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
 *     the VISIBLE view only. Hidden tabs cost nothing.
 *   - Own the shell chrome: title bar, run control bar, alarm banner stack, tab strip, status strip,
 *     the perf overlay and the theme toggle.
 *   - Route every `sim.*` action's `{ ok, reason }` to a toast when `ok` is false — never a silent
 *     refusal (§9.4.4).
 *   - Surface `run.speedDeficit` honestly as `1000× (limited to N×)` (§2.1.1, §9.4.3).
 *
 * THE UI IS READ-ONLY OVER `run` AND `config`. Nothing in this file assigns to either; every
 * mutation goes through `core/sim.js`.
 *
 * FRAME SAFETY. `sim.advanceWall` and every panel `update()` are wrapped: one bad panel shows an
 * error bar and is disabled after three consecutive throws, but the rAF loop never dies.
 *
 * CSS CONTRACT — the class names this file emits, which `styles/app.css` must style (§9.4.2):
 *   .shell .skip-link .sr-only
 *   .titlebar .titlebar__title .titlebar__sub .titlebar__spacer .titlebar__actions
 *   .chip .chip--sim
 *   .runbar .runbar__group .runbar__rule .runbar__label .runbar__value .runbar__stack
 *   .runbar__progress .runbar__progress-fill .runbar__speed-note
 *   .pill .pill--lg .pill--ok .pill--warn .pill--alarm .pill--info .pill--neutral
 *   .btn .btn--primary .btn--ghost .btn--danger .btn--icon .btn--estop
 *   .segmented .segmented__opt (with .is-selected)
 *   .holdring .holdring__track .holdring__fill
 *   .alarm-stack .alarm-stack__list .banner .banner--info|warn|alarm|critical|fault
 *   .banner__bar .banner__icon .banner__text .banner__msg .banner__detail .banner__sev
 *   .banner__actions .banner__count
 *   .tabstrip .tab (with .is-active)
 *   .workspace .view (hidden views carry the `hidden` attribute)
 *   .statusstrip .statchip .statchip__label .statchip__value .num
 *   .perf-overlay .perf-overlay__row .perf-overlay__k .perf-overlay__v
 *   .shell-error .shell-error__msg .shell-error__actions .shell-narrow-note
 * Tour anchors this file publishes for `ui/onboarding.js`: `[data-tour="run-controls"]`,
 * `[data-tour="tab-method"]`, `[data-tour="speed"]`, `[data-tour="status"]`.
 *
 * Layer L10. Imports the sim surface, the two physics helpers the startup benchmark needs, the
 * four views, the overlay host and onboarding. It imports NOTHING from `physics/*` beyond
 * `benchmarkColumn` / `buildColumnCfg`, and reads `skid/engine.js` / `skid/method.js` for two pure
 * progress helpers only.
 */

import * as sim from '../core/sim.js';
import * as state from '../core/state.js';
import { createBus, QF } from '../core/log.js';
import * as skid from '../skid/skid.js';
import { blockProgress } from '../skid/engine.js';
import { methodDemand } from '../skid/method.js';
import * as column from '../physics/column.js';
import * as bed from '../physics/bed.js';
import * as presets from '../data/presets.js';
import { glossaryFor } from '../data/glossary.js';
import {
  exportDataCSV, exportEventsCSV, exportFractionsCSV, exportRunJSON,
  exportMethodJSON, importMethodJSON, downloadText,
} from '../io/export.js';
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

/** The default preset the shell boots into. */
const DEFAULT_PRESET_ID = 'cex-capture-igg1-pilot';

/** The four tabs of §9.1.1, in DOM and Alt+N order. */
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
 * The reference machine of §2.1.1 measures ~5 ms/sim-s at `nz = 400` (0.25 ms per 0.05 s tick),
 * so 8.0 keeps the shipped grid on a reference-class machine and downgrades on one ~1.6× slower.
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

/** Severity ladder used to rank the alarm banner stack (§5.6). */
const SEVERITY_RANK = { INFO: 0, WARN: 1, ALARM: 2, CRITICAL: 3, FAULT: 4 };

/** Glyph per severity. Severity is ALWAYS also given as text — never colour alone (§9.7). */
const SEVERITY_GLYPH = { INFO: 'i', WARN: '!', ALARM: '!!', CRITICAL: '×', FAULT: '×' };

/** Maximum banners drawn before the "+N more" counter takes over (§9.1.1). */
const MAX_BANNERS = 3;

/** Event types that change list content and therefore demand a `structural` frame (§6.24). */
const STRUCTURAL_EVENT_TYPES = {
  BLOCK_START: 1, BLOCK_END: 1, FRACTION_START: 1, FRACTION_END: 1,
  ALARM_RAISED: 1, ALARM_CLEARED: 1, ALARM_ACK: 1, RUN_START: 1, RUN_END: 1,
  STATE_CHANGE: 1, PACKING_TEST_RESULT: 1, SCENARIO_APPLIED: 1,
};

