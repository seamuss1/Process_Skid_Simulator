/**
 * src/ui/panels.js — the right-hand rail: the controller faceplate, the tuning, the autotuner,
 * the staging sequence, the load, and the scorecard.
 *
 * Layer L6: imports `ui/dom.js`, reads the sim context and calls the action surface. Writes no
 * state of its own — every control routes through an action in `core/sim.js`, which validates and
 * can refuse, and the refusal is what the operator is shown.
 */

import {
  h, setText, cls, num, dur, panel, numField, slider, segmented, readout,
} from './dom.js';
import { MODE, ACTION } from '../control/pid.js';
import { SHARE, ROTATE } from '../control/staging.js';
import { TUNE, tuningRules } from '../control/autotune.js';
import { SCENARIOS } from '../control/scenario.js';
import { LOOP } from '../data/config.js';

/**
 * The controller faceplate: two bargraphs, three digits, the mode, and the output.
 * @param {object} ctx the sim context
 * @param {object} A the action surface
 * @returns {{el:HTMLElement, update:Function}} the view
 */
function faceplate(ctx, A) {
  const tag = h('b', { class: 'fp__tag', text: 'PIC-101' });
  const pvTrack = h('div', { class: 'fp__track' });
  const pvFill = h('i', { class: 'fp__fill fp__fill--pv' });
  const spMark = h('i', { class: 'fp__mark' });
  pvTrack.append(pvFill, spMark);
  const coTrack = h('div', { class: 'fp__track' });
  const coFill = h('i', { class: 'fp__fill fp__fill--co' });
  const coMark = h('i', { class: 'fp__mark fp__mark--stage' });
  coTrack.append(coFill, coMark);

  const pvVal = h('span', { class: 'fp__num fp__num--pv', text: '—' });
  const spVal = h('span', { class: 'fp__num fp__num--sp', text: '—' });
  const coVal = h('span', { class: 'fp__num fp__num--co', text: '—' });
  const unit = h('span', { class: 'fp__unit', text: 'bar' });

  const spIn = h('input', {
    class: 'fp__spin', type: 'number', step: '0.05',
    onChange: () => {
      const v = Number.parseFloat(spIn.value);
      if (Number.isFinite(v)) A.setSetpoint(v);
    },
  });
  const nudge = (d) => h('button', {
    class: 'btn btn--sq', type: 'button', text: d > 0 ? '▲' : '▼',
    title: `${d > 0 ? 'Raise' : 'Lower'} the setpoint`,
    onClick: () => A.setSetpoint(ctx.pid.spTarget + d * (ctx.run.mode === LOOP.FLOW ? 1 : 0.05)),
  });

  const modeSeg = segmented(
    [{ id: MODE.AUTO, label: 'AUTO', hint: 'The algorithm owns the output' },
      { id: MODE.MAN, label: 'MAN', hint: 'You own the output; the algorithm tracks it, so the transfer back is bumpless' }],
    MODE.AUTO, (id) => A.setControllerMode(id),
  );
  const coSlider = h('input', {
    class: 'fp__co', type: 'range', min: 0, max: 100, step: 0.5, value: '40',
    title: 'Manual output. Available in MAN.',
    onInput: () => A.setManualOutput(Number.parseFloat(coSlider.value)),
  });

  const flags = h('div', { class: 'fp__flags' });
  const fSat = h('span', { class: 'flag', text: 'SAT', title: 'The output is pinned against a limit' });
  const fWind = h('span', { class: 'flag', text: 'AW', title: 'Anti-windup is unwinding the integral' });
  const fCav = h('span', { class: 'flag', text: 'CAV', title: 'A running pump is cavitating' });
  const fTune = h('span', { class: 'flag', text: 'TUNE', title: 'The autotuner has the output' });
  flags.append(fSat, fWind, fCav, fTune);

  // The three terms, shown live. Nothing explains integral action faster than watching the I bar
  // fill while the P bar sits still.
  const term = (label, hint) => {
    const bar = h('i', { class: 'term__bar' });
    const val = h('span', { class: 'term__val', text: '0.0' });
    const el = h('div', { class: 'term', title: hint },
      h('span', { class: 'term__label', text: label }),
      h('span', { class: 'term__track' }, bar), val);
    el.set = (v) => {
      const f = Math.max(-1, Math.min(1, v / 100));
      bar.style.left = `${(f < 0 ? 50 + f * 50 : 50)}%`;
      bar.style.width = `${Math.abs(f) * 50}%`;
      setText(val, num(v, 1));
    };
    return el;
  };
  const tP = term('P', 'Proportional term, output percent. Acts on b·SP − PV.');
  const tI = term('I', 'Integral term. This is what removes offset, and this is what winds up.');
  const tD = term('D', 'Derivative term. Acts on c·SP − PV, rolled off at Td/N.');

  const el = panel('CONTROLLER', { cls: 'panel--fp' },
    h('div', { class: 'fp__head' }, tag, flags),
    h('div', { class: 'fp__body' },
      h('div', { class: 'fp__bars' },
        h('div', { class: 'fp__barwrap' }, pvTrack, h('span', { class: 'fp__cap', text: 'PV' })),
        h('div', { class: 'fp__barwrap' }, coTrack, h('span', { class: 'fp__cap', text: 'CO' }))),
      h('div', { class: 'fp__digits' },
        h('div', { class: 'fp__row' }, h('span', { class: 'fp__lbl', text: 'PV' }), pvVal, unit),
        h('div', { class: 'fp__row' }, h('span', { class: 'fp__lbl', text: 'SP' }), spVal,
          h('span', { class: 'fp__sp' }, nudge(-1), spIn, nudge(+1))),
        h('div', { class: 'fp__row' }, h('span', { class: 'fp__lbl', text: 'CO' }), coVal,
          h('span', { class: 'fp__unit', text: '%' })))),
    h('div', { class: 'fp__ctl' }, modeSeg, coSlider),
    h('div', { class: 'fp__terms' }, tP, tI, tD));

  let spFocused = false;
  spIn.addEventListener('focus', () => { spFocused = true; });
  spIn.addEventListener('blur', () => { spFocused = false; });

  const update = () => {
    const eu = ctx.run.mode === LOOP.FLOW
      ? { tag: 'FIC-101', unit: 'm³/h', lo: 0, hi: 150, dp: 1 }
      : { tag: 'PIC-101', unit: 'bar', lo: 0, hi: 8, dp: 2 };
    const pid = ctx.pid;
    const pv = ctx.run.mode === LOOP.FLOW ? ctx.plant.ft_m3h : ctx.plant.pt_bar;
    setText(tag, eu.tag);
    setText(unit, eu.unit);
    setText(pvVal, num(pv, eu.dp));
    setText(spVal, num(pid.sp, eu.dp));
    setText(coVal, num(pid.co, 1));
    if (!spFocused) spIn.value = String(Number(pid.spTarget.toFixed(eu.dp)));
    spIn.step = String(ctx.run.mode === LOOP.FLOW ? 1 : 0.05);

    const f = (v) => `${Math.max(0, Math.min(100, ((v - eu.lo) / (eu.hi - eu.lo)) * 100))}%`;
    pvFill.style.height = f(pv);
    spMark.style.bottom = f(pid.sp);
    coFill.style.height = `${Math.max(0, Math.min(100, pid.co))}%`;
    coMark.style.bottom = `${ctx.stagingCfg.stageUp_pct}%`;
    cls(pvFill, 'is-alarm', ctx.run.worst === 'ALARM');

    modeSeg.select(pid.mode);
    coSlider.disabled = pid.mode !== MODE.MAN;
    if (pid.mode !== MODE.MAN) coSlider.value = String(pid.co);

    cls(fSat, 'is-on', pid.saturated);
    cls(fWind, 'is-on', pid.windupActive);
    cls(fCav, 'is-on', ctx.plant.cav[0] < 0.999 || ctx.plant.cav[1] < 0.999);
    cls(fTune, 'is-on', ctx.autotune.phase === TUNE.CYCLING || ctx.autotune.phase === TUNE.SETTLING);

    tP.set(pid.prop);
    tI.set(pid.integ);
    tD.set(pid.deriv);
  };
  return { el, update };
}

