/**
 * src/chem/ph.js — Davies activity, the pKa ladder, the pH solve, the preparation-time
 * counter-ion solve, the buffer library, and tank-vector construction.
 *
 * Architecture contract §6.6, §8.2, §5.8.1. ONE FILE, so there is no `buffers <-> ph` cycle
 * (§4, §11 C-20). Layer L1: imports `core/util.js` and NOTHING else — in particular it does
 * NOT import `chem/solution.js` (build order §14 puts this file first), which is why
 * `describeTank` carries the small, explicitly-labelled mirror of §6.5's conductivity formula
 * at the bottom of this file.
 *
 * UNITS (§1.1, binding): concentrations `_mM`, ionic strength and the correlation-internal
 * proton/hydroxide activities `_molL` (mol/L is the unit every published activity correlation
 * is written in — R-U2), temperature `_C`, pH dimensionless.
 *
 * ================================ THE WATER CONVENTION ================================
 * NORMATIVE (§6.6), because `config.chem.sodiumErrorK = 0.673` is calibrated against it:
 *   - `Kw` is a CONCENTRATION product. pKw = 14.000 at 25 C with NO Davies shift.
 *   - `pH = -log10([H+])`, with NO activity coefficient on the proton.
 *   - `pkaAdjusted` applies to the BUFFER LADDERS ONLY.
 * Under this convention 0.5 M NaOH is pOH 0.30103, true pH 13.699, and the sodium error
 * -0.673*(13.699-12)*log10(0.5/0.1) = -0.7990 makes the electrode read exactly 12.900.
 * Shifting Kw or the proton instead gives 13.5625/12.83 or 13.428/12.72 — three "correct"
 * answers from one unstated convention, which is why this block exists.
 *
 * ================================ VERIFIED ANCHORS ====================================
 *   acetate pKa' at I = 0.1 / 1.0            -> 4.5460 / 4.4878   (the Ie <= 0.39 clamp is why)
 *   50 mM acetate, pH 5.00, required Na+     -> 35.542 mM (contract prints 35.532; see NOTE-A)
 *   20 mM Tris,    pH 8.00, required Cl-     -> 10.690 mM (z0 = +1 so 2(1-z) = 0, zero shift)
 *   20 mM phosphate, pH 7.00, required Na+   -> 31.406 mM (exact)
 *   Buffer A (50 mM AcT, pH 5.00, Na 50 tot) -> titrant 36.014 mM, NaCl 13.986, I 0.0500
 *   Buffer B (50 mM AcT, pH 5.00, Na 500 tot)-> titrant 38.241 mM, NaCl 461.76, I 0.5000
 *   0.5 M NaOH                               -> true pH 13.699, read 12.900
 *   20 mM Tris pH 8.00 prepared at 25 C, read at 4 C -> 8.59
 */

import { clamp } from '../core/util.js';

/** Maximum protonation steps a ladder may carry; `scratch.tj` is Float64Array(8) (§6.6). */
const MAX_LADDER = 8;

/** Default water ion product (concentration basis) when `config.chem.Kw` is absent. */
const KW_DEFAULT = 1e-14;

/** Pure-ethanol density, g/mL — converts `organic_frac` (volume fraction) to mM. */
const ETHANOL_DENSITY_gmL = 0.789;

/** Bisection bracket for the counter-ion solve, mM of net strong-ion charge. */
const TITRANT_LO_mM = -1e4;
const TITRANT_HI_mM = 1e4;

/**
 * The buffer library. COMPLETE (§6.6) — no entry may be elided.
 * `z0` is the charge of the FULLY PROTONATED form. `dpKadT` is dpKa/dT in 1/degC.
 * `range` is the useful buffering window (advisory, for validation warnings).
 * `anionLambda0` is the limiting equivalent conductivity of the ionised form, S*cm^2/eq.
 */
export const BUFFER_LIBRARY = {
  acetate: { pKas: [4.76], z0: 0, dpKadT: +0.0002, range: [3.8, 5.8], anionLambda0: 40.9 },
  citrate: { pKas: [3.13, 4.76, 6.40], z0: 0, dpKadT: -0.0024, range: [2.5, 7.0], anionLambda0: 70.2 },
  MES: { pKas: [6.15], z0: 0, dpKadT: -0.011, range: [5.5, 6.7], anionLambda0: 30.0 },
  phosphate: { pKas: [2.15, 7.20, 12.35], z0: 0, dpKadT: -0.0028, range: [6.0, 8.0], anionLambda0: 36.0 },
  HEPES: { pKas: [7.55], z0: 0, dpKadT: -0.014, range: [6.8, 8.2], anionLambda0: 22.0 },
  tris: { pKas: [8.06], z0: +1, dpKadT: -0.028, range: [7.0, 9.0], anionLambda0: 29.5 },
  glycine: { pKas: [2.35, 9.78], z0: +1, dpKadT: -0.025, range: [2.0, 3.5], anionLambda0: 37.0 },
  histidine: { pKas: [1.80, 6.04, 9.33], z0: +2, dpKadT: -0.017, range: [5.5, 6.5], anionLambda0: 24.0 },
  arginine: { pKas: [2.17, 9.04, 12.48], z0: +2, dpKadT: -0.028, range: [8.5, 9.5], anionLambda0: 28.0 },
  carbonate: { pKas: [6.35, 10.33], z0: 0, dpKadT: -0.009, range: [9.0, 11.0], anionLambda0: 44.5 },
};

