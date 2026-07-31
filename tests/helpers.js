/**
 * tests/helpers.js — the headless driver shared by every test file (architecture-v2 §10).
 *
 * NOT a test file: it contains no `t.test` and `node --test` must find nothing in it to run.
 * It imports only from `src/core`, `src/data`, `src/skid` and `node:assert/strict`; it never
 * touches the DOM and never imports `src/ui`.
 *
 * The API is deliberately small:
 *   makeConfig(presetId, overrides)  -> { config, run, ctx }   build a live, tickable context
 *   runHeadless(ctx, opts)           -> run                    drive a method to a stop condition
 *   pulseInjection(ctx, opts)        -> ctx                    rebuild ctx as a pulse-injection run
 *   trace(run, ...channelNames)      -> { n, <name>:Float64Array }
 *   firstMoment(V_mL, y, n)          -> { m0, mu1, mu2, sigma }
 *   assertClose / assertCloseAbs / assertMonotone
 *   synthPeak(kind, opts)            -> { V_mL, y, n }
 *
 * THE CONTEXT SHAPE (§2.4, §11 C-82) is `{ config, run, bus, sim, fmt, overrides }` — one shape
 * everywhere. There is no exported factory in `src/`, so `makeConfig` performs the four steps in
 * the order the contract requires:
 *     normalizePreset -> createRunState -> createSkid -> assemble ctx
 * `createSkid` is MANDATORY: it allocates `run.segC_mM` and builds `run.topo`/`run.bed`/`run.col`,
 * and `skid.physicsTick` asserts `run.topo !== null` (§6.3, §11 C-26).
 */

import assert from 'node:assert/strict';

import { createBus, column as logColumn } from '../src/core/log.js';
import { createRng, nextGaussian } from '../src/core/util.js';
import * as state from '../src/core/state.js';
import * as sim from '../src/core/sim.js';
import * as skid from '../src/skid/skid.js';
import * as presets from '../src/data/presets.js';

/** The default preset every test file starts from unless it says otherwise. */
export const DEFAULT_PRESET = 'cex-capture-igg1-pilot';

/** The validation geometry (§8.3): 1.60 x 20 cm, LAB skid table, 300 cm/h. */
export const LAB_PRESET = 'cex-capture-igg1-lab';

/**
 * The wall-clock fixture of §10 / §11 C-52: the reduced axial grid every case except the two
 * grid-convergence cases uses. `nz = 150` instead of 400 cuts the isotherm solve count by 2.7x
 * and is well above the point where the §7.2.2 numerical-dispersion law stops being the dominant
 * error term. Spread as `makeConfig(id, { ...FAST_COLUMN })`.
 */
export const FAST_COLUMN = Object.freeze({ column: { nz: 150 } });

/* ============================================================================================
 * 1. BUILDING A CONTEXT
 * ========================================================================================== */

/**
 * Build a complete, tickable `{ config, run, ctx }` from a preset id plus authored overrides.
 *
 * `overrides` is in AUTHORED (preset) form and is deep-merged by `normalizePreset` before any
 * derivation, so an override path is the authored path: `{ column: { nz: 150 } }`,
 * `{ skid: { ambientT_C: 5 } }`, `{ load: { value: 60 } }`, plus the four array-shaped keys
 * `tanksById` / `tankDefaults` / `speciesOverrides` / `methodPatches`.
 *
 * @param {string} [presetId=DEFAULT_PRESET] a key of `data/presets.js::PRESETS`
 * @param {object} [overrides={}] authored-form override patch
 * @returns {{config:object, run:object, ctx:object}} `config` is frozen; `run` is live; `ctx` is
 *          the §2.4 shape, and `ctx.overrides` carries the patch so `sim.rebuild` accumulates.
 */
export function makeConfig(presetId = DEFAULT_PRESET, overrides = {}) {
  const config = presets.normalizePreset(presetId, overrides);
  const run = state.createRunState(config);
  skid.createSkid(config, run);
  const ctx = { config, run, bus: createBus(), sim: {}, fmt: {}, overrides };
  return { config, run, ctx };
}

/**
 * Index of a block id in the current method, or -1.
 * @param {object} config frozen config
 * @param {string} blockId a `config.method.blocks[].id`
 * @returns {number} array index, or -1 when absent
 */
