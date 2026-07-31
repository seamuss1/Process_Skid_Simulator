/**
 * src/physics/column.js — the transport-dispersive column, on BASIS N1 (architecture-v2 §6.9).
 *
 * Convection (upwind, split), optional explicit axial dispersion, local equilibrium and the
 * coupled LDF relaxation. No DOM. Imports only `core/util.js`, `physics/isotherm.js` and
 * `physics/masstransfer.js` (layer L2 -> L1/L0, §4).
 *
 * UNITS (§1, binding). Length cm, area cm2, volume mL, time s, flow mL/s, superficial velocity
 * cm/s, ALL concentrations mM, particle load q mM per mL of BEAD volume, amount umol (= mM * mL),
 * diffusivity cm2/s, rate 1/s, viscosity cP, density g/mL, plate height cm.
 *
 * BASIS N1 (§1.2). `q_i` is the TOTAL particle content (adsorbed + pore liquid) per mL of bead
 * volume; `c_i` is the interstitial concentration. `phi = (1 - epsC)/epsC`. The quantity the
 * kinetic update conserves EXACTLY, per cell, is `c + phi*q`.
 *
 * ARRAY LENGTHS (§1.2). EVERY per-species array in this file is `nsCol` — the TRANSPORTED count,
 * never `ns` (the species registry length). They are equal in the shipped pilot preset and
 * unequal in the SEC preset, which is exactly how a bug of this class ships. `physics/bed.js`
 * owns the `ns <-> nsCol` mapping and this file never sees a registry index.
 *
 * LAYOUT. `c` and `q` are SPECIES-MAJOR, CELL-MINOR: `idx = i*nz + n`. `n = 0` is the inlet for
 * forward (Q > 0) flow.
 *
 * ZERO ALLOCATION in `stepColumn` and everything it calls. Every buffer is preallocated in
 * `createColumn`; the two object arguments the masstransfer correlations take are preallocated
 * scratch objects that are mutated in place.
 */

import { clamp } from '../core/util.js';
import {
  makeIsothermModel,
  computeQStar,
  ktLinear,
  relaxCell,
} from './isotherm.js';
import {
  computeAllKov,
  kovBreakdown,
  diffusivityPolson_cm2s,
  stokesRadius_cm,
  porediff_cm2s,
  filmCoefficient_cms,
} from './masstransfer.js';

/** Substeps between forced whole-column equilibrium passes (§6.9.4). */
const FULL_PASS_EVERY = 64;
/** Substeps between NaN tripwire checks (§6.9.3 S4). */
const NAN_TRIPWIRE_EVERY = 256;
/** Combined advection-diffusion stability bound, `nu + 2*beta <= 0.98` (§7.2.3). */
const STABILITY_LIMIT = 0.98;
/** Default fluid state until `setFlowDependentCoefficients` is called with the real one. */
const DEFAULT_T_C = 20.0;
const DEFAULT_MU_CP = 1.002;
const DEFAULT_RHO_GML = 0.9982;

/**
 * The ONE wall-clock read in `src/physics/`. It exists because `benchmarkColumn` is contractually
 * required to return `msPerSimSecond` (§6.9, §2.4 boot step 3) and a benchmark cannot be written
 * without a clock. It is NOT on the physics path: `benchmarkColumn` is called once, at startup,
 * on a throwaway column, and its result never feeds back into `run`. Determinism (§3.2 T29) is
 * unaffected. Callers that want a hermetic benchmark pass `opts.now`.
 *
 * @returns {number} milliseconds from an arbitrary origin, or 0 when no clock is available.
 */
function defaultClock_ms() {
  const g = globalThis;
  const p = g.performance;
  if (p && typeof p.now === 'function') return p.now();
  return 0;
}

/**
 * Build a Column from a fully assembled createColumn cfg.
 *
 * `cfg` is `{ ...config.column, comps: ColumnSpeciesConfig[], chem: config.chem }` and is
 * ASSEMBLED IN EXACTLY ONE PLACE — `physics/bed.js::buildColumnCfg(config)` (§6.9, §6.11).
 * `cfg.chem` is mandatory: `makeIsothermModel`'s `resin` needs CS_MIN_mM, C_MIN_mM, C_KT_mM,
 * KT_MIN and KT_MAX, and all five live in `config.chem`, not `config.column`.
 *
 * @param {object} cfg createColumn cfg.
 * @param {Array<object>} cfg.comps ColumnSpeciesConfig[] (§5.8.2) in COLUMN index order.
 * @param {object} cfg.chem `config.chem`.
 * @param {number} cfg.nz axial cell count.
 * @param {number} cfg.L_cm bed height, cm.
 * @param {number} cfg.A_cm2 cross-section, cm2.
 * @param {number} cfg.epsC interstitial porosity, dimensionless.
 * @param {number} cfg.epsP particle porosity, dimensionless.
 * @param {number} cfg.dp_cm particle diameter, cm.
 * @param {number} cfg.rp_cm particle radius, cm.
 * @param {number} cfg.rPore_cm pore radius, cm.
 * @param {number} cfg.Lambda_mM ionic capacity on the BEAD basis, mM.
 * @param {string} cfg.isothermMode 'SMA'|'LANGMUIR'|'HIC'|'SEC'|'LINEAR'|'INERT'.
 * @param {number} cfg.modulatorColIdx COLUMN index of the modulator species (-1 if none).
 * @returns {object} Column — see the file header for the field list. All arrays preallocated.
 */
