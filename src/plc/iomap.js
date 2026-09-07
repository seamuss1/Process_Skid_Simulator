/**
 * src/plc/iomap.js — the IO rack. Every point at which the processor touches the plant, declared
 * once in a fixed table, plus the two scans that move data across it.
 *
 * Layer L5: imports `core/util.js`, `data/config.js`, the L1-L3 process and control modules and
 * `plc/tags.js`. It NEVER imports `src/ui`, it never touches the DOM, `window`, `performance` or
 * the clock, and it holds no randomness — the whole module is unit-tested in Node.
 *
 * ------------------------------------------------------------------------------------------
 * THE INPUT IMAGE IS THE WHOLE POINT
 *
 * A PLC does not read a field device when a rung asks for it. It samples every input ONCE, at the
 * top of the scan, into an image; the logic then reads the image; and the outputs are applied
 * ONCE at the bottom. The plant is free to move underneath all of that and the logic will not
 * notice until the next scan.
 *
 * That is not an implementation detail, it is the contract that makes ladder logic analysable. If
 * a rung near the top of the program and a rung near the bottom both look at PT-101, they must
 * see the SAME pressure, or the two rungs can disagree about the state of the plant and there is
 * no longer any such thing as "the state the program ran on". Everything a controls engineer
 * knows about reading a program — that power flows left to right, that rungs execute top to
 * bottom, that a coil written in rung 3 is what rung 40 will see — rests on the image being
 * frozen for the duration. `tests/iomap.test.js` proves it by moving the plant in the middle of a
 * scan and asserting the image did not follow.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT A FORCE DOES, AND IN WHICH DIRECTION
 *
 * Forcing is the reason `scanInputs` and `scanOutputs` do not use the same accessors.
 *
 *   INPUTS are written with `rawWrite`, which goes under any force. The field value keeps being
 *   collected — you can still see what the transmitter is really saying — while `readTag` hands
 *   the logic the forced value. Use `writeTag` here instead and the very first scan would erase
 *   the force the operator just applied.
 *
 *   OUTPUTS are read with `readTag`, which honours the force. Forcing an output exists precisely
 *   so a commissioning engineer can bump a starter with the program still running; an output
 *   force that the IO scan quietly ignored would be a lie told to somebody standing next to a
 *   motor.
 *
 * ------------------------------------------------------------------------------------------
 * COMMAND SEMANTICS: LEVEL, GUARDED, IDEMPOTENT
 *
 * Every output is applied on every scan, and every `write` compares what it has been asked for
 * against what the plant is already doing before it calls an action. A held coil therefore means
 * "keep it this way", not "do it again five times a second" — which matters here because the
 * simulator's actions are not free: `startPump` counts a start, `setSetpoint` writes a line to
 * the operator's event feed. Re-issuing either of those every 200 ms would ruin the start counter
 * and bury the event log, and both are exactly the failures a real output card avoids by holding
 * a contactor closed rather than re-closing it.
 *
 * FOUR POINTS ARE MOMENTARY INSTEAD, and they are the four that are pushbuttons on the real
 * starter door: start, stop, auto and reset, plus the alarm acknowledge. Those act on a RISING
 * EDGE of the output image and are inert while they are simply held.
 *
 * It has to be that way, and the reason is worth stating because it is not obvious. A machine's
 * placement is ONE selector with three positions, but the ladder addresses it through three
 * separate coils. Hold two of them and maintained semantics would have the rack re-placing the
 * machine twice per scan for ever — auto, hand, auto, hand — counting a start every time. On a
 * rising edge, whichever button was PRESSED is the command and a held button does nothing, which
 * is exactly what the wiring in a motor control centre gives you.
 *
 * FIRST SCAN. The output image comes up at zero, and zero is a real command: "setpoint 0.0 bar",
 * "P-101 to OFF". So the first `scanInputs` PRIMES the output image from the plant instead,
 * exactly as a processor reads its outputs back on the transition to RUN. Without it, loading a
 * program would slam the rig before the first rung had been solved.
 *
 * ------------------------------------------------------------------------------------------
 * WHERE THE WRITES GO
 *
 * Every output either calls a real action on `src/core/sim.js` — validated the same way the
 * panel's own buttons are — or writes a documented field the plant reads. The two exceptions are
 * the annunciator and the recipe display: a horn and a lamp are field devices that this rig does
 * not model hydraulically, so their wiring terminates on `ctx.plcPanel` (see {@link panelOf}),
 * which is what the HMI reads. No point in this table is decorative; a point that quietly did
 * nothing would be worse than one that was missing, because you would trust it.
 * ------------------------------------------------------------------------------------------
 */

import { headToBar } from '../core/util.js';
import { LOOP } from '../data/config.js';
import { DRIVE, isCalled } from '../process/motor.js';
import {
  RECIRC, FINAL, electricalPower_kW, measuredPV, minimumFlow, runningCount,
} from '../process/plant.js';
import { HAND, ROTATE, CRITERION, startsPerHour } from '../control/staging.js';
import { MODE } from '../control/pid.js';
import { TYPE, SCOPE, defineTag, rawRead, rawWrite, readTag } from './tags.js';

/** The success result every `write` shares, so the common path allocates nothing. */
const OK = Object.freeze({ ok: true });

/**
 * The house refusal.
 * @param {string} reason a sentence an operator could read
 * @returns {{ok:false, reason:string}} the refusal
 */
const refuse = (reason) => ({ ok: false, reason });

/**
 * A value as it should appear in a refusal message: readable, and never `undefined` silently.
 * @param {*} v the offending value
 * @returns {string} a short description
 */
function shown(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `the non-number ${v}`;
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}

/**
 * Coerce an output-image value onto a discrete command.
 *
 * Booleans and the integers 0 and 1 are both accepted, because a tag database is entitled to
 * store a BOOL either way and an IO card that argued about the representation would be useless.
 * Anything else is a genuine programming error and is refused.
 *
 * @param {string} tag the point's tag, for the message
 * @param {*} v the value from the output image
 * @returns {{ok:true, v:boolean}|{ok:false, reason:string}} the command, or a refusal
 */
function asBool(tag, v) {
  if (typeof v === 'boolean') return { ok: true, v };
  if (v === 0 || v === 1) return { ok: true, v: v === 1 };
  return refuse(`${tag} was written ${shown(v)} — a discrete output is on or off, nothing else`);
}

/**
 * Coerce and range-check an output-image value onto an analogue command.
 * @param {string} tag the point's tag, for the message
 * @param {*} v the value from the output image
 * @param {number} lo lowest acceptable value
 * @param {number} hi highest acceptable value
 * @returns {{ok:true, v:number}|{ok:false, reason:string}} the command, or a refusal
 */
function asNum(tag, v, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return refuse(`${tag} was written ${shown(v)} — an analogue output has to be a finite number`);
  }
  if (v < lo || v > hi) {
    return refuse(`${tag} was written ${v} — outside the ${lo} to ${hi} this point is wired for`);
  }
  return { ok: true, v };
}

