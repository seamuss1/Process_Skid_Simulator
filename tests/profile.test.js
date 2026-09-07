/**
 * tests/profile.test.js — the persistent player record: ranks, the unlock gate, run history, and
 * the four ways an injected storage misbehaves in the field.
 *
 * The storage cases are the point of this file. Three of the four (absent, throwing read,
 * throwing write) are ordinary browser behaviour rather than exotic failures, and the fourth (a
 * save from another build, or one edited by hand) is what happens the first time anyone updates
 * the game with a profile already on disk. Each one is exercised against a real fake storage
 * rather than a stub of the module, because the claim being made is about the module's behaviour
 * at its boundary and a stub would only test the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_VERSION, STORAGE_KEY, RANKS, UNLOCKS, UNLOCK_ORDER, BASE_UNLOCK, XP,
  createProfile, loadProfile, saveProfile, rankFor, nextRankFor, addXp,
  recordMission, recordEndless, recordDaily, isUnlocked, unlock, awardBadge,
  resetProfile, exportProfile, importProfile,
} from '../src/game/profile.js';

/**
 * A storage that behaves. `fail` selects a method to make throw, the way a private-mode browser
 * does.
 * @param {object} [seed] initial contents, key to string
 * @param {string} [fail] 'read', 'write' or nothing
 * @returns {object} a storage with getItem/setItem
 */
function fakeStorage(seed, fail) {
  const map = { ...(seed || {}) };
  return {
    map,
    /**
     * @param {string} k the key
     * @returns {string|null} the stored text
     */
    getItem(k) {
      if (fail === 'read') throw new Error('SecurityError: the operation is insecure');
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    },
    /**
     * @param {string} k the key
     * @param {string} v the text
     * @returns {void}
     */
    setItem(k, v) {
      if (fail === 'write') throw new Error('QuotaExceededError');
      map[k] = String(v);
    },
  };
}

/**
 * A finished-run result.
 * @param {object} [over] fields to override
 * @returns {object} the result
 */
function run(over) {
  return { score: 1000, medal: 'bronze', failed: false, duration_s: 180, ...over };
}

// ---------------------------------------------------------------------------------------------
// The tables themselves

test('the rank roster is six grades whose thresholds only ever go up', () => {
  assert.equal(RANKS.length, 6, 'the UI and the mission briefs assume six grades');
  const ids = new Set(RANKS.map((r) => r.id));
  assert.equal(ids.size, RANKS.length, 'two ranks sharing an id would make rankFor ambiguous');
  assert.equal(RANKS[0].xp, 0, 'a new player must already hold the first rank');
  for (let i = 1; i < RANKS.length; i += 1) {
    assert.ok(RANKS[i].xp > RANKS[i - 1].xp, `rank ${RANKS[i].id} must cost more than the one below it`);
    assert.ok(RANKS[i].title.length > 0, 'a rank with no title cannot be shown to the player');
  }
});

test('every unlock carries its own id and the order list covers the whole table', () => {
  const keys = Object.keys(UNLOCKS);
  assert.ok(keys.length >= 12, 'the controller is meant to be handed back in at least twelve pieces');
  for (const k of keys) {
    assert.equal(UNLOCKS[k].id, k, `unlock ${k} must know its own id or the UI cannot round-trip it`);
    assert.ok(UNLOCKS[k].label.length > 0, `unlock ${k} needs a label for the unlock card`);
    assert.ok(UNLOCKS[k].detail.length > 0, `unlock ${k} needs a detail line saying what it fixes`);
  }
  assert.deepEqual([...UNLOCK_ORDER].sort(), keys.slice().sort(), 'UNLOCK_ORDER must list exactly the table');
  assert.equal(UNLOCK_ORDER[0], BASE_UNLOCK, 'manual output is where the progression starts');
});

test('the unlock ladder hands out the controller in the order the pain arrives', () => {
  const want = ['manual', 'proportional', 'reset', 'derivative'];
  assert.deepEqual(UNLOCK_ORDER.slice(0, 4), want, 'a term granted early costs the lesson it was meant to teach');
  assert.ok(UNLOCK_ORDER.indexOf('autotune') > UNLOCK_ORDER.indexOf('derivative'),
    'the autotuner must not arrive before the player has tuned by hand');
});

// ---------------------------------------------------------------------------------------------
// A fresh profile and the rank curve

