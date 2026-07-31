/**
 * src/io/export.js — CSV, JSON and method export/import, plus the two browser download helpers.
 *
 * Contract: architecture-v2 §5.12 (CSV column order and the metadata block), §5.13 (JSON export
 * shape), §6.23 (this module).
 *
 * All three CSVs are UTF-8, CRLF, RFC 4180: a field containing a comma, a double quote, CR or LF
 * is wrapped in double quotes and its own quotes are doubled. `NaN`, `Infinity`, `null` and
 * `undefined` all render as an EMPTY field. `activeAlarms` is a semicolon-joined id list inside
 * quotes; `qualityFlags` is `'0x'` + four hex digits.
 *
 * `t_iso` is SYNTHESISED from a fixed epoch plus `t_s` — there is no real clock in this program
 * and this module never reads one (DoD 2). The civil-date conversion below is a pure integer
 * algorithm, so no `Date` is constructed anywhere.
 *
 * `downloadText` / `downloadBlob` are the only DOM references outside `src/ui/`; both touch the
 * DOM inside the function body only and no test path reaches them.
 *
 * Layer: leaf-ish (`-> core/util.js, core/log.js` only), callable from any layer, called from UI.
 */

import { mg_from_umol } from '../core/util.js';
import { buildLogChannels, column as logColumn } from '../core/log.js';

/**
 * Decimal places for the EVENTS and FRACTIONS CSVs only, keyed by FIELD NAME (§5.12).
 * The data CSV takes its decimals from `buildLogChannels(config).decimals[k]` and never from here.
 * @type {{[field:string]: number}}
 */
export const DECIMALS = {
  t_s: 2, V_mL: 2, V_CV: 4,
  startTime_s: 2, endTime_s: 2, startVolume_mL: 2, endVolume_mL: 2,
  startVolumeValve_mL: 2, endVolumeValve_mL: 2, volume_mL: 2, carryover_mL: 2,
  switchOverlap_mL: 2, offsetError_mL: 2,
  uvStart_mAU: 2, uvEnd_mAU: 2, uvMax_mAU: 2, area_AUcm_mL: 4,
  estimatedMass_mg: 3, meanCond_mScm: 3, meanPH: 3,
};

/** RFC 4180 record separator. */
const CRLF = '\r\n';

/**
 * The fixed export epoch: 1970-01-01T00:00:00Z + this many seconds = 2024-01-01T00:00:00Z.
 * Every `t_iso` in every export is `EPOCH_UNIX_S + t_s`, so two runs of the same method with the
 * same seed produce byte-identical files (DoD 6).
 */
const EPOCH_UNIX_S = 1704067200;

/** The fraction column order of §5.12, in order; also the header of `<runId>_fractions.csv`. */
const FRACTION_FIELDS = [
  'index', 'port', 'startTime_s', 'endTime_s', 'startVolume_mL', 'endVolume_mL',
  'startVolumeValve_mL', 'endVolumeValve_mL', 'volume_mL', 'carryover_mL', 'carryoverFrom',
  'switchOverlap_mL', 'offsetError_mL', 'uvStart_mAU', 'uvEnd_mAU', 'uvMax_mAU',
  'containsPeakMax', 'area_AUcm_mL', 'estimatedMass_mg', 'meanCond_mScm', 'meanPH',
  'trigger', 'quality',
];

/** The event column order of §5.12. */
const EVENT_FIELDS = ['t_s', 't_iso', 'V_mL', 'V_CV', 'type', 'severity', 'source', 'blockId',
  'message', 'detail_json'];

/**
 * Zero-pad an integer to a fixed width.
 * @param {number} v integer value
 * @param {number} w width
 * @returns {string} padded decimal string
 */
function pad(v, w) {
  let s = String(Math.abs(v));
  while (s.length < w) s = '0' + s;
  return (v < 0 ? '-' : '') + s;
}

/**
 * ISO 8601 UTC timestamp from a Unix epoch offset, computed with integer arithmetic only
 * (Howard Hinnant's civil-from-days). No `Date` object is created — see the module note.
 * @param {number} unix_s seconds since 1970-01-01T00:00:00Z (may be fractional)
 * @returns {string} e.g. `'2024-01-01T00:12:34.500Z'`
 */
