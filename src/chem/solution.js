/**
 * src/chem/solution.js — bulk solution properties from a species vector.
 *
 * Architecture contract §6.5, §7.1.2 (viscosity), §7.4.1 (conductivity temperature).
 * Layer L1: imports `core/util.js` and NOTHING else. No DOM, no state, no allocation in any
 * function that the 20 Hz tick path calls (`mixtureViscosity_cP`, `density_gmL`,
 * `ionicStrength_molL`, `kappa25_mScm`, `kappaRaw_mScm`, `kappaDisplay_mScm`).
 *
 * UNITS (§1.1, binding): concentrations `_mM`, viscosity `_cP`, density `_gmL`,
 * conductivity `_mScm`, temperature `_C`. Molar concentrations passed to the salt/NaCl
 * correlations are in mol/L and carry `_molL`, because that is the unit those published
 * correlations are written in (R-U2: a local SI/mol-L conversion inside a correlation body
 * is legal; crossing a module boundary in anything but the canonical set is not).
 *
 * VERIFIED ANCHORS (tests/chem.test.js):
 *   kappaNaCl25_mScm(1.0)     = 85.0356 mS/cm   (the "1 M NaCl = 85.04" anchor)
 *   kappaNaCl25_mScm(0.154)   = 15.902  mS/cm
 *   kappaNaCl25_mScm(0.01)    =  1.1884 mS/cm
 *   cFromKappaNaCl_molL(85.2) =  1.0023 mol/L
 *   kappa25_mScm(0.1 M NaOH)  = 24.81 * 0.843125 * 1.0517 = 22.00 mS/cm
 *   muWater_cP(20/25/5)       = 1.001749 / 0.890439 / 1.501204 cP; mu(4)/mu(20) = 1.544398
 *   kappaDisplay/kappaRaw at 5 C = 1.0979  (reads 9.8 % HIGH — see kappaDisplay_mScm)
 */

import { clamp } from '../core/util.js';

/** Pure-ethanol density, g/mL. Converts an ethanol concentration to a volume fraction. */
const ETHANOL_DENSITY_gmL = 0.789;

/** Limiting equivalent conductivity of NaCl at infinite dilution, S*cm^2/eq (= 50.1 + 76.3). */
const LAMBDA_NACL_0 = 126.4;

/** Physics temperature model for conductivity (§7.4.1) — QUADRATIC, on purpose. */
const COND_ALPHA_PHYS_perC = 0.0214;
const COND_BETA_PHYS_perC2 = 1.4e-4;

/** Mass threshold above which a neutral species counts as "protein" for viscosity, g/mol. */
const PROTEIN_MW_MIN_gmol = 5000;

// ---------------------------------------------------------------------------------------------
// VISCOSITY
// ---------------------------------------------------------------------------------------------

/**
 * Dynamic viscosity of pure water, Vogel correlation (§7.1.2).
 *
 * @param {number} T_C temperature, degC
 * @returns {number} viscosity, cP (= mPa*s). 20 C -> 1.001749, 25 C -> 0.890439, 5 C -> 1.501204.
 */
export function muWater_cP(T_C) {
  return 2.414e-2 * Math.pow(10, 247.8 / (T_C + 273.15 - 140));
}

/**
 * Jones–Dole viscosity B-coefficients, per salt. COMPLETE (§6.5) — no entry may be elided:
 * the shipped pilot preset is an acetate buffer cleaned with 0.5 M NaOH, so `fSalt` hits
 * NaOH and NaOAc on the golden run.
 * `A` is the Falkenhagen sqrt term, `B` the linear Jones–Dole term, `D` the quadratic term.
 */
export const JONES_DOLE = {
  NaCl: { A: 0.0062, B: 0.0793, D: 0.0080 },
  NaOH: { A: 0.0074, B: 0.1250, D: 0.0060 },
  NaOAc: { A: 0.0064, B: 0.2500, D: 0.0100 },
  KCl: { A: 0.0052, B: -0.0140, D: 0.0043 },
  Na2SO4: { A: 0.0110, B: 0.2120, D: 0.0250 },
  '(NH4)2SO4': { A: 0.0089, B: 0.0180, D: 0.0130 },
  citrate: { A: 0.0120, B: 0.4200, D: 0.0300 },
};

