/**
 * src/core/log.js — everything that records: the 2 Hz channel store, the 20 Hz ring
 * buffer, the complete log-channel table with units and decimals, the `qualityFlags`
 * bitfield, the event log and the UI bus.
 *
 * Contract: architecture-v2.md §6.2 (this module), §5.1 (channels), §5.3 (QF),
 * §5.10 (events), §5.12 (CSV order), §4 (layering).
 *
 * LAYER L0 — THIS FILE IMPORTS NOTHING, and that is load-bearing. Every `skid/*` module
 * logs, and `core/state.js` sits at L8 above `data/presets.js`, which is above
 * `skid/skid.js`; putting `logEvent`/`createBus` in `core/state.js` closes the cycle
 * `state -> presets -> skid -> state` under every test file (§11 C-66). With no imports
 * here, logging is always safe from anywhere.
 *
 * No DOM, no `Date`, no `Math.random`, no network.
 */

/* -------------------------------------------------------------------------- */
/* 1. CHANNEL TABLES (§5.1)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The 24 fixed numeric log channels, in CSV order.
 * Row shape: `[name, unit, sourceExpr, decimals]`. `sourceExpr` is documentation of the
 * `run` field the value comes from; `decimals` is the ONLY decimal source for
 * `<runId>_data.csv` (§5.12) — `io/export.js::DECIMALS` covers events and fractions only.
 *
 * `buildLogChannels(config)` appends one `tank_<id>_L` per `config.tanks` entry (SOURCE
 * tanks only — there is no waste tank) and then exactly one `waste_L`.
 * @type {Array<[string, string, string, number]>}
 */
export const NUMERIC_CHANNELS = Object.freeze([
  // name                   unit       source (run field)                        decimals
  ['t_s', 's', 'run.t_s', 2],
  ['V_mL', 'mL', 'run.V_tot_mL', 2],
  ['V_CV', 'CV', 'run.V_tot_mL/config.column.V_mL', 4],
  ['V_block_mL', 'mL', 'run.V_block_mL', 2],
  ['V_block_CV', 'CV', 'run.V_block_mL/config.column.V_mL', 4],
  ['UV_280_mAU', 'mAU', '1000*run.uv.Afilt[0]', 2],
  ['UV_260_mAU', 'mAU', '1000*run.uv.Afilt[1]', 2],
  ['UV_300_mAU', 'mAU', '1000*run.uv.Afilt[2]', 2],
  ['UV_ratio_260_280', '-', 'Afilt[1]/Afilt[0], NaN if UV_280<10 mAU', 4],
  ['cond_mS_cm', 'mS/cm', 'run.cond.kappaDisp_mScm', 3],
  ['cond_raw_mS_cm', 'mS/cm', 'run.cond.kappaFilt_mScm', 3],
  ['cond_temp_C', 'C', 'run.T_cell_C', 2],
  ['pH', '-', 'run.ph.pHfilt', 3],
  ['P1_bar', 'bar', 'run.press.P1disp_bar', 3],
  ['P2_bar', 'bar', 'run.press.P2disp_bar', 3],
  ['dP_bar', 'bar', 'P1disp - P2disp', 3],
  ['flow_mL_min', 'mL/min', '60*run.Q_actual_mLs', 2],
  ['flow_cm_h', 'cm/h', '3600*run.Q_actual_mLs/A_cm2', 1],
  ['flow_setpoint_mL_min', 'mL/min', '60*run.Q_set_mLs', 2],
  ['pctB_setpoint', '%', 'run.pctB_set', 1],
  ['pctB_column_inlet', '%', 'run.pctB_colInlet', 1],
  ['conc_NaCl_M', 'mol/L', 'min(yCond[Na],yCond[Cl])/1000', 4],
  ['temp_fluid_C', 'C', 'run.T_fluid_C', 2],
  ['air_fraction', '-', 'run.fAirDet', 4],
]);

/**
 * The 15 fixed discrete (RLE) log channels, in CSV order (§5.1).
 * @type {string[]}
 */
export const DISCRETE_CHANNELS = Object.freeze([
  'state', 'blockId', 'blockName', 'blockType', 'phaseIndex',
  'inletA', 'inletB', 'inletSample', 'columnValve', 'outletValve',
  'fractionId', 'fractionating', 'activeAlarms', 'manualOverride', 'qualityFlags',
]);

