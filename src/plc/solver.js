/**
 * src/plc/solver.js — the scan engine. The thing that actually runs the ladder.
 *
 * Layer L4b: it sits beside `core/sim.js` and is called from it through the `ctx.plc` slot. It
 * imports nothing from `src/ui` and touches no DOM, no `window`, no `performance`, no `Date.now`
 * and no `Math.random` — every decision it makes is a function of the arguments it was handed,
 * which is what lets the whole processor be unit-tested in Node and replayed bit-for-bit.
 *
 * ------------------------------------------------------------------------------------------
 * THE SCAN IS THE WHOLE IDEA
 *
 * A PLC is not an interpreter that runs when something happens. It is a machine that goes round
 * and round doing exactly three things:
 *
 *   1. SAMPLE the entire input image. Every input the logic will see this scan is frozen here.
 *   2. SOLVE every rung, top to bottom, each rung left to right.
 *   3. WRITE the entire output image to the plant, once, at the end.
 *
 * Steps 1 and 3 are not an optimisation, they are the contract that makes ladder reasoning sound.
 * Because the inputs are frozen, a rung near the bottom and a rung near the top see the SAME
 * world, so a two-rung interlock cannot be fooled by a level switch that chattered in between.
 * Because the plant is written once, a coil that is set on rung 4 and cleared on rung 40 never
 * reaches a contactor at all — the plant sees the answer, not the working out. Simulators that
 * skip this feel almost right and then produce interlocks that fail once an hour for no visible
 * reason, which is the single hardest class of bug to teach against.
 *
 * What IS visible inside the scan is the output image itself: a coil written on rung 4 is seen by
 * a contact on rung 5, in that same scan. That is true of every processor an operator has ever
 * used and it is what makes cross-rung sequencing work. Write a coil on rung 40 and read it on
 * rung 4 and you get last scan's value — a one-scan lag that is a real and famous source of
 * confusion, so `compile.js` flags it rather than the engine hiding it.
 *
 * WHY POWER FLOW IS RECORDED FOR EVERY NODE
 *
 * Watching the logic energise is how controls engineers learn, so the power map is a first-class
 * output of the scan and not a debug aid. It has to be complete — every element, inside every
 * branch leg — and it has to be cheap enough to fill at ten scans a second without the browser
 * noticing. Both come from the same trick: the key strings the editor looks power up by are built
 * ONCE, when the program is loaded, into an index that mirrors the rung tree. The scan then walks
 * nodes and index in lockstep and never allocates a string.
 *
 * THE WATCHDOG COUNTS WORK, NOT SECONDS
 *
 * The first program a beginner writes contains a JMP that jumps backwards to a label above it,
 * and a processor without a watchdog answers that by locking the browser tab solid. So the scan
 * is capped: rungs evaluated, elements evaluated and jumps taken. Note that the cap is on WORK and
 * not on elapsed time, because a module that may not call `performance.now()` has no honest clock
 * — and because work is the thing that actually diverges. A wall-clock watchdog on a machine that
 * was merely busy would fault a perfectly good program; this one faults only a program that is
 * genuinely going round in circles.
 *
 * POWER OUT IS WHAT THE INSTRUCTION SAYS IT IS
 *
 * The engine sets `io.power` to the power arriving at an element and takes the value the element
 * returns AS the power leaving it. It does NOT then AND the two together, tempting though that
 * looks for a contact. `instructions.js` states the rule and OSF is why: a one-shot-falling exists
 * to emit a single scan of power on the edge where its input goes false, and an outer AND would
 * swallow exactly the pulse it was built to produce. Every input instruction ANDs `io.power`
 * itself, so for an ordinary contact the two readings are identical anyway.
 *
 * TWO SEVERITIES OF FAULT
 *
 * A MAJOR fault stops the processor: the watchdog, an instruction the processor does not have, an
 * instruction that throws. A MINOR fault — which is what an instruction raises through
 * `io.control.fault`, typically a divide by zero — is recorded and shown and the scan carries on,
 * because `instructions.js` handles arithmetic with no answer by leaving the destination alone and
 * dropping power flow, and stopping the plant over it would be a wild overreaction to a student
 * typing a zero.
 *
 * THE PROCESSOR CAN BE HANDED A DIFFERENT WORLD
 *
 * The instruction set, the tag accessors and the IO bridge default to the real ones, so
 * `createPlcState(prog, db)` is a working processor with no wiring at all. Every one of them can
 * still be replaced through {@link attachRuntime}: a lesson can hand the same engine a reduced
 * palette so a beginner cannot reach for PID on rung one, and the tests drive it with a stub
 * instruction set so that a failure here is unambiguously a failure of the engine.
 * ------------------------------------------------------------------------------------------
 */

import { validateProgram } from './model.js';
import { INSTRUCTIONS } from './instructions.js';
import { scanInputs, scanOutputs } from './iomap.js';
import { readTag, writeTag, timerOf, counterOf, tagExists } from './tags.js';

/** Processor key position. */
export const MODE = Object.freeze({
  /** Stopped. Inputs are still sampled so the tag browser stays live; no logic, no outputs. */
  PROGRAM: 'PROGRAM',
  /** Scanning normally. */
  RUN: 'RUN',
  /** Stopped, but the operator may advance the program one rung at a time. */
  TEST: 'TEST',
});

/**
 * Scan limits. Exceeding any of them faults the processor instead of hanging the tab.
 *
 * The numbers are generous against any honest program — the stock station program is under fifty
 * rungs — and instant against a jump loop, which reaches two thousand rungs in well under a
 * millisecond.
 */
