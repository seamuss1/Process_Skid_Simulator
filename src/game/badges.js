/**
 * src/game/badges.js — the achievement set: the standing record of things an operator has done
 * on this rig that were worth doing.
 *
 * Layer: `src/game`. Imports nothing. No DOM, no `window`, no clock, no randomness — a badge is
 * decided entirely from the statistics the scoring engine already measured, so the same shift
 * always earns the same badges whether it is replayed in a browser or in a unit test.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THESE BADGES AND NOT OTHERS
 *
 * The scoring engine rewards holding the band, which rewards reflexes. That is the loop, and it
 * is fine, but a rig graded only on reflexes teaches an operator to chase the trace — and chasing
 * the trace is exactly the habit that wrecks real machinery. So roughly half of what is here
 * rewards the opposite instinct: finishing under the energy budget, leaving the loop with real
 * stability margin, and above all NOT moving the output very much. `gentle-hands` and
 * `valve-saver` are the badges a plant manager would have written.
 *
 * Every check reads a field the scoring engine actually produces. A badge whose condition cannot
 * be measured is a badge that either never fires or fires by accident, and both are worse than
 * not having it — so {@link STAT_FIELDS} is the contract, and anything not in it is not testable
 * and is not a badge.
 *
 * THE TWO RULES THAT KEEP THIS HARMLESS
 *
 *   1. A check may never throw. It runs at the end of a shift, on the results screen, in front of
 *      a player who has just finished a good run. One bad field reference there would replace the
 *      scorecard with a stack trace, so every check reads through the guarded accessors below and
 *      {@link evaluateBadges} catches anything that still gets through.
 *   2. A badge is awarded exactly once, ever. The award is idempotent against the profile itself
 *      rather than against a "seen" flag, so calling it twice on the same result — which the UI
 *      will do the moment anything re-renders — cannot mint a duplicate.
 *
 * SANDBOX EARNS NOTHING. Free play has no band, no par and no clock; anything measured there is
 * measured against rules the player set themselves, which is not an achievement.
 * ------------------------------------------------------------------------------------------
 */

// --- the thresholds a reader would want to argue with ---------------------------------------

/**
 * Classical robustness targets: 6 dB of gain margin and 45 degrees of phase. They are the numbers
 * every loop-tuning text quotes, and the reason is concrete — 6 dB is a doubling, so a loop with
 * that margin still holds together when the process gain doubles, which it does when the duty
 * moves along the pump curve or a second machine joins the header.
 */
const GAIN_MARGIN_TARGET_DB = 6;
const PHASE_MARGIN_TARGET_DEG = 45;

/**
 * Total controller-output travel allowed for the `gentle-hands` badge, in percent of span summed
 * over the whole shift. Five full sweeps of the drive is about what a well-damped loop spends
 * riding out half a dozen upsets; a loop that is hunting passes 500 in under a minute, which is
 * precisely the distinction being rewarded.
 */
const TRAVEL_BUDGET_PCT = 500;

/** And the same claim expressed as a rate, so a long shift is not punished for being long. */
const TRAVEL_RATE_PCT_PER_MIN = 60;

/** Shifts shorter than this are not long enough for a travel figure to mean anything, s. */
const TRAVEL_MIN_SHIFT_S = 120;

/**
 * The multiplier cap from the scoring design (1 + floor(hold/8), capped at 4), so reaching it
 * takes 24 s of continuous in-band holding. The badge names the cap rather than the seconds so it
 * keeps agreeing with `score.js` if the ramp is ever retuned.
 */
const MULTIPLIER_CAP = 4;

/** Two unbroken minutes inside the band, s. Long enough that it cannot happen by luck. */
const LONG_HOLD_S = 120;

/** Fraction of the shift that counts as "never left the band", allowing for one scan of rounding. */
const FULL_BAND_FRACTION = 0.999;

/** A shift has to last this long before a full-band claim means anything, s. */
const REAL_SHIFT_S = 60;

/** Endless wave counts worth marking. Ten is where the wave table starts stacking upsets. */
const WAVES_RESPECTABLE = 10;
const WAVES_ABSURD = 20;

