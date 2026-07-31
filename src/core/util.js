/**
 * src/core/util.js — unit constants and converters, the deterministic PCG32 RNG with its
 * stream table, and the typed-array-safe `deepFreeze`.
 *
 * Contract: architecture-v2.md §6.1 (this module), §1.1 (units), §2.3 (freezing),
 * §2.4 (config rebuild / deepMerge), §5.9 (RNG streams).
 *
 * LAYER L0 — THIS FILE IMPORTS NOTHING. It holds no state, touches no DOM, and has no
 * top-level side effects beyond freezing its own const tables.
 *
 * UNITS (§1.1): every quantity carries its unit in the variable name. Length cm, area cm²,
 * volume mL, time s, volumetric flow mL/s, superficial velocity cm/s, concentration mM,
 * amount µmol, mass mg, molar mass g/mol, pressure bar, viscosity cP, density g/mL.
 */

/* -------------------------------------------------------------------------- */
/* 1. CONSTANTS                                                               */
/* -------------------------------------------------------------------------- */

/** mL/min -> mL/s. Multiply a mL/min number by this to get the canonical `_mLs`. */
export const ML_PER_MIN_TO_ML_S = 1 / 60;

/** cm/h -> cm/s. Multiply a cm/h number by this to get the canonical `_cms`. */
export const CM_H_TO_CM_S = 1 / 3600;

/** Pa -> bar. 1 Pa = 1e-5 bar. Used only inside correlation bodies (R-U2). */
export const BAR_PER_PA = 1e-5;

/** bar -> psi. Display boundary only (`ui/format.js`). */
export const PSI_PER_BAR = 14.503774;

/** Universal gas constant, J·mol⁻¹·K⁻¹. */
export const R_GAS = 8.314462618;

/** Faraday constant, C/mol. */
export const F_FARADAY = 96485.332;

/**
 * Boltzmann constant, J/K. Declared here because
 * `physics/masstransfer.js::stokesRadius_cm` needs it (§6.1, §11 C-24).
 */
export const KB_J_K = 1.380649e-23;

/* -------------------------------------------------------------------------- */
/* 2. UNIT CONVERTERS (§6.1)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Volumetric flow from superficial velocity.
 * @param {number} u_cmh Superficial velocity, cm/h.
 * @param {number} A_cm2 Column cross-sectional area, cm².
 * @returns {number} Volumetric flow, mL/s.
 */
export function flowFromVelocity_mLs(u_cmh, A_cm2) {
  return (u_cmh * A_cm2) / 3600;
}

/**
 * Superficial velocity from volumetric flow.
 * @param {number} Q_mLs Volumetric flow, mL/s.
 * @param {number} A_cm2 Column cross-sectional area, cm².
 * @returns {number} Superficial velocity, cm/h.
 */
export function velocityFromFlow_cmh(Q_mLs, A_cm2) {
  return (Q_mLs * 3600) / A_cm2;
}

/**
 * Residence time of a volume at a given flow.
 * @param {number} V_mL Volume, mL (normally one column volume).
 * @param {number} Q_mLs Volumetric flow, mL/s.
 * @returns {number} Residence time, minutes.
 */
export function residenceTime_min(V_mL, Q_mLs) {
  return V_mL / (Q_mLs * 60);
}

/**
 * Column volumes swept per hour.
 * @param {number} Q_mLs Volumetric flow, mL/s.
 * @param {number} V_mL Column volume, mL.
 * @returns {number} Column volumes per hour, CV/h (dimensionless per hour).
 */
export function cvPerHour(Q_mLs, V_mL) {
  return (Q_mLs * 3600) / V_mL;
}

/**
 * Molar -> mass concentration (R-U3: g/L exists only at reporting boundaries).
 * @param {number} c_mM Concentration, mM (= mol/m³).
 * @param {number} MW_gmol Molar mass, g/mol.
 * @returns {number} Concentration, g/L.
 */
export function gL_from_mM(c_mM, MW_gmol) {
  return (c_mM * MW_gmol) / 1000;
}

/**
 * Mass -> molar concentration (ingest boundary only).
 * @param {number} c_gL Concentration, g/L.
 * @param {number} MW_gmol Molar mass, g/mol.
 * @returns {number} Concentration, mM.
 */
export function mM_from_gL(c_gL, MW_gmol) {
  return (c_gL * 1000) / MW_gmol;
}

/**
 * Amount -> mass (R-U4: convert only at a reporting boundary).
 * @param {number} n_umol Amount of substance, µmol.
 * @param {number} MW_gmol Molar mass, g/mol.
 * @returns {number} Mass, mg.
 */