/**
 * Relative viscosity multiplier of one dissolved salt: 1 + A*sqrt(c) + B*c + D*c^2.
 *
 * @param {string} saltId key of JONES_DOLE ('NaCl' | 'NaOH' | 'NaOAc' | ...)
 * @param {number} c_molL salt concentration, mol/L (negative values are clamped to 0)
 * @returns {number} dimensionless multiplier, 1.0 for an unknown salt or c = 0
 */
export function fSalt(saltId, c_molL) {
  const jd = JONES_DOLE[saltId];
  if (jd === undefined) return 1.0;
  const c = c_molL > 0 ? c_molL : 0;
  return 1 + jd.A * Math.sqrt(c) + jd.B * c + jd.D * c * c;
}

/**
 * Relative viscosity of water/ethanol mixtures against volume fraction ethanol at ~20 C.
 * COMPLETE (§6.5): linear interpolation between these seven knots, clamped outside [0, 1].
 * EtOH is shipped species index 1, so this is a live path.
 */
export const F_ORGANIC = [
  [0.0, 1.00], [0.1, 1.33], [0.2, 1.75], [0.3, 2.15],
  [0.5, 2.40], [0.7, 2.35], [1.0, 1.20],
];

/**
 * Relative viscosity multiplier of an aqueous ethanol mixture.
 *
 * @param {number} fracEthanol ethanol VOLUME fraction, dimensionless 0..1 (clamped)
 * @returns {number} dimensionless multiplier; 1.00 at 0, 2.40 at 0.5, 1.20 at 1.0
 */