export const WATCHDOG = Object.freeze({
  /** Rung evaluations allowed in one scan. */
  maxRungs: 2000,
  /** Element evaluations allowed in one scan. */
  maxElements: 40000,
  /** Jumps allowed in one scan. */
  maxJumps: 500,
  /** Faults kept before the list stops growing. */
  maxFaults: 20,
});

/**
 * Output instructions that survive a de-energised MCR zone.
 *
 * This is the rule everybody gets wrong. An MCR zone that loses power drops its NON-RETENTIVE
 * outputs — coils go false, timers reset — and leaves the retentive ones exactly where they are.
 * A latch that unlatched itself because a zone dropped would make MCR useless as a safety
 * construct, since the whole point is to be able to drop a section and know the latched state of
 * the plant is still there when it comes back.
 */
const RETENTIVE_OUTPUTS = Object.freeze({
  OTL: true, OTU: true, RTO: true, RES: true, CTU: true, CTD: true, TOTAL: true, RUNHOURS: true,
});

/** Fault severities. Only a major fault stops the processor. */
export const SEVERITY = Object.freeze({
  /** Recorded and shown; the scan carries on. */
  MINOR: 'minor',
  /** The processor stops and stays stopped until the fault is cleared. */
  MAJOR: 'major',
});

/** Instruction kinds, mirrored from `instructions.js` rather than imported for one string. */
const KIND_COIL = 'COIL';

/** A tag name is a scope letter, a dot and a symbol — the naming rule `tags.js` enforces. */
const TAG_NAME = /^[IQMTCRS]\.[A-Za-z0-9_.]*[A-Za-z0-9_]$/;

/** The default tag accessors, gathered so a test can swap the whole set in one object. */
const DEFAULT_TAGS = Object.freeze({
  readTag, writeTag, timerOf, counterOf, tagExists,
});

/**
 * Create a processor.
 *
 * @param {object|null} prog the program document from `model.js`, or null for an empty processor
 * @param {object|null} db the tag database from `tags.js`
 * @param {object} [wiring] runtime wiring, see {@link attachRuntime}
 * @returns {object} the processor state
 */
export function createPlcState(prog, db, wiring) {
  const plc = {
    /** One of {@link MODE}. */
    mode: MODE.PROGRAM,
    /** The loaded program, or null. */
    prog: null,
    /** The tag database this processor is bound to. */
    db: db || null,
    /** Faults, newest last. A MAJOR one stops the scan until {@link clearFaults}. */
    faults: [],
    /** True while a major fault is standing. */
    faulted: false,
    /** Scan metrics. `ms` is the scan PERIOD, which is the number `S.SCAN_MS` publishes. */
    scan: { ms: 0, max: 0, count: 0 },
    /** Power flow at every node, keyed by the strings {@link powerOf} builds. */
    power: new Map(),
    /** Last scan's work, for the status bar and for the watchdog message. */
    lastScan: { rungsEvaluated: 0, elementsEvaluated: 0, jumps: 0 },
    /** Next rung index in {@link MODE.TEST}. */
    cursor: 0,
    /** The instruction set this processor understands. */
    instructions: null,
    /** The injected bridge to tags, IO and the recipe sequencer. */
    wiring: {},
    /** The reusable scan bundle handed to every instruction. */
    io: null,
    /** Program structure index, rebuilt on every load: keys, labels and rung lookup. */
    index: { rungs: new Map(), labels: new Map(), order: [] },
    /** Set by an instruction calling `io.control.jump`, consumed by the rung loop. */
    pendingJump: null,
    /** MCR zone state, carried between rungs and between TEST steps. */
    zone: { open: false, energised: true },
  };
  // `core/sim.js` calls `ctx.plc.onScan(ctx, scan_s)`, so the state object carries a bound method
  // and dropping the processor straight into the slot is all the wiring the UI has to do.
  plc.onScan = (ctx, dt_s) => { onScan(plc, ctx, plc.wiring.sim, dt_s); };
  attachRuntime(plc, wiring);
  if (prog) loadProgram(plc, prog, db);
  return plc;
}

/**
 * Give the processor its world: the instruction set it executes, the tag accessors it reads and
 * writes through, the IO bridge that couples it to the plant, and the recipe sequencer it steps.
 *
 * Everything here is optional and everything missing degrades to a silent no-op, because these
 * modules are written and tested independently and a processor with no IO bridge attached must
 * still scan its logic rather than throw.
 *
 * @param {object} plc processor state
 * @param {object} [w] wiring
 * @param {object} [w.instructions] mnemonic -> instruction spec, from `instructions.js`
 * @param {object} [w.tags] the `tags.js` module namespace (readTag, writeTag, timerOf, counterOf)
 * @param {(db:object, ctx:object)=>void} [w.scanInputs] from `iomap.js`
 * @param {(db:object, ctx:object, sim:object)=>void} [w.scanOutputs] from `iomap.js`
 * @param {(prog:object, db:object)=>object[]} [w.validateProgram] from `model.js`
 * @param {(db:object, dt_s:number)=>void} [w.stepSequencer] from `recipe.js`, run between the
 *   input pass and the logic so the ladder sees this scan's recipe tags
 * @param {object} [w.sim] the `core/sim.js` namespace, so output instructions act through real
 *   simulator actions rather than writing plant fields behind its back
 * @returns {{ok:boolean, reason?:string}} refusal when there is no processor to wire
 */
