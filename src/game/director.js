/**
 * src/game/director.js — what goes wrong, when it goes wrong, and how long before it does the
 * operator is told.
 *
 * Layer: game. Imports `core/util.js` for `clamp` and nothing else. No DOM, no `Date.now`, no
 * `Math.random` — time arrives as `dt_s` and randomness arrives as an injected function, because a
 * daily run has to be reproducible from its seed code and a unit test has to be able to run this
 * in Node with no plant of its own.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A TELEGRAPH
 *
 * A pressure loop on a rig this size settles in half a minute. Watched raw, that is not a game:
 * the upset lands, the operator reacts to something that has already happened, and the trace
 * tells them thirty seconds later whether the reaction was any good. Every decision is made with
 * no information and graded far too late to learn from.
 *
 * Announcing the upset BEFORE it lands inverts that. "T-8s DEMAND SURGE" is a question with a
 * deadline: stage the lag pump now or ride it out on one machine, nudge the setpoint up into the
 * band or trust the reset, arm the feedforward or leave it. The answer is committed before the
 * evidence arrives and settled a few seconds later, on the trace, where it can be seen. That is
 * the entire loop this file exists to serve, and it is why the timing below is fussed over.
 *
 * THREE PROMISES THE TIMING MAKES
 *
 *   1. An upset with a 10 s telegraph becomes visible on the ticker when it is 10 s out. Not 9.8,
 *      not when the next frame happens to land. The countdown an operator reads has to be the
 *      countdown they get.
 *   2. It fires ONCE, at its scheduled time, and never late because a frame was long. Time
 *      compression, a backgrounded tab and a slow machine all produce long frames; every event
 *      whose moment fell inside the step fires inside that step, in scheduled order. A director
 *      that silently skipped an upset because the tab was hidden would be scoring a run that
 *      never happened.
 *   3. Everything it does is reversible. `revertAll` has to leave the rig somewhere a fresh run
 *      can start from, or the second mission of a session is played on the wreckage of the first.
 *      That is why every `apply` returns the values it overwrote instead of the upset table
 *      holding state of its own: the table is frozen and shared, the restore record is not.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/**
 * How close to its scheduled moment an event counts as due, s.
 *
 * Elapsed time is accumulated by repeated addition, so after fifty 0.2 s scans `t_s` is
 * 10.000000000000002 and after some other run of steps it is 9.999999999999998. Without a
 * tolerance the second case fires a whole scan late and the countdown visibly reads "T-0" for two
 * frames. A microsecond is far below anything the plant or the player can resolve.
 */
const DUE_EPS_S = 1e-6;

/**
 * The shortest telegraph endless mode will ever issue, s.
 *
 * Below about three seconds the ticker stops being a decision and becomes a reflex test: at one
 * scan per 0.2 s there is no longer time to read the label, decide, and move a control before the
 * upset lands. Escalation makes the warning shorter until it reaches this floor and then makes
 * the upsets bigger instead, which stays hard without becoming unreadable.
 */
export const TELEGRAPH_FLOOR_S = 3;

/** Default ticker length, s. Caps how far ahead `upcoming` will look when nobody says. */
const DEFAULT_HORIZON_S = 30;

/** Quiet seconds between the last upset of an endless wave and the first of the next. */
const WAVE_GAP_S = 16;

/** Most waves the director will schedule ahead in one step, so a huge `dt_s` cannot run away. */
const MAX_WAVES_PER_STEP = 4;

/**
 * Call a sim action by name, tolerating a surface that does not have it.
 *
 * The director is handed the sim module rather than importing it, so that a test can drive it
 * with a stub and so that nothing in `src/game` depends on the action list staying still. A
 * missing action is a refusal, not a crash: an upset that cannot be applied must not take the
 * shift down with it.
 *
 * @param {object} sim the sim action surface, functions of `(ctx, ...args)`
 * @param {string} name the action to call
 * @param {object} ctx the sim context
 * @param {...*} args the action's own arguments
 * @returns {{ok:boolean, reason?:string}} the action's result, or a refusal
 */
function act(sim, name, ctx, ...args) {
  const fn = sim && typeof sim[name] === 'function' ? sim[name] : null;
  if (!fn) return { ok: false, reason: `the simulator does not expose the ${name} action` };
  const r = fn(ctx, ...args);
  return r && typeof r === 'object' ? r : { ok: true };
}