export function fOrganic(fracEthanol) {
  const x = clamp(fracEthanol, 0, 1);
  const n = F_ORGANIC.length;
  if (x <= F_ORGANIC[0][0]) return F_ORGANIC[0][1];
  for (let k = 1; k < n; k++) {
    const x1 = F_ORGANIC[k][0];
    if (x <= x1) {
      const x0 = F_ORGANIC[k - 1][0];
      const y0 = F_ORGANIC[k - 1][1];
      const y1 = F_ORGANIC[k][1];
      const t = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return F_ORGANIC[n - 1][1];
}

/**
 * Relative viscosity multiplier of a protein solution (Huggins form).
 * eta_rel = 1 + [eta]*c + kH*([eta]*c)^2.
 *
 * @param {number} c_gL total protein concentration, g/L
 * @param {number} [intrinsic_Lg=6.3e-3] intrinsic viscosity [eta], L/g (typical IgG value)
 * @param {number} [kH=0.40] Huggins constant, dimensionless
 * @returns {number} dimensionless multiplier, >= 1
 */
export function fProtein(c_gL, intrinsic_Lg = 6.3e-3, kH = 0.40) {
  const c = c_gL > 0 ? c_gL : 0;
  const x = intrinsic_Lg * c;
  return 1 + x + kH * x * x;
}

/**
 * Viscosity of the actual mixture at the composition `y_mM`.
 *
 * Water (Vogel) times the additive Jones–Dole excess of every salt pair present, times the
 * organic multiplier, times the protein multiplier when `enableProtein` is set.
 * Salt pairing is electroneutral and greedy in this order: strong base first (NaOH), then the
 * strong anion (NaCl), then the ionised buffer anion (NaOAc). The pairs are combined
 * additively — `f = 1 + SUM(f_k - 1)` — which is how Jones–Dole excess viscosities compose.
 * 1:1 salts are assumed (every shipped preset is NaCl / NaOH / NaOAc); for a 2:1 salt the
 * pairing concentration is in charge equivalents, which over-counts the D term slightly.
 *
 * ZERO ALLOCATION: one pass over `config.species`, all scalars.
 *
 * @param {object} config frozen config (§2.1); reads `config.species[i]`
 *                        `.role`, `.charge`, `.ionisedFraction`, `.MW_gmol`, `.bufferPkas`
 * @param {Float64Array} y_mM species vector, length config.ns, mM
 * @param {number} T_C temperature, degC
 * @param {boolean} enableProtein include the protein term (config.column.enableProteinViscosity,
 *                                D23, false by default; hydraulics passes it straight through)
 * @returns {number} dynamic viscosity, cP
 */
export function mixtureViscosity_cP(config, y_mM, T_C, enableProtein) {
  const species = config.species;
  const ns = species.length;
  let cationEq_mM = 0;        // charge equivalents of strong cations (Na, K, NH4)
  let anionStrongEq_mM = 0;   // charge equivalents of strong anions (Cl)
  let anionBufferEq_mM = 0;   // charge equivalents of IONISED buffer anions (acetate)
  let baseExcess_mM = 0;      // free hydroxide carried as the baseExcess species (OHex)
  let organic_gL = 0;
  let protein_gL = 0;

  for (let i = 0; i < ns; i++) {
    const c = y_mM[i];
    if (!(c > 0)) continue;
    const sp = species[i];
    const z = sp.charge || 0;
    if (sp.role === 'organic') {
      organic_gL += c * sp.MW_gmol / 1000;
      continue;
    }
    if (sp.role === 'baseExcess') {
      baseExcess_mM += c * (z !== 0 ? Math.abs(z) : 1);
      continue;
    }
    if (z === 0) {
      if (sp.MW_gmol >= PROTEIN_MW_MIN_gmol) protein_gL += c * sp.MW_gmol / 1000;
      continue;
    }
    const f = sp.ionisedFraction === undefined ? 1 : sp.ionisedFraction;
    if (z > 0) cationEq_mM += z * c * f;
    else if (sp.bufferPkas) anionBufferEq_mM += -z * c * f;
    else anionStrongEq_mM += -z * c * f;
  }

  let rem_mM = cationEq_mM;
  const cNaOH_molL = Math.min(rem_mM, baseExcess_mM) / 1000;
  rem_mM -= cNaOH_molL * 1000;
  const cNaCl_molL = Math.min(rem_mM, anionStrongEq_mM) / 1000;
  rem_mM -= cNaCl_molL * 1000;
  const cNaOAc_molL = Math.min(rem_mM, anionBufferEq_mM) / 1000;

  let f = 1;
  f += fSalt('NaOH', cNaOH_molL) - 1;
  f += fSalt('NaCl', cNaCl_molL) - 1;
  f += fSalt('NaOAc', cNaOAc_molL) - 1;

  let mu_cP = muWater_cP(T_C) * f;
  if (organic_gL > 0) mu_cP *= fOrganic(organic_gL / (1000 * ETHANOL_DENSITY_gmL));
  if (enableProtein && protein_gL > 0) mu_cP *= fProtein(protein_gL);
  return mu_cP;
}

/**
 * Mixture density (§6.5): `0.9982 + 4.0e-5 * c_NaCl_mM`.
 *
 * The contract's signature carries no `config`, so the species vector alone must yield a
 * NaCl-equivalent. RESOLVED CHOICE: the salt pair is the smaller of the two largest entries of
 * the vector — an electroneutral 1:1 salt always shows up as two comparably large entries
 * (Na 500 / Cl 461.8 -> 461.8 mM -> 1.0167 g/mL; Na 500 / OHex 500 -> 1.0182 g/mL, and
 * 0.5 M NaOH really is 1.0195). A single large entry (ethanol) cannot masquerade as a salt.
 * `T_C` is accepted for signature compatibility and is deliberately unused: the contract's
 * density model carries no temperature term and `run.rho_gmL` is initialised to 0.9982 at 25 C.
 *
 * @param {Float64Array} y_mM species vector, mM
 * @param {number} T_C temperature, degC (unused — see above)
 * @returns {number} density, g/mL
 */
export function density_gmL(y_mM, T_C) {
  let max1 = 0;
  let max2 = 0;
  for (let i = 0; i < y_mM.length; i++) {
    const c = y_mM[i];
    if (c > max1) { max2 = max1; max1 = c; } else if (c > max2) { max2 = c; }
  }
  return 0.9982 + 4.0e-5 * max2;
}

// ---------------------------------------------------------------------------------------------
// CONDUCTIVITY
// ---------------------------------------------------------------------------------------------

/**
 * Limiting equivalent ionic conductivities at 25 C, S*cm^2/eq. Reference table for the data
 * layer: every SpeciesConfig authors its own `lambda0_Scm2eq` from these values (§5.8.1).
 */
export const LAMBDA0 = {
  H: 349.8, OH: 198.0, Na: 50.1, Cl: 76.3, K: 73.5, NH4: 73.5,
  Acetate: 40.9, H2PO4: 36.0, HPO4: 57.0, Citrate: 70.2,
  TrisH: 29.5, ArgH: 28.0,
};

/**
 * Equivalent conductivity of NaCl at 25 C against concentration (Kohlrausch-type quartic in
 * sqrt(c)). §6.5.
 *
 * @param {number} c_molL NaCl concentration, mol/L (clamped to >= 0)
 * @returns {number} equivalent conductivity, S*cm^2/eq. 126.4 at c = 0, 85.0356 at 1.0 M.
 */
export function lambdaNaCl(c_molL) {
  const c = c_molL > 0 ? c_molL : 0;
  const x = Math.sqrt(c);
  return 126.4 - 82.8623 * x + 76.7090 * x * x - 43.6797 * x * x * x + 8.4686 * x * x * x * x;
}

/**
 * Conductivity of a pure NaCl solution at 25 C.
 *
 * @param {number} c_molL NaCl concentration, mol/L
 * @returns {number} conductivity, mS/cm. 1.0 M -> 85.0356; 0.154 M -> 15.902; 0.01 M -> 1.1884.
 */
export function kappaNaCl25_mScm(c_molL) {
  const c = c_molL > 0 ? c_molL : 0;
  return c * lambdaNaCl(c);
}

/**
 * Inverse of `kappaNaCl25_mScm`: the NaCl concentration that reads `kappa_mScm` at 25 C.
 * Newton from the linear guess `kappa/85.2`, at most 6 iterations (§6.5).
 *
 * @param {number} kappa_mScm conductivity, mS/cm
 * @returns {number} NaCl concentration, mol/L. c(85.2) = 1.0023 M.
 */
export function cFromKappaNaCl_molL(kappa_mScm) {
  if (!(kappa_mScm > 0)) return 0;
  let c = kappa_mScm / 85.2;
  for (let it = 0; it < 6; it++) {
    const x = Math.sqrt(c);
    const lam = 126.4 - 82.8623 * x + 76.7090 * x * x - 43.6797 * x * x * x + 8.4686 * x * x * x * x;
    const dLam_dx = -82.8623 + 2 * 76.7090 * x - 3 * 43.6797 * x * x + 4 * 8.4686 * x * x * x;
    const f = c * lam - kappa_mScm;
    // d(kappa)/dc = lambda + c * dLambda/dx * dx/dc, dx/dc = 1/(2*sqrt(c)) -> c*dx/dc = x/2
    const df = lam + 0.5 * x * dLam_dx;
    if (!(Math.abs(df) > 1e-12)) break;
    const step = f / df;
    c -= step;
    if (c < 0) c = 0;
    if (Math.abs(step) < 1e-12) break;
  }
  return c;
}

/**
 * Effective charge magnitude of species `i` for conductivity and ionic strength: how many
 * charge equivalents per mole the species actually carries at the solution's pH.
 * Uses `speciation.zbar[i]` when the caller supplies a solved speciation (chem/ph.js writes
 * exactly that array into its `scratch.charges`), otherwise the frozen
 * `charge * ionisedFraction` of §5.8.1.
 * @private
 */
function zAbsEff(sp, i, speciation) {
  if (speciation && speciation.zbar && i < speciation.zbar.length) {
    const zb = speciation.zbar[i];
    if (Number.isFinite(zb)) return Math.abs(zb);
  }
  const z = sp.charge || 0;
  if (z === 0) return 0;
  const f = sp.ionisedFraction === undefined ? 1 : sp.ionisedFraction;
  return Math.abs(z) * f;
}

/**
 * Ionic strength of the species vector: `I = 0.5 * SUM(c_i * z_i^2)`.
 *
 * The `z^2` weight of a buffer TOTAL is `|z| * |z_eff|` (for a monoprotic buffer that is exactly
 * `f * z^2`, e.g. 50 mM acetate at 72.03 % ionised contributes 36.014 mM, which is what makes
 * Buffer A's I come out at exactly 0.0500 mol/L — §8.2). A `speciation.z2bar` array, when the
 * caller supplies one, overrides that per species. The water ions are not included: this
 * function does not solve pH. chem/ph.js::solvePH carries the full water term internally.
 *
 * The baseExcess species (OHex) IS counted here — in this module it is the only carrier of
 * hydroxide, since nothing here evaluates the water equilibrium.
 *
 * ZERO ALLOCATION.
 *
 * @param {object} config frozen config; reads `config.species`
 * @param {Float64Array} y_mM species vector, mM
 * @param {{zbar?:Float64Array, z2bar?:Float64Array}|null} speciation optional solved speciation
 * @returns {number} ionic strength, mol/L
 */
export function ionicStrength_molL(config, y_mM, speciation) {
  const species = config.species;
  const ns = species.length;
  let sum_mM = 0;
  for (let i = 0; i < ns; i++) {
    const c = y_mM[i];
    if (!(c > 0)) continue;
    const sp = species[i];
    let z2;
    if (speciation && speciation.z2bar && i < speciation.z2bar.length
        && Number.isFinite(speciation.z2bar[i])) {
      z2 = speciation.z2bar[i];
    } else {
      const z = Math.abs(sp.charge || 0);
      if (z === 0) continue;
      z2 = z * zAbsEff(sp, i, speciation);
    }
    sum_mM += c * z2;
  }
  return 0.5 * sum_mM / 1000;
}

/**
 * Empirical conductivity calibration factors (§6.5). One row matches at a time; the NaOH rows
 * are interpolated in concentration.
 *
 * The 0.1 M NaOH factor is **1.0517, not 1.10**: the raw model gives
 * `(50.1 + 198.0) * 0.1 * Fr(0.1) = 24.81 * 0.843125 = 20.918 mS/cm`, and 1.10 would yield
 * 23.01 rather than the required 22.0 mS/cm (§11 C-04).
 */
export const CAL_TABLE = [
  { match: 'NaOH', c_molL: 0.1, f: 1.0517 },
  { match: 'NaOH', c_molL: 0.5, f: 1.185 },
  { match: 'NaOH', c_molL: 1.0, f: 1.138 },
  { match: 'EtOH+NaCl', f: 0.72 },
];

/** NaOH calibration knots, ascending, with the implicit (0 mol/L, f = 1.0) anchor prepended.
 *  Built once at module load so `calFactor` allocates nothing — it runs at 20 Hz through the
 *  whole CIP block. Mirrors the `match: 'NaOH'` rows of CAL_TABLE and nothing else. */
const CAL_NAOH_C = [0, 0.1, 0.5, 1.0];
const CAL_NAOH_F = [1.0, 1.0517, 1.185, 1.138];
const CAL_ETOH_NACL_F = 0.72;

/**
 * Select the single CAL_TABLE factor that applies to this composition.
 * NaOH: piecewise-linear in the hydroxide concentration through (0, 1.0) and the three table
 * knots, held at 1.138 above 1.0 M. EtOH+NaCl: applied when an organic is present together with
 * a salt. Neither: 1.0.
 * @private
 */
function calFactor(cBase_molL, fOrganicFrac, cSalt_molL) {
  if (cBase_molL > 1e-9) {
    for (let k = 1; k < CAL_NAOH_C.length; k++) {
      if (cBase_molL <= CAL_NAOH_C[k]) {
        const c0 = CAL_NAOH_C[k - 1];
        const t = (cBase_molL - c0) / (CAL_NAOH_C[k] - c0);
        return CAL_NAOH_F[k - 1] + (CAL_NAOH_F[k] - CAL_NAOH_F[k - 1]) * t;
      }
    }
    return CAL_NAOH_F[CAL_NAOH_F.length - 1];
  }
  if (fOrganicFrac > 0.02 && cSalt_molL > 1e-6) return CAL_ETOH_NACL_F;
  return 1.0;
}

/**
 * Conductivity of the mixture at 25 C (§6.5):
 *
 *   kappa25 = Fr(I) * SUM(lambda0_i * |z_eff_i| * c_i) * f_cal * max(0.05, 1 - 1.4*f_org)
 *   Fr(I)   = lambdaNaCl(min(I, 5)) / 126.4
 *
 * ZERO ALLOCATION on the summation path (`calFactor` allocates only in the NaOH branch, which
 * the CIP block reaches at operator rate, not per tick — and even there it is 3 rows).
 *
 * @param {object} config frozen config; reads `config.species[i].lambda0_Scm2eq`, `.charge`,
 *                        `.ionisedFraction`, `.role`, `.MW_gmol`
 * @param {Float64Array} y_mM species vector, mM
 * @param {{zbar?:Float64Array, z2bar?:Float64Array}|null} speciation optional solved speciation
 *        (chem/ph.js::solvePH fills `scratch.charges` with exactly the `zbar` array)
 * @returns {number} conductivity at 25 C, mS/cm
 */
export function kappa25_mScm(config, y_mM, speciation) {
  const species = config.species;
  const ns = species.length;
  let sum = 0;              // SUM lambda0*|z_eff|*c_mM  -> divided by 1000 gives mS/cm
  let organic_gL = 0;
  let baseExcess_mM = 0;
  let salt_mM = 0;
  for (let i = 0; i < ns; i++) {
    const c = y_mM[i];
    if (!(c > 0)) continue;
    const sp = species[i];
    if (sp.role === 'organic') {
      organic_gL += c * sp.MW_gmol / 1000;
      continue;
    }
    const zAbs = zAbsEff(sp, i, speciation);
    if (zAbs === 0) continue;
    sum += (sp.lambda0_Scm2eq || 0) * zAbs * c;
    if (sp.role === 'baseExcess') baseExcess_mM += c * zAbs;
    else if (!sp.bufferPkas && (sp.charge || 0) < 0) salt_mM += c * zAbs;
  }
  const I_molL = ionicStrength_molL(config, y_mM, speciation);
  const Fr = lambdaNaCl(Math.min(I_molL, 5)) / LAMBDA_NACL_0;
  const fOrg = organic_gL / (1000 * ETHANOL_DENSITY_gmL);
  const fCal = calFactor(baseExcess_mM / 1000, fOrg, salt_mM / 1000);
  const suppress = Math.max(0.05, 1 - 1.4 * fOrg);
  return Fr * (sum / 1000) * fCal * suppress;
}

/**
 * Physical (uncompensated) conductivity at the fluid temperature — QUADRATIC (§7.4.1):
 *   kappa_raw = kappa25 * (1 + 0.0214*dT + 1.4e-4*dT^2),  dT = T_C - 25.
 *
 * @param {number} kappa25 conductivity at 25 C, mS/cm
 * @param {number} T_C fluid temperature at the cell, degC
 * @returns {number} raw conductivity, mS/cm
 */
export function kappaRaw_mScm(kappa25, T_C) {
  const dT = T_C - 25;
  return kappa25 * (1 + COND_ALPHA_PHYS_perC * dT + COND_BETA_PHYS_perC2 * dT * dT);
}

/**
 * Meter-displayed, temperature-compensated conductivity — LINEAR inverse ONLY (§7.4.1):
 *   kappa_display = kappa_raw / (1 + alphaMeter*(T_C - Tref_C)).
 *
 * THE QUADRATIC-PHYSICS / LINEAR-METER MISMATCH IS A MODELLED INSTRUMENT ARTEFACT AND ITS SIGN
 * IS **HIGH**: the linear compensator always over-corrects, so a cold room reads HIGH, not low.
 * display/true = 1.0979 at 5 C (9.8 % high), 1.0636 at 8 C, 1.0392 at 45 C. Do not "fix" it and
 * do not invert its sign (§11 C-02).
 *
 * @param {number} kappaRaw uncompensated conductivity at T_C, mS/cm
 * @param {number} T_C fluid temperature at the cell, degC
 * @param {number} Tref_C meter reference temperature, degC (config.chem.condTref_C = 25)
 * @param {number} alphaMeter meter compensation slope, 1/degC (config.chem.condAlphaMeter_perC)
 * @returns {number} displayed conductivity, mS/cm
 */
export function kappaDisplay_mScm(kappaRaw, T_C, Tref_C, alphaMeter) {
  const denom = 1 + alphaMeter * (T_C - Tref_C);
  if (!(Math.abs(denom) > 1e-6)) return kappaRaw;
  return kappaRaw / denom;
}
