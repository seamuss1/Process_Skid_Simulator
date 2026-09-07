/**
 * src/process/valve.js — trim characteristics, the head-basis sizing relation, and the stem
 * friction that makes a real valve behave unlike an ideal one.
 *
 * Layer L1: imports `core/util.js` only. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * THE SIZING RELATION
 *
 * A valve is specified by its Kv: the flow in m3/h of water it passes at 1 bar differential. In
 * the catalogue form,
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
 * ------------------------------------------------------------------------------------------
 */

import { clamp, G, ssqrt, slew } from '../core/util.js';

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
 * @param {number} [spec.stickband=0] stem friction band S, as a fraction of travel
 * @param {number} [spec.slipJump=0] residual offset J once moving, as a fraction of travel
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
    stickband: spec.stickband || 0,
    slipJump: spec.slipJump || 0,
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
 * Head lost across a fixed restriction at a flow — the inverse of {@link flowThrough}.
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
 * Convert a Kv into the quadratic resistance coefficient `K` in `dH = K*Q^2`.
 * @param {number} kv effective Kv, m3/h
 * @returns {number} K, m per (m3/h)^2
 */
export function kvToK(kv) {
  if (!(kv > 0)) return Infinity;
  const d = KV_HEAD * kv;
  return 1 / (d * d);
}

// ---------------------------------------------------------------------------------------------
// Stem friction
// ---------------------------------------------------------------------------------------------

/**
 * Allocate the mutable state of a valve stem.
 * @param {number} x0 initial fractional travel
 * @returns {object} stem state
 */
export function createStem(x0) {
  return {
    /** Actual fractional travel, 0..1. What the process sees. */
    x: x0,
    /** Commanded fractional travel. What the controller asked for. */
    cmd: x0,
    /** True while friction is holding the stem still. */
    stuck: true,
    /** Travel at which it last stuck, for the diagnostic plot. */
    stuckAt: x0,
    /** Set for one tick when the stem broke free and jumped. */
    slipped: false,
  };
}

/**
 * Advance a valve stem one tick, through its friction and its positioner.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A VALVE IS NOT AN ACTUATOR
 *
 * A control valve's stem runs through packing, and packing grips. The behaviour that produces is
 * the single most common cause of a cycling loop in a real plant, and it has a specific,
 * recognisable signature:
 *
 *   DEADBAND    after a reversal, the stem does not move at all until the command has changed by
 *               the stickband S. The controller sees no response, so its integral keeps winding.
 *   SLIP-JUMP   when the actuator force finally exceeds static friction, the stem breaks free and
 *               jumps — past where a proportional response would have put it, because Coulomb
 *               friction is lower than static friction. The controller now sees too much response.
 *   LIMIT CYCLE the two together make a loop with integral action oscillate FOREVER at an
 *               amplitude set by the stiction and a period set by the loop, and no amount of
 *               retuning fixes it. Only maintenance does. Recognising that from a trend, instead
 *               of detuning a perfectly good controller, is a genuinely valuable skill.
 *
 * The model is the classical two-parameter friction one: the stem is held while the position
 * error is inside the stickband S, and once moving it tracks the command with a residual offset
 * J set by the running friction. Setting S to zero gives an ideal valve.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} valve the frozen valve
 * @param {object} st stem state (mutated)
 * @param {number} cmd commanded travel, 0..1
 * @param {number} dt_s tick, s
 * @returns {number} the actual travel after this tick
 */
export function stepStem(valve, st, cmd, dt_s) {
  st.cmd = clamp(cmd, 0, 1);
  st.slipped = false;
  const rate = valve.strokeTime_s > 0 ? 1 / valve.strokeTime_s : 0;

  if (!(valve.stickband > 0)) {
    st.x = clamp(slew(st.x, st.cmd, rate, dt_s), 0, 1);
    st.stuck = Math.abs(st.x - st.cmd) < 1e-9;
    return st.x;
  }

  const err = st.cmd - st.x;
  if (st.stuck) {
    if (Math.abs(err) <= valve.stickband) return st.x;   // friction wins; nothing moves
    st.stuck = false;
    st.slipped = true;
  }

  // Moving. Running friction leaves the stem short of the command by the slip jump, and the
  // positioner can only close the remaining distance at its stroke rate.
  const target = st.cmd - Math.sign(err) * Math.min(valve.slipJump, Math.abs(err));
  st.x = clamp(slew(st.x, target, rate, dt_s), 0, 1);
  if (Math.abs(st.cmd - st.x) <= valve.slipJump + 1e-9) {
    st.stuck = true;
    st.stuckAt = st.x;
  }
  return st.x;
}

/**
 * The installed characteristic of a valve in a given system, sampled over travel.
 *
 * The inherent characteristic is what the trim does on a constant differential. The INSTALLED
 * characteristic is what happens in a real line, where opening the valve raises the flow, which
 * raises the loss everywhere else, which takes the differential away from the valve itself. An
 * equal-percentage valve in a system with high pipe loss ends up behaving nearly linearly — which
 * is exactly why equal-percentage trim is specified for such systems, and why a linear valve in
 * the same place would be uncontrollable at the open end of its travel.
 *
 * @param {object} valve the valve
 * @param {number} totalHead_m the head available across valve plus system at zero flow, m
 * @param {number} kSystem the rest of the system's resistance, m per (m3/h)^2
 * @param {number} n number of samples
 * @returns {{x:Float64Array, Q:Float64Array, authority:number}} travel, flow, and the valve's
 *   authority — its share of the total pressure drop when fully open
 */
export function installedCharacteristic(valve, totalHead_m, kSystem, n) {
  const x = new Float64Array(n);
  const Q = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    x[i] = t;
    const kValve = kvToK(kvAt(valve, t));
    const kTot = kValve + kSystem;
    Q[i] = kTot > 0 && totalHead_m > 0 ? Math.sqrt(totalHead_m / kTot) : 0;
  }
  const kOpen = kvToK(kvAt(valve, 1));
  return { x, Q, authority: kOpen / (kOpen + kSystem) };
}
