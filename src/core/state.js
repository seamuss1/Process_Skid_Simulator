/**
 * src/core/state.js — run-state allocation, reset, snapshot and restore. Nothing else.
 *
 * Contract: architecture-v2 §2.2 (the `run` shape), §6.3 (this module), §5.9 (RNG streams).
 *
 * `createRunState` allocates EVERY typed array of §2.2 EXCEPT `run.segC_mM` and `run.segAir`,
 * whose lengths depend on `topo.nTanksTotal`; `skid/skid.js::createSkid(config, run)` allocates
 * those two and builds `run.topo`, `run.bed` and `run.col`. Calling `createRunState` without a
 * following `createSkid` is a documented error (§6.3, §11 C-26).
 *
 * Layer L8. Imports `core/util.js` (L0), `core/log.js` (L0) and `skid/engine.js` (L5) for
 * `LEGAL_TRANSITIONS` only. The event API lives in `core/log.js`, NOT here: routing logging
 * through this file closes the cycle `state -> presets -> skid -> state` (§4, §11 C-66).
 * This module therefore imports neither `data/presets.js` nor `skid/skid.js`.
 */

import { createRng, nextGaussian, RNG_STREAMS } from './util.js';
import { buildLogChannels, createChannelStore, createRing } from './log.js';
import { LEGAL_TRANSITIONS } from '../skid/engine.js';

/** Slots in the shared slope ring (§2.2). */
const SLOPE_RING_SLOTS = 64;
/** Maximum concurrent slope-ring signals (§6.16, NSIG_MAX). */
const NSIG_MAX = 6;
/** Standard deviation of the once-per-run %B proportioner bias, in percent B (§5.9). */
const PUMP_BIAS_SIGMA_PCT = 0.4;
/** Snapshot payload version; bumped only when the snapshot field set changes. */
const SNAPSHOT_VERSION = '2.0';

/**
 * Deep clone into structured-clone-safe plain data: typed arrays become `Array`, plain objects
 * and arrays are copied recursively, functions are dropped, primitives pass through.
 * @param {*} v value to clone
 * @returns {*} plain clone (no typed arrays, no functions, no prototypes)
 */
function plainClone(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? null : v;
  if (ArrayBuffer.isView(v)) return Array.from(/** @type {any} */ (v));
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = plainClone(v[i]);
    return out;
  }
  if (v instanceof Map) {
    const out = {};
    for (const [k, val] of v) out[String(k)] = plainClone(val);
    return out;
  }
  const out = {};
  for (const k of Object.keys(v)) {
    const val = v[k];
    if (typeof val === 'function') continue;
    out[k] = plainClone(val);
  }
  return out;
}

/**
 * Copy a plain array (or typed array) back into a preallocated Float64Array, up to its length.
 * @param {Float64Array|Int32Array|Uint8Array} dst destination typed array
 * @param {ArrayLike<number>|null|undefined} src source values
 * @returns {void}
 */
function fillFrom(dst, src) {
  if (!dst || !src) return;
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = Number(src[i]) || 0;
}

/**
 * Allocate the complete mutable run state for a frozen config (§2.2).
 *
 * Every typed array of §2.2 is allocated here except `run.segC_mM` and `run.segAir`
 * (topology-sized; `skid.createSkid` allocates them and this function sets them to `null`).
 * `RNG_STREAMS.PUMP_BIAS` is drawn EXACTLY ONCE here, into `run.biasPctB` — the one documented
 * exception to the per-tick draw rule (§5.9).
 *
 * @param {object} config frozen config from `data/presets.js::normalizePreset` (§2.1)
 * @returns {object} run — the mutable run state of §2.2. Units are carried in the field names:
 *   volumes `_mL`, flows `_mLs` (mL/s), times `_s`, concentrations `_mM`, amounts `_umol`,
 *   pressures `_bar`, viscosity `_cP`, density `_gmL`, temperatures `_C`.
 */
