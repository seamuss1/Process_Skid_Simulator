/**
 * src/ui/panels.js — the control rail: every panel an operator or engineer touches, grouped into
 * four tabs so the whole surface is reachable without a rail three screens long.
 *
 * Layer L6. Reads the sim context; writes through the bound actions in `A` and nothing else.
 *
 * ------------------------------------------------------------------------------------------
 * THE RULE THIS FILE OBEYS
 *
 * No panel here writes a field on `plant`, `pid`, `stagingCfg` or `run`. Every control calls an
 * action in `core/sim.js`, which validates and may refuse with a sentence. That is not ceremony:
 * it is what lets the rig say "a series controller cannot express Ti 6 s with Td 2 s" instead of
 * quietly accepting a tuning it will then not implement.
 *
 * WHY TABS. The rail carries a controller faceplate, tuning in three forms, a control strategy,
 * three identification experiments and their ranked results, the sequence, the load, the machines,
 * the energy meter, the scorecard and the exports. Stacked, that is a very long column and the
 * thing you want is always off screen. Grouped, each tab is one job: RUN the loop, TUNE it, work
 * the PLANT, or TEST what you have done.
 * ------------------------------------------------------------------------------------------
 */

import {
  h, setText, cls, num, dur, panel, numField, slider, segmented, readout,
} from './dom.js';
import { MODE, FORM, ALGO, convertForm } from '../control/pid.js';
import { STRUCTURE, SCHED_ON } from '../control/strategy.js';
import { HAND, SHARE, ROTATE, CRITERION } from '../control/staging.js';
import { SCENARIOS } from '../control/scenario.js';
import { TUNE, STEP } from '../control/autotune.js';
import { SWEEP } from '../control/analysis.js';
import { RECIRC, FINAL, minimumFlow, throttleRange } from '../process/plant.js';
import { DRIVE } from '../process/motor.js';
import { FLUIDS } from '../process/fluid.js';
import { vibrationZone } from '../process/pump.js';
import {
  trendToCsv, scorecardToCsv, comparisonToCsv, compareRuns, sessionSnapshot, applySession,
  download, timestampedName, readSessionFile,
} from '../io/export.js';
import { TREND_UNITS } from '../core/sim.js';
import { LOOP_EU } from '../data/config.js';

// ==============================================================================================
// RUN — the faceplate, the setpoint, the mode
// ==============================================================================================

