/**
 * tests/column.test.js — the core transport suite for `src/physics/column.js`.
 *
 * Contract: architecture-v2 §3.4 (batching), §3.5 (substep cap), §6.9 (module + the five substep
 * stages), §7.2 (column numerics), §10 (this file's row), §13 DoD 6 (determinism) and DoD 7
 * (mass balance).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THESE FIXTURES ARE ANALYTIC, AND NOT PINNED PRINTOUTS
 *
 * With explicit dispersion off (the shipped default) stage S1 is *exactly* the upwind update
 *     c_n <- (1 - nu) c_n^old + nu c_{n-1}^old
 * which is the transition matrix of a Bernoulli(nu) random walk in cell index. An impulse
 * delivered on step 1 therefore leaves cell nz-1 after a NEGATIVE-BINOMIAL number of steps
 * (nz successes at probability nu), so for a species that never enters the bead (`epsPi = 0`,
 * hence Kt = 0, R = 1) BOTH of the first two moments of the outlet trace are closed form:
 *
 *     E[exit step] = 1 + nz/nu            Var[exit step] = nz(1-nu)/nu^2
 *     mu1(out) - mu1(in) = (nz/nu)*dV = nz*VcellMob = epsC*V_col = V_0        (exact)
 *     sigma_V^2           = nz(1-nu)*VcellMob^2                              (exact)
 *     N = V_R^2/sigma_V^2 = nz/(1-nu)     H = L*sigma_V^2/V_R^2 = dz(1-nu)    (exact)
 *
 * With a linear partition Kt and instantaneous equilibrium the split scheme is *identically*
 * upwind on the conserved total `T = c + phi*q` at Courant `nu/R`, `R = 1 + phi*Kt` (§7.2.2), so
 * every identity above carries over with `nu -> nu/R`:
 *
 *     V_R = V_col*(epsC + (1-epsC)*Kt) = V_0 + Kt*V_s      H = dz*(1 - nu/R)
 *
 * Proof of the equivalence, for the record — with theta = 1 the S3 relaxation sends
 * (c, q) -> (T/R, Kt*T/R), so S1 followed by S3 gives
 *     T_n <- T_n/R + (nu/R)(T_{n-1} - T_n) + phi*Kt*T_n/R = T_n + (nu/R)(T_{n-1} - T_n).
 *
 * Every expected number below is one of those closed forms, the §7.2.5 retention identity, or a
 * value printed in the contract (T18). Nothing here records what the code happens to emit.
 *
 * The one place where the code is knowingly approximate is the ACTIVE WINDOW of §6.9.4: cells
 * outside [lo-margin, hi+margin] skip S3 for that substep, so a retained species picks up an
 * O(1e-6) relative error on V_R that an unretained one does not. Tolerances say so where it bites.
 *
 * All fixtures raise `dtCap_s` and `nuTarget` so that one `stepColumn` call is exactly one substep
 * and `nu` is precisely the value under test. The Courant / substep-cap tests deliberately use the
 * SHIPPED numerics block instead.
 *
 * No DOM, no `tests/helpers.js` — this file is self-contained on purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as presets from '../src/data/presets.js';
import * as stateMod from '../src/core/state.js';
import * as sim from '../src/core/sim.js';
import * as logMod from '../src/core/log.js';
import * as skid from '../src/skid/skid.js';
import * as bed from '../src/physics/bed.js';
import * as columnMod from '../src/physics/column.js';
import * as isoMod from '../src/physics/isotherm.js';
import * as pooling from '../src/analytics/pooling.js';

const PRESET = 'cex-capture-igg1-pilot';
const U_CMH = 150.0;               // the shipped B01..B07 velocity (§8.4.1)

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * Local helpers
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Relative-error assertion with a message that always reports the actual relative error. */
function assertRel(actual, expected, relTol, what) {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(
    rel <= relTol,
    `${what}: got ${actual}, expected ${expected} (rel ${rel.toExponential(3)} > ${relTol})`);
}

/**
 * Build a Column straight from the ingest boundary.
 *
 * `bed.buildColumnCfg` is the ONLY legal assembler of a `createColumn` cfg (§6.9/§6.11), so the
 * fixture goes through `normalizePreset` -> `buildColumnCfg` rather than hand-rolling a cfg.
 *
 * `dtCap_s`/`nuTarget` are widened so `nSub === 1` for every `nu <= 0.99` the analytic fixtures
 * use; the shipped values (0.5 s / 0.95) are what the Courant and substep-cap tests exercise.
 */
function buildAnalyticColumn(opts) {
  const {
    nz,
    isothermMode = 'INERT',
    enableDonnan = false,
    speciesOverrides = {},
    column = {},
    chem = {},
  } = opts;
  const config = presets.normalizePreset(PRESET, {
    column: Object.assign(
      { nz, isothermMode, enableDonnan, dtCap_s: 3600, nuTarget: 0.999 }, column),
    speciesOverrides,
    chem,
  });
  const cfg = bed.buildColumnCfg(config);
  return { config, cfg, col: columnMod.createColumn(cfg) };
}

/** Column index of a species id, or -1. */
function colIdx(cfg, id) {
  return cfg.comps.findIndex((c) => c.id === id);
}

/** The mM vector of a shipped tank, remapped registry index -> COLUMN index. */
function tankVectorCol(config, cfg, tankId) {
  const tank = config.tanks.find((t) => t.id === tankId);
  assert.ok(tank, `tank ${tankId} exists`);
  const out = new Float64Array(cfg.comps.length);
  for (let j = 0; j < out.length; j++) out[j] = tank.y_mM[config.skidIdxOf[j]];
  return out;
}

/** Superficial flow, mL/s, at U_CMH on this column's cross-section. */
function flow_mLs(col) {
  return (U_CMH / 3600) * col.A_cm2;
}

/**
 * Drive a rectangular inlet pulse of species `i` at unit concentration and return the moments of
 * the outlet trace on the volume axis `V_j = j*dV` (the same axis the inlet is measured on, which
 * is what makes `mu1(out) - mu1(in)` exactly the mean residence volume — see the file header).
 */
