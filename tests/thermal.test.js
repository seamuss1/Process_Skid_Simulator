/**
 * tests/thermal.test.js — the exchanger, the fouling layer, the transport delay and the heated
 * tank.
 *
 * Every number this file checks against is either a published effectiveness relation written out
 * in full, or an analytic solution of the differential equation the module claims to integrate.
 * Nothing is compared against a previous run of the module: a solver checked only against itself
 * is not checked.
 *
 * The transport-delay tests are the ones that matter most. They drive the line with a RAMP,
 * because linear interpolation of a linear function is exact — so plug flow with dead time
 * theta = L*A/Q must reproduce `a*(t - theta)` to floating point, at a flow deliberately chosen so
 * that theta is not a whole number of ticks. A shift-register delay cannot pass that test, and the
 * staircase it would produce instead is exactly the artefact that would make a gain-scheduling
 * lesson teach the wrong thing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRANGEMENT, FOULING_TEMA, INSULATION_K, OUTSIDE_FILM, STEEL_CP_JkgK,
  effectivenessNTU, lmtd_K, capacityRate_WK,
  createExchanger, exchangerUA_WK, exchangerDuty, createExchangerState, stepExchanger,
  createFoulingState, stepFouling, cleanExchanger,
  createTransportLine, createTransportState, stepTransport, deadTime_s,
  insulatedPipeUA_WK,
  createTank, createTankState, stepTank, tankDynamics,
  temperatureLoopModel, loopScaling,
} from '../src/process/thermal.js';
import { near, nearRel } from './helpers.js';

// ---------------------------------------------------------------------------------------------
// Effectiveness-NTU, against the published relations
// ---------------------------------------------------------------------------------------------

/**
 * The published counterflow relation, written out here so the test does not borrow the module's
 * arithmetic.
 * @param {number} N number of transfer units
 * @param {number} Cr capacity-rate ratio
 * @returns {number} effectiveness
 */
const counterflowPublished = (N, Cr) => (Cr === 1
  ? N / (1 + N)
  : (1 - Math.exp(-N * (1 - Cr))) / (1 - Cr * Math.exp(-N * (1 - Cr))));

/**
 * The published parallel-flow relation.
 * @param {number} N number of transfer units
 * @param {number} Cr capacity-rate ratio
 * @returns {number} effectiveness
 */
const parallelPublished = (N, Cr) => (1 - Math.exp(-N * (1 + Cr))) / (1 + Cr);

test('counterflow effectiveness matches the published relation at several capacity ratios', () => {
  for (const Cr of [0.25, 0.5, 0.75]) {
    for (const N of [0.5, 1, 2, 4, 8]) {
      near(effectivenessNTU(ARRANGEMENT.COUNTERFLOW, N, Cr), counterflowPublished(N, Cr), 1e-12,
        `counterflow eps at NTU=${N}, Cr=${Cr}`);
    }
  }
  // The balanced case, where the published expression is 0/0 and its limit is NTU/(1+NTU).
  near(effectivenessNTU(ARRANGEMENT.COUNTERFLOW, 1, 1), 0.5, 1e-12, 'balanced counterflow at NTU=1');
  near(effectivenessNTU(ARRANGEMENT.COUNTERFLOW, 3, 1), 0.75, 1e-12, 'balanced counterflow at NTU=3');
  // ...and approaching it from below must not blow up.
  near(effectivenessNTU(ARRANGEMENT.COUNTERFLOW, 3, 0.999999), 0.75, 1e-5,
    'counterflow just short of balanced');
});

test('parallel-flow effectiveness matches the published relation, and is capped at 1/(1+Cr)', () => {
  for (const Cr of [0.25, 0.5, 1]) {
    for (const N of [0.5, 1, 2, 4]) {
      near(effectivenessNTU(ARRANGEMENT.PARALLEL, N, Cr), parallelPublished(N, Cr), 1e-12,
        `parallel eps at NTU=${N}, Cr=${Cr}`);
    }
  }
  // The whole reason nobody buys a parallel-flow exchanger: infinite surface still cannot get
  // past the point where the two streams reach the same temperature.
  near(effectivenessNTU(ARRANGEMENT.PARALLEL, 500, 1), 0.5, 1e-9, 'parallel flow at Cr=1, NTU->inf');
  near(effectivenessNTU(ARRANGEMENT.PARALLEL, 500, 0.5), 1 / 1.5, 1e-9, 'parallel flow at Cr=0.5');
  near(effectivenessNTU(ARRANGEMENT.COUNTERFLOW, 500, 1), 1, 1e-2, 'counterflow has no such cap');
});

test('counterflow beats parallel flow everywhere, and the two agree as NTU goes to zero', () => {
  for (const Cr of [0.2, 0.6, 1]) {
    for (const N of [0.25, 1, 3, 6]) {
      assert.ok(effectivenessNTU(ARRANGEMENT.COUNTERFLOW, N, Cr)
        > effectivenessNTU(ARRANGEMENT.PARALLEL, N, Cr),
      `counterflow must beat parallel at NTU=${N}, Cr=${Cr}`);
    }
    const tiny = 1e-6;
    near(effectivenessNTU(ARRANGEMENT.COUNTERFLOW, tiny, Cr),
      effectivenessNTU(ARRANGEMENT.PARALLEL, tiny, Cr), 1e-11,
      `arrangement cannot matter with no surface (Cr=${Cr})`);
  }
});

