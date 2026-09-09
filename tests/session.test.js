/**
 * tests/session.test.js — the game session, end to end.
 *
 * The arc matters more than any single function here. A shift that scores but does not write the
 * profile, or writes the profile but leaves an upset applied to the plant, is worse than one that
 * fails outright: the damage shows up two runs later as a rig that is quietly wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../src/core/sim.js';
import {
  createGame, startMission, startEndless, startDaily, startFaultHunt, abortGame, onScan,
  gameView, submitDiagnosis, replayLast, PHASE, MODE, COUNTDOWN_S,
} from '../src/game/session.js';
import { createProfile, isUnlocked, unlock, UNLOCK_ORDER } from '../src/game/profile.js';
import { MISSIONS, missionById } from '../src/game/missions.js';
import { near } from './helpers.js';

/** A storage that behaves like localStorage and can be inspected. */
function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A profile with everything unlocked, so a test can start any shift it likes. */
function openProfile() {
  const p = createProfile();
  for (const id of UNLOCK_ORDER) unlock(p, id);
  return p;
}

/**
 * A session wired to a real simulator.
 * @param {object} [profile] the profile to use
 * @returns {{ctx:object, g:object, storage:object}} the bench
 */
function bench(profile) {
  const ctx = sim.createSim();
  const storage = fakeStorage();
  const g = createGame({ sim, storage, audio: null, profile: profile || openProfile() });
  ctx.game = g;
  return { ctx, g, storage };
}

/**
 * Advance the rig by simulated seconds, through the real scan loop so the game is driven by the
 * same hook the application uses rather than by the test calling onScan itself.
 * @param {object} ctx the sim context
 * @param {number} secs simulated seconds
 * @returns {void}
 */
function run(ctx, secs) {
  const dt = ctx.config.scan_s;
  for (let i = 0; i < Math.round(secs / dt); i += 1) sim.advance(ctx, dt);
}

test('a mission runs from its brief to a graded result and writes the profile', () => {
  const { ctx, g, storage } = bench();
  const m = MISSIONS[0];
  assert.equal(startMission(g, ctx, m.id).ok, true, 'the first shift must be startable');
  assert.equal(g.phase, PHASE.COUNTDOWN, 'a shift opens on its countdown, not on play');

  // Nothing may score before the countdown ends: the setup has just moved the plant and the
  // player did not cause the transient.
  run(ctx, COUNTDOWN_S / 2);
  assert.equal(g.phase, PHASE.COUNTDOWN);
  near(g.score.score, 0, 1e-9, 'no points may be awarded during the settle');

  run(ctx, COUNTDOWN_S);
  assert.equal(g.phase, PHASE.PLAY, 'the countdown must hand over to play');

  run(ctx, m.duration_s + 2);
  assert.ok(g.phase === PHASE.RESULT || g.phase === PHASE.FAILED,
    `the shift must end by itself, was ${g.phase}`);
  assert.ok(g.result, 'and it must produce a result');
  assert.ok(Number.isFinite(g.result.score), 'with a finite score');
  assert.equal(g.result.missionId, m.id);
  assert.ok(storage.map.size > 0, 'the profile must have been written');
});

test('the countdown gates scoring, and the energy bill starts when play does', () => {
  const { ctx, g } = bench();
  startMission(g, ctx, MISSIONS[0].id);
  run(ctx, COUNTDOWN_S + 1);
  assert.equal(g.phase, PHASE.PLAY);
  // The baseline is taken at the handover, not at setup, so the settle is not on the player's bill.
  near(g.baseEnergy_kWh, ctx.run.energy.kWh, 0.02,
    'the energy baseline should be taken as play begins, not when the shift was set up');
});

test('a shift the player has not earned is refused, and says what is missing', () => {
  const locked = createProfile();
  const { ctx, g } = bench(locked);
  // Find a mission that needs something a fresh profile has not got.
  const gated = MISSIONS.find((m) => (m.needs || []).some((n) => !isUnlocked(locked, n)));
  assert.ok(gated, 'the campaign must gate something, or the progression is decorative');
  const res = startMission(g, ctx, gated.id);
  assert.equal(res.ok, false);
  assert.match(res.reason, /earned/, `the refusal should name the gate: "${res.reason}"`);
});

test('abort leaves the rig exactly as free play expects to find it', () => {
  const { ctx, g } = bench();
  const before = snapshot(ctx);
  startMission(g, ctx, MISSIONS[3].id);
  run(ctx, 40);
  abortGame(g, ctx);
  assert.equal(g.phase, PHASE.IDLE);

  // The plant is allowed to have moved — time passed. What must NOT survive is anything the run
  // imposed: an applied upset, an injected fault, a disturbance the director set.
  const after = snapshot(ctx);
  assert.deepEqual(after.overrides, before.overrides,
    'an aborted run left a valve override behind');
  assert.equal(after.fluidId, before.fluidId, 'an aborted run left a fluid change behind');
  near(after.foul, before.foul, 1e-9, 'an aborted run left fouling behind');
});

