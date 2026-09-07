/**
 * src/game/profile.js — the player's record between shifts: experience, rank, which parts of the
 * controller they have earned, the medals they hold and their bests.
 *
 * Layer: `src/game`. Imports `core/util.js` only. It touches no DOM, no `window`, no
 * `localStorage` and no clock — the storage object arrives as an argument and every function here
 * is pure with respect to everything else, because this module is unit-tested in Node.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THE CONTROLLER ITSELF IS THE REWARD
 *
 * The usual progression system bolts cosmetics onto a game that was already complete. This one
 * cannot: the interesting thing about a PID loop is that each term exists to fix a specific,
 * felt failure of the loop without it, and that lesson does not land if all three terms are
 * present from the first minute. A player handed Kc, Ti and Td at once tunes by wiggling.
 *
 * So the unlock table below is the controller, taken apart and handed back one piece at a time,
 * in the order the pain arrives. You run the rig in manual until you are sick of chasing it, and
 * then you are given proportional. You watch proportional sit forever with a droop it cannot
 * remove, and then you are given reset. You watch reset overshoot a slow header, and then you are
 * given derivative. Every unlock is the answer to a question the previous mission made you ask.
 *
 * The consequence for this module is that unlocks are the ONE part of the profile that must never
 * be handed out loosely. Everything else here — XP, medals, bests, badges — is bookkeeping and a
 * corrupted value only costs a leaderboard entry. A wrongly granted unlock costs the lesson.
 * Hence: `unlock()` accepts nothing that is not in `UNLOCKS`, and a profile arriving from storage
 * has its unlock list filtered against the same table before it is believed.
 *
 * WHAT STORAGE IS ALLOWED TO DO TO US
 *
 * The injected storage is whatever the browser handed the UI, which means all four of these are
 * normal operating conditions rather than exceptional ones:
 *
 *   - it is absent entirely (Node, a test, a locked-down embed) — `null` is a legal argument;
 *   - `getItem` throws (some privacy modes throw rather than return null);
 *   - `setItem` throws (Safari private browsing, and any browser at quota) — this one is the
 *     dangerous case, because it happens AFTER a good run, and the naive handling of it is to let
 *     the exception escape mid-update and leave the in-memory profile half-written;
 *   - it returns a profile written by a newer build, or by a text editor, or a truncated string.
 *
 * The rule that falls out of that, and that the tests pin down: NOTHING in this module ever
 * throws, and no storage failure is ever allowed to damage the profile already in memory. A run
 * whose result cannot be persisted is still a run the player finished, and they keep it until the
 * tab closes. Reads are sanitised field by field onto a freshly created profile, so an unknown or
 * mistyped field is dropped rather than inherited.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/**
 * Bumped whenever the persisted shape changes in a way that `sanitize()` cannot silently absorb.
 * The storage KEY deliberately does not carry the version: a newer build must be able to find and
 * salvage an older save rather than start the player from nothing.
 */
export const PROFILE_VERSION = 1;

/** Where the profile lives in the injected storage. Stable across versions — see above. */
export const STORAGE_KEY = 'skid.game.profile';

/**
 * The six grades on the shift roster.
 *
 * The thresholds are set so a competent player reaches the top in roughly six to eight hours of
 * play. The arithmetic behind that, so it can be argued with: a three-minute mission run at a
 * decent standard scores around 3000 and takes a silver, which is 3000 * XP.perPoint + 90 = 150
 * XP, i.e. about 50 XP per minute of play. 20000 XP at that rate is 400 minutes, near seven
 * hours, and a sloppier player earning 35 XP/min gets there in ten. If mission scoring is
 * retuned, retune `XP.perPoint` to hold the 50 XP/min figure rather than moving these thresholds,
 * because the rank titles are referenced in mission briefs and badge text.
 */
export const RANKS = Object.freeze([
  Object.freeze({ id: 'TRAINEE', title: 'Trainee', xp: 0 }),
  Object.freeze({ id: 'OPERATOR', title: 'Operator', xp: 1200 }),
  Object.freeze({ id: 'SENIOR', title: 'Senior Operator', xp: 3500 }),
  Object.freeze({ id: 'ENGINEER', title: 'Control Engineer', xp: 7500 }),
  Object.freeze({ id: 'CHIEF', title: 'Chief Operator', xp: 13000 }),
  Object.freeze({ id: 'SUPERINTENDENT', title: 'Plant Superintendent', xp: 20000 }),
]);

