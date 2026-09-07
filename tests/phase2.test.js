/**
 * tests/phase2.test.js — the identification experiments, the curriculum, the energy accounting
 * and the two final elements, tested through the whole rig.
 *
 * These are integration tests by intent. Each one asserts a claim the application makes to the
 * person using it — "the step test gives you a model", "sleep saves energy", "a drive is cheaper
 * than a valve" — and would fail if the claim stopped being true, whichever module broke it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../src/core/sim.js';
import { STEP, simcTuning, modelRules, rankTunings, createStepTestState, startStepTest, stepStepTest } from '../src/control/autotune.js';
import { loopResponse, margins, predictStep, DEFAULT_GRID } from '../src/control/analysis.js';
import { createPidConfig, MODE } from '../src/control/pid.js';
import { LESSONS } from '../src/control/lessons.js';
import { SCENARIOS } from '../src/control/scenario.js';
import { CRITERION } from '../src/control/staging.js';
import { FINAL, throttleRange } from '../src/process/plant.js';
import { simFor, run, near, nearRel, fopdt } from './helpers.js';

/* ============================================================================================
 * Identification
 * ========================================================================================== */

test('the step test recovers a FOPDT model it was run against', () => {
  const MODEL = { K: 0.06, tau: 8, theta: 2.5 };
  const dt = 0.2;
  const proc = fopdt({ ...MODEL, dt, y0: 3, u0: 0 });
  const st = createStepTestState();
  assert.ok(startStepTest(st, { co: 40, du: 10, t_s: 0, outLo: 0, outHi: 100 }).ok);

  let t = 0;
  let y = 3;
  let guard = 0;
  while ((st.phase === STEP.SETTLING || st.phase === STEP.RECORDING) && guard < 200000) {
    const u = stepStepTest(st, y, t, dt, 1e-6);
    y = 3 + proc.step(u - 40);
    t += dt;
    guard += 1;
  }
  assert.equal(st.phase, STEP.DONE, st.message);
  nearRel(st.model.K, MODEL.K, 0.05, 'identified gain');
  nearRel(st.model.tau, MODEL.tau, 0.15, 'identified time constant');
  near(st.model.theta, MODEL.theta, 1.0, 'identified dead time');
  assert.match(st.message, /theta\/tau/, 'and the message must say how hard the loop is');
});

test('a step test on a process that never settles gives up rather than hanging', () => {
  const st = createStepTestState();
  startStepTest(st, { co: 40, du: 10, t_s: 0, outLo: 0, outHi: 100 });
  let t = 0;
  let guard = 0;
  // A measurement that drifts forever: the settle test must never be satisfied.
  while ((st.phase === STEP.SETTLING || st.phase === STEP.RECORDING) && guard < 200000) {
    stepStepTest(st, t * 0.01, t, 0.2, 1e-6);
    t += 0.2;
    guard += 1;
  }
  assert.equal(st.phase, STEP.FAILED);
  assert.match(st.message, /never settled/);
});