test('a new profile holds manual output and nothing else', () => {
  const p = createProfile();
  assert.equal(p.v, PROFILE_VERSION);
  assert.equal(p.xp, 0);
  assert.equal(p.rank, RANKS[0].id);
  assert.deepEqual(p.unlocks, [BASE_UNLOCK], 'starting with a PID term defeats the whole campaign');
  assert.equal(isUnlocked(p, 'proportional'), false, 'proportional must be earned');
  assert.equal(isUnlocked(p, 'manual'), true, 'the player must always be able to drive by hand');
});

test('rankFor picks the highest grade paid for and survives nonsense input', () => {
  assert.equal(rankFor(0).id, RANKS[0].id);
  assert.equal(rankFor(RANKS[1].xp - 1).id, RANKS[0].id, 'one point short is still the lower rank');
  assert.equal(rankFor(RANKS[1].xp).id, RANKS[1].id, 'the threshold itself must promote');
  assert.equal(rankFor(1e12).id, RANKS[RANKS.length - 1].id, 'the roster has a top and must stop there');
  assert.equal(rankFor(NaN).id, RANKS[0].id, 'a NaN XP total must not leave the rank undefined');
  assert.equal(rankFor(-500).id, RANKS[0].id, 'negative XP cannot demote below Trainee');
  assert.equal(rankFor(undefined).id, RANKS[0].id);
});

test('nextRankFor names the grade being filled towards and null at the top', () => {
  assert.equal(nextRankFor(0).id, RANKS[1].id);
  assert.equal(nextRankFor(RANKS[RANKS.length - 1].xp), null, 'the progress bar must know when it is finished');
});

test('the top rank is reachable in roughly six to eight hours of competent play', () => {
  // A three-minute mission scoring 3000 for a silver, i.e. the intended ~50 XP per minute.
  const perRun = XP.medal.silver + 3000 * XP.perPoint;
  const minutes = (RANKS[RANKS.length - 1].xp / perRun) * 3;
  assert.ok(minutes > 300 && minutes < 500,
    `the XP economy and the rank thresholds have drifted apart: ${Math.round(minutes)} min to the top`);
});

test('addXp promotes exactly once at a threshold and reports the crossing', () => {
  const p = createProfile();
  const a = addXp(p, RANKS[1].xp - 10);
  assert.equal(a.rankUp, false, 'no promotion until the threshold is actually crossed');
  const b = addXp(p, 10);
  assert.equal(b.rankUp, true, 'crossing the threshold must raise the promotion card');
  assert.equal(b.rank.id, RANKS[1].id);
  const c = addXp(p, 1);
  assert.equal(c.rankUp, false, 'a second award at the same rank must not raise the card again');
  assert.equal(p.rank, RANKS[1].id, 'the stored rank id must track the awarded XP');
});

test('addXp ignores NaN, zero and negative awards without corrupting the total', () => {
  const p = createProfile();
  addXp(p, 500);
  for (const bad of [NaN, Infinity, -Infinity, 0, -400, '900', null, undefined, {}]) {
    addXp(p, bad);
    assert.equal(p.xp, 500, `an award of ${String(bad)} must leave the total untouched`);
  }
  assert.ok(Number.isFinite(p.xp), 'a non-finite XP total would freeze the rank forever');
});

// ---------------------------------------------------------------------------------------------
// The unlock gate

test('unlock grants once and refuses anything not in the table', () => {
  const p = createProfile();
  assert.equal(unlock(p, 'reset'), true, 'the first grant is what raises the unlock card');
  assert.equal(unlock(p, 'reset'), false, 'a second grant must not raise a second card');
  assert.equal(isUnlocked(p, 'reset'), true);
  assert.equal(unlock(p, 'godmode'), false, 'an id with no mission behind it must not be grantable');
  assert.equal(isUnlocked(p, 'godmode'), false, 'an unknown gate answers locked, never open');
  assert.equal(p.unlocks.length, 2, 'the refused grants must not have been written anywhere');
});

test('a hand-written unlock list cannot smuggle in an unknown feature', () => {
  const storage = fakeStorage({
    [STORAGE_KEY]: JSON.stringify({ v: 1, xp: 0, unlocks: ['manual', 'cascade', 'godmode', 7, null] }),
  });
  const p = loadProfile(storage);
  assert.equal(isUnlocked(p, 'cascade'), true, 'a real unlock in the file must still be honoured');
  assert.equal(p.unlocks.indexOf('godmode'), -1, 'an invented unlock must be filtered out on load');
  assert.equal(p.unlocks.every((u) => typeof u === 'string'), true, 'non-string entries must not survive');
});