export function createColumn(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new TypeError('createColumn(cfg): cfg is required');
  }
  if (!Array.isArray(cfg.comps)) {
    throw new TypeError(
      'createColumn(cfg): cfg.comps must be a ColumnSpeciesConfig[] in COLUMN index order — ' +
      'assemble it with physics/bed.js::buildColumnCfg(config), never by hand and never ' +
      'config.column alone (§6.9)');
  }
  if (!cfg.chem) {
    throw new TypeError(
      'createColumn(cfg): cfg.chem is MANDATORY (§6.9) — CS_MIN_mM/C_MIN_mM/C_KT_mM/KT_MIN/' +
      'KT_MAX reach makeIsothermModel through it and there is no other path');
  }

  const comps = cfg.comps;
  const nsCol = comps.length;
  const nz = Math.max(1, cfg.nz | 0);

  const epsC = cfg.epsC;
  const epsP = cfg.epsP;
  const epsT = (cfg.epsT != null) ? cfg.epsT : epsC + (1 - epsC) * epsP;
  // phi is RECOMPUTED here rather than read from cfg.phi. config.column.phi is authored to seven
  // digits (1.8571429) and the mass audit's tolerance is 1e-11 relative (§10), three orders
  // tighter than that rounding. relaxCell conserves `c + phi*q` with the phi WE pass, while
  // totalMass_umol weighs with epsC and (1-epsC); the two agree to machine precision only when
  // phi is exactly (1-epsC)/epsC.
  const phi = (1 - epsC) / epsC;

  const A_cm2 = (cfg.A_cm2 != null) ? cfg.A_cm2 : Math.PI * cfg.id_cm * cfg.id_cm / 4;
  const L_cm = cfg.L_cm;
  const dz_cm = L_cm / nz;
  const Vcell_mL = A_cm2 * dz_cm;              // total cell volume, mL
  const VcellMob_mL = epsC * Vcell_mL;         // interstitial (mobile) cell volume, mL
  const VcellBead_mL = Vcell_mL - VcellMob_mL; // bead (particle) cell volume, mL
  const V_mL = A_cm2 * L_cm;                   // exactly nz*Vcell_mL

  const chem = cfg.chem;
  const iso = makeIsothermModel({
    Lambda_mM: cfg.Lambda_mM,
    mode: cfg.isothermMode,
    epsP,
    resinChargeSign: cfg.resinChargeSign,
    enableDonnan: cfg.enableDonnan,
    CS_MIN_mM: chem.CS_MIN_mM,
    C_MIN_mM: chem.C_MIN_mM,
    C_KT_mM: chem.C_KT_mM,
    KT_MIN: chem.KT_MIN,
    KT_MAX: chem.KT_MAX,
  }, comps);

  const diag = {
    // ---- per-species, Float64Array(nsCol) (§6.9.5) ----
    hetpTarget_cm: new Float64Array(nsCol),
    hetpNumerical_cm: new Float64Array(nsCol),
    hetpKinetic_cm: new Float64Array(nsCol),
    hetpDispersive_cm: new Float64Array(nsCol),
    hetpSimulated_cm: new Float64Array(nsCol),
    hetpExcess_cm: new Float64Array(nsCol),
    sigmaInflation: new Float64Array(nsCol),
    plateNumberSim: new Float64Array(nsCol),
    kPrime: new Float64Array(nsCol),
    KtBar: new Float64Array(nsCol),
    // ---- scalars (§6.9.5) ----
    clampCount: 0,
    isoIterAvg: 0,
    activeCells: 0,
    fullPassCounter: 0,
    smaFrozen: 0,
    smaNonConverged: 0,
  };
  diag.sigmaInflation.fill(1);

  const col = {
    // ---- GEOMETRY ----
    nz, nsCol, A_cm2, V_mL, Vcell_mL, VcellMob_mL, VcellBead_mL, dz_cm,
    epsC, epsP, epsT, phi, L_cm,

    // ---- NUMERICS ----
    nuTarget: (cfg.nuTarget != null) ? cfg.nuTarget : 0.95,
    dtCap_s: (cfg.dtCap_s != null) ? cfg.dtCap_s : 0.5,
    nSubMax: (cfg.nSubMax != null) ? (cfg.nSubMax | 0) : 64,
    enableExplicitDispersion: !!cfg.enableExplicitDispersion,
    DL_override_cm2s: (cfg.DL_override_cm2s != null) ? cfg.DL_override_cm2s : null,
    modulatorColIdx: (cfg.modulatorColIdx != null) ? (cfg.modulatorColIdx | 0) : -1,

    // ---- PRIMARY STATE (species-major, cell-minor: idx = i*nz + n) ----
    c: new Float64Array(nsCol * nz),   // interstitial concentration, mM
    q: new Float64Array(nsCol * nz),   // total particle content, mM per bead volume

    // ---- PER-SPECIES SCALARS ----
    epsPi: new Float64Array(nsCol),
    Dm_cm2s: new Float64Array(nsCol),
    Dp_cm2s: new Float64Array(nsCol),
    kf_cms: new Float64Array(nsCol),
    kOv_s1: new Float64Array(nsCol),
    A_vd_cm: new Float64Array(nsCol),
    B_vd_cm2s: new Float64Array(nsCol),
    C_vd_s: new Float64Array(nsCol),
    DL_cm2s: new Float64Array(nsCol),
    beta: new Float64Array(nsCol),      // dispersion number DL*dt/dz^2, dimensionless
    Rbar: new Float64Array(nsCol),      // retardation factor 1 + phi*KtBar
    KtBar: new Float64Array(nsCol),     // column-average secant partition, dimensionless

    // ---- MASS AUDIT (umol) ----
    massIn_umol: new Float64Array(nsCol),
    massOut_umol: new Float64Array(nsCol),
    massClamped_umol: new Float64Array(nsCol),
    mass0_umol: new Float64Array(nsCol),

    // ---- I/O + SCRATCH (never escape) ----
    cOut: new Float64Array(nsCol),
    cInHold: new Float64Array(nsCol),
    cCell: new Float64Array(nsCol),
    qCell: new Float64Array(nsCol),
    qStar: new Float64Array(nsCol),
    kOvCell: new Float64Array(nsCol),
    cOutSub: new Float64Array(nsCol),
    cOutAcc: new Float64Array(nsCol),
    tol_mM: new Float64Array(nsCol),
    lo: new Int32Array(nsCol),
    hi: new Int32Array(nsCol),

    // preallocated argument objects for the two masstransfer correlations that take one
    scratchPore: { Dm_cm2s: 0, rs_cm: 0, rPore_cm: cfg.rPore_cm, epsPi: 0 },
    scratchFilm: { u_cms: 0, dp_cm: cfg.dp_cm, epsC, Dm_cm2s: 0, mu_cP: 0, rho_gmL: 0 },

    // ---- CACHED FLUID STATE ----
    uSuperficial_cms: 0,
    T_C: DEFAULT_T_C,
    mu_cP: DEFAULT_MU_CP,
    rho_gmL: DEFAULT_RHO_GML,
    uKovCached_cms: -1,
    muKovCached_cP: -1,
    kovValid: false,
    lambdaPack: (cfg.lambdaPack != null) ? cfg.lambdaPack : 1.0,

    // ---- STATUS ----
    faulted: false,
    substepCounter: 0,
    comps,
    cfg,
    iso,
    diag,

    // ---- StepResult SINGLETON (§6.9.1) — reused, never destructured and kept ----
    result: {
      cOut: null,             // set to col.cOut immediately below
      dtAdvanced_s: 0,
      nSub: 0,
      speedDeficit: 1,
      courant: 0,
      status: 0,
    },
  };
  col.result.cOut = col.cOut;

  for (let i = 0; i < nsCol; i++) {
    const cm = comps[i];
    col.epsPi[i] = cm.epsPi;
    // Active-window tolerance, §6.9.4: tol_i = 1e-6 * comps[i].concScale_mM.
    const scale = (cm.concScale_mM > 0) ? cm.concScale_mM : 1e-3;
    col.tol_mM[i] = 1e-6 * scale;
    col.KtBar[i] = cm.epsPi;
    col.Rbar[i] = 1 + phi * cm.epsPi;
  }

  resetColumn(col, null);
  return col;
}

/**
 * Reset the column to a uniform composition, with the particle phase at equilibrium with it.
 *
 * Zeroes every accumulator, the diagnostics and the fault latch, and re-baselines
 * `col.mass0_umol` so `massBalanceResidual` closes from the new state.
 *
 * @param {object} col Column.
 * @param {Float64Array|null} cEq_mM length nsCol, mM; null means an empty (all-zero) column.
 * @returns {void}
 */
