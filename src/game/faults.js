/**
 * src/game/faults.js — the fault library and the diagnosis grading behind Fault Hunt.
 *
 * Layer L4 (game): imports `core/util.js`, `data/config.js`, `process/plant.js` and `game/rng.js`.
 * No DOM, no `window`, no `Date.now`, no `Math.random` — every fault advances on the `dt_s` it is
 * handed and every choice it makes comes from the injected generator, because a Fault Hunt round
 * has to replay identically from its seed code.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT A FAULT IS ALLOWED TO BE
 *
 * A fault here is not a number written on the display. Every one of these reaches the operator by
 * the same route the real thing would: a transmitter that is genuinely reading wrong, a stem with
 * genuine friction in its packing, an impeller with genuine wear-ring clearance, a strainer that
 * is genuinely blinded. The plant then does whatever the physics says, and the trend the player
 * reads is the honest consequence rather than a scripted picture of one.
 *
 * That constraint is what makes the mode worth playing. If the symptom were painted on, there
 * would be nothing to reason about: the only evidence would be the picture itself. Because the
 * fault is injected upstream, the second-order consequences come free and they are exactly the
 * ones an engineer uses — a worn impeller needs more speed for the same duty AND vibrates AND
 * loses efficiency, and a drifting transmitter holds the loop perfectly on a setpoint that is no
 * longer where the operator thinks it is.
 *
 * So faults act through the exported `sim` actions wherever an action exists — `setDisturbance`
 * already carries `wear`, `trim`, `foul`, `level_m` and `valveOverride`, which covers most of the
 * library — and through documented plant fields for the two things no action reaches: the motor
 * overload's thermal state, and the transmitter itself.
 *
 * ------------------------------------------------------------------------------------------
 * EVERY FAULT IS EXACTLY REVERSIBLE, AND NOT BY EACH FAULT BEHAVING ITSELF
 *
 * Fault Hunt runs round after round in one session. Whatever a fault changed — a plant field, a
 * tuning, an instrument, the controller's scan — clearing it has to put the rig back where it was
 * found, including after the fault has had a minute to develop. A fault that leaves anything
 * behind poisons every round that follows it, and the player experiences that as the simulator
 * slowly going wrong for no reason they can see: the hardest kind of bug to report and the
 * easiest to write.
 *
 * So no fault carries its own undo. Each one DECLARES what it disturbs, in `touches`;
 * `injectFault` photographs exactly those things before `apply` runs, and `clearFaults` puts the
 * photograph back. A fault cannot forget to restore something it never had to remember, a `step`
 * that starts writing somewhere new cannot silently escape the undo, and the restore path is one
 * table (`RESTORE`) that is read on every round rather than twenty hand-written inverses that are
 * each read once.
 *
 * ------------------------------------------------------------------------------------------
 * WHERE A SENSOR FAULT HAS TO BE INJECTED, AND WHY IT IS NOT THE OBVIOUS PLACE
 *
 * `plant.pt_bar` looks like the transmitter's output and is not: it is the STATE of a first-order
 * filter, written every tick as `pt_bar = lag(pt_bar, raw, filter_s, dt)`. A bias written into it
 * from outside is therefore an initial condition rather than a bias, and the plant washes it out
 * with a half-second half-life. A naive `pt_bar += 0.3` gives a decaying blip; topping the blip
 * up once per scan gives a sawtooth at scan rate, which the trend draws as a fur coat on the PV
 * pen. Neither of those is a transmitter fault.
 *
 * A real zero shift does not happen at the filter's output either. It happens at the SENSING
 * ELEMENT, upstream of the dead time and upstream of the filter, and everything downstream then
 * treats it as signal. So that is where it goes here: the bias is added to the samples sitting in
 * the transmitter's own transport-delay line, the last point in the chain before the filter. The
 * consequences then fall out correctly and for free — the fault arrives through the instrument's
 * dead time, the filter rolls off the noisy faults exactly as it rolls off real noise, and the
 * reading carries no artefact at any sample rate because nothing is fighting the filter.
 *
 * The one unlovely part is that the delay line lives on `plant._sig`, which is private. It is
 * flagged for promotion to a documented field; until then the injector checks the shape it
 * expects and does nothing whatever if it is not there, so a change in the plant shows up as a
 * sensor fault that has stopped working rather than as a corrupted signal.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { ACTION } from '../control/pid.js';
import { LOOP } from '../data/config.js';
import { FINAL } from '../process/plant.js';
import { rngShuffle } from './rng.js';

/** What kind of thing has gone wrong. The first question an engineer answers, and the hardest. */
export const CATEGORY = Object.freeze({
  /** The measurement is lying. The loop may be doing its job perfectly. */
  SENSOR: 'SENSOR',
  /** The controller's hands. It asks for travel and does not get it. */
  FINAL: 'FINAL',
  /** The machine itself: impeller, motor, strainer. */
  MACHINE: 'MACHINE',
  /** The process around the loop: suction, temperature, fluid, back pressure. */
  PROCESS: 'PROCESS',
  /** The controller's own configuration. Nothing is broken; something was typed wrong. */
  CONTROL: 'CONTROL',
});

/**
 * The grading constants, and the reasoning behind the one number that matters.
 *
 * A diagnosis is scored on being RIGHT first and QUICK second, and the whole scheme is built
 * around one hazard: a multiple-choice question rewards guessing unless a wrong answer costs
 * enough. With `choicesAssumed` options on screen, a player who buzzes in blind is right one time
 * in `choicesAssumed`, so the break-even penalty is
 *
 *     wrongPenalty = (base + speedBonus) / (choicesAssumed - 1)
 *
 * which at four choices and a 700-point best case is 233. `wrongPenalty` is set to that, so the
 * expected value of a blind guess is exactly zero and the only way to earn points is to read the
 * trend. A player who has genuinely narrowed it to two options still profits from answering,
 * which is the behaviour we want — eliminating options IS the skill.
 *
 * `grace_s` exists for the opposite reason. A pure decay from t=0 would pay most for answering
 * before the fault has had time to show itself, which rewards a coin flip dressed up as speed.
 * Twenty seconds is about the shortest interval in which a drift, a stuck stem or a rising
 * overload becomes legible on a trend, so nothing is lost by answering inside it and nothing is
 * gained by answering instantly.
 */
export const GRADE = Object.freeze({
  /** Points for being right, before any bonus. */
  base: 300,
  /** Points on top for being quick, at full value inside the grace window. */
  speedBonus: 400,
  /** Seconds during which the speed bonus is undiminished. */
  grace_s: 20,
  /** Seconds after the grace window in which the remaining speed bonus halves. */
  halfLife_s: 75,
  /** Cost of a wrong answer. See the derivation above. */
  wrongPenalty: 233,
  /** Number of options the penalty was balanced against. */
  choicesAssumed: 4,
  /** A correct answer never scores less than this, however many wrong guesses came first. */
  floor: 50,
});

/**
 * The transmitters a sensor fault can act on: the delay line whose samples the fault rewrites,
 * the filtered reading at the end of the chain, and the TRUE process value — a span error and a
 * frozen reading are both defined relative to the real quantity rather than to the reported one,
 * and putting the instrument back on the process at the end of a round needs the truth as well.
 */
const TX_CHANNELS = Object.freeze({
  pt: Object.freeze({
    tag: 'PT-101',
    delay: 'ptDelay',
    reading: 'pt_bar',
    /**
     * @param {object} p plant state
     * @returns {number} the true header pressure, bar
     */
    truth: (p) => p.p_bar,
  }),
  ft: Object.freeze({
    tag: 'FT-101',
    delay: 'ftDelay',
    reading: 'ft_m3h',
    /**
     * @param {object} p plant state
     * @returns {number} the true flow to process, m3/h
     */
    truth: (p) => p.Qdemand_m3h,
  }),
});

/**
 * A refusal in the house form.
 * @param {string} reason a sentence an operator could read
 * @returns {{ok:false, reason:string}} the refusal
 */
const fail = (reason) => ({ ok: false, reason });

/** @returns {{ok:true}} the acceptance */
const ok = () => ({ ok: true });

/**
 * Refuse anything that is not a usable sim context.
 * @param {object} ctx the sim context
 * @returns {boolean} true when the context has the parts a fault needs
 */
function usableCtx(ctx) {
  return !!(ctx && ctx.plant && ctx.run && ctx.config && ctx.pidCfg && ctx.plant.drv);
}

/**
 * The machine a single-machine fault should be put on: whichever one the sequence is leading
 * with, so the fault lands on a pump that is actually turning and the player has something to
 * read. Falls back to the first machine when the staging state is not there.
 * @param {object} ctx the sim context
 * @returns {number} a pump index
 */
function leadPump(ctx) {
  const lead = ctx.staging && Number.isInteger(ctx.staging.lead) ? ctx.staging.lead : 0;
  return clamp(lead, 0, ctx.plant.drv.length - 1) | 0;
}

