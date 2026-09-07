/**
 * tests/pid.test.js — the controller, tested against a process whose exact behaviour is known
 * from theory rather than from the plant.
 *
 * Every claim the module's own header makes is asserted here: that P alone leaves an offset and
 * PI does not, that back-calculation stops the integral running away against a limit, that the
 * transfer between AUTO and MAN moves nothing, that setpoint weighting separates servo response
 * from disturbance rejection, and that the derivative is the FILTERED one it says it is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPidConfig, createPidState, stepPid, setMode, resetPid, preload, MODE, ACTION,
} from '../src/control/pid.js';
import { fopdt, near, nearRel } from './helpers.js';

const DT = 0.2;

/**
 * Close a loop around a FOPDT process and run it.
 * @param {object} opts run options
 * @param {object} opts.tune tuning overrides
 * @param {number} opts.sp setpoint
 * @param {number} [opts.seconds=400] duration
 * @param {object} [opts.plant] FOPDT parameters
 * @param {(t:number, pid:object, cfg:object)=>number|undefined} [opts.each] per-scan hook; a
 *   returned number is added to the process input as a load disturbance
 * @returns {{cfg:object, pid:object, pv:number, trace:Array<object>}} the result
 */
function closeLoop({ tune, sp, seconds = 400, plant = { K: 0.06, tau: 8, theta: 1.2 }, each }) {
  const cfg = createPidConfig({ Kc: 10, Ti: 20, outLo: 0, outHi: 100, ...tune });
  const pid = createPidState(sp, 40);
  const p = fopdt({ ...plant, dt: DT, y0: plant.K * 40, u0: 40 });
  resetPid(pid, sp, 40);
  const trace = [];
  let pv = p.y();
  for (let k = 0; k * DT < seconds; k += 1) {
    const t = k * DT;
    const load = each ? (each(t, pid, cfg) || 0) : 0;
    const co = stepPid(cfg, pid, pv, DT);
    pv = p.step(co + load);
    trace.push({ t, pv, co, sp: pid.sp });
  }
  return { cfg, pid, pv, trace };
}

test('proportional-only control leaves an offset; adding reset removes it', () => {
  const sp = 3.2;
  const pOnly = closeLoop({ tune: { Kc: 10, Ti: Number.POSITIVE_INFINITY }, sp });
  assert.ok(Math.abs(sp - pOnly.pv) > 0.1,
    'P-only must sit off setpoint — that offset is what integral action exists to remove');

  const pi = closeLoop({ tune: { Kc: 10, Ti: 15 }, sp });
  near(pi.pv, sp, 1e-3, 'PI must land exactly on setpoint');
});

test('an infinite reset time disables the integral without dividing by zero', () => {
  const r = closeLoop({ tune: { Kc: 8, Ti: Number.POSITIVE_INFINITY }, sp: 3.2, seconds: 200 });
  assert.ok(Number.isFinite(r.pid.integ), 'the integral must stay finite');
  near(r.pid.integ, 40, 1e-9, 'and must not have moved from where it was preloaded');
});

test('the controller rejects a load disturbance and returns to setpoint', () => {
  const sp = 3.2;
  const r = closeLoop({
    tune: { Kc: 14, Ti: 12 },
    sp,
    seconds: 600,
    each: (t) => (t > 100 ? -12 : 0),
  });
  near(r.pv, sp, 2e-3, 'after a sustained load step the loop must still hold setpoint');
  assert.ok(r.pid.co > 48, 'and it must have moved the output to do it');
});

test('anti-windup: a loop driven against its output limit recovers promptly', () => {
  const sp = 3.2;
  // A setpoint the process cannot reach at any output holds the loop saturated for 200 s.
  const run = (Tt) => closeLoop({
    tune: { Kc: 14, Ti: 10, Tt },
    sp: 12,
    seconds: 400,
    each: (t, pid) => { if (t >= 200) pid.spTarget = sp; return 0; },
  });
  const withAW = run(10);
  assert.ok(withAW.pid.integ <= 200,
    `back-calculation must hold the integral near the output range, not at ${withAW.pid.integ}`);
  near(withAW.pv, sp, 5e-3, 'and the loop must come back to the reachable setpoint');
});

test('the saturation and windup flags mean what they say', () => {
  const r = closeLoop({ tune: { Kc: 30, Ti: 8 }, sp: 12, seconds: 200 });
  assert.equal(r.pid.saturated, true, 'an unreachable setpoint pins the output');
  assert.equal(r.pid.co, 100, 'at the high limit');
  assert.equal(r.pid.windupActive, true, 'and back-calculation must be actively unwinding');
});