export function resetColumn(col, cEq_mM) {
  const { nz, nsCol, c, q, cCell, qCell, qStar, iso } = col;

  if (cEq_mM) {
    for (let i = 0; i < nsCol; i++) {
      const v = cEq_mM[i] > 0 ? cEq_mM[i] : 0;
      cCell[i] = v;
      qCell[i] = 0;
      c.fill(v, i * nz, i * nz + nz);
    }
    const m = col.modulatorColIdx;
    const csEff = Math.max((m >= 0 && m < nsCol) ? cCell[m] : 0, iso.CS_MIN_mM);
    const x = computeQStar(iso, cCell, csEff, qCell, qStar);
    for (let i = 0; i < nsCol; i++) {
      // On an F2 freeze (x === NaN) fall back to the pore-liquid-only content, which is the
      // correct answer for an inert species and a safe floor for a binding one.
      const qi = Number.isNaN(x) ? col.epsPi[i] * cCell[i] : qStar[i];
      q.fill(qi > 0 ? qi : 0, i * nz, i * nz + nz);
    }
  } else {
    c.fill(0);
    q.fill(0);
    cCell.fill(0);
  }

  col.cInHold.set(cCell);
  col.cOut.set(cCell);
  col.massIn_umol.fill(0);
  col.massOut_umol.fill(0);
  col.massClamped_umol.fill(0);
  col.faulted = false;
  col.substepCounter = 0;
  col.kovValid = false;
  col.uKovCached_cms = -1;
  col.muKovCached_cP = -1;

  const d = col.diag;
  d.clampCount = 0;
  d.isoIterAvg = 0;
  d.activeCells = 0;
  d.fullPassCounter = 0;
  d.smaFrozen = 0;
  d.smaNonConverged = 0;
  if (iso.diag) {
    iso.diag.smaSlow = 0;
    iso.diag.smaNonConverged = 0;
    iso.diag.smaFrozen = 0;
    iso.diag.iterSum = 0;
    iso.diag.iterCalls = 0;
    iso.diag.langmuirOverflow = 0;
  }

  totalMass_umol(col, col.mass0_umol);

  col.result.dtAdvanced_s = 0;
  col.result.nSub = 0;
  col.result.speedDeficit = 1;
  col.result.courant = 0;
  col.result.status = 0;
}

/* ------------------------------------------------------------------------------------------ *
 * Flow-dependent coefficients
 * ------------------------------------------------------------------------------------------ */

/**
 * Recompute Dm, Dp, kf and k_ov for every species. Allocation-free: the two correlations that
 * take an options object are handed preallocated scratch objects.
 * @param {object} col Column.
 * @param {number} u_cms SUPERFICIAL velocity, cm/s, always >= 0.
 * @param {number} T_C temperature, degC.
 * @param {number} mu_cP dynamic viscosity, cP.
 * @param {number} rho_gmL density, g/mL.
 * @returns {void}
 */
function refreshTransportCoefficients(col, u_cms, T_C, mu_cP, rho_gmL) {
  const { comps, nsCol, cfg, scratchPore, scratchFilm } = col;
  for (let i = 0; i < nsCol; i++) {
    const cm = comps[i];
    // Precedence (§6.8): an explicit Dm is used VERBATIM, else Polson with the T/mu correction.
    const Dm = (cm.Dm_cm2s != null) ? cm.Dm_cm2s
      : diffusivityPolson_cm2s(cm.MW_gmol, T_C, mu_cP);
    col.Dm_cm2s[i] = Dm;

    let Dp;
    if (cm.Dp_cm2s != null) {
      Dp = cm.Dp_cm2s;
    } else {
      scratchPore.Dm_cm2s = Dm;
      scratchPore.rs_cm = stokesRadius_cm(Dm, T_C, mu_cP);
      scratchPore.rPore_cm = cfg.rPore_cm;
      scratchPore.epsPi = cm.epsPi;   // §6.8: the SPECIES' accessible pore porosity, not epsP
      Dp = porediff_cm2s(scratchPore);
    }
    col.Dp_cm2s[i] = Dp;

    scratchFilm.u_cms = u_cms;
    scratchFilm.dp_cm = cfg.dp_cm;
    scratchFilm.epsC = col.epsC;
    scratchFilm.Dm_cm2s = Dm;
    scratchFilm.mu_cP = mu_cP;
    scratchFilm.rho_gmL = rho_gmL;
    col.kf_cms[i] = filmCoefficient_cms(scratchFilm);
  }
  // k_ov has exactly one authority: masstransfer.computeAllKov (§6.8).
  computeAllKov(cfg, comps, u_cms, T_C, mu_cP, rho_gmL, col.kOv_s1);
  col.kOvCell.set(col.kOv_s1);
}

/**
 * Refresh `col.KtBar` / `col.Rbar` from the column-average composition.
 *
 * `KtBar` is the secant partition `q* / c` at the mean state — the quantity the van Deemter C term,
 * the numerical-dispersion law `H_num = dz*(1 - nu/R)` and the apportionment of §7.2.3 all need.
 * At `c` below `C_KT_mM` the linear (infinite-dilution) partition `ktLinear` is used instead,
 * which is what makes a blank column report the right retention.
 * @param {object} col Column.
 * @returns {void}
 */
function refreshPartition(col) {
  const { nsCol, nz, c, q, cCell, qCell, qStar, iso } = col;
  const inv = 1 / nz;
  for (let i = 0; i < nsCol; i++) {
    const base = i * nz;
    let sc = 0;
    let sq = 0;
    for (let n = 0; n < nz; n++) { sc += c[base + n]; sq += q[base + n]; }
    cCell[i] = sc * inv;
    qCell[i] = sq * inv;
  }
  const m = col.modulatorColIdx;
  const csEff = Math.max((m >= 0 && m < nsCol) ? cCell[m] : 0, iso.CS_MIN_mM);
  const x = computeQStar(iso, cCell, csEff, qCell, qStar);
  for (let i = 0; i < nsCol; i++) {
    let Kt;
    if (Number.isNaN(x)) {
      Kt = col.KtBar[i] > 0 ? col.KtBar[i] : col.epsPi[i];
    } else if (cCell[i] > iso.C_KT_mM) {
      Kt = qStar[i] / cCell[i];
    } else {
      Kt = ktLinear(iso, i, x, csEff);
    }
    // Clamped at 0, NOT at KT_MIN. KT_MIN is a solver-internal floor that exists so relaxCell's
    // `keff = kOv/Kt` cannot divide by zero; applying it to the REPORTED partition would move the
    // retention identity of §7.2.5 off its degenerate case (Kt = 0 must give exactly 0.35 CV, and
    // KT_MIN = 1e-3 turns that into 0.35065). The upper clamp is kept: it is the one relaxCell
    // actually transports with.
    Kt = clamp(Kt, 0, iso.KT_MAX);
    col.KtBar[i] = Kt;
    col.Rbar[i] = 1 + col.phi * Kt;
  }
}

/**
 * Refresh the van Deemter A / B / C coefficients from the current partition and k_ov.
 * `H = A + B/u_i + C*u_i` with `u_i` the INTERSTITIAL velocity (§7.2.3).
 * @param {object} col Column.
 * @returns {void}
 */
function refreshVanDeemter(col) {
  const A_cm = 2 * col.lambdaPack * col.cfg.dp_cm;
  const gamma = (col.cfg.gammaObstruction != null) ? col.cfg.gammaObstruction : 0.7;
  for (let i = 0; i < col.nsCol; i++) {
    col.A_vd_cm[i] = A_cm;
    col.B_vd_cm2s[i] = 2 * gamma * col.Dm_cm2s[i];
    const Kt = col.KtBar[i];
    const kPrime = col.phi * Kt;
    const keff_s1 = col.kOv_s1[i] / Math.max(Kt, 1e-30);
    // H_kin = 2*u_i*kPrime/(k_eff*(1+kPrime)^2), i.e. C_vd = H_kin/u_i.
    col.C_vd_s[i] = (keff_s1 > 0)
      ? 2 * kPrime / (keff_s1 * (1 + kPrime) * (1 + kPrime))
      : 0;
  }
}

/**
 * Refresh every flow-, temperature- and viscosity-dependent coefficient on the column.
 *
 * The expensive part (Dm / Dp / kf / k_ov) is gated exactly as §6.8 requires: it is recomputed
 * only when `|du|/u > 1 %` or `|dmu|/mu > 2 %`. The cheap parts (the partition and the van
 * Deemter terms) are refreshed on every call. `stepColumn` calls this once per call — never per
 * substep — so a caller that only ever uses `stepColumn` still gets correct coefficients.
 *
 * @param {object} col Column.
 * @param {number} u_cms SUPERFICIAL velocity, cm/s (magnitude; the sign lives in dV).
 * @param {number} T_C fluid temperature, degC.
 * @param {number} mu_cP dynamic viscosity, cP.
 * @param {number} rho_gmL density, g/mL.
 * @returns {void}
 */
