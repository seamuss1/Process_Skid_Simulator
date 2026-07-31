/**
 * @file src/ui/onboarding.js — the first-run window, the six-step tour, the coach-hint scheduler,
 *                             and the one-click scenario launcher, in the FT-CLASSIC idiom.
 *
 * **The scenario picker is the ONLY UI surface that reaches `sim.loadScenario` and
 * `presets.listScenarios`.** Without this module the eight mandatory teaching scenarios ship
 * unreachable.
 *
 * TEXT POLICY. The old prose-heavy intro is gone. The first-run window is now a compact beveled
 * panel: **one short line, then a grid of eight scenario buttons**, each an icon plus a one-to-three
 * word caption. The sentences that used to sit on the screen now live in the buttons' `title`
 * tooltips, where the scenario's own `expectedOutcome` from `src/data/presets.js` is the text —
 * this file authors captions, not explanations. All eight scenarios are one click away from both
 * the first-run window and the launcher.
 *
 * The tour's coach marks keep their prose deliberately: a teaching card IS the explanation surface,
 * and its text comes from `src/data/glossary.js` plus one connective sentence per step. Nothing else
 * in this module puts a sentence on screen.
 *
 * STATE IS IN MEMORY FOR THE SESSION. There is no `localStorage`, so the first-run window reappears
 * on reload.
 *
 * This module mutates nothing on `run` or `config`: it calls `core/sim.js` actions and surfaces
 * their `{ ok, reason }` verbatim.
 *
 * CSS CONTRACT — the classes this module emits. A complete beveled base sheet is injected once into
 * `@layer chromaskid-onboarding`, so the window is correct with `styles/tokens.css` alone;
 * `styles/app.css` is unlayered and therefore overrides every rule here without a specificity fight.
 *   .onboarding (display:contents; the Panel `el`, contributing no layout)
 *   .ob-lede .ob-grid .ob-sc .ob-sc__i .ob-sc__c .ob-sc__x
 *   .modal--firstrun on the first-run window
 *
 * TOUR ANCHOR CONTRACT — every step resolves the first selector that hits, and the primary selector
 * is always a `[data-tour="…"]` attribute. Panels that want a precise spotlight should stamp:
 *   data-tour="run-controls" | "toolbar" | "pid" | "trend" | "faceplate" | "fractions" |
 *   "nav-method" | "status"
 * Every step also falls back to the workspace, so a renamed class costs a precise spotlight, never
 * the tour.
 *
 * @module ui/onboarding
 */

import * as sim from '../core/sim.js';
import * as presets from '../data/presets.js';
import { glossaryFor } from '../data/glossary.js';
import * as overlay from './overlay.js';
import { h, hSvg } from './format.js';

/** Minimum wall-clock gap between two coach hints, ms (max one card per 20 s). */
const HINT_INTERVAL_MS = 20000;

/** How long a coach hint stays on screen, ms. */
const HINT_MS = 14000;

/** Nothing is offered in the first moments after a scenario loads; let the operator look first. */
const HINT_WARMUP_MS = 4000;

/** Conductivity rise, mS/cm above the running baseline, that means the salt front has arrived. */
const COND_FRONT_RISE_mScm = 2.0;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * BASE STYLES — beveled, square-cornered, token-only
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

const BEV_RAISED = 'inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),'
  + 'inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)';
const BEV_SUNKEN = 'inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),'
  + 'inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)';

/* The ordering statement is emitted by BOTH this module and ui/overlay.js, so whichever stylesheet
   the browser parses first fixes the same order: onboarding's rules win over the overlay base. */
