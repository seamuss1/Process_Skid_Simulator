/**
 * src/control/analysis.js — the frequency domain: loop transfer function, stability margins,
 * sensitivity peak, closed-loop prediction, and a measured frequency sweep on the live plant.
 *
 * Layer L2: imports `core/util.js` and `control/pid.js`. No DOM, no plant — it is handed a model
 * or a measurement.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A TUNING TRAINER NEEDS THE FREQUENCY DOMAIN
 *
 * Trial and error tells you whether a tuning worked on the disturbance you happened to try. It
 * does not tell you how close you were to instability, and that is the number that matters,
 * because the process will not stay where it was when you tuned it. A pump wears, a strainer
 * fouls, a second machine starts, the liquid gets colder — and a loop with no margin was fine
 * right up until it was not.
 *
 * Three numbers answer it:
 *
 *   GAIN MARGIN   how much more gain the loop would tolerate before oscillating. Classically
 *                 2 to 5 (6 to 14 dB).
 *   PHASE MARGIN  how much more phase lag — that is, how much more DEAD TIME — it would tolerate.
 *                 Classically 30 to 60 degrees. Divide it by the crossover frequency and it
 *                 becomes a DELAY MARGIN in seconds, which is the form an engineer can actually
 *                 check against a plant: "this loop tolerates another 1.4 seconds of dead time".
 *   Ms            the peak of the sensitivity function, 1/|1+L|. The best single robustness
 *                 number there is, because it bounds both of the others at once: Ms below 1.4 is
 *                 conservative, 1.4 to 2.0 is normal, and above 2.0 is a loop that will ring.
 *
 * ------------------------------------------------------------------------------------------
 * TWO WAYS TO GET THERE, AND THEY DISAGREE USEFULLY
 *
 * MODEL-BASED is instant: take a first-order-plus-dead-time fit of the process, write down the
 * controller's transfer function exactly, multiply, and read the margins off. It is exact for the
 * model and only as good as the model.
 *
 * MEASURED is a real experiment: inject a sinusoid at each frequency and correlate the response
 * out of the noise, exactly as a dynamic signal analyser does. It takes real time and it tells
 * the truth, including the parts of the truth the FOPDT fit threw away — the second lag from the
 * discharge line, the way the gain changes with operating point, the phase the transmitter filter
 * is quietly adding.
 *
 * Comparing the two on the same axes is the point. Where they agree, the model can be trusted for
 * design. Where they diverge is exactly where a model-based tuning will disappoint.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

// ---------------------------------------------------------------------------------------------
// Complex arithmetic, kept minimal and local
// ---------------------------------------------------------------------------------------------

/**
 * @param {number} re real part
 * @param {number} im imaginary part
 * @returns {{re:number, im:number}} a complex number
 */
const cx = (re, im) => ({ re, im });
/**
 * @param {object} a first operand
 * @param {object} b second operand
 * @returns {{re:number, im:number}} the product
 */
const cmul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
/**
 * @param {object} a numerator
 * @param {object} b denominator
 * @returns {{re:number, im:number}} the quotient
 */
const cdiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im || 1e-300;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
/**
 * @param {object} a first operand
 * @param {object} b second operand
 * @returns {{re:number, im:number}} the sum
 */
const cadd = (a, b) => cx(a.re + b.re, a.im + b.im);
/**
 * @param {object} a the number
 * @returns {number} its magnitude
 */
const cabs = (a) => Math.hypot(a.re, a.im);
/**
 * @param {object} a the number
 * @returns {number} its argument, radians
 */
const carg = (a) => Math.atan2(a.im, a.re);
/**
 * @param {number} theta angle, radians
 * @returns {{re:number, im:number}} exp(j*theta)
 */
const cexp = (theta) => cx(Math.cos(theta), Math.sin(theta));

/**
 * Frequency response of a first-order-plus-dead-time process.
 *
 *     G(jw) = K * exp(-j*w*theta) / (1 + j*w*tau)
 *
 * @param {{K:number, tau:number, theta:number}} m the model
 * @param {number} w angular frequency, rad/s
 * @returns {{re:number, im:number}} G(jw)
 */
export function processResponse(m, w) {
  return cmul(cdiv(cx(m.K, 0), cx(1, w * m.tau)), cexp(-w * m.theta));
}

