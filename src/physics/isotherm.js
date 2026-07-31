/**
 * src/physics/isotherm.js — adsorption equilibrium, the Donnan partition, and the coupled
 * analytic linear-driving-force (LDF) relaxation. This is the ONLY place `q` changes.
 *
 * Contract: architecture-v2 §6.7 (module), §6.7.1 (solver notes), §6.7.2 (`relaxCell` body),
 * §7.2.4 (Donnan group sums), §1.2 (BASIS N1), §5.8.2 (`ColumnSpeciesConfig`).
 *
 * UNITS (§1.1, absolute):
 *   c, cs, q, q*, Lambda, X ....... mM  (q/Lambda/q_max are per mL of BEAD volume — BASIS N1)
 *   k_ov, k_eff .................. 1/s
 *   dt ........................... s
 *   V_cell ....................... mL
 *   massDefect ................... umol  (= mM * mL, R-U4)
 *   phi, Kt, theta, x ............ dimensionless
 *
 * BASIS N1 (§1.2): `q_i` is the TOTAL particle content — adsorbed PLUS pore liquid:
 *   q*_i = epsPi_i * c_i + q_ads_i,  and the cell invariant conserved exactly here is
 *   c_i + phi * q_i  with  phi = (1 - epsC) / epsC.
 *
 * NO DOM, no timestep ownership, no transport. Imports only `core/util.js` (layer L1, §4).
 */

import { clamp } from '../core/util.js';

// ---------------------------------------------------------------------------
// Solver constants — §6.7.1. Module-private: the manifest fixes the export list.
// ---------------------------------------------------------------------------
const ITER_MAX = 30;
const TOL_X = 1e-10;
const TOL_R = 1e-12;
const STEP_MAX = 50;
const LN_TINY = -745;          // below this exp() underflows to 0, which is the correct limit
const MAX_COMPONENTS = 24;     // asserted at construction (§6.7): ns is 10, the library ships 15
const BRACKET_MAX_EXPANSIONS = 60;

const MODES = ['SMA', 'LANGMUIR', 'HIC', 'SEC', 'LINEAR', 'INERT'];

// kindCode: 0 inert, 1 donnan, 2 binding (§6.7 IsothermModel).
const KIND_CODE = { inert: 0, donnan: 1, binding: 2 };
// donnanSign: 0 NONE, +1 COUNTER, -1 CO (§5.8.3).
const DONNAN_SIGN = { NONE: 0, COUNTER: 1, CO: -1 };

// Parameter hard limits (§6.7.1 / the isotherm validation table). Clamp + warn, never reject
// silently; `validateParams` is what reports them.
const NU_MIN = 0.05, NU_MAX = 30;
const SIGMA_MIN = 0, SIGMA_MAX = 5000;
const KEQ_MIN = 0, KEQ_MAX = 1e30;
const KLIN_MIN = 0, KLIN_MAX = 1e12;
const B_MIN = 0, B_MAX = 1e9;
const QMAX_MAX_mM = 1e4;
const LAMBDA_MIN_mM = 1, LAMBDA_MAX_mM = 5000;
const EPSP_MIN = 0.05, EPSP_MAX = 0.98;
const LW_MAX = 700;            // overflow envelope: ln(MAX_DOUBLE) = 709.78

/** @returns {number} `v` when it is a finite number, otherwise `dflt`. */
function numOr(v, dflt) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : dflt;
}

/**
 * Build the frozen-parameter model consumed by `computeQStar` / `relaxCell`.
 *
 * Everything it needs per cell is preallocated here, so nothing after construction allocates
 * (§0, zero allocation in the hot path). Parameters outside the validated box are CLAMPED
 * (see `validateParams` for the reported errors/warnings) — the solver theorems of §6.7.1 hold
 * only inside that box.
 *
 * @param {object} resin
 *   @param {number} resin.Lambda_mM        ionic capacity, mM per mL of bead volume (BASIS N1)
 *   @param {'SMA'|'LANGMUIR'|'HIC'|'SEC'|'LINEAR'|'INERT'} resin.mode  isotherm mode; byte-identical
 *          to `config.column.isothermMode` (§2.1). There is no 'IEX_' prefix anywhere.
 *   @param {number} resin.epsP             nominal particle porosity, dimensionless
 *   @param {number} resin.resinChargeSign  -1 CEX, +1 AEX, 0 non-ionic (kept for diagnostics; the
 *          per-species `donnanRole` is already derived from it at ingest, §5.8.3)
 *   @param {boolean} resin.enableDonnan    apply the §7.2.4 partition to `kind === 'donnan'` species
 *   @param {number} resin.CS_MIN_mM        modulator floor, mM (1.0)
 *   @param {number} resin.C_MIN_mM         "component absent" floor, mM (1e-12)
 *   @param {number} resin.C_KT_mM          secant-partition floor, mM (1e-9)
 *   @param {number} resin.KT_MIN           lower clamp on Kt, dimensionless (1e-3)
 *   @param {number} resin.KT_MAX           upper clamp on Kt, dimensionless (1e6)
 * @param {Array<object>} comps  ColumnSpeciesConfig[] (§5.8.2), length m, in COLUMN index order.
 * @returns {object} IsothermModel — see §6.7. All per-species arrays are `Float64Array(m)` unless
 *   noted; `scratch` is PER-MODEL (two live models must never share it); `diag` counters are
 *   cumulative and are read by `physics/column.js` into `col.diag`.
 */