export function attachRuntime(plc, w) {
  if (!plc || typeof plc !== 'object') {
    return { ok: false, reason: 'There is no processor to attach a runtime to.' };
  }
  const next = {
    instructions: INSTRUCTIONS,
    tags: DEFAULT_TAGS,
    scanInputs,
    scanOutputs,
    validateProgram,
    ...plc.wiring,
    ...(w || {}),
  };
  plc.wiring = next;
  if (next.instructions) plc.instructions = next.instructions;
  if (next.db && !plc.db) plc.db = next.db;
  plc.io = null;
  return { ok: true };
}

/**
 * Turn the key.
 *
 * A processor with a fault standing cannot be put into RUN — clear the fault first. That is not
 * pedantry: silently running a program that has already faulted once is how a plant gets started
 * on logic nobody has looked at.
 *
 * @param {object} plc processor state
 * @param {string} mode one of {@link MODE}
 * @returns {{ok:boolean, reason?:string}} refusal with an operator-readable reason
 */
export function setMode(plc, mode) {
  if (!plc || typeof plc !== 'object') {
    return { ok: false, reason: 'There is no processor to change the mode of.' };
  }
  if (!MODE[mode]) {
    return { ok: false, reason: `${mode} is not a processor mode; use PROGRAM, RUN or TEST.` };
  }
  if (mode !== MODE.PROGRAM && plc.faulted) {
    return {
      ok: false,
      reason: `The processor is faulted (${lastMajor(plc)}). `
        + 'Clear the fault before leaving PROGRAM.',
    };
  }
  if (mode !== MODE.PROGRAM && !plc.prog) {
    return { ok: false, reason: 'There is no program loaded, so there is nothing to run.' };
  }
  plc.mode = mode;
  if (mode === MODE.TEST) plc.cursor = 0;
  resetScanState(plc);
  return { ok: true };
}

/**
 * Download a program into the processor.
 *
 * A program with errors is refused, exactly as a real download would be, and the problems come
 * back so the editor can point at them. Warnings — a duplicate coil, an unreachable rung — load
 * fine, because those are things a program is allowed to be wrong about while you are learning.
 *
 * @param {object} plc processor state
 * @param {object} prog the program document
 * @param {object} [db] the tag database to validate against and bind to
 * @returns {{ok:boolean, problems:object[], reason?:string}} the outcome and any problems
 */
export function loadProgram(plc, prog, db) {
  if (!plc || typeof plc !== 'object') {
    return { ok: false, problems: [], reason: 'There is no processor to load a program into.' };
  }
  if (!prog || !Array.isArray(prog.rungs)) {
    return { ok: false, problems: [], reason: 'That is not a ladder program.' };
  }
  if (db) plc.db = db;

  let problems = [];
  if (typeof plc.wiring.validateProgram === 'function') {
    const got = plc.wiring.validateProgram(prog, plc.db);
    if (Array.isArray(got)) problems = got.slice();
  }
  problems = problems.concat(labelProblems(prog));

  if (problems.some((p) => p && p.severity === 'error')) {
    return {
      ok: false,
      problems,
      reason: 'The program has errors and was not downloaded; fix them and load again.',
    };
  }

  plc.prog = prog;
  plc.index = indexProgram(prog);
  plc.power = new Map();
  for (const rung of plc.index.order) {
    plc.power.set(rung.rail, false);
    forEachIndexNode(rung.tree, (n) => plc.power.set(n.key, false));
  }
  resetScanState(plc);
  plc.cursor = 0;
  return { ok: true, problems };
}

/**
 * Solve the loaded program once: every rung, top to bottom, honouring jumps and MCR zones.
 *
 * This is the LOGIC pass only. It does not touch the plant — {@link onScan} brackets it with the
 * input and output passes, and keeping the three separable is what lets a test drive the logic
 * against a hand-built tag image with no simulator in the room.
 *
 * @param {object} plc processor state
 * @param {object} db the tag database
 * @param {object} io the scan bundle handed to each instruction, from {@link createScanIo}
 * @param {number} dt_s scan period, s — the same number the timers integrate on
 * @returns {{ok:boolean, faults:object[], rungsEvaluated:number, reason?:string}} the outcome
 */
export function scanProgram(plc, db, io, dt_s) {
  if (!plc || typeof plc !== 'object') {
    return { ok: false, faults: [], rungsEvaluated: 0, reason: 'There is no processor to scan.' };
  }
  if (!plc.prog) {
    return { ok: false, faults: plc.faults, rungsEvaluated: 0, reason: 'No program is loaded.' };
  }
  if (plc.faulted) {
    return {
      ok: false,
      faults: plc.faults,
      rungsEvaluated: 0,
      reason: 'The processor is faulted; clear the fault to scan again.',
    };
  }
  const step = Number.isFinite(dt_s) && dt_s > 0 ? dt_s : 0;
  const bundle = io || plc.io || createScanIo(plc, null, null);

  beginScan(plc, step);
  const rungs = plc.prog.rungs;
  const work = { rungs: 0, elements: 0, jumps: 0 };
  let i = 0;

  while (i < rungs.length) {
    if (work.rungs >= WATCHDOG.maxRungs || work.elements >= WATCHDOG.maxElements
        || work.jumps >= WATCHDOG.maxJumps) {
      plcFault(plc,
        `Watchdog: the scan did not finish after ${work.rungs} rung evaluations and `
        + `${work.jumps} jumps. A JMP is almost certainly jumping backwards to a label it never `
        + 'gets past.',
        rungs[i] ? rungs[i].id : null);
      break;
    }
    const rung = rungs[i];
    work.rungs += 1;
    const advanceTo = evaluateOneRung(plc, rung, bundle, step, work);
    if (plc.faulted) break;
    if (advanceTo >= 0) {
      work.jumps += 1;
      i = advanceTo;
    } else {
      i += 1;
    }
  }

  endScan(plc, work);
  return {
    ok: !plc.faulted,
    faults: plc.faults,
    rungsEvaluated: work.rungs,
  };
}

