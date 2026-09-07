/**
 * src/control/diagnostics.js — control-loop performance monitoring: is this loop oscillating, how
 * far is it from the best it could possibly be, and if it is cycling, is that the controller's
 * fault or the valve's?
 *
 * Layer L1: imports `core/util.js` only. Given arrays of samples; knows nothing about the plant.
 *
 * ------------------------------------------------------------------------------------------
 * THE QUESTION THIS MODULE ANSWERS
 *
 * A plant has hundreds of loops and nobody has time to look at them. What is wanted is a short
 * list: which loops are misbehaving, and what KIND of misbehaviour is it, because the three kinds
 * have three completely different fixes and doing the wrong one makes things worse.
 *
 *   TUNED TOO HOT      the loop oscillates smoothly, near-sinusoidally, and detuning fixes it.
 *   STICKING VALVE     the loop oscillates in a distorted, square-ish waveform that no tuning
 *                      will fix, because the limit cycle is coming from friction in the stem.
 *                      Detuning makes the cycle SLOWER and no smaller, and the loop is now also
 *                      sluggish. The fix is a maintenance ticket, not a tuning session.
 *   NOTHING WRONG      the loop is as good as the dead time allows, and any remaining variance is
 *                      the disturbance, not the controller. Tuning this loop is wasted effort.
 *
 * Telling the second from the first is the single most valuable thing a loop-monitoring package
 * does, and the industry standard for the third is the Harris index below.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/**
 * Fundamental-power fraction below which a cycle is called distorted rather than sinusoidal.
 *
 * Placed from the arithmetic rather than by eye. A pure sine puts all of its power in the
 * fundamental and scores 1.00. A square wave — which is what the measurement looks like when a
 * sticking stem moves in jumps — puts 8/pi^2 of its power there and scores about 0.81. A triangle
 * scores 0.99, which is why this test is applied to the MEASUREMENT and not to the controller
 * output: the output of a sticking loop is a sawtooth and would pass for a sine.
 *
 * 0.93 sits comfortably between the square wave and everything smoother, and it is deliberately
 * not the only condition — the stall fraction and a measurable stickband have to agree.
 */
const STICTION_SHAPE = 0.93;

/**
 * Allocate a rolling diagnostic window.
 * @param {number} capacity how many samples to keep
 * @param {number} period_s the sampling period the samples arrive at, s
 * @returns {object} the window
 */
export function createDiagnostics(capacity, period_s) {
  return {
    cap: capacity,
    period_s,
    n: 0,
    head: 0,
    /** Control error, engineering units. */
    e: new Float64Array(capacity),
    /** Controller output, percent. */
    u: new Float64Array(capacity),
    /** Process variable, engineering units. */
    y: new Float64Array(capacity),
    /** The last report produced, so the UI has something to show between recomputations. */
    report: null,
    /** Samples since the report was last recomputed. */
    sinceReport: 0,
  };
}

/**
 * Append one sample.
 * @param {object} d the window (mutated)
 * @param {number} e control error
 * @param {number} u controller output
 * @param {number} y process variable
 * @returns {void}
 */
export function pushSample(d, e, u, y) {
  d.e[d.head] = e;
  d.u[d.head] = u;
  d.y[d.head] = y;
  d.head = (d.head + 1) % d.cap;
  if (d.n < d.cap) d.n += 1;
  d.sinceReport += 1;
}

/**
 * Copy a channel out oldest-first.
 * @param {object} d the window
 * @param {string} name 'e', 'u' or 'y'
 * @returns {Float64Array} the samples, oldest first
 */
function series(d, name) {
  const src = d[name];
  const out = new Float64Array(d.n);
  const start = (d.head - d.n + d.cap) % d.cap;
  for (let i = 0; i < d.n; i += 1) out[i] = src[(start + i) % d.cap];
  return out;
}

/**
 * Mean and variance of a series.
 * @param {Float64Array} x the samples
 * @returns {{mean:number, variance:number}} the moments
 */
function moments(x) {
  const n = x.length;
  if (!n) return { mean: 0, variance: 0 };
  let s = 0;
  for (let i = 0; i < n; i += 1) s += x[i];
  const mean = s / n;
  let v = 0;
  for (let i = 0; i < n; i += 1) v += (x[i] - mean) ** 2;
  return { mean, variance: v / n };
}

