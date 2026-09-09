/**
 * src/ui/arcade.js — the board: where the player is when they are NOT on shift.
 *
 * Layer L6. Reads the profile and the campaign table, starts runs through the bound actions, and
 * writes nothing itself.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS SCREEN IS SHAPED LIKE A NOTICE BOARD
 *
 * Everything a player is owed between shifts is a comparison, and a comparison has to be visible
 * without being asked for. What did I score last time. What does gold cost on this one. What is
 * still locked, and what will open it. Which of the twenty-eight badges have I not seen yet. A
 * menu that answers those only after a click is a menu that gets clicked once.
 *
 * So the board carries its numbers on its face: every mission card shows its own best and medal,
 * every locked card names the shift that opens it, and the badge case shows the ones not yet
 * earned as silhouettes rather than hiding them. The player should be able to plan the next hour
 * from one screen without opening anything.
 *
 * THE RESULT PANEL is the exception to the house rules about restraint, deliberately. The 16px
 * type cap in tokens.css exists so that a PLANT screen cannot shout — an operator watching a
 * header does not need a number the size of a fist. The scorecard is not a plant screen: it is
 * shown between shifts, over a scrim, when nothing is being controlled, and it is the one moment
 * the game is allowed to be loud. It breaks the cap in `styles/arcade.css` and nowhere else.
 *
 * WHAT THIS MODULE ASSUMES ABOUT THE SESSION
 *
 * As little as it can. `A.gameView()` is the preferred way to reach the session snapshot, but the
 * board renders its whole campaign, badge case and mode panels from the PROFILE alone, so a build
 * in which the session is not yet wired shows everything except the live-run banner and the
 * scorecard, rather than showing nothing. Every action is called through {@link fire}, which
 * refuses politely if the surface does not carry it — an unwired button says so in a toast rather
 * than throwing inside a frame callback and taking the animation loop down with it.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { h, setText, setAttr, cls, num, dur } from './dom.js';
import {
  TIERS, MISSIONS, missionsForTier, missionById, missionNeeds, nextMission, missionCleared,
} from '../game/missions.js';
import { UNLOCKS, rankFor, nextRankFor, isUnlocked, createProfile } from '../game/profile.js';
import { BADGES, hasBadge } from '../game/badges.js';
import { seedCode, parseSeedCode, dailySeed, hashSeed } from '../game/rng.js';

/**
 * The two session phases that mean a shift is over and the scorecard is owed.
 *
 * Restated here rather than imported from `src/game/session.js` on purpose: the board must render
 * from the profile alone in a build where the session module is absent, and an import would make
 * that impossible. They are compared as plain strings, so a divergence shows up as a scorecard
 * that never appears — which is why {@link isOver} is one line and covered by a test.
 */
export const OVER_PHASES = Object.freeze(['RESULT', 'FAILED']);

/** Medal ids in ascending worth, so "which is better" is an index comparison. */
export const MEDAL_ORDER = Object.freeze(['none', 'bronze', 'silver', 'gold']);

/** What each medal is called on the card. */
const MEDAL_LABEL = Object.freeze({
  none: 'No medal', bronze: 'Bronze', silver: 'Silver', gold: 'Gold',
});

/** Human names for the modes, for the scorecard header. */
const MODE_LABEL = Object.freeze({
  CAMPAIGN: 'Campaign shift',
  ENDLESS: 'Endless',
  DAILY: 'Daily challenge',
  FAULT: 'Fault hunt',
  SANDBOX: 'Free play',
});

/** How fast the scorecard's total climbs: fraction of the remaining gap closed per repaint. */
const COUNT_RATE = 0.14;

/** Below this many points remaining, the count-up snaps rather than crawling the last few. */
const COUNT_SNAP = 4;

// ==============================================================================================
// PURE MODEL — everything below here is testable with no DOM, and is tested that way.
// ==============================================================================================

/**
 * A finite number or a fallback. The profile is persisted and importable, so every field read out
 * of it has to survive having been a string, a null or a NaN at some point.
 * @param {*} v the candidate
 * @param {number} d the fallback
 * @returns {number} a finite number
 */
function fin(v, d) {
  return Number.isFinite(v) ? v : d;
}

/**
 * Normalise a medal id.
 * @param {*} v the candidate
 * @returns {string} one of {@link MEDAL_ORDER}, defaulting to 'none'
 */
function medalId(v) {
  return typeof v === 'string' && MEDAL_ORDER.includes(v) ? v : 'none';
}

/**
 * Whether a session phase means the shift has ended and the scorecard is due.
 * @param {*} phase the phase id from the session view
 * @returns {boolean} true when the run is over
 */
export function isOver(phase) {
  return typeof phase === 'string' && OVER_PHASES.includes(phase);
}

/**
 * The calendar date the daily challenge keys on, as 'YYYY-MM-DD'.
 *
 * LOCAL date parts, not the ISO string off the Date object. `toISOString()` is UTC, so a player
 * west of Greenwich would be handed tomorrow's rig in the afternoon and would find their own
 * morning score filed under a date they cannot reach any more. The daily is a calendar day where
 * the player is standing.
 *
 * @param {Date} date the clock reading, injected so this is testable
 * @returns {string} the date string, or '' if that was not a usable Date
 */
