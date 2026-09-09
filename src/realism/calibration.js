/**
 * src/realism/calibration.js — what the transmitters actually read, as opposed to what is true,
 * and the procedure by which somebody finds out.
 *
 * Layer: `src/realism`. Imports `core/util.js`, `control/pid.js`, `process/motor.js` and the
 * seeded generator in `game/rng.js`. No DOM, no `window`, no `document`, no `performance`, no
 * `Date.now()`, no `Math.random()`. Every function here is tested in Node.
 *
 * ------------------------------------------------------------------------------------------
 * THE ONE LESSON THIS MODULE EXISTS FOR
 *
 * A loop sitting dead on setpoint while the real pressure is 0.4 bar away.
 *
 * That is the failure this file is built around, and it is the one that kills the intuition every
 * student arrives with — that a flat trend means a controlled process. It does not. It means the
 * controller has driven the INDICATION to setpoint, and the indication is the output of a physical
 * device with a zero, a span, a hysteresis loop and a drift rate. The controller has never once
 * seen the process.
 *
 * So this module keeps two numbers for every instrument on the rig and hands out exactly one of
 * them to the loop. `ch.trueValue` is what the plant is doing. `ch.value` is what the transmitter
 * says. `applyCalibration` writes `ch.value` — and only `ch.value` — into the plant fields the
 * controller reads, and both stay visible to anything that asks. A UI that plots the two together
 * teaches the lesson in one screen; a UI that plots only one of them is showing a trend that
 * cannot be interpreted.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THE ERROR COMPONENTS ARE KEPT SEPARATE
 *
 * An engineer handed a five-point as-found sheet is expected to say "that is a zero shift, not a
 * span error" and be right, because the two are fixed by different adjustments and caused by
 * different things — a zero shift is a wet leg that has lost its fill or a sensor that has crept,
 * a span error is a sensor whose gain has changed. If the model added one lump of error, the sheet
 * would carry no information and the skill could not be practised. So the error is carried as
 * separate, independently visible terms:
 *
 *   ZERO         constant across the range. Adjustable.
 *   SPAN         proportional to the reading. Adjustable.
 *   LINEARITY    a bow in the middle, zero at both ends. NOT adjustable on a two-point trim, which
 *                is exactly why it survives a calibration and shows up on the as-left sheet.
 *   HYSTERESIS   the gap between the rising and the falling traverse. Also not adjustable, and the
 *                whole reason the procedure runs five points UP and five points DOWN rather than
 *                five points once.
 *   REPEATABILITY scatter between readings at the same point. Sets the floor on what any
 *                calibration can resolve, and appears in the uncertainty statement.
 *   DRIFT        zero and span moving with elapsed time, faster when the instrument is hot.
 *   TEMPERATURE  a reversible zero shift with the transmitter's own ambient — which for a
 *                pump-mounted transmitter is not the site ambient at all.
 *   FAULTS       stuck, spiking, saturated, and open-circuit downscale per NAMUR NE 43.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THE PROCEDURE REFUSES
 *
 * `beginCalibration` will not start on a loop that is in service, and that refusal is not
 * housekeeping — it is the single most consequential interlock in the whole layer. Putting a hand
 * valve across a transmitter that is controlling a running plant drives the controller to a limit
 * on a measurement that is no longer connected to anything, and people have been hurt by exactly
 * that. The rig therefore asks for the loop in manual and the manifold isolated, in writing, before
 * it will take an as-found point.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A CALIBRATION CANNOT COME OUT PERFECT
 *
 * The reference standard has its own error. The technician cannot see it, subtracts it into his
 * adjustment along with everything else, and hands over a certificate whose as-left column reads
 * 0.00 at the ends. The instrument is then wrong by the standard's offset and the paperwork is the
 * only thing that says so — which is what the uncertainty statement on the certificate is FOR, and
 * why `finishCalibration` computes one instead of printing a row of zeros and calling it done.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, lag, headToBar, G } from '../core/util.js';
import { MODE } from '../control/pid.js';
import { DRIVE } from '../process/motor.js';
import { makeRng, rngRange, rngNormal } from '../game/rng.js';
import { FEATURE, isOn, rateOf, agedHours } from './config.js';

// ---------------------------------------------------------------------------------------------
// Constants, every one of them with the place it came from
// ---------------------------------------------------------------------------------------------

/**
 * The reference temperature every published instrument specification is quoted at, C.
 * 20 C is the ISO 554 / IEC standard reference atmosphere and is what a datasheet means by
 * "at reference conditions".
 */
export const REF_TEMP_C = 20;

/**
 * NAMUR NE 43 signal limits, as a fraction of the calibrated span.
 *
 * NE 43 is the recommendation that made a 4-20 mA transmitter self-diagnosing: the measuring range
 * is restricted to 3.8..20.5 mA so that anything outside it is unambiguously a fault, and a
 * detected failure is signalled by driving the loop DOWNSCALE below 3.6 mA or UPSCALE above 21 mA.
 * A broken wire also reads 0 mA, which is why downscale is the classic open-circuit symptom and
 * why a downscale reading on a reverse-acting loop is dangerous: the controller sees no pressure
 * and calls for everything the plant has got.
 */
export const NAMUR = Object.freeze({
  /** 3.8 mA — the bottom of the usable measuring range. */
  LOW_FRAC: -0.0125,
  /** 20.5 mA — the top of it. */
  HIGH_FRAC: 1.03125,
  /** 3.6 mA — a signalled downscale failure, and where an open circuit lands. */
  FAULT_LOW_FRAC: -0.025,
  /** 21.0 mA — a signalled upscale failure. */
  FAULT_HIGH_FRAC: 1.0625,
});

/** How an instrument can be broken, as opposed to merely inaccurate. */
export const FAULT = Object.freeze({
  /** Working, to whatever accuracy it has left. */
  NONE: 'NONE',
  /** Frozen at the last value it read. An impulse line full of hydrate, or a dead comms card. */
  STUCK: 'STUCK',
  /** Occasional large excursions. A loose terminal, a wet junction box, an earthing problem. */
  SPIKING: 'SPIKING',
  /** Pinned at the top of the range. A blocked wet leg, or a sensor that has been overpressured. */
  SAT_HIGH: 'SAT_HIGH',
  /** Pinned at the bottom. A drained wet leg, or a shut isolation valve nobody reopened. */
  SAT_LOW: 'SAT_LOW',
  /** Open circuit: NE 43 downscale. The one every loop must be able to survive. */
  DOWNSCALE: 'DOWNSCALE',
});

/**
 * The five points a calibration is taken at, as a percentage of span.
 *
 * Five up and five down is the ordinary industrial procedure and the smallest set that can
 * separate the four static error terms: the 0% point isolates zero, the 100% point isolates span
 * once zero is known, the three interior points expose a bow, and the difference between the
 * traverses IS the hysteresis. Three points cannot see linearity; ten add nothing a technician
 * would act on.
 */
export const CAL_POINTS = Object.freeze([0, 25, 50, 75, 100]);

/**
 * The reference standards available to the technician.
 *
 * `accuracy_pct` is the standard's own error as a percentage of the instrument's span, and
 * `uncertainty_pct` is what it contributes to the certificate at k=2. The ratio between the
 * standard and the instrument is the test accuracy ratio; ANSI/NCSL Z540 and ordinary calibration
 * practice want 4:1 or better, and {@link beginCalibration} says so when it is not met rather
 * than refusing — plenty of real work is done at 2:1 with a note on the certificate.
 */
export const REFERENCES = Object.freeze({
  /** A deadweight tester. The primary standard for pressure; slow, heavy, and almost right. */
  DEADWEIGHT: Object.freeze({
    id: 'DEADWEIGHT', name: 'Deadweight tester', accuracy_pct: 0.02, uncertainty_pct: 0.02,
    note: 'Primary pressure standard, class 0.02% of reading (EURAMET cg-3).',
  }),
  /** A documenting process calibrator. What most instrument technicians actually carry. */
  CALIBRATOR: Object.freeze({
    id: 'CALIBRATOR', name: 'Documenting process calibrator', accuracy_pct: 0.05,
    uncertainty_pct: 0.05,
    note: 'Portable multifunction calibrator, 0.05% of span, certified annually.',
  }),
  /** A test gauge off the shelf in the workshop. Coarse, and honest about it. */
  FIELD_GAUGE: Object.freeze({
    id: 'FIELD_GAUGE', name: 'Field test gauge', accuracy_pct: 0.5, uncertainty_pct: 0.5,
    note: 'EN 837-1 industrial test gauge, accuracy class 0.5. Fine for a bump test and no use '
      + 'at all for proving a 0.1% transmitter.',
  }),
});

/** The test accuracy ratio calibration practice asks for: the standard four times better. */
export const TAR_TARGET = 4;

