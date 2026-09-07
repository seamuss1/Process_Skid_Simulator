/**
 * tests/score.test.js — the live scoring engine.
 *
 * The engine is pure arithmetic, so every expectation here is worked out by hand in the test name
 * or the comment above it rather than recorded from a previous run. A scoring change that was not
 * intended will therefore fail a test that says what the old number meant, instead of quietly
 * rewriting a golden value.
 *
 * The two claims that matter most to a player are asserted hardest: the multiplier survives
 * measurement noise on the band edge but not a real excursion, and the breakdown adds up to the
 * score exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORE, createScoreState, stepScore, scoreEvent, takePops, finishScore, medalFor,
} from '../src/game/score.js';

/**
 * Assert two numbers agree to an absolute tolerance, with a message that shows both.
 *
 * Spelled out here rather than taken from `tests/helpers.js`: that module builds a whole simulator
 * to make its fixtures, and this engine is pure arithmetic that must be testable without one.
 *
 * @param {number} got the value under test
 * @param {number} want the expected value
 * @param {number} tol absolute tolerance
 * @param {string} what a description for the failure message
 * @returns {void}
 */
function near(got, want, tol, what) {
  assert.ok(Number.isFinite(got), `${what}: got a non-finite ${got}`);
  assert.ok(Math.abs(got - want) <= tol,
    `${what}: expected ${want} +/- ${tol}, got ${got} (off by ${(got - want).toPrecision(3)})`);
}

/** A scan period. Nothing here depends on it except through the arithmetic. */
const DT = 0.5;

/** A mission's rules with a band of exactly one engineering unit, so ratios are readable. */
const RULES = Object.freeze({ band: 1, bandEU: 'bar' });

/**
 * Feed one repeated sample for a number of seconds.
 * @param {object} st scoring state
 * @param {object} rules the rules in force
 * @param {object} sample the sample to repeat
 * @param {number} seconds how long to hold it
 * @param {number} [dt] scan period
 * @returns {void}
 */
function feed(st, rules, sample, seconds, dt = DT) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i += 1) stepScore(st, rules, sample, dt);
}

/** A sample sitting exactly on setpoint. @returns {object} the sample */
const onSp = () => ({ pv: 10, sp: 10, co: 50, dCo: 0 });

/**
 * A sample a given number of band-widths away from setpoint.
 * @param {number} bands how far out, in band widths
 * @returns {object} the sample
 */
const off = (bands) => ({ pv: 10 + bands * RULES.band, sp: 10, co: 50, dCo: 0 });

// ---------------------------------------------------------------------------------------------
// Earning
// ---------------------------------------------------------------------------------------------

test('holding the band earns ten points a second before any multiplier is won', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), SCORE.MULT_STEP_S);
  near(st.earned.inBand, 10 * SCORE.MULT_STEP_S, 1e-9,
    'eight seconds at the opening rate is eighty points');
  assert.equal(st.mult, 2, 'the eighth second is what buys the second multiplier step');
  assert.equal(st.inBand, true);
});

test('the multiplier climbs one step every eight seconds and stops at four', () => {
  const st = createScoreState();
  const marks = [];
  for (let s = 0; s < 5; s += 1) {
    feed(st, RULES, onSp(), SCORE.MULT_STEP_S);
    marks.push(st.mult);
  }
  assert.deepEqual(marks, [2, 3, 4, 4, 4],
    'the multiplier must saturate — an unbounded combo makes the last mission the only one worth playing');
  assert.equal(st.peakMult, SCORE.MAX_MULT, 'the peak is kept for the badges to read');
});

test('the multiplier is applied to the points as they are earned, not retrospectively', () => {
  const st = createScoreState();
  // Sixteen seconds: eight at x1 (80) then eight at x2 (160).
  feed(st, RULES, onSp(), 2 * SCORE.MULT_STEP_S);
  near(st.earned.inBand, 80 + 160, 1e-9,
    'a combo won at second eight must not repay the eight seconds that earned it');
});

// ---------------------------------------------------------------------------------------------
// The grace window — the claim this engine exists to get right
// ---------------------------------------------------------------------------------------------