/**
 * The tuning panel.
 * @param {object} ctx the sim context
 * @param {object} A the action surface
 * @returns {{el:HTMLElement, update:Function}} the view
 */
function tuningPanel(ctx, A) {
  const c = ctx.pidCfg;
  const f = (label, key, opts) => numField({
    label, value: c[key], ...opts, onCommit: (v) => A.setTuning({ [key]: v }),
  });

  const fields = {
    Kc: f('Gain  Kc', 'Kc', { step: 0.5, unit: '%/EU', hint: 'Proportional gain in the ISA standard form: it multiplies all three terms.' }),
    Ti: f('Reset  Ti', 'Ti', { step: 0.5, min: 0.1, unit: 's', hint: 'Integral time, seconds per repeat. Larger is weaker. Set it very large to run P-only.' }),
    Td: f('Rate  Td', 'Td', { step: 0.1, min: 0, unit: 's', hint: 'Derivative time. Zero disables it. On a noisy pressure signal, be careful.' }),
    N: f('D filter  N', 'N', { step: 1, min: 2, max: 100, unit: '', hint: 'The derivative rolls off at Td/N. Ten is the usual choice; lower filters harder.' }),
    b: f('SP weight  b', 'b', { step: 0.1, min: 0, max: 1, unit: '', hint: 'Proportional setpoint weight. Below 1 it softens setpoint response WITHOUT touching disturbance rejection — the most useful knob here.' }),
    c: f('SP weight  c', 'c', { step: 0.1, min: 0, max: 1, unit: '', hint: 'Derivative setpoint weight. Zero is derivative-on-measurement. Set it to 1 to see the classic derivative kick.' }),
    pvFilter_s: f('PV filter', 'pvFilter_s', { step: 0.1, min: 0, unit: 's', hint: 'A filter inside the controller. Cuts output travel on a noisy measurement, at the cost of phase lag.' }),
    deadband: f('Deadband', 'deadband', { step: 0.01, min: 0, unit: 'EU', hint: 'Error inside this band is treated as zero. Saves the drive; guarantees an offset.' }),
    spRate: f('SP ramp', 'spRate', { step: 0.01, min: 0, unit: 'EU/s', hint: 'Rate-limits the setpoint. Zero steps it.' }),
    outRate: f('CO rate limit', 'outRate', { step: 0.5, min: 0, unit: '%/s', hint: 'Rate-limits the output. Anti-windup unwinds the integral while it is active.' }),
    outLo: f('CO low limit', 'outLo', { step: 1, unit: '%', hint: 'Output low limit.' }),
    outHi: f('CO high limit', 'outHi', { step: 1, unit: '%', hint: 'Output high limit.' }),
  };

  const actSeg = segmented(
    [{ id: ACTION.REVERSE, label: 'REVERSE', hint: 'Output rises when the measurement falls below setpoint — correct for a pump' },
      { id: ACTION.DIRECT, label: 'DIRECT', hint: 'Output rises when the measurement rises. Wrong here; try it once and watch it run away.' }],
    c.action, (id) => A.setTuning({ action: id }),
  );
  const scanSeg = segmented(
    [0.1, 0.2, 0.5, 1].map((v) => ({ id: String(v), label: `${v}s`, hint: `Controller scan period ${v} s` })),
    String(ctx.config.scan_s), (id) => A.setScan(Number(id)),
  );

  const el = panel('TUNING', { cls: 'panel--tune' },
    h('div', { class: 'grid2' }, fields.Kc, fields.Ti, fields.Td, fields.N),
    h('div', { class: 'grid2' }, fields.b, fields.c, fields.pvFilter_s, fields.deadband),
    h('div', { class: 'grid2' }, fields.spRate, fields.outRate, fields.outLo, fields.outHi),
    h('div', { class: 'row' }, h('span', { class: 'row__label', text: 'Action' }), actSeg),
    h('div', { class: 'row' }, h('span', { class: 'row__label', text: 'Scan' }), scanSeg));

  const update = () => {
    for (const k of Object.keys(fields)) {
      const inp = fields[k].input;
      if (document.activeElement !== inp) {
        const want = String(Number(Number(c[k]).toFixed(4)));
        if (inp.value !== want) inp.value = want;
      }
    }
    actSeg.select(c.action);
    scanSeg.select(String(ctx.config.scan_s));
  };
  return { el, update };
}