/**
 * Biased autocovariance up to a lag.
 * @param {Float64Array} x the samples, mean already removed
 * @param {number} maxLag the highest lag wanted
 * @returns {Float64Array} r[0..maxLag]
 */
function autocov(x, maxLag) {
  const n = x.length;
  const r = new Float64Array(maxLag + 1);
  for (let k = 0; k <= maxLag; k += 1) {
    let s = 0;
    for (let i = 0; i + k < n; i += 1) s += x[i] * x[i + k];
    r[k] = s / n;
  }
  return r;
}

/**
 * Detect a sustained oscillation, and measure its period, from the autocorrelation of the error.
 *
 * A loop that is merely being disturbed has an autocorrelation that decays; a loop that is
 * OSCILLATING has one that comes back up, and the lag at which it does so is the period. Using
 * the autocorrelation rather than counting zero crossings is what makes this work on a noisy
 * signal, because noise is uncorrelated and integrates away while the cycle does not.
 *
 * @param {Float64Array} e the error samples, oldest first
 * @param {number} period_s the sample period, s
 * @returns {{oscillating:boolean, period_s:number, strength:number}} whether it is cycling, at
 *   what period, and how strongly (the height of the autocorrelation peak, 0..1)
 */
export function detectOscillation(e, period_s) {
  const n = e.length;
  if (n < 60) return { oscillating: false, period_s: NaN, strength: 0 };
  const { mean } = moments(e);
  const x = Float64Array.from(e, (v) => v - mean);
  const maxLag = Math.floor(n / 2);
  const r = autocov(x, maxLag);
  if (!(r[0] > 0)) return { oscillating: false, period_s: NaN, strength: 0 };

  // Walk past the first zero crossing, then find the highest peak after it.
  let i = 1;
  while (i < maxLag && r[i] > 0) i += 1;
  let bestLag = -1;
  let best = 0;
  for (let k = i; k < maxLag - 1; k += 1) {
    const v = r[k] / r[0];
    if (v > best && r[k] >= r[k - 1] && r[k] >= r[k + 1]) { best = v; bestLag = k; }
  }
  if (bestLag < 0) return { oscillating: false, period_s: NaN, strength: 0 };
  return {
    oscillating: best > 0.35,
    period_s: bestLag * period_s,
    strength: clamp(best, 0, 1),
  };
}

/**
 * Average a series down to a lower sample rate.
 *
 * Oscillation detection has to see a WHOLE period, and a stiction limit cycle on a slow loop can
 * run to four or five minutes. Correlating a 5 Hz series out to a five-minute lag is thousands of
 * lags on thousands of samples, several times a minute, for no gain — a cycle that slow is
 * perfectly visible at 1 Hz. Averaging rather than picking every nth sample also acts as an
 * anti-alias filter, which keeps measurement noise from folding down into the band being searched.
 *
 * @param {Float64Array} x the samples
 * @param {number} factor how many samples to average per output sample
 * @returns {Float64Array} the decimated series
 */
function decimate(x, factor) {
  if (factor <= 1) return x;
  const m = Math.floor(x.length / factor);
  const out = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    let s = 0;
    for (let k = 0; k < factor; k += 1) s += x[i * factor + k];
    out[i] = s / factor;
  }
  return out;
}

/**
 * Levinson-Durbin recursion: fit an autoregressive model from an autocovariance sequence.
 * @param {Float64Array} r autocovariance, r[0..p]
 * @param {number} p model order
 * @returns {{a:Float64Array, sigma2:number}} the AR coefficients a[1..p] and the innovation variance
 */
function levinson(r, p) {
  const a = new Float64Array(p + 1);
  let sigma2 = r[0];
  if (!(sigma2 > 0)) return { a, sigma2: 0 };
  for (let m = 1; m <= p; m += 1) {
    let acc = r[m];
    for (let i = 1; i < m; i += 1) acc -= a[i] * r[m - i];
    const k = acc / sigma2;
    const prev = a.slice();
    a[m] = k;
    for (let i = 1; i < m; i += 1) a[i] = prev[i] - k * prev[m - i];
    sigma2 *= 1 - k * k;
    if (!(sigma2 > 0)) { sigma2 = 1e-12; break; }
  }
  return { a, sigma2 };
}

