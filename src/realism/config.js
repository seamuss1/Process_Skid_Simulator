/**
 * src/realism/config.js — the switchboard for the optional realism layer: which of the seven
 * mechanisms are live, how hard they bite, and — the one number that matters most — how much
 * faster than the clock the plant is allowed to age.
 *
 * Layer: `src/realism`. Imports `core/util.js` only. No DOM, no `window`, no `document`, no
 * `performance`, no `Date.now()`, no `Math.random()`. Storage arrives as an argument and every
 * function here is tested in Node.
 *
 * ------------------------------------------------------------------------------------------
 * WHY EVERY DEFAULT IS OFF
 *
 * The rig as shipped is a teaching instrument, and a teaching instrument has to be trustworthy:
 * if a student's step test comes back with a gain 4% lower than last time, that has to mean the
 * student changed something. The moment a transmitter is quietly drifting underneath, every
 * conclusion drawn from the rig becomes provisional, and the student cannot tell a lesson from a
 * fault. So realism is not a difficulty setting that the simulator ships leaning on — it is a
 * second instrument the user deliberately switches on, one mechanism at a time, when they want
 * the plant to stop behaving like a textbook.
 *
 * `createRealismConfig()` with no argument therefore returns the OFF preset, `anyOn()` returns
 * false for it, and `agedHours()` on it still returns the compressed hours it would return
 * anywhere else — because nothing is reading them. OFF is inert because no feature is listening,
 * not because the rates were zeroed; a user who flips WEAR on inside OFF gets an honest plant at
 * honest rates rather than a dead one.
 *
 * ------------------------------------------------------------------------------------------
 * THE ACCELERATION FACTOR, AND WHY IT LIVES HERE AND NOWHERE ELSE
 *
 * Nobody is going to sit at this rig for six months, and every mechanism in this layer — bearing
 * life, seal life, transmitter drift, scaling, insulation ageing — happens on a scale of months
 * to years. The dishonest fix is to give each module its own quietly inflated rate: a "bearing
 * life" of 40 hours, a "drift" of 0.5% an hour. Do that and the numbers stop being traceable to
 * anything, nobody can check them against a datasheet, and the user has no way of knowing whether
 * the plant they are looking at is a plant.
 *
 * The honest fix is one explicit multiplier. Every rate in this layer is quoted at its REAL
 * engineering value — an API 610 bearing rating life of 25 000 hours is written as 25 000 hours —
 * and simulated time is then compressed by a single factor that the UI is required to display.
 * `agedHours(cfg, dt_s)` is the only function in the layer that is allowed to convert a scan
 * interval into equipment hours, and every other module calls it. If that factor is ever wrong,
 * it is wrong in one place and it is wrong visibly.
 *
 * The default is 720: one hour at the desk is thirty days on the machine. That was chosen so the
 * consequences of operating decisions arrive on the right side of two boundaries. A bearing at its
 * API 610 rating life of 25 000 hours (API 610 11th ed. §5.10.1.2, L10 = 25 000 h continuous)
 * survives about 35 hours of play, so a well-run plant does NOT fall apart in a session — which is
 * the point, because the lesson is that a badly run one does. Run the same machine far off its
 * best-efficiency point, or let it cavitate, and the hazard multiplies by enough that the same
 * bearing arrives at the knee of its Weibull inside a single sitting. An annual calibration
 * interval (12 months, ordinary plant practice for a process transmitter) comes round after about
 * twelve hours of play, which is why LIGHT deliberately runs drift faster than a real transmitter
 * does — see `describePreset('LIGHT')`.
 *
 * The one thing the presets do NOT do is move the acceleration factor around. PUNISHING is a bad
 * site, not a fast clock: it raises the severity multipliers — how hard this particular plant is
 * on its equipment, how long the supplier takes, how tired the crew is — and leaves the clock
 * where it is. Conflating the two would make "the machine is ageing 720 times faster than the
 * clock" a statement the user cannot check, and an unfalsifiable statement is worse than no
 * statement.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/**
 * Bumped when the persisted shape changes in a way `sanitize()` cannot absorb silently. The
 * storage key deliberately carries no version: a newer build must find and salvage an older
 * saved configuration rather than silently drop a user back to OFF without saying so.
 */
export const REALISM_VERSION = 1;

/** Where the realism configuration lives in the injected storage. Stable across versions. */
export const STORAGE_KEY = 'skid.realism.config';

/**
 * The seven mechanisms, as ids. Values are the ids themselves so `FEATURE.WEAR` can be handed
 * straight to `isOn()`, and so a typo is a `undefined` that fails loudly rather than a string
 * that fails silently.
 */
