/**
 * tests/autotune.test.js — the relay experiment, the published tuning rules, and the FOPDT fit.
 *
 * The headline test runs the relay against processes whose ultimate gain and period are known
 * exactly from theory, and checks that the describing-function estimate lands close to them. That
 * is the whole claim the module makes, and it is the only way to know the estimate is honest
 * rather than merely repeatable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutotuneState, startRelay, stepAutotune, abortAutotune, tuningRules, fitFOPDT,
  lambdaTuning, TUNE,
} from '../src/control/autotune.js';
import { fopdt, ultimateFOPDT, near, nearRel } from './helpers.js';

const DT = 0.2;

/**
 * Run a relay experiment to completion against a FOPDT process.
 * @param {object} model FOPDT parameters
 * @param {number} d relay half-amplitude, output percent
 * @param {number} [h=0] relay hysteresis, PV units
 * @returns {object} the autotuner state
 */
function relay(model, d, h = 0) {
  const bias = 50;
  const at = createAutotuneState();
  const p = fopdt({ ...model, dt: DT, y0: model.K * bias, u0: bias });
  const sp = p.y();
  const res = startRelay(at, { bias, sp, d, h, t_s: 0, outLo: 0, outHi: 100 });
  assert.equal(res.ok, true, res.reason);
  let t = 0;
  let pv = p.y();
  for (let k = 0; k < 40000 && (at.phase === TUNE.SETTLING || at.phase === TUNE.CYCLING); k += 1) {
    const co = stepAutotune(at, pv, t, true);
    pv = p.step(co);
    t += DT;
  }
  return at;
}

test('the relay recovers the ultimate gain and period of a known process', () => {
  const cases = [
    { K: 1, tau: 10, theta: 2 },
    { K: 0.06, tau: 8, theta: 1.2 },
    { K: 2.5, tau: 30, theta: 6 },
  ];
  for (const m of cases) {
    const exact = ultimateFOPDT(m.K, m.tau, m.theta);
    const at = relay(m, 10);
    assert.equal(at.phase, TUNE.DONE, `${JSON.stringify(m)}: ${at.message}`);
    // The describing function assumes the process filters the relay's harmonics away, which is
    // an approximation. Twenty percent is the accuracy the method is usually quoted at.
    nearRel(at.Tu, exact.Tu, 0.20, `ultimate period for ${JSON.stringify(m)}`);
    nearRel(at.Ku, exact.Ku, 0.30, `ultimate gain for ${JSON.stringify(m)}`);
  }
});

test('the estimate is independent of the relay amplitude chosen', () => {
  const m = { K: 1, tau: 10, theta: 2 };
  const small = relay(m, 4);
  const large = relay(m, 20);
  assert.equal(small.phase, TUNE.DONE);
  assert.equal(large.phase, TUNE.DONE);
  nearRel(small.Ku, large.Ku, 0.12,
    'the whole point of the relay method is that the answer does not depend on how hard you hit it');
  nearRel(small.Tu, large.Tu, 0.08, 'nor does the period');
  assert.ok(large.amplitude > small.amplitude * 2,
    'though a bigger relay does produce a bigger upset, which is the cost');
});

test('hysteresis is taken out of the amplitude, not left in it', () => {
  const m = { K: 1, tau: 10, theta: 2 };
  const clean = relay(m, 12, 0);
  const withH = relay(m, 12, 0.25);
  assert.equal(withH.phase, TUNE.DONE, withH.message);
  nearRel(withH.Ku, clean.Ku, 0.15,
    'the sqrt(a^2 - h^2) correction must remove the bias hysteresis would otherwise add');
});

