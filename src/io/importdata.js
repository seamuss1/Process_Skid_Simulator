/**
 * src/io/importdata.js — bring your own data: read a historian export of a real loop, work out
 * what is in it, and run the whole analysis suite on it.
 *
 * Layer L4: imports `core/util.js`, `control/autotune.js`, `control/analysis.js` and
 * `control/diagnostics.js`. No DOM — every function here takes text or arrays and returns a
 * value, so the entire import path is testable under Node with no browser at all.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT THIS TURNS THE SIMULATOR INTO
 *
 * Everything else in this repository is an argument made on a simulated plant, where the answer
 * is known because the plant was written down. That is the right way to LEARN identification and
 * tuning, and it is worth nothing on the Tuesday afternoon when someone has a CSV of a loop that
 * hunts and forty minutes to say why.
 *
 * So: the same relay-free identification, the same Bode margins, the same oscillation detector,
 * Harris index and stiction estimator, pointed at a file. Nothing in `control/` needed changing
 * to do it, which is the point — those modules were always given arrays.
 *
 * ------------------------------------------------------------------------------------------
 * THE FILE IS NOT THE DATA
 *
 * A historian export is a lossy, ambiguous rendering of what the DCS saw, and every one of the
 * following is normal rather than exotic:
 *
 *   · the delimiter is a semicolon, because the workstation was German, and so the decimal point
 *     is a comma
 *   · the columns are called `PIC101.PV (barg)`, `Tag2`, or nothing useful at all, in any order
 *   · the timestamps are day-first, or month-first, or Excel serial days, or epoch milliseconds
 *   · the sample period is 1 s in places and 47 s in others, because the historian only stored a
 *     value when it changed by more than the compression deadband
 *   · there are gaps where the collector was down, and duplicate timestamps where it caught up
 *   · the values are quantised to the resolution of the archive, sections are frozen, and the
 *     output spent an hour hard against 100%
 *
 * Every one of those changes the answer, and a tool that silently absorbs them and prints a
 * confident model is worse than no tool. So this module detects each of them and SAYS SO, and the
 * report carries the caveats next to the numbers they apply to.
 *
 * ------------------------------------------------------------------------------------------
 * THE MOST IMPORTANT FUNCTION IN THE MODULE IS THE ONE THAT REFUSES
 *
 * {@link assessExcitation}. Identification is only possible where the data contains a question
 * the process has answered: the output has to have MOVED, by more than the noise and more than
 * the archive's resolution, and the measurement has to have moved with it. A quiet hour of a loop
 * sitting on setpoint contains no information about the process dynamics whatsoever — and a least
 * squares fit will nonetheless return a model, with a gain, a lag and a dead time, all of them
 * fitted to transmitter noise, and all of them wrong in a way nobody downstream can see.
 *
 * Telling an engineer "there is nothing in this file to identify a model from, go and capture a
 * step" is a better answer than any model this module could otherwise hand them. It is also the
 * answer they will not get from a spreadsheet, which is the entire reason to write this.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { fitFOPDT, modelRules, tuningRules, rankTunings } from '../control/autotune.js';
import { loopResponse, margins, predictStep, logspace } from '../control/analysis.js';
import { createDiagnostics, pushSample, analyse as analyseLoop } from '../control/diagnostics.js';

// =============================================================================================
// Tables
// =============================================================================================

/** The roles a column can be given. */
export const ROLE = Object.freeze({
  TIME: 'time',
  PV: 'pv',
  SP: 'sp',
  OP: 'op',
  IGNORE: 'ignore',
});

/** Delimiters worth sniffing for, most likely first. */
export const DELIMITERS = Object.freeze([',', ';', '\t', '|']);

/**
 * Timestamp shapes historians actually emit.
 *
 * Deliberately NOT `new Date(string)`: that parser is implementation-defined for everything
 * except ISO 8601, and it silently succeeds on strings it has guessed at. A wrong guess about
 * `03/11/2024` is eight months of error in a sample period, which is exactly the kind of failure
 * that produces a confident answer to the wrong question.
 */
export const TIME_FORMATS = Object.freeze([
  Object.freeze({ id: 'iso', label: 'ISO 8601 (2024-03-11T08:15:00)' }),
  Object.freeze({ id: 'ymd', label: 'year-first (2024/03/11 08:15:00)' }),
  Object.freeze({ id: 'dmy', label: 'day-first (11/03/2024 08:15:00)' }),
  Object.freeze({ id: 'mdy', label: 'month-first (03/11/2024 08:15:00)' }),
  Object.freeze({ id: 'dmon', label: 'day-month-name (11-Mar-2024 08:15:00)' }),
  Object.freeze({ id: 'hms', label: 'time of day only (08:15:00)' }),
  Object.freeze({ id: 'epoch_s', label: 'epoch seconds' }),
  Object.freeze({ id: 'epoch_ms', label: 'epoch milliseconds' }),
  Object.freeze({ id: 'excel', label: 'Excel serial day' }),
  Object.freeze({ id: 'elapsed_s', label: 'elapsed seconds' }),
]);

/** Month names, for the `11-Mar-2024` family. */
const MONTHS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

/**
 * Header words that name a role, with the weight each carries.
 *
 * Weighted rather than boolean because the vocabulary genuinely collides: `CV` is the controlled
 * variable in one textbook and the control valve in the next, and `demand` is a setpoint on a
 * flow loop and an output on a speed loop. A weak match loses to the behavioural test below,
 * which is the right precedence — what a column DOES is evidence, what it is called is a hint.
 */
const NAME_PATTERNS = Object.freeze({
  time: Object.freeze([
    [/^(time|timestamp|datetime|date ?time|date|stamp|ts)$/i, 10],
    [/\b(timestamp|datetime|date)\b/i, 6],
    [/\b(time|utc|local ?time)\b/i, 4],
  ]),
  sp: Object.freeze([
    [/^(sp|setpoint|set ?point|target)$/i, 10],
    [/[._\-\s](sp|setpoint|set ?point)\b/i, 8],
    [/\b(setpoint|set ?point)\b/i, 8],
    [/\bsp\b/i, 6],
    [/\b(target|reference|ref)\b/i, 4],
    [/sp(\b|_|$)/i, 3],
  ]),
  pv: Object.freeze([
    [/^(pv|process ?value|process ?variable|measurement)$/i, 10],
    [/[._\-\s]pv\b/i, 8],
    [/\b(process ?value|process ?variable|measured|measurement)\b/i, 8],
    [/\bpv\b/i, 6],
    [/\b(meas|actual|feedback)\b/i, 4],
    [/pv(\b|_|$)/i, 3],
  ]),
  op: Object.freeze([
    [/^(op|out|output|co|mv)$/i, 10],
    [/[._\-\s](op|out|output|co|mv)\b/i, 8],
    [/\b(controller ?output|control ?output|valve ?position|manipulated)\b/i, 8],
    [/\b(output|op|co|mv)\b/i, 6],
    [/\b(valve|opening|cv|demand|speed ?ref)\b/i, 3],
    [/(op|out)(\b|_|$)/i, 3],
  ]),
});

/** Below this many samples nothing in the analysis suite has anything to say. */
const MIN_SAMPLES = 120;
/** A gap in the record wider than this many sample periods breaks the series into segments. */
const GAP_FACTOR = 2.5;
/** Diffs further than this fraction from the median period make the record non-uniform. */
const UNIFORM_TOL = 0.05;
/** Identification decimates to at most this many samples; the grid search is O(samples). */
const IDENT_MAX_SAMPLES = 6000;

// =============================================================================================
// Numbers
// =============================================================================================

/** A bare number, after the separators have been normalised away. */
const NUMERIC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Parse one cell as a number under a stated decimal convention.
 *
 * Thousands separators are stripped only where they are unambiguous — `1.234.567,8` under a comma
 * convention, `1,234.5` under a dot one. A lone dot in a comma-decimal file is treated as a
 * decimal point rather than as grouping, because mixed exports are common and reading `0.5` as
 * `5` is the worst available outcome.
 *
 * @param {*} raw the cell text
 * @param {string} [decimal='.'] the decimal separator, '.' or ','
 * @returns {number} the value, or NaN when the cell is not a number
 */
export function parseNumber(raw, decimal = '.') {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim();
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (!s) return NaN;
  // Unicode minus, thin spaces and apostrophes are all used as separators by real exporters.
  s = s.replace(/−/g, '-').replace(/[\s ']/g, '');
  if (decimal === ',') {
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^[+-]?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  } else if (s.includes(',')) {
    s = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s;
  }
  return NUMERIC_RE.test(s) ? Number.parseFloat(s) : NaN;
}

/**
 * Sorted copy of the finite values of a series.
 * @param {ArrayLike<number>} x the samples
 * @returns {Float64Array} the finite samples, ascending
 */
function sortedFinite(x) {
  const out = [];
  for (let i = 0; i < x.length; i += 1) if (Number.isFinite(x[i])) out.push(x[i]);
  out.sort((a, b) => a - b);
  return Float64Array.from(out);
}

/**
 * A percentile of an already-sorted series.
 * @param {Float64Array} sorted ascending samples
 * @param {number} p the percentile, 0..1
 * @returns {number} the value, or NaN when there are none
 */
function pct(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const i = clamp(Math.round(p * (n - 1)), 0, n - 1);
  return sorted[i];
}

/**
 * The median of a plain array of numbers.
 * @param {number[]} xs the values
 * @returns {number} the median, or NaN when empty
 */
function median(xs) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Robust noise amplitude of a series, from its second differences.
 *
 * The second difference annihilates any straight line, so a ramp, a slow trend and a step's flat
 * approaches all contribute nothing; what survives is the sample-to-sample wobble. Taking the
 * MEDIAN of it rather than the mean is what keeps the steps themselves — which are enormous in
 * second difference — from being counted as noise. For white noise of standard deviation sigma
 * the second difference has standard deviation sigma*sqrt(6), hence the constant.
 *
 * @param {ArrayLike<number>} x the samples
 * @returns {number} the estimated noise standard deviation, in the units of x
 */
export function noiseLevel(x) {
  const n = x.length;
  if (n < 8) return 0;
  const d = [];
  for (let i = 2; i < n; i += 1) {
    const v = x[i] - 2 * x[i - 1] + x[i - 2];
    if (Number.isFinite(v)) d.push(Math.abs(v));
  }
  // 1.4826 turns a median absolute deviation into a standard deviation for Gaussian data.
  return (median(d) * 1.4826) / Math.sqrt(6);
}

// =============================================================================================
// Timestamps
// =============================================================================================

const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const RE_YMD = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})[T ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?$/;
const RE_SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?$/;
const RE_DMON = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?$/;
const RE_HMS = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?$/;

/**
 * Assemble a UTC instant.
 *
 * NAIVE TIMESTAMPS ARE READ AS UTC, deliberately. A historian export with no offset carries no
 * zone, and reading it in the machine's local zone makes the result depend on where the browser
 * is sitting — and inserts a one-hour gap or a one-hour duplicate every time the record crosses a
 * daylight-saving boundary. Since everything downstream uses only DIFFERENCES between timestamps,
 * a consistent fiction is exactly right and a locally-correct answer is actively harmful.
 *
 * @param {number} y year
 * @param {number} mo month, 1-12
 * @param {number} d day
 * @param {number} h hour
 * @param {number} mi minute
 * @param {number} s second
 * @param {number} frac fractional seconds
 * @param {string} [tz] an explicit offset, 'Z' or '+HH:MM'
 * @returns {number} milliseconds since the epoch, or NaN
 */
function utcOf(y, mo, d, h, mi, s, frac, tz) {
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31) || !(h >= 0 && h <= 23)) return NaN;
  let ms = Date.UTC(y, mo - 1, d, h, mi, s, Math.round(frac * 1000));
  if (tz && tz !== 'Z' && tz !== 'z') {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
    if (m) {
      const off = (Number(m[2]) * 60 + Number(m[3])) * (m[1] === '-' ? -1 : 1);
      ms -= off * 60000;
    }
  }
  return ms;
}

