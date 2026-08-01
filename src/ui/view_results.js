/**
 * @file `src/ui/view_results.js` — the RESULTS screen (architecture-v2 §6.30, §9.3, §9.7), drawn in
 * the HMI-2012 operator vocabulary: graphite panels edged with a single 1px border over a subtle
 * 180deg gradient, recessed label boxes carrying a tag and an engineering unit, icon-only controls
 * with tooltips, recessed data grids. 2px corners; never a four-step bevel.
 *
 * The full-width chromatogram, the peak table, the pooling tool, the pool metrics, the mass
 * balance, the packing-test analysis, the exports and the post-run outcome summary.
 *
 * THIS MODULE OWNS THE GRID AND THE PACKING-TEST ANALYSIS (§6.30). It calls
 * `peaks.buildVolumeGrid(config, run)` — the single object cached on `run.grid` (§6.19) — and hands
 * that one object to `detectPeaks`, `poolMetrics`, `rePool` and `autoPool`, so a pool index produced
 * by a chart drag and a peak index produced by the detector always mean the same sample. It is also
 * the only module that imports both analytics modules, which is why `skid/engine.js` runs no
 * `PACKING_TEST` analysis of its own (§5.4.3).
 *
 * The view is READ-ONLY over `config` and `run` with exactly two contract-mandated exceptions, both
 * at operator rate and both named in §6.30:
 *   - `bed.forceFlush(config, run, 'MASS_AUDIT')` before any mass-balance display — `pooling.js` is
 *     L2 and cannot flush itself (§3.4);
 *   - `log.logEvent(..., 'PACKING_TEST_RESULT', ...)` once per analysed packing-test block.
 * Everything else goes through `ctx.sim`.
 *
 * TEXT POLICY: no sentence renders on this screen. Values live in sunken label boxes carrying their
 * tag and unit, truth-only metrics are drawn in the cyan output colour, controls are icons with
 * `title` + `aria-label`, and every explanation lives in a tooltip or a glossary popover.
 */

import {
  createChart, setSource, setSeriesChannel, setSeriesVisible, setWindow, setXMode, setFollow,
  invalidate, frame as chartFrame, setBands, setMarkers, setPoolWindow, attachInteractions,
  exportPNG, destroyChart,
} from './chart.js';
import {
  h, hSvg, setText, setAttr, cls, reconcileList,
  fmtVolume, fmtCond, fmtPH, fmtTime,
} from './format.js';
import { createOverlayHost, showGlossaryPopover, showToast, dismiss } from './overlay.js';
import * as peaks from '../analytics/peaks.js';
import * as pooling from '../analytics/pooling.js';
import * as bed from '../physics/bed.js';
import { column as logColumn, xIndexRange, logEvent } from '../core/log.js';
import {
  exportDataCSV, exportEventsCSV, exportFractionsCSV, exportRunJSON,
  downloadText, downloadBlob,
} from '../io/export.js';
import { SCENARIOS } from '../data/presets.js';
import { glossaryFor } from '../data/glossary.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

const STYLE_ID = 'rv-ftclassic-style';

/** Peak/pool analysis is operator-rate: never more often than this, in ms. */
const ANALYSIS_MS = 600;
/** Pool metrics during a live drag, in ms. */
const POOL_MS = 100;
/** The mass balance forces a column flush, so it is explicitly rate-limited, in ms. */
const AUDIT_MS = 2000;
/** Rows in the accessible data-table alternative (§9.7): every 1 % of the run. */
const DATA_TABLE_ROWS = 101;
/** |xi| above which a mass-balance row is called open (§5.11.4, DoD 7). */
const XI_TOL = 1e-6;

/**
 * Quality bits (§5.3) that make the UV trace SUSPECT or INVALID. §5.3 requires this view to flag
 * any peak whose window overlaps such an interval.
 */
const UV_SUSPECT_MASK = 0x0001 /* UV_OVERRANGE */ | 0x0002 /* UV_SATURATED */
  | 0x0004 /* UV_LAMP_FAULT */ | 0x0008 /* UV_AUTOZERO_UNSTABLE */
  | 0x0200 /* DETECTORS_BYPASSED */ | 0x0400 /* AIR_IN_PATH */;

/**
 * Chart y-axes. §9.3.1 lists pH and %B both on `R2` with mutually exclusive fixed ranges
 * (2–12 and 0–100), which no single axis can satisfy, so %B is given its own fixed 0–100 axis.
 */
const Y_AXES = [
  { id: 'L1', label: 'UV', unit: 'mAU', side: 'left', mode: 'auto-sticky', min: 0, max: 100 },
  { id: 'R1', label: 'COND', unit: 'mS/cm', side: 'right', mode: 'auto-sticky', min: 0, max: 10 },
  { id: 'R2', label: 'pH', unit: '', side: 'right', mode: 'manual', min: 2, max: 12 },
  { id: 'R3', label: 'P / Q', unit: 'bar', side: 'right', mode: 'auto-sticky', min: 0, max: 2 },
  { id: 'R4', label: '%B', unit: '%', side: 'right', mode: 'manual', min: 0, max: 100 },
];

/**
 * The eight channels of §9.3.1 on the pen palette: PV pens solid, the paired dashes kept as each
 * channel's dash signature so colour is never the sole encoder. `colorVar` names a token in
 * `styles/tokens.css` — no pen carries a hex of its own.
 */
const SERIES = [
  { id: 'uv280', channel: 'UV_280_mAU', yAxis: 'L1', colorVar: '--pen-uv',
    dash: [], width: 1.5, tag: 'UV-101', label: 'UV 280', unit: 'mAU', visible: true },
  // The palette names a pen per UV wavelength — `--pen-uv2` for 260 and `--pen-uv3` for 300 —
  // and these two used to ignore both: 260 borrowed the TEMPERATURE pen and 300 took UV 280's
  // own `--pen-uv`, so the two most-compared traces on the L1 axis were the identical green and
  // the dash pattern was carrying the whole distinction on its own.
  { id: 'uv260', channel: 'UV_260_mAU', yAxis: 'L1', colorVar: '--pen-uv2',
    dash: [], width: 1.2, tag: 'UV-260', label: 'UV 260', unit: 'mAU', visible: false },
  { id: 'uv300', channel: 'UV_300_mAU', yAxis: 'L1', colorVar: '--pen-uv3',
    dash: [1, 4], width: 1, tag: 'UV-300', label: 'UV 300', unit: 'mAU', visible: false },
  { id: 'cond', channel: 'cond_mS_cm', yAxis: 'R1', colorVar: '--pen-cond',
    dash: [], width: 1.5, tag: 'CE-101', label: 'Conductivity', unit: 'mS/cm', visible: true },
  { id: 'ph', channel: 'pH', yAxis: 'R2', colorVar: '--pen-ph',
    dash: [6, 3], width: 1.5, tag: 'AE-101', label: 'pH', unit: '', visible: false },
  { id: 'pctb', channel: 'pctB_column_inlet', yAxis: 'R4', colorVar: '--pen-pctb',
    dash: [], width: 1.5, tag: 'AIC-101', label: '%B', unit: '%', visible: true },
  { id: 'press', channel: 'P1_bar', yAxis: 'R3', colorVar: '--pen-press',
    dash: [3, 3], width: 1.5, tag: 'PT-101', label: 'P1', unit: 'bar', visible: false },
  { id: 'flow', channel: 'flow_mL_min', yAxis: 'R3', colorVar: '--pen-flow',
    dash: [8, 2, 2, 2], width: 1.5, tag: 'FIC-101', label: 'Flow', unit: 'mL/min', visible: false },
];

/** Phase-band tint keys by block type (§9.3.3). */
const BAND_KIND = {
  EQUILIBRATION: 'neutral', RE_EQUILIBRATION: 'neutral', HOLD: 'neutral',
  LOAD: 'load', WASH: 'wash',
  ELUTION_ISOCRATIC: 'elute', ELUTION_LINEAR: 'elute', ELUTION_STEP: 'elute',
  STRIP: 'cip', CIP: 'cip', COLUMN_BYPASS: 'neutral', PACKING_TEST: 'wash',
};

/** X-axis modes, shown as one- or two-character chips (never a word on a button face). */
const X_MODES = [
  { id: 'volume', chip: 'V', title: 'X axis: volume, mL' },
  { id: 'time', chip: 'T', title: 'X axis: time' },
  { id: 'cv', chip: 'CV', title: 'X axis: column volumes' },
];

/**
 * The pool metric boxes, in display order. `truth` marks the ones only the simulator can know —
 * those are drawn in the cyan `--fld-out` colour, never in the white `--fld-pv` colour a real
 * instrument's reading would take.
 */
const POOL_CARDS = [
  { key: 'yield', tag: 'YIELD', label: 'Yield', unit: '%', glossary: 'yield', truth: false },
  { key: 'purityMass', tag: 'PUR-M', label: 'Purity (mass)', unit: '%', glossary: 'purity', truth: true },
  { key: 'purityArea', tag: 'PUR-A', label: 'Purity (area)', unit: '%', glossary: 'purity', truth: true },
  { key: 'aggregate', tag: 'AGG', label: 'Aggregate', unit: '%', glossary: 'aggregate', truth: true },
  { key: 'mass', tag: 'MASS', label: 'Product mass', unit: 'mg', glossary: null, truth: false },
  { key: 'conc', tag: 'CONC', label: 'Concentration', unit: 'g/L', glossary: null, truth: false },
  { key: 'volume', tag: 'V-POOL', label: 'Pool volume', unit: '', glossary: null, truth: false },
  { key: 'cfactor', tag: 'C-FACT', label: 'Concentration factor', unit: 'x',
    glossary: 'concentration-factor', truth: false },
  { key: 'cond', tag: 'COND', label: 'Pool conductivity', unit: '', glossary: 'conductivity', truth: false },
  { key: 'ph', tag: 'PH', label: 'Pool pH', unit: '', glossary: 'ph', truth: false },
  { key: 'productivity', tag: 'PROD', label: 'Productivity', unit: 'g/L/h', glossary: 'productivity',
    truth: false },
  { key: 'buffer', tag: 'BUF', label: 'Buffer consumption', unit: 'L/g', glossary: 'buffer-consumption',
    truth: false },
];

/** Integration parameter fields: 10 px tag, sunken entry, unit. */
const PARAM_FIELDS = [
  { key: 'A_on_mAU', tag: 'A-ON', label: 'Height gate', unit: 'mAU', dec: 2, glossary: 'peak-max' },
  { key: 'f_on_pct', tag: 'F-ON', label: 'Relative gate', unit: '%', dec: 2, glossary: null },
  { key: 'p_min_mAU', tag: 'P-MIN', label: 'Minimum prominence', unit: 'mAU', dec: 2, glossary: null },
  { key: 'w_min_CV', tag: 'W-MIN', label: 'Minimum width', unit: 'CV', dec: 3, glossary: 'cv' },
  { key: 'W50_CV', tag: 'W50', label: 'Expected peak width at half height', unit: 'CV', dec: 3,
    glossary: 'peak-width-w50' },
  { key: 'maxPeaks', tag: 'N-MAX', label: 'Maximum peaks', unit: '-', dec: 0, glossary: null },
];