/**
 * The Harris index: how close this loop is to the best any controller could possibly do.
 *
 * ------------------------------------------------------------------------------------------
 * The idea is due to Harris (1989) and it is the closest thing process control has to an
 * absolute performance benchmark. Whatever the controller does, it cannot react to a disturbance
 * until the dead time has elapsed — so the first `d+1` terms of the closed-loop impulse response
 * are FIXED by the process, not by the tuning. The variance those terms contribute is therefore
 * the minimum achievable variance, and the ratio
 *
 *     eta = sigma^2_minimum-variance / sigma^2_actual
 *
 * says what fraction of the achievable performance this loop is delivering. It needs nothing but
 * routine operating data and an estimate of the dead time — no test, no upset, no downtime, which
 * is exactly why it is the metric that gets used on real plants.
 *
 * INTERPRETING IT HONESTLY. eta near 1 does not mean the loop is well tuned; it means retuning it
 * cannot help, because the remaining variance is the disturbance passing through the dead time.
 * eta near 0 means there is a great deal of room — but a minimum-variance controller is far too
 * aggressive to actually run, so nobody expects 1. Above about 0.6 is generally considered good,
 * and below 0.3 is a loop worth someone's afternoon.
 * ------------------------------------------------------------------------------------------
 *
 * @param {Float64Array} e the error samples, oldest first
 * @param {number} deadTimeSamples the process dead time, in samples
 * @param {number} [order=20] AR model order
 * @returns {{eta:number, sigma2:number, sigma2mv:number, ok:boolean, reason?:string}} the index
 */
export function harrisIndex(e, deadTimeSamples, order = 20) {
  const n = e.length;
  const d = Math.max(0, Math.round(deadTimeSamples));
  if (n < order * 8) return { eta: NaN, sigma2: 0, sigma2mv: 0, ok: false, reason: 'not enough data yet' };
  const { mean, variance } = moments(e);
  if (!(variance > 1e-14)) {
    return { eta: 1, sigma2: variance, sigma2mv: variance, ok: true };
  }
  const x = Float64Array.from(e, (v) => v - mean);
  const p = Math.min(order, Math.floor(n / 6));
  const r = autocov(x, p);
  const { a, sigma2 } = levinson(r, p);

  // Impulse response of the fitted AR model: psi[0] = 1, psi[j] = sum_i a[i]*psi[j-i].
  const psi = new Float64Array(d + 1);
  psi[0] = 1;
  for (let j = 1; j <= d; j += 1) {
    let s = 0;
    for (let i = 1; i <= Math.min(p, j); i += 1) s += a[i] * psi[j - i];
    psi[j] = s;
  }
  let sum = 0;
  for (let j = 0; j <= d; j += 1) sum += psi[j] * psi[j];
  const sigma2mv = sigma2 * sum;
  return { eta: clamp(sigma2mv / variance, 0, 1), sigma2: variance, sigma2mv, ok: true };
}

/**
 * How sinusoidal an oscillation is, from the share of ITS OWN power that sits in the fundamental
 * rather than in the harmonics.
 *
 * A limit cycle produced by too much gain is close to a sine wave, because the loop is a linear
 * system on the edge of instability and a linear system cannot manufacture harmonics. A limit
 * cycle produced by a sticking valve is not: the stem moves in jumps, so the measurement is a
 * series of flats and steps, and a great deal of the power lands in the odd harmonics. That
 * difference is measurable and it is the cheapest discriminator there is.
 *
 * MEASURED AGAINST THE HARMONICS, NOT AGAINST THE TOTAL VARIANCE. Comparing the fundamental to
 * everything else in the signal seems simpler and is wrong: a loop that is cycling at four
 * seconds while also wandering over ten minutes has most of its variance in the wander, and the
 * fundamental's share of the total says nothing about the shape of the cycle. Comparing it to its
 * own harmonics asks the question that was actually meant.
 *
 * Reference values, which is where the threshold comes from: a pure sine scores 1.00, a triangle
 * 0.99, and a square wave 0.87.
 *
 * @param {Float64Array} y the samples, oldest first
 * @param {number} period_s the oscillation period, s
 * @param {number} sample_s the sample period, s
 * @returns {number} the fundamental's share of the harmonic power, 0..1
 */
