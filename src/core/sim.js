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
 *   2. on a scan boundary:
 *        read instruments
 *        -> setpoint reset and gain scheduling decide what the controller is aiming at and with
 *        -> primary controller
 *        -> feedforward adds its correction
 *        -> cascade hands the result to the inner loop
 *        -> override selector decides who actually wins
 *        -> sequence starts and stops machines and distributes the output
 *        -> the final element is written
 *        -> alarms, diagnostics, scorecard, lesson
 *   3. log the trend
 *
 * The controller therefore never sees a measurement that its own current output helped produce.
 * Getting that backwards makes every tuning look better than it is.
 *
 * WHO OWNS THE OUTPUT. Four things can drive the final element and only one of them at a time:
 * the controller, the operator's hand, the relay autotuner, and the frequency sweep. The last
 * three all work by borrowing MANUAL, which means the handover in either direction is bumpless
 * for free and there is exactly one path from a number to the plant.
 * ------------------------------------------------------------------------------------------
 */

import {
  clamp, createRing, pushRing, clearRing, createBus, hydraulicPower_kW,
} from './util.js';
import {
  buildConfig, LOOP, LOOP_EU, DEFAULT_SP, DEFAULT_TUNING,
} from '../data/config.js';
import {
  createPlantState, stepPlant, measuredPV, truePV, settlePlant, solveSteady,
  outputForSetpoint, electricalPower_kW, usefulPower_kW, runningCount, throttleLoss_m,
  minimumFlow, throttleRange, speedForThrottleSetpoint, predictOperatingPoint, FINAL, RECIRC,
} from '../process/plant.js';
import {
  DRIVE, STOP_MODE, start as startDrive, stop as stopDrive, reset as resetDrive,
  trip as tripDrive, speedToReference, isCalled,
} from '../process/motor.js';
import { FLUID_BY_ID } from '../process/fluid.js';
import {
  createAlarmState, evaluateAlarms, acknowledgeAll, acknowledge, noteTransition,
} from '../process/alarms.js';
import {
  createPidConfig, createPidState, stepPid, setMode, resetPid, preload, convertForm,
  MODE, ACTION, FORM, ALGO,
} from '../control/pid.js';
import {
  createStrategyConfig, createStrategyState, resetSetpoint, scheduledTuning, schedulingVariable,
  feedforward, selectOverrides, stepCascade, masterTracking, resetStrategy, STRUCTURE,
} from '../control/strategy.js';
import {
  createStagingConfig, createStagingState, stepStaging, startsPerHour, HAND, CRITERION,
} from '../control/staging.js';
import {
  createAutotuneState, startRelay, stepAutotune, abortAutotune, tuningRules, modelRules,
  rankTunings, createStepTestState, startStepTest, stepStepTest, abortStepTest, TUNE, STEP,
} from '../control/autotune.js';
import {
  loopResponse, margins, predictStep, DEFAULT_GRID, createSweepState, startSweep, stepSweep,
  abortSweep, fitFromSweep, SWEEP,
} from '../control/analysis.js';
import {
  createDiagnostics, pushSample, analyse, resetDiagnostics,
} from '../control/diagnostics.js';
import {
  createScenarioState, stepScenario, startScenario, abortScenario, scoreNow, resetScore, SCENARIOS,
} from '../control/scenario.js';
import {
  createLessonState, startLesson, stepLesson, abortLesson, lessonProgress, restoreDefaults,
  LESSONS,
} from '../control/lessons.js';
import { createRunLibrary, saveRun } from '../io/export.js';

/** Trend channels, in push order. */
export const TREND_CHANNELS = Object.freeze([
  't_s', 'sp', 'pv', 'pvTrue', 'co',
  'n1', 'n2', 'q1', 'q2', 'qdem', 'qbyp',
  'p_bar', 'level', 'i1', 'i2', 'npshm1', 'npshm2', 'kW', 'fcv', 'pcv',
  'ff', 'temp', 'vib1', 'vib2', 'eta1', 'eta2', 'kWh_m3', 'slaveSp',
]);

/** Units for each trend channel, used by the CSV export and the trend legend. */
export const TREND_UNITS = Object.freeze({
  t_s: 's', sp: 'EU', pv: 'EU', pvTrue: 'EU', co: '%',
  n1: '%', n2: '%', q1: 'm3/h', q2: 'm3/h', qdem: 'm3/h', qbyp: 'm3/h',
  p_bar: 'bar', level: 'm', i1: '%', i2: '%', npshm1: 'm', npshm2: 'm',
  kW: 'kW', fcv: '%', pcv: '%', ff: '%', temp: 'C', vib1: 'mm/s', vib2: 'mm/s',
  eta1: '%', eta2: '%', kWh_m3: 'kWh/m3', slaveSp: 'm3/h',
});

/** Wall-clock clamp, s. A backgrounded tab must not be able to fast-forward the plant. */
const WALL_CLAMP_S = 0.25;
/** Hard cap on physics ticks per animation frame, so a slow machine degrades instead of freezing. */
const MAX_TICKS_PER_FRAME = 400;
/** How often the loop-health report is recomputed, s. It is not cheap and it is not urgent. */
const DIAG_PERIOD_S = 10;
/** How often the energy-optimal staging comparison is recomputed, s. Each one solves the plant. */
const ENERGY_PREDICT_PERIOD_S = 2;
/**
 * How long a diagnostic window is, s.
 *
 * Long enough to resolve a slow limit cycle, which is the binding requirement: a sticking valve
 * on a loop with a long reset can cycle at four or five minutes, and an autocorrelation can only
 * find a period it has room to reach. Fifteen minutes of history gives lag room for a seven-
 * minute cycle and several repeats of anything faster.
 */
