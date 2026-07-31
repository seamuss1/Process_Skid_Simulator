/**
 * src/analytics/peaks.js — moments, Savitzky–Golay smoothing, uniform-volume resampling,
 * peak detection and resolution. One pipeline, ONE grid (architecture-v2 §6.19, §5.11.1).
 *
 * Layer L1: imports `core/util.js` and nothing else. No DOM, no `window`, no `document`.
 *
 * UNITS (architecture-v2 §1). Every volume is mL, every absorbance on this path is the
 * path-normalised AU/cm, every slope is per mL, every length is cm. The uniform grid carries
 * `V` in mL and `y` in AU/cm; the source log channel is `UV_280_mAU` and is divided by
 * `1000 * config.skid.uv.pathlength_cm` on the way in.
 *
 * ALLOCATION. Everything here runs at operator rate (peak-table refresh, export, tests), where
 * §13 item 5 explicitly permits allocation. Nothing in this file is reachable from `physicsTick`.
 */

import { clamp } from '../core/util.js';

/** The one source channel of THE grid (§6.19). Do not parameterise it. */
const SOURCE_CHANNEL = 'UV_280_mAU';

/** Grid spacing rule (§6.19): 2000 points per column volume. */
const GRID_POINTS_PER_CV = 2000;

/** Compendial half-height plate constant (§5.11.1). NOT 8*ln2 = 5.5451774. */
const N_HALF_CONST = 5.54;

/** Foley–Dorsey exponentially-modified-Gaussian plate constant. */
const N_FOLEY_CONST = 41.7;

const ZERO_BASELINE = () => 0;

/* -------------------------------------------------------------------------- */
/* Compensated summation and integration                                      */
/* -------------------------------------------------------------------------- */

/**
 * Neumaier (improved Kahan) compensated summation.
 *
 * @param {ArrayLike<number>} values - the terms to add (any unit; the unit of the result is the
 *   unit of the terms).
 * @param {number} n - number of leading elements of `values` to sum.
 * @returns {number} the sum, in the unit of `values`.
 */
export function neumaierSum(values, n) {
  let sum = 0;
  let comp = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const t = sum + v;
    if (Math.abs(sum) >= Math.abs(v)) comp += (sum - t) + v;
    else comp += (v - t) + sum;
    sum = t;
  }
  return sum + comp;
}

/** Baseline-corrected sample height at index k. */
function heightAt(V_mL, y, k, baselineFn) {
  return baselineFn ? y[k] - baselineFn(V_mL[k]) : y[k];
}

/**
 * Trapezoidal area of a baseline-corrected trace between two sample indices, Neumaier-compensated.
 *
 * @param {ArrayLike<number>} V_mL - abscissa, mL, non-decreasing.
 * @param {ArrayLike<number>} y - ordinate, AU/cm (or any per-volume signal unit).
 * @param {number} i0 - first sample index (inclusive).
 * @param {number} i1 - last sample index (inclusive). Swapped with `i0` when reversed.
 * @param {((V_mL:number)=>number)|null} baselineFn - baseline in the unit of `y`; null/undefined
 *   means a zero baseline.
 * @returns {number} area in (unit of `y`)·mL, e.g. AU/cm·mL. 0 when the window holds < 2 samples.
 */
export function trapzArea(V_mL, y, i0, i1, baselineFn) {
  let a = i0 | 0;
  let b = i1 | 0;
  if (b < a) { const t = a; a = b; b = t; }
  if (b <= a) return 0;
  let sum = 0;
  let comp = 0;
  let fPrev = heightAt(V_mL, y, a, baselineFn);
  for (let k = a + 1; k <= b; k++) {
    const fk = heightAt(V_mL, y, k, baselineFn);
    const term = 0.5 * (fPrev + fk) * (V_mL[k] - V_mL[k - 1]);
    const t = sum + term;
    if (Math.abs(sum) >= Math.abs(term)) comp += (sum - t) + term;
    else comp += (term - t) + sum;
    sum = t;
    fPrev = fk;
  }
  return sum + comp;
}

/**
 * Statistical moments of a baseline-corrected peak, integrated on the volume axis.
 *
 * @param {ArrayLike<number>} V_mL - abscissa, mL, non-decreasing.
 * @param {ArrayLike<number>} y - ordinate, AU/cm.
 * @param {number} i0 - first sample index (inclusive).
 * @param {number} i1 - last sample index (inclusive).
 * @param {((V_mL:number)=>number)|null} baselineFn - baseline in the unit of `y`; null = zero.
 * @returns {{area:number, mu1:number, mu2:number, mu3:number, sigma:number, skew:number}}
 *   `area` AU/cm·mL, `mu1` mL (first moment = centre of gravity), `mu2` mL² (second CENTRAL
 *   moment), `mu3` mL³ (third central moment), `sigma` mL (= sqrt(mu2)), `skew` dimensionless
 *   (= mu3/mu2^1.5). Every moment is NaN when `area <= 0`.
 */
