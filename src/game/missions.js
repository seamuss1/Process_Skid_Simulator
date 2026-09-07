/**
 * src/game/missions.js — the campaign: twenty-two shifts, five tiers, and the order the features
 * are earned in.
 *
 * Layer L4 (game): imports `core/util.js` and `data/config.js` only. No DOM, no timers, no
 * randomness — a mission is a DATA record, and the director, the scorer and the session are what
 * bring it to life.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THE CAMPAIGN IS SHAPED LIKE THIS
 *
 * The sandbox has every control feature switched on from the first frame, which is exactly why
 * nobody learns anything from it: with cascade, feedforward, staging and an autotuner all
 * available at once, a beginner has no way to find out what any single one of them is FOR. The
 * campaign fixes that by taking them all away and handing them back one at a time, and each one
 * arrives immediately after the shift whose pain it removes. You do not get reset until you have
 * spent three minutes staring at an offset that will not close. You do not get staging until a
 * single machine has run out of road with the header still falling.
 *
 * That gives the tier structure:
 *
 *   1 HANDS      Manual only. Learn that the header answers late, and that a valve you can see
 *                moving is not a process you can see moving.
 *   2 THE LOOP   Proportional, the offset it leaves, reset, and the windup reset brings.
 *   3 THE UPSET  Regulation. The demand moves and you reject it; then rate action, and what a
 *                noisy transmitter does to it; then a cycle that is not a tuning problem at all.
 *   4 MACHINERY  The discrete half of the plant: staging, short-cycling, minimum flow, NPSH,
 *                duty and the electricity bill.
 *   5 STRATEGY   Structures. Cascade, feedforward, gain scheduling, and a full shift that throws
 *                all of it at you at once.
 *
 * THE DIFFICULTY CURVE IS THREE NUMBERS, and they move together on purpose:
 *
 *   band       starts at 0.25 bar — a quarter of a bar, which a beginner can hold by hand — and
 *              finishes at 0.05 bar, which is about eight times the transmitter noise and needs a
 *              tuning that is actually right. It never widens.
 *   duration   90 s to 300 s. A longer shift is harder for the same reason a longer drive is:
 *              there is more of it to get wrong, and the multiplier has further to fall.
 *   par.gold   never falls either. Because score accrues per second, a later mission must be long
 *              enough that its gold is worth more than the previous one's even though a smaller
 *              fraction of the theoretical maximum is being asked for.
 *
 * A NOTE ON COMPARING BANDS ACROSS LOOP MODES. Two missions run on FIC-101 rather than PIC-101,
 * and 2.6 m3/h is not comparable with 0.15 bar by inspection. The quantity that IS comparable is
 * the band as a fraction of the transmitter span, which is what {@link bandFraction} returns and
 * what the curve is actually monotone in. The engineering-unit number is what the player sees;
 * the fraction is what the design is checked against.
 * ------------------------------------------------------------------------------------------
 */

import { deepFreeze } from '../core/util.js';
import { LOOP, LOOP_EU } from '../data/config.js';

/**
 * The tiers, in the order they are played. `feature` names the one idea the tier exists to teach,
 * so the tier card can say it without repeating a mission brief.
 */
export const TIERS = Object.freeze([
  Object.freeze({
    n: 1,
    id: 'HANDS',
    title: 'On the handle',
    feature: 'manual control',
    blurb: 'No controller. Just you, the drive reference, and a header that answers late.',
  }),
  Object.freeze({
    n: 2,
    id: 'LOOP',
    title: 'Closing the loop',
    feature: 'proportional and reset',
    blurb: 'Gain buys you speed and leaves you an offset. Reset closes the offset and costs you '
      + 'stability. Both bills come due here.',
  }),
  Object.freeze({
    n: 3,
    id: 'UPSET',
    title: 'Rejecting the upset',
    feature: 'regulation, rate action, diagnosis',
    blurb: 'Nobody is moving the setpoint any more. The load moves instead, and your job is to '
      + 'make the header not notice.',
  }),
  Object.freeze({
    n: 4,
    id: 'MACHINERY',
    title: 'Minding the machines',
    feature: 'staging, protection, energy',
    blurb: 'The loop is continuous and the plant is not. Two pumps, one header, and a set of '
      + 'limits that do not negotiate.',
  }),
  Object.freeze({
    n: 5,
    id: 'STRATEGY',
    title: 'Building a strategy',
    feature: 'cascade, feedforward, scheduling',
    blurb: 'When tuning has run out, the answer is a different structure. Three of them, then a '
      + 'full shift with everything at once.',
  }),
]);

/**
 * Every feature the campaign hands back, in the order it is earned.
 *
 * These are the ids from `profile.js`'s `UNLOCKS` map, minus its `BASE_UNLOCK` — a fresh profile
 * already holds `manual`, because being able to drive the rig by hand is not a reward, it is the
 * starting condition. `validateMissions` demands that every id here is granted by exactly one
 * mission, so a feature that is declared and never awarded is a build failure rather than a
 * button nobody can ever reach.
 */
export const UNLOCK_IDS = Object.freeze([
  'proportional',
  'reset',
  'spWeight',
  'derivative',
  'analysis',
  'staging',
  'rotation',
  'cascade',
  'feedforward',
  'gainSchedule',
  'autotune',
]);

/**
 * The upsets a campaign script may call for, with a note on what each one does at full magnitude.
 *
 * THE MAGNITUDE CONVENTION, because it is the thing a mission author gets wrong. `mag` is a
 * SEVERITY in -1..+1, never an engineering value: the director scales its own physical range by
 * `|mag|` and reads the SIGN only where direction is meaningful (a setpoint the supervisor wants
 * lower is a negative `mag`). Writing `FOULING` as 0.55 meaning "55% blinded" would land as
 * severity 0.55 and blind the strainer to 60%, which is close enough to look right and wrong
 * enough to make a mission unrepeatable; writing a setpoint of 3.6 would clamp to full severity
 * and move the header by a fifth of span.
 *
 * The demand upsets are RELATIVE to whatever the valve is at when they fire, and nothing reverts
 * until the shift ends, so a script's demand walks rather than teleports — which is what a real
 * shift does, and why each row below is written as a change and not as a destination.
 */
export const UPSET_MAG = Object.freeze({
  /** Demand valve opens a further 10..42% of travel. */
  DEMAND_SURGE: 'severity 0..1 — opens the demand valve 10..42% of travel further',
  /** Demand valve gives back 12..42% of travel. */
  DEMAND_COLLAPSE: 'severity 0..1 — shuts the demand valve 12..42% of travel',
  /** Demand walks up 14..44% of travel over 90..45 s. Always upward; use a collapse to come back. */
  DEMAND_RAMP: 'severity 0..1 — walks demand up 14..44% over 90..45 s',
  /** Supervisor moves the setpoint 6..16% of span. Negative `mag` moves it down. */
  SP_CHANGE: 'severity -1..1 — moves the setpoint 6..16% of span, sign is direction',
  /** Make-up isolated and the tank drawn down 0.35..1.1 m. */
  LEVEL_SWING: 'severity 0..1 — draws the suction tank down 0.35..1.1 m',
  /** VG 32 below 0.55, VG 150 above it. The step is a cliff, not a ramp. */
  FLUID_CHANGE: 'severity 0..1 — VG 32 below 0.55, VG 150 above',
  /** Strainer blinds a further 35..80% over a couple of minutes. */
  FOULING: 'severity 0..1 — blinds the strainer a further 35..80%',
  /** Stem friction of 1.2..5.5% appears in whichever element the loop is modulating. */
  STICTION: 'severity 0..1 — 1.2..5.5% stickband on the final element',
  /** Transmitter picks up 0.4..2.0% of span in electrical noise. */
  NOISE: 'severity 0..1 — 0.4..2.0% of span in transmitter noise',
  /** Controller scan stretches by 0.35..1.75 s, all of it dead time. */
  SCAN_SLOW: 'severity 0..1 — stretches the scan by 0.35..1.75 s',
  /** A running machine trips on overload. Magnitude is ignored; a trip is a trip. */
  PUMP_TRIP: 'severity ignored — a running machine trips on overload',
  /** Pressure over the suction tank sags 0.08..0.30 bar, straight off NPSH available. */
  SUPPLY_SAG: 'severity 0..1 — 0.08..0.30 bar off the suction',
  /** Discharge static head rises 4..16 m as the receiving vessel fills. */
  BACKPRESSURE: 'severity 0..1 — 4..16 m more discharge static head',
  /** Demand valve shuts in one second, dumping 55..95% of the load into the header. */
  VALVE_SLAM: 'severity 0..1 — shuts the demand valve in 1 s, dumping 55..95% of load',
});

