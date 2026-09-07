/**
 * tests/tags.test.js — the tag database: naming, type checking, range clamping, forcing, the
 * timer and counter structures, and snapshot/restore.
 *
 * These are the awkward cases rather than the happy path, because the happy path is exercised by
 * every other test in the PLC layer the moment it defines a tag. What is pinned here is the
 * behaviour that only shows up when something is wrong: a REAL aimed at a bit, a name that lies
 * about its scope, a force that outlives the engineer who set it, and a snapshot restored into a
 * database that has grown since it was taken.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPE, SCOPE, SCOPE_PREFIX, SYSTEM_TAGS, TAGDB_VERSION, STRING_LEN,
  createTagDb, defineTag, defineTags, installSystemTags,
  readTag, writeTag, rawRead, rawWrite,
  forceTag, unforceTag, forcedTags, isForced, clearForces,
  tagExists, tagInfo, tagNames, timerOf, counterOf,
  snapshotTags, restoreTags, clearNonRetained,
} from '../src/plc/tags.js';

/**
 * A database with one tag of each interesting shape.
 * @returns {object} the database
 */
function bench() {
  const db = createTagDb();
  defineTag(db, { name: 'I.PT101', type: TYPE.REAL, scope: SCOPE.INPUT, unit: 'bar', min: 0, max: 16, desc: 'header pressure' });
  defineTag(db, { name: 'I.P1_RUN', type: TYPE.BOOL, scope: SCOPE.INPUT, desc: 'pump 1 running' });
  defineTag(db, { name: 'Q.P1_START', type: TYPE.BOOL, scope: SCOPE.OUTPUT, desc: 'start pump 1' });
  defineTag(db, { name: 'M.LEAD_IS_P1', type: TYPE.BOOL, scope: SCOPE.MEMORY, retain: true, desc: 'duty selection' });
  defineTag(db, { name: 'M.STAGE_COUNT', type: TYPE.INT, scope: SCOPE.MEMORY, min: 0, max: 2, desc: 'pumps wanted' });
  defineTag(db, { name: 'T.STAGE_DLY', type: TYPE.TIMER, scope: SCOPE.TIMER, desc: 'stage-up delay' });
  defineTag(db, { name: 'C.P1_STARTS', type: TYPE.COUNTER, scope: SCOPE.COUNTER, retain: true, desc: 'pump 1 starts' });
  defineTag(db, { name: 'R.HEADER_SP', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 'bar', min: 0, max: 12, desc: 'recipe setpoint' });
  defineTag(db, { name: 'R.STEP_NAME', type: TYPE.STRING, scope: SCOPE.RECIPE, desc: 'current step' });
  return db;
}

test('a tag whose prefix disagrees with its scope is refused, because the name is the documentation', () => {
  const db = createTagDb();
  const bad = defineTag(db, { name: 'M.PT101', type: TYPE.REAL, scope: SCOPE.INPUT });
  assert.equal(bad.ok, false, 'an INPUT tag named M. must not be accepted — a rung reading M.PT101 would claim the value is internal when it comes off a terminal');
  assert.match(bad.reason, /I\.PT101/, 'the refusal must name the tag it should have been called, or the operator has to guess');
  assert.equal(db.tags.size, 0, 'a refused definition must leave no trace in the database');

  for (const [scope, prefix] of Object.entries(SCOPE_PREFIX)) {
    const type = scope === SCOPE.TIMER ? TYPE.TIMER : (scope === SCOPE.COUNTER ? TYPE.COUNTER : TYPE.BOOL);
    const r = defineTag(db, { name: `${prefix}.OK`, type, scope });
    assert.equal(r.ok, true, `${scope} must accept its own prefix '${prefix}.' or nothing can be defined in it: ${r.reason}`);
  }
  assert.equal(defineTag(db, { name: 'REC.STEP', type: TYPE.INT, scope: SCOPE.RECIPE }).ok, true,
    'REC. is the documented alias for the recipe scope, and the sequencer publishes REC.STEP under it');
  assert.equal(defineTag(db, { name: 'X.THING', type: TYPE.BOOL, scope: SCOPE.MEMORY }).ok, false,
    'an unknown prefix must be refused, or the scope rule means nothing');
  assert.equal(defineTag(db, { name: 'lowercase.thing', type: TYPE.BOOL, scope: SCOPE.MEMORY }).ok, false,
    'tag names are upper case; accepting mixed case would give two names for one tag');
});