const DIAG_WINDOW_S = 900;

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
  const pidCfg = createPidConfig({ ...DEFAULT_TUNING[mode], action: ACTION.REVERSE });
  const pid = createPidState(DEFAULT_SP[mode], 40);
  const stagingCfg = createStagingConfig();
  const staging = createStagingState(config.pumps.length);

  const ctx = {
    config,
    plant,
    pid,
    pidCfg,
    strat: createStrategyState(),
    stratCfg: createStrategyConfig(),
    staging,
    stagingCfg,
    autotune: createAutotuneState(),
    stepTest: createStepTestState(),
    sweep: createSweepState(),
    diag: createDiagnostics(Math.round(DIAG_WINDOW_S / config.scan_s), config.scan_s),
    alarms: createAlarmState(),
    scenario: createScenarioState(),
    lessons: createLessonState(),
    runs: createRunLibrary(),
    trend: createRing(TREND_CHANNELS, config.trendRows),
    bus: createBus(),

    /** The identified process model, or null until a test produces one. */
    model: null,
    /** Where the model came from, for the panel. */
    modelSource: null,
    /** Stability margins for the current tuning against the current model, or null. */
    margins: null,
    /** Predicted closed-loop step response for the current tuning, or null. */
    prediction: null,
    /** Id of the tuning rule last applied, so a lesson can tell that one was. */
    appliedRuleId: null,

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
      /** Time since the loop-health report was last rebuilt, s. */
      diagAccum_s: 0,
      /** Time since the staging energy comparison was last rebuilt, s. */
      energyAccum_s: 0,
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
      /** Rolling event feed: sequence actions, alarms, test steps, objectives met. */
      events: [],
      /** Cumulative energy accounting since the last reset. */
      energy: {
        elapsed_s: 0, kWh: 0, m3: 0, usefulKWh: 0, throttleKWh: 0, cost: 0,
      },
      /**
       * The output actually sent to the final element, percent, after every stage of the strategy
       * and any staging bias. This is the number the faceplate and the trend show.
       */
      co_pct: 40,
      /** What the cascade slave was last asked for, m3/h. */
      slaveSp_m3h: 0,
      /** Feedforward contribution actually applied this scan, percent. */
      ff_pct: 0,
      /** Which controller won the override selection this scan. */
      selected: 'PRIMARY',
    },
  };

  // Start the lead pump and put it at the speed that ALREADY holds the setpoint, so the first
  // frame is calm and the operator is not watching a transient they did not cause. The speed is
  // solved from the plant rather than written down, so it stays right when the rig is
  // reconfigured — a hard-coded 67% is correct until somebody changes a pipe.
  startDrive(config.drives[0], plant.drv[0]);
  plant.drv[0].state = DRIVE.RUNNING;
  plant.drv[0].n_pct = 60;
  settlePlant(config, plant);
  const boot = outputForSetpoint(config, plant, DEFAULT_SP[mode], mode);
  const drive0 = config.drives[0];
  const n0 = drive0.minSpeed_pct
    + (drive0.maxSpeed_pct - drive0.minSpeed_pct) * (boot.co_pct / 100);
  plant.drv[0].n_pct = n0;
  plant.drv[0].ref_pct = n0;
  plant.drv[0].cmd_pct = boot.co_pct;
  plant.drv[0].w_rads = (n0 / 100) * drive0.wRated_rads;
  settlePlant(config, plant);
  resetPid(pid, DEFAULT_SP[mode], boot.co_pct);
  resetStrategy(ctx.strat, pid.co);
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
 * Push a line onto the event feed, newest first, bounded.
 * @param {object} ctx the sim context
 * @param {string} kind category
 * @param {string} text the line
 * @returns {void}
 */
function pushEvent(ctx, kind, text) {
  ctx.run.events.unshift({ t_s: ctx.run.t_s, kind, text });
  if (ctx.run.events.length > 300) ctx.run.events.length = 300;
}

/**
 * Assemble the context a lesson objective is evaluated against. Everything a check might
 * reasonably want, flattened so the checks stay one-liners.
 * @param {object} ctx the sim context
 * @param {number} pv the measurement this scan
 * @param {number} prevPv the measurement last scan
 * @returns {object} the lesson context
 */
function lessonContext(ctx, pv, prevPv) {
  return {
    config: ctx.config,
    plant: ctx.plant,
    pid: ctx.pid,
    pidCfg: ctx.pidCfg,
    strat: ctx.strat,
    stratCfg: ctx.stratCfg,
    sq: ctx.staging,
    stagingCfg: ctx.stagingCfg,
    autotune: ctx.autotune,
    stepTest: ctx.stepTest,
    diagReport: ctx.diag.report,
    margins: ctx.margins,
    model: ctx.model,
    score: ctx.scenario.m,
    lastResult: ctx.scenario.last,
    appliedRuleId: ctx.appliedRuleId,
    t_s: ctx.run.t_s,
    sp: ctx.pid.sp,
    pv,
    dPv: pv - prevPv,
    co: ctx.pid.co,
    err: ctx.pid.sp - pv,
    electrical_kW: electricalPower_kW(ctx.plant),
  };
}

/**
 * The action surface a scripted lesson or scenario arranges the rig through.
 *
 * Scripts get the same validated entry points an operator has, not raw field access, so a script
 * cannot put the plant somewhere the panel would have refused to.
 *
 * @param {object} ctx the sim context
 * @returns {object} the bound actions
 */
function scriptApi(ctx) {
  return {
    setLoopMode: (m) => setLoopMode(ctx, m),
    setSetpoint: (v) => {
      // Straight to the target: a script is allowed to place the setpoint even where the reset
      // schedule owns it, because the script is what turned the schedule on.
      ctx.pid.spTarget = v;
      ctx.pid.sp = v;
      return ok();
    },
    setTuning: (p) => setTuning(ctx, p),
    setStaging: (p) => setStaging(ctx, p),
    setStrategy: (p) => setStrategy(ctx, p),
    setDisturbance: (p) => setDisturbance(ctx, p),
    setControllerMode: (m) => setControllerMode(ctx, m),
  };
}

/**
 * Predicted electrical power with a hypothetical number of machines running at the duty that
 * satisfies the present setpoint.
 *
 * The plant is a pure function of its state, so this works by putting the state where the
 * hypothesis says it would be, solving, reading the answer, and putting everything back. It is
 * the same trick `outputForSetpoint` uses, one level up.
 *
 * @param {object} ctx the sim context
 * @param {number} n how many machines to assume are running
 * @returns {number} predicted electrical kW, or NaN when the setpoint is not reachable that way
 */
function predictPowerWith(ctx, n) {
  const { config, plant, run } = ctx;
  const nP = plant.drv.length;
  if (n < 1 || n > nP) return NaN;
  // Lead first, then whatever else the operator has left available.
  const order = [];
  for (let k = 0; k < nP; k += 1) {
    const i = (ctx.staging.lead + k) % nP;
    if (ctx.staging.hand[i] !== HAND.OFF && plant.drv[i].state !== DRIVE.TRIPPED) order.push(i);
  }
  if (order.length < n) return NaN;
  const r = predictOperatingPoint(config, plant, order.slice(0, n), ctx.pid.sp, run.mode);
  return r.ok ? r.electrical_kW : NaN;
}

/**
 * One controller scan: read, compute, sequence, drive, alarm, diagnose, score, teach.
 * @param {object} ctx the sim context
 * @param {number} scan_s the scan period, s
 * @returns {void}
 */