/** The upset ids, for validation and for anyone building a picker. */
export const UPSET_IDS = Object.freeze(Object.keys(UPSET_MAG));

/**
 * The heaviest demand a mission may script the valve to, and why there are two numbers.
 *
 * Measured on the shipped rig: one machine at 0.90 travel draws 17.9 kW against a 15 kW motor and
 * trips the overload inside a few minutes, and two machines at full travel draw 34 kW and trip
 * both. A campaign mission that ends in a trip has FAILED the player rather than tested them, so
 * the ceilings are set below where the thermal model bites and `validateMissions` walks every
 * script's demand trajectory against them.
 */
export const DEMAND_CEILING = Object.freeze({ onePump: 0.80, twoPumps: 0.92 });

/**
 * The sim actions a `setup` record is allowed to name.
 *
 * A mission's setup is declarative — `{action, args}` rather than a closure — so that it can be
 * serialised into a share code, shown to the player on the brief card, and replayed exactly. The
 * price of that is that nothing checks the action name at authoring time, so this allowlist does
 * it instead: an action outside this set is either a typo or a mission reaching for something the
 * campaign has no business doing (`forceTrip`, `beginAutotune`, `togglePause`).
 */
export const SETUP_ACTIONS = Object.freeze([
  'setLoopMode',
  'setSetpoint',
  'setControllerMode',
  'setManualOutput',
  'setTuning',
  'setAlgorithm',
  'setScan',
  'setStaging',
  'setStrategy',
  'setDisturbance',
  'startPump',
  'stopPump',
  'autoPump',
]);

/**
 * The scoring rules every mission starts from, straight out of the design.
 *
 * They live here rather than being imported from `score.js` because a mission has to be able to
 * DEPART from them — the two missions that are explicitly about wear and electricity charge more
 * for output travel — and a per-mission override that reads as a patch over a shared default is
 * easier to defend than twenty-two hand-written rule blocks.
 */
export const RULE_DEFAULTS = Object.freeze({
  /** Points per second while the measurement is inside the band, before the multiplier. */
  inBandRate: 10,
  /** Multiplier ceiling. Four means a clean two-minute hold is worth four times a scrappy one. */
  maxMult: 4,
  /** Points per percent of controller-output travel. The wear term. */
  thrashPenalty: 0.05,
  /** One-off, on the transition into alarm. */
  alarmPenalty: 150,
  /** Points per second while a machine is cavitating or below minimum continuous flow. */
  cavPenalty: 40,
});

/**
 * Steady electrical demand of the rig, measured on the shipped plant by settling PIC-101 at
 * 3.2 bar with the demand valve at each travel and reading the energy accumulator.
 *
 * This table is here so the `parEnergy_kWh` figures below are checkable rather than asserted. Par
 * for a mission is the time-weighted mean of these against its own demand profile; beat it and
 * the energy bonus pays, miss it and it charges. Two pumps are running from 0.72 upward, which is
 * why the curve has a step in it and not a bend.
 */
export const DUTY_KW = Object.freeze({
  0.25: 2.1, 0.35: 2.4, 0.45: 3.1, 0.55: 4.7, 0.65: 8.2, 0.75: 9.9, 0.85: 16.4,
});

/**
 * Build a frozen rule block for a mission.
 * @param {number} band half-width of the tolerance band, in the loop's engineering units
 * @param {string} bandEU the unit that band is expressed in, for the trend label
 * @param {object} [over] per-mission departures from {@link RULE_DEFAULTS}
 * @returns {object} the frozen rules
 */
function rules(band, bandEU, over) {
  return Object.freeze({ ...RULE_DEFAULTS, ...over, band, bandEU });
}

/**
 * Shorthand for a setup record, so a mission row reads as a list of instructions rather than a
 * list of object literals.
 * @param {string} action the sim action name, from {@link SETUP_ACTIONS}
 * @param {...*} args the arguments it is called with, after `ctx`
 * @returns {{action:string, args:Array}} the record
 */
function act(action, ...args) {
  return { action, args };
}

/**
 * Shorthand for a scripted upset.
 * @param {number} at_s seconds from the start of the shift
 * @param {string} upset an id from {@link UPSET_MAG}
 * @param {number} mag the magnitude, interpreted per {@link UPSET_MAG}
 * @param {string} label what the ticker says when it telegraphs, in plant language
 * @returns {object} the script entry
 */
function up(at_s, upset, mag, label) {
  return { at_s, upset, mag, label };
}

/** Put the rig in manual on one machine, with the lag locked out. The tier-1 starting state. */
const HAND_ONLY = [
  act('setStaging', { enabled: false }),
  act('stopPump', 1),
  act('setControllerMode', 'MAN'),
  act('setManualOutput', 35),
  act('setDisturbance', { demandTarget: 0.45 }),
];

/** One machine, controller in auto, sequence off. The tier-2 and tier-3 starting state. */
const SOLO_AUTO = [
  act('setStaging', { enabled: false }),
  act('stopPump', 1),
  act('setControllerMode', 'AUTO'),
  act('setDisturbance', { demandTarget: 0.5 }),
];

/**
 * The campaign.
 *
 * Read the rows in order: `requires` is a straight chain, so the table's order IS the play order
 * and there is no separate ordering field to fall out of step with it.
 */