/**
 * The autotuner panel: the relay experiment and the rules it feeds.
 * @param {object} ctx the sim context
 * @param {object} A the action surface
 * @returns {{el:HTMLElement, update:Function}} the view
 */
function autotunePanel(ctx, A) {
  let amp = 12;
  const ampField = numField({
    label: 'Relay amplitude  d', unit: '%', value: amp, step: 1, min: 1, max: 40,
    hint: 'How far the relay swings the output either side of the current operating point. '
      + 'Bigger gives a cleaner measurement and a bigger upset.',
    onCommit: (v) => { amp = v; },
  });
  const status = h('p', { class: 'note', text: 'idle' });
  const result = h('div', { class: 'at__result' });
  const rules = h('div', { class: 'at__rules' });

  const btnStart = h('button', {
    class: 'btn btn--primary', type: 'button', text: 'Run relay autotune',
    title: 'Swings the output about the current point until the loop cycles, then reads the '
      + 'ultimate gain and period off the oscillation.',
    onClick: () => A.beginAutotune({ d: amp }),
  });
  const btnStop = h('button', {
    class: 'btn', type: 'button', text: 'Abort', hidden: true,
    onClick: () => A.cancelAutotune(),
  });

  const el = panel('AUTOTUNE', { cls: 'panel--at' },
    ampField,
    h('div', { class: 'row row--btns' }, btnStart, btnStop),
    status, result, rules);

  let shownFor = null;
  const update = () => {
    const at = ctx.autotune;
    const busy = at.phase === TUNE.CYCLING || at.phase === TUNE.SETTLING;
    btnStart.hidden = busy;
    btnStop.hidden = !busy;
    setText(status, at.message);
    cls(status, 'is-alarm', at.phase === TUNE.FAILED);
    cls(status, 'is-ok', at.phase === TUNE.DONE);

    if (at.phase === TUNE.DONE) {
      const key = `${at.Ku}:${at.Tu}`;
      if (shownFor !== key) {
        shownFor = key;
        result.textContent = '';
        result.append(
          readout('Ku', '%/EU', 'Ultimate gain: the proportional gain at which this loop would oscillate forever.'),
          readout('Tu', 's', 'Ultimate period: how long one of those oscillations takes.'),
          readout('AMPL', 'EU', 'Peak-to-peak swing the relay produced.'),
        );
        result.children[0].set(num(at.Ku, 1));
        result.children[1].set(num(at.Tu, 2));
        result.children[2].set(num(at.amplitude, 3));
        rules.textContent = '';
        for (const r of tuningRules(at.Ku, at.Tu)) {
          rules.appendChild(h('div', { class: 'rule' },
            h('div', { class: 'rule__head' },
              h('b', { class: 'rule__name', text: r.name }),
              h('button', {
                class: 'btn btn--sm', type: 'button', text: 'Apply',
                onClick: () => A.applyTuningRule(r.id),
              })),
            h('div', { class: 'rule__nums' },
              `Kc ${num(r.Kc, 2)}   Ti ${num(r.Ti, 1)} s   Td ${num(r.Td, 2)} s`),
            h('p', { class: 'rule__note', text: r.note })));
        }
      }
    } else if (at.phase !== TUNE.DONE && shownFor && !busy) {
      shownFor = null;
    }
  };
  return { el, update };
}

