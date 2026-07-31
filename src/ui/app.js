/**
 * @file src/ui/app.js — the composition root and the program's ONLY `requestAnimationFrame` loop.
 *
 * Contract: architecture-v2 §6.32 (this module), §2.4 (the one `ctx` shape and the rebuild
 * protocol), §3.1–§3.2 (loop ownership), §9.1.1 (shell bands), §9.4.3 (the run control bar),
 * §9.5 (the keymap), §9.6 (onboarding is mounted at boot step 4a), §9.7 (accessibility).
 *
 * RESPONSIBILITIES
 *   - Build the ONE `ctx = { config, run, bus, sim, fmt, overrides }` (§2.4). `skid.createSkid` is
 *     REQUIRED after every `createRunState`, or `run.topo/bed/col` stay null and the first
 *     `physicsTick` throws.
 *   - Own the single rAF loop: `sim.advanceWall(ctx, wallDt_s)` once per frame, then `update()` on
 *     the VISIBLE view only. A hidden tab costs nothing.
 *   - Own the persistent chrome: title bar, run control bar, alarm banner stack, tab strip, status
 *     strip, the perf overlay and the theme toggle.
 *   - Route every `sim.*` action's `{ ok, reason }` to a toast when `ok` is false — never a silent
 *     refusal (§9.4.4).
 *   - Surface `run.speedDeficit` honestly as `1000× (limited to N×)` (§2.1.1, §9.4.3).
 *
 * THE UI IS READ-ONLY OVER `run` AND `config`. Nothing in this file assigns to either; every
 * mutation goes through `core/sim.js`.
 *
 * FRAME SAFETY. `sim.advanceWall` and every panel `update()` are guarded: a throwing panel is
 * reported in the chrome and, after three consecutive failures, taken out of the loop — but the
 * loop itself never dies and the shell never freezes.
 *
 * DOM DISCIPLINE. `boot` empties `#app` and builds the shell once. After that this module writes
 * only text and attributes onto cached node references: there is no `innerHTML` anywhere in this
 * file, and no layout read (`getBoundingClientRect`, `offsetWidth`) inside a frame (§6.24).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CSS CONTRACT — the class vocabulary this module emits, styled in `styles/app.css`:
 *   .shell .skip-link .sr-only
 *   .titlebar .titlebar__title .titlebar__sub .titlebar__spacer .titlebar__actions
 *   .chip .chip--sim
 *   .runbar .runbar__group .runbar__stack .runbar__label .runbar__value .runbar__rule
 *   .runbar__speed-note (.is-limited) .runbar__progress .runbar__progress-fill
 *   .pill .pill--lg .pill--ok|warn|alarm|info|neutral
 *   .btn .btn--primary .btn--ghost .btn--danger .btn--icon .btn--sm .btn--estop
 *   .segmented .segmented__opt (.is-selected)
 *   .holdring .holdring__track .holdring__fill
 *   .alarm-stack .alarm-stack__list .banner .banner--info|warn|alarm|critical|fault
 *   .banner__bar .banner__icon .banner__text .banner__sev .banner__msg .banner__detail
 *   .banner__actions .banner__count .info-dot
 *   .tabstrip .tab (.is-active) .workspace .view .view--run|method|results|system
 *   .statusstrip .statchip .statchip__label .statchip__value (.is-warn|.is-invalid|.is-off)
 *   .perf-overlay .perf-overlay__row .perf-overlay__k .perf-overlay__v
 *   .shell-error .shell-error__msg .shell-error__actions .shell-narrow-note
 *   .glossary .glossary__typical .empty .empty__title .table-wrap .field__hint .btn-row
 * The `.shell` grid has exactly six rows, so every extra surface it owns is out of flow: the skip
 * link is absolute, the narrow note and the perf overlay are fixed, and the error bar lives inside
 * the alarm band rather than adding a seventh band.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Layer L10. Imports the sim surface, the two physics helpers the startup benchmark needs, the four
 * views, the overlay host and onboarding, plus three pure read-only helpers from the skid layer
 * (`blockProgress`, `methodDemand`, `sensorQuality`).
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

/** The four tabs of §9.1.1, in DOM and `Alt+N` order. */
const TABS = [
  { id: 'run', label: 'Run', key: 'Alt+1', create: createRunView },
  { id: 'method', label: 'Method', key: 'Alt+2', create: createMethodView },
  { id: 'results', label: 'Results', key: 'Alt+3', create: createResultsView },
  { id: 'system', label: 'System', key: 'Alt+4', create: createSystemView },
];

/** Allowed axial grid sizes for the startup benchmark (§2.4 D5). Downgrade only. */
const NZ_LADDER = [100, 200, 400, 800];

/**
 * Column-solver budget in milliseconds per SIMULATED second, used to pick `nz` at boot.
 * The reference machine of §2.1.1 measures ~5 ms/sim-s at `nz = 400` (0.25 ms per 0.05 s tick), so
 * 8.0 keeps the shipped grid on a reference-class machine and downgrades on one ~1.6× slower.
 */
const NZ_BUDGET_MS_PER_SIM_S = 8.0;

/** Simulated seconds the startup benchmark covers. Long enough to be stable, short enough to hide. */
const BENCH_SIM_SECONDS = 3.0;

/** Wall-clock clamp per frame, seconds — mirrors `sim.advanceWall`'s own clamp (§3.2). */
const WALL_CLAMP_S = 0.25;

/** Press-and-hold duration for Skip Block, ms (§9.4.3). */
const SKIP_HOLD_MS = 400;

/** Two `Shift+Esc` presses inside this window fire the emergency stop (§9.5). */
const ESTOP_DOUBLE_MS = 1000;

/** Consecutive `update()` throws before a view is taken out of the frame loop. */
const VIEW_FAIL_LIMIT = 3;

/** Radius of the Skip Block progress ring, SVG user units. */
const RING_R = 9;

/** Severity ladder used to rank the alarm banner stack (§5.6). */
const SEVERITY_RANK = { INFO: 0, WARN: 1, ALARM: 2, CRITICAL: 3, FAULT: 4 };

/** Glyph per severity. Severity is ALWAYS also given as text — never colour alone (§9.7). */
const SEVERITY_GLYPH = { INFO: 'i', WARN: '!', ALARM: '!', CRITICAL: '×', FAULT: '×' };

/** Maximum banners drawn before the "+N more" row takes over (§9.1.1). */
const MAX_BANNERS = 3;

/** Event types that change list content and therefore demand a `structural` frame (§6.24). */
const STRUCTURAL_EVENT_TYPES = {
  BLOCK_START: 1, BLOCK_END: 1, FRACTION_START: 1, FRACTION_END: 1,
  ALARM_RAISED: 1, ALARM_CLEARED: 1, ALARM_ACK: 1, RUN_START: 1, RUN_END: 1,
  STATE_CHANGE: 1, PACKING_TEST_RESULT: 1, SCENARIO_APPLIED: 1,
};

/** Human names for the `run.qualityFlags` bits (§5.3), for the status strip's Quality chip. */
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

/**
 * The status strip of §9.1.1: key, visible label, glossary id, and the sensor whose
 * `sensorQuality` verdict tints the value (§5.3). `null` means the chip has no sensor of its own.
 */
