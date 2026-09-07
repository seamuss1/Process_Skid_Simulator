/**
 * src/control/staging.js — the sequence logic above the PID: which pump is lead, when the lag
 * joins it, when it leaves again, when the set is allowed to go to sleep, and how the duty gets
 * shared over a week.
 *
 * Layer L2: imports `core/util.js`, `control/pid.js` and `process/motor.js`. No DOM, no plant
 * physics — it reads drive states and the controller output, and it writes start/stop requests
 * and speed commands. Anything it needs to know about the process arrives in the context object.
 *
 * ------------------------------------------------------------------------------------------
 * WHY STAGING IS THE HARD PART
 *
 * A single VFD pump under PID is a well-behaved loop. Two of them are a HYBRID system: a
 * continuous controller wrapped in a discrete one, and the discrete one can destabilise a
 * continuous loop that was perfectly tuned on its own.
 *
 * The mechanism is specific and it is reproduced faithfully here. When the lag pump starts, its
 * check valve is shut — the header already stands above the head a pump at zero speed can make.
 * So the drive ramps, and for a second or two NOTHING happens: the loop is in dead time it did
 * not have a moment ago. Then the shutoff head crosses the header pressure, the check valve
 * cracks, and a second machine arrives on a header that was already satisfied. The PV overshoots,
 * the controller pulls the shared speed down, the combined flow collapses below the stage-down
 * threshold, the lag pump stops, and the whole thing repeats. That is short-cycling, it destroys
 * motors and starters, and the four defences against it are all here:
 *
 *   1. A STAGING BIAS. On stage-up the shared output is stepped down, because two pumps at speed
 *      n make far more flow than one. Without it the header takes the full surge. This is a
 *      preload on the controller's integral, not a fudge on its output, so the loop resumes from
 *      a consistent state instead of winding back up to where it was.
 *   2. ASYMMETRIC THRESHOLDS AND DELAYS. Stage up at a high output held for a while; stage down
 *      at a much lower one held for longer. The gap between them is the hysteresis band, and it
 *      has to be wider than the disturbance the stage itself causes.
 *   3. MINIMUM RUN AND STOP TIMES. The last line of defence. Whatever the loop does, a pump that
 *      has just started will not stop for `minRun_s`, and one that has just stopped will not
 *      start for `minStop_s`.
 *   4. RESET OF BOTH TIMERS ON ANY TRANSITION, so a stage can never trigger the opposite stage on
 *      the disturbance it caused itself.
 *
 * WHAT TO STAGE ON. The classic criterion is the controller output, and it is the one most sets
 * in the field use, because it needs no extra instrument. It is also the crudest: output percent
 * is a proxy for "how hard are we working", and the relationship between that and how many pumps
 * SHOULD be running depends on where the duty sits on the curve. Two better criteria are
 * offered — total flow, which is the honest measure of load, and predicted energy, which stages
 * wherever the electrical power actually crosses over. The energy criterion is what a modern
 * booster set does and it habitually runs more pumps at lower speed than an operator expects,
 * because friction loss goes with the square of velocity and splitting the flow between two
 * impellers beats running one hard.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { preload } from './pid.js';
import { DRIVE, STOP_MODE, start as startDrive, stop as stopDrive, isCalled } from '../process/motor.js';

/** How the operator has placed an individual pump. */
export const HAND = Object.freeze({
  /** The sequence owns it. */
  AUTO: 'AUTO',
  /** Forced to run, whatever the sequence wants. */
  HAND: 'HAND',
  /** Locked out. The sequence will not call it and will stage around it. */
  OFF: 'OFF',
});

/** How the shared controller output is distributed across the running machines. */
export const SHARE = Object.freeze({
  /** Every running pump takes the same speed. Correct for identical machines in parallel. */
  COMMON: 'COMMON',
  /** The lag runs at a fixed base speed and the lead modulates around it. */
  BASE_TRIM: 'BASE_TRIM',
});

/** Duty rotation policy. */
export const ROTATE = Object.freeze({
  /** Never swap. */
  OFF: 'OFF',
  /** Swap lead whenever the plant goes down to one pump. */
  ON_STAGE_DOWN: 'ON_STAGE_DOWN',
  /** Swap on a make-before-break changeover once the runtime gap exceeds the threshold. */
  RUNTIME: 'RUNTIME',
});

