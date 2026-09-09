/**
 * src/game/session.js — the state machine that turns ten modules into one game.
 *
 * Layer L5, above `src/core` and below `src/ui`. It owns the phase transitions, applies a
 * mission's declarative setup through sim actions, drives the director, feeds the scorer one
 * sample per controller scan, records the ghost, plays the sounds, and at the end writes the
 * profile, evaluates the badges and builds the result.
 *
 * TWO THINGS DECIDE WHETHER THIS FEELS LIKE A GAME OR LIKE A BUG.
 *
 * The first is that the COUNTDOWN genuinely gates play. A shift that starts scoring while the
 * plant is still settling from its own setup charges the player for a transient they did not
 * cause, and there is no way to win that back. So the setup is applied, the plant is given a few
 * seconds to answer it, and only then does the first point get awarded.
 *
 * The second is that ABORT LEAVES NOTHING BEHIND. A run injects faults, applies upsets, locks
 * features and rewrites the tuning; every one of those has to be undone when the player walks
 * away, or free play afterwards is quietly a different rig and nothing in the interface says so.
 * `finish` and `abortGame` share one teardown for exactly that reason.
 *
 * ALLOCATION. `onScan` runs on every controller scan — up to twenty per simulated second at high
 * time compression — so it reuses its sample and alarm buffers and does no work proportional to
 * the length of the run. `gameView` is called once per frame and mutates a single snapshot object
 * rather than building one, for the same reason.
 */

import { clamp } from '../core/util.js';
import { makeRng, hashSeed, dailySeed, seedCode } from './rng.js';
import {
  createScoreState, stepScore, scoreEvent, takePops, finishScore,
} from './score.js';
import {
  missionById, availableMissions, nextMission, missionNeeds, SETUP_ACTIONS, RULE_DEFAULTS,
} from './missions.js';
import {
  createDirector, stepDirector, upcoming, revertAll, endlessWave,
} from './director.js';
import {
  createFaultState, injectFault, clearFaults, stepFaults, faultChoices, gradeDiagnosis, FAULTS,
} from './faults.js';
import {
  createRecorder, recordSample, finishRecording, saveGhost, loadGhost,
} from './replay.js';
import {
  recordMission, recordEndless, recordDaily, isUnlocked, unlock, awardBadge, saveProfile,
} from './profile.js';
import { evaluateBadges } from './badges.js';
import { play, resume } from './audio.js';

/** Where a session can be. */
export const PHASE = Object.freeze({
  IDLE: 'IDLE',
  BRIEF: 'BRIEF',
  COUNTDOWN: 'COUNTDOWN',
  PLAY: 'PLAY',
  DIAGNOSE: 'DIAGNOSE',
  RESULT: 'RESULT',
  FAILED: 'FAILED',
});

/** What kind of run is in progress. */
export const MODE = Object.freeze({
  CAMPAIGN: 'CAMPAIGN',
  ENDLESS: 'ENDLESS',
  DAILY: 'DAILY',
  FAULT: 'FAULT',
  SANDBOX: 'SANDBOX',
});

/**
 * Settling time between the setup landing and the first point being scored, simulated seconds.
 *
 * Three, because the header's own dominant time constant is a couple of seconds and the setup can
 * move the demand valve a long way. Shorter and the player is charged for the settle; much longer
 * and it reads as the game having hung.
 */
export const COUNTDOWN_S = 3;

/** How long an endless wave lasts before the next, harder one is composed. */
export const ENDLESS_WAVE_S = 60;

/** Ghost sampling period, s. Half-second detail is plenty to race against. */
export const GHOST_PERIOD_S = 0.5;

/** localStorage key prefix for a mission's best-run ghost. */
export const GHOST_PREFIX = 'skid.game.ghost.';

/** Fault-hunt runs are open-ended; this is the cap before the answer is asked for anyway. */
export const FAULT_HUNT_S = 240;

