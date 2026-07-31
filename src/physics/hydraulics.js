/**
 * src/physics/hydraulics.js — owner `physics-hydraulics` (architecture-v2 §6.10, §7.1).
 *
 * Blake–Kozeny bed pressure drop, the bed-compression fixed point, the column-average mixture
 * viscosity/density assembly, and the hardware (frit) + inline-filter resistances.
 *
 * Layer L2: imports `core/util.js` and `chem/solution.js` only, and nothing else — never `skid/*`,
 * never `physics/bed.js`. No DOM, no `window`, no `document`: this file must import cleanly under
 * `node --test`.
 *
 * UNITS (§1.1): every argument and every return value is canonical — cm, cm/s, cP, g/mL, bar, mL/s.
 * The only SI excursion is inside `dpInertial_bar`, where the Burke–Plummer correlation is published
 * in Pa; the conversion is folded into the leading constant and never crosses the boundary (R-U2).
 *
 * THE ONE RULE THIS FILE EXISTS TO PROTECT: bed compression affects PRESSURE DROP ONLY. Nothing here
 * writes `col.epsC`, and `run.epsCompressed` is a hydraulic/diagnostic field, never a transport
 * porosity. Feeding a compressed porosity back into the column would silently move every retention
 * volume and break the mass audit (§6.10, §11 C-34).
 */

import { clamp } from '../core/util.js';
import { mixtureViscosity_cP, density_gmL } from '../chem/solution.js';

// --------------------------------------------------------------------------------------------
// Module constants (§7.1.3). Const tables only — no top-level side effects.
// --------------------------------------------------------------------------------------------

/** Damping factor of the compression fixed-point iteration. Normative: w = 0.5 (§7.1.3). */
const COMPRESSION_W = 0.5;

/** Relative convergence tolerance of the compression fixed point. Normative: 1e-6 (§7.1.3). */
const COMPRESSION_RTOL = 1e-6;

/** Hard iteration cap of the compression fixed point. Normative: 20 (§7.1.3). */
const COMPRESSION_MAX_ITER = 20;

/** Bed-collapse declaration threshold, bar (§7.1.3). Above this the packing is mechanically gone. */
const BED_COLLAPSE_BAR = 20.0;

/* The reference viscosity of every correlation quoted here is 1.002 cP — water at 20 °C (§7.1.2).
 * It is the basis of `rFrit`, of `Rdown` and of every Blake–Kozeny verification point below. The
 * constant itself is NOT declared here: the only expression that uses it is
 * `P2 = Rdown * Q * (mu/1.002)`, which is assembled by skid/sensors.js::updatePressure (§6.14) on
 * its own side of the boundary. */

/**
 * Module-owned singleton returned by `solveCompression`.
 *
 * `updateHydraulics` runs at 20 Hz, so a fresh object per call would be 72 000 allocations an hour
 * and would break DoD item 5 (heap growth < 64 kB over 10 000 ticks). Callers MUST read the fields
 * immediately and MUST NOT retain the object — the next `solveCompression` call overwrites it.
 * This is the same discipline as `requestColumnValve`'s two result singletons and `stepColumn`'s
 * `StepResult` (§0, §13 item 5).
 */
const COMPRESSION_RESULT = { dp_bar: 0, eps: 0, iterations: 0, collapsed: false };

/**
 * Module-owned scratch for the column-average composition vector, length `config.ns`.
 * Reallocated only when `ns` changes (i.e. on a config rebuild, §2.4), never per tick.
 */
const MEAN_Y = { y_mM: /** @type {Float64Array|null} */ (null), ns: -1 };

/**
 * Module-owned argument record for `dpBed_bar`, so tick step 9 does not allocate an object literal
 * every 50 ms. `dpBed_bar`'s destructured signature is mandated by the manifest; this is how
 * `updateHydraulics` calls it without allocating.
 */
const BED_ARGS = { kKozeny: 0, mu_cP: 0, u_cms: 0, L_cm: 0, eps: 0, dp_cm: 0 };

// --------------------------------------------------------------------------------------------
// Private helpers
// --------------------------------------------------------------------------------------------

/**
 * Species-registry length of a config, tolerant of a partially-built config.
 * @param {object} config canonical frozen config (§2.1)
 * @returns {number} `config.ns`, or `config.species.length`, or 0
 */