const STATUS_CHIPS = [
  { key: 'p1', label: 'P1', gloss: 'PT-101', sensor: 'PRESS' },
  { key: 'dp', label: 'ΔP', gloss: 'PDT-101', sensor: 'PRESS' },
  { key: 'flow', label: 'Flow', gloss: 'FT-101', sensor: null },
  { key: 'pctb', label: '%B', gloss: 'pctB', sensor: null },
  { key: 'uv', label: 'UV280', gloss: 'UV-101', sensor: 'UV' },
  { key: 'cond', label: 'Cond', gloss: 'CE-101', sensor: 'COND' },
  { key: 'ph', label: 'pH', gloss: 'AE-101', sensor: 'PH' },
  { key: 'cv', label: 'Total', gloss: 'cv', sensor: null },
  { key: 'clock', label: 'Sim', gloss: 'run-state', sensor: null },
  { key: 'quality', label: 'Quality', gloss: 'quality-flags', sensor: null },
];

/**
 * The global keyboard registry of §9.5.
 *
 * Keys are normalised combos (`normaliseCombo`): modifiers in the fixed order `Ctrl+Alt+Shift+`,
 * then the key name with single characters upper-cased. `Shift` is dropped for punctuation so `?`,
 * `+` and `-` are reachable on every layout.
 *
 * Shell-scoped actions execute here. View-scoped actions (chart, legend, pooling) are emitted on
 * `ctx.bus` as `('key-action', { action, combo, event })`, so whichever view owns them reacts
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
  'Alt+1': { action: 'tab:run', label: 'Run tab', group: 'Navigation' },
  'Alt+2': { action: 'tab:method', label: 'Method tab', group: 'Navigation' },
  'Alt+3': { action: 'tab:results', label: 'Results tab', group: 'Navigation' },
  'Alt+4': { action: 'tab:system', label: 'System tab', group: 'Navigation' },
  'X': { action: 'x-axis-cycle', label: 'Cycle the x axis: volume / CV / time', group: 'Chromatogram' },
  'A': { action: 'autoscale', label: 'Autoscale — fit all', group: 'Chromatogram' },
  'F': { action: 'follow-toggle', label: 'Toggle follow-live', group: 'Chromatogram' },
  '+': { action: 'zoom-in', label: 'Zoom in about the cursor', group: 'Chromatogram' },
  '-': { action: 'zoom-out', label: 'Zoom out about the cursor', group: 'Chromatogram' },
  'ArrowLeft': { action: 'pan-left', label: 'Pan left', group: 'Chromatogram' },
  'ArrowRight': { action: 'pan-right', label: 'Pan right', group: 'Chromatogram' },
  'Shift+ArrowLeft': { action: 'pan-left-fast', label: 'Pan left, 5×', group: 'Chromatogram' },
  'Shift+ArrowRight': { action: 'pan-right-fast', label: 'Pan right, 5×', group: 'Chromatogram' },
  'L': { action: 'legend-focus', label: 'Legend channel focus mode', group: 'Chromatogram' },
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
 * SMALL DOM HELPERS
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
 * Create a `<button>` with a click handler already attached.
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
 * Set `disabled` plus a `title` that explains WHY when the control is unavailable (§9.7).
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

/**
 * True when a text-entry element has focus, in which case bare keys are the user's typing (§9.5).
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
 * Boot order is §6.32, exactly:
 *   1. warm both theme-token maps, adopt the theme `index.html` stamped, build the shell chrome;
 *   2. build `ctx` (`normalizePreset` → `createRunState` → **`createSkid`**, which is required);
 *   3. benchmark a throwaway column, pick `nz` (downgrade only), `sim.rebuild(ctx, {column:{nz}})`;
 *   4. mount the four views, only the active one updating;
 *   4a. mount `ui/onboarding.js` — after the views, because its coach marks measure them, and
 *       before the loop, because its tour may auto-load `textbook-clean` at 60×;
 *   5. start the single `requestAnimationFrame` loop.
 *
 * @param {Element} rootEl `#app` from `index.html`; its placeholder content is removed
 * @returns {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}}
 *   the one long-lived `ctx` of §2.4
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
    views: new Map(),             // tabId -> { panel, host, failCount, disabled }
    activeTab: 'run',
    overlayHost: null,
    onboarding: null,
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    rafId: 0,
    tPrev: 0,
    structural: true,
    frameInfo: { now_ms: 0, dt_ms: 16.7, tick: 0, structural: true },
    lastEventCount: 0,
    demandCache: null,            // { config, total_mL, startById }
    progressPct: -1,
    // `null`, never `''`: an EMPTY alarm set has the signature `''`, so a `''` sentinel would make
    // "some alarms" -> "no alarms" compare equal and leave the banners on screen forever.
    alarmSig: null,
    silenced: new Set(),          // alarm ids the operator muted for this session
    liveAlarmId: null,
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

    // ---- 3. startup grid benchmark (D5) ------------------------------------------------------
    runStartupBenchmark(app);

    // ---- 4. the four views -------------------------------------------------------------------
    mountViews(app);

    // ---- 4a. onboarding ----------------------------------------------------------------------
    try {
      app.onboarding = onboarding.createOnboarding(app.el.shell, ctx, app.overlayHost);
      app.onboarding.mount();
    } catch (err) {
      reportError(app, 'onboarding', err);
    }

    // ---- input wiring ------------------------------------------------------------------------
    wireBus(app);
    wireKeyboard(app);
    wireResponsiveNote(app);
    document.addEventListener('visibilitychange', () => { app.tPrev = 0; });

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
 * Warm both theme-token maps once at boot (§6.25). `readThemeTokens` owns the hidden probes and the
 * cache; calling it here pays that cost before the first paint instead of inside a frame.
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
 * Time a throwaway column and pick the axial grid size, downgrading only (§2.4 D5).
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
 * Create the four view containers, construct each view into its own, and hide all but the active.
 * A view that throws at construction shows a written empty state instead of taking the shell down.
 * @param {object} a the application instance
 * @returns {void}
 */
