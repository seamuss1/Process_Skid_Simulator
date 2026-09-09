/**
 * src/realism/wear.js — machinery condition: what the plant is made to do, what that costs the
 * equipment, and what the equipment does about it.
 *
 * Layer: `src/realism`. Imports `core/util.js`, `process/pump.js`, `process/motor.js`,
 * `process/plant.js` and `realism/config.js`. No DOM, no `window`, no `document`, no
 * `performance`, no `Date.now()`, no `Math.random()`. Every function here is tested in Node.
 *
 * OFF BY DEFAULT, like everything else in this layer: `stepWear` returns immediately unless
 * `FEATURE.WEAR` is on, and `applyWear` on a state that has never been stepped writes back
 * exactly what it found. The rig as shipped is unchanged.
 *
 * ------------------------------------------------------------------------------------------
 * THE ARGUMENT
 *
 * A wear model that subtracts a percent an hour teaches nothing, because nothing the operator
 * does changes the answer. Everything in this file is driven by signals the plant already
 * computes about what is ACTUALLY HAPPENING to the machine:
 *
 *   DISTANCE FROM BEST-EFFICIENCY FLOW   A single-volute centrifugal pump is hydraulically
 *       balanced only near its best-efficiency flow. Away from it the impeller carries a net
 *       radial thrust (Stepanoff's radial-thrust coefficient, K ~ 0.36*(1 - (Q/Qbep)^2) for a
 *       single volute), and that thrust lands on the bearings, on the shaft deflection the seal
 *       has to tolerate, and on the recirculation cells that erode the impeller. The reliability
 *       consequence is well documented — Bloch and Geitner's pump MTBF-against-BEP curve, and
 *       Barringer's reliability work behind it, both put a machine held below half its BEP flow
 *       at three to five times the failure rate of one held on its curve. That factor, not a
 *       theoretical load exponent, is what is reproduced here.
 *
 *   CAVITATION   NPSHr is a 3%-head-drop criterion, so a pump at zero margin is already damaging
 *       itself; inception (NPSHi) is commonly 1.5 to 4 times NPSH3 for a machine of this suction
 *       specific speed (Gülich, *Centrifugal Pumps*). Erosion is at its worst in PARTIAL
 *       cavitation just past inception, where the cavity closes on the blade rather than well
 *       downstream of it. It is also cumulative and irreversible: metal that has left the
 *       impeller does not come back when the suction is fixed, and only a new impeller restores
 *       the machine. This model keeps that damage in a separate, unrecoverable account.
 *
 *   STARTS      Direct starting heats the winding with six to eight times full-load current and
 *       thermally cycles everything the shaft is bolted to. That is the whole reason a start-rate
 *       limit exists, and the damage is worse the closer together the starts are, because the
 *       winding has not cooled between them. So a start is charged as a quantum of insulation and
 *       bearing life, multiplied by how many starts that machine has taken in the last REAL hour.
 *       Short-cycling therefore shows up months later — on the compressed clock, minutes later —
 *       as a motor that fails long before its stablemate.
 *
 *   TEMPERATURE  Insulation life halves for every 10 K of extra winding temperature (Montsinger's
 *       rule, IEEE 1 / IEEE 117); grease life halves for every 10 to 15 K of bearing temperature
 *       (the standard relubrication charts); electrolytic capacitor life halves for every 10 K of
 *       core temperature (every DC-bus capacitor datasheet). Three different components, one
 *       Arrhenius exponential, and it is why the VFD's cooling fan is on this list: lose the fan
 *       and the capacitor bank ages about four times faster from that day on.
 *
 *   VIBRATION AND ALIGNMENT  ISO 10816-3 zone boundaries for a 15 kW machine on a rigid
 *       foundation are 2.3 / 4.5 / 7.1 mm/s RMS, and the plant already computes the reading.
 *       Vibration is both a symptom and a driver here, which is not double counting: a bearing
 *       that has begun to spall raises the vibration, and the raised vibration is what finishes
 *       the seal and the coupling. That positive feedback is the shape of a real failure.
 *
 *   VALVE TRAVEL   A control valve's packing wears by the distance the stem moves, so a badly
 *       tuned loop grinds out its own stiction — and the stiction then produces the limit cycle
 *       that grinds out the rest. The valve's plug and seat erode with the energy dissipated
 *       across them, which is exactly the energy the variable-speed argument is about.
 *
 * ------------------------------------------------------------------------------------------
 * WHERE THE CONSEQUENCES LAND
 *
 * On the plant the simulator already has, never on a parallel set of numbers:
 *
 *   `plant.wear[i]`            wear-ring clearance, impeller erosion and rotor condition, through
 *                              the pump's existing derate — head, efficiency, NPSHr and the
 *                              unbalance term of the vibration figure.
 *   `plant.V_m3`              a leaking mechanical seal removes real inventory from the tank, on
 *                              the REAL clock, not the compressed one. The level falls, the
 *                              make-up runs harder, and eventually the suction margin goes.
 *   `plant.foul`               strainer blinding and internal scale, which lift the strainer
 *                              differential, steepen the branch resistance and take NPSHa with
 *                              them.
 *   `plant.valveOverride.*`    packing friction as stickband and slip-jump, and a plug that has
 *                              been cut by throttling as a slower stroke.
 *   `plant.drv[i]`             a failed winding, capacitor bank or cooling fan trips the drive
 *                              through `motor.js`'s own `trip()`, so it locks out and needs a
 *                              reset exactly like any other trip.
 *
 * Three consequences have nowhere to land in the plant as it stands and are REPORTED rather than
 * applied: check-valve seat leakage, control-valve seat leakage, and bearing housing temperature.
 * They are in `condition()` and `wearSummary()` with their numbers, and the integration notes say
 * what hook each would need. A model that quietly invented a place to put them would be worse.
 *
 * ------------------------------------------------------------------------------------------
 * THE LIFE MODEL
 *
 * Every component carries a characteristic life in equipment hours and a Weibull shape factor
 * chosen for its failure physics, and consumes that life at a rate `stress` which is 1.0 for the
 * nominal duty — full speed, best-efficiency flow, healthy suction, clean lubricant, aligned.
 * Running at half BEP flow with a marginal suction consumes it at four or five. Health is what is
 * left; the hazard rate is the Weibull hazard at the life consumed so far, so a component that
 * has been abused is not merely closer to the end, it is more likely to let go TODAY.
 *
 * Shape factors, and why each is what it is:
 *   beta < 1   decreasing hazard — infant mortality. Real for power electronics, and the reason
 *              burn-in exists. The VFD power stage has it.
 *   beta ~ 1.5 rolling-element bearings. Lundberg-Palmgren gives 10/9 for ball bearings and
 *              practice puts the fitted slope at 1.1 to 1.5.
 *   beta ~ 2   a mechanism with a mild wear-out: couplings, check valves.
 *   beta ~ 2.5 erosion and abrasion, which have a definite onset and then run away.
 *   beta ~ 3   thermal ageing of insulation and of capacitor electrolyte: nothing fails early and
 *              then everything fails at once.
 * ------------------------------------------------------------------------------------------
 */

import {
  clamp, createRng, nextFloat, hydraulicPower_kW, RNG_STREAMS,
} from '../core/util.js';
import { VIB_ZONES } from '../process/pump.js';
import { DRIVE, trip } from '../process/motor.js';
import { throttleLoss_m } from '../process/plant.js';
import {
  FEATURE, isOn, rateOf, agedHours,
} from './config.js';

/** Bumped when the shape of a wear state changes in a way a saved game could not absorb. */
export const WEAR_VERSION = 1;

/** The pumps as built. `data/config.js` tags them here and this table follows it. */
const PUMP_TAGS = Object.freeze(['P-101', 'P-102']);

/** The drives as built, in the same order as the pumps. */
const DRIVE_TAGS = Object.freeze(['VFD-101', 'VFD-102']);

/**
 * Health at which a component is called finished and `remaining_h` counts down to.
 *
 * Not zero. Nobody runs a bearing to destruction on purpose: the planning decision is made when
 * the machine still has some life in it, and quoting "hours to nothing left" would give a planner
 * a date that is always too late.
 */
const REPLACE_AT = 0.10;

/** ISO 10816-3 zone A/B boundary, mm/s RMS. Above this a machine is no longer "as new". */
const VIB_GOOD_MMS = VIB_ZONES.AB;

/** Nominal relubrication interval for a 2950 rpm process-pump bearing, running hours. */
const RELUBE_H = 4000;

/** Bearing housing temperature at which grease life is quoted, C. Above it, life halves per 15 K. */
const GREASE_REF_C = 70;

/** Capacitor core temperature the catalogue life is quoted at, C. Life halves per 10 K above it. */
const CAP_REF_C = 45;

/** Window over which starts are counted for the short-cycling penalty, REAL hours. */
const START_WINDOW_H = 1;

// ---------------------------------------------------------------------------------------------
// The component register

/**
 * Build the component list for one machine — the pump, its motor, its drive and its check valve.
 *
 * @param {number} i machine index, 0 or 1
 * @returns {object[]} component records for that machine
 */
