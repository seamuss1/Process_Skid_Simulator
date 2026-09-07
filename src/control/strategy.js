/**
 * src/control/strategy.js — the control STRUCTURE above the algorithm: setpoint reset, gain
 * scheduling, cascade, feedforward and override selection.
 *
 * Layer L2: imports `core/util.js`, `control/pid.js` and the plant's steady-state inverse.
 * No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS AT ALL
 *
 * Almost every loop that "cannot be tuned" is a loop with the wrong STRUCTURE, not the wrong
 * numbers. Tuning moves a loop along a trade-off between speed and robustness; structure moves
 * the trade-off itself. The five things here are the ones that actually do that, and each of them
 * answers a specific complaint an operator makes about this rig:
 *
 *   "It cannot keep up with a big load change."
 *       FEEDFORWARD. The demand valve position is measured, so the disturbance is KNOWN before
 *       its effect arrives. A model-based feedforward asks the plant what output that demand will
 *       need and puts it there immediately; the feedback loop is then only correcting the model's
 *       error rather than discovering the whole disturbance from scratch.
 *
 *   "It is fine at 30 m3/h and hunts at 90."
 *       GAIN SCHEDULING. The process gain of this rig changes by a factor of several across its
 *       range — the pump curve steepens, the valve characteristic is exponential, and a second
 *       machine may have joined. One set of gains cannot be right everywhere, and pretending
 *       otherwise means being detuned everywhere to be safe somewhere.
 *
 *   "The pump curve is nonlinear so the pressure loop is horrible."
 *       CASCADE. Put a fast flow loop underneath. It linearises the drive-and-pump relationship
 *       and swallows its disturbances locally, and the pressure master then sees something close
 *       to a first-order lag.
 *
 *   "We waste energy holding full pressure at four in the morning."
 *       SETPOINT RESET. The system's friction loss falls with the square of flow, so the head
 *       actually needed falls with it. Holding the design pressure at part load is paying for
 *       friction that is not there.
 *
 *   "It holds setpoint beautifully and keeps tripping the motor."
 *       OVERRIDE. A constraint controller that is normally ignored and takes over when it is not.
 *       The important part is not the selection — it is keeping the losers' integrals tracking so
 *       that whichever one takes over does so without a bump.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, lag } from '../core/util.js';
import { createPidConfig, createPidState, stepPid, preload, resetPid, MODE } from './pid.js';

/** The control structure in force. */
export const STRUCTURE = Object.freeze({
  /** One controller straight onto the final element. */
  SINGLE: 'SINGLE',
  /** A master trimming the setpoint of a fast inner loop. */
  CASCADE: 'CASCADE',
});

/** What a gain schedule interpolates against. */
export const SCHED_ON = Object.freeze({
  /** Flow to process. The usual choice: it is what the process gain actually varies with. */
  FLOW: 'FLOW',
  /** Controller output. Cheap, always available, and a decent proxy. */
  OUTPUT: 'OUTPUT',
  /** How many machines are running. Discrete, and the biggest single change in the gain. */
  PUMPS: 'PUMPS',
});

/**
 * Default strategy configuration. Everything off: the rig ships as a plain single loop, and every
 * structure here is something the operator turns on deliberately and can see the effect of.
 * @param {object} [over] initial overrides
 * @returns {object} a fresh strategy configuration
 */
