/**
 * tests/isotherm.test.js — src/physics/isotherm.js
 *
 * Contract: architecture-v2 §6.7 (module shape), §6.7.1 (normative solver notes), §6.7.2
 * (`relaxCell` body), §7.2.4 (Donnan group sums), §7.2.6 (the dispersive-wave chord), §10 (this
 * file's row);  spec-physics-2-isotherms §2.2.10 (the four worked solver traces), §2.2.5 (the fuzz
 * box and the iteration histogram), §2.5.5 (the `theta` reference table), §2.8 (T3…T14).
 *
 * TESTING POLICY FOLLOWED THROUGHOUT. Every SMA assertion is made against an INDEPENDENT
 * evaluation of the reduced residual
 *
 *     R(x) = e^x + SUM_j e^(lw_j + nu_j x) - 1,   lw_j = ln(nu_j+sig_j) + ln(Keq_j) + ln(c_j)
 *                                                        + nu_j*(lnLambda - ln csEff) - lnLambda
 *
 * re-derived here from the published SMA reduction — never against a number scraped out of the
 * implementation. `R` is three lines, so a bisection on it is a genuinely independent root finder
 * and the shipped Newton solve is checked against it, not the other way round. Where a value can
 * only be pinned (no closed form exists) the comment says so explicitly.
 *
 * UNITS. c, cs, q, q*, Lambda, X in mM; k_ov in 1/s; dt in s; V in mL; massDefect in umol.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeIsothermModel,
  computeQStar,
  ktLinear,
  theta,
  relaxCell,
  convertSMABasis,
  validateParams,
  chargeBalanceResidual,
  donnanK,
} from '../src/physics/isotherm.js';
import { normalizePreset } from '../src/data/presets.js';
import { buildColumnCfg } from '../src/physics/bed.js';

// ---------------------------------------------------------------------------
// Local fixtures and independent reference maths
// ---------------------------------------------------------------------------

/** The shipped `config.chem` solver constants (src/data/presets.js). */
const CHEM = { CS_MIN_mM: 1.0, C_MIN_mM: 1e-12, C_KT_mM: 1e-9, KT_MIN: 1e-3, KT_MAX: 1e6 };

/** A complete ColumnSpeciesConfig (§5.8.2) with every field defaulted, overridden by `o`. */
function sp(o) {
  return Object.assign({
    id: 'x', colIdx: 0, MW_gmol: 0, kind: 'binding', donnanRole: 'NONE',
    charge: 0, ionisedFraction: 1, epsPi: 0.85, concScale_mM: 0.05,
    Dm_cm2s: 4e-7, Dp_cm2s: 6e-8, keffScale: 1,
    nu: 0, sigma: 0, Keq: 0, qmax_mM: 0, b0_mM1: 0, beta_mM1: 0, csRef_mM: 0, Klin: 0,
  }, o);
}

/** `makeIsothermModel` with the shipped chem constants and sane resin defaults. */
function mk(mode, comps, resin = {}) {
  return makeIsothermModel(Object.assign({
    mode, Lambda_mM: 350, epsP: 0.85, resinChargeSign: 0, enableDonnan: false,
  }, CHEM, resin), comps);
}

/** Independent `lw_j` for one binding species — the published SMA reduction, re-derived here. */
function lwOf(Lambda_mM, csEff_mM, nu, sigma, Keq, c_mM) {
  return Math.log(nu + sigma) + Math.log(Keq) + Math.log(c_mM)
    + nu * (Math.log(Lambda_mM) - Math.log(csEff_mM)) - Math.log(Lambda_mM);
}

/** Independent residual R(x) over an active set given as parallel arrays. */
function Rres(lw, nu, x) {
  let r = Math.exp(x) - 1;
  for (let j = 0; j < lw.length; j++) {
    const a = lw[j] + nu[j] * x;
    if (a > -745) r += Math.exp(a);
  }
  return r;
}

/**
 * The same residual with `expm1` on the free-salt term. Identical mathematically, but accurate
 * when the root is close to 0: `Math.exp(x) - 1` loses every digit below |x| ~ 1e-8, which is
 * exactly the regime the trace-load fast path lives in. Used only where that matters.
 */
function RresAcc(lw, nu, x) {
  let r = Math.expm1(x);
  for (let j = 0; j < lw.length; j++) {
    const a = lw[j] + nu[j] * x;
    if (a > -745) r += Math.exp(a);
  }
  return r;
}

/** Independent derivative R'(x) > 0 (T1). */
function Rder(lw, nu, x) {
  let r = Math.exp(x);
  for (let j = 0; j < lw.length; j++) {
    const a = lw[j] + nu[j] * x;
    if (a > -745) r += nu[j] * Math.exp(a);
  }
  return r;
}

/**
 * Independent root of R by 200-step bisection on [lo, 0]. R is strictly increasing (T1) so the
 * bracket test is a plain sign test; 200 halvings drive the interval to ~1e-58 of its span, i.e.
 * to double round-off. This is the reference the shipped Newton solve is measured against.
 */
function bisectRoot(lw, nu, lo = -800) {
  let a = lo, b = 0;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (a + b);
    if (Rres(lw, nu, mid) > 0) b = mid; else a = mid;
  }
  return 0.5 * (a + b);
}

/** assert |actual-expected| <= relTol*|expected| with a readable message. */
function close(actual, expected, relTol, what) {
  const err = Math.abs(actual - expected) / (Math.abs(expected) || 1);
  assert.ok(err <= relTol,
    `${what}: got ${actual}, expected ${expected}, rel err ${err.toExponential(3)} > ${relTol}`);
}

/** Deterministic LCG — the fuzz must be reproducible byte for byte on every machine. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * A one-species (or n identical-species) SMA rig that realises an EXACT chosen `lw`.
 * With Lambda = 1 mM, cs = CS_MIN = 1 mM and sigma = 0 the reduction collapses to
 * `lw = ln(nu*Keq*c)`, so `Keq = e^lw / nu` at `c = 1 mM` hits any `lw` to one rounding.
 * This is what lets the §6.7.1 flank fixtures be stated in their own (nu, lw) coordinates.
 */
function flankRig(nu, lw, n = 1) {
  const comps = [];
  for (let k = 0; k < n; k++) {
    comps.push(sp({ id: `f${k}`, colIdx: k, nu, sigma: 0, Keq: Math.exp(lw) / nu, epsPi: 0 }));
  }
  const model = mk('SMA', comps, { Lambda_mM: 1 });
  const c = new Float64Array(n).fill(1);
  const q = new Float64Array(n);
  const out = new Float64Array(n);
  const it0 = model.diag.iterSum;
  const x = computeQStar(model, c, 1, q, out);
  return { model, x, out, iters: model.diag.iterSum - it0, lw: new Array(n).fill(lw),
    nu: new Array(n).fill(nu) };
}

// ---------------------------------------------------------------------------
// Model construction (§6.7)
// ---------------------------------------------------------------------------

test('§6.7 — makeIsothermModel: MAX_COMPONENTS = 24 boundary and the mode enum', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => sp({ id: `s${i}`, colIdx: i }));
  // 24 is the asserted ceiling; 24 must build, 25 must throw. Exact boundary, no tolerance.
  const ok = mk('SMA', many(24));
  assert.equal(ok.m, 24);
  assert.equal(ok.scratch.lw.length, 24, 'scratch must be MAX_COMPONENTS long, not m long');
  assert.throws(() => mk('SMA', many(25)), RangeError);

  for (const mode of ['SMA', 'LANGMUIR', 'HIC', 'SEC', 'LINEAR', 'INERT']) {
    assert.equal(mk(mode, many(1)).mode, mode);
  }
  // There is no 'IEX_' prefix anywhere (§6.7) — the enum is byte-identical to config.column.
  assert.throws(() => mk('IEX_SMA', many(1)), RangeError);
  assert.throws(() => mk(undefined, many(1)), RangeError);

  // X = Lambda/epsP, the pore fixed charge (§7.2.4). 350/0.85 = 411.76470588235293 exactly.
  close(mk('SMA', many(1)).X_mM, 350 / 0.85, 1e-15, 'X_mM');
});

test('§6.7 — scratch is PER-MODEL: two live models must not share it', () => {
  // The hazard is a module-scope scratch: model B's solve would overwrite model A's active set.
  // Interleaving the two calls must give bit-identical results to running A twice alone.
  const A = mk('SMA', [sp({ id: 'a', nu: 5.2, sigma: 575, Keq: 0.044, epsPi: 0.70 })]);
  const B = mk('SMA', [sp({ id: 'b', nu: 9, sigma: 638, Keq: 1.33, epsPi: 0.68 })]);
  assert.notEqual(A.scratch.lw, B.scratch.lw, 'scratch.lw must not be shared between models');

  const cA = Float64Array.from([0.3]);
  const oA1 = new Float64Array(1), oA2 = new Float64Array(1), oB = new Float64Array(1);
  const xA1 = computeQStar(A, cA, 80, new Float64Array(1), oA1);
  computeQStar(B, Float64Array.from([0.1]), 80, new Float64Array(1), oB);
  const xA2 = computeQStar(A, cA, 80, new Float64Array(1), oA2);
  assert.equal(xA1, xA2, 'x must be bit-identical across an interleaved foreign solve');
  assert.equal(oA1[0], oA2[0], 'q* must be bit-identical across an interleaved foreign solve');
});

// ---------------------------------------------------------------------------
// theta — T10, the §2.5.5 reference table
// ---------------------------------------------------------------------------

test('T10 — theta reference table (§2.5.5) to the printed digits', () => {
  // The table is printed to 12 significant figures, so 1e-11 relative is exactly the precision
  // the printed digits carry; a tighter tolerance would be testing the transcription, not theta.
  const table = [
    [1e-8, 9.99999995e-9],
    [1e-4, 9.99950001667e-5],
    [1e-2, 0.00995016625083],
    [0.1, 0.095162581964],
    [0.5, 0.393469340287],
    [1, 0.632120558829],
    [2, 0.864664716763],
    [5, 0.993262053001],
    [10, 0.99995460007],
    [20, 0.999999997939],
  ];
  for (const [u, expected] of table) close(theta(u), expected, 1e-11, `theta(${u})`);

  // The table's last row reads ">= 37 -> 1 exactly". It cannot be met: exp(-37) = 8.53e-17 is
  // still above half an ulp of 1 (5.55e-17), so the true 1-e^-37 is one ulp below 1 and NO
  // implementation can return exactly 1 there. Assert what is true — within one ulp — and assert
  // the normative branch threshold (u > 40) returns exactly 1.
  assert.ok(Math.abs(theta(37) - 1) <= Number.EPSILON, 'theta(37) within 1 ulp of 1');
  assert.equal(theta(41), 1, 'the u > 40 branch must return exactly 1');

  // Guards: theta(0)=0, negatives and NaN fall to 0 (they must never leak NaN into k_eff).
  assert.equal(theta(0), 0);
  assert.equal(theta(-1), 0);
  assert.equal(theta(NaN), 0);

  // The small-u branch must NOT be 1 - Math.exp(-u): at u = 1e-12 that form loses every
  // significant digit to cancellation. The series u*(1-u/2) is exact to 5e-25 there.
  close(theta(1e-12), 1e-12 * (1 - 0.5e-12), 1e-15, 'theta small-u series');
  assert.ok(theta(1e-12) !== 1 - Math.exp(-1e-12) || Math.abs(theta(1e-12) - 1e-12) < 1e-24,
    'small-u branch must be accurate, not the cancelling form');

  // theta is in [0,1) below the cutoff and monotone increasing.
  let prev = 0;
  for (let u = 0.001; u < 40; u *= 1.3) {
    const t = theta(u);
    assert.ok(t > prev && t < 1, `theta must be monotone and < 1 at u=${u}`);
    prev = t;
  }
});

// ---------------------------------------------------------------------------
// The §6.7.1 flank fixtures and the bracket that is NOT a bracket
// ---------------------------------------------------------------------------

