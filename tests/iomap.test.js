/**
 * tests/iomap.test.js — the IO rack: the shape of the point table, the two scans, the input image
 * that must not move while the logic runs, and the refusals that keep a bad number out of the
 * plant.
 *
 * These are integration claims by nature — a point that "reads without throwing" is worthless
 * unless it reads the real rig — so everything here runs against a genuine `createSim` context
 * rather than a stub, and the write tests go through the real `src/core/sim.js` actions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as sim from '../src/core/sim.js';
import { createSim } from '../src/core/sim.js';
import {
  createTagDb, installSystemTags, readTag, rawRead, rawWrite, writeTag, forceTag, tagInfo,
  SCOPE, TYPE,
} from '../src/plc/tags.js';
import {
  IO_POINTS, installIo, ioPoint, scanInputs, scanOutputs, primeOutputs, ioFaults, panelOf,
} from '../src/plc/iomap.js';
import { HAND } from '../src/control/staging.js';
import { DRIVE } from '../src/process/motor.js';
import { RECIRC } from '../src/process/plant.js';
import { MODE } from '../src/control/pid.js';
import { run } from './helpers.js';

/**
 * A rig with an IO rack bolted to it, settled for a few seconds so the flows, the casing
 * temperatures and the alarm list are all past their boot transient.
 * @param {number} [seconds=4] simulated seconds to run before handing it back
 * @returns {{ctx:object, db:object}} the context and its tag database
 */
function rack(seconds = 4) {
  const ctx = createSim();
  run(ctx, seconds);
  const db = createTagDb();
  installSystemTags(db);
  installIo(db);
  scanInputs(db, ctx);
  scanOutputs(db, ctx, sim);
  return { ctx, db };
}

/** @returns {object[]} every input point */
const inputs = () => IO_POINTS.filter((p) => p.dir === 'in');
/** @returns {object[]} every output point */
const outputs = () => IO_POINTS.filter((p) => p.dir === 'out');

test('the rack carries more than forty points and every one is wired in a real direction', () => {
  assert.ok(IO_POINTS.length >= 40,
    `the rig is instrumented with ${IO_POINTS.length} points; anything under forty cannot cover `
    + 'two machines, their alarms, the controller and the sequence');
  assert.ok(inputs().length >= 30, 'a supervisory PLC that cannot see the plant cannot supervise it');
  assert.ok(outputs().length >= 20, 'the ladder has to be able to drive the whole rig, not part of it');
  for (const p of IO_POINTS) {
    assert.ok(p.dir === 'in' || p.dir === 'out',
      `${p.tag} has direction "${p.dir}" — a point is either read or written, never both`);
    assert.ok(typeof p.read === 'function', `${p.tag} has no way of collecting its value`);
    assert.ok(typeof p.desc === 'string' && p.desc.length > 10,
      `${p.tag} has no description an operator would recognise it by`);
    assert.equal(p.tag, p.tag.toUpperCase(), `${p.tag} is not an upper-case tag name`);
  }
});

test('every point name carries the scope prefix its direction implies', () => {
  for (const p of IO_POINTS) {
    const want = p.dir === 'in' ? 'I.' : 'Q.';
    assert.ok(p.tag.startsWith(want),
      `${p.tag} is an ${p.dir}put but is not named ${want}* — a tag whose name lies about where `
      + 'the value lives is how a program becomes unreadable');
  }
  const seen = new Set();
  for (const p of IO_POINTS) {
    assert.ok(!seen.has(p.tag), `${p.tag} appears twice in the rack — two points, one terminal`);
    seen.add(p.tag);
  }
});

test('installing the rack defines every point in the tag database with its unit and scope', () => {
  const db = createTagDb();
  installIo(db);
  for (const p of IO_POINTS) {
    const info = tagInfo(db, p.tag);
    assert.ok(info, `${p.tag} was not defined in the database, so no rung could ever address it`);
    assert.equal(info.type, p.type, `${p.tag} was defined as a ${info.type}, not a ${p.type}`);
    assert.equal(info.scope, p.dir === 'in' ? SCOPE.INPUT : SCOPE.OUTPUT,
      `${p.tag} landed in the ${info.scope} scope, which is not where an ${p.dir}put belongs`);
    if (p.type === TYPE.REAL || p.type === TYPE.INT) {
      assert.ok(typeof info.unit === 'string',
        `${p.tag} is an analogue point with no unit — a number without a unit is not a measurement`);
    }
  }
});