export function makeIsothermModel(resin, comps) {
  const m = comps.length;
  if (m > MAX_COMPONENTS) {
    throw new RangeError(
      `makeIsothermModel: ${m} components exceeds MAX_COMPONENTS = ${MAX_COMPONENTS}`);
  }
  const mode = resin && resin.mode;
  if (MODES.indexOf(mode) < 0) {
    throw new RangeError(
      `makeIsothermModel: unknown isotherm mode ${JSON.stringify(mode)}; expected one of ` +
      MODES.join('|'));
  }

  const Lambda_mM = numOr(resin.Lambda_mM, 0);
  const epsP = numOr(resin.epsP, 0);

  const nu = new Float64Array(m);
  const sig = new Float64Array(m);
  const Keq = new Float64Array(m);
  const lnKeq = new Float64Array(m);
  const lnNuSig = new Float64Array(m);
  const qmaxSMA_mM = new Float64Array(m);
  const epsPi = new Float64Array(m);
  const KtLin = new Float64Array(m);
  const qmax_mM = new Float64Array(m);
  const b0 = new Float64Array(m);
  const beta = new Float64Array(m);
  const csRef = new Float64Array(m);
  const Klin = new Float64Array(m);
  const kindCode = new Int32Array(m);
  const donnanSign = new Int32Array(m);
  const zAbsIonised = new Float64Array(m);

  for (let i = 0; i < m; i++) {
    const cp = comps[i] || {};
    // SMA parameters. nu is clamped only where it can actually enter the solver, so a salt with
    // nu = 0 stays nu = 0 and is simply never in the active set.
    const nuRaw = numOr(cp.nu, 0);
    const kc = KIND_CODE[cp.kind] !== undefined ? KIND_CODE[cp.kind] : KIND_CODE.inert;
    kindCode[i] = kc;
    nu[i] = (kc === KIND_CODE.binding && nuRaw > 0) ? clamp(nuRaw, NU_MIN, NU_MAX) : nuRaw;
    sig[i] = clamp(numOr(cp.sigma, 0), SIGMA_MIN, SIGMA_MAX);
    Keq[i] = clamp(numOr(cp.Keq, 0), KEQ_MIN, KEQ_MAX);
    lnKeq[i] = Keq[i] > 0 ? Math.log(Keq[i]) : -Infinity;
    const nuSig = nu[i] + sig[i];
    // Meaningless (and never read) for a species that can never be SMA-active; kept finite so a
    // diagnostic dump of the model never prints -Infinity/NaN.
    lnNuSig[i] = nuSig > 0 ? Math.log(nuSig) : 0;
    qmaxSMA_mM[i] = nuSig > 0 ? Lambda_mM / nuSig : 0;

    // Pore access. `epsPi` is AUTHORED per species (§5.8.1) and already clamped to [0, epsP] at
    // preset ingest; it is taken verbatim here and only reported on by `validateParams`.
    epsPi[i] = numOr(cp.epsPi, 0);
    KtLin[i] = epsPi[i];                 // pore-only linear limit until a mode overwrites it

    // Langmuir / HIC parameters (§5.8.2 field names).
    qmax_mM[i] = numOr(cp.qmax_mM, 0);
    b0[i] = clamp(numOr(cp.b0_mM1, 0), B_MIN, B_MAX);
    beta[i] = numOr(cp.beta_mM1, 0);
    csRef[i] = numOr(cp.csRef_mM, 0);

    // Linear parameter.
    Klin[i] = clamp(numOr(cp.Klin, 0), KLIN_MIN, KLIN_MAX);

    // Donnan (§5.8.3 / §7.2.4). zAbsIonised is the ONLY thing the group sums need from the
    // species config: |z| * ionisedFraction, precomputed once.
    const role = cp.donnanRole;
    donnanSign[i] = DONNAN_SIGN[role] !== undefined ? DONNAN_SIGN[role] : DONNAN_SIGN.NONE;
    zAbsIonised[i] = Math.abs(numOr(cp.charge, 0)) * numOr(cp.ionisedFraction, 0);
  }

  return {
    m,
    mode,
    Lambda_mM,
    lnLambda: Lambda_mM > 0 ? Math.log(Lambda_mM) : 0,
    // Fixed charge in the pore liquid, mM (§1.2, §7.2.4): X = Lambda / epsP = 411.7647 at the
    // shipped pilot preset.
    X_mM: epsP > 0 ? Lambda_mM / epsP : 0,
    epsP,
    resinChargeSign: numOr(resin.resinChargeSign, 0),

    nu, sig, Keq, lnKeq, lnNuSig, qmaxSMA_mM, epsPi,
    KtLin, qmax_mM, b0, beta, csRef, Klin,
    kindCode, donnanSign, zAbsIonised,

    enableDonnan: !!resin.enableDonnan,

    // Delivered here, read by relaxCell — this merge is what gives relaxCell a path to
    // C_KT/KT_MIN/KT_MAX at all (§6.7, §11 C-29).
    CS_MIN_mM: numOr(resin.CS_MIN_mM, 1.0),
    C_MIN_mM: numOr(resin.C_MIN_mM, 1e-12),
    C_KT_mM: numOr(resin.C_KT_mM, 1e-9),
    KT_MIN: numOr(resin.KT_MIN, 1e-3),
    KT_MAX: numOr(resin.KT_MAX, 1e6),

    // PER-MODEL scratch. Never module-scope: two live models (e.g. the startup benchmark column
    // and the run column) must not share it.
    scratch: {
      lw: new Float64Array(MAX_COMPONENTS),
      nuA: new Float64Array(MAX_COMPONENTS),
      idx: new Int32Array(MAX_COMPONENTS),
    },

    diag: {
      smaSlow: 0, smaNonConverged: 0, smaFrozen: 0,
      iterSum: 0, iterCalls: 0, langmuirOverflow: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Donnan partition (§7.2.4)
// ---------------------------------------------------------------------------

/**
 * The single-species form of the Donnan partition coefficient.
 *
 * `K_counter * K_co === 1` identically, and `K_counter*C - K_co*A === X` for ANY composition,
 * which is what makes the pore exactly electroneutral: SUM_i z_i q*_i = -epsP*X = -Lambda.
 *
 * @param {number} X_mM        fixed charge in the pore liquid, mM (= Lambda_mM / epsP)
 * @param {number} cCounter_mM counter-ion equivalents in the interstitial liquid, mM
 *        (= SUM |z_j| * ionisedFraction_j * c_j over donnanSign > 0)
 * @param {number} cCo_mM      co-ion equivalents, mM (same sum over donnanSign < 0)
 * @param {number} sign        +1 for a counter-ion, -1 for a co-ion, 0 for uncharged
 * @returns {number} partition coefficient K, dimensionless (>1 counter, <1 co, 1 for sign 0)
 */
export function donnanK(X_mM, cCounter_mM, cCo_mM, sign) {
  if (sign === 0) return 1;
  // Guard (§7.2.4): a stream with no counter-ions or no co-ions has no partition to speak of.
  if (!(cCounter_mM >= 1e-9) || !(cCo_mM >= 1e-9)) return sign > 0 ? 1 : 0;
  const S = Math.sqrt(X_mM * X_mM + 4 * cCounter_mM * cCo_mM);
  return sign > 0 ? (X_mM + S) / (2 * cCounter_mM) : (-X_mM + S) / (2 * cCo_mM);
}

/**
 * Write the pore-liquid baseline `q* = epsPi * K * c` into `out`, forming the two Donnan group
 * sums from THIS cell's own composition. Also refreshes `model.KtLin[i]` for every Donnan
 * species, which is exactly its linear-limit partition `epsPi_i * K_i` (the partition is linear
 * in c, so the secant and the limit coincide) — that is what `ktLinear` returns for kindCode 1.
 * @returns {void}
 */
function applyPoreBaseline(model, c_mM, out_mM) {
  const m = model.m;
  const epsPi = model.epsPi;
  const donnanSign = model.donnanSign;
  const KtLin = model.KtLin;

  if (!model.enableDonnan) {
    for (let i = 0; i < m; i++) {
      out_mM[i] = epsPi[i] * c_mM[i];
      if (model.kindCode[i] === 1) KtLin[i] = epsPi[i];
    }
    return;
  }

  // One pass forms both group sums (§7.2.4 prints two; one pass is the same arithmetic).
  // Negative concentrations cannot contribute — they would corrupt the electroneutrality
  // identity. `relaxCell` has already clamped them; a direct caller may not have.
  const zAbs = model.zAbsIonised;
  let C = 0, A = 0;
  for (let i = 0; i < m; i++) {
    const s = donnanSign[i];
    if (s === 0) continue;
    const ci = c_mM[i];
    if (!(ci > 0)) continue;
    const eq = zAbs[i] * ci;
    if (s > 0) C += eq; else A += eq;
  }

  const X = model.X_mM;
  let Kcounter = 1, Kco = 0;
  if (C >= 1e-9 && A >= 1e-9) {
    const S = Math.sqrt(X * X + 4 * C * A);
    Kcounter = (X + S) / (2 * C);
    Kco = (-X + S) / (2 * A);
  }

  for (let i = 0; i < m; i++) {
    const s = donnanSign[i];
    const K = s === 0 ? 1 : (s > 0 ? Kcounter : Kco);
    out_mM[i] = epsPi[i] * K * c_mM[i];
    if (model.kindCode[i] === 1) KtLin[i] = epsPi[i] * K;
  }
}

// ---------------------------------------------------------------------------
// The SMA solver (§6.7.1)
// ---------------------------------------------------------------------------

/**
 * R(x) = e^x + SUM_j e^(lw_j + nu_j x) - 1, using the active set already built in `scratch`.
 * Used only by the bracket expansion; the Newton loop fuses R and R' in one pass.
 * @returns {number} residual, dimensionless
 */
function smaResidual(model, nAct, x) {
  const lw = model.scratch.lw;
  const nuA = model.scratch.nuA;
  let R = Math.exp(x) - 1;
  for (let j = 0; j < nAct; j++) {
    const a = lw[j] + nuA[j] * x;
    if (a > LN_TINY) R += Math.exp(a);
  }
  return R;
}

/** F2 freeze: nothing moves this step, so the cell invariant is preserved exactly. */
function freezeCell(model, qCur_mM, out_mM) {
  model.diag.smaFrozen++;
  for (let i = 0, m = model.m; i < m; i++) out_mM[i] = qCur_mM[i];
  return NaN;
}

/**
 * Steric Mass Action equilibrium, solved in x = ln(qbar_s / Lambda).
 *
 * Structural theorems, restated here because the safeguards below are calibrated to them:
 *   T1  R'(x) = e^x + SUM nu_j e^(lw_j + nu_j x) > 0            => at most one root
 *   T2  R''(x) > 0                                              => R is strictly convex
 *   T3  R(-inf) = -1 < 0, R(0) >= 0                             => the root lies in (-inf, 0]
 *   T4  x_start = min(0, min_j(-lw_j/nu_j)) has R(x_start) >= 0 => a valid RIGHT bracket
 *   T6  every exp() argument along the path is <= 0             => no overflow, ever
 *   T7  convex + increasing + R(x0) >= 0 => undamped Newton converges monotonically and
 *       globally, never crossing the root.
 *
 * LEFT BRACKET — the closed form of §6.7.1 is NOT a bracket and is deliberately not used.
 *   `x_lo = x_start - ln(nAct+1)/nu_min` with `nu_min = min_j nu_j` omits the free-salt
 *   pseudo-component (nu_0 = 1, lw_0 = 0) from the minimum, and the T5 proof needs
 *   `nu_min = min(1, min_j nu_j)` for the "every term shrinks by exp(-nu_min*Delta)" step to
 *   cover the e^x term too. Verified counter-example (a fixture in tests/isotherm.test.js):
 *   one active component, nu = 5.2, lw = -0.103 gives x_start = 0, x_lo = -0.13330 and
 *   R(x_lo) = +0.326 against a true root of -0.26223 — no sign change. That is an ordinary
 *   peak flank (mAb at 5e-4 mM), so an implementation that validated that bracket would freeze
 *   the leading and trailing flank of every peak.
 *   What is shipped instead: start from `x_start - max(ln(nAct+1)/min(1, nu_min), 0.5)` — i.e.
 *   the repaired closed form, which does bracket — and then WIDEN GEOMETRICALLY until
 *   `R(x_lo) <= 0` is observed by evaluation. This terminates because R(x) -> -1 as x -> -inf,
 *   and the bracket is therefore proven by construction rather than by assumption.
 *
 * No warm start (§6.7.1, DEFERRED D17): the cold start is analytic and carries T4/T6/T7.
 *
 * @returns {number} x = ln(qbar_s / Lambda) <= 0, or NaN on an F2 freeze.
 */
function solveSMA(model, c_mM, csEff_mM, qCur_mM, out_mM) {
  const m = model.m;
  const nu = model.nu, Keq = model.Keq, lnKeq = model.lnKeq, lnNuSig = model.lnNuSig;
  const kindCode = model.kindCode, C_MIN = model.C_MIN_mM;
  const lw = model.scratch.lw, nuA = model.scratch.nuA, idx = model.scratch.idx;
  const lnLambda = model.lnLambda;
  const lnRatio = lnLambda - Math.log(csEff_mM);

  // ---- 1. active set and lw_j (eq. 2.21 of the SMA reduction) -------------
  let nAct = 0;
  let sumW0 = 0;          // SUM exp(lw_j), for the trace-loading fast path
  let xs = 0;             // running min for x_start; T3 caps it at 0
  let nuMin = 1;          // includes the free-salt pseudo-component nu_0 = 1
  for (let i = 0; i < m; i++) {
    if (kindCode[i] !== 2) continue;              // only binding species consume capacity
    const ci = c_mM[i];
    if (!(ci > C_MIN)) continue;                  // H2: absent (also rejects NaN and negatives)
    if (!(Keq[i] > 0)) continue;                  // non-binding component
    const nui = nu[i];
    if (!(nui > 0)) continue;                     // H6: -lw/nu is undefined at nu = 0
    const lwi = lnNuSig[i] + lnKeq[i] + Math.log(ci) + nui * lnRatio - lnLambda;
    if (!Number.isFinite(lwi)) continue;          // defensive; ln(0) etc.
    lw[nAct] = lwi;
    nuA[nAct] = nui;
    idx[nAct] = i;
    const xi = -lwi / nui;
    if (xi < xs) xs = xi;
    if (nui < nuMin) nuMin = nui;
    // Guarded: a term this large cannot be a "trace load", and exp() of it would be useless.
    if (lwi < 500) sumW0 += Math.exp(lwi); else sumW0 = Infinity;
    nAct++;
  }

  // ---- 2. FAST PATH A: nothing bound -> qbar_s = Lambda, x = 0 ------------
  // out already holds the pore-liquid (and Donnan) baseline.
  if (nAct === 0) return 0;

  let x;
  let iters = 0;

  if (sumW0 > 0 && sumW0 < 1e-8) {
    // ---- 3. FAST PATH C: trace loading, one-shot linearisation -----------
    // x* = ln(1 - S) to O(S^3), exact to double precision at this magnitude.
    x = -sumW0 - 0.5 * sumW0 * sumW0;
  } else {
    // ---- 4. brackets ----------------------------------------------------
    let xHi = xs;                                  // R(xHi) >= 0 by T4
    let xLo = xs - Math.max(Math.log(nAct + 1) / nuMin, 0.5);
    for (let k = 0; k < BRACKET_MAX_EXPANSIONS; k++) {
      if (smaResidual(model, nAct, xLo) <= 0) break;
      xLo -= (xs - xLo);                           // doubles the span each pass
    }

    // ---- 5. safeguarded Newton (S1..S5 of §6.7.1) -----------------------
    x = xs;
    let converged = false;
    for (let it = 1; it <= ITER_MAX; it++) {
      iters = it;
      // fused residual + derivative, single pass
      const ex = Math.exp(x);
      let R = ex - 1;
      let Rp = ex;
      for (let j = 0; j < nAct; j++) {
        const a = lw[j] + nuA[j] * x;
        if (a > LN_TINY) {                         // T6: a <= 0, so t is in (0, 1]
          const t = Math.exp(a);
          R += t;
          Rp += nuA[j] * t;
        }
      }
      if (!Number.isFinite(R) || !Number.isFinite(Rp) || Rp <= 0) {   // S1 — unreachable by T1/T6
        x = 0.5 * (xLo + xHi);
        continue;
      }
      // S5, generalised: keep BOTH brackets tight. This supersedes the literal S2 ("step > 0 =>
      // step = 0"), which assumes x is always the right bracket; with a real bracket pair a
      // positive step is legitimate whenever R(x) < 0 and is caught by the S4 containment test.
      if (R >= 0) xHi = x; else xLo = x;
      if (Math.abs(R) <= TOL_R) { converged = true; break; }

      let step = -R / Rp;
      if (step < -STEP_MAX) step = -STEP_MAX;      // S3
      else if (step > STEP_MAX) step = STEP_MAX;
      if (Math.abs(step) <= TOL_X) { x += step; converged = true; break; }

      let xn = x + step;
      if (!(xn > xLo && xn < xHi)) xn = 0.5 * (xLo + xHi);            // S4
      x = xn;
    }

    if (!converged) {
      if (xHi - xLo < 1e-6) {
        model.diag.smaSlow++;                      // F0 — answer is correct to 1e-6
      } else {
        model.diag.smaNonConverged++;              // F1 — accept the bisection midpoint
        x = 0.5 * (xLo + xHi);
      }
    }
  }

  model.diag.iterSum += iters;

  // ---- 6. FINALISE --------------------------------------------------------
  // x > 0 would mean qbar_s > Lambda, which is physically impossible; both branches are F2.
  if (!Number.isFinite(x) || x > 0) return freezeCell(model, qCur_mM, out_mM);

  const Lambda = model.Lambda_mM;
  const nuArr = model.nu, sigArr = model.sig;
  for (let j = 0; j < nAct; j++) {
    const i = idx[j];
    const a = lw[j] + nuA[j] * x;
    if (a > LN_TINY) {
      // q_ads_j = (Lambda/(nu_j+sigma_j)) * exp(lw_j + nu_j x); finite because a <= 0 (T6).
      out_mM[i] += (Lambda / (nuArr[i] + sigArr[i])) * Math.exp(a);
    }
  }
  return x;
}

// ---------------------------------------------------------------------------
// Competitive / modulated Langmuir (LANGMUIR, HIC) and the linear isotherm (LINEAR)
//
// CONTRACT GAP CLOSED HERE. architecture-v2 names LANGMUIR, HIC and LINEAR in the
// `config.column.isothermMode` enum (§2.1, §6.7) and fixes their RETURN contract (0, never NaN
// except on an F2 freeze — §6.7, §11 C-11) and their per-species parameter fields
// (`qmax_mM`, `b0_mM1`, `beta_mM1`, `csRef_mM`, `Klin` — §5.8.2), but writes no equilibrium
// body for any of them. The bodies below are the only forms those exact fields can express:
//
//   competitive Langmuir     D      = 1 + SUM_j b_j c_j
//                            q*_i   = epsPi_i c_i + q_max,i b_i c_i / D
//   modulator dependence     b_i(cs) = b0_i * exp(beta_i * (cs - csRef_i))
//                            beta > 0 salting-out (HIC), beta < 0 salting-in, beta = 0 affinity
//   linear                   q*_i   = epsPi_i c_i + Klin_i c_i
//
// HIC is therefore modulated competitive Langmuir with beta > 0 — NEVER SMA with a negative nu,
// which would destroy the monotonicity and convexity the SMA solver depends on (§6.7.1).
// The salt-dependent LINEAR forms are deliberately not folded into `Klin`: the IEX log-log form
// K(cs) = Keq (Lambda/cs)^nu is exactly the linear limit of SMA (use mode 'SMA'), and the HIC
// exponential form K(cs) = K0 exp(beta cs) is exactly the low-loading limit of the modulated
// Langmuir above (use mode 'HIC'). `Klin` stays a constant, so LINEAR has one unambiguous
// meaning and one code path.
// ---------------------------------------------------------------------------

/**
 * Modulated affinity b_i(cs) = b0_i * exp(beta_i * (cs - csRef_i)), mM^-1.
 * Returned as its logarithm so the overflow fallback never has to take ln(Infinity).
 * @returns {number} ln(b_i), dimensionless
 */
function lnAffinity(model, i, csEff_mM) {
  const b0 = model.b0[i];
  if (!(b0 > 0)) return -Infinity;
  return Math.log(b0) + model.beta[i] * (csEff_mM - model.csRef[i]);
}

/**
 * Competitive Langmuir with a shared surface, adding the adsorbed term to the pore-liquid
 * baseline already in `out`. `scratch.lw` doubles as the per-species affinity buffer here
 * (the SMA active set is not live on this branch), so nothing allocates.
 * @returns {void}
 */
function computeLangmuir(model, c_mM, csEff_mM, out_mM) {
  const m = model.m;
  const kindCode = model.kindCode, qmax = model.qmax_mM, C_MIN = model.C_MIN_mM;
  const bBuf = model.scratch.lw;

  // D >= 1 for all c_j >= 0, so the denominator can never be zero. No clamp needed.
  let D = 1;
  for (let i = 0; i < m; i++) {
    bBuf[i] = 0;
    if (kindCode[i] !== 2) continue;
    const ci = c_mM[i];
    if (!(ci > C_MIN)) continue;
    const bi = Math.exp(lnAffinity(model, i, csEff_mM));
    bBuf[i] = bi;
    D += bi * ci;
  }

  if (Number.isFinite(D)) {
    const invD = 1 / D;
    for (let i = 0; i < m; i++) {
      if (kindCode[i] !== 2) continue;
      const ci = c_mM[i];
      if (!(ci > C_MIN)) continue;
      out_mM[i] += qmax[i] * bBuf[i] * ci * invD;
    }
    return;
  }

  // H9 — D overflowed (only reachable with corrupt parameters, b_j c_j > 1e308). Fall back to
  // the saturation-share form q*_i = q_max,i * (b_i c_i) / SUM_j (b_j c_j), evaluated in log
  // space so no individual term is ever materialised.
  model.diag.langmuirOverflow++;
  const lnT = model.scratch.lw;                 // reuse: bBuf is dead from here on
  let maxLn = -Infinity;
  for (let i = 0; i < m; i++) {
    lnT[i] = -Infinity;
    if (kindCode[i] !== 2) continue;
    const ci = c_mM[i];
    if (!(ci > C_MIN)) continue;
    const v = lnAffinity(model, i, csEff_mM) + Math.log(ci);
    if (!Number.isFinite(v)) continue;
    lnT[i] = v;
    if (v > maxLn) maxLn = v;
  }
  if (!Number.isFinite(maxLn)) return;          // nothing competing; pore term only
  let S = 0;
  for (let i = 0; i < m; i++) {
    if (lnT[i] === -Infinity) continue;
    S += Math.exp(lnT[i] - maxLn);
  }
  if (!(S > 0)) return;
  const invS = 1 / S;
  for (let i = 0; i < m; i++) {
    if (lnT[i] === -Infinity) continue;
    out_mM[i] += qmax[i] * Math.exp(lnT[i] - maxLn) * invS;
  }
}

// ---------------------------------------------------------------------------
// Public equilibrium entry point
// ---------------------------------------------------------------------------

/**
 * Equilibrium TOTAL particle content q*_i for ONE cell, on BASIS N1 (adsorbed + pore liquid).
 *
 * There is NO cRef argument: the Donnan group sums are formed INSIDE this function from `c_mM`,
 * `model.donnanSign` and `model.zAbsIonised` (§7.2.4). One owner, one evaluation point.
 *
 * @param {object} model IsothermModel from `makeIsothermModel`
 * @param {Float64Array} c_mM   interstitial liquid concentrations, mM, length m (read only)
 * @param {number} cs_mM        modulator concentration, mM; floored at `model.CS_MIN_mM` in a
 *        LOCAL copy only — never written back, that would create salt
 * @param {Float64Array} qCur_mM current particle content, mM, length m; read ONLY on an F2 freeze
 * @param {Float64Array} out_mM  OUTPUT, q*_i in mM, length m; fully overwritten every call
 * @returns {number} x = ln(qbar_s/Lambda) (dimensionless, <= 0) for SMA; **0** for LANGMUIR,
 *   HIC, SEC, LINEAR and INERT; **NaN if and only if** the SMA solver failed and froze the cell
 *   (`out_mM` then equals `qCur_mM`, so the caller's relaxation moves nothing).
 */
export function computeQStar(model, c_mM, cs_mM, qCur_mM, out_mM) {
  // H1: local floor only.
  const csEff = cs_mM > model.CS_MIN_mM ? cs_mM : model.CS_MIN_mM;
  // Counted for EVERY mode, so `isoIterAvg = iterSum/iterCalls` is 0 (not 0/0 = NaN) on the
  // closed-form branches, which genuinely do run zero iterations.
  model.diag.iterCalls++;

  // Pore-liquid baseline for EVERY species, including the Donnan partition for kindCode 1.
  // Dropping this term breaks the SEC/tracer path and shifts the flow-through peak.
  applyPoreBaseline(model, c_mM, out_mM);

  switch (model.mode) {
    case 'SMA':
      return solveSMA(model, c_mM, csEff, qCur_mM, out_mM);
    case 'LANGMUIR':
    case 'HIC':
      computeLangmuir(model, c_mM, csEff, out_mM);
      return 0;
    case 'LINEAR': {
      const m = model.m, kindCode = model.kindCode, Klin = model.Klin;
      for (let i = 0; i < m; i++) {
        if (kindCode[i] === 2) out_mM[i] += Klin[i] * c_mM[i];
      }
      return 0;
    }
    case 'SEC':
    case 'INERT':
    default:
      // q* = epsPi_i * c_i, already written. Zero iterations.
      return 0;
  }
}

/**
 * The linear-limit partition Kt_i = q*_i/c_i evaluated in the limit c_i -> 0, for use when the
 * cell's own c_i has fallen below `model.C_KT_mM` and the secant would be 0/0. Desorption into
 * a clean liquid is exactly the case this exists for: c may be 1e-15 mM while q is 2 mM.
 *
 * Defined for EVERY mode:
 *   kindCode 1 (donnan) : epsPi_i * K_i, refreshed by the last `computeQStar` for this cell
 *   kindCode 0 (inert)  : epsPi_i
 *   SMA                 : epsPi_i + Keq_i * exp(nu_i * (x + lnLambda - ln csEff))
 *                         i.e. the CONVERGED qbar_s, not Lambda — one exp, no extra solve
 *   LANGMUIR / HIC      : epsPi_i + q_max,i * b_i(csEff)          (the c -> 0 limit of qstar/c)
 *   LINEAR              : epsPi_i + Klin_i
 *   SEC / INERT         : epsPi_i
 *
 * @param {object} model IsothermModel
 * @param {number} i     species index in COLUMN index order
 * @param {number} x     the value `computeQStar` returned for this cell (dimensionless); read
 *        only on the SMA branch
 * @param {number} cs_mM modulator concentration, mM — pass the SAME `csEff` the equilibrium used
 * @returns {number} Kt, dimensionless, always finite and >= 0
 */
export function ktLinear(model, i, x, cs_mM) {
  const kc = model.kindCode[i];
  if (kc === 1) return model.KtLin[i];
  const ePi = model.epsPi[i];
  if (kc !== 2) return ePi;

  const csEff = cs_mM > model.CS_MIN_mM ? cs_mM : model.CS_MIN_mM;
  let v = ePi;
  switch (model.mode) {
    case 'SMA': {
      if (model.Keq[i] > 0 && Number.isFinite(x)) {
        const a = model.nu[i] * (x + model.lnLambda - Math.log(csEff));
        if (a > LN_TINY) v = ePi + model.Keq[i] * Math.exp(a);
      }
      break;
    }
    case 'LANGMUIR':
    case 'HIC':
      v = ePi + model.qmax_mM[i] * Math.exp(lnAffinity(model, i, csEff));
      break;
    case 'LINEAR':
      v = ePi + model.Klin[i];
      break;
    default:
      break;
  }
  // Kt is clamped again by the caller; keep the return finite so a NaN can never reach k_eff.
  if (!Number.isFinite(v)) v = model.KT_MAX;
  model.KtLin[i] = v;
  return v;
}

/**
 * theta = 1 - exp(-u), computed accurately at both ends.
 *
 * NEVER substitute `1 - Math.exp(-u)`: it loses all relative precision below u ~ 1e-8
 * (catastrophic cancellation). `Math.expm1` is exact. The u > 40 branch skips a transcendental
 * in the common "salt equilibrates instantly" case, which runs every cell every step.
 *
 * NOTE on the reference table's last row. It reads ">= 37 -> 1 (exactly, in float64)"; the true
 * float64 crossover is u = 37.43 (`exp(-u)` must fall below half an ulp of 1, i.e. 5.551e-17,
 * and `exp(-37) = 8.533e-17`). `-expm1(-37)` and `1 - exp(-37)` both return 0.9999999999999999
 * — one ulp below 1 — so no implementation can satisfy `theta(37) === 1`. The branch threshold
 * here is the normative one (u > 40); the table row holds to within 1 ulp everywhere.
 *
 * @param {number} u  k' * dt, dimensionless (>= 0)
 * @returns {number} theta in [0, 1)
 */
export function theta(u) {
  if (!(u > 0)) return 0;                 // also catches NaN
  if (u < 1e-8) return u * (1 - 0.5 * u);
  if (u > 40) return 1;                   // exp(-40) = 4.2e-18 < eps/2
  return -Math.expm1(-u);
}

/**
 * The coupled analytic LDF relaxation for ONE cell: equilibrium, then an exact exponential
 * relaxation of every component toward the cell's TRUE joint equilibrium.
 *
 * Mutates `c_mM` and `q_mM` in place and conserves the cell invariant `c_i + phi*q_i` to within
 * one rounding of the product `phi*dq` (T11). Unconditionally stable at any `dt_s` (T8) and
 * positivity-preserving in both phases (T9) — the latter holds ONLY for the SECANT slope
 * `Kt = qstar/c`, which is why the tangent `dqstar/dc` must never be substituted here.
 *
 * @param {object} model IsothermModel
 * @param {Float64Array} c_mM  interstitial concentrations, mM, length m — MUTATED
 * @param {Float64Array} q_mM  particle total content, mM (BASIS N1), length m — MUTATED
 * @param {number} cs_mM       modulator concentration, mM (raw; floored locally)
 * @param {Float64Array} kOv_s1 liquid-side overall coefficients, 1/s, length m
 * @param {number} dt_s        timestep, s
 * @param {number} phi         (1 - epsC)/epsC, dimensionless
 * @param {number} VcellMob_mL mobile (interstitial) volume of this cell, mL — this is what turns
 *        the negative-c clamp into an AMOUNT: mM * mL = umol (R-U4)
 * @param {Float64Array} qstar_mM scratch, mM, length m — caller-owned, overwritten
 * @param {Float64Array} massDefect_umol cumulative UNSAFE-clamp ledger, umol, length m —
 *        INCREMENTED (never assigned) by the one unsafe clamp in this module
 * @returns {number} the `computeQStar` return value: x for SMA, 0 otherwise, NaN if the cell
 *   was frozen (in which case nothing was moved at all).
 */
export function relaxCell(model, c_mM, q_mM, cs_mM, kOv_s1, dt_s, phi, VcellMob_mL,
                          qstar_mM, massDefect_umol) {
  if (!(dt_s > 0)) return 0;                       // H13: paused flow, nothing to integrate
  const m = model.m;

  // The ONE unsafe clamp in this module (H3). Upwind transport is positivity-preserving under
  // the Courant condition so this should never fire; when it does it is accounted, never silent.
  for (let i = 0; i < m; i++) {
    const ci = c_mM[i];
    if (ci < 0) {
      if (massDefect_umol) massDefect_umol[i] += -ci * VcellMob_mL;   // mM * mL = umol (R-U4)
      c_mM[i] = 0;
    }
  }

  // The SAME modulator value is used by the equilibrium and by the linear-limit fallback.
  const csEff = cs_mM > model.CS_MIN_mM ? cs_mM : model.CS_MIN_mM;
  const x = computeQStar(model, c_mM, csEff, q_mM, qstar_mM);
  if (Number.isNaN(x)) return NaN;                 // F2 freeze — nothing moves, no mass created

  const C_KT = model.C_KT_mM, KT_MIN = model.KT_MIN, KT_MAX = model.KT_MAX;
  for (let i = 0; i < m; i++) {
    const ci = c_mM[i];
    // THE SECANT SLOPE, unclamped above. `KtDest` is what the DESTINATION is built from and it
    // must stay the true secant q*/c, because that — and only that — makes `qinf` the
    // mass-limited joint equilibrium:
    //     qinf = (q* + phi*Kt*q0)/(1 + phi*Kt) = q*(c + phi*q0)/(c + phi*q*)  <=  q0 + c/phi,
    // i.e. the destination can never demand more solute than the cell holds, so
    // c_new = c - phi*th*(qinf - q0) >= c*(1 - th) >= 0 for any dt (T9).
    //
    // KT_MAX MUST NOT REACH IT. Clamping Kt in `qinf` while leaving q* unclamped breaks that
    // identity: with Kt held at KT_MAX < q*/c the destination becomes q*/(1 + phi*KT_MAX), which
    // is ABOVE the ceiling by exactly the factor the clamp removed, and c lands at ~-2e-9 mM on
    // every clamped call. SBI at cs = 50 mM has a true Kt = Keq*(Lambda/cs)^nu = 5.4e7 and is
    // clamped by a factor of 54, so a 200 000-substep load/wash/gradient cycle recorded 644 013
    // clamp events and created 2.8e-2 umol of SBI out of nothing — a DoD 7 failure, not a
    // rounding one. The clamp is kept where it is harmless and needed: the RATE.
    let KtDest = (ci > C_KT) ? qstar_mM[i] / ci : ktLinear(model, i, x, csEff);
    if (!(KtDest > KT_MIN)) KtDest = KT_MIN;       // also catches NaN
    // The RATE clamp. k' = k_ov*(1/Kt + phi) is flat in Kt once phi*Kt >> 1, so bounding Kt here
    // is worth <2e-8 relative on k' at the ceiling; it exists so `kOv/Kt` cannot underflow and
    // `phi*Kt` cannot overflow on a pathological affinity.
    const KtRate = KtDest > KT_MAX ? KT_MAX : KtDest;

    const keff = kOv_s1[i] / KtRate;               // k_eff = k_ov / Kt, 1/s
    const th = theta(keff * (1 + phi * KtRate) * dt_s);   // k' = k_eff*(1 + phi*Kt)
    const pk = phi * KtDest;
    const q0 = q_mM[i];
    const qinf = (qstar_mM[i] + pk * q0) / (1 + pk);   // the cell's TRUE joint equilibrium
    const dq = th * (qinf - q0);
    q_mM[i] = q0 + dq;
    c_mM[i] = ci - phi * dq;                       // exact complement: c + phi*q is conserved
  }
  return x;
}

// ---------------------------------------------------------------------------
// Diagnostics, basis conversion and validation (operator rate — allocation permitted)
// ---------------------------------------------------------------------------

/**
 * SMA charge-balance closure for one cell, as a relative residual — the T4 acceptance check
 * (`qbar_s + SUM (nu+sigma) q_ads` must equal `Lambda` to <= 1e-9 relative, every cell, every
 * step).
 *
 * DIAGNOSTIC ONLY — it re-solves the equilibrium and therefore allocates one small array. Never
 * call it from the per-cell path (§13 DoD 5 permits allocation at operator rate only).
 *
 * `qbar_s = Lambda * exp(x)` comes from a FRESH solve at (c, cs), so it is independent of the
 * `q_mM` being checked; the electroneutrality relation is then evaluated against `q_mM`. The
 * alternative — recovering `qbar_s` from `Lambda - SUM (nu+sigma) q_ads` — would make the
 * identity true by construction and test nothing, and recovering it from the equilibrium
 * relation `q_ads = Keq c (qbar_s/cs)^nu` is ill-conditioned whenever the adsorbed term is much
 * smaller than the pore term it has to be subtracted out of (observed error 7e-3 in a fuzz).
 * The solver's own diagnostic counters are snapshotted and restored, so measuring the residual
 * never perturbs `isoIterAvg` or the freeze counts.
 *
 * @param {object} model IsothermModel
 * @param {Float64Array} c_mM interstitial concentrations, mM, length m
 * @param {number} cs_mM      modulator concentration, mM
 * @param {Float64Array} q_mM the TOTAL particle content to check, mM, length m — normally the
 *        `out_mM` a `computeQStar` call just produced
 * @returns {number} |qbar_s + SUM((nu+sigma)*q_ads) - Lambda| / Lambda, dimensionless.
 *   0 for every non-SMA mode (there is no Lambda bookkeeping to close); NaN if the cell froze.
 */
export function chargeBalanceResidual(model, c_mM, cs_mM, q_mM) {
  if (model.mode !== 'SMA') return 0;
  const Lambda = model.Lambda_mM;
  if (!(Lambda > 0)) return 0;

  const d = model.diag;
  const saved = [d.smaSlow, d.smaNonConverged, d.smaFrozen, d.iterSum, d.iterCalls];
  const x = computeQStar(model, c_mM, cs_mM, q_mM, new Float64Array(model.m));
  d.smaSlow = saved[0]; d.smaNonConverged = saved[1]; d.smaFrozen = saved[2];
  d.iterSum = saved[3]; d.iterCalls = saved[4];
  if (Number.isNaN(x)) return NaN;

  const qbar_s = Lambda * Math.exp(x);
  let sumCharge = 0;
  for (let i = 0, m = model.m; i < m; i++) {
    if (model.kindCode[i] !== 2) continue;
    const qAds = q_mM[i] - model.epsPi[i] * c_mM[i];      // strip the pore-liquid term
    if (!(qAds > 0)) continue;
    sumCharge += (model.nu[i] + model.sig[i]) * qAds;
  }
  return Math.abs(qbar_s + sumCharge - Lambda) / Lambda;
}

/**
 * Convert SMA / Langmuir / linear parameters between the solid-skeleton basis used by most
 * publications (`V_s = (1-epsT)*V_col`) and BASIS N1 (`V_bead = (1-epsC)*V_col`).
 *
 * With `f = 1 - epsP`, every solid-phase quantity scales by `f` under skel -> bead:
 *   nu, sigma, b   unchanged
 *   Lambda, q_max, Klin   -> f * value
 *   Keq                   -> Keq * f^(1 - nu)
 * The group `Keq * Lambda^(nu-1)` is invariant under the transform and is the right thing to
 * compare when two parameter sets disagree: if it differs they are genuinely different
 * chemistry, not a basis mix-up.
 *
 * @param {object} params  any object carrying some of `Lambda_mM`, `nu`, `sigma`, `Keq`,
 *        `qmax_mM`, `Klin`. Never mutated.
 * @param {number} epsP    particle porosity, dimensionless
 * @param {'skelToBead'|'beadToSkel'} direction
 * @returns {object} a NEW object: a shallow copy of `params` with the recognised fields
 *   transformed. Units are unchanged (mM stays mM); only the volume basis moves.
 */
export function convertSMABasis(params, epsP, direction) {
  const out = Object.assign({}, params);
  const f = 1 - epsP;
  if (!(f > 0) || !Number.isFinite(f)) return out;
  const toBead = direction === 'skelToBead';
  const s = toBead ? f : 1 / f;
  const nuv = numOr(params.nu, 0);

  if (typeof params.Lambda_mM === 'number') out.Lambda_mM = params.Lambda_mM * s;
  if (typeof params.qmax_mM === 'number') out.qmax_mM = params.qmax_mM * s;
  if (typeof params.Klin === 'number') out.Klin = params.Klin * s;
  if (typeof params.Keq === 'number') {
    out.Keq = params.Keq * Math.pow(f, toBead ? (1 - nuv) : (nuv - 1));
  }
  return out;
}

/**
 * Validate a resin + component set against the isotherm parameter box.
 *
 * `makeIsothermModel` CLAMPS the "clamp, warn" rows silently; this is where they are reported.
 * The rows that must refuse to run are returned as errors.
 *
 * @param {object} resin  same shape as `makeIsothermModel`'s first argument
 * @param {Array<object>} comps ColumnSpeciesConfig[]
 * @returns {{ok:boolean, errors:string[], warnings:string[]}} `ok` is true iff `errors` is empty.
 */
export function validateParams(resin, comps) {
  const errors = [];
  const warnings = [];
  const mode = resin && resin.mode;
  if (MODES.indexOf(mode) < 0) {
    errors.push(`isothermMode ${JSON.stringify(mode)} is not one of ${MODES.join('|')}`);
  }
  const m = Array.isArray(comps) ? comps.length : 0;
  if (m > MAX_COMPONENTS) {
    errors.push(`${m} components exceeds MAX_COMPONENTS = ${MAX_COMPONENTS}`);
  }

  const epsP = numOr(resin.epsP, 0);
  if (!(epsP >= EPSP_MIN && epsP <= EPSP_MAX)) {
    errors.push(`epsP = ${epsP} outside [${EPSP_MIN}, ${EPSP_MAX}]`);
  }

  const Lambda = numOr(resin.Lambda_mM, 0);
  if (mode === 'SMA') {
    if (!(Lambda >= LAMBDA_MIN_mM && Lambda <= LAMBDA_MAX_mM)) {
      errors.push(`Lambda_mM = ${Lambda} outside [${LAMBDA_MIN_mM}, ${LAMBDA_MAX_mM}] mM`);
    }
  }
  const csMin = numOr(resin.CS_MIN_mM, 1.0);
  if (!(csMin > 0)) errors.push(`CS_MIN_mM = ${csMin} must be > 0`);
  else if (csMin < 0.1) warnings.push(`CS_MIN_mM = ${csMin} mM is below the recommended 0.1 mM`);

  const lnLambda = Lambda > 0 ? Math.log(Lambda) : 0;
  const lnRatioMax = lnLambda - Math.log(csMin);

  for (let i = 0; i < m; i++) {
    const cp = comps[i] || {};
    const id = cp.id !== undefined ? cp.id : `#${i}`;
    const kind = cp.kind;
    const ePi = numOr(cp.epsPi, 0);
    if (!(ePi >= 0)) errors.push(`${id}: epsPi = ${cp.epsPi} must be >= 0`);
    else if (ePi > epsP) warnings.push(`${id}: epsPi ${ePi} exceeds resin epsP ${epsP}`);

    if (kind !== 'binding') continue;

    if (mode === 'SMA') {
      const nuv = numOr(cp.nu, 0);
      const sg = numOr(cp.sigma, 0);
      const kq = numOr(cp.Keq, 0);
      if (nuv < NU_MIN || nuv > NU_MAX) {
        warnings.push(`${id}: nu ${nuv} clamped into [${NU_MIN}, ${NU_MAX}]`);
      }
      if (sg < SIGMA_MIN || sg > SIGMA_MAX) {
        warnings.push(`${id}: sigma ${sg} clamped into [${SIGMA_MIN}, ${SIGMA_MAX}]`);
      }
      if (kq < KEQ_MIN || kq > KEQ_MAX) {
        warnings.push(`${id}: Keq ${kq} clamped into [${KEQ_MIN}, ${KEQ_MAX}]`);
      }
      const nuC = clamp(nuv, NU_MIN, NU_MAX);
      const sgC = clamp(sg, SIGMA_MIN, SIGMA_MAX);
      const kqC = clamp(kq, KEQ_MIN, KEQ_MAX);
      if (kqC > 0 && nuC > 0) {
        // Overflow envelope (§6.7.1): worst-case lw at c = 1e4 mM and cs = CS_MIN must stay well
        // below ln(MAX_DOUBLE). Checked here so the envelope is verified, not assumed.
        const lwMax = Math.log(nuC + sgC) + Math.log(kqC) + Math.log(1e4)
          + nuC * lnRatioMax - lnLambda;
        if (!(lwMax < LW_MAX)) {
          errors.push(`${id}: worst-case lw = ${lwMax.toFixed(1)} exceeds ${LW_MAX}; the SMA ` +
            'overflow envelope is violated');
        }
        // Elution salt at K_lin = 1 (eq. 2.14): cs_R = Lambda * Keq^(1/nu).
        const csElute = Lambda * Math.pow(kqC, 1 / nuC);
        if (!(csElute >= 20 && csElute <= 1000)) {
          warnings.push(`${id}: K_lin = 1 at cs = ${csElute.toFixed(1)} mM, outside 20-1000 mM`);
        }
        // Derived static capacity, expressed per mL of BEAD volume (BASIS N1).
        const MW = numOr(cp.MW_gmol, 0);
        if (MW > 0 && nuC + sgC > 0) {
          const qmaxGL = (Lambda / (nuC + sgC)) * MW / 1000;
          if (!(qmaxGL >= 2 && qmaxGL <= 400)) {
            warnings.push(`${id}: derived q_max = ${qmaxGL.toFixed(1)} g/L bead is outside the ` +
              'usual 2-400 g/L bead band');
          }
        }
      }
    } else if (mode === 'LANGMUIR' || mode === 'HIC') {
      const qm = numOr(cp.qmax_mM, 0);
      if (!(qm > 0)) errors.push(`${id}: qmax_mM = ${cp.qmax_mM} must be > 0 in ${mode} mode`);
      else if (qm > QMAX_MAX_mM) warnings.push(`${id}: qmax_mM ${qm} exceeds ${QMAX_MAX_mM} mM`);
      const b = numOr(cp.b0_mM1, 0);
      if (b < B_MIN || b > B_MAX) {
        warnings.push(`${id}: b0_mM1 ${b} clamped into [${B_MIN}, ${B_MAX}]`);
      }
      const bt = numOr(cp.beta_mM1, 0);
      if (mode === 'HIC' && !(bt > 0)) {
        warnings.push(`${id}: HIC expects beta_mM1 > 0 (salting-out); got ${bt}`);
      }
    } else if (mode === 'LINEAR') {
      const kl = numOr(cp.Klin, 0);
      if (kl < KLIN_MIN || kl > KLIN_MAX) {
        warnings.push(`${id}: Klin ${kl} clamped into [${KLIN_MIN}, ${KLIN_MAX}]`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
