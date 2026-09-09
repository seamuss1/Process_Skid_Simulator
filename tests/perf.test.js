/**
 * tests/perf.test.js — the frame-budget manager.
 *
 * The module is pure and clock-injected, so every clock here is a plain number that the test
 * advances by hand and every expectation is worked out in the comment above it rather than
 * recorded from a previous run. A budget change that was not intended therefore fails a test that
 * says what the old behaviour MEANT, instead of quietly rewriting a golden value.
 *
 * Four claims are asserted hardest, because they are the ones the simulator's correctness rests
 * on: physics is never skipped at any overrun, eviction happens in the documented order and stops
 * as soon as the frame fits, the weighted average is the average it says it is, and a
 * backgrounded tab is not mistaken for a slow machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERF, STAGE, STAGES, EVICTION_ORDER, QUALITY, QUALITY_ORDER, QUALITY_HINTS, FRAME,
  createPerf, configure, setQuality, classifyFrame, beginFrame, endFrame, stageStart, stageEnd,
  noteStage, shouldRun, accountTime, qualityHints, worstFrameMs, deficitNote, report, resetPerf,
} from '../src/core/perf.js';

/**
 * Assert two numbers agree to an absolute tolerance, with a message showing both.
 *
 * Spelled out here rather than taken from `tests/helpers.js`: that module builds a whole
 * simulator to make its fixtures, and this one is arithmetic that must be testable without one.
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

/** A budget that makes the arithmetic in these tests readable. */
const BUDGET = 16;

/**
 * Give every stage a known cost by seeding one sample each, so `ewma` equals the number given.
 * @param {object} perf the perf state
 * @param {object} costs stage id -> cost in ms
 * @returns {void}
 */
function seedCosts(perf, costs) {
  for (const id of Object.keys(costs)) noteStage(perf, id, costs[id]);
}

/**
 * Run one frame that costs nothing, so the frame index and the gap advance.
 * @param {object} perf the perf state
 * @param {number} beginMs the frame timestamp
 * @param {number} workMs how long the frame takes
 * @param {boolean} [hidden] the visibility flag to pass in
 * @returns {object} the plan for that frame
 */
function frame(perf, beginMs, workMs, hidden) {
  const plan = beginFrame(perf, beginMs, hidden);
  endFrame(perf, beginMs + workMs);
  return plan;
}

// ================================================================================================
// The tables themselves
// ================================================================================================

test('physics and the controller are the only essential stages, and they lead the order', () => {
  assert.equal(STAGES[0].id, STAGE.PHYSICS);
  assert.equal(STAGES[1].id, STAGE.CONTROL);
  const essential = STAGES.filter((s) => s.essential).map((s) => s.id);
  assert.deepEqual(essential, [STAGE.PHYSICS, STAGE.CONTROL]);
});

test('the eviction order is least-consequential first and excludes the essentials', () => {
  assert.deepEqual(EVICTION_ORDER, [
    STAGE.DECORATION, STAGE.ANALYSIS, STAGE.TREND, STAGE.VIEW, STAGE.GAME, STAGE.LADDER,
  ]);
  assert.ok(!EVICTION_ORDER.includes(STAGE.PHYSICS), 'physics must never be evictable');
  assert.ok(!EVICTION_ORDER.includes(STAGE.CONTROL), 'the controller must never be evictable');
});

test('the quality tables are frozen and monotonically cheaper', () => {
  assert.ok(Object.isFrozen(QUALITY_HINTS));
  let prev = Infinity;
  let prevDec = 0;
  for (const level of QUALITY_ORDER) {
    const h = QUALITY_HINTS[level];
    assert.ok(Object.isFrozen(h), `${level} hints must be frozen`);
    assert.ok(h.particles <= prev, `${level} must not ask for more particles than the level above`);
    assert.ok(h.trendDecimation >= prevDec, `${level} must not draw more trend points`);
    prev = h.particles;
    prevDec = h.trendDecimation;
  }
  assert.equal(QUALITY_HINTS[QUALITY.MINIMAL].particles, 0);
  assert.equal(QUALITY_HINTS[QUALITY.MINIMAL].gaugeSmoothing, 0,
    'at minimal quality a needle must snap, not be animated over frames we cannot draw');
});

