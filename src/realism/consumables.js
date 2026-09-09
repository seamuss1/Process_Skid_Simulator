/**
 * src/realism/consumables.js — the stores: what is on the shelf, what it cost, how long the next
 * one takes to arrive, and what the plant is quietly using up while nobody watches.
 *
 * Layer: `src/realism`. Imports `core/util.js` and `realism/config.js` only. No DOM, no `window`,
 * no `document`, no `performance`, no `Date.now()`, no `Math.random()`. Every function here is
 * tested in Node.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A STORES MODEL IS WORTH BUILDING AT ALL
 *
 * A maintenance simulator in which the part is always on the shelf teaches nothing, because it
 * removes the only decision a stores exists to force: how much money do you leave sitting on a
 * rack against a failure that may not come this year. Take the decision away and "replace the
 * seal" is a button. Put it back and it is a question with a cost on both sides — and the answer
 * arrives nine weeks later, in the form of a cast impeller on a truck, while the plant has been
 * running single-pump the whole time.
 *
 * So two mechanisms carry this module and everything else in it is bookkeeping in support of
 * them.
 *
 *   THE STOCKOUT BLOCKS THE JOB. `consumeKit()` is atomic: either every line of the bill of
 *   materials comes off the shelf together or nothing does and the caller gets a sentence saying
 *   what is missing, how many short, and when the outstanding order lands. A half-issued kit is
 *   not a thing — a pump stripped for a seal that is not in the country is worse than a pump left
 *   running on a seal that is weeping. The lead times are the real ones: a cartridge seal is a
 *   fortnight, valve trim is five weeks, a cast impeller is nine, and multiplying those by the
 *   `leadTime` severity rate is what turns an inconvenience into an outage.
 *
 *   THE DOSE CHANGES THE PLANT. Antiscalant, biocide and corrosion inhibitor are not counters
 *   going down; they multiply the fouling and corrosion rates the machinery model integrates.
 *   `foulingFactor()` returns 1.0 for the plant as dosed on day one, and climbs by roughly eight
 *   times when the dose stops — which it does by itself, without anybody deciding to stop it, the
 *   moment the antiscalant IBC runs dry and nobody ordered another. That is the whole chain:
 *   an unread reorder report, a stockout, a starved dose, a system curve that steepens over the
 *   following weeks, and an energy bill that says so. Every link is visible, and a user who works
 *   backwards along it has learned the thing the module exists to teach.
 *
 * ------------------------------------------------------------------------------------------
 * CONSUMPTION FOLLOWS THE DRIVER, NEVER THE CLOCK
 *
 * The failure mode this module is written against is a counter that ticks down at so many units
 * per hour whatever the plant is doing. Nothing here does that. Seal flush water is drawn per
 * SEAL RUNNING HOUR, so a stopped pump uses none. Instrument air is drawn per unit of VALVE
 * TRAVEL plus the positioner's standing bleed, so a loop that hunts costs more air than a loop
 * that sits still — which is true, and is one of the few places the cost of bad tuning is
 * directly meterable. Lube oil is drawn per BEARING HOUR and accelerated by casing temperature on
 * the ordinary oxidation rule of thumb. The flush filter loads on THROUGHPUT. The chemicals are
 * dosed on CIRCULATED FLOW. Stop the plant and the stores stops moving, which is exactly what a
 * stores does.
 *
 * All of that integrates against `agedHours()` from `realism/config.js` — the single acceleration
 * factor for the layer — and never against `dt_s / 3600`. Valve travel is the one quantity that
 * is measured in real scan time rather than plant time, so it is scaled by the same factor
 * explicitly: the travel seen in one scan is taken as representative of the compressed interval
 * that scan stands for. Doing anything else would make air the one consumable that does not age
 * with the plant.
 *
 * ------------------------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 *
 * Unit costs and lead times are ordinary Western European / North American process-plant
 * catalogue figures for a 15 kW end-suction process pump skid, in the simulator's own currency
 * unit. The engineering rates are cited individually at the constant that carries them:
 * API 682 seal-flush injection rates for Plan 32, SKF regreasing intervals for the motor bearing
 * size, the mineral-oil oxidation rule of thumb, and the threshold-inhibitor dose-response shape
 * that makes over-dosing an antiscalant a waste of money rather than extra protection.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, createRng, nextFloat, nextGaussian } from '../core/util.js';
import { FEATURE, isOn, rateOf, agedHours } from './config.js';

/** Bumped when the persisted stores shape changes in a way a loader cannot absorb silently. */
export const CONSUMABLES_VERSION = 1;

/**
 * What kind of thing an item is. The categories are the ones a stores actually separates on,
 * because they are bought, held and accounted differently: a rotating spare is capital sitting on
 * a rack, a chemical is an operating cost with a shelf life, and a utility is metered off a site
 * header and never runs out.
 */
export const CATEGORY = Object.freeze({
  /** Mechanical seals and their bits. */
  SEAL: 'SEAL',
  /** Rolling-element bearings, by size. */
  BEARING: 'BEARING',
  /** Static sealing: gaskets, joints, O-rings, gland packing. */
  GASKET: 'GASKET',
  /** Rotating spares — impeller, wear rings, sleeve, coupling. The expensive rack. */
  ROTATING: 'ROTATING',
  /** Valve internals and actuator parts. */
  VALVE: 'VALVE',
  /** Strainer baskets and filter cartridges. */
  FILTER: 'FILTER',
  /** Oils and greases, by grade. */
  LUBRICANT: 'LUBRICANT',
  /** Treatment chemicals that are dosed into the process. */
  CHEMICAL: 'CHEMICAL',
  /** Drive and motor spares. */
  DRIVE: 'DRIVE',
  /** What an instrument calibration itself consumes. */
  CALIBRATION: 'CALIBRATION',
  /** Metered off a site header rather than held: flush water, instrument air. */
  UTILITY: 'UTILITY',
});

/**
 * Which of the running consumptions a chemical acts on. Kept separate because scaling and
 * corrosion are different mechanisms with different remedies, and a simulator that lumps them
 * teaches a user that any chemical fixes any problem.
 */
export const ACTS_ON = Object.freeze({
  /** Mineral scale: the thing that steepens a system curve and blinds a strainer. */
  SCALE: 'SCALE',
  /** Biofilm: slime, which fouls faster than scale and comes back faster after cleaning. */
  BIOFILM: 'BIOFILM',
  /** General and pitting corrosion of the wetted steel. */
  CORROSION: 'CORROSION',
});

// ---------------------------------------------------------------------------------------------
// The bills of materials
// ---------------------------------------------------------------------------------------------

/**
 * Every maintenance task on this rig that draws something off the shelf, with what it draws.
 *
 * This table is the join between the machinery model and the stores, and it is deliberately
 * written here rather than inside a component record, because the same part serves several jobs
 * and the same job pulls several parts. A seal change is not one seal: it is a seal, an elastomer
 * set, a casing joint and two litres of oil, and forgetting the O-ring kit is exactly how a real
 * seal change turns into two shutdowns.
 *
 * Task ids are dotted `asset.action` strings. `kitFor()` returns an empty list for an unknown id
 * rather than throwing, so a machinery model that invents a task the stores has never heard of
 * gets an unblocked job rather than a crash — the failure direction that keeps a missing entry a
 * cosmetic bug instead of a stopped simulator.
 */
