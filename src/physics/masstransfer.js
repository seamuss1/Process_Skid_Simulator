/**
 * src/physics/masstransfer.js — free-solution diffusivity, hindered pore diffusion, the film
 * coefficient, and the isotherm-independent overall (liquid-side) mass-transfer coefficient
 * `k_ov`.
 *
 * Contract: architecture-v2 §6.8 (module), §7.3 (every correlation, PRE-CONVERTED to canonical
 * units), §7.3.4 (the shipped six-species table), §1.2 (BASIS N1), §5.8.2 (ColumnSpeciesConfig).
 *
 * UNITS (§1.1, absolute — every argument and every return value is canonical):
 *   length ......... cm      (`dp_cm`, `rp_cm`, `rPore_cm`, `rs_cm`)
 *   velocity ....... cm/s    (`u_cms`, superficial)
 *   diffusivity .... cm^2/s  (`Dm_cm2s`, `Dpore_cm2s`)
 *   viscosity ...... cP      (= mPa*s)
 *   density ........ g/mL
 *   temperature .... degC
 *   rate ........... 1/s     (`kOv_s1`)
 *   Re, Sc, Sh, lambda, psi, tortuosity, filmFraction: dimensionless
 *
 * R-U2: local SI conversion is permitted INSIDE a function body where a published correlation
 * demands it, and never across a boundary. §7.3 has already pre-converted every correlation, so
 * the only SI excursion left in this file is the Stokes-Einstein radius, which is written out
 * explicitly below.
 *
 * `k_ov` depends only on resin geometry, velocity, temperature and molecular size — NOT on salt,
 * loading or the isotherm. That is why it is computed once per (component, flow, temperature)
 * and only the cheap divide by `Kt` happens in the inner loop (`physics/isotherm.js`).
 *
 * No DOM. Imports only `core/util.js` (layer L1, §4).
 */

import { KB_J_K, clamp } from '../core/util.js';

const PI = Math.PI;

// Re below this loses all significance in Re^(1/3); the film term is ~1-24 % of the total
// resistance anyway, so the clamp is invisible in the answer (§7.3.2).
const RE_MIN = 1e-4;

// Acceptance band for the result (§7.3.4). AGG ships at 0.00782 and NaCl on 45 um beads at
// 8.408, so the band has to be this wide — [0.01, 5] would fire on shipped defaults (C-45).
const KOV_MIN_s1 = 1e-6;
const KOV_MAX_s1 = 1e4;

// Below this the bulk is stagnant. A real skid still equilibrates the film by molecular
// diffusion over seconds during a hold, so tau_film := 0 and pore diffusion governs. Failing to
// special-case this makes k_eff = 0 and the column visibly freezes during holds (§6.8).
const U_STAGNANT_cms = 1e-7;

// Dev-build sanity bands for the two conversions people get wrong (§7.3.1). A missed factor of
// 100 in either is silent and yields a plausible-looking k_ov, so `kovBreakdown` reports Re and
// Sc and tests/masstransfer.test.js asserts them against these bounds.
// Re in [1e-5, 1e2], Sc in [1e2, 1e5].

/**
 * Free-solution diffusivity from the Polson correlation, temperature- and viscosity-corrected.
 *
 *   D20w = 2.74e-5 * MW^(-1/3)                       [cm^2/s]
 *   Dm   = D20w * (T_C + 273.15)/293.15 * 1.002/mu_cP
 *
 * Accuracy: +/-15 % for compact globular proteins, about -25 % for elongated ones (IgG comes out
 * ~25 % high). This is the FALLBACK: every shipped species carries an explicit `Dm_cm2s`.
 *
 * @param {number} MW_gmol molar mass, g/mol
 * @param {number} T_C     temperature, degC
 * @param {number} mu_cP   dynamic viscosity, cP
 * @returns {number} Dm in cm^2/s; 0 when the inputs are not physical (MW <= 0 or mu <= 0), which
 *   the k_ov chain turns into a fully immobile component rather than a NaN.
 */
export function diffusivityPolson_cm2s(MW_gmol, T_C, mu_cP) {
  if (!(MW_gmol > 0) || !(mu_cP > 0)) return 0;
  const D20w = 2.74e-5 * Math.pow(MW_gmol, -1 / 3);
  return D20w * ((T_C + 273.15) / 293.15) * (1.002 / mu_cP);
}

