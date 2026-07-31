/**
 * @file src/ui/app.js — the composition root, the FT-CLASSIC shell, and the program's ONLY
 * `requestAnimationFrame` loop.
 *
 * THE SCREEN. A classic Rockwell FactoryTalk View SE / Wonderware InTouch operator screen: beveled
 * grey chrome, sunken near-black label boxes, icon-only controls, square corners. Five bands:
 *
 *   1. TITLE STRIP  26 px — unit name (the SIMULATED honesty note lives behind it), the block
 *                           counter, the sim clock with the method-progress bar, and the
 *                           alarm-summary lamps with the active-alarm count.
 *   2. TOOLBAR      40 px — 34×34 beveled icon buttons in groups split by 2 px sunken grooves:
 *                           [run][hold][continue][skip][stop][reset] ‖ [estop] ‖
 *                           speed chips 1× … 1000× + [pause] + LIMITED lamp + SPD box ‖
 *                           [P&ID][TREND][METHOD][RESULTS][CONFIG] ‖
 *                           [ack][manual][scenarios][help][theme]
 *   3. ALARM BANNER 24 px — present only while an alarm is active or a shell error is showing:
 *                           blinking lamp, severity code, ISA tag, alarm code, trip condition,
 *                           acknowledge and silence. Carries the two `aria-live` regions.
 *   4. WORKSPACE          — one `.view` per screen, stacked and shown one at a time. The MAIN
 *                           screen is `ui/view_run.js`, which holds the P&ID panel over the trend
 *                           panel with the draggable splitter between them: the P&ID and TREND nav
 *                           buttons therefore select the SAME screen and only hint which pane to
 *                           favour, because the co-visibility of schematic and trend is the
 *                           requirement and no navigation may take it away.
 *   5. STATUS STRIP 24 px — sunken label boxes FLOW %B P1 dP UV COND pH CV, then the run-state
 *                           lamp with its STATE box and the data-quality lamp with its QUAL box.
 *
 * NO PROSE ON A NORMAL SCREEN. Every control is an icon with `title` + `aria-label`; every number
 * sits in a label box carrying its tag and its engineering unit. Sentences live in tooltips, in the
 * `data/glossary.js` popovers, in help, and on failure surfaces — nowhere else.
 *
 * RESPONSIBILITIES
 *   - Build the ONE `ctx = { config, run, bus, sim, fmt, overrides }`. `skid.createSkid` is
 *     REQUIRED after every `createRunState`, or `run.topo/bed/col` stay null and the first
 *     `physicsTick` throws.
 *   - Own the single rAF loop: `sim.advanceWall(ctx, wallDt_s)` once per frame, then `update()` on
 *     the VISIBLE screen only. A hidden screen costs nothing.
 *   - Own the persistent chrome and every global keyboard shortcut.
 *   - Route every `sim.*` action's `{ ok, reason }` to a toast when `ok` is false — never a silent
 *     refusal.
 *   - Surface `run.speedDeficit` honestly: a LIMITED lamp beside the speed chips plus the achieved
 *     multiplier in the SPD label box.
 *
 * THE UI IS READ-ONLY OVER `run` AND `config`. Nothing in this file assigns to either; every
 * mutation goes through `core/sim.js`.
 *
 * FRAME SAFETY. `sim.advanceWall` and every panel `update()` are guarded: a throwing panel is
 * reported in the alarm band and, after three consecutive failures, taken out of the loop — but the
 * loop itself never dies and the shell never freezes.
 *
 * DOM DISCIPLINE. `boot` empties `#app` and builds the shell once. After that this module writes
 * only text, classes and attributes onto cached node references: there is no `innerHTML` anywhere
 * in this file, and no layout read inside a frame.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CSS CONTRACT — the class vocabulary this module emits, all of it styled in `styles/app.css`:
 *   .shell (.is-manual .is-narrow) .skip-link .sr-only
 *   .titlebar .titlebar__brand .titlebar__name .titlebar__spacer .titlebar__meta .titlebar__actions
 *   .toolbar .toolbar__group (.toolbar__group--estop) .toolbar__sep .toolbar__spacer
 *   .iconbtn (.is-active .iconbtn--sm .btn--estop) .holdring .holdring__track .holdring__fill
 *   .segmented .speedchip (.is-active)
 *   .lamp .lamp--off|run|warn|alarm (.is-blink)
 *   .tagblk .tagblk__lbl .lbox (.lbox--wide .lbox--narrow .is-alarm .is-warn .is-stale)
 *   .lbox__v .lbox__eu
 *   .progress .progress__fill
 *   .alarmbar .banner__sev .alarmbar__tag .alarmbar__code .banner__detail .banner__actions
 *   .banner__count
 *   .workspace .view .view--main|method|results|config
 *   .statusstrip .statusstrip__spacer
 *   .perf .perf__row .perf__key .perf__value
 * Buttons and glyphs come from `ui/hmi.js` (`iconButton`, `icon`); the label boxes, lamps and bands
 * are built here against the classes above. Every icon name used is one of `hmi.ICON_NAMES`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Layer L10.
 */

import * as sim from '../core/sim.js';
import * as state from '../core/state.js';
import { createBus, QF } from '../core/log.js';
import * as skid from '../skid/skid.js';
import { blockProgress } from '../skid/engine.js';
import { methodDemand } from '../skid/method.js';
import { sensorQuality } from '../skid/sensors.js';
import * as column from '../physics/column.js';
import * as bed from '../physics/bed.js';
import * as presets from '../data/presets.js';
import { GLOSSARY, glossaryFor } from '../data/glossary.js';
import { exportMethodJSON, importMethodJSON, downloadText } from '../io/export.js';
import * as fmt from './format.js';
import * as hmi from './hmi.js';
import * as overlay from './overlay.js';
import * as onboarding from './onboarding.js';
import { createRunView } from './view_run.js';
import { createMethodView } from './view_method.js';
import { createResultsView } from './view_results.js';
import { createSystemView } from './view_system.js';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * CONSTANTS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** The preset the shell boots into. */
const DEFAULT_PRESET_ID = 'cex-capture-igg1-pilot';

/**
 * The four screens of the workspace, in DOM order. `main` is `ui/view_run.js`: the P&ID panel over
 * the trend panel, splitter between, both always visible.
 */
const SCREENS = [
  { id: 'main', create: createRunView },
  { id: 'method', create: createMethodView },
  { id: 'results', create: createResultsView },
  { id: 'config', create: createSystemView },
];

/**
 * The five navigation buttons. `pid` and `trend` select the SAME screen and differ only in the
 * `request-pane` hint they publish, because that screen shows both panes at once.
 */
const NAV = [
  { id: 'pid', screen: 'main', pane: 'pid', icon: 'pid', label: 'Process schematic (P&ID)', key: 'Alt+1' },
  { id: 'trend', screen: 'main', pane: 'trend', icon: 'trend', label: 'Trend', key: 'Alt+2' },
  { id: 'method', screen: 'method', pane: null, icon: 'method', label: 'Method editor', key: 'Alt+3' },
  { id: 'results', screen: 'results', pane: null, icon: 'results', label: 'Results', key: 'Alt+4' },
  { id: 'config', screen: 'config', pane: null, icon: 'config', label: 'Configuration', key: 'Alt+5' },
];

/** Legacy tab ids other modules still emit on `request-tab`, mapped onto the nav ids. */
const LEGACY_NAV = {
  run: 'pid', pid: 'pid', trend: 'trend', chart: 'trend',
  method: 'method', results: 'results', system: 'config', config: 'config',
};

/**
 * The status strip, left to right.
 *
 * `signals` are the `AlarmDef.signal` names and `evals` the `AlarmDef.evalKey` names that turn the
 * digits red — an alarm table row watches a tag through one or the other, never both, so a box that
 * only matched `signal` would stay lime while its own custom-evaluator alarm was standing.
 * `sensor` is the `sensorQuality` channel that turns the digits stale.
 */
const STATUS_FIELDS = [
  { key: 'flow', tag: 'FLOW', isa: 'FIC-101', kind: 'flow', gloss: 'FT-101', sensor: null,
    signals: ['FLOW'], evals: ['flowDeviation', 'dryRun', 'cavitation'] },
  { key: 'pctb', tag: '%B', isa: 'AIC-101', kind: 'pct', gloss: 'pctB', sensor: null,
    signals: [], evals: [] },
  { key: 'p1', tag: 'P1', isa: 'PT-101', kind: 'pressure', gloss: 'PT-101', sensor: 'PRESS',
    signals: ['P1'], evals: [] },
  { key: 'dp', tag: 'dP', isa: 'PDT-101', kind: 'pressure', gloss: 'PDT-101', sensor: 'PRESS',
    signals: ['DP'], evals: [] },
  { key: 'uv', tag: 'UV', isa: 'UV-101', kind: 'abs', gloss: 'UV-101', sensor: 'UV',
    signals: ['UV'], evals: ['uvOverrange', 'uvLampFault', 'azUnstable'] },
  { key: 'cond', tag: 'COND', isa: 'CE-101', kind: 'cond', gloss: 'CE-101', sensor: 'COND',
    signals: ['COND'], evals: ['condRange'] },
  { key: 'ph', tag: 'pH', isa: 'AE-101', kind: 'ph', gloss: 'AE-101', sensor: 'PH',
    signals: ['PH'], evals: ['phRange', 'phDegraded'] },
  { key: 'cv', tag: 'CV', isa: '', kind: 'cv', gloss: 'cv', sensor: null,
    signals: [], evals: ['cvMismatch'] },
];

/** Allowed axial grid sizes for the startup benchmark. Downgrade only. */
const NZ_LADDER = [100, 200, 400, 800];

/**
 * Column-solver budget in milliseconds per SIMULATED second, used to pick `nz` at boot.
 * The reference machine measures ~5 ms/sim-s at `nz = 400`, so 8.0 keeps the shipped grid on a
 * reference-class machine and downgrades on one ~1.6× slower.
 */
const NZ_BUDGET_MS_PER_SIM_S = 8.0;

/** Simulated seconds the startup benchmark covers. */
const BENCH_SIM_SECONDS = 3.0;

/** Wall-clock clamp per frame, seconds — mirrors `sim.advanceWall`'s own clamp. */
const WALL_CLAMP_S = 0.25;

/** Press-and-hold duration for Skip Block, ms. */
const SKIP_HOLD_MS = 400;

/** Two `Shift+Esc` presses inside this window fire the emergency stop. */
const ESTOP_DOUBLE_MS = 1000;

/** Consecutive `update()` throws before a screen is taken out of the frame loop. */
const PANEL_FAIL_LIMIT = 3;

/** Radius of the Skip Block hold ring, SVG user units on a 24×24 viewBox. */
const RING_R = 10;

/** Severity ladder used to rank the alarm banner. */
const SEVERITY_RANK = { INFO: 0, WARN: 1, ALARM: 2, CRITICAL: 3, FAULT: 4 };

/** Four-character severity codes — the banner has 24 px, not a sentence. */
const SEVERITY_CODE = { INFO: 'INFO', WARN: 'WARN', ALARM: 'ALRM', CRITICAL: 'CRIT', FAULT: 'FLT' };

/** Lamp colour per severity. */
const SEVERITY_LAMP = { INFO: 'run', WARN: 'warn', ALARM: 'alarm', CRITICAL: 'alarm', FAULT: 'alarm' };

/** Event types that change list content and therefore demand a `structural` frame. */
const STRUCTURAL_EVENT_TYPES = {
  BLOCK_START: 1, BLOCK_END: 1, FRACTION_START: 1, FRACTION_END: 1,
  ALARM_RAISED: 1, ALARM_CLEARED: 1, ALARM_ACK: 1, RUN_START: 1, RUN_END: 1,
  STATE_CHANGE: 1, PACKING_TEST_RESULT: 1, SCENARIO_APPLIED: 1,
};

/** Human names for the `run.qualityFlags` bits, for the quality lamp's tooltip and popover. */
const QF_LABELS = [
  [QF.UV_OVERRANGE, 'UV over-range'],
  [QF.UV_SATURATED, 'UV saturated'],
  [QF.UV_LAMP_FAULT, 'UV lamp fault'],
  [QF.UV_AUTOZERO_UNSTABLE, 'Autozero unstable'],
  [QF.COND_DRY, 'Conductivity cell dry'],
  [QF.COND_TEMP_RANGE, 'Cell temperature out of range'],
  [QF.PH_FROZEN_AIR, 'pH frozen by air'],
  [QF.PH_ELECTRODE_DEGRADED, 'pH electrode degraded'],
  [QF.PRESS_SUSPECT, 'Pressure suspect'],
  [QF.DETECTORS_BYPASSED, 'Detectors bypassed'],
  [QF.AIR_IN_PATH, 'Air in the flow path'],
  [QF.FLOW_REDUCED, 'Flow reduced automatically'],
  [QF.MANUAL_OVERRIDE, 'Manual control'],
  [QF.SOLVER_FROZEN, 'Isotherm solver frozen'],
  [QF.SPEED_LIMITED, 'Simulation speed limited'],
  [QF.BED_COLLAPSED, 'Bed collapsed'],
];

/** Three-letter quality codes for the QUAL box. */
const QUALITY_CODE = { OK: 'OK', SUSPECT: 'SUS', INVALID: 'INV', BYPASSED: 'BYP' };