/**
 * Coerce an output-image value onto one of a fixed set of names.
 * @param {string} tag the point's tag, for the message
 * @param {*} v the value from the output image
 * @param {object} table a frozen enum whose keys are the acceptable names
 * @returns {{ok:true, v:string}|{ok:false, reason:string}} the selection, or a refusal
 */
function asEnum(tag, v, table) {
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(table, v)) {
    return { ok: true, v };
  }
  return refuse(`${tag} was written ${shown(v)} — it accepts only `
    + `${Object.keys(table).join(', ')}`);
}

/**
 * Call a simulator action by name and normalise its answer.
 *
 * The action surface is handed in rather than imported so this module can be tested against a
 * stub, and so a build that has not wired an action yet REFUSES instead of failing silently.
 *
 * @param {object} sim the `src/core/sim.js` action surface
 * @param {string} name the action to call
 * @param {...*} args the action's arguments
 * @returns {{ok:boolean, reason?:string}} the action's result, or a refusal
 */
function act(sim, name, ...args) {
  const fn = sim && sim[name];
  if (typeof fn !== 'function') {
    return refuse(`the simulation offers no ${name} action, so this output has nowhere to go`);
  }
  const r = fn(...args);
  return r && r.ok === false ? r : OK;
}

/**
 * The field devices that are not part of the hydraulic plant: the annunciator horn, the panel
 * lamps and the recipe display.
 *
 * They are real outputs with real wiring, they simply terminate on the HMI rather than on a valve
 * or a starter. Keeping them in one record on the context — created on demand, never replaced —
 * means the mimic has exactly one place to look and the IO table does not have to pretend a horn
 * is a piece of pipework.
 *
 * @param {object} ctx the sim context (gains `plcPanel` on first use)
 * @returns {object} the panel record
 */
export function panelOf(ctx) {
  if (!ctx.plcPanel) {
    ctx.plcPanel = {
      /** Annunciator horn, sounding. */
      horn: false,
      /** Red lamp: something is in alarm. */
      lampAlarm: false,
      /** Amber lamp: something is in warning. */
      lampWarn: false,
      /** Green lamp above P-101. */
      lampP1: false,
      /** Green lamp above P-102. */
      lampP2: false,
      /** Step number the recipe display is showing. */
      recipeStep: 0,
      /** Recipe held: the sequencer is not counting down. */
      recipeHold: false,
    };
  }
  return ctx.plcPanel;
}

// ---------------------------------------------------------------------------------------------
// Readings the table needs more than once
// ---------------------------------------------------------------------------------------------

/**
 * Whether a condition in `process/alarms.js` is presently standing.
 *
 * The alarm list keeps cleared-but-unacknowledged rows, so `active` is the only field that means
 * "this is true right now" — an annunciator wired to mere presence in the list would latch for
 * ever.
 *
 * @param {object} ctx the sim context
 * @param {string} id the condition id used by `evaluateAlarms`
 * @returns {boolean} whether it is active
 */
function alarmOn(ctx, id) {
  const row = ctx.alarms && ctx.alarms.rows ? ctx.alarms.rows.get(id) : null;
  return !!(row && row.active);
}

/**
 * How many alarm rows are waiting to be acknowledged.
 * @param {object} ctx the sim context
 * @returns {number} the count
 */
function unacked(ctx) {
  let n = 0;
  if (ctx.alarms && ctx.alarms.rows) {
    for (const row of ctx.alarms.rows.values()) if (!row.ack) n += 1;
  }
  return n;
}

/**
 * @param {number} v a value destined for an INT tag
 * @returns {number} the same value as a whole number
 */
const int = (v) => Math.round(v) | 0;

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

/**
 * Declare an input point.
 * @param {string} tag symbolic name, `I.` prefixed
 * @param {string} type one of {@link TYPE}
 * @param {string|undefined} unit engineering unit, or undefined for a discrete
 * @param {string} desc what an operator would call it
 * @param {(ctx:object)=>*} read how the value is collected from the plant
 * @param {object} [range] `{min, max}` for the tag browser's bar graph
 * @returns {object} the point
 */
function inp(tag, type, unit, desc, read, range) {
  return {
    tag, dir: 'in', type, unit, desc, read, min: range && range.min, max: range && range.max,
  };
}

/**
 * Declare an output point.
 * @param {string} tag symbolic name, `Q.` prefixed
 * @param {string} type one of {@link TYPE}
 * @param {string|undefined} unit engineering unit, or undefined for a discrete
 * @param {string} desc what an operator would call it
 * @param {(ctx:object)=>*} read the READBACK: what the plant is doing now, used to prime the
 *   output image on the first scan and to make a tracking point follow the field
 * @param {(ctx:object, sim:object, v:*)=>object} write how the command reaches the plant
 * @param {object} [opts] `{min, max}` for the browser; `edge` to make the point a momentary
 *   pushbutton that commands on a rising edge and is inert while it is held; and `tracks(ctx)` —
 *   true while this output is not in command and its image should follow the field instead of
 *   driving it
 * @returns {object} the point
 */
function out(tag, type, unit, desc, read, write, opts) {
  return {
    tag,
    dir: 'out',
    type,
    unit,
    desc,
    read,
    write,
    min: opts && opts.min,
    max: opts && opts.max,
    edge: !!(opts && opts.edge),
    tracks: opts && opts.tracks,
  };
}

/**
 * Every input this rig brings back from one machine.
 *
 * Built rather than typed out, because two identical pumps deserve two identical racks and a
 * hand-copied block is where the second machine quietly ends up reading the first one's current.
 *
 * @param {number} i pump index, 0-based
 * @returns {object[]} the points for that machine
 */
