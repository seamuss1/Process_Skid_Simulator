/**
 * src/core/sim.js — the wall-clock accumulator, the tick order, and the complete list of things
 * an operator is allowed to do.
 *
 * Layer L4: imports everything below it. Imported by `src/ui/*` and by the tests. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * TWO CLOCKS, AND WHY THEY ARE DIFFERENT
 *
 * The plant integrates at 50 Hz. The controller scans at 5 Hz by default, and the scan period is
 * on the panel because it is a real tuning parameter that almost every simulator hides.
 *
 * A controller that scans as fast as the process integrates is a controller that does not exist.
 * Every scan period adds up to a scan period of dead time, the derivative term differentiates
 * across it, and a loop tuned against a continuous model will be a little livelier in the plant
 * than it was on the desk. Making the scan slower here — 1 s, say — visibly degrades a tuning
 * that looked fine at 0.1 s, which is the point.
 *
 * THE TICK ORDER IS FIXED AND IT MATTERS:
 *
 *   1. plant integrates on the LAST scan's outputs
 *   2. on a scan boundary: read instruments -> controller -> sequence -> alarms -> score
 *   3. log the trend
 *
 * The controller therefore never sees a measurement that its own current output helped produce.
 * Getting that backwards makes every tuning look better than it is.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, createRing, pushRing, clearRing, createBus } from './util.js';
import { buildConfig, LOOP, LOOP_EU, DEFAULT_SP } from '../data/config.js';
import {
  createPlantState, stepPlant, measuredPV, truePV, settlePlant,
} from '../process/plant.js';
import { DRIVE, start as startDrive, stop as stopDrive, reset as resetDrive } from '../process/motor.js';
import { createAlarmState, evaluateAlarms, acknowledgeAll, noteTransition } from '../process/alarms.js';
import {
  createPidConfig, createPidState, stepPid, setMode, resetPid, preload, MODE, ACTION,
} from '../control/pid.js';
import {
  createStagingConfig, createStagingState, stepStaging, HAND,
} from '../control/staging.js';
import {
  createAutotuneState, startRelay, stepAutotune, abortAutotune, tuningRules, TUNE,
} from '../control/autotune.js';
import {
  createScenarioState, stepScenario, startScenario, abortScenario, scoreNow, resetScore, SCENARIOS,
} from '../control/scenario.js';

/** Trend channels, in push order. */
export const TREND_CHANNELS = Object.freeze([
  't_s', 'sp', 'pv', 'pvTrue', 'co',
  'n1', 'n2', 'q1', 'q2', 'qdem', 'qbyp',
  'p_bar', 'level', 'i1', 'i2', 'npshm1', 'npshm2', 'kW', 'fcv',
]);

/** Wall-clock clamp, s. A backgrounded tab must not be able to fast-forward the plant. */
const WALL_CLAMP_S = 0.25;
/** Hard cap on physics ticks per animation frame, so a slow machine degrades instead of freezing. */
const MAX_TICKS_PER_FRAME = 400;

/** @returns {{ok:true}} the success result */
const ok = () => ({ ok: true });
/**
 * @param {string} reason human-readable refusal, shown verbatim
 * @returns {{ok:false, reason:string}} the failure result
 */
const fail = (reason) => ({ ok: false, reason });

/**
 * Build a complete, running simulation.
 *
 * @param {object} [patch] a config patch, for tests and scenarios
 * @returns {object} the context every view and action is given
 */