export function createRunState(config) {
  const ns = config.ns;
  const nTanks = config.tanks.length;
  const nPorts = config.skid.fracValve.ports.length;
  const nAlarms = config.alarms.length;
  const dtPhys_s = config.sim.dtPhys_s;
  const ringRows = Math.max(1, Math.round((config.sim.ringSeconds || 120) / dtPhys_s));
  const channels = buildLogChannels(config);
  const eps0 = config.column.compression ? config.column.compression.eps0 : config.column.epsC;
  const ambient_C = config.skid.ambientT_C;

  const run = {
    // ---- CLOCK (only core/sim.js writes these) -----------------------------
    t_s: 0,
    tick: 0,
    wallAccum_s: 0,
    speed: 1,
    speedDeficit: 1.0,
    state: 'IDLE',
    manualOverride: false,
    cycleIndex: 0,

    // Extension to §2.2, owner core/sim.js: the target of `sim.end(ctx,'AFTER_BLOCK')`.
    // -1 means "no deferred end armed"; otherwise it holds the block index that must finish.
    // §6.4 mandates the AFTER_BLOCK mode and §2.2 gives it no home; this is that home.
    endAfterBlockIndex: -1,

    // ---- TOTALISERS (mL, all from the integral of Q_actual dt) -------------
    V_tot_mL: 0,
    V_run_mL: 0,
    V_block_mL: 0,
    V_held_mL: 0,
    V_load_mL: 0,
    cycleVolume_mL: 0,

    // ---- PUMPS / PROPORTIONER ---------------------------------------------
    Q_set_mLs: 0,
    Q_actual_mLs: 0,
    Q_limit_mLs: Infinity,
    QA_mLs: 0,
    QB_mLs: 0,
    QS_mLs: 0,
    pctB_set: 0,
    pctB_actual: 0,
    pctB_colInlet: 0,
    ripplePhase_rad: 0,
    chopPhase_s: 0,
    biasPctB: 0,
    walkPctB: 0,

    // ---- FLUID PATH --------------------------------------------------------
    topo: null,
    segC_mM: null,   // allocated by skid.createSkid (nTanksTotal*ns, TANK-MAJOR)
    segAir: null,    // allocated by skid.createSkid (nTanksTotal)
    yPumpA_mM: new Float64Array(ns),
    yPumpB_mM: new Float64Array(ns),
    yPumpS_mM: new Float64Array(ns),
    yTee_mM: new Float64Array(ns),
    yColIn_mM: new Float64Array(ns),
    yColOut_mM: new Float64Array(ns),
    yDet_mM: new Float64Array(ns),
    yCond_mM: new Float64Array(ns),
    yPh_mM: new Float64Array(ns),
    fAirColIn: 0,
    fAirDet: 0,
    fAirInletSensor: 0,
    trapHeadspace_mL: 0,

    // ---- COLUMN ------------------------------------------------------------
    bed: null,
    col: null,
    colBatch: {
      dt_s: 0,
      dV_mL: 0,
      yAcc_mM: new Float64Array(ns),
      uSum: 0,
      n: 0,
      sign: 0,
      carryDt_s: 0,
      carryDV_mL: 0,
      carryYAcc_mM: new Float64Array(ns),
    },
    colHold_mM: new Float64Array(ns),
    blockBoundaryFlag: false,

    // ---- HYDRAULICS --------------------------------------------------------
    mu_cP: 1.002,
    rho_gmL: 0.9982,
    epsCompressed: eps0,
    dPbed_bar: 0,
    dPhw_bar: 0,
    dPfilter_bar: 0,
    P1_bar: 0,
    P2_bar: 0,
    dP_bar: 0,
    Ppump_bar: 0,
    bedCollapsed: false,
    filterLoad_mg: 0,

    // ---- SENSORS -----------------------------------------------------------
    T_fluid_C: ambient_C,
    T_cell_C: ambient_C,
    uv: {
      Atrue: new Float64Array(3),
      Ameas: new Float64Array(3),
      Afilt: new Float64Array(3),
      Azero: new Float64Array(3),
      pink: new Float64Array(12),   // CHANNEL-MAJOR: pink[ch*4 + source] (§6.14)
      drift: new Float64Array(3),
      foul_AU: 0,
      ri_AU: 0,
      condPrev_mScm: 0,
      overrange: false,
      saturated: false,
      lampFault: false,
    },
    cond: {
      kappa25_mScm: 0,
      kappaRaw_mScm: 0,
      kappaFilt_mScm: 0,
      kappaDisp_mScm: 0,
      pink: 0,
      drift: 0,
      foul: 0,
      dry: false,
    },
    ph: {
      pHtrue: 7,
      pHelec: 7,
      pHfilt: 7,
      drift: 0,
      slopePct: config.skid.ph.slopePct,
      offset_mV: config.skid.ph.offset_mV,
      highPHminutes: 0,
      frozen: false,
    },
    press: {
      P1raw_bar: 0,
      P1disp_bar: 0,
      P1alm_bar: 0,
      P2raw_bar: 0,
      P2disp_bar: 0,
      P2alm_bar: 0,
    },

    // ---- METHOD ENGINE -----------------------------------------------------
    blockIndex: 0,
    blockElapsed_s: 0,
    blockStartV_mL: 0,
    gradElapsed_mL: 0,
    watchState: [],
    slopeRing: {
      V_mL: new Float64Array(SLOPE_RING_SLOTS),
      y: new Float64Array(SLOPE_RING_SLOTS * NSIG_MAX),   // SIGNAL-MAJOR: y[sig*64 + slot]
      signalIds: [],
      nSig: 0,
      n: 0,
      head: 0,
    },
    loopCount: {},
    extensionCount: {},

    // ---- FRACTIONATOR ------------------------------------------------------
    frac: {
      mode: 'OFF',
      port: 'WASTE',
      nextPortIdx: 0,
      open: false,
      current: null,
      queue: [],
      moving: false,
      moveStart_mL: 0,
      moveFrom: 'WASTE',
      moveElapsed_s: 0,
      peakMax_AU: 0,
      peakMax_V_mL: 0,
      peakMaxSeen: false,
      records: [],
    },

    // ---- VALVES ------------------------------------------------------------
    valves: {
      inletA: 'A1',
      inletB: 'B1',
      inletS: null,
      columnValve: 'BYPASS',
      outletValve: 'WASTE',
      cmdColumnValve: 'BYPASS',
      moveRemaining_s: 0,
      mismatch_s: 0,
      sampleMode: null,
      loopFilled_mL: 0,
      // Set by fluidics.requestColumnValve when a move is REJECTED under flow, sampled by
      // alarms.CUSTOM_EVALUATORS.cvMoveUnderFlow (ALM-CV-02) and auto-cleared by
      // fluidics.updateValves. Declared here so the flag cannot survive a resetRunState.
      cvMoveUnderFlow: false,
      cvMoveUnderFlow_s: 0,
    },

    // ---- INVENTORY ---------------------------------------------------------
    tankVolume_mL: new Float64Array(nTanks),
    wasteVolume_mL: 0,
    portVolume_mL: new Float64Array(nPorts),

    // ---- MASS ACCOUNTING (umol; R-U4) --------------------------------------
    massIn_umol: new Float64Array(ns),
    massOut_umol: new Float64Array(ns),
    massPool_umol: new Float64Array(ns),
    massLoad_umol: new Float64Array(ns),
    massDefect_umol: new Float64Array(ns),
    neumaier: new Float64Array(ns * 4),   // massIn, massOut, massPool, massLoad — in that order

    // ---- ALARMS ------------------------------------------------------------
    alarmPersist_s: new Float64Array(nAlarms),
    alarmActive: new Uint8Array(nAlarms),
    alarmLatched: new Uint8Array(nAlarms),
    alarmAcked: new Uint8Array(nAlarms),
    alarmSuppressUntil_s: new Float64Array(nAlarms),
    flowReduction: { active: false, since_s: 0, recoverSince_s: -1 },

    // ---- LOGS --------------------------------------------------------------
    log: createChannelStore(channels.numeric),
    ring: createRing(channels.numeric, ringRows),
    events: [],
    qualityFlags: 0,
    grid: null,   // CACHE, owned by analytics/peaks.js::buildVolumeGrid; never simulation state

    // ---- RNG + DIAGNOSTICS -------------------------------------------------
    rng: createRng(config.seed),

    diag: {
      msPerSimSecond: 0, msLastTick: 0,
      nSubLast: 1, courant: 0, isoIterAvg: 0, activeCells: 0, fullPassCounter: 0,
      smaFrozen: 0, smaNonConverged: 0, clampCount: 0, colStepsThisSecond: 0,
      hetpTarget_cm: 0, hetpNumerical_cm: 0, hetpKinetic_cm: 0, hetpDispersive_cm: 0,
      hetpSimulated_cm: 0, hetpExcess_cm: 0, sigmaInflation: 1, plateNumberSim: 0,
    },
  };

  for (let k = 0; k < nTanks; k++) run.tankVolume_mL[k] = config.tanks[k].startVolume_mL;

  // §5.9: PUMP_BIAS is drawn exactly ONCE per run, here, and never again.
  run.biasPctB = PUMP_BIAS_SIGMA_PCT * nextGaussian(run.rng.streams[RNG_STREAMS.PUMP_BIAS]);

  return run;
}