test('installing the rack twice is accepted, because loading a program installs it again', () => {
  const db = createTagDb();
  installIo(db);
  const before = IO_POINTS.length;
  installIo(db);
  for (const p of IO_POINTS) {
    assert.ok(tagInfo(db, p.tag), `${p.tag} was lost by the second install`);
  }
  assert.equal(IO_POINTS.length, before, 'the point table is frozen and must not grow on install');
});

test('the point table is frozen, so a running program cannot rewire its own IO', () => {
  assert.ok(Object.isFrozen(IO_POINTS), 'IO_POINTS is not frozen');
  assert.throws(() => { IO_POINTS.push({}); },
    'a program that can add a point to its own rack has a cross-reference that is fiction');
  for (const p of IO_POINTS) {
    assert.ok(Object.isFrozen(p), `${p.tag} is not frozen`);
  }
});

test('every point reads a finite, correctly typed value from a fresh rig without throwing', () => {
  const ctx = createSim();
  run(ctx, 3);
  for (const p of IO_POINTS) {
    let v;
    assert.doesNotThrow(() => { v = p.read(ctx); },
      `${p.tag} threw while being read — a point that cannot be collected is not a point`);
    if (p.type === TYPE.BOOL) {
      assert.equal(typeof v, 'boolean', `${p.tag} is a bit but read ${typeof v} ${v}`);
    } else if (p.type === TYPE.STRING) {
      assert.equal(typeof v, 'string', `${p.tag} is text but read ${typeof v} ${v}`);
    } else {
      assert.ok(Number.isFinite(v),
        `${p.tag} read ${v} — a non-finite analogue value poisons every comparison downstream`);
      if (p.type === TYPE.INT) {
        assert.ok(Number.isInteger(v), `${p.tag} is an INT but read the fraction ${v}`);
      }
    }
  }
});

test('the input scan lands every measurement in the image without a single refused write', () => {
  const { ctx, db } = rack();
  for (const p of inputs()) {
    const v = rawRead(db, p.tag);
    assert.notEqual(v, undefined, `${p.tag} is still undefined after an input scan`);
    if (p.type === TYPE.REAL) {
      assert.ok(Number.isFinite(v), `${p.tag} holds ${v} after the input scan`);
    }
  }
  assert.equal(readTag(db, 'I.PT101'), ctx.plant.pt_bar,
    'the image must carry exactly what PT-101 said, not a rounded copy of it');
  assert.equal(readTag(db, 'I.LOOP_MODE'), ctx.run.mode);
  assert.equal(readTag(db, 'I.P1_RUN'), ctx.plant.drv[0].state === DRIVE.RUNNING);
});

test('the input image does not move while the logic runs, however far the plant travels', () => {
  const { ctx, db } = rack();
  const before = inputs().map((p) => ({ tag: p.tag, v: readTag(db, p.tag) }));

  // Mid-scan: the plant is integrating underneath the program. This is the exact moment a
  // simulator that read the plant per instruction would produce two rungs that disagree.
  run(ctx, 12);
  ctx.plant.pt_bar += 2.5;
  ctx.plant.lt_m = 0.2;
  ctx.plant.drv[1].n_pct = 88;

  for (const { tag, v } of before) {
    assert.deepEqual(readTag(db, tag), v,
      `${tag} moved during the scan — every rung in the program can now disagree about the state `
      + 'of the plant, and the program no longer means anything');
  }

  // And the next scan does pick it all up, or the image would merely be stale rather than frozen.
  scanInputs(db, ctx);
  assert.equal(readTag(db, 'I.PT101'), ctx.plant.pt_bar,
    'the image never caught up — an image that never refreshes is worse than no image');
});