/** Fault-hunt marks: a streak, a quick call, and a call that is either expertise or a good guess. */
const FAULT_STREAK = 5;
const FAULT_FAST_S = 45;
const FAULT_UNCANNY_S = 20;

/** Energy fractions of par: at or under par, and the miser's margin. */
const MISER_FRACTION = 0.85;

/** A five-figure shift score. */
const FIVE_FIGURES = 10000;

/** Upsets ridden out without leaving the band, for `unbothered`. */
const UPSETS_UNBOTHERED = 6;

/** No single excursion longer than this, over at least this many excursions. */
const SHORT_EXCURSION_S = 5;
const SHORT_EXCURSION_COUNT = 3;

/** Consecutive daily rigs completed. */
const DAILY_STREAK_DAYS = 7;

/**
 * Every statistic a badge may read, with the value it takes when the caller did not supply it.
 *
 * This doubles as the integration contract: the session hands {@link evaluateBadges} one flat
 * object with these keys, assembled from the score result, the profile and the mission. The
 * defaults are what an all-zeros shift looks like, and no badge may fire on one.
 */
export const STAT_FIELDS = Object.freeze({
  /** One of the MODE ids: CAMPAIGN, ENDLESS, DAILY, FAULT, SANDBOX. */
  mode: '',
  /** Mission id, when the shift was a mission. */
  missionId: '',
  /** Mission tier, 0 when not applicable. */
  tier: 0,
  /** True when the shift ended in a trip or was otherwise failed. */
  failed: false,
  /** Final shift score. */
  score: 0,
  /** 'none' | 'bronze' | 'silver' | 'gold'. */
  medal: 'none',

  /** Simulated seconds the shift actually lasted. */
  duration_s: 0,
  /** Simulated seconds the PV spent inside the tolerance band. */
  timeInBand_s: 0,
  /** `timeInBand_s / duration_s`, derived by {@link normaliseStats} when it is missing. */
  inBandFraction: 0,
  /** The longest unbroken in-band hold, s. */
  longestHold_s: 0,
  /** The highest multiplier reached. */
  maxMultiplier: 0,
  /** How many times the PV left the band. */
  bandExits: 0,
  /** The longest single spell outside the band, s. */
  longestExcursion_s: 0,

  /** Total controller-output travel over the shift, percent of span. */
  coTravel_pct: 0,
  /** Alarms raised during the shift. */
  alarmCount: 0,
  /** True if a machine tripped. */
  tripped: false,
  /** Seconds spent cavitating. */
  cavTime_s: 0,
  /** Seconds spent below minimum continuous flow. */
  minFlow_s: 0,
  /** Pump starts commanded during the shift. */
  pumpStarts: 0,

  /** Energy used, kWh, and the mission's par for the same work. */
  energy_kWh: 0,
  parEnergy_kWh: 0,

  /** Stability margins of the tuning the shift finished with. */
  gainMargin_dB: 0,
  phaseMargin_deg: 0,

  /** True if the autotuner was run at any point during the shift. */
  usedAutotune: false,
  /** True if the controller was never in auto — the output was the operator's the whole way. */
  manualOnly: false,

  /** Scripted upsets that landed, and how many of them never pushed the PV out of the band. */
  upsetsRidden: 0,
  upsetsHeldInBand: 0,

  /** Endless waves survived. */
  wave: 0,

  /** Fault hunt: whether the call was right, how long it took, and the current run of right calls. */
  diagnosisCorrect: false,
  diagnosisTime_s: 0,
  faultStreak: 0,

  /** True when this run beat the stored ghost of the player's own earlier run. */
  ghostBeaten: false,

  /** True when this was the first time the mission was ever cleared. */
  firstClear: false,
  /** Missions cleared across the whole profile. */
  missionsCleared: 0,
  /** Golds held in this shift's tier, and how many missions the tier contains. */
  goldsInTier: 0,
  missionsInTier: 0,
  /** Consecutive days the daily rig has been completed. */
  dailyStreak_days: 0,
  /** True when this score beat the player's own previous best on this mission. */
  personalBest: false,
  /** That previous best, so a first clear is not mistaken for beating a record of zero. */
  previousBest: 0,
});