export function setFlowDependentCoefficients(col, u_cms, T_C, mu_cP, rho_gmL) {
  const u = Math.abs(u_cms);
  col.uSuperficial_cms = u;
  col.T_C = T_C;
  col.mu_cP = mu_cP;
  col.rho_gmL = rho_gmL;

  const du = Math.abs(u - col.uKovCached_cms) / Math.max(col.uKovCached_cms, 1e-12);
  const dmu = Math.abs(mu_cP - col.muKovCached_cP) / Math.max(col.muKovCached_cP, 1e-12);
  if (!col.kovValid || du > 0.01 || dmu > 0.02) {
    refreshTransportCoefficients(col, u, T_C, mu_cP, rho_gmL);
    col.uKovCached_cms = u;
    col.muKovCached_cP = mu_cP;
    col.kovValid = true;
  }
  refreshPartition(col);
  refreshVanDeemter(col);
}

/**
 * Refresh DL and the dispersion number beta by apportionment (§7.2.3) — the ONLY dispersion
 * scheme. Two fixed-point passes, then the combined stability clamp `nu + 2*beta <= 0.98`.
 * @param {object} col Column.
 * @param {number} nu Courant number, dimensionless.
 * @param {number} dtSub_s substep, s.
 * @param {number} absU_i_cms |interstitial velocity|, cm/s.
 * @returns {void}
 */
function refreshDispersion(col, nu, dtSub_s, absU_i_cms) {
  const dispersionOn = col.enableExplicitDispersion || col.DL_override_cm2s != null;
  if (!dispersionOn) {
    col.DL_cm2s.fill(0);
    col.beta.fill(0);
    return;
  }
  const dz = col.dz_cm;
  const maxBeta = Math.max(0, (STABILITY_LIMIT - nu) / 2);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < col.nsCol; i++) {
      let DL;
      if (col.DL_override_cm2s != null) {
        DL = col.DL_override_cm2s;
      } else {
        const H_num = dz * (1 - nu / col.Rbar[i]);
        // DL = (u_i/2)*max(0, A + B/u_i - H_num), EXPANDED so it is not 0*Infinity at zero flow.
        DL = 0.5 * Math.max(
          0,
          absU_i_cms * col.A_vd_cm[i] + col.B_vd_cm2s[i] - absU_i_cms * H_num);
      }
      let beta = (dtSub_s > 0) ? DL * dtSub_s / (dz * dz) : 0;
      if (beta > maxBeta) {
        beta = maxBeta;
        DL = (dtSub_s > 0) ? beta * dz * dz / dtSub_s : 0;
      }
      col.DL_cm2s[i] = DL;
      col.beta[i] = beta;
    }
  }
}

/**
 * Refresh the HETP diagnostics on `col.diag` (§6.9.5).
 * @param {object} col Column.
 * @param {number} nu Courant number, dimensionless.
 * @param {number} absU_i_cms |interstitial velocity|, cm/s.
 * @returns {void}
 */
function refreshHetpDiag(col, nu, absU_i_cms) {
  const d = col.diag;
  const dz = col.dz_cm;
  const hasFlow = absU_i_cms > 1e-12;
  for (let i = 0; i < col.nsCol; i++) {
    // Numerical dispersion of the split upwind scheme (§7.2.2). NOTE, and do not "fix" it:
    // a LARGER dt (larger nu) makes H_num SMALLER, i.e. the answer more accurate and cheaper.
    const H_num = dz * (1 - nu / col.Rbar[i]);
    const H_kin = col.C_vd_s[i] * absU_i_cms;
    const H_disp = hasFlow ? 2 * col.DL_cm2s[i] / absU_i_cms : 0;
    const H_tgt = col.A_vd_cm[i] + (hasFlow ? col.B_vd_cm2s[i] / absU_i_cms : 0) + H_kin;
    const H_sim = Math.max(0, H_num) + H_kin + H_disp;
    d.hetpTarget_cm[i] = H_tgt;
    d.hetpNumerical_cm[i] = H_num;
    d.hetpKinetic_cm[i] = H_kin;
    d.hetpDispersive_cm[i] = H_disp;
    d.hetpSimulated_cm[i] = H_sim;
    d.hetpExcess_cm[i] = H_sim - H_tgt;
    d.sigmaInflation[i] = (H_tgt > 1e-30) ? Math.sqrt(Math.max(H_sim, 0) / H_tgt) : 1;
    d.plateNumberSim[i] = (H_sim > 1e-30) ? col.L_cm / H_sim : 0;
    d.kPrime[i] = col.phi * col.KtBar[i];
    d.KtBar[i] = col.KtBar[i];
  }
}

/* ------------------------------------------------------------------------------------------ *
 * S1 / S2 — convection (+ dispersion) and flux accounting
 * ------------------------------------------------------------------------------------------ */

/**
 * S1 + S2 for one substep (§6.9.3).
 *
 * THE UPSTREAM VALUE IS THE PRE-UPDATE ONE. Exactly three names are live in the sweep — `up`,
 * `old` and `far` — and every one is defined here:
 *   `up`   the PRE-update value of the UPSTREAM neighbour, carried in a scalar;
 *   `old`  the PRE-update value of THIS cell;
 *   `far`  the DOWNSTREAM neighbour, read directly from c[] because the sweep has not reached
 *          it yet in either direction, so it is still pre-update.
 * Reading the upstream cell in place instead gives c[19] = 0.905 after 3 steps of a 20-cell
 * nu = 0.95 column (true upwind gives 0) and a -38 % mass residual (§11 C-33).
 *
 * The dispersive flux is ZERO across BOTH end faces — that IS the Danckwerts boundary condition,
 * with no ghost cells — which is what the two `has*` guards express.
 *
 * S2 uses the PRE-convection outlet value, which is `old` on the final iteration. That choice is
 * what makes the telescoping sum exact: `sum_n dc_n * VcellMob = |dV|*(cIn - cOutOld)`.
 *
 * @param {object} col Column.
 * @param {number} nu Courant number |dV|/VcellMob, dimensionless.
 * @param {number} absdVSub_mL |substep volume|, mL.
 * @param {Float64Array} cIn_mM inlet composition, length nsCol, mM.
 * @param {boolean} forward true for n ascending (Q > 0), false for n descending.
 * @returns {void}
 */
