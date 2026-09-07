/**
 * tests/solver.test.js — the scan engine: series and branch solving, power flow recording, jumps,
 * MCR zones, the watchdog, and the three passes of a scan staying in the right order.
 *
 * The solver is tested against a stub instruction set and a stub tag database rather than against
 * the real ones. That is on purpose: every claim here is a claim about the ENGINE — that a branch
 * ORs, that a de-energised zone drops its coils, that a backwards jump faults instead of hanging —
 * and mixing in the real instruction set would mean a failure could be either module's fault. The
 * stubs are also the executable statement of the contract the engine offers an instruction:
 * incoming power arrives on `io.power`, and what you return is the power leaving you.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE, SEVERITY, WATCHDOG, createPlcState, loadProgram, setMode, scanProgram, onScan,
  stepOneRung, powerOf, rungPower, clearFaults,
} from '../src/plc/solver.js';
import { createProgram, createRung, createElement, createBranch, addRung } from '../src/plc/model.js';
import { createTagDb, defineTag, readTag, writeTag, TYPE, SCOPE } from '../src/plc/tags.js';

// --- a tag database, small enough to read ------------------------------------------------------

/**
 * A stand-in for `tags.js` with the four accessors the solver actually uses.
 * @returns {object} the database
 */
function createDb() {
  return { values: new Map(), timers: new Map(), counters: new Map() };
}

const tags = {
  /**
   * @param {object} db the database
   * @param {string} name tag name
   * @returns {*} the value
   */
  readTag: (db, name) => db.values.get(name),
  /**
   * @param {object} db the database
   * @param {string} name tag name
   * @param {*} value the value
   * @returns {{ok:boolean}} always accepted
   */
  writeTag: (db, name, value) => { db.values.set(name, value); return { ok: true }; },
  /**
   * @param {object} db the database
   * @param {string} name tag name
   * @returns {object} the timer structure
   */
  timerOf: (db, name) => {
    if (!db.timers.has(name)) {
      db.timers.set(name, { pre: 1000, acc: 0, en: false, tt: false, dn: false });
    }
    return db.timers.get(name);
  },
  /**
   * @param {object} db the database
   * @param {string} name tag name
   * @returns {object} the counter structure
   */
  counterOf: (db, name) => {
    if (!db.counters.has(name)) db.counters.set(name, { pre: 0, acc: 0, dn: false });
    return db.counters.get(name);
  },
};

// --- a stub instruction set --------------------------------------------------------------------

/** How many times each stub was executed, so "executed every scan" can be asserted. */
const ran = new Map();

/**
 * Count an execution.
 * @param {string} what a label
 * @returns {void}
 */
function tick(what) { ran.set(what, (ran.get(what) || 0) + 1); }

