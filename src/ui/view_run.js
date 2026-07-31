/**
 * @file src/ui/view_run.js — the Run tab (architecture-v2 §6.28, §9.1.2, §9.2, §9.3).
 *
 * LAYER: `ui-panels`. Composes `ui/pid.js` and `ui/chart.js`; it never re-implements either.
 * Reads `ctx.config` / `ctx.run` fresh every frame and mutates neither — every state change goes
 * through a `core/sim.js` action, whose `{ok, reason}` is surfaced as a toast (§9.4.4).
 *
 * The two commitments of §9 bind this file:
 *   1. **Cause must be visible.** The P&ID and the chromatogram are co-visible, side by side, so a
 *      learner watching a peak tail can look left and see the bed that produced it.
 *   2. **Hover reveals detail, never existence.** Every §5.2 sensor signal — all 22 names, with
 *      `TANK_LEVEL:<id>` expanded per tank — has a permanent numeric home in the tag readout grid
 *      or the channel legend. Popovers add glossary depth; they never carry the only copy of a
 *      number.
 *
 * OWNS: the two-column grid, the phase progress rail, the fraction strip and collector, the
 * channel legend / readout table, the tag readout grid, the active-alarm list, and the two
 * `role="separator"` splitters.
 *
 * STYLES: the run view injects its own scoped stylesheet once, under the `.rv` prefix, built
 * entirely from the `styles/tokens.css` custom properties. `styles/app.css` is owned by `ui-shell`
 * and is not touched from here.
 */

import * as fmt from './format.js';
import * as chartlib from './chart.js';
import * as pidlib from './pid.js';
import * as overlaylib from './overlay.js';
import * as simlib from '../core/sim.js';
import * as sensors from '../skid/sensors.js';
import * as engine from '../skid/engine.js';
import * as methodlib from '../skid/method.js';
import { column, xIndexRange, QF } from '../core/log.js';
import { glossaryFor } from '../data/glossary.js';

/* ============================================================================================ */
/* 1. STATIC TABLES                                                                             */
/* ============================================================================================ */

/** Log channel names that carry the chart x axis, one per x mode (§9.3.2). */
const X_CHANNELS = Object.freeze({ volume: 'V_mL', time: 't_s', cv: 'V_CV' });

/** The three x modes, in the order the segmented control shows them. */
const X_MODES = Object.freeze([
  { mode: 'volume', label: 'Volume', unit: 'mL' },
  { mode: 'time', label: 'Time', unit: 'min' },
  { mode: 'cv', label: 'CV', unit: 'CV' },
]);

/**
 * The y axes of §9.3.1. pH and %B are both named `R2` in the spec table with two different fixed
 * ranges, which one axis cannot carry; they are split into `R2` (pH, 2–12) and `R2B` (%B, 0–100).
 * Only axes with a visible channel are drawn, and %B is off-scale context, so the default gutter
 * is still two right axes wide.
 */
const Y_AXES = Object.freeze([
  { id: 'L1', label: 'Absorbance', unit: 'mAU', side: 'left', mode: 'auto-sticky', min: 0, max: 100 },
  { id: 'R1', label: 'Conductivity', unit: 'mS/cm', side: 'right', mode: 'auto-sticky', min: 0, max: 10 },
  { id: 'R2', label: 'pH', unit: '', side: 'right', mode: 'manual', min: 2, max: 12 },
  { id: 'R2B', label: '%B', unit: '%', side: 'right', mode: 'manual', min: 0, max: 100 },
  { id: 'R3', label: 'Pressure / Flow', unit: 'bar · mL/min', side: 'right', mode: 'auto-sticky', min: 0, max: 2 },
]);

/** Axis ids a legend row may cycle through, in cycle order. */
const AXIS_CYCLE = Object.freeze(['L1', 'R1', 'R2', 'R2B', 'R3']);

/**
 * The eight chromatogram channels of §9.3.1. `channel` is the §5.1 log channel name; `live` reads
 * the same quantity straight off `run`, which is one log period fresher than the store.
 * Every channel carries a dash signature as well as a colour, so colour is never the sole encoder.
 */
const CHANNELS = Object.freeze([
  { id: 'uv280', label: 'UV 280', channel: 'UV_280_mAU', unit: 'mAU', axis: 'L1', dec: 1,
    colorVar: '--ch-uv280', dash: [], width: 1.5, visible: true, sensor: 'UV', glossary: 'UV_280',
    live: (c, r) => 1000 * r.uv.Afilt[0] },
  { id: 'uv260', label: 'UV 260', channel: 'UV_260_mAU', unit: 'mAU', axis: 'L1', dec: 1,
    colorVar: '--ch-uv260', dash: [], width: 2, visible: false, sensor: 'UV', glossary: 'UV_260',
    live: (c, r) => 1000 * r.uv.Afilt[1] },
  { id: 'uv300', label: 'UV 300', channel: 'UV_300_mAU', unit: 'mAU', axis: 'L1', dec: 1,
    colorVar: '--ch-uv300', dash: [1, 4], width: 1, visible: false, sensor: 'UV', glossary: 'UV_300',
    live: (c, r) => 1000 * r.uv.Afilt[2] },
  { id: 'cond', label: 'Cond', channel: 'cond_mS_cm', unit: 'mS/cm', axis: 'R1', dec: 3,
    colorVar: '--ch-cond', dash: [], width: 1.5, visible: true, sensor: 'COND', glossary: 'COND',
    live: (c, r) => r.cond.kappaDisp_mScm },
  { id: 'ph', label: 'pH', channel: 'pH', unit: '', axis: 'R2', dec: 2,
    colorVar: '--ch-ph', dash: [6, 3], width: 1.5, visible: false, sensor: 'PH', glossary: 'PH',
    live: (c, r) => r.ph.pHfilt },
  { id: 'pctb', label: '%B', channel: 'pctB_column_inlet', unit: '%', axis: 'R2B', dec: 1,
    colorVar: '--ch-pctb', dash: [], width: 1.5, visible: true, fill: 0.1, sensor: null,
    glossary: 'PCTB', live: (c, r) => r.pctB_colInlet },
  { id: 'press', label: 'P1', channel: 'P1_bar', unit: 'bar', axis: 'R3', dec: 3,
    colorVar: '--ch-press', dash: [3, 3], width: 1.5, visible: false, sensor: 'PRESS',
    glossary: 'P1', live: (c, r) => r.press.P1disp_bar },
  { id: 'flow', label: 'Flow', channel: 'flow_mL_min', unit: 'mL/min', axis: 'R3', dec: 1,
    colorVar: '--ch-flow', dash: [8, 2, 2, 2], width: 1.5, visible: false, sensor: null,
    glossary: 'FLOW', live: (c, r) => 60 * r.Q_actual_mLs },
]);

/**
 * The permanent numeric homes of the tag readout grid. Between this table and `CHANNELS`, every
 * §5.2 sensor signal is on screen without any hover.
 * `read` returns a preformatted string including its unit; `sensor` selects the quality badge.
 */
const TAGS = Object.freeze([
  { key: 'flow', label: 'FT-101 FLOW', glossary: 'FLOW', sensor: null,
    read: (c, r) => fmt.fmtFlow(r.Q_actual_mLs, c) },
  { key: 'flowsp', label: 'FLOW SP', glossary: 'FLOW', sensor: null,
    read: (c, r) => fmt.fmtFlow(r.Q_set_mLs, c) },
  { key: 'p1', label: 'PT-101 P1', glossary: 'P1', sensor: 'PRESS',
    read: (c, r) => fmt.fmtPressure(r.press.P1disp_bar) },
  { key: 'p2', label: 'PT-102 P2', glossary: 'P2', sensor: 'PRESS',
    read: (c, r) => fmt.fmtPressure(r.press.P2disp_bar) },
  { key: 'dp', label: 'PDT-101 dP', glossary: 'DP', sensor: 'PRESS',
    read: (c, r) => fmt.fmtPressure(r.dP_bar) },
  { key: 'uv280', label: 'UV-101 A280', glossary: 'UV_280', sensor: 'UV',
    read: (c, r) => nfix(1000 * r.uv.Afilt[0], 1) + ' mAU' },
  { key: 'uv260', label: 'UV-101 A260', glossary: 'UV_260', sensor: 'UV',
    read: (c, r) => nfix(1000 * r.uv.Afilt[1], 1) + ' mAU' },
  { key: 'uv300', label: 'UV-101 A300', glossary: 'UV_300', sensor: 'UV',
    read: (c, r) => nfix(1000 * r.uv.Afilt[2], 1) + ' mAU' },
  { key: 'uvratio', label: '260/280', glossary: 'UV_RATIO_260_280', sensor: 'UV',
    read: (c, r) => nfix(sensors.sensorSignal(c, r, 'UV_RATIO_260_280'), 3) },
  { key: 'cond', label: 'CE-101 COND', glossary: 'COND', sensor: 'COND',
    read: (c, r) => fmt.fmtCond(r.cond.kappaDisp_mScm) },
  { key: 'condraw', label: 'COND RAW', glossary: 'COND_RAW', sensor: 'COND',
    read: (c, r) => fmt.fmtCond(r.cond.kappaFilt_mScm) },
  { key: 'ph', label: 'AE-101 pH', glossary: 'PH', sensor: 'PH',
    read: (c, r) => fmt.fmtPH(r.ph.pHfilt) },
  { key: 'tfluid', label: 'TT-101 T FLUID', glossary: 'TEMP_FLUID', sensor: null,
    read: (c, r) => nfix(r.T_fluid_C, 1) + ' °C' },
  { key: 'tcell', label: 'T CELL', glossary: 'TEMP_CELL', sensor: 'COND',
    read: (c, r) => nfix(r.T_cell_C, 1) + ' °C' },
  { key: 'pctbsp', label: '%B SP', glossary: 'PCTB', sensor: null,
    read: (c, r) => fmt.fmtPct(r.pctB_set) },
  { key: 'pctbcol', label: '%B COL INLET', glossary: 'PCTB', sensor: null,
    read: (c, r) => fmt.fmtPct(r.pctB_colInlet) },
  { key: 'air', label: 'AIR FRAC', glossary: 'AIR', sensor: null,
    read: (c, r) => nfix(100 * r.fAirDet, 2) + ' %' },
  { key: 'vtot', label: 'V TOTAL', glossary: 'holdup-volume', sensor: null,
    read: (c, r) => fmt.fmtVolume(r.V_tot_mL, c) },
  { key: 'vrun', label: 'V RUN', glossary: 'holdup-volume', sensor: null,
    read: (c, r) => fmt.fmtVolume(r.V_run_mL, c) },
  { key: 'vblock', label: 'V BLOCK', glossary: 'block.duration', sensor: null,
    read: (c, r) => fmt.fmtVolume(r.V_block_mL, c) },
  { key: 'cvtot', label: 'CV TOTAL', glossary: 'CV', sensor: null,
    read: (c, r) => fmt.fmtCV(r.V_tot_mL, c) },
  { key: 'tblock', label: 'T BLOCK', glossary: 'block.duration', sensor: null,
    read: (c, r) => fmt.fmtTime(r.blockElapsed_s) },
  { key: 'trun', label: 'T RUN', glossary: 'run-state', sensor: null,
    read: (c, r) => fmt.fmtTime(r.t_s) },
  { key: 'load', label: 'LOAD PROGRESS', glossary: 'load-challenge', sensor: null,
    read: (c, r) => fmt.fmtPct(sensors.sensorSignal(c, r, 'LOAD_PROGRESS_PCT')) },
  { key: 'waste', label: 'WASTE', glossary: 'skid.wasteCapacity_mL', sensor: null,
    read: (c, r) => fmt.fmtVolume(r.wasteVolume_mL, c) },
  { key: 'speed', label: 'EFFECTIVE SPEED', glossary: 'speed-deficit', sensor: null,
    read: (c, r) => effectiveSpeedText(r) },
]);

/** Severity rank, worst first, for sorting the active-alarm list. */
const SEV_RANK = Object.freeze({ FAULT: 5, CRITICAL: 4, ALARM: 3, WARN: 2, INFO: 1 });

/** Short severity captions for the alarm list pills. */
const SEV_SHORT = Object.freeze({
  FAULT: 'FAULT', CRITICAL: 'CRIT', ALARM: 'ALARM', WARN: 'WARN', INFO: 'INFO',
});

/** Block-type → phase band tint class (§9.3.3) and rail class. */
const BLOCK_KIND = Object.freeze({
  EQUILIBRATION: 'equil', RE_EQUILIBRATION: 'equil', LOAD: 'load', WASH: 'wash',
  ELUTION_ISOCRATIC: 'elute', ELUTION_LINEAR: 'elute', ELUTION_STEP: 'elute',
  STRIP: 'strip', CIP: 'strip', HOLD: 'hold', COLUMN_BYPASS: 'bypass', PACKING_TEST: 'test',
});