export function blockIndexOf(config, blockId) {
  const blocks = (config.method && config.method.blocks) || [];
  for (let i = 0; i < blocks.length; i++) if (blocks[i].id === blockId) return i;
  return -1;
}

/* ============================================================================================
 * 2. RUNNING
 * ========================================================================================== */

/** Wall-slice handed to `sim.advanceWall`. At speed 1000 this banks 250 sim-s, of which the
 *  §2.1.1 frame cap (`maxTicksPerFrame = 150`) executes 7.5 s; the rest is dropped and re-banked
 *  on the next call, which is exactly the production path. */
const WALL_SLICE_S = 0.25;

/**
 * Drive a run headlessly until a stop condition fires or the method ends.
 *
 * Arms the run (`validateAndReady`) and starts it when it is IDLE/READY; if it is already RUNNING
 * the run is simply continued, so a test may call this repeatedly with tightening conditions.
 * Only RUNNING advances the clock (§3.2), so the loop also exits the moment an alarm, a watch or
 * the end of the method leaves that state.
 *
 * STOP CONDITIONS (all optional, first one met wins, all checked after each wall slice):
 *   untilBlock      block id (string) or index (number) — stop once the run has ENTERED it
 *   untilVolume_mL  stop once `run.V_tot_mL >= x`
 *   untilTime_s     stop once `run.t_s >= x`
 *   maxTicks        stop once this many physics ticks have been executed by THIS call
 *
 * @param {object} ctx the §2.4 context
 * @param {{untilBlock?:string|number, untilVolume_mL?:number, untilTime_s?:number,
 *          maxTicks?:number, speed?:number, requireReady?:boolean}} [opts]
 *        `speed` must be one of `config.sim.speedOptions` (default 1000);
 *        `requireReady` (default true) throws with the failing PRC code when the READY gate fails.
 * @returns {object} `ctx.run`, for chaining
 */
export function runHeadless(ctx, opts = {}) {
  const {
    untilBlock, untilVolume_mL, untilTime_s,
    maxTicks = 4_000_000, speed = 1000, requireReady = true,
  } = opts;

  const run = ctx.run;
  const config = ctx.config;

  const stopIndex = untilBlock === undefined ? -1
    : (typeof untilBlock === 'number' ? untilBlock : blockIndexOf(config, untilBlock));
  if (untilBlock !== undefined && stopIndex < 0) {
    throw new Error(`runHeadless: untilBlock '${untilBlock}' is not a block of this method`);
  }

  if (run.state === 'IDLE' || run.state === 'READY') {
    const v = sim.validateAndReady(ctx);
    if (!v.ok && requireReady) {
      const f = v.failures && v.failures[0];
      throw new Error(`runHeadless: pre-run checks failed — ${f ? `${f.code}: ${f.message}` : '(no detail)'}`);
    }
    const s = sim.start(ctx);
    if (!s.ok) throw new Error(`runHeadless: start refused — ${s.reason}`);
    sim.setSpeed(ctx, speed);
  }

  const met = () => (
    (stopIndex >= 0 && run.blockIndex >= stopIndex)
    || (untilVolume_mL !== undefined && run.V_tot_mL >= untilVolume_mL)
    || (untilTime_s !== undefined && run.t_s >= untilTime_s)
  );

  let ticks = 0;
  while (run.state === 'RUNNING' && ticks < maxTicks && !met()) {
    const n = sim.advanceWall(ctx, WALL_SLICE_S);
    // A RUNNING run that executes no ticks cannot make progress; bail rather than spin.
    if (n === 0) break;
    ticks += n;
  }
  return run;
}