test('a timer must live in the timer scope and a counter in the counter scope', () => {
  const db = createTagDb();
  assert.equal(defineTag(db, { name: 'M.DLY', type: TYPE.TIMER, scope: SCOPE.MEMORY }).ok, false,
    'a timer parked in memory would be invisible to the tag browser page that lists timers');
  assert.equal(defineTag(db, { name: 'M.CNT', type: TYPE.COUNTER, scope: SCOPE.MEMORY }).ok, false,
    'a counter parked in memory would be invisible to the tag browser page that lists counters');
});

test('a REAL written into a BOOL is refused and the bit keeps the value it had', () => {
  const db = bench();
  assert.equal(writeTag(db, 'Q.P1_START', true).ok, true, 'a bit must take a boolean');

  const bad = writeTag(db, 'Q.P1_START', 3.7);
  assert.equal(bad.ok, false, 'a REAL into a BOOL must be refused — a coil worth 3.7 no longer means what the rung says');
  assert.match(bad.reason, /bit/, 'the refusal must say the tag is a bit, so the author knows what to write instead');
  assert.equal(readTag(db, 'Q.P1_START'), true, 'a refused write must not disturb the value that was already there');

  assert.equal(writeTag(db, 'Q.P1_START', 'ON').ok, false, 'text into a bit must be refused, however plausible the text looks');
  assert.equal(writeTag(db, 'Q.P1_START', 0).ok, true, 'exactly 0 is accepted, because bit arithmetic in the maths instructions produces it');
  assert.equal(readTag(db, 'Q.P1_START'), false, '0 must land as false, not as the number zero');
  assert.equal(writeTag(db, 'Q.P1_START', 1).ok, true, 'exactly 1 is accepted for the same reason');
  assert.equal(readTag(db, 'Q.P1_START'), true, '1 must land as true');
  assert.equal(writeTag(db, 'Q.P1_START', 0.5).ok, false, 'a fraction is not a bit, and silently rounding it would hide the defect that produced it');

  assert.equal(writeTag(db, 'I.PT101', true).ok, false, 'a bit into a REAL must be refused too, or the type check only runs one way');
  assert.equal(writeTag(db, 'I.PT101', NaN).ok, false, 'NaN must never reach a tag — every comparison downstream of it silently goes false');
  assert.equal(writeTag(db, 'I.PT101', Infinity).ok, false, 'an infinite value must be refused for the same reason');
});

test('writes clamp to the tag range instead of letting a bad divide reach the plant', () => {
  const db = bench();
  const high = writeTag(db, 'I.PT101', 900);
  assert.equal(high.ok, true, 'an out-of-range write is clamped, not refused: the clamp is the protection');
  assert.equal(high.clamped, true, 'the caller must be told the value was moved, so a panel can show it');
  assert.equal(readTag(db, 'I.PT101'), 16, '900 bar must clamp to the 16 bar range limit');

  writeTag(db, 'I.PT101', -4);
  assert.equal(readTag(db, 'I.PT101'), 0, 'a negative pressure must clamp to the bottom of the range');

  const ok = writeTag(db, 'I.PT101', 4.2);
  assert.equal(ok.clamped, false, 'an in-range write must not report itself as clamped');
  assert.equal(readTag(db, 'I.PT101'), 4.2, 'an in-range value passes through untouched');

  assert.equal(defineTag(db, { name: 'M.SILLY', type: TYPE.REAL, scope: SCOPE.MEMORY, min: 10, max: 2 }).ok, false,
    'an inside-out range must be refused at definition, not discovered when every write clamps to 10');
  assert.equal(defineTag(db, { name: 'M.RANGED_BIT', type: TYPE.BOOL, scope: SCOPE.MEMORY, min: 0, max: 1 }).ok, false,
    'a range on a bit means nothing and would mislead whoever read the tag list');
});