/** What the sequence decides on. */
export const CRITERION = Object.freeze({
  /** Controller output percent. Needs no instrument; the field default. */
  OUTPUT: 'OUTPUT',
  /** Total header flow. The honest measure of load, if a flow meter exists. */
  FLOW: 'FLOW',
  /** Predicted electrical power. Stages wherever the energy actually crosses over. */
  ENERGY: 'ENERGY',
});

/**
 * Default staging configuration. Mutable at run time — these are the numbers a commissioning
 * engineer argues about, so they belong on the panel, not in a frozen constant.
 * @param {object} [over] initial overrides
 * @returns {object} a fresh staging configuration
 */
export function createStagingConfig(over) {
  return {
    /** Whether the sequence may start and stop pumps at all. */
    enabled: true,
    /** What the sequence decides on, one of {@link CRITERION}. */
    criterion: CRITERION.OUTPUT,
    /** Controller output above which the stage-up timer runs, percent. */
    stageUp_pct: 88,
    /** Seconds the output must stay above `stageUp_pct` before the lag starts. */
    stageUpDelay_s: 8,
    /** Controller output below which the stage-down timer runs, percent. */
    stageDown_pct: 40,
    /** Seconds the output must stay below `stageDown_pct` before the lag stops. */
    stageDownDelay_s: 20,
    /** Total flow above which the lag joins, under {@link CRITERION.FLOW}, m3/h. */
    stageUpFlow_m3h: 108,
    /** Total flow below which the lag leaves, under {@link CRITERION.FLOW}, m3/h. */
    stageDownFlow_m3h: 74,
    /**
     * Under {@link CRITERION.ENERGY}, how much cheaper the alternative must be before the
     * sequence acts, as a fraction. Without a margin the set hunts across the crossover point.
     */
    energyMargin: 0.04,
    /** Output above which the sequence stages up whatever the criterion says, percent. */
    saturationOverride_pct: 97,
    /** Multiplier applied to the output the instant a pump joins. 1 disables the bias. */
    stageUpBias: 0.72,
    /** Multiplier applied to the output the instant a pump leaves. 1 disables the bias. */
    stageDownBias: 1.30,
    /** Minimum time a started pump must run before it may be stopped, s. */
    minRun_s: 45,
    /** Minimum time a stopped pump must rest before it may be restarted, s. */
    minStop_s: 30,
    /** Output distribution, one of {@link SHARE}. */
    share: SHARE.COMMON,
    /** Fixed speed of the lag pump under {@link SHARE.BASE_TRIM}, percent. */
    baseSpeed_pct: 75,
    /** Rotation policy, one of {@link ROTATE}. */
    rotate: ROTATE.RUNTIME,
    /** Runtime difference that triggers a {@link ROTATE.RUNTIME} changeover, hours. */
    rotateAfter_h: 4,
    /** Overlap during a make-before-break changeover, s. */
    overlap_s: 12,

    // --- sleep -------------------------------------------------------------------------------
    /**
     * Whether the set may stop the last pump when there is no demand.
     *
     * A booster set on a satisfied header at three in the morning is running a pump against a
     * closed system purely to hold a pressure that nothing is drawing from. The gas cushion in
     * the header will hold that pressure for minutes on its own, so the set stops, coasts, and
     * restarts when the pressure droops. It is the single largest energy saving available on a
     * set like this, and it is also where sets get a reputation for short-cycling, because the
     * wake-up droop has to be wide enough that the accumulator actually buys some time.
     */
    sleepEnabled: false,
    /** Flow to process below which the sleep timer runs, m3/h. */
    sleepFlow_m3h: 3,
    /** Seconds the flow must stay below `sleepFlow_m3h` before the set stops. */
    sleepDelay_s: 40,
    /**
     * Fractional droop below setpoint that wakes the set.
     *
     * The single most important number in sleep mode, and the one that gets set too small. The
     * gas cushion is what buys the sleep, and how long it buys is the droop divided by the rate
     * the header falls at. Too tight and the set wakes within seconds of stopping, which is worse
     * than never sleeping at all.
     */
    wakeDroop: 0.10,
    ...over,
  };
}

/**
 * Allocate the mutable sequence state.
 * @param {number} nPumps how many machines the sequence manages
 * @returns {object} sequence state
 */