export const FEATURE = Object.freeze({
  /** Machinery condition: bearings, seals, impellers, wear rings, valve trim, scaling. */
  WEAR: 'WEAR',
  /** Instrument condition: zero and span drift, linearity, lag, and outright transmitter faults. */
  CALIBRATION: 'CALIBRATION',
  /** Stores: parts, chemicals, lead times, stockouts, and the dosing that slows fouling. */
  CONSUMABLES: 'CONSUMABLES',
  /** The human in the loop: personas, fatigue, latency, entry slop, and the shift handover. */
  OPERATORS: 'OPERATORS',
  /** Maintenance as work that has to be planned, isolated, resourced and signed off. */
  WORKORDERS: 'WORKORDERS',
  /** Sudden failures fired from the wear state's hazard rate, rather than gradual degradation. */
  FAILURES: 'FAILURES',
  /** Money: parts, chemicals, energy and downtime, totalled against a budget. */
  COSTS: 'COSTS',
});

/** The ids in the order the UI lists them: the substrate first, the things built on it after. */
export const FEATURE_ORDER = Object.freeze([
  FEATURE.WEAR, FEATURE.CALIBRATION, FEATURE.CONSUMABLES,
  FEATURE.OPERATORS, FEATURE.WORKORDERS, FEATURE.FAILURES, FEATURE.COSTS,
]);

/**
 * What each switch actually does, written for the operator reading the dialog. `needs` is not a
 * hard dependency — every feature is individually switchable, which is the whole brief — but a
 * feature whose substrate is off has nothing to work on, and `validateRealismConfig()` says so.
 */
export const FEATURE_INFO = Object.freeze([
  Object.freeze({
    id: FEATURE.WEAR,
    name: 'Machinery wear',
    needs: [],
    blurb: 'Bearings, seals, impellers, wear rings, valve trim and pipe scaling degrade from what '
      + 'the plant is actually made to do: hours at speed, distance from best-efficiency flow, '
      + 'cavitation exposure, vibration, bearing temperature and start count. A badly staged set '
      + 'wears measurably faster than a well staged one, and the evidence is on the condition page.',
  }),
  Object.freeze({
    id: FEATURE.CALIBRATION,
    name: 'Instrument drift and calibration',
    needs: [],
    blurb: 'Transmitters acquire zero offset, span error, linearity and lag, and they fall due for '
      + 'calibration. The controller only ever sees the INDICATED value, so a drifted transmitter '
      + 'means the loop holds the wrong true pressure while the faceplate reads exactly on '
      + 'setpoint. This is the most useful switch on the page and the least dangerous.',
  }),
  Object.freeze({
    id: FEATURE.CONSUMABLES,
    name: 'Stores and chemicals',
    needs: [FEATURE.WEAR],
    blurb: 'Parts have stock levels, costs and lead times, and a job you have no part for does not '
      + 'happen. Chemicals are dosed continuously: antiscalant slows the fouling that steepens the '
      + 'system curve, so stopping the dose to save money is a decision whose consequence turns up '
      + 'weeks later as a pump running harder for the same flow.',
  }),
  Object.freeze({
    id: FEATURE.OPERATORS,
    name: 'Operator variability',
    needs: [],
    blurb: 'Your own actions acquire human latency and slop — 3.5 typed when 3.45 was meant, an '
      + 'acknowledgement that takes eleven seconds — and the shift changes around you. The '
      + 'outgoing operator writes a handover note of variable quality and the incoming one knows '
      + 'only what was written down. Most real plant incidents start there.',
  }),
  Object.freeze({
    id: FEATURE.WORKORDERS,
    name: 'Work orders and permits',
    needs: [FEATURE.WEAR],
    blurb: 'Maintenance stops being a button. A job is raised, planned, resourced from stores, '
      + 'isolated, executed and signed off, and the loop it touches has to be taken out of service '
      + 'first. It is the difference between knowing a seal is failing and being able to do '
      + 'something about it before Friday.',
  }),
  Object.freeze({
    id: FEATURE.FAILURES,
    name: 'Sudden failures',
    needs: [FEATURE.WEAR],
    blurb: 'Degraded components do not only fade — they break, at a hazard rate that rises with '
      + 'accumulated damage. A seal that has been run dry lets go; an impeller that has been '
      + 'cavitating sheds material; a VFD fan that was never replaced takes the drive with it on a '
      + 'hot afternoon. Off, the plant only ever degrades gracefully.',
  }),
  Object.freeze({
    id: FEATURE.COSTS,
    name: 'Money',
    needs: [],
    blurb: 'Parts, chemicals, energy and lost production are totalled against a budget, so the '
      + 'cheap decision and the right decision can be compared instead of argued about. Energy is '
      + 'counted whether this is on or not; what this adds is everything else.',
  }),
]);

/** Default acceleration: one hour of running ages the plant 720 hours, i.e. about thirty days. */
export const DEFAULT_AGEING = 720;

/**
 * Every knob, with the range it is allowed to take and the reason it exists. `feature` names the
 * switch that governs it, or null for one that governs everything.
 *
 * The multipliers all default to 1.0, meaning "the real published rate". That is deliberate: a
 * user who wants to argue with a number should be arguing with the engineering source it came
 * from, not with a scaling factor sitting in front of it.
 */