/**
 * Coerce an upset magnitude to the 0..1 knob the table is written against.
 * @param {number} mag the requested magnitude
 * @returns {number} the magnitude, clamped, with a non-finite value treated as mid-scale
 */
function mag01(mag) {
  if (!Number.isFinite(mag)) return 0.5;
  return clamp(Math.abs(mag), 0, 1);
}

/**
 * Engineering-unit metadata for the loop, or a usable stand-in if the sim will not say.
 * @param {object} ctx the sim context
 * @param {object} sim the sim action surface
 * @returns {{lo:number, hi:number, unit:string, dp:number}} the loop's units
 */
function euOf(ctx, sim) {
  if (sim && typeof sim.loopEU === 'function') {
    const eu = sim.loopEU(ctx);
    if (eu && Number.isFinite(eu.lo) && Number.isFinite(eu.hi)) return eu;
  }
  return { lo: 0, hi: 8, unit: 'bar', dp: 2 };
}

/**
 * The index of a machine worth taking away: one that is actually turning, preferring the last of
 * them so that losing it on a staged set is a real hole rather than a formality.
 * @param {object} ctx the sim context
 * @returns {number} the pump index, or -1 if nothing is running
 */
function runningPump(ctx) {
  const drv = ctx && ctx.plant ? ctx.plant.drv : null;
  if (!Array.isArray(drv)) return -1;
  for (let i = drv.length - 1; i >= 0; i -= 1) {
    if (drv[i] && drv[i].state !== 'TRIPPED' && drv[i].n_pct > 5) return i;
  }
  return -1;
}

/**
 * Move a valve-position ramp along by one step.
 * @param {object} r the restore record carrying `from`, `to`, `ramp_s` and `done_s`
 * @param {number} dt_s the step, s
 * @returns {number} the value the ramp is at now
 */
function rampValue(r, dt_s) {
  r.done_s = Math.min(r.ramp_s, r.done_s + Math.max(0, dt_s));
  const f = r.ramp_s > 0 ? r.done_s / r.ramp_s : 1;
  return r.from + (r.to - r.from) * f;
}

/**
 * The upset table.
 *
 * Each record is:
 *
 *   id            the key, repeated, so a record carries its own name once detached from the map
 *   label         what the ticker shows, upper case because the ticker is
 *   glyph         one character, drawn beside the label
 *   telegraph_s   how long before it lands the ticker starts counting it down
 *   severity      1 (a nuisance) .. 5 (the shift is now about survival). Endless mode gates its
 *                 pool on this, and the scorecard weights by it.
 *   describe(mag) one sentence, from the magnitude alone — the brief has to be printable before
 *                 the upset has a plant to look at
 *   apply(ctx, sim, mag)      -> a restore record, or null if nothing was changed
 *   revert(ctx, sim, restore) -> undoes exactly what `apply` did
 *   hold(ctx, sim, dt_s, restore, rng) -> optional; for upsets that develop rather than step
 *
 * Everything here goes through an exported sim action or writes a plant field the sim's own
 * disturbance surface already writes. Nothing reaches into the controller, the sequence or the
 * instruments' internals: an upset is something that happens TO the rig, and if it could reach
 * into the control system the player would be scored on a fight they were never shown.
 */