export function createStrategyConfig(over) {
  return {
    structure: STRUCTURE.SINGLE,

    /** Cascade: the master's output becomes the slave's setpoint over this range. */
    cascade: {
      /** Slave setpoint at 0% master output, m3/h. */
      spLo_m3h: 0,
      /** Slave setpoint at 100% master output, m3/h. */
      spHi_m3h: 140,
    },

    /** Feedforward from the measured demand-valve position. */
    ff: {
      enabled: false,
      /**
       * How much of the model's answer to actually apply, 0..1. Almost never 1: a feedforward at
       * full gain that is slightly wrong is worse than one at 80% that is slightly wrong, because
       * the feedback loop can correct an under-correction far more gracefully than an
       * over-correction.
       */
      gain: 0.85,
      /** Lead time, s. Speeds the feedforward up when it arrives too late. */
      lead_s: 0,
      /** Lag time, s. Slows it down when it arrives too early. */
      lag_s: 2,
      /** Set by the strategy each scan: the raw model answer, before gain and dynamics. */
      raw_pct: 0,
      /** Set each scan: what is actually being added to the output. */
      applied_pct: 0,
    },

    /** Gain scheduling. */
    sched: {
      enabled: false,
      on: SCHED_ON.FLOW,
      /**
       * Breakpoints, ascending in `at`. Between them the tuning is interpolated linearly; outside
       * them it is held. Three points is almost always enough and more is almost always a sign
       * that the loop wants a different structure rather than more numbers.
       */
      points: [
        { at: 15, Kc: 26, Ti: 14, Td: 0 },
        { at: 45, Kc: 18, Ti: 12, Td: 0 },
        { at: 95, Kc: 11, Ti: 10, Td: 0 },
      ],
      /** Set each scan: the tuning the schedule produced. */
      active: { Kc: 0, Ti: 0, Td: 0 },
    },

    /** Setpoint reset: lower the demanded pressure as the flow falls. */
    reset: {
      enabled: false,
      /** Setpoint at zero flow — the static head the process still needs, bar. */
      spMin_bar: 1.6,
      /** Setpoint at the design flow, bar. */
      spMax_bar: 3.2,
      /** The design flow the maximum applies at, m3/h. */
      qDesign_m3h: 95,
      /** Set each scan: the setpoint the reset produced. */
      active_bar: 0,
    },

    /** Constraint overrides. Each is a controller that normally loses the selection. */
    override: {
      /** Pull the speed back before the motor overload does it for you. */
      current: { enabled: false, limit_pct: 105 },
      /** Hold a minimum flow through the machines when the recirculation cannot. */
      minFlow: { enabled: false, limit_m3h: 10 },
      /** Do not let the header exceed this, whatever the primary controller wants. */
      maxPressure: { enabled: false, limit_bar: 5.2 },
      /** Set each scan: which controller actually won. */
      selected: 'PRIMARY',
    },
    ...over,
  };
}

/**
 * Allocate the mutable state the strategy needs: the slave controller and the override
 * controllers, each of which is a full PID in its own right.
 * @returns {object} strategy state
 */
export function createStrategyState() {
  const mk = (sp, co, over) => ({
    cfg: createPidConfig(over),
    st: createPidState(sp, co),
  });
  return {
    /** The inner flow loop, used when the structure is CASCADE. */
    slave: mk(30, 40, { Kc: 1.4, Ti: 5, Td: 0, outLo: 0, outHi: 100 }),
    /** Constraint controllers. Reverse-acting on a maximum is a MINIMUM-select loser. */
    ovCurrent: mk(105, 100, { Kc: 2.5, Ti: 8, Td: 0, outLo: 0, outHi: 100, action: 'REVERSE' }),
    ovMinFlow: mk(10, 0, { Kc: 3.0, Ti: 10, Td: 0, outLo: 0, outHi: 100, action: 'REVERSE' }),
    ovMaxP: mk(5.2, 100, { Kc: 30, Ti: 8, Td: 0, outLo: 0, outHi: 100, action: 'REVERSE' }),
    /** Feedforward dynamic-compensation state. */
    ffLead: 0,
    ffLag: 0,
    /** The last selection made, for the trend marker. */
    lastSelected: 'PRIMARY',
  };
}

/**
 * The setpoint the reset schedule asks for at the current flow.
 *
 * The relation is a square law because that is what pipe friction is: at half the design flow the
 * system loses a quarter of the friction head, so the pressure needed at the pump to deliver the
 * same conditions at the far end is lower by that much. Holding the design pressure anyway is
 * paying, continuously, for a loss that is not occurring.
 *
 * @param {object} cfg strategy config (its `reset.active_bar` is written)
 * @param {number} q_m3h the present flow to process
 * @returns {number} the setpoint, bar
 */
export function resetSetpoint(cfg, q_m3h) {
  const r = cfg.reset;
  const f = clamp(q_m3h / Math.max(r.qDesign_m3h, 1e-6), 0, 1.2);
  r.active_bar = r.spMin_bar + (r.spMax_bar - r.spMin_bar) * f * f;
  return r.active_bar;
}

/**
 * Interpolate the scheduled tuning at a scheduling variable's present value.
 * @param {object} cfg strategy config (its `sched.active` is written)
 * @param {number} x the scheduling variable
 * @returns {{Kc:number, Ti:number, Td:number}} the interpolated tuning
 */