test('a crossing shorter than the grace window leaves the multiplier standing', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 3 * SCORE.MULT_STEP_S);
  assert.equal(st.mult, 4, 'set up: the combo is at its cap before the excursion');

  feed(st, RULES, off(1.4), SCORE.GRACE_S - DT);
  assert.equal(st.mult, 4,
    'half a second outside is measurement noise; killing the combo for it teaches the player to detune');
  assert.ok(st.holdTime_s > 0, 'the hold is frozen during the grace, not thrown away');
});

test('a full second continuously outside the band destroys the multiplier', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 3 * SCORE.MULT_STEP_S);
  assert.equal(st.mult, 4);

  feed(st, RULES, off(1.4), SCORE.GRACE_S);
  assert.equal(st.mult, 1,
    'at exactly the grace window the loop has genuinely lost the band and the combo goes');
  assert.equal(st.holdTime_s, 0, 'and the hold restarts from zero');
});

test('a loop chattering across the band edge keeps its combo for a whole minute', () => {
  // Three quarters of every second inside, a quarter outside: the signature of a well-tuned loop
  // on a noisy transmitter. It must reach the cap, because this is the loop the game is trying to
  // teach the player to build.
  const st = createScoreState();
  const dt = 0.25;
  for (let i = 0; i < 240; i += 1) {
    stepScore(st, RULES, (i % 4 === 3) ? off(1.1) : onSp(), dt);
  }
  assert.equal(st.mult, SCORE.MAX_MULT,
    'noise across the edge must not be able to hold the multiplier down');
});

test('the hold restarts after a real excursion, so the combo has to be earned again', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 3 * SCORE.MULT_STEP_S);
  feed(st, RULES, off(2), 4);
  assert.equal(st.mult, 1);
  feed(st, RULES, onSp(), SCORE.MULT_STEP_S - DT);
  assert.equal(st.mult, 1, 'seven and a half seconds back in the band is not yet eight');
  feed(st, RULES, onSp(), DT);
  assert.equal(st.mult, 2, 'eight is');
});

test('nothing is earned while the measurement is outside the band', () => {
  const st = createScoreState();
  feed(st, RULES, off(1.5), 10);
  assert.equal(st.earned.inBand, 0, 'the band is the whole game — outside it the meter stops');
  assert.ok(st.earned.outBand < 0);
  near(st.outBandTime_s, 10, 1e-9, 'ten seconds outside');
});

// ---------------------------------------------------------------------------------------------
// Penalties
// ---------------------------------------------------------------------------------------------

test('the deviation penalty is proportional to the error in band widths', () => {
  const st = createScoreState();
  feed(st, RULES, off(3), 2);
  near(st.earned.outBand, -2 * 3 * 2, 1e-9,
    'three band widths out costs six points a second, so two seconds costs twelve');
});

test('the deviation penalty is capped at thirty points a second however far out the loop goes', () => {
  const st = createScoreState();
  feed(st, RULES, off(1000), 2);
  near(st.earned.outBand, -SCORE.OUT_RATE_MAX * 2, 1e-9,
    'without the cap one wild excursion makes the rest of the shift pointless to play');
});

test('output travel is charged per percent moved, whichever way it moved', () => {
  const st = createScoreState();
  const n = 10;
  for (let i = 0; i < n; i += 1) {
    stepScore(st, RULES, { pv: 10, sp: 10, co: 50, dCo: (i % 2 ? -4 : 4) }, DT);
  }
  near(st.coTravel_pct, 40, 1e-9, 'ten scans of four percent is forty percent of travel');
  near(st.earned.thrash, -2, 1e-9, 'forty percent at 0.05 points a percent is two points');
});

test('output travel is derived from the output itself when the caller does not supply the delta', () => {
  const st = createScoreState();
  const co = [50, 55, 45, 45];
  for (const c of co) stepScore(st, RULES, { pv: 10, sp: 10, co: c }, DT);
  near(st.coTravel_pct, 15, 1e-9,
    'the first sample has nothing to difference against; after that it is 5 + 10 + 0');
});

test('an alarm is charged once when it is raised, not once every scan it stays up', () => {
  const st = createScoreState();
  feed(st, RULES, { ...onSp(), alarms: ['PT-101 HI'] }, 20);
  assert.equal(st.alarmCount, 1);
  near(st.earned.alarm, -SCORE.ALARM_PENALTY, 1e-9,
    'a latched alarm charged per second would end any shift that raised one');
});