/**
 * Call a sim action if it exists, and say so plainly if it does not. A fault that silently does
 * nothing is worse than one that refuses: the player would be asked to diagnose a rig that is
 * behaving perfectly.
 * @param {object} sim the sim module's action surface, whose actions take `ctx` first
 * @param {string} name the action to call
 * @param {object} ctx the sim context
 * @param {*} arg the action's second argument
 * @returns {{ok:boolean, reason?:string}} the action's result, or a refusal
 */
function act(sim, name, ctx, arg) {
  if (!sim || typeof sim[name] !== 'function') return fail(`this rig has no ${name} action`);
  const r = sim[name](ctx, arg);
  return r && r.ok === false ? r : ok();
}

// ---------------------------------------------------------------------------------------------
// The restore points
// ---------------------------------------------------------------------------------------------

/**
 * Build one restore point.
 * @param {string[]} needs sim actions the restore path itself uses
 * @param {(ctx:object) => *} read photograph the quantity as it stands
 * @param {(ctx:object, sim:object, saved:*, fs:object) => *} write put that photograph back
 * @returns {object} the frozen restore point
 */
const point = (needs, read, write) => Object.freeze({
  needs: Object.freeze(needs.slice()), read, write,
});

/**
 * Every quantity a fault in this library is allowed to disturb, with the two operations the
 * injector needs: read it as it stands, and put that value back.
 *
 * A fault names its restore points in `touches` and never writes anything else. That is the
 * entire reversibility argument, and the reason it is a table rather than twenty `clear`
 * functions is in the module header: a hand-written inverse is a second place to get the fault
 * right, it is exercised once per round instead of once per fault, and when it is wrong it is
 * wrong SILENTLY and CUMULATIVELY.
 *
 * Restoring through the sim actions rather than by assignment is deliberate too: the actions
 * clamp, validate and keep their derived state in step (`level_m` also owns the tank inventory,
 * `fluidId` has to exist, `finalElement` preloads the controller), so a restore cannot put the
 * plant somewhere the operator could not have put it.
 */
const RESTORE = Object.freeze({
  // --- the controller -------------------------------------------------------------------------
  scan_s: point(['setScan'], (ctx) => ctx.config.scan_s,
    (ctx, sim, v) => act(sim, 'setScan', ctx, v)),
  action: point(['setTuning'], (ctx) => ctx.pidCfg.action,
    (ctx, sim, v) => act(sim, 'setTuning', ctx, { action: v })),
  Td: point(['setTuning'], (ctx) => ctx.pidCfg.Td,
    (ctx, sim, v) => act(sim, 'setTuning', ctx, { Td: v })),
  outHi: point(['setTuning'], (ctx) => ctx.pidCfg.outHi,
    (ctx, sim, v) => act(sim, 'setTuning', ctx, { outHi: v })),

  // --- the plant ------------------------------------------------------------------------------
  foul: point(['setDisturbance'], (ctx) => ctx.plant.foul,
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { foul: v })),
  hDischarge_m: point(['setDisturbance'], (ctx) => ctx.plant.hDischarge_m,
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { hDischarge_m: v })),
  fluidId: point(['setDisturbance'], (ctx) => ctx.plant.fluidId,
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { fluidId: v })),
  makeupAuto: point(['setDisturbance'], (ctx) => ctx.plant.makeupAuto,
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { makeupAuto: v })),
  Tsupply_C: point(['setDisturbance'], (ctx) => ctx.plant.Tsupply_C,
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { Tsupply_C: v })),
  // The two inventories a fault can drive. Both are restored rather than left to recover on their
  // own: seven cubic metres of water does not cool, and a tank does not refill, in the ten seconds
  // between rounds. Clearing a fault here is a RESET to the rig as it was found, not a repair job
  // carried out in real time, and the alternative is a Fault Hunt whose third round starts hot and
  // half empty because of what happened in its first.
  T_tank_C: point(['setDisturbance'], (ctx) => ctx.plant.T_tank_C,
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { T_tank_C: v })),
  level_m: point(['setDisturbance'], (ctx) => ctx.plant.level_m,
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { level_m: v })),
  wear: point(['setDisturbance'], (ctx) => Array.from(ctx.plant.wear),
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { wear: v })),
  trim: point(['setDisturbance'], (ctx) => Array.from(ctx.plant.trim),
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { trim: v })),
  // No action reaches the overload's thermal state, so this one is written directly. It is a
  // documented plant field and the write is the same one `stepPlant` makes.
  thermal: point([], (ctx) => ctx.plant.drv.map((d) => d.thermal_pct), (ctx, sim, v) => {
    for (let i = 0; i < ctx.plant.drv.length; i += 1) {
      if (Number.isFinite(v[i])) ctx.plant.drv[i].thermal_pct = v[i];
    }
    return ok();
  }),
  // The valve overrides are read as a copy of all three fields, because `setDisturbance` merges
  // what it is given: handing it back a partial record would leave whatever the fault added.
  pcv: point(['setDisturbance'], (ctx) => ({ ...ctx.plant.valveOverride.pcv }),
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { valveOverride: { pcv: v } })),
  fcv: point(['setDisturbance'], (ctx) => ({ ...ctx.plant.valveOverride.fcv }),
    (ctx, sim, v) => act(sim, 'setDisturbance', ctx, { valveOverride: { fcv: v } })),

  // --- the instruments ------------------------------------------------------------------------
  // A transmitter is the one restore point whose photograph is worthless. The chain's state is a
  // delay line and a filter, and the reading it held a minute ago is not the reading a healthy
  // instrument would be showing now — putting it back would be a fault of its own. What "as it
  // was found" means for an instrument is that it is reading the process again, so the chain is
  // re-seeded with the truth exactly as `settlePlant` seeds it at boot. See
  // {@link reseedTransmitter} for why that is not merely stopping the bias.
  pt: point([], (ctx) => photographTx(ctx, 'pt'), (ctx, sim, v) => restoreTx(ctx, 'pt', v)),
  ft: point([], (ctx) => photographTx(ctx, 'ft'), (ctx, sim, v) => restoreTx(ctx, 'ft', v)),
});

/**
 * Photograph a whole measurement chain: the delay line, the filtered reading, and the truth they
 * were measuring at the time.
 *
 * The truth is part of the photograph and is the reason this works. See {@link restoreTx}.
 *
 * @param {object} ctx the sim context
 * @param {string} which a key of {@link TX_CHANNELS}
 * @returns {?object} the photograph, or null if there is no chain to photograph
 */
function photographTx(ctx, which) {
  const ch = TX_CHANNELS[which];
  if (!ch || !ctx || !ctx.plant) return null;
  const st = ctx.plant;
  const line = st._sig && st._sig[ch.delay];
  if (!line || !line.buf || !line.buf.length) return null;
  return {
    buf: Array.from(line.buf),
    reading: st[ch.reading],
    truth: ch.truth(st),
  };
}

/**
 * Put a measurement chain back on the process.
 *
 * A transmitter cannot be restored the way the other points are, and the two obvious fixes are both
 * wrong in ways that look right.
 *
 * The chain is a transport delay followed by a first-order filter. A sensor fault does not set a
 * field that can be unset — it adds a bias to each sample as the sample enters the delay line. So
 * when the fault is cleared the line is full of numbers wrong by an amount that varies along its
 * length, and the filter sits wherever they dragged it. Merely STOPPING the bias leaves all of that
 * in flight: the reading walks back over a dead time plus a filter constant, and the loop acts on
 * the fault for the whole of it. That is the offset that was being left behind.
 *
 * Putting the raw PHOTOGRAPH back is wrong too, for the opposite reason: the process moved while
 * the fault was in, so the pre-fault samples describe a header pressure that is no longer there,
 * and restoring them would be a fresh fault of its own.
 *
 * What is actually wanted is the chain's own internal shape — the lag between truth and reading
 * that a healthy instrument legitimately has — carried forward onto where the process is NOW. So
 * the photograph is re-centred: every sample is shifted by however far the truth has moved since it
 * was taken. Clear the fault the same scan and the shift is zero and the restore is exact, which is
 * what makes it testable; clear it a minute later and the instrument resumes measuring with the
 * same lag it had before, and no bias.
 *
 * No clamping is needed here — the next `stepPlant` clamps the reading to the transmitter's range
 * as it always does.
 *
 * @param {object} ctx the sim context
 * @param {string} which a key of {@link TX_CHANNELS}
 * @param {?object} saved the photograph from {@link photographTx}
 * @returns {{ok:boolean}} the house success result
 */
function restoreTx(ctx, which, saved) {
  const ch = TX_CHANNELS[which];
  if (!ch || !ctx || !ctx.plant || !saved) return ok();
  const st = ctx.plant;
  const line = st._sig && st._sig[ch.delay];
  if (!line || !line.buf || line.buf.length !== saved.buf.length) return ok();

  const truthNow = ch.truth(st);
  const shift = Number.isFinite(truthNow) && Number.isFinite(saved.truth)
    ? truthNow - saved.truth : 0;
  for (let i = 0; i < line.buf.length; i += 1) line.buf[i] = saved.buf[i] + shift;
  if (Number.isFinite(saved.reading)) st[ch.reading] = saved.reading + shift;
  return ok();
}