/**
 * The staging sequence panel.
 * @param {object} ctx the sim context
 * @param {object} A the action surface
 * @returns {{el:HTMLElement, update:Function}} the view
 */
function stagingPanel(ctx, A) {
  const c = ctx.stagingCfg;
  const f = (label, key, opts) => numField({
    label, value: c[key], ...opts, onCommit: (v) => A.setStaging({ [key]: v }),
  });
  const fields = {
    stageUp_pct: f('Stage up above', 'stageUp_pct', { step: 1, min: 0, max: 100, unit: '%', hint: 'Output above which the stage-up timer runs.' }),
    stageUpDelay_s: f('held for', 'stageUpDelay_s', { step: 1, min: 0, unit: 's', hint: 'How long the output must stay there. Too short and a transient stages a pump.' }),
    stageDown_pct: f('Stage down below', 'stageDown_pct', { step: 1, min: 0, max: 100, unit: '%', hint: 'Output below which the stage-down timer runs. The gap to the stage-up threshold is the hysteresis band.' }),
    stageDownDelay_s: f('held for', 'stageDownDelay_s', { step: 1, min: 0, unit: 's', hint: 'Longer than the stage-up delay, by convention: stopping a machine should be harder than starting one.' }),
    stageUpBias: f('Bias on stage up', 'stageUpBias', { step: 0.02, min: 0.3, max: 1, unit: '×', hint: 'The output is multiplied by this the instant a pump joins, because two machines at one speed make far more flow than one. Set it to 1 to see the surge it prevents.' }),
    stageDownBias: f('Bias on stage down', 'stageDownBias', { step: 0.02, min: 1, max: 2.5, unit: '×', hint: 'The matching kick the other way when a machine leaves.' }),
    minRun_s: f('Minimum run', 'minRun_s', { step: 5, min: 0, unit: 's', hint: 'A started pump will not stop for this long, whatever the loop wants. The last defence against short-cycling.' }),
    minStop_s: f('Minimum stop', 'minStop_s', { step: 5, min: 0, unit: 's', hint: 'A stopped pump will not restart for this long.' }),
  };
  const shareSeg = segmented(
    [{ id: SHARE.COMMON, label: 'COMMON SPEED', hint: 'Every running machine takes the same speed. Correct for identical pumps in parallel.' },
      { id: SHARE.BASE_TRIM, label: 'BASE / TRIM', hint: 'The lag runs at a fixed base speed and the lead modulates around it.' }],
    c.share, (id) => A.setStaging({ share: id }),
  );
  const rotSeg = segmented(
    [{ id: ROTATE.OFF, label: 'OFF', hint: 'Never swap lead' },
      { id: ROTATE.ON_STAGE_DOWN, label: 'ON STOP', hint: 'Swap lead whenever the plant drops to one machine' },
      { id: ROTATE.RUNTIME, label: 'RUNTIME', hint: 'Make-before-break changeover once the runtime gap opens up' }],
    c.rotate, (id) => A.setStaging({ rotate: id }),
  );
  const enable = h('button', {
    class: 'btn', type: 'button', text: 'SEQUENCE ENABLED',
    title: 'Turn the sequence off to drive both machines by hand',
    onClick: () => A.setStaging({ enabled: !ctx.stagingCfg.enabled }),
  });
  const state = h('p', { class: 'note' });
  const timers = h('div', { class: 'grid2' });
  const tUp = readout('UP TIMER', 's', 'How long the output has been above the stage-up threshold');
  const tDn = readout('DOWN TIMER', 's', 'How long it has been below the stage-down threshold');
  const tLead = readout('LEAD', '', 'The machine the sequence is modulating');
  const tTrans = readout('TRANSITIONS', '', 'Starts and stops so far. Short-cycling shows here first.');
  timers.append(tUp, tDn, tLead, tTrans);

  const el = panel('SEQUENCE', { cls: 'panel--seq' },
    h('div', { class: 'row row--btns' }, enable),
    h('div', { class: 'grid2' }, fields.stageUp_pct, fields.stageUpDelay_s,
      fields.stageDown_pct, fields.stageDownDelay_s),
    h('div', { class: 'grid2' }, fields.stageUpBias, fields.stageDownBias,
      fields.minRun_s, fields.minStop_s),
    h('div', { class: 'row' }, h('span', { class: 'row__label', text: 'Sharing' }), shareSeg),
    h('div', { class: 'row' }, h('span', { class: 'row__label', text: 'Rotation' }), rotSeg),
    timers, state);

  const update = () => {
    for (const k of Object.keys(fields)) {
      const inp = fields[k].input;
      if (document.activeElement !== inp) {
        const want = String(Number(Number(c[k]).toFixed(3)));
        if (inp.value !== want) inp.value = want;
      }
    }
    shareSeg.select(c.share);
    rotSeg.select(c.rotate);
    setText(enable, c.enabled ? 'SEQUENCE ENABLED' : 'SEQUENCE OFF');
    cls(enable, 'is-on', c.enabled);
    tUp.set(num(ctx.staging.upTimer_s, 1));
    tDn.set(num(ctx.staging.downTimer_s, 1));
    tLead.set(ctx.config.pumps[ctx.staging.lead].tag);
    tTrans.set(String(ctx.staging.transitions));
    setText(state, ctx.staging.lastAction);
  };
  return { el, update };
}