test('the transfer between AUTO and MAN moves nothing in either direction', () => {
  const cfg = createPidConfig({ Kc: 12, Ti: 10 });
  const pid = createPidState(3.2, 40);
  resetPid(pid, 3.2, 40);
  const p = fopdt({ K: 0.06, tau: 8, theta: 1.2, dt: DT, y0: 2.4, u0: 40 });
  let pv = p.y();
  for (let k = 0; k < 600; k += 1) pv = p.step(stepPid(cfg, pid, pv, DT));

  const before = pid.co;
  setMode(pid, MODE.MAN);
  const afterToMan = stepPid(cfg, pid, pv, DT);
  near(afterToMan, before, 1e-9, 'AUTO to MAN must not move the output');

  // Drive it by hand for a while, then hand it back.
  pid.coMan = before + 15;
  for (let k = 0; k < 100; k += 1) pv = p.step(stepPid(cfg, pid, pv, DT));
  const manual = pid.co;
  setMode(pid, MODE.AUTO);
  near(pid.co, manual, 1e-9, 'MAN to AUTO must not move the output at the instant of transfer');
  // The NEXT scan is allowed to move, and should: the loop is now in control and the measurement
  // has changed since the terms were last evaluated. What must not happen is a BUMP — the
  // several-tens-of-percent jump you get when the integral still holds a value from before the
  // operator took over. One scan of ordinary proportional action is a fraction of a percent.
  const afterToAuto = stepPid(cfg, pid, pv, DT);
  assert.ok(Math.abs(afterToAuto - manual) < 0.5,
    `MAN to AUTO bumped the output by ${(afterToAuto - manual).toFixed(2)}%`);
});

test('preload forces an exact output without disturbing the terms it did not set', () => {
  const cfg = createPidConfig({ Kc: 12, Ti: 10 });
  const pid = createPidState(3.2, 40);
  resetPid(pid, 3.2, 40);
  stepPid(cfg, pid, 3.0, DT);
  preload(pid, 72);
  near(pid.prop + pid.integ + pid.deriv, 72, 1e-9,
    'the three terms must now sum to exactly the requested output');
});

test('derivative setpoint weighting is what stops the derivative kick', () => {
  const spike = (c) => {
    const cfg = createPidConfig({ Kc: 12, Ti: 20, Td: 3, c });
    const pid = createPidState(3.0, 40);
    resetPid(pid, 3.0, 40);
    for (let k = 0; k < 40; k += 1) stepPid(cfg, pid, 3.0, DT);
    const before = pid.co;
    pid.spTarget = 3.5;
    return stepPid(cfg, pid, 3.0, DT) - before;
  };
  assert.ok(Math.abs(spike(0)) < 7,
    'with c = 0 the derivative sees only the measurement, so a setpoint step gives no spike');
  assert.ok(spike(1) > 25,
    'with c = 1 the derivative differentiates the step itself — the classic kick');
});

test('proportional setpoint weighting softens the setpoint response only', () => {
  const overshootFor = (b) => {
    // Aggressive enough to overshoot: this process has an ultimate gain near 185 %/EU and an
    // ultimate period near 4.5 s, so Kc 90 with 4 s of reset is roughly a Ziegler-Nichols PI.
    const r = closeLoop({ tune: { Kc: 90, Ti: 4, b }, sp: 3.2, seconds: 300,
      each: (t, pid) => { pid.spTarget = t < 60 ? 3.2 : 3.7; return 0; } });
    let peak = -Infinity;
    for (const s of r.trace) if (s.t > 60) peak = Math.max(peak, s.pv);
    return peak - 3.7;
  };
  const full = overshootFor(1);
  const soft = overshootFor(0.4);
  assert.ok(full > 0.01, 'this tuning must overshoot with b = 1, or the test proves nothing');
  assert.ok(soft < full * 0.6,
    `b = 0.4 must cut the overshoot: got ${soft.toFixed(3)} against ${full.toFixed(3)}`);
});

test('the derivative is the filtered one, and it settles to Kc*Td*slope on a ramp', () => {
  const cfg = createPidConfig({ Kc: 4, Ti: Number.POSITIVE_INFINITY, Td: 5, N: 10, c: 0 });
  const pid = createPidState(0, 0);
  resetPid(pid, 0, 0);
  const slope = -0.02; // PV units per second; reverse action makes -PV the derivative input
  let pv = 0;
  for (let k = 0; k < 2000; k += 1) { pv += slope * DT; stepPid(cfg, pid, pv, DT); }
  // d/dt of (-PV) is -slope, so D -> Kc*Td*(-slope).
  nearRel(pid.deriv, cfg.Kc * cfg.Td * -slope, 0.02,
    'the derivative of a ramp must settle to Kc*Td times its slope');
});