/**
 * The feature gate, in the order the missions hand it out. `detail` is written to be shown to the
 * player on the unlock card, so it says what the feature FIXES rather than what it is.
 */
export const UNLOCKS = Object.freeze({
  manual: Object.freeze({
    id: 'manual',
    label: 'Manual output',
    detail: 'Drive the pumps by hand. Everything else on this list exists because this is exhausting.',
  }),
  proportional: Object.freeze({
    id: 'proportional',
    label: 'Proportional action',
    detail: 'Gain: output moves in proportion to error. It reacts instantly and it never quite arrives.',
  }),
  reset: Object.freeze({
    id: 'reset',
    label: 'Reset (integral)',
    detail: 'Removes the offset proportional alone leaves behind. Brings its own overshoot and windup.',
  }),
  derivative: Object.freeze({
    id: 'derivative',
    label: 'Derivative',
    detail: 'Acts on the rate of change, so a slow header can be caught before it overshoots. Hates noise.',
  }),
  spWeight: Object.freeze({
    id: 'spWeight',
    label: 'Setpoint weighting',
    detail: 'Softens the kick a setpoint step gives the output without detuning the response to upsets.',
  }),
  staging: Object.freeze({
    id: 'staging',
    label: 'Lead/lag staging',
    detail: 'Brings the second pump on and off automatically, with the delays that stop it short-cycling.',
  }),
  rotation: Object.freeze({
    id: 'rotation',
    label: 'Duty rotation',
    detail: 'Shares runtime between the machines so one of them does not wear out alone.',
  }),
  cascade: Object.freeze({
    id: 'cascade',
    label: 'Cascade control',
    detail: 'An inner flow loop takes the fast disturbances so the outer pressure loop never sees them.',
  }),
  feedforward: Object.freeze({
    id: 'feedforward',
    label: 'Feedforward',
    detail: 'Acts on the measured demand before the error exists. The only answer to a large, fast upset.',
  }),
  gainSchedule: Object.freeze({
    id: 'gainSchedule',
    label: 'Gain scheduling',
    detail: 'One tuning cannot fit a pump curve end to end. This carries a set per operating region.',
  }),
  autotune: Object.freeze({
    id: 'autotune',
    label: 'Relay autotuner',
    detail: 'Measures the loop instead of guessing at it, and hands you ranked tuning rules.',
  }),
  analysis: Object.freeze({
    id: 'analysis',
    label: 'Analysis views',
    detail: 'Bode, Nyquist and the loop diagnostics: the evidence behind every number you just set.',
  }),
});

/** The unlock ids in award order — for the progression ladder in the UI. */
export const UNLOCK_ORDER = Object.freeze(Object.keys(UNLOCKS));

/** The one capability a fresh profile already holds: you can always drive the rig by hand. */
export const BASE_UNLOCK = 'manual';

/**
 * The XP economy. Kept as one frozen table because these numbers only make sense relative to each
 * other and to the rank thresholds above; changing one in isolation is how a progression curve
 * quietly breaks.
 */
export const XP = Object.freeze({
  /** Awarded for finishing, by the medal taken. */
  medal: Object.freeze({ none: 15, bronze: 50, silver: 90, gold: 150 }),
  /** XP per point of mission score. Set so a competent run pays about 50 XP per minute. */
  perPoint: 0.02,
  /** One-off, the first time a mission is finished without failing. */
  firstClear: 150,
  /** A failed shift still taught something, and a zero would make players quit rather than retry. */
  failed: 10,
  /** Endless pays per wave survived on top of its score, because depth is the point of that mode. */
  perWave: 20,
  /** The daily is worth playing once and not worth grinding, so its bonus is flat. */
  dailyBonus: 60,
  /** No single run may be worth more than this, so a marathon endless cannot vault a whole rank. */
  runCap: 600,
});

/** Medal names in ascending order, so "never downgrade a medal" is a comparison and not a table. */
const MEDAL_ORDER = Object.freeze(['none', 'bronze', 'silver', 'gold']);