/**
 * One whole controller scan: sample the plant, step the recipe, solve the logic, write the plant.
 *
 * Called from `core/sim.js` at the TOP of every controller scan, before the PID executes, which
 * is where a supervisory processor belongs — running it afterwards would put every start, stop
 * and setpoint change one scan late and make the staging logic look sloppier than it is.
 *
 * The input pass runs in every mode including PROGRAM, so the tag browser stays live on a stopped
 * processor. The output pass runs only when the processor is actually executing, so stopping it
 * leaves the plant exactly where the operator left it rather than slamming every command to zero.
 *
 * @param {object} plc processor state
 * @param {object} ctx the simulator context
 * @param {object} [sim] the `core/sim.js` namespace, for output instructions that act through it
 * @param {number} dt_s scan period, s
 * @returns {void}
 */
export function onScan(plc, ctx, sim, dt_s) {
  if (!plc || typeof plc !== 'object' || !plc.db) return;
  const step = Number.isFinite(dt_s) && dt_s > 0 ? dt_s : 0;
  const io = createScanIo(plc, ctx, sim === undefined ? plc.wiring.sim : sim);

  const { wiring } = plc;
  if (typeof wiring.scanInputs === 'function') wiring.scanInputs(plc.db, ctx);
  if (typeof wiring.stepSequencer === 'function') wiring.stepSequencer(plc.db, step);

  if (plc.mode === MODE.RUN) scanProgram(plc, plc.db, io, step);
  else if (plc.mode === MODE.PROGRAM) plc.scan.ms = step * 1000;

  if (plc.mode !== MODE.PROGRAM && !plc.faulted
      && typeof wiring.scanOutputs === 'function') {
    wiring.scanOutputs(plc.db, ctx, io.sim);
  }
}

/**
 * Advance a TEST-mode processor by exactly one rung.
 *
 * Single-stepping is the best teaching tool in the box: hold the scan still, watch one rung
 * energise, look at what it did to the tags, step again. The MCR zone and the jump state carry
 * across calls, so stepping through a program behaves like the same program running slowly rather
 * than like a different program.
 *
 * @param {object} plc processor state
 * @param {object} [db] the tag database, defaulting to the bound one
 * @param {object} [io] the scan bundle
 * @returns {{ok:boolean, rungId?:string|number, index?:number, wrapped?:boolean, reason?:string}}
 *   what was stepped, or a refusal
 */
export function stepOneRung(plc, db, io) {
  if (!plc || typeof plc !== 'object') {
    return { ok: false, reason: 'There is no processor to step.' };
  }
  if (plc.mode !== MODE.TEST) {
    return { ok: false, reason: 'Single-stepping needs the processor in TEST.' };
  }
  if (!plc.prog || plc.prog.rungs.length === 0) {
    return { ok: false, reason: 'No program is loaded, so there is nothing to step.' };
  }
  if (plc.faulted) {
    return { ok: false, reason: 'The processor is faulted; clear the fault to step again.' };
  }
  if (db) plc.db = db;
  const bundle = io || plc.io || createScanIo(plc, null, null);

  if (plc.cursor <= 0) {
    beginScan(plc, plc.scan.ms / 1000);
    plc.cursor = 0;
  }
  const rung = plc.prog.rungs[plc.cursor];
  const work = { rungs: 1, elements: 0, jumps: 0 };
  const advanceTo = evaluateOneRung(plc, rung, bundle, 0, work);
  const index = plc.cursor;
  plc.cursor = advanceTo >= 0 ? advanceTo : plc.cursor + 1;

  let wrapped = false;
  if (plc.cursor >= plc.prog.rungs.length) {
    plc.cursor = 0;
    wrapped = true;
    endScan(plc, work);
  }
  return { ok: !plc.faulted, rungId: rung ? rung.id : null, index, wrapped };
}

/**
 * Power flow at one node, for the live monitor.
 * @param {object} plc processor state
 * @param {string|number} rungId the rung
 * @param {number[]} [path] the node path; the empty path is the left rail
 * @returns {boolean} true when that node was passing power on the last scan
 */
export function powerOf(plc, rungId, path) {
  if (!plc || !plc.power) return false;
  if (!Array.isArray(path) || path.length === 0) return rungPower(plc, rungId);
  return plc.power.get(`${rungId}#${path.join('.')}`) === true;
}

/**
 * Whether a whole rung was solved true — the state of its output column.
 * @param {object} plc processor state
 * @param {string|number} rungId the rung
 * @returns {boolean} true when the rung had power at its outputs on the last scan
 */
export function rungPower(plc, rungId) {
  if (!plc || !plc.power) return false;
  return plc.power.get(`${rungId}#rail`) === true;
}

/**
 * Fault the processor.
 *
 * A MAJOR fault stops the scan and keeps it stopped, because a processor that carries on after its
 * logic has misbehaved is more dangerous than one that has visibly stopped. A MINOR fault is
 * recorded and the scan continues — that is what an instruction reports when a student asks it to
 * divide by zero, and shutting the plant down over it would teach entirely the wrong lesson.
 *
 * Identical messages are folded together and counted, so a fault raised on every scan cannot bury
 * the first one that mattered under ten thousand copies of itself.
 *
 * @param {object} plc processor state
 * @param {string} message an operator-readable sentence
 * @param {string|number|null} [rungId] where it happened
 * @param {string} [severity=SEVERITY.MAJOR] one of {@link SEVERITY}
 * @returns {void}
 */
