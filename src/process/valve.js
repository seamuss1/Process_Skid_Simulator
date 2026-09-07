/**
 * src/process/valve.js — trim characteristics and the head-basis sizing relation.
 *
 * Layer L1: imports `core/util.js` only. No DOM.
 *
 * THE SIZING RELATION. A valve is specified by its Kv: the flow in m3/h of water it passes at
 * 1 bar differential. In the catalogue form,
 *
 *     Q [m3/h] = Kv * sqrt(dp[bar] / SG)
 *
 * but this plant is solved in metres of head, and the conversion is worth doing once here because
 * of what falls out of it. With dp = rho*g*dH*1e-5 and SG = rho/1000,
 *
 *     dp/SG = (rho*g*dH*1e-5) / (rho/1000) = g*dH/100
 *
 * and the density cancels exactly. On a head basis a valve's flow depends only on its Kv and the
 * head across it — which is the whole reason pump people work in metres and not in bar. So
 *
 *     Q [m3/h] = sqrt(g/100) * Kv * sqrt(dH[m]) = 0.313155 * Kv * sqrt(dH[m])
 *
 * That constant is `KV_HEAD` below, and it is the only number in this file with a decimal point
 * that was not chosen by an engineer.
 */

import { clamp, G, ssqrt } from '../core/util.js';

/** sqrt(g/100): the m3/h-per-Kv-per-sqrt(metre) constant derived in the header comment. */
export const KV_HEAD = Math.sqrt(G / 100);

/** Inherent trim characteristics available to a valve. */
export const TRIM = Object.freeze({
  /** Fractional Kv equals fractional travel. */
  LINEAR: 'LINEAR',
  /** Equal-percentage: equal increments of travel give equal PERCENTAGE changes in flow. */
  EQUAL_PCT: 'EQUAL_PCT',
  /** Quick-opening: most of the capacity in the first third of travel. */
  QUICK: 'QUICK',
});

/**
 * Build a frozen valve.
 * @param {object} spec valve data
 * @param {string} spec.tag equipment tag, e.g. 'FCV-101'
 * @param {number} spec.kvMax_m3h rated Kv at full travel
 * @param {string} spec.trim one of {@link TRIM}
 * @param {number} [spec.rangeability=50] Kv ratio between full and minimum controllable travel
 * @param {number} [spec.leakFrac=0.0005] Kv at zero travel as a fraction of rated, the seat leakage
 * @param {number} [spec.strokeTime_s=6] full-travel stroke time, s
 * @returns {object} the frozen valve model
 */
export function createValve(spec) {
  return Object.freeze({
    tag: spec.tag,
    kvMax_m3h: spec.kvMax_m3h,
    trim: spec.trim || TRIM.LINEAR,
    rangeability: spec.rangeability || 50,
    leakFrac: spec.leakFrac === undefined ? 0.0005 : spec.leakFrac,
    strokeTime_s: spec.strokeTime_s === undefined ? 6 : spec.strokeTime_s,
  });
}

/**
 * Inherent characteristic: fraction of rated Kv at a fractional travel.
 *
 * The seat-leakage floor matters more than it looks. A valve that reaches EXACTLY zero Kv makes
 * the header a closed volume with no outlet, and the network's head-flow balance loses its unique
 * solution at that one point. Every real valve leaks, so honouring the leakage class both models
 * the plant better and keeps the solve well-posed everywhere on the travel range.
 *
 * @param {object} valve from {@link createValve}
 * @param {number} x fractional travel, 0..1
 * @returns {number} Kv fraction, leakFrac..1
 */
export function trimFraction(valve, x) {
  const t = clamp(x, 0, 1);
  let f;
  switch (valve.trim) {
    case TRIM.EQUAL_PCT:
      // R^(t-1), normalised so f(0) is 1/R and f(1) is 1.
      f = Math.pow(valve.rangeability, t - 1);
      break;
    case TRIM.QUICK:
      f = Math.sqrt(t);
      break;
    default:
      f = t;
  }
  return Math.max(f * (t > 0 ? 1 : 0), valve.leakFrac);
}

/**
 * Effective Kv at a fractional travel.
 * @param {object} valve the valve
 * @param {number} x fractional travel, 0..1
 * @returns {number} Kv, m3/h at 1 bar
 */
export function kvAt(valve, x) {
  return valve.kvMax_m3h * trimFraction(valve, x);
}

/**
 * Flow through a fixed Kv on a head differential, signed so a reversed differential gives a
 * reversed flow.
 * @param {number} kv effective Kv, m3/h
 * @param {number} dH_m head across the restriction, m
 * @returns {number} flow, m3/h
 */
export function flowThrough(kv, dH_m) {
  return KV_HEAD * kv * ssqrt(dH_m);
}

/**
 * Sensitivity of {@link flowThrough} to the head differential, for the implicit integrator's
 * Jacobian. Floored near zero differential, where the true square-root slope is unbounded.
 * @param {number} kv effective Kv, m3/h
 * @param {number} dH_m head across the restriction, m
 * @returns {number} dQ/d(dH), (m3/h) per m, always positive
 */
export function flowSlope(kv, dH_m) {
  const a = Math.max(Math.abs(dH_m), 1e-4);
  return (KV_HEAD * kv) / (2 * Math.sqrt(a));
}

/**
 * Head lost across a fixed resistance at a flow — the inverse of {@link flowThrough}, used for
 * the suction-side friction that sets NPSH available.
 * @param {number} kv effective Kv, m3/h
 * @param {number} Q_m3h flow, m3/h
 * @returns {number} head loss, m (always positive)
 */
export function headLoss(kv, Q_m3h) {
  if (!(kv > 0)) return 0;
  const v = Q_m3h / (KV_HEAD * kv);
  return v * v;
}

/**
 * Convert a Kv into the quadratic resistance coefficient `K` in `dH = K*Q^2` that the pump branch
 * solve wants. Two spellings of one number; keeping the conversion here means the plant never
 * writes `1/(KV_HEAD*kv)^2` by hand.
 * @param {number} kv effective Kv, m3/h
 * @returns {number} K, m per (m3/h)^2
 */
export function kvToK(kv) {
  if (!(kv > 0)) return Infinity;
  const d = KV_HEAD * kv;
  return 1 / (d * d);
}
