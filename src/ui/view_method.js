/**
 * @file src/ui/view_method.js — the Method tab (architecture-v2 §6.29, §9.1.1, spec-ux §6).
 *
 * The method editor: a reorderable block list, an inline block editor with unit suffixes, a live
 * gradient / flow / fraction preview strip, the validation rail (both `skid/method.js::validateMethod`
 * issues and the `sim.validateAndReady` PRC failures), the `METHOD_TEMPLATES` picker and JSON
 * import / export.
 *
 * THE EDITING MODEL, and the one rule that matters (§2.4, §6.24):
 *   `config` is frozen and the UI writes NOTHING. This view keeps a private, mutable **draft** —
 *   a plain deep clone of `ctx.config.method` — edits the draft, validates it with the pure
 *   `skid/method.js` functions, and installs it with `ctx.sim.loadMethod(ctx, draft)`. There is no
 *   other write path. `loadMethod` goes through the §2.4 rebuild protocol, which emits
 *   `config-replaced`; this view rebinds on that event and re-derives the draft from the new config.
 *
 * RENDERING (§6.24, §0): `update(frameInfo)` is called at most once per rAF frame by `ui/app.js`
 * and this module never starts a loop of its own. Recomputation (normalise → validate → plan) and
 * the 300×160 preview repaint are coalesced behind a 60 ms debounce that is *serviced inside*
 * `update`, so a hidden tab costs nothing and there is never a second timer painting to the canvas.
 * No `innerHTML` after mount; no layout reads inside `update` (the canvas box is cached by a
 * `ResizeObserver`).
 *
 * Reaches the mutation surface through `ctx.sim` only — this module deliberately does not import
 * `core/sim.js` (§2.4: "`sim` and `fmt` are on `ctx` so a panel never has to import the mutation
 * surface").
 *
 * Layer: `ui-panels`. Imports `ui/format.js`, `ui/overlay.js`, `skid/method.js`, `data/presets.js`,
 * `data/glossary.js`, `io/export.js`.
 */

import { setText, setAttr, cls, reconcileList, fmtVolume, fmtFlow, fmtTime, fmtCV,
  linkedFlowGroup } from './format.js';
import { createOverlayHost, showPopover, showGlossaryPopover, showModal, showToast, dismiss,
  reportResult } from './overlay.js';
import { BLOCK_TYPES, blockVolume_mL, blockFlow_mLs, targetPctB, blockPressureEstimate_bar,
  normalizeMethod, validateMethod, methodDemand } from '../skid/method.js';
import { METHOD_TEMPLATES } from '../data/presets.js';
import { glossaryFor } from '../data/glossary.js';
import { exportMethodJSON, importMethodJSON, downloadText } from '../io/export.js';

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 1. STATIC TABLES
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Per-block-type presentation: a two-letter chip code, the display label, the colour token used for
 * the 4 px left bar and the preview ribbon, and the one-line hint shown under the type selector.
 * Keys are exactly the twelve `BLOCK_TYPES` of §5.4.3, in that order.
 */
const TYPE_META = {
  EQUILIBRATION:      { code: 'EQ', label: 'Equilibration',      token: '--svc-a',       fallback: '#2D6FB8' },
  LOAD:               { code: 'LD', label: 'Sample load',        token: '--svc-sample',  fallback: '#C8862B' },
  WASH:               { code: 'WS', label: 'Wash',               token: '--pen-flow',    fallback: '#00E5FF' },
  ELUTION_ISOCRATIC:  { code: 'EI', label: 'Isocratic elution',  token: '--svc-b',       fallback: '#8A5BC8' },
  ELUTION_LINEAR:     { code: 'EL', label: 'Linear gradient',    token: '--svc-b',       fallback: '#8A5BC8' },
  ELUTION_STEP:       { code: 'ES', label: 'Step elution',       token: '--svc-b',       fallback: '#8A5BC8' },
  STRIP:              { code: 'ST', label: 'Strip',              token: '--pen-cond',    fallback: '#FF9A3C' },
  CIP:                { code: 'CI', label: 'CIP',                token: '--svc-cip',     fallback: '#1FA98C' },
  RE_EQUILIBRATION:   { code: 'RE', label: 'Re-equilibration',   token: '--svc-product', fallback: '#16C60C' },
  HOLD:               { code: 'HD', label: 'Hold',               token: '--lamp-warn',   fallback: '#FFC000' },
  COLUMN_BYPASS:      { code: 'BP', label: 'Column bypass',      token: '--svc-waste',   fallback: '#6B6B6B' },
  PACKING_TEST:       { code: 'PT', label: 'Packing test',       token: '--pen-ph',      fallback: '#B39DFF' },
};

/** `duration.basis` options (§5.4.2). */
const DURATION_BASES = ['CV', 'mL', 'min', 'CV_OF_SAMPLE'];
/** `duration.onTimeout` options (§5.4.4c rule 9). */
const ON_TIMEOUT = ['NEXT', 'HOLD', 'ALARM', 'REPEAT'];
/** `flow.mode` options (§5.4.2). */
const FLOW_MODES = ['CM_H', 'ML_MIN', 'RESIDENCE_TIME_MIN', 'CV_PER_H', 'INHERIT'];
/** The unit suffix each flow mode carries in the editor. */
const FLOW_MODE_UNIT = { CM_H: 'cm/h', ML_MIN: 'mL/min', RESIDENCE_TIME_MIN: 'min', CV_PER_H: 'CV/h', INHERIT: '' };
/** The `<option>` face for each flow mode: the unit it is entered in, never a description. */
const FLOW_MODE_OPTION = { CM_H: 'cm/h', ML_MIN: 'mL/min', RESIDENCE_TIME_MIN: 'RT min',
  CV_PER_H: 'CV/h', INHERIT: 'INHERIT' };
/** What each flow mode means. Tooltip only (§9.6 — explanation never renders on the screen). */
const FLOW_MODE_HINT = {
  CM_H: 'Linear velocity through the bed.',
  ML_MIN: 'Volumetric flow.',
  RESIDENCE_TIME_MIN: 'Residence time — one column volume per this many minutes.',
  CV_PER_H: 'Column volumes swept per hour.',
  INHERIT: 'Takes the flow of the previous enabled block.',
};
/** `gradient.shape` options (§5.4.2). */
const GRADIENT_SHAPES = ['ISOCRATIC', 'LINEAR', 'STEP', 'CONVEX', 'CONCAVE', 'MULTI_SEGMENT'];
/** `columnValve` positions (§5.4.2). */
const COLUMN_VALVES = ['DOWN', 'UP', 'BYPASS', 'ISOLATED', 'CIP_DETECTOR_BYPASS'];
/** `sample.mode` options (§5.4.2); `null` renders as "none". */
const SAMPLE_MODES = [null, 'DIRECT', 'LOOP_FILL', 'LOOP_INJECT'];
/** `fractionation.mode` options (§5.4.5). */
const FRAC_MODES = ['OFF', 'FIXED_VOLUME', 'FIXED_TIME', 'PEAK'];
/** Start-threshold types (§5.4.5). */
const START_TYPES = ['ABSOLUTE', 'SLOPE', 'BOTH', 'EITHER'];
/** Stop-threshold types — `PCT_OF_PEAK_MAX` is stop-only (§5.4.5). */
const STOP_TYPES = ['ABSOLUTE', 'SLOPE', 'BOTH', 'EITHER', 'PCT_OF_PEAK_MAX'];
/** `delayCompensation` options (§5.4.5). */
const DELAY_COMP = ['COMPENSATED', 'UNCOMPENSATED', 'FIXED_TIME'];
/** `deadLegPolicy` options (§5.4.5). */
const DEAD_LEG = ['REPORT', 'DIVERT', 'IGNORE'];
/** Volume-span bases used by `fixedVolume` / `minFractionVolume` / `maxFractionVolume` / `arm`. */
const SPAN_BASES = ['CV', 'mL', 'min'];
/** Watch operators, §5.4.4a. */
const WATCH_OPERATORS = ['RISES_ABOVE', 'FALLS_BELOW', 'ABOVE', 'BELOW', 'SLOPE_ABOVE', 'SLOPE_BELOW',
  'ABS_SLOPE_BELOW', 'STABLE', 'REACHES', 'CHANGES_BY', 'PLATEAU'];
/** The operators whose threshold is a SLOPE, i.e. per mL (§5.2, §5.4.4c rule 6). */
const SLOPE_OPERATORS = ['SLOPE_ABOVE', 'SLOPE_BELOW', 'ABS_SLOPE_BELOW'];
/** The operators that read `slopeWindow` (§5.4.4c rules 6–7). */
const WINDOW_OPERATORS = ['SLOPE_ABOVE', 'SLOPE_BELOW', 'ABS_SLOPE_BELOW', 'STABLE', 'PLATEAU'];
/** Watch actions, §5.4.4b. Terminal actions end evaluation for the tick. */
const WATCH_ACTIONS = ['END_BLOCK', 'GOTO_BLOCK', 'HOLD', 'PAUSE', 'RAISE_ALARM', 'MARK',
  'START_FRACTIONATION', 'STOP_FRACTIONATION', 'SET_PCTB', 'SET_FLOW', 'OUTLET_TO', 'EXTEND_BLOCK'];
/** The five terminal actions (§5.4.4b), badged in the watch editor. */
const TERMINAL_ACTIONS = ['END_BLOCK', 'GOTO_BLOCK', 'HOLD', 'PAUSE', 'RAISE_ALARM'];

/**
 * The twenty-one fixed `sensorSignal` names of §5.2. `TANK_LEVEL:<id>` is the twenty-second and is
 * appended per tank at render time, because the id set comes from `config.tanks`.
 */
const FIXED_SIGNALS = ['UV_280', 'UV_260', 'UV_300', 'UV_RATIO_260_280', 'COND', 'COND_TEMP_COMP',
  'COND_RAW', 'PH', 'P1', 'P2', 'DP', 'FLOW', 'VOLUME_BLOCK', 'VOLUME_RUN', 'TIME_BLOCK', 'TIME_RUN',
  'PCTB', 'AIR', 'LOAD_PROGRESS_PCT', 'TEMP_FLUID', 'TEMP_CELL'];

/**
 * Display units offered per signal family. The FIRST entry is the editor's preferred unit; the
 * canonical unit of §5.2 is always in the list so a value can be shown exactly as stored.
 * `level` are the units for a level threshold, `slope` those for a slope threshold (always per mL).
 */
const SIGNAL_UNITS = {
  UV:     { level: ['mAU', 'AU', 'AU/cm'],  slope: ['mAU/CV', 'mAU/mL', 'AU/cm/mL'] },
  RATIO:  { level: ['-'],                   slope: ['-'] },
  COND:   { level: ['mS/cm'],               slope: ['mS/cm/CV', 'mS/cm/mL'] },
  PH:     { level: ['pH'],                  slope: ['-'] },
  PRESS:  { level: ['bar'],                 slope: ['bar/min'] },
  FLOW:   { level: ['mL/min', 'cm/h', 'mL/s'], slope: ['-'] },
  VOLUME: { level: ['CV', 'mL'],            slope: ['-'] },
  TIME:   { level: ['min', 's'],            slope: ['-'] },
  PCT:    { level: ['%'],                   slope: ['-'] },
  FRAC:   { level: ['-'],                   slope: ['-'] },
  TEMP:   { level: ['°C'],             slope: ['-'] },
  TANK:   { level: ['mL'],                  slope: ['-'] },
};

/**
 * Map a §5.2 signal name onto its {@link SIGNAL_UNITS} family.
 * @param {string} name a §5.2 signal name, e.g. `'UV_280'` or `'TANK_LEVEL:TK-EQ'`
 * @returns {string} the family key
 */
