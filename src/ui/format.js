/**
 * @file src/ui/format.js — THE DISPLAY BOUNDARY (architecture-v2 §1.1 R-U1, §6.25, §9.4.2).
 *
 * This module is one of exactly **two** places in the program where a unit conversion is allowed.
 * The other is `data/presets.js::normalizePreset()` (the ingest boundary) and its sibling
 * `skid/method.js::normalizeMethod()`. Everything in between speaks one canonical unit set:
 * mL, s, mL/s, mM, bar, cP, AU, cm, °C, µmol.
 *
 * Three rules bind every function below.
 *
 *  1. **Pure.** No module state is read except this module's own display preferences, and nothing
 *     here touches `run` or `config` other than to read immutable derived constants
 *     (`config.column.V_mL`, `config.column.A_cm2`). Nothing here mutates anything.
 *  2. **One-way.** The string a `fmt*` function returns is **never** parsed back into state. When a
 *     numeric field must return to canonical units it calls `fromDisplay()` — the declared inverse —
 *     which is still inside this boundary, so the conversion has still happened in exactly one file.
 *  3. **Fixed decimal count per channel.** A live tag's digits never change width between frames
 *     (§9.7 "fixed decimal counts so numbers never change width"). The decimal counts are the
 *     `DECIMALS` table below; they are a *display* choice and are deliberately independent of
 *     `core/log.js::buildLogChannels().decimals[]`, which is the CSV's decimal source.
 *
 * The DOM micro-helpers live here too, because every view needs them and none of them is worth its
 * own module: `h`/`hSvg` build, `setText`/`setAttr`/`cls` write only on change, and `reconcileList`
 * is the ONLY diffing algorithm in the application (§6.24).
 *
 * `GLOSSARY` is **not** here — it is `src/data/glossary.js` (§6.22.1).
 *
 * @module ui/format
 */

import {
  PSI_PER_BAR,
  flowFromVelocity_mLs,
  velocityFromFlow_cmh,
  residenceTime_min,
  cvPerHour,
  gL_from_mM,
  mM_from_gL,
} from '../core/util.js';

/* =================================================================================================
 * 1. DISPLAY PREFERENCES
 * ===============================================================================================*/

/**
 * The placeholder rendered for a value that is not evaluable (`NaN`, `null`, `undefined`,
 * `Infinity`). An em dash, because a blank cell reads as "zero" on a process display.
 * @type {string}
 */
export const NO_VALUE = '—';

/**
 * The legal value of every display-unit preference. Views build their unit `<select>` elements
 * straight from this table, so a unit that is not listed here cannot be chosen.
 * @type {Readonly<{volume:string[], flow:string[], time:string[], pressure:string[],
 *                  conc:string[], abs:string[]}>}
 */
export const DISPLAY_UNIT_OPTIONS = Object.freeze({
  volume: Object.freeze(['mL', 'L', 'CV']),
  flow: Object.freeze(['mL/min', 'L/h', 'cm/h', 'CV/h']),
  time: Object.freeze(['s', 'min', 'h']),
  pressure: Object.freeze(['bar', 'MPa', 'psi']),
  conc: Object.freeze(['g/L', 'mM']),
  abs: Object.freeze(['AU', 'mAU']),
});

/** Live display preferences. Module-private; read through `getDisplayUnits()`. */
const PREFS = {
  volume: 'mL',
  flow: 'mL/min',
  time: 'min',
  pressure: 'bar',
  conc: 'g/L',
  abs: 'mAU',
};

/**
 * Fixed decimal counts, keyed `<kind>:<unit>`. A tag formatted through this table has a constant
 * character width for its whole life, which is what stops a status chip from twitching at 10 Hz.
 */
const DECIMALS = {
  'volume:mL': 1,
  'volume:L': 3,
  'volume:CV': 2,
  'flow:mL/min': 1,
  'flow:L/h': 2,
  'flow:cm/h': 1,
  'flow:CV/h': 2,
  'time:s': 1,
  'time:min': 2,
  'time:h': 3,
  'pressure:bar': 2,
  'pressure:MPa': 3,
  'pressure:psi': 1,
  'conc:mM': 2,
  'conc:g/L': 3,
  'abs:AU': 4,
  'abs:mAU': 1,
  'cond:mS/cm': 2,
  'ph:': 2,
  'pct:%': 1,
  'cv:CV': 2,
};

/**
 * Replace one or more display-unit preferences. Unknown keys and illegal values are ignored (with a
 * console warning) rather than throwing, because this is reachable from a `<select>` and a bad
 * option must never take the UI down.
 *
 * This function does **not** notify anybody. `ui/app.js` owns the announcement: it calls
 * `setDisplayUnits(...)` and then `ctx.bus.emit('display-units-changed', prefs)`, and every panel
 * that caches a formatted string re-renders on that event.
 *
 * @param {{volume?:string, flow?:string, time?:string, pressure?:string, conc?:string, abs?:string}} prefs
 *        Partial preference patch. Omitted keys keep their current value.
 * @returns {void}
 */
export function setDisplayUnits(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  for (const key of Object.keys(prefs)) {
    const allowed = DISPLAY_UNIT_OPTIONS[key];
    if (!allowed) {
      console.warn('format.setDisplayUnits: unknown preference "' + key + '" ignored');
      continue;
    }
    const value = prefs[key];
    if (allowed.indexOf(value) < 0) {
      console.warn(
        'format.setDisplayUnits: illegal ' + key + ' unit "' + value + '"; ' +
        'legal values are ' + allowed.join(', '),
      );
      continue;
    }
    PREFS[key] = value;
  }
}

/**
 * The current display-unit preferences, as a fresh shallow copy. Mutating the returned object has
 * no effect — call `setDisplayUnits` instead.
 * @returns {{volume:string, flow:string, time:string, pressure:string, conc:string, abs:string}}
 */