/** The inline reset an interactive label box needs, since `.tagblk` is not a button class. */
const BARE_BUTTON = { appearance: 'none', background: 'none', border: '0', padding: '0', cursor: 'pointer' };

/**
 * The global keyboard registry.
 *
 * Keys are normalised combos (`normaliseCombo`): modifiers in the fixed order `Ctrl+Alt+Shift+`,
 * then the key name with single characters upper-cased. `Shift` is dropped for punctuation so `?`,
 * `+` and `-` are reachable on every layout.
 *
 * Shell-scoped actions execute here. Panel-scoped actions (trend, legend, pooling) are emitted on
 * `ctx.bus` as `('key-action', { action, combo, event })`, so whichever panel owns them reacts
 * without a second document-level key listener existing anywhere in the program.
 *
 * @type {{[combo:string]: {action:string, label:string, group:string}}}
 */
export const KEYMAP = {
  'Space': { action: 'start-hold-toggle', label: 'Start / Hold toggle', group: 'Run control' },
  'Ctrl+Enter': { action: 'start-run', label: 'Start the run', group: 'Run control' },
  'H': { action: 'hold', label: 'Hold — flow continues, the clock freezes', group: 'Run control' },
  'C': { action: 'continue', label: 'Continue', group: 'Run control' },
  'N': { action: 'skip-block', label: 'Skip the current block (confirm)', group: 'Run control' },
  'E': { action: 'end-run', label: 'End the run (confirm)', group: 'Run control' },
  'Shift+Escape': { action: 'estop', label: 'Emergency stop — press twice within 1 s', group: 'Run control' },
  '1': { action: 'speed:0', label: 'Sim speed preset 1', group: 'Simulation speed' },
  '2': { action: 'speed:1', label: 'Sim speed preset 2', group: 'Simulation speed' },
  '3': { action: 'speed:2', label: 'Sim speed preset 3', group: 'Simulation speed' },
  '4': { action: 'speed:3', label: 'Sim speed preset 4', group: 'Simulation speed' },
  '5': { action: 'speed:4', label: 'Sim speed preset 5', group: 'Simulation speed' },
  '6': { action: 'speed:5', label: 'Sim speed preset 6', group: 'Simulation speed' },
  '7': { action: 'speed:6', label: 'Sim speed preset 7', group: 'Simulation speed' },
  'P': { action: 'pause-toggle', label: 'Pause / resume the simulation', group: 'Simulation speed' },
  '[': { action: 'speed-down', label: 'Sim speed down one step', group: 'Simulation speed' },
  ']': { action: 'speed-up', label: 'Sim speed up one step', group: 'Simulation speed' },
  'Alt+1': { action: 'nav:pid', label: 'Main screen, favour the P&ID pane', group: 'Navigation' },
  'Alt+2': { action: 'nav:trend', label: 'Main screen, favour the trend pane', group: 'Navigation' },
  'Alt+3': { action: 'nav:method', label: 'Method screen', group: 'Navigation' },
  'Alt+4': { action: 'nav:results', label: 'Results screen', group: 'Navigation' },
  'Alt+5': { action: 'nav:config', label: 'Configuration screen', group: 'Navigation' },
  'X': { action: 'x-axis-cycle', label: 'Cycle the x axis: volume / CV / time', group: 'Trend' },
  'A': { action: 'autoscale', label: 'Autoscale — fit all', group: 'Trend' },
  'F': { action: 'follow-toggle', label: 'Toggle follow-live', group: 'Trend' },
  '+': { action: 'zoom-in', label: 'Zoom in about the cursor', group: 'Trend' },
  '-': { action: 'zoom-out', label: 'Zoom out about the cursor', group: 'Trend' },
  'ArrowLeft': { action: 'pan-left', label: 'Pan left', group: 'Trend' },
  'ArrowRight': { action: 'pan-right', label: 'Pan right', group: 'Trend' },
  'Shift+ArrowLeft': { action: 'pan-left-fast', label: 'Pan left, 5×', group: 'Trend' },
  'Shift+ArrowRight': { action: 'pan-right-fast', label: 'Pan right, 5×', group: 'Trend' },
  'L': { action: 'legend-focus', label: 'Pen rail focus mode', group: 'Trend' },
  'M': { action: 'mark-fraction', label: 'Mark a fraction manually', group: 'Fractions' },
  'Shift+P': { action: 'pool-selection', label: 'Pool the selected fraction range', group: 'Fractions' },
  '?': { action: 'cheat-sheet', label: 'This shortcut list', group: 'General' },
  'Ctrl+S': { action: 'export-method', label: 'Export the method as JSON', group: 'General' },
  'Ctrl+O': { action: 'import-method', label: 'Import a method from JSON', group: 'General' },
  'Ctrl+Alt+P': { action: 'perf-overlay', label: 'Performance overlay', group: 'General' },
  'Escape': { action: 'dismiss', label: 'Close a popover or dialog, cancel a drag', group: 'General' },
};

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * MODULE SINGLETON
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The one live application instance. `boot` creates it; the exported `frame` reads it.
 * @type {object|null}
 */
let app = null;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * WIDGETS — icon buttons and glyphs come from ui/hmi.js; label boxes and lamps are built here
 * against the FT-CLASSIC classes styles/app.css defines.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Build an element through `ui/format.js::h`, the app's only element factory.
 * @param {string} tag element tag name
 * @param {object} attrs attribute bag (see `format.h`)
 * @param {...(Node|string)} children child nodes or text
 * @returns {Element} the new element
 */
function h(tag, attrs, ...children) {
  return fmt.h(tag, attrs, ...children);
}

/**
 * Create a `<button>` with a click handler already attached. Used for the few text controls the
 * design allows — the speed numerals — and for the buttons inside modals.
 * @param {string} className the full class attribute
 * @param {string} label visible text
 * @param {function(MouseEvent):void} onClick click handler
 * @param {object} [attrs] extra attributes (title, aria-*, data-*)
 * @returns {HTMLButtonElement} the button
 */
function button(className, label, onClick, attrs) {
  const a = Object.assign({ class: className, type: 'button' }, attrs || {});
  const el = /** @type {HTMLButtonElement} */ (h('button', a, label));
  el.addEventListener('click', onClick);
  return el;
}

/**
 * Build one 34×34 beveled icon button through `hmi.iconButton`, carrying the shell's own `.iconbtn`
 * class so `styles/app.css` and the kit's own rules agree on its geometry.
 *
 * The face never carries a word: the meaning is in `title` (hover) and `aria-label` (assistive
 * technology), exactly as an FT-CLASSIC toolbar does it.
 *
 * @param {{icon:string, label:string, title?:string, cls?:string, danger?:boolean, sm?:boolean,
 *          pressed?:boolean, onClick?:function(MouseEvent):void}} spec the button
 * @returns {HTMLButtonElement} the button
 */
function iconButton(spec) {
  const size = spec.sm ? 26 : 34;
  const btn = hmi.iconButton(spec.icon, {
    title: spec.title || spec.label,
    ariaLabel: spec.label,
    onClick: spec.onClick,
    className: `iconbtn${spec.sm ? ' iconbtn--sm' : ''}${spec.cls ? ` ${spec.cls}` : ''}`,
    size,
    iconSize: spec.sm ? 14 : 20,
    danger: !!spec.danger,
    pressed: spec.pressed,
  });
  return btn;
}

/**
 * Build a round status lamp. Colour alone never carries meaning: every lamp has an accessible name
 * and a tooltip that states the condition it is showing.
 * @param {string} label the initial accessible name
 * @returns {HTMLElement} the lamp
 */
function lamp(label) {
  return /** @type {HTMLElement} */ (h('span', {
    class: 'lamp lamp--off', role: 'img', 'aria-label': label, title: label,
  }));
}

/**
 * Drive a lamp built by {@link lamp}.
 * @param {Element} el the lamp
 * @param {'off'|'run'|'warn'|'alarm'} tone the lamp colour
 * @param {string} label the accessible name, which must state the current condition
 * @param {boolean} [blink] true to blink (CSS stands this down under `prefers-reduced-motion`)
 * @returns {void}
 */
function setLamp(el, tone, label, blink) {
  if (!el) return;
  fmt.cls(el, 'lamp--off', tone === 'off');
  fmt.cls(el, 'lamp--run', tone === 'run');
  fmt.cls(el, 'lamp--warn', tone === 'warn');
  fmt.cls(el, 'lamp--alarm', tone === 'alarm');
  fmt.cls(el, 'is-blink', !!blink);
  fmt.setAttr(el, 'aria-label', label);
  fmt.setAttr(el, 'title', label);
}

/**
 * Build a label box: a 10 px uppercase tag beside a sunken near-black field holding right-aligned
 * tabular digits and a smaller, dimmer engineering unit. This is the workhorse of the design —
 * every number in the chrome lives in one.
 *
 * The box becomes a real button when there is something behind it (a glossary entry, or an explicit
 * handler), so the explanation is reachable from the keyboard. A box with nothing behind it stays a
 * span: a dead button is worse than a label.
 *
 * @param {{tag:string, eu?:string, title?:string, wide?:boolean, narrow?:boolean, gloss?:string,
 *          onClick?:function(MouseEvent):void}} spec the box
 * @returns {{el:HTMLElement, val:Element, eu:Element, box:Element}} the box and its live nodes
 */
function labelBox(spec) {
  const val = h('span', { class: 'lbox__v' }, fmt.NO_VALUE);
  const eu = h('span', { class: 'lbox__eu' }, spec.eu || '');
  const box = h('span', {
    class: `lbox${spec.wide ? ' lbox--wide' : ''}${spec.narrow ? ' lbox--narrow' : ''}`,
  }, val, eu);
  const tag = h('span', { class: 'tagblk__lbl' }, spec.tag);

  const entry = spec.gloss ? glossaryFor(spec.gloss) : null;
  const interactive = !!(spec.onClick || entry);
  const el = /** @type {HTMLElement} */ (h(interactive ? 'button' : 'span', {
    class: 'tagblk',
    type: interactive ? 'button' : null,
    style: interactive ? BARE_BUTTON : null,
    title: spec.title || spec.tag,
    'data-tag': spec.tag,
  }, tag, box));
  if (interactive) {
    el.addEventListener('click', (ev) => {
      if (spec.onClick) spec.onClick(ev);
      else if (app) showGlossary(app, el, spec.gloss);
    });
  }
  return { el, val, eu, box };
}

/**
 * Write a value into a label box, skipping unchanged text.
 * @param {{val:Element, eu:Element}} rec a {@link labelBox} record
 * @param {string} text the formatted value
 * @param {string} [euText] the engineering unit
 * @returns {void}
 */
function setBox(rec, text, euText) {
  if (!rec) return;
  fmt.setText(rec.val, text);
  if (euText !== undefined) fmt.setText(rec.eu, euText);
}

/**
 * Colour a label box's digits: alarm red beats stale grey-green beats the normal PV lime.
 * @param {{box:Element}} rec a {@link labelBox} record
 * @param {boolean} inAlarm true when the tag is in alarm
 * @param {boolean} stale true when the sensor quality is SUSPECT, INVALID or BYPASSED
 * @returns {void}
 */
function setBoxState(rec, inAlarm, stale) {
  if (!rec) return;
  fmt.cls(rec.box, 'is-alarm', inAlarm);
  fmt.cls(rec.box, 'is-stale', !inAlarm && stale);
}

/**
 * Set `disabled` plus a `title` that explains WHY when the control is unavailable.
 * @param {HTMLButtonElement} el the control
 * @param {boolean} enabled true to enable
 * @param {string} whyDisabled the tooltip shown while disabled
 * @param {string} whenEnabled the tooltip shown while enabled
 * @returns {void}
 */
function setEnabled(el, enabled, whyDisabled, whenEnabled) {
  if (!el) return;
  if (el.disabled !== !enabled) el.disabled = !enabled;
  fmt.setAttr(el, 'title', enabled ? whenEnabled : whyDisabled);
}

/** @returns {Element} a 2 px sunken groove between two toolbar groups */
function toolbarSep() {
  return h('span', {
    class: 'toolbar__sep', role: 'separator', 'aria-orientation': 'vertical',
  });
}

/**
 * True when a text-entry element has focus, in which case bare keys are the user's typing.
 * @returns {boolean} whether keyboard shortcuts must stand down
 */
function typingInField() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(/** @type {HTMLElement} */ (el).isContentEditable);
}

/**
 * Normalise a keyboard event to a `KEYMAP` combo string.
 *
 * Modifier order is fixed (`Ctrl+Alt+Shift+`); `Meta` folds into `Ctrl` so macOS `⌘S` works.
 * `Shift` is dropped for non-letter single characters, because `?`, `+`, `[` and `]` require it on
 * many layouts and would otherwise be unreachable.
 *
 * @param {KeyboardEvent} e the event
 * @returns {string} the combo, e.g. `'Ctrl+Alt+P'`, `'Shift+Escape'`, `'?'`
 */