test('an alarm that clears and comes back is a second failure and is charged again', () => {
  const st = createScoreState();
  feed(st, RULES, { ...onSp(), alarms: ['PT-101 HI'] }, 4);
  feed(st, RULES, { ...onSp(), alarms: [] }, 4);
  feed(st, RULES, { ...onSp(), alarms: [{ id: 'PT-101 HI' }] }, 4);
  assert.equal(st.alarmCount, 2, 'alarm records and bare ids are both accepted');
  near(st.earned.alarm, -2 * SCORE.ALARM_PENALTY, 1e-9, 'two raisings, two charges');
});

test('cavitation and minimum flow together are charged at one rate, not two', () => {
  const both = createScoreState();
  feed(both, RULES, { ...onSp(), cavitating: true, minFlow: true }, 3);
  const one = createScoreState();
  feed(one, RULES, { ...onSp(), cavitating: true }, 3);
  near(both.earned.hazard, -SCORE.HAZARD_RATE * 3, 1e-9, 'three seconds of damage is 120 points');
  assert.equal(both.earned.hazard, one.earned.hazard,
    'one hydraulic condition raises both flags on this rig; charging it twice is a double penalty');
  near(both.cavTime_s, 3, 1e-9, 'the two are still counted separately for the scorecard');
  near(both.minFlowTime_s, 3, 1e-9, 'both timers run');
});

// ---------------------------------------------------------------------------------------------
// The trip
// ---------------------------------------------------------------------------------------------

test('a trip fails the shift, and nothing scored after it can change the total', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 10);
  const before = st.score;
  stepScore(st, RULES, { ...onSp(), tripped: true }, DT);
  assert.equal(st.failed, true);
  assert.equal(st.tripped, true);
  assert.ok(st.score > before, 'the scan that tripped is still scored for what led to it');

  const after = st.score;
  const refusal = stepScore(st, RULES, onSp(), DT);
  assert.equal(refusal.ok, false, 'a scan after the shift ended is refused, not thrown on');
  assert.match(refusal.reason, /pump tripped/);
  assert.equal(st.score, after, 'and it changes nothing');
});

test('a failed shift takes no medal and no energy award however well it was going', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 60);
  stepScore(st, RULES, { ...onSp(), tripped: true }, DT);
  const res = finishScore(st, RULES, {
    energy_kWh: 1, parEnergy_kWh: 100, thresholds: { bronze: 10, silver: 20, gold: 30 },
  });
  assert.equal(res.failed, true);
  assert.equal(res.medal, 'none', 'a tripped machine is not a bronze performance');
  assert.equal(res.stats.energyBonus, 0,
    'there is no credit for being efficient right up to the trip');
  assert.ok(res.breakdown.some((l) => /FAILED/.test(l.label)),
    'the scorecard has to say why the shift ended');
});

// ---------------------------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------------------------

test('the breakdown adds up to the score exactly, on a shift that hit everything', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 30);
  feed(st, RULES, { ...off(2.5), dCo: 3, alarms: ['FT-101 LO'] }, 6);
  feed(st, RULES, { ...onSp(), cavitating: true, dCo: 1.7 }, 4);
  scoreEvent(st, 'award', 75, 'Upset ridden out');
  scoreEvent(st, 'award', 75, 'Upset ridden out');
  scoreEvent(st, 'penalty', -20, 'Late on the surge');
  feed(st, RULES, onSp(), 25);

  const res = finishScore(st, RULES, {
    energy_kWh: 9, parEnergy_kWh: 10, duration_s: 65, thresholds: { bronze: 100, silver: 400, gold: 900 },
  });
  const sum = res.breakdown.reduce((a, l) => a + l.points, 0);
  assert.equal(sum, res.score,
    'a scorecard whose lines do not sum to its total is the fastest way to lose a player');
  for (const l of res.breakdown) {
    assert.ok(Number.isInteger(l.points), `every line is a whole number of points: ${l.label}`);
  }
  assert.ok(res.breakdown.some((l) => /Upset ridden out x2/.test(l.label)),
    'repeated awards are grouped into one line with a count');
  assert.equal(res.medal, medalFor(res.score, { bronze: 100, silver: 400, gold: 900 }));
  assert.equal(res.stats.duration_s, 65, 'the mission length is reported, not the time scored');
});