export function moments(V_mL, y, i0, i1, baselineFn) {
  let a = i0 | 0;
  let b = i1 | 0;
  if (b < a) { const t = a; a = b; b = t; }
  const area = trapzArea(V_mL, y, a, b, baselineFn);
  const out = { area, mu1: NaN, mu2: NaN, mu3: NaN, sigma: NaN, skew: NaN };
  if (!(area > 0) || b <= a) return out;

  // First moment.
  let s1 = 0;
  let fPrev = heightAt(V_mL, y, a, baselineFn) * V_mL[a];
  for (let k = a + 1; k <= b; k++) {
    const fk = heightAt(V_mL, y, k, baselineFn) * V_mL[k];
    s1 += 0.5 * (fPrev + fk) * (V_mL[k] - V_mL[k - 1]);
    fPrev = fk;
  }
  const mu1 = s1 / area;

  // Second and third CENTRAL moments, one pass.
  let s2 = 0;
  let s3 = 0;
  let d = V_mL[a] - mu1;
  let g2Prev = heightAt(V_mL, y, a, baselineFn) * d * d;
  let g3Prev = g2Prev * d;
  for (let k = a + 1; k <= b; k++) {
    d = V_mL[k] - mu1;
    const h = heightAt(V_mL, y, k, baselineFn);
    const g2 = h * d * d;
    const g3 = g2 * d;
    const dV = V_mL[k] - V_mL[k - 1];
    s2 += 0.5 * (g2Prev + g2) * dV;
    s3 += 0.5 * (g3Prev + g3) * dV;
    g2Prev = g2;
    g3Prev = g3;
  }
  const mu2 = s2 / area;
  const mu3 = s3 / area;
  out.mu1 = mu1;
  out.mu2 = mu2;
  out.mu3 = mu3;
  out.sigma = mu2 > 0 ? Math.sqrt(mu2) : NaN;
  out.skew = mu2 > 0 ? mu3 / Math.pow(mu2, 1.5) : NaN;
  return out;
}

/** Numerical-Recipes `erfcc`; fractional error everywhere below 1.2e-7. */
function erfcApprox(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? ans : 2 - ans;
}

/** Upper standard-normal tail Q(u) = P(Z > u). */
function normalTail(u) {
  return 0.5 * erfcApprox(u / Math.SQRT2);
}

/**
 * Fraction of a peak's true area lost by truncating the integration window at `i0`/`i1`.
 *
 * The contract fixes the argument list (`y`, `i0`, `i1`, `area`, `sigma`) and therefore fixes the
 * model: the peak is treated as Gaussian, so its apex height is `area/(sigma*sqrt(2*PI))`, the
 * endpoint height `h` sits `u = sqrt(2*ln(h_apex/h))` standard deviations from the centre, and the
 * area beyond it is the standard-normal upper tail `Q(u)`. Both ends are summed. This is the only
 * reading that uses every declared argument and returns 0 for a fully-captured peak; it is
 * recorded here rather than re-derived at each call site.
 *
 * @param {ArrayLike<number>} y - BASELINE-CORRECTED trace, AU/cm.
 * @param {number} i0 - left window index.
 * @param {number} i1 - right window index.
 * @param {number} area - integrated peak area over the window, AU/cm·mL.
 * @param {number} sigma - peak standard deviation, mL.
 * @returns {number} truncated fraction, dimensionless 0..1; NaN when `area` or `sigma` is not
 *   strictly positive and finite.
 */
export function truncFraction(y, i0, i1, area, sigma) {
  if (!(area > 0) || !(sigma > 0) || !Number.isFinite(area) || !Number.isFinite(sigma)) return NaN;
  const hApex = area / (sigma * Math.sqrt(2 * Math.PI));
  if (!(hApex > 0)) return NaN;
  let total = 0;
  const ends = [y[i0], y[i1]];
  for (let e = 0; e < 2; e++) {
    const h = ends[e];
    if (!(h > 0)) continue;              // at or below baseline: nothing beyond this end
    if (h >= hApex) { total += 0.5; continue; }
    const u = Math.sqrt(2 * Math.log(hApex / h));
    total += normalTail(u);
  }
  return clamp(total, 0, 1);
}

/* -------------------------------------------------------------------------- */
/* Savitzky–Golay kernels — COMPLETE, shape { c, d } (§6.19)                   */
/* -------------------------------------------------------------------------- */

/** Smoothing kernels: y_smooth[k] = SUM(c_j * y[k+j-h]) / d. */
export const SG_SMOOTH = {
  5: { c: [-3, 12, 17, 12, -3], d: 35 },
  7: { c: [-2, 3, 6, 7, 6, 3, -2], d: 21 },
  9: { c: [-21, 14, 39, 54, 59, 54, 39, 14, -21], d: 231 },
};

/** First-derivative kernels: dy/dV = SUM(c_j * y[k+j-h]) / (d * dV_mL). */
export const SG_D1 = {
  5: { c: [-2, -1, 0, 1, 2], d: 10 },
  7: { c: [-3, -2, -1, 0, 1, 2, 3], d: 28 },
  9: { c: [-4, -3, -2, -1, 0, 1, 2, 3, 4], d: 60 },
};

/** Second-derivative kernel, 7 points only: d2y/dV2 = SUM(c_j * y[...]) / (d * dV_mL^2). */
export const SG_D2_7 = { c: [5, 0, -3, -4, -3, 0, 5], d: 42 };

/* -------------------------------------------------------------------------- */
/* Resampling and THE grid                                                     */
/* -------------------------------------------------------------------------- */

let _ySrcScratch = null;
let _smoothScratch = null;

function ensureF64(buf, n) {
  if (buf && buf.length >= n) return buf;
  return new Float64Array(Math.max(n, 16));
}