/** Unit of every appended tank channel and of `waste_L`. */
const TANK_UNIT = 'L';
/** Decimals of every appended tank channel and of `waste_L`. */
const TANK_DECIMALS = 3;

/* -------------------------------------------------------------------------- */
/* 2. QUALITY FLAGS (§5.3)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `run.qualityFlags` bitfield (§5.3). `skid/sensors.js::updateQualityFlags` recomputes the
 * non-latched bits every tick; `UV_SATURATED` and `BED_COLLAPSED` latch until
 * `resetRunState`. Emitted to CSV as `'0x' + hex4`.
 * @type {Object<string, number>}
 */
export const QF = Object.freeze({
  UV_OVERRANGE: 0x0001,
  UV_SATURATED: 0x0002,
  UV_LAMP_FAULT: 0x0004,
  UV_AUTOZERO_UNSTABLE: 0x0008,
  COND_DRY: 0x0010,
  COND_TEMP_RANGE: 0x0020,
  PH_FROZEN_AIR: 0x0040,
  PH_ELECTRODE_DEGRADED: 0x0080,
  PRESS_SUSPECT: 0x0100,
  DETECTORS_BYPASSED: 0x0200,
  AIR_IN_PATH: 0x0400,
  FLOW_REDUCED: 0x0800,
  MANUAL_OVERRIDE: 0x1000,
  SOLVER_FROZEN: 0x2000,
  SPEED_LIMITED: 0x4000,
  BED_COLLAPSED: 0x8000,
});

/* -------------------------------------------------------------------------- */
/* 3. CHANNEL LIST CONSTRUCTION                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the ordered channel lists for a config. Deterministic given `config`: the 24 fixed
 * numeric rows, then one `tank_<id>_L` per `config.tanks` entry in array order, then
 * exactly one `waste_L` (§5.1). `units`/`decimals` are parallel to `numeric`.
 *
 * @param {object} config The frozen config (§2.1). Reads `config.tanks[].id` and
 *   `config.species[].id` only.
 * @returns {{numeric:string[], discrete:string[], units:string[], decimals:number[],
 *            truth:string[]}} Channel names; `units` are display unit strings
 *   ('mL', 'mS/cm', 'bar', 'L', …), `decimals` are CSV decimal places, `truth` is the
 *   `ns` ground-truth channel names `truth_<speciesId>_mM`.
 */
export function buildLogChannels(config) {
  const numeric = [];
  const units = [];
  const decimals = [];
  for (let k = 0; k < NUMERIC_CHANNELS.length; k++) {
    const row = NUMERIC_CHANNELS[k];
    numeric.push(row[0]);
    units.push(row[1]);
    decimals.push(row[3]);
  }
  const tanks = config && config.tanks ? config.tanks : [];
  for (let k = 0; k < tanks.length; k++) {
    numeric.push('tank_' + tanks[k].id + '_L');
    units.push(TANK_UNIT);
    decimals.push(TANK_DECIMALS);
  }
  numeric.push('waste_L');
  units.push(TANK_UNIT);
  decimals.push(TANK_DECIMALS);

  const truth = [];
  const species = config && config.species ? config.species : [];
  for (let i = 0; i < species.length; i++) truth.push('truth_' + species[i].id + '_mM');

  return { numeric, discrete: DISCRETE_CHANNELS.slice(), units, decimals, truth };
}

/**
 * Number of numeric channels a config produces: 24 fixed + one per tank + `waste_L`.
 * @param {object} config The frozen config.
 * @returns {number} Channel count, dimensionless.
 */
function numericChannelCount(config) {
  const tanks = config && config.tanks ? config.tanks : [];
  return NUMERIC_CHANNELS.length + tanks.length + 1;
}

/* -------------------------------------------------------------------------- */
/* 4. CHANNEL STORE — the 2 Hz whole-run log                                  */
/* -------------------------------------------------------------------------- */

/** Returned by `column()` for an unknown channel name. Never written to. */
const EMPTY_F32 = new Float32Array(0);