export function scheduledTuning(cfg, x) {
  const pts = cfg.sched.points;
  let out;
  if (!pts.length) out = { Kc: 1, Ti: 10, Td: 0 };
  else if (x <= pts[0].at) out = { Kc: pts[0].Kc, Ti: pts[0].Ti, Td: pts[0].Td };
  else if (x >= pts[pts.length - 1].at) {
    const p = pts[pts.length - 1];
    out = { Kc: p.Kc, Ti: p.Ti, Td: p.Td };
  } else {
    let i = 0;
    while (i < pts.length - 2 && x > pts[i + 1].at) i += 1;
    const a = pts[i];
    const b = pts[i + 1];
    const t = (x - a.at) / Math.max(b.at - a.at, 1e-9);
    out = {
      Kc: a.Kc + (b.Kc - a.Kc) * t,
      Ti: a.Ti + (b.Ti - a.Ti) * t,
      Td: a.Td + (b.Td - a.Td) * t,
    };
  }
  cfg.sched.active = out;
  return out;
}

/**
 * The value the scheduling variable currently has.
 * @param {object} cfg strategy config
 * @param {object} plant plant state
 * @param {object} pid the primary controller's state
 * @returns {number} the scheduling variable
 */
export function schedulingVariable(cfg, plant, pid) {
  switch (cfg.sched.on) {
    case SCHED_ON.OUTPUT: return pid.co;
    case SCHED_ON.PUMPS: {
      let n = 0;
      for (const d of plant.drv) if (d.n_pct > 5) n += 1;
      return n;
    }
    default: return plant.ft_m3h;
  }
}

/**
 * Compute and dynamically compensate the feedforward contribution.
 *
 * The model answers "what output holds setpoint at this valve position?" exactly, at steady
 * state. What it cannot answer is WHEN. The disturbance reaches the measurement through the
 * process's own dynamics; the feedforward reaches it through the drive's. Those are different, so
 * the raw model answer arrives at the wrong moment and produces an inverse-response wobble that
 * looks worse than no feedforward at all.
 *
 * The fix is the classical lead-lag: `(1 + lead*s)/(1 + lag*s)`, two numbers that shift the
 * feedforward earlier or later in time without changing its final magnitude. Getting them right
 * is a matter of watching the trend and asking whether the correction is early or late, which is
 * a far easier question than the one tuning normally poses.
 *
 * @param {object} cfg strategy config (its `ff.raw_pct` and `ff.applied_pct` are written)
 * @param {object} sst strategy state (mutated)
 * @param {number} raw_pct the model's answer, percent
 * @param {number} dt_s scan period, s
 * @returns {number} the feedforward contribution to add to the output, percent
 */
export function feedforward(cfg, sst, raw_pct, dt_s) {
  cfg.ff.raw_pct = raw_pct;
  if (!cfg.ff.enabled) { cfg.ff.applied_pct = 0; return 0; }
  const scaled = raw_pct * cfg.ff.gain;
  // Lag first, then add the lead as a scaled derivative of the lagged signal — the standard
  // realisable form, which never differentiates a step.
  const prevLag = sst.ffLag;
  sst.ffLag = lag(sst.ffLag, scaled, cfg.ff.lag_s, dt_s);
  const rate = dt_s > 0 ? (sst.ffLag - prevLag) / dt_s : 0;
  const out = sst.ffLag + cfg.ff.lead_s * rate;
  cfg.ff.applied_pct = out;
  return out;
}

/**
 * Run the constraint controllers and select between them.
 *
 * A selector loop's whole difficulty is the losers. A controller whose output is not selected is
 * a controller whose measurement is not being controlled, so its integral winds — and when the
 * constraint finally binds, it takes over with an output that has been drifting for ten minutes.
 * The cure is INTEGRAL TRACKING: every scan, each loser is preloaded to the output that actually
 * went out, so it is always ready to take over from exactly where the plant is.
 *
 * @param {object} cfg strategy config (its `override.selected` is written)
 * @param {object} sst strategy state (mutated)
 * @param {object} plant plant state
 * @param {number} primary_pct the primary controller's output
 * @param {number} dt_s scan period, s
 * @returns {{co_pct:number, selected:string, changed:boolean}} the selected output and who won
 */