const INSTRUCTIONS = Object.freeze({
  XIC: {
    mnemonic: 'XIC', kind: 'CONTACT',
    /**
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => io.power && io.read(el.operands[0]) === true,
  },
  XIO: {
    mnemonic: 'XIO', kind: 'CONTACT',
    /**
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => io.power && io.read(el.operands[0]) !== true,
  },
  OTE: {
    mnemonic: 'OTE', kind: 'COIL', operands: [{ name: 'bit', kinds: ['BOOL'], role: 'dest' }],
    /**
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => {
      tick(`OTE ${el.operands[0]}`);
      io.write(el.operands[0], io.power === true);
      return io.power;
    },
  },
  OTL: {
    mnemonic: 'OTL', kind: 'COIL', operands: [{ name: 'bit', kinds: ['BOOL'], role: 'dest' }],
    /**
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => {
      if (io.power) io.write(el.operands[0], true);
      return io.power;
    },
  },
  TON: {
    mnemonic: 'TON', kind: 'COIL',
    /**
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @param {number} dt_s scan period
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io, dt_s) => {
      const t = io.timer(el.operands[0]);
      if (!io.power) { t.acc = 0; t.en = false; t.tt = false; t.dn = false; return false; }
      t.en = true;
      t.acc = Math.min(t.pre, t.acc + dt_s * 1000);
      t.dn = t.acc >= t.pre;
      t.tt = !t.dn;
      return io.power;
    },
  },
  JMP: {
    mnemonic: 'JMP', kind: 'COIL',
    /**
     * A JMP that reports itself only by making power, so the engine's own detection is exercised.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => io.power,
  },
  JSR: {
    mnemonic: 'JSR', kind: 'COIL',
    /**
     * A JMP that reports itself the other way, through `io.control.jump`.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => {
      if (io.power) io.control.jump(el.operands[0]);
      return io.power;
    },
  },
  LBL: {
    mnemonic: 'LBL', kind: 'COIL',
    /**
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => io.power,
  },
  MCR: {
    mnemonic: 'MCR', kind: 'COIL',
    /**
     * The zone itself is the engine's business; the instruction only passes power.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => io.power,
  },
  COUNT: {
    mnemonic: 'COUNT', kind: 'BLOCK',
    /**
     * Records that it was reached, powered or not, and passes power through unchanged.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => { tick(el.operands[0]); return io.power; },
  },
  POKE: {
    mnemonic: 'POKE', kind: 'COIL',
    /**
     * Reaches around the input image and changes the plant mid-scan, which no honest instruction
     * would do — it exists so the test can prove the logic does not see it until the next scan.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => { if (io.ctx) io.ctx.raw = true; return io.power; },
  },
  PROBE: {
    mnemonic: 'PROBE', kind: 'COIL',
    /**
     * Records what the plant looked like at this point in the logic.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => { if (io.ctx) io.ctx.seen = io.ctx.plantRun; return io.power; },
  },
  STICKY: {
    mnemonic: 'STICKY', kind: 'COIL', operands: [{ name: 'bit', kinds: ['BOOL'], role: 'dest' }],
    /**
     * A badly behaved coil that writes true whether it has power or not — the engine's MCR rule
     * has to hold even against an instruction like this one.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => { io.write(el.operands[0], true); return io.power; },
  },
  GRIPE: {
    mnemonic: 'GRIPE', kind: 'BLOCK',
    /**
     * Reports a minor fault, the way a divide by zero does, and drops power.
     * @param {object} r the rung
     * @param {object} el the element
     * @param {object} io the scan bundle
     * @returns {boolean} outgoing power
     */
    evaluate: (r, el, io) => { io.control.fault('GRIPE: divide by zero'); return false; },
  },
  BOOM: {
    mnemonic: 'BOOM', kind: 'BLOCK',
    /**
     * @returns {boolean} never; it throws, the way a divide by zero would
     */
    evaluate: () => { throw new Error('divide by zero'); },
  },
});

// --- program construction ----------------------------------------------------------------------

/**
 * An element.
 * @param {string} mnemonic the instruction
 * @param {...*} operands its operands
 * @returns {object} the element
 */
const el = (mnemonic, ...operands) => ({ mnemonic, operands });

/**
 * A branch of parallel legs.
 * @param {...object[]} legs each leg a series list of nodes
 * @returns {object} the branch node
 */
const br = (...legs) => ({ kind: 'BRANCH', legs });

/**
 * A rung.
 * @param {string} id the rung id
 * @param {...object} nodes its series list
 * @returns {object} the rung
 */
const rung = (id, ...nodes) => ({ id, comment: '', nodes, enabled: true });

/**
 * A program.
 * @param {...object} rungs its rungs
 * @returns {object} the program document
 */
const program = (...rungs) => ({ v: 1, name: 'bench', rungs, meta: {} });

/**
 * A loaded, running processor on a fresh database.
 * @param {object} prog the program
 * @param {object} [wiring] extra wiring: scanInputs, scanOutputs, sim
 * @returns {object} the bench
 */