/**
 * Two-digit years, the way every historian resolves them: 70..99 are 1900s, 00..69 are 2000s.
 * @param {number} y the year as written
 * @returns {number} the four-digit year
 */
function fullYear(y) {
  if (y >= 100) return y;
  return y >= 70 ? 1900 + y : 2000 + y;
}

/**
 * Parse one timestamp cell in a stated format.
 *
 * @param {*} raw the cell text
 * @param {string} format one of the {@link TIME_FORMATS} ids
 * @param {object} [opts] options
 * @param {string} [opts.decimal='.'] decimal separator, for the numeric formats
 * @returns {number} milliseconds since the epoch, or NaN
 */
export function parseTimestamp(raw, format, opts = {}) {
  if (raw === null || raw === undefined) return NaN;
  let s = String(raw).trim().replace(/^"|"$/g, '').trim();
  if (!s) return NaN;
  const dec = opts.decimal || '.';
  let m;
  switch (format) {
    case 'iso':
      m = RE_ISO.exec(s);
      if (!m) return NaN;
      return utcOf(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]),
        Number(m[6] || 0), m[7] ? Number(`0.${m[7]}`) : 0, m[8]);
    case 'ymd':
      m = RE_YMD.exec(s);
      if (!m) return NaN;
      return utcOf(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]),
        Number(m[6] || 0), m[7] ? Number(`0.${m[7]}`) : 0);
    case 'dmy':
    case 'mdy': {
      m = RE_SLASH.exec(s);
      if (!m) return NaN;
      const a = Number(m[1]);
      const b = Number(m[2]);
      const day = format === 'dmy' ? a : b;
      const mon = format === 'dmy' ? b : a;
      return utcOf(fullYear(Number(m[3])), mon, day, Number(m[4] || 0), Number(m[5] || 0),
        Number(m[6] || 0), m[7] ? Number(`0.${m[7]}`) : 0);
    }
    case 'dmon': {
      m = RE_DMON.exec(s);
      if (!m) return NaN;
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (!mon) return NaN;
      return utcOf(fullYear(Number(m[3])), mon, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0),
        Number(m[6] || 0), m[7] ? Number(`0.${m[7]}`) : 0);
    }
    case 'hms': {
      m = RE_HMS.exec(s);
      if (!m) return NaN;
      const h = Number(m[1]);
      if (h > 47) return NaN;
      return ((h * 3600) + Number(m[2]) * 60 + Number(m[3] || 0)) * 1000
        + (m[4] ? Number(`0.${m[4]}`) * 1000 : 0);
    }
    case 'epoch_s': {
      const v = parseNumber(s, dec);
      return Number.isFinite(v) ? v * 1000 : NaN;
    }
    case 'epoch_ms': {
      const v = parseNumber(s, dec);
      return Number.isFinite(v) ? v : NaN;
    }
    case 'excel': {
      // Excel's day zero is 1899-12-30, which is not a typo: the 1900 leap-year bug in the
      // original spreadsheet is preserved by every tool that has read one since.
      const v = parseNumber(s, dec);
      return Number.isFinite(v) ? (v - 25569) * 86400000 : NaN;
    }
    case 'elapsed_s': {
      const v = parseNumber(s, dec);
      return Number.isFinite(v) ? v * 1000 : NaN;
    }
    default:
      return NaN;
  }
}

/**
 * How well a series of timestamps behaves: ascending, and how uniform its steps are.
 * @param {number[]} ms the parsed instants
 * @returns {{monotone:boolean, uniformity:number, period_ms:number}} the assessment
 */
function timeQuality(ms) {
  const diffs = [];
  let monotone = true;
  for (let i = 1; i < ms.length; i += 1) {
    const d = ms[i] - ms[i - 1];
    if (d < 0) monotone = false;
    if (d > 0) diffs.push(d);
  }
  const p = median(diffs);
  if (!(p > 0)) return { monotone, uniformity: 0, period_ms: NaN };
  let inside = 0;
  for (const d of diffs) if (Math.abs(d - p) <= UNIFORM_TOL * p) inside += 1;
  return { monotone, uniformity: inside / diffs.length, period_ms: p };
}

/**
 * Work out which timestamp format a column is in.
 *
 * The slash formats are genuinely ambiguous — `03/11/2024` is the eleventh of March in Frankfurt
 * and the third of November in Houston — and no amount of staring at one cell settles it. Three
 * things are tried, in order of how much they prove: a day component above 12 anywhere in the
 * column decides it outright; failing that, the reading that produces an ASCENDING series wins,
 * because a record that jumps backwards is not a record; and failing that, the more uniform
 * sample period wins. When it comes down to the last of those the choice is reported as an
 * assumption rather than a finding, because that is what it is.
 *
 * @param {string[]} cells the column's cells, in file order
 * @param {object} [opts] options
 * @param {string} [opts.decimal='.'] decimal separator, for numeric formats
 * @param {boolean} [opts.namedTime=false] whether the header calls this column a time
 * @returns {{ok:boolean, format?:string, reason?:string, warnings:string[], parsedFraction:number}}
 *   the detection
 */
export function detectTimeFormat(cells, opts = {}) {
  const warnings = [];
  const sample = cells.filter((c) => String(c).trim() !== '');
  if (sample.length < 3) return { ok: false, reason: 'too few rows to identify a time column', warnings, parsedFraction: 0 };
  const dec = opts.decimal || '.';

  /**
   * Try one format across the sample.
   * @param {string} id the format id
   * @returns {{id:string, frac:number, ms:number[]}} how well it parsed
   */
  const tryFormat = (id) => {
    const ms = [];
    let good = 0;
    for (const c of sample) {
      const v = parseTimestamp(c, id, { decimal: dec });
      if (Number.isFinite(v)) { good += 1; ms.push(v); } else ms.push(NaN);
    }
    return { id, frac: good / sample.length, ms };
  };

  for (const id of ['iso', 'ymd', 'dmon']) {
    const r = tryFormat(id);
    if (r.frac >= 0.95) return { ok: true, format: id, warnings, parsedFraction: r.frac };
  }

  // The slash family. Decide day-first against month-first on evidence, not on locale.
  const slash = sample.filter((c) => RE_SLASH.test(String(c).trim()));
  if (slash.length >= 0.95 * sample.length) {
    let firstOver12 = false;
    let secondOver12 = false;
    for (const c of sample) {
      const m = RE_SLASH.exec(String(c).trim());
      if (!m) continue;
      if (Number(m[1]) > 12) firstOver12 = true;
      if (Number(m[2]) > 12) secondOver12 = true;
    }
    if (firstOver12 && secondOver12) {
      return {
        ok: false,
        reason: 'the date column contains both a first component above 12 and a second component '
          + 'above 12, so no single day/month order reads the whole file. Split the export, or '
          + 'ask the historian for ISO timestamps.',
        warnings,
        parsedFraction: 0,
      };
    }
    if (firstOver12) return { ok: true, format: 'dmy', warnings, parsedFraction: 1 };
    if (secondOver12) return { ok: true, format: 'mdy', warnings, parsedFraction: 1 };
    const d = timeQuality(tryFormat('dmy').ms);
    const m = timeQuality(tryFormat('mdy').ms);
    let pick = 'dmy';
    if (d.monotone !== m.monotone) pick = d.monotone ? 'dmy' : 'mdy';
    else if (Math.abs(d.uniformity - m.uniformity) > 1e-9) pick = d.uniformity > m.uniformity ? 'dmy' : 'mdy';
    else {
      // Both readings give the same instants: the record does not cross midnight, so the order
      // cannot matter to anything downstream. Say nothing rather than raise a false worry.
      return { ok: true, format: 'dmy', warnings, parsedFraction: 1 };
    }
    warnings.push(`The dates are ambiguous — no day above 12 appears anywhere — so they have been `
      + `read as ${pick === 'dmy' ? 'day-first (11/03 = 11 March)' : 'month-first (03/11 = 3 November)'}, `
      + 'which is the reading that keeps the record in order. Check it against the shift log if '
      + 'the total duration matters to you.');
    return { ok: true, format: pick, warnings, parsedFraction: 1 };
  }

  const hms = tryFormat('hms');
  if (hms.frac >= 0.95) {
    warnings.push('The time column carries a time of day with no date. Anything spanning midnight '
      + 'will look like a jump backwards; the analysis uses the longest unbroken stretch.');
    return { ok: true, format: 'hms', warnings, parsedFraction: hms.frac };
  }

  // Numeric time columns: epoch, Excel serial, or plain elapsed seconds.
  const nums = sample.map((c) => parseNumber(c, dec));
  const finite = nums.filter((v) => Number.isFinite(v));
  if (finite.length >= 0.95 * sample.length) {
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    let ascending = true;
    for (let i = 1; i < nums.length; i += 1) if (nums[i] < nums[i - 1]) { ascending = false; break; }
    if (!ascending && !opts.namedTime) {
      return { ok: false, reason: 'the column does not increase, so it is not a time', warnings, parsedFraction: 0 };
    }
    if (lo > 1e11) return { ok: true, format: 'epoch_ms', warnings, parsedFraction: 1 };
    if (lo > 1e8) return { ok: true, format: 'epoch_s', warnings, parsedFraction: 1 };
    if (lo > 20000 && hi < 80000) {
      warnings.push('The time column looks like an Excel serial day number — the spreadsheet has '
        + 'already eaten the timestamps once. Values are read as days since 1899-12-30.');
      return { ok: true, format: 'excel', warnings, parsedFraction: 1 };
    }
    if (ascending) {
      warnings.push('The time column has no date in it and has been read as elapsed seconds.');
      return { ok: true, format: 'elapsed_s', warnings, parsedFraction: 1 };
    }
  }
  return { ok: false, reason: 'no recognised timestamp format', warnings, parsedFraction: 0 };
}

// =============================================================================================
// The file
// =============================================================================================

/**
 * Split a file into lines, tolerating any of the three line endings and a byte-order mark.
 * @param {string} text the file
 * @returns {string[]} the lines, with trailing blanks dropped
 */