export function mg_from_umol(n_umol, MW_gmol) {
  return (n_umol * MW_gmol) / 1000;
}

/**
 * Amount of substance from a concentration and a volume. `mM × mL = µmol` exactly.
 * THE ONLY amount helper in the program (R-U4).
 * @param {number} c_mM Concentration, mM.
 * @param {number} V_mL Volume, mL.
 * @returns {number} Amount, µmol.
 */
export function umol_from_mM(c_mM, V_mL) {
  return c_mM * V_mL;
}

/**
 * Vendor ionic-capacity conversion, applied at ingest only (BASIS N1, §1.2).
 * Verified: `0.2275 mmol/mL bed` at `epsC = 0.35` gives exactly 350.0 mM.
 * @param {number} mmolPerMLbed Ionic capacity, mmol per mL of PACKED BED.
 * @param {number} epsC Interstitial (extra-particle) porosity, dimensionless 0–1.
 * @returns {number} Capacity Λ, mM per mL of BEAD (particle) volume.
 */
export function LambdaBead_mM(mmolPerMLbed, epsC) {
  return (mmolPerMLbed * 1000) / (1 - epsC);
}

/**
 * Total porosity of a packed bed.
 * @param {number} epsC Interstitial porosity, dimensionless 0–1.
 * @param {number} epsP Intraparticle porosity, dimensionless 0–1.
 * @returns {number} Total porosity epsT, dimensionless 0–1.
 */
export function epsTotal(epsC, epsP) {
  return epsC + (1 - epsC) * epsP;
}

/**
 * Cross-sectional area of a cylindrical column.
 * @param {number} id_cm Internal diameter, cm.
 * @returns {number} Area, cm².
 */
export function area_cm2(id_cm) {
  return (Math.PI * id_cm * id_cm) / 4;
}

/**
 * Molar -> mass extinction coefficient.
 * @param {number} extMolar_M1cm1 Molar extinction coefficient, M⁻¹·cm⁻¹ (= L·mol⁻¹·cm⁻¹).
 * @param {number} MW_gmol Molar mass, g/mol.
 * @returns {number} Mass extinction coefficient, L·g⁻¹·cm⁻¹.
 */
export function extMass_Lgcm(extMolar_M1cm1, MW_gmol) {
  return extMolar_M1cm1 / MW_gmol;
}

/* -------------------------------------------------------------------------- */
/* 3. SMALL NUMERIC HELPERS                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Clamp to a closed interval. `NaN` in gives `NaN` out (both comparisons are false),
 * which is the behaviour every caller in this program wants.
 * @param {number} x Value, any unit.
 * @param {number} lo Lower bound, same unit as `x`.
 * @param {number} hi Upper bound, same unit as `x`.
 * @returns {number} The clamped value, same unit as `x`.
 */
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Linear interpolation. Not clamped: `t` outside [0,1] extrapolates.
 * @param {number} a Value at `t = 0`, any unit.
 * @param {number} b Value at `t = 1`, same unit as `a`.
 * @param {number} t Interpolation parameter, dimensionless.
 * @returns {number} Interpolated value, same unit as `a`.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Relative comparison. `nearlyEqual(0, 0, tol)` is true; `NaN` is never nearly equal
 * to anything, including itself.
 * @param {number} a First value, any unit.
 * @param {number} b Second value, same unit as `a`.
 * @param {number} relTol Relative tolerance, dimensionless (e.g. 1e-9).
 * @returns {boolean} True when |a-b| <= relTol * max(|a|,|b|).
 */
export function nearlyEqual(a, b, relTol) {
  if (a === b) return true;
  const d = Math.abs(a - b);
  const m = Math.max(Math.abs(a), Math.abs(b));
  return d <= relTol * m;
}

/* -------------------------------------------------------------------------- */
/* 4. FREEZE AND MERGE (§2.3, §2.4)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Recursive freeze that is safe on typed arrays. `Object.freeze(new Float64Array(3))`
 * throws `TypeError: Cannot freeze array buffer views with elements`, and `config` holds
 * `colIdxOf`, `skidIdxOf` and `tanks[].y_mM`, so the guard is mandatory (§2.3). Typed
 * arrays inside `config` are therefore frozen BY CONVENTION: writing to one is a
 * code-review failure, not a runtime error.
 * @param {any} obj Any value; non-objects are returned unchanged.
 * @returns {any} The same reference, frozen in place (typed arrays untouched).
 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (ArrayBuffer.isView(obj)) return obj; // typed arrays: SKIP, never freeze
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return obj;
}

/**
 * True for a plain `{}`-style object: not null, not an array, not a typed array,
 * not a Map/Set/Date/class instance. Only plain objects are recursed into by deepMerge.
 * @param {any} v Candidate.
 * @returns {boolean} True when `v` is a plain object.
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/**
 * Plain-object deep merge, LEAF WINS (§2.4). Arrays and typed arrays are REPLACED
 * wholesale, never merged element-wise. Returns a NEW object and mutates neither
 * argument, so it is safe to call on a frozen `ctx.overrides`.
 *
 * Sub-trees present only in `base` are carried across by reference; they are never
 * written to, so no aliasing hazard exists (`config` objects are frozen and `overrides`
 * objects are replaced rather than mutated).
 *
 * @param {object} base Existing overrides object (may be null/undefined).
 * @param {object} patch Patch to lay on top; its leaves win (may be null/undefined).
 * @returns {object} A new plain object; units are whatever the leaves carry.
 */