// ---------------------------------------------------------------------------------------------
// ACTIVITY
// ---------------------------------------------------------------------------------------------

/**
 * Davies log10(gamma) for a MONOVALENT ion.
 *   lg1 = -A * ( sqrt(Ie)/(1 + sqrt(Ie)) - 0.3*Ie ),   Ie = min(I, IeMax)
 *
 * THE CLAMP IS MANDATORY: without `Ie = min(I, 0.39)` the Davies expression turns over and the
 * acetate pKa' at I = 1.0 comes out on the wrong side of its own I = 0.1 value. With it,
 * pKa'(0.1) = 4.5460 and pKa'(1.0) = 4.4878, which are the contract's anchors.
 *
 * @param {number} I_molL ionic strength, mol/L (negatives clamped to 0)
 * @param {number} [A=0.509] Debye-Huckel A at 25 C (config.chem.daviesA)
 * @param {number} [IeMax=0.39] the mandatory clamp (config.chem.daviesIeMax)
 * @returns {number} log10 of the monovalent activity coefficient, dimensionless and <= 0
 */
export function daviesLg1(I_molL, A = 0.509, IeMax = 0.39) {
  const Ie = Math.min(I_molL > 0 ? I_molL : 0, IeMax);
  const s = Math.sqrt(Ie);
  return -A * (s / (1 + s) - 0.3 * Ie);
}

/**
 * Ionic-strength-adjusted pKa for one protonation step:
 *   pKa' = pKa + 2*(1 - z)*lg1 + cEmp*I
 * where `z` is the charge of the PROTONATED member of that step (acetate step 1: z = 0 for
 * HAc; phosphate step 2: z = -1 for H2PO4-; Tris step 1: z = +1 for TrisH+, which is why Tris
 * shows ZERO ionic-strength shift at every I).
 *
 * @param {number} pKa the (already temperature-adjusted) pKa, dimensionless
 * @param {number} zProtonated formal charge of the protonated form of this step
 * @param {number} lg1 monovalent Davies log10(gamma) from `daviesLg1`
 * @param {number} cEmp empirical linear-in-I coefficient (0 for every shipped buffer)
 * @param {number} I_molL ionic strength, mol/L
 * @returns {number} adjusted pKa', dimensionless
 */
export function pkaAdjusted(pKa, zProtonated, lg1, cEmp, I_molL) {
  return pKa + 2 * (1 - zProtonated) * lg1 + (cEmp || 0) * I_molL;
}

/**
 * Temperature-adjusted pKa: `pKa25 + dpKadT*(T_C - 25)`.
 * Tris at 4 C: 8.06 + (-0.028)*(-21) = 8.648, which is what makes a Tris buffer prepared to
 * pH 8.00 at 25 C read 8.59 in the cold room.
 *
 * @param {number} pKa25 pKa at 25 C, dimensionless
 * @param {number} dpKadT dpKa/dT, 1/degC
 * @param {number} T_C temperature, degC
 * @returns {number} pKa at T_C, dimensionless
 */
export function pkaAtT(pKa25, dpKadT, T_C) {
  return pKa25 + (dpKadT || 0) * (T_C - 25);
}

/** Ladder output, module-owned so the ladder allocates nothing. Consumed immediately. */
const LADDER = { zbar: 0, z2bar: 0, f0: 0 };

/** Module scratch for the exported convenience wrappers (never used by `solvePH`). */
const SCRATCH = { tj: new Float64Array(MAX_LADDER), charges: new Float64Array(16) };

/** Module-owned out object for `describeTank`'s internal pH solve. */
const PH_OUT = { pH: 7, I_molL: 0, iterations: 0 };

/**
 * Evaluate one buffer's protonation ladder at (pH, I, T) and write `LADDER`.
 * Species j (j = 0..n) has charge `z0 - j`; species 0 is fully protonated.
 * Computed in log10 space with the maximum term factored out, so a three-pKa ladder evaluated
 * at pH 14 cannot overflow.
 *
 * Takes the ladder as PRIMITIVES, not as a def object: `solvePH` calls this up to a thousand
 * times per solve and building a `{pKas, z0, ...}` wrapper per call would allocate on the 20 Hz
 * path (§13 / DoD 5, < 64 kB per 10 000 ticks).
 * @private
 */
function evalLadderRaw(pKas, z0, dpKadT, cEmp, pH, I_molL, T_C, lg1, tj) {
  const n = Math.min(pKas.length, tj.length - 1);
  // Pass 1 — cumulative log10 of each term, tracking the maximum for stability.
  let lt = 0;
  let ltMax = 0;
  tj[0] = 0;
  for (let j = 1; j <= n; j++) {
    const pKa = pkaAdjusted(pkaAtT(pKas[j - 1], dpKadT, T_C), z0 - (j - 1), lg1, cEmp, I_molL);
    lt += pH - pKa;
    tj[j] = lt;
    if (lt > ltMax) ltMax = lt;
  }
  // Pass 2 — normalised terms and the moments.
  let D = 0;
  for (let j = 0; j <= n; j++) {
    const t = Math.pow(10, tj[j] - ltMax);
    tj[j] = t;
    D += t;
  }
  let zbar = 0;
  let z2bar = 0;
  for (let j = 0; j <= n; j++) {
    const f = tj[j] / D;
    const z = z0 - j;
    zbar += f * z;
    z2bar += f * z * z;
  }
  LADDER.zbar = zbar;
  LADDER.z2bar = z2bar;
  LADDER.f0 = tj[0] / D;
}