/**
 * The controller faceplate: PV, SP, output, mode, and the three terms broken out.
 *
 * The term breakdown is the part most faceplates omit and the part that teaches most. A loop
 * sitting still with a large proportional term and a large opposite integral term is doing
 * something quite different from one sitting still with both near zero, and only one of those is
 * healthy.
 *
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function faceplate(ctx, A) {
  const pvBar = h('i', { class: 'fpbar__fill' });
  const spTick = h('i', { class: 'fpbar__tick' });
  const coBar = h('i', { class: 'fpbar__fill fpbar__fill--co' });

  const pvVal = h('b', { class: 'fp__pv', text: '—' });
  const pvUnit = h('span', { class: 'fp__unit', text: 'bar' });
  const spInput = h('input', {
    class: 'fp__sp', type: 'number', step: '0.05',
    onChange: () => A.setSetpoint(Number.parseFloat(spInput.value)),
    onKeydown: (ev) => { if (ev.key === 'Enter') spInput.blur(); },
  });
  const coInput = h('input', {
    class: 'fp__co', type: 'number', step: '1', min: '0', max: '100',
    onChange: () => A.setManualOutput(Number.parseFloat(coInput.value)),
    onKeydown: (ev) => { if (ev.key === 'Enter') coInput.blur(); },
  });
  const modeSeg = segmented([
    { id: MODE.AUTO, label: 'AUTO', hint: 'The controller holds setpoint.' },
    { id: MODE.MAN, label: 'MAN', hint: 'You hold the output. Transfers are bumpless in both directions.' },
  ], MODE.AUTO, (m) => A.setControllerMode(m));

  const terms = h('div', { class: 'fp__terms' });
  const tP = h('span', { class: 'term' }, h('i', { text: 'P' }), h('b', { text: '—' }));
  const tI = h('span', { class: 'term' }, h('i', { text: 'I' }), h('b', { text: '—' }));
  const tD = h('span', { class: 'term' }, h('i', { text: 'D' }), h('b', { text: '—' }));
  const tF = h('span', { class: 'term' }, h('i', { text: 'FF' }), h('b', { text: '—' }));
  terms.append(tP, tI, tD, tF);
  const flags = h('div', { class: 'fp__flags' });

  const el = panel('CONTROLLER', { cls: 'panel--fp' },
    h('div', { class: 'fp__row' },
      h('div', { class: 'fp__big' }, pvVal, pvUnit),
      h('div', { class: 'fp__mode' }, modeSeg)),
    h('div', { class: 'fpbar' }, pvBar, spTick),
    h('div', { class: 'fp__inputs' },
      h('label', { class: 'fp__lab' }, h('span', { text: 'SP' }), spInput),
      h('label', { class: 'fp__lab' }, h('span', { text: 'OUT %' }), coInput)),
    h('div', { class: 'fpbar' }, coBar),
    terms, flags);

  el.update = () => {
    const { pid, pidCfg, run } = ctx;
    const E = LOOP_EU[ctx.run.mode];
    setText(pvVal, num(pid.pvRaw, E.dp));
    setText(pvUnit, E.unit);
    const frac = (v) => Math.max(0, Math.min(1, (v - E.lo) / (E.hi - E.lo)));
    pvBar.style.width = `${frac(pid.pvRaw) * 100}%`;
    spTick.style.left = `${frac(pid.sp) * 100}%`;
    coBar.style.width = `${Math.max(0, Math.min(100, run.co_pct))}%`;
    if (document.activeElement !== spInput) spInput.value = pid.spTarget.toFixed(E.dp);
    if (document.activeElement !== coInput) coInput.value = run.co_pct.toFixed(1);
    coInput.disabled = pid.mode !== MODE.MAN;
    modeSeg.select(pid.mode === MODE.CASCADE ? MODE.AUTO : pid.mode);

    setText(tP.lastChild, `${num(pid.prop, 1)}%`);
    setText(tI.lastChild, `${num(pid.integ, 1)}%`);
    setText(tD.lastChild, `${num(pid.deriv, 1)}%`);
    setText(tF.lastChild, `${num(run.ff_pct, 1)}%`);
    cls(tD, 'is-dim', !(pidCfg.Td > 0));
    cls(tF, 'is-dim', !ctx.stratCfg.ff.enabled);

    const notes = [];
    if (pid.saturated) notes.push(['warn', `output at its ${run.co_pct > 50 ? 'upper' : 'lower'} limit`]);
    if (pid.windupActive) notes.push(['warn', 'anti-windup unwinding the integral']);
    if (run.selected !== 'PRIMARY') notes.push(['warn', `${run.selected} override has the output`]);
    if (ctx.stratCfg.structure === STRUCTURE.CASCADE) {
      notes.push(['', `cascade: slave SP ${num(run.slaveSp_m3h, 1)} m³/h`]);
    }
    if (ctx.stratCfg.reset.enabled) {
      notes.push(['', `SP reset schedule holding ${num(ctx.stratCfg.reset.active_bar, 2)} bar`]);
    }
    if (notes.length !== flags.childElementCount
        || notes.some((n, i) => flags.children[i].textContent !== n[1])) {
      flags.textContent = '';
      for (const [kind, text] of notes) {
        flags.append(h('span', { class: `flag ${kind ? `flag--${kind}` : ''}`, text }));
      }
    }
  };
  return el;
}

// ==============================================================================================
// TUNE — the constants, the form, the algorithm
// ==============================================================================================

/**
 * The tuning panel.
 *
 * The FORM selector is the interesting control. Three vendors write the same controller three
 * ways, the numbers are not interchangeable, and transcribing a gain from one to another without
 * converting it is one of the classic ways to make a plant oscillate. Here the algorithm is
 * always the ISA standard form and the selector changes only what you are shown — with the
 * conversion done properly, including refusing the series form when the standard tuning has
 * complex zeros and no series equivalent exists at all.
 *
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function tuningPanel(ctx, A) {
  const fKc = numField({
    label: 'Gain Kc', unit: '%/EU', value: ctx.pidCfg.Kc, step: 0.5,
    hint: 'Output percent per engineering unit of error.',
    onCommit: (v) => A.setTuning({ Kc: v }),
  });
  const fTi = numField({
    label: 'Reset Ti', unit: 's', value: ctx.pidCfg.Ti, step: 0.5, min: 0.01,
    hint: 'Seconds per repeat. Large is weak reset; a very large value disables it.',
    onCommit: (v) => A.setTuning({ Ti: v }),
  });
  const fTd = numField({
    label: 'Rate Td', unit: 's', value: ctx.pidCfg.Td, step: 0.1, min: 0,
    hint: 'Derivative time. Zero on almost every real pressure loop, and for good reason.',
    onCommit: (v) => A.setTuning({ Td: v }),
  });
  const fN = numField({
    label: 'Deriv filter N', value: ctx.pidCfg.N, step: 1, min: 2, max: 100,
    hint: 'The derivative roll-off sits at Td/N. Small N is a heavier filter.',
    onCommit: (v) => A.setTuning({ N: v }),
  });
  const fB = numField({
    label: 'SP weight b', value: ctx.pidCfg.b, step: 0.05, min: 0, max: 1,
    hint: 'How much of a setpoint change the proportional term sees. Below 1 softens the kick.',
    onCommit: (v) => A.setTuning({ b: v }),
  });
  const fFilt = numField({
    label: 'PV filter', unit: 's', value: ctx.pidCfg.pvFilter_s, step: 0.1, min: 0,
    hint: 'First-order filter on the measurement inside the controller.',
    onCommit: (v) => A.setTuning({ pvFilter_s: v }),
  });
  const fRate = numField({
    label: 'SP ramp', unit: 'EU/s', value: ctx.pidCfg.spRate, step: 0.01, min: 0,
    hint: 'Zero steps the setpoint. Any positive value ramps it, which is how a real plant moves.',
    onCommit: (v) => A.setTuning({ spRate: v }),
  });
  const fScan = numField({
    label: 'Scan period', unit: 's', value: ctx.config.scan_s, step: 0.05, min: 0.02, max: 5,
    hint: 'Half a scan of pure dead time, every scan. Slow it down and watch a good tuning decay.',
    onCommit: (v) => A.setScan(v),
  });

  const formSeg = segmented([
    { id: FORM.STANDARD, label: 'ISA', hint: 'Kc·(1 + 1/(Ti·s) + Td·s). The standard form.' },
    { id: FORM.PARALLEL, label: 'Parallel', hint: 'Kp + Ki/s + Kd·s. Independent gains.' },
    { id: FORM.SERIES, label: 'Series', hint: 'The classic pneumatic/interacting form.' },
  ], ctx.pidCfg.form, (f) => A.setTuningForm(f));
  const algoSeg = segmented([
    { id: ALGO.POSITION, label: 'Positional', hint: 'The output is computed from scratch each scan.' },
    { id: ALGO.VELOCITY, label: 'Velocity', hint: 'The CHANGE in output is computed and added. Cannot wind up, and cannot be preloaded either.' },
  ], ctx.pidCfg.algorithm, (a) => A.setAlgorithm(a));
  const shown = h('div', { class: 'note note--sm' });

  const el = panel('TUNING', { cls: 'panel--tune' },
    fKc, fTi, fTd, fN, fB, fFilt, fRate, fScan,
    h('div', { class: 'panel__sub', text: 'FORM SHOWN' }), formSeg, shown,
    h('div', { class: 'panel__sub', text: 'ALGORITHM' }), algoSeg);

  el.update = () => {
    const c = ctx.pidCfg;
    const sync = (f, v, dp) => {
      if (document.activeElement !== f.input) f.input.value = Number(v).toFixed(dp);
    };
    sync(fKc, c.Kc, 2);
    sync(fTi, Number.isFinite(c.Ti) ? c.Ti : 99999, 2);
    sync(fTd, c.Td, 2);
    sync(fN, c.N, 0);
    sync(fB, c.b, 2);
    sync(fFilt, c.pvFilter_s, 2);
    sync(fRate, c.spRate, 3);
    sync(fScan, ctx.config.scan_s, 2);
    formSeg.select(c.form);
    algoSeg.select(c.algorithm);
    const conv = convertForm(c, c.form);
    setText(shown, conv.ok
      ? conv.labels.map((l, i) => `${l} ${num(conv.values[i], 3)} ${conv.units[i]}`).join('   ')
      : conv.note);
    cls(shown, 'is-warn', !conv.ok);
  };
  return el;
}

/**
 * The control-strategy panel: everything above a single PID.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function strategyPanel(ctx, A) {
  const structSeg = segmented([
    { id: STRUCTURE.SINGLE, label: 'Single', hint: 'One controller straight to the final element.' },
    { id: STRUCTURE.CASCADE, label: 'Cascade', hint: 'Pressure master over a flow slave. The slave must be several times faster or they fight.' },
  ], ctx.stratCfg.structure, (v) => A.setStrategy({ structure: v }));

  const ffOn = toggle('Feedforward from FCV-101', ctx.stratCfg.ff.enabled,
    'Correct for the demand valve BEFORE the header moves. Open loop, so a wrong model is not detected — always used with feedback, never instead of it.',
    (v) => A.setStrategy({ ff: { enabled: v } }));
  const ffGain = slider({
    label: 'FF gain', value: ctx.stratCfg.ff.gain, min: 0, max: 1.2, step: 0.05, dp: 2,
    hint: 'Almost never 1. An over-correction is far harder for the feedback loop to clean up than an under-correction.',
    onInput: (v) => A.setStrategy({ ff: { gain: v } }),
  });
  const ffLead = slider({
    label: 'FF lead', unit: 's', value: ctx.stratCfg.ff.lead_s, min: 0, max: 15, step: 0.5, dp: 1,
    hint: 'Advances the correction in time. Raise it when the feedforward arrives late.',
    onInput: (v) => A.setStrategy({ ff: { lead_s: v } }),
  });
  const ffLag = slider({
    label: 'FF lag', unit: 's', value: ctx.stratCfg.ff.lag_s, min: 0, max: 20, step: 0.5, dp: 1,
    hint: 'Delays the correction. Raise it when the feedforward arrives early and causes a wobble.',
    onInput: (v) => A.setStrategy({ ff: { lag_s: v } }),
  });

  const schedOn = toggle('Gain scheduling', ctx.stratCfg.sched.enabled,
    'Interpolate the tuning against an operating variable. The honest answer to a process whose gain is not constant.',
    (v) => A.setStrategy({ sched: { enabled: v } }));
  const schedVar = segmented([
    { id: SCHED_ON.FLOW, label: 'flow' },
    { id: SCHED_ON.OUTPUT, label: 'output' },
    { id: SCHED_ON.PUMPS, label: 'pumps' },
  ], ctx.stratCfg.sched.on, (v) => A.setStrategy({ sched: { on: v } }));
  const schedNote = h('div', { class: 'note note--sm' });

  const resetOn = toggle('Setpoint reset on flow', ctx.stratCfg.reset.enabled,
    'Lower the demanded pressure as the flow falls, because the friction it was paying for is not occurring. The largest single saving available on a variable-flow header.',
    (v) => A.setStrategy({ reset: { enabled: v } }));
  const resetMin = slider({
    label: 'SP at zero flow', unit: 'bar', value: ctx.stratCfg.reset.spMin_bar,
    min: 0.5, max: 4, step: 0.05, dp: 2,
    hint: 'The static head the far end still needs when nothing is flowing.',
    onInput: (v) => A.setStrategy({ reset: { spMin_bar: v } }),
  });
  const resetMax = slider({
    label: 'SP at design flow', unit: 'bar', value: ctx.stratCfg.reset.spMax_bar,
    min: 1, max: 6, step: 0.05, dp: 2,
    onInput: (v) => A.setStrategy({ reset: { spMax_bar: v } }),
  });

  const ovCur = toggle('Motor current limit', ctx.stratCfg.override.current.enabled,
    'Pull the speed back before the overload relay does it for you. A constraint controller that normally loses the selection.',
    (v) => A.setStrategy({ override: { current: { enabled: v } } }));
  const ovMinQ = toggle('Minimum flow override', ctx.stratCfg.override.minFlow.enabled,
    'Push the speed UP to keep flow through the machines. A high-select, applied after the low-select.',
    (v) => A.setStrategy({ override: { minFlow: { enabled: v } } }));
  const ovMaxP = toggle('Maximum pressure override', ctx.stratCfg.override.maxPressure.enabled,
    'A ceiling on the header, whatever the primary controller wants.',
    (v) => A.setStrategy({ override: { maxPressure: { enabled: v } } }));
  const ovNote = h('div', { class: 'note note--sm' });

  const el = panel('STRATEGY', { cls: 'panel--strat' },
    h('div', { class: 'panel__sub', text: 'STRUCTURE' }), structSeg,
    h('div', { class: 'panel__sub', text: 'FEEDFORWARD' }), ffOn, ffGain, ffLead, ffLag,
    h('div', { class: 'panel__sub', text: 'GAIN SCHEDULING' }), schedOn, schedVar, schedNote,
    h('div', { class: 'panel__sub', text: 'SETPOINT RESET' }), resetOn, resetMin, resetMax,
    h('div', { class: 'panel__sub', text: 'CONSTRAINT OVERRIDES' }), ovCur, ovMinQ, ovMaxP, ovNote);

  el.update = () => {
    const c = ctx.stratCfg;
    structSeg.select(c.structure);
    ffOn.set(c.ff.enabled);
    schedOn.set(c.sched.enabled);
    schedVar.select(c.sched.on);
    resetOn.set(c.reset.enabled);
    ovCur.set(c.override.current.enabled);
    ovMinQ.set(c.override.minFlow.enabled);
    ovMaxP.set(c.override.maxPressure.enabled);
    setText(schedNote, c.sched.enabled
      ? `holding Kc ${num(c.sched.active.Kc, 1)}, Ti ${num(c.sched.active.Ti, 1)} s`
      : 'off — one tuning everywhere');
    setText(ovNote, `selected: ${ctx.run.selected}`);
    cls(ovNote, 'is-warn', ctx.run.selected !== 'PRIMARY');
    for (const [row, on] of [[ffGain, c.ff.enabled], [ffLead, c.ff.enabled], [ffLag, c.ff.enabled],
      [resetMin, c.reset.enabled], [resetMax, c.reset.enabled]]) {
      cls(row, 'is-dim', !on);
    }
  };
  return el;
}

/**
 * A labelled on/off switch.
 * @param {string} label the text
 * @param {boolean} value initial state
 * @param {string} hint title text
 * @param {(v:boolean)=>void} onChange called with the new state
 * @returns {HTMLElement} the row, with `.set(v)`
 */