export const RATES = Object.freeze([
  Object.freeze({
    key: 'ageing',
    name: 'Time compression',
    unit: 'x real time',
    def: DEFAULT_AGEING,
    min: 1,
    max: 8760,
    feature: null,
    why: 'The single acceleration factor for the whole layer. 720 makes an hour of running a month '
      + 'on the machine. 1 is real time and nothing will ever visibly age; 8760 makes an hour a '
      + 'year, which is useful for watching a calibration interval come round and useless for '
      + 'anything else. The UI must display whatever this is set to.',
  }),
  Object.freeze({
    key: 'wear',
    name: 'Mechanical wear severity',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.WEAR,
    why: 'How hard this particular site is on rotating equipment, over and above the duty it is '
      + 'given — abrasive solids, poor alignment, a foundation that was never grouted properly. '
      + '1.0 is a well built plant handling clean water.',
  }),
  Object.freeze({
    key: 'drift',
    name: 'Instrument drift severity',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.CALIBRATION,
    why: 'Multiplies the published drift spec. 1.0 is a modern transmitter at its datasheet figure '
      + '(order 0.1% of upper range limit per year); older analogue instruments in a hot, damp '
      + 'field enclosure are honestly two to three times that.',
  }),
  Object.freeze({
    key: 'fouling',
    name: 'Fouling and scaling rate',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.WEAR,
    why: 'How quickly scale builds in the pipework and on the strainer, steepening the system curve '
      + 'and lifting the strainer differential. Water chemistry, in one number. Chemical dosing '
      + 'multiplies this down; stopping the dose lets it back up.',
  }),
  Object.freeze({
    key: 'failure',
    name: 'Failure hazard',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.FAILURES,
    why: 'Multiplies the Weibull hazard rate, so it changes how often accumulated damage turns into '
      + 'a sudden failure without changing how fast the damage accumulates. Set it to 0 and '
      + 'components degrade forever without ever breaking.',
  }),
  Object.freeze({
    key: 'consumption',
    name: 'Consumable usage',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.CONSUMABLES,
    why: 'Seal flush water, instrument air, lube oil, filter loading and chemical dosing, all '
      + 'scaled together. Above 1.0 is a plant with leaks it has not found.',
  }),
  Object.freeze({
    key: 'leadTime',
    name: 'Supplier lead time',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.CONSUMABLES,
    why: 'Multiplies every catalogue lead time. This is the knob that decides whether a stockout is '
      + 'an inconvenience or an outage: a mechanical seal at 1.0 is a fortnight, and at 2.5 it is '
      + 'six weeks of running on the standby.',
  }),
  Object.freeze({
    key: 'cost',
    name: 'Cost scaling',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.COSTS,
    why: 'Scales parts, chemicals and energy prices together, so the same plant can be run against '
      + 'a cheap-power site and an expensive one without editing the catalogue.',
  }),
  Object.freeze({
    key: 'humanError',
    name: 'Human latency and slop',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.OPERATORS,
    why: 'Multiplies reaction times and entry errors for every operator, the player included. This '
      + 'is what makes tight tuning on a human-supervised loop a different problem from tight '
      + 'tuning on an automatic one.',
  }),
  Object.freeze({
    key: 'fatigue',
    name: 'Fatigue accumulation',
    unit: 'x',
    def: 1,
    min: 0,
    max: 10,
    feature: FEATURE.OPERATORS,
    why: 'How fast attention degrades through a twelve-hour shift, and how much worse nights are. '
      + '1.0 tracks the ordinary finding that alarm-response performance falls off through the '
      + 'back half of a night shift; above that is a crew working doubles.',
  }),
  Object.freeze({
    key: 'stock',
    name: 'Opening stock',
    unit: 'fraction of max',
    def: 1,
    min: 0,
    max: 1,
    feature: FEATURE.CONSUMABLES,
    why: 'How full the stores are on day one, as a fraction of each item maximum. 1.0 is a stores '
      + 'that was reviewed last month; 0.3 is one that has been run down for two years and is the '
      + 'reason a routine seal change becomes a six-week wait.',
  }),
  Object.freeze({
    key: 'budget',
    name: 'Maintenance budget',
    unit: 'currency',
    def: 25000,
    min: 0,
    max: 1e7,
    feature: FEATURE.COSTS,
    why: 'What there is to spend before somebody has to be asked. Sized against the catalogue: a '
      + 'cartridge mechanical seal for a 15 kW process pump is order 1000, so 25 000 is a handful '
      + 'of overhauls and a year of chemicals.',
  }),
]);

/** Rate metadata by key, so the lookups below are not a linear scan on every call. */
const RATE_BY_KEY = Object.freeze(Object.fromEntries(RATES.map((r) => [r.key, r])));

/** The label a configuration carries once it no longer matches any shipped preset. */
export const CUSTOM = 'CUSTOM';