/**
 * Resample a time-keyed trace onto a uniform VOLUME grid by one O(n) forward linear interpolation.
 *
 * `outV[k] = V_mL[0] + k*dV_mL`, so two calls made with the same `V_mL` and the same `dV_mL`
 * produce index-aligned outputs — which is what lets `analytics/pooling.js` overlay conductivity,
 * pH and the truth channels on the grid built from UV.
 *
 * @param {ArrayLike<number>} V_mL - source abscissa, mL, non-decreasing (`run.log`'s `V_mL`).
 * @param {ArrayLike<number>} y - source ordinate, any unit.
 * @param {number} n - number of valid source samples.
 * @param {number} dV_mL - uniform grid spacing, mL, > 0.
 * @param {Float64Array} outV - caller-owned output abscissa, mL.
 * @param {Float64Array} outY - caller-owned output ordinate, unit of `y`.
 * @returns {number} the sample count written (<= min(outV.length, outY.length)).
 */
export function resampleUniformV(V_mL, y, n, dV_mL, outV, outY) {
  if (!(n > 0) || !(dV_mL > 0)) return 0;
  const capacity = Math.min(outV.length, outY.length);
  if (capacity < 1) return 0;
  const V0 = V_mL[0];
  if (n === 1) { outV[0] = V0; outY[0] = y[0]; return 1; }
  const span = V_mL[n - 1] - V0;
  let count = Number.isFinite(span) && span > 0 ? Math.floor(span / dV_mL) + 1 : 1;
  if (count > capacity) count = capacity;
  let j = 0;
  for (let k = 0; k < count; k++) {
    const Vt = V0 + k * dV_mL;
    while (j < n - 2 && V_mL[j + 1] < Vt) j++;
    const Va = V_mL[j];
    const Vb = V_mL[j + 1];
    const d = Vb - Va;
    let t = d > 0 ? (Vt - Va) / d : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    outV[k] = Vt;
    outY[k] = y[j] + (y[j + 1] - y[j]) * t;
  }
  return count;
}

/** Read a channel of a `core/log.js` ChannelStore without importing it (peaks.js is L1). */
function storeColumn(store, name) {
  if (!store || !store.index || !store.index.has(name)) return null;
  const k = store.index.get(name);
  const col = store.cols[k];
  if (!col) return null;
  return col.subarray(0, store.n);
}

/**
 * Build (or reuse) THE uniform-volume grid — the single object `analytics/peaks.js`,
 * `analytics/pooling.js` and `ui/view_results.js` all index into (§6.19).
 *
 * This function is the SOLE writer of `run.grid`. It is a cache, never simulation state: nothing
 * in the physics path reads or writes it, and `core/state.js` leaves it null.
 *
 * Spacing and source are rules, not preferences:
 *   `dV_mL  = config.column.V_mL / 2000`
 *   `channel = 'UV_280_mAU'`, converted to AU/cm as `mAU/1000/config.skid.uv.pathlength_cm`
 *   `V[k]   = V0 + k*dV_mL`, `V0` = the first logged `V_mL`
 *
 * @param {object} config - frozen config (§2.1); reads `column.V_mL` and `skid.uv.pathlength_cm`.
 * @param {object} run - mutable run state (§2.2); reads `run.log`, writes `run.grid`.
 * @returns {{V:Float64Array, y:Float64Array, n:number, dV_mL:number, channel:string,
 *   builtAtRow:number}} `V` mL, `y` AU/cm, `n` valid sample count (buffers may be longer),
 *   `dV_mL` mL, `builtAtRow` the `run.log.n` the grid was built at.
 */
export function buildVolumeGrid(config, run) {
  const dV_mL = config.column.V_mL / GRID_POINTS_PER_CV;
  const store = run.log;
  const logN = store && store.n ? store.n : 0;

  let g = run.grid;
  if (!g) {
    g = { V: new Float64Array(1), y: new Float64Array(1), n: 0, dV_mL, channel: SOURCE_CHANNEL, builtAtRow: -1 };
    run.grid = g;
  }
  if (g.builtAtRow === logN && g.dV_mL === dV_mL && g.channel === SOURCE_CHANNEL) return g;

  g.dV_mL = dV_mL;
  g.channel = SOURCE_CHANNEL;

  const Vsrc = storeColumn(store, 'V_mL');
  const Asrc = storeColumn(store, SOURCE_CHANNEL);
  if (!Vsrc || !Asrc || logN < 1 || !(dV_mL > 0)) {
    g.n = 0;
    g.builtAtRow = logN;
    return g;
  }

  // mAU -> AU/cm, once, on the way in.
  const path_cm = (config.skid && config.skid.uv && config.skid.uv.pathlength_cm) || 1;
  const scale = 1 / (1000 * path_cm);
  _ySrcScratch = ensureF64(_ySrcScratch, logN);
  for (let k = 0; k < logN; k++) _ySrcScratch[k] = Asrc[k] * scale;

  const span = Vsrc[logN - 1] - Vsrc[0];
  let want = Number.isFinite(span) && span > 0 ? Math.floor(span / dV_mL) + 1 : 1;
  if (want < 1) want = 1;
  if (g.V.length < want) {
    const cap = Math.ceil(want * 1.25) + 8;
    g.V = new Float64Array(cap);
    g.y = new Float64Array(cap);
  }
  g.n = resampleUniformV(Vsrc, _ySrcScratch, logN, dV_mL, g.V, g.y);
  g.builtAtRow = logN;
  return g;
}

/* -------------------------------------------------------------------------- */
/* Smoothing and derivatives                                                   */
/* -------------------------------------------------------------------------- */