function isoFromUnixSeconds(unix_s) {
  let whole = Math.floor(unix_s);
  let ms = Math.round((unix_s - whole) * 1000);
  if (ms >= 1000) { ms -= 1000; whole += 1; }
  if (ms < 0) { ms += 1000; whole -= 1; }

  const days = Math.floor(whole / 86400);
  const rem = whole - days * 86400;
  const hh = Math.floor(rem / 3600);
  const mm = Math.floor((rem - hh * 3600) / 60);
  const ss = rem - hh * 3600 - mm * 60;

  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);
  const y0 = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = y0 + (m <= 2 ? 1 : 0);

  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(ms, 3)}Z`;
}

/**
 * RFC 4180 field escape.
 * @param {*} v any value; non-strings are stringified, `null`/`undefined` become empty
 * @param {boolean} [force=false] always quote (used for `activeAlarms`, §5.12)
 * @returns {string} a CSV-safe field
 */
function csvField(v, force) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (force || s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Fixed-decimal numeric field. Non-finite values (including `NaN`) render as an empty field.
 * @param {number} v value
 * @param {number} decimals decimal places
 * @returns {string} formatted number, or `''`
 */
function num(v, decimals) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  return v.toFixed(decimals);
}

/**
 * Strip commas and newlines from free text destined for a `#` metadata comment line, which is not
 * quoted.
 * @param {*} s any value
 * @returns {string} single-line, comma-free text
 */
function meta(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[\r\n]+/g, ' ').replace(/,/g, ';');
}

/**
 * Deep clone into structured-clone- and JSON-safe plain data: typed arrays become `Array`,
 * `Map`s become objects, functions are dropped, non-finite numbers become `null`.
 * @param {*} v value to clone
 * @returns {*} plain clone
 */
function plainClone(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? null : v;
  if (ArrayBuffer.isView(v)) {
    const a = /** @type {any} */ (v);
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = Number.isFinite(a[i]) ? a[i] : null;
    return out;
  }
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = plainClone(v[i]);
    return out;
  }
  if (v instanceof Map) {
    const out = {};
    for (const [k, val] of v) out[String(k)] = plainClone(val);
    return out;
  }
  const out = {};
  for (const k of Object.keys(v)) {
    if (typeof v[k] === 'function') continue;
    out[k] = plainClone(v[k]);
  }
  return out;
}

/**
 * Build a reader for an RLE discrete channel that walks rows in ascending order in O(1) amortised
 * time. Run boundaries are taken from the NEXT run's start rather than the current run's length,
 * so a trailing run whose length is still growing reads correctly.
 * @param {object} store the `ChannelStore` (`run.log`)
 * @param {string} name a §5.1 discrete channel name
 * @returns {(rowIndex:number) => *} value at a row, `''` where the channel has no run yet
 */
function discreteReader(store, name) {
  const entry = store && store.discrete ? store.discrete[name] : null;
  const runs = entry && Array.isArray(entry.runs) ? entry.runs : null;
  let k = 0;
  return function valueAt(i) {
    if (!runs || runs.length === 0) return '';
    while (k < runs.length - 1 && i >= runs[k + 1][1]) k++;
    while (k > 0 && i < runs[k][1]) k--;
    const r = runs[k];
    if (i < r[1]) return '';
    return r[0];
  };
}

/**
 * Render a discrete value for CSV. `qualityFlags` is normalised to `'0x' + hex4` even if the
 * store holds it as a number; `activeAlarms` is always quoted (§5.12).
 * @param {string} name discrete channel name
 * @param {*} value stored value
 * @returns {string} a CSV-safe field
 */
function discreteField(name, value) {
  if (name === 'qualityFlags' && typeof value === 'number') {
    // core/log.js stores this channel as lowercase '0x' + hex4 text; match it exactly when a
    // caller has stored the raw bitfield instead.
    return '0x' + ((value & 0xffff) >>> 0).toString(16).padStart(4, '0');
  }
  if (name === 'activeAlarms') return csvField(value === null || value === undefined ? '' : value, true);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return csvField(value);
}

/**
 * The 2 Hz log sample rate implied by the tick configuration.
 * @param {object} config frozen config
 * @returns {number} samples per second (2.0 at `dtPhys_s = 0.05`, `logEvery = 10`)
 */
function sampleRate_Hz(config) {
  return 1 / (config.sim.dtPhys_s * config.sim.logEvery);
}