export function createSim(patch) {
  const config = buildConfig(patch);
  const plant = createPlantState(config);
  const mode = LOOP.PRESSURE;
  const pidCfg = createPidConfig({
    Kc: 18, Ti: 12, Td: 0, action: ACTION.REVERSE, outLo: 0, outHi: 100, outRate: 0,
  });
  const pid = createPidState(DEFAULT_SP[mode], 40);
  const stagingCfg = createStagingConfig();
  stagingCfg._drives = config.drives;
  const staging = createStagingState(config.pumps.length);

  const ctx = {
    config,
    plant,
    pid,
    pidCfg,
    staging,
    stagingCfg,
    autotune: createAutotuneState(),
    alarms: createAlarmState(),
    scenario: createScenarioState(),
    trend: createRing(TREND_CHANNELS, config.trendRows),
    bus: createBus(),
    run: {
      /** 'RUNNING' or 'PAUSED'. */
      state: 'RUNNING',
      /** Simulated seconds per wall second. */
      speed: 1,
      /** Simulated time, s. */
      t_s: 0,
      /** Which variable the loop controls, one of {@link LOOP}. */
      mode,
      /** Banked wall time not yet spent on ticks, s. */
      accum_s: 0,
      /** Time since the last controller scan, s. */
      scanAccum_s: 0,
      /** Time since the last trend sample, s. */
      trendAccum_s: 0,
      /** Set when the machine could not keep up with the requested speed. */
      deficit: false,
      /** Rolling diagnostics for the performance readout. */
      diag: { ticks: 0, msPerFrame: 0, scans: 0 },
      /** The live alarm list, rebuilt each scan. */
      alarmList: [],
      /** Worst active severity, or null. */
      worst: null,
      /** The most recent operator or sequence action, for the status line. */
      lastNote: 'rig started — PIC-101 in auto on one pump',
    },
  };

  // Start the lead pump and put the loop where the plant already is, so the first frame is calm.
  startDrive(config.drives[0], plant.drv[0]);
  plant.drv[0].state = DRIVE.RUNNING;
  plant.drv[0].n_pct = 67;
  plant.drv[0].cmd_pct = 40;
  settlePlant(config, plant);
  resetPid(pid, DEFAULT_SP[mode], 40);
  return ctx;
}

/**
 * Engineering-unit metadata for the loop's current mode.
 * @param {object} ctx the sim context
 * @returns {object} the {@link LOOP_EU} record
 */
export function loopEU(ctx) {
  return LOOP_EU[ctx.run.mode];
}

/**
 * One controller scan: read, compute, sequence, alarm, score.
 * @param {object} ctx the sim context
 * @param {number} scan_s the scan period, s
 * @returns {void}
 */
function controllerScan(ctx, scan_s) {
  const { config, plant, pid, pidCfg, staging, stagingCfg, autotune, run } = ctx;
  run.diag.scans += 1;

  const pv = measuredPV(plant, run.mode);

  // --- the autotuner borrows the output through MAN, so leaving it is bumpless by construction.
  if (autotune.phase === TUNE.SETTLING || autotune.phase === TUNE.CYCLING) {
    pid.coMan = stepAutotune(autotune, pv, run.t_s, pidCfg.action === ACTION.REVERSE);
    if (autotune.phase === TUNE.DONE || autotune.phase === TUNE.FAILED) {
      setMode(pid, autotune._prevMode || MODE.AUTO);
      run.lastNote = autotune.message;
      ctx.bus.emit('autotune', autotune);
    }
  }

  stepPid(pidCfg, pid, pv, scan_s);

  // --- sequence -------------------------------------------------------------------------------
  const before = [];
  for (let i = 0; i < plant.drv.length; i += 1) before.push(plant.drv[i].state);
  const action = stepStaging(stagingCfg, staging, pidCfg, pid, plant.drv, run.t_s, scan_s);
  for (let i = 0; i < plant.drv.length; i += 1) {
    const was = before[i];
    const now = plant.drv[i].state;
    const wasOn = was === DRIVE.RUNNING || was === DRIVE.STARTING;
    const isOn = now === DRIVE.RUNNING || now === DRIVE.STARTING;
    if (wasOn !== isOn) {
      noteTransition(ctx.alarms, run.t_s);
      ctx.scenario.m.starts += 1;
    }
  }
  if (action) {
    run.lastNote = action;
    ctx.bus.emit('sequence', action);
  }

  // --- alarms ----------------------------------------------------------------------------------
  const res = evaluateAlarms(config, plant, { sp: pid.sp, pv, mode: run.mode },
    ctx.alarms, run.t_s, scan_s);
  run.alarmList = res.list;
  run.worst = res.worst;
  for (const a of res.newly) ctx.bus.emit('alarm', a);

  // --- scorecard and scripted test --------------------------------------------------------------
  const fired = stepScenario(config, ctx.scenario, {
    t_s: run.t_s,
    dt_s: scan_s,
    sp: pid.sp,
    pv: truePV(plant, run.mode),
    co: pid.co,
    saturated: pid.saturated,
    mode: run.mode,
    plant,
    pid,
  });
  for (const label of fired) {
    run.lastNote = `test step — ${label}`;
    ctx.bus.emit('scenario', label);
  }
}