function machineComponents(i) {
  const p = PUMP_TAGS[i];
  const v = DRIVE_TAGS[i];
  const nrv = `NRV-10${i + 1}`;
  return [
    {
      id: `${p}.impeller`,
      asset: p,
      index: i,
      kind: 'IMPELLER',
      name: 'Impeller',
      unit: 'running hours',
      // A cast impeller on clean cold water is a very long-lived part; it is cavitation, not
      // hours, that kills it, and that is exactly how the stress model is weighted.
      life_h: 70000,
      weibullShape: 2.5,
      drivers: ['hours at speed', 'distance from BEP flow', 'cavitation exposure', 'viscosity'],
      symptoms: ['head falls at the same speed', 'efficiency falls', 'vibration rises'],
      effect: 'Erodes, blunting the vane tips and opening the running clearances: head and '
        + 'efficiency fall through the pump derate. Cavitation damage is IRREVERSIBLE and only a '
        + 'new impeller clears it.',
      maintenance: ['REPLACE_IMPELLER', 'OVERHAUL'],
      parts: ['IMPELLER', 'GASKET_SET'],
      modes: [
        { mode: 'EROSION', weight: 6, damage: 0.20, trips: false, message: 'impeller erosion — a step down in developed head' },
        { mode: 'VANE_SHED', weight: 1, damage: 1.00, trips: false, message: 'impeller has shed material — heavy unbalance, head collapsed' },
      ],
    },
    {
      id: `${p}.wearRings`,
      asset: p,
      index: i,
      kind: 'RINGS',
      name: 'Wear rings',
      unit: 'running hours',
      life_h: 30000,
      weibullShape: 2.2,
      drivers: ['hours at speed', 'distance from BEP flow', 'dry running', 'cavitation'],
      symptoms: ['head falls', 'power stays up', 'NPSH required rises'],
      effect: 'Clearance opens, liquid short-circuits from discharge back to suction, and the '
        + 'machine needs more suction margin than it used to. Straight into the pump derate.',
      maintenance: ['REPLACE_WEAR_RINGS', 'OVERHAUL'],
      parts: ['WEAR_RING_SET', 'GASKET_SET'],
      modes: [
        { mode: 'CLEARANCE', weight: 8, damage: 0.25, trips: false, message: 'wear rings have opened up — head down, recirculation up' },
        { mode: 'SEIZURE', weight: 1, damage: 1.00, trips: true, message: 'wear ring pick-up — the rotor has rubbed and the drive has tripped' },
      ],
    },
    {
      id: `${p}.bearingDE`,
      asset: p,
      index: i,
      kind: 'BEARING',
      name: 'Drive-end bearing',
      unit: 'running hours',
      // API 610 requires a bearing rating life of at least 25 000 hours at rated conditions.
      life_h: 25000,
      weibullShape: 1.5,
      loadShare: 1.0,
      startCost_h: 6,
      drivers: ['hours at speed', 'radial thrust off BEP', 'vibration', 'housing temperature',
        'lubricant condition', 'alignment', 'starts'],
      symptoms: ['vibration rises', 'housing temperature rises', 'bearing noise'],
      effect: 'Raises vibration and housing temperature, and the vibration then shortens the seal '
        + 'and the coupling. Feeds the rotor-condition part of the pump derate.',
      maintenance: ['REPLACE_BEARINGS', 'REGREASE', 'OVERHAUL'],
      parts: ['BEARING_6309', 'GREASE_EP2', 'GASKET_SET'],
      modes: [
        { mode: 'SPALL', weight: 7, damage: 0.30, trips: false, message: 'drive-end bearing has spalled — vibration step change' },
        { mode: 'SEIZURE', weight: 1, damage: 1.00, trips: true, message: 'drive-end bearing seized — the drive has tripped on overload' },
      ],
    },
    {
      id: `${p}.bearingNDE`,
      asset: p,
      index: i,
      kind: 'BEARING',
      name: 'Non-drive-end bearing',
      unit: 'running hours',
      life_h: 25000,
      weibullShape: 1.5,
      // The non-drive end carries less of the hydraulic radial thrust than the coupling end.
      loadShare: 0.65,
      startCost_h: 5,
      drivers: ['hours at speed', 'radial thrust off BEP', 'vibration', 'housing temperature',
        'lubricant condition', 'starts'],
      symptoms: ['vibration rises', 'housing temperature rises'],
      effect: 'As the drive-end bearing, with a smaller share of the radial load.',
      maintenance: ['REPLACE_BEARINGS', 'REGREASE', 'OVERHAUL'],
      parts: ['BEARING_6209', 'GREASE_EP2', 'GASKET_SET'],
      modes: [
        { mode: 'SPALL', weight: 7, damage: 0.30, trips: false, message: 'non-drive-end bearing has spalled — vibration step change' },
        { mode: 'SEIZURE', weight: 1, damage: 1.00, trips: true, message: 'non-drive-end bearing seized — the drive has tripped' },
      ],
    },
    {
      id: `${p}.seal`,
      asset: p,
      index: i,
      kind: 'SEAL',
      name: 'Mechanical seal',
      unit: 'running hours',
      // API 682 asks for a seal design life of 25 000 hours — three years of uninterrupted duty.
      life_h: 25000,
      weibullShape: 1.8,
      startCost_h: 8,
      drivers: ['dry running', 'cavitation', 'casing temperature', 'vibration',
        'distance from BEP flow', 'starts'],
      symptoms: ['weepage at the gland', 'tank level falling with no draw', 'seal chamber noise'],
      effect: 'Leaks. A real leak: inventory leaves the tank, the make-up works harder, and left '
        + 'alone the suction margin goes with the level.',
      maintenance: ['REPLACE_SEAL', 'OVERHAUL'],
      parts: ['SEAL_CARTRIDGE', 'ORING_SET'],
      modes: [
        { mode: 'WEEP', weight: 6, damage: 0.25, trips: false, message: 'seal faces have opened — a visible weep at the gland' },
        { mode: 'BLOWOUT', weight: 2, damage: 1.00, trips: false, message: 'mechanical seal has blown — the pump is throwing liquid at the floor' },
      ],
    },
    {
      id: `${p}.coupling`,
      asset: p,
      index: i,
      kind: 'COUPLING',
      name: 'Coupling element',
      unit: 'running hours',
      life_h: 40000,
      weibullShape: 2.0,
      startCost_h: 10,
      drivers: ['torque', 'starts', 'alignment', 'vibration'],
      symptoms: ['vibration at twice running speed', 'rubber dust under the guard'],
      effect: 'Degrades alignment quality, which then loads the bearings and the seal.',
      maintenance: ['REPLACE_COUPLING', 'ALIGN', 'OVERHAUL'],
      parts: ['COUPLING_ELEMENT'],
      modes: [
        { mode: 'ELEMENT_WEAR', weight: 8, damage: 0.30, trips: false, message: 'coupling element worn — alignment has gone off' },
        { mode: 'PARTED', weight: 1, damage: 1.00, trips: true, message: 'coupling has parted — the motor is spinning and the pump is not' },
      ],
    },
    {
      id: `${p}.motorWinding`,
      asset: p,
      index: i,
      kind: 'MOTOR_WINDING',
      name: 'Motor winding insulation',
      unit: 'energised hours',
      life_h: 100000,
      // Thermal ageing: nothing fails early and then everything fails together.
      weibullShape: 3.0,
      // A direct start heats the winding with six to eight times full-load current. Twenty
      // equivalent hours per start is the ORDER the start-rate limit exists to protect, and the
      // penalty for closely spaced starts multiplies it — see `stressOf`.
      startCost_h: 20,
      drivers: ['thermal capacity used', 'starts', 'starts per hour', 'load'],
      symptoms: ['thermal capacity climbing at the same load', 'trips on overload'],
      effect: 'Fails to earth and the drive trips. Nothing gradual is visible on the faceplate '
        + 'first, which is why the thermal model is the only warning there is.',
      maintenance: ['REWIND_MOTOR'],
      parts: ['MOTOR_REWIND'],
      modes: [
        { mode: 'TURN_FAULT', weight: 3, damage: 0.35, trips: false, message: 'motor winding turn fault — current unbalance and more heat for the same load' },
        { mode: 'EARTH_FAULT', weight: 4, damage: 1.00, trips: true, message: 'motor winding insulation failed to earth — the drive has tripped' },
      ],
    },
    {
      id: `${p}.motorBearing`,
      asset: p,
      index: i,
      kind: 'MOTOR_BEARING',
      name: 'Motor bearings',
      unit: 'energised hours',
      life_h: 30000,
      weibullShape: 1.5,
      startCost_h: 4,
      drivers: ['hours at speed', 'vibration', 'lubricant condition', 'starts'],
      symptoms: ['vibration rises', 'motor end-bracket noise'],
      effect: 'Vibration, and eventually a locked rotor that trips the drive.',
      maintenance: ['REPLACE_MOTOR_BEARINGS', 'REGREASE'],
      parts: ['BEARING_6208', 'GREASE_EP2'],
      modes: [
        { mode: 'SPALL', weight: 8, damage: 0.30, trips: false, message: 'motor bearing spalled — vibration up at the non-drive end' },
        { mode: 'SEIZURE', weight: 1, damage: 1.00, trips: true, message: 'motor bearing seized — the drive has tripped' },
      ],
    },
    {
      id: `${v}.fan`,
      asset: v,
      index: i,
      kind: 'VFD_FAN',
      name: 'Drive cooling fan',
      unit: 'energised hours',
      life_h: 40000,
      weibullShape: 1.5,
      drivers: ['energised hours', 'ambient temperature', 'load'],
      symptoms: ['heatsink temperature rising', 'drive derating at full load'],
      effect: 'Loses the heatsink. The capacitor bank then ages about four times faster, which is '
        + 'the cheapest failure on this list and the most expensive one to ignore.',
      maintenance: ['REPLACE_VFD_FAN'],
      parts: ['VFD_FAN'],
      modes: [
        { mode: 'BEARING_NOISE', weight: 6, damage: 0.40, trips: false, message: 'drive cooling fan noisy and slowing — heatsink temperature rising' },
        { mode: 'STALLED', weight: 3, damage: 1.00, trips: false, message: 'drive cooling fan stalled — the capacitor bank is now cooking' },
      ],
    },
    {
      id: `${v}.caps`,
      asset: v,
      index: i,
      kind: 'VFD_CAPS',
      name: 'DC-bus capacitor bank',
      unit: 'energised hours',
      // Catalogue endurance for an aluminium electrolytic bus capacitor, quoted at CAP_REF_C.
      life_h: 60000,
      weibullShape: 3.0,
      drivers: ['energised hours', 'internal temperature', 'cooling fan condition', 'load'],
      symptoms: ['bus ripple rising', 'drive trips on undervoltage during load steps'],
      effect: 'Bus ripple rises until the drive trips on a load step. Electrolyte evaporation, so '
        + 'the Arrhenius rule applies: ten degrees hotter is half the life.',
      maintenance: ['REPLACE_VFD_CAPS', 'REPLACE_VFD'],
      parts: ['VFD_CAP_KIT'],
      modes: [
        { mode: 'RIPPLE', weight: 5, damage: 0.35, trips: false, message: 'DC bus ripple high — the capacitor bank is drying out' },
        { mode: 'BUS_FAULT', weight: 3, damage: 1.00, trips: true, message: 'DC bus capacitor failure — the drive has tripped and will not reset' },
      ],
    },
    {
      id: `${v}.power`,
      asset: v,
      index: i,
      kind: 'VFD_POWER',
      name: 'Drive power stage',
      unit: 'energised hours',
      life_h: 200000,
      // Below 1: a DECREASING hazard. Power electronics fail early or they fail late, and the
      // whole point of a factory burn-in is to spend the early part of this curve in the works
      // rather than on site.
      weibullShape: 0.85,
      startCost_h: 2,
      drivers: ['energised hours', 'thermal cycling from starts', 'internal temperature'],
      symptoms: ['nuisance trips with no process cause'],
      effect: 'Trips the drive, sometimes repeatedly before it finally stays down.',
      maintenance: ['REPLACE_VFD'],
      parts: ['VFD_UNIT'],
      modes: [
        { mode: 'NUISANCE_TRIP', weight: 5, damage: 0.15, trips: true, message: 'drive tripped with no process cause — the power stage is marginal' },
        { mode: 'IGBT_FAILURE', weight: 2, damage: 1.00, trips: true, message: 'drive power stage failed — the machine is unavailable until it is replaced' },
      ],
    },
    {
      id: `${nrv}.disc`,
      asset: nrv,
      index: i,
      kind: 'NRV',
      name: 'Check valve disc and seat',
      unit: 'operating cycles',
      life_h: 30000,
      weibullShape: 1.6,
      startCost_h: 25,
      drivers: ['start and stop cycles', 'flow velocity', 'reverse-flow slam'],
      symptoms: ['header bleeds back when the set is stopped', 'slam on stopping'],
      effect: 'Seat leakage: the header bleeds back through a stopped machine. REPORTED only — '
        + 'the plant has no per-branch check-valve override to land it on yet.',
      maintenance: ['REPLACE_NRV'],
      parts: ['NRV_KIT', 'GASKET_SET'],
      modes: [
        { mode: 'SEAT_LEAK', weight: 7, damage: 0.30, trips: false, message: 'check valve not seating — the header bleeds back when this machine stops' },
        { mode: 'STUCK_SHUT', weight: 2, damage: 1.00, trips: false, message: 'check valve stuck shut — this machine is running against a closed valve' },
      ],
    },
  ];
}