test('every arrangement collapses to 1 - exp(-NTU) when one stream does not change temperature', () => {
  for (const a of Object.values(ARRANGEMENT)) {
    for (const N of [0.5, 2, 5]) {
      near(effectivenessNTU(a, N, 0), 1 - Math.exp(-N), 1e-12,
        `${a} at Cr=0, NTU=${N} — the boiling/condensing limit`);
    }
  }
});

test('the 1-shell 2-tube-pass relation matches its published value and sits below counterflow', () => {
  // Kays & London, one shell pass and any even number of tube passes. Written out longhand.
  const N = 1;
  const Cr = 1;
  const r = Math.sqrt(2);
  const e = Math.exp(-N * r);
  const published = 2 / (1 + Cr + r * ((1 + e) / (1 - e)));
  near(effectivenessNTU(ARRANGEMENT.SHELL_TUBE_1N, N, Cr), published, 1e-12, 'shell-and-tube 1-2');
  nearRel(published, 0.4627, 0.002, 'the chart value a designer would read off');
  assert.ok(effectivenessNTU(ARRANGEMENT.SHELL_TUBE_1N, 2, 0.5)
    < effectivenessNTU(ARRANGEMENT.COUNTERFLOW, 2, 0.5),
  'no multi-pass arrangement can beat pure counterflow');
  assert.ok(effectivenessNTU(ARRANGEMENT.CROSSFLOW_UNMIXED, 2, 0.5)
    < effectivenessNTU(ARRANGEMENT.COUNTERFLOW, 2, 0.5),
  'nor can crossflow');
});

// ---------------------------------------------------------------------------------------------
// LMTD
// ---------------------------------------------------------------------------------------------

test('the log-mean temperature difference is the log mean, with the equal-terminal limit taken', () => {
  near(lmtd_K(50, 20), 30 / Math.log(2.5), 1e-12, 'LMTD of 50 K and 20 K');
  near(lmtd_K(20, 50), 30 / Math.log(2.5), 1e-12, 'LMTD is symmetric in its two ends');
  near(lmtd_K(25, 25), 25, 1e-12, 'equal terminals: the limit is the common value, not 0/0');
  near(lmtd_K(25, 25.00001), 25.000005, 1e-6, 'and it is continuous across the switch');
  assert.ok(Number.isNaN(lmtd_K(10, -5)),
    'a temperature cross describes equipment that cannot exist and must not be reported as a duty');
  assert.ok(Number.isNaN(lmtd_K(10, 0)), 'nor may a zero terminal difference be clamped away');
});

// ---------------------------------------------------------------------------------------------
// The exchanger
// ---------------------------------------------------------------------------------------------

const HX = createExchanger({
  tag: 'HX-101',
  arrangement: ARRANGEMENT.COUNTERFLOW,
  UAdesign_WK: 9000,
  area_m2: 12,
  mHotDesign_kgs: 12.5,
  mColdDesign_kgs: 10,
  resHot: 0.45,
  resWall: 0.10,
  holdupHot_kg: 45,
  holdupCold_kg: 45,
  metalMass_kg: 900,
  metalToHot: 0.5,
});

/** A representative duty: hot process water cooled by a colder utility stream. */
const DUTY = Object.freeze({
  ThotIn_C: 80,
  TcoldIn_C: 20,
  mHot_kgs: 12.5,
  mCold_kgs: 10,
  cpHot_JkgK: 4182,
  cpCold_JkgK: 4182,
  fouling_m2KW: 0,
});

test('the exchanger closes its own energy balance: what one stream loses the other gains', () => {
  const d = exchangerDuty(HX, DUTY);
  assert.ok(d.ok, 'the duty must solve');
  const Ch = DUTY.mHot_kgs * DUTY.cpHot_JkgK;
  const Cc = DUTY.mCold_kgs * DUTY.cpCold_JkgK;
  nearRel(Ch * (DUTY.ThotIn_C - d.ThotOut_C), d.Q_W, 1e-12, 'duty from the hot side');
  nearRel(Cc * (d.TcoldOut_C - DUTY.TcoldIn_C), d.Q_W, 1e-12, 'duty from the cold side');
  assert.ok(d.ThotOut_C > DUTY.TcoldIn_C && d.TcoldOut_C < DUTY.ThotIn_C,
    'neither outlet may cross the opposite inlet, which is what effectiveness <= 1 means');
});

test('effectiveness-NTU and LMTD agree: the counterflow correction factor F comes out at exactly 1', () => {
  // This is the strongest single check in the file. The duty is computed by one method and the
  // mean temperature difference by the other; if they disagree, one of them is wrong.
  const d = exchangerDuty(HX, DUTY);
  near(d.F, 1, 1e-12, 'F for pure counterflow');
  nearRel(d.Q_W, d.UA_WK * d.lmtd_K, 1e-12, 'Q = UA * LMTD');
});

