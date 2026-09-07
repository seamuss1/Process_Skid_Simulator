/**
 * src/control/pid.js — one PID controller, in the ISA standard form, with everything a real one
 * has and a textbook one does not.
 *
 * Layer L1: imports `core/util.js` only. No DOM, no plant.
 *
 *     CO = Kc * [ (b*SP - PV) + (1/Ti)*integral(SP - PV) dt + Td * d(c*SP - PV)/dt ]
 *
 * Standard (ISA, "dependent") form: Kc multiplies all three terms, and the reset and rate times
 * are in seconds. This is the form a DCS faceplate shows and the form every published tuning rule
 * is written for, so it is the form the rig teaches.
 *
 * WHAT THE TEXTBOOK LEAVES OUT, AND WHY EACH ONE IS HERE
 *
 * - Setpoint weighting (b, c). The proportional term acts on `b*SP - PV` and the derivative on
 *   `c*SP - PV`. With b = 1, c = 0 — the default — a setpoint step gives a proportional kick but
 *   no derivative spike. Setting c = 1 reproduces the classic derivative kick so it can be seen
 *   once and avoided forever. Lowering b detunes setpoint response without touching disturbance
 *   rejection, which is the single most useful knob on this list and the one least often known.
 *
 * - A filtered derivative. Pure d/dt has infinite gain at infinite frequency, so on a noisy
 *   measurement it amplifies nothing but noise. The derivative is rolled off at Td/N; N = 10 is
 *   the usual choice and is adjustable here because the effect of getting it wrong is worth
 *   seeing on a pressure signal that has real texture in it.
 *
 * - Anti-windup by back-calculation. When the output is limited — by the range, by the rate
 *   limit, or by manual — the integral is unwound toward the value that would have produced the
 *   output that actually left, at a rate set by Tt. Without it, a loop that saturates against a
 *   drive at 100% comes back late and overshoots, and every operator has watched that happen.
 *
 * - Bumpless transfer. In MAN the integral is back-calculated every scan so that the algorithm's
 *   output already equals the operator's. Switching to AUTO therefore moves nothing at all.
 *
 * - Output rate limiting, an error deadband and a setpoint ramp, because the final element here
 *   is a motor with inertia and a starter, and treating it as an ideal actuator flatters tunings
 *   that would hammer it.
 */

import { clamp, lag, slew } from '../core/util.js';

/** Controller modes. */
export const MODE = Object.freeze({
  /** The algorithm owns the output. */
  AUTO: 'AUTO',
  /** The operator owns the output; the algorithm tracks it. */
  MAN: 'MAN',
});

/** Controller action. */
export const ACTION = Object.freeze({
  /** Output rises as the measurement falls below setpoint. Pumps and heaters. */
  REVERSE: 'REVERSE',
  /** Output rises as the measurement rises above setpoint. Coolers and let-down valves. */
  DIRECT: 'DIRECT',
});

/**
 * Default tuning and options. Everything is mutable at run time — this object is the faceplate's
 * data model, not a frozen config, because retuning a live loop is the entire exercise.
 * @param {object} [over] initial overrides
 * @returns {object} a fresh tuning/options record
 */
export function createPidConfig(over) {
  return {
    /** Proportional gain, output percent per engineering unit of error. */
    Kc: 6,
    /** Integral (reset) time, seconds per repeat. Large is weak; Infinity disables integral. */
    Ti: 12,
    /** Derivative (rate) time, seconds. Zero disables derivative. */
    Td: 0,
    /** Derivative filter divisor: the roll-off sits at Td/N. */
    N: 10,
    /** Proportional setpoint weight, 0..1. */
    b: 1,
    /** Derivative setpoint weight, 0..1. Zero is derivative-on-measurement. */
    c: 0,
    /** Back-calculation tracking time, s. `null` follows Ti, which is the usual default. */
    Tt: null,
    /** Controller action, one of {@link ACTION}. */
    action: ACTION.REVERSE,
    /** First-order filter on the measurement inside the controller, s. */
    pvFilter_s: 0,
    /** Error magnitude below which the error is treated as zero, engineering units. */
    deadband: 0,
    /** Setpoint ramp rate, engineering units per second. Zero means step. */
    spRate: 0,
    /** Output low limit, percent. */
    outLo: 0,
    /** Output high limit, percent. */
    outHi: 100,
    /** Output rate limit, percent per second. Zero means unlimited. */
    outRate: 0,
    ...over,
  };
}

/**
 * Allocate the mutable controller state.
 * @param {number} sp0 initial setpoint, engineering units
 * @param {number} co0 initial output, percent
 * @returns {object} controller state
 */
export function createPidState(sp0, co0) {
  return {
    mode: MODE.AUTO,
    /** Operator's setpoint target. `sp` ramps toward this. */
    spTarget: sp0,
    /** Working setpoint, after the ramp. */
    sp: sp0,
    /** Filtered measurement the algorithm actually uses. */
    pvf: 0,
    /** Output, percent. The only thing this module gives the plant. */
    co: co0,
    /** Operator's output when in MAN. */
    coMan: co0,
    /** Integral accumulator, already multiplied by Kc — it is in output percent. */
    integ: co0,
    /** Derivative term, output percent. */
    deriv: 0,
    /** Proportional term, output percent. */
    prop: 0,
    /** Previous derivative input, for the difference. */
    ePrev: 0,
    /** Current error, SP minus PV in engineering units (sign as the operator reads it). */
    err: 0,
    /** True while the output is pinned against a limit. */
    saturated: false,
    /** True while back-calculation is actively unwinding the integral. */
    windupActive: false,
    /** Set on the first step so the derivative does not see a step from zero. */
    primed: false,
  };
}