/**
 * Build the rates object for a preset from a sparse patch. Anything not named takes its default,
 * so a preset that softens two rates says so in two lines and cannot silently drop a third.
 * @param {object} [patch] rate keys to override
 * @returns {object} a complete rates object
 */
function rates(patch) {
  const out = {};
  for (const r of RATES) out[r.key] = r.def;
  for (const k of Object.keys(patch || {})) {
    if (RATE_BY_KEY[k]) out[k] = patch[k];
  }
  return Object.freeze(out);
}

/**
 * Build the features object for a preset from a list of ids that are ON. Everything unnamed is
 * OFF, which is the direction the defaults have to fail in.
 * @param {string[]} on the ids to enable
 * @returns {object} a complete features object
 */
function features(on) {
  const out = {};
  for (const id of FEATURE_ORDER) out[id] = false;
  for (const id of on) out[id] = true;
  return Object.freeze(out);
}

/**
 * The four shipped settings. Each is a COMPLETE configuration — every feature and every rate —
 * so applying one can never leave a stale knob behind from the last one.
 *
 * `detail` is what `describePreset()` returns, and it is written to be read before the switch is
 * thrown rather than after something has gone wrong.
 */
export const PRESET = Object.freeze({
  OFF: Object.freeze({
    id: 'OFF',
    name: 'Off — clean instrument',
    features: features([]),
    rates: rates({}),
    detail: 'Nothing. The rig behaves exactly as it does with this whole layer deleted: every '
      + 'transmitter reads the true process value, the pumps are as good on hour nine hundred as '
      + 'they were on hour one, and the only thing that changes the plant is you. This is the right '
      + 'setting for learning to tune, for the lesson curriculum, and for any test where you need '
      + 'to know that a difference between two runs was caused by something you did. Turn realism '
      + 'on when the loop is no longer the hard part.',
  }),
  LIGHT: Object.freeze({
    id: 'LIGHT',
    name: 'Light — the instrument lies to you',
    features: features([FEATURE.WEAR, FEATURE.CALIBRATION]),
    rates: rates({ wear: 0.35, drift: 2.5, fouling: 0.5 }),
    detail: 'The two mechanisms that teach without punishing. Transmitters drift, so the number on '
      + 'the faceplate slowly stops being the number in the pipe — and because the controller only '
      + 'ever sees the indication, a loop sitting perfectly on setpoint can be holding the header '
      + 'a tenth of a bar away from where you think it is. The pipework fouls slowly, so the system '
      + 'curve steepens over a shift and the same setpoint costs more speed than it did this '
      + 'morning. Nothing breaks: sudden failures are off, there are no parts to run out of, no '
      + 'work orders to raise and no money to lose. Note that drift here is run about two and a '
      + 'half times faster than a real transmitter would drift. That is on purpose. A lesson you '
      + 'cannot see inside one sitting is not a lesson, and this preset exists to teach one thing: '
      + 'check the instrument against something before you believe it.',
  }),
  FULL: Object.freeze({
    id: 'FULL',
    name: 'Full — a working plant',
    features: features(FEATURE_ORDER.slice()),
    rates: rates({}),
    detail: 'Everything on, at honest rates. Machinery wears at a speed driven by what you actually '
      + 'do with it — hours at speed, distance from best-efficiency flow, cavitation exposure, '
      + 'vibration, bearing temperature and every start you spend — and once it is worn enough, it '
      + 'breaks. Instruments drift and fall due for calibration. Parts have stock levels, prices '
      + 'and lead times, so a job with no part in stores does not happen this week; chemicals are '
      + 'dosed continuously and antiscalant is the only thing holding the fouling rate down. '
      + 'Maintenance runs through work orders against equipment that has to be isolated first. '
      + 'Shifts change every twelve hours and the handover note is whatever the outgoing operator '
      + 'bothered to write. Everything is costed. Expect to spend as much attention on the plant as '
      + 'on the loop, which is the correct ratio and the reason this preset exists.',
  }),
  PUNISHING: Object.freeze({
    id: 'PUNISHING',
    name: 'Punishing — a bad site, a thin store and a tired crew',
    features: features(FEATURE_ORDER.slice()),
    rates: rates({
      wear: 1.8,
      drift: 2.2,
      fouling: 1.8,
      failure: 2.5,
      consumption: 1.35,
      leadTime: 2.5,
      cost: 1.4,
      humanError: 1.9,
      fatigue: 1.7,
      stock: 0.3,
      budget: 6000,
    }),
    detail: 'The same plant, on a site that has been managed badly for years. The water is '
      + 'aggressive and the foundations were never grouted properly, so bearings and seals go at '
      + 'nearly twice the rate and scale builds almost twice as fast. The instruments are older and '
      + 'live in hot field enclosures. Stores were run down long ago and start at about a third of '
      + 'their maximum, the supplier takes two and a half times as long as the catalogue says, and '
      + 'the maintenance budget is a quarter of normal — so you will have to choose which failure '
      + 'to prevent and live with the other one. The crew is short-handed and doing doubles: '
      + 'reaction times and entry errors are nearly double, fatigue accumulates faster, and the '
      + 'handover notes are worse. Two warnings. First, the clock is NOT faster here than on any '
      + 'other preset — the plant ages at the same 720 times real time, it is simply harder on its '
      + 'equipment. Second, this preset is not tuneable in the ordinary sense: it is a test of '
      + 'whether you can keep a degrading plant in service and decide what to spend, and it will '
      + 'feel unfair, because the site it is modelled on was.',
  }),
});