function splitLines(text) {
  const t = text.replace(/^﻿/, '');
  const lines = t.split(/\r\n|\n|\r/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/**
 * Split one line into fields, honouring RFC 4180 double quoting.
 *
 * Quoting is not a nicety here: a comma-decimal file exported by a tool that knew it was writing
 * CSV will quote every value, and that is the only thing that makes `"1,5","2,5"` readable at all.
 *
 * @param {string} line the line
 * @param {string} delim the delimiter
 * @returns {string[]} the fields, trimmed
 */
export function splitRow(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Whether a cell could be data of some sort — a number under this convention, a timestamp, or
 * empty. Used only for scoring a candidate dialect.
 * @param {string} cell the cell
 * @param {string} decimal the decimal separator
 * @returns {boolean} whether it parses as something
 */
function looksLikeData(cell, decimal) {
  const s = cell.trim();
  if (!s) return true;
  if (Number.isFinite(parseNumber(s, decimal))) return true;
  return RE_ISO.test(s) || RE_YMD.test(s) || RE_SLASH.test(s) || RE_DMON.test(s) || RE_HMS.test(s);
}

/**
 * Work out the delimiter, the decimal separator and where the header row is.
 *
 * Every candidate pair is parsed all the way through and scored on what it PRODUCES — a constant
 * field count, and cells that read as numbers or timestamps. Scoring the outcome rather than
 * counting separator characters is what settles the case the character count cannot: in
 * `1,5;2,5` both the comma and the semicolon appear once per line, and only one of them leaves
 * two readable numbers behind.
 *
 * @param {string} text the file
 * @returns {{ok:boolean, reason?:string, delimiter?:string, decimal?:string, headerIndex?:number,
 *   fieldCount?:number, rows?:string[][], preamble?:string[], warnings:string[]}} the dialect
 */
export function sniffDialect(text) {
  const warnings = [];
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'the file is empty', warnings };
  }
  const lines = splitLines(text).filter((l) => l.trim() !== '' && !/^\s*[#]/.test(l));
  if (lines.length < 3) {
    return { ok: false, reason: 'the file has fewer than three lines — there is nothing to analyse', warnings };
  }

  let best = null;
  for (const delim of DELIMITERS) {
    const rows = lines.map((l) => splitRow(l, delim));
    // The modal field count, over the rows that have more than one field.
    const counts = new Map();
    for (const r of rows) if (r.length > 1) counts.set(r.length, (counts.get(r.length) || 0) + 1);
    let mode = 0;
    let modeN = 0;
    for (const [k, v] of counts) if (v > modeN || (v === modeN && k > mode)) { mode = k; modeN = v; }
    if (mode < 2 || modeN < Math.max(3, 0.5 * rows.length)) continue;
    const body = rows.filter((r) => r.length === mode);
    for (const decimal of ['.', ',']) {
      // A comma decimal inside a comma-delimited file is only possible when the values are
      // quoted; if none of them are, do not entertain the combination.
      if (decimal === ',' && delim === ',' && !/"/.test(text)) continue;
      let cells = 0;
      let good = 0;
      let commaCells = 0;
      for (let i = 1; i < body.length; i += 1) {
        for (const c of body[i]) {
          cells += 1;
          if (looksLikeData(c, decimal)) good += 1;
          if (/^[+-]?\d+,\d+$/.test(c)) commaCells += 1;
        }
      }
      if (!cells) continue;
      const frac = good / cells;
      // Prefer the convention the data actually uses: a file full of `1,5` cells is comma-decimal
      // whichever way it also happens to parse.
      const commaBonus = decimal === ',' ? (commaCells / cells) * 0.5 : 0;
      const score = frac + commaBonus + (modeN / rows.length) * 0.25 + Math.min(mode, 6) * 0.01;
      if (!best || score > best.score) {
        best = { score, delim, decimal, rows: body, mode, frac };
      }
    }
  }

  if (!best || best.frac < 0.6) {
    return {
      ok: false,
      reason: 'no delimiter reads this file as a table of numbers. Check that it is a CSV export '
        + 'and not a report, a PDF print or a spreadsheet saved in its native format.',
      warnings,
    };
  }

  // The header is the first row whose cells are mostly NOT data. A headerless file is legal and
  // common from a database dump, and gets synthetic names.
  let headerIndex = -1;
  for (let i = 0; i < Math.min(best.rows.length, 20); i += 1) {
    const r = best.rows[i];
    let dataish = 0;
    for (const c of r) if (c !== '' && looksLikeData(c, best.decimal)) dataish += 1;
    if (dataish <= Math.floor(r.length / 2)) { headerIndex = i; break; }
    if (dataish > 0) break;
  }
  if (headerIndex < 0) {
    warnings.push('The file has no header row, so the columns were identified from their '
      + 'behaviour alone. Check the mapping before you trust the report.');
  }
  const preamble = headerIndex > 0 ? best.rows.slice(0, headerIndex).map((r) => r.join(best.delim)) : [];
  if (preamble.length) {
    warnings.push(`${preamble.length} line${preamble.length === 1 ? '' : 's'} of export preamble `
      + 'above the header were skipped.');
  }

  return {
    ok: true,
    delimiter: best.delim,
    decimal: best.decimal,
    headerIndex,
    fieldCount: best.mode,
    rows: best.rows,
    preamble,
    warnings,
  };
}

/**
 * Pull an engineering unit out of a column header.
 * @param {string} header the header cell
 * @returns {{name:string, unit:string}} the name with the unit removed, and the unit
 */
export function splitHeaderUnit(header) {
  const s = String(header || '').trim();
  const m = /^(.*?)[\s]*[([{]\s*([^)\]}]{1,16})\s*[)\]}]\s*$/.exec(s);
  if (m && m[1].trim()) return { name: m[1].trim(), unit: m[2].trim() };
  return { name: s, unit: '' };
}

/**
 * Descriptive statistics that the behavioural column mapping and the quality checks both need.
 * @param {Float64Array} x the samples
 * @returns {object} the statistics
 */
export function columnStats(x) {
  const sorted = sortedFinite(x);
  const n = sorted.length;
  if (!n) {
    return { n: 0, min: NaN, max: NaN, range: 0, mean: NaN, sd: 0, levels: 0, flatFraction: 0, noise: 0, quantum: 0 };
  }
  const min = sorted[0];
  const max = sorted[n - 1];
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += sorted[i];
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i += 1) v += (sorted[i] - mean) ** 2;
  // Distinct levels, and the smallest step between adjacent ones — the archive's resolution when
  // the signal is quantised, and meaningless noise when it is not.
  let levels = 1;
  const steps = [];
  for (let i = 1; i < n; i += 1) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 1e-12) { levels += 1; steps.push(d); }
  }
  let flat = 0;
  let held = 0;
  for (let i = 1; i < x.length; i += 1) if (x[i] === x[i - 1]) { flat += 1; held += 1; }
  return {
    n,
    min,
    max,
    range: max - min,
    p1: pct(sorted, 0.01),
    p99: pct(sorted, 0.99),
    mean,
    sd: Math.sqrt(v / n),
    levels,
    flatFraction: x.length > 1 ? flat / (x.length - 1) : 0,
    held,
    noise: noiseLevel(x),
    quantum: steps.length ? median(steps) : 0,
  };
}

/**
 * Parse a file into typed columns.
 *
 * @param {string} text the file
 * @param {object} [opts] options
 * @param {string} [opts.delimiter] force the delimiter
 * @param {string} [opts.decimal] force the decimal separator
 * @returns {{ok:boolean, reason?:string, dialect?:object, columns?:Array<object>,
 *   rowCount?:number, warnings:string[]}} the parsed table
 */
export function parseTable(text, opts = {}) {
  const sniff = sniffDialect(text);
  if (!sniff.ok) return { ok: false, reason: sniff.reason, warnings: sniff.warnings };
  const delimiter = opts.delimiter || sniff.delimiter;
  const decimal = opts.decimal || sniff.decimal;
  const warnings = sniff.warnings.slice();

  // Re-split when the caller overrode the dialect, so a corrected choice actually takes effect.
  let rows = sniff.rows;
  let headerIndex = sniff.headerIndex;
  if (delimiter !== sniff.delimiter) {
    const re = sniffDialect(text);
    rows = splitLines(text).filter((l) => l.trim() !== '').map((l) => splitRow(l, delimiter));
    const mode = median(rows.map((r) => r.length));
    rows = rows.filter((r) => r.length === mode);
    headerIndex = re.ok ? Math.min(re.headerIndex, rows.length - 1) : 0;
  }

  const header = headerIndex >= 0 ? rows[headerIndex] : null;
  const body = rows.slice(headerIndex >= 0 ? headerIndex + 1 : 0);
  if (body.length < 3) return { ok: false, reason: 'the file has no data rows below its header', warnings };

  const width = header ? header.length : body[0].length;
  const columns = [];
  for (let c = 0; c < width; c += 1) {
    const raw = body.map((r) => (r[c] === undefined ? '' : r[c]));
    const { name, unit } = header
      ? splitHeaderUnit(header[c])
      : { name: `column ${c + 1}`, unit: '' };
    const values = new Float64Array(raw.length);
    let numeric = 0;
    let nonEmpty = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const v = parseNumber(raw[i], decimal);
      values[i] = v;
      if (raw[i].trim() !== '') nonEmpty += 1;
      if (Number.isFinite(v)) numeric += 1;
    }
    const numericFraction = nonEmpty ? numeric / nonEmpty : 0;
    columns.push({
      index: c,
      header: header ? header[c] : `column ${c + 1}`,
      name,
      unit,
      raw,
      values,
      numericFraction,
      kind: numericFraction >= 0.9 ? 'number' : 'text',
      stats: numericFraction >= 0.9 ? columnStats(values) : null,
    });
  }

  return {
    ok: true,
    dialect: { delimiter, decimal, headerIndex, hasHeader: headerIndex >= 0, preamble: sniff.preamble },
    columns,
    rowCount: body.length,
    warnings,
  };
}

// =============================================================================================
// Which column is which
// =============================================================================================

/**
 * Score a header against the role vocabulary.
 * @param {string} name the column name, unit already removed
 * @returns {{role:string, score:number, runnerUp:number}} the best role and how clear it was
 */
function scoreName(name) {
  let best = { role: ROLE.IGNORE, score: 0 };
  let second = 0;
  for (const role of Object.keys(NAME_PATTERNS)) {
    let s = 0;
    for (const [re, w] of NAME_PATTERNS[role]) if (re.test(name)) s = Math.max(s, w);
    if (s > best.score) { second = best.score; best = { role, score: s }; } else if (s > second) second = s;
  }
  return { role: best.role, score: best.score, runnerUp: second };
}

/**
 * Correlation coefficient of two series.
 * @param {Float64Array} a first series
 * @param {Float64Array} b second series
 * @returns {number} r, or 0 when either is constant
 */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0;
  let sb = 0;
  let m = 0;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    sa += a[i]; sb += b[i]; m += 1;
  }
  if (m < 4) return 0;
  const ma = sa / m;
  const mb = sb / m;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    const da = a[i] - ma;
    const db = b[i] - mb;
    saa += da * da; sbb += db * db; sab += da * db;
  }
  const den = Math.sqrt(saa * sbb);
  return den > 1e-18 ? sab / den : 0;
}