export function isoDate(date) {
  if (!date || typeof date.getFullYear !== 'function' || Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The session snapshot, from whichever shape the action surface is offering.
 *
 * Three shapes are accepted because the wiring is owned by another module and the board must not
 * break whichever one lands: a query on the bound surface (`A.gameView()`, the preferred form and
 * the one that matches `A.summary()`), a session object carrying its own bound `view()`, or a
 * plain snapshot already hanging off `A.game`.
 *
 * @param {object|null} A the bound action surface
 * @returns {object|null} the snapshot, or null when there is no session wired up
 */
export function readView(A) {
  if (!A || typeof A !== 'object') return null;
  try {
    if (typeof A.gameView === 'function') return A.gameView() || null;
    const g = A.game;
    if (!g || typeof g !== 'object') return null;
    if (typeof g.view === 'function') return g.view() || null;
    if (g.view && typeof g.view === 'object') return g.view;
    return null;
  } catch {
    // A session mid-construction is a normal state during boot, and a snapshot that throws must
    // cost the live banner, not the whole board.
    return null;
  }
}

/**
 * What one mission's line in the profile says, whatever shape it arrived in.
 * @param {object|null} profile the player profile
 * @param {string} id the mission id
 * @returns {{best:number, medal:string, plays:number, cleared:boolean}} the record
 */
export function missionRecord(profile, id) {
  const blank = { best: 0, medal: 'none', plays: 0, cleared: false };
  if (!profile || typeof id !== 'string') return blank;
  let rec = null;
  try {
    const store = profile.missions;
    if (store && typeof store === 'object') {
      rec = Array.isArray(store) ? store.find((x) => x && x.id === id) : store[id];
    }
  } catch {
    rec = null;
  }
  const cleared = missionCleared(profile, id);
  if (!rec || typeof rec !== 'object') {
    return { ...blank, cleared, best: typeof rec === 'number' ? Math.max(0, rec) : 0 };
  }
  return {
    best: Math.max(0, fin(rec.best, 0)),
    medal: medalId(rec.medal),
    plays: Math.max(0, Math.floor(fin(rec.plays, 0))),
    cleared,
  };
}

/**
 * The rank and the bar filling towards the next one.
 *
 * The bar is drawn against the SPAN BETWEEN THE TWO RANKS, not against the next rank's absolute
 * threshold. Drawn the other way, a Trainee at 1199 XP shows a bar that is already 99% full and a
 * Senior Operator at 3600 shows one that has gone backwards to 28% — which reads as a bug rather
 * than as a promotion.
 *
 * @param {object|null} profile the player profile
 * @returns {{xp:number, rank:object, next:?object, into:number, span:number, frac:number,
 *   toNext:number, atTop:boolean}} the bar model
 */
export function xpBar(profile) {
  const xp = Math.max(0, fin(profile && profile.xp, 0));
  const rank = rankFor(xp);
  const next = nextRankFor(xp);
  const span = next ? Math.max(1, next.xp - rank.xp) : 1;
  const into = Math.max(0, xp - rank.xp);
  return {
    xp,
    rank,
    next,
    into,
    span,
    frac: next ? clamp(into / span, 0, 1) : 1,
    toNext: next ? Math.max(0, next.xp - xp) : 0,
    atTop: !next,
  };
}

/**
 * Medals held across the whole campaign, counted from the best medal on each mission.
 * @param {object|null} profile the player profile
 * @returns {{gold:number, silver:number, bronze:number, medals:number, cleared:number, of:number}}
 *   the tally
 */
export function medalTally(profile) {
  const t = { gold: 0, silver: 0, bronze: 0, medals: 0, cleared: 0, of: MISSIONS.length };
  for (const m of MISSIONS) {
    const rec = missionRecord(profile, m.id);
    if (rec.cleared) t.cleared += 1;
    if (rec.medal !== 'none') { t[rec.medal] += 1; t.medals += 1; }
  }
  return t;
}

/**
 * Badges held out of the badges that exist.
 * @param {object|null} profile the player profile
 * @returns {{held:number, of:number}} the tally
 */
export function badgeTally(profile) {
  let held = 0;
  for (const b of BADGES) if (hasBadge(profile, b.id)) held += 1;
  return { held, of: BADGES.length };
}

/**
 * One mission's card: everything printed on it, and whether it can be started.
 *
 * A card is locked by an unfinished PREREQUISITE, and separately by a controller feature the
 * profile has not been granted. The second case should be unreachable — `validateMissions()`
 * proves every feature a mission needs is handed out by a mission earlier in the same chain — but
 * it is checked anyway, because the alternative failure is a player dropped into a shift whose
 * brief tells them to use a button that is not on the faceplate, with nothing on screen to say
 * why. A locked card that names the missing piece is recoverable; that is not.
 *
 * @param {object|null} profile the player profile
 * @param {object} mission a mission record from the campaign table
 * @returns {?object} the card model, or null if that was not a mission
 */
export function missionCard(profile, mission) {
  if (!mission || typeof mission !== 'object' || typeof mission.id !== 'string') return null;
  const rec = missionRecord(profile, mission.id);
  const unmet = (mission.requires || []).filter((r) => !missionCleared(profile, r));
  const missing = missionNeeds(mission).filter((f) => !isUnlocked(profile, f));

  let lockNote = '';
  if (unmet.length) {
    const prev = missionById(unmet[0]);
    lockNote = `Clear "${prev ? prev.title : unmet[0]}" first.`;
  } else if (missing.length) {
    const u = UNLOCKS[missing[0]];
    lockNote = `Needs ${u ? u.label.toLowerCase() : missing[0]}, which an earlier shift hands out.`;
  }

  return {
    id: mission.id,
    tier: mission.tier,
    title: mission.title,
    teaches: mission.teaches,
    brief: mission.brief,
    duration_s: mission.duration_s,
    band: mission.band,
    bandEU: (mission.rules && mission.rules.bandEU) || '',
    par: mission.par,
    unlocks: (mission.unlocks || []).map((id) => (UNLOCKS[id] ? UNLOCKS[id].label : id)),
    locked: unmet.length > 0 || missing.length > 0,
    lockNote,
    blockedBy: unmet.slice(),
    missingFeatures: missing,
    cleared: rec.cleared,
    best: rec.best,
    medal: rec.medal,
    plays: rec.plays,
  };
}

/**
 * The campaign, grouped into its five tiers in play order.
 * @param {object|null} profile the player profile
 * @returns {Array<{tier:object, missions:object[], cleared:number, of:number, open:boolean,
 *   golds:number}>} one entry per tier, always all five, even when a tier is entirely locked
 */
export function tierRails(profile) {
  return TIERS.map((tier) => {
    const cards = missionsForTier(tier.n).map((m) => missionCard(profile, m)).filter(Boolean);
    return {
      tier,
      missions: cards,
      cleared: cards.filter((c) => c.cleared).length,
      golds: cards.filter((c) => c.medal === 'gold').length,
      of: cards.length,
      open: cards.some((c) => !c.locked),
    };
  });
}

/**
 * The badge case. Unearned hidden badges keep their slot but give away neither name nor rule —
 * a hidden badge whose title is on display is not hidden, and a hidden badge with no slot at all
 * leaves the player counting 25 of 28 with nowhere to put the other three.
 * @param {object|null} profile the player profile
 * @returns {Array<{id:string, title:string, detail:string, earned:boolean, hidden:boolean,
 *   silhouette:boolean}>} one entry per badge, in table order
 */
export function badgeCase(profile) {
  return BADGES.map((b) => {
    const earned = hasBadge(profile, b.id);
    const silhouette = b.hidden === true && !earned;
    return {
      id: b.id,
      title: silhouette ? '???' : b.title,
      detail: silhouette ? 'A hidden badge. You will know when you have done it.' : b.detail,
      earned,
      hidden: b.hidden === true,
      silhouette,
    };
  });
}

/**
 * Turn what somebody typed into a rig code into a seed, or into a sentence saying why not.
 *
 * The refusal wording matters more than usual here. Codes carry a check byte, so roughly 255 of
 * every 256 well-formed eight-character strings are rejected — a player who mistypes one
 * character gets a refusal, not a different rig, and if the message does not SAY that, the
 * refusal looks like the feature is broken.
 *
 * @param {string} text whatever is in the paste box
 * @returns {{ok:true, seed:number, code:string}|{ok:false, reason:string}} the seed or a refusal
 */
export function parseSeedInput(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'Type a rig code first — eight letters and digits, like ABCD-EFGH.' };
  }
  const seed = parseSeedCode(text);
  if (seed === null) {
    return {
      ok: false,
      reason: 'That is not a rig code from this game. Codes carry a check character, so a single '
        + 'mistyped letter is refused rather than quietly played as somebody else\'s rig.',
    };
  }
  return { ok: true, seed, code: seedCode(seed) };
}