export const UPSETS = Object.freeze({

  DEMAND_SURGE: Object.freeze({
    id: 'DEMAND_SURGE',
    label: 'DEMAND SURGE',
    glyph: '▲',
    telegraph_s: 8,
    severity: 2,
    describe(mag) {
      return `the downstream plant opens up — the demand valve takes another `
        + `${((0.10 + 0.32 * mag01(mag)) * 100).toFixed(0)}% of travel`;
    },
    apply(ctx, sim, mag) {
      const prev = ctx.plant.demandTarget;
      act(sim, 'setDisturbance', ctx, {
        demandTarget: clamp(prev + 0.10 + 0.32 * mag01(mag), 0, 1),
      });
      return { demandTarget: prev };
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { demandTarget: r.demandTarget });
    },
  }),

  DEMAND_COLLAPSE: Object.freeze({
    id: 'DEMAND_COLLAPSE',
    label: 'DEMAND COLLAPSE',
    glyph: '▼',
    telegraph_s: 7,
    severity: 2,
    describe(mag) {
      return `the downstream plant shuts down — the demand valve gives back `
        + `${((0.12 + 0.30 * mag01(mag)) * 100).toFixed(0)}% of travel`;
    },
    apply(ctx, sim, mag) {
      const prev = ctx.plant.demandTarget;
      act(sim, 'setDisturbance', ctx, {
        demandTarget: clamp(prev - (0.12 + 0.30 * mag01(mag)), 0, 1),
      });
      return { demandTarget: prev };
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { demandTarget: r.demandTarget });
    },
  }),

  DEMAND_RAMP: Object.freeze({
    id: 'DEMAND_RAMP',
    label: 'DEMAND RAMP',
    glyph: '◢',
    telegraph_s: 10,
    severity: 1,
    describe(mag) {
      return `demand walks up over about ${(90 - 45 * mag01(mag)).toFixed(0)} s — slow enough `
        + 'that reset does the work and fast enough to find a loop that has none';
    },
    apply(ctx, sim, mag) {
      const m = mag01(mag);
      const from = ctx.plant.demandTarget;
      return {
        demandTarget: from,
        from,
        to: clamp(from + 0.14 + 0.30 * m, 0, 1),
        ramp_s: 90 - 45 * m,
        done_s: 0,
      };
    },
    hold(ctx, sim, dt_s, r) {
      if (r.done_s >= r.ramp_s) return;
      act(sim, 'setDisturbance', ctx, { demandTarget: rampValue(r, dt_s) });
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { demandTarget: r.demandTarget });
    },
  }),

  VALVE_SLAM: Object.freeze({
    id: 'VALVE_SLAM',
    label: 'VALVE SLAM',
    glyph: '⌁',
    telegraph_s: 5,
    severity: 4,
    describe(mag) {
      return `the demand valve shuts in a second, dumping `
        + `${((0.55 + 0.40 * mag01(mag)) * 100).toFixed(0)}% of the load into the header`;
    },
    apply(ctx, sim, mag) {
      const p = ctx.plant;
      const prev = {
        demandTarget: p.demandTarget,
        strokeTime_s: p.valveOverride.fcv.strokeTime_s,
      };
      // Closure time is the whole difference between a pressure transient and a water hammer, so
      // it is a property of the upset rather than of the valve — the same as the scripted tests
      // in `control/scenario.js` treat it.
      act(sim, 'setDisturbance', ctx, {
        valveOverride: { fcv: { strokeTime_s: 1.0 } },
        demandTarget: clamp(p.demandTarget * (1 - (0.55 + 0.40 * mag01(mag))), 0, 1),
      });
      return prev;
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, {
        valveOverride: { fcv: { strokeTime_s: r.strokeTime_s } },
        demandTarget: r.demandTarget,
      });
    },
  }),

  LEVEL_SWING: Object.freeze({
    id: 'LEVEL_SWING',
    label: 'SUCTION LEVEL',
    glyph: '▄',
    telegraph_s: 9,
    severity: 3,
    describe(mag) {
      return `make-up is isolated and the suction tank drops about `
        + `${(0.35 + 0.75 * mag01(mag)).toFixed(2)} m — watch NPSH margin, not the setpoint`;
    },
    apply(ctx, sim, mag) {
      const p = ctx.plant;
      const prev = { level_m: p.level_m, makeupAuto: p.makeupAuto };
      act(sim, 'setDisturbance', ctx, {
        makeupAuto: false,
        level_m: p.level_m - (0.35 + 0.75 * mag01(mag)),
      });
      return prev;
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { level_m: r.level_m, makeupAuto: r.makeupAuto });
    },
  }),

  FLUID_CHANGE: Object.freeze({
    id: 'FLUID_CHANGE',
    label: 'WRONG LIQUID',
    glyph: '◍',
    telegraph_s: 12,
    severity: 4,
    describe(mag) {
      return mag01(mag) > 0.55
        ? 'the rig is filled with VG 150 gear oil — head, flow and efficiency all derate together'
        : 'the rig is filled with VG 32 oil — a mild viscous derate the tuning will still notice';
    },
    apply(ctx, sim, mag) {
      const prev = ctx.plant.fluidId;
      act(sim, 'setDisturbance', ctx, { fluidId: mag01(mag) > 0.55 ? 'VG150' : 'VG32' });
      return { fluidId: prev };
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { fluidId: r.fluidId });
    },
  }),

  FOULING: Object.freeze({
    id: 'FOULING',
    label: 'STRAINER FOULING',
    glyph: '▨',
    telegraph_s: 10,
    severity: 2,
    describe(mag) {
      return `the suction strainer blinds to about `
        + `${((0.35 + 0.45 * mag01(mag)) * 100).toFixed(0)}% over the next couple of minutes`;
    },
    apply(ctx, sim, mag) {
      const m = mag01(mag);
      const from = ctx.plant.foul;
      return {
        foul: from,
        from,
        to: clamp(from + 0.35 + 0.45 * m, 0, 0.95),
        ramp_s: 150 - 60 * m,
        done_s: 0,
      };
    },
    hold(ctx, sim, dt_s, r) {
      if (r.done_s >= r.ramp_s) return;
      act(sim, 'setDisturbance', ctx, { foul: rampValue(r, dt_s) });
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { foul: r.foul });
    },
  }),

  STICTION: Object.freeze({
    id: 'STICTION',
    label: 'VALVE STICTION',
    glyph: '⚙',
    telegraph_s: 8,
    severity: 3,
    describe(mag) {
      return `friction appears in the final element — a stickband of about `
        + `${(1.2 + 4.3 * mag01(mag)).toFixed(1)}%, and the cycle it starts is not a tuning problem`;
    },
    apply(ctx, sim, mag) {
      const p = ctx.plant;
      // Whichever element the controller is actually modulating: putting friction in the valve
      // the loop is not moving would be a disturbance the player could never see.
      const which = p.finalElement === 'THROTTLE' ? 'pcv' : 'fcv';
      const prev = {
        which,
        stickband: p.valveOverride[which].stickband,
        slipJump: p.valveOverride[which].slipJump,
      };
      const sb = (1.2 + 4.3 * mag01(mag)) / 100;
      act(sim, 'setDisturbance', ctx, {
        valveOverride: { [which]: { stickband: sb, slipJump: sb * 0.5 } },
      });
      return prev;
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, {
        valveOverride: { [r.which]: { stickband: r.stickband, slipJump: r.slipJump } },
      });
    },
  }),

  NOISE: Object.freeze({
    id: 'NOISE',
    label: 'TRANSMITTER NOISE',
    glyph: '∿',
    telegraph_s: 6,
    severity: 1,
    describe(mag) {
      return `the transmitter starts picking up about `
        + `${((0.004 + 0.016 * mag01(mag)) * 100).toFixed(1)}% of span in electrical noise — `
        + 'derivative on a signal like this is a machine-wrecking amplifier';
    },
    apply(ctx, sim, mag) {
      return { amp: 0.004 + 0.016 * mag01(mag) };
    },
    // Noise is the one upset with nothing to set and everything to keep doing, so it lives
    // entirely in `hold`. It is added to the transmitter reading rather than to the process,
    // because that is what an earthing fault does: the header pressure is fine and the number the
    // controller is given is not.
    hold(ctx, sim, dt_s, r, rng) {
      if (typeof rng !== 'function') return;
      const p = ctx.plant;
      const ins = ctx.config.instruments;
      // Three uniforms summed is a serviceable bell without a Box-Muller's square root and log,
      // and this runs every scan.
      const g = (rng() + rng() + rng() - 1.5) * 2;
      if (ctx.run.mode === 'FLOW') {
        const span = ins.ft.hi_m3h - ins.ft.lo_m3h;
        p.ft_m3h = clamp(p.ft_m3h + r.amp * span * g, ins.ft.lo_m3h, ins.ft.hi_m3h);
      } else {
        const span = ins.pt.hi_bar - ins.pt.lo_bar;
        p.pt_bar = clamp(p.pt_bar + r.amp * span * g, ins.pt.lo_bar, ins.pt.hi_bar);
      }
    },
    revert() {
      // Nothing to undo: the instrument's own filter walks the reading back to the truth within a
      // second of the injection stopping, and the injection stops when this upset leaves `active`.
    },
  }),

  SCAN_SLOW: Object.freeze({
    id: 'SCAN_SLOW',
    label: 'SCAN OVERRUN',
    glyph: '⏱',
    telegraph_s: 8,
    severity: 2,
    describe(mag) {
      return `the PLC picks up load and the loop's scan stretches by about `
        + `${(0.35 + 1.4 * mag01(mag)).toFixed(2)} s — every bit of it is dead time`;
    },
    apply(ctx, sim, mag) {
      const prev = ctx.config.scan_s;
      const r = act(sim, 'setScan', ctx, clamp(prev + 0.35 + 1.4 * mag01(mag), prev, 5));
      return { scan_s: prev, applied: r.ok !== false };
    },
    revert(ctx, sim, r) {
      if (r.applied) act(sim, 'setScan', ctx, r.scan_s);
    },
  }),

  PUMP_TRIP: Object.freeze({
    id: 'PUMP_TRIP',
    label: 'PUMP TRIP',
    glyph: '⚡',
    telegraph_s: 6,
    severity: 5,
    describe() {
      return 'a running machine trips on overload — the sequence has to promote the standby and '
        + 'the loop has to survive the hole in the middle';
    },
    apply(ctx, sim) {
      const i = runningPump(ctx);
      if (i < 0) return { i: -1 };
      const hand = ctx.staging && Array.isArray(ctx.staging.hand) ? ctx.staging.hand[i] : 'AUTO';
      act(sim, 'forceTrip', ctx, i);
      return { i, hand };
    },
    revert(ctx, sim, r) {
      if (r.i < 0) return;
      // The overload will refuse while its bimetal is still hot, which is correct behaviour and
      // not a failure of the revert — the machine stays locked out and the next run's sequence
      // stages around it, exactly as it would on the rig.
      act(sim, 'resetPump', ctx, r.i);
      if (r.hand === 'HAND') act(sim, 'startPump', ctx, r.i);
      else if (r.hand === 'OFF') act(sim, 'stopPump', ctx, r.i);
      else act(sim, 'autoPump', ctx, r.i);
    },
  }),

  SUPPLY_SAG: Object.freeze({
    id: 'SUPPLY_SAG',
    label: 'SUPPLY SAG',
    glyph: '↧',
    telegraph_s: 9,
    severity: 4,
    describe(mag) {
      return `the pressure over the suction tank sags about `
        + `${(0.08 + 0.22 * mag01(mag)).toFixed(2)} bar — that is metres straight off NPSH `
        + 'available before anything else has gone wrong';
    },
    apply(ctx, sim, mag) {
      const prev = ctx.plant.pAtm_bar;
      act(sim, 'setDisturbance', ctx, { pAtm_bar: prev - (0.08 + 0.22 * mag01(mag)) });
      return { pAtm_bar: prev };
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { pAtm_bar: r.pAtm_bar });
    },
  }),

  BACKPRESSURE: Object.freeze({
    id: 'BACKPRESSURE',
    label: 'BACKPRESSURE',
    glyph: '↥',
    telegraph_s: 9,
    severity: 2,
    describe(mag) {
      return `the receiving vessel fills and the discharge static head rises about `
        + `${(4 + 12 * mag01(mag)).toFixed(0)} m`;
    },
    apply(ctx, sim, mag) {
      const prev = ctx.plant.hDischarge_m;
      act(sim, 'setDisturbance', ctx, { hDischarge_m: prev + 4 + 12 * mag01(mag) });
      return { hDischarge_m: prev };
    },
    revert(ctx, sim, r) {
      act(sim, 'setDisturbance', ctx, { hDischarge_m: r.hDischarge_m });
    },
  }),

  SP_CHANGE: Object.freeze({
    id: 'SP_CHANGE',
    label: 'NEW SETPOINT',
    glyph: '✎',
    telegraph_s: 10,
    severity: 1,
    describe(mag) {
      return `the shift supervisor wants the header ${mag < 0 ? 'lower' : 'higher'} — about `
        + `${((0.06 + 0.10 * mag01(mag)) * 100).toFixed(0)}% of span, and the servo response is `
        + 'a different question from the regulation one';
    },
    apply(ctx, sim, mag) {
      const eu = euOf(ctx, sim);
      const span = eu.hi - eu.lo;
      const dir = mag < 0 ? -1 : 1;
      const prev = ctx.pid.spTarget;
      // Kept well inside the transmitter range: a setpoint the rig cannot reach is not a servo
      // test, it is a saturated output and a scorecard nobody can read.
      const target = clamp(
        prev + dir * (0.06 + 0.10 * mag01(mag)) * span,
        eu.lo + 0.15 * span,
        eu.lo + 0.75 * span,
      );
      const r = act(sim, 'setSetpoint', ctx, target);
      return { sp: prev, applied: r.ok !== false };
    },
    revert(ctx, sim, r) {
      if (r.applied) act(sim, 'setSetpoint', ctx, r.sp);
    },
  }),

});

