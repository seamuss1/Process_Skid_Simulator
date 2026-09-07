/**
 * src/control/autotune.js — relay-feedback identification, the published tuning rules it feeds,
 * and a first-order-plus-dead-time fit for the ones that need a model instead.
 *
 * Layer L1: imports `core/util.js` only. No DOM, no plant.
 *
 * ------------------------------------------------------------------------------------------
 * THE RELAY EXPERIMENT (Astrom & Hagglund, 1984)
 *
 * The classical continuous-cycling test asks you to raise the gain of a live loop until it
 * oscillates, and then to write down the gain and the period. It works, and it is dangerous:
 * "until it oscillates" has no upper bound, and the operator finds out how far past the limit
 * they went by watching what happens.
 *
 * The relay trick replaces the proportional controller with a two-position one — full up when the
 * measurement is below setpoint, full down when it is above. A relay in a feedback loop drives a
 * limit cycle AT THE FREQUENCY WHERE THE PROCESS PHASE LAG REACHES 180 DEGREES, which is exactly
 * the frequency the continuous-cycling test is hunting for. The amplitude of that cycle is set by
 * the relay amplitude the engineer chose, so the experiment is bounded by construction.
 *
 * Describing-function analysis gives the process gain at that frequency as `4d/(pi*a)` for relay
 * amplitude d and measured oscillation amplitude a, so the ultimate gain is its reciprocal:
 *
 *     Ku = 4d / (pi * a)                          and    Tu = the observed period
 *
 * With hysteresis h on the relay — which this implementation uses, because a relay switching on a
 * noisy pressure signal chatters otherwise — the describing function picks up the hysteresis and
 * the estimate becomes
 *
 *     Ku = 4d / (pi * sqrt(a^2 - h^2))
 *
 * which is the form used below. Setting h to zero recovers the textbook expression.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/** Phases of the relay experiment. */
export const TUNE = Object.freeze({
  /** Not running. */
  IDLE: 'IDLE',
  /** Relay engaged, waiting for the first clean half-cycle to discard the entry transient. */
  SETTLING: 'SETTLING',
  /** Collecting periods and amplitudes. */
  CYCLING: 'CYCLING',
  /** Converged; `Ku` and `Tu` are valid. */
  DONE: 'DONE',
  /** Gave up. `message` says why. */
  FAILED: 'FAILED',
});

/**
 * Allocate the autotuner state.
 * @returns {object} autotuner state
 */
export function createAutotuneState() {
  return {
    phase: TUNE.IDLE,
    /** Relay half-amplitude, output percent. */
    d: 12,
    /** Relay hysteresis, engineering units. Must exceed the noise band or the relay chatters. */
    h: 0,
    /** Output the relay swings about, percent. */
    bias: 50,
    /** Setpoint the relay switches about, engineering units. */
    sp: 0,
    /** Current relay position. */
    high: true,
    /** Output the tuner is commanding, percent. */
    co: 50,
    /** Simulated time the experiment started, s. */
    t0_s: 0,
    /** Simulated time of the last upward switch, s. */
    tLastUp_s: 0,
    /** Running extremes within the current half-cycles. */
    curMax: -Infinity,
    curMin: Infinity,
    /** @type {number[]} observed full-cycle periods, s */
    periods: [],
    /** @type {number[]} observed peak values */
    peaks: [],
    /** @type {number[]} observed trough values */
    troughs: [],
    /** Completed cycles. */
    cycles: 0,
    /** Ultimate gain, output percent per engineering unit. Valid in DONE. */
    Ku: 0,
    /** Ultimate period, s. Valid in DONE. */
    Tu: 0,
    /** Peak-to-peak amplitude of the limit cycle, engineering units. */
    amplitude: 0,
    /** Human-readable status. */
    message: 'idle',
  };
}