export const TASK_KITS = Object.freeze({
  /** Replace the cartridge seal complete — the normal job. */
  'seal.replace': Object.freeze([
    Object.freeze({ itemId: 'SEAL_CARTRIDGE', qty: 1 }),
    Object.freeze({ itemId: 'SEAL_ORING_KIT', qty: 1 }),
    Object.freeze({ itemId: 'GASKET_SET', qty: 1 }),
    Object.freeze({ itemId: 'LUBE_OIL_VG32', qty: 2 }),
  ]),
  /** Re-face a repairable seal in the workshop instead of buying a cartridge. Cheaper, slower. */
  'seal.reface': Object.freeze([
    Object.freeze({ itemId: 'SEAL_FACES', qty: 1 }),
    Object.freeze({ itemId: 'SEAL_ORING_KIT', qty: 1 }),
  ]),
  /** Convert a leaking seal chamber back to gland packing as a temporary measure. */
  'seal.repack': Object.freeze([
    Object.freeze({ itemId: 'GLAND_PACKING', qty: 1.2 }),
  ]),
  /** Drive-end bearing change. */
  'bearing.de.replace': Object.freeze([
    Object.freeze({ itemId: 'BEARING_6306', qty: 1 }),
    Object.freeze({ itemId: 'GASKET_SET', qty: 1 }),
    Object.freeze({ itemId: 'LUBE_OIL_VG32', qty: 2 }),
  ]),
  /** Non-drive-end (thrust) bearing change — a matched pair of angular-contact bearings. */
  'bearing.nde.replace': Object.freeze([
    Object.freeze({ itemId: 'BEARING_7306', qty: 2 }),
    Object.freeze({ itemId: 'GASKET_SET', qty: 1 }),
    Object.freeze({ itemId: 'LUBE_OIL_VG32', qty: 2 }),
  ]),
  /** Motor bearing change — both ends, because you are in there anyway. */
  'motor.bearing.replace': Object.freeze([
    Object.freeze({ itemId: 'BEARING_6208', qty: 2 }),
    Object.freeze({ itemId: 'GREASE_NLGI2', qty: 0.25 }),
  ]),
  /** Routine regrease at the interval. */
  'motor.regrease': Object.freeze([
    Object.freeze({ itemId: 'GREASE_NLGI2', qty: 0.02 }),
  ]),
  /** New impeller — the nine-week job. */
  'impeller.replace': Object.freeze([
    Object.freeze({ itemId: 'IMPELLER', qty: 1 }),
    Object.freeze({ itemId: 'WEAR_RING_SET', qty: 1 }),
    Object.freeze({ itemId: 'SHAFT_SLEEVE', qty: 1 }),
    Object.freeze({ itemId: 'GASKET_SET', qty: 1 }),
    Object.freeze({ itemId: 'SEAL_ORING_KIT', qty: 1 }),
  ]),
  /** Wear rings only — restores the clearance without touching the impeller. */
  'wearRing.replace': Object.freeze([
    Object.freeze({ itemId: 'WEAR_RING_SET', qty: 1 }),
    Object.freeze({ itemId: 'GASKET_SET', qty: 1 }),
  ]),
  /** Coupling element. */
  'coupling.replace': Object.freeze([
    Object.freeze({ itemId: 'COUPLING_ELEMENT', qty: 1 }),
  ]),
  /** Full pump overhaul: everything wetted and everything rotating. */
  'pump.overhaul': Object.freeze([
    Object.freeze({ itemId: 'SEAL_CARTRIDGE', qty: 1 }),
    Object.freeze({ itemId: 'SEAL_ORING_KIT', qty: 1 }),
    Object.freeze({ itemId: 'BEARING_6306', qty: 1 }),
    Object.freeze({ itemId: 'BEARING_7306', qty: 2 }),
    Object.freeze({ itemId: 'WEAR_RING_SET', qty: 1 }),
    Object.freeze({ itemId: 'SHAFT_SLEEVE', qty: 1 }),
    Object.freeze({ itemId: 'COUPLING_ELEMENT', qty: 1 }),
    Object.freeze({ itemId: 'GASKET_SET', qty: 1 }),
    Object.freeze({ itemId: 'FLANGE_GASKET', qty: 4 }),
    Object.freeze({ itemId: 'LUBE_OIL_VG32', qty: 3 }),
  ]),
  /** Control-valve plug and seat. */
  'valve.trim.replace': Object.freeze([
    Object.freeze({ itemId: 'VALVE_TRIM_KIT', qty: 1 }),
    Object.freeze({ itemId: 'VALVE_PACKING', qty: 1 }),
    Object.freeze({ itemId: 'FLANGE_GASKET', qty: 2 }),
  ]),
  /** Repack a sticking valve — the job that actually cures a stiction limit cycle. */
  'valve.repack': Object.freeze([
    Object.freeze({ itemId: 'VALVE_PACKING', qty: 1 }),
  ]),
  /** Actuator diaphragm. */
  'valve.actuator.repair': Object.freeze([
    Object.freeze({ itemId: 'VALVE_DIAPHRAGM', qty: 1 }),
    Object.freeze({ itemId: 'SEAL_ORING_KIT', qty: 1 }),
  ]),
  /** Non-return valve internals — the cure for a check valve that no longer checks. */
  'checkValve.overhaul': Object.freeze([
    Object.freeze({ itemId: 'CHECK_VALVE_KIT', qty: 1 }),
    Object.freeze({ itemId: 'FLANGE_GASKET', qty: 2 }),
  ]),
  /** Pull and wash the suction strainer basket. Costs a joint, nothing else. */
  'strainer.clean': Object.freeze([
    Object.freeze({ itemId: 'FLANGE_GASKET', qty: 1 }),
  ]),
  /** Replace a strainer basket that has been cleaned once too often and is holed. */
  'strainer.element.replace': Object.freeze([
    Object.freeze({ itemId: 'STRAINER_ELEMENT', qty: 1 }),
    Object.freeze({ itemId: 'FLANGE_GASKET', qty: 1 }),
  ]),
  /** Seal-flush filter cartridge change. Also happens automatically on differential pressure. */
  'filter.change': Object.freeze([
    Object.freeze({ itemId: 'FILTER_CARTRIDGE', qty: 1 }),
  ]),
  /** Bearing oil change at the interval. */
  'lube.change': Object.freeze([
    Object.freeze({ itemId: 'LUBE_OIL_VG32', qty: 2 }),
  ]),
  /** Chemical clean of the pipework to take built scale back off. */
  'pipe.descale': Object.freeze([
    Object.freeze({ itemId: 'CLEANING_ACID', qty: 2 }),
    Object.freeze({ itemId: 'CORROSION_INHIBITOR', qty: 20 }),
    Object.freeze({ itemId: 'FLANGE_GASKET', qty: 4 }),
  ]),
  /** Drive cooling fan — the VFD part that always goes first. */
  'vfd.fan.replace': Object.freeze([
    Object.freeze({ itemId: 'VFD_FAN', qty: 1 }),
  ]),
  /** DC bus capacitor bank. */
  'vfd.capacitors.replace': Object.freeze([
    Object.freeze({ itemId: 'VFD_CAPACITORS', qty: 1 }),
  ]),
  /** One five-point transmitter calibration, as-found and as-left. */
  'instrument.calibrate': Object.freeze([
    Object.freeze({ itemId: 'CAL_KIT_CONSUMABLES', qty: 1 }),
  ]),
  /** A calibration on a transmitter that needs a gas reference rather than a pressure one. */
  'instrument.calibrate.gas': Object.freeze([
    Object.freeze({ itemId: 'CAL_KIT_CONSUMABLES', qty: 1 }),
    Object.freeze({ itemId: 'CAL_GAS', qty: 1 }),
  ]),
  /** Send the reference standard away and get it back with a certificate. */
  'refStandard.recert': Object.freeze([
    Object.freeze({ itemId: 'CAL_REF_RECERT', qty: 1 }),
  ]),
  /** Reseal the hand test pump the technician calibrates with. */
  'testPump.service': Object.freeze([
    Object.freeze({ itemId: 'TEST_PUMP_SEALS', qty: 1 }),
  ]),
});

/** Every task id the stores knows a kit for, in table order. */
export const TASK_ORDER = Object.freeze(Object.keys(TASK_KITS));

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

/**
 * The catalogue before `consumedBy` is filled in. Split out so the reverse index can be DERIVED
 * from `TASK_KITS` rather than written twice — two hand-maintained copies of the same
 * relationship drift, and the way that failure shows up is a part that can never be reordered
 * because nothing appears to consume it.
 *
 * `min` is the reorder point and `max` the shelf maximum, both in the item's own unit. They are
 * set the way a real stores sets them: a fortnight of consumption for the things that move, and
 * "one, or none" for the things that do not move but stop the plant when they are needed.
 */