test('a shift with no samples at all scores zero and still reports a scorecard that sums', () => {
  const st = createScoreState();
  const res = finishScore(st, RULES, { thresholds: { bronze: 100, silver: 400, gold: 900 } });
  assert.equal(res.score, 0);
  assert.equal(res.medal, 'none');
  assert.equal(res.failed, false);
  assert.ok(res.breakdown.length >= 1, 'an empty scorecard reads as a bug, so one line always shows');
  assert.equal(res.breakdown.reduce((a, l) => a + l.points, 0), res.score);
  assert.equal(res.stats.inBandFraction, 0, 'no divide by a zero-length shift');
  assert.equal(res.stats.samples, 0);
});

test('the energy award is clamped at five hundred points however far under par the shift came', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 10);
  const res = finishScore(st, RULES, { energy_kWh: 1, parEnergy_kWh: 1000 });
  assert.equal(res.stats.energyBonus, SCORE.ENERGY_BONUS_MAX,
    'a thousandfold energy ratio is a broken mission par, not a thousand-point windfall');
});

test('the energy award never falls below minus five hundred however badly the shift overspent', () => {
  // The formula 500*(par/actual - 1) approaches -500 asymptotically and cannot cross it while both
  // figures are positive, so the lower clamp is a guard against a nonsense par rather than a case
  // the arithmetic reaches. Both facts are asserted, because a change to the formula that made the
  // floor reachable must not pass silently.
  const st = createScoreState();
  feed(st, RULES, onSp(), 10);
  const res = finishScore(st, RULES, { energy_kWh: 1000, parEnergy_kWh: 1e-6 });
  assert.ok(res.stats.energyBonus >= -SCORE.ENERGY_BONUS_MAX,
    'the award must never go past the clamp');
  assert.equal(res.breakdown.find((l) => /Energy/.test(l.label)).points, -SCORE.ENERGY_BONUS_MAX,
    'a gross overspend shows the full penalty on the card');
});

test('a shift with no energy figures is graded without an energy line', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 10);
  const res = finishScore(st, RULES, {});
  assert.equal(res.stats.energyBonus, 0);
  assert.ok(Number.isNaN(res.stats.energyRatio), 'no data is reported as no data, not as par');
  assert.ok(!res.breakdown.some((l) => /Energy/.test(l.label)),
    'a zero line for a metric that was never measured is noise on the card');
  assert.equal(res.breakdown.reduce((a, l) => a + l.points, 0), res.score);
});

test('medalFor awards the highest threshold the score reaches, and nothing without thresholds', () => {
  const th = { bronze: 100, silver: 400, gold: 900 };
  assert.equal(medalFor(99, th), 'none');
  assert.equal(medalFor(100, th), 'bronze', 'the threshold itself counts as reached');
  assert.equal(medalFor(899, th), 'silver');
  assert.equal(medalFor(90000, th), 'gold');
  assert.equal(medalFor(500, null), 'none', 'a mission with no thresholds awards no medal');
  assert.equal(medalFor(NaN, th), 'none');
});

test('the statistics a badge would check survive the shift', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 40);
  feed(st, RULES, off(3), 5);
  const res = finishScore(st, RULES, { energy_kWh: 8, parEnergy_kWh: 10 });
  near(res.stats.inBandFraction, 40 / 45, 1e-9, 'forty seconds in band out of forty-five');
  near(res.stats.bestHold_s, 40, 1e-9, 'the longest unbroken hold');
  near(res.stats.iae, 3 * RULES.band * 5, 1e-9, 'three band widths of error for five seconds');
  near(res.stats.maxAbsErr, 3, 1e-9);
  assert.equal(res.stats.peakMult, 4);
  near(res.stats.energyRatio, 10 / 8, 1e-9, 'par over actual: above one means under budget');
});

// ---------------------------------------------------------------------------------------------
// Pops
// ---------------------------------------------------------------------------------------------

test('an awarded event queues a pop, and taking the pops empties the queue', () => {
  const st = createScoreState();
  scoreEvent(st, 'award', 250, 'Fault called correctly');
  const pops = takePops(st);
  assert.equal(pops.length, 1);
  assert.equal(pops[0].amount, 250);
  assert.equal(pops[0].label, 'Fault called correctly');
  assert.equal(pops[0].kind, 'award');
  assert.ok(Number.isInteger(pops[0].id), 'pops carry an id so the HUD can key on them');
  assert.deepEqual(takePops(st), [], 'the queue is drained by the taking');
  near(st.score, 250, 1e-9);
});