export function getDisplayUnits() {
  return { ...PREFS };
}

/**
 * The unit string currently in force for a quantity kind, for labelling a field that has no value
 * yet (an empty numfield's unit span, an axis title).
 *
 * @param {'volume'|'cv'|'flow'|'time'|'pressure'|'conc'|'abs'|'cond'|'ph'|'pct'} kind
 * @returns {string} e.g. `'mL/min'`. `'ph'` returns `''` — pH is dimensionless.
 */
export function unitLabel(kind) {
  switch (kind) {
    case 'volume': return PREFS.volume;
    case 'cv': return 'CV';
    case 'flow': return PREFS.flow;
    case 'time': return PREFS.time;
    case 'pressure': return PREFS.pressure;
    case 'conc': return PREFS.conc;
    case 'abs': return PREFS.abs;
    case 'cond': return 'mS/cm';
    case 'ph': return '';
    case 'pct': return '%';
    default: return '';
  }
}

/* =================================================================================================
 * 2. THE CONVERSION CORE — canonical <-> display
 * ===============================================================================================*/

/**
 * Convert one canonical value into its display representation, without formatting it.
 *
 * This is the single conversion kernel; every `fmt*` function below is a two-line wrapper around it.
 * Views that need the *number* rather than the string — a numfield's `<input>` value, a chart axis
 * bound, a slider position — call this directly and keep the returned `unit`/`decimals` for the
 * surrounding chrome.
 *
 * @param {'volume'|'cv'|'flow'|'time'|'pressure'|'conc'|'abs'|'cond'|'ph'|'pct'} kind
 *        The quantity kind. Fixes both the canonical input unit and the preference consulted.
 * @param {number} value  The canonical value: mL, mL/s, s, bar, mM, AU, mS/cm, pH, or percent 0-100.
 * @param {object} [config]  Required for `'volume'` in CV, `'cv'`, and `'flow'` in cm/h or CV/h;
 *        read-only, and only `config.column.V_mL` / `config.column.A_cm2` are touched.
 * @param {{MW_gmol?:number}} [opts]  `MW_gmol` is required for `'conc'` in g/L; without it the
 *        result falls back to mM rather than returning nonsense.
 * @returns {{value:number, unit:string, decimals:number}} `value` is `NaN` when not evaluable.
 */
export function toDisplay(kind, value, config, opts) {
  const V_mL = config && config.column ? config.column.V_mL : NaN;
  const A_cm2 = config && config.column ? config.column.A_cm2 : NaN;
  const v = typeof value === 'number' ? value : NaN;

  switch (kind) {
    case 'volume': {
      const u = PREFS.volume;
      if (u === 'L') return { value: v / 1000, unit: 'L', decimals: DECIMALS['volume:L'] };
      if (u === 'CV') return { value: v / V_mL, unit: 'CV', decimals: DECIMALS['volume:CV'] };
      return { value: v, unit: 'mL', decimals: DECIMALS['volume:mL'] };
    }
    case 'cv':
      return { value: v / V_mL, unit: 'CV', decimals: DECIMALS['cv:CV'] };

    case 'flow': {
      const u = PREFS.flow;
      if (u === 'L/h') return { value: v * 3.6, unit: 'L/h', decimals: DECIMALS['flow:L/h'] };
      if (u === 'cm/h') {
        return { value: velocityFromFlow_cmh(v, A_cm2), unit: 'cm/h', decimals: DECIMALS['flow:cm/h'] };
      }
      if (u === 'CV/h') {
        return { value: cvPerHour(v, V_mL), unit: 'CV/h', decimals: DECIMALS['flow:CV/h'] };
      }
      return { value: v * 60, unit: 'mL/min', decimals: DECIMALS['flow:mL/min'] };
    }
    case 'time': {
      const u = PREFS.time;
      if (u === 's') return { value: v, unit: 's', decimals: DECIMALS['time:s'] };
      if (u === 'h') return { value: v / 3600, unit: 'h', decimals: DECIMALS['time:h'] };
      return { value: v / 60, unit: 'min', decimals: DECIMALS['time:min'] };
    }
    case 'pressure': {
      const u = PREFS.pressure;
      if (u === 'MPa') return { value: v * 0.1, unit: 'MPa', decimals: DECIMALS['pressure:MPa'] };
      if (u === 'psi') {
        return { value: v * PSI_PER_BAR, unit: 'psi', decimals: DECIMALS['pressure:psi'] };
      }
      return { value: v, unit: 'bar', decimals: DECIMALS['pressure:bar'] };
    }
    case 'conc': {
      const MW = opts && typeof opts.MW_gmol === 'number' ? opts.MW_gmol : NaN;
      if (PREFS.conc === 'g/L' && MW > 0) {
        return { value: gL_from_mM(v, MW), unit: 'g/L', decimals: DECIMALS['conc:g/L'] };
      }
      return { value: v, unit: 'mM', decimals: DECIMALS['conc:mM'] };
    }
    case 'abs': {
      if (PREFS.abs === 'AU') return { value: v, unit: 'AU', decimals: DECIMALS['abs:AU'] };
      return { value: v * 1000, unit: 'mAU', decimals: DECIMALS['abs:mAU'] };
    }
    case 'cond':
      return { value: v, unit: 'mS/cm', decimals: DECIMALS['cond:mS/cm'] };
    case 'ph':
      return { value: v, unit: '', decimals: DECIMALS['ph:'] };
    case 'pct':
      return { value: v, unit: '%', decimals: DECIMALS['pct:%'] };
    default:
      return { value: v, unit: '', decimals: 3 };
  }
}