test('badges are awarded once each and an empty id is refused', () => {
  const p = createProfile();
  assert.equal(awardBadge(p, 'first-gold'), true);
  assert.equal(awardBadge(p, 'first-gold'), false, 'the same badge must not be earnable twice');
  assert.equal(awardBadge(p, ''), false, 'an empty badge id would show as a blank tile');
  assert.equal(awardBadge(p, null), false);
  assert.deepEqual(p.badges, ['first-gold']);
});

// ---------------------------------------------------------------------------------------------
// Recording runs

test('the first clean run of a mission pays the first-clear bonus and only once', () => {
  const p = createProfile();
  const a = recordMission(p, 'T1-M1', run({ score: 1000, medal: 'bronze' }));
  assert.equal(a.firstClear, true);
  const b = recordMission(p, 'T1-M1', run({ score: 1000, medal: 'bronze' }));
  assert.equal(b.firstClear, false, 'the bonus is for clearing it, not for replaying it');
  assert.ok(a.xpGained > b.xpGained, 'the first clear must be worth more than the replay');
  assert.equal(p.missions['T1-M1'].plays, 2, 'both attempts must be counted');
});

test('a mission keeps the best score and never gives back a medal already earned', () => {
  const p = createProfile();
  recordMission(p, 'T2-M3', run({ score: 4000, medal: 'gold' }));
  const worse = recordMission(p, 'T2-M3', run({ score: 200, medal: 'none' }));
  assert.equal(worse.best, 4000, 'a bad replay must not overwrite the best score');
  assert.equal(worse.medal, 'gold', 'a gold once earned is kept; taking it back would punish practice');
  const better = recordMission(p, 'T2-M3', run({ score: 4500, medal: 'gold' }));
  assert.equal(better.best, 4500, 'a better run must move the best');
});

test('a failed shift still pays a little and does not count as cleared', () => {
  const p = createProfile();
  const r = recordMission(p, 'T1-M2', run({ score: 900, medal: 'gold', failed: true }));
  assert.equal(r.xpGained, XP.failed, 'a trip pays the consolation award and nothing else');
  assert.equal(r.medal, 'none', 'a medal cannot be claimed on a shift that tripped');
  assert.equal(p.missions['T1-M2'].cleared, false, 'a failed run must leave the mission uncleared');
  assert.equal(p.stats.failed, 1);
  assert.equal(p.stats.cleared, 0);
  const ok = recordMission(p, 'T1-M2', run({ score: 900, medal: 'silver' }));
  assert.equal(ok.firstClear, true, 'the first clear is the first run that did not fail');
});

test('no single run can be worth more XP than the per-run cap', () => {
  const p = createProfile();
  const r = recordMission(p, 'T5-M1', run({ score: 1e9, medal: 'gold' }));
  assert.equal(r.xpGained, XP.runCap, 'an uncapped run would let one lucky shift skip a rank');
});

test('recording refuses a run it cannot file rather than throwing', () => {
  const p = createProfile();
  assert.equal(recordMission(p, '', run()).ok, false, 'a run with no mission id has nowhere to go');
  assert.equal(recordMission(p, 'X', null).ok, false);
  assert.equal(recordMission(null, 'X', run()).ok, false);
  assert.equal(recordEndless(p, undefined).ok, false);
  assert.equal(recordDaily(p, 'yesterday', run()).ok, false, 'the daily key must be a real date');
  assert.equal(p.xp, 0, 'a refused record must not have credited anything');
  assert.equal(p.stats.runs, 0);
});

test('a result full of NaN records as zero rather than poisoning the profile', () => {
  const p = createProfile();
  const r = recordMission(p, 'T1-M1', { score: NaN, medal: 'platinum', failed: 'no', duration_s: NaN });
  assert.equal(r.best, 0, 'a NaN score must land as zero, not as NaN');
  assert.equal(r.medal, 'none', 'a medal name nobody defined must not be stored');
  assert.ok(Number.isFinite(p.xp) && Number.isFinite(p.stats.points),
    'one NaN reaching the totals would make every later comparison false');
});

test('a zero-length shift is recorded without inventing a best time', () => {
  const p = createProfile();
  recordMission(p, 'T1-M1', run({ duration_s: 0, score: 0, medal: 'none' }));
  assert.equal(p.missions['T1-M1'].bestTime_s, 0, 'a run of no length is not a record time');
  assert.equal(p.stats.seconds, 0);
});