/**
 * Rebuild `ctx` as a PULSE-INJECTION run: a short equilibration, a rectangular injection of one
 * species from the sample tank, then a chase long enough for the pulse to clear the column.
 *
 * This is the retention-identity fixture (§7.2.5). It goes through the real skid — sample inlet,
 * gradient path, column, detector path — so the moment it produces is the moment the instrument
 * would report, hold-up volumes included. The pulse is placed by overriding the SAMPLE tank's
 * composition (its proteins are removed and `species` carries the pulse in mM) and replacing
 * `methodPhases` with the three-block shorthand of §8.4.3.
 *
 * `ctx.config` and `ctx.run` are REPLACED (`sim.rebuild`), so re-read them from `ctx` afterwards.
 *
 * THE DELIVERED MASS IS NOT `conc_mM * volume_mL`. The sample suction line holds ~1.5 mL (LAB) to
 * ~50 mL (PROCESS) of the previous fluid, so a pulse narrower than that never reaches the column
 * at all. Size `volume_mL` at several times the suction hold-up and read the amount ACTUALLY
 * delivered from `run.massLoad_umol[config.idxById[speciesId]]` — never from the nominal product.
 *
 * @param {object} ctx the §2.4 context
 * @param {{speciesId:string, conc_mM:number, volume_mL:number, equilibrate_CV?:number,
 *          chase_CV?:number, flow_cmh?:number, sampleTankId?:string, samplePort?:string}} opts
 *        `volume_mL` is the injected pulse width; `chase_CV` (default 3) must be long enough for
 *        the species to elute or the moment is truncated.
 * @returns {object} the same `ctx`, rebuilt
 */
export function pulseInjection(ctx, opts) {
  const {
    speciesId, conc_mM, volume_mL,
    equilibrate_CV = 0.5, chase_CV = 3, flow_cmh,
    samplePort = 'S1', sampleTankId,
  } = opts;

  const assignments = ctx.config.inletAssignments || {};
  const tankId = sampleTankId || assignments[samplePort];
  if (!tankId) {
    throw new Error(`pulseInjection: no tank is assigned to sample port '${samplePort}'`);
  }
  if (ctx.config.idxById[speciesId] === undefined) {
    throw new Error(`pulseInjection: '${speciesId}' is not a species of this preset`);
  }

  const phase = (o) => (flow_cmh === undefined ? o : Object.assign({ flow: flow_cmh }, o));

  sim.rebuild(ctx, {
    // Strip the feed proteins and carry the pulse as an explicit mM extra. `buildTankVector`
    // adds `composition.species` on top of the solved buffer, so the pulse rides on the same
    // equilibration buffer the column is already sitting in — nothing else changes.
    tanksById: { [tankId]: { composition: { proteins: [], species: { [speciesId]: conc_mM } } } },
    methodPhases: [
      phase({ type: 'EQUILIBRATION', cv: equilibrate_CV, pctB: 0, columnValve: 'DOWN' }),
      phase({
        type: 'LOAD', mL: volume_mL, pctB: 0, columnValve: 'DOWN',
        sample: 'DIRECT', inlets: { a: 'A1', b: 'B1', sample: samplePort },
      }),
      phase({ type: 'WASH', cv: chase_CV, pctB: 0, columnValve: 'DOWN' }),
    ],
  });
  return ctx;
}

/* ============================================================================================
 * 3. EXTRACTING A TRACE
 * ========================================================================================== */

/**
 * Copy named channels out of the 2 Hz whole-run log into plain `Float64Array`s.
 *
 * `log.column` returns a VIEW that `pushRow` invalidates when the store grows (§6.2, §11 C-25),
 * so this copies. It also widens Float32 storage to Float64 — the log is Float32 on purpose
 * (§5.1), which caps the achievable precision of anything derived from it at ~1e-7 relative.
 * A test that needs more than that must read `run` directly, not the log.
 *
 * @param {object} run the run state, after (or during) a run
 * @param {...string} channelNames names from `core/log.js::NUMERIC_CHANNELS`, e.g. 'V_mL',
 *        'UV_280_mAU', 'cond_mS_cm', 'pH'
 * @returns {{n:number}&Object<string,Float64Array>} `n` rows, plus one array per requested name
 */
export function trace(run, ...channelNames) {
  const store = run.log;
  const n = store ? store.n : 0;
  const out = { n };
  for (const name of channelNames) {
    const col = store ? logColumn(store, name) : null;
    if (!col || col.length < n) {
      throw new Error(`trace: channel '${name}' is not in this run's log`);
    }
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = col[i];
    out[name] = a;
  }
  return out;
}