export function sinusoidality(y, period_s, sample_s) {
  const samplesPerCycle = period_s / sample_s;
  if (!(samplesPerCycle >= 4) || y.length < 2 * samplesPerCycle) return NaN;
  // Correlate over a WHOLE number of cycles, taken from the most recent end of the window. A
  // fractional cycle leaks power out of every bin and into its neighbours, which would put
  // fundamental power into the harmonics and make a clean sine look distorted.
  const cycles = Math.floor(y.length / samplesPerCycle);
  const n = Math.round(cycles * samplesPerCycle);
  const off = y.length - n;
  const { mean } = moments(y.subarray(off));
  const w0 = (2 * Math.PI) / samplesPerCycle;

  /**
   * Power in one harmonic, by a single-bin discrete Fourier transform.
   * @param {number} k the harmonic number
   * @returns {number} its power
   */
  const bin = (k) => {
    const w = w0 * k;
    if (w >= Math.PI) return 0;                 // above Nyquist: not present, not aliased in
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      re += (y[off + i] - mean) * Math.cos(w * i);
      im += (y[off + i] - mean) * Math.sin(w * i);
    }
    return (re * re + im * im) / (n * n);
  };

  const p1 = bin(1);
  if (!(p1 > 0)) return NaN;
  let harmonics = p1;
  for (let k = 2; k <= 6; k += 1) harmonics += bin(k);
  return clamp(p1 / harmonics, 0, 1);
}

/**
 * Estimate a valve's stickband directly, by measuring how far the controller output has to travel
 * while the measurement is going nowhere.
 *
 * This is the most direct test available and it needs no model. During a stiction limit cycle the
 * process variable stalls completely while the controller winds the output across the deadband;
 * the size of that output excursion IS the stickband, in output percent. Averaging it over
 * several stalls rejects the ones that were merely a quiet moment.
 *
 * @param {Float64Array} u controller output samples
 * @param {Float64Array} y process variable samples
 * @param {Float64Array} e control error samples
 * @param {number} sample_s the sample period, s
 * @param {number} period_s the detected oscillation period, s — the estimator needs to know how
 *   long a stall has to be before it counts as one
 * @returns {{ok:boolean, stickband_pct:number, stalls:number, stallFraction:number}} the estimate
 */
export function estimateStiction(u, y, e, sample_s, period_s) {
  const n = Math.min(u.length, y.length, e.length);
  const blank = { ok: false, stickband_pct: NaN, stalls: 0, stallFraction: 0 };
  if (n < 100 || !(period_s > 0)) return blank;

  // Smooth over a small fraction of the cycle. Without this every plateau is broken up by
  // measurement noise and none of them is long enough to count.
  const win = Math.max(3, Math.round((period_s / 40) / sample_s));
  const ys = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += y[i];
    if (i >= win) acc -= y[i - win];
    ys[i] = acc / Math.min(i + 1, win);
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = win; i < n; i += 1) { lo = Math.min(lo, ys[i]); hi = Math.max(hi, ys[i]); }
  const ptp = hi - lo;
  if (!(ptp > 0)) return blank;

  // A plateau is a maximal run over which the measurement stays inside a narrow band. Defining a
  // stall by LEVEL rather than by slope is what makes this work: during a stiction cycle the
  // measurement is not merely moving slowly, it is not moving at all, and a slope threshold has
  // to be set relative to noise while a level threshold is set relative to the cycle itself.
  const band = 0.15 * ptp;
  const eRms = Math.sqrt(moments(e).variance);
  const minRun = Math.max(4, Math.round((period_s * 0.15) / sample_s));
  const spans = [];
  let stalled = 0;
  let i = win;
  while (i < n) {
    let j = i;
    let a = ys[i];
    let b = ys[i];
    while (j + 1 < n) {
      const na = Math.min(a, ys[j + 1]);
      const nb = Math.max(b, ys[j + 1]);
      if (nb - na > band) break;
      a = na; b = nb; j += 1;
    }
    if (j - i >= minRun) {
      // What the output DID during the stall is what separates a stuck valve from a plateau the
      // process was driven to from outside.
      //
      // When friction is holding the stem, the measurement cannot move, so the error cannot go
      // away, so the integral winds steadily in ONE direction for the whole stall — the output
      // is a ramp, and the distance it covers is the deadband it has to cross before the stem
      // breaks free. When the plateau is instead an external disturbance holding the process
      // somewhere, the loop reaches that somewhere and STOPS: the output settles and what little
      // it does is noise, back and forth.
      //
      // So a stall counts only when the output's net movement is most of its total movement.
      // Both cases have a flat measurement and a wide output range; only one has a ramp.
      let travel = 0;
      let eSum = 0;
      for (let k = i + 1; k <= j; k += 1) travel += Math.abs(u[k] - u[k - 1]);
      for (let k = i; k <= j; k += 1) eSum += e[k];
      const net = Math.abs(u[j] - u[i]);
      const eBar = Math.abs(eSum / (j - i + 1));
      // The measurement must have gone essentially NOWHERE across the whole stall, not merely
      // stayed inside a band. A loop recovering slowly from a load change also spends a long
      // time looking flat and winding its integral one way; what it does not do is fail to move
      // at all while the output crosses several percent. The incremental process gain during a
      // genuine stall is zero, because the valve is not moving.
      const yNet = Math.abs(ys[j] - ys[i]);
      // And the error must STAY away from zero for the whole stall. That is the difference
      // between a valve that will not move and a plateau the process was driven to: if the loop
      // is able to settle back onto setpoint while the measurement is flat, then whatever was
      // holding the measurement flat was not the final element, because the final element
      // evidently got where it was asked to go.
      if (travel > 1e-9 && net / travel > 0.6 && eBar > 0.3 * eRms && yNet < 0.12 * ptp) {
        spans.push(net);
        stalled += j - i + 1;
      }
    }
    i = j + 1;
  }
  if (spans.length < 2) {
    return { ok: false, stickband_pct: NaN, stalls: spans.length, stallFraction: stalled / n };
  }
  spans.sort((a, b) => a - b);
  return {
    ok: true,
    // The median rather than the mean: one plateau interrupted by a setpoint change would drag
    // a mean anywhere, and the quantity wanted is the typical stall, not the average one.
    stickband_pct: spans[Math.floor(spans.length / 2)],
    stalls: spans.length,
    stallFraction: stalled / n,
  };
}