/**
 * Create the columnar channel store. One `Float32Array` per channel, grown in
 * `chunkRows`-row chunks — never an array of objects (§5.1).
 *
 * The store starts at `n = 0, cap = 0`; the first `pushRow` allocates the first chunk.
 * `store.discrete` is pre-populated with the 15 fixed discrete channels so an exporter
 * always finds a `{runs:[]}` entry. `store.truth` is empty until the first `pushRow` that
 * carries a truth vector, which then fixes the truth column count for the run.
 *
 * @param {string[]} channelNames Numeric channel names, in CSV order
 *   (`buildLogChannels(config).numeric`).
 * @param {number} [chunkRows=4096] Growth granularity, rows.
 * @returns {{names:string[], index:Map<string,number>, cols:Float32Array[], n:number,
 *            cap:number, chunkRows:number,
 *            discrete:Object<string,{runs:Array<[any,number,number]>}>,
 *            truth:Float32Array[]}} A fresh store. `n` is rows written, `cap` is rows
 *   allocated; `chunkRows` is carried on the store because `pushRow` needs it.
 */
export function createChannelStore(channelNames, chunkRows = 4096) {
  const names = channelNames.slice();
  const index = new Map();
  const cols = new Array(names.length);
  for (let k = 0; k < names.length; k++) {
    index.set(names[k], k);
    cols[k] = EMPTY_F32;
  }
  const discrete = {};
  for (let k = 0; k < DISCRETE_CHANNELS.length; k++) {
    discrete[DISCRETE_CHANNELS[k]] = { runs: [] };
  }
  const chunk = chunkRows > 0 ? Math.floor(chunkRows) : 4096;
  return { names, index, cols, n: 0, cap: 0, chunkRows: chunk, discrete, truth: [] };
}

/**
 * Grow the store to hold one more row, and reconcile the truth column count.
 * `store.cols` AND `store.truth` are reallocated in the SAME growth step so both stay
 * indexed by the same row number (§6.2) — growing `cols` alone leaves `truth` at cap 0
 * forever and makes `poolMetrics(mode:'truth')` read garbage.
 * @param {object} store The channel store.
 * @param {number} nTruth Required truth column count, dimensionless.
 * @returns {void}
 */
function ensureCapacity(store, nTruth) {
  if (store.n >= store.cap) {
    const newCap = store.cap + store.chunkRows;
    for (let k = 0; k < store.cols.length; k++) {
      const next = new Float32Array(newCap);
      next.set(store.cols[k]);
      store.cols[k] = next;
    }
    for (let k = 0; k < store.truth.length; k++) {
      const next = new Float32Array(newCap);
      next.set(store.truth[k]);
      store.truth[k] = next;
    }
    store.cap = newCap;
  }
  if (store.truth.length !== nTruth) {
    const t = store.truth;
    while (t.length > nTruth) t.pop();
    while (t.length < nTruth) {
      const col = new Float32Array(store.cap);
      // Rows written before the truth store existed must read NaN, not 0.
      if (store.n > 0) col.fill(NaN, 0, store.n);
      t.push(col);
    }
  }
}

/**
 * Append one row. Amortised O(1).
 *
 * @param {object} store The channel store from `createChannelStore`.
 * @param {Float64Array} values One value per numeric channel, in `store.names` order and
 *   in that channel's unit (see `NUMERIC_CHANNELS`).
 * @param {Float64Array|null} truthValues The species-resolved detector-plane vector
 *   (`run.yDet_mM`, mM, length `ns`), or `null` to write `NaN` into every truth column.
 * @returns {void}
 */
export function pushRow(store, values, truthValues) {
  const nTruth = truthValues == null ? store.truth.length : truthValues.length;
  ensureCapacity(store, nTruth);
  const row = store.n;
  const cols = store.cols;
  for (let k = 0; k < cols.length; k++) cols[k][row] = values[k];
  const t = store.truth;
  if (truthValues == null) {
    for (let k = 0; k < t.length; k++) t[k][row] = NaN;
  } else {
    for (let k = 0; k < t.length; k++) t[k][row] = truthValues[k];
  }
  store.n = row + 1;
}

/**
 * Append a discrete (RLE) sample. A run is extended when the value is unchanged and
 * contiguous; otherwise a new `[value, start, len]` run is appended (§5.1).
 * @param {object} store The channel store.
 * @param {string} name Discrete channel name (one of `DISCRETE_CHANNELS`).
 * @param {any} value String, number, boolean or null — stored verbatim.
 * @param {number} rowIndex The row this sample belongs to (usually `store.n - 1`).
 * @returns {void}
 */