/**
 * Read a numeric stat, treating anything that is not a finite number — undefined, null, NaN, a
 * string from a hand-edited save — as zero. Checks call this instead of touching `stats.x`
 * directly so that a malformed stats object costs the player a badge rather than the results
 * screen.
 * @param {object} stats the statistics bundle
 * @param {string} key field name
 * @returns {number} the value, or 0
 */
function num(stats, key) {
  if (!stats || typeof stats !== 'object') return 0;
  const v = stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Read a boolean stat. Only a literal `true` counts, so a truthy 1 left over from a serialised
 * profile does not quietly award anything.
 * @param {object} stats the statistics bundle
 * @param {string} key field name
 * @returns {boolean} the flag
 */
function flag(stats, key) {
  return !!stats && typeof stats === 'object' && stats[key] === true;
}

/**
 * Read a string stat, lower-cased for comparison.
 * @param {object} stats the statistics bundle
 * @param {string} key field name
 * @returns {string} the value, or ''
 */
function text(stats, key) {
  if (!stats || typeof stats !== 'object') return '';
  const v = stats[key];
  return typeof v === 'string' ? v.toLowerCase() : '';
}

/**
 * Whether this shift is one a badge may be earned on at all: it ran, it was not failed, and it
 * was not free play. Nearly every check starts here, because the alternative is twenty-odd
 * badges each independently forgetting that a zero-length sandbox session exists.
 * @param {object} stats the statistics bundle
 * @returns {boolean} true when the shift counts
 */
function completed(stats) {
  return !flag(stats, 'failed')
    && num(stats, 'duration_s') > 0
    && text(stats, 'mode') !== 'sandbox';
}

/**
 * Fraction of the shift spent inside the band, preferring the supplied figure and falling back to
 * the two times it was derived from.
 * @param {object} stats the statistics bundle
 * @returns {number} 0..1
 */
function bandFraction(stats) {
  const given = num(stats, 'inBandFraction');
  if (given > 0) return given;
  const dur = num(stats, 'duration_s');
  return dur > 0 ? num(stats, 'timeInBand_s') / dur : 0;
}

/**
 * The badge table. `check` is a pure predicate over the statistics bundle; `hidden` means the
 * badge is not listed until it is earned, so there is something left to find.
 */
export const BADGES = Object.freeze([
  Object.freeze({
    id: 'first-shift',
    title: 'First Shift Signed Off',
    detail: 'Cleared a mission. The header survived, and so did you.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s) && (flag(s, 'firstClear') || num(s, 'missionsCleared') >= 1),
  }),
  Object.freeze({
    id: 'first-gold',
    title: 'Gold on the Board',
    detail: 'A gold medal, which takes a loop that is quick and quiet at the same time.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s) && text(s, 'medal') === 'gold',
  }),
  Object.freeze({
    id: 'tier-swept',
    title: 'Tier Swept',
    detail: 'Every mission in one tier at gold. The commissioning engineer has run out of notes.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const of = num(s, 'missionsInTier');
      return completed(s) && of > 0 && num(s, 'goldsInTier') >= of;
    },
  }),
  Object.freeze({
    id: 'band-perfect',
    title: 'Inside the Lines',
    detail: 'A whole shift without the trace once leaving the tolerance band.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s)
      && num(s, 'duration_s') >= REAL_SHIFT_S
      && bandFraction(s) >= FULL_BAND_FRACTION,
  }),
  Object.freeze({
    id: 'quiet-panel',
    title: 'Quiet Panel',
    detail: 'Finished a shift without raising a single alarm, which nobody will ever thank you for.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s)
      && num(s, 'duration_s') >= REAL_SHIFT_S
      && num(s, 'alarmCount') === 0,
  }),
  Object.freeze({
    id: 'under-par',
    title: 'Under Par',
    detail: 'Held the setpoint on less energy than the mission budgeted for it.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const par = num(s, 'parEnergy_kWh');
      const used = num(s, 'energy_kWh');
      return completed(s) && par > 0 && used > 0 && used < par;
    },
  }),
  Object.freeze({
    id: 'miser',
    title: 'The Miser',
    detail: 'Came in under 85 percent of par energy, which on a real skid is a real invoice.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const par = num(s, 'parEnergy_kWh');
      const used = num(s, 'energy_kWh');
      return completed(s) && par > 0 && used > 0 && used <= par * MISER_FRACTION;
    },
  }),
  Object.freeze({
    id: 'wave-ten',
    title: 'Tenth Wave',
    detail: 'Survived ten waves of endless. The upsets do not get tired.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => text(s, 'mode') === 'endless' && num(s, 'wave') >= WAVES_RESPECTABLE,
  }),
  Object.freeze({
    id: 'wave-twenty',
    title: 'Twentieth Wave',
    detail: 'Twenty waves. By now the rig is being difficult on purpose.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => text(s, 'mode') === 'endless' && num(s, 'wave') >= WAVES_ABSURD,
  }),
  Object.freeze({
    id: 'fault-streak',
    title: 'Five in a Row',
    detail: 'Named five faults correctly without a miss between them.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => flag(s, 'diagnosisCorrect') && num(s, 'faultStreak') >= FAULT_STREAK,
  }),
  Object.freeze({
    id: 'fault-fast',
    title: 'Snap Diagnosis',
    detail: 'Named the fault inside forty-five seconds of being handed the trend.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const t = num(s, 'diagnosisTime_s');
      return flag(s, 'diagnosisCorrect') && t > 0 && t <= FAULT_FAST_S;
    },
  }),
  Object.freeze({
    id: 'robust',
    title: 'Robust by Design',
    detail: 'Left the loop with six decibels of gain margin and forty-five degrees of phase.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s)
      && num(s, 'gainMargin_dB') >= GAIN_MARGIN_TARGET_DB
      && num(s, 'phaseMargin_deg') >= PHASE_MARGIN_TARGET_DEG,
  }),
  Object.freeze({
    id: 'ghost-beaten',
    title: 'Ahead of Your Own Ghost',
    detail: 'Beat the trace you left behind on the same rig.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s) && flag(s, 'ghostBeaten'),
  }),
  Object.freeze({
    id: 'gentle-hands',
    title: 'Gentle Hands',
    detail: 'A full mission on under five hundred percent of total output travel.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const travel = num(s, 'coTravel_pct');
      return completed(s)
        && num(s, 'duration_s') >= TRAVEL_MIN_SHIFT_S
        && travel > 0
        && travel <= TRAVEL_BUDGET_PCT;
    },
  }),
  Object.freeze({
    id: 'valve-saver',
    title: 'The Drive Thanks You',
    detail: 'Averaged under sixty percent of output travel a minute across a long shift.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const dur = num(s, 'duration_s');
      const travel = num(s, 'coTravel_pct');
      if (!completed(s) || dur < TRAVEL_MIN_SHIFT_S || travel <= 0) return false;
      return travel / (dur / 60) <= TRAVEL_RATE_PCT_PER_MIN;
    },
  }),
  Object.freeze({
    id: 'multiplier-cap',
    title: 'Four Times Over',
    detail: 'Held the band long enough to reach the four times multiplier.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => num(s, 'maxMultiplier') >= MULTIPLIER_CAP,
  }),
  Object.freeze({
    id: 'long-hold',
    title: 'Two Quiet Minutes',
    detail: 'Two unbroken minutes inside the band, which is what a good loop looks like.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => num(s, 'longestHold_s') >= LONG_HOLD_S,
  }),
  Object.freeze({
    id: 'suction-intact',
    title: 'Suction Intact',
    detail: 'A whole shift with no cavitation and no time spent below minimum flow.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s)
      && num(s, 'duration_s') >= REAL_SHIFT_S
      && num(s, 'cavTime_s') === 0
      && num(s, 'minFlow_s') === 0,
  }),
  Object.freeze({
    id: 'manual-only',
    title: 'Hands On',
    detail: 'Cleared a mission on the manual output alone, the way it was done before the loop closed.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s) && flag(s, 'manualOnly'),
  }),
  Object.freeze({
    id: 'by-ear',
    title: 'Tuned by Ear',
    detail: 'A gold with the autotuner never touched.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s) && text(s, 'medal') === 'gold' && !flag(s, 'usedAutotune'),
  }),
  Object.freeze({
    id: 'daily-week',
    title: 'Seven Days Running',
    detail: 'Completed the daily rig seven days in a row, weekend included.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => text(s, 'mode') === 'daily'
      && completed(s)
      && num(s, 'dailyStreak_days') >= DAILY_STREAK_DAYS,
  }),
  Object.freeze({
    id: 'five-figures',
    title: 'Five Figures',
    detail: 'Ten thousand points banked in a single shift.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s) && num(s, 'score') >= FIVE_FIGURES,
  }),
  Object.freeze({
    id: 'own-record',
    title: 'Own Record Broken',
    detail: 'Beat your own best on a mission you had already cleared once.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s)
      && flag(s, 'personalBest')
      && num(s, 'previousBest') > 0
      && num(s, 'score') > num(s, 'previousBest'),
  }),
  Object.freeze({
    id: 'unbothered',
    title: 'Unbothered',
    detail: 'Rode out six upsets in one shift without the trace leaving the band for any of them.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const held = num(s, 'upsetsHeldInBand');
      return completed(s) && held >= UPSETS_UNBOTHERED && held >= num(s, 'upsetsRidden');
    },
  }),
  Object.freeze({
    id: 'short-excursions',
    title: 'Back Inside Quickly',
    detail: 'Left the band three times or more and was never outside it for longer than five seconds.',
    hidden: false,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const exits = num(s, 'bandExits');
      const worst = num(s, 'longestExcursion_s');
      return completed(s)
        && exits >= SHORT_EXCURSION_COUNT
        && worst > 0
        && worst <= SHORT_EXCURSION_S;
    },
  }),
  Object.freeze({
    id: 'clean-sheet',
    title: 'Clean Sheet',
    detail: 'A gold with no alarms, no cavitation and not one second spent outside the band.',
    hidden: true,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => completed(s)
      && text(s, 'medal') === 'gold'
      && num(s, 'duration_s') >= REAL_SHIFT_S
      && num(s, 'alarmCount') === 0
      && num(s, 'cavTime_s') === 0
      && num(s, 'minFlow_s') === 0
      && bandFraction(s) >= FULL_BAND_FRACTION,
  }),
  Object.freeze({
    id: 'learning-experience',
    title: 'A Learning Experience',
    detail: 'Tripped the rig. Every operator has done it once; few of them mention it.',
    hidden: true,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => flag(s, 'tripped') && text(s, 'mode') !== 'sandbox',
  }),
  Object.freeze({
    id: 'second-sight',
    title: 'Second Sight',
    detail: 'Named a fault within twenty seconds, which is either expertise or a very good guess.',
    hidden: true,
    /**
     * @param {object} s statistics bundle
     * @returns {boolean} earned
     */
    check: (s) => {
      const t = num(s, 'diagnosisTime_s');
      return flag(s, 'diagnosisCorrect') && t > 0 && t <= FAULT_UNCANNY_S;
    },
  }),
]);