/**
 * Decide which column is the time, the measurement, the setpoint and the output.
 *
 * NAMES FIRST, BEHAVIOUR SECOND, AND THE OPERATOR LAST. A header that says `PIC101.SP` is
 * evidence and is used. A header that says `Tag_2` is not, and then the columns have to be told
 * apart by what they DO, which they can be, because the three signals in a control loop do not
 * behave alike:
 *
 *   THE SETPOINT is piecewise constant. It sits on a value for hours and then jumps. Nothing else
 *   in a loop record is flat for 95% of its samples.
 *   THE MEASUREMENT shares its units with the setpoint — it is the thing being compared to it —
 *   so the two live at the same magnitude, and it is the noisiest of the three because it is the
 *   only one that comes from an instrument.
 *   THE OUTPUT is in percent: bounded by 0 and 100, and usually visiting a fair part of that.
 *
 * Every assignment of columns to roles is scored on those three statements together rather than
 * column by column, because the strongest evidence is a PAIRING — that two of the columns are in
 * the same units and one of them is flat. And whatever comes out, the UI shows it and lets the
 * engineer correct it, which is why a wrong guess here is a nuisance rather than a wrong answer.
 *
 * @param {Array<object>} columns from {@link parseTable}
 * @param {object} [opts] options
 * @param {Record<string,number>} [opts.force] role to column index, overriding everything
 * @returns {{ok:boolean, reason?:string, roles:object, method:object, notes:string[],
 *   timeFormat?:string, warnings:string[]}} the mapping
 */
export function mapColumns(columns, opts = {}) {
  const notes = [];
  const warnings = [];
  const force = opts.force || {};
  const method = {};
  const roles = { time: -1, pv: -1, sp: -1, op: -1 };

  for (const role of Object.keys(roles)) {
    if (Number.isInteger(force[role]) && force[role] >= 0 && force[role] < columns.length) {
      roles[role] = force[role];
      method[role] = 'operator';
    }
  }

  // ---- the time column ------------------------------------------------------------------------
  let timeFormat = null;
  if (roles.time < 0) {
    const named = columns.filter((c) => scoreName(c.name).role === ROLE.TIME
      && scoreName(c.name).score >= 4);
    const candidates = named.length ? named : columns;
    for (const c of candidates) {
      const det = detectTimeFormat(c.raw.slice(0, Math.min(c.raw.length, 400)), {
        decimal: opts.decimal, namedTime: named.includes(c),
      });
      if (det.ok) {
        roles.time = c.index;
        timeFormat = det.format;
        method.time = named.includes(c) ? 'name' : 'behaviour';
        for (const w of det.warnings) warnings.push(w);
        break;
      }
    }
  } else {
    const det = detectTimeFormat(columns[roles.time].raw.slice(0, 400), { decimal: opts.decimal, namedTime: true });
    if (!det.ok) return { ok: false, reason: `the chosen time column cannot be read: ${det.reason}`, roles, method, notes, warnings };
    timeFormat = det.format;
    for (const w of det.warnings) warnings.push(w);
  }
  if (roles.time < 0) {
    return {
      ok: false,
      reason: 'no column in this file reads as a timestamp or an elapsed time. Without a time base '
        + 'there is no sample period, and without a sample period nothing here can be identified.',
      roles,
      method,
      notes,
      warnings,
    };
  }

  // ---- the three signals ----------------------------------------------------------------------
  const numeric = columns.filter((c) => c.kind === 'number' && c.index !== roles.time
    && c.stats && c.stats.range > 0);
  if (numeric.length < 2) {
    return {
      ok: false,
      reason: `only ${numeric.length} numeric column${numeric.length === 1 ? '' : 's'} in this file `
        + 'actually changes. A loop record needs at least a measurement and an output.',
      roles,
      method,
      notes,
      warnings,
    };
  }

  // Names first.
  const claimed = new Set(Object.values(roles).filter((i) => i >= 0));
  for (const role of ['sp', 'pv', 'op']) {
    if (roles[role] >= 0) continue;
    let best = null;
    for (const c of numeric) {
      if (claimed.has(c.index)) continue;
      const s = scoreName(c.name);
      if (s.role === role && s.score >= 6 && (!best || s.score > best.score)) best = { c, score: s.score };
    }
    if (best) { roles[role] = best.c.index; method[role] = 'name'; claimed.add(best.c.index); }
  }

  // Behaviour for whatever is left.
  const free = numeric.filter((c) => !claimed.has(c.index));
  const missing = ['pv', 'sp', 'op'].filter((r) => roles[r] < 0);
  if (missing.length && free.length) {
    const chosen = assignByBehaviour(free, missing, roles, columns);
    for (const r of Object.keys(chosen)) {
      roles[r] = chosen[r];
      method[r] = 'behaviour';
    }
    notes.push(`${missing.filter((r) => roles[r] >= 0).map((r) => r.toUpperCase()).join(', ')} `
      + 'identified from behaviour rather than from the header — check the mapping.');
  }

  if (roles.pv < 0 || roles.op < 0) {
    return {
      ok: false,
      reason: 'the measurement and the controller output could not both be identified. Name the '
        + 'columns in the mapping and try again.',
      roles,
      method,
      notes,
      warnings,
      timeFormat,
    };
  }
  if (roles.sp < 0) {
    warnings.push('No setpoint column was found. The control error is taken about the mean of the '
      + 'measurement instead, so the loop-health numbers describe how steadily it held whatever '
      + 'it was holding rather than how well it tracked a target.');
  }
  return { ok: true, roles, method, notes, warnings, timeFormat };
}

/**
 * Choose columns for the roles the header could not fill.
 * @param {Array<object>} free the unclaimed numeric columns
 * @param {string[]} missing the roles still to fill
 * @param {object} roles the roles already decided
 * @param {Array<object>} columns every column, for looking up an already-assigned series
 * @returns {Record<string,number>} role to column index
 */
function assignByBehaviour(free, missing, roles, columns) {
  /**
   * How much a column looks like a controller output in percent.
   * @param {object} c the column
   * @returns {number} 0..1
   */
  const opLike = (c) => {
    const st = c.stats;
    const inRange = st.min >= -2 && st.max <= 102 ? 1 : 0;
    const usesRange = clamp(st.range / 40, 0, 1);
    return 0.7 * inRange + 0.3 * usesRange;
  };
  /**
   * How much a column looks like a setpoint: flat for most of the record, few levels.
   * @param {object} c the column
   * @returns {number} 0..1
   */
  const spLike = (c) => {
    const st = c.stats;
    const levelFrac = 1 - clamp(st.levels / Math.max(st.n, 1), 0, 1);
    return 0.6 * clamp(st.flatFraction, 0, 1) + 0.4 * levelFrac;
  };
  /**
   * How much a column looks like an instrument reading: it is the noisy one.
   * @param {object} c the column
   * @returns {number} 0..1
   */
  const pvLike = (c) => {
    const st = c.stats;
    const rough = st.range > 0 ? clamp((st.noise / st.range) * 60, 0, 1) : 0;
    return 0.6 * rough + 0.4 * (1 - clamp(st.flatFraction, 0, 1));
  };

  const pool = free.slice();
  const out = {};
  // Enumerate every assignment of the free columns to the missing roles. There are at most a
  // handful of columns, so exhaustive beats greedy and never paints itself into a corner.
  const perms = [];
  /**
   * Depth-first enumeration of role assignments.
   * @param {number} k which missing role we are filling
   * @param {object} acc the partial assignment
   * @param {Set<number>} used columns already spent
   * @returns {void}
   */
  const walk = (k, acc, used) => {
    if (k === missing.length) { perms.push({ ...acc }); return; }
    for (const c of pool) {
      if (used.has(c.index)) continue;
      used.add(c.index);
      acc[missing[k]] = c.index;
      walk(k + 1, acc, used);
      used.delete(c.index);
      delete acc[missing[k]];
    }
    // Leaving a role unfilled is legal — a two-column export has no setpoint in it.
    if (missing[k] === 'sp') {
      acc[missing[k]] = -1;
      walk(k + 1, acc, used);
      delete acc[missing[k]];
    }
  };
  walk(0, {}, new Set());

  const byIndex = new Map(columns.map((c) => [c.index, c]));
  let best = null;
  for (const p of perms) {
    const pick = { ...roles, ...p };
    const pv = byIndex.get(pick.pv);
    const sp = pick.sp >= 0 ? byIndex.get(pick.sp) : null;
    const op = byIndex.get(pick.op);
    if (!pv || !op || pv.index === op.index) continue;
    let score = pvLike(pv) + opLike(op) + (sp ? spLike(sp) : 0.25);
    // The pairing term, and the strongest single piece of evidence in the file: the measurement
    // and its setpoint are the SAME QUANTITY, so they live at the same magnitude. An output in
    // percent almost never does.
    if (sp) {
      const spread = Math.max(pv.stats.range, sp.stats.range, 1e-9);
      score += 1.2 * Math.exp(-Math.abs(pv.stats.mean - sp.stats.mean) / spread);
      score += 0.6 * Math.abs(correlation(pv.values, sp.values));
      if (spLike(sp) < spLike(pv)) score -= 0.8;   // the flat one is the setpoint, not the PV
    }
    if (best === null || score > best.score) best = { score, pick: p };
  }
  if (best) for (const r of Object.keys(best.pick)) out[r] = best.pick[r];
  return out;
}

// =============================================================================================
// From columns to a dataset
// =============================================================================================

/**
 * Timing of a set of timestamps: period, duplicates, gaps, uniformity.
 * @param {Float64Array} t sample times, s, ascending
 * @returns {object} the timing report
 */
function timing(t) {
  const diffs = [];
  let duplicates = 0;
  let backwards = 0;
  for (let i = 1; i < t.length; i += 1) {
    const d = t[i] - t[i - 1];
    if (d === 0) duplicates += 1;
    else if (d < 0) backwards += 1;
    else diffs.push(d);
  }
  const period = median(diffs);
  let inside = 0;
  for (const d of diffs) if (Math.abs(d - period) <= UNIFORM_TOL * period) inside += 1;
  const gaps = [];
  for (let i = 1; i < t.length; i += 1) {
    const d = t[i] - t[i - 1];
    if (d > GAP_FACTOR * period) {
      gaps.push({ from_s: t[i - 1], to_s: t[i], missing: Math.max(1, Math.round(d / period) - 1) });
    }
  }
  return {
    period_s: period,
    duplicates,
    backwards,
    uniformity: diffs.length ? inside / diffs.length : 0,
    uniform: diffs.length ? inside / diffs.length > 0.98 : false,
    gaps,
    duration_s: t.length ? t[t.length - 1] - t[0] : 0,
  };
}

/**
 * Resample onto a uniform grid.
 *
 * THE THREE SIGNALS ARE NOT INTERPOLATED THE SAME WAY, and the difference matters. The
 * measurement is a continuous physical quantity that was sampled, so a straight line between two
 * samples is the best available guess at what happened in between. The setpoint and the output
 * are not sampled continua at all: they are values a controller HELD until it changed them, and
 * drawing a ramp between two of them invents a movement that never occurred — which the stiction
 * estimator, whose whole method is looking for output travel while the measurement is flat, would
 * then read as evidence.
 *
 * @param {Float64Array} t original times, s, ascending and de-duplicated
 * @param {Record<string,Float64Array>} chans the channels
 * @param {number} period_s the target period
 * @returns {{t:Float64Array, chans:Record<string,Float64Array>}} the resampled series
 */