export function pushDiscrete(store, name, value, rowIndex) {
  let d = store.discrete[name];
  if (d === undefined) {
    d = { runs: [] };
    store.discrete[name] = d;
  }
  const runs = d.runs;
  const last = runs.length > 0 ? runs[runs.length - 1] : null;
  if (last !== null && Object.is(last[0], value) && last[1] + last[2] === rowIndex) {
    last[2]++;
    return;
  }
  runs.push([value, rowIndex, 1]);
}

/**
 * A live view of one numeric channel.
 *
 * THE RETURNED VIEW IS INVALIDATED BY THE NEXT `pushRow` THAT GROWS THE STORE (§6.2).
 * Every consumer must re-fetch it each frame; `store.cols` is never cached across a
 * `pushRow`. An unknown channel name yields a zero-length array rather than `undefined`,
 * so callers can always read `.length`.
 * @param {object} store The channel store.
 * @param {string} name Channel name.
 * @returns {Float32Array} Subarray of length `store.n`, in that channel's unit.
 */
export function column(store, name) {
  const k = store.index.get(name);
  if (k === undefined) return EMPTY_F32;
  return store.cols[k].subarray(0, store.n);
}

/**
 * First index with `x[i] >= target`, over `x[0..n)`. Binary search.
 * @param {Float32Array} x Monotone non-decreasing channel.
 * @param {number} n Number of valid samples.
 * @param {number} target Search value, same unit as `x`.
 * @returns {number} Index in [0, n].
 */
function lowerBound(x, n, target) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * First index with `x[i] > target`, over `x[0..n)`. Binary search.
 * @param {Float32Array} x Monotone non-decreasing channel.
 * @param {number} n Number of valid samples.
 * @param {number} target Search value, same unit as `x`.
 * @returns {number} Index in [0, n].
 */
function upperBound(x, n, target) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Row range covering an x-window, by binary search.
 *
 * LEGAL ONLY ON A MONOTONE NON-DECREASING CHANNEL — `'V_mL'` and `'t_s'` (and `'V_CV'`,
 * which is `V_mL` times a constant). `run.V_tot_mL` integrates `|Q_actual|`, so a reversed
 * column valve still advances it (§6.2).
 *
 * @param {object} store The channel store.
 * @param {string} xName Monotone channel name, 'V_mL' or 't_s'.
 * @param {number} x0 Window start, in that channel's unit (mL or s).
 * @param {number} x1 Window end, same unit.
 * @returns {{i0:number, i1:number}} HALF-OPEN row range `[i0, i1)` covering every sample
 *   with `x0 <= x <= x1`; `i0 === i1` when the window holds no samples.
 */
export function xIndexRange(store, xName, x0, x1) {
  const x = column(store, xName);
  const n = x.length;
  const i0 = lowerBound(x, n, x0);
  let i1 = upperBound(x, n, x1);
  if (i1 < i0) i1 = i0;
  return { i0, i1 };
}

/**
 * Min/max decimation for a chart, binned on the X-CHANNEL VALUE.
 *
 * NEVER ON THE ROW INDEX: the log is uniform in TIME (2 Hz), not in volume or CV, so index
 * binning horizontally distorts every trace in the volume and cv x-modes and makes
 * retention volume unreadable off the chart (§6.2, §11 C-80).
 *
 * Zero allocation: outputs are caller-owned and the scan is a single forward pass over the
 * rows in `[x0, x1]`. Empty bins receive `NaN` in both outputs; `NaN` samples are skipped
 * so a `NaN` in e.g. `UV_ratio_260_280` cannot poison a bin.
 *
 * @param {object} store The channel store.
 * @param {string} xName Monotone x channel, 'V_mL' or 't_s'.
 * @param {string} yName Series channel to decimate.
 * @param {number} x0 Window start, in the x channel's unit.
 * @param {number} x1 Window end, same unit.
 * @param {number} pixels Number of bins (device pixel columns), dimensionless.
 * @param {Float32Array} outMin Caller-owned output, >= `pixels` long; y-channel unit.
 * @param {Float32Array} outMax Caller-owned output, >= `pixels` long; y-channel unit.
 * @returns {void}
 */