/**
 * How much faster an instrument drifts when it is hot.
 *
 * The reliability rule of thumb from the Arrhenius relation is that a rate doubles for every 10 K,
 * and it is quoted everywhere for electronics life. It is applied here at HALF that sensitivity —
 * a doubling per 20 K — for two reasons: a transmitter's drift is part mechanical (sensor creep,
 * fill fluid, weld stress) and not purely a thermally activated chemical rate, and the electronics
 * inside a field housing do not sit at ambient anyway. Two-per-20 K puts a transmitter bolted to a
 * pump running at minimum flow at roughly three times its datasheet drift, which is the order of
 * difference a maintenance history actually shows between a hot service and a cool one.
 */
const DRIFT_DOUBLING_K = 20;

/**
 * The fraction of a hot casing's temperature rise that reaches a transmitter bolted to it.
 *
 * A pump-mounted transmitter is in the casing's thermal shadow — conducted up the impulse line and
 * radiated off the volute — and a thermal survey of one typically shows it sitting about halfway
 * between ambient and the casing. This is the number that turns "the operator ran it at minimum
 * flow for a week" into "and now its suction transmitter has drifted", which is the sort of chain
 * this layer is for.
 */
const CASING_SHADOW = 0.5;

/**
 * Failure rate of a field transmitter, failures per hour.
 *
 * exida and OREDA both put a modern smart pressure transmitter in the region of 300-400 FIT
 * (failures per 10^9 hours) for all failure modes together. 350 FIT is 3.5e-7/h, about one failure
 * per 325 years — which at the layer's default 720x time compression is one every 4000 hours of
 * play, i.e. it will essentially never happen unless the user turns the failure rate up. That is
 * the correct answer: transmitters are extremely reliable and a simulator that breaks one every
 * afternoon teaches the wrong reflex.
 */
const TRANSMITTER_FIT = 350e-9;

/** How the failure rate splits between the modes, from the usual field-failure breakdowns. */
const FAULT_WEIGHTS = Object.freeze([
  Object.freeze({ mode: FAULT.DOWNSCALE, w: 0.35 }),
  Object.freeze({ mode: FAULT.STUCK, w: 0.25 }),
  Object.freeze({ mode: FAULT.SAT_LOW, w: 0.15 }),
  Object.freeze({ mode: FAULT.SAT_HIGH, w: 0.13 }),
  Object.freeze({ mode: FAULT.SPIKING, w: 0.12 }),
]);

/** How far a spiking transmitter jumps, as a fraction of span, and how often it does it. */
const SPIKE_FRAC = 0.35;
/** Probability per reading that a spiking transmitter spikes. A loose terminal is intermittent. */
const SPIKE_P = 0.08;

// ---------------------------------------------------------------------------------------------
// Readers — where each instrument's TRUE value comes from
//
// These take the sim context and return the physical quantity in the instrument's engineering
// units. They are deliberately the only place in this file that knows the shape of the plant
// state, so a change in `process/plant.js` lands here and nowhere else.
// ---------------------------------------------------------------------------------------------

/**
 * The gauge head at a pump's suction flange, m, recovered from the NPSH the plant already solves.
 *
 * NPSHa = (p_atm + p_tank - p_vap)/(rho g) + z - h_friction, and everything in that expression
 * except (z - h_friction) is known here — so the suction gauge head falls out by subtraction
 * rather than by re-deriving a friction loss the plant has already computed. Two independent
 * copies of the same head loss is exactly how a simulator ends up with a strainer differential
 * that disagrees with itself.
 *
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {number} gauge head at the suction flange, m of liquid
 */
function suctionHead_m(ctx, i) {
  const p = ctx.plant;
  const rho = p.fluid.rho_kgm3;
  const absTerm = (p.pAtm_bar + ctx.config.tank.pTank_bar - p.fluid.pVap_bar) * 1e5;
  return p.npsha_m[i] - absTerm / (rho * G);
}

/**
 * Gauge pressure at a pump's suction flange, bar.
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {number} bar gauge
 */
function suctionPressure_bar(ctx, i) {
  return headToBar(suctionHead_m(ctx, i), ctx.plant.fluid.rho_kgm3);
}

/**
 * Gauge pressure at a pump's discharge flange, bar — suction plus what the machine developed.
 * @param {object} ctx the sim context
 * @param {number} i pump index
 * @returns {number} bar gauge
 */
function dischargePressure_bar(ctx, i) {
  return headToBar(suctionHead_m(ctx, i) + ctx.plant.Hp_m[i], ctx.plant.fluid.rho_kgm3);
}

// ---------------------------------------------------------------------------------------------
// THE INSTRUMENT LIST
//
// Every transmitter on the rig, with the range it was configured to, the accuracy class it was
// bought to, the drift its datasheet admits to, and the interval the maintenance system has it on.
//
// ACCURACY AND DRIFT FIGURES. Pressure and level: a mid-range smart transmitter publishes a
// reference accuracy near 0.075% of span and a long-term stability near 0.1% of the upper range
// limit per year, and the ambient temperature effect is of the order of 0.1% of span per 10 K —
// those are the three numbers on the front page of every such datasheet and they are what is used
// here. Flow: a magnetic flowmeter is quoted at 0.25% OF RATE, not of span, which is a better
// instrument than the number below suggests at full flow and a worse one at 10% — see the note on
// `spanReferenced`. Temperature: a class A Pt100 to IEC 60751 is +/-(0.15 + 0.002|T|) K, about
// 0.2% of a 0-100 C span at the top. Motor current: this is not a calibrated instrument at all,
// it is the drive's own current estimate, and +/-3% is a normal published figure — which is
// exactly why nobody should be trending a bearing on it.
//
// `field` names the plant field the reading is written back into, for the handful of instruments
// the controller and the alarms actually read. Everything else is indication only and lives in
// the calibration state, where the UI can find it.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Instrument
 * @property {string} id tag number
 * @property {string} name what it measures
 * @property {string} unit engineering unit
 * @property {number} lo bottom of the calibrated range
 * @property {number} hi top of the calibrated range
 * @property {number} accuracy_pct reference accuracy, % of span
 * @property {number} drift_pctPerYear published long-term stability, % of span per year
 * @property {number} tempCoef_pctPer10K ambient temperature effect, % of span per 10 K
 * @property {number} tolerance_pct the as-left tolerance the loop sheet asks for, % of span
 * @property {number} interval_h calibration interval, equipment hours
 * @property {string|null} field plant field the indication is written to, or null
 * @property {string|null} filterKey `config.instruments` key whose filter the plant applies
 * @property {string|null} loop which controller loop this is the PV of, or null
 * @property {number|null} pump which machine it belongs to, or null
 * @property {string|null} valve which valve it reads back, or null
 * @property {boolean} spanReferenced false when the datasheet figure is a percentage of reading
 * @property {(ctx:object)=>number} read the true value, in this instrument's units
 */