export function createStagingState(nPumps) {
  return {
    /** Index of the lead machine. */
    lead: 0,
    /** Per-pump operator placement, one of {@link HAND}. */
    hand: new Array(nPumps).fill(HAND.AUTO),
    /** Seconds the stage-up condition has been continuously true. */
    upTimer_s: 0,
    /** Seconds the stage-down condition has been continuously true. */
    downTimer_s: 0,
    /** Seconds the sleep condition has been continuously true. */
    sleepTimer_s: 0,
    /** True while the set is stopped on no demand and waiting for the pressure to droop. */
    sleeping: false,
    /** Per-pump minimum-run timers, s. */
    minRun_s: new Float64Array(nPumps),
    /** Per-pump minimum-stop timers, s. */
    minStop_s: new Float64Array(nPumps),
    /** Per-pump start counters, for the short-cycling metric. */
    starts: new Int32Array(nPumps),
    /** Non-null while a make-before-break changeover is in progress. */
    changeover: null,
    /** One-line description of the last thing the sequence did. */
    lastAction: 'sequence idle',
    /** Simulated time of the last action, s. */
    lastActionAt_s: 0,
    /** How many stage transitions have happened. The short-cycling counter. */
    transitions: 0,
    /** Why the sequence is holding, for the panel. Recomputed every scan. */
    holdReason: '',
    /** Latest energy comparison, for the panel: kW predicted for each pump count. */
    energyPredictions: [],
    /** The output actually sent to the machines last scan, after any staging bias, percent. */
    distributed_pct: 0,
  };
}

/**
 * The machine the sequence would call next, or -1 when there is nothing available.
 * @param {object} sq sequence state
 * @param {object[]} drv drive states
 * @param {number} exclude a machine index to skip
 * @returns {number} index of the next startable machine, or -1
 */
function nextAvailable(sq, drv, exclude) {
  const n = drv.length;
  for (let k = 0; k < n; k += 1) {
    const i = (sq.lead + k) % n;
    if (i === exclude) continue;
    if (sq.hand[i] !== HAND.AUTO) continue;
    if (drv[i].state === DRIVE.TRIPPED) continue;
    if (isCalled(drv[i])) continue;
    if (sq.minStop_s[i] > 0) continue;
    return i;
  }
  return -1;
}

/**
 * Apply a staging bias to the controller without a bump in the wrong direction.
 *
 * The output is scaled and then written back into the integral, so the loop restarts from the
 * biased point rather than winding back to where it was. Scaling the OUTPUT alone would be undone
 * by the very next scan.
 *
 * @param {object} pidCfg tuning record
 * @param {object} pid controller state (mutated)
 * @param {number} factor multiplier on the current output
 * @returns {void}
 */
function biasOutput(pidCfg, pid, co, factor) {
  if (factor === 1) return co;
  const next = clamp(co * factor, pidCfg.outLo, pidCfg.outHi);
  preload(pid, next);
  return next;
}

/**
 * Advance the sequence one scan: decide which machines should be turning, then distribute the
 * controller output across the ones that are.
 *
 * @param {object} cfg staging config from {@link createStagingConfig}
 * @param {object} sq sequence state (mutated)
 * @param {object} ctx everything the sequence needs to know about the world
 * @param {object[]} ctx.drives per-pump drive specs
 * @param {object[]} ctx.drv per-pump drive states (mutated through start/stop requests)
 * @param {object} ctx.pidCfg controller tuning, for the output limits the bias must respect
 * @param {number} ctx.co the output actually going to the machines this scan, percent — which
 *   is not always the primary controller's own output: feedforward, a cascade slave and an
 *   override selector all sit between them
 * @param {object} ctx.pid the controller that OWNS that output, whose integral is preloaded when
 *   the sequence applies a staging bias
 * @param {number} ctx.t_s simulated time, s, for the action log
 * @param {number} ctx.flow_m3h total header flow, m3/h
 * @param {number} ctx.pv the controlled measurement, engineering units
 * @param {number} ctx.sp the setpoint, engineering units
 * @param {(n:number)=>number} [ctx.predictPower] predicted electrical kW with `n` pumps running
 *   at the duty that satisfies the current setpoint; NaN when that is not achievable
 * @param {number} dt_s scan period, s
 * @returns {string|null} a one-line description if the sequence acted this scan, else null. The
 *   output that was actually distributed — which the staging bias may have moved — is left in
 *   `sq.distributed_pct`.
 */