const BASE_CSS = `@layer chromaskid-overlay, chromaskid-onboarding;
@layer chromaskid-onboarding {
.onboarding{display:contents;}
.ob{display:flex;flex-direction:column;gap:6px;}
.ob-lede{margin:0;font:400 11px/1.35 var(--font-ui);color:var(--ink-2);}
/* Four fixed columns, so the eight scenarios always read as a 4x2 block however wide the window
   the host stylesheet gives the dialog. Two columns once there is no room for four. */
.ob-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;}
@media (max-width:460px){.ob-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
.ob-sc{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;min-height:66px;
  padding:6px 4px 5px;background:var(--face);border:0;color:var(--ink);cursor:pointer;
  box-shadow:${BEV_RAISED};font:700 9px/1.2 var(--font-ui);letter-spacing:.04em;
  text-transform:uppercase;text-align:center;}
.ob-sc:active{box-shadow:${BEV_SUNKEN};}
.ob-sc:active .ob-sc__i,.ob-sc:active .ob-sc__c{transform:translate(1px,1px);}
.ob-sc__i{display:block;color:var(--ink);}
.ob-sc__c{display:block;min-height:22px;color:var(--ink);}
.ob-sc__x{display:block;margin-top:auto;padding:0 3px;background:var(--fld-bg);
  box-shadow:${BEV_SUNKEN};font:700 9px/1.5 var(--font-num);color:var(--fld-sp);
  font-variant-numeric:tabular-nums;}
}`;

let baseCssInjected = false;