/** Human names for the `run.qualityFlags` bits (§5.3), for the status-strip quality chip. */
const QF_LABELS = [
  [QF.UV_OVERRANGE, 'UV over-range'],
  [QF.UV_SATURATED, 'UV saturated'],
  [QF.UV_LAMP_FAULT, 'UV lamp fault'],
  [QF.UV_AUTOZERO_UNSTABLE, 'Autozero unstable'],
  [QF.COND_DRY, 'Conductivity cell dry'],
  [QF.COND_TEMP_RANGE, 'Cell temperature out of range'],
  [QF.PH_FROZEN_AIR, 'pH frozen (air)'],
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
 * The global keyboard registry of §9.5.
 *
 * Keys are normalised combos (`normaliseCombo`): modifiers in the fixed order `Ctrl+Alt+Shift+`,
 * then the key name with single characters upper-cased. `Shift` is dropped for punctuation so
 * `?`, `+` and `-` are reachable on every layout.
 *
 * Shell-scoped actions are executed here. View-scoped actions (chart, legend, pooling) are emitted
 * on `ctx.bus` as `('key-action', { action, combo, event })` so whichever view owns them can react
 * without adding a second document-level key listener.
 *
 * @type {{[combo:string]: {action:string, label:string}}}
 */
export const KEYMAP = {
  'Space': { action: 'start-hold-toggle', label: 'Start / Hold toggle' },
  'H': { action: 'hold', label: 'Hold (flow continues, clock freezes)' },
  'C': { action: 'continue', label: 'Continue' },
  'N': { action: 'skip-block', label: 'Skip the current block (confirm)' },
  'E': { action: 'end-run', label: 'End the run (confirm)' },
  'Shift+Escape': { action: 'estop', label: 'Emergency stop — press twice within 1 s' },
  '1': { action: 'speed:0', label: 'Sim speed preset 1' },
  '2': { action: 'speed:1', label: 'Sim speed preset 2' },
  '3': { action: 'speed:2', label: 'Sim speed preset 3' },
  '4': { action: 'speed:3', label: 'Sim speed preset 4' },
  '5': { action: 'speed:4', label: 'Sim speed preset 5' },
  '6': { action: 'speed:5', label: 'Sim speed preset 6' },
  '7': { action: 'speed:6', label: 'Sim speed preset 7' },
  '[': { action: 'speed-down', label: 'Sim speed down one step' },
  ']': { action: 'speed-up', label: 'Sim speed up one step' },
  'Alt+1': { action: 'tab:run', label: 'Run tab' },
  'Alt+2': { action: 'tab:method', label: 'Method tab' },
  'Alt+3': { action: 'tab:results', label: 'Results tab' },
  'Alt+4': { action: 'tab:system', label: 'System tab' },
  'X': { action: 'x-axis-cycle', label: 'Cycle the chromatogram x axis' },
  'A': { action: 'autoscale', label: 'Autoscale / fit all' },
  'F': { action: 'follow-toggle', label: 'Toggle follow-live' },
  '+': { action: 'zoom-in', label: 'Zoom in about the cursor' },
  '-': { action: 'zoom-out', label: 'Zoom out about the cursor' },
  'ArrowLeft': { action: 'pan-left', label: 'Pan left (Shift for 5×)' },
  'ArrowRight': { action: 'pan-right', label: 'Pan right (Shift for 5×)' },
  'Shift+ArrowLeft': { action: 'pan-left-fast', label: 'Pan left, 5×' },
  'Shift+ArrowRight': { action: 'pan-right-fast', label: 'Pan right, 5×' },
  'M': { action: 'mark-fraction', label: 'Mark a fraction manually' },
  'Shift+P': { action: 'pool-selection', label: 'Pool the selected fraction range' },
  'L': { action: 'legend-focus', label: 'Legend channel focus mode' },
  '?': { action: 'cheat-sheet', label: 'This shortcut list' },
  'Ctrl+S': { action: 'export-method', label: 'Export the method as JSON' },
  'Ctrl+O': { action: 'import-method', label: 'Import a method from JSON' },
  'Ctrl+Alt+P': { action: 'perf-overlay', label: 'Performance overlay' },
  'Escape': { action: 'dismiss', label: 'Close a popover or dialog, cancel a drag' },
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
 * Build an element through `ui/format.js::h`, which is the app's only element factory.
 * @param {string} tag element tag name
 * @param {object} attrs attribute map; values are set with `setAttribute`
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
  if (el.disabled !== !enabled) el.disabled = !enabled;
  const t = enabled ? whenEnabled : whyDisabled;
  if (el.getAttribute('title') !== t) el.setAttribute('title', t);
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
 *   1. warm both theme-token maps, apply the initial theme, mount the shell chrome;
 *   2. build `ctx` (`normalizePreset` → `createRunState` → **`createSkid`**, which is required);
 *   3. benchmark a throwaway column, pick `nz` (downgrade only), `sim.rebuild(ctx, {column:{nz}})`;
 *   4. mount the four views, only the active one updating;
 *   4a. mount `ui/onboarding.js` — after the views (its coach marks measure them) and before the
 *       loop (its tour may auto-load `textbook-clean` at 60×);
 *   5. start the single `requestAnimationFrame` loop.
 *
 * @param {Element} rootEl the container the shell is built into; it is emptied first
 * @returns {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}}
 *   the one long-lived `ctx` of §2.4
 */
export function boot(rootEl) {
  if (app && app.rafId) cancelAnimationFrame(app.rafId);

  const presetId = presets.PRESETS[DEFAULT_PRESET_ID] ? DEFAULT_PRESET_ID
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
    theme: (config.ui && config.ui.theme) || 'auto',
    rafId: 0,
    tPrev: 0,
    structural: true,
    frameInfo: { now_ms: 0, dt_ms: 16.7, tick: 0, structural: true },
    lastEventCount: 0,
    demandCache: null,            // { config, total_mL, startById }
    alarmSig: '',
    silenced: new Set(),          // alarm ids the operator muted for this session
    liveAlarmId: '',
    skipHold: { active: false, start_ms: 0, pointerId: -1 },
    estopArm_ms: 0,
    perfOn: false,
    perf: { frame_ms: 16.7, sim_ms: 0, render_ms: 0, ticks: 0, tps: 0, tAcc: 0, nAcc: 0 },
    simFailed: false,
    error: null,
    fileInput: null,
    benchmark: null,
    narrowQuery: null,
  };

  // ---- 1. theme tokens + shell chrome --------------------------------------------------------
  warmThemeTokens();
  applyTheme(app, app.theme, false);
  buildShell(app);

  // ---- 3. startup grid benchmark (D5) --------------------------------------------------------
  runStartupBenchmark(app);

  // ---- 4. the four views ---------------------------------------------------------------------
  mountViews(app);

  // ---- 4a. onboarding ------------------------------------------------------------------------
  try {
    app.onboarding = onboarding.createOnboarding(app.el.shell, ctx, app.overlayHost);
    app.onboarding.mount();
  } catch (err) {
    reportError(app, 'onboarding', err);
  }

  // ---- bus + input wiring --------------------------------------------------------------------
  wireBus(app);
  wireKeyboard(app);
  wireResponsiveNote(app);
  document.addEventListener('visibilitychange', () => { app.tPrev = 0; });

  refreshShell(app, true);

  // ---- 5. the one rAF loop -------------------------------------------------------------------
  app.rafId = requestAnimationFrame(frame);
  return ctx;
}

/**
 * Warm both theme-token maps once at boot (§6.25). `readThemeTokens` owns the hidden probes and the
 * cache; calling it here simply pays that cost before the first paint instead of inside a frame.
 * @returns {void}
 */
function warmThemeTokens() {
  try {
    fmt.readThemeTokens('light');
    fmt.readThemeTokens('dark');
  } catch (err) {
    // A missing token map degrades colour fidelity in exported PNGs; it must never block boot.
    console.warn('readThemeTokens failed at boot:', err);
  }
}

/**
 * Time a throwaway column and pick the axial grid size, downgrading only (§2.4 D5).
 *
 * Cost scales close to `nz²` — the cell count rises linearly and the Courant-limited substep count
 * rises with it — so a measurement at the preset's own `nz` predicts every rung of the ladder.
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
        if (nz > cfg.column.nz) break;                       // downgrade only, never upgrade
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
 * Construct the four views, mount them, and hide all but the active one.
 * @param {object} a the application instance
 * @returns {void}
 */