const CATALOGUE = [
  // --- mechanical seals ------------------------------------------------------------------
  {
    id: 'SEAL_CARTRIDGE',
    name: 'Cartridge mechanical seal, 45 mm, API 682 Cat 1 Type A',
    category: CATEGORY.SEAL,
    unit: 'ea',
    cost: 980,
    leadTime_d: 14,
    min: 1,
    max: 2,
  },
  {
    id: 'SEAL_FACES',
    name: 'Seal face set, carbon against silicon carbide',
    category: CATEGORY.SEAL,
    unit: 'set',
    cost: 310,
    leadTime_d: 10,
    min: 1,
    max: 2,
  },
  {
    id: 'SEAL_ORING_KIT',
    name: 'Seal elastomer set, FKM O-rings',
    category: CATEGORY.GASKET,
    unit: 'kit',
    cost: 45,
    leadTime_d: 5,
    min: 2,
    max: 6,
  },
  {
    id: 'GLAND_PACKING',
    name: 'Gland packing, PTFE-graphite braid, 10 mm square',
    category: CATEGORY.GASKET,
    unit: 'm',
    cost: 38,
    leadTime_d: 3,
    min: 2,
    max: 8,
  },
  // --- bearings --------------------------------------------------------------------------
  {
    id: 'BEARING_6306',
    name: 'Deep-groove ball bearing 6306 C3, drive end',
    category: CATEGORY.BEARING,
    unit: 'ea',
    cost: 42,
    leadTime_d: 4,
    min: 2,
    max: 6,
  },
  {
    id: 'BEARING_7306',
    name: 'Angular-contact bearing 7306 BECBM, thrust end, matched pair',
    category: CATEGORY.BEARING,
    unit: 'ea',
    cost: 96,
    leadTime_d: 7,
    min: 2,
    max: 4,
  },
  {
    id: 'BEARING_6208',
    name: 'Motor bearing 6208-2Z C3',
    category: CATEGORY.BEARING,
    unit: 'ea',
    cost: 34,
    leadTime_d: 4,
    min: 2,
    max: 6,
  },
  // --- static sealing --------------------------------------------------------------------
  {
    id: 'GASKET_SET',
    name: 'Pump casing joint and housing gasket set',
    category: CATEGORY.GASKET,
    unit: 'set',
    cost: 65,
    leadTime_d: 7,
    min: 1,
    max: 3,
  },
  {
    id: 'FLANGE_GASKET',
    name: 'Spiral-wound flange gasket, DN150 PN16',
    category: CATEGORY.GASKET,
    unit: 'ea',
    cost: 22,
    leadTime_d: 3,
    min: 4,
    max: 12,
  },
  // --- rotating spares -------------------------------------------------------------------
  {
    id: 'COUPLING_ELEMENT',
    name: 'Flexible coupling element',
    category: CATEGORY.ROTATING,
    unit: 'ea',
    cost: 78,
    leadTime_d: 6,
    min: 1,
    max: 3,
  },
  {
    id: 'IMPELLER',
    // Nine weeks because it is a casting: pattern, pour, machine, balance, freight. The single
    // longest lead time in the catalogue and the reason cavitation damage is a strategic problem
    // rather than a maintenance one.
    name: 'Impeller, duplex stainless casting, full diameter',
    category: CATEGORY.ROTATING,
    unit: 'ea',
    cost: 2450,
    leadTime_d: 63,
    min: 0,
    max: 1,
  },
  {
    id: 'WEAR_RING_SET',
    name: 'Casing and impeller wear ring set',
    category: CATEGORY.ROTATING,
    unit: 'set',
    cost: 420,
    leadTime_d: 28,
    min: 0,
    max: 2,
  },
  {
    id: 'SHAFT_SLEEVE',
    name: 'Shaft sleeve, 431 stainless, hard-faced',
    category: CATEGORY.ROTATING,
    unit: 'ea',
    cost: 185,
    leadTime_d: 21,
    min: 0,
    max: 2,
  },
  // --- valves ----------------------------------------------------------------------------
  {
    id: 'VALVE_TRIM_KIT',
    name: 'Control valve plug and seat, equal-percentage trim',
    category: CATEGORY.VALVE,
    unit: 'kit',
    cost: 1150,
    leadTime_d: 35,
    min: 0,
    max: 1,
  },
  {
    id: 'VALVE_PACKING',
    name: 'Valve stem packing, live-loaded PTFE V-ring set',
    category: CATEGORY.VALVE,
    unit: 'set',
    cost: 96,
    leadTime_d: 10,
    min: 1,
    max: 3,
  },
  {
    id: 'VALVE_DIAPHRAGM',
    name: 'Actuator diaphragm, nitrile on nylon',
    category: CATEGORY.VALVE,
    unit: 'ea',
    cost: 210,
    leadTime_d: 14,
    min: 0,
    max: 2,
  },
  {
    id: 'CHECK_VALVE_KIT',
    name: 'Non-return valve disc, spring and seat kit',
    category: CATEGORY.VALVE,
    unit: 'kit',
    cost: 145,
    leadTime_d: 18,
    min: 0,
    max: 2,
  },
  // --- strainers and filters -------------------------------------------------------------
  {
    id: 'STRAINER_ELEMENT',
    name: 'Suction strainer basket, 3 mm perforated stainless',
    category: CATEGORY.FILTER,
    unit: 'ea',
    cost: 130,
    leadTime_d: 12,
    min: 1,
    max: 4,
  },
  {
    id: 'FILTER_CARTRIDGE',
    name: 'Seal flush filter cartridge, 25 micron pleated',
    category: CATEGORY.FILTER,
    unit: 'ea',
    cost: 28,
    leadTime_d: 5,
    min: 4,
    max: 16,
  },
  // --- lubricants ------------------------------------------------------------------------
  {
    id: 'LUBE_OIL_VG32',
    name: 'Bearing oil, ISO VG 32',
    category: CATEGORY.LUBRICANT,
    unit: 'L',
    cost: 6.5,
    leadTime_d: 5,
    min: 10,
    max: 40,
  },
  {
    id: 'LUBE_OIL_VG68',
    name: 'Bearing oil, ISO VG 68, for the hot-service machine',
    category: CATEGORY.LUBRICANT,
    unit: 'L',
    cost: 7.2,
    leadTime_d: 5,
    min: 5,
    max: 20,
  },
  {
    id: 'GREASE_NLGI2',
    name: 'Lithium-complex grease, NLGI 2',
    category: CATEGORY.LUBRICANT,
    unit: 'kg',
    cost: 14,
    leadTime_d: 5,
    min: 1,
    max: 4,
  },
  // --- utilities -------------------------------------------------------------------------
  {
    id: 'FLUSH_WATER',
    // Metered off the treated-water header, so it cannot stock out — but it is emphatically not
    // free, and a Plan 32 flush running continuously on both machines is one of the larger
    // consumables on a skid this size. Sites that meter it are often surprised.
    name: 'Seal flush water, treated, API Plan 32',
    category: CATEGORY.UTILITY,
    unit: 'm3',
    cost: 1.4,
    leadTime_d: 0,
    min: 20,
    max: 200,
    utility: true,
  },
  {
    id: 'INSTRUMENT_AIR',
    name: 'Instrument air, dried, 7 barg',
    category: CATEGORY.UTILITY,
    unit: 'Nm3',
    cost: 0.015,
    leadTime_d: 0,
    min: 3000,
    max: 20000,
    utility: true,
  },
  // --- treatment chemicals ---------------------------------------------------------------
  {
    id: 'ANTISCALANT',
    name: 'Phosphonate antiscalant, threshold inhibitor',
    category: CATEGORY.CHEMICAL,
    unit: 'L',
    cost: 4.8,
    leadTime_d: 21,
    min: 200,
    max: 1000,
    dose: {
      // A threshold inhibitor works by poisoning crystal growth sites, so the response saturates:
      // past a few mg/L there are no more sites to poison and the extra product is money in the
      // drain. `fMin` is that floor and `c50_ppm` the concentration at which most of the benefit
      // has already been bought. Doses quoted on CIRCULATED flow, side-stream injection.
      nominal_ppm: 6,
      max_ppm: 20,
      density_kgL: 1.15,
      fMin: 0.12,
      c50_ppm: 3.5,
      acts: ACTS_ON.SCALE,
    },
  },
  {
    id: 'CORROSION_INHIBITOR',
    name: 'Filming corrosion inhibitor, phosphate-azole blend',
    category: CATEGORY.CHEMICAL,
    unit: 'L',
    cost: 6.2,
    leadTime_d: 21,
    min: 150,
    max: 1000,
    dose: {
      // A filming inhibitor has to establish and hold a monolayer, so its response is closer to
      // linear over the working range than the antiscalant's and it does not saturate as sharply.
      nominal_ppm: 5,
      max_ppm: 15,
      density_kgL: 1.1,
      fMin: 0.2,
      c50_ppm: 8,
      acts: ACTS_ON.CORROSION,
    },
  },
  {
    id: 'BIOCIDE',
    name: 'Non-oxidising biocide, isothiazolinone',
    category: CATEGORY.CHEMICAL,
    unit: 'L',
    cost: 9.5,
    leadTime_d: 28,
    min: 100,
    max: 400,
    dose: {
      // Quoted as the continuous equivalent of the weekly slug dose a non-oxidising programme
      // actually uses, because the simulator has no weekly clock an operator would set.
      nominal_ppm: 3,
      max_ppm: 12,
      density_kgL: 1.05,
      fMin: 0.35,
      c50_ppm: 2,
      acts: ACTS_ON.BIOFILM,
    },
  },
  {
    id: 'CLEANING_ACID',
    name: 'Sulphamic acid descaler with inhibitor, 25 kg',
    category: CATEGORY.CHEMICAL,
    unit: 'sack',
    cost: 78,
    leadTime_d: 14,
    min: 0,
    max: 4,
  },
  // --- drive -----------------------------------------------------------------------------
  {
    id: 'VFD_FAN',
    name: 'Drive heatsink cooling fan',
    category: CATEGORY.DRIVE,
    unit: 'ea',
    cost: 165,
    leadTime_d: 21,
    min: 0,
    max: 2,
  },
  {
    id: 'VFD_CAPACITORS',
    name: 'DC bus capacitor bank kit',
    category: CATEGORY.DRIVE,
    unit: 'kit',
    cost: 640,
    leadTime_d: 42,
    min: 0,
    max: 1,
  },
  // --- what a calibration itself uses -----------------------------------------------------
  {
    id: 'CAL_KIT_CONSUMABLES',
    name: 'Calibration consumables: test hose, quick-connect seals, certificate stationery',
    category: CATEGORY.CALIBRATION,
    unit: 'set',
    cost: 12,
    leadTime_d: 7,
    min: 5,
    max: 25,
  },
  {
    id: 'CAL_GAS',
    name: 'Certified zero and span calibration gas, disposable cylinder',
    category: CATEGORY.CALIBRATION,
    unit: 'ea',
    cost: 190,
    leadTime_d: 14,
    min: 0,
    max: 2,
  },
  {
    id: 'CAL_REF_RECERT',
    // The uncertainty on the reference standard is the floor under every certificate the site
    // issues, and it is only defensible while the standard's own certificate is in date.
    name: 'Reference standard recertification, ISO/IEC 17025 accredited laboratory',
    category: CATEGORY.CALIBRATION,
    unit: 'ea',
    cost: 420,
    leadTime_d: 21,
    min: 0,
    max: 1,
  },
  {
    id: 'TEST_PUMP_SEALS',
    name: 'Hand test pump seal kit',
    category: CATEGORY.CALIBRATION,
    unit: 'kit',
    cost: 55,
    leadTime_d: 10,
    min: 0,
    max: 2,
  },
];