export function decimateMinMax(store, xName, yName, x0, x1, pixels, outMin, outMax) {
  let p = pixels | 0;
  if (p > outMin.length) p = outMin.length;
  if (p > outMax.length) p = outMax.length;
  for (let k = 0; k < p; k++) {
    outMin[k] = NaN;
    outMax[k] = NaN;
  }
  if (p <= 0) return;
  const span = x1 - x0;
  if (!(span > 0)) return;

  const x = column(store, xName);
  const y = column(store, yName);
  let n = x.length;
  if (y.length < n) n = y.length;
  if (n === 0) return;

  const inv = p / span;
  for (let i = lowerBound(x, n, x0); i < n; i++) {
    const xv = x[i];
    if (xv > x1) break;
    const v = y[i];
    if (v !== v) continue; // skip NaN
    let b = Math.floor((xv - x0) * inv);
    if (b < 0) b = 0;
    else if (b >= p) b = p - 1;
    const lo = outMin[b];
    if (lo !== lo || v < lo) outMin[b] = v;
    const hi = outMax[b];
    if (hi !== hi || v > hi) outMax[b] = v;
  }
}

/* -------------------------------------------------------------------------- */
/* 5. RING BUFFER — the 20 Hz trailing window                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create the trailing ring buffer. It carries EXACTLY the same channel list as the
 * channel store, at 20 Hz over `config.sim.ringSeconds` (§5.1: one list, two rates).
 * Fully preallocated — `pushRing` never allocates.
 * @param {string[]} channelNames Numeric channel names, same list as the store.
 * @param {number} rows Ring depth, rows (e.g. `ringSeconds / dtPhys_s` = 2400).
 * @returns {{names:string[], index:Map<string,number>, cols:Float32Array[], rows:number,
 *            head:number, count:number}} A fresh ring.
 */
export function createRing(channelNames, rows) {
  const names = channelNames.slice();
  const index = new Map();
  const r = Math.max(1, Math.floor(rows));
  const cols = new Array(names.length);
  for (let k = 0; k < names.length; k++) {
    index.set(names[k], k);
    cols[k] = new Float32Array(r);
  }
  return { names, index, cols, rows: r, head: 0, count: 0 };
}

/**
 * Write one row into the ring, overwriting the oldest sample once full. Zero allocation.
 * @param {object} ring The ring from `createRing`.
 * @param {Float64Array} values One value per channel, in `ring.names` order and unit.
 * @returns {void}
 */
export function pushRing(ring, values) {
  const h = ring.head;
  const cols = ring.cols;
  for (let k = 0; k < cols.length; k++) cols[k][h] = values[k];
  ring.head = h + 1 === ring.rows ? 0 : h + 1;
  if (ring.count < ring.rows) ring.count++;
}

/**
 * Copy one ring channel into a caller-owned buffer, OLDEST FIRST. When `out` is shorter
 * than the ring holds, the MOST RECENT `out.length` samples are written (a trailing
 * window is what every consumer of a 20 Hz ring wants).
 * @param {object} ring The ring.
 * @param {string} name Channel name.
 * @param {Float32Array} out Caller-owned destination; that channel's unit.
 * @returns {number} Number of samples written, oldest first; 0 for an unknown channel.
 */
export function readRing(ring, name, out) {
  const k = ring.index.get(name);
  if (k === undefined) return 0;
  const col = ring.cols[k];
  const rows = ring.rows;
  const nWrite = Math.min(ring.count, out.length);
  let start = ring.head - nWrite;
  while (start < 0) start += rows;
  for (let j = 0; j < nWrite; j++) {
    let idx = start + j;
    if (idx >= rows) idx -= rows;
    out[j] = col[idx];
  }
  return nWrite;
}

/* -------------------------------------------------------------------------- */
/* 6. PER-TICK ROW ASSEMBLY (physicsTick steps 13 and 14)                     */
/* -------------------------------------------------------------------------- */

/**
 * Module-owned scratch row, reused by both `appendLogRow` and `pushRingRow`. Neither
 * callee retains it — `pushRow` and `pushRing` copy into `Float32Array` immediately — so
 * one buffer is enough and the per-tick path allocates nothing.
 * @type {Float64Array|null}
 */
let rowScratch = null;

/** Cache for the `'0x' + hex4` quality-flag string, so the 2 Hz path allocates no string. */
let qfCachedValue = -1;
let qfCachedText = '0x0000';

/**
 * Get (and lazily size) the shared scratch row.
 * @param {number} len Required length, channels.
 * @returns {Float64Array} A scratch row of exactly `len` doubles.
 */