/** `evalLadderRaw` against a def object ({ pKas, z0, dpKadT?, cEmp? }). @private */
function evalLadder(def, pH, I_molL, T_C, lg1, tj) {
  evalLadderRaw(def.pKas, def.z0 || 0, def.dpKadT || 0, def.cEmp || 0,
    pH, I_molL, T_C, lg1, tj);
}

/** `evalLadderRaw` against a SpeciesConfig's buffer fields (§5.8.1). @private */
function evalLadderSpecies(sp, pH, I_molL, T_C, lg1, tj) {
  evalLadderRaw(sp.bufferPkas, sp.bufferZ0 || 0, sp.bufferDpKadT || 0, sp.bufferCEmp || 0,
    pH, I_molL, T_C, lg1, tj);
}

/**
 * Mean charge of a buffer at a given proton concentration, via the t_j ladder.
 * Evaluated at 25 C (the signature carries no temperature); `solvePH` and `solveCounterIon`
 * use the internal temperature-aware path.
 *
 * @param {{pKas:number[], z0:number, dpKadT?:number, cEmp?:number}} bufferDef a BUFFER_LIBRARY
 *        entry or any object with the same shape
 * @param {number} H_molL proton concentration, mol/L
 * @param {number} I_molL ionic strength, mol/L
 * @returns {number} mean charge zbar of the buffer, dimensionless (negative for acetate)
 */
export function meanCharge(bufferDef, H_molL, I_molL) {
  const pH = -Math.log10(H_molL > 0 ? H_molL : 1e-300);
  evalLadder(bufferDef, pH, I_molL, 25, daviesLg1(I_molL), SCRATCH.tj);
  return LADDER.zbar;
}

// ---------------------------------------------------------------------------------------------
// THE pH SOLVE
// ---------------------------------------------------------------------------------------------

/** Species index for an id, via `config.idxById` when present, else a scan. Returns -1. */
function speciesIndex(config, id) {
  if (id === undefined || id === null) return -1;
  const map = config.idxById;
  if (map && map[id] !== undefined) return map[id];
  const species = config.species;
  for (let i = 0; i < species.length; i++) if (species[i].id === id) return i;
  return -1;
}

/**
 * Charge-balance residual, mM of net positive charge, at a trial pH.
 *
 * THE baseExcess SPECIES (OHex) IS EXCLUDED HERE, DELIBERATELY: it *is* free hydroxide, and the
 * water term below already carries every OH- the solution holds. Counting it as an ordinary
 * -1 anion would cancel the 500 mM Na+ of the CIP tank and return pH 7.000 for 0.5 M NaOH.
 * It is still written into `charges[]` with its formal charge, because chem/solution.js has no
 * water equilibrium and OHex is the only carrier of hydroxide conductivity there.
 * @private
 */
function chargeResidual_mM(config, y_mM, pH, I_molL, T_C, Kw, lg1, tj, charges) {
  const species = config.species;
  const ns = species.length;
  const H_molL = Math.pow(10, -pH);
  const OH_molL = Kw / H_molL;
  let sum_mM = 1000 * (H_molL - OH_molL);
  for (let i = 0; i < ns; i++) {
    const sp = species[i];
    const c = y_mM[i];
    const z = sp.charge || 0;
    if (sp.role === 'baseExcess') {
      if (charges && i < charges.length) charges[i] = z;
      continue;
    }
    if (z === 0 && !sp.bufferPkas) {
      if (charges && i < charges.length) charges[i] = 0;
      continue;
    }
    if (sp.bufferPkas && sp.bufferPkas.length > 0) {
      if (!(c > 0)) {
        if (charges && i < charges.length) charges[i] = 0;
        continue;
      }
      evalLadderSpecies(sp, pH, I_molL, T_C, lg1, tj);
      sum_mM += LADDER.zbar * c;
      if (charges && i < charges.length) charges[i] = LADDER.zbar;
    } else {
      sum_mM += z * c;
      if (charges && i < charges.length) charges[i] = z;
    }
  }
  return sum_mM;
}

/**
 * Ionic strength of the vector at a known pH, including the water ions and EXCLUDING the
 * baseExcess species for the same reason `chargeResidual_mM` excludes it (the water term
 * already carries that hydroxide: 0.5 M NaOH gives I = 0.5, not 0.75).
 * Also refreshes `charges[]` at this pH, so the caller is left with a consistent speciation.
 * @private
 */
function ionicStrengthAt_molL(config, y_mM, pH, I_molL, T_C, Kw, lg1, tj, charges) {
  const species = config.species;
  const ns = species.length;
  const H_molL = Math.pow(10, -pH);
  const OH_molL = Kw / H_molL;
  let sum_mM = 1000 * (H_molL + OH_molL);
  for (let i = 0; i < ns; i++) {
    const sp = species[i];
    const c = y_mM[i];
    const z = sp.charge || 0;
    if (sp.role === 'baseExcess') {
      if (charges && i < charges.length) charges[i] = z;
      continue;
    }
    if (!(c > 0) || (z === 0 && !sp.bufferPkas)) {
      if (charges && i < charges.length) charges[i] = z;
      continue;
    }
    if (sp.bufferPkas && sp.bufferPkas.length > 0) {
      evalLadderSpecies(sp, pH, I_molL, T_C, lg1, tj);
      sum_mM += LADDER.z2bar * c;
      if (charges && i < charges.length) charges[i] = LADDER.zbar;
    } else {
      sum_mM += z * z * c;
      if (charges && i < charges.length) charges[i] = z;
    }
  }
  return 0.5 * sum_mM / 1000;
}