/**
 * Stokes-Einstein hydrodynamic radius.
 *
 *   rs = kB*T / (6*pi*mu*D)      in SI, then *100 to reach cm
 *
 * This is the one local SI excursion in the file (R-U2): `mu_cP*1e-3` is Pa*s and
 * `D_cm2s*1e-4` is m^2/s. Anchor (§7.3.3): D = 1.211e-6 cm^2/s at 25 degC, mu = 0.945 cP gives
 * rs = 1.9083e-7 cm = 1.908 nm.
 *
 * @param {number} D_cm2s free-solution diffusivity, cm^2/s
 * @param {number} T_C    temperature, degC
 * @param {number} mu_cP  dynamic viscosity, cP
 * @returns {number} Stokes radius in cm; Infinity when D <= 0 (the molecule cannot move), which
 *   the hindrance chain correctly turns into "fully excluded".
 */
export function stokesRadius_cm(D_cm2s, T_C, mu_cP) {
  if (!(mu_cP > 0)) return Infinity;
  if (!(D_cm2s > 0)) return Infinity;
  const mu_Pas = mu_cP * 1e-3;
  const D_m2s = D_cm2s * 1e-4;
  return (KB_J_K * (T_C + 273.15) / (6 * PI * mu_Pas * D_m2s)) * 100;
}

/**
 * Hindered-diffusion factor psi for a sphere in a cylindrical pore.
 *
 *   lambda = rs / rPore
 *   Phi    = (1 - lambda)^2                                   (equilibrium partition)
 *   Kd_hyd = 1 - 2.104*lambda + 2.089*lambda^3 - 0.948*lambda^5   (Renkin drag, clamped >= 0)
 *   psi    = Phi * Kd_hyd
 *
 * @param {number} rs_cm    solute Stokes radius, cm
 * @param {number} rPore_cm pore radius, cm
 * @returns {number} psi, dimensionless, in [0, 1]. Exactly 0 when lambda >= 1 (the molecule is
 *   excluded), when either radius is not physical, or when either is NaN.
 */
export function hindrance(rs_cm, rPore_cm) {
  if (!(rPore_cm > 0)) return 0;
  const lambda = rs_cm / rPore_cm;
  if (!(lambda < 1)) return 0;              // catches lambda >= 1 and NaN
  const l = lambda > 0 ? lambda : 0;        // clamp lambda to [0, 1)
  const l3 = l * l * l;
  const Phi = (1 - l) * (1 - l);
  let Kd = 1 - 2.104 * l + 2.089 * l3 - 0.948 * l3 * l * l;
  if (!(Kd > 0)) Kd = 0;
  return Phi * Kd;
}

/**
 * Mackie-Meares tortuosity, `((2 - eps)/eps)^2`.
 *
 * The single largest uncertainty in `k_ov` (about +/-30 % against measurement). Note the
 * porosity passed here is the SPECIES' accessible pore porosity `epsPi`, not the resin nominal
 * `epsP` — see `computeKov_s1`.
 *
 * @param {number} epsP porosity, dimensionless (0, 1)
 * @returns {number} tortuosity, dimensionless (1.8304 at epsP = 0.85); Infinity at epsP <= 0.
 */
export function tortuosityMM(epsP) {
  if (!(epsP > 0)) return Infinity;
  const r = (2 - epsP) / epsP;
  return r * r;
}

/** Numeric kernel for the pore diffusivity — no object argument, so the hot path allocates 0. */
function poreDiffKernel(Dm_cm2s, rs_cm, rPore_cm, epsPi) {
  const psi = hindrance(rs_cm, rPore_cm);
  if (!(psi > 0)) return 0;
  const tau = tortuosityMM(epsPi);
  if (!(tau > 0) || !Number.isFinite(tau)) return 0;
  return Dm_cm2s * psi / tau;
}