function bench(prog, wiring) {
  ran.clear();
  const db = createDb();
  const plc = createPlcState(null, db, {
    // The engine's real defaults are the real instruction set, the real tag database and the real
    // IO bridge. All of them are replaced here: every claim in this file is a claim about the
    // ENGINE, and a stub world is what makes a failure unambiguous.
    instructions: INSTRUCTIONS,
    tags,
    scanInputs: null,
    scanOutputs: null,
    validateProgram: null,
    ...(wiring || {}),
  });
  const load = loadProgram(plc, prog, db);
  assert.equal(load.ok, true,
    `the bench program must download cleanly: ${JSON.stringify(load.problems)}`);
  assert.equal(setMode(plc, MODE.RUN).ok, true, 'and the processor must go to RUN');
  return {
    db,
    plc,
    /**
     * @param {string} name tag name
     * @returns {*} the value
     */
    get: (name) => db.values.get(name),
    /**
     * @param {string} name tag name
     * @param {*} v the value
     * @returns {void}
     */
    set: (name, v) => { db.values.set(name, v); },
    /**
     * @param {number} [dt_s=0.2] the scan period
     * @returns {object} the scan result
     */
    scan: (dt_s = 0.2) => scanProgram(plc, db, null, dt_s),
  };
}

// --- the tests ---------------------------------------------------------------------------------

test('a seal-in circuit latches on a momentary start and holds until the stop contact opens', () => {
  const b = bench(program(
    rung('r1', br([el('XIC', 'I.START')], [el('XIC', 'M.RUN')]), el('XIO', 'I.STOP'),
      el('OTE', 'M.RUN')),
    rung('r2', el('XIC', 'M.RUN'), el('OTE', 'Q.P1_START')),
  ));

  b.scan();
  assert.equal(b.get('M.RUN'), false, 'nothing pressed, nothing latched');

  b.set('I.START', true);
  b.scan();
  assert.equal(b.get('M.RUN'), true, 'the start contact must pick the coil up');
  assert.equal(b.get('Q.P1_START'), true,
    'and a coil written on rung 1 must be visible to rung 2 in the same scan, or no cross-rung '
    + 'sequencing works at all');

  b.set('I.START', false);
  b.scan();
  b.scan();
  assert.equal(b.get('M.RUN'), true,
    'the seal-in leg must hold the coil once the momentary start has cleared — if this fails the '
    + 'branch is not being solved with the coil it wrote last scan');

  b.set('I.STOP', true);
  b.scan();
  assert.equal(b.get('M.RUN'), false, 'the stop contact must break the seal');
  assert.equal(b.get('Q.P1_START'), false, 'and the machine must drop out with it');

  b.set('I.STOP', false);
  b.scan();
  assert.equal(b.get('M.RUN'), false,
    'and it must NOT restart when the stop is released — a circuit that self-restarts on a '
    + 'released stop button is the classic lethal ladder bug');
});

test('a branch makes power when either leg does, and every leg is solved even when one wins', () => {
  const b = bench(program(
    rung('r1',
      br([el('XIC', 'I.A')], [el('XIC', 'I.B'), el('COUNT', 'legB')]),
      el('OTE', 'Q.OUT')),
  ));

  b.scan();
  assert.equal(b.get('Q.OUT'), false, 'neither leg has power, so the rung is false');

  b.set('I.A', true);
  b.scan();
  assert.equal(b.get('Q.OUT'), true, 'the first leg alone must make power');
  assert.equal(ran.get('legB'), 2,
    'and the second leg must still have been solved — short-circuiting the OR would freeze any '
    + 'timer or counter sitting in a leg the scan skipped');

  b.set('I.A', false);
  b.set('I.B', true);
  b.scan();
  assert.equal(b.get('Q.OUT'), true, 'the second leg alone must make power too');

  b.set('I.B', false);
  b.scan();
  assert.equal(b.get('Q.OUT'), false, 'and with both legs open the rung must drop');
});