function sweepConvection(col, nu, absdVSub_mL, cIn_mM, forward) {
  const { nz, nsCol, c, q, beta, tol_mM, lo, hi, cOutSub, massIn_umol, massOut_umol } = col;
  const last = forward ? nz - 1 : 0;
  for (let i = 0; i < nsCol; i++) {
    const base = i * nz;
    const b = beta[i];
    const ti = tol_mM[i];
    const cInI = cIn_mM[i];
    let up = cInI;                 // ghost: c[-1] = cIn forward, c[nz] = cIn reverse
    let outOld = 0;
    let loI = nz;
    let hiI = -1;

    if (forward) {
      for (let n = 0; n < nz; n++) {
        const k = base + n;
        const old = c[k];
        const hasUp = n > 0;
        const hasFar = n < nz - 1;
        const far = hasFar ? c[k + 1] : old;
        let v = old + nu * (up - old);
        if (b !== 0) {
          v += b * ((hasUp ? (up - old) : 0) + (hasFar ? (far - old) : 0));
        }
        c[k] = v;
        up = old;
        if (n === last) outOld = old;
        if (v > ti || q[k] > ti) { if (n < loI) loI = n; if (n > hiI) hiI = n; }
      }
    } else {
      for (let n = nz - 1; n >= 0; n--) {
        const k = base + n;
        const old = c[k];
        const hasUp = n < nz - 1;
        const hasFar = n > 0;
        const far = hasFar ? c[k - 1] : old;
        let v = old + nu * (up - old);
        if (b !== 0) {
          v += b * ((hasUp ? (up - old) : 0) + (hasFar ? (far - old) : 0));
        }
        c[k] = v;
        up = old;
        if (n === last) outOld = old;
        if (v > ti || q[k] > ti) { if (n < loI) loI = n; if (n > hiI) hiI = n; }
      }
    }

    // S2 — flux accounting, on the PRE-convection outlet value. mM * mL = umol (R-U4).
    massIn_umol[i] += absdVSub_mL * cInI;
    massOut_umol[i] += absdVSub_mL * outOld;
    cOutSub[i] = outOld;
    lo[i] = loI;
    hi[i] = hiI;
  }
}

/**
 * Recompute the per-species occupancy window without moving anything. Used on the zero-flow path,
 * where S1 and S2 are skipped entirely (§6.9.3).
 * @param {object} col Column.
 * @returns {void}
 */
function scanWindow(col) {
  const { nz, nsCol, c, q, tol_mM, lo, hi } = col;
  for (let i = 0; i < nsCol; i++) {
    const base = i * nz;
    const ti = tol_mM[i];
    let loI = nz;
    let hiI = -1;
    for (let n = 0; n < nz; n++) {
      const k = base + n;
      if (c[k] > ti || q[k] > ti) { if (n < loI) loI = n; if (n > hiI) hiI = n; }
    }
    lo[i] = loI;
    hi[i] = hiI;
  }
}

/* ------------------------------------------------------------------------------------------ *
 * S3 / S4 — local equilibrium, LDF, clamps
 * ------------------------------------------------------------------------------------------ */

/**
 * S3 + S4 for one substep over the active window (§6.9.3).
 *
 * `relaxCell` conserves `c + phi*q` exactly, per cell. The clamps in S4 are the UNSAFE ones and
 * are logged in umol on `col.massClamped_umol` so `massBalance` can report them (R-U4).
 *
 * @param {object} col Column.
 * @param {number} dtSub_s substep, s.
 * @param {number} n0 first cell index of the active window, inclusive.
 * @param {number} n1 last cell index of the active window, inclusive.
 * @returns {void}
 */
function relaxWindow(col, dtSub_s, n0, n1) {
  const {
    nz, nsCol, c, q, cCell, qCell, qStar, kOvCell, iso, phi,
    VcellMob_mL, VcellBead_mL, massClamped_umol,
  } = col;
  const m = col.modulatorColIdx;
  let clamps = 0;

  for (let n = n0; n <= n1; n++) {
    for (let i = 0; i < nsCol; i++) {
      const k = i * nz + n;
      cCell[i] = c[k];
      qCell[i] = q[k];
    }
    // cs is the modulator's INTERSTITIAL concentration in THIS cell, on the COLUMN index.
    // No cRef: the Donnan group sums are formed inside computeQStar from cCell (§7.2.4).
    const cs_mM = (m >= 0 && m < nsCol) ? cCell[m] : 0;
    relaxCell(iso, cCell, qCell, cs_mM, kOvCell, dtSub_s, phi,
      VcellMob_mL, qStar, massClamped_umol);

    for (let i = 0; i < nsCol; i++) {
      let ci = cCell[i];
      let qi = qCell[i];
      if (ci < 0) { massClamped_umol[i] += -ci * VcellMob_mL; ci = 0; clamps++; }
      if (qi < 0) { massClamped_umol[i] += -qi * VcellBead_mL; qi = 0; clamps++; }
      const k = i * nz + n;
      c[k] = ci;
      q[k] = qi;
    }
  }
  if (clamps !== 0) col.diag.clampCount += clamps;
}

/* ------------------------------------------------------------------------------------------ *
 * stepColumn
 * ------------------------------------------------------------------------------------------ */

/**
 * Advance the column by up to `dt_s`, transporting `dV_mL` of liquid at composition `cIn_mM`.
 *
 * SUBSTEP CAP (§3.5). When the Courant limit needs more than `nSubMax` substeps the column
 * advances LESS — `nSubMax * dtMax` — and reports the shortfall in `dtAdvanced_s`. It NEVER
 * inflates dt: raising the per-substep dt past the Courant limit is unconditionally unstable.
 * The caller (`physics/bed.js`) carries the un-advanced dt, dV and SOLUTE forward.
 *
 * COURANT (§3.5, §7.2.1). The transported velocity is `Q_eff = dV_mL/dt_s`, always. `flow_mLs`
 * is used ONLY for the film coefficient k_f — during a pump ramp or a partial-batch flush the
 * two differ, and building `nu` from `flow_mLs` lets `nu` exceed 1.0.
 *
 * @param {object} col Column.
 * @param {number} dt_s requested interval, s. Must be > 0.
 * @param {number} flow_mLs volumetric flow for k_f only, mL/s (signed; only |.| is used).
 * @param {Float64Array} cIn_mM inlet composition, length nsCol, mM.
 * @param {number|undefined} dV_mL transported volume over dt_s, mL, SIGNED
 *        (+ down-flow, - up-flow). Omitted => `flow_mLs * dt_s`.
 * @returns {{cOut:Float64Array, dtAdvanced_s:number, nSub:number, speedDeficit:number,
 *            courant:number, status:number}} the col-owned StepResult SINGLETON. cOut is
 *        length nsCol in mM, flux-averaged over the advanced interval. status 0 ok,
 *        1 speed-limited, 2 faulted. Never destructure and retain it.
 */