/**
 * Effective intraparticle pore diffusivity, `Dpore = Dm * psi / tau_MM`.
 *
 * Sanity band on `Dpore/Dm` is [0.05, 0.65] across the shipped species (§7.3.4).
 *
 * @param {object} args
 *   @param {number} args.Dm_cm2s   free-solution diffusivity, cm^2/s
 *   @param {number} args.rs_cm     solute Stokes radius, cm
 *   @param {number} args.rPore_cm  pore radius, cm
 *   @param {number} args.epsPi     SPECIES accessible pore porosity, dimensionless
 * @returns {number} Dpore in cm^2/s; 0 for an excluded molecule.
 */
export function porediff_cm2s(args) {
  return poreDiffKernel(args.Dm_cm2s, args.rs_cm, args.rPore_cm, args.epsPi);
}

/** Numeric kernel for the film coefficient — no object argument (zero allocation). */
function filmKernel(u_cms, dp_cm, epsC, Dm_cm2s, mu_cP, rho_gmL) {
  if (!(dp_cm > 0) || !(epsC > 0) || !(Dm_cm2s > 0) || !(mu_cP > 0) || !(rho_gmL > 0)) return 0;
  // §7.3.1 — THE two conversions people get wrong. With u in cm/s, dp in cm, rho in g/mL,
  // mu in cP and D in cm^2/s the factors are exactly 100 and 0.01.
  let Re = 100 * rho_gmL * Math.abs(u_cms) * dp_cm / mu_cP;
  if (!(Re > RE_MIN)) Re = RE_MIN;
  const Sc = 0.01 * mu_cP / (rho_gmL * Dm_cm2s);
  const Sh = (1.09 / epsC) * Math.cbrt(Re * Sc);          // Wilson-Geankoplis
  return Sh * Dm_cm2s / dp_cm;
}

/**
 * Film mass-transfer coefficient from Wilson-Geankoplis.
 *
 *   Re = 100 * rho_gmL * |u_cms| * dp_cm / mu_cP          (Re clamped >= 1e-4)
 *   Sc = 0.01 * mu_cP / (rho_gmL * Dm_cm2s)
 *   Sh = (1.09/epsC) * (Re*Sc)^(1/3)
 *   kf = Sh * Dm / dp
 *
 * Valid for 0.0015 < Re < 55; Re > 55 is unreachable for preparative resin at <= 600 cm/h.
 *
 * @param {object} args
 *   @param {number} args.u_cms    SUPERFICIAL velocity, cm/s (sign ignored — reverse flow has
 *          the same film coefficient)
 *   @param {number} args.dp_cm    particle diameter, cm
 *   @param {number} args.epsC     interstitial porosity, dimensionless
 *   @param {number} args.Dm_cm2s  free-solution diffusivity, cm^2/s
 *   @param {number} args.mu_cP    dynamic viscosity, cP
 *   @param {number} args.rho_gmL  density, g/mL
 * @returns {number} kf in cm/s; 0 when any input is not physical.
 */
export function filmCoefficient_cms(args) {
  return filmKernel(args.u_cms, args.dp_cm, args.epsC, args.Dm_cm2s, args.mu_cP, args.rho_gmL);
}

/** `v` when it is a finite non-negative number, else `dflt`. keffScale 0 IS meaningful: frozen. */
function numOrDefault(v, dflt) {
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : dflt;
}

/** Particle radius, cm — `rp_cm` when the config carries it, else `dp_cm/2`. */
function particleRadius_cm(colCfg) {
  const rp = colCfg.rp_cm;
  if (typeof rp === 'number' && rp > 0) return rp;
  return (colCfg.dp_cm > 0) ? colCfg.dp_cm / 2 : 0;
}

/** Resolved free-solution diffusivity: an explicit `comp.Dm_cm2s` wins, else Polson. */
function resolveDm_cm2s(comp, T_C, mu_cP) {
  const d = comp.Dm_cm2s;
  if (typeof d === 'number' && d > 0) return d;
  return diffusivityPolson_cm2s(comp.MW_gmol, T_C, mu_cP);
}

/** Resolved pore diffusivity: an explicit `comp.Dp_cm2s` overrides the Renkin/Mackie-Meares result. */
function resolveDpore_cm2s(colCfg, comp, Dm_cm2s, rs_cm) {
  const d = comp.Dp_cm2s;
  if (typeof d === 'number' && d > 0) return d;
  return poreDiffKernel(Dm_cm2s, rs_cm, colCfg.rPore_cm, comp.epsPi);
}

