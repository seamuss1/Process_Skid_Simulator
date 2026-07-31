/**
 * tests/skid.test.js — the skid layer: topology and hold-up, the tanks-in-series cascade, the
 * pumps and the gradient proportioner, the run state machine, the pre-run checks, watch
 * evaluation, fractionation and the alarm-driven flow reduction.
 *
 * Contract: architecture-v2 §5.4.4c, §5.4.5, §5.5, §5.5.1, §5.6, §5.6.2, §5.7, §6.12–§6.17,
 * §7.4, §10.
 *
 * The expectations here are analytic wherever an analytic form exists: the mean residence volume
 * of a cascade of CSTRs is the sum of its tank volumes (exactly, for any plate count), the ramp
 * time is Qmax/rampRate, the LPGF ripple is the §7.4.2 closed form, the fraction execution volume
 * is the decision volume plus a contracted hold-up, and the segment hold-ups are the §5.7.3
 * formulas recomputed from the segment table rather than copied from `config.skid.holdup`.
 *
 * Zero dependencies, no DOM, `node --test tests/` on Node 20+.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePreset } from '../src/data/presets.js';
import { SEGMENT_TABLE } from '../src/data/library.js';
import { createRunState } from '../src/core/state.js';
import { createBus } from '../src/core/log.js';
import * as sim from '../src/core/sim.js';
import * as skid from '../src/skid/skid.js';
import * as fluidics from '../src/skid/fluidics.js';
import * as engine from '../src/skid/engine.js';
import * as fractionator from '../src/skid/fractionator.js';

const PRESET_LAB = 'cex-capture-igg1-lab';
const PRESET_PILOT = 'cex-capture-igg1-pilot';

/* ------------------------------------------------------------------------------------------- */
/* helpers                                                                                      */
/* ------------------------------------------------------------------------------------------- */

function makeCtx(presetId, overrides) {
  const config = normalizePreset(presetId, overrides || {});
  const run = createRunState(config);
  skid.createSkid(config, run);        // REQUIRED: physicsTick asserts run.topo (§6.3, §11 C-26)
  return { config, run, bus: createBus(), sim: {}, fmt: {}, overrides: {} };
}

