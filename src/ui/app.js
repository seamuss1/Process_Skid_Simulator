/**
 * src/ui/app.js — the shell: the title strip, the toolbar, the alarm banner, the workspace and
 * the frame loop.
 *
 * Layer L7. The only module the page imports.
 *
 * THE VIEWS NEVER WRITE STATE. Every control is wired to a function on `A`, which wraps the
 * corresponding action in `core/sim.js`. Actions validate and may refuse, and a refusal surfaces
 * as a toast carrying the reason verbatim — so the rig can say "the stage-up threshold must be
 * above the stage-down threshold, or the sequence will chatter" instead of silently declining.
 */

import * as sim from '../core/sim.js';
import { LOOP } from '../data/config.js';
import { deleteRun } from '../io/export.js';
import { h, setText, cls, clock, num } from './dom.js';
import { createMimic } from './mimic.js';
import { createCurves } from './curves.js';
import { createTrend } from './trend.js';
import { createRail } from './panels.js';
import { createAnalysis } from './analysis.js';
import { createHealth } from './health.js';
import { createLesson } from './lesson.js';
import { createHud } from './hud.js';
import { createRegistry, createPalette, paletteCommands } from './keys.js';
import {
  createGame, gameView, startMission, startEndless, startDaily, startFaultHunt,
  abortGame, submitDiagnosis, replayLast,
} from '../game/session.js';
import { loadProfile, saveProfile, resetProfile } from '../game/profile.js';
import { createAudio, setEnabled, setVolume } from '../game/audio.js';

/** Time-compression choices offered on the toolbar. */
const SPEEDS = [1, 5, 20];

/**
 * Build the action surface handed to the views: every `core/sim.js` action, wrapped so a refusal
 * becomes a toast instead of a silent no-op.
 * @param {object} ctx the sim context
 * @param {(msg:string, kind:string)=>void} toast the toast sink
 * @returns {object} the wrapped actions
 */
function bindActions(ctx, toast) {
  const A = {};
  const NAMES = [
    'togglePause', 'setSpeed', 'setLoopMode', 'setSetpoint', 'setControllerMode', 'setManualOutput',
    'setTuning', 'setTuningForm', 'setAlgorithm', 'setScan', 'setStrategy', 'setModel',
    'startPump', 'stopPump', 'autoPump', 'resetPump', 'forceTrip',
    'setStaging', 'setDisturbance',
    'beginAutotune', 'cancelAutotune', 'beginStepTest', 'cancelStepTest', 'beginSweep',
    'cancelSweep', 'applyTuningRule',
    'beginScenario', 'cancelScenario', 'gradeNow', 'clearScore', 'ackAlarms', 'clearTrend',
    'resetEnergy', 'beginLesson', 'endLesson',
  ];
  for (const name of NAMES) {
    A[name] = (...args) => {
      const res = sim[name](ctx, ...args);
      if (res && res.ok === false) toast(res.reason, 'warn');
      return res;
    };
  }
  // Queries. These never refuse, so they are not wrapped.
  A.summary = () => sim.summary(ctx);
  A.tuningCandidates = () => sim.tuningCandidates(ctx);
  A.deleteRun = (id) => deleteRun(ctx.runs, id);
  A.toast = toast;
  // The unwrapped module, for `io/export.js::applySession` — it collects its own problems and
  // reports them once, rather than raising a toast for every field in the file.
  A.raw = sim;
  return A;
}

/**
 * The page's own storage, or null when it cannot be used.
 *
 * Reading `localStorage` THROWS rather than returning null in a browser set to block site data,
 * and in a few embedding contexts, so the access itself has to be guarded — and a probe read is
 * needed as well, because the property can exist and still throw on first use. Everything
 * downstream already treats a null store as "remember nothing", so this is the whole of it.
 *
 * @returns {?object} a Storage, or null
 */
function pageStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    s.getItem('skid.probe');
    return s;
  } catch {
    return null;
  }
}

/**
 * An AudioContext factory, or null on a page that has no Web Audio.
 * @returns {?function(): object} the factory
 */
function audioFactory() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  return typeof Ctor === 'function' ? () => new Ctor() : null;
}

/**
 * Boot the application into a host element.
 * @param {HTMLElement} host the mount point; its children are replaced
 * @returns {object} the sim context, for the console
 */
export function boot(host) {
  const ctx = sim.createSim();
  host.textContent = '';

  // ---- toasts -------------------------------------------------------------------------------
  const toastLayer = h('div', { class: 'toasts' });
  /**
   * Show a transient message.
   * @param {string} msg the text
   * @param {string} [kind] 'warn', 'alarm' or empty
   * @returns {void}
   */
  function toast(msg, kind) {
    const t = h('div', { class: `toast ${kind ? `toast--${kind}` : ''}`, text: msg });
    toastLayer.appendChild(t);
    setTimeout(() => { t.classList.add('is-out'); }, 4200);
    setTimeout(() => { t.remove(); }, 4800);
    while (toastLayer.children.length > 5) toastLayer.firstChild.remove();
  }
  const A = bindActions(ctx, toast);

  // ---- the game layer -------------------------------------------------------------------------
  // `src/core/sim.js` scans whatever is in `ctx.game` at the bottom of every controller scan and
  // knows nothing else about it. This is the only place the two halves meet.
  const storage = pageStorage();
  const profile = loadProfile(storage);
  const audio = createAudio(audioFactory());
  const game = createGame({ sim, storage, audio, profile });
  ctx.game = game;

  /**
   * Wrap a game action so a refusal surfaces as a toast, exactly as a sim action's does.
   * @param {Function} fn the action, taking `(game, ctx, ...args)`
   * @returns {Function} the bound, wrapped action
   */
  const gameAction = (fn) => (...args) => {
    const res = fn(game, ctx, ...args);
    if (res && res.ok === false) toast(res.reason, 'warn');
    return res;
  };

  A.game = game;
  A.profile = profile;
  A.gameView = () => gameView(game);
  A.startMission = gameAction(startMission);
  A.startEndless = gameAction(startEndless);
  A.startDaily = gameAction(startDaily);
  A.startFaultHunt = gameAction(startFaultHunt);
  A.abortGame = gameAction(abortGame);
  A.submitDiagnosis = gameAction(submitDiagnosis);
  A.replayLast = gameAction(replayLast);
  A.saveProfile = () => saveProfile(storage, profile);
  A.resetProfile = () => { resetProfile(profile); saveProfile(storage, profile); };
  A.setAudio = (on, volume) => {
    setEnabled(audio, on !== false);
    if (Number.isFinite(volume)) setVolume(audio, volume);
  };

  // ---- title strip --------------------------------------------------------------------------
  const clockEl = h('span', { class: 'tb__clock', text: '0:00:00' });
  const stateChip = h('span', { class: 'tb__state' },
    h('i', { class: 'lamp lamp--sm' }), h('b', { text: 'RUNNING' }));
  const loopChip = h('span', { class: 'tb__loop', text: 'PIC-101 · header pressure' });
  const alarmChip = h('button', {
    class: 'tb__alarms', type: 'button', title: 'Acknowledge all alarms (A)',
    onClick: () => A.ackAlarms(),
  }, h('i', { class: 'lamp lamp--sm' }), h('b', { text: 'NO ALARMS' }));

  const titlebar = h('div', { class: 'titlebar' },
    h('b', { class: 'tb__unit', text: 'DUAL PUMP SKID' }),
    h('span', { class: 'tb__sub', text: 'PID CONTROL TRAINER' }),
    loopChip,
    h('span', { class: 'tb__gap' }),
    clockEl, stateChip, alarmChip);

  // ---- toolbar ------------------------------------------------------------------------------
  const btnRun = h('button', {
    class: 'iconbtn', type: 'button', title: 'Run or freeze the plant (Space)',
    onClick: () => A.togglePause(),
  }, h('span', { class: 'iconbtn__glyph', text: '❚❚' }));
  const speedBtns = SPEEDS.map((x) => h('button', {
    class: 'chip', type: 'button', text: `${x}×`, title: `${x} simulated seconds per real second`,
    onClick: () => A.setSpeed(x),
  }));
  const loopBtns = [
    h('button', { class: 'chip', type: 'button', text: 'PIC pressure', title: 'Control header pressure. Slow: the surge vessel dominates.', onClick: () => A.setLoopMode(LOOP.PRESSURE) }),
    h('button', { class: 'chip', type: 'button', text: 'FIC flow', title: 'Control flow to process. Fast: the drive ramp dominates.', onClick: () => A.setLoopMode(LOOP.FLOW) }),
  ];
  // ==============================================================================================
  // THE VIEW REGISTRY
  //
  // Six views fitted on one row of chips. Twenty do not, and constructing twenty panes at boot in
  // order to show one of them is worse still — each is a few thousand DOM nodes or a canvas.
  //
  // So views are GROUPED and LAZY. The toolbar carries one row of groups; picking a group reveals
  // its views. A pane is built the first time it is asked for, by a dynamic import, and never
  // before — which also means a view whose module is missing or throws on construction shows a
  // placeholder saying exactly that, while the rest of the application boots unaffected. That
  // property is worth having permanently, not only while the thing is being built.
  //
  // `make` receives the imported module and returns the standard pane shape: { el, update }.
  // ==============================================================================================
  let view = 'pid';

  const VIEW_GROUPS = [
    {
      id: 'process',
      label: 'PROCESS',
      views: [
        { id: 'pid', label: 'P&ID', hint: 'The process schematic' },
        { id: 'curves', label: 'CURVES', hint: 'Head-capacity chart: where the operating point actually sits' },
      ],
    },
    {
      id: 'control',
      label: 'CONTROL',
      views: [
        { id: 'bode', label: 'BODE', hint: 'Open-loop, sensitivity and noise responses, with the margins marked where they are read' },
        { id: 'nyquist', label: 'NYQUIST', hint: 'The same response as one curve, and how close it comes to the point of instability' },
        { id: 'health', label: 'REPORTS', hint: 'Loop health, the event log and the run comparison' },
      ],
    },
    {
      id: 'learn',
      label: 'LEARN',
      views: [
        { id: 'arcade', label: 'SHIFTS', hint: 'The campaign, the daily challenge, endless mode and fault hunt', mod: './arcade.js', make: (m) => m.createArcade(ctx, A) },
        { id: 'lessons', label: 'LESSONS', hint: 'Guided exercises with measurable objectives' },
      ],
    },
  ];

  /** Every view, flattened, for lookup and for the keyboard cycle. */
  const VIEWS = VIEW_GROUPS.flatMap((g) => g.views.map((v) => ({ ...v, group: g.id })));
  /**
   * Find a view record.
   * @param {string} id the view id
   * @returns {?object} the record, or null
   */
  const viewById = (id) => VIEWS.find((v) => v.id === id) || null;

  let group = 'process';
  // The title carries the group's own name as well as its description. A screen reader computes
  // the accessible name from the title when there is one, so a title of "5 views" would leave the
  // control announced as "5 views" and nothing else — which is exactly the sort of detail that
  // makes an interface unusable without ever looking broken.
  const GROUP_HINT = {
    process: 'PROCESS — the plant itself: schematic, machine view, curves and boards',
    control: 'CONTROL — the loop: frequency response, margins, health, and your own trend data',
    program: 'PROGRAM — the station program: ladder logic, the tag database and recipes',
    plant: 'PLANT — asset condition: maintenance, instrument calibration and the crew',
    learn: 'LEARN — training: shifts, lessons, the manual and settings',
  };
  const groupBtns = VIEW_GROUPS.map((g) => h('button', {
    class: 'chip chip--grp',
    type: 'button',
    text: g.label,
    title: GROUP_HINT[g.id] || g.label,
    onClick: () => setGroup(g.id),
  }));
  const viewBtns = VIEWS.map((v) => h('button', {
    class: 'chip', type: 'button', text: v.label, title: v.hint, onClick: () => setView(v.id),
  }));

  const viewRow = h('div', { class: 'toolbar toolbar--views' }, viewBtns);
  const toolbar = h('div', { class: 'toolbar' },
    btnRun,
    h('span', { class: 'tb__grp' }, speedBtns),
    h('span', { class: 'tb__rule' }),
    h('span', { class: 'tb__grp' }, loopBtns),
    h('span', { class: 'tb__rule' }),
    h('span', { class: 'tb__grp' }, groupBtns),
    h('span', { class: 'tb__gap' }),
    h('button', { class: 'chip', type: 'button', text: 'Clear trend', onClick: () => A.clearTrend() }));

  // ---- alarm banner ---------------------------------------------------------------------------
  const banner = h('div', { class: 'alarmbar', hidden: true });

  // ---- workspace ------------------------------------------------------------------------------
  const mimic = createMimic(ctx, A);
  const curves = createCurves(ctx);
  const analysis = createAnalysis(ctx);
  const health = createHealth(ctx, A);
  const lessons = createLesson(ctx, A);
  const trend = createTrend(ctx);
  const rail = createRail(ctx, A);

  // The panes live in a Map keyed by view id. The six that ship in the core bundle are registered
  // eagerly because they are cheap and one of them is the landing view; everything else arrives
  // through `ensurePane` the first time it is selected.
  const stageTitle = h('span', { class: 'panel__title', text: 'P&ID' });
  const stageBody = h('div', { class: 'panel__body panel__body--stage' });
  /** @type {Map<string, {el: HTMLElement, update: function():void}>} */
  const panes = new Map();

  /**
   * Put a pane on the stage, hidden.
   * @param {string} id the view id it serves
   * @param {{el: HTMLElement, update: function():void}} pane the pane
   * @returns {object} the pane, for chaining
   */
  function registerPane(id, pane) {
    pane.el.hidden = true;
    stageBody.appendChild(pane.el);
    panes.set(id, pane);
    return pane;
  }

  registerPane('pid', mimic);
  registerPane('curves', curves);
  // One module serves two views; both ids point at the same pane and `setView` picks its mode.
  registerPane('bode', analysis);
  panes.set('nyquist', analysis);
  registerPane('health', health);
  registerPane('lessons', lessons);

  /**
   * Build a lazy pane on first use, or hand back the one already built.
   *
   * A failure here is deliberately not fatal: an unavailable view says so in its own pane and the
   * rest of the application carries on. Losing the whole workstation because one screen would not
   * load is not how a control system behaves.
   *
   * @param {object} v the view record
   * @returns {Promise<?object>} the pane, or null if the view has no module
   */
  async function ensurePane(v) {
    if (panes.has(v.id)) return panes.get(v.id);
    if (!v.mod) return null;

    const holder = h('div', { class: 'pane pane--pending' },
      h('p', { class: 'pane__msg', text: `Loading ${v.label}…` }));
    const slot = registerPane(v.id, { el: holder, update() {} });
    if (view === v.id) holder.hidden = false;

    try {
      const built = v.make(await import(v.mod));
      if (!built || !built.el) throw new Error('the module did not return a pane');
      built.el.hidden = slot.el.hidden;
      stageBody.replaceChild(built.el, slot.el);
      panes.set(v.id, built);
      return built;
    } catch (err) {
      holder.classList.add('pane--missing');
      holder.firstChild.textContent = `${v.label} is not available in this build.`;
      holder.appendChild(h('p', { class: 'pane__detail', text: String((err && err.message) || err) }));
      return slot;
    }
  }

  const stage = h('section', { class: 'panel panel--stage' },
    h('header', { class: 'panel__head' },
      stageTitle,
      h('span', { class: 'panel__tools' },
        h('span', { class: 'panel__note', id: 'stageNote' }))),
    stageBody);

  // The HUD lives in the trend's own header, because the trend IS the play field and a score
  // that reads somewhere else asks the player to look away from the thing they are steering.
  const hud = createHud(ctx, A);
  const trendPanel = h('section', { class: 'panel panel--trend' },
    h('header', { class: 'panel__head panel__head--hud' },
      h('span', { class: 'panel__title', text: 'TREND' }),
      hud.el),
    h('div', { class: 'panel__body panel__body--trend' }, trend.el));

  // UNDER the pens, not over them. The tolerance band is the largest thing the HUD paints and the
  // trace has to stay the crispest thing on the chart — which is the reason the trend offers two
  // painting slots rather than one.
  trend.setUnderlay((g2d, map) => hud.overlay(g2d, map));

  const workspace = h('div', { class: 'workspace' },
    h('div', { class: 'col col--main' }, stage, trendPanel),
    h('div', { class: 'col col--rail' }, rail.el));

  const status = h('div', { class: 'statusbar' },
    h('span', { class: 'status__note', text: ctx.run.lastNote }),
    h('span', { class: 'tb__gap' }),
    h('span', { class: 'status__diag' }));

  // ---- the command palette --------------------------------------------------------------------
  // Every action on the bound surface, searchable, on one keystroke. The rig has grown a lot of
  // controls across five rail tabs and several screens, and a palette is the difference between
  // knowing a feature exists and being able to reach it.
  const keyReg = createRegistry();

  // The palette enumerates whatever it is handed, so it is handed the ACTIONS and not the queries.
  // `gameView` and `summary` are things the interface asks, not things an operator does, and a
  // command called "Game view" that appears to run and visibly does nothing is worse than no
  // command at all. `raw`, `game` and `profile` are plumbing and are not callable.
  const NOT_A_COMMAND = new Set([
    'summary', 'tuningCandidates', 'deleteRun', 'toast', 'raw', 'game', 'profile', 'gameView',
  ]);
  const paletteActions = {};
  for (const name of Object.keys(A)) {
    if (!NOT_A_COMMAND.has(name) && typeof A[name] === 'function') paletteActions[name] = A[name];
  }

  const palette = createPalette({
    A: paletteActions,
    reg: keyReg,
    // View switching is a property of the shell, not of the sim, so it is contributed here rather
    // than living in the action surface.
    extra: () => VIEWS.map((v) => ({
      id: `view:${v.id}`,
      label: `Go to ${v.label}`,
      section: 'View',
      runnable: true,
      run: () => setView(v.id),
    })),
  });

  host.append(
    h('div', { class: 'shell' }, titlebar, toolbar, viewRow, banner, workspace, status),
    palette.el,
    toastLayer,
  );

  /** Views that size themselves; everything else has to be told how much room it may have. */
  const SELF_SIZING = new Set(['pid', 'curves', 'iso']);

  /**
   * Show one view and hide the rest, building it first if it has never been shown.
   * @param {string} v the view id
   * @returns {void}
   */
  function setView(v) {
    const rec = viewById(v);
    if (!rec) return;
    view = v;
    group = rec.group;

    // `bode` and `nyquist` share one pane, so hide by pane rather than by id or the shared pane
    // would be hidden by the sibling id that is not current.
    const wanted = panes.get(v) || null;
    for (const [id, pane] of panes) {
      if (id === 'nyquist') continue;
      pane.el.hidden = pane !== wanted;
    }
    if (v === 'bode' || v === 'nyquist') analysis.el.setMode(v === 'bode' ? 'BODE' : 'NYQUIST');
    cls(stage, 'is-tall', !SELF_SIZING.has(v));
    setText(stageTitle, rec.label);

    for (let i = 0; i < VIEWS.length; i += 1) {
      const shown = VIEWS[i].group === group;
      viewBtns[i].hidden = !shown;
      cls(viewBtns[i], 'is-on', VIEWS[i].id === v);
    }
    for (let i = 0; i < VIEW_GROUPS.length; i += 1) {
      cls(groupBtns[i], 'is-on', VIEW_GROUPS[i].id === group);
    }

    if (!panes.has(v)) ensurePane(rec);
  }

  /**
   * Switch to a group, landing on its first view.
   * @param {string} g the group id
   * @returns {void}
   */
  function setGroup(g) {
    const grp = VIEW_GROUPS.find((x) => x.id === g);
    if (grp) setView(grp.views[0].id);
  }

  setView('pid');

  // ---- event markers on the trend -------------------------------------------------------------
  ctx.bus.on('sequence', (msg) => trend.mark('stage', msg));
  ctx.bus.on('alarm', (a) => { if (a.sev === 'ALARM') trend.mark('alarm', a.message); });
  ctx.bus.on('scenario', (msg) => trend.mark('test', msg));
  ctx.bus.on('lesson', (msg) => { trend.mark('test', msg); toast(msg); });
  ctx.bus.on('scored', (r) => toast(`${r.scenario}: ${Math.round(r.score)} / 100`));
  ctx.bus.on('trip', (ev) => toast(`${ev.tag}: ${ev.message}`, 'alarm'));

  // ---- keyboard ---------------------------------------------------------------------------------
  globalThis.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      // One exception: the palette's own field must still answer Ctrl-K and Escape, or the only
      // way out of it is the mouse.
      const escaping = ev.key === 'Escape' || ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K'));
      if (!escaping) return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      if (palette.isOpen()) palette.close(); else palette.open();
      return;
    }
    if (ev.key === 'Escape' && palette.isOpen()) { ev.preventDefault(); palette.close(); return; }
    if (ev.key === ' ') { ev.preventDefault(); A.togglePause(); }
    else if (ev.key === 'a' || ev.key === 'A') A.ackAlarms();
    else if (ev.key >= '1' && ev.key <= '3') A.setSpeed(SPEEDS[Number(ev.key) - 1]);
    else if (ev.key === 'p' || ev.key === 'P') {
      // Within the group, because cycling twenty views one key-press at a time is not navigation.
      const inGroup = VIEWS.filter((v) => v.group === group);
      const i = inGroup.findIndex((v) => v.id === view);
      setView(inGroup[(i + 1) % inGroup.length].id);
    } else if (ev.key === 'g' || ev.key === 'G') {
      const i = VIEW_GROUPS.findIndex((g) => g.id === group);
      setGroup(VIEW_GROUPS[(i + 1) % VIEW_GROUPS.length].id);
    }
  });

  // ---- the frame loop ----------------------------------------------------------------------------
  const stageNote = host.querySelector('#stageNote');
  let last = performance.now();
  let fpsAcc = 0;
  let fpsN = 0;

  /**
   * One animation frame: advance the plant by the elapsed wall time, then repaint.
   * @param {number} now the frame timestamp, ms
   * @returns {void}
   */
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;
    fpsAcc += dt;
    fpsN += 1;

    sim.advance(ctx, dt);

    // --- title strip -----------------------------------------------------------------------
    setText(clockEl, clock(ctx.run.t_s));
    const running = ctx.run.state === 'RUNNING';
    setText(stateChip.lastChild, running ? 'RUNNING' : 'FROZEN');
    cls(stateChip.firstChild, 'is-run', running);
    cls(stateChip.firstChild, 'is-warn', !running);
    setText(btnRun.firstChild, running ? '❚❚' : '▶');
    setText(loopChip, ctx.run.mode === LOOP.FLOW
      ? 'FIC-101 · flow to process' : 'PIC-101 · header pressure');

    // A condition that came and went while nobody was looking still has to be announced. Standard
    // alarm practice is that an alarm stays on the list until it is ACKNOWLEDGED, not until it
    // clears — otherwise the one upset that mattered is the one nobody ever sees.
    const active = ctx.run.alarmList.filter((a) => a.active);
    const stale = ctx.run.alarmList.filter((a) => !a.active && !a.ack);
    const worst = ctx.run.worst;
    setText(alarmChip.lastChild, active.length
      ? `${active.length} ${worst === 'ALARM' ? 'ALARM' : 'WARNING'}${active.length === 1 ? '' : 'S'}`
      : (stale.length ? `${stale.length} UNACKNOWLEDGED` : 'NO ALARMS'));
    cls(alarmChip.firstChild, 'is-alarm', worst === 'ALARM');
    cls(alarmChip.firstChild, 'is-warn', worst === 'WARN' || (!active.length && stale.length > 0));
    cls(alarmChip, 'is-live', active.length > 0 || stale.length > 0);

    // --- alarm banner ----------------------------------------------------------------------
    const top = active[0] || stale[0] || null;
    banner.hidden = !top;
    if (top) {
      const more = (active.length + stale.length) - 1;
      setText(banner, `${top.active ? top.sev : `${top.sev} CLEARED`}  ${top.tag}  —  ${top.message}`
        + (more > 0 ? `   (+${more} more — press A to acknowledge)` : '   press A to acknowledge'));
      cls(banner, 'is-alarm', top.active && top.sev === 'ALARM');
      cls(banner, 'is-warn', top.active && top.sev === 'WARN');
      cls(banner, 'is-stale', !top.active);
    }

    // --- toolbar state ------------------------------------------------------------------------
    for (let i = 0; i < SPEEDS.length; i += 1) cls(speedBtns[i], 'is-on', ctx.run.speed === SPEEDS[i]);
    cls(loopBtns[0], 'is-on', ctx.run.mode === LOOP.PRESSURE);
    cls(loopBtns[1], 'is-on', ctx.run.mode === LOOP.FLOW);

    // --- the panes ---------------------------------------------------------------------------
    // Only the visible one is repainted. Each pane is a few thousand canvas or DOM operations,
    // and five of them a frame is the difference between sixty frames a second and a slideshow.
    const shown = panes.get(view);
    if (shown) shown.update();
    // The HUD builds itself hidden and leaves the decision to show it to whoever mounted it —
    // which is right, because only the shell knows whether a run is on. It appears the moment a
    // shift is armed and goes away again the moment it is over, so the trend header is a plain
    // header in free play.
    const gv = A.gameView();
    hud.setVisible(!!gv && gv.phase !== 'IDLE');
    hud.update(gv);
    trend.update();
    rail.update();

    const sm = sim.summary(ctx);
    setText(stageNote, `${num(ctx.plant.Qdemand_m3h, 1)} m³/h to process · `
      + `${num(ctx.plant.p_bar, 2)} bar · ${num(sm.electrical_kW, 2)} kW · `
      + `${num(sm.specific_kWh_m3, 3)} kWh/m³`
      + (sm.owner ? ` · ${sm.owner} owns the output` : ''));
    setText(status.firstChild, ctx.run.lastNote);
    if (fpsAcc > 0.5) {
      setText(status.lastChild, `${Math.round(fpsN / fpsAcc)} fps · `
        + `${ctx.run.diag.ticks} ticks/frame${ctx.run.deficit ? ' · BEHIND' : ''}`);
      fpsAcc = 0;
      fpsN = 0;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Handy from the console, and used by the tests' smoke check.
  globalThis.__skid = ctx;
  return ctx;
}