function registryLength(config) {
  if (config && Number.isFinite(config.ns)) return config.ns | 0;
  if (config && config.species && config.species.length) return config.species.length | 0;
  return 0;
}

/**
 * Axial-mean INTERSTITIAL composition of the packed bed, mapped from COLUMN index order back into
 * SPECIES registry order through `config.skidIdxOf` (§1.2).
 *
 * `col.c` is species-major / cell-minor (`idx = j*nz + n`, §6.9), so this is one contiguous sweep
 * per transported species. Non-transported species (and every species when the column has not been
 * built yet) are left at 0 mM — they are not in the bed and cannot contribute to its viscosity.
 *
 * Zero allocation after the first call: the result is the module-owned `MEAN_Y.y_mM` scratch, which
 * is fully overwritten on every call. The caller must read it before the next call.
 *
 * DECISION (contract is silent): the bed's viscosity is evaluated at the MEAN COMPOSITION, not as
 * the mean of the per-cell viscosities. `mixtureViscosity_cP` is mildly non-linear in c, so the two
 * differ by well under a percent on any composition this preset produces, while the per-cell form
 * would cost `nz` (400) viscosity evaluations every tick and blow the 0.25 ms/tick budget of §2.1.1
 * on its own.
 *
 * @param {object} config canonical config (§2.1); reads `ns` and `skidIdxOf`
 * @param {object|null} col a `Column` (§6.9), or null before `createSkid`
 * @returns {Float64Array} module scratch, length `config.ns`, concentrations in mM
 */
function columnMeanComposition_mM(config, col) {
  const ns = registryLength(config);
  if (MEAN_Y.ns !== ns || MEAN_Y.y_mM === null) {
    MEAN_Y.y_mM = new Float64Array(ns);
    MEAN_Y.ns = ns;
  }
  const y_mM = MEAN_Y.y_mM;
  y_mM.fill(0);
  if (ns === 0 || !col || !col.c) return y_mM;

  const nz = col.nz | 0;
  const nsCol = col.nsCol | 0;
  if (nz <= 0 || nsCol <= 0) return y_mM;

  const c = col.c;
  const skidIdxOf = config.skidIdxOf;
  const invNz = 1 / nz;
  for (let j = 0; j < nsCol; j++) {
    const base = j * nz;
    let sum = 0;
    for (let n = 0; n < nz; n++) sum += c[base + n];
    const i = skidIdxOf ? skidIdxOf[j] : j;
    if (i >= 0 && i < ns) y_mM[i] = sum * invNz;
  }
  return y_mM;
}

/** Module-owned singleton filled by `compressionOf`. Read immediately; never retain (§13 item 5). */
const CMP = { enabled: false, eps0: 0.35, epsMin: 0.35, Pc_bar: Infinity };

/**
 * Resolve the compression sub-object of a column config into the module-owned `CMP` singleton, with
 * safe fallbacks (`eps0` falls back to `colCfg.epsC`, `epsMin` to `eps0`, an absent or non-positive
 * `Pc_bar` to Infinity, which makes `epsAtPressure` a no-op).
 *
 * Allocation-free: it mutates and returns `CMP`. Callers must copy out any value they need across
 * another `compressionOf` / `solveCompression` call.
 *
 * @param {object} colCfg `config.column` (or a `createColumn` cfg, which spreads it)
 * @returns {{enabled:boolean, eps0:number, epsMin:number, Pc_bar:number}} the `CMP` singleton
 */
function compressionOf(colCfg) {
  const cmp = colCfg && colCfg.compression ? colCfg.compression : null;
  const eps0 = cmp && Number.isFinite(cmp.eps0)
    ? cmp.eps0
    : (colCfg && Number.isFinite(colCfg.epsC) ? colCfg.epsC : 0.35);
  CMP.enabled = !!(cmp && cmp.enabled);
  CMP.eps0 = eps0;
  CMP.epsMin = cmp && Number.isFinite(cmp.epsMin) ? cmp.epsMin : eps0;
  CMP.Pc_bar = cmp && Number.isFinite(cmp.Pc_bar) && cmp.Pc_bar > 0 ? cmp.Pc_bar : Infinity;
  return CMP;
}

/**
 * The Blake–Kozeny porosity group `F(e) = (1-e)^2 / e^3`.
 * @param {number} eps bed void fraction, dimensionless
 * @returns {number} F(eps), dimensionless
 */