/**
 * The isotherm-independent overall liquid-side mass-transfer coefficient.
 *
 *   1/k_ov = rp_cm/(3*kf_cms)  +  rp_cm^2/(15 * comp.epsPi * Dpore_cm2s)
 *   k_ov  *= comp.keffScale ;  clamped to [1e-6, 1e4] 1/s
 *
 * THE POROSITY IN THE PORE TERM IS `comp.epsPi` — the SPECIES' accessible pore porosity — and
 * never `colCfg.epsP`. This is worth up to 2x on every DBC and every peak width: mAb comes out
 * at 0.03008 1/s with epsPi = 0.70 and at 0.0363 (+21 %) with the resin epsP = 0.85, and AGG
 * moves +87 % (§6.8, §7.3.4).
 *
 * When `|u_cms| < 1e-7` the film term is dropped (tau_film := 0) and pore diffusion governs —
 * a real skid still equilibrates the film during a stagnant hold.
 *
 * @param {object} colCfg a `createColumn` cfg (`{...config.column, comps, chem}`): reads
 *        `dp_cm`, `rp_cm`, `epsC`, `rPore_cm`
 * @param {object} comp   ColumnSpeciesConfig (§5.8.2): reads `MW_gmol`, `epsPi`, `Dm_cm2s`,
 *        `Dp_cm2s`, `keffScale`
 * @param {number} u_cms  SUPERFICIAL velocity, cm/s
 * @param {number} T_C    temperature, degC
 * @param {number} mu_cP  dynamic viscosity, cP
 * @param {number} rho_gmL density, g/mL
 * @returns {number} k_ov in 1/s, always finite and inside [1e-6, 1e4].
 */
export function computeKov_s1(colCfg, comp, u_cms, T_C, mu_cP, rho_gmL) {
  const rp_cm = particleRadius_cm(colCfg);
  const epsPi = comp.epsPi;
  const Dm = resolveDm_cm2s(comp, T_C, mu_cP);
  if (!(Dm > 0) || !(rp_cm > 0)) return KOV_MIN_s1;

  const rs_cm = stokesRadius_cm(Dm, T_C, mu_cP);
  const Dpore = resolveDpore_cm2s(colCfg, comp, Dm, rs_cm);

  let tauFilm_s = 0;
  if (Math.abs(u_cms) >= U_STAGNANT_cms) {
    const kf = filmKernel(u_cms, colCfg.dp_cm, colCfg.epsC, Dm, mu_cP, rho_gmL);
    tauFilm_s = (kf > 0) ? rp_cm / (3 * kf) : Infinity;
  }
  const tauPore_s = (Dpore > 0 && epsPi > 0)
    ? (rp_cm * rp_cm) / (15 * epsPi * Dpore)
    : Infinity;

  const sum_s = tauFilm_s + tauPore_s;
  let kOv = (sum_s > 0 && Number.isFinite(sum_s)) ? 1 / sum_s : KOV_MIN_s1;

  const ks = numOrDefault(comp.keffScale, 1);
  kOv *= ks;
  if (!Number.isFinite(kOv)) kOv = KOV_MIN_s1;
  return clamp(kOv, KOV_MIN_s1, KOV_MAX_s1);
}

/**
 * Fill `out_s1[j] = computeKov_s1(colCfg, comps[j], ...)` for every component.
 *
 * RECOMPUTE POLICY (§6.8): `physics/column.js` calls this once per TICK — never per substep —
 * and only when `|u_new - u_cached|/u_cached > 0.01` or `|mu_new - mu_cached|/mu_cached > 0.02`.
 * Allocates nothing.
 *
 * @param {object} colCfg createColumn cfg
 * @param {Array<object>} comps ColumnSpeciesConfig[], COLUMN index order, length nsCol
 * @param {number} u_cms   superficial velocity, cm/s
 * @param {number} T_C     temperature, degC
 * @param {number} mu_cP   viscosity, cP
 * @param {number} rho_gmL density, g/mL
 * @param {Float64Array} out_s1 OUTPUT, k_ov in 1/s, length >= comps.length
 * @returns {void}
 */