/**
 * Photograph the restore points a fault is about to disturb, before it disturbs them.
 * @param {object} ctx the sim context
 * @param {string[]} touches the restore points to photograph
 * @returns {object} the saved values, keyed by restore point
 */
function snapshotFor(ctx, touches) {
  const saved = {};
  for (const key of touches) saved[key] = RESTORE[key].read(ctx);
  return saved;
}

/**
 * Put a photograph back.
 * @param {object} ctx the sim context
 * @param {object} sim the sim action surface
 * @param {string[]} touches the restore points to put back
 * @param {object} saved the values from {@link snapshotFor}
 * @param {object} fs fault state, for the restore points that need to know what was disturbed
 * @returns {void}
 */
function restoreSaved(ctx, sim, touches, saved, fs) {
  if (!saved) return;
  for (const key of touches) RESTORE[key].write(ctx, sim, saved[key], fs);
}

/**
 * A deterministic sample in -1..1, for the transmitter faults that need one.
 *
 * Not `Math.random`: two runs of the same seed have to produce the same grass on the trend, or
 * the daily rig is not the same rig for everybody. This is one mulberry32 step over a counter
 * that lives in the fault state, so the sequence depends only on how many times it has been
 * asked — which for a fixed scan period is a function of time alone.
 *
 * @param {object} fs fault state (its counter is advanced)
 * @returns {number} a value in -1..1
 */