/**
 * A deterministic run identifier. There is no clock and no randomness available here, so the id
 * is a pure function of the preset and the seed.
 * @param {object} config frozen config
 * @returns {string} e.g. `'cex-capture-igg1-pilot-918273645'`
 */
function runIdOf(config) {
  return `${config.presetId}-${config.seed}`;
}

/**
 * Export the 2 Hz data log as `<runId>_data.csv` (§5.12).
 *
 * Layout: 8 `#` metadata lines, one header line, then one line per logged row. Column order is
 * `t_s`, `t_iso`, the remaining 23 fixed numeric channels of §5.1 in order, the per-tank
 * `tank_<id>_L` channels in `config.tanks` order, `waste_L`, then the 15 discrete channels.
 * Channel `k` is formatted with `buildLogChannels(config).decimals[k]` and nothing else.
 *
 * @param {object} config frozen config (§2.1)
 * @param {object} run run state (§2.2); `run.log` supplies every row
 * @returns {string} the complete CSV text, UTF-8, CRLF-terminated
 */
export function exportDataCSV(config, run) {
  const ch = buildLogChannels(config);
  const names = ch.numeric;
  const decimals = ch.decimals;
  const discrete = ch.discrete;
  const hold = config.skid.holdup;
  const out = [];

  out.push(`# runId,${isoFromUnixSeconds(EPOCH_UNIX_S)},${meta(config.method ? config.method.name : '')},${meta(config.scale)}`);
  out.push(`# columnId,${meta(config.presetId)},CV_mL,${config.column.V_mL.toFixed(2)},id_cm,${config.column.id_cm.toFixed(2)},bedHeight_cm,${config.column.L_cm.toFixed(2)}`);
  out.push(`# skid,${meta(config.skid.gradientMode)},mixer_mL,${config.skid.mixerVolume_mL},uvPath_mm,${(config.skid.uv.pathlength_cm * 10).toFixed(2)},wavelengths_nm,${config.skid.uv.channels_nm.join(';')}`);
  out.push(`# delayVolumes_mL,V_grad,${hold.Vgrad_mL.toFixed(2)},V_colOut_UV,${hold.VcolOutToUV_mL.toFixed(2)},V_UV_cond,${hold.VuvToCond_mL.toFixed(2)},V_cond_pH,${hold.VcondToPh_mL.toFixed(2)},V_UV_fracValve,${hold.VuvToFracValve_mL.toFixed(2)}`);
  out.push(`# sampleRate_Hz,${sampleRate_Hz(config).toFixed(1)}`);
  out.push(`# seed,${config.seed}`);
  out.push(`# schemaVersion,${config.schemaVersion}`);
  out.push('# units,see header row');

  const header = ['t_s', 't_iso'];
  for (let k = 1; k < names.length; k++) header.push(names[k]);
  for (const d of discrete) header.push(d);
  out.push(header.map((h) => csvField(h)).join(','));

  const store = run && run.log ? run.log : null;
  const n = store ? store.n : 0;
  if (n > 0) {
    const cols = new Array(names.length);
    for (let k = 0; k < names.length; k++) cols[k] = logColumn(store, names[k]);
    const readers = new Array(discrete.length);
    for (let j = 0; j < discrete.length; j++) readers[j] = discreteReader(store, discrete[j]);

    const t = cols[0];
    const row = new Array(header.length);
    for (let i = 0; i < n; i++) {
      const t_s = t ? t[i] : NaN;
      row[0] = num(t_s, decimals[0]);
      row[1] = Number.isFinite(t_s) ? isoFromUnixSeconds(EPOCH_UNIX_S + t_s) : '';
      for (let k = 1; k < names.length; k++) {
        row[1 + k] = cols[k] ? num(cols[k][i], decimals[k]) : '';
      }
      for (let j = 0; j < discrete.length; j++) {
        row[names.length + 1 + j] = discreteField(discrete[j], readers[j](i));
      }
      out.push(row.join(','));
    }
  }

  return out.join(CRLF) + CRLF;
}

/**
 * Export the event log as `<runId>_events.csv` (§5.12).
 * @param {object} config frozen config (§2.1)
 * @param {object} run run state; `run.events` supplies the rows (§5.10)
 * @returns {string} the complete CSV text, UTF-8, CRLF-terminated
 */