/**
 * How many days of daily-challenge results to keep. Sixty is two months of history, which is more
 * than any UI shows, and it bounds the saved string so a profile cannot grow without limit in a
 * storage that is typically capped at a few megabytes for the whole origin.
 */
const DAILY_KEEP = 60;

/** Sanity bounds on anything read back from storage, so a hand-edited file cannot blow up the UI. */
const XP_MAX = 1e9;
const MAX_MISSIONS = 500;
const MAX_BADGES = 300;
const ID_MAX_LEN = 64;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A finite number, or the fallback. Guards every value that arrives from storage, from a caller,
 * or from a scoring result — a single NaN reaching `xp` would make every later comparison false
 * and silently freeze the player's rank.
 * @param {*} x the candidate value
 * @param {number} dflt what to use when it is not a usable number
 * @returns {number} a finite number
 */
function finite(x, dflt) {
  return typeof x === 'number' && Number.isFinite(x) ? x : dflt;
}

/**
 * A non-negative whole number, for counters and scores.
 * @param {*} x the candidate value
 * @returns {number} a whole number, at least zero
 */
function whole(x) {
  return Math.max(0, Math.round(finite(x, 0)));
}

/**
 * True for a plain object we are willing to read fields from. Arrays and null are rejected here
 * so the callers do not each have to remember that `typeof null === 'object'`.
 * @param {*} x the candidate value
 * @returns {boolean} whether it can be treated as a record
 */