/** Every transmitter on the rig. @type {ReadonlyArray<Instrument>} */
export const INSTRUMENTS = Object.freeze([
  Object.freeze({
    id: 'PT-101',
    name: 'Header pressure',
    unit: 'bar',
    lo: 0,
    hi: 8,
    accuracy_pct: 0.075,
    drift_pctPerYear: 0.10,
    tempCoef_pctPer10K: 0.08,
    tolerance_pct: 0.5,
    // Six months, not twelve. It is the PV of the controlling loop and the input to the high-high
    // trip, and a maintenance system will always shorten the interval on an instrument that does
    // both.
    interval_h: 4380,
    field: 'pt_bar',
    filterKey: 'pt',
    loop: 'PRESSURE',
    pump: null,
    valve: null,
    spanReferenced: true,
    read: (ctx) => ctx.plant.p_bar,
  }),
  Object.freeze({
    id: 'FT-101',
    name: 'Flow to process',
    unit: 'm3/h',
    lo: 0,
    hi: 150,
    // 0.25% OF RATE for a magmeter, carried here as a span figure because the calibration sheet
    // works in percent of span. At the 30 m3/h duty point the real instrument is four times worse
    // than this number in span terms, and `spanReferenced: false` is how the certificate says so.
    accuracy_pct: 0.25,
    drift_pctPerYear: 0.10,
    tempCoef_pctPer10K: 0.05,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: 'ft_m3h',
    filterKey: 'ft',
    loop: 'FLOW',
    pump: null,
    valve: null,
    spanReferenced: false,
    read: (ctx) => ctx.plant.Qdemand_m3h,
  }),
  Object.freeze({
    id: 'LT-101',
    name: 'Suction tank level',
    unit: 'm',
    lo: 0,
    hi: 4,
    accuracy_pct: 0.10,
    // Worse than the pressure transmitter it is built from, because a level measurement is only as
    // stable as its wet leg: fill fluid evaporates, condensate collects, and the zero walks.
    drift_pctPerYear: 0.20,
    tempCoef_pctPer10K: 0.12,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: 'lt_m',
    filterKey: 'lt',
    loop: 'LEVEL',
    pump: null,
    valve: null,
    spanReferenced: true,
    read: (ctx) => ctx.plant.level_m,
  }),
  Object.freeze({
    id: 'TT-101',
    name: 'Tank temperature',
    unit: 'C',
    lo: 0,
    hi: 100,
    accuracy_pct: 0.35,
    drift_pctPerYear: 0.05,
    tempCoef_pctPer10K: 0.02,
    tolerance_pct: 1.0,
    interval_h: 17520,
    field: 'tt_C',
    filterKey: 'tt',
    loop: null,
    pump: null,
    valve: null,
    spanReferenced: true,
    read: (ctx) => ctx.plant.T_tank_C,
  }),
  Object.freeze({
    id: 'PT-100',
    name: 'Suction manifold pressure',
    unit: 'bar',
    // A suction gauge has to read below atmospheric or it cannot show a lift, and this rig's tank
    // floor sits below the pump centreline.
    lo: -1,
    hi: 4,
    accuracy_pct: 0.10,
    drift_pctPerYear: 0.15,
    tempCoef_pctPer10K: 0.10,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: null,
    filterKey: null,
    loop: null,
    pump: null,
    valve: null,
    spanReferenced: true,
    // Upstream of the strainers, so it reads the static head with no branch loss in it. The
    // difference between this and PT-104/105 IS the strainer differential, which is how a blinding
    // strainer is found — and why a drift on either one invents a blockage that is not there.
    read: (ctx) => headToBar(ctx.plant.zStatic_m, ctx.plant.fluid.rho_kgm3),
  }),
  Object.freeze({
    id: 'PT-104',
    name: 'P-101 suction pressure',
    unit: 'bar',
    lo: -1,
    hi: 4,
    accuracy_pct: 0.10,
    drift_pctPerYear: 0.15,
    tempCoef_pctPer10K: 0.10,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: null,
    filterKey: null,
    loop: null,
    pump: 0,
    valve: null,
    spanReferenced: true,
    read: (ctx) => suctionPressure_bar(ctx, 0),
  }),
  Object.freeze({
    id: 'PT-105',
    name: 'P-102 suction pressure',
    unit: 'bar',
    lo: -1,
    hi: 4,
    accuracy_pct: 0.10,
    drift_pctPerYear: 0.15,
    tempCoef_pctPer10K: 0.10,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: null,
    filterKey: null,
    loop: null,
    pump: 1,
    valve: null,
    spanReferenced: true,
    read: (ctx) => suctionPressure_bar(ctx, 1),
  }),
  Object.freeze({
    id: 'PT-102',
    name: 'P-101 discharge pressure',
    unit: 'bar',
    lo: 0,
    hi: 12,
    accuracy_pct: 0.10,
    drift_pctPerYear: 0.15,
    tempCoef_pctPer10K: 0.10,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: null,
    filterKey: null,
    loop: null,
    pump: 0,
    valve: null,
    spanReferenced: true,
    read: (ctx) => dischargePressure_bar(ctx, 0),
  }),
  Object.freeze({
    id: 'PT-103',
    name: 'P-102 discharge pressure',
    unit: 'bar',
    lo: 0,
    hi: 12,
    accuracy_pct: 0.10,
    drift_pctPerYear: 0.15,
    tempCoef_pctPer10K: 0.10,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: null,
    filterKey: null,
    loop: null,
    pump: 1,
    valve: null,
    spanReferenced: true,
    read: (ctx) => dischargePressure_bar(ctx, 1),
  }),
  Object.freeze({
    id: 'FT-102',
    name: 'P-101 flow',
    unit: 'm3/h',
    lo: 0,
    hi: 80,
    accuracy_pct: 0.25,
    drift_pctPerYear: 0.10,
    tempCoef_pctPer10K: 0.05,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: null,
    filterKey: null,
    loop: null,
    pump: 0,
    valve: null,
    spanReferenced: false,
    read: (ctx) => ctx.plant.Q_m3h[0],
  }),
  Object.freeze({
    id: 'FT-103',
    name: 'P-102 flow',
    unit: 'm3/h',
    lo: 0,
    hi: 80,
    accuracy_pct: 0.25,
    drift_pctPerYear: 0.10,
    tempCoef_pctPer10K: 0.05,
    tolerance_pct: 1.0,
    interval_h: 8760,
    field: null,
    filterKey: null,
    loop: null,
    pump: 1,
    valve: null,
    spanReferenced: false,
    read: (ctx) => ctx.plant.Q_m3h[1],
  }),
  Object.freeze({
    id: 'TE-102',
    name: 'P-101 casing temperature',
    unit: 'C',
    lo: 0,
    hi: 150,
    accuracy_pct: 0.30,
    drift_pctPerYear: 0.05,
    tempCoef_pctPer10K: 0.02,
    tolerance_pct: 1.5,
    interval_h: 17520,
    field: null,
    filterKey: null,
    loop: null,
    pump: 0,
    valve: null,
    spanReferenced: true,
    read: (ctx) => ctx.plant.Tcasing_C[0],
  }),
  Object.freeze({
    id: 'TE-103',
    name: 'P-102 casing temperature',
    unit: 'C',
    lo: 0,
    hi: 150,
    accuracy_pct: 0.30,
    drift_pctPerYear: 0.05,
    tempCoef_pctPer10K: 0.02,
    tolerance_pct: 1.5,
    interval_h: 17520,
    field: null,
    filterKey: null,
    loop: null,
    pump: 1,
    valve: null,
    spanReferenced: true,
    read: (ctx) => ctx.plant.Tcasing_C[1],
  }),
  Object.freeze({
    id: 'II-101',
    name: 'P-101 motor current',
    unit: '% FLA',
    lo: 0,
    hi: 150,
    // The drive's own estimate, not a metering-class CT. Three percent is a normal published
    // figure and it is the reason a motor-current trend is a load indication and not a condition
    // measurement: a bearing that has gone from good to bad moves the current by less than this.
    accuracy_pct: 3.0,
    drift_pctPerYear: 0.5,
    tempCoef_pctPer10K: 0.4,
    tolerance_pct: 5.0,
    interval_h: 17520,
    field: null,
    filterKey: null,
    loop: null,
    pump: 0,
    valve: null,
    spanReferenced: false,
    read: (ctx) => ctx.plant.drv[0].i_pct,
  }),
  Object.freeze({
    id: 'II-102',
    name: 'P-102 motor current',
    unit: '% FLA',
    lo: 0,
    hi: 150,
    accuracy_pct: 3.0,
    drift_pctPerYear: 0.5,
    tempCoef_pctPer10K: 0.4,
    tolerance_pct: 5.0,
    interval_h: 17520,
    field: null,
    filterKey: null,
    loop: null,
    pump: 1,
    valve: null,
    spanReferenced: false,
    read: (ctx) => ctx.plant.drv[1].i_pct,
  }),
  Object.freeze({
    id: 'ZT-101',
    name: 'FCV-101 position feedback',
    unit: '%',
    lo: 0,
    hi: 100,
    // A positioner's feedback is a potentiometer or a hall sensor on a linkage, and the linkage
    // wears. One percent is typical and half a percent a year of drift is what a worn takeoff arm
    // gives you — which is why a valve that "never gets to 100%" is so often a feedback problem
    // rather than a valve problem.
    accuracy_pct: 1.0,
    drift_pctPerYear: 0.5,
    tempCoef_pctPer10K: 0.2,
    tolerance_pct: 2.0,
    interval_h: 17520,
    field: null,
    filterKey: null,
    loop: null,
    pump: null,
    valve: 'fcv',
    spanReferenced: true,
    read: (ctx) => ctx.plant.fcv.x * 100,
  }),
  Object.freeze({
    id: 'ZT-102',
    name: 'PCV-101 position feedback',
    unit: '%',
    lo: 0,
    hi: 100,
    accuracy_pct: 1.0,
    drift_pctPerYear: 0.5,
    tempCoef_pctPer10K: 0.2,
    tolerance_pct: 2.0,
    interval_h: 17520,
    field: null,
    filterKey: null,
    loop: null,
    pump: null,
    valve: 'pcv',
    spanReferenced: true,
    read: (ctx) => ctx.plant.pcv.x * 100,
  }),
]);

/** Instruments by tag, so a lookup is not a linear scan on every scan of every loop. */
export const INSTRUMENT_BY_ID = Object.freeze(
  Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i])),
);

// ---------------------------------------------------------------------------------------------
// Guards. Nothing here throws; a bad argument comes back as a sentence an operator could read.
// ---------------------------------------------------------------------------------------------

/**
 * A finite number, or the fallback.
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
 * @param {string} reason the operator-readable refusal
 * @returns {{ok:false, reason:string}} the failure result
 */
const fail = (reason) => ({ ok: false, reason });

/**
 * Find a channel, or say why not.
 * @param {object} cs calibration state
 * @param {string} id an instrument tag
 * @returns {{ok:boolean, reason?:string, ch?:object, inst?:object}} the channel and its nameplate
 */
function channel(cs, id) {
  if (!isRecord(cs) || !isRecord(cs.ch)) {
    return fail('There is no instrument condition to work with — the calibration layer was never built.');
  }
  const inst = INSTRUMENT_BY_ID[id];
  if (!inst) return fail(`There is no instrument tagged ${id} on this rig.`);
  const ch = cs.ch[id];
  if (!ch) return fail(`${id} is on the drawing but not in the instrument register.`);
  return { ok: true, ch, inst };
}

/** @param {object} inst an instrument @returns {number} its calibrated span, in its own units */
const spanOf = (inst) => inst.hi - inst.lo;