// ================================================================================================
// The weighted average, against hand-computed values
// ================================================================================================

test('the first cost sample seeds the average instead of blending toward zero', () => {
  const perf = createPerf({ alpha: 0.25 });
  noteStage(perf, STAGE.VIEW, 30);
  assert.equal(perf.stages[STAGE.VIEW].ewma, 30,
    'a 30 ms view must be believed the first time, or the scheduler under-budgets for four frames');
});

test('the weighted average matches the hand-computed series at alpha = 1/4', () => {
  // e0 = 10                      (the seed)
  // e1 = 10   + 0.25*(20 - 10)   = 12.5
  // e2 = 12.5 + 0.25*(20 - 12.5) = 14.375
  // e3 = 14.375 + 0.25*(20 - 14.375) = 15.78125
  // Every value is exact in binary floating point, so these are equalities, not tolerances.
  const perf = createPerf({ alpha: 0.25 });
  const seen = [];
  for (const x of [10, 20, 20, 20]) {
    noteStage(perf, STAGE.ANALYSIS, x);
    seen.push(perf.stages[STAGE.ANALYSIS].ewma);
  }
  assert.deepEqual(seen, [10, 12.5, 14.375, 15.78125]);
});

test('a different alpha gives the different hand-computed series', () => {
  // alpha = 0.5:  8 -> 8 + 0.5*(0-8) = 4 -> 4 + 0.5*(0-4) = 2
  const perf = createPerf({ alpha: 0.5 });
  noteStage(perf, STAGE.TREND, 8);
  noteStage(perf, STAGE.TREND, 0);
  noteStage(perf, STAGE.TREND, 0);
  assert.equal(perf.stages[STAGE.TREND].ewma, 2);
});

test('the remembered peak decays but never below the last spike', () => {
  const perf = createPerf({ alpha: 0.25 });
  noteStage(perf, STAGE.VIEW, 40);
  assert.equal(perf.stages[STAGE.VIEW].peakMs, 40);
  // peak = max(1, 40 * 0.97) = 38.8
  noteStage(perf, STAGE.VIEW, 1);
  near(perf.stages[STAGE.VIEW].peakMs, 40 * PERF.PEAK_DECAY, 1e-9, 'peak after one decay');
});

test('stageStart and stageEnd measure the interval between the clocks they are handed', () => {
  const perf = createPerf();
  stageStart(perf, STAGE.LADDER, 1000);
  stageEnd(perf, STAGE.LADDER, 1003.5);
  assert.equal(perf.stages[STAGE.LADDER].lastMs, 3.5);
  assert.equal(perf.stages[STAGE.LADDER].ewma, 3.5);
  // An end without a start is ignored rather than recording a nonsense interval from -1.
  stageEnd(perf, STAGE.LADDER, 9999);
  assert.equal(perf.stages[STAGE.LADDER].lastMs, 3.5);
});

test('an unknown stage id is ignored rather than inventing a stage', () => {
  const perf = createPerf();
  noteStage(perf, 'sprinkles', 100);
  assert.equal(perf.stages.sprinkles, undefined);
  assert.equal(shouldRun(perf, 'sprinkles'), true,
    'a stage the manager has never heard of must not be silently disabled');
});

// ================================================================================================
// Eviction priority under a squeezed budget
// ================================================================================================

test('a squeezed budget evicts in order and stops as soon as the frame fits', () => {
  // Costs sum to 32 ms against a 16 ms budget.
  //   physics 8, control 2, ladder 2, game 2, view 6, trend 3, analysis 5, decoration 4
  // Evicting in order: 32 -4=28 (decoration), -5=23 (analysis), -3=20 (trend), -6=14 (view).
  // 14 <= 16, so the loop stops: the game session and the ladder both survive.
  const perf = createPerf({ budgetMs: BUDGET });
  seedCosts(perf, {
    [STAGE.PHYSICS]: 8,
    [STAGE.CONTROL]: 2,
    [STAGE.LADDER]: 2,
    [STAGE.GAME]: 2,
    [STAGE.VIEW]: 6,
    [STAGE.TREND]: 3,
    [STAGE.ANALYSIS]: 5,
    [STAGE.DECORATION]: 4,
  });

  const plan = beginFrame(perf, 0);
  assert.deepEqual(plan.skipped, [STAGE.DECORATION, STAGE.ANALYSIS, STAGE.TREND, STAGE.VIEW]);
  near(plan.demandMs, 32, 1e-9, 'demand');
  near(plan.projectedMs, 14, 1e-9, 'projection after eviction');
  assert.equal(plan.overMs, 0, 'the survivors fit, so nothing is reported over budget');
  assert.equal(plan.degraded, true);
  assert.equal(shouldRun(perf, STAGE.GAME), true, 'the session survives — eviction stopped early');
  assert.equal(shouldRun(perf, STAGE.LADDER), true, 'the ladder is the last thing dropped');
  assert.equal(shouldRun(perf, STAGE.VIEW), false);
});