/**
 * Which tasks draw a given item, derived once from {@link TASK_KITS}.
 * @returns {object} item id to a frozen array of task ids
 */
function buildConsumedBy() {
  const out = {};
  for (const item of CATALOGUE) out[item.id] = [];
  for (const taskId of TASK_ORDER) {
    for (const line of TASK_KITS[taskId]) {
      if (out[line.itemId] && !out[line.itemId].includes(taskId)) out[line.itemId].push(taskId);
    }
  }
  return out;
}

/**
 * The stores catalogue: every part, chemical and utility the rig can consume, with what it costs,
 * how long it takes to arrive, the reorder point, the shelf maximum, and which maintenance tasks
 * draw it.
 *
 * Frozen, and the single source of truth. Live stock levels are in the state object from
 * {@link createStores}, never here — a catalogue that mutates is a catalogue nobody can price a
 * decision against.
 */
export const ITEMS = Object.freeze(CATALOGUE.map((item) => {
  const consumedBy = Object.freeze(buildConsumedBy()[item.id].slice());
  return Object.freeze({
    ...item,
    utility: item.utility === true,
    dose: item.dose ? Object.freeze({ ...item.dose }) : null,
    consumedBy,
  });
}));

/** The catalogue by id, so a lookup is not a linear scan on every consumption tick. */
const ITEM_BY_ID = Object.freeze(Object.fromEntries(ITEMS.map((i) => [i.id, i])));

/** The ids of the chemicals that are dosed continuously, in catalogue order. */
export const DOSED_CHEMICALS = Object.freeze(ITEMS.filter((i) => i.dose).map((i) => i.id));

/**
 * Look one item up in the catalogue.
 * @param {string} itemId a catalogue id
 * @returns {object|null} the frozen item, or null if there is no such item
 */
export function itemOf(itemId) {
  return (typeof itemId === 'string' && ITEM_BY_ID[itemId]) || null;
}

/**
 * The bill of materials for a maintenance task.
 * @param {string} taskId a `TASK_KITS` id
 * @returns {{itemId:string, qty:number}[]} the kit, or an empty array for an unknown task
 */
export function kitFor(taskId) {
  const kit = typeof taskId === 'string' ? TASK_KITS[taskId] : null;
  return kit ? kit.map((l) => ({ itemId: l.itemId, qty: l.qty })) : [];
}

// ---------------------------------------------------------------------------------------------
// Engineering rates for the running consumptions
// ---------------------------------------------------------------------------------------------

/**
 * Continuous consumption rates, each quoted against the driver that produces it rather than
 * against the clock. Every one of these is a number a reader is entitled to argue with, so every
 * one of them says where it came from.
 */
const RATE = Object.freeze({
  /**
   * Seal flush injection, m3 per seal per RUNNING hour. API 682 Plan 32 injection for a 45 mm
   * seal on cool water is of the order 0.2 to 0.5 m3/h; 0.3 is the middle of that. Charged only
   * while the machine turns, because a stopped pump's flush is isolated.
   */
  flush_m3_per_sealH: 0.3,

  /**
   * Standing air bleed per digital positioner, Nm3 per hour. A modern two-wire positioner bleeds
   * of the order 0.1 to 0.2 Nm3/h at 7 barg supply even holding still. Two positioners on this
   * rig, FCV-101 and PCV-101.
   */
  airBleed_Nm3_per_positionerH: 0.15,

  /**
   * Air displaced per unit of FRACTIONAL stem travel, Nm3. A 50 litre spring-diaphragm actuator
   * working at about 2 barg vents roughly 0.15 Nm3 over a full stroke. This is the term that
   * makes a hunting loop cost money: a limit cycle strokes a valve thousands of times a day.
   */
  airPerTravel_Nm3: 0.15,

  /**
   * Bearing oil make-up, litres per 1000 BEARING hours per machine, at 60 C. Breathing losses and
   * seepage past the housing lip seals. Small, and honestly so — oil is consumed by scheduled
   * CHANGES, not by leakage, and `lube.change` is where the litres actually go.
   */
  oil_L_per_1000H: 0.15,

  /**
   * The oxidation rule of thumb for mineral oil: life halves, so consumption of the additive
   * package doubles, for every 10 K above 60 C. Applied to the casing liquid temperature, which
   * is the closest thing the plant model has to a bearing housing temperature.
   */
  oilRefT_C: 60,
  oilDoublePer_K: 10,

  /**
   * Motor regreasing: 10 g every 4000 running hours for a 6208 at 2950 rpm, from the ordinary
   * bearing-manufacturer relubrication tables. Expressed as kg per running hour per motor.
   */
  grease_kg_per_motorH: 0.010 / 4000,

  /**
   * Flush filter cartridge life, m3 of flush water through it. Set from plant practice rather
   * than from a solids balance: a 25 micron pleated cartridge on a clean flush duty is changed on
   * differential pressure about every three months, which at 0.3 m3/h is a little over 600 m3.
   */
  filterLife_m3: 700,

  /** Clean differential pressure across a new cartridge, bar. */
  filterCleanDP_bar: 0.15,

  /**
   * Chemical holding time. How long a treatment concentration takes to wash out of the system
   * once dosing stops — the cooling-water "holding time index", ordinarily 2 to 7 days. It is why
   * a stockout does not show up as a step in the fouling rate: the protection decays over days,
   * and the consequence arrives weeks after that.
   */
  chemHoldTime_h: 5 * 24,
});

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * Is this a plain object we can safely read fields off?
 * @param {*} v anything
 * @returns {boolean} true for a non-null, non-array object
 */
function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A finite number, or a fallback.
 * @param {*} v the candidate
 * @param {number} d the fallback
 * @returns {number} `v` when it is a finite number, otherwise `d`
 */
function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * Round a quantity to the precision the stores actually counts in, so a shelf never holds
 * 2.9999999999 seals and a reason sentence never reads "short by 0.9999999999".
 * @param {number} q a quantity
 * @returns {number} the quantity to six decimal places
 */
function tidy(q) {
  return Math.round(q * 1e6) / 1e6;
}

/**
 * Allocate the stores.
 *
 * `config` is the realism configuration, read for two things only: the `stock` rate, which says
 * how full the shelves are on day one, and the `leadTime`, `cost` and `consumption` severities,
 * which are captured here so that `order()` — which is not given a configuration — can price and
 * schedule a purchase. `stepConsumption()` refreshes them every scan, so a user who moves a rate
 * mid-session sees it take effect on the next order rather than on the next reload.
 *
 * A `stock` rate of 1.0 gives a stores that is exactly at its maximum on every line, because that
 * is what "reviewed last month" means and because a test that cannot construct a known starting
 * point cannot check anything else. Below 1.0 the shortfall is drawn per line rather than applied
 * evenly: a run-down stores is not uniformly 60% full, it is full of the cheap things and empty
 * of the expensive ones, which is exactly the stores that turns a seal change into a six-week
 * wait.
 *
 * @param {object} config the realism configuration from `realism/config.js`
 * @param {(() => number)|{s:number}} [rng] a generator returning [0,1), or an RNG state from
 *   `core/util.js`. Omitted, one is seeded from `config.seed` so the same configuration always
 *   produces the same stores.
 * @returns {object} the mutable stores state
 */