/** How many options a fault hunt offers. */
export const FAULT_CHOICES = 4;

/**
 * A refusal in the house form.
 * @param {string} reason a sentence an operator could read
 * @returns {{ok:false, reason:string}} the refusal
 */
function fail(reason) {
  return { ok: false, reason };
}

/** @returns {{ok:true}} the house success result */
function ok() {
  return { ok: true };
}

/**
 * True when the context is complete enough to run a shift against.
 * @param {object} ctx the sim context
 * @returns {boolean} whether it can be played
 */
function usableCtx(ctx) {
  return !!(ctx && ctx.plant && ctx.pid && ctx.run && ctx.config);
}

/**
 * Play a sound, if this build has audio at all.
 * @param {object} g the session
 * @param {string} id a sound id
 * @returns {void}
 */
function sound(g, id) {
  if (g.audio) play(g.audio, id);
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

/**
 * Build a game session.
 *
 * Everything environment-dependent is injected, so the whole machine runs under `node --test` with
 * no storage and no audio and behaves identically minus the saving and the noise.
 *
 * @param {object} deps `{sim, storage, audio, profile}` — every one optional
 * @returns {object} the session, carrying a bound `onScan` for `ctx.game`
 */
export function createGame(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const g = {
    /** Marks the object as one of ours, so a public entry point can refuse a stray argument. */
    isGame: true,

    sim: d.sim || null,
    storage: d.storage || null,
    audio: d.audio || null,
    profile: d.profile || null,

    phase: PHASE.IDLE,
    mode: MODE.SANDBOX,
    /** The mission record, or null outside campaign and daily play. */
    mission: null,
    /** The seed this run was composed from, and its share code. */
    seed: 0,
    code: '',
    /** The calendar date a daily run belongs to, or null. */
    dateStr: null,

    rng: null,
    score: null,
    rules: null,
    dir: null,
    faults: null,
    rec: null,
    /** The best previous run for this mission, to race against. */
    ghost: null,

    /** Play time elapsed and remaining, simulated seconds. */
    t_s: 0,
    left_s: 0,
    duration_s: 0,
    countdown_s: 0,

    /** Endless bookkeeping. */
    wave: 0,
    waveClock_s: 0,

    /** Fault hunt bookkeeping. */
    trueFault: null,
    choices: [],
    diagnosis: null,

    /** Energy and start counts at the moment scoring began, for the end-of-shift accounting. */
    baseEnergy_kWh: 0,
    baseStarts: 0,
    upsetsRidden: 0,
    upsetsHeldInBand: 0,
    bandExitsAtUpset: 0,

    /** The finished result, or null. */
    result: null,
    /** Newly earned badges, for the results screen. */
    earnedBadges: [],
    /** One line of what is happening, for the panel. */
    message: '',
    /** Enough to start the same run again. */
    lastStart: null,

    /** Reused per-scan buffers. See the note at the top of the file. */
    _sample: {
      pv: 0, sp: 0, co: 0, alarms: [], cavitating: false, minFlow: false, tripped: false,
    },
    _view: null,
  };

  // `src/core/sim.js` calls `ctx.game.onScan(ctx, scan_s)`. Binding it here keeps the free
  // functions below testable in their own right while giving the slot the shape it expects.
  g.onScan = (ctx, dt_s) => onScan(g, ctx, dt_s);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------------------------

/**
 * Apply a mission's declarative setup through the sim's own actions.
 *
 * The setup is a list of records rather than a closure so that a mission can be serialised and
 * shown to the player, and so that nothing in the campaign can reach past the action surface into
 * the plant. An action outside {@link SETUP_ACTIONS} is refused rather than called: the list is
 * the boundary, and a mission that wants something else is a mission with a bug.
 *
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {object[]} list setup records `{action, args}`
 * @returns {string[]} problems, empty when every record applied
 */
function applySetup(g, ctx, list) {
  const problems = [];
  if (!Array.isArray(list)) return problems;
  for (const rec of list) {
    if (!rec || typeof rec.action !== 'string') { problems.push('a setup record with no action'); continue; }
    if (!SETUP_ACTIONS.includes(rec.action)) {
      problems.push(`${rec.action} is not a setup action`);
      continue;
    }
    const fn = g.sim && g.sim[rec.action];
    if (typeof fn !== 'function') { problems.push(`this rig has no ${rec.action} action`); continue; }
    const res = fn(ctx, ...(Array.isArray(rec.args) ? rec.args : []));
    if (res && res.ok === false) problems.push(`${rec.action}: ${res.reason}`);
  }
  return problems;
}

/**
 * Common opening for every mode: wipe the previous run's state, arm the scorer and the recorder,
 * and put the session into its countdown.
 *
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {object} spec `{mode, mission, seed, dateStr, rules, duration_s, script, endless}`
 * @returns {void}
 */
function beginRun(g, ctx, spec) {
  teardown(g, ctx);

  // Hand the next shift a plant it can actually run. A trip LATCHES — which is correct, a real
  // starter does not re-close itself — so a run that ended on one leaves a machine locked out, and
  // the shift after it would be scored against a rig that was never going to hold setpoint. The
  // player would read that as the game being broken, and they would be right. Clearing the latch
  // is what an operator does at the panel before taking the next shift, so the session does it
  // too, and only here: nothing resets a trip while a run is in progress.
  if (typeof g.sim.resetPump === 'function') {
    for (let i = 0; i < ctx.plant.drv.length; i += 1) {
      if (ctx.plant.drv[i].trip) g.sim.resetPump(ctx, i);
    }
  }

  g.mode = spec.mode;
  g.mission = spec.mission || null;
  g.seed = spec.seed >>> 0;
  g.code = seedCode(g.seed);
  g.dateStr = spec.dateStr || null;
  g.rules = spec.rules || RULE_DEFAULTS;
  g.duration_s = spec.duration_s;
  g.left_s = spec.duration_s;
  g.t_s = 0;
  g.wave = spec.endless ? 1 : 0;
  g.waveClock_s = 0;
  g.result = null;
  g.earnedBadges = [];
  g.diagnosis = null;

  // Child streams, one per subsystem. Sharing one generator would mean that adding a draw to the
  // director shifted every fault decision in every seeded run ever recorded — the share code would
  // stop naming a fixed rig, which is the one thing it exists to do.
  g.rng = makeRng(hashSeed(`${g.seed}:director`));
  g.score = createScoreState();
  g.faults = createFaultState();
  g.rec = createRecorder(GHOST_PERIOD_S);
  g.dir = createDirector({
    script: spec.script || [],
    rng: g.rng,
    endless: !!spec.endless,
    intensity: spec.intensity || 1,
  });

  g.upsetsRidden = 0;
  g.upsetsHeldInBand = 0;
  g.baseEnergy_kWh = ctx.run.energy.kWh;
  g.baseStarts = countStarts(ctx);

  g.phase = PHASE.COUNTDOWN;
  g.countdown_s = COUNTDOWN_S;
  g.message = 'settling — stand by';
  if (g.audio) resume(g.audio);
  sound(g, 'countdown');
}

/**
 * Total machine starts so far, so the shift can be charged only for its own.
 * @param {object} ctx the sim context
 * @returns {number} cumulative starts across every machine
 */
function countStarts(ctx) {
  const sq = ctx.staging;
  if (sq && Array.isArray(sq.starts)) return sq.starts.reduce((a, b) => a + (b || 0), 0);
  return 0;
}

/**
 * Start a campaign mission.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {string} missionId which mission
 * @returns {{ok:boolean, reason?:string}} the result
 */
export function startMission(g, ctx, missionId) {
  if (!g || g.isGame !== true) return fail('there is no game session to start a shift in');
  if (!usableCtx(ctx)) return fail('the simulation is not ready to start a shift');
  const m = missionById(missionId);
  if (!m) return fail(`there is no shift called ${String(missionId)}`);

  // The unlock gate. Refusing here with the missing feature named is the difference between a
  // player who knows what to do next and a player staring at a button that does nothing.
  if (g.profile) {
    for (const need of missionNeeds(m)) {
      if (!isUnlocked(g.profile, need)) {
        return fail(`${m.title} needs ${need}, which you have not earned yet`);
      }
    }
  }

  beginRun(g, ctx, {
    mode: MODE.CAMPAIGN,
    mission: m,
    seed: m.seed >>> 0,
    rules: m.rules,
    duration_s: m.duration_s,
    script: m.script,
  });

  const problems = applySetup(g, ctx, m.setup);
  if (problems.length) g.message = `setup: ${problems[0]}`;
  g.ghost = g.storage ? loadGhost(g.storage, `${GHOST_PREFIX}${m.id}`) : null;
  g.lastStart = { kind: MODE.CAMPAIGN, id: m.id };
  return ok();
}

/**
 * Start an endless run.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {number} seed the run seed
 * @returns {{ok:boolean, reason?:string}} the result
 */
export function startEndless(g, ctx, seed) {
  if (!g || g.isGame !== true) return fail('there is no game session to start a run in');
  if (!usableCtx(ctx)) return fail('the simulation is not ready to start a run');
  const s = Number.isFinite(seed) ? seed >>> 0 : hashSeed('endless');

  beginRun(g, ctx, {
    mode: MODE.ENDLESS,
    seed: s,
    rules: RULE_DEFAULTS,
    // Endless ends when the player does, not when a clock does. The duration is a ceiling that
    // exists only so nothing runs forever if a session is left open.
    duration_s: 24 * 3600,
    endless: true,
  });
  g.lastStart = { kind: MODE.ENDLESS, seed: s };
  g.message = 'wave 1';
  return ok();
}

/**
 * Start the daily challenge.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {string} dateStr the local calendar date, 'YYYY-MM-DD'
 * @returns {{ok:boolean, reason?:string}} the result
 */
export function startDaily(g, ctx, dateStr) {
  if (!g || g.isGame !== true) return fail('there is no game session to start the daily in');
  if (!usableCtx(ctx)) return fail('the simulation is not ready to start the daily');
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    // The date has to come from the caller: nothing in src/game may read a clock, and it must be
    // the player's LOCAL date or everyone west of the line plays yesterday's rig.
    return fail('the daily needs the local date as YYYY-MM-DD');
  }
  const s = dailySeed(dateStr);
  const rng = makeRng(hashSeed(`${s}:daily`));

  beginRun(g, ctx, {
    mode: MODE.DAILY,
    seed: s,
    dateStr,
    rules: RULE_DEFAULTS,
    duration_s: 180,
    script: endlessWave(rng, 2),
  });
  g.lastStart = { kind: MODE.DAILY, dateStr };
  g.message = `daily ${dateStr} — ${g.code}`;
  return ok();
}

/**
 * Start a fault hunt: something is wrong, and the player has to name it.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {number} seed the run seed
 * @returns {{ok:boolean, reason?:string}} the result
 */
export function startFaultHunt(g, ctx, seed) {
  if (!g || g.isGame !== true) return fail('there is no game session to start a hunt in');
  if (!usableCtx(ctx)) return fail('the simulation is not ready for a fault hunt');
  const s = Number.isFinite(seed) ? seed >>> 0 : hashSeed('hunt');

  beginRun(g, ctx, {
    mode: MODE.FAULT,
    seed: s,
    rules: RULE_DEFAULTS,
    duration_s: FAULT_HUNT_S,
  });

  // Try faults in a seeded order until one takes: several of them legitimately refuse on a rig
  // that is not configured for them — a PT fault on a flow loop, a valve fault with no valve in
  // the loop — and a hunt that silently injected nothing would be unanswerable.
  const pick = makeRng(hashSeed(`${s}:fault`));
  const order = FAULTS.map((f) => f.id).sort((a, b) => (hashSeed(`${s}:${a}`) - hashSeed(`${s}:${b}`)));
  let chosen = null;
  for (const id of order) {
    if (injectFault(g.faults, ctx, g.sim, id, 0.6 + 0.4 * pick()).ok) { chosen = id; break; }
  }
  if (!chosen) {
    teardown(g, ctx);
    g.phase = PHASE.IDLE;
    return fail('no fault in the library can bite on this rig as it is configured');
  }

  g.trueFault = chosen;
  g.choices = faultChoices(pick, chosen, FAULT_CHOICES);
  g.lastStart = { kind: MODE.FAULT, seed: s };
  g.message = 'something is wrong — find it';
  return ok();
}

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

/**
 * Fill the reused sample buffer from the plant.
 *
 * The measurement scored is the one the CONTROLLER sees, not the true process value. That is the
 * fair thing and also the instructive one: hold what the transmitter reports, and a session with
 * a drifting transmitter will teach the difference the hard way.
 *
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @returns {object} the sample, reused between scans
 */
function sampleFrom(g, ctx) {
  const s = g._sample;
  s.pv = ctx.pid.pvRaw;
  s.sp = ctx.pid.sp;
  s.co = ctx.run.co_pct;

  const list = ctx.run.alarmList;
  s.alarms.length = 0;
  let cav = false;
  let minFlow = false;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a.active) continue;
    s.alarms.push(a.id);
    if (a.id.startsWith('CAV_')) cav = true;
    else if (a.id.startsWith('MINQ_')) minFlow = true;
  }
  s.cavitating = cav;
  s.minFlow = minFlow;

  // A trip is read from the machines rather than from the alarm list, because the alarm can be
  // acknowledged away and the trip cannot.
  let tripped = false;
  for (let i = 0; i < ctx.plant.drv.length; i += 1) {
    if (ctx.plant.drv[i].trip) { tripped = true; break; }
  }
  s.tripped = tripped;
  return s;
}