function normaliseM(m) {
  return (m === 5 || m === 7 || m === 9) ? m : 7;
}

function sgPass(src, n, kernel, dst) {
  const c = kernel.c;
  const inv = 1 / kernel.d;
  const h = (c.length - 1) >> 1;
  for (let k = 0; k < n; k++) {
    if (k < h || k >= n - h) { dst[k] = src[k]; continue; }   // edges: pass the sample through
    let s = 0;
    for (let j = 0; j < c.length; j++) s += c[j] * src[k + j - h];
    dst[k] = s * inv;
  }
}

/**
 * Repeated Savitzky–Golay smoothing.
 *
 * Edge policy: the `(m-1)/2` samples at each end are copied through unsmoothed — the SG window does
 * not fit there and extrapolating one would invent peak shape at exactly the place a truncated peak
 * is measured.
 *
 * @param {ArrayLike<number>} y - input trace, AU/cm.
 * @param {number} n - valid sample count.
 * @param {5|7|9} m - kernel width in samples (anything else is treated as 7).
 * @param {number} passes - number of repeated applications; 0 copies the input.
 * @param {Float64Array} out - caller-owned output, AU/cm. May alias `y`.
 * @returns {void}
 */
export function smooth(y, n, m, passes, out) {
  const mm = normaliseM(m);
  const kernel = SG_SMOOTH[mm];
  const p = Math.max(0, passes | 0);
  if (p === 0) {
    for (let k = 0; k < n; k++) out[k] = y[k];
    return;
  }
  sgPass(y, n, kernel, out);
  if (p === 1) return;
  _smoothScratch = ensureF64(_smoothScratch, n);
  for (let i = 1; i < p; i++) {
    sgPass(out, n, kernel, _smoothScratch);
    for (let k = 0; k < n; k++) out[k] = _smoothScratch[k];
  }
}

/**
 * Savitzky–Golay first derivative on a uniform volume grid.
 *
 * Edge policy: one-sided finite differences in the `(m-1)/2` samples at each end.
 *
 * @param {ArrayLike<number>} y - input trace, AU/cm.
 * @param {number} n - valid sample count.
 * @param {5|7|9} m - kernel width in samples (anything else is treated as 7).
 * @param {number} dV_mL - uniform grid spacing, mL.
 * @param {Float64Array} out - caller-owned output, AU/cm PER mL.
 * @returns {void}
 */
export function derivative1(y, n, m, dV_mL, out) {
  const kernel = SG_D1[normaliseM(m)];
  const c = kernel.c;
  const h = (c.length - 1) >> 1;
  const inv = 1 / (kernel.d * dV_mL);
  if (n < 2) { for (let k = 0; k < n; k++) out[k] = 0; return; }
  for (let k = 0; k < n; k++) {
    if (k < h) { out[k] = (y[k + 1] - y[k]) / dV_mL; continue; }
    if (k >= n - h) { out[k] = (y[k] - y[k - 1]) / dV_mL; continue; }
    let s = 0;
    for (let j = 0; j < c.length; j++) s += c[j] * y[k + j - h];
    out[k] = s * inv;
  }
}

/**
 * Savitzky–Golay second derivative, 7-point kernel only (`SG_D2_7`).
 *
 * Edge policy: the three samples at each end take the nearest interior value.
 *
 * @param {ArrayLike<number>} y - input trace, AU/cm.
 * @param {number} n - valid sample count.
 * @param {number} dV_mL - uniform grid spacing, mL.
 * @param {Float64Array} out - caller-owned output, AU/cm PER mL².
 * @returns {void}
 */
export function derivative2(y, n, dV_mL, out) {
  const c = SG_D2_7.c;
  const h = 3;
  const inv = 1 / (SG_D2_7.d * dV_mL * dV_mL);
  if (n < 7) { for (let k = 0; k < n; k++) out[k] = 0; return; }
  for (let k = h; k < n - h; k++) {
    let s = 0;
    for (let j = 0; j < 7; j++) s += c[j] * y[k + j - h];
    out[k] = s * inv;
  }
  for (let k = 0; k < h; k++) out[k] = out[h];
  for (let k = n - h; k < n; k++) out[k] = out[n - h - 1];
}

/**
 * Choose the Savitzky–Golay window and pass count for an expected peak width.
 *
 * `m` is consumed by BOTH `smooth` and `derivative1`. The rule: `P` = samples across the expected
 * half-height width; below 6 samples nothing may be smoothed at all (`passes: 0`), otherwise the
 * kernel grows with `P` and the pass count keeps the effective span near `P/6`, capped so a very
 * finely-sampled grid cannot spend unbounded time smoothing an already-filtered trace.
 *
 * @param {number} WhalfExpected_mL - expected width at half height, mL.
 * @param {number} dV_mL - uniform grid spacing, mL.
 * @returns {{m:5|7|9, passes:number}} kernel width in samples and repeat count.
 */
export function selectWindow(WhalfExpected_mL, dV_mL) {
  const P = WhalfExpected_mL / dV_mL;
  if (!Number.isFinite(P) || P < 6) return { m: 5, passes: 0 };
  const m = P >= 36 ? 9 : P >= 20 ? 7 : 5;
  const passes = clamp(Math.round(P / (6 * m)), 1, 12);
  return { m, passes };
}