test('parallel flow also gives F = 1, but on its own pair of terminal differences', () => {
  const par = createExchanger({ ...HX, arrangement: ARRANGEMENT.PARALLEL, UAdesign_WK: 9000, area_m2: 12, mHotDesign_kgs: 12.5, mColdDesign_kgs: 10 });
  const d = exchangerDuty(par, DUTY);
  near(d.F, 1, 1e-12, 'F for pure parallel flow');
  const dT1 = DUTY.ThotIn_C - DUTY.TcoldIn_C;
  const dT2 = d.ThotOut_C - d.TcoldOut_C;
  nearRel(d.lmtd_K, lmtd_K(dT1, dT2), 1e-12, 'parallel flow pairs inlet with inlet');
});

test('a shell-and-tube pays a correction factor below 1 — that is what F is for', () => {
  const st = createExchanger({ ...HX, arrangement: ARRANGEMENT.SHELL_TUBE_1N, UAdesign_WK: 9000, area_m2: 12, mHotDesign_kgs: 12.5, mColdDesign_kgs: 10 });
  const d = exchangerDuty(st, DUTY);
  assert.ok(d.F < 1 && d.F > 0.7, `F should be a modest penalty, got ${d.F}`);
  nearRel(d.Q_W, d.F * d.UA_WK * d.lmtd_K, 1e-12, 'Q = F * UA * LMTD is the definition of F');
});

test('UA is exactly the design figure at design flow, and falls with the film exponent off it', () => {
  near(exchangerUA_WK(HX, 12.5, 10, 0), 9000, 1e-9,
    'the three resistance shares must sum back to the design UA or every duty is wrong');
  // Halving the hot flow raises only the HOT film resistance, and by exactly 2^0.8.
  const dR = 1 / exchangerUA_WK(HX, 6.25, 10, 0) - 1 / exchangerUA_WK(HX, 12.5, 10, 0);
  near(dR, (0.45 / 9000) * (Math.pow(2, 0.8) - 1), 1e-15, 'the hot film resistance at half flow');
  assert.ok(exchangerUA_WK(HX, 12.5, 10, 0) > exchangerUA_WK(HX, 12.5, 10, FOULING_TEMA.TOWER_WATER),
    'fouling can only ever reduce UA');
  // The fouling penalty is the resistance divided by the area, added in series.
  near(1 / exchangerUA_WK(HX, 12.5, 10, 0.0006) - 1 / 9000, 0.0006 / 12, 1e-15,
    'fouling resistance is referred to the transfer area');
});

test('a stopped utility pump transfers nothing, and says so without becoming NaN', () => {
  const d = exchangerDuty(HX, { ...DUTY, mCold_kgs: 0 });
  assert.ok(d.ok, 'a stopped stream is an ordinary operating state, not a refusal');
  assert.equal(d.flowing, false, 'and it is flagged');
  near(d.Q_W, 0, 1e-12, 'no flow, no duty');
  near(d.ThotOut_C, DUTY.ThotIn_C, 1e-12, 'the hot stream passes through unchanged');
  assert.ok(Number.isFinite(d.UA_WK), 'UA must stay finite so the caller can still integrate');
});

test('a reversed duty just reverses: the relations do not care which stream is called hot', () => {
  const d = exchangerDuty(HX, { ...DUTY, ThotIn_C: 20, TcoldIn_C: 80 });
  assert.ok(d.Q_W < 0, 'heat flows the other way');
  assert.ok(d.ThotOut_C > 20 && d.TcoldOut_C < 80, 'and the two streams swap roles physically');
});

test('the exchanger lags at the speed of its metal, not of its liquid', () => {
  const st = createExchangerState(20);
  const cpH = DUTY.cpHot_JkgK;
  const Ch = DUTY.mHot_kgs * cpH;
  const tau = (HX.holdupHot_kg * cpH + 0.5 * HX.metalMass_kg * STEEL_CP_JkgK) / Ch;
  const steady = exchangerDuty(HX, DUTY);
  const dt = 0.5;
  const r = stepExchanger(HX, st, DUTY, dt);
  near(r.tauHot_s, tau, 1e-12, 'the hot-side time constant');
  near(r.ThotOut_C, steady.ThotOut_C + (20 - steady.ThotOut_C) * Math.exp(-dt / tau), 1e-12,
    'one step of the exact discrete pole');
  // The metal is the larger share: without it the lag would be holdup/flow alone.
  assert.ok(tau > (HX.holdupHot_kg * cpH) / Ch * 1.5,
    'the metal must dominate, or a shell-and-tube would respond like a plate unit');
  for (let i = 0; i < 4000; i += 1) stepExchanger(HX, st, DUTY, dt);
  near(st.ThotOut_C, steady.ThotOut_C, 1e-9, 'and it settles on the effectiveness-NTU answer');
});

test('halving the process flow does NOT halve the duty — the gain of an exchanger is not linear', () => {
  const full = exchangerDuty(HX, DUTY);
  const half = exchangerDuty(HX, { ...DUTY, mHot_kgs: 6.25 });
  assert.ok(half.Q_W > 0.5 * full.Q_W,
    'at half flow the stream sits in the exchanger twice as long, so it gives up more per kilogram');
  assert.ok(half.ThotOut_C < full.ThotOut_C,
    'and the outlet temperature moves, which is the disturbance a temperature loop has to reject');
});