/**
 * Begin a relay experiment about the current operating point.
 *
 * @param {object} at autotuner state (mutated)
 * @param {object} opts experiment settings
 * @param {number} opts.bias output to swing about, percent — normally the controller's current CO
 * @param {number} opts.sp setpoint to switch about, engineering units
 * @param {number} opts.d relay half-amplitude, output percent
 * @param {number} opts.h relay hysteresis, engineering units
 * @param {number} opts.t_s simulated time now, s
 * @param {number} opts.outLo output low limit, percent
 * @param {number} opts.outHi output high limit, percent
 * @returns {{ok:boolean, reason?:string}} whether the experiment could start
 */
export function startRelay(at, { bias, sp, d, h, t_s, outLo, outHi }) {
  if (!(d > 0)) return { ok: false, reason: 'relay amplitude must be greater than zero' };
  if (bias - d < outLo - 1e-9 || bias + d > outHi + 1e-9) {
    return {
      ok: false,
      reason: `relay would clip: ${(bias - d).toFixed(0)}..${(bias + d).toFixed(0)}% `
        + `is outside the ${outLo}..${outHi}% output range. Move the operating point or reduce d.`,
    };
  }
  at.phase = TUNE.SETTLING;
  at.d = d;
  at.h = Math.max(0, h);
  at.bias = bias;
  at.sp = sp;
  at.high = true;
  at.co = bias + d;
  at.t0_s = t_s;
  at.tLastUp_s = 0;
  at.curMax = -Infinity;
  at.curMin = Infinity;
  at.periods = [];
  at.peaks = [];
  at.troughs = [];
  at.cycles = 0;
  at.Ku = 0;
  at.Tu = 0;
  at.amplitude = 0;
  at.message = 'relay engaged — waiting for the first crossing';
  return { ok: true };
}

/** Give up if the loop has not produced enough cycles in this many seconds. */
const RELAY_TIMEOUT_S = 900;
/** Cycles that must agree before the estimate is accepted. */
const RELAY_CYCLES = 4;

/**
 * Advance the relay experiment one scan.
 *
 * @param {object} at autotuner state (mutated)
 * @param {number} pv the measurement, engineering units
 * @param {number} t_s simulated time, s
 * @param {boolean} reverseActing true when a higher output raises the measurement
 * @returns {number} the output the tuner wants, percent
 */
export function stepAutotune(at, pv, t_s, reverseActing) {
  if (at.phase !== TUNE.SETTLING && at.phase !== TUNE.CYCLING) return at.co;

  if (t_s - at.t0_s > RELAY_TIMEOUT_S) {
    at.phase = TUNE.FAILED;
    at.message = `no sustained cycle after ${RELAY_TIMEOUT_S} s — `
      + 'try a larger relay amplitude, or check that the loop is not saturating';
    return at.bias;
  }

  if (pv > at.curMax) at.curMax = pv;
  if (pv < at.curMin) at.curMin = pv;

  // The relay. Written for a reverse-acting loop (more output, more PV) and inverted for a
  // direct-acting one, so the experiment works on either sense of process.
  const below = pv < at.sp - at.h;
  const above = pv > at.sp + at.h;
  const wantHigh = reverseActing ? (below ? true : (above ? false : at.high))
    : (above ? true : (below ? false : at.high));

  if (wantHigh !== at.high) {
    if (wantHigh) {
      // Upward switch: one full cycle has closed since the previous upward switch.
      if (at.tLastUp_s > 0) {
        const period = t_s - at.tLastUp_s;
        if (at.phase === TUNE.SETTLING) {
          at.phase = TUNE.CYCLING;
          at.message = 'cycling — collecting periods';
        } else {
          at.periods.push(period);
          at.peaks.push(at.curMax);
          at.troughs.push(at.curMin);
          at.cycles += 1;
          at.message = `cycle ${at.cycles} of ${RELAY_CYCLES} — period ${period.toFixed(1)} s`;
          if (at.periods.length > RELAY_CYCLES) {
            at.periods.shift(); at.peaks.shift(); at.troughs.shift();
          }
          if (at.periods.length >= RELAY_CYCLES) finish(at);
        }
      } else {
        at.phase = TUNE.CYCLING;
      }
      at.tLastUp_s = t_s;
      at.curMax = -Infinity;
      at.curMin = Infinity;
    }
    at.high = wantHigh;
  }

  at.co = at.high ? at.bias + at.d : at.bias - at.d;
  return at.co;
}