// ---------------------------------------------------------------------------------------------
// Building the state
// ---------------------------------------------------------------------------------------------

/**
 * Allocate the condition of every instrument on the rig.
 *
 * The inherent errors — linearity, hysteresis, repeatability, the temperature coefficient and the
 * DIRECTION each instrument's drift runs in — are drawn once, here, from the seeded generator and
 * then never redrawn. That is what makes a maintenance history reproducible: the transmitter that
 * drifts high in one run drifts high in every run from the same seed, so "why did that loop end up
 * 0.4 bar out" has an answer somebody can go back and check.
 *
 * Published accuracy figures are BOUNDS, not typical values, so each component is drawn inside its
 * bound rather than at it. An instrument sitting exactly at its specification limit on every term
 * at once does not exist.
 *
 * `sinceCal_h` is staggered across the register on purpose. A plant where every certificate expires
 * in the same week is a plant nobody has ever maintained.
 *
 * @param {object} config the frozen sim config, for the seed and the site ambient
 * @param {function} [rng] a seeded generator from `game/rng.js`; built from the config seed if absent
 * @returns {object} the mutable calibration state
 */
export function createCalState(config, rng) {
  const seed = isRecord(config) && Number.isFinite(config.seed) ? config.seed : 0x5041;
  const r = typeof rng === 'function' ? rng : makeRng(seed ^ 0x43414c);
  const ambient = isRecord(config) && isRecord(config.site)
    ? num(config.site.ambient_C, REF_TEMP_C) : REF_TEMP_C;

  const cs = {
    /** Equipment hours this register has accumulated, on the compressed clock. */
    now_h: 0,
    /** The plant tick the last `applyCalibration` wrote at, for the injection accounting. */
    tick0: 0,
    /** False once `stepCalibration` sees the feature switched off; `applyCalibration` then idles. */
    enabled: true,
    /** The generator every stochastic thing in this module draws from. */
    rng: r,
    /** @type {Object<string, object>} condition, one entry per instrument tag */
    ch: {},
    /** @type {Array<object>} every certificate ever issued, newest last. */
    certificates: [],
    /** @type {Array<object>} things worth telling the operator about, drained by the UI. */
    events: [],
  };

  for (const inst of INSTRUMENTS) {
    const acc = inst.accuracy_pct;
    cs.ch[inst.id] = {
      id: inst.id,
      // --- the adjustable terms, in percent of span -----------------------------------------
      /** Constant error across the range. What a zero adjustment moves. */
      zeroPct: rngNormal(r, 0, acc * 0.35),
      /** Error proportional to the reading, quoted at full span. What a span adjustment moves. */
      spanPct: rngNormal(r, 0, acc * 0.35),

      // --- the inherent terms, which no adjustment can remove -------------------------------
      /** Bow in the middle of the characteristic, peak deviation at 50% of span. */
      linPct: rngNormal(r, 0, acc * 0.30),
      /** Gap between the rising and falling traverse, peak at mid-scale. Never negative. */
      hystPct: Math.abs(rngNormal(r, 0, acc * 0.40)),
      /** One standard deviation of scatter between readings at the same point. */
      repPct: Math.abs(rngNormal(r, 0, acc * 0.20)),
      /** Reversible zero shift with the transmitter's own ambient, % of span per 10 K. */
      tempZeroPct_per10K: rngRange(r, -1, 1) * inst.tempCoef_pctPer10K,

      // --- the terms that move -------------------------------------------------------------
      /** Signed zero drift rate, % of span per year. Drawn inside the datasheet bound. */
      driftZero_pctPerYear: rngRange(r, -1, 1) * inst.drift_pctPerYear,
      /** Signed span drift rate, % of span per year. Smaller: a gain moves less than a zero. */
      driftSpan_pctPerYear: rngRange(r, -1, 1) * inst.drift_pctPerYear * 0.5,
      /** Extra damping somebody has dialled into the transmitter, s. Zero on a healthy loop. */
      lag_s: 0,
      /** The damping filter's state, in engineering units. */
      y: NaN,

      // --- condition -----------------------------------------------------------------------
      /** One of {@link FAULT}. */
      fault: FAULT.NONE,
      /** The value a stuck transmitter is stuck at. */
      stuckAt: NaN,
      /** Equipment hours since this instrument was last calibrated. Staggered at build. */
      sinceCal_h: rngRange(r, 0, 1) * inst.interval_h,
      /** Equipment hours since it was installed. */
      age_h: 0,
      /** Its calibration interval, hours. Editable: an overdue loop is often re-intervalled. */
      interval_h: inst.interval_h,

      // --- what it is reading right now ----------------------------------------------------
      /** The physical truth, in engineering units. */
      trueValue: NaN,
      /** What the sensor sees before this module's error model — the plant's own signal. */
      clean: NaN,
      /** What the transmitter INDICATES. The only one of these three the controller ever gets. */
      value: NaN,
      /** value - clean, in engineering units. Kept so the plant write can be undone next scan. */
      injected: 0,
      /** Direction of the last movement, for the hysteresis branch. */
      dir: 1,
      /** The ambient this particular transmitter is sitting in, C. Not the site ambient. */
      ambient_C: ambient,

      // --- paperwork -------------------------------------------------------------------------
      /** The calibration in progress, or null. */
      job: null,
      /** The last certificate issued for this tag, or null. */
      cert: null,
    };
  }
  return cs;
}

// ---------------------------------------------------------------------------------------------
// The error model
// ---------------------------------------------------------------------------------------------

/**
 * The static error at a point, in percent of span.
 *
 * Every term is separately visible in the sum, because the whole point of the model is that a
 * technician can look at a sheet and name which one he is looking at.
 *
 * The two shape functions are `4f(1-f)`, which is zero at both ends of the range and peaks at 1 in
 * the middle. That is right for both terms it is used on: a linearity error is measured as a
 * deviation from the straight line THROUGH the endpoints, so it is zero at the endpoints by
 * construction, and a hysteresis loop is closed at the turnaround points because those are where
 * the traverse reverses.
 *
 * @param {object} ch the channel condition
 * @param {number} f the input as a fraction of span
 * @param {number} dir +1 on a rising traverse, -1 on a falling one
 * @returns {number} the error, percent of span
 */
function errorPct(ch, f, dir) {
  const bow = 4 * f * (1 - f);
  return ch.zeroPct
    + ch.spanPct * f
    + ch.linPct * bow
    // Rising, the indication lags and reads low; falling, it reads high. Half the loop width
    // either side of the straight line, which is how a hysteresis figure is defined.
    - (dir >= 0 ? 0.5 : -0.5) * ch.hystPct * bow
    + (ch.tempZeroPct_per10K * (ch.ambient_C - REF_TEMP_C)) / 10;
}

/**
 * Clamp an indication to what a 4-20 mA transmitter can physically send.
 * @param {number} v the value
 * @param {object} inst the instrument
 * @returns {number} the value, limited to the NAMUR NE 43 fault band
 */
function clampSignal(v, inst) {
  const s = spanOf(inst);
  return clamp(v, inst.lo + NAMUR.FAULT_LOW_FRAC * s, inst.lo + NAMUR.FAULT_HIGH_FRAC * s);
}

/**
 * What a FAILED instrument indicates, which has nothing to do with what it is measuring.
 * @param {object} cs calibration state, for the spike draw
 * @param {object} ch the channel condition
 * @param {object} inst the instrument
 * @param {number} x the true input, engineering units
 * @returns {number} the indication
 */
function faultValue(cs, ch, inst, x) {
  const s = spanOf(inst);
  switch (ch.fault) {
    case FAULT.STUCK:
      return Number.isFinite(ch.stuckAt) ? ch.stuckAt : x;
    case FAULT.SAT_HIGH:
      return inst.lo + NAMUR.FAULT_HIGH_FRAC * s;
    case FAULT.SAT_LOW:
    case FAULT.DOWNSCALE:
      return inst.lo + NAMUR.FAULT_LOW_FRAC * s;
    case FAULT.SPIKING: {
      // Intermittent by definition: most readings are fine, which is precisely what makes a loose
      // terminal so hard to find and so destructive to a derivative term.
      const p = rngRange(cs.rng, 0, 1);
      const jump = rngRange(cs.rng, -1, 1);
      if (p > SPIKE_P) return x;
      return clampSignal(x + jump * SPIKE_FRAC * s, inst);
    }
    default:
      return x;
  }
}

/**
 * What an instrument would indicate for a given true input.
 *
 * This is the function the calibration procedure is measuring and the function `applyCalibration`
 * applies. It is deliberately pure with respect to time — it carries no drift integration and no
 * repeatability draw — so that the same input twice gives the same answer twice on a healthy
 * instrument. Repeatability scatter belongs to a discrete READING and is added in
 * {@link recordPoint}; adding it here as well would double-count it against the transmitter noise
 * the plant already generates.
 *
 * @param {object} cs the calibration state
 * @param {string} id the instrument tag
 * @param {number} trueValue the true value of the measured quantity, in engineering units
 * @param {number} [dir] +1 rising, -1 falling; defaults to the channel's last movement
 * @returns {number} the indicated value, in engineering units — NaN if there is no such instrument
 */