// ---------------------------------------------------------------------------------------------
// Fouling
// ---------------------------------------------------------------------------------------------

test('fouling grows asymptotically: one time constant reaches 1 - 1/e of the asymptote', () => {
  const st = createFoulingState(0);
  // One call of exactly one fouling time constant. An Euler step of this size would overshoot the
  // asymptote by a factor of e; the exact exponential lands on it.
  stepFouling(HX, st, HX.foulVelocity_ms, HX.foulTau_h * 3600);
  nearRel(st.Rf_m2KW, HX.RfMax_m2KW * (1 - Math.exp(-1)), 1e-12, 'Rf after one tau');
  near(st.hours, HX.foulTau_h, 1e-9, 'and the running-hours clock agrees');
  stepFouling(HX, st, HX.foulVelocity_ms, HX.foulTau_h * 3600 * 40);
  nearRel(st.Rf_m2KW, HX.RfMax_m2KW, 1e-9, 'it approaches the asymptote and stops, it does not run away');
});

test('turndown quadruples the fouling asymptote and quadruples the time constant with it', () => {
  const slow = createFoulingState(0);
  const fast = createFoulingState(0);
  const halfV = HX.foulVelocity_ms / 2;
  const longTime = HX.foulTau_h * 3600 * 200;
  stepFouling(HX, slow, halfV, longTime);
  stepFouling(HX, fast, HX.foulVelocity_ms, longTime);
  nearRel(slow.Rf_m2KW, 4 * HX.RfMax_m2KW, 1e-6,
    'removal is shear-driven and goes as v^2, so half the velocity is four times the asymptote');
  nearRel(fast.Rf_m2KW, HX.RfMax_m2KW, 1e-6, 'at the reference velocity it is the quoted figure');
  // The time constant scales the same way, so 1 - 1/e of the asymptote takes four times as long.
  const early = createFoulingState(0);
  stepFouling(HX, early, halfV, HX.foulTau_h * 4 * 3600);
  nearRel(early.Rf_m2KW, 4 * HX.RfMax_m2KW * (1 - Math.exp(-1)), 1e-12,
    'one time constant at half velocity is four times the hours it is at design velocity');
});

test('the initial fouling rate does not depend on velocity, but the layer is thicker ever after', () => {
  // Asymptote and time constant both go as 1/v^2, so their ratio — the deposition rate — does
  // not move at all. A monitoring programme that watches only the early slope therefore sees
  // nothing wrong with a turned-down exchanger, and is surprised a year later.
  const hour = 3600;
  const slow = createFoulingState(0);
  const fast = createFoulingState(0);
  stepFouling(HX, slow, HX.foulVelocity_ms / 2, hour);
  stepFouling(HX, fast, HX.foulVelocity_ms, hour);
  nearRel(slow.Rf_m2KW, fast.Rf_m2KW, 2e-3, 'the first hour of fouling looks the same either way');
  for (let k = 0; k < 8000; k += 1) {
    stepFouling(HX, slow, HX.foulVelocity_ms / 2, hour);
    stepFouling(HX, fast, HX.foulVelocity_ms, hour);
  }
  assert.ok(slow.Rf_m2KW > 2.5 * fast.Rf_m2KW,
    'but a year in, the turned-down unit is three times as dirty and still climbing');
});

test('cleaning returns the surface to bare metal and the clock to zero', () => {
  const st = createFoulingState(0.0004);
  st.hours = 900;
  cleanExchanger(st);
  near(st.Rf_m2KW, 0, 1e-15, 'no resistance left');
  near(st.hours, 0, 1e-15, 'no hours left');
  near(exchangerUA_WK(HX, 12.5, 10, st.Rf_m2KW), 9000, 1e-9, 'and the design UA is back');
});

// ---------------------------------------------------------------------------------------------
// The transport delay — the reason this module exists
// ---------------------------------------------------------------------------------------------

const LINE = createTransportLine({ tag: 'L-101', length_m: 30, id_mm: 80 });
const LINE_VOL = (Math.PI * 0.08 * 0.08) / 4 * 30;

test('the dead time of a line is exactly L*A/Q', () => {
  near(LINE.volume_m3, LINE_VOL, 1e-15, 'the line volume is length times bore area');
  near(deadTime_s(LINE, 45), (LINE_VOL * 3600) / 45, 1e-12, 'dead time at 45 m3/h');
  near(deadTime_s(LINE, 22.5), 2 * deadTime_s(LINE, 45), 1e-12,
    'halving the flow doubles the dead time — the single fact this module exists to teach');
  assert.equal(deadTime_s(LINE, 0), Infinity, 'at zero flow nothing ever arrives');
  const byVolume = createTransportLine({ tag: 'L-102', volume_m3: 0.5 });
  near(deadTime_s(byVolume, 36), 50, 1e-12, 'a line given by volume behaves the same');
});

