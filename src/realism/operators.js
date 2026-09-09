/**
 * src/realism/operators.js — the human in the loop: who is sitting at the desk, how tired they
 * are, how long they take to do anything, how badly they type it, and what they did or did not
 * write down at four in the morning for the next crew to find.
 *
 * Layer: `src/realism`. Imports `core/util.js`, `control/pid.js`, `process/motor.js`,
 * `process/alarms.js` and `realism/config.js`. No DOM, no `window`, no `document`, no
 * `performance`, no `Date.now()`, no `Math.random()`. Every function here is tested in Node.
 *
 * OFF BY DEFAULT, like everything else in this layer. `stepShift()` is the only function that
 * sees the configuration, and it is the one that arms the rest: until it has been called with
 * FEATURE.OPERATORS on, `operatorDelay()` returns 0, `operatorError()` returns exactly what it
 * was given, `noticesAlarm()` returns true, and `autoOperator()` touches nothing. A rig with this
 * switch off is the rig as it has always been.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS AT ALL
 *
 * Every other part of this simulator models the plant. This one models the only component that
 * is present in every real incident report and in no simulator of this kind: the person.
 *
 * Three mechanisms carry it, and they are worth stating plainly because each one changes a
 * question the user thought they had already answered.
 *
 *   LATENCY. An operator is a dead time in the loop. A supervisory action that a script performs
 *   in the same scan takes a human between five seconds and a minute, and the tuning that is
 *   perfectly stable when a PLC closes the outer loop is not necessarily stable when a person
 *   does. Tightening a loop that a human supervises is a DIFFERENT problem from tightening one
 *   that a machine supervises, and the only way to feel that is to have to wait for the human.
 *
 *   SLOP. Nobody types 3.45. They type 3.5, because that is the number the hand reaches for, and
 *   under time pressure and at hour eleven of a night shift they type 3.5 when they meant 3.4.
 *   Entry error is dominated by ROUNDING, not by keying mistakes — see `operatorError()` — and
 *   modelling it as a small Gaussian alone would miss the whole effect.
 *
 *   HANDOVER. This is the interesting one. At shift change the outgoing operator writes down some
 *   fraction of what they know, weighted by how important it is and by how tired they are; the
 *   incoming operator knows what was written and NOTHING ELSE; and the incoming operator then
 *   acts on the plant according to their own habits. The failure mode this reproduces is the
 *   commonest one in the industry: a machine was locked out for a reason, the reason never made
 *   it onto the sheet, and the next shift — being diligent, not careless — found an unexplained
 *   abnormal state on the mimic and tidied it up. Piper Alpha is the extreme case of that
 *   sentence. `handover()` is where it lives here, and `planTakeover()` is where the tidying up
 *   is queued.
 *
 * ------------------------------------------------------------------------------------------
 * THE TWO CLOCKS, AND WHY THERE ARE TWO
 *
 * `realism/config.js` compresses time by a single documented factor (720 by default) so that
 * bearings and transmitters age inside a session. People do not age at 720x. A shift boundary
 * every fifty seconds is not a handover, it is noise, and a reaction time expressed on that clock
 * would be sixty milliseconds — which is not a reaction time at all.
 *
 * So this module runs two clocks and says so:
 *
 *   THE LATENCY CLOCK is the simulator's own simulated seconds, unscaled. When `operatorDelay()`
 *   says eleven seconds, the loop sees eleven seconds of the same seconds its dead time and its
 *   reset time are quoted in. Anything else would make human latency incomparable with loop
 *   dynamics, which is the entire point of modelling it.
 *
 *   THE SHIFT CLOCK is compressed by `shiftRate` (60 by default, adjustable per shift state):
 *   one minute at the desk is an hour on shift, so a twelve-hour shift is twelve minutes of play
 *   and a night shift arrives inside a sitting. It is deliberately NOT the plant's ageing factor,
 *   for the same reason the ageing factor is deliberately visible: a number that governs what the
 *   user sees has to be one they can check.
 *
 * A consequence worth knowing: fatigue and shift position advance sixty times faster than the
 * reaction times they modify. That is a stated distortion, not an accident. The alternative is a
 * fatigue curve nobody ever reaches.
 *
 * ------------------------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 *
 * Traits are numbers with sources rather than adjectives with vibes. The anchors used are:
 *
 *   REACTION TIME. EEMUA 191 sizes an operator's alarm-handling capacity by assuming roughly one
 *   minute of attention per alarm and calls more than about ten alarms an hour unmanageable. The
 *   personas sit between 7 s (a hand already on the acknowledge key, reading nothing) and 45 s (a
 *   trainee who checks the procedure first), with a lognormal spread because response times are
 *   right-skewed — the long tail is where the interesting failures are.
 *
 *   ATTENTION. Quoted as the probability of noticing one alarm within one 60 s window while
 *   fresh. Human-reliability tables put the omission probability for an annunciated signal very
 *   low in isolation (THERP Ch. 20) and much higher under load or when the annunciation is not
 *   salient; HEART's generic "routine, highly practised task" nominal error probability is 0.02
 *   and its "completely familiar, well designed" case 0.0004. The values here — 0.5 to 0.97 per
 *   window — are the loaded case, i.e. the probability of THIS alarm getting attention while
 *   everything else on the screen is also asking for it. Three windows of exposure at 0.9 leaves
 *   a miss probability of 0.001; three at 0.5 leaves 0.125, and that difference is the lesson.
 *
 *   FATIGUE. Folkard & Tucker (2003), "Shift work, safety and productivity", report relative risk
 *   rising with hours on duty — roughly flat over the first eight hours, then climbing to about
 *   double by the twelfth — and higher on nights than on days, with the worst of it near the
 *   circadian nadir at about 04:00-05:00. Both effects are reproduced separately below so that a
 *   user can see which one is biting, plus a small sleep-debt term for consecutive nights.
 *
 *   ENTRY PRECISION. Keying-error probability per digit is of order 1e-3 in the human-reliability
 *   literature, which is far too small to matter here. What matters is that people enter round
 *   numbers: `precision` is the granularity a persona habitually types at, as a fraction of the
 *   instrument span, and the Gaussian `slop` on top of it is the smaller effect.
 *
 * None of these are load-bearing to a decimal place. They are load-bearing in their ORDER, and
 * the ordering is the thing the sources support.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, createRng, nextFloat } from '../core/util.js';
import { MODE } from '../control/pid.js';
import { DRIVE } from '../process/motor.js';
import { SEV } from '../process/alarms.js';
import { FEATURE, isOn, rateOf } from './config.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Hours in a shift. Twelve, because that is what this kind of plant actually runs. */
export const SHIFT_HOURS = 12;

/** Hour of the day the day shift takes over. 07:00 is the ordinary continental pattern. */
const DAY_START_H = 7;

/** Hour of the day the night shift takes over. */
const NIGHT_START_H = 19;

/**
 * The window an alarm has to catch an eye in, seconds. EEMUA 191 assumes about a minute of
 * operator attention per alarm, so a minute is the natural unit of "did they see it this time".
 */
const DETECTION_WINDOW_S = 60;

/** How often a standing condition on the mimic gets a fresh look, seconds. */
const SCAN_WINDOW_S = 300;

/**
 * Default shift-clock compression: one minute at the desk is an hour on shift. See the header —
 * this is NOT the plant's ageing factor and must not be conflated with it.
 */
const DEFAULT_SHIFT_RATE = 60;

/** How often the simulated operator re-reads the plant and decides something, simulated seconds. */
const DECIDE_S = 5;

/** Logbook length. Long enough for a couple of shifts, short enough not to grow without bound. */
const LOG_LIMIT = 400;

/** Most actions an operator may have queued at once. Beyond this they are not an operator. */
const QUEUE_LIMIT = 24;

/** Most alarms tracked for attention at once. */
const WATCH_LIMIT = 400;

/** Most outstanding facts carried into a handover. */
const FACT_LIMIT = 60;

/**
 * What each trait means, in a form the UI can print next to the number. Written for somebody
 * deciding whether the persona they are about to put on shift is the one they meant.
 */