test('§6.7.1 — flank fixture A (nu = 5.2, lw = -0.103) against an independent bisection', () => {
  const r = flankRig(5.2, -0.103);
  const ref = bisectRoot([-0.103], [5.2]);
  // The solver's root and a 200-step bisection on an independently coded R must agree to the
  // solver's own log-space tolerance TOL_X = 1e-10; observed agreement is at double round-off.
  assert.ok(Math.abs(r.x - ref) <= 1e-10,
    `root ${r.x} vs independent bisection ${ref}`);
  // And the residual at the returned root must be at TOL_R.
  assert.ok(Math.abs(Rres([-0.103], [5.2], r.x)) <= 1e-12, 'R(x*) must be <= TOL_R');
  assert.ok(r.iters <= 12, `iterations ${r.iters} must stay inside the T5 bound of 12`);
  // Independently derived reference value, printed here for the record: -0.262252114205.
  close(r.x, -0.262252114205, 1e-11, 'flank-A root');
});

test('§6.7.1 — flank fixture A, and why the contract-printed -0.26223 is wrong', () => {
  // CONTRACT CORRECTION (recorded, not swallowed). §6.7.1 and the §10 test table both print
  // -0.26223 as the root for (nu = 5.2, lw = -0.103). It is wrong in its 5th printed decimal:
  // the true root of e^x + e^(-0.103 + 5.2x) = 1 is -0.2622521142050684, reproduced to 12 digits
  // by the 200-step bisection on the independently coded R above, and leaving |R| = 0 exactly.
  // The fixture is internally INCONSISTENT because `lw` was itself rounded to three decimals:
  // dx/dlw = -1/R'(x) is -0.1172 at the root, so the +/-0.0005 of slack in "-0.103" is worth
  // +/-5.9e-5 in x — 2.7x the whole discrepancy. Below: lw = -0.10319, which is inside the
  // printed "-0.103", reproduces -0.26223 to its last digit. The contract must either print the
  // root as -0.262252 for lw = -0.103, or state lw to five decimals. The CODE is right.
  const r = flankRig(5.2, -0.103);

  // (a) the corrected anchor, at the precision it should be printed to.
  assert.ok(Math.abs(r.x - (-0.262252)) <= 5e-7,
    `corrected root -0.262252 vs solver ${r.x} (delta ${(r.x + 0.262252).toExponential(3)})`);

  // (b) the demonstration that -0.26223 is a rounding of lw, not an error in the solve: an lw
  // that still prints as "-0.103" lands exactly on the contract's number.
  const rounded = flankRig(5.2, -0.10319);
  assert.ok(Math.abs(rounded.x - (-0.26223)) <= 5e-6,
    `lw = -0.10319 must reproduce the contract-printed -0.26223; got ${rounded.x}`);

  // (c) the sensitivity that makes (b) an explanation rather than a coincidence. Implicit
  // differentiation of R(x, lw) = 0: dx/dlw = -(dR/dlw)/(dR/dx) = -e^(lw + nu*x) / R'(x).
  const dxdlw = -Math.exp(-0.103 + 5.2 * r.x) / Rder([-0.103], [5.2], r.x);
  close(dxdlw, -0.1172, 1e-3, 'dx/dlw at the root');
  close((rounded.x - r.x) / (-0.10319 - -0.103), dxdlw, 2e-3,
    'the measured lw sensitivity IS -1/R\'(x)');

  // (d) and the residual at the SHIPPED root is at round-off (8.3e-17, i.e. TOL_R is met with
  // four orders to spare); at the contract's -0.26223 it is 4.35e-5, which is 5e11 times larger.
  assert.ok(Math.abs(Rres([-0.103], [5.2], r.x)) <= 1e-12, 'R(x*) is zero to TOL_R');
  assert.ok(Math.abs(Rres([-0.103], [5.2], -0.26223)) > 1e-5,
    'R(-0.26223) is measurably non-zero, so -0.26223 is not a root of the printed fixture');
});

test('§6.7.1 — flank fixture B (nu = 9, lw = 0) -> -0.19322, and the 4-component case', () => {
  const b = flankRig(9, 0);
  close(b.x, -0.19322, 5e-6, 'flank-B root against the contract-printed -0.19322');
  assert.ok(Math.abs(b.x - bisectRoot([0], [9])) <= 1e-10, 'flank-B vs independent bisection');
  assert.ok(b.iters <= 12, `flank-B iterations ${b.iters}`);

  // Four components all at nu = 9, lw = 0 -> root -0.303 (§6.7.1).
  const f = flankRig(9, 0, 4);
  close(f.x, -0.303, 5e-4, 'four-component root against the contract-printed -0.303');
  assert.ok(Math.abs(f.x - bisectRoot([0, 0, 0, 0], [9, 9, 9, 9])) <= 1e-10,
    'four-component vs independent bisection');
  assert.ok(f.iters <= 12, `four-component iterations ${f.iters}`);
});

test('§6.7.1 — the closed-form left bracket x_start - ln(nAct+1)/nu_min does NOT bracket', () => {
  // This is the counter-example that forbids the closed form. An implementation that VALIDATED
  // that bracket would freeze every peak flank. All three residuals below are positive, i.e. no
  // sign change against R(x_start) >= 0, so [x_lo, x_start] contains no root at all.
  const cases = [
    { nu: 5.2, lw: -0.103, n: 1, printed: 0.326 },
    { nu: 9, lw: 0, n: 1, printed: 0.426 },
    { nu: 9, lw: 0, n: 4, printed: 0.636 },
  ];
  for (const { nu, lw, n, printed } of cases) {
    const lws = new Array(n).fill(lw), nus = new Array(n).fill(nu);
    const xStart = Math.min(0, -lw / nu);
    const xLoBroken = xStart - Math.log(n + 1) / nu;          // nu_min = min_j nu_j — the bug
    const R = Rres(lws, nus, xLoBroken);
    assert.ok(R > 0, `broken bracket must fail to bracket (nu=${nu}, n=${n}); R = ${R}`);
    close(R, printed, 1e-3, `§6.7.1 printed residual for nu=${nu}, n=${n}`);
    // ... and the true root is strictly to the LEFT of the claimed bracket.
    assert.ok(bisectRoot(lws, nus) < xLoBroken, 'the root lies outside the broken bracket');

    // The SHIPPED rule — nu_min = min(1, min_j nu_j), floor 0.5, then geometric widening —
    // does bracket, on the first evaluation, with no expansion needed.
    let nuMin = 1;
    for (const v of nus) if (v < nuMin) nuMin = v;
    const xLoFixed = xStart - Math.max(Math.log(n + 1) / nuMin, 0.5);
    assert.ok(Rres(lws, nus, xLoFixed) <= 0,
      `repaired bracket must bracket (nu=${nu}, n=${n})`);
  }
});

test('§6.7.1 — the shipped bracket rule brackets over a 40 000-case sweep', () => {
  // Sweeps the RULE, in the (lw, nu) coordinates the solver actually works in, over the whole
  // range lw can reach under the LW_MAX = 700 overflow envelope. Two claims are checked:
  //   (a) the repaired closed form + geometric widening always reaches R(x_lo) <= 0, well inside
  //       BRACKET_MAX_EXPANSIONS = 60;
  //   (b) the closed form of the rejected draft fails on a measurable fraction of ordinary cases,
  //       so the counter-examples above are not curiosities.
  const U = lcg(0x5eed01);
  const lin = (a, b) => a + U() * (b - a);
  let maxExpansions = 0, brokenFails = 0, shippedFails = 0;
  const N = 40000;
  for (let k = 0; k < N; k++) {
    const m = 1 + Math.floor(U() * 4);
    const lw = [], nu = [];
    for (let i = 0; i < m; i++) { nu.push(lin(0.05, 30)); lw.push(lin(-200, 200)); }

    let xStart = 0, nuMinBroken = Infinity, nuMin = 1;
    for (let i = 0; i < m; i++) {
      const xi = -lw[i] / nu[i];
      if (xi < xStart) xStart = xi;
      if (nu[i] < nuMinBroken) nuMinBroken = nu[i];
      if (nu[i] < nuMin) nuMin = nu[i];
    }
    if (Rres(lw, nu, xStart - Math.log(m + 1) / nuMinBroken) > 0) brokenFails++;

    let xLo = xStart - Math.max(Math.log(m + 1) / nuMin, 0.5);
    let e = 0;
    for (; e < 60; e++) { if (Rres(lw, nu, xLo) <= 0) break; xLo -= (xStart - xLo); }
    if (e > maxExpansions) maxExpansions = e;
    if (Rres(lw, nu, xLo) > 0) shippedFails++;
  }
  assert.equal(shippedFails, 0, 'the shipped bracket rule must bracket in every case');
  assert.ok(maxExpansions < 60, `geometric widening used ${maxExpansions} expansions (cap 60)`);
  assert.ok(brokenFails > N / 1000,
    `the closed form must be shown to fail on real cases; it failed ${brokenFails}/${N}`);
});

test('§6.7.1 T7 — undamped Newton from x_start converges globally with NO left bracket', () => {
  // The shipped guarantee: R convex + strictly increasing + R(x0) >= 0 => plain Newton from x0
  // decreases monotonically, never crosses the root, and converges. Verified directly on the
  // independent R over a sweep, which is what licenses shipping without bracket validation.
  const U = lcg(0x5eed02);
  const lin = (a, b) => a + U() * (b - a);
  let maxIters = 0;
  for (let k = 0; k < 20000; k++) {
    const m = 1 + Math.floor(U() * 4);
    const lw = [], nu = [];
    for (let i = 0; i < m; i++) { nu.push(lin(0.05, 30)); lw.push(lin(-60, 60)); }

    let x = 0;
    for (let i = 0; i < m; i++) { const xi = -lw[i] / nu[i]; if (xi < x) x = xi; }
    // T4 and T7 are theorems in EXACT arithmetic. In float64 the term that attains the minimum
    // evaluates `lw_j + nu_j*(-lw_j/nu_j)` with cancellation of magnitude |lw_j| + nu_j*|x|, so
    // the residual can sit a few ulps of that scale below zero. `slack` is that bound, derived —
    // not tuned: it is the largest exponent argument formed, times a few machine epsilons.
    let scale = 1;
    for (let i = 0; i < m; i++) scale = Math.max(scale, Math.abs(lw[i]) + nu[i] * Math.abs(x));
    const slack = 8 * Number.EPSILON * scale;
    assert.ok(Rres(lw, nu, x) >= -slack, 'T4: R(x_start) >= 0');
    assert.ok(Rder(lw, nu, x) > 0, 'T1: R is strictly increasing');

    let it = 0, prev = Infinity;
    for (; it < 30; it++) {
      const R = Rres(lw, nu, x);
      // Never crosses: the iterate stays on the R >= 0 side to within double round-off.
      assert.ok(R >= -slack, `Newton crossed the root at iteration ${it}, R = ${R}`);
      if (Math.abs(R) <= slack) break;
      const step = -R / Rder(lw, nu, x);
      assert.ok(step <= slack, 'the Newton step must be non-positive from the right bracket');
      x += step;
      assert.ok(x <= prev + slack, 'the iterate sequence must be monotonically decreasing');
      prev = x;
    }
    assert.ok(it < 30, 'undamped Newton must converge inside ITER_MAX = 30');
    if (it > maxIters) maxIters = it;
  }
  assert.ok(maxIters <= 12, `worst-case iterations ${maxIters} must stay inside the T5 bound 12`);
});

// ---------------------------------------------------------------------------
// The four worked solver traces — spec-physics-2 §2.2.10
// ---------------------------------------------------------------------------

// Lambda = 180 mM, lysozyme nu = 4.5, sigma = 50, Keq = 0.383, eps_p = 0.85.
const LYSO = { Lambda: 180, nu: 4.5, sigma: 50, Keq: 0.383, epsPi: 0.85 };

function lysoSolve(c_mM, cs_mM, Lambda = LYSO.Lambda) {
  const model = mk('SMA', [sp({
    id: 'lyz', nu: LYSO.nu, sigma: LYSO.sigma, Keq: LYSO.Keq, epsPi: LYSO.epsPi,
  })], { Lambda_mM: Lambda });
  const c = Float64Array.from([c_mM]);
  const out = new Float64Array(1);
  const it0 = model.diag.iterSum;
  const x = computeQStar(model, c, cs_mM, new Float64Array(1), out);
  return {
    model, x, iters: model.diag.iterSum - it0,
    qbar_s: Lambda * Math.exp(x),
    qAds: out[0] - LYSO.epsPi * c_mM,          // strip the BASIS N1 pore-liquid term
    Kt: out[0] / c_mM,
    lw: lwOf(Lambda, Math.max(cs_mM, 1), LYSO.nu, LYSO.sigma, LYSO.Keq, c_mM),
  };
}