/**
 * The declared inverse of {@link toDisplay}: take a number a human typed into a field labelled in
 * the current display unit and return the canonical value.
 *
 * This exists so that a numfield with a `mL/min <-> cm/h` selector never converts in a view module.
 * R-U1's "conversion happens in exactly two places" is preserved: the conversion is still in this
 * file. R-U1's "the return value is never read back into state" is also preserved: what is read back
 * is *operator input*, not a string this module produced.
 *
 * @param {'volume'|'cv'|'flow'|'time'|'pressure'|'conc'|'abs'|'cond'|'ph'|'pct'} kind
 * @param {number} displayValue  The number as shown, in the unit currently selected for `kind`.
 * @param {object} [config]  Same requirement as `toDisplay`.
 * @param {{MW_gmol?:number, unit?:string}} [opts]  `unit` overrides the current preference, for a
 *        field whose selector differs from the global preference. `MW_gmol` as in `toDisplay`.
 * @returns {number} The canonical value (mL, mL/s, s, bar, mM, AU, mS/cm, pH, percent), or `NaN`.
 */
export function fromDisplay(kind, displayValue, config, opts) {
  const V_mL = config && config.column ? config.column.V_mL : NaN;
  const A_cm2 = config && config.column ? config.column.A_cm2 : NaN;
  const v = typeof displayValue === 'number' ? displayValue : NaN;
  const override = opts && typeof opts.unit === 'string' ? opts.unit : null;

  switch (kind) {
    case 'volume': {
      const u = override || PREFS.volume;
      if (u === 'L') return v * 1000;
      if (u === 'CV') return v * V_mL;
      return v;
    }
    case 'cv':
      return v * V_mL;
    case 'flow': {
      const u = override || PREFS.flow;
      if (u === 'L/h') return v / 3.6;
      if (u === 'cm/h') return flowFromVelocity_mLs(v, A_cm2);
      if (u === 'CV/h') return (v * V_mL) / 3600;
      return v / 60;
    }
    case 'time': {
      const u = override || PREFS.time;
      if (u === 's') return v;
      if (u === 'h') return v * 3600;
      return v * 60;
    }
    case 'pressure': {
      const u = override || PREFS.pressure;
      if (u === 'MPa') return v * 10;
      if (u === 'psi') return v / PSI_PER_BAR;
      return v;
    }
    case 'conc': {
      const u = override || PREFS.conc;
      const MW = opts && typeof opts.MW_gmol === 'number' ? opts.MW_gmol : NaN;
      if (u === 'g/L' && MW > 0) return mM_from_gL(v, MW);
      return v;
    }
    case 'abs': {
      const u = override || PREFS.abs;
      return u === 'AU' ? v : v / 1000;
    }
    default:
      return v;
  }
}

/* =================================================================================================
 * 3. NUMBER FORMATTING PRIMITIVES
 * ===============================================================================================*/

/**
 * Format a number with a fixed decimal count. The width-stable primitive every tag readout uses.
 *
 * @param {number} value  Any number. `NaN`/`Infinity`/non-number renders as {@link NO_VALUE}.
 * @param {number} decimals  Digits after the point, 0-20. Clamped into range.
 * @returns {string} e.g. `'150.0'`, or `'—'`.
 */
export function fmtFixed(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  let d = Math.round(decimals);
  if (!Number.isFinite(d) || d < 0) d = 0;
  if (d > 20) d = 20;
  // Avoid the '-0.00' that toFixed produces for tiny negatives; it reads as a fault on an HMI.
  const s = value.toFixed(d);
  return s === '-' + (0).toFixed(d) ? (0).toFixed(d) : s;
}

/**
 * Format a number to a fixed number of significant figures, staying in positional notation for the
 * range a human reads comfortably and falling back to exponential outside it.
 *
 * @param {number} value  Any number.
 * @param {number} [sigFigs=4]  Significant figures, 1-17.
 * @returns {string} e.g. `fmtSig(0.0004123, 3)` -> `'0.000412'`; `fmtSig(4.123e-9, 3)` -> `'4.12e-9'`.
 */
export function fmtSig(value, sigFigs) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  let sig = Math.round(sigFigs === undefined ? 4 : sigFigs);
  if (!Number.isFinite(sig) || sig < 1) sig = 1;
  if (sig > 17) sig = 17;
  if (value === 0) return (0).toFixed(sig - 1);
  const mag = Math.abs(value);
  if (mag >= 1e-4 && mag < 1e7) {
    const exp = Math.floor(Math.log10(mag));
    let d = sig - 1 - exp;
    if (d < 0) d = 0;
    if (d > 20) d = 20;
    return value.toFixed(d);
  }
  // toExponential gives '4.12e-9' already; normalise '+' out of the exponent for compactness.
  return value.toExponential(sig - 1).replace('e+', 'e');
}

/**
 * Engineering notation: an exponent that is always a multiple of three, which is how diffusivities,
 * rate constants and permeabilities are read in the process industries.
 *
 * @param {number} value  Any number.
 * @param {number} [sigFigs=4]  Significant figures in the mantissa, 1-17.
 * @returns {string} e.g. `fmtEng(4.0e-7, 4)` -> `'400.0e-9'`; `fmtEng(1570.8, 4)` -> `'1.571e3'`.
 */
export function fmtEng(value, sigFigs) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  let sig = Math.round(sigFigs === undefined ? 4 : sigFigs);
  if (!Number.isFinite(sig) || sig < 1) sig = 1;
  if (sig > 17) sig = 17;
  if (value === 0) return (0).toFixed(sig - 1);

  const exp = Math.floor(Math.log10(Math.abs(value)));
  let exp3 = Math.floor(exp / 3) * 3;
  let mant = value / Math.pow(10, exp3);
  let d = sig - 1 - (exp - exp3);
  if (d < 0) d = 0;
  if (d > 20) d = 20;
  // Rounding can push the mantissa to 1000.0; renormalise once.
  if (Math.abs(Number(mant.toFixed(d))) >= 1000) {
    exp3 += 3;
    mant = value / Math.pow(10, exp3);
    d = sig - 1;
    if (d > 20) d = 20;
  }
  const m = mant.toFixed(d);
  return exp3 === 0 ? m : m + 'e' + exp3;
}