/**
 * The components that belong to the rig rather than to one machine: the two control valves, the
 * suction strainer and the pipework itself.
 *
 * @returns {object[]} the plant-wide component records
 */
function plantComponents() {
  return [
    {
      id: 'PCV-101.packing',
      asset: 'PCV-101',
      index: -1,
      kind: 'VALVE_PACKING',
      valve: 'pcv',
      name: 'Throttle valve packing',
      unit: 'stem travel, full strokes',
      life_h: 20000,
      weibullShape: 2.0,
      drivers: ['stem travel', 'reversals', 'gland temperature'],
      symptoms: ['stiction', 'a limit cycle that was not there last month', 'gland weep'],
      effect: 'Stem friction — stickband and slip-jump, straight onto the valve override the '
        + 'plant already models. A loop that cycles wears out its own valve and then blames the '
        + 'tuning.',
      maintenance: ['REPACK_VALVE'],
      parts: ['GLAND_PACKING', 'ORING_SET'],
      modes: [
        { mode: 'STICTION', weight: 8, damage: 0.30, trips: false, message: 'PCV-101 packing dried out — the stem is sticking' },
        { mode: 'GLAND_LEAK', weight: 2, damage: 0.60, trips: false, message: 'PCV-101 gland is weeping and has been overtightened to stop it' },
      ],
    },
    {
      id: 'PCV-101.trim',
      asset: 'PCV-101',
      index: -1,
      kind: 'VALVE_TRIM',
      valve: 'pcv',
      name: 'Throttle valve plug and seat',
      unit: 'dissipated energy hours',
      life_h: 45000,
      weibullShape: 2.5,
      drivers: ['energy dissipated across the valve', 'travel near the seat', 'flashing'],
      symptoms: ['the valve has to close further for the same pressure', 'seat leakage'],
      effect: 'Wire-drawing across the seat. Lands as a slower, sticking stroke; the seat leakage '
        + 'itself is REPORTED only — the valve record is frozen and has no leakage override.',
      maintenance: ['REPLACE_VALVE_TRIM'],
      parts: ['VALVE_TRIM_SET', 'GASKET_SET'],
      modes: [
        { mode: 'WIRE_DRAWN', weight: 8, damage: 0.35, trips: false, message: 'PCV-101 seat wire-drawn — it now leaks with the stem on its seat' },
        { mode: 'PLUG_DAMAGE', weight: 2, damage: 0.80, trips: false, message: 'PCV-101 plug badly cut — the installed characteristic has changed shape' },
      ],
    },
    {
      id: 'FCV-101.packing',
      asset: 'FCV-101',
      index: -1,
      kind: 'VALVE_PACKING',
      valve: 'fcv',
      name: 'Demand valve packing',
      unit: 'stem travel, full strokes',
      life_h: 20000,
      weibullShape: 2.0,
      drivers: ['stem travel', 'reversals'],
      symptoms: ['the load stops arriving where it was asked for'],
      effect: 'Stem friction on the LOAD valve, which turns a clean disturbance into a ragged one.',
      maintenance: ['REPACK_VALVE'],
      parts: ['GLAND_PACKING', 'ORING_SET'],
      modes: [
        { mode: 'STICTION', weight: 9, damage: 0.30, trips: false, message: 'FCV-101 packing stiff — the demand valve is sticking' },
        { mode: 'GLAND_LEAK', weight: 1, damage: 0.60, trips: false, message: 'FCV-101 gland weeping' },
      ],
    },
    {
      id: 'STR-101.element',
      asset: 'STR-101',
      index: -1,
      kind: 'STRAINER',
      name: 'Suction strainer element',
      unit: 'throughput hours',
      life_h: 6000,
      weibullShape: 2.2,
      drivers: ['throughput', 'water chemistry', 'chemical dosing'],
      symptoms: ['strainer differential rising', 'NPSH margin falling', 'cavitation at high flow'],
      effect: 'Blinds. Straight onto `plant.foul`: the strainer differential rises, the suction '
        + 'margin falls, and a duty that was comfortable last week starts to cavitate.',
      maintenance: ['CLEAN_STRAINER', 'REPLACE_STRAINER'],
      parts: ['STRAINER_ELEMENT'],
      modes: [
        { mode: 'BLINDED', weight: 9, damage: 0.35, trips: false, message: 'suction strainer blinding — NPSH margin is going' },
        { mode: 'COLLAPSED', weight: 1, damage: 1.00, trips: false, message: 'suction strainer element has collapsed — debris is now going through the pumps' },
      ],
    },
    {
      id: 'PL-101.scale',
      asset: '150-PL-101',
      index: -1,
      kind: 'SCALE',
      name: 'Internal scale, suction and pump branches',
      unit: 'throughput hours',
      life_h: 40000,
      weibullShape: 2.5,
      drivers: ['throughput', 'water chemistry', 'temperature', 'chemical dosing'],
      symptoms: ['the system curve steepens', 'the same flow costs more speed than it did'],
      effect: 'Roughens and narrows the branch, steepening the system curve. Cleaning the strainer '
        + 'does NOT touch it: a chemical clean recovers most of it and never all of it.',
      maintenance: ['DESCALE'],
      parts: ['CLEANING_CHEMICAL'],
      modes: [
        { mode: 'DEPOSIT', weight: 10, damage: 0.20, trips: false, message: 'scale build-up in the suction pipework — the system curve has steepened' },
      ],
    },
  ];
}

/**
 * Every component on the rig: fourteen per-machine records across two machines, plus five that
 * belong to the plant. Frozen, because it is a register of what was installed.
 */
export const COMPONENTS = Object.freeze(
  [...machineComponents(0), ...machineComponents(1), ...plantComponents()]
    .map((c) => Object.freeze({
      ...c,
      drivers: Object.freeze(c.drivers),
      symptoms: Object.freeze(c.symptoms),
      maintenance: Object.freeze(c.maintenance),
      parts: Object.freeze(c.parts),
      modes: Object.freeze(c.modes.map((m) => Object.freeze(m))),
    })),
);

/** Components by id, so nothing in the hot path is a linear scan. */
const BY_ID = Object.freeze(Object.fromEntries(COMPONENTS.map((c) => [c.id, c])));

/** Component ids grouped by asset tag, for `assetHealth`. */
const BY_ASSET = (() => {
  const m = {};
  for (const c of COMPONENTS) (m[c.asset] = m[c.asset] || []).push(c.id);
  for (const k of Object.keys(m)) Object.freeze(m[k]);
  return Object.freeze(m);
})();

// ---------------------------------------------------------------------------------------------
// Maintenance

/**
 * What a job actually restores, and no more.
 *
 * `restores` is a map from component id suffix to the fraction of consumed life the job gives
 * back. Replacing a seal does not fix a bearing; cleaning a strainer does not undo scale; a
 * chemical descale recovers most of the deposit and never all of it, because some of what scale
 * does to a pipe wall is permanent roughening. That asymmetry is the whole lesson of the table.
 */
export const TASKS = Object.freeze([
  Object.freeze({
    id: 'REPLACE_SEAL',
    name: 'Replace mechanical seal',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 6,
    restores: Object.freeze({ seal: 1 }),
    parts: Object.freeze(['SEAL_CARTRIDGE', 'ORING_SET']),
    note: 'A new cartridge seal. It does nothing at all for the bearing that has been shaking it '
      + 'to pieces, which is why a seal that comes back in six weeks is a bearing problem.',
  }),
  Object.freeze({
    id: 'REPLACE_BEARINGS',
    name: 'Replace pump bearings',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 10,
    restores: Object.freeze({ bearingDE: 1, bearingNDE: 1 }),
    parts: Object.freeze(['BEARING_6309', 'BEARING_6209', 'GREASE_EP2', 'GASKET_SET']),
    note: 'Both ends together — nobody splits a pump to change one bearing. Resets the '
      + 'lubricant clock with them.',
  }),
  Object.freeze({
    id: 'REGREASE',
    name: 'Relubricate bearings',
    scope: 'PUMP',
    requiresStop: false,
    duration_h: 0.5,
    restores: Object.freeze({}),
    parts: Object.freeze(['GREASE_EP2']),
    note: 'Restores no damage whatsoever. What it does is reset the lubricant clock, and a '
      + 'bearing running on grease that is a thousand hours past its interval is consuming life '
      + 'at half as much again.',
  }),
  Object.freeze({
    id: 'REPLACE_IMPELLER',
    name: 'Replace impeller',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 12,
    restores: Object.freeze({ impeller: 1 }),
    parts: Object.freeze(['IMPELLER', 'GASKET_SET']),
    note: 'The only thing that clears cavitation damage, because the metal is gone.',
  }),
  Object.freeze({
    id: 'REPLACE_WEAR_RINGS',
    name: 'Replace wear rings',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 10,
    restores: Object.freeze({ wearRings: 1 }),
    parts: Object.freeze(['WEAR_RING_SET', 'GASKET_SET']),
    note: 'Recovers the head and efficiency the clearance was costing. Not the impeller.',
  }),
  Object.freeze({
    id: 'REPLACE_COUPLING',
    name: 'Replace coupling element',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 3,
    restores: Object.freeze({ coupling: 1 }),
    parts: Object.freeze(['COUPLING_ELEMENT']),
    note: 'Includes a rough alignment check. A proper laser alignment is its own job.',
  }),
  Object.freeze({
    id: 'ALIGN',
    name: 'Laser align the set',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 4,
    restores: Object.freeze({}),
    parts: Object.freeze([]),
    note: 'Restores no consumed life and buys a great deal of it: misalignment is a multiplier on '
      + 'the bearings, the seal and the coupling all at once.',
  }),
  Object.freeze({
    id: 'REWIND_MOTOR',
    name: 'Rewind motor',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 72,
    restores: Object.freeze({ motorWinding: 1 }),
    parts: Object.freeze(['MOTOR_REWIND']),
    note: 'A rewound motor is usually a percentage point less efficient than it was. It is still '
      + 'cheaper than the machine.',
  }),
  Object.freeze({
    id: 'REPLACE_MOTOR_BEARINGS',
    name: 'Replace motor bearings',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 6,
    restores: Object.freeze({ motorBearing: 1 }),
    parts: Object.freeze(['BEARING_6208', 'GREASE_EP2']),
    note: 'The motor end. Nothing to do with the pump bearings.',
  }),
  Object.freeze({
    id: 'OVERHAUL',
    name: 'Full pump overhaul',
    scope: 'PUMP',
    requiresStop: true,
    duration_h: 40,
    restores: Object.freeze({
      impeller: 1, wearRings: 1, bearingDE: 1, bearingNDE: 1, seal: 1, coupling: 1,
    }),
    parts: Object.freeze([
      'IMPELLER', 'WEAR_RING_SET', 'BEARING_6309', 'BEARING_6209', 'SEAL_CARTRIDGE',
      'COUPLING_ELEMENT', 'GASKET_SET', 'ORING_SET', 'GREASE_EP2',
    ]),
    note: 'The pump, back to as-new. Not the motor, not the drive, and not the pipework it is '
      + 'bolted to.',
  }),
  Object.freeze({
    id: 'REPLACE_VFD_FAN',
    name: 'Replace drive cooling fan',
    scope: 'DRIVE',
    requiresStop: true,
    duration_h: 1,
    restores: Object.freeze({ fan: 1 }),
    parts: Object.freeze(['VFD_FAN']),
    note: 'Twenty minutes and the price of a meal. It does not give the capacitors back the life '
      + 'they lost while it was stalled.',
  }),
  Object.freeze({
    id: 'REPLACE_VFD_CAPS',
    name: 'Replace DC-bus capacitors',
    scope: 'DRIVE',
    requiresStop: true,
    duration_h: 8,
    restores: Object.freeze({ caps: 1 }),
    parts: Object.freeze(['VFD_CAP_KIT']),
    note: 'A recognised mid-life overhaul on a drive that is otherwise sound.',
  }),
  Object.freeze({
    id: 'REPLACE_VFD',
    name: 'Replace the drive',
    scope: 'DRIVE',
    requiresStop: true,
    duration_h: 16,
    restores: Object.freeze({ fan: 1, caps: 1, power: 1 }),
    parts: Object.freeze(['VFD_UNIT']),
    note: 'A new drive. Also the only thing that clears a failed power stage.',
  }),
  Object.freeze({
    id: 'REPLACE_NRV',
    name: 'Overhaul check valve',
    scope: 'NRV',
    requiresStop: true,
    duration_h: 4,
    restores: Object.freeze({ disc: 1 }),
    parts: Object.freeze(['NRV_KIT', 'GASKET_SET']),
    note: 'New disc, spring and seat.',
  }),
  Object.freeze({
    id: 'REPACK_VALVE',
    name: 'Repack valve gland',
    scope: 'VALVE',
    requiresStop: false,
    duration_h: 3,
    restores: Object.freeze({ packing: 1 }),
    parts: Object.freeze(['GLAND_PACKING', 'ORING_SET']),
    note: 'Clears the stiction. Does not touch the plug and seat, so a valve that still has to '
      + 'close hard to hold pressure will be back.',
  }),
  Object.freeze({
    id: 'REPLACE_VALVE_TRIM',
    name: 'Replace valve trim',
    scope: 'VALVE',
    requiresStop: true,
    duration_h: 8,
    restores: Object.freeze({ trim: 1 }),
    parts: Object.freeze(['VALVE_TRIM_SET', 'GASKET_SET']),
    note: 'New plug, seat and cage. The line has to come out of service for it.',
  }),
  Object.freeze({
    id: 'CLEAN_STRAINER',
    name: 'Clean suction strainer',
    scope: 'STRAINER',
    requiresStop: true,
    duration_h: 1,
    restores: Object.freeze({ element: 1 }),
    parts: Object.freeze([]),
    note: 'Pull the basket, wash it, put it back. It does NOTHING for the scale in the pipework, '
      + 'and an operator who cleans the strainer for the third time this month while the branch '
      + 'quietly scales up is treating the symptom.',
  }),
  Object.freeze({
    id: 'REPLACE_STRAINER',
    name: 'Replace strainer element',
    scope: 'STRAINER',
    requiresStop: true,
    duration_h: 1.5,
    restores: Object.freeze({ element: 1 }),
    parts: Object.freeze(['STRAINER_ELEMENT']),
    note: 'For a basket that has been cleaned too many times, or collapsed.',
  }),
  Object.freeze({
    id: 'DESCALE',
    name: 'Chemically clean the pipework',
    scope: 'PIPE',
    requiresStop: true,
    duration_h: 24,
    // Deliberately not 1. An acid clean lifts the deposit and leaves the wall rougher than it was
    // when it was new, and no amount of chemistry gives that back.
    restores: Object.freeze({ scale: 0.75 }),
    parts: Object.freeze(['CLEANING_CHEMICAL']),
    note: 'Recovers most of the deposit and none of the roughening underneath it.',
  }),
]);