/**
 * Advance the simulation by one wall-clock interval.
 *
 * Banked time is `wallDt * speed`, clamped so a hidden tab cannot fast-forward. Leftover debt is
 * DROPPED rather than banked and reported through `run.deficit`, because a simulator that tries
 * to catch up after a stall produces a transient the operator did not cause.
 *
 * @param {object} ctx the sim context
 * @param {number} wallDt_s wall seconds since the last call
 * @returns {number} how many physics ticks were run
 */
export function advance(ctx, wallDt_s) {
  const { config, plant, run } = ctx;
  if (run.state !== 'RUNNING') return 0;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

  run.accum_s += clamp(wallDt_s, 0, WALL_CLAMP_S) * run.speed;
  const dt = config.dt_s;
  let ticks = 0;

  while (run.accum_s >= dt && ticks < MAX_TICKS_PER_FRAME) {
    stepPlant(config, plant, dt);
    run.t_s = plant.t_s;
    ticks += 1;
    run.accum_s -= dt;

    for (const ev of plant.events) {
      run.lastNote = `${ev.tag}: ${ev.message}`;
      ctx.bus.emit('trip', ev);
    }

    run.scanAccum_s += dt;
    if (run.scanAccum_s >= config.scan_s - 1e-9) {
      controllerScan(ctx, run.scanAccum_s);
      run.scanAccum_s = 0;
    }

    run.trendAccum_s += dt;
    if (run.trendAccum_s >= config.trendPeriod_s - 1e-9) {
      logTrend(ctx);
      run.trendAccum_s = 0;
    }
  }

  run.deficit = run.accum_s >= dt;
  if (run.deficit) run.accum_s = 0;
  run.diag.ticks = ticks;
  run.diag.msPerFrame = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  ctx.bus.emit('tick', ctx);
  return ticks;
}

/** Scratch row for the trend push, so logging allocates nothing. */
const TREND_ROW = new Float64Array(TREND_CHANNELS.length);

/**
 * Append one row to the trend ring.
 * @param {object} ctx the sim context
 * @returns {void}
 */
function logTrend(ctx) {
  const { plant, pid, run } = ctx;
  const r = TREND_ROW;
  r[0] = run.t_s;
  r[1] = pid.sp;
  r[2] = measuredPV(plant, run.mode);
  r[3] = truePV(plant, run.mode);
  r[4] = pid.co;
  r[5] = plant.drv[0].n_pct;
  r[6] = plant.drv[1].n_pct;
  r[7] = plant.Q_m3h[0];
  r[8] = plant.Q_m3h[1];
  r[9] = plant.Qdemand_m3h;
  r[10] = plant.Qbypass_m3h;
  r[11] = plant.p_bar;
  r[12] = plant.level_m;
  r[13] = plant.drv[0].i_pct;
  r[14] = plant.drv[1].i_pct;
  r[15] = plant.npsha_m[0] - plant.npshr_m[0];
  r[16] = plant.npsha_m[1] - plant.npshr_m[1];
  r[17] = plant.P_kW[0] + plant.P_kW[1];
  r[18] = plant.fcv * 100;
  pushRing(ctx.trend, r);
}

// ==============================================================================================
// ACTIONS — the complete list of things an operator may do. Every one validates, records a note
// and returns {ok, reason?}. The views call these and nothing else; nothing in `src/ui` writes a
// field on `plant`, `pid` or `run` directly.
// ==============================================================================================

/**
 * Record what just happened, for the status line.
 * @param {object} ctx the sim context
 * @param {string} line one line of description
 * @returns {{ok:true}} the success result
 */
function note(ctx, line) {
  ctx.run.lastNote = line;
  ctx.bus.emit('action', line);
  return ok();
}

/** @param {object} ctx the sim context @returns {{ok:true}} result */
export function togglePause(ctx) {
  ctx.run.state = ctx.run.state === 'RUNNING' ? 'PAUSED' : 'RUNNING';
  return note(ctx, ctx.run.state === 'RUNNING' ? 'running' : 'paused — the plant is frozen');
}

