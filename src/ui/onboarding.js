/**
 * @file src/ui/onboarding.js — the first-run experience, the six-step tour, the coach-hint
 *                             scheduler, and the one-click scenario launcher.
 *
 * Contract: architecture-v2 §6.34 (this module), §9.6 (onboarding and teaching), §6.24 (the panel
 * shape), §6.33 (every floating surface comes from `ui/overlay.js`).
 *
 * **The scenario picker is the ONLY UI surface that reaches `sim.loadScenario` and
 * `presets.listScenarios`.** Without this module the eight mandatory teaching scenarios ship
 * unreachable, which is exactly the defect §11 C-81 records.
 *
 * All explanatory prose is `src/data/glossary.js` (§6.22.1) or the scenario's own
 * `expectedOutcome` / `teachingNotes` from `src/data/presets.js`. This file authors the connective
 * sentences only — it never re-writes a definition that already exists in the glossary.
 *
 * STATE IS IN MEMORY FOR THE SESSION. There is no `localStorage` (§12 D26a), so the first-run modal
 * reappears on reload; the modal says so itself rather than pretending otherwise.
 *
 * This module mutates nothing on `run` or `config`: it calls `core/sim.js` actions and surfaces
 * their `{ ok, reason }` verbatim.
 *
 * CSS CONTRACT — the classes this module emits, styled in `styles/app.css`:
 *   .onboarding (display:contents; the Panel.el §6.24 requires, contributing no layout)
 *   .onboard .onboard__lede .onboard__note
 *   .scenario-list .scenario .scenario__name .scenario__outcome .scenario__hook
 *   .modal--firstrun on the first-run dialog
 *
 * Tour anchors are tried in priority order per step (see `TOUR_STEPS`) and every step falls back to
 * the workspace, so a view that renames a class costs a precise spotlight, never the tour.
 */

import * as sim from '../core/sim.js';
import * as presets from '../data/presets.js';
import { glossaryFor } from '../data/glossary.js';
import * as overlay from './overlay.js';
import { h } from './format.js';

/** Minimum wall-clock gap between two coach hints, ms (§9.6: max one card per 20 s). */
const HINT_INTERVAL_MS = 20000;

/** How long a coach hint stays on screen, ms. */
const HINT_MS = 14000;

/** Nothing is offered in the first moments after a scenario loads; let the operator look first. */
const HINT_WARMUP_MS = 4000;

/** Conductivity rise, mS/cm above the running baseline, that means the salt front has arrived. */
const COND_FRONT_RISE_mScm = 2.0;

/**
 * The six coach-mark steps of §9.6.
 *
 * `selectors` is tried in order against the live document; the first hit anchors the spotlight.
 * `glossary` supplies the authoritative explanation, `lead` the one sentence that ties it to what
 * is on screen.
 *
 * @type {Array<{title:string, lead:string, glossary:string, selectors:string[]}>}
 */
const TOUR_STEPS = [
  {
    title: 'The run bar is always here',
    lead: 'Start, Hold, Skip block, End and the emergency stop never move and never hide behind a tab. '
      + 'The pill on the left is the run state, and it decides what the other controls will let you do.',
    glossary: 'run-state',
    selectors: ['[data-tour="run-controls"]', '#run-controls', '.runbar'],
  },
  {
    title: 'The skid, drawn as a P&ID',
    lead: 'Valves, pump, mixer, detectors and the column itself. Inside the column the packed bed is '
      + 'painted live: coloured bands are protein moving down the bed, and the yellow edge is the salt front.',
    glossary: 'C-101',
    selectors: ['[data-tour="pid"]', '#view-run .rv-pid', '.rv-pid', '.pid-root', '#view-run'],
  },
  {
    title: 'The chromatogram',
    lead: 'UV, conductivity, pH, %B and pressure on shared axes. Press X to switch the x axis between '
      + 'volume, column volumes and time — the same run tells three different stories.',
    glossary: 'UV-101',
    selectors: ['[data-tour="chromatogram"]', '#view-run .rv-chart', '.rv-chart', '#view-run .chart', '#view-run'],
  },
  {
    title: 'The phase rail',
    lead: 'Every block of the method, drawn proportional to the volume it delivers, with the current '
      + 'one shaded as it runs. Click a block to see the parameters it is running on.',
    glossary: 'method.block',
    selectors: ['[data-tour="phase-rail"]', '#view-run .rv-rail', '.rv-rail', '.rail'],
  },
  {
    title: 'Fractions and pooling',
    lead: 'The collector fills vials as the peak passes. Afterwards, on the Results tab, you drag a '
      + 'window across the chromatogram to pool them and the yield and purity update as you drag.',
    glossary: 'pool',
    selectors: ['[data-tour="fractions"]', '#view-run .rv-frac', '.rv-frac', '.fracstrip'],
  },
  {
    title: 'The Method tab',
    lead: 'The blocks, their durations, gradients and fraction rules. Change one number, come back to '
      + 'the Run tab and press Start — that loop is the whole point of the simulator.',
    glossary: 'block.duration',
    selectors: ['[data-tour="tab-method"]', '#tab-method', '.tabstrip'],
  },
];

