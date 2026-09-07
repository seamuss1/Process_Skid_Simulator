/**
 * tests/diagnostics.test.js — loop performance monitoring.
 *
 * The discriminators are tested against SYNTHETIC waveforms whose answers are known from
 * arithmetic — a sine scores 1.00 on the shape test, a square wave scores 8/pi^2 over its own
 * harmonic sum — and then against the real plant, where a sticking valve and a hot tuning have to
 * be told apart from each other. A detector that works on synthetic data and not on the plant is
 * a maths exercise; one that works on the plant and cannot be checked against arithmetic is a
 * coincidence. Both are needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiagnostics, pushSample, analyse, resetDiagnostics,
  detectOscillation, sinusoidality, harrisIndex, estimateStiction,
} from '../src/control/diagnostics.js';
import * as sim from '../src/core/sim.js';
import { simFor, run, near, nearRel } from './helpers.js';

const DT = 0.2;

/**
 * Build a series from a generator.
 * @param {number} n samples
 * @param {(i:number)=>number} f the generator
 * @returns {Float64Array} the samples
 */
const series = (n, f) => Float64Array.from({ length: n }, (_, i) => f(i));

test('a sine is found at its own period, and a random walk is not found at all', () => {
  const period = 40;
  const x = series(3000, (i) => Math.sin((2 * Math.PI * i * DT) / period));
  const osc = detectOscillation(x, DT);
  assert.equal(osc.oscillating, true);
  nearRel(osc.period_s, period, 0.06, 'detected period');
  assert.ok(osc.strength > 0.8, 'a clean sine must correlate strongly with itself');

  // Pseudo-random, deterministic: a wandering signal is not an oscillation.
  let s = 12345;
  const noise = series(3000, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; });
  assert.equal(detectOscillation(noise, DT).oscillating, false, 'noise is not a cycle');
});

test('the waveform test scores a sine at 1, a triangle near 1, and a square at 8/pi-squared', () => {
  const period = 40;
  const n = 4000;
  const phase = (i) => (2 * Math.PI * i * DT) / period;
  const sine = series(n, (i) => Math.sin(phase(i)));
  const square = series(n, (i) => Math.sign(Math.sin(phase(i))));
  const triangle = series(n, (i) => Math.asin(Math.sin(phase(i))));

  near(sinusoidality(sine, period, DT), 1, 1e-6, 'a sine is all fundamental');
  // A square wave has amplitudes 1/n at the odd harmonics, so the fundamental holds
  // 1 / (1 + 1/9 + 1/25 + 1/49) of the power counted here.
  const squareShare = 1 / (1 + 1 / 9 + 1 / 25 + 1 / 49);
  near(sinusoidality(square, period, DT), squareShare, 0.02, 'a square wave');
  assert.ok(sinusoidality(triangle, period, DT) > 0.97, 'a triangle is nearly all fundamental');
  // And the discriminator threshold has to sit between them, or it separates nothing.
  assert.ok(squareShare < 0.93 && 0.93 < 0.97, 'the 0.93 threshold sits between square and triangle');
});

test('the Harris index is 1 when the error is pure dead-time-limited noise', () => {
  // White noise through a pure delay: nothing a controller does inside the dead time can help,
  // so the minimum-variance benchmark IS the actual variance and the index must be 1.
  let s = 999;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  const e = series(4000, () => rnd());
  const h = harrisIndex(e, 3);
  assert.ok(h.ok);
  assert.ok(h.eta > 0.9, `white noise cannot be improved on: eta was ${h.eta.toFixed(3)}`);
});

test('the Harris index is small when the error is a slow, predictable wander', () => {
  // A slow sine is entirely predictable more than a few samples ahead, so a minimum-variance
  // controller would remove nearly all of it and the index must be near zero.
  const e = series(4000, (i) => Math.sin((2 * Math.PI * i * DT) / 120));
  const h = harrisIndex(e, 3);
  assert.ok(h.ok);
  assert.ok(h.eta < 0.15, `a slow cycle is mostly removable: eta was ${h.eta.toFixed(3)}`);
});

test('the stickband estimator recovers a known deadband from a synthetic cycle', () => {
  // A stiction cycle in its purest form: the measurement sits on one of two levels while the
  // output ramps across a fixed band, then jumps.
  const period = 200;
  const band = 6;
  const n = 5000;
  const u = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const ph = ((i * DT) % period) / period;
    const half = ph < 0.5 ? ph / 0.5 : (ph - 0.5) / 0.5;
    u[i] = ph < 0.5 ? 50 + band * half : 50 + band * (1 - half);
    y[i] = ph < 0.5 ? 1 : -1;
  }
  const e = Float64Array.from(y, (v) => -v);
  const st = estimateStiction(u, y, e, DT, period);
  assert.ok(st.ok, 'the estimator must find the stalls');
  nearRel(st.stickband_pct, band, 0.25, 'and measure the band the output crossed during them');
  assert.ok(st.stallFraction > 0.6, 'a stiction cycle is mostly stationary');
});