/**
 * Test the collected cycles for consistency and, if they agree, compute Ku and Tu.
 * @param {object} at autotuner state (mutated)
 * @returns {void}
 */
function finish(at) {
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / Math.max(mean(xs), 1e-9);
  const Tu = mean(at.periods);
  const amp = mean(at.peaks) - mean(at.troughs);

  if (spread(at.periods) > 0.15) {
    at.message = `periods still varying by ${(spread(at.periods) * 100).toFixed(0)}% — continuing`;
    at.periods.shift(); at.peaks.shift(); at.troughs.shift();
    return;
  }
  const a = amp / 2;
  const under = a * a - at.h * at.h;
  if (!(under > 0)) {
    at.phase = TUNE.FAILED;
    at.message = 'oscillation amplitude is inside the relay hysteresis — reduce h or increase d';
    return;
  }
  at.Tu = Tu;
  at.amplitude = amp;
  at.Ku = (4 * at.d) / (Math.PI * Math.sqrt(under));
  at.phase = TUNE.DONE;
  at.message = `Ku ${at.Ku.toFixed(2)} %/EU, Tu ${Tu.toFixed(1)} s `
    + `from ${RELAY_CYCLES} cycles of ${amp.toPrecision(3)} EU peak-to-peak`;
}

/**
 * Abandon a running experiment.
 * @param {object} at autotuner state (mutated)
 * @returns {void}
 */
export function abortAutotune(at) {
  if (at.phase === TUNE.SETTLING || at.phase === TUNE.CYCLING) {
    at.phase = TUNE.IDLE;
    at.message = 'aborted by the operator';
  }
}

/**
 * The published tuning rules, evaluated from an ultimate gain and period.
 *
 * Each entry says what it is FOR, because that is the part that gets lost. Ziegler-Nichols was
 * derived to give quarter-amplitude damping — every overshoot a quarter of the last — which is
 * aggressive, oscillatory, and was chosen in 1942 for load rejection on processes where a little
 * ringing cost nothing. On a pump header with a check valve and a staging sequence it costs a
 * great deal, which is why Tyreus-Luyben is the sane default here and ZN is kept so the
 * difference can be seen rather than asserted.
 *
 * @param {number} Ku ultimate gain, output percent per engineering unit
 * @param {number} Tu ultimate period, s
 * @returns {Array<{id:string,name:string,Kc:number,Ti:number,Td:number,note:string}>} candidates
 */
export function tuningRules(Ku, Tu) {
  if (!(Ku > 0) || !(Tu > 0)) return [];
  return [
    {
      id: 'TL_PI',
      name: 'Tyreus-Luyben PI',
      Kc: Ku / 3.2,
      Ti: 2.2 * Tu,
      Td: 0,
      note: 'Conservative and robust. The right first choice for a pump header: slow reset keeps '
        + 'the loop from fighting the staging sequence.',
    },
    {
      id: 'TL_PID',
      name: 'Tyreus-Luyben PID',
      Kc: Ku / 2.2,
      Ti: 2.2 * Tu,
      Td: Tu / 6.3,
      note: 'As above with rate action. Worth it only when the measurement is clean enough to '
        + 'differentiate.',
    },
    {
      id: 'ZN_PI',
      name: 'Ziegler-Nichols PI',
      Kc: 0.45 * Ku,
      Ti: Tu / 1.2,
      Td: 0,
      note: 'Quarter-amplitude damping. Fast, and it rings. Included as the benchmark everything '
        + 'else is compared against.',
    },
    {
      id: 'ZN_PID',
      name: 'Ziegler-Nichols PID',
      Kc: 0.6 * Ku,
      Ti: Tu / 2,
      Td: Tu / 8,
      note: 'The 1942 classic. Aggressive enough to trip the stage-up threshold on a setpoint '
        + 'change, which is exactly the lesson.',
    },
    {
      id: 'PESSEN',
      name: 'Pessen integral rule',
      Kc: 0.7 * Ku,
      Ti: 0.4 * Tu,
      Td: 0.15 * Tu,
      note: 'Tighter than ZN. For loops where integrated error is what matters and overshoot is '
        + 'cheap.',
    },
    {
      id: 'NO_OS',
      name: 'ZN, no overshoot',
      Kc: 0.2 * Ku,
      Ti: Tu / 2,
      Td: Tu / 3,
      note: 'Heavily detuned. Use when overshoot would lift a relief valve or stage a pump you '
        + 'did not want.',
    },
  ];
}