/**
 * Zero an existing run in place. Reallocates no typed array; re-forks `run.rng` from
 * `config.seed` and re-draws `RNG_STREAMS.PUMP_BIAS` so a reset run replays bit-identically.
 *
 * `run.topo`, `run.segC_mM`, `run.segAir`, `run.bed` and `run.col` are KEPT (they are topology-
 * sized or module-owned); their contents are zeroed where this module owns them. The caller
 * re-seeds the cascade and the bed — `core/sim.js::reset` calls `skid.createSkid` afterwards.
 *
 * @param {object} config frozen config (§2.1)
 * @param {object} run run state produced by {@link createRunState}
 * @returns {void}
 */
export function resetRunState(config, run) {
  run.t_s = 0;
  run.tick = 0;
  run.wallAccum_s = 0;
  run.speedDeficit = 1.0;
  run.state = 'IDLE';
  run.manualOverride = false;
  run.cycleIndex = 0;
  run.endAfterBlockIndex = -1;

  run.V_tot_mL = 0;
  run.V_run_mL = 0;
  run.V_block_mL = 0;
  run.V_held_mL = 0;
  run.V_load_mL = 0;
  run.cycleVolume_mL = 0;

  run.Q_set_mLs = 0;
  run.Q_actual_mLs = 0;
  run.Q_limit_mLs = Infinity;
  run.QA_mLs = 0;
  run.QB_mLs = 0;
  run.QS_mLs = 0;
  run.pctB_set = 0;
  run.pctB_actual = 0;
  run.pctB_colInlet = 0;
  run.ripplePhase_rad = 0;
  run.chopPhase_s = 0;
  run.walkPctB = 0;

  if (run.segC_mM) run.segC_mM.fill(0);
  if (run.segAir) run.segAir.fill(0);
  run.yPumpA_mM.fill(0);
  run.yPumpB_mM.fill(0);
  run.yPumpS_mM.fill(0);
  run.yTee_mM.fill(0);
  run.yColIn_mM.fill(0);
  run.yColOut_mM.fill(0);
  run.yDet_mM.fill(0);
  run.yCond_mM.fill(0);
  run.yPh_mM.fill(0);
  run.fAirColIn = 0;
  run.fAirDet = 0;
  run.fAirInletSensor = 0;
  run.trapHeadspace_mL = 0;

  const b = run.colBatch;
  b.dt_s = 0;
  b.dV_mL = 0;
  b.yAcc_mM.fill(0);
  b.uSum = 0;
  b.n = 0;
  b.sign = 0;
  b.carryDt_s = 0;
  b.carryDV_mL = 0;
  b.carryYAcc_mM.fill(0);
  run.colHold_mM.fill(0);
  run.blockBoundaryFlag = false;

  run.mu_cP = 1.002;
  run.rho_gmL = 0.9982;
  run.epsCompressed = config.column.compression ? config.column.compression.eps0 : config.column.epsC;
  run.dPbed_bar = 0;
  run.dPhw_bar = 0;
  run.dPfilter_bar = 0;
  run.P1_bar = 0;
  run.P2_bar = 0;
  run.dP_bar = 0;
  run.Ppump_bar = 0;
  run.bedCollapsed = false;
  run.filterLoad_mg = 0;

  run.T_fluid_C = config.skid.ambientT_C;
  run.T_cell_C = config.skid.ambientT_C;
  run.uv.Atrue.fill(0);
  run.uv.Ameas.fill(0);
  run.uv.Afilt.fill(0);
  run.uv.Azero.fill(0);
  run.uv.pink.fill(0);
  run.uv.drift.fill(0);
  run.uv.foul_AU = 0;
  run.uv.ri_AU = 0;
  run.uv.condPrev_mScm = 0;
  run.uv.overrange = false;
  run.uv.saturated = false;
  run.uv.lampFault = false;

  run.cond.kappa25_mScm = 0;
  run.cond.kappaRaw_mScm = 0;
  run.cond.kappaFilt_mScm = 0;
  run.cond.kappaDisp_mScm = 0;
  run.cond.pink = 0;
  run.cond.drift = 0;
  run.cond.foul = 0;
  run.cond.dry = false;

  run.ph.pHtrue = 7;
  run.ph.pHelec = 7;
  run.ph.pHfilt = 7;
  run.ph.drift = 0;
  run.ph.slopePct = config.skid.ph.slopePct;
  run.ph.offset_mV = config.skid.ph.offset_mV;
  run.ph.highPHminutes = 0;
  run.ph.frozen = false;

  run.press.P1raw_bar = 0;
  run.press.P1disp_bar = 0;
  run.press.P1alm_bar = 0;
  run.press.P2raw_bar = 0;
  run.press.P2disp_bar = 0;
  run.press.P2alm_bar = 0;

  run.blockIndex = 0;
  run.blockElapsed_s = 0;
  run.blockStartV_mL = 0;
  run.gradElapsed_mL = 0;
  run.watchState.length = 0;
  run.slopeRing.V_mL.fill(0);
  run.slopeRing.y.fill(0);
  run.slopeRing.signalIds.length = 0;
  run.slopeRing.nSig = 0;
  run.slopeRing.n = 0;
  run.slopeRing.head = 0;
  for (const k of Object.keys(run.loopCount)) delete run.loopCount[k];
  for (const k of Object.keys(run.extensionCount)) delete run.extensionCount[k];

  run.frac.mode = 'OFF';
  run.frac.port = 'WASTE';
  run.frac.nextPortIdx = 0;
  run.frac.open = false;
  run.frac.current = null;
  run.frac.queue.length = 0;
  run.frac.moving = false;
  run.frac.moveStart_mL = 0;
  run.frac.moveFrom = 'WASTE';
  run.frac.moveElapsed_s = 0;
  run.frac.peakMax_AU = 0;
  run.frac.peakMax_V_mL = 0;
  run.frac.peakMaxSeen = false;
  run.frac.records.length = 0;

  run.valves.inletA = 'A1';
  run.valves.inletB = 'B1';
  run.valves.inletS = null;
  run.valves.columnValve = 'BYPASS';
  run.valves.outletValve = 'WASTE';
  run.valves.cmdColumnValve = 'BYPASS';
  run.valves.moveRemaining_s = 0;
  run.valves.mismatch_s = 0;
  run.valves.sampleMode = null;
  run.valves.loopFilled_mL = 0;
  run.valves.cvMoveUnderFlow = false;
  run.valves.cvMoveUnderFlow_s = 0;

  for (let k = 0; k < run.tankVolume_mL.length; k++) {
    run.tankVolume_mL[k] = config.tanks[k].startVolume_mL;
  }
  run.wasteVolume_mL = 0;
  run.portVolume_mL.fill(0);

  run.massIn_umol.fill(0);
  run.massOut_umol.fill(0);
  run.massPool_umol.fill(0);
  run.massLoad_umol.fill(0);
  run.massDefect_umol.fill(0);
  run.neumaier.fill(0);

  run.alarmPersist_s.fill(0);
  run.alarmActive.fill(0);
  run.alarmLatched.fill(0);
  run.alarmAcked.fill(0);
  run.alarmSuppressUntil_s.fill(0);
  run.flowReduction.active = false;
  run.flowReduction.since_s = 0;
  run.flowReduction.recoverSince_s = -1;

  // Logs: rewind in place, keep the allocated capacity (a reset must not reallocate).
  if (run.log) {
    run.log.n = 0;
    if (run.log.discrete) {
      for (const name of Object.keys(run.log.discrete)) run.log.discrete[name].runs.length = 0;
    }
  }
  if (run.ring) {
    run.ring.head = 0;
    run.ring.count = 0;
  }
  run.events.length = 0;
  run.qualityFlags = 0;
  run.grid = null;

  // Re-fork the RNG and re-draw the once-per-run %B bias (§5.9).
  run.rng = createRng(config.seed);
  run.biasPctB = PUMP_BIAS_SIGMA_PCT * nextGaussian(run.rng.streams[RNG_STREAMS.PUMP_BIAS]);

  const d = run.diag;
  d.msPerSimSecond = 0; d.msLastTick = 0;
  d.nSubLast = 1; d.courant = 0; d.isoIterAvg = 0; d.activeCells = 0; d.fullPassCounter = 0;
  d.smaFrozen = 0; d.smaNonConverged = 0; d.clampCount = 0; d.colStepsThisSecond = 0;
  d.hetpTarget_cm = 0; d.hetpNumerical_cm = 0; d.hetpKinetic_cm = 0; d.hetpDispersive_cm = 0;
  d.hetpSimulated_cm = 0; d.hetpExcess_cm = 0; d.sigmaInflation = 1; d.plateNumberSim = 0;
}