test('power flow is recorded at every node, inside branch legs included', () => {
  const b = bench(program(
    rung('r1',
      br([el('XIC', 'I.A')], [el('XIC', 'I.B')]),
      el('XIO', 'I.STOP'),
      el('OTE', 'Q.OUT')),
  ));
  b.set('I.A', true);
  b.scan();

  assert.equal(powerOf(b.plc, 'r1', [0, 0, 0]), true, 'the live leg must light');
  assert.equal(powerOf(b.plc, 'r1', [0, 1, 0]), false, 'the dead leg must not');
  assert.equal(powerOf(b.plc, 'r1', [0]), true, 'the branch as a whole must pass power');
  assert.equal(powerOf(b.plc, 'r1', [1]), true, 'and so must the series contact after it');
  assert.equal(powerOf(b.plc, 'r1', [2]), true, 'the coil lights with the rung');
  assert.equal(rungPower(b.plc, 'r1'), true, 'and the rung reads true');

  b.set('I.STOP', true);
  b.scan();
  assert.equal(powerOf(b.plc, 'r1', [0, 0, 0]), true,
    'the branch is still making power — the monitor has to show WHERE the power stopped');
  assert.equal(powerOf(b.plc, 'r1', [1]), false, 'and it stopped at the stop contact');
  assert.equal(powerOf(b.plc, 'r1', [2]), false, 'so the coil is dark');
  assert.equal(rungPower(b.plc, 'r1'), false, 'and the rung is false');
});

test('a JMP skips the rungs between it and its label, and the skipped rungs go dark', () => {
  const b = bench(program(
    rung('r1', el('XIC', 'I.SKIP'), el('JMP', 'AFTER')),
    rung('r2', el('COUNT', 'skipped'), el('OTE', 'Q.MID')),
    rung('r3', el('LBL', 'AFTER')),
    rung('r4', el('OTE', 'Q.END')),
  ));

  b.scan();
  assert.equal(b.get('Q.MID'), true, 'with the jump condition false the middle rung runs');
  assert.equal(ran.get('skipped'), 1, 'and its elements are executed');

  b.set('I.SKIP', true);
  b.scan();
  assert.equal(ran.get('skipped'), 1,
    'the jumped-over rung must not be executed at all — a skipped rung that still ran would make '
    + 'JMP useless for the thing it is for');
  assert.equal(b.get('Q.MID'), true,
    'and its coil must HOLD its last state rather than dropping, which is what makes JMP over '
    + 'outputs dangerous and worth seeing');
  assert.equal(rungPower(b.plc, 'r2'), false,
    'but it must go dark on the monitor, or the student never notices the interlock is skipped');
  assert.equal(b.get('Q.END'), true, 'and the scan must land after the label and carry on');
});

test('a JMP reported through io.control.jump is honoured as well as one that only makes power', () => {
  const b = bench(program(
    rung('r1', el('XIC', 'I.SKIP'), el('JSR', 'AFTER')),
    rung('r2', el('OTE', 'Q.MID')),
    rung('r3', el('LBL', 'AFTER'), el('OTE', 'Q.END')),
  ));
  b.set('I.SKIP', true);
  b.scan();
  assert.equal(b.get('Q.MID'), undefined,
    'the middle rung must never have run, so its coil was never written');
  assert.equal(b.get('Q.END'), true, 'and the scan resumed at the label');
});