test('plug flow reproduces a ramp delayed by exactly L*A/Q, at a flow that is not a whole tick', () => {
  // 41.37 m3/h is chosen so the dead time is 131.22 ticks. A shift-register delay would quantise
  // that to 131 and be a tick and a fifth wrong; interpolating in volume is exact.
  const Q = 41.37;
  const dt = 0.1;
  const rate = 0.4;                       // K/s of inlet ramp
  const theta = (LINE_VOL * 3600) / Q;
  assert.ok(Math.abs(theta / dt - Math.round(theta / dt)) > 0.1,
    'the test flow must give a dead time that is not a whole number of ticks, or it proves nothing');

  const st = createTransportState(LINE, 0);
  let worst = 0;
  for (let k = 1; k <= 4000; k += 1) {
    const t = k * dt;
    const r = stepTransport(LINE, st, {
      Tin_C: rate * t, Q_m3h: Q, rho_kgm3: 998.2, cp_JkgK: 4182, Tamb_C: 20,
    }, dt);
    assert.ok(r.ok, 'the line must step');
    if (t < theta + dt) continue;
    worst = Math.max(worst, Math.abs(r.T_C - rate * (t - theta)));
    near(r.deadTime_s, theta, 1e-9, `measured dead time at t=${t.toFixed(1)} s`);
  }
  near(worst, 0, 1e-9,
    'plug flow of a ramp must come out as the same ramp shifted by exactly one residence time');
});

test('the line holds its initial contents for exactly one residence time, then delivers', () => {
  const Q = 45;
  const dt = 0.2;
  const theta = (LINE_VOL * 3600) / Q;
  const st = createTransportState(LINE, 20);
  let firstMove = Infinity;
  for (let k = 1; k <= 1200; k += 1) {
    const r = stepTransport(LINE, st, {
      Tin_C: 80, Q_m3h: Q, rho_kgm3: 998.2, cp_JkgK: 4182, Tamb_C: 20,
    }, dt);
    if (firstMove === Infinity && r.T_C > 20.0001) firstMove = k * dt;
  }
  near(firstMove, theta, 2 * dt,
    'the step at the inlet must not appear at the outlet before the liquid carrying it does');
  near(st.out_C, 80, 1e-9, 'and once the line has turned over, the outlet is the inlet');
});

test('a flow change re-times the parcels already in the line, it does not rescale the delay', () => {
  const dt = 0.25;
  const st = createTransportState(LINE, 20);
  // Fill at 45 m3/h, then halve the flow and let the line turn over completely at the new rate.
  for (let k = 0; k < 400; k += 1) {
    stepTransport(LINE, st, { Tin_C: 20, Q_m3h: 45, rho_kgm3: 998.2, cp_JkgK: 4182 }, dt);
  }
  let last = null;
  for (let k = 0; k < 400; k += 1) {
    last = stepTransport(LINE, st, { Tin_C: 20, Q_m3h: 22.5, rho_kgm3: 998.2, cp_JkgK: 4182 }, dt);
  }
  near(last.deadTime_s, deadTime_s(LINE, 22.5), 1e-9,
    'once every parcel in the line entered at the new flow, the delay is the new L*A/Q');
});

test('a line whose history cannot reach the parcel now leaving says so rather than lying', () => {
  const shortMemory = createTransportLine({ tag: 'L-103', length_m: 30, id_mm: 80, capacity: 16 });
  const st = createTransportState(shortMemory, 20);
  let r = null;
  for (let k = 0; k < 40; k += 1) {
    r = stepTransport(shortMemory, st, { Tin_C: 80, Q_m3h: 2, rho_kgm3: 998.2, cp_JkgK: 4182 }, 1);
  }
  assert.ok(r.ok, 'starvation is not a failure, it is a stated limitation');
  assert.equal(r.starved, true, 'and it must be stated');
  assert.ok(Number.isFinite(r.T_C), 'the outlet still has to be a number the plant can integrate');
});

test('ambient loss along a line is exp(-UA/(mdot*cp)), which is itself a function of flow', () => {
  const lagged = createTransportLine({ tag: 'L-104', length_m: 30, id_mm: 80, UA_WK: 40 });
  const dt = 0.25;
  const run = (Q) => {
    const st = createTransportState(lagged, 20);
    let r = null;
    for (let k = 0; k < 4000; k += 1) {
      r = stepTransport(lagged, st, {
        Tin_C: 80, Q_m3h: Q, rho_kgm3: 998.2, cp_JkgK: 4182, Tamb_C: 20,
      }, dt);
    }
    return r.T_C;
  };
  const full = run(45);
  const C = (45 / 3600) * 998.2 * 4182;
  near(full, 20 + 60 * Math.exp(-40 / C), 1e-9, 'the classic steady-flow line-loss result');
  const part = run(4.5);
  const Cp = (4.5 / 3600) * 998.2 * 4182;
  near(part, 20 + 60 * Math.exp(-40 / Cp), 1e-9, 'the same relation at a tenth of the flow');
  assert.ok(80 - part > 8 * (80 - full),
    'a tenth of the flow loses far more than ten times the temperature — the second reason a '
    + 'temperature loop misbehaves at turndown');
});