function pumpInputs(i) {
  const n = i + 1;
  const P = `P-10${n}`;
  const V = `VFD-10${n}`;
  const q = (ctx) => ctx.plant.drv[i];
  return [
    inp(`I.P${n}_RUN`, TYPE.BOOL, undefined,
      `${P} running — the starter is in and the shaft is turning`,
      (ctx) => q(ctx).state === DRIVE.RUNNING),
    inp(`I.P${n}_CALLED`, TYPE.BOOL, undefined,
      `${P} called — a start has been accepted, including the permissive delay before it moves`,
      (ctx) => isCalled(q(ctx))),
    inp(`I.P${n}_AVAIL`, TYPE.BOOL, undefined,
      `${P} available to the sequence — healthy and not locked out at the panel`,
      (ctx) => q(ctx).state !== DRIVE.TRIPPED && ctx.staging.hand[i] !== HAND.OFF),
    inp(`I.P${n}_FAULT`, TYPE.BOOL, undefined,
      `${P} tripped — the drive has locked out and will not restart until it is reset`,
      (ctx) => q(ctx).state === DRIVE.TRIPPED),
    inp(`I.P${n}_AUTO`, TYPE.BOOL, undefined,
      `${P} selector in AUTO — the sequence owns this machine`,
      (ctx) => ctx.staging.hand[i] === HAND.AUTO),
    inp(`I.P${n}_SPEED`, TYPE.REAL, '%',
      `${P} shaft speed, percent of rated — the number on the drive keypad, not the reference`,
      (ctx) => q(ctx).n_pct, { min: 0, max: 100 }),
    inp(`I.P${n}_CURRENT`, TYPE.REAL, '%FLA',
      `${V} motor current as a percentage of full-load amps`,
      (ctx) => q(ctx).i_pct, { min: 0, max: 250 }),
    inp(`I.P${n}_POWER`, TYPE.REAL, 'kW',
      `${V} electrical power at the drive input`,
      (ctx) => q(ctx).pElec_kW, { min: 0, max: 25 }),
    inp(`I.P${n}_THERMAL`, TYPE.REAL, '%',
      `${V} motor thermal capacity used — the overload locks out when this reaches its trip point`,
      (ctx) => q(ctx).thermal_pct, { min: 0, max: 150 }),
    inp(`I.P${n}_HOURS`, TYPE.REAL, 'h',
      `${P} cumulative run hours — what duty rotation is shared out on`,
      (ctx) => q(ctx).runtime_h, { min: 0 }),
    inp(`I.P${n}_STARTS`, TYPE.INT, undefined,
      `${P} cumulative starts — short cycling shows up here long before it shows up as a failure`,
      (ctx) => int(q(ctx).starts), { min: 0 }),
    inp(`I.P${n}_FLOW`, TYPE.REAL, 'm3/h',
      `${P} flow through the impeller, recirculation included`,
      (ctx) => ctx.plant.Q_m3h[i], { min: 0, max: 150 }),
    inp(`I.P${n}_HEAD`, TYPE.REAL, 'm',
      `${P} head developed across the machine`,
      (ctx) => ctx.plant.Hp_m[i], { min: 0, max: 150 }),
    inp(`I.P${n}_NPSH_M`, TYPE.REAL, 'm',
      `${P} suction margin, NPSH available less NPSH required — negative means it is cavitating`,
      (ctx) => ctx.plant.npsha_m[i] - ctx.plant.npshr_m[i], { min: -20, max: 30 }),
    inp(`I.P${n}_CAV`, TYPE.BOOL, undefined,
      `${P} cavitating — vapour is collapsing in the eye and the impeller is being eroded now`,
      (ctx) => ctx.plant.npsha_m[i] < ctx.plant.npshr_m[i]),
    inp(`I.P${n}_MINFLOW`, TYPE.BOOL, undefined,
      `${P} below its minimum continuous flow — it is heating the liquid rather than moving it`,
      (ctx) => ctx.plant.Q_m3h[i]
        < minimumFlow(ctx.config, ctx.plant, i).governing_m3h && isCalled(ctx.plant.drv[i])),
    inp(`I.P${n}_CHECK_SHUT`, TYPE.BOOL, undefined,
      `NRV-10${n} holding shut — ${P} is turning but the header is above the head it can make`,
      (ctx) => ctx.plant.checkShut[i] === 1),
    inp(`I.P${n}_VIB`, TYPE.REAL, 'mm/s',
      `${P} overall vibration velocity, ISO 10816 RMS`,
      (ctx) => ctx.plant.vib_mms[i], { min: 0, max: 50 }),
    inp(`I.P${n}_TCASE`, TYPE.REAL, 'degC',
      `${P} casing liquid temperature — this is what climbs when the recirculation is shut`,
      (ctx) => ctx.plant.Tcasing_C[i], { min: -50, max: 250 }),
    inp(`I.P${n}_WEAR`, TYPE.REAL, '%',
      `${P} wear-ring condition, 0 as new and 100 scrap`,
      (ctx) => ctx.plant.wear[i] * 100, { min: 0, max: 100 }),

    // The annunciated conditions for this machine, straight off the alarm list so the ladder and
    // the alarm banner can never disagree about what is standing.
    inp(`I.ALM_P${n}_TRIP`, TYPE.BOOL, undefined,
      `${P} tripped — the machine is locked out and the set is down to one`,
      (ctx) => alarmOn(ctx, `TRIP_${i}`)),
    inp(`I.ALM_P${n}_CAV`, TYPE.BOOL, undefined,
      `${P} cavitating — the impeller is being eroded for as long as this stands`,
      (ctx) => alarmOn(ctx, `CAV_${i}`)),
    inp(`I.ALM_P${n}_NPSH`, TYPE.BOOL, undefined,
      `${P} suction margin below the minimum — cavitation is the next thing to happen`,
      (ctx) => alarmOn(ctx, `NPSH_${i}`)),
    inp(`I.ALM_P${n}_MINQ`, TYPE.BOOL, undefined,
      `${P} below minimum continuous flow — open the recirculation or stop the machine`,
      (ctx) => alarmOn(ctx, `MINQ_${i}`)),
    inp(`I.ALM_P${n}_VIB`, TYPE.BOOL, undefined,
      `${P} vibration outside ISO zone B — it is running well away from best efficiency`,
      (ctx) => alarmOn(ctx, `VIB_${i}`) || alarmOn(ctx, `VIBW_${i}`)),
    inp(`I.ALM_P${n}_THERM`, TYPE.BOOL, undefined,
      `${V} motor overload approaching its trip — the machine is about to lock itself out`,
      (ctx) => alarmOn(ctx, `THERM_${i}`)),
    inp(`I.ALM_P${n}_TCAS`, TYPE.BOOL, undefined,
      `${P} casing temperature high — the liquid in it is heading for its vapour pressure`,
      (ctx) => alarmOn(ctx, `TCAS_${i}`) || alarmOn(ctx, `TRISE_${i}`)),
  ];
}

/**
 * Every command this rig sends to one machine.
 *
 * All four are momentary: a machine's placement is one three-position selector, and three coils
 * that each maintained their position would spend every scan undoing one another. On a rising
 * edge, whichever coil was just energised is the command and a held coil does nothing.
 *
 * @param {number} i pump index, 0-based
 * @returns {object[]} the points for that machine
 */
