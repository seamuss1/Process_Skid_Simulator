/**
 * tests/analytics.test.js — src/analytics/peaks.js and src/analytics/pooling.js.
 *
 * Contract: architecture-v2 §5.11.1, §5.11.3–§5.11.5, §6.19, §6.20, §7.5, §7.6, §10;
 * spec-physics-3-params §2 and VC-10.
 *
 * EVERY expectation here is either a closed-form value (Gaussian / EMG moments and widths, the
 * Beer–Lambert stray-light law, the plate-count identities) or is derived in the test itself from
 * an independent construction (bisection on the analytic peak, the trapezoid of a known integral).
 * Nothing is a transcript of what the code currently prints; where a number could only be pinned,
 * it says so and says why.
 *
 * Zero dependencies, no DOM, `node --test tests/` on Node 20+.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  moments, trapzArea, resampleUniformV, buildVolumeGrid, smooth, derivative1, selectWindow,
  refineApex, widthAt, detectPeaks, resolution, anchoredBaseline, truncFraction, neumaierSum,
} from '../src/analytics/peaks.js';
import { poolMetrics, massBalance, autoPool, rePool, analysePackingTest } from '../src/analytics/pooling.js';
import { strayLight_AU } from '../src/skid/sensors.js';
import { normalizePreset } from '../src/data/presets.js';
import { createRunState } from '../src/core/state.js';
import { createSkid } from '../src/skid/skid.js';
import { pushRow } from '../src/core/log.js';

/* ------------------------------------------------------------------------------------------- */
/* fixtures and closed-form references                                                          */
/* ------------------------------------------------------------------------------------------- */

/** VC-10's grid spacing: uniform ΔV = 0.0100 mL. */
const DV = 0.01;

/** Gaussian width identities, spec §2.7. Written as expressions, never as decimal literals. */
const K50 = 2 * Math.sqrt(2 * Math.LN2);          // 2.3548200450309493
const K10 = 2 * Math.sqrt(2 * Math.log(10));      // 4.2919320157606850
const K05 = 2 * Math.sqrt(2 * Math.log(20));      // 4.8954935697900070
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Compendial plate constant, §5.11.1. NOT 8·ln2. */
const N_HALF_CONST = 5.54;

/**
 * A grid in the `buildVolumeGrid` shape, sampled from an analytic profile.
 * `detectPeaks` only ever reads `V`, `y`, `n` and `dV_mL` off it (§6.19).
 */
function sample(V0, V1, f, dV = DV) {
  const n = Math.round((V1 - V0) / dV) + 1;
  const V = new Float64Array(n);
  const y = new Float64Array(n);
  for (let k = 0; k < n; k++) { V[k] = V0 + k * dV; y[k] = f(V[k]); }
  return { V, y, n, dV_mL: dV, channel: 'UV_280_mAU', builtAtRow: 0 };
}

const gaussian = (A, mu, sigma) => (V) => A * Math.exp(-0.5 * ((V - mu) / sigma) ** 2);

/**
 * `detectPeaks` reads only `column.L_cm`, `column.dp_cm` and (for reporting) the UV pathlength,
 * so a literal stub is the honest fixture for the synthetic-peak cases: it keeps the shipped
 * preset's geometry out of numbers that are pure peak mathematics.
 */
const STUB_CONFIG = { column: { L_cm: 20, dp_cm: 0.009 }, skid: { uv: { pathlength_cm: 0.02 } } };

/** The §2.4 default detection thresholds, in the synthetic trace's own AU/cm units. */
const DEFAULT_OPTS = {
  A_on_AUcm: 0.02, f_on: 0.005, s_on: 0.002, s_off: 0.0005,
  p_min: 0.020, w_min: 5 * DV, baseline: 'zero',
};

/** Run the §6.19 pipeline: SG smooth -> SG first derivative -> detectPeaks. */
function analyse(grid, opts, WhalfExpected_mL = K50 * 2) {
  const yS = new Float64Array(grid.n);
  const dyS = new Float64Array(grid.n);
  const w = selectWindow(WhalfExpected_mL, grid.dV_mL);
  smooth(grid.y, grid.n, w.m, w.passes, yS);
  derivative1(yS, grid.n, w.m, grid.dV_mL, dyS);
  return detectPeaks(STUB_CONFIG, grid, yS, dyS, Object.assign({}, DEFAULT_OPTS, opts));
}