test('the pop queue is bounded, so a run nobody is watching cannot grow one forever', () => {
  const st = createScoreState();
  for (let i = 0; i < SCORE.MAX_POPS * 3; i += 1) scoreEvent(st, 'award', 1, `n${i}`);
  const pops = takePops(st);
  assert.equal(pops.length, SCORE.MAX_POPS);
  assert.equal(pops[pops.length - 1].label, `n${SCORE.MAX_POPS * 3 - 1}`,
    'the newest pop is the one kept — it is the one the player wants explained');
  near(st.score, SCORE.MAX_POPS * 3, 1e-9, 'dropping a pop must never drop its points');
});

test('winning and losing a multiplier both announce themselves', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), SCORE.MULT_STEP_S);
  feed(st, RULES, off(2), 2);
  const labels = takePops(st).map((p) => p.label);
  assert.ok(labels.includes('x2'), 'the combo announces itself when it is won');
  assert.ok(labels.includes('x2 LOST'), 'and when it is lost');
});

// ---------------------------------------------------------------------------------------------
// Nonsense in
// ---------------------------------------------------------------------------------------------

test('a scan period of zero changes nothing and is not an error', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 10);
  const snapshot = { score: st.score, elapsed: st.elapsed_s, samples: st.samples };
  const r = stepScore(st, RULES, { ...onSp(), dCo: 9, alarms: ['X'], cavitating: true }, 0);
  assert.equal(r, undefined, 'a paused simulator still ticks; that is not a bad call');
  assert.equal(st.score, snapshot.score, 'a paused game must not be farmable');
  assert.equal(st.elapsed_s, snapshot.elapsed);
  assert.equal(st.samples, snapshot.samples);
  assert.equal(st.alarmCount, 0, 'and no rising edge is taken for no elapsed time');
});

test('a non-numeric measurement is refused rather than poisoning the total', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 5);
  const before = st.score;
  for (const bad of [{ pv: NaN, sp: 10 }, { pv: 10, sp: NaN }, { pv: Infinity, sp: 10 }]) {
    const r = stepScore(st, RULES, bad, DT);
    assert.equal(r.ok, false, `a ${bad.pv}/${bad.sp} sample must be refused`);
    assert.match(r.reason, /not a number/);
  }
  assert.equal(st.score, before, 'a NaN reaching the total makes every later comparison false');
  assert.ok(Number.isFinite(st.score));
});

test('a bad state, a missing sample and a negative scan period are all refused', () => {
  assert.equal(stepScore(null, RULES, onSp(), DT).ok, false);
  assert.equal(stepScore({}, RULES, onSp(), DT).ok, false);
  const st = createScoreState();
  assert.equal(stepScore(st, RULES, null, DT).ok, false);
  assert.equal(stepScore(st, RULES, onSp(), -1).ok, false);
  assert.equal(stepScore(st, RULES, onSp(), NaN).ok, false);
  assert.equal(scoreEvent(st, 'award', NaN, 'nonsense').ok, false);
  assert.equal(finishScore(null, RULES, {}).ok, false);
  assert.deepEqual(takePops(null), []);
  assert.equal(st.score, 0, 'none of that touched the score');
});

test('a mission that states no rules is scored on the defaults instead of scoring nothing', () => {
  const st = createScoreState();
  // A NaN band would make every comparison false and silently mark the whole shift in band.
  feed(st, { band: NaN }, { pv: 10, sp: 10 }, 4);
  near(st.earned.inBand, 40, 1e-9, 'the default band still earns at the default rate');
  const out = createScoreState();
  feed(out, undefined, { pv: 10 + SCORE.DEFAULT_BAND * 4, sp: 10 }, 2);
  assert.ok(out.earned.outBand < 0, 'and still charges for being outside it');
  assert.equal(out.earned.inBand, 0);
});

test('a shift cannot be added to once it has been graded', () => {
  const st = createScoreState();
  feed(st, RULES, onSp(), 10);
  const res = finishScore(st, RULES, {});
  assert.equal(stepScore(st, RULES, onSp(), DT).ok, false, 'a published result is final');
  assert.equal(scoreEvent(st, 'award', 100, 'too late').ok, false);
  assert.equal(finishScore(st, RULES, {}).score, res.score, 'and grading again gives the same card');
});