/**
 * Fill in every field a check might read, so a caller that assembled half a stats object gets a
 * quiet non-award instead of an exception. Non-finite numbers (a NaN energy from a zero-length
 * run, say) collapse to the default for the same reason.
 *
 * `inBandFraction` is derived here rather than in each check, because it is the one figure the
 * scoring engine may reasonably report either way.
 *
 * @param {object} raw whatever the caller has, possibly nothing
 * @returns {object} a complete statistics bundle
 */
export function normaliseStats(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(STAT_FIELDS)) {
    const def = STAT_FIELDS[key];
    const v = src[key];
    if (typeof def === 'number') out[key] = typeof v === 'number' && Number.isFinite(v) ? v : def;
    else if (typeof def === 'boolean') out[key] = v === true;
    else out[key] = typeof v === 'string' ? v : def;
  }
  if (out.inBandFraction === 0 && out.duration_s > 0 && out.timeInBand_s > 0) {
    out.inBandFraction = out.timeInBand_s / out.duration_s;
  }
  return out;
}

/**
 * Look a badge up by id.
 * @param {string} id badge id
 * @returns {object|null} the badge, or null when nothing has that id
 */
export function badgeById(id) {
  if (typeof id !== 'string' || id === '') return null;
  return BADGES.find((b) => b.id === id) || null;
}