function pulseMoments(col, i, nu, nPulse, nSteps) {
  const Q = flow_mLs(col);
  const dV = nu * col.VcellMob_mL;
  const dt = dV / Q;
  const cIn = new Float64Array(col.nsCol);
  let m0in = 0, m1in = 0, m0out = 0, m1out = 0, m2out = 0;
  for (let j = 1; j <= nSteps; j++) {
    cIn.fill(0);
    if (j <= nPulse) cIn[i] = 1.0;
    const r = columnMod.stepColumn(col, dt, Q, cIn, dV);
    assert.equal(r.nSub, 1, 'analytic fixture must run exactly one substep per stepColumn call');
    const V = j * dV;
    const mi = dV * cIn[i];
    m0in += mi; m1in += mi * V;
    const mo = dV * col.cOut[i];
    m0out += mo; m1out += mo * V; m2out += mo * V * V;
  }
  const mu1out = m1out / m0out;
  return {
    VR_mL: mu1out - m1in / m0in,
    var_mL2: m2out / m0out - mu1out * mu1out,
    recovery: m0out / m0in,
    dV_mL: dV,
    dt_s: dt,
  };
}

/**
 * Push a step change of composition through an equilibrated column and return the breakthrough
 * first moment in CV, `V_R/CV = (1/V_col) * INTEGRAL (1 - (c_out - c0)/(c1 - c0)) dV`.
 * By mass balance this is exactly the chord `epsC + (1-epsC)*[q*(c1)-q*(c0)]/(c1-c0)` of §7.2.6.
 */
function breakthroughFirstMoment_CV(col, i, c0, c1, nu, maxCV) {
  const Q = flow_mLs(col);
  const dV = nu * col.VcellMob_mL;
  const dt = dV / Q;
  let V = 0;
  let integ = 0;
  const span = c1[i] - c0[i];
  while (V < maxCV * col.V_mL) {
    const r = columnMod.stepColumn(col, dt, Q, c1, dV);
    assert.equal(r.nSub, 1, 'breakthrough fixture must run exactly one substep per call');
    V += dV;
    integ += (1 - (col.cOut[i] - c0[i]) / span) * dV;
  }
  return integ / col.V_mL;
}

/**
 * A synthetic load / wash / gradient / re-equilibration cycle driven straight into `stepColumn`,
 * on the SHIPPED SMA + Donnan chemistry. Used by the long mass-conservation drive, the positivity
 * check and the unsafe-clamp ledger check; memoised because 200 000 substeps is ~6 s of CPU.
 */
let _cycleDrive = null;
function shippedCycleDrive(minSubsteps) {
  if (_cycleDrive && _cycleDrive.col.substepCounter >= minSubsteps) return _cycleDrive;
  const nz = 24;
  const config = presets.normalizePreset(PRESET, {
    column: { nz, dtCap_s: 3600, nuTarget: 0.999 },
  });
  const cfg = bed.buildColumnCfg(config);
  const col = columnMod.createColumn(cfg);
  const cA = tankVectorCol(config, cfg, 'TK-EQ');
  const cB = tankVectorCol(config, cfg, 'TK-ELU');
  const cF = tankVectorCol(config, cfg, 'TK-FEED');
  columnMod.resetColumn(col, cA);

  const Q = flow_mLs(col);
  const nu = 0.9;
  const dV = nu * col.VcellMob_mL;
  const dt = dV / Q;
  const cIn = new Float64Array(cfg.comps.length);
  const CYCLE = 400;               // 60 load / 60 wash / 180 gradient / 100 re-equilibration
  let s = 0;
  while (col.substepCounter < minSubsteps) {
    const ph = s % CYCLE;
    if (ph < 60) cIn.set(cF);
    else if (ph < 120) cIn.set(cA);
    else if (ph < 300) {
      const f = (ph - 120) / 180;
      for (let j = 0; j < cIn.length; j++) cIn[j] = cA[j] * (1 - f) + cB[j] * f;
    } else cIn.set(cA);
    columnMod.stepColumn(col, dt, Q, cIn, dV);
    s++;
  }
  _cycleDrive = { config, cfg, col, steps: s };
  return _cycleDrive;
}

/** Run a short 4-block method headlessly and return `{config, run}`. */
const SHORT_METHOD = [
  { type: 'EQUILIBRATION', cv: 0.6 },
  { type: 'LOAD', cv: 0.4, sample: 'DIRECT', inlets: { a: 'A1', b: 'B1', sample: 'S1' } },
  { type: 'WASH', cv: 0.3 },
  { type: 'ELUTION_LINEAR', cv: 2.0, pctB: [0, 100], frac: 'PEAK' },
];

function runShortMethod(speed, nz) {
  const config = presets.normalizePreset(PRESET, {
    column: { nz },
    methodPhases: SHORT_METHOD,
  });
  const run = stateMod.createRunState(config);
  skid.createSkid(config, run);          // REQUIRED: physicsTick throws on a null topo/bed/col
  const ctx = { config, run, bus: logMod.createBus(), sim: {}, fmt: {}, overrides: {} };
  sim.validateAndReady(ctx);
  sim.start(ctx);
  sim.setSpeed(ctx, speed);
  let guard = 0;
  while (run.state === 'RUNNING' && guard++ < 4e6) sim.advanceWall(ctx, 0.25);
  assert.notEqual(run.state, 'RUNNING', 'the short method must terminate');
  return { config, run };
}