/** Preset ids in the order the UI offers them: least reality first. */
export const PRESET_ORDER = Object.freeze(['OFF', 'LIGHT', 'FULL', 'PUNISHING']);

// ---------------------------------------------------------------------------------------------
// Guards. Nothing in this module throws; a bad argument comes back as a sentence.

/**
 * A finite number, or the fallback. Guards every value arriving from storage or from a caller.
 * @param {*} x the candidate
 * @param {number} def the fallback
 * @returns {number} a finite number
 */
function num(x, def) {
  return Number.isFinite(x) ? x : def;
}

/**
 * Is this a plain object we can read fields off?
 * @param {*} x the candidate
 * @returns {boolean} true for a non-null, non-array object
 */
function isRecord(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Resolve a preset argument to an id. Accepts the id string or the preset object itself, because
 * `setPreset(cfg, PRESET.FULL)` is the mistake every caller makes once and there is no ambiguity
 * in allowing it.
 * @param {*} id a preset id, or a preset object
 * @returns {string|null} the id, or null if it is not one of ours
 */
function presetId(id) {
  if (typeof id === 'string') return PRESET[id] ? id : null;
  if (isRecord(id) && typeof id.id === 'string' && PRESET[id.id]) return id.id;
  return null;
}

/**
 * The preset id a configuration currently matches, or CUSTOM.
 *
 * Recomputed after every change rather than latched, so a user who turns a switch off again gets
 * the honest label back instead of being stuck on 'CUSTOM' for the rest of the session.
 * @param {object} cfg the configuration
 * @returns {string} a preset id, or CUSTOM
 */
function labelFor(cfg) {
  if (!isRecord(cfg) || !isRecord(cfg.features) || !isRecord(cfg.rates)) return CUSTOM;
  for (const id of PRESET_ORDER) {
    const p = PRESET[id];
    let same = true;
    for (const f of FEATURE_ORDER) {
      if (cfg.features[f] !== p.features[f]) { same = false; break; }
    }
    if (same) {
      for (const r of RATES) {
        if (cfg.rates[r.key] !== p.rates[r.key]) { same = false; break; }
      }
    }
    if (same) return id;
  }
  return CUSTOM;
}

// ---------------------------------------------------------------------------------------------
// The configuration itself

/**
 * Create a realism configuration.
 *
 * With no argument, or with anything unrecognised, this returns OFF — the direction a defaulting
 * mistake has to fail in, because a user who did not ask for realism must never get it.
 *
 * @param {string|object} [preset] a preset id ('OFF', 'LIGHT', 'FULL', 'PUNISHING') or a preset
 *   object from `PRESET`. Defaults to OFF.
 * @returns {object} a mutable configuration: {version, preset, features, rates, seed}
 */
export function createRealismConfig(preset) {
  const id = presetId(preset) || 'OFF';
  const p = PRESET[id];
  return {
    version: REALISM_VERSION,
    preset: id,
    features: { ...p.features },
    rates: { ...p.rates },
    // The seed for every stochastic thing in this layer. Fixed, not drawn from a clock: a
    // maintenance history that cannot be reproduced from a seed cannot be taught from, because
    // "why did that bearing go" has no answer you can go back and check.
    seed: 20240517,
  };
}

/**
 * Is a feature switched on?
 *
 * Returns false for a missing configuration and for an unknown id, so a caller that has not been
 * given a realism configuration at all behaves exactly like one that has it switched off.
 *
 * @param {object} cfg the configuration
 * @param {string} id a `FEATURE` id
 * @returns {boolean} true only if the configuration is sound and the feature is on
 */
export function isOn(cfg, id) {
  if (!isRecord(cfg) || !isRecord(cfg.features)) return false;
  if (typeof id !== 'string') return false;
  return cfg.features[id] === true;
}

/**
 * Is anything on at all?
 *
 * The cheap test `sim.js` and the UI use to skip the whole layer, and the one that makes "OFF is
 * inert" checkable in one line rather than seven.
 *
 * @param {object} cfg the configuration
 * @returns {boolean} true if at least one of the seven features is enabled
 */
export function anyOn(cfg) {
  return FEATURE_ORDER.some((id) => isOn(cfg, id));
}

/**
 * Turn one feature on or off.
 *
 * An unknown id is refused rather than ignored: silently accepting `setFeature(cfg, 'WARE', true)`
 * would leave a user staring at a switch they believe they threw, wondering why the plant never
 * degrades.
 *
 * Dependencies are NOT enforced here. Every feature is individually switchable by design; a
 * combination that cannot do anything useful — failures with no wear to fail from — is reported
 * by `validateRealismConfig()` as something to read, not as something to refuse.
 *
 * @param {object} cfg the configuration to modify in place
 * @param {string} id a `FEATURE` id
 * @param {boolean} on true to enable
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function setFeature(cfg, id, on) {
  if (!isRecord(cfg) || !isRecord(cfg.features)) {
    return { ok: false, reason: 'There is no realism configuration to change.' };
  }
  if (typeof id !== 'string' || !FEATURE_ORDER.includes(id)) {
    return { ok: false, reason: `There is no realism feature called "${String(id)}". The seven are ${FEATURE_ORDER.join(', ')}.` };
  }
  cfg.features[id] = on === true;
  cfg.preset = labelFor(cfg);
  return { ok: true };
}

/**
 * Apply a preset, replacing every feature and every rate.
 *
 * A preset is a complete configuration on purpose: applying one after another must not leave a
 * knob behind from the first, because a user who selected PUNISHING and then OFF and still had a
 * 2.5x lead time would rightly conclude the simulator was broken.
 *
 * @param {object} cfg the configuration to modify in place
 * @param {string|object} id a preset id or a preset object
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function setPreset(cfg, id) {
  if (!isRecord(cfg)) return { ok: false, reason: 'There is no realism configuration to change.' };
  const pid = presetId(id);
  if (!pid) {
    return { ok: false, reason: `There is no realism preset called "${String(isRecord(id) ? id.id : id)}". The four are ${PRESET_ORDER.join(', ')}.` };
  }
  const p = PRESET[pid];
  cfg.features = { ...p.features };
  cfg.rates = { ...p.rates };
  cfg.preset = pid;
  return { ok: true };
}

/**
 * Set one rate.
 *
 * Out-of-range values are refused with the range in the message rather than clamped, because a
 * clamp is a silent disagreement: the user asked for 50x wear, got 10x, and every conclusion they
 * draw afterwards is off by five.
 *
 * @param {object} cfg the configuration to modify in place
 * @param {string} key a key from `RATES`
 * @param {number} value the new value
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function setRate(cfg, key, value) {
  if (!isRecord(cfg) || !isRecord(cfg.rates)) {
    return { ok: false, reason: 'There is no realism configuration to change.' };
  }
  const meta = typeof key === 'string' ? RATE_BY_KEY[key] : null;
  if (!meta) {
    return { ok: false, reason: `There is no realism rate called "${String(key)}". The keys are ${RATES.map((r) => r.key).join(', ')}.` };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `${meta.name} has to be a number.` };
  }
  if (value < meta.min || value > meta.max) {
    return { ok: false, reason: `${meta.name} has to be between ${meta.min} and ${meta.max} ${meta.unit}; ${value} is outside that.` };
  }
  cfg.rates[key] = value;
  cfg.preset = labelFor(cfg);
  return { ok: true };
}

/**
 * Read one rate, falling back to its documented default.
 *
 * Every module in this layer reads its multipliers through here rather than off `cfg.rates`
 * directly, so a configuration that arrived from an older save with a key missing behaves as the
 * default rather than as `undefined * something`, which is NaN and would quietly poison a plant
 * state that nothing else in the simulator checks.
 *
 * @param {object} cfg the configuration
 * @param {string} key a key from `RATES`
 * @returns {number} the configured value, or the default, or 1 for an unknown key
 */
export function rateOf(cfg, key) {
  const meta = typeof key === 'string' ? RATE_BY_KEY[key] : null;
  if (!meta) return 1;
  if (!isRecord(cfg) || !isRecord(cfg.rates)) return meta.def;
  return clamp(num(cfg.rates[key], meta.def), meta.min, meta.max);
}

/**
 * Set the seed every stochastic mechanism in this layer draws from.
 *
 * @param {object} cfg the configuration to modify in place
 * @param {number} seed a non-negative integer
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function setSeed(cfg, seed) {
  if (!isRecord(cfg)) return { ok: false, reason: 'There is no realism configuration to change.' };
  if (!Number.isInteger(seed) || seed < 0) {
    return { ok: false, reason: 'The realism seed has to be a whole number of zero or more, so the same plant history can be reproduced from it.' };
  }
  cfg.seed = seed;
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The clock. This is the only place in the layer allowed to convert wall time into plant age.

/**
 * Convert a scan interval into equipment hours.
 *
 * THE contract of this module. Every degradation, drift, consumption and fatigue rate in
 * `src/realism` is quoted at its real engineering value — hours, months, years — and every one of
 * them integrates against this function rather than against `dt_s / 3600`. That is what keeps the
 * acceleration factor a single documented number the UI can display instead of a fudge smeared
 * across five modules.
 *
 * A negative or non-finite interval returns zero rather than running the plant backwards; a scan
 * that arrives with a bad `dt` is a bug somewhere upstream and ageing the machine by NaN would
 * hide it behind a plant state full of NaN an hour later.
 *
 * @param {object} cfg the configuration
 * @param {number} dt_s the scan interval in real seconds
 * @returns {number} equipment hours elapsed
 */
export function agedHours(cfg, dt_s) {
  const dt = num(dt_s, 0);
  if (dt <= 0) return 0;
  return (dt / 3600) * rateOf(cfg, 'ageing');
}

/**
 * The same conversion in days, for the things that are quoted in days: supplier lead times,
 * chemical deliveries, calibration intervals on a certificate.
 *
 * @param {object} cfg the configuration
 * @param {number} dt_s the scan interval in real seconds
 * @returns {number} equipment days elapsed
 */
export function agedDays(cfg, dt_s) {
  return agedHours(cfg, dt_s) / 24;
}

/**
 * The sentence the UI is required to show whenever any realism feature is on.
 *
 * This is not decoration. A user who does not know the plant is ageing 720 times faster than the
 * clock will read a bearing that failed in forty minutes as a broken simulator, and — worse —
 * will draw the wrong conclusion about how quickly real machines degrade. Stating the compression
 * is what makes every other number in the layer honest.
 *
 * @param {object} cfg the configuration
 * @returns {string} a sentence naming the factor and what it means in practice
 */
export function describeAgeing(cfg) {
  const f = rateOf(cfg, 'ageing');
  const daysPerHour = f / 24;
  const calHours = 8760 / f;
  if (f <= 1) {
    return 'Degradation is running in real time: nothing in this layer will visibly change inside a '
      + 'session. Raise the time compression if you want to see wear or drift arrive.';
  }
  return `Degradation is running ${f.toFixed(0)} times faster than the clock — one hour at the desk `
    + `is about ${daysPerHour.toFixed(0)} days on the machine, and a twelve-month calibration `
    + `interval falls due after roughly ${calHours.toFixed(0)} hours of play. Run hours and `
    + 'condition are quoted on that compressed clock, not on wall time.';
}

// ---------------------------------------------------------------------------------------------
// Prose and validation

/**
 * The paragraph an operator should read before switching a preset on.
 *
 * @param {string|object} id a preset id or a preset object
 * @returns {string|null} the description, or null if there is no such preset
 */
export function describePreset(id) {
  const pid = presetId(id);
  if (pid) return PRESET[pid].detail;
  if (id === CUSTOM || (isRecord(id) && id.id === CUSTOM)) {
    return 'A configuration of your own: one or more switches or rates have been moved away from '
      + 'any of the four shipped presets. Nothing is wrong with that — but the shipped presets are '
      + 'the ones whose combinations have been thought about, so check the warnings on this page '
      + 'before you conclude the plant is misbehaving.';
  }
  return null;
}

/**
 * What one feature does, for the dialog.
 *
 * @param {string} id a `FEATURE` id
 * @returns {object|null} the entry from `FEATURE_INFO`, or null
 */
export function describeFeature(id) {
  return FEATURE_INFO.find((f) => f.id === id) || null;
}

/**
 * Check a configuration and return everything wrong with it, as sentences.
 *
 * Two kinds of problem land here. The first is structural — a missing feature, a rate outside its
 * range, a version from the future — and means the object should not be trusted. The second is
 * incoherence: a combination that is legal, because every switch is independent by design, but
 * that cannot do what the user presumably wanted. Failures with no wear underneath them will
 * never fire; work orders with no wear have nothing to raise a job against. Those are the
 * combinations a user reaches by flipping one switch and then wondering for twenty minutes why
 * nothing happened, so they are worth a sentence.
 *
 * @param {object} cfg the configuration
 * @returns {string[]} problems, empty if the configuration is sound and coherent
 */
export function validateRealismConfig(cfg) {
  const problems = [];
  if (!isRecord(cfg)) return ['There is no realism configuration at all.'];
  if (!Number.isInteger(cfg.version) || cfg.version < 1) {
    problems.push('The configuration carries no usable version number.');
  } else if (cfg.version > REALISM_VERSION) {
    problems.push(`The configuration was written by a newer build (version ${cfg.version}, this one understands ${REALISM_VERSION}).`);
  }
  if (!Number.isInteger(cfg.seed) || cfg.seed < 0) {
    problems.push('The realism seed is not a whole number, so this plant history could not be reproduced.');
  }

  if (!isRecord(cfg.features)) {
    problems.push('The configuration has no feature switches.');
  } else {
    for (const id of FEATURE_ORDER) {
      if (typeof cfg.features[id] !== 'boolean') {
        problems.push(`The ${id} switch is neither on nor off.`);
      }
    }
    for (const k of Object.keys(cfg.features)) {
      if (!FEATURE_ORDER.includes(k)) problems.push(`"${k}" is not a realism feature.`);
    }
  }

  if (!isRecord(cfg.rates)) {
    problems.push('The configuration has no rates.');
  } else {
    for (const r of RATES) {
      const v = cfg.rates[r.key];
      if (!Number.isFinite(v)) problems.push(`${r.name} has no usable value.`);
      else if (v < r.min || v > r.max) {
        problems.push(`${r.name} is ${v} ${r.unit}, outside the ${r.min} to ${r.max} it is allowed to take.`);
      }
    }
    for (const k of Object.keys(cfg.rates)) {
      if (!RATE_BY_KEY[k]) problems.push(`"${k}" is not a realism rate.`);
    }
  }

  if (isRecord(cfg.features)) {
    for (const info of FEATURE_INFO) {
      if (!isOn(cfg, info.id)) continue;
      for (const need of info.needs) {
        if (!isOn(cfg, need)) {
          problems.push(`${info.name} is on but ${need} is off, so it has nothing to work on and you will see no effect from it.`);
        }
      }
    }
    if (isOn(cfg, FEATURE.WEAR) && rateOf(cfg, 'wear') === 0 && rateOf(cfg, 'fouling') === 0) {
      problems.push('Machinery wear is on but both its severity rates are zero, so nothing will ever degrade.');
    }
    if (isOn(cfg, FEATURE.FAILURES) && rateOf(cfg, 'failure') === 0) {
      problems.push('Sudden failures are on but the failure hazard is zero, so nothing will ever break.');
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// Persistence. The storage is whatever the browser handed the UI, which means absent, throwing on
// read, throwing on write and holding something a previous build wrote are all ordinary cases.

/**
 * Rebuild a trustworthy configuration from whatever came out of storage.
 *
 * Field by field onto a fresh OFF configuration, so an unknown feature, a mistyped switch or a
 * rate from a build that had one we no longer have is dropped rather than inherited. Rates are
 * CLAMPED here rather than refused — unlike `setRate`, which is a user acting deliberately, this
 * is a repair of a file nobody is watching, and dropping a whole configuration because one number
 * was edited to 99 would cost more than it saves.
 *
 * @param {*} raw the parsed contents of storage
 * @returns {object} a sound configuration
 */
function sanitize(raw) {
  const cfg = createRealismConfig('OFF');
  if (!isRecord(raw)) return cfg;
  if (isRecord(raw.features)) {
    for (const id of FEATURE_ORDER) {
      if (typeof raw.features[id] === 'boolean') cfg.features[id] = raw.features[id];
    }
  }
  if (isRecord(raw.rates)) {
    for (const r of RATES) {
      const v = raw.rates[r.key];
      if (Number.isFinite(v)) cfg.rates[r.key] = clamp(v, r.min, r.max);
    }
  }
  if (Number.isInteger(raw.seed) && raw.seed >= 0) cfg.seed = raw.seed;
  cfg.preset = labelFor(cfg);
  return cfg;
}

/**
 * Read the realism configuration from injected storage.
 *
 * Always returns a usable configuration. A missing storage, a `getItem` that throws, an empty
 * string, unparseable text or a save from another build all land on OFF — the only safe direction
 * for this particular failure, because a user whose settings could not be read must not silently
 * find themselves running PUNISHING.
 *
 * @param {{getItem: Function}|null} storage anything with `getItem`, or null
 * @returns {object} a sound configuration, OFF if nothing usable was stored
 */
export function loadRealismConfig(storage) {
  if (!storage || typeof storage.getItem !== 'function') return createRealismConfig('OFF');
  let text = null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return createRealismConfig('OFF');
  }
  if (typeof text !== 'string' || text.length === 0) return createRealismConfig('OFF');
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return createRealismConfig('OFF');
  }
  return sanitize(raw);
}

/**
 * Write the realism configuration to injected storage.
 *
 * A storage that throws on write is ordinary — private browsing, a full quota — and it must never
 * damage the configuration already in memory. The settings the user chose stay in force for this
 * session; all that is lost is the memory of them, and the reason is returned as a sentence so
 * the UI can say so rather than failing silently.
 *
 * @param {{setItem: Function}|null} storage anything with `setItem`, or null
 * @param {object} cfg the configuration to persist
 * @returns {{ok: boolean, reason?: string}} ok, or why not
 */
export function saveRealismConfig(storage, cfg) {
  if (!isRecord(cfg)) return { ok: false, reason: 'There is no realism configuration to save.' };
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, reason: 'This browser is not offering any storage, so these realism settings will only last until the tab closes.' };
  }
  let text = '';
  try {
    text = JSON.stringify({
      v: REALISM_VERSION,
      version: REALISM_VERSION,
      preset: cfg.preset,
      features: cfg.features,
      rates: cfg.rates,
      seed: cfg.seed,
    });
  } catch {
    return { ok: false, reason: 'The realism settings could not be turned into text and were not saved.' };
  }
  try {
    storage.setItem(STORAGE_KEY, text);
  } catch {
    return { ok: false, reason: 'The browser refused to save the realism settings — private browsing or a full storage quota. They still apply until you close the tab.' };
  }
  return { ok: true };
}