export function createStores(config, rng) {
  const seed = isRecord(config) ? num(config.seed, 20240517) : 20240517;
  const rngState = createRng(seed ^ 0x53544f52);
  let draw;
  if (typeof rng === 'function') draw = rng;
  else if (isRecord(rng) && typeof rng.s === 'number') draw = () => nextFloat(rng);
  else draw = () => nextFloat(rngState);
  const gauss = () => nextGaussian(rngState);

  const stockFrac = clamp(rateOf(config, 'stock'), 0, 1);
  const st = {
    version: CONSUMABLES_VERSION,
    /** Mirrors the CONSUMABLES switch. False makes every effect on the plant exactly neutral. */
    enabled: isOn(config, FEATURE.CONSUMABLES),
    /** Equipment hours since the stores was opened. Advanced only by `stepConsumption`. */
    hours_h: 0,
    /** The same clock in days — what `order()` and `receiveDeliveries()` count in. */
    days_d: 0,
    /** On the shelf now, item id to quantity in the item's own unit. */
    stock: {},
    /** Lifetime issue, item id to quantity. The audit trail behind every consumption claim. */
    used: {},
    /** Outstanding purchase orders, oldest first. */
    onOrder: [],
    /** Next purchase order number. */
    nextPo: 1,
    /** Live dosing, chemical id to {set_ppm, delivered_ppm, held_ppm, starved}. */
    dosing: {},
    /** Seal flush filter condition. */
    filter: { load: 0, dp_bar: RATE.filterCleanDP_bar, changes: 0 },
    /** Money spent acquiring stock, by category group. */
    cost: {
      parts: 0, chemicals: 0, utilities: 0, calibration: 0,
    },
    /** Item ids the plant asked for and could not have. Cleared when stock returns. */
    starved: {},
    /** Every refusal, in order. This is what explains a job that did not happen. */
    stockouts: [],
    /** Deliveries, changes and starvations since the caller last drained it. */
    events: [],
    /** Captured severity multipliers — see the note above. */
    leadTimeMul: rateOf(config, 'leadTime'),
    costMul: rateOf(config, 'cost'),
    consumptionMul: rateOf(config, 'consumption'),
    /** Last seen valve travel, for the air consumption difference. */
    _travel: { fcv: null, pcv: null },
  };

  for (const item of ITEMS) {
    let qty;
    if (item.utility) {
      // A utility is metered off a header, so day one is always a full header.
      qty = item.max;
    } else if (stockFrac >= 1) {
      qty = item.max;
    } else {
      // Draw around the target fraction, then bias the expensive lines downward: the parts a
      // stores runs out of first are the ones somebody declined to buy.
      const priceBias = clamp(1 - Math.log10(1 + item.cost / 100) * 0.22, 0.45, 1);
      const jitter = clamp(1 + gauss() * 0.25, 0.25, 1.35);
      qty = item.max * stockFrac * priceBias * jitter;
      qty = item.unit === 'ea' || item.unit === 'set' || item.unit === 'kit'
        ? Math.floor(qty + (draw() * 0.5))
        : tidy(qty);
    }
    st.stock[item.id] = clamp(num(qty, 0), 0, item.max);
    st.used[item.id] = 0;
    if (item.dose) {
      st.dosing[item.id] = {
        set_ppm: item.dose.nominal_ppm,
        delivered_ppm: item.dose.nominal_ppm,
        // The plant arrives already treated, so the protection is in place on scan one. Starting
        // it at zero would make switching the feature on a fouling event nobody caused.
        held_ppm: item.dose.nominal_ppm,
        starved: false,
      };
    }
  }
  return st;
}

// ---------------------------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------------------------

/**
 * How much of an item is on the shelf.
 * @param {object} st the stores
 * @param {string} itemId a catalogue id
 * @returns {number} the quantity, or 0 for an unknown item or a missing stores
 */
export function stockOf(st, itemId) {
  if (!isRecord(st) || !isRecord(st.stock)) return 0;
  return num(st.stock[itemId], 0);
}

/**
 * How much of an item is on order but not yet delivered.
 * @param {object} st the stores
 * @param {string} itemId a catalogue id
 * @returns {number} the outstanding quantity
 */
export function onOrderOf(st, itemId) {
  if (!isRecord(st) || !Array.isArray(st.onOrder)) return 0;
  let q = 0;
  for (const po of st.onOrder) if (po.itemId === itemId) q += num(po.qty, 0);
  return tidy(q);
}

/**
 * When the next outstanding delivery of an item is due.
 * @param {object} st the stores
 * @param {string} itemId a catalogue id
 * @returns {number|null} the earliest eta in stores days, or null if nothing is on order
 */
export function nextEta_d(st, itemId) {
  if (!isRecord(st) || !Array.isArray(st.onOrder)) return null;
  let best = null;
  for (const po of st.onOrder) {
    if (po.itemId !== itemId) continue;
    if (best === null || po.eta_d < best) best = po.eta_d;
  }
  return best;
}

/**
 * The clause that tells an operator what to do about a part they have not got: when the
 * outstanding order lands, or how long a new one would take.
 * @param {object} st the stores
 * @param {object} item the frozen catalogue item
 * @returns {string} a sentence fragment, always ending in a full stop
 */
function whenClause(st, item) {
  const eta = nextEta_d(st, item.id);
  if (eta !== null) {
    const days = Math.max(0, eta - num(st.days_d, 0));
    return `${onOrderOf(st, item.id)} ${item.unit} are on order, due in ${days.toFixed(1)} days.`;
  }
  const lead = item.leadTime_d * num(st.leadTimeMul, 1);
  if (lead <= 0) return 'It is a metered utility and should never be short — check the supply header.';
  return `Nothing is on order; the catalogue lead time is ${lead.toFixed(0)} days from raising the requisition.`;
}

/**
 * Take an item off the shelf, all or nothing.
 *
 * All or nothing is the whole point. A maintenance job that can start with three of the four
 * things it needs is a job that ends with a machine in pieces and a hole in the schedule, so a
 * short line refuses the issue and says by how much. `shortBy` is on the result because the
 * question an operator asks next is never "did it work" but "how many do I need".
 *
 * @param {object} st the stores
 * @param {string} itemId a catalogue id
 * @param {number} qty how many, in the item's own unit
 * @returns {{ok:boolean, reason?:string, shortBy?:number, cost?:number}} ok, or why not
 */
export function consume(st, itemId, qty) {
  if (!isRecord(st) || !isRecord(st.stock)) {
    return { ok: false, reason: 'There is no stores to draw from.' };
  }
  const item = itemOf(itemId);
  if (!item) {
    return { ok: false, reason: `There is no stores item called "${String(itemId)}".` };
  }
  const want = num(qty, NaN);
  if (!(want > 0)) {
    return { ok: false, reason: `A stores issue has to be for a positive quantity; ${String(qty)} is not one.` };
  }
  const have = stockOf(st, itemId);
  if (have + 1e-9 < want) {
    const shortBy = tidy(want - have);
    st.stockouts.push({
      at_h: num(st.hours_h, 0), itemId, need: want, have, shortBy,
    });
    st.starved[itemId] = true;
    return {
      ok: false,
      shortBy,
      reason: `Stores has ${tidy(have)} ${item.unit} of ${item.name} against the ${tidy(want)} `
        + `this job needs — short by ${shortBy}. ${whenClause(st, item)}`,
    };
  }
  st.stock[itemId] = tidy(have - want);
  st.used[itemId] = tidy(num(st.used[itemId], 0) + want);
  delete st.starved[itemId];
  return { ok: true, cost: tidy(want * item.cost * num(st.costMul, 1)) };
}

/**
 * Normalise a kit argument into lines.
 * @param {string|Array<{itemId:string, qty:number}>} needs a task id or an explicit kit
 * @returns {{itemId:string, qty:number}[]} the lines, aggregated by item
 */
function linesOf(needs) {
  const raw = typeof needs === 'string' ? kitFor(needs) : (Array.isArray(needs) ? needs : []);
  const byItem = new Map();
  for (const line of raw) {
    if (!isRecord(line)) continue;
    const q = num(line.qty, 0);
    if (!(q > 0)) continue;
    byItem.set(line.itemId, tidy(num(byItem.get(line.itemId), 0) + q));
  }
  return [...byItem.entries()].map(([itemId, qty]) => ({ itemId, qty }));
}

/**
 * Can the stores supply a job, without taking anything off the shelf?
 *
 * The question a planner asks before they book a shutdown, and the one `performTask()` in the
 * machinery model has to ask before it lets anybody near a machine. Every short line is reported,
 * not just the first — a planner who fixes one shortage and discovers a second the following week
 * has been failed by their system, not by their supplier.
 *
 * @param {object} st the stores
 * @param {string|Array<{itemId:string, qty:number}>} needs a `TASK_KITS` id, or explicit lines
 * @returns {{ok:boolean, reason?:string, missing:object[], lines:object[]}} whether the job can go
 *   ahead, why not, and what is short
 */