test('§2.2.10 trace 1 — load, c = 0.350 mM, cs = 50 mM, to the printed digits', () => {
  const r = lysoSolve(0.350, 50);
  // The full printed Newton table, reproduced with an INDEPENDENT R/R' and an independent
  // undamped Newton from x_start. Every row must match its printed digits.
  const rows = [
    [-0.568867498013, 5.6617e-1, 5.0662e+0],
    [-0.680621876196, 1.1108e-1, 3.2278e+0],
    [-0.715035249811, 7.1879e-3, 2.8202e+0],
    [-0.717583938744, 3.5527e-5, 2.7924e+0],
    [-0.717596661591, 8.7879e-10, 2.7923e+0],
    [-0.717596661906, 2.2204e-16, 2.7923e+0],
  ];
  const lw = [r.lw], nu = [LYSO.nu];
  let x = Math.min(0, -r.lw / LYSO.nu);
  for (let i = 0; i < rows.length; i++) {
    const [xe, Re, Rpe] = rows[i];
    close(x, xe, 5e-12, `trace 1 x at iteration ${i + 1}`);      // 12 printed decimals
    close(Rres(lw, nu, x), Re, 5e-4, `trace 1 R at iteration ${i + 1}`);   // 5 printed digits
    close(Rder(lw, nu, x), Rpe, 5e-4, `trace 1 R' at iteration ${i + 1}`);
    x -= Rres(lw, nu, x) / Rder(lw, nu, x);
  }
  // The shipped solver must land on the same root.
  close(r.x, -0.717596661906, 1e-12, 'trace 1 root');
  // Printed results. qbar_s 87.8262 mM, q_ads 1.6913 mM, secant q/c 4.832, Kt = eps_p + q/c 5.682,
  // 51.2 % of Lambda consumed. Tolerances are the printed precision of each figure.
  close(r.qbar_s, 87.8262, 1e-6, 'trace 1 qbar_s');
  close(r.qAds, 1.6913, 3e-5, 'trace 1 q_ads');
  close(r.qAds / 0.350, 4.832, 2e-4, 'trace 1 secant q/c');
  close(r.Kt, 5.682, 2e-4, 'trace 1 Kt = eps_p + q/c');
  close((LYSO.nu + LYSO.sigma) * r.qAds / LYSO.Lambda, 0.512, 1e-3, 'trace 1 saturation');
  // The printed iteration count follows from the printed R column and TOL_R = 1e-12: row 5 has
  // |R| = 8.8e-10 > TOL_R so a sixth pass is required, and row 6 stops. Not a free parameter.
  assert.equal(r.iters, 6, 'trace 1 iteration count');
});

test('§2.2.10 traces 2 and 3 — elution and overload, to the printed digits', () => {
  // Trace 2 — elution, c = 0.350 mM, cs = 150 mM: qbar_s 167.87, q_ads 0.2225, Kt 1.486,
  // 6.7 % saturation, 5 iterations, and x_start = 0 because the salt term wins the min.
  const t2 = lysoSolve(0.350, 150);
  assert.equal(Math.min(0, -t2.lw / LYSO.nu), 0, 'trace 2 x_start must be 0');
  close(t2.qbar_s, 167.87, 1e-4, 'trace 2 qbar_s');
  close(t2.qAds, 0.2225, 2e-4, 'trace 2 q_ads');
  close(t2.Kt, 1.486, 5e-4, 'trace 2 Kt');
  close((LYSO.nu + LYSO.sigma) * t2.qAds / LYSO.Lambda, 0.067, 1e-2, 'trace 2 saturation');
  assert.equal(t2.iters, 5, 'trace 2 iteration count');
  assert.ok(Math.abs(t2.x - bisectRoot([t2.lw], [LYSO.nu])) <= 1e-10, 'trace 2 vs bisection');

  // Trace 3 — overload, c = 3.50 mM (10x trace 1), cs = 50 mM: qbar_s 56.22, q_ads 2.2713,
  // 68.8 % saturation, 5 iterations. The point of the trace is that a 10x rise in c lifts q_ads
  // by only 34 % and it stays below q_max = Lambda/(nu+sigma) = 3.303 mM.
  const t3 = lysoSolve(3.50, 50);
  const t1 = lysoSolve(0.350, 50);
  close(t3.qbar_s, 56.22, 1e-4, 'trace 3 qbar_s');
  close(t3.qAds, 2.2713, 3e-5, 'trace 3 q_ads');
  close((LYSO.nu + LYSO.sigma) * t3.qAds / LYSO.Lambda, 0.688, 1e-3, 'trace 3 saturation');
  assert.equal(t3.iters, 5, 'trace 3 iteration count');
  const qmax = LYSO.Lambda / (LYSO.nu + LYSO.sigma);
  close(qmax, 3.303, 1e-3, 'trace 3 q_max');
  assert.ok(t3.qAds < qmax, 'SMA is structurally self-limiting: q_ads < q_max always');
  close(t3.qAds / t1.qAds - 1, 0.34, 0.02, 'trace 3 rise over trace 1');
});

test('§2.2.10 trace 4 — two-component displacement, charge balance exact', () => {
  // Lambda = 1200, cs = 100; A: Keq 5e-4, nu 4.5, sigma 50, c 0.3; B: Keq 2e-3, nu 5.5,
  // sigma 44, c 0.2. Printed: 6 iterations, qbar_s 637.8490, q_A 0.6271, q_B 10.6662, and
  // qbar_s + SUM (nu+sigma) q = 1200.0000000000 exactly.
  const comps = [
    sp({ id: 'A', colIdx: 0, nu: 4.5, sigma: 50, Keq: 5e-4, epsPi: 0.85 }),
    sp({ id: 'B', colIdx: 1, nu: 5.5, sigma: 44, Keq: 2e-3, epsPi: 0.85 }),
  ];
  const model = mk('SMA', comps, { Lambda_mM: 1200 });
  const c = Float64Array.from([0.3, 0.2]);
  const out = new Float64Array(2);
  const it0 = model.diag.iterSum;
  const x = computeQStar(model, c, 100, new Float64Array(2), out);
  const iters = model.diag.iterSum - it0;
  const qA = out[0] - 0.85 * 0.3, qB = out[1] - 0.85 * 0.2;

  close(1200 * Math.exp(x), 637.8490, 1e-6, 'trace 4 qbar_s');
  close(qA, 0.6271, 1e-4, 'trace 4 q_A');
  close(qB, 10.6662, 1e-5, 'trace 4 q_B');
  assert.equal(iters, 6, 'trace 4 iteration count');

  // Charge balance to the printed ten decimals. This is the T4 identity: R(x) = 0 multiplied
  // through by Lambda, so it is exact to double round-off, not merely close.
  const bal = 1200 * Math.exp(x) + 54.5 * qA + 49.5 * qB;
  close(bal, 1200, 1e-12, 'trace 4 qbar_s + SUM (nu+sigma) q = Lambda');

  // The displacement statement the trace exists to make: the minor, stronger-binding component
  // takes ~17x more capacity than the major one despite the lower liquid concentration.
  // 10.6662/0.6271 = 17.01 from the printed values themselves.
  close(qB / qA, 17.01, 1e-3, 'trace 4 capacity ratio B:A');
  assert.ok(c[1] < c[0], 'B is the MINOR component in the liquid phase');

  // ... and the shipped chargeBalanceResidual agrees.
  assert.ok(chargeBalanceResidual(model, c, 100, out) <= 1e-9, 'T4 residual <= 1e-9');
});

// ---------------------------------------------------------------------------
// Structural properties of the SMA equilibrium
// ---------------------------------------------------------------------------

test('T3 — SMA with all nu_i = 1 reproduces closed-form competitive Langmuir', () => {
  // Analytic identity. With nu_i = 1 the reduction closes: e^x (1 + SUM e^lw_j) = 1, so
  //   q_ads,i = Lambda*Keq_i*c_i / (cs + SUM_j (1+sigma_j)*Keq_j*c_j)
  // which is competitive Langmuir with q_max,i = Lambda/(1+sigma_i) and
  // b_i = (1+sigma_i)*Keq_i/cs. The two modes are then independent code paths computing the
  // same number, which is why this is a real cross-check of the SMA solver.
  const L = 350, cs = 120;
  const P = [
    { sig: 69, Keq: 0.018, eps: 0.85, c: 0.30 },
    { sig: 575, Keq: 0.044, eps: 0.70, c: 0.12 },
    { sig: 1473, Keq: 0.0415, eps: 0.45, c: 0.05 },
  ];
  const smaModel = mk('SMA',
    P.map((p, i) => sp({ id: `s${i}`, colIdx: i, nu: 1, sigma: p.sig, Keq: p.Keq, epsPi: p.eps })),
    { Lambda_mM: L });
  const lanModel = mk('LANGMUIR',
    P.map((p, i) => sp({
      id: `s${i}`, colIdx: i, epsPi: p.eps,
      qmax_mM: L / (1 + p.sig), b0_mM1: (1 + p.sig) * p.Keq / cs, beta_mM1: 0, csRef_mM: 0,
    })), { Lambda_mM: L });

  const c = Float64Array.from(P.map((p) => p.c));
  const oS = new Float64Array(3), oL = new Float64Array(3);
  const x = computeQStar(smaModel, c, cs, new Float64Array(3), oS);
  computeQStar(lanModel, c, cs, new Float64Array(3), oL);
  for (let i = 0; i < 3; i++) close(oS[i], oL[i], 1e-12, `T3 q*[${i}] SMA vs Langmuir`);

  // The closed form for qbar_s itself.
  const denom = 1 + P.reduce((a, p) => a + (1 + p.sig) * p.Keq * p.c / cs, 0);
  close(L * Math.exp(x), L / denom, 1e-12, 'T3 qbar_s closed form');
});

test('T4 — charge balance qbar_s + SUM (nu+sigma) q_ads = Lambda, every composition', () => {
  const comps = [
    sp({ id: 'WKI', colIdx: 0, nu: 3.5, sigma: 69, Keq: 0.018, epsPi: 0.85 }),
    sp({ id: 'mAb', colIdx: 1, nu: 5.2, sigma: 575, Keq: 0.044, epsPi: 0.70 }),
    sp({ id: 'AGG', colIdx: 2, nu: 7, sigma: 1473, Keq: 0.0415, epsPi: 0.45 }),
    sp({ id: 'SBI', colIdx: 3, nu: 9, sigma: 638, Keq: 1.33, epsPi: 0.68 }),
  ];
  const model = mk('SMA', comps, { Lambda_mM: 350 });
  const out = new Float64Array(4);
  let worst = 0;
  for (const cs of [1, 5, 50, 150, 500, 1000]) {
    for (const scale of [1e-9, 1e-6, 1e-3, 0.05, 1, 20]) {
      const c = Float64Array.from([0.9, 1.7, 0.3, 0.05].map((v) => v * scale));
      const x = computeQStar(model, c, cs, new Float64Array(4), out);
      assert.ok(!Number.isNaN(x) && x <= 0, `x must be <= 0 and finite (cs=${cs})`);
      let sum = 350 * Math.exp(x);
      for (let i = 0; i < 4; i++) {
        sum += (comps[i].nu + comps[i].sigma) * (out[i] - comps[i].epsPi * c[i]);
      }
      const rel = Math.abs(sum - 350) / 350;
      if (rel > worst) worst = rel;
      // 1e-9 relative is the T4 acceptance criterion of §2.8.
      assert.ok(rel <= 1e-9, `charge balance ${sum} vs 350 at cs=${cs}, scale=${scale}`);
      assert.ok(chargeBalanceResidual(model, c, cs, out) <= 1e-9, 'chargeBalanceResidual');
    }
  }
  assert.ok(worst < 1e-9, `worst relative charge-balance error ${worst.toExponential(2)}`);
});