/**
 * Fit a first-order-plus-dead-time model to an open-loop step response.
 *
 * The two-point method: dead time and time constant follow from the times at which the response
 * has completed 28.3% and 63.2% of its total change, because for a FOPDT process those are
 * exactly theta + tau/3 and theta + tau.
 *
 *     tau = 1.5 * (t63 - t28)              theta = t63 - tau
 *
 * A FOPDT fit is what lambda and IMC tuning need, and it is also the honest way to say how hard a
 * loop is: the ratio theta/tau is the controllability index, and everything above about 1 is a
 * dead-time-dominant process that no amount of gain will fix.
 *
 * @param {ArrayLike<number>} t sample times, s, ascending
 * @param {ArrayLike<number>} y the measurement at each sample
 * @param {number} du the size of the output step that caused it, percent
 * @param {number} n number of valid samples
 * @returns {{ok:boolean, K?:number, tau?:number, theta?:number, reason?:string}} the model,
 *   with process gain K in engineering units per output percent
 */
export function fitFOPDT(t, y, du, n) {
  if (n < 8 || !Number.isFinite(du) || du === 0) {
    return { ok: false, reason: 'not enough samples, or a zero step' };
  }
  const y0 = y[0];
  const yInf = y[n - 1];
  const dy = yInf - y0;
  if (Math.abs(dy) < 1e-9) return { ok: false, reason: 'the measurement did not move' };

  /**
   * Time at which the response first reaches a fraction of its total change, interpolated.
   * @param {number} f fraction, 0..1
   * @returns {number} the time, s, or NaN
   */
  function crossing(f) {
    const target = y0 + dy * f;
    for (let i = 1; i < n; i += 1) {
      const a = y[i - 1];
      const b = y[i];
      if ((a < target && b >= target) || (a > target && b <= target)) {
        const u = (target - a) / (b - a || 1);
        return t[i - 1] + u * (t[i] - t[i - 1]);
      }
    }
    return NaN;
  }

  const t28 = crossing(0.283);
  const t63 = crossing(0.632);
  if (!Number.isFinite(t28) || !Number.isFinite(t63) || t63 <= t28) {
    return { ok: false, reason: 'the response is not first-order enough to fit' };
  }
  const tau = 1.5 * (t63 - t28);
  const theta = Math.max(0, t63 - tau - t[0]);
  return { ok: true, K: dy / du, tau, theta };
}

/**
 * Lambda (IMC) tuning from a FOPDT model.
 *
 * Lambda is the closed-loop time constant you are asking for, and it is the only tuning rule with
 * a knob whose meaning an operator recognises: "settle in about this long". The usual guidance is
 * lambda between one and three times the dead time; below the dead time the request is not
 * physically available and the rule will hand back a gain that oscillates.
 *
 * @param {{K:number, tau:number, theta:number}} model from {@link fitFOPDT}
 * @param {number} lambda_s desired closed-loop time constant, s
 * @returns {{Kc:number, Ti:number, Td:number}} PI tuning in the ISA standard form
 */
export function lambdaTuning(model, lambda_s) {
  const lam = Math.max(lambda_s, 0.1);
  const Kc = model.tau / (model.K * (lam + model.theta));
  return { Kc: clamp(Kc, -1e4, 1e4), Ti: model.tau, Td: 0 };
}