/**
 * Frequency response of the controller, in the FEEDBACK path.
 *
 *     C(jw) = Kc * [ 1 + 1/(j*w*Ti) + j*w*Td / (1 + j*w*Td/N) ]
 *
 * Setpoint weighting does not appear: `b` and `c` act only on the setpoint, so they change how the
 * loop follows a setpoint but not whether it is stable. That is precisely why lowering `b` is such
 * a useful knob — it buys a gentler setpoint response for free, without spending any margin.
 *
 * The measurement filter and the scan period ARE included, because they are in the feedback path
 * and they both cost phase. A zero-order hold sampling at `scan_s` contributes very nearly half a
 * scan period of pure delay, and on a tightly tuned loop that is a real fraction of the budget.
 *
 * @param {object} cfg the tuning record
 * @param {number} w angular frequency, rad/s
 * @param {number} [scan_s=0] controller scan period, s
 * @returns {{re:number, im:number}} C(jw)
 */
export function controllerResponse(cfg, w, scan_s = 0) {
  const integral = Number.isFinite(cfg.Ti) && cfg.Ti > 0
    ? cdiv(cx(1, 0), cx(0, w * cfg.Ti)) : cx(0, 0);
  const N = cfg.N > 0 ? cfg.N : 10;
  const deriv = cfg.Td > 0
    ? cdiv(cx(0, w * cfg.Td), cx(1, (w * cfg.Td) / N)) : cx(0, 0);
  let C = cx(cfg.Kc, 0);
  C = cmul(C, cadd(cadd(cx(1, 0), integral), deriv));
  if (cfg.pvFilter_s > 0) C = cdiv(C, cx(1, w * cfg.pvFilter_s));
  if (scan_s > 0) C = cmul(C, cexp((-w * scan_s) / 2));
  return C;
}

/**
 * Sample the open-loop, sensitivity and complementary-sensitivity responses over a set of
 * frequencies.
 * @param {object} cfg the tuning record
 * @param {{K:number, tau:number, theta:number}} model the process model
 * @param {Float64Array|number[]} w angular frequencies, rad/s
 * @param {number} [scan_s=0] controller scan period, s
 * @returns {{w:Float64Array, magL:Float64Array, phaseL:Float64Array, reL:Float64Array,
 *   imL:Float64Array, magS:Float64Array, magT:Float64Array}} the sampled responses
 */
export function loopResponse(cfg, model, w, scan_s = 0) {
  const n = w.length;
  const out = {
    w: Float64Array.from(w),
    magL: new Float64Array(n),
    phaseL: new Float64Array(n),
    reL: new Float64Array(n),
    imL: new Float64Array(n),
    magS: new Float64Array(n),
    magT: new Float64Array(n),
  };
  let unwrap = 0;
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    const L = cmul(controllerResponse(cfg, w[i], scan_s), processResponse(model, w[i]));
    out.magL[i] = cabs(L);
    out.reL[i] = L.re;
    out.imL[i] = L.im;
    // Unwrap the phase so a Bode plot reads continuously through -180 degrees instead of
    // jumping, which is the difference between a chart you can read a margin off and one you
    // cannot.
    let ph = carg(L);
    if (i > 0) {
      while (ph - prev > Math.PI) ph -= 2 * Math.PI;
      while (prev - ph > Math.PI) ph += 2 * Math.PI;
    }
    prev = ph;
    unwrap = ph;
    out.phaseL[i] = (unwrap * 180) / Math.PI;
    const S = cdiv(cx(1, 0), cadd(cx(1, 0), L));
    out.magS[i] = cabs(S);
    out.magT[i] = cabs(cmul(L, S));
  }
  return out;
}

/** A logarithmically spaced frequency grid. */
export const DEFAULT_GRID = logspace(-2.3, 1.2, 220);

/**
 * Logarithmically spaced frequencies.
 * @param {number} decadeLo log10 of the lowest frequency
 * @param {number} decadeHi log10 of the highest
 * @param {number} n how many points
 * @returns {Float64Array} the frequencies, rad/s
 */