/**
 * Produce the whole loop-health report.
 *
 * @param {object} d the diagnostic window
 * @param {object} opts context the metrics need
 * @param {number} opts.deadTime_s the process dead time, s
 * @param {number} opts.span the loop's engineering-unit span, for normalising the error
 * @param {number} [opts.satFraction] fraction of the window the output spent saturated
 * @param {number} [opts.resetTime_s] the controller's integral time, which is what decides
 *   whether a stiction diagnosis can be made confidently — see the verdict below
 * @returns {object} the report
 */
export function analyse(d, opts) {
  const e = series(d, 'e');
  const u = series(d, 'u');
  const y = series(d, 'y');
  // Cycle hunting runs on a decimated copy so a five-minute limit cycle is inside the search
  // range; the variance and stiction metrics stay on the native samples, where they belong.
  // Decimate to a fixed sample BUDGET rather than to a fixed rate. Autocorrelation costs
  // samples times lags, so a budget bounds the work whatever the window length or scan period,
  // and 1500 samples still resolves a cycle of a few scans as easily as one of several minutes.
  const dec = Math.max(1, Math.ceil(d.n / 1500));
  const osc = detectOscillation(decimate(e, dec), d.period_s * dec);
  const harris = harrisIndex(e, opts.deadTime_s / d.period_s);
  // Waveform shape is measured on the NATIVE samples. Decimation is fine for finding a slow
  // period but it is a low-pass filter, and asking it about the shape of a cycle near its own
  // cut-off gets an answer about the filter rather than about the loop.
  const shape = osc.oscillating ? sinusoidality(y, osc.period_s, d.period_s) : NaN;
  const stick = osc.oscillating
    ? estimateStiction(u, y, e, d.period_s, osc.period_s)
    : { ok: false, stickband_pct: NaN, stalls: 0, stallFraction: 0 };

  let travel = 0;
  let reversals = 0;
  let lastDir = 0;
  for (let i = 1; i < u.length; i += 1) {
    const du = u[i] - u[i - 1];
    travel += Math.abs(du);
    const dir = Math.sign(du);
    if (dir !== 0 && lastDir !== 0 && dir !== lastDir) reversals += 1;
    if (dir !== 0) lastDir = dir;
  }
  const { mean, variance } = moments(e);
  const windowMin = (d.n * d.period_s) / 60;

  // The verdict. Ordered so the most actionable finding wins: a sticking valve is a maintenance
  // job and no amount of tuning helps, so it is checked before the tuning is blamed.
  // Can a stiction diagnosis be made CONFIDENTLY on this loop at all? Only if the loop is quick
  // enough, relative to the cycle it is in, that it would have settled during a half-cycle had
  // nothing been holding it. A loop whose reset time is a large fraction of the cycle period is
  // still crawling toward setpoint throughout each half-cycle, and a crawl looks exactly like a
  // stall: flat measurement, monotone output, persistent error. That is not a defect in the
  // detector, it is a genuine ambiguity in the data, and the honest thing is to say so and name
  // the test that settles it rather than to guess and be confidently wrong half the time.
  const Ti = opts.resetTime_s;
  const separable = !Number.isFinite(Ti) || !(osc.period_s > 0) || Ti < 0.08 * osc.period_s;
  const looksStuck = osc.oscillating && stick.ok && Number.isFinite(shape) && shape < STICTION_SHAPE
    && stick.stickband_pct > 0.4 && stick.stallFraction > 0.35;

  let verdict;
  let advice;
  if (d.n < d.cap * 0.35) {
    verdict = 'gathering data';
    advice = `${Math.round((d.n * d.period_s))} s of history so far; the metrics need a few minutes.`;
  } else if (looksStuck && separable) {
    verdict = 'sticking final element';
    advice = `Cycling at ${osc.period_s.toFixed(0)} s with a distorted waveform and about `
      + `${stick.stickband_pct.toFixed(1)}% of output travel lost in stalls. This is friction, not `
      + 'tuning — detuning will slow the cycle down without making it smaller.';
  } else if (looksStuck && !separable) {
    verdict = 'cycling — cause not yet separable';
    advice = `Cycling at ${osc.period_s.toFixed(0)} s with a distorted waveform, but the reset `
      + `time of ${Ti.toFixed(0)} s is a large share of that period, so this loop would still be `
      + 'crawling toward setpoint through every half cycle even with a perfect valve. A crawl and '
      + 'a stall look the same from here. Two things separate them: put the controller in MANUAL '
      + 'and hold the output — a friction cycle stops dead, a cycle driven from outside carries '
      + 'on — or shorten the reset until the loop can settle inside a half cycle and look again.';
  } else if (osc.oscillating && osc.strength > 0.55) {
    verdict = 'oscillating';
    advice = `Cycling at ${osc.period_s.toFixed(0)} s with a near-sinusoidal waveform. That is a `
      + 'linear instability: lower the gain or lengthen the reset.';
  } else if (Number.isFinite(harris.eta) && harris.eta > 0.65) {
    verdict = 'near the achievable limit';
    advice = `Harris index ${harris.eta.toFixed(2)} — most of the remaining variance is the `
      + 'disturbance arriving through the dead time, which no controller can remove. Retuning '
      + 'this loop would be wasted effort.';
  } else if (Number.isFinite(harris.eta) && harris.eta < 0.3) {
    verdict = 'sluggish';
    advice = `Harris index ${harris.eta.toFixed(2)} — there is a great deal of achievable `
      + 'performance being left on the table. Raise the gain or shorten the reset.';
  } else if (reversals / Math.max(windowMin, 0.1) > 90) {
    verdict = 'excessive output activity';
    advice = `${Math.round(reversals / Math.max(windowMin, 0.1))} output reversals a minute. The `
      + 'loop is chasing measurement noise; filter the measurement or add a deadband.';
  } else {
    verdict = 'satisfactory';
    advice = 'No oscillation, reasonable activity, and a sensible share of the achievable '
      + 'performance.';
  }

  d.report = {
    samples: d.n,
    window_min: windowMin,
    bias: mean,
    variance,
    sd: Math.sqrt(variance),
    /** Error standard deviation as a percentage of the loop's span. The headline number. */
    sdPct: opts.span > 0 ? (100 * Math.sqrt(variance)) / opts.span : NaN,
    oscillating: osc.oscillating,
    period_s: osc.period_s,
    strength: osc.strength,
    sinusoidality: shape,
    stiction: stick,
    harris: harris.eta,
    harrisOk: harris.ok,
    travel,
    reversals,
    reversalsPerMin: reversals / Math.max(windowMin, 1e-6),
    satFraction: opts.satFraction,
    verdict,
    advice,
  };
  d.sinceReport = 0;
  return d.report;
}

/**
 * Clear a diagnostic window.
 * @param {object} d the window (mutated)
 * @returns {void}
 */
export function resetDiagnostics(d) {
  d.n = 0;
  d.head = 0;
  d.report = null;
  d.sinceReport = 0;
}