/**
 * @param {object} ctx the sim context
 * @param {number} x simulated seconds per wall second
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setSpeed(ctx, x) {
  if (!(x > 0) || x > 60) return fail('speed must be between 0 and 60x');
  ctx.run.speed = x;
  return note(ctx, `time compression ${x}x`);
}

/**
 * Switch the controlled variable, carrying the output across bumplessly.
 * @param {object} ctx the sim context
 * @param {string} mode one of {@link LOOP}
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setLoopMode(ctx, mode) {
  if (!LOOP_EU[mode]) return fail(`unknown loop mode ${mode}`);
  if (ctx.run.mode === mode) return ok();
  if (ctx.autotune.phase === TUNE.CYCLING || ctx.autotune.phase === TUNE.SETTLING) {
    return fail('an autotune is running — abort it first');
  }
  ctx.run.mode = mode;
  const eu = LOOP_EU[mode];
  // Gains carry units, so a gain tuned in bar is meaningless in m3/h. Rather than silently
  // rescaling somebody's tuning, the controller is put back to a conservative default for the new
  // variable and the operator is told.
  ctx.pidCfg.Kc = mode === LOOP.FLOW ? 1.4 : 22;
  ctx.pidCfg.Ti = mode === LOOP.FLOW ? 6 : 14;
  ctx.pidCfg.Td = 0;
  ctx.pid.spTarget = DEFAULT_SP[mode];
  ctx.pid.sp = DEFAULT_SP[mode];
  ctx.pid.primed = false;
  preload(ctx.pid, ctx.pid.co);
  return note(ctx, `${eu.tag} selected — gains reset to the default for ${eu.unit}`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} sp setpoint, engineering units
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setSetpoint(ctx, sp) {
  const eu = loopEU(ctx);
  if (!Number.isFinite(sp) || sp < eu.lo || sp > eu.hi) {
    return fail(`setpoint must be between ${eu.lo} and ${eu.hi} ${eu.unit}`);
  }
  ctx.pid.spTarget = sp;
  return note(ctx, `${eu.tag} SP ${sp.toFixed(eu.dp)} ${eu.unit}`);
}

/**
 * @param {object} ctx the sim context
 * @param {string} mode one of {@link MODE}
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setControllerMode(ctx, mode) {
  if (ctx.autotune.phase === TUNE.CYCLING || ctx.autotune.phase === TUNE.SETTLING) {
    return fail('the autotuner owns the output — abort it first');
  }
  setMode(ctx.pid, mode);
  return note(ctx, `${loopEU(ctx).tag} to ${mode}`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} co output, percent
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setManualOutput(ctx, co) {
  if (ctx.pid.mode !== MODE.MAN) return fail('the controller is in AUTO');
  ctx.pid.coMan = clamp(co, ctx.pidCfg.outLo, ctx.pidCfg.outHi);
  return ok();
}

/**
 * Patch the tuning. Validated per field, because a zero reset time is an infinite gain and a
 * negative one is a controller that runs away.
 * @param {object} ctx the sim context
 * @param {object} patch fields of the tuning record to change
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setTuning(ctx, patch) {
  const c = ctx.pidCfg;
  const next = { ...c, ...patch };
  if (!(next.Kc > -1e5 && next.Kc < 1e5)) return fail('gain out of range');
  if (!(next.Ti > 0)) return fail('reset time must be greater than zero (use a very large value to disable integral)');
  if (!(next.Td >= 0)) return fail('rate time cannot be negative');
  if (!(next.N >= 2 && next.N <= 100)) return fail('derivative filter divisor must be between 2 and 100');
  if (!(next.b >= 0 && next.b <= 1)) return fail('setpoint weight b must be between 0 and 1');
  if (!(next.c >= 0 && next.c <= 1)) return fail('setpoint weight c must be between 0 and 1');
  if (!(next.outLo < next.outHi)) return fail('output limits are inverted');
  Object.assign(c, patch);
  return ok();
}

/**
 * @param {object} ctx the sim context
 * @param {number} s scan period, s
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setScan(ctx, s) {
  if (!(s >= ctx.config.dt_s && s <= 5)) return fail(`scan must be between ${ctx.config.dt_s} and 5 s`);
  // config is frozen by design; the scan period is the one field a session is allowed to retune,
  // so it lives on `run` and shadows the config value here.
  Object.defineProperty(ctx.config, 'scan_s', { value: s, writable: false, configurable: true });
  return note(ctx, `controller scan ${s} s`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {{ok:boolean, reason?:string}} result
 */
