/**
 * tests/strategy.test.js — everything above a single PID: cascade, feedforward, gain scheduling,
 * setpoint reset and the override selector.
 *
 * Each structure is tested for the property it exists to provide AND for the failure it is prone
 * to. A cascade that works but winds its master up is not a working cascade; an override selector
 * that picks correctly but lets the losers drift is not a working selector.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStrategyConfig, createStrategyState, resetSetpoint, scheduledTuning, schedulingVariable,
  feedforward, selectOverrides, stepCascade, masterTracking, resetStrategy, STRUCTURE, SCHED_ON,
} from '../src/control/strategy.js';
import * as sim from '../src/core/sim.js';
import { simFor, run, near, nearRel } from './helpers.js';

test('the setpoint reset schedule follows a square law, because pipe friction does', () => {
  const cfg = createStrategyConfig();
  cfg.reset.spMin_bar = 1.6;
  cfg.reset.spMax_bar = 3.2;
  cfg.reset.qDesign_m3h = 100;
  near(resetSetpoint(cfg, 0), 1.6, 1e-12, 'at zero flow there is only the static head');
  near(resetSetpoint(cfg, 100), 3.2, 1e-12, 'at design flow, the design pressure');
  // Half the flow is a quarter of the friction, so a quarter of the way up the range.
  near(resetSetpoint(cfg, 50), 1.6 + 0.25 * 1.6, 1e-12, 'half flow, a quarter of the friction');
});

test('scheduled tuning interpolates between breakpoints and holds outside them', () => {
  const cfg = createStrategyConfig();
  cfg.sched.points = [{ at: 10, Kc: 20, Ti: 10, Td: 0 }, { at: 50, Kc: 10, Ti: 20, Td: 0 }];
  near(scheduledTuning(cfg, 5).Kc, 20, 1e-12, 'below the first point it holds');
  near(scheduledTuning(cfg, 90).Kc, 10, 1e-12, 'above the last point it holds');
  near(scheduledTuning(cfg, 30).Kc, 15, 1e-12, 'and interpolates linearly between');
  near(scheduledTuning(cfg, 30).Ti, 15, 1e-12, 'reset time too');
});

test('the scheduling variable reads whichever signal was chosen', () => {
  const cfg = createStrategyConfig();
  const plant = { ft_m3h: 42, drv: [{ n_pct: 80 }, { n_pct: 0 }] };
  const pid = { co: 63 };
  cfg.sched.on = SCHED_ON.FLOW;
  near(schedulingVariable(cfg, plant, pid), 42, 1e-12, 'flow');
  cfg.sched.on = SCHED_ON.OUTPUT;
  near(schedulingVariable(cfg, plant, pid), 63, 1e-12, 'output');
  cfg.sched.on = SCHED_ON.PUMPS;
  near(schedulingVariable(cfg, plant, pid), 1, 1e-12, 'how many machines are turning');
});

test('feedforward is zero when disabled, and scaled by its gain when not', () => {
  const cfg = createStrategyConfig();
  const sst = createStrategyState();
  near(feedforward(cfg, sst, 10, 0.2), 0, 1e-12, 'disabled means disabled');
  near(cfg.ff.raw_pct, 10, 1e-12, 'but the model answer is still published, for the panel');
  cfg.ff.enabled = true;
  cfg.ff.gain = 0.8;
  cfg.ff.lag_s = 0;
  cfg.ff.lead_s = 0;
  near(feedforward(cfg, sst, 10, 0.2), 8, 1e-9, 'and applied at its gain when enabled');
});

test('the feedforward lag delays the correction without changing where it ends up', () => {
  const cfg = createStrategyConfig();
  const sst = createStrategyState();
  cfg.ff.enabled = true;
  cfg.ff.gain = 1;
  cfg.ff.lag_s = 5;
  cfg.ff.lead_s = 0;
  const first = feedforward(cfg, sst, 10, 0.2);
  assert.ok(first < 2, 'a five-second lag must not pass a step through in one scan');
  for (let i = 0; i < 200; i += 1) feedforward(cfg, sst, 10, 0.2);
  near(cfg.ff.applied_pct, 10, 0.05, 'but forty seconds later it is all there');
});

test('the cascade maps master output onto the slave setpoint, and back again exactly', () => {
  const cfg = createStrategyConfig();
  cfg.cascade.spLo_m3h = 0;
  cfg.cascade.spHi_m3h = 140;
  const sst = createStrategyState();
  const r = stepCascade(cfg, sst, 50, 70, 0.2);
  near(r.sp_m3h, 70, 1e-12, 'half output is half the slave range');
  near(masterTracking(cfg, r.sp_m3h), 50, 1e-12, 'and the inverse round-trips');
  near(masterTracking(cfg, 0), 0, 1e-12, 'at the bottom');
  near(masterTracking(cfg, 140), 100, 1e-12, 'and at the top');
});

test('the override selector takes the lowest of the low-select group', () => {
  const cfg = createStrategyConfig();
  const sst = createStrategyState();
  cfg.override.current.enabled = true;
  cfg.override.current.limit_pct = 105;
  const plant = {
    drv: [{ i_pct: 130 }, { i_pct: 0 }],
    Q_m3h: [40, 0],
    pt_bar: 3.2,
  };
  // A machine well past its current limit: the constraint controller must pull the output down
  // and must be the one selected.
  let out = null;
  for (let i = 0; i < 200; i += 1) out = selectOverrides(cfg, sst, plant, 90, 0.2);
  assert.equal(out.selected, 'CURRENT', 'the binding constraint has to win');
  assert.ok(out.co_pct < 90, 'and it must actually pull the output back');
});

test('the losers of a selection are tracked, so taking over is bumpless', () => {
  const cfg = createStrategyConfig();
  const sst = createStrategyState();
  cfg.override.current.enabled = true;
  cfg.override.maxPressure.enabled = true;
  const plant = { drv: [{ i_pct: 40 }, { i_pct: 0 }], Q_m3h: [40, 0], pt_bar: 3.2 };
  // Ten minutes with neither constraint binding. Without integral tracking, both constraint
  // controllers would have wound their integrals to a limit by now.
  for (let i = 0; i < 3000; i += 1) selectOverrides(cfg, sst, plant, 45, 0.2);
  near(sst.ovCurrent.st.co, 45, 1.0, 'the current controller must be sitting where the plant is');
  near(sst.ovMaxP.st.co, 45, 1.0, 'and so must the pressure controller');
});

test('the minimum-flow override is a HIGH select, applied after the low select', () => {
  const cfg = createStrategyConfig();
  const sst = createStrategyState();
  cfg.override.minFlow.enabled = true;
  cfg.override.minFlow.limit_m3h = 30;
  const plant = { drv: [{ i_pct: 40 }, { i_pct: 0 }], Q_m3h: [5, 0], pt_bar: 3.2 };
  let out = null;
  for (let i = 0; i < 400; i += 1) out = selectOverrides(cfg, sst, plant, 20, 0.2);
  assert.equal(out.selected, 'MIN-FLOW');
  assert.ok(out.co_pct > 20, 'a minimum-flow constraint can only ever raise the output');
});

test('resetStrategy puts every controller the strategy owns back where the plant is', () => {
  const sst = createStrategyState();
  const cfg = createStrategyConfig();
  cfg.override.current.enabled = true;
  const plant = { drv: [{ i_pct: 200 }, { i_pct: 0 }], Q_m3h: [1, 0], pt_bar: 9 };
  for (let i = 0; i < 500; i += 1) selectOverrides(cfg, sst, plant, 80, 0.2);
  resetStrategy(sst, 37);
  near(sst.slave.st.co, 37, 1e-9, 'the slave');
  near(sst.ovCurrent.st.co, 37, 1e-9, 'and every constraint controller');
});

/* ============================================================================================
 * Against the real plant
 * ========================================================================================== */