export function logspace(decadeLo, decadeHi, n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    w[i] = 10 ** (decadeLo + ((decadeHi - decadeLo) * i) / (n - 1));
  }
  return w;
}

/**
 * Read the stability margins off a sampled loop response.
 *
 * Crossings are found by linear interpolation between grid points rather than by re-solving,
 * which is accurate to well within the width of the pen on any chart and cannot fail to converge.
 *
 * @param {object} r the result of {@link loopResponse}
 * @returns {{gm:number, gm_dB:number, pm_deg:number, wgc:number, wpc:number, ms:number,
 *   wms:number, delayMargin_s:number, stable:boolean, verdict:string}} the margins
 */
export function margins(r) {
  const n = r.w.length;
  let wgc = NaN;
  let pmDeg = NaN;
  let wpc = NaN;
  let gm = NaN;

  // Gain crossover: |L| passes through 1. Take the LAST such crossing, which is the one that
  // decides stability when the magnitude is not monotone.
  for (let i = 1; i < n; i += 1) {
    if ((r.magL[i - 1] - 1) * (r.magL[i] - 1) < 0) {
      const t = (1 - r.magL[i - 1]) / (r.magL[i] - r.magL[i - 1]);
      wgc = r.w[i - 1] + t * (r.w[i] - r.w[i - 1]);
      pmDeg = 180 + (r.phaseL[i - 1] + t * (r.phaseL[i] - r.phaseL[i - 1]));
    }
  }
  // Phase crossover: the phase passes through -180 degrees.
  for (let i = 1; i < n; i += 1) {
    if ((r.phaseL[i - 1] + 180) * (r.phaseL[i] + 180) < 0) {
      const t = (-180 - r.phaseL[i - 1]) / (r.phaseL[i] - r.phaseL[i - 1]);
      wpc = r.w[i - 1] + t * (r.w[i] - r.w[i - 1]);
      const mag = r.magL[i - 1] + t * (r.magL[i] - r.magL[i - 1]);
      gm = mag > 0 ? 1 / mag : Infinity;
      break;
    }
  }

  let ms = 0;
  let wms = 0;
  for (let i = 0; i < n; i += 1) if (r.magS[i] > ms) { ms = r.magS[i]; wms = r.w[i]; }

  const stable = !(Number.isFinite(gm) && gm < 1) && !(Number.isFinite(pmDeg) && pmDeg <= 0);
  const delayMargin = Number.isFinite(pmDeg) && wgc > 0 ? (pmDeg * Math.PI) / 180 / wgc : Infinity;

  let verdict;
  if (!stable) verdict = 'unstable — this tuning will oscillate and keep oscillating';
  else if (ms > 2.4) verdict = 'very aggressive — almost no margin left for the process to change';
  else if (ms > 2.0) verdict = 'aggressive — fast, and it will ring on anything unexpected';
  else if (ms > 1.6) verdict = 'normal — the range most plant loops live in';
  else if (ms > 1.3) verdict = 'robust — safe against a process that moves around';
  else verdict = 'conservative — plenty of margin, and slower than it needs to be';

  return { gm, gm_dB: 20 * Math.log10(gm), pm_deg: pmDeg, wgc, wpc, ms, wms, delayMargin_s: delayMargin, stable, verdict };
}

/**
 * Simulate the closed loop on the MODEL, so a tuning can be judged before it is applied to the
 * plant.
 *
 * This is the single most useful thing the model buys. Trying a candidate tuning on the real rig
 * costs a real upset; trying it here costs a millisecond, and the answer is close enough to rank
 * six rule sets against each other and pick the two worth actually testing.
 *
 * @param {object} cfg the tuning record
 * @param {{K:number, tau:number, theta:number}} model the process model
 * @param {object} [opts] options
 * @param {number} [opts.dt=0.1] integration step, s
 * @param {number} [opts.horizon=200] how long to simulate, s
 * @param {number} [opts.spStep=1] setpoint step size, engineering units
 * @param {number} [opts.loadStep=0] load step applied at half the horizon, output percent
 * @param {number} [opts.scan_s=0] controller scan period, s
 * @returns {{t:Float64Array, y:Float64Array, u:Float64Array, overshootPct:number,
 *   settle_s:number, rise_s:number, iae:number, travel:number, stable:boolean}} the prediction
 */