test('an INT truncates a fractional write the way a MOV into an integer file does', () => {
  const db = bench();
  writeTag(db, 'M.STAGE_COUNT', 1.9);
  assert.equal(readTag(db, 'M.STAGE_COUNT'), 1, 'an INT truncates toward zero rather than rounding, which is what a real MOV does');
  writeTag(db, 'M.STAGE_COUNT', 7);
  assert.equal(readTag(db, 'M.STAGE_COUNT'), 2, 'the range clamp applies before the truncation');
});

test('reading a tag that was never defined gives undefined rather than throwing', () => {
  const db = bench();
  assert.equal(readTag(db, 'M.NO_SUCH_THING'), undefined, 'an unknown tag must read as undefined so a renderer can show a broken operand instead of dying');
  assert.equal(rawRead(db, 'M.NO_SUCH_THING'), undefined, 'the raw path must be just as forgiving');
  assert.equal(tagExists(db, 'M.NO_SUCH_THING'), false, 'tagExists is what the cross-reference uses to list unresolved operands');
  assert.equal(tagInfo(db, 'M.NO_SUCH_THING'), null, 'tagInfo must return null, not a half-built record');

  const w = writeTag(db, 'M.NO_SUCH_THING', true);
  assert.equal(w.ok, false, 'writing an undefined tag must be refused — a typo silently creating a tag is how a coil stops driving anything');
  assert.match(w.reason, /no tag called M\.NO_SUCH_THING/, 'the refusal must name the tag, because the usual cause is a typo in the rung');
  assert.equal(forceTag(db, 'M.NO_SUCH_THING', true).ok, false, 'forcing an undefined tag must be refused for the same reason');
  assert.equal(readTag(db, 'not a reference at all'), undefined, 'a malformed reference must not throw either');
});

test('a force overrides every read while the program keeps writing underneath it', () => {
  const db = bench();
  writeTag(db, 'I.P1_RUN', false);

  assert.equal(forceTag(db, 'I.P1_RUN', true).ok, true, 'forcing an input is how a rung is proven out without starting a pump');
  assert.equal(readTag(db, 'I.P1_RUN'), true, 'every read through readTag must see the force, or the force means nothing');
  assert.equal(rawRead(db, 'I.P1_RUN'), false, 'rawRead must see past the force, because the IO scan is what wrote the real value');
  assert.equal(isForced(db, 'I.P1_RUN'), true, 'a forced tag must be identifiable cheaply, so every place it is drawn can mark it');
  assert.deepEqual(forcedTags(db), ['I.P1_RUN'], 'the force must appear in the list the UI shouts with — a forgotten force is the expensive failure here');

  const w = writeTag(db, 'I.P1_RUN', true);
  assert.equal(w.ok, true, 'the program must still be able to write a forced tag, exactly as a real processor allows');
  rawWrite(db, 'I.P1_RUN', false);
  assert.equal(readTag(db, 'I.P1_RUN'), true, 'the underlying write must not disturb what readers see while the force stands');

  assert.equal(forceTag(db, 'I.P1_RUN', 2.5).ok, false, 'a force is type-checked like a write, or forcing becomes a way to smuggle a REAL into a bit');
  assert.equal(readTag(db, 'I.P1_RUN'), true, 'a refused force must leave the existing force alone');

  assert.equal(unforceTag(db, 'I.P1_RUN').ok, true, 'the force comes off');
  assert.equal(readTag(db, 'I.P1_RUN'), false, 'removing a force must expose whatever was written underneath it — that jump is the lesson');
  assert.deepEqual(forcedTags(db), [], 'the force list must empty');
  assert.equal(unforceTag(db, 'I.P1_RUN').ok, false, 'unforcing a tag that is not forced is refused rather than silently ignored');
});

test('clearForces removes every force at once and reports how many there were', () => {
  const db = bench();
  forceTag(db, 'I.P1_RUN', true);
  forceTag(db, 'I.PT101', 5);
  assert.equal(forcedTags(db).length, 2, 'both forces must be listed');
  assert.equal(clearForces(db), 2, 'clearing must report the count, so the UI can say what it just undid');
  assert.equal(readTag(db, 'I.PT101'), 0, 'the tag reads its underlying value again');
  assert.equal(clearForces(db), 0, 'clearing an unforced database is a no-op, not a fault');
});