export function canSupply(st, needs) {
  const lines = linesOf(needs);
  if (!isRecord(st) || !isRecord(st.stock)) {
    return { ok: false, reason: 'There is no stores to draw from.', missing: [], lines };
  }
  const missing = [];
  for (const line of lines) {
    const item = itemOf(line.itemId);
    if (!item) continue;
    const have = stockOf(st, line.itemId);
    if (have + 1e-9 < line.qty) {
      missing.push({
        itemId: line.itemId,
        name: item.name,
        unit: item.unit,
        need: line.qty,
        have: tidy(have),
        shortBy: tidy(line.qty - have),
        eta_d: nextEta_d(st, line.itemId),
        leadTime_d: tidy(item.leadTime_d * num(st.leadTimeMul, 1)),
      });
    }
  }
  if (missing.length === 0) return { ok: true, missing: [], lines };
  const worst = missing.slice().sort((a, b) => {
    const ea = a.eta_d === null ? a.leadTime_d : Math.max(0, a.eta_d - num(st.days_d, 0));
    const eb = b.eta_d === null ? b.leadTime_d : Math.max(0, b.eta_d - num(st.days_d, 0));
    return eb - ea;
  })[0];
  const list = missing.map((m) => `${m.shortBy} ${m.unit} of ${m.name}`).join('; ');
  return {
    ok: false,
    missing,
    lines,
    reason: `This job cannot be issued: stores is short ${list}. `
      + `${whenClause(st, itemOf(worst.itemId))}`,
  };
}

/**
 * Issue a whole kit against a maintenance task, all or nothing.
 *
 * THE MECHANISM THIS MODULE EXISTS FOR. A task whose kit cannot be filled does not happen, and
 * the reason it did not happen is a sentence naming the part and the wait. Everything else here —
 * the lead times, the reorder points, the opening stock rate — exists to make that refusal arrive
 * at a moment the user can learn something from.
 *
 * @param {object} st the stores
 * @param {string|Array<{itemId:string, qty:number}>} needs a `TASK_KITS` id, or explicit lines
 * @returns {{ok:boolean, reason?:string, missing?:object[], consumed?:object[], cost?:number}}
 *   ok and what was drawn, or why the job is blocked
 */
export function consumeKit(st, needs) {
  const check = canSupply(st, needs);
  if (!check.ok) {
    if (isRecord(st) && Array.isArray(st.stockouts)) {
      for (const m of check.missing) {
        st.stockouts.push({
          at_h: num(st.hours_h, 0),
          itemId: m.itemId,
          taskId: typeof needs === 'string' ? needs : null,
          need: m.need,
          have: m.have,
          shortBy: m.shortBy,
        });
        st.starved[m.itemId] = true;
      }
    }
    return { ok: false, reason: check.reason, missing: check.missing };
  }
  const consumed = [];
  let cost = 0;
  for (const line of check.lines) {
    const r = consume(st, line.itemId, line.qty);
    // canSupply has already proved every line, so a failure here would be a corrupted stores
    // rather than a shortage; report it as such instead of leaving a half-issued kit.
    if (!r.ok) return { ok: false, reason: r.reason, missing: [] };
    consumed.push({ itemId: line.itemId, qty: line.qty });
    cost += num(r.cost, 0);
  }
  return { ok: true, consumed, cost: tidy(cost) };
}

// ---------------------------------------------------------------------------------------------
// Purchasing
// ---------------------------------------------------------------------------------------------

/**
 * Raise a purchase order.
 *
 * The cost is booked NOW, at the moment of committing, not when the box arrives. That is both how
 * a maintenance budget actually works and the thing that makes the decision honest: a user who
 * fills every rack against every eventuality has spent the money whether or not anything ever
 * breaks, and the scorecard should say so on the day they did it.
 *
 * The delivery date carries a modest, seeded slip on top of the catalogue lead time, because
 * suppliers slip and a plant that can plan to the day is not a plant. The slip is never earlier
 * than the quoted lead time — nothing in a stores ever arrives early — so `eta_d` is a promise the
 * simulator keeps exactly.
 *
 * @param {object} st the stores
 * @param {string} itemId a catalogue id
 * @param {number} qty how many, in the item's own unit
 * @param {number} [now_d] the stores day the order is raised on; defaults to the stores' own clock
 * @returns {{ok:boolean, reason?:string, eta_d?:number, cost?:number, po?:number}} the promise
 */
export function order(st, itemId, qty, now_d) {
  if (!isRecord(st) || !Array.isArray(st.onOrder)) {
    return { ok: false, reason: 'There is no stores to order into.' };
  }
  const item = itemOf(itemId);
  if (!item) {
    return { ok: false, reason: `There is no stores item called "${String(itemId)}" to order.` };
  }
  const want = num(qty, NaN);
  if (!(want > 0)) {
    return { ok: false, reason: `A purchase order has to be for a positive quantity; ${String(qty)} is not one.` };
  }
  const day = num(now_d, num(st.days_d, 0));
  const headroom = tidy(item.max - stockOf(st, itemId) - onOrderOf(st, itemId));
  if (want > headroom + 1e-9) {
    return {
      ok: false,
      reason: `The shelf for ${item.name} holds ${item.max} ${item.unit} and there are already `
        + `${tidy(stockOf(st, itemId))} on it with ${onOrderOf(st, itemId)} on order. `
        + `Order ${Math.max(0, headroom)} ${item.unit} or fewer, or raise the maximum.`,
    };
  }

  const lead = item.leadTime_d * num(st.leadTimeMul, 1);
  // A seeded, one-sided slip: half the orders land within a tenth of the quote, the tail is the
  // casting that missed the pour. Never negative, because early delivery is not a thing.
  const slip = lead > 0 ? lead * Math.abs(nextGaussian(createRng((st.nextPo * 2654435761) >>> 0))) * 0.18 : 0;
  const eta = tidy(day + lead + slip);
  const cost = tidy(want * item.cost * num(st.costMul, 1));
  const po = st.nextPo;
  st.nextPo += 1;
  st.onOrder.push({
    po, itemId, qty: tidy(want), orderedAt_d: tidy(day), eta_d: eta, cost,
  });
  bookCost(st, item, cost);
  return {
    ok: true, po, eta_d: eta, cost,
  };
}

/**
 * Book a purchase against the right cost bucket.
 * @param {object} st the stores
 * @param {object} item the frozen catalogue item
 * @param {number} cost the amount
 * @returns {void}
 */
function bookCost(st, item, cost) {
  const c = num(cost, 0);
  if (item.category === CATEGORY.CHEMICAL) st.cost.chemicals += c;
  else if (item.category === CATEGORY.UTILITY) st.cost.utilities += c;
  else if (item.category === CATEGORY.CALIBRATION) st.cost.calibration += c;
  else st.cost.parts += c;
}

/**
 * Take delivery of everything that is due.
 *
 * Nothing arrives before the `eta_d` the order was promised on, and nothing arrives twice: a
 * received order leaves `onOrder`. `stepConsumption()` calls this itself as the stores clock
 * advances, so a caller that never calls it still gets its deliveries — but it is exported
 * because a user pressing "goods in" is a real thing and because a test needs to be able to stand
 * exactly one hour short of a delivery and see nothing.
 *
 * @param {object} st the stores
 * @param {number} [now_d] the stores day; defaults to the stores' own clock
 * @returns {object[]} the orders received on this call, oldest first
 */
export function receiveDeliveries(st, now_d) {
  if (!isRecord(st) || !Array.isArray(st.onOrder)) return [];
  const day = num(now_d, num(st.days_d, 0));
  const received = [];
  const still = [];
  for (const po of st.onOrder) {
    if (po.eta_d <= day + 1e-9) {
      const item = itemOf(po.itemId);
      const cap = item ? item.max : Infinity;
      st.stock[po.itemId] = tidy(Math.min(cap, stockOf(st, po.itemId) + num(po.qty, 0)));
      delete st.starved[po.itemId];
      received.push({ ...po, receivedAt_d: tidy(day) });
      st.events.push({
        at_h: num(st.hours_h, 0),
        kind: 'DELIVERY',
        itemId: po.itemId,
        qty: po.qty,
        text: `PO ${po.po}: ${po.qty} ${item ? item.unit : ''} of ${item ? item.name : po.itemId} received.`,
      });
    } else {
      still.push(po);
    }
  }
  st.onOrder = still;
  return received;
}

/**
 * What the stores should be buying, and why.
 *
 * The rule is the ordinary one — order up to the maximum when stock plus what is already on order
 * has fallen to the reorder point — and the value is entirely in `why`, which states the wait. A
 * reorder report that says "BEARING_6306: 2" tells a user nothing they can act on; one that says
 * the drive-end bearing is on its reorder point and is four days from the gate tells them whether
 * to care.
 *
 * Sorted by how much trouble the shortage would be: the wait, weighted by how far below the point
 * the line has fallen. The impeller nobody has ordered comes first.
 *
 * @param {object} st the stores
 * @param {number} [now_d] the stores day; defaults to the stores' own clock
 * @returns {{itemId:string, qty:number, why:string, urgency:number}[]} what to raise, worst first
 */