function isRecord(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * A usable identifier: a short, non-empty string.
 * @param {*} x the candidate value
 * @returns {boolean} whether it can be used as a key
 */
function isId(x) {
  return typeof x === 'string' && x.length > 0 && x.length <= ID_MAX_LEN;
}

/**
 * Normalise a medal name to one of the four known ones.
 * @param {*} m the candidate medal
 * @returns {string} 'none', 'bronze', 'silver' or 'gold'
 */
function normMedal(m) {
  return MEDAL_ORDER.includes(m) ? m : 'none';
}

/**
 * The better of two medals.
 * @param {string} a one medal name
 * @param {string} b the other
 * @returns {string} whichever is higher
 */
function bestMedal(a, b) {
  return MEDAL_ORDER.indexOf(normMedal(a)) >= MEDAL_ORDER.indexOf(normMedal(b)) ? normMedal(a) : normMedal(b);
}

/**
 * A blank per-mission record.
 * @returns {object} the record
 */
function blankMission() {
  return { plays: 0, cleared: false, best: 0, medal: 'none', bestTime_s: 0 };
}

/**
 * Create an empty profile. Never reads storage and never fails, so it is also the fallback for
 * every load path below.
 * @returns {object} a fresh profile
 */
export function createProfile() {
  return {
    v: PROFILE_VERSION,
    xp: 0,
    rank: RANKS[0].id,
    unlocks: [BASE_UNLOCK],
    badges: [],
    missions: {},
    endless: { plays: 0, best: 0, bestWave: 0 },
    daily: {},
    stats: {
      runs: 0, cleared: 0, failed: 0, gold: 0, silver: 0, bronze: 0, points: 0, seconds: 0,
    },
  };
}

/**
 * The rank held at a given XP total.
 * @param {number} xp experience points
 * @returns {object} the rank record; the lowest rank for nonsense input
 */
export function rankFor(xp) {
  const x = finite(xp, 0);
  let r = RANKS[0];
  for (let i = 0; i < RANKS.length; i += 1) if (x >= RANKS[i].xp) r = RANKS[i];
  return r;
}

/**
 * The rank after the one held at a given XP total — what the progress bar is filling towards.
 * @param {number} xp experience points
 * @returns {object|null} the next rank, or null at the top of the roster
 */
export function nextRankFor(xp) {
  const x = finite(xp, 0);
  for (let i = 0; i < RANKS.length; i += 1) if (RANKS[i].xp > x) return RANKS[i];
  return null;
}

/**
 * Add experience and re-derive the rank.
 *
 * Negative and non-finite amounts are ignored rather than refused, because this is called from
 * the end of a run where throwing or unwinding would cost the player the result they just earned;
 * the return value still reports the true state so a caller can notice nothing happened.
 * @param {object} profile the profile to credit
 * @param {number} n experience to add; ignored unless it is a positive finite number
 * @returns {{xp:number, rank:object, rankUp:boolean}} the totals after the award
 */
export function addXp(profile, n) {
  if (!isRecord(profile)) return { xp: 0, rank: RANKS[0], rankUp: false };
  const before = rankFor(profile.xp);
  const add = finite(n, 0);
  if (add > 0) profile.xp = clamp(finite(profile.xp, 0) + add, 0, XP_MAX);
  const after = rankFor(profile.xp);
  profile.rank = after.id;
  return { xp: profile.xp, rank: after, rankUp: after.id !== before.id };
}

/**
 * Whether a feature has been earned.
 *
 * Ids outside `UNLOCKS` answer false. That is deliberate and it is the safe direction: a gate the
 * table does not describe is a gate nobody has written a mission to open, and answering true
 * would hand the player a control term with no lesson attached to it.
 * @param {object} profile the profile
 * @param {string} id an unlock id
 * @returns {boolean} whether it is held
 */
export function isUnlocked(profile, id) {
  if (!isRecord(profile) || !Array.isArray(profile.unlocks)) return false;
  if (!Object.prototype.hasOwnProperty.call(UNLOCKS, id)) return false;
  return profile.unlocks.indexOf(id) >= 0;
}

/**
 * Grant a feature.
 * @param {object} profile the profile to modify
 * @param {string} id an unlock id from `UNLOCKS`
 * @returns {boolean} true only if this call is what granted it, so the caller can raise a card
 */
export function unlock(profile, id) {
  if (!isRecord(profile)) return false;
  if (!Object.prototype.hasOwnProperty.call(UNLOCKS, id)) return false;
  if (!Array.isArray(profile.unlocks)) profile.unlocks = [BASE_UNLOCK];
  if (profile.unlocks.indexOf(id) >= 0) return false;
  profile.unlocks.push(id);
  return true;
}

/**
 * Record a badge.
 *
 * The badge table lives in `badges.js` and is deliberately NOT imported: badges are cosmetic, the
 * two modules would otherwise import each other, and a badge id that has since been retired
 * should stay in an old profile rather than be silently deleted on load.
 * @param {object} profile the profile to modify
 * @param {string} id the badge id
 * @returns {boolean} true only if it is newly earned
 */
export function awardBadge(profile, id) {
  if (!isRecord(profile) || !isId(id)) return false;
  if (!Array.isArray(profile.badges)) profile.badges = [];
  if (profile.badges.indexOf(id) >= 0) return false;
  if (profile.badges.length >= MAX_BADGES) return false;
  profile.badges.push(id);
  return true;
}

/**
 * Fold one finished run into the lifetime counters that badges are checked against.
 * @param {object} profile the profile to modify
 * @param {string} medal the medal taken
 * @param {boolean} failed whether the shift was failed
 * @param {number} score the run score
 * @param {number} duration_s how long the run lasted, s
 * @returns {void}
 */
function bumpStats(profile, medal, failed, score, duration_s) {
  const s = profile.stats;
  s.runs += 1;
  s.points += Math.max(0, score);
  s.seconds += Math.max(0, duration_s);
  if (failed) s.failed += 1;
  else {
    s.cleared += 1;
    if (medal === 'gold') s.gold += 1;
    else if (medal === 'silver') s.silver += 1;
    else if (medal === 'bronze') s.bronze += 1;
  }
}

/**
 * Record a campaign mission result.
 *
 * The mission's own `unlocks` list is NOT applied here — this module knows nothing about the
 * mission table, deliberately, so that the two do not import each other. The session applies them
 * through `unlock()` once it has decided the mission was actually passed.
 * @param {object} profile the profile to modify
 * @param {string} missionId the mission's id
 * @param {object} result a finished score result {score, medal, failed, duration_s}
 * @returns {{best:number, medal:string, xpGained:number, firstClear:boolean}|{ok:false, reason:string}}
 *   the best score and best medal now held for that mission, or a refusal for unusable arguments
 */
export function recordMission(profile, missionId, result) {
  if (!isRecord(profile)) return { ok: false, reason: 'There is no profile to record this run against.' };
  if (!isId(missionId)) return { ok: false, reason: 'That run has no mission id, so it cannot be filed.' };
  if (!isRecord(result)) return { ok: false, reason: 'That run produced no result to record.' };

  if (!isRecord(profile.missions)) profile.missions = {};
  const entry = isRecord(profile.missions[missionId])
    ? profile.missions[missionId]
    : blankMission();

  const score = finite(result.score, 0);
  const failed = result.failed === true;
  const medal = failed ? 'none' : normMedal(result.medal);
  const duration_s = Math.max(0, finite(result.duration_s, 0));
  const firstClear = !failed && entry.cleared !== true;

  let xpGained = XP.failed;
  if (!failed) {
    xpGained = XP.medal[medal] + Math.max(0, score) * XP.perPoint + (firstClear ? XP.firstClear : 0);
  }
  xpGained = Math.round(clamp(xpGained, 0, XP.runCap));

  entry.plays = whole(entry.plays) + 1;
  entry.cleared = entry.cleared === true || !failed;
  entry.best = Math.max(finite(entry.best, 0), score);
  entry.medal = bestMedal(entry.medal, medal);
  const prevTime_s = Math.max(0, finite(entry.bestTime_s, 0));
  if (!failed && duration_s > 0) {
    entry.bestTime_s = prevTime_s > 0 ? Math.min(prevTime_s, duration_s) : duration_s;
  } else entry.bestTime_s = prevTime_s;
  profile.missions[missionId] = entry;

  bumpStats(profile, medal, failed, score, duration_s);
  addXp(profile, xpGained);

  return { best: entry.best, medal: entry.medal, xpGained, firstClear };
}

/**
 * Record an endless run.
 * @param {object} profile the profile to modify
 * @param {object} result a finished result {score, wave, duration_s, failed}
 * @returns {{best:number, bestWave:number, xpGained:number}|{ok:false, reason:string}} the bests
 *   now held, or a refusal for unusable arguments
 */
export function recordEndless(profile, result) {
  if (!isRecord(profile)) return { ok: false, reason: 'There is no profile to record this run against.' };
  if (!isRecord(result)) return { ok: false, reason: 'That run produced no result to record.' };
  if (!isRecord(profile.endless)) profile.endless = { plays: 0, best: 0, bestWave: 0 };

  const score = finite(result.score, 0);
  const wave = whole(result.wave);
  const duration_s = Math.max(0, finite(result.duration_s, 0));

  const e = profile.endless;
  e.plays = whole(e.plays) + 1;
  e.best = Math.max(finite(e.best, 0), score);
  e.bestWave = Math.max(whole(e.bestWave), wave);

  const xpGained = Math.round(clamp(Math.max(0, score) * XP.perPoint + wave * XP.perWave, 0, XP.runCap));
  bumpStats(profile, 'none', result.failed === true, score, duration_s);
  addXp(profile, xpGained);

  return { best: e.best, bestWave: e.bestWave, xpGained };
}

/**
 * Drop the oldest daily results. 'YYYY-MM-DD' sorts lexicographically in date order, which is the
 * whole reason the daily key is that string and not a number.
 * @param {object} daily the map of date to result
 * @returns {object} the same map, pruned
 */
function pruneDaily(daily) {
  const keys = Object.keys(daily).sort();
  for (let i = 0; i < keys.length - DAILY_KEEP; i += 1) delete daily[keys[i]];
  return daily;
}

/**
 * Record a daily-challenge run. Every player gets the same rig for a given date, so only the best
 * attempt of that date is kept — the number that is worth comparing with anyone else.
 * @param {object} profile the profile to modify
 * @param {string} dateStr the challenge date, 'YYYY-MM-DD'
 * @param {object} result a finished result {score, medal, failed, duration_s}
 * @returns {{best:number, medal:string, xpGained:number, firstToday:boolean}|{ok:false, reason:string}}
 *   the best now held for that date, or a refusal for unusable arguments
 */
export function recordDaily(profile, dateStr, result) {
  if (!isRecord(profile)) return { ok: false, reason: 'There is no profile to record this run against.' };
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) {
    return { ok: false, reason: 'A daily result needs a date in YYYY-MM-DD form.' };
  }
  if (!isRecord(result)) return { ok: false, reason: 'That run produced no result to record.' };
  if (!isRecord(profile.daily)) profile.daily = {};

  const score = finite(result.score, 0);
  const failed = result.failed === true;
  const medal = failed ? 'none' : normMedal(result.medal);
  const duration_s = Math.max(0, finite(result.duration_s, 0));

  const prev = isRecord(profile.daily[dateStr]) ? profile.daily[dateStr] : null;
  const firstToday = !prev;
  const entry = {
    plays: (prev ? whole(prev.plays) : 0) + 1,
    best: Math.max(prev ? finite(prev.best, 0) : score, score),
    medal: bestMedal(prev ? prev.medal : 'none', medal),
  };
  profile.daily[dateStr] = entry;
  pruneDaily(profile.daily);

  const xpGained = Math.round(clamp(
    XP.medal[medal] + Math.max(0, score) * XP.perPoint + (firstToday ? XP.dailyBonus : 0),
    0,
    XP.runCap,
  ));
  bumpStats(profile, medal, failed, score, duration_s);
  addXp(profile, xpGained);

  return { best: entry.best, medal: entry.medal, xpGained, firstToday };
}