/** Event types that earn an axis chevron (§9.3.3). */
const MARKER_EVENTS = Object.freeze({
  RUN_START: 'run start', ALARM_RAISED: 'alarm', WATCH_FIRED: 'watch',
  OPERATOR_ACTION: 'operator', AUTOZERO: 'autozero', PEAK_MAX: 'peak max',
  AIR_DETECTED: 'air', FLOW_REDUCTION_START: 'flow reduced', STATE_CHANGE: 'state',
});

/** Quality-flag bits worth a chip in the panel header, worst first. */
const QF_CHIPS = Object.freeze([
  ['BED COLLAPSED', QF.BED_COLLAPSED], ['UV SAT', QF.UV_SATURATED],
  ['LAMP FAULT', QF.UV_LAMP_FAULT], ['COND DRY', QF.COND_DRY], ['pH FROZEN', QF.PH_FROZEN_AIR],
  ['AIR', QF.AIR_IN_PATH], ['BYPASSED', QF.DETECTORS_BYPASSED], ['UV OVER', QF.UV_OVERRANGE],
  ['FLOW RED', QF.FLOW_REDUCED], ['MANUAL', QF.MANUAL_OVERRIDE], ['SPEED LIM', QF.SPEED_LIMITED],
  ['pH DEGRADED', QF.PH_ELECTRODE_DEGRADED], ['PRESS SUSPECT', QF.PRESS_SUSPECT],
]);

/** Readout refresh period, ms. 10 Hz is the HMI convention and matches the control tick. */
const READOUT_MS = 100;

/** Splitter snap points, px, for the fraction strip and the bottom readout panel. */
const SNAP_FRAC = Object.freeze([104, 150, 232]);
const SNAP_BOTTOM = Object.freeze([132, 196, 264]);

/* ============================================================================================ */
/* 2. SMALL HELPERS                                                                             */
/* ============================================================================================ */

/**
 * Shorthand over `format.h` for the common "tag + class + text" case, which is most of this file.
 *
 * @param {string} tag Tag name.
 * @param {string} [className] Space-separated class list, or '' for none.
 * @param {string} [text] Text content.
 * @returns {HTMLElement} The new element, not yet attached.
 */
function mk(tag, className, text) {
  return fmt.h(tag, className ? { class: className } : null,
    (text === undefined || text === null) ? null : text);
}

/**
 * Fixed-decimal formatting through the display boundary, so a readout never changes width and
 * never shows `NaN` (§9.4.2).
 *
 * @param {number} v Value.
 * @param {number} d Decimal places.
 * @returns {string} Formatted value, or `format.NO_VALUE`.
 */
function nfix(v, d) {
  return fmt.fmtFixed(v, d);
}

/**
 * The honest effective-speed string of §9.4.3: `run.speed / run.speedDeficit`, annotated when the
 * machine cannot keep up.
 *
 * @param {object} run The run state.
 * @returns {string} e.g. '60x' or '1000x (limited to 450x)'.
 */
function effectiveSpeedText(run) {
  const s = run.speed;
  const d = run.speedDeficit > 1 ? run.speedDeficit : 1;
  if (d <= 1.01) return nfix(s, 0) + '×';
  return nfix(s, 0) + '× (limited to ' + nfix(s / d, 0) + '×)';
}

/**
 * Clamp helper, local so this module keeps its import surface to the six declared dependencies
 * plus the log and glossary leaves.
 *
 * @param {number} x Value.
 * @param {number} lo Lower bound.
 * @param {number} hi Upper bound.
 * @returns {number} `x` clamped into `[lo, hi]`.
 */
function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * Resolve the overlay host: the one `ui/app.js` built if it published it on `ctx`, otherwise a
 * lazily created singleton on `document.body`. Cached per document so two views never build two.
 *
 * @param {object} ctx The §2.4 context.
 * @returns {object} An OverlayHost as returned by `overlay.createOverlayHost`.
 */
let sharedOverlayHost = null;
function overlayHostFor(ctx) {
  if (ctx && ctx.overlayHost) return ctx.overlayHost;
  if (ctx && ctx.overlay) return ctx.overlay;
  if (!sharedOverlayHost) sharedOverlayHost = overlaylib.createOverlayHost(document.body);
  return sharedOverlayHost;
}

/**
 * Invoke a `core/sim.js` action through `ctx.sim` when the shell published it, falling back to the
 * module import. Both are the same module; the fallback only guards a partially built `ctx`.
 *
 * @param {object} ctx The §2.4 context.
 * @param {string} name The action name, e.g. `'markFraction'`.
 * @param {...any} args Extra arguments after `ctx`.
 * @returns {{ok:boolean, reason?:string}} The action's result.
 */
function callSim(ctx, name, ...args) {
  const bag = (ctx && ctx.sim && typeof ctx.sim[name] === 'function') ? ctx.sim : simlib;
  const fn = bag[name];
  if (typeof fn !== 'function') return { ok: false, reason: 'action ' + name + ' is unavailable' };
  return fn(ctx, ...args);
}

/* ============================================================================================ */
/* 3. SCOPED STYLESHEET                                                                         */
/* ============================================================================================ */

const STYLE_ID = 'rv-run-view-styles';

/** The run view's own rules. Every colour is a token from `styles/tokens.css`. */
const STYLE_TEXT = [
  '.rv{display:grid;grid-template-columns:minmax(380px,30%) 1fr;gap:12px;height:100%;',
  'min-height:0;min-width:0;color:var(--text-1);font-family:var(--font-ui);font-size:12px}',
  '.rv,.rv *{box-sizing:border-box}',
  '.rv-col{display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0}',
  '.rv-panel{background:var(--surface-1);border:1px solid var(--line);border-radius:var(--r-3);',
  'display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;position:relative}',
  '.rv-hd{flex:0 0 32px;height:32px;display:flex;align-items:center;gap:8px;padding:0 12px;',
  'border-bottom:1px solid var(--line-soft);font-size:var(--fs-10,10px);letter-spacing:.06em;',
  'text-transform:uppercase;color:var(--text-3);user-select:none}',
  '.rv-hd-t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.rv-hd-sp{flex:1 1 auto}',
  '.rv-body{flex:1 1 auto;min-height:0;min-width:0;position:relative;overflow:hidden}',
  '.rv-num{font-family:var(--font-num);font-variant-numeric:tabular-nums lining-nums}',
  '.rv button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}',
  '.rv :focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}',
  /* generic chips + pills */
  '.rv-chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:',
  'var(--r-pill,999px);font-size:var(--fs-9,9px);font-weight:700;letter-spacing:.06em;',
  'border:1px solid transparent;white-space:nowrap}',
  '.rv-chip.ok{background:var(--ok-soft);color:var(--ok);border-color:var(--ok)}',
  '.rv-chip.warn{background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}',
  '.rv-chip.alarm{background:var(--alarm-soft);color:var(--alarm);border-color:var(--alarm)}',
  '.rv-chip.info{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}',
  '.rv-chip.mut{background:var(--surface-3);color:var(--text-3);border-color:var(--line)}',
  /* P&ID panel */
  // The P&ID is the one panel in the left column that must claim the leftover height. .rv-panel
  // does not declare `flex`, so it inherits `0 1 auto` and every panel sits at its content
  // height — which for this one is just the 32px header, clipping the schematic to nothing while
  // the rest of the column sat empty. `1 1 0` makes it the flexible sibling; the fraction strip
  // below keeps its natural height. The floor stops it collapsing again on a short viewport.
  '.rv-pid{flex:1 1 0;min-height:260px}',
  '.rv-pid .rv-body{padding:6px}',
  '.rv-pid.is-manual{box-shadow:inset 0 0 0 3px var(--warn)}',
  '.rv-pid-host{position:absolute;inset:6px;min-height:0}',
  /* alarms */
  '.rv-alarms{flex:0 0 auto;max-height:132px}',
  '.rv-alarms[hidden]{display:none}',
  '.rv-alm-list{list-style:none;margin:0;padding:0;overflow-y:auto;max-height:100px}',
  '.rv-alm{display:flex;align-items:center;gap:8px;height:26px;padding:0 10px;',
  'border-bottom:1px solid var(--line-soft);font-size:11px}',
  '.rv-alm:last-child{border-bottom:0}',
  '.rv-alm-id{font-family:var(--font-num);color:var(--text-2);flex:0 0 auto}',
  '.rv-alm-nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.rv-alm.is-latched .rv-alm-nm{color:var(--text-2)}',
  '.rv-ack{flex:0 0 auto;height:20px;padding:0 8px;border:1px solid var(--line-strong);',
  'border-radius:var(--r-2);font-size:10px;font-weight:600;color:var(--text-1);',
  'background:var(--surface-2)}',
  '.rv-ack:hover{background:var(--surface-3)}',
  '.rv-ack[hidden]{display:none}',
  /* tag readout grid */
  // Column COUNT was fixed (4, or 5 when wide), so at a narrow panel each cell fell to ~111px.
  // .rv-tag-v is `flex:0 0 auto` + nowrap and so refuses to shrink; a wide value such as
  // "60000.0 mL" then overflowed a cell that had no overflow guard and painted across its
  // neighbour, which is what made the tag block unreadable. Size by MINIMUM WIDTH instead so the
  // count adapts to the panel, and clip at the cell as a backstop.
  '.rv-tags{display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));gap:1px;',
  'background:var(--line-soft);overflow-y:auto;height:100%;align-content:start}',
  '.rv-tag{display:flex;align-items:center;gap:6px;height:22px;padding:0 8px;overflow:hidden;',
  'background:var(--surface-1);text-align:left;width:100%;min-width:0}',
  '.rv-tag-l{flex:1 1 auto;font-size:var(--fs-9,9px);letter-spacing:.06em;color:var(--text-3);',
  'text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.rv-tag-v{flex:0 0 auto;font-family:var(--font-num);font-variant-numeric:tabular-nums ',
  'lining-nums;font-size:12px;font-weight:600;color:var(--text-1);white-space:nowrap}',
  '.rv-tag[data-q="SUSPECT"] .rv-tag-v{color:var(--warn)}',
  '.rv-tag[data-q="INVALID"] .rv-tag-v{color:var(--alarm)}',
  '.rv-tag[data-q="BYPASSED"] .rv-tag-v{color:var(--text-3)}',
  '.rv-tag.is-low .rv-tag-v{color:var(--warn)}',
  '.rv-tag.has-info:hover{background:var(--surface-2)}',
  /* fraction strip */
  '.rv-frac-body{display:flex;flex-direction:column;gap:6px;padding:8px 10px;height:100%}',
  '.rv-frac-rail{position:relative;flex:1 1 auto;min-height:0}',
  '.rv-vials{list-style:none;margin:0;padding:0;display:flex;gap:4px;height:100%;align-items:',
  'stretch}',
  '.rv-vials li{flex:1 1 0;min-width:0;display:flex}',
  '.rv-vial{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%;',
  'padding-top:10px;border-radius:var(--r-1)}',
  '.rv-vial-b{position:relative;flex:1 1 auto;width:100%;min-height:14px;background:',
  'var(--surface-2);border:1px solid var(--line);border-radius:0 0 var(--r-2) var(--r-2);',
  'overflow:hidden}',
  '.rv-vial-f{position:absolute;left:0;right:0;bottom:0;height:0;background:var(--accent);',
  'opacity:.55}',
  '.rv-vial-id{font-size:var(--fs-9,9px);font-family:var(--font-num);color:var(--text-3);',
  'white-space:nowrap;overflow:hidden}',
  '.rv-vial.has-rec .rv-vial-b{border-color:var(--line-strong)}',
  '.rv-vial.has-peak .rv-vial-b{border-color:var(--accent)}',
  '.rv-vial.is-open .rv-vial-b{border-color:var(--ok);box-shadow:inset 0 0 0 1px var(--ok)}',
  '.rv-vial.is-sel .rv-vial-b{background:var(--accent-soft);border-color:var(--accent)}',
  '.rv-vial.is-sel .rv-vial-id{color:var(--accent)}',
  '.rv-vial.is-waste .rv-vial-b{border-radius:var(--r-2);background:var(--surface-3)}',
  '.rv-head{position:absolute;top:0;width:14px;height:10px;margin-left:-7px;',
  'transition:left var(--dur-3) var(--ease-out);pointer-events:none}',
  '.rv-head::after{content:"";display:block;width:0;height:0;margin:0 auto;',
  'border-left:6px solid transparent;border-right:6px solid transparent;',
  'border-top:8px solid var(--accent)}',
  '.rv-frac-ft{flex:0 0 16px;display:flex;align-items:center;gap:10px;font-size:10px;',
  'color:var(--text-3)}',
  '.rv-mini{height:22px;padding:0 8px;border:1px solid var(--line-strong);',
  'border-radius:var(--r-2);background:var(--surface-2);font-size:10px;font-weight:600;',
  'color:var(--text-1)}',
  '.rv-mini:hover{background:var(--surface-3)}',
  '.rv-mini[disabled]{opacity:.45;cursor:not-allowed}',
  /* phase rail */
  '.rv-rail{flex:0 0 var(--rv-rail-h,64px);height:var(--rv-rail-h,64px)}',
  '.rv-rail .rv-body{display:flex;flex-direction:column;padding:6px 10px;gap:4px}',
  '.rv-rail-hd{flex:0 0 14px;display:flex;align-items:center;gap:10px;font-size:10px;',
  'color:var(--text-3);letter-spacing:.04em}',
  '.rv-blocks{list-style:none;margin:0;padding:0;display:flex;gap:2px;flex:1 1 auto;min-height:0}',
  '.rv-blocks li{min-width:6px;display:flex}',
  '.rv-blk{position:relative;width:100%;height:100%;border-radius:var(--r-1);overflow:hidden;',
  'background:var(--surface-2);border:1px solid var(--line);padding:0 6px;text-align:left;',
  'display:flex;align-items:center}',
  '.rv-blk-f{position:absolute;left:0;top:0;bottom:0;width:100%;transform:scaleX(0);',
  'transform-origin:left center;background:var(--accent-soft)}',
  '.rv-blk-t{position:relative;font-size:var(--fs-9,9px);letter-spacing:.04em;',
  'text-transform:uppercase;color:var(--text-2);white-space:nowrap;overflow:hidden;',
  'text-overflow:ellipsis;pointer-events:none}',
  '.rv-blk[data-kind="load"]{background:color-mix(in srgb,var(--warn) 10%,var(--surface-2))}',
  '.rv-blk[data-kind="wash"]{background:color-mix(in srgb,var(--info) 8%,var(--surface-2))}',
  '.rv-blk[data-kind="elute"]{background:color-mix(in srgb,var(--ch-uv260) 10%,var(--surface-2))}',
  '.rv-blk[data-kind="strip"]{background:color-mix(in srgb,var(--ok) 9%,var(--surface-2))}',
  '.rv-blk.is-done .rv-blk-t{color:var(--text-3)}',
  '.rv-blk.is-cur{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}',
  '.rv-blk.is-cur .rv-blk-t{color:var(--text-1);font-weight:700}',
  '.rv-blk.is-off{opacity:.4}',
  /* chart */
  '.rv-chart{flex:1 1 auto;min-height:320px}',
  '.rv-chart-host{position:absolute;inset:0}',
  '.rv-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
  'text-align:center;color:var(--text-3);font-size:13px;pointer-events:none;padding:24px}',
  '.rv-empty[hidden]{display:none}',
  '.rv-live{position:absolute;right:12px;top:8px;height:22px;padding:0 10px;border-radius:',
  'var(--r-pill,999px);background:var(--accent);color:var(--text-inv);font-size:10px;',
  'font-weight:700;letter-spacing:.06em}',
  '.rv-live[hidden]{display:none}',
  /* segmented control */
  '.rv-seg{display:inline-flex;height:22px;border:1px solid var(--line-strong);',
  'border-radius:var(--r-2);overflow:hidden}',
  '.rv-seg button{padding:0 8px;font-size:10px;font-weight:600;letter-spacing:.04em;',
  'color:var(--text-2);background:var(--surface-2);border-right:1px solid var(--line)}',
  '.rv-seg button:last-child{border-right:0}',
  '.rv-seg button[aria-checked="true"]{background:var(--accent);color:var(--text-inv)}',
  /* bottom readout panel */
  '.rv-bottom{flex:0 0 var(--rv-bottom-h,132px);height:var(--rv-bottom-h,132px)}',
  '.rv-bottom .rv-body{display:flex;gap:1px;background:var(--line-soft)}',
  '.rv-legend-wrap{flex:1.3 1 0;min-width:0;overflow:auto;background:var(--surface-1)}',
  '.rv-tags-wrap{flex:1 1 0;min-width:0;overflow:auto;background:var(--surface-1)}',
  '.rv-lg{width:100%;border-collapse:collapse;font-size:11px}',
  '.rv-lg th{position:sticky;top:0;z-index:1;background:var(--surface-2);color:var(--text-3);',
  'font-size:var(--fs-9,9px);letter-spacing:.06em;text-transform:uppercase;font-weight:600;',
  'height:18px;padding:0 6px;text-align:right;border-bottom:1px solid var(--line)}',
  '.rv-lg th.l,.rv-lg td.l{text-align:left}',
  '.rv-lg td{height:20px;padding:0 6px;text-align:right;border-bottom:1px solid var(--line-soft);',
  'font-family:var(--font-num);font-variant-numeric:tabular-nums lining-nums;color:var(--text-1)}',
  '.rv-lg td.l{font-family:var(--font-ui)}',
  '.rv-lg tr.is-off td{color:var(--text-3)}',
  '.rv-lg tr.is-focus{background:var(--accent-soft)}',
  '.rv-lg tr:hover{background:var(--surface-2)}',
  '.rv-sw{display:block;width:28px;height:12px}',
  '.rv-axis{height:16px;min-width:28px;padding:0 4px;border:1px solid var(--line);',
  'border-radius:var(--r-1);background:var(--surface-2);font-size:9px;font-weight:700;',
  'color:var(--text-2);font-family:var(--font-num)}',
  '.rv-lg-q{font-size:9px;font-weight:700}',
  '.rv-lg-q[data-q="OK"]{color:var(--text-3)}',
  '.rv-lg-q[data-q="SUSPECT"]{color:var(--warn)}',
  '.rv-lg-q[data-q="INVALID"]{color:var(--alarm)}',
  '.rv-lg-q[data-q="BYPASSED"]{color:var(--text-3)}',
  /* splitters */
  '.rv-sp{flex:0 0 6px;height:6px;margin:-3px 0;position:relative;cursor:row-resize;z-index:2}',
  '.rv-sp::after{content:"";position:absolute;left:24px;right:24px;top:2px;height:1px;',
  'background:var(--line)}',
  '.rv-sp:hover::after,.rv-sp:focus-visible::after{background:var(--accent);height:2px}',
  /* responsive (§9.1.3) */
  '.rv.is-mid .rv-lg .opt{display:none}',
  '.rv.is-narrow{grid-template-columns:1fr;grid-auto-rows:minmax(0,auto);overflow-y:auto}',
  '.rv.is-narrow .rv-col{min-height:0}',
  '.rv.is-narrow .rv-chart{min-height:280px}',
  '.rv.is-narrow .rv-tags{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}',
  '.rv.is-narrow .rv-bottom .rv-body{flex-direction:column}',
  '.rv.is-short{--rv-rail-h:28px}',
  '.rv.is-short .rv-rail-hd{display:none}',
  '.rv.is-short .rv-blk-t{display:none}',
  '.rv.is-mid .rv-blk-t{display:none}',
  '.rv.is-wide .rv-tags{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}',
  '.rv-note{padding:6px 12px;font-size:11px;color:var(--text-3)}',
  '.rv-note[hidden]{display:none}',
  '.rv-pop-h{font-weight:700;margin-bottom:2px}',
  '@media (prefers-reduced-motion: reduce){.rv-head{transition:none}}',
  '.rv.is-reduced .rv-head{transition:none}',
].join('');