function toggle(label, value, hint, onChange) {
  const input = h('input', { type: 'checkbox', class: 'tog__box', onChange: () => onChange(input.checked) });
  input.checked = !!value;
  const el = h('label', { class: 'tog', title: hint || '' },
    input, h('span', { class: 'tog__label', text: label }));
  el.set = (v) => { if (document.activeElement !== input) input.checked = !!v; };
  return el;
}

// ==============================================================================================
// IDENTIFY — the three experiments and the ranked results
// ==============================================================================================

/**
 * Process identification and the tuning rules it feeds.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function identifyPanel(ctx, A) {
  const relayD = slider({
    label: 'Relay amplitude', unit: '%', value: 12, min: 2, max: 30, step: 1, dp: 0,
    hint: 'How far the relay swings the output either side of the present operating point. The experiment is bounded by this number and by nothing else.',
    onInput: () => {},
  });
  const stepDu = slider({
    label: 'Step size', unit: '%', value: 10, min: -30, max: 30, step: 1, dp: 0,
    hint: 'The open-loop bump. Large enough to see through the noise, small enough that the plant survives it.',
    onInput: () => {},
  });

  const btnRelay = h('button', { class: 'btn', type: 'button', text: 'Relay autotune', onClick: () => {
    if (ctx.autotune.phase === TUNE.SETTLING || ctx.autotune.phase === TUNE.CYCLING) A.cancelAutotune();
    else A.beginAutotune({ d: Number.parseFloat(relayD.input.value) });
  } });
  const btnStep = h('button', { class: 'btn', type: 'button', text: 'Step test', onClick: () => {
    if (ctx.stepTest.phase === STEP.SETTLING || ctx.stepTest.phase === STEP.RECORDING) A.cancelStepTest();
    else A.beginStepTest({ du: Number.parseFloat(stepDu.input.value) });
  } });
  const btnSweep = h('button', { class: 'btn', type: 'button', text: 'Frequency sweep', onClick: () => {
    if (ctx.sweep.phase === SWEEP.SETTLING || ctx.sweep.phase === SWEEP.MEASURING) A.cancelSweep();
    else A.beginSweep({ amp: 5 });
  } });

  const status = h('div', { class: 'note' });
  const model = h('div', { class: 'note note--sm' });
  const rules = h('div', { class: 'rules' });
  let lastKey = '';

  const el = panel('IDENTIFY & TUNE', { cls: 'panel--at' },
    relayD, stepDu,
    h('div', { class: 'btnrow' }, btnRelay, btnStep, btnSweep),
    status, model,
    h('div', { class: 'panel__sub', text: 'CANDIDATE TUNINGS' }), rules);

  el.update = () => {
    const at = ctx.autotune;
    const st = ctx.stepTest;
    const sw = ctx.sweep;
    const relayRunning = at.phase === TUNE.SETTLING || at.phase === TUNE.CYCLING;
    const stepRunning = st.phase === STEP.SETTLING || st.phase === STEP.RECORDING;
    const sweepRunning = sw.phase === SWEEP.SETTLING || sw.phase === SWEEP.MEASURING;
    setText(btnRelay, relayRunning ? 'Abort relay' : 'Relay autotune');
    setText(btnStep, stepRunning ? 'Abort step test' : 'Step test');
    setText(btnSweep, sweepRunning ? 'Abort sweep' : 'Frequency sweep');
    cls(btnRelay, 'is-live', relayRunning);
    cls(btnStep, 'is-live', stepRunning);
    cls(btnSweep, 'is-live', sweepRunning);
    btnStep.disabled = relayRunning || sweepRunning;
    btnSweep.disabled = relayRunning || stepRunning;
    btnRelay.disabled = stepRunning || sweepRunning;

    setText(status, relayRunning ? at.message
      : stepRunning ? st.message
        : sweepRunning ? `${sw.message} — ${sw.points.length} done, ${sw.todo.length + 1} to go`
          : at.phase === TUNE.DONE ? at.message
            : st.phase === STEP.DONE ? st.message
              : 'No experiment running. The relay is safe and gives Ku and Tu; the step test is '
                + 'disruptive and gives a model.');
    setText(model, ctx.model
      ? `model: K ${num(ctx.model.K, 4)} EU/%, τ ${num(ctx.model.tau, 1)} s, θ `
        + `${num(ctx.model.theta, 1)} s — ${ctx.modelSource}`
      : 'no process model yet — run a step test or a sweep');
    cls(model, 'is-dim', !ctx.model);

    const cand = A.tuningCandidates ? A.tuningCandidates() : { rules: [], ranked: false };
    const key = `${cand.rules.length}:${cand.ranked}:${cand.rules.map((r) => r.Kc.toFixed(2)).join()}`;
    if (key !== lastKey) {
      lastKey = key;
      rules.textContent = '';
      if (!cand.rules.length) {
        rules.append(h('div', { class: 'note note--sm', text: 'Run an experiment and the published rules appear here, each simulated on the model so you can see what it would actually do before you apply it.' }));
      }
      for (const r of cand.rules) {
        const m = r.margins;
        const p = r.predicted;
        rules.append(h('div', { class: 'rule' },
          h('div', { class: 'rule__top' },
            h('b', { class: 'rule__name', text: r.name }),
            h('button', {
              class: 'btn btn--sm', type: 'button', text: 'Apply',
              onClick: () => A.applyTuningRule(r.id),
            })),
          h('div', { class: 'rule__nums', text:
            `Kc ${num(r.Kc, 2)}   Ti ${num(r.Ti, 2)} s   Td ${num(r.Td, 2)} s` }),
          m ? h('div', { class: `rule__margins ${m.stable ? '' : 'is-alarm'}`, text:
            `Ms ${num(m.ms, 2)}   GM ${num(m.gm_dB, 1)} dB   PM ${num(m.pm_deg, 0)}°   `
            + `overshoot ${num(p.overshootPct, 0)}%   settle ${dur(p.settle_s)}` }) : null,
          m ? h('div', { class: 'rule__verdict', text: m.verdict }) : null,
          h('div', { class: 'rule__note', text: r.note })));
      }
    }
  };
  return el;
}

// ==============================================================================================
// PLANT — the sequence, the load, the machines
// ==============================================================================================

/**
 * The sequence panel.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function stagingPanel(ctx, A) {
  const enable = toggle('Sequence enabled', ctx.stagingCfg.enabled,
    'When off, the machines only do what you tell them by hand.',
    (v) => A.setStaging({ enabled: v }));
  const critSeg = segmented([
    { id: CRITERION.OUTPUT, label: 'Output', hint: 'The field default. Needs no instrument and is the crudest.' },
    { id: CRITERION.FLOW, label: 'Flow', hint: 'The honest measure of load, if you have a flow meter.' },
    { id: CRITERION.ENERGY, label: 'Energy', hint: 'Solve the plant both ways and stage wherever the kilowatts actually cross over.' },
  ], ctx.stagingCfg.criterion, (v) => A.setStaging({ criterion: v }));

  const sUp = slider({
    label: 'Stage up above', unit: '%', value: ctx.stagingCfg.stageUp_pct, min: 50, max: 100, step: 1, dp: 0,
    onInput: (v) => A.setStaging({ stageUp_pct: v }),
  });
  const sDown = slider({
    label: 'Stage down below', unit: '%', value: ctx.stagingCfg.stageDown_pct, min: 5, max: 80, step: 1, dp: 0,
    hint: 'The gap between the two thresholds is the hysteresis band, and it has to be wider than the disturbance the stage itself causes.',
    onInput: (v) => A.setStaging({ stageDown_pct: v }),
  });
  const sUpDly = slider({
    label: 'Stage-up delay', unit: 's', value: ctx.stagingCfg.stageUpDelay_s, min: 0, max: 60, step: 1, dp: 0,
    onInput: (v) => A.setStaging({ stageUpDelay_s: v }),
  });
  const sDnDly = slider({
    label: 'Stage-down delay', unit: 's', value: ctx.stagingCfg.stageDownDelay_s, min: 0, max: 120, step: 1, dp: 0,
    onInput: (v) => A.setStaging({ stageDownDelay_s: v }),
  });
  const sUpBias = slider({
    label: 'Stage-up bias', value: ctx.stagingCfg.stageUpBias, min: 0.4, max: 1, step: 0.01, dp: 2,
    hint: 'What the output is multiplied by the instant a pump joins. Feedforward, applied to a discrete event: it tells the controller the plant just changed instead of letting it find out.',
    onInput: (v) => A.setStaging({ stageUpBias: v }),
  });
  const sDnBias = slider({
    label: 'Stage-down bias', value: ctx.stagingCfg.stageDownBias, min: 1, max: 1.8, step: 0.01, dp: 2,
    onInput: (v) => A.setStaging({ stageDownBias: v }),
  });
  const sMinRun = slider({
    label: 'Minimum run', unit: 's', value: ctx.stagingCfg.minRun_s, min: 0, max: 300, step: 5, dp: 0,
    hint: 'The last line of defence against short-cycling. Whatever the loop does, a pump that has just started will not stop.',
    onInput: (v) => A.setStaging({ minRun_s: v }),
  });
  const sMinStop = slider({
    label: 'Minimum stop', unit: 's', value: ctx.stagingCfg.minStop_s, min: 0, max: 300, step: 5, dp: 0,
    onInput: (v) => A.setStaging({ minStop_s: v }),
  });
  const shareSeg = segmented([
    { id: SHARE.COMMON, label: 'Common speed', hint: 'Every running pump takes the same speed. Correct for identical machines in parallel.' },
    { id: SHARE.BASE_TRIM, label: 'Base + trim', hint: 'The lag runs at a fixed speed and the lead modulates. Cheaper on a set with one drive.' },
  ], ctx.stagingCfg.share, (v) => A.setStaging({ share: v }));
  const rotSeg = segmented([
    { id: ROTATE.OFF, label: 'No rotation' },
    { id: ROTATE.ON_STAGE_DOWN, label: 'On stage down' },
    { id: ROTATE.RUNTIME, label: 'On runtime' },
  ], ctx.stagingCfg.rotate, (v) => A.setStaging({ rotate: v }));

  const sleepOn = toggle('Sleep on no demand', ctx.stagingCfg.sleepEnabled,
    'Stop the last pump when nothing is being drawn and let the gas cushion hold the header. The largest energy saving available on a set like this, and the easiest way to make one short-cycle.',
    (v) => A.setStaging({ sleepEnabled: v }));
  const sSleepQ = slider({
    label: 'Sleep below', unit: 'm³/h', value: ctx.stagingCfg.sleepFlow_m3h, min: 0.5, max: 20, step: 0.5, dp: 1,
    onInput: (v) => A.setStaging({ sleepFlow_m3h: v }),
  });
  const sWake = slider({
    label: 'Wake droop', unit: '%', value: ctx.stagingCfg.wakeDroop * 100, min: 1, max: 30, step: 1, dp: 0,
    hint: 'How far the header may fall before the set restarts. Too tight and it wakes within seconds of stopping, which is worse than never sleeping.',
    onInput: (v) => A.setStaging({ wakeDroop: v / 100 }),
  });

  const status = h('div', { class: 'note' });
  const energyNote = h('div', { class: 'note note--sm' });

  const el = panel('SEQUENCE', { cls: 'panel--seq' },
    enable,
    h('div', { class: 'panel__sub', text: 'STAGE ON' }), critSeg,
    sUp, sDown, sUpDly, sDnDly, sUpBias, sDnBias, sMinRun, sMinStop,
    h('div', { class: 'panel__sub', text: 'SHARING' }), shareSeg,
    h('div', { class: 'panel__sub', text: 'DUTY ROTATION' }), rotSeg,
    h('div', { class: 'panel__sub', text: 'SLEEP' }), sleepOn, sSleepQ, sWake,
    status, energyNote);

  el.update = () => {
    const c = ctx.stagingCfg;
    const sq = ctx.staging;
    enable.set(c.enabled);
    critSeg.select(c.criterion);
    shareSeg.select(c.share);
    rotSeg.select(c.rotate);
    sleepOn.set(c.sleepEnabled);
    setText(status, sq.holdReason || sq.lastAction);
    cls(status, 'is-warn', sq.sleeping);
    setText(energyNote,
      `${sq.transitions} transitions · lead P-10${sq.lead + 1}`
      + (c.criterion === CRITERION.ENERGY && sq.energyPredictions.length
        ? ` · predicted ${sq.energyPredictions.map((p) => `${p.n}:${Number.isFinite(p.kW) ? num(p.kW, 1) : '—'} kW`).join('  ')}`
        : ''));
    for (const [row, on] of [[sUp, c.criterion === CRITERION.OUTPUT],
      [sDown, c.criterion === CRITERION.OUTPUT],
      [sSleepQ, c.sleepEnabled], [sWake, c.sleepEnabled]]) cls(row, 'is-dim', !on);
  };
  return el;
}

/**
 * The disturbance surface, plus the final element and the fluid.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function loadPanel(ctx, A) {
  const p = ctx.plant;
  const finalSeg = segmented([
    { id: FINAL.VFD, label: 'VFD speed', hint: 'The drives modulate. Head goes with the square of speed and power with the cube.' },
    { id: FINAL.THROTTLE, label: 'PCV throttle', hint: 'The pumps run at a fixed speed and PCV-101 destroys the surplus head. Constant-speed control, and the reason drives get retrofitted.' },
  ], p.finalElement, (v) => A.setDisturbance({ finalElement: v }));
  const sFixed = slider({
    label: 'Fixed speed', unit: '%', value: p.fixedSpeed_pct, min: 30, max: 100, step: 1, dp: 0,
    hint: 'Shaft speed while throttling. It sets the floor of the pressure the valve can hold: a valve can only hold a pressure the pump already exceeds.',
    onInput: (v) => A.setDisturbance({ fixedSpeed_pct: v }),
  });
  const bandNote = h('div', { class: 'note note--sm' });

  const sDemand = slider({
    label: 'FCV-101 demand', unit: '%', value: p.demandTarget * 100, min: 0, max: 100, step: 1, dp: 0,
    hint: 'The load. Everything the loop has to reject comes through here.',
    onInput: (v) => A.setDisturbance({ demandTarget: v / 100 }),
  });
  const sHead = slider({
    label: 'Discharge static head', unit: 'm', value: p.hDischarge_m, min: 0, max: 40, step: 0.5, dp: 1,
    hint: 'The back pressure the process itself imposes. A pure offset on the system curve.',
    onInput: (v) => A.setDisturbance({ hDischarge_m: v }),
  });
  const sSupply = slider({
    label: 'Make-up temperature', unit: '°C', value: p.Tsupply_C, min: 4, max: 96, step: 1, dp: 0,
    hint: 'The tank mixes toward this. Vapour pressure rises very steeply near boiling and takes the NPSH margin with it.',
    onInput: (v) => A.setDisturbance({ Tsupply_C: v }),
  });
  const sFoul = slider({
    label: 'Strainer blinding', unit: '%', value: p.foul * 100, min: 0, max: 95, step: 1, dp: 0,
    hint: 'Suction-side resistance. It costs NPSH available directly.',
    onInput: (v) => A.setDisturbance({ foul: v / 100 }),
  });
  const sLevel = slider({
    label: 'Tank level', unit: 'm', value: p.level_m, min: 0, max: ctx.config.tank.height_m, step: 0.05, dp: 2,
    onInput: (v) => A.setDisturbance({ level_m: v }),
  });
  const makeup = toggle('Make-up in auto', p.makeupAuto,
    'Off isolates the supply and the tank runs down.',
    (v) => A.setDisturbance({ makeupAuto: v }));

  const fluidSeg = h('select', {
    class: 'select',
    onChange: () => A.setDisturbance({ fluidId: fluidSeg.value }),
  }, FLUIDS.map((f) => h('option', { value: f.id, text: f.name })));
  fluidSeg.value = p.fluidId;

  const recircSeg = segmented([
    { id: RECIRC.ARV, label: 'ARV auto', hint: 'A self-contained valve that opens as forward flow falls. No controller, nothing to tune.' },
    { id: RECIRC.MANUAL, label: 'Manual', hint: 'You set the travel.' },
    { id: RECIRC.CLOSED, label: 'Shut', hint: 'The way to find out what minimum-flow protection is for.' },
  ], p.recircMode, (v) => A.setDisturbance({ recircMode: v }));
  const sByp = slider({
    label: 'Recirculation travel', unit: '%', value: p.bypass * 100, min: 0, max: 100, step: 1, dp: 0,
    onInput: (v) => A.setDisturbance({ bypass: v / 100 }),
  });

  const sStick = slider({
    label: 'Final element stickband', unit: '%', value: 0, min: 0, max: 12, step: 0.25, dp: 2,
    hint: 'Friction in the stem, as a percentage of travel. The single most common cause of a cycling loop, and the one no tuning will fix.',
    onInput: (v) => {
      const which = ctx.plant.finalElement === FINAL.THROTTLE ? 'pcv' : 'fcv';
      A.setDisturbance({ valveOverride: { [which]: { stickband: v / 100, slipJump: v / 200 } } });
    },
  });

  const el = panel('LOAD & UPSETS', { cls: 'panel--load' },
    h('div', { class: 'panel__sub', text: 'FINAL ELEMENT' }), finalSeg, sFixed, bandNote,
    h('div', { class: 'panel__sub', text: 'LOAD' }), sDemand, sHead,
    h('div', { class: 'panel__sub', text: 'SUCTION' }), sSupply, sFoul, sLevel, makeup,
    h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'Liquid' }), fluidSeg),
    h('div', { class: 'panel__sub', text: 'MINIMUM FLOW' }), recircSeg, sByp,
    h('div', { class: 'panel__sub', text: 'MAINTENANCE' }), sStick);

  el.update = () => {
    const pl = ctx.plant;
    const sync = (row, v) => {
      if (document.activeElement !== row.input) {
        row.input.value = String(v);
        setText(row.read, `${num(v, row.dp)}${row.unit ? ` ${row.unit}` : ''}`);
      }
    };
    finalSeg.select(pl.finalElement);
    recircSeg.select(pl.recircMode);
    makeup.set(pl.makeupAuto);
    sync(sDemand, pl.demandTarget * 100);
    sync(sHead, pl.hDischarge_m);
    sync(sSupply, pl.Tsupply_C);
    sync(sFoul, pl.foul * 100);
    sync(sLevel, pl.level_m);
    sync(sByp, pl.bypass * 100);
    sync(sFixed, pl.fixedSpeed_pct);
    if (document.activeElement !== fluidSeg) fluidSeg.value = pl.fluidId;
    cls(sFixed, 'is-dim', pl.finalElement !== FINAL.THROTTLE);
    cls(sByp, 'is-dim', pl.recircMode !== RECIRC.MANUAL);
    if (pl.finalElement === FINAL.THROTTLE) {
      const band = throttleRange(ctx.config, pl);
      setText(bandNote, band.ok
        ? `PCV-101 can hold ${num(band.lo_bar, 2)} to ${num(band.hi_bar, 2)} bar at this speed. `
          + `Throwing away ${num(ctx.plant.p_bar - band.lo_bar, 2)} bar of head right now.`
        : 'nothing running');
      bandNote.hidden = false;
    } else {
      bandNote.hidden = true;
    }
    const which = pl.finalElement === FINAL.THROTTLE ? 'pcv' : 'fcv';
    sync(sStick, pl.valveOverride[which].stickband * 100);
  };
  return el;
}

/**
 * Condition monitoring: what each machine is doing to itself.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function machinesPanel(ctx, A) {
  const cards = ctx.config.pumps.map((pump, i) => {
    const hand = segmented([
      { id: HAND.HAND, label: 'HAND' },
      { id: HAND.AUTO, label: 'AUTO' },
      { id: HAND.OFF, label: 'OFF' },
    ], HAND.AUTO, (v) => {
      if (v === HAND.HAND) A.startPump(i);
      else if (v === HAND.OFF) A.stopPump(i);
      else A.autoPump(i);
    });
    const ros = {
      speed: readout('SPEED', '%', 'Shaft speed as a percentage of rated.'),
      flow: readout('FLOW', 'm³/h', 'Flow through this machine.'),
      eff: readout('EFF', '%', 'Total efficiency at the present duty.'),
      npsh: readout('NPSH m', 'm', 'Margin: available minus required. Below about 0.5 m the impeller is being damaged.'),
      vib: readout('VIB', 'mm/s', 'Overall velocity, ISO 10816-3. Zone A is new, B is acceptable, C is short-term only.'),
      temp: readout('CASING', 'K', 'Casing temperature above the tank.'),
      amps: readout('MOTOR', '%', 'Current as a percentage of full load.'),
      therm: readout('OVERLOAD', '%', 'Thermal capacity used. The relay trips at 115%.'),
      wear: readout('WEAR', '%', 'Accumulated wear-ring clearance. It only ever goes up.'),
      hours: readout('RUN', 'h', 'Running hours, for the duty rotation.'),
    };
    const status = h('div', { class: 'mach__status' });
    const btnReset = h('button', {
      class: 'btn btn--sm', type: 'button', text: 'Reset overload',
      onClick: () => A.resetPump(i),
    });
    const btnTrip = h('button', {
      class: 'btn btn--sm', type: 'button', text: 'Inject trip',
      onClick: () => A.forceTrip(i),
    });
    const card = h('div', { class: 'mach' },
      h('div', { class: 'mach__head' },
        h('b', { class: 'mach__tag', text: pump.tag }),
        h('span', { class: 'mach__lead' }),
        hand),
      status,
      h('div', { class: 'mach__grid' }, Object.values(ros)),
      h('div', { class: 'btnrow' }, btnReset, btnTrip));
    return { card, hand, ros, status, btnReset, btnTrip };
  });

  const el = panel('MACHINES', { cls: 'panel--mach' }, cards.map((c) => c.card));

  el.update = () => {
    const p = ctx.plant;
    for (let i = 0; i < cards.length; i += 1) {
      const c = cards[i];
      const d = p.drv[i];
      c.hand.select(ctx.staging.hand[i]);
      setText(c.card.querySelector('.mach__lead'), ctx.staging.lead === i ? 'LEAD' : '');
      const mf = minimumFlow(ctx.config, p, i);
      const marg = p.npsha_m[i] - p.npshr_m[i];
      const zone = vibrationZone(p.vib_mms[i]);
      c.ros.speed.set(num(d.n_pct, 0), d.state === DRIVE.TRIPPED ? 'alarm' : d.n_pct < 1 ? 'off' : '');
      c.ros.flow.set(num(p.Q_m3h[i], 1),
        d.n_pct > 5 && p.Q_m3h[i] < mf.governing_m3h ? 'alarm' : '');
      c.ros.eff.set(num(p.eta[i] * 100, 0), p.eta[i] < 0.35 && d.n_pct > 5 ? 'warn' : '');
      c.ros.npsh.set(num(marg, 2), marg < 0.3 ? 'alarm' : marg < 0.8 ? 'warn' : '');
      c.ros.vib.set(num(p.vib_mms[i], 2), zone === 'D' || zone === 'C' ? 'alarm' : zone === 'B' ? 'warn' : '');
      c.ros.temp.set(num(p.Tcasing_C[i] - p.T_tank_C, 1),
        p.Tcasing_C[i] - p.T_tank_C > 12 ? 'alarm' : '');
      c.ros.amps.set(num(d.i_pct, 0), d.i_pct > 105 ? 'warn' : '');
      c.ros.therm.set(num(d.thermal_pct, 0), d.thermal_pct > 85 ? 'alarm' : '');
      c.ros.wear.set(num(p.wear[i] * 100, 2), p.wear[i] > 0.55 ? 'warn' : '');
      c.ros.hours.set(num(d.runtime_h, 2), '');
      const lines = [`${d.state}`];
      if (d.trip) lines.push(d.trip);
      if (d.torqueLimited) lines.push('at the drive torque limit');
      if (p.checkShut[i] && d.n_pct > 5) lines.push('check valve shut — making no flow into the header');
      if (p.cav[i] < 0.995) lines.push(`cavitating — ${num((1 - p.cav[i]) * 100, 0)}% head loss`);
      if (d.n_pct > 5 && p.Q_m3h[i] < mf.governing_m3h) {
        lines.push(`below minimum continuous flow (${num(mf.governing_m3h, 1)} m³/h, set by ${mf.reason})`);
      }
      setText(c.status, lines.join(' · '));
      cls(c.status, 'is-alarm', d.state === DRIVE.TRIPPED || p.cav[i] < 0.995);
      c.btnReset.disabled = d.state !== DRIVE.TRIPPED;
      c.btnTrip.disabled = d.state === DRIVE.TRIPPED;
    }
  };
  return el;
}

/**
 * The energy meter.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function energyPanel(ctx, A) {
  const ros = {
    now: readout('ELECTRICAL', 'kW', 'What the set is drawing from the supply right now.'),
    useful: readout('USEFUL', 'kW', 'Hydraulic power actually delivered to process.'),
    w2w: readout('WIRE-WATER', '%', 'Useful over electrical. Everything else is losses in the motor, the drive, the impeller and the valves.'),
    spec: readout('SPECIFIC', 'kWh/m³', 'The number a plant manager asks about.'),
    total: readout('ENERGY', 'kWh', 'Since the meter was last reset.'),
    cost: readout('COST', '', 'At the configured tariff.'),
    thr: readout('THROTTLED', 'kWh', 'Energy destroyed across the throttle valve. On a variable-speed system this is nearly zero, and that is the entire argument.'),
    starts: readout('STARTS/h', '', 'Most starters are rated for six to ten an hour.'),
  };
  const btnReset = h('button', { class: 'btn btn--sm', type: 'button', text: 'Reset meter', onClick: () => A.resetEnergy() });
  const el = panel('ENERGY', { cls: 'panel--energy', tools: btnReset },
    h('div', { class: 'ro__grid' }, Object.values(ros)));

  el.update = () => {
    const s = A.summary();
    const e = ctx.run.energy;
    ros.now.set(num(s.electrical_kW, 2));
    ros.useful.set(num(s.useful_kW, 2));
    ros.w2w.set(num(s.wireToWater * 100, 1), s.wireToWater < 0.4 ? 'warn' : '');
    ros.spec.set(num(s.specific_kWh_m3, 4));
    ros.total.set(num(e.kWh, 3));
    ros.cost.set(`${ctx.config.energy.symbol}${num(e.cost, 3)}`);
    ros.thr.set(num(e.throttleKWh, 3), e.throttleKWh > 0.2 * Math.max(e.kWh, 1e-9) ? 'warn' : '');
    ros.starts.set(num(s.startsPerHour, 1), s.startsPerHour > 8 ? 'alarm' : s.startsPerHour > 5 ? 'warn' : '');
  };
  return el;
}

// ==============================================================================================
// TEST — scenarios, the scorecard, exports
// ==============================================================================================

/**
 * The scenario runner and the scorecard.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function scorePanel(ctx, A) {
  const pick = h('select', { class: 'select' },
    SCENARIOS.map((sc) => h('option', { value: sc.id, text: sc.name, title: sc.blurb })));
  const blurb = h('div', { class: 'note note--sm' });
  pick.addEventListener('change', () => {
    const def = SCENARIOS.find((sc) => sc.id === pick.value);
    setText(blurb, def ? def.blurb : '');
  });
  setText(blurb, SCENARIOS[0].blurb);

  const btnRun = h('button', { class: 'btn', type: 'button', text: 'Run test', onClick: () => {
    if (ctx.scenario.def) A.cancelScenario(); else A.beginScenario(pick.value);
  } });
  const btnGrade = h('button', { class: 'btn', type: 'button', text: 'Grade now', onClick: () => A.gradeNow() });
  const btnClear = h('button', { class: 'btn', type: 'button', text: 'Clear', onClick: () => A.clearScore() });

  const progress = h('div', { class: 'note' });
  const grade = h('div', { class: 'grade' });
  const body = h('div', { class: 'score' });
  let lastId = null;

  const el = panel('TEST & SCORE', { cls: 'panel--score' },
    h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'Test' }), pick),
    blurb,
    h('div', { class: 'btnrow' }, btnRun, btnGrade, btnClear),
    progress, grade, body);

  el.update = () => {
    const sc = ctx.scenario;
    setText(btnRun, sc.def ? 'Abort test' : 'Run test');
    cls(btnRun, 'is-live', !!sc.def);
    setText(progress, sc.def
      ? `${sc.def.name} — ${dur(sc.elapsed_s)} of ${dur(sc.def.duration_s)}`
      : `accumulating: ${dur(sc.m.t_s)}, IAE ${num(sc.m.iae, 2)}, travel ${num(sc.m.coTravel, 0)}%`);

    const r = sc.last;
    if (!r) { setText(grade, ''); return; }
    const key = `${sc.lastId}:${r.t_s.toFixed(1)}:${r.score.toFixed(2)}`;
    if (key === lastId) return;
    lastId = key;
    setText(grade, `${num(r.score, 0)} / 100`);
    cls(grade, 'is-good', r.score >= 75);
    cls(grade, 'is-warn', r.score >= 45 && r.score < 75);
    cls(grade, 'is-alarm', r.score < 45);

    body.textContent = '';
    body.append(h('div', { class: 'score__head', text: r.scenario }));
    const rows = [
      ['IAE', num(r.iae, 2), 'EU·s'],
      ['ITAE', num(r.itae, 1), 'EU·s²'],
      ['Peak error', num(r.peakErr, 3), 'EU'],
      ['Overshoot', num(r.overshootPct, 1), '%'],
      ['Settling', dur(r.settle_s), ''],
      ['Output travel', num(r.coTravel, 0), '%'],
      ['Pump starts', String(r.starts), ''],
      ['Specific energy', num(r.specific_kWh_m3, 4), 'kWh/m³'],
      ['Saturated', dur(r.satTime_s), ''],
      ['Below min flow', dur(r.minFlowTime_s), ''],
      ['Cavitating', dur(r.cavTime_s), ''],
    ];
    for (const [k, v, u] of rows) {
      body.append(h('div', { class: 'score__row' },
        h('span', { text: k }), h('b', { text: `${v}${u ? ` ${u}` : ''}` })));
    }
    body.append(h('div', { class: 'panel__sub', text: 'GRADE BREAKDOWN' }));
    for (const part of r.parts) {
      body.append(h('div', { class: `score__row ${part.applicable ? '' : 'is-dim'}` },
        h('span', { text: `${part.label} (ref ${part.ref})` }),
        h('b', { text: part.applicable ? `${num(part.earned, 1)} pts` : 'n/a' })));
    }
    if (r.penalties.cavitation > 0.1 || r.penalties.minFlow > 0.1) {
      body.append(h('div', { class: 'score__row is-alarm' },
        h('span', { text: 'Machinery penalties' }),
        h('b', { text: `−${num(r.penalties.cavitation + r.penalties.minFlow, 1)} pts` })));
    }
    for (const st of r.steps) {
      body.append(h('div', { class: 'score__step' },
        h('b', { text: st.label }),
        h('span', { text: `${Number.isFinite(st.overshootPct) ? `overshoot ${num(st.overshootPct, 0)}%, ` : ''}`
          + `settled ${dur(st.settle_s)}, peak deviation ${num(st.peakDev, 3)}, IAE ${num(st.iae, 2)}` })));
    }
  };
  return el;
}

/**
 * Exports and the session file.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {HTMLElement} the panel, with `.update()`
 */