function assertClose(actual, expected, absTol, what) {
  assert.ok(Number.isFinite(actual), `${what}: expected a finite number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= absTol,
    `${what}: ${actual} is not within ${absTol} of ${expected} (off by ${actual - expected})`);
}

function assertRel(actual, expected, relTol, what) {
  assert.ok(Number.isFinite(actual), `${what}: expected a finite number, got ${actual}`);
  const r = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(r <= relTol, `${what}: ${actual} vs ${expected} is ${r} relative, tolerance ${relTol}`);
}

/** Shallow config overlay — every function under test reads `config`, none of them mutates it. */
const overlay = (config, patch) => Object.assign({}, config, patch);
const patchBlocks = (config, fn) => overlay(config, {
  method: Object.assign({}, config.method, { blocks: config.method.blocks.map(fn) }),
});

const eventsOfType = (run, type) => run.events.filter((e) => e.type === type);

/* ------------------------------------------------------------------------------------------- */
/* §5.7 — segment hold-up, dispersion and the derived table                                     */
/* ------------------------------------------------------------------------------------------- */

/** The §5.7.3 derived hold-ups, recomputed here from the segment table itself. */
function expectedHoldup(scale) {
  const segs = SEGMENT_TABLE[scale];
  const byId = new Map(segs.map((s) => [s.id, s]));
  const V = (id) => (byId.has(id) ? byId.get(id).V_mL : 0);
  const varOf = (id) => (byId.has(id) ? byId.get(id).V_mL ** 2 / byId.get(id).N : 0);
  const grad = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'];
  const Vgrad = grad.reduce((a, id) => a + V(id), 0);
  const varGrad = grad.reduce((a, id) => a + varOf(id), 0);
  const halfD3 = V('D3') / 2;
  return {
    Vsuction_mL: V('S1A') + V('S2A'),
    Vgrad_mL: Vgrad,
    VcolOutToUV_mL: V('D1') + V('D2') + halfD3,
    VuvToCond_mL: halfD3 + V('D4') + V('D5') / 2,
    VcondToPh_mL: V('D5') / 2 + V('D6') + V('D7') / 2,
    VphToFracValve_mL: V('D7') / 2 + V('D8'),
    VuvToFracValve_mL: halfD3 + V('D4') + V('D5') + V('D6') + V('D7') + V('D8'),
    VfracDeadLeg_mL: V('D9'),
    VsampleLine_mL: V('A1') + V('A2'),
    sigmaGrad_mL: Math.sqrt(varGrad),
    NeffGrad: Vgrad * Vgrad / varGrad,
    // The UV half-cell enters as ONE tank of volume D3/2, i.e. variance (D3/2)^2.
    sigmaInjToUV_mL: Math.sqrt(varOf('G6') + varOf('G7') + varOf('G8') + varOf('G9')
      + varOf('D1') + varOf('D2') + halfD3 * halfD3),
  };
}

test('§5.7.3 — the derived hold-up table reproduces on all three scales', () => {
  // The printed §5.7.3 values, so a change to the segment table is caught by two independent
  // routes: the formulas above and these literals. Each carries HALF A UNIT IN ITS OWN LAST
  // PRINTED PLACE as its tolerance — nothing looser, and nothing invented. The two `NeffGrad`
  // entries the §5.7.2 table truncates rather than rounds (4.67, 5.16) are taken from that
  // section's own prose, which prints 4.6678 and 5.1652.
  const printed = {
    LAB: { VcolOutToUV_mL: [0.57, 5e-3], VuvToCond_mL: [0.22, 5e-3], VcondToPh_mL: [0.45, 5e-3],
      VphToFracValve_mL: [0.55, 5e-3], VuvToFracValve_mL: [1.22, 5e-3],
      VfracDeadLeg_mL: [0.35, 5e-3], Vsuction_mL: [1.55, 5e-3], Vgrad_mL: [3.80, 5e-3],
      sigmaGrad_mL: [2.026, 5e-4], NeffGrad: [3.518, 5e-4], sigmaInjToUV_mL: [0.25606, 5e-6],
      VsampleLine_mL: [1.8, 5e-2] },
    PILOT: { VcolOutToUV_mL: [36.25, 5e-3], VuvToCond_mL: [6.75, 5e-3], VcondToPh_mL: [17.50, 5e-3],
      VphToFracValve_mL: [26.0, 5e-2], VuvToFracValve_mL: [50.25, 5e-3],
      VfracDeadLeg_mL: [18.0, 5e-2], Vsuction_mL: [37.0, 5e-2], Vgrad_mL: [245.0, 5e-2],
      sigmaGrad_mL: [113.40, 5e-3], NeffGrad: [4.6678, 5e-5], sigmaInjToUV_mL: [16.155, 5e-4],
      VsampleLine_mL: [45, 5e-1] },
    PROCESS: { VcolOutToUV_mL: [652.5, 5e-2], VuvToCond_mL: [107.5, 5e-2],
      VcondToPh_mL: [300.0, 5e-2], VphToFracValve_mL: [425.0, 5e-2],
      VuvToFracValve_mL: [832.5, 5e-2], VfracDeadLeg_mL: [250.0, 5e-2], Vsuction_mL: [600.0, 5e-2],
      Vgrad_mL: [3940.0, 5e-2], sigmaGrad_mL: [1733.6, 5e-2], NeffGrad: [5.1652, 5e-5],
      sigmaInjToUV_mL: [291.90, 5e-3], VsampleLine_mL: [750, 5e-1] },
  };

  for (const scale of ['LAB', 'PILOT', 'PROCESS']) {
    const topo = skid.buildTopology({ scale, ns: 1, skid: {}, species: [] });
    const want = expectedHoldup(scale);
    for (const key of Object.keys(want)) {
      assertRel(topo.holdup[key], want[key], 1e-12, `${scale} ${key} against the §5.7.3 formula`);
    }
    for (const key of Object.keys(printed[scale])) {
      const [value, tol] = printed[scale][key];
      assertClose(topo.holdup[key], value, tol, `${scale} ${key} against §5.7.3`);
    }
  }
});

test('§5.7.3 / §11 C-68 — the two values that did not reproduce in v1', () => {
  const lab = skid.buildTopology({ scale: 'LAB', ns: 1, skid: {}, species: [] });
  const proc = skid.buildTopology({ scale: 'PROCESS', ns: 1, skid: {}, species: [] });

  // LAB NeffGrad: variance sum over G1..G9 is 4.1050417 mL^2, so 3.80^2/4.1050417 = 3.5176.
  assertRel(lab.holdup.sigmaGrad_mL ** 2, 4.1050417, 1e-6, 'LAB gradient variance sum');
  assertClose(lab.holdup.NeffGrad, 3.518, 0.001, 'LAB NeffGrad (3.518, not 3.56)');

  // PROCESS sigmaInjToUV: 5000 + 1200 + 15000 + 24500 + 24500 + 15000 + 6.25 = 85 206.25 mL^2.
  assertRel(proc.holdup.sigmaInjToUV_mL ** 2, 85206.25, 1e-9, 'PROCESS inj->UV variance sum');
  assertClose(proc.holdup.sigmaInjToUV_mL, 291.90, 0.01, 'PROCESS sigmaInjToUV (291.90, not 269.5)');
});

test('§5.7.3 — the 10-90 % smear of a step is 2.563 sigma on every scale', () => {
  // Half a unit in the last printed place, as above.
  const printed = { LAB: [5.19, 5e-3], PILOT: [290.6, 5e-2], PROCESS: [4443, 5e-1] };
  for (const scale of ['LAB', 'PILOT', 'PROCESS']) {
    const topo = skid.buildTopology({ scale, ns: 1, skid: {}, species: [] });
    const smear = 2.563 * topo.holdup.sigmaGrad_mL;
    assertClose(smear, printed[scale][0], printed[scale][1], `${scale} 10-90 % gradient smear`);
  }
  // 2.563 is 2 x the standard-normal 10/90 quantile: the 10-90 % rise of a Gaussian-shaped
  // step response is 2*1.2816*sigma.
  assertClose(2 * 1.2815516, 2.563, 5e-4, '2.563 is 2 x z(0.90)');
});

test('§6.12 — segmentVariance_mL2 and effectivePlates are the tanks-in-series identities', () => {
  // N equal tanks of total volume V have variance V^2/N and effective plate count N, exactly.
  const segs = [{ V_mL: 10, N: 5 }];
  assertRel(skid.segmentVariance_mL2(segs), 100 / 5, 1e-15, 'one segment variance');
  assertRel(skid.effectivePlates(segs), 5, 1e-15, 'one segment N_eff');

  // Two segments in series add variances. When their TANK volumes are equal (2 mL each here) the
  // chain is just N1+N2 equal tanks and N_eff is exactly 7.
  const equal = [{ V_mL: 10, N: 5 }, { V_mL: 4, N: 2 }];
  assertRel(skid.segmentVariance_mL2(equal), 100 / 5 + 16 / 2, 1e-15, 'two-segment variance');
  assertRel(skid.effectivePlates(equal), 5 + 2, 1e-15, 'equal tanks give N_eff = N1 + N2');

  // When the tank volumes differ, one large tank dominates the variance and N_eff falls BELOW the
  // tank count — which is exactly why the gradient path's 58 tanks are worth only 3.5 plates.
  const uneven = [{ V_mL: 10, N: 5 }, { V_mL: 4, N: 1 }];
  assertRel(skid.effectivePlates(uneven), 196 / (20 + 16), 1e-15, 'uneven two-segment N_eff');
  assert.ok(skid.effectivePlates(uneven) < 5 + 1, 'unequal tanks lower the effective plate count');

  assert.ok(Number.isNaN(skid.effectivePlates([{ V_mL: 0, N: 1 }])), 'zero volume gives NaN');
});

test('§6.12 — pathVolume_mL and pathSigma_mL span the inclusive segment range', () => {
  const topo = skid.buildTopology({ scale: 'LAB', ns: 1, skid: {}, species: [] });
  assertRel(skid.pathVolume_mL(topo, 'D1', 'D2'), 0.20 + 0.35, 1e-12, 'D1..D2 volume');
  assertRel(skid.pathVolume_mL(topo, 'D2', 'D1'), 0.20 + 0.35, 1e-12, 'the range is order-free');
  assertRel(skid.pathSigma_mL(topo, 'D1', 'D2'), Math.sqrt(0.04 / 5 + 0.1225 / 6), 1e-12,
    'D1..D2 sigma');
  assert.ok(Number.isNaN(skid.pathVolume_mL(topo, 'D1', 'NOPE')), 'an unknown id yields NaN');
});

/* ------------------------------------------------------------------------------------------- */
/* §7.4.5 — the cascade: hold-up, dispersion and the three detector planes                      */
/* ------------------------------------------------------------------------------------------- */

/**
 * Drive a 0 -> 1 step into the detector chain at constant flow and return, for each measurement
 * plane, the mean residence VOLUME `integral (1 - F) dV` and the mean residence TIME.
 *
 * The mean residence volume of a cascade of CSTRs is the SUM OF ITS TANK VOLUMES exactly,
 * whatever the plate distribution — which is what makes this an analytic test of the §5.7.3
 * hold-ups rather than a recording of the code's output.
 */
function stepResponse(config, Q_mLs, dt_s, spanFactor) {
  const run = createRunState(config);
  skid.createSkid(config, run);
  const ns = config.ns;
  skid.seedSegments(config, run, new Float64Array(ns));
  run.Q_actual_mLs = Q_mLs;
  run.valves.columnValve = 'DOWN';
  run.valves.outletValve = 'WASTE';
  run.yColOut_mM.fill(0);
  run.yColOut_mM[0] = 1;                                    // step on the tracer

  const H = config.skid.holdup;
  const Vspan = spanFactor * (H.VcolOutToUV_mL + H.VuvToCond_mL + H.VcondToPh_mL);
  const steps = Math.ceil(Vspan / (Q_mLs * dt_s));
  const dV = Q_mLs * dt_s;
  const mu = [0, 0, 0];
  const prev = [0, 0, 0];
  for (let s = 0; s < steps; s++) {
    skid.advanceSegments(config, run, dt_s, 'DOWNSTREAM');
    const cur = [run.yDet_mM[0], run.yCond_mM[0], run.yPh_mM[0]];
    for (let p = 0; p < 3; p++) { mu[p] += 0.5 * ((1 - prev[p]) + (1 - cur[p])) * dV; prev[p] = cur[p]; }
  }
  return { muV: mu, muT: mu.map((v) => v / Q_mLs), tail: prev, run };
}

test('§5.7.3 / §7.4.5 — UV, conductivity and pH lag the column outlet by DIFFERENT hold-ups', () => {
  const config = normalizePreset(PRESET_LAB, {});
  const H = config.skid.holdup;
  const Q = 0.01;
  const dt = 0.01;
  const r = stepResponse(config, Q, dt, 8);

  for (const f of r.tail) assertClose(f, 1, 1e-4, 'the step response must have completed');

  // The exponential kernel is exact per tank but the discrete cascade adds dt/2 of transport lag
  // per tank (mean = dt/(1 - exp(-Q dt/V)) instead of V/Q). Up to the pH plane that is 36 tanks,
  // worth 36*Q*dt/2 = 1.8e-3 mL against a 1.24 mL hold-up, i.e. 0.15 %. The 0.5 % band below is
  // therefore three times the known bias and nothing else.
  const nTanks = (plane) => plane - r.run.topo.segOffset[r.run.topo.detector[0]] + 1;
  const biasV = (plane) => nTanks(plane) * Q * dt / 2;
  assert.ok(biasV(r.run.topo.phTank) / (H.VcolOutToUV_mL + H.VuvToCond_mL + H.VcondToPh_mL) < 5e-3,
    'the discretisation bias is inside the tolerance this test uses');

  assertRel(r.muV[0], H.VcolOutToUV_mL, 5e-3, 'column outlet -> UV cell centre');
  assertRel(r.muV[1], H.VcolOutToUV_mL + H.VuvToCond_mL, 5e-3, 'column outlet -> conductivity cell');
  assertRel(r.muV[2], H.VcolOutToUV_mL + H.VuvToCond_mL + H.VcondToPh_mL, 5e-3,
    'column outlet -> pH chamber');

  // The three lags must be DIFFERENT, by the contracted increments — a build that wires all three
  // sensors to the same tank passes every total above only if it also fails these.
  assertRel(r.muV[1] - r.muV[0], H.VuvToCond_mL, 5e-3, 'UV -> conductivity increment');
  assertRel(r.muV[2] - r.muV[1], H.VcondToPh_mL, 5e-3, 'conductivity -> pH increment');
  assert.ok(r.muV[0] < r.muV[1] && r.muV[1] < r.muV[2], 'the planes are strictly ordered');
  assert.ok(r.muV[1] - r.muV[0] > 0.20 * r.muV[0], 'the UV/cond gap is not a rounding artefact');
});

test('§5.4.4c rule 2 / §7.4.4 — delay volumes are constant in mL and halve in time at 2x flow', () => {
  const config = normalizePreset(PRESET_LAB, {});
  const dt = 0.01;
  const a = stepResponse(config, 0.01, dt, 8);
  const b = stepResponse(config, 0.02, dt, 8);

  for (let p = 0; p < 3; p++) {
    assertRel(b.muV[p], a.muV[p], 5e-3, `plane ${p} delay is the same VOLUME at 2x flow`);
    assertRel(a.muT[p] / b.muT[p], 2, 5e-3, `plane ${p} delay TIME halves at 2x flow`);
  }

  // The pilot's own numbers: 50.25 mL of UV -> fraction-valve hold-up is 15.4 s at 196.35 mL/min
  // and 7.7 s at 392.7 mL/min (§7.4.4).
  const pilot = normalizePreset(PRESET_PILOT, {});
  const delay_mL = pilot.skid.holdup.VuvToFracValve_mL;
  assertClose(delay_mL, 50.25, 1e-9, 'pilot VuvToFracValve_mL');
  assertClose(delay_mL / (196.35 / 60), 15.4, 0.1, 'the same hold-up is 15.4 s at 196.35 mL/min');
  assertClose(delay_mL / (392.7 / 60), 7.7, 0.05, 'and 7.7 s at 392.7 mL/min');
});

test('§7.4.5 — the cascade is unconditionally stable at Q*dt/V = 50', () => {
  const config = normalizePreset(PRESET_LAB, {});
  const run = createRunState(config);
  skid.createSkid(config, run);
  const ns = config.ns;
  skid.seedSegments(config, run, new Float64Array(ns));

  const topo = run.topo;
  let Vmin = Infinity;
  for (let t = 0; t < topo.nTanksTotal; t++) {
    if (topo.Vtank_mL[t] > 0 && topo.Vtank_mL[t] < Vmin) Vmin = topo.Vtank_mL[t];
  }
  const dt = 1.0;
  const Q = 50 * Vmin / dt;                     // Q*dt/V = 50 in the SMALLEST tank
  assertRel(Q * dt / Vmin, 50, 1e-12, 'the fixture really sits at Q*dt/V = 50');

  run.Q_actual_mLs = Q;
  run.valves.columnValve = 'DOWN';
  run.yColOut_mM.fill(0);
  run.yColOut_mM[0] = 1;

  let prevUV = -1;
  for (let s = 0; s < 200; s++) {
    skid.advanceSegments(config, run, dt, 'DOWNSTREAM');
    for (let t = 0; t < topo.nTanksTotal; t++) {
      const c = run.segC_mM[t * ns];
      // Explicit Euler at Q*dt/V = 50 would overshoot to -49 on the first step; the exponential
      // kernel a = exp(-50) cannot leave [inlet, initial] at any Courant number.
      assert.ok(c >= -1e-15 && c <= 1 + 1e-12,
        `tank ${t} left [0,1] at step ${s}: ${c} — the kernel is not unconditionally stable`);
    }
    assert.ok(run.yDet_mM[0] >= prevUV - 1e-15, `the UV plane overshot at step ${s}`);
    prevUV = run.yDet_mM[0];
  }
  assertClose(prevUV, 1, 1e-9, 'and it converges to the inlet composition');
});

test('§5.7.5 — dead-leg accounting: D9 is traversed only while a port is collecting', () => {
  const config = normalizePreset(PRESET_LAB, {});
  const topo = skid.buildTopology(config);
  const deadLeg = topo.deadLeg.map((k) => topo.segments[k]);
  assert.equal(deadLeg.length, 1, 'exactly one DEAD_LEG segment');
  assert.equal(deadLeg[0].id, 'D9', 'the dead leg is D9');
  assertRel(config.skid.holdup.VfracDeadLeg_mL, deadLeg[0].V_mL, 1e-12,
    'VfracDeadLeg_mL is D9 and nothing else');
  // D9 is downstream of the fraction valve, so it is NOT part of the UV -> valve delay.
  assert.ok(config.skid.holdup.VuvToFracValve_mL > 0);
  const withDeadLeg = config.skid.holdup.VuvToFracValve_mL + config.skid.holdup.VfracDeadLeg_mL;
  assert.ok(withDeadLeg > config.skid.holdup.VuvToFracValve_mL,
    'the dead leg sits beyond the decision plane');
});

/* ------------------------------------------------------------------------------------------- */
/* §6.13 / §7.4.3 — pumps, the ramp and the flow envelope                                       */
/* ------------------------------------------------------------------------------------------- */

test('§6.13 — the pump ramp is exactly rampRate_mLs2 with the ripple switched off', () => {
  // With `rippleFlow_frac = 0` the ramp is the bare first-order law and can be pinned to machine
  // precision: Q_n = min(Q_set, n * rampRate * dt), and the ramp completes in Q_set/rampRate.
  const { config, run } = makeCtx(PRESET_LAB, { skid: { rippleFlow_frac: 0 } });
  const sk = config.skid;
  assert.equal(sk.rippleFlow_frac, 0, 'the fixture really has the ripple off');
  const dt = config.sim.dtPhys_s;
  const step = sk.rampRate_mLs2 * dt;
  const target = 0.5 * sk.Qmax_mLs;
  run.state = 'RUNNING';
  run.Q_set_mLs = target;

  const nFull = Math.ceil(target / step);
  for (let n = 1; n <= nFull + 5; n++) {
    fluidics.updatePumps(config, run, dt);
    assertClose(run.Q_actual_mLs, Math.min(target, n * step), 1e-12, `ramp envelope at tick ${n}`);
  }
  assertClose(nFull * dt, target / sk.rampRate_mLs2, dt, 'the ramp completes in Q_set/rampRate');

  // Ramping DOWN uses the same rate.
  run.Q_set_mLs = 0;
  for (let n = 1; n <= nFull + 5; n++) {
    fluidics.updatePumps(config, run, dt);
    assertClose(run.Q_actual_mLs, Math.max(0, target - n * step), 1e-12, `ramp-down at tick ${n}`);
  }
});

test('§7.4.3 — with the ripple on, the settled flow sits inside +/-rippleFlow_frac of the setpoint', () => {
  const { config, run } = makeCtx(PRESET_LAB, {});
  const sk = config.skid;
  const dt = config.sim.dtPhys_s;
  const rho = sk.rippleFlow_frac;
  const target = 0.5 * sk.Qmax_mLs;
  run.state = 'RUNNING';
  run.Q_set_mLs = target;

  // Settle first: the ramp needs target/rampRate seconds plus the ripple's own settling.
  const nFull = Math.ceil(target / (sk.rampRate_mLs2 * dt));
  for (let n = 0; n < nFull + 60; n++) fluidics.updatePumps(config, run, dt);

  let mx = -Infinity;
  let mn = Infinity;
  let sum = 0;
  const N = 2000;
  for (let k = 0; k < N; k++) {
    fluidics.updatePumps(config, run, dt);
    mx = Math.max(mx, run.Q_actual_mLs);
    mn = Math.min(mn, run.Q_actual_mLs);
    sum += run.Q_actual_mLs;
  }
  assert.ok(mx <= target * (1 + rho) + 1e-12, 'the ripple never exceeds +rippleFlow_frac');
  assert.ok(mn >= target * (1 - rho) - 1e-12, 'nor -rippleFlow_frac');
  assert.ok(mx - mn > rho * target, 'and the ripple is actually present');
  // A zero-mean sine averages out: the mean delivered flow is the setpoint to within 1 %.
  assertRel(sum / N, target, 0.01, 'the mean delivered flow is the setpoint');
});

test('§7.4.3 — the flow ripple is a phase accumulator at f = 2Q/Vstroke, never an integrator', () => {
  const { config, run } = makeCtx(PRESET_LAB, {});
  const sk = config.skid;
  run.Q_actual_mLs = 0.2;
  run.ripplePhase_rad = 0;
  const dt = 0.05;
  const f_Hz = 2 * 0.2 / sk.Vstroke_mL;
  const r = fluidics.flowRipple(config, run, dt);
  assertClose(run.ripplePhase_rad, 2 * Math.PI * f_Hz * dt % (2 * Math.PI), 1e-12,
    'the phase advances by 2*pi*f*dt');
  assertClose(r, sk.rippleFlow_frac * Math.sin(run.ripplePhase_rad), 1e-15,
    'and the ripple is sampled analytically at the new phase');
  // The phase stays wrapped no matter how long it runs.
  for (let k = 0; k < 10000; k++) fluidics.flowRipple(config, run, dt);
  assert.ok(run.ripplePhase_rad >= 0 && run.ripplePhase_rad < 2 * Math.PI, 'the phase stays wrapped');
});

test('§5.5 / §6.13 — the flow envelope: Qmax clamp, Q_limit, RAMP_ZERO and ZERO_NOW', () => {
  const { config, run } = makeCtx(PRESET_LAB, {});
  const sk = config.skid;
  const dt = config.sim.dtPhys_s;

  // A setpoint above Qmax is clamped, never delivered.
  run.state = 'RUNNING';
  run.Q_set_mLs = 10 * sk.Qmax_mLs;
  for (let k = 0; k < 1000; k++) fluidics.updatePumps(config, run, dt);
  assert.ok(run.Q_actual_mLs <= sk.Qmax_mLs * (1 + sk.rippleFlow_frac) + 1e-12,
    'Q_actual is clamped at Qmax');

  // Q_limit_mLs (the REDUCE_FLOW controller's output) caps it further.
  run.Q_limit_mLs = 0.25 * sk.Qmax_mLs;
  for (let k = 0; k < 1000; k++) fluidics.updatePumps(config, run, dt);
  assertRel(run.Q_actual_mLs, 0.25 * sk.Qmax_mLs, sk.rippleFlow_frac + 1e-9, 'Q_limit caps the flow');
  run.Q_limit_mLs = Infinity;

  // PAUSED ramps to zero; FAULT drops to zero on the same tick, with no ramp (§5.5).
  for (let k = 0; k < 1000; k++) fluidics.updatePumps(config, run, dt);
  const before = run.Q_actual_mLs;
  assert.ok(before > 0);
  run.state = 'PAUSED';
  fluidics.updatePumps(config, run, dt);
  assert.ok(run.Q_actual_mLs > 0, 'PAUSED ramps down, it does not stop dead');
  assert.ok(run.Q_actual_mLs < before, 'and it is already falling');
  run.state = 'FAULT';
  fluidics.updatePumps(config, run, dt);
  assert.equal(run.Q_actual_mLs, 0, 'FAULT drops flow to zero immediately');

  for (const st of ['IDLE', 'READY', 'ENDED']) {
    run.state = st;
    run.Q_actual_mLs = 0.5 * sk.Qmax_mLs;
    for (let k = 0; k < 1000; k++) fluidics.updatePumps(config, run, dt);
    assert.equal(run.Q_actual_mLs, 0, `${st} commands zero flow`);
  }
});

/* ------------------------------------------------------------------------------------------- */
/* §6.13 / §7.4.2 — gradient proportioning                                                      */
/* ------------------------------------------------------------------------------------------- */

test('§6.13 — HPGF proportioning is exact: QA=(1-x)Q, QB=xQ, tee = flow-weighted blend', () => {
  const { config, run } = makeCtx(PRESET_LAB, { skid: { gradientMode: 'HPGF' } });
  run.rng = null;                       // silence the AR(1) walk: pctBError draws 0 with no stream
  run.biasPctB = 0;
  run.walkPctB = 0;
  const Q = 0.1;
  run.Q_actual_mLs = Q;
  run.pctB_set = 37;

  const na = config.idxById.Na;
  run.yPumpA_mM.fill(0);
  run.yPumpB_mM.fill(0);
  run.yPumpA_mM[na] = 50;
  run.yPumpB_mM[na] = 500;

  fluidics.updateProportioner(config, run, 0.05);
  assertClose(run.QA_mLs, 0.63 * Q, 1e-15, 'QA = (1-x) Qbuf');
  assertClose(run.QB_mLs, 0.37 * Q, 1e-15, 'QB = x Qbuf');
  assertClose(run.QA_mLs + run.QB_mLs, Q, 1e-15, 'the two branches sum to the buffer flow');
  assertClose(run.pctB_actual, 37, 1e-12, 'HPGF carries no chop ripple');
  assertClose(run.yTee_mM[na], 0.63 * 50 + 0.37 * 500, 1e-12, 'the tee is the flow-weighted blend');
});

test('§7.4.2 — LPGF quantises the duty to tMinOpen/chopPeriod and adds the analytic ripple', () => {
  const { config, run } = makeCtx(PRESET_LAB, {});
  const sk = config.skid;
  assert.equal(sk.gradientMode, 'LPGF', 'the shipped pilot/lab skid is low-pressure gradient form');
  run.rng = null;
  run.biasPctB = 0;
  run.walkPctB = 0;
  const Q = 0.083776;                                  // 150 cm/h on the lab column
  run.Q_actual_mLs = Q;

  // 2.0 s / 0.040 s = 50 quanta, so the delivered duty moves in steps of exactly 2 %B.
  const nQ = Math.round(sk.chopPeriod_s / sk.tMinOpen_s);
  assert.equal(nQ, 50, 'the shipped chop period gives 50 duty quanta');
  for (const [set, want] of [[0, 0], [30, 0.30], [31, 0.32], [37, 0.38], [50, 0.50], [100, 1]]) {
    run.pctB_set = set;
    run.chopPhase_s = 0;
    fluidics.updateProportioner(config, run, 0.05);
    const x = run.QB_mLs / Math.max(run.QA_mLs + run.QB_mLs, 1e-30);
    assertClose(x, want, 1e-12, `duty at ${set} %B is quantised to ${want}`);
  }

  // §7.4.2 ripple, closed form: tau_mix = V_mix/Q, atten = 1/sqrt(1+(2 pi f tau)^2),
  // ripple_pk = (4/pi) min(x, 1-x) atten, sampled at the square-wave phase.
  const tauMix_s = sk.mixerVolume_mL / Q;
  const atten = 1 / Math.sqrt(1 + (2 * Math.PI * (1 / sk.chopPeriod_s) * tauMix_s) ** 2);
  const ripplePk = (4 / Math.PI) * 0.5 * atten;
  run.pctB_set = 50;
  run.chopPhase_s = 0;
  fluidics.updateProportioner(config, run, 0.05);            // phase 0.05 s of 2.0 s -> +1
  assertClose(run.pctB_actual, 100 * 0.5 + 100 * ripplePk, 1e-9, 'ripple at the positive half-cycle');
  run.chopPhase_s = 1.0;
  fluidics.updateProportioner(config, run, 0.05);            // phase 1.05 s of 2.0 s -> -1
  assertClose(run.pctB_actual, 100 * 0.5 - 100 * ripplePk, 1e-9, 'ripple at the negative half-cycle');

  // The 100 mL lab mixer at 0.0838 mL/s attenuates a 0.5 Hz chop by 75x: the ripple is under 1 %B.
  assert.ok(100 * ripplePk < 1.0, `the mixer must attenuate the chop: ${100 * ripplePk} %B`);
});

test('§6.13 — a commanded 0 %B or 100 %B closes the other pump, bias or no bias', () => {
  const { config, run } = makeCtx(PRESET_LAB, {});
  run.rng = null;
  run.walkPctB = 0;
  run.biasPctB = 5;                     // 5 percentage points of proportioner bias
  run.Q_actual_mLs = 0.1;

  run.pctB_set = 0;
  fluidics.updateProportioner(config, run, 0.05);
  assert.equal(run.QB_mLs, 0, 'a closed B valve does not leak at 0 %B');
  assertClose(run.QA_mLs, 0.1, 1e-15, 'and all the flow is on A');

  run.pctB_set = 100;
  fluidics.updateProportioner(config, run, 0.05);
  assert.equal(run.QA_mLs, 0, 'a closed A valve does not leak at 100 %B');
  assertClose(run.QB_mLs, 0.1, 1e-15, 'and all the flow is on B');

  // In between, the bias DOES move the delivered duty — that is the modelled instrument error.
  run.pctB_set = 50;
  fluidics.updateProportioner(config, run, 0.05);
  const x = run.QB_mLs / (run.QA_mLs + run.QB_mLs);
  assert.ok(x > 0.5, `a +5 point bias must raise the delivered duty above 0.50, got ${x}`);
});

/* ------------------------------------------------------------------------------------------- */
/* §5.5 — the run state machine                                                                 */
/* ------------------------------------------------------------------------------------------- */

/** An independent transcription of the §5.5 graph — the point is that it is NOT imported. */
const CONTRACT_TRANSITIONS = {
  IDLE: ['READY'],
  READY: ['IDLE', 'RUNNING'],
  RUNNING: ['HELD', 'PAUSED', 'ALARM', 'ENDED', 'FAULT'],
  HELD: ['RUNNING', 'PAUSED', 'ENDED', 'ALARM', 'FAULT'],
  PAUSED: ['RUNNING', 'HELD', 'ENDED', 'ALARM', 'FAULT'],
  ALARM: ['HELD', 'PAUSED', 'ENDED', 'FAULT'],
  ENDED: ['IDLE'],
  FAULT: ['IDLE'],
};

test('§5.5 — LEGAL_TRANSITIONS matches the contract graph, edge for edge', () => {
  assert.deepEqual(engine.RUN_STATES.slice().sort(), Object.keys(CONTRACT_TRANSITIONS).sort());
  for (const from of engine.RUN_STATES) {
    assert.deepEqual(engine.LEGAL_TRANSITIONS[from].slice().sort(),
      CONTRACT_TRANSITIONS[from].slice().sort(), `outgoing edges of ${from}`);
    for (const to of engine.RUN_STATES) {
      const want = from === to || CONTRACT_TRANSITIONS[from].indexOf(to) >= 0;
      assert.equal(engine.canTransition(from, to), want, `canTransition(${from}, ${to})`);
    }
  }
  // §5.5's STATE_TABLE, spot-checked on the rows that carry behaviour this file relies on.
  assert.equal(engine.STATE_TABLE.HELD.pumps, 'SETPOINT', 'HELD keeps flow at the setpoint');
  assert.equal(engine.STATE_TABLE.PAUSED.pumps, 'RAMP_ZERO', 'PAUSED ramps flow to zero');
  assert.equal(engine.STATE_TABLE.FAULT.pumps, 'ZERO_NOW', 'FAULT stops immediately');
  assert.equal(engine.STATE_TABLE.ALARM.valves, 'DIVERT', 'an ALARM diverts the outlet');
  assert.equal(engine.STATE_TABLE.ALARM.ackRequired, true);
});

test('§5.5 — setRunState rejects every illegal transition with its own reason and never throws', () => {
  const { config, run } = makeCtx(PRESET_LAB, {});
  const illegal = [
    ['IDLE', 'RUNNING'], ['IDLE', 'HELD'], ['IDLE', 'ENDED'],
    ['READY', 'HELD'], ['READY', 'PAUSED'], ['READY', 'ALARM'], ['READY', 'ENDED'],
    ['ENDED', 'RUNNING'], ['ENDED', 'READY'],
    ['FAULT', 'READY'], ['FAULT', 'RUNNING'], ['FAULT', 'HELD'], ['FAULT', 'ENDED'],
    ['ALARM', 'RUNNING'],                       // §5.5: an alarm is left through HELD or PAUSED
  ];
  for (const [from, to] of illegal) {
    run.state = from;
    const r = engine.setRunState(config, run, to, 'test');
    assert.equal(r.ok, false, `${from} -> ${to} must be rejected`);
    assert.ok(typeof r.reason === 'string' && r.reason.includes(from) && r.reason.includes(to),
      `${from} -> ${to} must be rejected with its own message, got "${r.reason}"`);
    assert.equal(run.state, from, `${from} -> ${to} must leave the state alone`);
  }

  // An unknown target is rejected, not thrown.
  run.state = 'IDLE';
  const bogus = engine.setRunState(config, run, 'SPINNING', 'test');
  assert.equal(bogus.ok, false);
  assert.equal(run.state, 'IDLE');

  // A self-transition is a legal no-op.
  assert.equal(engine.setRunState(config, run, 'IDLE', 'test').ok, true);

  // ALARM -> HELD -> RUNNING is the sanctioned route back.
  run.state = 'ALARM';
  assert.equal(engine.setRunState(config, run, 'HELD', 'ack').ok, true);
  assert.equal(engine.setRunState(config, run, 'RUNNING', 'resume').ok, true);
  assert.equal(run.state, 'RUNNING');
  assert.equal(run.manualOverride, false, '§5.5: manual mode is force-cleared into RUNNING');
});

/* ------------------------------------------------------------------------------------------- */
/* §5.5.1 — the twelve pre-run checks                                                           */
/* ------------------------------------------------------------------------------------------- */

test('§5.5.1 — all twelve pre-run checks are reachable, and all fire at once', () => {
  const base = normalizePreset(PRESET_LAB, {});
  const fresh = () => { const r = createRunState(base); skid.createSkid(base, r); return r; };
  const codesOf = (config, run) => {
    const res = engine.preRunChecks(config, run);
    assert.ok(Array.isArray(res.failures), 'preRunChecks returns {ok, failures[]}');
    for (const f of res.failures) {
      assert.equal(typeof f.code, 'string');
      assert.equal(typeof f.message, 'string');
      assert.equal(typeof f.acknowledgeable, 'boolean');
    }
    return res;
  };

  // The shipped method passes; the only failure is the acknowledgeable PRC-12 (the CIP block
  // runs 0.5 M NaOH past the pH probe), so `ok` is still true.
  const clean = codesOf(base, fresh());
  assert.equal(clean.ok, true, 'the shipped lab method passes the READY gate');
  assert.deepEqual(clean.failures.map((f) => f.code), ['PRC-12']);
  assert.equal(clean.failures[0].acknowledgeable, true);

  const has = (res, code) => res.failures.some((f) => f.code === code);
  const ackOf = (res, code) => res.failures.find((f) => f.code === code).acknowledgeable;

  // PRC-01 — an inlet with no tank.
  {
    const c = overlay(base, { inletAssignments: Object.assign({}, base.inletAssignments, { A1: null }) });
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-01') && !ackOf(r, 'PRC-01') && r.ok === false, 'PRC-01');
  }
  // PRC-02 — a tank below its demand (acknowledgeable).
  {
    const run = fresh();
    run.tankVolume_mL.fill(0);
    const r = codesOf(base, run);
    assert.ok(has(r, 'PRC-02') && ackOf(r, 'PRC-02') && r.ok === true, 'PRC-02 is acknowledgeable');
  }
  // PRC-03 — no waste headroom (acknowledgeable).
  {
    const run = fresh();
    run.wasteVolume_mL = base.skid.wasteCapacity_mL;
    const r = codesOf(base, run);
    assert.ok(has(r, 'PRC-03') && ackOf(r, 'PRC-03'), 'PRC-03');
  }
  // PRC-04 — a block outside the pump envelope.
  {
    const c = patchBlocks(base, (b) => (b.id === 'B03'
      ? Object.assign({}, b, { flow: { mode: 'ML_MIN', value: 1e6, rampOverride_mLs2: null } }) : b));
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-04') && !ackOf(r, 'PRC-04') && r.ok === false, 'PRC-04');
  }
  // PRC-05 — the P1 trip above the hardware rating.
  {
    const c = overlay(base, {
      alarms: base.alarms.map((a) => (a.id === 'ALM-P1-02' ? Object.assign({}, a, { threshold: 99 }) : a)),
    });
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-05') && !ackOf(r, 'PRC-05'), 'PRC-05');
  }
  // PRC-06 — inconsistent column geometry.
  {
    const c = overlay(base, { column: Object.assign({}, base.column, { V_mL: base.column.V_mL * 1.5 }) });
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-06') && !ackOf(r, 'PRC-06'), 'PRC-06');
  }
  // PRC-07 — a fraction shorter than 10 valve switches.
  {
    const c = patchBlocks(base, (b) => (b.id === 'B04'
      ? Object.assign({}, b, {
        fractionation: Object.assign({}, b.fractionation, {
          minFractionVolume: { basis: 'mL', value: 1e-6 },
        }),
      }) : b));
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-07') && !ackOf(r, 'PRC-07'), 'PRC-07');
  }
  // PRC-08 — a non-positive duration.
  {
    const c = patchBlocks(base, (b) => (b.id === 'B03'
      ? Object.assign({}, b, { duration: { basis: 'CV', value: 0, onTimeout: 'NEXT', repeatLimit: 0 } }) : b));
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-08') && !ackOf(r, 'PRC-08'), 'PRC-08');
  }
  // PRC-09 — a GOTO to a block that does not exist.
  {
    const c = patchBlocks(base, (b) => (b.id === 'B03'
      ? Object.assign({}, b, {
        watches: [{
          id: 'W-BAD', signal: 'UV_280', operator: 'ABOVE', threshold: 1, slopeWindow: null,
          stableTolerance: 0, arm: { basis: 'CV', value: 0 }, persistence_ticks: 1,
          action: 'GOTO_BLOCK', actionParam: 'B99', oneShot: true, useDelayCompensated: false,
        }],
      }) : b));
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-09') && !ackOf(r, 'PRC-09'), 'PRC-09');
  }
  // PRC-10 — a degraded pH electrode (acknowledgeable).
  {
    const run = fresh();
    run.ph.slopePct = 80;
    const r = codesOf(base, run);
    assert.ok(has(r, 'PRC-10') && ackOf(r, 'PRC-10'), 'PRC-10');
  }
  // PRC-11 — a load defined with no enabled LOAD block (acknowledgeable).
  {
    const c = patchBlocks(base, (b) => (b.type === 'LOAD' ? Object.assign({}, b, { enabled: false }) : b));
    const r = codesOf(c, fresh());
    assert.ok(has(r, 'PRC-11') && ackOf(r, 'PRC-11'), 'PRC-11');
  }
  // PRC-12 — cleared by routing the CIP block around the detectors.
  {
    const c = patchBlocks(base, (b) => (b.type === 'CIP'
      ? Object.assign({}, b, { columnValve: 'CIP_DETECTOR_BYPASS' }) : b));
    const r = codesOf(c, fresh());
    assert.equal(r.failures.length, 0, 'PRC-12 clears once the probe is out of the CIP path');
    assert.equal(r.ok, true);
  }

  // ALL failures are reported at once — not the first one.
  {
    const c = patchBlocks(overlay(base, {
      column: Object.assign({}, base.column, { V_mL: base.column.V_mL * 1.5 }),
    }), (b) => (b.id === 'B03'
      ? Object.assign({}, b, { duration: { basis: 'CV', value: 0, onTimeout: 'NEXT', repeatLimit: 0 } }) : b));
    const run = fresh();
    run.ph.slopePct = 80;
    const r = codesOf(c, run);
    for (const code of ['PRC-06', 'PRC-08', 'PRC-10', 'PRC-12']) {
      assert.ok(has(r, code), `${code} must still be reported alongside the others`);
    }
    assert.equal(r.ok, false, 'ok is false because PRC-06 and PRC-08 are not acknowledgeable');
  }
});

/* ------------------------------------------------------------------------------------------- */
/* §5.4.4c — watch evaluation                                                                   */
/* ------------------------------------------------------------------------------------------- */

const WATCH = (o) => Object.assign({
  id: 'W', signal: 'UV_280', operator: 'ABOVE', threshold: 1.0, slopeWindow: null,
  stableTolerance: 0, arm: { basis: 'CV', value: 0 }, persistence_ticks: 1,
  action: 'MARK', actionParam: null, oneShot: true, useDelayCompensated: false,
}, o);

/** A run parked in RUNNING on block `blockIdx`, with that block's watches replaced. */
function watchFixture(watches, blockIdx = 0) {
  const base = normalizePreset(PRESET_LAB, {});
  const config = patchBlocks(base, (b, i) => (i === blockIdx ? Object.assign({}, b, { watches }) : b));
  const run = createRunState(config);
  skid.createSkid(config, run);
  run.state = 'RUNNING';
  run.blockIndex = blockIdx;
  engine.initWatchStates(config, run, blockIdx);
  return { config, run };
}
const setUV = (config, run, AUcm) => { run.uv.Afilt[0] = AUcm * config.skid.uv.pathlength_cm; };
const firedCount = (run, id) =>
  run.events.filter((e) => e.type === 'WATCH_FIRED' && e.detail.watchId === id).length;

test('§5.4.4c rule 3 — a watch cannot fire before its arm volume on the BLOCK totaliser', () => {
  const { config, run } = watchFixture([WATCH({ id: 'W-ARM', arm: { basis: 'CV', value: 0.5 } })]);
  setUV(config, run, 5);                                     // condition satisfied from tick 0
  run.V_block_mL = 0.4999 * config.column.V_mL;
  for (let k = 0; k < 20; k++) engine.evaluateWatches(config, run, 0.1);
  assert.equal(firedCount(run, 'W-ARM'), 0, 'not armed below 0.5 CV of block volume');
  assert.equal(run.watchState[0].armed, false);

  run.V_block_mL = 0.5 * config.column.V_mL;
  engine.evaluateWatches(config, run, 0.1);
  assert.equal(run.watchState[0].armed, true, 'armed once the block totaliser reaches 0.5 CV');
  assert.equal(firedCount(run, 'W-ARM'), 1, 'and it fires on that tick');
});

test('§5.4.4c rule 4 — persistence needs consecutive ticks; one miss resets the counter to 0', () => {
  const { config, run } = watchFixture([WATCH({ id: 'W-P', persistence_ticks: 5 })]);
  run.V_block_mL = 100;
  const seq = [5, 5, 5, 5, 0, 5, 5, 5, 5, 5];      // 4 hits, a miss, then 5 hits
  const counts = [];
  for (const v of seq) {
    setUV(config, run, v);
    engine.evaluateWatches(config, run, 0.1);
    counts.push(run.watchState[0].count);
  }
  assert.deepEqual(counts.slice(0, 5), [1, 2, 3, 4, 0], 'a single failing tick resets the counter');
  assert.equal(firedCount(run, 'W-P'), 1, 'it fires exactly once');
  // It fired on the tenth tick — the fifth consecutive hit after the miss, not the ninth.
  const idx = run.events.findIndex((e) => e.type === 'WATCH_FIRED');
  assert.ok(idx >= 0);
  assert.deepEqual(counts.slice(5), [1, 2, 3, 4, 0], 'the counter is cleared on the firing tick');
});

test('§5.4.4c rule 5 — RISES_ABOVE is edge-triggered, ABOVE is level-triggered', () => {
  {
    const { config, run } = watchFixture([WATCH({ id: 'W-EDGE', operator: 'RISES_ABOVE' })]);
    run.V_block_mL = 100;
    setUV(config, run, 5);                                   // already above at arm time
    for (let k = 0; k < 10; k++) engine.evaluateWatches(config, run, 0.1);
    assert.equal(firedCount(run, 'W-EDGE'), 0, 'an edge watch does not fire from the wrong side');
    assert.equal(run.watchState[0].prevSide, 1, 'and it records which side it armed on');

    setUV(config, run, 0.1);
    engine.evaluateWatches(config, run, 0.1);                // cross below
    setUV(config, run, 5);
    engine.evaluateWatches(config, run, 0.1);                // and back above -> the edge
    assert.equal(firedCount(run, 'W-EDGE'), 1, 'it fires on the crossing');
  }
  {
    const { config, run } = watchFixture([WATCH({ id: 'W-LEVEL', operator: 'ABOVE' })]);
    run.V_block_mL = 100;
    setUV(config, run, 5);
    engine.evaluateWatches(config, run, 0.1);
    assert.equal(firedCount(run, 'W-LEVEL'), 1, 'a level watch fires immediately at arm time');
  }
});

test('§5.4.4c rule 8 — array order: every non-terminal first, then the FIRST terminal only', () => {
  const { config, run } = watchFixture([
    WATCH({ id: 'W-T1', action: 'END_BLOCK' }),
    WATCH({ id: 'W-N', action: 'MARK' }),
    WATCH({ id: 'W-T2', action: 'PAUSE' }),
  ]);
  run.V_block_mL = 100;
  setUV(config, run, 5);
  engine.evaluateWatches(config, run, 0.1);

  assert.equal(firedCount(run, 'W-N'), 1, 'the non-terminal fired');
  assert.equal(eventsOfType(run, 'NOTE').length, 1, 'and its MARK action ran');
  assert.equal(run.blockIndex, 1, 'the FIRST terminal (END_BLOCK) was applied');
  assert.equal(run.state, 'RUNNING', 'the SECOND terminal (PAUSE) was NOT applied');
});

test('§5.4.4c rule 9 — a duration timeout is distinguishable from a watch-driven block end', () => {
  {
    const { config, run } = watchFixture([]);                // no watches: the duration decides
    run.V_block_mL = 1e9;
    engine.advanceBlockClock(config, run, 0.1);
    const timeouts = eventsOfType(run, 'WATCH_TIMEOUT');
    assert.equal(timeouts.length, 1, 'a timeout logs WATCH_TIMEOUT');
    assert.equal(timeouts[0].detail.onTimeout, 'NEXT', 'carrying the onTimeout policy');
    const ends = eventsOfType(run, 'BLOCK_END');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].detail.reason, 'TIMEOUT', 'and the block end is reasoned TIMEOUT');
  }
  {
    const { config, run } = watchFixture([WATCH({ id: 'W-E', action: 'END_BLOCK' })]);
    run.V_block_mL = 100;
    setUV(config, run, 5);
    engine.evaluateWatches(config, run, 0.1);
    assert.equal(eventsOfType(run, 'WATCH_TIMEOUT').length, 0, 'a watch end logs no WATCH_TIMEOUT');
    const ends = eventsOfType(run, 'BLOCK_END');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].detail.reason, 'WATCH', 'the block end is reasoned WATCH');
  }
});

test('§5.4.4c rules 6, 7, 15 — slope, STABLE and CHANGES_BY refuse to invent state', () => {
  // Rule 6: fewer than 8 samples in the window -> NaN, and a signal with no lane -> NaN.
  const { config, run } = watchFixture([WATCH({
    id: 'W-S', operator: 'ABS_SLOPE_BELOW', threshold: 1,
    slopeWindow: { basis: 'CV', value: 0.05 },
  })]);
  assert.ok(Number.isNaN(engine.signalSlope(config, run, 'UV_280', 100)),
    'an empty ring yields NaN, so a slope watch cannot fire');
  assert.ok(Number.isNaN(engine.signalSlope(config, run, 'PH', 100)),
    'a signal with no lane in the ring yields NaN');
  assert.equal(engine.isStable(config, run, 'UV_280', 1, 100), false,
    'STABLE is false when the slope is not evaluable');
  assert.equal(engine.isStable(config, run, 'UV_280', 1, 0), false,
    'and false for a non-positive window');

  // Rule 15: CHANGES_BY reads valueAtArm, which is NaN until the arm tick, so it cannot fire.
  const f = watchFixture([WATCH({
    id: 'W-C', operator: 'CHANGES_BY', threshold: 0.5, arm: { basis: 'CV', value: 0.5 },
  })]);
  setUV(f.config, f.run, 5);
  f.run.V_block_mL = 0;
  engine.evaluateWatches(f.config, f.run, 0.1);
  assert.ok(Number.isNaN(f.run.watchState[0].valueAtArm), 'valueAtArm is NaN before the arm tick');
  assert.equal(firedCount(f.run, 'W-C'), 0, 'and CHANGES_BY cannot fire against NaN');

  f.run.V_block_mL = 0.5 * f.config.column.V_mL;
  engine.evaluateWatches(f.config, f.run, 0.1);              // arms here, valueAtArm = 5
  assertClose(f.run.watchState[0].valueAtArm, 5, 1e-12, 'valueAtArm is written once, at arm');
  assert.equal(firedCount(f.run, 'W-C'), 0, 'no change yet');
  setUV(f.config, f.run, 5.6);
  engine.evaluateWatches(f.config, f.run, 0.1);
  assert.equal(firedCount(f.run, 'W-C'), 1, 'and it fires once |x - valueAtArm| >= threshold');
});

test('§6.16 — initWatchStates builds one slope-ring lane per slope signal, plus the frac signal', () => {
  const { config, run } = watchFixture([
    WATCH({ id: 'W1', operator: 'SLOPE_ABOVE', signal: 'UV_280', slopeWindow: { basis: 'CV', value: 0.05 } }),
    WATCH({ id: 'W2', operator: 'STABLE', signal: 'COND', slopeWindow: { basis: 'CV', value: 0.05 } }),
    WATCH({ id: 'W3', operator: 'ABOVE', signal: 'PH' }),           // not a slope operator
    WATCH({ id: 'W4', operator: 'SLOPE_BELOW', signal: 'UV_280', slopeWindow: { basis: 'CV', value: 0.05 } }),
  ], 0);
  assert.deepEqual(run.slopeRing.signalIds, ['UV_280', 'COND'],
    'slope signals only, de-duplicated, in array order');
  assert.equal(run.slopeRing.nSig, 2);
  assert.equal(run.slopeRing.n, 0, 'history does not cross a block boundary');
  assert.equal(run.watchState.length, 4, 'one state per watch');
  for (const st of run.watchState) {
    assert.equal(st.armed, false);
    assert.equal(st.count, 0);
    assert.ok(Number.isNaN(st.valueAtArm));
  }
});

/* ------------------------------------------------------------------------------------------- */
/* §5.4.5 / §7.4.4 — fractionation and the delay compensation                                   */
/* ------------------------------------------------------------------------------------------- */

test('§7.4.4 — a fractionation decision is keyed on VOLUME, not on time', () => {
  const { config, run } = makeCtx(PRESET_PILOT, {});
  run.blockIndex = 3;                                        // B04, the PEAK-fractionated elution
  const delay_mL = config.skid.holdup.VuvToFracValve_mL;

  for (const Q of [3.2725, 6.5450]) {
    run.frac.queue.length = 0;
    run.Q_actual_mLs = Q;
    run.V_tot_mL = 1000;
    run.t_s = 500;
    fractionator.enqueue(config, run, 'OPEN', 'PEAK_START');
    assert.equal(run.frac.queue.length, 1);
    assertClose(run.frac.queue[0].V_exec_mL, 1000 + delay_mL, 1e-12,
      `COMPENSATED execution volume at Q = ${Q} mL/s`);
    assert.ok(Number.isNaN(run.frac.queue[0].t_exec_s), 'the volume key decides, not a time key');
  }

  // The queue is kept sorted ascending by execution volume (§5.4.5).
  run.frac.queue.length = 0;
  run.V_tot_mL = 2000;
  fractionator.enqueue(config, run, 'OPEN', 'A');
  run.V_tot_mL = 2100;
  fractionator.enqueue(config, run, 'CLOSE', 'B');
  assert.ok(run.frac.queue[0].V_exec_mL <= run.frac.queue[1].V_exec_mL, 'the queue is sorted');

  // FIXED_TIME converts the hold-up ONCE, at decision time, from the then-current flow.
  const ft = patchBlocks(config, (b) => (b.id === 'B04'
    ? Object.assign({}, b, {
      fractionation: Object.assign({}, b.fractionation, { delayCompensation: 'FIXED_TIME' }),
    }) : b));
  run.frac.queue.length = 0;
  run.Q_actual_mLs = 3.2725;
  run.t_s = 700;
  run.V_tot_mL = 3000;
  fractionator.enqueue(ft, run, 'OPEN', 'PEAK_START');
  assertClose(run.frac.queue[0].t_exec_s, 700 + delay_mL / 3.2725, 1e-9,
    'FIXED_TIME keys on a time computed once from the current flow');
});

/**
 * Drive the fractionator over a synthetic Gaussian UV peak expressed as a function of VOLUME, at
 * a flow the caller controls. Everything the fractionator reads is set explicitly, so the
 * fraction boundaries are a pure function of the volume axis.
 */
function fractionatePeak(config, flowAt, apex_mL = 60, sigma_mL = 12, apex_AUcm = 12) {
  const run = createRunState(config);
  skid.createSkid(config, run);
  run.state = 'RUNNING';
  run.blockIndex = 3;
  run.frac.mode = 'PEAK';
  run.frac.nextPortIdx = 0;
  const dtCtrl = config.sim.dtPhys_s * config.sim.ctrlEvery;
  const path_cm = config.skid.uv.pathlength_cm;
  let V = 0;
  for (let k = 0; k < 500000 && V <= 140; k++) {
    const Q = flowAt(V);
    run.Q_actual_mLs = Q;
    V += Q * dtCtrl;
    run.V_tot_mL = V;
    run.t_s += dtCtrl;
    run.uv.Afilt[0] = apex_AUcm * Math.exp(-0.5 * ((V - apex_mL) / sigma_mL) ** 2) * path_cm;
    fractionator.tickFractionator(config, run, dtCtrl);
  }
  if (run.frac.open) fractionator.closeFraction(config, run, 'BLOCK_END');
  return run;
}

test('§5.4.5 — COMPENSATED puts the valve plane exactly one hold-up beyond the decision plane', () => {
  const config = normalizePreset(PRESET_LAB, {});
  const delay_mL = config.skid.holdup.VuvToFracValve_mL;
  const Q = 0.083776;                                        // 150 cm/h
  const run = fractionatePeak(config, () => Q);
  const recs = run.frac.records;
  assert.ok(recs.length >= 3, `the peak should yield several fractions, got ${recs.length}`);

  for (const r of recs) {
    assertClose(r.startVolumeValve_mL - r.startVolume_mL, delay_mL, 1e-9,
      `fraction ${r.port}: the valve plane leads the detector plane by VuvToFracValve_mL`);
    assertClose(r.offsetError_mL, 0, 1e-9, `fraction ${r.port}: COMPENSATED has no offset error`);
    assert.equal(r.quality, 'OK');
  }

  // maxFractionVolume is 0.25 CV, and it takes precedence over everything (§5.4.5 rule 1).
  const max_mL = 0.25 * config.column.V_mL;
  for (const r of recs.slice(0, -1)) {
    assert.equal(r.trigger, 'MAX_VOLUME', 'the interior fractions are cut by the volume cap');
    assertClose(r.endVolume_mL - r.startVolume_mL, max_mL, 2 * Q * 0.1,
      'and each is exactly maxFractionVolume wide');
  }

  // The last fraction closes on the peak-stop threshold, whose crossing is analytic:
  // 12 AU/cm falls to the 2 AU/cm cut at apex + sigma*sqrt(2 ln 6), plus the persistence delay.
  const fr = config.method.blocks[3].fractionation;
  const stopV = 60 + 12 * Math.sqrt(2 * Math.log(12 / fr.stopThreshold.value));
  const persist_mL = fr.persistence_ticks * Q * (config.sim.dtPhys_s * config.sim.ctrlEvery);
  const last = recs[recs.length - 1];
  assert.equal(last.trigger, 'PEAK_STOP');
  assertClose(last.endVolume_mL, stopV + persist_mL, 0.05,
    'the peak stop lands at the analytic threshold crossing plus the persistence delay');

  // And the first fraction opens at the mirror-image crossing on the rising flank.
  const startV = 60 - 12 * Math.sqrt(2 * Math.log(12 / fr.startThreshold.value));
  assertClose(recs[0].startVolume_mL, startV + persist_mL, 0.05,
    'the peak start lands at the analytic rising crossing plus the persistence delay');

  // The apex is inside exactly one fraction.
  assert.equal(recs.filter((r) => r.containsPeakMax).length, 1, 'one fraction contains the apex');
});

test('§5.4.5 — UNCOMPENSATED collapses the two planes and reports the full offset error', () => {
  const config = normalizePreset(PRESET_LAB, {
    methodPatches: { B04: { fractionation: { delayCompensation: 'UNCOMPENSATED' } } },
  });
  assert.equal(config.method.blocks[3].fractionation.delayCompensation, 'UNCOMPENSATED');
  const run = fractionatePeak(config, () => 0.083776);
  const delay_mL = config.skid.holdup.VuvToFracValve_mL;
  assert.ok(run.frac.records.length >= 3);
  for (const r of run.frac.records) {
    assertClose(r.startVolumeValve_mL, r.startVolume_mL, 1e-9,
      'UNCOMPENSATED executes at the decision volume');
    assertClose(r.offsetError_mL, delay_mL, 1e-9,
      'and every fraction carries the whole hold-up as its offset error');
  }
});

test('§10 — fraction boundaries are unchanged in mL across a mid-peak flow doubling', () => {
  const config = normalizePreset(PRESET_LAB, {});
  const Q = 0.083776;
  const dtCtrl = config.sim.dtPhys_s * config.sim.ctrlEvery;
  const steady = fractionatePeak(config, () => Q).frac.records;
  const doubled = fractionatePeak(config, (V) => (V < 60 ? Q : 2 * Q)).frac.records;

  assert.equal(doubled.length, steady.length, 'the same number of fractions is cut');
  // The only volume-axis sensitivity left is the persistence counter, which is counted in TICKS:
  // 5 ticks at 2Q is 5*2*Q*dtCtrl = 0.084 mL. Everything else - the min/max caps, the threshold
  // crossings and the execution queue - is keyed on volume and must not move at all.
  const tol_mL = 2 * config.method.blocks[3].fractionation.persistence_ticks * 2 * Q * dtCtrl;
  assert.ok(tol_mL < 0.005 * config.column.V_mL, 'the tick quantum is well under 0.5 % of a CV');
  for (let k = 0; k < steady.length; k++) {
    assertClose(doubled[k].startVolume_mL, steady[k].startVolume_mL, tol_mL,
      `fraction ${k} start volume is unchanged by the flow change`);
    assertClose(doubled[k].endVolume_mL, steady[k].endVolume_mL, tol_mL,
      `fraction ${k} end volume is unchanged by the flow change`);
    assert.equal(doubled[k].port, steady[k].port, `fraction ${k} lands on the same port`);
    assert.equal(doubled[k].trigger, steady[k].trigger, `fraction ${k} has the same trigger`);
  }
});

test('§5.4.5 — the dead leg is reported under REPORT and diverted under DIVERT', () => {
  const deadLeg_mL = normalizePreset(PRESET_LAB, {}).skid.holdup.VfracDeadLeg_mL;

  const reported = fractionatePeak(normalizePreset(PRESET_LAB, {}), () => 0.083776).frac.records;
  for (const r of reported) {
    assertClose(r.carryover_mL, Math.min(deadLeg_mL, r.volume_mL), 1e-9,
      'REPORT records the first VfracDeadLeg_mL of every fraction as carry-over');
    assert.equal(r.divertedVolume_mL, 0, 'and diverts nothing');
    assert.ok(typeof r.carryoverFrom === 'string', 'the carry-over source is named');
  }

  const divertCfg = normalizePreset(PRESET_LAB, {
    methodPatches: { B04: { fractionation: { deadLegPolicy: 'DIVERT' } } },
  });
  const diverted = fractionatePeak(divertCfg, () => 0.083776).frac.records;
  assert.equal(diverted.length, reported.length, 'the cut points do not move');
  for (let k = 0; k < diverted.length; k++) {
    assert.equal(diverted[k].carryover_mL, 0, 'DIVERT leaves no carry-over');
    assertClose(diverted[k].divertedVolume_mL, deadLeg_mL, 1e-9, 'it diverts exactly the dead leg');
    assertClose(diverted[k].volume_mL, reported[k].volume_mL - deadLeg_mL, 1e-9,
      'and the collected volume is short by exactly that much');
  }
});

/* ------------------------------------------------------------------------------------------- */
/* §5.6.2 — the REDUCE_FLOW escalation                                                          */
/* ------------------------------------------------------------------------------------------- */

/** Advance a ctx to `t_s` of simulated time at 1000x, tracking the peak dP. */
function runUntil(ctx, t_s) {
  sim.validateAndReady(ctx);
  const started = sim.start(ctx);
  assert.equal(started.ok, true, `the run must start: ${started.reason}`);
  sim.setSpeed(ctx, 1000);
  let maxDP_bar = 0;
  let guard = 0;
  while (ctx.run.t_s < t_s && ctx.run.state === 'RUNNING' && guard++ < 20000) {
    sim.advanceWall(ctx, 0.25);
    if (ctx.run.dP_bar > maxDP_bar) maxDP_bar = ctx.run.dP_bar;
  }
  return maxDP_bar;
}

const alarmRaised = (run, id) =>
  run.events.some((e) => e.type === 'ALARM_RAISED' && e.message.startsWith(id));

test('§5.6.2 — the fouled-column overrides drive dP to 0.84 bar and force REDUCE_FLOW', () => {
  // The mandated `fouled-column-high-dp` scenario: rFrit 0.0011 -> 0.030 bar/(cm/s) at the 500
  // fouling ceiling, worth 0.030*500*0.0416667 = 0.625 bar of hardware dP on top of the 0.215 bar
  // the clean system already makes.
  const ctx = makeCtx(PRESET_PILOT, { column: { rFrit_bar_per_cms: 0.030, foulingFactor: 500 } });
  const maxDP_bar = runUntil(ctx, 90);

  assertClose(maxDP_bar, 0.84, 0.08, 'peak dP with the fouled-column overrides');
  assert.ok(alarmRaised(ctx.run, 'ALM-DP-01'), 'ALM-DP-01 (0.60 bar, WARN) must fire');
  assert.ok(alarmRaised(ctx.run, 'ALM-DP-02'), 'ALM-DP-02 (0.80 bar, REDUCE_FLOW) must fire');
  assert.ok(!alarmRaised(ctx.run, 'ALM-DP-03'), 'ALM-DP-03 (1.00 bar, TRIP) must NOT fire');

  assert.equal(ctx.run.flowReduction.active, true, 'the flow-reduction controller engaged');
  assert.ok(ctx.run.Q_limit_mLs < ctx.config.skid.Qmax_mLs, 'and it lowered the flow limit');
  assert.ok(ctx.run.Q_limit_mLs >= 0.05 * ctx.config.skid.Qmax_mLs,
    'never below the 5 % of Qmax floor');
  assert.equal(ctx.run.state, 'RUNNING', 'the run completes at reduced flow rather than tripping');
  // Having reduced the flow, the ladder must actually be back under control.
  assert.ok(ctx.run.dP_bar < 0.80, `dP settles below the REDUCE_FLOW threshold: ${ctx.run.dP_bar}`);
});

test('§5.6.2 — flow alone crosses the same ladder between 500 and 760 cm/h', () => {
  // 500 cm/h sits above ALM-DP-01 (0.60) but below ALM-DP-02 (0.80): a warning, no reduction.
  const warn = makeCtx(PRESET_PILOT, {
    methodPatches: { B01: { flow: { mode: 'CM_H', value: 500 }, duration: { basis: 'CV', value: 40 } } },
  });
  runUntil(warn, 60);
  assert.ok(alarmRaised(warn.run, 'ALM-DP-01'), '500 cm/h raises the dP warning');
  assert.equal(warn.run.flowReduction.active, false, 'but does not demand a flow reduction');

  // 600 cm/h crosses ALM-DP-02 and the escalation fires from flow alone, with no fouling at all.
  const reduce = makeCtx(PRESET_PILOT, {
    methodPatches: { B01: { flow: { mode: 'CM_H', value: 600 }, duration: { basis: 'CV', value: 40 } } },
  });
  const maxDP_bar = runUntil(reduce, 60);
  assert.ok(maxDP_bar >= 0.80, `600 cm/h must reach the REDUCE_FLOW threshold: ${maxDP_bar} bar`);
  assert.ok(alarmRaised(reduce.run, 'ALM-DP-02'), 'ALM-DP-02 fires from flow alone');
  assert.equal(reduce.run.flowReduction.active, true, 'and the escalation engages');
  assert.ok(!alarmRaised(reduce.run, 'ALM-DP-03'), 'without reaching the trip');
  assert.equal(reduce.run.state, 'RUNNING');
});

test('§6.13 — applyFlowReduction is a 50 %/s squeeze with a 5 % floor and a 30 s recovery delay', () => {
  const { config, run } = makeCtx(PRESET_LAB, {});
  const Qmax = config.skid.Qmax_mLs;
  const dtCtrl = 0.1;
  run.Q_limit_mLs = Qmax;

  fluidics.applyFlowReduction(config, run, dtCtrl, true);
  assertClose(run.Q_limit_mLs, Qmax * (1 - 0.5 * dtCtrl), 1e-12, 'one control tick of squeeze');
  assert.equal(run.flowReduction.active, true);

  for (let k = 0; k < 5000; k++) fluidics.applyFlowReduction(config, run, dtCtrl, true);
  assertClose(run.Q_limit_mLs, 0.05 * Qmax, 1e-12, 'the squeeze floors at 5 % of Qmax');

  // Recovery waits 30 s of clear condition before it starts.
  run.t_s = 1000;
  fluidics.applyFlowReduction(config, run, dtCtrl, false);
  assertClose(run.Q_limit_mLs, 0.05 * Qmax, 1e-12, 'no recovery in the first 30 s');
  run.t_s = 1000 + 29.9;
  fluidics.applyFlowReduction(config, run, dtCtrl, false);
  assertClose(run.Q_limit_mLs, 0.05 * Qmax, 1e-12, 'still none at 29.9 s');
  run.t_s = 1000 + 30.1;
  fluidics.applyFlowReduction(config, run, dtCtrl, false);
  assertClose(run.Q_limit_mLs, 0.05 * Qmax * (1 + 0.05 * dtCtrl), 1e-12, 'then +5 %/s');
});

/* ------------------------------------------------------------------------------------------- */
/* §2.4 — config immutability across a run                                                      */
/* ------------------------------------------------------------------------------------------- */

/** Every typed array reachable from `obj`, with its dotted path. */
function typedArraysOf(obj, path, out, seen) {
  if (obj === null || typeof obj !== 'object' || seen.has(obj)) return out;
  seen.add(obj);
  if (ArrayBuffer.isView(obj)) { out.push([path, obj]); return out; }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) typedArraysOf(obj[i], `${path}[${i}]`, out, seen);
    return out;
  }
  for (const k of Object.keys(obj)) typedArraysOf(obj[k], `${path}.${k}`, out, seen);
  return out;
}

test("§2.3/§2.4 — config's typed arrays are byte-identical after a run", () => {
  // `deepFreeze` deliberately skips ArrayBuffer views (§11 C-16), so nothing but this test stops
  // a module writing through `config.tanks[k].y_mM` or `config.colIdxOf` mid-run.
  const ctx = makeCtx(PRESET_LAB, { column: { nz: 100 } });
  const arrays = typedArraysOf(ctx.config, 'config', [], new Set());
  assert.ok(arrays.length >= 5, `the config really does carry typed arrays: ${arrays.length}`);
  const before = arrays.map(([p, a]) => [p, a, Array.from(a)]);

  sim.validateAndReady(ctx);
  sim.start(ctx);
  sim.setSpeed(ctx, 1000);
  let guard = 0;
  while (ctx.run.t_s < 300 && ctx.run.state === 'RUNNING' && guard++ < 20000) sim.advanceWall(ctx, 0.25);
  sim.skipBlock(ctx);                                   // cross a block boundary (flush + valves)
  sim.skipBlock(ctx);
  guard = 0;
  while (ctx.run.t_s < 700 && ctx.run.state === 'RUNNING' && guard++ < 20000) sim.advanceWall(ctx, 0.25);
  assert.ok(ctx.run.tick > 5000, 'the run really advanced');
  assert.ok(ctx.run.blockIndex >= 2, 'and crossed at least two block boundaries');

  for (const [p, live, snapshot] of before) {
    assert.equal(live.length, snapshot.length, `${p} changed length`);
    for (let i = 0; i < live.length; i++) {
      assert.ok(Object.is(live[i], snapshot[i]),
        `${p}[${i}] was mutated during the run: ${snapshot[i]} -> ${live[i]}`);
    }
  }
});
