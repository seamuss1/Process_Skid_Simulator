/**
 * src/control/pid.js — one PID controller, with everything a real one has and a textbook one
 * does not: three algorithm forms, two implementations, setpoint weighting, a filtered
 * derivative, anti-windup, bumpless transfer and an optional dead-time compensator.
 *
 * Layer L1: imports `core/util.js` only. No DOM, no plant.
 *
 * ------------------------------------------------------------------------------------------
 * THE ALGORITHM IS ISA STANDARD FORM
 *
 *     CO = Kc * [ (b*SP - PV) + (1/Ti)*integral(SP - PV) dt + Td * d(c*SP - PV)/dt ]
 *
 * Kc multiplies all three terms and the reset and rate times are in seconds. This is the form a
 * DCS faceplate shows and the form every published tuning rule is written for.
 *
 * WHY THE OTHER TWO FORMS ARE HERE. They are the single most common source of a tuning that is
 * three times too aggressive. The same three numbers mean different things in each:
 *
 *   STANDARD (ISA, dependent)   Kc*[e + (1/Ti)Int(e) + Td*de/dt]
 *   PARALLEL (independent)      Kp*e + Ki*Int(e) + Kd*de/dt
 *   SERIES   (interacting)      Kc'*(1 + 1/(Ti's))*(1 + Td's)
 *
 * A Ziegler-Nichols PID is derived for the SERIES form — that is what a pneumatic controller in
 * 1942 was. Type those numbers into a standard-form controller and the gain is right but the
 * reset and rate are not, and the loop is livelier than intended. Type them into a parallel-form
 * controller and the reset is wrong by a factor of Kc, which for this rig is a factor of twenty.
 * The conversions are exact and are in {@link convertForm}; the faceplate shows all three at once
 * so the difference is arithmetic rather than folklore.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT THE TEXTBOOK LEAVES OUT
 *
 * - Setpoint weighting (b, c). With b = 1, c = 0 — the default — a setpoint step gives a
 *   proportional kick but no derivative spike. Lowering b detunes setpoint response WITHOUT
 *   touching disturbance rejection, which is the most useful knob on this list and the one least
 *   often known.
 * - A filtered derivative. Pure d/dt has infinite gain at infinite frequency. The derivative is
 *   rolled off at Td/N; N = 10 is usual.
 * - Anti-windup by back-calculation. When the output is limited the integral is unwound toward
 *   the value that would have produced the output that actually left, at a rate set by Tt.
 * - Bumpless transfer, in both directions and for every mode change.
 * - Output rate limiting, an error deadband and a setpoint ramp, because the final element is a
 *   motor with inertia and a starter.
 * - A Smith predictor, for when the dead time is the problem and no amount of tuning will fix it.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, lag, slew } from '../core/util.js';

/** Controller modes. */
export const MODE = Object.freeze({
  /** The algorithm owns the output. */
  AUTO: 'AUTO',
  /** The operator owns the output; the algorithm tracks it. */
  MAN: 'MAN',
  /** An outer loop owns the setpoint. Only meaningful on a secondary controller. */
  CASCADE: 'CASCADE',
});

/** Controller action. */
export const ACTION = Object.freeze({
  /** Output rises as the measurement falls below setpoint. Pumps and heaters. */
  REVERSE: 'REVERSE',
  /** Output rises as the measurement rises above setpoint. Coolers and let-down valves. */
  DIRECT: 'DIRECT',
});

/** The three ways the same three numbers can be interpreted. */
export const FORM = Object.freeze({
  /** ISA standard, dependent gains. What this module computes in. */
  STANDARD: 'STANDARD',
  /** Independent gains: Kp, Ki, Kd. */
  PARALLEL: 'PARALLEL',
  /** Interacting, the classical pneumatic arrangement. What Ziegler-Nichols was derived for. */
  SERIES: 'SERIES',
});