function pumpOutputs(i) {
  const n = i + 1;
  const P = `P-10${n}`;
  return [
    out(`Q.P${n}_AUTO`, TYPE.BOOL, undefined,
      `${P} to AUTO — hand the machine back to the sequence`,
      (ctx) => ctx.staging.hand[i] === HAND.AUTO,
      (ctx, sim, v) => {
        const b = asBool(`Q.P${n}_AUTO`, v);
        if (!b.ok) return b;
        if (!b.v || ctx.staging.hand[i] === HAND.AUTO) return OK;
        return act(sim, 'autoPump', ctx, i);
      }, { edge: true }),
    out(`Q.P${n}_START`, TYPE.BOOL, undefined,
      `${P} start — hold the machine running whatever the sequence wants`,
      (ctx) => ctx.staging.hand[i] === HAND.HAND,
      (ctx, sim, v) => {
        const b = asBool(`Q.P${n}_START`, v);
        if (!b.ok) return b;
        if (!b.v || ctx.staging.hand[i] === HAND.HAND) return OK;
        if (ctx.plant.drv[i].state === DRIVE.TRIPPED) {
          return refuse(`${P} is tripped — the start command will not be accepted until the `
            + 'overload has been reset');
        }
        return act(sim, 'startPump', ctx, i);
      }, { edge: true }),
    out(`Q.P${n}_STOP`, TYPE.BOOL, undefined,
      `${P} stop — lock the machine out and let the sequence stage around it`,
      (ctx) => ctx.staging.hand[i] === HAND.OFF,
      (ctx, sim, v) => {
        const b = asBool(`Q.P${n}_STOP`, v);
        if (!b.ok) return b;
        if (!b.v || ctx.staging.hand[i] === HAND.OFF) return OK;
        return act(sim, 'stopPump', ctx, i);
      }, { edge: true }),
    out(`Q.P${n}_RESET`, TYPE.BOOL, undefined,
      `${P} overload reset — only accepted once the bimetal has cooled`,
      () => false,
      (ctx, sim, v) => {
        const b = asBool(`Q.P${n}_RESET`, v);
        if (!b.ok) return b;
        if (!b.v || ctx.plant.drv[i].state !== DRIVE.TRIPPED) return OK;
        return act(sim, 'resetPump', ctx, i);
      }, { edge: true }),
  ];
}

/**
 * The complete IO rack, as built for the two-pump skid.
 *
 * Frozen, because the wiring is not a run-time decision: a program that could add a point to its
 * own IO list is a program whose cross-reference is a work of fiction.
 */