export function stepColumn(col, dt_s, flow_mLs, cIn_mM, dV_mL) {
  const r = col.result;
  r.status = 0;
  r.nSub = 0;
  r.speedDeficit = 1;
  r.courant = 0;

  if (col.faulted) {
    r.dtAdvanced_s = 0;
    r.status = 2;
    return r;
  }
  if (!(dt_s > 0)) {
    r.dtAdvanced_s = 0;
    return r;
  }

  const dVReq_mL = (dV_mL === undefined || dV_mL === null || !Number.isFinite(dV_mL))
    ? flow_mLs * dt_s
    : dV_mL;
  const Qeff_mLs = dVReq_mL / dt_s;
  const u_s_cms = Qeff_mLs / col.A_cm2;              // superficial, signed
  const absU_i_cms = Math.abs(u_s_cms) / col.epsC;   // interstitial magnitude

  // S0 — coefficients. Once per CALL, never per substep. k_f (and therefore k_ov) is built from
  // flow_mLs, per §3.5; everything transport-related below is built from Q_eff.
  setFlowDependentCoefficients(
    col, Math.abs(flow_mLs) / col.A_cm2, col.T_C, col.mu_cP, col.rho_gmL);

  const dtMax_s = (absU_i_cms > 1e-12)
    ? Math.min(col.nuTarget * col.dz_cm / absU_i_cms, col.dtCap_s)
    : col.dtCap_s;
  const nSubIdeal = Math.max(1, Math.ceil(dt_s / dtMax_s));

  let nSub;
  let dtAdvanced_s;
  let dVAdvanced_mL;
  let speedDeficit;
  if (nSubIdeal > col.nSubMax) {
    nSub = col.nSubMax;
    speedDeficit = nSubIdeal / col.nSubMax;
    dtAdvanced_s = col.nSubMax * dtMax_s;            // ADVANCE LESS. Never raise dt.
    dVAdvanced_mL = dVReq_mL * (dtAdvanced_s / dt_s);
    r.status = 1;
  } else {
    nSub = nSubIdeal;
    speedDeficit = 1.0;
    dtAdvanced_s = dt_s;
    dVAdvanced_mL = dVReq_mL;
  }

  const dtSub_s = dtAdvanced_s / nSub;
  const dVSub_mL = dVAdvanced_mL / nSub;
  const absdVSub_mL = Math.abs(dVSub_mL);
  // The flow direction is constant within a call by construction: there is exactly one dV.
  const forward = dVSub_mL >= 0;
  const zeroFlow = !(absdVSub_mL > 0);
  // nu = |dV|/VcellMob is algebraically |u_i|*dt/dz and is the form that makes the S1
  // telescoping sum exact against S2's |dV|*c accounting.
  const nu = zeroFlow ? 0 : absdVSub_mL / col.VcellMob_mL;

  refreshDispersion(col, nu, dtSub_s, absU_i_cms);
  refreshHetpDiag(col, nu, absU_i_cms);

  // Active window (§6.9.4): widen to the whole column whenever the inlet is non-flat.
  let inletChanged = false;
  for (let i = 0; i < col.nsCol; i++) {
    if (Math.abs(cIn_mM[i] - col.cInHold[i]) > col.tol_mM[i]) { inletChanged = true; break; }
  }
  const margin = (nu >= 0.999) ? col.nz : Math.max(4, Math.ceil(2 / (1 - nu)));
  const outletCell = forward ? col.nz - 1 : 0;

  col.cOutAcc.fill(0);
  let outWeight_mL = 0;
  let activeCells = 0;

  for (let s = 0; s < nSub; s++) {
    if (zeroFlow) {
      scanWindow(col);
      for (let i = 0; i < col.nsCol; i++) col.cOutSub[i] = col.c[i * col.nz + outletCell];
    } else {
      sweepConvection(col, nu, absdVSub_mL, cIn_mM, forward);
      for (let i = 0; i < col.nsCol; i++) col.cOutAcc[i] += absdVSub_mL * col.cOutSub[i];
      outWeight_mL += absdVSub_mL;
    }

    col.diag.fullPassCounter++;
    const forceFull = inletChanged || col.diag.fullPassCounter >= FULL_PASS_EVERY;
    let n0 = 0;
    let n1 = col.nz - 1;
    if (forceFull) {
      col.diag.fullPassCounter = 0;
    } else {
      let loMin = col.nz;
      let hiMax = -1;
      for (let i = 0; i < col.nsCol; i++) {
        if (col.hi[i] < 0) continue;
        if (col.lo[i] < loMin) loMin = col.lo[i];
        if (col.hi[i] > hiMax) hiMax = col.hi[i];
      }
      if (hiMax < 0) {
        // Nothing above tolerance anywhere: relax only the entry region, where the inlet
        // stream is delivered.
        n0 = forward ? 0 : Math.max(0, col.nz - 1 - margin);
        n1 = forward ? Math.min(col.nz - 1, margin) : col.nz - 1;
      } else {
        n0 = Math.max(0, loMin - margin);
        n1 = Math.min(col.nz - 1, hiMax + margin);
      }
    }
    activeCells = n1 - n0 + 1;
    relaxWindow(col, dtSub_s, n0, n1);

    col.substepCounter++;
    if ((col.substepCounter % NAN_TRIPWIRE_EVERY) === 0) {
      const a = col.c[0];
      const b = col.c[col.nsCol * col.nz - 1];
      if (Number.isNaN(a) || Number.isNaN(b)) {
        col.faulted = true;
        r.status = 2;
        break;
      }
    }
  }

  // Flux-averaged outlet over the advanced interval.
  if (outWeight_mL > 0) {
    const inv = 1 / outWeight_mL;
    for (let i = 0; i < col.nsCol; i++) col.cOut[i] = col.cOutAcc[i] * inv;
  } else {
    for (let i = 0; i < col.nsCol; i++) col.cOut[i] = col.c[i * col.nz + outletCell];
  }

  col.cInHold.set(cIn_mM);

  const isod = col.iso.diag;
  if (isod) {
    col.diag.isoIterAvg = (isod.iterCalls > 0) ? isod.iterSum / isod.iterCalls : 0;
    col.diag.smaFrozen = isod.smaFrozen;
    col.diag.smaNonConverged = isod.smaNonConverged;
  }
  col.diag.activeCells = activeCells;

  r.dtAdvanced_s = dtAdvanced_s;
  r.nSub = nSub;
  r.speedDeficit = speedDeficit;
  r.courant = nu;
  return r;
}

/* ------------------------------------------------------------------------------------------ *
 * Mass accounting and reporting
 * ------------------------------------------------------------------------------------------ */

/**
 * Total amount of every species currently held in the column, mobile phase plus particle phase.
 * @param {object} col Column.
 * @param {Float64Array} out length nsCol; overwritten.
 * @returns {Float64Array} `out`, in umol (`Vcell_mL * SUM_n(epsC*c + (1-epsC)*q)`).
 */
export function totalMass_umol(col, out) {
  const { nz, nsCol, c, q, epsC, Vcell_mL } = col;
  const wq = 1 - epsC;
  for (let i = 0; i < nsCol; i++) {
    const base = i * nz;
    let sc = 0;
    let sq = 0;
    for (let n = 0; n < nz; n++) { sc += c[base + n]; sq += q[base + n]; }
    out[i] = Vcell_mL * (epsC * sc + wq * sq);
  }
  return out;
}

/**
 * The column's own mass closure, per species, relative and dimensionless.
 *
 * `residual = (mass0 + massIn - massOut + massClamped - current) / scale`, where `massClamped` is
 * ADDED because the clamp of a negative concentration injects `-c*V` umol into the column. On a
 * healthy run `massClamped` is identically zero and the residual is pure round-off; the contract
 * requires < 1e-11 over 200 000 substeps (§10).
 *
 * @param {object} col Column.
 * @param {Float64Array} out length nsCol; overwritten.
 * @returns {Float64Array} `out`, dimensionless relative residual per species.
 */
export function massBalanceResidual(col, out) {
  totalMass_umol(col, col.cOutAcc);   // cOutAcc is free here: stepColumn refills it on entry
  for (let i = 0; i < col.nsCol; i++) {
    const now_umol = col.cOutAcc[i];
    const expected_umol = col.mass0_umol[i] + col.massIn_umol[i]
      - col.massOut_umol[i] + col.massClamped_umol[i];
    const scale = Math.max(
      Math.abs(col.massIn_umol[i]), Math.abs(col.mass0_umol[i]), Math.abs(now_umol), 1e-12);
    out[i] = (expected_umol - now_umol) / scale;
  }
  return out;
}

/**
 * Decimate one species' axial profile onto a caller-owned array, by box average.
 * @param {object} col Column.
 * @param {number} speciesColIdx COLUMN index.
 * @param {'c'|'q'} which 'c' = interstitial concentration (mM), 'q' = particle content
 *        (mM per bead volume).
 * @param {Float32Array} out any length >= 1; overwritten.
 * @returns {Float32Array} `out`, in mM, index 0 = the inlet end of the bed.
 */