function mountViews(a) {
  for (const tab of TABS) {
    const host = h('section', {
      class: 'view',
      id: `view-${tab.id}`,
      role: 'tabpanel',
      tabindex: '0',
      'aria-labelledby': `tab-${tab.id}`,
    });
    if (tab.id !== a.activeTab) host.setAttribute('hidden', '');
    a.el.workspace.appendChild(host);
    let panel = null;
    try {
      panel = tab.create(host, a.ctx);
      if (panel && typeof panel.mount === 'function') panel.mount();
    } catch (err) {
      panel = null;
      host.appendChild(h('div', { class: 'shell-error__msg' },
        `The ${tab.label} view failed to load: ${errText(err)}`));
      reportError(a, `${tab.id} view`, err);
    }
    a.views.set(tab.id, { panel, host, failCount: 0, disabled: !panel });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SHELL CHROME
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Build the six vertical bands of §9.1.1 and cache every node the frame loop writes to.
 * @param {object} a the application instance
 * @returns {void}
 */
function buildShell(a) {
  while (a.root.firstChild) a.root.removeChild(a.root.firstChild);

  const shell = h('div', { class: 'shell' });
  a.el.shell = shell;

  const skip = h('a', { class: 'skip-link', href: '#runbar' }, 'Skip to run controls');
  shell.appendChild(skip);

  shell.appendChild(buildTitleBar(a));
  shell.appendChild(buildRunBar(a));
  shell.appendChild(buildAlarmStack(a));
  shell.appendChild(buildTabStrip(a));

  const workspace = h('main', { class: 'workspace' });
  a.el.workspace = workspace;
  shell.appendChild(workspace);

  shell.appendChild(buildStatusStrip(a));

  const narrow = h('div', { class: 'shell-narrow-note' },
    'This HMI is designed for 1280 px and wider. Everything still works here, but the Run view stacks.');
  narrow.setAttribute('hidden', '');
  a.el.narrowNote = narrow;
  shell.appendChild(narrow);

  const perf = h('div', { class: 'perf-overlay', role: 'status', 'aria-label': 'Performance' });
  perf.setAttribute('hidden', '');
  a.el.perf = perf;
  shell.appendChild(perf);

  a.root.appendChild(shell);

  // The overlay host owns every floating surface, so it is created last and lives on the shell.
  a.overlayHost = overlay.createOverlayHost(shell);
}

/**
 * The 44 px title bar: product identity, the `SIMULATED` honesty chip, and the global entry points.
 * @param {object} a the application instance
 * @returns {Element} the title bar
 */
function buildTitleBar(a) {
  const bar = h('header', { class: 'titlebar' });

  bar.appendChild(h('span', { class: 'titlebar__title' }, 'Process Skid Simulator'));
  const sub = h('span', { class: 'titlebar__sub' }, '');
  a.el.presetName = sub;
  bar.appendChild(sub);

  const simChip = button('chip chip--sim', 'SIMULATED', (e) => {
    overlay.showPopover(a.overlayHost, {
      anchorEl: /** @type {Element} */ (e.currentTarget),
      content: honestyContent(a),
      placement: 'bottom',
      maxWidth: 320,
    });
  }, { title: 'What this model does and does not do' });
  bar.appendChild(simChip);

  bar.appendChild(h('span', { class: 'titlebar__spacer' }));

  const actions = h('div', { class: 'titlebar__actions' });
  actions.appendChild(button('btn btn--ghost', 'Scenarios', () => {
    if (a.onboarding) onboarding.showScenarioPicker(a.onboarding);
  }, { title: 'Load one of the eight teaching scenarios' }));
  actions.appendChild(button('btn btn--ghost', 'Tour', () => {
    if (a.onboarding) onboarding.startTour(a.onboarding);
  }, { title: 'Replay the 60-second tour' }));

  const hints = button('btn btn--ghost', 'Hints on', () => {
    if (!a.onboarding) return;
    a.onboarding.hintsEnabled = !a.onboarding.hintsEnabled;
    fmt.setText(hints, a.onboarding.hintsEnabled ? 'Hints on' : 'Hints off');
    fmt.cls(hints, 'is-selected', a.onboarding.hintsEnabled);
  }, { title: 'Coach hints during a run — one card per 20 s, never blocking' });
  a.el.hintsBtn = hints;
  actions.appendChild(hints);

  actions.appendChild(button('btn btn--icon', '?', () => {
    overlay.showCheatSheet(a.overlayHost, KEYMAP);
  }, { title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts' }));

  const themeBtn = button('btn btn--icon', 'A', () => cycleTheme(a), {
    'aria-label': 'Colour theme',
  });
  a.el.themeBtn = themeBtn;
  actions.appendChild(themeBtn);

  bar.appendChild(actions);
  return bar;
}

/**
 * The 56 px run control bar of §9.4.3, left to right: state, transport, E-stop, speed, progress,
 * mode.
 * @param {object} a the application instance
 * @returns {Element} the run bar
 */
function buildRunBar(a) {
  const bar = h('div', { class: 'runbar', id: 'runbar', role: 'toolbar', 'aria-label': 'Run controls' });

  // 1 — state pill + method name + block
  const g1 = h('div', { class: 'runbar__group' });
  const pill = h('span', { class: 'pill pill--lg pill--neutral', role: 'status', 'aria-live': 'polite' }, 'IDLE');
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
  a.el.endBtn = button('btn btn--ghost', 'End', (e) => openEndPopover(a, /** @type {Element} */ (e.currentTarget)), {});
  a.el.resetBtn = button('btn btn--ghost', 'Reset', () => act(a, () => sim.reset(a.ctx)), {});
  g2.appendChild(a.el.startBtn);
  g2.appendChild(a.el.holdBtn);
  g2.appendChild(a.el.skipBtn);
  g2.appendChild(a.el.endBtn);
  g2.appendChild(a.el.resetBtn);

  const exports = h('div', { class: 'runbar__group' });
  exports.setAttribute('hidden', '');
  a.el.exportGroup = exports;
  exports.appendChild(button('btn btn--ghost', 'Data CSV', () => exportFile(a, 'data')));
  exports.appendChild(button('btn btn--ghost', 'Fractions CSV', () => exportFile(a, 'fractions')));
  exports.appendChild(button('btn btn--ghost', 'Events CSV', () => exportFile(a, 'events')));
  exports.appendChild(button('btn btn--ghost', 'Run JSON', () => exportFile(a, 'json')));
  g2.appendChild(exports);
  bar.appendChild(g2);

  // 3 — emergency stop, behind a rule and a gap so it never sits beside a benign control
  bar.appendChild(h('span', { class: 'runbar__rule', role: 'separator', 'aria-orientation': 'vertical' }));
  const estop = button('btn btn--danger btn--estop', 'E-STOP', () => act(a, () => sim.estop(a.ctx)), {
    title: 'Emergency stop — acts immediately, no undo (Shift+Esc twice)',
    'aria-label': 'Emergency stop',
  });
  a.el.estopBtn = estop;
  bar.appendChild(estop);
  bar.appendChild(h('span', { class: 'runbar__rule', role: 'separator', 'aria-orientation': 'vertical' }));

  // 4 — sim speed
  const g4 = h('div', { class: 'runbar__group', 'data-tour': 'speed' });
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Simulation speed' });
  a.el.speedOpts = [];
  for (const s of a.ctx.config.sim.speedOptions) {
    const opt = button('segmented__opt', `${s}×`, () => act(a, () => sim.setSpeed(a.ctx, s)), {
      role: 'radio', 'aria-checked': 'false', title: `Run the simulation at ${s}× real time`,
    });
    opt.dataset.speed = String(s);
    a.el.speedOpts.push(opt);
    seg.appendChild(opt);
  }
  g4.appendChild(seg);
  a.el.pauseBtn = button('btn btn--ghost', 'Pause', () => togglePause(a), {});
  g4.appendChild(a.el.pauseBtn);
  const note = h('span', { class: 'runbar__speed-note num' }, '');
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
  const fill = h('div', { class: 'runbar__progress-fill' });
  a.el.progressTrack = track;
  a.el.progressFill = fill;
  track.appendChild(fill);
  g5.appendChild(track);
  bar.appendChild(g5);

  // 6 — mode chip (also the manual-control toggle of §9.4.4)
  const mode = button('pill pill--neutral', 'METHOD', () => toggleManual(a), {
    title: 'Manual control — available in IDLE, READY, HELD and PAUSED only',
    'aria-pressed': 'false',
  });
  a.el.modeChip = mode;
  bar.appendChild(mode);

  return bar;
}

/**
 * The Skip Block control: a 400 ms press-and-hold with a filling progress ring (§9.4.3).
 * The ring is advanced by the shell's own frame pass — no panel starts a second rAF loop.
 * @param {object} a the application instance
 * @returns {HTMLButtonElement} the skip button
 */
function buildSkipButton(a) {
  const btn = /** @type {HTMLButtonElement} */ (h('button', {
    class: 'btn btn--ghost', type: 'button',
    title: 'Skip the current block — hold for 400 ms',
  }, 'Skip block'));

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'holdring');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('class', 'holdring__track');
  track.setAttribute('cx', '12'); track.setAttribute('cy', '12'); track.setAttribute('r', '9');
  track.setAttribute('fill', 'none');
  const arc = document.createElementNS(NS, 'circle');
  arc.setAttribute('class', 'holdring__fill');
  arc.setAttribute('cx', '12'); arc.setAttribute('cy', '12'); arc.setAttribute('r', '9');
  arc.setAttribute('fill', 'none');
  arc.setAttribute('transform', 'rotate(-90 12 12)');
  const circumference = 2 * Math.PI * 9;
  arc.setAttribute('stroke-dasharray', String(circumference));
  arc.setAttribute('stroke-dashoffset', String(circumference));
  svg.appendChild(track);
  svg.appendChild(arc);
  btn.appendChild(svg);
  a.el.skipArc = arc;
  a.el.skipArcLength = circumference;

  const start = (ev) => {
    if (btn.disabled) return;
    ev.preventDefault();
    a.skipHold.active = true;
    a.skipHold.start_ms = performance.now();
    a.skipHold.pointerId = ev.pointerId === undefined ? -1 : ev.pointerId;
    if (btn.setPointerCapture && ev.pointerId !== undefined) {
      try { btn.setPointerCapture(ev.pointerId); } catch (_e) { /* not capturable */ }
    }
  };
  const cancel = () => {
    a.skipHold.active = false;
    a.el.skipArc.setAttribute('stroke-dashoffset', String(a.el.skipArcLength));
  };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointerleave', cancel);
  // Keyboard equivalent: Enter/Space open the same confirm the `N` shortcut opens.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmSkip(a); }
  });
  return btn;
}

/**
 * The alarm banner stack of §9.1.1 with the two live regions of §9.7.
 * @param {object} a the application instance
 * @returns {Element} the alarm stack container
 */
function buildAlarmStack(a) {
  const wrap = h('div', { class: 'alarm-stack', role: 'region', 'aria-label': 'Alarms' });
  const assertive = h('div', {
    class: 'sr-only', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true',
  });
  const polite = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const list = h('div', { class: 'alarm-stack__list' });
  a.el.alarmAssertive = assertive;
  a.el.alarmPolite = polite;
  a.el.alarmList = list;
  wrap.appendChild(assertive);
  wrap.appendChild(polite);
  wrap.appendChild(list);
  return wrap;
}

/**
 * The 36 px tab strip: a real `role="tablist"` with arrow-key navigation (§9.7).
 * @param {object} a the application instance
 * @returns {Element} the tab strip
 */
function buildTabStrip(a) {
  const strip = h('div', { class: 'tabstrip', role: 'tablist', 'aria-label': 'Workspace' });
  a.el.tabs = new Map();
  for (const tab of TABS) {
    const btn = button('tab', tab.label, () => setTab(a, tab.id), {
      role: 'tab',
      id: `tab-${tab.id}`,
      'aria-controls': `view-${tab.id}`,
      'aria-selected': tab.id === a.activeTab ? 'true' : 'false',
      tabindex: tab.id === a.activeTab ? '0' : '-1',
      title: `${tab.label} (${tab.key})`,
    });
    if (tab.id === 'method') btn.setAttribute('data-tour', 'tab-method');
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === tab.id);
      let j = i;
      if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
      else if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
      else if (e.key === 'Home') j = 0;
      else j = TABS.length - 1;
      setTab(a, TABS[j].id);
      const next = a.el.tabs.get(TABS[j].id);
      if (next) next.focus();
    });
    a.el.tabs.set(tab.id, btn);
    strip.appendChild(btn);
  }
  return strip;
}