export function plcFault(plc, message, rungId, severity) {
  if (!plc || typeof plc !== 'object') return;
  const text = String(message || 'The processor faulted for an unrecorded reason.');
  const level = severity === SEVERITY.MINOR ? SEVERITY.MINOR : SEVERITY.MAJOR;
  if (level === SEVERITY.MAJOR) plc.faulted = true;
  const seen = plc.faults.find((f) => f.message === text && f.rungId === (rungId ?? null));
  if (seen) { seen.count += 1; seen.scan = plc.scan.count; return; }
  if (plc.faults.length >= WATCHDOG.maxFaults) return;
  plc.faults.push({
    message: text, rungId: rungId ?? null, severity: level, scan: plc.scan.count, count: 1,
  });
}

/**
 * The message of the newest major fault, for a refusal that has to say what is wrong.
 * @param {object} plc processor state
 * @returns {string} the message, or a placeholder
 */
function lastMajor(plc) {
  for (let i = plc.faults.length - 1; i >= 0; i -= 1) {
    if (plc.faults[i].severity === SEVERITY.MAJOR) return plc.faults[i].message;
  }
  return 'reason not recorded';
}

/**
 * Clear the fault list so the processor can be put back in RUN.
 * @param {object} plc processor state
 * @returns {{ok:boolean, reason?:string}} refusal when there is no processor
 */
export function clearFaults(plc) {
  if (!plc || typeof plc !== 'object') {
    return { ok: false, reason: 'There is no processor to clear.' };
  }
  plc.faults.length = 0;
  plc.faulted = false;
  return { ok: true };
}

/**
 * Build the bundle every instruction is handed: its tags, its timers, its world and the two
 * levers — jump and MCR — by which it can talk back to the scan engine.
 *
 * One bundle is reused for the life of the processor and its `ctx`/`sim` fields are refreshed per
 * scan, because allocating a dozen closures ten times a second for the entire session is exactly
 * the sort of quiet garbage that makes a browser stutter on a trend redraw.
 *
 * @param {object} plc processor state
 * @param {object|null} ctx the simulator context this scan
 * @param {object|null} sim the `core/sim.js` namespace
 * @returns {object} the scan bundle
 */
export function createScanIo(plc, ctx, sim) {
  if (plc.io) {
    plc.io.ctx = ctx;
    plc.io.sim = sim || plc.wiring.sim || null;
    plc.io.db = plc.db;
    return plc.io;
  }
  const tags = plc.wiring.tags || {};
  const io = {
    db: plc.db,
    ctx,
    sim: sim || plc.wiring.sim || null,
    plc,
    /** Incoming power flow to the element being evaluated; `in` is the same value. */
    power: false,
    in: false,
    /** The rung and node path being evaluated, for an instruction that wants to report itself. */
    rung: null,
    path: null,
    /**
     * Read a tag, honouring any force.
     * @param {string} name tag name
     * @returns {*} the value, or undefined when the tag does not exist
     */
    read(name) {
      return typeof tags.readTag === 'function' ? tags.readTag(plc.db, name) : undefined;
    },
    /**
     * Write a tag.
     * @param {string} name tag name
     * @param {*} value the value
     * @returns {{ok:boolean, reason?:string}} the tag database's own answer
     */
    write(name, value) {
      if (typeof tags.writeTag !== 'function') return { ok: false, reason: 'No tag database.' };
      return tags.writeTag(plc.db, name, value);
    },
    /**
     * The mutable structure behind a TIMER tag.
     * @param {string} name tag name
     * @returns {object|undefined} {pre, acc, en, tt, dn}
     */
    timer(name) {
      return typeof tags.timerOf === 'function' ? tags.timerOf(plc.db, name) : undefined;
    },
    /**
     * The mutable structure behind a COUNTER tag.
     * @param {string} name tag name
     * @returns {object|undefined} {pre, acc, cu, cd, dn, ov, un}
     */
    counter(name) {
      return typeof tags.counterOf === 'function' ? tags.counterOf(plc.db, name) : undefined;
    },
    control: {
      /** True while the element being solved sits inside a de-energised MCR zone. */
      inZone: false,
      /**
       * Ask the scan to continue at a label. Honoured after the current rung finishes, which is
       * what a real processor does — the rest of the rung still solves.
       * @param {string} label the LBL operand to jump to
       * @returns {void}
       */
      jump(label) { plc.pendingJump = label; },
      /**
       * An MCR instruction reporting that its own rung has no power, so the zone below it is
       * dead. The engine reaches the same conclusion from the rung's power on its own and
       * overwrites this a moment later; the hook exists because `instructions.js` calls it, and
       * an instruction set that expects to be able to say so should be able to say so.
       * @returns {void}
       */
      mcrOff() { plc.zone.open = true; plc.zone.energised = false; },
      /**
       * Open or close an MCR zone explicitly.
       * @param {boolean|undefined} energised true to open an energised zone, false a dead one,
       *   undefined to close the open zone
       * @returns {void}
       */
      mcr(energised) {
        if (energised === undefined) plc.zone.open = false;
        else { plc.zone.open = true; plc.zone.energised = energised === true; }
      },
      /**
       * Report a MINOR fault from inside an instruction — a divide by zero, an operand that will
       * not resolve. Recorded and shown; the scan carries on.
       * @param {string} message an operator-readable sentence
       * @returns {void}
       */
      fault(message) {
        plcFault(plc, message, io.rung ? io.rung.id : null, SEVERITY.MINOR);
      },
    },
  };
  plc.io = io;
  return io;
}