export const TRAIT_INFO = Object.freeze([
  Object.freeze({
    key: 'reaction_s',
    name: 'Reaction time',
    unit: 's',
    why: 'Median seconds from noticing something to acting on it, for the simplest action there '
      + 'is. Everything else scales off it. The spread around it is lognormal, because response '
      + 'times have a long right tail and that tail is where incidents live.',
  }),
  Object.freeze({
    key: 'attention',
    name: 'Attention',
    unit: 'p(notice) per minute',
    why: 'Probability of noticing one alarm in one minute of exposure while fresh, with the rest '
      + 'of the screen competing for the same eyes. An alarm nobody notices is an alarm nobody '
      + 'hands over.',
  }),
  Object.freeze({
    key: 'skill',
    name: 'Skill',
    unit: '0..1',
    why: 'How well the action they choose fits the situation. Governs how far a tuning change '
      + 'they make is likely to be in the right direction and the right size.',
  }),
  Object.freeze({
    key: 'caution',
    name: 'Caution',
    unit: '0..1',
    why: 'How readily they take the loop off automatic and drive it by hand when something looks '
      + 'wrong. High caution is safe and expensive; low caution is quick and occasionally awful.',
  }),
  Object.freeze({
    key: 'tuningBias',
    name: 'Tuning bias',
    unit: '-1..+1',
    why: 'The direction they habitually push a controller when left alone with it. Positive adds '
      + 'gain — the loop feels responsive and then oscillates on the next load change. Negative '
      + 'detunes until nothing ever moves.',
  }),
  Object.freeze({
    key: 'adherence',
    name: 'Procedure adherence',
    unit: '0..1',
    why: 'Whether they read the alarm before acknowledging it, log what they did, and leave the '
      + 'plant the way the procedure says. Low adherence is what turns an acknowledged alarm into '
      + 'an unrecorded one.',
  }),
  Object.freeze({
    key: 'handoverQuality',
    name: 'Handover quality',
    unit: 'fraction written down',
    why: 'The fraction of what they know that reaches the next shift, weighted by importance and '
      + 'degraded by fatigue. This is the single most consequential number in the module.',
  }),
  Object.freeze({
    key: 'fatigueResistance',
    name: 'Fatigue resistance',
    unit: '0..1',
    why: 'How well they hold up late and at night. It scales the whole fatigue curve; it does not '
      + 'abolish it, because nobody is immune to 04:00.',
  }),
  Object.freeze({
    key: 'precision',
    name: 'Entry precision',
    unit: 'fraction of span',
    why: 'The granularity they habitually type at. 0.001 of span is somebody entering three '
      + 'significant figures; 0.012 is somebody who types round numbers and means "about there".',
  }),
  Object.freeze({
    key: 'slop',
    name: 'Entry slop',
    unit: 'sd, fraction of span',
    why: 'Gaussian error on top of the rounding — the genuine mis-key. Smaller than the rounding '
      + 'effect for everyone, which is the honest ordering.',
  }),
]);

/**
 * Six people you have met, and a relief hand.
 *
 * They are not difficulty levels. Each one is good at something and expensive at something else,
 * and the point of the roster is that the plant is handed between them: the veteran's tidy plant
 * becomes the quick one's problem twelve hours later, and vice versa.
 */
export const PERSONAS = Object.freeze([
  Object.freeze({
    id: 'VETERAN',
    name: 'M. Kowalczyk',
    blurb: 'Twenty-two years on this skid. Not fast, and never wrong about which machine is making '
      + 'the noise. Writes a handover that the next shift can actually work from.',
    daysOnly: false,
    traits: Object.freeze({
      reaction_s: 22,
      attention: 0.94,
      skill: 0.9,
      caution: 0.6,
      tuningBias: -0.1,
      adherence: 0.88,
      handoverQuality: 0.92,
      fatigueResistance: 0.8,
      precision: 0.002,
      slop: 0.0015,
    }),
  }),
  Object.freeze({
    id: 'QUICK',
    name: 'J. Reyes',
    blurb: 'Quick hands and a short memory. Acts before anyone else has finished reading the alarm, '
      + 'which is sometimes exactly right, and remembers about a third of it at handover.',
    daysOnly: false,
    traits: Object.freeze({
      reaction_s: 9,
      attention: 0.72,
      skill: 0.62,
      caution: 0.2,
      tuningBias: 0.45,
      adherence: 0.4,
      handoverQuality: 0.3,
      fatigueResistance: 0.55,
      precision: 0.01,
      slop: 0.005,
    }),
  }),
  Object.freeze({
    id: 'TRAINEE',
    name: 'S. Bright',
    blurb: 'Six weeks signed off and frightened of breaking something. Watches everything, reads '
      + 'the procedure first, and leaves the loop in manual because manual feels safer.',
    daysOnly: false,
    traits: Object.freeze({
      reaction_s: 45,
      attention: 0.9,
      skill: 0.35,
      caution: 0.95,
      tuningBias: -0.35,
      adherence: 0.85,
      handoverQuality: 0.6,
      fatigueResistance: 0.5,
      precision: 0.004,
      slop: 0.004,
    }),
  }),
  Object.freeze({
    id: 'FEEL',
    name: 'P. Vance',
    blurb: 'Tunes by feel and the feel is always "more gain". The loop is beautifully responsive '
      + 'until the load changes, and he is never on shift when it does.',
    daysOnly: false,
    traits: Object.freeze({
      reaction_s: 18,
      attention: 0.8,
      skill: 0.7,
      caution: 0.3,
      tuningBias: 0.85,
      adherence: 0.5,
      handoverQuality: 0.5,
      fatigueResistance: 0.65,
      precision: 0.006,
      slop: 0.003,
    }),
  }),
  Object.freeze({
    id: 'ACKER',
    name: 'D. Mott',
    blurb: 'Acknowledges alarms without reading them, because the banner being clear is what he '
      + 'thinks the job is. The fastest hand on the desk and the emptiest logbook on the site.',
    daysOnly: false,
    traits: Object.freeze({
      reaction_s: 7,
      attention: 0.5,
      skill: 0.5,
      caution: 0.35,
      tuningBias: 0.05,
      adherence: 0.2,
      handoverQuality: 0.22,
      fatigueResistance: 0.6,
      precision: 0.012,
      slop: 0.006,
    }),
  }),
  Object.freeze({
    id: 'STAR',
    name: 'H. Ndiaye',
    blurb: 'The best operator on the site, and rostered days only — which is the whole problem, '
      + 'because the plant does not restrict its trouble to daylight.',
    daysOnly: true,
    traits: Object.freeze({
      reaction_s: 14,
      attention: 0.97,
      skill: 0.95,
      caution: 0.55,
      tuningBias: 0,
      adherence: 0.95,
      handoverQuality: 0.95,
      fatigueResistance: 0.85,
      precision: 0.0015,
      slop: 0.001,
    }),
  }),
  Object.freeze({
    id: 'RELIEF',
    name: 'T. Aliyev',
    blurb: 'Agency relief covering the fourth night. Competent, careful, and knows this plant only '
      + 'from what the last shift wrote down — so a thin handover costs more with him on the desk '
      + 'than with anybody else.',
    daysOnly: false,
    traits: Object.freeze({
      reaction_s: 30,
      attention: 0.78,
      skill: 0.55,
      caution: 0.7,
      tuningBias: 0,
      adherence: 0.7,
      handoverQuality: 0.45,
      fatigueResistance: 0.7,
      precision: 0.005,
      slop: 0.0035,
    }),
  }),
]);

/** Persona lookup, built once. */
const PERSONA_BY_ID = Object.freeze(Object.fromEntries(PERSONAS.map((p) => [p.id, p])));

/**
 * The kinds of thing an operator can be asked to do, and how much longer than the simplest one
 * each takes. The multipliers are on the persona's base reaction time.
 *
 * Acknowledging is one key. Changing a mode means deciding first. Retuning means thinking, and a
 * walk-round means physically leaving the desk — which is why the last one is measured in tens of
 * minutes and why an operator on a walk-round is not watching the screen.
 */
export const DELAY = Object.freeze({
  ACK: 'ACK',
  MODE: 'MODE',
  SETPOINT: 'SETPOINT',
  PUMP: 'PUMP',
  TUNE: 'TUNE',
  RESET: 'RESET',
  WALKROUND: 'WALKROUND',
});

/** Multiplier on the base reaction time for each {@link DELAY} kind. */
const DELAY_WEIGHT = Object.freeze({
  ACK: 1,
  MODE: 2.2,
  SETPOINT: 3,
  PUMP: 4,
  TUNE: 6,
  RESET: 8,
  WALKROUND: 20,
});

/**
 * How much a severity helps itself get noticed. An ALARM is red and audible; an INFO row is a
 * grey line in a list nobody has scrolled to.
 */
const SALIENCE = Object.freeze({ ALARM: 1, WARN: 0.8, INFO: 0.45 });

/** How important each kind of outstanding item is at handover, 0..1. */
const IMPORTANCE = Object.freeze({
  ALARM: 1,
  WARN: 0.7,
  INFO: 0.35,
  TRIP: 0.95,
  HAND: 0.85,
  MODE: 0.8,
  SETPOINT: 0.55,
  TUNING: 0.5,
  NOTE: 0.6,
});

// ---------------------------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------------------------

