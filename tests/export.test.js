/**
 * tests/export.test.js — CSV, the session file, and the run library.
 *
 * The session-file tests matter more than they look. A file that restores 90% of a tuning and
 * silently drops the rest is worse than one that fails outright, because the loop then behaves in
 * a way nobody can account for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trendToCsv, scorecardToCsv, comparisonToCsv, compareRuns, createRunLibrary, saveRun, deleteRun,
  sessionSnapshot, applySession, timestampedName, SESSION_VERSION,
} from '../src/io/export.js';
import * as sim from '../src/core/sim.js';
import { TREND_UNITS } from '../src/core/sim.js';
import { MODE, FORM } from '../src/control/pid.js';
import { STRUCTURE } from '../src/control/strategy.js';
import { CRITERION } from '../src/control/staging.js';
import { createRing, pushRing } from '../src/core/util.js';
import { simFor, run, near, nearRel } from './helpers.js';

test('the trend exports one header row and one row per sample, oldest first', () => {
  const ring = createRing(['t_s', 'pv'], 4);
  for (let i = 1; i <= 6; i += 1) pushRing(ring, [i, i * 0.5]);
  const csv = trendToCsv(ring, { t_s: 's', pv: 'bar' });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 5, 'a header and the four rows the ring still holds');
  assert.equal(lines[0], 't_s (s),pv (bar)', 'columns carry their units');
  assert.equal(lines[1], '3,1.5', 'the oldest surviving sample comes first');
  assert.equal(lines[4], '6,3', 'and the newest last');
});

test('the trend export never writes a NaN into a spreadsheet', () => {
  const ring = createRing(['a'], 3);
  pushRing(ring, [NaN]);
  pushRing(ring, [1.23456789]);
  const csv = trendToCsv(ring, {}, { decimals: 3 });
  assert.ok(!csv.includes('NaN'), 'a NaN in a CSV becomes a text cell and poisons the column');
  assert.ok(csv.includes('1.235'), 'and numbers are rounded, not dumped at full precision');
});

test('a full sim exports a trend whose width matches its channel list', () => {
  const ctx = simFor(120);
  const csv = trendToCsv(ctx.trend, TREND_UNITS);
  const lines = csv.trim().split('\n');
  assert.ok(lines.length > 10, 'two minutes must produce samples');
  const cols = lines[0].split(',').length;
  for (const line of lines.slice(1)) {
    assert.equal(line.split(',').length, cols, 'every row must have every column');
  }
});

test('a session snapshot round-trips through the actions that validate it', () => {
  const a = simFor(60);
  sim.setTuning(a, { Kc: 33, Ti: 7.5, Td: 1.2, N: 8, b: 0.6, pvFilter_s: 0.4 });
  sim.setStaging(a, { stageUp_pct: 91, stageDown_pct: 37, criterion: CRITERION.FLOW });
  sim.setStrategy(a, { ff: { enabled: true, gain: 0.7 } });
  sim.setDisturbance(a, { demandTarget: 0.63, foul: 0.2, fluidId: 'EG30' });
  sim.setSetpoint(a, 3.45);
  const snap = sessionSnapshot(a);
  assert.equal(snap.version, SESSION_VERSION);

  const b = simFor(60);
  const res = applySession(b, snap, sim);
  assert.deepEqual(res.problems, [], 'a snapshot from this build must restore without complaint');
  near(b.pidCfg.Kc, 33, 1e-9, 'gain');
  near(b.pidCfg.Ti, 7.5, 1e-9, 'reset');
  near(b.pidCfg.b, 0.6, 1e-9, 'setpoint weight');
  near(b.pid.spTarget, 3.45, 1e-9, 'setpoint');
  assert.equal(b.stagingCfg.criterion, CRITERION.FLOW);
  assert.equal(b.stratCfg.ff.enabled, true);
  near(b.plant.demandTarget, 0.63, 1e-9, 'demand');
  assert.equal(b.plant.fluidId, 'EG30');
});

test('a hand-edited session is rejected field by field, not applied as nonsense', () => {
  const ctx = simFor(30);
  const before = ctx.pidCfg.Kc;
  const bad = sessionSnapshot(ctx);
  bad.tuning.Ti = -5;
  bad.setpoint = 99;
  const res = applySession(ctx, bad, sim);
  assert.equal(res.ok, false);
  assert.equal(res.problems.length, 2, 'both bad fields must be reported');
  assert.match(res.problems.join(' '), /reset time/);
  assert.match(res.problems.join(' '), /setpoint must be between/);
  near(ctx.pidCfg.Kc, before, 1e-9, 'and the running rig must be left alone');
});

test('a snapshot from a future version is applied as far as it can be, with a warning', () => {
  const ctx = simFor(30);
  const snap = sessionSnapshot(ctx);
  snap.version = SESSION_VERSION + 99;
  const res = applySession(ctx, snap, sim);
  assert.equal(res.ok, false, 'the version mismatch is itself a problem worth reporting');
  assert.match(res.problems[0], /version/);
  assert.ok(res.applied > 4, 'but everything it did recognise was still applied');
});

test('something that is not a session file is refused without throwing', () => {
  const ctx = simFor(10);
  assert.equal(applySession(ctx, null, sim).ok, false);
  assert.equal(applySession(ctx, 'nonsense', sim).ok, false);
});

test('the run library keeps the settings that produced each run, not a live reference', () => {
  const ctx = simFor(60);
  sim.setTuning(ctx, { Kc: 10, Ti: 20 });
  const lib = createRunLibrary();
  const fake = fakeResult('Load step', 55);
  const first = saveRun(lib, fake, ctx, 'slow');
  sim.setTuning(ctx, { Kc: 40, Ti: 4 });
  saveRun(lib, fakeResult('Load step', 78), ctx, 'fast');

  near(first.tuning.Kc, 10, 1e-9, 'the first run must remember the tuning it ran with');
  near(lib.runs[1].tuning.Kc, 40, 1e-9, 'and the second, its own');
  assert.equal(lib.runs.length, 2);
  assert.equal(deleteRun(lib, first.id), true);
  assert.equal(lib.runs.length, 1);
  assert.equal(deleteRun(lib, 999), false, 'removing something that is not there is not an error');
});

test('the comparison marks the best of each metric, and flags runs that are not comparable', () => {
  const ctx = simFor(30);
  const lib = createRunLibrary();
  saveRun(lib, fakeResult('Load step', 55), ctx, 'a');
  saveRun(lib, fakeResult('Load step', 78), ctx, 'b');
  const same = compareRuns(lib);
  assert.equal(same.comparable, true);
  const score = same.metrics.find((m) => m.key === 'score');
  near(score.best, 78, 1e-9, 'a higher score is better');
  const iae = same.metrics.find((m) => m.key === 'iae');
  assert.equal(iae.better, 'low', 'and a lower IAE is');

  saveRun(lib, fakeResult('Shift duty cycle', 60), ctx, 'c');
  const mixed = compareRuns(lib);
  assert.equal(mixed.comparable, false,
    'runs of different tests over different durations are not comparable numbers');
  assert.equal(mixed.scenarios.length, 2);

  const csv = comparisonToCsv(mixed);
  assert.ok(csv.includes('Score'), 'and the CSV carries the metrics');
  assert.ok(csv.includes('Kc'), 'and the settings that produced them');
});

test('the scorecard CSV carries the summary, the steps and the grade breakdown', () => {
  const ctx = simFor(30);
  sim.gradeNow(ctx);
  const csv = scorecardToCsv(ctx.scenario.last);
  assert.ok(csv.includes('summary,scenario'));
  assert.ok(csv.includes('grade component'));
  assert.ok(csv.includes('penalty,cavitation'));
});

test('exported filenames sort chronologically', () => {
  const a = timestampedName('trend', 'csv');
  assert.match(a, /^trend-\d{8}-\d{6}\.csv$/);
});

/**
 * A minimal scorecard result, for the library tests. Building one from a real run would take
 * twelve minutes of simulated time to say something about a CSV writer.
 * @param {string} scenario the test name
 * @param {number} score the grade
 * @returns {object} a result shaped like the real thing
 */
function fakeResult(scenario, score) {
  return {
    scenario,
    t_s: 260,
    iae: 100 - score,
    itae: (100 - score) * 40,
    peakErr: 0.4,
    coTravel: 120,
    starts: 2,
    energy_kWh: 0.9,
    volume_m3: 3.2,
    specific_kWh_m3: 0.28,
    satTime_s: 0,
    minFlowTime_s: 0,
    cavTime_s: 0,
    overshootPct: 8,
    settle_s: 30,
    steps: [{ label: 'step', kind: 'load', at_s: 20, overshootPct: NaN, rise_s: NaN, settle_s: 30, peakDev: 0.4, iae: 12 }],
    score,
    parts: [{ id: 'iae', label: 'Integrated error', weight: 34, ratio: 1, ref: '1', applicable: true, earned: 34 }],
    penalties: { cavitation: 0, minFlow: 0 },
  };
}