function exportPanel(ctx, A) {
  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', class: 'hidden-file',
    onChange: async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        const snap = await readSessionFile(f);
        const res = applySession(ctx, snap, A.raw);
        A.toast(res.problems.length
          ? `session loaded with ${res.problems.length} problem(s): ${res.problems[0]}`
          : `session loaded — ${res.applied} settings applied`,
        res.problems.length ? 'warn' : '');
      } catch (e) {
        A.toast(`could not read that file: ${e.message}`, 'warn');
      }
      fileInput.value = '';
    },
  });

  const btnCsv = h('button', { class: 'btn', type: 'button', text: 'Trend CSV', onClick: () => {
    download(timestampedName('trend', 'csv'), trendToCsv(ctx.trend, TREND_UNITS));
    A.toast(`${ctx.trend.len} samples exported`);
  } });
  const btnScore = h('button', { class: 'btn', type: 'button', text: 'Scorecard CSV', onClick: () => {
    if (!ctx.scenario.last) { A.toast('nothing graded yet', 'warn'); return; }
    download(timestampedName('scorecard', 'csv'), scorecardToCsv(ctx.scenario.last));
  } });
  const btnRuns = h('button', { class: 'btn', type: 'button', text: 'Comparison CSV', onClick: () => {
    if (!ctx.runs.runs.length) { A.toast('no runs filed yet', 'warn'); return; }
    download(timestampedName('runs', 'csv'), comparisonToCsv(compareRuns(ctx.runs)));
  } });
  const btnSave = h('button', { class: 'btn', type: 'button', text: 'Save session', onClick: () => {
    download(timestampedName('session', 'json'), JSON.stringify(sessionSnapshot(ctx), null, 2),
      'application/json');
  } });
  const btnLoad = h('button', { class: 'btn', type: 'button', text: 'Load session', onClick: () => fileInput.click() });

  const note = h('div', { class: 'note note--sm' });
  const el = panel('EXPORT', { cls: 'panel--export' },
    h('div', { class: 'btnrow' }, btnCsv, btnScore, btnRuns),
    h('div', { class: 'btnrow' }, btnSave, btnLoad),
    fileInput, note);

  el.update = () => {
    setText(note, `${ctx.trend.len} trend samples · ${ctx.runs.runs.length} runs filed. `
      + 'A session file carries the settings, not the state of the plant.');
  };
  return el;
}