/**
 * The 28 px status strip — the redundant copy of process state that survives a tab switch (§9.1.1).
 * @param {object} a the application instance
 * @returns {Element} the status strip
 */
function buildStatusStrip(a) {
  const strip = h('footer', { class: 'statusstrip', 'data-tour': 'status' });
  a.el.stat = {};
  const chips = [
    ['p1', 'P1', 'PT-101'],
    ['dp', 'ΔP', 'PDT-101'],
    ['flow', 'Flow', 'FT-101'],
    ['pctb', '%B', 'pctB'],
    ['uv', 'UV280', 'UV-101'],
    ['cond', 'Cond', 'CE-101'],
    ['ph', 'pH', 'AE-101'],
    ['cv', 'Total', 'cv'],
    ['clock', 'Clock', 'run-state'],
  ];
  for (const [key, label, glossId] of chips) {
    const value = h('span', { class: 'statchip__value num' }, '—');
    const chip = button('statchip', '', (e) => {
      showGlossary(a, /** @type {Element} */ (e.currentTarget), glossId);
    }, { title: `${label} — click for what this is` });
    while (chip.firstChild) chip.removeChild(chip.firstChild);
    chip.appendChild(h('span', { class: 'statchip__label' }, label));
    chip.appendChild(value);
    a.el.stat[key] = value;
    strip.appendChild(chip);
  }
  const quality = button('statchip', '', (e) => {
    showQualityPopover(a, /** @type {Element} */ (e.currentTarget));
  }, { title: 'Data quality flags' });
  while (quality.firstChild) quality.removeChild(quality.firstChild);
  quality.appendChild(h('span', { class: 'statchip__label' }, 'Quality'));
  const qv = h('span', { class: 'statchip__value num' }, 'OK');
  quality.appendChild(qv);
  a.el.stat.quality = qv;
  strip.appendChild(quality);
  return strip;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ACTIONS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Run a `core/sim.js` action and surface its refusal. Every action returns `{ ok, reason? }`; a
 * refusal is ALWAYS shown, because a silent refusal teaches nothing (§9.4.4).
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
  if (!r || typeof r !== 'object') return { ok: true };
  if (r.ok === false) toast(a, r.reason || 'Blocked.', 'blocked');
  else if (r.reason) toast(a, r.reason, 'warn');
  a.structural = true;
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
    overlay.showToast(a.overlayHost, { message, kind: kind || 'info', ms: kind === 'blocked' ? 6000 : 4000 });
  } catch (err) {
    console.warn('toast failed:', message, err);
  }
}