/**
 * Whether the argument is something a badge could be stored in. An array is rejected explicitly:
 * it is an object as far as `typeof` is concerned, so without this a caller who passed a LIST of
 * profiles — or an empty array standing in for "no profile" — would get badges written onto it
 * and lost, with no error anywhere to say so.
 * @param {*} profile the candidate
 * @returns {boolean} true when it can hold badges
 */
function isProfile(profile) {
  return !!profile && typeof profile === 'object' && !Array.isArray(profile);
}

/**
 * Whether a profile already holds a badge.
 *
 * The container is read defensively — array, Set or plain map — because `profile.js` owns the
 * shape of a profile and a badge list that came back from `importProfile` may have been through
 * JSON, which turns a Set into an empty object and an array into an array. Guessing wrong here
 * would mint duplicates, which is the one failure a badge system must not have.
 *
 * @param {object} profile the player profile
 * @param {string} id badge id
 * @returns {boolean} true when it has already been earned
 */
export function hasBadge(profile, id) {
  if (!isProfile(profile) || typeof id !== 'string') return false;
  const held = profile.badges;
  if (Array.isArray(held)) return held.includes(id);
  if (held instanceof Set) return held.has(id);
  if (held && typeof held === 'object') {
    return Object.prototype.hasOwnProperty.call(held, id) && held[id] !== false;
  }
  return false;
}