function porosityGroup(eps) {
  if (!(eps > 0)) return Infinity;
  const oneMinus = 1 - eps;
  return (oneMinus * oneMinus) / (eps * eps * eps);
}

/**
 * The compression constitutive law `eps(dP) = eps0 - (eps0 - epsMin)*dP/(dP + Pc)` (§7.1.3).
 * @param {number} dp_bar bed pressure drop, bar
 * @param {number} eps0 uncompressed void fraction, dimensionless
 * @param {number} epsMin fully-compressed void fraction, dimensionless
 * @param {number} Pc_bar characteristic compression pressure, bar
 * @returns {number} void fraction, dimensionless, clamped to [epsMin, eps0]
 */
function epsAtPressure(dp_bar, eps0, epsMin, Pc_bar) {
  if (!(dp_bar > 0) || !Number.isFinite(Pc_bar)) return eps0;
  const eps = eps0 - (eps0 - epsMin) * (dp_bar / (dp_bar + Pc_bar));
  return clamp(eps, Math.min(epsMin, eps0), Math.max(epsMin, eps0));
}

// --------------------------------------------------------------------------------------------
// Exports
// --------------------------------------------------------------------------------------------

/**
 * Blake–Kozeny (laminar Ergun) pressure drop across a packed bed, pre-converted to canonical units
 * (§7.1.1):
 *
 *     dP_bar = 1e-8 * kKozeny * mu_cP * u_cms * L_cm * (1-eps)^2 / (eps^3 * dp_cm^2)
 *
 * The leading `1e-8` is the whole of the SI conversion (Pa·s→cP, m/s→cm/s, m→cm, Pa→bar); nothing
 * here converts across a module boundary (R-U2).
 *
 * `u_cms` is the SUPERFICIAL velocity `|Q_mLs| / A_cm2`, never the interstitial velocity. Using
 * `epsT = 0.9025` in place of `epsC = 0.35` yields 3.99e-4 bar on the VC-07 design point — a factor
 * of 762 too small (§7.1.6); the porosity argument must be the INTERSTITIAL void fraction.
 *
 * Verified: `{kK:180, mu:1.002, u:0.0416667 (150 cm/h), L:20, eps:0.35, dp:9.0e-3}` -> 0.18285066 bar
 * (the shipped pilot preset); `{kK:150, mu:1.000, u:0.0833333 (300 cm/h), ...}` -> 0.30414282 bar;
 * the same at `kK:180` -> 0.36497139 bar.
 *
 * The magnitude of `u_cms` is used, so a reversed column (`columnValve === 'UP'`) reports a positive
 * pressure drop rather than a negative one.
 *
 * @param {object} args
 * @param {number} args.kKozeny Kozeny constant, dimensionless (180 for the shipped resin)
 * @param {number} args.mu_cP dynamic viscosity, cP
 * @param {number} args.u_cms superficial velocity, cm/s (sign ignored)
 * @param {number} args.L_cm bed height, cm
 * @param {number} args.eps interstitial void fraction, dimensionless
 * @param {number} args.dp_cm particle diameter, cm
 * @returns {number} bed pressure drop, bar (0 for a degenerate geometry)
 */
export function dpBed_bar({ kKozeny, mu_cP, u_cms, L_cm, eps, dp_cm }) {
  if (!(eps > 0) || !(dp_cm > 0) || !(L_cm > 0)) return 0;
  const oneMinus = 1 - eps;
  return 1e-8 * kKozeny * mu_cP * Math.abs(u_cms) * L_cm *
    (oneMinus * oneMinus) / (eps * eps * eps * dp_cm * dp_cm);
}