export function computeAllKov(colCfg, comps, u_cms, T_C, mu_cP, rho_gmL, out_s1) {
  for (let j = 0, n = comps.length; j < n; j++) {
    out_s1[j] = computeKov_s1(colCfg, comps[j], u_cms, T_C, mu_cP, rho_gmL);
  }
}

/**
 * Every intermediate of the `k_ov` chain, for diagnostics, the UI and the acceptance tests.
 *
 * Operator rate only — it allocates its return object. `kOv_s1` is byte-identical to what
 * `computeKov_s1` returns for the same arguments (same kernels, same clamps).
 *
 * Reference (§7.3.3, lysozyme at T = 25 degC and mu = 0.945 cP, and NOT at any other T/mu):
 *   rs 1.9083e-7 cm, lambda 0.06361, psi 0.7599, tortuosity 1.8304, Dpore 5.0277e-7 cm^2/s,
 *   Re 0.0396, Sc 7818, Sh 21.07, kf 2.8350e-3 cm/s, kOv 0.2711 1/s, filmFraction 0.143.
 * Dev sanity bands (§7.3.1): Re in [1e-5, 1e2] and Sc in [1e2, 1e5]; outside either, one of the
 * two unit factors (100 and 0.01) has been dropped.
 *
 * @param {object} colCfg createColumn cfg
 * @param {object} comp   ColumnSpeciesConfig
 * @param {number} u_cms  superficial velocity, cm/s
 * @param {number} T_C    temperature, degC
 * @param {number} mu_cP  viscosity, cP
 * @param {number} rho_gmL density, g/mL
 * @returns {{Dm_cm2s:number, Dpore_cm2s:number, rs_cm:number, lambda:number, psi:number,
 *   tortuosity:number, Re:number, Sc:number, Sh:number, kf_cms:number, tauFilm_s:number,
 *   tauPore_s:number, kOv_s1:number, filmFraction:number}}
 *   Units: cm^2/s, cm^2/s, cm, -, -, -, -, -, -, cm/s, s, s, 1/s, -.
 */
export function kovBreakdown(colCfg, comp, u_cms, T_C, mu_cP, rho_gmL) {
  const rp_cm = particleRadius_cm(colCfg);
  const epsPi = comp.epsPi;
  const dp_cm = colCfg.dp_cm;
  const Dm = resolveDm_cm2s(comp, T_C, mu_cP);
  const rs_cm = stokesRadius_cm(Dm, T_C, mu_cP);
  const rPore_cm = colCfg.rPore_cm;
  const lambda = (rPore_cm > 0) ? rs_cm / rPore_cm : Infinity;
  const psi = hindrance(rs_cm, rPore_cm);
  const tortuosity = tortuosityMM(epsPi);
  const Dpore = resolveDpore_cm2s(colCfg, comp, Dm, rs_cm);

  let Re = (mu_cP > 0) ? 100 * rho_gmL * Math.abs(u_cms) * dp_cm / mu_cP : 0;
  if (!(Re > RE_MIN)) Re = RE_MIN;
  const Sc = (Dm > 0 && rho_gmL > 0) ? 0.01 * mu_cP / (rho_gmL * Dm) : 0;
  const Sh = (colCfg.epsC > 0) ? (1.09 / colCfg.epsC) * Math.cbrt(Re * Sc) : 0;
  const kf_cms = (dp_cm > 0) ? Sh * Dm / dp_cm : 0;

  let tauFilm_s = 0;
  if (Math.abs(u_cms) >= U_STAGNANT_cms) tauFilm_s = (kf_cms > 0) ? rp_cm / (3 * kf_cms) : Infinity;
  const tauPore_s = (Dpore > 0 && epsPi > 0) ? (rp_cm * rp_cm) / (15 * epsPi * Dpore) : Infinity;
  const sum_s = tauFilm_s + tauPore_s;

  return {
    Dm_cm2s: Dm,
    Dpore_cm2s: Dpore,
    rs_cm,
    lambda,
    psi,
    tortuosity,
    Re,
    Sc,
    Sh,
    kf_cms,
    tauFilm_s,
    tauPore_s,
    kOv_s1: computeKov_s1(colCfg, comp, u_cms, T_C, mu_cP, rho_gmL),
    filmFraction: (Number.isFinite(sum_s) && sum_s > 0) ? tauFilm_s / sum_s : 0,
  };
}