export function predictStep(cfg, model, opts = {}) {
  const dt = opts.dt || 0.1;
  const horizon = opts.horizon || 200;
  const spStep = opts.spStep === undefined ? 1 : opts.spStep;
  const loadStep = opts.loadStep || 0;
  const scan = Math.max(opts.scan_s || dt, dt);
  const n = Math.round(horizon / dt);
  const t = new Float64Array(n);
  const y = new Float64Array(n);
  const u = new Float64Array(n);

  const nDelay = Math.max(1, Math.round(model.theta / dt));
  const line = new Float64Array(nDelay);
  const a = Math.exp(-dt / Math.max(model.tau, 1e-6));
  let yv = 0;
  let li = 0;

  // A minimal ISA PID, matching `control/pid.js`: filtered derivative on the measurement,
  // back-calculation anti-windup, output limits.
  let integ = 0;
  let deriv = 0;
  let ePrev = 0;
  let co = 0;
  let sinceScan = 1e9;
  const N = cfg.N > 0 ? cfg.N : 10;
  const lo = cfg.outLo === undefined ? -1e6 : cfg.outLo;
  const hi = cfg.outHi === undefined ? 1e6 : cfg.outHi;
  const band = 0.02 * Math.abs(spStep || 1);

  let settle = 0;
  let rise = NaN;
  let peak = -Infinity;
  let iae = 0;
  let travel = 0;
  let coPrev = 0;
  const loadAt = horizon / 2;

  for (let k = 0; k < n; k += 1) {
    const time = k * dt;
    t[k] = time;
    const sp = time >= 5 ? spStep : 0;
    const load = loadStep && time >= loadAt ? loadStep : 0;

    sinceScan += dt;
    if (sinceScan >= scan - 1e-12) {
      const eP = cfg.b === undefined ? sp - yv : cfg.b * sp - yv;
      const eI = sp - yv;
      const eD = cfg.c ? cfg.c * sp - yv : -yv;
      const prop = cfg.Kc * eP;
      if (cfg.Td > 0) {
        const den = cfg.Td + N * sinceScan;
        deriv = (cfg.Td / den) * deriv + ((cfg.Kc * cfg.Td * N) / den) * (eD - ePrev);
      } else deriv = 0;
      ePrev = eD;
      const raw = prop + integ + deriv;
      const sat = clamp(raw, lo, hi);
      const Ti = cfg.Ti;
      const inc = Number.isFinite(Ti) && Ti > 0 ? (cfg.Kc * sinceScan * eI) / Ti : 0;
      const Tt = cfg.Tt && cfg.Tt > 0 ? cfg.Tt : (Number.isFinite(Ti) && Ti > 0 ? Ti : 1);
      integ += inc + ((sat - raw) * sinceScan) / Tt;
      co = sat;
      sinceScan = 0;
    }

    const delayed = line[li];
    line[li] = co + load;
    li = (li + 1) % nDelay;
    yv = yv * a + model.K * delayed * (1 - a);

    y[k] = yv;
    u[k] = co;
    if (time >= 5) {
      const err = Math.abs(sp - yv);
      iae += err * dt;
      if (yv > peak) peak = yv;
      if (err > band) settle = time - 5;
      if (!Number.isFinite(rise) && spStep > 0 && yv >= 0.9 * spStep) rise = time - 5;
    }
    travel += Math.abs(co - coPrev);
    coPrev = co;
    if (!Number.isFinite(yv) || Math.abs(yv) > 1e6) {
      return { t, y, u, overshootPct: Infinity, settle_s: Infinity, rise_s: NaN, iae: Infinity, travel: Infinity, stable: false };
    }
  }
  const overshoot = spStep > 0 && Number.isFinite(peak)
    ? Math.max(0, ((peak - spStep) / spStep) * 100) : NaN;
  // A loop that is still moving at the end of the horizon has not settled; call it unstable
  // rather than reporting a settling time that is really "the simulation ran out".
  const tail = Math.abs(y[n - 1] - y[n - 1 - Math.round(10 / dt)]);
  return {
    t, y, u,
    overshootPct: overshoot,
    settle_s: settle,
    rise_s: rise,
    iae,
    travel,
    stable: tail < 0.02 * Math.abs(spStep || 1),
  };
}