/** Positional or velocity implementation. */
export const ALGO = Object.freeze({
  /** The output is computed from an explicit integral state. */
  POSITION: 'POSITION',
  /** The CHANGE in output is computed; the output is its own integrator. */
  VELOCITY: 'VELOCITY',
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
    /** Which form the operator is READING the numbers in. The algorithm is always STANDARD. */
    form: FORM.STANDARD,
    /** Positional or velocity implementation, one of {@link ALGO}. */
    algorithm: ALGO.POSITION,
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
    /** Dead-time compensator. See {@link stepPid}. */
    smith: { enabled: false, K: 0.05, tau: 3, theta: 1 },
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
    /** Raw measurement as handed in. */
    pvRaw: 0,
    /** Filtered measurement the algorithm actually uses, after any dead-time compensation. */
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
    /** Previous proportional input, for the velocity form. */
    ePropPrev: 0,
    /** Current error, SP minus PV in engineering units. */
    err: 0,
    /** True while the output is pinned against a limit. */
    saturated: false,
    /** True while back-calculation is actively unwinding the integral. */
    windupActive: false,
    /** Set on the first step so the derivative does not see a step from zero. */
    primed: false,
    /** Smith predictor internals: undelayed model output and its delayed copy. */
    smith: { y: 0, delay: null, correction: 0 },
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
 * Switch mode with a bumpless transfer in every direction.
 * @param {object} st controller state (mutated)
 * @param {string} mode one of {@link MODE}
 * @returns {void}
 */
export function setMode(st, mode) {
  if (st.mode === mode) return;
  if (mode === MODE.MAN) st.coMan = st.co; else preload(st, st.co);
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
  st.pvRaw = pv;

  // --- dead-time compensation ------------------------------------------------------------------
  // A Smith predictor runs a model of the process alongside the real one and feeds the controller
  // the measurement PLUS the difference between the model's undelayed and delayed outputs. If the
  // model is right, the controller effectively sees the process without its dead time and can be
  // tuned as if there were none — which for a dead-time-dominant loop is transformative.
  //
  // If the model is WRONG it is worse than useless, because the controller is now acting on a
  // prediction nobody checked. That asymmetry is the whole lesson, and it is why the model
  // parameters are on the panel next to the switch that turns it on.
  let pvEff = pv;
  if (cfg.smith && cfg.smith.enabled) {
    const s = st.smith;
    const n = Math.max(1, Math.round(cfg.smith.theta / dt_s));
    if (!s.delay || s.delay.length !== n) s.delay = new Float64Array(n).fill(s.y);
    s.idx = ((s.idx || 0) + 1) % n;
    s.y = lag(s.y, cfg.smith.K * st.co, cfg.smith.tau, dt_s);
    const delayed = s.delay[s.idx];
    s.delay[s.idx] = s.y;
    s.correction = s.y - delayed;
    pvEff = pv + s.correction;
  } else if (st.smith) {
    st.smith.correction = 0;
  }

  // --- setpoint ramp and measurement filter ------------------------------------------------
  st.sp = cfg.spRate > 0 ? slew(st.sp, st.spTarget, cfg.spRate, dt_s) : st.spTarget;
  st.pvf = st.primed ? lag(st.pvf, pvEff, cfg.pvFilter_s, dt_s) : pvEff;

  const dir = cfg.action === ACTION.DIRECT ? -1 : 1;
  st.err = st.sp - st.pvf;

  // Three distinct "errors", because the three terms are allowed to see different things.
  const eP = applyDeadband(dir * (cfg.b * st.sp - st.pvf), cfg.deadband);
  const eI = applyDeadband(dir * st.err, cfg.deadband);
  const eD = dir * (cfg.c * st.sp - st.pvf);
  if (!st.primed) { st.ePrev = eD; st.ePropPrev = eP; st.primed = true; }

  // --- derivative, rolled off at Td/N -----------------------------------------------------------
  // D(s) = Kc*Td*s / (1 + s*Td/N), by backward difference:
  //   D[k] = (Td/(Td + N*dt))*D[k-1] + (Kc*Td*N/(Td + N*dt))*(e[k] - e[k-1])
  const dPrev = st.deriv;
  if (cfg.Td > 0) {
    const N = cfg.N > 0 ? cfg.N : 10;
    const den = cfg.Td + N * dt_s;
    st.deriv = (cfg.Td / den) * st.deriv + ((cfg.Kc * cfg.Td * N) / den) * (eD - st.ePrev);
  } else {
    st.deriv = 0;
  }
  st.ePrev = eD;

  const propPrev = st.prop;
  st.prop = cfg.Kc * eP;

  const Ti = cfg.Ti;
  const integrating = Number.isFinite(Ti) && Ti > 0;

  // --- assemble ----------------------------------------------------------------------------------
  let coRaw;
  if (st.mode === MODE.MAN) {
    coRaw = clamp(st.coMan, cfg.outLo, cfg.outHi);
  } else if (cfg.algorithm === ALGO.VELOCITY) {
    // The velocity form computes the CHANGE in output and lets the output be its own integrator.
    // Its practical advantage is that there is no separate integral state to wind up: clamping
    // the output IS the anti-windup, and the loop resumes the instant the error reverses.
    const dP = st.prop - propPrev;
    const dI = integrating ? (cfg.Kc * dt_s * eI) / Ti : 0;
    const dD = st.deriv - dPrev;
    coRaw = st.co + dP + dI + dD;
  } else {
    coRaw = st.prop + st.integ + st.deriv;
  }

  const coLim = clamp(coRaw, cfg.outLo, cfg.outHi);
  const coOut = cfg.outRate > 0 ? slew(st.co, coLim, cfg.outRate, dt_s) : coLim;
  st.saturated = coLim !== coRaw || coOut !== coLim;

  // --- unwind ------------------------------------------------------------------------------------
  if (st.mode === MODE.MAN) {
    // Track exactly: the algorithm's own sum is held equal to what the operator is putting out, so
    // the transfer back to AUTO cannot move the drive.
    st.integ = coOut - st.prop - st.deriv;
    st.windupActive = false;
  } else if (cfg.algorithm === ALGO.VELOCITY) {
    // Keep the positional integral in step so the faceplate's I bar and a switch back to the
    // positional algorithm both stay honest.
    st.integ = coOut - st.prop - st.deriv;
    st.windupActive = Math.abs(coOut - coRaw) > 1e-9;
  } else {
    const integrate = integrating ? (cfg.Kc * dt_s * eI) / Ti : 0;
    const Tt = cfg.Tt && cfg.Tt > 0 ? cfg.Tt : (integrating ? Ti : 1);
    const back = ((coOut - coRaw) * dt_s) / Tt;
    st.windupActive = Math.abs(coOut - coRaw) > 1e-9;
    st.integ = clamp(st.integ + integrate + back, cfg.outLo - 100, cfg.outHi + 100);
  }

  st.ePropPrev = eP;
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
  st.ePropPrev = 0;
  st.err = 0;
  st.saturated = false;
  st.windupActive = false;
  st.primed = false;
  st.smith = { y: 0, delay: null, correction: 0, idx: 0 };
}

// ---------------------------------------------------------------------------------------------
// Form conversion
// ---------------------------------------------------------------------------------------------

/**
 * Express a standard-form tuning in another form.
 *
 * The conversions are exact, not approximations:
 *
 *   PARALLEL   Kp = Kc,  Ki = Kc/Ti,  Kd = Kc*Td
 *   SERIES     with f = 0.5*(1 + sqrt(1 - 4*Td/Ti)):
 *              Kc' = Kc*f,  Ti' = Ti*f,  Td' = Td/f
 *
 * A standard-form PID with Ti < 4*Td has COMPLEX zeros and cannot be written in series form at
 * all — the two are not equivalent families. That is reported rather than approximated, because
 * an engineer who has just been handed a series-form number for a controller that cannot express
 * it needs to know that, not a plausible-looking pair of numbers.
 *
 * @param {{Kc:number, Ti:number, Td:number}} std the standard-form tuning
 * @param {string} form the target form, one of {@link FORM}
 * @returns {{ok:boolean, labels:string[], values:number[], units:string[], note?:string}} the
 *   equivalent tuning, ready to display
 */
export function convertForm(std, form) {
  const { Kc, Ti, Td } = std;
  if (form === FORM.PARALLEL) {
    return {
      ok: true,
      labels: ['Kp', 'Ki', 'Kd'],
      values: [Kc, Number.isFinite(Ti) && Ti > 0 ? Kc / Ti : 0, Kc * Td],
      units: ['%/EU', '%/EU·s', '%·s/EU'],
    };
  }
  if (form === FORM.SERIES) {
    if (!(Td > 0)) {
      return { ok: true, labels: ['Kc′', 'Ti′', 'Td′'], values: [Kc, Ti, 0], units: ['%/EU', 's', 's'] };
    }
    const disc = 1 - (4 * Td) / Ti;
    if (disc < 0) {
      return {
        ok: false,
        labels: ['Kc′', 'Ti′', 'Td′'],
        values: [NaN, NaN, NaN],
        units: ['%/EU', 's', 's'],
        note: `Ti = ${Ti.toPrecision(3)} s is less than 4·Td = ${(4 * Td).toPrecision(3)} s, so this `
          + 'standard-form tuning has complex zeros and has no series-form equivalent at all.',
      };
    }
    const f = 0.5 * (1 + Math.sqrt(disc));
    return {
      ok: true,
      labels: ['Kc′', 'Ti′', 'Td′'],
      values: [Kc * f, Ti * f, Td / f],
      units: ['%/EU', 's', 's'],
    };
  }
  return { ok: true, labels: ['Kc', 'Ti', 'Td'], values: [Kc, Ti, Td], units: ['%/EU', 's', 's'] };
}

/**
 * The inverse: read a tuning that was written in some form and give the standard-form equivalent
 * this module can actually run.
 * @param {number[]} values the three numbers as written
 * @param {string} form the form they were written in, one of {@link FORM}
 * @returns {{Kc:number, Ti:number, Td:number}} the standard-form tuning
 */
export function fromForm(values, form) {
  const [a, b, c] = values;
  if (form === FORM.PARALLEL) {
    return { Kc: a, Ti: b > 0 ? a / b : Number.POSITIVE_INFINITY, Td: a > 0 ? c / a : 0 };
  }
  if (form === FORM.SERIES) {
    const f = b > 0 ? 1 + c / b : 1;
    return { Kc: a * f, Ti: b * f, Td: c / f };
  }
  return { Kc: a, Ti: b, Td: c };
}