test('a frame that already fits skips nothing', () => {
  const perf = createPerf({ budgetMs: BUDGET });
  seedCosts(perf, {
    [STAGE.PHYSICS]: 4, [STAGE.CONTROL]: 1, [STAGE.VIEW]: 3, [STAGE.DECORATION]: 2,
  });
  const plan = beginFrame(perf, 0);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.degraded, false);
  for (const s of STAGES) assert.equal(shouldRun(perf, s.id), true, `${s.id} must run`);
});

test('every skipped stage carries the reason it was skipped', () => {
  const perf = createPerf({ budgetMs: 2 });
  seedCosts(perf, { [STAGE.PHYSICS]: 1, [STAGE.DECORATION]: 9 });
  const plan = beginFrame(perf, 0);
  assert.deepEqual(plan.skipped, [STAGE.DECORATION]);
  assert.match(plan.reasons[STAGE.DECORATION], /cosmetic/,
    'the scheduler must say why, not degrade silently');
  const r = report(perf);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].label, 'decoration');
  assert.match(r.line, /skipping decoration/);
});

test('a stage that has never cost anything is not named in the skip list', () => {
  // Only physics and the view have ever run. Dropping "analysis" here would tell the operator we
  // discarded something the frame never contained.
  const perf = createPerf({ budgetMs: 4 });
  seedCosts(perf, { [STAGE.PHYSICS]: 10, [STAGE.VIEW]: 5 });
  const plan = beginFrame(perf, 0);
  assert.deepEqual(plan.skipped, [STAGE.VIEW]);
});

test('a stage skipped MAX_SKIPS frames running is forced back in', () => {
  // A permanently over-budget frame: the trend would otherwise never repaint again, which is
  // indistinguishable from a frozen application.
  const perf = createPerf({ budgetMs: 4, maxSkips: 3 });
  seedCosts(perf, { [STAGE.PHYSICS]: 10, [STAGE.TREND]: 5 });

  let t = 0;
  for (let i = 0; i < 3; i += 1) {
    const plan = frame(perf, t, 1);
    assert.deepEqual(plan.skipped, [STAGE.TREND], `frame ${i} should still be skipping the trend`);
    t += 16;
  }
  const forced = frame(perf, t, 1);
  assert.deepEqual(forced.skipped, [], 'after three skips the trend must be let through');
  near(forced.overMs, 11, 1e-9, 'and the frame says how far over budget that puts it');
  assert.equal(perf.stages[STAGE.TREND].consecutiveSkips, 0);
});

// ================================================================================================
// Physics is never skipped
// ================================================================================================

test('physics and the controller run however far over budget the frame goes', () => {
  // A pathological frame: the plant integration alone is sixty times the budget.
  const perf = createPerf({ budgetMs: BUDGET });
  seedCosts(perf, {
    [STAGE.PHYSICS]: 1000,
    [STAGE.CONTROL]: 40,
    [STAGE.LADDER]: 10,
    [STAGE.GAME]: 10,
    [STAGE.VIEW]: 10,
    [STAGE.TREND]: 10,
    [STAGE.ANALYSIS]: 10,
    [STAGE.DECORATION]: 10,
  });

  const plan = beginFrame(perf, 0);
  assert.equal(shouldRun(perf, STAGE.PHYSICS), true, 'skipping physics would stop time');
  assert.equal(shouldRun(perf, STAGE.CONTROL), true, 'skipping the controller would open the loop');
  assert.equal(plan.runs[STAGE.PHYSICS], true);
  assert.equal(plan.runs[STAGE.CONTROL], true);
  for (const id of EVICTION_ORDER) {
    assert.equal(plan.runs[id], false, `${id} should have been evicted`);
  }
  // 1000 + 40 survive against a 16 ms budget, and the plan SAYS the frame will overrun by 1024 ms
  // rather than pretending it fits.
  near(plan.projectedMs, 1040, 1e-9, 'projection with only the essentials left');
  near(plan.overMs, 1024, 1e-9, 'stated overrun');
});