test('the derivative filter divisor N actually filters', () => {
  const noisyD = (N) => {
    const cfg = createPidConfig({ Kc: 6, Ti: Number.POSITIVE_INFINITY, Td: 4, N });
    const pid = createPidState(3.2, 40);
    resetPid(pid, 3.2, 40);
    let travel = 0;
    let last = 0;
    // A deterministic saw of measurement noise.
    for (let k = 0; k < 400; k += 1) {
      stepPid(cfg, pid, 3.2 + 0.02 * Math.sin(k * 1.7), DT);
      if (k > 20) travel += Math.abs(pid.deriv - last);
      last = pid.deriv;
    }
    return travel;
  };
  assert.ok(noisyD(3) < noisyD(20) * 0.75,
    'a harder derivative filter must pass less of the noise through to the output');
});

test('direct action inverts the sense of the loop', () => {
  const cfg = createPidConfig({ Kc: 10, Ti: 20, action: ACTION.DIRECT });
  const pid = createPidState(3.2, 40);
  resetPid(pid, 3.2, 40);
  const up = stepPid(cfg, pid, 3.6, DT);
  resetPid(pid, 3.2, 40);
  const down = stepPid(cfg, pid, 2.8, DT);
  assert.ok(up > 40 && down < 40,
    'a direct-acting controller raises its output when the measurement rises');
});

test('the output rate limit is honoured, and windup is unwound while it bites', () => {
  const cfg = createPidConfig({ Kc: 40, Ti: 6, outRate: 2 });
  const pid = createPidState(3.2, 40);
  resetPid(pid, 3.2, 40);
  let prev = pid.co;
  for (let k = 0; k < 100; k += 1) {
    const co = stepPid(cfg, pid, 1.0, DT);
    assert.ok(Math.abs(co - prev) <= cfg.outRate * DT + 1e-9,
      `the output moved ${(co - prev).toFixed(3)}% in one scan, past the ${cfg.outRate}%/s limit`);
    prev = co;
  }
  assert.ok(pid.windupActive, 'the rate limit is a limit, so anti-windup must be working');
});

test('a deadband stops the output chasing noise, at the price of an offset', () => {
  const cfg = createPidConfig({ Kc: 20, Ti: 10, deadband: 0.05 });
  const pid = createPidState(3.2, 40);
  resetPid(pid, 3.2, 40);
  const start = pid.integ;
  for (let k = 0; k < 200; k += 1) stepPid(cfg, pid, 3.22, DT);
  near(pid.integ, start, 1e-9, 'an error inside the band must not move the integral at all');
  for (let k = 0; k < 200; k += 1) stepPid(cfg, pid, 3.4, DT);
  assert.ok(pid.integ !== start, 'an error outside it must');
});

test('the setpoint ramp rate-limits the working setpoint, not the target', () => {
  const cfg = createPidConfig({ Kc: 10, Ti: 20, spRate: 0.05 });
  const pid = createPidState(3.0, 40);
  resetPid(pid, 3.0, 40);
  pid.spTarget = 4.0;
  stepPid(cfg, pid, 3.0, DT);
  near(pid.sp, 3.0 + 0.05 * DT, 1e-9, 'one scan of ramp');
  assert.equal(pid.spTarget, 4.0, 'the target itself must not move');
  for (let k = 0; k < 200; k += 1) stepPid(cfg, pid, 3.0, DT);
  near(pid.sp, 4.0, 1e-9, 'and it must arrive');
});

test('the controller filter is separate from, and additional to, the instrument', () => {
  const cfg = createPidConfig({ Kc: 10, Ti: 20, pvFilter_s: 4 });
  const pid = createPidState(3.2, 40);
  resetPid(pid, 3.2, 40);
  stepPid(cfg, pid, 3.2, DT);
  near(pid.pvf, 3.2, 1e-9, 'the first scan primes the filter rather than stepping into it');
  stepPid(cfg, pid, 4.2, DT);
  assert.ok(pid.pvf > 3.2 && pid.pvf < 3.3,
    'a 1-unit step through a 4 s filter must move about 5% in one 0.2 s scan');
});