test('a line with no flow cools in place instead of dividing by zero', () => {
  const lagged = createTransportLine({
    tag: 'L-105', length_m: 30, id_mm: 80, UA_WK: 40, metalMass_kg: 180,
  });
  const st = createTransportState(lagged, 80);
  let r = null;
  for (let k = 0; k < 600; k += 1) {
    r = stepTransport(lagged, st, { Tin_C: 80, Q_m3h: 0, rho_kgm3: 998.2, cp_JkgK: 4182, Tamb_C: 20 }, 1);
  }
  assert.equal(r.stagnant, true, 'no flow is a stagnant line');
  assert.ok(r.T_C < 80 && r.T_C > 20, `a standing line cools toward ambient, got ${r.T_C}`);
  assert.ok(Number.isFinite(r.T_C), 'and stays finite');
});

test('a perfectly lagged standing line simply holds its temperature', () => {
  const st = createTransportState(LINE, 65);
  const r = stepTransport(LINE, st, { Tin_C: 20, Q_m3h: 0, rho_kgm3: 998.2, cp_JkgK: 4182 }, 1);
  near(r.T_C, 65, 1e-12, 'with UA = 0 there is nowhere for the heat to go');
});

// ---------------------------------------------------------------------------------------------
// Ambient losses
// ---------------------------------------------------------------------------------------------

test('an insulated pipe UA is the two series resistances, and a bare one is the outside film alone', () => {
  const bare = insulatedPipeUA_WK({ od_mm: 88.9, length_m: 30, insulation_mm: 0, hOut_Wm2K: 10 });
  near(bare, 2 * Math.PI * (0.0889 / 2) * 10 * 30, 1e-9,
    'a bare pipe loses through its outside film only: UA = 2*pi*r*h*L');
  const lagged = insulatedPipeUA_WK({
    od_mm: 88.9, length_m: 30, insulation_mm: 50, k_WmK: INSULATION_K.MINERAL_WOOL, hOut_Wm2K: OUTSIDE_FILM.INDOOR,
  });
  const r1 = 0.04445;
  const r2 = r1 + 0.05;
  const expected = 30 / (Math.log(r2 / r1) / (2 * Math.PI * 0.04) + 1 / (2 * Math.PI * r2 * 10));
  near(lagged, expected, 1e-9, 'the cylindrical conduction plus film resistance');
  assert.ok(lagged < bare / 8, '50 mm of mineral wool is worth better than eight to one');
  assert.ok(insulatedPipeUA_WK({ od_mm: 88.9, length_m: 30, insulation_mm: 100, k_WmK: 0.04 })
    < lagged, 'more insulation, less loss');
});

// ---------------------------------------------------------------------------------------------
// The tank
// ---------------------------------------------------------------------------------------------

const TANK = createTank({
  tag: 'T-101',
  metalMass_kg: 0,
  UAambient_WK: 0,
  heater_kW: 10,
  heaterEff: 1,
  heaterTau_s: 0,
  jacketUA_WK: 0,
});

test('an insulated tank with no throughput is a pure integrator — it ramps, it never settles', () => {
  const st = createTankState(20);
  const u = {
    mass_kg: 1000, cp_JkgK: 4182, mIn_kgs: 0, Tin_C: 20, Tamb_C: 20, heaterCmd: 1,
  };
  const dyn = tankDynamics(TANK, u);
  assert.equal(dyn.a_perS, 0, 'with no flow and no losses there is no path for heat to leave');
  assert.equal(dyn.tau_s, Infinity, 'so there is no time constant');
  assert.equal(dyn.gain_KperW, Infinity, 'and no steady-state gain — the classic non-self-regulating tank');
  assert.equal(dyn.integrating, true, 'which the model has to say out loud, because PI will oscillate on it');

  const dt = 0.5;
  for (let k = 0; k < 1200; k += 1) stepTank(TANK, st, u, dt);
  // The analytic answer: dT/dt = P/(m*cp), integrated for 600 s.
  near(st.T_C, 20 + (10000 * 600) / (1000 * 4182), 1e-9,
    'the ramp rate is the heater duty over the thermal mass, exactly');
});

test('give the tank a throughput and it becomes an ordinary first-order lag, exactly', () => {
  const tank = createTank({ tag: 'T-102', UAambient_WK: 200, heater_kW: 10, heaterTau_s: 0 });
  const st = createTankState(20);
  const u = {
    mass_kg: 1000, cp_JkgK: 4182, mIn_kgs: 5, Tin_C: 20, Tamb_C: 20, heaterCmd: 1,
  };
  const dyn = tankDynamics(tank, u);
  const a = (5 * 4182 + 200) / (1000 * 4182);
  near(dyn.a_perS, a, 1e-15, 'the coefficient of the linear balance');
  near(dyn.tau_s, 1 / a, 1e-9, 'the open-loop time constant');
  near(dyn.gain_KperW, 1 / (5 * 4182 + 200), 1e-15, 'and the steady-state gain, K per watt');
  assert.equal(dyn.integrating, false, 'this one settles');

  const Tss = 20 + 10000 * dyn.gain_KperW;
  const dt = 0.5;
  const n = 400;
  for (let k = 0; k < n; k += 1) stepTank(tank, st, u, dt);
  near(st.T_C, Tss + (20 - Tss) * Math.exp(-a * n * dt), 1e-9,
    'the closed-form solution of dT/dt = b - a*T, to floating point, after 200 s');
  for (let k = 0; k < 20000; k += 1) stepTank(tank, st, u, dt);
  near(st.T_C, Tss, 1e-9, 'and it settles on the steady state the gain predicts');
});