/* -------------------------------------------------------------------------- */
/* Apex, widths, baseline                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Sub-sample apex refinement by three-point parabolic interpolation, with flat-apex detection.
 *
 * @param {ArrayLike<number>} V_mL - abscissa, mL.
 * @param {ArrayLike<number>} yRaw - BASELINE-CORRECTED trace, AU/cm (the raw trace, not the
 *   smoothed one — §5.11.1 measures on the raw).
 * @param {number} i - the sample index of the apex.
 * @returns {{VR_mL:number, Amax_AUcm:number, flatApex:boolean}} retention volume mL, apex height
 *   AU/cm, and whether the apex is a plateau or has vanishing curvature.
 */
export function refineApex(V_mL, yRaw, i) {
  const yi = yRaw[i];
  const tol = 1e-9 * Math.max(1, Math.abs(yi));

  // Plateau scan: equal neighbours on either side.
  let lo = i;
  let hi = i;
  while (lo > 0 && Math.abs(yRaw[lo - 1] - yi) <= tol) lo--;
  const nMax = V_mL.length;
  while (hi + 1 < nMax && Math.abs(yRaw[hi + 1] - yi) <= tol) hi++;
  if (hi > lo) {
    return { VR_mL: 0.5 * (V_mL[lo] + V_mL[hi]), Amax_AUcm: yi, flatApex: true };
  }

  if (i <= 0 || i >= nMax - 1) {
    return { VR_mL: V_mL[i], Amax_AUcm: yi, flatApex: false };
  }
  const ym = yRaw[i - 1];
  const yp = yRaw[i + 1];
  const denom = ym - 2 * yi + yp;
  if (!(Math.abs(denom) > tol)) {
    return { VR_mL: V_mL[i], Amax_AUcm: yi, flatApex: true };
  }
  let delta = 0.5 * (ym - yp) / denom;
  delta = clamp(delta, -1, 1);
  const step = V_mL[i + 1] - V_mL[i];
  return {
    VR_mL: V_mL[i] + delta * step,
    Amax_AUcm: yi - 0.25 * (ym - yp) * delta,
    flatApex: false,
  };
}

/**
 * Width of a peak at a fraction of its apex height, measured on the BASELINE-CORRECTED trace by
 * searching OUTWARD from the apex and taking the FIRST crossing on each side. A missing crossing
 * returns NaN — never a guess (§5.11.1).
 *
 * @param {ArrayLike<number>} V_mL - abscissa, mL.
 * @param {ArrayLike<number>} y - baseline-corrected trace, AU/cm.
 * @param {number} iApex - apex sample index.
 * @param {number} i0 - left search bound (inclusive).
 * @param {number} i1 - right search bound (inclusive).
 * @param {number} fraction - height fraction, 0..1 (0.5 = half height).
 * @returns {{left_mL:number, right_mL:number, width_mL:number}} crossing volumes and their
 *   difference, all mL; any unreachable crossing is NaN and propagates into `width_mL`.
 */
export function widthAt(V_mL, y, iApex, i0, i1, fraction) {
  const h = y[iApex] * fraction;
  let left_mL = NaN;
  let right_mL = NaN;
  for (let k = iApex; k > i0; k--) {
    if (y[k - 1] <= h) {
      const ya = y[k - 1];
      const yb = y[k];
      const d = yb - ya;
      const t = Math.abs(d) > 0 ? (h - ya) / d : 0;
      left_mL = V_mL[k - 1] + clamp(t, 0, 1) * (V_mL[k] - V_mL[k - 1]);
      break;
    }
  }
  for (let k = iApex; k < i1; k++) {
    if (y[k + 1] <= h) {
      const ya = y[k];
      const yb = y[k + 1];
      const d = ya - yb;
      const t = Math.abs(d) > 0 ? (ya - h) / d : 0;
      right_mL = V_mL[k] + clamp(t, 0, 1) * (V_mL[k + 1] - V_mL[k]);
      break;
    }
  }
  return { left_mL, right_mL, width_mL: right_mL - left_mL };
}

/**
 * A baseline anchored at the two window endpoints.
 *
 * The declared signature carries the endpoint HEIGHTS but not the endpoint VOLUMES, and the
 * returned closure is called with a volume. With the optional fourth argument (`V_mL`, which
 * `detectPeaks` always supplies) the closure is the exact tilted line through both anchors; called
 * with three arguments it falls back to a LEVEL baseline at the mean of the two anchor heights,
 * because a tilted line through two points whose abscissae are unknown cannot be constructed. The
 * choice is recorded here rather than guessed at each call site.
 *
 * @param {ArrayLike<number>} y - trace, AU/cm.
 * @param {number} iStart - left anchor index.
 * @param {number} iEnd - right anchor index.
 * @param {ArrayLike<number>} [V_mL] - optional abscissa, mL; enables the tilted baseline.
 * @returns {(V_mL:number)=>number} baseline height in AU/cm at a given volume in mL.
 */
export function anchoredBaseline(y, iStart, iEnd, V_mL) {
  const y0 = y[iStart];
  const y1 = y[iEnd];
  if (!V_mL || iEnd === iStart) {
    const level = 0.5 * (y0 + y1);
    return () => level;
  }
  const V0 = V_mL[iStart];
  const V1 = V_mL[iEnd];
  const dV = V1 - V0;
  if (!(Math.abs(dV) > 0)) {
    const level = 0.5 * (y0 + y1);
    return () => level;
  }
  const slope = (y1 - y0) / dV;
  return (V) => y0 + slope * (V - V0);
}

/* -------------------------------------------------------------------------- */
/* Peak detection                                                              */
/* -------------------------------------------------------------------------- */