function normaliseCombo(e) {
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  const single = key.length === 1;
  const isLetter = single && key.toUpperCase() !== key.toLowerCase();
  if (single) key = key.toUpperCase();
  let combo = '';
  if (e.ctrlKey || e.metaKey) combo += 'Ctrl+';
  if (e.altKey) combo += 'Alt+';
  if (e.shiftKey && (!single || isLetter)) combo += 'Shift+';
  return combo + key;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * BOOT
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Build the whole application inside `rootEl` and start the frame loop.
 *
 * Boot order:
 *   1. warm both theme-token maps, adopt the theme `index.html` stamped, build the shell chrome;
 *   2. build `ctx` (`normalizePreset` → `createRunState` → **`createSkid`**, which is required);
 *   3. benchmark a throwaway column, pick `nz` (downgrade only), `sim.rebuild(ctx, {column:{nz}})`;
 *   4. mount the four screens, only the visible one updating;
 *   4a. mount `ui/onboarding.js` — after the screens, because its coach marks measure them, and
 *       before the loop, because its tour may auto-load a scenario;
 *   5. start the single `requestAnimationFrame` loop.
 *
 * @param {Element} rootEl `#app` from `index.html`; its placeholder content is removed
 * @returns {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}}
 *   the one long-lived `ctx`
 */
export function boot(rootEl) {
  if (app && app.rafId) cancelAnimationFrame(app.rafId);
  // createOverlayHost appends a fresh .ov-root to <body> every call, so a second boot() in the same
  // document would leave the first host's layer, Esc handler and focus trap behind. Tear it down on
  // the same re-entry path that already cancels the previous rAF loop.
  if (app && app.overlayHost) {
    try { overlay.destroyOverlayHost(app.overlayHost); } catch (err) { /* never block a re-boot */ }
  }

  const presetId = presets.PRESETS[DEFAULT_PRESET_ID]
    ? DEFAULT_PRESET_ID
    : Object.keys(presets.PRESETS)[0];

  const config = presets.normalizePreset(presetId, {});
  const run = state.createRunState(config);
  skid.createSkid(config, run);                       // REQUIRED: builds run.topo / bed / col

  /** @type {any} */
  const ctx = { config, run, bus: createBus(), sim, fmt, overrides: {} };

  app = {
    ctx,
    root: rootEl,
    el: {},                       // cached shell nodes
    screens: new Map(),           // screenId -> { panel, host, failCount, disabled }
    activeScreen: 'main',
    activeNav: 'pid',
    overlayHost: null,
    glossaryHandle: null,         // the ONE open glossary popover, or null — see showGlossary
    onboarding: null,
    // FT-CLASSIC is a light design; index.html stamps light before first paint.
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
    rafId: 0,
    tPrev: 0,
    structural: true,
    frameInfo: { now_ms: 0, dt_ms: 16.7, tick: 0, structural: true },
    lastEventCount: 0,
    demandCache: null,            // { config, total_mL, startById }
    progressPct: -1,
    // `null`, never `''`: an EMPTY alarm set has the signature `''`, so a `''` sentinel would make
    // "some alarms" -> "no alarms" compare equal and leave the banner on screen forever.
    alarmSig: null,
    alarm: {
      active: [], signals: new Set(), evals: new Set(),
      count: 0, crit: 0, alarms: 0, warns: 0, worst: '', ackable: null,
    },
    silenced: new Set(),          // alarm ids the operator muted for this session
    liveAlarmId: null,
    shellError: null,             // { source, message, detail } — the failure surface of the band
    skipHold: { active: false, start_ms: 0 },
    estopArm_ms: 0,
    perfOn: false,
    perf: { frame_ms: 16.7, sim_ms: 0, render_ms: 0, ticks: 0, tps: 0, tAcc: 0, nAcc: 0 },
    perfRows: null,
    simFailed: false,
    fileInput: null,
    benchmark: null,
  };

  try {
    // ---- 1. theme tokens + shell chrome ------------------------------------------------------
    warmThemeTokens();
    buildShell(app);
    applyTheme(app, app.theme, false);

    // ---- 3. startup grid benchmark -----------------------------------------------------------
    runStartupBenchmark(app);

    // ---- 4. the four screens -----------------------------------------------------------------
    mountScreens(app);

    // ---- 4a. onboarding ----------------------------------------------------------------------
    try {
      app.onboarding = onboarding.createOnboarding(app.el.shell, ctx, app.overlayHost);
      if (app.onboarding && typeof app.onboarding.mount === 'function') app.onboarding.mount();
    } catch (err) {
      app.onboarding = null;
      reportError(app, 'onboarding', err);
    }

    // ---- input wiring ------------------------------------------------------------------------
    wireBus(app);
    wireKeyboard(app);
    wireResponsive(app);
    document.addEventListener('visibilitychange', () => { app.tPrev = 0; });

    refreshNav(app);
    refreshShell(app, true);
  } catch (err) {
    showBootError(err);
    throw err;
  }

  // ---- 5. the one rAF loop -------------------------------------------------------------------
  app.rafId = requestAnimationFrame(frame);
  return ctx;
}

/**
 * Reveal `index.html`'s `#boot-error` panel with a real message. A blank page is the worst possible
 * failure mode for a teaching tool, so a boot that throws says what threw.
 * @param {*} err the thrown value
 * @returns {void}
 */
function showBootError(err) {
  const panel = document.getElementById('boot-error');
  if (!panel) return;
  const slot = panel.querySelector('[data-slot="detail"]');
  if (slot) fmt.setText(slot, `${errText(err)}\n${(err && err.stack) || ''}`);
  panel.hidden = false;
}

/**
 * Warm both theme-token maps once at boot. `readThemeTokens` owns the hidden probes and the cache;
 * calling it here pays that cost before the first paint instead of inside a frame.
 * @returns {void}
 */
function warmThemeTokens() {
  try {
    fmt.readThemeTokens('light');
    fmt.readThemeTokens('dark');
  } catch (err) {
    // A missing token map degrades exported-PNG colour fidelity; it must never block boot.
    console.warn('readThemeTokens failed at boot:', err);
  }
}

/**
 * Time a throwaway column and pick the axial grid size, downgrading only.
 *
 * Cost scales close to `nz²` — the cell count rises linearly and the Courant-limited substep count
 * rises with it — so one measurement at the preset's own `nz` predicts every rung of the ladder.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function runStartupBenchmark(a) {
  const cfg = a.ctx.config;
  try {
    const demand = methodDemand(cfg, cfg.method);
    const flow_mLs = (demand && demand.totalTime_s > 0)
      ? demand.totalVolume_mL / demand.totalTime_s
      : cfg.column.A_cm2 * 150 / 3600;
    const bench = column.benchmarkColumn(bed.buildColumnCfg(cfg), {
      simSeconds: BENCH_SIM_SECONDS,
      flow_mLs: Math.max(flow_mLs, 1e-3),
    });
    a.benchmark = bench;

    const nz0 = bench.nz || cfg.column.nz;
    const cost0 = bench.msPerSimSecond;
    let pick = NZ_LADDER[0];
    if (Number.isFinite(cost0) && cost0 > 0) {
      for (const nz of NZ_LADDER) {
        if (nz > cfg.column.nz) break;                     // downgrade only, never upgrade
        const predicted = cost0 * (nz / nz0) * (nz / nz0);
        if (predicted <= NZ_BUDGET_MS_PER_SIM_S) pick = nz;
      }
    } else {
      pick = Math.min(cfg.column.nz, NZ_LADDER[NZ_LADDER.length - 1]);
    }
    if (pick !== cfg.column.nz) sim.rebuild(a.ctx, { column: { nz: pick } });
  } catch (err) {
    // A failed benchmark leaves the preset's own nz in place. That is the safe direction.
    console.warn('startup grid benchmark failed, keeping the preset nz:', err);
  }
}

/**
 * Construct the four screens into their hosts and hide all but the active one. A screen that throws
 * at construction is reported in the alarm band instead of taking the shell down.
 * @param {object} a the application instance
 * @returns {void}
 */