test('a JMP that jumps backwards faults the watchdog instead of locking the browser', () => {
  const b = bench(program(
    rung('r1', el('LBL', 'TOP')),
    rung('r2', el('XIC', 'I.LOOP'), el('JMP', 'TOP')),
    rung('r3', el('OTE', 'Q.NEVER')),
  ));

  b.set('I.LOOP', true);
  const res = b.scan();

  assert.equal(res.ok, false, 'a scan that never finishes must not report success');
  assert.equal(b.plc.faults.length, 1, 'and it must leave exactly one fault standing');
  assert.equal(b.plc.faults[0].severity, SEVERITY.MAJOR,
    'a scan that never ends is a major fault — the processor must stop, not carry on');
  const msg = b.plc.faults[0].message;
  assert.match(msg, /watchdog/i, `the fault must name itself as the watchdog, got: ${msg}`);
  assert.match(msg, /JMP/,
    `and it must point the beginner at the jump, got: ${msg}`);
  assert.ok(res.rungsEvaluated <= WATCHDOG.maxRungs + 1,
    `the engine must stop at the cap, not run away: it evaluated ${res.rungsEvaluated} rungs`);
  assert.equal(b.get('Q.NEVER'), undefined, 'and the rung below the loop was never reached');

  assert.equal(b.scan().ok, false, 'a faulted processor must stay stopped');
  assert.equal(setMode(b.plc, MODE.RUN).ok, false,
    'and it must refuse to be put back in RUN while the fault stands');
  assert.equal(clearFaults(b.plc).ok, true, 'clearing the fault is the operator action');
  b.set('I.LOOP', false);
  assert.equal(setMode(b.plc, MODE.RUN).ok, true, 'after which it runs again');
  assert.equal(b.scan().ok, true, 'and the scan completes');
  assert.equal(b.get('Q.NEVER'), true, 'reaching the rung the loop was starving');
});

test('a program whose JMP has no matching LBL is refused at download', () => {
  const db = createDb();
  const plc = createPlcState(null, db, { instructions: INSTRUCTIONS, tags, validateProgram: null });
  const plcProg = program(rung('r1', el('JMP', 'NOWHERE')));
  const res = loadProgram(plc, plcProg, db);
  assert.equal(res.ok, false, 'the download must be refused, not accepted and faulted later');
  assert.equal(plc.prog, null, 'and nothing must have been installed');
  assert.match(res.problems[0].message, /NOWHERE/,
    'the problem must name the label the program asked for');
  assert.equal(setMode(plc, MODE.RUN).ok, false, 'with no program there is nothing to run');
});

test('a de-energised MCR zone drives its coils false and leaves its latches alone', () => {
  const b = bench(program(
    rung('r1', el('XIC', 'I.ZONE'), el('MCR')),
    rung('r2', el('XIC', 'I.A'), el('OTE', 'Q.INSIDE')),
    rung('r3', el('XIC', 'I.A'), el('OTL', 'M.LATCH')),
    rung('r4', el('MCR')),
    rung('r5', el('XIC', 'I.A'), el('OTE', 'Q.OUTSIDE')),
  ));

  b.set('I.ZONE', true);
  b.set('I.A', true);
  b.scan();
  assert.equal(b.get('Q.INSIDE'), true, 'an energised zone runs normally');
  assert.equal(b.get('M.LATCH'), true, 'and its latch sets');
  assert.equal(b.get('Q.OUTSIDE'), true, 'as does everything past the closing MCR');

  b.set('I.ZONE', false);
  b.scan();
  assert.equal(b.get('Q.INSIDE'), false,
    'a zone that loses power must drop its non-retentive outputs even though their own conditions '
    + 'are still true — that is the entire purpose of MCR');
  assert.equal(b.get('M.LATCH'), true,
    'but a latch is retentive and must survive the zone dropping, or MCR could not be used to '
    + 'shed a section without losing the plant state underneath it');
  assert.equal(b.get('Q.OUTSIDE'), true,
    'and the closing MCR must end the zone, leaving the rest of the program running');
  assert.equal(rungPower(b.plc, 'r2'), false, 'the dead zone shows dark on the monitor');
  assert.equal(rungPower(b.plc, 'r5'), true, 'and the rung outside it does not');

  b.set('I.ZONE', true);
  b.scan();
  assert.equal(b.get('Q.INSIDE'), true, 'and the zone comes back when it is powered again');
});

test('a de-energised MCR zone drops a coil even when the coil instruction ignores power', () => {
  const b = bench(program(
    rung('r1', el('XIC', 'I.ZONE'), el('MCR')),
    rung('r2', el('STICKY', 'Q.STUCK')),
    rung('r3', el('MCR')),
  ));

  b.set('I.ZONE', true);
  b.scan();
  assert.equal(b.get('Q.STUCK'), true, 'the badly behaved coil writes itself true, as it would');

  b.set('I.ZONE', false);
  b.scan();
  assert.equal(b.get('Q.STUCK'), false,
    'and the zone rule must still drop it — MCR is the construct a program uses to shed a whole '
    + 'section, so the engine has to enforce it rather than hoping every instruction is polite');
});