/**
 * Solve the pH of a species vector.
 *
 * Bisection on pH in [0, 14], 50 iterations, inside an outer ionic-strength fixed-point loop
 * (max 20 passes, tolerance 1e-7 mol/L). The residual is decreasing in pH, so the bracket is
 * unconditional. Cost target < 60 us (§6.6); typical convergence is 3-4 outer passes.
 *
 * MUTATES AND RETURNS `out`. ALLOCATES NOTHING — this runs at 20 Hz from skid/sensors.js.
 *
 * On return, `scratch.charges[i]` holds the mean charge of species `i` at the solved pH — that
 * array is exactly the `speciation.zbar` that `chem/solution.js::kappa25_mScm` and
 * `::ionicStrength_molL` consume, so the caller may pass `{ zbar: scratch.charges }` straight on.
 *
 * @param {object} config frozen config; reads `config.species` and `config.chem`
 *                        (`Kw`, `daviesA`, `daviesIeMax`)
 * @param {Float64Array} y_mM species vector, length config.ns, mM
 * @param {number} T_C temperature, degC
 * @param {{tj:Float64Array, charges:Float64Array}} scratch caller-owned scratch
 *        (`tj` length >= 8, `charges` length >= config.ns)
 * @param {{pH:number, I_molL:number, iterations:number}} out caller-owned result object
 * @returns {typeof out} `out`, with pH (dimensionless), I_molL (mol/L) and the outer-loop
 *          iteration count
 */
export function solvePH(config, y_mM, T_C, scratch, out) {
  const chem = config.chem || {};
  const Kw = chem.Kw === undefined ? KW_DEFAULT : chem.Kw;
  const A = chem.daviesA === undefined ? 0.509 : chem.daviesA;
  const IeMax = chem.daviesIeMax === undefined ? 0.39 : chem.daviesIeMax;
  const tj = scratch.tj;
  const charges = scratch.charges;

  // Seed I from the frozen ionisedFraction of §5.8.1 — one outer pass cheaper than starting at 0.
  const species = config.species;
  const ns = species.length;
  let seed_mM = 0;
  for (let i = 0; i < ns; i++) {
    const c = y_mM[i];
    if (!(c > 0)) continue;
    const sp = species[i];
    if (sp.role === 'baseExcess') continue;
    const z = Math.abs(sp.charge || 0);
    if (z === 0) continue;
    const f = sp.ionisedFraction === undefined ? 1 : sp.ionisedFraction;
    seed_mM += c * z * z * f;
  }
  let I_molL = 0.5 * seed_mM / 1000;

  let pH = 7;
  let passes = 0;
  for (let pass = 0; pass < 20; pass++) {
    passes = pass + 1;
    const lg1 = daviesLg1(I_molL, A, IeMax);
    let lo = 0;
    let hi = 14;
    // Residual is monotonically DECREASING in pH: positive at pH 0, negative at pH 14.
    if (chargeResidual_mM(config, y_mM, lo, I_molL, T_C, Kw, lg1, tj, null) <= 0) {
      pH = lo;
    } else if (chargeResidual_mM(config, y_mM, hi, I_molL, T_C, Kw, lg1, tj, null) >= 0) {
      pH = hi;
    } else {
      for (let k = 0; k < 50; k++) {
        const mid = 0.5 * (lo + hi);
        if (chargeResidual_mM(config, y_mM, mid, I_molL, T_C, Kw, lg1, tj, null) > 0) lo = mid;
        else hi = mid;
      }
      pH = 0.5 * (lo + hi);
    }
    const Inew = ionicStrengthAt_molL(config, y_mM, pH, I_molL, T_C, Kw, lg1, tj, charges);
    const dI = Inew - I_molL;
    I_molL = Inew;
    if ((dI < 0 ? -dI : dI) < 1e-7) break;
  }

  out.pH = pH;
  out.I_molL = I_molL;
  out.iterations = passes;
  return out;
}

// ---------------------------------------------------------------------------------------------
// THE PREPARATION-TIME COUNTER-ION SOLVE
// ---------------------------------------------------------------------------------------------

/**
 * Resolve one `buffers[]` entry to a ladder definition. Order: inline pKas, explicit
 * `bufferId` in BUFFER_LIBRARY, the species registry's own `bufferPkas`, then BUFFER_LIBRARY
 * keyed by `speciesId` (which is what lets a test solve `tris` or `phosphate` against a config
 * whose registry only knows acetate).
 * @private
 */
function resolveBufferDef(config, entry) {
  if (entry.pKas && entry.pKas.length > 0) return entry;
  const explicit = entry.bufferId || entry.buffer;
  if (explicit && BUFFER_LIBRARY[explicit]) return BUFFER_LIBRARY[explicit];
  const idx = speciesIndex(config, entry.speciesId);
  if (idx >= 0) {
    const sp = config.species[idx];
    if (sp.bufferPkas && sp.bufferPkas.length > 0) {
      return {
        pKas: sp.bufferPkas, z0: sp.bufferZ0 || 0,
        dpKadT: sp.bufferDpKadT || 0, cEmp: sp.bufferCEmp || 0,
      };
    }
  }
  if (entry.speciesId && BUFFER_LIBRARY[entry.speciesId]) return BUFFER_LIBRARY[entry.speciesId];
  return null;
}