function mountScreens(a) {
  for (const scr of SCREENS) {
    const host = h('section', {
      class: `view view--${scr.id}`, id: `screen-${scr.id}`, 'data-screen': scr.id, tabindex: '0',
    });
    if (scr.id !== a.activeScreen) host.hidden = true;
    a.el.workspace.appendChild(host);

    let panel = null;
    try {
      panel = scr.create(host, a.ctx);
      if (panel && typeof panel.mount === 'function') panel.mount();
    } catch (err) {
      panel = null;
      reportError(a, `${scr.id} screen`, err);
    }
    a.screens.set(scr.id, { panel, host, failCount: 0, disabled: !panel });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SHELL CONSTRUCTION — the five FT-CLASSIC bands, built once
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Empty `#app` and build the shell: title strip 26 px, toolbar 40 px, alarm banner 24 px,
 * workspace, status strip 24 px — plus the out-of-flow skip link and perf overlay.
 * @param {object} a the application instance
 * @returns {void}
 */
function buildShell(a) {
  while (a.root.firstChild) a.root.removeChild(a.root.firstChild);

  const shell = h('div', { class: 'shell' });
  a.el.shell = shell;

  shell.appendChild(h('a', { class: 'skip-link', href: '#toolbar' }, 'Skip to the run controls'));
  shell.appendChild(buildTitleBar(a));
  shell.appendChild(buildToolbar(a));
  shell.appendChild(buildAlarmBar(a));

  const workspace = h('main', { class: 'workspace' });
  a.el.workspace = workspace;
  shell.appendChild(workspace);

  shell.appendChild(buildStatusStrip(a));

  const perf = h('div', { class: 'perf', role: 'status', 'aria-label': 'Performance' });
  perf.hidden = true;
  a.el.perf = perf;
  shell.appendChild(perf);

  a.root.appendChild(shell);

  // One host for the whole app. It is handed the mount root, because that is the subtree it marks
  // `inert` + `aria-hidden` while a modal is up; its own layer goes on <body>.
  a.overlayHost = overlay.createOverlayHost(a.root);

  // Publish it on ctx BEFORE mountScreens() runs. Every panel resolves its host as
  // `ctx.overlayHost || ctx.overlay || createOverlayHost(...)`, so without this line each panel
  // builds a host of its own — competing Esc handlers and focus traps over one modal stack.
  a.ctx.overlayHost = a.overlayHost;
}

/**
 * Band 1 — the 26 px title strip: unit name (the honesty note is behind it), the block counter, the
 * sim clock with the method-progress bar, and the alarm-summary lamps.
 * @param {object} a the application instance
 * @returns {Element} the title strip
 */
function buildTitleBar(a) {
  const bar = h('header', { class: 'titlebar' });

  const brand = h('div', { class: 'titlebar__brand' });
  const unit = button('titlebar__name', '', (e) => {
    overlay.showPopover(a.overlayHost, {
      anchorEl: /** @type {Element} */ (e.currentTarget),
      content: honestyContent(a),
      placement: 'bottom',
      maxWidth: 360,
    });
  }, {
    style: BARE_BUTTON,
    title: 'SIMULATED — what this model does, and what it deliberately does not',
    'aria-label': 'This is a simulation. Press for what the model does and does not do.',
  });
  a.el.unitName = unit;
  brand.appendChild(unit);
  a.el.blkBox = labelBox({ tag: 'BLK', gloss: 'block.type', title: 'Method block', narrow: true });
  brand.appendChild(a.el.blkBox.el);
  bar.appendChild(brand);

  bar.appendChild(h('span', { class: 'titlebar__spacer' }));

  const meta = h('div', { class: 'titlebar__meta' });
  a.el.clkBox = labelBox({ tag: 'CLK', gloss: 'run-state', title: 'Simulated run clock' });
  meta.appendChild(a.el.clkBox.el);
  const track = h('div', {
    class: 'progress', role: 'progressbar',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
    'aria-label': 'Method progress',
  });
  const fill = h('span', { class: 'progress__fill' });
  track.appendChild(fill);
  a.el.progressTrack = track;
  a.el.progressFill = fill;
  meta.appendChild(track);
  bar.appendChild(meta);

  bar.appendChild(h('span', { class: 'titlebar__spacer' }));

  const actions = h('div', { class: 'titlebar__actions' });
  a.el.lampCrit = lamp('Critical alarms: none');
  a.el.lampAlarm = lamp('Alarms: none');
  a.el.lampWarn = lamp('Warnings: none');
  actions.appendChild(a.el.lampCrit);
  actions.appendChild(a.el.lampAlarm);
  actions.appendChild(a.el.lampWarn);
  a.el.almBox = labelBox({ tag: 'ALM', gloss: 'alarm-state', title: 'Active alarms', narrow: true });
  actions.appendChild(a.el.almBox.el);
  bar.appendChild(actions);

  return bar;
}

/**
 * Band 2 — the 40 px icon toolbar. Five groups split by 2 px grooves: transport, emergency stop,
 * simulation speed, screen navigation, system. Every control is icon-only.
 * @param {object} a the application instance
 * @returns {Element} the toolbar
 */
function buildToolbar(a) {
  const bar = h('div', {
    class: 'toolbar', id: 'toolbar', role: 'toolbar', 'aria-label': 'Run controls', tabindex: '-1',
  });

  /* -- 1. transport ------------------------------------------------------------------------- */
  const g1 = h('div', { class: 'toolbar__group', 'data-tour': 'run-controls' });
  a.el.runBtn = iconButton({ icon: 'run', label: 'Start the run', onClick: () => doStartOrContinue(a) });
  a.el.holdBtn = iconButton({ icon: 'hold', label: 'Hold', onClick: () => act(a, () => sim.hold(a.ctx)) });
  a.el.contBtn = iconButton({
    icon: 'continue', label: 'Continue', onClick: () => act(a, () => sim.resume(a.ctx)),
  });
  a.el.skipBtn = buildSkipButton(a);
  a.el.stopBtn = iconButton({
    icon: 'stop', label: 'End the run',
    onClick: (e) => openEndPopover(a, /** @type {Element} */ (e.currentTarget)),
  });
  fmt.setAttr(a.el.stopBtn, 'aria-haspopup', 'dialog');
  a.el.resetBtn = iconButton({
    icon: 'reset', label: 'Reset', onClick: () => act(a, () => sim.reset(a.ctx)),
  });
  for (const b of [a.el.runBtn, a.el.holdBtn, a.el.contBtn, a.el.skipBtn, a.el.stopBtn, a.el.resetBtn]) {
    g1.appendChild(b);
  }
  bar.appendChild(g1);
  bar.appendChild(toolbarSep());

  /* -- 2. emergency stop, alone behind its own groove ---------------------------------------- */
  const g2 = h('div', { class: 'toolbar__group toolbar__group--estop' });
  a.el.estopBtn = iconButton({
    icon: 'estop', label: 'Emergency stop', cls: 'btn--estop', danger: true,
    title: 'Emergency stop — acts immediately, no undo (Shift+Esc twice within 1 s)',
    onClick: () => act(a, () => sim.estop(a.ctx)),
  });
  g2.appendChild(a.el.estopBtn);
  bar.appendChild(g2);
  bar.appendChild(toolbarSep());

  /* -- 3. simulation speed -------------------------------------------------------------------- */
  const g3 = h('div', { class: 'toolbar__group', 'data-tour': 'speed' });
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Simulation speed' });
  a.el.speedSeg = seg;
  a.el.speedChips = [];
  buildSpeedChips(a);
  g3.appendChild(seg);
  a.el.pauseBtn = iconButton({
    icon: 'pause', label: 'Pause the simulation', pressed: false, onClick: () => togglePause(a),
  });
  g3.appendChild(a.el.pauseBtn);
  a.el.speedLamp = lamp('Speed limited: no');
  g3.appendChild(a.el.speedLamp);
  a.el.spdBox = labelBox({ tag: 'SPD', eu: '×', title: 'Achieved simulation speed', narrow: true });
  g3.appendChild(a.el.spdBox.el);
  bar.appendChild(g3);
  bar.appendChild(toolbarSep());

  /* -- 4. screen navigation ------------------------------------------------------------------- */
  const g4 = h('div', { class: 'toolbar__group' });
  a.el.navBtns = new Map();
  for (const nav of NAV) {
    const btn = iconButton({
      icon: nav.icon, label: nav.label, title: `${nav.label} (${nav.key})`, pressed: false,
      onClick: () => selectNav(a, nav.id),
    });
    if (nav.id === 'method') fmt.setAttr(btn, 'data-tour', 'tab-method');
    a.el.navBtns.set(nav.id, btn);
    g4.appendChild(btn);
  }
  bar.appendChild(g4);
  bar.appendChild(h('span', { class: 'toolbar__spacer' }));

  /* -- 5. system ------------------------------------------------------------------------------ */
  const g5 = h('div', { class: 'toolbar__group' });
  a.el.ackBtn = iconButton({
    icon: 'ack', label: 'Acknowledge the highest alarm', onClick: () => ackTopAlarm(a),
  });
  a.el.manualBtn = iconButton({
    icon: 'wrench', label: 'Manual control', pressed: false, onClick: () => toggleManual(a),
    title: 'METHOD: the engine drives the skid. MANUAL: you do — in IDLE, READY, HELD and PAUSED.',
  });
  const scenBtn = iconButton({
    icon: 'flask', label: 'Teaching scenarios',
    title: 'Load one of the teaching scenarios — each starts in one click',
    onClick: () => showScenarios(a),
  });
  const helpBtn = iconButton({
    icon: 'help', label: 'Help, glossary and keyboard shortcuts',
    title: 'Help, the glossary and the shortcut list (?)',
    onClick: () => showHelp(a),
  });
  a.el.themeBtn = iconButton({
    icon: 'theme', label: 'Toggle the light and dark theme', pressed: false,
    onClick: () => toggleTheme(a),
  });
  for (const b of [a.el.ackBtn, a.el.manualBtn, scenBtn, helpBtn, a.el.themeBtn]) g5.appendChild(b);
  bar.appendChild(g5);

  return bar;
}

/**
 * (Re)build the speed chips from `config.sim.speedOptions`, which a different preset may change.
 * These are the one place a numeral is allowed on the face of a control.
 * @param {object} a the application instance
 * @returns {void}
 */
function buildSpeedChips(a) {
  const seg = a.el.speedSeg;
  while (seg.firstChild) seg.removeChild(seg.firstChild);
  a.el.speedChips = [];
  for (const s of a.ctx.config.sim.speedOptions) {
    const chip = button('speedchip', `${s}×`, () => act(a, () => sim.setSpeed(a.ctx, s)), {
      role: 'radio',
      'aria-checked': 'false',
      'aria-label': `Simulation speed ${s} times real time`,
      title: `Run the simulation at ${s}× real time`,
    });
    chip.dataset.speed = String(s);
    a.el.speedChips.push(chip);
    seg.appendChild(chip);
  }
}

/**
 * The Skip Block control: a 400 ms press-and-hold with a filling ring drawn over the glyph, so a
 * fat-fingered click cannot throw away the rest of a block. The ring is advanced by the shell's own
 * frame pass — no panel starts a second rAF loop.
 * @param {object} a the application instance
 * @returns {HTMLButtonElement} the skip button
 */
function buildSkipButton(a) {
  const btn = iconButton({
    icon: 'skip', label: 'Skip the current block', cls: 'btn--hold-to-act',
    title: 'Skip the current block — press and hold for 400 ms (N)',
  });

  const circumference = 2 * Math.PI * RING_R;
  const arc = fmt.hSvg('circle', {
    class: 'holdring__fill', cx: '12', cy: '12', r: String(RING_R), fill: 'none',
    transform: 'rotate(-90 12 12)',
    'stroke-dasharray': String(circumference),
    'stroke-dashoffset': String(circumference),
  });
  btn.appendChild(fmt.hSvg('svg', {
    class: 'holdring', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
  },
  fmt.hSvg('circle', { class: 'holdring__track', cx: '12', cy: '12', r: String(RING_R), fill: 'none' }),
  arc));
  a.el.skipArc = arc;
  a.el.skipArcLength = circumference;

  const start = (ev) => {
    if (btn.disabled) return;
    ev.preventDefault();
    a.skipHold.active = true;
    a.skipHold.start_ms = performance.now();
    if (btn.setPointerCapture && ev.pointerId !== undefined) {
      try { btn.setPointerCapture(ev.pointerId); } catch (_e) { /* not capturable */ }
    }
  };
  const cancel = () => {
    if (!a.skipHold.active) return;
    a.skipHold.active = false;
    fmt.setAttr(a.el.skipArc, 'stroke-dashoffset', String(a.el.skipArcLength));
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointerleave', cancel);
  // Keyboard path: a held key has no reliable "still held" signal across layouts, so the keyboard
  // gets the same confirm dialog the `N` shortcut opens. Neither path is a single unguarded click.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmSkip(a); }
  });
  return btn;
}

/**
 * Band 3 — the 24 px alarm banner and the two screen-reader live regions.
 *
 * One row serves two jobs. An active alarm owns it; when there is none, a caught shell error takes
 * the same slots, so a failure is always visible without a sixth band ever existing.
 *
 * @param {object} a the application instance
 * @returns {Element} the alarm band
 */
function buildAlarmBar(a) {
  const bar = h('div', { class: 'alarmbar', role: 'region', 'aria-label': 'Alarms' });
  bar.hidden = true;

  a.el.alarmAssertive = h('div', {
    class: 'sr-only', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true',
  });
  a.el.alarmPolite = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  bar.appendChild(a.el.alarmAssertive);
  bar.appendChild(a.el.alarmPolite);

  a.el.alarmLamp = lamp('Alarm');
  a.el.alarmSev = h('span', { class: 'banner__sev' }, '');
  a.el.alarmTag = h('span', { class: 'alarmbar__tag' }, '');
  a.el.alarmCode = h('span', { class: 'alarmbar__code' }, '');
  a.el.alarmCond = h('span', { class: 'banner__detail' }, '');
  bar.appendChild(a.el.alarmLamp);
  bar.appendChild(a.el.alarmSev);
  bar.appendChild(a.el.alarmTag);
  bar.appendChild(a.el.alarmCode);
  bar.appendChild(a.el.alarmCond);

  const actions = h('div', { class: 'banner__actions' });
  a.el.alarmCount = h('span', { class: 'banner__count' }, '');
  a.el.alarmCount.hidden = true;
  actions.appendChild(a.el.alarmCount);

  a.el.alarmAckBtn = iconButton({
    icon: 'ack', label: 'Acknowledge this alarm', sm: true, onClick: () => ackTopAlarm(a),
  });
  a.el.alarmSilenceBtn = iconButton({
    icon: 'cross', label: 'Silence this banner', sm: true,
    title: 'Hide this banner for the session. The alarm stays active and stays logged.',
    onClick: () => silenceTopAlarm(a),
  });
  a.el.alarmMoreBtn = iconButton({
    icon: 'warn', label: 'Open the alarm table', sm: true,
    title: 'Open the configuration screen and its alarm table',
    onClick: () => selectNav(a, 'config'),
  });
  a.el.errCopyBtn = iconButton({
    icon: 'copy', label: 'Copy the error detail', sm: true, onClick: () => copyShellError(a),
  });
  a.el.errClearBtn = iconButton({
    icon: 'cross', label: 'Dismiss this error', sm: true, onClick: () => clearShellError(a),
  });
  for (const b of [a.el.alarmAckBtn, a.el.alarmSilenceBtn, a.el.alarmMoreBtn,
    a.el.errCopyBtn, a.el.errClearBtn]) {
    b.hidden = true;
    actions.appendChild(b);
  }
  bar.appendChild(actions);

  a.el.alarmBar = bar;
  return bar;
}

/**
 * Band 5 — the 24 px status strip: the eight sunken label boxes, then the run-state lamp with its
 * STATE box and the data-quality lamp with its QUAL box. This is the redundant copy of process
 * state that survives a screen change.
 * @param {object} a the application instance
 * @returns {Element} the status strip
 */
function buildStatusStrip(a) {
  const strip = h('footer', {
    class: 'statusstrip', 'aria-label': 'Live process values', 'data-tour': 'status',
  });
  a.el.fields = {};
  for (const spec of STATUS_FIELDS) {
    const entry = glossaryFor(spec.gloss);
    const rec = labelBox({
      tag: spec.tag,
      eu: fmt.unitLabel(spec.kind),
      gloss: spec.gloss,
      title: `${spec.isa ? `${spec.isa} · ` : ''}${entry ? entry.term : spec.tag}`,
    });
    a.el.fields[spec.key] = rec;
    strip.appendChild(rec.el);
  }

  strip.appendChild(h('span', { class: 'statusstrip__spacer' }));

  a.el.stateLamp = lamp('Run state: IDLE');
  strip.appendChild(a.el.stateLamp);
  a.el.stateBox = labelBox({ tag: 'STATE', gloss: 'run-state', title: 'Run state', wide: true });
  strip.appendChild(a.el.stateBox.el);

  a.el.qualLamp = lamp('Data quality: OK');
  strip.appendChild(a.el.qualLamp);
  a.el.qualBox = labelBox({
    tag: 'QUAL', narrow: true, title: 'Data quality — press for the per-sensor verdicts',
    onClick: () => showQualityPopover(a, a.el.qualBox.el),
  });
  strip.appendChild(a.el.qualBox.el);

  return strip;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ACTIONS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Run a `core/sim.js` action and surface its refusal. Every action returns `{ ok, reason? }`, and a
 * refusal is ALWAYS shown: a silent refusal teaches nothing and gets worked around.
 * @param {object} a the application instance
 * @param {function():{ok:boolean, reason?:string}} fn the action thunk
 * @returns {{ok:boolean, reason?:string}} the action's own result
 */
function act(a, fn) {
  let r;
  try {
    r = fn();
  } catch (err) {
    reportError(a, 'action', err);
    return { ok: false, reason: errText(err) };
  }
  a.structural = true;
  if (!r || typeof r !== 'object') return { ok: true };
  if (!overlay.reportResult(a.overlayHost, r, 'The skid refused that action.')) return r;
  if (r.reason) toast(a, r.reason, 'warn');       // ok:true WITH a reason = partial success
  return r;
}

/**
 * Show a transient message through the overlay host.
 * @param {object} a the application instance
 * @param {string} message the text
 * @param {'info'|'warn'|'blocked'} kind severity of the toast
 * @returns {void}
 */
function toast(a, message, kind) {
  try {
    overlay.showToast(a.overlayHost, { message, kind: kind || 'info' });
  } catch (err) {
    console.warn('toast failed:', message, err);
  }
}

/**
 * Start, or continue from HELD/PAUSED. A pre-run-check refusal opens the full failure list rather
 * than a one-line toast, because all the checks report at once.
 * @param {object} a the application instance
 * @returns {void}
 */
function doStartOrContinue(a) {
  const st = a.ctx.run.state;
  if (st === 'HELD' || st === 'PAUSED') { act(a, () => sim.resume(a.ctx)); return; }
  if (st === 'IDLE') {
    const v = sim.validateAndReady(a.ctx);
    if (!v.ok) { showPreRunFailures(a, v.failures); return; }
  }
  act(a, () => sim.start(a.ctx));
}

/**
 * Render the pre-run check failures as a modal list, blocking failures first. A failure surface, so
 * it is allowed to use words.
 * @param {object} a the application instance
 * @param {Array<{code:string, message:string, acknowledgeable:boolean}>} failures the failures
 * @returns {void}
 */
function showPreRunFailures(a, failures) {
  const blocking = failures.filter((f) => !f.acknowledgeable);
  const advisory = failures.filter((f) => f.acknowledgeable);
  const body = h('div', {},
    h('p', {}, blocking.length > 0
      ? 'The run cannot start until these are fixed:'
      : 'Only advisory checks failed. You may acknowledge them and start anyway.'));
  const ul = h('ul', {});
  for (const f of blocking.concat(advisory)) {
    ul.appendChild(h('li', {}, `${f.code} — ${f.message}${f.acknowledgeable ? ' (advisory)' : ''}`));
  }
  body.appendChild(ul);

  // `showModal` closes nothing by itself: every handler is handed the handle and dismisses it.
  const actions = [{ label: 'Close', variant: 'ghost', onClick: (hd) => overlay.dismiss(hd) }];
  if (blocking.length === 0) {
    actions.unshift({
      label: 'Acknowledge and start',
      variant: 'primary',
      onClick: (hd) => { overlay.dismiss(hd); act(a, () => sim.start(a.ctx)); },
    });
  }
  overlay.showModal(a.overlayHost, {
    title: 'Pre-run checks', content: body, actions, dismissible: true,
  });
}

/**
 * The End confirm popover: end after the current block, or end now. Two icon buttons — the words
 * are in their tooltips.
 * @param {object} a the application instance
 * @param {Element} anchorEl the stop button
 * @returns {void}
 */
function openEndPopover(a, anchorEl) {
  let handle = null;
  const after = iconButton({
    icon: 'clock', label: 'End after the current block',
    title: 'End after the current block — the block finishes and is logged normally',
    onClick: () => { overlay.dismiss(handle); act(a, () => sim.end(a.ctx, 'AFTER_BLOCK')); },
  });
  const now = iconButton({
    icon: 'stop', label: 'End now', danger: true,
    title: 'End now — the current block is cut short at this volume',
    onClick: () => { overlay.dismiss(handle); act(a, () => sim.end(a.ctx, 'NOW')); },
  });
  handle = overlay.showPopover(a.overlayHost, {
    anchorEl, content: h('div', { class: 'btn-row' }, after, now), placement: 'bottom', maxWidth: 200,
  });
}

/**
 * The keyboard path to Skip Block: a confirm dialog where `Enter` confirms.
 * @param {object} a the application instance
 * @returns {void}
 */
function confirmSkip(a) {
  const run = a.ctx.run;
  if (run.state !== 'RUNNING' && run.state !== 'HELD') {
    toast(a, `Blocked: a block can only be skipped while RUNNING or HELD (state is ${run.state}).`, 'blocked');
    return;
  }
  const blocks = a.ctx.config.method ? a.ctx.config.method.blocks : null;
  const b = blocks && blocks[run.blockIndex];
  const body = h('div', {},
    h('p', {}, `Skip ${b ? `${b.id} · ${b.name}` : `block ${run.blockIndex + 1}`} and move on?`),
    h('p', {}, 'The block boundary is flushed and logged exactly as a normal block end is.'));

  let handle = null;
  let settled = false;                 // Enter reaches both the capture listener and the button
  const confirm = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.dismiss(handle);
    act(a, () => sim.skipBlock(a.ctx));
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.dismiss(handle);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    else if (e.key === 'Escape') cancel();
  };

  handle = overlay.showModal(a.overlayHost, {
    title: 'Skip block',
    content: body,
    actions: [
      { label: 'Skip block (Enter)', variant: 'primary', onClick: confirm },
      { label: 'Cancel', variant: 'ghost', onClick: cancel },
    ],
    dismissible: true,
    onDismiss: cancel,          // the X, the dim and Esc all land here, so the listener never leaks
  });
  document.addEventListener('keydown', onKey, true);
}

/**
 * Pause / resume the process. `Pause` ramps flow to zero; resuming returns to RUNNING.
 * @param {object} a the application instance
 * @returns {void}
 */
function togglePause(a) {
  const st = a.ctx.run.state;
  if (st === 'PAUSED' || st === 'HELD') act(a, () => sim.resume(a.ctx));
  else act(a, () => sim.pause(a.ctx));
}

/**
 * Toggle manual control. Interlocks and the legal-state rule live in `sim`; a refusal is explained
 * by the toast.
 * @param {object} a the application instance
 * @returns {void}
 */
function toggleManual(a) {
  act(a, () => sim.setManualOverride(a.ctx, !a.ctx.run.manualOverride));
}

/**
 * Acknowledge the highest-ranked alarm that is waiting for it.
 * @param {object} a the application instance
 * @returns {void}
 */
function ackTopAlarm(a) {
  const def = a.alarm.ackable;
  if (!def) return;
  act(a, () => sim.acknowledgeAlarm(a.ctx, def.id));
  a.alarmSig = null;
}

/**
 * Hide the top banner for the session. The alarm stays active and stays logged — silencing changes
 * the screen, never the skid.
 * @param {object} a the application instance
 * @returns {void}
 */
function silenceTopAlarm(a) {
  const def = a.alarm.active[0];
  if (!def) return;
  a.silenced.add(def.id);
  a.alarmSig = null;
  toast(a, `${def.id} hidden from the banner. It is still active and still in the event log.`, 'info');
}

/**
 * Step the simulation speed one rung along `config.sim.speedOptions`.
 * @param {object} a the application instance
 * @param {number} dir `+1` for faster, `-1` for slower
 * @returns {void}
 */
function stepSpeed(a, dir) {
  const opts = a.ctx.config.sim.speedOptions;
  const i = opts.indexOf(a.ctx.run.speed);
  const j = Math.max(0, Math.min(opts.length - 1, (i < 0 ? 0 : i) + dir));
  act(a, () => sim.setSpeed(a.ctx, opts[j]));
}

/**
 * Export the loaded method as JSON (`Ctrl+S`). The run's data exports live on the Results screen,
 * which owns the analytics they carry; the method is shell-scoped because it is editable on the
 * Method screen and worth saving from anywhere.
 * @param {object} a the application instance
 * @returns {void}
 */
function exportMethod(a) {
  try {
    const payload = exportMethodJSON(a.ctx.config);
    downloadText(`${a.ctx.config.presetId}_method.json`, JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8');
  } catch (err) {
    toast(a, `Export failed: ${errText(err)}`, 'blocked');
  }
}

/**
 * Open a file picker and install the chosen method JSON through `sim.loadMethod` (`Ctrl+O`).
 * The shell owns this shortcut rather than the Method screen so it works from anywhere.
 * @param {object} a the application instance
 * @returns {void}
 */
function importMethodFile(a) {
  if (!a.fileInput) {
    const input = /** @type {HTMLInputElement} */ (h('input', {
      type: 'file', accept: '.json,application/json', class: 'sr-only',
    }));
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onerror = () => toast(a, 'Could not read that file.', 'blocked');
      reader.onload = () => {
        let parsed = null;
        try {
          parsed = JSON.parse(String(reader.result));
        } catch (err) {
          toast(a, `Not valid JSON: ${errText(err)}`, 'blocked');
          return;
        }
        const res = importMethodJSON(a.ctx.config, parsed);
        if (!res.ok) { toast(a, `Method rejected: ${res.errors.join('; ')}`, 'blocked'); return; }
        const loaded = act(a, () => sim.loadMethod(a.ctx, res.method));
        if (loaded.ok) toast(a, `Method loaded: ${a.ctx.config.method.name || file.name}`, 'info');
      };
      reader.readAsText(file);
      input.value = '';
    });
    a.el.shell.appendChild(input);
    a.fileInput = input;
  }
  a.fileInput.click();
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SCREENS, THEME, HELP
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Act on one of the five navigation buttons. `P&ID` and `TREND` both select the main screen, where
 * the schematic and the trend are co-visible, and publish which pane the operator asked for so the
 * screen can favour it; neither ever hides the other.
 * @param {object} a the application instance
 * @param {string} navId a {@link NAV} id
 * @returns {void}
 */
function selectNav(a, navId) {
  const nav = NAV.find((n) => n.id === navId);
  if (!nav) return;
  a.activeNav = navId;
  setScreen(a, nav.screen);
  if (nav.pane) a.ctx.bus.emit('request-pane', nav.pane);
  refreshNav(a);
}

/**
 * Show one screen. Only the visible screen's `update()` runs, so a hidden one costs nothing.
 * @param {object} a the application instance
 * @param {string} screenId one of the {@link SCREENS} ids
 * @returns {void}
 */
function setScreen(a, screenId) {
  if (!a.screens.has(screenId) || a.activeScreen === screenId) return;
  // The popover is anchored to an element on the screen we are leaving; hiding that host would
  // strand it over the new screen, pointing at nothing.
  closeGlossary(a);
  a.activeScreen = screenId;
  for (const [id, entry] of a.screens) entry.host.hidden = id !== screenId;
  // A newly revealed screen has missed every frame since it was hidden: give it a structural pass.
  a.structural = true;
  a.ctx.bus.emit('screen-changed', screenId);
  a.ctx.bus.emit('tab-changed', screenId);
}

/**
 * Mark the navigation button that is currently showing.
 * @param {object} a the application instance
 * @returns {void}
 */
function refreshNav(a) {
  for (const nav of NAV) {
    const btn = a.el.navBtns.get(nav.id);
    if (!btn) continue;
    const on = nav.screen === a.activeScreen && (!nav.pane || a.activeNav === nav.id);
    fmt.cls(btn, 'is-active', on);
    fmt.setAttr(btn, 'aria-pressed', on ? 'true' : 'false');
  }
}

/**
 * Flip between the classic grey and the dark panel, and tell every canvas painter to re-read its
 * tokens. `index.html` stamps an explicit `data-theme` before first paint, so there is no third
 * state to carry here; reading CSS custom properties per frame is a layout-thrash trap.
 * @param {object} a the application instance
 * @returns {void}
 */
function toggleTheme(a) {
  applyTheme(a, a.theme === 'dark' ? 'light' : 'dark', true);
}

/**
 * Apply a theme to the document root and announce it.
 * @param {object} a the application instance
 * @param {'dark'|'light'} theme the chosen theme
 * @param {boolean} announce true to emit `theme-changed` on the bus
 * @returns {void}
 */
function applyTheme(a, theme, announce) {
  a.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', a.theme);
  if (a.el.themeBtn) {
    fmt.setAttr(a.el.themeBtn, 'aria-pressed', a.theme === 'dark' ? 'true' : 'false');
    fmt.setAttr(a.el.themeBtn, 'title',
      a.theme === 'dark' ? 'Dark panel — switch to the classic grey' : 'Classic grey — switch to dark');
    fmt.cls(a.el.themeBtn, 'is-active', a.theme === 'dark');
  }
  try {
    fmt.invalidateThemeTokens();
  } catch (_err) { /* the token cache is an optimisation; failing to clear it is not fatal */ }
  if (announce) a.ctx.bus.emit('theme-changed', a.theme);
}

/**
 * Open the glossary popover for a tag or parameter id. A missing entry renders NO info affordance —
 * `glossaryFor` returning null is a contract, not an error.
 * @param {object} a the application instance
 * @param {Element} anchorEl the element the popover points at
 * @param {string} id a P&ID tag, config path, concept id or alias
 * @returns {void}
 */
function showGlossary(a, anchorEl, id) {
  const entry = glossaryFor(id);
  if (!entry) return;
  // ONE glossary popover at a time. The handle used to be discarded, so every tag you touched left
  // its popover pinned to the screen — observed live as a 213 px paragraph stranded over the trend.
  // On an HMI whose whole premise is "almost no text", a leaked block of prose is a real defect.
  closeGlossary(a);
  a.glossaryHandle = overlay.showGlossaryPopover(a.overlayHost, {
    anchorEl,
    entry,
    placement: 'top',
    onSeeAlso: (nextId) => showGlossary(a, anchorEl, nextId),
    onDismiss: () => { a.glossaryHandle = null; },
  });
}

/**
 * Dismiss the open glossary popover, if any. Idempotent, and safe to call when the overlay layer
 * has already torn the popover down on its own (Esc, outside click, host destroy).
 * @param {object} a the application instance
 * @returns {void}
 */
function closeGlossary(a) {
  if (!a.glossaryHandle) return;
  const handle = a.glossaryHandle;
  a.glossaryHandle = null;
  try { overlay.dismiss(handle); } catch (_err) { /* already gone; nothing to do */ }
}

/**
 * The QUAL box's popover: every `run.qualityFlags` bit currently set, and the per-sensor verdict
 * behind them.
 * @param {object} a the application instance
 * @param {Element} anchorEl the box
 * @returns {void}
 */
function showQualityPopover(a, anchorEl) {
  const run = a.ctx.run;
  const body = h('div', { class: 'glossary' }, h('strong', {}, 'Data quality'));
  const ul = h('ul', {});
  for (const sensor of ['UV', 'COND', 'PH', 'PRESS']) {
    ul.appendChild(h('li', {}, `${sensor}: ${sensorQuality(run, sensor)}`));
  }
  body.appendChild(ul);

  const set = QF_LABELS.filter(([bit]) => (run.qualityFlags & bit) !== 0);
  if (set.length === 0) {
    body.appendChild(h('p', {}, 'No quality flags are set: every sensor is reporting normally.'));
  } else {
    const flags = h('ul', {});
    for (const [, label] of set) flags.appendChild(h('li', {}, label));
    body.appendChild(flags);
  }
  const g = glossaryFor('quality-flags');
  if (g) body.appendChild(h('p', { class: 'glossary__typical' }, g.why));
  overlay.showPopover(a.overlayHost, { anchorEl, content: body, placement: 'top', maxWidth: 340 });
}

/**
 * The unit name's popover: what the model does, and what it deliberately does not.
 * @param {object} a the application instance
 * @returns {Element} the popover body
 */
function honestyContent(a) {
  const cfg = a.ctx.config;
  return h('div', { class: 'glossary' },
    h('strong', {}, 'This is a simulation, not an instrument'),
    h('p', {}, 'A one-dimensional packed bed with axial dispersion, film and pore mass transfer and '
      + `a ${cfg.column.isothermMode} isotherm. The sensors carry real noise, drift, filtering and `
      + 'delay volumes, so they lie in the ways real sensors lie.'),
    h('p', {}, 'Deliberately absent: radial gradients, per-cell protein charge, replay and '
      + 'scrubbing, and any network or cloud component. The numbers are physically consistent; they '
      + 'are not a substitute for a qualified run.'),
    h('p', { class: 'glossary__typical' },
      `${cfg.presetId} · ${cfg.scale} · seed ${cfg.seed} · grid nz=${cfg.column.nz}`
      + `${a.benchmark ? ` · ${a.benchmark.msPerSimSecond.toFixed(2)} ms per simulated second` : ''}`));
}

/**
 * Open the teaching-scenario picker.
 * @param {object} a the application instance
 * @returns {void}
 */
function showScenarios(a) {
  if (a.onboarding) { onboarding.showScenarioPicker(a.onboarding); return; }

  const rows = presets.SCENARIOS || {};
  const ids = Object.keys(rows);
  const list = h('div', { class: 'btn-row' });
  let handle = null;
  for (const id of ids) {
    const s = rows[id];
    list.appendChild(button('btn btn--ghost btn--sm', (s && s.name) || id, () => {
      overlay.dismiss(handle);
      act(a, () => sim.loadScenario(a.ctx, id));
    }, { title: (s && s.teaches) || id }));
  }
  handle = overlay.showModal(a.overlayHost, {
    title: 'Teaching scenarios',
    content: ids.length ? list : h('p', {}, 'This preset library declares no scenarios.'),
    dismissible: true,
    actions: [{ label: 'Close', variant: 'primary', onClick: (hd) => overlay.dismiss(hd) }],
  });
}

/**
 * The Help modal: the ways into the app, and a searchable index of the whole glossary.
 * Every word of definition comes from `data/glossary.js`; this function contributes the search box
 * and the layout only.
 * @param {object} a the application instance
 * @returns {void}
 */
function showHelp(a) {
  const ids = Object.keys(GLOSSARY);
  const list = h('div', { class: 'btn-row' });
  const detail = h('div', { class: 'glossary' });

  const showEntry = (id) => {
    const entry = GLOSSARY[id];
    while (detail.firstChild) detail.removeChild(detail.firstChild);
    if (!entry) return;
    detail.appendChild(h('strong', {}, entry.term));
    detail.appendChild(h('p', {}, entry.short));
    detail.appendChild(h('p', {}, entry.why));
    detail.appendChild(h('p', { class: 'glossary__typical' }, entry.typical));
  };

  const render = (needle) => {
    const q = needle.trim().toLowerCase();
    const hits = [];
    for (const id of ids) {
      const e = GLOSSARY[id];
      if (q === '' || id.toLowerCase().indexOf(q) >= 0
        || e.term.toLowerCase().indexOf(q) >= 0 || e.short.toLowerCase().indexOf(q) >= 0) {
        hits.push(id);
      }
      if (hits.length >= 30) break;
    }
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const id of hits) {
      list.appendChild(button('btn btn--ghost btn--sm', GLOSSARY[id].term, () => showEntry(id)));
    }
    if (hits.length === 0) list.appendChild(h('p', { class: 'field__hint' }, 'No matches.'));
  };

  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text', class: 'numfield__input', placeholder: 'Search the glossary…',
    'aria-label': 'Search the glossary',
  }));
  search.addEventListener('input', () => render(search.value));

  const body = h('div', {},
    h('p', {}, `${ids.length} entries cover every instrument tag, every configurable parameter and `
      + 'every concept the simulator models. The same text is behind every label box on screen.'),
    h('div', { class: 'numfield' }, search),
    list,
    detail);
  render('');

  const actions = [];
  if (a.onboarding) {
    actions.push({
      label: 'Take the tour',
      variant: 'ghost',
      onClick: (hd) => { overlay.dismiss(hd); onboarding.startTour(a.onboarding); },
    });
  }
  actions.push({
    label: 'Keyboard shortcuts',
    variant: 'ghost',
    onClick: (hd) => { overlay.dismiss(hd); overlay.showCheatSheet(a.overlayHost, KEYMAP); },
  });
  if (a.onboarding) {
    actions.push({
      label: hintsOn(a) ? 'Turn coach hints off' : 'Turn coach hints on',
      variant: 'ghost',
      onClick: (hd) => {
        overlay.dismiss(hd);
        if (!a.onboarding) return;
        a.onboarding.hintsEnabled = !a.onboarding.hintsEnabled;
        toast(a, a.onboarding.hintsEnabled
          ? 'Coach hints on — at most one card every 20 seconds, never blocking.'
          : 'Coach hints off for this session.', 'info');
      },
    });
  }
  actions.push({ label: 'Close', variant: 'primary', onClick: (hd) => overlay.dismiss(hd) });

  overlay.showModal(a.overlayHost, {
    title: 'Help and glossary', content: body, dismissible: true, actions,
  });
}