test('feedforward cuts the peak deviation of a load step on the real rig', () => {
  /**
   * Take one load step and report the worst the header got.
   * @param {boolean} ff whether feedforward is on
   * @returns {number} peak absolute deviation, bar
   */
  function peakOf(ff) {
    const ctx = simFor(90);
    sim.setStaging(ctx, { enabled: false });
    sim.setStrategy(ctx, { ff: { enabled: ff, gain: 0.85, lag_s: 1 } });
    run(ctx, 60);
    sim.setDisturbance(ctx, { demandTarget: 0.68 });
    let peak = 0;
    for (let i = 0; i < 120 / ctx.config.dt_s; i += 1) {
      run(ctx, ctx.config.dt_s);
      peak = Math.max(peak, Math.abs(ctx.pid.sp - ctx.plant.p_bar));
    }
    return peak;
  }
  const without = peakOf(false);
  const with_ = peakOf(true);
  assert.ok(with_ < without * 0.75,
    `feedforward must materially help: ${with_.toFixed(3)} bar against ${without.toFixed(3)}`);
});

test('a cascade transfers bumplessly in both directions', () => {
  const ctx = simFor(120);
  const before = ctx.run.co_pct;
  const r = sim.setStrategy(ctx, { structure: STRUCTURE.CASCADE });
  assert.ok(r.ok, r.reason);
  run(ctx, 1);
  assert.ok(Math.abs(ctx.run.co_pct - before) < 6,
    `closing a cascade must not step the drives: ${before.toFixed(1)} to ${ctx.run.co_pct.toFixed(1)}`);
  run(ctx, 240);
  near(ctx.plant.pt_bar, ctx.pid.sp, 0.08, 'and the outer loop must still hold setpoint');

  const during = ctx.run.co_pct;
  sim.setStrategy(ctx, { structure: STRUCTURE.SINGLE });
  run(ctx, 1);
  assert.ok(Math.abs(ctx.run.co_pct - during) < 6, 'and opening it again must not step them either');
});