test('§6.7.1 — monotone in salt and in load; q_ads never reaches Lambda/(nu+sigma)', () => {
  const model = mk('SMA', [sp({ id: 'mAb', nu: 5.2, sigma: 575, Keq: 0.044, epsPi: 0.70 })]);
  const qmax = 350 / (5.2 + 575);
  const out = new Float64Array(1);

  // (a) Monotone in the modulator: raising cs must strictly reduce the bound amount and
  // strictly raise x (more free capacity). Physical, and required for a well-posed gradient.
  let prevQ = Infinity, prevX = -Infinity;
  for (let cs = 1; cs <= 800; cs += 1) {
    const x = computeQStar(model, Float64Array.from([0.05]), cs, new Float64Array(1), out);
    const qAds = out[0] - 0.70 * 0.05;
    assert.ok(qAds < prevQ, `q_ads must strictly decrease with salt (cs=${cs})`);
    assert.ok(x > prevX, `x must strictly increase with salt (cs=${cs})`);
    prevQ = qAds; prevX = x;
  }

  // (b) Monotone and SATURATING in load: q_ads rises, the secant q_ads/c falls (concavity),
  // and q_ads never touches the structural ceiling Lambda/(nu+sigma). The ceiling is exact:
  // R(x) = 0 forces every term e^(lw_j+nu_j x) < 1, hence q_ads,j < Lambda/(nu_j+sigma_j).
  // Run on epsPi = 0 so `out` IS the adsorbed amount: at c = 1e12 mM the pore term epsPi*c is
  // 12 orders above q_ads and subtracting it out would leave nothing but round-off. The two
  // terms are additive and the pore one is exactly linear, so nothing under test is lost.
  const bare = mk('SMA', [sp({ id: 'mAb', nu: 5.2, sigma: 575, Keq: 0.044, epsPi: 0 })]);
  let lastQ = -Infinity, lastSecant = Infinity, lastX = Infinity;
  for (const c of [1e-9, 1e-7, 1e-5, 1e-3, 0.01, 0.1, 1, 10, 100, 1e4, 1e6, 1e9, 1e12]) {
    const x = computeQStar(bare, Float64Array.from([c]), 50, new Float64Array(1), out);
    const qAds = out[0];
    assert.ok(qAds > lastQ, `q_ads must increase with load (c=${c})`);
    assert.ok(qAds < qmax, `q_ads ${qAds} must stay strictly below q_max ${qmax} (c=${c})`);
    assert.ok(qAds / c < lastSecant, `the secant must fall (concavity) at c=${c}`);
    assert.ok(x < lastX, `x must fall with load (c=${c})`);
    // Capacity utilisation is exactly 1 - e^x. Stated in the Lambda-normalised form, which is
    // the well-conditioned one and is literally the T4 acceptance identity; a ratio form would
    // carry a meaningless relative error at light load, where both sides are ~1e-6 while the
    // solver's TOL_R = 1e-12 is ABSOLUTE. Evaluated with expm1 for the same reason theta may
    // never be written as 1 - exp(-u).
    // Tolerance 1e-9 is T4's published criterion and is exactly what the solver can promise: it
    // may also stop on |step| <= TOL_X = 1e-10, and step = R/R' with R' <= e^x + nu_max, so the
    // residual it leaves behind is bounded by 1e-10*(1+nu) = 6.2e-10 at this nu = 5.2.
    const closure = Math.abs(350 * -Math.expm1(x) - (5.2 + 575) * qAds) / 350;
    assert.ok(closure <= 1e-9,
      `utilisation identity at c=${c}: closes to ${closure.toExponential(3)} of Lambda`);
    lastQ = qAds; lastSecant = qAds / c; lastX = x;
  }
  // How fast the ceiling is approached is set by the isotherm, not by the solver: the free
  // fraction goes as e^x ~ c^(-1/nu), so at nu = 5.2 each decade of load removes only 36 % of
  // what is left. At c = 1e12 mM that leaves 1 - q/q_max ~ 1.2e-3. Approached, never reached.
  assert.ok(lastQ / qmax > 0.998, `at c = 1e12 mM q_ads/q_max = ${lastQ / qmax} must exceed 0.998`);
  assert.ok(lastQ < qmax, 'and never reached — SMA is structurally self-limiting');
});

test('T14 — zero-salt excursion: csEff = max(cs, CS_MIN) in a LOCAL copy only', () => {
  const model = mk('SMA', [sp({ id: 'mAb', nu: 5.2, sigma: 575, Keq: 0.044, epsPi: 0.70 })]);
  const c = Float64Array.from([0.05]);
  const at = (cs) => {
    const out = new Float64Array(1);
    const x = computeQStar(model, c, cs, new Float64Array(1), out);
    return { x, q: out[0] };
  };
  const ref = at(CHEM.CS_MIN_mM);
  // cs = 0, cs < CS_MIN and even cs < 0 must all produce the CS_MIN answer, bit for bit.
  for (const cs of [0, 1e-12, 0.5, -5]) {
    const r = at(cs);
    assert.equal(r.x, ref.x, `x at cs=${cs} must equal the CS_MIN answer exactly`);
    assert.equal(r.q, ref.q, `q* at cs=${cs} must equal the CS_MIN answer exactly`);
    assert.ok(Number.isFinite(r.x) && r.q >= 0, 'no NaN, no negative q at zero salt');
  }
  // The clamp must not be written back — c is the only array the function may touch, and cs is
  // a number, so the observable statement is that the column holds ALL the protein at zero salt.
  const q = new Float64Array(1);
  const cc = Float64Array.from([0.05]);
  relaxCell(model, cc, q, 0, Float64Array.from([0.03]), 5, (1 - 0.35) / 0.35, 1.3744,
    new Float64Array(1), new Float64Array(1));
  assert.ok(q[0] > 0 && Number.isFinite(q[0]), 'protein must bind, finitely, at cs = 0');
  assert.ok(cc[0] >= 0, 'c must stay non-negative at cs = 0');
});

test('§2.3.3 — zero-protein limit: c = 0 and c below C_MIN give the pore term only', () => {
  const comps = [
    sp({ id: 'mAb', colIdx: 0, nu: 5.2, sigma: 575, Keq: 0.044, epsPi: 0.70 }),
    sp({ id: 'tracer', colIdx: 1, kind: 'inert', epsPi: 0.85 }),
  ];
  const model = mk('SMA', comps);
  const out = new Float64Array(2);

  // All components absent -> fast path A: qbar_s = Lambda, x = 0 exactly, q* = 0.
  const x0 = computeQStar(model, Float64Array.from([0, 0]), 50, new Float64Array(2), out);
  assert.equal(x0, 0, 'x must be exactly 0 when nothing is bound');
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);

  // Below C_MIN = 1e-12 the component is dropped from the active set, but it must still get its
  // pore term epsPi*c — dropping it would break the SEC/tracer path and shift the flow-through.
  const cTiny = Float64Array.from([1e-15, 2e-13]);
  const x1 = computeQStar(model, cTiny, 50, new Float64Array(2), out);
  assert.equal(x1, 0, 'x must be exactly 0 when every c is below C_MIN');
  assert.equal(out[0], 0.70 * 1e-15, 'pore term must survive the drop');
  assert.equal(out[1], 0.85 * 2e-13, 'inert species always get the pore term');

  // Just above C_MIN the component re-enters the active set and q* exceeds the pore term.
  const x2 = computeQStar(model, Float64Array.from([1e-11, 0]), 50, new Float64Array(2), out);
  assert.ok(x2 < 0, 'x must go negative once a component binds');
  assert.ok(out[0] > 0.70 * 1e-11, 'q* must exceed the pore term once bound');
});

test('§2.2.9 fast path C — the trace-load linearisation lands on the true root', () => {
  // When SUM e^lw < 1e-8 the solver skips Newton and uses x = -S - S^2/2, i.e. ln(1-S) to
  // O(S^3). Checked against the independent residual: |R| must still be at round-off, and the
  // path must genuinely be taken (zero Newton iterations).
  for (const S of [1e-9, 1e-10, 1e-12]) {
    for (const nu of [1, 15]) {
      const r = flankRig(nu, Math.log(S));
      assert.equal(r.iters, 0, `fast path C must run zero Newton iterations (S=${S}, nu=${nu})`);
      // Bound derived, not tuned. The exact root satisfies x*(1 + S*nu) = -S - x^2/2 + O(S^3),
      // so x_true = -S - S^2/2 + nu*S^2 + O(S^3) while the shipped shortcut is -S - S^2/2.
      // R'(x) -> 1, hence |R| ~ nu*S^2; 2*S^2*(nu+1) is that with a factor-2 margin. Evaluated
      // with expm1 because |x| ~ 1e-9 makes `exp(x)-1` pure cancellation noise at ~1e-16.
      const bound = 2 * S * S * (nu + 1);
      const R = RresAcc([Math.log(S)], [nu], r.x);
      assert.ok(Math.abs(R) <= bound,
        `fast-path residual ${R} exceeds the O(S^2) bound ${bound} (S=${S}, nu=${nu})`);
      close(r.x, Math.log1p(-S), 2 * S, `fast path C x vs ln(1-S) (S=${S})`);
    }
  }
});

test('T5 — 200 000-case SMA fuzz, sigma <= 5000: finite, positive, converged, balanced', () => {
  // Box: the §2.2.5 fuzz box widened to sigma <= 5000 per §10 (the shipped AGG sigma is 1473).
  //   Lambda [50,3000] mM, m in {1..4}, cs [0.1,1000] mM, Keq [1e-9,1e3], nu [0.5,15],
  //   sigma [0.01,5000], c [1e-9,32] mM.
  // Pass criteria (§2.8 T5): zero non-finite, zero ITER_MAX exhaustions, max iterations <= 12.
  // Added here: |R(x)| at the returned root, evaluated from an INDEPENDENTLY recomputed lw, and
  // strict positivity / capacity containment of every q*.
  const U = lcg(20260731);
  const logU = (a, b) => Math.exp(Math.log(a) + U() * (Math.log(b) - Math.log(a)));
  const lin = (a, b) => a + U() * (b - a);

  const MAXM = 4;
  const c = new Float64Array(MAXM), out = new Float64Array(MAXM), q = new Float64Array(MAXM);
  let maxIter = 0, worstR = 0, worstBal = 0;
  const N = 200000;

  for (let k = 0; k < N; k++) {
    const m = 1 + Math.floor(U() * 4);
    const Lambda = lin(50, 3000);
    const cs = logU(0.1, 1000);
    const comps = [];
    for (let i = 0; i < m; i++) {
      comps.push(sp({
        id: `s${i}`, colIdx: i, epsPi: lin(0.1, 0.9),
        nu: lin(0.5, 15), sigma: logU(0.01, 5000), Keq: logU(1e-9, 1e3),
      }));
      c[i] = logU(1e-9, 32);
    }
    const model = mk('SMA', comps, { Lambda_mM: Lambda, epsP: 0.9 });
    const cv = c.subarray(0, m), ov = out.subarray(0, m), qv = q.subarray(0, m);
    const x = computeQStar(model, cv, cs, qv, ov);

    assert.ok(!Number.isNaN(x), `case ${k}: computeQStar returned NaN (an F2 freeze)`);
    assert.ok(Number.isFinite(x) && x <= 0, `case ${k}: x = ${x} must be finite and <= 0`);
    assert.equal(model.diag.smaFrozen, 0, `case ${k}: no cell may freeze on healthy parameters`);
    assert.equal(model.diag.smaNonConverged, 0, `case ${k}: ITER_MAX must not be exhausted`);
    const iters = model.diag.iterSum;
    if (iters > maxIter) maxIter = iters;

    // Independent residual at the returned root.
    const csEff = Math.max(cs, CHEM.CS_MIN_mM);
    let R = Math.exp(x) - 1;
    let bal = Lambda * Math.exp(x);
    for (let i = 0; i < m; i++) {
      const s = comps[i], ci = cv[i];
      assert.ok(Number.isFinite(ov[i]), `case ${k}: q*[${i}] is not finite`);
      assert.ok(ov[i] >= 0, `case ${k}: q*[${i}] = ${ov[i]} is negative`);
      const qAds = ov[i] - s.epsPi * ci;
      assert.ok(qAds >= -1e-15, `case ${k}: adsorbed amount ${qAds} is negative`);
      assert.ok(qAds < Lambda / (s.nu + s.sigma) + 1e-15,
        `case ${k}: q_ads ${qAds} breached the structural ceiling`);
      bal += (s.nu + s.sigma) * qAds;
      const lw = lwOf(Lambda, csEff, s.nu, s.sigma, s.Keq, ci);
      if (!Number.isFinite(lw)) continue;
      const a = lw + s.nu * x;
      if (a > -745) R += Math.exp(a);
    }
    // 1e-9 vs the solver's own TOL_R = 1e-12: recomputing lw here costs O(m*eps*|lw|) which is
    // amplified through exp(), so 1e-9 is the honest bound on an INDEPENDENT evaluation. A
    // genuine solver failure produces |R| of order 0.1-1, three orders above this.
    if (Math.abs(R) > worstR) worstR = Math.abs(R);
    assert.ok(Math.abs(R) <= 1e-9, `case ${k}: independent residual ${R}`);
    const relBal = Math.abs(bal - Lambda) / Lambda;
    if (relBal > worstBal) worstBal = relBal;
    assert.ok(relBal <= 1e-9, `case ${k}: charge balance off by ${relBal}`);
  }
  assert.ok(maxIter <= 12,
    `T5 requires max iterations <= 12; observed ${maxIter} over ${N} cases`);
  assert.ok(worstR <= 1e-9 && worstBal <= 1e-9,
    `worst |R| ${worstR.toExponential(2)}, worst balance ${worstBal.toExponential(2)}`);
});