/**
 * The GROUND-TRUTH concentration of one species at the detector plane, per log row.
 *
 * `appendLogRow` pushes `run.yDet_mM` into `store.truth[i]`, index-parallel to `config.species`
 * (§5.1, §11 C-23). This channel carries no detector drift, no stray light, no noise and no
 * filter lag, so it is the right x-axis partner for a retention or mass assertion; `UV_280_mAU`
 * is the right one for a test that is actually about the detector.
 *
 * @param {object} config frozen config
 * @param {object} run the run state
 * @param {string} speciesId a `config.species[].id`
 * @returns {Float64Array} length `run.log.n`, mM
 */
export function truthTrace(config, run, speciesId) {
  const i = config.idxById[speciesId];
  if (i === undefined) throw new Error(`truthTrace: unknown species '${speciesId}'`);
  const store = run.log;
  const n = store ? store.n : 0;
  const col = store && store.truth[i];
  if (!col) throw new Error(`truthTrace: this run's log carries no truth channels`);
  const a = new Float64Array(n);
  for (let k = 0; k < n; k++) a[k] = col[k];
  return a;
}

/**
 * Trapezoidal moments of a curve sampled on a (not necessarily uniform) volume axis.
 *
 * `m0 = INT y dV`, `mu1 = INT V*y dV / m0`, `mu2 = INT (V-mu1)^2 * y dV / m0`,
 * `sigma = sqrt(mu2)`. No baseline is subtracted — pass a baseline-corrected `y`.
 *
 * The trapezoid rule is second-order, so on a curve resolved by ~200 points per peak the moment
 * error is O(h^2) ~ 1e-4 relative; that is the floor for any assertion built on this.
 *
 * @param {ArrayLike<number>} V_mL abscissa, mL, strictly increasing
 * @param {ArrayLike<number>} y ordinate, any unit
 * @param {number} [n=V_mL.length] number of samples to use
 * @returns {{m0:number, mu1:number, mu2:number, sigma:number}} `m0` in (y-unit)*mL, `mu1` in mL,
 *          `mu2` in mL^2, `sigma` in mL. All NaN when `m0` is 0.
 */
export function firstMoment(V_mL, y, n = V_mL.length) {
  let m0 = 0;
  let m1 = 0;
  for (let i = 1; i < n; i++) {
    const h = V_mL[i] - V_mL[i - 1];
    m0 += 0.5 * h * (y[i] + y[i - 1]);
    m1 += 0.5 * h * (V_mL[i] * y[i] + V_mL[i - 1] * y[i - 1]);
  }
  if (!(m0 !== 0)) return { m0: 0, mu1: NaN, mu2: NaN, sigma: NaN };
  const mu1 = m1 / m0;
  let m2 = 0;
  for (let i = 1; i < n; i++) {
    const h = V_mL[i] - V_mL[i - 1];
    const a = V_mL[i - 1] - mu1;
    const b = V_mL[i] - mu1;
    m2 += 0.5 * h * (b * b * y[i] + a * a * y[i - 1]);
  }
  const mu2 = m2 / m0;
  return { m0, mu1, mu2, sigma: mu2 > 0 ? Math.sqrt(mu2) : 0 };
}

/* ============================================================================================
 * 4. APPROXIMATE EQUALITY
 * ========================================================================================== */

/**
 * Assert `|actual - expected| <= relTol * |expected|`.
 *
 * RELATIVE, against `expected` alone — not against `max(|a|,|b|)` — so the tolerance a test
 * writes is the tolerance it gets even when `actual` is wildly wrong. `expected === 0` falls back
 * to an absolute comparison against `relTol`; prefer `assertCloseAbs` in that case and say so.
 *
 * @param {number} actual value under test
 * @param {number} expected the contract's number
 * @param {number} relTol relative tolerance, dimensionless (e.g. 1e-4 for "four digits")
 * @param {string} message what is being asserted, and WHY this tolerance
 * @returns {void}
 */
export function assertClose(actual, expected, relTol, message) {
  const scale = Math.abs(expected);
  const tol = scale > 0 ? relTol * scale : relTol;
  const d = Math.abs(actual - expected);
  assert.ok(
    Number.isFinite(actual) && d <= tol,
    `${message}\n  actual   = ${actual}\n  expected = ${expected}\n  |diff|   = ${d}`
    + `\n  allowed  = ${tol} (relTol ${relTol})`,
  );
}