export function exportEventsCSV(config, run) {
  const out = [EVENT_FIELDS.join(',')];
  const events = run && Array.isArray(run.events) ? run.events : [];
  for (const e of events) {
    let detail = '';
    if (e.detail !== null && e.detail !== undefined) {
      try {
        detail = JSON.stringify(plainClone(e.detail));
      } catch (err) {
        detail = '';
      }
    }
    out.push([
      num(e.t_s, DECIMALS.t_s),
      Number.isFinite(e.t_s) ? isoFromUnixSeconds(EPOCH_UNIX_S + e.t_s) : '',
      num(e.V_mL, DECIMALS.V_mL),
      num(e.V_CV, DECIMALS.V_CV),
      csvField(e.type),
      csvField(e.severity),
      csvField(e.source),
      csvField(e.blockId),
      csvField(e.message),
      csvField(detail),
    ].join(','));
  }
  return out.join(CRLF) + CRLF;
}

/**
 * Export the fraction table as `<runId>_fractions.csv` — the 23 columns of §5.12, in order.
 * @param {object} config frozen config (§2.1)
 * @param {object} run run state; `run.frac.records` supplies the rows (§5.11.2)
 * @returns {string} the complete CSV text, UTF-8, CRLF-terminated
 */
export function exportFractionsCSV(config, run) {
  const out = [FRACTION_FIELDS.join(',')];
  const records = run && run.frac && Array.isArray(run.frac.records) ? run.frac.records : [];
  for (const r of records) {
    const row = new Array(FRACTION_FIELDS.length);
    for (let k = 0; k < FRACTION_FIELDS.length; k++) {
      const f = FRACTION_FIELDS[k];
      const v = r[f];
      if (f === 'index') {
        row[k] = typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '';
      } else if (typeof v === 'boolean') {
        row[k] = v ? 'true' : 'false';
      } else if (Object.prototype.hasOwnProperty.call(DECIMALS, f)) {
        row[k] = num(v, DECIMALS[f]);
      } else if (typeof v === 'number') {
        row[k] = num(v, 4);
      } else {
        row[k] = csvField(v);
      }
    }
    out.push(row.join(','));
  }
  return out.join(CRLF) + CRLF;
}

/**
 * Assemble the complete run export object (§5.13). Plain columnar JSON only — the base64
 * `Float32Array` variant is deferred (§12, D13).
 *
 * Numeric channel values are rounded to the channel's own decimal count and `NaN` is emitted as
 * `null`, so `JSON.stringify` of the result is lossless with respect to the CSV. The per-species
 * ground-truth channels (`run.log.truth`) are deliberately NOT exported.
 *
 * @param {object} config frozen config (§2.1)
 * @param {object} run run state (§2.2)
 * @param {{peaks?:Array<object>, pool?:object|null, massBalance?:object|null,
 *          packingTest?:object|null}|null} results analytics results, or null
 * @returns {object} the §5.13 export object; volumes mL, masses mg, pressures bar, times s
 */