test('a forced input hides the field from the logic and leaves the field itself still visible', () => {
  const { ctx, db } = rack();
  forceTag(db, 'I.PT101', 7.5);
  scanInputs(db, ctx);
  assert.equal(readTag(db, 'I.PT101'), 7.5,
    'the logic did not see the force — a force nobody obeys is a lie told to an engineer');
  assert.equal(rawRead(db, 'I.PT101'), ctx.plant.pt_bar,
    'the input scan stopped collecting the field, so removing the force would hand the logic a '
    + 'value from before it was applied');
});

test('the first scan reads the outputs back from the plant instead of commanding them to zero', () => {
  const ctx = createSim();
  run(ctx, 3);
  const db = createTagDb();
  installIo(db);
  const sp = ctx.pid.spTarget;
  const hand = ctx.staging.hand.slice();

  // The output image comes up at zero, and zero is a real command: "setpoint 0.00 bar".
  assert.equal(rawRead(db, 'Q.PIC_SP'), 0);
  scanInputs(db, ctx);

  assert.equal(readTag(db, 'Q.PIC_SP'), sp,
    'the output image was not primed, so loading a program would slam the setpoint to zero '
    + 'before a single rung had been solved');
  assert.deepEqual(ctx.staging.hand, hand, 'priming moved a machine that nobody commanded');
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.pid.spTarget, sp, 'the primed image wrote itself back onto the plant');
  assert.deepEqual(ioFaults(db), [], `the first scan refused: ${JSON.stringify(ioFaults(db))}`);
});

test('a clean scan of the whole rack refuses nothing on a rig that is behaving', () => {
  const { ctx, db } = rack();
  for (let k = 0; k < 5; k += 1) {
    run(ctx, 1);
    scanInputs(db, ctx);
    scanOutputs(db, ctx, sim);
    assert.deepEqual(ioFaults(db), [],
      `the rack refused an output on an untouched rig: ${JSON.stringify(ioFaults(db))}`);
  }
});

test('the pump commands place the machine where the ladder asked and nowhere else', () => {
  const { ctx, db } = rack();

  writeTag(db, 'Q.P2_START', true);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.staging.hand[1], HAND.HAND,
    'Q.P2_START did not put P-102 in hand — the coil claims a machine it never took');
  assert.ok(ctx.plant.drv[1].state === DRIVE.STARTING || ctx.plant.drv[1].state === DRIVE.RUNNING,
    'P-102 was placed in hand but never actually called');

  writeTag(db, 'Q.P2_STOP', true);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.staging.hand[1], HAND.OFF,
    'a stop command has to beat the start command sitting beside it, as the wiring does');

  // The auto coil was already energised from the prime — P-102 boots in auto — so handing the
  // machine back means pressing the button, which is a rising edge and not a held level.
  writeTag(db, 'Q.P2_STOP', false);
  writeTag(db, 'Q.P2_START', false);
  writeTag(db, 'Q.P2_AUTO', false);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.staging.hand[1], HAND.OFF, 'releasing a momentary button issued a command');
  writeTag(db, 'Q.P2_AUTO', true);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.staging.hand[1], HAND.AUTO, 'Q.P2_AUTO did not hand P-102 back to the sequence');
});

test('a machine already in auto is not re-placed by the auto coil the prime found energised', () => {
  const { ctx, db } = rack();
  assert.equal(ctx.staging.hand[1], HAND.AUTO);
  assert.equal(readTag(db, 'Q.P2_AUTO'), true,
    'the prime should have found P-102 in auto and said so in the output image');
  ctx.staging.hand[1] = HAND.HAND;
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.staging.hand[1], HAND.HAND,
    'the still-energised auto coil dragged the machine back — a momentary button that keeps '
    + 'commanding while it is held takes the panel away from the operator');
});

test('a held start coil commands the starter once rather than counting a start every scan', () => {
  const { ctx, db } = rack();
  writeTag(db, 'Q.P2_START', true);
  scanOutputs(db, ctx, sim);
  const starts = ctx.staging.starts[1];
  for (let k = 0; k < 25; k += 1) scanOutputs(db, ctx, sim);
  assert.equal(ctx.staging.starts[1], starts,
    `the held coil counted ${ctx.staging.starts[1] - starts} extra starts — a rack that re-issues `
    + 'a command five times a second destroys the short-cycling metric it is supposed to protect');
});

