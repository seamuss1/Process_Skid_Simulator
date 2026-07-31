/**
 * src/data/presets.js — the four shipped presets, the eight failure scenarios, the six method
 * templates, and `normalizePreset()`: THE ingest boundary of the whole program.
 *
 * architecture-v2 §1.1 R-U1, §2.1, §2.3, §5.6, §5.7, §5.8, §6.22, §8.
 *
 * AUTHORING UNITS vs CANONICAL UNITS.
 * Everything in `PRESETS` below is authored the way a human writes a batch record: cm, mL, mL/min,
 * cm/h, g/L, mmol per mL of packed bed, mm of UV path, °C, mAU. `normalizePreset()` converts that
 * ONCE into the §1 canonical set (cm, mL, s, mL/s, mM, µmol, bar, cP, AU/cm) and freezes the
 * result. Nothing downstream ever sees a human unit, and nothing else in the program converts.
 *
 * OVERRIDES. `normalizePreset(id, overrides)` deep-merges `overrides` onto the AUTHORED preset
 * object before any derivation, so an override path is the authored path — `{column:{nz:200}}`,
 * `{skid:{ambientT_C:5}}`, `{load:{value:60}}`. Four extra keys exist because arrays cannot be
 * deep-merged by key:
 *   tanksById     { '<tankId>': <partial tank> }        patch one tank
 *   tankDefaults  <partial tank>                        patch every tank
 *   speciesOverrides { '<speciesId>': <partial spec> }  patch one species
 *   methodPatches { '<blockId>': <partial block> }      patch one expanded method block
 * `methodPhases` may be an array or a `(config) => array` factory; a factory lets a block's volume
 * follow `config.load.derived`, which is what makes the `overloaded-column` scenario a one-liner.
 */

import {
  deepFreeze, deepMerge, clamp, area_cm2, epsTotal, LambdaBead_mM, extMass_Lgcm, mM_from_gL,
} from '../core/util.js';
import { solveCounterIon, buildTankVector, describeTank, meanCharge, BUFFER_LIBRARY } from '../chem/ph.js';
import { SCALES, SEGMENT_TABLE, RESINS, SPECIES, getScale, getResin, getSpecies } from './library.js';
import { expandPresetMethod, normalizeMethod } from '../skid/method.js';
import { ALARM_TABLE } from '../skid/alarms.js';
import { buildTopology } from '../skid/skid.js';

const SCHEMA_VERSION = '2.0';
const DEFAULT_PRESET_ID = 'cex-capture-igg1-pilot';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Canonical default blocks (architecture-v2 §2.1, verbatim)
 * ──────────────────────────────────────────────────────────────────────────── */

const CHEM_DEFAULTS = {
  CS_MIN_mM: 1.0, C_MIN_mM: 1e-12, C_KT_mM: 1e-9,
  KT_MIN: 1e-3, KT_MAX: 1e6,
  daviesA: 0.509, daviesIeMax: 0.39, Kw: 1e-14,
  condTref_C: 25.0, condAlphaMeter_perC: 0.0214,
  sodiumErrorK: 0.673,
};

const SIM_DEFAULTS = {
  dtPhys_s: 0.05, ctrlEvery: 2, logEvery: 10, ringSeconds: 120,
  maxTicksPerFrame: 150, speedOptions: [1, 2, 5, 10, 60, 300, 1000],
};

const UI_DEFAULTS = { theme: 'auto', xMode: 'volume', bedCells: 120, hintsEnabled: true };

const COLUMN_DEFAULTS = {
  id_cm: 10.0, L_cm: 20.0,
  epsC: 0.35, epsP: 0.85,
  dp_cm: 9.0e-3, rPore_cm: 3.0e-6,
  lambdaPack: 1.0, gammaObstruction: 0.7, kKozeny: 180,
  Lambda_mmolPerMLbed: 0.2275,           // human basis; Lambda_mM is derived (BASIS N1)
  isothermMode: 'SMA', resinChargeSign: -1,
  modulatorSpeciesId: 'Na',
  enableDonnan: true,
  channellingFactor: 0.0,
  compression: { enabled: true, eps0: 0.35, epsMin: 0.26, Pc_bar: 2.0 },
  hardwarePressureLimit_bar: 4.0,
  rFrit_bar_per_cms: 0.0011,
  foulingFactor: 1.0,
  enableProteinViscosity: false,
  nz: 400, nuTarget: 0.95, dtCap_s: 0.50, nSubMax: 64,
  enableExplicitDispersion: false,
  DL_override_cm2s: null,
};

const UV_DEFAULTS = {
  pathlength_mm: 0.2, strayLight: 3.0e-3, channels_nm: [280, 260, 300],
  tau_s: 2.0, noiseWhite_AU: 8e-5, noisePink_AU: 2.5e-4,
  driftWarm_AU_s: 2.78e-7, driftStart_AU: 0.025, driftTau_s: 400,
  foulPerCycle_AU: 2e-4, kRI_AU_per_mScm_s: 1.5e-3,
  overrange_AU: 2.00, saturated_AU: 2.40, dilutionRatio: 1.0, airSpike_AU: 3.0,
};

const COND_DEFAULTS = {
  Kcell_cm1: 5.0, tau_s: 1.0, noiseAbs_mScm: 0.005, noiseRel: 5e-4,
  noisePinkRel: 2e-4, driftRel_s: 2.78e-7, foulPerCycle: -0.003,
  ptTau_s: 60, dryThreshold_frac: 0.5,
};

const PH_DEFAULTS = {
  tau_s: 8.0, tauAsymRising: 1.6, tauElec_s: 2.0, noise_pH: 0.003,
  drift_pH_s: 5.56e-6, slopePct: 99.0, offset_mV: 0.0,
  slopeDecayPerCycle: 0.4, offsetDecayPerCycle: 0.3, freezeAir_frac: 0.30,
};

const PRESS_DEFAULTS = {
  P1FS_bar: 10.0, P2FS_bar: 10.0, accuracyFS: 0.005, noiseFS: 0.002,
  tauDisp_s: 0.5, tauAlarm_s: 0.2, Rdown_bar_per_mLs: 0.027,
};

const FILTER_DEFAULTS = { R0_bar_per_mLs: 0.004, kFoul_per_mg: 2.0e-5 };

const SKID_DEFAULTS = {
  gradientMode: 'LPGF', chopPeriod_s: 2.0, tMinOpen_s: 0.040,
  mixerVolume_mL: 100, mixerN: 1,
  airTrap: true, inlineFilter: true,
  estopRamp_s: 0.5,
  rippleFlow_frac: 0.015, ripplePress_frac: 0.03,
  QswitchMax_frac: 0.10,
  ambientT_C: 25.0, fluidTau_s: 900, bubbleSensorThreshold_frac: 0.02,
};

/**
 * Per-scale hardware fallbacks. `data/library.js::SCALES` is AUTHORITATIVE for every key it
 * defines; these fill only the keys it omits, so a partially-authored scale row can never leave a
 * numeric field `undefined` (which would silently become NaN two layers down). PILOT reproduces
 * §2.1 exactly; Qmin/QminAbs/rampRate are derived from Qmax when the row omits them.
 */
const SCALE_FALLBACK = {
  LAB: {
    Qmax_mLs: 0.4267, Vstroke_mL: 0.1, mixerVolume_mL: 2.0, mixerOptions_mL: [0.6, 2.0, 5.0],
    Rdown_bar_per_mLs: 0.530, wasteCapacity_mL: 5000, tSwitch_s: 0.25, portCapacity_mL: 20,
    fracValvePorts: 12, column: { id_cm: 1.60, L_cm: 20.0 },
  },
  PILOT: {
    Qmax_mLs: 16.667, Qmin_mLs: 0.333, QminAbs_mLs: 0.0833, rampRate_mLs2: 1.6667,
    Vstroke_mL: 5.0, mixerVolume_mL: 100, mixerOptions_mL: [50, 100, 250],
    Rdown_bar_per_mLs: 0.027, wasteCapacity_mL: 200000, tSwitch_s: 0.80, portCapacity_mL: 500,
    fracValvePorts: 12, column: { id_cm: 10.0, L_cm: 20.0 },
  },
  PROCESS: {
    Qmax_mLs: 337.4, Vstroke_mL: 100, mixerVolume_mL: 1500, mixerOptions_mL: [600, 1500, 3000],
    Rdown_bar_per_mLs: 0.00133, wasteCapacity_mL: 3000000, tSwitch_s: 2.0, portCapacity_mL: 5000,
    fracValvePorts: 12, column: { id_cm: 45.0, L_cm: 20.0 },
  },
};

/**
 * Per-field species fallbacks, in HUMAN authoring form. `data/library.js::SPECIES` is authoritative
 * for every field it defines; this table only fills gaps, so the shipped chemistry is correct even
 * if a field is renamed or omitted upstream. Numbers are §8.1 (SMA, optics, epsPi) and §7.3.4
 * (Dm, Dp). MW for WKI/SBI is the mass that reproduces their §7.3.4 Dm through Polson.
 */