/** Tasks by id. */
const TASK_BY_ID = Object.freeze(Object.fromEntries(TASKS.map((t) => [t.id, t])));

// ---------------------------------------------------------------------------------------------
// Guards. Nothing here throws; a bad argument comes back as a defined value or a sentence.

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
 * Read element `i` of something that may be an array, a typed array, or missing.
 * @param {*} arr the container
 * @param {number} i the index
 * @param {number} def the fallback
 * @returns {number} a finite number
 */
function at(arr, i, def) {
  if (!arr || typeof arr.length !== 'number' || i < 0 || i >= arr.length) return def;
  return num(arr[i], def);
}

/**
 * @param {string} reason human-readable refusal, shown verbatim to an operator
 * @returns {{ok:false, reason:string}} the refusal
 */
function fail(reason) {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------------------------
// State

/**
 * Allocate the mutable wear state for a rig.
 *
 * The generator is INJECTED, so a maintenance history is reproducible from a seed and a test can
 * hand in a stub. When none is supplied, a seeded xorshift stream from `core/util.js` is built
 * from the config's own seed on the `PUMP_WEAR` channel — never `Math.random()`, because a plant
 * that fails differently on every reload cannot be taught from.
 *
 * @param {object} [config] the frozen sim config, for the seed and the machine count
 * @param {() => number} [rng] a generator returning samples in [0, 1)
 * @returns {object} the mutable wear state
 */
export function createWearState(config, rng) {
  const seed = isRecord(config) ? num(config.seed, 0x50494431) : 0x50494431;
  const fallback = createRng((seed | 0) ^ RNG_STREAMS.PUMP_WEAR);
  const draw = typeof rng === 'function' ? rng : () => nextFloat(fallback);

  const comp = {};
  for (const c of COMPONENTS) {
    comp[c.id] = {
      id: c.id,
      /** Effective life consumed, equipment hours. Health is what is left of `life_h`. */
      used_h: 0,
      /** The part of `used_h` that no maintenance task can give back. */
      perm_h: 0,
      /** Stress on the last step: 1.0 is the nominal duty. */
      stress: 0,
      /** Life fraction consumed per equipment hour on the last step, for `remaining_h`. */
      rate_perH: 0,
      /** The failure mode this component has suffered, or null. */
      failed: null,
      /** The message that came with it. */
      message: null,
      /** Equipment hours at which it last failed. */
      failedAt_h: NaN,
      /** How many times this component has been renewed. */
      renewals: 0,
      /** Equipment hours at the last renewal. */
      renewedAt_h: 0,
    };
  }

  const machines = [];
  for (let i = 0; i < PUMP_TAGS.length; i += 1) {
    machines.push({
      tag: PUMP_TAGS[i],
      /** Equipment hours this machine has actually turned. */
      run_h: 0,
      /** Equipment hours it has run with the suction below inception. */
      cav_h: 0,
      /** Equipment hours it has run with effectively no throughflow. */
      dry_h: 0,
      /** Running hours since the bearings were last greased. */
      lube_h: 0,
      /** Alignment quality, 1 (laser aligned) .. 0 (nobody has looked at it in years). */
      align: 1,
      /** The drive's cumulative start count as of the last step, to difference against. */
      lastStarts: NaN,
      /** Starts per REAL hour, exponentially windowed. The short-cycling penalty reads this. */
      startRate_perH: 0,
      /** Bearing housing temperature, C — this layer's own reading; the plant has none. */
      bearingT_C: NaN,
      /** Condition-monitoring vibration including what this layer knows and the plant does not. */
      vib_mms: 0,
      /** Seal leakage, m3/h, on the REAL clock. */
      leak_m3h: 0,
    });
  }

  return {
    version: WEAR_VERSION,
    rng: draw,
    /** Equipment hours since this state was created. The compressed clock. */
    clock_h: 0,
    /** Real seconds of simulation this state has seen. */
    real_s: 0,
    comp,
    machines,
    valves: {
      pcv: { travel: 0, reversals: 0, lastX: NaN, lastDir: 0, dissipated_kWh: 0 },
      fcv: { travel: 0, reversals: 0, lastX: NaN, lastDir: 0, dissipated_kWh: 0 },
    },
    /** Cumulative liquid lost through seals, m3. */
    leaked_m3: 0,
    /** Failures raised so far, oldest first: {at_h, componentId, mode, message}. */
    events: [],
    /**
     * What this layer last wrote onto the plant, and the baseline underneath it.
     *
     * The plant's own fields have other owners — `stepPlant` accumulates `wear` itself, and the
     * operator can set `foul` and the valve stickband from the disturbance panel. Overwriting
     * them would silently throw those away, so every push records what it wrote, and the next
     * push absorbs anything that changed in between into the baseline. The visible consequence is
     * that `applyWear` on a fresh state writes back exactly what it found: a no-op.
     */
    overlay: {
      wear: machines.map(() => ({ base: 0, written: NaN })),
      foul: { base: 0, written: NaN },
      pcvStick: { base: 0, written: NaN },
      fcvStick: { base: 0, written: NaN },
      pcvStroke: { base: 0, written: NaN },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the plant

/**
 * The radial-thrust and reliability multiplier for running away from the best-efficiency flow.
 *
 * A single-volute pump is hydraulically balanced only at its BEP; either side of it the impeller
 * carries a net radial load and develops recirculation cells at the eye and the discharge. The
 * shape below is fitted to the published reliability-against-BEP relation rather than to a load
 * exponent: about 1 on the curve, about 2 at 70% or 130%, about 3 at 40%, about 4 at 25%. Worse
 * to the LEFT, because suction recirculation is more destructive than discharge recirculation.
 *
 * @param {number} x flow as a fraction of the best-efficiency flow at this speed
 * @returns {number} a multiplier on the rate at which life is consumed, >= 1
 */
function offBepFactor(x) {
  if (!Number.isFinite(x)) return 1;
  const d = x - 1;
  return 1 + (d < 0 ? 5.5 * d * d : 3.0 * d * d);
}

/**
 * How hard this machine's suction is working it, 0 (comfortable) upward.
 *
 * Two terms, because two different things are happening. Below about 1.5 times NPSHr the machine
 * is past inception and bubbles are collapsing on the blade even though the head has not moved —
 * this is where erosion is at its worst and where the operator has no indication at all. Below
 * NPSHr the head itself starts to go, and the plant's own cavitation multiplier says by how much.
 *
 * @param {number} npsha_m NPSH available, m
 * @param {number} npshr_m NPSH required (the 3% criterion), m
 * @param {number} cav the plant's cavitation head multiplier, 1 when healthy
 * @returns {number} a cavitation exposure index, 0 when the suction is comfortable
 */
function cavIndex(npsha_m, npshr_m, cav) {
  let idx = 0;
  if (npshr_m > 0.01) {
    const m = npsha_m / npshr_m;
    if (m < 1.5) {
      const t = (1.5 - clamp(m, 0, 1.5)) / 1.5;
      idx += t * t;
    }
  }
  if (cav < 1) idx += 2 * (1 - cav);
  return idx;
}

/**
 * Sample everything this scan needs to know about one machine.
 *
 * @param {object} ws the wear state
 * @param {object} ctx the sim context
 * @param {number} i machine index
 * @returns {object} a duty sample
 */
function machineSample(ws, ctx, i) {
  const config = ctx.config || {};
  const plant = ctx.plant || {};
  const drv = (plant.drv && plant.drv[i]) || {};
  const pump = (config.pumps && config.pumps[i]) || { Qbep_m3h: 45 };
  const drive = (config.drives && config.drives[i]) || { Trated_Nm: 48, motor_kW: 15 };
  const m = ws.machines[i];
  const ambient = num(config.site && config.site.ambient_C, 20);

  const s = clamp(num(drv.n_pct, 0) / 100, 0, 1.2);
  const running = s > 0.05;
  const Q = at(plant.Q_m3h, i, 0);
  const Qbep = num(pump.Qbep_m3h, 45);
  // Referred to speed, so a machine at half speed and half flow is still AT its best-efficiency
  // point — which is the whole reason variable speed is kinder to a pump than throttling.
  const x = running && Qbep > 0 ? Q / (s * Qbep) : 1;
  const cav = at(plant.cav, i, 1);
  const idx = cavIndex(at(plant.npsha_m, i, 99), at(plant.npshr_m, i, 0), cav);
  const Tcasing = at(plant.Tcasing_C, i, ambient);
  const torqueFrac = num(drive.Trated_Nm, 0) > 0
    ? Math.abs(num(drv.torque_Nm, 0)) / drive.Trated_Nm : 0;

  // Bearing housing temperature. The plant models the casing but not the bearing, so this is
  // built here: ambient, plus what conducts back from the casing, plus the bearing's own friction
  // rising with speed, load and its own damage. Around 42 C on a healthy machine at full speed in
  // a 20 C room, which is what a housing actually reads; API 610 practice alarms at 82 C.
  const bearingDamage = Math.max(
    1 - healthOf(ws, `${PUMP_TAGS[i]}.bearingDE`),
    1 - healthOf(ws, `${PUMP_TAGS[i]}.bearingNDE`),
  );
  const bearingT = ambient + 0.25 * Math.max(0, Tcasing - ambient)
    + (running ? 22 * s * s * (0.7 + 0.5 * torqueFrac) * (1 + 1.8 * bearingDamage) : 0);

  // The condition-monitoring reading: what the plant computes, plus the contributions this layer
  // knows about and the plant's vibration function has no way to see — a spalling bearing, a worn
  // coupling and an alignment nobody has checked.
  const couplingDamage = 1 - healthOf(ws, `${PUMP_TAGS[i]}.coupling`);
  const vibPlant = at(plant.vib_mms, i, 0);
  const vib = vibPlant + (running
    ? s * s * (6.0 * bearingDamage * bearingDamage + 3.0 * couplingDamage * couplingDamage
      + 4.0 * (1 - m.align) * (1 - m.align))
    : 0);

  return {
    i,
    tag: PUMP_TAGS[i],
    driveTag: DRIVE_TAGS[i],
    s,
    running,
    energised: drv.state === DRIVE.RUNNING || drv.state === DRIVE.STARTING
      || drv.state === DRIVE.STOPPING,
    Q,
    x,
    cav,
    cavIdx: idx,
    // Dry running: turning with effectively nothing going through it. A mechanical seal run dry
    // fails in minutes, which is why this is the most violent multiplier in the file.
    dry: running && Q < 0.02 * Qbep,
    vib,
    vibPlant,
    Tcasing,
    bearingT,
    ambient,
    P_kW: at(plant.P_kW, i, 0),
    loadFrac: num(drive.motor_kW, 15) > 0 ? at(plant.P_kW, i, 0) / drive.motor_kW : 0,
    torqueFrac,
    thermal_pct: num(drv.thermal_pct, 0),
    starts: num(drv.starts, 0),
    startRate_perH: m.startRate_perH,
    align: m.align,
    lube_h: m.lube_h,
    sg: num(plant.fluid && plant.fluid.rho_kgm3, 998.2) / 998.2,
    nu_cSt: num(plant.fluid && plant.fluid.nu_cSt, 1),
  };
}

/**
 * Sample the rig-wide duty: the two control valves and what is going through the pipework.
 *
 * @param {object} ws the wear state
 * @param {object} ctx the sim context
 * @param {number} dtReal_h the scan interval in REAL hours
 * @returns {object} a plant-wide duty sample
 */
function plantSample(ws, ctx, dtReal_h) {
  const config = ctx.config || {};
  const plant = ctx.plant || {};
  const Qref = num(config.pumps && config.pumps[0] && config.pumps[0].Qbep_m3h, 45);
  const Qtot = num(plant.Qtotal_m3h, 0);

  const out = {
    Qtot,
    throughput: Qref > 0 ? Math.max(0, Qtot) / Qref : 0,
    T_C: num(plant.T_tank_C, 20),
    ambient: num(config.site && config.site.ambient_C, 20),
    valve: {},
    // Head burned across the throttle valve, and the power that goes with it. This is the number
    // the variable-speed argument is about, and it is also what cuts the plug out of the valve.
    pcvLoss_m: 0,
    pcvDissipated_kW: 0,
    // Whatever the consumables layer says the chemical dosing is doing to the fouling rate. Read
    // as a plain number rather than imported, so this module has no dependency on a sibling that
    // may not be present.
    foulingMul: 1,
  };

  const rl = ctx.realism;
  if (isRecord(rl) && Number.isFinite(rl.foulingMul)) out.foulingMul = clamp(rl.foulingMul, 0, 10);

  for (const key of ['pcv', 'fcv']) {
    const v = ws.valves[key];
    const stem = plant[key];
    const x = clamp(num(stem && stem.x, 0), 0, 1);
    let moved = 0;
    if (Number.isFinite(v.lastX)) {
      moved = Math.abs(x - v.lastX);
      const dir = Math.sign(x - v.lastX);
      // A reversal is where the packing does its damage and where stiction shows itself: the
      // stem has to break away again every time the loop changes its mind.
      if (dir !== 0 && v.lastDir !== 0 && dir !== v.lastDir) v.reversals += 1;
      if (dir !== 0) v.lastDir = dir;
    }
    v.lastX = x;
    v.travel += moved;
    out.valve[key] = {
      x,
      moved,
      // Full strokes per REAL hour. A well-behaved loop is a fraction of one; a valve in a limit
      // cycle is tens.
      strokeRate_perH: dtReal_h > 0 ? moved / dtReal_h : 0,
    };
  }

  if (typeof throttleLoss_m === 'function' && config.pcvValve && plant.pcv) {
    try {
      out.pcvLoss_m = Math.max(0, throttleLoss_m(config, plant));
      out.pcvDissipated_kW = hydraulicPower_kW(
        Math.max(0, num(plant.Qdemand_m3h, 0)), out.pcvLoss_m,
        num(plant.fluid && plant.fluid.rho_kgm3, 998.2),
      );
    } catch (e) {
      out.pcvLoss_m = 0;
      out.pcvDissipated_kW = 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stress: what one component's duty is costing it, per equipment hour

/**
 * Push one line of evidence, if anybody is collecting it.
 *
 * `condition()` collects; `stepWear()` does not, because building thirty strings five times a
 * second to throw them away is exactly the sort of thing that makes an optional feature
 * expensive.
 *
 * @param {string[]|null} out the collector, or null
 * @param {string} line the sentence
 * @returns {void}
 */
function evidence(out, line) {
  if (out) out.push(line);
}

/**
 * The lubricant multiplier on a bearing: hot grease and old grease both shorten life.
 *
 * The relubrication charts halve grease life for every 15 K above about 70 C, and a bearing run
 * well past its interval is running on oxidised grease with the base oil gone. Neither is
 * mysterious and both are entirely in the operator's hands.
 *
 * @param {number} T_C bearing housing temperature, C
 * @param {number} lube_h running hours since the last relubrication
 * @param {string[]|null} out evidence collector
 * @returns {number} a multiplier, >= 1
 */
function lubeFactor(T_C, lube_h, out) {
  const heat = Math.pow(2, Math.max(0, T_C - GREASE_REF_C) / 15);
  const overdue = Math.max(0, lube_h / RELUBE_H - 1);
  const age = 1 + 0.5 * Math.min(overdue, 4);
  if (heat > 1.05) evidence(out, `bearing housing at ${T_C.toFixed(0)} C — grease life factor ${heat.toFixed(1)}x`);
  if (overdue > 0.05) evidence(out, `${lube_h.toFixed(0)} h since the last regrease against a ${RELUBE_H} h interval — ${age.toFixed(1)}x`);
  return heat * age;
}

/**
 * The vibration multiplier, referred to the ISO 10816-3 zone boundaries.
 *
 * @param {number} v_mms overall velocity, mm/s RMS
 * @param {string[]|null} out evidence collector
 * @returns {number} a multiplier, >= 1
 */
function vibFactor(v_mms, out) {
  const over = Math.max(0, v_mms - VIB_GOOD_MMS) / 2.2;
  const f = clamp(1 + over * over, 1, 8);
  if (f > 1.05) evidence(out, `vibration ${v_mms.toFixed(1)} mm/s against the ISO 10816-3 zone A/B line at ${VIB_GOOD_MMS} — ${f.toFixed(1)}x`);
  return f;
}

/**
 * How much life one component is consuming per equipment hour, as a multiple of its nominal duty.
 *
 * Returns 0 for a component that is doing nothing at all — a stopped machine's bearings do not
 * wear, which is the entire reason duty rotation and sleep mode are worth having.
 *
 * @param {object} c the component record from {@link COMPONENTS}
 * @param {object} ws the wear state
 * @param {object} duty {machines, plant} from the samplers
 * @param {string[]|null} out evidence collector, or null on the hot path
 * @returns {number} the stress multiplier
 */
function stressOf(c, ws, duty, out) {
  const m = c.index >= 0 ? duty.machines[c.index] : null;
  const p = duty.plant;

  switch (c.kind) {
    case 'IMPELLER': {
      if (!m || !m.running) return 0;
      const off = offBepFactor(m.x);
      const base = m.s * m.s * m.s * (0.35 + 0.65 * off);
      // Weighted hard toward cavitation on purpose: an impeller on clean water at its duty point
      // outlives the plant, and an impeller in a cavitating pump is scrap in months.
      const cavPart = 45 * m.cavIdx;
      if (off > 1.1) evidence(out, `running at ${(m.x * 100).toFixed(0)}% of best-efficiency flow — ${off.toFixed(1)}x on hydraulic loading`);
      if (m.cavIdx > 0.01) evidence(out, `cavitation exposure index ${m.cavIdx.toFixed(2)} — ${cavPart.toFixed(1)}x, and this part of the damage is permanent`);
      return base + cavPart;
    }
    case 'RINGS': {
      if (!m || !m.running) return 0;
      const off = offBepFactor(m.x);
      const dry = m.dry ? 80 : 0;
      if (off > 1.1) evidence(out, `running at ${(m.x * 100).toFixed(0)}% of best-efficiency flow — ${off.toFixed(1)}x`);
      if (dry) evidence(out, 'turning with no throughflow — the rings are running dry at 80x');
      if (m.cavIdx > 0.01) evidence(out, `cavitation exposure ${m.cavIdx.toFixed(2)} — ${(6 * m.cavIdx).toFixed(1)}x`);
      return m.s * m.s * (0.5 + 0.5 * off) + dry + 6 * m.cavIdx;
    }
    case 'BEARING': {
      if (!m || !m.running) return 0;
      const share = num(c.loadShare, 1);
      // Radial thrust is a load, and bearing life goes as the cube of load — so the off-BEP
      // penalty is steeper here than it is anywhere else on the machine. The exponent is held at
      // 1.4 rather than 3 because the reliability curve this is fitted to is the observed one,
      // not the theoretical bearing one, and the observed curve already includes everything else
      // that is happening at 40% flow.
      const load = Math.pow(offBepFactor(m.x), 1.4);
      const lube = lubeFactor(m.bearingT, m.lube_h, out);
      const vib = vibFactor(m.vib, out);
      const align = 1 + 3 * (1 - m.align) * (1 - m.align);
      const sg = 1 + 0.4 * Math.max(0, m.sg - 1);
      if (load > 1.1) evidence(out, `radial thrust off BEP — ${load.toFixed(1)}x on this bearing`);
      if (align > 1.05) evidence(out, `alignment quality ${(m.align * 100).toFixed(0)}% — ${align.toFixed(1)}x`);
      return m.s * m.s * share * load * lube * vib * align * sg;
    }
    case 'SEAL': {
      if (!m || !m.running) return 0;
      // A seal run dry destroys its faces in minutes, not hours. This is deliberately the largest
      // single multiplier in the file, and it is what makes minimum-flow protection matter.
      const dry = m.dry ? 300 : 0;
      const heat = Math.pow(2, Math.max(0, m.Tcasing - 60) / 20);
      const vib = vibFactor(m.vib, out);
      const off = offBepFactor(m.x);
      if (dry) evidence(out, 'turning with no throughflow — the seal faces are running dry at 300x');
      if (heat > 1.05) evidence(out, `casing at ${m.Tcasing.toFixed(0)} C — ${heat.toFixed(1)}x on the faces`);
      if (m.cavIdx > 0.01) evidence(out, `cavitation is shaking the seal chamber — ${(25 * m.cavIdx).toFixed(1)}x`);
      return (0.4 + 0.6 * off) * heat * vib + dry + 25 * m.cavIdx;
    }
    case 'COUPLING': {
      if (!m || !m.running) return 0;
      const align = 1 + 6 * (1 - m.align) * (1 - m.align);
      const torque = 0.3 + 1.4 * m.torqueFrac * m.torqueFrac;
      const vib = vibFactor(m.vib, out);
      if (align > 1.05) evidence(out, `alignment quality ${(m.align * 100).toFixed(0)}% — ${align.toFixed(1)}x on the element`);
      return torque * align * vib;
    }
    case 'MOTOR_WINDING': {
      if (!m || !m.energised) return 0;
      // Montsinger's rule: insulation life halves for every 10 K of extra winding temperature.
      // The overload relay's thermal capacity IS the winding's temperature model, and on this
      // machine twelve points of it is about ten kelvin of rise.
      const heat = clamp(Math.pow(2, (m.thermal_pct - 80) / 12), 0.05, 40);
      if (m.thermal_pct > 85) evidence(out, `thermal capacity used ${m.thermal_pct.toFixed(0)}% — insulation ageing ${heat.toFixed(1)}x`);
      return 0.2 + 0.8 * heat;
    }
    case 'MOTOR_BEARING': {
      if (!m || !m.running) return 0;
      const lube = lubeFactor(m.bearingT - 4, m.lube_h, out);
      const vib = vibFactor(m.vib, out);
      return m.s * m.s * (0.6 + 0.8 * m.torqueFrac) * lube * vib;
    }
    case 'VFD_FAN': {
      if (!m || !m.energised) return 0;
      // A fan's bearings are rated at a reference ambient; hotter air is a shorter life, same
      // Arrhenius shape as everything else on this list.
      const heat = Math.pow(2, Math.max(0, m.ambient - 25) / 15);
      return (0.7 + 0.6 * m.loadFrac) * heat;
    }
    case 'VFD_CAPS': {
      if (!m || !m.energised) return 0;
      const fanHealth = healthOf(ws, `${DRIVE_TAGS[c.index]}.fan`);
      // With the fan gone the heatsink runs some 25 K hotter, and 25 K on an electrolytic
      // capacitor is between five and six times the ageing rate. This is the chain the whole
      // component exists for: the cheapest part on the drive takes the most expensive one with it.
      const Tcap = m.ambient + 20 + 15 * m.loadFrac + 25 * (1 - fanHealth);
      const heat = Math.pow(2, (Tcap - CAP_REF_C) / 10);
      if (fanHealth < 0.9) evidence(out, `cooling fan at ${(fanHealth * 100).toFixed(0)}% — capacitor core about ${Tcap.toFixed(0)} C, ${heat.toFixed(1)}x`);
      return clamp(heat, 0.05, 40);
    }
    case 'VFD_POWER': {
      if (!m || !m.energised) return 0;
      return 0.5 + 0.5 * m.loadFrac;
    }
    case 'NRV': {
      if (!m || !m.running) return 0;
      // A check valve wears at its seat with flow, and is damaged by slamming — which is a
      // per-start-and-stop event, charged separately.
      const vel = m.Q > 0 ? m.Q / 45 : 0;
      return 0.2 + 0.8 * vel * vel;
    }
    case 'VALVE_PACKING': {
      const v = p.valve[c.valve] || { strokeRate_perH: 0 };
      // Nominal duty is a valve that strokes about six percent of full travel per hour — a
      // well-tuned loop responding to a slowly moving load. A valve in a limit cycle does that in
      // a minute, and the packing knows.
      const rate = v.strokeRate_perH / 0.06;
      if (rate > 2) evidence(out, `stem moving ${v.strokeRate_perH.toFixed(2)} full strokes an hour against a nominal 0.06 — ${rate.toFixed(0)}x`);
      return 0.1 + rate;
    }
    case 'VALVE_TRIM': {
      // Erosion goes with the energy being destroyed across the trim, and is worse the closer to
      // the seat it is being destroyed. Nominal duty is 1 kW of throttling loss.
      const power = p.pcvDissipated_kW;
      const x = p.valve[c.valve] ? p.valve[c.valve].x : 1;
      const nearSeat = 1 + 3 * Math.max(0, 0.35 - x) / 0.35;
      if (power > 0.2) evidence(out, `${power.toFixed(1)} kW being destroyed across the trim at ${(x * 100).toFixed(0)}% open — ${(power * nearSeat).toFixed(1)}x`);
      return 0.05 + power * nearSeat;
    }
    case 'STRAINER': {
      // Blinding goes with what has been through it and with the water chemistry, and dosing is
      // the only thing holding it down.
      return (0.15 + p.throughput) * p.foulingMul;
    }
    case 'SCALE': {
      // Carbonate scale has inverse solubility: it deposits faster hot, which is why a shut
      // minimum-flow line scales a plant as well as cooking it.
      const heat = Math.pow(2, Math.max(0, p.T_C - 25) / 25);
      return (0.1 + 0.9 * p.throughput) * heat * p.foulingMul;
    }
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// The step

/**
 * Advance every component's condition by one controller scan.
 *
 * Time arrives as an argument and is converted through `agedHours()`, so the acceleration factor
 * lives in exactly one place and every life in this file stays quoted at its real engineering
 * value. Nothing happens at all unless `FEATURE.WEAR` is on.
 *
 * @param {object} ws the wear state, mutated
 * @param {object} cfg the realism configuration
 * @param {object} ctx the sim context: `config`, `plant`, and optionally `realism`
 * @param {number} dt_s the scan interval in real seconds
 * @returns {void}
 */
export function stepWear(ws, cfg, ctx, dt_s) {
  if (!isRecord(ws) || !isRecord(ws.comp) || !isRecord(ctx)) return;
  if (!isOn(cfg, FEATURE.WEAR)) return;
  const dt = num(dt_s, 0);
  if (dt <= 0) return;

  const dAge_h = agedHours(cfg, dt);
  const dtReal_h = dt / 3600;
  const severity = rateOf(cfg, 'wear');
  const fouling = rateOf(cfg, 'fouling');
  ws.clock_h += dAge_h;
  ws.real_s += dt;

  // --- 1. the duty this scan ------------------------------------------------------------------
  const duty = { machines: [], plant: plantSample(ws, ctx, dtReal_h) };
  for (let i = 0; i < ws.machines.length; i += 1) duty.machines.push(machineSample(ws, ctx, i));

  // --- 2. per-machine counters, and the charge for every start --------------------------------
  const startCharge = [];
  for (let i = 0; i < ws.machines.length; i += 1) {
    const m = ws.machines[i];
    const d = duty.machines[i];
    m.bearingT_C = d.bearingT;
    m.vib_mms = d.vib;

    if (d.running) {
      m.run_h += dAge_h;
      m.lube_h += dAge_h;
      if (d.cavIdx > 0) m.cav_h += dAge_h;
      if (d.dry) m.dry_h += dAge_h;
      // Alignment is not permanent. Thermal cycling and a worn coupling walk a machine off its
      // shims, and nothing puts it back except somebody with a laser.
      m.align = clamp(m.align - dAge_h * 4e-6 * severity, 0.2, 1);
    }

    // Starts are counted on the REAL clock, because what makes closely spaced starts damaging is
    // that the winding has not cooled — and the motor's thermal time constant is twenty real
    // minutes, not twenty compressed ones.
    const decay = Math.exp(-dtReal_h / START_WINDOW_H);
    let fresh = 0;
    if (Number.isFinite(m.lastStarts)) fresh = Math.max(0, d.starts - m.lastStarts);
    m.lastStarts = d.starts;
    m.startRate_perH = m.startRate_perH * decay + fresh / START_WINDOW_H;
    // The penalty for short-cycling: each start costs its nominal equivalent hours multiplied by
    // how many starts this machine has taken in the last real hour. Two starts a shift is free;
    // thirty an hour is a motor that will not see its second year.
    startCharge.push(fresh * (1 + 0.6 * m.startRate_perH));
    if (fresh > 0) m.align = clamp(m.align - 0.0008 * fresh, 0.2, 1);
  }

  // --- 3. consume life -------------------------------------------------------------------------
  for (const c of COMPONENTS) {
    const st = ws.comp[c.id];
    if (!st || st.failed) continue;
    const mul = c.kind === 'STRAINER' || c.kind === 'SCALE' ? fouling : severity;
    const stress = stressOf(c, ws, duty, null);
    let used = dAge_h * stress * mul;

    // A start is an event, not a rate: a fixed quantum of life, charged once, whatever the clock
    // is doing.
    if (c.startCost_h && c.index >= 0 && startCharge[c.index] > 0) {
      used += c.startCost_h * startCharge[c.index] * mul;
    }

    st.stress = stress;
    st.rate_perH = c.life_h > 0 ? (stress * mul) / c.life_h : 0;
    if (used > 0) {
      st.used_h = Math.min(st.used_h + used, c.life_h * 4);
      // Cavitation erosion is metal that has left the impeller. No task short of a new impeller
      // gives it back, and `performTask` will not restore below this line.
      if (c.kind === 'IMPELLER') {
        const m = duty.machines[c.index];
        if (m && m.cavIdx > 0) st.perm_h = Math.min(st.perm_h + dAge_h * 45 * m.cavIdx * mul, st.used_h);
      }
    }
  }

  // --- 4. the seal leak, on the real clock ------------------------------------------------------
  // The damage accrued above is on the compressed clock; the liquid on the floor is not. A seal
  // that is leaking 40 litres an hour leaks 40 litres in an hour whatever the ageing factor says.
  const plant = ctx.plant;
  let leakTotal = 0;
  for (let i = 0; i < ws.machines.length; i += 1) {
    const st = ws.comp[`${PUMP_TAGS[i]}.seal`];
    const d = duty.machines[i];
    const dmg = st ? clamp(st.used_h / BY_ID[`${PUMP_TAGS[i]}.seal`].life_h, 0, 1) : 0;
    // API 682 allows a contacting wet seal a few grams an hour when it is healthy. A seal at the
    // end of its life weeps litres; a blown one throws them.
    let leak = d.running ? 2e-5 + 0.06 * Math.pow(dmg, 3) : 0;
    if (st && st.failed === 'BLOWOUT') leak = d.running ? 0.9 : 0.05;
    else if (st && st.failed === 'WEEP') leak += d.running ? 0.05 : 0;
    ws.machines[i].leak_m3h = leak;
    leakTotal += leak;
  }
  if (leakTotal > 0 && plant && Number.isFinite(plant.V_m3)) {
    const lost = leakTotal * dtReal_h;
    plant.V_m3 = Math.max(0.001, plant.V_m3 - lost);
    ws.leaked_m3 += lost;
  }
}

// ---------------------------------------------------------------------------------------------
// Pushing the consequences onto the plant

/**
 * Lay this layer's contribution over a plant field without stealing it from its other owners.
 *
 * @param {{base:number, written:number}} slot the overlay record, mutated
 * @param {number} current what the plant holds right now
 * @param {number} ours this layer's contribution
 * @param {number} lo lower clamp
 * @param {number} hi upper clamp
 * @returns {number} the value to write back
 */
function overlay(slot, current, ours, lo, hi) {
  if (!Number.isFinite(slot.written)) slot.base = num(current, 0);
  else slot.base += num(current, slot.written) - slot.written;
  const v = clamp(slot.base + ours, lo, hi);
  slot.written = v;
  return v;
}

/**
 * Push every consequence of the current condition onto the plant. Called once per controller
 * scan, before the processor and the loop read anything.
 *
 * On a state that has never been stepped this writes back exactly what it found: the overlay
 * baselines adopt the plant's own values on the first pass and this layer's contribution is zero.
 * That is what makes the feature genuinely optional rather than merely defaulted off.
 *
 * @param {object} ws the wear state
 * @param {object} ctx the sim context
 * @returns {void}
 */
export function applyWear(ws, ctx) {
  if (!isRecord(ws) || !isRecord(ws.comp) || !isRecord(ctx) || !isRecord(ctx.plant)) return;
  const plant = ctx.plant;
  const config = ctx.config || {};

  // --- the pump derate --------------------------------------------------------------------------
  // One number carries it, because the plant has one: `wear` drives head, efficiency, NPSH
  // required and the unbalance term of the vibration figure through `deratedPump`. Wear rings
  // dominate it, impeller erosion adds to it, and a small contribution from the rotor's own
  // condition is what lets a spalled bearing show up on the vibration pen.
  if (plant.wear && plant.wear.length) {
    for (let i = 0; i < ws.machines.length && i < plant.wear.length; i += 1) {
      const rings = 1 - healthOf(ws, `${PUMP_TAGS[i]}.wearRings`);
      const imp = 1 - healthOf(ws, `${PUMP_TAGS[i]}.impeller`);
      const bear = Math.max(
        1 - healthOf(ws, `${PUMP_TAGS[i]}.bearingDE`),
        1 - healthOf(ws, `${PUMP_TAGS[i]}.bearingNDE`),
      );
      const ours = clamp(0.90 * rings + 0.60 * imp + 0.20 * bear
        + 0.10 * (1 - ws.machines[i].align), 0, 1);
      plant.wear[i] = overlay(ws.overlay.wear[i], plant.wear[i], ours, 0, 1);
    }
  }

  // --- the suction: strainer blinding and internal scale ---------------------------------------
  // Both land on the same plant field, because both do the same thing to the branch: raise its
  // resistance and take the suction margin with it. They are tracked SEPARATELY so that cleaning
  // the strainer cannot undo the scale, which is the point.
  {
    const blind = 1 - healthOf(ws, 'STR-101.element');
    const scale = 1 - healthOf(ws, 'PL-101.scale');
    // A blinded basket can take the strainer to nearly nothing; scale in the branch is slower and
    // its ceiling is lower, but nothing an operator does at the strainer touches it.
    const ours = clamp(0.85 * blind + 0.35 * scale, 0, 0.95);
    plant.foul = overlay(ws.overlay.foul, plant.foul, ours, 0, 0.95);
  }

  // --- the control valves -----------------------------------------------------------------------
  if (isRecord(plant.valveOverride)) {
    const pack = (key, slot, damage) => {
      const ov = plant.valveOverride[key];
      if (!isRecord(ov)) return;
      // Gland friction, as a fraction of travel. A repacked valve is a couple of tenths of a
      // percent; one that has been running for years and then overtightened to stop it weeping is
      // several percent, and several percent is a limit cycle.
      const stick = overlay(slot, ov.stickband, 0.05 * damage * damage, 0, 0.3);
      ov.stickband = stick;
      // Slip-jump defaults to half the stickband in the plant when it is left at zero; setting it
      // explicitly here keeps the stiction a stiction and not a deadband.
      ov.slipJump = stick > 0 ? Math.max(num(ov.slipJump, 0), 0.5 * stick) : ov.slipJump;
    };
    pack('pcv', ws.overlay.pcvStick, 1 - healthOf(ws, 'PCV-101.packing'));
    pack('fcv', ws.overlay.fcvStick, 1 - healthOf(ws, 'FCV-101.packing'));

    // A plug that has been cut by throttling binds in its cage, and the stroke slows. The seat
    // leakage that goes with it is REPORTED in `condition()`; the frozen valve record has no
    // leakage override to land it on.
    const ov = plant.valveOverride.pcv;
    const trim = 1 - healthOf(ws, 'PCV-101.trim');
    if (isRecord(ov) && config.pcvValve) {
      const nominal = num(config.pcvValve.strokeTime_s, 4);
      const ours = nominal * (0.6 * trim + 0.4 * (1 - healthOf(ws, 'PCV-101.packing')));
      if (ours > 0.02) {
        ov.strokeTime_s = overlay(ws.overlay.pcvStroke, num(ov.strokeTime_s, nominal),
          ours, 0.5, 120);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the condition

/**
 * How much life a component has left, 1 (as new) to 0 (finished).
 *
 * An unknown id reads as new: a caller asking about a component this rig does not have is a
 * caller bug, and returning "broken" would put a fault on a plant that has none.
 *
 * @param {object} ws the wear state
 * @param {string} componentId a component id
 * @returns {number} health, 0..1
 */
export function healthOf(ws, componentId) {
  const c = BY_ID[componentId];
  if (!c || !isRecord(ws) || !isRecord(ws.comp)) return 1;
  const st = ws.comp[componentId];
  if (!st) return 1;
  if (st.failed && st.used_h >= c.life_h) return 0;
  return clamp(1 - st.used_h / c.life_h, 0, 1);
}

/**
 * The health of an asset — its weakest component.
 *
 * Weakest link, not average. A pump with a perfect impeller and a seal about to let go is a pump
 * about to stop, and an average would hide that behind the parts that are fine.
 *
 * @param {object} ws the wear state
 * @param {string} asset an equipment tag, e.g. 'P-101' or 'VFD-102'
 * @returns {number} health, 0..1; 1 for an asset with no components
 */
export function assetHealth(ws, asset) {
  const ids = BY_ASSET[asset];
  if (!ids || !ids.length) return 1;
  let worst = 1;
  for (const id of ids) worst = Math.min(worst, healthOf(ws, id));
  return worst;
}

/**
 * The Weibull hazard rate: the chance per equipment hour that this component fails NOW, given
 * that it has not yet.
 *
 *     h(t) = (beta / eta) * (t / eta)^(beta - 1)
 *
 * with `eta` the characteristic life and `t` the effective life consumed. The shape factor is
 * what makes this worth having over a constant rate: a bearing that has been run hard is not
 * merely nearer the end of its life, it is more likely to fail today than it was last month, and
 * for the drive's power stage — shape below one — the opposite is true.
 *
 * @param {object} ws the wear state
 * @param {string} componentId a component id
 * @returns {number} failures per equipment hour, 0 for an unknown or already-failed component
 */
export function hazardRate(ws, componentId) {
  const c = BY_ID[componentId];
  if (!c || !isRecord(ws) || !isRecord(ws.comp)) return 0;
  const st = ws.comp[componentId];
  if (!st || st.failed) return 0;
  const eta = c.life_h;
  const beta = c.weibullShape;
  if (!(eta > 0) || !(beta > 0)) return 0;
  // The hazard of a decreasing-hazard component is infinite at exactly zero age, which is a
  // property of the algebra and not of the machine. A floor at a thousandth of the characteristic
  // life keeps it finite and keeps infant mortality where it belongs — high, and early.
  const t = Math.max(st.used_h, 0.001 * eta);
  return (beta / eta) * Math.pow(t / eta, beta - 1);
}

/**
 * Where a health figure sits on the scale a planner would use.
 * @param {number} health 0..1
 * @param {boolean} failed whether the component has already failed
 * @returns {string} 'FAILED', 'URGENT', 'PLAN', 'WATCH' or 'OK'
 */
function severityOf(health, failed) {
  if (failed) return 'FAILED';
  if (health <= REPLACE_AT) return 'URGENT';
  if (health <= 0.35) return 'PLAN';
  if (health <= 0.6) return 'WATCH';
  return 'OK';
}

/**
 * The condition report: every component, what is left of it, how long that will last at the duty
 * it is being given RIGHT NOW, and the evidence for the answer.
 *
 * The evidence is the point. A number that says a bearing is at 40% teaches nothing; a line that
 * says the machine is running at 43% of best-efficiency flow and that this is costing the bearing
 * four and a half times its nominal rate tells an operator what to change.
 *
 * @param {object} ws the wear state
 * @param {object} ctx the sim context, for the live duty
 * @returns {object[]} one record per component, worst first
 */
export function condition(ws, ctx) {
  if (!isRecord(ws) || !isRecord(ws.comp)) return [];
  const c2 = isRecord(ctx) ? ctx : { config: {}, plant: {} };
  const duty = { machines: [], plant: plantSample(ws, c2, 0) };
  for (let i = 0; i < ws.machines.length; i += 1) duty.machines.push(machineSample(ws, c2, i));

  const out = [];
  for (const c of COMPONENTS) {
    const st = ws.comp[c.id];
    if (!st) continue;
    const ev = [];
    const stress = st.failed ? 0 : stressOf(c, ws, duty, ev);
    const health = healthOf(ws, c.id);
    const rate = c.life_h > 0 ? stress / c.life_h : 0;
    const usable = Math.max(0, health - REPLACE_AT);
    const remaining = rate > 1e-12 ? usable / rate : Infinity;

    if (stress <= 0 && !st.failed) ev.push('not running — consuming no life at all');
    else if (stress > 0) ev.push(`consuming life at ${stress.toFixed(2)}x its nominal duty`);
    if (st.perm_h > 0) {
      ev.push(`${((st.perm_h / c.life_h) * 100).toFixed(1)}% of its life is permanent damage that no overhaul recovers`);
    }
    if (st.failed) ev.push(`failed: ${st.message}`);

    out.push({
      id: c.id,
      asset: c.asset,
      name: c.name,
      health,
      remaining_h: remaining,
      // A single word for the list, and the number behind it for anyone who wants to argue.
      trend: st.failed ? 'failed' : (stress <= 0 ? 'steady' : (stress > 2 ? 'accelerating' : 'degrading')),
      stress,
      rate_perH: rate,
      hazard_perH: hazardRate(ws, c.id),
      evidence: ev,
      severity: severityOf(health, !!st.failed),
      failed: st.failed,
      maintenance: c.maintenance,
      parts: c.parts,
      symptoms: c.symptoms,
      effect: c.effect,
    });
  }
  out.sort((a, b) => a.health - b.health);
  return out;
}

/**
 * The compact view: what the UI puts on a page without asking for thirty records.
 *
 * @param {object} ws the wear state
 * @returns {object} assets with their worst component, the live leak, and the running totals
 */
export function wearSummary(ws) {
  if (!isRecord(ws) || !isRecord(ws.comp)) {
    return { ok: false, assets: [], worst: null, leak_m3h: 0, leaked_m3: 0, clock_h: 0, failures: 0 };
  }
  const assets = [];
  for (const asset of Object.keys(BY_ASSET)) {
    let worstId = null;
    let worstHealth = 1;
    for (const id of BY_ASSET[asset]) {
      const h = healthOf(ws, id);
      if (h <= worstHealth) { worstHealth = h; worstId = id; }
    }
    const st = worstId ? ws.comp[worstId] : null;
    assets.push({
      asset,
      health: worstHealth,
      worstId,
      worstName: worstId ? BY_ID[worstId].name : null,
      severity: severityOf(worstHealth, !!(st && st.failed)),
      failed: !!(st && st.failed),
    });
  }
  assets.sort((a, b) => a.health - b.health);
  let leak = 0;
  for (const m of ws.machines) leak += num(m.leak_m3h, 0);
  return {
    ok: true,
    clock_h: ws.clock_h,
    assets,
    worst: assets.length ? assets[0] : null,
    leak_m3h: leak,
    leaked_m3: ws.leaked_m3,
    failures: ws.events.length,
    lastFailure: ws.events.length ? ws.events[ws.events.length - 1] : null,
    machines: ws.machines.map((m) => ({
      tag: m.tag,
      run_h: m.run_h,
      cav_h: m.cav_h,
      dry_h: m.dry_h,
      lube_h: m.lube_h,
      align: m.align,
      startRate_perH: m.startRate_perH,
      bearingT_C: m.bearingT_C,
      vib_mms: m.vib_mms,
      leak_m3h: m.leak_m3h,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Failures

/**
 * Choose a failure mode by weight.
 * @param {object[]} modes the component's modes
 * @param {number} r a sample in [0, 1)
 * @returns {object} the chosen mode
 */
function pickMode(modes, r) {
  let total = 0;
  for (const m of modes) total += m.weight;
  if (!(total > 0)) return modes[0];
  let acc = r * total;
  for (const m of modes) {
    acc -= m.weight;
    if (acc <= 0) return m;
  }
  return modes[modes.length - 1];
}

/**
 * Roll this scan's failures against every component's hazard rate.
 *
 * A component can fail GRADUALLY — a spalled bearing, a weeping seal, a wire-drawn seat — which
 * takes a bite out of its remaining life and leaves it running, or CATASTROPHICALLY, which
 * finishes it and, for the modes that warrant it, trips the drive through `motor.js`'s own
 * `trip()` so the machine locks out exactly like any other trip.
 *
 * A draw is taken for every component in a fixed order whether or not it is a candidate, so the
 * stream's position does not depend on the failure history and a seeded run reproduces.
 *
 * @param {object} ws the wear state, mutated
 * @param {object} cfg the realism configuration
 * @param {object} ctx the sim context
 * @param {number} dt_s the scan interval in real seconds
 * @returns {Array<{componentId:string, mode:string, message:string, severity:string}>} what broke
 */
export function rollFailures(ws, cfg, ctx, dt_s) {
  const out = [];
  if (!isRecord(ws) || !isRecord(ws.comp) || typeof ws.rng !== 'function') return out;
  if (!isOn(cfg, FEATURE.FAILURES)) return out;
  const dAge_h = agedHours(cfg, num(dt_s, 0));
  if (!(dAge_h > 0)) return out;
  const mul = rateOf(cfg, 'failure');

  for (const c of COMPONENTS) {
    // Always draw. See the note above: skipping the draw for a failed component would make the
    // stream's position depend on the history and a share code would stop reproducing.
    const r = ws.rng();
    const r2 = ws.rng();
    const st = ws.comp[c.id];
    if (!st || st.failed || mul <= 0) continue;
    const p = 1 - Math.exp(-hazardRate(ws, c.id) * dAge_h * mul);
    if (!(r < p)) continue;

    const mode = pickMode(c.modes, r2);
    const catastrophic = mode.damage >= 1;
    st.used_h = catastrophic ? c.life_h : Math.min(st.used_h + mode.damage * c.life_h, c.life_h);
    if (catastrophic) {
      st.failed = mode.mode;
      st.message = mode.message;
      st.failedAt_h = ws.clock_h;
    }
    // Erosion damage on an impeller is permanent whether it arrived slowly or all at once.
    if (c.kind === 'IMPELLER') st.perm_h = Math.max(st.perm_h, st.used_h);

    const record = {
      componentId: c.id,
      asset: c.asset,
      mode: mode.mode,
      message: `${c.asset} — ${mode.message}`,
      severity: catastrophic ? 'ALARM' : 'WARN',
      at_h: ws.clock_h,
    };
    ws.events.push(record);
    out.push(record);

    if (mode.trips && c.index >= 0 && isRecord(ctx) && isRecord(ctx.plant)
      && ctx.plant.drv && ctx.plant.drv[c.index]) {
      trip(ctx.plant.drv[c.index], record.message);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Maintenance

/**
 * Which components a task would touch on a given target.
 *
 * @param {object} task the task record
 * @param {string} target a component id, or an asset tag
 * @returns {object[]} the components it applies to
 */
function targetsOf(task, target) {
  const keys = Object.keys(task.restores);
  const direct = BY_ID[target];
  if (direct) {
    const suffix = direct.id.slice(direct.id.indexOf('.') + 1);
    return keys.includes(suffix) ? [direct] : [];
  }
  return COMPONENTS.filter((c) => c.asset === target
    && keys.includes(c.id.slice(c.id.indexOf('.') + 1)));
}

/**
 * Carry out a maintenance task.
 *
 * It restores what the task actually restores and nothing else. Replacing a seal does not fix the
 * bearing that has been shaking it; cleaning a strainer does not undo the scale in the branch; a
 * chemical descale leaves the roughening behind. An overhaul restores the pump and does not touch
 * the motor, the drive or the pipework.
 *
 * Two things can refuse the job. A task that needs the machine stopped is refused while the drive
 * is anything but stopped or tripped — a job on a running pump is not a modelling nicety, it is
 * the reason isolation procedures exist. And if the stores layer is present and says the part is
 * not there, the job does not happen, which is the entire point of having a stores model.
 *
 * @param {object} ws the wear state, mutated
 * @param {string} taskId a task id from {@link TASKS}
 * @param {string} componentId the component or asset to work on
 * @param {object} ctx the sim context, for the machine's state and the optional stores
 * @returns {{ok:boolean, reason?:string, restored?:object[], note?:string}} what happened
 */
export function performTask(ws, taskId, componentId, ctx) {
  if (!isRecord(ws) || !isRecord(ws.comp)) {
    return fail('There is no machinery condition state to work on.');
  }
  const task = TASK_BY_ID[taskId];
  if (!task) {
    return fail(`There is no maintenance task called "${String(taskId)}".`);
  }
  const target = typeof componentId === 'string' ? componentId : '';
  const comps = targetsOf(task, target);
  if (!comps.length) {
    return fail(`${task.name} does not apply to "${target || 'nothing'}". It covers ${Object.keys(task.restores).join(', ') || 'no components at all'}.`);
  }

  // --- isolation ------------------------------------------------------------------------------
  if (task.requiresStop) {
    const idx = comps[0].index;
    const drv = idx >= 0 && isRecord(ctx) && isRecord(ctx.plant) && ctx.plant.drv
      ? ctx.plant.drv[idx] : null;
    if (drv && drv.state !== DRIVE.STOPPED && drv.state !== DRIVE.TRIPPED) {
      return fail(`${comps[0].asset} is ${String(drv.state).toLowerCase()}. Stop and isolate the machine before starting ${task.name.toLowerCase()}.`);
    }
    // A job on the throttle valve or the pipework takes the line out of service, so nothing may
    // be turning at all.
    if (idx < 0 && isRecord(ctx) && isRecord(ctx.plant) && Array.isArray(ctx.plant.drv)) {
      const live = ctx.plant.drv.some((d) => d && (d.state === DRIVE.RUNNING
        || d.state === DRIVE.STARTING || d.state === DRIVE.STOPPING));
      if (live) {
        return fail(`${task.name} needs the line out of service, and there is still a machine running.`);
      }
    }
  }

  // --- parts ------------------------------------------------------------------------------------
  // The stores layer is optional and lives in a sibling module. Rather than import it — which
  // would make this module fail to load when consumables are not in the build — the job asks
  // whatever the integrator put on `ctx.realism.consumeParts` and believes its refusal.
  const rl = isRecord(ctx) ? ctx.realism : null;
  if (isRecord(rl) && typeof rl.consumeParts === 'function' && task.parts.length) {
    let res;
    try {
      res = rl.consumeParts(task.parts, task, comps);
    } catch (e) {
      res = { ok: false, reason: 'The stores system could not be reached.' };
    }
    if (isRecord(res) && res.ok === false) {
      return fail(res.reason || `There is no ${task.parts[0]} in stores, so ${task.name.toLowerCase()} cannot go ahead.`);
    }
  }

  // --- do the work ------------------------------------------------------------------------------
  const restored = [];
  for (const c of comps) {
    const st = ws.comp[c.id];
    if (!st) continue;
    const suffix = c.id.slice(c.id.indexOf('.') + 1);
    const frac = clamp(num(task.restores[suffix], 0), 0, 1);
    const before = healthOf(ws, c.id);
    // Permanent damage is a floor. A full replacement clears it — the part is new — but a partial
    // restoration cannot reach past it.
    const floor = frac >= 1 ? 0 : st.perm_h;
    st.used_h = Math.max(floor, st.used_h * (1 - frac));
    if (frac >= 1) {
      st.perm_h = 0;
      st.failed = null;
      st.message = null;
      st.failedAt_h = NaN;
      st.renewals += 1;
      st.renewedAt_h = ws.clock_h;
    }
    restored.push({ id: c.id, name: c.name, from: before, to: healthOf(ws, c.id) });
  }

  // --- what the job resets that is not damage ---------------------------------------------------
  const idx = comps[0].index;
  if (idx >= 0 && ws.machines[idx]) {
    const m = ws.machines[idx];
    if (taskId === 'REGREASE' || taskId === 'REPLACE_BEARINGS' || taskId === 'OVERHAUL'
      || taskId === 'REPLACE_MOTOR_BEARINGS') {
      m.lube_h = 0;
    }
    if (taskId === 'ALIGN' || taskId === 'OVERHAUL') m.align = 1;
    if (taskId === 'REPLACE_COUPLING') m.align = Math.max(m.align, 0.85);
    if (taskId === 'REPLACE_SEAL' || taskId === 'OVERHAUL') m.leak_m3h = 0;
  }

  return {
    ok: true,
    restored,
    duration_h: task.duration_h,
    note: task.note,
  };
}