/** The upset ids, in table order. Handy for pickers and for the endless pool. */
const UPSET_IDS = Object.freeze(Object.keys(UPSETS));

/**
 * Build a director.
 *
 * @param {object} [opts] options
 * @param {Array<object>} [opts.script] scheduled upsets, `{at_s, upset, mag, label, telegraph_s}`
 * @param {function():number} [opts.rng] seeded PRNG, required for endless mode
 * @param {boolean} [opts.endless] compose escalating waves instead of running a fixed script
 * @param {number} [opts.intensity] multiplies every magnitude; 1 is as written
 * @param {number} [opts.horizon_s] how far ahead the ticker will look, s
 * @returns {object} the director state
 */
export function createDirector(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const dir = {
    /** Elapsed director time, s. Advanced only by {@link stepDirector}. */
    t_s: 0,
    /** The seeded PRNG, or null. */
    rng: typeof o.rng === 'function' ? o.rng : null,
    /** True when waves are composed rather than scripted. */
    endless: !!o.endless,
    /** Magnitude multiplier applied at schedule time, so the ticker shows what will fire. */
    intensity: Number.isFinite(o.intensity) && o.intensity > 0 ? o.intensity : 1,
    /** Ticker length, s. */
    horizon_s: Number.isFinite(o.horizon_s) && o.horizon_s > 0 ? o.horizon_s : DEFAULT_HORIZON_S,
    /** Pending events, ascending by `at_s`. Fired events are removed. */
    queue: [],
    /** Applied and not yet reverted, in the order they landed. */
    active: [],
    /** Endless wave number; 0 until the first is composed. */
    wave: 0,
    /** Director time the next endless wave starts, s. */
    nextWave_s: 0,
    /** Event id counter, so two upsets at the same second still order deterministically. */
    seq: 0,
    /** What fired and when, for the debrief. */
    log: [],
    /** Script entries that could not be scheduled, named rather than thrown. */
    problems: [],
  };
  schedule(dir, o.script, 0);
  // Endless mode composes its first wave up front rather than on the first step, so the ticker is
  // already populated on the frame the player is handed the rig.
  if (dir.endless && dir.rng) pushWave(dir);
  return dir;
}