test('timers and counters are addressed by member, and one bit can be forced on its own', () => {
  const db = bench();
  const t = timerOf(db, 'T.STAGE_DLY');
  assert.ok(t, 'timerOf must hand back the live structure the timer instructions accumulate into');
  assert.deepEqual({ ...t }, { pre: 0, acc: 0, en: false, tt: false, dn: false },
    'a fresh timer must start with every bit clear, or the first scan acts on stale state');

  assert.equal(writeTag(db, 'T.STAGE_DLY.PRE', 8000).ok, true, 'a preset is written by member');
  assert.equal(t.pre, 8000, 'the member write must land in the live structure the instruction reads');
  assert.equal(readTag(db, 'T.STAGE_DLY.PRE'), 8000, 'and must read back through the database');
  writeTag(db, 'T.STAGE_DLY.ACC', -50);
  assert.equal(readTag(db, 'T.STAGE_DLY.ACC'), 0, 'a timer accumulator clamps at zero — a negative accumulator would never reach its preset');
  assert.equal(writeTag(db, 'T.STAGE_DLY.DN', 1.5).ok, false, 'a timer done bit is a bit, and must refuse a REAL like any other');
  assert.equal(writeTag(db, 'T.STAGE_DLY.NOPE', 1).ok, false, 'an unknown member must be refused, or a typo silently writes nothing');
  assert.match(tagInfo(db, 'T.STAGE_DLY.DN').desc, /done/, 'a member must describe itself in the tag browser');

  assert.equal(forceTag(db, 'T.STAGE_DLY', 1).ok, false, 'a whole timer structure cannot be forced — there is no single value to force it to');
  assert.equal(writeTag(db, 'T.STAGE_DLY', 5).ok, false, 'and it cannot be written as if it were a number');
  assert.equal(forceTag(db, 'T.STAGE_DLY.DN', true).ok, true, 'the done bit on its own can be forced, which is how a delay is skipped during commissioning');
  assert.equal(readTag(db, 'T.STAGE_DLY.DN'), true, 'the forced bit reads forced');
  assert.equal(rawRead(db, 'T.STAGE_DLY.DN'), false, 'while the timer itself has not actually finished');

  const c = counterOf(db, 'C.P1_STARTS');
  assert.deepEqual({ ...c }, { pre: 0, acc: 0, cu: false, cd: false, dn: false, ov: false, un: false },
    'a fresh counter must start with every bit clear');
  writeTag(db, 'C.P1_STARTS.ACC', 6);
  assert.equal(readTag(db, 'C.P1_STARTS.ACC'), 6, 'a counter accumulator is written by member like a timer');
  assert.equal(timerOf(db, 'C.P1_STARTS'), null, 'asking for a counter as a timer must return null, not the wrong structure');
  assert.equal(counterOf(db, 'M.LEAD_IS_P1'), null, 'asking for a bit as a counter must return null');
  assert.equal(readTag(db, 'M.LEAD_IS_P1.DN'), undefined, 'a bit has no members, and asking for one must not throw');
});

test('the same definition twice is accepted; a conflicting one is refused', () => {
  const db = bench();
  writeTag(db, 'M.STAGE_COUNT', 2);
  const again = defineTag(db, { name: 'M.STAGE_COUNT', type: TYPE.INT, scope: SCOPE.MEMORY, min: 0, max: 2 });
  assert.equal(again.ok, true, 'the IO map is installed on every program load, so an identical redefinition must be a no-op rather than a failure');
  assert.equal(readTag(db, 'M.STAGE_COUNT'), 2, 'and it must not wipe the value the plant is running on');

  const clash = defineTag(db, { name: 'M.STAGE_COUNT', type: TYPE.REAL, scope: SCOPE.MEMORY });
  assert.equal(clash.ok, false, 'two modules disagreeing about a tag type is the exact fault this database exists to catch');
  assert.equal(tagInfo(db, 'M.STAGE_COUNT').type, TYPE.INT, 'the original definition must stand');
});