/**
 * Wipe a profile back to a fresh one, IN PLACE.
 *
 * In place because the UI, the session and the HUD are all holding this same object; handing back
 * a new one would leave two of the three still pointing at the old record and reporting a rank
 * the player no longer has.
 * @param {object} profile the profile to wipe
 * @returns {void}
 */
export function resetProfile(profile) {
  if (!isRecord(profile)) return;
  const fresh = createProfile();
  for (const k of Object.keys(profile)) delete profile[k];
  for (const k of Object.keys(fresh)) profile[k] = fresh[k];
}

/**
 * Rebuild a trustworthy profile from an untrusted object, field by field.
 *
 * Everything is copied onto a fresh profile rather than the untrusted object being patched, so an
 * unknown key cannot survive, a mistyped key cannot shadow a real one, and a truncated save
 * simply keeps its defaults. Rank is always RE-DERIVED from XP and never read, which means a
 * hand-edited `"rank":"CHIEF"` buys nothing.
 * @param {*} raw the parsed candidate
 * @param {Array<string>} problems collects a sentence per rejected field
 * @returns {object} a valid profile
 */
function sanitize(raw, problems) {
  const p = createProfile();
  if (!isRecord(raw)) {
    problems.push('The saved profile was not a profile at all, so a new one was started.');
    return p;
  }

  const v = finite(raw.v, 0);
  if (v > PROFILE_VERSION) {
    problems.push('That profile was written by a newer version; anything this build does not understand was left out.');
  }

  p.xp = clamp(Math.max(0, finite(raw.xp, 0)), 0, XP_MAX);

  if (Array.isArray(raw.unlocks)) {
    for (const id of raw.unlocks) {
      if (Object.prototype.hasOwnProperty.call(UNLOCKS, id)) {
        if (p.unlocks.indexOf(id) < 0) p.unlocks.push(id);
      } else problems.push(`Unknown unlock "${String(id).slice(0, ID_MAX_LEN)}" was ignored.`);
    }
  } else if (raw.unlocks !== undefined) problems.push('The unlock list was not a list and was ignored.');

  if (Array.isArray(raw.badges)) {
    for (const id of raw.badges) {
      if (isId(id) && p.badges.indexOf(id) < 0 && p.badges.length < MAX_BADGES) p.badges.push(id);
    }
  } else if (raw.badges !== undefined) problems.push('The badge list was not a list and was ignored.');

  if (isRecord(raw.missions)) {
    const ids = Object.keys(raw.missions).slice(0, MAX_MISSIONS);
    for (const id of ids) {
      const m = raw.missions[id];
      if (!isId(id) || !isRecord(m)) {
        problems.push('A mission record was malformed and was dropped.');
        continue;
      }
      p.missions[id] = {
        plays: whole(m.plays),
        cleared: m.cleared === true,
        best: finite(m.best, 0),
        medal: normMedal(m.medal),
        bestTime_s: Math.max(0, finite(m.bestTime_s, 0)),
      };
    }
  } else if (raw.missions !== undefined) problems.push('The mission history was malformed and was dropped.');

  if (isRecord(raw.endless)) {
    p.endless = {
      plays: whole(raw.endless.plays),
      best: finite(raw.endless.best, 0),
      bestWave: whole(raw.endless.bestWave),
    };
  } else if (raw.endless !== undefined) problems.push('The endless record was malformed and was dropped.');

  if (isRecord(raw.daily)) {
    for (const day of Object.keys(raw.daily)) {
      const d = raw.daily[day];
      if (!DATE_RE.test(day) || !isRecord(d)) {
        problems.push('A daily record had no usable date and was dropped.');
        continue;
      }
      p.daily[day] = { plays: whole(d.plays), best: finite(d.best, 0), medal: normMedal(d.medal) };
    }
    pruneDaily(p.daily);
  } else if (raw.daily !== undefined) problems.push('The daily history was malformed and was dropped.');

  if (isRecord(raw.stats)) {
    for (const k of Object.keys(p.stats)) p.stats[k] = whole(raw.stats[k]);
  } else if (raw.stats !== undefined) problems.push('The lifetime statistics were malformed and were reset.');

  p.rank = rankFor(p.xp).id;
  return p;
}