/**
 * The glossary concept each scenario is really teaching, shown as the picker's one-line hook.
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
 * Event type → the glossary entry the coach hint should teach from (§9.6).
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
 * Mounted at boot step 4a (§6.32): after the four views, because the tour's coach marks measure
 * them, and before the rAF loop, because the tour may auto-load `textbook-clean` at 60×.
 *
 * @param {Element} rootEl the shell element the (invisible) host node is appended to
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx
 *   the one §2.4 context
 * @param {object} overlayHost the `OverlayHost` from `ui/overlay.js::createOverlayHost`
 * @returns {{el:Element, mount:function():void, update:function(object):void,
 *            destroy:function():void, hintsEnabled:boolean}} the Panel, plus the public
 *   `hintsEnabled` flag the shell's Hints button toggles
 */
export function createOnboarding(rootEl, ctx, overlayHost) {
  // `.onboarding` is `display: contents` — it satisfies the Panel contract's `el` without adding a
  // box to the shell's six-row grid. Every surface this module shows is an overlay, not a child.
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
 * Show the first-run modal, once per session.
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
 * Dismiss the modal, the coach mark and any live hint.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function dismissAll(o) {
  if (o.modalHandle) { overlay.dismiss(o.modalHandle); o.modalHandle = null; }
  if (o.tourHandle) { overlay.dismiss(o.tourHandle); o.tourHandle = null; }
  if (o.hintHandle) { overlay.dismiss(o.hintHandle); o.hintHandle = null; }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * FIRST-RUN MODAL
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The 560×420 first-run modal of §9.6: three ways in, and an honest note about session state.
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function showFirstRunModal(o) {
  const body = h('div', { class: 'onboard' },
    h('p', { class: 'onboard__lede' },
      'This is a simulated preparative chromatography skid. Nothing here is connected to hardware: '
      + 'the bed, the sensors, the alarms and the fraction collector are all solved from physics on '
      + 'your machine, at up to 1000× real time.'),
    h('p', {},
      'Pick a way in. A scenario is the fastest route to something interesting — each one loads a '
      + 'complete method and a specific failure mode, and starts immediately so you can watch it happen.'),
    h('p', { class: 'onboard__note' },
      'Nothing is saved between reloads — there is no local storage, no account and no network. '
      + 'This dialog will appear again next time you load the page, and your layout and unit '
      + 'preferences last only for this session.'));

  // `showModal` closes nothing by itself: every action handler is handed the handle and dismisses.
  o.modalHandle = overlay.showModal(o.host, {
    title: 'This is a simulated chromatography skid',
    content: body,
    className: 'modal--firstrun',
    dismissible: true,
    onDismiss: () => { o.modalHandle = null; },
    actions: [
      {
        label: 'Take the 60-second tour',
        variant: 'primary',
        onClick: (hd) => { overlay.dismiss(hd); startTour(o); },
      },
      {
        label: 'Load a scenario',
        variant: 'ghost',
        onClick: (hd) => { overlay.dismiss(hd); showScenarioPicker(o); },
      },
      {
        label: 'Start empty',
        variant: 'ghost',
        onClick: (hd) => overlay.dismiss(hd),
      },
    ],
  });
}

/**
 * Close whatever modal onboarding currently owns.
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
 * Run the six-step coach-mark tour (§9.6). Back / Next / Skip come from the overlay's coach mark;
 * `Esc` exits through the same path. At the end `textbook-clean` is auto-loaded at 60×, because a
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
    const el = document.querySelector(sel);
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
 * so something is moving within five seconds (§9.6).
 * @param {object} o the onboarding instance
 * @returns {void}
 */
function finishTour(o) {
  endTour(o);
  o.ctx.bus.emit('request-tab', 'run');
  launchScenario(o, 'textbook-clean');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * SCENARIO PICKER — the only caller of sim.loadScenario and presets.listScenarios
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Show the scenario picker: every shipped teaching scenario, each loading AND starting in one
 * click so the learner watches the failure mode rather than configuring it.
 *
 * @param {object} o the onboarding instance
 * @returns {void}
 */
export function showScenarioPicker(o) {
  closeModal(o);
  const list = h('ul', { class: 'scenario-list' });
  const rows = presets.listScenarios();

  for (const row of rows) {
    const full = findScenario(row.id);
    const hookId = SCENARIO_HOOK[row.id];
    const hook = hookId ? glossaryFor(hookId) : null;
    const speed = full && typeof full.speed === 'number' ? full.speed : 1;

    const card = h('button', {
      class: 'scenario', type: 'button',
      title: `Load "${row.name}", apply its fault and start the run at ${speed}×`,
    });
    card.appendChild(h('span', { class: 'scenario__name' }, row.name));
    card.appendChild(h('span', { class: 'scenario__outcome' }, row.expectedOutcome));
    if (hook) card.appendChild(h('span', { class: 'scenario__hook' }, `${hook.term} — ${hook.short}`));
    else if (full && full.teachingNotes && full.teachingNotes.length > 0) {
      card.appendChild(h('span', { class: 'scenario__hook' }, full.teachingNotes[0]));
    }
    card.addEventListener('click', () => {
      closeModal(o);
      launchScenario(o, row.id);        // one click: load, apply the fault, and start
    });
    list.appendChild(h('li', {}, card));
  }

  const body = h('div', { class: 'onboard' },
    h('p', { class: 'onboard__lede' },
      'Each scenario replaces the configuration, applies its fault, and starts the run at the speed '
      + 'that makes it readable. The chromatogram, the alarms and the P&ID all respond — nothing is '
      + 'scripted, so the outcome is whatever the physics produces.'),
    list,
    h('p', { class: 'onboard__note' },
      'When the run ends, the Results tab shows the measured outcome beside the scenario\'s teaching '
      + 'notes, so you can check what you saw against what was supposed to happen.'));

  o.modalHandle = overlay.showModal(o.host, {
    title: 'Teaching scenarios',
    content: body,
    dismissible: true,
    onDismiss: () => { o.modalHandle = null; },
    actions: [{ label: 'Close', variant: 'ghost', onClick: (hd) => overlay.dismiss(hd) }],
  });
}

/**
 * Load and start one scenario, surfacing any refusal verbatim (§9.4.4).
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
    queueHint(o, `scenario:${scenarioId}`,
      `${full.name} — ${full.expectedOutcome}`);
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
 * concept per session and at most one card per 20 s (§9.6); the newest candidate wins, so a burst
 * of events never queues a backlog of stale advice.
 *
 * @param {object} o the onboarding instance
 * @param {{type:string, severity:string, source:string, message:string, detail:(object|null),
 *          t_s:number, V_mL:number, V_CV:number, blockId:(string|null)}} eventRecord
 *   an `EventRecord` from `run.events` (§5.10)
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
 * Never blocks, never steals focus, and does nothing at all while the tour or a modal is open.
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
