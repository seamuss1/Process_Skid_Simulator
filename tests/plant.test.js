/**
 * tests/plant.test.js — the network: mass balance, the integrator's agreement with the
 * steady-state solve, and its stability under the worst transient the rig can produce.
 *
 * The stability tests are the important ones. A linearly-implicit step is unconditionally stable
 * ONLY because g'(H) is negative everywhere, and that property depends on every branch term
 * keeping its sign. These tests are what would notice if one stopped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/data/config.js';
import {
  createPlantState, stepPlant, settlePlant, solveSteady, characteristicCurves, runningCount,
  predictOperatingPoint, throttleRange, FINAL,
} from '../src/process/plant.js';
import { DRIVE, speedToReference } from '../src/process/motor.js';
import { headToBar, barToHead } from '../src/core/util.js';
import { near, nearRel } from './helpers.js';

/**
 * A plant with both machines turning at a chosen speed and the valves where we want them.
 * @param {object} [over] initial disturbance settings
 * @param {number[]} [speeds=[80, 80]] shaft speeds, percent
 * @returns {{cfg:object, p:object}} the config and the settled plant
 */
function rig(over = {}, speeds = [80, 80]) {
  const cfg = buildConfig();
  const p = createPlantState(cfg);
  for (let i = 0; i < speeds.length; i += 1) {
    p.drv[i].state = speeds[i] > 0 ? DRIVE.RUNNING : DRIVE.STOPPED;
    p.drv[i].n_pct = speeds[i];
    // The drive reference has to agree with the shaft speed, or the very first `stepPlant` ramps
    // the machine back toward whatever 0% reference maps to.
    p.drv[i].cmd_pct = speedToReference(cfg.drives[i], speeds[i]);
  }
  Object.assign(p, over);
  if (over.level_m !== undefined) p.V_m3 = over.level_m * cfg.tank.area_m2;
  settlePlant(cfg, p);
  return { cfg, p };
}

test('at steady state, what the pumps deliver equals what the outlets swallow', () => {
  for (const x of [0.2, 0.45, 0.7, 0.9]) {
    const { p } = rig({ demandTarget: x });
    near(p.Qtotal_m3h - p.Qdemand_m3h - p.Qbypass_m3h, 0, 1e-6,
      `mass balance at demand ${x}`);
  }
});

test('the integrator converges to the same header the bisection solve finds', () => {
  const { cfg, p } = rig({ demandTarget: 0.55 });
  const analytic = solveSteady(cfg, p).H_m;
  // Kick it well away, then let the ODE find its own way back.
  p.H_m = analytic + 12;
  for (let i = 0; i < 60 / cfg.dt_s; i += 1) stepPlant(cfg, p, cfg.dt_s);
  nearRel(p.H_m, analytic, 2e-3,
    'the differential model and the algebraic model must agree at rest');
});

test('the header is a first-order lag, not an algebraic junction', () => {
  const { cfg, p } = rig({ demandTarget: 0.45 });
  const before = p.H_m;
  p.demandTarget = 0.62;
  stepPlant(cfg, p, cfg.dt_s);
  assert.ok(Math.abs(p.H_m - before) < 0.05,
    'one 20 ms tick must not teleport the header — the surge vessel has to hold it back');
  for (let i = 0; i < 90 / cfg.dt_s; i += 1) stepPlant(cfg, p, cfg.dt_s);
  assert.ok(p.H_m < before - 1, 'but ninety seconds later the extra demand must have told');
});

test('a valve slam cannot destabilise the integrator', () => {
  const { cfg, p } = rig({ demandTarget: 0.05 });
  // Instant full-open and full-close, repeatedly, bypassing the stroke limit entirely: far more
  // violent than anything the UI can ask for.
  for (let cycle = 0; cycle < 8; cycle += 1) {
    const x = cycle % 2 === 0 ? 1 : 0;
    p.fcv.x = x;
    p.fcv.cmd = x;
    for (let i = 0; i < 4 / cfg.dt_s; i += 1) {
      p.demandTarget = x;
      stepPlant(cfg, p, cfg.dt_s);
      assert.ok(Number.isFinite(p.H_m), 'the header head went non-finite');
      assert.ok(p.H_m > -50 && p.H_m < 400, `the header head ran away to ${p.H_m}`);
    }
  }
});