/** The 1000x reference run, shared by the two DoD 7 tests and the determinism test. */
let _fastRun = null;
function fastShortRun() {
  if (!_fastRun) _fastRun = runShortMethod(1000, 40);
  return _fastRun;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §6.9.3 S1 — the pre-update upwind rule
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('S1 pre-update rule — 20 cells at nu=0.95, c[19] is exactly 0 after 3 steps (§6.9.3, C-33)', () => {
  // The contract's own regression fixture. Read literally, v1's in-place ascending update uses the
  // NEW upstream value and the inlet reaches cell 19 in 3 steps (c[19] = 0.905); true upwind leaves
  // it at exactly 0, and the S2 flux accounting then closes instead of carrying a -38 % residual.
  const { cfg, col } = buildAnalyticColumn({ nz: 20, speciesOverrides: { tracer: { epsPi: 0 } } });
  const i = colIdx(cfg, 'tracer');
  columnMod.resetColumn(col, null);

  const Q = flow_mLs(col);
  const nu = 0.95;
  const dV = nu * col.VcellMob_mL;
  const cIn = new Float64Array(col.nsCol);
  cIn[i] = 1.0;
  for (let k = 0; k < 3; k++) {
    const r = columnMod.stepColumn(col, dV / Q, Q, cIn, dV);
    assert.equal(r.nSub, 1);
    assertRel(r.courant, nu, 1e-12, 'reported Courant number');
  }

  const base = i * col.nz;
  // TRUE upwind against a constant inlet: c_n after k steps is P(Bin(k, nu) >= n+1) — a closed
  // form, so these are exact, not recorded. Machine tolerance 1e-15 relative.
  const p = [1 - 0.05 ** 3, 0.95 ** 3 + 3 * 0.95 ** 2 * 0.05, 0.95 ** 3];
  assertRel(col.c[base + 0], p[0], 1e-15, 'c[0] after 3 steps');
  assertRel(col.c[base + 1], p[1], 1e-15, 'c[1] after 3 steps');
  assertRel(col.c[base + 2], p[2], 1e-15, 'c[2] after 3 steps');
  for (let n = 3; n < 20; n++) {
    assert.equal(col.c[base + n], 0, `c[${n}] must be EXACTLY 0 after 3 steps (n > k)`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.2.5 — the retention identity and both degenerate cases
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§7.2.5 retention identity — Kt = 0 gives exactly 0.35 CV (degenerate case 1)', () => {
  const nz = 60;
  const nu = 0.6;
  const { cfg, col } = buildAnalyticColumn({ nz, speciesOverrides: { tracer: { epsPi: 0 } } });
  const i = colIdx(cfg, 'tracer');
  columnMod.resetColumn(col, null);

  const m = pulseMoments(col, i, nu, 1, Math.ceil((nz / nu) * 8));
  const V0 = col.epsC * col.V_mL;

  // Tolerance 1e-12: with Kt = 0 the scheme is pure upwind advection and mu1(out) - mu1(in) is the
  // exact negative-binomial mean nz/nu * dV = V_0. Only float64 summation error is left.
  assertRel(m.VR_mL, V0, 1e-12, 'V_R of a pore-excluded species');
  assertRel(m.VR_mL / col.V_mL, col.epsC, 1e-12, 'V_R/CV');
  assertRel(m.recovery, 1.0, 1e-12, 'mass recovery of the pulse');
});

test('§7.2.5 retention identity — Kt = epsP gives exactly epsT = 0.9025 CV (degenerate case 2)', () => {
  const nz = 60;
  const nu = 0.6;
  // keffScale 1e6 drives k_ov to its 1e4 1/s ceiling so `theta(k'*dt) === 1` and the cell is at
  // local equilibrium after every substep; that is the regime in which the split scheme is exactly
  // upwind on T (file header) and the identity is a statement about the isotherm alone.
  const { cfg, col } = buildAnalyticColumn({
    nz, speciesOverrides: { tracer: { epsPi: 0.85, keffScale: 1e6 } },
  });
  const i = colIdx(cfg, 'tracer');
  columnMod.resetColumn(col, null);

  const Kt = 0.85;
  const R = 1 + col.phi * Kt;
  const m = pulseMoments(col, i, nu, 1, Math.ceil((nz * R / nu) * 8));
  const VR_expected = col.V_mL * (col.epsC + (1 - col.epsC) * Kt);

  // The contract's own band for this identity is +/-0.5 % (§7.2.5). The residual here is ~4e-6 and
  // is the §6.9.4 active-window approximation: cells below `tol_i = 1e-6*concScale_mM` skip S3 for
  // that substep, so the trailing edge equilibrates a step late. It is NOT float error.
  assertRel(m.VR_mL, VR_expected, 5e-3, 'V_R of a fully permeating tracer');
  assertRel(m.VR_mL / col.V_mL, 0.9025, 5e-3, 'V_R/CV must be epsT');
  assert.equal(col.epsT, 0.9025, 'epsT is 0.9025 everywhere, with no exceptions (§7.2.5, C-42)');
  assertRel(m.recovery, 1.0, 1e-6, 'mass recovery of the pulse');
});

test('§7.2.5 retention identity — LINEAR isotherm gives V_R = V_0 + K*V_s', () => {
  const nz = 60;
  const nu = 0.6;
  const Klin = 2.0;
  const { cfg, col } = buildAnalyticColumn({
    nz,
    isothermMode: 'LINEAR',
    speciesOverrides: { WKI: { epsPi: 0.85, Klin, keffScale: 1e6 } },
  });
  const i = colIdx(cfg, 'WKI');
  assert.equal(cfg.comps[i].Klin, Klin, 'Klin reached ColumnSpeciesConfig');
  columnMod.resetColumn(col, null);

  // LINEAR mode: q* = epsPi*c + Klin*c for a binding species, so Kt = epsPi + Klin exactly.
  const Kt = 0.85 + Klin;
  const R = 1 + col.phi * Kt;
  const V0 = col.epsC * col.V_mL;               // interstitial (mobile) volume
  const Vs = (1 - col.epsC) * col.V_mL;         // bead (stationary) volume
  const m = pulseMoments(col, i, nu, 1, Math.ceil((nz * R / nu) * 6));

  assertRel(m.VR_mL, V0 + Kt * Vs, 5e-3, 'V_R = V_0 + K*V_s');           // §7.2.5 band
  assertRel(m.VR_mL, col.V_mL * (col.epsC + (1 - col.epsC) * Kt), 5e-3,
    'V_R = V_col*(epsC + (1-epsC)*Kt)');
  assertRel(m.recovery, 1.0, 1e-6, 'mass recovery of the pulse');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.2.2 — numerical dispersion and plate-count scaling
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§7.2.2 H_num = dz*(1 - nu/R) — unretained limit R = 1 is exact', () => {
  const nz = 40;
  for (const nu of [0.25, 0.5, 0.95]) {
    const { cfg, col } = buildAnalyticColumn({ nz, speciesOverrides: { tracer: { epsPi: 0 } } });
    const i = colIdx(cfg, 'tracer');
    columnMod.resetColumn(col, null);
    const m = pulseMoments(col, i, nu, 1, Math.ceil((nz / nu) * 10));

    // Closed forms for the Bernoulli walk (file header): all three hold to float64 round-off.
    const varExpected = nz * (1 - nu) * col.VcellMob_mL * col.VcellMob_mL;
    const N = m.VR_mL * m.VR_mL / m.var_mL2;
    const H = col.L_cm * m.var_mL2 / (m.VR_mL * m.VR_mL);
    assertRel(m.var_mL2, varExpected, 1e-10, `sigma_V^2 at nu=${nu}`);
    assertRel(N, nz / (1 - nu), 1e-10, `N_eff at nu=${nu}`);
    assertRel(H, col.dz_cm * (1 - nu), 1e-10, `H_num at nu=${nu}`);
  }
});

test('§7.2.2 H_num = dz*(1 - nu/R) — retained species, R = 1 + phi*Kt', () => {
  const nz = 60;
  const nu = 0.6;
  const { cfg, col } = buildAnalyticColumn({
    nz, speciesOverrides: { tracer: { epsPi: 0.85, keffScale: 1e6 } },
  });
  const i = colIdx(cfg, 'tracer');
  columnMod.resetColumn(col, null);

  const R = 1 + col.phi * 0.85;
  const m = pulseMoments(col, i, nu, 1, Math.ceil((nz * R / nu) * 8));
  const H = col.L_cm * m.var_mL2 / (m.VR_mL * m.VR_mL);

  // 0.5 % — the retained case inherits the §6.9.4 active-window error, which lands harder on the
  // second moment (~7e-4 relative) than on the first (~4e-6).
  assertRel(H, col.dz_cm * (1 - nu / R), 5e-3, 'H_num with retention');

  // The corollary the contract asks to keep visible: a LARGER dt (larger nu) is MORE accurate.
  // Do not "fix" this.
  const Hsmall = col.dz_cm * (1 - 0.1 / R);
  const Hlarge = col.dz_cm * (1 - 0.9 / R);
  assert.ok(Hlarge < Hsmall, 'reducing dt must make H_num worse, not better (§7.2.2)');
});

test('§7.2.2 plate-count scaling — doubling nz halves the peak variance', () => {
  const nu = 0.5;
  const results = [];
  for (const nz of [40, 80, 160]) {
    const { cfg, col } = buildAnalyticColumn({ nz, speciesOverrides: { tracer: { epsPi: 0 } } });
    const i = colIdx(cfg, 'tracer');
    columnMod.resetColumn(col, null);
    // dt is halved with dz (dV = nu*VcellMob and VcellMob halves), so nu is held fixed at 0.5 and
    // H_num = dz*(1-nu) halves exactly. sigma_V^2 = V_R^2 * H/L therefore halves too.
    const m = pulseMoments(col, i, nu, 1, Math.ceil((nz / nu) * 8));
    results.push({ nz, ...m });
    assertRel(m.VR_mL, col.epsC * col.V_mL, 1e-12, `V_R invariant to nz (nz=${nz})`);
  }
  // Tolerance 1e-9: both variances are exact closed forms, so the ratio is exact bar round-off.
  assertRel(results[1].var_mL2 / results[0].var_mL2, 0.5, 1e-9, 'variance ratio nz 40 -> 80');
  assertRel(results[2].var_mL2 / results[1].var_mL2, 0.5, 1e-9, 'variance ratio nz 80 -> 160');
  assertRel(results[2].var_mL2 / results[0].var_mL2, 0.25, 1e-9, 'variance ratio nz 40 -> 160');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.2.1 / §3.5 — Courant condition and substepping
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§7.2.1/§3.5 Courant condition — nSub is the ceiling and nu never exceeds nuTarget', () => {
  // (a) The SHIPPED numerics block: nuTarget 0.95, dtCap_s 0.50, nSubMax 64. At 150 cm/h and
  //     nz = 50 the 0.5 s CAP binds before the Courant limit does, which is the normal operating
  //     regime and the one bed.js batches against.
  const config = presets.normalizePreset(PRESET, { column: { nz: 50 } });
  const cfg = bed.buildColumnCfg(config);
  const col = columnMod.createColumn(cfg);
  assert.equal(col.nuTarget, 0.95, 'shipped nuTarget');
  assert.equal(col.dtCap_s, 0.5, 'shipped dtCap_s');
  assert.equal(col.nSubMax, 64, 'shipped nSubMax');
  columnMod.resetColumn(col, null);

  const Q = flow_mLs(col);
  const uI = (Q / col.A_cm2) / col.epsC;
  const dtMax = Math.min(col.nuTarget * col.dz_cm / uI, col.dtCap_s);
  assertRel(dtMax, col.dtCap_s, 1e-15, 'fixture (a) must be dtCap-limited');
  const cIn = new Float64Array(col.nsCol);

  for (const dt of [0.05, 0.2, dtMax, dtMax * 1.001, 1.0, 5.0, 20.0]) {
    const nSubIdeal = Math.max(1, Math.ceil(dt / dtMax));
    if (nSubIdeal > col.nSubMax) continue;               // the cap is its own test, below
    const r = columnMod.stepColumn(col, dt, Q, cIn, Q * dt);
    assert.equal(r.nSub, nSubIdeal, `nSub at dt=${dt}`);
    assert.equal(r.dtAdvanced_s, dt, `dtAdvanced must equal dt below the cap (dt=${dt})`);
    assert.equal(r.status, 0, `status must be 0 below the cap (dt=${dt})`);
    assert.equal(r.speedDeficit, 1, `speedDeficit must be 1 below the cap (dt=${dt})`);
    // nu = |dV_sub| / VcellMob, and it must respect nuTarget and never touch the hard ceiling 1.0.
    assertRel(r.courant, Math.abs(Q * dt / r.nSub) / col.VcellMob_mL, 1e-14, 'reported Courant');
    assert.ok(r.courant <= col.nuTarget + 1e-12,
      `Courant ${r.courant} exceeded nuTarget ${col.nuTarget} at dt=${dt}`);
    assert.ok(r.courant < 1.0, `Courant ${r.courant} reached the hard ceiling at dt=${dt}`);
  }

  // (b) With the wall-clock cap lifted the COURANT limit is what binds, and asking for an exact
  //     multiple of dtMax must land the per-substep Courant number exactly on nuTarget.
  const cfg2 = bed.buildColumnCfg(
    presets.normalizePreset(PRESET, { column: { nz: 50, dtCap_s: 3600 } }));
  const col2 = columnMod.createColumn(cfg2);
  columnMod.resetColumn(col2, null);
  const dtMax2 = col2.nuTarget * col2.dz_cm / uI;
  assert.ok(dtMax2 < 3600, 'fixture (b) must be Courant-limited');
  const cIn2 = new Float64Array(col2.nsCol);
  for (const k of [1, 2, 3, 5, 17]) {
    // (1 - 1e-12) keeps ceil() on the intended side of the integer boundary.
    const dt = k * dtMax2 * (1 - 1e-12);
    const r = columnMod.stepColumn(col2, dt, Q, cIn2, Q * dt);
    assert.equal(r.nSub, k, `nSub must be exactly k=${k} at dt = k*dtMax`);
    assertRel(r.courant, col2.nuTarget, 1e-9, `Courant at dt = ${k}*dtMax`);
    assert.ok(r.courant <= col2.nuTarget + 1e-12, 'nuTarget is an upper bound, never a target to exceed');
  }
});

test('§3.5 Courant uses the TRANSPORTED velocity dV/dt, never flow_mLs (C-07)', () => {
  // dtCap is lifted so the COURANT limit is what chooses nSub; with the shipped 0.5 s cap both
  // velocities land on nSub = 1 and the fixture would not discriminate anything.
  const config = presets.normalizePreset(PRESET, { column: { nz: 50, dtCap_s: 3600 } });
  const cfg = bed.buildColumnCfg(config);
  const col = columnMod.createColumn(cfg);
  columnMod.resetColumn(col, null);

  const Q = flow_mLs(col);
  const dt = 5.0;
  const dV = 3 * Q * dt;                                   // a partial-batch flush: dV/dt = 3*Q
  const cIn = new Float64Array(col.nsCol);
  const r = columnMod.stepColumn(col, dt, Q, cIn, dV);

  const uIeff = (dV / dt / col.A_cm2) / col.epsC;
  const nSubEff = Math.max(1, Math.ceil(dt / Math.min(col.nuTarget * col.dz_cm / uIeff, col.dtCap_s)));
  const uIflow = (Q / col.A_cm2) / col.epsC;
  const nSubFlow = Math.max(1, Math.ceil(dt / Math.min(col.nuTarget * col.dz_cm / uIflow, col.dtCap_s)));

  assert.notEqual(nSubEff, nSubFlow, 'fixture must actually discriminate the two velocities');
  assert.equal(r.nSub, nSubEff, 'nSub must be built from dV/dt');
  assertRel(r.courant, Math.abs(dV / r.nSub) / col.VcellMob_mL, 1e-14, 'Courant from dV');
  assert.ok(r.courant <= col.nuTarget + 1e-12,
    `Courant from dV must still respect nuTarget; building nu from flow_mLs would give ` +
    `${(Math.abs(dV / nSubFlow) / col.VcellMob_mL).toFixed(4)}`);
  // Building nu from flow_mLs at this operating point would let it exceed the hard ceiling 1.0 —
  // the exact failure C-07 records.
  assert.ok(Math.abs(dV / nSubFlow) / col.VcellMob_mL > 1.0,
    'fixture must be one where the flow-based choice is actually unstable');
});

test('§3.5 substep cap — the column advances LESS, it never inflates dt (C-06)', () => {
  const config = presets.normalizePreset(PRESET, { column: { nz: 50, nSubMax: 8 } });
  const cfg = bed.buildColumnCfg(config);
  const col = columnMod.createColumn(cfg);
  columnMod.resetColumn(col, null);

  const Q = flow_mLs(col);
  const uI = (Q / col.A_cm2) / col.epsC;
  const dtMax = Math.min(col.nuTarget * col.dz_cm / uI, col.dtCap_s);
  const dt = 20 * dtMax;
  const dV = Q * dt;
  const cIn = new Float64Array(col.nsCol);
  cIn[0] = 1.0;

  const r = columnMod.stepColumn(col, dt, Q, cIn, dV);
  assert.equal(r.nSub, 8, 'nSub is capped at nSubMax');
  assert.equal(r.status, 1, 'status 1 = speed-limited');
  assertRel(r.speedDeficit, 20 / 8, 1e-12, 'speedDeficit = ceil(dt/dtMax)/nSubMax');
  assertRel(r.dtAdvanced_s, 8 * dtMax, 1e-12, 'dtAdvanced = nSubMax*dtMax');
  assert.ok(r.dtAdvanced_s < dt, 'the cap must advance LESS than asked');
  assert.ok(r.courant <= col.nuTarget + 1e-12,
    'the per-substep Courant must stay at the target even when capped');
  // Volume fidelity: only the ADVANCED volume may be counted as delivered, so bed.accumulate can
  // carry the remainder without losing or duplicating solute.
  const dVAdvanced = dV * (r.dtAdvanced_s / dt);
  assertRel(col.massIn_umol[0], Math.abs(dVAdvanced) * 1.0, 1e-12,
    'massIn must count the advanced volume only');
});

test('§3.5 substep independence — one N-substep call equals N one-substep calls', () => {
  // nuTarget is set to the substep Courant number so that dtMax === dtSub and the batched call is
  // forced to choose exactly N substeps. N = 8 is a power of two, so `N*x` and `(N*x)/N` are exact
  // in float64 and the two paths see bit-identical dtSub and dVSub.
  const NU = 0.5;
  const N = 8;
  const mk = () => {
    const b = buildAnalyticColumn({
      nz: 30,
      speciesOverrides: { tracer: { epsPi: 0.85 } },
      column: { nuTarget: NU },
    });
    columnMod.resetColumn(b.col, null);
    return b;
  };
  const a = mk();
  const b = mk();
  const i = colIdx(a.cfg, 'tracer');
  const Q = flow_mLs(a.col);
  const dVsub = NU * (1 - 1e-9) * a.col.VcellMob_mL;
  const dtsub = dVsub / Q;
  const cIn = new Float64Array(a.col.nsCol);
  cIn[i] = 1.0;

  // Precondition both columns identically so `cInHold` already matches `cIn` and the §6.9.4
  // active-window bookkeeping (`inletChanged`, `fullPassCounter`) is in the same state on both
  // sides. Without this the batched call would see one `inletChanged` for all N substeps and the
  // stepped call would see it only on the first — a legitimate difference in the WINDOW, not in
  // the scheme, and not what this test is about.
  for (let k = 0; k < 4; k++) {
    columnMod.stepColumn(a.col, dtsub, Q, cIn, dVsub);
    columnMod.stepColumn(b.col, dtsub, Q, cIn, dVsub);
  }
  assert.equal(a.col.diag.fullPassCounter, b.col.diag.fullPassCounter, 'preconditioning matched');

  // `a` is asked for the whole interval and must split it into exactly N substeps; `b` is handed
  // the same N substeps one at a time. Identical dtSub, dVSub and coefficients => identical state.
  const ra = columnMod.stepColumn(a.col, N * dtsub, Q, cIn, N * dVsub);
  assert.equal(ra.nSub, N, 'the batched call must choose exactly N substeps');
  for (let k = 0; k < N; k++) {
    const rb = columnMod.stepColumn(b.col, dtsub, Q, cIn, dVsub);
    assert.equal(rb.nSub, 1);
  }
  for (let k = 0; k < a.col.c.length; k++) {
    assert.equal(a.col.c[k], b.col.c[k], `c[${k}] must be bit-identical`);
    assert.equal(a.col.q[k], b.col.q[k], `q[${k}] must be bit-identical`);
  }
  assert.equal(a.col.massIn_umol[i], b.col.massIn_umol[i], 'massIn bit-identical');
  assert.equal(a.col.massOut_umol[i], b.col.massOut_umol[i], 'massOut bit-identical');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §6.9.3 — zero flow and flow reversal
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§6.9.3 zero flow — S1/S2 skipped, S3 still runs, mass exactly held', () => {
  const { cfg, col } = buildAnalyticColumn({
    nz: 30, speciesOverrides: { tracer: { epsPi: 0.85, keffScale: 1e-4 } },
  });
  const i = colIdx(cfg, 'tracer');
  columnMod.resetColumn(col, null);

  const Q = flow_mLs(col);
  const dV = 0.5 * col.VcellMob_mL;
  const cIn = new Float64Array(col.nsCol);
  cIn[i] = 1.0;
  for (let k = 0; k < 8; k++) columnMod.stepColumn(col, dV / Q, Q, cIn, dV);

  const massBefore = columnMod.totalMass_umol(col, new Float64Array(col.nsCol))[i];
  const inBefore = col.massIn_umol[i];
  const outBefore = col.massOut_umol[i];
  const qBefore = col.q[i * col.nz];

  // keffScale 1e-4 leaves the particle phase far from equilibrium, so S3 has real work to do.
  const r = columnMod.stepColumn(col, 5.0, 0, new Float64Array(col.nsCol), 0);

  assert.equal(r.courant, 0, 'zero flow => zero Courant');
  assert.equal(r.dtAdvanced_s, 5.0, 'a zero-flow hold advances the full dt (dtMax = dtCap)');
  assert.equal(col.massIn_umol[i], inBefore, 'S2 must not run at zero flow (massIn)');
  assert.equal(col.massOut_umol[i], outBefore, 'S2 must not run at zero flow (massOut)');
  assert.ok(col.q[i * col.nz] > qBefore, 'S3 must still run at zero flow (q must move)');

  const massAfter = columnMod.totalMass_umol(col, new Float64Array(col.nsCol))[i];
  // relaxCell conserves c + phi*q exactly per cell; totalMass weighs with epsC/(1-epsC) and
  // createColumn recomputes phi = (1-epsC)/epsC, so the two agree to machine precision.
  assertRel(massAfter, massBefore, 1e-13, 'a zero-flow hold must not change the inventory');
});

test('§6.9.3 flow reversal — an unretained pulse pushed in and pulled back out is fully recovered', () => {
  const { cfg, col } = buildAnalyticColumn({ nz: 40, speciesOverrides: { tracer: { epsPi: 0 } } });
  const i = colIdx(cfg, 'tracer');
  columnMod.resetColumn(col, null);

  const Q = flow_mLs(col);
  const dV = 0.5 * col.VcellMob_mL;
  const dt = dV / Q;
  const cIn = new Float64Array(col.nsCol);

  cIn[i] = 1.0;
  for (let k = 0; k < 4; k++) columnMod.stepColumn(col, dt, Q, cIn, dV);
  cIn[i] = 0.0;
  for (let k = 0; k < 10; k++) columnMod.stepColumn(col, dt, Q, cIn, dV);

  const injected = col.massIn_umol[i];
  assert.equal(col.massOut_umol[i], 0, 'the pulse must still be inside the column');

  // Reverse: the sweep mirrors and the ghost face moves to n = nz-1; cell 0 becomes the outlet.
  const held = new Float64Array(col.nsCol);
  let n = 0;
  do {
    columnMod.stepColumn(col, dt, Q, cIn, -dV);
    columnMod.totalMass_umol(col, held);
    n++;
  } while (held[i] > 1e-12 && n < 1000);

  assert.ok(n < 1000, 'the reversed pulse must leave the column');
  // Nothing was created or destroyed: everything that went in came back out of the inlet face.
  assertRel(col.massOut_umol[i], injected, 1e-12, 'reversed recovery');
  const res = columnMod.massBalanceResidual(col, new Float64Array(col.nsCol));
  assert.ok(Math.abs(res[i]) < 1e-12,
    `reversal must not disturb the ledger, residual ${res[i]}`);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §7.2.4 / §7.2.6 — Donnan on/off and the T18 salt front
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('T18 — salt-front first moment is the mass-balance chord, 0.7538 CV +/- 2 % (§7.2.6, C-43)', () => {
  const nz = 60;
  const config = presets.normalizePreset(PRESET, {
    column: { nz, dtCap_s: 3600, nuTarget: 0.999 },
  });
  const cfg = bed.buildColumnCfg(config);
  const col = columnMod.createColumn(cfg);
  const iNa = colIdx(cfg, 'Na');
  const c0 = tankVectorCol(config, cfg, 'TK-EQ');     // Na 50, Cl 13.986, AcT 50 — charge balanced
  const c1 = tankVectorCol(config, cfg, 'TK-ELU');    // Na 500, Cl 461.757, AcT 50
  assertRel(c0[iNa], 50.0, 1e-9, 'fixture low salt');
  assertRel(c1[iNa], 500.0, 1e-9, 'fixture high salt');
  columnMod.resetColumn(col, c0);

  const VR_CV = breakthroughFirstMoment_CV(col, iNa, c0, c1, 0.8, 4.0);
  // The contract's band. The wave is dispersive on a convex isotherm, so the first moment is the
  // CHORD dq/dc, not the secant q*(c1)/c1 (which would give 0.7200 — the rejected value, §11.3).
  assertRel(VR_CV, 0.7538, 0.02, 'T18 salt-front V_R/CV');

  // ... and it IS the chord: recompute it straight off the isotherm and demand agreement to 1e-4,
  // which is what proves the transport is reproducing the isotherm and not something else.
  const scratch = new Float64Array(cfg.comps.length);
  const q0 = new Float64Array(cfg.comps.length);
  const q1 = new Float64Array(cfg.comps.length);
  isoMod.computeQStar(col.iso, c0, c0[iNa], scratch, q0);
  isoMod.computeQStar(col.iso, c1, c1[iNa], scratch, q1);
  const chord = (q1[iNa] - q0[iNa]) / (c1[iNa] - c0[iNa]);
  assertRel(VR_CV, col.epsC + (1 - col.epsC) * chord, 1e-4,
    'the measured first moment must equal epsC + (1-epsC)*dq/dc');
});

test('§7.2.4 Donnan on/off — disabling it makes the salt purely pore-permeating (0.9025 CV)', () => {
  const run = (enableDonnan) => {
    const config = presets.normalizePreset(PRESET, {
      column: { nz: 60, dtCap_s: 3600, nuTarget: 0.999, enableDonnan },
    });
    const cfg = bed.buildColumnCfg(config);
    const col = columnMod.createColumn(cfg);
    const iNa = colIdx(cfg, 'Na');
    const c0 = tankVectorCol(config, cfg, 'TK-EQ');
    const c1 = tankVectorCol(config, cfg, 'TK-ELU');
    columnMod.resetColumn(col, c0);
    return breakthroughFirstMoment_CV(col, iNa, c0, c1, 0.8, 4.0);
  };
  // With the partition switched off q* collapses to the pore-liquid baseline epsPi*c, i.e. Kt is
  // exactly epsPi = 0.85, so the front must sit on the epsT degenerate case of §7.2.5.
  assertRel(run(false), 0.9025, 1e-4, 'Donnan OFF -> epsT');
  // With it on, the counter-ion is enriched in the pore and the chord is well below epsT.
  assertRel(run(true), 0.7538, 0.02, 'Donnan ON -> the T18 chord');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * T10 — mass conservation, positivity, and the unsafe-clamp ledger
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('T10 — column mass conservation < 1e-11 relative over 200 000 substeps (§10)', () => {
  const { cfg, col } = shippedCycleDrive(200000);
  assert.ok(col.substepCounter >= 200000,
    `drive produced ${col.substepCounter} substeps, needed 200 000`);
  assert.equal(col.faulted, false, 'the NaN tripwire must not have fired');

  const res = columnMod.massBalanceResidual(col, new Float64Array(cfg.comps.length));
  for (let i = 0; i < res.length; i++) {
    assert.ok(Math.abs(res[i]) < 1e-11,
      `${cfg.comps[i].id}: |residual| ${Math.abs(res[i]).toExponential(3)} >= 1e-11 ` +
      `after ${col.substepCounter} substeps`);
  }
});

test('§6.9.3 S4 positivity — no negative concentration or particle load survives a full cycle', () => {
  const { cfg, col } = shippedCycleDrive(200000);
  let minC = Infinity, minQ = Infinity, minCell = -1;
  for (let k = 0; k < col.c.length; k++) {
    if (col.c[k] < minC) { minC = col.c[k]; minCell = k; }
    if (col.q[k] < minQ) minQ = col.q[k];
  }
  assert.ok(minC >= 0, `min c = ${minC} at index ${minCell} (species ${cfg.comps[Math.floor(minCell / col.nz)].id})`);
  assert.ok(minQ >= 0, `min q = ${minQ}`);
  assert.ok(Number.isFinite(minC) && Number.isFinite(minQ), 'no NaN/Infinity in the state');
});

test('§2.2 unsafe-clamp ledger — massDefect_umol "must stay at zero"', () => {
  // §2.2: "massDefect_umol is deliberately uncompensated — it is a diagnostic that must stay at
  // zero". §6.9.3 S3/S4 and §6.7.2 both call their clamps UNSAFE and say upwind transport under
  // the Courant condition makes them unreachable. DoD 7's |xi| < 1e-6 is only attainable when this
  // ledger is zero. Any non-zero entry is therefore a defect, not a tolerance question.
  const { cfg, col } = shippedCycleDrive(200000);
  const offenders = [];
  for (let i = 0; i < cfg.comps.length; i++) {
    if (col.massClamped_umol[i] !== 0) {
      offenders.push(`${cfg.comps[i].id}=${col.massClamped_umol[i].toExponential(3)} umol ` +
        `(${(col.massClamped_umol[i] / Math.max(col.massIn_umol[i], 1e-12)).toExponential(2)} of massIn)`);
    }
  }
  assert.deepEqual(offenders, [],
    `col.massClamped_umol must be all-zero after ${col.substepCounter} substeps ` +
    `(clampCount ${col.diag.clampCount}); non-zero: ${offenders.join(', ')}`);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * DoD 7 — the run-level mass balance
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('DoD 7 — the column-plane ledger closes exactly (in - out + clamped = delta holdup)', () => {
  const { config, run } = fastShortRun();
  bed.forceFlush(config, run, 'MASS_AUDIT');
  const mb = pooling.massBalance(config, run);
  assert.equal(mb.flushed, true, 'forceFlush must leave colBatch empty');

  // The identity `mass0 + in - out + clamped = now` is what physics/column.js maintains. Stated in
  // massBalance's own terms, `column_umol = now - mass0`, so `in - out + defect - column === 0`.
  // Tolerance 1e-11 relative to massIn — the same order T10 demands of the solver.
  for (let i = 0; i < config.ns; i++) {
    if (mb.in_umol[i] === 0) continue;
    const resid = mb.in_umol[i] - mb.out_umol[i] + mb.defect_umol[i] - mb.column_umol[i];
    const rel = Math.abs(resid) / Math.abs(mb.in_umol[i]);
    assert.ok(rel < 1e-11,
      `${config.species[i].id}: column-plane ledger residual ${rel.toExponential(3)} >= 1e-11`);
  }
});

test('DoD 7 — pooling.massBalance returns flushed && ok, every |xi| < 1e-6 (§5.11.4)', () => {
  const { config, run } = fastShortRun();
  bed.forceFlush(config, run, 'MASS_AUDIT');
  const mb = pooling.massBalance(config, run);
  assert.equal(mb.flushed, true, 'forceFlush must leave colBatch empty');

  const bad = [];
  for (let i = 0; i < config.ns; i++) {
    if (!(Math.abs(mb.xi[i]) < 1e-6)) {
      bad.push(`${config.species[i].id}: xi=${mb.xi[i].toExponential(3)} ` +
        `(in=${mb.in_umol[i].toExponential(4)}, defect=${mb.defect_umol[i].toExponential(3)}, ` +
        `-2*defect/in=${(-2 * mb.defect_umol[i] / mb.in_umol[i]).toExponential(3)})`);
    }
  }
  assert.deepEqual(bad, [], `species outside the DoD 7 band: ${bad.join(' | ')}`);
  assert.equal(mb.ok, true, 'massBalance().ok');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * T29 / DoD 6 — determinism
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('T29 / DoD 6 — 1x and 1000x produce bit-identical log arrays and event lists', () => {
  const fast = fastShortRun();
  const slow = runShortMethod(1, 40);

  assert.equal(fast.run.tick, slow.run.tick, 'tick count');
  assert.equal(fast.run.t_s, slow.run.t_s, 't_s');
  assert.equal(fast.run.V_tot_mL, slow.run.V_tot_mL, 'V_tot_mL');
  assert.equal(fast.run.log.n, slow.run.log.n, 'log row count');
  assert.equal(fast.run.frac.records.length, slow.run.frac.records.length, 'fraction count');

  const n = fast.run.log.n;
  for (const name of logMod.NUMERIC_CHANNELS) {
    const a = logMod.column(fast.run.log, name);
    const b = logMod.column(slow.run.log, name);
    assert.equal(!!a, !!b, `channel ${name} present in both`);
    if (!a) continue;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
      assert.equal(a[i], b[i], `channel ${name} row ${i}: ${a[i]} !== ${b[i]}`);
    }
  }

  // The only legitimate difference is the operator's own "Speed Nx" action, which records the
  // speed that was set. Everything else — including every solver-side RNG draw — must match.
  const strip = (run) => run.events
    .filter((e) => !(e.type === 'OPERATOR_ACTION' && e.detail && 'speed' in e.detail))
    .map((e) => JSON.stringify(e));
  assert.deepEqual(strip(fast.run), strip(slow.run), 'event lists');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §6.9 — serialise round-trip
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§6.9 serializeColumn/deserializeColumn — bit-identical state and identical continuation', () => {
  const { cfg, col } = buildAnalyticColumn({
    nz: 25, speciesOverrides: { tracer: { epsPi: 0.85 } },
  });
  const i = colIdx(cfg, 'tracer');
  columnMod.resetColumn(col, null);

  const Q = flow_mLs(col);
  const dV = 0.5 * col.VcellMob_mL;
  const dt = dV / Q;
  const cIn = new Float64Array(col.nsCol);
  cIn[i] = 1.0;
  for (let k = 0; k < 6; k++) columnMod.stepColumn(col, dt, Q, cIn, dV);

  const restored = columnMod.deserializeColumn(columnMod.serializeColumn(col));
  assert.equal(restored.nz, col.nz);
  assert.equal(restored.nsCol, col.nsCol);
  for (let k = 0; k < col.c.length; k++) {
    assert.equal(restored.c[k], col.c[k], `c[${k}]`);
    assert.equal(restored.q[k], col.q[k], `q[${k}]`);
  }
  for (let k = 0; k < col.nsCol; k++) {
    assert.equal(restored.massIn_umol[k], col.massIn_umol[k], `massIn[${k}]`);
    assert.equal(restored.massOut_umol[k], col.massOut_umol[k], `massOut[${k}]`);
    assert.equal(restored.mass0_umol[k], col.mass0_umol[k], `mass0[${k}]`);
  }

  // A restored column must also STEP identically — the serialised form has to carry every field
  // the update reads, not just the state arrays.
  for (let k = 0; k < 6; k++) {
    columnMod.stepColumn(col, dt, Q, cIn, dV);
    columnMod.stepColumn(restored, dt, Q, cIn, dV);
  }
  for (let k = 0; k < col.c.length; k++) {
    assert.equal(restored.c[k], col.c[k], `c[${k}] after continuation`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * §6.9 — describeColumn geometry (the identities every other test leans on)
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('§6.9/§8.1 describeColumn — the shipped pilot geometry and the porosity identities', () => {
  const config = presets.normalizePreset(PRESET, { column: { nz: 30 } });
  const cfg = bed.buildColumnCfg(config);
  const col = columnMod.createColumn(cfg);
  const d = columnMod.describeColumn(col);

  assertRel(d.V_mL, 1570.7963267948966, 1e-12, 'CV of the 10.0 x 20.0 cm pilot column (§8.1)');
  assert.equal(d.epsC, 0.35);
  assert.equal(d.epsP, 0.85);
  assertRel(d.epsT, 0.35 + 0.65 * 0.85, 1e-15, 'epsT = epsC + (1-epsC)*epsP');
  assert.equal(d.epsT, 0.9025, 'epsT is 0.9025, with no exceptions (C-42)');
  assertRel(d.phi, (1 - 0.35) / 0.35, 1e-15, 'phi = (1-epsC)/epsC');
  assertRel(d.V0_mL + d.Vpore_mL, d.Vt_mL, 1e-12, 'V_0 + V_pore = V_t');
  assertRel(d.Vbead_mL, d.Vpore_mL + d.Vskel_mL, 1e-12, 'V_bead = V_pore + V_skeleton');
  assertRel(d.dz_cm * d.nz, col.L_cm, 1e-15, 'dz*nz = L');
  assertRel(col.VcellMob_mL * col.nz, d.V0_mL, 1e-12, 'nz*VcellMob = V_0');
});