test('a step that would leave the output range is refused, with the number', () => {
  const st = createStepTestState();
  const r = startStepTest(st, { co: 95, du: 10, t_s: 0, outLo: 0, outHi: 100 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /105/);
});

test('SIMC lands near thirty degrees of phase margin, which is what it is derived to do', () => {
  for (const m of [{ K: 0.05, tau: 3, theta: 1.1 }, { K: 0.4, tau: 30, theta: 4 }, { K: 2, tau: 1, theta: 1 }]) {
    const t = simcTuning(m, m.theta);
    const cfg = createPidConfig({ Kc: t.Kc, Ti: t.Ti, Td: 0 });
    const marg = margins(loopResponse(cfg, m, DEFAULT_GRID));
    assert.ok(marg.stable, 'SIMC must never produce an unstable loop');
    assert.ok(marg.pm_deg > 40 && marg.pm_deg < 80,
      `SIMC gave ${marg.pm_deg.toFixed(0)} degrees on K=${m.K} tau=${m.tau} theta=${m.theta}`);
  }
});

test('SIMC caps the reset time, which is what stops it from ignoring load disturbances', () => {
  // A lag-dominant process: the uncapped IMC rule would set Ti = tau = 300 s, which rejects
  // nothing. The cap is the whole difference between the rules.
  const m = { K: 0.05, tau: 300, theta: 2 };
  const t = simcTuning(m, m.theta);
  assert.ok(t.Ti < 20, `Ti came back ${t.Ti.toFixed(1)} s; the cap is 4*(tc + theta) = 16 s`);
});

test('the ranked table puts the unstable candidates last, whatever their pedigree', () => {
  const model = { K: 0.05, tau: 3, theta: 1.1 };
  const rules = [
    ...modelRules(model),
    { id: 'MAD', name: 'far too much gain', Kc: 5000, Ti: 0.2, Td: 0, note: '' },
  ];
  const ranked = rankTunings(rules, model, {
    loopResponse, margins, predictStep, grid: DEFAULT_GRID,
  }, createPidConfig(), 0.2);
  assert.equal(ranked[ranked.length - 1].id, 'MAD', 'an unstable tuning cannot rank above a stable one');
  assert.ok(ranked[0].margins.stable);
  for (const r of ranked) {
    assert.ok(Number.isFinite(r.predicted.overshootPct), `${r.name} must have a prediction`);
  }
});

test('a relay test then a step test leave a model and a ranked table on the rig', () => {
  const ctx = simFor(180);
  assert.equal(ctx.model, null, 'nothing is known about the process to begin with');
  assert.equal(sim.tuningCandidates(ctx).rules.length, 0);

  assert.ok(sim.beginStepTest(ctx, { du: 8 }).ok);
  for (let i = 0; i < 1600 / ctx.config.dt_s
    && (ctx.stepTest.phase === STEP.SETTLING || ctx.stepTest.phase === STEP.RECORDING); i += 1) {
    run(ctx, ctx.config.dt_s);
  }
  assert.equal(ctx.stepTest.phase, STEP.DONE, ctx.stepTest.message);
  assert.ok(ctx.model, 'the rig must now have a model');
  assert.ok(ctx.model.K > 0 && ctx.model.tau > 0, 'a sensible one');
  assert.ok(ctx.margins, 'and margins for the tuning it is running');
  assert.equal(ctx.pid.mode, MODE.AUTO, 'and the controller must be handed back');

  const cand = sim.tuningCandidates(ctx);
  assert.ok(cand.ranked, 'with a model, the candidates can be ranked');
  assert.ok(cand.rules.length >= 4);
  const applied = sim.applyTuningRule(ctx, cand.rules[0].id);
  assert.ok(applied.ok, applied.reason);
  run(ctx, 300);
  near(ctx.plant.pt_bar, ctx.pid.sp, 0.06, 'and the applied tuning must hold setpoint');
});

test('two experiments cannot run at once, and each says which one has the output', () => {
  const ctx = simFor(180);
  assert.ok(sim.beginStepTest(ctx, { du: 6 }).ok);
  const r = sim.beginAutotune(ctx, { d: 8 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /step test/);
  assert.equal(sim.setControllerMode(ctx, MODE.AUTO).ok, false, 'and the operator cannot take it back');
  assert.ok(sim.cancelStepTest(ctx).ok);
  assert.ok(sim.beginAutotune(ctx, { d: 8 }).ok, 'once it is aborted, the relay can have it');
});

/* ============================================================================================
 * The scan period — a documented control that has to actually do something
 * ========================================================================================== */

test('the scan period is writable through the frozen config, and it costs the loop margin', () => {
  const ctx = simFor(60);
  assert.ok(sim.setScan(ctx, 1.0).ok);
  near(ctx.config.scan_s, 1.0, 1e-12, 'the config must actually take the new value');
  assert.equal(sim.setScan(ctx, 9).ok, false, 'and refuse a silly one');
  near(ctx.config.scan_s, 1.0, 1e-12, 'without changing anything');

  sim.setModel(ctx, { K: 0.05, tau: 3, theta: 1.1 });
  const slow = ctx.margins.pm_deg;
  sim.setScan(ctx, 0.1);
  const fast = ctx.margins.pm_deg;
  assert.ok(fast > slow + 3,
    `a slower scan is dead time and must cost phase margin: ${slow.toFixed(0)} against ${fast.toFixed(0)} degrees`);
});

/* ============================================================================================
 * The two final elements
 * ========================================================================================== */

test('a throttle valve can only hold a pressure the pumps already exceed, and the rig says so', () => {
  const ctx = simFor(60);
  const band = throttleRange(ctx.config, ctx.plant);
  assert.ok(band.ok);
  assert.ok(band.lo_bar < band.hi_bar, 'wide open is the floor and nearly shut is the ceiling');

  // Switching to the throttle with a setpoint below that floor must move the fixed speed rather
  // than leave the operator with a loop that saturates and never explains itself.
  sim.setSetpoint(ctx, 2.2);
  run(ctx, 120);
  assert.ok(sim.setDisturbance(ctx, { finalElement: FINAL.THROTTLE }).ok);
  const after = throttleRange(ctx.config, ctx.plant);
  assert.ok(after.lo_bar < 2.2 && 2.2 < after.hi_bar,
    `2.2 bar must end up inside ${after.lo_bar.toFixed(2)}..${after.hi_bar.toFixed(2)} bar`);
  run(ctx, 400);
  near(ctx.plant.pt_bar, ctx.pid.sp, 0.1, 'and the loop must then hold it on the valve');
});

test('the controller action follows the physics when the final element changes', () => {
  const ctx = simFor(60);
  assert.equal(ctx.pidCfg.action, 'REVERSE', 'more speed is more pressure');
  sim.setDisturbance(ctx, { finalElement: FINAL.THROTTLE });
  assert.equal(ctx.pidCfg.action, 'DIRECT', 'but more valve opening is LESS header pressure');
  sim.setLoopMode(ctx, 'FLOW');
  assert.equal(ctx.pidCfg.action, 'REVERSE', 'and more valve opening is MORE flow');
});

test('switching the final element does not step the machines', () => {
  const ctx = simFor(120);
  sim.setSetpoint(ctx, 3.2);
  run(ctx, 120);
  const before = ctx.plant.Qdemand_m3h;
  sim.setDisturbance(ctx, { finalElement: FINAL.THROTTLE });
  run(ctx, 2);
  assert.ok(Math.abs(ctx.plant.Qdemand_m3h - before) < 6,
    `the flow must not jump on the changeover: ${before.toFixed(1)} to ${ctx.plant.Qdemand_m3h.toFixed(1)}`);
});

test('holding the same duty on speed costs far less than holding it on a valve', () => {
  /**
   * Hold a flow setpoint one way and report the specific energy.
   * @param {string} element the final element
   * @returns {{kWh_m3:number, bar:number, q:number}} what it cost and where it sat
   */
  function hold(element) {
    const ctx = simFor(60);
    sim.setStaging(ctx, { enabled: false });
    sim.setLoopMode(ctx, 'FLOW');
    sim.setSetpoint(ctx, 22);
    sim.setDisturbance(ctx, { demandTarget: 0.55, fixedSpeed_pct: 80 });
    sim.setDisturbance(ctx, { finalElement: element });
    run(ctx, 400);
    sim.resetEnergy(ctx);
    run(ctx, 600);
    return {
      kWh_m3: ctx.run.energy.kWh / ctx.run.energy.m3,
      bar: ctx.plant.pt_bar,
      q: ctx.plant.Qdemand_m3h,
    };
  }
  const thr = hold(FINAL.THROTTLE);
  const vfd = hold(FINAL.VFD);
  near(thr.q, vfd.q, 1.5, 'the comparison is only honest at the same duty');
  assert.ok(thr.bar > vfd.bar + 1,
    'the throttled case must be sitting on a much higher header — that is the head being wasted');
  assert.ok(vfd.kWh_m3 < thr.kWh_m3 * 0.75,
    `speed control must be far cheaper: ${vfd.kWh_m3.toFixed(4)} against ${thr.kWh_m3.toFixed(4)} kWh/m3`);
});

/* ============================================================================================
 * Sequencing and energy
 * ========================================================================================== */

test('energy-optimal staging runs more machines more slowly, and it is cheaper for it', () => {
  /**
   * Sit at a demand under one staging criterion and report what it cost.
   * @param {string} criterion the staging criterion
   * @returns {{kWh_m3:number, pumps:number}} the cost and how many machines were on line
   */
  function settle(criterion) {
    const ctx = simFor(60);
    sim.setStaging(ctx, { criterion });
    sim.setDisturbance(ctx, { demandTarget: 0.70 });
    run(ctx, 400);
    sim.resetEnergy(ctx);
    run(ctx, 400);
    return {
      kWh_m3: ctx.run.energy.kWh / ctx.run.energy.m3,
      pumps: sim.summary(ctx).running,
    };
  }
  const byOutput = settle(CRITERION.OUTPUT);
  const byEnergy = settle(CRITERION.ENERGY);
  assert.ok(byEnergy.pumps > byOutput.pumps,
    'at this duty the energy criterion should be running the extra machine');
  assert.ok(byEnergy.kWh_m3 < byOutput.kWh_m3 * 0.9,
    `and it must actually be cheaper: ${byEnergy.kWh_m3.toFixed(4)} against ${byOutput.kWh_m3.toFixed(4)}`);
});

test('sleep stops the set on no demand and wakes it on droop, without short-cycling', () => {
  const ctx = simFor(60);
  sim.setStaging(ctx, { sleepEnabled: true });
  sim.setDisturbance(ctx, { demandTarget: 0 });
  let asleep_s = 0;
  let wakes = 0;
  let was = false;
  for (let i = 0; i < 900 / ctx.config.dt_s; i += 1) {
    run(ctx, ctx.config.dt_s);
    if (ctx.staging.sleeping) asleep_s += ctx.config.dt_s;
    if (was && !ctx.staging.sleeping) wakes += 1;
    was = ctx.staging.sleeping;
  }
  assert.ok(asleep_s > 400, `the set must spend most of a quiet quarter-hour stopped: ${asleep_s.toFixed(0)} s`);
  assert.ok(wakes <= 6, `and must not short-cycle doing it: ${wakes} wakes in 15 minutes`);
  assert.ok(ctx.plant.pt_bar > 2.5, 'while still holding a usable header on the gas cushion');

  // And it must come back when the demand does.
  sim.setDisturbance(ctx, { demandTarget: 0.5 });
  run(ctx, 200);
  assert.equal(ctx.staging.sleeping, false);
  near(ctx.plant.pt_bar, ctx.pid.sp, 0.15, 'and get back on setpoint');
});

test('the energy meter accounts for what the drives actually drew', () => {
  const ctx = simFor(120);
  sim.resetEnergy(ctx);
  run(ctx, 600);
  const e = ctx.run.energy;
  const s = sim.summary(ctx);
  assert.ok(e.kWh > 0 && e.m3 > 0);
  nearRel(e.kWh / e.m3, s.specific_kWh_m3, 1e-9, 'the headline figure is the meter divided out');
  assert.ok(e.usefulKWh < e.kWh, 'useful work is always less than what was drawn');
  assert.ok(s.wireToWater > 0.2 && s.wireToWater < 0.9, `wire-to-water ${s.wireToWater.toFixed(2)}`);
  nearRel(e.cost, e.kWh * ctx.config.energy.tariff_perkWh, 1e-9, 'and the cost is the tariff');
});

/* ============================================================================================
 * The curriculum
 * ========================================================================================== */

test('every lesson starts, arranges the rig, and can be left again', () => {
  for (const def of LESSONS) {
    const ctx = simFor(45);
    const r = sim.beginLesson(ctx, def.id);
    assert.ok(r.ok, `${def.id}: ${r.reason}`);
    assert.equal(ctx.lessons.def.id, def.id);
    run(ctx, 90);
    for (const o of def.objectives) {
      assert.ok(ctx.lessons.progress[o.id], `${def.id}: objective ${o.id} must be tracked`);
    }
    assert.ok(Number.isFinite(ctx.plant.H_m), `${def.id} must leave the plant finite`);
    const end = sim.endLesson(ctx);
    assert.ok(end.ok, `${def.id}: ${end.reason}`);
    assert.equal(ctx.lessons.def, null);
  }
});

test('leaving a lesson undoes the damage it deliberately did', () => {
  const ctx = simFor(45);
  sim.beginLesson(ctx, 'PONLY');
  assert.equal(ctx.pidCfg.Ti, Infinity, 'the lesson switches reset off, which is its whole point');
  run(ctx, 60);
  sim.endLesson(ctx);
  assert.ok(Number.isFinite(ctx.pidCfg.Ti) && ctx.pidCfg.Ti > 0, 'and leaving must put it back');

  sim.beginLesson(ctx, 'MINFLOW');
  assert.equal(ctx.plant.recircMode, 'CLOSED', 'this one shuts the recirculation');
  sim.endLesson(ctx);
  assert.equal(ctx.plant.recircMode, 'ARV', 'and leaving must open it again');
  assert.equal(ctx.pid.mode, MODE.AUTO, 'and hand the controller back to auto');
});

test('a lesson objective latches when it is met and reports when', () => {
  const ctx = simFor(45);
  sim.beginLesson(ctx, 'PONLY');
  run(ctx, 400);
  const p = ctx.lessons.progress.offset;
  assert.equal(p.met, true, 'proportional-only control leaves an offset, unaided');
  assert.ok(p.at_s > 0 && Number.isFinite(p.at_s), 'and the moment it did is recorded');
});

test('every scenario runs to completion and files a graded result', () => {
  for (const def of SCENARIOS) {
    const ctx = simFor(45);
    const r = sim.beginScenario(ctx, def.id);
    assert.ok(r.ok, `${def.id}: ${r.reason}`);
    let guard = 0;
    while (ctx.scenario.def && guard < (def.duration_s + 200) / ctx.config.dt_s) {
      run(ctx, ctx.config.dt_s);
      guard += 1;
    }
    assert.equal(ctx.scenario.def, null, `${def.id} must finish`);
    const res = ctx.scenario.last;
    assert.ok(res, `${def.id} must produce a result`);
    assert.ok(res.score >= 0 && res.score <= 100, `${def.id} score ${res.score}`);
    assert.ok(Number.isFinite(res.iae) && res.iae >= 0, `${def.id} IAE`);
    assert.ok(ctx.runs.runs.length >= 1, `${def.id} must be filed in the run library`);
    assert.ok(Number.isFinite(ctx.plant.H_m), `${def.id} must leave the plant finite`);
  }
});