function signalFamily(name) {
  const s = String(name || '');
  if (s === 'UV_RATIO_260_280') return 'RATIO';
  if (s.lastIndexOf('UV_', 0) === 0) return 'UV';
  if (s.lastIndexOf('COND', 0) === 0) return 'COND';
  if (s === 'PH') return 'PH';
  if (s === 'P1' || s === 'P2' || s === 'DP') return 'PRESS';
  if (s === 'FLOW') return 'FLOW';
  if (s.lastIndexOf('VOLUME_', 0) === 0) return 'VOLUME';
  if (s.lastIndexOf('TIME_', 0) === 0) return 'TIME';
  if (s === 'PCTB' || s === 'LOAD_PROGRESS_PCT') return 'PCT';
  if (s === 'AIR') return 'FRAC';
  if (s.lastIndexOf('TEMP_', 0) === 0) return 'TEMP';
  if (s.lastIndexOf('TANK_LEVEL', 0) === 0) return 'TANK';
  return 'FRAC';
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 2. THE §5.2 UNIT TABLE, BOTH WAYS
 *
 * `skid/method.js` converts authored → canonical at ingest with a private table. The editor needs
 * the SAME table in both directions so it can show a stored canonical number in the unit it was
 * authored in and write the user's edit back as an `authoredAs` pair. The two directions are exact
 * reciprocals of each other, so a round trip through the editor cannot move a pool cut (§5.2).
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The multiplicative factor `canonical = authored * factor` for one §5.2 unit string.
 *
 * @param {object} config frozen config; reads `skid.uv.pathlength_cm`, `column.V_mL`, `column.A_cm2`
 * @param {string|null} unit a §5.2 unit string, or null/unknown for "already canonical"
 * @returns {number} the factor, always finite and non-zero
 */
function unitFactor(config, unit) {
  const path_cm = config.skid.uv.pathlength_cm;
  const V_mL = config.column.V_mL;
  const A_cm2 = config.column.A_cm2;
  switch (unit) {
    case 'mAU': return 1 / 1000 / path_cm;
    case 'AU': return 1 / path_cm;
    case 'mL/min': return 1 / 60;
    case 'cm/h': return A_cm2 / 3600;
    case 'CV': return V_mL;
    case 'min': return 60;
    case 'mAU/CV': return 1 / 1000 / path_cm / V_mL;
    case 'mAU/mL': return 1 / 1000 / path_cm;
    case 'mS/cm/CV': return 1 / V_mL;
    case 'bar/min': return 1 / 60;
    default: return 1;   // identity rows of §5.2 plus the null "already canonical" case
  }
}

/**
 * Authored magnitude → canonical value (§5.2). Mirrors `skid/method.js::convertUnit` exactly.
 *
 * @param {object} config frozen config
 * @param {number} value authored magnitude, expressed in `unit`
 * @param {string|null} unit a §5.2 unit string
 * @returns {number} the canonical value (AU/cm, mS/cm, bar, mL/s, mL, s, or the same per mL)
 */
export function toCanonical(config, value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return value * unitFactor(config, unit);
}

/**
 * Canonical value → the magnitude an operator would type in `unit`. The exact inverse of
 * {@link toCanonical}, so `fromCanonical(c, toCanonical(c, x, u), u) === x` to float precision.
 *
 * @param {object} config frozen config
 * @param {number} canonical the stored canonical value
 * @param {string|null} unit a §5.2 unit string
 * @returns {number} the magnitude in `unit`
 */
export function fromCanonical(config, canonical, unit) {
  if (typeof canonical !== 'number' || !Number.isFinite(canonical)) return canonical;
  return canonical / unitFactor(config, unit);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 3. SMALL PURE HELPERS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** @param {*} x any JSON-safe value @returns {*} a structural deep copy (no typed arrays here) */
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

/**
 * @param {number} x value @param {number} d decimal places
 * @returns {string} `x` at a FIXED decimal count so digits never change width (§9.4.2); `'—'` for
 *   a non-finite value, because a blank cell reads as "zero" and an em dash reads as "not evaluable"
 */
function nf(x, d) {
  return (typeof x === 'number' && Number.isFinite(x)) ? x.toFixed(d) : '—';
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} `x` clamped to [lo,hi] */
function clampN(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * Choose a sensible decimal count for a magnitude, so a 0.0006 slope and a 1500 mL volume are both
 * legible in the same numfield component.
 * @param {number} x the magnitude about to be displayed
 * @returns {number} decimals, 0..6
 */
function autoDecimals(x) {
  const a = Math.abs(x);
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 1000) return 1;
  if (a >= 10) return 2;
  if (a >= 0.1) return 3;
  if (a >= 0.001) return 5;
  return 6;
}

/**
 * Does an editor field path fall under a `validateMethod` issue's `field`? An issue on `'gradient'`
 * covers `'gradient.startPctB'` and `'gradient.endPctB'`; an issue on `'duration.value'` covers only
 * itself.
 * @param {string} fieldPath the editor field's path
 * @param {string|null} issueField the issue's `field`
 * @returns {boolean} true when the issue should mark this field invalid
 */
function fieldMatches(fieldPath, issueField) {
  if (!fieldPath || !issueField) return false;
  return fieldPath === issueField || fieldPath.lastIndexOf(issueField + '.', 0) === 0;
}

/**
 * A fresh, unique block id of the form `B07`, never colliding with an id already in the method.
 * @param {Array<object>} blocks the draft's block array
 * @returns {string} the new id
 */
function nextBlockId(blocks) {
  const used = new Set(blocks.map((b) => b.id));
  for (let n = 1; n < 1000; n++) {
    const id = 'B' + String(n).padStart(2, '0');
    if (!used.has(id)) return id;
  }
  return 'B' + Date.now().toString(36);
}

/**
 * A brand-new block of `type`, in the §5.4.2 shape with every field present. `normalizeMethod`
 * fills defaults anyway, but authoring the whole shape here means the editor never has to render a
 * field that does not exist yet.
 *
 * @param {object} config frozen config, for the inlet ids and the fraction port count
 * @param {string} type one of `BLOCK_TYPES`
 * @param {string} id the block id
 * @returns {object} a complete, unnormalised block
 */
function makeBlock(config, type, id) {
  const isElution = type.lastIndexOf('ELUTION', 0) === 0;
  const ports = (config.skid.fracValve && config.skid.fracValve.ports) || [];
  return {
    id,
    name: TYPE_META[type] ? TYPE_META[type].label : type,
    type,
    enabled: true,
    duration: { basis: 'CV', value: type === 'HOLD' ? 0 : 5, onTimeout: 'NEXT', repeatLimit: 0 },
    flow: { mode: 'CM_H', value: 150, rampOverride_mLs2: null },
    inlets: { a: 'A1', b: 'B1', sample: type === 'LOAD' || type === 'PACKING_TEST' ? 'S1' : null },
    gradient: {
      startPctB: type === 'STRIP' ? 100 : 0,
      endPctB: type === 'ELUTION_LINEAR' ? 100 : (type === 'STRIP' ? 100 : 0),
      shape: type === 'ELUTION_LINEAR' ? 'LINEAR' : (type === 'ELUTION_STEP' ? 'STEP' : 'ISOCRATIC'),
      curvature: 0, segments: null, lengthFraction: 1,
    },
    columnValve: type === 'COLUMN_BYPASS' ? 'BYPASS' : 'DOWN',
    outletDefault: 'WASTE',
    sample: {
      mode: type === 'LOAD' ? 'DIRECT' : (type === 'PACKING_TEST' ? 'LOOP_INJECT' : null),
      loopVolume_mL: type === 'PACKING_TEST' ? 10 : null,
      sampleFlow: null,
      chaseVolume_CV: 0,
    },
    fractionation: {
      mode: 'OFF', signal: 'UV_280',
      startThreshold: { type: 'ABSOLUTE', value: 2, slopeValue: 0, pctOfMax: 0,
        authoredAs: { value: 40, unit: 'mAU', slopeValue: 0, slopeUnit: 'mAU/CV', pctOfMax: 0 } },
      stopThreshold: { type: 'ABSOLUTE', value: 2, slopeValue: 0, pctOfMax: 10,
        authoredAs: { value: 40, unit: 'mAU', slopeValue: 0, slopeUnit: 'mAU/CV', pctOfMax: 10 } },
      fixedVolume: { basis: 'CV', value: 0.10 },
      minFractionVolume: { basis: 'CV', value: 0.05 },
      maxFractionVolume: { basis: 'CV', value: 0.25 },
      slopeWindow: { basis: 'CV', value: 0.05 },
      peakMaxDetection: true, peakMaxProminence: 1.5,
      firstPort: ports[0] || 'F1', portCount: ports.length || 12, overflowTo: 'WASTE',
      delayCompensation: 'COMPENSATED', deadLegPolicy: 'REPORT', persistence_ticks: 5,
    },
    autozero: isElution && type === 'ELUTION_LINEAR',
    holdAtEnd: false,
    watches: [],
    notes: '',
  };
}

/**
 * A brand-new watch in the §5.4.4 shape.
 * @param {number} index position in the block's watch array, used for the default id
 * @returns {object} a complete, unnormalised watch
 */
function makeWatch(index) {
  return {
    id: 'W' + String(index + 1).padStart(2, '0'),
    signal: 'UV_280',
    operator: 'FALLS_BELOW',
    threshold: 2.5,
    authoredAs: { value: 50, unit: 'mAU' },
    slopeWindow: { basis: 'CV', value: 0.05 },
    stableTolerance: 0,
    arm: { basis: 'CV', value: 0.5 },
    persistence_ticks: 5,
    action: 'END_BLOCK',
    actionParam: null,
    actionParamUnit: null,
    oneShot: true,
    useDelayCompensated: false,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 4. THE VIEW'S OWN STYLESHEET
 *
 * `styles/app.css` owns the shell and the shared component styles. This view is composed of
 * method-editor-specific surfaces (the block row, the reorder insertion line, the preview strip,
 * the validation rail, the template cards) that have no shared class, so it ships its own scoped
 * sheet under the `.vm-` prefix, injected once per document and reference-counted so `destroy()` on
 * the last instance removes it. EVERY value comes from `styles/tokens.css`, with the §9.4.1 hex as
 * a `var()` fallback, so both themes, `prefers-contrast: more` and `prefers-reduced-motion` are
 * inherited rather than re-authored. Nothing here selects outside `.vm-root`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const STYLE_ID = 'vm-view-method-styles';
let styleRefCount = 0;

const STYLE_TEXT = `
.vm-root{
  --screen:#6E6E6E;--face:#C7C3BC;--face-2:#BFBBB4;--face-3:#D2CEC7;
  --bev-hi:#FFFFFF;--bev-lt:#E6E2DA;--bev-sh:#85817B;--bev-dk:#4A4744;
  --ink:#101010;--ink-2:#3A3A3A;--ink-off:#7A7A7A;
  --fld-bg:#0A0F0A;--fld-pv:#12FF4B;--fld-sp:#FFD400;--fld-out:#00E5FF;--fld-alarm:#FF3B30;
  --fld-stale:#7A8A7A;--fld-eu:#9FB39F;
  --lamp-off:#4A4744;--lamp-run:#16C60C;--lamp-warn:#FFC000;--lamp-alarm:#E81123;
  --plot-bg:#000000;--plot-grid:#1F3D1F;--plot-axis:#C7C3BC;
  --pen-flow:#00E5FF;--pen-pctb:#FF6EC7;--pen-press:#FFD400;--pen-uv:#12FF4B;
  --pen-cond:#FF9A3C;--pen-ph:#B39DFF;--pen-temp:#FFFFFF;
  --pipe-idle:#4A4744;--svc-a:#2D6FB8;--svc-b:#8A5BC8;--svc-sample:#C8862B;--svc-cip:#1FA98C;
  --svc-product:#16C60C;--svc-waste:#6B6B6B;
  --font-ui:system-ui,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
  --font-num:ui-monospace,Consolas,'Cascadia Mono','Courier New',monospace;
  position:relative;display:flex;flex-direction:column;min-height:0;height:100%;
  background:var(--screen);color:var(--ink);font:400 11px/1.2 var(--font-ui);
  -webkit-font-smoothing:antialiased;
}
:root[data-theme="dark"] .vm-root{
  --screen:#2A2A2A;--face:#4A4744;--face-2:#3E3B38;--face-3:#565250;
  --bev-hi:#7A7672;--bev-lt:#605C58;--bev-sh:#2E2B29;--bev-dk:#1A1817;
  --ink:#E8E4DC;--ink-2:#B8B4AC;--ink-off:#8A8680;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme]) .vm-root{
    --screen:#2A2A2A;--face:#4A4744;--face-2:#3E3B38;--face-3:#565250;
    --bev-hi:#7A7672;--bev-lt:#605C58;--bev-sh:#2E2B29;--bev-dk:#1A1817;
    --ink:#E8E4DC;--ink-2:#B8B4AC;--ink-off:#8A8680;
  }
}
.vm-root *{box-sizing:border-box;border-radius:0}
.vm-grid{display:grid;grid-template-columns:248px minmax(300px,1fr) 312px;gap:3px;
  flex:1 1 auto;min-height:0;padding:3px;align-items:stretch}
.vm-rail{display:flex;flex-direction:column;gap:3px;min-height:0;overflow:auto}
.vm-panel{background:var(--face);padding:3px;display:flex;flex-direction:column;min-height:0;
  overflow:hidden;box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-panel--flex{flex:1 1 auto}
.vm-hd{height:20px;flex:0 0 20px;display:flex;align-items:center;gap:4px;padding:0 4px;
  background:var(--face-2);color:var(--ink);user-select:none;
  font:700 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em;
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-hd__sp{flex:1 1 auto}
.vm-hd__n{min-width:34px;padding:1px 4px;text-align:right;background:var(--fld-bg);color:var(--fld-pv);
  font:700 11px/1 var(--font-num);font-variant-numeric:tabular-nums lining-nums;letter-spacing:0;
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-scroll{flex:1 1 auto;min-height:0;overflow:auto;background:var(--face)}
.vm-ft{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:2px;padding:2px;background:var(--face-2);
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-btn{height:20px;min-width:22px;padding:0 3px;border:0;background:var(--face);color:var(--ink);
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:3px;
  white-space:nowrap;font:700 10px/1 var(--font-num);letter-spacing:.06em;
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-btn svg{width:12px;height:12px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;
  stroke-linecap:square;pointer-events:none}
.vm-btn:active:not(:disabled),.vm-btn[aria-pressed="true"]{
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
  inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)}
.vm-btn:active:not(:disabled) svg{transform:translate(1px,1px)}
.vm-btn:disabled{color:var(--ink-off);cursor:not-allowed}
.vm-btn--primary{background:var(--face-3)}
.vm-btn--danger{color:#8E1710}
.vm-btn--sm{height:18px;min-width:20px}
.vm-btn--icon{width:22px;padding:0}
.vm-btn--sm.vm-btn--icon{width:20px}
.vm-row{position:relative;display:grid;grid-template-columns:12px 4px minmax(0,1fr) auto;gap:4px;
  align-items:center;min-height:34px;padding:2px 3px;cursor:pointer;background:var(--face-3);
  border-bottom:1px solid var(--bev-sh);user-select:none}
.vm-row:hover{background:var(--face)}
.vm-row.is-selected{background:var(--face-2);box-shadow:inset 3px 0 0 var(--fld-sp)}
.vm-row.is-off .vm-row__name,.vm-row.is-off .vm-row__sum{color:var(--ink-off)}
.vm-row.is-off .vm-row__name{text-decoration:line-through}
.vm-row.is-drag{z-index:5;background:var(--face-2);
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-row:focus-visible{outline:2px solid #FFD400;outline-offset:-2px}
.vm-row__grip{color:var(--ink-2);font-size:11px;line-height:1;text-align:center;cursor:grab;
  touch-action:none}
.vm-row.is-drag .vm-row__grip{cursor:grabbing}
.vm-row__bar{width:4px;height:26px;background:var(--pipe-idle)}
.vm-row__mid{min-width:0;display:flex;flex-direction:column;gap:1px}
.vm-row__top{display:flex;align-items:center;gap:4px;min-width:0}
.vm-row__code{flex:0 0 auto;padding:1px 3px;background:var(--face-2);color:var(--ink);
  font:700 9px/1 var(--font-num);letter-spacing:.06em;
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk)}
.vm-row__name{font:700 11px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.02em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vm-row__sum{font:400 10px/1 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vm-row__right{display:flex;align-items:center;gap:4px}
.vm-dot,.vm-issue__mk{width:10px;height:10px;flex:0 0 10px;border-radius:50%;border:1px solid #2A2A2A;
  background:radial-gradient(circle at 33% 28%,rgba(255,255,255,.8) 0 1.2px,rgba(255,255,255,0) 2.2px),
  var(--lamp-off)}
.vm-dot--ok,.vm-issue__mk[data-s="ok"]{background:radial-gradient(circle at 33% 28%,
  rgba(255,255,255,.85) 0 1.2px,rgba(255,255,255,0) 2.2px),var(--lamp-run)}
.vm-dot--warn,.vm-issue__mk[data-s="warn"]{background:radial-gradient(circle at 33% 28%,
  rgba(255,255,255,.85) 0 1.2px,rgba(255,255,255,0) 2.2px),var(--lamp-warn)}
.vm-dot--err,.vm-issue__mk[data-s="alarm"]{background:radial-gradient(circle at 33% 28%,
  rgba(255,255,255,.85) 0 1.2px,rgba(255,255,255,0) 2.2px),var(--lamp-alarm)}
.vm-insert{position:absolute;left:2px;right:2px;height:2px;background:var(--fld-sp);
  pointer-events:none;display:none;z-index:6}
.vm-insert.is-on{display:block}
.vm-listwrap{position:relative}
.vm-sec{border-bottom:1px solid var(--bev-sh)}
.vm-sec__hd{width:100%;height:18px;display:flex;align-items:center;gap:3px;padding:0 3px;border:0;
  background:var(--face-2);cursor:pointer;color:var(--ink);text-align:left;
  font:700 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em}
.vm-sec__caret{display:inline-block;width:9px;color:var(--ink-2);font-size:9px;line-height:1}
.vm-sec__body{padding:2px;display:grid;gap:1px 6px;background:var(--face);
  grid-template-columns:repeat(auto-fill,minmax(206px,1fr));align-items:center}
.vm-sec.is-collapsed .vm-sec__body{display:none}
.vm-field{display:grid;grid-template-columns:88px minmax(0,1fr);align-items:center;gap:4px;
  min-width:0;min-height:20px}
.vm-field--span{grid-column:1/-1}
.vm-field__lb{display:flex;align-items:center;gap:3px;font:700 10px/1 var(--font-ui);
  color:var(--ink-2);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.vm-field__body{min-width:0}
.vm-field__hint{display:none}
.vm-field__msg{display:none;grid-column:2;align-items:center;gap:3px;height:14px;padding:0 3px;
  background:var(--lamp-alarm);color:#fff;font:700 9px/1 var(--font-num);letter-spacing:.04em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vm-field.is-invalid .vm-field__msg{display:flex}
.vm-field.is-invalid .vm-nf,.vm-field.is-invalid .vm-sel,.vm-field.is-invalid .vm-txt{
  outline:2px solid var(--fld-alarm);outline-offset:-2px}
.vm-info{width:14px;height:14px;flex:0 0 14px;padding:0;border:0;background:var(--face);
  color:var(--ink-2);cursor:help;display:inline-flex;align-items:center;justify-content:center;
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk)}
.vm-info svg{width:10px;height:10px;display:block;fill:none;stroke:currentColor;stroke-width:1.5}
.vm-info:hover{color:var(--ink)}
.vm-nf{display:flex;align-items:stretch;height:18px;background:var(--fld-bg);overflow:hidden;
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
  inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)}
.vm-nf:focus-within{outline:2px solid #FFD400;outline-offset:-2px}
.vm-nf input{flex:1 1 auto;min-width:0;width:100%;background:transparent;border:0;padding:0 3px;
  color:var(--fld-sp);text-align:right;font:700 12px/1 var(--font-num);
  font-variant-numeric:tabular-nums lining-nums}
.vm-nf input:focus{outline:none}
.vm-nf input:disabled{color:var(--fld-stale)}
.vm-nf__v{flex:1 1 auto;min-width:0;padding:0 3px;text-align:right;color:var(--fld-pv);
  font:700 12px/1 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vm-nf__v[data-q="alarm"]{color:var(--fld-alarm)}
.vm-nf__step{display:none;flex-direction:column;width:12px;flex:0 0 12px}
.vm-nf:hover .vm-nf__step,.vm-nf:focus-within .vm-nf__step{display:flex}
.vm-nf__step button{flex:1 1 0;border:0;background:var(--face);cursor:pointer;padding:0;
  color:var(--ink);font:400 6px/1 var(--font-ui);
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk)}
.vm-nf__step button:active{box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-nf__u{display:flex;align-items:center;padding:0 3px;color:var(--fld-eu);
  font:400 10px/1 var(--font-num);user-select:none;white-space:nowrap}
.vm-nf__usel{border:0;background:var(--face-3);color:var(--ink);font:400 10px/1 var(--font-ui);
  padding:0 2px;cursor:pointer;max-width:88px}
.vm-sel,.vm-txt{height:18px;border:0;background:var(--face-3);color:var(--ink);padding:0 2px;
  min-width:0;width:100%;font:400 11px/1 var(--font-ui);
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
  inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)}
.vm-ta{min-height:38px;border:0;background:var(--face-3);color:var(--ink);padding:2px;
  resize:vertical;width:100%;font:400 11px/1.3 var(--font-ui);
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-sel:focus-visible,.vm-txt:focus-visible,.vm-ta:focus-visible,.vm-btn:focus-visible,
.vm-info:focus-visible,.vm-card:focus-visible,.vm-issue:focus-visible,.vm-sec__hd:focus-visible,
.vm-nf__usel:focus-visible{outline:2px solid #FFD400;outline-offset:1px}
.vm-tg{display:inline-flex;align-items:center;gap:4px;cursor:pointer;position:relative}
.vm-tg input{position:absolute;opacity:0;width:26px;height:14px;margin:0;cursor:pointer}
.vm-tg__tr{width:26px;height:14px;flex:0 0 26px;position:relative;background:var(--fld-bg);
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-tg__tr::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;
  background:var(--face);box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk)}
.vm-tg input:checked + .vm-tg__tr::after{left:14px;background:var(--lamp-run)}
.vm-tg input:focus-visible + .vm-tg__tr{outline:2px solid #FFD400;outline-offset:1px}
.vm-tg input:disabled + .vm-tg__tr{opacity:.55}
.vm-tg__lb{font:700 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em;
  color:var(--ink-2);white-space:nowrap}
.vm-watch{background:var(--face-3);padding:3px;display:grid;gap:1px 6px;
  grid-template-columns:repeat(auto-fill,minmax(168px,1fr));
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-watch__hd{grid-column:1/-1;display:flex;align-items:center;gap:4px;height:18px;padding:0 3px;
  background:var(--face-2);
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk)}
.vm-watch__id{font:700 10px/1 var(--font-num);letter-spacing:.06em;color:var(--ink)}
.vm-pill{height:16px;display:inline-flex;align-items:center;padding:0 4px;background:var(--face);
  color:var(--ink);font:700 9px/1 var(--font-num);text-transform:uppercase;letter-spacing:.06em;
  white-space:nowrap;box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk)}
.vm-pill--ok{background:var(--lamp-run);color:#06210A}
.vm-pill--warn{background:var(--lamp-warn);color:#241A00}
.vm-pill--err{background:var(--lamp-alarm);color:#FFFFFF}
.vm-pill--info{background:var(--svc-a);color:#FFFFFF}
.vm-pill--mute{background:var(--face-2);color:var(--ink-2)}
.vm-prev{padding:3px;display:flex;flex-direction:column;gap:3px;background:var(--face)}
.vm-prev canvas{display:block;width:100%;height:160px;background:var(--plot-bg);
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
  inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)}
.vm-prev__stats{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}
.vm-stat{display:flex;flex-direction:column;gap:1px;min-width:0}
.vm-stat__k{font:700 9px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em;
  color:var(--ink-2)}
.vm-stat__v{background:var(--fld-bg);color:var(--fld-pv);padding:1px 3px;text-align:right;
  font:700 12px/16px var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-issue{display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:4px;align-items:center;
  width:100%;min-height:22px;padding:2px 4px;border:0;border-bottom:1px solid var(--bev-sh);
  background:var(--face-3);text-align:left;cursor:pointer;color:var(--ink)}
.vm-issue:hover{background:var(--face)}
.vm-issue__tx{min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden}
.vm-issue__hd{display:flex;gap:4px;align-items:center;flex:0 0 auto}
.vm-issue__code{padding:1px 3px;background:var(--face-2);color:var(--ink);
  font:700 10px/1 var(--font-num);letter-spacing:.04em}
.vm-issue__where{font:400 9px/1 var(--font-num);color:var(--ink-2);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:96px}
.vm-issue__msg{font:400 10px/1 var(--font-ui);color:var(--ink-2);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;min-width:0}
.vm-empty{display:flex;align-items:center;gap:4px;margin:2px;padding:3px 4px;background:var(--fld-bg);
  color:var(--fld-stale);font:700 10px/1 var(--font-num);letter-spacing:.06em}
.vm-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px;align-items:center;width:100%;
  min-height:26px;padding:2px 4px;border:0;border-bottom:1px solid var(--bev-sh);
  background:var(--face-3);cursor:pointer;text-align:left;color:var(--ink)}
.vm-card:hover{background:var(--face)}
.vm-card__nm{font:700 11px/1.2 var(--font-ui);text-transform:uppercase;letter-spacing:.02em}
.vm-card__sub{font:400 10px/1.2 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  color:var(--ink-2)}
.vm-card svg{display:block;background:var(--plot-bg)}
.vm-bar{flex:0 0 24px;height:24px;display:flex;align-items:center;gap:3px;padding:0 3px;
  background:var(--face-2);
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-bar__sp{flex:1 1 auto}
.vm-bar__msg{display:flex;align-items:center;height:18px;padding:0 4px;background:var(--fld-bg);
  color:var(--fld-pv);font:700 10px/1 var(--font-num);letter-spacing:.06em;min-width:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-bar__msg[data-kind="alarm"]{color:var(--fld-alarm)}
.vm-bar__msg[data-kind="warn"]{color:var(--fld-sp)}
.vm-note{display:flex;align-items:center;gap:4px;height:20px;margin:3px 3px 0;padding:0 4px;
  background:var(--fld-bg);color:var(--fld-sp);font:700 10px/1 var(--font-num);letter-spacing:.06em;
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.vm-drop{position:absolute;inset:0;z-index:20;display:none;align-items:center;justify-content:center;
  background:rgba(0,0,0,.55)}
.vm-root.is-dropping .vm-drop{display:flex}
.vm-drop__in{padding:12px 18px;background:var(--face);color:var(--ink);
  font:700 11px/1 var(--font-num);letter-spacing:.08em;
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.vm-fallback-toast{position:fixed;right:16px;bottom:16px;z-index:9999;max-width:340px;padding:6px 8px;
  background:var(--face);color:var(--ink);font:400 11px/1.3 var(--font-ui);
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-fallback-modal{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
  justify-content:center;background:rgba(0,0,0,.55)}
.vm-fallback-modal__b{max-width:520px;width:calc(100% - 32px);max-height:80vh;overflow:auto;padding:8px;
  background:var(--face);color:var(--ink);
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.vm-fallback-modal h3{margin:0 0 6px;font:700 12px/1 var(--font-ui);text-transform:uppercase;
  letter-spacing:.04em}
.vm-fallback-modal__a{display:flex;gap:4px;justify-content:flex-end;margin-top:8px}
@media (max-width:1279px){
  .vm-grid{grid-template-columns:236px minmax(0,1fr)}
  .vm-rail{grid-column:1/-1;flex-direction:row;flex-wrap:wrap;overflow:visible}
  .vm-rail > .vm-panel{flex:1 1 280px;min-width:262px}
}
@media (max-width:1023px){
  .vm-grid{grid-template-columns:minmax(0,1fr)}
  .vm-panel{max-height:60vh}
}
@media (prefers-reduced-motion:reduce){
  .vm-btn:active:not(:disabled) svg{transform:none}
}
@media (prefers-contrast:more){
  .vm-root{--bev-sh:#5A5652;--ink-2:var(--ink)}
}
`;

/**
 * Inject the scoped sheet once per document and bump the reference count.
 * @param {Document} doc the document to inject into
 * @returns {void}
 */
function acquireStyles(doc) {
  styleRefCount++;
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.setAttribute('id', STYLE_ID);
  st.textContent = STYLE_TEXT;
  doc.head.appendChild(st);
}

/**
 * Drop the reference and remove the sheet when the last method view is destroyed.
 * @param {Document} doc the document the sheet was injected into
 * @returns {void}
 */
function releaseStyles(doc) {
  styleRefCount = Math.max(0, styleRefCount - 1);
  if (styleRefCount > 0) return;
  const st = doc.getElementById(STYLE_ID);
  if (st && st.parentNode) st.parentNode.removeChild(st);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 5. DOM CONSTRUCTION HELPERS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Create an element. Deliberately narrow: tag, class list, text. Everything else is set through the
 * `format.js` helpers (`setAttr`, `setText`, `cls`) so there is exactly one way to touch the DOM
 * and no `innerHTML` anywhere in this module.
 *
 * @param {Document} doc owning document
 * @param {string} tag tag name
 * @param {string} [className] space-separated class list
 * @param {string} [text] text content
 * @returns {HTMLElement} the new element
 */
function mk(doc, tag, className, text) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

/**
 * Append children, skipping nulls so a caller can inline `cond ? node : null`.
 * @param {Element} parent the parent
 * @param {...(Node|null|undefined)} kids children
 * @returns {Element} `parent`, for chaining
 */
function add(parent, ...kids) {
  for (const k of kids) if (k) parent.appendChild(k);
  return parent;
}

/**
 * Fill a `<select>` with options. Values are stringified; `null` round-trips through the sentinel
 * `'__null__'` so a "none" option is distinguishable from the empty string.
 *
 * @param {HTMLSelectElement} sel the select
 * @param {Array<*>} values option values, in order
 * @param {function(*):string} labelFn value → visible label
 * @returns {void}
 */
function fillOptions(sel, values, labelFn) {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  for (const v of values) {
    const o = sel.ownerDocument.createElement('option');
    o.value = v === null || v === undefined ? '__null__' : String(v);
    o.textContent = labelFn(v);
    sel.appendChild(o);
  }
}

/** @param {string} v a `<select>` value @returns {string|null} the value, with the null sentinel decoded */
function decodeOption(v) {
  return v === '__null__' ? null : v;
}

/** @param {string} s an enum constant like `'ELUTION_LINEAR'` @returns {string} `'Elution linear'` */
function humanise(s) {
  if (s === null || s === undefined || s === '') return 'None';
  const t = String(s).toLowerCase().replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Icon geometry, authored here as 16×16 stroke paths — no icon font, no network, no web font (§0).
 * Every control on this screen is one of these plus a `title` and an `aria-label`.
 */
const ICONS = {
  add: ['M8 2.5v11', 'M2.5 8h11'],
  duplicate: ['M5.5 5.5h8v8h-8z', 'M2.5 2.5h8v2', 'M2.5 2.5v8h2'],
  del: ['M3.5 4.5h9', 'M6 4.5V2.5h4v2', 'M4.6 4.5 5.5 14h5l.9-9.5'],
  up: ['M8 13.5V3', 'M3.5 7.5 8 3l4.5 4.5'],
  down: ['M8 2.5V13', 'M3.5 8.5 8 13l4.5-4.5'],
  undo: ['M3 8.5a5.5 5.5 0 1 1 2 4.2', 'M2.5 4.5v4h4'],
  redo: ['M13 8.5a5.5 5.5 0 1 0-2 4.2', 'M13.5 4.5v4h-4'],
  apply: ['M2.5 8.5 6 12l7.5-7.5'],
  revert: ['M3 8.5a5.5 5.5 0 1 1 2 4.2', 'M2.5 4.5v4h4'],
  recheck: ['M13.5 8a5.5 5.5 0 1 1-1.7-4', 'M13.5 1.5v3.2h-3.2'],
  export: ['M8 1.5v8', 'M5 6.5 8 9.5l3-3', 'M2.5 11.5v3h11v-3'],
  import: ['M8 9.5v-8', 'M5 4.5 8 1.5l3 3', 'M2.5 11.5v3h11v-3'],
  info: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M8 7v4.5', 'M8 4.4v.9'],
  fix: ['M13 2.5a3.5 3.5 0 0 1-4.4 4.4L3.5 12l1 1 5.1-5.1A3.5 3.5 0 0 1 13 2.5z'],
};

/**
 * One inline icon, in the SVG namespace.
 * @param {Document} doc owning document
 * @param {string} name a key of {@link ICONS}
 * @returns {SVGElement} a 16×16 `<svg>`
 */
function svgIcon(doc, name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name] || []) {
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * A beveled icon-only button: the glyph carries the meaning, `title` and `aria-label` carry the
 * words (§9.7 — an icon-only control still has an accessible name).
 *
 * @param {Document} doc owning document
 * @param {string} name a key of {@link ICONS}
 * @param {string} title the tooltip and the accessible name
 * @param {function(Event):void} onClick the handler
 * @param {string} [extraClass] additional class names
 * @returns {HTMLButtonElement} the button
 */
function iconBtn(doc, name, title, onClick, extraClass) {
  const b = mk(doc, 'button', 'vm-btn vm-btn--icon' + (extraClass ? ' ' + extraClass : ''));
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  add(b, svgIcon(doc, name));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/**
 * Where a message may be cut into clauses. A `.` or `;` counts ONLY when whitespace or the end of
 * the string follows it, and the dashes only when spaced.
 *
 * The lookahead is the whole point. Nearly every `validateMethod` message quotes a number —
 * `'Estimated column dP 1.23 bar exceeds the 1.00 bar trip.'` — and a bare `.` split cut that to
 * `ESTIMATED COLUMN DP 1`, which is not an abbreviation of the message but a different, false
 * statement about the pressure. A short clause still has to be TRUE.
 * @type {RegExp}
 */
const CLAUSE_BREAK = /[.;](?=\s|$)|\s[—-]\s/;

/**
 * Shorten a sentence to the SHORT clause an FT-CLASSIC screen may carry: the first clause,
 * uppercased, capped at `max` characters. The whole sentence belongs in the tooltip.
 *
 * @param {string} message the full message
 * @param {number} [max=28] the character cap
 * @returns {string} the short clause
 */
function shortClause(message, max) {
  const cap = max || 28;
  const s = String(message || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.split(CLAUSE_BREAK)[0].trim();
  const t = (cut || s).toUpperCase();
  return t.length <= cap ? t : t.slice(0, cap - 1) + '…';
}

/**
 * The unparseable-entry message. Written so {@link shortClause} renders `NOT A NUMBER` on the glass
 * while the whole sentence stays behind the tooltip, which is the rule for every message here.
 * @type {string}
 */
const BAD_NUMBER = 'Not a number — the entry was rejected and the draft was not written.';

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 6. OVERLAY ADAPTERS
 *
 * Every floating surface belongs to `ui/overlay.js` (§6.33) and this module calls it for popovers,
 * modals and toasts. The three wrappers below add ONE thing: if the overlay host is unavailable or
 * a call throws, the interaction still completes through a minimal local surface instead of
 * vanishing. A method editor that silently swallows "import failed" would be worse than plain.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Show a transient message. Kinds follow §9.4.4: `'blocked'` is the interlock refusal.
 * @param {object} ui the view's overlay bundle `{host, doc, root}`
 * @param {string} message the text
 * @param {'info'|'warn'|'blocked'} [kind='info'] severity
 * @returns {void}
 */
function toast(ui, message, kind) {
  const k = kind || 'info';
  try {
    if (ui.host) {
      showToast(ui.host, { message, kind: k, ms: k === 'info' ? 3000 : 5000 });
      return;
    }
  } catch (e) { /* fall through to the local surface */ }
  const el = mk(ui.doc, 'div', 'vm-fallback-toast', message);
  el.setAttribute('role', 'status');
  ui.doc.body.appendChild(el);
  ui.timers.push(setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 4500));
}

/**
 * Show a modal with a title, a body node and a row of actions. Each action closes the modal before
 * its `onClick` runs, so an action that opens another modal cannot stack two dims.
 *
 * @param {object} ui the view's overlay bundle
 * @param {{title:string, content:Node, actions:Array<{label:string, onClick?:function, variant?:string}>}} opts
 * @returns {void}
 */
function modal(ui, opts) {
  const actions = opts.actions.map((a) => ({
    label: a.label, variant: a.variant || 'ghost',
    onClick: () => { if (a.onClick) a.onClick(); },
  }));
  try {
    const host = ui.host;
    if (host) {
      // §6.33: nothing closes automatically — the handler receives the handle and dismisses it.
      showModal(host, { title: opts.title, content: opts.content, dismissible: true,
        actions: actions.map((a) => ({ label: a.label, variant: a.variant,
          onClick: (hnd) => { try { dismiss(hnd); } catch (e) { /* already closed */ } a.onClick(); } })) });
      return;
    }
  } catch (e) { /* fall through to the local surface */ }
  const dim = mk(ui.doc, 'div', 'vm-fallback-modal');
  dim.setAttribute('role', 'dialog');
  dim.setAttribute('aria-modal', 'true');
  const box = mk(ui.doc, 'div', 'vm-fallback-modal__b');
  add(box, mk(ui.doc, 'h3', null, opts.title), opts.content);
  const row = mk(ui.doc, 'div', 'vm-fallback-modal__a');
  const close = () => {
    ui.doc.removeEventListener('keydown', onKey, true);
    if (dim.parentNode) dim.parentNode.removeChild(dim);
    if (prev && prev.focus) prev.focus();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  for (const a of actions) {
    const b = mk(ui.doc, 'button', 'vm-btn' + (a.variant === 'primary' ? ' vm-btn--primary'
      : a.variant === 'danger' ? ' vm-btn--danger' : ''), a.label);
    b.type = 'button';
    b.addEventListener('click', () => { close(); a.onClick(); });
    row.appendChild(b);
  }
  add(box, row);
  add(dim, box);
  const prev = ui.doc.activeElement;
  ui.doc.body.appendChild(dim);
  ui.doc.addEventListener('keydown', onKey, true);
  const first = box.querySelector('button, input, select, textarea, [tabindex]');
  if (first && first.focus) first.focus();
}

/**
 * Show the glossary popover for one entry, anchored to its `ⓘ` button. `overlay.js` owns the
 * layout; `data/glossary.js` owns every word of the text (§6.33, §6.22.1).
 *
 * @param {object} ui the view's overlay bundle
 * @param {Element} anchorEl the button the popover points at
 * @param {{term:string, short:string, why:string, typical:string, seeAlso:string[]}} entry the entry
 * @returns {void}
 */
function popover(ui, anchorEl, entry) {
  try {
    if (ui.host) {
      const handle = showGlossaryPopover(ui.host, { anchorEl, entry, placement: 'right',
        onSeeAlso: (id) => {
          const next = glossaryFor(id);
          if (next) popover(ui, anchorEl, next);
        } });
      if (handle) return;
      showPopover(ui.host, { anchorEl, content: glossaryBody(ui.doc, entry),
        placement: 'right', maxWidth: 280 });
      return;
    }
  } catch (e) { /* fall through to the local surface */ }
  modal(ui, { title: entry.term, content: glossaryBody(ui.doc, entry),
    actions: [{ label: 'Close', variant: 'primary' }] });
}

/**
 * Build the body of a glossary popover from a `data/glossary.js` entry (§9.6: what it is, units and
 * typical range, why it matters).
 *
 * @param {Document} doc owning document
 * @param {{term:string, short:string, why:string, typical:string}} entry the glossary entry
 * @returns {DocumentFragment} the popover body
 */
function glossaryBody(doc, entry) {
  const frag = doc.createDocumentFragment();
  const h = mk(doc, 'div', null, entry.term);
  h.style.cssText = 'font-weight:700;font-size:12px;margin-bottom:4px;';
  const p1 = mk(doc, 'div', null, entry.short);
  p1.style.cssText = 'margin-bottom:6px;';
  const p2 = mk(doc, 'div', null, entry.typical);
  p2.style.cssText = 'font-family:var(--font-num,monospace);color:var(--text-2,#A7B4C4);margin-bottom:6px;';
  const p3 = mk(doc, 'div', null, entry.why);
  p3.style.cssText = 'color:var(--text-2,#A7B4C4);';
  return add(frag, h, p1, p2, p3);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 7. FORM CONTROLS (§9.4.2)
 *
 * Every control is built from a real `<input>` / `<select>` / `<textarea>` so keyboard behaviour,
 * focus rings and screen-reader semantics come for free (§9.7). Each returns nothing: it appends
 * itself to `F.parent` and registers a `refresh()` on `F.fields`, keyed by its `fieldPath` so the
 * validation pass can mark exactly the offending field invalid.
 *
 * `F` is the form context: `{ doc, ui, parent, fields, edit(fn), readOnly }`.
 * `edit(fn)` is the ONLY mutation entry point — it snapshots for undo, runs `fn`, marks the draft
 * dirty and schedules the debounced recompute.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The shared label / body / hint / error scaffold every control sits in.
 *
 * `label` is the FACE: 10 px uppercase, at most two words (FT-CLASSIC text policy). `title` is the
 * unabbreviated name and goes to the tooltip and the accessible name, so shortening a tag on the
 * glass never costs an operator the words.
 *
 * @param {object} F the form context
 * @param {{label:string, title?:string, unit?:string, glossary?:string, fieldPath?:string,
 *          span?:boolean}} o field options
 * @returns {{el:HTMLElement, body:HTMLElement, setHint:function(string):void,
 *            setError:function(string|null):void, fieldPath:string|null}} the scaffold
 */
function makeField(F, o) {
  const doc = F.doc;
  const el = mk(doc, 'div', 'vm-field' + (o.span ? ' vm-field--span' : ''));
  const lb = mk(doc, 'div', 'vm-field__lb');
  const lbText = mk(doc, 'span', null, o.label);
  add(lb, lbText);
  const entry = o.glossary ? glossaryFor(o.glossary) : null;
  if (entry) {
    // §6.22.1: an entry is REQUIRED before a label may render an info affordance.
    const b = mk(doc, 'button', 'vm-info');
    b.type = 'button';
    b.title = entry.term + ' — ' + entry.short;
    b.setAttribute('aria-label', 'About ' + entry.term);
    add(b, svgIcon(doc, 'info'));
    b.addEventListener('click', (ev) => { ev.stopPropagation(); popover(F.ui, b, entry); });
    add(lb, b);
  }
  const body = mk(doc, 'div', 'vm-field__body');
  const msg = mk(doc, 'div', 'vm-field__msg');
  add(el, lb, body, msg);
  add(F.parent, el);
  // The label is the tag; every sentence this field would have shown lives in its tooltip, and an
  // invalid field shows a SHORT clause with the full message behind it (FT-CLASSIC text policy).
  const baseTitle = (o.title || o.label) + (o.unit ? ' (' + o.unit + ')' : '');
  setAttr(el, 'title', baseTitle);
  return {
    el, body, fieldPath: o.fieldPath || null,
    setHint(s) { setAttr(el, 'title', s ? baseTitle + ' — ' + s : baseTitle); },
    setError(s) {
      cls(el, 'is-invalid', !!s);
      setText(msg, s ? shortClause(s) : '');
      setAttr(msg, 'title', s || null);
    },
  };
}

/**
 * Build the numfield chrome of §9.4.2: a right-aligned tabular `<input type="text"
 * inputmode="decimal">`, a hover stepper column, and a unit suffix (a static span, or a `<select>`
 * when more than one unit applies).
 *
 * @param {object} F the form context
 * @param {HTMLElement} host the field body to append into
 * @param {{units:Array<string>|null, unit:string, onUnit:function(string):void}} u unit config
 * @returns {{wrap:HTMLElement, input:HTMLInputElement, unitSel:HTMLSelectElement|null}} the parts
 */
function numChrome(F, host, u) {
  const doc = F.doc;
  const wrap = mk(doc, 'div', 'vm-nf');
  const input = mk(doc, 'input');
  input.type = 'text';
  input.setAttribute('inputmode', 'decimal');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const step = mk(doc, 'div', 'vm-nf__step');
  const up = mk(doc, 'button', null, '▲');
  const dn = mk(doc, 'button', null, '▼');
  up.type = 'button'; dn.type = 'button';
  up.tabIndex = -1; dn.tabIndex = -1;
  up.setAttribute('aria-hidden', 'true'); dn.setAttribute('aria-hidden', 'true');
  add(step, up, dn);
  add(wrap, input, step);
  let unitSel = null;
  if (u.units && u.units.length > 1) {
    unitSel = mk(doc, 'select', 'vm-nf__usel');
    fillOptions(unitSel, u.units, (v) => v);
    unitSel.value = u.unit;
    unitSel.setAttribute('aria-label', 'Unit');
    unitSel.addEventListener('change', () => u.onUnit(unitSel.value));
    add(wrap, unitSel);
  } else if (u.unit) {
    add(wrap, mk(doc, 'span', 'vm-nf__u', u.unit));
  }
  add(host, wrap);
  return { wrap, input, unitSel, up, dn };
}

/**
 * A plain numeric field bound to one number on the draft.
 *
 * `↑`/`↓` step by `step`, `Shift` ×10 and `Alt` ×0.1 (§9.4.2). A value that does not parse marks the
 * field invalid and is NOT written to the draft, so a half-typed `1.` never reaches the model.
 *
 * @param {object} F the form context
 * @param {{label:string, title?:string, glossary?:string, fieldPath?:string, span?:boolean,
 *          unit?:string, step?:number, decimals?:number, min?:number, max?:number,
 *          integer?:boolean, get:function():number, set:function(number):void,
 *          hint?:function():string, disabled?:function():boolean}} o field options
 * @returns {object} the field scaffold
 */
function numField(F, o) {
  const f = makeField(F, o);
  const step = o.step === undefined ? 1 : o.step;
  const parts = numChrome(F, f.body, { units: null, unit: o.unit || '', onUnit: () => {} });
  const input = parts.input;
  input.setAttribute('aria-label', (o.title || o.label) + (o.unit ? ' in ' + o.unit : ''));
  const decimals = () => (o.decimals === undefined ? autoDecimals(o.get()) : o.decimals);
  const commit = (raw) => {
    const v = parseFloat(String(raw).replace(',', '.'));
    if (!Number.isFinite(v)) { f.setError(BAD_NUMBER); return; }
    let x = v;
    if (o.integer) x = Math.round(x);
    if (o.min !== undefined) x = Math.max(o.min, x);
    if (o.max !== undefined) x = Math.min(o.max, x);
    f.setError(null);
    F.edit(() => o.set(x));
  };
  input.addEventListener('input', () => commit(input.value));
  input.addEventListener('blur', () => { f.setError(null); input.value = nf(o.get(), decimals()); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    const mult = ev.shiftKey ? 10 : (ev.altKey ? 0.1 : 1);
    const cur = parseFloat(input.value);
    const base = Number.isFinite(cur) ? cur : o.get();
    const next = base + (ev.key === 'ArrowUp' ? 1 : -1) * step * mult;
    input.value = nf(next, decimals());
    commit(input.value);
  });
  const bump = (dir) => {
    const next = o.get() + dir * step;
    commit(next);
    input.value = nf(o.get(), decimals());
  };
  parts.up.addEventListener('click', () => bump(1));
  parts.dn.addEventListener('click', () => bump(-1));
  f.refresh = () => {
    const dis = F.readOnly || (o.disabled ? o.disabled() : false);
    input.disabled = dis;
    if (F.doc.activeElement !== input) input.value = nf(o.get(), decimals());
    if (o.hint) f.setHint(o.hint());
  };
  F.fields.push(f);
  return f;
}

/**
 * A threshold field: the value is stored CANONICALLY (§5.2) and displayed in a unit the operator
 * chooses. Changing the unit re-expresses the same canonical number — it never rescales the
 * physics — and every edit writes BOTH the canonical value and the matching `authoredAs` pair, so
 * `normalizeMethod` reproduces exactly what the editor showed and a flow-cell swap cannot move a
 * pool cut (§5.2, §5.4.6).
 *
 * @param {object} F the form context
 * @param {{label:string, title?:string, glossary?:string, fieldPath?:string, span?:boolean,
 *          units:Array<string>, getUnit:function():string, setUnit:function(string):void,
 *          get:function():number, set:function(number):void,
 *          hint?:function():string, config:object}} o field options
 * @returns {object} the field scaffold
 */
function unitNumField(F, o) {
  const f = makeField(F, o);
  const units = o.units && o.units.length ? o.units : ['-'];
  const curUnit = () => {
    const u = o.getUnit();
    return units.indexOf(u) >= 0 ? u : units[0];
  };
  const shown = () => fromCanonical(o.config, o.get(), curUnit());
  const parts = numChrome(F, f.body, {
    units, unit: curUnit(),
    onUnit: (u) => {
      // Re-express, never rescale: the canonical number is unchanged, only its authored form moves.
      const canonical = o.get();
      F.edit(() => { o.setUnit(u); o.set(canonical); });
    },
  });
  const input = parts.input;
  input.setAttribute('aria-label', o.title || o.label);
  const commit = (raw) => {
    const v = parseFloat(String(raw).replace(',', '.'));
    if (!Number.isFinite(v)) { f.setError(BAD_NUMBER); return; }
    f.setError(null);
    F.edit(() => o.set(toCanonical(o.config, v, curUnit())));
  };
  input.addEventListener('input', () => commit(input.value));
  input.addEventListener('blur', () => { f.setError(null); input.value = nf(shown(), autoDecimals(shown())); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    const x = shown();
    const mag = Math.abs(x) >= 10 ? 1 : (Math.abs(x) >= 1 ? 0.1 : Math.pow(10, -autoDecimals(x) + 1));
    const mult = ev.shiftKey ? 10 : (ev.altKey ? 0.1 : 1);
    input.value = nf(x + (ev.key === 'ArrowUp' ? 1 : -1) * mag * mult, autoDecimals(x));
    commit(input.value);
  });
  parts.up.addEventListener('click', () => { const x = shown(); commit(x + Math.max(Math.abs(x) * 0.05, 1e-6)); });
  parts.dn.addEventListener('click', () => { const x = shown(); commit(x - Math.max(Math.abs(x) * 0.05, 1e-6)); });
  f.refresh = () => {
    input.disabled = F.readOnly;
    if (parts.unitSel) {
      parts.unitSel.disabled = F.readOnly;
      if (parts.unitSel.value !== curUnit()) parts.unitSel.value = curUnit();
    }
    const x = shown();
    if (F.doc.activeElement !== input) input.value = nf(x, autoDecimals(x));
    f.setHint(o.hint ? o.hint() : ('= ' + nf(o.get(), autoDecimals(o.get())) + ' canonical'));
  };
  F.fields.push(f);
  return f;
}

/**
 * A `<select>` bound to one enum on the draft.
 * @param {object} F the form context
 * @param {{label:string, title?:string, glossary?:string, fieldPath?:string, span?:boolean,
 *          options:Array<*>, labelFn?:function(*):string, get:function():*, set:function(*):void,
 *          hint?:function():string, disabled?:function():boolean}} o field options
 * @returns {object} the field scaffold
 */
function selectField(F, o) {
  const f = makeField(F, o);
  const sel = mk(F.doc, 'select', 'vm-sel');
  sel.setAttribute('aria-label', o.title || o.label);
  fillOptions(sel, o.options, o.labelFn || humanise);
  add(f.body, sel);
  sel.addEventListener('change', () => F.edit(() => o.set(decodeOption(sel.value))));
  f.refresh = () => {
    sel.disabled = F.readOnly || (o.disabled ? o.disabled() : false);
    const v = o.get();
    const want = v === null || v === undefined ? '__null__' : String(v);
    if (sel.value !== want) sel.value = want;
    if (o.hint) f.setHint(o.hint());
  };
  F.fields.push(f);
  return f;
}

/**
 * A 34×18 toggle wrapping a real checkbox (§9.4.2).
 * @param {object} F the form context
 * @param {{label:string, title?:string, glossary?:string, fieldPath?:string, span?:boolean,
 *          text?:string, get:function():boolean, set:function(boolean):void,
 *          hint?:function():string}} o options
 * @returns {object} the field scaffold
 */
function toggleField(F, o) {
  const f = makeField(F, o);
  const lab = mk(F.doc, 'label', 'vm-tg');
  const cb = mk(F.doc, 'input');
  cb.type = 'checkbox';
  cb.setAttribute('aria-label', o.title || o.label);
  const tr = mk(F.doc, 'span', 'vm-tg__tr');
  const tx = mk(F.doc, 'span', 'vm-tg__lb', o.text || '');
  add(lab, cb, tr, tx);
  add(f.body, lab);
  cb.addEventListener('change', () => F.edit(() => o.set(cb.checked)));
  f.refresh = () => {
    cb.disabled = F.readOnly;
    const v = !!o.get();
    if (cb.checked !== v) cb.checked = v;
    if (o.hint) f.setHint(o.hint());
  };
  F.fields.push(f);
  return f;
}

/**
 * A single-line text field.
 * @param {object} F the form context
 * @param {{label:string, title?:string, glossary?:string, fieldPath?:string, span?:boolean,
 *          placeholder?:string, get:function():string, set:function(string):void,
 *          hint?:function():string}} o options
 * @returns {object} the field scaffold
 */
function textField(F, o) {
  const f = makeField(F, o);
  const inp = mk(F.doc, 'input', 'vm-txt');
  inp.type = 'text';
  inp.autocomplete = 'off';
  inp.setAttribute('aria-label', o.title || o.label);
  if (o.placeholder) inp.placeholder = o.placeholder;
  add(f.body, inp);
  inp.addEventListener('input', () => F.edit(() => o.set(inp.value)));
  f.refresh = () => {
    inp.disabled = F.readOnly;
    const v = o.get() === null || o.get() === undefined ? '' : String(o.get());
    if (F.doc.activeElement !== inp && inp.value !== v) inp.value = v;
    if (o.hint) f.setHint(o.hint());
  };
  F.fields.push(f);
  return f;
}

/**
 * A multi-line notes field.
 * @param {object} F the form context
 * @param {{label:string, glossary?:string, get:function():string, set:function(string):void}} o options
 * @returns {object} the field scaffold
 */
function textAreaField(F, o) {
  const f = makeField(F, { label: o.label, glossary: o.glossary, span: true });
  const ta = mk(F.doc, 'textarea', 'vm-ta');
  ta.setAttribute('aria-label', o.label);
  ta.rows = 2;
  add(f.body, ta);
  ta.addEventListener('input', () => F.edit(() => o.set(ta.value)));
  f.refresh = () => {
    ta.disabled = F.readOnly;
    const v = o.get() || '';
    if (F.doc.activeElement !== ta && ta.value !== v) ta.value = v;
  };
  F.fields.push(f);
  return f;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 8. THE METHOD PLAN — the model behind the preview strip and the three readouts
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The ΔP the preview draws its red overload band against: the `ALM-DP-03` column-ΔP trip
 * (§5.6). Falls back to the 1.00 bar `skid/method.js::validateMethod` uses when the row is absent.
 *
 * @param {object} config frozen config
 * @returns {number} the trip threshold, bar
 */
function dpTrip_bar(config) {
  const rows = config.alarms || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id === 'ALM-DP-03' && Number.isFinite(rows[i].threshold)) return rows[i].threshold;
  }
  return 1.0;
}

/**
 * Lay the enabled blocks of a NORMALISED method out on one cumulative-volume axis and total the
 * buffer each one draws, mirroring `methodDemand`'s split so the readouts and the PRC-02 warning
 * can never disagree.
 *
 * A `HOLD` block has no finite volume (§5.4.3) and would collapse the axis, so it is drawn at a
 * nominal 1 CV and flagged `isHold`; it contributes nothing to the totals, exactly as
 * `methodDemand` treats it.
 *
 * @param {object} config frozen config
 * @param {object} m a NORMALISED method (`normalizeMethod` output — `INHERIT` already resolved)
 * @returns {{rows:Array<object>, total_mL:number, drawn_mL:number, total_s:number, bufA_mL:number,
 *            bufB_mL:number, sample_mL:number, maxFlow_mLs:number, trip_bar:number,
 *            demand:object}} the plan
 */
function buildPlan(config, m) {
  const rows = [];
  const V_mL = config.column.V_mL;
  const trip_bar = dpTrip_bar(config);
  let cursor_mL = 0;
  let total_mL = 0;
  let total_s = 0;
  let bufA_mL = 0;
  let bufB_mL = 0;
  let sample_mL = 0;
  let maxFlow_mLs = 0;
  let prevEnabled = null;
  const blocks = (m && Array.isArray(m.blocks)) ? m.blocks : [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.enabled) continue;
    const flow_mLs = blockFlow_mLs(config, b, prevEnabled);
    prevEnabled = b;
    const raw_mL = blockVolume_mL(config, b);
    const isHold = !Number.isFinite(raw_mL);
    const vol_mL = isHold ? V_mL : Math.max(0, raw_mL);
    const time_s = (Number.isFinite(flow_mLs) && flow_mLs > 0) ? vol_mL / flow_mLs : 0;
    const dP_bar = blockPressureEstimate_bar(config, b);
    rows.push({ block: b, index: i, isHold, vol_mL, x0_mL: cursor_mL, x1_mL: cursor_mL + vol_mL,
      flow_mLs, time_s, dP_bar, over: dP_bar > trip_bar });
    cursor_mL += vol_mL;
    if (Number.isFinite(flow_mLs) && flow_mLs > maxFlow_mLs) maxFlow_mLs = flow_mLs;
    if (isHold) continue;
    total_mL += vol_mL;
    total_s += time_s;
    if (b.type === 'LOAD' && b.sample && b.sample.mode) {
      sample_mL += vol_mL;
      bufA_mL += (b.sample.chaseVolume_CV || 0) * V_mL;
    } else {
      // Mean %B by the same 21-point trapezoid `methodDemand` uses, so the two agree exactly.
      let sum = 0;
      for (let k = 0; k <= 20; k++) sum += (k === 0 || k === 20 ? 0.5 : 1) * targetPctB(config, b, k / 20);
      const xB = clampN(sum / 20, 0, 100) / 100;
      bufA_mL += vol_mL * (1 - xB);
      bufB_mL += vol_mL * xB;
    }
  }
  let demand = { perTank: {}, totalVolume_mL: 0, totalTime_s: 0, perBlock: [] };
  try { demand = methodDemand(config, m); } catch (e) { /* a malformed draft: totals stay zero */ }
  return { rows, total_mL, drawn_mL: cursor_mL, total_s, bufA_mL, bufB_mL, sample_mL,
    maxFlow_mLs, trip_bar, demand };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 9. THE PREVIEW STRIP (§6.29, spec-ux §6.2)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Lane geometry, CSS px, inside the nominal 300×160 canvas of §6.29. */
const PV = { H: 160, PADL: 26, PADR: 6, RIB_Y: 0, RIB_H: 13,
  L1_Y: 16, L1_H: 70, L2_Y: 90, L2_H: 36, L3_Y: 130, L3_H: 22, AX_Y: 157 };

/**
 * Resize a canvas for the device pixel ratio and return its 2D context, pre-scaled so every draw
 * call below is in CSS pixels.
 *
 * @param {HTMLCanvasElement} cv the canvas
 * @param {number} wCss CSS width
 * @param {number} hCss CSS height
 * @returns {CanvasRenderingContext2D|null} the scaled context, or null when 2D is unavailable
 */
function prepCanvas(cv, wCss, hCss) {
  const dpr = Math.max(1, Math.min(3, (cv.ownerDocument.defaultView || {}).devicePixelRatio || 1));
  const w = Math.max(1, Math.round(wCss * dpr));
  const h = Math.max(1, Math.round(hCss * dpr));
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, wCss, hCss);
  return g;
}

/**
 * Paint the three-lane preview: %B as a filled area, the flow step line with a red overlay wherever
 * the estimated block ΔP exceeds the trip, and the fraction plan as ticks with the load region
 * hatched (§6.29). The selected block's span is tinted `--accent-soft`.
 *
 * Pure with respect to the model: it reads `plan`, `config` and a cached token map and writes only
 * to the canvas.
 *
 * @param {HTMLCanvasElement} cv the preview canvas
 * @param {number} wCss the canvas CSS width (cached by the ResizeObserver — never read here)
 * @param {object} config frozen config
 * @param {object} plan the {@link buildPlan} result
 * @param {string|null} selectedId the selected block id, or null
 * @param {function(string,string):string} tok theme-token reader `(name, fallback) => value`
 * @returns {void}
 */
function drawPreview(cv, wCss, config, plan, selectedId, tok) {
  const g = prepCanvas(cv, wCss, PV.H);
  if (!g) return;
  const x0 = PV.PADL;
  const x1 = Math.max(x0 + 20, wCss - PV.PADR);
  const span = x1 - x0;
  const total = plan.drawn_mL > 0 ? plan.drawn_mL : 1;
  const V_mL = config.column.V_mL;
  const X = (v_mL) => x0 + span * clampN(v_mL / total, 0, 1);

  // FT-CLASSIC plot furniture: black field, dark-green graticule, service-coloured marks.
  const cLine = tok('--plot-axis', '#C7C3BC');
  const cGrid = tok('--plot-grid', '#1F3D1F');
  const cText = tok('--fld-eu', '#9FB39F');
  const cPctb = tok('--pen-pctb', '#FF6EC7');
  const cFlow = tok('--pen-flow', '#00E5FF');
  const cAlarm = tok('--fld-alarm', '#FF3B30');
  const cSample = tok('--svc-sample', '#C8862B');
  const cAccent = tok('--fld-sp', '#FFD400');
  const cAccentSoft = 'rgba(255,212,0,0.16)';
  const fontNum = tok('--font-num', 'ui-monospace, monospace');
  g.fillStyle = tok('--plot-bg', '#000000');
  g.fillRect(0, 0, wCss, PV.H);
  g.font = '9px ' + fontNum;
  g.textBaseline = 'middle';

  if (plan.rows.length === 0) {
    g.fillStyle = tok('--fld-stale', '#7A8A7A');
    g.textAlign = 'center';
    g.fillText('NO BLOCKS', wCss / 2, PV.H / 2);
    return;
  }

  // ---- selected-block span, behind everything ------------------------------------------------
  for (const r of plan.rows) {
    if (!selectedId || r.block.id !== selectedId) continue;
    g.fillStyle = cAccentSoft;
    g.fillRect(X(r.x0_mL), PV.RIB_Y, Math.max(1, X(r.x1_mL) - X(r.x0_mL)), PV.L3_Y + PV.L3_H - PV.RIB_Y);
  }

  // ---- ribbon: block boundaries and names ----------------------------------------------------
  for (const r of plan.rows) {
    const bx = X(r.x0_mL);
    g.strokeStyle = cLine;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(bx) + 0.5, PV.RIB_Y);
    g.lineTo(Math.round(bx) + 0.5, PV.L3_Y + PV.L3_H);
    g.stroke();
    const w = X(r.x1_mL) - bx;
    if (w >= 22) {
      const meta = TYPE_META[r.block.type];
      g.fillStyle = tok(meta ? meta.token : '--text-3', meta ? meta.fallback : '#71818F');
      g.fillRect(bx + 1, PV.RIB_Y + 1, Math.max(1, w - 2), 3);
      g.fillStyle = cText;
      g.textAlign = 'left';
      const label = (meta ? meta.code : '??') + ' ' + r.block.name;
      let s = label;
      while (s.length > 3 && g.measureText(s).width > w - 6) s = s.slice(0, -1);
      g.fillText(s === label ? s : s + '…', bx + 3, PV.RIB_Y + 9);
    } else if (w >= 4) {
      const meta = TYPE_META[r.block.type];
      g.fillStyle = tok(meta ? meta.token : '--text-3', meta ? meta.fallback : '#71818F');
      g.fillRect(bx + 1, PV.RIB_Y + 1, Math.max(1, w - 2), 3);
    }
  }

  // ---- lane 1: %B ----------------------------------------------------------------------------
  const yB = (pct) => PV.L1_Y + PV.L1_H * (1 - clampN(pct, 0, 100) / 100);
  g.strokeStyle = cGrid;
  g.lineWidth = 1;
  for (let p = 0; p <= 100; p += 25) {
    const y = Math.round(yB(p)) + 0.5;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
  }
  g.fillStyle = cText;
  g.textAlign = 'right';
  g.fillText('100', x0 - 3, yB(100));
  g.fillText('%B', x0 - 3, yB(50));
  g.fillText('0', x0 - 3, yB(0));

  const pts = [];
  for (const r of plan.rows) {
    const wpx = Math.max(2, X(r.x1_mL) - X(r.x0_mL));
    const n = Math.max(2, Math.min(64, Math.round(wpx / 3)));
    for (let k = 0; k <= n; k++) {
      const fr = k / n;
      pts.push([X(r.x0_mL + fr * r.vol_mL), yB(targetPctB(config, r.block, fr))]);
    }
  }
  if (pts.length > 1) {
    g.beginPath();
    g.moveTo(pts[0][0], PV.L1_Y + PV.L1_H);
    for (const p of pts) g.lineTo(p[0], p[1]);
    g.lineTo(pts[pts.length - 1][0], PV.L1_Y + PV.L1_H);
    g.closePath();
    g.globalAlpha = 0.16;
    g.fillStyle = cPctb;
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) g.lineTo(p[0], p[1]);
    g.strokeStyle = cPctb;
    g.lineWidth = 1.5;
    g.stroke();
  }

  // ---- lane 2: flow step line + the ΔP overload overlay ---------------------------------------
  const qMax = Math.max(plan.maxFlow_mLs, 1e-6) * 1.15;
  const yQ = (q) => PV.L2_Y + PV.L2_H * (1 - clampN(q / qMax, 0, 1));
  g.strokeStyle = cGrid;
  g.beginPath();
  g.moveTo(x0, Math.round(PV.L2_Y + PV.L2_H) + 0.5);
  g.lineTo(x1, Math.round(PV.L2_Y + PV.L2_H) + 0.5);
  g.stroke();
  g.fillStyle = cText;
  g.textAlign = 'right';
  g.fillText('Q', x0 - 3, PV.L2_Y + PV.L2_H / 2);
  for (const r of plan.rows) {
    if (!r.over) continue;
    g.fillStyle = cAlarm;
    g.globalAlpha = 0.22;
    g.fillRect(X(r.x0_mL), PV.L2_Y, Math.max(1, X(r.x1_mL) - X(r.x0_mL)), PV.L2_H);
    g.globalAlpha = 1;
  }
  g.beginPath();
  let started = false;
  for (const r of plan.rows) {
    const q = Number.isFinite(r.flow_mLs) ? r.flow_mLs : 0;
    const a = X(r.x0_mL);
    const b = X(r.x1_mL);
    if (!started) { g.moveTo(a, yQ(q)); started = true; } else { g.lineTo(a, yQ(q)); }
    g.lineTo(b, yQ(q));
  }
  if (started) { g.strokeStyle = cFlow; g.lineWidth = 1.5; g.stroke(); }
  for (const r of plan.rows) {
    if (!r.over) continue;
    const a = X(r.x0_mL);
    const b = X(r.x1_mL);
    const q = Number.isFinite(r.flow_mLs) ? r.flow_mLs : 0;
    g.beginPath();
    g.moveTo(a, yQ(q)); g.lineTo(b, yQ(q));
    g.strokeStyle = cAlarm;
    g.lineWidth = 2.5;
    g.stroke();
  }

  // ---- lane 3: fraction plan and the hatched load region --------------------------------------
  g.fillStyle = cText;
  g.textAlign = 'right';
  g.fillText('F', x0 - 3, PV.L3_Y + PV.L3_H / 2);
  for (const r of plan.rows) {
    const a = X(r.x0_mL);
    const b = X(r.x1_mL);
    const f = r.block.fractionation;
    if (r.block.type === 'LOAD' && r.block.sample && r.block.sample.mode) {
      g.save();
      g.beginPath();
      g.rect(a, PV.L3_Y, Math.max(1, b - a), PV.L3_H);
      g.clip();
      g.strokeStyle = cSample;
      g.globalAlpha = 0.65;
      g.lineWidth = 1;
      for (let hx = a - PV.L3_H; hx < b + PV.L3_H; hx += 5) {
        g.beginPath();
        g.moveTo(hx, PV.L3_Y + PV.L3_H);
        g.lineTo(hx + PV.L3_H, PV.L3_Y);
        g.stroke();
      }
      g.restore();
      g.globalAlpha = 1;
    }
    if (!f || f.mode === 'OFF') continue;
    if (f.mode === 'PEAK') {
      g.fillStyle = cAccent;
      g.globalAlpha = 0.35;
      g.fillRect(a, PV.L3_Y + PV.L3_H - 4, Math.max(1, b - a), 4);
      g.globalAlpha = 1;
      if (b - a > 30) {
        g.fillStyle = cAccent;
        g.textAlign = 'left';
        g.fillText('peak', a + 3, PV.L3_Y + 6);
      }
      continue;
    }
    const step_mL = f.fixedVolume.basis === 'CV' ? f.fixedVolume.value * V_mL
      : (f.fixedVolume.basis === 'mL' ? f.fixedVolume.value
        : f.fixedVolume.value * 60 * (Number.isFinite(r.flow_mLs) ? r.flow_mLs : 0));
    const pxStep = step_mL > 0 ? (step_mL / total) * span : 0;
    if (pxStep >= 2) {
      g.strokeStyle = cAccent;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = a; x <= b; x += pxStep) {
        g.moveTo(Math.round(x) + 0.5, PV.L3_Y + PV.L3_H);
        g.lineTo(Math.round(x) + 0.5, PV.L3_Y + PV.L3_H - 8);
      }
      g.stroke();
    } else {
      g.fillStyle = cAccent;
      g.globalAlpha = 0.5;
      g.fillRect(a, PV.L3_Y + PV.L3_H - 8, Math.max(1, b - a), 8);
      g.globalAlpha = 1;
    }
  }

  // ---- axis ----------------------------------------------------------------------------------
  g.strokeStyle = cLine;
  g.beginPath();
  g.moveTo(x0, Math.round(PV.L3_Y + PV.L3_H) + 0.5);
  g.lineTo(x1, Math.round(PV.L3_Y + PV.L3_H) + 0.5);
  g.stroke();
  g.fillStyle = cText;
  g.textAlign = 'left';
  g.fillText('0', x0, PV.AX_Y);
  g.textAlign = 'right';
  g.fillText(nf(plan.drawn_mL / V_mL, 1) + ' CV  ·  ' + nf(plan.drawn_mL, 0) + ' mL', x1, PV.AX_Y);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * 10. THE VIEW
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Debounce for the recompute + repaint pass, ms (§6.29). */
const DEBOUNCE_MS = 60;
/** Undo snapshots are coalesced inside this window so typing a number is one undo step, ms. */
const UNDO_GATE_MS = 700;
/** Maximum undo depth. */
const UNDO_DEPTH = 80;

/**
 * Create the Method tab.
 *
 * The returned Panel follows §6.24 exactly: `update(frameInfo)` is called at most once per rAF
 * frame by `ui/app.js`, renders only, and mutates neither `config` nor `run`. Two extra methods,
 * `exportMethod()` and `importMethod()`, are exposed so the shell can bind `Ctrl+S` / `Ctrl+O`
 * (§9.5) without reaching into the DOM; the same two actions are also reachable on the bus through
 * `'method-export-requested'` / `'method-import-requested'`.
 *
 * @param {Element} rootEl the element the view mounts into
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx
 *   the §2.4 context. `ctx.sim` is `core/sim.js` — the only mutation surface this view touches.
 * @returns {{el:Element, mount:function():void, update:function(object):void,
 *            destroy:function():void, exportMethod:function():void, importMethod:function():void}}
 *   the Panel
 */
export function createMethodView(rootEl, ctx) {
  const doc = rootEl.ownerDocument || document;
  acquireStyles(doc);

  const root = mk(doc, 'div', 'vm-root');

  /**
   * The overlay bundle. `host` is resolved LAZILY and on every read: §6.33 says there must be one
   * host for the whole app, and `ui/app.js` owns it — but the §2.4 `ctx` shape has no slot for it,
   * so a view cannot be handed one. Reading `ctx.overlayHost` each time means that the moment the
   * shell does expose it, this view uses the shared stack; only if it never does, and only when a
   * floating surface is actually needed, does this view fall back to one of its own.
   */
  const ui = {
    doc, root, timers: [], own: null,
    get host() {
      if (ctx && ctx.overlayHost) return ctx.overlayHost;
      if (this.own === null) {
        try { this.own = createOverlayHost(root); } catch (e) { this.own = false; }
      }
      return this.own || null;
    },
  };

  /** Everything mutable this view owns. `draft` is the ONLY method object it writes to. */
  const S = {
    draft: null,            // plain, mutable working copy of ctx.config.method
    norm: null,             // normalizeMethod(config, draft) — the validated / previewed object
    validation: { ok: true, errors: [], warnings: [] },
    plan: null,
    prc: null,              // last sim.validateAndReady result, for the INSTALLED method
    selectedId: null,
    dirty: false,
    undo: [], redo: [], undoGate: 0,
    // The debounce is measured ENTIRELY on the frame clock `ui/app.js` passes in. Scheduling with
    // `performance.now()` and servicing with `frameInfo.now_ms` compares two clocks that are only
    // incidentally the same one, and a host that passes any other time base would stall the editor
    // for good. `pendingSince` is stamped on the first frame that sees the request.
    pending: false, pendingSince: 0, pendingImmediate: false,
    editorKey: '',
    fields: [],
    collapsed: Object.create(null),
    canvasW: 300,
    readOnly: false,
    lastState: '',
    selfCommit: false,
    tok: (n, f) => f,
  };

  /* ── theme tokens ─────────────────────────────────────────────────────────────────────────── */

  /**
   * Re-read the cached theme token map (§6.25). Called at mount, on a `data-theme` change and on a
   * `prefers-color-scheme` change — never per frame.
   * @returns {void}
   */
  function refreshTokens() {
    // The FT-CLASSIC palette is declared on `.vm-root` itself, so the live computed value of this
    // view's own root is the authority — a canvas cannot use `var()` and must be handed hex.
    let cs = null;
    try {
      const view = doc.defaultView;
      cs = (view && typeof view.getComputedStyle === 'function') ? view.getComputedStyle(root) : null;
    } catch (e) { cs = null; }
    const map = Object.create(null);
    S.tok = (name, fallback) => {
      let v = map[name];
      if (v === undefined) {
        let read = '';
        try { read = cs ? (cs.getPropertyValue(name) || '').trim() : ''; } catch (e) { read = ''; }
        v = read;
        map[name] = v;
      }
      return v || fallback;
    };
  }
  refreshTokens();

  /* ── draft lifecycle ──────────────────────────────────────────────────────────────────────── */

  /**
   * Replace the draft wholesale and reset the edit history.
   * @param {object} m the method to clone into the draft
   * @param {boolean} dirty whether the new draft differs from what is installed
   * @returns {void}
   */
  function setDraft(m, dirty) {
    S.draft = clone(m);
    if (!Array.isArray(S.draft.blocks)) S.draft.blocks = [];
    S.undo.length = 0;
    S.redo.length = 0;
    S.dirty = !!dirty;
    if (!S.draft.blocks.some((b) => b.id === S.selectedId)) {
      S.selectedId = S.draft.blocks.length ? S.draft.blocks[0].id : null;
    }
    S.editorKey = '';
    recomputeNow();
  }

  /** @returns {object|null} the selected block in the DRAFT, or null */
  function selected() {
    if (!S.draft || !S.selectedId) return null;
    return S.draft.blocks.find((b) => b.id === S.selectedId) || null;
  }

  /** @returns {{json:string, sel:string|null}} a snapshot of the current draft */
  function snapshot() {
    return { json: JSON.stringify(S.draft), sel: S.selectedId };
  }

  /**
   * The single mutation entry point. Snapshots for undo (coalesced inside {@link UNDO_GATE_MS} so
   * typing a number is one step), runs `fn`, marks the draft dirty and schedules the debounced
   * recompute + repaint.
   *
   * @param {function():void} fn the mutation, applied to `S.draft`
   * @param {boolean} [structural] true when the block list itself changed, forcing a list rebuild
   * @returns {void}
   */
  function edit(fn, structural) {
    if (S.readOnly) return;
    const now = Date.now();
    if (structural || now - S.undoGate > UNDO_GATE_MS) {
      S.undo.push(snapshot());
      if (S.undo.length > UNDO_DEPTH) S.undo.shift();
      S.redo.length = 0;
    }
    S.undoGate = now;
    fn();
    S.dirty = true;
    if (structural) S.editorKey = '';
    schedule();
  }

  /** Undo one edit step. @returns {void} */
  function undo() {
    if (!S.undo.length) { toast(ui, 'Nothing to undo.', 'info'); return; }
    S.redo.push(snapshot());
    const s = S.undo.pop();
    S.draft = JSON.parse(s.json);
    S.selectedId = s.sel;
    S.dirty = true;
    S.editorKey = '';
    announce('Undone.');
    recomputeNow();
  }

  /** Redo one undone step. @returns {void} */
  function redo() {
    if (!S.redo.length) { toast(ui, 'Nothing to redo.', 'info'); return; }
    S.undo.push(snapshot());
    const s = S.redo.pop();
    S.draft = JSON.parse(s.json);
    S.selectedId = s.sel;
    S.dirty = true;
    S.editorKey = '';
    announce('Redone.');
    recomputeNow();
  }

  /** Arm the 60 ms debounce (§6.29). Serviced inside `update`, never by a timer. @returns {void} */
  function schedule() {
    S.pending = true;
    S.pendingSince = 0;
    S.pendingImmediate = false;
  }

  /**
   * Normalise → validate → plan, then repaint everything that depends on the draft. Called on the
   * debounce, and directly whenever the draft is replaced.
   * @returns {void}
   */
  function recomputeNow() {
    S.pending = false;
    S.pendingSince = 0;
    S.pendingImmediate = false;
    const config = ctx.config;
    try {
      S.norm = normalizeMethod(config, S.draft);
    } catch (err) {
      S.norm = null;
      S.validation = { ok: false, warnings: [],
        errors: [{ blockId: null, field: null, level: 'error', code: 'NORMALISE_FAILED',
          message: 'The method could not be normalised: ' + ((err && err.message) || String(err)) }] };
      S.plan = buildPlan(config, { blocks: [] });
      renderAll();
      return;
    }
    try {
      S.validation = validateMethod(config, S.norm);
    } catch (err) {
      S.validation = { ok: false, warnings: [],
        errors: [{ blockId: null, field: null, level: 'error', code: 'VALIDATE_FAILED',
          message: 'Validation threw: ' + ((err && err.message) || String(err)) }] };
    }
    S.plan = buildPlan(config, S.norm);
    renderAll();
    const first = S.validation.errors[0];
    if (ctx.bus && typeof ctx.bus.emit === 'function') {
      // The shell disables Start while any error exists and names the first one in the tooltip
      // (§6.29). It is told, rather than made to re-derive the same validation pass.
      ctx.bus.emit('method-validation', {
        ok: S.validation.errors.length === 0,
        firstError: first ? (first.code + ': ' + first.message) : null,
        errors: S.validation.errors.length, warnings: S.validation.warnings.length,
        dirty: S.dirty,
      });
    }
  }

  /* ── commit / revert ──────────────────────────────────────────────────────────────────────── */

  /**
   * Install the draft through `sim.loadMethod` (§2.4) — the ONLY write path out of this view.
   * @param {boolean} [quiet] suppress the success toast (used by the template / import flows)
   * @returns {boolean} true when the method was installed
   */
  function commit(quiet) {
    if (!ctx.sim || typeof ctx.sim.loadMethod !== 'function') {
      toast(ui, 'The simulation actions are unavailable.', 'blocked');
      return false;
    }
    if (S.validation.errors.length > 0) {
      const e = S.validation.errors[0];
      toast(ui, 'Blocked: ' + e.code + ' — ' + e.message, 'blocked');
      return false;
    }
    const submitted = clone(S.draft);
    S.selfCommit = true;
    const res = ctx.sim.loadMethod(ctx, submitted);
    S.selfCommit = false;
    if (!res || res.ok !== true) {
      // §9.4.4: an interlock is explained, never a silent refusal.
      let handled = false;
      try {
        if (ui.host) { reportResult(ui.host, res, 'The method was rejected.'); handled = true; }
      } catch (e) { handled = false; }
      if (!handled) toast(ui, 'Blocked: ' + ((res && res.reason) || 'the method was rejected'), 'blocked');
      return false;
    }
    // `loadMethod` reports `{ok:true}` once the rebuild has not thrown; it does not verify that the
    // method it was handed is the one that came back. Confirm it, because silently reverting an
    // operator's edits behind a "Method applied" toast is the worst possible failure mode here.
    if (!sameMethod(ctx.config, submitted, ctx.config.method)) {
      S.dirty = true;
      renderAll();
      toast(ui, 'The skid accepted the method but installed a different one — your edits are still '
        + 'in the editor and were NOT applied. Report this: normalizePreset ignores the `method` '
        + 'override.', 'blocked');
      announce('The method was not installed. Your edits are still in the editor.');
      return false;
    }
    S.dirty = false;
    setDraft(ctx.config.method, false);
    schedulePreRunChecks();
    if (!quiet) toast(ui, 'Method applied.', 'info');
    announce('Method applied.');
    return true;
  }

  /**
   * Do two methods describe the same run? Compares the fields the engine actually sequences on,
   * after normalising both against the same config, so an `authoredAs` difference or a re-derived
   * `_raw` cannot raise a false alarm.
   *
   * @param {object} config the config both are normalised against
   * @param {object} a one method
   * @param {object} b the other
   * @returns {boolean} true when the two would run identically
   */
  function sameMethod(config, a, b) {
    try {
      return methodDigest(config, a) === methodDigest(config, b);
    } catch (e) {
      return true;   // if either will not normalise, the validation rail is the honest reporter
    }
  }

  /**
   * A compact structural digest of a method: everything the block engine sequences on.
   * @param {object} config frozen config
   * @param {object} m a method, authored or normalised
   * @returns {string} the digest
   */
  function methodDigest(config, m) {
    const n = normalizeMethod(config, m);
    return JSON.stringify(n.blocks.map((b) => [b.id, b.type, b.enabled,
      b.duration.basis, b.duration.value, b.duration.onTimeout,
      b.flow.mode, b.flow.value, b.inlets.a, b.inlets.b, b.inlets.sample,
      b.gradient.shape, b.gradient.startPctB, b.gradient.endPctB, b.gradient.curvature,
      b.gradient.lengthFraction, b.columnValve, b.outletDefault,
      b.sample.mode, b.sample.loopVolume_mL, b.sample.chaseVolume_CV,
      b.fractionation.mode, b.fractionation.signal, b.fractionation.startThreshold.value,
      b.fractionation.stopThreshold.value, b.autozero, b.holdAtEnd,
      b.watches.map((w) => [w.signal, w.operator, w.threshold, w.action, w.actionParam])]));
  }

  /** Discard every uncommitted edit and re-derive the draft from the installed method. @returns {void} */
  function revert() {
    setDraft(ctx.config.method, false);
    announce('Draft reverted to the installed method.');
  }

  /**
   * Run the twelve pre-run checks against the INSTALLED method (§5.5.1). Deliberately not run per
   * keystroke: `validateAndReady` reads `config`/`run`, not the draft, so running it against
   * uncommitted edits would report the wrong thing — and it arms the run when the checks pass.
   * @returns {void}
   */
  function schedulePreRunChecks() {
    if (!ctx.sim || typeof ctx.sim.validateAndReady !== 'function') { S.prc = null; return; }
    const st = ctx.run.state;
    if (st !== 'IDLE' && st !== 'READY') { S.prc = null; renderPRC(); return; }
    try {
      S.prc = ctx.sim.validateAndReady(ctx);
    } catch (err) {
      S.prc = { ok: false, failures: [{ code: 'PRC-XX', acknowledgeable: false,
        message: 'Pre-run checks threw: ' + ((err && err.message) || String(err)) }] };
    }
    renderPRC();
  }

  /* ── DOM skeleton (built once, at construction; no innerHTML anywhere) ─────────────────────── */

  const note = mk(doc, 'div', 'vm-note');
  note.style.display = 'none';
  const grid = mk(doc, 'div', 'vm-grid');

  // Left: the block list.
  const listPanel = mk(doc, 'section', 'vm-panel');
  const listHd = mk(doc, 'div', 'vm-hd');
  const listCount = mk(doc, 'span', 'vm-hd__n', '0');
  listCount.title = 'Blocks in the draft method';
  add(listHd, mk(doc, 'span', null, 'BLOCKS'), mk(doc, 'span', 'vm-hd__sp'), listCount);
  const listWrap = mk(doc, 'div', 'vm-listwrap vm-scroll');
  const listEl = mk(doc, 'div', 'vm-list');
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Method blocks');
  const insertLine = mk(doc, 'div', 'vm-insert');
  add(listWrap, listEl, insertLine);
  const listFt = mk(doc, 'div', 'vm-ft');
  add(listPanel, listHd, listWrap, listFt);

  // Centre: the block editor.
  const edPanel = mk(doc, 'section', 'vm-panel');
  const edHd = mk(doc, 'div', 'vm-hd');
  const edTitle = mk(doc, 'span', null, 'BLOCK');
  const edId = mk(doc, 'span', 'vm-hd__n', '');
  edId.title = 'Selected block id';
  add(edHd, edTitle, mk(doc, 'span', 'vm-hd__sp'), edId);
  const edBody = mk(doc, 'div', 'vm-scroll');
  edBody.setAttribute('role', 'group');
  edBody.setAttribute('aria-label', 'Block parameters');
  add(edPanel, edHd, edBody);

  // Right: preview, validation, pre-run checks, templates, file.
  const rail = mk(doc, 'aside', 'vm-rail');

  const pvPanel = mk(doc, 'section', 'vm-panel');
  const pvHd = mk(doc, 'div', 'vm-hd');
  add(pvHd, mk(doc, 'span', null, 'PREVIEW'));
  const pvBody = mk(doc, 'div', 'vm-prev');
  const canvas = mk(doc, 'canvas');
  canvas.setAttribute('role', 'img');
  const stats = mk(doc, 'div', 'vm-prev__stats');
  const statNodes = {};
  const STAT_TAGS = [
    ['Total volume', 'V-TOT', 'Total volume of every enabled block'],
    ['Total time', 'T-TOT', 'Total run time of every enabled block'],
    ['Buffer A / B', 'A / B', 'Buffer A and buffer B demand, litres'],
  ];
  for (const [k, tag, title] of STAT_TAGS) {
    const s = mk(doc, 'div', 'vm-stat');
    s.title = title;
    const v = mk(doc, 'div', 'vm-stat__v', '—');
    add(s, mk(doc, 'div', 'vm-stat__k', tag), v);
    add(stats, s);
    statNodes[k] = v;
  }
  add(pvBody, canvas, stats);
  add(pvPanel, pvHd, pvBody);

  const vdPanel = mk(doc, 'section', 'vm-panel');
  const vdHd = mk(doc, 'div', 'vm-hd');
  const vdLamp = mk(doc, 'span', 'vm-dot');
  const vdCount = mk(doc, 'span', 'vm-hd__n', '0/0');
  vdCount.title = 'Errors / warnings';
  add(vdHd, mk(doc, 'span', null, 'VALIDATION'), mk(doc, 'span', 'vm-hd__sp'), vdLamp, vdCount);
  const vdBody = mk(doc, 'div', 'vm-scroll');
  vdBody.setAttribute('role', 'list');
  add(vdPanel, vdHd, vdBody);

  const prcPanel = mk(doc, 'section', 'vm-panel');
  const prcHd = mk(doc, 'div', 'vm-hd');
  const prcLamp = mk(doc, 'span', 'vm-dot');
  const prcBtn = iconBtn(doc, 'recheck',
    'Run the twelve pre-run checks against the installed method (PRC-01 … PRC-12)',
    schedulePreRunChecks, 'vm-btn--sm');
  add(prcHd, mk(doc, 'span', null, 'PRE-RUN'), mk(doc, 'span', 'vm-hd__sp'), prcLamp, prcBtn);
  const prcBody = mk(doc, 'div', 'vm-scroll');
  prcBody.setAttribute('role', 'list');
  add(prcPanel, prcHd, prcBody);

  const tplPanel = mk(doc, 'section', 'vm-panel');
  const tplHd = mk(doc, 'div', 'vm-hd');
  add(tplHd, mk(doc, 'span', null, 'TEMPLATES'));
  const tplBody = mk(doc, 'div', 'vm-scroll');
  add(tplPanel, tplHd, tplBody);

  const ioPanel = mk(doc, 'section', 'vm-panel');
  const ioHd = mk(doc, 'div', 'vm-hd');
  add(ioHd, mk(doc, 'span', null, 'FILE'));
  const ioFt = mk(doc, 'div', 'vm-ft');
  const fileInput = mk(doc, 'input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.className = 'vm-sr';
  fileInput.setAttribute('aria-label', 'Choose a method JSON file');
  add(ioPanel, ioHd, ioFt, fileInput);

  add(rail, pvPanel, vdPanel, prcPanel, tplPanel, ioPanel);
  add(grid, listPanel, edPanel, rail);

  // Commit bar.
  const bar = mk(doc, 'div', 'vm-bar');
  const barLamp = mk(doc, 'span', 'vm-dot');
  const barMsg = mk(doc, 'div', 'vm-bar__msg', '');
  const btnRevert = iconBtn(doc, 'revert', 'Discard draft edits and reload the installed method', () => {
    if (!S.dirty) { toast(ui, 'The draft already matches the installed method.', 'info'); return; }
    modal(ui, { title: 'Discard draft edits?',
      content: mk(doc, 'div', null, 'The block list will be reloaded from the installed method. '
        + 'This cannot be undone.'),
      actions: [{ label: 'Keep editing' }, { label: 'Discard', variant: 'danger', onClick: revert }] });
  });
  const btnApply = iconBtn(doc, 'apply', 'Install this method through sim.loadMethod',
    () => commit(false), 'vm-btn--primary');
  add(bar, barLamp, barMsg, mk(doc, 'div', 'vm-bar__sp'), btnRevert, btnApply);

  const drop = mk(doc, 'div', 'vm-drop');
  add(drop, mk(doc, 'div', 'vm-drop__in', 'DROP .JSON'));
  const live = mk(doc, 'div', 'vm-sr');
  live.setAttribute('aria-live', 'polite');
  add(root, note, grid, bar, drop, live);

  /**
   * Put one sentence into the polite live region (§9.7). Rebuilt, never appended, so a screen
   * reader announces once.
   * @param {string} msg the sentence
   * @returns {void}
   */
  function announce(msg) {
    setText(live, msg);
  }

  /* ── list footer actions ──────────────────────────────────────────────────────────────────── */

  /**
   * Build one footer button: an icon, with the words in `title` (§9.7).
   * @param {string} name a key of {@link ICONS}
   * @param {string} title tooltip, which also explains why the button is disabled (§9.7)
   * @param {function():void} onClick handler
   * @returns {HTMLButtonElement} the button
   */
  function ftBtn(name, title, onClick) {
    const b = iconBtn(doc, name, title, onClick, 'vm-btn--sm');
    add(listFt, b);
    return b;
  }

  const btnAdd = ftBtn('add', 'Insert a new block after the selected one', () => openTypePalette());
  const btnDup = ftBtn('duplicate', 'Copy the selected block and insert it below', () => duplicateBlock());
  const btnDel = ftBtn('del', 'Remove the selected block (Ctrl+Z undoes it)', () => deleteBlock());
  const btnUp = ftBtn('up', 'Move the selected block up (Alt+Up)', () => nudge(-1));
  const btnDown = ftBtn('down', 'Move the selected block down (Alt+Down)', () => nudge(1));
  const btnUndo = ftBtn('undo', 'Undo the last edit (Ctrl+Z)', undo);
  const btnRedo = ftBtn('redo', 'Redo (Ctrl+Shift+Z)', redo);

  /** @returns {number} the selected block's index in the draft, or -1 */
  function selIndex() {
    if (!S.draft) return -1;
    return S.draft.blocks.findIndex((b) => b.id === S.selectedId);
  }

  /**
   * Open the block-type palette: the twelve `BLOCK_TYPES` of §5.4.3 in contract order.
   * @returns {void}
   */
  function openTypePalette() {
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    const body = mk(doc, 'div');
    body.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:4px;';
    for (const t of BLOCK_TYPES) {
      const meta = TYPE_META[t];
      // The face carries the two-letter §5.4.3 code; the name is in the tooltip.
      const b = mk(doc, 'button', 'vm-btn', meta.code);
      b.type = 'button';
      b.title = meta.label;
      b.setAttribute('aria-label', meta.label);
      b.addEventListener('click', () => addBlock(t));
      add(body, b);
    }
    modal(ui, { title: 'Add a block', content: body, actions: [{ label: 'Cancel' }] });
  }

  /**
   * Insert a new block of `type` after the selection (or at the end when nothing is selected).
   * @param {string} type one of `BLOCK_TYPES`
   * @returns {void}
   */
  function addBlock(type) {
    const at = selIndex();
    const b = makeBlock(ctx.config, type, nextBlockId(S.draft.blocks));
    edit(() => { S.draft.blocks.splice(at < 0 ? S.draft.blocks.length : at + 1, 0, b); }, true);
    S.selectedId = b.id;
    announce(TYPE_META[type].label + ' block added.');
    recomputeNow();
  }

  /** Duplicate the selected block, giving the copy a fresh id. @returns {void} */
  function duplicateBlock() {
    const i = selIndex();
    if (i < 0) { toast(ui, 'Select a block first.', 'info'); return; }
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    const copy = clone(S.draft.blocks[i]);
    copy.id = nextBlockId(S.draft.blocks);
    copy.name = copy.name + ' (copy)';
    edit(() => { S.draft.blocks.splice(i + 1, 0, copy); }, true);
    S.selectedId = copy.id;
    announce('Block duplicated.');
    recomputeNow();
  }

  /** Delete the selected block. Undoable with `Ctrl+Z` (§9.7). @returns {void} */
  function deleteBlock() {
    const i = selIndex();
    if (i < 0) { toast(ui, 'Select a block first.', 'info'); return; }
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    if (S.draft.blocks.length <= 1) {
      toast(ui, 'Blocked: a method needs at least one block.', 'blocked');
      return;
    }
    const name = S.draft.blocks[i].name;
    edit(() => { S.draft.blocks.splice(i, 1); }, true);
    const next = S.draft.blocks[Math.min(i, S.draft.blocks.length - 1)];
    S.selectedId = next ? next.id : null;
    announce(name + ' deleted. Ctrl+Z undoes it.');
    recomputeNow();
  }

  /**
   * Move the selected block by `delta` positions.
   * @param {number} delta -1 for up, +1 for down
   * @returns {void}
   */
  function nudge(delta) {
    const i = selIndex();
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= S.draft.blocks.length) return;
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    edit(() => {
      const [b] = S.draft.blocks.splice(i, 1);
      S.draft.blocks.splice(j, 0, b);
    }, true);
    announce('Moved to position ' + (j + 1) + ' of ' + S.draft.blocks.length + '.');
    recomputeNow();
    const rowEl = listEl.querySelector('[data-block-id="' + S.selectedId + '"]');
    if (rowEl && rowEl.focus) rowEl.focus();
  }

  /**
   * Move a block from one index to another — the commit step of a pointer drag.
   * @param {number} from source index
   * @param {number} to destination index
   * @returns {void}
   */
  function moveBlock(from, to) {
    if (from === to || from < 0 || to < 0) return;
    edit(() => {
      const [b] = S.draft.blocks.splice(from, 1);
      S.draft.blocks.splice(to, 0, b);
    }, true);
    announce('Moved to position ' + (to + 1) + ' of ' + S.draft.blocks.length + '.');
    recomputeNow();
  }

  /** @returns {string} why editing is disabled right now, phrased for a tooltip (§9.7) */
  function readOnlyReason() {
    return 'The method cannot be changed while the run is ' + ctx.run.state
      + ' — it is legal in IDLE, READY and ENDED only.';
  }

  /* ── block list ───────────────────────────────────────────────────────────────────────────── */

  /**
   * The one-line parameter summary on a list row, e.g. `6.0 CV @ 150 cm/h · 0→100 %B`.
   * @param {object} b a draft block
   * @returns {string} the summary
   */
  function blockSummary(b) {
    const d = b.duration || {};
    const f = b.flow || {};
    const basis = d.basis === 'CV_OF_SAMPLE' ? 'CV(sample)' : (d.basis || 'CV');
    let s = nf(d.value, basis === 'CV' || basis === 'CV(sample)' ? 2 : 1) + ' ' + basis;
    s += ' @ ' + (f.mode === 'INHERIT' ? 'inherit' : nf(f.value, 1) + ' ' + (FLOW_MODE_UNIT[f.mode] || ''));
    const g = b.gradient || {};
    if (g.shape && g.shape !== 'ISOCRATIC') s += ' · ' + nf(g.startPctB, 0) + '→' + nf(g.endPctB, 0) + ' %B';
    else if (g.startPctB) s += ' · ' + nf(g.startPctB, 0) + ' %B';
    if (b.fractionation && b.fractionation.mode !== 'OFF') s += ' · frac';
    return s;
  }

  /** @param {string} id a block id @returns {'err'|'warn'|'ok'} the worst issue level on that block */
  function blockLevel(id) {
    for (const e of S.validation.errors) if (e.blockId === id) return 'err';
    for (const w of S.validation.warnings) if (w.blockId === id) return 'warn';
    return 'ok';
  }

  const drag = { on: false, pointerId: null, from: -1, target: -1, el: null, startY: 0,
    tops: [], heights: [] };

  /**
   * Begin a pointer reorder. Pointer events plus `transform: translateY` and a 2 px accent
   * insertion line — never HTML5 drag-and-drop (§6.29).
   * @param {PointerEvent} ev the pointerdown on a row grip
   * @param {HTMLElement} rowEl the row being dragged
   * @returns {void}
   */
  function dragStart(ev, rowEl) {
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    if (ev.button !== undefined && ev.button !== 0) return;
    const kids = Array.prototype.slice.call(listEl.children);
    const from = kids.indexOf(rowEl);
    if (from < 0) return;
    ev.preventDefault();
    drag.on = true;
    drag.pointerId = ev.pointerId;
    drag.from = from;
    drag.target = from;
    drag.el = rowEl;
    drag.startY = ev.clientY;
    drag.tops = kids.map((k) => k.offsetTop);
    drag.heights = kids.map((k) => k.offsetHeight);
    cls(rowEl, 'is-drag', true);
    if (rowEl.setPointerCapture) { try { rowEl.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
    doc.addEventListener('pointermove', dragMove);
    doc.addEventListener('pointerup', dragEnd);
    doc.addEventListener('pointercancel', dragEnd);
  }

  /**
   * Track the drag: translate the dragged row, shift the rows it passes, move the insertion line.
   * @param {PointerEvent} ev the pointermove
   * @returns {void}
   */
  function dragMove(ev) {
    if (!drag.on) return;
    const dy = ev.clientY - drag.startY;
    drag.el.style.transform = 'translateY(' + dy + 'px)';
    const h = drag.heights[drag.from];
    const centre = drag.tops[drag.from] + dy + h / 2;
    let target = 0;
    for (let i = 0; i < drag.tops.length; i++) {
      if (i === drag.from) continue;
      if (centre > drag.tops[i] + drag.heights[i] / 2) target++;
    }
    drag.target = target;
    const kids = listEl.children;
    for (let i = 0; i < kids.length; i++) {
      if (i === drag.from) continue;
      let shift = 0;
      if (drag.from < target && i > drag.from && i <= target) shift = -h;
      else if (target < drag.from && i >= target && i < drag.from) shift = h;
      kids[i].style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    }
    if (target === drag.from) {
      cls(insertLine, 'is-on', false);
    } else {
      const y = target > drag.from ? drag.tops[target] + drag.heights[target] : drag.tops[target];
      insertLine.style.top = (y - 1) + 'px';
      cls(insertLine, 'is-on', true);
    }
  }

  /**
   * Finish the drag: clear every transform, then commit the move.
   * @returns {void}
   */
  function dragEnd() {
    if (!drag.on) return;
    doc.removeEventListener('pointermove', dragMove);
    doc.removeEventListener('pointerup', dragEnd);
    doc.removeEventListener('pointercancel', dragEnd);
    const kids = listEl.children;
    for (let i = 0; i < kids.length; i++) kids[i].style.transform = '';
    cls(drag.el, 'is-drag', false);
    cls(insertLine, 'is-on', false);
    drag.on = false;
    if (drag.target !== drag.from) moveBlock(drag.from, drag.target);
  }

  /**
   * Keyboard handling on a block row: roving focus with the arrows, `Alt+↑/↓` to reorder (§6.29),
   * `Enter`/`Space` to select, `Delete` to remove.
   * @param {KeyboardEvent} ev the keydown
   * @param {object} b the block the row shows
   * @returns {void}
   */
  function rowKey(ev, b) {
    const i = S.draft.blocks.findIndex((x) => x.id === b.id);
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      S.selectedId = b.id;
      nudge(ev.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const j = clampN(i + (ev.key === 'ArrowUp' ? -1 : 1), 0, S.draft.blocks.length - 1);
      select(S.draft.blocks[j].id);
      const el = listEl.querySelector('[data-block-id="' + S.draft.blocks[j].id + '"]');
      if (el && el.focus) el.focus();
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(b.id); return; }
    if (ev.key === 'Delete') { ev.preventDefault(); select(b.id); deleteBlock(); }
  }

  /**
   * Select a block: it becomes the editor's subject and the preview's highlighted span.
   * @param {string} id the block id
   * @returns {void}
   */
  function select(id) {
    if (S.selectedId === id) return;
    S.selectedId = id;
    S.editorKey = '';
    renderList();
    renderEditor();
    schedulePreview();
  }

  /** Repaint on the very next frame, with no debounce — used when only the selection moved. @returns {void} */
  function schedulePreview() {
    if (S.pending) return;
    S.pending = true;
    S.pendingImmediate = true;
  }

  /**
   * Render the block list with the app's one reconciler (§6.25). Rows are keyed by block id, so a
   * reorder is an `insertBefore` walk and the focused row keeps its identity.
   * @returns {void}
   */
  function renderList() {
    const blocks = S.draft ? S.draft.blocks : [];
    setText(listCount, String(blocks.length));
    reconcileList(listEl, blocks, (b) => b.id, (b) => {
      const row = mk(doc, 'div', 'vm-row');
      row.setAttribute('role', 'option');
      const grip = mk(doc, 'span', 'vm-row__grip', '⠿');
      grip.setAttribute('aria-hidden', 'true');
      const bar = mk(doc, 'span', 'vm-row__bar');
      const mid = mk(doc, 'span', 'vm-row__mid');
      const top = mk(doc, 'span', 'vm-row__top');
      const code = mk(doc, 'span', 'vm-row__code');
      const name = mk(doc, 'span', 'vm-row__name');
      add(top, code, name);
      const sum = mk(doc, 'span', 'vm-row__sum');
      add(mid, top, sum);
      const right = mk(doc, 'span', 'vm-row__right');
      const dot = mk(doc, 'span', 'vm-dot');
      const lab = mk(doc, 'label', 'vm-tg');
      const cb = mk(doc, 'input');
      cb.type = 'checkbox';
      const tr = mk(doc, 'span', 'vm-tg__tr');
      add(lab, cb, tr);
      add(right, dot, lab);
      add(row, grip, bar, mid, right);
      row._parts = { code, name, sum, dot, bar, cb, lab, grip };
      row.addEventListener('click', () => select(row.getAttribute('data-block-id')));
      row.addEventListener('keydown', (ev) => rowKey(ev, blockById(row.getAttribute('data-block-id'))));
      grip.addEventListener('pointerdown', (ev) => dragStart(ev, row));
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      cb.addEventListener('change', () => {
        const id = row.getAttribute('data-block-id');
        const blk = blockById(id);
        if (!blk) return;
        if (S.readOnly) { cb.checked = blk.enabled; toast(ui, readOnlyReason(), 'blocked'); return; }
        edit(() => { blk.enabled = cb.checked; }, true);
        announce(blk.name + (blk.enabled ? ' enabled.' : ' disabled — it stays in the file.'));
        recomputeNow();
      });
      return row;
    }, (row, b) => {
      const meta = TYPE_META[b.type] || { code: '??', label: b.type, token: '--text-3', fallback: '#71818F' };
      const p = row._parts;
      setAttr(row, 'data-block-id', b.id);
      row.style.transform = '';
      setText(p.code, meta.code);
      setText(p.name, b.name || meta.label);
      setText(p.sum, blockSummary(b));
      p.bar.style.background = S.tok(meta.token, meta.fallback);
      const lvl = blockLevel(b.id);
      cls(p.dot, 'vm-dot--err', lvl === 'err');
      cls(p.dot, 'vm-dot--warn', lvl === 'warn');
      cls(p.dot, 'vm-dot--ok', lvl === 'ok');
      setAttr(p.dot, 'title', lvl === 'err' ? 'This block has a blocking error'
        : (lvl === 'warn' ? 'This block has a warning' : 'No issues'));
      if (p.cb.checked !== !!b.enabled) p.cb.checked = !!b.enabled;
      p.cb.disabled = S.readOnly;
      setAttr(p.lab, 'title', b.enabled ? 'Disable this block (it stays in the file)' : 'Enable this block');
      setAttr(p.cb, 'aria-label', (b.enabled ? 'Disable ' : 'Enable ') + (b.name || meta.label));
      const sel = b.id === S.selectedId;
      cls(row, 'is-selected', sel);
      cls(row, 'is-off', !b.enabled);
      setAttr(row, 'aria-selected', sel ? 'true' : 'false');
      row.tabIndex = sel ? 0 : -1;
      setAttr(row, 'aria-label', meta.label + ': ' + (b.name || '') + '. ' + blockSummary(b)
        + (b.enabled ? '' : '. Disabled'));
    });
    const i = selIndex();
    btnDup.disabled = i < 0 || S.readOnly;
    btnDel.disabled = i < 0 || S.readOnly || blocks.length <= 1;
    btnUp.disabled = i <= 0 || S.readOnly;
    btnDown.disabled = i < 0 || i >= blocks.length - 1 || S.readOnly;
    btnAdd.disabled = S.readOnly;
    btnUndo.disabled = S.undo.length === 0 || S.readOnly;
    btnRedo.disabled = S.redo.length === 0 || S.readOnly;
    if (S.readOnly) {
      for (const b of [btnAdd, btnDup, btnDel, btnUp, btnDown, btnUndo, btnRedo]) b.title = readOnlyReason();
    }
  }

  /** @param {string|null} id a block id @returns {object|null} that block in the draft */
  function blockById(id) {
    if (!S.draft || !id) return null;
    return S.draft.blocks.find((b) => b.id === id) || null;
  }

  /* ── block editor ─────────────────────────────────────────────────────────────────────────── */

  /** The persistent form context handed to every control factory of §7. */
  const F = { doc, ui, parent: edBody, fields: S.fields, edit, readOnly: false };

  /**
   * The four linked flow expressions of §6.25 for one volumetric flow.
   * @param {object} config frozen config
   * @param {number} Q_mLs flow, mL/s
   * @returns {{Q_mLs:number, u_cmh:number, RT_min:number, CVh:number}} the group
   */
  function flowGroup(config, Q_mLs) {
    try {
      const g = linkedFlowGroup(config, { Q_mLs });
      if (g && Number.isFinite(g.u_cmh)) return g;
    } catch (e) { /* fall through to the local derivation */ }
    const A = config.column.A_cm2;
    const V = config.column.V_mL;
    return { Q_mLs, u_cmh: Q_mLs * 3600 / A, RT_min: Q_mLs > 0 ? V / (Q_mLs * 60) : NaN,
      CVh: Q_mLs * 3600 / V };
  }

  /**
   * The structural signature of the editor form. When it changes, the form is rebuilt; when it does
   * not, only values and error states are refreshed — so a caret never jumps mid-edit (§6.24).
   * @param {object|null} b the selected block
   * @returns {string} the signature
   */
  function editorKeyFor(b) {
    if (!b) return 'none';
    const f = b.fractionation || {};
    return [b.id, b.type, (b.gradient || {}).shape, f.mode,
      (f.startThreshold || {}).type, (f.stopThreshold || {}).type,
      (b.sample || {}).mode, (b.duration || {}).onTimeout, (b.watches || []).length,
      (b.watches || []).map((w) => w.operator + '>' + w.action).join(',')].join('|');
  }

  /**
   * Add a collapsible section to the editor and return its body, ready to receive fields.
   * @param {string} title the section heading
   * @param {string} key stable id, so the collapsed state survives a rebuild
   * @returns {HTMLElement} the section body
   */
  function section(title, key) {
    const sec = mk(doc, 'section', 'vm-sec');
    const hd = mk(doc, 'button', 'vm-sec__hd');
    hd.type = 'button';
    const caret = mk(doc, 'span', 'vm-sec__caret', '▾');
    add(hd, caret, mk(doc, 'span', null, title));
    const body = mk(doc, 'div', 'vm-sec__body');
    add(sec, hd, body);
    const apply = (c) => {
      cls(sec, 'is-collapsed', c);
      setText(caret, c ? '▸' : '▾');
      setAttr(hd, 'aria-expanded', c ? 'false' : 'true');
    };
    apply(!!S.collapsed[key]);
    hd.addEventListener('click', () => {
      S.collapsed[key] = !S.collapsed[key];
      apply(!!S.collapsed[key]);
    });
    add(edBody, sec);
    return body;
  }

  /** @returns {Array<string>} the `A*` inlet port ids of this skid */
  function inletsA() { return Object.keys(ctx.config.inletAssignments || {}).filter((k) => k[0] === 'A'); }
  /** @returns {Array<string>} the `B*` inlet port ids of this skid */
  function inletsB() { return Object.keys(ctx.config.inletAssignments || {}).filter((k) => k[0] === 'B'); }
  /** @returns {Array<string|null>} `null` plus the `S*` inlet port ids of this skid */
  function inletsS() {
    return [null].concat(Object.keys(ctx.config.inletAssignments || {}).filter((k) => k[0] === 'S'));
  }
  /** @returns {Array<string>} the fraction-collector port ids, `F1 … Fn` */
  function fracPorts() {
    return ((ctx.config.skid.fracValve && ctx.config.skid.fracValve.ports) || []).slice();
  }
  /** @param {string} port an inlet port id @returns {string} `'A1 — TK-EQ'`, or the bare id when unassigned */
  function inletLabel(port) {
    if (port === null || port === undefined) return 'None';
    const t = (ctx.config.inletAssignments || {})[port];
    return t ? port + ' — ' + t : port + ' — unassigned';
  }
  /** @returns {Array<string>} every §5.2 signal name, the twenty-one fixed ones plus one per tank */
  function allSignals() {
    return FIXED_SIGNALS.concat((ctx.config.tanks || []).map((t) => 'TANK_LEVEL:' + t.id));
  }

  /**
   * Rebuild (or merely refresh) the centre editor for the selected block.
   * @returns {void}
   */
  function renderEditor() {
    const b = selected();
    const key = editorKeyFor(b);
    if (key === S.editorKey) { refreshFields(); return; }
    S.editorKey = key;
    S.fields.length = 0;
    while (edBody.firstChild) edBody.removeChild(edBody.firstChild);
    const config = ctx.config;

    if (!b) {
      setText(edTitle, 'BLOCK');
      setText(edId, '—');
      const empty = mk(doc, 'div', 'vm-empty', 'NO BLOCK');
      empty.title = 'No block is selected. Add one from the block list, or load a template.';
      add(edBody, empty);
      return;
    }
    const meta = TYPE_META[b.type] || { code: '??', label: b.type };
    setText(edTitle, (meta.code || '??') + ' ' + (meta.label || b.type).toUpperCase());
    setText(edId, b.id);

    /* 1 ── identity ─────────────────────────────────────────────────────────────────────────── */
    F.parent = section('Identity', 'identity');
    textField(F, { label: 'Name', span: true, get: () => b.name, set: (v) => { b.name = v; },
      hint: () => 'Shown on the phase rail and in the log.' });
    selectField(F, { label: 'Type', glossary: 'block.type', fieldPath: 'type', options: BLOCK_TYPES,
      labelFn: (t) => TYPE_META[t].label,
      get: () => b.type,
      set: (v) => {
        b.type = v;
        // §5.4.3 enforcement, mirrored here so the editor shows what the engine will do.
        if (['EQUILIBRATION', 'WASH', 'RE_EQUILIBRATION', 'ELUTION_ISOCRATIC', 'STRIP'].indexOf(v) >= 0) {
          b.gradient.shape = 'ISOCRATIC';
        }
        if (v === 'ELUTION_STEP') b.gradient.shape = 'STEP';
        if (v === 'ELUTION_LINEAR' && b.gradient.shape === 'ISOCRATIC') b.gradient.shape = 'LINEAR';
        if (v === 'COLUMN_BYPASS') b.columnValve = 'BYPASS';
        if (v === 'CIP' && COLUMN_VALVES.indexOf(b.columnValve) >= 0
            && ['DOWN', 'UP', 'CIP_DETECTOR_BYPASS'].indexOf(b.columnValve) < 0) b.columnValve = 'DOWN';
        if (v === 'PACKING_TEST' && !b.sample.mode) b.sample.mode = 'LOOP_INJECT';
        S.editorKey = '';
      },
      hint: () => typeHint(b.type) });
    toggleField(F, { label: 'Enabled', text: b.enabled ? 'IN RUN' : 'SKIP',
      get: () => b.enabled, set: (v) => { b.enabled = v; },
      hint: () => 'A disabled block stays in the file and is skipped at run time.' });
    toggleField(F, { label: 'Autozero', title: 'Autozero at block start', glossary: 'block.autozero',
      get: () => b.autozero, set: (v) => { b.autozero = v; }, text: 'UV ZERO',
      hint: () => 'Zeroes UV 280/260/300 as this block begins.' });
    toggleField(F, { label: 'Hold end', title: 'Hold at end of block', glossary: 'block.holdAtEnd',
      get: () => b.holdAtEnd, set: (v) => { b.holdAtEnd = v; }, text: 'HELD',
      hint: () => 'HELD keeps flow at setpoint and freezes the block clock.' });
    textAreaField(F, { label: 'Notes', get: () => b.notes, set: (v) => { b.notes = v; } });

    /* 2 ── duration ─────────────────────────────────────────────────────────────────────────── */
    F.parent = section('Duration', 'duration');
    numField(F, { label: 'Length', glossary: 'block.duration', fieldPath: 'duration.value',
      step: b.duration.basis === 'CV' ? 0.5 : 10, min: 0,
      unit: b.duration.basis === 'CV_OF_SAMPLE' ? 'CV(s)' : b.duration.basis,
      get: () => b.duration.value, set: (v) => { b.duration.value = v; },
      disabled: () => b.type === 'HOLD',
      hint: () => {
        if (b.type === 'HOLD') return 'HOLD never ends on duration — a watch or the operator ends it.';
        const v = blockVolume_mL(config, b);
        if (!Number.isFinite(v)) return '';
        const q = blockFlow_mLs(config, b, prevEnabledOf(b));
        const t = (Number.isFinite(q) && q > 0) ? v / q : NaN;
        return nf(v, 1) + ' mL · ' + nf(v / config.column.V_mL, 2) + ' CV · ' + nf(t / 60, 1) + ' min';
      } });
    selectField(F, { label: 'Basis', fieldPath: 'duration.basis', options: DURATION_BASES,
      labelFn: (x) => (x === 'CV_OF_SAMPLE' ? 'CV of sample' : x),
      get: () => b.duration.basis, set: (v) => { b.duration.basis = v; S.editorKey = ''; },
      hint: () => 'CV and mL count the integral of actual flow; min counts simulated time.' });
    selectField(F, { label: 'On timeout', glossary: 'duration.onTimeout', options: ON_TIMEOUT,
      get: () => b.duration.onTimeout, set: (v) => { b.duration.onTimeout = v; S.editorKey = ''; },
      hint: () => 'What happens when the duration elapses with no watch fired.' });
    if (b.duration.onTimeout === 'REPEAT') {
      numField(F, { label: 'Repeat limit', step: 1, min: 0, integer: true, decimals: 0,
        get: () => b.duration.repeatLimit, set: (v) => { b.duration.repeatLimit = v; },
        hint: () => 'Maximum restarts before the block gives up.' });
    }

    /* 3 ── flow ─────────────────────────────────────────────────────────────────────────────── */
    F.parent = section('Flow', 'flow');
    selectField(F, { label: 'Flow mode', glossary: 'block.flow', options: FLOW_MODES,
      // The option face carries the unit the setpoint is expressed in; what each mode MEANS is in
      // the field tooltip, not on the glass.
      labelFn: (m) => FLOW_MODE_OPTION[m] || m,
      get: () => b.flow.mode, set: (v) => { b.flow.mode = v; S.editorKey = ''; },
      hint: () => FLOW_MODE_HINT[b.flow.mode] || '' });
    numField(F, { label: 'Setpoint', fieldPath: 'flow.value', unit: FLOW_MODE_UNIT[b.flow.mode],
      step: b.flow.mode === 'CM_H' ? 10 : 1, min: 0,
      get: () => b.flow.value, set: (v) => { b.flow.value = v; },
      disabled: () => b.flow.mode === 'INHERIT',
      hint: () => {
        const q = blockFlow_mLs(config, b, prevEnabledOf(b));
        if (!Number.isFinite(q)) return 'INHERIT could not be resolved — no previous enabled block.';
        const g = flowGroup(config, q);
        // Leads with the operator's chosen display unit (§6.25), then the whole linked group, so
        // the four expressions of the same flow are always visible together.
        return fmtFlow(q, config) + '  =  ' + nf(g.Q_mLs * 60, 1) + ' mL/min · '
          + nf(g.u_cmh, 0) + ' cm/h · RT ' + nf(g.RT_min, 2) + ' min · ' + nf(g.CVh, 2) + ' CV/h';
      } });
    numField(F, { label: 'Ramp override', unit: 'mL/s²', step: 0.05, min: 0,
      get: () => (b.flow.rampOverride_mLs2 === null ? 0 : b.flow.rampOverride_mLs2),
      set: (v) => { b.flow.rampOverride_mLs2 = v > 0 ? v : null; },
      hint: () => (b.flow.rampOverride_mLs2 === null
        ? 'Zero uses the skid default, ' + nf(config.skid.rampRate_mLs2, 3) + ' mL/s².'
        : 'Overrides the skid ramp rate for this block.') });
    F.parent.appendChild(dpHintNode(b));

    /* 4 ── buffer ───────────────────────────────────────────────────────────────────────────── */
    F.parent = section('Gradient', 'buffer');
    selectField(F, { label: 'Shape', glossary: 'block.gradient', fieldPath: 'gradient.shape',
      options: GRADIENT_SHAPES, get: () => b.gradient.shape,
      set: (v) => { b.gradient.shape = v; S.editorKey = ''; },
      hint: () => shapeHint(b.gradient.shape) });
    numField(F, { label: 'Start %B', fieldPath: 'gradient.startPctB', unit: '%', step: 5, min: 0, max: 100,
      decimals: 1, get: () => b.gradient.startPctB, set: (v) => { b.gradient.startPctB = v; },
      hint: () => 'Commanded at block start.' });
    numField(F, { label: 'End %B', fieldPath: 'gradient.endPctB', unit: '%', step: 5, min: 0, max: 100,
      decimals: 1, get: () => b.gradient.endPctB, set: (v) => { b.gradient.endPctB = v; },
      disabled: () => b.gradient.shape === 'ISOCRATIC',
      hint: () => {
        if (b.gradient.shape === 'ISOCRATIC') return 'Isocratic — the end value is not used.';
        const vol = blockVolume_mL(config, b);
        if (!Number.isFinite(vol) || vol <= 0) return '';
        const cv = vol / config.column.V_mL * Math.max(b.gradient.lengthFraction, 1e-9);
        return 'Slope ' + nf(Math.abs(b.gradient.endPctB - b.gradient.startPctB) / Math.max(cv, 1e-9), 2)
          + ' %B/CV';
      } });
    if (b.gradient.shape === 'CONVEX' || b.gradient.shape === 'CONCAVE') {
      numField(F, { label: 'Curvature', glossary: 'gradient.curvature', step: 0.5, min: -5, max: 5,
        decimals: 1, get: () => b.gradient.curvature, set: (v) => { b.gradient.curvature = v; },
        hint: () => 'Exponent n = ' + nf(1 + Math.abs(b.gradient.curvature) / 2, 2)
          + '; 0 reproduces linear exactly.' });
    }
    numField(F, { label: 'Gradient length', glossary: 'gradient.lengthFraction', unit: 'fraction',
      step: 0.05, min: 0, max: 1, decimals: 2,
      get: () => b.gradient.lengthFraction, set: (v) => { b.gradient.lengthFraction = v; },
      hint: () => 'The gradient occupies the first ' + nf(b.gradient.lengthFraction * 100, 0)
        + ' % of the block, then holds.' });
    selectField(F, { label: 'Inlet A', glossary: 'block.inlets', options: inletsA(),
      labelFn: inletLabel, get: () => b.inlets.a, set: (v) => { b.inlets.a = v; } });
    selectField(F, { label: 'Inlet B', options: inletsB(), labelFn: inletLabel,
      get: () => b.inlets.b, set: (v) => { b.inlets.b = v; } });
    selectField(F, { label: 'Sample inlet', options: inletsS(), labelFn: inletLabel,
      get: () => b.inlets.sample, set: (v) => { b.inlets.sample = v; } });

    /* 5 ── valves ───────────────────────────────────────────────────────────────────────────── */
    F.parent = section('Valves', 'valves');
    selectField(F, { label: 'Column valve', glossary: 'block.columnValve', options: COLUMN_VALVES,
      get: () => b.columnValve, set: (v) => { b.columnValve = v; },
      disabled: () => b.type === 'COLUMN_BYPASS',
      hint: () => (b.type === 'COLUMN_BYPASS' ? 'Forced to BYPASS by the block type.'
        : (b.type === 'CIP' ? 'CIP allows DOWN, UP and CIP_DETECTOR_BYPASS only.' : '')) });
    selectField(F, { label: 'Outlet', title: 'Outlet when not collecting',
      glossary: 'block.outletDefault', options: ['WASTE'].concat(fracPorts()),
      get: () => b.outletDefault, set: (v) => { b.outletDefault = v; } });

    buildSampleSection(b, config);
    buildFracSection(b, config);
    buildWatchSection(b, config);
    refreshFields();
  }

  /**
   * The previous ENABLED block before `b`, which is what `INHERIT` resolves against (§5.4.6).
   * @param {object} b a draft block
   * @returns {object|null} the previous enabled block, or null
   */
  function prevEnabledOf(b) {
    const blocks = S.draft.blocks;
    const i = blocks.indexOf(b);
    for (let k = i - 1; k >= 0; k--) if (blocks[k].enabled) return blocks[k];
    return null;
  }

  /** @param {string} t a block type @returns {string} the one-line semantic the engine enforces (§5.4.3) */
  function typeHint(t) {
    return ({
      EQUILIBRATION: 'Isocratic; fractionation defaults off.',
      LOAD: 'Needs a sample mode; counts V_load and the loaded mass.',
      WASH: 'Isocratic; outlet defaults to waste.',
      ELUTION_ISOCRATIC: 'Isocratic at the start %B.',
      ELUTION_LINEAR: 'Ramps start → end %B over the gradient length.',
      ELUTION_STEP: 'Steps to the end %B at block start.',
      STRIP: 'Isocratic, normally 100 %B; outlet defaults to waste.',
      CIP: 'Column valve limited to DOWN / UP / detector bypass; the cycle counter increments.',
      RE_EQUILIBRATION: 'Isocratic; commonly carries a conductivity STABLE watch.',
      HOLD: 'Flow continues and the block never ends on duration — watch or operator only.',
      COLUMN_BYPASS: 'Column valve forced to BYPASS.',
      PACKING_TEST: 'Injects a tracer through the loop; the analysis runs in the Results tab.',
    })[t] || '';
  }

  /** @param {string} s a gradient shape @returns {string} the one-line description */
  function shapeHint(s) {
    return ({
      ISOCRATIC: 'Holds the start %B for the whole block.',
      LINEAR: 'Straight ramp start → end.',
      STEP: 'Jumps to the end %B at block start.',
      CONVEX: 'Fast early, flattening — sharpens early-eluting peaks.',
      CONCAVE: 'Slow early, steepening — spreads early-eluting peaks.',
      MULTI_SEGMENT: 'Piecewise-linear through the authored segments.',
    })[s] || '';
  }

  /**
   * The design-time pressure readout beneath the flow fields — the same estimate the preview's red
   * overload band uses (`blockPressureEstimate_bar`, §6.15).
   * @param {object} b the selected block
   * @returns {HTMLElement} a full-width hint node
   */
  function dpHintNode(b) {
    const el = mk(doc, 'div', 'vm-field');
    const lb = mk(doc, 'div', 'vm-field__lb', 'PDT-EST');
    const body = mk(doc, 'div', 'vm-field__body');
    const box = mk(doc, 'div', 'vm-nf');
    const val = mk(doc, 'span', 'vm-nf__v', '—');
    add(box, val, mk(doc, 'span', 'vm-nf__u', 'bar'));
    add(body, box);
    add(el, lb, body);
    S.fields.push({ el, fieldPath: null, setError: () => {}, setHint: () => {}, refresh: () => {
      const dp = blockPressureEstimate_bar(ctx.config, b);
      const trip = dpTrip_bar(ctx.config);
      setText(val, nf(dp, 3));
      setAttr(val, 'data-q', dp > trip ? 'alarm' : null);
      setAttr(el, 'title', 'Estimated column ΔP at this flow: ' + nf(dp, 3) + ' bar of the '
        + nf(trip, 2) + ' bar trip (design-time estimate at 1.002 cP).');
    } });
    return el;
  }

  /**
   * The sample section (§5.4.2 `sample`).
   * @param {object} b the selected block
   * @param {object} config frozen config
   * @returns {void}
   */
  function buildSampleSection(b, config) {
    F.parent = section('Sample', 'sample');
    selectField(F, { label: 'Sample mode', glossary: 'block.sample', options: SAMPLE_MODES,
      labelFn: humanise,
      get: () => b.sample.mode, set: (v) => { b.sample.mode = v; S.editorKey = ''; },
      hint: () => (b.sample.mode
        ? ''
        : (b.type === 'LOAD' ? 'A LOAD block requires a sample mode.'
          : 'None — this block runs on buffer only.')) });
    if (b.sample.mode) {
      numField(F, { label: 'Loop volume', fieldPath: 'sample.loopVolume_mL', unit: 'mL',
        step: 1, min: 0, decimals: 2,
        get: () => (b.sample.loopVolume_mL === null ? 0 : b.sample.loopVolume_mL),
        set: (v) => { b.sample.loopVolume_mL = v > 0 ? v : null; },
        disabled: () => b.sample.mode === 'DIRECT',
        hint: () => (b.sample.mode === 'DIRECT'
          ? 'Direct loading pumps from the sample tank; no loop is used.'
          : 'LOOP_INJECT needs a loop volume.') });
      numField(F, { label: 'Chase', unit: 'CV', step: 0.1, min: 0, decimals: 2,
        get: () => b.sample.chaseVolume_CV, set: (v) => { b.sample.chaseVolume_CV = v; },
        hint: () => nf(b.sample.chaseVolume_CV * config.column.V_mL, 1)
          + ' mL of buffer A pushed after the sample.' });
    }
    if (config.load && config.load.derived) {
      const d = config.load.derived;
      const el = mk(doc, 'div', 'vm-field');
      const body = mk(doc, 'div', 'vm-field__body');
      const box = mk(doc, 'div', 'vm-nf');
      add(box, mk(doc, 'span', 'vm-nf__v', nf(d.mass_g, 2)), mk(doc, 'span', 'vm-nf__u', 'g'));
      add(body, box);
      add(el, mk(doc, 'div', 'vm-field__lb', 'LOAD'), body);
      setAttr(el, 'title', 'Configured load: ' + nf(d.mass_g, 2) + ' g in '
        + nf(d.volume_mL, 0) + ' mL (' + nf(d.CV, 2) + ' CV) of feed.');
      add(F.parent, el);
    }
  }

  /**
   * The fractionation section (§5.4.5). Only the fields the chosen mode actually reads are shown,
   * so an `OFF` block does not display eight dead thresholds.
   * @param {object} b the selected block
   * @param {object} config frozen config
   * @returns {void}
   */
  function buildFracSection(b, config) {
    const f = b.fractionation;
    F.parent = section('Fractions', 'frac');
    selectField(F, { label: 'Collection mode', glossary: 'frac.mode', fieldPath: 'fractionation.mode',
      options: FRAC_MODES, get: () => f.mode, set: (v) => { f.mode = v; S.editorKey = ''; },
      hint: () => ({ OFF: 'Everything goes to the outlet default.',
        FIXED_VOLUME: 'Advance every fixed volume.',
        FIXED_TIME: 'Advance on a fixed volume converted to time at the current flow.',
        PEAK: 'Start and stop on the signal, bounded by the min and max fraction volume.' })[f.mode] });
    if (f.mode === 'OFF') return;

    const fam = () => signalFamily(f.signal);
    selectField(F, { label: 'Signal', glossary: 'watch.signal', options: allSignals(),
      get: () => f.signal, set: (v) => { f.signal = v; S.editorKey = ''; },
      hint: () => 'Read at the detector plane, with its real transport delay.' });

    if (f.mode === 'PEAK') {
      selectField(F, { label: 'Start on', glossary: 'frac.startThreshold', options: START_TYPES,
        get: () => f.startThreshold.type, set: (v) => { f.startThreshold.type = v; S.editorKey = ''; } });
      if (f.startThreshold.type !== 'SLOPE') {
        unitNumField(F, { label: 'Start level', config,
          units: SIGNAL_UNITS[fam()].level,
          getUnit: () => (f.startThreshold.authoredAs || {}).unit || SIGNAL_UNITS[fam()].level[0],
          setUnit: (u) => { f.startThreshold.authoredAs = f.startThreshold.authoredAs || {}; f.startThreshold.authoredAs.unit = u; },
          get: () => f.startThreshold.value,
          set: (v) => {
            f.startThreshold.value = v;
            const a = f.startThreshold.authoredAs = f.startThreshold.authoredAs || {};
            a.unit = a.unit || SIGNAL_UNITS[fam()].level[0];
            a.value = fromCanonical(config, v, a.unit);
            a.pathlength_cm = config.skid.uv.pathlength_cm;
          },
          hint: () => 'Stored as ' + nf(f.startThreshold.value, 5) + ' canonical — invariant if the '
            + 'flow cell changes.' });
      }
      if (f.startThreshold.type !== 'ABSOLUTE') {
        unitNumField(F, { label: 'Start slope', config,
          units: SIGNAL_UNITS[fam()].slope,
          getUnit: () => (f.startThreshold.authoredAs || {}).slopeUnit || SIGNAL_UNITS[fam()].slope[0],
          setUnit: (u) => { f.startThreshold.authoredAs = f.startThreshold.authoredAs || {}; f.startThreshold.authoredAs.slopeUnit = u; },
          get: () => f.startThreshold.slopeValue,
          set: (v) => {
            f.startThreshold.slopeValue = v;
            const a = f.startThreshold.authoredAs = f.startThreshold.authoredAs || {};
            a.slopeUnit = a.slopeUnit || SIGNAL_UNITS[fam()].slope[0];
            a.slopeValue = fromCanonical(config, v, a.slopeUnit);
          },
          hint: () => 'Every slope in the contract is per mL, because every window is a volume window.' });
      }
      selectField(F, { label: 'Stop on', glossary: 'frac.stopThreshold', options: STOP_TYPES,
        get: () => f.stopThreshold.type, set: (v) => { f.stopThreshold.type = v; S.editorKey = ''; } });
      if (f.stopThreshold.type === 'PCT_OF_PEAK_MAX') {
        numField(F, { label: 'Stop %', title: 'Stop at this percentage of the peak maximum',
          unit: '%', step: 5, min: 0, max: 100, decimals: 1,
          get: () => f.stopThreshold.pctOfMax,
          set: (v) => {
            f.stopThreshold.pctOfMax = v;
            const a = f.stopThreshold.authoredAs = f.stopThreshold.authoredAs || {};
            a.pctOfMax = v;
          } });
      } else {
        if (f.stopThreshold.type !== 'SLOPE') {
          unitNumField(F, { label: 'Stop level', config,
            units: SIGNAL_UNITS[fam()].level,
            getUnit: () => (f.stopThreshold.authoredAs || {}).unit || SIGNAL_UNITS[fam()].level[0],
            setUnit: (u) => { f.stopThreshold.authoredAs = f.stopThreshold.authoredAs || {}; f.stopThreshold.authoredAs.unit = u; },
            get: () => f.stopThreshold.value,
            set: (v) => {
              f.stopThreshold.value = v;
              const a = f.stopThreshold.authoredAs = f.stopThreshold.authoredAs || {};
              a.unit = a.unit || SIGNAL_UNITS[fam()].level[0];
              a.value = fromCanonical(config, v, a.unit);
              a.pathlength_cm = config.skid.uv.pathlength_cm;
            } });
        }
        if (f.stopThreshold.type !== 'ABSOLUTE') {
          unitNumField(F, { label: 'Stop slope', config,
            units: SIGNAL_UNITS[fam()].slope,
            getUnit: () => (f.stopThreshold.authoredAs || {}).slopeUnit || SIGNAL_UNITS[fam()].slope[0],
            setUnit: (u) => { f.stopThreshold.authoredAs = f.stopThreshold.authoredAs || {}; f.stopThreshold.authoredAs.slopeUnit = u; },
            get: () => f.stopThreshold.slopeValue,
            set: (v) => {
              f.stopThreshold.slopeValue = v;
              const a = f.stopThreshold.authoredAs = f.stopThreshold.authoredAs || {};
              a.slopeUnit = a.slopeUnit || SIGNAL_UNITS[fam()].slope[0];
              a.slopeValue = fromCanonical(config, v, a.slopeUnit);
            } });
        }
      }
      toggleField(F, { label: 'Apex detect', title: 'Peak maximum detection',
        glossary: 'frac.peakMaxDetection',
        text: 'APEX MARK', get: () => f.peakMaxDetection,
        set: (v) => { f.peakMaxDetection = v; } });
      unitNumField(F, { label: 'Apex prominence', config, units: SIGNAL_UNITS[fam()].level,
        getUnit: () => SIGNAL_UNITS[fam()].level[0],
        setUnit: () => {},
        get: () => f.peakMaxProminence, set: (v) => { f.peakMaxProminence = v; },
        hint: () => 'A local maximum below this prominence is not called an apex.' });
    } else {
      spanField(F, 'Fraction size', 'fractionation.fixedVolume', f.fixedVolume, config, b, 0.05,
        'Size basis');
    }
    spanField(F, 'Minimum fraction', 'fractionation.minFractionVolume', f.minFractionVolume,
      config, b, 0.01, 'Min basis');
    spanField(F, 'Maximum fraction', 'fractionation.maxFractionVolume', f.maxFractionVolume,
      config, b, 0.05, 'Max basis');
    if (WINDOW_OPERATORS.length) {
      spanField(F, 'Slope window', 'fractionation.slopeWindow', f.slopeWindow, config, b, 0.01,
        'Window basis');
    }
    selectField(F, { label: 'First port', options: fracPorts(),
      get: () => f.firstPort, set: (v) => { f.firstPort = v; } });
    numField(F, { label: 'Port count', title: 'Number of collector ports to use',
      unit: 'port', step: 1, min: 1, integer: true, decimals: 0,
      get: () => f.portCount, set: (v) => { f.portCount = v; },
      hint: () => 'This collector has ' + fracPorts().length + ' ports.' });
    selectField(F, { label: 'Overflow to', glossary: 'frac.overflowTo',
      options: ['WASTE'].concat(fracPorts()),
      get: () => f.overflowTo, set: (v) => { f.overflowTo = v; } });
    selectField(F, { label: 'Delay compensation', glossary: 'frac.delayCompensation',
      options: DELAY_COMP, get: () => f.delayCompensation, set: (v) => { f.delayCompensation = v; },
      hint: () => ({ COMPENSATED: 'Decisions are queued on the valve-plane volume — the correct behaviour.',
        UNCOMPENSATED: 'Executes immediately; every fraction is annotated with its offset error.',
        FIXED_TIME: 'Converts to a time delay once, at decision time.' })[f.delayCompensation] });
    selectField(F, { label: 'Dead-leg policy', glossary: 'frac.deadLegPolicy', options: DEAD_LEG,
      get: () => f.deadLegPolicy, set: (v) => { f.deadLegPolicy = v; } });
    numField(F, { label: 'Persistence', unit: 'ticks', step: 1, min: 1, integer: true, decimals: 0,
      get: () => f.persistence_ticks, set: (v) => { f.persistence_ticks = v; },
      hint: () => 'Consecutive 10 Hz control ticks the condition must hold.' });
  }

  /**
   * A `{basis, value}` volume span rendered as a numfield plus a basis selector, with the resolved
   * millilitres and seconds in the hint.
   *
   * @param {object} Fc the form context
   * @param {string} label the two-word face tag
   * @param {string} fieldPath the validation field path
   * @param {{basis:string, value:number}} span the span object on the draft
   * @param {object} config frozen config
   * @param {object} b the owning block, for the flow used by the `min` basis
   * @param {number} step the numfield step
   * @param {string} basisLabel the two-word face tag of the basis selector beside it
   * @returns {void}
   */
  function spanField(Fc, label, fieldPath, span, config, b, step, basisLabel) {
    numField(Fc, { label, fieldPath, unit: span.basis, step, min: 0,
      get: () => span.value, set: (v) => { span.value = v; },
      hint: () => {
        const q = blockFlow_mLs(config, b, prevEnabledOf(b));
        const mL = span.basis === 'CV' ? span.value * config.column.V_mL
          : (span.basis === 'mL' ? span.value : span.value * 60 * (Number.isFinite(q) ? q : 0));
        const s = (Number.isFinite(q) && q > 0) ? mL / q : NaN;
        return nf(mL, 2) + ' mL · ' + nf(s, 1) + ' s';
      } });
    selectField(Fc, { label: basisLabel, title: label + ' basis', options: SPAN_BASES,
      get: () => span.basis, set: (v) => { span.basis = v; S.editorKey = ''; } });
  }

  /**
   * The watch list (§5.4.4): one card per watch, each with an add / remove control.
   * @param {object} b the selected block
   * @param {object} config frozen config
   * @returns {void}
   */
  function buildWatchSection(b, config) {
    const body = section('Watches (' + b.watches.length + ')', 'watches');
    body.className = 'vm-sec__body';
    body.style.gridTemplateColumns = '1fr';
    for (let k = 0; k < b.watches.length; k++) buildWatchCard(body, b, b.watches[k], k, config);
    const addWrap = mk(doc, 'div', 'vm-field vm-field--span');
    addWrap.style.gridTemplateColumns = 'auto 1fr';
    const addBtn = iconBtn(doc, 'add',
      'Add a watch: it ends the block, or acts on it, when a signal condition holds', () => {
        if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
        edit(() => { b.watches.push(makeWatch(b.watches.length)); }, true);
        recomputeNow();
      }, 'vm-btn--sm');
    add(addWrap, addBtn);
    if (b.watches.length === 0) {
      const e = mk(doc, 'div', 'vm-empty', 'NO WATCHES');
      e.title = 'No watches — this block runs its full duration (§5.4.4c rule 11).';
      add(addWrap, e);
    }
    add(body, addWrap);
  }

  /**
   * One watch card.
   * @param {HTMLElement} host the watch section body
   * @param {object} b the owning block
   * @param {object} w the watch on the draft
   * @param {number} k its index
   * @param {object} config frozen config
   * @returns {void}
   */
  function buildWatchCard(host, b, w, k, config) {
    const card = mk(doc, 'div', 'vm-watch');
    const hd = mk(doc, 'div', 'vm-watch__hd');
    const terminal = TERMINAL_ACTIONS.indexOf(w.action) >= 0;
    const pill = mk(doc, 'span', 'vm-pill ' + (terminal ? 'vm-pill--info' : 'vm-pill--mute'),
      terminal ? 'TERM' : 'NON-T');
    pill.title = terminal
      ? 'Terminal: the first satisfied terminal action ends evaluation for the tick.'
      : 'Non-terminal: every satisfied non-terminal action runs, in array order.';
    const del = iconBtn(doc, 'del', 'Remove this watch', () => {
      if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
      edit(() => { b.watches.splice(k, 1); }, true);
      recomputeNow();
    }, 'vm-btn--sm vm-btn--danger');
    add(hd, mk(doc, 'span', 'vm-watch__id', w.id || 'W' + (k + 1)), pill,
      mk(doc, 'span', 'vm-hd__sp'), del);
    add(card, hd);
    add(host, card);

    const prev = F.parent;
    F.parent = card;
    const fam = () => signalFamily(w.signal);
    const isSlope = () => SLOPE_OPERATORS.indexOf(w.operator) >= 0;
    selectField(F, { label: 'Signal', glossary: 'watch.signal',
      fieldPath: 'watches[' + k + '].signal', options: allSignals(),
      get: () => w.signal, set: (v) => { w.signal = v; S.editorKey = ''; } });
    selectField(F, { label: 'Operator', glossary: 'watch.operator',
      fieldPath: 'watches[' + k + '].operator', options: WATCH_OPERATORS,
      get: () => w.operator, set: (v) => { w.operator = v; S.editorKey = ''; },
      hint: () => operatorHint(w.operator) });
    unitNumField(F, { label: 'Threshold', glossary: 'watch.threshold',
      fieldPath: 'watches[' + k + '].threshold', config,
      units: isSlope() ? SIGNAL_UNITS[fam()].slope : SIGNAL_UNITS[fam()].level,
      getUnit: () => (w.authoredAs || {}).unit
        || (isSlope() ? SIGNAL_UNITS[fam()].slope[0] : SIGNAL_UNITS[fam()].level[0]),
      setUnit: (u) => { w.authoredAs = w.authoredAs || {}; w.authoredAs.unit = u; },
      get: () => w.threshold,
      set: (v) => {
        w.threshold = v;
        const a = w.authoredAs = w.authoredAs || {};
        a.unit = a.unit || (isSlope() ? SIGNAL_UNITS[fam()].slope[0] : SIGNAL_UNITS[fam()].level[0]);
        a.value = fromCanonical(config, v, a.unit);
        a.pathlength_cm = config.skid.uv.pathlength_cm;
      } });
    if (WINDOW_OPERATORS.indexOf(w.operator) >= 0) {
      spanField(F, 'Slope window', 'watches[' + k + '].slopeWindow', w.slopeWindow, config, b, 0.01,
        'Window basis');
      if (w.operator === 'STABLE' || w.operator === 'PLATEAU') {
        unitNumField(F, { label: 'Stable tolerance', glossary: 'watch.stableTolerance', config,
          units: SIGNAL_UNITS[fam()].level,
          getUnit: () => (w.authoredAs || {}).stableToleranceUnit || SIGNAL_UNITS[fam()].level[0],
          setUnit: (u) => { w.authoredAs = w.authoredAs || {}; w.authoredAs.stableToleranceUnit = u; },
          get: () => w.stableTolerance,
          set: (v) => {
            w.stableTolerance = v;
            const a = w.authoredAs = w.authoredAs || {};
            a.stableToleranceUnit = a.stableToleranceUnit || SIGNAL_UNITS[fam()].level[0];
            a.stableTolerance = fromCanonical(config, v, a.stableToleranceUnit);
          },
          hint: () => 'Both the slope AND the window range must sit inside this.' });
      }
    }
    spanField(F, 'Arm after', 'watches[' + k + '].arm', w.arm, config, b, 0.05, 'Arm basis');
    numField(F, { label: 'Persistence', glossary: 'watch.persistence_ticks', unit: 'ticks',
      step: 1, min: 1, integer: true, decimals: 0,
      get: () => w.persistence_ticks, set: (v) => { w.persistence_ticks = v; },
      hint: () => 'Consecutive 10 Hz ticks; one failing tick resets the counter.' });
    selectField(F, { label: 'Action', glossary: 'watch.action',
      fieldPath: 'watches[' + k + '].action', options: WATCH_ACTIONS,
      get: () => w.action, set: (v) => { w.action = v; w.actionParam = null; S.editorKey = ''; } });
    buildActionParam(w, k, config);
    toggleField(F, { label: 'One shot', glossary: 'watch.oneShot', text: 'ONCE',
      get: () => w.oneShot, set: (v) => { w.oneShot = v; } });
    toggleField(F, { label: 'Delay comp', title: 'Delay-compensated watch',
      glossary: 'watch.useDelayCompensated', text: 'COMP',
      get: () => w.useDelayCompensated, set: (v) => { w.useDelayCompensated = v; },
      hint: () => 'A training aid. Off is the honest behaviour: a UV watch fires after the '
        + 'transport delay.' });
    F.parent = prev;
  }

  /**
   * The action parameter, whose type depends on the action (§5.4.4b).
   * @param {object} w the watch
   * @param {number} k its index
   * @param {object} config frozen config
   * @returns {void}
   */
  function buildActionParam(w, k, config) {
    const path = 'watches[' + k + '].actionParam';
    if (w.action === 'GOTO_BLOCK') {
      selectField(F, { label: 'Target block', fieldPath: path,
        options: S.draft.blocks.map((x) => x.id),
        labelFn: (id) => { const x = blockById(id); return id + ' — ' + (x ? x.name : '?'); },
        get: () => w.actionParam, set: (v) => { w.actionParam = v; },
        hint: () => 'A backward jump increments the loop counter; ten loops raise ALM-MTH-02.' });
      return;
    }
    if (w.action === 'OUTLET_TO') {
      selectField(F, { label: 'Outlet', fieldPath: path, options: ['WASTE'].concat(fracPorts()),
        get: () => w.actionParam, set: (v) => { w.actionParam = v; } });
      return;
    }
    if (w.action === 'SET_PCTB') {
      numField(F, { label: 'New %B', fieldPath: path, unit: '%', step: 5, min: 0, max: 100, decimals: 1,
        get: () => (typeof w.actionParam === 'number' ? w.actionParam : 0),
        set: (v) => { w.actionParam = v; w.actionParamUnit = '%'; } });
      return;
    }
    if (w.action === 'SET_FLOW') {
      unitNumField(F, { label: 'New flow', fieldPath: path, config,
        units: ['mL/min', 'cm/h', 'mL/s'],
        getUnit: () => w.actionParamUnit || 'mL/min',
        setUnit: (u) => { w.actionParamUnit = u; },
        get: () => (typeof w.actionParam === 'number' ? w.actionParam : 0),
        set: (v) => { w.actionParam = v; w.actionParamUnit = w.actionParamUnit || 'mL/min'; },
        hint: () => 'Stored in mL/s, the canonical flow unit.' });
      return;
    }
    if (w.action === 'EXTEND_BLOCK') {
      numField(F, { label: 'Extend by', fieldPath: path, unit: 'block basis', step: 0.5, min: 0,
        get: () => (typeof w.actionParam === 'number' ? w.actionParam : 0),
        set: (v) => { w.actionParam = v; },
        hint: () => 'In the block’s own duration basis; three extensions maximum.' });
      return;
    }
    if (w.action === 'RAISE_ALARM') {
      textField(F, { label: 'Alarm id', fieldPath: path, placeholder: 'ALM-MTH-01',
        get: () => (w.actionParam === null ? '' : String(w.actionParam)),
        set: (v) => { w.actionParam = v || null; } });
    }
  }

  /** @param {string} op a watch operator @returns {string} its one-line semantic (§5.4.4a) */
  function operatorHint(op) {
    return ({
      RISES_ABOVE: 'Edge: must have been below the threshold since arming.',
      FALLS_BELOW: 'Edge: must have been above the threshold since arming.',
      ABOVE: 'Level: fires immediately at arm time if already satisfied.',
      BELOW: 'Level: fires immediately at arm time if already satisfied.',
      SLOPE_ABOVE: 'OLS slope per mL over the volume window.',
      SLOPE_BELOW: 'OLS slope per mL over the volume window.',
      ABS_SLOPE_BELOW: 'Magnitude of the slope, per mL.',
      STABLE: 'Slope AND window range must both be inside the tolerance.',
      REACHES: 'Within 1 % of the threshold.',
      CHANGES_BY: 'Change since the value at arm time; cannot fire before arming.',
      PLATEAU: 'Flat slope and a small window range together.',
    })[op] || '';
  }

  /**
   * Push current values and validation state into every live control. Cheap: no DOM is created and
   * an input the user is typing in is never overwritten.
   * @returns {void}
   */
  function refreshFields() {
    F.readOnly = S.readOnly;
    const issues = S.validation.errors.concat(S.validation.warnings);
    for (const f of S.fields) {
      if (f.refresh) f.refresh();
      if (!f.setError) continue;
      let msg = null;
      for (const it of issues) {
        if (it.blockId !== S.selectedId) continue;
        if (!fieldMatches(f.fieldPath, it.field)) continue;
        if (it.level === 'error') { msg = it.message; break; }
        if (!msg) msg = it.message;
      }
      f.setError(msg);
    }
  }

  /* ── the right-hand rail ──────────────────────────────────────────────────────────────────── */

  /**
   * The three readouts under the preview: total volume, total time, and the A / B buffer split.
   * @returns {void}
   */
  function renderStats() {
    const p = S.plan;
    const config = ctx.config;
    if (!p) return;
    setText(statNodes['Total volume'], fmtVolume(p.total_mL, config) + '  (' + fmtCV(p.total_mL, config) + ')');
    setText(statNodes['Total time'], fmtTime(p.total_s));
    setText(statNodes['Buffer A / B'], nf(p.bufA_mL / 1000, 2) + ' / ' + nf(p.bufB_mL / 1000, 2) + ' L');
    setAttr(canvas, 'aria-label', 'Method preview: ' + p.rows.length + ' enabled blocks, '
      + nf(p.total_mL / config.column.V_mL, 1) + ' column volumes, '
      + fmtTime(p.total_s) + ', buffer A ' + nf(p.bufA_mL / 1000, 2) + ' L and B '
      + nf(p.bufB_mL / 1000, 2) + ' L.');
  }

  /**
   * The validation rail: every `validateMethod` error then every warning, grouped by block, each
   * click-to-focus and each carrying its one-click `fix` where one exists (§6.15).
   * @returns {void}
   */
  function renderValidation() {
    const errs = S.validation.errors;
    const warns = S.validation.warnings;
    setText(vdCount, errs.length + '/' + warns.length);
    setAttr(vdCount, 'title', errs.length + ' error(s), ' + warns.length + ' warning(s)');
    cls(vdLamp, 'vm-dot--err', errs.length > 0);
    cls(vdLamp, 'vm-dot--warn', errs.length === 0 && warns.length > 0);
    cls(vdLamp, 'vm-dot--ok', errs.length === 0 && warns.length === 0);
    setAttr(vdLamp, 'title', errs.length > 0
      ? 'At least one blocking error: Start is disabled until it is resolved.'
      : (warns.length > 0 ? 'Warnings only: the method may still run.'
        : 'No issues. Every block validates.'));
    const items = errs.concat(warns).map((it, i) => ({
      it, key: it.level + '|' + (it.blockId || '-') + '|' + (it.field || '-') + '|' + it.code + '|' + i,
    }));
    if (items.length === 0) {
      while (vdBody.firstChild) vdBody.removeChild(vdBody.firstChild);
      const ok = mk(doc, 'div', 'vm-empty', 'NO ISSUES');
      ok.title = 'No issues. Every block validates.';
      add(vdBody, ok);
      return;
    }
    if (vdBody.firstChild && vdBody.firstChild.className === 'vm-empty') {
      vdBody.removeChild(vdBody.firstChild);
    }
    reconcileList(vdBody, items, (x) => x.key, () => {
      const row = mk(doc, 'button', 'vm-issue');
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      const mkr = mk(doc, 'span', 'vm-issue__mk');
      const tx = mk(doc, 'span', 'vm-issue__tx');
      const hd = mk(doc, 'span', 'vm-issue__hd');
      const code = mk(doc, 'span', 'vm-issue__code');
      const where = mk(doc, 'span', 'vm-issue__where');
      add(hd, code, where);
      const msg = mk(doc, 'span', 'vm-issue__msg');
      add(tx, hd, msg);
      const fix = mk(doc, 'span', 'vm-btn vm-btn--sm vm-btn--icon');
      fix.setAttribute('role', 'button');
      fix.setAttribute('aria-label', 'Apply the one-click fix');
      fix.tabIndex = 0;
      add(fix, svgIcon(doc, 'fix'));
      add(row, mkr, tx, fix);
      row._parts = { mkr, code, where, msg, fix };
      return row;
    }, (row, x) => {
      const it = x.it;
      const p = row._parts;
      const isErr = it.level === 'error';
      setAttr(p.mkr, 'data-s', isErr ? 'alarm' : 'warn');
      setText(p.code, it.code);
      const blk = blockById(it.blockId);
      setText(p.where, blk ? (blk.id + (it.field ? '·' + it.field : ''))
        : (it.blockId ? it.blockId : 'METHOD'));
      setAttr(p.where, 'title', blk ? blk.name : '');
      setText(p.msg, shortClause(it.message, 36));
      p.fix.style.display = it.fix ? '' : 'none';
      p.fix.onclick = (ev) => {
        ev.stopPropagation();
        if (!it.fix) return;
        if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
        edit(() => {
          const patched = it.fix.apply(S.draft);
          if (patched && Array.isArray(patched.blocks)) S.draft.blocks = patched.blocks;
        }, true);
        announce(it.fix.label + ' applied.');
        recomputeNow();
      };
      p.fix.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); p.fix.onclick(ev); }
      };
      if (it.fix) setAttr(p.fix, 'title', it.fix.label);
      row.onclick = () => {
        if (it.blockId) select(it.blockId);
        const f = S.fields.find((q) => fieldMatches(q.fieldPath, it.field));
        if (f) {
          const focusable = f.el.querySelector('input, select, textarea');
          if (focusable && focusable.focus) focusable.focus();
        }
      };
      setAttr(row, 'title', (isErr ? 'Error — blocks Start. ' : 'Warning. ') + it.message);
    });
  }

  /**
   * The pre-run check rail (§5.5.1). Acknowledgeable failures are visually distinguished from the
   * blocking ones, because only the blocking ones stop a run.
   * @returns {void}
   */
  function renderPRC() {
    while (prcBody.firstChild) prcBody.removeChild(prcBody.firstChild);
    const st = ctx.run.state;
    if (!S.prc) {
      const e = mk(doc, 'div', 'vm-empty', (st === 'IDLE' || st === 'READY') ? 'NOT RUN' : 'N/A ' + st);
      e.title = (st === 'IDLE' || st === 'READY')
        ? 'Not run yet. The re-check button runs PRC-01 … PRC-12 against the installed method.'
        : 'Pre-run checks apply in IDLE and READY only; the run is ' + st + '.';
      cls(prcLamp, 'vm-dot--err', false);
      cls(prcLamp, 'vm-dot--warn', false);
      cls(prcLamp, 'vm-dot--ok', false);
      setAttr(prcLamp, 'title', e.title);
      add(prcBody, e);
      return;
    }
    const fails = S.prc.failures || [];
    if (fails.length === 0) {
      const wrap = mk(doc, 'div', 'vm-empty', '');
      wrap.title = 'All twelve pre-run checks passed. The run is armed (READY).';
      add(wrap, mk(doc, 'span', 'vm-pill vm-pill--ok', 'PRC 12/12'));
      cls(prcLamp, 'vm-dot--err', false);
      cls(prcLamp, 'vm-dot--warn', false);
      cls(prcLamp, 'vm-dot--ok', true);
      setAttr(prcLamp, 'title', wrap.title);
      add(prcBody, wrap);
      return;
    }
    const blocking = fails.some((f) => !f.acknowledgeable);
    cls(prcLamp, 'vm-dot--err', blocking);
    cls(prcLamp, 'vm-dot--warn', !blocking);
    cls(prcLamp, 'vm-dot--ok', false);
    setAttr(prcLamp, 'title', fails.length + ' pre-run check failure(s)'
      + (blocking ? ', at least one blocking.' : ', all acknowledgeable.'));
    for (const fl of fails) {
      const row = mk(doc, 'div', 'vm-issue');
      row.setAttribute('role', 'listitem');
      const mkr = mk(doc, 'span', 'vm-issue__mk');
      setAttr(mkr, 'data-s', fl.acknowledgeable ? 'warn' : 'alarm');
      const tx = mk(doc, 'span', 'vm-issue__tx');
      const hd = mk(doc, 'span', 'vm-issue__hd');
      add(hd, mk(doc, 'span', 'vm-issue__code', fl.code),
        mk(doc, 'span', 'vm-pill ' + (fl.acknowledgeable ? 'vm-pill--warn' : 'vm-pill--err'),
          fl.acknowledgeable ? 'ACK' : 'BLOCK'));
      add(tx, hd, mk(doc, 'span', 'vm-issue__msg', shortClause(fl.message, 36)));
      add(row, mkr, tx, mk(doc, 'span'));
      setAttr(row, 'title', (fl.acknowledgeable
        ? 'Acknowledgeable: the run may still be armed with this outstanding. '
        : 'Blocking: the run cannot be armed until this is resolved. ') + fl.message);
      add(prcBody, row);
    }
  }

  /**
   * Build a 110×22 %B sparkline for a template card from its 32 authored samples.
   * @param {Array<number>} spark 32 values, 0–100
   * @returns {SVGElement} the sparkline
   */
  function sparkSvg(spark) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('width', '110');
    svg.setAttribute('height', '22');
    svg.setAttribute('viewBox', '0 0 110 22');
    svg.setAttribute('aria-hidden', 'true');
    const pts = spark.map((v, i) => (i / (spark.length - 1) * 108 + 1).toFixed(1) + ','
      + (21 - clampN(v, 0, 100) / 100 * 20).toFixed(1)).join(' ');
    const poly = doc.createElementNS(NS, 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', S.tok('--pen-pctb', '#FF6EC7'));
    poly.setAttribute('stroke-width', '1.5');
    svg.appendChild(poly);
    return svg;
  }

  /**
   * Render the six built-in templates as cards with a mini gradient sparkline (spec-ux §6.4).
   * Templates are read-only: choosing one copies it into the draft.
   * @returns {void}
   */
  function renderTemplates() {
    while (tplBody.firstChild) tplBody.removeChild(tplBody.firstChild);
    for (const t of METHOD_TEMPLATES) {
      const card = mk(doc, 'button', 'vm-card');
      card.type = 'button';
      const left = mk(doc, 'span');
      add(left, mk(doc, 'span', 'vm-card__nm', t.name));
      const sub = mk(doc, 'span', 'vm-card__sub');
      add(left, mk(doc, 'br'), sub);
      add(card, left, sparkSvg(t.sparkline || []));
      let blocks = 0;
      let cv = 0;
      try {
        const m = t.method;
        blocks = m.blocks.length;
        for (const b of m.blocks) {
          if (!b.enabled) continue;
          const v = blockVolume_mL(ctx.config, b);
          if (Number.isFinite(v)) cv += v / ctx.config.column.V_mL;
        }
      } catch (e) { /* a template that will not build reports zeros rather than breaking the rail */ }
      setText(sub, blocks + ' BLK · ' + nf(cv, 1) + ' CV');
      setAttr(card, 'title', 'Load “' + t.name + '” into the editor (read-only template — the copy is yours)');
      card.addEventListener('click', () => loadTemplate(t, blocks, cv));
      add(tplBody, card);
    }
  }

  /**
   * Copy a template into the draft, optionally applying it immediately.
   * @param {{id:string, name:string, method:object}} t the template
   * @param {number} blocks its block count
   * @param {number} cv its total column volumes
   * @returns {void}
   */
  function loadTemplate(t, blocks, cv) {
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    let m = null;
    try { m = t.method; } catch (e) { toast(ui, 'That template could not be built.', 'warn'); return; }
    const body = mk(doc, 'div');
    add(body, mk(doc, 'div', null, t.name + ' — ' + blocks + ' blocks, ' + nf(cv, 1) + ' CV total.'));
    add(body, mk(doc, 'div', null,
      'Templates are read-only; this copies it into the editor. Your current draft is replaced.'));
    if (m.scale && m.scale !== ctx.config.scale) {
      const w = mk(doc, 'div', null, 'Authored at ' + m.scale + ' scale; this skid is '
        + ctx.config.scale + '. Flows in cm/h and thresholds in mAU re-resolve against this column.');
      w.style.color = S.tok('--warn', '#E8A33D');
      add(body, w);
    }
    modal(ui, { title: 'Load template', content: body, actions: [
      { label: 'Cancel' },
      { label: 'Load into editor', onClick: () => {
        const copy = clone(m);
        copy.methodId = 'm_' + t.id;
        copy.name = t.name;
        setDraft(copy, true);
        announce('Template loaded into the editor. Apply it to install it.');
        toast(ui, 'Template loaded. Press “Apply method” to install it.', 'info');
      } },
      { label: 'Load and apply', variant: 'primary', onClick: () => {
        const copy = clone(m);
        copy.methodId = 'm_' + t.id;
        copy.name = t.name;
        setDraft(copy, true);
        commit(false);
      } },
    ] });
  }

  /* ── import / export ──────────────────────────────────────────────────────────────────────── */

  /** @param {string} s a method name @returns {string} a safe file stem */
  function safeName(s) {
    return String(s || 'method').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'method';
  }

  /**
   * Write a method to a `.json` download. The installed method goes through
   * `io/export.js::exportMethodJSON` so the wrapper is byte-identical to every other export; an
   * uncommitted draft is wrapped in the same shape here.
   * @param {boolean} useDraft true to export the draft rather than what is installed
   * @returns {void}
   */
  function doExport(useDraft) {
    let payload;
    try {
      payload = useDraft
        ? { schemaVersion: '2.0',
          exportedFrom: { presetId: ctx.config.presetId, scale: ctx.config.scale,
            CV_mL: ctx.config.column.V_mL },
          method: clone(S.draft) }
        : exportMethodJSON(ctx.config);
    } catch (err) {
      toast(ui, 'Export failed: ' + ((err && err.message) || String(err)), 'warn');
      return;
    }
    const name = safeName((payload.method && payload.method.name) || 'method');
    downloadText(name + '.method.json', JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8');
    announce('Method exported.');
  }

  /** Export, asking first when the draft and the installed method differ. @returns {void} */
  function exportMethod() {
    if (!S.dirty) { doExport(false); return; }
    modal(ui, { title: 'Export which method?',
      content: mk(doc, 'div', null, 'The editor holds changes that are not installed. '
        + 'The draft exports exactly what you see; the installed method exports what the '
        + 'simulator would run.'),
      actions: [
        { label: 'Cancel' },
        { label: 'Installed method', onClick: () => doExport(false) },
        { label: 'Draft', variant: 'primary', onClick: () => doExport(true) },
      ] });
  }

  /** Open the file picker. @returns {void} */
  function importMethod() {
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    fileInput.value = '';
    fileInput.click();
  }

  /**
   * Parse, structurally validate and preview an imported method before installing it.
   * @param {string} text the file contents
   * @param {string} label the source shown in the summary, usually the file name
   * @returns {void}
   */
  function ingestMethodText(text, label) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      toast(ui, 'Not valid JSON: ' + ((err && err.message) || String(err)), 'warn');
      return;
    }
    let res;
    try {
      res = importMethodJSON(ctx.config, obj);
    } catch (err) {
      toast(ui, 'Import failed: ' + ((err && err.message) || String(err)), 'warn');
      return;
    }
    if (!res.ok) {
      const body = mk(doc, 'div');
      add(body, mk(doc, 'div', null, label + ' could not be imported:'));
      const ul = mk(doc, 'ul');
      for (const e of res.errors) add(ul, mk(doc, 'li', null, e));
      add(body, ul);
      modal(ui, { title: 'Import rejected', content: body, actions: [{ label: 'Close', variant: 'primary' }] });
      return;
    }
    // Summarise against THIS config: normalising here is what turns authored units into the numbers
    // the run would actually use, so the count the operator confirms is the real one.
    let norm = res.method;
    let cv = 0;
    let issues = { errors: [], warnings: [] };
    try {
      norm = normalizeMethod(ctx.config, res.method);
      for (const b of norm.blocks) {
        if (!b.enabled) continue;
        const v = blockVolume_mL(ctx.config, b);
        if (Number.isFinite(v)) cv += v / ctx.config.column.V_mL;
      }
      issues = validateMethod(ctx.config, norm);
    } catch (e) { /* the summary degrades; the draft still loads and the rail reports the rest */ }
    const body = mk(doc, 'div');
    add(body, mk(doc, 'div', null, (norm.name || 'Untitled') + ' — ' + norm.blocks.length
      + ' blocks, ' + nf(cv, 1) + ' CV total, from ' + label + '.'));
    add(body, mk(doc, 'div', null, issues.errors.length + ' error(s), '
      + issues.warnings.length + ' warning(s) against this column.'));
    if (issues.errors.length) {
      const e0 = mk(doc, 'div', null, 'First error — ' + issues.errors[0].code + ': '
        + issues.errors[0].message);
      e0.style.color = S.tok('--alarm', '#F2544B');
      add(body, e0);
    }
    modal(ui, { title: 'Import method', content: body, actions: [
      { label: 'Cancel' },
      { label: 'Import', variant: 'primary', onClick: () => {
        setDraft(res.method, true);
        announce('Method imported into the editor.');
        toast(ui, 'Imported. Press “Apply method” to install it.', 'info');
      } },
    ] });
  }

  /**
   * Read a `File` and hand its text to {@link ingestMethodText}.
   * @param {File} file the chosen or dropped file
   * @returns {void}
   */
  function readFile(file) {
    if (!file) return;
    const view = doc.defaultView;
    if (!view || typeof view.FileReader !== 'function') {
      toast(ui, 'This browser cannot read local files.', 'warn');
      return;
    }
    const fr = new view.FileReader();
    fr.onload = () => ingestMethodText(String(fr.result || ''), file.name);
    fr.onerror = () => toast(ui, 'Could not read ' + file.name + '.', 'warn');
    fr.readAsText(file);
  }

  fileInput.addEventListener('change', () => readFile(fileInput.files && fileInput.files[0]));

  const btnExport = iconBtn(doc, 'export',
    'Download this method as JSON (Ctrl+S). Unknown fields survive the round trip: the raw '
    + 'object travels with the method.', exportMethod, 'vm-btn--sm');
  const btnImport = iconBtn(doc, 'import',
    'Load a method from a JSON file, or drop one anywhere on this tab (Ctrl+O)',
    importMethod, 'vm-btn--sm');
  add(ioFt, btnExport, btnImport);

  let dropDepth = 0;
  /** @param {DragEvent} ev the dragenter @returns {void} */
  function onDragEnter(ev) {
    if (S.readOnly) return;
    ev.preventDefault();
    dropDepth++;
    cls(root, 'is-dropping', true);
  }
  /** @param {DragEvent} ev the dragover @returns {void} */
  function onDragOver(ev) { if (!S.readOnly) ev.preventDefault(); }
  /** @returns {void} */
  function onDragLeave() {
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) cls(root, 'is-dropping', false);
  }
  /** @param {DragEvent} ev the drop @returns {void} */
  function onDrop(ev) {
    ev.preventDefault();
    dropDepth = 0;
    cls(root, 'is-dropping', false);
    if (S.readOnly) { toast(ui, readOnlyReason(), 'blocked'); return; }
    const dt = ev.dataTransfer;
    if (dt && dt.files && dt.files.length) readFile(dt.files[0]);
  }
  root.addEventListener('dragenter', onDragEnter);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);

  /* ── commit bar and the whole-view render ─────────────────────────────────────────────────── */

  /** Refresh the bottom bar: dirty state, the first error, and the two commit buttons. @returns {void} */
  function renderBar() {
    const errs = S.validation.errors;
    const first = errs[0];
    let code;
    let full;
    let kind;
    if (S.readOnly) {
      code = 'LOCKED ' + ctx.run.state;
      full = readOnlyReason();
      kind = 'warn';
    } else if (first) {
      code = first.code;
      full = first.code + ': ' + first.message;
      kind = 'alarm';
    } else if (S.dirty) {
      code = 'DRAFT DIRTY';
      full = 'The draft has changes that are not installed. Apply installs them.';
      kind = 'warn';
    } else {
      code = 'IN SYNC';
      full = 'The draft matches the installed method.';
      kind = 'ok';
    }
    setText(barMsg, code);
    setAttr(barMsg, 'title', full);
    setAttr(barMsg, 'data-kind', kind);
    cls(barLamp, 'vm-dot--err', kind === 'alarm');
    cls(barLamp, 'vm-dot--warn', kind === 'warn');
    cls(barLamp, 'vm-dot--ok', kind === 'ok');
    setAttr(barLamp, 'title', full);
    btnApply.disabled = S.readOnly || errs.length > 0 || !S.dirty;
    btnApply.title = S.readOnly ? readOnlyReason()
      : (first ? 'Disabled: ' + first.code + ' — ' + first.message
        : (S.dirty ? 'Install this method through sim.loadMethod'
          : 'Nothing to apply — the draft matches the installed method.'));
    btnRevert.disabled = S.readOnly || !S.dirty;
    btnRevert.title = S.readOnly ? readOnlyReason()
      : (S.dirty ? 'Discard draft edits and reload the installed method'
        : 'Nothing to revert.');
  }

  /** Repaint everything that depends on the draft. @returns {void} */
  function renderAll() {
    const st = ctx.run.state;
    S.readOnly = !(st === 'IDLE' || st === 'READY' || st === 'ENDED');
    S.lastState = st;
    note.style.display = S.readOnly ? '' : 'none';
    if (S.readOnly) {
      setText(note, 'EDIT LOCKED · ' + st);
      setAttr(note, 'title', readOnlyReason());
    }
    renderList();
    renderEditor();
    renderStats();
    renderValidation();
    renderBar();
    if (S.plan) drawPreview(canvas, S.canvasW, ctx.config, S.plan, S.selectedId, S.tok);
  }

  /* ── bus, observers, keyboard ─────────────────────────────────────────────────────────────── */

  /**
   * Rebind after `config-replaced` / `preset-loaded` / `scenario-applied`: `config` and `run` are
   * new objects, so every cached reference is stale and the draft must come from the new config
   * (§2.4).
   * @returns {void}
   */
  function onConfigReplaced() {
    refreshTokens();
    if (S.selfCommit) {
      // This event is the echo of our own `loadMethod`. `commit` owns the draft across it: it must
      // still be able to compare what it submitted against what came back, so it is not reset here.
      renderTemplates();
      return;
    }
    const wasDirty = S.dirty;
    S.selectedId = null;
    S.prc = null;
    setDraft(ctx.config.method, false);
    renderTemplates();
    renderPRC();
    if (wasDirty) {
      toast(ui, 'The configuration changed — the editor reloaded and unapplied block edits were discarded.',
        'warn');
    }
  }

  /** @returns {void} re-read the token cache and repaint anything that draws with them */
  function onThemeChanged() {
    refreshTokens();
    renderAll();
  }

  /**
   * `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` undo and redo, scoped to this view (§9.7: every
   * destructive action is undoable).
   * @param {KeyboardEvent} ev the keydown
   * @returns {void}
   */
  function onKeyDown(ev) {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const k = ev.key.toLowerCase();
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if ((k === 'z' && ev.shiftKey) || k === 'y') { ev.preventDefault(); redo(); }
  }
  root.addEventListener('keydown', onKeyDown);

  let ro = null;
  let themeObserver = null;
  let mql = null;
  const busHandlers = [
    ['config-replaced', onConfigReplaced],
    ['preset-loaded', onConfigReplaced],
    ['scenario-applied', onConfigReplaced],
    ['run-reset', () => { S.prc = null; renderAll(); renderPRC(); }],
    ['run-ended', () => { renderAll(); }],
    ['theme-changed', onThemeChanged],
    ['method-export-requested', exportMethod],
    ['method-import-requested', importMethod],
  ];

  /* ── the Panel ────────────────────────────────────────────────────────────────────────────── */

  return {
    el: root,

    /**
     * Mount into `rootEl`: derive the draft from the installed method, wire the bus, the resize and
     * theme observers, and paint once.
     * @returns {void}
     */
    mount() {
      rootEl.appendChild(root);
      const view = doc.defaultView;
      if (view && typeof view.ResizeObserver === 'function') {
        // The only place a box is measured. `update` never reads layout (§6.24).
        ro = new view.ResizeObserver((entries) => {
          for (const e of entries) {
            const w = Math.max(240, Math.round(e.contentRect.width));
            if (w !== S.canvasW) {
              S.canvasW = w;
              if (S.plan) drawPreview(canvas, S.canvasW, ctx.config, S.plan, S.selectedId, S.tok);
            }
          }
        });
        ro.observe(pvBody);
      }
      if (view && typeof view.MutationObserver === 'function') {
        themeObserver = new view.MutationObserver(onThemeChanged);
        themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
      if (view && typeof view.matchMedia === 'function') {
        mql = view.matchMedia('(prefers-color-scheme: light)');
        if (mql.addEventListener) mql.addEventListener('change', onThemeChanged);
        else if (mql.addListener) mql.addListener(onThemeChanged);
      }
      if (ctx.bus && typeof ctx.bus.on === 'function') {
        for (const [name, fn] of busHandlers) ctx.bus.on(name, fn);
      }
      renderTemplates();
      setDraft(ctx.config.method, false);
      renderPRC();
    },

    /**
     * Render only. Services the 60 ms recompute debounce, and repaints the state-dependent chrome
     * when the run state changes. Costs one comparison per frame when nothing is pending, which is
     * what makes a hidden tab free (§6.24, §0).
     *
     * @param {{now_ms:number, dt_ms:number, tick:number, structural:boolean}} frameInfo the frame
     * @returns {void}
     */
    update(frameInfo) {
      const now = (frameInfo && Number.isFinite(frameInfo.now_ms))
        ? frameInfo.now_ms
        : ((doc.defaultView && doc.defaultView.performance)
          ? doc.defaultView.performance.now() : Date.now());
      if (ctx.run.state !== S.lastState) {
        S.lastState = ctx.run.state;
        const ro2 = !(ctx.run.state === 'IDLE' || ctx.run.state === 'READY' || ctx.run.state === 'ENDED');
        S.readOnly = ro2;
        note.style.display = ro2 ? '' : 'none';
        if (ro2) {
          setText(note, 'EDIT LOCKED · ' + ctx.run.state);
          setAttr(note, 'title', readOnlyReason());
        }
        renderList();
        refreshFields();
        renderBar();
        renderPRC();
      }
      if (frameInfo && frameInfo.structural) { recomputeNow(); return; }
      if (!S.pending) return;
      if (S.pendingImmediate) { recomputeNow(); return; }
      if (S.pendingSince === 0) S.pendingSince = now;
      else if (now - S.pendingSince >= DEBOUNCE_MS) recomputeNow();
    },

    /**
     * Tear down every listener, observer and timer this view owns, and drop the scoped stylesheet
     * when it is the last method view in the document.
     * @returns {void}
     */
    destroy() {
      if (ctx.bus && typeof ctx.bus.off === 'function') {
        for (const [name, fn] of busHandlers) ctx.bus.off(name, fn);
      }
      if (ro) { ro.disconnect(); ro = null; }
      if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
      if (mql) {
        if (mql.removeEventListener) mql.removeEventListener('change', onThemeChanged);
        else if (mql.removeListener) mql.removeListener(onThemeChanged);
        mql = null;
      }
      doc.removeEventListener('pointermove', dragMove);
      doc.removeEventListener('pointerup', dragEnd);
      doc.removeEventListener('pointercancel', dragEnd);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('dragenter', onDragEnter);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragleave', onDragLeave);
      root.removeEventListener('drop', onDrop);
      for (const t of ui.timers) clearTimeout(t);
      ui.timers.length = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
      releaseStyles(doc);
    },

    /** Export the method as JSON — bound to `Ctrl+S` by the shell (§9.5). @returns {void} */
    exportMethod,

    /** Import a method from JSON — bound to `Ctrl+O` by the shell (§9.5). @returns {void} */
    importMethod,
  };
}