test('the integrator is stable at any step size, because the step is implicit', () => {
  // A plain explicit Euler step would blow up long before 2 s. This one degenerates gracefully
  // toward the steady-state answer instead.
  for (const dt of [0.02, 0.2, 1, 2]) {
    const { cfg, p } = rig({ demandTarget: 0.7 });
    const analytic = solveSteady(cfg, p).H_m;
    p.H_m = analytic - 15;
    for (let i = 0; i < Math.round(200 / dt); i += 1) stepPlant(cfg, p, dt);
    assert.ok(Number.isFinite(p.H_m), `dt = ${dt} s produced a non-finite header`);
    nearRel(p.H_m, analytic, 5e-3, `dt = ${dt} s must still land on the steady state`);
  }
});

test('two identical machines share the flow equally; one carries it all alone', () => {
  const both = rig({ demandTarget: 0.7 }, [85, 85]);
  near(both.p.Q_m3h[0], both.p.Q_m3h[1], 1e-9, 'identical pumps in parallel share equally');
  assert.equal(runningCount(both.p), 2);

  const solo = rig({ demandTarget: 0.7 }, [85, 0]);
  assert.equal(solo.p.Q_m3h[1], 0, 'a stopped machine passes nothing');
  assert.equal(solo.p.checkShut[1], 1, 'because its check valve is held shut by the header');
  assert.ok(solo.p.Q_m3h[0] > both.p.Q_m3h[0],
    'the surviving machine moves further out along its curve');
  assert.ok(solo.p.H_m < both.p.H_m, 'and the header falls');
});

test('a lag pump starting into a live header delivers nothing until it can beat it', () => {
  const { cfg, p } = rig({ demandTarget: 0.55 }, [90, 0]);
  const header = p.H_m;
  // Bring the second machine up slowly and find where its check valve cracks.
  let crackedAt = null;
  for (let n = 0; n <= 100; n += 0.5) {
    p.drv[1].state = DRIVE.RUNNING;
    p.drv[1].n_pct = n;
    settlePlant(cfg, p);
    if (crackedAt === null && p.Q_m3h[1] > 0.01) crackedAt = n;
  }
  assert.ok(crackedAt !== null, 'the lag pump must eventually contribute');
  const needed = Math.sqrt((header - p.zStatic_m) / cfg.pumps[1].H0_m) * 100;
  nearRel(crackedAt, needed, 0.03,
    'the check valve must crack exactly where shutoff head reaches the header — the dead time '
    + 'before that point is the whole difficulty of staging');
});

test('inventory closes: what leaves the tank shows up as level', () => {
  const { cfg, p } = rig({ demandTarget: 0.6, makeupAuto: false });
  p.inflow_m3h = 0;
  const V0 = p.V_m3;
  let drawn = 0;
  const dt = cfg.dt_s;
  for (let i = 0; i < 30 / dt; i += 1) {
    stepPlant(cfg, p, dt);
    drawn += ((p.Qtotal_m3h - p.Qbypass_m3h) / 3600) * dt;
  }
  nearRel(V0 - p.V_m3, drawn, 1e-6, 'the tank must lose exactly the net draw');
  near(p.level_m, p.V_m3 / cfg.tank.area_m2, 1e-12, 'level is inventory over area');
});

test('the make-up controller holds level against a steady draw', () => {
  const { cfg, p } = rig({ demandTarget: 0.7, makeupAuto: true });
  for (let i = 0; i < 600 / cfg.dt_s; i += 1) stepPlant(cfg, p, cfg.dt_s);
  near(p.level_m, cfg.tank.levelSP_m, 0.15, 'level after ten minutes of duty');
});