export function reorderSuggestions(st, now_d) {
  if (!isRecord(st) || !isRecord(st.stock)) return [];
  const day = num(now_d, num(st.days_d, 0));
  const out = [];
  for (const item of ITEMS) {
    if (item.utility) continue;
    const have = stockOf(st, item.id);
    const coming = onOrderOf(st, item.id);
    const effective = have + coming;
    if (effective > item.min + 1e-9) continue;
    const qty = tidy(item.max - effective);
    if (!(qty > 0)) continue;
    const lead = item.leadTime_d * num(st.leadTimeMul, 1);
    const eta = nextEta_d(st, item.id);
    const shortfall = clamp((item.min + 1 - effective) / (item.min + 1), 0, 1);
    const jobs = item.consumedBy.length;
    const waiting = eta === null ? lead : Math.max(0, eta - day);
    out.push({
      itemId: item.id,
      qty,
      urgency: tidy(waiting * (0.4 + shortfall) * (jobs > 0 ? 1 : 0.5)),
      why: `${tidy(have)} ${item.unit} on the shelf against a reorder point of ${item.min}`
        + `${coming > 0 ? ` with ${coming} on order` : ''}. `
        + `${lead.toFixed(0)} days from order to gate`
        + `${jobs > 0 ? `, and ${jobs === 1 ? 'the job that needs it is' : `the ${jobs} jobs that need it are`} ${item.consumedBy.join(', ')}` : ''}. `
        + `Ordering after the failure means ${lead.toFixed(0)} days of running without the spare.`,
    });
  }
  return out.sort((a, b) => b.urgency - a.urgency);
}

// ---------------------------------------------------------------------------------------------
// Dosing — the chain that reaches the plant
// ---------------------------------------------------------------------------------------------

/**
 * Set the dose rate for a treatment chemical, in mg/L of circulated flow.
 *
 * @param {object} st the stores
 * @param {string} chemicalId one of {@link DOSED_CHEMICALS}
 * @param {number} rate the dose, ppm (mg/L) on circulated flow; 0 stops the dose
 * @returns {{ok:boolean, reason?:string}} ok, or why not
 */
export function setDosing(st, chemicalId, rate) {
  if (!isRecord(st) || !isRecord(st.dosing)) {
    return { ok: false, reason: 'There is no stores to set a dose on.' };
  }
  const item = itemOf(chemicalId);
  if (!item || !item.dose) {
    return {
      ok: false,
      reason: `${String(chemicalId)} is not a chemical this rig doses. The dosed chemicals are ${DOSED_CHEMICALS.join(', ')}.`,
    };
  }
  const r = num(rate, NaN);
  if (!(r >= 0)) {
    return { ok: false, reason: `A dose rate has to be zero or more mg/L; ${String(rate)} is not.` };
  }
  if (r > item.dose.max_ppm) {
    return {
      ok: false,
      reason: `The ${item.name} dosing pump tops out at ${item.dose.max_ppm} mg/L, and past about `
        + `${item.dose.c50_ppm * 2} mg/L the extra product buys almost nothing anyway.`,
    };
  }
  st.dosing[chemicalId].set_ppm = r;
  return { ok: true };
}

/**
 * The raw dose-response of one chemical: how much of the untreated degradation rate survives at a
 * given held concentration.
 * @param {object} dose the item's frozen dose block
 * @param {number} ppm the held concentration, mg/L
 * @returns {number} a multiplier on the untreated rate, `fMin`..1
 */
function rawResponse(dose, ppm) {
  const c = Math.max(0, num(ppm, 0));
  return dose.fMin + (1 - dose.fMin) * Math.exp(-c / dose.c50_ppm);
}

/**
 * What one chemical is doing to the rate it acts on, relative to the plant as it was handed over.
 *
 * NORMALISED AT THE NOMINAL DOSE, and this is the important design decision in the module. The
 * value is 1.0 when the chemical is being dosed at its nominal rate, which is what the rig ships
 * doing — so switching the CONSUMABLES feature on does not silently move the fouling rate the
 * machinery model was calibrated against. Stop the dose and it climbs, by about eight times for
 * the antiscalant. Push the dose to maximum and it falls, but only to about 0.4, because a
 * threshold inhibitor saturates and the money spent past that point buys nothing.
 *
 * Returns exactly 1.0 when the feature is off, so a machinery model can multiply by this
 * unconditionally.
 *
 * @param {object} st the stores
 * @param {string} chemicalId one of {@link DOSED_CHEMICALS}
 * @returns {number} the multiplier the fouling or corrosion model applies, 1.0 when neutral
 */
export function dosingEffect(st, chemicalId) {
  if (!isRecord(st) || st.enabled !== true || !isRecord(st.dosing)) return 1;
  const item = itemOf(chemicalId);
  if (!item || !item.dose) return 1;
  const live = st.dosing[chemicalId];
  if (!isRecord(live)) return 1;
  const atNominal = rawResponse(item.dose, item.dose.nominal_ppm);
  if (!(atNominal > 0)) return 1;
  return clamp(rawResponse(item.dose, live.held_ppm) / atNominal, 0.05, 20);
}

/**
 * The single multiplier the fouling model should apply: scale inhibition and biofilm control
 * together.
 *
 * Fouling on this rig is one number — the strainer blinding and the pipe roughness that steepen
 * the system curve — and two chemicals defend it by different mechanisms, so their effects
 * multiply. Both at nominal gives exactly 1.0. Both stopped gives about twenty times, which
 * sounds extreme until you remember it is the difference between a treated circuit and an
 * untreated one over a season.
 *
 * @param {object} st the stores
 * @returns {number} a multiplier on the untreated fouling rate; 1.0 when neutral
 */
export function foulingFactor(st) {
  if (!isRecord(st) || st.enabled !== true) return 1;
  return clamp(dosingEffect(st, 'ANTISCALANT') * dosingEffect(st, 'BIOCIDE'), 0.05, 50);
}

/**
 * The multiplier the corrosion model should apply.
 * @param {object} st the stores
 * @returns {number} a multiplier on the untreated corrosion rate; 1.0 when neutral
 */
export function corrosionFactor(st) {
  if (!isRecord(st) || st.enabled !== true) return 1;
  return clamp(dosingEffect(st, 'CORROSION_INHIBITOR'), 0.05, 50);
}

// ---------------------------------------------------------------------------------------------
// Running consumption
// ---------------------------------------------------------------------------------------------

/**
 * Draw a running consumption off the shelf, taking what is there and flagging the rest.
 *
 * Different from {@link consume} on purpose. A maintenance issue is all or nothing because a
 * half-built pump is worthless; a running consumption is not, because the plant does not stop
 * when the antiscalant drum empties — it carries on running untreated, which is precisely the
 * failure this module is here to make visible. So this takes what it can, records the shortfall,
 * and returns how much it actually got.
 *
 * @param {object} st the stores
 * @param {string} itemId a catalogue id
 * @param {number} qty how much the plant wanted
 * @returns {number} how much it actually got
 */
function drawDown(st, itemId, qty) {
  const want = num(qty, 0);
  if (!(want > 0)) return 0;
  const item = itemOf(itemId);
  if (!item) return 0;
  const have = stockOf(st, itemId);
  const got = Math.min(have, want);
  st.stock[itemId] = tidy(have - got);
  st.used[itemId] = tidy(num(st.used[itemId], 0) + got);
  if (got + 1e-12 < want) {
    if (!st.starved[itemId]) {
      st.starved[itemId] = true;
      st.events.push({
        at_h: num(st.hours_h, 0),
        kind: 'STARVED',
        itemId,
        text: `${item.name} has run out. ${whenClause(st, item)}`,
      });
      st.stockouts.push({
        at_h: num(st.hours_h, 0), itemId, need: tidy(want), have: tidy(have), shortBy: tidy(want - got),
      });
    }
  } else if (st.starved[itemId] && got > 0) {
    delete st.starved[itemId];
  }
  // A metered utility is replenished off the site header the moment it drops to its reorder
  // point, and the top-up is bought at catalogue price. It is not free; it just never blocks.
  if (item.utility && st.stock[itemId] <= item.min + 1e-9) {
    const topUp = tidy(item.max - st.stock[itemId]);
    st.stock[itemId] = item.max;
    bookCost(st, item, topUp * item.cost * num(st.costMul, 1));
    delete st.starved[itemId];
  }
  return got;
}

/**
 * Advance every running consumption by one controller scan.
 *
 * Reads the plant, not the clock. Nothing in here moves unless the thing that drives it moved:
 * a stopped rig consumes no flush water, a still valve consumes no air beyond its positioner's
 * standing bleed, and a rig with both pumps off doses nothing.
 *
 * The one subtlety is valve travel, which is measured in REAL scan time while everything else is
 * integrated in compressed equipment hours. The travel seen in one scan is therefore scaled by
 * the same acceleration factor, on the basis that this scan stands in for the whole compressed
 * interval. Leaving it unscaled would make instrument air the one consumable that does not age
 * with the plant, and a user comparing the air bill to the flush-water bill would draw a
 * conclusion that is wrong by a factor of 720.
 *
 * @param {object} st the stores
 * @param {object} cfg the realism configuration
 * @param {object} ctx the simulator context, for `ctx.plant`
 * @param {number} dt_s the scan interval, real seconds
 * @returns {void}
 */