export const MISSIONS = deepFreeze([

  // === TIER 1 — HANDS =========================================================================
  {
    id: 'HANDS_ON',
    tier: 1,
    title: 'Hold it by hand',
    brief: 'Nights left it at 3.2 bar and it has sat there all morning. PIC-101 is in manual, so '
      + 'the number you type is the number the drive gets. Process are opening up around the half '
      + 'hour — keep the header on 3.2 and do not let it wander.',
    teaches: 'Output is not pressure. You set a speed; the header decides the rest.',
    loop: LOOP.PRESSURE,
    duration_s: 90,
    band: 0.25,
    rules: rules(0.25, 'bar'),
    seed: 0x4841_4e44,
    setup: HAND_ONLY,
    script: [
      up(35, 'DEMAND_SURGE', 0.2, 'process opening up'),
    ],
    par: { bronze: 950, silver: 1400, gold: 1850 },
    parEnergy_kWh: 0.13,
    unlocks: [],
    requires: [],
  },
  {
    id: 'DEAD_TIME',
    tier: 1,
    title: 'It answers late',
    brief: 'Same rig, still in manual. Downstream are walking their valve open over the next '
      + 'minute or so. Chase it if you like — you will find out how long the header takes to '
      + 'answer, which is the whole point of the exercise.',
    teaches: 'Dead time plus lag. Correct once and wait, or you will chase your own correction.',
    loop: LOOP.PRESSURE,
    duration_s: 110,
    band: 0.25,
    rules: rules(0.25, 'bar'),
    seed: 0x4c41_4731,
    setup: HAND_ONLY,
    script: [
      up(25, 'DEMAND_RAMP', 0.35, 'demand walking up'),
    ],
    par: { bronze: 1200, silver: 1800, gold: 2350 },
    parEnergy_kWh: 0.16,
    unlocks: [],
    requires: ['HANDS_ON'],
  },
  {
    id: 'SUPERVISOR',
    tier: 1,
    title: 'New number from the office',
    brief: 'Load is steady, but the shift supervisor wants the header lifted for a transfer and '
      + 'then put back. He will tell you before he does it. Move it by hand and settle it — a '
      + 'setpoint that arrives with warning is not an upset, it is a plan.',
    teaches: 'A telegraphed change is free. Pre-position before it lands, not after.',
    loop: LOOP.PRESSURE,
    duration_s: 130,
    band: 0.22,
    rules: rules(0.22, 'bar'),
    seed: 0x5350_4d56,
    setup: HAND_ONLY,
    script: [
      up(25, 'SP_CHANGE', 0.1, 'supervisor wants the header up for a transfer'),
      up(80, 'SP_CHANGE', -0.3, 'transfer done — put it back down'),
    ],
    par: { bronze: 1450, silver: 2150, gold: 2800 },
    parEnergy_kWh: 0.12,
    unlocks: [],
    requires: ['DEAD_TIME'],
  },
  {
    id: 'TOO_MANY_HANDS',
    tier: 1,
    title: 'Three things at once',
    brief: 'Busy half hour coming: they open up, then they drop off hard, then they come back. '
      + 'All by hand, all yours. If you finish this thinking there ought to be something doing '
      + 'this for you, that is the correct conclusion.',
    teaches: 'Manual control does not scale. This is the argument for a controller.',
    loop: LOOP.PRESSURE,
    duration_s: 150,
    band: 0.22,
    rules: rules(0.22, 'bar'),
    seed: 0x4d41_4e59,
    setup: HAND_ONLY,
    script: [
      up(25, 'DEMAND_SURGE', 0.35, 'process opening up'),
      up(70, 'DEMAND_COLLAPSE', 0.75, 'they have dropped off'),
      up(110, 'DEMAND_SURGE', 0.5, 'and back on again'),
    ],
    par: { bronze: 1700, silver: 2500, gold: 3300 },
    parEnergy_kWh: 0.21,
    unlocks: ['proportional'],
    requires: ['SUPERVISOR'],
  },

  // === TIER 2 — THE LOOP ======================================================================
  {
    id: 'FIRST_AUTO',
    tier: 2,
    title: 'Put it in auto',
    brief: 'Gain only — reset is switched out, so all this controller does is multiply the error. '
      + 'Kc is on 12 to start. Take it up until it is quick and stop before it starts ringing. '
      + 'Two demand changes coming.',
    teaches: 'Gain is speed. Too much of it is a loop that argues with the process.',
    loop: LOOP.PRESSURE,
    duration_s: 160,
    band: 0.20,
    rules: rules(0.20, 'bar'),
    seed: 0x4155_546f,
    setup: [
      ...SOLO_AUTO,
      // Ti is a very large number rather than Infinity: `setTuning` refuses anything that is not
      // greater than zero, and a serialised mission has to survive a JSON round trip, which
      // Infinity does not.
      act('setTuning', { Kc: 12, Ti: 1e6, Td: 0 }),
      act('setSetpoint', 3.2),
    ],
    script: [
      up(30, 'DEMAND_SURGE', 0.3, 'process opening up'),
      up(95, 'DEMAND_COLLAPSE', 0.8, 'and dropping off'),
    ],
    par: { bronze: 1850, silver: 2700, gold: 3550 },
    parEnergy_kWh: 0.24,
    unlocks: [],
    requires: ['TOO_MANY_HANDS'],
  },
  {
    id: 'THE_OFFSET',
    tier: 2,
    title: 'The gap that will not close',
    brief: 'Still gain only. You will notice it settles NEAR setpoint and never on it, and that '
      + 'the gap changes size every time the load does. More gain shrinks it and makes the loop '
      + 'nervier. Find out how far that trade goes before you run out of band.',
    teaches: 'Proportional offset. Zero error means zero correction, and no pump runs on zero.',
    loop: LOOP.PRESSURE,
    duration_s: 175,
    band: 0.20,
    rules: rules(0.20, 'bar'),
    seed: 0x4f46_4653,
    setup: [
      ...SOLO_AUTO,
      act('setTuning', { Kc: 14, Ti: 1e6, Td: 0 }),
      act('setSetpoint', 3.2),
    ],
    script: [
      up(30, 'SP_CHANGE', 0.1, 'supervisor wants it a little higher'),
      up(90, 'DEMAND_SURGE', 0.2, 'process opening up'),
      up(140, 'DEMAND_COLLAPSE', 0.6, 'and off again'),
    ],
    par: { bronze: 2050, silver: 2950, gold: 3900 },
    parEnergy_kWh: 0.25,
    unlocks: ['reset'],
    requires: ['FIRST_AUTO'],
  },
  {
    id: 'RESET_TIME',
    tier: 2,
    title: 'Reset earns its keep',
    brief: 'Ti is live now, sat on 30 seconds, which is far too slow to be useful. Bring it down '
      + 'until the offset goes away quickly, and stop when the recovery starts to overshoot and '
      + 'come back. That point is not a matter of taste — you will see it.',
    teaches: 'Integral removes offset by never being satisfied. Too much of it rings, and a '
      + 'setpoint step is where the ringing shows first.',
    loop: LOOP.PRESSURE,
    duration_s: 190,
    band: 0.18,
    rules: rules(0.18, 'bar'),
    seed: 0x5245_5354,
    setup: [
      ...SOLO_AUTO,
      act('setTuning', { Kc: 18, Ti: 30, Td: 0 }),
      act('setSetpoint', 3.2),
    ],
    script: [
      up(30, 'DEMAND_SURGE', 0.3, 'process opening up'),
      up(90, 'DEMAND_COLLAPSE', 0.7, 'dropping off'),
      up(145, 'SP_CHANGE', 0.2, 'supervisor wants it up a bit'),
    ],
    par: { bronze: 2200, silver: 3250, gold: 4250 },
    parEnergy_kWh: 0.26,
    unlocks: ['spWeight'],
    requires: ['THE_OFFSET'],
  },
  {
    id: 'THE_WINDUP',
    tier: 2,
    title: 'When it stops listening',
    brief: 'P-102 is locked out for a mechanical inspection, so there is one machine on the '
      + 'header and back-calculation has been switched out on the controller. Process are about to '
      + 'ask for more than one pump can make. When they back off, watch how long the loop takes to '
      + 'notice you exist again.',
    teaches: 'Windup. The integral keeps counting into a number the output cannot express.',
    loop: LOOP.PRESSURE,
    duration_s: 200,
    band: 0.18,
    rules: rules(0.18, 'bar'),
    seed: 0x5749_4e44,
    setup: [
      ...SOLO_AUTO,
      // Tt is the back-calculation time constant; a huge value is an anti-windup scheme that
      // never gets round to it, which is what this shift is about.
      act('setTuning', { Kc: 20, Ti: 8, Td: 0, Tt: 1e9 }),
      act('setSetpoint', 3.2),
    ],
    script: [
      up(35, 'DEMAND_SURGE', 0.5, 'process asking for everything'),
      up(110, 'DEMAND_COLLAPSE', 0.8, 'they are off — recover the header'),
      up(160, 'DEMAND_SURGE', 0.3, 'and back on'),
    ],
    par: { bronze: 2350, silver: 3400, gold: 4500 },
    parEnergy_kWh: 0.38,
    unlocks: [],
    requires: ['RESET_TIME'],
  },

  // === TIER 3 — THE UPSET =====================================================================
  {
    id: 'LOAD_REJECT',
    tier: 3,
    title: 'Nobody touches the setpoint',
    brief: '3.2 bar all shift, and the load will not sit still. Four changes, all telegraphed. '
      + 'This is the job the loop actually does — everything before this was practice.',
    teaches: 'Regulation, not servo. The measure is how little the header moved, not how fast it '
      + 'got back.',
    loop: LOOP.PRESSURE,
    duration_s: 205,
    band: 0.16,
    rules: rules(0.16, 'bar'),
    seed: 0x4c4f_4144,
    setup: [
      ...SOLO_AUTO,
      act('setTuning', { Kc: 22, Ti: 12, Td: 0 }),
      act('setSetpoint', 3.2),
    ],
    script: [
      up(28, 'DEMAND_SURGE', 0.25, 'process opening up'),
      up(75, 'DEMAND_COLLAPSE', 0.6, 'off again'),
      up(110, 'DEMAND_RAMP', 0.6, 'slow build downstream'),
      up(180, 'DEMAND_COLLAPSE', 0.5, 'back to normal'),
    ],
    par: { bronze: 2350, silver: 3450, gold: 4550 },
    parEnergy_kWh: 0.31,
    unlocks: ['derivative'],
    requires: ['THE_WINDUP'],
  },
  {
    id: 'RATE_ACTION',
    tier: 3,
    title: 'Seeing it coming',
    brief: 'Derivative is available to you now. It acts on how fast the measurement is moving, so '
      + 'on a step it fires before the error has built. Try it on these steps and be honest about '
      + 'whether it bought you anything.',
    teaches: 'Rate action anticipates. On a lag-dominant loop it helps; that is not every loop.',
    loop: LOOP.PRESSURE,
    duration_s: 215,
    band: 0.15,
    rules: rules(0.15, 'bar'),
    seed: 0x5241_5445,
    setup: [
      ...SOLO_AUTO,
      act('setTuning', { Kc: 20, Ti: 12, Td: 0, N: 10 }),
      act('setSetpoint', 3.2),
    ],
    script: [
      up(30, 'DEMAND_SURGE', 0.3, 'hard step up'),
      up(95, 'DEMAND_COLLAPSE', 0.9, 'hard step down'),
      up(150, 'SP_CHANGE', 0.15, 'supervisor lifting the header'),
      up(190, 'DEMAND_SURGE', 0.2, 'and they are back on'),
    ],
    par: { bronze: 2450, silver: 3550, gold: 4700 },
    parEnergy_kWh: 0.28,
    unlocks: [],
    requires: ['LOAD_REJECT'],
  },
  {
    id: 'NOISY_LOOP',
    tier: 3,
    title: 'A microphone on the drive',
    brief: 'We are on flow control today, 30 m3/h, and FT-101 has never been quiet. Instrument '
      + 'say the head is due for a clean and it is getting worse. Derivative is still in — listen '
      + 'to what the drives are doing before you decide to leave it there.',
    teaches: 'Derivative amplifies high frequency, and noise is nothing else. Filter it or drop it.',
    loop: LOOP.FLOW,
    duration_s: 225,
    // 2.6 m3/h on a 150 m3/h span. Tighter than the tier-3 pressure missions in the only unit
    // that compares across loops, and about seven times FT-101's nameplate noise.
    band: 2.6,
    rules: rules(2.6, 'm³/h'),
    seed: 0x4e4f_4953,
    setup: [
      act('setLoopMode', 'FLOW'),
      act('setStaging', { enabled: false }),
      act('stopPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setSetpoint', 30),
      act('setTuning', { Kc: 1.4, Ti: 6, Td: 1.2, N: 60 }),
      act('setDisturbance', { demandTarget: 0.6 }),
    ],
    script: [
      up(30, 'NOISE', 0.4, 'FT-101 getting noisy'),
      up(85, 'DEMAND_SURGE', 0.45, 'process opening up'),
      up(140, 'NOISE', 0.9, 'transmitter worse again'),
      up(180, 'DEMAND_COLLAPSE', 0.6, 'back off'),
    ],
    par: { bronze: 2550, silver: 3700, gold: 4900 },
    parEnergy_kWh: 0.12,
    unlocks: [],
    requires: ['RATE_ACTION'],
  },
  {
    id: 'THE_CYCLE',
    tier: 3,
    title: 'It is cycling and it is not you',
    brief: 'PIC-101 has started swinging on its own, and we are on the throttle valve today, not '
      + 'the drives. Your first instinct will be to detune it. Look at the shape of the wave '
      + 'first — a tuning cycle and a sticking valve do not look the same, and only one of them is '
      + 'fixed from this chair.',
    teaches: 'Not every oscillation is a tuning problem. Read the waveform before you touch Kc.',
    loop: LOOP.PRESSURE,
    duration_s: 235,
    band: 0.13,
    rules: rules(0.13, 'bar'),
    seed: 0x4359_434c,
    setup: [
      ...SOLO_AUTO,
      act('setTuning', { Kc: 22, Ti: 10, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.55, finalElement: 'THROTTLE' }),
    ],
    script: [
      up(30, 'STICTION', 0.3, 'PCV-101 stiffening up'),
      up(95, 'DEMAND_SURGE', 0.35, 'process opening up'),
      up(150, 'STICTION', 0.7, 'stem worse — it is the valve'),
      up(195, 'DEMAND_COLLAPSE', 0.7, 'back off'),
    ],
    par: { bronze: 2700, silver: 3900, gold: 5150 },
    parEnergy_kWh: 0.17,
    unlocks: ['analysis'],
    requires: ['NOISY_LOOP'],
  },
  {
    id: 'OUT_OF_ROAD',
    tier: 3,
    title: 'One machine is not enough',
    brief: 'P-102 is available but the sequence is off, so nothing will call it but you — and you '
      + 'cannot, today. Process are building to more than a single pump can hold. Hold what you '
      + 'can, keep the header off the low alarm, and note what the output does when it runs out.',
    teaches: 'Saturation is not a tuning failure. When the plant is out of capacity, tuning cannot '
      + 'buy any.',
    loop: LOOP.PRESSURE,
    duration_s: 245,
    band: 0.12,
    rules: rules(0.12, 'bar'),
    seed: 0x524f_4144,
    setup: [
      act('setStaging', { enabled: false }),
      act('stopPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setTuning', { Kc: 22, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.45 }),
    ],
    script: [
      up(30, 'DEMAND_RAMP', 0.5, 'slow build downstream'),
      up(110, 'DEMAND_COLLAPSE', 0.6, 'off — recover it'),
      up(160, 'DEMAND_SURGE', 0.6, 'and they want the lot'),
      up(205, 'DEMAND_COLLAPSE', 0.5, 'back to normal'),
    ],
    par: { bronze: 2800, silver: 4100, gold: 5400 },
    parEnergy_kWh: 0.40,
    unlocks: ['staging'],
    requires: ['THE_CYCLE'],
  },

  // === TIER 4 — MACHINERY =====================================================================
  {
    id: 'THE_SEQUENCE',
    tier: 4,
    title: 'Calling the second machine',
    brief: 'Sequence is in and P-102 is on auto. It stages up at 85% output after a ten second '
      + 'delay. Same build as yesterday, except this time something answers. Watch the header when '
      + 'the second machine arrives — two pumps on a set that one was nearly holding is a '
      + 'disturbance of its own.',
    teaches: 'The continuous loop and the discrete sequence have to agree about the same header.',
    loop: LOOP.PRESSURE,
    duration_s: 250,
    band: 0.10,
    rules: rules(0.10, 'bar'),
    seed: 0x5345_5131,
    setup: [
      act('setStaging', {
        enabled: true, criterion: 'OUTPUT', stageUp_pct: 85, stageDown_pct: 45,
        stageUpDelay_s: 10, stageDownDelay_s: 40, stageUpBias: 1, stageDownBias: 1,
      }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setTuning', { Kc: 22, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.45 }),
    ],
    script: [
      up(30, 'DEMAND_RAMP', 0.5, 'slow build downstream'),
      up(110, 'DEMAND_SURGE', 0.2, 'they want the lot'),
      up(170, 'DEMAND_COLLAPSE', 0.9, 'off again'),
      up(215, 'DEMAND_SURGE', 0.3, 'and back'),
    ],
    par: { bronze: 2850, silver: 4150, gold: 5450 },
    parEnergy_kWh: 0.69,
    unlocks: [],
    requires: ['OUT_OF_ROAD'],
  },
  {
    id: 'SHORT_CYCLE',
    tier: 4,
    title: 'Stop it hunting the starter',
    brief: 'Somebody narrowed the staging band to 70 and 62 with four second delays, and now the '
      + 'set starts and stops all shift at this load. Every start is a contactor. Sort the '
      + 'sequence out without switching it off, and without making it slow.',
    teaches: 'Hysteresis, delays and the staging bias are three different fixes for one symptom.',
    loop: LOOP.PRESSURE,
    duration_s: 255,
    band: 0.10,
    // The mission is about starter wear, so output travel is charged at half again the usual
    // rate: a tuning that holds the band by hunting the drives has not solved this shift.
    rules: rules(0.10, 'bar', { thrashPenalty: 0.075 }),
    seed: 0x4359_434b,
    setup: [
      act('setStaging', {
        enabled: true, criterion: 'OUTPUT', stageUp_pct: 70, stageDown_pct: 62,
        stageUpDelay_s: 4, stageDownDelay_s: 4, minRun_s: 5, minStop_s: 5,
        stageUpBias: 1, stageDownBias: 1,
      }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setTuning', { Kc: 22, Ti: 10, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.68 }),
    ],
    script: [
      up(30, 'DEMAND_SURGE', 0, 'right on the crossover'),
      up(95, 'DEMAND_COLLAPSE', 0, 'and back under it'),
      up(150, 'DEMAND_SURGE', 0.1, 'over again'),
      up(205, 'DEMAND_COLLAPSE', 0.2, 'settling down'),
    ],
    par: { bronze: 2850, silver: 4200, gold: 5500 },
    parEnergy_kWh: 0.66,
    unlocks: ['rotation'],
    requires: ['THE_SEQUENCE'],
  },
  {
    id: 'DEADHEAD',
    tier: 4,
    title: 'Nowhere for it to go',
    brief: 'Downstream are shutting in for a changeover — the valve goes almost fully closed and '
      + 'stays there a while, and at the end of it they slam it shut on us. The recirculation is '
      + 'on manual and barely cracked. Keep the machine off its minimum flow; everything the pump '
      + 'cannot put into the line it puts into the water in the casing.',
    teaches: 'Minimum continuous flow is a temperature limit, not a preference.',
    loop: LOOP.PRESSURE,
    duration_s: 260,
    band: 0.09,
    rules: rules(0.09, 'bar'),
    seed: 0x4445_4144,
    setup: [
      act('setStaging', { enabled: true, criterion: 'OUTPUT', stageUp_pct: 85, stageDown_pct: 45 }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setTuning', { Kc: 22, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.5, recircMode: 'MANUAL', bypass: 0.05 }),
    ],
    script: [
      up(30, 'DEMAND_COLLAPSE', 1.0, 'shutting in for the changeover'),
      up(140, 'DEMAND_SURGE', 1.0, 'changeover done — back on'),
      up(200, 'VALVE_SLAM', 0.5, 'and they have slammed it shut'),
    ],
    par: { bronze: 2900, silver: 4250, gold: 5600 },
    parEnergy_kWh: 0.18,
    unlocks: [],
    requires: ['SHORT_CYCLE'],
  },
  {
    id: 'LOSING_SUCTION',
    tier: 4,
    title: 'The tank is going down',
    brief: 'Make-up is isolated for a valve change and the tank contents came in warm. Level will '
      + 'fall through the shift and the strainer is not clean either. Watch NPSH margin, not the '
      + 'setpoint — if the pump starts cavitating, no amount of gain is going to help you.',
    teaches: 'NPSH available is a property of the suction, and the controller cannot see it.',
    loop: LOOP.PRESSURE,
    duration_s: 270,
    band: 0.085,
    rules: rules(0.085, 'bar'),
    seed: 0x4e50_5348,
    setup: [
      act('setStaging', { enabled: true, criterion: 'OUTPUT', stageUp_pct: 85, stageDown_pct: 45 }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setTuning', { Kc: 20, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.6, makeupAuto: false, T_tank_C: 62 }),
    ],
    script: [
      up(30, 'LEVEL_SWING', 0.6, 'tank running down'),
      up(90, 'FOULING', 0.45, 'strainer blinding'),
      up(150, 'LEVEL_SWING', 0.8, 'level still falling'),
      up(210, 'SUPPLY_SAG', 0.7, 'suction header sagging'),
    ],
    par: { bronze: 3000, silver: 4350, gold: 5750 },
    parEnergy_kWh: 0.52,
    unlocks: [],
    requires: ['DEADHEAD'],
  },
  {
    id: 'THE_BILL',
    tier: 4,
    title: 'Somebody is paying for this',
    brief: 'Flow control, 22 m3/h, and it has to be held there whatever else happens. Flow answers '
      + 'you almost immediately, which is a nice change. Same duty all shift, so the only variable '
      + 'left is how much electricity you spend holding it. Par is on the card. Beat it.',
    teaches: 'Throttling and speed hold the same duty at very different cost, and kWh/m3 says so. '
      + 'It also shows how much faster flow is than pressure, which is the case for a cascade.',
    loop: LOOP.FLOW,
    duration_s: 275,
    // 1.5 m3/h on a 150 m3/h span — one percent, the tightest band in tier 4 in comparable units.
    band: 1.5,
    // Energy is the whole point, so wear is charged the way it would be on a real machine: travel
    // costs, and a loop that hunts to hold the band pays for it twice.
    rules: rules(1.5, 'm³/h', { thrashPenalty: 0.08 }),
    seed: 0x4b57_4831,
    setup: [
      act('setLoopMode', 'FLOW'),
      act('setStaging', { enabled: false }),
      act('stopPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setSetpoint', 22),
      act('setTuning', { Kc: 1.4, Ti: 6, Td: 0 }),
      act('setDisturbance', { demandTarget: 0.55 }),
    ],
    script: [
      up(35, 'DEMAND_RAMP', 0.5, 'downstream opening — hold the flow'),
      up(110, 'DEMAND_COLLAPSE', 0.7, 'and closing in'),
      up(175, 'DEMAND_SURGE', 0.4, 'opening again'),
      up(240, 'BACKPRESSURE', 0.6, 'receiving vessel filling up'),
    ],
    par: { bronze: 3050, silver: 4500, gold: 5900 },
    parEnergy_kWh: 0.12,
    unlocks: ['cascade'],
    requires: ['LOSING_SUCTION'],
  },

  // === TIER 5 — STRATEGY ======================================================================
  {
    id: 'INNER_LOOP',
    tier: 5,
    title: 'A loop inside the loop',
    brief: 'Pressure control, and the load is going to move faster than the header can tell you '
      + 'about it. Cascade is available: put FIC-101 underneath PIC-101, tune the slave first and '
      + 'make it several times faster than the master, then close the master onto it.',
    teaches: 'Cascade catches the disturbance in the fast variable before the slow one moves.',
    loop: LOOP.PRESSURE,
    duration_s: 280,
    band: 0.07,
    rules: rules(0.07, 'bar'),
    seed: 0x4341_5343,
    setup: [
      act('setStaging', { enabled: true, criterion: 'OUTPUT', stageUp_pct: 85, stageDown_pct: 45 }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setStrategy', { structure: 'SINGLE' }),
      act('setTuning', { Kc: 22, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.55 }),
    ],
    script: [
      up(30, 'DEMAND_SURGE', 0.5, 'hard step up'),
      up(95, 'DEMAND_COLLAPSE', 0.8, 'hard step down'),
      up(155, 'DEMAND_SURGE', 0.6, 'and up again'),
      up(220, 'DEMAND_COLLAPSE', 0.5, 'settling'),
    ],
    par: { bronze: 3100, silver: 4500, gold: 5950 },
    parEnergy_kWh: 0.57,
    unlocks: ['feedforward'],
    requires: ['THE_BILL'],
  },
  {
    id: 'AHEAD_OF_IT',
    tier: 5,
    title: 'Correct before it hurts',
    brief: 'Feedback waits for the error. Feedforward reads FCV-101 directly and corrects for the '
      + 'load before the header has moved at all. It is switched off — turn it on, get the lead-lag '
      + 'right, and leave the gain short of one. A model that is slightly wrong at full gain is '
      + 'worse than no model.',
    teaches: 'Feedforward is open loop. It has no stability of its own and always runs with '
      + 'feedback underneath it.',
    loop: LOOP.PRESSURE,
    duration_s: 285,
    band: 0.065,
    rules: rules(0.065, 'bar'),
    seed: 0x4646_5744,
    setup: [
      act('setStaging', { enabled: true, criterion: 'OUTPUT', stageUp_pct: 85, stageDown_pct: 45 }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setStrategy', { structure: 'SINGLE', ff: { enabled: false, gain: 0.85, lag_s: 2 } }),
      act('setTuning', { Kc: 22, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.5 }),
    ],
    script: [
      up(28, 'DEMAND_SURGE', 0.7, 'big step up'),
      up(90, 'DEMAND_COLLAPSE', 1.0, 'big step down'),
      up(150, 'DEMAND_SURGE', 0.6, 'up'),
      up(205, 'DEMAND_COLLAPSE', 0.6, 'down'),
      up(250, 'DEMAND_SURGE', 0.3, 'and level out'),
    ],
    par: { bronze: 3150, silver: 4600, gold: 6050 },
    parEnergy_kWh: 0.53,
    unlocks: ['gainSchedule'],
    requires: ['INNER_LOOP'],
  },
  {
    id: 'MOVING_TARGET',
    tier: 5,
    title: 'One tuning is not enough',
    brief: 'We are going to run this from nearly shut to nearly wide open in one shift. The '
      + 'process gain down at a trickle and the process gain with both machines flat out are not '
      + 'the same number, so one set of constants is going to be wrong at one end. Schedule them.',
    teaches: 'Process gain varies along the curve. Gain scheduling admits it instead of averaging '
      + 'it.',
    loop: LOOP.PRESSURE,
    duration_s: 290,
    band: 0.06,
    rules: rules(0.06, 'bar'),
    seed: 0x5343_4844,
    setup: [
      act('setStaging', { enabled: true, criterion: 'OUTPUT', stageUp_pct: 85, stageDown_pct: 45 }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setStrategy', { structure: 'SINGLE', sched: { enabled: false, on: 'FLOW' } }),
      act('setTuning', { Kc: 20, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.45 }),
    ],
    script: [
      up(28, 'DEMAND_COLLAPSE', 0.9, 'right down to a trickle'),
      up(85, 'DEMAND_RAMP', 0.9, 'building'),
      up(140, 'DEMAND_SURGE', 0.9, 'wide open'),
      up(200, 'DEMAND_COLLAPSE', 1.0, 'and straight back down'),
      up(250, 'DEMAND_SURGE', 0.3, 'normal duty'),
    ],
    par: { bronze: 3200, silver: 4650, gold: 6150 },
    parEnergy_kWh: 0.49,
    unlocks: ['autotune'],
    requires: ['AHEAD_OF_IT'],
  },
  {
    id: 'FULL_SHIFT',
    tier: 5,
    title: 'A full shift',
    brief: 'Everything you have, on a rig that will not be the same at the end as it was at the '
      + 'start. Load moves, the fill is wrong, the strainer blinds, the scan gets slower and at '
      + 'some point you are going to lose a machine. Five hundredths of a bar. Good luck.',
    teaches: 'The whole job at once: structure, tuning, protection and the machinery, under load.',
    loop: LOOP.PRESSURE,
    duration_s: 300,
    band: 0.05,
    rules: rules(0.05, 'bar'),
    seed: 0x4558_414d,
    setup: [
      act('setStaging', { enabled: true, criterion: 'OUTPUT', stageUp_pct: 85, stageDown_pct: 45 }),
      act('autoPump', 1),
      act('setControllerMode', 'AUTO'),
      act('setStrategy', { structure: 'SINGLE' }),
      act('setTuning', { Kc: 22, Ti: 11, Td: 0 }),
      act('setSetpoint', 3.2),
      act('setDisturbance', { demandTarget: 0.5 }),
    ],
    script: [
      up(25, 'DEMAND_SURGE', 0.3, 'process opening up'),
      // Deliberately below the VG 150 threshold. Two machines on gear oil at this duty draw more
      // than both motors are rated for and trip the pair, which fails the shift on the plant's
      // account rather than the player's — the exam is meant to be survivable.
      up(70, 'FLUID_CHANGE', 0.4, 'wrong fill coming through'),
      up(115, 'FOULING', 0.35, 'strainer blinding'),
      up(155, 'SCAN_SLOW', 0.35, 'DCS loading — scan slowing'),
      up(195, 'SP_CHANGE', -0.4, 'supervisor dropping the header'),
      up(235, 'PUMP_TRIP', 0, 'a machine has tripped'),
      up(275, 'DEMAND_COLLAPSE', 0.5, 'and they are off'),
    ],
    par: { bronze: 3300, silver: 4800, gold: 6350 },
    parEnergy_kWh: 0.75,
    unlocks: [],
    requires: ['MOVING_TARGET'],
  },
]);

/** Mission lookup, built once. */
const BY_ID = new Map(MISSIONS.map((m) => [m.id, m]));

/**
 * Find a mission by id.
 * @param {string} id the mission id
 * @returns {object|null} the mission, or null if there is no such id
 */
export function missionById(id) {
  if (typeof id !== 'string') return null;
  return BY_ID.get(id) || null;
}

/**
 * Every mission in a tier, in play order.
 * @param {number|string} tier the tier number 1..5, or its {@link TIERS} id
 * @returns {object[]} the missions, empty if the tier does not exist
 */
export function missionsForTier(tier) {
  const t = typeof tier === 'string' ? TIERS.find((x) => x.id === tier) : null;
  const n = t ? t.n : tier;
  if (!Number.isFinite(n)) return [];
  return MISSIONS.filter((m) => m.tier === n);
}

/**
 * The tolerance band as a fraction of the transmitter span for the mission's loop.
 *
 * This is the only band number that means the same thing on PIC-101 and FIC-101, so it is the one
 * the difficulty curve is defined in and the one the tests check. A player never sees it.
 *
 * @param {object} mission a mission record
 * @returns {number} the fraction, or NaN if the mission or its loop is not recognised
 */
export function bandFraction(mission) {
  if (!mission || !LOOP_EU[mission.loop]) return NaN;
  const eu = LOOP_EU[mission.loop];
  const span = eu.hi - eu.lo;
  if (!(span > 0) || !(mission.band > 0)) return NaN;
  return mission.band / span;
}

/**
 * Whether a profile has cleared a mission.
 *
 * Written defensively because the profile is persisted, versioned and edited by an importer: a
 * record that arrives as a bare number, or a map that arrives as an array, must not throw here and
 * strand the player on the first mission with no way back.
 *
 * @param {object|null} profile the player profile, or null for a fresh player
 * @param {string} id the mission id
 * @returns {boolean} true if the mission has been completed at least once
 */
export function missionCleared(profile, id) {
  if (!profile || typeof id !== 'string') return false;
  try {
    const store = profile.missions;
    if (!store || typeof store !== 'object') return false;
    const rec = Array.isArray(store) ? store.find((x) => x && x.id === id) : store[id];
    if (!rec) return false;
    if (typeof rec === 'number') return rec > 0;
    if (typeof rec !== 'object') return false;
    if (rec.cleared === true) return true;
    if (Number.isFinite(rec.clears) && rec.clears > 0) return true;
    if (typeof rec.medal === 'string' && rec.medal !== 'none') return true;
    return Number.isFinite(rec.best) && rec.best > 0;
  } catch {
    // A profile can arrive from `importProfile`, which is fed a paste box. Anything at all can be
    // in there, including an accessor that throws. Refusing to read it costs the player their
    // progress on one mission; letting it escape costs them the whole mission list.
    return false;
  }
}

/**
 * The missions a player may start: everything whose prerequisites are all cleared.
 *
 * Already-cleared missions stay in the list, because replaying one for a better medal is the
 * point of having medals at all.
 *
 * @param {object|null} profile the player profile, or null for a fresh player
 * @returns {object[]} the available missions, in play order
 */
export function availableMissions(profile) {
  return MISSIONS.filter((m) => m.requires.every((r) => missionCleared(profile, r)));
}

/**
 * The next mission the player has not cleared.
 * @param {object|null} profile the player profile, or null for a fresh player
 * @returns {object|null} the mission, or null once the campaign is finished
 */
export function nextMission(profile) {
  return availableMissions(profile).find((m) => !missionCleared(profile, m.id)) || null;
}

/**
 * The demand-valve travel a mission starts from, read out of its own setup.
 * @param {object} m a mission record
 * @returns {number} the travel, 0..1, defaulting to the rig's boot position
 */
function startingDemand(m) {
  let d = 0.45;
  for (const s of m.setup || []) {
    if (s.action === 'setDisturbance' && s.args && s.args[0]
      && Number.isFinite(s.args[0].demandTarget)) d = s.args[0].demandTarget;
  }
  return d;
}

/**
 * Whether the mission lets the sequence call the second machine.
 * @param {object} m a mission record
 * @returns {boolean} true when two pumps can end up on the header
 */
function twoPumpsAvailable(m) {
  let on = false;
  for (const s of m.setup || []) {
    if (s.action === 'setStaging' && s.args && s.args[0]) on = s.args[0].enabled === true;
    if (s.action === 'stopPump') on = false;
  }
  return on;
}

/**
 * Apply one scripted upset to a demand-valve travel, using the director's arithmetic.
 *
 * Duplicated from `director.js` on purpose: this is a check on the mission table, and a check
 * that imported the thing it is checking would pass by construction if the director's ranges
 * changed underneath it. The numbers are the ones written into `UPSET_MAG` above, so a drift
 * between the two modules shows up here as a mission that suddenly reads as unplayable.
 *
 * @param {number} d travel before the upset, 0..1
 * @param {{upset:string, mag:number}} e the script entry
 * @returns {number} travel after it, 0..1
 */
function walkDemand(d, e) {
  const m = Number.isFinite(e.mag) ? Math.min(1, Math.abs(e.mag)) : 0.5;
  let next = d;
  if (e.upset === 'DEMAND_SURGE') next = d + 0.10 + 0.32 * m;
  else if (e.upset === 'DEMAND_COLLAPSE') next = d - (0.12 + 0.30 * m);
  else if (e.upset === 'DEMAND_RAMP') next = d + 0.14 + 0.30 * m;
  else if (e.upset === 'VALVE_SLAM') next = d * (1 - (0.55 + 0.40 * m));
  return Math.min(1, Math.max(0, next));
}

/**
 * Check the campaign table against everything it depends on, and against itself.
 *
 * This is a build-time assertion that happens to be written in JavaScript. A mission table is
 * pure data assembled by hand, which means the failures are all of the same species — a
 * mistyped unlock id, a `requires` pointing at a mission that was renamed, a script event
 * scheduled after the shift ends, a bronze threshold above the gold one — and every one of them
 * is invisible until a player hits it. So the table is checked in full, and the test suite calls
 * this and demands an empty list.
 *
 * Pass `refs` to check against the real tables from the other game modules once they are wired
 * up; with no argument the table is checked against the id lists declared at the top of this
 * file, which is still a closed check because those lists are maintained separately from the
 * mission rows.
 *
 * @param {object} [refs] cross-module tables to validate against
 * @param {object} [refs.unlocks] `UNLOCKS` from profile.js, id -> record
 * @param {object} [refs.upsets] `UPSETS` from director.js, id -> record
 * @param {string[]} [refs.actions] the sim action names that actually exist
 * @returns {string[]} one sentence per problem; empty when the campaign is sound
 */
export function validateMissions(refs) {
  const problems = [];
  const r = refs && typeof refs === 'object' ? refs : {};
  const knownUnlock = r.unlocks ? (id) => Object.prototype.hasOwnProperty.call(r.unlocks, id)
    : (id) => UNLOCK_IDS.includes(id);
  const knownUpset = r.upsets ? (id) => Object.prototype.hasOwnProperty.call(r.upsets, id)
    : (id) => UPSET_IDS.includes(id);
  const knownAction = Array.isArray(r.actions) ? (a) => r.actions.includes(a)
    : (a) => SETUP_ACTIONS.includes(a);

  const seen = new Set();
  const granted = new Set();
  const usedUpsets = new Set();
  let prevFrac = Infinity;
  let prevGold = -Infinity;
  let prevTier = 0;

  for (let i = 0; i < MISSIONS.length; i += 1) {
    const m = MISSIONS[i];
    const at = `mission ${m.id || `#${i}`}`;

    if (!m.id || typeof m.id !== 'string') problems.push(`${at} has no id`);
    else if (seen.has(m.id)) problems.push(`${at} is a duplicate id`);
    seen.add(m.id);

    if (!TIERS.some((t) => t.n === m.tier)) problems.push(`${at} is in tier ${m.tier}, which does not exist`);
    if (m.tier < prevTier) problems.push(`${at} is in tier ${m.tier} after tier ${prevTier} — the table order is the play order`);
    prevTier = m.tier;

    if (!m.title) problems.push(`${at} has no title`);
    if (!m.brief || m.brief.length < 40) problems.push(`${at} has no usable brief`);
    if (!m.teaches) problems.push(`${at} does not say what it teaches`);
    if (!LOOP[m.loop]) problems.push(`${at} names loop mode ${m.loop}, which does not exist`);
    if (!Number.isInteger(m.seed) || m.seed < 0) problems.push(`${at} has no usable seed`);

    // A shift shorter than 90 s cannot reach the top multiplier and a shift longer than 300 s
    // stops being a decision and starts being a wait.
    if (!(m.duration_s >= 90 && m.duration_s <= 300)) {
      problems.push(`${at} runs for ${m.duration_s} s, outside the 90..300 s a shift is allowed to be`);
    }

    const frac = bandFraction(m);
    if (!Number.isFinite(frac)) problems.push(`${at} has no usable band`);
    else if (frac > prevFrac + 1e-12) {
      problems.push(`${at} widens the band to ${(frac * 100).toFixed(3)}% of span after `
        + `${(prevFrac * 100).toFixed(3)}% — the campaign must not get easier`);
    } else prevFrac = frac;

    if (!m.rules || m.rules.band !== m.band) {
      problems.push(`${at} has rules whose band disagrees with the mission band`);
    } else if (!(m.rules.inBandRate > 0) || !(m.rules.maxMult >= 1) || !m.rules.bandEU) {
      problems.push(`${at} has an incomplete rule block`);
    }

    const p = m.par || {};
    if (!(p.bronze > 0 && p.silver > p.bronze && p.gold > p.silver)) {
      problems.push(`${at} has medal thresholds that do not ascend`);
    } else if (p.gold < prevGold - 1e-9) {
      problems.push(`${at} asks ${p.gold} for gold after a mission that asked ${prevGold} — the `
        + 'campaign must not get cheaper');
    } else prevGold = p.gold;

    // Par energy is checked as an implied mean load rather than as a number, because that is the
    // form a wrong one is obvious in: this rig cannot draw less than about 1 kW with a machine
    // turning, and two motors flat out are 30 kW.
    const kW = (m.parEnergy_kWh * 3600) / (m.duration_s || 1);
    if (!(kW >= 1 && kW <= 30)) {
      problems.push(`${at} pars ${m.parEnergy_kWh} kWh over ${m.duration_s} s, which implies `
        + `${kW.toFixed(1)} kW — outside anything this rig draws`);
    }

    for (const s of m.setup || []) {
      if (!s || !knownAction(s.action)) problems.push(`${at} setup calls ${s && s.action}, which is not an allowed action`);
      else if (!Array.isArray(s.args)) problems.push(`${at} setup step ${s.action} has no argument list`);
    }
    if (!Array.isArray(m.setup) || m.setup.length === 0) problems.push(`${at} has no setup`);

    let prevAt = -Infinity;
    // The demand valve is walked through the script with the director's own arithmetic, because
    // the demand upsets are relative and nothing reverts until the shift ends. A script that
    // reads reasonably event by event can still stack its way to a travel that trips both motors,
    // and that is a failed shift the player did nothing to earn.
    //
    // Only on a pressure loop. There, the demand valve IS the load: open it and the machines have
    // to make the flow. On a flow loop the controller holds the flow the setpoint asks for and
    // opening the valve lets it slow the pumps DOWN, so a wide-open valve is the cheap end of the
    // shift rather than the expensive one, and a ceiling there would refuse a legitimate mission.
    const ceiling = m.loop !== LOOP.PRESSURE ? Infinity
      : (twoPumpsAvailable(m) ? DEMAND_CEILING.twoPumps : DEMAND_CEILING.onePump);
    let demand = startingDemand(m);
    if (!Array.isArray(m.script) || m.script.length === 0) problems.push(`${at} has no scripted upsets`);
    for (const e of m.script || []) {
      if (!knownUpset(e.upset)) { problems.push(`${at} scripts upset ${e.upset}, which does not exist`); continue; }
      usedUpsets.add(e.upset);
      // `mag` is a severity, not an engineering value — see {@link UPSET_MAG}. Anything outside
      // -1..1 has been written in the wrong units and will silently clamp to full severity.
      if (!Number.isFinite(e.mag) || Math.abs(e.mag) > 1) {
        problems.push(`${at} scripts ${e.upset} with mag ${e.mag} — severities run -1..1, and `
          + 'anything else is an engineering value written in the wrong place');
      }
      if (!e.label) problems.push(`${at} scripts ${e.upset} with nothing for the ticker to say`);
      demand = walkDemand(demand, e);
      if (demand > ceiling + 1e-9) {
        problems.push(`${at} walks the demand valve to ${(demand * 100).toFixed(0)}% by ${e.at_s} s, `
          + `past the ${(ceiling * 100).toFixed(0)}% this rig can hold without tripping a motor`);
      }
      // Twelve seconds is longer than the longest telegraph, so every upset can be announced
      // before it lands; twenty at the end leaves time to recover inside the scored window,
      // without which the last upset is a penalty rather than a test.
      if (!(e.at_s >= 12)) problems.push(`${at} fires ${e.upset} at ${e.at_s} s, too early to telegraph`);
      if (!(e.at_s <= m.duration_s - 20)) {
        problems.push(`${at} fires ${e.upset} at ${e.at_s} s of a ${m.duration_s} s shift, with no time to recover`);
      }
      if (e.at_s <= prevAt) problems.push(`${at} scripts ${e.upset} out of order at ${e.at_s} s`);
      prevAt = e.at_s;
    }

    for (const u of m.unlocks || []) {
      if (!knownUnlock(u)) problems.push(`${at} unlocks ${u}, which is not a known feature`);
      else if (granted.has(u)) problems.push(`${at} unlocks ${u}, which an earlier mission already granted`);
      granted.add(u);
    }
    for (const req of m.requires || []) {
      if (!seen.has(req)) {
        problems.push(`${at} requires ${req}, which is not a mission that comes before it`);
      }
    }
  }

  for (const u of UNLOCK_IDS) {
    if (!granted.has(u)) problems.push(`${u} is declared but no mission ever unlocks it`);
  }
  for (const u of UPSET_IDS) {
    if (!usedUpsets.has(u)) problems.push(`${u} is declared but the campaign never scripts it`);
  }
  if (!MISSIONS.some((m) => (m.requires || []).length === 0)) {
    problems.push('no mission can be started first — every one has a prerequisite');
  }
  return problems;
}