test('a minor fault is recorded and the scan carries on, unlike a major one', () => {
  const b = bench(program(
    rung('r1', el('GRIPE'), el('OTE', 'Q.NEVER')),
    rung('r2', el('OTE', 'Q.AFTER')),
  ));

  const res = b.scan();
  assert.equal(res.ok, true,
    'a divide by zero must not stop the plant — the instruction drops power and says so');
  assert.equal(b.plc.faults[0].severity, SEVERITY.MINOR, 'and it is recorded as minor');
  assert.equal(b.get('Q.NEVER'), false, 'the coil after it goes out, which is the fault light');
  assert.equal(b.get('Q.AFTER'), true, 'and the rest of the program ran');

  b.scan();
  b.scan();
  assert.equal(b.plc.faults.length, 1,
    'a fault raised every scan must fold into one entry with a count, or the first fault that '
    + 'mattered is buried under ten thousand copies of the newest one');
  assert.equal(b.plc.faults[0].count, 3, 'counted, not lost');
});

test('the input image is sampled once, so a change the logic causes is not seen until next scan', () => {
  const ctx = { raw: false };
  const b = bench(program(
    rung('r1', el('POKE')),
    rung('r2', el('XIC', 'I.RAW'), el('OTE', 'M.SAW')),
  ), {
    /**
     * @param {object} db the database
     * @param {object} c the simulator context
     * @returns {void}
     */
    scanInputs: (db, c) => { db.values.set('I.RAW', c.raw === true); },
  });

  onScan(b.plc, ctx, null, 0.2);
  assert.equal(ctx.raw, true, 'the logic did change the plant');
  assert.equal(b.get('M.SAW'), false,
    'but the rung below must still be reading the input image sampled BEFORE the logic ran — a '
    + 'scan where a later rung sees a fresher input than an earlier one makes every interlock '
    + 'argument unsound');

  onScan(b.plc, ctx, null, 0.2);
  assert.equal(b.get('M.SAW'), true, 'and the next scan picks it up, exactly one scan later');
});

test('the output image reaches the plant only after the whole program has been solved', () => {
  const ctx = { on: true, plantRun: false, seen: null };
  const b = bench(program(
    rung('r1', el('XIC', 'I.ON'), el('OTE', 'Q.CMD')),
    rung('r2', el('XIC', 'Q.CMD'), el('OTE', 'M.ECHO')),
    rung('r3', el('PROBE')),
  ), {
    /**
     * @param {object} db the database
     * @param {object} c the simulator context
     * @returns {void}
     */
    scanInputs: (db, c) => { db.values.set('I.ON', c.on === true); },
    /**
     * @param {object} db the database
     * @param {object} c the simulator context
     * @returns {void}
     */
    scanOutputs: (db, c) => { c.plantRun = db.values.get('Q.CMD') === true; },
  });

  onScan(b.plc, ctx, null, 0.2);
  assert.equal(ctx.seen, false,
    'the plant must not have been written while the logic was still running — the output pass is '
    + 'once, at the end, or a coil that is set on rung 4 and cleared on rung 40 would flick a real '
    + 'contactor on the way past');
  assert.equal(ctx.plantRun, true, 'and by the end of the scan the plant has the answer');
  assert.equal(b.get('M.ECHO'), true,
    'the output IMAGE, though, is visible to later rungs in the same scan, which is what every '
    + 'processor does and what cross-rung interlocking depends on');
});