/**
 * Parse operator input into a number. Tolerates surrounding whitespace, thousands separators, a
 * Unicode minus, a comma decimal point and a trailing unit the user did not delete.
 *
 * @param {string|number} text  The raw field value.
 * @returns {number} The parsed number, or `NaN` when the input is not a number.
 */
export function parseNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : NaN;
  if (typeof text !== 'string') return NaN;
  let s = text.trim();
  if (s === '') return NaN;
  s = s.replace(/−/g, '-').replace(/[\s  ]/g, '');
  // A comma is a decimal point only when there is no dot; otherwise it is a thousands separator.
  if (s.indexOf('.') < 0 && (s.match(/,/g) || []).length === 1) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const m = s.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
  if (!m) return NaN;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : NaN;
}

/* =================================================================================================
 * 4. THE TAG FORMATTERS — canonical in, display string out
 * ===============================================================================================*/

/** Join a formatted number and its unit. pH has no unit and gets no trailing space. */
function withUnit(numberText, unit) {
  return unit ? numberText + ' ' + unit : numberText;
}

/**
 * Format a volume in the current volume unit (mL, L or CV).
 * @param {number} v_mL  Canonical volume, mL.
 * @param {object} [config]  Needed only when the CV unit is selected.
 * @returns {string} e.g. `'1570.8 mL'`, `'1.571 L'`, `'1.00 CV'`.
 */