test('§6.7 — computeQStar return contract: 0 for every non-SMA mode, NaN only on freeze', () => {
  // v1 left the non-SMA return unspecified while relaxCell used isNaN(x) as the freeze signal,
  // which froze every cell forever in every non-IEX preset (§11 C-11). Exact equality to 0 is
  // the contract; a tolerance here would defeat the point.
  const comps = () => [
    sp({ id: 'a', colIdx: 0, nu: 5, sigma: 100, Keq: 0.05, qmax_mM: 2, b0_mM1: 0.01,
      beta_mM1: 0.001, Klin: 1.5, epsPi: 0.70 }),
    sp({ id: 'b', colIdx: 1, kind: 'inert', epsPi: 0.85 }),
    sp({ id: 'na', colIdx: 2, kind: 'donnan', donnanRole: 'COUNTER', charge: 1, epsPi: 0.85 }),
  ];
  for (const mode of ['LANGMUIR', 'HIC', 'SEC', 'LINEAR', 'INERT']) {
    const model = mk(mode, comps(), { enableDonnan: true });
    const out = new Float64Array(3);
    const x = computeQStar(model, Float64Array.from([0.3, 1, 50]), 60, new Float64Array(3), out);
    assert.equal(x, 0, `${mode} must return exactly 0, never NaN and never a signalling value`);
    assert.equal(model.diag.smaFrozen, 0, `${mode} must not touch the freeze counter`);
    // iterCalls is incremented for EVERY mode so isoIterAvg = iterSum/iterCalls is 0, not 0/0.
    assert.equal(model.diag.iterCalls, 1);
    assert.equal(model.diag.iterSum / model.diag.iterCalls, 0, 'isoIterAvg must be 0, not NaN');
    for (let i = 0; i < 3; i++) assert.ok(out[i] >= 0 && Number.isFinite(out[i]));
  }
  // SMA returns x = ln(qbar_s/Lambda) <= 0, never 0 unless nothing is bound.
  const smaModel = mk('SMA', comps());
  const out = new Float64Array(3);
  const x = computeQStar(smaModel, Float64Array.from([0.3, 1, 50]), 60, new Float64Array(3), out);
  assert.ok(x < 0 && Number.isFinite(x), 'SMA must return a strictly negative x when loaded');
  assert.equal(smaModel.diag.smaFrozen, 0);
});

// ---------------------------------------------------------------------------
// Donnan — §7.2.4
// ---------------------------------------------------------------------------

test('§7.2.4 — donnanK: K_counter * K_co = 1 identically, plus the guard', () => {
  const X = 350 / 0.85;
  for (const [C, A] of [[50, 50], [50, 13.986], [1e-3, 900], [900, 1e-3], [1e4, 1e4]]) {
    const kc = donnanK(X, C, A, 1);
    const kco = donnanK(X, C, A, -1);
    // Algebraic identity: (X+S)(-X+S) = S^2 - X^2 = 4CA, so the product is 1 in exact arithmetic.
    // In float64 the co-ion form (-X+S)/(2A) that §7.2.4 prints subtracts two nearly equal
    // numbers when 4CA << X^2, losing X^2/(2CA) worth of significance. `tol` is exactly that
    // conditioning bound, derived — it is not a fitted number. (The algebraically equivalent
    // K_co = 2C/(X+S) has no cancellation; the shipped form matches the printed contract.)
    const tol = Math.max(1e-14, 8 * Number.EPSILON * (X * X) / (2 * C * A));
    close(kc * kco, 1, tol, `K_counter*K_co at C=${C}, A=${A}`);
    // ENRICHMENT DIRECTION, derived rather than asserted by eye: K_counter = (X+S)/(2C) > 1
    // iff X + S > 2C iff (squaring, S > 0) A + X > C. Every charge-balanced stream — which is
    // every shipped tank, because solveCounterIon balances it — has C = A and therefore always
    // enriches the counter-ion. The reverse corner (C >> A + X) is included on purpose: the
    // partition stays self-consistent there, it simply stops being an "enrichment".
    if (C < A + X) {
      assert.ok(kc > 1 && kco < 1, `counter-ion must be enriched at C=${C}, A=${A}`);
    } else {
      assert.ok(kc < 1 && kco > 1, `direction must reverse at C=${C}, A=${A}`);
    }
    // The electroneutrality generator: K_counter*C - K_co*A = X, for ANY composition.
    close(kc * C - kco * A, X, Math.max(1e-13, tol * A / X),
      `K_c*C - K_co*A at C=${C}, A=${A}`);
  }
  assert.equal(donnanK(X, 50, 50, 0), 1, 'an uncharged species must not partition');
  // Guard: a stream with no counter-ions or no co-ions has no partition to speak of.
  assert.equal(donnanK(X, 0, 50, 1), 1);
  assert.equal(donnanK(X, 50, 0, -1), 0);
  assert.equal(donnanK(X, 1e-12, 50, -1), 0);
});

test('§7.2.4 — electroneutrality on the SHIPPED unbalanced-species tank vector', () => {
  // THE C-03 REGRESSION GUARD. Na 50 / Cl 13.986 / AcT 50 mM at ionisedFraction 0.72028 — a
  // vector that is charge-balanced in EQUIVALENTS but NOT in species concentrations. A pure-NaCl
  // fixture passes under the broken single-reference form too, so it guards nothing.
  const comps = [
    sp({ id: 'Na', colIdx: 0, kind: 'donnan', donnanRole: 'COUNTER', charge: 1,
      ionisedFraction: 1, epsPi: 0.85 }),
    sp({ id: 'Cl', colIdx: 1, kind: 'donnan', donnanRole: 'CO', charge: -1,
      ionisedFraction: 1, epsPi: 0.85 }),
    sp({ id: 'AcT', colIdx: 2, kind: 'donnan', donnanRole: 'CO', charge: -1,
      ionisedFraction: 0.72028, epsPi: 0.85 }),
  ];
  const model = mk('SMA', comps, { Lambda_mM: 350, epsP: 0.85, enableDonnan: true,
    resinChargeSign: -1 });
  const c = Float64Array.from([50, 13.986, 50]);
  const out = new Float64Array(3);
  computeQStar(model, c, 50, new Float64Array(3), out);

  // The §7.2.4 worked table, to its printed digits.
  close(model.X_mM, 411.7647, 1e-6, 'X = Lambda/epsP');
  const C = 50, A = 13.986 + 50 * 0.72028;
  close(A, 50.000, 1e-6, 'the co-ion equivalent sum must equal the counter-ion sum');
  close(donnanK(model.X_mM, C, A, 1), 8.354983, 1e-6, 'K_counter');
  close(donnanK(model.X_mM, C, A, -1), 0.1196890, 1e-6, 'K_co');
  close(out[0], 355.087, 1e-5, 'q*_Na');
  close(out[1], 1.4228, 1e-4, 'q*_Cl');
  close(out[2], 5.0868, 1e-4, 'q*_AcT');

  // The assertion §10 mandates: SUM |z_i| * ionisedFraction_i * q*_i = Lambda, exactly.
  const sumCharge = 1 * 1 * out[0] - 1 * 1 * out[1] - 1 * 0.72028 * out[2];
  close(sumCharge, 350.000, 1e-12, 'SUM |z|*f*q* must equal Lambda exactly');

  // ktLinear for a Donnan species is its linear-limit partition epsPi*K, which for a partition
  // linear in c coincides with the secant q*/c. Exact.
  const x = computeQStar(model, c, 50, new Float64Array(3), out);
  for (let i = 0; i < 3; i++) {
    close(ktLinear(model, i, x, 50), out[i] / c[i], 1e-14, `ktLinear vs secant for ${comps[i].id}`);
  }
});

test('§7.2.4 — pure-NaCl table, Donnan off, and the §7.2.6 dispersive chord', () => {
  const comps = [
    sp({ id: 'Na', colIdx: 0, kind: 'donnan', donnanRole: 'COUNTER', charge: 1, epsPi: 0.85 }),
    sp({ id: 'Cl', colIdx: 1, kind: 'donnan', donnanRole: 'CO', charge: -1, epsPi: 0.85 }),
  ];
  const on = mk('SMA', comps, { enableDonnan: true, resinChargeSign: -1 });
  const off = mk('SMA', comps, { enableDonnan: false, resinChargeSign: -1 });
  const out = new Float64Array(2);

  const qNa = (cRef, model = on) => {
    computeQStar(model, Float64Array.from([cRef, cRef]), cRef, new Float64Array(2), out);
    return { na: out[0], cl: out[1] };
  };
  // §7.2.4's printed collapse table for the symmetric case.
  let r = qNa(50);
  close(r.na, 355.09, 1e-4, 'q*_Na at 50 mM');
  close(r.cl, 5.087, 1e-3, 'q*_Cl at 50 mM');
  close(r.na - r.cl, 350, 1e-12, 'q*_counter - q*_co = Lambda at 50 mM');
  r = qNa(500);
  close(r.na, 634.62, 1e-5, 'q*_Na at 500 mM');
  close(r.cl, 284.62, 1e-4, 'q*_Cl at 500 mM');
  close(r.na - r.cl, 350, 1e-12, 'q*_counter - q*_co = Lambda at 500 mM');

  // Donnan OFF must fall back to the plain pore term, with no partition at all.
  const off50 = qNa(50, off);
  assert.equal(off50.na, 0.85 * 50);
  assert.equal(off50.cl, 0.85 * 50);

  // §7.2.6: for a step on the CONVEX Donnan isotherm the wave is dispersive and its first moment
  // is the mass-balance CHORD, not the secant. This is the isotherm-side half of the T18 fixture
  // (the transported front itself is tests/column.test.js). epsC = 0.35, epsT = 0.9025.
  const chordNa = (c0, c1) => 0.35 + 0.65 * (qNa(c1).na - qNa(c0).na) / (c1 - c0);
  const chordCl = (c0, c1) => 0.35 + 0.65 * (qNa(c1).cl - qNa(c0).cl) / (c1 - c0);
  close(chordNa(50, 500), 0.7538, 2e-2, '§7.2.6 chord for Na 50 -> 500 mM');
  close(chordNa(50, 1000), 0.8206, 2e-2, '§7.2.6 chord for Na 50 -> 1000 mM');
  // The co-ion step of §7.2.6: Cl 13.99 -> 461.76 mM gives 0.7192.
  close(chordCl(13.986, 461.757), 0.7192, 2e-2, '§7.2.6 chord for the Cl 13.99 -> 461.76 step');
  // CONVEXITY, checked as the property that makes the chord the right statistic: the chord slope
  // from a fixed c0 must increase with the far end. (The isotherm has a positive intercept
  // q*(0) = epsP*X = Lambda, so "convex" does NOT mean chord > secant here.)
  assert.ok(chordNa(50, 250) < chordNa(50, 500) && chordNa(50, 500) < chordNa(50, 1000),
    'the chord slope must increase with the far end — the isotherm is convex');
  // The rejected statistic, pinned so the distinction cannot quietly regress (§11.3, C-43): the
  // SECANT q*(c1)/c1 on the co-ion gives 0.7200, which is right for a self-sharpening shock and
  // wrong for the dispersive wave a convex isotherm produces.
  close(0.35 + 0.65 * qNa(500).cl / 500, 0.7200, 1e-4, 'the rejected secant statistic');
  assert.ok(Math.abs(chordCl(13.986, 461.757) - 0.7200) > 5e-4,
    'the chord and the secant must be distinguishable, or the fixture guards nothing');
  // Both degenerate ends of §7.2.5: an excluded co-ion tends to epsC, a fully pore-accessible
  // unretained species to epsT = epsC + (1-epsC)*epsP = 0.9025.
  close(0.35 + 0.65 * 0.85, 0.9025, 1e-15, 'epsT identity');
});