test('the rolling window fills, reports, and clears', () => {
  const d = createDiagnostics(500, DT);
  assert.equal(d.n, 0);
  for (let i = 0; i < 700; i += 1) pushSample(d, Math.sin(i / 20), 50, 3.2);
  assert.equal(d.n, 500, 'the window is bounded');
  const r = analyse(d, { deadTime_s: 1, span: 8 });
  assert.ok(r.window_min > 0 && Number.isFinite(r.sd));
  resetDiagnostics(d);
  assert.equal(d.n, 0);
  assert.equal(d.report, null);
});

test('a hot tuning on the real plant is called an oscillation, not a valve fault', () => {
  const ctx = simFor(60);
  sim.setTuning(ctx, { Kc: 150, Ti: 3 });
  run(ctx, 1500);
  const r = ctx.diag.report;
  assert.ok(r, 'the report must exist by now');
  assert.equal(r.oscillating, true, 'a gain well past the ultimate one must cycle');
  assert.ok(r.sinusoidality > 0.93,
    `a linear instability is near-sinusoidal, but scored ${r.sinusoidality.toFixed(3)}`);
  assert.equal(r.verdict, 'oscillating');
});

test('a sticking valve on the real plant is identified as a valve fault, not a tuning one', () => {
  const ctx = simFor(60);
  sim.beginLesson(ctx, 'DIAGNOSE');
  run(ctx, 1500);
  const r = ctx.diag.report;
  assert.ok(r, 'the report must exist by now');
  assert.equal(r.oscillating, true, 'the stiction must produce a limit cycle');
  assert.ok(r.sinusoidality < 0.93,
    `a stiction cycle is distorted, but scored ${r.sinusoidality.toFixed(3)}`);
  assert.equal(r.verdict, 'sticking final element');
  assert.ok(r.stiction.ok, 'and the stickband must be measurable');
  // The lesson sets a 3.5% stickband. Recovering it to within a factor of two, from the trend
  // alone with nobody going outside to look at the valve, is the whole point.
  assert.ok(r.stiction.stickband_pct > 1.7 && r.stiction.stickband_pct < 7,
    `estimated stickband ${r.stiction.stickband_pct.toFixed(2)}% against a true 3.5%`);
});

test('an undisturbed loop is near its limit whatever the tuning, because there is nothing to reject', () => {
  // This is the property people find surprising and it is the correct one. With no disturbance
  // the only thing in the error is measurement noise, which arrives through the dead time and is
  // therefore irreducible. The Harris index says so, for every tuning, and a monitoring package
  // that claimed to rank tunings on quiet data would be inventing information.
  const results = [];
  for (const t of [{ Kc: 30, Ti: 6 }, { Kc: 3, Ti: 90 }]) {
    const c = simFor(60);
    sim.setTuning(c, t);
    run(c, 1400);
    results.push(c.diag.report);
  }
  for (const r of results) {
    assert.ok(r.harris > 0.5,
      `quiet data cannot be improved on, but eta came back ${r.harris.toFixed(2)}`);
    assert.equal(r.verdict, 'near the achievable limit');
  }
});

test('a slow loop under a fast disturbance is called ambiguous rather than blamed on the valve', () => {
  // A repeating load change with a period comparable to the loop's own settling time produces
  // flat stretches of measurement while the output ramps — which is exactly what stiction looks
  // like. The detector must not confidently call this a valve fault, because it is not one and
  // there is no way to tell from this data alone.
  const c = simFor(60);
  sim.setStaging(c, { enabled: false });
  sim.setTuning(c, { Kc: 12, Ti: 20 });
  for (let k = 0; k < 30; k += 1) {
    sim.setDisturbance(c, { demandTarget: k % 2 === 0 ? 0.60 : 0.45 });
    run(c, 50);
  }
  const r = c.diag.report;
  assert.equal(r.oscillating, true, 'it is certainly cycling');
  assert.notEqual(r.verdict, 'sticking final element',
    'but there is no sticking valve here, and the valve is not what to blame');
  assert.equal(r.verdict, 'cycling — cause not yet separable');
  assert.match(r.advice, /MANUAL/, 'and the advice must name the test that would settle it');
});
