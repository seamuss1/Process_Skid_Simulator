/**
 * tests/badges.test.js — the achievement set.
 *
 * Two kinds of claim are tested here and they need different treatment. The TABLE claims — ids
 * unique, every check total, nothing fires on an empty shift — are tested over the whole table by
 * iteration, because a badge added later must satisfy them without anyone remembering to come
 * back here. The individual badges are tested one at a time against the smallest stats bundle
 * that should earn them, and against a near miss that should not, because a threshold nobody has
 * pushed from both sides is a threshold that could be anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGES, STAT_FIELDS, normaliseStats, evaluateBadges, badgeById, hasBadge,
} from '../src/game/badges.js';

/**
 * A stats bundle in which nothing whatever has happened: every number zero, every flag false.
 * @returns {object} the all-zeros bundle
 */
function zeros() {
  const s = {};
  for (const key of Object.keys(STAT_FIELDS)) {
    const def = STAT_FIELDS[key];
    s[key] = typeof def === 'number' ? 0 : typeof def === 'boolean' ? false : '';
  }
  return s;
}

/**
 * A creditable finished mission: three minutes, gold, no alarms, tidy output.
 * @param {object} [over] field overrides
 * @returns {object} the bundle
 */
function goodRun(over) {
  return {
    ...zeros(),
    mode: 'CAMPAIGN',
    missionId: 'M-01',
    tier: 1,
    medal: 'gold',
    score: 4200,
    duration_s: 180,
    timeInBand_s: 174,
    longestHold_s: 90,
    maxMultiplier: 3,
    bandExits: 2,
    longestExcursion_s: 3,
    coTravel_pct: 260,
    energy_kWh: 0.9,
    parEnergy_kWh: 1.0,
    ...over,
  };
}

/**
 * A fresh profile stub. `profile.js` owns the real shape; a badge list is all this module reads.
 * @returns {object} the stub
 */
function profileStub() {
  return { badges: [] };
}

test('every badge check returns a boolean on an all-zeros shift instead of throwing', () => {
  const s = zeros();
  for (const badge of BADGES) {
    const got = badge.check(s);
    assert.equal(typeof got, 'boolean',
      `${badge.id} returned ${typeof got} — a check that is not a predicate breaks the results screen`);
    assert.equal(got, false,
      `${badge.id} fired on a shift where nothing happened, so it will fire on everything`);
  }
});

test('every badge check survives null, an empty object and garbage in every field', () => {
  const junk = {};
  for (const key of Object.keys(STAT_FIELDS)) junk[key] = key.endsWith('_s') ? NaN : undefined;
  junk.score = 'lots';
  junk.medal = 42;
  junk.duration_s = Infinity;
  junk.tripped = 1;
  for (const badge of BADGES) {
    for (const s of [null, undefined, {}, junk, [], 'nonsense', 7]) {
      const got = badge.check(s);
      assert.equal(typeof got, 'boolean',
        `${badge.id} did not return a boolean for ${JSON.stringify(s)}`);
    }
    assert.equal(badge.check(junk), false,
      `${badge.id} awarded itself on garbage — a truthy 1 must not read as a flag`);
  }
});

test('badge ids are unique and every badge carries a title and a one-line detail', () => {
  assert.ok(BADGES.length >= 20, `only ${BADGES.length} badges — the set is meant to be at least 20`);
  const seen = new Set();
  for (const badge of BADGES) {
    assert.equal(typeof badge.id, 'string');
    assert.ok(badge.id.length > 0, 'a badge with no id cannot be stored in a profile');
    assert.ok(!seen.has(badge.id), `duplicate id ${badge.id} — the second one can never be earned`);
    seen.add(badge.id);
    assert.ok(badge.title.length > 0, `${badge.id} has no title`);
    assert.ok(badge.detail.length > 0, `${badge.id} has no detail`);
    assert.ok(!badge.detail.includes('!'), `${badge.id} shouts; the house voice does not`);
    assert.equal(typeof badge.hidden, 'boolean', `${badge.id} must say whether it is hidden`);
    assert.equal(typeof badge.check, 'function', `${badge.id} has no check`);
    assert.ok(Object.isFrozen(badge), `${badge.id} is mutable, so the UI could edit the table`);
  }
  assert.ok(Object.isFrozen(BADGES), 'the badge table must be frozen');
  assert.ok(BADGES.filter((b) => b.hidden).length >= 2,
    'at least a couple of badges should be hidden, or there is nothing to discover');
});