/**
 * A reproducible seed for the "deal me another one" buttons.
 *
 * Endless and Fault Hunt want a fresh rig on demand, and neither `Math.random` nor a clock will
 * do: a rig the player cannot name is a rig they cannot share or replay. So the nth press of the
 * button on a given day is a NAMED rig — the same nth rig everywhere — and the code shown under
 * the button is how it gets shared.
 *
 * @param {string} kind the pack name, e.g. 'endless' or 'hunt'
 * @param {string} dateStr the calendar date, 'YYYY-MM-DD'
 * @param {number} n which rig in the day's pack, from 0
 * @returns {number} a uint32 seed
 */
export function packSeed(kind, dateStr, n) {
  return hashSeed(`${kind}:${dateStr}:${Math.max(0, Math.floor(fin(n, 0)))}`);
}

/**
 * What the daily panel says today.
 * @param {object|null} profile the player profile
 * @param {string} dateStr the calendar date, 'YYYY-MM-DD'
 * @returns {{dateStr:string, seed:number, code:string, best:number, medal:string, plays:number,
 *   played:boolean}} the panel model
 */
export function dailyState(profile, dateStr) {
  const seed = dailySeed(dateStr);
  let rec = null;
  try {
    const store = profile && profile.daily;
    if (store && typeof store === 'object') rec = store[dateStr];
  } catch {
    rec = null;
  }
  const ok = rec && typeof rec === 'object';
  return {
    dateStr,
    seed,
    code: seedCode(seed),
    best: ok ? Math.max(0, fin(rec.best, 0)) : 0,
    medal: ok ? medalId(rec.medal) : 'none',
    plays: ok ? Math.max(0, Math.floor(fin(rec.plays, 0))) : 0,
    played: !!ok,
  };
}

/**
 * Which medal threshold is still ahead of a score, and by how much.
 * @param {number} score the score achieved
 * @param {object} par the mission's `{bronze, silver, gold}` thresholds
 * @returns {{held:string, next:?{id:string, need:number, gap:number}, marks:object[]}} the model
 */
export function parRow(score, par) {
  const s = fin(score, 0);
  const p = par && typeof par === 'object' ? par : {};
  const marks = ['bronze', 'silver', 'gold']
    .filter((id) => Number.isFinite(p[id]))
    .map((id) => ({ id, need: p[id], reached: s >= p[id] }));
  let held = 'none';
  for (const m of marks) if (m.reached) held = m.id;
  const ahead = marks.find((m) => !m.reached) || null;
  return {
    held,
    next: ahead ? { id: ahead.id, need: ahead.need, gap: Math.max(0, ahead.need - s) } : null,
    marks,
  };
}

/**
 * The scorecard, assembled and ordered.
 *
 * THE BREAKDOWN IS NOT RE-SORTED. `score.js` emits its lines in the order a shift is actually
 * argued about — what you earned holding the band, then each way you gave it back, then the
 * one-off events in the order they happened, then the energy bill — and putting the biggest
 * number first would replace an explanation with a leaderboard. The rows are annotated with their
 * sign and passed through untouched, and a test pins both the order and that they still sum to
 * the printed total.
 *
 * @param {object|null} result a `finishScore` result, plus whatever the session added to it
 * @param {object} [opts] context
 * @param {object|null} [opts.mission] the mission record, when this was a campaign shift
 * @param {object|null} [opts.profile] the profile, AFTER the run was recorded
 * @param {string} [opts.mode] the session mode id
 * @param {number} [opts.wave] the endless wave reached
 * @returns {?object} the scorecard model, or null when there is no result to show
 */