/**
 * Put a list of event records on the queue, resolving their upsets and applying the intensity.
 * @param {object} dir the director state (mutated)
 * @param {Array<object>} list event records
 * @param {number} offset_s seconds added to every `at_s`
 * @returns {void}
 */
function schedule(dir, list, offset_s) {
  if (!Array.isArray(list)) return;
  for (const e of list) {
    if (!e || typeof e !== 'object') { dir.problems.push('an event record that is not an object'); continue; }
    const def = UPSETS[e.upset];
    if (!def) { dir.problems.push(`unknown upset ${String(e.upset)}`); continue; }
    const at_s = (Number.isFinite(e.at_s) ? Math.max(0, e.at_s) : 0) + offset_s;
    const tel = Number.isFinite(e.telegraph_s)
      ? clamp(e.telegraph_s, 0, 300)
      : def.telegraph_s;
    const raw = Number.isFinite(e.mag) ? e.mag : 0.5;
    // Intensity scales how hard, never which way: a setpoint order that was downward stays
    // downward however hot the wave has got.
    const mag = (raw < 0 ? -1 : 1) * clamp(Math.abs(raw) * dir.intensity, 0, 1);
    dir.seq += 1;
    dir.queue.push({
      eid: dir.seq,
      upset: def.id,
      at_s,
      telegraph_s: tel,
      mag,
      label: typeof e.label === 'string' && e.label ? e.label : def.label,
      armed: false,
      fired: false,
    });
  }
  dir.queue.sort((a, b) => (a.at_s - b.at_s) || (a.eid - b.eid));
}