function getRowScratch(len) {
  if (rowScratch === null || rowScratch.length !== len) rowScratch = new Float64Array(len);
  return rowScratch;
}

/**
 * Fill one numeric row from `run`, in `NUMERIC_CHANNELS` order plus the per-tank channels
 * and `waste_L`. Every expression is the one named in the channel table (§5.1).
 * @param {object} config The frozen config.
 * @param {object} run The mutable run state.
 * @param {Float64Array} out Destination row, `numericChannelCount(config)` long.
 * @returns {void}
 */
function fillNumericRow(config, run, out) {
  const col = config.column;
  const Vcol_mL = col.V_mL;
  const uv = run.uv;
  const press = run.press;

  const uv280_mAU = 1000 * uv.Afilt[0];
  const uv260_mAU = 1000 * uv.Afilt[1];
  const uv300_mAU = 1000 * uv.Afilt[2];

  out[0] = run.t_s;
  out[1] = run.V_tot_mL;
  out[2] = run.V_tot_mL / Vcol_mL;
  out[3] = run.V_block_mL;
  out[4] = run.V_block_mL / Vcol_mL;
  out[5] = uv280_mAU;
  out[6] = uv260_mAU;
  out[7] = uv300_mAU;
  // NaN below 10 mAU on the 280 channel: the ratio is meaningless on baseline (§5.1).
  out[8] = uv280_mAU < 10 ? NaN : uv.Afilt[1] / uv.Afilt[0];
  out[9] = run.cond.kappaDisp_mScm;
  out[10] = run.cond.kappaFilt_mScm;
  out[11] = run.T_cell_C;
  out[12] = run.ph.pHfilt;
  out[13] = press.P1disp_bar;
  out[14] = press.P2disp_bar;
  out[15] = press.P1disp_bar - press.P2disp_bar;
  out[16] = 60 * run.Q_actual_mLs;
  out[17] = (3600 * run.Q_actual_mLs) / col.A_cm2;
  out[18] = 60 * run.Q_set_mLs;
  out[19] = run.pctB_set;
  out[20] = run.pctB_colInlet;

  // conc_NaCl_M — the common NaCl concentration at the conductivity cell plane, mol/L.
  let naCl_molL = NaN;
  const idxById = config.idxById;
  const yCond = run.yCond_mM;
  if (yCond && idxById && idxById.Na !== undefined && idxById.Cl !== undefined) {
    const na_mM = yCond[idxById.Na];
    const cl_mM = yCond[idxById.Cl];
    naCl_molL = (na_mM < cl_mM ? na_mM : cl_mM) / 1000;
  }
  out[21] = naCl_molL;
  out[22] = run.T_fluid_C;
  out[23] = run.fAirDet;

  let k = NUMERIC_CHANNELS.length;
  const tanks = config.tanks;
  const tankVolume_mL = run.tankVolume_mL;
  for (let i = 0; i < tanks.length; i++) out[k++] = tankVolume_mL[i] / 1000;
  out[k] = run.wasteVolume_mL / 1000;
}

/**
 * Semicolon-joined ids of every currently active alarm (§5.1). Returns the interned empty
 * string when nothing is active, so the common case allocates nothing.
 * @param {object} config The frozen config; reads `config.alarms[i].id`.
 * @param {object} run The run state; reads `run.alarmActive`.
 * @returns {string} e.g. `'ALM-DP-01;WRN-TNK-01'`, or `''`.
 */
function activeAlarmIds(config, run) {
  const active = run.alarmActive;
  const alarms = config.alarms;
  if (!active || !alarms) return '';
  let any = false;
  for (let i = 0; i < active.length; i++) {
    if (active[i]) {
      any = true;
      break;
    }
  }
  if (!any) return '';
  let s = '';
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue;
    if (s.length > 0) s += ';';
    s += alarms[i].id;
  }
  return s;
}

/**
 * `'0x' + hex4` rendering of the quality bitfield (§5.1), cached so an unchanged bitfield
 * allocates no string.
 * @param {number} flags `run.qualityFlags`, a 16-bit bitfield.
 * @returns {string} e.g. `'0x0410'`.
 */
function qualityFlagsText(flags) {
  const v = flags & 0xffff;
  if (v !== qfCachedValue) {
    qfCachedValue = v;
    let hex = v.toString(16);
    while (hex.length < 4) hex = '0' + hex;
    qfCachedText = '0x' + hex;
  }
  return qfCachedText;
}