/** True when the species (or ion id) named by `saltTarget.ion` is a cation. Defaults to true. */
function saltIonIsCation(config, ion) {
  const idx = speciesIndex(config, ion);
  if (idx >= 0) {
    const z = config.species[idx].charge || 0;
    if (z !== 0) return z > 0;
  }
  return ion !== 'Cl';
}

/**
 * How much strong titrant a buffer needs to sit at `targetPH` — the recipe solve (§8.2).
 *
 * Bisects the NET strong-ion charge `t` (mM, positive = strong base cation added) against the
 * charge balance evaluated at the FIXED target pH, re-deriving the ionic strength — and hence
 * every pKa' — inside every residual evaluation. 90 bisection steps over [-10, +10] mol/L,
 * which is machine precision long before it ends. Preparation time only: never call this from
 * the tick path.
 *
 * THE SOLVE IS DAVIES-CORRECTED (§11 C-28) — the zero-activity answers (31.73 / 27.74 mM) are
 * wrong and must not reappear.
 *
 * NOTE-A — the water term is DELIBERATELY absent from this charge balance (`solvePH`, which
 * must handle 0.5 M NaOH, carries it in full). §7.2.4 requires every tank vector to be EXACTLY
 * charge balanced in strong-ions-plus-buffer terms, because that is what makes the Donnan group
 * sums satisfy C = A (Buffer A: Na 50.000 = Cl 13.986 + ionised acetate 36.014). Carrying
 * 1000*([H+]-[OH-]) here would shift the titrant by the 0.01 mM of free proton at pH 5 and
 * break that identity. Every shipped buffer sits between pH 3.8 and 9.0, where the omitted term
 * is below 0.01 mM. It is also what reproduces the contract's 36.014 / 13.986 / 38.243 exactly;
 * the standalone 50 mM acetate anchor then lands at 35.542 against the printed 35.532.
 * THE PRINTED 35.532 IS A CONTRACT ERROR, not a tolerance: the 0.009917 mM gap is exactly the
 * omitted 1000*([H+] - [OH-]) = 0.0100 mM at pH 5.00, so 35.532 is the answer to the charge
 * balance §7.2.4 forbids. §6.6 cannot have both that anchor and §7.2.4's exactness guarantee;
 * the anchor is the one to reprint (tests/chem.test.js C-28 carries the derivation).
 *
 * @param {object} config frozen config; reads `config.species`, `config.idxById`, `config.chem`
 * @param {{buffers:Array<{speciesId:string, total_mM:number, bufferId?:string, pKas?:number[]}>,
 *          organic_frac?:number, strongBase_mM?:number, strongAcid_mM?:number,
 *          saltTarget?:{ion:string, total_mM:number}}} bufferSpec the tank composition
 * @param {number} targetPH target pH, dimensionless
 * @param {number} T_C preparation temperature, degC
 * @param {{cation_mM:number, anion_mM:number, I_molL:number, pH:number}} out caller-owned result
 * @returns {typeof out} `out`: `cation_mM` is the strong BASE (e.g. NaOH) titrant required,
 *          `anion_mM` the strong ACID (e.g. HCl) titrant required — exactly one is non-zero;
 *          `I_molL` is the converged ionic strength of the finished buffer; `pH` echoes the target
 */