export function startPump(ctx, i) {
  const d = ctx.plant.drv[i];
  if (d.state === DRIVE.TRIPPED) return fail(`${ctx.config.pumps[i].tag} is tripped — reset it first`);
  ctx.staging.hand[i] = HAND.HAND;
  startDrive(ctx.config.drives[i], d);
  return note(ctx, `${ctx.config.pumps[i].tag} to HAND`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {{ok:boolean, reason?:string}} result
 */
export function stopPump(ctx, i) {
  ctx.staging.hand[i] = HAND.OFF;
  stopDrive(ctx.plant.drv[i]);
  return note(ctx, `${ctx.config.pumps[i].tag} to OFF — the sequence will stage around it`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {{ok:boolean, reason?:string}} result
 */
export function autoPump(ctx, i) {
  ctx.staging.hand[i] = HAND.AUTO;
  return note(ctx, `${ctx.config.pumps[i].tag} to AUTO`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {{ok:boolean, reason?:string}} result
 */
export function resetPump(ctx, i) {
  if (!resetDrive(ctx.plant.drv[i])) return fail(`${ctx.config.pumps[i].tag} is not tripped`);
  return note(ctx, `${ctx.config.pumps[i].tag} overload reset`);
}

/**
 * Trip a pump on purpose, so the sequence's response to losing a machine can be watched.
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {{ok:boolean, reason?:string}} result
 */
export function forceTrip(ctx, i) {
  const d = ctx.plant.drv[i];
  if (d.state === DRIVE.TRIPPED) return fail('already tripped');
  d.state = DRIVE.TRIPPED;
  d.trip = 'simulated fault injected by the operator';
  return note(ctx, `${ctx.config.pumps[i].tag} tripped — injected fault`);
}

/**
 * Patch a staging setting, with the same validation discipline as the tuning.
 * @param {object} ctx the sim context
 * @param {object} patch fields to change
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setStaging(ctx, patch) {
  const next = { ...ctx.stagingCfg, ...patch };
  if (!(next.stageUp_pct > next.stageDown_pct)) {
    return fail('the stage-up threshold must be above the stage-down threshold, or the sequence will chatter');
  }
  if (!(next.stageUpDelay_s >= 0 && next.stageDownDelay_s >= 0)) return fail('delays cannot be negative');
  if (!(next.minRun_s >= 0 && next.minStop_s >= 0)) return fail('timers cannot be negative');
  Object.assign(ctx.stagingCfg, patch);
  return ok();
}

/**
 * The disturbance surface: everything the operator can do TO the plant rather than to the loop.
 * @param {object} ctx the sim context
 * @param {object} patch any of demandTarget, hDischarge_m, T_C, foul, bypass, makeupAuto
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setDisturbance(ctx, patch) {
  const p = ctx.plant;
  if (patch.demandTarget !== undefined) p.demandTarget = clamp(patch.demandTarget, 0, 1);
  if (patch.hDischarge_m !== undefined) p.hDischarge_m = clamp(patch.hDischarge_m, 0, 60);
  if (patch.T_C !== undefined) p.T_C = clamp(patch.T_C, 4, 98);
  if (patch.foul !== undefined) p.foul = clamp(patch.foul, 0, 0.95);
  if (patch.bypass !== undefined) p.bypass = clamp(patch.bypass, 0, 1);
  if (patch.makeupAuto !== undefined) p.makeupAuto = !!patch.makeupAuto;
  if (patch.level_m !== undefined) {
    p.level_m = clamp(patch.level_m, 0, ctx.config.tank.height_m);
    p.V_m3 = p.level_m * ctx.config.tank.area_m2;
  }
  return ok();
}

/**
 * Begin a relay-feedback autotune about the current operating point.
 * @param {object} ctx the sim context
 * @param {object} [opts] relay amplitude `d` and hysteresis `h`
 * @returns {{ok:boolean, reason?:string}} result
 */
export function beginAutotune(ctx, opts) {
  const { pid, pidCfg, autotune, run } = ctx;
  if (autotune.phase === TUNE.CYCLING || autotune.phase === TUNE.SETTLING) {
    return fail('an autotune is already running');
  }
  const eu = loopEU(ctx);
  // The relay swings the output about the point the loop is sitting at, and switches about the
  // setpoint. If those two are not the same point, the measurement never comes back across the
  // switching line and the relay simply parks at one end — a failure mode that looks like a hung
  // experiment rather than the operator error it is. So it is refused up front, with the number.
  const pvNow = measuredPV(ctx.plant, run.mode);
  const off = Math.abs(pvNow - pid.sp);
  if (off > 0.02 * (eu.hi - eu.lo)) {
    return fail(`${eu.pv} is ${off.toPrecision(2)} ${eu.unit} off setpoint. A relay test has to `
      + 'start from a settled loop — let it come to setpoint in AUTO first.');
  }
  const d = (opts && opts.d) || 12;
  const h = (opts && opts.h !== undefined) ? opts.h : (run.mode === LOOP.FLOW ? 1.2 : 0.02);
  const res = startRelay(autotune, {
    bias: pid.co,
    sp: pid.sp,
    d,
    h,
    t_s: run.t_s,
    outLo: pidCfg.outLo,
    outHi: pidCfg.outHi,
  });
  if (!res.ok) return res;
  autotune._prevMode = pid.mode;
  setMode(pid, MODE.MAN);
  pid.coMan = pid.co;
  return note(ctx, `relay autotune on ${eu.tag} — ${d}% amplitude about ${pid.co.toFixed(0)}%`);
}

/**
 * @param {object} ctx the sim context
 * @returns {{ok:boolean, reason?:string}} result
 */
export function cancelAutotune(ctx) {
  const { autotune, pid } = ctx;
  if (autotune.phase !== TUNE.CYCLING && autotune.phase !== TUNE.SETTLING) {
    return fail('no autotune is running');
  }
  abortAutotune(autotune);
  setMode(pid, autotune._prevMode || MODE.AUTO);
  return note(ctx, 'autotune aborted — controller returned to its previous mode');
}

/**
 * Apply one of the rule sets derived from a completed autotune.
 * @param {object} ctx the sim context
 * @param {string} ruleId one of the ids from {@link tuningRules}
 * @returns {{ok:boolean, reason?:string}} result
 */
export function applyTuningRule(ctx, ruleId) {
  const { autotune } = ctx;
  if (autotune.phase !== TUNE.DONE) return fail('no completed autotune to apply');
  const rule = tuningRules(autotune.Ku, autotune.Tu).find((r) => r.id === ruleId);
  if (!rule) return fail(`unknown rule ${ruleId}`);
  const res = setTuning(ctx, { Kc: rule.Kc, Ti: rule.Ti, Td: rule.Td });
  if (!res.ok) return res;
  return note(ctx, `${rule.name} applied — Kc ${rule.Kc.toPrecision(3)}, `
    + `Ti ${rule.Ti.toPrecision(3)} s, Td ${rule.Td ? rule.Td.toPrecision(3) : 0} s`);
}

/**
 * @param {object} ctx the sim context
 * @param {string} id one of the {@link SCENARIOS} ids
 * @returns {{ok:boolean, reason?:string}} result
 */
export function beginScenario(ctx, id) {
  const def = SCENARIOS.find((s) => s.id === id);
  if (!def) return fail(`unknown test ${id}`);
  if (ctx.scenario.def) return fail('a test is already running');
  if (ctx.autotune.phase === TUNE.CYCLING || ctx.autotune.phase === TUNE.SETTLING) {
    return fail('an autotune is running — abort it first');
  }
  startScenario(ctx.scenario, def, ctx.run.t_s, ctx.pid.spTarget);
  return note(ctx, `${def.name} started — ${def.duration_s} s`);
}

/**
 * @param {object} ctx the sim context
 * @returns {{ok:boolean, reason?:string}} result
 */
export function cancelScenario(ctx) {
  if (!ctx.scenario.def) return fail('no test is running');
  abortScenario(ctx.scenario);
  return note(ctx, 'test aborted');
}

/**
 * Grade the metrics accumulated so far without waiting for a test to finish.
 * @param {object} ctx the sim context
 * @returns {{ok:true}} result
 */
export function gradeNow(ctx) {
  scoreNow(ctx.config, ctx.scenario, {
    mode: ctx.run.mode, plant: ctx.plant, pid: ctx.pid,
  });
  return note(ctx, `scored the last ${Math.round(ctx.scenario.m.t_s)} s`);
}

/**
 * @param {object} ctx the sim context
 * @returns {{ok:true}} result
 */
export function clearScore(ctx) {
  resetScore(ctx.scenario);
  return note(ctx, 'scorecard cleared');
}

/**
 * @param {object} ctx the sim context
 * @returns {{ok:true}} result
 */
export function ackAlarms(ctx) {
  const n = acknowledgeAll(ctx.alarms);
  return note(ctx, n ? `${n} alarm${n === 1 ? '' : 's'} acknowledged` : 'nothing to acknowledge');
}

/**
 * Clear the trend history without disturbing the plant.
 * @param {object} ctx the sim context
 * @returns {{ok:true}} result
 */
export function clearTrend(ctx) {
  clearRing(ctx.trend);
  return note(ctx, 'trend cleared');
}