// ---------------------------------------------------------------------------------------------
// the scan itself
// ---------------------------------------------------------------------------------------------

/**
 * Reset the per-scan state that must not carry over: the MCR zone, any pending jump and the
 * cursor a TEST session was holding.
 * @param {object} plc processor state
 * @returns {void}
 */
function resetScanState(plc) {
  plc.pendingJump = null;
  plc.zone.open = false;
  plc.zone.energised = true;
}

/**
 * Start a scan: blank the power map and reset the zone.
 *
 * Blanking every recorded node rather than only the ones about to be solved is deliberate. A rung
 * that got jumped over must go dark on the monitor; leaving last scan's green on a rung that is
 * no longer being executed is a lie, and it is precisely the lie that stops a student noticing
 * their JMP is skipping the interlock.
 *
 * @param {object} plc processor state
 * @param {number} dt_s scan period, s
 * @returns {void}
 */
function beginScan(plc, dt_s) {
  for (const key of plc.power.keys()) plc.power.set(key, false);
  resetScanState(plc);
  plc.scan.ms = dt_s * 1000;
  if (plc.scan.ms > plc.scan.max) plc.scan.max = plc.scan.ms;
}

/**
 * Finish a scan: count it and publish the work done.
 * @param {object} plc processor state
 * @param {object} work the running totals
 * @returns {void}
 */
function endScan(plc, work) {
  plc.scan.count += 1;
  plc.lastScan.rungsEvaluated = work.rungs;
  plc.lastScan.elementsEvaluated = work.elements;
  plc.lastScan.jumps = work.jumps;
}

/**
 * Solve one rung and decide where the scan goes next.
 *
 * @param {object} plc processor state
 * @param {object} rung the rung
 * @param {object} io the scan bundle
 * @param {number} dt_s scan period, s
 * @param {object} work running work totals (mutated)
 * @returns {number} the rung index to continue at, or -1 to simply carry on downwards
 */
function evaluateOneRung(plc, rung, io, dt_s, work) {
  if (!rung) return -1;
  const idx = plc.index.rungs.get(rung.id) || indexAndStore(plc, rung);
  plc.pendingJump = null;

  // A disabled rung is the ladder equivalent of a commented-out block: it stays visible, it stays
  // dark, and nothing it would have written gets written.
  if (rung.enabled === false) {
    darkenRung(plc, idx);
    return -1;
  }

  // An MCR rung is not solved for outputs, it is solved for its own condition and then acts on
  // the zone. Doing this before the zone test is what lets a dead zone be closed again.
  const mcr = idx.mcr;
  const wasOpen = plc.zone.open;
  const dead = wasOpen && !plc.zone.energised && !mcr;
  io.control.inZone = dead;

  const power = evaluateNodes(plc, rung, rung.nodes || [], idx.tree, !dead, io, dt_s, work);
  plc.power.set(idx.rail, power === true);
  io.control.inZone = false;

  if (dead) forceZoneOutputsOff(plc, rung, io);

  if (mcr) {
    // The zone state is decided here and nowhere else. An MCR instruction may have called
    // `io.control.mcrOff` on its way past, and that must not be allowed to look like a zone that
    // was already open, or the closing MCR of a dead zone would open a second one instead of
    // ending the first and every rung below it would go dark.
    if (wasOpen) plc.zone.open = false;
    else { plc.zone.open = true; plc.zone.energised = power === true; }
    return -1;
  }

  const label = plc.pendingJump !== null ? plc.pendingJump : energisedJumpLabel(plc, idx);
  plc.pendingJump = null;
  if (label === null || label === undefined) return -1;

  const target = plc.index.labels.get(String(label));
  if (target === undefined) {
    plcFault(plc, `JMP to ${label}, but no rung carries a matching LBL.`, rung.id);
    return -1;
  }
  return target;
}

/**
 * Solve a series list of nodes left to right.
 *
 * Series is AND and a branch is OR, and that two-level shape is the whole of ladder. The one
 * subtlety is the empty branch leg: a leg with nothing in it is a wire, so it passes the incoming
 * power straight through, which is how an operator draws "or just carry on" round a contact.
 *
 * @param {object} plc processor state
 * @param {object} rung the rung being solved
 * @param {object[]} nodes the series list
 * @param {object[]} tree the matching index nodes, carrying the precomputed power keys
 * @param {boolean} incoming power arriving from the left
 * @param {object} io the scan bundle
 * @param {number} dt_s scan period, s
 * @param {object} work running work totals (mutated)
 * @returns {boolean} power leaving the right of the list
 */
function evaluateNodes(plc, rung, nodes, tree, incoming, io, dt_s, work) {
  let power = incoming === true;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const idx = tree && tree[i] ? tree[i] : { key: `${rung.id}#${i}`, path: [i] };
    const legs = legsOf(node);
    if (legs) {
      let any = false;
      for (let j = 0; j < legs.length; j += 1) {
        const legTree = idx.legs ? idx.legs[j] : null;
        const out = evaluateNodes(plc, rung, legs[j], legTree, power, io, dt_s, work);
        // Every leg is solved, not just the ones up to the first true one. A leg holds output
        // instructions in real programs, and short-circuiting the OR would leave a timer in the
        // second leg frozen for as long as the first leg happened to be making power.
        if (out) any = true;
      }
      if (legs.length === 0) any = power;
      power = any === true;
      plc.power.set(idx.key, power);
    } else {
      power = evaluateElement(plc, rung, node, idx, power, io, dt_s, work);
      plc.power.set(idx.key, power);
    }
    if (plc.faulted) return false;
  }
  return power;
}