/**
 * The load and disturbance panel — everything the operator can do TO the plant.
 * @param {object} ctx the sim context
 * @param {object} A the action surface
 * @returns {{el:HTMLElement, update:Function}} the view
 */
function loadPanel(ctx, A) {
  const p = ctx.plant;
  const sDemand = slider({
    label: 'FCV-101 demand', unit: '%', value: p.demandTarget * 100, min: 0, max: 100, step: 1, dp: 0,
    hint: 'The downstream user. This is the LOAD, not the final control element — moving it is '
      + 'the disturbance the loop has to reject. Past about 70% one machine cannot hold setpoint.',
    onInput: (v) => A.setDisturbance({ demandTarget: v / 100 }),
  });
  const sHead = slider({
    label: 'Discharge static head', unit: 'm', value: p.hDischarge_m, min: 0, max: 40, step: 0.5, dp: 1,
    hint: 'Back pressure the process presents. Raising it steepens the system curve and eats the '
      + 'available turndown.',
    onInput: (v) => A.setDisturbance({ hDischarge_m: v }),
  });
  const sTemp = slider({
    label: 'Liquid temperature', unit: '°C', value: p.T_C, min: 4, max: 98, step: 1, dp: 0,
    hint: 'Sets vapour pressure, and so the suction margin. Above about 95 °C this rig cavitates '
      + 'on temperature alone.',
    onInput: (v) => A.setDisturbance({ T_C: v }),
  });
  const sFoul = slider({
    label: 'Suction strainer blinding', unit: '%', value: p.foul * 100, min: 0, max: 95, step: 1, dp: 0,
    hint: 'Blinds the strainers. Loss goes with the square of flow, so the last 10% of blinding '
      + 'costs more than the first 70%.',
    onInput: (v) => A.setDisturbance({ foul: v / 100 }),
  });
  const sByp = slider({
    label: 'RO-101 recirculation', unit: '%', value: p.bypass * 100, min: 0, max: 100, step: 1, dp: 0,
    hint: 'The minimum-flow line back to the tank. Closing it fully lets a lightly loaded pump '
      + 'run below its minimum continuous flow.',
    onInput: (v) => A.setDisturbance({ bypass: v / 100 }),
  });
  const sLevel = slider({
    label: 'TK-101 level', unit: 'm', value: p.level_m, min: 0, max: ctx.config.tank.height_m, step: 0.05, dp: 2,
    hint: 'Only settable with the make-up controller in manual.',
    onInput: (v) => A.setDisturbance({ level_m: v }),
  });
  const makeup = h('button', {
    class: 'btn', type: 'button', text: 'MAKE-UP AUTO',
    title: 'The make-up controller holds the tank level. Switch it off to let the level drift and '
      + 'watch the suction margin go with it.',
    onClick: () => A.setDisturbance({ makeupAuto: !ctx.plant.makeupAuto }),
  });

  const tests = h('div', { class: 'tests' });
  for (const sc of SCENARIOS) {
    tests.appendChild(h('button', {
      class: 'btn btn--sm btn--wide', type: 'button', text: sc.name, title: sc.blurb,
      onClick: () => A.beginScenario(sc.id),
    }));
  }
  const testState = h('p', { class: 'note' });
  const btnAbort = h('button', {
    class: 'btn btn--sm', type: 'button', text: 'Abort test', hidden: true,
    onClick: () => A.cancelScenario(),
  });

  const el = panel('LOAD & UPSETS', { cls: 'panel--load' },
    sDemand, sHead, sTemp, sFoul, sByp,
    h('div', { class: 'row row--btns' }, makeup), sLevel,
    h('div', { class: 'panel__sub', text: 'SCRIPTED TESTS' }),
    tests, h('div', { class: 'row row--btns' }, btnAbort), testState);

  const update = () => {
    const active = document.activeElement;
    const sync = (row, v) => {
      if (active === row.input) return;
      const want = String(Number(v.toFixed(4)));
      if (row.input.value !== want) {
        row.input.value = want;
        setText(row.read, `${num(v, row.dp)}${row.unit ? ` ${row.unit}` : ''}`);
      }
    };
    sync(sDemand, ctx.plant.demandTarget * 100);
    sync(sHead, ctx.plant.hDischarge_m);
    sync(sTemp, ctx.plant.T_C);
    sync(sFoul, ctx.plant.foul * 100);
    sync(sByp, ctx.plant.bypass * 100);
    sync(sLevel, ctx.plant.level_m);
    sLevel.input.disabled = ctx.plant.makeupAuto;
    cls(sLevel, 'is-disabled', ctx.plant.makeupAuto);
    setText(makeup, ctx.plant.makeupAuto ? 'MAKE-UP AUTO' : 'MAKE-UP MANUAL');
    cls(makeup, 'is-on', ctx.plant.makeupAuto);

    const sc = ctx.scenario;
    btnAbort.hidden = !sc.def;
    if (sc.def) {
      const left = Math.max(0, sc.def.duration_s - sc.elapsed_s);
      setText(testState, `${sc.def.name} — ${dur(left)} remaining`);
    } else {
      setText(testState, sc.last ? `last: ${sc.last.scenario}, scored ${num(sc.last.score, 1)}/100` : '');
    }
  };
  return { el, update };
}