export function selectOverrides(cfg, sst, plant, primary_pct, dt_s) {
  const o = cfg.override;
  /** @type {Array<{name:string, co:number}>} */
  const candidates = [{ name: 'PRIMARY', co: primary_pct }];

  if (o.current.enabled) {
    let worst = 0;
    for (const d of plant.drv) worst = Math.max(worst, d.i_pct);
    sst.ovCurrent.st.spTarget = o.current.limit_pct;
    candidates.push({ name: 'CURRENT', co: stepPid(sst.ovCurrent.cfg, sst.ovCurrent.st, worst, dt_s) });
  }
  if (o.maxPressure.enabled) {
    sst.ovMaxP.st.spTarget = o.maxPressure.limit_bar;
    candidates.push({ name: 'MAX-P', co: stepPid(sst.ovMaxP.cfg, sst.ovMaxP.st, plant.pt_bar, dt_s) });
  }

  // The minimum-flow constraint pushes the output UP, so it is a HIGH select and is applied after
  // the low select rather than inside it. A constraint that can only raise the output and one that
  // can only lower it are different selections and must not be mixed into one comparison.
  let lo = candidates[0];
  for (const c of candidates) if (c.co < lo.co) lo = c;
  let co = lo.co;
  let selected = lo.name;

  if (o.minFlow.enabled) {
    let total = 0;
    for (const q of plant.Q_m3h) total += q;
    sst.ovMinFlow.st.spTarget = o.minFlow.limit_m3h;
    const hi = stepPid(sst.ovMinFlow.cfg, sst.ovMinFlow.st, total, dt_s);
    if (hi > co) { co = hi; selected = 'MIN-FLOW'; }
  }

  // Integral tracking on everyone who did not win.
  if (selected !== 'CURRENT' && o.current.enabled) preload(sst.ovCurrent.st, co);
  if (selected !== 'MAX-P' && o.maxPressure.enabled) preload(sst.ovMaxP.st, co);
  if (selected !== 'MIN-FLOW' && o.minFlow.enabled) preload(sst.ovMinFlow.st, co);

  const changed = selected !== sst.lastSelected;
  sst.lastSelected = selected;
  o.selected = selected;
  return { co_pct: co, selected, changed };
}

/**
 * Run the inner loop of a cascade.
 *
 * The master's output is not a valve position: it is a SETPOINT for the slave, scaled onto the
 * slave's engineering range. That is the whole trick, and the reason a cascade linearises a
 * nonlinear final element — the slave takes responsibility for actually achieving the flow the
 * master asked for, whatever the pump curve is doing.
 *
 * The two rules a cascade must obey are both here: the inner loop has to be several times faster
 * than the outer one or the pair will fight, and the master must be prevented from winding up
 * while the slave is saturated. The second is what `masterTracking` is for.
 *
 * @param {object} cfg strategy config
 * @param {object} sst strategy state (mutated)
 * @param {number} master_pct the master controller's output
 * @param {number} plantFlow_m3h the inner loop's measurement
 * @param {number} dt_s scan period, s
 * @returns {{co_pct:number, sp_m3h:number, slaveSaturated:boolean}} the slave's output, the
 *   setpoint it was given, and whether it is up against a limit
 */
export function stepCascade(cfg, sst, master_pct, plantFlow_m3h, dt_s) {
  const c = cfg.cascade;
  const sp = c.spLo_m3h + (c.spHi_m3h - c.spLo_m3h) * clamp(master_pct, 0, 100) / 100;
  sst.slave.st.spTarget = sp;
  sst.slave.st.mode = MODE.CASCADE;
  const co = stepPid(sst.slave.cfg, sst.slave.st, plantFlow_m3h, dt_s);
  return { co_pct: co, sp_m3h: sp, slaveSaturated: sst.slave.st.saturated };
}

/**
 * The master output that corresponds to a slave setpoint — used to keep a master from winding up
 * while its slave is limited, and to transfer bumplessly into and out of cascade.
 * @param {object} cfg strategy config
 * @param {number} sp_m3h the slave setpoint
 * @returns {number} the equivalent master output, percent
 */
export function masterTracking(cfg, sp_m3h) {
  const c = cfg.cascade;
  const span = c.spHi_m3h - c.spLo_m3h;
  return span !== 0 ? clamp(((sp_m3h - c.spLo_m3h) / span) * 100, 0, 100) : 0;
}

/**
 * Put every controller the strategy owns back to a known state.
 * @param {object} sst strategy state (mutated)
 * @param {number} co the output everything should be preloaded to
 * @returns {void}
 */
export function resetStrategy(sst, co) {
  resetPid(sst.slave.st, sst.slave.st.spTarget, co);
  resetPid(sst.ovCurrent.st, sst.ovCurrent.st.spTarget, co);
  resetPid(sst.ovMinFlow.st, sst.ovMinFlow.st.spTarget, co);
  resetPid(sst.ovMaxP.st, sst.ovMaxP.st.spTarget, co);
  sst.ffLead = 0;
  sst.ffLag = co;
  sst.lastSelected = 'PRIMARY';
}