export function stepStaging(cfg, sq, ctx, dt_s) {
  const { drives, drv, pidCfg, pid, t_s } = ctx;
  const n = drv.length;
  let action = null;
  let co = ctx.co;
  sq.holdReason = '';

  // --- timers ------------------------------------------------------------------------------
  for (let i = 0; i < n; i += 1) {
    if (isCalled(drv[i])) {
      sq.minRun_s[i] = Math.max(0, sq.minRun_s[i] - dt_s);
      sq.minStop_s[i] = cfg.minStop_s;
    } else {
      sq.minStop_s[i] = Math.max(0, sq.minStop_s[i] - dt_s);
      sq.minRun_s[i] = cfg.minRun_s;
    }
  }

  /**
   * Record an action and reset every stage timer, so one transition cannot immediately trigger
   * the next on the disturbance it caused itself.
   * @param {string} msg description
   * @returns {void}
   */
  function note(msg) {
    action = msg;
    sq.lastAction = msg;
    sq.lastActionAt_s = t_s;
    sq.upTimer_s = 0;
    sq.downTimer_s = 0;
    sq.sleepTimer_s = 0;
    sq.transitions += 1;
  }

  /**
   * Start a machine and count it.
   * @param {number} i pump index
   * @returns {void}
   */
  function call(i) {
    startDrive(drives[i], drv[i]);
    sq.starts[i] += 1;
  }

  // --- operator placement wins over everything ---------------------------------------------
  for (let i = 0; i < n; i += 1) {
    if (sq.hand[i] === HAND.HAND && !isCalled(drv[i]) && drv[i].state !== DRIVE.TRIPPED) {
      call(i);
      sq.sleeping = false;
    } else if (sq.hand[i] === HAND.OFF && isCalled(drv[i])) {
      stopDrive(drv[i], STOP_MODE.RAMP);
    }
  }

  const called = [];
  for (let i = 0; i < n; i += 1) if (isCalled(drv[i])) called.push(i);

  // --- a tripped lead is promoted away immediately -----------------------------------------
  if (drv[sq.lead].state === DRIVE.TRIPPED) {
    const alt = nextAvailable(sq, drv, sq.lead);
    if (alt >= 0) {
      const was = sq.lead;
      sq.lead = alt;
      call(alt);
      sq.sleeping = false;
      note(`P-10${was + 1} tripped — P-10${alt + 1} promoted to lead`);
    }
  }

  // --- sleep and wake ------------------------------------------------------------------------
  if (cfg.enabled && cfg.sleepEnabled && !action && !sq.changeover) {
    if (sq.sleeping) {
      const wakeAt = ctx.sp * (1 - cfg.wakeDroop);
      // Only the droop wakes it. Testing "is anything running" here looks reasonable and is a
      // trap: a machine that has just been told to stop is still coasting down and still reads as
      // called, so the set wakes on the very next scan and the whole feature turns into a
      // short-cycling generator.
      if (!(ctx.pv >= wakeAt)) {
        sq.sleeping = false;
        const first = nextAvailable(sq, drv, -1);
        if (first >= 0) {
          call(first);
          note(`woke on droop — header fell to ${ctx.pv.toPrecision(3)} against a `
            + `${wakeAt.toPrecision(3)} wake point`);
        } else {
          sq.holdReason = 'wants to wake but nothing is available to start';
        }
      } else {
        sq.holdReason = `asleep — header holding at ${ctx.pv.toPrecision(3)}, wakes at `
          + `${wakeAt.toPrecision(3)}`;
      }
    } else if (called.length === 1 && ctx.flow_m3h <= cfg.sleepFlow_m3h && ctx.pv >= ctx.sp) {
      sq.sleepTimer_s += dt_s;
      if (sq.sleepTimer_s >= cfg.sleepDelay_s && sq.minRun_s[called[0]] <= 0) {
        stopDrive(drv[called[0]], STOP_MODE.RAMP);
        sq.sleeping = true;
        note(`set asleep — ${ctx.flow_m3h.toFixed(1)} m3/h drawn for ${cfg.sleepDelay_s} s on a `
          + 'satisfied header');
      } else if (sq.sleepTimer_s < cfg.sleepDelay_s) {
        sq.holdReason = `sleep in ${(cfg.sleepDelay_s - sq.sleepTimer_s).toFixed(0)} s`;
      }
    } else {
      sq.sleepTimer_s = 0;
    }
  } else if (!cfg.sleepEnabled) {
    sq.sleeping = false;
    sq.sleepTimer_s = 0;
  }

  // --- make-before-break changeover ---------------------------------------------------------
  if (sq.changeover) {
    sq.changeover.timer_s -= dt_s;
    const { from, to } = sq.changeover;
    if (sq.changeover.timer_s <= 0) {
      stopDrive(drv[from], STOP_MODE.RAMP);
      sq.lead = to;
      sq.changeover = null;
      co = biasOutput(pidCfg, pid, co, cfg.stageDownBias);
      note(`changeover complete — P-10${to + 1} is lead`);
    } else {
      sq.holdReason = `changeover: P-10${from + 1} stops in ${sq.changeover.timer_s.toFixed(0)} s`;
    }
  } else if (cfg.enabled && !action && !sq.sleeping && cfg.rotate === ROTATE.RUNTIME
      && called.length === 1) {
    const running = called[0];
    const alt = nextAvailable(sq, drv, running);
    if (alt >= 0 && drv[running].runtime_h - drv[alt].runtime_h >= cfg.rotateAfter_h
        && sq.minRun_s[running] <= 0) {
      call(alt);
      sq.changeover = { from: running, to: alt, timer_s: cfg.overlap_s };
      co = biasOutput(pidCfg, pid, co, cfg.stageUpBias);
      note(`duty rotation — P-10${alt + 1} starting, P-10${running + 1} to stop in ${cfg.overlap_s} s`);
    }
  }

  // --- ordinary stage up and down -----------------------------------------------------------
  if (cfg.enabled && !sq.changeover && !action && !sq.sleeping) {
    const auto = [];
    for (let i = 0; i < n; i += 1) if (sq.hand[i] === HAND.AUTO) auto.push(i);

    // Always keep at least one machine turning while any is available in auto.
    if (called.length === 0 && auto.length > 0) {
      const first = nextAvailable(sq, drv, -1);
      if (first >= 0) {
        call(first);
        note(`P-10${first + 1} started — lead`);
      } else {
        sq.holdReason = 'nothing available to start — check hand/off placement and trips';
      }
    } else {
      const want = stagingDemand(cfg, sq, ctx, called.length, auto.length);
      if (want > called.length) {
        sq.downTimer_s = 0;
        sq.upTimer_s += dt_s;
        if (sq.upTimer_s >= cfg.stageUpDelay_s) {
          const add = nextAvailable(sq, drv, -1);
          if (add >= 0) {
            call(add);
            co = biasOutput(pidCfg, pid, co, cfg.stageUpBias);
            note(`P-10${add + 1} staged in — ${want > called.length + 1 ? 'demand' : 'threshold'} `
              + `held ${cfg.stageUpDelay_s} s (${stagingReason(cfg, ctx)})`);
          } else {
            sq.upTimer_s = cfg.stageUpDelay_s;
            sq.holdReason = 'want another pump but none is available';
          }
        } else {
          sq.holdReason = `stage up in ${(cfg.stageUpDelay_s - sq.upTimer_s).toFixed(0)} s`;
        }
      } else if (want < called.length && called.length > 1) {
        sq.upTimer_s = 0;
        sq.downTimer_s += dt_s;
        if (sq.downTimer_s >= cfg.stageDownDelay_s) {
          // Stop the machine with the MOST runtime that is allowed to stop — rotation for free.
          let drop = -1;
          for (const i of called) {
            if (sq.hand[i] !== HAND.AUTO) continue;
            if (sq.minRun_s[i] > 0) continue;
            if (drop < 0 || drv[i].runtime_h > drv[drop].runtime_h) drop = i;
          }
          if (drop >= 0) {
            stopDrive(drv[drop], STOP_MODE.RAMP);
            co = biasOutput(pidCfg, pid, co, cfg.stageDownBias);
            if (drop === sq.lead) {
              for (const i of called) if (i !== drop) { sq.lead = i; break; }
            }
            note(`P-10${drop + 1} staged out — threshold held ${cfg.stageDownDelay_s} s `
              + `(${stagingReason(cfg, ctx)})`);
          } else {
            sq.holdReason = 'want to stage down but the minimum run timer is holding';
          }
        } else {
          sq.holdReason = `stage down in ${(cfg.stageDownDelay_s - sq.downTimer_s).toFixed(0)} s`;
        }
      } else {
        sq.upTimer_s = 0;
        sq.downTimer_s = 0;
      }
    }
  }

  // --- distribute the output ------------------------------------------------------------------
  const running = [];
  for (let i = 0; i < n; i += 1) if (isCalled(drv[i])) running.push(i);
  for (let i = 0; i < n; i += 1) {
    if (!isCalled(drv[i])) { drv[i].cmd_pct = 0; continue; }
    if (cfg.share === SHARE.BASE_TRIM && running.length > 1 && i !== sq.lead) {
      drv[i].cmd_pct = cfg.baseSpeed_pct;
    } else {
      drv[i].cmd_pct = co;
    }
  }

  sq.distributed_pct = co;
  return action;
}