export function axialProfile(col, speciesColIdx, which, out) {
  const m = out.length;
  if (speciesColIdx < 0 || speciesColIdx >= col.nsCol) { out.fill(0); return out; }
  const src = (which === 'q') ? col.q : col.c;
  const nz = col.nz;
  const base = speciesColIdx * nz;
  for (let k = 0; k < m; k++) {
    const n0 = Math.floor(k * nz / m);
    const n1 = Math.max(n0 + 1, Math.floor((k + 1) * nz / m));
    let s = 0;
    for (let n = n0; n < n1; n++) s += src[base + n];
    out[k] = s / (n1 - n0);
  }
  return out;
}

/**
 * Static geometric description of the column.
 * @param {object} col Column.
 * @returns {{V_mL:number, V0_mL:number, Vpore_mL:number, Vt_mL:number, Vbead_mL:number,
 *            Vskel_mL:number, epsC:number, epsP:number, epsT:number, phi:number, F:number,
 *            tResCV_s:number, tResLiquid_s:number, t0_s:number, dz_cm:number, nz:number}}
 *   Volumes mL, porosities and phase ratios dimensionless, times s, dz cm. `phi` is the
 *   interstitial phase ratio `(1-epsC)/epsC` used by every transport identity; `F` is the
 *   TOTAL-porosity phase ratio `(1-epsT)/epsT`, reported for display only. The three times are
 *   built from the cached superficial velocity and are Infinity at zero flow: `tResCV_s` is the
 *   time to pump one CV, `tResLiquid_s` the mean residence time of a fully permeating unretained
 *   tracer, `t0_s` the interstitial (void) transit time.
 */
export function describeColumn(col) {
  const { epsC, epsP, epsT, V_mL, L_cm } = col;
  const u = col.uSuperficial_cms;
  const hasFlow = u > 1e-12;
  return {
    V_mL,
    V0_mL: epsC * V_mL,
    Vpore_mL: (1 - epsC) * epsP * V_mL,
    Vt_mL: epsT * V_mL,
    Vbead_mL: (1 - epsC) * V_mL,
    Vskel_mL: (1 - epsC) * (1 - epsP) * V_mL,
    epsC,
    epsP,
    epsT,
    phi: col.phi,
    F: (1 - epsT) / epsT,
    tResCV_s: hasFlow ? L_cm / u : Infinity,
    tResLiquid_s: hasFlow ? epsT * L_cm / u : Infinity,
    t0_s: hasFlow ? epsC * L_cm / u : Infinity,
    dz_cm: col.dz_cm,
    nz: col.nz,
  };
}

/**
 * Per-species transport summary at a stated operating point. Operator rate — it allocates, and it
 * FORCES a coefficient refresh at the queried condition (there is no other way to answer the
 * question); `stepColumn` refreshes again on its next call, so nothing is left stale.
 * @param {object} col Column.
 * @param {number} u_cms SUPERFICIAL velocity, cm/s.
 * @param {number} T_C temperature, degC.
 * @param {number} mu_cP viscosity, cP.
 * @param {number} rho_gmL density, g/mL.
 * @returns {Array<{id:string, Dm_cm2s:number, Dp_cm2s:number, kf_cms:number, kOv_s1:number,
 *   epsPi:number, Kt:number, kPrime:number, R:number, A_cm:number, B_cm2s:number, C_s:number,
 *   HETP_cm:number, N:number, VR_mL:number, VR_CV:number}>} one entry per COLUMN index.
 *   Diffusivities cm2/s, kf cm/s, kOv 1/s, A cm, B cm2/s, C s, HETP cm, VR mL and CV.
 */
export function describeSpecies(col, u_cms, T_C, mu_cP, rho_gmL) {
  col.kovValid = false;
  setFlowDependentCoefficients(col, u_cms, T_C, mu_cP, rho_gmL);
  const u_i = Math.abs(u_cms) / col.epsC;
  const hasFlow = u_i > 1e-12;
  const out = [];
  for (let i = 0; i < col.nsCol; i++) {
    const cm = col.comps[i];
    const br = kovBreakdown(col.cfg, cm, Math.abs(u_cms), T_C, mu_cP, rho_gmL);
    const Kt = col.KtBar[i];
    const kPrime = col.phi * Kt;
    const A_cm = col.A_vd_cm[i];
    const B_cm2s = col.B_vd_cm2s[i];
    const C_s = col.C_vd_s[i];
    const HETP_cm = A_cm + (hasFlow ? B_cm2s / u_i : 0) + C_s * u_i;
    const VR_mL = col.V_mL * (col.epsC + (1 - col.epsC) * Kt);
    out.push({
      id: cm.id,
      Dm_cm2s: br.Dm_cm2s,
      Dp_cm2s: br.Dpore_cm2s,
      kf_cms: br.kf_cms,
      kOv_s1: br.kOv_s1,
      epsPi: cm.epsPi,
      Kt,
      kPrime,
      R: 1 + kPrime,
      A_cm,
      B_cm2s,
      C_s,
      HETP_cm,
      N: (HETP_cm > 1e-30) ? col.L_cm / HETP_cm : 0,
      VR_mL,
      VR_CV: VR_mL / col.V_mL,
    });
  }
  return out;
}

/**
 * Back out the packing quality factor `lambdaPack` from a measured plate height.
 *
 * PURE — it does NOT mutate `col`. Config is immutable (§2.4); the caller applies the result
 * through `sim.rebuild(ctx, { column: { lambdaPack } })`.
 *
 * @param {object} col Column.
 * @param {number} speciesColIdx COLUMN index of the marker.
 * @param {number} HETP_meas_cm measured plate height, cm.
 * @param {number} u_cms SUPERFICIAL velocity of the measurement, cm/s.
 * @param {'column-intrinsic'|'system-measured'} source 'system-measured' strips the
 *        extra-column variance first (§7.6); 'column-intrinsic' takes HETP_meas_cm as given.
 * @param {number} sigmaExtra_mL extra-column standard deviation, mL. Ignored when
 *        source === 'column-intrinsic'.
 * @returns {{lambdaPack:number, warn:string|null}} `lambdaPack` dimensionless, >= 0.
 */
export function calibrateHETP(col, speciesColIdx, HETP_meas_cm, u_cms, source, sigmaExtra_mL) {
  let warn = null;
  if (speciesColIdx < 0 || speciesColIdx >= col.nsCol) {
    return { lambdaPack: col.lambdaPack, warn: 'unknown speciesColIdx; lambdaPack unchanged' };
  }
  if (!(HETP_meas_cm > 0)) {
    return { lambdaPack: col.lambdaPack, warn: 'HETP_meas_cm must be > 0; lambdaPack unchanged' };
  }

  const Kt = col.KtBar[speciesColIdx];
  const VR_mL = col.V_mL * (col.epsC + (1 - col.epsC) * Kt);
  let H_col_cm = HETP_meas_cm;

  if (source === 'system-measured') {
    const N_app = col.L_cm / HETP_meas_cm;
    const sigmaMeas_mL = VR_mL / Math.sqrt(Math.max(N_app, 1e-30));
    const varCol_mL2 = sigmaMeas_mL * sigmaMeas_mL - sigmaExtra_mL * sigmaExtra_mL;
    if (!(varCol_mL2 > 0)) {
      return {
        lambdaPack: col.lambdaPack,
        warn: 'extra-column variance exceeds the measurement; result INDETERMINATE, ' +
          'lambdaPack unchanged',
      };
    }
    const N_corr = (VR_mL * VR_mL) / varCol_mL2;
    H_col_cm = col.L_cm / N_corr;
  }

  const u_i_cms = Math.abs(u_cms) / col.epsC;
  const B_term = (u_i_cms > 1e-12) ? col.B_vd_cm2s[speciesColIdx] / u_i_cms : 0;
  const C_term = col.C_vd_s[speciesColIdx] * u_i_cms;
  let lambdaPack = (H_col_cm - B_term - C_term) / (2 * col.cfg.dp_cm);
  if (!(lambdaPack > 0)) {
    lambdaPack = 0;
    warn = 'measured HETP is below the B/u + C*u floor at this velocity; lambdaPack clamped to 0';
  }
  return { lambdaPack, warn };
}