export function exportRunJSON(config, run, results) {
  const ch = buildLogChannels(config);
  const store = run && run.log ? run.log : null;
  const n = store ? store.n : 0;
  const res = results || {};

  const channels = {};
  for (let k = 0; k < ch.numeric.length; k++) {
    const name = ch.numeric[k];
    const dec = ch.decimals[k];
    const col = store ? logColumn(store, name) : null;
    const values = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = col ? col[i] : NaN;
      values[i] = Number.isFinite(v) ? Number(v.toFixed(dec)) : null;
    }
    channels[name] = { unit: ch.units[k], decimals: dec, values };
  }

  const discrete = {};
  for (const name of ch.discrete) {
    const entry = store && store.discrete ? store.discrete[name] : null;
    discrete[name] = { encoding: 'RLE', runs: entry ? plainClone(entry.runs) : [] };
  }

  const tanks = config.tanks.map((t, k) => {
    const endVolume_mL = run && run.tankVolume_mL ? run.tankVolume_mL[k] : t.startVolume_mL;
    return {
      id: t.id,
      startVolume_mL: t.startVolume_mL,
      endVolume_mL,
      consumed_mL: t.startVolume_mL - endVolume_mL,
    };
  });

  const hold = config.skid.holdup;
  const outcome = run.state === 'ENDED' ? 'COMPLETED' : (run.state === 'FAULT' ? 'FAULTED' : 'ABORTED');

  return {
    schemaVersion: '2.0',
    runId: runIdOf(config),
    runName: config.name,
    startedAt: isoFromUnixSeconds(EPOCH_UNIX_S),
    endedAt: isoFromUnixSeconds(EPOCH_UNIX_S + (run.t_s || 0)),
    durationSimulated_s: run.t_s || 0,
    seed: config.seed,
    outcome,
    scale: config.scale,

    method: plainClone(config.method),
    config: plainClone(config),
    derivedConstants: {
      CV_mL: config.column.V_mL,
      area_cm2: config.column.A_cm2,
      Vsuction_mL: hold.Vsuction_mL,
      Vgrad_mL: hold.Vgrad_mL,
      VcolOutToUV_mL: hold.VcolOutToUV_mL,
      VuvToCond_mL: hold.VuvToCond_mL,
      VcondToPh_mL: hold.VcondToPh_mL,
      VuvToFracValve_mL: hold.VuvToFracValve_mL,
      VfracDeadLeg_mL: hold.VfracDeadLeg_mL,
      sigmaGrad_mL: hold.sigmaGrad_mL,
      NeffGrad: hold.NeffGrad,
      sigmaInjToUV_mL: hold.sigmaInjToUV_mL,
    },
    tanks,

    data: { sampleRate_Hz: sampleRate_Hz(config), n, channels, discrete },

    events: plainClone(run.events || []),
    fractions: plainClone(run.frac ? run.frac.records || [] : []),

    results: {
      peaks: plainClone(res.peaks || []),
      pool: res.pool ? plainClone(res.pool) : null,
      massBalance: res.massBalance ? plainClone(res.massBalance) : null,
      packingTest: res.packingTest ? plainClone(res.packingTest) : null,
    },

    summary: buildSummary(config, run, store, res),
  };
}

/**
 * Build the §5.13 `summary` block from the log and the analytics results.
 * @param {object} config frozen config
 * @param {object} run run state
 * @param {object|null} store `run.log`, or null
 * @param {object} res the analytics results object (may be empty)
 * @returns {{totalVolume_mL:number, totalVolume_CV:number, peakMax_mAU:number,
 *            peakMax_volume_mL:number, pooledVolume_mL:number, pooledMass_mg:number,
 *            stepYield_pct:number, maxP1_bar:number, maxDP_bar:number,
 *            alarmCount:{WARN:number, ALARM:number, CRITICAL:number, FAULT:number}}}
 */
function buildSummary(config, run, store, res) {
  const n = store ? store.n : 0;
  const uv = store ? logColumn(store, 'UV_280_mAU') : null;
  const V = store ? logColumn(store, 'V_mL') : null;
  const p1 = store ? logColumn(store, 'P1_bar') : null;
  const dp = store ? logColumn(store, 'dP_bar') : null;

  let peakMax_mAU = 0;
  let peakMax_volume_mL = 0;
  let maxP1_bar = 0;
  let maxDP_bar = 0;
  for (let i = 0; i < n; i++) {
    if (uv && Number.isFinite(uv[i]) && uv[i] > peakMax_mAU) {
      peakMax_mAU = uv[i];
      peakMax_volume_mL = V && Number.isFinite(V[i]) ? V[i] : 0;
    }
    if (p1 && Number.isFinite(p1[i]) && p1[i] > maxP1_bar) maxP1_bar = p1[i];
    if (dp && Number.isFinite(dp[i]) && dp[i] > maxDP_bar) maxDP_bar = dp[i];
  }

  const alarmCount = { WARN: 0, ALARM: 0, CRITICAL: 0, FAULT: 0 };
  for (const e of run.events || []) {
    if (e.type !== 'ALARM_RAISED') continue;
    if (Object.prototype.hasOwnProperty.call(alarmCount, e.severity)) alarmCount[e.severity]++;
  }

  const pool = res.pool || null;
  const productIdx = config.idxById[config.load.productSpeciesId];
  let pooledMass_mg = 0;
  if (pool && pool.mass_mg && productIdx !== undefined && productIdx >= 0) {
    pooledMass_mg = pool.mass_mg[productIdx] || 0;
  } else if (run.massPool_umol && productIdx !== undefined && productIdx >= 0) {
    // Fallback: the solver-side pooled amount (umol, R-U4) converted at the reporting boundary.
    pooledMass_mg = mg_from_umol(run.massPool_umol[productIdx], config.species[productIdx].MW_gmol);
  }

  return {
    totalVolume_mL: run.V_tot_mL || 0,
    totalVolume_CV: (run.V_tot_mL || 0) / config.column.V_mL,
    peakMax_mAU,
    peakMax_volume_mL,
    pooledVolume_mL: pool ? pool.V_pool_mL : 0,
    pooledMass_mg,
    stepYield_pct: pool && Number.isFinite(pool.yield_frac) ? pool.yield_frac * 100 : 0,
    maxP1_bar,
    maxDP_bar,
    alarmCount,
  };
}