/**
 * Burke–Plummer inertial (turbulent) contribution of the Ergun equation, pre-converted to bar.
 *
 *     dP_Pa  = 1.75 * (L/dp) * rho * u^2 * (1-eps)/eps^3        [SI]
 *     dP_bar = 1.75e-6 * (L_cm/dp_cm) * rho_gmL * u_cms^2 * (1-eps)/eps^3
 *
 * DEV WARNING ONLY (§6.10): the simulator's pressure model is Blake–Kozeny; this term exists so a
 * developer can assert that the inertial contribution is negligible at every legal flow. On the
 * VC-07 design point (`rho 0.9982, u 0.0833333, L 20, eps 0.35, dp 9.0e-3`) it is 4.0864e-4 bar
 * = 40.86 Pa, i.e. 0.13 % of the 0.304143 bar viscous term (§7.1.1). It is NEVER added to
 * `run.dPbed_bar`.
 *
 * @param {object} args
 * @param {number} args.rho_gmL density, g/mL
 * @param {number} args.u_cms superficial velocity, cm/s (squared, so sign-free)
 * @param {number} args.L_cm bed height, cm
 * @param {number} args.eps interstitial void fraction, dimensionless
 * @param {number} args.dp_cm particle diameter, cm
 * @returns {number} inertial pressure drop, bar (0 for a degenerate geometry)
 */
export function dpInertial_bar({ rho_gmL, u_cms, L_cm, eps, dp_cm }) {
  if (!(eps > 0) || !(dp_cm > 0) || !(L_cm > 0)) return 0;
  return 1.75e-6 * (L_cm / dp_cm) * rho_gmL * u_cms * u_cms * (1 - eps) / (eps * eps * eps);
}

/**
 * Particle Reynolds number, pre-converted (§7.3.1):
 *
 *     Re_p = 100 * rho_gmL * u_cms * dp_cm / mu_cP
 *
 * The `100` carries g/mL→kg/m³, cm/s→m/s, cm→m and cP→Pa·s together. Superficial velocity, as in
 * `dpBed_bar`. Verified: `rho 0.9982, u 0.0833333, dp 9.0e-3, mu 1.000` -> 0.074865 (§7.1.1).
 * Blake–Kozeny is valid while `Re_p < ~10`; the pilot preset runs three orders of magnitude below.
 *
 * @param {number} rho_gmL density, g/mL
 * @param {number} u_cms superficial velocity, cm/s (sign ignored)
 * @param {number} dp_cm particle diameter, cm
 * @param {number} mu_cP dynamic viscosity, cP
 * @returns {number} particle Reynolds number, dimensionless (0 if mu_cP <= 0)
 */
export function reynoldsParticle(rho_gmL, u_cms, dp_cm, mu_cP) {
  if (!(mu_cP > 0)) return 0;
  return 100 * rho_gmL * Math.abs(u_cms) * dp_cm / mu_cP;
}

/**
 * Kozeny–Carman bed permeability, cm²:
 *
 *     k_cm2 = eps^3 * dp_cm^2 / (kKozeny * (1-eps)^2)
 *
 * This is the exact inverse of `dpBed_bar`: `dP_bar = 1e-5 * (mu_cP*1e-3) * (u_cms/100) * (L_cm/100)
 * / (k_cm2*1e-4)` reproduces it identically. Verified: `eps 0.35, dp 9.0e-3, kKozeny 180`
 * -> 4.56656e-8 cm² = 4.56656e-12 m² (§7.1.1), which back-substitutes to the shipped 0.18285 bar at
 * 150 cm/h and mu = 1.002 cP.
 *
 * The porosity-scaling sub-assertion of VC-07 is a ratio of the inverse group:
 * `F(0.40)/F(0.35) = 0.570821006` (§7.1.5) — NOT 0.570874.
 *
 * @param {object} args
 * @param {number} args.eps interstitial void fraction, dimensionless
 * @param {number} args.dp_cm particle diameter, cm
 * @param {number} args.kKozeny Kozeny constant, dimensionless
 * @returns {number} permeability, cm² (0 for a degenerate geometry)
 */
export function permeability_cm2({ eps, dp_cm, kKozeny }) {
  if (!(eps > 0) || !(eps < 1) || !(dp_cm > 0) || !(kKozeny > 0)) return 0;
  const oneMinus = 1 - eps;
  return (eps * eps * eps * dp_cm * dp_cm) / (kKozeny * oneMinus * oneMinus);
}