test('every badge condition is reachable from some shift the scoring engine could produce', () => {
  // Not a proof, but it catches the badge whose threshold contradicts itself — the one that is
  // impossible to earn and that nobody notices for a year.
  const reachable = new Map([
    ['first-shift', goodRun({ firstClear: true })],
    ['first-gold', goodRun()],
    ['tier-swept', goodRun({ goldsInTier: 4, missionsInTier: 4 })],
    ['band-perfect', goodRun({ timeInBand_s: 180, bandExits: 0, longestExcursion_s: 0 })],
    ['quiet-panel', goodRun({ alarmCount: 0 })],
    ['under-par', goodRun()],
    ['miser', goodRun({ energy_kWh: 0.8, parEnergy_kWh: 1.0 })],
    ['wave-ten', { ...zeros(), mode: 'ENDLESS', wave: 10 }],
    ['wave-twenty', { ...zeros(), mode: 'ENDLESS', wave: 22 }],
    ['fault-streak', { ...zeros(), mode: 'FAULT', diagnosisCorrect: true, faultStreak: 5 }],
    ['fault-fast', { ...zeros(), mode: 'FAULT', diagnosisCorrect: true, diagnosisTime_s: 30 }],
    ['robust', goodRun({ gainMargin_dB: 8, phaseMargin_deg: 52 })],
    ['ghost-beaten', goodRun({ ghostBeaten: true })],
    ['gentle-hands', goodRun()],
    ['valve-saver', goodRun({ coTravel_pct: 120, duration_s: 300, timeInBand_s: 290 })],
    ['multiplier-cap', goodRun({ maxMultiplier: 4 })],
    ['long-hold', goodRun({ longestHold_s: 130 })],
    ['suction-intact', goodRun()],
    ['manual-only', goodRun({ manualOnly: true })],
    ['by-ear', goodRun()],
    ['daily-week', { ...goodRun(), mode: 'DAILY', dailyStreak_days: 7 }],
    ['five-figures', goodRun({ score: 12000 })],
    ['own-record', goodRun({ personalBest: true, previousBest: 3000, score: 4200 })],
    ['unbothered', goodRun({ upsetsRidden: 6, upsetsHeldInBand: 6 })],
    ['short-excursions', goodRun({ bandExits: 4, longestExcursion_s: 4 })],
    ['clean-sheet', goodRun({ timeInBand_s: 180, bandExits: 0, longestExcursion_s: 0 })],
    ['learning-experience', { ...zeros(), mode: 'CAMPAIGN', failed: true, tripped: true }],
    ['second-sight', { ...zeros(), mode: 'FAULT', diagnosisCorrect: true, diagnosisTime_s: 12 }],
  ]);
  for (const badge of BADGES) {
    const s = reachable.get(badge.id);
    assert.ok(s, `${badge.id} has no worked example here — add one when you add a badge`);
    assert.equal(badge.check(s), true, `${badge.id} could not be earned by the shift meant to earn it`);
  }
});

test('a shift that never ran earns nothing, however good its other numbers look', () => {
  const p = profileStub();
  const s = goodRun({ duration_s: 0, timeInBand_s: 0, score: 50000, medal: 'gold' });
  assert.deepEqual(evaluateBadges(p, s), [],
    'a zero-length shift must not award anything — it is the shape an aborted run leaves behind');
});

test('free play earns nothing, because there are no rules to keep in sandbox', () => {
  const p = profileStub();
  const s = goodRun({ mode: 'SANDBOX', firstClear: true, ghostBeaten: true, score: 99000 });
  const earned = evaluateBadges(p, s);
  for (const id of earned) {
    const badge = badgeById(id);
    assert.fail(`sandbox awarded ${id} (${badge.title}), which cannot have been earned there`);
  }
});

test('a failed shift earns only the badge for having failed', () => {
  const p = profileStub();
  const s = { ...zeros(), mode: 'CAMPAIGN', failed: true, tripped: true, duration_s: 60 };
  assert.deepEqual(evaluateBadges(p, s), ['learning-experience'],
    'a trip is worth a wry badge and nothing else — a failed shift must not pay out');
});