test('endless keeps the deepest wave and the highest score independently', () => {
  const p = createProfile();
  recordEndless(p, { score: 5000, wave: 9, duration_s: 400 });
  const r = recordEndless(p, { score: 1000, wave: 12, duration_s: 500 });
  assert.equal(r.best, 5000, 'a deeper but sloppier run must not lower the best score');
  assert.equal(r.bestWave, 12, 'the deepest wave reached is its own record');
  assert.equal(p.endless.plays, 2);
});

test('the daily keeps one best per date and drops the oldest once the history is full', () => {
  const p = createProfile();
  const first = recordDaily(p, '2026-01-01', run({ score: 800, medal: 'silver' }));
  assert.equal(first.firstToday, true, 'the first attempt of a date pays the daily bonus');
  const second = recordDaily(p, '2026-01-01', run({ score: 100, medal: 'none' }));
  assert.equal(second.best, 800, 'the daily records your best attempt, not your last');
  assert.equal(second.medal, 'silver');
  assert.equal(second.firstToday, false);
  assert.equal(p.daily['2026-01-01'].plays, 2);

  for (let d = 1; d <= 90; d += 1) {
    const day = `2026-04-${String(d % 28 + 1).padStart(2, '0')}`;
    recordDaily(p, day, run());
  }
  assert.ok(Object.keys(p.daily).length <= 60,
    'an unbounded daily history would eventually fill the origin storage quota');
});

// ---------------------------------------------------------------------------------------------
// The four ways storage misbehaves

test('a null storage still yields a working profile and says why it cannot save', () => {
  const p = loadProfile(null);
  assert.equal(p.xp, 0, 'no storage means a fresh profile, not a broken one');
  addXp(p, 100);
  const r = saveProfile(null, p);
  assert.equal(r.ok, false);
  assert.match(r.reason, /storage/i, 'the refusal must be a sentence an operator could read');
  assert.equal(p.xp, 100, 'a refused save must leave the in-memory profile exactly as it was');
});

test('a storage whose read throws is survived as if it were empty', () => {
  const p = loadProfile(fakeStorage({}, 'read'));
  assert.equal(p.xp, 0);
  assert.deepEqual(p.unlocks, [BASE_UNLOCK], 'a throwing read must not leave the profile half-built');
});

test('a storage whose write throws costs the save but never the run just played', () => {
  const storage = fakeStorage({}, 'write');
  const p = createProfile();
  recordMission(p, 'T1-M1', run({ score: 2400, medal: 'silver' }));
  const before = JSON.stringify(p);
  const r = saveProfile(storage, p);
  assert.equal(r.ok, false, 'Safari private mode throws here and it must be reported, not thrown');
  assert.ok(r.reason.length > 0);
  assert.equal(JSON.stringify(p), before, 'the shift the player just finished must survive a failed save');
});

test('garbage in storage is discarded rather than believed', () => {
  for (const junk of ['', '   ', 'not json at all', '{"xp":', '[]', 'null', '"a string"', '42']) {
    const p = loadProfile(fakeStorage({ [STORAGE_KEY]: junk }));
    assert.equal(p.xp, 0, `"${junk}" must load as a fresh profile`);
    assert.deepEqual(p.unlocks, [BASE_UNLOCK], `"${junk}" must not leave the unlock list broken`);
    assert.equal(typeof p.missions, 'object');
  }
});

test('a profile written by a newer build keeps what this build understands', () => {
  const future = JSON.stringify({
    v: PROFILE_VERSION + 7,
    xp: 4200,
    unlocks: ['manual', 'proportional', 'quantumMode'],
    badges: ['first-gold'],
    missions: { 'T1-M1': { plays: 3, cleared: true, best: 2100, medal: 'silver' } },
    prestige: { tier: 9 },
  });
  const p = loadProfile(fakeStorage({ [STORAGE_KEY]: future }));
  assert.equal(p.xp, 4200, 'a version bump must not cost the player their experience');
  assert.equal(p.rank, rankFor(4200).id, 'rank is re-derived from XP, never read from the file');
  assert.equal(isUnlocked(p, 'proportional'), true);
  assert.equal(p.unlocks.indexOf('quantumMode'), -1, 'a feature this build has no gate for must be dropped');
  assert.equal(p.missions['T1-M1'].best, 2100);
  assert.equal(p.prestige, undefined, 'unknown fields must not be carried into the live profile');
  assert.equal(p.v, PROFILE_VERSION, 'the loaded profile is stamped with the version now running');
});