export function resultModel(result, opts) {
  if (!result || typeof result !== 'object' || result.ok === false) return null;
  const o = opts && typeof opts === 'object' ? opts : {};
  const mission = o.mission && typeof o.mission === 'object' ? o.mission : null;
  const stats = result.stats && typeof result.stats === 'object' ? result.stats : {};
  const failed = result.failed === true;
  const score = Math.round(fin(result.score, 0));
  const medal = failed ? 'none' : medalId(result.medal);
  const mode = typeof o.mode === 'string' ? o.mode : '';

  const rawLines = Array.isArray(result.breakdown) ? result.breakdown : [];
  const lines = rawLines.map((l) => {
    const points = Math.round(fin(l && l.points, 0));
    return {
      label: String((l && l.label) || ''),
      points,
      kind: points > 0 ? 'gain' : points < 0 ? 'cost' : 'zero',
    };
  });
  let total = 0;
  for (const l of lines) total += l.points;

  const par = mission ? parRow(score, mission.par) : null;
  const used = fin(stats.energy_kWh, NaN);
  const parkWh = fin(stats.parEnergy_kWh, NaN);
  const energy = used > 0 && parkWh > 0
    ? {
      used_kWh: used,
      par_kWh: parkWh,
      ratio: fin(stats.energyRatio, parkWh / used),
      points: Math.round(fin(stats.energyBonus, 0)),
      under: used <= parkWh,
    }
    : null;

  const prev = mission && o.profile ? missionRecord(o.profile, mission.id) : null;
  const badgeIds = Array.isArray(result.badges) ? result.badges
    : Array.isArray(o.badges) ? o.badges : [];
  const badges = badgeIds
    .map((id) => BADGES.find((b) => b.id === id))
    .filter(Boolean)
    .map((b) => ({ id: b.id, title: b.title, detail: b.detail }));

  const headline = failed
    ? 'SHIFT FAILED'
    : medal === 'none' ? 'SHIFT COMPLETE' : `${MEDAL_LABEL[medal].toUpperCase()} MEDAL`;

  let subtitle;
  if (failed) {
    subtitle = stats.failReason
      ? `The shift ended early: ${stats.failReason}`
      : 'The shift ended early. Nothing that happened after the trip could be scored.';
  } else if (par && par.next) {
    subtitle = `${Math.round(par.next.gap)} points short of ${par.next.id}.`;
  } else if (par) {
    subtitle = 'Nothing left to beat on this one but your own number.';
  } else {
    subtitle = MODE_LABEL[mode] || 'Shift complete.';
  }

  return {
    failed,
    medal,
    medalLabel: MEDAL_LABEL[medal],
    headline,
    subtitle,
    mode,
    modeLabel: MODE_LABEL[mode] || 'Shift',
    title: mission ? mission.title : (MODE_LABEL[mode] || 'Shift'),
    score,
    total,
    lines,
    par,
    energy,
    badges,
    wave: Math.max(0, Math.floor(fin(o.wave ?? result.wave, 0))),
    xpGained: Math.max(0, Math.round(fin(result.xpGained ?? o.xpGained, 0))),
    rankUp: (result.rankUp || o.rankUp) === true,
    best: prev ? prev.best : 0,
    newBest: !!prev && score >= prev.best && score > 0,
    stats: [
      { label: 'In band', value: `${num(fin(stats.inBandFraction, 0) * 100, 0)}%` },
      { label: 'Longest hold', value: dur(fin(stats.bestHold_s, 0)) },
      { label: 'Peak multiplier', value: `${num(fin(stats.peakMult, 1), 0)}x` },
      { label: 'Output travel', value: `${num(fin(stats.coTravel_pct, 0), 0)}%` },
      { label: 'Alarms', value: String(Math.max(0, Math.floor(fin(stats.alarmCount, 0)))) },
      { label: 'Worst error', value: `${num(fin(stats.maxAbsErr, 0), 2)} ${stats.bandEU || ''}`.trim() },
    ],
  };
}

/**
 * What the Retry button should do.
 *
 * The board remembers what it last started, because that is the only description of a run that
 * survives it: the session view says which MISSION was played but not which endless seed or which
 * date, and re-dealing a different rig under a button labelled "Retry" is a lie.
 *
 * @param {?object} lastStart the `{action, args}` the board last dispatched
 * @param {?object} view the session snapshot
 * @returns {?{action:string, args:Array}} the plan, or null when there is nothing to repeat
 */
export function retryPlan(lastStart, view) {
  if (lastStart && typeof lastStart.action === 'string' && Array.isArray(lastStart.args)) {
    return { action: lastStart.action, args: lastStart.args.slice() };
  }
  const m = view && view.mission;
  if (m && typeof m.id === 'string') return { action: 'startMission', args: [m.id] };
  return null;
}

/**
 * What the Next button should do: the first campaign shift still not cleared.
 * @param {object|null} profile the profile, AFTER the run was recorded
 * @param {?object} view the session snapshot
 * @returns {?{action:string, args:Array, label:string}} the plan, or null outside the campaign or
 *   once the campaign is finished
 */
export function nextPlan(profile, view) {
  const mode = view && typeof view.mode === 'string' ? view.mode : 'CAMPAIGN';
  if (mode !== 'CAMPAIGN') return null;
  const m = nextMission(profile);
  return m ? { action: 'startMission', args: [m.id], label: `Next: ${m.title}` } : null;
}

/**
 * Advance a counting-up number one repaint towards its target.
 *
 * Frame-rate dependent by design: this is decoration on a number that is already printed
 * elsewhere, and giving it a real clock would mean threading `performance.now()` through a view
 * that otherwise has no notion of time. It always terminates exactly on the target.
 *
 * @param {number} shown where the counter is now
 * @param {number} target where it is going
 * @returns {number} the next value
 */
export function countUp(shown, target) {
  const to = fin(target, 0);
  const from = fin(shown, 0);
  const gap = to - from;
  if (Math.abs(gap) <= COUNT_SNAP) return to;
  return from + gap * COUNT_RATE;
}