test('physics survives even when it is the only stage with a cost', () => {
  const perf = createPerf({ budgetMs: 1 });
  seedCosts(perf, { [STAGE.PHYSICS]: 500 });
  const plan = beginFrame(perf, 0);
  assert.equal(plan.runs[STAGE.PHYSICS], true);
  assert.deepEqual(plan.skipped, []);
  near(plan.overMs, 499, 1e-9, 'overrun with nothing left to drop');
});

test('no sequence of over-budget frames ever unsets physics or the controller', () => {
  const perf = createPerf({ budgetMs: 1, maxSkips: 2 });
  seedCosts(perf, {
    [STAGE.PHYSICS]: 90, [STAGE.CONTROL]: 30, [STAGE.VIEW]: 20, [STAGE.DECORATION]: 20,
  });
  let t = 0;
  for (let i = 0; i < 200; i += 1) {
    const plan = frame(perf, t, 140);
    assert.equal(plan.runs[STAGE.PHYSICS], true, `frame ${i} skipped physics`);
    assert.equal(plan.runs[STAGE.CONTROL], true, `frame ${i} skipped the controller`);
    t += 150;
  }
});

// ================================================================================================
// A slow machine versus a backgrounded tab
// ================================================================================================

test('classifyFrame separates a slow machine from a tab that was not running', () => {
  const b = BUDGET;
  const g = PERF.STALL_GAP_MS;
  // Normal frames.
  assert.equal(classifyFrame(16, 15, b, g), FRAME.OK);
  // A short but laboured frame: over the budget, nowhere near a stall.
  assert.equal(classifyFrame(40, 38, b, g), FRAME.SLOW);
  // A long gap we can account for: the machine spent it.
  assert.equal(classifyFrame(400, 380, b, g), FRAME.SLOW);
  // A long gap we cannot: the tab was descheduled.
  assert.equal(classifyFrame(1200, 2, b, g), FRAME.STALL);
  // Exactly at the accounting threshold, the machine gets the benefit of the doubt: half a
  // receipt is enough to own the gap, because calling a slow machine a stall stops it degrading.
  assert.equal(classifyFrame(1000, 500, b, g), FRAME.SLOW);
  assert.equal(classifyFrame(1000, 499, b, g), FRAME.STALL);
  // Being told beats any arithmetic.
  assert.equal(classifyFrame(16, 15, b, g, true), FRAME.STALL);
});

test('a backgrounded tab does not degrade quality; a slow machine does', () => {
  // The tab: sixty normal frames, then a one-second gap in which we did two milliseconds of work.
  const tab = createPerf({ budgetMs: BUDGET });
  seedCosts(tab, { [STAGE.PHYSICS]: 4, [STAGE.VIEW]: 4 });
  let t = 0;
  for (let i = 0; i < 60; i += 1) { frame(tab, t, 8); t += 16; }
  assert.equal(tab.quality, QUALITY.FULL);
  // The alt-tab itself, which the test described but never performed: without this the next
  // beginFrame sees an ordinary 16 ms gap and is classified OK, so the assertion below was
  // checking that a normal frame is normal.
  t += 1000;
  for (let i = 0; i < 10; i += 1) {
    const plan = beginFrame(tab, t, false);
    assert.equal(tab.frame.kind, i === 0 ? FRAME.STALL : FRAME.OK,
      'the frame after the gap is the stall; the ones after it are normal again');
    endFrame(tab, t + 2);
    t += (i === 0 ? 16 : 16);
    assert.equal(plan.quality, QUALITY.FULL);
  }
  assert.equal(tab.quality, QUALITY.FULL, 'one alt-tab must not cost the operator any quality');
  assert.ok(tab.stall.count >= 1, 'but the stall is counted');

  // Now the same shape of gap on a machine that actually spent it.
  const slow = createPerf({ budgetMs: BUDGET });
  seedCosts(slow, { [STAGE.PHYSICS]: 20, [STAGE.VIEW]: 20 });
  let s = 0;
  for (let i = 0; i < 10; i += 1) { frame(slow, s, 40); s += 45; }
  assert.notEqual(slow.quality, QUALITY.FULL, 'a machine that cannot keep up must lose quality');
  assert.ok(slow.slowFrames > 0, 'and the slow frames are counted as such');
  assert.equal(slow.stall.count, 0, 'and none of them are called stalls');
});