test('a bulk define reports every bad point instead of stopping at the first', () => {
  const db = createTagDb();
  const r = defineTags(db, [
    { name: 'I.FT101', type: TYPE.REAL, scope: SCOPE.INPUT },
    { name: 'I.BAD', type: 'FLOAT', scope: SCOPE.INPUT },
    { name: 'I.FT102', type: TYPE.REAL, scope: SCOPE.INPUT },
  ]);
  assert.equal(r.ok, false, 'one bad point makes the install unsuccessful');
  assert.equal(r.defined, 2, 'an IO map with one bad point must still install the other points');
  assert.equal(r.problems.length, 1, 'and must report exactly the point that failed');
  assert.equal(tagExists(db, 'I.FT102'), true, 'the point after the bad one must not be skipped');
});

test('tagNames filters by scope, by prefix, by predicate and by substring', () => {
  const db = bench();
  assert.deepEqual(tagNames(db, SCOPE.OUTPUT), ['Q.P1_START'], 'a scope name selects that scope');
  assert.deepEqual(tagNames(db, 'Q'), ['Q.P1_START'], 'so does the bare prefix, because that is what an engineer types');
  assert.deepEqual(tagNames(db, 'P1_STARTS'), ['C.P1_STARTS'], 'anything else is a substring search over the name');
  assert.deepEqual(tagNames(db, (t) => t.retain), ['M.LEAD_IS_P1', 'C.P1_STARTS'], 'a predicate sees the whole tag record');
  assert.deepEqual(tagNames(db, { type: TYPE.TIMER }), ['T.STAGE_DLY'], 'an object matches every field it lists');
  assert.equal(tagNames(db).length, db.tags.size, 'no filter lists everything');
  assert.deepEqual(tagNames(db, SCOPE.INPUT), ['I.PT101', 'I.P1_RUN'],
    'the order must be definition order, because that is terminal order and an alphabetical shuffle would lose it');

  forceTag(db, 'I.PT101', 3);
  assert.deepEqual(tagNames(db, { forced: true }), ['I.PT101'], 'the forced filter is what the tag browser highlights with');
});

test('a STRING tag truncates rather than growing without limit', () => {
  const db = bench();
  const long = 'x'.repeat(STRING_LEN + 40);
  const r = writeTag(db, 'R.STEP_NAME', long);
  assert.equal(r.ok, true, 'a long step name is truncated rather than refused — the name is for display, not for control');
  assert.equal(readTag(db, 'R.STEP_NAME').length, STRING_LEN, 'the stored text must be capped');
  assert.equal(writeTag(db, 'R.STEP_NAME', 42).ok, false, 'a number into a text tag must still be refused');
});

test('clearNonRetained is a power cycle: retentive tags survive it', () => {
  const db = bench();
  writeTag(db, 'M.STAGE_COUNT', 2);
  writeTag(db, 'M.LEAD_IS_P1', true);
  writeTag(db, 'C.P1_STARTS.ACC', 9);
  writeTag(db, 'T.STAGE_DLY.ACC', 3000);

  clearNonRetained(db);
  assert.equal(readTag(db, 'M.STAGE_COUNT'), 0, 'a non-retentive word must come back cleared, as it would after a power cycle');
  assert.equal(readTag(db, 'T.STAGE_DLY.ACC'), 0, 'a non-retentive timer loses its accumulator');
  assert.equal(readTag(db, 'M.LEAD_IS_P1'), true, 'duty selection is retentive, or the plant forgets which pump it was alternating to every restart');
  assert.equal(readTag(db, 'C.P1_STARTS.ACC'), 9, 'a retentive start counter must survive, or the short-cycling metric resets itself');
});

test('the processor tags install with the two constants already set', () => {
  const db = createTagDb();
  const r = installSystemTags(db);
  assert.equal(r.ok, true, `the system tags must install cleanly: ${r.problems.join('; ')}`);
  assert.equal(r.defined, SYSTEM_TAGS.length, 'every system tag must be defined');
  assert.equal(readTag(db, 'S.ALWAYS_ON'), true, 'S.ALWAYS_ON must be true before the first scan, or an unconditional rung never energises');
  assert.equal(readTag(db, 'S.ALWAYS_OFF'), false, 'S.ALWAYS_OFF must be false for the same reason in reverse');
  assert.equal(installSystemTags(db).ok, true, 'installing twice must be harmless, because it happens on every program load');
});