/**
 * @param {*} x anything
 * @returns {boolean} whether it is a usable object
 */
function isRecord(x) {
  return x !== null && typeof x === 'object';
}

/**
 * @param {*} x a value that should be a number
 * @param {number} d the fallback
 * @returns {number} `x` if finite, else `d`
 */
function num(x, d) {
  return Number.isFinite(x) ? x : d;
}

/**
 * One uniform draw from the shift state's generator.
 *
 * Guarded the way `src/game/rng.js` guards its own: a generator that has been replaced by
 * something that returns rubbish degrades to a defined value rather than pushing NaN into a
 * probability comparison, where it would silently mean "never".
 *
 * @param {object} ss the shift state
 * @returns {number} a sample in [0, 1)
 */
function drawUnit(ss) {
  const f = ss && typeof ss.rng === 'function' ? ss.rng() : 0;
  if (!Number.isFinite(f) || f < 0) return 0;
  return f >= 1 ? 0.9999999999 : f;
}

/**
 * A normal sample by Box-Muller, taking exactly two draws every time.
 *
 * The same rule `src/game/rng.js` follows and for the same reason: a helper whose draw count
 * depends on its arguments puts the whole seeded sequence one step out of position, and a shift
 * history that cannot be reproduced from a seed cannot be argued with afterwards.
 *
 * @param {object} ss the shift state
 * @param {number} mean the distribution mean
 * @param {number} sd the standard deviation
 * @returns {number} a finite sample
 */