export function errorOf(cs, id, trueValue, dir) {
  const c = channel(cs, id);
  if (!c.ok) return NaN;
  const { ch, inst } = c;
  const x = num(trueValue, NaN);
  if (!Number.isFinite(x)) return NaN;
  if (ch.fault !== FAULT.NONE) return faultValue(cs, ch, inst, x);
  const f = clamp((x - inst.lo) / spanOf(inst), NAMUR.FAULT_LOW_FRAC, NAMUR.FAULT_HIGH_FRAC);
  const d = Number.isFinite(dir) ? dir : ch.dir;
  return clampSignal(x + (errorPct(ch, f, d) / 100) * spanOf(inst), inst);
}

/**
 * The error an instrument is carrying right now, in percent of span — the number the condition
 * table sorts on and the number a "worst instrument on the rig" readout wants.
 * @param {object} cs the calibration state
 * @param {string} id the instrument tag
 * @returns {number} indicated minus true, as a percentage of span; NaN before the first scan
 */
export function errorPctOf(cs, id) {
  const c = channel(cs, id);
  if (!c.ok) return NaN;
  const { ch, inst } = c;
  if (!Number.isFinite(ch.value) || !Number.isFinite(ch.trueValue)) return NaN;
  return ((ch.value - ch.trueValue) / spanOf(inst)) * 100;
}

// ---------------------------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------------------------

/**
 * The ambient this particular transmitter is sitting in, C.
 *
 * NOT the site ambient for anything bolted to a machine. A transmitter on a pump that is being run
 * at minimum flow is in the thermal shadow of a casing that is cooking, and it drifts accordingly.
 * That is the causal chain: a badly operated plant does not only wear its bearings out, it walks
 * its instruments off calibration, and the instruments it walks off are the ones on the machine
 * that was abused.
 *
 * @param {object} ctx the sim context
 * @param {object} inst the instrument
 * @returns {number} the local ambient, C
 */
function ambientFor(ctx, inst) {
  const base = isRecord(ctx.config) && isRecord(ctx.config.site)
    ? num(ctx.config.site.ambient_C, REF_TEMP_C) : REF_TEMP_C;
  if (inst.pump === null || !ctx.plant || !ctx.plant.Tcasing_C) return base;
  const casing = num(ctx.plant.Tcasing_C[inst.pump], base);
  return base + CASING_SHADOW * Math.max(0, casing - base);
}

/**
 * Roll a hard failure for one instrument over an interval.
 * @param {object} cs calibration state, for the generator
 * @param {object} cfg the realism configuration
 * @param {object} ch the channel condition
 * @param {number} dh equipment hours elapsed
 * @returns {string|null} the fault mode that arrived, or null
 */
function rollFault(cs, cfg, ch, dh) {
  const hazard = TRANSMITTER_FIT * rateOf(cfg, 'failure') * dh;
  if (rngRange(cs.rng, 0, 1) >= hazard) return null;
  let pick = rngRange(cs.rng, 0, 1);
  for (const w of FAULT_WEIGHTS) {
    pick -= w.w;
    if (pick <= 0) return w.mode;
  }
  return FAULT.DOWNSCALE;
}

/**
 * Age every instrument on the register by one scan.
 *
 * Drift is integrated against {@link agedHours} rather than against wall time, so the whole layer
 * shares one documented acceleration factor instead of each module inventing its own. It is
 * accelerated further by the transmitter's own temperature — see {@link DRIFT_DOUBLING_K} — which
 * is the mechanism that connects how the plant was operated to how far its instruments have walked.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {object} cfg the realism configuration
 * @param {object} ctx the sim context
 * @param {number} dt_s the scan interval, real seconds
 * @returns {void}
 */