// ---------------------------------------------------------------------------------------------
// The measured sweep
// ---------------------------------------------------------------------------------------------

/** Phases of a measured frequency sweep. */
export const SWEEP = Object.freeze({
  IDLE: 'IDLE',
  /** Waiting out the transient at a new frequency before any of it is believed. */
  SETTLING: 'SETTLING',
  /** Correlating the response over an integer number of cycles. */
  MEASURING: 'MEASURING',
  DONE: 'DONE',
  FAILED: 'FAILED',
});

/**
 * Allocate the state of a measured frequency sweep.
 * @returns {object} sweep state
 */
export function createSweepState() {
  return {
    phase: SWEEP.IDLE,
    /** Frequencies still to do, and the ones already done. */
    todo: [],
    /** @type {Array<{w:number, mag:number, phase_deg:number}>} results so far */
    points: [],
    /** The frequency being measured now, rad/s. */
    w: 0,
    /** Injection amplitude, output percent. */
    amp: 4,
    /** Output the sweep swings about, percent. */
    bias: 50,
    /** Simulated time this frequency's phase began, s. */
    tPhase_s: 0,
    /** Correlation accumulators. */
    accS: 0,
    accC: 0,
    accT: 0,
    /** Output the sweep is commanding, percent. */
    co: 50,
    /** Human-readable status. */
    message: 'idle',
  };
}

/** Cycles discarded at each frequency before correlating. */
const SWEEP_SETTLE_CYCLES = 2.5;
/** Cycles correlated at each frequency. */
const SWEEP_MEASURE_CYCLES = 4;

/**
 * Begin a measured sweep.
 * @param {object} sw sweep state (mutated)
 * @param {object} opts settings
 * @param {number} opts.bias output to swing about, percent
 * @param {number} opts.amp injection amplitude, output percent
 * @param {number} opts.t_s simulated time now, s
 * @param {number} [opts.wLo=0.05] lowest frequency, rad/s
 * @param {number} [opts.wHi=6] highest frequency, rad/s
 * @param {number} [opts.n=11] number of frequencies
 * @param {number} opts.outLo output low limit
 * @param {number} opts.outHi output high limit
 * @returns {{ok:boolean, reason?:string, estimate_s?:number}} whether the sweep could start, and
 *   roughly how long it will take
 */
export function startSweep(sw, opts) {
  const { bias, amp, t_s, outLo, outHi } = opts;
  if (!(amp > 0)) return { ok: false, reason: 'injection amplitude must be greater than zero' };
  if (bias - amp < outLo - 1e-9 || bias + amp > outHi + 1e-9) {
    return {
      ok: false,
      reason: `the injection would clip: ${(bias - amp).toFixed(0)}..${(bias + amp).toFixed(0)}% is `
        + `outside the ${outLo}..${outHi}% output range`,
    };
  }
  const wLo = opts.wLo || 0.05;
  const wHi = opts.wHi || 6;
  const n = opts.n || 11;
  sw.todo = [];
  for (let i = 0; i < n; i += 1) {
    sw.todo.push(10 ** (Math.log10(wLo) + ((Math.log10(wHi) - Math.log10(wLo)) * i) / (n - 1)));
  }
  sw.points = [];
  sw.amp = amp;
  sw.bias = bias;
  sw.co = bias;
  sw.phase = SWEEP.SETTLING;
  sw.w = sw.todo.shift();
  sw.tPhase_s = t_s;
  sw.accS = 0;
  sw.accC = 0;
  sw.accT = 0;
  let est = 0;
  for (const w of [sw.w, ...sw.todo]) {
    est += ((SWEEP_SETTLE_CYCLES + SWEEP_MEASURE_CYCLES) * 2 * Math.PI) / w;
  }
  sw.message = `sweeping ${n} frequencies — about ${Math.round(est / 60)} min of plant time`;
  return { ok: true, estimate_s: est };
}