/** Icon geometry, authored here as 16×16 stroke paths — no icon font, no network (§0). */
const ICONS = {
  fit: ['M2 6V2h4', 'M14 6V2h-4', 'M2 10v4h4', 'M14 10v4h-4'],
  pool: ['M4 2.5v11', 'M12 2.5v11', 'M4 8h8'],
  table: ['M2 3h12v10H2z', 'M2 6.4h12', 'M6.2 3v10'],
  png: ['M2 3h12v10H2z', 'M4 11.5 7 8.5l2 2 2-2 3 3'],
  csvData: ['M2 3h12v10H2z', 'M2 6.4h12', 'M5.6 6.4v7.6', 'M9.8 6.4v7.6'],
  csvPeaks: ['M1.5 12.5h13', 'M2.5 11 5 5l2.5 6', 'M8.5 11 11 7.5l2.5 3.5'],
  csvFrac: ['M3 2.5h2.5v11H3z', 'M6.8 2.5h2.4v11H6.8z', 'M10.6 2.5H13v11h-2.4z'],
  csvEvents: ['M2.5 4h11', 'M2.5 8h11', 'M2.5 12h7'],
  json: ['M6 2C4 2 5.2 7 3 8c2.2 1 1 6 3 6', 'M10 2c2 0 .8 5 3 6-2.2 1-1 6-3 6'],
  auto: ['M2.5 13.5 10 6', 'M11 1.5l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1z'],
  target: ['M8 1.5v3', 'M8 11.5v3', 'M1.5 8h3', 'M11.5 8h3',
    'M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z'],
  clear: ['M4 4l8 8', 'M12 4l-8 8'],
  refresh: ['M13.5 8a5.5 5.5 0 1 1-1.7-4', 'M13.5 1.5v3.2h-3.2'],
  info: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M8 7v4.5', 'M8 4.4v.9'],
  caret: { f: ['M4 6h8l-4 5z'] },
  caretRight: { f: ['M6 4v8l5-4z'] },
};

/**
 * The scoped HMI-2012 sheet.
 *
 * Two things are load-bearing here and easy to undo by accident:
 *
 *  1. THE DEPTH LANGUAGE is six aliases on `.rv-root` — raised, pressed, sunken, zebra, gloss —
 *     each pointing at one of the recipes `styles/tokens.css` publishes (`--surface-raised`,
 *     `--elev-sunken`, `--lamp-gloss` …). No rule below hand-rolls a border, a gradient or a
 *     shadow, so the light theme comes for free and there is not one colour literal in this file.
 *
 *  2. EVERY SELECTOR IS SCOPED UNDER `.rv-root`. The class names here (`.rv-panel`, `.rv-hd`) are
 *     shared with `styles/app.css` and with the run screen; without the scope this sheet would
 *     restyle both.
 */
const CSS = `
.rv-root{
  --u-raise:var(--surface-raised);
  --u-press:var(--surface-pressed);
  --u-drop:var(--elev-raised);
  --u-sunk:var(--elev-sunken);
  --u-zebra:var(--press-tint);
  --u-gloss:radial-gradient(circle at 34% 27%,var(--lamp-gloss) 0 1.3px,transparent 2.4px);
  position:relative;height:100%;min-height:0;display:flex;flex-direction:column;gap:3px;padding:3px;
  background:var(--screen);color:var(--ink);font:400 11px/1.3 var(--font-ui);
  -webkit-font-smoothing:antialiased;
}
.rv-root *{box-sizing:border-box}
.rv-root .rv-rz{background:var(--u-raise);border:var(--border-edge);border-radius:2px;
  box-shadow:var(--u-drop)}
.rv-root .rv-sk{background:var(--fld-bg);border:var(--border-field);border-radius:2px;
  box-shadow:var(--u-sunk)}
.rv-root .rv-panel{background:var(--panel);border:var(--border-edge);border-radius:2px;
  box-shadow:var(--u-drop);display:flex;flex-direction:column;min-width:0;min-height:0;
  overflow:hidden}
.rv-root .rv-panel--chart{flex:1 1 58%;min-height:240px}
.rv-root .rv-group{display:flex;flex-direction:column;gap:3px;min-width:0;min-height:0}
.rv-root .rv-lower{flex:0 0 auto;display:grid;
  grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr);gap:3px;min-height:0;
  max-height:46%}
@media (max-width:1180px){.rv-root .rv-lower{grid-template-columns:minmax(0,1fr);max-height:none}}
.rv-root .rv-hd{height:22px;flex:0 0 22px;display:flex;align-items:center;gap:6px;padding:0 6px;
  background:var(--u-raise);border:0;border-bottom:var(--border-soft);border-radius:0;
  box-shadow:none;color:var(--ink);user-select:none;font:600 11px/1 var(--font-ui);
  text-transform:uppercase;letter-spacing:.02em}
.rv-root .rv-hd__sp{flex:1 1 auto}
.rv-root .rv-bar{display:flex;align-items:center;gap:3px;height:26px;flex:0 0 26px;padding:0 4px;
  background:var(--panel);border:0;border-bottom:var(--border-soft);border-radius:0;
  box-shadow:none;overflow-x:auto;overflow-y:hidden}
.rv-root .rv-sep{width:1px;height:15px;flex:0 0 1px;margin:0 4px;background:var(--edge-soft)}
.rv-root .rv-btn{width:22px;height:22px;flex:0 0 22px;padding:0;border:var(--border-edge);
  border-radius:2px;background:var(--u-raise);color:var(--ink-2);box-shadow:var(--u-drop);
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.rv-root .rv-btn svg{width:12px;height:12px;display:block;fill:none;stroke:currentColor;
  stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.rv-root .rv-btn--chip{width:auto;min-width:24px;padding:0 6px;
  font:600 10px/1 var(--font-num);letter-spacing:.02em}
.rv-root .rv-btn:hover:not(:disabled){color:var(--ink);border-color:var(--ink-3)}
.rv-root .rv-btn:active:not(:disabled){background:var(--u-press);box-shadow:none}
.rv-root .rv-btn[aria-pressed="true"],.rv-root .rv-btn[aria-checked="true"]{
  background:var(--u-press);border-color:var(--accent);color:var(--ink);box-shadow:none}
.rv-root .rv-btn:disabled{color:var(--ink-3);cursor:not-allowed;box-shadow:none}
.rv-root .rv-btn:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.rv-root .rv-chartroot{flex:1 1 auto;min-height:0;min-width:0;display:flex;flex-direction:column;
  margin:3px;background:var(--plot-bg);border:var(--border-field);border-radius:3px;
  overflow:hidden}
.rv-root .rv-chartroot.is-pooling,.rv-root .rv-chartroot.is-pooling *{cursor:cell}
.rv-root .rv-scroll{flex:1 1 auto;min-height:0;overflow:auto}
.rv-root .rv-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));
  gap:2px 8px;padding:4px}
.rv-root .rv-form[hidden],.rv-root .rv-row[hidden],.rv-root .rv-f[hidden]{display:none}
.rv-root .rv-f{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:5px;
  height:22px}
.rv-root .rv-lb{font:500 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.02em;
  color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:none;
  border:0;padding:0;text-align:left}
.rv-root button.rv-lb{cursor:help;text-decoration:underline dotted 1px;text-underline-offset:2px}
.rv-root button.rv-lb:hover{color:var(--ink)}
.rv-root .rv-box{display:flex;align-items:center;height:20px;min-width:0;padding:0 4px;
  background:var(--fld-bg);border:var(--border-field);border-radius:2px;
  box-shadow:var(--u-sunk)}
.rv-root .rv-box>input{flex:1 1 auto;min-width:0;width:100%;background:transparent;border:0;
  padding:0;margin:0;text-align:right;color:var(--fld-sp);font:500 13px/1 var(--font-num);
  font-variant-numeric:tabular-nums lining-nums}
.rv-root .rv-box>input:focus{outline:none}
.rv-root .rv-box>.rv-v{flex:1 1 auto;min-width:0;text-align:right;color:var(--fld-pv);
  font:500 13px/1 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-root .rv-box>.rv-v[data-truth="1"]{color:var(--fld-out)}
.rv-root .rv-box>.rv-v[data-q="alarm"]{color:var(--fld-alarm)}
.rv-root .rv-box>.rv-v[data-q="stale"]{color:var(--fld-stale)}
.rv-root .rv-box>.rv-eu{flex:0 0 auto;padding-left:4px;color:var(--fld-eu);
  font:400 10px/1 var(--font-num);white-space:nowrap}
.rv-root .rv-box:focus-within{outline:2px solid var(--accent);outline-offset:-2px}
.rv-root .rv-box--bad{border-color:var(--alarm);outline:2px solid var(--alarm);outline-offset:-2px}
.rv-root .rv-sel{height:20px;min-width:0;width:100%;padding:0 4px;background:var(--fld-bg);
  color:var(--ink);border:var(--border-field);border-radius:2px;box-shadow:var(--u-sunk);
  font:400 11px/1 var(--font-ui);cursor:pointer}
.rv-root .rv-sel:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.rv-root .rv-lamp{width:10px;height:10px;flex:0 0 10px;border-radius:50%;
  border:1px solid var(--lamp-ring);background:var(--u-gloss),var(--lamp-off)}
.rv-root .rv-lamp[data-s="run"]{background:var(--u-gloss),var(--ok);
  box-shadow:0 0 5px var(--glow-run)}
.rv-root .rv-lamp[data-s="warn"]{background:var(--u-gloss),var(--warn);
  box-shadow:0 0 5px var(--glow-warn)}
.rv-root .rv-lamp[data-s="alarm"]{background:var(--u-gloss),var(--alarm);
  box-shadow:0 0 5px var(--glow-alarm)}
.rv-root .rv-tw{overflow:auto;background:var(--panel);box-shadow:none;min-height:0}
.rv-root .rv-tbl{width:100%;border-collapse:collapse;font:400 11px/1 var(--font-ui);
  color:var(--ink)}
.rv-root .rv-tbl th{height:24px;padding:0 6px;text-align:left;white-space:nowrap;
  background:var(--u-raise);border-bottom:var(--border-edge);position:sticky;top:0;z-index:1;
  color:var(--ink-2);font:600 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.02em}
.rv-root .rv-tbl td{height:24px;padding:0 6px;white-space:nowrap;
  border-bottom:var(--border-soft);overflow:hidden;text-overflow:ellipsis}
.rv-root .rv-tbl td.num,.rv-root .rv-tbl th.num{text-align:right;font-family:var(--font-num);
  font-variant-numeric:tabular-nums lining-nums}
.rv-root .rv-tbl td.lamp{width:20px;padding:0 0 0 6px}
.rv-root .rv-tbl tbody tr:nth-child(2n) td{background:var(--u-zebra)}
.rv-root .rv-tbl tbody tr:hover td{background:var(--panel-hi)}
.rv-root .rv-tbl tbody tr.is-selected td{background:var(--accent-soft)}
.rv-root .rv-tbl tbody tr.is-selected td:first-child{box-shadow:inset 2px 0 0 var(--accent)}
.rv-root .rv-tbl tbody tr:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.rv-root .rv-code{margin-left:4px;padding:0 4px;background:var(--panel-hi);
  border:var(--border-edge);border-radius:2px;color:var(--ink-2);
  font:600 9px/13px var(--font-num);letter-spacing:.02em}
.rv-root .rv-code[data-kind="alarm"]{background:var(--alarm);border-color:var(--alarm);
  color:var(--on-alarm)}
.rv-root .rv-code[data-kind="warn"]{background:var(--warn);border-color:var(--warn);
  color:var(--on-warn)}
.rv-root .rv-grp{border-top:var(--border-soft)}
.rv-root .rv-grp__hd{width:100%;height:22px;display:flex;align-items:center;gap:4px;padding:0 6px;
  border:0;background:var(--u-raise);color:var(--ink-2);cursor:pointer;text-align:left;
  font:600 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.02em}
.rv-root .rv-grp__hd:hover{color:var(--ink)}
.rv-root .rv-grp__hd:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.rv-root .rv-grp__hd svg{width:11px;height:11px;fill:currentColor;stroke:none;flex:0 0 11px}
.rv-root .rv-grp.is-closed .rv-grp__b{display:none}
.rv-root .rv-row{display:flex;align-items:center;gap:4px;padding:3px 4px;flex-wrap:wrap}
.rv-root .rv-status{height:20px;display:flex;align-items:center;padding:0 5px;
  background:var(--fld-bg);border:var(--border-field);border-radius:2px;
  box-shadow:var(--u-sunk);color:var(--fld-pv);font:500 11px/1 var(--font-num);
  letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-root .rv-status[data-kind="warn"]{color:var(--fld-alarm)}
.rv-root .rv-empty{display:flex;align-items:center;gap:6px;margin:3px;padding:4px 6px;
  background:var(--fld-bg);border:var(--border-field);border-radius:2px;
  box-shadow:var(--u-sunk);color:var(--fld-stale);font:500 10px/1 var(--font-num);
  letter-spacing:.02em}
.rv-root .rv-empty[hidden]{display:none}
.rv-root .rv-mb{display:grid;grid-template-columns:14px 1fr 62px 62px;align-items:center;gap:5px;
  height:24px;padding:0 5px;border-bottom:var(--border-soft);
  font:400 11px/1 var(--font-ui)}
.rv-root .rv-mb__n{text-align:right;font:500 12px/1 var(--font-num);
  font-variant-numeric:tabular-nums lining-nums;color:var(--fld-pv)}
.rv-root .rv-mb[data-ok="false"] .rv-mb__n{color:var(--fld-alarm)}
.rv-root .rv-pen{display:inline-block;width:14px;height:0;border-top-width:2px;
  border-top-style:solid;flex:0 0 14px;margin-right:3px}
@media (prefers-contrast:more){.rv-root{--ink-2:var(--ink)}}
`;

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** Inject the scoped HMI-2012 sheet once per document. */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Fixed-decimal display; a non-finite value is an em dash, never a guess. */
function num(x, d) {
  return Number.isFinite(x) ? x.toFixed(d) : '—';
}