test('a stopped processor still samples its inputs but writes nothing to the plant', () => {
  const ctx = { on: true, plantRun: false };
  const b = bench(program(
    rung('r1', el('XIC', 'I.ON'), el('OTE', 'Q.CMD')),
  ), {
    /**
     * @param {object} db the database
     * @param {object} c the simulator context
     * @returns {void}
     */
    scanInputs: (db, c) => { db.values.set('I.ON', c.on === true); },
    /**
     * @param {object} db the database
     * @param {object} c the simulator context
     * @returns {void}
     */
    scanOutputs: (db, c) => { c.plantRun = db.values.get('Q.CMD') === true; },
  });

  assert.equal(setMode(b.plc, MODE.PROGRAM).ok, true, 'the key goes to PROGRAM');
  onScan(b.plc, ctx, null, 0.2);
  assert.equal(b.get('I.ON'), true,
    'the input image must keep updating so the tag browser stays live on a stopped processor');
  assert.equal(b.get('Q.CMD'), undefined, 'but no logic ran');
  assert.equal(ctx.plantRun, false,
    'and nothing was written to the plant — stopping the processor leaves the rig where the '
    + 'operator left it rather than slamming every command to zero');
});

test('every output instruction is executed on every scan, powered or not', () => {
  const b = bench(program(
    rung('r1', el('XIC', 'I.RUN'), el('TON', 'T.DLY')),
    rung('r2', el('COUNT', 'always')),
  ));

  b.set('I.RUN', true);
  b.scan(0.2);
  b.scan(0.2);
  assert.equal(b.db.timers.get('T.DLY').acc, 400, 'the timer accumulates on the scan period it is given');

  b.set('I.RUN', false);
  b.scan(0.2);
  assert.equal(b.db.timers.get('T.DLY').acc, 0,
    'and it must RESET when its rung goes false, which can only happen if the engine calls output '
    + 'instructions on dead rungs too — an engine that skips them leaves timers stuck forever');
  assert.equal(ran.get('always'), 3, 'and a block on a live rung runs once per scan, no more');
});

test('an instruction that throws faults the processor with a readable message instead of escaping', () => {
  const b = bench(program(
    rung('r1', el('BOOM')),
    rung('r2', el('OTE', 'Q.AFTER')),
  ));

  const res = b.scan();
  assert.equal(res.ok, false, 'the scan must report the failure');
  assert.match(b.plc.faults[0].message, /BOOM faulted: divide by zero/,
    'the fault must name the instruction and quote what went wrong, in a sentence an operator can '
    + 'read off the panel');
  assert.equal(b.plc.faults[0].rungId, 'r1', 'and say which rung it was on');
  assert.equal(b.get('Q.AFTER'), undefined,
    'and the scan must stop there rather than carrying on with logic that has already misbehaved');
});

test('TEST mode advances exactly one rung per step and wraps at the end of the program', () => {
  const b = bench(program(
    rung('r1', el('OTE', 'Q.ONE')),
    rung('r2', el('OTE', 'Q.TWO')),
  ));
  assert.equal(setMode(b.plc, MODE.TEST).ok, true, 'the key goes to TEST');
  assert.equal(scanProgram(b.plc, b.db, null, 0.2).rungsEvaluated >= 0, true,
    'scanProgram is still callable, but the operator drives TEST with stepOneRung');

  b.db.values.clear();
  b.plc.cursor = 0;
  const first = stepOneRung(b.plc, b.db, null);
  assert.equal(first.ok, true, 'the first step must be accepted');
  assert.equal(first.rungId, 'r1', 'and it must have stepped the first rung');
  assert.equal(b.get('Q.ONE'), true, 'which wrote its coil');
  assert.equal(b.get('Q.TWO'), undefined,
    'while the second rung has not run — that is what single-stepping is for');

  const second = stepOneRung(b.plc, b.db, null);
  assert.equal(second.rungId, 'r2', 'the next step takes the next rung');
  assert.equal(second.wrapped, true, 'and the end of the program wraps back to the top');
  assert.equal(b.plc.cursor, 0, 'ready to start the next pass');

  assert.equal(setMode(b.plc, MODE.PROGRAM).ok, true, 'back to PROGRAM');
  assert.equal(stepOneRung(b.plc, b.db, null).ok, false,
    'and stepping outside TEST must be refused rather than quietly running a rung');
});