test('§7.2.4 — electroneutrality holds on the SHIPPED preset comps at any composition', () => {
  // Same identity, but driven straight off buildColumnCfg so a change to the shipped species
  // table (charges, ionisedFraction, epsPi) cannot silently break the pore charge balance.
  const cfg = buildColumnCfg(normalizePreset('cex-capture-igg1-pilot', {}));
  assert.equal(cfg.isothermMode, 'SMA');
  assert.equal(cfg.enableDonnan, true);
  const model = makeIsothermModel({
    Lambda_mM: cfg.Lambda_mM, mode: cfg.isothermMode, epsP: cfg.epsP,
    resinChargeSign: cfg.resinChargeSign, enableDonnan: cfg.enableDonnan, ...cfg.chem,
  }, cfg.comps);

  const m = cfg.comps.length;
  const c = new Float64Array(m), out = new Float64Array(m);
  const U = lcg(0xd07a11);
  for (let trial = 0; trial < 200; trial++) {
    // Charge-balanced draws, which is what solveCounterIon guarantees for every shipped tank.
    let C = 0, A = 0;
    for (let i = 0; i < m; i++) {
      const s = cfg.comps[i];
      c[i] = U() * 600;
      const eq = Math.abs(s.charge) * s.ionisedFraction * c[i];
      if (s.donnanRole === 'COUNTER') C += eq; else if (s.donnanRole === 'CO') A += eq;
    }
    // Force balance by scaling the counter-ion (Na, index 3 in column order).
    const naIdx = cfg.comps.findIndex((s) => s.donnanRole === 'COUNTER');
    if (!(C > 0) || !(A > 0)) continue;
    c[naIdx] *= A / C;

    computeQStar(model, c, c[naIdx], new Float64Array(m), out);
    let sum = 0;
    for (let i = 0; i < m; i++) {
      const s = cfg.comps[i];
      if (s.donnanRole === 'COUNTER') sum += Math.abs(s.charge) * s.ionisedFraction * out[i];
      else if (s.donnanRole === 'CO') sum -= Math.abs(s.charge) * s.ionisedFraction * out[i];
    }
    close(sum, cfg.Lambda_mM, 1e-12,
      `pore charge must equal Lambda on the shipped comps (trial ${trial})`);
  }
});

// ---------------------------------------------------------------------------
// Competitive Langmuir, HIC and LINEAR
// ---------------------------------------------------------------------------

test('§6.7 — competitive Langmuir: closed form, competition, saturation', () => {
  // The shipped HIC preset parameters (data/library.js), used as a realistic fixture.
  const P = [
    { id: 'WKI', epsPi: 0.85, qmax: 2, b0: 0.0004, beta: 0.0085 },
    { id: 'mAb', epsPi: 0.70, qmax: 2, b0: 0.00035, beta: 0.01 },
    { id: 'AGG', epsPi: 0.45, qmax: 2.5, b0: 0.0003, beta: 0.0115 },
  ];
  const comps = P.map((p, i) => sp({
    id: p.id, colIdx: i, epsPi: p.epsPi, qmax_mM: p.qmax, b0_mM1: p.b0, beta_mM1: p.beta,
    csRef_mM: 0,
  }));
  const model = mk('HIC', comps);
  const c = Float64Array.from([0.05, 0.30, 0.02]);
  const out = new Float64Array(3);

  for (const cs of [1, 50, 500, 1500]) {
    computeQStar(model, c, cs, new Float64Array(3), out);
    // q*_i = epsPi_i c_i + q_max,i b_i c_i / (1 + SUM_j b_j c_j), b_i = b0_i e^(beta_i (cs-csRef)).
    const b = P.map((p) => p.b0 * Math.exp(p.beta * cs));
    let D = 1;
    for (let i = 0; i < 3; i++) D += b[i] * c[i];
    for (let i = 0; i < 3; i++) {
      close(out[i], P[i].epsPi * c[i] + P[i].qmax * b[i] * c[i] / D, 1e-14,
        `Langmuir q* for ${P[i].id} at cs=${cs}`);
      // c -> 0 limit: Kt = epsPi + q_max*b.
      close(ktLinear(model, i, 0, cs), P[i].epsPi + P[i].qmax * b[i], 1e-14,
        `ktLinear for ${P[i].id} at cs=${cs}`);
    }
  }

  // COMPETITION: adding a rival strictly reduces the first component's bound amount.
  const solo = mk('LANGMUIR', [comps[0]]);
  const oSolo = new Float64Array(1);
  computeQStar(solo, Float64Array.from([0.05]), 500, new Float64Array(1), oSolo);
  computeQStar(model, Float64Array.from([0.05, 5, 5]), 500, new Float64Array(3), out);
  assert.ok(out[0] - 0.85 * 0.05 < oSolo[0] - 0.85 * 0.05,
    'a competitor must reduce the bound amount');

  // SATURATION: alone at very high c, q_ads -> q_max from below and never exceeds it.
  const big = new Float64Array(1);
  let prev = 0;
  for (const cc of [1, 1e2, 1e4, 1e6, 1e9]) {
    computeQStar(solo, Float64Array.from([cc]), 500, new Float64Array(1), big);
    const qAds = big[0] - 0.85 * cc;
    assert.ok(qAds > prev - 1e-12, 'q_ads must be monotone in c');
    assert.ok(qAds <= 2 + 1e-12, `q_ads ${qAds} must not exceed q_max = 2`);
    prev = qAds;
  }
  close(prev, 2, 1e-6, 'q_ads must reach q_max in the limit');

  // HIC modulation direction: beta > 0 is salting-out, so binding must RISE with salt.
  let last = -Infinity;
  for (const cs of [0, 100, 400, 800, 1200]) {
    computeQStar(model, c, cs, new Float64Array(3), out);
    const qAds = out[1] - 0.70 * 0.30;
    assert.ok(qAds > last, `HIC binding must increase with salt (cs=${cs})`);
    last = qAds;
  }
  // beta < 0 is salting-in: the same code path, opposite sign.
  const salting = mk('LANGMUIR', [sp({ id: 's', epsPi: 0.5, qmax_mM: 3, b0_mM1: 0.01,
    beta_mM1: -0.004, csRef_mM: 0 })]);
  const o1 = new Float64Array(1), o2 = new Float64Array(1);
  computeQStar(salting, Float64Array.from([0.5]), 50, new Float64Array(1), o1);
  computeQStar(salting, Float64Array.from([0.5]), 600, new Float64Array(1), o2);
  assert.ok(o2[0] < o1[0], 'beta < 0 must be salting-in');
});

test('§6.7 H9 — the Langmuir overflow fallback is the exact log-space saturation share', () => {
  // D = 1 + SUM b_j c_j overflows only with corrupt parameters, so the branch is otherwise
  // untested. Driven here with b0 = 1e9 and beta*cs = 800, i.e. b = 1e9*e^800 = Infinity.
  const model = mk('LANGMUIR', [
    sp({ id: 'A', colIdx: 0, epsPi: 0.5, qmax_mM: 10, b0_mM1: 1e9, beta_mM1: 1, csRef_mM: 0 }),
    sp({ id: 'B', colIdx: 1, epsPi: 0.5, qmax_mM: 4, b0_mM1: 1e9, beta_mM1: 1, csRef_mM: 0 }),
  ]);
  const c = Float64Array.from([2, 1]);
  const out = new Float64Array(2);
  const x = computeQStar(model, c, 800, new Float64Array(2), out);

  assert.equal(x, 0, 'the overflow fallback must still honour the return contract');
  assert.equal(model.diag.langmuirOverflow, 1, 'the overflow must be counted, not silent');
  // Analytic share: q*_i = epsPi_i c_i + q_max,i * T_i / SUM_j T_j with ln T_i = ln b_i + ln c_i.
  // The two beta terms are equal here, so T_A/T_B = c_A/c_B = 2 and the shares are 2/3 and 1/3.
  close(out[0], 0.5 * 2 + 10 * (2 / 3), 1e-13, 'overflow share for A');
  close(out[1], 0.5 * 1 + 4 * (1 / 3), 1e-13, 'overflow share for B');
  for (const v of out) assert.ok(Number.isFinite(v) && v >= 0, 'no NaN, no negative q*');

  // ktLinear must not leak Infinity either — it falls back to KT_MAX.
  assert.equal(ktLinear(model, 0, 0, 800), model.KT_MAX,
    'an overflowing affinity must clamp ktLinear to KT_MAX, never return Infinity');
});

test('§6.7 — LINEAR: q* = (epsPi + Klin)*c exactly, with no saturation at any load', () => {
  const model = mk('LINEAR', [
    sp({ id: 'A', colIdx: 0, epsPi: 0.40, Klin: 3.25 }),
    sp({ id: 'B', colIdx: 1, epsPi: 0.70, Klin: 0 }),
    sp({ id: 'T', colIdx: 2, kind: 'inert', epsPi: 0.85, Klin: 99 }),   // Klin ignored: not binding
  ]);
  const out = new Float64Array(3);
  let firstKt = null;
  for (const scale of [1e-9, 1e-3, 1, 1e3, 1e6]) {
    const c = Float64Array.from([0.7 * scale, 2.0 * scale, 1.0 * scale]);
    const x = computeQStar(model, c, 100, new Float64Array(3), out);
    assert.equal(x, 0, 'LINEAR must return exactly 0');
    close(out[0], (0.40 + 3.25) * c[0], 1e-15, 'LINEAR q* for A');
    close(out[1], (0.70 + 0) * c[1], 1e-15, 'LINEAR q* for B');
    close(out[2], 0.85 * c[2], 1e-15, 'a non-binding species must get the pore term only');
    // The defining property: Kt is independent of c. Any drift means a saturating term crept in.
    const Kt = out[0] / c[0];
    if (firstKt === null) firstKt = Kt; else close(Kt, firstKt, 1e-15, 'LINEAR Kt vs load');
    close(Kt, 3.65, 1e-15, 'LINEAR Kt = epsPi + Klin');
    // The §7.2.5 retention identity this feeds: V_R/V_col = epsC + (1-epsC)*Kt.
    close(0.35 + 0.65 * Kt, 0.35 + 0.65 * (0.40 + 3.25), 1e-15, 'retention identity input');
  }
  // Klin must not depend on the modulator: the salt-dependent forms live in SMA and HIC.
  const a = new Float64Array(3), b = new Float64Array(3);
  computeQStar(model, Float64Array.from([1, 1, 1]), 1, new Float64Array(3), a);
  computeQStar(model, Float64Array.from([1, 1, 1]), 900, new Float64Array(3), b);
  for (let i = 0; i < 3; i++) assert.equal(a[i], b[i], 'LINEAR must be modulator-independent');
});