// ==============================================================================================
// The rail
// ==============================================================================================

/**
 * Build the control rail: four tabs, each a stack of panels.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {{el:HTMLElement, update:Function, show:Function}} the rail
 */
export function createRail(ctx, A) {
  const groups = [
    { id: 'run', label: 'RUN', panels: [faceplate(ctx, A), strategyPanel(ctx, A)] },
    { id: 'tune', label: 'TUNE', panels: [tuningPanel(ctx, A), identifyPanel(ctx, A)] },
    { id: 'plant', label: 'PLANT', panels: [stagingPanel(ctx, A), loadPanel(ctx, A), machinesPanel(ctx, A)] },
    { id: 'test', label: 'TEST', panels: [scorePanel(ctx, A), energyPanel(ctx, A), exportPanel(ctx, A)] },
  ];
  let active = 'run';

  const tabs = h('div', { class: 'railtabs' }, groups.map((g) => h('button', {
    class: 'railtab', type: 'button', text: g.label, dataset: { id: g.id },
    onClick: () => show(g.id),
  })));
  const stacks = groups.map((g) => h('div', { class: 'railstack' }, g.panels));
  const el = h('div', { class: 'rail' }, tabs, stacks);

  /**
   * Reveal one tab.
   * @param {string} id the group id
   * @returns {void}
   */
  function show(id) {
    active = id;
    for (let i = 0; i < groups.length; i += 1) {
      stacks[i].hidden = groups[i].id !== id;
      cls(tabs.children[i], 'is-on', groups[i].id === id);
    }
  }
  show(active);

  return {
    el,
    show,
    update() {
      // Only the visible stack is repainted. Everything else is a few hundred DOM writes a frame
      // that nobody can see.
      const i = groups.findIndex((g) => g.id === active);
      for (const p of groups[i].panels) p.update();
    },
  };
}