/** Grow a Float64Array to at least `n`, reusing the buffer when it already fits. */
function ensureF64(buf, n) {
  if (buf && buf.length >= n) return buf;
  return new Float64Array(Math.max(n, 256));
}

/** Clamp helper (local: `core/util.js` is not a dependency of this view). */
function clampInt(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Passes of the detection-scale moving average. Three passes ≈ a Gaussian. */
const BOX_PASSES = 3;
/** Doublings the auto-widening may take before it gives up. */
const BOX_STEPS_MAX = 14;

/** One moving-average pass over `[0,len)`, half-width `hw` samples, O(n) by running sum. */
function boxPass(src, dst, len, hw) {
  let acc = 0;
  let cnt = 0;
  for (let k = 0; k <= hw && k < len; k++) { acc += src[k]; cnt++; }
  for (let k = 0; k < len; k++) {
    dst[k] = acc / cnt;
    const add = k + hw + 1;
    const sub = k - hw;
    if (add < len) { acc += src[add]; cnt++; }
    if (sub >= 0) { acc -= src[sub]; cnt--; }
  }
}

/**
 * The DETECTION-SCALE filter, `BOX_PASSES` moving-average passes; the result lands in `dst`.
 *
 * This is not a second copy of `peaks.smooth` — it does a different job. Savitzky–Golay is a
 * LOCAL noise filter whose window `selectWindow` caps at 9 samples × 12 passes, i.e. a few
 * millilitres; a preparative elution band is thousands of millilitres wide and carries real
 * shoulder structure on its top. `detectPeaks` splits a peak at the valley between ADJACENT
 * apexes, so every one of those shoulders becomes its own sliver with a prominence of hundredths
 * of a mAU, and the whole band is then rejected by `p_min`. Smoothing at the SCALE OF THE BAND is
 * what makes it a single apex again. Detection only: every number in the table is still measured
 * by `detectPeaks` on the raw trace `grid.y`.
 *
 * @param {ArrayLike<number>} src input trace, AU/cm.
 * @param {Float64Array} dst output, AU/cm.
 * @param {Float64Array} tmp scratch of the same length.
 * @param {number} len valid sample count.
 * @param {number} hw half-width in samples.
 * @returns {void}
 */
function boxcar(src, dst, tmp, len, hw) {
  let a = src;
  let b = BOX_PASSES % 2 === 1 ? dst : tmp;
  for (let p = 0; p < BOX_PASSES; p++) {
    boxPass(a, b, len, hw);
    a = b;
    b = (b === dst) ? tmp : dst;
  }
}

/** Local maxima at or above `gate` — the count the auto-widening drives down. */
function countApexes(y, len, gate) {
  let c = 0;
  for (let k = 1; k < len - 1; k++) {
    if (y[k] > y[k - 1] && y[k + 1] < y[k] && y[k] >= gate) c++;
  }
  return c;
}

/** Monotone clock, the same timebase as the rAF timestamps. */
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** One inline icon. */
function icon(name) {
  const spec = ICONS[name];
  const filled = spec && !Array.isArray(spec);
  const paths = filled ? spec.f : spec;
  const svg = hSvg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
  for (const d of paths || []) svg.appendChild(hSvg('path', { d }));
  return svg;
}

/** A round glassy status lamp. */
function lamp(state, title) {
  return h('span', {
    class: 'rv-lamp', 'data-s': state || 'off', role: 'img',
    'aria-label': title || state || 'off', title: title || '',
  });
}

/** A sunken label box: right-aligned value plus a dimmer EU suffix. */
function labelBox(unit, ariaLabel, truth) {
  const v = h('span', { class: 'rv-v' }, '—');
  if (truth) setAttr(v, 'data-truth', '1');
  const el = h('div', { class: 'rv-box rv-sk', role: 'group', 'aria-label': ariaLabel || unit || '' },
    v, unit ? h('span', { class: 'rv-eu' }, unit) : null);
  return { el, v };
}

/** A sunken entry box: right-aligned tabular input plus a dimmer EU suffix. */
function entryBox(unit, ariaLabel) {
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off',
    spellcheck: 'false', 'aria-label': ariaLabel });
  const el = h('div', { class: 'rv-box rv-sk' }, input, unit ? h('span', { class: 'rv-eu' }, unit) : null);
  return { el, input };
}

/** One overlay host per document, reused across mounts; `ui/app.js`'s own host wins if exposed. */
let sharedOverlayHost = null;

/**
 * The overlay host to float popovers and toasts from. `ui/app.js` owns one host for the whole
 * application (§6.33) but does not put it on `ctx`, so this mirrors `ui/view_run.js`: prefer a host
 * exposed on `ctx`, otherwise create one shared host for this module.
 *
 * @param {object} ctx the §2.4 context
 * @returns {object} the overlay host
 */
function overlayHostFor(ctx) {
  if (ctx && ctx.overlayHost) return ctx.overlayHost;
  if (ctx && ctx.overlay) return ctx.overlay;
  if (!sharedOverlayHost) sharedOverlayHost = createOverlayHost(document.body);
  return sharedOverlayHost;
}

/**
 * Normalise the several plausible shapes a chart interaction callback may use into `{x0,x1}`.
 * `ui/chart.js` declares `attachInteractions(chart, {onZoom, onCursor, onSelect, onPoolDrag})`
 * without pinning the payload, so `(x0, x1)`, `[x0, x1]` and `({x0, x1})` are all accepted.
 */