/**
 * Read the profile from injected storage.
 *
 * Always returns a usable profile. A missing storage, a `getItem` that throws, an empty string,
 * a truncated JSON fragment and a save from a future build all land on the same path: take what
 * can be understood, discard the rest, never throw.
 * @param {{getItem:Function}|null} storage anything with `getItem`, or null
 * @returns {object} a valid profile
 */
export function loadProfile(storage) {
  if (!storage || typeof storage.getItem !== 'function') return createProfile();
  let text = null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return createProfile();
  }
  if (typeof text !== 'string' || text.length === 0) return createProfile();
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return createProfile();
  }
  return sanitize(raw, []);
}

/**
 * Write the profile to injected storage.
 *
 * A failure here is reported, never thrown and never allowed to touch `profile`: `setItem`
 * throwing is the normal state of affairs in Safari's private mode and at quota, and it happens
 * at the end of a good run. The player keeps that run in memory either way; all they lose is the
 * next reload.
 * @param {{setItem:Function}|null} storage anything with `setItem`, or null
 * @param {object} profile the profile to persist
 * @returns {{ok:boolean, reason?:string}} ok, or a sentence an operator could read
 */
export function saveProfile(storage, profile) {
  if (!isRecord(profile)) return { ok: false, reason: 'There is no profile to save.' };
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, reason: 'This browser is not offering any storage, so progress will only last until the tab closes.' };
  }
  let text = '';
  try {
    text = JSON.stringify({ ...profile, v: PROFILE_VERSION });
  } catch {
    return { ok: false, reason: 'The profile could not be turned into text and was not saved.' };
  }
  try {
    storage.setItem(STORAGE_KEY, text);
  } catch {
    return { ok: false, reason: 'The browser refused to save progress — private browsing or a full storage quota. This shift still counts until you close the tab.' };
  }
  return { ok: true };
}