export function solveCounterIon(config, bufferSpec, targetPH, T_C, out) {
  const chem = config.chem || {};
  const A = chem.daviesA === undefined ? 0.509 : chem.daviesA;
  const IeMax = chem.daviesIeMax === undefined ? 0.39 : chem.daviesIeMax;
  const Kw = chem.Kw === undefined ? KW_DEFAULT : chem.Kw;
  const buffers = bufferSpec.buffers || [];
  const strongBase_mM = bufferSpec.strongBase_mM || 0;
  const strongAcid_mM = bufferSpec.strongAcid_mM || 0;
  const salt = bufferSpec.saltTarget || null;
  const saltTotal_mM = salt && Number.isFinite(salt.total_mM) ? salt.total_mM : 0;
  const saltOnCation = salt ? saltIonIsCation(config, salt.ion) : true;

  out.cation_mM = 0;
  out.anion_mM = 0;
  out.I_molL = 0;
  out.pH = targetPH;
  if (buffers.length === 0) {
    // Nothing to titrate. The ionic strength still reflects any strong base/acid and salt.
    const strong_mM = strongBase_mM + strongAcid_mM;
    out.I_molL = 0.5 * (2 * Math.max(saltTotal_mM, strong_mM)) / 1000;
    return out;
  }

  // Resolve the ladders once (preparation time — allocation is permitted here).
  const defs = [];
  const totals_mM = [];
  for (let b = 0; b < buffers.length; b++) {
    const def = resolveBufferDef(config, buffers[b]);
    if (def === null) continue;
    defs.push(def);
    totals_mM.push(buffers[b].total_mM || 0);
  }
  if (defs.length === 0) return out;

  const H_molL = Math.pow(10, -targetPH);
  const OH_molL = Kw / H_molL;
  const water2_mM = 1000 * (H_molL + OH_molL);   // z^2-weighted water term for I only
  const tj = SCRATCH.tj;

  // residual(t) = t + SUM(zbar_b * total_b) + strongBase - strongAcid, with I = I(t).
  // Monotonically increasing in t, so plain bisection is unconditional.
  let lo = TITRANT_LO_mM;
  let hi = TITRANT_HI_mM;
  let t_mM = 0;
  let I_molL = 0;
  let net_mM = 0;
  for (let k = 0; k < 90; k++) {
    t_mM = 0.5 * (lo + hi);
    // Strong-ion inventory implied by this titrant plus the neutral-salt top-up.
    const titrantCation_mM = t_mM > 0 ? t_mM : 0;
    const titrantAnion_mM = t_mM < 0 ? -t_mM : 0;
    let cation_mM = titrantCation_mM + strongBase_mM;
    let anion_mM = titrantAnion_mM + strongAcid_mM;
    if (salt !== null) {
      const topUp = saltOnCation ? saltTotal_mM - cation_mM : saltTotal_mM - anion_mM;
      if (topUp > 0) { cation_mM += topUp; anion_mM += topUp; }
    }
    // INNER FIXED POINT on the ionic strength. It must be iterated to convergence, not
    // estimated once: the buffer's own z^2 contribution is 63 % of I for 20 mM phosphate at
    // pH 7, and a single pass leaves I at 0.0410 instead of 0.04281 and the answer at
    // 31.349 mM instead of the contract's 31.406 mM.
    const strong2_mM = cation_mM + anion_mM + water2_mM;
    I_molL = 0.5 * strong2_mM / 1000;
    for (let pass = 0; pass < 16; pass++) {
      const lg1p = daviesLg1(I_molL, A, IeMax);
      let sum2_mM = strong2_mM;
      for (let b = 0; b < defs.length; b++) {
        evalLadder(defs[b], targetPH, I_molL, T_C, lg1p, tj);
        sum2_mM += LADDER.z2bar * totals_mM[b];
      }
      const Inew = 0.5 * sum2_mM / 1000;
      const dI = Inew - I_molL;
      I_molL = Inew;
      if ((dI < 0 ? -dI : dI) < 1e-10) break;
    }
    // Net buffer charge at the converged ionic strength.
    const lg1 = daviesLg1(I_molL, A, IeMax);
    net_mM = 0;
    for (let b = 0; b < defs.length; b++) {
      evalLadder(defs[b], targetPH, I_molL, T_C, lg1, tj);
      net_mM += LADDER.zbar * totals_mM[b];
    }
    const r = t_mM + net_mM + strongBase_mM - strongAcid_mM;
    if (r > 0) hi = t_mM; else lo = t_mM;
  }

  out.cation_mM = t_mM > 0 ? t_mM : 0;
  out.anion_mM = t_mM < 0 ? -t_mM : 0;
  out.I_molL = I_molL;
  out.pH = targetPH;
  return out;
}

// ---------------------------------------------------------------------------------------------
// TANK VECTORS
// ---------------------------------------------------------------------------------------------

/** Module-owned out object for the counter-ion solve inside `buildTankVector`. */
const CI_OUT = { cation_mM: 0, anion_mM: 0, I_molL: 0, pH: 7 };

/**
 * Build a tank's species vector from its authored composition, solving the recipe (§8.2).
 *
 * The buffer totals go in as authored; the strong titrant is SOLVED (never stored); the neutral
 * salt top-up is either supplied by the caller as `saltNaCl_mM` (the §8.2 two-step, where
 * `normalizePreset` computes `saltTarget.total_mM - r.cation_mM` itself) or derived here from
 * `saltTarget` when it is absent. Strong base is placed as counter-cation PLUS the baseExcess
 * species, which is what carries hydroxide conductivity while the pH solve derives the same
 * hydroxide from the water equilibrium (see `chargeResidual_mM`).
 *
 * THIS IS ALSO WHERE `ionisedFraction` (§5.8.1) IS DERIVED: after the vector is complete the pH
 * is re-solved and every buffer species' ionised fraction is written back onto its
 * SpeciesConfig, unless that object is already frozen. Acetate at pH 5.00 with pKa' 4.5892
 * gives 0.72028, i.e. 50 mM AcT contributes 36.014 mM of co-ion equivalent (§7.2.4).
 *
 * @param {object} config config under construction (not yet frozen at ingest)
 * @param {{buffers?:Array<{speciesId:string,total_mM:number}>, targetPH?:number|null,
 *          counterCation?:string, counterAnion?:string,
 *          saltTarget?:{ion:string,total_mM:number}, saltNaCl_mM?:number,
 *          organic_frac?:number, strongBase_mM?:number, strongAcid_mM?:number,
 *          species?:Object<string,number>, proteins_gL?:Object<string,number>}} tankComposition
 *        authored composition; `species` (mM) and `proteins_gL` (g/L) are optional additive
 *        extras, which is how a feed tank carries its proteins
 * @param {number} [T_C=25] preparation temperature, degC
 * @returns {Float64Array} a NEW vector of length `config.ns`, mM
 */