/**
 * Export the currently loaded method as a plain, JSON-safe object.
 *
 * The normalised method preserves `authoredAs` on every converted threshold and `_raw` verbatim
 * (§5.4.6), so the round trip through {@link importMethodJSON} is lossless.
 *
 * @param {object} config frozen config whose `config.method` is exported
 * @returns {object} `{ schemaVersion, exportedFrom, method }` — plain data, no typed arrays
 */
export function exportMethodJSON(config) {
  return {
    schemaVersion: '2.0',
    exportedFrom: { presetId: config.presetId, scale: config.scale, CV_mL: config.column.V_mL },
    method: plainClone(config.method),
  };
}

/**
 * Read a method back from a parsed JSON object.
 *
 * This is a STRUCTURAL check only — it accepts either the wrapper produced by
 * {@link exportMethodJSON} or a bare method object. Semantic validation and unit conversion are
 * `skid/method.js::validateMethod` / `normalizeMethod`, which run at the ingest boundary when the
 * caller passes the result to `core/sim.js::loadMethod` (§5.4.6, §6.15).
 *
 * @param {object} config frozen config (used for the scale-mismatch warning only)
 * @param {object} obj a parsed JSON value
 * @returns {{ok:boolean, method:object|null, errors:string[]}} `method` is null when `ok` is false
 */
export function importMethodJSON(config, obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, method: null, errors: ['not a JSON object'] };
  }
  const method = (obj.method && typeof obj.method === 'object' && !Array.isArray(obj.method))
    ? obj.method : obj;

  if (!Array.isArray(method.blocks)) {
    errors.push('method.blocks is missing or not an array');
  } else if (method.blocks.length === 0) {
    errors.push('method.blocks is empty');
  } else {
    const seen = Object.create(null);
    method.blocks.forEach((b, i) => {
      if (!b || typeof b !== 'object') {
        errors.push(`blocks[${i}] is not an object`);
        return;
      }
      if (typeof b.id !== 'string' || b.id === '') errors.push(`blocks[${i}] has no id`);
      else if (seen[b.id]) errors.push(`duplicate block id '${b.id}'`);
      else seen[b.id] = true;
      if (typeof b.type !== 'string' || b.type === '') errors.push(`blocks[${i}] has no type`);
      if (b.duration !== undefined && (b.duration === null || typeof b.duration !== 'object')) {
        errors.push(`blocks[${i}].duration must be an object`);
      }
    });
  }
  if (method.schemaVersion !== undefined && method.schemaVersion !== '2.0') {
    errors.push(`unsupported schemaVersion '${method.schemaVersion}' (expected '2.0')`);
  }
  if (obj.exportedFrom && obj.exportedFrom.scale && obj.exportedFrom.scale !== config.scale) {
    errors.push(`method was authored at ${obj.exportedFrom.scale} scale, this skid is ${config.scale}`);
  }

  if (errors.length > 0) return { ok: false, method: null, errors };
  return { ok: true, method: plainClone(method), errors: [] };
}

/**
 * Offer a text payload to the browser as a file download. DOM inside this body only — never
 * reached from a test path (§0, DoD 2).
 * @param {string} filename suggested file name, e.g. `'run_data.csv'`
 * @param {string} text file contents
 * @param {string} mime MIME type, e.g. `'text/csv;charset=utf-8'`
 * @returns {void}
 */
export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  downloadBlob(filename, blob);
}

/**
 * Offer a Blob to the browser as a file download. DOM inside this body only (§0, DoD 2).
 * @param {string} filename suggested file name
 * @param {Blob} blob the payload
 * @returns {void}
 */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
