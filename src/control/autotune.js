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

/**
 * SIMC (Skogestad) tuning from a FOPDT model.
 *
 * Skogestad's refinement of IMC, and the rule most worth knowing after Ziegler-Nichols: it is
 * derived rather than fitted, the single tuning constant is the closed-loop time constant, and
 * the recommended `tc = theta` gives about 30 degrees of phase margin on essentially anything.
 * The integral time is capped at four times (tc + theta), which is the part that matters — an
 * uncapped IMC rule sets Ti = tau, and on a lag-dominant process that is a reset so slow the loop
 * never rejects a load at all.
 *
 * @param {{K:number, tau:number, theta:number}} model from {@link fitFOPDT}
 * @param {number} [tc_s] desired closed-loop time constant, s; defaults to the dead time
 * @returns {{Kc:number, Ti:number, Td:number}} PI tuning in the ISA standard form
 */
export function simcTuning(model, tc_s) {
  const tc = Math.max(tc_s === undefined ? model.theta : tc_s, 1e-3);
  const Kc = model.tau / (model.K * (tc + model.theta));
  const Ti = Math.min(model.tau, 4 * (tc + model.theta));
  return { Kc: clamp(Kc, -1e4, 1e4), Ti, Td: 0 };
}

/* ============================================================================================
 * THE OPEN-LOOP STEP TEST
 *
 * The relay experiment identifies the process where it matters most for stability — at the
 * frequency where the phase reaches 180 degrees — and it does it in closed loop, so the plant
 * never runs away. What it does NOT give you is a model. Ku and Tu feed the classical rule table
 * and nothing else; you cannot draw a Bode plot from them, you cannot predict a step response,
 * and you cannot use lambda or SIMC tuning, which are the two rules an engineer would actually
 * reach for on a process with real dead time.
 *
 * The step test gives the model. Put the controller in manual, wait until everything has stopped
 * moving, bump the output once, and watch. The shape of what comes back is the process: how far
 * it moved per percent of output is the gain, how long it took to start moving is the dead time,
 * and how long it took to get 63% of the way there is the time constant.
 *
 * The reason it is not always the right test is written into the state machine below. It needs
 * OPEN LOOP — the controller is not correcting anything for the duration — and it needs the
 * process to be genuinely at rest first, because a drifting starting point turns into a gain
 * error you cannot see afterwards. On a live plant that is a real cost, and it is why the relay
 * test exists. Both are here, and the difference between what they can tell you is the lesson.
 * ============================================================================================ */

/** Phases of the open-loop step test. */
export const STEP = Object.freeze({
  /** Not running. */
  IDLE: 'IDLE',
  /** Output held; waiting for the measurement to stop drifting. */
  SETTLING: 'SETTLING',
  /** Step applied; recording the response. */
  RECORDING: 'RECORDING',
  /** Converged; `model` is valid. */
  DONE: 'DONE',
  /** Gave up. `message` says why. */
  FAILED: 'FAILED',
});

/** How many samples the step test will keep. */
const STEP_CAPACITY = 4000;

/**
 * Allocate the step-test state.
 * @returns {object} step-test state
 */
export function createStepTestState() {
  return {
    phase: STEP.IDLE,
    /** Output before the step, percent. */
    co0: 50,
    /** Output during the step, percent. */
    co: 50,
    /** Size of the step, output percent, signed. */
    du: 10,
    /** Simulated time the phase began, s. */
    tPhase_s: 0,
    /** Sample times, s, relative to the step. */
    t: new Float64Array(STEP_CAPACITY),
    /** The measurement at each sample. */
    y: new Float64Array(STEP_CAPACITY),
    /** Valid sample count. */
    n: 0,
    /** Measurement when the step was applied. */
    y0: 0,
    /** Rolling window used by the settle and steady tests. */
    recent: [],
    /** Seconds the measurement has been steady since it last moved. */
    steady_s: 0,
    /** The fitted model, valid in DONE. */
    model: null,
    /** Human-readable status. */
    message: 'idle',
  };
}

/** How long the measurement must be quiet before the step is applied, s. */
const STEP_SETTLE_S = 20;
/** How long the measurement must be quiet afterwards before the fit is taken, s. */
const STEP_STEADY_S = 25;
/** Give up if the process has not settled before the step within this long, s. */
const STEP_SETTLE_TIMEOUT_S = 240;
/** Give up if the response has not steadied within this long after the step, s. */
const STEP_RECORD_TIMEOUT_S = 900;

/**
 * Begin an open-loop step test from the current operating point.
 *
 * @param {object} sp step-test state (mutated)
 * @param {object} opts test settings
 * @param {number} opts.co the output to hold and then step from, percent
 * @param {number} opts.du the step size, output percent (signed)
 * @param {number} opts.t_s simulated time now, s
 * @param {number} opts.outLo output low limit, percent
 * @param {number} opts.outHi output high limit, percent
 * @returns {{ok:boolean, reason?:string}} whether the test could start
 */