/**
 * Start, or continue from HELD/PAUSED. On a pre-run-check refusal the full failure list is shown in
 * a modal rather than a one-line toast — all twelve checks report at once (§5.5.1).
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
  const body = h('div', { class: 'shell-error__msg' });
  const blocking = failures.filter((f) => !f.acknowledgeable);
  const advisory = failures.filter((f) => f.acknowledgeable);
  body.appendChild(h('p', {},
    blocking.length > 0
      ? 'The run cannot start until these are fixed:'
      : 'Only advisory checks failed. You may acknowledge and start anyway.'));
  const ul = h('ul', {});
  for (const f of blocking.concat(advisory)) {
    ul.appendChild(h('li', {}, `${f.code} — ${f.message}${f.acknowledgeable ? ' (advisory)' : ''}`));
  }
  body.appendChild(ul);
  const actions = [{ label: 'Close', onClick: () => {}, variant: 'ghost' }];
  if (blocking.length === 0) {
    actions.unshift({
      label: 'Acknowledge and start',
      variant: 'primary',
      onClick: () => act(a, () => sim.start(a.ctx)),
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
  const box = h('div', { class: 'shell-error__actions' });
  let handle = null;
  const close = () => { if (handle) overlay.dismiss(handle); };
  box.appendChild(h('p', {}, 'End the run:'));
  box.appendChild(button('btn btn--ghost', 'End after current block', () => {
    close(); act(a, () => sim.end(a.ctx, 'AFTER_BLOCK'));
  }));
  box.appendChild(button('btn btn--danger', 'End now', () => {
    close(); act(a, () => sim.end(a.ctx, 'NOW'));
  }));
  handle = overlay.showPopover(a.overlayHost, {
    anchorEl, content: box, placement: 'bottom', maxWidth: 260,
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
  const body = h('div', { class: 'shell-error__msg' },
    h('p', {}, `Skip ${b ? `${b.id} · ${b.name}` : `block ${run.blockIndex + 1}`} and move to the next block?`),
    h('p', {}, 'The block boundary is flushed and logged exactly as a normal block end.'));
  let handle = null;
  const confirm = () => {
    document.removeEventListener('keydown', onKey, true);
    if (handle) overlay.dismiss(handle);
    act(a, () => sim.skipBlock(a.ctx));
  };
  const cancel = () => {
    document.removeEventListener('keydown', onKey, true);
    if (handle) overlay.dismiss(handle);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    else if (e.key === 'Escape') { cancel(); }
  };
  handle = overlay.showModal(a.overlayHost, {
    title: 'Skip block',
    content: body,
    actions: [
      { label: 'Skip block (Enter)', onClick: confirm, variant: 'primary' },
      { label: 'Cancel', onClick: cancel, variant: 'ghost' },
    ],
    dismissible: true,
  });
  document.addEventListener('keydown', onKey, true);
}

/**
 * Pause / resume the process. `Pause` ramps flow to zero; `Continue` returns to RUNNING (§5.5).
 * @param {object} a the application instance
 * @returns {void}
 */
function togglePause(a) {
  const st = a.ctx.run.state;
  if (st === 'PAUSED' || st === 'HELD') act(a, () => sim.resume(a.ctx));
  else act(a, () => sim.pause(a.ctx));
}

/**
 * Toggle manual control. Interlocks and the legal-state rule are enforced by `sim` and explained by
 * the toast on refusal (§9.4.4).
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
 * Write one of the four export files (§5.12, §5.13).
 * @param {object} a the application instance
 * @param {'data'|'events'|'fractions'|'json'|'method'} kind which file
 * @returns {void}
 */
function exportFile(a, kind) {
  const { config, run } = a.ctx;
  const stem = `${config.presetId}_${Math.round(run.t_s)}s`;
  try {
    if (kind === 'data') downloadText(`${stem}_data.csv`, exportDataCSV(config, run), 'text/csv;charset=utf-8');
    else if (kind === 'events') downloadText(`${stem}_events.csv`, exportEventsCSV(config, run), 'text/csv;charset=utf-8');
    else if (kind === 'fractions') downloadText(`${stem}_fractions.csv`, exportFractionsCSV(config, run), 'text/csv;charset=utf-8');
    else if (kind === 'json') {
      downloadText(`${stem}_run.json`, JSON.stringify(exportRunJSON(config, run, null), null, 2),
        'application/json;charset=utf-8');
    } else {
      downloadText(`${config.presetId}_method.json`, JSON.stringify(exportMethodJSON(config), null, 2),
        'application/json;charset=utf-8');
    }
  } catch (err) {
    toast(a, `Export failed: ${errText(err)}`, 'blocked');
  }
}

/**
 * Open a file picker and install the chosen method JSON through `sim.loadMethod` (`Ctrl+O`, §9.5).
 *
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
 * TABS, THEME, POPOVERS
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
    if (on) entry.host.removeAttribute('hidden');
    else entry.host.setAttribute('hidden', '');
    fmt.cls(btn, 'is-active', on);
    fmt.setAttr(btn, 'aria-selected', on ? 'true' : 'false');
    fmt.setAttr(btn, 'tabindex', on ? '0' : '-1');
  }
  // A newly revealed view has missed every frame since it was hidden: give it a structural pass.
  a.structural = true;
  a.ctx.bus.emit('tab-changed', tabId);
}

/**
 * Cycle the colour theme `auto → dark → light → auto` and tell every canvas painter to re-read its
 * tokens. Reading CSS custom properties per frame is a layout-thrash trap (§6.25).
 * @param {object} a the application instance
 * @returns {void}
 */
function cycleTheme(a) {
  const order = ['auto', 'dark', 'light'];
  const next = order[(order.indexOf(a.theme) + 1) % order.length];
  applyTheme(a, next, true);
}

/**
 * Apply a theme choice to the document root and announce it.
 * @param {object} a the application instance
 * @param {'auto'|'dark'|'light'} theme the chosen theme
 * @param {boolean} announce true to emit `theme-changed` on the bus
 * @returns {void}
 */