test('evaluateBadges awards each badge exactly once however often it is called', () => {
  const p = profileStub();
  const s = goodRun({ firstClear: true, timeInBand_s: 180, bandExits: 0, longestExcursion_s: 0 });
  const first = evaluateBadges(p, s);
  assert.ok(first.length >= 3, `expected a handful of badges from a gold clean sheet, got ${first.length}`);
  const second = evaluateBadges(p, s);
  assert.deepEqual(second, [],
    'the same result was cashed in twice, so the player can farm pops by re-rendering the screen');
  const third = evaluateBadges(p, goodRun({ firstClear: true }));
  assert.deepEqual(third, [], 'a later shift re-earned badges the profile already held');
  assert.equal(new Set(p.badges).size, p.badges.length, 'the profile ended up holding a duplicate');
  for (const id of first) assert.ok(hasBadge(p, id), `${id} was reported as earned but not stored`);
});

test('a badge earned on one shift is not re-earned when a later shift also qualifies', () => {
  const p = profileStub();
  evaluateBadges(p, goodRun({ score: 12000 }));
  assert.ok(hasBadge(p, 'five-figures'));
  const again = evaluateBadges(p, goodRun({ score: 40000 }));
  assert.ok(!again.includes('five-figures'), 'a bigger score re-awarded a badge already held');
});

test('the profile badge list is read wherever it is kept — array, Set or map from JSON', () => {
  const asSet = { badges: new Set(['five-figures']) };
  assert.ok(hasBadge(asSet, 'five-figures'));
  assert.ok(!evaluateBadges(asSet, goodRun({ score: 12000 })).includes('five-figures'),
    'a Set-backed profile was awarded a duplicate');
  assert.ok(asSet.badges.has('first-gold'), 'a Set-backed profile did not receive new badges');

  const asMap = { badges: { 'five-figures': 1700000000000 } };
  assert.ok(hasBadge(asMap, 'five-figures'));
  assert.ok(!evaluateBadges(asMap, goodRun({ score: 12000 })).includes('five-figures'),
    'a map-backed profile was awarded a duplicate');
  assert.ok(asMap.badges['first-gold'], 'a map-backed profile did not receive new badges');

  const missing = {};
  assert.equal(hasBadge(missing, 'first-gold'), false);
  assert.ok(evaluateBadges(missing, goodRun()).includes('first-gold'));
  assert.ok(Array.isArray(missing.badges), 'a profile with no badge list should get one');
});

test('an injected writer takes over the award, so persistence stays in one place', () => {
  const p = profileStub();
  const written = [];
  const earned = evaluateBadges(p, goodRun({ score: 12000 }), (profile, id) => {
    written.push(id);
    profile.badges.push(id);
    return true;
  });
  assert.deepEqual(written, earned, 'the injected writer did not see every award');
  assert.ok(written.includes('five-figures'));
});

test('nonsense in place of a profile or a result is refused quietly rather than thrown', () => {
  for (const bad of [null, undefined, 'profile', 42, []]) {
    assert.deepEqual(evaluateBadges(bad, goodRun()), [],
      `evaluateBadges(${JSON.stringify(bad)}) should award nothing`);
  }
  const p = profileStub();
  for (const bad of [null, undefined, 'stats', 0]) {
    assert.deepEqual(evaluateBadges(p, bad), [],
      `evaluateBadges(profile, ${JSON.stringify(bad)}) should award nothing`);
  }
  assert.equal(p.badges.length, 0, 'a nonsense result still managed to write to the profile');
});

test('badgeById finds a badge and returns null rather than undefined for anything else', () => {
  assert.equal(badgeById('first-gold').title, 'Gold on the Board');
  for (const bad of ['', 'no-such-badge', null, undefined, 7, {}]) {
    assert.equal(badgeById(bad), null, `badgeById(${JSON.stringify(bad)}) should be null`);
  }
});