/** Inject the base stylesheet once, as the first child of `<head>` so author rules win. */
function injectBaseCss() {
  if (baseCssInjected || typeof document === 'undefined') return;
  baseCssInjected = true;
  const head = document.head || document.documentElement;
  const style = document.createElement('style');
  style.setAttribute('data-owner', 'ui/onboarding.js');
  style.textContent = BASE_CSS;
  head.insertBefore(style, head.firstChild);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ICONS — inline SVG, authored here, one per scenario
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Scenario pictograms on a 16×16 grid. `{d}` is a stroked path, `{d, fill:true}` a filled one,
 * `{c:[cx,cy,r]}` a circle. Each one draws the *shape of the failure*, which is what the operator
 * will actually see on the trend.
 * @type {{[key:string]: Array<{d?:string, c?:number[], fill?:boolean}>}}
 */
const ICONS = {
  /* two resolved gaussians on a baseline */
  'textbook-clean': [
    { d: 'M1 14 H15' },
    { d: 'M1.5 14 C3 14 3 4 5 4 C7 4 7 14 8.5 14' },
    { d: 'M8.5 14 C10 14 10 7.5 11.5 7.5 C13 7.5 13 14 14.5 14' },
  ],
  /* a square-topped, fronting peak: the column is full */
  'overloaded-column': [
    { d: 'M1 14 H15' },
    { d: 'M1.5 14 L4.5 4 H11 L12 14' },
  ],
  /* a very steep ramp */
  'gradient-too-steep': [
    { d: 'M1 14 H15' },
    { d: 'M2 13 L8 13 L10.5 2 L15 2' },
  ],
  /* a pressure gauge with the needle high */
  'fouled-column-high-dp': [
    { c: [8, 9, 5.5] },
    { d: 'M8 9 L11.6 5.4' },
    { d: 'M2.6 9 H4' },
    { d: 'M12 9 H13.4' },
    { d: 'M8 2.6 V4' },
  ],
  /* bubbles travelling down a pipe */
  'air-in-the-line': [
    { d: 'M1 4.5 H15' },
    { d: 'M1 12.5 H15' },
    { c: [4.5, 8.5, 1.7] },
    { c: [8.5, 7.8, 1.2] },
    { c: [12, 9.2, 1.5] },
  ],
  /* a droplet with the pH falling */
  'wrong-buffer-ph': [
    { d: 'M8 1.5 C5 6 4 8.2 4 10 A4 4 0 0 0 12 10 C12 8.2 11 6 8 1.5 Z' },
    { d: 'M8 7 V11.4' },
    { d: 'M6.3 9.7 L8 11.4 L9.7 9.7' },
  ],
  /* a snowflake */
  'cold-room': [
    { d: 'M8 1 V15' }, { d: 'M2 4.5 L14 11.5' }, { d: 'M14 4.5 L2 11.5' },
    { d: 'M6 2.6 L8 4.2 L10 2.6' }, { d: 'M6 13.4 L8 11.8 L10 13.4' },
  ],
  /* a peak sitting to the left of the vials that should have caught it */
  'uncompensated-fractionation': [
    { d: 'M1 6.5 C2.5 6.5 2.5 1.5 4.5 1.5 C6.5 1.5 6.5 6.5 8 6.5' },
    { d: 'M2 9 H5 V15 H2 Z' }, { d: 'M6.5 9 H9.5 V15 H6.5 Z' }, { d: 'M11 9 H14 V15 H11 Z' },
  ],
  /* the tour: a compass rose */
  tour: [{ c: [8, 8, 6] }, { d: 'M10.8 5.2 L9.2 9.2 L5.2 10.8 L6.8 6.8 Z', fill: true }],
  /* start with the shipped method and nothing applied */
  blank: [{ d: 'M2 3 H14 V13 H2 Z' }, { d: 'M2 11 H14' }],
  /* generic fallback: a warning triangle */
  fault: [{ d: 'M8 2 L15 14 H1 Z' }, { d: 'M8 6.5 V10' }, { d: 'M8 11.6 V12.4' }],
};

/**
 * Build one scenario pictogram.
 * @param {string} key an {@link ICONS} key; unknown keys fall back to the warning triangle
 * @param {number} [size=22] edge length in px
 * @returns {SVGElement} the icon, always `aria-hidden` — the caption and the title carry the name
 */
function icon(key, size) {
  const px = typeof size === 'number' && size > 0 ? Math.round(size) : 22;
  const shapes = ICONS[key] || ICONS.fault;
  const svg = hSvg('svg', {
    viewBox: '0 0 16 16', width: px, height: px, class: 'ob-sc__i',
    'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
    'stroke-linecap': 'square', 'stroke-linejoin': 'miter',
  });
  for (let i = 0; i < shapes.length; i += 1) {
    const s = shapes[i];
    const paint = s.fill ? { fill: 'currentColor', stroke: 'none' } : {};
    if (s.c) svg.appendChild(hSvg('circle', Object.assign({ cx: s.c[0], cy: s.c[1], r: s.c[2] }, paint)));
    else svg.appendChild(hSvg('path', Object.assign({ d: s.d }, paint)));
  }
  return svg;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * TABLES
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The one-to-three word caption on each scenario button. An id absent from this table falls back to
 * the first two words of the scenario's own name, so a new scenario is never unreachable.
 * @type {{[scenarioId:string]: string}}
 */
const SCENARIO_CAPTION = {
  'textbook-clean': 'CLEAN',
  'overloaded-column': 'OVERLOAD',
  'gradient-too-steep': 'STEEP GRAD',
  'fouled-column-high-dp': 'HIGH ΔP',
  'air-in-the-line': 'AIR SLUG',
  'wrong-buffer-ph': 'LOW PH',
  'cold-room': 'COLD 5 °C',
  'uncompensated-fractionation': 'FRAC LAG',
};

/**
 * The six coach-mark steps.
 *
 * `selectors` is tried in order against the live document; the first hit anchors the spotlight.
 * `glossary` supplies the authoritative explanation, `lead` the one sentence that ties it to what
 * is on screen.
 *
 * @type {Array<{title:string, lead:string, glossary:string, selectors:string[]}>}
 */
const TOUR_STEPS = [
  {
    title: 'The toolbar',
    lead: 'Run, hold, continue, skip block, end and the emergency stop never move and never hide '
      + 'behind a tab. Every button is an icon: hover it for its name. The lamp on the left is the '
      + 'run state, and it decides what the other controls will let you do.',
    glossary: 'run-state',
    selectors: ['[data-tour="run-controls"]', '[data-tour="toolbar"]', '.ft-toolbar', '#run-controls',
      '.toolbar', '.runbar'],
  },
  {
    title: 'The P&ID',
    lead: 'Valves, pump, mixer, detectors and the column itself, drawn as a plant would draw them. '
      + 'Pipes carry their service colour and march while they flow. Inside the column the packed '
      + 'bed is painted live: coloured bands are protein, the yellow edge is the salt front.',
    glossary: 'C-101',
    selectors: ['[data-tour="pid"]', '.ft-pid', '.pid-root', '#view-run .rv-pid', '.rv-pid'],
  },
  {
    title: 'The trend',
    lead: 'UV, conductivity, pH, %B, pressure and flow on shared axes, always visible under the '
      + 'P&ID. A solid pen is the PV; a dashed pen of the same colour is its setpoint, so you read '
      + 'the pair at a glance. Press X to switch the x axis between volume, column volumes and time.',
    glossary: 'UV-101',
    selectors: ['[data-tour="trend"]', '[data-tour="chromatogram"]', '.ft-trend', '#view-run .rv-chart',
      '.rv-chart', '.chart'],
  },
  {
    title: 'Faceplates',
    lead: 'Click any instrument bubble on the P&ID and its faceplate opens: PV, setpoint, a bargraph '
      + 'against the alarm limits, the AUTO/MAN lamps and whatever that tag can do. That is where '
      + 'the numbers and the controls live, which is why the screen itself carries so few words.',
    glossary: 'FT-101',
    selectors: ['[data-tour="faceplate"]', '.pid-bubble', '.isa-bubble', '[data-tour="pid"]', '.ft-pid'],
  },
  {
    title: 'Fractions',
    lead: 'The collector fills vials as the peak passes. Afterwards, on the Results screen, you drag '
      + 'a window across the chromatogram to pool them and the yield and purity update as you drag.',
    glossary: 'pool',
    selectors: ['[data-tour="fractions"]', '.ft-frac', '#view-run .rv-frac', '.rv-frac', '.fracstrip'],
  },
  {
    title: 'The method',
    lead: 'The blocks, their durations, gradients and fraction rules. Change one number, come back '
      + 'and press run — that loop is the whole point of the simulator.',
    glossary: 'block.duration',
    selectors: ['[data-tour="nav-method"]', '[data-tour="tab-method"]', '#tab-method', '.ft-nav',
      '.tabstrip'],
  },
];

/**
 * The glossary concept each scenario is really teaching, used for the launch hint.
 * Every id here resolves in `data/glossary.js`.
 * @type {{[scenarioId:string]: string}}
 */
const SCENARIO_HOOK = {
  'textbook-clean': 'resolution',
  'overloaded-column': 'breakthrough',
  'gradient-too-steep': 'gradient-slope',
  'fouled-column-high-dp': 'PDT-101',
  'air-in-the-line': 'air-in-line',
  'wrong-buffer-ph': 'ph',
  'cold-room': 'viscosity',
  'uncompensated-fractionation': 'delay-volume',
};

/**
 * Event type → the glossary entry the coach hint should teach from.
 * An event type absent from this table never produces a hint.
 * @type {{[eventType:string]: string}}
 */
const HINT_FOR_EVENT = {
  BLOCK_START: 'block.type',
  WATCH_FIRED: 'watch.signal',
  FRACTION_START: 'fraction',
  FRACTION_END: 'delay-volume',
  PEAK_MAX: 'peak-max',
  ALARM_RAISED: 'alarm-state',
  FLOW_REDUCTION_START: 'flow-reduction',
  AIR_DETECTED: 'air-in-line',
  CIP_COMPLETE: 'cip',
  PACKING_TEST_RESULT: 'packing-test',
  TANK_REFILL: 'tank.startVolume_mL',
  AUTOZERO: 'autozero',
  RUN_END: 'yield',
};

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * CONSTRUCTION
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Create the onboarding panel.
 *
 * Mounted at boot after the views, because the tour's coach marks measure them, and before the rAF
 * loop, because the tour may auto-load `textbook-clean` at 60×.
 *
 * @param {Element} rootEl the shell element the (invisible) host node is appended to
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx
 *   the one context
 * @param {object} overlayHost the `OverlayHost` from `ui/overlay.js::createOverlayHost`
 * @returns {{el:Element, mount:function():void, update:function(object):void,
 *            destroy:function():void, hintsEnabled:boolean}} the Panel, plus the public
 *   `hintsEnabled` flag the shell's Hints control toggles
 */
export function createOnboarding(rootEl, ctx, overlayHost) {
  injectBaseCss();

  // `.onboarding` is `display: contents` — it satisfies the Panel contract's `el` without adding a
  // box to the shell's grid. Every surface this module shows is an overlay, not a child.
  const el = h('div', { class: 'onboarding' });
  rootEl.appendChild(el);

  /** @type {any} */
  const o = {
    el,
    rootEl,
    ctx,
    host: overlayHost,
    hintsEnabled: !!(ctx.config.ui && ctx.config.ui.hintsEnabled),

    // first-run + tour
    firstRunShown: false,
    modalHandle: null,
    tourHandle: null,
    tourIndex: -1,

    // coach hints
    now_ms: 0,
    started_ms: 0,
    lastHint_ms: 0,
    pendingHint: null,          // { key, text }
    hintHandle: null,
    hintsSeen: new Set(),       // one card per concept per session — a hint teaches once

    // derived-signal hint state
    condBaseline_mScm: Infinity,
    condFrontDone: false,
    lastRunState: ctx.run.state,

    mount() { mount(o); },
    update(frameInfo) { update(o, frameInfo); },
    destroy() { destroy(o); },
  };

  o.onConfigReplaced = () => {
    o.condBaseline_mScm = Infinity;
    o.condFrontDone = false;
    o.started_ms = o.now_ms;
    o.pendingHint = null;
  };
  ctx.bus.on('config-replaced', o.onConfigReplaced);
  ctx.bus.on('run-reset', o.onConfigReplaced);

  return o;
}

/**
 * Show the first-run window, once per session.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function mount(o) {
  if (o.firstRunShown) return;
  o.firstRunShown = true;
  showFirstRunModal(o);
}

/**
 * Tear down every floating surface and unsubscribe.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function destroy(o) {
  dismissAll(o);
  o.ctx.bus.off('config-replaced', o.onConfigReplaced);
  o.ctx.bus.off('run-reset', o.onConfigReplaced);
  if (o.el.parentNode) o.el.parentNode.removeChild(o.el);
}

/**
 * Dismiss the window, the coach mark and any live hint.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function dismissAll(o) {
  if (o.modalHandle) { overlay.dismiss(o.modalHandle); o.modalHandle = null; }
  if (o.tourHandle) { overlay.dismiss(o.tourHandle); o.tourHandle = null; }
  if (o.hintHandle) { overlay.dismiss(o.hintHandle); o.hintHandle = null; }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SCENARIO GRID — shared by the first-run window and the launcher
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A one-to-three word caption for a scenario, falling back to the first two words of its name.
 * @param {{id:string, name:string}} row a `listScenarios()` row
 * @returns {string} the uppercase caption
 */
function captionFor(row) {
  const fixed = SCENARIO_CAPTION[row.id];
  if (fixed) return fixed;
  const words = String(row.name || row.id).split(/[\s—-]+/).filter(Boolean).slice(0, 2);
  return words.join(' ').toUpperCase().slice(0, 14);
}

/**
 * Build the grid of eight scenario buttons: icon, caption, and the scenario's speed in a sunken
 * chip. One click loads the configuration, applies the fault and starts the run.
 *
 * The explanation is not on the button — it is the button's `title`, which carries the scenario's
 * own `expectedOutcome` from `data/presets.js` verbatim.
 *
 * @param {object} o the onboarding instance
 * @returns {Element} the `.ob-grid` element
 */
function buildScenarioGrid(o) {
  const grid = h('div', { class: 'ob-grid', role: 'group', 'aria-label': 'Teaching scenarios' });
  const rows = presets.listScenarios();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const full = findScenario(row.id);
    const speed = full && typeof full.speed === 'number' ? full.speed : 1;
    const caption = captionFor(row);
    const title = `${row.name} — ${row.expectedOutcome} Loads, applies its fault and starts at ${speed}×.`;

    const btn = h('button', {
      type: 'button',
      class: 'ob-sc',
      title,
      // The accessible name starts with the visible caption, so voice control can address the
      // button by what is written on it, and screen readers still get the whole outcome.
      'aria-label': `${caption} — ${title}`,
    },
    icon(row.id, 22),
    h('span', { class: 'ob-sc__c' }, caption),
    h('span', { class: 'ob-sc__x' }, speed + '×'));

    btn.addEventListener('click', () => {
      closeModal(o);
      launchScenario(o, row.id);        // one click: load, apply the fault, and start
    });
    grid.appendChild(btn);
  }
  return grid;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * FIRST-RUN WINDOW
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The first-run window: one short line, then every scenario as a button. The tour and the plain
 * start are the two dialog actions.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function showFirstRunModal(o) {
  const body = h('div', { class: 'ob' },
    h('p', { class: 'ob-lede' },
      'Simulated skid — solved from physics, nothing connected, nothing saved.'),
    buildScenarioGrid(o));

  // `showModal` closes nothing by itself: every action handler is handed the handle and dismisses.
  o.modalHandle = overlay.showModal(o.host, {
    title: 'Select a start',
    content: body,
    className: 'modal--firstrun',
    dismissible: true,
    onDismiss: () => { o.modalHandle = null; },
    actions: [
      {
        label: 'Tour',
        icon: 'play',
        title: 'Take the 60-second guided tour of the screen',
        variant: 'ghost',
        onClick: (hd) => { overlay.dismiss(hd); startTour(o); },
      },
      {
        label: 'Idle',
        icon: 'blank',
        title: 'Start idle on the shipped method, with no scenario applied',
        variant: 'primary',
        onClick: (hd) => overlay.dismiss(hd),
      },
    ],
  });
}

/**
 * Close whatever window onboarding currently owns.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function closeModal(o) {
  if (o.modalHandle) { overlay.dismiss(o.modalHandle); o.modalHandle = null; }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TOUR
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Run the six-step coach-mark tour. Back / Next / Skip come from the overlay's coach mark; `Esc`
 * exits through the same path. At the end `textbook-clean` is auto-loaded at 60×, because a
 * simulator that starts idle teaches nothing.
 *
 * @param {object} o the onboarding instance
 * @returns {void}
 */
export function startTour(o) {
  closeModal(o);
  o.ctx.bus.emit('request-tab', 'run');
  showStep(o, 0);
}

/**
 * Show one tour step.
 * @param {object} o the onboarding instance
 * @param {number} i zero-based step index
 * @returns {void}
 */
function showStep(o, i) {
  if (o.tourHandle) { overlay.dismiss(o.tourHandle); o.tourHandle = null; }
  if (i < 0) i = 0;
  if (i >= TOUR_STEPS.length) { finishTour(o); return; }

  const step = TOUR_STEPS[i];
  o.tourIndex = i;
  const target = resolveTarget(o, step.selectors);
  const body = composeStepBody(step);

  o.tourHandle = overlay.showCoachMark(o.host, {
    targetEl: target,
    title: step.title,
    body,
    step: i + 1,
    total: TOUR_STEPS.length,
    onNext: () => showStep(o, i + 1),
    onBack: () => showStep(o, i - 1),
    onSkip: () => endTour(o),
  });
}

/**
 * Compose a step's body: the connective sentence, then the glossary's own definition and why it
 * matters. The definition is never re-authored here.
 * @param {{lead:string, glossary:string}} step the step
 * @returns {string} the card body
 */
function composeStepBody(step) {
  const g = glossaryFor(step.glossary);
  if (!g) return step.lead;
  return `${step.lead}\n\n${g.term}: ${g.short} ${g.why}`;
}

/**
 * Resolve the first matching anchor for a step, falling back to the workspace so a missing anchor
 * costs a precise spotlight and nothing else.
 * @param {object} o the onboarding instance
 * @param {string[]} selectors candidate CSS selectors, best first
 * @returns {Element} the anchor element
 */
function resolveTarget(o, selectors) {
  for (const sel of selectors) {
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch (err) {
      el = null;                       // a malformed selector costs this candidate, not the tour
    }
    if (el) return el;
  }
  return document.querySelector('.workspace') || o.rootEl || document.body;
}

/**
 * Leave the tour early. No scenario is loaded — the operator asked to stop.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function endTour(o) {
  if (o.tourHandle) { overlay.dismiss(o.tourHandle); o.tourHandle = null; }
  o.tourIndex = -1;
}

/**
 * Finish the tour and auto-load `textbook-clean`, which carries `autoStart: true` and `speed: 60`,
 * so something is moving within five seconds.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function finishTour(o) {
  endTour(o);
  o.ctx.bus.emit('request-tab', 'run');
  launchScenario(o, 'textbook-clean');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SCENARIO LAUNCHER — the only caller of sim.loadScenario and presets.listScenarios
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Show the scenario launcher: every shipped teaching scenario as one icon button, each loading AND
 * starting in one click so the learner watches the failure mode rather than configuring it.
 *
 * @param {object} o the onboarding instance
 * @returns {void}
 */
export function showScenarioPicker(o) {
  closeModal(o);
  injectBaseCss();

  const body = h('div', { class: 'ob' }, buildScenarioGrid(o));

  o.modalHandle = overlay.showModal(o.host, {
    title: 'Scenarios',
    content: body,
    className: 'modal--scenarios',
    dismissible: true,
    onDismiss: () => { o.modalHandle = null; },
    actions: [{
      label: 'Close',
      title: 'Close without loading a scenario',
      variant: 'primary',
      onClick: (hd) => overlay.dismiss(hd),
    }],
  });
}

/**
 * Load and start one scenario, surfacing any refusal verbatim.
 * @param {object} o the onboarding instance
 * @param {string} scenarioId a `data/presets.js::SCENARIOS` id
 * @returns {void}
 */
function launchScenario(o, scenarioId) {
  let r;
  try {
    r = sim.loadScenario(o.ctx, scenarioId);
  } catch (err) {
    overlay.showToast(o.host, {
      message: `Scenario "${scenarioId}" failed to load: ${(err && err.message) || String(err)}`,
      kind: 'blocked', ms: 8000,
    });
    return;
  }
  if (!r || r.ok === false) {
    overlay.showToast(o.host, {
      message: (r && r.reason) || `Scenario "${scenarioId}" could not be loaded.`,
      kind: 'blocked', ms: 8000,
    });
    return;
  }
  if (r.reason) overlay.showToast(o.host, { message: r.reason, kind: 'warn', ms: 8000 });

  // Reset the hint scheduler so the new run gets its own first hint promptly.
  o.hintsSeen.clear();
  o.pendingHint = null;
  o.lastHint_ms = 0;
  o.started_ms = o.now_ms;
  o.condBaseline_mScm = Infinity;
  o.condFrontDone = false;

  const full = findScenario(scenarioId);
  if (full) {
    const hookId = SCENARIO_HOOK[scenarioId];
    const hook = hookId ? glossaryFor(hookId) : null;
    queueHint(o, `scenario:${scenarioId}`,
      `${full.name} — ${full.expectedOutcome}${hook ? ` ${hook.term}: ${hook.short}` : ''}`);
  }
  o.ctx.bus.emit('request-tab', 'run');
}

/**
 * @param {string} id a scenario id
 * @returns {object|null} the full `SCENARIOS` entry, for its `teachingNotes` and `speed`
 */
function findScenario(id) {
  const list = presets.SCENARIOS || [];
  for (const s of list) if (s.id === id) return s;
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * COACH HINTS
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Feed one event record to the coach-hint scheduler.
 *
 * Called by `ui/app.js` for every record appended to `run.events`, in order. At most one hint per
 * concept per session and at most one card per 20 s; the newest candidate wins, so a burst of
 * events never queues a backlog of stale advice.
 *
 * @param {object} o the onboarding instance
 * @param {{type:string, severity:string, source:string, message:string, detail:(object|null),
 *          t_s:number, V_mL:number, V_CV:number, blockId:(string|null)}} eventRecord
 *   an `EventRecord` from `run.events`
 * @returns {void}
 */
export function noteEvent(o, eventRecord) {
  if (!eventRecord || !o.hintsEnabled) return;
  const type = eventRecord.type;

  if (type === 'SCENARIO_APPLIED') {
    const id = eventRecord.detail && eventRecord.detail.scenarioId;
    const sc = id ? findScenario(id) : null;
    if (sc && sc.teachingNotes && sc.teachingNotes.length > 0) {
      queueHint(o, `notes:${id}`, sc.teachingNotes[0]);
    }
    return;
  }

  const glossaryId = HINT_FOR_EVENT[type];
  if (!glossaryId) return;
  const g = glossaryFor(glossaryId);
  if (!g) return;

  const lead = eventRecord.message
    ? `${eventRecord.message} (${eventRecord.V_CV.toFixed(2)} CV)`
    : g.term;
  queueHint(o, glossaryId, `${lead} — ${g.short} ${g.why}`);
}

/**
 * Queue a hint for the next slot. Deduplicated by key: a concept teaches once per session.
 * @param {object} o the onboarding instance
 * @param {string} key the dedupe key, usually the glossary id
 * @param {string} text the card text
 * @returns {void}
 */
function queueHint(o, key, text) {
  if (!o.hintsEnabled) return;
  if (o.hintsSeen.has(key)) return;
  o.pendingHint = { key, text };
}

/**
 * The per-frame half of onboarding: release a queued hint when the 20 s gate opens, and watch the
 * two derived signals that no event announces.
 *
 * Never blocks, never steals focus, and does nothing at all while the tour or a window is open.
 *
 * @param {object} o the onboarding instance
 * @param {{now_ms:number, dt_ms:number, tick:number, structural:boolean}} frameInfo the frame
 * @returns {void}
 */
function update(o, frameInfo) {
  o.now_ms = frameInfo.now_ms;
  if (o.started_ms === 0) o.started_ms = frameInfo.now_ms;

  const run = o.ctx.run;
  if (run.state !== o.lastRunState) {
    o.lastRunState = run.state;
    if (run.state === 'RUNNING') o.condBaseline_mScm = Math.min(o.condBaseline_mScm, run.cond.kappaDisp_mScm);
  }
  if (o.hintsEnabled) watchDerivedSignals(o, run);

  if (!o.hintsEnabled || !o.pendingHint) return;
  // A hint never covers a dialog. `isOpen` rather than a truthiness test, so a handle left behind
  // by an Esc dismissal cannot suppress hints for the rest of the session.
  if (overlay.isOpen(o.modalHandle) || overlay.isOpen(o.tourHandle)) return;
  if (frameInfo.now_ms - o.started_ms < HINT_WARMUP_MS) return;
  if (o.lastHint_ms > 0 && frameInfo.now_ms - o.lastHint_ms < HINT_INTERVAL_MS) return;

  const hint = o.pendingHint;
  o.pendingHint = null;
  o.hintsSeen.add(hint.key);
  o.lastHint_ms = frameInfo.now_ms;
  o.hintHandle = overlay.showToast(o.host, { message: hint.text, kind: 'info', ms: HINT_MS });
}

/**
 * The hints no event can raise, because they are properties of a trace rather than a transition.
 *
 * Currently one: the salt front arriving at the conductivity cell, which is the moment the gradient
 * stops being a setpoint and becomes something the column has actually seen. The lag it announces
 * is read from the real hold-up table, not invented.
 *
 * @param {object} o the onboarding instance
 * @param {object} run the run state (read only)
 * @returns {void}
 */
function watchDerivedSignals(o, run) {
  if (run.state !== 'RUNNING') return;
  const k = run.cond.kappaDisp_mScm;
  if (!Number.isFinite(k)) return;
  if (k < o.condBaseline_mScm) o.condBaseline_mScm = k;
  if (o.condFrontDone) return;
  if (!(o.condBaseline_mScm < Infinity)) return;
  if (k < o.condBaseline_mScm + COND_FRONT_RISE_mScm) return;

  o.condFrontDone = true;
  const cfg = o.ctx.config;
  const hold = cfg.skid.holdup;
  const lag_mL = (hold.VcolOutToUV_mL || 0) + (hold.VuvToCond_mL || 0);
  const lag_CV = lag_mL / cfg.column.V_mL;
  const g = glossaryFor('conductivity');
  const tail = g ? ` ${g.why}` : '';
  queueHint(o, 'cond-front',
    `Conductivity is rising: the salt front has reached the detector. It left the column outlet `
    + `${lag_mL.toFixed(1)} mL ago — ${lag_CV.toFixed(3)} CV of tubing, and ${(lag_mL / Math.max(run.Q_actual_mLs, 1e-9)).toFixed(0)} s `
    + `at the current flow.${tail}`);
}
