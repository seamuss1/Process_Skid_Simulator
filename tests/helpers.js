/**
 * tests/helpers.js — shared fixtures.
 *
 * Nothing here imports the DOM, and nothing here is used by `src/`.
 */

import assert from 'node:assert/strict';
import { createPump } from '../src/process/pump.js';
import { createDrive } from '../src/process/motor.js';
import { createSim, advance } from '../src/core/sim.js';

/** The shipped pump, built from its datasheet points. */
export const PUMP = createPump({
  tag: 'P-TEST',
  H0_m: 95,
  Qbep_m3h: 45,
  Hbep_m: 72,
  a1: 0.06,
  etaBep: 0.78,
  nRated_rpm: 2950,
  motor_kW: 15,
  motorI_A: 28.5,
  npshr0_m: 1.2,
  npshrBep_m: 4.5,
  minFlowFrac: 0.15,
});

/** The shipped drive. */
export const DRIVE_SPEC = createDrive({
  tag: 'VFD-TEST',
  minSpeed_pct: 45,
  maxSpeed_pct: 100,
  accel_s: 10,
  decel_s: 14,
  startDelay_s: 1.5,
  tripCurrent_pct: 118,
  tripDelay_s: 8,
});

/**
 * Assert two numbers agree to an absolute tolerance, with a message that shows both.
 * @param {number} got the value under test
 * @param {number} want the expected value
 * @param {number} tol absolute tolerance
 * @param {string} what a description for the failure message
 * @returns {void}
 */
export function near(got, want, tol, what) {
  assert.ok(Number.isFinite(got), `${what}: got a non-finite ${got}`);
  assert.ok(Math.abs(got - want) <= tol,
    `${what}: expected ${want} +/- ${tol}, got ${got} (off by ${(got - want).toPrecision(3)})`);
}

/**
 * Assert two numbers agree to a relative tolerance.
 * @param {number} got the value under test
 * @param {number} want the expected value
 * @param {number} rel relative tolerance, e.g. 0.02 for two percent
 * @param {string} what a description for the failure message
 * @returns {void}
 */
export function nearRel(got, want, rel, what) {
  const tol = Math.abs(want) * rel;
  near(got, want, tol, `${what} (within ${(rel * 100).toFixed(1)}%)`);
}

/**
 * A first-order-plus-dead-time process, for testing controllers against something whose exact
 * answers are known from theory rather than from the plant.
 *
 *     G(s) = K * exp(-theta*s) / (tau*s + 1)
 *
 * @param {object} spec model parameters
 * @param {number} spec.K process gain, PV units per output percent
 * @param {number} spec.tau time constant, s
 * @param {number} spec.theta dead time, s
 * @param {number} spec.dt step, s
 * @param {number} [spec.y0=0] initial PV
 * @param {number} [spec.u0=0] the output that holds `y0`
 * @returns {{step:(u:number)=>number, y:()=>number}} the process
 */
export function fopdt({ K, tau, theta, dt, y0 = 0, u0 = 0 }) {
  const n = Math.max(1, Math.round(theta / dt));
  const line = new Float64Array(n).fill(u0);
  let i = 0;
  let y = y0;
  const a = Math.exp(-dt / tau);
  return {
    /**
     * Advance one step.
     * @param {number} u the input
     * @returns {number} the new output
     */
    step(u) {
      const delayed = line[i];
      line[i] = u;
      i = (i + 1) % n;
      y = y * a + K * delayed * (1 - a);
      return y;
    },
    /** @returns {number} the current output */
    y() { return y; },
  };
}

/**
 * The exact ultimate gain and period of a FOPDT process, from the frequency at which its phase
 * lag reaches 180 degrees. This is what a relay experiment is trying to estimate.
 * @param {number} K process gain
 * @param {number} tau time constant, s
 * @param {number} theta dead time, s
 * @returns {{Ku:number, Tu:number, wu:number}} the analytic values
 */
export function ultimateFOPDT(K, tau, theta) {
  // Solve theta*w + atan(w*tau) = pi by bisection; the left side is strictly increasing in w.
  let lo = 1e-6;
  let hi = 100;
  for (let k = 0; k < 200; k += 1) {
    const w = 0.5 * (lo + hi);
    if (theta * w + Math.atan(w * tau) < Math.PI) lo = w; else hi = w;
  }
  const wu = 0.5 * (lo + hi);
  return { wu, Tu: (2 * Math.PI) / wu, Ku: Math.sqrt(1 + (wu * tau) ** 2) / K };
}

/**
 * Build a simulation and run it for a while at the fixed tick.
 * @param {number} [seconds=0] simulated seconds to run after construction
 * @param {object} [patch] a config patch
 * @returns {object} the sim context
 */
export function simFor(seconds = 0, patch) {
  const ctx = createSim(patch);
  run(ctx, seconds);
  return ctx;
}

/**
 * Advance a sim by a number of simulated seconds, one physics tick at a time.
 * @param {object} ctx the sim context
 * @param {number} seconds simulated seconds
 * @returns {void}
 */
export function run(ctx, seconds) {
  const n = Math.round(seconds / ctx.config.dt_s);
  for (let i = 0; i < n; i += 1) advance(ctx, ctx.config.dt_s);
}