test('normaliseStats fills every field, drops NaN, and works out the in-band fraction', () => {
  const s = normaliseStats({});
  for (const key of Object.keys(STAT_FIELDS)) {
    assert.ok(key in s, `${key} missing after normalisation`);
    if (typeof STAT_FIELDS[key] === 'number') {
      assert.ok(Number.isFinite(s[key]), `${key} came out non-finite`);
    }
  }
  const nan = normaliseStats({ score: NaN, duration_s: Infinity, energy_kWh: 'free' });
  assert.equal(nan.score, 0, 'NaN must collapse to zero or every comparison against it is false');
  assert.equal(nan.duration_s, 0, 'an infinite duration is not a duration');
  assert.equal(nan.energy_kWh, 0);
  assert.equal(normaliseStats({ tripped: 1 }).tripped, false, 'only a real true is a flag');

  const derived = normaliseStats({ duration_s: 200, timeInBand_s: 150 });
  assert.equal(derived.inBandFraction, 0.75, 'the fraction should be derived when it is not given');
  const given = normaliseStats({ duration_s: 200, timeInBand_s: 150, inBandFraction: 0.9 });
  assert.equal(given.inBandFraction, 0.9, 'a supplied fraction must win over the derived one');
  assert.equal(normaliseStats({ timeInBand_s: 10 }).inBandFraction, 0,
    'a zero-length shift must not divide by its own duration');
  assert.deepEqual(normaliseStats(null), normaliseStats({}), 'null should normalise like nothing');
});

test('the thresholds are pushed from both sides, so none of them sits anywhere by accident', () => {
  const near = (over) => badgeById(over.id).check({ ...goodRun(), ...over.stats });

  assert.equal(near({ id: 'robust', stats: { gainMargin_dB: 5.9, phaseMargin_deg: 60 } }), false,
    'six decibels of gain margin means six, not almost six');
  assert.equal(near({ id: 'robust', stats: { gainMargin_dB: 9, phaseMargin_deg: 44 } }), false,
    'phase margin is half of the claim and must be checked too');

  assert.equal(near({ id: 'gentle-hands', stats: { coTravel_pct: 501 } }), false);
  assert.equal(near({ id: 'gentle-hands', stats: { coTravel_pct: 500 } }), true);
  assert.equal(near({ id: 'gentle-hands', stats: { coTravel_pct: 100, duration_s: 90 } }), false,
    'a ninety second shift is too short for a travel budget to mean anything');

  assert.equal(near({ id: 'valve-saver', stats: { coTravel_pct: 300, duration_s: 300 } }), true,
    '300 percent over five minutes is 60 a minute, exactly on the limit');
  assert.equal(near({ id: 'valve-saver', stats: { coTravel_pct: 360, duration_s: 300 } }), false);

  assert.equal(near({ id: 'under-par', stats: { energy_kWh: 1.0, parEnergy_kWh: 1.0 } }), false,
    'matching par is not beating it');
  assert.equal(near({ id: 'under-par', stats: { energy_kWh: 1.0, parEnergy_kWh: 0 } }), false,
    'a mission with no par cannot be beaten on energy');
  assert.equal(near({ id: 'miser', stats: { energy_kWh: 0.86, parEnergy_kWh: 1.0 } }), false);

  assert.equal(near({ id: 'band-perfect', stats: { timeInBand_s: 178 } }), false,
    'two seconds outside the band is not a whole shift inside it');
  assert.equal(near({ id: 'wave-ten', stats: { mode: 'ENDLESS', wave: 9 } }), false);
  assert.equal(near({ id: 'fault-fast', stats: { diagnosisCorrect: true, diagnosisTime_s: 46 } }), false);
  assert.equal(near({ id: 'second-sight', stats: { diagnosisCorrect: true, diagnosisTime_s: 20 } }), true);
  assert.equal(near({ id: 'fault-streak', stats: { diagnosisCorrect: false, faultStreak: 9 } }), false,
    'a streak that ended on a wrong call is not a streak');
  assert.equal(near({ id: 'tier-swept', stats: { goldsInTier: 3, missionsInTier: 4 } }), false);
  assert.equal(near({ id: 'tier-swept', stats: { goldsInTier: 0, missionsInTier: 0 } }), false,
    'a tier with no missions in it must not sweep itself');
  assert.equal(near({ id: 'own-record', stats: { personalBest: true, previousBest: 0 } }), false,
    'a first clear beats no record, so it is not a record broken');
  assert.equal(near({ id: 'unbothered', stats: { upsetsRidden: 8, upsetsHeldInBand: 6 } }), false,
    'two upsets that pushed the trace out of the band are two too many');
  assert.equal(near({ id: 'short-excursions', stats: { bandExits: 4, longestExcursion_s: 6 } }), false);
  assert.equal(near({ id: 'short-excursions', stats: { bandExits: 2, longestExcursion_s: 2 } }), false,
    'this one is for a busy shift, not a quiet one');
  assert.equal(near({ id: 'by-ear', stats: { usedAutotune: true } }), false);
});