/**
 * The public shape of a queued event.
 * @param {object} e the queue entry
 * @param {number} in_s seconds until it lands
 * @returns {object} a ticker ticket
 */
function ticket(e, in_s) {
  const def = UPSETS[e.upset];
  return {
    id: e.upset,
    label: e.label,
    glyph: def.glyph,
    in_s,
    severity: def.severity,
    mag: e.mag,
    at_s: e.at_s,
    telegraph_s: e.telegraph_s,
  };
}

/**
 * Compose and queue the next endless wave.
 * @param {object} dir the director state (mutated)
 * @returns {void}
 */
function pushWave(dir) {
  dir.wave += 1;
  const evs = endlessWave(dir.rng, dir.wave);
  const base = dir.nextWave_s;
  schedule(dir, evs, base);
  let last = 0;
  for (const e of evs) if (e.at_s > last) last = e.at_s;
  dir.nextWave_s = base + last + WAVE_GAP_S;
}

/**
 * Advance the director: arm what is now within its telegraph, fire what is due, and let the
 * upsets that develop over time develop.
 *
 * @param {object} dir the director state (mutated)
 * @param {object} ctx the sim context
 * @param {object} sim the sim action surface
 * @param {number} dt_s elapsed simulated time since the last call, s
 * @returns {{ok:boolean, reason?:string, fired:object[], armed:object[]}} what changed this step
 */