test('§6.7 — SEC and INERT: q* = epsPi*c, zero iterations, both K_D end members', () => {
  for (const mode of ['SEC', 'INERT']) {
    const model = mk(mode, [
      sp({ id: 'excluded', colIdx: 0, kind: 'binding', epsPi: 0, nu: 5, Keq: 9 }),
      sp({ id: 'permeating', colIdx: 1, kind: 'inert', epsPi: 0.85 }),
      sp({ id: 'partial', colIdx: 2, kind: 'binding', epsPi: 0.35, nu: 5, Keq: 9 }),
    ], { epsP: 0.85 });
    const c = Float64Array.from([1.5, 1.5, 1.5]);
    const out = new Float64Array(3);
    const x = computeQStar(model, c, 50, new Float64Array(3), out);
    assert.equal(x, 0, `${mode} must return exactly 0`);
    assert.equal(model.diag.iterSum, 0, `${mode} must run zero iterations`);
    // K_D = 0 -> Kt = 0 -> V_R = epsC CV; K_D = 1 -> Kt = epsP -> V_R = epsT = 0.9025 CV (§7.2.5).
    assert.equal(out[0], 0, 'a fully excluded species gets nothing');
    close(out[1], 0.85 * 1.5, 1e-15, 'a fully permeating species gets epsP*c');
    close(out[2], 0.35 * 1.5, 1e-15, 'a partially permeating species gets epsPi*c');
    close(0.35 + 0.65 * (out[1] / 1.5), 0.9025, 1e-15, 'K_D = 1 lands at epsT');
    assert.equal(0.35 + 0.65 * (out[0] / 1.5), 0.35, 'K_D = 0 lands at epsC');
    for (let i = 0; i < 3; i++) close(ktLinear(model, i, 0, 50), out[i] / 1.5, 1e-15,
      `${mode} ktLinear vs secant`);
  }
});

// ---------------------------------------------------------------------------
// ktLinear — every mode, every kind
// ---------------------------------------------------------------------------

test('§6.7 — ktLinear for SMA is the converged-qbar_s linear limit, and matches lim q*/c', () => {
  const model = mk('SMA', [sp({ id: 'mAb', nu: 5.2, sigma: 575, Keq: 0.044, epsPi: 0.70 })]);
  const out = new Float64Array(1);
  for (const cs of [1, 50, 200, 1000]) {
    for (const c of [1e-11, 1e-6, 0.05, 5]) {
      const x = computeQStar(model, Float64Array.from([c]), cs, new Float64Array(1), out);
      // Documented form: epsPi + Keq*(qbar_s/csEff)^nu with the CONVERGED qbar_s = Lambda*e^x,
      // not Lambda. Exact, so 1e-13 relative is the float bound on pow().
      const csEff = Math.max(cs, CHEM.CS_MIN_mM);
      const expected = 0.70 + 0.044 * Math.pow(350 * Math.exp(x) / csEff, 5.2);
      close(ktLinear(model, 0, x, cs), expected, 1e-13, `ktLinear SMA at c=${c}, cs=${cs}`);
      assert.ok(ktLinear(model, 0, x, cs) >= 0, 'ktLinear must be >= 0');
      assert.ok(Number.isFinite(ktLinear(model, 0, x, cs)), 'ktLinear must be finite');
    }
    // In the true zero-load limit qbar_s = Lambda, x = 0, and the linear-limit partition is the
    // closed form Kt = epsPi + Keq*(Lambda/csEff)^nu. Reached exactly by putting c below
    // C_MIN = 1e-12 so the active set is empty and x is 0 by construction (fast path A).
    const csEff = Math.max(cs, CHEM.CS_MIN_mM);
    const x0 = computeQStar(model, Float64Array.from([1e-13]), cs, new Float64Array(1), out);
    assert.equal(x0, 0, 'an empty active set must give x = 0 exactly');
    close(ktLinear(model, 0, x0, cs), 0.70 + 0.044 * Math.pow(350 / csEff, 5.2), 1e-13,
      `SMA zero-load Kt at cs=${cs}`);
  }
  // ktLinear must agree with the secant q*/c wherever the load is light enough that the two
  // coincide. At cs = 200 mM the mAb Kt is ~1.5, so c = 1e-9 mM is deep in the linear regime
  // and the O(c*Kt/Lambda) truncation is ~1e-11; 1e-8 is a safe bound on it.
  const x = computeQStar(model, Float64Array.from([1e-9]), 200, new Float64Array(1), out);
  close(out[0] / 1e-9, ktLinear(model, 0, x, 200), 1e-8, 'ktLinear vs the secant at c -> 0');
  close(ktLinear(model, 0, x, 200), 0.70 + 0.044 * Math.pow(350 / 200, 5.2), 1e-6,
    'the light-load Kt at cs = 200 mM');
});

test('§6.7.2 — SBI Kt = 5.367e7 at cs = 50 mM and the KT_MAX clamp factor of ~54', () => {
  // The contract states the clamp is NOT destination-neutral and quantifies the worst case:
  // SBI has a true Kt = Keq*(Lambda/cs)^nu = 1.33*7^9 at cs = 50 mM and is clamped by ~54x on
  // every call. Both numbers are closed-form, so this pins the statement, not the code.
  const model = mk('SMA', [sp({ id: 'SBI', nu: 9, sigma: 638, Keq: 1.33, epsPi: 0.68 })]);
  // c below C_MIN keeps the active set empty, so x = 0 exactly and ktLinear is the true limit.
  const x = computeQStar(model, Float64Array.from([1e-13]), 50, new Float64Array(1),
    new Float64Array(1));
  assert.equal(x, 0);
  const KtTrue = ktLinear(model, 0, x, 50);
  close(KtTrue, 0.68 + 1.33 * Math.pow(7, 9), 1e-13, 'SBI zero-load Kt');
  close(KtTrue, 5.367e7, 1e-3, 'SBI Kt to the contract-printed 5.4e7');
  close(KtTrue / model.KT_MAX, 53.67, 1e-3, 'the KT_MAX clamp factor');
  assert.ok(KtTrue > model.KT_MAX, 'the shipped SBI parameters really do hit the ceiling');
});

test('§6.7 — ktLinear is defined, finite and >= 0 for EVERY mode and EVERY kind', () => {
  const comps = () => [
    sp({ id: 'bind', colIdx: 0, kind: 'binding', epsPi: 0.70, nu: 5.2, sigma: 575, Keq: 0.044,
      qmax_mM: 2, b0_mM1: 3.5e-4, beta_mM1: 0.01, csRef_mM: 0, Klin: 1.75 }),
    sp({ id: 'inert', colIdx: 1, kind: 'inert', epsPi: 0.85 }),
    sp({ id: 'ctr', colIdx: 2, kind: 'donnan', donnanRole: 'COUNTER', charge: 1, epsPi: 0.85 }),
    sp({ id: 'co', colIdx: 3, kind: 'donnan', donnanRole: 'CO', charge: -1, epsPi: 0.85 }),
  ];
  const expectedBinding = {
    SMA: null,                                   // depends on x; checked in the SMA test above
    LANGMUIR: 0.70 + 2 * 3.5e-4 * Math.exp(0.01 * 120),
    HIC: 0.70 + 2 * 3.5e-4 * Math.exp(0.01 * 120),
    LINEAR: 0.70 + 1.75,
    SEC: 0.70,
    INERT: 0.70,
  };
  for (const mode of ['SMA', 'LANGMUIR', 'HIC', 'SEC', 'LINEAR', 'INERT']) {
    const model = mk(mode, comps(), { enableDonnan: true, resinChargeSign: -1 });
    const c = Float64Array.from([0.3, 1.0, 60, 60]);
    const out = new Float64Array(4);
    const x = computeQStar(model, c, 120, new Float64Array(4), out);
    for (let i = 0; i < 4; i++) {
      const kt = ktLinear(model, i, x, 120);
      assert.ok(Number.isFinite(kt) && kt >= 0, `${mode}: ktLinear[${i}] = ${kt}`);
    }
    if (expectedBinding[mode] !== null) {
      close(ktLinear(model, 0, x, 120), expectedBinding[mode], 1e-14, `${mode} binding ktLinear`);
    }
    // Inert: always epsPi. Donnan: epsPi*K, which equals the secant exactly.
    assert.equal(ktLinear(model, 1, x, 120), 0.85, `${mode} inert ktLinear = epsPi`);
    close(ktLinear(model, 2, x, 120), out[2] / 60, 1e-14, `${mode} counter-ion ktLinear`);
    close(ktLinear(model, 3, x, 120), out[3] / 60, 1e-14, `${mode} co-ion ktLinear`);
    assert.ok(ktLinear(model, 2, x, 120) > ktLinear(model, 3, x, 120),
      'the counter-ion must partition above the co-ion');
    // The modulator floor must apply on this branch too (the same csEff as the equilibrium).
    assert.equal(ktLinear(model, 0, x, 0), ktLinear(model, 0, x, CHEM.CS_MIN_mM),
      `${mode}: ktLinear must floor cs at CS_MIN`);
  }
});

// ---------------------------------------------------------------------------
// relaxCell — §6.7.2
// ---------------------------------------------------------------------------

test('T6 — relaxCell conserves c + phi*q exactly, in every mode', () => {
  const phi = (1 - 0.35) / 0.35;
  for (const mode of ['SMA', 'LANGMUIR', 'HIC', 'LINEAR', 'SEC', 'INERT']) {
    const model = mk(mode, [
      sp({ id: 'mAb', colIdx: 0, epsPi: 0.70, nu: 5.2, sigma: 575, Keq: 0.044,
        qmax_mM: 2, b0_mM1: 3.5e-4, beta_mM1: 0.01, Klin: 1.75 }),
      sp({ id: 'Na', colIdx: 1, kind: 'inert', epsPi: 0.85 }),
    ]);
    const c = Float64Array.from([0.4, 150]);
    const q = new Float64Array(2);
    const kOv = Float64Array.from([0.03, 5]);
    const qstar = new Float64Array(2), defect = new Float64Array(2);
    let worst = 0;
    for (let step = 0; step < 300; step++) {
      const inv = [c[0] + phi * q[0], c[1] + phi * q[1]];
      const x = relaxCell(model, c, q, 150, kOv, 2.0, phi, 1.3744, qstar, defect);
      assert.ok(!Number.isNaN(x), `${mode}: relaxCell must not freeze`);
      for (let i = 0; i < 2; i++) {
        const drift = Math.abs(c[i] + phi * q[i] - inv[i]) / Math.max(inv[i], 1e-30);
        if (drift > worst) worst = drift;
      }
    }
    // T6 accepts 1e-12 relative drift; the analytic complement c -= phi*dq gives one rounding.
    assert.ok(worst <= 1e-12, `${mode}: cell-invariant drift ${worst.toExponential(3)}`);
    assert.equal(defect[0], 0, `${mode}: no unsafe clamp may fire on a healthy cell`);
    assert.equal(defect[1], 0);
  }
});

test('T9 — positivity at dt x 1000: c >= 0 and q >= 0, no NaN', () => {
  // The secant slope Kt = q*/c is what makes c_new >= (c0 + phi q0)/(1 + phi Kt) > 0. The
  // tangent dq*/dc does NOT have this property, which is why it must never be substituted.
  const phi = (1 - 0.35) / 0.35;
  const model = mk('SMA', [
    sp({ id: 'mAb', colIdx: 0, epsPi: 0.70, nu: 5.2, sigma: 575, Keq: 0.044 }),
    sp({ id: 'Na', colIdx: 1, kind: 'inert', epsPi: 0.85 }),
  ]);
  for (const dt of [4, 400, 4000]) {
    const c = Float64Array.from([0.4, 150]);
    const q = Float64Array.from([3, 100]);
    const kOv = Float64Array.from([0.03, 5]);
    const qstar = new Float64Array(2), defect = new Float64Array(2);
    for (let step = 0; step < 100; step++) {
      const x = relaxCell(model, c, q, 150, kOv, dt, phi, 1.3744, qstar, defect);
      assert.ok(!Number.isNaN(x), `dt=${dt}: no freeze`);
      for (let i = 0; i < 2; i++) {
        assert.ok(c[i] >= 0 && Number.isFinite(c[i]), `dt=${dt}: c[${i}] = ${c[i]}`);
        assert.ok(q[i] >= 0 && Number.isFinite(q[i]), `dt=${dt}: q[${i}] = ${q[i]}`);
      }
    }
    assert.equal(defect[0], 0, 'positivity must be structural, not clamped');
  }
});