/**
 * @param {object} a the application instance
 * @returns {boolean} whether the coach-hint scheduler is currently armed
 */
function hintsOn(a) {
  return !!(a.onboarding && a.onboarding.hintsEnabled);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * BUS, KEYBOARD, RESPONSIVE
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Subscribe the shell to the bus. Every derived value keyed on `config` is dropped on
 * `config-replaced`, and the startup benchmark is re-run on `preset-loaded`.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireBus(a) {
  const bus = a.ctx.bus;
  const invalidate = () => {
    a.demandCache = null;
    a.progressPct = -1;
    a.alarmSig = null;
    a.liveAlarmId = null;
    a.silenced.clear();
    a.lastEventCount = a.ctx.run.events ? a.ctx.run.events.length : 0;
    a.simFailed = false;
    a.structural = true;
    if (a.el.speedChips.length !== a.ctx.config.sim.speedOptions.length) buildSpeedChips(a);
  };
  bus.on('config-replaced', invalidate);
  bus.on('run-reset', invalidate);
  bus.on('preset-loaded', () => {
    invalidate();
    runStartupBenchmark(a);
    invalidate();
  });
  bus.on('scenario-applied', () => selectNav(a, 'pid'));
  bus.on('run-ended', () => { a.structural = true; });
  bus.on('request-tab', (tabId) => {
    const navId = LEGACY_NAV[String(tabId)];
    if (navId) selectNav(a, navId);
  });
  bus.on('show-glossary', (payload) => {
    if (payload && payload.anchorEl && payload.id) showGlossary(a, payload.anchorEl, payload.id);
  });
  bus.on('display-units-changed', () => {
    a.structural = true;
    for (const spec of STATUS_FIELDS) {
      const rec = a.el.fields[spec.key];
      if (rec) fmt.setText(rec.eu, fmt.unitLabel(spec.kind));
    }
  });
}

/**
 * Install the one document-level key handler. Shell actions execute here; panel actions go out on
 * the bus as `('key-action', { action, combo, event })`, so no second listener is ever needed.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireKeyboard(a) {
  document.addEventListener('keydown', (e) => {
    // A control that already consumed the key (a splitter's arrows, a numfield's stepper, an open
    // dialog) wins: the global registry never double-handles.
    if (e.defaultPrevented) return;
    const combo = normaliseCombo(e);
    const entry = KEYMAP[combo];
    if (!entry) return;
    if (typingInField() && combo !== 'Escape') return;
    if (handleKeyAction(a, entry.action, e, combo)) e.preventDefault();
  });
}

/**
 * Execute one keymap action.
 * @param {object} a the application instance
 * @param {string} action the action id from `KEYMAP`
 * @param {KeyboardEvent} e the originating event
 * @param {string} combo the normalised combo, forwarded to the panels
 * @returns {boolean} true when the event was consumed and should be prevented
 */
function handleKeyAction(a, action, e, combo) {
  const run = a.ctx.run;
  if (action.startsWith('nav:')) { selectNav(a, action.slice(4)); return true; }
  if (action.startsWith('speed:')) {
    const opts = a.ctx.config.sim.speedOptions;
    const i = Number(action.slice(6));
    if (i >= 0 && i < opts.length) act(a, () => sim.setSpeed(a.ctx, opts[i]));
    return true;
  }
  switch (action) {
    case 'start-hold-toggle':
      if (run.state === 'RUNNING') act(a, () => sim.hold(a.ctx));
      else doStartOrContinue(a);
      return true;
    case 'start-run': doStartOrContinue(a); return true;
    case 'hold': act(a, () => sim.hold(a.ctx)); return true;
    case 'continue': act(a, () => sim.resume(a.ctx)); return true;
    case 'skip-block': confirmSkip(a); return true;
    case 'end-run': openEndPopover(a, a.el.stopBtn); return true;
    case 'pause-toggle': togglePause(a); return true;
    case 'estop': {
      const now = performance.now();
      if (a.estopArm_ms > 0 && now - a.estopArm_ms < ESTOP_DOUBLE_MS) {
        a.estopArm_ms = 0;
        act(a, () => sim.estop(a.ctx));
      } else {
        a.estopArm_ms = now;
        toast(a, 'Press Shift+Esc again within 1 second to trigger the emergency stop.', 'warn');
      }
      return true;
    }
    case 'speed-up': stepSpeed(a, +1); return true;
    case 'speed-down': stepSpeed(a, -1); return true;
    case 'mark-fraction': act(a, () => sim.markFraction(a.ctx)); return true;
    case 'cheat-sheet': overlay.showCheatSheet(a.overlayHost, KEYMAP); return true;
    case 'export-method': exportMethod(a); return true;
    case 'import-method': importMethodFile(a); return true;
    case 'perf-overlay':
      a.perfOn = !a.perfOn;
      a.el.perf.hidden = !a.perfOn;
      a.perfRows = null;
      return true;
    case 'dismiss':
      a.ctx.bus.emit('key-action', { action, combo, event: e });
      return false;                     // the overlay host's own capture-phase Esc handling runs too
    default:
      // The trend, its pen rail and the pooling tools live in the panels; they own these.
      a.ctx.bus.emit('key-action', { action, combo, event: e });
      return true;
  }
}

/**
 * Flag a narrow viewport on the shell so `styles/app.css` can reflow the bands, without ever
 * reading layout in a frame.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireResponsive(a) {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(max-width: 899.98px)');
  const apply = () => fmt.cls(a.el.shell, 'is-narrow', mq.matches);
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply);
  apply();
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FRAME LOOP — the ONLY requestAnimationFrame in the program
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One animation frame: advance the physics by the real elapsed time, then render the visible screen.
 *
 * Rendering is decoupled from the fixed-timestep sim: `sim.advanceWall` runs whole 0.05 s ticks and
 * drops any debt it cannot pay, reporting the shortfall through `run.speedDeficit`. Both halves are
 * guarded — a throwing panel is reported and, after three consecutive failures, taken out of the
 * loop, but the loop itself never stops.
 *
 * `document.hidden` pauses RENDERING only; the simulation keeps running, and the 0.25 s wall clamp
 * inside `advanceWall` stops a backgrounded tab from fast-forwarding.
 *
 * @param {number} now_ms the `requestAnimationFrame` timestamp, milliseconds
 * @returns {void}
 */
export function frame(now_ms) {
  const a = app;
  if (!a) return;
  a.rafId = requestAnimationFrame(frame);

  const dt_ms = a.tPrev === 0 ? 16.7 : Math.max(0, now_ms - a.tPrev);
  a.tPrev = now_ms;
  const wallDt_s = Math.min(dt_ms / 1000, WALL_CLAMP_S);

  // ---- physics -------------------------------------------------------------------------------
  let ticks = 0;
  const tSim0 = performance.now();
  if (!a.simFailed) {
    try {
      ticks = sim.advanceWall(a.ctx, wallDt_s);
    } catch (err) {
      a.simFailed = true;
      reportError(a, 'simulation', err);
    }
  }
  const tSim1 = performance.now();

  // ---- events: one central drain feeds onboarding and the structural flag ---------------------
  drainEvents(a);

  // ---- render --------------------------------------------------------------------------------
  const info = a.frameInfo;
  info.now_ms = now_ms;
  info.dt_ms = dt_ms;
  info.tick = a.ctx.run.tick;
  info.structural = a.structural;

  const tR0 = performance.now();
  if (document.visibilityState !== 'hidden') {
    try {
      refreshShell(a, info.structural);
    } catch (err) {
      reportError(a, 'shell', err);
    }
    const entry = a.screens.get(a.activeScreen);
    if (entry && entry.panel && !entry.disabled) {
      try {
        entry.panel.update(info);
        entry.failCount = 0;
      } catch (err) {
        entry.failCount++;
        reportError(a, `${a.activeScreen} screen`, err);
        if (entry.failCount >= PANEL_FAIL_LIMIT) {
          entry.disabled = true;
          toast(a, `The ${a.activeScreen} screen was disabled after ${PANEL_FAIL_LIMIT} errors. `
            + 'Switch screens and back to retry.', 'blocked');
        }
      }
    }
    if (a.onboarding && typeof a.onboarding.update === 'function') {
      try {
        a.onboarding.update(info);
      } catch (err) {
        reportError(a, 'onboarding', err);
      }
    }
    // Cleared only when a render actually happened: a structural change that lands while the tab is
    // backgrounded must still reach the panels on the first visible frame.
    a.structural = false;
  }
  const tR1 = performance.now();

  // ---- perf accounting -----------------------------------------------------------------------
  const p = a.perf;
  p.frame_ms += (dt_ms - p.frame_ms) * 0.1;
  p.sim_ms += ((tSim1 - tSim0) - p.sim_ms) * 0.1;
  p.render_ms += ((tR1 - tR0) - p.render_ms) * 0.1;
  p.ticks = ticks;
  p.tAcc += dt_ms;
  p.nAcc += ticks;
  if (p.tAcc >= 500) { p.tps = p.nAcc * 1000 / p.tAcc; p.tAcc = 0; p.nAcc = 0; }
  if (a.perfOn && document.visibilityState !== 'hidden') renderPerf(a);
}

/**
 * Consume every event appended to `run.events` since the last frame: feed the coach-hint scheduler
 * and raise the `structural` flag when list content changed.
 * @param {object} a the application instance
 * @returns {void}
 */
function drainEvents(a) {
  const events = a.ctx.run.events;
  if (!events) { a.lastEventCount = 0; return; }
  const n = events.length;
  if (n < a.lastEventCount) a.lastEventCount = 0;      // the run was replaced
  for (let i = a.lastEventCount; i < n; i++) {
    const ev = events[i];
    if (STRUCTURAL_EVENT_TYPES[ev.type]) a.structural = true;
    if (a.onboarding) {
      try {
        onboarding.noteEvent(a.onboarding, ev);
      } catch (err) {
        reportError(a, 'onboarding', err);
      }
    }
  }
  a.lastEventCount = n;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SHELL RENDER — text, classes and attributes onto cached nodes; no innerHTML, no layout reads
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Repaint the persistent chrome from the current `run`. Called once per visible frame.
 * @param {object} a the application instance
 * @param {boolean} structural true when list content may have changed
 * @returns {void}
 */
function refreshShell(a, structural) {
  const { config, run } = a.ctx;
  if (structural) a.alarmSig = null;
  collectAlarms(a, config, run);
  refreshTitleBar(a, config, run);
  refreshToolbar(a, config, run);
  refreshStatusStrip(a, config, run);
  refreshAlarmBar(a);
  if (a.skipHold.active) advanceSkipHold(a);
}

/**
 * Fill `a.alarm` with this frame's alarm picture: the count and the per-severity tallies over EVERY
 * raised row, the signal names in alarm (which redden the status boxes), the first row waiting to
 * be acknowledged, and the ranked list of rows the banner may show.
 *
 * Silencing is a SCREEN act, never a process act: a silenced row is kept out of `active` — the
 * banner — but still counts, still lights its summary lamp and can still be acknowledged, so
 * nothing an operator does to the banner can hide the fact that the alarm is standing.
 *
 * Buffers are reused, so a frame allocates nothing here.
 *
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function collectAlarms(a, config, run) {
  const defs = config.alarms || [];
  const out = a.alarm;
  out.active.length = 0;
  out.signals.clear();
  out.evals.clear();
  out.count = 0;
  out.crit = 0;
  out.alarms = 0;
  out.warns = 0;
  out.worst = '';
  out.ackable = null;

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const raised = run.alarmActive[i] === 1
      || (run.alarmLatched[i] === 1 && run.alarmAcked[i] !== 1);
    if (!raised) continue;
    const rank = SEVERITY_RANK[def.severity] || 0;
    out.count++;
    if (rank >= SEVERITY_RANK.CRITICAL) out.crit++;
    else if (rank === SEVERITY_RANK.ALARM) out.alarms++;
    else out.warns++;
    if (def.signal) out.signals.add(def.signal);
    if (def.evalKey) out.evals.add(def.evalKey);
    if (!out.worst || rank > (SEVERITY_RANK[out.worst] || 0)) out.worst = def.severity;
    if ((def.ackRequired || def.latching)
      && (!out.ackable || rank > (SEVERITY_RANK[out.ackable.severity] || 0))) out.ackable = def;
    if (!a.silenced.has(def.id)) out.active.push(def);
  }
  out.active.sort((x, y) => (SEVERITY_RANK[y.severity] || 0) - (SEVERITY_RANK[x.severity] || 0));
}

/**
 * Repaint the title strip: unit, block counter, clock, progress and the alarm-summary lamps.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshTitleBar(a, config, run) {
  const el = a.el;
  fmt.setText(el.unitName, String(config.name || config.presetId).toUpperCase());

  const blocks = config.method ? config.method.blocks : null;
  if (blocks && blocks.length > 0) {
    const i = Math.max(0, Math.min(blocks.length - 1, run.blockIndex));
    const b = blocks[i];
    const prog = blockProgress(config, run);
    const pct = Number.isFinite(prog.fraction) ? Math.round(prog.fraction * 100) : 0;
    setBox(el.blkBox, `${i + 1}/${blocks.length}`, '');
    fmt.setAttr(el.blkBox.el, 'title', `${b.id} · ${b.name || b.type} — ${pct} % delivered, `
      + `${fmt.fmtVolume(prog.remaining_mL, config)} remaining`);
  } else {
    setBox(el.blkBox, fmt.NO_VALUE, '');
    fmt.setAttr(el.blkBox.el, 'title', 'No method is loaded');
  }

  setBox(el.clkBox, fmt.fmtClock(run.t_s), '');

  const pct = Math.round(methodFraction(a, config, run) * 100);
  if (a.progressPct !== pct) {                 // a style write per frame is a style invalidation
    a.progressPct = pct;
    el.progressFill.style.width = `${pct}%`;
    fmt.setAttr(el.progressTrack, 'aria-valuenow', String(pct));
    fmt.setAttr(el.progressTrack, 'aria-valuetext',
      `${pct} % of the method, ${(run.V_tot_mL / config.column.V_mL).toFixed(2)} column volumes delivered`);
  }

  // Counted over every raised row, silenced ones included: a summary lamp that a silenced banner
  // could switch off would be a lie.
  const { crit, alarms, warns } = a.alarm;
  setLamp(el.lampCrit, crit > 0 ? 'alarm' : 'off',
    crit > 0 ? `Critical alarms: ${crit}` : 'Critical alarms: none', crit > 0);
  setLamp(el.lampAlarm, alarms > 0 ? 'alarm' : 'off',
    alarms > 0 ? `Alarms: ${alarms}` : 'Alarms: none', false);
  setLamp(el.lampWarn, warns > 0 ? 'warn' : 'off',
    warns > 0 ? `Warnings: ${warns}` : 'Warnings: none', false);
  setBox(el.almBox, String(a.alarm.count), '');
  setBoxState(el.almBox, a.alarm.count > 0, false);
}

/**
 * Repaint the toolbar: transport availability, the speed chips, the honest speed readout, the
 * manual-mode toggle and the acknowledge button.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshToolbar(a, config, run) {
  const el = a.el;
  const st = run.state;
  const held = st === 'HELD' || st === 'PAUSED';

  setEnabled(el.runBtn, st === 'IDLE' || st === 'READY',
    held ? 'Already started — use Continue.' : `Cannot start from ${st}.`,
    'Run the pre-run checks and start (Space)');
  setEnabled(el.holdBtn, st === 'RUNNING',
    `Hold is only available while RUNNING (state is ${st}).`,
    'Freeze the method; flow stays at setpoint (H)');
  setEnabled(el.contBtn, held,
    `Continue is only available from HELD or PAUSED (state is ${st}).`,
    'Return to RUNNING (C)');
  setEnabled(el.skipBtn, st === 'RUNNING' || st === 'HELD',
    `A block can only be skipped while RUNNING or HELD (state is ${st}).`,
    'Skip the current block — press and hold for 400 ms (N)');
  setEnabled(el.stopBtn, st === 'RUNNING' || st === 'HELD' || st === 'PAUSED' || st === 'ALARM',
    `Cannot end from ${st}.`, 'End now, or after the current block (E)');
  // At run end the transport collapses to Reset: replay and scrubbing do not exist, so there is no
  // post-run cursor. The Results screen is the only post-run surface.
  const resettable = st === 'ENDED' || st === 'FAULT' || st === 'READY';
  setEnabled(el.resetBtn, resettable,
    `Reset is available from READY, ENDED and FAULT (state is ${st}).`,
    'Return to IDLE and rebuild the fluid path');

  for (const chip of el.speedChips) {
    const on = Number(chip.dataset.speed) === run.speed;
    fmt.cls(chip, 'is-active', on);
    fmt.setAttr(chip, 'aria-checked', on ? 'true' : 'false');
  }

  const paused = st === 'PAUSED' || st === 'HELD';
  fmt.setAttr(el.pauseBtn, 'aria-pressed', paused ? 'true' : 'false');
  fmt.setAttr(el.pauseBtn, 'aria-label', paused ? 'Resume the simulation' : 'Pause the simulation');
  fmt.cls(el.pauseBtn, 'is-active', paused);
  setEnabled(el.pauseBtn, st === 'RUNNING' || paused,
    `Nothing is running to pause (state is ${st}).`,
    paused ? 'Return to RUNNING (P)' : 'Ramp flow to zero and freeze the clock (P)');

  // The honesty readout — never claim a speed the machine is not delivering.
  const limited = run.speedDeficit > 1.01 && st === 'RUNNING';
  const achieved = limited ? run.speed / run.speedDeficit : run.speed;
  setBox(el.spdBox, formatSpeed(achieved), '×');
  setBoxState(el.spdBox, false, limited);
  setLamp(el.speedLamp, limited ? 'warn' : 'off',
    limited
      ? `Speed limited: asking for ${run.speed}×, achieving ${formatSpeed(achieved)}×`
      : 'Speed limited: no', false);
  fmt.setAttr(el.spdBox.el, 'title', limited
    ? 'This machine cannot keep up with the requested speed. Effective speed is '
      + 'run.speed / run.speedDeficit; a coarser column grid buys it back.'
    : 'Simulated seconds per real second');

  const manual = !!run.manualOverride;
  fmt.cls(el.manualBtn, 'is-active', manual);
  fmt.setAttr(el.manualBtn, 'aria-pressed', manual ? 'true' : 'false');
  fmt.setAttr(el.manualBtn, 'aria-label', manual ? 'Manual control is ON' : 'Manual control is OFF');
  fmt.cls(el.shell, 'is-manual', manual);

  const ackable = a.alarm.ackable;
  setEnabled(el.ackBtn, !!ackable,
    'No alarm is waiting to be acknowledged.',
    ackable ? `Acknowledge ${ackable.id} — ${ackable.name}` : 'Acknowledge the highest alarm');
}

/**
 * Advance the Skip Block hold ring and fire the skip once the 400 ms threshold is crossed.
 * @param {object} a the application instance
 * @returns {void}
 */
function advanceSkipHold(a) {
  const p = Math.min(1, (performance.now() - a.skipHold.start_ms) / SKIP_HOLD_MS);
  fmt.setAttr(a.el.skipArc, 'stroke-dashoffset', String(a.el.skipArcLength * (1 - p)));
  if (p >= 1) {
    a.skipHold.active = false;
    fmt.setAttr(a.el.skipArc, 'stroke-dashoffset', String(a.el.skipArcLength));
    act(a, () => sim.skipBlock(a.ctx));
  }
}

/**
 * Overall method progress as a fraction, weighted by block VOLUME so the title strip's bar agrees
 * with the phase rail. `methodDemand` is cached per `config` and dropped on `config-replaced`.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {number} 0..1
 */
function methodFraction(a, config, run) {
  if (!config.method || !Array.isArray(config.method.blocks)) return 0;
  if (!a.demandCache || a.demandCache.config !== config) {
    let total = 0;
    const startById = Object.create(null);
    try {
      const d = methodDemand(config, config.method);
      for (const b of d.perBlock) { startById[b.id] = total; total += b.volume_mL; }
    } catch (_err) {
      total = 0;
    }
    a.demandCache = { config, total_mL: total, startById };
  }
  const total = a.demandCache.total_mL;
  if (!(total > 0)) return 0;
  const blocks = config.method.blocks;
  const b = blocks[Math.max(0, Math.min(blocks.length - 1, run.blockIndex))];
  const start = b ? (a.demandCache.startById[b.id] || 0) : 0;
  return Math.max(0, Math.min(1, (start + Math.max(0, run.V_block_mL)) / total));
}

/**
 * Repaint the status strip. Each box carries its sensor's `sensorQuality` verdict and its alarm
 * state as classes, which `styles/app.css` renders as digit colour; the QUAL box states the verdict
 * as a code, so the information is never colour alone.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshStatusStrip(a, config, run) {
  const f = a.el.fields;
  writeField(f.flow, 'flow', run.Q_actual_mLs, config);
  writeField(f.pctb, 'pct', run.pctB_actual, config);
  writeField(f.p1, 'pressure', run.press.P1disp_bar, config);
  writeField(f.dp, 'pressure', run.dP_bar, config);
  writeField(f.uv, 'abs', run.uv.Afilt[0], config);
  writeField(f.cond, 'cond', run.cond.kappaDisp_mScm, config);
  writeField(f.ph, 'ph', run.ph.pHfilt, config);
  writeField(f.cv, 'cv', run.V_tot_mL, config);

  let worst = 'OK';
  for (const spec of STATUS_FIELDS) {
    const q = spec.sensor ? sensorQuality(run, spec.sensor) : 'OK';
    if (q !== 'OK' && worst === 'OK') worst = q;
    else if (q === 'INVALID') worst = 'INVALID';
    let inAlarm = false;
    for (const s of spec.signals) if (a.alarm.signals.has(s)) inAlarm = true;
    for (const k of spec.evals) if (a.alarm.evals.has(k)) inAlarm = true;
    // Flow has no sensor of its own, but an automatic flow reduction means the number on screen is
    // not the number the method asked for, and that must be visible.
    const stale = q !== 'OK'
      || (spec.key === 'flow' && (run.qualityFlags & QF.FLOW_REDUCED) !== 0);
    setBoxState(f[spec.key], inAlarm, stale);
  }

  const st = run.state;
  setBox(a.el.stateBox, st, '');
  setBoxState(a.el.stateBox, st === 'ALARM' || st === 'FAULT', st === 'HELD' || st === 'PAUSED');
  fmt.setAttr(a.el.stateBox.el, 'title', stateExplanation(st));
  setLamp(a.el.stateLamp, stateLamp(st), `Run state: ${st} — ${stateExplanation(st)}`,
    st === 'ALARM' || st === 'FAULT');

  let nFlags = 0;
  const names = [];
  for (const [bit, label] of QF_LABELS) {
    if ((run.qualityFlags & bit) === 0) continue;
    nFlags++;
    names.push(label);
  }
  const tone = worst === 'INVALID' ? 'alarm' : (worst === 'OK' ? 'run' : 'warn');
  const qualText = nFlags === 0
    ? 'Data quality: OK — press for the per-sensor verdicts'
    : `Data quality: ${worst}, ${nFlags} flag${nFlags === 1 ? '' : 's'}: ${names.join(' · ')}`;
  setLamp(a.el.qualLamp, tone, qualText, false);
  setBox(a.el.qualBox, QUALITY_CODE[worst] || worst, nFlags > 0 ? String(nFlags) : '');
  setBoxState(a.el.qualBox, worst === 'INVALID', worst !== 'OK');
  fmt.setAttr(a.el.qualBox.el, 'title', qualText);
}

/**
 * Format one canonical value into its label box, unit and all.
 * @param {{val:Element, eu:Element, box:Element}} rec the label box record
 * @param {'volume'|'cv'|'flow'|'time'|'pressure'|'conc'|'abs'|'cond'|'ph'|'pct'} kind the quantity
 * @param {number} value the canonical value
 * @param {object} config the frozen config
 * @returns {void}
 */
function writeField(rec, kind, value, config) {
  if (!rec) return;
  const d = fmt.toDisplay(kind, value, config);
  setBox(rec, fmt.fmtFixed(d.value, d.decimals), d.unit);
}

/**
 * Repaint the alarm banner when the active set changes, and keep the two live regions honest.
 *
 * The band shows the highest-ranked alarm; when there is none it shows the last caught shell error;
 * when there is neither it disappears. Only the newest alarm's text is placed in a live region,
 * rebuilt rather than appended, so a screen reader announces once.
 *
 * @param {object} a the application instance
 * @returns {void}
 */
function refreshAlarmBar(a) {
  const el = a.el;
  const top = a.alarm.active[0] || null;
  const err = a.shellError;
  const sig = top
    ? `A:${a.alarm.active.map((d) => d.id).join('|')}#${a.alarm.count}`
    : (err ? `E:${err.source}:${err.message}` : '');

  if (sig !== a.alarmSig) {
    a.alarmSig = sig;

    if (top) {
      const sev = top.severity || 'WARN';
      setLamp(el.alarmLamp, SEVERITY_LAMP[sev] || 'warn', `${sev}: ${top.name}`,
        (SEVERITY_RANK[sev] || 0) >= SEVERITY_RANK.ALARM);
      fmt.setText(el.alarmSev, SEVERITY_CODE[sev] || sev);
      fmt.setText(el.alarmTag, alarmTag(top));
      fmt.setText(el.alarmCode, `${top.id} · ${top.name}`);
      fmt.setText(el.alarmCond, alarmCondition(top));
      fmt.setAttr(el.alarmBar, 'title', `${top.id} — ${top.name}. Action ${top.action}.`);
      fmt.setText(el.alarmCount, String(a.alarm.count));
      el.alarmCount.hidden = a.alarm.count < 2;
      el.alarmAckBtn.hidden = !(top.ackRequired || top.latching);
      fmt.setAttr(el.alarmAckBtn, 'aria-label', `Acknowledge ${top.name}`);
      el.alarmSilenceBtn.hidden = false;
      fmt.setAttr(el.alarmSilenceBtn, 'aria-label', `Silence the banner for ${top.name}`);
      el.alarmMoreBtn.hidden = a.alarm.count < 2;
      el.errCopyBtn.hidden = true;
      el.errClearBtn.hidden = true;
    } else if (err) {
      setLamp(el.alarmLamp, 'alarm', `Shell error in ${err.source}`, false);
      fmt.setText(el.alarmSev, 'ERR');
      fmt.setText(el.alarmTag, err.source.toUpperCase());
      fmt.setText(el.alarmCode, err.message);
      fmt.setText(el.alarmCond, '');
      fmt.setAttr(el.alarmBar, 'title', `${err.source}: ${err.message}`);
      el.alarmCount.hidden = true;
      el.alarmAckBtn.hidden = true;
      el.alarmSilenceBtn.hidden = true;
      el.alarmMoreBtn.hidden = true;
      el.errCopyBtn.hidden = false;
      el.errClearBtn.hidden = false;
    }
    el.alarmBar.hidden = !(top || err);

    const topId = top ? top.id : '';
    if (topId !== a.liveAlarmId) {
      a.liveAlarmId = topId;
      const text = top ? `${top.severity}: ${top.name}` : '';
      const rank = top ? (SEVERITY_RANK[top.severity] || 0) : 0;
      fmt.setText(el.alarmAssertive, rank >= SEVERITY_RANK.CRITICAL ? text : '');
      fmt.setText(el.alarmPolite, rank > 0 && rank < SEVERITY_RANK.CRITICAL ? text : '');
    }
  }
}

/**
 * The ISA tag an alarm watches, for the banner's tag slot.
 * @param {object} def the `AlarmDef` row
 * @returns {string} the tag, or the alarm's own family prefix when it watches no single instrument
 */
function alarmTag(def) {
  const entry = def.signal ? glossaryFor(def.signal) : null;
  if (entry && entry.term) {
    const m = /([A-Z]{2,4}-\d{3})/.exec(entry.term);
    if (m) return m[1];
  }
  if (def.signal) return def.signal;
  return def.id.split('-').slice(0, 2).join('-');
}

/**
 * The trip condition in as few characters as a 24 px band allows: `P1 > 1.60`, or the custom
 * evaluator's key when there is no simple comparison.
 * @param {object} def the `AlarmDef` row
 * @returns {string} the condition
 */
function alarmCondition(def) {
  if (def.signal && def.op && typeof def.threshold === 'number') {
    return `${def.signal} ${def.op} ${def.threshold}`;
  }
  if (def.evalKey) return def.evalKey;
  return def.action || '';
}

/**
 * Repaint the `Ctrl+Alt+P` performance overlay. Rows are created once and then written to, so the
 * overlay costs a handful of text assignments per frame.
 * @param {object} a the application instance
 * @returns {void}
 */
function renderPerf(a) {
  const run = a.ctx.run;
  const p = a.perf;
  const rows = [
    ['FRAME', `${p.frame_ms.toFixed(1)} ms · ${(1000 / Math.max(p.frame_ms, 0.001)).toFixed(0)} fps`],
    ['SIM', `${p.sim_ms.toFixed(2)} ms`],
    ['RENDER', `${p.render_ms.toFixed(2)} ms`],
    ['TICK/FR', String(p.ticks)],
    ['TICK/S', p.tps.toFixed(0)],
    ['SPEED', `${run.speed}× → ${formatSpeed(run.speed / Math.max(run.speedDeficit, 1e-9))}×`],
    ['DEFICIT', run.speedDeficit.toFixed(3)],
    ['MS/SIM-S', run.diag.msPerSimSecond.toFixed(3)],
    ['MS/TICK', run.diag.msLastTick.toFixed(3)],
    ['NSUB', String(run.diag.nSubLast)],
    ['COURANT', run.diag.courant.toFixed(3)],
    ['CELLS', String(run.diag.activeCells)],
    ['NZ', String(a.ctx.config.column.nz)],
    ['BENCH', a.benchmark ? `${a.benchmark.msPerSimSecond.toFixed(2)} ms/sim-s` : 'not run'],
    ['LOG', String(run.log ? run.log.n : 0)],
  ];

  if (!a.perfRows || a.perfRows.length !== rows.length) {
    while (a.el.perf.firstChild) a.el.perf.removeChild(a.el.perf.firstChild);
    a.perfRows = rows.map(([k]) => {
      const value = h('span', { class: 'perf__value' }, '');
      a.el.perf.appendChild(h('div', { class: 'perf__row' },
        h('span', { class: 'perf__key' }, k), value));
      return value;
    });
  }
  for (let i = 0; i < rows.length; i++) fmt.setText(a.perfRows[i], rows[i][1]);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ERRORS — the alarm band doubles as the shell's failure surface
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * @param {*} err anything thrown
 * @returns {string} a one-line message
 */
function errText(err) {
  if (!err) return 'unknown error';
  return (err && err.message) ? String(err.message) : String(err);
}

/**
 * Surface a caught error in the alarm band instead of freezing. One error is held at a time, so a
 * fault that repeats every frame never grows the DOM. An active alarm always outranks it.
 * @param {object} a the application instance
 * @param {string} source where it came from, e.g. `'main screen'`
 * @param {*} err the thrown value
 * @returns {void}
 */
function reportError(a, source, err) {
  console.error(`[app] ${source} failed:`, err);
  if (!a || !a.el || !a.el.alarmBar) return;
  a.shellError = {
    source,
    message: errText(err),
    detail: `${source}: ${errText(err)}\n${(err && err.stack) || ''}`,
  };
  a.alarmSig = null;
}

/**
 * Copy the held error, stack and all, to the clipboard — the one thing a user can usefully do with
 * a stack trace.
 * @param {object} a the application instance
 * @returns {void}
 */
function copyShellError(a) {
  if (!a.shellError) return;
  const text = a.shellError.detail;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  else console.log(text);
}

/**
 * Dismiss the held error and let the band close.
 * @param {object} a the application instance
 * @returns {void}
 */
function clearShellError(a) {
  a.shellError = null;
  a.alarmSig = null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SMALL FORMATTERS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * @param {string} st a `run.state` value
 * @returns {'off'|'run'|'warn'|'alarm'} the lamp colour for the run-state lamp
 */
function stateLamp(st) {
  switch (st) {
    case 'RUNNING': return 'run';
    case 'READY': return 'run';
    case 'ENDED': return 'run';
    case 'HELD': return 'warn';
    case 'PAUSED': return 'warn';
    case 'ALARM': return 'alarm';
    case 'FAULT': return 'alarm';
    default: return 'off';
  }
}

/**
 * One sentence explaining what a run state permits — the state box's tooltip.
 * @param {string} st a `run.state` value
 * @returns {string} the explanation
 */
function stateExplanation(st) {
  switch (st) {
    case 'IDLE': return 'Idle — pumps at zero. Start runs the pre-run checks first.';
    case 'READY': return 'Ready — the pre-run checks passed. Start begins the method.';
    case 'RUNNING': return 'Running — the method engine is driving the skid.';
    case 'HELD': return 'Held — flow continues at setpoint; the block clock and block volume are frozen.';
    case 'PAUSED': return 'Paused — flow has ramped to zero and the clock is frozen.';
    case 'ALARM': return 'Alarm — the outlet is diverted to waste. Acknowledge, then Hold or Pause.';
    case 'ENDED': return 'Ended — the Results screen has the analysis. Reset to arm another run.';
    case 'FAULT': return 'Fault — flow stopped without a ramp. Only Reset recovers.';
    default: return 'Run state';
  }
}

/**
 * Round an effective speed to something an operator can read without it flickering.
 * @param {number} x speed multiplier
 * @returns {string} the rounded speed
 */
function formatSpeed(x) {
  if (!Number.isFinite(x)) return '0';
  if (x >= 100) return String(Math.round(x / 10) * 10);
  if (x >= 10) return String(Math.round(x));
  return x.toFixed(1);
}