/**
 * One controller scan of the game. Called from `src/core/sim.js` at the bottom of every scan.
 *
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {number} dt_s the scan interval, s
 * @returns {void}
 */
export function onScan(g, ctx, dt_s) {
  if (!g || g.isGame !== true || !usableCtx(ctx)) return;
  const dt = Number.isFinite(dt_s) && dt_s > 0 ? dt_s : 0;
  if (dt === 0) return;

  if (g.phase === PHASE.COUNTDOWN) {
    g.countdown_s -= dt;
    if (g.countdown_s <= 0) {
      g.phase = PHASE.PLAY;
      g.countdown_s = 0;
      // The energy baseline is taken HERE and not when the run was set up, so the settle the
      // player did not ask for is not on their bill.
      g.baseEnergy_kWh = ctx.run.energy.kWh;
      g.baseStarts = countStarts(ctx);
      g.message = g.mission ? g.mission.title : 'running';
      sound(g, 'bandIn');
    }
    return;
  }

  if (g.phase !== PHASE.PLAY) return;

  // --- the world moves --------------------------------------------------------------------------
  const wasInBand = g.score.inBand;
  const step = stepDirector(g.dir, ctx, g.sim, dt);
  if (step && step.fired && step.fired.length) {
    g.upsetsRidden += step.fired.length;
    if (wasInBand) g.upsetsHeldInBand += step.fired.length;
    sound(g, 'warn');
  }
  if (g.mode === MODE.FAULT) stepFaults(g.faults, ctx, g.sim, dt);

  // --- the score --------------------------------------------------------------------------------
  const sample = sampleFrom(g, ctx);
  const before = g.score.mult;
  stepScore(g.score, g.rules, sample, dt);
  if (g.score.mult > before) sound(g, 'combo');
  else if (wasInBand && !g.score.inBand) sound(g, 'bandOut');

  recordSample(g.rec, g.t_s, sample.pv, sample.sp, sample.co);

  g.t_s += dt;
  g.left_s = Math.max(0, g.left_s - dt);

  // --- endless escalation -----------------------------------------------------------------------
  // The director composes and stocks its own waves — it has to, because it is the thing that knows
  // how far ahead the ticker needs to be filled. So this only NOTICES a new wave and pays for it;
  // pushing entries onto `dir.queue` from out here would bypass `schedule` and put records of the
  // wrong shape in front of `stepDirector`.
  if (g.mode === MODE.ENDLESS && g.dir.wave > g.wave) {
    g.wave = g.dir.wave;
    scoreEvent(g.score, 'bonus', 100 * g.wave, `wave ${g.wave}`);
    g.message = `wave ${g.wave}`;
    sound(g, 'stage');
  }

  // --- the ways a shift ends --------------------------------------------------------------------
  if (g.score.failed) { finish(g, ctx, true); return; }
  if (g.left_s <= 0) {
    if (g.mode === MODE.FAULT) {
      g.phase = PHASE.DIAGNOSE;
      g.message = 'name the fault';
      sound(g, 'warn');
      return;
    }
    finish(g, ctx, false);
  }
}