let _ycScratch = null;

/** Apex runs of `y` over [0,n): rising edge, optional flat top, falling edge. */
function findApexes(y, n) {
  const apexes = [];
  let k = 1;
  while (k < n - 1) {
    if (y[k] > y[k - 1]) {
      const tol = 1e-9 * Math.max(1, Math.abs(y[k]));
      let j = k;
      while (j < n - 1 && Math.abs(y[j + 1] - y[k]) <= tol) j++;
      if (j < n - 1 && y[j + 1] < y[k]) apexes.push((k + j) >> 1);
      k = j + 1;
    } else {
      k++;
    }
  }
  return apexes;
}

function argMin(y, a, b) {
  let best = a;
  for (let k = a + 1; k <= b; k++) if (y[k] < y[best]) best = k;
  return best;
}

/**
 * TOPOGRAPHIC prominence of the apex at `i` — the apex height above the higher of its two key
 * cols, where a key col is the lowest point reached walking outward until a sample STRICTLY
 * HIGHER than the apex (or the end of the trace) is met.
 *
 * NOT the drop to the two perpendicular-drop valleys that bound the integration window. Those
 * valleys are the minima to the IMMEDIATELY ADJACENT apexes, so every fragment of a group that
 * shares one summit — the ripples on a saturated flat top, the shoulders of a fused pair, the
 * chatter on a noisy apex — measures its own height against a neighbour of the SAME height and
 * scores ~0. Under the §2.4 default `p_min` that deletes the whole group, including the tallest
 * member: a detector-clipped peak of true prominence 0.5 AU/cm (25x `p_min`) came back as zero
 * peaks, and so did the 1.0 AU/cm apex of a 0.3 %-noise trace. §4.3 mitigation 5 requires the
 * clipped peak to be REPORTED (flat-topped and flagged), which is only possible if the gate
 * measures the summit against the baseline it actually stands on.
 *
 * The window-relative drop is still the right quantity for the SUSPECT flag — "this apex is not
 * well separated from its neighbour" — and `detectPeaks` keeps computing it for exactly that.
 *
 * @param {ArrayLike<number>} y - the smoothed trace.
 * @param {number} n - sample count.
 * @param {number} i - apex index.
 * @returns {number} prominence in the units of `y` (>= 0).
 */
function prominenceAt(y, n, i) {
  const h = y[i];
  let leftCol = h;
  for (let k = i - 1; k >= 0; k--) {
    if (y[k] > h) break;
    if (y[k] < leftCol) leftCol = y[k];
  }
  let rightCol = h;
  for (let k = i + 1; k < n; k++) {
    if (y[k] > h) break;
    if (y[k] < rightCol) rightCol = y[k];
  }
  return h - (leftCol > rightCol ? leftCol : rightCol);
}

/**
 * Detect and fully characterise peaks on THE uniform-volume grid.
 *
 * Detection runs on `ySmooth`/`dySmooth`; every MEASUREMENT (area, moments, widths, apex) runs on
 * the baseline-corrected RAW trace `grid.y`, per §5.11.1. Peak boundaries are the perpendicular-drop
 * valleys between adjacent apexes, which is what splits a fused pair; `s_on`/`s_off` qualify a
 * candidate rather than move its boundaries, so a boundary is always a real minimum of the trace.
 *
 * @param {object} config - frozen config; reads `column.L_cm`, `column.dp_cm`,
 *   `skid.uv.pathlength_cm`.
 * @param {{V:Float64Array, y:Float64Array, n:number, dV_mL:number}} grid - the
 *   `buildVolumeGrid` product. Indices in the returned peaks index `grid.V`.
 * @param {ArrayLike<number>} ySmooth - smoothed trace, AU/cm, at least `grid.n` long.
 * @param {ArrayLike<number>} dySmooth - its first derivative, AU/cm PER mL.
 * @param {{A_on_AUcm?:number, f_on?:number, s_on?:number, s_off?:number, p_min?:number,
 *   w_min?:number, path_cm?:number, baseline?:'zero'|'anchored'}} [opts] - `A_on_AUcm` absolute
 *   apex-height gate (AU/cm); `f_on` apex-height gate as a fraction of the tallest peak;
 *   `s_on` minimum leading slope (AU/cm per mL); `s_off` trailing slope that must be reached
 *   (magnitude is used, sign is forced negative); `p_min` minimum TOPOGRAPHIC prominence (AU/cm,
 *   see `prominenceAt`); `w_min` minimum peak equivalent width `area / A_max` (mL — the §2.4
 *   spike rejector; it is NOT the span of the integration window); `path_cm` flow-cell
 *   pathlength (cm, reporting only); `baseline` integration baseline.
 * @returns {Array<object>} Peak objects per §5.11.1, ascending in `VR_mL`. Volumes mL, heights
 *   AU/cm, areas AU/cm·mL, `mu2_mL2` mL², `HETP_cm` cm, plate counts and flags dimensionless.
 *   `prominence_AUcm` is the topographic prominence the `p_min` gate was applied to (AU/cm), and
 *   is reported so an operator can see why a shoulder was or was not kept.
 */