function resample(t, chans, period_s) {
  const n = Math.max(2, Math.floor((t[t.length - 1] - t[0]) / period_s) + 1);
  const tg = new Float64Array(n);
  const out = {};
  for (const k of Object.keys(chans)) out[k] = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const tt = t[0] + i * period_s;
    tg[i] = tt;
    while (j + 1 < t.length && t[j + 1] <= tt) j += 1;
    const j1 = Math.min(j + 1, t.length - 1);
    const span = t[j1] - t[j];
    const u = span > 0 ? clamp((tt - t[j]) / span, 0, 1) : 0;
    out.pv[i] = chans.pv[j] + (chans.pv[j1] - chans.pv[j]) * u;
    if (chans.sp) out.sp[i] = chans.sp[j];
    out.op[i] = chans.op[j];
  }
  return { t: tg, chans: out };
}

/**
 * Split a record at its gaps and return the longest unbroken stretch.
 * @param {Float64Array} t sample times, s
 * @param {number} period_s the sample period
 * @returns {{from:number, to:number, breaks:number}} the half-open index range of the longest run
 */
function longestSegment(t, period_s) {
  let bestFrom = 0;
  let bestTo = t.length;
  let from = 0;
  let breaks = 0;
  let best = 0;
  for (let i = 1; i <= t.length; i += 1) {
    const broken = i === t.length || (t[i] - t[i - 1]) > GAP_FACTOR * period_s;
    if (broken) {
      if (i - from > best) { best = i - from; bestFrom = from; bestTo = i; }
      if (i < t.length) { breaks += 1; from = i; }
    }
  }
  return { from: bestFrom, to: bestTo, breaks };
}

/**
 * Clipping, quantisation and frozen sections in one channel.
 *
 * All three are archive artefacts rather than process behaviour, and all three change what the
 * analysis is entitled to say:
 *
 *   CLIPPING at a transmitter range limit destroys the shape of the response, so a model fitted
 *   through it is fitted to the range and not to the process. Clipping of the OUTPUT is different
 *   and useful — a saturated output is why the loop was not controlling, and it is information.
 *   QUANTISATION sets a floor under the error variance, which the Harris index reads as
 *   irreducible disturbance and which is really the archive's resolution.
 *   FROZEN sections are either a dead instrument or, far more often, the historian's compression
 *   deadband deciding nothing had changed enough to be worth storing.
 *
 * @param {Float64Array} x the samples
 * @param {number} period_s the sample period
 * @param {object} [opts] options
 * @param {number} [opts.lo] a known low limit, e.g. 0 for an output
 * @param {number} [opts.hi] a known high limit, e.g. 100
 * @returns {object} the quality report
 */
export function channelQuality(x, period_s, opts = {}) {
  const st = columnStats(x);
  const n = x.length;
  let atLo = 0;
  let atHi = 0;
  const lo = opts.lo === undefined ? st.min : opts.lo;
  const hi = opts.hi === undefined ? st.max : opts.hi;
  const tol = Math.max(1e-9, 1e-6 * Math.max(1, Math.abs(hi - lo)));
  for (let i = 0; i < n; i += 1) {
    if (x[i] <= lo + tol) atLo += 1;
    if (x[i] >= hi - tol) atHi += 1;
  }
  // Frozen: a run of identical values long enough that no live instrument would produce it.
  const minRun = Math.max(8, Math.round(60 / Math.max(period_s, 1e-6)));
  let longest = 0;
  let runs = 0;
  let frozenSamples = 0;
  let run = 1;
  for (let i = 1; i <= n; i += 1) {
    if (i < n && x[i] === x[i - 1]) run += 1;
    else {
      if (run >= minRun) { runs += 1; frozenSamples += run; longest = Math.max(longest, run); }
      run = 1;
    }
  }
  const quantised = st.levels > 1 && st.levels < 0.15 * n && st.quantum > 0
    && st.quantum > 0.002 * st.range;
  return {
    stats: st,
    clipped: {
      low: atLo / n,
      high: atHi / n,
      // A single sample sitting on the extreme is arithmetic; a hundredth of the record parked
      // there is a limit.
      any: atLo / n > 0.01 || atHi / n > 0.01,
      lo,
      hi,
    },
    quantised,
    quantum: st.quantum,
    resolutionPct: st.range > 0 ? (100 * st.quantum) / st.range : 0,
    frozen: {
      runs,
      longest_s: longest * period_s,
      fraction: frozenSamples / n,
      any: runs > 0,
    },
  };
}

/**
 * Read a historian export into an analysable dataset.
 *
 * @param {string} text the file
 * @param {object} [opts] options
 * @param {string} [opts.delimiter] force the delimiter
 * @param {string} [opts.decimal] force the decimal separator
 * @param {Record<string,number>} [opts.map] force role to column index
 * @returns {{ok:boolean, reason?:string, t?:Float64Array, pv?:Float64Array, sp?:Float64Array,
 *   op?:Float64Array, period_s?:number, duration_s?:number, samples?:number, resampled?:boolean,
 *   timing?:object, quality?:object, columns?:Array<object>, mapping?:object, dialect?:object,
 *   warnings:string[]}} the dataset
 */
export function importSeries(text, opts = {}) {
  const table = parseTable(text, opts);
  if (!table.ok) return { ok: false, reason: table.reason, warnings: table.warnings || [] };
  const warnings = table.warnings.slice();

  const mapping = mapColumns(table.columns, { force: opts.map, decimal: table.dialect.decimal });
  for (const w of mapping.warnings) warnings.push(w);
  for (const n of mapping.notes) warnings.push(n);
  if (!mapping.ok) {
    return { ok: false, reason: mapping.reason, columns: table.columns, mapping, dialect: table.dialect, warnings };
  }

  const timeCol = table.columns[mapping.roles.time];
  const pvCol = table.columns[mapping.roles.pv];
  const spCol = mapping.roles.sp >= 0 ? table.columns[mapping.roles.sp] : null;
  const opCol = table.columns[mapping.roles.op];

  // Rows survive only when every mapped channel is readable on them. A row with a hole in it is
  // not a sample: filling it would invent data, and interpolating across it is what the gap and
  // resample machinery below is for.
  const rows = [];
  let dropped = 0;
  for (let i = 0; i < timeCol.raw.length; i += 1) {
    const ms = parseTimestamp(timeCol.raw[i], mapping.timeFormat, { decimal: table.dialect.decimal });
    const pv = pvCol.values[i];
    const op = opCol.values[i];
    const sp = spCol ? spCol.values[i] : 0;
    if (!Number.isFinite(ms) || !Number.isFinite(pv) || !Number.isFinite(op)
      || (spCol && !Number.isFinite(sp))) { dropped += 1; continue; }
    rows.push({ t: ms / 1000, pv, sp, op });
  }
  if (dropped) {
    warnings.push(`${dropped} row${dropped === 1 ? '' : 's'} had a missing or unreadable value in `
      + 'one of the mapped columns and were left out.');
  }
  if (rows.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: `only ${rows.length} complete rows survived parsing. Nothing in the analysis suite `
        + `says anything useful below ${MIN_SAMPLES} samples — the Harris index alone needs about `
        + 'a hundred and sixty.',
      columns: table.columns,
      mapping,
      dialect: table.dialect,
      warnings,
    };
  }

  // Order, then duplicates. Historians emit both: a collector catching up writes out of order,
  // and a store-and-forward buffer flushing writes the same second twice.
  rows.sort((a, b) => a.t - b.t);
  const uniq = [];
  let dup = 0;
  for (const r of rows) {
    if (uniq.length && r.t === uniq[uniq.length - 1].t) { dup += 1; continue; }
    uniq.push(r);
  }
  if (dup) warnings.push(`${dup} duplicate timestamp${dup === 1 ? '' : 's'} were dropped, keeping the first value at each instant.`);

  let t = Float64Array.from(uniq, (r) => r.t);
  let pv = Float64Array.from(uniq, (r) => r.pv);
  let sp = spCol ? Float64Array.from(uniq, (r) => r.sp) : null;
  let op = Float64Array.from(uniq, (r) => r.op);

  const tim = timing(t);
  if (!(tim.period_s > 0)) {
    return { ok: false, reason: 'every row carries the same timestamp — there is no time base here', columns: table.columns, mapping, dialect: table.dialect, warnings };
  }

  let resampled = false;
  if (!tim.uniform) {
    const chans = { pv, op };
    if (sp) chans.sp = sp;
    const r = resample(t, chans, tim.period_s);
    t = r.t;
    pv = r.chans.pv;
    op = r.chans.op;
    sp = sp ? r.chans.sp : null;
    resampled = true;
    warnings.push(`The record is not uniformly sampled — only ${Math.round(tim.uniformity * 100)}% `
      + `of its intervals are within 5% of the median ${tim.period_s.toFixed(2)} s. It has been `
      + `RESAMPLED onto a uniform ${tim.period_s.toFixed(2)} s grid: the measurement linearly `
      + 'interpolated, the setpoint and output held. Every frequency-domain number below is '
      + 'computed on that resampled series, not on the file.');
  }
  if (tim.gaps.length) {
    const missing = tim.gaps.reduce((a, g) => a + g.missing, 0);
    warnings.push(`${tim.gaps.length} gap${tim.gaps.length === 1 ? '' : 's'} in the record, about `
      + `${(missing * tim.period_s / 60).toFixed(1)} min of data missing in total. The analysis `
      + 'runs on the longest unbroken stretch rather than pretending the join is a sample.');
  }

  const seg = longestSegment(t, tim.period_s);
  if (seg.to - seg.from < t.length) {
    t = t.slice(seg.from, seg.to);
    pv = pv.slice(seg.from, seg.to);
    op = op.slice(seg.from, seg.to);
    if (sp) sp = sp.slice(seg.from, seg.to);
  }
  if (t.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: `the longest unbroken stretch of this record is only ${t.length} samples `
        + `(${((t.length * tim.period_s) / 60).toFixed(1)} min). The gaps have cut it into pieces `
        + 'too short to analyse; export a continuous period instead.',
      columns: table.columns,
      mapping,
      dialect: table.dialect,
      warnings,
    };
  }

  if (!sp) {
    // Analysis downstream wants an error signal. With no setpoint recorded, the honest surrogate
    // is the measurement's own mean — regulation about whatever it was holding — and the warning
    // above has already said so.
    const st = columnStats(pv);
    sp = new Float64Array(pv.length).fill(st.mean);
  }

  const quality = {
    pv: channelQuality(pv, tim.period_s),
    op: channelQuality(op, tim.period_s, { lo: 0, hi: 100 }),
    sp: channelQuality(sp, tim.period_s),
  };
  if (quality.pv.clipped.any) {
    warnings.push(`The measurement sits exactly on its ${quality.pv.clipped.high > quality.pv.clipped.low ? 'maximum' : 'minimum'} `
      + `for ${(100 * Math.max(quality.pv.clipped.low, quality.pv.clipped.high)).toFixed(1)}% of `
      + 'the record. That is a transmitter or an archive range limit, not the process: the shape '
      + 'of the response through those sections has been thrown away and any model fitted across '
      + 'them is fitted to the range.');
  }
  if (quality.op.clipped.any) {
    warnings.push(`The output is hard against ${quality.op.clipped.high > quality.op.clipped.low ? '100%' : '0%'} `
      + `for ${(100 * Math.max(quality.op.clipped.low, quality.op.clipped.high)).toFixed(1)}% of the `
      + 'record. While it is saturated the loop is open, whatever the mode says, and none of that '
      + 'time tells you anything about the tuning.');
  }
  if (quality.pv.quantised) {
    warnings.push(`The measurement is stored in steps of ${quality.pv.quantum.toPrecision(3)} — `
      + `${quality.pv.resolutionPct.toFixed(2)}% of its range. That resolution is a floor under `
      + 'the error variance, so the Harris index will read it as disturbance that no controller '
      + 'could have removed.');
  }
  if (quality.pv.frozen.any) {
    warnings.push(`${quality.pv.frozen.runs} frozen section${quality.pv.frozen.runs === 1 ? '' : 's'} `
      + `in the measurement, the longest ${(quality.pv.frozen.longest_s / 60).toFixed(1)} min. `
      + 'Either the instrument stopped updating or the historian\'s compression deadband decided '
      + 'nothing had changed; both look identical here and only one is a fault.');
  }

  return {
    ok: true,
    t,
    pv,
    sp,
    op,
    hasSetpoint: mapping.roles.sp >= 0,
    period_s: tim.period_s,
    duration_s: t[t.length - 1] - t[0],
    samples: t.length,
    resampled,
    timing: tim,
    quality,
    columns: table.columns,
    mapping,
    dialect: table.dialect,
    units: {
      pv: pvCol.unit,
      sp: spCol ? spCol.unit : '',
      op: opCol.unit || '%',
    },
    warnings,
  };
}

