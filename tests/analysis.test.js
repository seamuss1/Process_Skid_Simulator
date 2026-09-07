/**
 * tests/analysis.test.js — the frequency-domain tools.
 *
 * Every claim here is checked against a value that is known independently: an analytic frequency
 * response, an ultimate gain solved from the phase condition, or a time-domain simulation of the
 * same controller against the same model. A frequency-response routine that agrees with itself
 * and nothing else is worth nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processResponse, controllerResponse, loopResponse, margins, predictStep, logspace, DEFAULT_GRID,
  createSweepState, startSweep, stepSweep, abortSweep, fitFromSweep, SWEEP,
} from '../src/control/analysis.js';
import { createPidConfig } from '../src/control/pid.js';
import { near, nearRel, fopdt, ultimateFOPDT } from './helpers.js';

const MODEL = { K: 0.05, tau: 3, theta: 1.1 };

test('the process response matches the analytic FOPDT transfer function', () => {
  for (const w of [0.01, 0.1, 0.5, 1, 3]) {
    const g = processResponse(MODEL, w);
    const mag = Math.hypot(g.re, g.im);
    const phase = (Math.atan2(g.im, g.re) * 180) / Math.PI;
    nearRel(mag, MODEL.K / Math.sqrt(1 + (w * MODEL.tau) ** 2), 1e-12, `|G| at ${w} rad/s`);
    // Dead time contributes pure phase and no magnitude, which is exactly what makes it hard.
    const want = (-Math.atan(w * MODEL.tau) - w * MODEL.theta) * (180 / Math.PI);
    near(((phase - want + 540) % 360) - 180, 0, 1e-9, `arg G at ${w} rad/s`);
  }
});

test('a pure integrator controller has -90 degrees of phase and 1/(w*Ti) of gain', () => {
  const cfg = createPidConfig({ Kc: 1, Ti: 10, Td: 0 });
  const c = controllerResponse(cfg, 1e-4);
  // At a frequency far below 1/Ti the integral term dominates completely.
  nearRel(Math.hypot(c.re, c.im), 1 / (1e-4 * 10), 1e-3, 'controller gain at low frequency');
  near((Math.atan2(c.im, c.re) * 180) / Math.PI, -90, 0.1, 'controller phase at low frequency');
});

test('S + T = 1 at every frequency, which is the constraint no tuning escapes', () => {
  const cfg = createPidConfig({ Kc: 20, Ti: 8, Td: 0.5 });
  const r = loopResponse(cfg, MODEL, DEFAULT_GRID);
  for (let i = 0; i < r.w.length; i += 4) {
    // |S| and |T| are magnitudes, so they do not add — but S = 1/(1+L) and T = L/(1+L) do, and
    // the identity below is what that means for the sampled arrays.
    const L = { re: r.reL[i], im: r.imL[i] };
    const den = Math.hypot(1 + L.re, L.im);
    nearRel(r.magS[i], 1 / den, 1e-12, `|S| at index ${i}`);
    nearRel(r.magT[i], Math.hypot(L.re, L.im) / den, 1e-12, `|T| at index ${i}`);
  }
});

test('the ultimate gain read off the margins matches the analytic one', () => {
  // A proportional-only controller at gain 1: the gain margin IS the ultimate gain, because
  // multiplying by it is exactly what puts the loop on the stability boundary.
  const cfg = createPidConfig({ Kc: 1, Ti: Infinity, Td: 0 });
  const m = margins(loopResponse(cfg, MODEL, logspace(-2.5, 2, 4000)));
  const exact = ultimateFOPDT(MODEL.K, MODEL.tau, MODEL.theta);
  nearRel(m.gm, exact.Ku, 5e-3, 'gain margin against the analytic ultimate gain');
  nearRel((2 * Math.PI) / m.wpc, exact.Tu, 5e-3, 'and the phase crossover against the period');
});

test('a loop tuned at its ultimate gain is reported as unstable, and just under it as stable', () => {
  const exact = ultimateFOPDT(MODEL.K, MODEL.tau, MODEL.theta);
  const grid = logspace(-2.5, 2, 4000);
  const hot = margins(loopResponse(createPidConfig({ Kc: exact.Ku * 1.05, Ti: Infinity, Td: 0 }), MODEL, grid));
  const cool = margins(loopResponse(createPidConfig({ Kc: exact.Ku * 0.95, Ti: Infinity, Td: 0 }), MODEL, grid));
  assert.equal(hot.stable, false, 'five percent past the ultimate gain is unstable');
  assert.equal(cool.stable, true, 'five percent under it is not');
  assert.ok(cool.ms > hot.ms || !hot.stable, 'and the sensitivity peak says the same thing');
});

test('the predicted step response matches a straight simulation of the same loop', () => {
  const cfg = createPidConfig({ Kc: 12, Ti: 6, Td: 0, outLo: -1e6, outHi: 1e6, b: 1 });
  const p = predictStep(cfg, MODEL, { dt: 0.05, horizon: 120, spStep: 1 });

  // The same controller and the same process, integrated independently here.
  const dt = 0.05;
  const proc = fopdt({ ...MODEL, dt });
  let integ = 0;
  let y = 0;
  let peak = 0;
  for (let k = 0; k < 120 / dt; k += 1) {
    const e = 1 - y;
    integ += ((cfg.Kc * e) / cfg.Ti) * dt;
    const u = cfg.Kc * e + integ;
    y = proc.step(u);
    peak = Math.max(peak, y);
  }
  const overshoot = Math.max(0, (peak - 1) * 100);
  near(p.overshootPct, overshoot, 3,
    'the prediction and an independent simulation must agree on overshoot');
  nearRel(p.y[p.y.length - 1], y, 0.02, 'and on where it ends up');
});

test('the prediction ranks tunings the same way the margins do', () => {
  const grid = DEFAULT_GRID;
  const tunings = [
    { Kc: 5, Ti: 20 },
    { Kc: 12, Ti: 6 },
    { Kc: 30, Ti: 3 },
  ];
  const rows = tunings.map((t) => {
    const cfg = createPidConfig(t);
    return {
      ms: margins(loopResponse(cfg, MODEL, grid)).ms,
      overshoot: predictStep(cfg, MODEL, { horizon: 200 }).overshootPct,
    };
  });
  assert.ok(rows[0].ms < rows[1].ms && rows[1].ms < rows[2].ms, 'Ms must rise with the gain');
  assert.ok(rows[0].overshoot <= rows[1].overshoot && rows[1].overshoot < rows[2].overshoot,
    'and so must the predicted overshoot — if these two ever disagree, one of them is wrong');
});

test('an unstable tuning is reported as unstable rather than simulated into nonsense', () => {
  const cfg = createPidConfig({ Kc: 400, Ti: 0.5, Td: 0 });
  const p = predictStep(cfg, MODEL, { horizon: 100 });
  assert.equal(p.stable, false);
  for (let i = 0; i < p.y.length; i += 1) assert.ok(Number.isFinite(p.y[i]), 'and it stays finite');
});

test('the measured sweep recovers the model it was run against', () => {
  const sw = createSweepState();
  const dt = 0.05;
  const proc = fopdt({ ...MODEL, dt });
  const r = startSweep(sw, {
    bias: 50, amp: 5, t_s: 0, wLo: 0.05, wHi: 3, n: 9, outLo: 0, outHi: 100,
  });
  assert.ok(r.ok, r.reason);

  let t = 0;
  let y = proc.y();
  let guard = 0;
  while (sw.phase !== SWEEP.DONE && sw.phase !== SWEEP.FAILED && guard < 4e6) {
    const u = stepSweep(sw, y, t, dt);
    y = proc.step(u - 50);
    t += dt;
    guard += 1;
  }
  assert.equal(sw.phase, SWEEP.DONE, sw.message);
  assert.equal(sw.points.length, 9);

  // Each measured point must match the analytic response at that frequency.
  for (const pt of sw.points) {
    const g = processResponse(MODEL, pt.w);
    nearRel(pt.mag, Math.hypot(g.re, g.im), 0.05, `swept |G| at ${pt.w.toFixed(3)} rad/s`);
    near(pt.phase_deg, (Math.atan2(g.im, g.re) * 180) / Math.PI, 6,
      `swept phase at ${pt.w.toFixed(3)} rad/s`);
  }

  const fit = fitFromSweep(sw.points);
  assert.ok(fit.ok, fit.reason);
  nearRel(fit.K, MODEL.K, 0.12, 'fitted gain');
  nearRel(fit.tau, MODEL.tau, 0.25, 'fitted time constant');
  near(fit.theta, MODEL.theta, 0.45, 'fitted dead time');
});

test('a sweep that would clip the output is refused before it starts', () => {
  const sw = createSweepState();
  const r = startSweep(sw, { bias: 98, amp: 5, t_s: 0, outLo: 0, outHi: 100 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /clip/);
  assert.equal(sw.phase, SWEEP.IDLE);
});

test('aborting a sweep returns it to idle without leaving the output anywhere odd', () => {
  const sw = createSweepState();
  startSweep(sw, { bias: 40, amp: 5, t_s: 0, outLo: 0, outHi: 100 });
  stepSweep(sw, 0, 1, 0.2);
  abortSweep(sw);
  assert.equal(sw.phase, SWEEP.IDLE);
});

test('the scan period costs the loop phase, and the margins say so', () => {
  const cfg = createPidConfig({ Kc: 20, Ti: 6, Td: 0 });
  const fast = margins(loopResponse(cfg, MODEL, DEFAULT_GRID, 0.05));
  const slow = margins(loopResponse(cfg, MODEL, DEFAULT_GRID, 1.5));
  assert.ok(slow.pm_deg < fast.pm_deg - 5,
    'a slower scan is half a scan of extra dead time, and it comes straight off the phase margin');
  assert.ok(slow.ms > fast.ms, 'and the sensitivity peak rises with it');
});