// ---------------------------------------------------------------------------------------------
// Ending a run
// ---------------------------------------------------------------------------------------------

/**
 * Undo everything a run did to the rig.
 *
 * Shared by `finish` and `abortGame` deliberately. Two teardowns drift apart, and the failure when
 * they do is invisible: free play afterwards is a subtly different plant, and nothing says so.
 *
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @returns {void}
 */
function teardown(g, ctx) {
  if (!usableCtx(ctx)) return;
  if (g.dir) revertAll(g.dir, ctx, g.sim);
  if (g.faults) clearFaults(g.faults, ctx, g.sim);
  g.trueFault = null;
  g.choices = [];
}

/**
 * Grade the shift, write the profile, and move to the results screen.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {boolean} failed whether the shift ended badly
 * @returns {void}
 */
function finish(g, ctx, failed) {
  const used = ctx.run.energy.kWh - g.baseEnergy_kWh;
  const res = finishScore(g.score, g.rules, {
    energy_kWh: used,
    parEnergy_kWh: g.mission ? g.mission.parEnergy_kWh : NaN,
    duration_s: g.t_s,
    thresholds: g.mission ? g.mission.par : null,
  });

  const ghost = finishRecording(g.rec);
  // `finishScore` hands back a frozen record, deliberately — a grade nobody can quietly edit after
  // the fact is the point of it. So the session's own fields go on a NEW object built around it
  // rather than being written onto the grade.
  const graded = (res && res.ok === false)
    ? { score: 0, medal: 'none', failed: true, breakdown: [], stats: {} }
    : res;
  const result = {
    ...graded,
    mode: g.mode,
    missionId: g.mission ? g.mission.id : null,
    title: g.mission ? g.mission.title : g.mode,
    wave: g.wave,
    seed: g.seed,
    code: g.code,
    energy_kWh: used,
    parEnergy_kWh: g.mission ? g.mission.parEnergy_kWh : NaN,
    starts: countStarts(ctx) - g.baseStarts,
    upsetsRidden: g.upsetsRidden,
    upsetsHeldInBand: g.upsetsHeldInBand,
    par: g.mission ? g.mission.par : null,
    ghost,
  };

  // --- the profile ------------------------------------------------------------------------------
  if (g.profile) {
    let record = null;
    if (g.mode === MODE.CAMPAIGN && g.mission) record = recordMission(g.profile, g.mission.id, result);
    else if (g.mode === MODE.ENDLESS) record = recordEndless(g.profile, result);
    else if (g.mode === MODE.DAILY) record = recordDaily(g.profile, g.dateStr, result);
    result.record = record;

    // Unlocks are granted only on a cleared campaign shift, and only once — `unlock` reports
    // whether it was new, which is what the results screen celebrates.
    result.unlocked = [];
    if (g.mode === MODE.CAMPAIGN && g.mission && !result.failed) {
      for (const id of g.mission.unlocks || []) {
        if (unlock(g.profile, id)) result.unlocked.push(id);
      }
    }

    g.earnedBadges = evaluateBadges(g.profile, {
      ...result.stats,
      mode: g.mode,
      missionId: result.missionId,
      tier: g.mission ? g.mission.tier : 0,
      failed: result.failed,
      score: result.score,
      medal: result.medal,
      duration_s: g.t_s,
      energy_kWh: used,
      parEnergy_kWh: result.parEnergy_kWh,
      pumpStarts: result.starts,
      upsetsRidden: g.upsetsRidden,
      upsetsHeldInBand: g.upsetsHeldInBand,
      wave: g.wave,
      diagnosisCorrect: g.diagnosis ? g.diagnosis.correct : false,
    }, awardBadge);
    result.badges = g.earnedBadges;

    if (g.storage) saveProfile(g.storage, g.profile);
  }

  // --- the ghost --------------------------------------------------------------------------------
  // Kept only when it is the run to beat, so the store holds one ghost per mission rather than one
  // per attempt — which is both the useful thing and the thing that fits in localStorage.
  if (g.storage && g.mission && !result.failed
    && (!g.ghost || (result.record && result.record.best))) {
    saveGhost(g.storage, `${GHOST_PREFIX}${g.mission.id}`, ghost);
  }

  teardown(g, ctx);
  g.result = result;
  g.phase = result.failed ? PHASE.FAILED : PHASE.RESULT;
  g.message = result.failed ? 'shift failed' : `${Math.round(result.score)} points`;
  sound(g, result.failed ? 'fail' : (result.medal === 'none' ? 'cash' : 'medal'));
}