/**
 * Execute one instruction and work out the power leaving it.
 *
 * Every element is executed on every scan, whether or not it has power, and that is not a waste:
 * a TON with no power is a TON that must reset, a TOF with no power is a TOF that must be timing,
 * and an OTE with no power is an OTE that must write false. An engine that only calls instructions
 * on live rungs produces timers that stick and coils that never drop, and those are the two bugs
 * that make a hand-rolled ladder simulator useless.
 *
 * The incoming power is handed over on `io.power` and as a fifth argument, and what comes back is
 * taken as the power leaving the element without being ANDed with what went in — see the note at
 * the top of the file, and OSF, which is the instruction that proves the rule.
 *
 * @param {object} plc processor state
 * @param {object} rung the rung
 * @param {object} el the element
 * @param {object} idx its index node
 * @param {boolean} power incoming power
 * @param {object} io the scan bundle
 * @param {number} dt_s scan period, s
 * @param {object} work running work totals (mutated)
 * @returns {boolean} outgoing power
 */
function evaluateElement(plc, rung, el, idx, power, io, dt_s, work) {
  work.elements += 1;
  const spec = plc.instructions ? plc.instructions[el && el.mnemonic] : null;
  if (!spec || typeof spec.evaluate !== 'function') {
    plcFault(plc,
      `Rung uses ${el && el.mnemonic ? el.mnemonic : 'an unnamed instruction'}, which this `
      + 'processor does not have.', rung.id);
    return false;
  }
  io.power = power;
  io.in = power;
  io.rung = rung;
  io.path = idx.path;

  try {
    return spec.evaluate(rung, el, io, dt_s, power) === true;
  } catch (err) {
    // An instruction that throws is a defect in the instruction, not in the operator's program —
    // `instructions.js` answers arithmetic with no answer by dropping power, not by throwing. So
    // this is a major fault with a sentence attached, rather than an exception escaping into the
    // animation frame and taking the whole page down with it.
    plcFault(plc, `${el.mnemonic} faulted: ${err && err.message ? err.message : String(err)}`,
      rung.id);
    return false;
  }
}

/**
 * Drop every non-retentive output on a rung inside a de-energised MCR zone.
 *
 * The rung has already been solved with a dead rail, so a well-behaved OTE has written false
 * already. This is the belt to that braces: the zone rule is a safety construct and it has to
 * hold whatever an individual instruction chose to do with zero power.
 *
 * @param {object} plc processor state
 * @param {object} rung the rung
 * @param {object} io the scan bundle
 * @returns {void}
 */
function forceZoneOutputsOff(plc, rung, io) {
  walkRungElements(rung, (el) => {
    const spec = plc.instructions ? plc.instructions[el.mnemonic] : null;
    if (!spec || spec.kind !== KIND_COIL) return;
    if (RETENTIVE_OUTPUTS[el.mnemonic]) return;
    // JMP is coil-shaped and its operand is a LABEL, not a tag; writing false to it would invent
    // a tag and corrupt the database. So the drop is narrowed to what it is actually for: a coil
    // whose first operand slot is declared as a BOOL destination, holding a real tag name.
    const slot = spec.operands && spec.operands[0];
    if (!slot || slot.role !== 'dest' || !slot.kinds || !slot.kinds.includes('BOOL')) return;
    const tag = operandName(el, 0);
    if (!tag || !TAG_NAME.test(tag)) return;
    const exists = plc.wiring.tags && plc.wiring.tags.tagExists;
    if (typeof exists === 'function' && !exists(plc.db, tag)) return;
    io.write(tag, false);
  });
}

/**
 * Mark every node of a rung dark without solving it.
 * @param {object} plc processor state
 * @param {object} idx the rung's index entry
 * @returns {void}
 */
function darkenRung(plc, idx) {
  plc.power.set(idx.rail, false);
  forEachIndexNode(idx.tree, (n) => plc.power.set(n.key, false));
}

/**
 * The label of an energised JMP on this rung.
 *
 * A JMP can report itself either way: by calling `io.control.jump` from its own evaluate, or
 * simply by making power. Honouring both means the engine cannot be broken by an instruction set
 * that chose the other convention, and the JMP nodes were found once at load so this costs a
 * lookup rather than a walk.
 *
 * @param {object} plc processor state
 * @param {object} idx the rung's index entry
 * @returns {string|null} the label, or null
 */