function assertClose(actual, expected, absTol, what) {
  assert.ok(Number.isFinite(actual), `${what}: expected a finite number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= absTol,
    `${what}: ${actual} is not within ${absTol} of ${expected} (off by ${actual - expected})`);
}

function assertRel(actual, expected, relTol, what) {
  assert.ok(Number.isFinite(actual), `${what}: expected a finite number, got ${actual}`);
  const r = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(r <= relTol, `${what}: ${actual} vs ${expected} is ${r} relative, tolerance ${relTol}`);
}

/**
 * `exp(x²)·erfc(x)` for x >= 0 — the Numerical Recipes `erfcc` rational core with its exponential
 * factor removed. Fractional error below 1.2e-7 everywhere, which is three orders below every
 * tolerance this file asserts on the EMG.
 */
function erfcxPos(x) {
  const t = 1 / (1 + 0.5 * x);
  return t * Math.exp(-1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
}

/**
 * Unit-area exponentially-modified Gaussian, written in the numerically stable form
 * `f = (1/2τ)·exp(-u²/2)·erfcx(z)` on the branch where `z >= 0` (the naive
 * `exp(σ²/2τ² - (V-µ)/τ)·erfc(z)` overflows there) and in the direct form on the other branch,
 * where the exponent is bounded above by `σ²/2τ² - 1`.
 */
function emg(mu, sigma, tau) {
  return (V) => {
    const u = (V - mu) / sigma;
    const z = (sigma / tau - u) / Math.SQRT2;
    if (z >= 0) return (1 / (2 * tau)) * Math.exp(-0.5 * u * u) * erfcxPos(z);
    const erfcz = 2 - Math.exp(-z * z) * erfcxPos(-z);
    return (1 / (2 * tau)) * Math.exp(0.5 * (sigma / tau) ** 2 - (V - mu) / tau) * erfcz;
  };
}

/** Golden-section maximum of `f` on [a,b], to ~1e-12. Used to locate an apex independently. */
function argMaxOf(f, a, b) {
  let lo = a; let hi = b;
  for (let i = 0; i < 400; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) lo = m1; else hi = m2;
  }
  return 0.5 * (lo + hi);
}

/** Bisection for `f(V) = target` on a bracket where the sign changes. */
function crossOf(f, target, a, b) {
  let lo = a; let hi = b;
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (lo + hi);
    if ((f(m) - target) * (f(lo) - target) <= 0) hi = m; else lo = m;
  }
  return 0.5 * (lo + hi);
}

/* ------------------------------------------------------------------------------------------- */
/* VC-10(a) — the single Gaussian                                                               */
/* ------------------------------------------------------------------------------------------- */

test('VC-10(a) — moments of a Gaussian A=1, V_R=80, sigma=2 on V in [40,120]', () => {
  const g = sample(40, 120, gaussian(1, 80, 2));
  const m = moments(g.V, g.y, 0, g.n - 1, null);

  // The window is +/-20 sigma, so the truncated tail is exp(-200) ~ 1e-87 and the composite
  // trapezoid on a smooth peak that decays to baseline at both ends is super-algebraically
  // accurate (spec §2.6). 1e-9 relative is therefore a real assertion, not a padded one.
  assertRel(m.area, 1 * 2 * SQRT_2PI, 1e-9, 'VC-10(a) area = A*sigma*sqrt(2*pi)');
  assertClose(m.mu1, 80, 1e-4, 'VC-10(a) mu1');
  assertClose(m.mu2, 4, 1e-3, 'VC-10(a) mu2 = sigma^2');
  assertClose(m.sigma, 2, 3e-4, 'VC-10(a) sigma_V');
  assertClose(m.skew, 0, 2e-3, 'VC-10(a) skew');

  // trapzArea and moments.area must be the same integral.
  assert.equal(trapzArea(g.V, g.y, 0, g.n - 1, null), m.area);
});

test('VC-10(a) — apex, widths, asymmetry and the three plate counts', () => {
  const g = sample(40, 120, gaussian(1, 80, 2));
  const found = analyse(g, {});
  assert.equal(found.length, 1, 'exactly one peak');
  const p = found[0];

  assertClose(p.VR_mL, 80, 0.005, 'VC-10(a) parabolic apex V_R');
  assertClose(p.Amax_AUcm, 1, 1e-4, 'VC-10(a) A_max');

  // Widths: the crossing volumes are found by linear interpolation between samples 0.01 mL
  // apart, so the width error is bounded by the curvature over one interval, ~2e-5 mL. The
  // VC-10 tolerances (0.003 / 0.004 / 0.005) are two orders looser than that.
  assertClose(p.W50_mL, K50 * 2, 0.003, 'VC-10(a) W50 = 2*sqrt(2*ln2)*sigma');
  assertClose(p.W10_mL, K10 * 2, 0.004, 'VC-10(a) W10 = 2*sqrt(2*ln10)*sigma');
  assertClose(p.W05_mL, K05 * 2, 0.005, 'VC-10(a) W05 = 2*sqrt(2*ln20)*sigma');

  assertClose(p.Tf, 1, 0.002, 'VC-10(a) USP tailing factor of a Gaussian');
  assertClose(p.As10, 1, 0.002, 'VC-10(a) asymmetry at 10 %');
  assertClose(p.As50, 1, 0.002, 'VC-10(a) asymmetry at 50 %');

  // N_moment is exact by definition; N_tangent is 16*(V_R/4sigma)^2 = 1600 for a Gaussian.
  assertClose(p.Nmoment, (80 * 80) / 4, 1, 'VC-10(a) N_moment = mu1^2/mu2');
  assertClose(p.Ntangent, 16 * (80 / (4 * 2)) ** 2, 3, 'VC-10(a) N_tangent = 16*(V_R/4sigma)^2');

  // HETP and reduced plate height follow from N_half and the stub geometry.
  assertRel(p.HETP_cm, STUB_CONFIG.column.L_cm / p.Nhalf, 1e-12, 'HETP = L/N_half');
  assertRel(p.hRed, p.HETP_cm / STUB_CONFIG.column.dp_cm, 1e-12, 'h = HETP/dp');

  assert.equal(p.flags.FLAT_APEX, false);
  assert.equal(p.flags.INDETERMINATE, false);
});

test('VC-10(a) / §11 C-51 — N_half = 1598.506 against N_moment = 1600, a 0.0934 % gap', () => {
  const g = sample(40, 120, gaussian(1, 80, 2));
  const p = analyse(g, {})[0];

  // Closed form: N_half = 5.54*(V_R/(2*sqrt(2*ln2)*sigma))^2. The whole point of the case is
  // that the gap is the USP rounding of 8*ln2 = 5.5451774 to 5.54 and nothing else, so the
  // reference is written as that expression rather than as the printed 1598.506.
  const NhalfExact = N_HALF_CONST * (80 / (K50 * 2)) ** 2;
  assertRel(p.Nhalf, NhalfExact, 1e-5, 'N_half against its closed form');
  assertClose(p.Nhalf, 1598.506, 2, 'N_half against the §11 C-51 value');

  // The gap is a difference of two numbers within 0.1 % of each other, so a 1e-6 relative error
  // in W50 (the interpolation error over one 0.01 mL interval) moves it by 2e-6*1600/16 = 2e-4
  // percentage points. 5e-4 pp absolute is therefore the tightest honest band, and it separates
  // 5.54 (0.0934 %) from 8*ln2 (0.0000 %) by a factor of 190.
  const gapPct = 100 * (1600 - p.Nhalf) / 1600;
  const gapExact = 100 * (1 - N_HALF_CONST / (8 * Math.LN2));
  assertClose(gapPct, gapExact, 5e-4, 'N_half/N_moment gap against 1 - 5.54/(8 ln2)');
  assertClose(gapPct, 0.0934, 5e-4, 'N_half/N_moment gap against the §11 C-51 value');
});

/* ------------------------------------------------------------------------------------------- */
/* VC-10(b) — the resolved pair                                                                 */
/* ------------------------------------------------------------------------------------------- */

test('VC-10(b) — resolved Gaussian pair: two peaks, exact split areas, three agreeing Rs', () => {
  const g = sample(40, 132, (V) => gaussian(1, 80, 2)(V) + gaussian(1, 92, 2)(V));
  const found = analyse(g, {});
  assert.equal(found.length, 2, 'exactly two peaks');
  const [p1, p2] = found;

  // The perpendicular drop falls at V = 86, the symmetry point, so by symmetry each window
  // recovers the whole of its own Gaussian: what peak 1 loses beyond 86 it gains from peak 2's
  // left tail, term for term. The expected area is therefore the full A*sigma*sqrt(2*pi).
  assertRel(p1.area_AUcm_mL, 2 * SQRT_2PI, 1e-3, 'VC-10(b) area of peak 1');
  assertRel(p2.area_AUcm_mL, 2 * SQRT_2PI, 1e-3, 'VC-10(b) area of peak 2');
  assertClose(p1.VR_mL, 80, 0.01, 'VC-10(b) apex 1');
  assertClose(p2.VR_mL, 92, 0.01, 'VC-10(b) apex 2');

  const rs = resolution(p1, p2);
  assertClose(rs.Rs_half, 1.18 * 12 / (2 * K50 * 2), 0.015, 'Rs_half = 1.18*dV/(W50_1+W50_2)');
  assertClose(rs.Rs_4sigma, 2 * 12 / (2 * 4 * 2), 0.015, 'Rs_4sigma = 2*dV/(Wb_1+Wb_2)');
  assertClose(rs.Rs_moment, 12 / (2 * (2 + 2)), 0.015, 'Rs_moment = dV/(2*(s1+s2))');

  // Spec §2.11: the three bases agree for Gaussians, and the 0.22 % spread between Rs_half and
  // Rs_4sigma is entirely the rounding of 4/(2*2.35482) to 1.18/2.
  const all = [rs.Rs_half, rs.Rs_4sigma, rs.Rs_moment];
  for (const a of all) {
    for (const b of all) {
      assert.ok(Math.abs(a - b) < 0.010, `pairwise Rs agreement: |${a} - ${b}| >= 0.010`);
    }
  }
  assertClose(rs.alpha, 92 / 80, 1e-6, 'alpha = V_R2/V_R1');
});

/* ------------------------------------------------------------------------------------------- */
/* VC-10(c) — the exponentially-modified Gaussian                                               */
/* ------------------------------------------------------------------------------------------- */

test('VC-10(c) — EMG mu=80, sigma=2, tau=2: moments match the closed form', () => {
  const f = emg(80, 2, 2);
  const g = sample(40, 140, f);
  const m = moments(g.V, g.y, 0, g.n - 1, null);

  assertRel(m.area, 1, 1e-5, 'VC-10(c) unit area');
  assertClose(m.mu1, 80 + 2, 0.02, 'VC-10(c) mu1 = mu_g + tau');
  assertClose(m.mu2, 2 * 2 + 2 * 2, 0.05, 'VC-10(c) mu2 = sigma_g^2 + tau^2');
  assertClose(m.skew, 2 * 8 / Math.pow(8, 1.5), 0.02, 'VC-10(c) skew = 2*tau^3/(sg^2+tau^2)^1.5');
  assertClose((m.mu1 / m.sigma) ** 2, 82 * 82 / 8, 5, 'VC-10(c) N_moment = mu1^2/mu2');
});

test('VC-10(c) — EMG apex, tailing and asymmetry against an independent bisection', () => {
  const f = emg(80, 2, 2);
  const g = sample(40, 140, f);
  const found = analyse(g, { A_on_AUcm: 0.002, p_min: 0.002 }, 5.8);
  assert.equal(found.length, 1, 'exactly one EMG peak');
  const p = found[0];

  // Independent reference: locate the apex and the height crossings on the ANALYTIC profile by
  // golden section and bisection, with no reference to what peaks.js returns.
  const apex = argMaxOf(f, 78, 90);
  const fmax = f(apex);
  const exact = {};
  for (const frac of [0.5, 0.1, 0.05]) {
    const L = crossOf(f, frac * fmax, 40, apex);
    const R = crossOf(f, frac * fmax, apex, 200);
    exact[frac] = { L, R, W: R - L, a: apex - L, b: R - apex };
  }

  assertClose(p.VR_mL, apex, 0.01, 'VC-10(c) apex against golden-section on the analytic EMG');
  assert.ok(p.VR_mL > 80 && p.VR_mL < 82, 'VC-10(c) apex lies in [80, 82] mL');
  assertClose(p.W50_mL, exact[0.5].W, 0.005, 'VC-10(c) W50');
  assertClose(p.W10_mL, exact[0.1].W, 0.005, 'VC-10(c) W10');
  assertClose(p.W05_mL, exact[0.05].W, 0.005, 'VC-10(c) W05');

  // T_f = W05/(2a(0.05)) and A_s = b(0.10)/a(0.10), spec §2.9. Both are computed here from the
  // bisection crossings above; for tau/sigma = 1 they come out at 1.2282 and 1.3622.
  const TfExact = exact[0.05].W / (2 * exact[0.05].a);
  const As10Exact = exact[0.1].b / exact[0.1].a;
  assertClose(p.Tf, TfExact, 0.002, 'VC-10(c) USP tailing factor');
  assertClose(p.As10, As10Exact, 0.002, 'VC-10(c) asymmetry at 10 %');
  assert.ok(TfExact > 1.2 && TfExact < 1.3, `sanity: exact T_f is ${TfExact}`);

  // Identity: b(0.05)/a(0.05) = 2*T_f - 1, so the 5 % asymmetry follows from T_f alone.
  assertClose(2 * p.Tf - 1, exact[0.05].b / exact[0.05].a, 0.005, 'A_s(5 %) = 2*T_f - 1');

  // The deliberate divergence of §2.10: a tailing peak degrades N_half far more than N_moment
  // reports, and the two must NOT be reconciled.
  assert.ok(p.Nhalf < 1200, `VC-10(c) N_half must fall clearly below the Gaussian 1600: ${p.Nhalf}`);
  assertClose(p.Nmoment, 82 * 82 / 8, 5, 'VC-10(c) N_moment');
  assert.ok(p.Nhalf > p.Nmoment, 'VC-10(c) N_half and N_moment straddle, as §2.10 requires');
});

/* ------------------------------------------------------------------------------------------- */
/* VC-10(d) — the barely-resolved pair                                                          */
/* ------------------------------------------------------------------------------------------- */

test('VC-10(d) — barely-resolved pair: two peaks, no half-height crossing, analytic p/v', () => {
  const sum = (V) => gaussian(1, 80, 2)(V) + gaussian(1, 86, 2)(V);
  const g = sample(40, 126, sum);
  const found = analyse(g, {});
  assert.equal(found.length, 2, 'VC-10(d) exactly two peaks (prominence 0.36 > p_min)');
  const [p1, p2] = found;

  // Independent: the apex of the sum and the valley are both analytic.
  const apex1 = argMaxOf(sum, 78, 82);
  const valleyV = 83;                 // by symmetry
  const valleyY = sum(valleyV);       // = 2*exp(-9/8) = 0.649305
  assertClose(valleyY, 2 * Math.exp(-9 / 8), 1e-12, 'VC-10(d) valley height');
  assert.ok(p1.VR_mL >= 80.00 && p1.VR_mL <= 80.30, `VC-10(d) apex 1 in [80.00, 80.30]: ${p1.VR_mL}`);
  assertClose(p1.VR_mL, apex1, 0.01, 'VC-10(d) apex 1 against golden section on the sum');
  assertClose(g.V[p1.iEnd], valleyV, 0.02, 'VC-10(d) perpendicular drop falls at the valley');

  // Peak-to-valley from the trace itself, which is what spec §2.11 defines p/v to be.
  const pv = p1.Amax_AUcm / g.y[p1.iEnd];
  assertClose(pv, sum(apex1) / valleyY, 0.005, 'VC-10(d) p/v against the analytic apex/valley');
  assertClose(pv, 1.557, 0.05, 'VC-10(d) p/v against the printed value');

  // The valley (0.6493) sits ABOVE half the apex (0.5059), so no half-height crossing exists on
  // the inner flank. §5.11.1 requires NaN there and INDETERMINATE on everything derived from it.
  assert.ok(valleyY > 0.5 * sum(apex1), 'the fixture really has no inner half-height crossing');
  assert.ok(Number.isNaN(p1.W50_mL), 'VC-10(d) W50 of peak 1 is NaN, never a guess');
  assert.ok(Number.isNaN(p1.Nhalf), 'VC-10(d) N_half of peak 1 is NaN');
  assert.equal(p1.flags.INDETERMINATE, true, 'VC-10(d) peak 1 flagged INDETERMINATE');
  assert.ok(Number.isNaN(resolution(p1, p2).Rs_half), 'Rs_half is NaN when a W50 is missing');
});

test('VC-10(d) — Rs_4sigma of the fused pair, against the analytic 0.59680 (NOT the printed 0.750)', () => {
  // CONTRACT CORRECTION (recorded, not swallowed). VC-10(d) prints Rs_4sigma = 2 x 6 / 16 = 0.750.
  // That is the IDEAL DECONVOLVED value: it uses the undistorted apex separation (6.000 mL, the
  // separation of the two GENERATING Gaussians) and the undistorted Gaussian tangent width
  // (4 sigma = 8.000 mL, the width each peak would have ALONE). Neither of those is a property of
  // the trace the detector sees, and neither survives the fusion:
  //   (a) the apexes of the SUM sit at 80.0735 / 85.9265, 5.8530 mL apart, not 6.000;
  //   (b) the inner-flank tangent is taken on the sum of a FALLING and a RISING Gaussian, whose
  //       slope is much shallower than either alone, so it extrapolates to 9.8073 mL, not 8.000.
  // The spec §2.8 alternative (W_b = 1.69864*W_50) cannot rescue 0.750 either: W_50 is itself
  // unmeasurable on this fixture (the valley 0.649305 sits above half the apex, 0.505860), so it
  // returns NaN. 0.750 is unreachable under either reading of W_b. Everything below is built from
  // the analytic sum by golden section and closed-form differentiation, never from the module.
  const A = gaussian(1, 80, 2);
  const B = gaussian(1, 86, 2);
  const f = (V) => A(V) + B(V);
  // d/dV of a Gaussian is -((V-mu)/sigma^2) * G(V).
  const fp = (V) => -((V - 80) / 4) * A(V) - ((V - 86) / 4) * B(V);

  const g = sample(40, 126, f);
  const [p1, p2] = analyse(g, {});
  const rs = resolution(p1, p2);

  // (a) THE APEX SEPARATION, from golden section on the analytic sum.
  const apex1 = argMaxOf(f, 78, 82);
  const apex2 = argMaxOf(f, 84, 88);
  const dVR_analytic = apex2 - apex1;
  assertClose(dVR_analytic, 5.8530, 5e-4, 'the analytic apex separation of the SUM');
  assert.ok(dVR_analytic < 6.0, 'the apexes really are pulled together by the neighbour');
  const dVR = Math.abs(p2.VR_mL - p1.VR_mL);
  assertClose(dVR, dVR_analytic, 1e-3, 'the measured apex separation is the analytic one');

  // (b) THE TANGENT WIDTH, from the same construction §5.11.1 specifies — extrapolate the
  // inflection tangents to the baseline — evaluated on the analytic sum. The inner inflection is
  // searched only as far as the valley at 83, which is where the perpendicular drop puts the
  // integration boundary.
  const VinflL = argMaxOf(fp, 40, apex1);                 // steepest rise, outer flank
  const VinflR = argMaxOf((V) => -fp(V), apex1, 83);      // steepest fall, inner flank
  const Wb_analytic = (VinflR - f(VinflR) / fp(VinflR)) - (VinflL - f(VinflL) / fp(VinflL));
  assertClose(Wb_analytic, 9.8073, 1e-3, 'the analytic tangent width of the fused peak');
  assert.ok(Wb_analytic > 8.0, 'the tangent width really is inflated above 4 sigma');
  assertClose(p1.Wb_mL, Wb_analytic, 5e-3, 'the measured tangent width is the analytic one');

  // ... and the SAME construction returns 4 sigma = 8.000 on the same peak UNFUSED, which is what
  // proves the inflation is the fusion and not the tangent code.
  const solo = analyse(sample(40, 120, A), {})[0];
  assertClose(solo.Wb_mL, 8.000, 1e-3, 'an isolated Gaussian still gives W_b = 4 sigma');

  // (c) THE CORRECTED ANCHOR. Rs_4sigma = 2*dVR/(Wb1 + Wb2), symmetric fixture so Wb1 = Wb2.
  const Rs_analytic = 2 * dVR_analytic / (2 * Wb_analytic);
  assertClose(Rs_analytic, 0.59680, 5e-5, 'the analytic Rs_4sigma of this fixture');
  assertClose(rs.Rs_4sigma, Rs_analytic, 5e-4,
    `VC-10(d) Rs_4sigma (measured from dVR = ${dVR.toFixed(4)} mL and Wb = ${p1.Wb_mL.toFixed(4)} mL)`);
  // The printed 0.750 is 26 % away — far outside anything a tolerance could absorb.
  assert.ok(Math.abs(rs.Rs_4sigma - 0.750) > 0.15,
    'the printed 0.750 is the deconvolved ideal, not a measurable property of this trace');
});

/* ------------------------------------------------------------------------------------------- */
/* VC-10(e) — baseline handling                                                                 */
/* ------------------------------------------------------------------------------------------- */

test('VC-10(e) — anchored baseline removes a linear drift; zero baseline visibly does not', () => {
  const drift = (V) => 0.0100 + 2.500e-5 * (V - 40);
  const g = sample(40, 120, (V) => gaussian(1, 80, 2)(V) + drift(V));

  const anchored = analyse(g, { baseline: 'anchored' });
  assert.equal(anchored.length, 1, 'anchored: one peak');
  const a = anchored[0];
  assertRel(a.area_AUcm_mL, 2 * SQRT_2PI, 3e-3, 'VC-10(e) anchored area within 0.3 %');
  assertClose(a.mu1_mL, 80, 0.02, 'VC-10(e) anchored mu1');
  assertClose(a.Amax_AUcm, 1, 0.002, 'VC-10(e) anchored A_max');

  const zeroed = analyse(g, { baseline: 'zero' });
  assert.equal(zeroed.length, 1, 'zero: one peak');
  const rel = zeroed[0].area_AUcm_mL / (2 * SQRT_2PI) - 1;
  assert.ok(rel > 0.01,
    `VC-10(e) the zero baseline must be visibly wrong (>1 % high), it is ${(100 * rel).toFixed(2)} %`);
});

test('§2.3 — anchoredBaseline is the exact line through the two anchors, level without volumes', () => {
  const V = Float64Array.from([10, 12, 14, 16]);
  const y = Float64Array.from([1.0, 5.0, 5.0, 3.0]);
  const tilted = anchoredBaseline(y, 0, 3, V);
  assertClose(tilted(10), 1.0, 1e-12, 'anchored baseline at the left anchor');
  assertClose(tilted(16), 3.0, 1e-12, 'anchored baseline at the right anchor');
  assertClose(tilted(13), 2.0, 1e-12, 'anchored baseline interpolates linearly');
  // Without the abscissa the tilt cannot be constructed, so it degrades to the anchor mean.
  const level = anchoredBaseline(y, 0, 3);
  assertClose(level(10), 2.0, 1e-12, 'level fallback = mean of the anchors');
  assertClose(level(1e6), 2.0, 1e-12, 'level fallback is constant');
});

/* ------------------------------------------------------------------------------------------- */
/* VC-10(f) — degenerate inputs                                                                 */
/* ------------------------------------------------------------------------------------------- */

test('VC-10(f) — a flat trace produces no peaks and no exception', () => {
  const flat = sample(40, 120, () => 0);
  assert.equal(analyse(flat, {}).length, 0, 'flat trace yields no peaks');
  assert.equal(analyse(flat, { p_min: 0, s_on: 0, s_off: 0, A_on_AUcm: 0 }).length, 0,
    'and still none with every gate opened');
});

test('VC-10(f) — a one-sample spike is rejected by the §2.4 default w_min', () => {
  // §2.4 sets w_min = 5 x dV_log expressly to "reject spikes (bubbles)". A single sample above
  // the detect level is the canonical bubble artefact and must not become a peak.
  //
  // WHAT w_min MAY NOT BE MEASURED ON: `V[iEnd] - V[iStart]`, the span of the perpendicular-drop
  // WINDOW. The window of an isolated spike runs out to the Savitzky-Golay side lobes — 0.160 mL
  // after selectWindow's 9 passes of a 9-point kernel, sixteen times w_min — so gating on it
  // leaves §2.4's spike rejector inoperative at its own documented default. The gate is on the
  // peak's EQUIVALENT WIDTH `area/A_max`, which for this fixture is one sample, 0.0100 mL.
  const spike = sample(40, 120, (V) => (Math.abs(V - 80) < 0.5 * DV ? 1 : 0));
  const found = analyse(spike, { w_min: 5 * DV });
  assert.equal(found.length, 0, 'a one-sample spike must be rejected by w_min = 5 dV = 0.05 mL');

  // The spike IS found with the gate removed, and its measured width is what the gate saw: one
  // sample of area against unit height, while its integration window is 16x wider than w_min.
  const open = analyse(spike, { w_min: 0, p_min: 0 });
  assert.equal(open.length, 1, 'and is found once w_min is removed');
  const span = spike.V[open[0].iEnd] - spike.V[open[0].iStart];
  assertClose(open[0].area_AUcm_mL / open[0].Amax_AUcm, DV, 1e-6,
    'the spike is exactly one sample wide by area/height');
  assert.ok(span > 3 * 5 * DV,
    `its window spans ${span.toFixed(3)} mL, so a window-span gate could never fire`);

  // A real peak must be nowhere near the gate: 5.013 mL of equivalent width (sigma*sqrt(2pi)) is
  // a hundred times w_min, so nothing about this rejector endangers a genuine peak.
  const real = analyse(sample(40, 120, gaussian(1, 80, 2)), { w_min: 5 * DV });
  assert.equal(real.length, 1, 'a sigma = 2 mL Gaussian is untouched by the same gate');
  assertRel(real[0].area_AUcm_mL / real[0].Amax_AUcm, 2 * SQRT_2PI, 1e-3,
    'whose equivalent width is sigma*sqrt(2pi) = 5.013 mL');
});

test('VC-10(f) — a truncated peak returns NaN on the missing side and reports truncFrac', () => {
  // The trace stops 0.5 sigma past the apex, so the 50 %, 10 % and 5 % crossings on the falling
  // side do not exist. §5.11.1: NaN, never a guess, and everything derived is INDETERMINATE.
  const g = sample(40, 81, gaussian(1, 80, 2));
  const found = analyse(g, {});
  assert.equal(found.length, 1, 'the truncated peak is still detected');
  const p = found[0];
  assert.ok(Number.isNaN(p.W50_mL), 'W50 is NaN');
  assert.ok(Number.isNaN(p.W10_mL), 'W10 is NaN');
  assert.ok(Number.isNaN(p.Nhalf), 'N_half is NaN');
  assert.equal(p.flags.INDETERMINATE, true, 'INDETERMINATE propagates');
  assert.ok(p.truncFrac > 0.05, `truncFrac must exceed 0.05, it is ${p.truncFrac}`);

  // The right-hand crossing IS reachable on the full trace, which proves the NaN above is the
  // truncation and not a broken search.
  const whole = analyse(sample(40, 120, gaussian(1, 80, 2)), {})[0];
  assert.ok(Number.isFinite(whole.W50_mL), 'the same peak measured whole has a finite W50');
});

test('VC-10(f) — a clipped peak raises FLAT_APEX and yields NaN plate counts, without throwing', () => {
  const g = sample(40, 120, (V) => Math.min(0.5, gaussian(1, 80, 2)(V)));
  const found = analyse(g, { p_min: 0 });
  assert.ok(found.length >= 1, 'the clipped peak is reported');
  for (const p of found) {
    assert.equal(p.flags.FLAT_APEX, true, 'FLAT_APEX raised on a clipped apex');
    assertClose(p.Amax_AUcm, 0.5, 1e-12, 'the reported apex height is the clip level');
    assert.ok(Number.isNaN(p.Nhalf), 'N_half is NaN on a clipped apex');
  }
});

test('VC-10(f) — a clipped peak survives the §2.4 default prominence filter', () => {
  // A detector-saturated peak sits 0.5 AU/cm above a zero baseline, so its topographic
  // prominence is 0.5 — 25x the §2.4 default p_min of 0.020. §4.3 mitigation 5 and VC-10(f)
  // both require it to be reported (flat-topped, flagged), not discarded.
  //
  // The failure mode this pins: a flat top carries several apexes, and if prominence is measured
  // as the drop to the perpendicular-drop valleys of the IMMEDIATELY ADJACENT apexes then every
  // fragment measures itself against a neighbour of its own height, scores ~0, and the whole
  // group — summit included — is deleted by any non-zero p_min.
  const g = sample(40, 120, (V) => Math.min(0.5, gaussian(1, 80, 2)(V)));
  const found = analyse(g, { p_min: 0.020 });
  assert.ok(found.length >= 1,
    'a clipped peak of prominence 0.5 must survive p_min = 0.020; detectPeaks reports '
    + `${found.length} peaks`);
  for (const p of found) {
    assertClose(p.Amax_AUcm, 0.5, 1e-12, 'and it is still reported at the clip level');
    assert.equal(p.flags.FLAT_APEX, true, 'still flat-topped');
  }
  // The gate must still bite on something genuinely low: a 0.010 AU/cm bump is half of p_min.
  const small = analyse(sample(40, 120, gaussian(0.010, 80, 2)), { p_min: 0.020, A_on_AUcm: 0 });
  assert.equal(small.length, 0, 'p_min still rejects a peak of prominence 0.010');
});

test('§2.4 — the tallest peak of a noisy trace survives the default prominence filter', () => {
  // The same root cause, on the case that matters in service: chatter on the apex of a real peak
  // splits it into fragments that are all the same height as each other. At 0.3 % RMS noise on a
  // 1.0 AU/cm apex the perpendicular-drop reading of prominence returned ZERO peaks — the
  // product peak of a 300:1 SNR trace, deleted by a 2 % prominence gate.
  let x = 0x5eed1234 | 0;
  const rnd = () => {
    x ^= x << 13; x |= 0; x ^= x >>> 17; x ^= x << 5; x |= 0;
    return (x >>> 0) / 4294967296 - 0.5;
  };
  const amp = 0.003 * Math.sqrt(12);                        // 0.003 RMS = 0.3 % of the apex
  const g = sample(40, 120, (V) => gaussian(1, 80, 2)(V) + amp * rnd());
  const found = analyse(g, {});
  assert.equal(found.length, 1, `exactly one peak on a 0.3 % noise trace, got ${found.length}`);
  assertClose(found[0].VR_mL, 80, 0.1, 'and it is the real apex');
  assertRel(found[0].area_AUcm_mL, 2 * SQRT_2PI, 0.02, 'carrying the right area');
});

/* ------------------------------------------------------------------------------------------- */
/* the sixth synthetic peak — noisy                                                             */
/* ------------------------------------------------------------------------------------------- */

test('§2.2/§2.4 — a Gaussian carrying detector-grade noise integrates to within 1.5 %', () => {
  // Noise amplitude 0.2 % of the apex, matching the shipped detector: §4.4 gives 0.0005 AU RMS
  // against the §7.5 predicted mAb apex of 0.241 AU. Deterministic xorshift32 so the fixture is
  // byte-reproducible.
  let x = 0x5eed1234 | 0;
  const rnd = () => {
    x ^= x << 13; x |= 0; x ^= x >>> 17; x ^= x << 5; x |= 0;
    return (x >>> 0) / 4294967296 - 0.5;                    // uniform on [-0.5, 0.5)
  };
  const amp = 0.002 * Math.sqrt(12);                        // 0.002 RMS
  const g = sample(40, 120, (V) => gaussian(1, 80, 2)(V) + amp * rnd());

  const found = analyse(g, {});
  assert.equal(found.length, 1, `exactly one peak on a 500:1 SNR trace, got ${found.length}`);
  const p = found[0];
  assertClose(p.VR_mL, 80, 0.05, 'noisy apex');
  assertRel(p.area_AUcm_mL, 2 * SQRT_2PI, 0.015, 'noisy area within 1.5 % of A*sigma*sqrt(2pi)');
  assertRel(p.W50_mL, K50 * 2, 0.01, 'noisy W50 within 1 % of 2*sqrt(2ln2)*sigma');
});

/* ------------------------------------------------------------------------------------------- */
/* §7.5 — the stray-light law                                                                   */
/* ------------------------------------------------------------------------------------------- */

test('§7.5 / VC-12 — stray-light saturation A_obs = -log10((1-s)*10^-A + s)', () => {
  const s = 3.0e-3;
  const closed = (A) => -Math.log10((1 - s) * Math.pow(10, -A) + s);

  for (const A of [0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 10.0]) {
    assertClose(strayLight_AU(A, s), closed(A), 1e-12, `stray light at A_true = ${A}`);
  }

  // The printed digits of §7.5 / VC-12(d)-(f), to their stated +/-1e-5.
  assertClose(strayLight_AU(0.5, s), 0.4971910, 1e-5, 'A_true = 0.5');
  assertClose(strayLight_AU(1.0, s), 0.9884266, 1e-5, 'A_true = 1.0');
  assertClose(strayLight_AU(2.0, s), 1.8870601, 1e-5, 'A_true = 2.0');

  // §7.5's fourth entry pairs A_true = 3.0 with 2.5228787. 2.5228787 is -log10(s), the value the
  // law approaches only as A_true -> infinity (VC-12(g) pins it at A_true = 100); the law gives
  // 2.3982659 at 3.0 AU, which is also what spec §4.4's own table prints. Both are asserted here
  // so the asymptote stays pinned where it belongs.
  assertClose(strayLight_AU(3.0, s), closed(3.0), 1e-12, 'A_true = 3.0 against the closed form');
  assertClose(strayLight_AU(3.0, s), 2.3982659, 1e-6, 'A_true = 3.0, spec §4.4');
  assertClose(strayLight_AU(100, s), -Math.log10(s), 1e-9, 'asymptote = -log10(s)');
  assertClose(-Math.log10(s), 2.5228787, 1e-6, 'the asymptote is 2.5228787 AU');

  assertClose(strayLight_AU(0, s), 0, 1e-15, 'A_true = 0 reads exactly 0');

  // VC-12(i) monotonicity. Strictly increasing while the model can be resolved in double
  // precision: the step in A_obs is about (1-s)/s * 10^-A * h, which falls below one ulp of the
  // 2.5228787 asymptote (4.4e-16) at A_true ~ 16.6. Beyond that the requirement is non-decreasing
  // and bounded by the asymptote, which is an IEEE754 limit and not a property of the model.
  let prev = -Infinity;
  for (let A = 0; A <= 16; A += 0.05) {
    const obs = strayLight_AU(A, s);
    assert.ok(obs > prev, `A_obs must be strictly increasing; broke at A_true = ${A}`);
    prev = obs;
  }
  for (let A = 16; A <= 20; A += 0.05) {
    const obs = strayLight_AU(A, s);
    assert.ok(obs >= prev, `A_obs must be non-decreasing; broke at A_true = ${A}`);
    assert.ok(obs <= -Math.log10(s) + 1e-12, `A_obs must never exceed the asymptote at ${A}`);
    prev = obs;
  }
});

/* ------------------------------------------------------------------------------------------- */
/* §7.6 — the packing test                                                                      */
/* ------------------------------------------------------------------------------------------- */

test('§7.6 — fixture PT-1: N_apparent = 302.6 +/- 2, N_corrected = 500 +/- 0.5 %', () => {
  // Fixture PT-1: 1.0 cm ID x 10.0 cm bed, unretained tracer at epsT = 0.9025 so
  // V_R = 0.9025 * pi/4 * 10 = 7.08822 mL; true N = 500; sigma_ec = 0.25606 mL from the LAB
  // segment table. The input W50 is DERIVED, not taken from the code: sigma_meas is the
  // quadrature sum of the column and extra-column contributions and W50 = 2 sqrt(2 ln2) sigma.
  const A_cm2 = Math.PI * 0.5 * 0.5;
  const VR_mL = 0.9025 * A_cm2 * 10;
  assertClose(VR_mL, 7.08822, 1e-4, 'PT-1 V_R');

  const sigmaEc_mL = 0.25606;
  const sigmaCol_mL = VR_mL / Math.sqrt(500);
  const sigmaMeas_mL = Math.sqrt(sigmaCol_mL * sigmaCol_mL + sigmaEc_mL * sigmaEc_mL);
  const W50_mL = K50 * sigmaMeas_mL;

  const r = analysePackingTest(STUB_CONFIG, { VR_mL, W50_mL, As10: 1.0 }, 10, sigmaEc_mL);
  assertClose(r.N_apparent, 302.6, 2, 'PT-1 N_apparent');
  assertRel(r.N_corrected, 500, 0.005, 'PT-1 N_corrected');
  assertClose(r.sigma_extracolumn_mL, sigmaEc_mL, 1e-12, 'sigma_ec is reported back verbatim');
  assertRel(r.HETP_corrected_cm, 10 / r.N_corrected, 1e-12, 'HETP_corrected = L/N_corrected');
  assertRel(r.N_per_m, r.N_corrected * 100 / 10, 1e-12, 'N_per_m comes off the CORRECTED count');

  // 500 plates in 10 cm is 5000 plates/m: below the 6000 INVESTIGATE floor.
  assert.equal(r.verdict, 'REJECT', 'PT-1 verdict');

  // The uncorrected number understates the column by 39 %: that gap is the teaching point.
  assert.ok(r.N_apparent / 500 < 0.65, 'N_apparent understates the true N by about 40 %');
});

test('§7.6 — the verdict ladder and INDETERMINATE propagation', () => {
  const VR_mL = 100;
  // Choose sigma_col so N_per_m lands in each band for an L = 10 cm bed.
  const forN = (N) => ({ VR_mL, W50_mL: K50 * (VR_mL / Math.sqrt(N)), As10: 1 });
  assert.equal(analysePackingTest(STUB_CONFIG, forN(1200), 10, 0).verdict, 'ACCEPT');
  assert.equal(analysePackingTest(STUB_CONFIG, forN(800), 10, 0).verdict, 'INVESTIGATE');
  assert.equal(analysePackingTest(STUB_CONFIG, forN(400), 10, 0).verdict, 'REJECT');

  // sigma_ec >= sigma_meas leaves a non-positive column variance: §7.6 says INDETERMINATE.
  const over = analysePackingTest(STUB_CONFIG, forN(1200), 10, 10 * VR_mL / Math.sqrt(1200));
  assert.equal(over.verdict, 'INDETERMINATE');
  assert.ok(Number.isNaN(over.N_corrected), 'N_corrected is NaN when the correction is impossible');

  // A missing half-height crossing must carry straight through to the verdict.
  const missing = analysePackingTest(STUB_CONFIG, { VR_mL, W50_mL: NaN, As10: NaN }, 10, 0.1);
  assert.ok(Number.isNaN(missing.N_apparent), 'N_apparent is NaN when W50 is NaN');
  assert.equal(missing.verdict, 'INDETERMINATE', 'INDETERMINATE propagates from an unmeasured W50');
});

/* ------------------------------------------------------------------------------------------- */
/* §6.19 — resampleUniformV, the grid, and the small numeric helpers                            */
/* ------------------------------------------------------------------------------------------- */

test('§6.19 — resampleUniformV round-trip: exact on a linear signal, exact grid definition', () => {
  const nSrc = 500;
  const Vsrc = new Float64Array(nSrc);
  const ysrc = new Float64Array(nSrc);
  for (let k = 0; k < nSrc; k++) {
    Vsrc[k] = 10 + k * 0.37 + 0.11 * Math.sin(k);        // deliberately NON-uniform, monotone
    ysrc[k] = 3 + 2.5 * Vsrc[k];
  }
  for (let k = 1; k < nSrc; k++) assert.ok(Vsrc[k] > Vsrc[k - 1], 'the source abscissa is monotone');

  const dV = 0.05;
  const outV = new Float64Array(8000);
  const outY = new Float64Array(8000);
  const n = resampleUniformV(Vsrc, ysrc, nSrc, dV, outV, outY);

  // §6.19 fixes the grid exactly: V[k] = V_src[0] + k*dV, count = floor(span/dV) + 1.
  assert.equal(n, Math.floor((Vsrc[nSrc - 1] - Vsrc[0]) / dV) + 1, 'sample count');
  assert.equal(outV[0], Vsrc[0], 'the grid starts at the first logged volume');
  for (let k = 0; k < n; k++) assertClose(outV[k], Vsrc[0] + k * dV, 1e-12, `grid abscissa at ${k}`);

  // Linear interpolation of a linear function is exact, so this is a round-trip identity and not
  // an approximation: 1e-11 absolute on values of order 500.
  for (let k = 0; k < n; k++) {
    assertClose(outY[k], 3 + 2.5 * outV[k], 1e-11, `linear round-trip at k = ${k}`);
  }

  // Two calls sharing V_src and dV must be index-aligned — that is what lets pooling.js overlay
  // conductivity and the truth channels on the UV grid (§6.19).
  const y2 = new Float64Array(nSrc);
  for (let k = 0; k < nSrc; k++) y2[k] = -7 + 0.5 * Vsrc[k];
  const outV2 = new Float64Array(8000);
  const outY2 = new Float64Array(8000);
  const n2 = resampleUniformV(Vsrc, y2, nSrc, dV, outV2, outY2);
  assert.equal(n2, n, 'both channels produce the same sample count');
  for (let k = 0; k < n; k++) assert.equal(outV2[k], outV[k], `abscissa alignment at ${k}`);

  // Degenerate inputs return 0 or 1 rather than throwing.
  assert.equal(resampleUniformV(Vsrc, ysrc, 0, dV, outV, outY), 0, 'n = 0');
  assert.equal(resampleUniformV(Vsrc, ysrc, nSrc, 0, outV, outY), 0, 'dV = 0');
  assert.equal(resampleUniformV(Vsrc, ysrc, 1, dV, outV, outY), 1, 'a single source sample');
});

test('§6.19 — neumaierSum, trapzArea, widthAt and refineApex behave as declared', () => {
  // Compensated summation: each 1e-17 term is far below ulp(1) = 2.2e-16, so naive left-to-right
  // summation loses every one of them and returns exactly 1; Neumaier returns 1 + 1e-11.
  const terms = new Float64Array(1000001);
  terms[0] = 1;
  for (let k = 1; k < terms.length; k++) terms[k] = 1e-17;
  let naive = 0;
  for (let k = 0; k < terms.length; k++) naive += terms[k];
  assert.equal(naive, 1, 'the fixture really does defeat naive summation');
  assertClose(neumaierSum(terms, terms.length), 1 + 1e-11, 1e-15, 'Neumaier compensated sum');

  // Trapezoid of a straight line is exact; a reversed window is the same integral.
  const V = new Float64Array(11);
  const y = new Float64Array(11);
  for (let k = 0; k < 11; k++) { V[k] = k; y[k] = 2 * k + 1; }
  assertClose(trapzArea(V, y, 0, 10, null), 10 * (1 + 21) / 2, 1e-12, 'trapezoid of a line');
  assertClose(trapzArea(V, y, 10, 0, null), 10 * (1 + 21) / 2, 1e-12, 'reversed window');
  assert.equal(trapzArea(V, y, 4, 4, null), 0, 'a zero-width window integrates to 0');

  // refineApex on an exact parabola recovers the vertex to machine precision.
  const par = sample(0, 10, (x) => 5 - 2 * (x - 4.037) ** 2, 0.5);
  let iMax = 0;
  for (let k = 1; k < par.n; k++) if (par.y[k] > par.y[iMax]) iMax = k;
  const ref = refineApex(par.V, par.y, iMax);
  assertClose(ref.VR_mL, 4.037, 1e-9, 'parabolic apex refinement');
  assertClose(ref.Amax_AUcm, 5, 1e-9, 'parabolic apex height');
  assert.equal(ref.flatApex, false);

  // widthAt takes the FIRST crossing outward from the apex, so a shoulder cannot steal the width.
  const gg = sample(40, 120, gaussian(1, 80, 2));
  const apexIdx = Math.round((80 - 40) / DV);
  const w = widthAt(gg.V, gg.y, apexIdx, 0, gg.n - 1, 0.5);
  assertClose(w.width_mL, K50 * 2, 0.003, 'widthAt at half height');
  assertClose(w.left_mL, 80 - 0.5 * K50 * 2, 0.002, 'left crossing');
  assertClose(w.right_mL, 80 + 0.5 * K50 * 2, 0.002, 'right crossing');

  // truncFraction is 0 for a fully captured peak and 0.5 per end when the end sits at the apex.
  assertClose(truncFraction(gg.y, 0, gg.n - 1, 2 * SQRT_2PI, 2), 0, 1e-12, 'no truncation');
  assert.ok(Number.isNaN(truncFraction(gg.y, 0, 10, 0, 2)), 'NaN for a non-positive area');
});

/* ------------------------------------------------------------------------------------------- */
/* §5.11.3 / §6.20 — pool metrics over a synthetic run                                          */
/* ------------------------------------------------------------------------------------------- */

/**
 * Build a real `config`/`run` pair and write a synthetic chromatogram straight into `run.log`:
 * three Gaussians in mM on the per-species truth channels and their exact Beer–Lambert A280 on
 * `UV_280_mAU`. Every pool number then has a closed form (`integral = C * sigma * sqrt(2 pi)`),
 * which is the whole point — nothing here is a transcript of a simulation.
 */
const POOL_PEAKS = { WKI: [0.020, 70, 3.0], mAb: [0.060, 100, 3.0], AGG: [0.010, 112, 3.0] };
const POOL_V0 = 40;
const POOL_dV = 0.02;
const POOL_ROWS = 8001;

function syntheticPoolRun() {
  const config = normalizePreset('cex-capture-igg1-lab', {});
  const run = createRunState(config);
  createSkid(config, run);
  const idx = config.idxById;
  const store = run.log;
  const values = new Float64Array(store.names.length);
  const yv = new Float64Array(config.ns);

  for (let k = 0; k < POOL_ROWS; k++) {
    const V = POOL_V0 + k * POOL_dV;
    yv.fill(0);
    let A280_AUcm = 0;
    for (const id of Object.keys(POOL_PEAKS)) {
      const [C, mu, sg] = POOL_PEAKS[id];
      const c_mM = gaussian(C, mu, sg)(V);
      const sp = config.species[idx[id]];
      yv[idx[id]] = c_mM;
      A280_AUcm += sp.eps280_Lgcm * (c_mM * sp.MW_gmol / 1000);   // mM -> g/L -> AU/cm
    }
    values.fill(0);
    values[store.index.get('t_s')] = k;
    values[store.index.get('V_mL')] = V;
    values[store.index.get('UV_280_mAU')] = 1000 * config.skid.uv.pathlength_cm * A280_AUcm;
    values[store.index.get('cond_mS_cm')] = 12.5;
    values[store.index.get('pH')] = 5.25;
    pushRow(store, values, yv);
  }
  run.t_s = 3600;
  run.V_run_mL = 2000;
  return { config, run, idx };
}

/** Closed-form pooled mass, mg: integral(c dV) [umol] * MW / 1000. */
function poolMass_mg(config, idx, id) {
  const [C, , sg] = POOL_PEAKS[id];
  return C * sg * SQRT_2PI * config.species[idx[id]].MW_gmol / 1000;
}

test('§5.11.3 — poolMetrics(truth) reproduces closed-form mass, purity, yield and LRV', () => {
  const { config, run, idx } = syntheticPoolRun();
  // Deliver exactly twice the pooled mAb and ten times the pooled AGG from the sample tank.
  run.massLoad_umol[idx.mAb] = 2 * POOL_PEAKS.mAb[0] * POOL_PEAKS.mAb[2] * SQRT_2PI;
  run.massLoad_umol[idx.AGG] = 10 * POOL_PEAKS.AGG[0] * POOL_PEAKS.AGG[2] * SQRT_2PI;

  const grid = buildVolumeGrid(config, run);
  assertRel(grid.dV_mL, config.column.V_mL / 2000, 1e-15, '§6.19 grid spacing is V_mL/2000');
  assert.equal(grid.channel, 'UV_280_mAU', '§6.19 grid source channel');
  assert.equal(grid.V[0], POOL_V0, '§6.19 grid starts at the first logged volume');

  const pm = poolMetrics(config, run, grid, 0, grid.n - 1, 'truth');
  assert.equal(pm.mode, 'truth');

  // The pool spans every peak to well beyond 10 sigma, so each species mass is its whole integral.
  // The truth channels are Float32, ~6e-8 relative, and the resample is a linear interpolation of
  // an already 0.02 mL-sampled Gaussian: 1e-6 relative is a real assertion here.
  const m = {};
  for (const id of Object.keys(POOL_PEAKS)) {
    m[id] = poolMass_mg(config, idx, id);
    assertRel(pm.mass_mg[idx[id]], m[id], 1e-6, `pooled mass of ${id}`);
    assertRel(pm.meanConc_gL[idx[id]], m[id] / pm.V_pool_mL, 1e-6, `mean concentration of ${id}`);
  }
  const protein = m.WKI + m.mAb + m.AGG;
  assertRel(pm.purityMass_frac, m.mAb / protein, 1e-6, 'mass purity');
  assertRel(pm.aggregate_frac, m.AGG / protein, 1e-6, 'aggregate fraction');

  const eps = (id) => config.species[idx[id]].eps280_Lgcm;
  const area = eps('WKI') * m.WKI + eps('mAb') * m.mAb + eps('AGG') * m.AGG;
  assertRel(pm.purityArea_frac, eps('mAb') * m.mAb / area, 1e-6, 'A280 area purity');
  assert.ok(Math.abs(pm.purityArea_frac - pm.purityMass_frac) > 1e-4,
    'spec §2.12: mass purity and A280 area purity are different numbers');

  assertRel(pm.yield_frac, 0.5, 1e-6, 'step yield = pooled / delivered');
  assertRel(pm.lrv[idx.mAb], Math.log10(2), 1e-6, 'LRV of the product');
  assertRel(pm.lrv[idx.AGG], Math.log10(10), 1e-6, 'LRV of the aggregate');

  assertRel(pm.V_pool_mL, (grid.n - 1) * grid.dV_mL, 1e-12, 'V_pool = (i1 - i0) * dV');
  assertClose(pm.meanCond_mScm, 12.5, 1e-4, 'mean conductivity over the pool');
  assertClose(pm.meanPH, 5.25, 1e-4, 'mean pH over the pool');

  assertRel(pm.concentrationFactor, pm.meanConc_gL[idx.mAb] / config.load.productTiter_gL, 1e-12,
    'concentration factor');
  assertRel(pm.productivity_gLh, (m.mAb / config.column.V_mL) / (run.t_s / 3600), 1e-6,
    'productivity, g per L of column per hour');
  assertRel(pm.bufferConsumption_L_per_g, run.V_run_mL / m.mAb, 1e-6, 'buffer consumption');
});

test('§5.11.3 — poolMetrics(detector) over-reads by the impurity absorbance and cannot see purity', () => {
  const { config, run, idx } = syntheticPoolRun();
  const grid = buildVolumeGrid(config, run);
  const pm = poolMetrics(config, run, grid, 0, grid.n - 1, 'detector');
  assert.equal(pm.mode, 'detector');

  // Detector mode has one wavelength: the whole A280 area is attributed to the product at the
  // product's own extinction coefficient. The closed form is therefore the eps-weighted total
  // divided by eps_mAb — measurably larger than the true mAb mass.
  const eps = (id) => config.species[idx[id]].eps280_Lgcm;
  const m = {};
  for (const id of Object.keys(POOL_PEAKS)) m[id] = poolMass_mg(config, idx, id);
  const expected = (eps('WKI') * m.WKI + eps('mAb') * m.mAb + eps('AGG') * m.AGG) / eps('mAb');
  assertRel(pm.mass_mg[idx.mAb], expected, 1e-6, 'detector-mode product mass');
  assert.ok(pm.mass_mg[idx.mAb] > 1.05 * m.mAb, 'and it over-reads the truth by more than 5 %');

  // §6.20: a single-wavelength detector cannot resolve species, so purity is NaN — never 1.0.
  assert.ok(Number.isNaN(pm.purityMass_frac), 'detector-mode mass purity is NaN');
  assert.ok(Number.isNaN(pm.purityArea_frac), 'detector-mode area purity is NaN');
  assert.ok(Number.isNaN(pm.aggregate_frac), 'detector-mode aggregate fraction is NaN');
  assert.ok(Number.isNaN(pm.meanConc_gL[idx.AGG]), 'no per-species concentration in detector mode');
});

test('§6.20 — autoPool cuts exactly at the threshold, and rePool addresses the same grid', () => {
  const { config, run } = syntheticPoolRun();
  const grid = buildVolumeGrid(config, run);

  const T = 5.0;                                   // AU/cm
  const { i0, i1 } = autoPool(config, run, grid, { type: 'THRESHOLD', value: T, signal: 'UV_280' });
  assert.ok(i1 > i0, 'the pool is non-empty');
  // Exact definition: the window is the maximal contiguous run at or above the cut around the apex.
  assert.ok(grid.y[i0] >= T && grid.y[i1] >= T, 'both endpoints sit at or above the cut');
  assert.ok(i0 === 0 || grid.y[i0 - 1] < T, 'the sample before the pool is below the cut');
  assert.ok(i1 === grid.n - 1 || grid.y[i1 + 1] < T, 'the sample after the pool is below the cut');
  for (let k = i0; k <= i1; k++) assert.ok(grid.y[k] >= T, `the pool is contiguous above the cut at ${k}`);

  // A 10 %-of-apex cut is strictly wider than a fixed cut above 10 % of the apex.
  let apex = 0;
  for (let k = 1; k < grid.n; k++) if (grid.y[k] > grid.y[apex]) apex = k;
  const pct = autoPool(config, run, grid, { type: 'APEX_PCT', value: 10, signal: 'UV_280' });
  assert.ok(grid.y[apex] * 0.10 < T, 'the fixture really is wider at 10 % of apex');
  assert.ok(pct.i0 <= i0 && pct.i1 >= i1, 'APEX_PCT at 10 % contains the 5 AU/cm pool');

  // rePool by VOLUME indexes the same grid the metrics are computed on (§6.20).
  const r = rePool(config, run, grid, { type: 'VOLUME', startV_mL: 91, endV_mL: 109, mode: 'truth' });
  assertClose(grid.V[r.i0], 91, grid.dV_mL, 'rePool VOLUME start');
  assertClose(grid.V[r.i1], 109, grid.dV_mL, 'rePool VOLUME end');
  assertRel(r.metrics.V_pool_mL, (r.i1 - r.i0) * grid.dV_mL, 1e-12, 'rePool pool volume');

  // 91..109 mL is the mAb apex (100 mL) plus or minus 3 sigma, so the recovered fraction is the
  // closed-form erf(3/sqrt2) = 0.9973002. The 1e-3 band absorbs the grid's own +/-dV/2 on each cut.
  const idx = config.idxById;
  const full = poolMass_mg(config, idx, 'mAb');
  const captured = r.metrics.mass_mg[idx.mAb];
  const erf3 = 0.99730020393674;
  assertClose(captured / full, erf3, 1e-3,
    'a +/-3 sigma cut recovers erf(3/sqrt2) of the product');
});

/* ------------------------------------------------------------------------------------------- */
/* §5.11.4 — the mass balance                                                                   */
/* ------------------------------------------------------------------------------------------- */

test('§5.11.4 / §6.20 — massBalance closes to solver precision and reports an unflushed batch', () => {
  const config = normalizePreset('cex-capture-igg1-lab', {});
  const run = createRunState(config);
  createSkid(config, run);

  // A fresh column has moved nothing: every term is zero and xi is zero.
  const fresh = massBalance(config, run);
  assert.equal(fresh.flushed, true, 'a fresh run has no pending column batch');
  assert.equal(fresh.ok, true, 'and its balance closes');
  for (let i = 0; i < config.ns; i++) assert.equal(fresh.xi[i], 0, `xi[${i}] of a fresh run`);

  // §6.20: massBalance may not flush the bed itself, so it must REPORT an un-advanced batch and
  // refuse to claim closure.
  run.colBatch.dt_s = 0.05;
  const pending = massBalance(config, run);
  assert.equal(pending.flushed, false, 'an un-advanced batch is reported');
  assert.equal(pending.ok, false, 'and ok is false regardless of xi');
  run.colBatch.dt_s = 0;
  run.colBatch.carryDt_s = 0.05;
  assert.equal(massBalance(config, run).flushed, false, 'the carry counts as pending too');
  run.colBatch.carryDt_s = 0;

  // Controlled closure: in - out + defect - column = 0 by construction.
  //
  // THE SIGN OF `defect`, settled here because §5.11.4 prints the residual as
  // `in - out - column - defect` and that is not the balance the ledger it reads supports.
  // `defect_umol` is `col.massClamped_umol`, and physics/column.js accumulates it as the mass the
  // unsafe clamps CREATED (`massClamped += -c*Vcell` when a negative c is raised to zero). Mass
  // created enters on the INPUT side: in + defect = out + accumulation. The column plane says the
  // same thing structurally — column.js maintains `mass0 + in - out + clamped = now` and
  // `column_umol` is `now - mass0`, so `in - out - column` is IDENTICALLY `-clamped` before the
  // defect term is applied at all; subtracting it again returns exactly -2*defect/in and no
  // solver, however clean, can then satisfy DoD 7. (tests/column.test.js's
  // 'the column-plane ledger closes exactly' asserts that identity directly, at 1e-11.)
  // Adding dc to the interstitial phase of every cell of one species raises the column hold-up
  // by exactly epsC * dc * nz * Vcell umol, and mass0 was captured with that species at zero.
  const col = run.col;
  const i = config.idxById.mAb;
  const j = config.colIdxOf[i];
  assert.ok(j >= 0, 'the product is a transported species');
  const held_umol = 600;
  const dc_mM = held_umol / (col.epsC * col.nz * col.Vcell_mL);
  for (let cell = 0; cell < col.nz; cell++) col.c[j * col.nz + cell] += dc_mM;
  col.massIn_umol[j] = 1000;
  col.massOut_umol[j] = 400;
  run.massDefect_umol[i] = 0;

  const mb = massBalance(config, run);
  assertClose(mb.in_umol[i], 1000, 1e-12, 'in comes off the COLUMN plane');
  assertClose(mb.out_umol[i], 400, 1e-12, 'out comes off the COLUMN plane');
  assertClose(mb.column_umol[i], held_umol, 1e-9, 'column hold-up net of the initial charge');
  assertClose(mb.xi[i], 0, 1e-12, 'xi = (in - out + defect - column)/in');
  assert.equal(mb.ok, true, 'DoD item 7: |xi| < 1e-6 for every species');

  // A defect the size of the tolerance must open the balance — here by exactly +defect/in,
  // because this fixture injects the created mass into the ledger WITHOUT putting it into the
  // hold-up. On a real run the two move together and cancel; that is the point of the term.
  run.massDefect_umol[i] = 1000 * 2e-6;
  const broken = massBalance(config, run);
  assertClose(broken.xi[i], +2e-6, 1e-12, 'the defect enters xi on the input side');
  assert.equal(broken.ok, false, 'and |xi| >= 1e-6 fails the audit');
});

test('§5.11.4 — logDerived_umol re-integrates the truth channels and is reported separately', () => {
  const { config, run, idx } = syntheticPoolRun();
  const mb = massBalance(config, run);
  for (const id of Object.keys(POOL_PEAKS)) {
    const [C, , sg] = POOL_PEAKS[id];
    assertRel(mb.logDerived_umol[idx[id]], C * sg * SQRT_2PI, 1e-6,
      `log-derived amount of ${id} = C*sigma*sqrt(2pi)`);
  }
  // It is a logging-fidelity diagnostic only: it never enters xi, which is still zero here even
  // though the log carries 0.45 umol of product.
  assert.equal(mb.xi[idx.mAb], 0, 'logDerived never feeds xi');
});