function controllerScan(ctx, scan_s) {
  const {
    config, plant, pid, pidCfg, strat, stratCfg, staging, stagingCfg, autotune, stepTest, sweep, run,
  } = ctx;
  run.diag.scans += 1;

  const prevPv = pid.pvRaw;
  const pv = measuredPV(plant, run.mode);

  // --- setpoint reset -------------------------------------------------------------------------
  // A schedule that lowers the demanded pressure as the flow falls. It is applied to the TARGET,
  // not to the controller's working setpoint, so the operator's own setpoint ramp still governs
  // how fast the change is allowed to arrive.
  if (stratCfg.reset.enabled && run.mode === LOOP.PRESSURE) {
    pid.spTarget = resetSetpoint(stratCfg, plant.ft_m3h);
  }

  // --- gain scheduling ------------------------------------------------------------------------
  if (stratCfg.sched.enabled) {
    const x = schedulingVariable(stratCfg, plant, pid);
    const t = scheduledTuning(stratCfg, x);
    pidCfg.Kc = t.Kc;
    pidCfg.Ti = t.Ti;
    pidCfg.Td = t.Td;
  }

  // --- experiments that borrow the output ------------------------------------------------------
  // Each of these runs the controller in MAN and writes coMan, so leaving the experiment is
  // bumpless by construction and there is only one path from a number to the plant.
  if (autotune.phase === TUNE.SETTLING || autotune.phase === TUNE.CYCLING) {
    pid.coMan = stepAutotune(autotune, pv, run.t_s, pidCfg.action === ACTION.REVERSE);
    if (autotune.phase === TUNE.DONE || autotune.phase === TUNE.FAILED) {
      setMode(pid, autotune._prevMode || MODE.AUTO);
      run.lastNote = autotune.message;
      pushEvent(ctx, 'tune', autotune.message);
      ctx.bus.emit('autotune', autotune);
    }
  } else if (stepTest.phase === STEP.SETTLING || stepTest.phase === STEP.RECORDING) {
    const noise = run.mode === LOOP.FLOW ? config.instruments.ft.noise_m3h
      : config.instruments.pt.noise_bar;
    pid.coMan = stepStepTest(stepTest, pv, run.t_s, scan_s, noise);
    if (stepTest.phase === STEP.DONE || stepTest.phase === STEP.FAILED) {
      setMode(pid, stepTest._prevMode || MODE.AUTO);
      run.lastNote = stepTest.message;
      pushEvent(ctx, 'tune', stepTest.message);
      if (stepTest.model) {
        ctx.model = { ...stepTest.model };
        ctx.modelSource = 'open-loop step test';
        refreshAnalysis(ctx);
      }
      ctx.bus.emit('steptest', stepTest);
    }
  } else if (sweep.phase === SWEEP.SETTLING || sweep.phase === SWEEP.MEASURING) {
    pid.coMan = stepSweep(sweep, pv, run.t_s, scan_s);
    if (sweep.phase === SWEEP.DONE || sweep.phase === SWEEP.FAILED) {
      setMode(pid, sweep._prevMode || MODE.AUTO);
      run.lastNote = sweep.message;
      pushEvent(ctx, 'tune', sweep.message);
      const fit = fitFromSweep(sweep.points);
      if (fit.ok) {
        ctx.model = { K: fit.K, tau: fit.tau, theta: fit.theta };
        ctx.modelSource = `measured sweep (${sweep.points.length} frequencies, `
          + `${(fit.rms * 100).toFixed(0)}% fit residual)`;
        refreshAnalysis(ctx);
      }
      ctx.bus.emit('sweep', sweep);
    }
  }

  // --- the primary controller ------------------------------------------------------------------
  let co = stepPid(pidCfg, pid, pv, scan_s);

  // --- feedforward -------------------------------------------------------------------------------
  // The model's answer is "what output holds setpoint at this valve position", computed on the
  // plant itself. Everything about how it is applied — gain, lead, lag — is in `strategy.js`.
  let ffRaw = 0;
  if (stratCfg.ff.enabled && plant.finalElement === FINAL.VFD) {
    const sol = outputForSetpoint(config, plant, pid.sp, run.mode);
    // Only the CHANGE matters: the steady part is the feedback loop's job, and adding the whole
    // model output would simply double the bias.
    ffRaw = sol.achievable ? sol.co_pct - pid.co : 0;
  }
  run.ff_pct = feedforward(stratCfg, strat, ffRaw, scan_s);
  co = clamp(co + run.ff_pct, pidCfg.outLo, pidCfg.outHi);

  // --- cascade -------------------------------------------------------------------------------
  if (stratCfg.structure === STRUCTURE.CASCADE && pid.mode !== MODE.MAN) {
    const inner = stepCascade(stratCfg, strat, co, plant.ft_m3h, scan_s);
    run.slaveSp_m3h = inner.sp_m3h;
    // If the slave cannot reach the setpoint it is being given, the master must stop asking for
    // more. Tracking the master back to what the slave actually achieved is the standard cure.
    if (inner.slaveSaturated) preload(pid, masterTracking(stratCfg, plant.ft_m3h));
    co = inner.co_pct;
  } else {
    run.slaveSp_m3h = 0;
  }

  // --- constraint overrides ---------------------------------------------------------------------
  const sel = selectOverrides(stratCfg, strat, plant, co, scan_s);
  co = sel.co_pct;
  run.selected = sel.selected;
  if (sel.changed) {
    const msg = sel.selected === 'PRIMARY'
      ? `${LOOP_EU[run.mode].tag} back in control`
      : `${sel.selected} override has taken the output`;
    run.lastNote = msg;
    pushEvent(ctx, 'override', msg);
  }
  // The primary must not wind up while a constraint holds the output down.
  if (sel.selected !== 'PRIMARY' && pid.mode === MODE.AUTO) preload(pid, co);

  // --- sequence ------------------------------------------------------------------------------
  // The sequence stages on the output that is ACTUALLY going out, and applies its bias to
  // whichever controller owns that output — the primary in a single loop, the slave in a cascade.
  // Getting the second part wrong is subtle and nasty: the bias lands on a controller that is not
  // driving anything, and the loop simply ignores it.
  const owner = (stratCfg.structure === STRUCTURE.CASCADE && pid.mode !== MODE.MAN)
    ? { cfg: strat.slave.cfg, st: strat.slave.st }
    : { cfg: pidCfg, st: pid };
  const before = plant.drv.map((d) => d.state);
  const action = stepStaging(stagingCfg, staging, {
    drives: config.drives,
    drv: plant.drv,
    pidCfg: owner.cfg,
    pid: owner.st,
    co,
    t_s: run.t_s,
    // FT-101 measures what goes to process, not what the impellers pass, and the difference is
    // the recirculation. A sequence that stages on total pump flow will never let a set sleep,
    // because the minimum-flow valve keeps the number up all night.
    flow_m3h: plant.ft_m3h,
    pv,
    sp: pid.sp,
    predictPower: stagingCfg.criterion === CRITERION.ENERGY
      ? (n) => cachedPredict(ctx, n) : undefined,
  }, scan_s);
  co = staging.distributed_pct;
  run.co_pct = co;

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
    pushEvent(ctx, 'sequence', action);
    ctx.bus.emit('sequence', action);
  }

  // --- write the final element -------------------------------------------------------------------
  writeFinalElement(ctx, co);

  // --- alarms ----------------------------------------------------------------------------------
  const res = evaluateAlarms(config, plant, { sp: pid.sp, pv, mode: run.mode },
    ctx.alarms, run.t_s, scan_s);
  run.alarmList = res.list;
  run.worst = res.worst;
  for (const a of res.newly) {
    pushEvent(ctx, 'alarm', `${a.sev} ${a.tag} — ${a.message}`);
    ctx.bus.emit('alarm', a);
  }

  // --- loop diagnostics -----------------------------------------------------------------------
  pushSample(ctx.diag, pid.sp - pv, co, pv);
  run.diagAccum_s += scan_s;
  if (run.diagAccum_s >= DIAG_PERIOD_S) {
    run.diagAccum_s = 0;
    const eu = LOOP_EU[run.mode];
    analyse(ctx.diag, {
      deadTime_s: ctx.model ? ctx.model.theta : config.instruments.pt.deadTime_s + config.scan_s,
      span: eu.hi - eu.lo,
      satFraction: ctx.scenario.m.t_s > 0 ? ctx.scenario.m.satTime_s / ctx.scenario.m.t_s : 0,
      resetTime_s: pidCfg.Ti,
    });
  }

  // --- energy accounting ------------------------------------------------------------------------
  const e = run.energy;
  const elec = electricalPower_kW(plant);
  e.elapsed_s += scan_s;
  e.kWh += (elec * scan_s) / 3600;
  e.usefulKWh += (usefulPower_kW(plant, config) * scan_s) / 3600;
  e.m3 += (plant.Qdemand_m3h * scan_s) / 3600;
  e.cost = e.kWh * config.energy.tariff_perkWh;
  // Energy destroyed across the throttle valve: the head it takes out, times the flow through
  // it. On a throttled system this is the number the whole variable-speed argument turns on.
  e.throttleKWh += (hydraulicPower_kW(plant.Qdemand_m3h, throttleLoss_m(config, plant),
    plant.fluid.rho_kgm3) * scan_s) / 3600;

  // --- scorecard and scripted test --------------------------------------------------------------
  const fired = stepScenario(config, ctx.scenario, {
    t_s: run.t_s,
    dt_s: scan_s,
    sp: pid.sp,
    pv: truePV(plant, run.mode),
    co,
    saturated: pid.saturated,
    mode: run.mode,
    plant,
    pid,
    api: scriptApi(ctx),
  });
  for (const label of fired) {
    run.lastNote = `test step — ${label}`;
    pushEvent(ctx, 'scenario', label);
    ctx.bus.emit('scenario', label);
  }
  if (ctx.scenario.done) {
    ctx.scenario.done = false;
    if (ctx.scenario.last) {
      saveRun(ctx.runs, ctx.scenario.last, ctx);
      pushEvent(ctx, 'scenario', `${ctx.scenario.last.scenario} scored `
        + `${ctx.scenario.last.score.toFixed(0)}/100 — filed as run ${ctx.runs.nextId - 1}`);
      ctx.bus.emit('scored', ctx.scenario.last);
    }
  }

  // --- lesson ------------------------------------------------------------------------------------
  if (ctx.lessons.def) {
    const met = stepLesson(ctx.lessons, lessonContext(ctx, pv, prevPv), scan_s);
    for (const m of met) {
      run.lastNote = m;
      pushEvent(ctx, 'lesson', m);
      ctx.bus.emit('lesson', m);
    }
  }
}