test('the stall gap is kept out of the frame-rate average', () => {
  // Sixteen-millisecond frames, then one one-second gap. Reporting 2 fps for the next half minute
  // over a single tab switch is exactly the misreport this exclusion prevents.
  const perf = createPerf({ budgetMs: BUDGET });
  seedCosts(perf, { [STAGE.PHYSICS]: 4 });
  let t = 0;
  for (let i = 0; i < 40; i += 1) { frame(perf, t, 6); t += 16; }
  const before = report(perf).fps;
  near(before, 62.5, 0.5, 'fps on 16 ms frames');
  t += 1000;
  frame(perf, t, 2);
  near(report(perf).fps, before, 0.5, 'fps after a stall');
});

test('quality steps down after DEGRADE_FRAMES and back up only after RECOVER_FRAMES', () => {
  const perf = createPerf({ budgetMs: BUDGET });
  seedCosts(perf, { [STAGE.PHYSICS]: 30 });
  let t = 0;
  for (let i = 0; i < PERF.DEGRADE_FRAMES; i += 1) { frame(perf, t, 30); t += 34; }
  assert.equal(perf.quality, QUALITY.REDUCED);
  for (let i = 0; i < PERF.DEGRADE_FRAMES; i += 1) { frame(perf, t, 30); t += 34; }
  assert.equal(perf.quality, QUALITY.MINIMAL);
  // It cannot go below the last level however long it stays over budget.
  for (let i = 0; i < 100; i += 1) { frame(perf, t, 30); t += 34; }
  assert.equal(perf.quality, QUALITY.MINIMAL);

  // Now comfortable frames. Recovery is deliberately far slower than degradation.
  resetPerf(perf);
  seedCosts(perf, { [STAGE.PHYSICS]: 30 });
  for (let i = 0; i < PERF.DEGRADE_FRAMES; i += 1) { frame(perf, t, 30); t += 34; }
  assert.equal(perf.quality, QUALITY.REDUCED);
  perf.stages[STAGE.PHYSICS].ewma = 2;
  for (let i = 0; i < PERF.RECOVER_FRAMES - 1; i += 1) { frame(perf, t, 2); t += 16; }
  assert.equal(perf.quality, QUALITY.REDUCED, 'one frame short of recovery must not recover');
  frame(perf, t, 2);
  assert.equal(perf.quality, QUALITY.FULL);
});

test('a pinned quality level ignores the frame time entirely', () => {
  const perf = createPerf({ budgetMs: BUDGET });
  assert.deepEqual(setQuality(perf, QUALITY.FULL), { ok: true });
  seedCosts(perf, { [STAGE.PHYSICS]: 300 });
  let t = 0;
  for (let i = 0; i < 50; i += 1) { frame(perf, t, 300); t += 320; }
  assert.equal(perf.quality, QUALITY.FULL);
  assert.equal(qualityHints(perf).particles, QUALITY_HINTS[QUALITY.FULL].particles);
  assert.deepEqual(setQuality(perf, null), { ok: true });
  for (let i = 0; i < 5; i += 1) { frame(perf, t, 300); t += 320; }
  assert.notEqual(perf.quality, QUALITY.FULL, 'unpinning must let it adapt again');
});

test('setQuality refuses a level that does not exist, and says so', () => {
  const perf = createPerf();
  const res = setQuality(perf, 'ultra');
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown quality level 'ultra'/);
  assert.equal(perf.quality, QUALITY.FULL, 'a refusal must not have changed anything');
});