/**
 * Ensure `run.log` exists. `core/state.js::createRunState` normally builds it; this is the
 * one-time fallback so logging is never silently lost.
 * @param {object} config The frozen config.
 * @param {object} run The run state.
 * @returns {object} `run.log`.
 */
function ensureLog(config, run) {
  if (run.log == null) run.log = createChannelStore(buildLogChannels(config).numeric);
  return run.log;
}

/**
 * Ensure `run.ring` exists, sized `ringSeconds / dtPhys_s` rows.
 * @param {object} config The frozen config.
 * @param {object} run The run state.
 * @returns {object} `run.ring`.
 */
function ensureRing(config, run) {
  if (run.ring == null) {
    const sim = config.sim || {};
    const dt_s = sim.dtPhys_s > 0 ? sim.dtPhys_s : 0.05;
    const ringSeconds = sim.ringSeconds > 0 ? sim.ringSeconds : 120;
    run.ring = createRing(buildLogChannels(config).numeric, Math.round(ringSeconds / dt_s));
  }
  return run.ring;
}

/**
 * Append one row to the 2 Hz whole-run log: numeric channels, the `ns` ground-truth
 * channels (`run.yDet_mM`, the detector-plane composition in mM), and the 15 RLE discrete
 * channels. Called from `skid/skid.js::physicsTick` step 14, every `config.sim.logEvery`
 * ticks.
 * @param {object} config The frozen config.
 * @param {object} run The mutable run state; `run.log` is created on first use if null.
 * @returns {void}
 */
export function appendLogRow(config, run) {
  const store = ensureLog(config, run);
  const values = getRowScratch(numericChannelCount(config));
  fillNumericRow(config, run, values);
  pushRow(store, values, run.yDet_mM || null);

  const row = store.n - 1;
  const blocks = config.method && config.method.blocks ? config.method.blocks : null;
  const bi = run.blockIndex;
  const blk = blocks && bi >= 0 && bi < blocks.length ? blocks[bi] : null;
  const valves = run.valves;
  const frac = run.frac;

  pushDiscrete(store, 'state', run.state, row);
  pushDiscrete(store, 'blockId', blk ? blk.id : null, row);
  pushDiscrete(store, 'blockName', blk ? blk.name : null, row);
  pushDiscrete(store, 'blockType', blk ? blk.type : null, row);
  pushDiscrete(store, 'phaseIndex', bi, row);
  pushDiscrete(store, 'inletA', valves ? valves.inletA : null, row);
  pushDiscrete(store, 'inletB', valves ? valves.inletB : null, row);
  pushDiscrete(store, 'inletSample', valves ? valves.inletS : null, row);
  pushDiscrete(store, 'columnValve', valves ? valves.columnValve : null, row);
  pushDiscrete(store, 'outletValve', valves ? valves.outletValve : null, row);
  // fractionId is the FractionRecord.index of the fraction currently open (§5.11.2);
  // null whenever the fraction valve is not collecting.
  pushDiscrete(
    store,
    'fractionId',
    frac && frac.open && frac.current ? frac.current.index : null,
    row,
  );
  pushDiscrete(store, 'fractionating', !!(frac && frac.open), row);
  pushDiscrete(store, 'activeAlarms', activeAlarmIds(config, run), row);
  pushDiscrete(store, 'manualOverride', !!run.manualOverride, row);
  pushDiscrete(store, 'qualityFlags', qualityFlagsText(run.qualityFlags), row);
}

/**
 * Push one row into the 20 Hz trailing ring. Same channel list as the log, every physics
 * tick. Called from `skid/skid.js::physicsTick` step 13. Zero allocation in steady state.
 * @param {object} config The frozen config.
 * @param {object} run The mutable run state; `run.ring` is created on first use if null.
 * @returns {void}
 */
export function pushRingRow(config, run) {
  const ring = ensureRing(config, run);
  const values = getRowScratch(numericChannelCount(config));
  fillNumericRow(config, run, values);
  pushRing(ring, values);
}

/* -------------------------------------------------------------------------- */
/* 7. EVENT LOG (§5.10)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The 26 event types (§5.10).
 * @type {string[]}
 */
