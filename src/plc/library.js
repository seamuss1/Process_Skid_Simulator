/**
 * src/plc/library.js — the stock ladder programs, and the memory, timer, counter and recipe tags
 * they run on.
 *
 * Layer L5 (src/plc): imports `plc/model.js` and `plc/tags.js` only. No DOM, no window, no clock,
 * no randomness — every program here is parsed and scanned in a Node test.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A LIBRARY AND NOT A HARD-CODED SEQUENCE
 *
 * The rig already stages its own pumps: `src/control/staging.js` starts the lag, rotates the
 * duty, holds the minimum-run timer and puts the set to sleep, and none of that is visible to the
 * person operating it. {@link STOCK_PROGRAMS}`[0]` — DEFAULT_STATION — is that same sequence
 * written as ladder, rung by rung, with a comment on every rung saying what it is defending
 * against. It is the first thing a user opens, so it is the one that has to be genuinely good: a
 * reader who cannot find the rung that starts the lag pump has not been taught anything.
 *
 * DEFAULT_STATION therefore holds the built-in sequence OFF (rung 1, `Q.SEQ_ENABLE`) and drives
 * the machines itself. The two are alternatives, never partners: leave both running and they
 * fight over the same starters.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT THE LADDER CANNOT REPRODUCE, SAID OUT LOUD
 *
 * Three things in `staging.js` do not survive the translation, and each one is admitted in the
 * rung comment where it belongs rather than quietly dropped:
 *
 *   1. THE STAGING BIAS. On a stage transition the sequence multiplies the controller output by
 *      0.72 or 1.30 and preloads that into the integral, so the loop resumes from the biased
 *      point. No instruction in this set can write a controller's integral — PID commands the
 *      loop, it does not reach inside it — so the ladder stages without the bias and the header
 *      takes a little more of the transition than it would otherwise. It is the one place the
 *      ladder is measurably worse than the built-in sequence.
 *   2. THE FLOW AND ENERGY CRITERIA. `staging.js` will stage on total flow or on predicted
 *      electrical power. This program stages on controller output, which is what most sets in the
 *      field do and what needs no extra instrument. Staging on `I.FT102` instead is two edits to
 *      one rung, and is a good first exercise.
 *   3. STRING COMMANDS. `Q.RECIRC_MODE`, `Q.LOOP_MODE`, `Q.SEQ_ROTATE`, `Q.SEQ_CRITERION` and
 *      `Q.FINAL_ELEMENT` are STRING outputs, and no instruction in `instructions.js` writes a
 *      string — MOV resolves its source as a number. So the ladder can read the recirculation
 *      valve's mode but cannot select it, and the minimum-flow rung says so where it matters.
 *
 * ------------------------------------------------------------------------------------------
 * HOUSE STYLE FOR THE PROGRAM TEXT
 *
 * Every program is stored as TEXT in the grammar `model.js` documents, because text is what
 * diffs, what a user can paste into a forum post, and what survives a change to the internal
 * tree. `programFor` parses it on demand and hands back a fresh document each time, so two
 * callers editing "the same" stock program cannot corrupt each other.
 *
 * Rung comments carry the meaning. A `;` line is legal anywhere and is skipped by the parser, but
 * it is NOT part of the document, so anything written on one is lost the moment a user saves from
 * the editor. Everything worth keeping goes on the RUNG line.
 *
 * Naming: `M.` for the program's own bits, `T.`/`C.` for its timers and counters, `REC.` for the
 * four tags the recipe sequencer publishes. Anything the operator presses ends in `_PB`, and the
 * HMI writes those; the ladder only ever reads them.
 * ------------------------------------------------------------------------------------------
 */

import { programFromText } from './model.js';
import { TYPE, SCOPE, defineTags } from './tags.js';

/** The program a fresh processor comes up with. */
export const DEFAULT_PROGRAM_ID = 'DEFAULT_STATION';

/**
 * Every tag the stock programs address that the IO rack does not already provide.
 *
 * The IO map defines `I.` and `Q.`, `installSystemTags` defines `S.`, and nothing defines the
 * working storage a program needs — so a stock program loaded into a database carrying only the
 * rack fails validation on its first `M.` operand. These are that working storage, declared in
 * one table so the tag browser can describe them and the cross-reference can resolve them.
 *
 * Frozen: the tag list of a shipped program is not a run-time decision.
 */