export const IO_POINTS = Object.freeze([
  // --- process measurements ------------------------------------------------------------------
  inp('I.PT101', TYPE.REAL, 'bar',
    'PT-101 header pressure, as the transmitter reads it — filtered, delayed and noisy',
    (ctx) => ctx.plant.pt_bar, { min: 0, max: 8 }),
  inp('I.PT102', TYPE.REAL, 'bar',
    'PT-102 suction pressure at the pump centreline — the static column standing on the eye',
    (ctx) => headToBar(ctx.plant.zStatic_m, ctx.plant.fluid.rho_kgm3), { min: -1, max: 3 }),
  inp('I.FT101', TYPE.REAL, 'm3/h',
    'FT-101 flow to process — what leaves the skid, recirculation excluded',
    (ctx) => ctx.plant.ft_m3h, { min: 0, max: 150 }),
  inp('I.FT102', TYPE.REAL, 'm3/h',
    'Total discharge flow off the pumps, recirculation included',
    (ctx) => ctx.plant.Qtotal_m3h, { min: 0, max: 300 }),
  inp('I.FT103', TYPE.REAL, 'm3/h',
    'RO-101 minimum-flow recirculation returning to TK-101',
    (ctx) => ctx.plant.Qbypass_m3h, { min: 0, max: 50 }),
  inp('I.LT101', TYPE.REAL, 'm',
    'LT-101 suction tank level',
    (ctx) => ctx.plant.lt_m, { min: 0, max: 4 }),
  inp('I.TT101', TYPE.REAL, 'degC',
    'TT-101 tank temperature — a slow thermowell, and the thing that raises vapour pressure',
    (ctx) => ctx.plant.tt_C, { min: 0, max: 100 }),
  inp('I.HDR_VEL', TYPE.REAL, 'm/s',
    'Velocity in the 150 mm discharge line — the column whose inertia makes a slam a surge',
    (ctx) => ctx.plant.vDischarge_ms, { min: 0, max: 20 }),
  inp('I.PATM', TYPE.REAL, 'bara',
    'Site barometric pressure — a fifth of the NPSH available at altitude is simply gone',
    (ctx) => ctx.plant.pAtm_bar, { min: 0.5, max: 1.1 }),
  inp('I.MAKEUP', TYPE.REAL, 'm3/h',
    'Make-up flow into TK-101',
    (ctx) => ctx.plant.inflow_m3h, { min: 0, max: 200 }),

  // --- final elements ----------------------------------------------------------------------
  inp('I.FCV101_POS', TYPE.REAL, '%',
    'FCV-101 demand valve stem position — the LOAD, not a control element',
    (ctx) => ctx.plant.fcv.x * 100, { min: 0, max: 100 }),
  inp('I.PCV101_POS', TYPE.REAL, '%',
    'PCV-101 throttle valve stem position, wide open on variable speed',
    (ctx) => ctx.plant.pcv.x * 100, { min: 0, max: 100 }),
  inp('I.RO101_POS', TYPE.REAL, '%',
    'RO-101 recirculation valve travel',
    (ctx) => ctx.plant.bypass * 100, { min: 0, max: 100 }),
  inp('I.RECIRC_AUTO', TYPE.BOOL, undefined,
    'RO-101 in its automatic recirculation mode — the self-contained minimum-flow protection',
    (ctx) => ctx.plant.recircMode === RECIRC.ARV),
  inp('I.ON_THROTTLE', TYPE.BOOL, undefined,
    'The loop is modulating PCV-101 with the pumps at fixed speed, not modulating the drives',
    (ctx) => ctx.plant.finalElement === FINAL.THROTTLE),

  // --- per machine ---------------------------------------------------------------------------
  ...pumpInputs(0),
  ...pumpInputs(1),

  // --- the controller ------------------------------------------------------------------------
  inp('I.PIC_PV', TYPE.REAL, 'EU',
    'PIC-101 measurement in the loop\'s own engineering units',
    (ctx) => measuredPV(ctx.plant, ctx.run.mode)),
  inp('I.PIC_SP', TYPE.REAL, 'EU',
    'PIC-101 working setpoint, after any ramp or reset schedule',
    (ctx) => ctx.pid.sp),
  inp('I.PIC_CO', TYPE.REAL, '%',
    'Output actually going to the final element, after feedforward, overrides and staging bias',
    (ctx) => ctx.run.co_pct, { min: 0, max: 100 }),
  inp('I.PIC_ERR', TYPE.REAL, 'EU',
    'PIC-101 error, setpoint less measurement',
    (ctx) => ctx.pid.err),
  inp('I.PIC_AUTO', TYPE.BOOL, undefined,
    'PIC-101 in automatic — false means an operator or a test owns the output',
    (ctx) => ctx.pid.mode !== MODE.MAN),
  inp('I.PIC_MODE', TYPE.STRING, undefined,
    'PIC-101 mode as the faceplate shows it: AUTO, MAN or CASCADE',
    (ctx) => String(ctx.pid.mode)),
  inp('I.PIC_SAT', TYPE.BOOL, undefined,
    'PIC-101 output pinned against a limit — there is no more machine to ask for',
    (ctx) => !!ctx.pid.saturated),
  inp('I.LOOP_MODE', TYPE.STRING, undefined,
    'Which variable the loop is controlling: PRESSURE, FLOW or LEVEL',
    (ctx) => String(ctx.run.mode)),

  // --- the sequence --------------------------------------------------------------------------
  inp('I.SEQ_ENABLED', TYPE.BOOL, undefined,
    'The built-in staging sequence is enabled — turn it off to let ladder logic stage the set',
    (ctx) => !!ctx.stagingCfg.enabled),
  inp('I.SEQ_LEAD', TYPE.INT, undefined,
    'Which machine is lead, 1 or 2',
    (ctx) => int(ctx.staging.lead + 1), { min: 1, max: 2 }),
  inp('I.SEQ_RUNNING', TYPE.INT, undefined,
    'How many machines are running',
    (ctx) => int(runningCount(ctx.plant)), { min: 0, max: 2 }),
  inp('I.SEQ_SLEEPING', TYPE.BOOL, undefined,
    'The set is asleep on a satisfied header, waiting for the pressure to droop',
    (ctx) => !!ctx.staging.sleeping),
  inp('I.SEQ_STARTS_H', TYPE.REAL, '1/h',
    'Starts per hour across the set — most starters are rated for six to ten',
    (ctx) => startsPerHour(ctx.staging, Math.max(ctx.run.t_s / 3600, 1e-9)), { min: 0 }),

  // --- annunciated process and control conditions ---------------------------------------------
  inp('I.ALM_PT_HH', TYPE.BOOL, undefined, 'PT-101 high high — relief protection is what is left',
    (ctx) => alarmOn(ctx, 'PT_HH')),
  inp('I.ALM_PT_HI', TYPE.BOOL, undefined,
    'PT-101 header pressure high — the loop is overshooting or the demand has collapsed',
    (ctx) => alarmOn(ctx, 'PT_HI')),
  inp('I.ALM_PT_LO', TYPE.BOOL, undefined,
    'PT-101 header pressure low — the set is not keeping up with what the process is drawing',
    (ctx) => alarmOn(ctx, 'PT_LO')),
  inp('I.ALM_PT_LL', TYPE.BOOL, undefined, 'PT-101 low low — the process is not being supplied',
    (ctx) => alarmOn(ctx, 'PT_LL')),
  inp('I.ALM_LT_LO', TYPE.BOOL, undefined,
    'TK-101 level low — the suction margin is falling with it',
    (ctx) => alarmOn(ctx, 'LT_LO')),
  inp('I.ALM_LT_LL', TYPE.BOOL, undefined, 'TK-101 level low low — dry-run risk',
    (ctx) => alarmOn(ctx, 'LT_LL')),
  inp('I.ALM_SURGE', TYPE.BOOL, undefined,
    'Pressure transient — the discharge column is being stopped by pressure',
    (ctx) => alarmOn(ctx, 'SURGE')),
  inp('I.ALM_DEV', TYPE.BOOL, undefined,
    'PIC-101 off setpoint for longer than the deviation delay — the loop is not holding',
    (ctx) => alarmOn(ctx, 'DEV')),
  inp('I.ALM_CYCLE', TYPE.BOOL, undefined,
    'The sequence is short-cycling the machines — widen the hysteresis or lengthen the timers',
    (ctx) => alarmOn(ctx, 'CYCLE')),
  inp('I.ALM_ARV_SHUT', TYPE.BOOL, undefined,
    'Minimum-flow recirculation shut with pumps running — the protection is defeated',
    (ctx) => alarmOn(ctx, 'ARV_SHUT')),
  inp('I.ALM_ANY', TYPE.BOOL, undefined,
    'Anything at all is standing in alarm or warning — the summary bit the horn hangs off',
    (ctx) => !!ctx.run.worst),
  inp('I.ALM_CRITICAL', TYPE.BOOL, undefined,
    'At least one condition is at ALARM severity — something needs protecting now',
    (ctx) => ctx.run.worst === 'ALARM'),
  inp('I.ALM_UNACK', TYPE.INT, undefined,
    'How many alarm rows are waiting to be acknowledged',
    (ctx) => int(unacked(ctx)), { min: 0 }),
  inp('I.ALM_COUNT', TYPE.INT, undefined,
    'How many rows are on the alarm list, cleared-but-unacknowledged rows included',
    (ctx) => int(ctx.run.alarmList ? ctx.run.alarmList.length : 0), { min: 0 }),
  inp('I.ALM_WORST', TYPE.STRING, undefined,
    'Worst active severity: ALARM, WARN, INFO, or empty when the list is quiet',
    (ctx) => String(ctx.run.worst || '')),

  // --- energy and the run clock -----------------------------------------------------------------
  inp('I.KW_TOTAL', TYPE.REAL, 'kW',
    'Electrical power drawn by the whole skid',
    (ctx) => electricalPower_kW(ctx.plant), { min: 0, max: 60 }),
  inp('I.KWH_TOTAL', TYPE.REAL, 'kWh',
    'Cumulative electrical energy since the meter was reset',
    (ctx) => ctx.run.energy.kWh, { min: 0 }),
  inp('I.M3_TOTAL', TYPE.REAL, 'm3',
    'Cumulative volume delivered to process since the meter was reset',
    (ctx) => ctx.run.energy.m3, { min: 0 }),
  inp('I.KWH_PER_M3', TYPE.REAL, 'kWh/m3',
    'Specific energy — the only pumping number worth putting on a monthly report',
    (ctx) => (ctx.run.energy.m3 > 0.01 ? ctx.run.energy.kWh / ctx.run.energy.m3 : 0), { min: 0 }),
  inp('I.RUN_TIME', TYPE.REAL, 's',
    'Simulated time since the rig was started — the processor\'s free-running clock',
    (ctx) => ctx.run.t_s, { min: 0 }),

  // --- machine commands -------------------------------------------------------------------------
  ...pumpOutputs(0),
  ...pumpOutputs(1),

  // --- controller commands ---------------------------------------------------------------------
  out('Q.PIC_SP', TYPE.REAL, 'EU',
    'PIC-101 setpoint in the loop\'s engineering units — this is what a recipe step writes',
    (ctx) => ctx.pid.spTarget,
    (ctx, sim, v) => {
      const r = asNum('Q.PIC_SP', v, -1e4, 1e4);
      if (!r.ok) return r;
      // Only a genuine change is passed on. `setSetpoint` writes a line to the operator's event
      // feed, and a setpoint re-announced five times a second would bury everything else in it.
      if (Math.abs(r.v - ctx.pid.spTarget) <= 1e-9) return OK;
      return act(sim, 'setSetpoint', ctx, r.v);
    }),
  out('Q.PIC_AUTO', TYPE.BOOL, undefined,
    'PIC-101 to AUTO when energised, to MANUAL when not',
    (ctx) => ctx.pid.mode !== MODE.MAN,
    (ctx, sim, v) => {
      const b = asBool('Q.PIC_AUTO', v);
      if (!b.ok) return b;
      const wantAuto = b.v;
      if (wantAuto === (ctx.pid.mode !== MODE.MAN)) return OK;
      return act(sim, 'setControllerMode', ctx, wantAuto ? MODE.AUTO : MODE.MAN);
    }),
  out('Q.PIC_MAN_CO', TYPE.REAL, '%',
    'PIC-101 output when it is in MANUAL',
    (ctx) => ctx.pid.coMan,
    (ctx, sim, v) => {
      const r = asNum('Q.PIC_MAN_CO', v, 0, 100);
      if (!r.ok) return r;
      if (Math.abs(r.v - ctx.pid.coMan) <= 1e-9) return OK;
      return act(sim, 'setManualOutput', ctx, r.v);
    }, {
      min: 0,
      max: 100,
      // In AUTO the manual station TRACKS the controller instead of driving it, which is what
      // makes the transfer to MANUAL bumpless. Leave the image where the program last put it and
      // the first scan in MANUAL steps the plant to a number nobody chose.
      tracks: (ctx) => ctx.pid.mode !== MODE.MAN,
    }),
  out('Q.LOOP_MODE', TYPE.STRING, undefined,
    'Which variable PIC-101 controls: PRESSURE, FLOW or LEVEL',
    (ctx) => String(ctx.run.mode),
    (ctx, sim, v) => {
      const r = asEnum('Q.LOOP_MODE', v, LOOP);
      if (!r.ok) return r;
      if (r.v === ctx.run.mode) return OK;
      return act(sim, 'setLoopMode', ctx, r.v);
    }),

  // --- sequence settings -------------------------------------------------------------------------
  out('Q.SEQ_ENABLE', TYPE.BOOL, undefined,
    'Let the built-in staging sequence start and stop machines — de-energise it to stage in ladder',
    (ctx) => !!ctx.stagingCfg.enabled,
    (ctx, sim, v) => {
      const b = asBool('Q.SEQ_ENABLE', v);
      if (!b.ok) return b;
      if (b.v === !!ctx.stagingCfg.enabled) return OK;
      return act(sim, 'setStaging', ctx, { enabled: b.v });
    }),
  out('Q.SEQ_UP_PCT', TYPE.REAL, '%',
    'Controller output above which the stage-up timer runs',
    (ctx) => ctx.stagingCfg.stageUp_pct,
    (ctx, sim, v) => {
      const r = asNum('Q.SEQ_UP_PCT', v, 0, 100);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.stageUp_pct) return OK;
      return act(sim, 'setStaging', ctx, { stageUp_pct: r.v });
    }, { min: 0, max: 100 }),
  out('Q.SEQ_DN_PCT', TYPE.REAL, '%',
    'Controller output below which the stage-down timer runs',
    (ctx) => ctx.stagingCfg.stageDown_pct,
    (ctx, sim, v) => {
      const r = asNum('Q.SEQ_DN_PCT', v, 0, 100);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.stageDown_pct) return OK;
      return act(sim, 'setStaging', ctx, { stageDown_pct: r.v });
    }, { min: 0, max: 100 }),
  out('Q.SEQ_UP_DLY', TYPE.REAL, 's',
    'How long the stage-up condition must hold before the lag machine starts',
    (ctx) => ctx.stagingCfg.stageUpDelay_s,
    (ctx, sim, v) => {
      const r = asNum('Q.SEQ_UP_DLY', v, 0, 3600);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.stageUpDelay_s) return OK;
      return act(sim, 'setStaging', ctx, { stageUpDelay_s: r.v });
    }, { min: 0, max: 600 }),
  out('Q.SEQ_DN_DLY', TYPE.REAL, 's',
    'How long the stage-down condition must hold before the lag machine stops',
    (ctx) => ctx.stagingCfg.stageDownDelay_s,
    (ctx, sim, v) => {
      const r = asNum('Q.SEQ_DN_DLY', v, 0, 3600);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.stageDownDelay_s) return OK;
      return act(sim, 'setStaging', ctx, { stageDownDelay_s: r.v });
    }, { min: 0, max: 600 }),
  out('Q.SEQ_MINRUN', TYPE.REAL, 's',
    'Minimum time a started machine must run before it may be stopped',
    (ctx) => ctx.stagingCfg.minRun_s,
    (ctx, sim, v) => {
      const r = asNum('Q.SEQ_MINRUN', v, 0, 3600);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.minRun_s) return OK;
      return act(sim, 'setStaging', ctx, { minRun_s: r.v });
    }, { min: 0, max: 600 }),
  out('Q.SEQ_MINSTOP', TYPE.REAL, 's',
    'Minimum time a stopped machine must rest before it may be restarted',
    (ctx) => ctx.stagingCfg.minStop_s,
    (ctx, sim, v) => {
      const r = asNum('Q.SEQ_MINSTOP', v, 0, 3600);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.minStop_s) return OK;
      return act(sim, 'setStaging', ctx, { minStop_s: r.v });
    }, { min: 0, max: 600 }),
  out('Q.SEQ_SLEEP', TYPE.BOOL, undefined,
    'Allow the set to stop its last machine on a satisfied header',
    (ctx) => !!ctx.stagingCfg.sleepEnabled,
    (ctx, sim, v) => {
      const b = asBool('Q.SEQ_SLEEP', v);
      if (!b.ok) return b;
      if (b.v === !!ctx.stagingCfg.sleepEnabled) return OK;
      return act(sim, 'setStaging', ctx, { sleepEnabled: b.v });
    }),
  out('Q.SEQ_ROTATE', TYPE.STRING, undefined,
    'Duty rotation policy: OFF, ON_STAGE_DOWN or RUNTIME',
    (ctx) => String(ctx.stagingCfg.rotate),
    (ctx, sim, v) => {
      const r = asEnum('Q.SEQ_ROTATE', v, ROTATE);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.rotate) return OK;
      return act(sim, 'setStaging', ctx, { rotate: r.v });
    }),
  out('Q.SEQ_CRITERION', TYPE.STRING, undefined,
    'What the sequence stages on: OUTPUT, FLOW or ENERGY',
    (ctx) => String(ctx.stagingCfg.criterion),
    (ctx, sim, v) => {
      const r = asEnum('Q.SEQ_CRITERION', v, CRITERION);
      if (!r.ok) return r;
      if (r.v === ctx.stagingCfg.criterion) return OK;
      return act(sim, 'setStaging', ctx, { criterion: r.v });
    }),
  out('Q.SEQ_LEAD', TYPE.INT, undefined,
    'Duty selection — which machine is lead, 1 or 2',
    (ctx) => int(ctx.staging.lead + 1),
    (ctx, sim, v) => {
      const r = asNum('Q.SEQ_LEAD', v, 1, 2);
      if (!r.ok) return r;
      if (!Number.isInteger(r.v)) {
        return refuse(`Q.SEQ_LEAD was written ${v} — the lead machine is 1 or 2, not a fraction`);
      }
      if (r.v - 1 === ctx.staging.lead) return OK;
      // There is no operator action for lead selection: on the panel it is a consequence of
      // rotation, not a button. `staging.lead` is a documented field of the sequence state and an
      // index into it is the whole of the change, so this one point writes it directly.
      ctx.staging.lead = r.v - 1;
      return OK;
    }, { min: 1, max: 2 }),

  // --- plant commands ----------------------------------------------------------------------------
  out('Q.RECIRC_MODE', TYPE.STRING, undefined,
    'RO-101 operating mode: ARV automatic, MANUAL travel, or CLOSED',
    (ctx) => String(ctx.plant.recircMode),
    (ctx, sim, v) => {
      const r = asEnum('Q.RECIRC_MODE', v, RECIRC);
      if (!r.ok) return r;
      if (r.v === ctx.plant.recircMode) return OK;
      return act(sim, 'setDisturbance', ctx, { recircMode: r.v });
    }),
  out('Q.RECIRC_POS', TYPE.REAL, '%',
    'RO-101 travel command — only in command while the valve is in MANUAL',
    (ctx) => ctx.plant.bypass * 100,
    (ctx, sim, v) => {
      const r = asNum('Q.RECIRC_POS', v, 0, 100);
      if (!r.ok) return r;
      if (Math.abs(r.v / 100 - ctx.plant.bypass) <= 1e-9) return OK;
      return act(sim, 'setDisturbance', ctx, { bypass: r.v / 100 });
    }, {
      min: 0,
      max: 100,
      // In ARV the valve is a self-contained mechanical device and the plant repositions it every
      // tick. Tracking it rather than fighting it keeps the image honest AND means the changeover
      // to MANUAL happens at the travel the valve is already at.
      tracks: (ctx) => ctx.plant.recircMode !== RECIRC.MANUAL,
    }),
  out('Q.FCV101_CMD', TYPE.REAL, '%',
    'FCV-101 demand valve command — the load the recipe asks the process to draw',
    (ctx) => ctx.plant.demandTarget * 100,
    (ctx, sim, v) => {
      const r = asNum('Q.FCV101_CMD', v, 0, 100);
      if (!r.ok) return r;
      if (Math.abs(r.v / 100 - ctx.plant.demandTarget) <= 1e-9) return OK;
      return act(sim, 'setDisturbance', ctx, { demandTarget: r.v / 100 });
    }, { min: 0, max: 100 }),
  out('Q.FIXED_SPEED', TYPE.REAL, '%',
    'Shaft speed the machines are held at while PCV-101 is the final control element',
    (ctx) => ctx.plant.fixedSpeed_pct,
    (ctx, sim, v) => {
      const r = asNum('Q.FIXED_SPEED', v, 0, 100);
      if (!r.ok) return r;
      if (Math.abs(r.v - ctx.plant.fixedSpeed_pct) <= 1e-9) return OK;
      return act(sim, 'setDisturbance', ctx, { fixedSpeed_pct: r.v });
    }, { min: 0, max: 100 }),
  out('Q.FINAL_ELEMENT', TYPE.STRING, undefined,
    'Which element the loop modulates: VFD for variable speed, THROTTLE for PCV-101',
    (ctx) => String(ctx.plant.finalElement),
    (ctx, sim, v) => {
      const r = asEnum('Q.FINAL_ELEMENT', v, FINAL);
      if (!r.ok) return r;
      if (r.v === ctx.plant.finalElement) return OK;
      return act(sim, 'setDisturbance', ctx, { finalElement: r.v });
    }),

  // --- annunciator and recipe display -------------------------------------------------------------
  out('Q.ALARM_ACK', TYPE.BOOL, undefined,
    'Acknowledge every standing alarm — the ladder\'s half of the horn silence button',
    () => false,
    (ctx, sim, v) => {
      const b = asBool('Q.ALARM_ACK', v);
      if (!b.ok) return b;
      // Acknowledging nothing still writes "nothing to acknowledge" to the event feed, so the
      // command is only passed on when there is genuinely something waiting.
      if (!b.v || unacked(ctx) === 0) return OK;
      return act(sim, 'ackAlarms', ctx);
    }, { edge: true }),
  out('Q.HORN', TYPE.BOOL, undefined,
    'Annunciator horn — sounds until the operator acknowledges',
    (ctx) => !!panelOf(ctx).horn,
    (ctx, sim, v) => {
      const b = asBool('Q.HORN', v);
      if (!b.ok) return b;
      panelOf(ctx).horn = b.v;
      return OK;
    }),
  out('Q.LAMP_ALARM', TYPE.BOOL, undefined,
    'Red panel lamp — something is standing at ALARM severity',
    (ctx) => !!panelOf(ctx).lampAlarm,
    (ctx, sim, v) => {
      const b = asBool('Q.LAMP_ALARM', v);
      if (!b.ok) return b;
      panelOf(ctx).lampAlarm = b.v;
      return OK;
    }),
  out('Q.LAMP_WARN', TYPE.BOOL, undefined,
    'Amber panel lamp — something is standing at WARN severity',
    (ctx) => !!panelOf(ctx).lampWarn,
    (ctx, sim, v) => {
      const b = asBool('Q.LAMP_WARN', v);
      if (!b.ok) return b;
      panelOf(ctx).lampWarn = b.v;
      return OK;
    }),
  out('Q.LAMP_P1', TYPE.BOOL, undefined,
    'Green running lamp above P-101 on the panel',
    (ctx) => !!panelOf(ctx).lampP1,
    (ctx, sim, v) => {
      const b = asBool('Q.LAMP_P1', v);
      if (!b.ok) return b;
      panelOf(ctx).lampP1 = b.v;
      return OK;
    }),
  out('Q.LAMP_P2', TYPE.BOOL, undefined,
    'Green running lamp above P-102 on the panel',
    (ctx) => !!panelOf(ctx).lampP2,
    (ctx, sim, v) => {
      const b = asBool('Q.LAMP_P2', v);
      if (!b.ok) return b;
      panelOf(ctx).lampP2 = b.v;
      return OK;
    }),
  out('Q.REC_STEP', TYPE.INT, undefined,
    'Recipe step number the sequencer and the display are showing',
    (ctx) => int(panelOf(ctx).recipeStep),
    (ctx, sim, v) => {
      const r = asNum('Q.REC_STEP', v, 0, 999);
      if (!r.ok) return r;
      if (!Number.isInteger(r.v)) {
        return refuse(`Q.REC_STEP was written ${v} — a step number is a whole number`);
      }
      panelOf(ctx).recipeStep = r.v;
      return OK;
    }, { min: 0, max: 999 }),
  out('Q.REC_HOLD', TYPE.BOOL, undefined,
    'Recipe held — the step timer stops and the sequencer will not advance',
    (ctx) => !!panelOf(ctx).recipeHold,
    (ctx, sim, v) => {
      const b = asBool('Q.REC_HOLD', v);
      if (!b.ok) return b;
      panelOf(ctx).recipeHold = b.v;
      return OK;
    }),
].map((p) => Object.freeze(p)));