/** Cache for the staging energy prediction, which is far too expensive to do every scan. */
const energyCache = new WeakMap();

/**
 * Predicted power with `n` machines, recomputed at most every {@link ENERGY_PREDICT_PERIOD_S}.
 * @param {object} ctx the sim context
 * @param {number} n how many machines
 * @returns {number} predicted electrical kW, or NaN
 */
function cachedPredict(ctx, n) {
  let c = energyCache.get(ctx);
  if (!c) { c = { at_s: -1e9, values: new Map() }; energyCache.set(ctx, c); }
  if (ctx.run.t_s - c.at_s >= ENERGY_PREDICT_PERIOD_S) {
    c.at_s = ctx.run.t_s;
    c.values.clear();
  }
  if (!c.values.has(n)) c.values.set(n, predictPowerWith(ctx, n));
  return c.values.get(n);
}

/**
 * Send the selected output to whichever element the rig is controlling with.
 *
 * The convention is the one a real plant uses and it is deliberately not smoothed over: 0-100%
 * of output is 0-100% of the element, and PCV-101 is air-to-open, so 100% output is a valve wide
 * open. Nothing is inverted in the wiring.
 *
 * What that costs is that the CONTROLLER ACTION is no longer the same for every combination, and
 * {@link requiredAction} works out which one the physics demands. Opening the throttle valve
 * raises the flow through it and lowers the header behind it, so the same valve is reverse-acting
 * for FIC-101 and direct-acting for PIC-101. Getting that backwards produces a loop that runs
 * away from setpoint at full speed, which is a lesson worth having somewhere other than a plant.
 *
 * @param {object} ctx the sim context
 * @param {number} co the selected output, percent
 * @returns {void}
 */
function writeFinalElement(ctx, co) {
  const { plant } = ctx;
  if (plant.finalElement === FINAL.THROTTLE) {
    plant.pcv.cmd = clamp(co / 100, 0, 1);
    for (let i = 0; i < plant.drv.length; i += 1) {
      // `fixedSpeed_pct` is a shaft speed; `cmd_pct` is a drive reference over the drive's own
      // minimum-to-maximum span. They are not the same number, and conflating them silently runs
      // the machines faster than the panel says.
      if (isCalled(plant.drv[i])) {
        plant.drv[i].cmd_pct = speedToReference(ctx.config.drives[i], plant.fixedSpeed_pct);
      }
    }
  } else {
    plant.pcv.cmd = 1;
  }
}