export function startStepTest(sp, { co, du, t_s, outLo, outHi }) {
  if (!Number.isFinite(du) || du === 0) return { ok: false, reason: 'step size must be non-zero' };
  const target = co + du;
  if (target < outLo - 1e-9 || target > outHi + 1e-9) {
    return {
      ok: false,
      reason: `stepping ${du > 0 ? 'to' : 'down to'} ${target.toFixed(0)}% would leave the `
        + `${outLo}..${outHi}% output range. Move the operating point or reverse the step.`,
    };
  }
  sp.phase = STEP.SETTLING;
  sp.co0 = co;
  sp.co = co;
  sp.du = du;
  sp.tPhase_s = t_s;
  sp.n = 0;
  sp.y0 = 0;
  sp.recent = [];
  sp.steady_s = 0;
  sp.model = null;
  sp.message = `holding ${co.toFixed(1)}% — waiting for the process to stop moving`;
  return { ok: true };
}

/**
 * Advance the step test one scan.
 *
 * @param {object} sp step-test state (mutated)
 * @param {number} pv the measurement, engineering units
 * @param {number} t_s simulated time, s
 * @param {number} dt_s scan period, s
 * @param {number} noiseBand the measurement's own noise amplitude, engineering units — the test
 *   calls the process "steady" when it moves less than this over the settle window
 * @returns {number} the output the test wants, percent
 */
export function stepStepTest(sp, pv, t_s, dt_s, noiseBand) {
  if (sp.phase !== STEP.SETTLING && sp.phase !== STEP.RECORDING) return sp.co;

  // Keep a short trailing window and call the process steady when its spread is inside the noise.
  sp.recent.push(pv);
  const windowN = Math.max(4, Math.round(8 / Math.max(dt_s, 1e-3)));
  if (sp.recent.length > windowN) sp.recent.shift();
  const lo = Math.min(...sp.recent);
  const hi = Math.max(...sp.recent);
  const quiet = sp.recent.length >= windowN && hi - lo <= Math.max(noiseBand * 2.5, 1e-9);
  sp.steady_s = quiet ? sp.steady_s + dt_s : 0;

  if (sp.phase === STEP.SETTLING) {
    if (sp.steady_s >= STEP_SETTLE_S) {
      sp.phase = STEP.RECORDING;
      sp.tPhase_s = t_s;
      sp.y0 = pv;
      sp.co = sp.co0 + sp.du;
      sp.n = 0;
      sp.steady_s = 0;
      sp.recent = [];
      sp.t[sp.n] = 0;
      sp.y[sp.n] = pv;
      sp.n += 1;
      sp.message = `stepped ${sp.du > 0 ? '+' : ''}${sp.du.toFixed(1)}% — recording`;
    } else if (t_s - sp.tPhase_s > STEP_SETTLE_TIMEOUT_S) {
      sp.phase = STEP.FAILED;
      sp.message = `the process never settled — it is still moving by more than the noise band `
        + 'after four minutes. Something else is disturbing it; find that first.';
    } else {
      sp.message = `holding ${sp.co0.toFixed(1)}% — steady for ${sp.steady_s.toFixed(0)} of `
        + `${STEP_SETTLE_S} s`;
    }
    return sp.co;
  }

  // RECORDING
  if (sp.n < STEP_CAPACITY) {
    sp.t[sp.n] = t_s - sp.tPhase_s;
    sp.y[sp.n] = pv;
    sp.n += 1;
  }
  const moved = Math.abs(pv - sp.y0);
  if (sp.steady_s >= STEP_STEADY_S && moved > Math.max(noiseBand * 4, 1e-9)) {
    finishStepTest(sp);
  } else if (t_s - sp.tPhase_s > STEP_RECORD_TIMEOUT_S || sp.n >= STEP_CAPACITY) {
    if (moved > Math.max(noiseBand * 4, 1e-9)) finishStepTest(sp);
    else {
      sp.phase = STEP.FAILED;
      sp.message = 'the measurement barely moved — the step was too small to see through the '
        + 'noise, or the final element is not passing it.';
    }
  } else {
    sp.message = `recording — ${(t_s - sp.tPhase_s).toFixed(0)} s, moved `
      + `${(pv - sp.y0).toPrecision(3)} EU`;
  }
  return sp.co;
}

/**
 * Fit the recorded response and finish.
 * @param {object} sp step-test state (mutated)
 * @returns {void}
 */