/**
 * Solve the bed-compression fixed point (§7.1.3).
 *
 *     eps(dP) = eps0 - (eps0 - epsMin) * dP/(dP + Pc)
 *     dP  <-  (1-w)*dP + w * dP_rigid * F(eps)/F(eps0),   F(e) = (1-e)^2/e^3,  w = 0.5
 *     rtol 1e-6, at most 20 iterations, BED COLLAPSE declared above 20 bar
 *
 * The iteration starts at `dP = dP_rigid` and is damped, not Newton: the damping is normative so
 * that every implementation lands on the same number of significant figures.
 *
 * Verified against the shipped pilot column (`kK 180, mu 1.002 cP, L 20 cm, eps0 0.35, epsMin 0.26,
 * Pc 2.0 bar, dp 9.0e-3 cm`): 300 cm/h -> 0.443577 bar / eps 0.333663; 900 cm/h -> 1.855019 bar /
 * eps 0.306692; **ratio 4.1820**, inside the mandated `4.183 ± 0.5 %`. (The contract's printed
 * 0.443467 / 1.854864 pair differs in the 4th significant figure only; the earlier 0.442514 /
 * 1.850211 pair is not a fixed point of this equation at all and must not be reproduced.)
 * At 150 cm/h the rigid 0.182851 bar becomes 0.201394 bar at eps 0.341766 — the 0.2014 bar of §8.1.
 *
 * COMPRESSION AFFECTS PRESSURE DROP ONLY. The returned `eps` is a hydraulic porosity for reporting
 * and for the next pressure evaluation; it must NEVER be written back into `col.epsC`, because
 * retention, the interstitial volume and therefore the whole mass audit are computed at the frozen
 * `epsC` (§6.10, §11 C-34).
 *
 * ZERO ALLOCATION: returns the module-owned `COMPRESSION_RESULT` singleton. Read its fields
 * immediately; never retain the object across another call.
 *
 * @param {object} colCfg a column config — `config.column` or any object spreading it. Reads
 *   `compression:{enabled, eps0, epsMin, Pc_bar}` and falls back to `epsC` for `eps0`.
 * @param {number} dpRigid_bar the UNCOMPRESSED bed pressure drop at `eps0`, bar, i.e.
 *   `dpBed_bar({..., eps: compression.eps0})`
 * @returns {{dp_bar:number, eps:number, iterations:number, collapsed:boolean}} module singleton:
 *   `dp_bar` compressed bed pressure drop in bar, `eps` the converged void fraction
 *   (dimensionless), `iterations` the number of damped passes performed, `collapsed` true once
 *   `dp_bar` exceeds 20 bar
 */
export function solveCompression(colCfg, dpRigid_bar) {
  const cmp = compressionOf(colCfg);
  // Copy out of the CMP singleton immediately — these are the only four values needed.
  const enabled = cmp.enabled;
  const eps0 = cmp.eps0;
  const epsMin = cmp.epsMin;
  const Pc_bar = cmp.Pc_bar;

  const out = COMPRESSION_RESULT;
  const dpRigid = Number.isFinite(dpRigid_bar) && dpRigid_bar > 0 ? dpRigid_bar : 0;

  if (!enabled || dpRigid === 0) {
    out.dp_bar = dpRigid;
    out.eps = eps0;
    out.iterations = 0;
    out.collapsed = dpRigid > BED_COLLAPSE_BAR;
    return out;
  }

  const F0 = porosityGroup(eps0);
  let dp = dpRigid;
  let eps = eps0;
  let iterations = 0;

  for (let k = 0; k < COMPRESSION_MAX_ITER; k++) {
    eps = epsAtPressure(dp, eps0, epsMin, Pc_bar);
    const target = dpRigid * porosityGroup(eps) / F0;
    const next = (1 - COMPRESSION_W) * dp + COMPRESSION_W * target;
    const step = Math.abs(next - dp);
    dp = next;
    iterations = k + 1;
    if (step <= COMPRESSION_RTOL * Math.max(Math.abs(next), 1e-30)) break;
  }
  eps = epsAtPressure(dp, eps0, epsMin, Pc_bar);

  out.dp_bar = dp;
  out.eps = eps;
  out.iterations = iterations;
  out.collapsed = dp > BED_COLLAPSE_BAR;
  return out;
}

