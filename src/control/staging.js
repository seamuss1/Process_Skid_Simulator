/**
 * src/control/staging.js — the sequence logic above the PID: which pump is lead, when the lag
 * joins it, when it leaves again, and how the duty gets shared over a week.
 *
 * Layer L2: imports `core/util.js`, `control/pid.js` and `process/motor.js`. No DOM, no plant
 * physics — it reads drive states and the controller output, and it writes start/stop requests
 * and speed commands.
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
 * motors and starters, and the three defences against it are all here:
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
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { preload } from './pid.js';
import { DRIVE, start as startDrive, stop as stopDrive, isCalled } from '../process/motor.js';

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
    /** Controller output above which the stage-up timer runs, percent. */
    stageUp_pct: 88,
    /** Seconds the output must stay above `stageUp_pct` before the lag starts. */
    stageUpDelay_s: 8,
    /** Controller output below which the stage-down timer runs, percent. */
    stageDown_pct: 40,
    /** Seconds the output must stay below `stageDown_pct` before the lag stops. */
    stageDownDelay_s: 20,
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
    /** Seconds the output has been continuously above the stage-up threshold. */
    upTimer_s: 0,
    /** Seconds the output has been continuously below the stage-down threshold. */
    downTimer_s: 0,
    /** Per-pump minimum-run timers, s. */
    minRun_s: new Float64Array(nPumps),
    /** Per-pump minimum-stop timers, s. */
    minStop_s: new Float64Array(nPumps),
    /** Non-null while a make-before-break changeover is in progress. */
    changeover: null,
    /** One-line description of the last thing the sequence did. */
    lastAction: 'sequence idle',
    /** Simulated time of the last action, s. */
    lastActionAt_s: 0,
    /** How many stage transitions have happened. The short-cycling counter. */
    transitions: 0,
  };
}

/**
 * The machine the sequence would call next, or -1 when there is nothing available.
 * @param {object} cfg staging config
 * @param {object} sq sequence state
 * @param {object[]} drv drive states
 * @param {number} exclude a machine index to skip
 * @returns {number} index of the next startable machine, or -1
 */