test('a reset command is refused while the motor is tripped and still hot, and the plant stands still', () => {
  const { ctx, db } = rack();
  sim.forceTrip(ctx, 0);
  ctx.plant.drv[0].thermal_pct = 95;
  scanInputs(db, ctx);
  assert.equal(readTag(db, 'I.P1_FAULT'), true, 'the trip never reached the input image');

  writeTag(db, 'Q.P1_RESET', true);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.plant.drv[0].state, DRIVE.TRIPPED,
    'the overload reset while the bimetal was still hot, which no relay on earth does');
  const faults = ioFaults(db);
  assert.equal(faults.length, 1, `expected one refusal, got ${JSON.stringify(faults)}`);
  assert.match(faults[0].reason, /cool/,
    'the refusal has to say WHY, or an operator concludes the simulator is broken');
});

test('the controller setpoint output moves the setpoint and is issued only when it changes', () => {
  const { ctx, db } = rack();
  const events = ctx.run.events.length;
  writeTag(db, 'Q.PIC_SP', 4.1);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.pid.spTarget, 4.1, 'Q.PIC_SP did not reach PIC-101');
  const after = ctx.run.events.length;
  for (let k = 0; k < 30; k += 1) scanOutputs(db, ctx, sim);
  assert.equal(ctx.run.events.length, after,
    'the unchanged setpoint was re-announced on every scan and buried the operator event log');
  assert.ok(after > events, 'the setpoint change was never announced at all');
});

test('an output written with nonsense is refused and the plant does not move', () => {
  const { ctx, db } = rack();
  const sp = ctx.pid.spTarget;
  const mode = ctx.run.mode;

  assert.equal(ioPoint('Q.PIC_SP').write(ctx, sim, NaN).ok, false,
    'a not-a-number setpoint was accepted');
  assert.equal(ioPoint('Q.PIC_SP').write(ctx, sim, 'four bar').ok, false,
    'a text setpoint was accepted');
  assert.equal(ioPoint('Q.P1_START').write(ctx, sim, 0.5).ok, false,
    'half a start command was accepted — a bit is on or off');
  assert.equal(ctx.pid.spTarget, sp, 'a refused write still moved the setpoint');

  // The database will happily store any string in a STRING tag, so this is the whole nonsense
  // path end to end: a rung writes a name nobody wired, and the rack has to catch it.
  writeTag(db, 'Q.LOOP_MODE', 'BANANA');
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.run.mode, mode, 'the loop changed the variable it controls to nonsense');
  const faults = ioFaults(db);
  assert.equal(faults.length, 1, `expected one refusal, got ${JSON.stringify(faults)}`);
  assert.equal(faults[0].tag, 'Q.LOOP_MODE');
  assert.match(faults[0].reason, /PRESSURE/,
    'the refusal has to name what the point WOULD have accepted');
});

test('a refusal is cleared by the next clean scan rather than latching for ever', () => {
  const { ctx, db } = rack();
  writeTag(db, 'Q.LOOP_MODE', 'BANANA');
  scanOutputs(db, ctx, sim);
  assert.equal(ioFaults(db).length, 1);
  writeTag(db, 'Q.LOOP_MODE', ctx.run.mode);
  scanOutputs(db, ctx, sim);
  assert.deepEqual(ioFaults(db), [],
    'the fault list describes the scan that just happened, not a museum of old ones');
});