export function detectPeaks(config, grid, ySmooth, dySmooth, opts) {
  const o = opts || {};
  const n = grid.n | 0;
  const out = [];
  if (n < 5) return out;

  const V = grid.V;
  const yRaw = grid.y;
  const A_on = o.A_on_AUcm !== undefined ? o.A_on_AUcm : 0.02;
  const f_on = o.f_on !== undefined ? o.f_on : 0.005;
  const s_on = o.s_on !== undefined ? o.s_on : 0;
  const s_off = -Math.abs(o.s_off !== undefined ? o.s_off : 0);
  const p_min = o.p_min !== undefined ? o.p_min : 0;
  const w_min = o.w_min !== undefined ? o.w_min : 0;
  const baselineMode = o.baseline === 'zero' ? 'zero' : 'anchored';
  const L_cm = (config && config.column && config.column.L_cm) || NaN;
  const dp_cm = (config && config.column && config.column.dp_cm) || NaN;

  const apexes = findApexes(ySmooth, n);
  if (apexes.length === 0) return out;

  let globalMax = -Infinity;
  for (let a = 0; a < apexes.length; a++) if (ySmooth[apexes[a]] > globalMax) globalMax = ySmooth[apexes[a]];
  const heightGate = Math.max(A_on, f_on * globalMax);

  _ycScratch = ensureF64(_ycScratch, n);

  // TWO STAGES, and the order matters. The height and prominence gates are properties of the
  // apex and the trace alone, so they are applied FIRST; the perpendicular-drop boundaries are
  // then drawn between the apexes that survived. Drawing the boundaries against every raw apex
  // instead would let a rejected one cut a real peak's integration window in half — apex chatter
  // on a 0.3 %-noise trace does exactly that, and halves the reported area of the product peak.
  const kept = [];
  const proms = [];
  for (let a = 0; a < apexes.length; a++) {
    const iApex = apexes[a];
    if (!(ySmooth[iApex] >= heightGate)) continue;
    const prom = prominenceAt(ySmooth, n, iApex);
    if (!(prom >= p_min)) continue;
    kept.push(iApex);
    proms.push(prom);
  }

  for (let a = 0; a < kept.length; a++) {
    const iApex = kept[a];
    const leftLimit = a === 0 ? 0 : kept[a - 1];
    const rightLimit = a === kept.length - 1 ? n - 1 : kept[a + 1];
    const iStart = argMin(ySmooth, leftLimit, iApex);
    const iEnd = argMin(ySmooth, iApex, rightLimit);
    if (iEnd - iStart < 3) continue;

    // TWO DIFFERENT QUANTITIES, deliberately. `prominence_AUcm` is topographic (see
    // `prominenceAt`) and is what `p_min` gated above; `windowDrop` is the drop to the two
    // perpendicular-drop valleys that bound the integration window, and is what SUSPECT is about.
    const prominence_AUcm = proms[a];
    const windowDrop = ySmooth[iApex] - Math.max(ySmooth[iStart], ySmooth[iEnd]);

    let maxRise = -Infinity;
    for (let k = iStart; k <= iApex; k++) if (dySmooth[k] > maxRise) maxRise = dySmooth[k];
    let minFall = Infinity;
    for (let k = iApex; k <= iEnd; k++) if (dySmooth[k] < minFall) minFall = dySmooth[k];
    if (!(maxRise >= s_on) || !(minFall <= s_off)) continue;

    const baselineFn = baselineMode === 'zero'
      ? ZERO_BASELINE
      : anchoredBaseline(yRaw, iStart, iEnd, V);
    for (let k = iStart; k <= iEnd; k++) _ycScratch[k] = yRaw[k] - baselineFn(V[k]);
    const yc = _ycScratch;

    const apexInfo = refineApex(V, yc, iApex);
    const VR_mL = apexInfo.VR_mL;
    const Amax_AUcm = apexInfo.Amax_AUcm;

    const mom = moments(V, yRaw, iStart, iEnd, baselineFn);

    // THE w_min GATE, on the width of the PEAK — not on the span of the window that contains it.
    // §2.4 sets `w_min = 5 x dV_log` expressly to reject spikes (bubbles), and the window span
    // cannot do that job: an isolated one-sample spike is smoothed into side lobes that make its
    // perpendicular-drop window 0.160 mL wide, sixteen times the 0.05 mL default, so the gate
    // never fired at its documented setting. The measure used instead is the EQUIVALENT WIDTH
    // `area / A_max` — the width of the rectangle of the same area and height, taken off the
    // baseline-corrected RAW trace as §5.11.1 requires every measurement to be. It is 0.0100 mL
    // for the one-sample spike (exactly one sample, which is what "spike" means) against
    // 5.013 mL for a sigma = 2 mL Gaussian, and unlike W_50 it is always defined: a truncated,
    // fused or flat-topped peak has no half-height crossing but still has an area and a height,
    // and none of those may be silently dropped by a width gate.
    const wEq_mL = (Amax_AUcm > 0) ? mom.area / Amax_AUcm : 0;
    if (w_min > 0 && !(wEq_mL >= w_min)) continue;

    const w50 = widthAt(V, yc, iApex, iStart, iEnd, 0.5);
    const w10 = widthAt(V, yc, iApex, iStart, iEnd, 0.1);
    const w05 = widthAt(V, yc, iApex, iStart, iEnd, 0.05);

    // Tangent construction: extrapolate the inflection tangents to the (corrected) baseline.
    let iInflL = iStart;
    for (let k = iStart; k <= iApex; k++) if (dySmooth[k] > dySmooth[iInflL]) iInflL = k;
    let iInflR = iApex;
    for (let k = iApex; k <= iEnd; k++) if (dySmooth[k] < dySmooth[iInflR]) iInflR = k;
    const mL = dySmooth[iInflL];
    const mR = dySmooth[iInflR];
    let Wb_mL = NaN;
    if (mL > 0 && mR < 0) {
      const VL = V[iInflL] - yc[iInflL] / mL;
      const VRt = V[iInflR] - yc[iInflR] / mR;
      const w = VRt - VL;
      if (w > 0) Wb_mL = w;
    }

    const As10 = (Number.isFinite(w10.left_mL) && Number.isFinite(w10.right_mL))
      ? (w10.right_mL - VR_mL) / (VR_mL - w10.left_mL) : NaN;
    const As50 = (Number.isFinite(w50.left_mL) && Number.isFinite(w50.right_mL))
      ? (w50.right_mL - VR_mL) / (VR_mL - w50.left_mL) : NaN;
    const Tf = Number.isFinite(w05.width_mL) ? w05.width_mL / (2 * (VR_mL - w05.left_mL)) : NaN;

    const Nhalf = N_HALF_CONST * (VR_mL / w50.width_mL) * (VR_mL / w50.width_mL);
    const Ntangent = 16 * (VR_mL / Wb_mL) * (VR_mL / Wb_mL);
    const Nmoment = mom.sigma > 0 ? (mom.mu1 / mom.sigma) * (mom.mu1 / mom.sigma) : NaN;
    const NFoleyDorsey = N_FOLEY_CONST * (VR_mL / w10.width_mL) * (VR_mL / w10.width_mL) / (As10 + 1.25);
    const HETP_cm = L_cm / Nhalf;
    const hRed = HETP_cm / dp_cm;
    const truncFrac = truncFraction(yc, iStart, iEnd, mom.area, mom.sigma);

    const indeterminate = !Number.isFinite(w50.width_mL) || !Number.isFinite(w10.width_mL) ||
      !Number.isFinite(w05.width_mL) || !Number.isFinite(Wb_mL);
    const suspect = iStart === 0 || iEnd === n - 1 ||
      (Number.isFinite(truncFrac) && truncFrac > 0.01) ||
      (Amax_AUcm > 0 && windowDrop < 0.5 * ySmooth[iApex]);

    out.push({
      iStart, iApex, iEnd,
      VR_mL, Amax_AUcm, prominence_AUcm,
      area_AUcm_mL: mom.area,
      mu1_mL: mom.mu1, mu2_mL2: mom.mu2, sigma_mL: mom.sigma, skew: mom.skew,
      W50_mL: w50.width_mL, W10_mL: w10.width_mL, W05_mL: w05.width_mL, Wb_mL,
      Tf, As10, As50,
      Nhalf, Ntangent, Nmoment, NFoleyDorsey, HETP_cm, hRed,
      truncFrac,
      flags: { FLAT_APEX: apexInfo.flatApex, INDETERMINATE: indeterminate, SUSPECT: suspect },
    });
  }

  out.sort((p, q) => p.VR_mL - q.VR_mL);
  return out;
}