export const EVENT_TYPES = Object.freeze([
  'RUN_START', 'RUN_END', 'STATE_CHANGE', 'BLOCK_START', 'BLOCK_END',
  'WATCH_FIRED', 'WATCH_TIMEOUT', 'VALVE_CHANGE', 'INLET_CHANGE', 'SETPOINT_CHANGE',
  'AUTOZERO', 'FRACTION_START', 'FRACTION_END', 'PEAK_MAX', 'ALARM_RAISED',
  'ALARM_CLEARED', 'ALARM_ACK', 'OPERATOR_ACTION', 'TANK_REFILL', 'FLOW_REDUCTION_START',
  'FLOW_REDUCTION_END', 'AIR_DETECTED', 'CIP_COMPLETE', 'PACKING_TEST_RESULT',
  'SCENARIO_APPLIED', 'NOTE',
]);

/**
 * Append an event to `run.events` and return the stamped record.
 *
 * `config` is the first argument precisely so the record can carry `V_CV`, which `run`
 * alone cannot provide (§5.10, §11 C-22). This function lives at L0 with no imports so
 * every `skid/*` module can log without creating an import cycle.
 *
 * @param {object} config The frozen config; reads `config.column.V_mL` (mL) only.
 * @param {object} run The run state; reads `run.t_s` (s) and `run.V_tot_mL` (mL).
 * @param {{type:string, severity:string, source:string, blockId:(string|null),
 *          message:string, detail:(object|null)}} rec The event. `severity` is one of
 *   'INFO'|'WARN'|'ALARM'|'CRITICAL'|'FAULT'; `source` is one of
 *   'PHASE_ENGINE'|'ALARM'|'OPERATOR'|'MANUAL'|'SYSTEM'.
 * @returns {{t_s:number, V_mL:number, V_CV:number, type:string, severity:string,
 *            source:string, blockId:(string|null), message:string, detail:(object|null)}}
 *   The stored record: `t_s` in s, `V_mL` in mL, `V_CV` in column volumes.
 */
export function logEvent(config, run, rec) {
  const V_mL = run.V_tot_mL;
  const event = {
    t_s: run.t_s,
    V_mL,
    V_CV: V_mL / config.column.V_mL,
    type: rec.type,
    severity: rec.severity === undefined ? 'INFO' : rec.severity,
    source: rec.source === undefined ? 'SYSTEM' : rec.source,
    blockId: rec.blockId === undefined ? null : rec.blockId,
    message: rec.message === undefined ? '' : rec.message,
    detail: rec.detail === undefined ? null : rec.detail,
  };
  if (!run.events) run.events = [];
  run.events.push(event);
  return event;
}

/* -------------------------------------------------------------------------- */
/* 8. UI BUS                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create the synchronous UI event bus. No async, no microtasks: `emit` runs every
 * subscriber to completion before returning, so a panel that re-subscribes or
 * unsubscribes during a dispatch cannot corrupt the iteration (the handler list is
 * snapshotted first). Handler exceptions propagate — silent swallowing would hide bugs in
 * a teaching tool.
 * @returns {{on:function(string, Function):void, off:function(string, Function):void,
 *            emit:function(string, any):void}} A fresh bus. The canonical event is
 *   `'config-replaced'` with the `ctx` object as payload (§2.4).
 */
export function createBus() {
  const listeners = new Map();
  return {
    /**
     * Subscribe.
     * @param {string} name Event name.
     * @param {Function} fn Handler, called with the emitted payload.
     * @returns {void}
     */
    on(name, fn) {
      let arr = listeners.get(name);
      if (arr === undefined) {
        arr = [];
        listeners.set(name, arr);
      }
      arr.push(fn);
    },
    /**
     * Unsubscribe. Removes the first matching registration only.
     * @param {string} name Event name.
     * @param {Function} fn The exact handler reference passed to `on`.
     * @returns {void}
     */
    off(name, fn) {
      const arr = listeners.get(name);
      if (arr === undefined) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    /**
     * Dispatch synchronously to every current subscriber.
     * @param {string} name Event name.
     * @param {any} payload Passed unchanged to each handler.
     * @returns {void}
     */
    emit(name, payload) {
      const arr = listeners.get(name);
      if (arr === undefined || arr.length === 0) return;
      const snapshot = arr.slice();
      for (let i = 0; i < snapshot.length; i++) snapshot[i](payload);
    },
  };
}