// =============================================================================================
// Is there anything in here?
// =============================================================================================

/**
 * Decide what this record can and cannot support, and refuse the rest.
 *
 * The tests are ordered by how fundamental the failure is, and each one carries the number that
 * failed it, because "insufficient excitation" without a figure is an opinion and "the output
 * moved 0.4%, which is inside its own 0.6% archive resolution" is a fact the engineer can go and
 * do something about.
 *
 * @param {object} ds a dataset from {@link importSeries}
 * @returns {{ok:boolean, reason?:string, checks:Array<object>, can:object, metrics:object}} the
 *   assessment
 */
export function assessExcitation(ds) {
  if (!ds || !ds.ok) return { ok: false, reason: 'no dataset', checks: [], can: {}, metrics: {} };
  const { pv, sp, op, period_s, samples, duration_s } = ds;
  const opQ = ds.quality.op;
  const pvQ = ds.quality.pv;

  const opNoise = Math.max(opQ.stats.noise, opQ.quantum / 2);
  const pvNoise = Math.max(pvQ.stats.noise, pvQ.quantum / 2);
  const opMove = opQ.stats.p99 - opQ.stats.p1;
  const pvMove = pvQ.stats.p99 - pvQ.stats.p1;
  let opTravel = 0;
  for (let i = 1; i < op.length; i += 1) opTravel += Math.abs(op[i] - op[i - 1]);

  // The largest sustained output move: the biggest difference between two half-window averages,
  // which finds a step wherever it sits and is not fooled by a single spike.
  const w = Math.max(3, Math.round(op.length / 40));
  let biggestStep = 0;
  let stepAt = -1;
  for (let i = w; i + w <= op.length; i += 1) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < w; k += 1) { a += op[i - 1 - k]; b += op[i + k]; }
    const d = (b - a) / w;
    if (Math.abs(d) > Math.abs(biggestStep)) { biggestStep = d; stepAt = i; }
  }

  // Setpoint activity: an external excitation, which is what makes closed-loop identification
  // legitimate rather than merely arithmetic.
  let spChanges = 0;
  const spBand = Math.max(2 * pvNoise, 0.005 * Math.max(pvMove, 1e-9));
  for (let i = 1; i < sp.length; i += 1) if (Math.abs(sp[i] - sp[i - 1]) > spBand) spChanges += 1;

  const corr = Math.abs(correlation(op, pv));

  const checks = [];
  /**
   * Record one test.
   * @param {string} id the test's id
   * @param {boolean} ok whether it passed
   * @param {string} detail what was measured, in words
   * @returns {boolean} `ok`, so tests can be chained
   */
  const check = (id, ok, detail) => { checks.push({ id, ok, detail }); return ok; };

  const enoughSamples = check('samples', samples >= MIN_SAMPLES,
    `${samples} samples at ${period_s.toFixed(2)} s — ${(duration_s / 60).toFixed(1)} min of record.`);
  const enoughDuration = check('duration', duration_s >= 30 * period_s,
    `${(duration_s / 60).toFixed(1)} min is ${Math.round(duration_s / period_s)} sample periods.`);
  const outputMoved = check('output-movement',
    opMove > Math.max(4 * opNoise, 2 * opQ.quantum, 0.5),
    `the output moved ${opMove.toFixed(2)}% peak to peak against a noise and resolution floor of `
    + `${Math.max(opNoise, opQ.quantum / 2).toFixed(2)}%; total travel ${opTravel.toFixed(0)}%.`);
  const pvMoved = check('measurement-response', pvMove > 4 * pvNoise,
    `the measurement moved ${pvMove.toPrecision(3)} against a noise level of ${pvNoise.toPrecision(2)}.`);
  const related = check('causality', corr > 0.25 || spChanges > 0,
    `output and measurement correlate at ${corr.toFixed(2)}; ${spChanges} setpoint change`
    + `${spChanges === 1 ? '' : 's'} in the record.`);
  const informative = check('excitation-shape',
    Math.abs(biggestStep) > Math.max(4 * opNoise, 1) || opTravel > 8 * Math.max(opMove, 1),
    Math.abs(biggestStep) > 0
      ? `the largest sustained output move is ${biggestStep.toFixed(1)}%, at `
        + `${((stepAt * period_s) / 60).toFixed(1)} min.`
      : 'the output never makes a sustained move.');

  const canIdentify = enoughSamples && enoughDuration && outputMoved && pvMoved && related && informative;
  const can = {
    identify: canIdentify,
    diagnostics: samples >= MIN_SAMPLES,
    harris: samples >= 200,
    oscillation: samples >= 200,
    stiction: samples >= 200 && ds.hasSetpoint,
    margins: canIdentify,
  };

  let reason;
  if (!canIdentify) {
    const failed = checks.find((c) => !c.ok);
    const REASONS = {
      samples: `There are only ${samples} samples here. Nothing in this suite says anything `
        + `honest below ${MIN_SAMPLES}.`,
      duration: `The record covers ${(duration_s / 60).toFixed(1)} min at a ${period_s.toFixed(1)} s `
        + 'sample period — a few dozen samples of process, which cannot separate a lag from a dead '
        + 'time however it is fitted.',
      'output-movement': `The output moved ${opMove.toFixed(2)}% peak to peak over `
        + `${(duration_s / 60).toFixed(0)} minutes, which is inside its own noise and archive `
        + `resolution of ${Math.max(opNoise, opQ.quantum / 2).toFixed(2)}%. Nothing in this file `
        + 'says what the process does when the valve moves, because in this file the valve did not '
        + 'move. A model fitted to it would be a model of the transmitter noise. Capture a record '
        + 'with a deliberate step in manual, or one taken while the loop was actually being upset.',
      'measurement-response': `The output moved but the measurement did not — ${pvMove.toPrecision(3)} `
        + `peak to peak against ${pvNoise.toPrecision(2)} of noise. Either the final element is not `
        + 'passing the signal, the measurement is frozen, or the two columns are not the same loop. '
        + 'Check the mapping before you believe the file.',
      causality: `The output and the measurement correlate at only ${corr.toFixed(2)} and the `
        + 'setpoint never moves. Whatever is moving this process, it is not this output; these two '
        + 'columns may not belong to the same loop.',
      'excitation-shape': `The output wanders but never makes a sustained move — the largest is `
        + `${Math.abs(biggestStep).toFixed(2)}%. Identification needs a change the process has had `
        + 'time to answer: a step, a setpoint change, or a sustained cycle. Ordinary regulation '
        + 'around a quiet operating point contains almost no information about the dynamics, which '
        + 'is exactly why a bump test exists.',
    };
    reason = REASONS[failed.id] || 'this record cannot support identification';
  }

  return {
    ok: canIdentify,
    reason,
    checks,
    can,
    metrics: {
      opMove, opNoise, opTravel, pvMove, pvNoise, corr, spChanges, biggestStep, stepAt,
    },
  };
}

// =============================================================================================
// Identification
// =============================================================================================

/**
 * A frequency grid that suits a particular model and sample rate.
 *
 * The shipped `DEFAULT_GRID` spans the rig's own dynamics. An imported loop may be a hundred
 * times slower or ten times faster, and a margin read off a grid that does not reach the
 * crossover is not a margin, it is a NaN — so the grid is built from the model instead.
 *
 * @param {{tau:number, theta:number}} model the process model
 * @param {number} period_s the sample period, s
 * @returns {Float64Array} the frequencies, rad/s
 */
export function modelGrid(model, period_s) {
  const slow = Math.max(model.tau, model.theta, period_s, 1e-3);
  const wLo = 0.003 / slow;
  const wHi = Math.PI / Math.max(period_s, 1e-3);
  return logspace(Math.log10(wLo), Math.log10(Math.max(wHi, wLo * 100)), 420);
}

/**
 * Fit a first-order-plus-dead-time model to whatever excitation the record contains.
 *
 * ------------------------------------------------------------------------------------------
 * WHY NOT JUST THE TWO-POINT STEP METHOD
 *
 * `autotune.js::fitFOPDT` reads a model off the 28.3% and 63.2% points of a step response, and it
 * is the right method when there IS a step: it is quick, it is standard, and an engineer can
 * check it by hand off the trend. Historian data usually is not that. The output moves a dozen
 * times, the setpoint moves twice, a disturbance arrives in the middle, and no single edge is
 * clean enough to read two crossings off.
 *
 * So the primary method here is a least-squares fit of the whole record: for each candidate lag
 * and dead time, drive a first-order model with the recorded OUTPUT, and ask what gain and bias
 * best explain the recorded MEASUREMENT. Every sample contributes, so a dozen small moves add up
 * to the information one clean step would have given.
 *
 * TWO IMPLEMENTATION NOTES THAT MATTER. The filtered output is computed once per candidate lag
 * and then merely INDEX-SHIFTED for each dead time — a delay and a linear filter commute, so the
 * inner loop of the search is a regression and not a re-simulation. And the search runs in two
 * passes, coarse and then refined about the winner, because a logarithmic lag grid fine enough to
 * be accurate everywhere would spend most of its points where the answer is not.
 *
 * WHERE IT IS BIASED, AND SAYING SO. Fitting closed-loop data with no setpoint changes is asking
 * what the output does to the measurement while the output is itself a function of the
 * measurement. The fit will return something; what it returns leans toward the inverse of the
 * controller rather than the process. The report says so whenever the record contains no setpoint
 * movement, because that caveat is the difference between ranking candidate tunings — fine — and
 * commissioning one off this file — not fine.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} ds a dataset from {@link importSeries}
 * @param {object} [opts] options
 * @param {number} [opts.maxDeadTime_s] cap on the dead time searched
 * @returns {{ok:boolean, reason?:string, K?:number, tau?:number, theta?:number, r2?:number,
 *   rms?:number, method?:string, crossCheck?:object, closedLoop?:boolean}} the model
 */