function nextNoise(fs) {
  fs.noiseState = (fs.noiseState + 0x6d2b79f5) >>> 0;
  let t = fs.noiseState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Ramp a memo's value toward its target at the rate the memo carries.
 * @param {object} mem the fault's memo, holding `value`, `target` and `rate`
 * @param {number} dt_s the interval, s
 * @returns {number} the new value
 */
function ramp(mem, dt_s) {
  const step = mem.rate * dt_s;
  if (mem.value < mem.target) mem.value = Math.min(mem.target, mem.value + step);
  else if (mem.value > mem.target) mem.value = Math.max(mem.target, mem.value - step);
  return mem.value;
}

/**
 * Refuse a pressure-transmitter fault when the loop is not reading that transmitter. PT-101 can
 * of course fail while the rig is on flow control, but the player would be asked to find a fault
 * that never reaches the loop, which is not a diagnosis exercise.
 * @param {object} ctx the sim context
 * @returns {string|null} a reason to refuse, or null
 */
function needsPressureLoop(ctx) {
  return ctx.run.mode === LOOP.PRESSURE ? null
    : 'PT-101 is not the controlled measurement in this loop mode, so the fault would never reach '
      + 'the controller. Put the rig on pressure control first.';
}

/**
 * Refuse a valve fault while the drives are the final control element, where PCV-101 sits wide
 * open and never moves.
 * @param {object} ctx the sim context
 * @returns {string|null} a reason to refuse, or null
 */
function needsThrottle(ctx) {
  return ctx.plant.finalElement === FINAL.THROTTLE ? null
    : 'PCV-101 is not the final control element while the loop is on the drives — the valve is '
      + 'wide open and a fault in it would not move anything. Switch the final element first.';
}

/**
 * Build one frozen fault record, filling in the optional parts so every consumer can read the
 * same shape.
 *
 * `needs` is DERIVED from `touches` rather than declared. A fault must never be able to apply
 * through an action surface that could not undo it, and the way that used to go wrong is a fault
 * that grew a new write and forgot the matching entry in its hand-written `needs` list. Here the
 * two cannot disagree: the actions a fault needs are exactly the actions its restore points use,
 * plus anything it asks for on top.
 *
 * `clear` is synthesised for the same reason, and is the only undo any fault gets. It is still on
 * the record because the diagnosis screen and the session both hold fault records and expect one
 * shape, and because a fault that could not be cleared has no business in the library.
 *
 * @param {object} spec the fault's fields
 * @returns {object} the frozen record
 */
function fault(spec) {
  const touches = Object.freeze((spec.touches || []).slice());
  const needs = new Set(spec.needs || []);
  for (const key of touches) for (const n of RESTORE[key].needs) needs.add(n);
  return Object.freeze({
    id: spec.id,
    label: spec.label,
    category: spec.category,
    blurb: spec.blurb,
    symptoms: Object.freeze(spec.symptoms.slice()),
    evidence: Object.freeze(spec.evidence.slice()),
    progressive: !!spec.progressive,
    /** Ids a competent operator could reasonably confuse this with. Drives the decoys. */
    confusable: Object.freeze((spec.confusable || []).slice()),
    /** The restore points this fault disturbs, and the only ones it may write. */
    touches,
    /** Sim actions this fault needs; checked before injection so it cannot half-apply. */
    needs: Object.freeze([...needs]),
    /** Optional predicate returning a reason the fault cannot bite on this rig right now. */
    requires: spec.requires || null,
    apply: spec.apply,
    /** Optional per-scan advance. Only progressive faults have one. */
    step: spec.step || null,
    /**
     * Put the rig back exactly as the injector found it.
     * @param {object} ctx the sim context
     * @param {object} sim the sim action surface
     * @param {object} mem the fault's memo, carrying the injector's photograph in `mem.saved`
     * @param {object} fs fault state
     * @returns {void}
     */
    clear(ctx, sim, mem, fs) {
      // Both mechanisms, in this order, because the library uses both. Nine faults declare the
      // restore points they disturb and are undone from the photograph taken at injection; the
      // other fourteen were written before that mechanism existed and undo themselves in their own
      // `clear`. The wrapper used to build this method from `touches` alone and drop `spec.clear`
      // on the floor, so those fourteen never undid anything at all — the rig kept a slow impeller,
      // a blocked strainer or a doubled scan period for the rest of the session, and nothing said
      // so. Running the photograph first and the fault's own clear second is correct for either
      // kind and harmless for a fault that has only one.
      restoreSaved(ctx, sim, touches, mem && mem.saved, fs);
      if (spec.clear) spec.clear(ctx, sim, mem, fs);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------------------------

/**
 * Every fault the rig can be given, across the five categories an engineer sorts a problem into
 * before doing anything else.
 *
 * The `symptoms` of a fault are what shows on the trend and the faceplate — what you notice. The
 * `evidence` is what SEPARATES it from the things it looks like — what you check to be sure. They
 * are deliberately different lists, because the difference between them is the whole job.
 */
export const FAULTS = Object.freeze([
  // --- sensor --------------------------------------------------------------------------------
  fault({
    id: 'PT_DRIFT',
    label: 'PT-101 zero drifting high',
    category: CATEGORY.SENSOR,
    blurb: 'The pressure transmitter\'s zero is walking upward. It reports a header that is '
      + 'higher than the one that exists, and the controller obediently takes the real one down '
      + 'to match.',
    symptoms: [
      'PV sits exactly on setpoint and the loop looks flawless',
      'flow to process falls away with the demand valve untouched',
      'controller output and pump speed drift down for no reason the load explains',
      'nothing alarms — the transmitter says the header is fine',
    ],
    evidence: [
      'PT-101 and FT-101 disagree: the flow the header claims to be making is not the flow the '
        + 'line is passing',
      'the drift is one-way and steady, not a step and not noise',
      'stop the loop in manual at a fixed speed and the reading still climbs',
    ],
    progressive: true,
    requires: needsPressureLoop,
    touches: ['pt'],
    confusable: ['PT_SPAN', 'BACKPRESSURE', 'IMPELLER_WEAR', 'PT_FREEZE'],
    apply(ctx, sim, mag, mem) {
      mem.tx = 'pt';
      mem.value = 0;
      // A bar at full severity, and the size is the whole design of this fault. It has to be big
      // enough that the divergence between PT-101 and everything else is unarguable — a bar is an
      // eighth of the transmitter's span and a third of the setpoint — and small enough that the
      // controller can still take the real header down to match it. It can: a bar of drift leaves
      // the header near 2.2 bar with the output around 20%, nowhere near a limit. A drift that
      // saturates the output stops being a drift and becomes an indistinguishable stuck-output
      // fault, which is a different question with the same picture.
      mem.target = 0.35 + 0.65 * mag;
      // Fully developed inside a minute. A real transmitter takes months to walk this far; a
      // shift on the game clock is three minutes, and the fault has to be legible inside one.
      mem.rate = mem.target / 60;
    },
    step(ctx, sim, mag, mem, dt_s) { mem.bias = ramp(mem, dt_s); },
  }),
  fault({
    id: 'PT_SPAN',
    label: 'PT-101 span wrong after a re-range',
    category: CATEGORY.SENSOR,
    blurb: 'The transmitter was re-ranged and the span was typed in wrong. Its zero is right and '
      + 'everything above zero reads proportionally high.',
    symptoms: [
      'the loop holds a low setpoint nearly correctly and a high one badly',
      'a setpoint step of one bar moves the real header by rather less than one bar',
      'the error grows with the reading rather than sitting at a constant offset',
    ],
    evidence: [
      'the discrepancy scales with the measurement — halve the setpoint and it halves',
      'at a vented, dead header the reading is still correct, so the zero is not the problem',
      'FT-101 and the pump speed both say the header is lower than PT-101 claims',
    ],
    requires: needsPressureLoop,
    touches: ['pt'],
    confusable: ['PT_DRIFT', 'IMPELLER_WEAR', 'BACKPRESSURE'],
    apply(ctx, sim, mag, mem) {
      mem.tx = 'pt';
      // A GAIN on the sample, not an offset computed from the present truth. That is what a span
      // error is: the element reads proportionally high at every value it passes, including the
      // ones still coming down the instrument's dead time.
      mem.gain = 1 + 0.08 + 0.12 * mag;
    },
  }),
  fault({
    id: 'PT_FREEZE',
    label: 'PT-101 output frozen at its last value',
    category: CATEGORY.SENSOR,
    blurb: 'The transmitter has stopped updating — a failed comms link holding the last good '
      + 'value. The number is plausible, which is what makes it dangerous.',
    symptoms: [
      'the PV pen is a ruler while the output wanders',
      'the controller drifts steadily toward an output limit and stays there',
      'the real header goes wherever the load takes it, unopposed',
    ],
    evidence: [
      'PV variance is exactly zero over a period in which the load has plainly changed',
      'a real header on a bladder vessel always has some noise on it; this has none',
      'move the demand valve and the reading does not so much as twitch',
    ],
    requires: needsPressureLoop,
    touches: ['pt'],
    confusable: ['PT_DRIFT', 'VALVE_STUCK', 'PT_SPAN'],
    apply(ctx, sim, mag, mem) {
      mem.tx = 'pt';
      // The last value that got through, held. Because the transmitter's samples are REPLACED
      // with it rather than nudged toward it, the filter downstream is fed a constant and its
      // output is a constant: the pen is a ruler through a load change that moves the real header
      // two bar. An offset computed against the present truth cannot do that — the truth it is
      // computed against is a dead time old, so every transient leaks through as a wobble of a
      // tenth of a bar, and a PV that wobbles is a PV the player will not call frozen.
      mem.hold = ctx.plant.pt_bar;
    },
  }),
  fault({
    id: 'PT_NOISE',
    label: 'PT-101 impulse line gassed up',
    category: CATEGORY.SENSOR,
    blurb: 'Gas trapped in the impulse line, or a wet terminal box. The measurement acquires far '
      + 'more noise than the process it is measuring could possibly have.',
    symptoms: [
      'the PV pen turns to grass',
      'the output is busy and fuzzy even with the average error at zero',
      'the final element travels constantly and the valve or drive earns it',
    ],
    evidence: [
      'the noise is on the measurement, not the process — the header cannot move that fast '
        + 'through a bladder vessel',
      'the machines are steady: speed, current and flow are all calm',
      'the noise band does not change when the loop is put in manual',
    ],
    requires: needsPressureLoop,
    touches: ['pt'],
    confusable: ['DERIV_ON_NOISE', 'PT_SPIKE', 'VALVE_STICTION'],
    apply(ctx, sim, mag, mem) {
      mem.tx = 'pt';
      // An amplitude on the RAW signal, which the transmitter's own half-second filter then
      // rolls off by about a factor of seven. What reaches the faceplate is a few percent of
      // span — unmistakable, and still holdable if the operator does the right thing about it.
      mem.noise = 0.25 + 0.55 * mag;
    },
  }),
  fault({
    id: 'PT_SPIKE',
    label: 'PT-101 throwing intermittent spikes',
    category: CATEGORY.SENSOR,
    blurb: 'An intermittent connection. Every few seconds the transmitter reports one sample that '
      + 'never happened, and the controller believes every one of them.',
    symptoms: [
      'isolated single-sample jumps on an otherwise clean trace',
      'the output kicks once per spike and then recovers',
      'the loop is perfectly well behaved in between',
    ],
    evidence: [
      'each spike is one scan wide — the header has capacitance and cannot physically do that',
      'the spikes are all the same size and the same sign',
      'no flow, speed or current disturbance accompanies them',
    ],
    requires: needsPressureLoop,
    touches: ['pt'],
    confusable: ['PT_NOISE', 'PT_DRIFT', 'DERIV_ON_NOISE'],
    apply(ctx, sim, mag, mem) {
      mem.tx = 'pt';
      // Also a raw amplitude, and a spike lasts one scan, so the filter passes about a third
      // of it. These numbers put half a bar on the faceplate at full severity.
      mem.spikeAmp = 1.2 + 1.8 * mag;
      mem.period_s = 8;
      mem.timer_s = 0;
      mem.spikeNow = false;
    },
    progressive: true,
    step(ctx, sim, mag, mem, dt_s) {
      mem.timer_s += dt_s;
      mem.spikeNow = false;
      if (mem.timer_s >= mem.period_s) {
        mem.timer_s = 0;
        mem.spikeNow = true;
      }
    },
  }),

  // --- final element -------------------------------------------------------------------------
  fault({
    id: 'VALVE_STICTION',
    label: 'PCV-101 stem sticking',
    category: CATEGORY.FINAL,
    blurb: 'Friction in the valve packing. The stem will not move until the actuator force '
      + 'exceeds static friction, and then it breaks free and overshoots.',
    symptoms: [
      'a sustained limit cycle: the PV a rounded square wave, the output a sawtooth',
      'the oscillation will not tune out — halving the gain changes the period barely at all',
      'the cycle stops dead the instant the controller goes to manual',
    ],
    evidence: [
      'output against valve travel traces a parallelogram, not a line',
      'the loop-health page reports a stiction estimate rather than an oscillation period',
      'integral action is required for the cycle: turn reset off and it stops',
    ],
    touches: ['pcv'],
    requires: needsThrottle,
    confusable: ['VALVE_HYSTERESIS', 'VALVE_SLOW', 'SCAN_SLOW', 'PT_NOISE'],
    apply(ctx, sim, mag, mem) {
      const S = 0.02 + 0.06 * mag;
      act(sim, 'setDisturbance', ctx, { valveOverride: { pcv: { stickband: S, slipJump: S * 0.5 } } });
    },
  }),
  fault({
    id: 'VALVE_HYSTERESIS',
    label: 'PCV-101 deadband — lost motion in the linkage',
    category: CATEGORY.FINAL,
    blurb: 'Worn linkage between actuator and stem. After every reversal a fixed slice of travel '
      + 'goes nowhere, but once moving the stem tracks properly — so there is no slip and no '
      + 'limit cycle, only lateness.',
    symptoms: [
      'the response to a setpoint step is prompt one way and late the other',
      'small corrections do nothing at all; large ones work',
      'the loop wanders slowly rather than cycling at a period',
    ],
    evidence: [
      'the lost motion is the same size in both directions and equal to the deadband',
      'the stem does not jump when it finally moves — that would be stiction, and this is not',
      'output travel exceeds valve travel by a constant amount per reversal',
    ],
    touches: ['pcv'],
    requires: needsThrottle,
    confusable: ['VALVE_STICTION', 'VALVE_SLOW', 'VALVE_STUCK'],
    apply(ctx, sim, mag, mem) {
      // A stickband with essentially no slip jump is a deadband, and the plant's effective-valve
      // rule fills in half the stickband as the slip unless a slip is given — so it is given, as
      // a number small enough to be no jump at all.
      act(sim, 'setDisturbance', ctx, {
        valveOverride: { pcv: { stickband: 0.02 + 0.06 * mag, slipJump: 1e-6 } },
      });
    },
  }),
  fault({
    id: 'VALVE_SLOW',
    label: 'PCV-101 positioner starved of air',
    category: CATEGORY.FINAL,
    blurb: 'A restricted or leaking air supply. The valve goes where it is told and takes the '
      + 'better part of a minute about it, so the loop has acquired a lag it was not tuned for.',
    symptoms: [
      'the loop is sluggish and looks badly under-tuned',
      'more gain makes it oscillate instead of making it faster',
      'the valve does arrive eventually, at every command',
    ],
    evidence: [
      'travel ramps at a constant rate to every command, large or small — a rate limit, not a lag',
      'the stroke time measured on a step is many times the nameplate four seconds',
      'the deadband and the jump are both absent; nothing sticks',
    ],
    touches: ['pcv'],
    requires: needsThrottle,
    confusable: ['VALVE_STICTION', 'VALVE_HYSTERESIS', 'SCAN_SLOW', 'IMPELLER_WEAR'],
    apply(ctx, sim, mag, mem) {
      act(sim, 'setDisturbance', ctx, {
        // Right up to the two minutes the rig will accept. Below about a minute the positioner
        // is still quicker than this loop ever asks it to be, and a fault nobody can see is not
        // a fault — the nameplate stroke is four seconds.
        valveOverride: { pcv: { strokeTime_s: 40 + 80 * mag } },
      });
    },
  }),
  fault({
    id: 'VALVE_STUCK',
    label: 'PCV-101 stem seized',
    category: CATEGORY.FINAL,
    blurb: 'The stem has seized in the packing. The positioner is blowing air at a valve that is '
      + 'not going to move, and the controller has no hands.',
    symptoms: [
      'the output ramps to a limit and sits there',
      'the PV does not respond to anything the controller does',
      'a deviation alarm, and the integral wound hard against the limit',
    ],
    evidence: [
      'valve travel is a flat line while the output covers its whole range',
      'the process still responds to the demand valve, so the plant is alive and the loop is not',
      'switching to manual and stroking the output by hand changes nothing',
    ],
    touches: ['pcv'],
    requires: needsThrottle,
    confusable: ['PT_FREEZE', 'VALVE_SLOW', 'OUTPUT_LIMIT', 'WRONG_ACTION'],
    apply(ctx, sim, mag, mem) {
      // The disturbance surface caps the stickband at 0.3 of travel, which on its own would still
      // let a large command drag the stem. Pairing it with the slowest stroke the plant accepts
      // makes the stem immobile on any timescale the round has.
      act(sim, 'setDisturbance', ctx, {
        valveOverride: { pcv: { stickband: 0.3, slipJump: 0.3, strokeTime_s: 120 } },
      });
    },
  }),

  // --- machine -------------------------------------------------------------------------------
  fault({
    id: 'IMPELLER_WEAR',
    label: 'Wear-ring clearance opened up on the running machine',
    category: CATEGORY.MACHINE,
    blurb: 'The wear rings have opened out and liquid is short-circuiting from discharge back to '
      + 'suction inside the casing. The machine still turns; it just makes less head for the same '
      + 'shaft power.',
    symptoms: [
      'the same duty now needs noticeably more speed than it did',
      'efficiency and wire-to-water both down; the running cost up',
      'vibration rising on that machine, and a wear advisory with it',
    ],
    evidence: [
      'the head the machine makes at its measured speed is below its curve',
      'the OTHER machine is normal — run it alone and the loop behaves',
      'the suction margin has also fallen, which worn rings do and a fouled strainer does '
        + 'differently',
    ],
    progressive: true,
    needs: ['setDisturbance'],
    confusable: ['IMPELLER_TRIM', 'STRAINER_BLOCKED', 'VISCOSITY', 'BACKPRESSURE'],
    apply(ctx, sim, mag, mem) {
      mem.i = leadPump(ctx);
      mem.prev = ctx.plant.wear[mem.i];
      mem.value = mem.prev;
      mem.target = clamp(0.35 + 0.55 * mag, 0, 1);
      mem.rate = Math.max(1e-4, (mem.target - mem.prev) / 60);
    },
    step(ctx, sim, mag, mem, dt_s) {
      const wear = ctx.plant.wear.slice();
      wear[mem.i] = ramp(mem, dt_s);
      act(sim, 'setDisturbance', ctx, { wear });
    },
    clear(ctx, sim, mem) {
      const wear = ctx.plant.wear.slice();
      wear[mem.i] = mem.prev;
      act(sim, 'setDisturbance', ctx, { wear });
    },
  }),
  fault({
    id: 'IMPELLER_TRIM',
    label: 'Wrong impeller fitted to the standby machine',
    category: CATEGORY.MACHINE,
    blurb: 'The standby pump came back from overhaul with an impeller turned down further than '
      + 'the drawing says. On its own it looks fine; in parallel it does not pull its weight.',
    symptoms: [
      'nothing whatever until the lag machine stages in',
      'with two running, the header does not rise the way two machines should make it rise',
      'the shared speed stays high with both pumps on line',
    ],
    evidence: [
      'the two branch flows are unequal at the same shaft speed — the same speed should give the '
        + 'same flow from identical machines',
      'the shortfall is proportional and constant, not something that developed over the shift',
      'the standby\'s shutoff head is below the other\'s',
    ],
    needs: ['setDisturbance'],
    confusable: ['IMPELLER_WEAR', 'STRAINER_BLOCKED', 'VISCOSITY'],
    apply(ctx, sim, mag, mem) {
      const lead = leadPump(ctx);
      mem.i = ctx.plant.trim.length > 1 ? (lead + 1) % ctx.plant.trim.length : lead;
      mem.prev = ctx.plant.trim[mem.i];
      const trim = ctx.plant.trim.slice();
      // The disturbance surface floors the trim ratio at 0.7, which is a 30% cut on diameter and
      // about half the head. Anything less obvious than 0.8 is not readable in a three-minute
      // round.
      trim[mem.i] = clamp(0.92 - 0.17 * mag, 0.7, 1);
      act(sim, 'setDisturbance', ctx, { trim });
    },
    clear(ctx, sim, mem) {
      const trim = ctx.plant.trim.slice();
      trim[mem.i] = mem.prev;
      act(sim, 'setDisturbance', ctx, { trim });
    },
  }),
  fault({
    id: 'STRAINER_BLOCKED',
    label: 'Suction strainer blinding',
    category: CATEGORY.MACHINE,
    blurb: 'The suction strainer is filling with debris. Friction upstream of the pump rises, and '
      + 'the suction margin goes with it.',
    symptoms: [
      'NPSH margin falling steadily with the tank level unchanged',
      'a suction margin warning, then cavitation and the head collapsing with it',
      'noise and vibration on the affected machine; output climbing to compensate',
    ],
    evidence: [
      'the tank level and the liquid temperature have BOTH stayed put, so the margin is being '
        + 'eaten by friction',
      'throttle the demand back and the margin recovers immediately — suction loss goes with the '
        + 'square of flow',
      'the discharge side is unremarkable: the head curve is where it should be until cavitation '
        + 'starts',
    ],
    progressive: true,
    needs: ['setDisturbance'],
    confusable: ['LOW_SUCTION', 'HOT_FEED', 'IMPELLER_WEAR', 'VISCOSITY'],
    apply(ctx, sim, mag, mem) {
      mem.prev = ctx.plant.foul;
      mem.value = mem.prev;
      // Stopping short of the 0.95 the disturbance surface allows is deliberate. A fully
      // blinded strainer takes the header to nothing and cavitates both machines inside a
      // minute, which ends the shift rather than posing a question.
      mem.target = clamp(0.35 + 0.35 * mag, 0, 0.95);
      mem.rate = Math.max(1e-4, (mem.target - mem.prev) / 45);
    },
    step(ctx, sim, mag, mem, dt_s) {
      act(sim, 'setDisturbance', ctx, { foul: ramp(mem, dt_s) });
    },
    clear(ctx, sim, mem) {
      act(sim, 'setDisturbance', ctx, { foul: mem.prev });
    },
  }),
  fault({
    id: 'MOTOR_OVERHEAT',
    label: 'Motor cooling blocked on the running machine',
    category: CATEGORY.MACHINE,
    blurb: 'The fan cowl is choked with dust. The motor is doing ordinary work and cannot get rid '
      + 'of the heat, so the overload relay is filling up on a duty it should manage all day.',
    symptoms: [
      'thermal capacity used climbing steadily on one motor',
      'a thermal warning, with the lockout coming if it is left alone',
      'the other machine at the same duty is cool',
    ],
    evidence: [
      'current and shaft power are normal for the duty — the heat is not coming from the load',
      'nothing hydraulic has changed: flow, head and speed are all where they were',
      'the rise is steady rather than following the duty about',
    ],
    progressive: true,
    confusable: ['IMPELLER_WEAR', 'VISCOSITY', 'BACKPRESSURE'],
    apply(ctx, sim, mag, mem) {
      mem.i = leadPump(ctx);
      mem.prev = ctx.plant.drv[mem.i].thermal_pct;
      mem.value = mem.prev;
      // Short of the 115% lockout on purpose. Tripping a machine ends the shift, and a fault that
      // ends the round before it can be diagnosed teaches nothing.
      mem.target = clamp(80 + 25 * mag, 0, 105);
      mem.rate = Math.max(0.1, (mem.target - mem.prev) / 50);
    },
    step(ctx, sim, mag, mem, dt_s) {
      ctx.plant.drv[mem.i].thermal_pct = ramp(mem, dt_s);
    },
    clear(ctx, sim, mem) {
      ctx.plant.drv[mem.i].thermal_pct = mem.prev;
    },
  }),

  // --- process -------------------------------------------------------------------------------
  fault({
    id: 'LOW_SUCTION',
    label: 'Make-up shut in — TK-101 draining',
    category: CATEGORY.PROCESS,
    blurb: 'The make-up valve has failed shut. The tank is being drawn down with nothing coming '
      + 'in, and the static head at the pump suction is going with it.',
    symptoms: [
      'LT-101 falling steadily; a low-level warning in due course',
      'suction margin following the level down',
      'cavitation and a noisy machine once the margin runs out',
    ],
    evidence: [
      'the LEVEL is the thing that is moving, and nothing about the draw has changed',
      'the strainer differential and the liquid temperature are both unremarkable',
      'the margin lost equals the level lost, metre for metre',
    ],
    progressive: true,
    needs: ['setDisturbance'],
    confusable: ['STRAINER_BLOCKED', 'HOT_FEED', 'IMPELLER_WEAR'],
    apply(ctx, sim, mag, mem) {
      mem.makeupAuto = ctx.plant.makeupAuto;
      mem.prevLevel = ctx.plant.level_m;
      mem.value = ctx.plant.level_m;
      mem.target = 0.3;
      // A tank this size drains far too slowly on the draw alone to be readable in a round, so
      // the failure is modelled as a leak as well as a shut valve: 1.2 m/min at full magnitude.
      mem.rate = 0.004 + 0.016 * mag;
      act(sim, 'setDisturbance', ctx, { makeupAuto: false });
    },
    step(ctx, sim, mag, mem, dt_s) {
      act(sim, 'setDisturbance', ctx, { level_m: ramp(mem, dt_s) });
    },
    clear(ctx, sim, mem) {
      // The level is not teleported back: the make-up controller refills the tank on its own time
      // constant, which is what actually happens when somebody opens the valve again.
      act(sim, 'setDisturbance', ctx, { makeupAuto: mem.makeupAuto });
    },
  }),
  fault({
    id: 'HOT_FEED',
    label: 'Hot make-up — suction liquid heating',
    category: CATEGORY.PROCESS,
    blurb: 'A cooler has been bypassed upstream and the make-up is arriving hot. Vapour pressure '
      + 'rises with it, and the suction margin that was comfortable stops being so.',
    symptoms: [
      'TT-101 climbing steadily',
      'suction margin collapsing with the level rock steady',
      'cavitation, head collapse and vibration once the margin is gone',
    ],
    evidence: [
      'vapour pressure, not friction: the tank level and the strainer are both fine',
      'the margin falls with TEMPERATURE and does not care how much you throttle the flow back',
      'both machines lose margin together, because they share the same suction',
    ],
    progressive: true,
    needs: ['setDisturbance'],
    confusable: ['LOW_SUCTION', 'STRAINER_BLOCKED', 'VISCOSITY'],
    apply(ctx, sim, mag, mem) {
      mem.prevSupply = ctx.plant.Tsupply_C;
      mem.prevTank = ctx.plant.T_tank_C;
      mem.value = ctx.plant.T_tank_C;
      mem.target = clamp(60 + 30 * mag, 2, 96);
      mem.rate = 0.3 + 0.5 * mag;
      act(sim, 'setDisturbance', ctx, { Tsupply_C: mem.target });
    },
    step(ctx, sim, mag, mem, dt_s) {
      act(sim, 'setDisturbance', ctx, { T_tank_C: ramp(mem, dt_s) });
    },
    clear(ctx, sim, mem) {
      // Seven cubic metres of water does not cool in the ten seconds between rounds, so clearing
      // puts the inventory back where it was rather than pretending to. Clearing a fault here is
      // a reset, not a repair job.
      act(sim, 'setDisturbance', ctx, { Tsupply_C: mem.prevSupply, T_tank_C: mem.prevTank });
    },
  }),
  fault({
    id: 'VISCOSITY',
    label: 'Wrong product in the tank',
    category: CATEGORY.PROCESS,
    blurb: 'A heavier oil has found its way into TK-101. Both machines are derated by the same '
      + 'Hydraulic Institute correction, and the system curve has moved as well.',
    symptoms: [
      'head and efficiency down on BOTH machines at once',
      'power up for less flow; the running cost noticeably worse',
      'the loop slower than it was, and the tuning now sluggish',
    ],
    evidence: [
      'both machines are derated identically — a machine fault would not be so even-handed',
      'the pipework loss has risen too, which a pump fault cannot do',
      'the viscous-derating advisory is raised, and the correction factors say by how much',
    ],
    needs: ['setDisturbance'],
    confusable: ['IMPELLER_WEAR', 'IMPELLER_TRIM', 'STRAINER_BLOCKED', 'BACKPRESSURE'],
    apply(ctx, sim, mag, mem) {
      mem.prev = ctx.plant.fluidId;
      act(sim, 'setDisturbance', ctx, { fluidId: mag > 0.5 ? 'VG150' : 'VG32' });
    },
    clear(ctx, sim, mem) {
      act(sim, 'setDisturbance', ctx, { fluidId: mem.prev });
    },
  }),
  fault({
    id: 'BACKPRESSURE',
    label: 'Restriction downstream of the battery limit',
    category: CATEGORY.PROCESS,
    blurb: 'A filter is blinding, or somebody has closed a valve, out beyond FT-101. The static '
      + 'head the demand valve discharges against has gone up and the flow has nowhere to go.',
    symptoms: [
      'flow to process falling with the demand valve untouched',
      'output and speed climbing to hold the header, possibly to saturation',
      'the header itself holds, because the loop is fighting for it',
    ],
    evidence: [
      'the demand valve has not moved and the flow has fallen anyway — the loss is downstream',
      'the machines are healthy: curve, margin, vibration and temperature all normal',
      'open the demand valve further and the flow barely improves',
    ],
    needs: ['setDisturbance'],
    confusable: ['FCV_STICTION', 'IMPELLER_WEAR', 'VISCOSITY', 'STRAINER_BLOCKED'],
    apply(ctx, sim, mag, mem) {
      mem.prev = ctx.plant.hDischarge_m;
      // Bounded well below the head the machines can make. Push the static head above that
      // and the flow does not fall, it REVERSES, which is a different fault entirely and not
      // one this record describes.
      act(sim, 'setDisturbance', ctx, { hDischarge_m: clamp(mem.prev + 4 + 11 * mag, 0, 60) });
    },
    clear(ctx, sim, mem) {
      act(sim, 'setDisturbance', ctx, { hDischarge_m: mem.prev });
    },
  }),
  fault({
    id: 'FCV_STICTION',
    label: 'FCV-101 sticking — the load arrives in jumps',
    category: CATEGORY.PROCESS,
    blurb: 'The demand valve\'s packing has been overtightened. The load no longer changes '
      + 'smoothly: it does nothing, and then it steps. Note that it shows itself only when the '
      + 'demand actually moves.',
    symptoms: [
      'a smooth demand change produces nothing, then a sudden step',
      'the header takes a kick on every one of those steps',
      'between the steps the loop is entirely well behaved',
    ],
    evidence: [
      'the disturbances are on the LOAD side: flow steps first and pressure follows',
      'FCV-101 travel against its command is a staircase',
      'the controller and the final element are both blameless — put the loop in manual and the '
        + 'steps still arrive',
    ],
    needs: ['setDisturbance'],
    confusable: ['BACKPRESSURE', 'VALVE_STICTION', 'PT_SPIKE'],
    apply(ctx, sim, mag, mem) {
      mem.prev = { ...ctx.plant.valveOverride.fcv };
      const S = 0.03 + 0.07 * mag;
      act(sim, 'setDisturbance', ctx, { valveOverride: { fcv: { stickband: S, slipJump: S * 0.5 } } });
    },
    clear(ctx, sim, mem) {
      act(sim, 'setDisturbance', ctx, { valveOverride: { fcv: mem.prev } });
    },
  }),

  // --- control -------------------------------------------------------------------------------
  fault({
    id: 'SCAN_SLOW',
    label: 'Controller scan left slow after maintenance',
    category: CATEGORY.CONTROL,
    blurb: 'The scan period was raised for a comms test and never put back. The tuning has not '
      + 'changed; the sampling has, and the loop has lost its margin to the extra half-scan of '
      + 'dead time.',
    symptoms: [
      'a disturbance that used to be caught is now half a process constant old before anything '
        + 'happens about it',
      'the output moves in visible steps and the PV pen is stair-stepped between them',
      'a loop that had been tuned tight hunts; a conservatively tuned one merely goes slow',
    ],
    evidence: [
      'the output only ever changes at the scan boundary, and the staircase has the SCAN period, '
        + 'not the loop\'s',
      'the plant is blameless — every machine and every valve reads normal, and the response to a '
        + 'change in MANUAL is as quick as it ever was',
      'the faceplate\'s scan period is not the one the tuning was done at',
    ],
    needs: ['setScan'],
    confusable: ['VALVE_SLOW', 'VALVE_STICTION', 'DERIV_ON_NOISE'],
    apply(ctx, sim, mag, mem) {
      mem.prev = ctx.config.scan_s;
      // Up to the five seconds the rig allows. Anything gentler leaves the shipped, conservative
      // pressure tuning completely unmoved — the whole point of the fault is that the loop stops
      // having the phase margin its tuning assumed, and that needs most of a process time
      // constant of extra sampling.
      act(sim, 'setScan', ctx, clamp(mem.prev * (6 + 19 * mag), ctx.config.dt_s, 5));
    },
    clear(ctx, sim, mem) {
      act(sim, 'setScan', ctx, mem.prev);
    },
  }),
  fault({
    id: 'WRONG_ACTION',
    label: 'Controller action reversed',
    category: CATEGORY.CONTROL,
    blurb: 'Somebody has left PIC-101 on direct action. On a pump loop that is positive feedback: '
      + 'every correction makes the error it was correcting bigger.',
    symptoms: [
      'the output runs straight to a limit and stays there',
      'the further the measurement gets from setpoint the harder the controller pushes the wrong '
        + 'way',
      'a deviation alarm within seconds of going to auto',
    ],
    evidence: [
      'put the loop in manual and the runaway stops instantly — the plant is stable, the loop is '
        + 'not',
      'the sign of the response is wrong: raise the setpoint and the output falls',
      'the faceplate says DIRECT on a loop whose final element raises the measurement',
    ],
    needs: ['setTuning'],
    confusable: ['OUTPUT_LIMIT', 'VALVE_STUCK', 'PT_FREEZE'],
    apply(ctx, sim, mag, mem) {
      mem.prev = ctx.pidCfg.action;
      act(sim, 'setTuning', ctx, {
        action: mem.prev === ACTION.DIRECT ? ACTION.REVERSE : ACTION.DIRECT,
      });
    },
    clear(ctx, sim, mem) {
      act(sim, 'setTuning', ctx, { action: mem.prev });
    },
  }),
  fault({
    id: 'DERIV_ON_NOISE',
    label: 'Rate action added to a noisy measurement',
    category: CATEGORY.CONTROL,
    blurb: 'Derivative was turned up to sharpen the response. On a measurement with real noise on '
      + 'it, rate action amplifies the noise far more than it amplifies the signal.',
    symptoms: [
      'the output is fuzzy and busy even with the average error at zero',
      'the final element travels constantly and goes nowhere',
      'there is no clean oscillation period — the movement is broad-band, not a cycle',
    ],
    evidence: [
      'the output noise is proportional to the MEASUREMENT noise, not to the error',
      'the loop-health page reports large output travel and no dominant period',
      'zero the rate time and the thrashing stops without costing any control',
    ],
    needs: ['setTuning'],
    confusable: ['PT_NOISE', 'PT_SPIKE', 'VALVE_STICTION'],
    apply(ctx, sim, mag, mem) {
      mem.prevTd = ctx.pidCfg.Td;
      mem.prevN = ctx.pidCfg.N;
      // BOTH numbers, and the second is the one that matters. A filtered derivative's gain at
      // high frequency is Kc*N whatever Td is, so winding Td up on its own amplifies nothing:
      // the fault is somebody opening the derivative filter out as well, which is exactly the
      // mistake that produces a thrashing output on a perfectly ordinary measurement.
      const Td = 1.5 + 5 * mag;
      const N = 20 + 60 * mag;
      const r = act(sim, 'setTuning', ctx, { Td, N });
      // The series form refuses a rate time its reset time cannot express. Back off to the
      // largest rate time it will take rather than leave the round with no fault in it.
      if (!r.ok) act(sim, 'setTuning', ctx, { Td: Math.max(0.2, ctx.pidCfg.Ti / 4.2), N });
    },
    clear(ctx, sim, mem) {
      act(sim, 'setTuning', ctx, { Td: mem.prevTd, N: mem.prevN });
    },
  }),
  fault({
    id: 'OUTPUT_LIMIT',
    label: 'Output high limit left behind after a test',
    category: CATEGORY.CONTROL,
    blurb: 'The controller\'s output high limit was pulled down for a test and never restored. '
      + 'The loop cannot ask for the speed it needs, and the reset winds up against a ceiling '
      + 'that is not the drive\'s.',
    symptoms: [
      'the PV holds below setpoint and never reaches it',
      'the output is pinned at a number that is not 100%',
      'a deviation alarm, and no response at all to more gain',
    ],
    evidence: [
      'the output is saturated somewhere odd — read the limits on the faceplate',
      'the drive is not at its own limit: there is speed left in the machine',
      'raise the limit and the loop closes the deviation immediately, with the same tuning',
    ],
    needs: ['setTuning'],
    confusable: ['WRONG_ACTION', 'VALVE_STUCK', 'IMPELLER_WEAR', 'BACKPRESSURE'],
    apply(ctx, sim, mag, mem) {
      mem.prev = ctx.pidCfg.outHi;
      const target = clamp(mem.prev - (15 + 30 * mag), ctx.pidCfg.outLo + 5, mem.prev);
      act(sim, 'setTuning', ctx, { outHi: target });
    },
    clear(ctx, sim, mem) {
      act(sim, 'setTuning', ctx, { outHi: mem.prev });
    },
  }),
]);

/** Index by id, built once. */
const BY_ID = Object.freeze(Object.fromEntries(FAULTS.map((f) => [f.id, f])));

/**
 * Look a fault up by id.
 * @param {string} id the fault id
 * @returns {object|null} the frozen fault record, or null when there is no such fault
 */
export function faultById(id) {
  return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * Allocate the mutable fault state for one round.
 * @returns {object} the fault state
 */
export function createFaultState() {
  return {
    /** @type {object[]} active faults: `{id, mag, mem, at_s, elapsed_s}` */
    list: [],
    /** Counter behind the deterministic noise generator. */
    noiseState: 0x9e3779b9,
    /** Ids already guessed and rejected, so a second bite costs what the first one did. */
    wrongGuesses: [],
    /** Set once a correct diagnosis has been graded, so it cannot be graded twice. */
    solved: false,
  };
}

/**
 * Inject a fault.
 *
 * Everything that could go wrong is checked BEFORE anything is changed, because a fault that
 * half-applies leaves the rig in a state no `clear` can undo and quietly poisons every round
 * after it.
 *
 * @param {object} fs fault state from {@link createFaultState} (mutated)
 * @param {object} ctx the sim context
 * @param {object} sim the sim action surface, whose actions take `ctx` as their first argument
 * @param {string} id the fault to inject
 * @param {number} [mag=1] severity, 0..1
 * @returns {{ok:boolean, reason?:string}} the result
 */
export function injectFault(fs, ctx, sim, id, mag) {
  if (!fs || !Array.isArray(fs.list)) return fail('there is no fault state to inject into');
  const f = faultById(id);
  if (!f) return fail(`there is no fault called ${String(id)} in the library`);
  if (!usableCtx(ctx)) return fail('the simulation context is not complete enough to fault');
  const m = mag === undefined || mag === null ? 1 : mag;
  if (!Number.isFinite(m)) return fail('the fault magnitude has to be a number between 0 and 1');
  if (fs.list.some((a) => a.id === id)) return fail(`${f.label} is already injected`);
  for (const name of f.needs) {
    if (!sim || typeof sim[name] !== 'function') {
      return fail(`${f.label} needs the ${name} action and this rig does not have one`);
    }
  }
  if (f.requires) {
    const why = f.requires(ctx);
    if (why) return fail(why);
  }

  const rec = {
    id,
    mag: clamp(m, 0, 1),
    mem: {},
    at_s: Number.isFinite(ctx.run.t_s) ? ctx.run.t_s : 0,
    elapsed_s: 0,
  };
  // The photograph is taken BEFORE `apply` and never after. A fault that recorded what it found
  // once it had already changed it would restore its own damage, and — worse — a second fault
  // injected on top of the first would photograph the first one's handiwork and enshrine it as
  // the healthy state. Every round after that inherits a rig that is quietly wrong, with nothing
  // in the interface admitting it.
  rec.mem.saved = snapshotFor(ctx, f.touches);
  f.apply(ctx, sim, rec.mag, rec.mem);
  fs.list.push(rec);
  return ok();
}

/**
 * Advance every active fault by one controller scan, then push the sensor faults into the
 * transmitters.
 *
 * @param {object} fs fault state (mutated)
 * @param {object} ctx the sim context
 * @param {object} sim the sim action surface
 * @param {number} dt_s the interval since the last call, s
 * @returns {void}
 */
export function stepFaults(fs, ctx, sim, dt_s) {
  if (!fs || !Array.isArray(fs.list) || !usableCtx(ctx)) return;
  const dt = Number.isFinite(dt_s) && dt_s > 0 ? dt_s : 0;

  for (const rec of fs.list) {
    rec.elapsed_s += dt;
    const f = faultById(rec.id);
    if (f && f.step) f.step(ctx, sim, rec.mag, rec.mem, dt);
  }
  // Only when time is actually going to pass. A call with no interval means no plant ticks will
  // be taken either, so biasing samples that nobody is about to read would put a stray notch in
  // the signal for every wasted call.
  if (dt > 0) applyTransmitters(fs, ctx, dt);
}

/**
 * Compose what the active sensor faults want added to one transmitter's signal, as a steady part
 * and a per-sample noise amplitude.
 *
 * Everything is expressed as a bias on the RAW signal, because a bias is the only thing the delay
 * line can carry. A span error is a bias proportional to the true value; a frozen reading is the
 * bias that cancels the true value and substitutes the held one, recomputed every scan so that
 * the reading stays put however far the process wanders away from it.
 *
 * @param {object} fs fault state
 * @param {object} ctx the sim context
 * @param {string} channel a key of {@link TX_CHANNELS}
 * @returns {{constant:number, noise:number}} the bias to add to every sample, and the amplitude
 *   of the extra white noise to add on top of it
 */
function transmitterBias(fs, ctx, channel) {
  const ch = TX_CHANNELS[channel];
  const truth = ch.truth(ctx.plant);
  const out = { constant: 0, noise: 0 };
  for (const rec of fs.list) {
    const mem = rec.mem;
    if (mem.tx !== channel) continue;
    if (Number.isFinite(mem.bias)) out.constant += mem.bias;
    if (Number.isFinite(mem.gain)) out.constant += (mem.gain - 1) * truth;
    if (Number.isFinite(mem.hold)) out.constant += mem.hold - truth;
    if (Number.isFinite(mem.noise)) out.noise += mem.noise;
    if (mem.spikeNow && Number.isFinite(mem.spikeAmp)) out.constant += mem.spikeAmp;
  }
  return out;
}

/**
 * Add the sensor faults' bias to the samples the transmitter is about to read out of its
 * transport-delay line.
 *
 * Only the samples that will actually be consumed before the next call are touched. The line is a
 * ring and the plant overwrites each slot with a fresh clean sample as it consumes it, so biasing
 * the whole ring would bias some slots twice over. A scan period that is not a whole number of
 * physics ticks leaves a slot's worth of slop at the boundary; the transmitter's own filter turns
 * that into a fraction of a percent, and nobody will ever see it.
 *
 * @param {object} fs fault state (its noise counter advances)
 * @param {object} ctx the sim context (its transmitter signal chain is written)
 * @param {number} dt_s the interval until the next call, s
 * @returns {void}
 */
function applyTransmitters(fs, ctx, dt_s) {
  const sig = ctx.plant._sig;
  if (!sig) return;
  for (const key of Object.keys(TX_CHANNELS)) {
    const line = sig[TX_CHANNELS[key].delay];
    if (!line || !line.buf || !line.buf.length || !Number.isInteger(line.i)) continue;
    const b = transmitterBias(fs, ctx, key);
    if (!b.constant && !b.noise) continue;
    const span = Math.min(line.buf.length, Math.max(1, Math.round(dt_s / ctx.config.dt_s)));
    for (let k = 0; k < span; k += 1) {
      const j = (line.i + k) % line.buf.length;
      line.buf[j] += b.constant + (b.noise ? b.noise * nextNoise(fs) : 0);
    }
  }
}

/**
 * Clear every active fault and put the rig back where it was found.
 *
 * What each fault WROTE is restored exactly. What the plant then integrated on its own — an
 * inventory that drained, a casing that heated, a reading still coming down the instrument's dead
 * time — is left to recover physically, except where a physical recovery would take longer than
 * the game exists for; the individual `clear` functions say which is which and why.
 *
 * @param {object} fs fault state (emptied)
 * @param {object} ctx the sim context
 * @param {object} sim the sim action surface
 * @returns {void}
 */
export function clearFaults(fs, ctx, sim) {
  if (!fs || !Array.isArray(fs.list)) return;
  if (usableCtx(ctx)) {
    // Last in, first out. Two faults can touch the same restore point — two valve faults both
    // write the stem override — and the second one photographed what the first had already done.
    // Unwinding in injection order would therefore finish by writing the FIRST fault's damage back
    // on; unwinding in reverse finishes on the oldest photograph, which is the one taken of a
    // healthy rig. This is the same discipline as any nested override, and the reason it is not
    // merely tidier is that forward order is silently wrong rather than noisily wrong.
    for (const rec of fs.list.slice().reverse()) {
      const f = faultById(rec.id);
      if (f) f.clear(ctx, sim, rec.mem, fs);
    }
  }
  fs.list.length = 0;
  // Nothing has to be undone on the transmitters: with no sensor fault left to bias it, the delay
  // line flushes itself within its own dead time and the filter follows within its own constant.
}

/**
 * Which faults are active.
 * @param {object} fs fault state
 * @returns {string[]} the active fault ids, in the order they were injected
 */
export function activeFaults(fs) {
  if (!fs || !Array.isArray(fs.list)) return [];
  return fs.list.map((rec) => rec.id);
}

// ---------------------------------------------------------------------------------------------
// The question, and the marking of it
// ---------------------------------------------------------------------------------------------

/**
 * Build the multiple-choice options for a diagnosis.
 *
 * The decoys are the point. Three absurd options are not a question — the player answers by
 * elimination without looking at the trend, and learns nothing. So the decoys are drawn first
 * from the fault's own `confusable` list, which names the things that genuinely produce a similar
 * trace (a drifting transmitter against a wrong span; stiction against a slow positioner; a
 * fouled strainer against a hot suction), then from its own category, and only then from the rest
 * of the library.
 *
 * @param {() => number} rng the seeded generator
 * @param {string} trueId the fault actually injected
 * @param {number} [n=4] how many options to offer, including the true one
 * @returns {string[]} the option ids, shuffled; empty when `trueId` is not a known fault
 */
export function faultChoices(rng, trueId, n) {
  const truth = faultById(trueId);
  if (!truth) return [];
  const want = Number.isFinite(n) ? clamp(Math.round(n), 1, FAULTS.length) : 4;
  const gen = typeof rng === 'function' ? rng : () => 0.5;

  const chosen = [truth.id];
  const take = (pool) => {
    for (const id of rngShuffle(gen, pool)) {
      if (chosen.length >= want) return;
      if (!chosen.includes(id)) chosen.push(id);
    }
  };
  take(truth.confusable.filter((id) => !!faultById(id)));
  take(FAULTS.filter((f) => f.category === truth.category).map((f) => f.id));
  take(FAULTS.map((f) => f.id));

  return rngShuffle(gen, chosen);
}

/**
 * Mark a diagnosis.
 *
 * The scheme is in {@link GRADE}: full marks for being right, a speed bonus that is undiminished
 * for the first twenty seconds and then halves every seventy-five, and a wrong answer priced so
 * that a blind guess among four options is worth exactly nothing on average. Wrong guesses are
 * remembered, so working through the options one at a time costs what it should.
 *
 * A non-finite `elapsed_s` is treated as a very long time rather than as zero: nonsense should
 * never be worth more than an honest answer.
 *
 * @param {object} fs fault state (its guess history is updated)
 * @param {string} guessId the fault the player named
 * @param {number} elapsed_s seconds since the fault was injected
 * @returns {{correct:boolean, points:number, explain:string}} the verdict
 */
export function gradeDiagnosis(fs, guessId, elapsed_s) {
  if (!fs || !Array.isArray(fs.list)) {
    return { correct: false, points: 0, explain: 'there is no round in progress to mark.' };
  }
  const guess = faultById(guessId);
  if (!guess) {
    return {
      correct: false,
      points: 0,
      explain: `${String(guessId)} is not a fault this rig knows about, so nothing was marked.`,
    };
  }
  const truthId = fs.list.length ? fs.list[0].id : null;
  const truth = truthId ? faultById(truthId) : null;
  if (!truth) {
    return {
      correct: false,
      points: 0,
      explain: 'no fault was injected, so there was nothing to find.',
    };
  }
  if (fs.solved) {
    return {
      correct: false,
      points: 0,
      explain: `${truth.label} has already been diagnosed — this round is marked.`,
    };
  }

  if (guess.id !== truth.id) {
    if (!fs.wrongGuesses.includes(guess.id)) fs.wrongGuesses.push(guess.id);
    return {
      correct: false,
      points: -GRADE.wrongPenalty,
      explain: `${guess.label} would have shown ${guess.symptoms[0]}. That is not what the trend `
        + 'is doing. Look again.',
    };
  }

  // Nonsense in the clock is treated as an eternity, never as an instant: an unreadable elapsed
  // time must not be worth more than an honest one.
  const t = Number.isFinite(elapsed_s) ? Math.max(0, elapsed_s) : 1e6;
  const late_s = Math.max(0, t - GRADE.grace_s);
  const bonus = GRADE.speedBonus * Math.pow(0.5, late_s / GRADE.halfLife_s);
  const raw = GRADE.base + bonus - GRADE.wrongPenalty * fs.wrongGuesses.length;
  fs.solved = true;
  return {
    correct: true,
    points: Math.round(Math.max(GRADE.floor, raw)),
    explain: `${truth.label}. ${truth.evidence[0]}.`,
  };
}