export function stepConsumption(st, cfg, ctx, dt_s) {
  if (!isRecord(st) || !isRecord(st.stock)) return;
  st.enabled = isOn(cfg, FEATURE.CONSUMABLES);
  st.leadTimeMul = rateOf(cfg, 'leadTime');
  st.costMul = rateOf(cfg, 'cost');
  st.consumptionMul = rateOf(cfg, 'consumption');
  if (!st.enabled) return;

  const dh = agedHours(cfg, dt_s);
  if (!(dh > 0)) return;
  const ageMul = dh / (num(dt_s, 0) / 3600);
  const k = clamp(num(st.consumptionMul, 1), 0, 10);

  st.hours_h = tidy(num(st.hours_h, 0) + dh);
  st.days_d = st.hours_h / 24;
  receiveDeliveries(st, st.days_d);

  const plant = isRecord(ctx) && isRecord(ctx.plant) ? ctx.plant : null;
  if (!plant) return;

  // --- what the machines are doing --------------------------------------------------------
  const drv = Array.isArray(plant.drv) ? plant.drv : [];
  let runningSeals = 0;
  let bearingHours = 0;
  let greaseHours = 0;
  for (let i = 0; i < drv.length; i += 1) {
    const n = num(drv[i] && drv[i].n_pct, 0);
    if (!(n > 2)) continue;
    runningSeals += 1;
    // Oil oxidises faster hot. Casing liquid temperature is the closest thing the plant model
    // carries to a bearing housing temperature, and it moves for the right reasons — a pump on
    // its minimum flow cooks its own bearings as well as its own liquid.
    const T = num(plant.Tcasing_C && plant.Tcasing_C[i], RATE.oilRefT_C);
    bearingHours += dh * Math.pow(2, (T - RATE.oilRefT_C) / RATE.oilDoublePer_K);
    greaseHours += dh;
  }

  // --- seal flush water, per SEAL RUNNING HOUR ---------------------------------------------
  const flush_m3 = RATE.flush_m3_per_sealH * runningSeals * dh * k;
  if (flush_m3 > 0) drawDown(st, 'FLUSH_WATER', flush_m3);

  // --- instrument air, per POSITIONER BLEED and per VALVE TRAVEL ---------------------------
  const fcvX = num(plant.fcv && plant.fcv.x, null);
  const pcvX = num(plant.pcv && plant.pcv.x, null);
  let travel = 0;
  if (fcvX !== null) {
    if (st._travel.fcv !== null) travel += Math.abs(fcvX - st._travel.fcv);
    st._travel.fcv = fcvX;
  }
  if (pcvX !== null) {
    if (st._travel.pcv !== null) travel += Math.abs(pcvX - st._travel.pcv);
    st._travel.pcv = pcvX;
  }
  const positioners = (fcvX !== null ? 1 : 0) + (pcvX !== null ? 1 : 0);
  const air_Nm3 = (RATE.airBleed_Nm3_per_positionerH * positioners * dh
    + RATE.airPerTravel_Nm3 * travel * ageMul) * k;
  if (air_Nm3 > 0) drawDown(st, 'INSTRUMENT_AIR', air_Nm3);

  // --- lube, per BEARING HOUR --------------------------------------------------------------
  const oil_L = (RATE.oil_L_per_1000H / 1000) * bearingHours * k;
  if (oil_L > 0) drawDown(st, 'LUBE_OIL_VG32', oil_L);
  const grease_kg = RATE.grease_kg_per_motorH * greaseHours * k;
  if (grease_kg > 0) drawDown(st, 'GREASE_NLGI2', grease_kg);

  // --- flush filter, per THROUGHPUT --------------------------------------------------------
  if (flush_m3 > 0) {
    st.filter.load += flush_m3 / Math.max(1, RATE.filterLife_m3);
    while (st.filter.load >= 1) {
      const got = drawDown(st, 'FILTER_CARTRIDGE', 1);
      if (got < 1) {
        // No cartridge, so the old one stays in and the differential keeps climbing. That is a
        // real failure — a blocked flush filter starves the seal it was fitted to protect.
        st.filter.load = 1;
        break;
      }
      st.filter.load -= 1;
      st.filter.changes += 1;
      st.events.push({
        at_h: st.hours_h, kind: 'FILTER', itemId: 'FILTER_CARTRIDGE', text: 'Seal flush filter cartridge changed on differential pressure.',
      });
    }
  }
  st.filter.dp_bar = RATE.filterCleanDP_bar * (1 + 9 * st.filter.load * st.filter.load);

  // --- chemicals, per CIRCULATED FLOW ------------------------------------------------------
  const Q_m3h = Math.max(0, num(plant.Qtotal_m3h, 0));
  for (const id of DOSED_CHEMICALS) {
    const item = ITEM_BY_ID[id];
    const live = st.dosing[id];
    if (!live) continue;
    // mg/L on m3/h is g/h of product; divide by 1000*density to get litres.
    const wanted_L = (live.set_ppm * Q_m3h * dh) / (1000 * item.dose.density_kgL) * k;
    const got_L = wanted_L > 0 ? drawDown(st, id, wanted_L) : 0;
    // What the plant ACTUALLY received, which is what the dose-response has to be read at. An
    // empty drum delivers nothing however the dosing pump is set, and this is the exact point
    // where an unread reorder report turns into a plant that is fouling.
    live.delivered_ppm = wanted_L > 0 ? live.set_ppm * (got_L / wanted_L) : 0;
    live.starved = wanted_L > 0 && got_L + 1e-12 < wanted_L;
    // Concentration washes out on the holding time rather than stepping, so a stockout shows up
    // as a slow loss of protection and the consequence lands weeks later.
    const alpha = clamp(dh / RATE.chemHoldTime_h, 0, 1);
    live.held_ppm = live.held_ppm + (live.delivered_ppm - live.held_ppm) * alpha;
  }
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/**
 * What the stores has spent so far.
 *
 * Money is booked when stock is ACQUIRED — when a purchase order is raised, or when a metered
 * utility tops itself up off the header — and never when it is issued to a job, because it was
 * already paid for. Opening stock is free: it was on the books before this session started.
 *
 * @param {object} st the stores
 * @returns {{parts:number, chemicals:number, utilities:number, calibration:number, total:number}}
 *   spend by category and in total
 */
export function costsToDate(st) {
  const c = isRecord(st) && isRecord(st.cost) ? st.cost : {};
  const parts = tidy(num(c.parts, 0));
  const chemicals = tidy(num(c.chemicals, 0));
  const utilities = tidy(num(c.utilities, 0));
  const calibration = tidy(num(c.calibration, 0));
  return {
    parts,
    chemicals,
    utilities,
    calibration,
    total: tidy(parts + chemicals + utilities + calibration),
  };
}

/**
 * A compact picture of the stores for the UI: what is short, what is coming, what the treatment
 * programme is currently doing to the plant, and what it has all cost.
 *
 * @param {object} st the stores
 * @returns {object} the summary
 */
export function storesSummary(st) {
  if (!isRecord(st)) return null;
  const belowMin = [];
  const out = [];
  for (const item of ITEMS) {
    if (item.utility) continue;
    const have = stockOf(st, item.id);
    if (have <= 0) out.push(item.id);
    else if (have + onOrderOf(st, item.id) <= item.min) belowMin.push(item.id);
  }
  const dosing = DOSED_CHEMICALS.map((id) => ({
    itemId: id,
    set_ppm: tidy(num(st.dosing[id] && st.dosing[id].set_ppm, 0)),
    held_ppm: tidy(num(st.dosing[id] && st.dosing[id].held_ppm, 0)),
    starved: !!(st.dosing[id] && st.dosing[id].starved),
    effect: tidy(dosingEffect(st, id)),
  }));
  return {
    enabled: st.enabled === true,
    hours_h: tidy(num(st.hours_h, 0)),
    days_d: tidy(num(st.days_d, 0)),
    outOfStock: out,
    belowReorderPoint: belowMin,
    onOrder: st.onOrder.map((po) => ({ ...po })),
    dosing,
    foulingFactor: tidy(foulingFactor(st)),
    corrosionFactor: tidy(corrosionFactor(st)),
    filter: { load: tidy(st.filter.load), dp_bar: tidy(st.filter.dp_bar), changes: st.filter.changes },
    stockouts: st.stockouts.length,
    cost: costsToDate(st),
  };
}

/**
 * Take the events the stores has raised since this was last called.
 * @param {object} st the stores
 * @returns {object[]} the events, oldest first
 */
export function drainEvents(st) {
  if (!isRecord(st) || !Array.isArray(st.events)) return [];
  const out = st.events;
  st.events = [];
  return out;
}
