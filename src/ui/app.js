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
import { h, setText, cls, clock, num } from './dom.js';
import { createMimic } from './mimic.js';
import { createCurves } from './curves.js';
import { createTrend } from './trend.js';
import { createRail } from './panels.js';

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
    'setTuning', 'setScan', 'startPump', 'stopPump', 'autoPump', 'resetPump', 'forceTrip',
    'setStaging', 'setDisturbance', 'beginAutotune', 'cancelAutotune', 'applyTuningRule',
    'beginScenario', 'cancelScenario', 'gradeNow', 'clearScore', 'ackAlarms', 'clearTrend',
  ];
  for (const name of NAMES) {
    A[name] = (...args) => {
      const res = sim[name](ctx, ...args);
      if (res && res.ok === false) toast(res.reason, 'warn');
      return res;
    };
  }
  return A;
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
  let view = 'pid';
  const viewBtns = [
    h('button', { class: 'chip', type: 'button', text: 'P&ID', title: 'The process schematic', onClick: () => setView('pid') }),
    h('button', { class: 'chip', type: 'button', text: 'CURVES', title: 'Head-capacity chart: where the operating point actually sits', onClick: () => setView('curves') }),
  ];
  const toolbar = h('div', { class: 'toolbar' },
    btnRun,
    h('span', { class: 'tb__grp' }, speedBtns),
    h('span', { class: 'tb__rule' }),
    h('span', { class: 'tb__grp' }, loopBtns),
    h('span', { class: 'tb__rule' }),
    h('span', { class: 'tb__grp' }, viewBtns),
    h('span', { class: 'tb__gap' }),
    h('button', { class: 'chip', type: 'button', text: 'Clear trend', onClick: () => A.clearTrend() }));

  // ---- alarm banner ---------------------------------------------------------------------------
  const banner = h('div', { class: 'alarmbar', hidden: true });

  // ---- workspace ------------------------------------------------------------------------------
  const mimic = createMimic(ctx, A);
  const curves = createCurves(ctx);
  const trend = createTrend(ctx);
  const rail = createRail(ctx, A);

  const stage = h('section', { class: 'panel panel--stage' },
    h('header', { class: 'panel__head' },
      h('span', { class: 'panel__title', text: 'PROCESS' }),
      h('span', { class: 'panel__tools' },
        h('span', { class: 'panel__note', id: 'stageNote' }))),
    h('div', { class: 'panel__body panel__body--stage' }, mimic.el, curves.el));
  curves.el.hidden = true;

  const trendPanel = h('section', { class: 'panel panel--trend' },
    h('header', { class: 'panel__head' },
      h('span', { class: 'panel__title', text: 'TREND' })),
    h('div', { class: 'panel__body panel__body--trend' }, trend.el));

  const workspace = h('div', { class: 'workspace' },
    h('div', { class: 'col col--main' }, stage, trendPanel),
    h('div', { class: 'col col--rail' }, rail.el));

  const status = h('div', { class: 'statusbar' },
    h('span', { class: 'status__note', text: ctx.run.lastNote }),
    h('span', { class: 'tb__gap' }),
    h('span', { class: 'status__diag' }));

  host.append(h('div', { class: 'shell' }, titlebar, toolbar, banner, workspace, status), toastLayer);

  /**
   * Switch the stage between the schematic and the curve chart.
   * @param {string} v 'pid' or 'curves'
   * @returns {void}
   */
  function setView(v) {
    view = v;
    mimic.el.hidden = v !== 'pid';
    curves.el.hidden = v !== 'curves';
    cls(viewBtns[0], 'is-on', v === 'pid');
    cls(viewBtns[1], 'is-on', v === 'curves');
  }
  setView('pid');

  // ---- event markers on the trend -------------------------------------------------------------
  ctx.bus.on('sequence', (msg) => trend.mark('stage', msg));
  ctx.bus.on('alarm', (a) => { if (a.sev === 'ALARM') trend.mark('alarm', a.message); });
  ctx.bus.on('scenario', (msg) => trend.mark('test', msg));
  ctx.bus.on('trip', (ev) => toast(`${ev.tag}: ${ev.message}`, 'alarm'));

  // ---- keyboard ---------------------------------------------------------------------------------
  globalThis.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.key === ' ') { ev.preventDefault(); A.togglePause(); }
    else if (ev.key === 'a' || ev.key === 'A') A.ackAlarms();
    else if (ev.key >= '1' && ev.key <= '3') A.setSpeed(SPEEDS[Number(ev.key) - 1]);
    else if (ev.key === 'p' || ev.key === 'P') setView(view === 'pid' ? 'curves' : 'pid');
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
    if (view === 'pid') mimic.update(); else curves.update();
    trend.update();
    rail.update();

    setText(stageNote, `${num(ctx.plant.Qtotal_m3h, 1)} m³/h total · `
      + `${num(ctx.plant.H_m, 1)} m header · ${num(ctx.plant.P_kW[0] + ctx.plant.P_kW[1], 2)} kW`);
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