/**
 * Chromatographic resolution between two peaks, on three independent width bases.
 *
 * `Rs_4sigma` uses the TANGENT baseline width `Wb_mL` (4·sigma for a Gaussian), which is why
 * `detectPeaks` reports `Wb_mL` as the tangent width and not as the integration-window span.
 * `alpha` here is the retention-volume ratio: the textbook selectivity `k'2/k'1` needs the column
 * void volume and this signature receives no config, so the ratio is the honest surrogate.
 * `pOverV` is the peak-to-valley ratio of the equivalent Gaussian pair, evaluated on a 201-point
 * scan of the summed model between the two apexes.
 *
 * @param {object} p1 - the earlier-eluting Peak (§5.11.1).
 * @param {object} p2 - the later-eluting Peak.
 * @returns {{Rs_half:number, Rs_4sigma:number, Rs_moment:number, alpha:number, pOverV:number}}
 *   all dimensionless.
 */
export function resolution(p1, p2) {
  const dVR = Math.abs(p2.VR_mL - p1.VR_mL);
  const Rs_half = 1.18 * dVR / (p1.W50_mL + p2.W50_mL);
  const Rs_4sigma = 2 * dVR / (p1.Wb_mL + p2.Wb_mL);
  const Rs_moment = dVR / (2 * (p1.sigma_mL + p2.sigma_mL));
  const alpha = p1.VR_mL !== 0 ? p2.VR_mL / p1.VR_mL : NaN;

  let pOverV = NaN;
  const s1 = p1.sigma_mL;
  const s2 = p2.sigma_mL;
  const A1 = p1.Amax_AUcm;
  const A2 = p2.Amax_AUcm;
  if (s1 > 0 && s2 > 0 && Number.isFinite(A1) && Number.isFinite(A2) && dVR > 0) {
    const Va = Math.min(p1.VR_mL, p2.VR_mL);
    const Vb = Math.max(p1.VR_mL, p2.VR_mL);
    const steps = 200;
    let valley = Infinity;
    for (let k = 0; k <= steps; k++) {
      const V = Va + (Vb - Va) * (k / steps);
      const d1 = (V - p1.VR_mL) / s1;
      const d2 = (V - p2.VR_mL) / s2;
      const f = A1 * Math.exp(-0.5 * d1 * d1) + A2 * Math.exp(-0.5 * d2 * d2);
      if (f < valley) valley = f;
    }
    pOverV = valley > 0 ? Math.min(A1, A2) / valley : Infinity;
  }
  return { Rs_half, Rs_4sigma, Rs_moment, alpha, pOverV };
}