export function identifyModel(ds, opts = {}) {
  if (!ds || !ds.ok) return { ok: false, reason: 'no dataset' };

  // Decimate to bound the search. Averaging rather than picking every nth sample keeps the
  // anti-alias property, and the dynamics being fitted are by definition slower than the cycle
  // that survives decimation.
  const factor = Math.max(1, Math.ceil(ds.samples / IDENT_MAX_SAMPLES));
  const n = Math.floor(ds.samples / factor);
  const dt = ds.period_s * factor;
  const u = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let su = 0;
    let sy = 0;
    for (let k = 0; k < factor; k += 1) { su += ds.op[i * factor + k]; sy += ds.pv[i * factor + k]; }
    u[i] = su / factor;
    y[i] = sy / factor;
  }

  const maxTheta_s = Math.min(opts.maxDeadTime_s || Infinity, 0.25 * (n * dt));
  const dMax = clamp(Math.round(maxTheta_s / dt), 0, Math.floor(n / 8));

  let Syy = 0;
  let Sy = 0;
  for (let i = 0; i < n; i += 1) { Sy += y[i]; Syy += y[i] * y[i]; }
  const yBar = Sy / n;
  let sst = 0;
  for (let i = 0; i < n; i += 1) sst += (y[i] - yBar) ** 2;
  if (!(sst > 0)) return { ok: false, reason: 'the measurement never changes' };

  /**
   * First-order filter of the output at one candidate lag.
   * @param {number} tau the lag, s
   * @returns {Float64Array} the filtered output
   */
  const filterAt = (tau) => {
    const a = Math.exp(-dt / Math.max(tau, 1e-6));
    const x = new Float64Array(n);
    x[0] = u[0];
    for (let i = 1; i < n; i += 1) x[i] = a * x[i - 1] + (1 - a) * u[i - 1];
    return x;
  };

  /**
   * Best gain and bias for one filtered output at one dead time, and the residual it leaves.
   * @param {Float64Array} x the filtered output
   * @param {number} d dead time, samples
   * @returns {{sse:number, K:number}} the fit
   */
  const fitAt = (x, d) => {
    let Sx = 0;
    let Sxx = 0;
    let Sxy = 0;
    for (let i = 0; i < n; i += 1) {
      const xv = x[Math.max(0, i - d)];
      Sx += xv;
      Sxx += xv * xv;
      Sxy += xv * y[i];
    }
    const den = n * Sxx - Sx * Sx;
    if (!(Math.abs(den) > 1e-12)) return { sse: Infinity, K: 0 };
    const K = (n * Sxy - Sx * Sy) / den;
    const c = (Sy - K * Sx) / n;
    const sse = Syy - K * Sxy - c * Sy;
    return { sse: Math.max(sse, 0), K };
  };

  /**
   * Search a list of lags against every dead time.
   * @param {number[]} taus the lags to try, s
   * @param {object|null} best the incumbent
   * @returns {object} the winner
   */
  const search = (taus, best) => {
    let win = best;
    for (const tau of taus) {
      const x = filterAt(tau);
      for (let d = 0; d <= dMax; d += 1) {
        const f = fitAt(x, d);
        if (!Number.isFinite(f.sse)) continue;
        if (win === null || f.sse < win.sse) win = { sse: f.sse, K: f.K, tau, d };
      }
    }
    return win;
  };

  const tauLo = Math.max(dt, 0.5 * dt);
  const tauHi = Math.max(tauLo * 4, 0.5 * n * dt);
  const coarse = [];
  const steps = 40;
  for (let i = 0; i < steps; i += 1) {
    coarse.push(10 ** (Math.log10(tauLo) + ((Math.log10(tauHi) - Math.log10(tauLo)) * i) / (steps - 1)));
  }
  let best = search(coarse, null);
  if (!best) return { ok: false, reason: 'the output never varies enough to fit anything to' };
  // Refine about the winner, over the two coarse cells either side of it.
  const ratio = 10 ** ((Math.log10(tauHi) - Math.log10(tauLo)) / (steps - 1));
  const fine = [];
  for (let i = -10; i <= 10; i += 1) fine.push(best.tau * ratio ** (i / 10));
  best = search(fine.filter((t) => t > 0), best);

  const r2 = 1 - best.sse / sst;
  const model = {
    ok: true,
    K: best.K,
    tau: best.tau,
    theta: best.d * dt,
    r2,
    rms: Math.sqrt(best.sse / n),
    method: 'least squares over the whole record',
    closedLoop: false,
  };
  if (!(Math.abs(model.K) > 0) || !Number.isFinite(model.K)) {
    return { ok: false, reason: 'no gain could be fitted: the output and the measurement do not move together' };
  }
  if (r2 < 0.25) {
    return {
      ok: false,
      reason: `the best first-order-plus-dead-time model explains only ${(100 * r2).toFixed(0)}% of `
        + 'the movement in the measurement. Whatever is driving this loop is not mostly the output: '
        + 'look for a disturbance, an interacting loop, or a second time constant before tuning '
        + 'anything.',
      K: model.K,
      tau: model.tau,
      theta: model.theta,
      r2,
    };
  }

  // Cross-check against the classical two-point method on the largest step, when there is one.
  model.crossCheck = crossCheckStep(ds, model);
  return model;
}

/**
 * Read a second model off the largest step in the record, using the classical two-point method,
 * and say whether the two agree.
 *
 * Two methods that agree on a number are worth much more than either alone, and where they
 * DISAGREE is informative rather than embarrassing: the least-squares fit uses the whole record
 * and is pulled about by disturbances, the two-point method uses one edge and is pulled about by
 * whatever happened to be arriving during it. A large disagreement means the record contains more
 * than one process.
 *
 * @param {object} ds the dataset
 * @param {object} primary the least-squares model
 * @returns {{ok:boolean, reason?:string, K?:number, tau?:number, theta?:number, agrees?:boolean,
 *   note?:string}} the cross-check
 */
function crossCheckStep(ds, primary) {
  const { op, pv, t, period_s } = ds;
  const n = op.length;
  const w = Math.max(3, Math.round(n / 60));
  let bestAt = -1;
  let bestStep = 0;
  for (let i = w; i + w <= n; i += 1) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < w; k += 1) { a += op[i - 1 - k]; b += op[i + k]; }
    const d = (b - a) / w;
    if (Math.abs(d) > Math.abs(bestStep)) { bestStep = d; bestAt = i; }
  }
  const opNoise = Math.max(ds.quality.op.stats.noise, 1e-9);
  if (bestAt < 0 || Math.abs(bestStep) < Math.max(4 * opNoise, 1)) {
    return { ok: false, reason: 'no single step in the record is clean enough for the two-point method' };
  }
  // Take from the step to whichever comes first: the end of the record, or four estimated time
  // constants later. Any longer and a later disturbance is inside the window.
  const from = Math.max(0, bestAt - w);
  const to = Math.min(n, bestAt + Math.round((4 * (primary.tau + primary.theta)) / period_s));
  if (to - from < 12) return { ok: false, reason: 'the step is too close to the end of the record to read' };
  const tt = new Float64Array(to - from);
  const yy = new Float64Array(to - from);
  for (let i = from; i < to; i += 1) { tt[i - from] = t[i] - t[from]; yy[i - from] = pv[i]; }
  const fit = fitFOPDT(tt, yy, bestStep, to - from);
  if (!fit.ok) return { ok: false, reason: fit.reason };
  const rel = Math.abs(fit.K - primary.K) / Math.max(Math.abs(primary.K), 1e-9);
  const agrees = rel < 0.35;
  return {
    ok: true,
    K: fit.K,
    tau: fit.tau,
    theta: fit.theta,
    step_pct: bestStep,
    at_s: t[bestAt] - t[0],
    agrees,
    note: agrees
      ? 'The two-point method on the largest step agrees with the whole-record fit to within 35%, '
        + 'which is as close as two identification methods ever get on plant data.'
      : `The two-point method on the largest step gives a gain of ${fit.K.toPrecision(3)} against `
        + `${primary.K.toPrecision(3)} from the whole record. They disagree, which usually means a `
        + 'disturbance arrived during the step or the process gain is not the same at both '
        + 'operating points. Trust neither number to better than a factor of two until you know '
        + 'which.',
  };
}

/**
 * The ultimate gain and period of a FOPDT model, from the frequency where its phase lag reaches
 * 180 degrees. This is what a relay experiment measures directly; on imported data there is no
 * relay to run, so it is computed from the identified model instead — which is exactly what makes
 * the classical Ziegler-Nichols family available for a loop nobody may bump.
 *
 * @param {{K:number, tau:number, theta:number}} model the process model
 * @returns {{ok:boolean, Ku?:number, Tu?:number, wu?:number, reason?:string}} the ultimate values
 */
export function ultimateFromModel(model) {
  const K = Math.abs(model.K);
  if (!(K > 0)) return { ok: false, reason: 'the model has no gain' };
  if (!(model.theta > 0)) {
    // A pure first-order lag never reaches 180 degrees, so it has no ultimate gain: with no dead
    // time at all a proportional controller of any size is stable. Real loops always have some;
    // the sample period alone contributes half a scan.
    return { ok: false, reason: 'no dead time was identified, so the loop has no ultimate gain' };
  }
  let lo = 1e-6;
  let hi = 1e4;
  for (let i = 0; i < 200; i += 1) {
    const w = 0.5 * (lo + hi);
    if (model.theta * w + Math.atan(w * model.tau) < Math.PI) lo = w; else hi = w;
  }
  const wu = 0.5 * (lo + hi);
  return { ok: true, wu, Tu: (2 * Math.PI) / wu, Ku: Math.sqrt(1 + (wu * model.tau) ** 2) / K };
}

// =============================================================================================
// The report
// =============================================================================================

/**
 * Run the whole analysis suite on an imported record.
 *
 * @param {object} ds a dataset from {@link importSeries}
 * @param {object} [opts] options
 * @param {{Kc:number, Ti:number, Td:number, pvFilter_s?:number, N?:number}} [opts.tuning] the
 *   tuning that was running while the data was collected, if it is known — the file does not
 *   contain it
 * @param {number} [opts.span] the loop's engineering-unit span, defaulting to the measured range
 * @returns {object} the report
 */