export function stepDirector(dir, ctx, sim, dt_s) {
  const fired = [];
  const armed = [];
  if (!dir || !Array.isArray(dir.queue)) {
    return { ok: false, reason: 'the director has no state to advance', fired, armed };
  }
  if (!ctx || !ctx.plant || !sim) {
    return { ok: false, reason: 'the director needs a running sim context and its action surface', fired, armed };
  }
  if (!Number.isFinite(dt_s) || dt_s < 0) {
    return { ok: false, reason: 'time cannot run backwards or by an unknown amount', fired, armed };
  }

  dir.t_s += dt_s;

  // Endless mode keeps the queue stocked far enough ahead that the ticker is never empty for want
  // of a wave. Capped, so one enormous step cannot compose the rest of the shift in a loop.
  if (dir.endless && dir.rng) {
    for (let k = 0; k < MAX_WAVES_PER_STEP; k += 1) {
      if (dir.nextWave_s > dir.t_s + dir.horizon_s + WAVE_GAP_S) break;
      pushWave(dir);
    }
  }

  for (const e of dir.queue) {
    if (e.armed) continue;
    if (e.at_s - e.telegraph_s <= dir.t_s + DUE_EPS_S) {
      e.armed = true;
      armed.push(ticket(e, Math.max(0, e.at_s - dir.t_s)));
    }
  }

  // The queue is sorted, so everything due is at the front and `break` is safe. Firing all of it
  // — rather than one per step — is what keeps a long frame from swallowing an upset.
  let due = 0;
  for (const e of dir.queue) {
    if (e.at_s > dir.t_s + DUE_EPS_S) break;
    due += 1;
  }
  if (due > 0) {
    const going = dir.queue.splice(0, due);
    for (const e of going) {
      e.fired = true;
      e.armed = true;
      const def = UPSETS[e.upset];
      let restore = null;
      try {
        restore = def.apply(ctx, sim, e.mag) || null;
      } catch (err) {
        // An upset that cannot land is a missing disturbance, not a failed shift. It is recorded
        // so a mission author sees it, and the run continues.
        dir.problems.push(`${e.upset} could not be applied: ${err && err.message ? err.message : err}`);
        restore = null;
      }
      if (restore) dir.active.push({ eid: e.eid, upset: e.upset, restore, at_s: e.at_s });
      const t = ticket(e, 0);
      t.describe = def.describe(e.mag);
      dir.log.push({ t_s: dir.t_s, upset: e.upset, label: e.label, mag: e.mag });
      fired.push(t);
    }
  }

  for (const a of dir.active) {
    const def = UPSETS[a.upset];
    if (typeof def.hold !== 'function') continue;
    try {
      def.hold(ctx, sim, dt_s, a.restore, dir.rng);
    } catch (err) {
      dir.problems.push(`${a.upset} failed while running: ${err && err.message ? err.message : err}`);
    }
  }

  return { ok: true, fired, armed };
}

/**
 * What the ticker should be showing: every armed, unfired upset inside its own telegraph window
 * and inside the horizon, soonest first.
 *
 * @param {object} dir the director state
 * @param {number} [horizon_s] how far ahead to look, s; defaults to the director's own horizon
 * @returns {object[]} tickets, each with `in_s` counting down to zero
 */