/**
 * Answer a fault hunt.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @param {string} faultId the player's answer
 * @returns {{ok:boolean, reason?:string, correct?:boolean, explain?:string}} the verdict
 */
export function submitDiagnosis(g, ctx, faultId) {
  if (!g || g.isGame !== true) return fail('there is no game session to answer');
  if (g.mode !== MODE.FAULT) return fail('this is not a fault hunt');
  if (g.phase !== PHASE.PLAY && g.phase !== PHASE.DIAGNOSE) return fail('the hunt is not running');

  const verdict = gradeDiagnosis(g.faults, faultId, g.t_s);
  g.diagnosis = verdict;
  if (verdict && Number.isFinite(verdict.points)) {
    scoreEvent(g.score, verdict.correct ? 'bonus' : 'penalty', verdict.points,
      verdict.correct ? 'correct diagnosis' : 'wrong call');
  }
  sound(g, verdict && verdict.correct ? 'medal' : 'bandOut');
  if (verdict && verdict.correct) finish(g, ctx, false);
  return { ok: true, correct: !!(verdict && verdict.correct), explain: verdict && verdict.explain };
}

/**
 * Walk away from a run, leaving the rig exactly as free play expects to find it.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @returns {{ok:true}} the house success result
 */
export function abortGame(g, ctx) {
  if (!g || g.isGame !== true) return ok();
  teardown(g, ctx);
  g.phase = PHASE.IDLE;
  g.mode = MODE.SANDBOX;
  g.mission = null;
  g.result = null;
  g.score = null;
  g.dir = null;
  g.rec = null;
  g.message = 'free play';
  return ok();
}