/* ------------------------------------------------------------------------------------------ *
 * Serialisation and benchmark
 * ------------------------------------------------------------------------------------------ */

/**
 * Structured-clone-safe snapshot of a Column. Operator rate; allocates.
 * @param {object} col Column.
 * @returns {object} plain object; typed arrays become plain Arrays.
 */
export function serializeColumn(col) {
  return {
    schemaVersion: '2.0',
    cfg: {
      ...col.cfg,
      comps: col.comps.map((cm) => ({ ...cm })),
      chem: { ...col.cfg.chem },
    },
    nz: col.nz,
    nsCol: col.nsCol,
    lambdaPack: col.lambdaPack,
    c: Array.from(col.c),
    q: Array.from(col.q),
    massIn_umol: Array.from(col.massIn_umol),
    massOut_umol: Array.from(col.massOut_umol),
    massClamped_umol: Array.from(col.massClamped_umol),
    mass0_umol: Array.from(col.mass0_umol),
    cInHold: Array.from(col.cInHold),
    cOut: Array.from(col.cOut),
    faulted: col.faulted,
    substepCounter: col.substepCounter,
    T_C: col.T_C,
    mu_cP: col.mu_cP,
    rho_gmL: col.rho_gmL,
    uSuperficial_cms: col.uSuperficial_cms,
    diag: {
      clampCount: col.diag.clampCount,
      isoIterAvg: col.diag.isoIterAvg,
      activeCells: col.diag.activeCells,
      fullPassCounter: col.diag.fullPassCounter,
      smaFrozen: col.diag.smaFrozen,
      smaNonConverged: col.diag.smaNonConverged,
    },
  };
}

/**
 * Rebuild a Column from `serializeColumn` output.
 * @param {object} obj the serialised object.
 * @returns {object} a fresh Column with the stored state restored.
 */
export function deserializeColumn(obj) {
  const col = createColumn(obj.cfg);
  col.c.set(obj.c);
  col.q.set(obj.q);
  col.massIn_umol.set(obj.massIn_umol);
  col.massOut_umol.set(obj.massOut_umol);
  col.massClamped_umol.set(obj.massClamped_umol);
  col.mass0_umol.set(obj.mass0_umol);
  col.cInHold.set(obj.cInHold);
  col.cOut.set(obj.cOut);
  col.faulted = !!obj.faulted;
  col.substepCounter = obj.substepCounter | 0;
  col.T_C = obj.T_C;
  col.mu_cP = obj.mu_cP;
  col.rho_gmL = obj.rho_gmL;
  col.uSuperficial_cms = obj.uSuperficial_cms;
  if (obj.lambdaPack != null) col.lambdaPack = obj.lambdaPack;
  if (obj.diag) {
    col.diag.clampCount = obj.diag.clampCount;
    col.diag.isoIterAvg = obj.diag.isoIterAvg;
    col.diag.activeCells = obj.diag.activeCells;
    col.diag.fullPassCounter = obj.diag.fullPassCounter;
    col.diag.smaFrozen = obj.diag.smaFrozen;
    col.diag.smaNonConverged = obj.diag.smaNonConverged;
  }
  col.kovValid = false;
  return col;
}

/**
 * Time a throwaway column so `ui/app.js` can pick `nz` at startup (§2.4 boot step 3, D5).
 *
 * `colCfg` is a FULL createColumn cfg — call it as
 * `benchmarkColumn(bed.buildColumnCfg(config), { simSeconds, flow_mLs })`, never with
 * `config.column` alone. Two passes are run: an uninstrumented one for the headline timings, and
 * an instrumented one for the convection/equilibrium split (a clock read per stage would inflate
 * the headline).
 *
 * @param {object} colCfg full createColumn cfg.
 * @param {{simSeconds:number, flow_mLs:number, now?:function():number}} opts
 *        `simSeconds` simulated seconds to cover, `flow_mLs` mL/s, `now` an optional injected
 *        millisecond clock (defaults to the guarded host clock).
 * @returns {{msPerSimSecond:number, msPerStep:number, stepsPerSimSecond:number, nz:number,
 *   nsCol:number, fracConvection:number, fracEquilibrium:number, isoIterAvg:number,
 *   activeCellFraction:number}} times in ms, fractions dimensionless 0..1.
 */
export function benchmarkColumn(colCfg, opts) {
  const o = opts || {};
  const simSeconds = (o.simSeconds > 0) ? o.simSeconds : 10;
  const flow_mLs = Number.isFinite(o.flow_mLs) ? o.flow_mLs : 1;
  const now = (typeof o.now === 'function') ? o.now : defaultClock_ms;

  const col = createColumn(colCfg);
  const nsCol = col.nsCol;
  const cIn = new Float64Array(nsCol);
  for (let i = 0; i < nsCol; i++) {
    const s = col.comps[i].concScale_mM;
    cIn[i] = (s > 0 ? s : 1e-3) * 20;   // a realistic non-flat inlet, so the window stays open
  }

  const absQ = Math.max(Math.abs(flow_mLs), 1e-9);
  const dtStep_s = clamp(col.nuTarget * col.VcellMob_mL / absQ, 0.05, col.dtCap_s);
  const nSteps = Math.max(1, Math.ceil(simSeconds / dtStep_s));
  const dVStep_mL = flow_mLs * dtStep_s;

  const t0 = now();
  for (let s = 0; s < nSteps; s++) stepColumn(col, dtStep_s, flow_mLs, cIn, dVStep_mL);
  const t1 = now();
  const totalMs = t1 - t0;
  const simCovered_s = nSteps * dtStep_s;

  // Second, instrumented pass for the split. Times the two dominant stages by re-running the
  // same work with a clock read around each phase of one representative step.
  const col2 = createColumn(colCfg);
  setFlowDependentCoefficients(col2, absQ / col2.A_cm2, col2.T_C, col2.mu_cP, col2.rho_gmL);
  let msConv = 0;
  let msEq = 0;
  const probeSteps = Math.max(1, Math.min(nSteps, 64));
  for (let s = 0; s < probeSteps; s++) {
    const a = now();
    sweepConvection(col2, clamp(Math.abs(dVStep_mL) / col2.VcellMob_mL, 0, 0.999),
      Math.abs(dVStep_mL), cIn, dVStep_mL >= 0);
    const b = now();
    relaxWindow(col2, dtStep_s, 0, col2.nz - 1);
    const c2 = now();
    msConv += (b - a);
    msEq += (c2 - b);
  }
  const msSplit = msConv + msEq;

  return {
    msPerSimSecond: (simCovered_s > 0) ? totalMs / simCovered_s : 0,
    msPerStep: totalMs / nSteps,
    stepsPerSimSecond: 1 / dtStep_s,
    nz: col.nz,
    nsCol,
    fracConvection: (msSplit > 0) ? msConv / msSplit : 0,
    fracEquilibrium: (msSplit > 0) ? msEq / msSplit : 0,
    isoIterAvg: col.diag.isoIterAvg,
    activeCellFraction: col.diag.activeCells / col.nz,
  };
}