/**
 * The controller action the present combination of controlled variable and final element
 * physically requires.
 *
 * @param {string} loopMode one of {@link LOOP}
 * @param {string} element one of {@link FINAL}
 * @returns {string} one of {@link ACTION}
 */
export function requiredAction(loopMode, element) {
  // A drive raises everything it can affect: more speed is more head and more flow.
  if (element !== FINAL.THROTTLE) return ACTION.REVERSE;
  // Opening a valve downstream of the header lets more through and lets the header down.
  return loopMode === LOOP.PRESSURE ? ACTION.DIRECT : ACTION.REVERSE;
}

/**
 * Put the controller action where the physics needs it, and say so if it moved.
 * @param {object} ctx the sim context
 * @returns {boolean} whether the action had to change
 */
function alignAction(ctx) {
  const want = requiredAction(ctx.run.mode, ctx.plant.finalElement);
  if (ctx.pidCfg.action === want) return false;
  ctx.pidCfg.action = want;
  note(ctx, `${LOOP_EU[ctx.run.mode].tag} set to ${want}-acting — on `
    + `${ctx.plant.finalElement === FINAL.THROTTLE ? 'PCV-101' : 'the drives'}, more output means `
    + `${want === ACTION.REVERSE ? 'more' : 'less'} ${ctx.run.mode === LOOP.PRESSURE ? 'header pressure' : 'flow'}.`);
  return true;
}

/**
 * Recompute the margins and the predicted step response for the current tuning and model.
 * @param {object} ctx the sim context
 * @returns {void}
 */
export function refreshAnalysis(ctx) {
  if (!ctx.model) { ctx.margins = null; ctx.prediction = null; return; }
  const r = loopResponse(ctx.pidCfg, ctx.model, DEFAULT_GRID, ctx.config.scan_s);
  ctx.margins = margins(r);
  ctx.margins._response = r;
  ctx.prediction = predictStep(ctx.pidCfg, ctx.model, {
    spStep: 1,
    horizon: Math.max(120, 40 * ctx.model.tau),
    scan_s: ctx.config.scan_s,
  });
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
      pushEvent(ctx, 'trip', `${ev.tag}: ${ev.message}`);
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
  const e = run.energy;
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
  r[17] = electricalPower_kW(plant);
  r[18] = plant.fcv.x * 100;
  r[19] = plant.pcv.x * 100;
  r[20] = run.ff_pct;
  r[21] = plant.T_tank_C;
  r[22] = plant.vib_mms[0];
  r[23] = plant.vib_mms[1];
  r[24] = plant.eta[0] * 100;
  r[25] = plant.eta[1] * 100;
  r[26] = e.m3 > 0.01 ? e.kWh / e.m3 : 0;
  r[27] = run.slaveSp_m3h;
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
  pushEvent(ctx, 'operator', line);
  ctx.bus.emit('action', line);
  return ok();
}

/**
 * True while something other than the operator owns the output.
 * @param {object} ctx the sim context
 * @returns {string|null} the name of the owner, or null
 */