export const PROGRAM_TAGS = Object.freeze([
  // --- the station's own bits ----------------------------------------------------------------
  Object.freeze({ name: 'M.ESTOP', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'emergency stop — breaks the station permissive' }),
  Object.freeze({ name: 'M.PERMIT', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'station permissive: it is safe to call a machine' }),
  Object.freeze({ name: 'M.ACK_PB', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'alarm acknowledge pushbutton, written by the HMI' }),
  Object.freeze({ name: 'M.RESET_PB', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'overload reset pushbutton, written by the HMI' }),
  Object.freeze({ name: 'M.START_PB', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'start pushbutton, written by the HMI' }),
  Object.freeze({ name: 'M.STOP_PB', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'stop pushbutton, written by the HMI — wired normally closed on a real panel' }),
  Object.freeze({ name: 'M.CALL_PB', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'maintained run request, written by the HMI' }),
  Object.freeze({ name: 'M.JOG_PB', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'jog pushbutton, written by the HMI' }),

  // --- duty ----------------------------------------------------------------------------------
  Object.freeze({ name: 'M.LEAD_IS_P1', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'P-101 holds the lead duty; clear means P-102 does' }),
  Object.freeze({ name: 'M.LEAD_SYNC', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'one-shot: the duty selection has been read back from the panel' }),
  Object.freeze({ name: 'M.PROMOTE', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'one-shot: the lead machine has just tripped' }),
  Object.freeze({ name: 'M.LEAD_READY', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the lead machine is healthy and the station is permitted' }),
  Object.freeze({ name: 'M.LAG_READY', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the standby machine is healthy and the station is permitted' }),
  Object.freeze({ name: 'M.CALL_LEAD', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the sequence wants the lead machine turning' }),
  Object.freeze({ name: 'M.CALL_LAG', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the sequence wants the standby machine turning as well' }),
  Object.freeze({ name: 'M.P1_CALL', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'P-101 is called, whichever duty it is holding' }),
  Object.freeze({ name: 'M.P2_CALL', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'P-102 is called, whichever duty it is holding' }),
  Object.freeze({ name: 'M.ROTATING', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'a make-before-break duty changeover is in progress' }),
  Object.freeze({ name: 'M.ROT_REQ', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'one-shot: the runtime gap has just opened far enough to rotate' }),
  Object.freeze({ name: 'M.SWAP', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'one-shot: the set has just stopped, so the next start uses the other machine' }),
  Object.freeze({ name: 'M.ASLEEP', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the set is stopped on a satisfied header, waiting for the pressure to droop' }),

  // --- annunciator ---------------------------------------------------------------------------
  Object.freeze({ name: 'M.FO_LOCK', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'first-out lock: something has already been captured as the first condition in' }),
  Object.freeze({ name: 'M.FO_LEVEL', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'first out: TK-101 level low low' }),
  Object.freeze({ name: 'M.FO_PRESS', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'first out: PT-101 high high' }),
  Object.freeze({ name: 'M.FO_P1', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'first out: P-101 tripped' }),
  Object.freeze({ name: 'M.FO_P2', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'first out: P-102 tripped' }),
  Object.freeze({ name: 'M.FLASH', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the annunciator flasher, half a second on and half a second off' }),

  // --- the numbers the timers and the sequence work on ---------------------------------------
  Object.freeze({ name: 'M.UP_MS', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'ms', min: 0, desc: 'stage-up delay in the milliseconds a timer preset wants' }),
  Object.freeze({ name: 'M.DN_MS', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'ms', min: 0, desc: 'stage-down delay, ms' }),
  Object.freeze({ name: 'M.MINRUN_MS', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'ms', min: 0, desc: 'minimum run time, ms' }),
  Object.freeze({ name: 'M.MINSTOP_MS', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'ms', min: 0, desc: 'minimum stop time, ms' }),
  Object.freeze({ name: 'M.HOUR_GAP', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'h', desc: 'run hours on the lead machine less run hours on the standby' }),
  Object.freeze({ name: 'M.WAKE_AT', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'EU', desc: 'the measurement a sleeping set wakes at — setpoint less the droop' }),
  Object.freeze({ name: 'M.P1_RUN_H', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'h', min: 0, desc: 'run hours logged by the ladder itself, for the pump-down example' }),

  // --- totals ---------------------------------------------------------------------------------
  Object.freeze({ name: 'M.SHIFT_M3', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'm3', min: 0, desc: 'volume delivered this shift' }),
  Object.freeze({ name: 'M.SHIFT_KWH', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'kWh', min: 0, desc: 'energy drawn this shift' }),
  Object.freeze({ name: 'M.SHIFT_RATIO', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: 'kWh/m3', min: 0, desc: 'specific energy this shift — the only pumping number worth reporting' }),
  Object.freeze({ name: 'M.SHIFT_PB', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'shift change pushbutton, written by the HMI' }),
  Object.freeze({ name: 'M.SHIFT_EDGE', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'one-shot: the shift has just been changed' }),

  // --- the pump-down and recipe examples ------------------------------------------------------
  Object.freeze({ name: 'M.PUMPING', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the pump-down sequence is transferring' }),
  Object.freeze({ name: 'M.REC_START', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'recipe start, written by the HMI' }),
  Object.freeze({ name: 'M.REC_RUN', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'the recipe is running and not held' }),
  Object.freeze({ name: 'M.REC_GO', type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: 'one-shot: the recipe has just been started' }),
  Object.freeze({ name: 'M.REC_CO', type: TYPE.REAL, scope: SCOPE.MEMORY, unit: '%', min: 0, max: 100, desc: 'the loop output the recipe is watching' }),

  // --- timers ---------------------------------------------------------------------------------
  Object.freeze({ name: 'T.STAGE_UP', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'the stage-up condition has held this long' }),
  Object.freeze({ name: 'T.STAGE_DN', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'the stage-down condition has held this long' }),
  Object.freeze({ name: 'T.LAG_MINRUN', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'the standby machine has been called this long and may not be stopped yet' }),
  Object.freeze({ name: 'T.LAG_MINSTOP', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'the standby machine has rested this long and may not be restarted yet' }),
  Object.freeze({ name: 'T.LEAD_MINRUN', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'the lead machine has been called this long' }),
  Object.freeze({ name: 'T.OVERLAP', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'both machines run together for this long during a changeover' }),
  Object.freeze({ name: 'T.SLEEP', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'the header has been satisfied with no draw for this long' }),
  Object.freeze({ name: 'T.MINQ', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'a machine has been below its minimum continuous flow for this long' }),
  Object.freeze({ name: 'T.STEP1', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'recipe step 1 dwell' }),
  Object.freeze({ name: 'T.STEP2', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'recipe step 2 dwell' }),
  Object.freeze({ name: 'T.STEP3', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'recipe step 3 dwell' }),
  Object.freeze({ name: 'T.FLASH_ON', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'annunciator flasher, lit half' }),
  Object.freeze({ name: 'T.FLASH_OFF', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'annunciator flasher, dark half' }),
  Object.freeze({ name: 'T.SHIFT', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'retentive eight-hour shift clock' }),

  // --- counters --------------------------------------------------------------------------------
  Object.freeze({ name: 'C.P1_STARTS', type: TYPE.COUNTER, scope: SCOPE.COUNTER, desc: 'P-101 starts — short cycling shows up here first' }),
  Object.freeze({ name: 'C.P2_STARTS', type: TYPE.COUNTER, scope: SCOPE.COUNTER, desc: 'P-102 starts' }),
  Object.freeze({ name: 'C.LAG_STAGES', type: TYPE.COUNTER, scope: SCOPE.COUNTER, desc: 'how many times the standby machine has been staged in' }),
  Object.freeze({ name: 'C.SHIFTS', type: TYPE.COUNTER, scope: SCOPE.COUNTER, desc: 'shifts counted since the totals were last cleared' }),

  // --- the four tags the recipe sequencer publishes ---------------------------------------------
  // Declared here so a stock program validates against a database that has no sequencer attached.
  // `recipe.js` owns them at run time; `defineTag` accepts an identical redefinition and refuses a
  // conflicting one, so whichever module installs first wins and the disagreement is reported
  // rather than silently resolved.
  Object.freeze({ name: 'REC.STEP', type: TYPE.INT, scope: SCOPE.RECIPE, min: 0, max: 999, desc: 'the recipe step the sequencer is on, 0 when it is not running' }),
  Object.freeze({ name: 'REC.STEP_DN', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'the current step has met its transition condition' }),
  Object.freeze({ name: 'REC.HOLD', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'the recipe is held: the step timer stops and nothing advances' }),
  Object.freeze({ name: 'REC.SP', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 'EU', desc: 'the setpoint the current step is asking the loop to hold' }),
]);

/**
 * Declare every tag the stock programs need, on top of whatever is already in the database.
 *
 * Call it after `installIo` and `installSystemTags` and before loading any program from this
 * library — an undeclared operand is an ERROR in `validateProgram`, and a program with errors is
 * refused by the download exactly as it would be on a real processor.
 *
 * @param {object} db the tag database
 * @returns {{ok:boolean, defined:number, problems:string[]}} what was defined and what was refused
 */
export function installProgramTags(db) {
  return defineTags(db, PROGRAM_TAGS);
}

// ---------------------------------------------------------------------------------------------
// The programs
// ---------------------------------------------------------------------------------------------

/**
 * The station sequence the rig already runs, written out as ladder.
 *
 * Read alongside `src/control/staging.js`: the thresholds, the delays, the minimum-run and
 * minimum-stop timers and the make-before-break changeover are the same numbers, taken from the
 * panel's own `Q.SEQ_*` settings rather than typed in again, so a commissioning change on the
 * staging page moves the ladder with it.
 */
const DEFAULT_STATION_TEXT = `PROGRAM Station sequence — lead/lag on controller output
VERSION 1
META source = library.js DEFAULT_STATION
META companion = src/control/staging.js

RUNG This ladder owns the starters, so the rig's built-in staging sequence is held off — leave both running and they fight over the same machines
  XIC(S.ALWAYS_OFF) OTE(Q.SEQ_ENABLE)
END

RUNG The panel's own staging settings, converted to the milliseconds a timer preset wants; change them on the staging page and every timer below follows
  MUL(Q.SEQ_UP_DLY, 1000, M.UP_MS) MUL(Q.SEQ_DN_DLY, 1000, M.DN_MS) MUL(Q.SEQ_MINRUN, 1000, M.MINRUN_MS) MUL(Q.SEQ_MINSTOP, 1000, M.MINSTOP_MS)
END

RUNG Station permissive — the rig's own sequence has no permissive chain at all, so this rung is the one thing standing between a low tank and a set of dry-run pumps
  XIO(M.ESTOP) XIO(I.ALM_LT_LL) XIO(I.ALM_PT_HH) OTE(M.PERMIT)
END

RUNG Power-up: take the duty selection from the panel rather than assuming P-101, so a restart does not undo a rotation
  EQU(I.SEQ_LEAD, 1) OSR(M.LEAD_SYNC) OTL(M.LEAD_IS_P1)
END

RUNG A tripped lead is promoted away at once — the one-shot is what stops the duty flipping every scan while both machines are locked out
  [ XIC(M.LEAD_IS_P1) XIC(I.P1_FAULT) | XIO(M.LEAD_IS_P1) XIC(I.P2_FAULT) ] OSR(M.PROMOTE) ALTERNATE(M.LEAD_IS_P1, 2)
END

RUNG The duty selection goes back out to the panel, so the mimic and the ladder can never disagree about which machine is lead
  XIC(M.LEAD_IS_P1) MOV(1, Q.SEQ_LEAD)
END

RUNG ... and the other way round
  XIO(M.LEAD_IS_P1) MOV(2, Q.SEQ_LEAD)
END

RUNG The lead machine is fit to call: health is the fault bit and not I.Px_AVAIL, because AVAIL reports the panel selector and this program drives that selector itself
  XIC(M.PERMIT) [ XIC(M.LEAD_IS_P1) XIO(I.P1_FAULT) | XIO(M.LEAD_IS_P1) XIO(I.P2_FAULT) ] OTE(M.LEAD_READY)
END

RUNG The standby machine is fit to call
  XIC(M.PERMIT) [ XIC(M.LEAD_IS_P1) XIO(I.P2_FAULT) | XIO(M.LEAD_IS_P1) XIO(I.P1_FAULT) ] OTE(M.LAG_READY)
END

RUNG One machine turns whenever the station is permitted and the set is not asleep
  XIC(M.LEAD_READY) XIO(M.ASLEEP) OTE(M.CALL_LEAD)
END

RUNG Minimum run: a machine that has just started will not be stopped for 45 s whatever the loop does — the last line of defence against short cycling
  XIC(M.CALL_LAG) TON(T.LAG_MINRUN, M.MINRUN_MS)
END

RUNG Minimum stop: and one that has just stopped will not restart for 30 s
  XIO(M.CALL_LAG) TON(T.LAG_MINSTOP, M.MINSTOP_MS)
END

RUNG The same minimum run on the lead, so sleep cannot stop a machine that has only just come up
  XIC(M.CALL_LEAD) TON(T.LEAD_MINRUN, M.MINRUN_MS)
END

RUNG Minimum continuous flow: every start begins with the check valve shut and no flow at all, so the condition has to persist for 25 s before it means anything
  [ XIC(I.P1_MINFLOW) | XIC(I.P2_MINFLOW) ] TON(T.MINQ, 25000)
END

RUNG Drive RO-101 open — only reachable when the valve has been left in MANUAL, because no instruction here can write the STRING that selects its mode; in ARV the valve is its own protection and this program only watches it
  XIC(T.MINQ.DN) XIO(I.RECIRC_AUTO) MOV(100, Q.RECIRC_POS)
END

RUNG Shed the standby: two machines sharing less than one machine's minimum flow is the condition that put us here, and stopping one is the only thing the ladder can do about it
  XIC(T.MINQ.DN) XIC(T.LAG_MINRUN.DN) OTU(M.CALL_LAG)
END

RUNG Stage up: the shared output has to hold above the panel's stage-up threshold for the whole delay, and the timer resets the moment the standby is called, so a stage can never trigger the next one on the disturbance it caused itself
  XIO(M.CALL_LAG) GEQ(I.PIC_CO, Q.SEQ_UP_PCT) TON(T.STAGE_UP, M.UP_MS)
END

RUNG The standby joins, unless it is still resting or the minimum-flow protection is standing — the saturation override at 97% is subsumed by the 88% threshold under this criterion, so there is no separate rung for it
  XIC(T.STAGE_UP.DN) XIC(M.LAG_READY) XIC(T.LAG_MINSTOP.DN) XIO(T.MINQ.DN) OTL(M.CALL_LAG)
END

RUNG Stage down: a much lower threshold held for much longer, and the gap between the two is the hysteresis band that has to be wider than the transition's own disturbance
  XIC(M.CALL_LAG) LEQ(I.PIC_CO, Q.SEQ_DN_PCT) TON(T.STAGE_DN, M.DN_MS)
END

RUNG The standby leaves, once it has run its minimum — note there is no staging bias here: the sequence in staging.js preloads the controller integral on a transition and no instruction in this set can reach inside a loop, so the header takes rather more of the stage than it otherwise would
  XIC(T.STAGE_DN.DN) XIC(T.LAG_MINRUN.DN) XIO(M.ROTATING) OTU(M.CALL_LAG)
END

RUNG Runtime gap with P-101 leading: hours on the lead less hours on the standby
  XIC(M.LEAD_IS_P1) SUB(I.P1_HOURS, I.P2_HOURS, M.HOUR_GAP)
END

RUNG ... and with P-102 leading
  XIO(M.LEAD_IS_P1) SUB(I.P2_HOURS, I.P1_HOURS, M.HOUR_GAP)
END

RUNG Duty rotation: only with the set down to one machine, and only once the lead has worn four hours more than the standby
  XIO(M.CALL_LAG) XIC(M.LAG_READY) XIC(T.LAG_MINSTOP.DN) GEQ(M.HOUR_GAP, 4) OSR(M.ROT_REQ) OTL(M.ROTATING)
END

RUNG Make before break: the standby starts and both machines run together, so the header never sees a gap
  XIC(M.ROTATING) OTL(M.CALL_LAG)
END

RUNG The overlap — 12 s, the same as the panel's overlap_s
  XIC(M.ROTATING) TON(T.OVERLAP, 12000)
END

RUNG Changeover complete: the machine that has just started takes the lead and the old lead is released in the same scan, which works only because a coil written on one rung is visible to the rungs below it
  XIC(T.OVERLAP.DN) ALTERNATE(M.LEAD_IS_P1, 2) OTU(M.CALL_LAG) OTU(M.ROTATING)
END

RUNG The wake point: setpoint less a 10% droop, recomputed every scan so a setpoint change moves it
  MUL(I.PIC_SP, 0.9, M.WAKE_AT)
END

RUNG Sleep timer — no draw on a satisfied header, with one machine turning and the panel's sleep enable in
  XIC(Q.SEQ_SLEEP) XIO(M.ASLEEP) XIO(M.CALL_LAG) LEQ(I.FT101, 3) GEQ(I.PIC_PV, I.PIC_SP) TON(T.SLEEP, 40000)
END

RUNG The set goes to sleep and the gas cushion holds the header on its own
  XIC(T.SLEEP.DN) XIC(T.LEAD_MINRUN.DN) OTL(M.ASLEEP)
END

RUNG Only the droop wakes it: testing "is anything running" here looks reasonable and turns the feature into a short-cycling generator, because a machine told to stop is still coasting and still reads as called
  XIC(M.ASLEEP) LES(I.PIC_PV, M.WAKE_AT) OTU(M.ASLEEP)
END

RUNG And sleep is not available at all while the panel says so
  XIO(Q.SEQ_SLEEP) OTU(M.ASLEEP)
END

RUNG P-101 is called when it holds whichever duty is calling
  [ XIC(M.LEAD_IS_P1) XIC(M.CALL_LEAD) | XIO(M.LEAD_IS_P1) XIC(M.CALL_LAG) ] OTE(M.P1_CALL)
END

RUNG P-102 likewise
  [ XIO(M.LEAD_IS_P1) XIC(M.CALL_LEAD) | XIC(M.LEAD_IS_P1) XIC(M.CALL_LAG) ] OTE(M.P2_CALL)
END

RUNG P-101 start — the rack point is a momentary pushbutton, so the command is issued on the rising edge and holding the coil simply keeps the machine placed; the fault contact drops the coil so a reset re-issues the start
  XIC(M.P1_CALL) XIO(I.P1_FAULT) OTE(Q.P1_START)
END

RUNG P-101 stop, and only when it is actually called, so the program does not lock out a machine that is already standing still
  XIO(M.P1_CALL) XIC(I.P1_CALLED) OTE(Q.P1_STOP)
END

RUNG P-102 start
  XIC(M.P2_CALL) XIO(I.P2_FAULT) OTE(Q.P2_START)
END

RUNG P-102 stop
  XIO(M.P2_CALL) XIC(I.P2_CALLED) OTE(Q.P2_STOP)
END

RUNG Overload reset — the relay will not accept it until the bimetal has cooled, so the operator may have to press twice
  XIC(M.RESET_PB) XIC(I.P1_FAULT) OTE(Q.P1_RESET)
END

RUNG ... and for P-102
  XIC(M.RESET_PB) XIC(I.P2_FAULT) OTE(Q.P2_RESET)
END

RUNG First out: the first condition to come in latches its own bit and locks the rest out, and it works because the four rungs scan in order within one scan
  XIO(M.FO_LOCK) XIC(I.ALM_LT_LL) OTL(M.FO_LEVEL) OTL(M.FO_LOCK)
END

RUNG First out: header high high
  XIO(M.FO_LOCK) XIC(I.ALM_PT_HH) OTL(M.FO_PRESS) OTL(M.FO_LOCK)
END

RUNG First out: P-101 tripped
  XIO(M.FO_LOCK) XIC(I.ALM_P1_TRIP) OTL(M.FO_P1) OTL(M.FO_LOCK)
END

RUNG First out: P-102 tripped
  XIO(M.FO_LOCK) XIC(I.ALM_P2_TRIP) OTL(M.FO_P2) OTL(M.FO_LOCK)
END

RUNG Acknowledge silences the horn, clears the first-out capture and arms it for the next upset
  XIC(M.ACK_PB) OTE(Q.ALARM_ACK) OTU(M.FO_LOCK) OTU(M.FO_LEVEL) OTU(M.FO_PRESS) OTU(M.FO_P1) OTU(M.FO_P2)
END

RUNG The horn sounds while anything at all is waiting to be acknowledged, and stops on the acknowledge and not on the condition clearing
  GRT(I.ALM_UNACK, 0) OTE(Q.HORN)
END

RUNG Red lamp: flashing while unacknowledged, steady once acknowledged, which is what the flasher bit is for
  XIC(I.ALM_CRITICAL) [ EQU(I.ALM_UNACK, 0) | XIC(S.PULSE_1S) ] OTE(Q.LAMP_ALARM)
END

RUNG Amber lamp: something is standing but nothing is critical
  XIC(I.ALM_ANY) XIO(I.ALM_CRITICAL) OTE(Q.LAMP_WARN)
END

RUNG Running lamps come off the running bit and not off the call, so a machine that has been told to run and has not is visibly not running
  XIC(I.P1_RUN) OTE(Q.LAMP_P1)
END

RUNG ... and P-102
  XIC(I.P2_RUN) OTE(Q.LAMP_P2)
END

RUNG Starts per machine, counted on the rising edge — most starters are rated for six to ten an hour and DN is the number worth putting on the panel
  XIC(I.P1_RUN) CTU(C.P1_STARTS, 6)
END

RUNG ... and P-102
  XIC(I.P2_RUN) CTU(C.P2_STARTS, 6)
END

RUNG How often the standby has been staged in: if this climbs the hysteresis band is too narrow or the delays are too short
  XIC(M.CALL_LAG) CTU(C.LAG_STAGES, 6)
END
`;

/** The classic latch. Everything else in ladder is this rung with more contacts on it. */
const SEAL_IN_TEXT = `PROGRAM Seal-in start/stop
VERSION 1
META source = library.js SEAL_IN

RUNG The built-in sequence is held off so this program owns P-101
  XIC(S.ALWAYS_OFF) OTE(Q.SEQ_ENABLE)
END

RUNG The seal-in: the start button energises the coil and the coil's own contact holds it in when the button is released; the stop contact is in series so it breaks the seal wherever the power came from
  [ XIC(M.START_PB) | XIC(M.P1_CALL) ] XIO(M.STOP_PB) XIO(I.P1_FAULT) OTE(M.P1_CALL)
END

RUNG The call reaches the starter — the rack point is momentary, so this coil commands on its rising edge and then simply holds the machine placed
  XIC(M.P1_CALL) XIO(I.P1_FAULT) OTE(Q.P1_START)
END

RUNG Releasing the seal stops the machine, and only if it is actually running
  XIO(M.P1_CALL) XIC(I.P1_CALLED) OTE(Q.P1_STOP)
END

RUNG Running lamp
  XIC(I.P1_RUN) OTE(Q.LAMP_P1)
END
`;

/** Alternation on the falling edge, so the set does not always wear the same machine. */
const ALTERNATION_TEXT = `PROGRAM Motor alternation
VERSION 1
META source = library.js ALTERNATION

RUNG The built-in sequence is held off so this program owns both machines
  XIC(S.ALWAYS_OFF) OTE(Q.SEQ_ENABLE)
END

RUNG One machine runs while the operator's call is in and the tank has something in it
  XIC(M.CALL_PB) XIO(I.ALM_LT_LL) OTE(M.CALL_LEAD)
END

RUNG Swap the duty as the set STOPS, not as it starts: alternating on the falling edge means the changeover happens while nothing is turning, and the next start uses the other machine
  XIC(M.CALL_LEAD) OSF(M.SWAP) ALTERNATE(M.LEAD_IS_P1, 2)
END

RUNG P-101 holds the duty that is called
  XIC(M.LEAD_IS_P1) XIC(M.CALL_LEAD) OTE(M.P1_CALL)
END

RUNG P-102 holds the other one
  XIO(M.LEAD_IS_P1) XIC(M.CALL_LEAD) OTE(M.P2_CALL)
END

RUNG P-101 start
  XIC(M.P1_CALL) XIO(I.P1_FAULT) OTE(Q.P1_START)
END

RUNG P-101 stop
  XIO(M.P1_CALL) XIC(I.P1_CALLED) OTE(Q.P1_STOP)
END

RUNG P-102 start
  XIC(M.P2_CALL) XIO(I.P2_FAULT) OTE(Q.P2_START)
END

RUNG P-102 stop
  XIO(M.P2_CALL) XIC(I.P2_CALLED) OTE(Q.P2_STOP)
END

RUNG The starts should end up level; if one counter runs away, the alternation is not firing
  XIC(I.P1_RUN) CTU(C.P1_STARTS, 6)
END

RUNG ... and the other machine
  XIC(I.P2_RUN) CTU(C.P2_STARTS, 6)
END
`;

/** Two set points and a latch: the shape of every level-driven sequence there has ever been. */
const PUMP_DOWN_TEXT = `PROGRAM Pump-down on tank level
VERSION 1
META source = library.js PUMP_DOWN

RUNG The built-in sequence is held off so this program owns P-101
  XIC(S.ALWAYS_OFF) OTE(Q.SEQ_ENABLE)
END

RUNG Start the transfer once TK-101 reaches 2.6 m — a latch and not a maintained contact, because a level sitting exactly on the set point would otherwise chatter the starter
  GRT(I.LT101, 2.6) OTL(M.PUMPING)
END

RUNG Stop at 0.9 m: the gap between the two set points is the whole of the anti-cycling design, and it is the number to widen when the starts per hour climb
  LES(I.LT101, 0.9) OTU(M.PUMPING)
END

RUNG Dry-run interlock — an unlatch on its own rung, so it wins over the start whatever the level transmitter is saying
  XIC(I.ALM_LT_LL) OTU(M.PUMPING)
END

RUNG The transfer calls the machine
  XIC(M.PUMPING) XIO(I.P1_FAULT) OTE(Q.P1_START)
END

RUNG ... and releases it
  XIO(M.PUMPING) XIC(I.P1_CALLED) OTE(Q.P1_STOP)
END

RUNG Log the hours the ladder has actually run the machine for, which is what a maintenance interval should be counted on rather than the hours the plant was energised
  XIC(I.P1_RUN) RUNHOURS(M.P1_RUN_H)
END

RUNG Running lamp
  XIC(I.P1_RUN) OTE(Q.LAMP_P1)
END
`;

/** The step walker: the logic half of "change the recipe behaviour". */
const RECIPE_WALKER_TEXT = `PROGRAM Three-step recipe walker
VERSION 1
META source = library.js RECIPE_WALKER

RUNG The recipe runs while the operator's start is in and nothing is holding it — HOLD stops the walker without losing the step
  XIC(M.REC_START) XIO(REC.HOLD) OTE(M.REC_RUN)
END

RUNG Starting the recipe puts it on step 1; the one-shot is what stops a maintained start button re-entering step 1 every scan
  XIC(M.REC_START) OSR(M.REC_GO) MOV(1, REC.STEP)
END

RUNG Step 1 — hold 2.6 bar for a minute. SETPT is the guard: the recipe grid is editable by anyone and this is the rung that says what the plant will actually accept, so power drops if the step asks for something out of range
  XIC(M.REC_RUN) EQU(REC.STEP, 1) SETPT(2.6, 1.0, 5.0, REC.SP) TON(T.STEP1, 60000)
END

RUNG Step 1 is complete
  XIC(M.REC_RUN) EQU(REC.STEP, 1) XIC(T.STEP1.DN) MOV(2, REC.STEP)
END

RUNG Step 2 — 3.4 bar for ninety seconds. Each step gets its OWN timer: share one and the inactive step's rung zeroes the accumulator every scan and the active step never finishes
  XIC(M.REC_RUN) EQU(REC.STEP, 2) SETPT(3.4, 1.0, 5.0, REC.SP) TON(T.STEP2, 90000)
END

RUNG Step 2 is complete
  XIC(M.REC_RUN) EQU(REC.STEP, 2) XIC(T.STEP2.DN) MOV(3, REC.STEP)
END

RUNG Step 3 — ramp down to 2.0 bar at 0.05 bar a second and finish when it ARRIVES rather than after a fixed time, which is what a ramp step means
  XIC(M.REC_RUN) EQU(REC.STEP, 3) RAMP(2.0, 0.05, REC.SP) OTE(REC.STEP_DN)
END

RUNG End of recipe: back to step 0 and the start bit drops, so the operator has to ask for it again
  XIC(M.REC_RUN) EQU(REC.STEP, 3) XIC(REC.STEP_DN) MOV(0, REC.STEP) OTU(M.REC_START)
END

RUNG The step setpoint goes to PIC-101 and the loop is held in AUTO — the supervisory program decides WHAT to hold, the loop decides how hard to work for it
  XIC(M.REC_RUN) PID(REC.SP, 'AUTO', M.REC_CO)
END

RUNG The display follows the step number and the hold
  XIC(S.ALWAYS_ON) MOV(REC.STEP, Q.REC_STEP)
END

RUNG ... and the hold lamp
  XIC(REC.HOLD) OTE(Q.REC_HOLD)
END
`;

/** Horn, flasher, first out, acknowledge: an annunciator that behaves like ISA-18 says it should. */
const ANNUNCIATOR_TEXT = `PROGRAM Annunciator with first-out
VERSION 1
META source = library.js ANNUNCIATOR

RUNG A flasher built out of two timers, because the processor's own S.PULSE_1S is not something a program should have to assume exists: this half times while the other one is not done
  XIO(T.FLASH_OFF.DN) TON(T.FLASH_ON, 500)
END

RUNG ... and this half times once the first one is, which resets the first one and starts the cycle again
  XIC(T.FLASH_ON.DN) TON(T.FLASH_OFF, 500)
END

RUNG Half a second lit, half a second dark
  XIC(T.FLASH_ON.DN) XIO(T.FLASH_OFF.DN) OTE(M.FLASH)
END

RUNG First out: whichever of these comes in first captures the lock and the others cannot, which is the difference between knowing what tripped the station and knowing what happened afterwards
  XIO(M.FO_LOCK) XIC(I.ALM_LT_LL) OTL(M.FO_LEVEL) OTL(M.FO_LOCK)
END

RUNG First out: header high high
  XIO(M.FO_LOCK) XIC(I.ALM_PT_HH) OTL(M.FO_PRESS) OTL(M.FO_LOCK)
END

RUNG First out: P-101 tripped
  XIO(M.FO_LOCK) XIC(I.ALM_P1_TRIP) OTL(M.FO_P1) OTL(M.FO_LOCK)
END

RUNG First out: P-102 tripped
  XIO(M.FO_LOCK) XIC(I.ALM_P2_TRIP) OTL(M.FO_P2) OTL(M.FO_LOCK)
END

RUNG The horn sounds on anything unacknowledged and is silenced by the acknowledge, never by the condition going away on its own
  GRT(I.ALM_UNACK, 0) OTE(Q.HORN)
END

RUNG Red: flashing while unacknowledged, steady after
  XIC(I.ALM_CRITICAL) [ EQU(I.ALM_UNACK, 0) | XIC(M.FLASH) ] OTE(Q.LAMP_ALARM)
END

RUNG Amber: standing, but nothing critical
  XIC(I.ALM_ANY) XIO(I.ALM_CRITICAL) OTE(Q.LAMP_WARN)
END

RUNG Green means the plant is running and quiet, which is the state an annunciator should make obvious at a glance
  XIC(I.P1_RUN) XIO(I.ALM_ANY) OTE(Q.LAMP_P1)
END

RUNG Acknowledge: silence, clear the capture, and arm it for the next upset
  XIC(M.ACK_PB) OTE(Q.ALARM_ACK) OTU(M.FO_LOCK) OTU(M.FO_LEVEL) OTU(M.FO_PRESS) OTU(M.FO_P1) OTU(M.FO_P2)
END
`;

/** Integrate a rate into a total, and clear it on a shift change. */
const SHIFT_TOTAL_TEXT = `PROGRAM Shift totaliser
VERSION 1
META source = library.js SHIFT_TOTAL

RUNG Volume delivered this shift. TOTAL integrates the WHOLE of a long scan, unlike a timer, so the number stays honest at twenty times real time; the divisor is 3600 because the rate is per hour
  XIC(S.ALWAYS_ON) TOTAL(I.FT101, M.SHIFT_M3)
END

RUNG Energy drawn this shift, the same way — kW into kWh
  XIC(S.ALWAYS_ON) TOTAL(I.KW_TOTAL, M.SHIFT_KWH)
END

RUNG Specific energy, guarded: divide by zero leaves the destination alone and drops power rather than writing a NaN, and the contact in front means it never gets asked in the first place
  GRT(M.SHIFT_M3, 0.01) DIV(M.SHIFT_KWH, M.SHIFT_M3, M.SHIFT_RATIO)
END

RUNG A retentive shift clock: RTO keeps its accumulator when the rung goes false, so it totals scattered running rather than one continuous run, and only a RES will clear it
  XIC(S.ALWAYS_ON) RTO(T.SHIFT, 28800000)
END

RUNG Shift change: one shot, clear both totals, count the shift, reset the clock. Forgetting the RES is why somebody's shift timer has been sitting at DN since commissioning
  XIC(M.SHIFT_PB) OSR(M.SHIFT_EDGE) CLR(M.SHIFT_M3) CLR(M.SHIFT_KWH) CTU(C.SHIFTS, 3) RES(T.SHIFT)
END
`;

/**
 * Broken on purpose. Two OTEs drive one tag, the second one wins every scan, and the first rung
 * appears to do nothing at all — which is the single most common fault in a program somebody has
 * been maintaining for years.
 */
const DUPLICATE_COIL_TEXT = `PROGRAM Duplicate coil — broken on purpose
VERSION 1
META source = library.js DUPLICATE_COIL
META broken = the same tag is driven by an OTE on two rungs

RUNG The original rung: the operator's start button calls P-101, and on its own this works perfectly
  XIC(M.START_PB) OTE(Q.P1_START)
END

RUNG The rung somebody added later for a jog button. It also drives Q.P1_START, it scans second, and it therefore decides the state of that output on every single scan — press start and nothing happens, because this rung has already written false over it
  XIC(M.JOG_PB) OTE(Q.P1_START)
END

RUNG And the lamp faithfully reports the output, which is why the fault reads as a broken start button rather than as a program defect. Run the cross-reference on Q.P1_START and the two coils are the first thing it shows you
  XIC(Q.P1_START) OTE(Q.LAMP_P1)
END
`;

/**
 * Every program that ships with the simulator, in teaching order.
 *
 * `text` is the source of truth. `teaches` is the one-line answer to "why would I open this one",
 * and the editor's program list is built straight off these fields.
 */
export const STOCK_PROGRAMS = Object.freeze([
  Object.freeze({
    id: DEFAULT_PROGRAM_ID,
    title: 'Station sequence',
    blurb: 'The sequence the rig runs on, written as ladder: permissives, lead/lag staging on '
      + 'controller output, minimum-flow protection, duty rotation, sleep and a first-out '
      + 'annunciator.',
    teaches: 'How a real pump station is sequenced, and where every number on the staging page '
      + 'lands in the logic.',
    text: DEFAULT_STATION_TEXT,
  }),
  Object.freeze({
    id: 'SEAL_IN',
    title: 'Seal-in start/stop',
    blurb: 'One machine, one start button, one stop button, and the latch that holds it in.',
    teaches: 'The seal-in — a coil holding itself in through its own contact. Everything else in '
      + 'ladder is this rung with more contacts on it.',
    text: SEAL_IN_TEXT,
  }),
  Object.freeze({
    id: 'ALTERNATION',
    title: 'Motor alternation',
    blurb: 'Two machines sharing one duty, swapping on every stop so they wear evenly.',
    teaches: 'Why duty alternation is done on an EDGE and not on a level, and why the edge is '
      + 'the falling one.',
    text: ALTERNATION_TEXT,
  }),
  Object.freeze({
    id: 'PUMP_DOWN',
    title: 'Pump-down on level',
    blurb: 'Start at high level, run to low level, and never dry-run the machine.',
    teaches: 'Latch and unlatch on two set points, and why the gap between them is the whole of '
      + 'the anti-cycling design.',
    text: PUMP_DOWN_TEXT,
  }),
  Object.freeze({
    id: 'RECIPE_WALKER',
    title: 'Three-step recipe walker',
    blurb: 'A step sequencer that writes the loop setpoint, dwells, ramps, and hands the step '
      + 'number to the display.',
    teaches: 'That a recipe is data AND logic: the step numbers are in the grid, and these are '
      + 'the rungs that walk them.',
    text: RECIPE_WALKER_TEXT,
  }),
  Object.freeze({
    id: 'ANNUNCIATOR',
    title: 'Annunciator with first-out',
    blurb: 'Horn, flasher, red and amber lamps, acknowledge, and a first-out capture that says '
      + 'which condition came in first.',
    teaches: 'ISA-18 annunciator behaviour, a flasher built from two timers, and first-out '
      + 'sequence-of-events capture.',
    text: ANNUNCIATOR_TEXT,
  }),
  Object.freeze({
    id: 'SHIFT_TOTAL',
    title: 'Shift totaliser',
    blurb: 'Volume and energy integrated into running totals, with a retentive shift clock and a '
      + 'one-button reset.',
    teaches: 'TOTAL against TON at time compression, RTO retention, and why a division needs a '
      + 'contact in front of it.',
    text: SHIFT_TOTAL_TEXT,
  }),
  Object.freeze({
    id: 'DUPLICATE_COIL',
    title: 'Duplicate coil (broken)',
    blurb: 'A start button that does not work, and a jog button that quietly owns the output. '
      + 'The processor refuses to download this one.',
    teaches: 'What a duplicate coil does to a program, and what the cross-reference is for.',
    text: DUPLICATE_COIL_TEXT,
  }),
]);

/** Index for {@link programFor}, built once because a linear search per lookup is silly. */
const BY_ID = new Map(STOCK_PROGRAMS.map((p) => [p.id, p]));

/**
 * The ids of the stock programs, in the order the editor should list them.
 * @returns {string[]} the ids
 */
export function programIds() {
  return STOCK_PROGRAMS.map((p) => p.id);
}

/**
 * The catalogue entry for one stock program.
 * @param {string} id one of {@link programIds}
 * @returns {object|null} the record, or null when nothing answers to that id
 */
export function stockProgram(id) {
  return BY_ID.get(String(id)) || null;
}

/**
 * Parse one stock program into a fresh document.
 *
 * Fresh every call, deliberately: rung ids are runtime handles, and two panels editing what they
 * both believe is "the default program" must not be editing one object.
 *
 * @param {string} id one of {@link programIds}
 * @param {object} [opts] parser options, forwarded to `model.programFromText` — pass
 *   `{specs: INSTRUCTIONS}` to classify elements against the real instruction set
 * @returns {object|null} the parsed program, or null when the id is unknown or the text does not
 *   parse, which can only happen if a program in this file has been edited badly
 */
export function programFor(id, opts) {
  const rec = BY_ID.get(String(id));
  if (!rec) return null;
  const r = programFromText(rec.text, opts);
  if (!r.ok || !r.prog) return null;
  r.prog.meta.id = rec.id;
  return r.prog;
}