/**
 * Capture a structured-clone-safe plain snapshot of the run.
 *
 * Every typed array is emitted as a plain `Array` in canonical units (the field names carry the
 * unit). The module-owned opaque handles are NOT captured and are listed in `omitted`:
 * `topo`, `bed`, `col`, `log`, `ring` and `grid`. The column's internal state has its own
 * serialiser (`physics/column.js::serializeColumn`), which this module may not import (§4).
 *
 * @param {object} config frozen config (§2.1)
 * @param {object} run run state
 * @returns {object} plain snapshot object: `{ schemaVersion, presetId, seed, omitted:string[], ... }`
 */
export function snapshot(config, run) {
  return {
    schemaVersion: SNAPSHOT_VERSION,
    presetId: config.presetId,
    seed: config.seed,
    omitted: ['topo', 'bed', 'col', 'log', 'ring', 'grid'],

    t_s: run.t_s,
    tick: run.tick,
    wallAccum_s: run.wallAccum_s,
    speed: run.speed,
    speedDeficit: run.speedDeficit,
    state: run.state,
    manualOverride: run.manualOverride,
    cycleIndex: run.cycleIndex,
    endAfterBlockIndex: run.endAfterBlockIndex,

    V_tot_mL: run.V_tot_mL,
    V_run_mL: run.V_run_mL,
    V_block_mL: run.V_block_mL,
    V_held_mL: run.V_held_mL,
    V_load_mL: run.V_load_mL,
    cycleVolume_mL: run.cycleVolume_mL,

    Q_set_mLs: run.Q_set_mLs,
    Q_actual_mLs: run.Q_actual_mLs,
    Q_limit_mLs: run.Q_limit_mLs,
    QA_mLs: run.QA_mLs,
    QB_mLs: run.QB_mLs,
    QS_mLs: run.QS_mLs,
    pctB_set: run.pctB_set,
    pctB_actual: run.pctB_actual,
    pctB_colInlet: run.pctB_colInlet,
    ripplePhase_rad: run.ripplePhase_rad,
    chopPhase_s: run.chopPhase_s,
    biasPctB: run.biasPctB,
    walkPctB: run.walkPctB,

    segC_mM: run.segC_mM ? Array.from(run.segC_mM) : null,
    segAir: run.segAir ? Array.from(run.segAir) : null,
    yPumpA_mM: Array.from(run.yPumpA_mM),
    yPumpB_mM: Array.from(run.yPumpB_mM),
    yPumpS_mM: Array.from(run.yPumpS_mM),
    yTee_mM: Array.from(run.yTee_mM),
    yColIn_mM: Array.from(run.yColIn_mM),
    yColOut_mM: Array.from(run.yColOut_mM),
    yDet_mM: Array.from(run.yDet_mM),
    yCond_mM: Array.from(run.yCond_mM),
    yPh_mM: Array.from(run.yPh_mM),
    fAirColIn: run.fAirColIn,
    fAirDet: run.fAirDet,
    fAirInletSensor: run.fAirInletSensor,
    trapHeadspace_mL: run.trapHeadspace_mL,

    colBatch: {
      dt_s: run.colBatch.dt_s,
      dV_mL: run.colBatch.dV_mL,
      yAcc_mM: Array.from(run.colBatch.yAcc_mM),
      uSum: run.colBatch.uSum,
      n: run.colBatch.n,
      sign: run.colBatch.sign,
      carryDt_s: run.colBatch.carryDt_s,
      carryDV_mL: run.colBatch.carryDV_mL,
      carryYAcc_mM: Array.from(run.colBatch.carryYAcc_mM),
    },
    colHold_mM: Array.from(run.colHold_mM),
    blockBoundaryFlag: run.blockBoundaryFlag,

    mu_cP: run.mu_cP,
    rho_gmL: run.rho_gmL,
    epsCompressed: run.epsCompressed,
    dPbed_bar: run.dPbed_bar,
    dPhw_bar: run.dPhw_bar,
    dPfilter_bar: run.dPfilter_bar,
    P1_bar: run.P1_bar,
    P2_bar: run.P2_bar,
    dP_bar: run.dP_bar,
    Ppump_bar: run.Ppump_bar,
    bedCollapsed: run.bedCollapsed,
    filterLoad_mg: run.filterLoad_mg,

    T_fluid_C: run.T_fluid_C,
    T_cell_C: run.T_cell_C,
    uv: plainClone(run.uv),
    cond: plainClone(run.cond),
    ph: plainClone(run.ph),
    press: plainClone(run.press),

    blockIndex: run.blockIndex,
    blockElapsed_s: run.blockElapsed_s,
    blockStartV_mL: run.blockStartV_mL,
    gradElapsed_mL: run.gradElapsed_mL,
    watchState: plainClone(run.watchState),
    slopeRing: {
      V_mL: Array.from(run.slopeRing.V_mL),
      y: Array.from(run.slopeRing.y),
      signalIds: run.slopeRing.signalIds.slice(),
      nSig: run.slopeRing.nSig,
      n: run.slopeRing.n,
      head: run.slopeRing.head,
    },
    loopCount: plainClone(run.loopCount),
    extensionCount: plainClone(run.extensionCount),

    frac: plainClone(run.frac),
    valves: plainClone(run.valves),

    tankVolume_mL: Array.from(run.tankVolume_mL),
    wasteVolume_mL: run.wasteVolume_mL,
    portVolume_mL: Array.from(run.portVolume_mL),

    massIn_umol: Array.from(run.massIn_umol),
    massOut_umol: Array.from(run.massOut_umol),
    massPool_umol: Array.from(run.massPool_umol),
    massLoad_umol: Array.from(run.massLoad_umol),
    massDefect_umol: Array.from(run.massDefect_umol),
    neumaier: Array.from(run.neumaier),

    alarmPersist_s: Array.from(run.alarmPersist_s),
    alarmActive: Array.from(run.alarmActive),
    alarmLatched: Array.from(run.alarmLatched),
    alarmAcked: Array.from(run.alarmAcked),
    alarmSuppressUntil_s: Array.from(run.alarmSuppressUntil_s),
    flowReduction: plainClone(run.flowReduction),

    events: plainClone(run.events),
    qualityFlags: run.qualityFlags,

    rng: { streams: run.rng.streams.map((s) => ({ s0: s.s0, s1: s.s1 })) },
    diag: plainClone(run.diag),
  };
}