const SPECIES_DEFAULTS = {
  tracer: { name: 'Acetone tracer', role: 'tracer', kind: 'inert', MW_gmol: 58.08, epsPi: 0.85,
    Dm_cm2s: 1.28e-5, Dp_cm2s: 7.68e-6, charge: 0, concScale_mM: 1.0,
    eps280_Lgcm: 0.26, eps260_Lgcm: 0.30, eps300_Lgcm: 0.12 },
  EtOH: { name: 'Ethanol', role: 'organic', kind: 'inert', MW_gmol: 46.07, epsPi: 0.85,
    Dm_cm2s: 1.24e-5, Dp_cm2s: 4.34e-6, charge: 0, concScale_mM: 100.0 },
  OHex: { name: 'Hydroxide excess', role: 'baseExcess', kind: 'inert', MW_gmol: 17.007, epsPi: 0.85,
    Dm_cm2s: 5.27e-5, Dp_cm2s: 1.84e-5, charge: -1, lambda0_Scm2eq: 198.0, concScale_mM: 1.0 },
  Na: { name: 'Sodium', role: 'ion', kind: 'donnan', MW_gmol: 22.990, epsPi: 0.85,
    Dm_cm2s: 1.33e-5, Dp_cm2s: 4.66e-6, charge: 1, lambda0_Scm2eq: 50.1, concScale_mM: 100.0 },
  Cl: { name: 'Chloride', role: 'ion', kind: 'donnan', MW_gmol: 35.453, epsPi: 0.85,
    Dm_cm2s: 1.33e-5, Dp_cm2s: 4.66e-6, charge: -1, lambda0_Scm2eq: 76.3, concScale_mM: 100.0 },
  AcT: { name: 'Acetate (total)', role: 'buffer', kind: 'donnan', MW_gmol: 59.044, epsPi: 0.85,
    Dm_cm2s: 1.20e-5, Dp_cm2s: 4.20e-6, charge: -1, lambda0_Scm2eq: 40.9, concScale_mM: 50.0,
    bufferId: 'acetate', bufferPkas: [4.76], bufferZ0: 0, bufferDpKadT: 0.0002, donnanRole: 'CO' },
  WKI: { name: 'Weakly-bound host-cell impurity', role: 'impurity', kind: 'binding',
    MW_gmol: 17800, epsPi: 0.85, Dm_cm2s: 1.05e-6, Dp_cm2s: 3.68e-7, charge: 0, concScale_mM: 0.05,
    nu: 3.5, sigma: 69, Keq: 0.018, eps280_Lgcm: 0.95, eps260_Lgcm: 0.60, eps300_Lgcm: 0.05 },
  mAb: { name: 'IgG1 monoclonal antibody', role: 'product', kind: 'binding',
    MW_gmol: 148000, epsPi: 0.70, Dm_cm2s: 4.00e-7, Dp_cm2s: 6.00e-8, charge: 0, concScale_mM: 0.05,
    nu: 5.2, sigma: 575, Keq: 0.044, eps280_Lgcm: 1.42, eps260_Lgcm: 0.72, eps300_Lgcm: 0.10 },
  AGG: { name: 'IgG1 aggregate (HMW)', role: 'aggregate', kind: 'binding',
    MW_gmol: 296000, epsPi: 0.45, Dm_cm2s: 2.96e-7, Dp_cm2s: 2.37e-8, charge: 0, concScale_mM: 0.01,
    nu: 7.0, sigma: 1473, Keq: 0.0415, eps280_Lgcm: 1.48, eps260_Lgcm: 0.75, eps300_Lgcm: 0.11 },
  SBI: { name: 'Strongly-bound host-cell impurity', role: 'impurity', kind: 'binding',
    MW_gmol: 26400, epsPi: 0.68, Dm_cm2s: 9.20e-7, Dp_cm2s: 1.29e-7, charge: 0, concScale_mM: 0.01,
    nu: 9.0, sigma: 638, Keq: 1.33, eps280_Lgcm: 1.42, eps260_Lgcm: 0.80, eps300_Lgcm: 0.06 },
};

const PILOT_SPECIES_IDS = ['tracer', 'EtOH', 'OHex', 'Na', 'Cl', 'AcT', 'WKI', 'mAb', 'AGG', 'SBI'];

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Small local helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

/** Structural clone of authored data. Functions pass through by reference (method factories). */
function cloneAuthored(v) {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(cloneAuthored);
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneAuthored(v[k]);
  return out;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function lookup(fn, table, id) {
  let v;
  try { v = fn ? fn(id) : undefined; } catch (_e) { v = undefined; }
  if (v === undefined || v === null) v = table ? table[id] : undefined;
  return v || null;
}

function requireFinite(x, what) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new Error(`normalizePreset: ${what} is not a finite number (got ${String(x)})`);
  }
  return x;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Method shorthand (architecture-v2 §8.4.1, §8.4.3)
 * ──────────────────────────────────────────────────────────────────────────── */

/** The §8.4.1 B04 peak-fractionation object, authored value + authoredAs (round-trips through §5.2). */
function peakFractionation() {
  return {
    mode: 'PEAK', signal: 'UV_280',
    startThreshold: { type: 'ABSOLUTE', value: 2.00, authoredAs: { value: 40, unit: 'mAU' } },
    stopThreshold: { type: 'ABSOLUTE', value: 2.00, authoredAs: { value: 40, unit: 'mAU' } },
    minFractionVolume: { basis: 'CV', value: 0.05 },
    maxFractionVolume: { basis: 'CV', value: 0.25 },
    peakMaxDetection: true, peakMaxProminence: 1.5,
    firstPort: 'F1', portCount: 12, overflowTo: 'WASTE',
    delayCompensation: 'COMPENSATED', deadLegPolicy: 'REPORT', persistence_ticks: 5,
  };
}

/** The §8.4.1 B07 `COND STABLE` watch. */
function reEqWatch() {
  return {
    id: 'W-REQ', signal: 'COND', operator: 'STABLE', threshold: 0,
    stableTolerance: 0.20,
    slopeWindow: { basis: 'CV', value: 0.50 },
    arm: { basis: 'CV', value: 2.0 }, persistence_ticks: 5,
    action: 'END_BLOCK', oneShot: true,
  };
}

/**
 * The shipped eight-block bind-and-elute method (§8.4.1) as §8.4.3 shorthand.
 * B08 carries a nominal 2 CV duration purely so PRC-08 (`duration.value > 0`) has something to
 * check and the phase rail has a finite slice; a HOLD block never ends on duration (§5.4.4c r12).
 */