/**
 * The scorecard.
 * @param {object} ctx the sim context
 * @param {object} A the action surface
 * @returns {{el:HTMLElement, update:Function}} the view
 */
function scorePanel(ctx, A) {
  const live = h('div', { class: 'grid2' });
  const mIae = readout('IAE', 'EU·s', 'Integral of absolute error since the scorecard was last cleared.');
  const mTravel = readout('CO TRAVEL', '%', 'Total variation of the output. The wear term.');
  const mStarts = readout('STARTS', '', 'Pump starts and stops.');
  const mkWh = readout('SPECIFIC', 'kWh/m³', 'Shaft energy per cubic metre delivered. The number a plant manager asks about.');
  live.append(mIae, mTravel, mStarts, mkWh);

  const scoreBig = h('div', { class: 'score__big' },
    h('span', { class: 'score__num', text: '—' }),
    h('span', { class: 'score__den', text: '/100' }));
  const scoreName = h('p', { class: 'note' });
  const breakdown = h('div', { class: 'score__parts' });
  const steps = h('div', { class: 'score__steps' });

  const el = panel('SCORECARD', {
    tools: [
      h('button', { class: 'btn btn--sm', type: 'button', text: 'Score now', title: 'Grade whatever has accumulated so far', onClick: () => A.gradeNow() }),
      h('button', { class: 'btn btn--sm', type: 'button', text: 'Clear', onClick: () => A.clearScore() }),
    ],
  }, live, scoreBig, scoreName, breakdown, steps);

  let shown = null;
  const update = () => {
    const m = ctx.scenario.m;
    mIae.set(num(m.iae, 2));
    mTravel.set(num(m.coTravel, 0));
    mStarts.set(String(m.starts));
    mkWh.set(m.volume_m3 > 0.01 ? num(m.energy_kWh / m.volume_m3, 4) : '—');

    const r = ctx.scenario.last;
    if (!r) return;
    if (shown === r) return;
    shown = r;
    setText(scoreBig.firstChild, num(r.score, 1));
    cls(scoreBig, 'is-good', r.score >= 75);
    cls(scoreBig, 'is-poor', r.score < 45);
    setText(scoreName, `${r.scenario} over ${dur(r.t_s)} — `
      + `${num(r.iae, 1)} EU·s error, ${num(r.coTravel, 0)}% output travel, ${r.starts} starts`);
    breakdown.textContent = '';
    for (const p of r.parts) {
      const row = h('div', { class: 'part' },
        h('span', { class: 'part__label', text: p.label }),
        h('span', { class: 'part__track' },
          h('i', {
            class: 'part__fill',
            style: { width: `${Number.isFinite(p.earned) ? (p.earned / Math.max(p.weight, 1)) * 100 : 0}%` },
          })),
        h('span', {
          class: 'part__val',
          text: Number.isFinite(p.earned) ? `${num(p.earned, 0)}` : 'n/a',
          title: `reference ${p.ref}`,
        }));
      cls(row, 'is-na', !p.applicable);
      breakdown.appendChild(row);
    }
    steps.textContent = '';
    for (const st of r.steps) {
      steps.appendChild(h('div', { class: 'step' },
        h('b', { text: st.label }),
        h('span', {
          text: `${st.kind === 'servo' && Number.isFinite(st.overshootPct)
            ? `overshoot ${num(st.overshootPct, 0)}%, ` : ''}`
            + `peak deviation ${num(st.peakDev, 3)}, settled in ${dur(st.settle_s)}`,
        })));
    }
    if (r.penalties.cavitation > 0.1 || r.penalties.minFlow > 0.1) {
      steps.appendChild(h('div', { class: 'step step--bad' },
        h('b', { text: 'Protection penalties' }),
        h('span', {
          text: `${num(r.penalties.cavitation, 1)} for ${dur(r.cavTime_s)} cavitating, `
            + `${num(r.penalties.minFlow, 1)} for ${dur(r.minFlowTime_s)} below minimum flow`,
        })));
    }
  };
  return { el, update };
}

/**
 * Build the whole right-hand rail.
 * @param {object} ctx the sim context
 * @param {object} A the action surface
 * @returns {{el:HTMLElement, update:Function}} the rail
 */
export function createRail(ctx, A) {
  const views = [
    faceplate(ctx, A), tuningPanel(ctx, A), autotunePanel(ctx, A),
    stagingPanel(ctx, A), loadPanel(ctx, A), scorePanel(ctx, A),
  ];
  const el = h('div', { class: 'rail' }, views.map((v) => v.el));
  return { el, update: () => { for (const v of views) v.update(); } };
}