function xPair(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return { x0: a, x1: b };
  if (Array.isArray(a) && a.length >= 2) return { x0: +a[0], x1: +a[1] };
  if (a && typeof a === 'object') {
    const x0 = a.x0 !== undefined ? +a.x0 : (a.start !== undefined ? +a.start : NaN);
    const x1 = a.x1 !== undefined ? +a.x1 : (a.end !== undefined ? +a.end : NaN);
    if (Number.isFinite(x0) && Number.isFinite(x1)) return { x0, x1 };
  }
  return null;
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

/**
 * Create the Results panel.
 *
 * @param {Element} rootEl - the element the panel mounts into (the tab host built by `ui/app.js`).
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx -
 *   the one §2.4 context. `ctx.config` / `ctx.run` are re-read every frame and re-bound on
 *   `config-replaced`; the view never mutates them and drives the simulation only through
 *   `ctx.sim`.
 * @returns {{el:Element, mount:function():void,
 *   update:function({now_ms:number, dt_ms:number, tick:number, structural:boolean}):void,
 *   destroy:function():void}} the §6.24 Panel.
 */
export function createResultsView(rootEl, ctx) {
  injectStyles();

  /* ---------------------------------------------------------------- state */

  const dom = {};
  let overlayHost = null;
  let chart = null;
  let mounted = false;
  let visible = true;
  let observer = null;

  let xMode = (ctx.config.ui && ctx.config.ui.xMode) || 'volume';
  let poolMode = false;
  let altHeld = false;

  let grid = null;
  let ySmooth = null;
  let dySmooth = null;
  let boxTmp = null;
  let detectWidth_mL = NaN;
  let peakList = [];
  let peakRows = [];
  let selectedPeak = -1;
  let hoverPeak = -1;

  let pool = null;               // { i0, i1, metrics }
  let poolMetricsMode = 'truth'; // 'detector' | 'truth'
  let audit = null;              // MassBalance (§5.11.4)
  let packing = [];              // [{ blockId, result }]
  const packingLogged = new Set();

  let lastLogN = -1;
  let lastAnalysisMs = -1e9;
  let lastPoolMs = -1e9;
  let lastAuditMs = -1e9;
  let poolPending = null;
  let poolTimer = 0;
  let winX0 = NaN;
  let winX1 = NaN;
  let dragWin = null;
  let restoreTimer = 0;
  let lastBandKey = '';
  let lastMarkerKey = '';
  let dataTableOpen = false;

  const params = {
    A_on_mAU: 5,
    f_on_pct: 0.5,
    p_min_mAU: 2,
    w_min_CV: 0.01,
    W50_CV: 0.05,
    maxPeaks: 8,
    baseline: 'anchored',
  };
  const autoPoolCriterion = { type: 'APEX_PCT', value: 10, signal: 'UV_280' };

  const busHandlers = [];
  const listeners = [];
  let openPopover = null;

  /* -------------------------------------------------------------- plumbing */

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function subscribe(name, fn) {
    if (ctx.bus && typeof ctx.bus.on === 'function') {
      ctx.bus.on(name, fn);
      busHandlers.push([name, fn]);
    }
  }

  /**
   * The status strip carries a SHORT uppercase code; the sentence lives in its tooltip and in the
   * transient toast, never on the face of the screen.
   */
  function notify(code, message, kind) {
    if (dom.status) {
      setText(dom.status, code);
      setAttr(dom.status, 'title', message);
      setAttr(dom.status, 'data-kind', kind === 'warn' || kind === 'blocked' ? 'warn' : 'info');
    }
    try {
      if (overlayHost) showToast(overlayHost, { message, kind: kind || 'info', ms: 4000 });
    } catch (err) {
      // The aria-live status strip above has already carried the message.
    }
  }

  /** Open a glossary popover anchored at `anchor` (§6.33, §9.6). */
  function openGlossary(anchor, entry) {
    try {
      if (openPopover) dismiss(openPopover);
      openPopover = showGlossaryPopover(overlayHost, {
        anchorEl: anchor, entry, placement: 'right',
        onSeeAlso: (id) => {
          const next = glossaryFor(id);
          if (!next) return;
          if (openPopover) dismiss(openPopover);
          openPopover = showGlossaryPopover(overlayHost,
            { anchorEl: anchor, entry: next, placement: 'right' });
        },
      });
    } catch (err) {
      notify('HELP', `${entry.term}: ${entry.short}`, 'info');
    }
  }

  /**
   * The ⓘ affordance of §9.6, as an icon button. Returns null when the glossary has no entry,
   * which §6.22.1 makes the condition for rendering no affordance at all.
   */
  function info(glossaryId) {
    const entry = glossaryId ? glossaryFor(glossaryId) : null;
    if (!entry) return null;
    const btn = h('button', {
      type: 'button', class: 'rv-btn', 'aria-label': `About ${entry.term}`,
      title: `${entry.term} — ${entry.short}`,
    }, icon('info'));
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openGlossary(btn, entry);
    });
    return btn;
  }

  /** The 10 px tag label; with a glossary entry it becomes a help button. */
  function tagLabel(tag, fullLabel, glossaryId) {
    const entry = glossaryId ? glossaryFor(glossaryId) : null;
    if (!entry) return h('span', { class: 'rv-lb', title: fullLabel }, tag);
    const b = h('button', {
      type: 'button', class: 'rv-lb', title: `${fullLabel} — ${entry.short}`,
      'aria-label': `About ${entry.term}`,
    }, tag);
    b.addEventListener('click', (ev) => { ev.preventDefault(); openGlossary(b, entry); });
    return b;
  }

  /** A beveled icon-only button. */
  function iconButton(name, label, fn, opts) {
    const o = opts || {};
    const b = h('button', {
      type: 'button', class: 'rv-btn' + (o.chip ? ' rv-btn--chip' : ''), title: label,
      'aria-label': label,
    }, name ? icon(name) : null, o.chip ? h('span', {}, o.chip) : null);
    if (o.pressed !== undefined) setAttr(b, 'aria-pressed', o.pressed ? 'true' : 'false');
    on(b, 'click', fn);
    return b;
  }

  /** One dense `[tag][field]` row. */
  function frow(tag, label, glossaryId, control) {
    return h('div', { class: 'rv-f' }, tagLabel(tag, label, glossaryId), control);
  }

  /** A panel: raised face with a face-2 header strip. */
  function panel(title, ...children) {
    const hd = h('div', { class: 'rv-hd rv-rz' }, h('span', {}, title), h('span', { class: 'rv-hd__sp' }));
    const p = h('section', { class: 'rv-panel rv-rz' }, hd, ...children);
    p._hd = hd;
    return p;
  }

  /** A collapsible group with a caret and one or two uppercase words. */
  function group(title, closed, ...children) {
    const car = icon('caret');
    const body = h('div', { class: 'rv-grp__b' }, ...children);
    const hd = h('button', { type: 'button', class: 'rv-grp__hd', title,
      'aria-expanded': closed ? 'false' : 'true' }, car, h('span', {}, title));
    const sec = h('section', { class: 'rv-grp' + (closed ? ' is-closed' : '') }, hd, body);
    on(hd, 'click', () => {
      const nowClosed = !sec.classList.contains('is-closed');
      cls(sec, 'is-closed', nowClosed);
      setAttr(hd, 'aria-expanded', nowClosed ? 'false' : 'true');
      while (car.firstChild) car.removeChild(car.firstChild);
      const next = icon(nowClosed ? 'caretRight' : 'caret');
      while (next.firstChild) car.appendChild(next.firstChild);
    });
    sec._body = body;
    return sec;
  }

  /* ------------------------------------------------------- unit conversion */

  /** mAU as the detector reports it -> AU/cm, the canonical detector unit of §5.2. */
  function mAUtoAUcm(mAU) {
    return mAU / 1000 / ctx.config.skid.uv.pathlength_cm;
  }

  /** AU/cm -> mAU as the detector reports it. */
  function AUcmToMAU(auCm) {
    return auCm * 1000 * ctx.config.skid.uv.pathlength_cm;
  }

  /** The log channel the chart's current x-mode reads. */
  function xChannel() {
    return xMode === 'time' ? 't_s' : (xMode === 'cv' ? 'V_CV' : 'V_mL');
  }

  /**
   * Detector-plane volume -> chart x in the current x-mode's unit. Time mode goes through the log
   * so the mapping is the run's own, not an assumed constant flow.
   */
  function volumeToX(V_mL) {
    if (xMode === 'volume') return V_mL;
    if (xMode === 'cv') return V_mL / ctx.config.column.V_mL;
    const store = ctx.run.log;
    if (!store || !store.n) return 0;
    const r = xIndexRange(store, 'V_mL', V_mL, V_mL);
    const t = logColumn(store, 't_s');
    if (!t.length) return 0;
    return t[clampInt(r.i0, 0, t.length - 1)];
  }

  /** Chart x -> detector-plane volume, the exact inverse of {@link volumeToX}. */
  function xToVolume(x) {
    if (xMode === 'volume') return x;
    if (xMode === 'cv') return x * ctx.config.column.V_mL;
    const store = ctx.run.log;
    if (!store || !store.n) return 0;
    const r = xIndexRange(store, 't_s', x, x);
    const V = logColumn(store, 'V_mL');
    if (!V.length) return 0;
    return V[clampInt(r.i0, 0, V.length - 1)];
  }

  /** Grid index for a detector-plane volume. */
  function gridIndexOf(V_mL) {
    if (!grid || grid.n < 1) return 0;
    const k = Math.round((V_mL - grid.V[0]) / grid.dV_mL);
    return clampInt(k, 0, grid.n - 1);
  }

  /* --------------------------------------------------------------- analysis */

  /** Volume intervals over which the UV trace was SUSPECT or INVALID (§5.3). */
  function uvSuspectRanges() {
    const store = ctx.run.log;
    if (!store || !store.discrete || !store.discrete.qualityFlags) return [];
    const runs = store.discrete.qualityFlags.runs || [];
    const V = logColumn(store, 'V_mL');
    if (!V.length) return [];
    const out = [];
    for (const entry of runs) {
      const raw = entry[0];
      const start = entry[1] | 0;
      const len = entry[2] | 0;
      const bits = typeof raw === 'string'
        ? parseInt(String(raw).replace(/^0x/i, ''), 16) : (raw | 0);
      if (!Number.isFinite(bits) || !(bits & UV_SUSPECT_MASK)) continue;
      const i0 = clampInt(start, 0, V.length - 1);
      const i1 = clampInt(start + Math.max(len, 1) - 1, 0, V.length - 1);
      out.push([V[i0], V[i1]]);
    }
    return out;
  }

  /** Product mass extinction coefficient, L/(g·cm) — the area→mass constant. */
  function productEps() {
    const i = ctx.config.idxById[ctx.config.load.productSpeciesId];
    return (i === undefined || i < 0) ? NaN : ctx.config.species[i].eps280_Lgcm;
  }

  /** Derive every peak-table cell once, so rendering is pure text writing. */
  function buildPeakRows() {
    let totalArea = 0;
    for (const p of peakList) if (Number.isFinite(p.area_AUcm_mL)) totalArea += p.area_AUcm_mL;
    const eps = productEps();
    const suspect = uvSuspectRanges();
    peakRows = peakList.map((p, i) => {
      const V0 = grid.V[p.iStart];
      const V1 = grid.V[p.iEnd];
      let qualitySuspect = false;
      for (const [a, b] of suspect) if (b >= V0 && a <= V1) { qualitySuspect = true; break; }
      return {
        key: `p${i}`,
        i,
        p,
        V0,
        V1,
        areaPct: totalArea > 0 ? 100 * p.area_AUcm_mL / totalArea : NaN,
        mass_mg: eps > 0 ? p.area_AUcm_mL / eps : NaN,
        rs: i > 0 ? peaks.resolution(peakList[i - 1], p).Rs_half : NaN,
        qualitySuspect,
      };
    });
  }

  /** Rebuild the shared grid and re-run peak detection with the current integration parameters. */
  function recomputePeaks() {
    const { config, run } = ctx;
    grid = peaks.buildVolumeGrid(config, run);
    if (!grid || grid.n < 8) {
      peakList = [];
      peakRows = [];
      return;
    }
    ySmooth = ensureF64(ySmooth, grid.n);
    dySmooth = ensureF64(dySmooth, grid.n);
    boxTmp = ensureF64(boxTmp, grid.n);

    const W50_mL = Math.max(params.W50_CV * config.column.V_mL, grid.dV_mL * 4);
    const sel = peaks.selectWindow(W50_mL, grid.dV_mL);

    // Build the detection trace at the scale of the band: start from the expected peak width and
    // widen by doubling until no more than `maxPeaks` apexes clear the height gate. Bounded by
    // BOX_STEPS_MAX and by a quarter of the record, so it always terminates.
    const gate = mAUtoAUcm(params.A_on_mAU);
    const target = Math.max(1, params.maxPeaks | 0);
    const hwCap = Math.max(2, grid.n >> 2);
    let hw = clampInt(Math.round(W50_mL / grid.dV_mL / 8), 2, hwCap);
    for (let step = 0; step < BOX_STEPS_MAX; step++) {
      boxcar(grid.y, ySmooth, boxTmp, grid.n, hw);
      if (countApexes(ySmooth, grid.n, gate) <= target) break;
      const next = hw * 2;
      if (next > hwCap) break;
      hw = next;
    }
    detectWidth_mL = hw * grid.dV_mL;
    peaks.derivative1(ySmooth, grid.n, sel.m, grid.dV_mL, dySmooth);

    peakList = peaks.detectPeaks(config, grid, ySmooth, dySmooth, {
      A_on_AUcm: mAUtoAUcm(params.A_on_mAU),
      f_on: params.f_on_pct / 100,
      s_on: 0,
      s_off: 0,
      p_min: mAUtoAUcm(params.p_min_mAU),
      w_min: params.w_min_CV * config.column.V_mL,
      path_cm: config.skid.uv.pathlength_cm,
      baseline: params.baseline,
    });
    buildPeakRows();
  }

  /** Fraction boundary volumes (start and end of every fraction), ascending. */
  function fractionBoundaries() {
    const recs = (ctx.run.frac && ctx.run.frac.records) || [];
    const out = [];
    for (const r of recs) {
      if (Number.isFinite(r.startVolume_mL)) out.push(r.startVolume_mL);
      if (Number.isFinite(r.endVolume_mL)) out.push(r.endVolume_mL);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** Snap a volume to the nearest fraction boundary within 8 grid steps; Alt disables it (§6.30). */
  function snapVolume(V_mL) {
    if (altHeld || !grid) return V_mL;
    const tol = 8 * grid.dV_mL;
    let best = V_mL;
    let bestD = tol;
    for (const b of fractionBoundaries()) {
      const d = Math.abs(b - V_mL);
      if (d <= bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** Apply a pool window given in grid indices; refresh its metrics and the chart overlay. */
  function setPool(i0, i1) {
    if (!grid || grid.n < 2) return;
    let a = clampInt(i0 | 0, 0, grid.n - 1);
    let b = clampInt(i1 | 0, 0, grid.n - 1);
    if (b < a) { const t = a; a = b; b = t; }
    if (b === a) b = Math.min(grid.n - 1, a + 1);
    const metrics = pooling.poolMetrics(ctx.config, ctx.run, grid, a, b, poolMetricsMode);
    pool = { i0: a, i1: b, metrics };
    if (chart) setPoolWindow(chart, volumeToX(grid.V[a]), volumeToX(grid.V[b]));
    renderPool();
    renderOutcome();          // the run summary quotes the pool's yield and purity
  }

  /** Clear the pool selection. */
  function clearPool() {
    pool = null;
    if (chart) setPoolWindow(chart, null, null);
    renderPool();
    renderOutcome();
  }

  /**
   * Recompute the mass balance. `analytics/pooling.js` is L2 and cannot flush the column batch, so
   * this view flushes first — the §3.4 precondition, which `massBalance` reports mechanically as
   * `flushed:false` when it is not met.
   */
  function refreshAudit(force) {
    const t = nowMs();
    if (!force && t - lastAuditMs < AUDIT_MS) return;
    lastAuditMs = t;
    bed.forceFlush(ctx.config, ctx.run, 'MASS_AUDIT');
    audit = pooling.massBalance(ctx.config, ctx.run);
    renderAudit();
  }

  /**
   * Run the §7.6 packing-test analysis for every block whose `BLOCK_END` carries
   * `detail.packingTest === true`, and log one `PACKING_TEST_RESULT` per block (§6.30).
   */
  function refreshPackingTests() {
    const { config, run } = ctx;
    const events = run.events || [];
    const starts = new Map();
    const windows = [];
    for (const e of events) {
      if (e.type === 'BLOCK_START') starts.set(e.blockId, e);
      if (e.type !== 'BLOCK_END' || !e.detail || e.detail.packingTest !== true) continue;
      const s = starts.get(e.blockId);
      windows.push({ blockId: e.blockId, V0: s ? s.V_mL : 0, V1: e.V_mL });
    }
    if (windows.length === 0) { packing = []; return; }
    if (!grid || grid.n < 8) return;

    const out = [];
    for (const w of windows) {
      let best = null;
      for (const p of peakList) {
        if (p.VR_mL < w.V0 || p.VR_mL > w.V1) continue;
        if (!best || p.area_AUcm_mL > best.area_AUcm_mL) best = p;
      }
      if (!best) continue;
      const result = pooling.analysePackingTest(
        config, best, config.column.L_cm, config.skid.holdup.sigmaInjToUV_mL);
      out.push({ blockId: w.blockId, result });
      if (!packingLogged.has(w.blockId)) {
        packingLogged.add(w.blockId);
        logEvent(config, run, {
          type: 'PACKING_TEST_RESULT',
          severity: 'INFO',
          source: 'SYSTEM',
          blockId: w.blockId,
          message: `Packing test ${w.blockId}: ${result.verdict}, ` +
            `${num(result.N_per_m, 0)} plates/m (corrected)`,
          detail: {
            VR_mL: result.VR_mL, W50_mL: result.W50_mL,
            N_apparent: result.N_apparent, N_corrected: result.N_corrected,
            HETP_corrected_cm: result.HETP_corrected_cm,
            sigma_measured_mL: result.sigma_measured_mL,
            sigma_extracolumn_mL: result.sigma_extracolumn_mL,
            As10: result.As10, verdict: result.verdict,
          },
        });
      }
    }
    packing = out;
  }

  /** The whole operator-rate analysis pass. */
  function refreshAnalysis() {
    recomputePeaks();
    if (pool && grid) setPool(pool.i0, pool.i1);
    refreshPackingTests();
    renderPeakTable();
    renderPool();
    renderPacking();
    renderOutcome();
    refreshAnnotations();
    if (dataTableOpen) renderDataTable();
  }

  /* ------------------------------------------------------------ annotations */

  /** Block id -> block type, from the loaded method. */
  function blockTypeMap() {
    const map = new Map();
    const blocks = (ctx.config.method && ctx.config.method.blocks) || [];
    for (const b of blocks) map.set(b.id, b.type);
    return map;
  }

  /** Phase bands from the run's own BLOCK_START/BLOCK_END events, in chart x units. */
  function buildBands() {
    const events = ctx.run.events || [];
    const types = blockTypeMap();
    const open = new Map();
    const bands = [];
    const key = xMode === 'time' ? 't_s' : (xMode === 'cv' ? 'V_CV' : 'V_mL');
    for (const e of events) {
      if (e.type === 'BLOCK_START') {
        open.set(e.blockId, e);
      } else if (e.type === 'BLOCK_END') {
        const s = open.get(e.blockId);
        if (!s) continue;
        open.delete(e.blockId);
        bands.push({
          x0: s[key], x1: e[key], label: e.blockId,
          kind: BAND_KIND[types.get(e.blockId)] || 'neutral',
        });
      }
    }
    const liveX = xMode === 'time' ? ctx.run.t_s
      : (xMode === 'cv' ? ctx.run.V_tot_mL / ctx.config.column.V_mL : ctx.run.V_tot_mL);
    for (const s of open.values()) {
      bands.push({
        x0: s[key], x1: liveX, label: s.blockId,
        kind: BAND_KIND[types.get(s.blockId)] || 'neutral',
      });
    }
    if (hoverPeak >= 0 && hoverPeak < peakRows.length) {
      const r = peakRows[hoverPeak];
      bands.push({
        x0: volumeToX(r.V0), x1: volumeToX(r.V1), label: `P${hoverPeak + 1}`, kind: 'peak',
      });
    }
    return bands;
  }

  /** Peak apex flags plus fraction ticks, in chart x units. */
  function buildMarkers() {
    const markers = [];
    for (let i = 0; i < peakList.length; i++) {
      const p = peakList[i];
      markers.push({
        x: volumeToX(p.VR_mL),
        label: `P${i + 1} · ${num(p.VR_mL, 1)} mL · ${num(AUcmToMAU(p.Amax_AUcm), 0)} mAU`,
        kind: 'flag',
      });
    }
    const recs = (ctx.run.frac && ctx.run.frac.records) || [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const x = xMode === 'time' ? r.startTime_s
        : (xMode === 'cv' ? r.startVolume_mL / ctx.config.column.V_mL : r.startVolume_mL);
      markers.push({ x, label: (i % 5 === 0) ? r.port : '', kind: 'tick' });
    }
    return markers;
  }

  /** Push bands and markers to the chart only when the set actually changed (§6.26). */
  function refreshAnnotations() {
    if (!chart) return;
    const bands = buildBands();
    const markers = buildMarkers();
    const last = bands.length ? bands[bands.length - 1] : null;
    const bandKey = `${xMode}|${bands.length}|${hoverPeak}|${last ? last.x1.toFixed(2) : ''}`;
    const markerKey = `${xMode}|${markers.length}|${peakList.length}`;
    if (bandKey !== lastBandKey) { lastBandKey = bandKey; setBands(chart, bands); }
    if (markerKey !== lastMarkerKey) { lastMarkerKey = markerKey; setMarkers(chart, markers); }
  }

  /* ------------------------------------------------------------ chart panel */

  function buildChartPanel() {
    dom.xModeButtons = {};
    const seg = h('div', { class: 'rv-row', role: 'radiogroup', 'aria-label': 'X axis mode',
      style: 'padding:0;gap:2px' });
    for (const m of X_MODES) {
      const b = h('button', {
        type: 'button', class: 'rv-btn rv-btn--chip', role: 'radio', title: m.title,
        'aria-label': m.title, 'aria-checked': m.id === xMode ? 'true' : 'false',
      }, h('span', {}, m.chip));
      on(b, 'click', () => applyXMode(m.id));
      dom.xModeButtons[m.id] = b;
      seg.appendChild(b);
    }

    dom.poolBtn = iconButton('pool',
      'Pool mode: drag across the chromatogram to select a pool. Hold Alt while dragging to ' +
      'ignore fraction boundaries.', () => setPoolMode(!poolMode), { pressed: false });

    dom.tableBtn = iconButton('table',
      'Accessible table of the chart data, decimated to 1 % of the run', () => {
        dataTableOpen = !dataTableOpen;
        setAttr(dom.tableBtn, 'aria-pressed', dataTableOpen ? 'true' : 'false');
        cls(dom.dataGroup, 'is-closed', !dataTableOpen);
        if (dataTableOpen) renderDataTable();
      }, { pressed: false });

    dom.chartRoot = h('div', {
      class: 'rv-chartroot', role: 'img',
      'aria-label': 'Chromatogram. The data-table button gives the same data as a table.',
    });

    const legend = h('div', { class: 'rv-row', style: 'padding:0;gap:6px' });
    for (const s of SERIES) {
      const pen = h('span', { class: 'rv-pen',
        style: `border-top-color:var(${s.colorVar});`
          + (s.dash.length ? 'border-top-style:dashed;' : '') });
      legend.appendChild(h('span', { class: 'rv-lb', title: `${s.label} (${s.unit || '-'})` },
        pen, s.tag));
    }

    const p = panel('CHROMATOGRAM',
      h('div', { class: 'rv-bar rv-rz' },
        seg,
        h('span', { class: 'rv-sep' }),
        iconButton('fit', 'Fit the whole run on the x axis', fitAll),
        dom.poolBtn,
        dom.tableBtn,
        h('span', { class: 'rv-sep' }),
        iconButton('png', 'Export the chromatogram as a PNG image', doExportPNG),
        iconButton('csvData', 'Export the full 2 Hz data as CSV', () => doExport('data')),
        iconButton('csvPeaks', 'Export the peak table as CSV', () => doExport('peaks')),
        iconButton('csvFrac', 'Export the fraction records as CSV', () => doExport('fractions')),
        iconButton('csvEvents', 'Export the event log as CSV', () => doExport('events')),
        iconButton('json', 'Export the complete run record as JSON', () => doExport('json')),
        h('span', { class: 'rv-sep' }),
        legend),
      dom.chartRoot);
    p.classList.add('rv-panel--chart');
    return p;
  }

  function applyXMode(mode) {
    if (mode === xMode) return;
    const poolV = pool && grid ? [grid.V[pool.i0], grid.V[pool.i1]] : null;
    xMode = mode;
    for (const id of Object.keys(dom.xModeButtons)) {
      setAttr(dom.xModeButtons[id], 'aria-checked', id === mode ? 'true' : 'false');
    }
    if (!chart) return;
    setXMode(chart, mode);
    lastBandKey = '';
    lastMarkerKey = '';
    refreshAnnotations();
    if (poolV) setPoolWindow(chart, volumeToX(poolV[0]), volumeToX(poolV[1]));
    invalidate(chart, 'all');
  }

  function setPoolMode(next) {
    poolMode = next;
    setAttr(dom.poolBtn, 'aria-pressed', poolMode ? 'true' : 'false');
    cls(dom.chartRoot, 'is-pooling', poolMode);
    notify(poolMode ? 'POOL ARM' : 'POOL OFF',
      poolMode
        ? 'Pool mode: drag across the chromatogram. Hold Alt to ignore fraction boundaries.'
        : 'Pool mode off.', 'info');
  }

  function fitAll() {
    if (!chart) return;
    const store = ctx.run.log;
    if (!store || !store.n) { notify('NO DATA', 'Nothing has been logged yet.', 'warn'); return; }
    const x = logColumn(store, xChannel());
    if (!x.length) return;
    setFollow(chart, false);
    winX0 = x[0];
    winX1 = x[x.length - 1];
    setWindow(chart, winX0, winX1);
    invalidate(chart, 'all');
  }

  /* ------------------------------------------------------------ peak panel */

  const PEAK_COLUMNS = [
    { t: '', cls: 'lamp', title: 'Peak quality lamp' },
    { t: '#', title: 'Peak index and quality codes' },
    { t: 'START', cls: 'num', title: 'Window start, mL' },
    { t: 'APEX', cls: 'num', title: 'Apex retention volume, mL' },
    { t: 'END', cls: 'num', title: 'Window end, mL' },
    { t: 'HEIGHT', cls: 'num', title: 'Apex height, mAU' },
    { t: 'AREA', cls: 'num', title: 'Area, mAU·mL' },
    { t: 'AREA %', cls: 'num', title: 'Share of the total integrated area' },
    { t: 'W50', cls: 'num', title: 'Width at half height, mL' },
    { t: 'AS', cls: 'num', title: 'Asymmetry at 10 % height' },
    { t: 'N', cls: 'num', title: 'Plate number from the half-height width' },
    { t: 'HETP', cls: 'num', title: 'Plate height, cm' },
    { t: 'RS', cls: 'num', title: 'Resolution against the previous peak' },
    { t: 'MASS', cls: 'num', title: 'Estimated product mass, mg' },
  ];

  function buildParams() {
    const grp = h('div', { class: 'rv-form' });
    dom.paramInputs = {};

    for (const f of PARAM_FIELDS) {
      const box = entryBox(f.unit, `${f.label} in ${f.unit}`);
      box.input.value = num(params[f.key], f.dec);
      on(box.input, 'change', () => {
        const v = parseFloat(box.input.value);
        if (!Number.isFinite(v) || v < 0) {
          cls(box.el, 'rv-box--bad', true);
          setAttr(box.input, 'aria-invalid', 'true');
          notify('RANGE', `${f.label} must be a non-negative number.`, 'warn');
          return;
        }
        cls(box.el, 'rv-box--bad', false);
        setAttr(box.input, 'aria-invalid', null);
        params[f.key] = v;
        box.input.value = v.toFixed(f.dec);
        lastAnalysisMs = -1e9;
        refreshAnalysis();
      });
      dom.paramInputs[f.key] = box.input;
      grp.appendChild(frow(f.tag, f.label, f.glossary, box.el));
    }

    const sel = h('select', { class: 'rv-sel rv-sk', 'aria-label': 'Integration baseline',
      title: 'Integration baseline' },
    h('option', { value: 'anchored' }, 'ANCHORED'),
    h('option', { value: 'zero' }, 'ZERO'));
    sel.value = params.baseline;
    on(sel, 'change', () => {
      params.baseline = sel.value;
      lastAnalysisMs = -1e9;
      refreshAnalysis();
    });
    grp.appendChild(frow('BASE', 'Integration baseline', null, sel));

    const smooth = labelBox('mL', 'Detection smoothing half width');
    dom.detectNote = smooth.v;
    dom.detectBox = smooth.el;
    grp.appendChild(frow('SMOOTH', 'Detection smoothing half width', null, smooth.el));

    return group('INTEGRATION', true, grp);
  }

  function buildDataTable() {
    dom.dataTableBody = h('tbody', {});
    dom.dataGroup = group('CHART DATA', true,
      h('div', { class: 'rv-tw rv-sk', style: 'max-height:220px' },
        h('table', { class: 'rv-tbl' },
          h('thead', {}, h('tr', {},
            h('th', { class: 'num', scope: 'col', title: 'Volume, mL' }, 'V'),
            h('th', { class: 'num', scope: 'col', title: 'Column volumes' }, 'CV'),
            h('th', { class: 'num', scope: 'col', title: 'Time, s' }, 'T'),
            ...SERIES.map((s) => h('th', { class: 'num', scope: 'col',
              title: `${s.label}${s.unit ? ` (${s.unit})` : ''}` }, s.tag)))),
          dom.dataTableBody)));
    // The group header and the toolbar button drive the same state, so opening the group from its
    // own caret still fills the table.
    const groupHead = dom.dataGroup.firstChild;
    on(groupHead, 'click', () => {
      dataTableOpen = !dom.dataGroup.classList.contains('is-closed');
      setAttr(dom.tableBtn, 'aria-pressed', dataTableOpen ? 'true' : 'false');
      if (dataTableOpen) renderDataTable();
    });
    return dom.dataGroup;
  }

  function buildPeakPanel() {
    dom.peakCount = h('span', { class: 'rv-v' }, '0');
    dom.peakBody = h('tbody', {});
    dom.peakEmpty = h('div', { class: 'rv-empty' }, lamp('off', 'No peaks detected'), 'NO PEAKS');

    const p = panel('PEAKS',
      buildParams(),
      buildDataTable(),
      h('div', { class: 'rv-tw rv-sk rv-scroll' },
        h('table', { class: 'rv-tbl' },
          h('thead', {}, h('tr', {}, ...PEAK_COLUMNS.map((c) => h('th',
            { class: c.cls === 'num' ? 'num' : '', scope: 'col', title: c.title }, c.t)))),
          dom.peakBody)),
      dom.peakEmpty);
    const inf = info('plate-number');
    if (inf) p._hd.appendChild(inf);
    p._hd.appendChild(h('div', { class: 'rv-box rv-sk', style: 'width:58px', role: 'group',
      'aria-label': 'Peak count' }, dom.peakCount, h('span', { class: 'rv-eu' }, 'PK')));
    return p;
  }

  function renderPeakTable() {
    setText(dom.peakCount, String(peakRows.length));
    dom.peakEmpty.hidden = peakRows.length > 0;
    if (dom.detectNote) {
      setText(dom.detectNote, num(detectWidth_mL, 0));
      setAttr(dom.detectBox, 'title', Number.isFinite(detectWidth_mL)
        ? `Detection trace smoothed over ±${num(detectWidth_mL, 0)} mL ` +
          `(${num(detectWidth_mL / ctx.config.column.V_mL, 3)} CV), widened automatically until at ` +
          `most ${params.maxPeaks} apexes cleared the height gate. Every number in the table is ` +
          'measured on the raw trace.'
        : 'No data to integrate yet.');
    }

    reconcileList(dom.peakBody, peakRows, (r) => r.key,
      (r) => {
        const lp = lamp('off', `Peak ${r.i + 1} quality`);
        const tr = h('tr', {
          tabindex: '0', role: 'button', 'aria-label': `Peak ${r.i + 1}, zoom to it`,
          title: `Peak ${r.i + 1} — click to zoom the chart onto it`,
        }, h('td', { class: 'lamp' }, lp));
        for (let c = 1; c < PEAK_COLUMNS.length; c++) {
          tr.appendChild(h('td', PEAK_COLUMNS[c].cls === 'num' ? { class: 'num' } : {}, ''));
        }
        tr._lamp = lp;
        tr.addEventListener('mouseenter', () => { hoverPeak = r.i; refreshAnnotations(); });
        tr.addEventListener('mouseleave', () => { hoverPeak = -1; refreshAnnotations(); });
        tr.addEventListener('focus', () => { hoverPeak = r.i; refreshAnnotations(); });
        tr.addEventListener('blur', () => { hoverPeak = -1; refreshAnnotations(); });
        tr.addEventListener('click', () => zoomToPeak(r.i));
        tr.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); zoomToPeak(r.i); }
        });
        return tr;
      },
      (tr, r) => {
        const p = r.p;
        const c = tr.children;
        setText(c[1], `P${r.i + 1}`);
        const codes = [];
        if (p.flags.INDETERMINATE) codes.push(['IND', 'warn', 'A width could not be measured; ' +
          'everything derived from it is unreliable.']);
        if (p.flags.FLAT_APEX) codes.push(['FLAT', 'warn', 'Flat or saturated apex.']);
        if (p.flags.SUSPECT) codes.push(['SUS', 'warn',
          'Truncated at a window edge, or poorly resolved from its neighbour.']);
        if (r.qualitySuspect) codes.push(['UV?', 'alarm',
          'The UV signal was SUSPECT or INVALID somewhere in this peak window (§5.3).']);
        for (const [code, kind, why] of codes) {
          c[1].appendChild(h('span', { class: 'rv-code', 'data-kind': kind, title: why }, code));
        }
        setAttr(tr._lamp, 'data-s', codes.length === 0 ? 'run'
          : (r.qualitySuspect ? 'alarm' : 'warn'));
        setAttr(tr._lamp, 'title', codes.length === 0 ? 'Integration clean'
          : codes.map((k) => `${k[0]}: ${k[2]}`).join(' · '));
        setText(c[2], num(r.V0, 1));
        setText(c[3], num(p.VR_mL, 2));
        setText(c[4], num(r.V1, 1));
        setText(c[5], num(AUcmToMAU(p.Amax_AUcm), 1));
        setText(c[6], num(AUcmToMAU(p.area_AUcm_mL), 1));
        setText(c[7], num(r.areaPct, 1));
        setText(c[8], num(p.W50_mL, 2));
        setText(c[9], num(p.As10, 2));
        setText(c[10], num(p.Nhalf, 0));
        setText(c[11], num(p.HETP_cm, 4));
        setText(c[12], num(r.rs, 2));
        setText(c[13], num(r.mass_mg, 1));
        cls(tr, 'is-selected', r.i === selectedPeak);
      });
  }

  function zoomToPeak(i) {
    if (!chart || !grid || i < 0 || i >= peakRows.length) return;
    selectedPeak = i;
    const r = peakRows[i];
    const pad = Math.max(2 * (r.p.W50_mL || grid.dV_mL * 8), grid.dV_mL * 16);
    setFollow(chart, false);
    winX0 = volumeToX(r.V0 - pad);
    winX1 = volumeToX(r.V1 + pad);
    setWindow(chart, winX0, winX1);
    invalidate(chart, 'all');
    renderPeakTable();
  }

  /* ------------------------------------------------------------- pool panel */

  function buildPoolPanel() {
    const ports = labelBox('', 'Fraction ports in the pool');
    const vpool = labelBox('mL', 'Pool volume');
    const v0 = labelBox('mL', 'Pool window start');
    const v1 = labelBox('mL', 'Pool window end');
    dom.poolPorts = ports.v;
    dom.poolV = vpool.v;
    dom.poolV0 = v0.v;
    dom.poolV1 = v1.v;
    const head = h('div', { class: 'rv-form' },
      frow('PORTS', 'Fraction ports covered by the pool', null, ports.el),
      frow('V-POOL', 'Pool volume', null, vpool.el),
      frow('V-START', 'Pool window start', null, v0.el),
      frow('V-END', 'Pool window end', null, v1.el));

    const typeSel = h('select', { class: 'rv-sel rv-sk', 'aria-label': 'Auto-pool criterion',
      title: 'Auto-pool criterion' },
    h('option', { value: 'APEX_PCT' }, '% OF APEX'),
    h('option', { value: 'THRESHOLD' }, 'THRESHOLD'),
    h('option', { value: 'PURITY' }, 'PURITY'));
    typeSel.value = autoPoolCriterion.type;
    on(typeSel, 'change', () => { autoPoolCriterion.type = typeSel.value; });

    const valueField = entryBox('', 'Auto-pool criterion value');
    valueField.input.value = String(autoPoolCriterion.value);
    on(valueField.input, 'change', () => {
      const v = parseFloat(valueField.input.value);
      if (Number.isFinite(v)) {
        autoPoolCriterion.value = v;
        cls(valueField.el, 'rv-box--bad', false);
      } else {
        cls(valueField.el, 'rv-box--bad', true);
        notify('RANGE', 'The auto-pool value must be a number.', 'warn');
      }
    });

    const sigSel = h('select', { class: 'rv-sel rv-sk', 'aria-label': 'Auto-pool signal',
      title: 'Auto-pool signal' },
    h('option', { value: 'UV_280' }, 'UV 280'),
    h('option', { value: 'UV_260' }, 'UV 260'),
    h('option', { value: 'COND' }, 'COND'),
    h('option', { value: 'PH' }, 'PH'));
    sigSel.value = autoPoolCriterion.signal;
    on(sigSel, 'change', () => { autoPoolCriterion.signal = sigSel.value; });

    const modeSel = h('select', { class: 'rv-sel rv-sk', 'aria-label': 'Metrics data source',
      title: 'Metrics data source: simulator truth, or the detector trace alone' },
    h('option', { value: 'truth' }, 'TRUTH'),
    h('option', { value: 'detector' }, 'DETECTOR'));
    modeSel.value = poolMetricsMode;
    on(modeSel, 'change', () => {
      poolMetricsMode = modeSel.value;
      if (pool) setPool(pool.i0, pool.i1);
      else renderPool();
    });

    const criteria = h('div', { class: 'rv-form' },
      frow('CRIT', 'Auto-pool criterion', null, typeSel),
      frow('VALUE', 'Auto-pool criterion value', null, valueField.el),
      frow('SIGNAL', 'Auto-pool signal', null, sigSel),
      frow('SOURCE', 'Metrics data source', 'purity', modeSel));

    const tools = h('div', { class: 'rv-bar rv-rz' },
      iconButton('auto', 'Auto-pool with the criterion above', () => {
        if (!grid || grid.n < 4) { notify('NO DATA', 'There is no data to pool yet.', 'warn'); return; }
        const r = pooling.rePool(ctx.config, ctx.run, grid,
          { type: 'CRITERION', criterion: autoPoolCriterion, mode: poolMetricsMode });
        setPool(r.i0, r.i1);
        notify('POOL SET', 'Auto-pool applied.', 'info');
      }),
      iconButton('target', 'Pool the peak selected in the peak table', () => {
        if (selectedPeak < 0 || selectedPeak >= peakList.length) {
          notify('NO PEAK', 'Select a peak in the table first.', 'warn');
          return;
        }
        const p = peakList[selectedPeak];
        setPool(p.iStart, p.iEnd);
      }),
      iconButton('clear', 'Clear the pool selection', clearPool));

    dom.poolMetrics = h('div', { class: 'rv-form' });
    dom.poolValues = {};
    for (const card of POOL_CARDS) {
      const box = labelBox(card.unit, `${card.label}${card.unit ? ` in ${card.unit}` : ''}`, card.truth);
      setAttr(box.el, 'title', card.truth
        ? `${card.label} — simulator ground truth; a single UV trace could not tell you this.`
        : card.label);
      dom.poolValues[card.key] = box.v;
      dom.poolMetrics.appendChild(frow(card.tag, card.label, card.glossary, box.el));
    }

    dom.poolEmpty = h('div', { class: 'rv-empty' }, lamp('off', 'No pool selected'), 'NO POOL');
    dom.status = h('div', { class: 'rv-status rv-sk', role: 'status', 'aria-live': 'polite' }, '');

    const p = panel('POOL', head, criteria, tools, dom.poolEmpty,
      h('div', { class: 'rv-scroll' }, dom.poolMetrics), dom.status);
    const inf = info('pool');
    if (inf) p._hd.appendChild(inf);
    return p;
  }

  function renderPool() {
    const has = !!pool;
    dom.poolEmpty.hidden = has;
    dom.poolMetrics.hidden = !has;
    for (const card of POOL_CARDS) {
      setAttr(dom.poolValues[card.key], 'data-truth',
        card.truth && poolMetricsMode === 'truth' ? '1' : null);
    }
    if (!has) {
      setText(dom.poolPorts, '—');
      setText(dom.poolV, '—');
      setText(dom.poolV0, '—');
      setText(dom.poolV1, '—');
      return;
    }
    const m = pool.metrics;
    const { config } = ctx;
    const V0 = grid.V[pool.i0];
    const V1 = grid.V[pool.i1];
    const recs = (ctx.run.frac && ctx.run.frac.records) || [];
    const inPool = recs.filter((r) => r.endVolume_mL > V0 && r.startVolume_mL < V1);
    const ports = inPool.length
      ? (inPool.length === 1
        ? inPool[0].port
        : `${inPool[0].port}–${inPool[inPool.length - 1].port}`)
      : 'FREE';
    setText(dom.poolPorts, ports);
    setText(dom.poolV, num(m.V_pool_mL, 1));
    setText(dom.poolV0, num(V0, 1));
    setText(dom.poolV1, num(V1, 1));

    const iProd = config.idxById[config.load.productSpeciesId];
    const hasProd = iProd !== undefined && iProd >= 0;
    const values = {
      yield: num(m.yield_frac * 100, 1),
      purityMass: num(m.purityMass_frac * 100, 2),
      purityArea: num(m.purityArea_frac * 100, 2),
      aggregate: num(m.aggregate_frac * 100, 2),
      mass: num(hasProd ? m.mass_mg[iProd] : NaN, 1),
      conc: num(hasProd ? m.meanConc_gL[iProd] : NaN, 3),
      volume: fmtVolume(m.V_pool_mL, config),
      cfactor: num(m.concentrationFactor, 2),
      cond: fmtCond(m.meanCond_mScm),
      ph: fmtPH(m.meanPH),
      productivity: num(m.productivity_gLh, 3),
      buffer: num(m.bufferConsumption_L_per_g, 2),
    };
    for (const card of POOL_CARDS) setText(dom.poolValues[card.key], values[card.key]);
  }

  /* ------------------------------------------------------- audit / packing */

  function buildAuditPanel() {
    dom.auditLamp = lamp('off', 'Mass balance not computed');
    dom.auditState = h('span', { class: 'rv-v' }, '—');
    dom.auditRows = h('div', {});
    dom.packingBody = h('div', {});
    dom.outcomeBody = h('div', { class: 'rv-form' });
    dom.packingEmpty = h('div', { class: 'rv-empty' },
      lamp('off', 'No packing test has run'), 'NO PACKING TEST');
    dom.outcomeEmpty = h('div', { class: 'rv-empty' }, lamp('off', 'No run logged yet'), 'NO RUN');

    // The closure grid is a data grid, so its two numeric columns carry their tag and unit in a
    // header strip — the same contract a label box keeps, paid once for the whole column.
    const auditHead = h('div', { class: 'rv-mb' },
      h('span', {}),
      h('span', { class: 'rv-lb', title: 'Species id' }, 'ID'),
      h('span', { class: 'rv-lb', style: 'text-align:right', title: 'Total presented, µmol' },
        'IN µmol'),
      h('span', { class: 'rv-lb', style: 'text-align:right',
        title: 'xi = (in - out - column - defect) / in, read at the column plane' }, 'XI'));

    const auditPanel = panel('MASS BALANCE',
      h('div', { class: 'rv-scroll' }, auditHead, dom.auditRows));
    auditPanel._hd.appendChild(dom.auditLamp);
    auditPanel._hd.appendChild(h('div', { class: 'rv-box rv-sk', style: 'width:74px', role: 'group',
      'aria-label': 'Mass balance state' }, dom.auditState));
    const inf = info('mass-balance');
    if (inf) auditPanel._hd.appendChild(inf);
    auditPanel._hd.appendChild(iconButton('refresh',
      'Recompute the mass balance; the column batch is flushed first', () => refreshAudit(true)));
    dom.auditPanel = auditPanel;

    const packPanel = panel('PACKING TEST', dom.packingEmpty, dom.packingBody);
    const infoPack = info('packing-test');
    if (infoPack) packPanel._hd.appendChild(infoPack);

    const outPanel = panel('OUTCOME', dom.outcomeEmpty, dom.outcomeBody);

    return h('div', { class: 'rv-group' }, auditPanel, packPanel, outPanel);
  }

  function renderAudit() {
    if (!audit) return;
    const { config } = ctx;
    const rows = [];
    for (let i = 0; i < config.ns; i++) {
      rows.push({
        key: config.species[i].id,
        id: config.species[i].id,
        inU: audit.in_umol[i],
        outU: audit.out_umol[i],
        colU: audit.column_umol[i],
        defU: audit.defect_umol[i],
        poolU: audit.pool_umol[i],
        xi: audit.xi[i],
      });
    }
    reconcileList(dom.auditRows, rows, (r) => r.key,
      () => {
        const lp = lamp('off', 'species closure');
        const el = h('div', { class: 'rv-mb' }, lp, h('span', { class: 'rv-lb' }, ''),
          h('span', { class: 'rv-mb__n' }, ''), h('span', { class: 'rv-mb__n' }, ''));
        el._lamp = lp;
        return el;
      },
      (el, r) => {
        const ok = Number.isFinite(r.xi) && Math.abs(r.xi) < XI_TOL;
        setAttr(el, 'data-ok', ok ? 'true' : 'false');
        setAttr(el._lamp, 'data-s', ok ? 'run' : 'alarm');
        setAttr(el, 'title',
          `${r.id} · in ${num(r.inU, 3)} · out ${num(r.outU, 3)} · column ${num(r.colU, 3)} · ` +
          `defect ${num(r.defU, 6)} · pooled ${num(r.poolU, 3)} µmol · ` +
          `xi = (in - out - column - defect) / in, read at the column plane`);
        setText(el.children[1], r.id);
        setText(el.children[2], num(r.inU, 2));
        setText(el.children[3], Number.isFinite(r.xi) ? r.xi.toExponential(2) : '—');
      });

    const ok = audit.ok === true;
    setText(dom.auditState, !audit.flushed ? 'UNFLUSHED' : (ok ? 'CLOSED' : 'OPEN'));
    setAttr(dom.auditLamp, 'data-s', !audit.flushed ? 'warn' : (ok ? 'run' : 'alarm'));
    setAttr(dom.auditLamp, 'title', audit.flushed
      ? (ok
        ? 'Every species closes to better than 1e-6 relative. ' +
          'xi = (in - out - column - defect) / in, read at the column plane.'
        : 'At least one species is outside 1e-6. The column-plane terms are the audit; the ' +
          'skid-plane totals lead and lag by up to one column batch and are not used here.')
      : 'The column batch was not flushed, so the audit is not valid. Press the refresh button.');
  }

  function renderPacking() {
    while (dom.packingBody.firstChild) dom.packingBody.removeChild(dom.packingBody.firstChild);
    dom.packingEmpty.hidden = packing.length > 0;
    if (packing.length === 0) return;
    for (const entry of packing) {
      const r = entry.result;
      const verdictLamp = lamp(r.verdict === 'GOOD' || r.verdict === 'PASS' ? 'run'
        : (r.verdict === 'FAIL' || r.verdict === 'POOR' ? 'alarm' : 'warn'),
      `${entry.blockId} verdict: ${r.verdict}`);
      const head = h('div', { class: 'rv-row' }, verdictLamp,
        h('span', { class: 'rv-lb', title: `Packing test block ${entry.blockId}` }, entry.blockId),
        h('div', { class: 'rv-box rv-sk', style: 'width:76px', role: 'group',
          'aria-label': `${entry.blockId} verdict` },
        h('span', { class: 'rv-v' }, r.verdict)));
      const gridEl = h('div', { class: 'rv-form' });
      const rows = [
        ['V-R', num(r.VR_mL, 2), 'mL', 'Tracer retention volume'],
        ['W50', num(r.W50_mL, 3), 'mL', 'Width at half height'],
        ['N-APP', num(r.N_apparent, 0), '-', 'Apparent plate number'],
        ['N-COR', num(r.N_corrected, 0), '-', 'Plate number corrected for extra-column dispersion'],
        ['HETP', num(r.HETP_corrected_cm, 4), 'cm', 'Corrected plate height'],
        ['N/M', num(r.N_per_m, 0), '1/m', 'Corrected plates per metre'],
        ['SIG-M', num(r.sigma_measured_mL, 4), 'mL', 'Measured peak sigma'],
        ['SIG-EC', num(r.sigma_extracolumn_mL, 4), 'mL', 'Extra-column sigma'],
        ['AS-10', num(r.As10, 2), '-', 'Asymmetry at 10 % height'],
      ];
      for (const [tag, value, unit, title] of rows) {
        const box = labelBox(unit, title);
        setText(box.v, value);
        gridEl.appendChild(frow(tag, title, null, box.el));
      }
      dom.packingBody.appendChild(h('div', {}, head, gridEl));
    }
  }

  /** The active scenario, from the last SCENARIO_APPLIED event. */
  function activeScenario() {
    const events = ctx.run.events || [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== 'SCENARIO_APPLIED' || !e.detail) continue;
      for (const s of SCENARIOS) if (s.id === e.detail.scenarioId) return s;
    }
    return null;
  }

  function renderOutcome() {
    const { config, run } = ctx;
    const hasRun = !!(run.log && run.log.n);
    dom.outcomeEmpty.hidden = hasRun;
    dom.outcomeBody.hidden = !hasRun;
    if (!hasRun) return;

    const alarms = { WARN: 0, ALARM: 0, CRITICAL: 0, FAULT: 0 };
    for (const e of run.events || []) {
      if (e.type === 'ALARM_RAISED' && alarms[e.severity] !== undefined) alarms[e.severity]++;
    }
    let worstRs = NaN;
    for (let i = 1; i < peakList.length; i++) {
      const rs = peaks.resolution(peakList[i - 1], peakList[i]).Rs_half;
      if (!Number.isFinite(worstRs) || rs < worstRs) worstRs = rs;
    }
    const m = pool ? pool.metrics : null;
    const sc = activeScenario();
    const notes = sc && Array.isArray(sc.teachingNotes) ? sc.teachingNotes.join(' · ') : '';

    // Every number carries an engineering unit, counts included: `PK`, `FR` and `EV` are the EU of
    // a count exactly as `mL` is the EU of a volume. Only the two rows whose value is a NAME —
    // the run state and the scenario id — have no unit, because they are not measurements.
    const rows = [
      ['STATE', String(run.state), '', 'Run state'],
      ['DUR', fmtTime(run.t_s), '', 'Run duration'],
      ['V-TOT', num(run.V_tot_mL, 1), 'mL', 'Total volume delivered'],
      ['CV', num(run.V_tot_mL / config.column.V_mL, 2), 'CV', 'Total volume in column volumes'],
      ['PEAKS', String(peakList.length), 'PK', 'Detected peaks'],
      ['RS-MIN', num(worstRs, 2), '-', 'Worst adjacent-pair resolution'],
      ['FRACS', String((run.frac && run.frac.records && run.frac.records.length) || 0), 'FR',
        'Fractions collected'],
      ['YIELD', m ? num(m.yield_frac * 100, 1) : '—', '%', 'Pool yield'],
      ['PURITY', m ? num(m.purityMass_frac * 100, 2) : '—', '%', 'Pool purity by mass'],
      ['ALM-W', String(alarms.WARN), 'EV', 'WARN alarms raised'],
      ['ALM-A', String(alarms.ALARM), 'EV', 'ALARM alarms raised'],
      ['ALM-C', String(alarms.CRITICAL), 'EV', 'CRITICAL alarms raised'],
      ['ALM-F', String(alarms.FAULT), 'EV', 'FAULT alarms raised'],
      ['SCEN', sc ? sc.id : 'NONE', '', sc
        ? `${sc.name}${sc.expectedOutcome ? ` — ${sc.expectedOutcome}` : ''}` +
          `${notes ? ` · ${notes}` : ''}`
        : 'No scenario is loaded — this is a free run against the loaded method.'],
    ];
    reconcileList(dom.outcomeBody, rows.map((r) => ({ key: r[0], r })), (o) => o.key,
      (o) => {
        const box = labelBox(o.r[2], o.r[3]);
        const row = frow(o.r[0], o.r[3], null, box.el);
        row._v = box.v;
        row._box = box.el;
        return row;
      },
      (row, o) => {
        setText(row._v, o.r[1]);
        setAttr(row._box, 'title', o.r[3]);
      });
  }

  /* -------------------------------------------------------- accessible table */

  function renderDataTable() {
    const store = ctx.run.log;
    const n = store ? store.n : 0;
    if (!n) {
      reconcileList(dom.dataTableBody, [], (r) => r.key, () => h('tr', {}), () => {});
      return;
    }
    const cols = SERIES.map((s) => logColumn(store, s.channel));
    const V = logColumn(store, 'V_mL');
    const CV = logColumn(store, 'V_CV');
    const T = logColumn(store, 't_s');
    const rows = [];
    for (let k = 0; k < DATA_TABLE_ROWS; k++) {
      const i = Math.min(n - 1, Math.round((n - 1) * k / (DATA_TABLE_ROWS - 1)));
      rows.push({
        key: `d${k}`,
        V: V[i], CV: CV[i], t: T[i],
        v: cols.map((c) => (c && c.length > i ? c[i] : NaN)),
      });
    }
    reconcileList(dom.dataTableBody, rows, (r) => r.key,
      () => {
        const tr = h('tr', {});
        for (let c = 0; c < 3 + SERIES.length; c++) tr.appendChild(h('td', { class: 'num' }, ''));
        return tr;
      },
      (tr, r) => {
        const c = tr.children;
        setText(c[0], num(r.V, 1));
        setText(c[1], num(r.CV, 3));
        setText(c[2], num(r.t, 1));
        for (let k = 0; k < SERIES.length; k++) setText(c[3 + k], num(r.v[k], 2));
      });
  }

  /* ---------------------------------------------------------------- exports */

  function runId() {
    const id = String(ctx.config.presetId || 'run').replace(/[^A-Za-z0-9_-]/g, '-');
    return `${id}_${Math.round(ctx.run.t_s)}s`;
  }

  function peaksCSV() {
    const head = ['index', 'start_mL', 'apex_mL', 'end_mL', 'height_mAU', 'area_mAU_mL',
      'area_pct', 'W50_mL', 'W10_mL', 'As10', 'Tf', 'N_half', 'N_moment', 'HETP_cm',
      'sigma_mL', 'skew', 'Rs_prev', 'est_mass_mg', 'flags'];
    const lines = [head.join(',')];
    const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
    for (const r of peakRows) {
      const p = r.p;
      const flags = Object.keys(p.flags).filter((k) => p.flags[k])
        .concat(r.qualitySuspect ? ['UV_QUALITY'] : []).join(';');
      lines.push([
        r.i + 1, fx(r.V0, 2), fx(p.VR_mL, 3), fx(r.V1, 2),
        fx(AUcmToMAU(p.Amax_AUcm), 2), fx(AUcmToMAU(p.area_AUcm_mL), 3), fx(r.areaPct, 2),
        fx(p.W50_mL, 3), fx(p.W10_mL, 3), fx(p.As10, 3), fx(p.Tf, 3),
        fx(p.Nhalf, 0), fx(p.Nmoment, 0), fx(p.HETP_cm, 5),
        fx(p.sigma_mL, 4), fx(p.skew, 3), fx(r.rs, 3), fx(r.mass_mg, 3),
        `"${flags}"`,
      ].join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  function doExport(kind) {
    const { config, run } = ctx;
    try {
      if (kind === 'data') {
        downloadText(`${runId()}_data.csv`, exportDataCSV(config, run), 'text/csv;charset=utf-8');
      } else if (kind === 'events') {
        downloadText(`${runId()}_events.csv`, exportEventsCSV(config, run), 'text/csv;charset=utf-8');
      } else if (kind === 'fractions') {
        downloadText(`${runId()}_fractions.csv`, exportFractionsCSV(config, run),
          'text/csv;charset=utf-8');
      } else if (kind === 'peaks') {
        downloadText(`${runId()}_peaks.csv`, peaksCSV(), 'text/csv;charset=utf-8');
      } else if (kind === 'json') {
        refreshAudit(true);
        const obj = exportRunJSON(config, run, {
          peaks: peakList,
          pool: pool ? pool.metrics : null,
          massBalance: audit,
          packingTest: packing.length ? packing[0].result : null,
        });
        downloadText(`${runId()}.json`, JSON.stringify(obj, null, 2), 'application/json');
      }
      notify('EXPORT OK', `Exported ${kind}.`, 'info');
    } catch (err) {
      notify('EXPORT ERR', `Export failed: ${(err && err.message) || String(err)}`, 'warn');
    }
  }

  function doExportPNG() {
    if (!chart) return;
    const { config } = ctx;
    const footer = `${config.name} · ${config.scale} · ${config.column.id_cm} × ` +
      `${config.column.L_cm} cm · seed ${config.seed}`;
    let promise = null;
    try {
      promise = exportPNG(chart, {
        width: 1600, height: 900, theme: 'light',
        title: (config.method && config.method.name) ? config.method.name : 'Chromatogram',
        footer,
      });
    } catch (err) {
      notify('EXPORT ERR', `PNG export failed: ${(err && err.message) || String(err)}`, 'warn');
      return;
    }
    Promise.resolve(promise).then((blob) => {
      if (!blob) throw new Error('the chart returned no image');
      downloadBlob(`${runId()}_chromatogram.png`, blob);
      notify('EXPORT OK', 'Chromatogram exported as PNG.', 'info');
    }).catch((err) => {
      notify('EXPORT ERR', `PNG export failed: ${(err && err.message) || String(err)}`, 'warn');
    });
  }

  /* ------------------------------------------------------------------ chart */

  function applyPoolFromX(x0, x1) {
    if (!grid || grid.n < 2) return;
    const t = nowMs();
    if (t - lastPoolMs < POOL_MS) {
      poolPending = [x0, x1];
      if (!poolTimer) {
        poolTimer = setTimeout(() => {
          poolTimer = 0;
          const p = poolPending;
          poolPending = null;
          if (p) applyPoolFromX(p[0], p[1]);
        }, POOL_MS);
      }
      return;
    }
    lastPoolMs = t;
    const V0 = snapVolume(xToVolume(Math.min(x0, x1)));
    const V1 = snapVolume(xToVolume(Math.max(x0, x1)));
    setPool(gridIndexOf(V0), gridIndexOf(V1));
  }

  function buildChart() {
    chart = createChart(dom.chartRoot, {
      xAxis: { mode: xMode },
      yAxes: Y_AXES.map((a) => Object.assign({}, a)),
      series: SERIES.map((s) => ({
        id: s.id, yAxis: s.yAxis, colorVar: s.colorVar, dash: s.dash.slice(),
        width: s.width, visible: s.visible, label: s.label,
      })),
      overview: true,
    });
    for (const s of SERIES) {
      setSeriesChannel(chart, s.id, s.channel);
      setSeriesVisible(chart, s.id, s.visible);
    }
    if (ctx.run.log) setSource(chart, ctx.run.log, { volume: 'V_mL', time: 't_s', cv: 'V_CV' });
    attachInteractions(chart, {
      onZoom: (a) => {
        const p = xPair(a, undefined);
        if (p) { winX0 = p.x0; winX1 = p.x1; }
        setFollow(chart, false);
        refreshAnnotations();
      },
      onCursor: () => {},
      // A plain drag is the chart's own x-zoom select; in pool mode it is how the FIRST pool
      // window is created, because the chart only enters its pool-drag mode on an existing
      // handle. The chart applies the zoom right after this callback, so the pre-drag window is
      // restored on the next task — otherwise selecting a pool would silently zoom the trace.
      onSelect: (a) => {
        if (!poolMode) return;
        const p = xPair(a, undefined);
        if (!p) return;
        applyPoolFromX(p.x0, p.x1);
        const w = dragWin;
        if (!w) return;
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          restoreTimer = 0;
          setWindow(chart, w[0], w[1]);
          invalidate(chart, 'all');
        }, 0);
      },
      onPoolDrag: (a) => {
        const p = xPair(a, undefined);
        if (p) applyPoolFromX(p.x0, p.x1);
      },
    });
  }

  /* ------------------------------------------------------------ build tree */

  const el = h('div', { class: 'rv-root' });
  const chartPanel = buildChartPanel();
  const peakPanel = buildPeakPanel();
  const poolPanel = buildPoolPanel();
  const auditPanel = buildAuditPanel();

  el.appendChild(chartPanel);
  el.appendChild(h('div', { class: 'rv-lower' }, peakPanel, poolPanel, auditPanel));

  /* --------------------------------------------------------------- lifecycle */

  /** Drop every cached reference to the replaced run and rebuild from the new one. */
  function rebind() {
    lastLogN = -1;
    lastAnalysisMs = -1e9;
    lastBandKey = '';
    lastMarkerKey = '';
    grid = null;
    peakList = [];
    peakRows = [];
    pool = null;
    audit = null;
    packing = [];
    packingLogged.clear();
    selectedPeak = -1;
    hoverPeak = -1;
    setText(dom.auditState, '—');
    setAttr(dom.auditLamp, 'data-s', 'off');
    if (chart) {
      setPoolWindow(chart, null, null);
      if (ctx.run.log) setSource(chart, ctx.run.log, { volume: 'V_mL', time: 't_s', cv: 'V_CV' });
      invalidate(chart, 'all');
    }
    refreshAnalysis();
  }

  function mount() {
    if (mounted) return;
    // `styles/app.css` styles the tab host as `.view` and carries a `.view--results` modifier for
    // this view's scrolling; `ui/app.js` builds the host generically, so the modifier is applied
    // here, by the view that owns the content.
    if (rootEl.classList) rootEl.classList.add('view--results');
    rootEl.appendChild(el);
    mounted = true;
    try {
      overlayHost = overlayHostFor(ctx);
    } catch (err) {
      overlayHost = null;   // popovers and toasts degrade to the inline status strip
    }
    buildChart();

    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) visible = e.isIntersecting;
      }, { root: null, threshold: 0 });
      observer.observe(el);
    }

    on(window, 'keydown', (ev) => { if (ev.key === 'Alt') altHeld = true; });
    on(window, 'keyup', (ev) => { if (ev.key === 'Alt') altHeld = false; });
    on(dom.chartRoot, 'pointerdown', (ev) => {
      altHeld = ev.altKey === true;
      dragWin = (Number.isFinite(winX0) && Number.isFinite(winX1)) ? [winX0, winX1] : null;
    });
    on(dom.chartRoot, 'pointermove', (ev) => { if (ev.buttons) altHeld = ev.altKey === true; });

    subscribe('config-replaced', rebind);
    subscribe('preset-loaded', rebind);
    subscribe('run-reset', rebind);
    subscribe('scenario-applied', renderOutcome);
    subscribe('run-ended', () => {
      lastAnalysisMs = -1e9;
      refreshAnalysis();
      refreshAudit(true);
      fitAll();
    });

    refreshAnalysis();
  }

  function update(frameInfo) {
    if (!mounted || !visible) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    if (chart) chartFrame(chart, frameInfo.now_ms);

    const store = ctx.run.log;
    const n = store ? store.n : 0;
    if (n !== lastLogN && frameInfo.now_ms - lastAnalysisMs >= ANALYSIS_MS) {
      lastLogN = n;
      lastAnalysisMs = frameInfo.now_ms;
      refreshAnalysis();
    } else if (frameInfo.structural === true) {
      renderPeakTable();
      renderOutcome();
      refreshAnnotations();
    }
  }

  function destroy() {
    for (const [name, fn] of busHandlers) {
      if (ctx.bus && typeof ctx.bus.off === 'function') ctx.bus.off(name, fn);
    }
    busHandlers.length = 0;
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
    if (poolTimer) { clearTimeout(poolTimer); poolTimer = 0; }
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0; }
    if (observer) { observer.disconnect(); observer = null; }
    if (openPopover) {
      try { dismiss(openPopover); } catch (err) { /* the host may already be gone */ }
      openPopover = null;
    }
    if (chart) { destroyChart(chart); chart = null; }
    if (rootEl.classList) rootEl.classList.remove('view--results');
    if (el.parentNode) el.parentNode.removeChild(el);
    mounted = false;
  }

  return { el, mount, update, destroy };
}