// ================================================================================================
// Deficit accounting
// ================================================================================================

test('a shortfall opens an episode and reports by how much and for how long', () => {
  // Ten frames, each asking for 0.5 s of simulation and integrating 0.2 s: 0.3 s lost per frame.
  const perf = createPerf({ budgetMs: BUDGET });
  let t = 0;
  for (let i = 0; i < 10; i += 1) {
    beginFrame(perf, t);
    accountTime(perf, 0.5, 0.2);
    endFrame(perf, t + 20);
    t += 100;
  }
  const d = perf.deficit;
  assert.equal(d.behind, true);
  near(d.dropped_s, 3.0, 1e-9, 'simulated seconds never integrated');
  near(d.requested_s, 5.0, 1e-9, 'simulated seconds asked for');
  // The episode opened at t = 0 and the tenth frame began at t = 900.
  near(d.forMs, 900, 1e-9, 'how long the rig has been behind');
  assert.equal(d.episodes, 1);
  near(d.worstRatio, 0.6, 1e-9, 'worst single-frame shortfall as a fraction of the request');
  assert.match(deficitNote(perf), /behind by 3\.0 s of simulation over 0\.9 s of wall clock \(60%/);
});

test('the episode closes only after a run of on-time frames, not on the first one', () => {
  const perf = createPerf({ budgetMs: BUDGET });
  let t = 0;
  beginFrame(perf, t); accountTime(perf, 0.5, 0.2); endFrame(perf, t + 5); t += 16;
  assert.equal(perf.deficit.behind, true);
  for (let i = 0; i < PERF.CLEAR_FRAMES - 1; i += 1) {
    beginFrame(perf, t); accountTime(perf, 0.016, 0.016); endFrame(perf, t + 5); t += 16;
  }
  assert.equal(perf.deficit.behind, true, 'one good frame is not recovery');
  beginFrame(perf, t); accountTime(perf, 0.016, 0.016); endFrame(perf, t + 5);
  assert.equal(perf.deficit.behind, false);
  assert.equal(perf.deficit.episodes, 1);
  assert.match(deficitNote(perf), /on time — 0\.3 s lost over 1 earlier spell/);
});

test('time lost while the tab was not running is a stall, not a deficit', () => {
  // This is the discrimination doing real work: the same shortfall, classified two ways.
  const perf = createPerf({ budgetMs: BUDGET });
  seedCosts(perf, { [STAGE.PHYSICS]: 4 });
  let t = 0;
  for (let i = 0; i < 5; i += 1) { frame(perf, t, 5); t += 16; }

  // A one-second gap in which we did nothing: the next frame is a stall.
  t += 1000;
  beginFrame(perf, t);
  assert.equal(perf.frame.kind, FRAME.STALL);
  accountTime(perf, 1.0, 0.016);
  endFrame(perf, t + 5);

  assert.equal(perf.deficit.behind, false, 'a hidden tab is not a machine that cannot keep up');
  assert.equal(perf.deficit.episodes, 0);
  near(perf.stall.dropped_s, 0.984, 1e-9, 'the discarded time is counted, just not as a deficit');
  assert.match(report(perf).line, /1 stall/);
  assert.match(report(perf).line, /on time/);
});

test('an exactly-met request is not a deficit', () => {
  const perf = createPerf();
  beginFrame(perf, 0);
  accountTime(perf, 0.02, 0.02);
  endFrame(perf, 5);
  assert.equal(perf.deficit.behind, false);
  assert.equal(deficitNote(perf), 'on time');
});

test('a second spell of falling behind is counted as a second episode', () => {
  const perf = createPerf();
  let t = 0;
  /**
   * Run one accounted frame.
   * @param {number} want simulated seconds requested
   * @param {number} got simulated seconds integrated
   * @returns {void}
   */
  const run = (want, got) => {
    beginFrame(perf, t);
    accountTime(perf, want, got);
    endFrame(perf, t + 4);
    t += 16;
  };
  run(0.5, 0.1);
  for (let i = 0; i < PERF.CLEAR_FRAMES; i += 1) run(0.016, 0.016);
  assert.equal(perf.deficit.behind, false);
  run(0.5, 0.1);
  assert.equal(perf.deficit.behind, true);
  assert.equal(perf.deficit.episodes, 2);
  near(perf.deficit.totalDropped_s, 0.8, 1e-9, 'the session total spans both episodes');
  near(perf.deficit.dropped_s, 0.4, 1e-9, 'the episode figure covers only this spell');
});

// ================================================================================================
// The rolling report
// ================================================================================================

test('the rolling window reports the worst frame in it and forgets older ones', () => {
  const perf = createPerf({ budgetMs: BUDGET });
  let t = 0;
  frame(perf, t, 90); t += 100;
  for (let i = 0; i < 10; i += 1) { frame(perf, t, 5); t += 16; }
  near(worstFrameMs(perf), 90, 1e-9, 'the spike is still in the window');
  for (let i = 0; i < PERF.WINDOW; i += 1) { frame(perf, t, 5); t += 16; }
  near(worstFrameMs(perf), 5, 1e-9, 'and has aged out of it');
});

test('the report line names the frame rate, the quality and the deficit', () => {
  const perf = createPerf({ budgetMs: BUDGET });
  seedCosts(perf, { [STAGE.PHYSICS]: 6, [STAGE.VIEW]: 4 });
  let t = 0;
  for (let i = 0; i < 20; i += 1) { frame(perf, t, 10); t += 16; }
  const r = report(perf);
  assert.match(r.line, /fps/);
  assert.match(r.line, /ms\/frame/);
  assert.match(r.line, /full quality/);
  assert.match(r.line, /on time/);
  near(r.frameMs, 10, 1e-6, 'every frame took ten milliseconds');
  assert.equal(r.stages.length, STAGES.length);
  assert.equal(r.hints, QUALITY_HINTS[QUALITY.FULL]);
});

// ================================================================================================
// Configuration and reset
// ================================================================================================

test('configure validates and refuses with the reason', () => {
  const perf = createPerf();
  assert.deepEqual(configure(perf, { budgetMs: 8 }), { ok: true });
  assert.equal(perf.budgetMs, 8);

  const bad = configure(perf, { budgetMs: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /between 1 and 10000 ms/);
  assert.equal(perf.budgetMs, 8, 'a refusal must leave the setting alone');

  assert.equal(configure(perf, { alpha: 0 }).ok, false);
  assert.equal(configure(perf, { alpha: 1 }).ok, true);
  assert.equal(configure(perf, { stallGapMs: 5 }).ok, false);
  assert.equal(configure(perf, { maxSkips: 0 }).ok, false);
  assert.equal(configure(perf, null).ok, false);
  assert.equal(configure(null, { budgetMs: 8 }).ok, false);
});

test('resetPerf forgets the measurements but keeps the configuration and the pin', () => {
  const perf = createPerf({ budgetMs: 8 });
  setQuality(perf, QUALITY.MINIMAL);
  seedCosts(perf, { [STAGE.PHYSICS]: 40, [STAGE.VIEW]: 40 });
  let t = 0;
  for (let i = 0; i < 5; i += 1) { frame(perf, t, 80); t += 90; }
  beginFrame(perf, t);
  accountTime(perf, 1, 0.1);
  endFrame(perf, t + 80);

  assert.deepEqual(resetPerf(perf), { ok: true });
  assert.equal(perf.budgetMs, 8, 'the budget is configuration, not a measurement');
  assert.equal(perf.quality, QUALITY.MINIMAL, 'a pinned level survives a reset');
  assert.equal(perf.stages[STAGE.VIEW].ewma, 0);
  assert.equal(perf.deficit.behind, false);
  assert.equal(perf.deficit.episodes, 0);
  assert.equal(perf.stall.count, 0);
  assert.equal(worstFrameMs(perf), 0);
  assert.equal(resetPerf(null).ok, false);
});

test('the plan object is reused rather than allocated每 frame', () => {
  // The frame loop reads the plan sixty times a second; allocating one would feed the collector
  // the very jitter this module exists to remove.
  const perf = createPerf();
  const a = beginFrame(perf, 0);
  endFrame(perf, 5);
  const b = beginFrame(perf, 16);
  assert.equal(a, b, 'beginFrame must hand back the same plan object every frame');
});