test('the same seed produces the same daily, twice', () => {
  const a = bench();
  const b = bench();
  assert.equal(startDaily(a.g, a.ctx, '2026-03-14').ok, true);
  assert.equal(startDaily(b.g, b.ctx, '2026-03-14').ok, true);
  assert.equal(a.g.seed, b.g.seed, 'one date must name one rig');
  assert.equal(a.g.code, b.g.code, 'and one share code');

  run(a.ctx, 90);
  run(b.ctx, 90);
  near(a.g.score.score, b.g.score.score, 1e-9,
    'two runs of one daily seed must score identically, or the leaderboard means nothing');
});

test('a different date is a different rig', () => {
  const a = bench();
  const b = bench();
  startDaily(a.g, a.ctx, '2026-03-14');
  startDaily(b.g, b.ctx, '2026-03-15');
  assert.notEqual(a.g.seed, b.g.seed);
});

test('the daily refuses anything that is not a local calendar date', () => {
  const { ctx, g } = bench();
  for (const bad of [undefined, null, 42, 'today', '14/03/2026', '2026-3-4']) {
    assert.equal(startDaily(g, ctx, bad).ok, false, `"${String(bad)}" was accepted as a date`);
  }
});

test('endless escalates: later waves arrive and are paid for', () => {
  const { ctx, g } = bench();
  assert.equal(startEndless(g, ctx, 12345).ok, true);
  run(ctx, COUNTDOWN_S + 5);
  assert.equal(g.phase, PHASE.PLAY);
  const early = g.dir.wave;
  run(ctx, 400);
  assert.ok(g.dir.wave > early, `waves must keep coming, stuck at ${g.dir.wave}`);
});

test('a fault hunt injects something real, offers it among the options, and grades the answer', () => {
  const { ctx, g } = bench();
  assert.equal(startFaultHunt(g, ctx, 777).ok, true);
  assert.ok(g.trueFault, 'a hunt with no fault in it is unanswerable');
  assert.ok(g.choices.includes(g.trueFault), 'the true fault must be among the options');
  assert.equal(new Set(g.choices).size, g.choices.length, 'the options must not repeat');

  run(ctx, COUNTDOWN_S + 20);
  const wrong = g.choices.find((c) => c !== g.trueFault);
  const bad = submitDiagnosis(g, ctx, wrong);
  assert.equal(bad.correct, false, 'a wrong call must not be graded correct');

  const good = submitDiagnosis(g, ctx, g.trueFault);
  assert.equal(good.correct, true);
  assert.equal(g.phase, PHASE.RESULT, 'a correct diagnosis ends the hunt');
});

test('a shift after a trip starts on a plant that can actually run', () => {
  const { ctx, g } = bench();
  startMission(g, ctx, MISSIONS[0].id);
  run(ctx, 20);
  sim.forceTrip(ctx, 0);
  run(ctx, 2);
  assert.ok(ctx.plant.drv[0].trip, 'the machine should be locked out at this point');

  // A trip latches, as it must. But the NEXT shift would then be graded against a rig that was
  // never going to hold setpoint, and the player would call that a broken game rather than a
  // locked-out pump.
  startMission(g, ctx, MISSIONS[0].id);
  assert.ok(!ctx.plant.drv[0].trip,
    'starting a shift must clear a latched trip, or the shift is unplayable before it begins');
});

test('the view is one object, reused, and never returns a stale phase', () => {
  const { ctx, g } = bench();
  const a = gameView(g);
  startMission(g, ctx, MISSIONS[0].id);
  const b = gameView(g);
  assert.equal(a, b, 'gameView must not allocate a fresh snapshot every frame');
  assert.equal(b.phase, PHASE.COUNTDOWN, 'and it must reflect the phase it is actually in');
  assert.equal(b.missionId, MISSIONS[0].id);
});

test('a run can be repeated on its own seed', () => {
  const { ctx, g } = bench();
  startEndless(g, ctx, 999);
  run(ctx, 20);
  const seed = g.seed;
  assert.equal(replayLast(g, ctx).ok, true);
  assert.equal(g.seed, seed, 'a repeat must be the same run, not a fresh one');
  near(g.t_s, 0, 1e-9, 'and it must start from the beginning');
});

test('the session is inert when nothing is running, and survives a rubbish context', () => {
  const { ctx, g } = bench();
  assert.equal(g.phase, PHASE.IDLE);
  onScan(g, ctx, 0.2);
  assert.equal(g.phase, PHASE.IDLE, 'an idle session must not start itself');
  onScan(g, null, 0.2);
  onScan(g, ctx, 0);
  onScan(null, ctx, 0.2);
  assert.equal(startMission(g, ctx, 'NO_SUCH_SHIFT').ok, false);
});

/**
 * The parts of the plant a run is allowed to disturb and must give back.
 * @param {object} ctx the sim context
 * @returns {object} the comparable state
 */
function snapshot(ctx) {
  const p = ctx.plant;
  return {
    fluidId: p.fluidId,
    foul: p.foul,
    overrides: JSON.parse(JSON.stringify(p.valveOverride)),
  };
}