/**
 * Dynamic viscosity of the liquid held in the packed bed, cP — NOT Pa·s (§6.10).
 *
 * Builds the axial-mean INTERSTITIAL composition of the column (column index order mapped back to
 * species registry order through `config.skidIdxOf`) and evaluates `chem/solution.js`'s
 * `mixtureViscosity_cP` on it. `config.column.enableProteinViscosity` is passed straight through as
 * that function's `enableProtein` argument: one source (§2.1), one consumer, and D23 keeps it
 * `false` by default.
 *
 * Returns `mixtureViscosity_cP` of an all-zero vector (i.e. pure water at `T_C`) when the column has
 * not been built yet, which is the correct value for an empty flow path.
 *
 * Allocation-free after the first call; it writes into a module-owned scratch vector that is
 * reallocated only when `config.ns` changes.
 *
 * @param {object} config canonical config (§2.1); reads `ns`, `skidIdxOf`,
 *   `column.enableProteinViscosity`
 * @param {object|null} col the `Column` (§6.9) — `run.col`; may be null before `createSkid`
 * @param {number} T_C fluid temperature, °C
 * @returns {number} dynamic viscosity, cP
 */
export function columnAverageViscosity_cP(config, col, T_C) {
  const y_mM = columnMeanComposition_mM(config, col);
  const enableProtein = config && config.column ? config.column.enableProteinViscosity : false;
  return mixtureViscosity_cP(config, y_mM, T_C, enableProtein);
}

/**
 * Inline-filter hydraulic resistance, bar per (mL/s) (§7.1.4):
 *
 *     R_filter = R0_bar_per_mLs * (1 + kFoul_per_mg * run.filterLoad_mg)
 *
 * The filter housing (`G4`) sits in the gradient path UPSTREAM of the column valve, so this
 * resistance is in line at every column-valve position; it is not gated on the column being in line.
 * It IS gated on `config.skid.inlineFilter`: when that is false the housing is removed from the
 * topology entirely (`G4` becomes `V = 0`, §5.7.2), so its resistance is 0 rather than a phantom
 * 0.0131 bar.
 *
 * With the shipped pilot preset (`R0 = 0.004`, `kFoul = 2.0e-5 /mg`) the whole 27 715 mg feed load
 * multiplies `R0` by 1.554 — worth 0.007 bar at nominal flow, which is why the mandatory
 * `fouled-column-high-dp` scenario moves `rFrit_bar_per_cms` and not this (§5.6.2).
 *
 * @param {object} config canonical config; reads `skid.filter.{R0_bar_per_mLs, kFoul_per_mg}` and
 *   `skid.inlineFilter`
 * @param {object} run mutable run state; reads `run.filterLoad_mg` (mg of solids retained)
 * @returns {number} filter resistance, bar per mL/s
 */
export function filterResistance_bar_per_mLs(config, run) {
  const skid = config && config.skid ? config.skid : null;
  if (!skid || skid.inlineFilter === false) return 0;
  const f = skid.filter;
  if (!f) return 0;
  const R0 = Number.isFinite(f.R0_bar_per_mLs) ? f.R0_bar_per_mLs : 0;
  const kFoul = Number.isFinite(f.kFoul_per_mg) ? f.kFoul_per_mg : 0;
  const load_mg = run && Number.isFinite(run.filterLoad_mg) ? run.filterLoad_mg : 0;
  return R0 * (1 + kFoul * Math.max(0, load_mg));
}