/**
 * Rebuild a run from a {@link snapshot} payload.
 *
 * Returns a freshly allocated run (via {@link createRunState}) with every captured field written
 * back. `run.topo`, `run.bed` and `run.col` are `null` on return and `run.log` / `run.ring` are
 * empty: the caller must call `skid/skid.js::createSkid(config, run)` afterwards, exactly as it
 * must after `createRunState`. `segC_mM` / `segAir` are restored when the snapshot carries them,
 * and `createSkid` will overwrite them with a freshly seeded cascade.
 *
 * @param {object} config frozen config the snapshot was taken against (§2.1)
 * @param {object} obj snapshot payload from {@link snapshot}
 * @returns {object} a run state (§2.2)
 */
export function restore(config, obj) {
  const run = createRunState(config);
  if (!obj || typeof obj !== 'object') return run;

  const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

  run.t_s = num(obj.t_s, 0);
  run.tick = num(obj.tick, 0);
  run.wallAccum_s = num(obj.wallAccum_s, 0);
  run.speed = num(obj.speed, 1);
  run.speedDeficit = num(obj.speedDeficit, 1);
  run.state = Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, obj.state) ? obj.state : 'IDLE';
  run.manualOverride = !!obj.manualOverride;
  run.cycleIndex = num(obj.cycleIndex, 0);
  run.endAfterBlockIndex = num(obj.endAfterBlockIndex, -1);

  run.V_tot_mL = num(obj.V_tot_mL, 0);
  run.V_run_mL = num(obj.V_run_mL, 0);
  run.V_block_mL = num(obj.V_block_mL, 0);
  run.V_held_mL = num(obj.V_held_mL, 0);
  run.V_load_mL = num(obj.V_load_mL, 0);
  run.cycleVolume_mL = num(obj.cycleVolume_mL, 0);

  run.Q_set_mLs = num(obj.Q_set_mLs, 0);
  run.Q_actual_mLs = num(obj.Q_actual_mLs, 0);
  run.Q_limit_mLs = typeof obj.Q_limit_mLs === 'number' ? obj.Q_limit_mLs : Infinity;
  run.QA_mLs = num(obj.QA_mLs, 0);
  run.QB_mLs = num(obj.QB_mLs, 0);
  run.QS_mLs = num(obj.QS_mLs, 0);
  run.pctB_set = num(obj.pctB_set, 0);
  run.pctB_actual = num(obj.pctB_actual, 0);
  run.pctB_colInlet = num(obj.pctB_colInlet, 0);
  run.ripplePhase_rad = num(obj.ripplePhase_rad, 0);
  run.chopPhase_s = num(obj.chopPhase_s, 0);
  run.biasPctB = num(obj.biasPctB, run.biasPctB);
  run.walkPctB = num(obj.walkPctB, 0);

  if (obj.segC_mM) run.segC_mM = Float64Array.from(obj.segC_mM);
  if (obj.segAir) run.segAir = Float64Array.from(obj.segAir);
  fillFrom(run.yPumpA_mM, obj.yPumpA_mM);
  fillFrom(run.yPumpB_mM, obj.yPumpB_mM);
  fillFrom(run.yPumpS_mM, obj.yPumpS_mM);
  fillFrom(run.yTee_mM, obj.yTee_mM);
  fillFrom(run.yColIn_mM, obj.yColIn_mM);
  fillFrom(run.yColOut_mM, obj.yColOut_mM);
  fillFrom(run.yDet_mM, obj.yDet_mM);
  fillFrom(run.yCond_mM, obj.yCond_mM);
  fillFrom(run.yPh_mM, obj.yPh_mM);
  run.fAirColIn = num(obj.fAirColIn, 0);
  run.fAirDet = num(obj.fAirDet, 0);
  run.fAirInletSensor = num(obj.fAirInletSensor, 0);
  run.trapHeadspace_mL = num(obj.trapHeadspace_mL, 0);

  if (obj.colBatch) {
    run.colBatch.dt_s = num(obj.colBatch.dt_s, 0);
    run.colBatch.dV_mL = num(obj.colBatch.dV_mL, 0);
    fillFrom(run.colBatch.yAcc_mM, obj.colBatch.yAcc_mM);
    run.colBatch.uSum = num(obj.colBatch.uSum, 0);
    run.colBatch.n = num(obj.colBatch.n, 0);
    run.colBatch.sign = num(obj.colBatch.sign, 0);
    run.colBatch.carryDt_s = num(obj.colBatch.carryDt_s, 0);
    run.colBatch.carryDV_mL = num(obj.colBatch.carryDV_mL, 0);
    fillFrom(run.colBatch.carryYAcc_mM, obj.colBatch.carryYAcc_mM);
  }
  fillFrom(run.colHold_mM, obj.colHold_mM);
  run.blockBoundaryFlag = !!obj.blockBoundaryFlag;

  run.mu_cP = num(obj.mu_cP, run.mu_cP);
  run.rho_gmL = num(obj.rho_gmL, run.rho_gmL);
  run.epsCompressed = num(obj.epsCompressed, run.epsCompressed);
  run.dPbed_bar = num(obj.dPbed_bar, 0);
  run.dPhw_bar = num(obj.dPhw_bar, 0);
  run.dPfilter_bar = num(obj.dPfilter_bar, 0);
  run.P1_bar = num(obj.P1_bar, 0);
  run.P2_bar = num(obj.P2_bar, 0);
  run.dP_bar = num(obj.dP_bar, 0);
  run.Ppump_bar = num(obj.Ppump_bar, 0);
  run.bedCollapsed = !!obj.bedCollapsed;
  run.filterLoad_mg = num(obj.filterLoad_mg, 0);

  run.T_fluid_C = num(obj.T_fluid_C, run.T_fluid_C);
  run.T_cell_C = num(obj.T_cell_C, run.T_cell_C);
  if (obj.uv) {
    fillFrom(run.uv.Atrue, obj.uv.Atrue);
    fillFrom(run.uv.Ameas, obj.uv.Ameas);
    fillFrom(run.uv.Afilt, obj.uv.Afilt);
    fillFrom(run.uv.Azero, obj.uv.Azero);
    fillFrom(run.uv.pink, obj.uv.pink);
    fillFrom(run.uv.drift, obj.uv.drift);
    run.uv.foul_AU = num(obj.uv.foul_AU, 0);
    run.uv.ri_AU = num(obj.uv.ri_AU, 0);
    run.uv.condPrev_mScm = num(obj.uv.condPrev_mScm, 0);
    run.uv.overrange = !!obj.uv.overrange;
    run.uv.saturated = !!obj.uv.saturated;
    run.uv.lampFault = !!obj.uv.lampFault;
  }
  if (obj.cond) Object.assign(run.cond, obj.cond);
  if (obj.ph) Object.assign(run.ph, obj.ph);
  if (obj.press) Object.assign(run.press, obj.press);

  run.blockIndex = num(obj.blockIndex, 0);
  run.blockElapsed_s = num(obj.blockElapsed_s, 0);
  run.blockStartV_mL = num(obj.blockStartV_mL, 0);
  run.gradElapsed_mL = num(obj.gradElapsed_mL, 0);
  if (Array.isArray(obj.watchState)) {
    run.watchState.length = 0;
    for (const w of obj.watchState) run.watchState.push(plainClone(w));
  }
  if (obj.slopeRing) {
    fillFrom(run.slopeRing.V_mL, obj.slopeRing.V_mL);
    fillFrom(run.slopeRing.y, obj.slopeRing.y);
    run.slopeRing.signalIds = Array.isArray(obj.slopeRing.signalIds)
      ? obj.slopeRing.signalIds.slice() : [];
    run.slopeRing.nSig = num(obj.slopeRing.nSig, 0);
    run.slopeRing.n = num(obj.slopeRing.n, 0);
    run.slopeRing.head = num(obj.slopeRing.head, 0);
  }
  if (obj.loopCount) Object.assign(run.loopCount, obj.loopCount);
  if (obj.extensionCount) Object.assign(run.extensionCount, obj.extensionCount);

  if (obj.frac) {
    const f = plainClone(obj.frac);
    run.frac.mode = f.mode;
    run.frac.port = f.port;
    run.frac.nextPortIdx = num(f.nextPortIdx, 0);
    run.frac.open = !!f.open;
    run.frac.current = f.current ?? null;
    run.frac.queue.length = 0;
    if (Array.isArray(f.queue)) for (const q of f.queue) run.frac.queue.push(q);
    run.frac.moving = !!f.moving;
    run.frac.moveStart_mL = num(f.moveStart_mL, 0);
    run.frac.moveFrom = f.moveFrom ?? 'WASTE';
    run.frac.moveElapsed_s = num(f.moveElapsed_s, 0);
    run.frac.peakMax_AU = num(f.peakMax_AU, 0);
    run.frac.peakMax_V_mL = num(f.peakMax_V_mL, 0);
    run.frac.peakMaxSeen = !!f.peakMaxSeen;
    run.frac.records.length = 0;
    if (Array.isArray(f.records)) for (const r of f.records) run.frac.records.push(r);
  }
  if (obj.valves) Object.assign(run.valves, obj.valves);

  fillFrom(run.tankVolume_mL, obj.tankVolume_mL);
  run.wasteVolume_mL = num(obj.wasteVolume_mL, 0);
  fillFrom(run.portVolume_mL, obj.portVolume_mL);

  fillFrom(run.massIn_umol, obj.massIn_umol);
  fillFrom(run.massOut_umol, obj.massOut_umol);
  fillFrom(run.massPool_umol, obj.massPool_umol);
  fillFrom(run.massLoad_umol, obj.massLoad_umol);
  fillFrom(run.massDefect_umol, obj.massDefect_umol);
  fillFrom(run.neumaier, obj.neumaier);

  fillFrom(run.alarmPersist_s, obj.alarmPersist_s);
  fillFrom(run.alarmActive, obj.alarmActive);
  fillFrom(run.alarmLatched, obj.alarmLatched);
  fillFrom(run.alarmAcked, obj.alarmAcked);
  fillFrom(run.alarmSuppressUntil_s, obj.alarmSuppressUntil_s);
  if (obj.flowReduction) Object.assign(run.flowReduction, obj.flowReduction);

  run.events.length = 0;
  if (Array.isArray(obj.events)) for (const e of obj.events) run.events.push(plainClone(e));
  run.qualityFlags = num(obj.qualityFlags, 0);

  if (obj.rng && Array.isArray(obj.rng.streams)) {
    for (let i = 0; i < run.rng.streams.length && i < obj.rng.streams.length; i++) {
      run.rng.streams[i].s0 = obj.rng.streams[i].s0;
      run.rng.streams[i].s1 = obj.rng.streams[i].s1;
    }
  }
  if (obj.diag) Object.assign(run.diag, obj.diag);

  return run;
}