export function upcoming(dir, horizon_s) {
  if (!dir || !Array.isArray(dir.queue)) return [];
  const h = Number.isFinite(horizon_s) && horizon_s > 0 ? horizon_s : dir.horizon_s;
  const out = [];
  for (const e of dir.queue) {
    const in_s = e.at_s - dir.t_s;
    if (in_s < -DUE_EPS_S) continue;
    // Two separate gates, and they mean different things. The telegraph is the upset's own
    // promise about how much warning it gives; the horizon is how much of the future this ticker
    // has room to draw. An upset is only news once BOTH allow it.
    if (in_s > e.telegraph_s + DUE_EPS_S) continue;
    if (in_s > h + DUE_EPS_S) continue;
    out.push(ticket(e, Math.max(0, in_s)));
  }
  return out;
}

/**
 * Compose one endless wave.
 *
 * Escalation moves three dials at once and each is bounded, because an unbounded one stops being
 * difficulty and becomes noise:
 *
 *   how many   2 at wave 1, one more every second wave, capped at 8 — past that the upsets
 *              overlap so heavily that nothing is attributable to anything
 *   how big    magnitude climbs from about a quarter scale toward full, with jitter so two waves
 *              of the same number never feel identical
 *   how much   the telegraph shortens by about half a second a wave down to
 *   warning    {@link TELEGRAPH_FLOOR_S}, and then stops
 *
 * The severity gate is the fourth: wave 1 draws only from the nuisances, and the machine-losing
 * upsets are not in the pool until the player has survived long enough to have earned them.
 *
 * @param {function():number} rng a seeded PRNG returning [0,1)
 * @param {number} wave the wave number, 1-based
 * @returns {Array<{at_s:number, upset:string, mag:number, telegraph_s:number}>} the wave
 */
export function endlessWave(rng, wave) {
  if (typeof rng !== 'function') return [];
  const w = Number.isFinite(wave) && wave >= 1 ? Math.floor(wave) : 1;
  const n = Math.min(8, 2 + Math.floor((w - 1) / 2));
  const cap = clamp(2 + Math.floor((w - 1) / 2), 2, 5);
  const pool = UPSET_IDS.filter((id) => UPSETS[id].severity <= cap);
  const magBase = clamp(0.25 + 0.06 * (w - 1), 0, 1);
  const gap_s = Math.max(9, 26 - 1.4 * (w - 1));
  const lead_s = Math.max(6, 14 - 0.7 * (w - 1));

  const out = [];
  for (let i = 0; i < n; i += 1) {
    const def = UPSETS[pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]];
    const mag = clamp(magBase + (rng() - 0.5) * 0.24, 0.05, 1);
    // A setpoint order is the one upset with a direction, and it is worth being able to go down.
    const signed = def.id === 'SP_CHANGE' && rng() < 0.5 ? -mag : mag;
    out.push({
      at_s: lead_s + i * gap_s + rng() * 0.4 * gap_s,
      upset: def.id,
      mag: signed,
      telegraph_s: Math.max(TELEGRAPH_FLOOR_S, def.telegraph_s - 0.55 * (w - 1)),
    });
  }
  out.sort((a, b) => a.at_s - b.at_s);
  return out;
}

/**
 * Undo every upset that has landed, newest first, and leave the rig somewhere a fresh run can
 * start from.
 *
 * Newest first is not cosmetic. Two upsets can touch the same field — a surge followed by a
 * collapse both write the demand valve — and each `apply` recorded what it personally overwrote.
 * Unwinding in reverse order therefore lands back on the value the first of them found; unwinding
 * forwards would leave the second one's overwrite in place.
 *
 * @param {object} dir the director state (mutated)
 * @param {object} ctx the sim context
 * @param {object} sim the sim action surface
 * @returns {void}
 */
export function revertAll(dir, ctx, sim) {
  if (!dir || !Array.isArray(dir.active)) return;
  if (!ctx || !ctx.plant || !sim) { dir.active.length = 0; return; }
  for (let i = dir.active.length - 1; i >= 0; i -= 1) {
    const a = dir.active[i];
    const def = UPSETS[a.upset];
    if (!def || typeof def.revert !== 'function') continue;
    try {
      def.revert(ctx, sim, a.restore);
    } catch (err) {
      // A revert that throws must not strand the remaining ones: the whole point of this call is
      // that the next run starts clean, and stopping half way through guarantees it will not.
      dir.problems.push(`${a.upset} could not be reverted: ${err && err.message ? err.message : err}`);
    }
  }
  dir.active.length = 0;
}