/**
 * Tick step 9 of §3.3. SOLE writer of `run.mu_cP`, `run.rho_gmL`, `run.epsCompressed`,
 * `run.dPbed_bar`, `run.dPhw_bar`, `run.dPfilter_bar` and `run.bedCollapsed` (§6.10, R-S1).
 *
 * Order of business:
 *   1. Column-average composition -> `run.mu_cP` (§7.1.2 via `chem/solution.js`) and `run.rho_gmL`.
 *      Both track `run.T_fluid_C`, which is what makes the cold-room scenario visible: the Vogel
 *      curve gives `mu(4)/mu(20) = 1.5444` and `mu(5) = 1.501 cP` (+50 %).
 *   2. Superficial velocity `u_cms = |run.Q_actual_mLs| / config.column.A_cm2`.
 *   3. Bed: rigid Blake–Kozeny at `compression.eps0`, then the §7.1.3 fixed point.
 *   4. Hardware frit `dP_hw = rFrit_bar_per_cms * u_cms * foulingFactor` and inline filter
 *      `dP_filter = R_filter * Q_mLs` (§7.1.4).
 *
 * OUT-OF-LINE COLUMN. When `run.valves.columnValve` is anything other than `DOWN` or `UP`
 * (i.e. `BYPASS`, `ISOLATED` or `CIP_DETECTOR_BYPASS` — the same three-line table `bed.accumulate`
 * computes inline for its flow sign, §3.4) this function SKIPS `solveCompression`, holds
 * `run.epsCompressed` at `compression.eps0` and sets `run.dPbed_bar = 0` ITSELF. `bed.accumulate`
 * must not touch that field: it runs at step 7 and this runs at step 9, so a zero written there is
 * overwritten every tick, and a `COLUMN_BYPASS` block at high flow would report a full bed ΔP and
 * trip `ALM-P1-02` — which suppresses on `VALVE_MOVE` only, never on `BYPASS` (§6.10, §11 C-75).
 * `dP_hw` and `dP_filter` are deliberately NOT zeroed in that branch: §6.10 names `dPbed_bar` and
 * only `dPbed_bar`, and at the shipped `rFrit` the frit term is 4.6e-5 bar — three orders below any
 * alarm threshold.
 *
 * `run.bedCollapsed` LATCHES: once the bed has collapsed it stays collapsed until
 * `core/state.js::resetRunState` clears it, matching `QF.BED_COLLAPSED`, which §5.3 declares latched
 * for the run.
 *
 * `P1`/`P2` are NOT assembled here — they are transducer readings with two filters each and belong
 * to `skid/sensors.js::updatePressure` (§6.14), which reads the four fields written above.
 *
 * Zero allocation. `dt_s` is part of the uniform tick signature; the hydraulic model is
 * quasi-steady (every dynamic lag lives in the transducers), so it is intentionally unused.
 *
 * @param {object} config canonical frozen config (§2.1)
 * @param {object} run mutable run state (§2.2)
 * @param {number} dt_s physics timestep, s — unused; the model is quasi-steady
 * @returns {void}
 */
export function updateHydraulics(config, run, dt_s) { // eslint-disable-line no-unused-vars
  const colCfg = config.column;
  const T_C = Number.isFinite(run.T_fluid_C) ? run.T_fluid_C : 25;

  // --- 1. fluid properties, from the bed's own average composition -------------------------
  const yMean_mM = columnMeanComposition_mM(config, run.col);
  run.mu_cP = mixtureViscosity_cP(config, yMean_mM, T_C, colCfg.enableProteinViscosity);
  run.rho_gmL = density_gmL(yMean_mM, T_C);

  // --- 2. superficial velocity -------------------------------------------------------------
  const Q_mLs = Math.abs(run.Q_actual_mLs);
  const A_cm2 = colCfg.A_cm2;
  const u_cms = A_cm2 > 0 ? Q_mLs / A_cm2 : 0;

  // --- 3. bed ------------------------------------------------------------------------------
  // eps0 is copied out of the CMP singleton at once: solveCompression refills CMP below.
  const eps0 = compressionOf(colCfg).eps0;
  const pos = run.valves ? run.valves.columnValve : 'BYPASS';
  const columnInLine = (pos === 'DOWN' || pos === 'UP');

  if (!columnInLine) {
    run.epsCompressed = eps0;
    run.dPbed_bar = 0;
  } else {
    BED_ARGS.kKozeny = colCfg.kKozeny;
    BED_ARGS.mu_cP = run.mu_cP;
    BED_ARGS.u_cms = u_cms;
    BED_ARGS.L_cm = colCfg.L_cm;
    BED_ARGS.eps = eps0;                 // the RIGID drop, evaluated at the uncompressed porosity
    BED_ARGS.dp_cm = colCfg.dp_cm;
    const dpRigid_bar = dpBed_bar(BED_ARGS);
    const r = solveCompression(colCfg, dpRigid_bar);
    run.dPbed_bar = r.dp_bar;
    run.epsCompressed = r.eps;
    if (r.collapsed) run.bedCollapsed = true;   // LATCHED until resetRunState (§5.3)
  }

  // --- 4. hardware frit + inline filter (§7.1.4) --------------------------------------------
  const rFrit = Number.isFinite(colCfg.rFrit_bar_per_cms) ? colCfg.rFrit_bar_per_cms : 0;
  const fouling = Number.isFinite(colCfg.foulingFactor) ? colCfg.foulingFactor : 1;
  run.dPhw_bar = rFrit * u_cms * fouling;
  run.dPfilter_bar = filterResistance_bar_per_mLs(config, run) * Q_mLs;
}