function cexPhases(config, o) {
  const flow = o.flow_cmh;
  const b = o.bInlet || 'B1';
  return [
    { type: 'EQUILIBRATION', cv: 6, flow, pctB: 0,
      inlets: { a: 'A1', b, sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'LOAD', mL: config.load.derived.volume_mL, flow, pctB: 0,
      inlets: { a: 'A1', b, sample: 'S1' }, sample: 'DIRECT', columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'WASH', cv: 5, flow, pctB: 0,
      inlets: { a: 'A1', b, sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'ELUTION_LINEAR', cv: o.gradientCV, flow, pctB: [0, 100], shape: 'LINEAR',
      inlets: { a: 'A1', b, sample: null }, columnValve: 'DOWN', outlet: 'WASTE',
      frac: peakFractionation() },
    { type: 'STRIP', cv: 3, flow, pctB: 100,
      inlets: { a: 'A1', b: 'B2', sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'CIP', cv: 3, flow, pctB: 0,
      inlets: { a: 'A4', b, sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'RE_EQUILIBRATION', cv: 6, flow, pctB: 0,
      inlets: { a: 'A1', b, sample: null }, columnValve: 'DOWN', outlet: 'WASTE',
      watch: reEqWatch() },
    // Terminal hold: flow MUST be 0. The column valve interlock rejects a move while
    // Q_actual > QswitchMax_frac*Qmax, so commanding BYPASS at running flow raises ALM-CV-02
    // and parks the run in ALARM, where advanceWall stops ticking entirely.
    { type: 'HOLD', cv: 2, flow: 0, pctB: 0,
      inlets: { a: 'A1', b, sample: null }, columnValve: 'BYPASS', outlet: 'WASTE' },
  ];
}

/** Descending-salt HIC (§8.4.4): B is the HIGH-salt buffer, so 100 %B is high salt throughout. */
function hicPhases(config) {
  const flow = 150;
  return [
    { type: 'EQUILIBRATION', cv: 5, flow, pctB: 100,
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'LOAD', mL: config.load.derived.volume_mL, flow, pctB: 100,
      inlets: { a: 'A1', b: 'B1', sample: 'S1' }, sample: 'DIRECT', columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'WASH', cv: 3, flow, pctB: 100,
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'ELUTION_LINEAR', cv: 15, flow, pctB: [100, 0], shape: 'LINEAR',
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE',
      frac: peakFractionation() },
    { type: 'STRIP', cv: 3, flow, pctB: 0,
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'CIP', cv: 3, flow, pctB: 0,
      inlets: { a: 'A4', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'RE_EQUILIBRATION', cv: 5, flow, pctB: 100,
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE',
      watch: reEqWatch() },
    // Terminal hold: flow MUST be 0 — see the CEX note above (ALM-CV-02 / valve-under-flow).
    { type: 'HOLD', cv: 2, flow: 0, pctB: 100,
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'BYPASS', outlet: 'WASTE' },
  ];
}

/** Three-block isocratic SEC (§8.4.4). */
function secPhases() {
  const flow = 25;
  return [
    { type: 'EQUILIBRATION', cv: 2, flow, pctB: 0,
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'LOAD', cv: 0.02, flow, pctB: 0,
      inlets: { a: 'A1', b: 'B1', sample: 'S1' }, sample: 'LOOP_INJECT',
      columnValve: 'DOWN', outlet: 'WASTE' },
    { type: 'ELUTION_ISOCRATIC', cv: 1.5, flow, pctB: 0,
      inlets: { a: 'A1', b: 'B1', sample: null }, columnValve: 'DOWN', outlet: 'WASTE',
      frac: peakFractionation() },
  ];
}

/** `air-in-the-line`: the pilot method with a COLUMN_BYPASS block after the wash (D4, §11 C-35). */
function airInLinePhases(config) {
  const phases = cexPhases(config, { flow_cmh: 150, gradientCV: 20 });
  phases.splice(3, 0, {
    type: 'COLUMN_BYPASS', cv: 3, flow: 150, pctB: 0,
    inlets: { a: 'A2', b: 'B1', sample: null }, columnValve: 'BYPASS', outlet: 'WASTE',
  });
  return phases;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Tank compositions (§8.2 solves them; nothing here stores a salt number)
 * ──────────────────────────────────────────────────────────────────────────── */

function acetateBuffer(saltNa_mM, targetPH) {
  return {
    buffers: [{ speciesId: 'AcT', bufferId: 'acetate', total_mM: 50 }],
    targetPH: targetPH === undefined ? 5.00 : targetPH,
    counterCation: 'Na', counterAnion: 'Cl',
    saltTarget: { ion: 'Na', total_mM: saltNa_mM },
    organic_frac: 0, strongBase_mM: 0, strongAcid_mM: 0,
  };
}

function waterComposition() {
  return {
    buffers: [], targetPH: null, counterCation: 'Na', counterAnion: 'Cl',
    saltTarget: null, organic_frac: 0, strongBase_mM: 0, strongAcid_mM: 0,
  };
}

function naohComposition(base_mM) {
  return {
    buffers: [], targetPH: null, counterCation: 'Na', counterAnion: 'Cl',
    saltTarget: null, organic_frac: 0, strongBase_mM: base_mM, strongAcid_mM: 0,
  };
}

const PILOT_FEED_PROTEINS = [
  { speciesId: 'mAb', c_gL: 4.25 },
  { speciesId: 'WKI', c_gL: 0.45 },
  { speciesId: 'AGG', c_gL: 0.20 },
  { speciesId: 'SBI', c_gL: 0.10 },
];

function tank(id, label, port, startVolume_mL, composition, extra) {
  return Object.assign({
    id, label, port,
    nominalVolume_mL: startVolume_mL,
    startVolume_mL,
    lowLevelPct: 10, emptyLevel_mL: 500, T_C: 25,
    isSample: port.charAt(0) === 'S',
    composition,
  }, extra || {});
}

const PILOT_INLETS = {
  A1: 'TK-EQ', A2: 'TK-WASH', A3: 'TK-WFI', A4: 'TK-NAOH',
  B1: 'TK-ELU', B2: 'TK-STRIP', B3: null, B4: null,
  S1: 'TK-FEED', S2: null, S3: null,
};

/**
 * The seven shipped tanks (§8.4.2).
 * TK-EQ ships 60 000 mL, not §8.4.2's 40 000. §8.4.2's "demand 26 500" counts B01+B03+B07 only and
 * omits the A-side of the 0→100 %B gradient, which is another 0.5 × 20 CV = 15 708 mL: the true A1
 * demand is 42 412 mL, so a 40 000 mL tank runs dry inside B07 and trips ALM-TNK-02 on the golden
 * run. 60 000 mL leaves 17 588 mL and clears the 10 % low-level warn.
 */
function pilotTanks(scaleFactor, feedProteins) {
  const k = scaleFactor;
  const v = (mL) => Math.round(mL * k);
  // The dip-tube dead volume is a property of the VESSEL and scales with it, exactly as
  // data/library.js's own per-scale tank tables do (TANKS_PILOT 500 mL, TANKS_LAB 20 mL).
  // `tank()`'s default is the PILOT 500 mL of §8.4.2, which k = 1 reproduces exactly; leaving it
  // at 500 mL for the LAB preset (k = 0.03) put TK-FEED (240 mL), TK-NAOH and TK-STRIP (300 mL)
  // BELOW their own empty level at t = 0, so B02 tripped ALM-TNK-02 (CRITICAL) and ALM-AIR-01 the
  // instant it selected the feed and the run stalled in ALARM at 6 CV.
  const empty_mL = Math.max(1, Math.round(500 * k));
  const t = (id, label, port, start_mL, comp) =>
    tank(id, label, port, start_mL, comp, { emptyLevel_mL: empty_mL });
  return [
    t('TK-EQ', 'Equilibration / wash buffer', 'A1', v(60000), acetateBuffer(50.0)),
    t('TK-WASH', 'Spare wash (same as A1)', 'A2', v(20000), acetateBuffer(50.0)),
    t('TK-WFI', 'Water for injection', 'A3', v(20000), waterComposition()),
    t('TK-NAOH', '0.5 M NaOH (CIP)', 'A4', v(10000), naohComposition(500)),
    t('TK-ELU', 'Elution buffer B', 'B1', v(35000), acetateBuffer(500.0)),
    t('TK-STRIP', 'Strip (= buffer B)', 'B2', v(10000), acetateBuffer(500.0)),
    t('TK-FEED', 'Clarified harvest', 'S1', v(8000),
      Object.assign(acetateBuffer(50.0), { proteins: feedProteins })),
  ];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. PRESETS (authored, human units)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The four shipped presets, in AUTHORING form. `normalizePreset(id, overrides)` turns one of these
 * into the frozen canonical `config` of §2.1.
 * @type {Object<string, object>}
 */
export const PRESETS = {

  'cex-capture-igg1-pilot': {
    id: 'cex-capture-igg1-pilot',
    name: 'CEX Capture — IgG1 on SP agarose (pilot)',
    scale: 'PILOT',
    seed: 918273645,
    resinId: 'PrepSP-90HF',
    column: { id_cm: 10.0, L_cm: 20.0, isothermMode: 'SMA', resinChargeSign: -1,
      modulatorSpeciesId: 'Na', enableDonnan: true },
    speciesIds: PILOT_SPECIES_IDS,
    speciesOverrides: {},
    skid: { gradientMode: 'LPGF', mixerVolume_mL: 100, mixerN: 1, airTrap: true, inlineFilter: true,
      uv: { pathlength_mm: 0.2 } },
    tanks: pilotTanks(1, PILOT_FEED_PROTEINS),
    inletAssignments: PILOT_INLETS,
    load: { basis: 'MG_PER_ML_RESIN', value: 15.0, feedTiterTotal_gL: 5.00,
      productTiter_gL: 4.25, productSpeciesId: 'mAb' },
    methodMeta: { methodId: 'm-cex-pilot', name: 'CEX Capture v3',
      globalDefaults: { flow: { mode: 'CM_H', value: 150 }, arm: { basis: 'CV', value: 0.05 },
        persistence_ticks: 5 },
      endState: { columnValve: 'BYPASS', outletValve: 'WASTE' },
      notes: 'Bind-and-elute capture: 6 CV equilibration, 15 mg/mL load, 5 CV wash, 20 CV linear ' +
        'salt gradient with peak fractionation, strip, CIP, re-equilibration.' },
    methodPhases: (config) => cexPhases(config, { flow_cmh: 150, gradientCV: 20 }),
    methodPatches: { B01: { autozero: true } },
    sim: {}, ui: {}, chem: {},
  },

  'cex-capture-igg1-lab': {
    id: 'cex-capture-igg1-lab',
    name: 'CEX Capture — IgG1 on SP agarose (lab)',
    scale: 'LAB',
    seed: 918273645,
    resinId: 'PrepSP-90HF',
    column: { id_cm: 1.60, L_cm: 20.0, isothermMode: 'SMA', resinChargeSign: -1,
      modulatorSpeciesId: 'Na', enableDonnan: true },
    speciesIds: PILOT_SPECIES_IDS,
    speciesOverrides: {},
    skid: { gradientMode: 'LPGF', mixerVolume_mL: 2.0, mixerN: 1, airTrap: true, inlineFilter: true,
      uv: { pathlength_mm: 0.2 } },
    tanks: pilotTanks(0.03, PILOT_FEED_PROTEINS),
    inletAssignments: PILOT_INLETS,
    load: { basis: 'MG_PER_ML_RESIN', value: 15.0, feedTiterTotal_gL: 5.00,
      productTiter_gL: 4.25, productSpeciesId: 'mAb' },
    methodMeta: { methodId: 'm-cex-lab', name: 'CEX Capture v3 (lab)',
      globalDefaults: { flow: { mode: 'CM_H', value: 300 }, arm: { basis: 'CV', value: 0.05 },
        persistence_ticks: 5 },
      endState: { columnValve: 'BYPASS', outletValve: 'WASTE' },
      notes: 'The validation geometry: 1.60 x 20 cm, 300 cm/h, identical block list to the pilot.' },
    methodPhases: (config) => cexPhases(config, { flow_cmh: 300, gradientCV: 20 }),
    methodPatches: { B01: { autozero: true } },
    sim: {}, ui: {}, chem: {},
  },

  'hic-polish-agg': {
    id: 'hic-polish-agg',
    name: 'HIC Polish — aggregate removal, descending salt (pilot)',
    scale: 'PILOT',
    seed: 271828183,
    resinId: 'PrepSP-90HF',
    // Same bead geometry, non-ionic surface: HIC binds as salt RISES, so B is the high-salt buffer
    // and the gradient runs 100 -> 0 %B. beta > 0 is what makes b(cs) increase with modulator.
    column: { id_cm: 10.0, L_cm: 20.0, isothermMode: 'HIC', resinChargeSign: 0,
      modulatorSpeciesId: 'Na', enableDonnan: false },
    speciesIds: PILOT_SPECIES_IDS,
    // nu/sigma/Keq are left at their CEX values on purpose: HIC mode never reads them, and zeroing
    // them would make ln(nu+sigma) = -Infinity if a model builds that term before branching on mode.
    speciesOverrides: {
      WKI: { qmax_mM: 2.0, b0_mM1: 4.0e-4, beta_mM1: 0.0085, csRef_mM: 0 },
      mAb: { qmax_mM: 2.0, b0_mM1: 3.5e-4, beta_mM1: 0.0100, csRef_mM: 0 },
      AGG: { qmax_mM: 2.5, b0_mM1: 3.0e-4, beta_mM1: 0.0115, csRef_mM: 0 },
      SBI: { qmax_mM: 2.0, b0_mM1: 3.0e-4, beta_mM1: 0.0090, csRef_mM: 0 },
    },
    skid: { gradientMode: 'LPGF', mixerVolume_mL: 100, mixerN: 1, airTrap: true, inlineFilter: true,
      uv: { pathlength_mm: 0.2 } },
    tanks: [
      tank('TK-EQ', 'Low-salt elution buffer (A)', 'A1', 40000, acetateBuffer(50.0)),
      tank('TK-WASH', 'Spare wash', 'A2', 20000, acetateBuffer(50.0)),
      tank('TK-WFI', 'Water for injection', 'A3', 20000, waterComposition()),
      tank('TK-NAOH', '0.5 M NaOH (CIP)', 'A4', 10000, naohComposition(500)),
      tank('TK-ELU', 'High-salt equilibration buffer (B)', 'B1', 80000, acetateBuffer(1000.0)),
      tank('TK-STRIP', 'Strip (= buffer B)', 'B2', 10000, acetateBuffer(1000.0)),
      tank('TK-FEED', 'Product pool in high salt', 'S1', 10000,
        Object.assign(acetateBuffer(1000.0), { proteins: PILOT_FEED_PROTEINS })),
    ],
    inletAssignments: PILOT_INLETS,
    load: { basis: 'MG_PER_ML_RESIN', value: 15.0, feedTiterTotal_gL: 5.00,
      productTiter_gL: 4.25, productSpeciesId: 'mAb' },
    methodMeta: { methodId: 'm-hic-pilot', name: 'HIC polish, descending salt',
      globalDefaults: { flow: { mode: 'CM_H', value: 150 }, arm: { basis: 'CV', value: 0.05 },
        persistence_ticks: 5 },
      endState: { columnValve: 'BYPASS', outletValve: 'WASTE' },
      notes: 'Bind at 1.0 M Na, elute on a 15 CV descending-salt gradient. Aggregate is the more ' +
        'hydrophobic species and elutes LAST, after the monomer.' },
    methodPhases: (config) => hicPhases(config),
    methodPatches: { B01: { autozero: true } },
    sim: {}, ui: {}, chem: {},
  },

  'sec-polish-s200': {
    id: 'sec-polish-s200',
    name: 'SEC Polish — S200, isocratic (lab)',
    scale: 'LAB',
    seed: 161803399,
    resinId: 'PrepSP-90HF',
    // THE preset where ns !== nsCol (§1.2/§8.3): Na, Cl and AcT stay in the registry for
    // conductivity and pH but are NOT transported, so colIdxOf returns -1 for exactly three rows.
    column: { id_cm: 1.60, L_cm: 60.0, dp_cm: 4.7e-3, epsC: 0.35, epsP: 0.80, rPore_cm: 1.6e-6,
      isothermMode: 'SEC', resinChargeSign: 0, modulatorSpeciesId: 'Na', enableDonnan: false,
      compression: { enabled: true, eps0: 0.35, epsMin: 0.30, Pc_bar: 1.2 } },
    speciesIds: ['tracer', 'Na', 'Cl', 'AcT', 'AGG', 'mAb', 'SBI', 'WKI'],
    speciesOverrides: {
      Na: { transported: false }, Cl: { transported: false }, AcT: { transported: false },
      AGG: { epsPi: 0.10 }, mAb: { epsPi: 0.35 }, SBI: { epsPi: 0.62 }, WKI: { epsPi: 0.70 },
    },
    skid: { gradientMode: 'LPGF', mixerVolume_mL: 2.0, mixerN: 1, airTrap: true, inlineFilter: true,
      uv: { pathlength_mm: 2.0 } },
    tanks: [
      tank('TK-EQ', 'Running buffer (A)', 'A1', 6000, acetateBuffer(150.0), { emptyLevel_mL: 100 }),
      tank('TK-ELU', 'Running buffer (B, identical)', 'B1', 2000, acetateBuffer(150.0),
        { emptyLevel_mL: 100 }),
      tank('TK-WFI', 'Water for injection', 'A3', 2000, waterComposition(), { emptyLevel_mL: 100 }),
      tank('TK-NAOH', '0.5 M NaOH (CIP)', 'A4', 1000, naohComposition(500), { emptyLevel_mL: 100 }),
      tank('TK-FEED', 'Capture pool', 'S1', 200,
        Object.assign(acetateBuffer(150.0), { proteins: PILOT_FEED_PROTEINS }),
        { emptyLevel_mL: 20 }),
    ],
    inletAssignments: { A1: 'TK-EQ', A2: null, A3: 'TK-WFI', A4: 'TK-NAOH',
      B1: 'TK-ELU', B2: null, B3: null, B4: null, S1: 'TK-FEED', S2: null, S3: null },
    load: { basis: 'ML', value: 2.0, feedTiterTotal_gL: 5.00,
      productTiter_gL: 4.25, productSpeciesId: 'mAb' },
    methodMeta: { methodId: 'm-sec-lab', name: 'SEC polish, isocratic',
      globalDefaults: { flow: { mode: 'CM_H', value: 25 }, arm: { basis: 'CV', value: 0.02 },
        persistence_ticks: 5 },
      endState: { columnValve: 'BYPASS', outletValve: 'WASTE' },
      notes: 'Size exclusion: retention is pure pore accessibility, so aggregate elutes FIRST and ' +
        'the small tracer LAST at epsT. No gradient, no strip, no CIP.' },
    methodPhases: () => secPhases(),
    methodPatches: { B01: { autozero: true }, B02: { sample: { loopVolume_mL: 2.0 } } },
    sim: {}, ui: {}, chem: {},
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * 6. SCENARIOS (§6.22 — exactly these eight, and no others)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The eight one-click failure scenarios. Each is a pure overrides object plus an optional
 * `runMutator(config, run)` that touches `run` only (§2.4); `loadScenario` rebuilds through
 * `normalizePreset` and never mutates a frozen config.
 * @type {Array<{id:string, name:string, teachingNotes:string[], expectedOutcome:string,
 *               overrides:object, runMutator:((config:object, run:object)=>void)|null,
 *               autoStart:boolean, speed:number}>}
 */
export const SCENARIOS = [
  {
    id: 'textbook-clean',
    name: 'Textbook-clean separation',
    expectedOutcome: 'Four peaks, mAb apex near 12 AU/cm at 6.1 CV after gradient start, ' +
      'step yield 85–95 %, max ΔP 0.19–0.23 bar.',
    teachingNotes: [
      'This is the shipped method with the detector noise, drift and warm-up turned down — the run ' +
        'a textbook draws, and the reference every other scenario is compared against.',
      'WKI (3.12 CV) and SBI (13.24 CV) resolve cleanly, Rs 1.58 and 1.64. The aggregate does NOT ' +
        'resolve from the monomer: Rs(mAb/AGG) is about 0.37, a shoulder on the tail. That is the ' +
        'correct answer for a capture step, and it is why the pool tool exists.',
      'Watch the conductivity trace lag the %B setpoint: 245 mL of gradient hold-up with an ' +
        'effective 4.67 plates smears a step over roughly 291 mL, 10–90 %.',
      'The UV cell is 0.2 mm. The apex reads about 0.24 AU — a 2 mm cell would read 2.4 AU and ' +
        'saturate the detector.',
    ],
    overrides: {
      column: { channellingFactor: 0.0 },
      skid: { uv: { noiseWhite_AU: 2.0e-5, noisePink_AU: 6.0e-5, driftWarm_AU_s: 0,
        driftStart_AU: 0.002 }, cond: { noiseAbs_mScm: 0.001, noiseRel: 1e-4 },
        ph: { noise_pH: 0.001 } },
    },
    runMutator: null, autoStart: true, speed: 60,
  },
  {
    id: 'overloaded-column',
    name: 'Overloaded column (60 mg/mL)',
    expectedOutcome: 'Product breaks through during the load, the elution peak is square-topped ' +
      'and fronting, and step yield collapses well below 85 %.',
    teachingNotes: [
      'The load is raised from 15 to 60 mg of mAb per mL of column, against a static capacity of ' +
        'about 58 g/L of column volume. The column simply cannot hold it.',
      'Look at the UV trace DURING the load block, not the elution: the rising baseline is product ' +
        'leaving in the flow-through. Everything after that point is lost yield.',
      'The elution peak is fronting rather than tailing — a self-sharpening rear and a diffuse ' +
        'front is the signature of a favourable isotherm run into its plateau.',
      'The fix in a real plant is residence time or a second column, not a bigger gradient.',
    ],
    overrides: {
      load: { value: 60.0 },
      tanksById: { 'TK-FEED': { startVolume_mL: 26000, nominalVolume_mL: 26000 } },
    },
    runMutator: null, autoStart: true, speed: 300,
  },
  {
    id: 'gradient-too-steep',
    name: 'Gradient too steep (5 CV)',
    expectedOutcome: 'All four species co-elute in one tall, narrow band; Rs(WKI/mAb) drops below ' +
      '1.0 and the aggregate shoulder disappears inside the monomer peak.',
    teachingNotes: [
      'The linear gradient is compressed from 20 CV to 5 CV. Nothing else changes.',
      'Peak capacity scales with gradient length: four times steeper is roughly half the ' +
        'resolution, because Rs goes as the square root of the gradient volume.',
      'The apex gets taller and the peak narrower, which looks better on the chart and is worse ' +
        'chemistry — purity is set by resolution, not by peak height.',
      'Compare the pooled purity against textbook-clean at the same yield: that trade is the whole ' +
        'argument for a longer gradient.',
    ],
    overrides: { methodPatches: { B04: { duration: { basis: 'CV', value: 5 } } } },
    runMutator: null, autoStart: true, speed: 60,
  },
  {
    id: 'fouled-column-high-dp',
    name: 'Fouled column, high ΔP',
    expectedOutcome: 'ΔP settles near 0.84 bar: ALM-DP-01 warns, ALM-DP-02 forces the automatic ' +
      'REDUCE_FLOW escalation, and the run completes at reduced flow without tripping ALM-DP-03.',
    teachingNotes: [
      'The base frit resistance is raised from 0.0011 to 0.030 bar per cm/s and the fouling factor ' +
        'to its 500 ceiling, giving 0.625 bar of hardware ΔP on top of the 0.215 bar the clean ' +
        'system already makes.',
      'Fouling alone at nominal flow is worth only about +0.030 bar — 5 % of the way to the warn. ' +
        'A real high-ΔP event is nearly always the frit or the inlet distributor, not the bed.',
      'ALM-DP-02 reduces flow at 50 % per second down to 5 % of Qmax, then recovers at 5 %/s after ' +
        '30 s below the warn. The block still delivers its full CV — volume basis, not time basis.',
      'Peak shapes are unchanged: this scenario touches neither k_ov nor the isotherm, so the ' +
        'lesson is purely hydraulic.',
    ],
    overrides: { column: { rFrit_bar_per_cms: 0.030, foulingFactor: 500 } },
    runMutator: null, autoStart: true, speed: 60,
  },
  {
    id: 'air-in-the-line',
    name: 'Air in the line',
    expectedOutcome: 'The inlet air sensor raises ALM-AIR-01 and the skid PAUSES. Acknowledge and ' +
      'resume and the slug reaches the detectors: a UV spike, a conductivity dropout and a frozen ' +
      'pH reading — visible only because the column valve is in BYPASS.',
    teachingNotes: [
      'A COLUMN_BYPASS block has been inserted after the wash and is fed from TK-WASH, which is ' +
        'nearly empty. When the dip tube uncovers, the inlet vector cross-fades to gas over 2 s.',
      'Air is BLOCKED at the column inlet plane in this simulator (D4). With the column valve in ' +
        'DOWN or UP the downstream detectors never see gas at all, so the UV spike, the ' +
        'conductivity dropout and the pH freeze are visible ONLY in BYPASS or CIP_DETECTOR_BYPASS. ' +
        'That is exactly why this scenario runs its slug through a COLUMN_BYPASS block.',
      'ALM-AIR-01 pauses on 0.1 s of persistence — far faster than the roughly 1.7 min the slug ' +
        'needs to reach the UV cell. Acknowledge the alarm and resume to watch it travel.',
      'Refill TK-WASH (System tab) or switch the A inlet before resuming, or the next slug follows ' +
        'immediately.',
    ],
    overrides: {
      methodPhases: airInLinePhases,
      tanksById: { 'TK-WASH': { startVolume_mL: 1400, nominalVolume_mL: 1400, emptyLevel_mL: 900 } },
    },
    runMutator: null, autoStart: true, speed: 10,
  },
  {
    id: 'wrong-buffer-ph',
    name: 'Wrong buffer pH (equilibration at 4.20)',
    expectedOutcome: 'The pH trace sits near 4.2 instead of 5.0 through equilibration, load and ' +
      'wash; ALM-PH-01 warns, and retention shifts slightly as the buffer co-ion balance changes.',
    teachingNotes: [
      'TK-EQ is titrated to pH 4.20 instead of 5.00. The recipe is re-solved at ingest: acetate is ' +
        'only about 29 % ionised at 4.20 against 72 % at 5.00, so the NaOH titrant drops and the ' +
        'NaCl top-up rises to keep total sodium at 50 mM.',
      'Conductivity barely moves — total Na is unchanged — which is the trap. Conductivity is NOT ' +
        'a pH check, and a skid with only a conductivity monitor would never see this.',
      'Honest limitation: protein charge is frozen at ingest in this simulator (per-cell speciation ' +
        'is deferred), so the retention shift you see comes from the Donnan co-ion balance alone. ' +
        'On a real CEX column a 0.8 pH unit drop would raise mAb charge and retention much more.',
      'The elution buffer is untouched, so the gradient still ends at 500 mM — the pH step at the ' +
        'start of B04 is the two buffers meeting.',
    ],
    overrides: { tanksById: { 'TK-EQ': { composition: { targetPH: 4.20 } } } },
    runMutator: null, autoStart: true, speed: 60,
  },
  {
    id: 'cold-room',
    name: 'Cold room (5 °C)',
    expectedOutcome: 'Viscosity rises about 1.54×, so ΔP rises with it; peaks broaden as k_ov ' +
      'falls; and the temperature-compensated conductivity reads about 9.8 % HIGH.',
    teachingNotes: [
      'Every tank and the ambient are set to 5 °C. Water viscosity goes from 1.002 to 1.519 cP — ' +
        'a factor of 1.5444 — and bed ΔP is directly proportional to viscosity.',
      'The compensated conductivity reads about 9.8 % HIGH, not low. The physics of conductivity ' +
        'against temperature is quadratic; the meter compensates linearly, so it over-corrects. ' +
        'This is a real instrument artefact, modelled on purpose.',
      'Diffusivity falls with T/µ, so k_ov falls and every peak is wider. Cold rooms buy stability ' +
        'and cost resolution.',
      'The fluid takes about 15 min (fluidTau_s = 900) to reach the new temperature, so the first ' +
        'block runs on a moving baseline.',
    ],
    overrides: { skid: { ambientT_C: 5.0 }, tankDefaults: { T_C: 5 } },
    runMutator: null, autoStart: true, speed: 60,
  },
  {
    id: 'uncompensated-fractionation',
    name: 'Uncompensated fractionation',
    expectedOutcome: 'Every fraction boundary lands 50.25 mL early; each FractionRecord reports ' +
      'offsetError_mL = 50.25 and the pooled yield drops even though the chromatogram is identical.',
    teachingNotes: [
      'Only one field changes: delayCompensation goes from COMPENSATED to UNCOMPENSATED. The ' +
        'chemistry, the method and the chromatogram are bit-identical.',
      'The UV cell sits 50.25 mL upstream of the fraction valve. A decision taken when the detector ' +
        'sees the peak start must be EXECUTED 50.25 mL later, or the valve moves while the ' +
        'previous stream is still in the line.',
      'That is 3.2 % of a CV here, and 15.4 s at 196 mL/min — but only 7.7 s if you double the ' +
        'flow. Volume-keyed scheduling is correct through a ramp; time-keyed is not.',
      'Look at offsetError_mL in the fraction table: this is the single most common real-world ' +
        'cause of a pool that misses its purity spec while the trace looks perfect.',
    ],
    overrides: {
      methodPatches: { B04: { fractionation: { delayCompensation: 'UNCOMPENSATED' } } },
    },
    runMutator: null, autoStart: true, speed: 60,
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * 7. METHOD_TEMPLATES (§8.4.5 — exactly six)
 * ──────────────────────────────────────────────────────────────────────────── */

function pctBAt(phase, f) {
  const p = phase.pctB;
  if (p === undefined || p === null) return 0;
  if (Array.isArray(p)) {
    if ((phase.shape || 'LINEAR') === 'STEP') return p[1];
    return p[0] + (p[1] - p[0]) * f;
  }
  return p;
}

/** 32 evenly-spaced %B samples over the shorthand's total CV, for the 64x16 px picker preview. */
function sparkline32(phases) {
  const cvs = phases.map((p) => (typeof p.cv === 'number' && p.cv > 0 ? p.cv : 1));
  let total = 0;
  for (const c of cvs) total += c;
  const out = new Array(32);
  for (let k = 0; k < 32; k++) {
    const x = ((k + 0.5) / 32) * total;
    let acc = 0;
    let j = 0;
    while (j < cvs.length - 1 && acc + cvs[j] < x) { acc += cvs[j]; j++; }
    const f = cvs[j] > 0 ? clamp((x - acc) / cvs[j], 0, 1) : 0;
    out[k] = Math.round(pctBAt(phases[j], f) * 10) / 10;
  }
  return out;
}

let templateConfigCache = null;
function templateConfig() {
  if (templateConfigCache === null) templateConfigCache = normalizePreset(DEFAULT_PRESET_ID, {});
  return templateConfigCache;
}

/**
 * A template's `method` is built lazily against the default pilot config the first time it is read.
 * Building all six eagerly would be a top-level side effect (and six `buildTopology` calls) in a
 * module that every layer imports.
 */
function makeTemplate(id, name, phases) {
  const t = { id, name, sparkline: sparkline32(phases) };
  let cached = null;
  Object.defineProperty(t, 'method', {
    enumerable: true,
    configurable: false,
    get() {
      if (cached === null) {
        const cfg = templateConfig();
        cached = normalizeMethod(cfg, expandPresetMethod(cfg, phases));
      }
      return cached;
    },
  });
  return t;
}

const TEMPLATE_IEX_LINEAR = [
  { type: 'EQUILIBRATION', cv: 6, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'LOAD', cv: 3.5, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: 'S1' },
    sample: 'DIRECT' },
  { type: 'WASH', cv: 5, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'ELUTION_LINEAR', cv: 20, flow: 150, pctB: [0, 100], shape: 'LINEAR',
    inlets: { a: 'A1', b: 'B1', sample: null }, frac: 'PEAK' },
  { type: 'STRIP', cv: 3, flow: 150, pctB: 100, inlets: { a: 'A1', b: 'B2', sample: null } },
  { type: 'CIP', cv: 3, flow: 150, pctB: 0, inlets: { a: 'A4', b: 'B1', sample: null } },
  { type: 'RE_EQUILIBRATION', cv: 6, flow: 150, pctB: 0,
    inlets: { a: 'A1', b: 'B1', sample: null } },
];

const TEMPLATE_IEX_STEP = [
  { type: 'EQUILIBRATION', cv: 6, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'LOAD', cv: 3.5, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: 'S1' },
    sample: 'DIRECT' },
  { type: 'WASH', cv: 5, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'ELUTION_STEP', cv: 5, flow: 150, pctB: 20, inlets: { a: 'A1', b: 'B1', sample: null },
    frac: 'PEAK' },
  { type: 'ELUTION_STEP', cv: 5, flow: 150, pctB: 40, inlets: { a: 'A1', b: 'B1', sample: null },
    frac: 'PEAK' },
  { type: 'ELUTION_STEP', cv: 5, flow: 150, pctB: 100, inlets: { a: 'A1', b: 'B1', sample: null },
    frac: 'PEAK' },
  { type: 'CIP', cv: 3, flow: 150, pctB: 0, inlets: { a: 'A4', b: 'B1', sample: null } },
  { type: 'RE_EQUILIBRATION', cv: 6, flow: 150, pctB: 0,
    inlets: { a: 'A1', b: 'B1', sample: null } },
];

const TEMPLATE_SEC = [
  { type: 'EQUILIBRATION', cv: 2, flow: 25, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'LOAD', cv: 0.02, flow: 25, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: 'S1' },
    sample: 'LOOP_INJECT' },
  { type: 'ELUTION_ISOCRATIC', cv: 1.5, flow: 25, pctB: 0,
    inlets: { a: 'A1', b: 'B1', sample: null }, frac: 'PEAK' },
];

const TEMPLATE_PROTEIN_A = [
  { type: 'EQUILIBRATION', cv: 5, flow: 300, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'LOAD', cv: 8, flow: 300, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: 'S1' },
    sample: 'DIRECT' },
  { type: 'WASH', cv: 5, flow: 300, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'ELUTION_STEP', cv: 5, flow: 150, pctB: 100, inlets: { a: 'A1', b: 'B1', sample: null },
    frac: 'PEAK' },
  { type: 'CIP', cv: 3, flow: 150, pctB: 0, inlets: { a: 'A4', b: 'B1', sample: null } },
  { type: 'RE_EQUILIBRATION', cv: 5, flow: 300, pctB: 0,
    inlets: { a: 'A1', b: 'B1', sample: null } },
];

const TEMPLATE_HIC = [
  { type: 'EQUILIBRATION', cv: 5, flow: 150, pctB: 100, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'LOAD', cv: 4, flow: 150, pctB: 100, inlets: { a: 'A1', b: 'B1', sample: 'S1' },
    sample: 'DIRECT' },
  { type: 'WASH', cv: 3, flow: 150, pctB: 100, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'ELUTION_LINEAR', cv: 15, flow: 150, pctB: [100, 0], shape: 'LINEAR',
    inlets: { a: 'A1', b: 'B1', sample: null }, frac: 'PEAK' },
  { type: 'STRIP', cv: 3, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
  { type: 'RE_EQUILIBRATION', cv: 5, flow: 150, pctB: 100,
    inlets: { a: 'A1', b: 'B1', sample: null } },
];

const TEMPLATE_BLANK = [
  { type: 'EQUILIBRATION', cv: 5, flow: 150, pctB: 0, inlets: { a: 'A1', b: 'B1', sample: null } },
];

/**
 * The method editor's six starting points. `sparkline` is 32 %B samples; `method` is built lazily
 * against the default pilot config on first read.
 * @type {Array<{id:string, name:string, sparkline:number[], method:object}>}
 */
export const METHOD_TEMPLATES = [
  makeTemplate('iex-bind-elute-linear', 'IEX bind & elute, linear gradient', TEMPLATE_IEX_LINEAR),
  makeTemplate('iex-step', 'IEX step elution (20 / 40 / 100 %B)', TEMPLATE_IEX_STEP),
  makeTemplate('sec-isocratic', 'SEC isocratic', TEMPLATE_SEC),
  makeTemplate('protein-a', 'Protein A capture, low-pH elution', TEMPLATE_PROTEIN_A),
  makeTemplate('hic-descending-salt', 'HIC, descending salt', TEMPLATE_HIC),
  makeTemplate('blank', 'Blank (single equilibration block)', TEMPLATE_BLANK),
];

/* ────────────────────────────────────────────────────────────────────────────
 * 8. normalizePreset — THE ingest boundary
 * ──────────────────────────────────────────────────────────────────────────── */

function buildColumn(def, scaleRow) {
  // A missing resin entry is not fatal by itself: COLUMN_DEFAULTS carries the PrepSP-90 HF
  // numbers, and requireFinite below turns any remaining gap into a loud ingest error.
  const resin = lookup(getResin, RESINS, def.resinId);
  const scaleCol = (scaleRow && scaleRow.column) || {};
  const raw = Object.assign({}, COLUMN_DEFAULTS, scaleCol, resin || {}, def.column || {});

  // --- human -> canonical: µm and nm are the two authoring units the resin tables may use -------
  let dp_cm = firstDefined(raw.dp_cm, raw.dp_um !== undefined ? raw.dp_um * 1e-4 : undefined);
  let rPore_cm = firstDefined(raw.rPore_cm,
    raw.rPore_nm !== undefined ? raw.rPore_nm * 1e-7 : undefined);
  dp_cm = requireFinite(dp_cm, 'column.dp_cm');
  rPore_cm = requireFinite(rPore_cm, 'column.rPore_cm');

  const id_cm = requireFinite(raw.id_cm, 'column.id_cm');
  const L_cm = requireFinite(raw.L_cm, 'column.L_cm');
  const epsC = requireFinite(raw.epsC, 'column.epsC');
  const epsP = requireFinite(raw.epsP, 'column.epsP');

  const A_cm2 = area_cm2(id_cm);
  const V_mL = A_cm2 * L_cm;
  const Vbead_mL = (1 - epsC) * V_mL;

  // BASIS N1: q, Lambda and q_max are per mL of PARTICLE volume. 0.2275 * 1000 / 0.65 = 350.0000.
  const Lambda_mM = firstDefined(raw.Lambda_mM,
    raw.Lambda_mmolPerMLbed !== undefined ? LambdaBead_mM(raw.Lambda_mmolPerMLbed, epsC) : undefined,
    350.0);

  const comp = Object.assign({}, COLUMN_DEFAULTS.compression, raw.compression || {});
  if (comp.eps0 === undefined || comp.eps0 === null) comp.eps0 = epsC;

  return {
    id_cm, L_cm, A_cm2, V_mL, Vbead_mL,
    epsC, epsP, epsT: epsTotal(epsC, epsP),
    phi: (1 - epsC) / epsC,
    dp_cm, rp_cm: dp_cm / 2, rPore_cm,
    lambdaPack: raw.lambdaPack, gammaObstruction: raw.gammaObstruction, kKozeny: raw.kKozeny,
    Lambda_mM,
    Lambda_mmolPerMLbed: raw.Lambda_mmolPerMLbed,
    isothermMode: raw.isothermMode,
    resinChargeSign: raw.resinChargeSign,
    modulatorSpeciesId: raw.modulatorSpeciesId === undefined ? null : raw.modulatorSpeciesId,
    modulatorIdx: -1, modulatorColIdx: -1,   // filled once the species registry is sorted
    enableDonnan: raw.enableDonnan === true,
    channellingFactor: clamp(raw.channellingFactor || 0, 0, 1),
    compression: comp,
    hardwarePressureLimit_bar: raw.hardwarePressureLimit_bar,
    rFrit_bar_per_cms: raw.rFrit_bar_per_cms,
    foulingFactor: raw.foulingFactor,
    enableProteinViscosity: raw.enableProteinViscosity === true,
    nz: raw.nz | 0, nuTarget: raw.nuTarget, dtCap_s: raw.dtCap_s, nSubMax: raw.nSubMax | 0,
    enableExplicitDispersion: raw.enableExplicitDispersion === true,
    DL_override_cm2s: raw.DL_override_cm2s === undefined ? null : raw.DL_override_cm2s,
    resinId: def.resinId || null,
    maxCycles: (resin && resin.maxCycles) !== undefined ? resin.maxCycles : 200,
  };
}

const KIND_RANK = { inert: 0, donnan: 1, binding: 2 };

function canonicaliseSpecies(id, raw, column) {
  const MW_gmol = requireFinite(
    firstDefined(raw.MW_gmol, raw.MW_kDa !== undefined ? raw.MW_kDa * 1000 : undefined),
    `species '${id}'.MW_gmol`);
  const epsPi = clamp(firstDefined(raw.epsPi, column.epsP), 0, column.epsP);
  const eps = (mass, molar) => {
    if (mass !== undefined && mass !== null) return mass;
    if (molar !== undefined && molar !== null) return extMass_Lgcm(molar, MW_gmol);
    return 0;
  };
  const kind = raw.kind || 'binding';
  if (KIND_RANK[kind] === undefined) {
    throw new Error(`normalizePreset: species '${id}' has unknown kind '${kind}'`);
  }
  return {
    id,
    name: raw.name || id,
    role: raw.role || 'impurity',
    MW_gmol,
    transported: raw.transported !== false,
    kind,
    donnanRole: raw.donnanRole || null,          // authored override; derived below when null
    epsPi,
    KD: column.epsP > 0 ? epsPi / column.epsP : 0,
    Dm_cm2s: raw.Dm_cm2s === undefined ? null : raw.Dm_cm2s,
    Dp_cm2s: raw.Dp_cm2s === undefined ? null : raw.Dp_cm2s,
    keffScale: firstDefined(raw.keffScale, 1.0),
    concScale_mM: firstDefined(raw.concScale_mM, 1.0),
    nu: firstDefined(raw.nu, 0), sigma: firstDefined(raw.sigma, 0), Keq: firstDefined(raw.Keq, 0),
    qmax_mM: firstDefined(raw.qmax_mM, 0), b0_mM1: firstDefined(raw.b0_mM1, 0),
    beta_mM1: firstDefined(raw.beta_mM1, 0), csRef_mM: firstDefined(raw.csRef_mM, 0),
    Klin: firstDefined(raw.Klin, 0),
    eps280_Lgcm: eps(raw.eps280_Lgcm, raw.eps280_M1cm1),
    eps260_Lgcm: eps(raw.eps260_Lgcm, raw.eps260_M1cm1),
    eps300_Lgcm: eps(raw.eps300_Lgcm, raw.eps300_M1cm1),
    charge: firstDefined(raw.charge, 0),
    ionisedFraction: 1.0,                        // derived from the A1 tank's solved pH, below
    lambda0_Scm2eq: firstDefined(raw.lambda0_Scm2eq, 0),
    bufferId: raw.bufferId || null,
    bufferPkas: raw.bufferPkas || null,
    bufferZ0: firstDefined(raw.bufferZ0, 0),
    bufferDpKadT: firstDefined(raw.bufferDpKadT, 0),
  };
}

function buildSpecies(def, column) {
  const ids = def.speciesIds || PILOT_SPECIES_IDS;
  const overrides = def.speciesOverrides || {};
  const list = [];
  for (const id of ids) {
    const lib = lookup(getSpecies, SPECIES, id);
    const fallback = SPECIES_DEFAULTS[id];
    if (!lib && !fallback) {
      throw new Error(`normalizePreset: species '${id}' is in neither data/library.js SPECIES ` +
        'nor the local fallback table');
    }
    // library.js is authoritative per field; the fallback fills only what it omits.
    const raw = Object.assign({}, fallback || {}, lib || {}, overrides[id] || {});
    list.push(canonicaliseSpecies(id, raw, column));
  }
  // NORMATIVE ORDER: inert, then donnan, then binding; authoring order preserved inside a group.
  // Array.prototype.sort is stable (ES2019), which is what preserves it.
  list.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

  // donnanRole (§5.8.3) — derived unless the species authored an override.
  const sign = column.resinChargeSign;
  for (const s of list) {
    if (s.donnanRole === null) {
      if (s.kind !== 'donnan' || s.charge === 0) s.donnanRole = 'NONE';
      else if (s.charge * sign < 0) s.donnanRole = 'COUNTER';
      else if (s.charge * sign > 0) s.donnanRole = 'CO';
      else s.donnanRole = 'NONE';
    }
  }
  return list;
}

function buildIndices(species) {
  const ns = species.length;
  const colIdxOf = new Int32Array(ns);
  const idxById = {};
  let nsCol = 0;
  for (let i = 0; i < ns; i++) {
    idxById[species[i].id] = i;
    colIdxOf[i] = species[i].transported ? nsCol++ : -1;
  }
  const skidIdxOf = new Int32Array(nsCol);
  for (let i = 0; i < ns; i++) if (colIdxOf[i] >= 0) skidIdxOf[colIdxOf[i]] = i;
  return { ns, nsCol, colIdxOf, skidIdxOf, idxById };
}

function buildSegments(def, skid) {
  const rows = SEGMENT_TABLE && SEGMENT_TABLE[def.scale];
  if (!rows || !rows.length) {
    throw new Error(`normalizePreset: data/library.js SEGMENT_TABLE has no rows for scale ` +
      `'${def.scale}'`);
  }
  const out = [];
  for (const r of rows) {
    const seg = { id: r.id, group: r.group, V_mL: r.V_mL, N: r.N };
    // §5.7.2: G2 is the SELECTED mixer; G5 collapses without the air trap; G4 without the filter.
    if (seg.id === 'G2') { seg.V_mL = skid.mixerVolume_mL; seg.N = skid.mixerN; }
    if (seg.id === 'G5' && skid.airTrap === false) { seg.V_mL = 0.05; seg.N = 1; }
    if (seg.id === 'G4' && skid.inlineFilter === false) { seg.V_mL = 0; seg.N = 1; }
    if (!(seg.N >= 1)) seg.N = 1;
    out.push(seg);
  }
  return out;
}

function buildSkid(def, scaleRow) {
  const s = scaleRow || {};
  const authored = def.skid || {};
  const Qmax_mLs = requireFinite(firstDefined(authored.Qmax_mLs, s.Qmax_mLs,
    (SCALE_FALLBACK[def.scale] || {}).Qmax_mLs), 'skid.Qmax_mLs');
  const fb = SCALE_FALLBACK[def.scale] || {};
  // data/library.js's SCALES ship `fracValvePorts` as an ARRAY of port ids (['F1'..'F12']), and
  // that file's assembly rule is `skid.fracValve.ports <- scale.fracValvePorts`. The local
  // SCALE_FALLBACK table ships a COUNT instead. Accept both shapes: an array is the port list
  // verbatim, a number is a count of 'F1'..'Fn'. The previous unconditional `| 0` coerced the
  // library's array to 0, so `ports` came out EMPTY at every scale and the fraction collector
  // could never open — B04 ran its whole peak to WASTE and produced zero FractionRecords.
  const portsSrc = firstDefined(authored.fracValvePorts, s.fracValvePorts, fb.fracValvePorts, 12);
  let ports;
  if (Array.isArray(portsSrc)) {
    ports = portsSrc.slice();
  } else {
    ports = [];
    const nPorts = portsSrc | 0;
    for (let i = 1; i <= nPorts; i++) ports.push('F' + i);
  }

  const uv = Object.assign({}, UV_DEFAULTS, authored.uv || {});
  const pathlength_cm = firstDefined(uv.pathlength_cm,
    uv.pathlength_mm !== undefined ? uv.pathlength_mm / 10 : undefined, 0.02);
  delete uv.pathlength_mm;
  uv.pathlength_cm = requireFinite(pathlength_cm, 'skid.uv.pathlength_cm');
  uv.channels_nm = (uv.channels_nm || [280, 260, 300]).slice();

  const skid = Object.assign({}, SKID_DEFAULTS, {
    mixerVolume_mL: firstDefined(authored.mixerVolume_mL, s.mixerVolume_mL, fb.mixerVolume_mL, 100),
    mixerOptions_mL: (firstDefined(s.mixerOptions_mL, fb.mixerOptions_mL, [50, 100, 250])).slice(),
    Qmax_mLs,
    Qmin_mLs: firstDefined(authored.Qmin_mLs, s.Qmin_mLs, fb.Qmin_mLs, Qmax_mLs * 0.02),
    QminAbs_mLs: firstDefined(authored.QminAbs_mLs, s.QminAbs_mLs, fb.QminAbs_mLs, Qmax_mLs * 0.005),
    rampRate_mLs2: firstDefined(authored.rampRate_mLs2, s.rampRate_mLs2, fb.rampRate_mLs2,
      Qmax_mLs * 0.10),
    Vstroke_mL: firstDefined(authored.Vstroke_mL, s.Vstroke_mL, fb.Vstroke_mL, 5.0),
    wasteCapacity_mL: firstDefined(authored.wasteCapacity_mL, s.wasteCapacity_mL,
      fb.wasteCapacity_mL, 200000),
    segments: [], holdup: null,
    uv,
    cond: Object.assign({}, COND_DEFAULTS, authored.cond || {}),
    ph: Object.assign({}, PH_DEFAULTS, authored.ph || {}),
    press: Object.assign({}, PRESS_DEFAULTS, {
      Rdown_bar_per_mLs: firstDefined(
        (authored.press || {}).Rdown_bar_per_mLs, s.Rdown_bar_per_mLs, fb.Rdown_bar_per_mLs, 0.027),
    }, authored.press || {}),
    filter: Object.assign({}, FILTER_DEFAULTS, authored.filter || {}),
    fracValve: Object.assign({
      tSwitch_s: firstDefined(s.tSwitch_s, fb.tSwitch_s, 0.80),
      overflowTo: 'WASTE',
      portCapacity_mL: firstDefined(s.portCapacity_mL, fb.portCapacity_mL, 500),
      ports,
    }, authored.fracValve || {}),
  });
  // scalar authored keys that are not sub-objects
  for (const k of ['gradientMode', 'chopPeriod_s', 'tMinOpen_s', 'mixerN', 'airTrap',
    'inlineFilter', 'estopRamp_s', 'rippleFlow_frac', 'ripplePress_frac', 'QswitchMax_frac',
    'ambientT_C', 'fluidTau_s', 'bubbleSensorThreshold_frac', 'loopVolume_mL']) {
    if (authored[k] !== undefined) skid[k] = authored[k];
  }
  if (skid.mixerN === undefined || !(skid.mixerN >= 1)) skid.mixerN = 1;
  skid.segments = buildSegments(def, skid);
  return skid;
}

function buildLoad(def, column) {
  const a = def.load || {};
  const basis = a.basis || 'MG_PER_ML_RESIN';
  const value = requireFinite(a.value, 'load.value');
  const productTiter_gL = requireFinite(a.productTiter_gL, 'load.productTiter_gL');
  let mass_g;
  let volume_mL;
  if (basis === 'MG_PER_ML_RESIN') {
    mass_g = value * column.V_mL / 1000;
    volume_mL = mass_g * 1000 / productTiter_gL;
  } else if (basis === 'G_TOTAL') {
    mass_g = value;
    volume_mL = mass_g * 1000 / productTiter_gL;
  } else if (basis === 'CV') {
    volume_mL = value * column.V_mL;
    mass_g = volume_mL * productTiter_gL / 1000;
  } else if (basis === 'ML') {
    volume_mL = value;
    mass_g = volume_mL * productTiter_gL / 1000;
  } else {
    throw new Error(`normalizePreset: unknown load.basis '${basis}'`);
  }
  return {
    basis, value,
    feedTiterTotal_gL: requireFinite(a.feedTiterTotal_gL, 'load.feedTiterTotal_gL'),
    productTiter_gL,
    productSpeciesId: a.productSpeciesId || 'mAb',
    derived: { mass_g, volume_mL, CV: volume_mL / column.V_mL },
  };
}

/**
 * Solve every tank (§8.2). The NaCl top-up is `saltTarget.total_mM - solveCounterIon().cation_mM`,
 * WITH the Davies correction — it is never a stored constant. Verified anchors for the shipped
 * pilot: buffer A NaOH 36.014 / NaCl 13.986 mM; buffer B NaOH 38.243 / NaCl 461.757 mM.
 */
function buildTanks(def, draft) {
  const src = def.tanks || [];
  const defaults = def.tankDefaults || {};
  const byId = def.tanksById || {};
  const out = [];
  const scratch = { cation_mM: 0, anion_mM: 0, I_molL: 0, pH: 7 };

  for (const t0 of src) {
    let t = deepMerge(cloneAuthored(t0), defaults);
    if (byId[t0.id]) t = deepMerge(t, byId[t0.id]);

    const comp = t.composition || waterComposition();
    const proteins = comp.proteins || [];
    const chemComp = Object.assign({}, comp);
    delete chemComp.proteins;

    let titrant_mM = 0;
    let saltNaCl_mM = 0;
    const hasBuffer = Array.isArray(chemComp.buffers) && chemComp.buffers.length > 0;
    if (hasBuffer && chemComp.targetPH !== null && chemComp.targetPH !== undefined) {
      const r = solveCounterIon(draft, chemComp, chemComp.targetPH, t.T_C, scratch);
      titrant_mM = r.cation_mM;
      if (chemComp.saltTarget && chemComp.saltTarget.total_mM !== undefined) {
        saltNaCl_mM = chemComp.saltTarget.total_mM - titrant_mM;
        if (saltNaCl_mM < -1e-9) {
          throw new Error(`normalizePreset: tank '${t.id}' target ion ` +
            `${chemComp.saltTarget.total_mM} mM is below the titration requirement ` +
            `${titrant_mM.toFixed(3)} mM`);
        }
        if (saltNaCl_mM < 0) saltNaCl_mM = 0;
      }
    } else if (chemComp.saltTarget && chemComp.saltTarget.total_mM !== undefined) {
      saltNaCl_mM = chemComp.saltTarget.total_mM;
    }

    const y_mM = buildTankVector(draft, Object.assign({}, chemComp, { saltNaCl_mM }));
    for (const p of proteins) {
      const i = draft.idxById[p.speciesId];
      if (i === undefined) {
        throw new Error(`normalizePreset: tank '${t.id}' references unknown species ` +
          `'${p.speciesId}'`);
      }
      y_mM[i] += mM_from_gL(p.c_gL, draft.species[i].MW_gmol);
    }

    const d = describeTank(draft, y_mM, t.T_C);
    out.push({
      id: t.id, label: t.label, port: t.port,
      nominalVolume_mL: t.nominalVolume_mL, startVolume_mL: t.startVolume_mL,
      lowLevelPct: t.lowLevelPct, emptyLevel_mL: t.emptyLevel_mL, T_C: t.T_C,
      isSample: t.isSample === true,
      composition: Object.assign({}, comp, { proteins: proteins.slice() }),
      derived: {
        titrantCation_mM: titrant_mM, saltNaCl_mM,
        pH: d.pH, kappa25_mScm: d.kappa25_mScm, I_molL: d.I_molL,
        Na_mM: d.Na_mM, Cl_mM: d.Cl_mM,
      },
      y_mM,
    });
  }
  return out;
}

/**
 * Freeze `ionisedFraction` from the reference (inlet A1) tank's solved pH and the Davies-adjusted
 * pKa ladder. Acetate at pH 5.00, pKa' 4.5892 gives 0.72028, so 50 mM AcT contributes 36.014 mM of
 * co-ion equivalent and the Donnan group sums balance exactly (§7.2.4, §5.8.2).
 * Per-cell speciation inside the bed is deferred (D3) — this is a frozen approximation on purpose.
 */
function deriveIonisedFractions(species, tanks, inletAssignments) {
  const refId = inletAssignments && inletAssignments.A1;
  const ref = tanks.find((t) => t.id === refId) || tanks[0];
  if (!ref) return;
  const pH = ref.derived.pH;
  const I_molL = ref.derived.I_molL;
  const H_molL = Math.pow(10, -pH);
  for (const s of species) {
    if (s.charge === 0) { s.ionisedFraction = 1.0; continue; }   // |z| = 0 makes this a no-op
    if (!s.bufferPkas || !s.bufferPkas.length) { s.ionisedFraction = 1.0; continue; }
    const bd = (s.bufferId && BUFFER_LIBRARY[s.bufferId]) || {
      pKas: s.bufferPkas, z0: s.bufferZ0, dpKadT: s.bufferDpKadT,
    };
    const zbar = meanCharge(bd, H_molL, I_molL);
    const f = Math.abs(zbar) / Math.abs(s.charge);
    s.ionisedFraction = Number.isFinite(f) ? clamp(f, 0, 1) : 1.0;
  }
}

function resolveSignalName(name, tankIndexById, where) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const i = name.indexOf(':');
  if (i < 0) return { base: name, tankIdx: -1 };
  const base = name.slice(0, i);
  const key = name.slice(i + 1);
  if (base === 'TANK_LEVEL') {
    const idx = tankIndexById.get(key);
    if (idx === undefined) {
      throw new Error(`normalizePreset: ${where} references unknown tank id '${key}' in ` +
        `signal '${name}'`);
    }
    return { base, tankIdx: idx };
  }
  return { base, tankIdx: -1 };
}

function buildAlarms(def, scaleRow, tankIndexById) {
  if (!Array.isArray(ALARM_TABLE) || ALARM_TABLE.length === 0) {
    throw new Error('normalizePreset: skid/alarms.js ALARM_TABLE is empty');
  }
  const scaleOv = (scaleRow && scaleRow.alarmThresholdOverrides) || {};
  const presetOv = def.alarmThresholdOverrides || {};
  return ALARM_TABLE.map((row) => {
    const a = Object.assign({}, row);
    let th = a.threshold;
    if (isPlainObject(th)) th = th[def.scale];                 // { LAB, PILOT, PROCESS }
    if (scaleOv[a.id] !== undefined) th = scaleOv[a.id];
    if (presetOv[a.id] !== undefined) th = presetOv[a.id];
    a.threshold = th === undefined ? null : th;
    a.suppressWhen = Array.isArray(row.suppressWhen) ? row.suppressWhen.slice() : [];
    a.signalResolved = resolveSignalName(a.signal, tankIndexById, `alarm '${a.id}'`);
    return a;
  });
}

function applyMethodPatches(method, patches) {
  if (!patches || !method || !Array.isArray(method.blocks)) return method;
  for (const id of Object.keys(patches)) {
    const k = method.blocks.findIndex((b) => b && b.id === id);
    if (k >= 0) method.blocks[k] = deepMerge(method.blocks[k], patches[id]);
  }
  return method;
}

function resolveWatchSignals(method, tankIndexById) {
  if (!method || !Array.isArray(method.blocks)) return;
  for (const b of method.blocks) {
    if (!b || !Array.isArray(b.watches)) continue;
    for (const w of b.watches) {
      if (w && !w.signalResolved) {
        w.signalResolved = resolveSignalName(w.signal, tankIndexById,
          `watch '${w.id}' in block '${b.id}'`);
      }
    }
  }
}

/**
 * THE ingest boundary. Reads one authored preset, deep-merges `overrides` onto it, converts every
 * human unit exactly once, computes every derived field, solves every tank recipe, expands and
 * normalises the method, and returns a `deepFreeze`d §2.1 `config`.
 *
 * Derived here and nowhere else: `A_cm2` (cm²), `V_mL` (mL), `Vbead_mL` (mL), `epsT`, `phi`,
 * `Lambda_mM` (mM on the bead basis), the `epsPi` clamp to [0, epsP], `KD`, `donnanRole`,
 * `ionisedFraction`, `colIdxOf`/`skidIdxOf`/`idxById`, `modulatorIdx`/`modulatorColIdx`,
 * `load.derived` (g, mL, CV), the per-scale segment table, `skid.holdup` (mL) via
 * `skid.buildTopology`, the per-scale alarm thresholds and every `TANK_LEVEL:<id>` pre-split.
 *
 * @param {string} presetId  A key of `PRESETS`, e.g. 'cex-capture-igg1-pilot'.
 * @param {object} [overrides]  Deep-merged onto the AUTHORED preset before any derivation. Plain
 *   objects recurse, arrays and leaves replace. Extra keys: `tanksById`, `tankDefaults`,
 *   `speciesOverrides`, `methodPatches`, and `methodPhases` (array or `(config)=>array`).
 * @returns {object} The frozen canonical `config` of §2.1. Units: lengths cm, volumes mL, time s,
 *   flow mL/s, concentrations mM, pressure bar, absorbance AU (thresholds AU/cm), temperature °C.
 * @throws {Error} On an unknown preset id, a non-finite required number, an unknown species or
 *   tank id, or a salt target below the titration requirement.
 */
export function normalizePreset(presetId, overrides) {
  const base = PRESETS[presetId];
  if (!base) throw new Error(`normalizePreset: unknown presetId '${presetId}'`);

  const def = deepMerge(cloneAuthored(base), overrides || {});
  const scaleRow = lookup(getScale, SCALES, def.scale) || {};

  const column = buildColumn(def, scaleRow);
  const species = buildSpecies(def, column);
  const idx = buildIndices(species);

  const modId = column.modulatorSpeciesId;
  column.modulatorIdx = (modId !== null && idx.idxById[modId] !== undefined)
    ? idx.idxById[modId] : -1;
  column.modulatorColIdx = column.modulatorIdx >= 0 ? idx.colIdxOf[column.modulatorIdx] : -1;

  const chem = Object.assign({}, CHEM_DEFAULTS, def.chem || {});
  const skid = buildSkid(def, scaleRow);
  const load = buildLoad(def, column);

  // A partial config is enough for chem/ph.js (species registry + chem constants) and for
  // skid.buildTopology (segments + fracValve). Both read only; neither mutates.
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    presetId: def.id, name: def.name, scale: def.scale, seed: def.seed | 0,
    column, species, chem, skid, load,
    ns: idx.ns, nsCol: idx.nsCol,
    colIdxOf: idx.colIdxOf, skidIdxOf: idx.skidIdxOf, idxById: idx.idxById,
    inletAssignments: Object.assign({}, def.inletAssignments || {}),
    tanks: [], alarms: [], method: null,
    sim: Object.assign({}, SIM_DEFAULTS, def.sim || {}),
    ui: Object.assign({}, UI_DEFAULTS, def.ui || {}),
  };
  draft.sim.speedOptions = (draft.sim.speedOptions || SIM_DEFAULTS.speedOptions).slice();

  draft.tanks = buildTanks(def, draft);
  deriveIonisedFractions(species, draft.tanks, draft.inletAssignments);

  const tankIndexById = new Map();
  for (let i = 0; i < draft.tanks.length; i++) tankIndexById.set(draft.tanks[i].id, i);

  const topo = buildTopology(draft);
  skid.holdup = topo.holdup;

  draft.alarms = buildAlarms(def, scaleRow, tankIndexById);

  const phasesSrc = def.methodPhases;
  const phases = typeof phasesSrc === 'function' ? phasesSrc(draft) : (phasesSrc || []);
  let method = expandPresetMethod(draft, phases);
  method = Object.assign(method, {
    schemaVersion: SCHEMA_VERSION,
    scale: def.scale,
  }, def.methodMeta || {});
  method = applyMethodPatches(method, def.methodPatches);
  method = normalizeMethod(draft, method);
  resolveWatchSignals(method, tankIndexById);
  draft.method = method;

  return deepFreeze(draft);
}

/**
 * The preset picker's list.
 * @returns {Array<{id:string, name:string, scale:string, mode:string}>} `mode` is the preset's
 *   `column.isothermMode` ('SMA' | 'LANGMUIR' | 'HIC' | 'SEC' | 'LINEAR' | 'INERT').
 */
export function listPresets() {
  return Object.keys(PRESETS).map((id) => {
    const p = PRESETS[id];
    return {
      id,
      name: p.name,
      scale: p.scale,
      mode: (p.column && p.column.isothermMode) || COLUMN_DEFAULTS.isothermMode,
    };
  });
}

/**
 * The scenario picker's list (§6.34).
 * @returns {Array<{id:string, name:string, expectedOutcome:string}>} In `SCENARIOS` order.
 */
export function listScenarios() {
  return SCENARIOS.map((s) => ({ id: s.id, name: s.name, expectedOutcome: s.expectedOutcome }));
}