/**
 * Advance a measured sweep one scan.
 *
 * The response is extracted by correlating the measurement against a sine and a cosine at the
 * injection frequency over a whole number of cycles — the same single-bin discrete Fourier
 * transform a lock-in amplifier performs. Anything that is not at the injection frequency,
 * including all of the transmitter noise and any drift, integrates to very nearly nothing, which
 * is why this works on a signal where the injected component is invisible to the eye.
 *
 * @param {object} sw sweep state (mutated)
 * @param {number} pv the measurement, engineering units
 * @param {number} t_s simulated time, s
 * @param {number} dt_s scan period, s
 * @returns {number} the output the sweep wants, percent
 */
export function stepSweep(sw, pv, t_s, dt_s) {
  if (sw.phase !== SWEEP.SETTLING && sw.phase !== SWEEP.MEASURING) return sw.co;
  const elapsed = t_s - sw.tPhase_s;
  const period = (2 * Math.PI) / sw.w;
  sw.co = sw.bias + sw.amp * Math.sin(sw.w * t_s);

  if (sw.phase === SWEEP.SETTLING) {
    if (elapsed >= SWEEP_SETTLE_CYCLES * period) {
      sw.phase = SWEEP.MEASURING;
      sw.tPhase_s = t_s;
      sw.accS = 0;
      sw.accC = 0;
      sw.accT = 0;
      sw.message = `measuring ${sw.w.toFixed(3)} rad/s (${(period).toFixed(1)} s period), `
        + `${sw.points.length + 1} of ${sw.points.length + 1 + sw.todo.length}`;
    }
    return sw.co;
  }

  sw.accS += pv * Math.sin(sw.w * t_s) * dt_s;
  sw.accC += pv * Math.cos(sw.w * t_s) * dt_s;
  sw.accT += dt_s;

  if (elapsed >= SWEEP_MEASURE_CYCLES * period) {
    const a = (2 * sw.accS) / sw.accT;
    const b = (2 * sw.accC) / sw.accT;
    const B = Math.hypot(a, b);
    sw.points.push({
      w: sw.w,
      mag: B / sw.amp,
      phase_deg: (Math.atan2(b, a) * 180) / Math.PI,
    });
    if (sw.todo.length === 0) {
      sw.phase = SWEEP.DONE;
      sw.co = sw.bias;
      sw.message = `sweep complete — ${sw.points.length} frequencies measured`;
    } else {
      sw.w = sw.todo.shift();
      sw.phase = SWEEP.SETTLING;
      sw.tPhase_s = t_s;
    }
  }
  return sw.co;
}

/**
 * Abandon a running sweep.
 * @param {object} sw sweep state (mutated)
 * @returns {void}
 */
export function abortSweep(sw) {
  if (sw.phase === SWEEP.SETTLING || sw.phase === SWEEP.MEASURING) {
    sw.phase = SWEEP.IDLE;
    sw.message = 'aborted by the operator';
  }
}

/**
 * Fit a first-order-plus-dead-time model to a set of measured frequency-response points.
 *
 * The gain comes from the lowest frequency measured, where the lag has not yet done anything. The
 * time constant and dead time then come from a coarse grid search on the phase, which is what
 * actually distinguishes them — magnitude alone cannot tell a lag from a delay, and that
 * ambiguity is precisely why a step test can be fooled and a frequency sweep cannot.
 *
 * @param {Array<{w:number, mag:number, phase_deg:number}>} points the measured response
 * @returns {{ok:boolean, K?:number, tau?:number, theta?:number, rms?:number, reason?:string}} the
 *   fitted model
 */
export function fitFromSweep(points) {
  if (!points || points.length < 4) return { ok: false, reason: 'not enough frequencies measured' };
  const sorted = points.slice().sort((a, b) => a.w - b.w);
  const K = sorted[0].mag;
  if (!(K > 0)) return { ok: false, reason: 'the measured gain is zero' };
  let best = null;
  for (let tau = 0.2; tau <= 60; tau *= 1.12) {
    for (let theta = 0; theta <= 20; theta += 0.05) {
      let err = 0;
      for (const p of sorted) {
        const pred = (-Math.atan(p.w * tau) - p.w * theta) * (180 / Math.PI);
        let d = pred - p.phase_deg;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        err += d * d;
      }
      if (best === null || err < best.err) best = { tau, theta, err };
    }
  }
  return { ok: true, K, tau: best.tau, theta: best.theta, rms: Math.sqrt(best.err / sorted.length) };
}