test('a profile with every field of the wrong type loads as a fresh one', () => {
  const p = loadProfile(fakeStorage({
    [STORAGE_KEY]: JSON.stringify({
      v: 'one', xp: 'lots', rank: 'SUPERINTENDENT', unlocks: 'everything',
      badges: 3, missions: [], endless: 'deep', daily: 7, stats: null,
    }),
  }));
  assert.equal(p.xp, 0, 'a non-numeric XP must not become NaN');
  assert.equal(p.rank, RANKS[0].id, 'a rank claimed in the file buys nothing without the XP behind it');
  assert.deepEqual(p.unlocks, [BASE_UNLOCK]);
  assert.deepEqual(p.badges, []);
  assert.equal(p.endless.best, 0);
  assert.equal(p.stats.runs, 0);
});

test('a saved profile reloads with the same rank, unlocks and bests', () => {
  const storage = fakeStorage();
  const p = createProfile();
  addXp(p, RANKS[2].xp + 50);
  unlock(p, 'proportional');
  unlock(p, 'reset');
  awardBadge(p, 'held-the-band');
  recordMission(p, 'T2-M1', run({ score: 3300, medal: 'gold' }));
  recordEndless(p, { score: 2000, wave: 6, duration_s: 300 });
  recordDaily(p, '2026-09-07', run({ score: 1500, medal: 'silver' }));
  assert.equal(saveProfile(storage, p).ok, true);

  const q = loadProfile(storage);
  assert.equal(q.xp, p.xp, 'the whole point of saving is that the XP comes back');
  assert.equal(q.rank, p.rank);
  assert.deepEqual(q.unlocks, p.unlocks, 'a lost unlock would re-lock a feature the player earned');
  assert.deepEqual(q.badges, p.badges);
  assert.deepEqual(q.missions, p.missions);
  assert.deepEqual(q.endless, p.endless);
  assert.deepEqual(q.daily, p.daily);
  assert.deepEqual(q.stats, p.stats);
});

// ---------------------------------------------------------------------------------------------
// Reset, export and import

test('resetProfile wipes in place so every holder of the object sees the wipe', () => {
  const p = createProfile();
  addXp(p, 9000);
  unlock(p, 'cascade');
  const alias = p;
  resetProfile(p);
  assert.equal(alias.xp, 0, 'the UI is holding this same object and must see the reset');
  assert.equal(alias.rank, RANKS[0].id);
  assert.deepEqual(alias.unlocks, [BASE_UNLOCK]);
  assert.deepEqual(alias.missions, {});
});

test('an exported profile imports back identically', () => {
  const p = createProfile();
  addXp(p, 2600);
  unlock(p, 'proportional');
  recordMission(p, 'T1-M4', run({ score: 1800, medal: 'silver' }));
  const text = exportProfile(p);
  const q = createProfile();
  const r = importProfile(q, text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, [], 'a profile this build wrote must import with nothing dropped');
  assert.equal(q.xp, p.xp);
  assert.deepEqual(q.unlocks, p.unlocks);
  assert.deepEqual(q.missions, p.missions);
});

test('a failed import leaves the profile the player already had untouched', () => {
  const p = createProfile();
  addXp(p, 1500);
  unlock(p, 'proportional');
  const before = JSON.stringify(p);
  for (const junk of ['', '   ', 'nope', '{"xp":', '"text"', null, undefined, 12]) {
    const r = importProfile(p, junk);
    assert.equal(r.ok, false, `importing ${String(junk)} must be refused`);
    assert.ok(r.problems.length > 0, 'a refusal must say what was wrong with the paste');
  }
  assert.equal(JSON.stringify(p), before, 'a bad paste must never cost the player their profile');
});

test('an import that is partly wrong lands the good half and reports the rest', () => {
  const p = createProfile();
  const r = importProfile(p, JSON.stringify({
    v: 1, xp: 5000, unlocks: ['manual', 'reset', 'wormhole'], missions: 'lots',
  }));
  assert.equal(r.ok, true);
  assert.equal(p.xp, 5000, 'the fields that made sense must be kept');
  assert.equal(isUnlocked(p, 'reset'), true);
  assert.equal(isUnlocked(p, 'wormhole'), false);
  assert.ok(r.problems.length >= 2, 'the player needs told which parts of the paste were dropped');
});

test('an import wrapped in an envelope object is accepted too', () => {
  const p = createProfile();
  const r = importProfile(p, JSON.stringify({ app: 'skid', profile: { v: 1, xp: 777 } }));
  assert.equal(r.ok, true, 'a pasted export that someone wrapped must still be readable');
  assert.equal(p.xp, 777);
});