test('T8 — the equilibrium limit: theta = 1 lands exactly on the cell joint equilibrium', () => {
  // With theta = 1 the analytic destination is closed-form and independent of the code:
  //   c_eq = (c0 + phi*q0)/(1 + phi*Kt),  q_eq = Kt*c_eq.
  // LINEAR is used because Kt = epsPi + Klin is exact and constant, so the identity is exact.
  const phi = (1 - 0.35) / 0.35;
  const Kt = 0.40 + 3.25;
  const model = mk('LINEAR', [sp({ id: 'A', epsPi: 0.40, Klin: 3.25 })]);
  const c = Float64Array.from([0.7]);
  const q = Float64Array.from([1.9]);
  const c0 = c[0], q0 = q[0];
  // k_ov = 1e6 1/s makes u = k_eff*(1+phi*Kt)*dt far beyond the theta cutoff of 40.
  relaxCell(model, c, q, 100, Float64Array.from([1e6]), 1, phi, 1.3744,
    new Float64Array(1), new Float64Array(1));
  const cEq = (c0 + phi * q0) / (1 + phi * Kt);
  close(c[0], cEq, 1e-14, 'T8 c at the joint equilibrium');
  close(q[0], Kt * cEq, 1e-14, 'T8 q at the joint equilibrium');
  close(q[0] / c[0], Kt, 1e-13, 'T8 the equilibrated cell sits exactly on the isotherm');
  close(c[0] + phi * q[0], c0 + phi * q0, 1e-14, 'T8 mass is still conserved');
});

test('§6.7.2 — the one UNSAFE clamp is accounted in umol, and dt <= 0 moves nothing', () => {
  const phi = (1 - 0.35) / 0.35;
  const model = mk('SMA', [sp({ id: 'mAb', epsPi: 0.70, nu: 5.2, sigma: 575, Keq: 0.044 })]);

  // massDefect is umol = mM * mL, which is the whole reason VcellMob_mL is an argument.
  // At nz = 400 the shipped VcellMob_mL is 1.3744 mL; a bare-mM accumulation would be wrong by
  // exactly that factor and would move with the grid.
  const c = Float64Array.from([-0.25]);
  const q = Float64Array.from([1.0]);
  const defect = new Float64Array(1);
  relaxCell(model, c, q, 100, Float64Array.from([0.03]), 1, phi, 1.3744,
    new Float64Array(1), defect);
  close(defect[0], 0.25 * 1.3744, 1e-15, 'clamp ledger in umol');
  assert.ok(c[0] >= 0, 'the clamped concentration must be non-negative afterwards');

  // The ledger is INCREMENTED, never assigned.
  const c2 = Float64Array.from([-0.5]);
  relaxCell(model, c2, q, 100, Float64Array.from([0.03]), 1, phi, 1.3744,
    new Float64Array(1), defect);
  close(defect[0], (0.25 + 0.5) * 1.3744, 1e-15, 'the ledger must accumulate');

  // dt <= 0 (H13: paused flow) returns 0 and touches nothing at all — not even the clamp.
  const c3 = Float64Array.from([-0.75]);
  const q3 = Float64Array.from([2.5]);
  const d3 = new Float64Array(1);
  for (const dt of [0, -1]) {
    assert.equal(relaxCell(model, c3, q3, 100, Float64Array.from([0.03]), dt, phi, 1.3744,
      new Float64Array(1), d3), 0, `dt=${dt} must return 0`);
    assert.equal(c3[0], -0.75, `dt=${dt} must not touch c`);
    assert.equal(q3[0], 2.5, `dt=${dt} must not touch q`);
    assert.equal(d3[0], 0, `dt=${dt} must not touch the ledger`);
  }
});

test('§6.7.2 — relaxCell desorbs into a clean liquid via the ktLinear branch', () => {
  // The case ktLinear exists for: c is below C_KT = 1e-9 mM while q is 2 mM, so the secant
  // q*/c is 0/0. Without the linear-limit substitute the cell would never release its protein.
  const phi = (1 - 0.35) / 0.35;
  const model = mk('SMA', [sp({ id: 'mAb', epsPi: 0.70, nu: 5.2, sigma: 575, Keq: 0.044 })]);
  const c = Float64Array.from([1e-15]);
  const q = Float64Array.from([2.0]);
  const inv = c[0] + phi * q[0];
  for (let step = 0; step < 50; step++) {
    const x = relaxCell(model, c, q, 600, Float64Array.from([0.03]), 60, phi, 1.3744,
      new Float64Array(1), new Float64Array(1));
    assert.ok(!Number.isNaN(x));
  }
  assert.ok(q[0] < 2.0, 'the solid phase must release protein at high salt');
  assert.ok(c[0] > 1e-15, 'the liquid phase must receive it');
  close(c[0] + phi * q[0], inv, 1e-12, 'desorption must conserve the cell invariant');
});

// ---------------------------------------------------------------------------
// Basis conversion and parameter validation
// ---------------------------------------------------------------------------

test('T12 — convertSMABasis round-trips, keeps Keq*Lambda^(nu-1), and scales q* by (1-epsP)', () => {
  const epsP = 0.85, f = 1 - epsP;
  const p = { Lambda_mM: 350, nu: 5.2, sigma: 575, Keq: 0.044, qmax_mM: 12, Klin: 3.3 };
  const bead = convertSMABasis(p, epsP, 'skelToBead');
  const back = convertSMABasis(bead, epsP, 'beadToSkel');

  for (const k of ['Lambda_mM', 'nu', 'sigma', 'Keq', 'qmax_mM', 'Klin']) {
    close(back[k], p[k], 1e-15, `T12 round-trip of ${k}`);
  }
  assert.notEqual(bead, p, 'convertSMABasis must return a NEW object, never mutate');
  assert.equal(p.Lambda_mM, 350, 'the input must be untouched');
  close(bead.Lambda_mM, 350 * f, 1e-15, 'Lambda scales by f');
  close(bead.qmax_mM, 12 * f, 1e-15, 'q_max scales by f');
  close(bead.Klin, 3.3 * f, 1e-15, 'Klin scales by f');
  close(bead.Keq, 0.044 * Math.pow(f, 1 - 5.2), 1e-15, 'Keq scales by f^(1-nu)');
  assert.equal(bead.nu, 5.2, 'nu is basis-invariant');
  assert.equal(bead.sigma, 575, 'sigma is basis-invariant');

  // The invariant group: if it differs, two parameter sets are genuinely different chemistry.
  close(bead.Keq * Math.pow(bead.Lambda_mM, bead.nu - 1),
    p.Keq * Math.pow(p.Lambda_mM, p.nu - 1), 1e-13, 'Keq*Lambda^(nu-1) is basis-invariant');

  // The physical consequence: the same c, cs solved on both bases must give q_bead = f*q_skel.
  const skel = mk('SMA', [sp({ id: 'm', nu: 5.2, sigma: 575, Keq: p.Keq, epsPi: 0 })],
    { Lambda_mM: p.Lambda_mM });
  const bd = mk('SMA', [sp({ id: 'm', nu: 5.2, sigma: 575, Keq: bead.Keq, epsPi: 0 })],
    { Lambda_mM: bead.Lambda_mM });
  const o1 = new Float64Array(1), o2 = new Float64Array(1);
  for (const c of [0.035, 0.35, 3.5]) {
    computeQStar(skel, Float64Array.from([c]), 80, new Float64Array(1), o1);
    computeQStar(bd, Float64Array.from([c]), 80, new Float64Array(1), o2);
    close(o2[0] / o1[0], f, 1e-12, `q* must scale by f at c=${c}`);
  }
});

test('§6.7 — validateParams: the four shipped presets validate clean', () => {
  for (const id of ['cex-capture-igg1-pilot', 'cex-capture-igg1-lab', 'hic-polish-agg',
    'sec-polish-s200']) {
    const cfg = buildColumnCfg(normalizePreset(id, {}));
    const v = validateParams({
      Lambda_mM: cfg.Lambda_mM, mode: cfg.isothermMode, epsP: cfg.epsP,
      resinChargeSign: cfg.resinChargeSign, enableDonnan: cfg.enableDonnan, ...cfg.chem,
    }, cfg.comps);
    assert.deepEqual(v.errors, [], `${id} must produce no validation errors`);
    assert.equal(v.ok, true, `${id} must validate`);
    assert.deepEqual(v.warnings, [], `${id} must produce no validation warnings`);
  }
});

test('§6.7 — validateParams: the rows that must refuse to run, and the clamp warnings', () => {
  const base = { mode: 'SMA', Lambda_mM: 350, epsP: 0.85, ...CHEM };
  const comp = (o) => [sp(Object.assign({ id: 'm', nu: 5.2, sigma: 575, Keq: 0.044,
    epsPi: 0.70, MW_gmol: 148000 }, o))];

  assert.equal(validateParams(base, comp({})).ok, true, 'the baseline must validate');

  // Errors.
  assert.ok(!validateParams({ ...base, mode: 'IEX_SMA' }, comp({})).ok, 'unknown mode');
  assert.ok(!validateParams({ ...base, epsP: 0.99 }, comp({})).ok, 'epsP above 0.98');
  assert.ok(!validateParams({ ...base, epsP: 0.01 }, comp({})).ok, 'epsP below 0.05');
  assert.ok(!validateParams({ ...base, Lambda_mM: 9000 }, comp({})).ok, 'Lambda above 5000 mM');
  assert.ok(!validateParams({ ...base, CS_MIN_mM: 0 }, comp({})).ok, 'CS_MIN must be > 0');
  assert.ok(!validateParams({ ...base, mode: 'LANGMUIR' }, comp({ qmax_mM: 0 })).ok,
    'LANGMUIR needs qmax_mM > 0');

  // The SMA overflow envelope (T6/H7): worst-case lw at c = 1e4 mM and cs = CS_MIN must stay
  // below LW_MAX = 700. The check must fire when it is violated ...
  const envelope = validateParams(
    { ...base, Lambda_mM: 5000, CS_MIN_mM: 1e-6 },
    comp({ nu: 30, sigma: 5000, Keq: 1e30 }));
  assert.ok(envelope.errors.some((e) => /overflow envelope/.test(e)),
    `the overflow envelope must be checked; got ${JSON.stringify(envelope.errors)}`);
  // ... and it must NOT fire anywhere inside the shipped box. The worst corner of that box is
  //   lw = ln(nu+sigma) + ln(Keq) + ln(1e4) + nu*(ln Lambda - ln CS_MIN) - ln Lambda
  // at nu = NU_MAX = 30, sigma = SIGMA_MAX = 5000, Keq = KEQ_MAX = 1e30, Lambda = 5000 mM and
  // the shipped CS_MIN = 1 mM, which evaluates to 333.8 — a factor of 2 of headroom on the
  // ln(MAX_DOUBLE) = 709.78 limit. Computed here, not copied, so the margin is verified.
  const lwWorst = Math.log(30 + 5000) + Math.log(1e30) + Math.log(1e4)
    + 30 * (Math.log(5000) - Math.log(1.0)) - Math.log(5000);
  close(lwWorst, 333.8, 1e-3, 'worst-case lw inside the shipped box');
  assert.ok(lwWorst < 700, 'the shipped parameter box cannot reach the overflow envelope');
  assert.deepEqual(
    validateParams({ ...base, Lambda_mM: 5000 }, comp({ nu: 30, sigma: 5000, Keq: 1e30 }))
      .errors, [], 'the worst shipped-box corner must not error');

  // Warnings: clamped parameters and an implausible elution salt.
  assert.ok(validateParams(base, comp({ nu: 40 })).warnings.some((w) => /nu 40 clamped/.test(w)));
  assert.ok(validateParams(base, comp({ sigma: 9000 })).warnings.some((w) => /sigma/.test(w)));
  assert.ok(validateParams({ ...base, mode: 'HIC' },
    comp({ qmax_mM: 2, b0_mM1: 3e-4, beta_mM1: -0.01 })).warnings.some((w) => /salting-out/.test(w)),
  'HIC must warn on beta <= 0 — HIC is never SMA with a negative nu');
  // K_lin = 1 at cs_R = Lambda*Keq^(1/nu); Keq = 1e-9 puts it far below 20 mM.
  assert.ok(validateParams(base, comp({ Keq: 1e-9 })).warnings.some((w) => /K_lin = 1/.test(w)));
  // epsPi above the resin nominal.
  assert.ok(validateParams(base, comp({ epsPi: 0.95 })).warnings.some((w) => /exceeds resin/.test(w)));
});