export function stepCalibration(cs, cfg, ctx, dt_s) {
  if (!isRecord(cs) || !isRecord(cs.ch) || !isRecord(ctx)) return;
  cs.enabled = isOn(cfg, FEATURE.CALIBRATION);
  if (!cs.enabled) return;

  const dh = agedHours(cfg, dt_s);
  if (!(dh > 0)) return;
  const years = dh / 8760;
  const severity = rateOf(cfg, 'drift');
  const failures = isOn(cfg, FEATURE.FAILURES);
  cs.now_h += dh;

  for (const inst of INSTRUMENTS) {
    const ch = cs.ch[inst.id];
    if (!ch) continue;
    ch.ambient_C = ambientFor(ctx, inst);
    ch.age_h += dh;
    ch.sinceCal_h += dh;

    // A calibration in progress freezes the drift. The instrument is off the process, sitting on a
    // bench at workshop temperature, and pretending it is still ageing in the field would put an
    // error into the as-left column that the technician had no way to measure.
    if (ch.job && ch.job.active) continue;

    const accel = Math.pow(2, (ch.ambient_C - REF_TEMP_C) / DRIFT_DOUBLING_K);
    ch.zeroPct += ch.driftZero_pctPerYear * years * severity * accel;
    ch.spanPct += ch.driftSpan_pctPerYear * years * severity * accel;

    if (failures && ch.fault === FAULT.NONE) {
      const mode = rollFault(cs, cfg, ch, dh);
      if (mode) {
        ch.fault = mode;
        ch.stuckAt = ch.value;
        cs.events.push({
          at_h: cs.now_h,
          id: inst.id,
          kind: 'fault',
          message: `${inst.id} (${inst.name}) has failed ${mode.toLowerCase().replace('_', ' ')}.`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Putting the indication in front of the controller
// ---------------------------------------------------------------------------------------------

/**
 * How much of an injected offset the plant's own transmitter filter has eaten since the last scan.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS ARITHMETIC IS NECESSARY AND WHY IT IS EXACT
 *
 * `process/plant.js` computes each transmitted signal into a field — `pt_bar`, `ft_m3h` — and that
 * field is BOTH the output and the state of a first-order filter. So when this module writes an
 * offset indication into it, the plant spends the next several ticks filtering that offset back out
 * again, and by the following scan the field is no longer what we wrote.
 *
 * The filter is affine, though: `lag(y, u)` is `u(1-a) + y*a`, so an offset `e` added to `y`
 * arrives `n` ticks later as exactly `e * a^n` on top of whatever the plant would have produced by
 * itself. Subtracting that recovers the plant's own clean signal EXACTLY, with no estimator and no
 * accumulating error, and the tick count comes from `plant.tick` rather than being assumed — so a
 * paused rig, a slow frame or a changed scan period all come out right.
 *
 * The alternative — building a second copy of the transmitter's noise, dead time and filter in this
 * module — would have meant two implementations of the signal path that could drift apart, and the
 * first symptom would have been a loop whose dead time changed when realism was switched on.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} config the frozen sim config
 * @param {object} inst the instrument
 * @param {number} dt_s seconds of plant time since the last write
 * @returns {number} the fraction of the injected offset still present, 0..1
 */
function retention(config, inst, dt_s) {
  if (!inst.filterKey || !isRecord(config.instruments)) return 1;
  const spec = config.instruments[inst.filterKey];
  const tau = spec ? num(spec.filter_s, 0) : 0;
  if (!(tau > 0) || !(dt_s > 0)) return 1;
  return Math.exp(-dt_s / tau);
}

/**
 * Put the indicated value in front of everything that reads an instrument.
 *
 * Called at the very top of the controller scan, before the supervisory processor and before the
 * loop, so that nothing downstream this scan can read a measurement the transmitter has not had a
 * chance to corrupt.
 *
 * Both numbers survive the call. `ch.trueValue` is the plant, `ch.value` is the transmitter, and
 * only `ch.value` is written back into the plant field the controller reads. A trend that plots
 * both is the lesson; a trend that plots one is a mystery.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {object} ctx the sim context (its instrument fields are mutated)
 * @returns {void}
 */
export function applyCalibration(cs, ctx) {
  if (!isRecord(cs) || !isRecord(cs.ch) || !isRecord(ctx) || !isRecord(ctx.plant)) return;
  const { plant, config } = ctx;
  const ticks = Math.max(0, num(plant.tick, 0) - num(cs.tick0, 0));
  const dt = ticks * num(config.dt_s, 0.02);

  for (const inst of INSTRUMENTS) {
    const ch = cs.ch[inst.id];
    if (!ch) continue;

    let trueValue = NaN;
    try {
      trueValue = num(inst.read(ctx), NaN);
    } catch {
      // A reader that trips over a half-built plant state must not take the scan down with it.
      trueValue = NaN;
    }
    if (!Number.isFinite(trueValue)) continue;

    // The signal as the plant made it: the field with our previous injection removed. For an
    // instrument the plant does not carry a field for, that is simply the truth.
    let clean = trueValue;
    if (inst.field && Number.isFinite(plant[inst.field])) {
      clean = plant[inst.field] - ch.injected * retention(config, inst, dt);
    }

    ch.ambient_C = ambientFor(ctx, inst);
    ch.trueValue = trueValue;
    ch.clean = clean;

    if (!cs.enabled) {
      // Switched off: hand the plant's own signal straight back and un-inject whatever was there,
      // so turning the feature off during a session leaves a clean instrument rather than a frozen
      // offset nobody can now get rid of.
      ch.value = clean;
      ch.injected = 0;
      ch.y = clean;
      if (inst.field) plant[inst.field] = clean;
      continue;
    }

    // Extra damping, if somebody has dialled some in. Zero by default, so a healthy loop keeps
    // exactly the dynamics it had before this layer was switched on.
    const damped = ch.lag_s > 0 && Number.isFinite(ch.y)
      ? lag(ch.y, clean, ch.lag_s, Math.max(dt, 1e-6))
      : clean;
    ch.y = damped;

    if (Number.isFinite(ch.clean) && Number.isFinite(ch.value)) {
      const move = damped - ch.clean;
      if (Math.abs(move) > 1e-9) ch.dir = move > 0 ? 1 : -1;
    }
    if (ch.fault === FAULT.STUCK && !Number.isFinite(ch.stuckAt)) ch.stuckAt = damped;

    const indicated = errorOf(cs, inst.id, damped, ch.dir);
    ch.value = Number.isFinite(indicated) ? indicated : damped;
    ch.injected = ch.value - clean;
    if (inst.field) plant[inst.field] = ch.value;
  }
  cs.tick0 = num(plant.tick, 0);
}

/**
 * Both numbers for every instrument, for a panel that wants to show them side by side.
 * @param {object} cs the calibration state
 * @returns {Array<object>} one row per instrument: tag, name, unit, true, indicated, error, status
 */
export function readings(cs) {
  if (!isRecord(cs) || !isRecord(cs.ch)) return [];
  return INSTRUMENTS.map((inst) => {
    const ch = cs.ch[inst.id];
    const span = spanOf(inst);
    const err = ch && Number.isFinite(ch.value) && Number.isFinite(ch.trueValue)
      ? ch.value - ch.trueValue : NaN;
    return {
      id: inst.id,
      name: inst.name,
      unit: inst.unit,
      trueValue: ch ? ch.trueValue : NaN,
      indicated: ch ? ch.value : NaN,
      error: err,
      errorPct: Number.isFinite(err) ? (err / span) * 100 : NaN,
      fault: ch ? ch.fault : FAULT.NONE,
      overdue: ch ? ch.sinceCal_h > ch.interval_h : false,
      tolerance_pct: inst.tolerance_pct,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Is this loop in service?
// ---------------------------------------------------------------------------------------------

/**
 * Why this instrument must not be worked on right now, or null if it may be.
 *
 * The rules are the ones a permit would carry. A transmitter that is the PV of a loop in automatic
 * is controlling a running plant; isolating it hands the controller a measurement that no longer
 * moves, and the controller answers by driving its output to a limit. A transmitter on a machine
 * that is turning is inside the machine's protection. A valve position feedback cannot be stroked
 * against a live header.
 *
 * @param {object} ctx the sim context
 * @param {object} inst the instrument
 * @returns {string|null} the reason, or null when the loop is out of service
 */
export function inServiceReason(ctx, inst) {
  if (!isRecord(ctx) || !isRecord(ctx.plant)) return null;
  const { plant, pid, run } = ctx;

  if (inst.loop && isRecord(pid) && isRecord(run) && run.mode === inst.loop
    && pid.mode !== MODE.MAN) {
    return `${inst.id} is the measurement the loop is controlling on and the controller is in `
      + `${pid.mode}. Put the loop in manual before isolating the transmitter, or the controller `
      + 'will drive its output to a limit on a measurement that has stopped moving.';
  }

  if (inst.pump !== null && Array.isArray(plant.drv) && plant.drv[inst.pump]) {
    const st = plant.drv[inst.pump].state;
    if (st !== DRIVE.STOPPED && st !== DRIVE.TRIPPED) {
      return `${inst.id} is on a machine that is running. Stop and isolate the pump before `
        + 'breaking into its instrumentation.';
    }
  }

  if (inst.valve && Array.isArray(plant.drv)) {
    const running = plant.drv.some((d) => d.state !== DRIVE.STOPPED && d.state !== DRIVE.TRIPPED);
    if (running) {
      return `${inst.id} reads back a valve in the live flow path. Proving a position feedback `
        + 'means stroking the valve, and that cannot be done with pumps running.';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The procedure
// ---------------------------------------------------------------------------------------------

/**
 * When this instrument's certificate expires.
 *
 * @param {object} cs the calibration state
 * @param {string} id the instrument tag
 * @param {number} [now_h] equipment hours now; defaults to the register's own clock
 * @returns {{ok:boolean, reason?:string, due_h?:number, overdue?:boolean, interval_h?:number,
 *   sinceCal_h?:number}} how long is left, or why the question cannot be answered
 */
export function dueStatus(cs, id, now_h) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  const { ch } = c;
  const since = ch.sinceCal_h;
  const remaining = ch.interval_h - since;
  return {
    ok: true,
    due_h: remaining,
    overdue: remaining < 0,
    interval_h: ch.interval_h,
    sinceCal_h: since,
    // `now_h` is accepted so a caller with its own maintenance clock can ask against that one
    // rather than against ours; the answer does not depend on it, because what expires a
    // certificate is hours run since the calibration, not the date on the wall.
    at_h: Number.isFinite(now_h) ? now_h : cs.now_h,
  };
}

/**
 * Everything that is due or overdue, worst first — the list a planner works from.
 * @param {object} cs the calibration state
 * @param {number} [within_h=720] also list anything falling due inside this many hours
 * @returns {Array<object>} {id, name, due_h, overdue, interval_h}
 */
export function dueList(cs, within_h = 720) {
  if (!isRecord(cs) || !isRecord(cs.ch)) return [];
  return INSTRUMENTS
    .map((inst) => ({ inst, d: dueStatus(cs, inst.id) }))
    .filter((r) => r.d.ok && r.d.due_h <= within_h)
    .sort((a, b) => a.d.due_h - b.d.due_h)
    .map((r) => ({
      id: r.inst.id, name: r.inst.name, due_h: r.d.due_h, overdue: r.d.overdue,
      interval_h: r.d.interval_h,
    }));
}

/**
 * Start a calibration.
 *
 * Refuses on a loop that is in service. That refusal is the point of the function: everything else
 * it does is bookkeeping, and this is the interlock.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {string} id the instrument tag
 * @param {object} [opts] the job
 * @param {object} [opts.ctx] the sim context, so the in-service check can be made. Omitting it
 *   skips the check, which is only ever right in a bench test.
 * @param {boolean} [opts.isolated] the technician's confirmation that the manifold is isolated and
 *   the loop defeated. Required: the whole hazard is starting without it.
 * @param {string} [opts.technician] whose name goes on the certificate
 * @param {string} [opts.reference='CALIBRATOR'] which standard is being used, a {@link REFERENCES} id
 * @param {number} [opts.tolerance_pct] the as-left tolerance, defaulting to the loop sheet's
 * @returns {{ok:boolean, reason?:string, warning?:string, tar?:number}} ok, or why not
 */
export function beginCalibration(cs, id, opts) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  const { ch, inst } = c;
  const o = isRecord(opts) ? opts : {};

  if (ch.job && ch.job.active) {
    return fail(`${id} already has a calibration open. Finish or abandon that one first.`);
  }

  if (isRecord(o.ctx)) {
    const busy = inServiceReason(o.ctx, inst);
    if (busy) return fail(busy);
  }

  if (o.isolated !== true) {
    return fail(`${id} has not been isolated. Confirm the manifold is closed and the loop is `
      + 'defeated — pass { isolated: true } — before applying a test pressure to a transmitter '
      + 'that is still connected to the process.');
  }

  const ref = REFERENCES[o.reference] || REFERENCES.CALIBRATOR;
  const tolerance = Number.isFinite(o.tolerance_pct) ? Math.abs(o.tolerance_pct)
    : inst.tolerance_pct;
  const tar = inst.accuracy_pct / ref.accuracy_pct;

  // The reference standard's OWN error, drawn once for this job and held constant across it.
  //
  // Constant rather than point-by-point on purpose: over a single session the dominant
  // uncontrolled contribution from a good standard is a systematic offset — its zero, the head
  // correction between it and the transmitter, the ambient it was zeroed at — and its span error
  // against an instrument ten times less accurate is negligible. Treating it as a fixed offset is
  // both what a technician assumes and what makes the as-found sheet readable: a constant error
  // across all five points still means a zero shift, because the standard's contribution is
  // common to every row.
  const refOffset = rngNormal(cs.rng, 0, (ref.accuracy_pct / 2 / 100) * spanOf(inst));

  ch.job = {
    active: true,
    at_h: cs.now_h,
    technician: typeof o.technician === 'string' && o.technician ? o.technician : 'unassigned',
    reference: ref,
    tolerance_pct: tolerance,
    refOffset,
    asFound: [],
    asLeft: [],
    /** The zero and span the instrument arrived with, for the "what was adjusted" line. */
    before: { zeroPct: ch.zeroPct, spanPct: ch.spanPct },
    lastApplied: NaN,
  };

  const out = { ok: true, tar };
  if (tar < TAR_TARGET) {
    out.warning = `The ${ref.name} is only ${tar.toFixed(1)}:1 better than ${id}'s own `
      + `${inst.accuracy_pct}% accuracy. Calibration practice asks for ${TAR_TARGET}:1 — this `
      + 'result will carry an uncertainty comparable with the error it is trying to measure.';
  }
  return out;
}

/**
 * Record one point of the traverse.
 *
 * The technician applies a known input from the standard and writes down what the instrument says.
 * The error he records is `indicated - nominal`, because the nominal is what he believes he
 * applied — the standard's own offset is inside the number and he cannot see it. That is not a
 * modelling shortcut; it is the reason the certificate needs an uncertainty statement.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {string} id the instrument tag
 * @param {number} appliedPct the input applied, as a percentage of span
 * @param {number} [indicated] what was read; computed from the instrument's own condition when
 *   omitted, which is what the simulated technician does
 * @returns {{ok:boolean, reason?:string, error?:number, errorPct?:number, tolerance?:number,
 *   pass?:boolean, applied?:number, indicated?:number}} the row that went on the sheet
 */
export function recordPoint(cs, id, appliedPct, indicated) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  const { ch, inst } = c;
  const job = ch.job;
  if (!job || !job.active) {
    return fail(`There is no calibration open on ${id}. Start one before recording points.`);
  }
  const pct = num(appliedPct, NaN);
  if (!Number.isFinite(pct) || pct < -5 || pct > 105) {
    return fail('A calibration point has to be a percentage of span between 0 and 100.');
  }

  const span = spanOf(inst);
  const nominal = inst.lo + (pct / 100) * span;
  // What the standard ACTUALLY put on the instrument, as opposed to what the dial said.
  const applied = nominal + job.refOffset;
  const dir = Number.isFinite(job.lastApplied) && pct < job.lastApplied ? -1 : 1;
  job.lastApplied = pct;

  let read = num(indicated, NaN);
  if (!Number.isFinite(read)) {
    read = errorOf(cs, id, applied, dir);
    // Repeatability: the scatter between two readings taken at the same point on the same day. It
    // is drawn here and nowhere else, because it belongs to the act of taking a reading, and it is
    // what sets the floor on what any amount of calibration can resolve.
    if (ch.repPct > 0) read += (rngNormal(cs.rng, 0, ch.repPct) / 100) * span;
  }

  const error = read - nominal;
  const errPct = (error / span) * 100;
  const tolerance = (job.tolerance_pct / 100) * span;
  const row = {
    appliedPct: pct,
    applied: nominal,
    indicated: read,
    error,
    errorPct: errPct,
    dir,
    pass: Math.abs(errPct) <= job.tolerance_pct,
  };
  (job.asLeft.length || job.phase === 'AS_LEFT' ? job.asLeft : job.asFound).push(row);

  return {
    ok: true,
    error,
    errorPct: errPct,
    tolerance,
    pass: row.pass,
    applied: nominal,
    indicated: read,
  };
}

/**
 * Run a full five-up, five-down traverse through the instrument's present condition.
 *
 * Used for the as-left proving run, where the technician is not making a judgement about which
 * points to take — he is repeating the same ten he just did.
 *
 * @param {object} cs the calibration state
 * @param {object} ch the channel
 * @param {object} inst the instrument
 * @param {object} job the open job
 * @returns {Array<object>} the rows
 */
function traverse(cs, ch, inst, job) {
  const span = spanOf(inst);
  const rows = [];
  const sequence = [...CAL_POINTS, ...[...CAL_POINTS].reverse().slice(1)];
  let last = NaN;
  for (const pct of sequence) {
    const nominal = inst.lo + (pct / 100) * span;
    const applied = nominal + job.refOffset;
    const dir = Number.isFinite(last) && pct < last ? -1 : 1;
    last = pct;
    let read = errorOf(cs, inst.id, applied, dir);
    if (ch.repPct > 0) read += (rngNormal(cs.rng, 0, ch.repPct) / 100) * span;
    const error = read - nominal;
    rows.push({
      appliedPct: pct,
      applied: nominal,
      indicated: read,
      error,
      errorPct: (error / span) * 100,
      dir,
      pass: Math.abs((error / span) * 100) <= job.tolerance_pct,
    });
  }
  return rows;
}

/**
 * The measured error at a nominal point on a rising traverse, percent of span.
 * @param {Array<object>} rows the as-found sheet
 * @param {number} pct the point wanted
 * @returns {number} the recorded error there, or NaN if it was not taken
 */
function errorAt(rows, pct) {
  const row = rows.find((r) => r.dir >= 0 && Math.abs(r.appliedPct - pct) < 1e-6);
  return row ? row.errorPct : NaN;
}

/**
 * Close the calibration and issue the certificate.
 *
 * With `adjust` true the technician trims zero and span from what he measured. The trim removes
 * the error at 0% from the zero and the remaining error at 100% from the span — which is all a
 * two-point adjustment can do, and is why the linearity and hysteresis terms survive it and appear
 * in the as-left column. They are not a bug in the model; they are the residual every real
 * certificate carries.
 *
 * With `adjust` false nothing is touched and the as-left column is a copy of the as-found — which
 * is exactly what a real "found in tolerance, no adjustment made" certificate says. Re-measuring
 * would be dishonest paperwork: he did not take those readings.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {string} id the instrument tag
 * @param {boolean} [adjust=true] whether to trim zero and span
 * @returns {object} the certificate, or {ok:false, reason} if there was nothing to close
 */
export function finishCalibration(cs, id, adjust = true) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  const { ch, inst } = c;
  const job = ch.job;
  if (!job || !job.active) {
    return fail(`There is no calibration open on ${id} to close.`);
  }
  if (job.asFound.length === 0) {
    return fail(`No as-found readings were taken on ${id}. A certificate with an empty as-found `
      + 'column proves nothing about what the instrument was doing before it was touched.');
  }

  const span = spanOf(inst);
  const foundZero = errorAt(job.asFound, 0);
  const foundSpan = errorAt(job.asFound, 100);
  let adjusted = false;

  if (adjust && Number.isFinite(foundZero)) {
    // Zero first, then span on what is left: the order every calibration procedure specifies,
    // because the span adjustment is referred to the zero and doing it the other way round means
    // going round twice.
    ch.zeroPct -= foundZero;
    if (Number.isFinite(foundSpan)) ch.spanPct -= foundSpan - foundZero;
    adjusted = true;
  }

  const asLeft = adjusted ? traverse(cs, ch, inst, job) : job.asFound.map((r) => ({ ...r }));

  // Uncertainty of the result, combined in quadrature and expanded to k=2 — the GUM method, and
  // what ISO/IEC 17025 expects on the face of a certificate. Three contributions matter here: the
  // standard, the instrument's own repeatability, and the resolution it can be read to.
  const uRef = job.reference.uncertainty_pct / 2;
  const uRep = ch.repPct;
  const uRes = (0.01 * span) / span / Math.sqrt(3) * 100 / 2;
  const uncertainty_pct = 2 * Math.sqrt(uRef * uRef + uRep * uRep + uRes * uRes);

  const worst = asLeft.reduce((m, r) => Math.max(m, Math.abs(r.errorPct)), 0);
  const worstFound = job.asFound.reduce((m, r) => Math.max(m, Math.abs(r.errorPct)), 0);
  let verdict = 'PASS';
  if (worst > job.tolerance_pct) verdict = 'FAIL';
  else if (adjusted) verdict = 'ADJUSTED';

  const cert = {
    ok: true,
    id: inst.id,
    name: inst.name,
    unit: inst.unit,
    lo: inst.lo,
    hi: inst.hi,
    at_h: job.at_h,
    technician: job.technician,
    reference: job.reference.name,
    referenceNote: job.reference.note,
    tolerance_pct: job.tolerance_pct,
    asFound: job.asFound.map((r) => ({ ...r })),
    asLeft,
    adjusted,
    zeroTrim_pct: adjusted ? -foundZero : 0,
    spanTrim_pct: adjusted && Number.isFinite(foundSpan) ? -(foundSpan - foundZero) : 0,
    worstAsFound_pct: worstFound,
    worstAsLeft_pct: worst,
    verdict,
    uncertainty_pct,
    uncertainty_eu: (uncertainty_pct / 100) * span,
    interval_h: ch.interval_h,
    // The sentence that keeps the paperwork honest. An as-left column of zeros does not mean the
    // instrument is right; it means nobody has anything better to compare it against.
    statement: `Errors are stated as a percentage of the ${inst.lo} to ${inst.hi} ${inst.unit} `
      + `calibrated span. Expanded uncertainty ${uncertainty_pct.toFixed(3)}% of span (k=2, `
      + `about 95%), against a ${job.reference.name}. The instrument cannot be shown to be better `
      + 'than that figure however good the as-left column looks.',
  };

  ch.cert = cert;
  ch.sinceCal_h = 0;
  ch.job = null;
  cs.certificates.push(cert);
  cs.events.push({
    at_h: cs.now_h,
    id: inst.id,
    kind: 'calibration',
    message: `${inst.id} calibrated by ${cert.technician}: as found ${worstFound.toFixed(2)}% of `
      + `span, as left ${worst.toFixed(2)}%, ${verdict.toLowerCase()}.`,
  });
  return cert;
}

/**
 * Abandon an open calibration without issuing anything.
 *
 * Deliberately does NOT reset `sinceCal_h`: a job that was walked away from halfway through leaves
 * the instrument exactly as overdue as it was, which is the honest outcome and the one that keeps
 * turning up on the planner's list until somebody finishes it.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {string} id the instrument tag
 * @returns {{ok:boolean, reason?:string}} ok, or why not
 */
export function abortCalibration(cs, id) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  if (!c.ch.job || !c.ch.job.active) return fail(`There is no calibration open on ${id}.`);
  c.ch.job = null;
  return { ok: true };
}

/**
 * The last certificate issued for a tag.
 * @param {object} cs the calibration state
 * @param {string} id the instrument tag
 * @returns {object|null} the certificate, or null if the instrument has never been calibrated here
 */
export function certificateOf(cs, id) {
  const c = channel(cs, id);
  if (!c.ok) return null;
  return c.ch.cert;
}

/**
 * A bump test: put a test gauge on the same tapping and see whether the two agree.
 *
 * This is the five-minute check an operator asks for when a reading looks wrong, and its value is
 * as much in what it CANNOT do as in what it can. A field test gauge is accuracy class 0.5, and a
 * transmitter that has drifted 0.2% of span is well inside the gauge's own error — so a bump test
 * that comes back "agrees" does not mean the transmitter is right. It means the check was too
 * coarse to find anything, and the result says so in as many words.
 *
 * @param {object} cs the calibration state
 * @param {object} ctx the sim context
 * @param {string} id the instrument tag
 * @returns {{ok:boolean, reason?:string, result?:object}} the comparison
 */
export function bumpTest(cs, ctx, id) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  const { ch, inst } = c;
  if (!isRecord(ctx) || !isRecord(ctx.plant)) {
    return fail('There is no plant to take a reading from.');
  }

  let trueValue = NaN;
  try {
    trueValue = num(inst.read(ctx), NaN);
  } catch {
    trueValue = NaN;
  }
  if (!Number.isFinite(trueValue)) {
    return fail(`${id} cannot be read at the moment — there is nothing at that tapping to compare `
      + 'against.');
  }

  const span = spanOf(inst);
  const gauge = REFERENCES.FIELD_GAUGE;
  const gaugeError = rngNormal(cs.rng, 0, (gauge.accuracy_pct / 2 / 100) * span);
  const gaugeReads = trueValue + gaugeError;
  const indicated = Number.isFinite(ch.value) ? ch.value : errorOf(cs, id, trueValue);
  const diff = indicated - gaugeReads;
  const diffPct = (diff / span) * 100;
  // Anything inside the gauge's own accuracy is not evidence of anything.
  const resolvable = Math.abs(diffPct) > gauge.accuracy_pct;

  return {
    ok: true,
    result: {
      id: inst.id,
      indicated,
      reference: gaugeReads,
      unit: inst.unit,
      difference: diff,
      differencePct: diffPct,
      resolvable,
      verdict: resolvable ? 'SUSPECT' : 'INCONCLUSIVE',
      note: resolvable
        ? `${inst.id} reads ${diff >= 0 ? '+' : ''}${diff.toPrecision(3)} ${inst.unit} against a `
          + `test gauge, which is ${Math.abs(diffPct).toFixed(2)}% of span — outside what a class `
          + `${gauge.accuracy_pct} gauge could explain. Schedule a calibration.`
        : `${inst.id} agrees with the test gauge to within ${Math.abs(diffPct).toFixed(2)}% of `
          + `span, which is inside the gauge's own ${gauge.accuracy_pct}% accuracy. This proves `
          + 'nothing either way: a bump test cannot find a drift smaller than the standard used '
          + 'to look for it.',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Editing condition — for the fault library, the lessons and the scenarios
// ---------------------------------------------------------------------------------------------

/**
 * Put a fault on an instrument, or clear one.
 *
 * This is how a lesson stages "the transmitter has failed downscale, what does the loop do", which
 * is the exercise that separates an operator who has thought about it from one who has not.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {string} id the instrument tag
 * @param {string} mode one of {@link FAULT}
 * @returns {{ok:boolean, reason?:string}} ok, or why not
 */
export function setFault(cs, id, mode) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  if (!FAULT[mode]) {
    return fail(`${mode} is not a failure an instrument can have. Use one of: `
      + `${Object.keys(FAULT).join(', ')}.`);
  }
  c.ch.fault = mode;
  c.ch.stuckAt = mode === FAULT.STUCK ? c.ch.value : NaN;
  return { ok: true };
}

/**
 * Write the error terms directly.
 *
 * The honest use of this is to stage a specific teaching case — a pure zero shift, a pure span
 * error, a hysteresis loop with nothing else in it — so that a student can be shown one error at a
 * time before being asked to find them mixed together. Anything not named is set to zero, because
 * a "pure zero shift" that quietly still has linearity in it is not a pure zero shift and the
 * lesson it teaches is wrong.
 *
 * @param {object} cs the calibration state (mutated)
 * @param {string} id the instrument tag
 * @param {object} parts the terms, in percent of span: zeroPct, spanPct, linPct, hystPct, repPct,
 *   tempZeroPct_per10K, driftZero_pctPerYear, driftSpan_pctPerYear, lag_s
 * @returns {{ok:boolean, reason?:string}} ok, or why not
 */
export function setErrorComponents(cs, id, parts) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  if (!isRecord(parts)) return fail('Give the error terms as an object of percentages of span.');
  const p = parts;
  const ch = c.ch;
  ch.zeroPct = num(p.zeroPct, 0);
  ch.spanPct = num(p.spanPct, 0);
  ch.linPct = num(p.linPct, 0);
  ch.hystPct = Math.abs(num(p.hystPct, 0));
  ch.repPct = Math.abs(num(p.repPct, 0));
  ch.tempZeroPct_per10K = num(p.tempZeroPct_per10K, 0);
  ch.driftZero_pctPerYear = num(p.driftZero_pctPerYear, 0);
  ch.driftSpan_pctPerYear = num(p.driftSpan_pctPerYear, 0);
  ch.lag_s = Math.max(0, num(p.lag_s, 0));
  return { ok: true };
}

/**
 * Change an instrument's calibration interval.
 * @param {object} cs the calibration state (mutated)
 * @param {string} id the instrument tag
 * @param {number} interval_h the new interval, equipment hours
 * @returns {{ok:boolean, reason?:string}} ok, or why not
 */
export function setInterval(cs, id, interval_h) {
  const c = channel(cs, id);
  if (!c.ok) return c;
  if (!Number.isFinite(interval_h) || interval_h <= 0) {
    return fail('A calibration interval has to be a positive number of hours.');
  }
  c.ch.interval_h = interval_h;
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Prose and summary
// ---------------------------------------------------------------------------------------------

/**
 * A compact view of the whole register, for the UI.
 * @param {object} cs the calibration state
 * @returns {object} counts, the worst offender, and what is overdue
 */
export function calibrationSummary(cs) {
  if (!isRecord(cs) || !isRecord(cs.ch)) {
    return { ok: false, reason: 'There is no instrument register.' };
  }
  let overdue = 0;
  let faulted = 0;
  let worst = null;
  for (const inst of INSTRUMENTS) {
    const ch = cs.ch[inst.id];
    if (!ch) continue;
    if (ch.sinceCal_h > ch.interval_h) overdue += 1;
    if (ch.fault !== FAULT.NONE) faulted += 1;
    const e = Math.abs(errorPctOf(cs, inst.id));
    if (Number.isFinite(e) && (!worst || e > worst.errorPct)) {
      worst = { id: inst.id, name: inst.name, errorPct: e };
    }
  }
  return {
    ok: true,
    count: INSTRUMENTS.length,
    overdue,
    faulted,
    worst,
    certificates: cs.certificates.length,
    now_h: cs.now_h,
  };
}

/**
 * What an instrument is, in a sentence somebody would read on a hover.
 * @param {string} id the instrument tag
 * @returns {string|null} the description, or null for an unknown tag
 */
export function describeInstrument(id) {
  const inst = INSTRUMENT_BY_ID[id];
  if (!inst) return null;
  const ref = inst.spanReferenced
    ? `${inst.accuracy_pct}% of span`
    : `${inst.accuracy_pct}% of reading, carried here as a percentage of span — it is better than `
      + 'that at the top of the range and worse than it at the bottom';
  return `${inst.id}, ${inst.name}, ranged ${inst.lo} to ${inst.hi} ${inst.unit}. Reference `
    + `accuracy ${ref}; published stability ${inst.drift_pctPerYear}% of span per year; ambient `
    + `effect ${inst.tempCoef_pctPer10K}% of span per 10 K. Loop tolerance `
    + `${inst.tolerance_pct}% of span, calibration interval ${Math.round(inst.interval_h / 24)} `
    + 'days of running.';
}