export function fmtVolume(v_mL, config) {
  const d = toDisplay('volume', v_mL, config);
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Format a flow in the current flow unit (mL/min, L/h, cm/h or CV/h).
 * @param {number} Q_mLs  Canonical volumetric flow, mL/s.
 * @param {object} [config]  Needed for cm/h (column area) and CV/h (column volume).
 * @returns {string} e.g. `'196.3 mL/min'`, `'150.0 cm/h'`.
 */
export function fmtFlow(Q_mLs, config) {
  const d = toDisplay('flow', Q_mLs, config);
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Format an elapsed or absolute simulated time in the current time unit (s, min or h).
 * @param {number} t_s  Canonical time, seconds.
 * @returns {string} e.g. `'12.50 min'`.
 */
export function fmtTime(t_s) {
  const d = toDisplay('time', t_s);
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Format a time as a run clock, `H:MM:SS`, independent of the time unit preference. Used for the
 * status-strip sim clock, where a monotonically climbing decimal minute count is unreadable.
 * @param {number} t_s  Canonical time, seconds. Negative values are clamped to zero.
 * @returns {string} e.g. `'1:23:45'`, or `'—'` when not evaluable.
 */
export function fmtClock(t_s) {
  if (typeof t_s !== 'number' || !Number.isFinite(t_s)) return NO_VALUE;
  const total = Math.max(0, Math.floor(t_s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/**
 * Format a pressure in the current pressure unit (bar, MPa or psi).
 * @param {number} p_bar  Canonical gauge pressure, bar.
 * @returns {string} e.g. `'3.42 bar'`.
 */
export function fmtPressure(p_bar) {
  const d = toDisplay('pressure', p_bar);
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Format a concentration in the current concentration unit (g/L or mM).
 *
 * R-U3: concentration is molar everywhere inside the simulator; g/L exists only at this boundary.
 * When `MW_gmol` is missing or non-positive the result falls back to mM rather than dividing by
 * zero — a salt has no meaningful g/L in this UI and must not render as `Infinity`.
 *
 * @param {number} c_mM  Canonical concentration, mM.
 * @param {number} [MW_gmol]  Molar mass, g/mol. Required for the g/L form.
 * @returns {string} e.g. `'4.250 g/L'`, `'150.00 mM'`.
 */
export function fmtConc(c_mM, MW_gmol) {
  const d = toDisplay('conc', c_mM, null, { MW_gmol });
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Format an absorbance in the current absorbance unit (AU or mAU).
 * @param {number} A_AU  Canonical absorbance, AU (as stored in `run.uv.Afilt[ch]`).
 * @returns {string} e.g. `'842.3 mAU'`, `'0.8423 AU'`.
 */
export function fmtAbs(A_AU) {
  const d = toDisplay('abs', A_AU);
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Format a conductivity. mS/cm is the only unit a chromatography skid uses, so there is no
 * preference for it.
 * @param {number} k_mScm  Canonical conductivity, mS/cm.
 * @returns {string} e.g. `'15.90 mS/cm'`.
 */
export function fmtCond(k_mScm) {
  const d = toDisplay('cond', k_mScm);
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Format a pH. Dimensionless, always two decimals, never a unit suffix.
 * @param {number} pH  Canonical pH.
 * @returns {string} e.g. `'5.00'`.
 */
export function fmtPH(pH) {
  return fmtFixed(pH, DECIMALS['ph:']);
}

/**
 * Format a percentage. The canonical percentage convention is 0-100 (§1), not 0-1.
 * @param {number} x  Percentage, 0-100.
 * @returns {string} e.g. `'45.0 %'`.
 */
export function fmtPct(x) {
  return withUnit(fmtFixed(x, DECIMALS['pct:%']), '%');
}

/**
 * Format a volume as column volumes, regardless of the volume unit preference. The phase rail, the
 * method editor and the CV axis all speak CV whatever else is selected.
 * @param {number} v_mL  Canonical volume, mL.
 * @param {object} config  Must carry `config.column.V_mL`.
 * @returns {string} e.g. `'3.53 CV'`.
 */
export function fmtCV(v_mL, config) {
  const d = toDisplay('cv', v_mL, config);
  return withUnit(fmtFixed(d.value, d.decimals), d.unit);
}

/* =================================================================================================
 * 5. THE LINKED FLOW GROUP
 * ===============================================================================================*/

/**
 * The four equivalent statements of "how fast is it running", derived from whichever one the
 * operator typed. Enter any ONE and get all four; the mapping is exact and lossless in both
 * directions (they are all the same number times a constant).
 *
 *   Q [mL/s]  <->  u = Q*3600/A [cm/h]  <->  RT = V/(Q*60) [min]  <->  CV/h = Q*3600/V
 *
 * When more than one field is supplied the precedence is `Q_mLs` > `u_cmh` > `RT_min` > `CVh`,
 * which is the order in which the Column card's fields appear; supplying none returns all `NaN`.
 * At `Q = 0` the residence time is `Infinity` and `CV/h` is `0` — both are the truth and neither is
 * masked.
 *
 * @param {object} config  Must carry `config.column.A_cm2` and `config.column.V_mL`.
 * @param {{Q_mLs?:number, u_cmh?:number, RT_min?:number, CVh?:number}} partial  Exactly one field.
 * @returns {{Q_mLs:number, u_cmh:number, RT_min:number, CVh:number}} All four, canonical/display as
 *          named: `Q_mLs` is canonical mL/s, the other three are the human-facing forms.
 */
export function linkedFlowGroup(config, partial) {
  const A_cm2 = config && config.column ? config.column.A_cm2 : NaN;
  const V_mL = config && config.column ? config.column.V_mL : NaN;
  const p = partial || {};

  let Q_mLs = NaN;
  if (typeof p.Q_mLs === 'number' && Number.isFinite(p.Q_mLs)) {
    Q_mLs = p.Q_mLs;
  } else if (typeof p.u_cmh === 'number' && Number.isFinite(p.u_cmh)) {
    Q_mLs = flowFromVelocity_mLs(p.u_cmh, A_cm2);
  } else if (typeof p.RT_min === 'number' && Number.isFinite(p.RT_min)) {
    Q_mLs = p.RT_min === 0 ? Infinity : V_mL / (p.RT_min * 60);
  } else if (typeof p.CVh === 'number' && Number.isFinite(p.CVh)) {
    Q_mLs = (p.CVh * V_mL) / 3600;
  }

  if (!Number.isFinite(Q_mLs)) {
    return { Q_mLs: NaN, u_cmh: NaN, RT_min: NaN, CVh: NaN };
  }
  return {
    Q_mLs,
    u_cmh: velocityFromFlow_cmh(Q_mLs, A_cm2),
    RT_min: residenceTime_min(V_mL, Q_mLs),
    CVh: cvPerHour(Q_mLs, V_mL),
  };
}

/* =================================================================================================
 * 6. AXIS FORMATTING — the nice-number ladder
 * ===============================================================================================*/

/**
 * Snap a magnitude onto the 1 / 2 / 2.5 / 5 x 10^n ladder. This is the ladder `ui/chart.js`
 * quantises its eased auto-sticky axis bounds to, which is what turns a 4 s shrink animation into a
 * handful of full repaints instead of 240 (§6.26).
 *
 * @param {number} x  A positive magnitude.
 * @param {boolean} round  `true` snaps to the nearest rung (for a tick step), `false` snaps up to
 *        the next rung at or above `x` (for an axis range).
 * @returns {number} The ladder value, or `NaN` if `x` is not a positive finite number.
 */
export function niceNumber(x, round) {
  if (!(typeof x === 'number' && Number.isFinite(x) && x > 0)) return NaN;
  const exp = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, exp);
  let nf;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 2.25) nf = 2;
    else if (f < 3.5) nf = 2.5;
    else if (f < 7.5) nf = 5;
    else nf = 10;
  } else {
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 2.5) nf = 2.5;
    else if (f <= 5) nf = 5;
    else nf = 10;
  }
  return nf * Math.pow(10, exp);
}

/** Decimals needed to write `step` exactly, capped at 12. */
function decimalsForStep(step) {
  if (!(typeof step === 'number' && Number.isFinite(step) && step > 0)) return 0;
  let d = 0;
  let s = step;
  while (d < 12 && Math.abs(s - Math.round(s)) > 1e-9 * Math.max(1, Math.abs(s))) {
    s *= 10;
    d += 1;
  }
  return d;
}

/**
 * Compute gridline positions for an axis, on the nice-number ladder, targeting `approxCount`
 * intervals. §9.3.2 asks for 60-110 px spacing; the caller turns pixels into a count.
 *
 * @param {number} min  Axis lower bound (data units).
 * @param {number} max  Axis upper bound (data units). Must exceed `min`.
 * @param {number} [approxCount=6]  Desired number of intervals, 1-100.
 * @returns {{step:number, decimals:number, ticks:number[]}} `ticks` are the gridline values inside
 *          `[min, max]`, ascending. An empty array with `step:0` when the range is degenerate.
 */
export function niceTicks(min, max, approxCount) {
  const out = { step: 0, decimals: 0, ticks: [] };
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return out;
  let count = Math.round(approxCount === undefined ? 6 : approxCount);
  if (!Number.isFinite(count) || count < 1) count = 1;
  if (count > 100) count = 100;

  // Derive the step from the RAW range, not from a nice-rounded range: rounding the range up first
  // (Heckbert's "loose" labelling) assumes the axis is then extended to the nice bounds. Here the
  // bounds are fixed by the data window, so niceNumber(5544, false) = 10000 would yield a 2000 step
  // and leave a 6-tick request with 3 ticks.
  const step = niceNumber((max - min) / count, true);
  if (!(step > 0)) return out;

  out.step = step;
  out.decimals = decimalsForStep(step);
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  const n = last - first;
  if (!Number.isFinite(n) || n < 0 || n > 1000) return out;
  // Snap each tick to the step's own precision: (first+i)*step drifts (3*0.2 = 0.6000000000000001)
  // and a caller comparing a tick against zero or against a data value would miss.
  const snap = Math.min(12, out.decimals + 2);
  for (let i = 0; i <= n; i += 1) out.ticks.push(Number(((first + i) * step).toFixed(snap)));
  return out;
}

/**
 * The unit label for a chart x-axis mode, for the axis title.
 * @param {'volume'|'time'|'cv'} mode
 * @returns {string} `'mL'`, `'min'` or `'CV'`.
 */
export function axisUnitLabel(mode) {
  if (mode === 'time') return 'min';
  if (mode === 'cv') return 'CV';
  return 'mL';
}

/**
 * Format one x-axis tick label. The tick text carries the number only — the unit belongs to the
 * axis title (see {@link axisUnitLabel}) — so a dense axis does not repeat `mL` eleven times.
 *
 * The x-axis mode is deliberately independent of the volume/time display preferences: §9.3.2 fixes
 * the three modes as Volume (mL) / Time (min) / CV, and switching the preference must not silently
 * relabel a chart the user is reading.
 *
 * @param {number} value  Volume mode: mL. Time mode: **seconds** (the canonical unit; it is divided
 *        by 60 here). CV mode: CV.
 * @param {'volume'|'time'|'cv'} mode
 * @param {number} [decimals]  Fixed decimals for the whole axis, normally `niceTicks().decimals`
 *        (adjusted by the caller for the time mode's /60). Omitted, a sensible per-magnitude count
 *        is chosen.
 * @returns {string} The tick text.
 */
export function fmtAxisTick(value, mode, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const v = mode === 'time' ? value / 60 : value;
  if (typeof decimals === 'number' && Number.isFinite(decimals)) return fmtFixed(v, decimals);
  const mag = Math.abs(v);
  if (mag >= 1000) return fmtFixed(v, 0);
  if (mag >= 100) return fmtFixed(v, 0);
  if (mag >= 10) return fmtFixed(v, 1);
  if (mag >= 1) return fmtFixed(v, 2);
  return fmtSig(v, 3);
}

/* =================================================================================================
 * 7. DOM MICRO-HELPERS
 * ===============================================================================================*/

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Apply one attribute-ish key to an element. Shared by `h` and `hSvg`. */
function applyProp(el, key, value, isSvg) {
  if (value === null || value === undefined || value === false) return;

  if (key === 'class' || key === 'className') {
    if (isSvg) el.setAttribute('class', String(value));
    else el.className = String(value);
    return;
  }
  if (key === 'style') {
    if (typeof value === 'string') {
      el.setAttribute('style', value);
    } else {
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (v === null || v === undefined) continue;
        if (k.charCodeAt(0) === 45 /* '-' */) el.style.setProperty(k, String(v));
        else el.style[k] = typeof v === 'number' ? String(v) + 'px' : String(v);
      }
    }
    return;
  }
  if (key === 'dataset') {
    for (const k of Object.keys(value)) {
      if (value[k] === null || value[k] === undefined) continue;
      el.setAttribute('data-' + k, String(value[k]));
    }
    return;
  }
  if (key === 'text') {
    el.textContent = String(value);
    return;
  }
  if (key.length > 2 && key.charCodeAt(0) === 111 /* 'o' */ && key.charCodeAt(1) === 110 /* 'n' */
      && typeof value === 'function') {
    // onClick -> 'click', onPointerDown -> 'pointerdown'
    el.addEventListener(key.slice(2).toLowerCase(), value);
    return;
  }
  if (value === true) {
    el.setAttribute(key, '');
    return;
  }
  el.setAttribute(key, String(value));
}

/** Append one child spec (string, number, Node, array, or nullish) to a parent. */
function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (let i = 0; i < child.length; i += 1) appendChild(parent, child[i]);
    return;
  }
  if (typeof child === 'object' && typeof child.nodeType === 'number') {
    parent.appendChild(child);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

/**
 * Build an HTML element. The whole construction vocabulary of the UI layer, so that no view has to
 * reach for `innerHTML` (§6.24 forbids `innerHTML` after mount, and this makes it unnecessary at
 * mount time too).
 *
 * Recognised `attrs` keys:
 *  - `class` / `className` — string.
 *  - `style` — a string, or an object; numeric object values get `px`, and keys starting with `--`
 *    go through `style.setProperty` so CSS custom properties work.
 *  - `dataset` — an object, written as `data-*` attributes.
 *  - `text` — sets `textContent` (mutually exclusive with children, last write wins).
 *  - `on<Event>` — a function, registered with `addEventListener` on the lowercased event name.
 *  - anything else — `setAttribute`. `true` writes an empty attribute; `false`/`null`/`undefined`
 *    are skipped entirely, so `h('button', { disabled: isDisabled })` does the right thing.
 *
 * @param {string} tag  HTML tag name.
 * @param {object|null} [attrs]  Attribute bag as above.
 * @param {...(Node|string|number|Array|null|undefined|boolean)} children  Appended in order;
 *        nullish and boolean children are skipped so `cond && h(...)` is safe.
 * @returns {HTMLElement} The new element.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) applyProp(el, k, attrs[k], false);
  for (let i = 0; i < children.length; i += 1) appendChild(el, children[i]);
  return el;
}

/**
 * Build an SVG element in the SVG namespace. Same `attrs` vocabulary as {@link h}, except that
 * `class` is always written with `setAttribute` (SVG's `className` is a read-only `SVGAnimatedString`).
 *
 * @param {string} tag  SVG tag name, e.g. `'svg'`, `'path'`, `'g'`.
 * @param {object|null} [attrs]  Attribute bag.
 * @param {...(Node|string|number|Array|null|undefined|boolean)} children  Appended in order.
 * @returns {SVGElement} The new element.
 */
export function hSvg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) applyProp(el, k, attrs[k], true);
  for (let i = 0; i < children.length; i += 1) appendChild(el, children[i]);
  return el;
}

/**
 * Write text into a node **only when it changed**. Every live tag readout goes through this: at
 * 60 fps with ~40 visible tags, skipping the unchanged ones is the difference between 2400 and ~30
 * text mutations per second.
 *
 * @param {Node} node  An element (writes `textContent`) or a text node (writes `nodeValue`).
 * @param {string} s  The new text. Coerced with `String()`.
 * @returns {void}
 */
export function setText(node, s) {
  if (!node) return;
  const next = typeof s === 'string' ? s : String(s);
  if (node.nodeType === 3 /* TEXT_NODE */) {
    if (node.nodeValue !== next) node.nodeValue = next;
  } else if (node.textContent !== next) {
    node.textContent = next;
  }
}

/**
 * Write an attribute only when it changed; `null`/`undefined` removes it.
 *
 * @param {Element} node  Target element.
 * @param {string} k  Attribute name.
 * @param {string|number|null|undefined} v  New value, or nullish to remove.
 * @returns {void}
 */
export function setAttr(node, k, v) {
  if (!node) return;
  if (v === null || v === undefined) {
    if (node.hasAttribute(k)) node.removeAttribute(k);
    return;
  }
  const next = typeof v === 'string' ? v : String(v);
  if (node.getAttribute(k) !== next) node.setAttribute(k, next);
}

/**
 * Add or remove a class. A thin, null-safe wrapper over `classList.toggle(name, force)`.
 *
 * @param {Element} node  Target element.
 * @param {string} name  Class name.
 * @param {boolean} on  Truthy adds, falsy removes.
 * @returns {void}
 */
export function cls(node, name, on) {
  if (!node || !name) return;
  node.classList.toggle(name, !!on);
}

/** container -> Map<key, Element> from the previous reconcile pass. */
const RECONCILE_STATE = new WeakMap();

/**
 * The only diffing algorithm in the application (§6.24): a keyed reconcile of a container's element
 * children against an item array. Used by the method block list, the peak table, the event log, the
 * fraction strip and the alarm banner stack.
 *
 * Elements are created once and then reused across passes; a reorder is `insertBefore` on the
 * existing node, so focus, scroll position and CSS transitions survive it. Items that disappear have
 * their element removed from the DOM.
 *
 * Keys must be unique within one call. A duplicate key is skipped with a console warning rather than
 * corrupting the list (inserting one element twice would silently drop a row).
 *
 * @param {Element} container  The parent. It must contain nothing except the reconciled children.
 * @param {Array<*>} items  The desired contents, in the desired order.
 * @param {(item:*, index:number) => string} keyFn  Stable identity for an item.
 * @param {(item:*, index:number) => Element} createFn  Builds the element for a new key.
 * @param {(el:Element, item:*, index:number) => void} [updateFn]  Writes current values onto an
 *        existing element. Called for new elements too, immediately after `createFn`.
 * @returns {void}
 */
export function reconcileList(container, items, keyFn, createFn, updateFn) {
  if (!container) return;
  const list = items || [];
  const prev = RECONCILE_STATE.get(container) || new Map();
  const next = new Map();
  let cursor = container.firstChild;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const key = String(keyFn(item, i));
    if (next.has(key)) {
      console.warn('format.reconcileList: duplicate key "' + key + '" skipped');
      continue;
    }
    let el = prev.get(key);
    if (!el) el = createFn(item, i);
    if (updateFn) updateFn(el, item, i);
    next.set(key, el);

    if (el === cursor) {
      cursor = cursor.nextSibling;
    } else {
      container.insertBefore(el, cursor);
    }
  }

  for (const [key, el] of prev) {
    if (!next.has(key) && el.parentNode === container) container.removeChild(el);
  }
  RECONCILE_STATE.set(container, next);
}

/* =================================================================================================
 * 8. THEME TOKENS
 * ===============================================================================================*/

/**
 * Every CSS custom property `styles/tokens.css` defines, in one list, because `getComputedStyle`
 * cannot be relied on to enumerate custom properties across engines. Canvas painters
 * (`ui/chart.js`, `ui/pid.js`) resolve colours through this list — a canvas cannot use `var()`.
 *
 * Adding a token to `styles/tokens.css` means adding its name here in the same commit.
 * @type {readonly string[]}
 */
export const THEME_TOKEN_NAMES = Object.freeze([
  // surfaces and lines
  '--bg-0', '--bg-1', '--surface-1', '--surface-2', '--surface-3', '--overlay',
  '--line', '--line-soft', '--line-strong',
  // text
  '--text-1', '--text-2', '--text-3', '--text-inv',
  // accent and status
  '--accent', '--accent-hover', '--accent-press', '--accent-soft',
  '--ok', '--warn', '--alarm', '--info',
  '--ok-soft', '--warn-soft', '--alarm-soft', '--focus',
  // chart furniture. The phase-band tints are named `--phase-band-*` in
  // styles/tokens.css (all four theme blocks); `--band-1..4` below are the
  // separate P&ID species bands and are NOT the same tokens.
  '--grid', '--grid-strong', '--phase-band-a', '--phase-band-b',
  // P&ID
  '--pipe-idle', '--flow-dash', '--valve-closed', '--valve-open',
  '--bed-bead', '--col-glass', '--gradient-front',
  '--band-1', '--band-2', '--band-3', '--band-4',
  // shadows
  '--shadow-1', '--shadow-2',
  // channel palette (§9.3.1) — colour-blind safe, one per trace
  '--ch-uv280', '--ch-uv260', '--ch-uv300', '--ch-cond',
  '--ch-ph', '--ch-pctb', '--ch-press', '--ch-flow',
  // typography, spacing and motion (theme-independent, but canvas text needs them)
  '--font-ui', '--font-num',
  '--fs-9', '--fs-10', '--fs-11', '--fs-12', '--fs-13', '--fs-15', '--fs-18', '--fs-24', '--fs-32',
  '--lh-tight', '--lh-base',
  '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5',
  '--sp-6', '--sp-7', '--sp-8', '--sp-9', '--sp-10',
  '--r-1', '--r-2', '--r-3', '--r-4', '--r-pill',
  '--dur-1', '--dur-2', '--dur-3', '--ease-out', '--ease-inout',
]);

/** Cached token maps, one per theme. Populated once, by `primeThemeTokens`. */
const TOKEN_CACHE = { dark: null, light: null };

/** Read every token off one element's computed style. */
function readTokensFrom(el) {
  const cs = getComputedStyle(el);
  const out = {};
  for (let i = 0; i < THEME_TOKEN_NAMES.length; i += 1) {
    const name = THEME_TOKEN_NAMES[i];
    out[name] = cs.getPropertyValue(name).trim();
  }
  return out;
}

/** True when two token maps are byte-identical, i.e. the probe never picked up a theme. */
function sameTokens(a, b) {
  for (let i = 0; i < THEME_TOKEN_NAMES.length; i += 1) {
    const n = THEME_TOKEN_NAMES[i];
    if (a[n] !== b[n]) return false;
  }
  return true;
}

/**
 * Fill `TOKEN_CACHE` for both themes, once.
 *
 * Strategy A (the §6.25 probe): mount `<div data-theme="light">` and `<div data-theme="dark">`
 * off-screen and read each. This works when `styles/tokens.css` scopes its overrides with a
 * selector that matches any element, e.g. `[data-theme="light"]`.
 *
 * Strategy B (the fallback): if the probes come back identical, the stylesheet scoped its overrides
 * to `:root[data-theme="light"]`, which by definition cannot match a nested `<div>`. In that case
 * flip `data-theme` on the document element twice and restore it. This is safe at boot — it is
 * synchronous within a single task, so the browser never paints an intermediate state — and it is
 * the only way to obtain the inactive theme's values when the selector is root-scoped.
 */
function primeThemeTokens() {
  if (TOKEN_CACHE.dark && TOKEN_CACHE.light) return;
  if (typeof document === 'undefined' || !document.documentElement) {
    const empty = {};
    for (let i = 0; i < THEME_TOKEN_NAMES.length; i += 1) empty[THEME_TOKEN_NAMES[i]] = '';
    TOKEN_CACHE.dark = empty;
    TOKEN_CACHE.light = { ...empty };
    return;
  }

  const parent = document.body || document.documentElement;
  const probeStyle =
    'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;' +
    'visibility:hidden;pointer-events:none';
  const lightProbe = h('div', { 'data-theme': 'light', 'aria-hidden': 'true', style: probeStyle });
  const darkProbe = h('div', { 'data-theme': 'dark', 'aria-hidden': 'true', style: probeStyle });
  parent.appendChild(lightProbe);
  parent.appendChild(darkProbe);
  let light = readTokensFrom(lightProbe);
  let dark = readTokensFrom(darkProbe);
  parent.removeChild(lightProbe);
  parent.removeChild(darkProbe);

  if (sameTokens(light, dark)) {
    const root = document.documentElement;
    const saved = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
    light = readTokensFrom(root);
    root.setAttribute('data-theme', 'dark');
    dark = readTokensFrom(root);
    if (saved === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', saved);
  }

  TOKEN_CACHE.light = light;
  TOKEN_CACHE.dark = dark;
}

/** Which theme the document is actually showing right now. */
function activeTheme() {
  if (typeof document === 'undefined' || !document.documentElement) return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

/**
 * The resolved value of every design token for a given theme.
 *
 * **Both maps are read once and cached.** `getComputedStyle` can only ever return the *currently
 * active* theme, and the token values live in `styles/tokens.css` with no JS representation — so
 * `chart.exportPNG({ theme:'light' })` from a dark session would otherwise have to flip `data-theme`
 * on the live document mid-frame, costing a full style recalc and a visible flash (§6.25). Reading
 * CSS custom properties inside a frame is a layout-thrash trap; never call this per frame. Call it
 * at boot, cache the map on the panel, and refresh only when the theme changes.
 *
 * @param {'dark'|'light'|'current'} theme  `'current'` resolves the document's active theme, taking
 *        `data-theme` first and `prefers-color-scheme` when the attribute is absent.
 * @returns {{[cssVarName:string]: string}} A cached map; treat it as read-only. Keys are the full
 *          custom-property names including the leading `--`. Missing tokens map to `''`.
 */
export function readThemeTokens(theme) {
  primeThemeTokens();
  const key = theme === 'current' || theme === undefined ? activeTheme() : theme;
  return TOKEN_CACHE[key === 'light' ? 'light' : 'dark'];
}

/**
 * Drop the cached token maps so the next {@link readThemeTokens} re-reads them from the stylesheet.
 * Needed only if a stylesheet is swapped or a `prefers-contrast` block changes the token values at
 * runtime; a plain theme toggle does **not** need it, because both maps are already cached.
 * @returns {void}
 */
export function invalidateThemeTokens() {
  TOKEN_CACHE.dark = null;
  TOKEN_CACHE.light = null;
}