export function buildTankVector(config, tankComposition, T_C = 25) {
  const ns = config.ns === undefined ? config.species.length : config.ns;
  const y_mM = new Float64Array(ns);
  const comp = tankComposition || {};
  const buffers = comp.buffers || [];
  const cationId = comp.counterCation || 'Na';
  const anionId = comp.counterAnion || 'Cl';
  const iCation = speciesIndex(config, cationId);
  const iAnion = speciesIndex(config, anionId);

  // 1. Buffer totals.
  for (let b = 0; b < buffers.length; b++) {
    const idx = speciesIndex(config, buffers[b].speciesId);
    if (idx >= 0) y_mM[idx] += buffers[b].total_mM || 0;
  }

  // 2. Organic (volume fraction -> mM through the species' own molar mass).
  const organic_frac = comp.organic_frac || 0;
  if (organic_frac > 0) {
    for (let i = 0; i < ns; i++) {
      if (config.species[i].role === 'organic') {
        const MW = config.species[i].MW_gmol || 46.07;
        y_mM[i] += organic_frac * 1000 * ETHANOL_DENSITY_gmL * 1000 / MW;
        break;
      }
    }
  }

  // 3. The solved titrant.
  let titrantCation_mM = 0;
  let titrantAnion_mM = 0;
  if (comp.targetPH !== null && comp.targetPH !== undefined && buffers.length > 0) {
    solveCounterIon(config, comp, comp.targetPH, T_C, CI_OUT);
    titrantCation_mM = CI_OUT.cation_mM;
    titrantAnion_mM = CI_OUT.anion_mM;
    if (iCation >= 0) y_mM[iCation] += titrantCation_mM;
    if (iAnion >= 0) y_mM[iAnion] += titrantAnion_mM;
  }

  // 4. Strong base / strong acid. Strong base also fills the baseExcess species (OHex), which
  //    is what carries hydroxide CONDUCTIVITY; the pH solve gets the same OH- from water.
  const strongBase_mM = comp.strongBase_mM || 0;
  const strongAcid_mM = comp.strongAcid_mM || 0;
  if (strongBase_mM > 0) {
    if (iCation >= 0) y_mM[iCation] += strongBase_mM;
    for (let i = 0; i < ns; i++) {
      if (config.species[i].role === 'baseExcess') { y_mM[i] += strongBase_mM; break; }
    }
  }
  if (strongAcid_mM > 0 && iAnion >= 0) y_mM[iAnion] += strongAcid_mM;

  // 5. Neutral salt top-up.
  let salt_mM = 0;
  if (Number.isFinite(comp.saltNaCl_mM)) {
    salt_mM = comp.saltNaCl_mM;
  } else if (comp.saltTarget && Number.isFinite(comp.saltTarget.total_mM)) {
    const onCation = saltIonIsCation(config, comp.saltTarget.ion);
    const placed = onCation ? titrantCation_mM + strongBase_mM
      : titrantAnion_mM + strongAcid_mM;
    salt_mM = comp.saltTarget.total_mM - placed;
  }
  if (salt_mM > 0) {
    if (iCation >= 0) y_mM[iCation] += salt_mM;
    if (iAnion >= 0) y_mM[iAnion] += salt_mM;
  }

  // 6. Explicit extras (proteins, tracers).
  if (comp.species) {
    for (const id in comp.species) {
      const idx = speciesIndex(config, id);
      if (idx >= 0) y_mM[idx] += comp.species[id] || 0;
    }
  }
  if (comp.proteins_gL) {
    for (const id in comp.proteins_gL) {
      const idx = speciesIndex(config, id);
      if (idx >= 0) {
        const MW = config.species[idx].MW_gmol || 1;
        y_mM[idx] += (comp.proteins_gL[id] || 0) * 1000 / MW;   // g/L -> mM  (R-U3)
      }
    }
  }

  // 7. Derive ionisedFraction from the solved pH and the Davies-adjusted ladder (§5.8.1).
  //    WHICH pH: the recipe's own `targetPH` when the tank was titrated, otherwise the pH this
  //    vector actually solves to. They differ by 4e-4 pH here, because `solvePH` carries the
  //    water term and the recipe solve deliberately does not (NOTE-A). Using the recipe pH is
  //    what keeps §7.2.4's Donnan group sums EXACTLY balanced — Buffer A's C = Na = 50.000 and
  //    A = Cl 13.986 + 50*0.72028 = 50.000 — which the contract states as a guarantee and the
  //    isotherm test asserts. Taking the 5.0004 solved value instead moves the co-ion sum by
  //    0.010 mM and 0.72028 to 0.72048.
  solvePH(config, y_mM, T_C, SCRATCH, PH_OUT);
  const titrated = comp.targetPH !== null && comp.targetPH !== undefined && buffers.length > 0;
  const fracPH = titrated ? comp.targetPH : PH_OUT.pH;
  const fracI_molL = titrated ? CI_OUT.I_molL : PH_OUT.I_molL;
  const lg1 = daviesLg1(fracI_molL,
    config.chem ? config.chem.daviesA : 0.509,
    config.chem ? config.chem.daviesIeMax : 0.39);
  for (let i = 0; i < ns; i++) {
    const sp = config.species[i];
    if (!sp.bufferPkas || sp.bufferPkas.length === 0) continue;
    if (!(y_mM[i] > 0)) continue;
    if (Object.isFrozen(sp)) continue;         // §2.3: never write through a frozen config
    evalLadderSpecies(sp, fracPH, fracI_molL, T_C, lg1, SCRATCH.tj);
    const z = sp.charge || 0;
    sp.ionisedFraction = z !== 0
      ? clamp(Math.abs(LADDER.zbar / z), 0, 1)
      : clamp(1 - LADDER.f0, 0, 1);
  }

  return y_mM;
}