function applyTheme(a, theme, announce) {
  a.theme = theme;
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  if (a.el.themeBtn) {
    const label = theme === 'auto' ? 'Auto' : (theme === 'dark' ? 'Dark' : 'Light');
    fmt.setText(a.el.themeBtn, label === 'Auto' ? 'A' : label[0]);
    fmt.setAttr(a.el.themeBtn, 'title', `Colour theme: ${label} — click to change`);
  }
  if (announce) a.ctx.bus.emit('theme-changed', resolvedTheme(a));
}

/**
 * @param {object} a the application instance
 * @returns {'dark'|'light'} the theme actually being displayed
 */
function resolvedTheme(a) {
  if (a.theme === 'dark' || a.theme === 'light') return a.theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
}

/**
 * Open the glossary popover for a tag or parameter id (§9.6). A missing entry renders NO info
 * affordance — `glossaryFor` returning null is a contract, not an error.
 * @param {object} a the application instance
 * @param {Element} anchorEl the element the popover points at
 * @param {string} id a P&ID tag, config path, concept id or alias
 * @returns {void}
 */
function showGlossary(a, anchorEl, id) {
  const entry = glossaryFor(id);
  if (!entry) return;
  overlay.showPopover(a.overlayHost, {
    anchorEl, content: glossaryContent(entry), placement: 'top', maxWidth: 300,
  });
}

/**
 * Render a glossary entry as DOM: what it is, why it matters, units and typical range.
 * @param {{term:string, short:string, why:string, typical:string, seeAlso:string[]}} entry the entry
 * @returns {Element} the popover body
 */
function glossaryContent(entry) {
  return h('div', { class: 'glossary' },
    h('strong', {}, entry.term),
    h('p', {}, entry.short),
    h('p', {}, entry.why),
    h('p', { class: 'glossary__typical' }, entry.typical));
}

/**
 * The `SIMULATED` chip's popover: what the model does, and what it deliberately does not.
 * @param {object} a the application instance
 * @returns {Element} the popover body
 */
function honestyContent(a) {
  const cfg = a.ctx.config;
  return h('div', { class: 'glossary' },
    h('strong', {}, 'This is a simulation, not an instrument'),
    h('p', {}, 'A one-dimensional packed bed with axial dispersion, film and pore mass transfer, and a '
      + `${cfg.column.isothermMode} isotherm. Sensors carry real noise, drift, filtering and delay volumes.`),
    h('p', {}, 'Deliberately absent: radial gradients, per-cell protein charge, replay and scrubbing, '
      + 'and any network or cloud component. Numbers here are physically consistent, not certified.'),
    h('p', { class: 'glossary__typical' },
      `Preset ${cfg.presetId} · ${cfg.scale} · seed ${cfg.seed} · grid nz=${cfg.column.nz}.`));
}

/**
 * The status strip's quality chip popover: every `run.qualityFlags` bit currently set (§5.3).
 * @param {object} a the application instance
 * @param {Element} anchorEl the chip
 * @returns {void}
 */