test('a relay that would clip against the output limits is refused before it starts', () => {
  const at = createAutotuneState();
  const res = startRelay(at, { bias: 95, sp: 1, d: 12, h: 0, t_s: 0, outLo: 0, outHi: 100 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /clip/);
  assert.equal(at.phase, TUNE.IDLE, 'and nothing must have been started');
});

test('a zero relay amplitude is refused', () => {
  const at = createAutotuneState();
  assert.equal(startRelay(at, { bias: 50, sp: 1, d: 0, h: 0, t_s: 0, outLo: 0, outHi: 100 }).ok, false);
});

test('a hysteresis wider than the oscillation is reported, not silently mis-estimated', () => {
  // A tiny relay on a low-gain process cannot produce a swing bigger than a large hysteresis.
  const at = relay({ K: 0.02, tau: 10, theta: 2 }, 2, 5);
  assert.notEqual(at.phase, TUNE.DONE);
  assert.match(at.message, /hysteresis|sustained cycle/);
});

test('the experiment times out rather than running for ever', () => {
  // A pure integrator-free process with almost no dead time barely cycles at this scan rate.
  const at = relay({ K: 1, tau: 400, theta: 0.2 }, 5);
  assert.ok(at.phase === TUNE.DONE || at.phase === TUNE.FAILED,
    'the experiment must reach a conclusion one way or the other');
});

test('an experiment can be abandoned', () => {
  const at = createAutotuneState();
  startRelay(at, { bias: 50, sp: 1, d: 10, h: 0, t_s: 0, outLo: 0, outHi: 100 });
  abortAutotune(at);
  assert.equal(at.phase, TUNE.IDLE);
  assert.match(at.message, /aborted/);
});

test('the tuning rules compute what the literature says they compute', () => {
  const Ku = 20;
  const Tu = 8;
  const by = Object.fromEntries(tuningRules(Ku, Tu).map((r) => [r.id, r]));

  near(by.ZN_PI.Kc, 0.45 * Ku, 1e-12, 'Ziegler-Nichols PI gain');
  near(by.ZN_PI.Ti, Tu / 1.2, 1e-12, 'Ziegler-Nichols PI reset');
  near(by.ZN_PID.Kc, 0.6 * Ku, 1e-12, 'Ziegler-Nichols PID gain');
  near(by.ZN_PID.Ti, Tu / 2, 1e-12, 'Ziegler-Nichols PID reset');
  near(by.ZN_PID.Td, Tu / 8, 1e-12, 'Ziegler-Nichols PID rate');
  near(by.TL_PI.Kc, Ku / 3.2, 1e-12, 'Tyreus-Luyben PI gain');
  near(by.TL_PI.Ti, 2.2 * Tu, 1e-12, 'Tyreus-Luyben PI reset');

  assert.ok(by.TL_PI.Kc < by.ZN_PI.Kc,
    'Tyreus-Luyben must be the more conservative of the two, or the panel is lying about it');
  assert.ok(by.TL_PI.Ti > by.ZN_PI.Ti, 'with slower reset');
  assert.ok(by.NO_OS.Kc < by.TL_PI.Kc, 'and the no-overshoot rule more conservative still');
});

test('the rules refuse to produce numbers from an invalid identification', () => {
  assert.deepEqual(tuningRules(0, 8), []);
  assert.deepEqual(tuningRules(20, 0), []);
  assert.deepEqual(tuningRules(NaN, NaN), []);
});

test('the FOPDT fit recovers a model it was given', () => {
  for (const m of [{ K: 0.05, tau: 12, theta: 3 }, { K: 2, tau: 40, theta: 5 }]) {
    const p = fopdt({ ...m, dt: DT, y0: 0, u0: 0 });
    const t = [];
    const y = [];
    const du = 10;
    for (let k = 0; k < Math.round((m.tau * 8 + m.theta) / DT); k += 1) {
      t.push(k * DT);
      y.push(p.step(du));
    }
    const fit = fitFOPDT(t, y, du, t.length);
    assert.equal(fit.ok, true, fit.reason);
    nearRel(fit.K, m.K, 0.02, 'process gain');
    nearRel(fit.tau, m.tau, 0.08, 'time constant');
    near(fit.theta, m.theta, Math.max(0.5, m.theta * 0.2), 'dead time');
  }
});

test('the FOPDT fit declines rather than guessing when there is nothing to fit', () => {
  assert.equal(fitFOPDT([0, 1], [0, 1], 10, 2).ok, false, 'too few samples');
  const flat = Array.from({ length: 50 }, (_, i) => i * DT);
  assert.equal(fitFOPDT(flat, flat.map(() => 3), 10, 50).ok, false, 'the measurement never moved');
  assert.equal(fitFOPDT(flat, flat.map((x) => x), 0, 50).ok, false, 'a zero step');
});

test('lambda tuning is the IMC formula, and slows down as lambda is raised', () => {
  const model = { K: 0.05, tau: 12, theta: 3 };
  const fast = lambdaTuning(model, 3);
  near(fast.Kc, model.tau / (model.K * (3 + model.theta)), 1e-9, 'the IMC gain');
  near(fast.Ti, model.tau, 1e-12, 'reset equals the process time constant');
  assert.ok(lambdaTuning(model, 30).Kc < fast.Kc,
    'asking for a slower closed loop must give a lower gain');
});