test('every output actually changes the thing it claims to', () => {
  const { ctx, db } = rack();

  /**
   * Command an output and assert the readback followed it.
   * @param {string} tag the output point
   * @param {*} v the command
   * @param {string} what what should have changed
   * @returns {void}
   */
  const drive = (tag, v, what) => {
    const p = ioPoint(tag);
    const r = p.write(ctx, sim, v);
    assert.equal(r.ok, true, `${tag} refused ${v}: ${r.reason}`);
    const got = p.read(ctx);
    const followed = typeof v === 'number' ? Math.abs(got - v) < 1e-6 : got === v;
    assert.ok(followed,
      `${tag} was accepted but ${what} did not follow it (read back ${got}) — a point that `
      + 'quietly does nothing is worse than a point that is missing, because you trust it');
  };

  drive('Q.SEQ_ENABLE', false, 'the staging sequence');
  drive('Q.SEQ_UP_PCT', 91, 'the stage-up threshold');
  drive('Q.SEQ_DN_PCT', 35, 'the stage-down threshold');
  drive('Q.SEQ_UP_DLY', 14, 'the stage-up delay');
  drive('Q.SEQ_DN_DLY', 26, 'the stage-down delay');
  drive('Q.SEQ_MINRUN', 60, 'the minimum run timer');
  drive('Q.SEQ_MINSTOP', 40, 'the minimum stop timer');
  drive('Q.SEQ_SLEEP', true, 'sleep mode');
  drive('Q.SEQ_ROTATE', 'OFF', 'the rotation policy');
  drive('Q.SEQ_CRITERION', 'FLOW', 'the staging criterion');
  drive('Q.SEQ_LEAD', 2, 'the duty selection');
  drive('Q.FCV101_CMD', 62, 'the demand valve');
  drive('Q.FIXED_SPEED', 80, 'the fixed speed');
  drive('Q.RECIRC_MODE', RECIRC.MANUAL, 'the recirculation mode');
  drive('Q.RECIRC_POS', 55, 'the recirculation valve travel');
  drive('Q.HORN', true, 'the annunciator horn');
  drive('Q.LAMP_ALARM', true, 'the red lamp');
  drive('Q.LAMP_WARN', true, 'the amber lamp');
  drive('Q.LAMP_P1', true, 'the P-101 lamp');
  drive('Q.LAMP_P2', true, 'the P-102 lamp');
  drive('Q.REC_STEP', 3, 'the recipe step display');
  drive('Q.REC_HOLD', true, 'the recipe hold flag');

  assert.equal(ctx.stagingCfg.stageUp_pct, 91);
  assert.equal(ctx.plant.recircMode, RECIRC.MANUAL);
  assert.equal(panelOf(ctx).recipeStep, 3);
  assert.equal(ctx.staging.lead, 1);
});

test('the manual output tracks the controller while it is in AUTO and drives it in MANUAL', () => {
  const { ctx, db } = rack();
  assert.notEqual(ctx.pid.mode, MODE.MAN, 'the rig should boot in automatic');

  // In AUTO the manual station is not in command, so its image follows the field. Leave it where
  // the program last put it and the first scan in MANUAL steps the plant to a number nobody chose.
  rawWrite(db, 'Q.PIC_MAN_CO', 3);
  scanOutputs(db, ctx, sim);
  assert.equal(readTag(db, 'Q.PIC_MAN_CO'), ctx.pid.coMan,
    'the manual station did not track in AUTO, so the transfer to MANUAL would not be bumpless');
  assert.deepEqual(ioFaults(db), [], 'tracking should never raise a fault');

  writeTag(db, 'Q.PIC_AUTO', false);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.pid.mode, MODE.MAN, 'Q.PIC_AUTO did not take PIC-101 out of automatic');
  writeTag(db, 'Q.PIC_MAN_CO', 33);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.pid.coMan, 33, 'the manual output did not reach the controller in MANUAL');
});

test('the recirculation travel tracks the ARV rather than fighting a mechanical device', () => {
  const { ctx, db } = rack();
  assert.equal(ctx.plant.recircMode, RECIRC.ARV, 'the rig should boot with the ARV in service');
  rawWrite(db, 'Q.RECIRC_POS', 5);
  scanOutputs(db, ctx, sim);
  assert.equal(readTag(db, 'Q.RECIRC_POS'), ctx.plant.bypass * 100,
    'the image is arguing with a self-contained valve it has no authority over');
  assert.deepEqual(ioFaults(db), []);
});

test('a forced output reaches the plant, because that is the entire point of forcing one', () => {
  const { ctx, db } = rack();
  assert.equal(ctx.staging.hand[1], HAND.AUTO);
  forceTag(db, 'Q.P2_STOP', true);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.staging.hand[1], HAND.OFF,
    'the force never reached the starter — an output force the IO scan ignores is a lie told to '
    + 'somebody standing next to a motor');
});