/** Index for {@link ioPoint}, built once because a linear search per instruction is silly. */
const BY_TAG = new Map(IO_POINTS.map((p) => [p.tag, p]));

/**
 * The processor's own bookkeeping bit: has the output image been read back from the field yet?
 *
 * It lives in the tag database rather than in a closure so that it survives `snapshotTags` and
 * `restoreTags` along with everything else — restoring a saved session must not re-prime the
 * outputs and throw away the program's commands.
 */
const PRIMED_TAG = 'S.IO_PRIMED';

/** Refusals raised by the last output scan, per database. Diagnostics, not plant state. */
const FAULTS = new WeakMap();

/**
 * The previous state of every momentary output, per database, so a rising edge can be recognised.
 *
 * It sits beside the database rather than in it because it is the rack's own bookkeeping, exactly
 * as the fault list is: it describes the scan that just happened, not the state of the plant, and
 * nothing in a saved session should carry it. Keyed weakly so a discarded database takes its
 * bookkeeping with it.
 *
 * @type {WeakMap<object, Map<string, boolean>>}
 */
const EDGES = new WeakMap();

/**
 * The rack's per-database bookkeeping, created on first use.
 * @param {object} db the tag database
 * @returns {Map<string, boolean>} the previous state of each momentary output
 */
function edgesOf(db) {
  let m = EDGES.get(db);
  if (!m) { m = new Map(); EDGES.set(db, m); }
  return m;
}