test('the exact exponential step is right at any tick length, where an Euler step would not be', () => {
  const tank = createTank({ tag: 'T-103', UAambient_WK: 0, heater_kW: 20, heaterTau_s: 0 });
  const u = { mass_kg: 500, cp_JkgK: 4182, mIn_kgs: 4, Tin_C: 20, Tamb_C: 20, heaterCmd: 1 };
  const a = (4 * 4182) / (500 * 4182);
  const Tss = 20 + 20000 / (4 * 4182);
  // A 60 s tick is more than four time constants. Euler would give a - 4.8 K overshoot and then
  // ring; the closed form lands on the analytic value.
  const coarse = createTankState(20);
  stepTank(tank, coarse, u, 60);
  near(coarse.T_C, Tss + (20 - Tss) * Math.exp(-a * 60), 1e-9, 'one enormous step');
  assert.ok(coarse.T_C < Tss, 'and it cannot overshoot a steady state it is approaching from below');
});

test('the outflow carries no enthalpy term: a draining tank heats faster, and by the right amount', () => {
  // d(m*T)/dt with the outflow written out cancels to m*dT/dt = mIn*(Tin - T), so a tank that is
  // draining with the heater on follows T = T0 + (P/(cp*k))*ln(m0/m) exactly.
  const tank = createTank({ tag: 'T-104', UAambient_WK: 0, heater_kW: 10, heaterTau_s: 0 });
  const st = createTankState(20);
  const dt = 0.05;
  const drain_kgs = 1;
  let mass = 1000;
  for (let k = 0; k < 12000; k += 1) {
    stepTank(tank, st, {
      mass_kg: mass, cp_JkgK: 4182, mIn_kgs: 0, Tin_C: 20, Tamb_C: 20, heaterCmd: 1,
    }, dt);
    mass -= drain_kgs * dt;
  }
  const analytic = 20 + (10000 / (4182 * drain_kgs)) * Math.log(1000 / mass);
  near(st.T_C, analytic, 1e-3, 'the analytic solution for a tank draining under constant duty');
  assert.ok(st.T_C > 20 + (10000 * 600) / (1000 * 4182),
    'a draining tank must heat faster than a full one, because there is less of it to heat');
});

test('a jacket is a Cr = 0 exchanger: its effective UA saturates at UA one way and at the flow the other', () => {
  const jacketed = createTank({ tag: 'T-105', jacketUA_WK: 4000 });
  const u = (flow) => ({
    mass_kg: 1000, cp_JkgK: 4182, mIn_kgs: 0, Tin_C: 20, jacketFlow_kgs: flow, jacketCp_JkgK: 4182,
  });
  const mid = tankDynamics(jacketed, u(2));
  const Cj = 2 * 4182;
  near(mid.epsJacket, 1 - Math.exp(-4000 / Cj), 1e-12, 'the Cr = 0 effectiveness relation');
  near(mid.UAjacket_WK, mid.epsJacket * Cj, 1e-12, 'and the heat it actually delivers');
  nearRel(tankDynamics(jacketed, u(1000)).UAjacket_WK, 4000, 1e-3,
    'plenty of jacket flow and the jacket UA is the limit');
  const starved = tankDynamics(jacketed, u(0.02));
  nearRel(starved.UAjacket_WK, 0.02 * 4182, 1e-3,
    'barely any jacket flow and the CAPACITY RATE is the limit — more UA would not help');
  near(tankDynamics(jacketed, u(0)).UAjacket_WK, 0, 1e-15, 'a stopped jacket pump delivers nothing');
});

test('the jacket outlet reports what the utility gave up, so the utility side balances too', () => {
  const jacketed = createTank({ tag: 'T-106', jacketUA_WK: 4000, heater_kW: 0 });
  const st = createTankState(20);
  const r = stepTank(jacketed, st, {
    mass_kg: 1000, cp_JkgK: 4182, mIn_kgs: 0, Tin_C: 20, Tamb_C: 20,
    jacketFlow_kgs: 2, jacketCp_JkgK: 4182, jacketIn_C: 90,
  }, 1);
  assert.ok(r.ok, 'the tank must step');
  assert.ok(r.Qjacket_W > 0, 'a hot jacket puts heat in');
  near(r.jacketOut_C, 90 - r.Qjacket_W / (2 * 4182), 1e-12, 'the jacket leaves colder by its duty');
  assert.ok(r.jacketOut_C > 20, 'but it cannot leave colder than the thing it is heating');
});