export function outputOwner(ctx) {
  if (ctx.autotune.phase === TUNE.SETTLING || ctx.autotune.phase === TUNE.CYCLING) {
    return 'the relay autotuner';
  }
  if (ctx.stepTest.phase === STEP.SETTLING || ctx.stepTest.phase === STEP.RECORDING) {
    return 'the step test';
  }
  if (ctx.sweep.phase === SWEEP.SETTLING || ctx.sweep.phase === SWEEP.MEASURING) {
    return 'the frequency sweep';
  }
  return null;
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
  const owner = outputOwner(ctx);
  if (owner) return fail(`${owner} is running — abort it first`);
  ctx.run.mode = mode;
  const eu = LOOP_EU[mode];
  // Gains carry units, so a gain tuned in bar is meaningless in m3/h. Rather than silently
  // rescaling somebody's tuning, the controller is put back to a conservative default for the new
  // variable and the operator is told.
  Object.assign(ctx.pidCfg, DEFAULT_TUNING[mode]);
  ctx.pid.spTarget = DEFAULT_SP[mode];
  ctx.pid.sp = DEFAULT_SP[mode];
  ctx.pid.primed = false;
  preload(ctx.pid, ctx.pid.co);
  ctx.model = null;
  ctx.modelSource = null;
  alignAction(ctx);
  refreshAnalysis(ctx);
  resetDiagnostics(ctx.diag);
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
  if (ctx.stratCfg.reset.enabled && ctx.run.mode === LOOP.PRESSURE) {
    return fail('the setpoint reset schedule is writing the setpoint — turn it off first');
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
  const owner = outputOwner(ctx);
  if (owner) return fail(`${owner} owns the output — abort it first`);
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
  if (outputOwner(ctx)) return fail(`${outputOwner(ctx)} owns the output`);
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
  if (next.form === FORM.SERIES && next.Td > 0 && next.Ti < 4 * next.Td) {
    return fail(`a series controller cannot express Ti ${next.Ti.toPrecision(3)} s with Td `
      + `${next.Td.toPrecision(3)} s — the series form needs Ti of at least 4*Td `
      + `(${(4 * next.Td).toPrecision(3)} s here).`);
  }
  if (next.pvFilter_s < 0) return fail('the measurement filter cannot be negative');
  Object.assign(c, patch);
  refreshAnalysis(ctx);
  return ok();
}

/**
 * Change the form the tuning numbers are READ in, converting them so the controller behaves
 * identically. The algorithm is always the ISA standard form; this only changes the arithmetic
 * between what is displayed and what is used.
 * @param {object} ctx the sim context
 * @param {string} form one of {@link FORM}
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setTuningForm(ctx, form) {
  if (!FORM[form]) return fail(`unknown controller form ${form}`);
  if (ctx.pidCfg.form === form) return ok();
  const shown = convertForm(ctx.pidCfg, form);
  if (!shown.ok) return fail(shown.note);
  ctx.pidCfg.form = form;
  const parts = shown.labels.map((l, i) => `${l} ${shown.values[i].toPrecision(4)} ${shown.units[i]}`);
  return note(ctx, `tuning shown in ${form} form — ${parts.join(', ')}`);
}

/**
 * @param {object} ctx the sim context
 * @param {string} algo one of {@link ALGO}
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setAlgorithm(ctx, algo) {
  if (!ALGO[algo]) return fail(`unknown algorithm ${algo}`);
  ctx.pidCfg.algorithm = algo;
  return note(ctx, `${algo === ALGO.VELOCITY ? 'velocity' : 'positional'} algorithm`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} s scan period, s
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setScan(ctx, s) {
  if (!(s >= ctx.config.dt_s && s <= 5)) return fail(`scan must be between ${ctx.config.dt_s} and 5 s`);
  // The config is frozen by design, and `scan_s` is the single accessor property in it precisely
  // so this assignment works — see `data/config.js::buildConfig`.
  ctx.config.scan_s = s;
  ctx.diag.period_s = s;
  resetDiagnostics(ctx.diag);
  refreshAnalysis(ctx);
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
  ctx.staging.starts[i] += 1;
  return note(ctx, `${ctx.config.pumps[i].tag} to HAND`);
}

/**
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @param {string} [stopMode] one of {@link STOP_MODE}
 * @returns {{ok:boolean, reason?:string}} result
 */
export function stopPump(ctx, i, stopMode) {
  ctx.staging.hand[i] = HAND.OFF;
  stopDrive(ctx.plant.drv[i], stopMode || STOP_MODE.RAMP);
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
  const d = ctx.plant.drv[i];
  const tag = ctx.config.pumps[i].tag;
  if (d.state !== DRIVE.TRIPPED) return fail(`${tag} is not tripped`);
  // A thermal overload relay physically will not reset until its bimetal has cooled, and neither
  // will this one. Saying so with the number is the difference between a simulator that seems
  // broken and one that is teaching you what the relay is doing.
  if (!resetDrive(d)) {
    return fail(`the overload on ${tag} is still at ${d.thermal_pct.toFixed(0)}% and will not `
      + 'reset until it has cooled below 60%. Wait, or raise the time compression.');
  }
  return note(ctx, `${tag} overload reset`);
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
  tripDrive(d, 'simulated fault injected by the operator');
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
  if (!(next.stageUpFlow_m3h > next.stageDownFlow_m3h)) {
    return fail('the stage-up flow must be above the stage-down flow');
  }
  if (!(next.stageUpDelay_s >= 0 && next.stageDownDelay_s >= 0)) return fail('delays cannot be negative');
  if (!(next.minRun_s >= 0 && next.minStop_s >= 0)) return fail('timers cannot be negative');
  if (!(next.energyMargin >= 0 && next.energyMargin < 0.5)) {
    return fail('the energy margin must be between 0 and 0.5');
  }
  if (!(next.wakeDroop > 0.005 && next.wakeDroop < 0.5)) {
    return fail('the wake droop must be between 0.5% and 50% of setpoint');
  }
  Object.assign(ctx.stagingCfg, patch);
  return ok();
}

/**
 * Patch the control strategy: structure, feedforward, scheduling, reset and overrides.
 * @param {object} ctx the sim context
 * @param {object} patch a partial strategy config, merged one level deep
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setStrategy(ctx, patch) {
  const c = ctx.stratCfg;
  if (patch.structure && !STRUCTURE[patch.structure]) {
    return fail(`unknown structure ${patch.structure}`);
  }
  if (patch.structure && patch.structure !== c.structure) {
    if (patch.structure === STRUCTURE.CASCADE && ctx.run.mode === LOOP.FLOW) {
      return fail('the loop is already controlling flow — a flow-on-flow cascade has no inner '
        + 'variable to work on. Switch to pressure control first.');
    }
    // Transferring has to be bumpless in BOTH directions, and the two directions are different
    // problems. Closing the cascade: the slave takes over from the output that is already going
    // out, and the master is preloaded to the setpoint corresponding to the flow the plant is
    // already passing. Opening it: the master's output has been a slave SETPOINT all this time,
    // in percent of the slave's flow range — a completely different quantity from a drive
    // reference — so it has to be preloaded to what the slave was actually putting out, or the
    // machines take a step the size of the difference between the two scales.
    if (patch.structure === STRUCTURE.CASCADE) {
      resetPid(ctx.strat.slave.st, ctx.plant.ft_m3h, ctx.run.co_pct);
      preload(ctx.pid, masterTracking(c, ctx.plant.ft_m3h));
    } else if (c.structure === STRUCTURE.CASCADE) {
      preload(ctx.pid, clamp(ctx.strat.slave.st.co, ctx.pidCfg.outLo, ctx.pidCfg.outHi));
    }
    c.structure = patch.structure;
    note(ctx, `structure: ${patch.structure}`);
  }
  for (const key of ['cascade', 'ff', 'sched', 'reset', 'override']) {
    if (patch[key]) mergeInto(c[key], patch[key]);
  }
  if (c.ff.gain < 0 || c.ff.gain > 1.5) return fail('feedforward gain must be between 0 and 1.5');
  if (c.reset.spMin_bar > c.reset.spMax_bar) {
    return fail('the reset schedule minimum is above its maximum');
  }
  return ok();
}

/**
 * Merge a patch one level deeper than Object.assign, so `{override:{current:{enabled:true}}}`
 * does not blow away the limit that sits beside it.
 * @param {object} target the object to write into
 * @param {object} patch the values
 * @returns {void}
 */
function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      mergeInto(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

/**
 * The disturbance surface: everything the operator can do TO the plant rather than to the loop.
 * @param {object} ctx the sim context
 * @param {object} patch any of the plant's operator-writable fields
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setDisturbance(ctx, patch) {
  const p = ctx.plant;
  const c = ctx.config;
  if (patch.demandTarget !== undefined) p.demandTarget = clamp(patch.demandTarget, 0, 1);
  if (patch.hDischarge_m !== undefined) p.hDischarge_m = clamp(patch.hDischarge_m, 0, 60);
  if (patch.foul !== undefined) p.foul = clamp(patch.foul, 0, 0.95);
  if (patch.bypass !== undefined) p.bypass = clamp(patch.bypass, 0, 1);
  if (patch.makeupAuto !== undefined) p.makeupAuto = !!patch.makeupAuto;
  if (patch.Tsupply_C !== undefined) p.Tsupply_C = clamp(patch.Tsupply_C, 2, 98);
  if (patch.T_tank_C !== undefined) p.T_tank_C = clamp(patch.T_tank_C, 2, 98);
  if (patch.pAtm_bar !== undefined) p.pAtm_bar = clamp(patch.pAtm_bar, 0.5, 1.1);
  if (patch.fixedSpeed_pct !== undefined) p.fixedSpeed_pct = clamp(patch.fixedSpeed_pct, 0, 100);
  if (patch.fluidId !== undefined) {
    if (!FLUID_BY_ID[patch.fluidId]) return fail(`unknown fluid ${patch.fluidId}`);
    p.fluidId = patch.fluidId;
  }
  if (patch.recircMode !== undefined) {
    if (!RECIRC[patch.recircMode]) return fail(`unknown recirculation mode ${patch.recircMode}`);
    p.recircMode = patch.recircMode;
  }
  if (patch.finalElement !== undefined) {
    if (!FINAL[patch.finalElement]) return fail(`unknown final element ${patch.finalElement}`);
    if (patch.finalElement !== p.finalElement) {
      if (patch.finalElement === FINAL.THROTTLE && ctx.run.mode === LOOP.PRESSURE) {
        // A throttle valve can only hold a pressure the pump is already making more than. If the
        // setpoint is below what the wide-open valve gives at the present fixed speed, no
        // controller can reach it — so the fixed speed is moved to make it reachable, and the
        // operator is told exactly what happened and why.
        const band = throttleRange(c, p);
        if (band.ok && ctx.pid.spTarget <= band.lo_bar + 0.05) {
          const n = speedForThrottleSetpoint(c, p, ctx.pid.spTarget);
          if (!Number.isFinite(n)) {
            return fail('nothing is running, so there is no throttle band to control in');
          }
          p.fixedSpeed_pct = n;
          const after = throttleRange(c, p);
          note(ctx, `fixed speed set to ${n.toFixed(0)}% — PCV-101 can only hold a pressure the `
            + `pumps already exceed, and at ${band.lo_bar.toFixed(2)} bar wide open it could not `
            + `reach ${ctx.pid.spTarget.toFixed(2)} bar. The band is now `
            + `${after.lo_bar.toFixed(2)}..${after.hi_bar.toFixed(2)} bar.`);
        }
      }
      // The output means a different thing on the other element, so the controller is preloaded
      // to whatever the new element is already at. Without this the loop takes a step it did not
      // ask for at the moment of the switch.
      p.finalElement = patch.finalElement;
      alignAction(ctx);
      const equiv = patch.finalElement === FINAL.THROTTLE
        ? p.pcv.x * 100
        : speedToReference(c.drives[0], p.drv[0].n_pct);
      preload(ctx.pid, clamp(equiv, ctx.pidCfg.outLo, ctx.pidCfg.outHi));
    }
  }
  if (patch.level_m !== undefined) {
    p.level_m = clamp(patch.level_m, 0, c.tank.height_m);
    p.V_m3 = p.level_m * c.tank.area_m2;
  }
  if (patch.trim !== undefined) {
    for (let i = 0; i < p.trim.length && i < patch.trim.length; i += 1) {
      p.trim[i] = clamp(patch.trim[i], 0.7, 1.0);
    }
  }
  if (patch.wear !== undefined) {
    for (let i = 0; i < p.wear.length && i < patch.wear.length; i += 1) {
      p.wear[i] = clamp(patch.wear[i], 0, 1);
    }
  }
  if (patch.valveOverride !== undefined) {
    for (const which of ['fcv', 'pcv']) {
      const o = patch.valveOverride[which];
      if (!o) continue;
      if (o.stickband !== undefined) p.valveOverride[which].stickband = clamp(o.stickband, 0, 0.3);
      if (o.slipJump !== undefined) p.valveOverride[which].slipJump = clamp(o.slipJump, 0, 0.3);
      if (o.strokeTime_s !== undefined) {
        p.valveOverride[which].strokeTime_s = o.strokeTime_s == null
          ? null : clamp(o.strokeTime_s, 0.2, 120);
      }
    }
  }
  return ok();
}

/**
 * Set the process model by hand, or restore one from a session file.
 * @param {object} ctx the sim context
 * @param {{K:number, tau:number, theta:number}} model the model
 * @returns {{ok:boolean, reason?:string}} result
 */
export function setModel(ctx, model) {
  if (!model || !Number.isFinite(model.K) || model.K === 0) return fail('the model gain must be non-zero');
  if (!(model.tau > 0)) return fail('the time constant must be greater than zero');
  if (!(model.theta >= 0)) return fail('the dead time cannot be negative');
  ctx.model = { K: model.K, tau: model.tau, theta: model.theta };
  ctx.modelSource = ctx.modelSource || 'entered by hand';
  refreshAnalysis(ctx);
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
  const owner = outputOwner(ctx);
  if (owner) return fail(`${owner} is already running`);
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
 * Begin an open-loop step test.
 * @param {object} ctx the sim context
 * @param {object} [opts] `du`, the step size in output percent
 * @returns {{ok:boolean, reason?:string}} result
 */
export function beginStepTest(ctx, opts) {
  const { pid, pidCfg, stepTest, run } = ctx;
  const owner = outputOwner(ctx);
  if (owner) return fail(`${owner} is already running`);
  const du = (opts && opts.du) || 10;
  const res = startStepTest(stepTest, {
    co: pid.co, du, t_s: run.t_s, outLo: pidCfg.outLo, outHi: pidCfg.outHi,
  });
  if (!res.ok) return res;
  stepTest._prevMode = pid.mode;
  setMode(pid, MODE.MAN);
  pid.coMan = pid.co;
  return note(ctx, `step test armed — holding ${pid.co.toFixed(1)}% until the process is at rest, `
    + `then stepping ${du > 0 ? '+' : ''}${du}%`);
}

/**
 * @param {object} ctx the sim context
 * @returns {{ok:boolean, reason?:string}} result
 */
export function cancelStepTest(ctx) {
  const { stepTest, pid } = ctx;
  if (stepTest.phase !== STEP.SETTLING && stepTest.phase !== STEP.RECORDING) {
    return fail('no step test is running');
  }
  abortStepTest(stepTest);
  setMode(pid, stepTest._prevMode || MODE.AUTO);
  return note(ctx, 'step test aborted');
}

/**
 * Begin a measured frequency sweep.
 * @param {object} ctx the sim context
 * @param {object} [opts] `amp`, `wLo`, `wHi`, `n`
 * @returns {{ok:boolean, reason?:string}} result
 */
export function beginSweep(ctx, opts = {}) {
  const { pid, pidCfg, sweep, run } = ctx;
  const owner = outputOwner(ctx);
  if (owner) return fail(`${owner} is already running`);
  const res = startSweep(sweep, {
    bias: pid.co,
    amp: opts.amp || 5,
    t_s: run.t_s,
    wLo: opts.wLo,
    wHi: opts.wHi,
    n: opts.n,
    outLo: pidCfg.outLo,
    outHi: pidCfg.outHi,
  });
  if (!res.ok) return res;
  sweep._prevMode = pid.mode;
  setMode(pid, MODE.MAN);
  pid.coMan = pid.co;
  return note(ctx, `${sweep.message} — raise the time compression, this one is slow`);
}

/**
 * @param {object} ctx the sim context
 * @returns {{ok:boolean, reason?:string}} result
 */
export function cancelSweep(ctx) {
  const { sweep, pid } = ctx;
  if (sweep.phase !== SWEEP.SETTLING && sweep.phase !== SWEEP.MEASURING) {
    return fail('no sweep is running');
  }
  abortSweep(sweep);
  setMode(pid, sweep._prevMode || MODE.AUTO);
  return note(ctx, 'sweep aborted');
}

/**
 * Every tuning candidate available right now, ranked by what each would actually do.
 *
 * The classical rules need only Ku and Tu, so they appear as soon as a relay test has finished.
 * The model-based ones need a model, and the ranking — which simulates each candidate — needs one
 * too, so without a model the list comes back unranked and says so.
 *
 * @param {object} ctx the sim context
 * @returns {{rules:object[], ranked:boolean}} the candidates
 */
export function tuningCandidates(ctx) {
  const rules = [];
  if (ctx.autotune.phase === TUNE.DONE) {
    rules.push(...tuningRules(ctx.autotune.Ku, ctx.autotune.Tu));
  }
  if (ctx.model) rules.push(...modelRules(ctx.model));
  if (!rules.length) return { rules: [], ranked: false };
  if (!ctx.model) return { rules, ranked: false };
  return {
    rules: rankTunings(rules, ctx.model, {
      loopResponse, margins, predictStep, grid: DEFAULT_GRID,
    }, ctx.pidCfg, ctx.config.scan_s),
    ranked: true,
  };
}

/**
 * Apply one of the candidate tunings.
 * @param {object} ctx the sim context
 * @param {string} ruleId the candidate's id
 * @returns {{ok:boolean, reason?:string}} result
 */
export function applyTuningRule(ctx, ruleId) {
  const { rules } = tuningCandidates(ctx);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return fail(`no candidate named ${ruleId} is available — run a test first`);
  const res = setTuning(ctx, { Kc: rule.Kc, Ti: rule.Ti, Td: rule.Td });
  if (!res.ok) return res;
  ctx.appliedRuleId = ruleId;
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
  const owner = outputOwner(ctx);
  if (owner) return fail(`${owner} is running — abort it first`);
  // A scenario may need the rig arranged before the clock starts — a different controlled
  // variable, a different final element. That goes through the actions, so it is validated
  // exactly as if the operator had done it by hand.
  if (def.setup) def.setup(ctx, scriptApi(ctx));
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
  const r = scoreNow(ctx.config, ctx.scenario, {
    mode: ctx.run.mode, plant: ctx.plant, pid: ctx.pid,
  });
  saveRun(ctx.runs, r, ctx, `free run #${ctx.runs.nextId}`);
  return note(ctx, `scored the last ${Math.round(ctx.scenario.m.t_s)} s — ${r.score.toFixed(0)}/100`);
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
 * Begin a guided lesson.
 * @param {object} ctx the sim context
 * @param {string} id one of the {@link LESSONS} ids
 * @returns {{ok:boolean, reason?:string}} result
 */
export function beginLesson(ctx, id) {
  const def = LESSONS.find((l) => l.id === id);
  if (!def) return fail(`unknown lesson ${id}`);
  const owner = outputOwner(ctx);
  if (owner) return fail(`${owner} is running — abort it first`);
  if (ctx.scenario.def) return fail('a scripted test is running — abort it first');
  // Put the rig back to a known state first, so a lesson never inherits the last one's damage.
  const lctx = lessonContext(ctx, measuredPV(ctx.plant, ctx.run.mode), 0);
  restoreDefaults(lctx, {
    pid: { ...DEFAULT_TUNING[ctx.run.mode] },
    staging: createStagingConfig(),
  });
  alignAction(ctx);
  startLesson(ctx.lessons, def, lctx, scriptApi(ctx));
  resetDiagnostics(ctx.diag);
  resetScore(ctx.scenario);
  return note(ctx, `lesson: ${def.title}`);
}

/**
 * Leave the running lesson and put the rig back to its defaults.
 * @param {object} ctx the sim context
 * @returns {{ok:boolean, reason?:string}} result
 */
export function endLesson(ctx) {
  if (!ctx.lessons.def) return fail('no lesson is running');
  const title = ctx.lessons.def.title;
  abortLesson(ctx.lessons);
  restoreDefaults(lessonContext(ctx, measuredPV(ctx.plant, ctx.run.mode), 0), {
    pid: { ...DEFAULT_TUNING[ctx.run.mode] },
    staging: createStagingConfig(),
  });
  alignAction(ctx);
  refreshAnalysis(ctx);
  return note(ctx, `left "${title}" — rig restored to its defaults`);
}

/**
 * @param {object} ctx the sim context
 * @returns {{met:number, total:number, fraction:number}} the running lesson's progress
 */
export function lessonStatus(ctx) {
  return lessonProgress(ctx.lessons);
}

/**
 * @param {object} ctx the sim context
 * @param {string} [id] a single alarm to acknowledge, or all of them
 * @returns {{ok:true}} result
 */
export function ackAlarms(ctx, id) {
  if (id) {
    const done = acknowledge(ctx.alarms, id);
    return note(ctx, done ? `${id} acknowledged` : `${id} is not in alarm`);
  }
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

/**
 * Reset the cumulative energy meter.
 * @param {object} ctx the sim context
 * @returns {{ok:true}} result
 */
export function resetEnergy(ctx) {
  ctx.run.energy = { elapsed_s: 0, kWh: 0, m3: 0, usefulKWh: 0, throttleKWh: 0, cost: 0 };
  return note(ctx, 'energy meter reset');
}

/**
 * A compact live summary for the panels, computed once rather than in six places.
 * @param {object} ctx the sim context
 * @returns {object} the summary
 */
export function summary(ctx) {
  const { plant, run, config } = ctx;
  const elec = electricalPower_kW(plant);
  const useful = usefulPower_kW(plant, config);
  const e = run.energy;
  return {
    running: runningCount(plant),
    electrical_kW: elec,
    useful_kW: useful,
    wireToWater: elec > 0.01 ? useful / elec : 0,
    specific_kWh_m3: e.m3 > 0.01 ? e.kWh / e.m3 : NaN,
    cost: e.cost,
    kWh: e.kWh,
    m3: e.m3,
    throttleLoss_m: throttleLoss_m(config, plant),
    startsPerHour: startsPerHour(ctx.staging, Math.max(run.t_s / 3600, 1e-9)),
    minFlow: plant.drv.map((d, i) => minimumFlow(config, plant, i)),
    diag: ctx.diag.report,
    margins: ctx.margins,
    model: ctx.model,
    modelSource: ctx.modelSource,
    owner: outputOwner(ctx),
    selected: run.selected,
  };
}