/**
 * Whether a value read out of the output image counts as energised.
 * @param {*} v the value
 * @returns {boolean} true for `true` and for the integer 1
 */
const energised = (v) => v === true || v === 1;

/**
 * Define a tag in the database for every point in the rack, plus the scan's own bookkeeping bit.
 *
 * Re-definition is not an error worth stopping for — installing onto a database that already has
 * the rack is exactly what reloading a program does — so a duplicate is reported and skipped.
 *
 * @param {object} db the tag database from `createTagDb`
 * @returns {void}
 */
export function installIo(db) {
  for (const p of IO_POINTS) {
    defineTag(db, {
      name: p.tag,
      type: p.type,
      scope: p.dir === 'in' ? SCOPE.INPUT : SCOPE.OUTPUT,
      desc: p.desc,
      unit: p.unit,
      min: p.min,
      max: p.max,
    });
  }
  defineTag(db, {
    name: PRIMED_TAG,
    type: TYPE.BOOL,
    scope: SCOPE.SYSTEM,
    desc: 'The output image has been read back from the field; the rack is in command',
  });
  FAULTS.set(db, []);
}

/**
 * Look a point up by tag.
 * @param {string} tag the symbolic name
 * @returns {object|null} the point, or null when nothing is wired to that name
 */
export function ioPoint(tag) {
  return BY_TAG.get(tag) || null;
}