/**
 * Assert `|actual - expected| <= absTol`. Use where the contract states an absolute band
 * ("12.900 +/- 0.005 pH units") or where `expected` may legitimately be zero.
 *
 * @param {number} actual value under test
 * @param {number} expected the contract's number
 * @param {number} absTol absolute tolerance, SAME UNIT as the values
 * @param {string} message what is being asserted, and WHY this tolerance
 * @returns {void}
 */
export function assertCloseAbs(actual, expected, absTol, message) {
  const d = Math.abs(actual - expected);
  assert.ok(
    Number.isFinite(actual) && d <= absTol,
    `${message}\n  actual   = ${actual}\n  expected = ${expected}\n  |diff|   = ${d}`
    + `\n  allowed  = ${absTol} (absolute)`,
  );
}

/**
 * Assert a sampled sequence is monotone in the stated direction.
 *
 * @param {ArrayLike<number>} a the sequence
 * @param {1|-1} direction +1 for non-decreasing, -1 for non-increasing
 * @param {string} message what is being asserted
 * @param {number} [slack=0] permitted backward step, in the sequence's own unit — 0 means strict
 *        monotonicity up to exact floating-point equality; use a small value to absorb the log's
 *        Float32 quantisation.
 * @returns {void}
 */
export function assertMonotone(a, direction, message, slack = 0) {
  for (let i = 1; i < a.length; i++) {
    const step = (a[i] - a[i - 1]) * direction;
    assert.ok(
      step >= -slack,
      `${message}\n  broke at index ${i}: ${a[i - 1]} -> ${a[i]} (step ${a[i] - a[i - 1]},`
      + ` allowed backward slack ${slack})`,
    );
  }
}

/* ============================================================================================
 * 5. SYNTHETIC PEAKS
 * ========================================================================================== */

/**
 * Chebyshev coefficients for the SCALED complementary error function
 * `erfcx(z) = exp(z^2)*erfc(z)`, z >= 0 (Numerical Recipes 3rd ed., `erfccheb`). Relative
 * accuracy ~1e-13, which is four orders below any tolerance a peak-shape test can justify.
 */
const ERFC_COF = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
  -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
  6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
  9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13,
  3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17,
];

/**
 * `erfcx(z) = exp(z^2) * erfc(z)` for z >= 0. Scaled, so the EMG can be evaluated in its far
 * tail without `exp(z^2)` overflowing.
 * @param {number} z argument, >= 0
 * @returns {number} erfcx(z), in (0, 1]
 */
function erfcx(z) {
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = ERFC_COF.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + ERFC_COF[j];
    dd = tmp;
  }
  return t * Math.exp(0.5 * (ERFC_COF[0] + ty * d) - dd);
}

/** Unit-area Gaussian in V. @private */
function gauss(V, VR, sigma) {
  const u = (V - VR) / sigma;
  return Math.exp(-0.5 * u * u) / (sigma * Math.SQRT2 * Math.sqrt(Math.PI));
}

/**
 * Unit-area exponentially-modified Gaussian, evaluated through `erfcx` so it is stable on both
 * flanks. Its moments are exact and analytic: `mu1 = VR + tau`, `variance = sigma^2 + tau^2`,
 * skew `= 2*tau^3 / (sigma^2 + tau^2)^1.5` — which is what makes it a real test of a moment
 * routine rather than a shape that only looks right.
 * @private
 */
function emg(V, VR, sigma, tau) {
  const u = (V - VR) / sigma;
  const k = sigma / tau;
  const z = (k - u) / Math.SQRT2;
  if (z >= 0) return Math.exp(-0.5 * u * u) * erfcx(z) / (2 * tau);
  // erfcx(z) = 2*exp(z^2) - erfcx(-z); the first term is folded into the outer exponential.
  return (2 * Math.exp(0.5 * k * k - k * u) - Math.exp(-0.5 * u * u) * erfcx(-z)) / (2 * tau);
}