test('the heater element lags behind its command, so it is not the ideal actuator it looks like', () => {
  const slow = createTank({ tag: 'T-107', heater_kW: 10, heaterTau_s: 30 });
  const st = createTankState(20);
  const u = { mass_kg: 1000, cp_JkgK: 4182, mIn_kgs: 0, Tin_C: 20, Tamb_C: 20, heaterCmd: 1 };
  const r = stepTank(slow, st, u, 30);
  nearRel(r.Qheater_W, 10000 * (1 - Math.exp(-1)), 1e-12, 'one sheath time constant of the demand');
  for (let k = 0; k < 100; k += 1) stepTank(slow, st, u, 30);
  nearRel(st.heater_W, 10000, 1e-9, 'and it does get there');
});

// ---------------------------------------------------------------------------------------------
// What all of it does to the loop
// ---------------------------------------------------------------------------------------------

test('the loop gain and the dead time both go as 1/flow, which is why gain scheduling exists', () => {
  const cond = (Q) => ({ Q_m3h: Q, rho_kgm3: 998.2, cp_JkgK: 4182 });
  const full = temperatureLoopModel(HX, LINE, cond(45));
  const half = temperatureLoopModel(HX, LINE, cond(22.5));
  assert.ok(full.ok && half.ok, 'both operating points must model');
  near(full.K_KperkW, 1000 / ((45 / 3600) * 998.2 * 4182), 1e-12,
    'the gain is one over the capacity rate, from the enthalpy balance');
  nearRel(half.K_KperkW, 2 * full.K_KperkW, 1e-12, 'half the flow, twice the gain');
  nearRel(half.theta_s, 2 * full.theta_s, 1e-12, 'half the flow, twice the dead time');
  nearRel(half.tau_s, 2 * full.tau_s, 1e-12, 'and twice the exchanger lag with it');
  assert.ok(half.ratio > full.ratio - 1e-12,
    'the controllability ratio cannot improve when everything got slower');
});

test('a controller moved to half flow needs a QUARTER of its gain', () => {
  const cond = (Q) => ({ Q_m3h: Q, rho_kgm3: 998.2, cp_JkgK: 4182 });
  const ref = temperatureLoopModel(HX, LINE, cond(45));
  const s = loopScaling(ref, temperatureLoopModel(HX, LINE, cond(22.5)));
  assert.ok(s.ok, 'the scaling must resolve');
  near(s.kcFactor, 0.25, 1e-12,
    'gain and dead time each doubled, and Kc goes as 1/(K*theta): the square of the flow ratio');
  near(s.tiFactor, 2, 1e-12, 'reset has to be slowed in proportion to the dead time');
  const same = loopScaling(ref, temperatureLoopModel(HX, LINE, cond(45)));
  near(same.kcFactor, 1, 1e-12, 'and at the point it was tuned, nothing changes');
  const up = loopScaling(ref, temperatureLoopModel(HX, LINE, cond(90)));
  near(up.kcFactor, 4, 1e-12, 'at double flow the loop will take four times the gain');
});

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

test('every entry point refuses nonsense with a reason instead of throwing or returning NaN', () => {
  assert.equal(exchangerDuty(null, DUTY).ok, false, 'no exchanger');
  assert.equal(exchangerDuty(HX, { ...DUTY, ThotIn_C: NaN }).ok, false, 'a poisoned inlet temperature');
  assert.equal(stepExchanger(HX, createExchangerState(20), DUTY, 0).ok, false, 'a zero step');
  assert.equal(stepTransport(LINE, null, { Tin_C: 20, Q_m3h: 45, rho_kgm3: 998, cp_JkgK: 4182 }, 1).ok,
    false, 'no line state');
  assert.equal(stepTransport(LINE, createTransportState(LINE, 20),
    { Tin_C: NaN, Q_m3h: 45, rho_kgm3: 998, cp_JkgK: 4182 }, 1).ok, false, 'a poisoned inlet');
  assert.equal(stepTank(TANK, createTankState(20), { mass_kg: 0, cp_JkgK: 4182 }, 1).ok, false,
    'an empty tank');
  assert.equal(temperatureLoopModel(HX, LINE, { Q_m3h: 0, rho_kgm3: 998, cp_JkgK: 4182 }).ok, false,
    'there is no loop at zero flow');
  assert.equal(loopScaling(null, null).ok, false, 'no operating points');
  for (const r of [exchangerDuty(null, DUTY), stepTank(TANK, createTankState(20), { mass_kg: 0 }, 1)]) {
    assert.equal(typeof r.reason, 'string', 'a refusal has to say why');
  }
});

test('reverse flow through a transport line is flagged rather than silently modelled', () => {
  const st = createTransportState(LINE, 40);
  const r = stepTransport(LINE, st, { Tin_C: 80, Q_m3h: -20, rho_kgm3: 998.2, cp_JkgK: 4182 }, 1);
  assert.ok(r.ok, 'it still has to return an answer the plant can integrate');
  assert.equal(st.reversed, true, 'but the caller is told the plug-flow model does not cover it');
  near(r.T_C, 40, 1e-12, 'the line is treated as standing still, not as running backwards');
});

test('the capacity-rate bridge converts m3/h into W/K the way the rest of the plant expects', () => {
  near(capacityRate_WK(45, 998.2, 4182), (45 / 3600) * 998.2 * 4182, 1e-9, 'water at 45 m3/h');
  near(capacityRate_WK(-5, 998.2, 4182), 0, 1e-12, 'a reversed flow carries no capacity forward');
});