// ==============================================================================================
// THE VIEW
// ==============================================================================================

/**
 * Ensure `styles/arcade.css` is on the page.
 *
 * The board is a lazily imported view, so its stylesheet cannot be assumed to be in index.html —
 * and an unstyled scorecard is worse than no scorecard. The href is resolved against this
 * module's own URL rather than the document's, so it survives the app being served from a
 * subdirectory. Once index.html carries the link (see the integration notes) this finds it by id
 * and does nothing.
 *
 * @returns {void}
 */
function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('arcade-css')) return;
  try {
    const href = new URL('../../styles/arcade.css', import.meta.url).href;
    document.head.appendChild(h('link', { id: 'arcade-css', rel: 'stylesheet', href }));
  } catch {
    // A hostile or exotic embedding can refuse both the URL and the append. The board still works
    // — it is plain semantic markup — it just looks like the rest of the app instead of like a
    // scorecard, which is not worth taking the view down for.
  }
}

/**
 * Call a bound action that may not have been wired up yet.
 * @param {object} A the bound action surface
 * @param {string} name the action name
 * @param {...*} args the arguments
 * @returns {*} whatever the action returned, or a refusal
 */
function fire(A, name, ...args) {
  if (!A || typeof A[name] !== 'function') {
    const reason = `${name} is not wired up in this build, so that button does nothing yet.`;
    if (A && typeof A.toast === 'function') A.toast(reason, 'warn');
    return { ok: false, reason };
  }
  return A[name](...args);
}

/**
 * A one-line labelled statistic.
 * @param {string} label the name
 * @param {string} value the value
 * @returns {HTMLElement} the cell
 */
function stat(label, value) {
  return h('div', { class: 'arc-stat' },
    h('span', { class: 'arc-stat__label', text: label }),
    h('b', { class: 'arc-stat__val', text: value }));
}

/**
 * Build the board.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @returns {{el:HTMLElement, update:Function}} the view
 */