export function deepMerge(base, patch) {
  const out = {};
  if (base && typeof base === 'object') {
    for (const k of Object.keys(base)) out[k] = base[k];
  }
  if (patch && typeof patch === 'object') {
    for (const k of Object.keys(patch)) {
      const bv = out[k];
      const pv = patch[k];
      out[k] = isPlainObject(bv) && isPlainObject(pv) ? deepMerge(bv, pv) : pv;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 5. DETERMINISTIC RNG — PCG32, BigInt-free (§5.9)                           */
/* -------------------------------------------------------------------------- */

/**
 * Stream ownership table (§5.9). Every stream draws a FIXED number of values per tick,
 * unconditionally, even when the value is discarded — that is the whole of determinism
 * requirement T29. `PUMP_BIAS` is the single documented exception: it is drawn exactly
 * once per run, in `core/state.js::createRunState`, outside the tick loop entirely.
 *
 * Per-tick draw counts: PUMP_WALK 1 (fluidics.pctBError); UV 3 white + 12 pink;
 * COND 2 white + 1 pink; PH 1; PRESS 2; TANK 1 (fluidics.drawTanks);
 * BED_TEXTURE at ui/pid.js construction only.
 * @type {{PUMP_BIAS:number, PUMP_WALK:number, UV:number, COND:number, PH:number,
 *         PRESS:number, TANK:number, BED_TEXTURE:number}}
 */
export const RNG_STREAMS = Object.freeze({
  PUMP_BIAS: 1,
  PUMP_WALK: 2,
  UV: 3,
  COND: 4,
  PH: 5,
  PRESS: 6,
  TANK: 7,
  BED_TEXTURE: 8,
});

// PCG32 (pcg_oneseq_64_xsh_rr_32): 64-bit LCG state held as two 32-bit halves so the hot
// path never touches BigInt. Multiplier 0x5851F42D4C957F2D, increment 0x14057B7EF767814F.
// Streams are distinguished by their seeded initial state, not by the increment, because
// the stream object shape `{s0, s1}` is fixed by the contract and carries no `inc` field.
const MUL_L0 = 0x7f2d; // multiplier, 16-bit limbs, least significant first
const MUL_L1 = 0x4c95;
const MUL_L2 = 0xf42d;
const MUL_L3 = 0x5851;
const INC_LO = 0xf767814f; // increment, low 32 bits
const INC_HI = 0x14057b7e; // increment, high 32 bits
const TWO32 = 4294967296;

/**
 * Add an unsigned 64-bit value to the stream state, in place, modulo 2^64.
 * @param {{s0:number, s1:number}} s Stream state (s0 = low 32 bits, s1 = high 32 bits).
 * @param {number} lo Low 32 bits of the addend, uint32.
 * @param {number} hi High 32 bits of the addend, uint32.
 * @returns {void}
 */
function add64(s, lo, hi) {
  let l = (s.s0 >>> 0) + (lo >>> 0);
  let carry = 0;
  if (l >= TWO32) {
    l -= TWO32;
    carry = 1;
  }
  let h = (s.s1 >>> 0) + (hi >>> 0) + carry;
  if (h >= TWO32) h -= TWO32;
  s.s0 = l >>> 0;
  s.s1 = h >>> 0;
}

/**
 * Advance the LCG one step: `state = state * MULT + INC (mod 2^64)`.
 * Schoolbook 16-bit limb multiply; every intermediate stays below 2^35, well inside the
 * exact-integer range of a double.
 * @param {{s0:number, s1:number}} s Stream state, mutated in place.
 * @returns {void}
 */
function pcgAdvance(s) {
  const s0 = s.s0 >>> 0;
  const s1 = s.s1 >>> 0;
  const a0 = s0 & 0xffff;
  const a1 = s0 >>> 16;
  const a2 = s1 & 0xffff;
  const a3 = s1 >>> 16;

  const c0 = a0 * MUL_L0;
  const c1 = a0 * MUL_L1 + a1 * MUL_L0;
  const c2 = a0 * MUL_L2 + a1 * MUL_L1 + a2 * MUL_L0;
  const c3 = a0 * MUL_L3 + a1 * MUL_L2 + a2 * MUL_L1 + a3 * MUL_L0;

  let t = c0;
  const r0 = t % 65536;
  t = (t - r0) / 65536 + c1;
  const r1 = t % 65536;
  t = (t - r1) / 65536 + c2;
  const r2 = t % 65536;
  t = (t - r2) / 65536 + c3;
  const r3 = t % 65536;

  s.s0 = (r0 | (r1 << 16)) >>> 0;
  s.s1 = (r2 | (r3 << 16)) >>> 0;
  add64(s, INC_LO, INC_HI);
}

/**
 * SplitMix32 finaliser — used only to spread one int32 seed across the stream table.
 * @param {number} x Input word, int32.
 * @returns {number} Well-mixed uint32.
 */
function mix32(x) {
  let z = (x + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Seed one stream, following the reference `pcg32_srandom_r` schedule:
 * state = 0; advance; state += initstate; advance.
 * @param {number} seed_int32 Run seed, int32.
 * @param {number} k Stream index, integer 0..n-1.
 * @returns {{s0:number, s1:number}} A freshly seeded stream state.
 */
function seedStream(seed_int32, k) {
  const s = { s0: 0, s1: 0 };
  const initLo = mix32(seed_int32 ^ Math.imul(k + 1, 0x9e3779b9));
  const initHi = mix32((initLo ^ Math.imul(k + 1, 0x85ebca6b) ^ seed_int32) | 0);
  pcgAdvance(s);
  add64(s, initLo, initHi);
  pcgAdvance(s);
  return s;
}

/**
 * Fork one independent PCG32 stream per entry in {@link RNG_STREAMS}.
 * The returned array has length `1 + max(RNG_STREAMS values)` = 9; index 0 is unused so
 * that `streams[RNG_STREAMS.UV]` indexes directly.
 * @param {number} seed_int32 Run seed, int32 (`config.seed`).
 * @returns {{streams: Array<{s0:number, s1:number}>}} Fresh RNG, ready for `run.rng`.
 */
export function createRng(seed_int32) {
  let maxStream = 0;
  for (const key of Object.keys(RNG_STREAMS)) {
    const v = RNG_STREAMS[key];
    if (v > maxStream) maxStream = v;
  }
  const n = maxStream + 1;
  const seed = seed_int32 | 0;
  const streams = new Array(n);
  for (let k = 0; k < n; k++) streams[k] = seedStream(seed, k);
  return { streams };
}

/**
 * Draw one uniform 32-bit word and advance the stream. PCG32 XSH-RR output, computed
 * from the PRE-advance state exactly as the reference implementation does.
 * @param {{s0:number, s1:number}} s Stream state, mutated in place.
 * @returns {number} Uniform integer in [0, 2^32), dimensionless.
 */
export function nextU32(s) {
  const s0 = s.s0 >>> 0;
  const s1 = s.s1 >>> 0;
  // (state >> 18) ^ state, as two 32-bit halves
  const x0 = ((s0 >>> 18) | (s1 << 14)) ^ s0;
  const x1 = (s1 >>> 18) ^ s1;
  // >> 27, keeping the low 32 bits
  const xorshifted = ((x0 >>> 27) | (x1 << 5)) >>> 0;
  const rot = s1 >>> 27; // = state >> 59
  pcgAdvance(s);
  return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
}

/**
 * Draw one uniform double. Consumes EXACTLY one `nextU32`.
 * @param {{s0:number, s1:number}} s Stream state, mutated in place.
 * @returns {number} Uniform deviate in [0, 1), dimensionless.
 */
export function nextFloat(s) {
  return nextU32(s) / TWO32;
}

/**
 * Draw one standard normal deviate, N(0,1). Box–Muller, consuming EXACTLY two `nextU32`
 * calls on every invocation with NO caching of the second variate: caching would make the
 * per-tick draw count depend on call parity and break bit-identical replay (§5.9).
 * The first uniform is offset by half an ulp so `log(0)` is unreachable.
 * @param {{s0:number, s1:number}} s Stream state, mutated in place.
 * @returns {number} Normal deviate, dimensionless (scale it at the call site).
 */
export function nextGaussian(s) {
  const u1 = (nextU32(s) + 0.5) / TWO32; // in (0,1), never 0
  const u2 = nextU32(s) / TWO32;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