/**
 * Mirror of §6.5's `kappa25_mScm` for `describeTank` only.
 * `chem/ph.js` may not import `chem/solution.js` (manifest `depends_on`, and §14 builds this
 * file first), so the formula is restated here against the SOLVED speciation:
 *   kappa25 = Fr(I) * SUM(lambda0_i*|zbar_i|*c_i) * f_cal * max(0.05, 1 - 1.4*f_org),
 *   Fr(I) = lambdaNaCl(min(I,5))/126.4.
 * If §6.5's formula ever changes, this function changes with it.
 * @private
 */
function kappaMirror_mScm(config, y_mM, I_molL, charges) {
  const species = config.species;
  const ns = species.length;
  let sum = 0;
  let organic_gL = 0;
  let base_mM = 0;
  for (let i = 0; i < ns; i++) {
    const c = y_mM[i];
    if (!(c > 0)) continue;
    const sp = species[i];
    if (sp.role === 'organic') { organic_gL += c * sp.MW_gmol / 1000; continue; }
    let zAbs = Math.abs(i < charges.length ? charges[i] : (sp.charge || 0));
    if (!Number.isFinite(zAbs)) zAbs = Math.abs(sp.charge || 0);
    if (zAbs === 0) continue;
    sum += (sp.lambda0_Scm2eq || 0) * zAbs * c;
    if (sp.role === 'baseExcess') base_mM += c * zAbs;
  }
  const x = Math.sqrt(Math.min(I_molL > 0 ? I_molL : 0, 5));
  const lam = 126.4 - 82.8623 * x + 76.7090 * x * x - 43.6797 * x * x * x + 8.4686 * x * x * x * x;
  const Fr = lam / 126.4;
  const fOrg = organic_gL / (1000 * ETHANOL_DENSITY_gmL);
  // The CAL_TABLE NaOH knots of §6.5, with the implicit (0, 1.0) anchor.
  const cB = base_mM / 1000;
  let fCal = 1.0;
  if (cB > 1e-9) {
    const cs = [0, 0.1, 0.5, 1.0];
    const fs = [1.0, 1.0517, 1.185, 1.138];
    fCal = fs[3];
    for (let k = 1; k < cs.length; k++) {
      if (cB <= cs[k]) {
        fCal = fs[k - 1] + (fs[k] - fs[k - 1]) * (cB - cs[k - 1]) / (cs[k] - cs[k - 1]);
        break;
      }
    }
  } else if (fOrg > 0.02) {
    fCal = 0.72;
  }
  return Fr * (sum / 1000) * fCal * Math.max(0.05, 1 - 1.4 * fOrg);
}

/**
 * Human-readable summary of a tank vector: what the operator would measure if they dipped a
 * pH probe and a conductivity cell into it. Allocates its return object — it is a description
 * helper for the UI, presets validation and tests, never a tick-path function.
 *
 * @param {object} config frozen config
 * @param {Float64Array} y_mM species vector, mM
 * @param {number} T_C temperature, degC
 * @returns {{pH:number, kappa25_mScm:number, I_molL:number, Na_mM:number, Cl_mM:number}}
 *          pH dimensionless, conductivity at 25 C in mS/cm, ionic strength in mol/L,
 *          sodium and chloride in mM (0 when the registry has no such species)
 */
export function describeTank(config, y_mM, T_C) {
  solvePH(config, y_mM, T_C, SCRATCH, PH_OUT);
  const iNa = speciesIndex(config, 'Na');
  const iCl = speciesIndex(config, 'Cl');
  return {
    pH: PH_OUT.pH,
    kappa25_mScm: kappaMirror_mScm(config, y_mM, PH_OUT.I_molL, SCRATCH.charges),
    I_molL: PH_OUT.I_molL,
    Na_mM: iNa >= 0 ? y_mM[iNa] : 0,
    Cl_mM: iCl >= 0 ? y_mM[iCl] : 0,
  };
}

/**
 * The alkaline (sodium) error of a glass pH electrode — a NEGATIVE offset, so the electrode
 * READS LOW in strong base.
 *   pH > 12 && cNa > 0.1 mol/L :  -k * (pH - 12) * log10(cNa/0.1)
 *   otherwise                  :  0
 *
 * `config.chem.sodiumErrorK = 0.673` is calibrated against the water convention at the top of
 * this file: 0.5 M NaOH is truly pH 13.699 and the error -0.673*1.699*log10(5) = -0.799 makes
 * the electrode read exactly 12.900 (§11 C-08).
 *
 * @param {object} config frozen config; reads `config.chem.sodiumErrorK`
 * @param {number} pH true pH, dimensionless
 * @param {number} cNa_molL sodium concentration, mol/L
 * @returns {number} pH offset to ADD to the true pH, dimensionless and <= 0
 */
export function sodiumError(config, pH, cNa_molL) {
  if (!(pH > 12) || !(cNa_molL > 0.1)) return 0;
  const k = config.chem && config.chem.sodiumErrorK !== undefined
    ? config.chem.sodiumErrorK : 0.673;
  return -k * (pH - 12) * Math.log10(cNa_molL / 0.1);
}