/**
 * Apply a symmetric deadband.
 * @param {number} e error
 * @param {number} db deadband half-width (zero disables)
 * @returns {number} the error outside the band, or zero inside it
 */
function applyDeadband(e, db) {
  if (!(db > 0)) return e;
  if (e > db) return e - db;
  if (e < -db) return e + db;
  return 0;
}

/**
 * Force the controller's internal state to produce a given output right now, without a bump.
 *
 * Called on a mode change to AUTO, after an autotune, when staging hands the loop a new output,
 * and at reset. The proportional and derivative terms are whatever the current PV says they are,
 * so the integral takes up the remainder — which is exactly what back-calculation does, only
 * instantaneously.
 *
 * @param {object} st controller state (mutated)
 * @param {number} co the output to preserve, percent
 * @returns {void}
 */
export function preload(st, co) {
  st.integ = co - st.prop - st.deriv;
  st.co = co;
  st.coMan = co;
}

/**
 * Switch mode with a bumpless transfer in both directions.
 * @param {object} st controller state (mutated)
 * @param {string} mode one of {@link MODE}
 * @returns {void}
 */
export function setMode(st, mode) {
  if (st.mode === mode) return;
  if (mode === MODE.MAN) {
    st.coMan = st.co;
  } else {
    preload(st, st.co);
  }
  st.mode = mode;
}

/**
 * Advance the controller one scan.
 *
 * @param {object} cfg tuning and options from {@link createPidConfig}
 * @param {object} st controller state (mutated)
 * @param {number} pv the measurement, engineering units
 * @param {number} dt_s scan period, s
 * @returns {number} the output, percent — also written to `st.co`
 */
export function stepPid(cfg, st, pv, dt_s) {
  // --- setpoint ramp and measurement filter ------------------------------------------------
  st.sp = cfg.spRate > 0 ? slew(st.sp, st.spTarget, cfg.spRate, dt_s) : st.spTarget;
  st.pvf = st.primed ? lag(st.pvf, pv, cfg.pvFilter_s, dt_s) : pv;

  const dir = cfg.action === ACTION.DIRECT ? -1 : 1;
  st.err = st.sp - st.pvf;

  // Three distinct "errors", because the three terms are allowed to see different things.
  const eP = applyDeadband(dir * (cfg.b * st.sp - st.pvf), cfg.deadband);
  const eI = applyDeadband(dir * st.err, cfg.deadband);
  const eD = dir * (cfg.c * st.sp - st.pvf);
  if (!st.primed) { st.ePrev = eD; st.primed = true; }

  // --- proportional --------------------------------------------------------------------------
  st.prop = cfg.Kc * eP;

  // --- derivative, rolled off at Td/N ---------------------------------------------------------
  // D(s) = Kc*Td*s / (1 + s*Td/N), by backward difference:
  //   D[k] = (Td/(Td + N*dt))*D[k-1] + (Kc*Td*N/(Td + N*dt))*(e[k] - e[k-1])
  if (cfg.Td > 0) {
    const N = cfg.N > 0 ? cfg.N : 10;
    const den = cfg.Td + N * dt_s;
    st.deriv = (cfg.Td / den) * st.deriv + ((cfg.Kc * cfg.Td * N) / den) * (eD - st.ePrev);
  } else {
    st.deriv = 0;
  }
  st.ePrev = eD;

  // --- assemble, limit, and unwind -------------------------------------------------------------
  let coRaw;
  if (st.mode === MODE.MAN) {
    coRaw = clamp(st.coMan, cfg.outLo, cfg.outHi);
  } else {
    coRaw = st.prop + st.integ + st.deriv;
  }
  const coLim = clamp(coRaw, cfg.outLo, cfg.outHi);
  const coOut = cfg.outRate > 0 ? slew(st.co, coLim, cfg.outRate, dt_s) : coLim;

  st.saturated = coLim !== coRaw || coOut !== coLim;

  if (st.mode === MODE.MAN) {
    // Track exactly: the algorithm's own sum is held equal to what the operator is putting out,
    // so the transfer back to AUTO cannot move the drive.
    st.integ = coOut - st.prop - st.deriv;
    st.windupActive = false;
  } else {
    const Ti = cfg.Ti;
    const integrate = Number.isFinite(Ti) && Ti > 0 ? (cfg.Kc * dt_s * eI) / Ti : 0;
    const Tt = cfg.Tt && cfg.Tt > 0 ? cfg.Tt : (Number.isFinite(Ti) && Ti > 0 ? Ti : 1);
    const back = ((coOut - coRaw) * dt_s) / Tt;
    st.windupActive = Math.abs(coOut - coRaw) > 1e-9;
    st.integ += integrate + back;
    // A hard clamp behind the back-calculation. Tt sets how fast the integral unwinds, but it
    // must not be able to wander outside the output range in the meantime — belt and braces,
    // and it costs one comparison.
    st.integ = clamp(st.integ, cfg.outLo - 100, cfg.outHi + 100);
  }

  st.co = coOut;
  return st.co;
}

/**
 * Reset the controller to a known output and setpoint, discarding all history.
 * @param {object} st controller state (mutated)
 * @param {number} sp setpoint, engineering units
 * @param {number} co output, percent
 * @returns {void}
 */
export function resetPid(st, sp, co) {
  st.spTarget = sp;
  st.sp = sp;
  st.co = co;
  st.coMan = co;
  st.integ = co;
  st.deriv = 0;
  st.prop = 0;
  st.ePrev = 0;
  st.err = 0;
  st.saturated = false;
  st.windupActive = false;
  st.primed = false;
}