/**
 * Read the output image back from the plant, so a freshly loaded program starts from where the
 * rig already is instead of commanding every output to zero.
 *
 * @param {object} db the tag database
 * @param {object} ctx the sim context
 * @returns {void}
 */
export function primeOutputs(db, ctx) {
  const edges = edgesOf(db);
  for (const p of IO_POINTS) {
    if (p.dir !== 'out') continue;
    const v = p.read(ctx);
    rawWrite(db, p.tag, v);
    // Seed the edge memory from the readback too, or a machine that is ALREADY in auto would see
    // a spurious rising edge on the first scan and be re-placed where it already was.
    if (p.edge) edges.set(p.tag, energised(v));
  }
  rawWrite(db, PRIMED_TAG, true);
}

/**
 * Sample the whole plant into the input image. Runs once, at the top of the scan, before a single
 * rung is solved.
 *
 * Values go in with `rawWrite`, which passes under any force: the field keeps being collected so
 * the tag browser can show what the transmitter really says, while the logic reads the forced
 * value through `readTag`.
 *
 * @param {object} db the tag database
 * @param {object} ctx the sim context
 * @returns {void}
 */
export function scanInputs(db, ctx) {
  if (!rawRead(db, PRIMED_TAG)) primeOutputs(db, ctx);
  for (const p of IO_POINTS) {
    if (p.dir !== 'in') continue;
    rawWrite(db, p.tag, p.read(ctx));
  }
}

/**
 * Apply the whole output image to the plant. Runs once, at the bottom of the scan, after the last
 * rung has been solved.
 *
 * Values come out through `readTag`, which honours a force, because forcing an output is the
 * whole reason the feature exists. A maintained point is guarded and idempotent, so holding a coil
 * means "keep it this way" rather than re-issuing the command on every scan; a momentary point —
 * start, stop, auto, reset, acknowledge — commands on the rising edge and is inert while it is
 * simply held, which is how the pushbuttons on the starter door behave. Anything a point refuses is
 * collected for {@link ioFaults} rather than thrown, because a rack that halted the processor on a
 * bad number would be a worse failure than the number.
 *
 * @param {object} db the tag database
 * @param {object} ctx the sim context
 * @param {object} sim the `src/core/sim.js` action surface
 * @returns {void}
 */
export function scanOutputs(db, ctx, sim) {
  let faults = FAULTS.get(db);
  if (!faults) { faults = []; FAULTS.set(db, faults); }
  faults.length = 0;
  if (!rawRead(db, PRIMED_TAG)) { primeOutputs(db, ctx); return; }

  const edges = edgesOf(db);
  for (const p of IO_POINTS) {
    if (p.dir !== 'out') continue;
    if (p.tracks && p.tracks(ctx)) {
      rawWrite(db, p.tag, p.read(ctx));
      continue;
    }
    const v = readTag(db, p.tag);
    if (p.edge) {
      const was = edges.get(p.tag) === true;
      const now = energised(v);
      edges.set(p.tag, now);
      if (!(now && !was)) continue;
    }
    const res = p.write(ctx, sim, v);
    if (res && res.ok === false) faults.push({ tag: p.tag, reason: res.reason });
  }
}

/**
 * What the last output scan refused, and why.
 *
 * A real rack lights an IO fault LED and leaves the plant alone; this is the same idea in a form
 * a panel or a test can read. The list is replaced every scan, so it always describes the scan
 * that just happened rather than accumulating history nobody will read.
 *
 * @param {object} db the tag database
 * @returns {Array<{tag:string, reason:string}>} the refusals from the most recent output scan
 */
export function ioFaults(db) {
  return FAULTS.get(db) || [];
}