export function analyseImport(ds, opts = {}) {
  if (!ds || !ds.ok) return { ok: false, reason: (ds && ds.reason) || 'no dataset', caveats: [] };
  const caveats = ds.warnings.slice();
  const excitation = assessExcitation(ds);

  const span = opts.span || Math.max(ds.quality.pv.stats.range, 1e-9);
  const report = {
    ok: false,
    dataset: {
      samples: ds.samples,
      period_s: ds.period_s,
      duration_s: ds.duration_s,
      resampled: ds.resampled,
      gaps: ds.timing.gaps.length,
      duplicates: ds.timing.duplicates,
      hasSetpoint: ds.hasSetpoint,
      units: ds.units,
      mapping: ds.mapping,
      dialect: ds.dialect,
      quality: ds.quality,
    },
    excitation,
    model: null,
    ultimate: null,
    existing: null,
    health: null,
    candidates: [],
    caveats,
    headline: '',
  };

  // ---- loop health, which needs no excitation at all ------------------------------------------
  // This is the half of the suite that works on ROUTINE data — which is the whole reason the
  // Harris index is the metric plants actually use. It runs before the refusal below, because a
  // record with no excitation in it can still be told it is cycling.
  if (excitation.can.diagnostics) {
    const d = createDiagnostics(ds.samples, ds.period_s);
    let sat = 0;
    for (let i = 0; i < ds.samples; i += 1) {
      pushSample(d, ds.sp[i] - ds.pv[i], ds.op[i], ds.pv[i]);
      if (ds.op[i] <= 0.001 || ds.op[i] >= 99.999) sat += 1;
    }
    report.health = analyseLoop(d, {
      // Before a model exists the dead time is unknown; one sample period is the smallest honest
      // guess and it makes the Harris index a LOWER bound, which is the safe direction to be wrong
      // in — it can only understate how much room there is.
      deadTime_s: ds.period_s,
      span,
      satFraction: sat / ds.samples,
      resetTime_s: opts.tuning && opts.tuning.Ti,
    });
  }

  if (!excitation.ok) {
    report.ok = false;
    report.reason = excitation.reason;
    report.headline = 'This record cannot support identification.';
    caveats.push(excitation.reason);
    return report;
  }

  // ---- the model -------------------------------------------------------------------------------
  const model = identifyModel(ds);
  if (!model.ok) {
    report.ok = false;
    report.reason = model.reason;
    report.headline = 'A model could not be fitted to this record.';
    caveats.push(model.reason);
    return report;
  }
  report.model = model;

  if (excitation.metrics.spChanges === 0) {
    caveats.push('The setpoint never moves in this record, so the only thing exciting the process '
      + 'is whatever was disturbing it. A model identified from closed-loop data with no external '
      + 'excitation leans toward the inverse of the controller rather than the process. It is good '
      + 'enough to rank candidate tunings against each other; it is not good enough to commission '
      + 'one from. Ask for a record with a setpoint change or a manual bump in it.');
    model.closedLoop = true;
  }
  if (model.crossCheck && model.crossCheck.ok && !model.crossCheck.agrees) {
    caveats.push(model.crossCheck.note);
  }
  if (model.theta < ds.period_s) {
    caveats.push(`The identified dead time (${model.theta.toFixed(1)} s) is at or below the sample `
      + `period (${ds.period_s.toFixed(1)} s), so it is not resolved by this data. Everything below `
      + 'one sample looks the same to the archive, and the margins are computed as though the dead '
      + 'time were exactly that.');
  }

  // Re-run the health report now that the dead time is known: the Harris index is defined against
  // it, and one sample period was only ever a placeholder.
  if (report.health && excitation.can.diagnostics) {
    const d = createDiagnostics(ds.samples, ds.period_s);
    let sat = 0;
    for (let i = 0; i < ds.samples; i += 1) {
      pushSample(d, ds.sp[i] - ds.pv[i], ds.op[i], ds.pv[i]);
      if (ds.op[i] <= 0.001 || ds.op[i] >= 99.999) sat += 1;
    }
    report.health = analyseLoop(d, {
      deadTime_s: Math.max(model.theta, ds.period_s),
      span,
      satFraction: sat / ds.samples,
      resetTime_s: opts.tuning && opts.tuning.Ti,
    });
  }

  const ult = ultimateFromModel(model);
  report.ultimate = ult.ok ? ult : null;

  // ---- the margins of what is actually running --------------------------------------------------
  const grid = modelGrid(model, ds.period_s);
  // The sign of the process gain is the loop's ACTION, and it belongs in the controller's sign,
  // not in the loop transfer function: a direct-acting process under a direct-acting controller
  // has a positive product and is stable feedback exactly as a reverse/reverse pair is. Analysing
  // |K| with |Kc| asks the stability question the engineer meant.
  const absModel = { K: Math.abs(model.K), tau: model.tau, theta: model.theta };
  const base = {
    Kc: 1, Ti: Infinity, Td: 0, N: 10, b: 1, outLo: 0, outHi: 100, pvFilter_s: 0,
  };
  if (opts.tuning && Number.isFinite(opts.tuning.Kc) && opts.tuning.Kc !== 0) {
    const cfg = {
      ...base,
      Kc: Math.abs(opts.tuning.Kc),
      Ti: Number.isFinite(opts.tuning.Ti) && opts.tuning.Ti > 0 ? opts.tuning.Ti : Infinity,
      Td: opts.tuning.Td > 0 ? opts.tuning.Td : 0,
      N: opts.tuning.N > 0 ? opts.tuning.N : 10,
      pvFilter_s: opts.tuning.pvFilter_s > 0 ? opts.tuning.pvFilter_s : 0,
    };
    const m = margins(loopResponse(cfg, absModel, grid, ds.period_s));
    report.existing = {
      tuning: { Kc: opts.tuning.Kc, Ti: cfg.Ti, Td: cfg.Td },
      margins: m,
      note: `Computed on the identified model with the recorded sample period (${ds.period_s.toFixed(1)} s) `
        + 'counted as controller scan, which costs half a scan of phase and is usually the part '
        + 'people forget.',
    };
  } else {
    report.existing = null;
    caveats.push('A historian export contains the loop but not the controller: enter the Kc, Ti '
      + 'and Td that were running while this data was collected to get the margins of the tuning '
      + 'that is actually installed.');
  }

  // ---- the candidates ---------------------------------------------------------------------------
  const rules = modelRules(model.K < 0 ? absModel : model);
  if (ult.ok) for (const r of tuningRules(ult.Ku, ult.Tu)) rules.push(r);
  report.candidates = rankTunings(rules, absModel, { loopResponse, margins, predictStep, grid }, base, ds.period_s);
  if (model.K < 0) {
    caveats.push('The process gain is negative — a rising output lowers the measurement — so this '
      + 'is a DIRECT-acting loop and every candidate gain below should be entered with the '
      + 'controller\'s action set accordingly. The magnitudes are what they are; the sign lives in '
      + 'the action switch.');
  }

  report.ok = true;
  const ratio = model.theta / Math.max(model.tau, 1e-9);
  report.headline = `K ${model.K.toPrecision(3)} ${ds.units.pv || 'EU'}/%, tau `
    + `${model.tau.toFixed(1)} s, theta ${model.theta.toFixed(1)} s (theta/tau ${ratio.toFixed(2)}), `
    + `fitted to ${(100 * model.r2).toFixed(0)}% of the movement in ${(ds.duration_s / 60).toFixed(0)} `
    + 'min of record.';
  return report;
}

/**
 * Parse and analyse in one call — the entry point the UI uses and the one to guard.
 *
 * @param {string} text the file
 * @param {object} [opts] options, as {@link importSeries} and {@link analyseImport}
 * @returns {{ok:boolean, reason?:string, dataset?:object, report?:object}} the result
 */
export function importAndAnalyse(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'nothing to import — the file or the pasted text is empty' };
  }
  const ds = importSeries(text, opts);
  if (!ds.ok) return { ok: false, reason: ds.reason, dataset: ds };
  const report = analyseImport(ds, opts);
  return { ok: report.ok, reason: report.reason, dataset: ds, report };
}

/**
 * Render a report as plain text, for a clipboard or a file.
 *
 * The caveats come FIRST and the numbers second, which is the opposite of how a tool would
 * usually lay this out and is deliberate: by the time somebody has read a gain they have already
 * decided to believe it.
 *
 * @param {object} report from {@link analyseImport}
 * @returns {string} the report text
 */
export function reportToText(report) {
  if (!report) return '';
  const L = [];
  const d = report.dataset;
  L.push('IMPORTED LOOP DATA — ANALYSIS');
  L.push('');
  if (d) {
    L.push(`Record       ${d.samples} samples at ${d.period_s.toFixed(2)} s `
      + `= ${(d.duration_s / 60).toFixed(1)} min`
      + `${d.resampled ? ' (RESAMPLED onto a uniform grid)' : ''}`);
    L.push(`Columns      PV${d.units.pv ? ` (${d.units.pv})` : ''}, `
      + `${d.hasSetpoint ? 'SP' : 'no SP recorded'}, OP${d.units.op ? ` (${d.units.op})` : ''}`);
  }
  L.push('');
  if (report.caveats.length) {
    L.push('CAVEATS');
    for (const c of report.caveats) L.push(`  - ${c}`);
    L.push('');
  }
  if (!report.ok) {
    L.push('REFUSED');
    L.push(`  ${report.reason}`);
    L.push('');
    L.push('  Tests:');
    for (const c of report.excitation.checks) {
      L.push(`    [${c.ok ? 'ok  ' : 'FAIL'}] ${c.id} — ${c.detail}`);
    }
  } else {
    L.push('MODEL');
    L.push(`  ${report.headline}`);
    if (report.model.crossCheck && report.model.crossCheck.ok) {
      L.push(`  Cross-check: ${report.model.crossCheck.note}`);
    }
    if (report.ultimate) {
      L.push(`  Ultimate gain ${report.ultimate.Ku.toPrecision(3)} %/EU at a period of `
        + `${report.ultimate.Tu.toFixed(1)} s.`);
    }
    L.push('');
    if (report.existing) {
      const m = report.existing.margins;
      L.push('THE TUNING THAT IS RUNNING');
      L.push(`  Kc ${report.existing.tuning.Kc}, Ti ${report.existing.tuning.Ti}, Td ${report.existing.tuning.Td}`);
      L.push(`  Gain margin ${m.gm_dB.toFixed(1)} dB, phase margin ${m.pm_deg.toFixed(0)} deg, `
        + `Ms ${m.ms.toFixed(2)} — ${m.verdict}`);
      L.push('');
    }
    if (report.candidates.length) {
      L.push('CANDIDATE TUNINGS, best first');
      for (const c of report.candidates.slice(0, 8)) {
        L.push(`  ${c.name.padEnd(26)} Kc ${c.Kc.toPrecision(3)}  Ti ${c.Ti.toPrecision(3)} s  `
          + `Td ${c.Td.toPrecision(3)} s   Ms ${c.margins.ms.toFixed(2)}  `
          + `PM ${c.margins.pm_deg.toFixed(0)} deg`);
      }
      L.push('');
    }
  }
  if (report.health) {
    L.push('LOOP HEALTH');
    L.push(`  ${report.health.verdict} — ${report.health.advice}`);
  }
  return `${L.join('\n')}\n`;
}