function energisedJumpLabel(plc, idx) {
  for (const j of idx.jumps) {
    if (plc.power.get(j.key) === true) return j.label;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// program index: the precomputed power keys and the label table
// ---------------------------------------------------------------------------------------------

/**
 * Build the whole-program index: one entry per rung carrying its power keys, plus the label table
 * jumps resolve against.
 * @param {object} prog the program
 * @returns {{rungs:Map, labels:Map, order:object[]}} the index
 */
function indexProgram(prog) {
  const index = { rungs: new Map(), labels: new Map(), order: [] };
  prog.rungs.forEach((rung, i) => {
    const entry = indexRung(rung);
    index.rungs.set(rung.id, entry);
    index.order.push(entry);
    walkRungElements(rung, (el) => {
      if (el.mnemonic !== 'LBL') return;
      const name = labelText(el);
      if (name && !index.labels.has(name)) index.labels.set(name, i);
    });
  });
  return index;
}

/**
 * Index one rung: a tree of nodes mirroring its shape, each carrying the string key its power is
 * recorded under and the path the editor addresses it by, plus the two things the scan would
 * otherwise have to go looking for on every pass — where the JMPs are and whether this rung is an
 * MCR boundary.
 * @param {object} rung the rung
 * @returns {{rail:string, tree:object[], jumps:object[], mcr:boolean}} the entry
 */
function indexRung(rung) {
  const jumps = [];
  let mcr = false;
  /**
   * @param {object[]} list a series list
   * @param {number[]} base the path of the list
   * @returns {object[]} the index nodes
   */
  const walk = (list, base) => (list || []).map((node, i) => {
    const path = base.concat(i);
    const key = `${rung.id}#${path.join('.')}`;
    const legs = legsOf(node);
    if (legs) return { key, path, legs: legs.map((leg, j) => walk(leg, path.concat(j))) };
    if (node && node.mnemonic === 'JMP') jumps.push({ key, label: labelText(node) });
    if (node && node.mnemonic === 'MCR') mcr = true;
    return { key, path };
  });
  const tree = walk(rung.nodes, []);
  return { rail: `${rung.id}#rail`, tree, jumps, mcr };
}

/**
 * Index a rung the loader has not seen — an editor can add one between downloads and the monitor
 * should still light it rather than silently ignoring it.
 * @param {object} plc processor state
 * @param {object} rung the rung
 * @returns {object} the entry
 */
function indexAndStore(plc, rung) {
  const entry = indexRung(rung);
  plc.index.rungs.set(rung.id, entry);
  plc.power.set(entry.rail, false);
  forEachIndexNode(entry.tree, (n) => plc.power.set(n.key, false));
  return entry;
}

/**
 * Every rung that defines a label twice, and every JMP with no matching LBL, as load problems.
 * @param {object} prog the program
 * @returns {object[]} problems
 */
function labelProblems(prog) {
  const problems = [];
  const seen = new Map();
  const jumps = [];
  prog.rungs.forEach((rung) => {
    walkRungElements(rung, (el, path) => {
      const name = labelText(el);
      if (el.mnemonic === 'LBL') {
        if (seen.has(name)) {
          problems.push({
            rungId: rung.id,
            path,
            severity: 'error',
            message: `LBL ${name} is defined twice; a jump to it could not say which rung it meant.`,
          });
        } else seen.set(name, rung.id);
      } else if (el.mnemonic === 'JMP') {
        jumps.push({ rungId: rung.id, path, name });
      }
    });
  });
  for (const j of jumps) {
    if (seen.has(j.name)) continue;
    problems.push({
      rungId: j.rungId,
      path: j.path,
      severity: 'error',
      message: `JMP ${j.name} has no matching LBL, so the scan would have nowhere to go.`,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// rung structure helpers
//
// These duck-type the document rather than importing `model.js`, so a change to the exact field
// name a branch stores its legs under cannot stop the processor scanning.
// ---------------------------------------------------------------------------------------------

/**
 * The parallel legs of a branch node, or null when the node is an element.
 * @param {object} node a rung node
 * @returns {object[][]|null} the legs
 */
function legsOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.legs)) return node.legs;
  if (Array.isArray(node.branches)) return node.branches;
  if (Array.isArray(node.paths)) return node.paths;
  if (node.kind === 'BRANCH' && Array.isArray(node.nodes)) return node.nodes;
  return null;
}

/**
 * Visit every element of a rung in evaluation order.
 * @param {object} rung the rung
 * @param {(el:object, path:number[])=>void} fn the visitor
 * @returns {void}
 */
function walkRungElements(rung, fn) {
  /**
   * @param {object[]} list a series list
   * @param {number[]} base the list's path
   * @returns {void}
   */
  const walk = (list, base) => {
    (list || []).forEach((node, i) => {
      const path = base.concat(i);
      const legs = legsOf(node);
      if (legs) legs.forEach((leg, j) => walk(leg, path.concat(j)));
      else if (node && node.mnemonic) fn(node, path);
    });
  };
  walk(rung && rung.nodes, []);
}

/**
 * Visit every node of an index tree.
 * @param {object[]} tree the index tree
 * @param {(node:object)=>void} fn the visitor
 * @returns {void}
 */
function forEachIndexNode(tree, fn) {
  (tree || []).forEach((node) => {
    fn(node);
    if (node.legs) node.legs.forEach((leg) => forEachIndexNode(leg, fn));
  });
}

/**
 * A label operand, normalised.
 *
 * `instructions.js` strips the quotes off a label before it jumps, because the text format allows
 * `LBL 'RESTART'` as readily as `LBL RESTART`. The label table has to strip them the same way or
 * a program that quotes its labels parses, validates, downloads and then jumps to nowhere.
 *
 * @param {object} el the element
 * @returns {string} the label text, possibly empty
 */
function labelText(el) {
  const raw = operandName(el, 0);
  return raw === null ? '' : String(raw).trim().replace(/^['"]|['"]$/g, '');
}

/**
 * The name an operand carries, whether the document stores operands as bare strings or as objects.
 * @param {object} el the element
 * @param {number} i the operand index
 * @returns {string|null} the name
 */
function operandName(el, i) {
  const ops = (el && (el.operands || el.args || el.ops)) || [];
  const op = ops[i];
  if (op === undefined || op === null) return null;
  if (typeof op === 'string') return op;
  if (typeof op === 'object') {
    const v = op.tag || op.name || op.value || op.label;
    return typeof v === 'string' ? v : null;
  }
  return null;
}