test('the alarm bits in the image agree with the alarm list they came from', () => {
  const { ctx, db } = rack();
  sim.forceTrip(ctx, 1);
  run(ctx, 2);
  scanInputs(db, ctx);
  assert.equal(readTag(db, 'I.ALM_P2_TRIP'), true, 'the P-102 trip never annunciated to the ladder');
  assert.equal(readTag(db, 'I.ALM_ANY'), true, 'something is in alarm but the summary bit is clear');
  assert.equal(readTag(db, 'I.ALM_CRITICAL'), true, 'a trip is an ALARM, not a warning');
  assert.ok(readTag(db, 'I.ALM_UNACK') >= 1, 'the unacknowledged count did not see the new alarm');
});

test('the acknowledge output clears the list once and then stops shouting about it', () => {
  const { ctx, db } = rack();
  sim.forceTrip(ctx, 0);
  run(ctx, 2);
  scanInputs(db, ctx);
  assert.ok(readTag(db, 'I.ALM_UNACK') >= 1);

  const events = ctx.run.events.length;
  writeTag(db, 'Q.ALARM_ACK', true);
  scanOutputs(db, ctx, sim);
  scanInputs(db, ctx);
  assert.equal(readTag(db, 'I.ALM_UNACK'), 0, 'the acknowledge command never reached the list');
  const after = ctx.run.events.length;
  for (let k = 0; k < 20; k += 1) scanOutputs(db, ctx, sim);
  assert.equal(ctx.run.events.length, after,
    'a held acknowledge coil wrote "nothing to acknowledge" to the event feed on every scan');
  assert.ok(after > events, 'the acknowledgement was never recorded at all');
});

test('every machine has the same rack, so the second pump cannot read the first one\'s current', () => {
  const suffixes = IO_POINTS
    .filter((p) => /^[IQ]\.(ALM_)?P1_/.test(p.tag))
    .map((p) => p.tag.replace('P1_', 'P2_'));
  assert.ok(suffixes.length >= 20, 'a machine with fewer than twenty points is barely instrumented');
  for (const tag of suffixes) {
    assert.ok(ioPoint(tag), `${tag} is missing — the two machines do not have the same rack`);
  }
  const { ctx } = rack();
  ctx.plant.drv[0].n_pct = 71;
  ctx.plant.drv[1].n_pct = 33;
  assert.equal(ioPoint('I.P1_SPEED').read(ctx), 71);
  assert.equal(ioPoint('I.P2_SPEED').read(ctx), 33,
    'the second machine is reading the first one\'s speed');
});

test('an unwired tag has no point, and the rack says so instead of guessing', () => {
  assert.equal(ioPoint('I.NOT_A_POINT'), null);
  assert.equal(ioPoint('M.LEAD_IS_P1'), null, 'a memory bit is not an IO point');
  assert.equal(ioPoint(''), null);
});

test('an output whose action the simulation does not offer refuses rather than doing nothing', () => {
  const { ctx, db } = rack();
  writeTag(db, 'Q.PIC_SP', 4.4);
  scanOutputs(db, ctx, {});
  const faults = ioFaults(db);
  assert.ok(faults.some((f) => f.tag === 'Q.PIC_SP' && /no setSetpoint action/.test(f.reason)),
    `an unwired action was accepted silently: ${JSON.stringify(faults)}`);
  assert.notEqual(ctx.pid.spTarget, 4.4, 'the setpoint moved without an action to move it');
});

test('priming can be repeated on demand, which is what loading a new program has to do', () => {
  const { ctx, db } = rack();
  writeTag(db, 'Q.PIC_SP', 4.6);
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.pid.spTarget, 4.6);
  rawWrite(db, 'Q.PIC_SP', 0);
  primeOutputs(db, ctx);
  assert.equal(readTag(db, 'Q.PIC_SP'), 4.6,
    'the reload did not read the outputs back, so the new program would start by zeroing the rig');
  scanOutputs(db, ctx, sim);
  assert.equal(ctx.pid.spTarget, 4.6);
});