function finishStepTest(sp) {
  const fit = fitFOPDT(sp.t, sp.y, sp.du, sp.n);
  if (!fit.ok) {
    sp.phase = STEP.FAILED;
    sp.message = fit.reason;
    return;
  }
  sp.model = { K: fit.K, tau: fit.tau, theta: fit.theta };
  sp.phase = STEP.DONE;
  const ratio = fit.theta / Math.max(fit.tau, 1e-9);
  const difficulty = ratio < 0.15 ? 'easy — lag-dominant, this loop will take a lot of gain'
    : ratio < 0.6 ? 'ordinary — a normal balance of dead time to lag'
      : ratio < 1.2 ? 'difficult — dead time is a large share of the response'
        : 'dead-time dominant — no amount of gain will help; consider a Smith predictor';
  sp.message = `K ${fit.K.toPrecision(3)} EU/%, tau ${fit.tau.toFixed(1)} s, theta `
    + `${fit.theta.toFixed(1)} s. theta/tau ${ratio.toFixed(2)} — ${difficulty}.`;
}

/**
 * Abandon a running step test.
 * @param {object} sp step-test state (mutated)
 * @returns {void}
 */
export function abortStepTest(sp) {
  if (sp.phase === STEP.SETTLING || sp.phase === STEP.RECORDING) {
    sp.phase = STEP.IDLE;
    sp.co = sp.co0;
    sp.message = 'aborted by the operator';
  }
}

/**
 * Model-based candidates, for when a FOPDT fit is available.
 *
 * @param {{K:number, tau:number, theta:number}} model the process model
 * @returns {Array<{id:string,name:string,Kc:number,Ti:number,Td:number,note:string}>} candidates
 */
export function modelRules(model) {
  if (!model || !(Math.abs(model.K) > 0)) return [];
  const out = [];
  const simc = simcTuning(model, model.theta);
  out.push({
    id: 'SIMC',
    name: 'SIMC (tc = theta)',
    ...simc,
    note: 'Skogestad\'s recommended setting. Derived rather than fitted, and it lands near 30 '
      + 'degrees of phase margin on almost any process. The sane modern default.',
  });
  const simcSlow = simcTuning(model, 3 * model.theta);
  out.push({
    id: 'SIMC_SLOW',
    name: 'SIMC (tc = 3 theta)',
    ...simcSlow,
    note: 'The same rule asked for a slower closed loop. Use when the final element is expensive '
      + 'to move or the measurement is noisy.',
  });
  for (const mult of [1, 3]) {
    const lam = mult * Math.max(model.tau, model.theta);
    const t = lambdaTuning(model, lam);
    out.push({
      id: `LAMBDA_${mult}`,
      name: `Lambda (${lam.toFixed(0)} s closed loop)`,
      ...t,
      note: `Asks the loop to settle in about ${lam.toFixed(0)} s. The only rule whose knob means `
        + 'something an operator recognises.',
    });
  }
  return out;
}

/**
 * Rank a set of candidate tunings by simulating each one on the model.
 *
 * This is what turns a table of rules into advice. Every rule in the literature was derived for
 * some particular idea of "good", and those ideas disagree; running them all against the same
 * model and showing what each actually does — how far it overshoots, how long it settles, how
 * much margin it leaves, how hard it works the valve — replaces an argument about pedigree with
 * a comparison.
 *
 * @param {Array<object>} rules candidates from {@link tuningRules} or {@link modelRules}
 * @param {{K:number, tau:number, theta:number}} model the process model
 * @param {object} deps the analysis functions, injected so this module stays free of imports it
 *   would otherwise only need here
 * @param {Function} deps.loopResponse from `control/analysis.js`
 * @param {Function} deps.margins from `control/analysis.js`
 * @param {Function} deps.predictStep from `control/analysis.js`
 * @param {Float64Array} deps.grid the frequency grid
 * @param {object} base a template tuning record the candidates are merged into
 * @param {number} [scan_s=0] the controller scan period, s
 * @returns {Array<object>} the candidates, each with `margins` and `predicted`, best first
 */
export function rankTunings(rules, model, deps, base, scan_s = 0) {
  const scored = rules.map((r) => {
    const cfg = { ...base, Kc: r.Kc, Ti: r.Ti, Td: r.Td };
    const resp = deps.loopResponse(cfg, model, deps.grid, scan_s);
    const m = deps.margins(resp);
    const pred = deps.predictStep(cfg, model, { spStep: 1, horizon: Math.max(120, 40 * model.tau), scan_s });
    return { ...r, margins: m, predicted: pred };
  });

  // Rank on how close Ms lands to 1.6 — the middle of the range plant loops actually live in —
  // with anything unstable pushed to the bottom regardless.
  scored.sort((a, b) => {
    if (a.margins.stable !== b.margins.stable) return a.margins.stable ? -1 : 1;
    return Math.abs(a.margins.ms - 1.6) - Math.abs(b.margins.ms - 1.6);
  });
  return scored;
}