function nextAvailable(cfg, sq, drv, exclude) {
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
function biasOutput(pidCfg, pid, factor) {
  if (factor === 1) return;
  preload(pid, clamp(pid.co * factor, pidCfg.outLo, pidCfg.outHi));
}

/**
 * Advance the sequence one scan: decide which machines should be turning, then distribute the
 * controller output across the ones that are.
 *
 * @param {object} cfg staging config from {@link createStagingConfig}
 * @param {object} sq sequence state (mutated)
 * @param {object} pidCfg controller tuning, for the output limits the bias must respect
 * @param {object} pid controller state (read for `co`; its integral is preloaded on a stage)
 * @param {object[]} drv drive states (mutated through start/stop requests)
 * @param {number} t_s simulated time, s, for the action log
 * @param {number} dt_s scan period, s
 * @returns {string|null} a one-line description if the sequence acted this scan, else null
 */
export function stepStaging(cfg, sq, pidCfg, pid, drv, t_s, dt_s) {
  const n = drv.length;
  let action = null;

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
   * Record an action and reset both stage timers, so one transition cannot immediately trigger
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
    sq.transitions += 1;
  }

  // --- operator placement wins over everything ---------------------------------------------
  for (let i = 0; i < n; i += 1) {
    if (sq.hand[i] === HAND.HAND && !isCalled(drv[i]) && drv[i].state !== DRIVE.TRIPPED) {
      startDrive(cfg._drives ? cfg._drives[i] : DEFAULT_DRIVE, drv[i]);
    } else if (sq.hand[i] === HAND.OFF && isCalled(drv[i])) {
      stopDrive(drv[i]);
    }
  }

  const called = [];
  for (let i = 0; i < n; i += 1) if (isCalled(drv[i])) called.push(i);

  // --- a tripped lead is promoted away immediately -----------------------------------------
  if (drv[sq.lead].state === DRIVE.TRIPPED) {
    const alt = nextAvailable(cfg, sq, drv, sq.lead);
    if (alt >= 0) {
      const was = sq.lead;
      sq.lead = alt;
      startDrive(cfg._drives[alt], drv[alt]);
      note(`P-10${was + 1} tripped — P-10${alt + 1} promoted to lead`);
    }
  }

  // --- make-before-break changeover ---------------------------------------------------------
  if (sq.changeover) {
    sq.changeover.timer_s -= dt_s;
    const { from, to } = sq.changeover;
    if (sq.changeover.timer_s <= 0) {
      stopDrive(drv[from]);
      sq.lead = to;
      sq.changeover = null;
      biasOutput(pidCfg, pid, cfg.stageDownBias);
      note(`changeover complete — P-10${to + 1} is lead`);
    }
  } else if (cfg.enabled && cfg.rotate === ROTATE.RUNTIME && called.length === 1) {
    const running = called[0];
    const alt = nextAvailable(cfg, sq, drv, running);
    if (alt >= 0 && drv[running].runtime_h - drv[alt].runtime_h >= cfg.rotateAfter_h
        && sq.minRun_s[running] <= 0) {
      startDrive(cfg._drives[alt], drv[alt]);
      sq.changeover = { from: running, to: alt, timer_s: cfg.overlap_s };
      biasOutput(pidCfg, pid, cfg.stageUpBias);
      note(`duty rotation — P-10${alt + 1} starting, P-10${running + 1} to stop in ${cfg.overlap_s} s`);
    }
  }

  // --- ordinary stage up and down -----------------------------------------------------------
  if (cfg.enabled && !sq.changeover && !action) {
    const co = pid.co;
    const auto = [];
    for (let i = 0; i < n; i += 1) if (sq.hand[i] === HAND.AUTO) auto.push(i);

    // Always keep at least one machine turning while any is available in auto.
    if (called.length === 0 && auto.length > 0) {
      const first = nextAvailable(cfg, sq, drv, -1);
      if (first >= 0) {
        startDrive(cfg._drives[first], drv[first]);
        note(`P-10${first + 1} started — lead`);
      }
    } else if (co >= cfg.stageUp_pct && called.length < auto.length) {
      sq.downTimer_s = 0;
      sq.upTimer_s += dt_s;
      if (sq.upTimer_s >= cfg.stageUpDelay_s) {
        const add = nextAvailable(cfg, sq, drv, -1);
        if (add >= 0) {
          startDrive(cfg._drives[add], drv[add]);
          biasOutput(pidCfg, pid, cfg.stageUpBias);
          note(`P-10${add + 1} staged in — output held ${cfg.stageUpDelay_s} s above ${cfg.stageUp_pct}%`);
        } else {
          sq.upTimer_s = cfg.stageUpDelay_s;
        }
      }
    } else if (co <= cfg.stageDown_pct && called.length > 1) {
      sq.upTimer_s = 0;
      sq.downTimer_s += dt_s;
      if (sq.downTimer_s >= cfg.stageDownDelay_s) {
        // Stop the machine with the MOST runtime that is allowed to stop — rotation for free.
        let drop = -1;
        for (const i of called) {
          if (sq.hand[i] !== HAND.AUTO) continue;
          if (sq.minRun_s[i] > 0) continue;
          if (called.length <= 1) continue;
          if (drop < 0 || drv[i].runtime_h > drv[drop].runtime_h) drop = i;
        }
        if (drop >= 0) {
          stopDrive(drv[drop]);
          biasOutput(pidCfg, pid, cfg.stageDownBias);
          if (drop === sq.lead) {
            for (const i of called) if (i !== drop) { sq.lead = i; break; }
          } else if (cfg.rotate === ROTATE.ON_STAGE_DOWN) {
            sq.lead = drop === 0 ? 0 : sq.lead;
          }
          note(`P-10${drop + 1} staged out — output held ${cfg.stageDownDelay_s} s below ${cfg.stageDown_pct}%`);
        }
      }
    } else {
      sq.upTimer_s = 0;
      sq.downTimer_s = 0;
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
      drv[i].cmd_pct = pid.co;
    }
  }

  return action;
}

/**
 * Fallback drive spec used only if the sequence is stepped before `cfg._drives` is attached — it
 * keeps a misconfigured harness from throwing instead of failing a test loudly. Production code
 * always passes the real specs.
 */
const DEFAULT_DRIVE = Object.freeze({ startDelay_s: 1 });