function showQualityPopover(a, anchorEl) {
  const flags = a.ctx.run.qualityFlags;
  const body = h('div', { class: 'glossary' }, h('strong', {}, 'Data quality'));
  const set = QF_LABELS.filter(([bit]) => (flags & bit) !== 0);
  if (set.length === 0) {
    body.appendChild(h('p', {}, 'Every sensor is reporting normally.'));
  } else {
    const ul = h('ul', {});
    for (const [, label] of set) ul.appendChild(h('li', {}, label));
    body.appendChild(ul);
  }
  const g = glossaryFor('quality-flags');
  if (g) body.appendChild(h('p', { class: 'glossary__typical' }, g.why));
  overlay.showPopover(a.overlayHost, { anchorEl, content: body, placement: 'top', maxWidth: 320 });
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * BUS, KEYBOARD, RESPONSIVE
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Subscribe the shell to the bus. Everything that holds a derived value keyed on `config` is
 * rebuilt on `config-replaced`; the startup benchmark is re-run on `preset-loaded` (§6.32).
 * @param {object} a the application instance
 * @returns {void}
 */
function wireBus(a) {
  const bus = a.ctx.bus;
  const invalidate = () => {
    a.demandCache = null;
    a.alarmSig = '';
    a.liveAlarmId = '';
    a.silenced.clear();
    a.lastEventCount = a.ctx.run.events ? a.ctx.run.events.length : 0;
    a.simFailed = false;
    a.structural = true;
    rebuildSpeedOptions(a);
  };
  bus.on('config-replaced', invalidate);
  bus.on('run-reset', invalidate);
  bus.on('preset-loaded', () => {
    invalidate();
    runStartupBenchmark(a);
    invalidate();
  });
  bus.on('scenario-applied', () => { setTab(a, 'run'); });
  bus.on('run-ended', () => { a.structural = true; });
  bus.on('request-tab', (tabId) => setTab(a, tabId));
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { if (a.theme === 'auto') bus.emit('theme-changed', resolvedTheme(a)); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

/**
 * Rebuild the speed segmented control when `config.sim.speedOptions` changes with the preset.
 * @param {object} a the application instance
 * @returns {void}
 */
function rebuildSpeedOptions(a) {
  const opts = a.ctx.config.sim.speedOptions;
  const same = a.el.speedOpts.length === opts.length
    && a.el.speedOpts.every((el, i) => Number(el.dataset.speed) === opts[i]);
  if (same) return;
  const parent = a.el.speedOpts.length > 0 ? a.el.speedOpts[0].parentNode : null;
  if (!parent) return;
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  a.el.speedOpts = [];
  for (const s of opts) {
    const opt = button('segmented__opt', `${s}×`, () => act(a, () => sim.setSpeed(a.ctx, s)), {
      role: 'radio', 'aria-checked': 'false', title: `Run the simulation at ${s}× real time`,
    });
    opt.dataset.speed = String(s);
    a.el.speedOpts.push(opt);
    parent.appendChild(opt);
  }
}

/**
 * Install the one document-level key handler. Shell actions execute here; view actions go out on
 * the bus as `('key-action', { action, combo, event })` so no second listener is ever needed.
 * @param {object} a the application instance
 * @returns {void}
 */
function wireKeyboard(a) {
  document.addEventListener('keydown', (e) => {
    const combo = normaliseCombo(e);
    const entry = KEYMAP[combo];
    if (!entry) return;
    if (typingInField() && combo !== 'Escape') return;
    if (handleKeyAction(a, entry.action, e)) e.preventDefault();
  });
}

/**
 * Execute one keymap action.
 * @param {object} a the application instance
 * @param {string} action the action id from `KEYMAP`
 * @param {KeyboardEvent} e the originating event
 * @returns {boolean} true when the event was consumed and should be prevented
 */
function handleKeyAction(a, action, e) {
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
    case 'hold': act(a, () => sim.hold(a.ctx)); return true;
    case 'continue': act(a, () => sim.resume(a.ctx)); return true;
    case 'skip-block': confirmSkip(a); return true;
    case 'end-run': openEndPopover(a, a.el.endBtn); return true;
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
    case 'export-method': exportFile(a, 'method'); return true;
    case 'import-method': importMethodFile(a); return true;
    case 'perf-overlay':
      a.perfOn = !a.perfOn;
      if (a.perfOn) a.el.perf.removeAttribute('hidden');
      else a.el.perf.setAttribute('hidden', '');
      return true;
    case 'dismiss':
      a.ctx.bus.emit('key-action', { action, combo: 'Escape', event: e });
      return false;                     // let the overlay host's own Esc handling run too
    default:
      // Chart, legend and pooling live in the views; they own these.
      a.ctx.bus.emit('key-action', { action, combo: normaliseCombo(e), event: e });
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
  const mq = window.matchMedia('(max-width: 719px)');
  const apply = () => {
    if (mq.matches) a.el.narrowNote.removeAttribute('hidden');
    else a.el.narrowNote.setAttribute('hidden', '');
  };
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply);
  a.narrowQuery = mq;
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
 * `document.hidden` pauses RENDERING only; the simulation keeps running and the 0.25 s wall clamp
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
  }
  const tR1 = performance.now();
  a.structural = false;

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
 * is rebuilt only when the active set actually changes; `structural` forces that comparison to be
 * redone after a `config-replaced`, when the whole alarm table may have been swapped.
 *
 * @param {object} a the application instance
 * @param {boolean} structural true when list content may have changed
 * @returns {void}
 */
function refreshShell(a, structural) {
  const { config, run } = a.ctx;
  if (structural) a.alarmSig = '';
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
  const st = run.state;

  // 1 — state, method, block
  const pillClass = `pill pill--lg pill--${stateTone(st)}`;
  if (a.el.statePill.className !== pillClass) a.el.statePill.className = pillClass;
  fmt.setText(a.el.statePill, st);

  fmt.setText(a.el.presetName, config.name || config.presetId);
  fmt.setText(a.el.methodName, (config.method && config.method.name) || 'No method');

  const blocks = config.method ? config.method.blocks : null;
  if (blocks && blocks.length > 0) {
    const i = Math.max(0, Math.min(blocks.length - 1, run.blockIndex));
    const b = blocks[i];
    const prog = blockProgress(config, run);
    const pct = Number.isFinite(prog.fraction) ? Math.round(prog.fraction * 100) : 0;
    fmt.setText(a.el.blockName, `${i + 1}/${blocks.length} · ${b.name || b.id} · ${pct}%`);
  } else {
    fmt.setText(a.el.blockName, '—');
  }

  // 2 — transport
  const held = st === 'HELD' || st === 'PAUSED';
  fmt.setText(a.el.startBtn, held ? 'Continue' : 'Start');
  setEnabled(a.el.startBtn, st === 'IDLE' || st === 'READY' || held,
    `Cannot start from ${st}.`, held ? 'Return to RUNNING (C)' : 'Run the pre-run checks and start (Space)');
  setEnabled(a.el.holdBtn, st === 'RUNNING',
    `Hold is only available while RUNNING (state is ${st}).`, 'Freeze the method, keep flow at setpoint (H)');
  setEnabled(a.el.skipBtn, st === 'RUNNING' || st === 'HELD',
    `A block can only be skipped while RUNNING or HELD (state is ${st}).`,
    'Hold for 400 ms to skip this block (N)');
  setEnabled(a.el.endBtn, st === 'RUNNING' || st === 'HELD' || st === 'PAUSED' || st === 'ALARM',
    `Cannot end from ${st}.`, 'End now, or after the current block (E)');
  const resettable = st === 'ENDED' || st === 'FAULT' || st === 'READY';
  setEnabled(a.el.resetBtn, resettable,
    `Reset is available from READY, ENDED and FAULT (state is ${st}).`,
    'Return to IDLE and rebuild the fluid path');

  // At run end the bar collapses to Reset plus the exports — there is no transport bar (D26b).
  const finished = st === 'ENDED' || st === 'FAULT';
  fmt.cls(a.el.shell, 'is-finished', finished);
  if (finished) a.el.exportGroup.removeAttribute('hidden');
  else a.el.exportGroup.setAttribute('hidden', '');

  // 4 — speed
  for (const opt of a.el.speedOpts) {
    const on = Number(opt.dataset.speed) === run.speed;
    fmt.cls(opt, 'is-selected', on);
    fmt.setAttr(opt, 'aria-checked', on ? 'true' : 'false');
  }
  fmt.setText(a.el.pauseBtn, st === 'PAUSED' || st === 'HELD' ? 'Resume' : 'Pause');
  setEnabled(a.el.pauseBtn, st === 'RUNNING' || st === 'PAUSED' || st === 'HELD',
    `Nothing is running to pause (state is ${st}).`,
    st === 'PAUSED' || st === 'HELD' ? 'Return to RUNNING' : 'Ramp flow to zero and freeze the clock');

  // The honesty readout — never claim a speed the machine is not delivering (§2.1.1).
  if (run.speedDeficit > 1.01 && st === 'RUNNING') {
    const eff = run.speed / run.speedDeficit;
    fmt.setText(a.el.speedNote, `${run.speed}× (limited to ${formatSpeed(eff)}×)`);
    fmt.setAttr(a.el.speedNote, 'title',
      'The machine cannot keep up with the requested speed. Effective speed = speed / speedDeficit.');
    fmt.cls(a.el.speedNote, 'is-limited', true);
  } else {
    fmt.setText(a.el.speedNote, `${run.speed}×`);
    fmt.setAttr(a.el.speedNote, 'title', 'Simulated seconds per real second');
    fmt.cls(a.el.speedNote, 'is-limited', false);
  }

  // 5 — progress
  const CV = config.column.V_mL;
  fmt.setText(a.el.counters,
    `${fmt.fmtVolume(run.V_tot_mL, config)} · ${fmt.fmtCV(run.V_tot_mL, config)} · ${fmt.fmtTime(run.t_s)}`);
  const frac = methodFraction(a, config, run);
  const pct = Math.round(frac * 100);
  a.el.progressFill.style.width = `${pct}%`;
  fmt.setAttr(a.el.progressTrack, 'aria-valuenow', String(pct));
  fmt.setAttr(a.el.progressTrack, 'aria-valuetext',
    `${pct}% of the method, ${(run.V_tot_mL / CV).toFixed(2)} column volumes delivered`);

  // 6 — mode chip
  const manual = !!run.manualOverride;
  fmt.setText(a.el.modeChip, manual ? 'MANUAL CONTROL' : 'METHOD');
  const modeClass = `pill ${manual ? 'pill--warn' : 'pill--neutral'}`;
  if (a.el.modeChip.className !== modeClass) a.el.modeChip.className = modeClass;
  fmt.setAttr(a.el.modeChip, 'aria-pressed', manual ? 'true' : 'false');
  fmt.cls(a.el.shell, 'is-manual', manual);
}

/**
 * Advance the Skip Block hold ring and fire the skip once the 400 ms threshold is crossed.
 * @param {object} a the application instance
 * @returns {void}
 */
function advanceSkipHold(a) {
  const p = Math.min(1, (performance.now() - a.skipHold.start_ms) / SKIP_HOLD_MS);
  a.el.skipArc.setAttribute('stroke-dashoffset', String(a.el.skipArcLength * (1 - p)));
  if (p >= 1) {
    a.skipHold.active = false;
    a.el.skipArc.setAttribute('stroke-dashoffset', String(a.el.skipArcLength));
    act(a, () => sim.skipBlock(a.ctx));
  }
}

/**
 * Overall method progress as a fraction, weighted by block VOLUME so the bar matches the phase rail.
 * `methodDemand` is cached per `config` and rebuilt on `config-replaced`.
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
  const done = start + Math.max(0, run.V_block_mL);
  return Math.max(0, Math.min(1, done / total));
}

/**
 * Repaint the status strip chips.
 * @param {object} a the application instance
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @returns {void}
 */
function refreshStatusStrip(a, config, run) {
  const s = a.el.stat;
  fmt.setText(s.p1, fmt.fmtPressure(run.press.P1disp_bar));
  fmt.setText(s.dp, fmt.fmtPressure(run.press.P1disp_bar - run.press.P2disp_bar));
  fmt.setText(s.flow, fmt.fmtFlow(run.Q_actual_mLs, config));
  fmt.setText(s.pctb, fmt.fmtPct(run.pctB_colInlet));
  fmt.setText(s.uv, fmt.fmtAbs(run.uv.Afilt[0]));
  fmt.setText(s.cond, fmt.fmtCond(run.cond.kappaDisp_mScm));
  fmt.setText(s.ph, fmt.fmtPH(run.ph.pHfilt));
  fmt.setText(s.cv, fmt.fmtCV(run.V_tot_mL, config));
  fmt.setText(s.clock, fmt.fmtTime(run.t_s));

  let count = 0;
  for (const [bit] of QF_LABELS) if ((run.qualityFlags & bit) !== 0) count++;
  fmt.setText(s.quality, count === 0 ? 'OK' : `${count} flag${count === 1 ? '' : 's'}`);
  fmt.cls(s.quality, 'is-flagged', count > 0);
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

  const shown = active.slice(0, MAX_BANNERS);
  for (const def of shown) list.appendChild(buildBanner(a, def, active.length));
  if (active.length > MAX_BANNERS) {
    list.appendChild(h('div', { class: 'banner__count' },
      `+${active.length - MAX_BANNERS} more active alarm${active.length - MAX_BANNERS === 1 ? '' : 's'} — see the System tab`));
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
  fmt.cls(a.el.shell, 'has-alarms', active.length > 0);
}

/**
 * Build one alarm banner (§9.4.2): colour bar, icon, severity word, message, detail, Ack, Silence.
 * @param {object} a the application instance
 * @param {object} def the `AlarmDef` row from `config.alarms`
 * @param {number} total how many alarms are active in total
 * @returns {Element} the banner
 */
function buildBanner(a, def, total) {
  const sev = def.severity || 'WARN';
  const banner = h('div', { class: `banner banner--${sev.toLowerCase()}` });
  banner.appendChild(h('span', { class: 'banner__bar', 'aria-hidden': 'true' }));
  banner.appendChild(h('span', { class: 'banner__icon', 'aria-hidden': 'true' }, SEVERITY_GLYPH[sev] || '!'));

  const text = h('div', { class: 'banner__text' });
  text.appendChild(h('span', { class: 'banner__sev' }, sev));
  text.appendChild(h('span', { class: 'banner__msg' }, def.name));
  const g = glossaryFor(def.signal || 'alarm-state');
  text.appendChild(h('span', { class: 'banner__detail' },
    `${def.id} · action ${def.action}${g ? ` · ${g.term}` : ''}`));
  banner.appendChild(text);

  const actions = h('div', { class: 'banner__actions' });
  if (def.ackRequired || def.latching) {
    actions.appendChild(button('btn btn--ghost', 'Ack', () => {
      act(a, () => sim.acknowledgeAlarm(a.ctx, def.id));
      a.alarmSig = '';
    }, { 'aria-label': `Acknowledge ${def.name}` }));
  }
  actions.appendChild(button('btn btn--ghost', 'Silence', () => {
    a.silenced.add(def.id);
    a.alarmSig = '';
    toast(a, `${def.id} hidden from the banner. It stays active in the event log.`, 'info');
  }, { 'aria-label': `Silence the banner for ${def.name}`, title: 'Hide this banner; the alarm stays active' }));
  actions.appendChild(button('btn btn--icon', 'i', (e) => {
    showGlossary(a, /** @type {Element} */ (e.currentTarget), def.signal || 'alarm-state');
  }, { 'aria-label': `What ${def.name} means` }));
  if (total > 1) actions.appendChild(h('span', { class: 'banner__count' }, `${total} active`));
  banner.appendChild(actions);
  return banner;
}

/**
 * Repaint the `Ctrl+Alt+P` performance overlay (§6.32).
 * @param {object} a the application instance
 * @returns {void}
 */
function renderPerf(a) {
  const run = a.ctx.run;
  const p = a.perf;
  const rows = [
    ['frame', `${p.frame_ms.toFixed(1)} ms (${(1000 / Math.max(p.frame_ms, 0.001)).toFixed(0)} fps)`],
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
    ['log rows', String(run.log ? run.log.n : 0)],
  ];
  const el = a.el.perf;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const [k, v] of rows) {
    el.appendChild(h('div', { class: 'perf-overlay__row' },
      h('span', { class: 'perf-overlay__k' }, k),
      h('span', { class: 'perf-overlay__v num' }, v)));
  }
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
 * repeating fault does not grow the DOM without bound.
 * @param {object} a the application instance
 * @param {string} source where it came from, e.g. `'run view'`
 * @param {*} err the thrown value
 * @returns {void}
 */
function reportError(a, source, err) {
  console.error(`[app] ${source} failed:`, err);
  if (!a.el.shell) return;
  if (a.el.errorBar && a.el.errorBar.parentNode) a.el.errorBar.parentNode.removeChild(a.el.errorBar);
  const bar = h('div', { class: 'shell-error', role: 'alert' });
  bar.appendChild(h('span', { class: 'shell-error__msg' }, `${source}: ${errText(err)}`));
  const actions = h('div', { class: 'shell-error__actions' });
  actions.appendChild(button('btn btn--ghost', 'Copy details', () => {
    const text = `${source}: ${errText(err)}\n${(err && err.stack) || ''}`;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    else console.log(text);
  }));
  actions.appendChild(button('btn btn--ghost', 'Dismiss', () => {
    if (bar.parentNode) bar.parentNode.removeChild(bar);
    if (a.el.errorBar === bar) a.el.errorBar = null;
  }));
  bar.appendChild(actions);
  a.el.errorBar = bar;
  a.el.shell.insertBefore(bar, a.el.alarmList ? a.el.alarmList.parentNode : a.el.shell.firstChild);
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