/**
 * Write a badge into the profile, in whatever container it is already using.
 * @param {object} profile the player profile (mutated)
 * @param {string} id badge id
 * @returns {boolean} true when this call is what earned it
 */
function grantBadge(profile, id) {
  if (!isProfile(profile)) return false;
  if (hasBadge(profile, id)) return false;
  const held = profile.badges;
  if (Array.isArray(held)) { held.push(id); return true; }
  if (held instanceof Set) { held.add(id); return true; }
  if (held && typeof held === 'object') { held[id] = true; return true; }
  profile.badges = [id];
  return true;
}

/**
 * Award every badge whose condition this shift satisfies and the profile does not already hold.
 *
 * Called at the end of a shift, and safe to call again on the same result: the profile itself is
 * the record of what has been earned, so a second call returns an empty list rather than a second
 * round of pops.
 *
 * There is no `{ok:false}` refusal here even for nonsense input, because the caller is a results
 * screen that wants a list to iterate — so a bad profile or a bad stats bundle earns nothing and
 * says nothing, which is the same outcome as a shift that deserved nothing.
 *
 * @param {object} profile the player profile (mutated)
 * @param {object} stats the statistics bundle described by {@link STAT_FIELDS}
 * @param {(profile:object, id:string)=>boolean} [award] optional writer, so the session can route
 *   the write through `profile.awardBadge` and keep one code path for persistence
 * @returns {string[]} ids earned by this call, in table order
 */
export function evaluateBadges(profile, stats, award) {
  if (!isProfile(profile)) return [];
  const s = normaliseStats(stats);
  const write = typeof award === 'function' ? award : grantBadge;
  const earned = [];
  for (const badge of BADGES) {
    if (hasBadge(profile, badge.id)) continue;
    let hit = false;
    try {
      hit = badge.check(s) === true;
    } catch {
      // A badge is a garnish. If one check is broken it loses the player that badge and nothing
      // else — it must never be allowed to take down the end-of-shift screen with it.
      hit = false;
    }
    if (!hit) continue;
    if (write(profile, badge.id) !== false) earned.push(badge.id);
  }
  return earned;
}