/**
 * Generate one of the six synthetic chromatogram fixtures of §10, on a uniform volume grid.
 *
 * Every shape is UNIT AREA before `amplitude` scaling, so `firstMoment(...).m0` is `amplitude`
 * (or the sum of the two amplitudes, for `'overlap'`) and a test can check the integrator
 * independently of the shape.
 *
 * KINDS
 *   'gaussian'   pure Gaussian. mu1 = VR exactly, sigma = opts.sigma exactly.
 *   'emg'        exponentially-modified Gaussian. mu1 = VR + tau, var = sigma^2 + tau^2.
 *   'overlap'    two Gaussians at VR and VR2. Resolution Rs = (VR2-VR)/(2*(sigma+sigma2)).
 *   'flat'       Gaussian flanks with a flat apex of half-width `flatHalfWidth_mL` — the shape
 *                that breaks a naive three-point apex refinement.
 *   'truncated'  Gaussian whose grid STOPS at `VR + truncAtSigma*sigma`, so the trailing tail is
 *                missing and `m0` is only the captured fraction.
 *   'noisy'      Gaussian plus deterministic Gaussian noise of standard deviation `noise`,
 *                drawn from `core/util.js::createRng` at `seed` — reproducible bit-for-bit.
 *
 * @param {'gaussian'|'emg'|'overlap'|'flat'|'truncated'|'noisy'} kind fixture name
 * @param {{VR?:number, sigma?:number, tau?:number, amplitude?:number, n?:number,
 *          halfWidthSigmas?:number, VR2?:number, sigma2?:number, amplitude2?:number,
 *          flatHalfWidth_mL?:number, truncAtSigma?:number, noise?:number, seed?:number,
 *          baseline?:number}} [opts] all volumes in mL
 * @returns {{V_mL:Float64Array, y:Float64Array, n:number}} `V_mL` uniform and increasing,
 *          `y` in (amplitude-unit)/mL
 */
export function synthPeak(kind, opts = {}) {
  const {
    VR = 100, sigma = 5, tau = 5, amplitude = 1, n = 2001,
    halfWidthSigmas = 10,
    VR2 = VR + 12, sigma2 = sigma, amplitude2 = amplitude,
    flatHalfWidth_mL = 2 * sigma,
    truncAtSigma = 1.0,
    noise = 0.002, seed = 20260731,
    baseline = 0,
  } = opts;

  let V0 = VR - halfWidthSigmas * sigma;
  let V1 = VR + halfWidthSigmas * sigma;
  if (kind === 'emg') V1 = VR + halfWidthSigmas * sigma + 12 * tau;
  if (kind === 'overlap') V1 = Math.max(V1, VR2 + halfWidthSigmas * sigma2);
  if (kind === 'flat') { V0 -= flatHalfWidth_mL; V1 += flatHalfWidth_mL; }
  if (kind === 'truncated') V1 = VR + truncAtSigma * sigma;

  const V_mL = new Float64Array(n);
  const y = new Float64Array(n);
  const h = (V1 - V0) / (n - 1);
  // One PCG32 stream, seeded from `seed`. `nextGaussian` takes the STREAM, not the rng wrapper.
  const noiseStream = createRng(seed).streams[1];

  // 'flat' is a Gaussian split down the middle and separated by 2*flatHalfWidth_mL. Unit area
  // needs the inserted plateau's own area removed from the normalisation.
  const plateauArea = 2 * flatHalfWidth_mL * gauss(0, 0, sigma);

  for (let i = 0; i < n; i++) {
    const V = V0 + i * h;
    V_mL[i] = V;
    let v;
    switch (kind) {
      case 'gaussian':
      case 'truncated':
        v = amplitude * gauss(V, VR, sigma);
        break;
      case 'emg':
        v = amplitude * emg(V, VR, sigma, tau);
        break;
      case 'overlap':
        v = amplitude * gauss(V, VR, sigma) + amplitude2 * gauss(V, VR2, sigma2);
        break;
      case 'flat': {
        const d = V - VR;
        const core = Math.abs(d) <= flatHalfWidth_mL
          ? gauss(0, 0, sigma)
          : gauss(Math.abs(d) - flatHalfWidth_mL, 0, sigma);
        v = amplitude * core / (1 + plateauArea);
        break;
      }
      case 'noisy':
        v = amplitude * gauss(V, VR, sigma) + noise * nextGaussian(noiseStream);
        break;
      default:
        throw new Error(`synthPeak: unknown kind '${kind}'`);
    }
    y[i] = v + baseline;
  }
  return { V_mL, y, n };
}