test('a flow-on-flow cascade is refused, because there is no inner variable left', () => {
  const ctx = simFor(30);
  sim.setLoopMode(ctx, 'FLOW');
  const r = sim.setStrategy(ctx, { structure: STRUCTURE.CASCADE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /inner variable/);
});

test('the setpoint reset schedule lowers the header as the demand falls', () => {
  const ctx = simFor(60);
  sim.setStrategy(ctx, {
    reset: { enabled: true, spMin_bar: 1.8, spMax_bar: 3.2, qDesign_m3h: 90 },
  });
  sim.setDisturbance(ctx, { demandTarget: 0.75 });
  run(ctx, 300);
  const busy = ctx.pid.sp;
  sim.setDisturbance(ctx, { demandTarget: 0.25 });
  run(ctx, 300);
  assert.ok(ctx.pid.sp < busy - 0.3,
    `the schedule must actually move the setpoint: ${busy.toFixed(2)} to ${ctx.pid.sp.toFixed(2)}`);
  assert.ok(ctx.pid.sp >= 1.8 - 1e-9, 'but never below the static head the far end still needs');

  // And it must refuse a manual setpoint while it owns the setpoint, rather than fighting.
  const r = sim.setSetpoint(ctx, 3.0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /reset schedule/);
});

test('setpoint reset saves energy at part load, which is the entire point of it', () => {
  /**
   * Deliver at a low demand for a while and report the specific energy.
   * @param {boolean} on whether the reset schedule is enabled
   * @returns {number} kWh per cubic metre
   */
  function specific(on) {
    const ctx = simFor(60);
    sim.setStrategy(ctx, {
      reset: { enabled: on, spMin_bar: 1.8, spMax_bar: 3.2, qDesign_m3h: 90 },
    });
    sim.setDisturbance(ctx, { demandTarget: 0.3 });
    run(ctx, 400);
    sim.resetEnergy(ctx);
    run(ctx, 600);
    return ctx.run.energy.kWh / ctx.run.energy.m3;
  }
  const flat = specific(false);
  const scheduled = specific(true);
  assert.ok(scheduled < flat * 0.92,
    `the schedule must pay for itself: ${scheduled.toFixed(4)} against ${flat.toFixed(4)} kWh/m3`);
});