test('head and pressure convert through the CURRENT density, not a constant', () => {
  const cold = rig({ T_tank_C: 20, Tsupply_C: 20 }).p;
  const hot = rig({ T_tank_C: 90, Tsupply_C: 90 }).p;
  near(cold.p_bar, headToBar(cold.H_m, cold.fluid.rho_kgm3), 1e-12, 'cold conversion');
  near(barToHead(cold.p_bar, cold.fluid.rho_kgm3), cold.H_m, 1e-9, 'and it round-trips');
  assert.ok(hot.fluid.rho_kgm3 < cold.fluid.rho_kgm3 - 20, 'hot water is lighter');
});

test('hot liquid and a blinded strainer both eat the suction margin', () => {
  const base = rig({ demandTarget: 0.6 }).p;
  const marginOf = (p) => p.npsha_m[0] - p.npshr_m[0];
  assert.ok(marginOf(base) > 5, 'the default rig has plenty of margin, by design');
  assert.ok(marginOf(rig({ demandTarget: 0.6, T_tank_C: 90, Tsupply_C: 90 }).p) < marginOf(base) - 4,
    '90 C must cost several metres');
  assert.ok(marginOf(rig({ demandTarget: 0.6, foul: 0.85 }).p) < marginOf(base) - 2,
    'a blinded strainer must cost several metres');
  assert.ok(marginOf(rig({ demandTarget: 0.6, level_m: 0.4 }).p) < marginOf(base) - 1.5,
    'a low tank must cost the static head it no longer has');
});

test('cavitation is reachable, and it costs head', () => {
  const { cfg, p } = rig({ demandTarget: 0.7, T_tank_C: 96, Tsupply_C: 96, foul: 0.6 }, [100, 100]);
  for (let i = 0; i < 30 / cfg.dt_s; i += 1) stepPlant(cfg, p, cfg.dt_s);
  assert.ok(p.npsha_m[0] < p.npshr_m[0], 'this combination must break the suction margin');
  assert.ok(p.cav[0] < 0.95, 'and the pump must lose head for it');
  assert.ok(Number.isFinite(p.H_m) && p.H_m > 0, 'without the model falling over');
});

test('cavitation does not limit-cycle at the tick rate when a pump sits on its NPSH curve', () => {
  // Walk the temperature up to find the exact onset, then hold there and check that the head
  // multiplier settles instead of chattering. Before the inception lag was added, this is where
  // the plant produced a 25 Hz oscillation that was purely an artefact of the discretisation.
  const cfg = buildConfig();
  const p = createPlantState(cfg);
  p.drv[0].state = DRIVE.RUNNING;
  p.drv[0].n_pct = 85;
  p.demandTarget = 0.6;
  settlePlant(cfg, p);
  for (let T = 88; T <= 97; T += 0.5) {
    p.T_tank_C = T;
    p.Tsupply_C = T;
    for (let i = 0; i < 20 / cfg.dt_s; i += 1) stepPlant(cfg, p, cfg.dt_s);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 5 / cfg.dt_s; i += 1) {
      stepPlant(cfg, p, cfg.dt_s);
      lo = Math.min(lo, p.Q_m3h[0]);
      hi = Math.max(hi, p.Q_m3h[0]);
    }
    assert.ok(hi - lo < 1.0,
      `at ${T} C the flow swings ${(hi - lo).toFixed(2)} m3/h tick to tick — that is chatter, `
      + 'not physics');
  }
});

test('the curve sampler agrees with the live operating point', () => {
  const { cfg, p } = rig({ demandTarget: 0.6 });
  const cur = characteristicCurves(cfg, p, 400);
  // Find where the sampled pump and system curves cross, and check it is where the plant is.
  let cross = null;
  for (let j = 1; j < cur.Q.length; j += 1) {
    const a = cur.Hpump[j - 1] - cur.Hsys[j - 1];
    const b = cur.Hpump[j] - cur.Hsys[j];
    if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b < 0) {
      cross = cur.Q[j - 1] + (cur.Q[j] - cur.Q[j - 1]) * (a / (a - b));
      break;
    }
  }
  assert.ok(cross !== null, 'the two sampled curves must cross somewhere');
  nearRel(cross, p.Qtotal_m3h, 0.02,
    'the chart must be drawing the operating point the plant is actually at');
});