function mountViews(a) {
  for (const tab of TABS) {
    const host = h('section', {
      class: `view view--${tab.id}`,
      id: `view-${tab.id}`,
      role: 'tabpanel',
      tabindex: '0',
      'aria-labelledby': `tab-${tab.id}`,
    });
    if (tab.id !== a.activeTab) host.hidden = true;
    a.el.workspace.appendChild(host);

    let panel = null;
    try {
      panel = tab.create(host, a.ctx);
      if (panel && typeof panel.mount === 'function') panel.mount();
    } catch (err) {
      panel = null;
      host.appendChild(h('div', { class: 'empty' },
        h('p', { class: 'empty__title' }, `The ${tab.label} view failed to load`),
        h('p', {}, errText(err))));
      reportError(a, `${tab.id} view`, err);
    }
    a.views.set(tab.id, { panel, host, failCount: 0, disabled: !panel });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SHELL CONSTRUCTION — the six bands of §9.1.1, built once
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Empty `#app` and build the shell: title bar 44 px, run bar 56 px, alarm stack, tab strip 36 px,
 * workspace, status strip 28 px — plus the out-of-flow skip link, narrow note and perf overlay.
 * @param {object} a the application instance
 * @returns {void}
 */
function buildShell(a) {
  while (a.root.firstChild) a.root.removeChild(a.root.firstChild);

  const shell = h('div', { class: 'shell' });
  a.el.shell = shell;

  // Out of flow, so the six-row grid keeps exactly six children.
  shell.appendChild(h('a', { class: 'skip-link', href: '#runbar' }, 'Skip to run controls'));

  shell.appendChild(buildTitleBar(a));
  shell.appendChild(buildRunBar(a));
  shell.appendChild(buildAlarmStack(a));
  shell.appendChild(buildTabStrip(a));

  const workspace = h('main', { class: 'workspace' });
  a.el.workspace = workspace;
  shell.appendChild(workspace);

  shell.appendChild(buildStatusStrip(a));

  const narrow = h('div', { class: 'shell-narrow-note' },
    'Best viewed at 1280 px or wider. Everything still works here; the Run view stacks.');
  narrow.hidden = true;
  a.el.narrowNote = narrow;
  shell.appendChild(narrow);

  const perf = h('div', { class: 'perf-overlay', role: 'status', 'aria-label': 'Performance' });
  perf.hidden = true;
  a.el.perf = perf;
  shell.appendChild(perf);

  a.root.appendChild(shell);

  // One host for the whole app (§6.33). It is handed the mount root, because that is the subtree
  // it marks `inert` + `aria-hidden` while a modal is up; its own layer goes on <body>.
  a.overlayHost = overlay.createOverlayHost(a.root);

  // Publish it on ctx BEFORE mountViews() runs. Every view resolves its host as
  // `ctx.overlayHost || ctx.overlay || createOverlayHost(...)`, so without this line each of the
  // four views builds a host of its own — four .ov-root layers, four Esc handlers and four focus
  // traps competing over one modal stack. overlay.js requires exactly one host per document.
  a.ctx.overlayHost = a.overlayHost;
}

/**
 * The 44 px title bar: product identity, the active preset, the `SIMULATED` honesty chip, and the
 * global entry points.
 * @param {object} a the application instance
 * @returns {Element} the title bar
 */
function buildTitleBar(a) {
  const bar = h('header', { class: 'titlebar' });

  bar.appendChild(h('span', { class: 'titlebar__title' }, 'Process Skid Simulator'));
  const sub = h('span', { class: 'titlebar__sub' }, '');
  a.el.presetName = sub;
  bar.appendChild(sub);

  // The physics-honesty chip of §9.6: a real button, so the assumptions are keyboard-reachable.
  const simChip = button('chip chip--sim', 'SIMULATED', (e) => {
    overlay.showPopover(a.overlayHost, {
      anchorEl: /** @type {Element} */ (e.currentTarget),
      content: honestyContent(a),
      placement: 'bottom',
      maxWidth: 340,
    });
  }, { title: 'What this model does, and what it deliberately does not' });
  bar.appendChild(simChip);

  bar.appendChild(h('span', { class: 'titlebar__spacer' }));

  const actions = h('div', { class: 'titlebar__actions' });
  actions.appendChild(button('btn btn--ghost', 'Scenarios', () => {
    if (a.onboarding) onboarding.showScenarioPicker(a.onboarding);
  }, { title: 'Load one of the eight teaching scenarios — each starts in one click' }));
  actions.appendChild(button('btn btn--ghost', 'Help', () => showHelp(a), {
    title: 'The tour, the glossary and the shortcuts',
  }));
  actions.appendChild(button('btn btn--icon', '?', () => {
    overlay.showCheatSheet(a.overlayHost, KEYMAP);
  }, { title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts' }));

  const themeBtn = button('btn btn--icon', '◐', () => toggleTheme(a), {
    'aria-label': 'Toggle the light and dark theme',
    'aria-pressed': 'false',
  });
  a.el.themeBtn = themeBtn;
  actions.appendChild(themeBtn);

  bar.appendChild(actions);
  return bar;
}

/**
 * The 56 px run control bar of §9.4.3, left to right: state · transport · E-stop · speed ·
 * progress · mode. The E-stop and the mode chip are DIRECT children of `.runbar`, which is how
 * `styles/app.css` fixes the E-stop's x and pushes the mode chip to the right edge.
 * @param {object} a the application instance
 * @returns {Element} the run bar
 */
function buildRunBar(a) {
  const bar = h('div', {
    class: 'runbar', id: 'runbar', role: 'toolbar', 'aria-label': 'Run controls', tabindex: '-1',
  });

  // 1 — state pill + method name + block name/index
  const g1 = h('div', { class: 'runbar__group' });
  const pill = h('span', {
    class: 'pill pill--lg pill--neutral', role: 'status', 'aria-live': 'polite',
  }, 'IDLE');
  a.el.statePill = pill;
  g1.appendChild(pill);
  const stack = h('div', { class: 'runbar__stack' });
  const methodName = h('span', { class: 'runbar__label' }, '');
  const blockName = h('span', { class: 'runbar__value' }, '');
  a.el.methodName = methodName;
  a.el.blockName = blockName;
  stack.appendChild(methodName);
  stack.appendChild(blockName);
  g1.appendChild(stack);
  bar.appendChild(g1);

  // 2 — transport
  const g2 = h('div', { class: 'runbar__group', 'data-tour': 'run-controls' });
  a.el.startBtn = button('btn btn--primary', 'Start', () => doStartOrContinue(a), {});
  a.el.holdBtn = button('btn btn--ghost', 'Hold', () => act(a, () => sim.hold(a.ctx)), {});
  a.el.skipBtn = buildSkipButton(a);
  a.el.endBtn = button('btn btn--ghost', 'End',
    (e) => openEndPopover(a, /** @type {Element} */ (e.currentTarget)),
    { 'aria-haspopup': 'dialog' });
  a.el.resetBtn = button('btn btn--ghost', 'Reset', () => act(a, () => sim.reset(a.ctx)), {});
  a.el.resetBtn.hidden = true;
  g2.appendChild(a.el.startBtn);
  g2.appendChild(a.el.holdBtn);
  g2.appendChild(a.el.skipBtn);
  g2.appendChild(a.el.endBtn);
  g2.appendChild(a.el.resetBtn);
  bar.appendChild(g2);

  // 3 — emergency stop, behind a rule and a gap so it never sits beside a benign control
  bar.appendChild(h('span', { class: 'runbar__rule', role: 'separator', 'aria-orientation': 'vertical' }));
  a.el.estopBtn = button('btn btn--danger btn--estop', 'E-STOP', () => act(a, () => sim.estop(a.ctx)), {
    title: 'Emergency stop — acts immediately, no undo (Shift+Esc twice within 1 s)',
    'aria-label': 'Emergency stop',
  });
  bar.appendChild(a.el.estopBtn);
  bar.appendChild(h('span', { class: 'runbar__rule', role: 'separator', 'aria-orientation': 'vertical' }));

  // 4 — sim speed
  const g4 = h('div', { class: 'runbar__group', 'data-tour': 'speed' });
  g4.appendChild(h('span', { class: 'runbar__label', id: 'speed-caption' }, 'Sim speed'));
  const seg = h('div', {
    class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'speed-caption',
  });
  a.el.speedSeg = seg;
  a.el.speedOpts = [];
  buildSpeedOptions(a);
  g4.appendChild(seg);
  a.el.pauseBtn = button('btn btn--icon', '❚❚', () => togglePause(a), {
    'aria-pressed': 'false', 'aria-label': 'Pause the simulation',
  });
  g4.appendChild(a.el.pauseBtn);
  const note = h('span', { class: 'runbar__speed-note' }, '');
  a.el.speedNote = note;
  g4.appendChild(note);
  bar.appendChild(g4);

  // 5 — progress
  const g5 = h('div', { class: 'runbar__group' });
  const counters = h('span', { class: 'runbar__value num' }, '');
  a.el.counters = counters;
  g5.appendChild(counters);
  const track = h('div', {
    class: 'runbar__progress', role: 'progressbar',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
    'aria-label': 'Method progress',
  });
  const fill = h('span', { class: 'runbar__progress-fill' });
  a.el.progressTrack = track;
  a.el.progressFill = fill;
  track.appendChild(fill);
  g5.appendChild(track);
  bar.appendChild(g5);

  // 6 — mode chip, a direct child of .runbar, and the manual-control toggle of §9.4.4
  const mode = button('pill pill--neutral', 'METHOD', () => toggleManual(a), {
    title: 'METHOD: the engine drives the skid. MANUAL: you do — available in IDLE, READY, HELD and PAUSED.',
    'aria-pressed': 'false',
  });
  a.el.modeChip = mode;
  bar.appendChild(mode);

  return bar;
}

/**
 * (Re)build the speed segmented control from `config.sim.speedOptions`, which a different preset
 * may change.
 * @param {object} a the application instance
 * @returns {void}
 */
function buildSpeedOptions(a) {
  const seg = a.el.speedSeg;
  while (seg.firstChild) seg.removeChild(seg.firstChild);
  a.el.speedOpts = [];
  for (const s of a.ctx.config.sim.speedOptions) {
    const opt = button('segmented__opt', `${s}×`, () => act(a, () => sim.setSpeed(a.ctx, s)), {
      role: 'radio', 'aria-checked': 'false', title: `Run the simulation at ${s}× real time`,
    });
    opt.dataset.speed = String(s);
    a.el.speedOpts.push(opt);
    seg.appendChild(opt);
  }
}

/**
 * The Skip Block control: a 400 ms press-and-hold with a filling progress ring (§9.4.3), so a
 * fat-fingered click cannot throw away the rest of a block.
 *
 * The ring is advanced by the shell's own frame pass — no panel starts a second rAF loop.
 *
 * @param {object} a the application instance
 * @returns {HTMLButtonElement} the skip button
 */
function buildSkipButton(a) {
  const btn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'btn btn--ghost', type: 'button',
    title: 'Skip the current block — press and hold for 400 ms (N)',
  }, 'Skip block'));

  const circumference = 2 * Math.PI * RING_R;
  const arc = fmt.hSvg('circle', {
    class: 'holdring__fill',
    cx: '12', cy: '12', r: String(RING_R), fill: 'none',
    transform: `rotate(-90 12 12)`,
    'stroke-dasharray': String(circumference),
    'stroke-dashoffset': String(circumference),
  });
  btn.appendChild(fmt.hSvg('svg', {
    class: 'holdring', viewBox: '0 0 24 24', width: '18', height: '18', 'aria-hidden': 'true',
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
  // gets the same confirm dialog the `N` shortcut opens. Both paths are deliberate; neither is a
  // single unguarded click.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmSkip(a); }
  });
  return btn;
}

/**
 * The alarm banner stack of §9.1.1 with the two live regions of §9.7. The shell's error bar lives
 * in this band too, rather than adding a seventh row to the grid.
 * @param {object} a the application instance
 * @returns {Element} the alarm stack container
 */
function buildAlarmStack(a) {
  const wrap = h('div', { class: 'alarm-stack', role: 'region', 'aria-label': 'Alarms' });
  const assertive = h('div', {
    class: 'sr-only', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true',
  });
  const polite = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const errors = h('div', {});
  const list = h('div', { class: 'alarm-stack__list' });
  a.el.alarmAssertive = assertive;
  a.el.alarmPolite = polite;
  a.el.errorSlot = errors;
  a.el.alarmList = list;
  wrap.appendChild(assertive);
  wrap.appendChild(polite);
  wrap.appendChild(errors);
  wrap.appendChild(list);
  return wrap;
}

/**
 * The 36 px tab strip: a real `role="tablist"` with arrow-key navigation (§9.7).
 * @param {object} a the application instance
 * @returns {Element} the tab strip
 */
function buildTabStrip(a) {
  const strip = h('nav', { class: 'tabstrip', role: 'tablist', 'aria-label': 'Workspace views' });
  a.el.tabs = new Map();
  for (const tab of TABS) {
    const on = tab.id === a.activeTab;
    const btn = button(`tab${on ? ' is-active' : ''}`, tab.label, () => setTab(a, tab.id), {
      role: 'tab',
      id: `tab-${tab.id}`,
      'aria-controls': `view-${tab.id}`,
      'aria-selected': on ? 'true' : 'false',
      tabindex: on ? '0' : '-1',
      title: `${tab.label} (${tab.key})`,
    });
    if (tab.id === 'method') fmt.setAttr(btn, 'data-tour', 'tab-method');
    btn.addEventListener('keydown', (e) => onTabKey(a, e, tab.id));
    a.el.tabs.set(tab.id, btn);
    strip.appendChild(btn);
  }
  return strip;
}

/**
 * Arrow-key navigation for the tab strip (§9.7).
 * @param {object} a the application instance
 * @param {KeyboardEvent} e the key event
 * @param {string} tabId the tab the key landed on
 * @returns {void}
 */
function onTabKey(a, e, tabId) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const i = TABS.findIndex((t) => t.id === tabId);
  let j;
  if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
  else if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
  else if (e.key === 'Home') j = 0;
  else j = TABS.length - 1;
  setTab(a, TABS[j].id);
  const next = a.el.tabs.get(TABS[j].id);
  if (next) next.focus();
}

/**
 * The 28 px status strip — the redundant copy of process state that survives a tab switch (§9.1.1).
 * Every chip is a real button, so the glossary behind it is keyboard-reachable.
 * @param {object} a the application instance
 * @returns {Element} the status strip
 */
function buildStatusStrip(a) {
  const strip = h('footer', {
    class: 'statusstrip', 'aria-label': 'Live process values', 'data-tour': 'status',
  });
  a.el.stat = {};
  for (const spec of STATUS_CHIPS) {
    const chip = /** @type {HTMLButtonElement} */ (h('button', {
      class: 'statchip', type: 'button',
      title: `${spec.label} — press for what this is and what abnormal looks like`,
    },
    h('span', { class: 'statchip__label' }, spec.label),
    h('span', { class: 'statchip__value' }, fmt.NO_VALUE)));
    chip.addEventListener('click', () => {
      if (spec.key === 'quality') showQualityPopover(a, chip);
      else showGlossary(a, chip, spec.gloss);
    });
    a.el.stat[spec.key] = {
      chip,
      value: chip.querySelector('.statchip__value'),
      sensor: spec.sensor,
    };
    strip.appendChild(chip);
  }
  return strip;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ACTIONS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Run a `core/sim.js` action and surface its refusal. Every action returns `{ ok, reason? }`, and a
 * refusal is ALWAYS shown: a silent refusal teaches nothing and gets worked around (§9.4.4).
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
 * than a one-line toast, because all twelve checks report at once (§5.5.1).
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
 * Render the pre-run check failures as a modal list, blocking failures first.
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
 * The End confirm popover: end now, or end after the current block (§9.4.3).
 * @param {object} a the application instance
 * @param {Element} anchorEl the End button
 * @returns {void}
 */
function openEndPopover(a, anchorEl) {
  const box = h('div', {});
  box.appendChild(h('p', {}, 'End the run:'));
  let handle = null;
  const after = button('btn btn--ghost btn--sm', 'After this block', () => {
    overlay.dismiss(handle); act(a, () => sim.end(a.ctx, 'AFTER_BLOCK'));
  });
  const now = button('btn btn--danger btn--sm', 'End now', () => {
    overlay.dismiss(handle); act(a, () => sim.end(a.ctx, 'NOW'));
  });
  box.appendChild(h('div', { class: 'btn-row' }, after, now));
  handle = overlay.showPopover(a.overlayHost, {
    anchorEl, content: box, placement: 'bottom', maxWidth: 280,
  });
}

/**
 * The keyboard path to Skip Block: a confirm dialog where `Enter` confirms (§9.5).
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
 * Pause / resume the process. `Pause` ramps flow to zero; resuming returns to RUNNING (§5.5).
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
 * by the toast (§9.4.4).
 * @param {object} a the application instance
 * @returns {void}
 */
function toggleManual(a) {
  act(a, () => sim.setManualOverride(a.ctx, !a.ctx.run.manualOverride));
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
 * Export the loaded method as JSON (`Ctrl+S`). The run's data exports live on the Results tab,
 * which owns the analytics they carry; the method is shell-scoped because it is editable on the
 * Method tab and worth saving from anywhere.
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
 * Open a file picker and install the chosen method JSON through `sim.loadMethod` (`Ctrl+O`, §9.5).
 * The shell owns this shortcut rather than the Method view so it works from any tab.
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
 * TABS, THEME, HELP
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Switch the visible tab. Only the visible view's `update()` runs, so a hidden tab costs nothing.
 * @param {object} a the application instance
 * @param {string} tabId one of `run` | `method` | `results` | `system`
 * @returns {void}
 */
function setTab(a, tabId) {
  if (!a.views.has(tabId) || a.activeTab === tabId) return;
  a.activeTab = tabId;
  for (const tab of TABS) {
    const entry = a.views.get(tab.id);
    const btn = a.el.tabs.get(tab.id);
    const on = tab.id === tabId;
    entry.host.hidden = !on;
    fmt.cls(btn, 'is-active', on);
    fmt.setAttr(btn, 'aria-selected', on ? 'true' : 'false');
    fmt.setAttr(btn, 'tabindex', on ? '0' : '-1');
  }
  // A newly revealed view has missed every frame since it was hidden: give it a structural pass.
  a.structural = true;
  a.ctx.bus.emit('tab-changed', tabId);
}

/**
 * Flip between the dark and light themes and tell every canvas painter to re-read its tokens.
 * `index.html` stamps an explicit `data-theme` before first paint, so there is no third state to
 * carry here; reading CSS custom properties per frame is a layout-thrash trap (§6.25).
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
  a.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', a.theme);
  if (a.el.themeBtn) {
    fmt.setAttr(a.el.themeBtn, 'aria-pressed', a.theme === 'light' ? 'true' : 'false');
    fmt.setAttr(a.el.themeBtn, 'title',
      a.theme === 'light' ? 'Light theme — switch to dark' : 'Dark theme — switch to light');
    fmt.setText(a.el.themeBtn, a.theme === 'light' ? '◑' : '◐');
  }
  try {
    fmt.invalidateThemeTokens();
  } catch (_err) { /* the token cache is an optimisation; failing to clear it is not fatal */ }
  if (announce) a.ctx.bus.emit('theme-changed', a.theme);
}

/**
 * Open the glossary popover for a tag or parameter id (§9.6). A missing entry renders NO info
 * affordance — `glossaryFor` returning null is a contract, not an error (§6.22.1).
 * @param {object} a the application instance
 * @param {Element} anchorEl the element the popover points at
 * @param {string} id a P&ID tag, config path, concept id or alias
 * @returns {void}
 */
function showGlossary(a, anchorEl, id) {
  const entry = glossaryFor(id);
  if (!entry) return;
  overlay.showGlossaryPopover(a.overlayHost, {
    anchorEl,
    entry,
    placement: 'top',
    onSeeAlso: (nextId) => showGlossary(a, anchorEl, nextId),
  });
}

/**
 * The status strip's Quality chip popover: every `run.qualityFlags` bit currently set (§5.3), and
 * the per-sensor verdict behind them.
 * @param {object} a the application instance
 * @param {Element} anchorEl the chip
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
 * The `SIMULATED` chip's popover: what the model does, and what it deliberately does not (§9.6).
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
      + 'every concept the simulator models. The same text is behind the ⓘ on any label on screen.'),
    h('div', { class: 'numfield' }, search),
    list,
    detail);
  render('');

  overlay.showModal(a.overlayHost, {
    title: 'Help and glossary',
    content: body,
    dismissible: true,
    actions: [
      {
        label: 'Take the tour',
        variant: 'ghost',
        onClick: (hd) => {
          overlay.dismiss(hd);
          if (a.onboarding) onboarding.startTour(a.onboarding);
        },
      },
      {
        label: 'Keyboard shortcuts',
        variant: 'ghost',
        onClick: (hd) => { overlay.dismiss(hd); overlay.showCheatSheet(a.overlayHost, KEYMAP); },
      },
      {
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
      },
      { label: 'Close', variant: 'primary', onClick: (hd) => overlay.dismiss(hd) },
    ],
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
 * `config-replaced`, and the startup benchmark is re-run on `preset-loaded` (§6.32).
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
    if (a.el.speedOpts.length !== a.ctx.config.sim.speedOptions.length) buildSpeedOptions(a);
  };
  bus.on('config-replaced', invalidate);
  bus.on('run-reset', invalidate);
  bus.on('preset-loaded', () => {
    invalidate();
    runStartupBenchmark(a);
    invalidate();
  });
  bus.on('scenario-applied', () => setTab(a, 'run'));
  bus.on('run-ended', () => { a.structural = true; });
  bus.on('request-tab', (tabId) => setTab(a, tabId));
  bus.on('show-glossary', (payload) => {
    if (payload && payload.anchorEl && payload.id) showGlossary(a, payload.anchorEl, payload.id);
  });
  bus.on('display-units-changed', () => { a.structural = true; });
}

/**
 * Install the one document-level key handler. Shell actions execute here; view actions go out on
 * the bus as `('key-action', { action, combo, event })`, so no second listener is ever needed.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireKeyboard(a) {
  document.addEventListener('keydown', (e) => {
    // A control that already consumed the key (the tab strip's arrows, a numfield's stepper, an
    // open dialog) wins: the global registry never double-handles.
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
 * @param {string} combo the normalised combo, forwarded to the views
 * @returns {boolean} true when the event was consumed and should be prevented
 */
function handleKeyAction(a, action, e, combo) {
  const run = a.ctx.run;
  if (action.startsWith('tab:')) { setTab(a, action.slice(4)); return true; }
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
    case 'end-run': openEndPopover(a, a.el.endBtn); return true;
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
      // Chart, legend and pooling live in the views; they own these.
      a.ctx.bus.emit('key-action', { action, combo, event: e });
      return true;
  }
}

/**
 * Show the "best viewed wider" note below 720 px, without ever reading layout in a frame (§9.1.3).
 * @param {object} a the application instance
 * @returns {void}
 */
function wireResponsiveNote(a) {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(max-width: 719.98px)');
  const apply = () => { a.el.narrowNote.hidden = !mq.matches; };
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply);
  apply();
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FRAME LOOP — the ONLY requestAnimationFrame in the program (§3.1)
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One animation frame: advance the physics by the real elapsed time, then render the visible view.
 *
 * Rendering is decoupled from the fixed-timestep sim: `sim.advanceWall` runs whole 0.05 s ticks and
 * drops any debt it cannot pay, reporting the shortfall through `run.speedDeficit`. Both halves are
 * guarded — a throwing panel is reported and, after three consecutive failures, taken out of the
 * loop, but the loop itself never stops.
 *
 * `document.hidden` pauses RENDERING only; the simulation keeps running, and the 0.25 s wall clamp
 * inside `advanceWall` stops a backgrounded tab from fast-forwarding (§6.32).
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
    const entry = a.views.get(a.activeTab);
    if (entry && entry.panel && !entry.disabled) {
      try {
        entry.panel.update(info);
        entry.failCount = 0;
      } catch (err) {
        entry.failCount++;
        reportError(a, `${a.activeTab} view`, err);
        if (entry.failCount >= VIEW_FAIL_LIMIT) {
          entry.disabled = true;
          toast(a, `The ${a.activeTab} view was disabled after ${VIEW_FAIL_LIMIT} errors. `
            + 'Switch tabs and back to retry.', 'blocked');
        }
      }
    }
    if (a.onboarding) {
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
 * and raise the `structural` flag when list content changed (§6.24).
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
 * SHELL RENDER — text and attributes onto cached nodes; no innerHTML, no layout reads
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Repaint the persistent chrome from the current `run`. Called once per visible frame.
 *
 * `refreshAlarms` runs every frame but early-outs on an unchanged id signature, so the banner DOM
 * is rebuilt only when the active set changes; `structural` forces that comparison to be redone
 * after a `config-replaced`, when the whole alarm table may have been swapped.
 *
 * @param {object} a the application instance
 * @param {boolean} structural true when list content may have changed
 * @returns {void}
 */
function refreshShell(a, structural) {
  const { config, run } = a.ctx;
  if (structural) a.alarmSig = null;
  refreshRunBar(a, config, run);
  refreshStatusStrip(a, config, run);
  refreshAlarms(a, config, run);
  if (a.skipHold.active) advanceSkipHold(a);
}

/**
 * Repaint the run control bar (§9.4.3).
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshRunBar(a, config, run) {
  const el = a.el;
  const st = run.state;

  // 1 — state, method, block
  const pillClass = `pill pill--lg pill--${stateTone(st)}`;
  if (el.statePill.className !== pillClass) el.statePill.className = pillClass;
  fmt.setText(el.statePill, st);
  fmt.setAttr(el.statePill, 'title', stateExplanation(st));

  fmt.setText(el.presetName, config.name || config.presetId);
  fmt.setText(el.methodName, (config.method && config.method.name) || 'No method');

  const blocks = config.method ? config.method.blocks : null;
  if (blocks && blocks.length > 0) {
    const i = Math.max(0, Math.min(blocks.length - 1, run.blockIndex));
    const b = blocks[i];
    const prog = blockProgress(config, run);
    const pct = Number.isFinite(prog.fraction) ? Math.round(prog.fraction * 100) : 0;
    fmt.setText(el.blockName, `${i + 1}/${blocks.length} · ${b.name || b.id} · ${pct}%`);
    fmt.setAttr(el.blockName, 'title', `Block ${b.id} (${b.type}) — ${pct}% delivered, `
      + `${fmt.fmtVolume(prog.remaining_mL, config)} remaining`);
  } else {
    fmt.setText(el.blockName, '—');
  }

  // 2 — transport
  const held = st === 'HELD' || st === 'PAUSED';
  fmt.setText(el.startBtn, held ? 'Continue' : 'Start');
  setEnabled(el.startBtn, st === 'IDLE' || st === 'READY' || held,
    `Cannot start from ${st}.`,
    held ? 'Return to RUNNING (C)' : 'Run the pre-run checks and start (Space)');
  setEnabled(el.holdBtn, st === 'RUNNING',
    `Hold is only available while RUNNING (state is ${st}).`,
    'Freeze the method; flow stays at setpoint (H)');
  setEnabled(el.skipBtn, st === 'RUNNING' || st === 'HELD',
    `A block can only be skipped while RUNNING or HELD (state is ${st}).`,
    'Skip the current block — press and hold for 400 ms (N)');
  setEnabled(el.endBtn, st === 'RUNNING' || st === 'HELD' || st === 'PAUSED' || st === 'ALARM',
    `Cannot end from ${st}.`, 'End now, or after the current block (E)');

  // At run end the bar collapses to Reset: replay and scrubbing are D26b, so there is no transport
  // bar and no post-run cursor. The Results tab is the only post-run surface.
  const resettable = st === 'ENDED' || st === 'FAULT' || st === 'READY';
  el.resetBtn.hidden = !resettable;
  setEnabled(el.resetBtn, resettable,
    `Reset is available from READY, ENDED and FAULT (state is ${st}).`,
    'Return to IDLE and rebuild the fluid path');

  // 4 — speed
  for (const opt of el.speedOpts) {
    const on = Number(opt.dataset.speed) === run.speed;
    fmt.cls(opt, 'is-selected', on);
    fmt.setAttr(opt, 'aria-checked', on ? 'true' : 'false');
  }
  const paused = st === 'PAUSED' || st === 'HELD';
  fmt.setText(el.pauseBtn, paused ? '▶' : '❚❚');
  fmt.setAttr(el.pauseBtn, 'aria-pressed', paused ? 'true' : 'false');
  fmt.setAttr(el.pauseBtn, 'aria-label', paused ? 'Resume the simulation' : 'Pause the simulation');
  setEnabled(el.pauseBtn, st === 'RUNNING' || paused,
    `Nothing is running to pause (state is ${st}).`,
    paused ? 'Return to RUNNING (P)' : 'Ramp flow to zero and freeze the clock (P)');

  // The honesty readout — never claim a speed the machine is not delivering (§2.1.1, §9.4.3).
  if (run.speedDeficit > 1.01 && st === 'RUNNING') {
    fmt.setText(el.speedNote, `${run.speed}× (limited to ${formatSpeed(run.speed / run.speedDeficit)}×)`);
    fmt.setAttr(el.speedNote, 'title',
      'This machine cannot keep up with the requested speed. Effective speed is '
      + 'run.speed / run.speedDeficit; a coarser column grid buys it back.');
    fmt.cls(el.speedNote, 'is-limited', true);
  } else {
    fmt.setText(el.speedNote, `${run.speed}×`);
    fmt.setAttr(el.speedNote, 'title', 'Simulated seconds per real second');
    fmt.cls(el.speedNote, 'is-limited', false);
  }

  // 5 — progress
  fmt.setText(el.counters,
    `${fmt.fmtVolume(run.V_tot_mL, config)} · ${fmt.fmtCV(run.V_tot_mL, config)} · ${fmt.fmtClock(run.t_s)}`);
  const pct = Math.round(methodFraction(a, config, run) * 100);
  if (a.progressPct !== pct) {                 // a style write per frame is a style invalidation
    a.progressPct = pct;
    el.progressFill.style.width = `${pct}%`;
    fmt.setAttr(el.progressTrack, 'aria-valuenow', String(pct));
    fmt.setAttr(el.progressTrack, 'aria-valuetext',
      `${pct}% of the method, ${(run.V_tot_mL / config.column.V_mL).toFixed(2)} column volumes delivered`);
  }

  // 6 — mode chip, and the amber P&ID outline `.shell.is-manual` draws (§9.4.4)
  const manual = !!run.manualOverride;
  fmt.setText(el.modeChip, manual ? 'MANUAL' : 'METHOD');
  const modeClass = `pill ${manual ? 'pill--warn' : 'pill--neutral'}`;
  if (el.modeChip.className !== modeClass) el.modeChip.className = modeClass;
  fmt.setAttr(el.modeChip, 'aria-pressed', manual ? 'true' : 'false');
  fmt.cls(el.shell, 'is-manual', manual);
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
 * Overall method progress as a fraction, weighted by block VOLUME so the run bar's thin bar agrees
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
 * Repaint the status strip. Each chip carries its sensor's `sensorQuality` verdict as a class, and
 * `styles/app.css` renders that as colour; the Quality chip states the verdict in words, so the
 * information is never colour alone (§5.3, §9.7).
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshStatusStrip(a, config, run) {
  const s = a.el.stat;
  fmt.setText(s.p1.value, fmt.fmtPressure(run.press.P1disp_bar));
  fmt.setText(s.dp.value, fmt.fmtPressure(run.press.P1disp_bar - run.press.P2disp_bar));
  fmt.setText(s.flow.value, fmt.fmtFlow(run.Q_actual_mLs, config));
  fmt.setText(s.pctb.value, fmt.fmtPct(run.pctB_colInlet));
  fmt.setText(s.uv.value, fmt.fmtAbs(run.uv.Afilt[0]));
  fmt.setText(s.cond.value, fmt.fmtCond(run.cond.kappaDisp_mScm));
  fmt.setText(s.ph.value, fmt.fmtPH(run.ph.pHfilt));
  fmt.setText(s.cv.value, fmt.fmtCV(run.V_tot_mL, config));
  fmt.setText(s.clock.value, fmt.fmtClock(run.t_s));

  let worst = 'OK';
  for (const spec of STATUS_CHIPS) {
    if (!spec.sensor) continue;
    const q = sensorQuality(run, spec.sensor);
    applyQualityClass(s[spec.key].chip, q);
    if (q !== 'OK' && worst === 'OK') worst = q;
    else if (q === 'INVALID') worst = 'INVALID';
  }
  // Flow has no sensor of its own, but an automatic flow reduction means the number on screen is
  // not the number the method asked for, and that must be visible.
  applyQualityClass(s.flow.chip, (run.qualityFlags & QF.FLOW_REDUCED) !== 0 ? 'SUSPECT' : 'OK');

  let nFlags = 0;
  const names = [];
  for (const [bit, label] of QF_LABELS) {
    if ((run.qualityFlags & bit) === 0) continue;
    nFlags++;
    names.push(label);
  }
  fmt.setText(s.quality.value, nFlags === 0 ? 'OK' : `${worst} · ${nFlags}`);
  applyQualityClass(s.quality.chip, worst);
  fmt.setAttr(s.quality.chip, 'title', nFlags === 0
    ? 'Every sensor is reporting normally. Press for the per-sensor verdicts.'
    : `${nFlags} quality flag${nFlags === 1 ? '' : 's'} set: ${names.join(' · ')}`);
}

/**
 * Map a `sensorQuality` verdict onto the status chip's state classes.
 * @param {Element} chip the chip element
 * @param {'OK'|'SUSPECT'|'INVALID'|'BYPASSED'} q the verdict
 * @returns {void}
 */
function applyQualityClass(chip, q) {
  fmt.cls(chip, 'is-warn', q === 'SUSPECT');
  fmt.cls(chip, 'is-invalid', q === 'INVALID');
  fmt.cls(chip, 'is-off', q === 'BYPASSED');
}

/**
 * Rebuild the alarm banner stack when the active set changes, and keep the two live regions honest.
 *
 * Only the newest alarm's text is placed in a live region, rebuilt rather than appended, so a
 * screen reader announces once (§9.7).
 *
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshAlarms(a, config, run) {
  const defs = config.alarms || [];
  const active = [];
  for (let i = 0; i < defs.length; i++) {
    const shown = run.alarmActive[i] === 1 || (run.alarmLatched[i] === 1 && run.alarmAcked[i] !== 1);
    if (!shown) continue;
    if (a.silenced.has(defs[i].id)) continue;
    active.push(defs[i]);
  }
  active.sort((x, y) => (SEVERITY_RANK[y.severity] || 0) - (SEVERITY_RANK[x.severity] || 0));

  const sig = active.map((d) => d.id).join('|');
  if (sig === a.alarmSig) return;
  a.alarmSig = sig;

  const list = a.el.alarmList;
  while (list.firstChild) list.removeChild(list.firstChild);
  for (const def of active.slice(0, MAX_BANNERS)) list.appendChild(buildBanner(a, def, active.length));

  const extra = active.length - MAX_BANNERS;
  if (extra > 0) {
    list.appendChild(button('btn btn--ghost btn--sm',
      `+${extra} more active alarm${extra === 1 ? '' : 's'} — open the System tab`,
      () => setTab(a, 'system')));
  }

  const top = active[0];
  const topId = top ? top.id : '';
  if (topId !== a.liveAlarmId) {
    a.liveAlarmId = topId;
    const text = top ? `${top.severity}: ${top.name}` : '';
    const rank = top ? (SEVERITY_RANK[top.severity] || 0) : 0;
    fmt.setText(a.el.alarmAssertive, rank >= SEVERITY_RANK.CRITICAL ? text : '');
    fmt.setText(a.el.alarmPolite, rank > 0 && rank < SEVERITY_RANK.CRITICAL ? text : '');
  }
}

/**
 * Build one alarm banner (§9.4.2): colour bar, glyph, severity word, message, detail, Ack, Silence
 * and the glossary affordance.
 * @param {object} a the application instance
 * @param {object} def the `AlarmDef` row from `config.alarms`
 * @param {number} total how many alarms are active in total
 * @returns {Element} the banner
 */
function buildBanner(a, def, total) {
  const sev = def.severity || 'WARN';
  const banner = h('div', { class: `banner banner--${sev.toLowerCase()}` });
  banner.appendChild(h('span', { class: 'banner__bar', 'aria-hidden': 'true' }));
  banner.appendChild(h('span', { class: 'banner__icon', 'aria-hidden': 'true' },
    SEVERITY_GLYPH[sev] || '!'));

  banner.appendChild(h('div', { class: 'banner__text' },
    h('span', { class: 'banner__sev' }, sev),
    h('span', { class: 'banner__msg' }, def.name),
    h('span', { class: 'banner__detail' }, describeAlarm(def))));

  const actions = h('div', { class: 'banner__actions' });
  if (def.ackRequired || def.latching) {
    actions.appendChild(button('btn btn--ghost btn--sm', 'Ack', () => {
      act(a, () => sim.acknowledgeAlarm(a.ctx, def.id));
      a.alarmSig = null;
    }, { 'aria-label': `Acknowledge ${def.name}` }));
  }
  actions.appendChild(button('btn btn--ghost btn--sm', 'Silence', () => {
    a.silenced.add(def.id);
    a.alarmSig = null;
    toast(a, `${def.id} hidden from the banner. It is still active and still in the event log.`, 'info');
  }, {
    'aria-label': `Silence the banner for ${def.name}`,
    title: 'Hide this banner for the session. The alarm stays active and stays logged.',
  }));
  if (glossaryFor(def.signal || 'alarm-state')) {
    const info = button('info-dot', 'i', (e) => {
      showGlossary(a, /** @type {Element} */ (e.currentTarget), def.signal || 'alarm-state');
    }, { 'aria-label': `What ${def.name} means` });
    actions.appendChild(info);
  }
  if (total > 1) actions.appendChild(h('span', { class: 'banner__count' }, String(total)));
  banner.appendChild(actions);
  return banner;
}

/**
 * One line of context under an alarm's name: what it watches, and what it will do about it.
 * @param {object} def the `AlarmDef` row
 * @returns {string} the detail line
 */
function describeAlarm(def) {
  const parts = [def.id];
  if (def.signal && def.op && typeof def.threshold === 'number') {
    parts.push(`${def.signal} ${def.op} ${def.threshold}`);
  } else if (def.evalKey) {
    parts.push(def.evalKey);
  }
  if (def.persist_s > 0) parts.push(`held ${def.persist_s} s`);
  parts.push(`action ${def.action}`);
  return parts.join(' · ');
}

/**
 * Repaint the `Ctrl+Alt+P` performance overlay (§6.32). Rows are created once and then written to,
 * so the overlay costs a handful of text assignments per frame.
 * @param {object} a the application instance
 * @returns {void}
 */
function renderPerf(a) {
  const run = a.ctx.run;
  const p = a.perf;
  const rows = [
    ['frame', `${p.frame_ms.toFixed(1)} ms · ${(1000 / Math.max(p.frame_ms, 0.001)).toFixed(0)} fps`],
    ['sim', `${p.sim_ms.toFixed(2)} ms`],
    ['render', `${p.render_ms.toFixed(2)} ms`],
    ['ticks/frame', String(p.ticks)],
    ['ticks/s', p.tps.toFixed(0)],
    ['speed', `${run.speed}× → ${formatSpeed(run.speed / Math.max(run.speedDeficit, 1e-9))}×`],
    ['speedDeficit', run.speedDeficit.toFixed(3)],
    ['ms/sim-s', run.diag.msPerSimSecond.toFixed(3)],
    ['ms/tick', run.diag.msLastTick.toFixed(3)],
    ['nSub', String(run.diag.nSubLast)],
    ['courant', run.diag.courant.toFixed(3)],
    ['active cells', String(run.diag.activeCells)],
    ['nz', String(a.ctx.config.column.nz)],
    ['boot bench', a.benchmark ? `${a.benchmark.msPerSimSecond.toFixed(2)} ms/sim-s` : 'not run'],
    ['log rows', String(run.log ? run.log.n : 0)],
  ];

  if (!a.perfRows || a.perfRows.length !== rows.length) {
    while (a.el.perf.firstChild) a.el.perf.removeChild(a.el.perf.firstChild);
    a.perfRows = rows.map(([k]) => {
      const value = h('span', { class: 'perf-overlay__v' }, '');
      a.el.perf.appendChild(h('div', { class: 'perf-overlay__row' },
        h('span', { class: 'perf-overlay__k' }, k), value));
      return value;
    });
  }
  for (let i = 0; i < rows.length; i++) fmt.setText(a.perfRows[i], rows[i][1]);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ERRORS
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
 * Surface a caught error in the chrome instead of freezing. The bar is rebuilt, not stacked, so a
 * fault that repeats every frame does not grow the DOM without bound.
 * @param {object} a the application instance
 * @param {string} source where it came from, e.g. `'run view'`
 * @param {*} err the thrown value
 * @returns {void}
 */
function reportError(a, source, err) {
  console.error(`[app] ${source} failed:`, err);
  const slot = a.el && a.el.errorSlot;
  if (!slot) return;
  while (slot.firstChild) slot.removeChild(slot.firstChild);

  const bar = h('div', { class: 'shell-error', role: 'alert' },
    h('span', { class: 'shell-error__msg' }, `${source}: ${errText(err)}`));
  const actions = h('div', { class: 'shell-error__actions' });
  actions.appendChild(button('btn btn--ghost btn--sm', 'Copy details', () => {
    const text = `${source}: ${errText(err)}\n${(err && err.stack) || ''}`;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    else console.log(text);
  }));
  actions.appendChild(button('btn btn--ghost btn--sm', 'Dismiss', () => {
    while (slot.firstChild) slot.removeChild(slot.firstChild);
  }));
  bar.appendChild(actions);
  slot.appendChild(bar);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SMALL FORMATTERS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * @param {string} st a `run.state` value
 * @returns {string} the pill tone class suffix
 */
function stateTone(st) {
  switch (st) {
    case 'RUNNING': return 'ok';
    case 'READY': return 'info';
    case 'ENDED': return 'info';
    case 'HELD': return 'warn';
    case 'PAUSED': return 'warn';
    case 'ALARM': return 'alarm';
    case 'FAULT': return 'alarm';
    default: return 'neutral';
  }
}

/**
 * One sentence explaining what a run state permits — the pill's tooltip (§5.5).
 * @param {string} st a `run.state` value
 * @returns {string} the explanation
 */
function stateExplanation(st) {
  switch (st) {
    case 'IDLE': return 'Idle — pumps at zero. Start runs the twelve pre-run checks first.';
    case 'READY': return 'Ready — the pre-run checks passed. Start begins the method.';
    case 'RUNNING': return 'Running — the method engine is driving the skid.';
    case 'HELD': return 'Held — flow continues at setpoint; the block clock and block volume are frozen.';
    case 'PAUSED': return 'Paused — flow has ramped to zero and the clock is frozen.';
    case 'ALARM': return 'Alarm — the outlet is diverted to waste. Acknowledge, then Hold or Pause.';
    case 'ENDED': return 'Ended — the Results tab has the analysis. Reset to arm another run.';
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