/**
 * Serialise a profile for the player to copy out and keep.
 * @param {object} profile the profile to export
 * @returns {string} JSON text; '{}' if there is nothing exportable
 */
export function exportProfile(profile) {
  if (!isRecord(profile)) return '{}';
  try {
    return JSON.stringify({ ...profile, v: PROFILE_VERSION }, null, 1);
  } catch {
    return '{}';
  }
}

/**
 * Replace a profile from exported text, IN PLACE.
 *
 * The candidate is sanitised in full BEFORE anything is written, so a half-valid paste cannot
 * leave the player with half a profile; either the whole import lands or nothing moves. `problems`
 * is populated even on success, because a field that was quietly dropped is exactly the thing a
 * player needs told.
 * @param {object} profile the profile to overwrite
 * @param {string} text exported profile text
 * @returns {{ok:boolean, problems:Array<string>}} whether it landed, and what was discarded
 */
export function importProfile(profile, text) {
  const problems = [];
  if (!isRecord(profile)) return { ok: false, problems: ['There is no profile to import into.'] };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, problems: ['There was nothing to import.'] };
  }
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['That is not a profile — the text could not be read as JSON.'] };
  }
  if (isRecord(raw) && isRecord(raw.profile)) raw = raw.profile;
  if (!isRecord(raw)) return { ok: false, problems: ['That text held no profile.'] };
  const fresh = sanitize(raw, problems);
  for (const k of Object.keys(profile)) delete profile[k];
  for (const k of Object.keys(fresh)) profile[k] = fresh[k];
  return { ok: true, problems };
}