test('a snapshot is a copy, not a window onto the live structures', () => {
  const db = bench();
  writeTag(db, 'T.STAGE_DLY.ACC', 1200);
  const snap = snapshotTags(db);
  writeTag(db, 'T.STAGE_DLY.ACC', 7000);
  assert.equal(snap.values['T.STAGE_DLY'].acc, 1200,
    'the snapshot must have deep-copied the timer — handing out the live object gives a snapshot that keeps changing under the caller');
  assert.equal(JSON.parse(JSON.stringify(snap)).values['I.PT101'], 0, 'a snapshot must survive a JSON round trip, because that is how a session is saved');
});

test('a snapshot taken before a tag existed restores what it can and names what it could not', () => {
  const before = bench();
  writeTag(before, 'M.STAGE_COUNT', 2);
  writeTag(before, 'I.PT101', 4.5);
  forceTag(before, 'I.P1_RUN', true);
  const snap = snapshotTags(before);

  // The database has grown since: one tag is new, and one the snapshot knows about is gone.
  const after = createTagDb();
  defineTag(after, { name: 'M.STAGE_COUNT', type: TYPE.INT, scope: SCOPE.MEMORY, min: 0, max: 2 });
  defineTag(after, { name: 'I.P1_RUN', type: TYPE.BOOL, scope: SCOPE.INPUT });
  defineTag(after, { name: 'M.NEW_SINCE', type: TYPE.REAL, scope: SCOPE.MEMORY });
  writeTag(after, 'M.NEW_SINCE', 3.25);

  const r = restoreTags(after, snap);
  assert.equal(r.ok, true, 'a snapshot that mentions tags this database no longer has must still restore — refusing outright would make snapshots useless the first time the IO map grows');
  assert.equal(r.applied, 2, 'both tags the snapshot and the database share must be restored');
  assert.ok(r.skipped.includes('I.PT101'), 'the names that could not be restored must be reported, not swallowed');
  assert.ok(!r.skipped.includes('M.NEW_SINCE'), 'a tag the snapshot never knew about is not a skipped restore, it is simply untouched');
  assert.equal(readTag(after, 'M.STAGE_COUNT'), 2, 'the shared value must come back');
  assert.equal(readTag(after, 'M.NEW_SINCE'), 3.25, 'a tag the snapshot does not mention must keep what it has');
  assert.equal(readTag(after, 'I.P1_RUN'), true, 'the forces travel with the snapshot, or a restored state is not the state that was captured');
  assert.deepEqual(forcedTags(after), ['I.P1_RUN'], 'and they must be listed so the restored force is visible');
});

test('restoring something that is not a snapshot is refused rather than half-applied', () => {
  const db = bench();
  writeTag(db, 'M.STAGE_COUNT', 2);
  assert.equal(restoreTags(db, null).ok, false, 'a missing snapshot must be refused');
  assert.equal(restoreTags(db, { hello: 'world' }).ok, false, 'an arbitrary object must be refused');
  const wrong = restoreTags(db, { v: TAGDB_VERSION + 9, values: {} });
  assert.equal(wrong.ok, false, 'a snapshot from a future format must be refused rather than partly understood');
  assert.match(wrong.reason, /version/, 'and must say why, so the operator knows the file is not corrupt');
  assert.equal(readTag(db, 'M.STAGE_COUNT'), 2, 'a refused restore must not have touched anything');
});

test('the revision counter moves on structural change and not on ordinary writes', () => {
  const db = bench();
  const start = db.rev;
  writeTag(db, 'M.STAGE_COUNT', 1);
  writeTag(db, 'I.PT101', 5);
  assert.equal(db.rev, start, 'ordinary writes must not bump the revision — a UI redrawing on every scan write would redraw thousands of times a second and learn nothing');
  forceTag(db, 'I.PT101', 6);
  assert.ok(db.rev > start, 'a force changes what the tag list means, so the UI must be told the list is stale');
});
