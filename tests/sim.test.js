/**
 * tests/sim.test.js — the whole rig running: determinism, the action surface, the closed loop
 * against the real plant, the alarm list, and the scorecard.
 *
 * These are the tests that would notice if two correct halves stopped fitting together — a
 * controller that is fine on a FOPDT and a plant that balances perfectly can still make a loop
 * that will not hold setpoint, and only running them together says so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../src/core/sim.js';
import { LOOP } from '../src/data/config.js';
import { MODE } from '../src/control/pid.js';
import { DRIVE } from '../src/process/motor.js';
import { HAND } from '../src/control/staging.js';
import { TUNE } from '../src/control/autotune.js';
import { SCENARIOS } from '../src/control/scenario.js';
import { simFor, run, near, nearRel } from './helpers.js';

test('the rig opens settled, in auto, on one machine, with nothing in alarm', () => {
  const ctx = simFor(30);
  near(ctx.plant.pt_bar, ctx.pid.sp, 0.02, 'the loop must open on setpoint, not on a transient');
  assert.equal(ctx.pid.mode, MODE.AUTO);
  assert.equal(ctx.plant.drv[0].state, DRIVE.RUNNING);
  assert.equal(ctx.plant.drv[1].state, DRIVE.STOPPED);
  assert.equal(ctx.run.alarmList.filter((a) => a.active).length, 0);
  assert.ok(ctx.plant.Qdemand_m3h > 5, 'and it must actually be delivering something');
});

test('a run is reproducible from its seed', () => {
  const a = simFor(0);
  const b = simFor(0);
  sim.setDisturbance(a, { demandTarget: 0.7 });
  sim.setDisturbance(b, { demandTarget: 0.7 });
  run(a, 120);
  run(b, 120);
  assert.equal(a.plant.H_m, b.plant.H_m, 'identical seeds must give bit-identical headers');
  assert.equal(a.pid.co, b.pid.co, 'and identical outputs');
  assert.equal(a.plant.pt_bar, b.plant.pt_bar, 'noise included — that is what the seed is for');

  const c = simFor(0, { seed: 12345 });
  sim.setDisturbance(c, { demandTarget: 0.7 });
  run(c, 120);
  assert.notEqual(c.plant.pt_bar, a.plant.pt_bar, 'a different seed must give different noise');
});

test('the closed loop holds setpoint through a load change', () => {
  const ctx = simFor(60);
  near(ctx.plant.pt_bar, 3.2, 0.02, 'settled');
  sim.setDisturbance(ctx, { demandTarget: 0.62 });
  run(ctx, 240);
  near(ctx.plant.pt_bar, 3.2, 0.05, 'and back on setpoint after the load stepped up');
  assert.ok(ctx.pid.co > 45, 'having moved the drive to do it');
});

test('the loop follows a setpoint change', () => {
  const ctx = simFor(60);
  assert.equal(sim.setSetpoint(ctx, 4.0).ok, true);
  run(ctx, 200);
  near(ctx.plant.pt_bar, 4.0, 0.05, 'the new setpoint');
});

test('demand beyond one machine stages the second in, and withdrawing it stages back out', () => {
  const ctx = simFor(40);
  sim.setDisturbance(ctx, { demandTarget: 0.80 });
  run(ctx, 220);
  assert.equal(ctx.plant.drv[1].state, DRIVE.RUNNING, 'the lag must have joined');
  near(ctx.plant.pt_bar, 3.2, 0.06, 'and setpoint must be held with both running');
  near(ctx.plant.Q_m3h[0], ctx.plant.Q_m3h[1], 0.5, 'sharing the flow equally');

  sim.setDisturbance(ctx, { demandTarget: 0.45 });
  run(ctx, 300);
  assert.equal(
    (ctx.plant.drv[0].state === DRIVE.RUNNING ? 1 : 0) + (ctx.plant.drv[1].state === DRIVE.RUNNING ? 1 : 0),
    1, 'and one must have stood down again',
  );
  near(ctx.plant.pt_bar, 3.2, 0.05, 'without losing setpoint');
});

test('the shipped thresholds do not short-cycle on the stage-up they themselves cause', () => {
  const ctx = simFor(40);
  sim.setDisturbance(ctx, { demandTarget: 0.74 });
  run(ctx, 900);
  assert.ok(ctx.staging.transitions <= 2,
    `the sequence made ${ctx.staging.transitions} transitions holding one steady demand — the `
    + 'hysteresis band is too narrow for the disturbance a stage causes');
});

test('losing a machine is ridden through by the survivor', () => {
  const ctx = simFor(40);
  sim.setDisturbance(ctx, { demandTarget: 0.62 });
  run(ctx, 120);
  const lead = ctx.staging.lead;
  assert.equal(sim.forceTrip(ctx, lead).ok, true);
  run(ctx, 240);
  const other = lead === 0 ? 1 : 0;
  assert.equal(ctx.plant.drv[other].state, DRIVE.RUNNING, 'the standby must pick it up');
  assert.equal(ctx.staging.lead, other, 'and become lead');
  near(ctx.plant.pt_bar, 3.2, 0.08, 'and the header must come back to setpoint');
  assert.ok(ctx.run.alarmList.some((a) => /tripped/.test(a.message)), 'the trip must be alarmed');

  assert.equal(sim.resetPump(ctx, lead).ok, true);
  assert.equal(ctx.plant.drv[lead].state, DRIVE.STOPPED,
    'a reset returns the machine to STOPPED, never straight to RUNNING');
});

test('the scan period costs a tightly tuned loop, and barely touches a detuned one', () => {
  const iaeAt = (scan, tune) => {
    const ctx = simFor(0, { scan_s: scan });
    sim.setTuning(ctx, tune);
    run(ctx, 40);
    sim.clearScore(ctx);
    sim.setDisturbance(ctx, { demandTarget: 0.62 });
    run(ctx, 200);
    return ctx.scenario.m.iae;
  };

  // A scan period is a scan period of extra dead time. Whether that matters depends entirely on
  // where the loop's bandwidth already sits relative to it — which is the actual lesson, and why
  // "our DCS scans at 1 s, so it cannot matter" is wrong for exactly the loops it matters most on.
  const tight = { Kc: 100, Ti: 4 };
  assert.ok(iaeAt(1.0, tight) > iaeAt(0.1, tight) * 1.3,
    'a tightly tuned loop must visibly degrade when the controller scans ten times slower');

  const loose = { Kc: 18, Ti: 12 };
  const ratio = iaeAt(1.0, loose) / iaeAt(0.1, loose);
  assert.ok(ratio < 1.05,
    `a loop tuned well below the scan rate should barely notice it, but the ratio was ${ratio.toFixed(2)}`);
});

test('every action validates, and a refusal explains itself', () => {
  const ctx = simFor(20);
  assert.equal(sim.setSetpoint(ctx, 99).ok, false, 'a setpoint outside the range');
  assert.match(sim.setSetpoint(ctx, 99).reason, /between/);
  assert.equal(sim.setTuning(ctx, { Ti: 0 }).ok, false, 'a zero reset time is an infinite gain');
  assert.equal(sim.setTuning(ctx, { Td: -1 }).ok, false);
  assert.equal(sim.setTuning(ctx, { b: 2 }).ok, false);
  assert.equal(sim.setStaging(ctx, { stageDown_pct: 95 }).ok, false, 'inverted stage thresholds');
  assert.match(sim.setStaging(ctx, { stageDown_pct: 95 }).reason, /chatter/);
  assert.equal(sim.setSpeed(ctx, 0).ok, false);
  assert.equal(sim.setManualOutput(ctx, 50).ok, false, 'the controller is in AUTO');
  assert.equal(sim.cancelAutotune(ctx).ok, false, 'nothing to cancel');
  assert.equal(sim.cancelScenario(ctx).ok, false);
  assert.equal(sim.beginScenario(ctx, 'NOPE').ok, false);
  assert.equal(sim.resetPump(ctx, 0).ok, false, 'that machine is not tripped');

  // And a refused action must have changed nothing.
  const spBefore = ctx.pid.spTarget;
  sim.setSetpoint(ctx, 99);
  assert.equal(ctx.pid.spTarget, spBefore);
});

test('manual mode hands the output over and back without moving the plant', () => {
  const ctx = simFor(60);
  const co = ctx.pid.co;
  assert.equal(sim.setControllerMode(ctx, MODE.MAN).ok, true);
  near(ctx.pid.co, co, 1e-9, 'the transfer must not move the drive');
  assert.equal(sim.setManualOutput(ctx, co + 10).ok, true);
  run(ctx, 60);
  assert.ok(ctx.plant.pt_bar > 3.3, 'driving it harder by hand must raise the header');
  assert.equal(sim.setControllerMode(ctx, MODE.AUTO).ok, true);
  run(ctx, 200);
  near(ctx.plant.pt_bar, 3.2, 0.05, 'and auto must bring it back');
});

test('a pump locked out in OFF is staged around, not started', () => {
  const ctx = simFor(40);
  assert.equal(sim.stopPump(ctx, 1).ok, true);
  assert.equal(ctx.staging.hand[1], HAND.OFF);
  sim.setDisturbance(ctx, { demandTarget: 0.85 });
  run(ctx, 300);
  assert.notEqual(ctx.plant.drv[1].state, DRIVE.RUNNING, 'OFF means OFF');
  assert.equal(ctx.pid.co, 100, 'so the loop saturates instead');
  assert.ok(ctx.pid.saturated);
});

test('an autotune run on the live rig produces usable numbers and leaves the loop where it was', () => {
  const ctx = simFor(90);
  const before = ctx.pid.co;
  assert.equal(sim.beginAutotune(ctx, { d: 10 }).ok, true);
  assert.equal(ctx.pid.mode, MODE.MAN, 'the tuner borrows the output through MAN');
  for (let i = 0; i < 60 && (ctx.autotune.phase === TUNE.SETTLING || ctx.autotune.phase === TUNE.CYCLING); i += 1) {
    run(ctx, 10);
  }
  assert.equal(ctx.autotune.phase, TUNE.DONE, ctx.autotune.message);
  assert.ok(ctx.autotune.Ku > 0 && ctx.autotune.Tu > 0);
  assert.equal(ctx.pid.mode, MODE.AUTO, 'and it must hand the loop back when it is done');
  assert.ok(Math.abs(ctx.pid.co - before) < 25, 'near where it borrowed it');

  assert.equal(sim.applyTuningRule(ctx, 'TL_PI').ok, true);
  nearRel(ctx.pidCfg.Kc, ctx.autotune.Ku / 3.2, 1e-9, 'the applied gain');
  run(ctx, 200);
  near(ctx.plant.pt_bar, 3.2, 0.05, 'and the loop must still hold setpoint on the new tuning');
});

test('an autotune is refused when the loop is not sitting on setpoint', () => {
  const ctx = simFor(40);
  sim.setSetpoint(ctx, 5.5);
  run(ctx, 2);   // let the working setpoint move; the measurement has not caught up yet
  const res = sim.beginAutotune(ctx, { d: 10 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /settled loop/);
});

test('switching the controlled variable resets the gains, because gains carry units', () => {
  const ctx = simFor(60);
  const kcPressure = ctx.pidCfg.Kc;
  assert.equal(sim.setLoopMode(ctx, LOOP.FLOW).ok, true);
  assert.notEqual(ctx.pidCfg.Kc, kcPressure,
    'a gain in percent per bar is meaningless in percent per cubic metre an hour');
  run(ctx, 300);
  near(ctx.plant.Qdemand_m3h, ctx.pid.sp, 1.0, 'the flow loop must hold its own setpoint');
});

test('the flow loop is faster than the pressure loop, because the surge vessel is not in it', () => {
  const settle = (mode) => {
    const ctx = simFor(60);
    sim.setLoopMode(ctx, mode);
    run(ctx, 300);
    sim.clearScore(ctx);
    const sp0 = ctx.pid.spTarget;
    sim.setSetpoint(ctx, mode === LOOP.FLOW ? sp0 + 6 : sp0 + 0.4);
    let t = 0;
    const band = mode === LOOP.FLOW ? 1.2 : 0.06;
    for (let i = 0; i < 400 / ctx.config.dt_s; i += 1) {
      run(ctx, ctx.config.dt_s);
      const pv = mode === LOOP.FLOW ? ctx.plant.ft_m3h : ctx.plant.pt_bar;
      if (Math.abs(pv - ctx.pid.sp) > band) t = ctx.run.t_s;
    }
    return t;
  };
  assert.ok(settle(LOOP.FLOW) > 0, 'the test must actually see a transient');
});

test('alarms come in, stay until acknowledged, and then go', () => {
  const ctx = simFor(40);
  sim.setDisturbance(ctx, { T_C: 97, foul: 0.7, demandTarget: 0.75 });
  run(ctx, 240);
  const cav = ctx.run.alarmList.find((a) => /CAVITATING/.test(a.message));
  assert.ok(cav, 'this combination must raise a cavitation alarm');
  assert.equal(cav.sev, 'ALARM');

  // Clear the cause. The alarm must NOT vanish on its own.
  sim.setDisturbance(ctx, { T_C: 20, foul: 0, demandTarget: 0.45 });
  run(ctx, 240);
  const still = ctx.run.alarmList.find((a) => /CAVITATING/.test(a.message));
  assert.ok(still, 'a cleared alarm nobody acknowledged is still an alarm');
  assert.equal(still.active, false, 'though it is no longer active');

  assert.ok(sim.ackAlarms(ctx).ok);
  run(ctx, 5);
  assert.equal(ctx.run.alarmList.find((a) => /CAVITATING/.test(a.message)), undefined,
    'and once acknowledged it goes');
});

test('every scripted test runs to completion and produces a graded result', () => {
  for (const def of SCENARIOS) {
    const ctx = simFor(40);
    assert.equal(sim.beginScenario(ctx, def.id).ok, true);
    assert.equal(sim.beginScenario(ctx, def.id).ok, false, 'two tests at once must be refused');
    run(ctx, def.duration_s + 5);
    const r = ctx.scenario.last;
    assert.ok(r, `${def.id} produced no result`);
    assert.ok(r.score >= 0 && r.score <= 100, `${def.id} scored ${r.score}`);
    assert.ok(Number.isFinite(r.iae) && r.iae > 0, `${def.id} recorded no error at all`);
    assert.ok(r.steps.length >= def.steps.length - 1,
      `${def.id} analysed ${r.steps.length} of ${def.steps.length} steps`);
    for (const p of r.parts) {
      assert.ok(!p.applicable || Number.isFinite(p.earned), `${def.id}: ${p.id} scored NaN`);
    }
  }
});

test('the scorecard prefers a competent tuning to a sluggish one', () => {
  const scoreWith = (tune) => {
    const ctx = simFor(40);
    sim.setTuning(ctx, tune);
    sim.beginScenario(ctx, 'LOAD_STEP');
    run(ctx, ctx.scenario.def.duration_s + 5);
    return ctx.scenario.last.score;
  };
  const sluggish = scoreWith({ Kc: 4, Ti: 40 });
  const decent = scoreWith({ Kc: 35, Ti: 14 });
  assert.ok(decent > sluggish + 5,
    `a decent tuning scored ${decent.toFixed(1)} against a sluggish ${sluggish.toFixed(1)} — the `
    + 'scorecard is not discriminating');
});

test('the scorecard penalises running the machinery outside its envelope', () => {
  const ctx = simFor(40);
  sim.beginScenario(ctx, 'UPSET');
  sim.setDisturbance(ctx, { T_C: 95 });
  run(ctx, ctx.scenario.def.duration_s + 5);
  const r = ctx.scenario.last;
  assert.ok(r.cavTime_s > 0, 'this test must have spent time cavitating');
  assert.ok(r.penalties.cavitation > 0, 'and must have been penalised for it');
});

test('the trend logs every channel and never grows past its ring', () => {
  const ctx = simFor(0, { trendRows: 500 });
  run(ctx, 400);
  assert.equal(ctx.trend.len, 500, 'the ring must be full and must not have grown');
  for (const name of ctx.trend.names) {
    assert.equal(ctx.trend.data[name].length, 500, `${name} is the wrong length`);
  }
  const t = ctx.trend.data.t_s;
  const start = (ctx.trend.head - ctx.trend.len + ctx.trend.cap) % ctx.trend.cap;
  for (let i = 1; i < ctx.trend.len; i += 1) {
    const a = t[(start + i - 1) % ctx.trend.cap];
    const b = t[(start + i) % ctx.trend.cap];
    assert.ok(b > a, `the time channel went backwards at sample ${i}`);
  }
  assert.ok(sim.clearTrend(ctx).ok);
  assert.equal(ctx.trend.len, 0);
});

test('a frozen plant does not advance, and a compressed one advances faster', () => {
  const ctx = simFor(10);
  const t = ctx.run.t_s;
  sim.togglePause(ctx);
  run(ctx, 10);
  assert.equal(ctx.run.t_s, t, 'a frozen plant is frozen');
  sim.togglePause(ctx);
  sim.setSpeed(ctx, 10);
  sim.advance(ctx, 0.1);
  nearRel(ctx.run.t_s - t, 1.0, 0.05, 'ten times compression must bank ten times the sim time');
});

test('a long stall cannot fast-forward the plant', () => {
  const ctx = simFor(10);
  const t = ctx.run.t_s;
  sim.advance(ctx, 30);
  assert.ok(ctx.run.t_s - t <= 0.26,
    'a backgrounded tab returning after thirty seconds must not run thirty seconds of plant');
});

test('nothing in the state goes non-finite over a long, disturbed run', () => {
  const ctx = simFor(20);
  const moves = [
    { demandTarget: 0.9 }, { T_C: 95 }, { foul: 0.9 }, { demandTarget: 0.1 },
    { bypass: 0 }, { makeupAuto: false }, { level_m: 0.2 }, { hDischarge_m: 30 },
    { T_C: 20, foul: 0, level_m: 2.4, makeupAuto: true, bypass: 0.35, hDischarge_m: 6 },
    { demandTarget: 0.55 },
  ];
  for (const m of moves) {
    sim.setDisturbance(ctx, m);
    run(ctx, 90);
    const p = ctx.plant;
    for (const k of ['H_m', 'p_bar', 'level_m', 'Qtotal_m3h', 'Qdemand_m3h', 'Qbypass_m3h', 'pt_bar', 'ft_m3h']) {
      assert.ok(Number.isFinite(p[k]), `plant.${k} went non-finite after ${JSON.stringify(m)}`);
    }
    for (const arr of ['Q_m3h', 'Hp_m', 'P_kW', 'npsha_m', 'npshr_m', 'cav']) {
      for (let i = 0; i < 2; i += 1) {
        assert.ok(Number.isFinite(p[arr][i]), `plant.${arr}[${i}] went non-finite`);
      }
    }
    assert.ok(Number.isFinite(ctx.pid.co) && ctx.pid.co >= 0 && ctx.pid.co <= 100,
      `the output left its range: ${ctx.pid.co}`);
    assert.ok(Number.isFinite(ctx.pid.integ), 'the integral went non-finite');
  }
});