/**
 * How many machines the criterion in force says should be running.
 *
 * @param {object} cfg staging config
 * @param {object} sq sequence state (its energy predictions are refreshed here)
 * @param {object} ctx the step context
 * @param {number} nowRunning how many are called at the moment
 * @param {number} available how many the sequence is allowed to use
 * @returns {number} the wanted count
 */
function stagingDemand(cfg, sq, ctx, nowRunning, available) {
  // Saturation is a backstop under every criterion: if the output is pinned there is by
  // definition not enough machine on line, whatever the economics say.
  if (ctx.co >= cfg.saturationOverride_pct && nowRunning < available) return nowRunning + 1;

  if (cfg.criterion === CRITERION.FLOW) {
    if (ctx.flow_m3h >= cfg.stageUpFlow_m3h && nowRunning < available) return nowRunning + 1;
    if (ctx.flow_m3h <= cfg.stageDownFlow_m3h && nowRunning > 1) return nowRunning - 1;
    return nowRunning;
  }

  if (cfg.criterion === CRITERION.ENERGY && typeof ctx.predictPower === 'function') {
    const preds = [];
    for (let k = 1; k <= available; k += 1) preds.push({ n: k, kW: ctx.predictPower(k) });
    sq.energyPredictions = preds;
    const here = preds.find((p) => p.n === nowRunning);
    // An infeasible current configuration means the setpoint is out of reach: add a machine.
    if (!here || !Number.isFinite(here.kW)) {
      return nowRunning < available ? nowRunning + 1 : nowRunning;
    }
    const up = preds.find((p) => p.n === nowRunning + 1);
    const down = preds.find((p) => p.n === nowRunning - 1);
    if (up && Number.isFinite(up.kW) && up.kW < here.kW * (1 - cfg.energyMargin)) {
      return nowRunning + 1;
    }
    if (down && Number.isFinite(down.kW) && down.kW < here.kW * (1 - cfg.energyMargin)
        && nowRunning > 1) {
      return nowRunning - 1;
    }
    return nowRunning;
  }

  // CRITERION.OUTPUT, and the fallback whenever a better criterion has no data.
  if (ctx.co >= cfg.stageUp_pct && nowRunning < available) return nowRunning + 1;
  if (ctx.co <= cfg.stageDown_pct && nowRunning > 1) return nowRunning - 1;
  return nowRunning;
}

/**
 * A short phrase naming the number the criterion acted on, for the action log.
 * @param {object} cfg staging config
 * @param {object} ctx the step context
 * @returns {string} the phrase
 */
function stagingReason(cfg, ctx) {
  if (cfg.criterion === CRITERION.FLOW) return `${ctx.flow_m3h.toFixed(0)} m3/h`;
  if (cfg.criterion === CRITERION.ENERGY) return 'predicted energy crossover';
  return `output ${ctx.co.toFixed(0)}%`;
}

/**
 * Total starts across the set, per hour of simulated running. The short-cycling number an
 * engineer actually quotes: most starters are rated for six to ten starts an hour.
 * @param {object} sq sequence state
 * @param {number} elapsed_h simulated hours since the counters were cleared
 * @returns {number} starts per hour
 */
export function startsPerHour(sq, elapsed_h) {
  let total = 0;
  for (let i = 0; i < sq.starts.length; i += 1) total += sq.starts[i];
  return elapsed_h > 1e-6 ? total / elapsed_h : 0;
}