test('a disabled rung is skipped and shown dark, without dropping the coils it would have written', () => {
  const prog = program(
    rung('r1', el('OTE', 'Q.OUT')),
    rung('r2', el('OTE', 'Q.OTHER')),
  );
  const b = bench(prog);
  b.scan();
  assert.equal(b.get('Q.OUT'), true, 'the rung runs while it is enabled');

  prog.rungs[0].enabled = false;
  b.scan();
  assert.equal(b.get('Q.OUT'), true,
    'a disabled rung is a commented-out rung: it stops writing, it does not write false');
  assert.equal(rungPower(b.plc, 'r1'), false, 'and it shows dark');
  assert.equal(b.get('Q.OTHER'), true, 'the rest of the program is unaffected');
});

test('the scan metrics report the period and the work done, for the processor status line', () => {
  const b = bench(program(
    rung('r1', el('XIC', 'I.A'), el('OTE', 'Q.OUT')),
    rung('r2', el('COUNT', 'x')),
  ));
  b.scan(0.2);
  b.scan(0.5);
  assert.equal(b.plc.scan.count, 2, 'both scans are counted');
  assert.equal(b.plc.scan.ms, 500, 'the reported period is the one the last scan was handed');
  assert.equal(b.plc.scan.max, 500,
    'and the worst period is held, because a 20x time-compressed run hands the logic a scan far '
    + 'longer than the panel claims and the operator should be able to see that');
  assert.equal(b.plc.lastScan.rungsEvaluated, 2, 'every rung was evaluated');
  assert.equal(b.plc.lastScan.elementsEvaluated, 3, 'and every element');
});

test('the real instruction set solves a seal-in against the real tag database', () => {
  // The one test here that crosses the module boundary. Everything above proves the engine on
  // stubs; this proves the engine and `instructions.js` agree about the thing they have to agree
  // about — that power arrives on `io.power` and the value returned IS the power leaving.
  const db = createTagDb();
  for (const name of ['M.START', 'M.STOP', 'M.RUN']) {
    const res = defineTag(db, {
      name, type: TYPE.BOOL, scope: SCOPE.MEMORY, desc: `bench bit ${name}`,
    });
    assert.equal(res.ok, true, `the bench tag ${name} must define: ${res.reason}`);
  }

  const prog = createProgram('seal-in');
  const r1 = createRung('start/stop with a seal-in leg');
  r1.nodes = [
    createBranch([[createElement('XIC', ['M.START'])], [createElement('XIC', ['M.RUN'])]]),
    createElement('XIO', ['M.STOP']),
    createElement('OTE', ['M.RUN']),
  ];
  addRung(prog, r1);

  const plc = createPlcState(prog, db, { scanInputs: null, scanOutputs: null });
  assert.equal(plc.faults.length, 0, 'the program must download against the real validator');
  assert.equal(setMode(plc, MODE.RUN).ok, true, 'and the processor must go to RUN');

  scanProgram(plc, db, null, 0.2);
  assert.equal(readTag(db, 'M.RUN'), false, 'nothing pressed, nothing running');

  writeTag(db, 'M.START', true);
  scanProgram(plc, db, null, 0.2);
  assert.equal(readTag(db, 'M.RUN'), true, 'the real XIC and OTE must pick the coil up');

  writeTag(db, 'M.START', false);
  scanProgram(plc, db, null, 0.2);
  assert.equal(readTag(db, 'M.RUN'), true, 'and the seal-in leg must hold it');
  assert.equal(rungPower(plc, r1.id), true, 'with the rung lit for the monitor');

  writeTag(db, 'M.STOP', true);
  scanProgram(plc, db, null, 0.2);
  assert.equal(readTag(db, 'M.RUN'), false, 'until the stop contact breaks it');
  assert.equal(powerOf(plc, r1.id, [0]), true, 'the branch is still passing power');
  assert.equal(powerOf(plc, r1.id, [1]), false, 'and the monitor shows the stop contact broke it');
});