/**
 * Start the last run again, on the same seed.
 * @param {object} g the session
 * @param {object} ctx the sim context
 * @returns {{ok:boolean, reason?:string}} the result
 */
export function replayLast(g, ctx) {
  if (!g || g.isGame !== true || !g.lastStart) return fail('there is no run to repeat');
  const s = g.lastStart;
  if (s.kind === MODE.CAMPAIGN) return startMission(g, ctx, s.id);
  if (s.kind === MODE.ENDLESS) return startEndless(g, ctx, s.seed);
  if (s.kind === MODE.DAILY) return startDaily(g, ctx, s.dateStr);
  if (s.kind === MODE.FAULT) return startFaultHunt(g, ctx, s.seed);
  return fail('that run cannot be repeated');
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/**
 * A snapshot for the interface, built once and mutated thereafter.
 *
 * Called every frame by the HUD, the arcade screen and the rail tab, so it must not allocate. The
 * arrays it hands out are live and must be treated as read-only by the caller.
 *
 * @param {object} g the session
 * @returns {object} the snapshot
 */
export function gameView(g) {
  if (!g || g.isGame !== true) return null;
  if (!g._view) {
    g._view = {
      phase: PHASE.IDLE, mode: MODE.SANDBOX, mission: null, missionId: null, title: '',
      t_s: 0, left_s: 0, countdown_s: 0, duration_s: 0,
      score: 0, mult: 1, inBand: false, holdTime_s: 0, band: 0, bandEU: '', sp: 0,
      upcoming: [], pops: [], result: null, ghost: null, wave: 0, message: '',
      seed: 0, code: '', dateStr: null, faultChoices: [], diagnosis: null,
    };
  }
  const v = g._view;
  v.phase = g.phase;
  v.mode = g.mode;
  v.mission = g.mission;
  v.missionId = g.mission ? g.mission.id : null;
  v.title = g.mission ? g.mission.title : g.mode;
  v.t_s = g.t_s;
  // Endless has no finish, so it must not advertise one. Its `duration_s` is a 24-hour ceiling
  // that exists only to stop a forgotten session running for ever, and reporting it as "1440.0
  // minutes left" tells the player something that is both true and completely useless. The
  // readouts already render a non-finite remaining time as an em dash.
  v.left_s = g.mode === MODE.ENDLESS ? NaN : g.left_s;
  v.countdown_s = g.countdown_s;
  v.duration_s = g.duration_s;
  v.score = g.score ? g.score.score : 0;
  v.mult = g.score ? g.score.mult : 1;
  v.inBand = g.score ? g.score.inBand : false;
  v.holdTime_s = g.score ? g.score.holdTime_s : 0;
  v.band = g.rules ? g.rules.band : 0;
  v.bandEU = g.rules ? (g.rules.bandEU || '') : '';
  v.sp = g._sample.sp;
  v.upcoming = g.dir ? upcoming(g.dir) : [];
  v.pops = g.score ? takePops(g.score) : [];
  v.result = g.result;
  v.ghost = g.ghost;
  v.wave = g.wave;
  v.message = g.message;
  v.seed = g.seed;
  v.code = g.code;
  v.dateStr = g.dateStr;
  v.faultChoices = g.choices;
  v.diagnosis = g.diagnosis;
  return v;
}

/**
 * What the campaign screen should offer next.
 * @param {object} g the session
 * @returns {?object} the mission record, or null when the campaign is finished or has no profile
 */
export function suggestNext(g) {
  if (!g || !g.profile) return null;
  return nextMission(g.profile) || (availableMissions(g.profile)[0] || null);
}

/**
 * Set the band used for scoring, so a lesson or a scenario can borrow the HUD.
 * @param {object} g the session
 * @param {number} band half-width in engineering units
 * @param {string} [unit] the units, for the readout
 * @returns {{ok:boolean, reason?:string}} the result
 */
export function setBand(g, band, unit) {
  if (!g || g.isGame !== true) return fail('there is no game session');
  if (!Number.isFinite(band) || band <= 0) return fail('the band has to be a positive width');
  g.rules = { ...(g.rules || RULE_DEFAULTS), band: clamp(band, 1e-6, 1e6), bandEU: unit || '' };
  return ok();
}