function normal(ss, mean, sd) {
  const u1 = 1 - drawUnit(ss);
  const u2 = drawUnit(ss);
  const m = num(mean, 0);
  const s = Math.abs(num(sd, 0));
  return m + s * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * The persona currently on the desk, as the frozen record.
 * @param {object} ss the shift state
 * @returns {object} a persona from {@link PERSONAS}, never null
 */
function personaOf(ss) {
  const id = isRecord(ss) && Array.isArray(ss.roster) ? ss.roster[ss.seat] : null;
  return PERSONA_BY_ID[id] || PERSONAS[0];
}

/**
 * Is this hour of the day inside the night shift?
 * @param {number} tod_h hour of day, 0..24
 * @returns {boolean} true between 19:00 and 07:00
 */
function isNightHour(tod_h) {
  const h = ((num(tod_h, 0) % 24) + 24) % 24;
  return h >= NIGHT_START_H || h < DAY_START_H;
}

/**
 * Attention after fatigue, as a probability per detection window.
 * @param {object} ss the shift state
 * @returns {number} 0..1
 */
function effectiveAttention(ss) {
  const p = personaOf(ss);
  return clamp(p.traits.attention * (1 - 0.55 * num(ss.fatigue, 0)), 0, 1);
}

/**
 * Push a line into the logbook, oldest first, bounded.
 * @param {object} ss the shift state
 * @param {string} kind one of 'SHIFT', 'HANDOVER', 'ACTION', 'REFUSED', 'ALARM', 'NOTE'
 * @param {string} entry the line
 * @returns {void}
 */
function logLine(ss, kind, entry) {
  ss.log.push({
    at_h: Math.round(num(ss.clock.sim_s, 0) / 36) / 100,
    tod_h: Math.round(num(ss.clock.tod_h, 0) * 100) / 100,
    who: personaOf(ss).name,
    kind,
    entry,
  });
  if (ss.log.length > LOG_LIMIT) ss.log.splice(0, ss.log.length - LOG_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

/**
 * Clean a requested roster into ids this build knows, preserving order and dropping duplicates.
 * @param {string[]} ids the requested roster
 * @returns {string[]} the usable ids, or every persona if nothing usable was asked for
 */
function normaliseRoster(ids) {
  const out = [];
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (PERSONA_BY_ID[id] && !out.includes(id)) out.push(id);
    }
  }
  return out.length > 0 ? out : PERSONAS.map((p) => p.id);
}

/**
 * Allocate the shift state.
 *
 * The generator is injected rather than created from a clock, like everything else in this layer:
 * a crew that behaves differently on every reload cannot be taught from, because "why did that
 * alarm get missed" has no answer anybody can go back and check. Passing nothing gives a fixed
 * internal stream, which keeps a headless test honest without making the caller build one.
 *
 * @param {string[]} [roster] persona ids in the order they take the desk; unknown ids are dropped
 *   and an empty result falls back to the whole crew
 * @param {() => number} [rng] a seeded generator returning [0, 1)
 * @param {object} [opts] overrides
 * @param {number} [opts.seed] seed for the internal generator when `rng` is not supplied
 * @param {number} [opts.startHour=7] hour of the day the first shift starts on
 * @param {number} [opts.shiftRate=60] shift-clock compression; see the header on the two clocks
 * @returns {object} the shift state
 */
export function createShiftState(roster, rng, opts) {
  const o = isRecord(opts) ? opts : {};
  const fallback = createRng(Math.floor(num(o.seed, 20240517)) | 0);
  const draw = typeof rng === 'function' ? rng : () => nextFloat(fallback);
  const ids = normaliseRoster(roster);
  const startHour = clamp(num(o.startHour, DAY_START_H), 0, 24);

  const ss = {
    /** The seeded generator every stochastic decision here draws from. */
    rng: draw,
    /** Persona ids in rotation order. */
    roster: ids,
    /** Index into `roster` of whoever has the desk. */
    seat: 0,
    /** Which persona the PLAYER is, or null for a fully simulated crew. */
    playerId: null,
    /** Whether FEATURE.OPERATORS was on at the last `stepShift`. Everything is inert until it is. */
    active: false,
    /** Live rate multipliers, refreshed from the configuration each `stepShift`. */
    rates: { humanError: 1, fatigue: 1 },
    /** Shift-clock compression. NOT the plant ageing factor — see the header. */
    shiftRate: clamp(num(o.shiftRate, DEFAULT_SHIFT_RATE), 1, 3600),
    clock: {
      /** Simulated seconds since the crew came on. The latency clock. */
      sim_s: 0,
      /** Hour of the day, 0..24. The shift clock. */
      tod_h: startHour,
      /** Hours into the current shift. */
      shift_h: 0,
      /** How many handovers have happened. */
      shift: 0,
      /** Day number, from 1. */
      day: 1,
    },
    /** Fatigue of whoever is on the desk, 0..1. Recomputed every `stepShift`. */
    fatigue: 0,
    /** Consecutive night shifts run, per persona id — the sleep-debt term. */
    nights: {},
    /** @type {Map<string, object>} everything a diligent operator would hand over. */
    facts: new Map(),
    /** @type {Set<string>} fact ids the operator on the desk was actually told about. */
    known: new Set(),
    /** @type {Map<string, object>} attention bookkeeping, per alarm id. */
    watch: new Map(),
    /** @type {object[]} actions decided on and not yet carried out — the human dead time. */
    queue: [],
    /** @type {Set<string>} action keys already queued or done this shift, so nothing repeats. */
    done: new Set(),
    /** Counters for the UI and for tests. */
    stats: { looks: 0, noticed: 0, missedLooks: 0, missedAlarms: 0, actions: 0, refused: 0, handovers: 0 },
    /** The last handover record, for the panel. */
    lastHandover: null,
    /** @type {object[]} the logbook, oldest first. */
    log: [],
    /** Time since the simulated operator last looked at the plant and decided something. */
    decideAccum_s: 0,
    /** Setpoint at the start of the current shift, so "somebody moved it" is a fact. */
    shiftStartSp: NaN,
  };

  // Whoever is first must be allowed to work the shift that is actually starting. A day-only
  // operator rostered onto a night is the one constraint the roster genuinely enforces.
  seatSomeoneFor(ss, isNightHour(startHour));
  logLine(ss, 'SHIFT', `${personaOf(ss).name} on shift, ${isNightHour(startHour) ? 'nights' : 'days'}`);
  return ss;
}

/**
 * Move the seat to the next rostered person who may work this shift.
 *
 * `daysOnly` is a real rostering constraint and it changes who is on the desk at 04:00, which is
 * exactly the hour it matters. When nobody rostered can work the shift, somebody works it anyway
 * and the logbook says so — that is what happens on a site, and silently leaving the desk empty
 * would be worse.
 *
 * @param {object} ss the shift state
 * @param {boolean} night whether the shift being taken is a night
 * @returns {void}
 */
function seatSomeoneFor(ss, night) {
  const n = ss.roster.length;
  for (let k = 0; k < n; k += 1) {
    const idx = (ss.seat + k) % n;
    const p = PERSONA_BY_ID[ss.roster[idx]];
    if (p && !(night && p.daysOnly)) { ss.seat = idx; return; }
  }
  logLine(ss, 'SHIFT', 'nobody on the roster works nights — the desk is covered anyway');
}

// ---------------------------------------------------------------------------------------------
// Fatigue and who is on the desk
// ---------------------------------------------------------------------------------------------

/**
 * Fatigue of the operator on the desk, 0 (fresh) .. 1 (should not be driving home).
 *
 * Three separable terms, kept separable so a user can see which one is biting:
 *
 *   TIME ON TASK, rising with roughly the 1.8 power of the fraction of the shift elapsed. Folkard
 *   & Tucker (2003) find relative risk approximately flat over the first eight hours of a shift
 *   and about double by the twelfth; a power a little under two through a twelve-hour shift is
 *   the simplest curve with that shape.
 *
 *   CIRCADIAN, peaking at about 04:30 and gone by mid-morning. This is why a night shift is worse
 *   than a day shift at the same hours on task, and why the worst moment of the week is the back
 *   half of a night rather than the end of a long day.
 *
 *   SLEEP DEBT, a small addition per consecutive night, saturating at four. The fourth night is
 *   measurably worse than the first and every rota designer knows it.
 *
 * `fatigueResistance` scales the total; it does not abolish it, because nobody is immune to 04:00.
 *
 * @param {object} ss the shift state
 * @returns {number} fatigue, 0..1
 */
export function fatigueOf(ss) {
  if (!isRecord(ss)) return 0;
  return clamp(num(ss.fatigue, 0), 0, 1);
}

/**
 * Recompute fatigue from the shift clock. Called by {@link stepShift}; nothing else should.
 * @param {object} ss the shift state
 * @returns {number} fatigue, 0..1
 */
function computeFatigue(ss) {
  const p = personaOf(ss);
  const onTask = clamp(num(ss.clock.shift_h, 0) / SHIFT_HOURS, 0, 1.2);
  const timeTerm = 0.55 * Math.pow(onTask, 1.8);
  // Cubed cosine rather than a plain one: alertness recovers quickly after the nadir, so the
  // penalty should be a trough between roughly 22:30 and 10:30 rather than half of every day.
  const c = Math.cos((2 * Math.PI * (num(ss.clock.tod_h, 0) - 4.5)) / 24);
  const circadian = 0.45 * Math.pow(Math.max(0, c), 3);
  const debt = 0.06 * clamp(num(ss.nights[p.id], 0), 0, 4);
  const resist = 1.25 - 0.5 * p.traits.fatigueResistance;
  return clamp((timeTerm + circadian + debt) * resist * num(ss.rates.fatigue, 1), 0, 1);
}

/**
 * Who is on the desk, with their traits as fatigue has left them.
 *
 * The base traits are handed back untouched alongside the live ones, because the interesting
 * readout is the difference: an operator whose attention has gone from 0.94 to 0.52 has not
 * become a worse operator, they have been awake for eleven hours.
 *
 * @param {object} ss the shift state
 * @returns {object} the persona, its live traits, fatigue and shift position
 */
export function currentOperator(ss) {
  if (!isRecord(ss)) return null;
  const p = personaOf(ss);
  const f = fatigueOf(ss);
  const he = num(ss.rates.humanError, 1);
  return {
    id: p.id,
    name: p.name,
    blurb: p.blurb,
    daysOnly: p.daysOnly,
    traits: p.traits,
    live: {
      attention: effectiveAttention(ss),
      reaction_s: p.traits.reaction_s * (1 + 1.4 * f) * he,
      precision: p.traits.precision * (1 + 0.8 * f) * he,
      slop: p.traits.slop * (1 + 1.2 * f) * he,
      handoverQuality: clamp(p.traits.handoverQuality * (1 - 0.4 * f), 0, 1),
    },
    fatigue: f,
    onShift_h: num(ss.clock.shift_h, 0),
    tod_h: num(ss.clock.tod_h, 0),
    night: isNightHour(ss.clock.tod_h),
    nights: clamp(num(ss.nights[p.id], 0), 0, 99),
    isPlayer: ss.playerId === p.id,
  };
}

/**
 * A paragraph about a persona, for the dialog where the roster is chosen.
 * @param {string} id a persona id
 * @returns {string|null} the blurb with its two governing numbers, or null if there is no such id
 */
export function describePersona(id) {
  const p = PERSONA_BY_ID[id];
  if (!p) return null;
  const t = p.traits;
  return `${p.name}. ${p.blurb} Notices about ${(t.attention * 100).toFixed(0)}% of alarms in the `
    + `first minute when fresh, takes about ${t.reaction_s.toFixed(0)} s to act, and hands over `
    + `roughly ${(t.handoverQuality * 100).toFixed(0)}% of what they know.`;
}

/**
 * Does the player currently have the desk?
 *
 * The simulated operator must not act while the player is sitting in the same chair — two hands
 * on one keyboard is not a model of anything — so this is checked before every automatic action
 * and again when the seat changes.
 *
 * @param {object} ss the shift state
 * @returns {boolean} true when the persona on shift is the player's own
 */
export function playerHasDesk(ss) {
  if (!isRecord(ss)) return true;
  return ss.playerId !== null && ss.playerId === personaOf(ss).id;
}

// ---------------------------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------------------------

/**
 * Has the operator noticed this alarm yet?
 *
 * Exposure accumulates and is rolled against attention once per {@link DETECTION_WINDOW_S}, so an
 * alarm that stays up gets repeated chances and a transient one may get only one. Exactly one
 * draw is taken per completed window, whatever the arguments, so two personas run against the
 * same seed see the same stream and differ only in the threshold — which is what makes "this
 * operator misses more" a measurement rather than an impression.
 *
 * Returns true when the feature is off: with no simulated operator in the loop, the player is the
 * operator and the player can see the whole alarm list.
 *
 * @param {object} ss the shift state
 * @param {object} alarm an alarm row: `{id, sev}` is all that is read
 * @param {number} dt_s simulated seconds of exposure to add
 * @returns {boolean} whether it has been noticed
 */
export function noticesAlarm(ss, alarm, dt_s) {
  if (!isRecord(ss) || ss.active !== true) return true;
  if (!isRecord(alarm)) return false;
  const id = String(alarm.id === undefined ? 'unknown' : alarm.id);
  let w = ss.watch.get(id);
  if (!w) {
    if (ss.watch.size >= WATCH_LIMIT) {
      const oldest = ss.watch.keys().next();
      if (!oldest.done) ss.watch.delete(oldest.value);
    }
    w = { exposure_s: 0, noticed: false, windows: 0, sev: alarm.sev };
    ss.watch.set(id, w);
  }
  if (w.noticed) return true;
  w.exposure_s += Math.max(0, num(dt_s, 0));
  const sal = num(SALIENCE[alarm.sev], SALIENCE.WARN);
  while (w.exposure_s >= DETECTION_WINDOW_S && !w.noticed) {
    w.exposure_s -= DETECTION_WINDOW_S;
    w.windows += 1;
    ss.stats.looks += 1;
    if (drawUnit(ss) < clamp(effectiveAttention(ss) * sal, 0, 1)) {
      w.noticed = true;
      ss.stats.noticed += 1;
    } else {
      ss.stats.missedLooks += 1;
    }
  }
  return w.noticed;
}

/**
 * The same roll for a standing condition on the mimic rather than an annunciated alarm.
 *
 * Slower, because nothing is flashing: a pump left in HAND is noticed on the next proper look
 * round the screen, not within the minute. This is why an unannounced abnormal state can survive
 * a whole shift and arrive at handover as something nobody ever knew about.
 *
 * @param {object} ss the shift state
 * @param {string} key the fact id
 * @param {number} dt_s simulated seconds of exposure
 * @returns {boolean} whether it has been noticed
 */
function noticesCondition(ss, key, dt_s) {
  let w = ss.watch.get(key);
  if (!w) {
    w = { exposure_s: 0, noticed: false, windows: 0, sev: 'INFO' };
    ss.watch.set(key, w);
  }
  if (w.noticed) return true;
  w.exposure_s += Math.max(0, num(dt_s, 0));
  while (w.exposure_s >= SCAN_WINDOW_S && !w.noticed) {
    w.exposure_s -= SCAN_WINDOW_S;
    w.windows += 1;
    if (drawUnit(ss) < clamp(effectiveAttention(ss), 0, 1)) w.noticed = true;
  }
  return w.noticed;
}

// ---------------------------------------------------------------------------------------------
// Latency and slop — the two things that make a supervised loop a different loop
// ---------------------------------------------------------------------------------------------

/**
 * How long the operator on the desk takes to do something, in SIMULATED seconds.
 *
 * Lognormal about the persona's base reaction time, scaled by the kind of action and stretched by
 * fatigue and by the `humanError` rate. The distribution matters: response times have a long
 * right tail, and the tail — the acknowledgement that took ninety seconds because they were on
 * the phone — is where the interesting failures are. A symmetric distribution would model away
 * the only part of this that bites.
 *
 * Returns 0 when the feature is off, so a caller can apply it unconditionally.
 *
 * @param {object} ss the shift state
 * @param {string} kind one of {@link DELAY}; anything unknown is treated as the simplest action
 * @returns {number} seconds, 0.5..3600
 */
export function operatorDelay(ss, kind) {
  if (!isRecord(ss) || ss.active !== true) return 0;
  const p = personaOf(ss);
  const weight = num(DELAY_WEIGHT[kind], 1);
  const base = p.traits.reaction_s * weight
    * (1 + 1.4 * fatigueOf(ss)) * num(ss.rates.humanError, 1);
  // sigma 0.35 in log space: a factor of two either way at two standard deviations, which is
  // about what published operator response-time distributions look like.
  return clamp(base * Math.exp(normal(ss, 0, 0.35)), 0.5, 3600);
}

/**
 * The furthest from the intended value an entry can land, in engineering units.
 *
 * Exported because "bounded by the trait" is a property worth being able to check, in a test and
 * on a panel. An operator who habitually types to the nearest 0.05 bar cannot be a bar out; the
 * error model must not let them.
 *
 * @param {object} ss the shift state
 * @param {number} span the instrument span the value lives on
 * @returns {number} the bound, in the same units as `span`
 */
export function entryBound(ss, span) {
  if (!isRecord(ss) || ss.active !== true) return 0;
  const sp = Math.abs(num(span, 0));
  if (!(sp > 0)) return 0;
  const p = personaOf(ss);
  const f = fatigueOf(ss);
  const he = num(ss.rates.humanError, 1);
  const step = clamp(p.traits.precision * sp * (1 + 0.8 * f) * he, sp * 1e-6, sp * 0.1);
  const sd = p.traits.slop * sp * (1 + 1.2 * f) * he;
  return 0.5 * step + 3 * sd;
}

/**
 * The value the operator ACTUALLY enters when they mean to enter `value`.
 *
 * Two effects, and their relative size is the point:
 *
 *   ROUNDING, which dominates. People type the number their hand reaches for. Somebody who works
 *   to the nearest 0.05 bar and means 3.47 enters 3.45 or 3.50, every time, and no amount of
 *   care changes that because they do not experience it as an error.
 *
 *   KEYING SLOP, a small Gaussian on top. Keying-error probability per digit is of order 1e-3 in
 *   the human-reliability literature, so modelling entry error as this alone — which is the
 *   obvious thing to do — would produce an operator who is far more precise than any real one.
 *
 * Both are stretched by fatigue: the granularity coarsens and the scatter widens together, which
 * is why a setpoint change at 04:00 lands somewhere else than the same change at 09:00.
 *
 * The result is centred on the intent — there is no systematic bias, because a persona who always
 * typed high would be a calibration error rather than a person — and never further from it than
 * {@link entryBound}.
 *
 * @param {object} ss the shift state
 * @param {number} value what they meant to enter
 * @param {number} span the instrument span, so the same trait means the same thing on a 10 bar
 *   header and a 200 m3/h flow meter
 * @returns {number} what they actually entered
 */
export function operatorError(ss, value, span) {
  const v = num(value, 0);
  if (!isRecord(ss) || ss.active !== true) return v;
  const sp = Math.abs(num(span, 0));
  if (!(sp > 0)) return v;
  const p = personaOf(ss);
  const f = fatigueOf(ss);
  const he = num(ss.rates.humanError, 1);
  const step = clamp(p.traits.precision * sp * (1 + 0.8 * f) * he, sp * 1e-6, sp * 0.1);
  const sd = p.traits.slop * sp * (1 + 1.2 * f) * he;
  const rounded = Math.round(v / step) * step;
  const jitter = clamp(normal(ss, 0, sd), -3 * sd, 3 * sd);
  const bound = 0.5 * step + 3 * sd;
  return v + clamp(rounded + jitter - v, -bound, bound);
}

// ---------------------------------------------------------------------------------------------
// What the operator knows
// ---------------------------------------------------------------------------------------------

/**
 * Record or refresh something the shift ought to hand over.
 *
 * Exported so the rest of the realism layer can put its own findings in front of the operator —
 * a seal starting to weep, a transmitter that has gone overdue — without this module having to
 * import wear or calibration and without those modules having to know how a handover works. If
 * `noticed` is not supplied, whether it registered is decided by attention like anything else,
 * which is the honest default: telling an operator something is not the same as them taking it in.
 *
 * @param {object} ss the shift state
 * @param {object} fact the item
 * @param {string} fact.id a stable id, so the same condition does not accumulate duplicates
 * @param {string} [fact.kind='NOTE'] one of the {@link IMPORTANCE} keys
 * @param {string} fact.text one sentence, as it would appear on the handover sheet
 * @param {number} [fact.importance] 0..1; defaults to the kind's importance
 * @param {boolean} [fact.noticed] force it seen (true) or unseen (false)
 * @param {boolean} [fact.standing] true for a live condition, false for something that happened
 * @param {object} [fact.normalise] `{kind, arg}` — the action an incoming operator would take to
 *   tidy this away if nobody told them why it is like that
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function noteFact(ss, fact) {
  if (!isRecord(ss)) return { ok: false, reason: 'There is no shift state to note anything on.' };
  if (!isRecord(fact) || typeof fact.id !== 'string' || fact.id.length === 0) {
    return { ok: false, reason: 'A handover item needs a stable id, or the same condition would be written down again every scan.' };
  }
  if (typeof fact.text !== 'string' || fact.text.length === 0) {
    return { ok: false, reason: 'A handover item needs a sentence the next shift could read.' };
  }
  upsertFact(ss, {
    id: fact.id,
    kind: typeof fact.kind === 'string' ? fact.kind : 'NOTE',
    text: fact.text,
    importance: clamp(num(fact.importance, num(IMPORTANCE[fact.kind], IMPORTANCE.NOTE)), 0, 1),
    noticed: fact.noticed,
    standing: fact.standing === true,
    normalise: isRecord(fact.normalise) ? fact.normalise : null,
  }, 0);
  return { ok: true };
}

/**
 * Merge a fact into the shift's knowledge, preserving whether it has already been noticed.
 * @param {object} ss the shift state
 * @param {object} f the fact
 * @param {number} dt_s simulated seconds since the last look, for the attention roll
 * @returns {object} the stored fact
 */
function upsertFact(ss, f, dt_s) {
  let row = ss.facts.get(f.id);
  if (!row) {
    if (ss.facts.size >= FACT_LIMIT) {
      const oldest = ss.facts.keys().next();
      if (!oldest.done) ss.facts.delete(oldest.value);
    }
    row = {
      id: f.id,
      kind: f.kind,
      text: f.text,
      importance: f.importance,
      noticed: false,
      standing: f.standing === true,
      normalise: f.normalise || null,
      at_h: num(ss.clock.tod_h, 0),
    };
    ss.facts.set(f.id, row);
  }
  row.text = f.text;
  row.kind = f.kind;
  row.importance = f.importance;
  row.standing = f.standing === true;
  if (f.normalise) row.normalise = f.normalise;
  row.seen_s = num(ss.clock.sim_s, 0);
  if (f.noticed === true) row.noticed = true;
  else if (f.noticed !== false && !row.noticed) row.noticed = noticesCondition(ss, `fact:${f.id}`, dt_s);
  return row;
}

/**
 * Everything the shift is carrying, for the panel.
 * @param {object} ss the shift state
 * @returns {object[]} copies of the outstanding items, each with whether it has been noticed
 */
export function outstanding(ss) {
  if (!isRecord(ss) || !(ss.facts instanceof Map)) return [];
  return Array.from(ss.facts.values()).map((f) => ({
    id: f.id, kind: f.kind, text: f.text, importance: f.importance, noticed: f.noticed,
    standing: f.standing, known: ss.known.has(f.id),
  }));
}

/**
 * Read the plant and update what the operator knows about it.
 *
 * Only conditions a person could actually see are considered, and each one still has to get past
 * attention. Standing conditions that have gone away are dropped so a handover cannot report a
 * pump that was put back in AUTO an hour ago; things that HAPPENED — an alarm that came and went —
 * are kept for the shift, because that is exactly the kind of thing the next crew needs told.
 *
 * @param {object} ss the shift state
 * @param {object} ctx the sim context
 * @param {number} dt_s simulated seconds since the last look
 * @returns {void}
 */
function observe(ss, ctx, dt_s) {
  if (!isRecord(ctx)) return;
  const now = num(ss.clock.sim_s, 0);
  const run = isRecord(ctx.run) ? ctx.run : null;

  // --- alarms ---------------------------------------------------------------------------------
  const list = run && Array.isArray(run.alarmList) ? run.alarmList : [];
  const live = new Set();
  for (const a of list) {
    if (!isRecord(a) || a.active !== true) continue;
    live.add(String(a.id));
    const seen = noticesAlarm(ss, a, dt_s);
    upsertFact(ss, {
      id: `alarm:${a.id}`,
      kind: a.sev === SEV.ALARM ? 'ALARM' : (a.sev === SEV.WARN ? 'WARN' : 'INFO'),
      text: `${a.sev} ${a.tag || a.id} — ${a.message || 'in alarm'}`,
      importance: num(IMPORTANCE[a.sev], IMPORTANCE.WARN),
      noticed: seen,
      standing: false,
    }, dt_s);
  }
  // An alarm that has cleared stops competing for attention. Anyone who never saw it now never
  // will, and that is precisely the item that reaches the next shift as a surprise.
  for (const key of Array.from(ss.watch.keys())) {
    if (key.startsWith('fact:')) continue;
    if (!live.has(key)) {
      const w = ss.watch.get(key);
      if (w && !w.noticed) ss.stats.missedAlarms += 1;
      ss.watch.delete(key);
    }
  }

  // --- standing conditions --------------------------------------------------------------------
  const pid = isRecord(ctx.pid) ? ctx.pid : null;
  if (pid && pid.mode === MODE.MAN) {
    upsertFact(ss, {
      id: 'mode:man',
      kind: 'MODE',
      text: `PIC-101 is in MANUAL at ${num(pid.co, 0).toFixed(0)}%`,
      importance: IMPORTANCE.MODE,
      standing: true,
      normalise: { kind: 'MODE_AUTO' },
    }, dt_s);
  }

  const hands = isRecord(ctx.staging) && Array.isArray(ctx.staging.hand) ? ctx.staging.hand : [];
  const drives = isRecord(ctx.plant) && Array.isArray(ctx.plant.drv) ? ctx.plant.drv : [];
  const pumps = isRecord(ctx.config) && Array.isArray(ctx.config.pumps) ? ctx.config.pumps : [];
  for (let i = 0; i < hands.length; i += 1) {
    if (hands[i] === undefined || hands[i] === 'AUTO') continue;
    const tag = pumps[i] && pumps[i].tag ? pumps[i].tag : `pump ${i + 1}`;
    upsertFact(ss, {
      id: `hand:${i}`,
      kind: 'HAND',
      text: `${tag} is in ${hands[i]}, out of the sequence`,
      importance: IMPORTANCE.HAND,
      standing: true,
      normalise: { kind: 'PUMP_AUTO', arg: i },
    }, dt_s);
  }
  for (let i = 0; i < drives.length; i += 1) {
    if (!isRecord(drives[i]) || drives[i].state !== DRIVE.TRIPPED) continue;
    const tag = pumps[i] && pumps[i].tag ? pumps[i].tag : `pump ${i + 1}`;
    upsertFact(ss, {
      id: `trip:${i}`,
      kind: 'TRIP',
      text: `${tag} is TRIPPED — ${drives[i].tripReason || 'no reason recorded'}`,
      importance: IMPORTANCE.TRIP,
      standing: true,
      normalise: { kind: 'PUMP_RESET', arg: i },
    }, dt_s);
  }

  if (pid && Number.isFinite(ss.shiftStartSp) && Number.isFinite(pid.spTarget)) {
    const moved = Math.abs(pid.spTarget - ss.shiftStartSp);
    if (moved > 1e-6) {
      upsertFact(ss, {
        id: 'sp:moved',
        kind: 'SETPOINT',
        text: `setpoint moved this shift, ${ss.shiftStartSp.toPrecision(3)} to ${pid.spTarget.toPrecision(3)}`,
        importance: IMPORTANCE.SETPOINT,
        // The operator who moved it knows they moved it. Nobody has to notice their own hands.
        noticed: true,
        standing: true,
      }, dt_s);
    }
  }

  // Drop standing conditions that are no longer true, so the sheet describes the plant as it is.
  for (const [id, f] of Array.from(ss.facts.entries())) {
    if (f.standing && f.seen_s !== now) {
      ss.facts.delete(id);
      ss.watch.delete(`fact:${id}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Handover — the whole reason this module is interesting
// ---------------------------------------------------------------------------------------------

/**
 * Change the shift.
 *
 * The outgoing operator writes down some of what they know. Each item is written with probability
 * `handoverQuality * (0.55 + 0.45 * importance)`, degraded by the fatigue they have at the moment
 * they are writing it — which is the end of the shift, and on nights is the worst hour of the
 * week. So the sheet is thinnest exactly when the plant most needs it explained, and that is not
 * a cynical flourish: it is the documented shape of the problem.
 *
 * Anything the outgoing operator never NOTICED cannot be written down at all. That is the second
 * gap, and it is the more dangerous one, because the outgoing operator will honestly report a
 * quiet shift.
 *
 * The incoming operator then knows the notes and nothing else, and {@link planTakeover} queues
 * what they do about it. Whatever the outgoing operator had queued and not yet done leaves with
 * them, because intentions do not transfer.
 *
 * Call it directly to force a changeover; {@link stepShift} calls it at the twelve-hour boundary.
 *
 * @param {object} ss the shift state
 * @param {object} ctx the sim context, for the plant the new shift inherits
 * @returns {{from: object, to: object, notes: object[], missed: object[], at_h: number,
 *   night: boolean}} the handover record
 */
export function handover(ss, ctx) {
  const empty = { from: null, to: null, notes: [], missed: [], at_h: 0, night: false };
  if (!isRecord(ss)) return empty;

  const from = personaOf(ss);
  const quality = clamp(from.traits.handoverQuality * (1 - 0.4 * fatigueOf(ss)), 0, 1);
  const notes = [];
  const missed = [];
  const standing = [];

  for (const f of ss.facts.values()) {
    const item = { id: f.id, kind: f.kind, text: f.text, importance: f.importance };
    if (f.standing) standing.push(f);
    if (!f.noticed) {
      missed.push({ ...item, why: 'never noticed it' });
      continue;
    }
    const p = clamp(quality * (0.55 + 0.45 * f.importance), 0, 1);
    if (drawUnit(ss) < p) notes.push(item);
    else missed.push({ ...item, why: 'knew about it and did not write it down' });
  }

  // --- the seat changes -----------------------------------------------------------------------
  const shiftHours = num(ss.clock.shift_h, 0);
  ss.clock.shift_h = shiftHours >= SHIFT_HOURS ? shiftHours - SHIFT_HOURS : 0;
  ss.clock.shift += 1;
  const night = isNightHour(ss.clock.tod_h);
  ss.seat = (ss.seat + 1) % Math.max(1, ss.roster.length);
  seatSomeoneFor(ss, night);
  const to = personaOf(ss);
  ss.nights[to.id] = night ? clamp(num(ss.nights[to.id], 0) + 1, 0, 9) : 0;

  const written = new Set(notes.map((n) => n.id));
  ss.known = written;
  ss.watch.clear();
  ss.queue.length = 0;
  ss.done.clear();
  ss.decideAccum_s = 0;
  ss.stats.handovers += 1;
  ss.shiftStartSp = isRecord(ctx) && isRecord(ctx.pid) ? num(ctx.pid.spTarget, NaN) : NaN;

  // The new shift keeps the standing conditions as FACTS — they are still true and still on the
  // mimic — but knows the reason for only the ones that were written down. Everything else has to
  // be noticed again from scratch, which is why `noticed` is reset here.
  ss.facts.clear();
  for (const f of standing) {
    ss.facts.set(f.id, {
      ...f, noticed: written.has(f.id), seen_s: num(ss.clock.sim_s, 0), at_h: num(ss.clock.tod_h, 0),
    });
  }

  ss.fatigue = computeFatigue(ss);
  const record = {
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    notes,
    missed,
    at_h: Math.round(num(ss.clock.tod_h, 0) * 100) / 100,
    night,
  };
  ss.lastHandover = record;

  logLine(ss, 'HANDOVER', `${from.name} handed over to ${to.name} (${night ? 'nights' : 'days'}): `
    + `${notes.length} item${notes.length === 1 ? '' : 's'} written down, ${missed.length} not`);
  for (const n of notes) logLine(ss, 'NOTE', `handover note — ${n.text}`);

  planTakeover(ss, standing, written);
  return record;
}

/**
 * What the incoming operator does about the plant they have just been handed.
 *
 * This is where the gap in the handover turns into an action. An abnormal state with a note
 * against it is left alone — somebody explained it, so there is a reason. An abnormal state with
 * NO note against it gets tidied up, because from the incoming operator's side of the desk it is
 * simply a machine that somebody left out of the sequence and nobody mentioned, and putting the
 * plant back to normal is what a conscientious operator does at the start of a shift.
 *
 * The more diligent the incoming operator, the more likely they are to do it. That inversion is
 * deliberate and it is the lesson: this failure is not caused by carelessness on the receiving
 * end. It is caused by the sentence that was never written on the sheet.
 *
 * @param {object} ss the shift state
 * @param {object[]} standing the standing conditions the plant is actually in
 * @param {Set<string>} written the ids that were handed over
 * @returns {void}
 */
function planTakeover(ss, standing, written) {
  const p = personaOf(ss);
  for (const f of standing) {
    if (!f.normalise || typeof f.normalise.kind !== 'string') continue;
    if (written.has(f.id)) {
      logLine(ss, 'NOTE', `left ${f.text} — handed over with a reason`);
      continue;
    }
    // Conscientiousness is what makes them act on it, and caution is what makes them look first.
    if (drawUnit(ss) >= clamp(p.traits.adherence * (1 - 0.3 * p.traits.caution), 0, 1)) continue;
    enqueue(ss, {
      kind: f.normalise.kind,
      arg: f.normalise.arg,
      why: `${f.text} — nothing on the handover sheet said why`,
      delay_s: operatorDelay(ss, DELAY.WALKROUND),
      key: `takeover:${f.id}`,
    });
  }

  // The habits people bring with them. Once per shift, after they have settled in.
  if (p.traits.tuningBias >= 0.5) {
    enqueue(ss, {
      kind: 'TUNE_BIAS',
      arg: p.traits.tuningBias,
      why: `${p.name} thinks the loop is sluggish`,
      delay_s: operatorDelay(ss, DELAY.TUNE) * 4,
      key: 'shift:tune',
    });
  } else if (p.traits.tuningBias <= -0.3) {
    enqueue(ss, {
      kind: 'TUNE_BIAS',
      arg: p.traits.tuningBias,
      why: `${p.name} thinks the loop is nervous`,
      delay_s: operatorDelay(ss, DELAY.TUNE) * 4,
      key: 'shift:tune',
    });
  }
}

/**
 * The logbook: what happened, who was on, and when.
 * @param {object} ss the shift state
 * @returns {object[]} a copy of the log, oldest first
 */
export function logbook(ss) {
  if (!isRecord(ss) || !Array.isArray(ss.log)) return [];
  return ss.log.map((l) => ({ ...l }));
}

/**
 * A compact readout for the panel.
 * @param {object} ss the shift state
 * @returns {object} who is on, how tired, how many alarms went unseen, and the last handover
 */
export function shiftSummary(ss) {
  if (!isRecord(ss)) return null;
  const op = currentOperator(ss);
  return {
    operator: op,
    shift: num(ss.clock.shift, 0),
    onShift_h: num(ss.clock.shift_h, 0),
    tod_h: num(ss.clock.tod_h, 0),
    day: num(ss.clock.day, 1),
    night: isNightHour(ss.clock.tod_h),
    fatigue: fatigueOf(ss),
    outstanding: ss.facts.size,
    queued: ss.queue.length,
    stats: { ...ss.stats },
    lastHandover: ss.lastHandover,
    playerHasDesk: playerHasDesk(ss),
  };
}

// ---------------------------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------------------------

/**
 * Set who is on the rota, in the order they take the desk.
 *
 * An unknown id is refused rather than dropped: a user who typed one name wrong and got a crew of
 * five when they asked for six would spend the next hour wondering why the person they picked
 * never appeared.
 *
 * @param {object} ss the shift state
 * @param {string[]} ids persona ids
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function setRoster(ss, ids) {
  if (!isRecord(ss)) return { ok: false, reason: 'There is no shift state to set a roster on.' };
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, reason: 'A roster needs at least one operator on it.' };
  }
  const unknown = ids.filter((id) => !PERSONA_BY_ID[id]);
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `There is nobody called "${String(unknown[0])}" on the crew. The people available are `
        + `${PERSONAS.map((p) => p.id).join(', ')}.`,
    };
  }
  const clean = [];
  for (const id of ids) if (!clean.includes(id)) clean.push(id);
  ss.roster = clean;
  ss.seat = 0;
  seatSomeoneFor(ss, isNightHour(ss.clock.tod_h));
  logLine(ss, 'SHIFT', `roster set: ${clean.map((id) => PERSONA_BY_ID[id].name).join(', ')}`);
  return { ok: true };
}

/**
 * Say which persona the PLAYER is.
 *
 * When that persona has the desk, the simulated operator stands down completely — no queued
 * actions, no acknowledgements, nothing — and the player has the plant. When the rota moves on,
 * the simulated operator picks it up again. That is the whole handing-back-and-forth mechanism,
 * and it is deliberately a single comparison so it cannot get into a state where both are acting.
 *
 * @param {object} ss the shift state
 * @param {string|null} id a persona id, or null for a fully simulated crew
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function setPlayerOperator(ss, id) {
  if (!isRecord(ss)) return { ok: false, reason: 'There is no shift state to sit down at.' };
  if (id === null || id === undefined) {
    ss.playerId = null;
    logLine(ss, 'SHIFT', 'the desk is being run by the simulated crew');
    return { ok: true };
  }
  if (!PERSONA_BY_ID[id]) {
    return {
      ok: false,
      reason: `There is nobody called "${String(id)}" on the crew. The people available are `
        + `${PERSONAS.map((p) => p.id).join(', ')}.`,
    };
  }
  ss.playerId = id;
  if (playerHasDesk(ss)) {
    ss.queue.length = 0;
    logLine(ss, 'SHIFT', `${PERSONA_BY_ID[id].name} — you — have the desk`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The action queue: everything the simulated operator does happens late
// ---------------------------------------------------------------------------------------------

/**
 * Put an action on the queue, to happen after the human delay it deserves.
 *
 * Actions carry an ABSOLUTE due time rather than a countdown, so that a facade calling both
 * `stepShift` and `autoOperator` in the same scan cannot fire anything twice or advance a timer
 * twice. The shift clock is owned by `stepShift` and nothing else moves it.
 *
 * @param {object} ss the shift state
 * @param {object} item the action
 * @param {string} item.kind what to do
 * @param {*} [item.arg] its argument
 * @param {string} item.why the sentence that goes in the logbook
 * @param {number} item.delay_s how long the operator takes to get to it, simulated seconds
 * @param {string} item.key a per-shift key, so the same intention is not queued twice
 * @returns {boolean} whether it was queued
 */
function enqueue(ss, item) {
  if (ss.done.has(item.key)) return false;
  if (ss.queue.length >= QUEUE_LIMIT) return false;
  ss.done.add(item.key);
  ss.queue.push({
    kind: item.kind,
    arg: item.arg,
    why: item.why,
    due_s: num(ss.clock.sim_s, 0) + Math.max(0, num(item.delay_s, 0)),
  });
  return true;
}

/**
 * What the operator is about to do, for the panel and for a test that wants to see the intention
 * before the plant does.
 * @param {object} ss the shift state
 * @returns {object[]} copies of the queued actions
 */
export function pendingActions(ss) {
  if (!isRecord(ss) || !Array.isArray(ss.queue)) return [];
  return ss.queue.map((q) => ({ ...q }));
}

/**
 * Carry out one queued action through the real simulator actions.
 *
 * Everything goes through `sim`, injected rather than imported: this layer sits beside the core
 * rather than under it, and an operator who wrote to `ctx` directly would be able to do things no
 * operator can do — set a mode the interlocks forbid, start a tripped pump. Going through the
 * front door means a refusal is a refusal, and it goes in the logbook exactly as it would go in a
 * real one.
 *
 * @param {object} ss the shift state
 * @param {object} ctx the sim context
 * @param {object} sim the `core/sim.js` module namespace
 * @param {object} item the queued action
 * @returns {void}
 */
function applyAction(ss, ctx, sim, item) {
  if (!isRecord(sim) || !isRecord(ctx)) return;
  /**
   * @param {string} name the sim action
   * @param {...*} args its arguments
   * @returns {object} the result, or a refusal saying the action does not exist here
   */
  const call = (name, ...args) => {
    const fn = sim[name];
    if (typeof fn !== 'function') return { ok: false, reason: `this build has no ${name} action` };
    const r = fn(ctx, ...args);
    return isRecord(r) ? r : { ok: true };
  };

  let res = { ok: false, reason: `nobody knows how to ${item.kind}` };
  switch (item.kind) {
    case 'ACK':
      res = call('ackAlarms', item.arg);
      break;
    case 'MODE_AUTO':
      res = call('setControllerMode', MODE.AUTO);
      break;
    case 'MODE_MAN':
      res = call('setControllerMode', MODE.MAN);
      break;
    case 'PUMP_AUTO':
      res = call('autoPump', item.arg);
      break;
    case 'PUMP_RESET':
      res = call('resetPump', item.arg);
      break;
    case 'SETPOINT':
      res = call('setSetpoint', item.arg);
      break;
    case 'TUNE_BIAS': {
      const cfg = isRecord(ctx.pidCfg) ? ctx.pidCfg : null;
      if (!cfg || !Number.isFinite(cfg.Kc)) { res = { ok: false, reason: 'there is no controller to retune' }; break; }
      // The size of the nudge is the bias tempered by skill: somebody who knows what they are
      // doing moves it less far, because they know how far is far.
      const p = personaOf(ss);
      const step = 0.18 * num(item.arg, 0) * (1.4 - 0.6 * p.traits.skill);
      res = call('setTuning', { Kc: cfg.Kc * (1 + step) });
      break;
    }
    default:
      break;
  }

  if (res.ok) {
    ss.stats.actions += 1;
    logLine(ss, 'ACTION', `${item.kind}${item.arg === undefined ? '' : ` ${String(item.arg)}`} — ${item.why}`);
  } else {
    ss.stats.refused += 1;
    logLine(ss, 'REFUSED', `tried to ${item.kind} — ${res.reason}`);
  }
}

/**
 * Fire everything that has come due.
 * @param {object} ss the shift state
 * @param {object} ctx the sim context
 * @param {object} sim the `core/sim.js` module namespace
 * @returns {void}
 */
function drainQueue(ss, ctx, sim) {
  if (ss.queue.length === 0) return;
  const now = num(ss.clock.sim_s, 0);
  const keep = [];
  for (const item of ss.queue) {
    if (item.due_s > now) { keep.push(item); continue; }
    applyAction(ss, ctx, sim, item);
  }
  ss.queue = keep;
}

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

/**
 * Advance the crew one controller scan: the clocks, fatigue, what has been noticed, the shift
 * change when it falls due, and any action that has come to the top of the queue.
 *
 * This is the only function in the module that sees the configuration, and therefore the only one
 * that can arm the rest. With FEATURE.OPERATORS off it returns immediately, having set the flag
 * that keeps `operatorDelay`, `operatorError`, `noticesAlarm` and `autoOperator` inert — so a rig
 * with the switch off behaves exactly as it did before this file existed.
 *
 * @param {object} ss the shift state
 * @param {object} cfg the realism configuration
 * @param {object} ctx the sim context
 * @param {object} sim the `core/sim.js` module namespace, for actions that come due
 * @param {number} dt_s the scan interval, simulated seconds
 * @returns {void}
 */
export function stepShift(ss, cfg, ctx, sim, dt_s) {
  if (!isRecord(ss)) return;
  const on = isOn(cfg, FEATURE.OPERATORS);
  ss.active = on;
  if (!on) return;

  ss.rates.humanError = rateOf(cfg, 'humanError');
  ss.rates.fatigue = rateOf(cfg, 'fatigue');

  const dt = Math.max(0, num(dt_s, 0));
  ss.clock.sim_s += dt;
  const dh = (dt / 3600) * ss.shiftRate;
  ss.clock.shift_h += dh;
  ss.clock.tod_h += dh;
  while (ss.clock.tod_h >= 24) { ss.clock.tod_h -= 24; ss.clock.day += 1; }

  if (!Number.isFinite(ss.shiftStartSp) && isRecord(ctx) && isRecord(ctx.pid)) {
    ss.shiftStartSp = num(ctx.pid.spTarget, NaN);
  }

  ss.fatigue = computeFatigue(ss);
  observe(ss, ctx, dt);

  if (ss.clock.shift_h >= SHIFT_HOURS) handover(ss, ctx);

  drainQueue(ss, ctx, sim);
}

/**
 * The simulated operator, deciding.
 *
 * Called after {@link stepShift}, which owns the clock. It looks at the plant every few seconds —
 * not every scan, because a person does not — decides what to do about what they have NOTICED,
 * and queues it to happen after the delay that action deserves. Nothing is done instantly and
 * nothing is done twice in a shift.
 *
 * It stands down entirely while the player has the desk, and clears any intention it had, so
 * control passes back and forth without two hands ever being on the same keyboard.
 *
 * @param {object} ss the shift state
 * @param {object} ctx the sim context
 * @param {object} sim the `core/sim.js` module namespace
 * @param {number} dt_s the scan interval, simulated seconds
 * @returns {void}
 */
export function autoOperator(ss, ctx, sim, dt_s) {
  if (!isRecord(ss) || ss.active !== true) return;
  if (playerHasDesk(ss)) {
    if (ss.queue.length > 0) ss.queue.length = 0;
    return;
  }
  ss.decideAccum_s += Math.max(0, num(dt_s, 0));
  if (ss.decideAccum_s >= DECIDE_S) {
    ss.decideAccum_s = 0;
    decide(ss, ctx);
  }
  drainQueue(ss, ctx, sim);
}

/**
 * One pass of the simulated operator's judgement.
 *
 * Only facts they have NOTICED are available to them, which is the whole point: an operator does
 * not act on an alarm they never saw, and the plant does not care that the alarm was on the list.
 *
 * @param {object} ss the shift state
 * @param {object} ctx the sim context
 * @returns {void}
 */
function decide(ss, ctx) {
  if (!isRecord(ctx)) return;
  const p = personaOf(ss);
  const run = isRecord(ctx.run) ? ctx.run : null;
  const list = run && Array.isArray(run.alarmList) ? run.alarmList : [];

  // --- acknowledging --------------------------------------------------------------------------
  // Somebody with low adherence clears the whole banner without reading any of it, which is a
  // different action from acknowledging the one alarm you have understood, and it is modelled as
  // a different action because the difference is the point.
  const unacked = list.filter((a) => isRecord(a) && a.active === true && a.ack !== true);
  const seen = unacked.filter((a) => {
    const w = ss.watch.get(String(a.id));
    return w ? w.noticed === true : false;
  });
  if (seen.length > 0) {
    if (p.traits.adherence < 0.35) {
      enqueue(ss, {
        kind: 'ACK',
        arg: undefined,
        why: 'cleared the banner',
        delay_s: operatorDelay(ss, DELAY.ACK),
        key: `ack:all:${ss.clock.shift}:${Math.floor(num(ss.clock.sim_s, 0) / 600)}`,
      });
    } else {
      for (const a of seen) {
        enqueue(ss, {
          kind: 'ACK',
          arg: a.id,
          why: `${a.sev} ${a.tag || a.id} read and acknowledged`,
          delay_s: operatorDelay(ss, DELAY.ACK),
          key: `ack:${a.id}`,
        });
      }
    }
  }

  // --- a tripped machine ----------------------------------------------------------------------
  const drives = isRecord(ctx.plant) && Array.isArray(ctx.plant.drv) ? ctx.plant.drv : [];
  for (let i = 0; i < drives.length; i += 1) {
    if (!isRecord(drives[i]) || drives[i].state !== DRIVE.TRIPPED) continue;
    const f = ss.facts.get(`trip:${i}`);
    if (!f || !f.noticed) continue;
    enqueue(ss, {
      kind: 'PUMP_RESET',
      arg: i,
      why: 'tripped machine, reset attempted',
      // Caution buys time here, and the time is worth buying: the overload will not reset until
      // its bimetal has cooled, so the impatient operator is refused and the careful one is not.
      delay_s: operatorDelay(ss, DELAY.RESET) * (0.5 + p.traits.caution),
      key: `reset:${i}`,
    });
  }

  // --- the loop's mode ------------------------------------------------------------------------
  const pid = isRecord(ctx.pid) ? ctx.pid : null;
  const worst = run ? run.worst : null;
  if (pid) {
    if (pid.mode === MODE.MAN && worst === null && p.traits.adherence > 0.6) {
      enqueue(ss, {
        kind: 'MODE_AUTO',
        why: 'plant quiet, loop put back in automatic',
        delay_s: operatorDelay(ss, DELAY.MODE),
        key: `auto:${ss.clock.shift}`,
      });
    } else if (pid.mode === MODE.AUTO && worst === SEV.ALARM && p.traits.caution > 0.8) {
      enqueue(ss, {
        kind: 'MODE_MAN',
        why: 'took the loop to manual rather than watch it fight an alarm',
        delay_s: operatorDelay(ss, DELAY.MODE),
        key: `man:${ss.clock.shift}`,
      });
    }
  }
}