export function createArcade(ctx, A) {
  ensureStyles();

  /** What the board last started, so Retry repeats the same rig and not merely the same mode. */
  let lastStart = null;
  /** Which rig in today's pack each "deal another" button is on. */
  const packN = { endless: 0, hunt: 0 };
  /** Rebuild keys — the board is repainted every frame and rebuilt only when something changed. */
  let profileStamp = '';
  let resultKey = '';
  let dateStr = '';
  /** The scorecard's climbing total. */
  let counted = 0;
  /** Set while the player has dismissed a scorecard they have already read. */
  let dismissed = '';

  /**
   * The live profile, or an empty one so the board can render before the session exists.
   * @returns {object} a profile
   */
  const profileOf = () => (A && A.profile && typeof A.profile === 'object' ? A.profile : EMPTY);
  const EMPTY = createProfile();

  /**
   * A cheap change detector for the profile. Every write path through `profile.js` that can
   * change what this board draws also bumps xp or the run count, so four numbers are enough and
   * a deep digest of twenty-two mission records every frame is not.
   * @param {object} p the profile
   * @returns {string} the stamp
   */
  function stampOf(p) {
    const s = (p && p.stats) || {};
    const u = Array.isArray(p && p.unlocks) ? p.unlocks.length : 0;
    const b = Array.isArray(p && p.badges) ? p.badges.length
      : (p && p.badges && typeof p.badges === 'object' ? Object.keys(p.badges).length : 0);
    return `${fin(p && p.xp, 0)}|${fin(s.runs, 0)}|${fin(s.cleared, 0)}|${u}|${b}`;
  }

  /**
   * Dispatch a start plan and remember it for Retry.
   * @param {{action:string, args:Array}} plan what to start
   * @returns {void}
   */
  function start(plan) {
    if (!plan) return;
    const res = fire(A, plan.action, ...plan.args);
    if (res && res.ok === false) return;
    lastStart = plan;
    dismissed = '';
  }

  // ---- profile header --------------------------------------------------------------------
  const rankTitle = h('b', { class: 'arc-hero__rank', text: 'Trainee' });
  const rankXp = h('span', { class: 'arc-hero__xp', text: '0 XP' });
  const xpFill = h('i', { class: 'arc-hero__fill' });
  const xpNote = h('span', { class: 'arc-hero__next', text: '' });
  const tallyMedals = h('div', { class: 'arc-hero__tally' });
  const goldN = h('b', { class: 'arc-tally__n', text: '0' });
  const silverN = h('b', { class: 'arc-tally__n', text: '0' });
  const bronzeN = h('b', { class: 'arc-tally__n', text: '0' });
  const badgeN = h('b', { class: 'arc-tally__n', text: '0' });
  const clearedN = h('b', { class: 'arc-tally__n', text: '0' });
  tallyMedals.append(
    h('span', { class: 'arc-tally arc-tally--gold', title: 'Gold medals held' },
      h('i', { class: 'arc-medal arc-medal--gold arc-medal--pip' }), goldN),
    h('span', { class: 'arc-tally arc-tally--silver', title: 'Silver medals held' },
      h('i', { class: 'arc-medal arc-medal--silver arc-medal--pip' }), silverN),
    h('span', { class: 'arc-tally arc-tally--bronze', title: 'Bronze medals held' },
      h('i', { class: 'arc-medal arc-medal--bronze arc-medal--pip' }), bronzeN),
    h('span', { class: 'arc-tally', title: 'Badges earned' },
      h('span', { class: 'arc-tally__label', text: 'BADGES' }), badgeN),
    h('span', { class: 'arc-tally', title: 'Missions cleared' },
      h('span', { class: 'arc-tally__label', text: 'SHIFTS' }), clearedN));

  const nowLabel = h('span', { class: 'arc-now__label', text: '' });
  const nowTitle = h('b', { class: 'arc-now__title', text: '' });
  const btnAbort = h('button', {
    class: 'btn btn--sm', type: 'button', text: 'Abort shift',
    onClick: () => { fire(A, 'abortGame'); },
  });
  const nowBox = h('div', { class: 'arc-now', hidden: true }, nowLabel, nowTitle, btnAbort);

  const hero = h('header', { class: 'arc-hero' },
    h('div', { class: 'arc-hero__who' },
      h('span', { class: 'arc-hero__cap', text: 'SHIFT ROSTER' }),
      rankTitle,
      h('div', { class: 'arc-hero__bar' }, xpFill),
      h('div', { class: 'arc-hero__meta' }, rankXp, xpNote)),
    tallyMedals,
    nowBox);

  // ---- campaign ---------------------------------------------------------------------------
  const rails = h('div', { class: 'arc-rails' });
  const campaign = h('section', { class: 'card arc-campaign' },
    h('header', { class: 'card__head' },
      h('b', { text: 'CAMPAIGN' }),
      h('span', { class: 'card__note', text: 'twenty-two shifts, five tiers — the controller is handed back one piece at a time' })),
    rails);

  // ---- modes ------------------------------------------------------------------------------
  const endlessBest = h('span', { class: 'arc-mode__best', text: 'no runs yet' });
  const endlessCode = h('code', { class: 'arc-code', text: '————-————' });
  const btnEndless = h('button', {
    class: 'btn arc-mode__go', type: 'button', text: 'Start endless',
    onClick: () => start({ action: 'startEndless', args: [packSeed('endless', dateStr, packN.endless)] }),
  });
  const btnEndlessDeal = h('button', {
    class: 'btn btn--sm', type: 'button', text: 'Deal another rig',
    title: 'The next rig in today\'s pack. Same pack for everybody, so the code is worth sharing.',
    onClick: () => { packN.endless += 1; paintModes(); },
  });
  const endlessPanel = h('section', { class: 'card arc-mode' },
    h('header', { class: 'card__head' }, h('b', { text: 'ENDLESS' }),
      h('span', { class: 'card__note', text: 'waves until you drop one' })),
    h('div', { class: 'arc-mode__body' },
      h('p', { class: 'arc-mode__blurb', text:
        'Upsets keep coming and keep getting worse. There is no duration and no par — the run '
        + 'ends when the header does. Score is how long you lasted times how well you held it.' }),
      h('div', { class: 'arc-mode__row' }, endlessCode, btnEndlessDeal),
      endlessBest,
      btnEndless));

  const dailyDate = h('span', { class: 'arc-mode__date', text: '' });
  const dailyCode = h('code', { class: 'arc-code', text: '————-————' });
  const dailyBest = h('span', { class: 'arc-mode__best', text: 'not played today' });
  const pasteBox = h('input', {
    class: 'field__input arc-paste', type: 'text', placeholder: 'ABCD-EFGH', maxlength: 12,
    title: 'Paste a rig code somebody sent you and play their exact rig.',
    onKeydown: (ev) => { if (ev.key === 'Enter') playPasted(); },
  });
  const btnPaste = h('button', {
    class: 'btn btn--sm', type: 'button', text: 'Play that rig', onClick: () => playPasted(),
  });
  const btnDaily = h('button', {
    class: 'btn arc-mode__go', type: 'button', text: 'Play today\'s rig',
    onClick: () => start({ action: 'startDaily', args: [dateStr] }),
  });
  const dailyPanel = h('section', { class: 'card arc-mode' },
    h('header', { class: 'card__head' }, h('b', { text: 'DAILY' }), dailyDate),
    h('div', { class: 'arc-mode__body' },
      h('p', { class: 'arc-mode__blurb', text:
        'One rig and one upset script per calendar day, the same for everyone. Only your best '
        + 'attempt of the day is kept, so the number is worth comparing.' }),
      h('div', { class: 'arc-mode__row' }, dailyCode),
      dailyBest,
      btnDaily,
      h('div', { class: 'arc-mode__row arc-mode__row--paste' }, pasteBox, btnPaste)));

  const huntCode = h('code', { class: 'arc-code', text: '————-————' });
  const btnHuntDeal = h('button', {
    class: 'btn btn--sm', type: 'button', text: 'Deal another rig',
    onClick: () => { packN.hunt += 1; paintModes(); },
  });
  const btnHunt = h('button', {
    class: 'btn arc-mode__go', type: 'button', text: 'Start fault hunt',
    onClick: () => start({ action: 'startFaultHunt', args: [packSeed('hunt', dateStr, packN.hunt)] }),
  });
  const huntPanel = h('section', { class: 'card arc-mode' },
    h('header', { class: 'card__head' }, h('b', { text: 'FAULT HUNT' }),
      h('span', { class: 'card__note', text: 'read the trend, name the fault' })),
    h('div', { class: 'arc-mode__body' },
      h('p', { class: 'arc-mode__blurb', text:
        'Something is wrong with the rig and nothing on the panel says what. Watch the trend and '
        + 'the faceplate, then name it from a shortlist. Scored on being right and on being quick '
        + '— in that order.' }),
      h('div', { class: 'arc-mode__row' }, huntCode, btnHuntDeal),
      btnHunt));

  // ---- badge case -------------------------------------------------------------------------
  const badgeGrid = h('div', { class: 'arc-badges' });
  const badgeHead = h('span', { class: 'card__note', text: '' });
  const badgePanel = h('section', { class: 'card arc-badgecase' },
    h('header', { class: 'card__head' }, h('b', { text: 'BADGE CASE' }), badgeHead),
    badgeGrid);

  const side = h('div', { class: 'arc-side' }, endlessPanel, dailyPanel, huntPanel, badgePanel);

  // ---- the scorecard ----------------------------------------------------------------------
  const resMedal = h('i', { class: 'arc-medal arc-medal--big' });
  const resHead = h('b', { class: 'arc-res__head', text: '' });
  const resTitle = h('span', { class: 'arc-res__title', text: '' });
  const resScore = h('b', { class: 'arc-res__score', text: '0' });
  const resSub = h('span', { class: 'arc-res__sub', text: '' });
  const resLines = h('div', { class: 'arc-res__lines' });
  const resPar = h('div', { class: 'arc-res__par' });
  const resStats = h('div', { class: 'arc-res__stats' });
  const resBadges = h('div', { class: 'arc-res__badges' });
  const resXp = h('div', { class: 'arc-res__xp' });
  const btnRetry = h('button', { class: 'btn arc-res__btn', type: 'button', text: 'Retry' });
  const btnNext = h('button', { class: 'btn arc-res__btn arc-res__btn--go', type: 'button', text: 'Next' });
  const btnBoard = h('button', {
    class: 'btn btn--ghost arc-res__btn', type: 'button', text: 'Back to the board',
    onClick: () => { dismissed = resultKey; result.hidden = true; },
  });
  const result = h('div', { class: 'arc-res', hidden: true },
    h('div', { class: 'arc-res__panel' },
      h('div', { class: 'arc-res__crown' },
        resMedal,
        h('div', { class: 'arc-res__names' }, resHead, resTitle)),
      resScore,
      resSub,
      resPar,
      resLines,
      resStats,
      resBadges,
      resXp,
      h('div', { class: 'arc-res__btns' }, btnRetry, btnNext, btnBoard)));

  const el = h('div', { class: 'arcade' },
    hero,
    h('div', { class: 'arc-body' }, campaign, side),
    result);

  /**
   * Start whatever is in the paste box.
   * @returns {void}
   */
  function playPasted() {
    const parsed = parseSeedInput(pasteBox.value);
    if (!parsed.ok) { if (A && A.toast) A.toast(parsed.reason, 'warn'); return; }
    pasteBox.value = parsed.code;
    start({ action: 'startEndless', args: [parsed.seed] });
  }

  // ---- painting ---------------------------------------------------------------------------

  /**
   * Rebuild the campaign rails. Cheap enough to do wholesale, and only done when the profile
   * stamp moves — which is once per finished run, not once per frame.
   * @param {object} profile the profile
   * @returns {void}
   */
  function paintCampaign(profile) {
    rails.textContent = '';
    for (const rail of tierRails(profile)) {
      const cards = rail.missions.map((c) => {
        const card = h('button', {
          class: `arc-card ${c.locked ? 'is-locked' : ''} ${c.cleared ? 'is-cleared' : ''}`,
          type: 'button',
          title: c.locked ? c.lockNote : c.brief,
          disabled: c.locked,
          onClick: () => start({ action: 'startMission', args: [c.id] }),
        },
        h('div', { class: 'arc-card__top' },
          h('b', { class: 'arc-card__title', text: c.title }),
          c.medal !== 'none' ? h('i', { class: `arc-medal arc-medal--${c.medal}` }) : null),
        h('div', { class: 'arc-card__teaches', text: c.locked ? c.lockNote : c.teaches }),
        h('div', { class: 'arc-card__foot' },
          h('span', { class: 'arc-card__best', text: c.best > 0 ? `best ${Math.round(c.best)}` : 'not played' }),
          h('span', { class: 'arc-card__par', text: `gold ${c.par ? c.par.gold : '—'}` })),
        c.unlocks.length
          ? h('div', { class: 'arc-card__unlock', text: `unlocks ${c.unlocks.join(', ').toLowerCase()}` })
          : null);
        return card;
      });
      rails.append(h('section', { class: `arc-tier ${rail.open ? '' : 'is-locked'}` },
        h('header', { class: 'arc-tier__head' },
          h('span', { class: 'arc-tier__n', text: String(rail.tier.n) }),
          h('b', { class: 'arc-tier__title', text: rail.tier.title }),
          h('span', { class: 'arc-tier__feature', text: rail.tier.feature }),
          h('span', { class: 'arc-tier__count', text: `${rail.cleared}/${rail.of}` })),
        h('p', { class: 'arc-tier__blurb', text: rail.tier.blurb }),
        h('div', { class: 'arc-tier__cards' }, cards)));
    }
  }

  /**
   * Rebuild the badge case.
   * @param {object} profile the profile
   * @returns {void}
   */
  function paintBadges(profile) {
    const tally = badgeTally(profile);
    setText(badgeHead, `${tally.held} of ${tally.of}`);
    badgeGrid.textContent = '';
    for (const b of badgeCase(profile)) {
      badgeGrid.append(h('div', {
        class: `arc-badge ${b.earned ? 'is-earned' : ''} ${b.silhouette ? 'is-hidden' : ''}`,
        title: b.detail,
      },
      h('b', { class: 'arc-badge__title', text: b.title }),
      h('span', { class: 'arc-badge__detail', text: b.detail })));
    }
  }

  /**
   * Repaint the three mode panels. Separate from the campaign because the seed codes change on a
   * button press rather than on a finished run.
   * @returns {void}
   */
  function paintModes() {
    const profile = profileOf();
    const day = dailyState(profile, dateStr);
    setText(dailyDate, dateStr);
    setText(dailyCode, day.code);
    setText(dailyBest, day.played
      ? `best today ${Math.round(day.best)} · ${MEDAL_LABEL[day.medal].toLowerCase()} · ${day.plays} attempt${day.plays === 1 ? '' : 's'}`
      : 'not played today');
    cls(dailyBest, 'is-good', day.medal === 'gold');

    setText(endlessCode, seedCode(packSeed('endless', dateStr, packN.endless)));
    setText(huntCode, seedCode(packSeed('hunt', dateStr, packN.hunt)));
    const e = (profile && profile.endless) || {};
    setText(endlessBest, fin(e.best, 0) > 0
      ? `best ${Math.round(fin(e.best, 0))} · wave ${Math.max(0, Math.floor(fin(e.bestWave, 0)))}`
      : 'no runs yet');
  }

  /**
   * Fill the scorecard. Called once per result, not per frame — only the climbing total is
   * touched after that.
   * @param {object} m the model from {@link resultModel}
   * @param {object} profile the profile
   * @param {?object} view the session snapshot
   * @returns {void}
   */
  function paintResult(m, profile, view) {
    for (const id of MEDAL_ORDER) cls(resMedal, `arc-medal--${id}`, id === m.medal);
    cls(resMedal, 'is-failed', m.failed);
    cls(result, 'is-failed', m.failed);
    setText(resMedal, m.failed ? '!' : '');
    setText(resHead, m.headline);
    setText(resTitle, `${m.modeLabel} — ${m.title}`);
    setText(resSub, m.subtitle);

    resPar.textContent = '';
    if (m.par) {
      for (const mark of m.par.marks) {
        resPar.append(h('span', { class: `arc-pip ${mark.reached ? 'is-hit' : ''} arc-pip--${mark.id}` },
          h('i', { class: `arc-medal arc-medal--${mark.id} arc-medal--pip` }),
          h('span', { text: `${mark.id} ${Math.round(mark.need)}` })));
      }
    }
    if (m.newBest) resPar.append(h('span', { class: 'arc-pip is-best', text: 'personal best' }));

    resLines.textContent = '';
    for (const l of m.lines) {
      resLines.append(h('div', { class: `arc-line is-${l.kind}` },
        h('span', { class: 'arc-line__label', text: l.label }),
        h('b', { class: 'arc-line__pts', text: l.points > 0 ? `+${l.points}` : String(l.points) })));
    }
    resLines.append(h('div', { class: 'arc-line arc-line--total' },
      h('span', { class: 'arc-line__label', text: m.energy
        ? `Total — ${num(m.energy.used_kWh, 3)} kWh against a par of ${num(m.energy.par_kWh, 3)}`
        : 'Total' }),
      h('b', { class: 'arc-line__pts', text: String(m.total) })));

    resStats.textContent = '';
    for (const s of m.stats) resStats.append(stat(s.label, s.value));

    resBadges.textContent = '';
    for (const b of m.badges) {
      resBadges.append(h('div', { class: 'arc-badge is-earned is-new', title: b.detail },
        h('b', { class: 'arc-badge__title', text: b.title }),
        h('span', { class: 'arc-badge__detail', text: b.detail })));
    }

    resXp.textContent = '';
    if (m.xpGained > 0) {
      const bar = xpBar(profile);
      resXp.append(h('span', { text: `+${m.xpGained} XP` }),
        h('span', { class: 'arc-res__rank', text: m.rankUp
          ? `PROMOTED — ${bar.rank.title}`
          : (bar.atTop ? bar.rank.title : `${bar.toNext} XP to ${bar.next.title}`) }));
    }

    const retry = retryPlan(lastStart, view);
    btnRetry.hidden = !retry;
    btnRetry.onclick = () => { if (retry) start(retry); };
    const next = nextPlan(profile, view);
    btnNext.hidden = !next;
    if (next) {
      setText(btnNext, next.label);
      btnNext.onclick = () => start(next);
    }
  }

  /**
   * Repaint.
   * @returns {void}
   */
  function update() {
    const profile = profileOf();
    const today = isoDate(new Date());
    const stamp = stampOf(profile);
    const view = readView(A);

    if (today !== dateStr) { dateStr = today; paintModes(); }
    if (stamp !== profileStamp) {
      profileStamp = stamp;
      paintCampaign(profile);
      paintBadges(profile);
      paintModes();

      const bar = xpBar(profile);
      setText(rankTitle, bar.rank.title);
      setText(rankXp, `${Math.round(bar.xp)} XP`);
      setText(xpNote, bar.atTop
        ? 'top of the roster'
        : `${bar.toNext} XP to ${bar.next.title}`);
      xpFill.style.width = `${bar.frac * 100}%`;
      cls(xpFill, 'is-full', bar.atTop);

      const t = medalTally(profile);
      setText(goldN, String(t.gold));
      setText(silverN, String(t.silver));
      setText(bronzeN, String(t.bronze));
      setText(clearedN, `${t.cleared}/${t.of}`);
      const bt = badgeTally(profile);
      setText(badgeN, `${bt.held}/${bt.of}`);
    }

    // ---- the live-run banner ---------------------------------------------------------------
    const running = !!view && !isOver(view.phase) && view.phase !== 'IDLE';
    nowBox.hidden = !running;
    if (running) {
      setText(nowLabel, `${MODE_LABEL[view.mode] || 'ON SHIFT'} · ${view.phase}`);
      const m = view.mission;
      setText(nowTitle, `${m && m.title ? m.title : 'in progress'}`
        + (Number.isFinite(view.left_s) ? ` · ${dur(Math.max(0, view.left_s))} left` : '')
        + (Number.isFinite(view.score) ? ` · ${Math.round(view.score)} pts` : ''));
    }

    // ---- the scorecard ---------------------------------------------------------------------
    const over = !!view && isOver(view.phase) && view.result;
    const key = over
      ? `${view.phase}|${view.mode}|${(view.mission && view.mission.id) || ''}|${fin(view.result.score, 0)}`
      : '';
    if (key && key !== resultKey) {
      resultKey = key;
      counted = 0;
      const model = resultModel(view.result, {
        mission: view.mission || (view.result.missionId ? missionById(view.result.missionId) : null),
        profile,
        mode: view.mode,
        wave: view.wave,
      });
      if (model) {
        paintResult(model, profile, view);
        result.hidden = false;
        result.dataset.score = String(model.score);
      }
    } else if (!key) {
      resultKey = '';
      result.hidden = true;
    }
    if (!result.hidden) {
      const target = fin(Number(result.dataset.score), 0);
      counted = countUp(counted, target);
      setText(resScore, String(Math.round(counted)));
    }
    if (dismissed && dismissed === resultKey) result.hidden = true;
  }

  return { el, update };
}