/**
 * Inject the run view's scoped stylesheet once per document.
 * @returns {void}
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE_TEXT;
  document.head.appendChild(s);
}

/* ============================================================================================ */
/* 4. THE VIEW                                                                                  */
/* ============================================================================================ */

/**
 * Build the Run tab.
 *
 * Composition, left to right: the P&ID panel and the active-alarm list and the fraction strip in
 * the left column; the phase progress rail, the chromatogram and the legend / tag readout in the
 * right column — the two-column `minmax(380px, 30%) / 1fr` grid of §9.1.2.
 *
 * The returned panel obeys the §6.24 contract exactly: `update(frameInfo)` is called at most once
 * per rAF frame by `ui/app.js`, never starts a rAF loop of its own, never calls `sim.advanceWall`,
 * never mutates `config` or `run`, and does no layout reads — every size it needs is cached from a
 * `ResizeObserver`.
 *
 * @param {Element} rootEl The element the view mounts into.
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx
 *   The one §2.4 context shape.
 * @returns {{el:Element, mount:function():void, update:function(object):void,
 *            destroy:function():void}} The panel.
 */
export function createRunView(rootEl, ctx) {
  injectStyles();

  /* ---- mutable view state (never simulation state) ---------------------------------------- */
  let mounted = false;
  let pid = null;
  let chart = null;
  let boundStore = null;
  let xMode = (ctx.config && ctx.config.ui && ctx.config.ui.xMode) || 'volume';
  let follow = true;
  let cursorX = NaN;
  let focusChannel = null;
  let lastReadout = -1e9;
  let evCursor = 0;
  let annotationsDirty = true;
  let cachedW = 0;
  let cachedH = 0;
  let pendingStructural = true;
  let tokens = {};
  let reduced = false;

  /** Per-channel running min/max over the whole run, scanned incrementally from the log. */
  const stat = CHANNELS.map(() => ({ min: Infinity, max: -Infinity }));
  let statRow = 0;

  /** Chart annotation buffers, rebuilt only when the event log or the x mode changes. */
  let bands = [];
  let markers = [];
  const openBands = [];
  let lastBandExtend = -1e9;

  /** The last window this view asked the chart for, used when the chart publishes none. */
  const viewWindow = { x0: NaN, x1: NaN };

  /** Fraction selection: a contiguous port-index range, or null. */
  let selFrom = -1;
  let selTo = -1;

  /** Cached node references — no `innerHTML` and no query after mount (§6.24). */
  const nodes = {
    railBlocks: [], railFills: [],
    vials: [], vialFills: [],
    tagEls: [], tagVals: [],
    lgRows: [], lgVal: [], lgMin: [], lgMax: [], lgCur: [], lgAxis: [], lgVis: [], lgQ: [],
    lgSw: [], lgName: [], tankTags: [],
  };

  let railSig = '';
  let alarmSig = '';
  let vialSig = '';
  let tagSig = '';

  const host = overlayHostFor(ctx);
  const openHandles = [];

  /* ---- DOM ------------------------------------------------------------------------------- */
  const el = mk('div', 'rv');
  el.setAttribute('data-view', 'run');

  const colL = mk('div', 'rv-col rv-col-l');
  const colR = mk('div', 'rv-col rv-col-r');
  el.appendChild(colL);
  el.appendChild(colR);

  /* -- P&ID panel -- */
  const pidPanel = mk('section', 'rv-panel rv-pid');
  const pidHd = mk('div', 'rv-hd');
  const pidTitle = mk('span', 'rv-hd-t', 'Process schematic');
  const pidSpacer = mk('span', 'rv-hd-sp');
  const pidState = mk('span', 'rv-chip mut rv-num', 'IDLE');
  const pidManual = mk('span', 'rv-chip warn', 'MANUAL');
  pidManual.hidden = true;
  const qfWrap = mk('span', 'rv-hd-qf');
  qfWrap.style.display = 'inline-flex';
  qfWrap.style.gap = '4px';
  pidHd.appendChild(pidTitle);
  pidHd.appendChild(pidSpacer);
  pidHd.appendChild(qfWrap);
  pidHd.appendChild(pidManual);
  pidHd.appendChild(pidState);
  const pidBody = mk('div', 'rv-body');
  const pidHost = mk('div', 'rv-pid-host');
  pidBody.appendChild(pidHost);
  pidPanel.appendChild(pidHd);
  pidPanel.appendChild(pidBody);
  colL.appendChild(pidPanel);

  const qfChipEls = QF_CHIPS.map(([label]) => {
    const c = mk('span', 'rv-chip warn', label);
    c.hidden = true;
    qfWrap.appendChild(c);
    return c;
  });

  /* -- active-alarm list -- */
  const almPanel = mk('section', 'rv-panel rv-alarms');
  almPanel.hidden = true;
  almPanel.setAttribute('role', 'region');
  almPanel.setAttribute('aria-label', 'Active alarms');
  const almHd = mk('div', 'rv-hd');
  const almTitle = mk('span', 'rv-hd-t', 'Active alarms');
  const almCount = mk('span', 'rv-chip alarm rv-num', '0');
  almHd.appendChild(almTitle);
  almHd.appendChild(mk('span', 'rv-hd-sp'));
  almHd.appendChild(almCount);
  const almList = mk('ul', 'rv-alm-list');
  almList.setAttribute('aria-live', 'polite');
  almPanel.appendChild(almHd);
  almPanel.appendChild(almList);
  colL.appendChild(almPanel);

  /* -- splitter (left) -- */
  const spL = mk('div', 'rv-sp');
  colL.appendChild(spL);

  /* -- fraction strip -- */
  const fracPanel = mk('section', 'rv-panel rv-frac');
  fracPanel.style.flex = '0 0 var(--rv-frac-h,150px)';
  fracPanel.style.height = 'var(--rv-frac-h,150px)';
  const fracHd = mk('div', 'rv-hd');
  const fracTitle = mk('span', 'rv-hd-t', 'Fractions');
  const fracMode = mk('span', 'rv-chip mut', 'OFF');
  const fracMark = mk('button', 'rv-mini', 'Mark');
  fracMark.type = 'button';
  fracMark.title = 'Mark a fraction now (keyboard: M)';
  const fracClear = mk('button', 'rv-mini', 'Clear');
  fracClear.type = 'button';
  fracClear.title = 'Clear the pool selection';
  fracHd.appendChild(fracTitle);
  fracHd.appendChild(mk('span', 'rv-hd-sp'));
  fracHd.appendChild(fracMode);
  fracHd.appendChild(fracMark);
  fracHd.appendChild(fracClear);
  const fracBody = mk('div', 'rv-body');
  const fracInner = mk('div', 'rv-frac-body');
  const fracRail = mk('div', 'rv-frac-rail');
  const vialList = mk('ul', 'rv-vials');
  vialList.setAttribute('role', 'listbox');
  vialList.setAttribute('aria-label', 'Fraction collector positions');
  const collectorHead = mk('div', 'rv-head');
  fracRail.appendChild(vialList);
  fracRail.appendChild(collectorHead);
  const fracFoot = mk('div', 'rv-frac-ft');
  const fracSel = mk('span', 'rv-num', 'No pool selection');
  const fracPort = mk('span', 'rv-num', '');
  fracFoot.appendChild(fracSel);
  fracFoot.appendChild(mk('span', 'rv-hd-sp'));
  fracFoot.appendChild(fracPort);
  fracInner.appendChild(fracRail);
  fracInner.appendChild(fracFoot);
  fracBody.appendChild(fracInner);
  fracPanel.appendChild(fracHd);
  fracPanel.appendChild(fracBody);
  colL.appendChild(fracPanel);

  /* -- phase rail -- */
  const railPanel = mk('section', 'rv-panel rv-rail');
  const railBody = mk('div', 'rv-body');
  const railHd = mk('div', 'rv-rail-hd');
  const railBlockName = mk('span', 'rv-num', '—');
  const railProg = mk('span', 'rv-num', '');
  const railRemain = mk('span', 'rv-num', '');
  railHd.appendChild(railBlockName);
  railHd.appendChild(mk('span', 'rv-hd-sp'));
  railHd.appendChild(railProg);
  railHd.appendChild(railRemain);
  const railList = mk('ol', 'rv-blocks');
  railList.setAttribute('aria-label', 'Method blocks, widths proportional to volume');
  railBody.appendChild(railHd);
  railBody.appendChild(railList);
  railPanel.appendChild(railBody);
  colR.appendChild(railPanel);

  /* -- chromatogram -- */
  const chartPanel = mk('section', 'rv-panel rv-chart');
  const chartHd = mk('div', 'rv-hd');
  const chartTitle = mk('span', 'rv-hd-t', 'Chromatogram');
  const xSeg = mk('div', 'rv-seg');
  xSeg.setAttribute('role', 'radiogroup');
  xSeg.setAttribute('aria-label', 'X axis mode');
  const xBtns = X_MODES.map((m) => {
    const b = mk('button', '', m.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', m.mode === xMode ? 'true' : 'false');
    b.title = 'X axis in ' + m.label.toLowerCase() + ' (' + m.unit + ')';
    b.dataset.mode = m.mode;
    xSeg.appendChild(b);
    return b;
  });
  const fitBtn = mk('button', 'rv-mini', 'Fit');
  fitBtn.type = 'button';
  fitBtn.title = 'Fit the whole run (keyboard: A)';
  const followBtn = mk('button', 'rv-mini', 'Follow');
  followBtn.type = 'button';
  followBtn.setAttribute('aria-pressed', 'true');
  followBtn.title = 'Keep the live edge in view (keyboard: F)';
  chartHd.appendChild(chartTitle);
  chartHd.appendChild(mk('span', 'rv-hd-sp'));
  chartHd.appendChild(xSeg);
  chartHd.appendChild(fitBtn);
  chartHd.appendChild(followBtn);
  const chartBody = mk('div', 'rv-body');
  const chartHost = mk('div', 'rv-chart-host');
  const chartEmpty = mk('div', 'rv-empty',
    'No run yet. Load a scenario or press Start — the trace, the bed and the fractions all '
    + 'move together.');
  const livePill = mk('button', 'rv-live', 'Jump to live');
  livePill.type = 'button';
  livePill.hidden = true;
  chartBody.appendChild(chartHost);
  chartBody.appendChild(chartEmpty);
  chartBody.appendChild(livePill);
  chartPanel.appendChild(chartHd);
  chartPanel.appendChild(chartBody);
  colR.appendChild(chartPanel);

  /* -- splitter (right) -- */
  const spR = mk('div', 'rv-sp');
  colR.appendChild(spR);

  /* -- legend + tag readouts -- */
  const bottomPanel = mk('section', 'rv-panel rv-bottom');
  const bottomBody = mk('div', 'rv-body');
  const legendWrap = mk('div', 'rv-legend-wrap');
  const tagsWrap = mk('div', 'rv-tags-wrap');
  const lgTable = mk('table', 'rv-lg');
  lgTable.setAttribute('aria-label',
    'Chromatogram channels: live value, run minimum and maximum, value at the cursor, axis and '
    + 'visibility');
  const lgHead = mk('thead');
  const lgHeadRow = mk('tr');
  [['', ''], ['Channel', 'l'], ['Value', ''], ['Unit', 'l'], ['Min', 'opt'], ['Max', 'opt'],
    ['Cursor', 'opt'], ['Axis', ''], ['Q', ''], ['', '']].forEach(([t, c]) => {
    const th = mk('th', c, t);
    if (c === 'l') th.className = 'l';
    lgHeadRow.appendChild(th);
  });
  lgHead.appendChild(lgHeadRow);
  const lgBody = mk('tbody');
  lgTable.appendChild(lgHead);
  lgTable.appendChild(lgBody);
  legendWrap.appendChild(lgTable);
  const tagGrid = mk('div', 'rv-tags');
  tagsWrap.appendChild(tagGrid);
  bottomBody.appendChild(legendWrap);
  bottomBody.appendChild(tagsWrap);
  bottomPanel.appendChild(bottomBody);
  colR.appendChild(bottomPanel);

  el.style.setProperty('--rv-frac-h', SNAP_FRAC[1] + 'px');
  el.style.setProperty('--rv-bottom-h', SNAP_BOTTOM[0] + 'px');
  rootEl.appendChild(el);

  /* ========================================================================================== */
  /* 4.1 legend                                                                                 */
  /* ========================================================================================== */

  /**
   * Build the legend table once. Rows are static — only their cell text changes afterwards.
   * @returns {void}
   */
  function buildLegend() {
    lgBody.textContent = '';
    nodes.lgRows.length = 0; nodes.lgVal.length = 0; nodes.lgMin.length = 0;
    nodes.lgMax.length = 0; nodes.lgCur.length = 0; nodes.lgAxis.length = 0;
    nodes.lgVis.length = 0; nodes.lgQ.length = 0; nodes.lgSw.length = 0;
    nodes.lgName.length = 0;

    CHANNELS.forEach((ch, i) => {
      const tr = mk('tr');
      tr.dataset.ch = ch.id;

      const tdSw = mk('td', 'l');
      const cv = mk('canvas', 'rv-sw');
      cv.width = 28; cv.height = 12;
      cv.setAttribute('aria-hidden', 'true');
      tdSw.appendChild(cv);
      tr.appendChild(tdSw);

      const tdName = mk('td', 'l');
      const nameBtn = mk('button', '', ch.label);
      nameBtn.type = 'button';
      const g = glossaryFor(ch.glossary);
      if (g) {
        nameBtn.title = g.term + ' — click for detail';
        nameBtn.appendChild(mk('span', '', ' ⓘ'));
      } else {
        nameBtn.title = ch.label;
      }
      nameBtn.addEventListener('click', () => openGlossary(nameBtn, ch.glossary));
      tdName.appendChild(nameBtn);
      tr.appendChild(tdName);

      const tdVal = mk('td', '', '—');
      const tdUnit = mk('td', 'l', ch.unit || '–');
      const tdMin = mk('td', 'opt', '—');
      const tdMax = mk('td', 'opt', '—');
      const tdCur = mk('td', 'opt', '—');
      tr.appendChild(tdVal); tr.appendChild(tdUnit);
      tr.appendChild(tdMin); tr.appendChild(tdMax); tr.appendChild(tdCur);

      const tdAxis = mk('td');
      const axisBtn = mk('button', 'rv-axis', ch.axis);
      axisBtn.type = 'button';
      axisBtn.title = 'Axis ' + ch.axis + ' — click to reassign';
      axisBtn.addEventListener('click', () => cycleAxis(i));
      tdAxis.appendChild(axisBtn);
      tr.appendChild(tdAxis);

      const tdQ = mk('td');
      // `data-q` is deliberately left unset: `updateLegend` writes the badge only when the value
      // changes, so seeding it with 'OK' here would suppress the very first write.
      const qSpan = mk('span', 'rv-lg-q', '');
      tdQ.appendChild(qSpan);
      tr.appendChild(tdQ);

      const tdVis = mk('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ch.visible;
      cb.setAttribute('aria-label', 'Show ' + ch.label);
      cb.addEventListener('change', () => {
        chartlib.setSeriesVisible(chart, ch.id, cb.checked);
        chartlib.invalidate(chart, 'all');
        fmt.cls(tr, 'is-off', !cb.checked);
      });
      tdVis.appendChild(cb);
      tr.appendChild(tdVis);

      tr.addEventListener('pointerenter', () => setFocusChannel(ch.id));
      tr.addEventListener('pointerleave', () => setFocusChannel(null));
      nameBtn.addEventListener('focus', () => setFocusChannel(ch.id));
      nameBtn.addEventListener('blur', () => setFocusChannel(null));

      lgBody.appendChild(tr);
      nodes.lgRows.push(tr); nodes.lgVal.push(tdVal); nodes.lgMin.push(tdMin);
      nodes.lgMax.push(tdMax); nodes.lgCur.push(tdCur); nodes.lgAxis.push(axisBtn);
      nodes.lgVis.push(cb); nodes.lgQ.push(qSpan); nodes.lgSw.push(cv);
      nodes.lgName.push(nameBtn);
      fmt.cls(tr, 'is-off', !ch.visible);
      paintSwatch(cv, ch);
    });
  }

  /**
   * Draw a legend stroke sample: the channel's real colour, width and dash signature, never a
   * solid swatch (§9.3.1).
   *
   * @param {HTMLCanvasElement} cv The 28x12 swatch canvas.
   * @param {object} ch A `CHANNELS` entry.
   * @returns {void}
   */
  function paintSwatch(cv, ch) {
    const g = cv.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, cv.width, cv.height);
    const colour = (tokens && tokens[ch.colorVar]) || 'currentColor';
    if (ch.fill) {
      g.globalAlpha = ch.fill;
      g.fillStyle = colour;
      g.fillRect(0, 6, 28, 6);
      g.globalAlpha = 1;
    }
    g.strokeStyle = colour;
    g.lineWidth = ch.width;
    g.setLineDash(ch.dash && ch.dash.length ? ch.dash : []);
    g.beginPath();
    g.moveTo(1, 6);
    g.lineTo(27, 6);
    g.stroke();
    g.setLineDash([]);
  }

  /**
   * Legend hover focus (§9.6): ask the chart to dim every other trace. When the chart build in use
   * exposes no focus API, fall back to a solo view — the focused trace stays, the rest are hidden —
   * which keeps the pedagogic effect without pretending an alpha we cannot set.
   *
   * @param {string|null} id A channel id, or null to clear.
   * @returns {void}
   */
  function setFocusChannel(id) {
    if (focusChannel === id) return;
    focusChannel = id;
    for (let i = 0; i < CHANNELS.length; i++) {
      fmt.cls(nodes.lgRows[i], 'is-focus', CHANNELS[i].id === id);
    }
    if (!chart) return;
    if (typeof chartlib.setSeriesFocus === 'function') {
      chartlib.setSeriesFocus(chart, id);
    } else if (typeof chartlib.setSeriesAlpha === 'function') {
      for (let i = 0; i < CHANNELS.length; i++) {
        chartlib.setSeriesAlpha(chart, CHANNELS[i].id, (!id || CHANNELS[i].id === id) ? 1 : 0.2);
      }
    } else {
      for (let i = 0; i < CHANNELS.length; i++) {
        const on = nodes.lgVis[i].checked && (!id || CHANNELS[i].id === id);
        chartlib.setSeriesVisible(chart, CHANNELS[i].id, on);
      }
    }
    chartlib.invalidate(chart, 'all');
  }

  /**
   * Move a channel to the next y axis and rebuild the chart, preserving the window and follow
   * state. Axis assignment is a `createChart` option, so a rebuild is the honest way to change it.
   *
   * @param {number} i Index into `CHANNELS`.
   * @returns {void}
   */
  function cycleAxis(i) {
    const cur = nodes.lgAxis[i].textContent;
    const k = AXIS_CYCLE.indexOf(cur);
    const next = AXIS_CYCLE[(k + 1) % AXIS_CYCLE.length];
    fmt.setText(nodes.lgAxis[i], next);
    nodes.lgAxis[i].title = 'Axis ' + next + ' — click to reassign';
    rebuildChart();
  }

  /* ========================================================================================== */
  /* 4.2 tag readout grid                                                                       */
  /* ========================================================================================== */

  /**
   * Build the tag grid: one permanent numeric home per §5.2 signal, with `TANK_LEVEL:<id>`
   * expanded to one chip per configured tank.
   * @returns {void}
   */
  function buildTags() {
    const config = ctx.config;
    tagGrid.textContent = '';
    nodes.tagEls.length = 0; nodes.tagVals.length = 0; nodes.tankTags.length = 0;

    const add = (label, glossaryId, sensor) => {
      const g = glossaryFor(glossaryId);
      const node = mk(g ? 'button' : 'div', 'rv-tag' + (g ? ' has-info' : ''));
      if (g) {
        node.type = 'button';
        node.title = g.term + ' — click for detail';
        node.addEventListener('click', () => openGlossary(node, glossaryId));
      }
      const l = mk('span', 'rv-tag-l', label);
      const v = mk('span', 'rv-tag-v', '—');
      node.appendChild(l);
      node.appendChild(v);
      if (sensor) node.dataset.sensor = sensor;
      tagGrid.appendChild(node);
      nodes.tagEls.push(node);
      nodes.tagVals.push(v);
      return node;
    };

    for (let i = 0; i < TAGS.length; i++) add(TAGS[i].label, TAGS[i].glossary, TAGS[i].sensor);

    const tanks = (config && config.tanks) || [];
    for (let k = 0; k < tanks.length; k++) {
      const node = add(tanks[k].id, tanks[k].id, null);
      nodes.tankTags.push({ node, val: nodes.tagVals[nodes.tagVals.length - 1], idx: k,
        lowPct: tanks[k].lowLevelPct || 10, nominal: tanks[k].nominalVolume_mL || 1 });
    }
    tagSig = String(tanks.length);
  }

  /* ========================================================================================== */
  /* 4.3 phase rail                                                                             */
  /* ========================================================================================== */

  /**
   * Rebuild the phase rail. Block widths are proportional to the volume each block delivers
   * (§6.28); a `HOLD` block has no finite volume, so it is given a fixed narrow slot rather than
   * being dropped, because the operator still has to see it coming.
   * @returns {void}
   */
  function buildRail() {
    const config = ctx.config;
    const method = config && config.method;
    const blocks = (method && method.blocks) || [];
    railList.textContent = '';
    nodes.railBlocks.length = 0; nodes.railFills.length = 0;

    const vols = new Array(blocks.length);
    let total = 0;
    for (let i = 0; i < blocks.length; i++) {
      const v = methodlib.blockVolume_mL(config, blocks[i]);
      vols[i] = Number.isFinite(v) ? Math.max(v, 0) : NaN;
      if (Number.isFinite(vols[i])) total += vols[i];
    }
    const holdSlot = total > 0 ? total * 0.06 : 1;
    for (let i = 0; i < vols.length; i++) if (!Number.isFinite(vols[i])) vols[i] = holdSlot;
    let grand = 0;
    for (let i = 0; i < vols.length; i++) grand += vols[i];
    if (grand <= 0) grand = 1;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const li = mk('li');
      li.style.flex = (vols[i] / grand).toFixed(6) + ' 1 0';
      const btn = mk('button', 'rv-blk');
      btn.type = 'button';
      btn.dataset.kind = BLOCK_KIND[b.type] || 'other';
      btn.dataset.index = String(i);
      btn.title = b.id + ' · ' + b.name + ' · ' + b.type
        + ' — click for parameters';
      btn.setAttribute('aria-label', 'Block ' + (i + 1) + ' of ' + blocks.length + ', ' + b.name);
      if (b.enabled === false) btn.classList.add('is-off');
      const fill = mk('span', 'rv-blk-f');
      const label = mk('span', 'rv-blk-t', b.name);
      btn.appendChild(fill);
      btn.appendChild(label);
      btn.addEventListener('click', () => openBlockPopover(btn, i));
      btn.addEventListener('keydown', onRailKey);
      li.appendChild(btn);
      railList.appendChild(li);
      nodes.railBlocks.push(btn);
      nodes.railFills.push(fill);
    }
    railSig = blocks.map((b) => b.id + ':' + b.type + ':' + (b.enabled === false ? '0' : '1'))
      .join('|');
  }

  /**
   * Arrow-key navigation across the rail.
   * @param {KeyboardEvent} e The key event.
   * @returns {void}
   */
  function onRailKey(e) {
    const n = nodes.railBlocks.length;
    if (n === 0) return;
    const i = Number(e.currentTarget.dataset.index);
    let j = -1;
    if (e.key === 'ArrowRight') j = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j < 0) return;
    e.preventDefault();
    nodes.railBlocks[j].focus();
  }

  /**
   * The block parameter popover of §6.28 — the click target on every rail segment.
   * @param {Element} anchorEl The rail button.
   * @param {number} i Block index.
   * @returns {void}
   */
  function openBlockPopover(anchorEl, i) {
    const config = ctx.config;
    const b = (config.method && config.method.blocks) ? config.method.blocks[i] : null;
    if (!b) return;
    const wrap = mk('div', 'rv-pop');
    wrap.appendChild(mk('div', 'rv-pop-h', b.id + ' · ' + b.name));
    const dl = mk('dl');
    dl.style.display = 'grid';
    dl.style.gridTemplateColumns = 'auto 1fr';
    dl.style.columnGap = '10px';
    dl.style.rowGap = '3px';
    dl.style.margin = '6px 0 0';
    const row = (k, v) => {
      const dt = mk('dt', '', k);
      dt.style.color = 'var(--text-3)';
      dt.style.fontSize = '10px';
      dt.style.textTransform = 'uppercase';
      dt.style.letterSpacing = '.06em';
      const dd = mk('dd', 'rv-num', v);
      dd.style.margin = '0';
      dl.appendChild(dt);
      dl.appendChild(dd);
    };
    const d = b.duration || {};
    const f = b.flow || {};
    const g = b.gradient || {};
    const inl = b.inlets || {};
    const fr = b.fractionation || {};
    const Q = methodlib.blockFlow_mLs(config, b, i > 0 ? config.method.blocks[i - 1] : null);
    row('Type', b.type);
    row('Enabled', b.enabled === false ? 'no' : 'yes');
    row('Duration', nfix(d.value, 2) + ' ' + (d.basis || '') + ' · on timeout '
      + (d.onTimeout || 'NEXT'));
    row('Volume', fmt.fmtVolume(methodlib.blockVolume_mL(config, b), config));
    row('Flow', (f.mode || 'INHERIT') + ' ' + nfix(f.value, 2) + '  →  '
      + fmt.fmtFlow(Q, config));
    row('Gradient', (g.shape || 'ISOCRATIC') + '  ' + nfix(g.startPctB, 1) + ' → '
      + nfix(g.endPctB, 1) + ' %B over ' + nfix(100 * (g.lengthFraction ?? 1), 0) + '% of block');
    row('Inlets', 'A ' + (inl.a || '–') + '  B ' + (inl.b || '–') + '  S '
      + (inl.sample || '–'));
    row('Column valve', b.columnValve || '–');
    row('Outlet default', b.outletDefault || '–');
    row('Fractionation', (fr.mode || 'OFF') + (fr.signal ? ' on ' + fr.signal : ''));
    row('Autozero', b.autozero ? 'yes' : 'no');
    row('Hold at end', b.holdAtEnd ? 'yes' : 'no');
    row('Watches', String((b.watches && b.watches.length) || 0));
    wrap.appendChild(dl);
    const gl = glossaryFor('block.type');
    if (gl) {
      const p = mk('p', '', gl.short);
      p.style.margin = '8px 0 0';
      p.style.color = 'var(--text-2)';
      wrap.appendChild(p);
    }
    track(overlaylib.showPopover(host, { anchorEl, content: wrap, placement: 'bottom',
      maxWidth: 320 }));
  }

  /* ========================================================================================== */
  /* 4.4 fraction strip                                                                         */
  /* ========================================================================================== */

  /**
   * Rebuild the vial rail. Slot 0 is WASTE so the collector head always has a home to park in.
   * @returns {void}
   */
  function buildVials() {
    const config = ctx.config;
    const ports = (config.skid && config.skid.fracValve && config.skid.fracValve.ports) || [];
    vialList.textContent = '';
    nodes.vials.length = 0; nodes.vialFills.length = 0;

    const slots = ['WASTE'].concat(ports);
    for (let i = 0; i < slots.length; i++) {
      const isWaste = i === 0;
      const li = mk('li');
      const btn = mk('button', 'rv-vial' + (isWaste ? ' is-waste' : ''));
      btn.type = 'button';
      btn.dataset.slot = String(i);
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      btn.setAttribute('aria-label', isWaste ? 'Waste' : 'Fraction ' + slots[i]);
      btn.title = isWaste ? 'Waste — the outlet default'
        : 'Fraction ' + slots[i] + ' — click to select for pooling, shift-click to extend';
      const body = mk('span', 'rv-vial-b');
      const fill = mk('span', 'rv-vial-f');
      body.appendChild(fill);
      const id = mk('span', 'rv-vial-id', slots[i]);
      btn.appendChild(body);
      btn.appendChild(id);
      if (!isWaste) {
        btn.addEventListener('click', (e) => onVialClick(i - 1, e.shiftKey));
        btn.addEventListener('keydown', onVialKey);
      }
      li.appendChild(btn);
      vialList.appendChild(li);
      nodes.vials.push(btn);
      nodes.vialFills.push(fill);
    }
    vialSig = slots.join(',');
    selFrom = -1; selTo = -1;
    applySelection();
  }

  /**
   * Select a fraction, or extend the selection with shift.
   * @param {number} portIdx Index into `config.skid.fracValve.ports`.
   * @param {boolean} extend True to extend the current range.
   * @returns {void}
   */
  function onVialClick(portIdx, extend) {
    if (extend && selFrom >= 0) {
      selTo = portIdx;
    } else if (selFrom === portIdx && selTo === portIdx) {
      selFrom = -1; selTo = -1;
    } else {
      selFrom = portIdx; selTo = portIdx;
    }
    applySelection();
  }

  /**
   * Arrow-key navigation and selection across the vial rail.
   * @param {KeyboardEvent} e The key event.
   * @returns {void}
   */
  function onVialKey(e) {
    const n = nodes.vials.length;
    const i = Number(e.currentTarget.dataset.slot);
    let j = -1;
    if (e.key === 'ArrowRight') j = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') j = Math.max(1, i - 1);
    else if (e.key === 'Home') j = 1;
    else if (e.key === 'End') j = n - 1;
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onVialClick(i - 1, e.shiftKey);
      return;
    }
    if (j < 1) return;
    e.preventDefault();
    nodes.vials[j].focus();
    if (e.shiftKey) onVialClick(j - 1, true);
  }

  /**
   * Push the current fraction selection to the chart's pool window, the strip's classes and the
   * bus, in the chart's current x units.
   * @returns {void}
   */
  function applySelection() {
    const config = ctx.config;
    const run = ctx.run;
    const ports = (config.skid && config.skid.fracValve && config.skid.fracValve.ports) || [];
    const lo = Math.min(selFrom, selTo);
    const hi = Math.max(selFrom, selTo);
    for (let i = 0; i < ports.length; i++) {
      const on = selFrom >= 0 && i >= lo && i <= hi;
      const btn = nodes.vials[i + 1];
      if (!btn) continue;
      fmt.cls(btn, 'is-sel', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (selFrom < 0) {
      fmt.setText(fracSel, 'No pool selection');
      if (chart) chartlib.setPoolWindow(chart, null, null);
      emit('fraction-selection', { from: null, to: null, records: [] });
      return;
    }
    const recs = run.frac.records.filter((r) => {
      const k = ports.indexOf(r.port);
      return k >= lo && k <= hi;
    });
    let x0 = NaN;
    let x1 = NaN;
    let vol = 0;
    for (let i = 0; i < recs.length; i++) {
      const a = toX(recs[i].startVolume_mL, recs[i].startTime_s);
      const b = toX(recs[i].endVolume_mL, recs[i].endTime_s);
      if (!Number.isFinite(x0) || a < x0) x0 = a;
      if (!Number.isFinite(x1) || b > x1) x1 = b;
      vol += recs[i].volume_mL || 0;
    }
    const label = 'Pool: ' + ports[lo] + (hi > lo ? '–' + ports[hi] : '')
      + ' · ' + fmt.fmtVolume(vol, config)
      + (recs.length ? '' : ' (not collected yet)');
    fmt.setText(fracSel, label);
    if (chart) {
      if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
        chartlib.setPoolWindow(chart, x0, x1);
      } else {
        chartlib.setPoolWindow(chart, null, null);
      }
    }
    emit('fraction-selection', { from: ports[lo], to: ports[hi], records: recs });
  }

  /* ========================================================================================== */
  /* 4.5 alarms                                                                                 */
  /* ========================================================================================== */

  /**
   * Rebuild the active-alarm list through the app's one list reconciler. The panel is hidden
   * entirely while nothing is active, so a quiet skid costs no vertical space.
   * @returns {void}
   */
  function renderAlarms() {
    const config = ctx.config;
    const run = ctx.run;
    const table = config.alarms || [];
    const items = [];
    let sig = '';
    for (let k = 0; k < table.length; k++) {
      const active = run.alarmActive[k] === 1;
      const latched = run.alarmLatched[k] === 1;
      if (!active && !latched) continue;
      const acked = run.alarmAcked[k] === 1;
      items.push({ row: table[k], k, active, latched, acked });
      sig += k + (active ? 'a' : '') + (latched ? 'l' : '') + (acked ? 'k' : '') + ';';
    }
    if (sig === alarmSig) return;
    alarmSig = sig;
    items.sort((p, q) => (SEV_RANK[q.row.severity] || 0) - (SEV_RANK[p.row.severity] || 0));

    almPanel.hidden = items.length === 0;
    fmt.setText(almCount, String(items.length));

    fmt.reconcileList(almList, items, (it) => it.row.id,
      () => {
        const li = mk('li', 'rv-alm');
        li.appendChild(mk('span', 'rv-chip alarm', ''));
        li.appendChild(mk('span', 'rv-alm-id', ''));
        li.appendChild(mk('span', 'rv-alm-nm', ''));
        const ack = mk('button', 'rv-ack', 'Ack');
        ack.type = 'button';
        li.appendChild(ack);
        return li;
      },
      (li, it) => {
        const sev = li.children[0];
        const id = li.children[1];
        const nm = li.children[2];
        const ack = li.children[3];
        fmt.setText(sev, SEV_SHORT[it.row.severity] || it.row.severity);
        sev.className = 'rv-chip ' + (SEV_RANK[it.row.severity] >= 4 ? 'alarm'
          : (SEV_RANK[it.row.severity] === 3 ? 'alarm' : 'warn'));
        fmt.setText(id, it.row.id);
        fmt.setText(nm, it.row.name);
        li.title = it.row.name + ' — ' + it.row.severity + ', action ' + it.row.action
          + (it.latched && !it.active ? ' (latched, condition cleared)' : '');
        fmt.cls(li, 'is-latched', it.latched && !it.active);
        ack.hidden = it.acked || !(it.row.ackRequired || it.latched);
        ack.onclick = () => act('acknowledgeAlarm', it.row.id);
      });
  }

  /* ========================================================================================== */
  /* 4.6 chart plumbing                                                                         */
  /* ========================================================================================== */

  /**
   * Convert a (volume, time) pair to the chart's current x channel value.
   * @param {number} v_mL Detector-plane volume, mL.
   * @param {number} t_s Simulated time, s.
   * @returns {number} x in the current mode's channel units.
   */
  function toX(v_mL, t_s) {
    if (xMode === 'time') return t_s;
    if (xMode === 'cv') return v_mL / ctx.config.column.V_mL;
    return v_mL;
  }

  /**
   * Build (or rebuild) the chart from the current legend axis assignments and visibilities.
   * @returns {void}
   */
  function rebuildChart() {
    const prevWindow = chart && chart.window ? { x0: chart.window.x0, x1: chart.window.x1 } : null;
    if (chart) {
      chartlib.destroyChart(chart);
      chart = null;
      chartHost.textContent = '';
    }
    const series = CHANNELS.map((ch, i) => ({
      id: ch.id,
      yAxis: nodes.lgAxis.length ? nodes.lgAxis[i].textContent : ch.axis,
      colorVar: ch.colorVar,
      dash: ch.dash.slice(),
      width: ch.width,
      fill: ch.fill || 0,
      visible: nodes.lgVis.length ? nodes.lgVis[i].checked : ch.visible,
      label: ch.label,
    }));
    chart = chartlib.createChart(chartHost, {
      xAxis: { mode: xMode },
      yAxes: Y_AXES.map((a) => Object.assign({}, a)),
      series,
      overview: true,
    });
    for (let i = 0; i < CHANNELS.length; i++) {
      chartlib.setSeriesChannel(chart, CHANNELS[i].id, CHANNELS[i].channel);
    }
    boundStore = ctx.run.log;
    chartlib.setSource(chart, boundStore, X_CHANNELS);
    chartlib.setXMode(chart, xMode);
    chartlib.setFollow(chart, follow);
    chartlib.attachInteractions(chart, {
      onZoom: onChartZoom,
      onCursor: onChartCursor,
      onSelect: onChartZoom,
      onPoolDrag: onChartPool,
    });
    if (prevWindow && Number.isFinite(prevWindow.x0) && prevWindow.x1 > prevWindow.x0) {
      chartlib.setWindow(chart, prevWindow.x0, prevWindow.x1);
    }
    annotationsDirty = true;
    applySelection();
  }

  /**
   * Any manual zoom or pan drops follow and raises the "Jump to live" pill (§9.3.4).
   * @param {object} [info] The chart's payload; `{x0, x1}` when it reports the new window.
   * @returns {void}
   */
  function onChartZoom(info) {
    if (info && Number.isFinite(info.x0) && info.x1 > info.x0) {
      viewWindow.x0 = info.x0;
      viewWindow.x1 = info.x1;
    }
    if (!follow) return;
    follow = false;
    if (chart) chartlib.setFollow(chart, false);
    syncFollowUi();
  }

  /**
   * Cursor moved: remember its x so the legend's at-cursor column can be filled from the log.
   * @param {object|number|null} info The chart's cursor payload, or null on leave.
   * @returns {void}
   */
  function onChartCursor(info) {
    if (info === null || info === undefined) { cursorX = NaN; return; }
    if (typeof info === 'number') { cursorX = info; return; }
    cursorX = Number.isFinite(info.x) ? info.x
      : (Number.isFinite(info.xValue) ? info.xValue : NaN);
  }

  /**
   * A pool drag on the chart maps back onto whole fractions, which is the unit a pool is actually
   * made of; Alt-free dragging therefore snaps to fraction boundaries.
   * @param {object|null} info `{x0, x1}` in chart x units, or null to clear.
   * @returns {void}
   */
  function onChartPool(info) {
    const config = ctx.config;
    const run = ctx.run;
    const ports = (config.skid && config.skid.fracValve && config.skid.fracValve.ports) || [];
    if (!info) { selFrom = -1; selTo = -1; applySelection(); return; }
    const a = Math.min(info.x0, info.x1);
    const b = Math.max(info.x0, info.x1);
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < run.frac.records.length; i++) {
      const r = run.frac.records[i];
      const rs = toX(r.startVolume_mL, r.startTime_s);
      const re = toX(r.endVolume_mL, r.endTime_s);
      if (re < a || rs > b) continue;
      const k = ports.indexOf(r.port);
      if (k < 0) continue;
      if (lo < 0 || k < lo) lo = k;
      if (hi < 0 || k > hi) hi = k;
    }
    selFrom = lo;
    selTo = hi;
    applySelection();
  }

  /**
   * Rebuild the phase bands, event chevrons and fraction ticks from `run.events` and
   * `run.frac.records`. Events are scanned incrementally; the whole set is re-projected whenever
   * the x mode changes, because band coordinates are in chart x units.
   * @returns {void}
   */
  function rebuildAnnotations() {
    const config = ctx.config;
    const run = ctx.run;
    const events = run.events || [];
    bands = [];
    markers = [];
    openBands.length = 0;

    let open = null;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'BLOCK_START') {
        if (open) { open.x1 = toX(ev.V_mL, ev.t_s); bands.push(open); }
        const blk = findBlock(config, ev.blockId);
        open = { x0: toX(ev.V_mL, ev.t_s), x1: toX(ev.V_mL, ev.t_s),
          label: blk ? blk.name : (ev.blockId || ''),
          kind: blk ? (BLOCK_KIND[blk.type] || 'other') : 'other' };
      } else if (ev.type === 'BLOCK_END' && open) {
        open.x1 = toX(ev.V_mL, ev.t_s);
        bands.push(open);
        open = null;
      }
      const mk2 = MARKER_EVENTS[ev.type];
      if (mk2) {
        if (ev.type === 'STATE_CHANGE'
          && !(ev.message && /HELD|PAUSED|ALARM|FAULT/.test(ev.message))) continue;
        markers.push({ x: toX(ev.V_mL, ev.t_s), label: ev.message || mk2, kind: 'flag',
          severity: ev.severity });
      }
    }
    if (open) {
      open.x1 = toX(run.V_tot_mL, run.t_s);
      bands.push(open);
      openBands.push(open);
    }
    const recs = run.frac.records;
    for (let i = 0; i < recs.length; i++) {
      markers.push({ x: toX(recs[i].endVolume_mL, recs[i].endTime_s), label: recs[i].port,
        kind: 'tick' });
    }
    evCursor = events.length;
    if (chart) {
      chartlib.setBands(chart, bands);
      chartlib.setMarkers(chart, markers);
      chartlib.invalidate(chart, 'static');
    }
    annotationsDirty = false;
    lastBandExtend = -1e9;
  }

  /**
   * Stretch the in-progress phase band out to the live edge. Called at 2 Hz, not per frame: the
   * static layer's repaint budget is under five per second (§6.26) and the band edge is at the
   * live edge either way.
   *
   * @param {number} now Frame timestamp, ms.
   * @returns {void}
   */
  function extendOpenBand(now) {
    if (openBands.length === 0 || !chart) return;
    if (now - lastBandExtend < 500) return;
    lastBandExtend = now;
    openBands[0].x1 = toX(ctx.run.V_tot_mL, ctx.run.t_s);
    chartlib.setBands(chart, bands);
    chartlib.invalidate(chart, 'static');
  }

  /**
   * Find a method block by id.
   * @param {object} config The frozen config.
   * @param {string} id Block id.
   * @returns {object|null} The block, or null.
   */
  function findBlock(config, id) {
    const blocks = (config.method && config.method.blocks) || [];
    for (let i = 0; i < blocks.length; i++) if (blocks[i].id === id) return blocks[i];
    return null;
  }

  /* ========================================================================================== */
  /* 4.7 splitters                                                                              */
  /* ========================================================================================== */

  /**
   * Wire one horizontal splitter: pointer drag, arrow-key resizing (10 px, shift 40 px) and three
   * snap points, exposing `role="separator"` with a live `aria-valuenow` (§9.1.2, §9.7).
   *
   * @param {Element} handle The 6 px hit area.
   * @param {string} varName The CSS custom property it drives, e.g. '--rv-frac-h'.
   * @param {number[]} snaps Three snap sizes in px, ascending.
   * @param {string} label Accessible name.
   * @returns {function():void} A teardown function.
   */
  function wireSplitter(handle, varName, snaps, label) {
    let size = snaps[1] !== undefined ? snaps[1] : snaps[0];
    if (varName === '--rv-bottom-h') size = snaps[0];
    const lo = snaps[0] - 24;
    const hi = snaps[snaps.length - 1] + 96;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', label);
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-valuemin', String(lo));
    handle.setAttribute('aria-valuemax', String(hi));

    const apply = (v) => {
      size = clamp(v, lo, hi);
      el.style.setProperty(varName, Math.round(size) + 'px');
      handle.setAttribute('aria-valuenow', String(Math.round(size)));
      if (chart) chartlib.invalidate(chart, 'all');
    };
    apply(size);

    let dragging = false;
    let startY = 0;
    let startSize = 0;
    const onDown = (e) => {
      dragging = true;
      startY = e.clientY;
      startSize = size;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      apply(startSize - (e.clientY - startY));
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      let best = snaps[0];
      let bestD = Infinity;
      for (let i = 0; i < snaps.length; i++) {
        const d = Math.abs(snaps[i] - size);
        if (d < bestD) { bestD = d; best = snaps[i]; }
      }
      if (bestD <= 18) apply(best);
    };
    const onKey = (e) => {
      const step = e.shiftKey ? 40 : 10;
      if (e.key === 'ArrowUp') { apply(size + step); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { apply(size - step); e.preventDefault(); }
      else if (e.key === 'Home') { apply(snaps[0]); e.preventDefault(); }
      else if (e.key === 'End') { apply(snaps[snaps.length - 1]); e.preventDefault(); }
    };
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    handle.addEventListener('keydown', onKey);
    return () => {
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.removeEventListener('keydown', onKey);
    };
  }

  /* ========================================================================================== */
  /* 4.8 misc UI plumbing                                                                       */
  /* ========================================================================================== */

  /**
   * Run a `core/sim.js` action and let the overlay host explain a refusal. Interlocks are always
   * explained, never silently refused (§9.4.4).
   * @param {string} name The action name.
   * @param {...any} args Arguments after `ctx`.
   * @returns {boolean} True when the action succeeded.
   */
  function act(name, ...args) {
    return overlaylib.reportResult(host, callSim(ctx, name, ...args));
  }

  /**
   * Open the glossary popover for an id, when `data/glossary.js` has an entry. An id with no entry
   * renders no info affordance at all, which is the glossary module's stated contract.
   * @param {Element} anchorEl The anchor.
   * @param {string} id A glossary id, tag or alias.
   * @returns {void}
   */
  function openGlossary(anchorEl, id) {
    const entry = glossaryFor(id);
    if (!entry) return;
    track(overlaylib.showGlossaryPopover(host, {
      anchorEl,
      entry,
      placement: 'top',
      onSeeAlso: (seeAlsoId) => openGlossary(anchorEl, seeAlsoId),
    }));
  }

  /**
   * Remember an overlay handle so `destroy` can dismiss it.
   * @param {any} handle An overlay handle.
   * @returns {any} The same handle.
   */
  function track(handle) {
    if (handle) openHandles.push(handle);
    return handle;
  }

  /**
   * Emit on the app bus, tolerating a context without one.
   * @param {string} name Event name.
   * @param {any} payload Payload.
   * @returns {void}
   */
  function emit(name, payload) {
    if (ctx.bus && typeof ctx.bus.emit === 'function') ctx.bus.emit(name, payload);
  }

  /**
   * Reflect the follow flag on the toolbar button and the "Jump to live" pill.
   * @returns {void}
   */
  function syncFollowUi() {
    followBtn.setAttribute('aria-pressed', follow ? 'true' : 'false');
    livePill.hidden = follow;
  }

  /**
   * Switch the x axis mode. Bands and markers are re-projected, because their coordinates are in
   * chart x units.
   * @param {'volume'|'time'|'cv'} mode The new mode.
   * @returns {void}
   */
  function setXMode(mode) {
    if (mode === xMode) return;
    xMode = mode;
    for (let i = 0; i < xBtns.length; i++) {
      xBtns[i].setAttribute('aria-checked', xBtns[i].dataset.mode === mode ? 'true' : 'false');
    }
    syncChartTitle();
    if (chart) chartlib.setXMode(chart, mode);
    annotationsDirty = true;
    viewWindow.x0 = NaN;
    viewWindow.x1 = NaN;
    applySelection();
  }

  /**
   * Name the chromatogram's x unit in the panel header, so the axis unit is stated even before the
   * chart has drawn a tick label.
   * @returns {void}
   */
  function syncChartTitle() {
    let unit = 'mL';
    for (let i = 0; i < X_MODES.length; i++) if (X_MODES[i].mode === xMode) unit = X_MODES[i].unit;
    fmt.setText(chartTitle, 'Chromatogram · x in ' + unit);
  }

  /**
   * The window the chart is showing. The chart is the authority when it publishes one; otherwise
   * the view's own record of the last window it set is used, falling back to the whole run.
   * @returns {{x0:number, x1:number}} The window in the current x mode's channel units.
   */
  function currentWindow() {
    const w = chart && chart.window;
    if (w && Number.isFinite(w.x0) && w.x1 > w.x0) return { x0: w.x0, x1: w.x1 };
    if (Number.isFinite(viewWindow.x0) && viewWindow.x1 > viewWindow.x0) {
      return { x0: viewWindow.x0, x1: viewWindow.x1 };
    }
    const col = column(ctx.run.log, X_CHANNELS[xMode]);
    const last = col.length ? col[col.length - 1] : 0;
    return { x0: 0, x1: last > 0 ? last : 1 };
  }

  /**
   * Set the chart window and remember it.
   * @param {number} x0 Left bound.
   * @param {number} x1 Right bound.
   * @returns {void}
   */
  function setWindow(x0, x1) {
    if (!chart || !(x1 > x0)) return;
    viewWindow.x0 = x0;
    viewWindow.x1 = x1;
    chartlib.setWindow(chart, x0, x1);
  }

  /**
   * Zoom about the window centre — the `+` / `-` keys of §9.5.
   * @param {number} factor Span multiplier; below 1 zooms in.
   * @returns {void}
   */
  function zoomBy(factor) {
    const w = currentWindow();
    const c = 0.5 * (w.x0 + w.x1);
    const half = 0.5 * (w.x1 - w.x0) * factor;
    if (!(half > 0)) return;
    onChartZoom();
    setWindow(c - half, c + half);
  }

  /**
   * Pan by a fraction of the window span — the arrow keys of §9.5.
   * @param {number} frac Signed fraction of the span, e.g. -0.05.
   * @returns {void}
   */
  function panBy(frac) {
    const w = currentWindow();
    const d = (w.x1 - w.x0) * frac;
    if (!Number.isFinite(d) || d === 0) return;
    onChartZoom();
    setWindow(w.x0 + d, w.x1 + d);
  }

  /**
   * Fit the whole run into the window and stop following.
   * @returns {void}
   */
  function fitAll() {
    if (!chart) return;
    const col = column(ctx.run.log, X_CHANNELS[xMode]);
    const last = col.length ? col[col.length - 1] : 0;
    setWindow(0, last > 0 ? last : 1);
    follow = false;
    chartlib.setFollow(chart, false);
    syncFollowUi();
  }

  /**
   * Re-enable live following and jump the window to the live edge.
   * @returns {void}
   */
  function jumpToLive() {
    if (!chart) return;
    follow = true;
    chartlib.setFollow(chart, true);
    syncFollowUi();
  }

  /**
   * Toggle live following from the toolbar button or the `F` key.
   * @returns {void}
   */
  function toggleFollow() {
    if (!follow) { jumpToLive(); return; }
    follow = false;
    if (chart) chartlib.setFollow(chart, false);
    syncFollowUi();
  }

  /* ---- event wiring ----------------------------------------------------------------------- */
  for (let i = 0; i < xBtns.length; i++) {
    xBtns[i].addEventListener('click', () => setXMode(xBtns[i].dataset.mode));
    xBtns[i].addEventListener('keydown', (e) => {
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % xBtns.length;
      else if (e.key === 'ArrowLeft') j = (i + xBtns.length - 1) % xBtns.length;
      if (j < 0) return;
      e.preventDefault();
      xBtns[j].focus();
      setXMode(xBtns[j].dataset.mode);
    });
  }
  fitBtn.addEventListener('click', fitAll);
  followBtn.addEventListener('click', toggleFollow);
  livePill.addEventListener('click', jumpToLive);
  fracMark.addEventListener('click', () => act('markFraction'));
  fracClear.addEventListener('click', () => { selFrom = -1; selTo = -1; applySelection(); });

  /**
   * The chart, legend and pooling shortcuts of §9.5. `ui/app.js` owns the one document key
   * listener and forwards every action it does not handle itself on the bus as `'key-action'`, so
   * this view never installs a second listener and nothing is ever double-handled.
   *
   * @param {{action:string}} payload The bus payload from `ui/app.js`.
   * @returns {void}
   */
  function onKeyAction(payload) {
    if (!mounted || !payload || cachedW <= 0) return;    // a hidden Run tab owns no shortcut
    switch (payload.action) {
      case 'x-axis-cycle': {
        let k = 0;
        for (let i = 0; i < X_MODES.length; i++) if (X_MODES[i].mode === xMode) k = i;
        setXMode(X_MODES[(k + 1) % X_MODES.length].mode);
        return;
      }
      case 'autoscale': fitAll(); return;
      case 'follow-toggle': toggleFollow(); return;
      case 'zoom-in': zoomBy(1 / 1.6); return;
      case 'zoom-out': zoomBy(1.6); return;
      case 'pan-left': panBy(-0.05); return;
      case 'pan-right': panBy(0.05); return;
      case 'pan-left-fast': panBy(-0.25); return;
      case 'pan-right-fast': panBy(0.25); return;
      case 'legend-focus':
        setFocusChannel(null);
        if (nodes.lgName.length) nodes.lgName[0].focus();
        return;
      case 'pool-selection': {
        if (selFrom < 0) {
          overlaylib.showToast(host, {
            message: 'Select one or more fractions in the strip first, then press Shift+P.',
            kind: 'info', ms: 4000,
          });
          return;
        }
        const ports = ctx.config.skid.fracValve.ports;
        const lo = Math.min(selFrom, selTo);
        const hi = Math.max(selFrom, selTo);
        emit('pool-request', { from: ports[lo], to: ports[hi] });
        return;
      }
      default:
    }
  }

  /* ---- bus + observers -------------------------------------------------------------------- */
  const busHandlers = [];

  /**
   * Subscribe to a bus event and remember the pair for teardown.
   * @param {string} name Event name.
   * @param {Function} fn Handler.
   * @returns {void}
   */
  function on(name, fn) {
    if (!ctx.bus || typeof ctx.bus.on !== 'function') return;
    ctx.bus.on(name, fn);
    busHandlers.push([name, fn]);
  }

  /** Full rebind after the config or run object was replaced (§2.4). */
  const onReplaced = () => {
    pendingStructural = true;
    annotationsDirty = true;
    evCursor = 0;
    statRow = 0;
    for (let i = 0; i < stat.length; i++) { stat[i].min = Infinity; stat[i].max = -Infinity; }
    selFrom = -1; selTo = -1;
    alarmSig = '\u0000';
    if (chart) {
      boundStore = ctx.run.log;
      chartlib.setSource(chart, boundStore, X_CHANNELS);
      chartlib.invalidate(chart, 'all');
    }
  };

  const ro = new ResizeObserver((entries) => {
    for (let i = 0; i < entries.length; i++) {
      const r = entries[i].contentRect;
      cachedW = r.width;
      cachedH = r.height;
    }
    fmt.cls(el, 'is-narrow', cachedW > 0 && cachedW < 1024);
    fmt.cls(el, 'is-mid', cachedW >= 1024 && cachedW < 1280);
    fmt.cls(el, 'is-wide', cachedW >= 1600);
    fmt.cls(el, 'is-short', cachedH > 0 && cachedH < 700);
    if (chart) chartlib.invalidate(chart, 'all');
  });

  const themeObserver = new MutationObserver(() => refreshTokens());

  const mq = (typeof window.matchMedia === 'function')
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const onMq = () => {
    reduced = !!(mq && mq.matches);
    fmt.cls(el, 'is-reduced', reduced);
  };

  /**
   * Re-read the theme token map and repaint everything that caches a colour.
   * @returns {void}
   */
  function refreshTokens() {
    tokens = fmt.readThemeTokens('current') || {};
    for (let i = 0; i < nodes.lgSw.length; i++) paintSwatch(nodes.lgSw[i], CHANNELS[i]);
    if (chart) chartlib.invalidate(chart, 'all');
  }

  let unwireL = null;
  let unwireR = null;

  /* ========================================================================================== */
  /* 4.9 per-frame update                                                                       */
  /* ========================================================================================== */

  /**
   * Refresh the phase rail: the block classes and the sweep transform, then the header text.
   * Called on the 10 Hz readout tick — the sweep crosses a block over minutes, so a faster cadence
   * would buy nothing and cost a style write per frame.
   * @returns {void}
   */
  function updateRail() {
    const config = ctx.config;
    const run = ctx.run;
    const blocks = (config.method && config.method.blocks) || [];
    const cur = run.blockIndex;
    const prog = engine.blockProgress(config, run);
    for (let i = 0; i < nodes.railBlocks.length; i++) {
      const btn = nodes.railBlocks[i];
      const done = i < cur;
      const isCur = i === cur && run.state !== 'IDLE' && run.state !== 'READY';
      fmt.cls(btn, 'is-done', done);
      fmt.cls(btn, 'is-cur', isCur);
      if (isCur) btn.setAttribute('aria-current', 'step');
      else btn.removeAttribute('aria-current');
      const f = done ? 1 : (isCur ? clamp(prog.fraction, 0, 1) : 0);
      nodes.railFills[i].style.transform = 'scaleX(' + f.toFixed(4) + ')';
    }
    const b = blocks[cur];
    fmt.setText(railBlockName, b
      ? (cur + 1) + '/' + blocks.length + ' · ' + b.name + ' · ' + b.type
      : 'No block');
    fmt.setText(railProg, fmt.fmtVolume(run.V_block_mL, config) + ' in block · '
      + nfix(100 * clamp(prog.fraction, 0, 1), 0) + '%');
    fmt.setText(railRemain, Number.isFinite(prog.remaining_mL)
      ? 'remaining ' + fmt.fmtVolume(prog.remaining_mL, config)
        + (Number.isFinite(prog.remaining_s) ? ' · ' + fmt.fmtTime(prog.remaining_s) : '')
      : 'ends on a watch');
  }

  /**
   * Refresh the fraction strip: vial fill heights, per-vial state and the collector head position.
   * Called on the 10 Hz readout tick; the head's own `left` carries a CSS transition, so a valve
   * switch still reads as continuous motion.
   * @returns {void}
   */
  function updateFractions() {
    const config = ctx.config;
    const run = ctx.run;
    const ports = config.skid.fracValve.ports;
    const cap = config.skid.fracValve.portCapacity_mL || 1;
    const nSlots = nodes.vials.length;

    const byPort = new Map();
    for (let i = 0; i < run.frac.records.length; i++) {
      byPort.set(run.frac.records[i].port, run.frac.records[i]);
    }
    for (let i = 0; i < ports.length; i++) {
      const btn = nodes.vials[i + 1];
      if (!btn) continue;
      const v = run.portVolume_mL ? run.portVolume_mL[i] : 0;
      nodes.vialFills[i + 1].style.height = clamp(100 * v / cap, 0, 100).toFixed(1) + '%';
      const rec = byPort.get(ports[i]);
      fmt.cls(btn, 'has-rec', !!rec);
      fmt.cls(btn, 'has-peak', !!(rec && rec.containsPeakMax));
      fmt.cls(btn, 'is-open', run.frac.open && run.frac.port === ports[i]);
      btn.title = rec
        ? ports[i] + ' · ' + fmt.fmtVolume(rec.volume_mL, config) + ' · max '
          + nfix(rec.uvMax_mAU, 1) + ' mAU · ' + rec.trigger + ' · ' + rec.quality
        : ports[i] + ' — empty';
    }
    const modeCls = 'rv-chip ' + (run.frac.mode && run.frac.mode !== 'OFF' ? 'ok' : 'mut');
    fmt.setText(fracMode, run.frac.mode || 'OFF');
    if (fracMode.className !== modeCls) fracMode.className = modeCls;
    fmt.setText(fracPort, 'Valve → ' + (run.frac.port || 'WASTE')
      + (run.frac.open ? ' (collecting)' : '')
      + ' · ' + run.frac.records.length + ' collected');
    fracMark.disabled = !(run.state === 'RUNNING' || run.state === 'HELD')
      || run.frac.mode === 'OFF';

    // Collector head: slot 0 is WASTE, slot k+1 is ports[k].
    const slotOf = (name) => {
      const k = ports.indexOf(name);
      return k >= 0 ? k + 1 : 0;
    };
    let slot = slotOf(run.frac.port);
    if (run.frac.moving) {
      const tS = config.skid.fracValve.tSwitch_s || 1;
      const u = clamp(run.frac.moveElapsed_s / tS, 0, 1);
      const from = slotOf(run.frac.moveFrom);
      slot = from + (slot - from) * u;
    }
    if (nSlots > 0) {
      collectorHead.style.left = (100 * (slot + 0.5) / nSlots).toFixed(3) + '%';
    }
  }

  /**
   * Refresh the legend: live values from `run`, min/max scanned incrementally from the log store,
   * at-cursor values read at the cursor's row, and the per-sensor quality badge.
   * @returns {void}
   */
  function updateLegend() {
    const config = ctx.config;
    const run = ctx.run;
    const store = run.log;

    if (!store || store.n < statRow) {
      statRow = 0;
      for (let i = 0; i < stat.length; i++) { stat[i].min = Infinity; stat[i].max = -Infinity; }
    }
    if (store && store.n > statRow) {
      for (let i = 0; i < CHANNELS.length; i++) {
        const col = column(store, CHANNELS[i].channel);
        let mn = stat[i].min;
        let mx = stat[i].max;
        for (let r = statRow; r < col.length; r++) {
          const v = col[r];
          if (!Number.isFinite(v)) continue;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        stat[i].min = mn;
        stat[i].max = mx;
      }
      statRow = store.n;
    }

    let curRow = -1;
    if (Number.isFinite(cursorX) && store && store.n > 0) {
      const range = xIndexRange(store, X_CHANNELS[xMode], -Infinity, cursorX);
      curRow = clamp(range.i1 - 1, 0, store.n - 1);
    }

    for (let i = 0; i < CHANNELS.length; i++) {
      const ch = CHANNELS[i];
      fmt.setText(nodes.lgVal[i], nfix(ch.live(config, run), ch.dec));
      fmt.setText(nodes.lgMin[i], nfix(stat[i].min === Infinity ? NaN : stat[i].min, ch.dec));
      fmt.setText(nodes.lgMax[i], nfix(stat[i].max === -Infinity ? NaN : stat[i].max, ch.dec));
      if (curRow >= 0) {
        const col = column(store, ch.channel);
        fmt.setText(nodes.lgCur[i], nfix(col[curRow], ch.dec));
      } else {
        fmt.setText(nodes.lgCur[i], '—');
      }
      const q = ch.sensor ? sensors.sensorQuality(run, ch.sensor) : 'OK';
      const badge = nodes.lgQ[i];
      if (badge.dataset.q !== q) {
        badge.dataset.q = q;
        fmt.setText(badge, q === 'OK' ? '✓' : q.slice(0, 4));
        badge.title = ch.sensor ? ch.sensor + ' signal quality: ' + q : 'derived value';
      }
    }
  }

  /**
   * Refresh the tag readout grid — the permanent home of every §5.2 signal.
   * @returns {void}
   */
  function updateTags() {
    const config = ctx.config;
    const run = ctx.run;
    for (let i = 0; i < TAGS.length; i++) {
      const t = TAGS[i];
      fmt.setText(nodes.tagVals[i], t.read(config, run));
      if (t.sensor) {
        const q = sensors.sensorQuality(run, t.sensor);
        if (nodes.tagEls[i].dataset.q !== q) nodes.tagEls[i].dataset.q = q;
      }
    }
    for (let k = 0; k < nodes.tankTags.length; k++) {
      const tt = nodes.tankTags[k];
      const v = run.tankVolume_mL ? run.tankVolume_mL[tt.idx] : NaN;
      fmt.setText(tt.val, fmt.fmtVolume(v, config));
      fmt.cls(tt.node, 'is-low', Number.isFinite(v) && v < tt.nominal * tt.lowPct / 100);
    }
  }

  /**
   * Refresh the header chips: run state, manual mode, and the quality-flag bitfield.
   * @returns {void}
   */
  function updateHeader() {
    const run = ctx.run;
    fmt.setText(pidState, run.state);
    const stateCls = 'rv-chip rv-num ' + (
      run.state === 'RUNNING' ? 'ok'
        : (run.state === 'ALARM' || run.state === 'FAULT' ? 'alarm'
          : (run.state === 'HELD' || run.state === 'PAUSED' ? 'warn' : 'mut')));
    if (pidState.className !== stateCls) pidState.className = stateCls;
    pidManual.hidden = !run.manualOverride;
    fmt.cls(pidPanel, 'is-manual', !!run.manualOverride);
    const qf = run.qualityFlags | 0;
    for (let i = 0; i < qfChipEls.length; i++) {
      qfChipEls[i].hidden = (qf & QF_CHIPS[i][1]) === 0;
    }
  }

  /* ========================================================================================== */
  /* 5. PANEL                                                                                   */
  /* ========================================================================================== */

  /**
   * Mount: build the children that need a laid-out DOM (the chart and the P&ID), take the first
   * structural render and start observing.
   * @returns {void}
   */
  function mount() {
    if (mounted) return;
    mounted = true;

    tokens = fmt.readThemeTokens('current') || {};
    onMq();
    if (mq) {
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMq);
      else if (typeof mq.addListener === 'function') mq.addListener(onMq);
    }

    buildLegend();
    buildTags();
    buildRail();
    buildVials();

    pid = pidlib.createPID(pidHost, ctx);
    if (pid && typeof pid.mount === 'function') pid.mount();

    rebuildChart();
    syncFollowUi();
    syncChartTitle();

    unwireL = wireSplitter(spL, '--rv-frac-h', SNAP_FRAC, 'Resize the fraction strip');
    unwireR = wireSplitter(spR, '--rv-bottom-h', SNAP_BOTTOM, 'Resize the channel legend');

    on('config-replaced', onReplaced);
    on('preset-loaded', onReplaced);
    on('scenario-applied', onReplaced);
    on('run-reset', onReplaced);
    on('run-started', () => { pendingStructural = true; annotationsDirty = true; jumpToLive(); });
    on('run-ended', () => { pendingStructural = true; annotationsDirty = true; fitAll(); });
    on('estop', () => { pendingStructural = true; });
    on('theme-changed', refreshTokens);
    on('key-action', onKeyAction);

    ro.observe(el);
    themeObserver.observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme', 'class'] });

    renderAlarms();
    updateHeader();
    updateRail();
    updateFractions();
    updateLegend();
    updateTags();
  }

  /**
   * The per-frame render. Physics is not touched here: `ui/app.js` has already called
   * `sim.advanceWall` for this frame.
   *
   * @param {{now_ms:number, dt_ms:number, tick:number, structural:boolean}} frameInfo
   *   The frame descriptor from `ui/app.js`.
   * @returns {void}
   */
  function update(frameInfo) {
    if (!mounted) return;
    if (cachedW <= 0 || cachedH <= 0) return;      // hidden tab or zero-size: cost nothing

    const now = (frameInfo && Number.isFinite(frameInfo.now_ms))
      ? frameInfo.now_ms : performance.now();
    const structural = pendingStructural || !!(frameInfo && frameInfo.structural);
    pendingStructural = false;
    const run = ctx.run;
    const config = ctx.config;

    if (run.log !== boundStore && chart) {
      boundStore = run.log;
      chartlib.setSource(chart, boundStore, X_CHANNELS);
      chartlib.invalidate(chart, 'all');
    }

    if (structural) {
      const blocks = (config.method && config.method.blocks) || [];
      const sig = blocks.map((b) => b.id + ':' + b.type + ':' + (b.enabled === false ? '0' : '1'))
        .join('|');
      if (sig !== railSig) buildRail();
      const ports = config.skid.fracValve.ports;
      if (['WASTE'].concat(ports).join(',') !== vialSig) buildVials();
      if (String((config.tanks || []).length) !== tagSig) buildTags();
      annotationsDirty = true;
    }

    if (annotationsDirty || (run.events && run.events.length !== evCursor)) {
      rebuildAnnotations();
    } else {
      extendOpenBand(now);
    }

    chartEmpty.hidden = !!(run.log && run.log.n > 0);

    if (now - lastReadout >= READOUT_MS) {
      lastReadout = now;
      updateHeader();
      renderAlarms();
      updateRail();
      updateFractions();
      updateLegend();
      updateTags();
    }

    if (pid && typeof pid.update === 'function') pid.update(frameInfo);
    if (chart) chartlib.frame(chart, now);
  }

  /**
   * Tear everything down: observers, bus subscriptions, splitter handlers, overlays, the chart and
   * the P&ID. After this the view holds no references into `run` or `config`.
   * @returns {void}
   */
  function destroy() {
    mounted = false;
    ro.disconnect();
    themeObserver.disconnect();
    if (mq) {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onMq);
      else if (typeof mq.removeListener === 'function') mq.removeListener(onMq);
    }
    for (let i = 0; i < busHandlers.length; i++) {
      if (ctx.bus && typeof ctx.bus.off === 'function') {
        ctx.bus.off(busHandlers[i][0], busHandlers[i][1]);
      }
    }
    busHandlers.length = 0;
    if (unwireL) unwireL();
    if (unwireR) unwireR();
    for (let i = 0; i < openHandles.length; i++) overlaylib.dismiss(openHandles[i]);
    openHandles.length = 0;
    if (chart) { chartlib.destroyChart(chart); chart = null; }
    if (pid && typeof pid.destroy === 'function') pid.destroy();
    pid = null;
    boundStore = null;
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return { el, mount, update, destroy };
}
