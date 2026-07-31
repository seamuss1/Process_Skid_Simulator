/**
 * src/skid/alarms.js — the declarative alarm table, its custom evaluators, persistence, latching,
 * suppression and automatic actions.
 *
 * Owner: `skid-method`. Contract §5.6, §5.6.1, §6.18.
 *
 * Persistence is measured in SECONDS (`run.alarmPersist_s`), never in ticks, so the table is
 * independent of `config.sim.ctrlEvery`.
 *
 * Layer L4. Imports `core/log.js`, `skid/sensors.js` and `skid/fluidics.js` only (§4). It cannot
 * import `skid/engine.js` (that would be an upward edge), so an alarm ACTION that needs a run-state
 * transition is not applied here: `alarms.js` records the alarm, and `engine.controlTick` derives
 * the demanded transition from `run.alarmActive` + this table immediately after `evaluateAlarms`
 * returns. That keeps one state machine, in `engine.js`, and adds no field to `run`.
 */

import { logEvent, QF } from '../core/log.js';
import { sensorSignal, sensorQuality } from './sensors.js';
import { applyFlowReduction } from './fluidics.js';

/** Severity ladder, ascending (§5.6). */
export const SEVERITIES = ['INFO', 'WARN', 'ALARM', 'CRITICAL', 'FAULT'];

/** Automatic actions an alarm row may demand (§5.6). */
export const ALARM_ACTIONS = ['NONE', 'WARN', 'REDUCE_FLOW', 'HOLD', 'PAUSE', 'STOP', 'TRIP'];

/** The nine suppression keys of §5.6.1. */
export const SUPPRESSION_KEYS = ['BYPASS', 'VALVE_MOVE', 'CIP', 'FLOW_REDUCTION', 'RAMP',
  'LOW_FLOW', 'NO_TRAP', 'PH_INVALID', 'GRADIENT'];

/** Column-valve move suppression window, s (§5.6.1 `VALVE_MOVE`). */
const VALVE_MOVE_SUPPRESS_S = 5.0;

/** Acceptable fluid/cell temperature band, °C — row 19 `tempRange`, whose threshold column is a pair. */
const TEMP_RANGE_C = [2, 30];

/** Backward-GOTO ceiling (§5.4.4c rule 14); `methodLoops` fires above it. */
const MAX_LOOPS = 10;

/**
 * The 31 rows of §5.6, indices 0..30, in that order.
 *
 * `AlarmDef = { id, name, signal, op, threshold, evalKey, persist_s, severity, action,
 *               suppressWhen, latching, ackRequired }`
 * `signal` is a §5.2 `sensorSignal` name (UPPERCASE) or null when `op === 'custom'`.
 * `threshold` is a number, or `{LAB,PILOT,PROCESS}` resolved at ingest, or null when the predicate
 * carries its own constants. Units are stated per row.
 */
export const ALARM_TABLE = [
  { id: 'ALM-P1-01', name: 'Pre-column pressure high', signal: 'P1', op: '>', threshold: 1.60,
    evalKey: null, persist_s: 0.3, severity: 'ALARM', action: 'REDUCE_FLOW',
    suppressWhen: ['VALVE_MOVE'], latching: false, ackRequired: false },                 // bar
  { id: 'ALM-P1-02', name: 'Pre-column pressure trip', signal: 'P1', op: '>', threshold: 2.20,
    evalKey: null, persist_s: 0.2, severity: 'CRITICAL', action: 'TRIP',
    suppressWhen: ['VALVE_MOVE'], latching: true, ackRequired: true },                   // bar
  { id: 'ALM-DP-01', name: 'Column dP high', signal: 'DP', op: '>', threshold: 0.60,
    evalKey: null, persist_s: 0.3, severity: 'WARN', action: 'WARN',
    suppressWhen: ['BYPASS', 'VALVE_MOVE'], latching: false, ackRequired: false },       // bar
  { id: 'ALM-DP-02', name: 'Column dP alarm', signal: 'DP', op: '>', threshold: 0.80,
    evalKey: null, persist_s: 0.3, severity: 'ALARM', action: 'REDUCE_FLOW',
    suppressWhen: ['BYPASS', 'VALVE_MOVE'], latching: false, ackRequired: false },       // bar
  { id: 'ALM-DP-03', name: 'Column dP trip', signal: 'DP', op: '>', threshold: 1.00,
    evalKey: null, persist_s: 0.2, severity: 'CRITICAL', action: 'TRIP',
    suppressWhen: ['BYPASS', 'VALVE_MOVE'], latching: true, ackRequired: true },         // bar
  { id: 'ALM-DP-04', name: 'dP negative / sensor fault', signal: 'DP', op: '<', threshold: -0.20,
    evalKey: null, persist_s: 5.0, severity: 'WARN', action: 'WARN',
    suppressWhen: ['LOW_FLOW'], latching: false, ackRequired: false },                   // bar
  { id: 'ALM-AIR-01', name: 'Air detected, inlet sensor', signal: null, op: 'custom',
    threshold: 0.02, evalKey: 'airInlet', persist_s: 0.1, severity: 'ALARM', action: 'PAUSE',
    suppressWhen: [], latching: true, ackRequired: true },                               // frac
  { id: 'ALM-AIR-02', name: 'Air detected, post-column', signal: 'AIR', op: '>', threshold: 0.02,
    evalKey: null, persist_s: 0.1, severity: 'ALARM', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },                             // frac
  { id: 'WRN-AIR-03', name: 'Air trap filling', signal: null, op: 'custom', threshold: 0.60,
    evalKey: 'trapFill', persist_s: 1.0, severity: 'WARN', action: 'WARN',
    suppressWhen: ['NO_TRAP'], latching: false, ackRequired: false },                    // frac
  { id: 'ALM-PMP-01', name: 'Pump cavitation', signal: null, op: 'custom', threshold: 0.005,
    evalKey: 'cavitation', persist_s: 5.0, severity: 'ALARM', action: 'REDUCE_FLOW',
    suppressWhen: [], latching: false, ackRequired: false },                             // frac
  { id: 'ALM-PMP-02', name: 'Inlet empty / dry running', signal: null, op: 'custom', threshold: null,
    evalKey: 'dryRun', persist_s: 10.0, severity: 'CRITICAL', action: 'TRIP',
    suppressWhen: [], latching: true, ackRequired: true },
  { id: 'ALM-PMP-03', name: 'Flow deviation', signal: null, op: 'custom', threshold: 0.10,
    evalKey: 'flowDeviation', persist_s: 10.0, severity: 'ALARM', action: 'HOLD',
    suppressWhen: ['FLOW_REDUCTION', 'RAMP'], latching: false, ackRequired: false },     // relative
  { id: 'ALM-UV-01', name: 'UV over-range', signal: null, op: 'custom', threshold: null,
    evalKey: 'uvOverrange', persist_s: 2.0, severity: 'WARN', action: 'WARN',
    suppressWhen: ['CIP'], latching: false, ackRequired: false },
  { id: 'ALM-UV-02', name: 'UV lamp fault', signal: null, op: 'custom', threshold: null,
    evalKey: 'uvLampFault', persist_s: 1.0, severity: 'ALARM', action: 'HOLD',
    suppressWhen: [], latching: true, ackRequired: true },
  { id: 'WRN-UV-03', name: 'Autozero on unstable baseline', signal: null, op: 'custom',
    threshold: null, evalKey: 'azUnstable', persist_s: 0.0, severity: 'WARN', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },
  { id: 'WRN-TNK-01', name: 'Buffer tank low', signal: null, op: 'custom', threshold: 0.10,
    evalKey: 'tankLow', persist_s: 1.0, severity: 'WARN', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },                             // frac
  { id: 'ALM-TNK-02', name: 'Buffer tank empty', signal: null, op: 'custom', threshold: null,
    evalKey: 'tankEmpty', persist_s: 0.0, severity: 'CRITICAL', action: 'TRIP',
    suppressWhen: [], latching: true, ackRequired: true },
  { id: 'ALM-TNK-03', name: 'Waste tank full', signal: null, op: 'custom', threshold: 0.95,
    evalKey: 'wasteFull', persist_s: 1.0, severity: 'ALARM', action: 'PAUSE',
    suppressWhen: [], latching: false, ackRequired: false },                             // frac
  { id: 'WRN-TNK-04', name: 'Waste tank high', signal: null, op: 'custom', threshold: 0.85,
    evalKey: 'wasteHigh', persist_s: 1.0, severity: 'WARN', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },                             // frac
  { id: 'ALM-TMP-01', name: 'Temperature out of range', signal: null, op: 'custom', threshold: null,
    evalKey: 'tempRange', persist_s: 60.0, severity: 'WARN', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },                             // [2,30] C
  { id: 'ALM-TMP-02', name: 'Temperature critical', signal: 'TEMP_FLUID', op: '>', threshold: 40,
    evalKey: null, persist_s: 5.0, severity: 'ALARM', action: 'HOLD',
    suppressWhen: [], latching: false, ackRequired: false },                             // C
  { id: 'ALM-CV-01', name: 'Column not in line', signal: null, op: 'custom', threshold: null,
    evalKey: 'colNotInLine', persist_s: 1.0, severity: 'ALARM', action: 'HOLD',
    suppressWhen: [], latching: false, ackRequired: false },
  { id: 'ALM-CV-02', name: 'Column valve move under flow', signal: null, op: 'custom',
    threshold: null, evalKey: 'cvMoveUnderFlow', persist_s: 0.0, severity: 'ALARM', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },
  { id: 'ALM-CV-03', name: 'Column valve position mismatch', signal: null, op: 'custom',
    threshold: null, evalKey: 'cvMismatch', persist_s: 3.0, severity: 'FAULT', action: 'TRIP',
    suppressWhen: [], latching: true, ackRequired: true },
  { id: 'ALM-PH-01', name: 'pH out of range', signal: null, op: 'custom', threshold: 1.0,
    evalKey: 'phRange', persist_s: 30.0, severity: 'WARN', action: 'WARN',
    suppressWhen: ['CIP', 'PH_INVALID'], latching: false, ackRequired: false },          // +/- pH
  { id: 'ALM-PH-02', name: 'pH electrode degraded', signal: null, op: 'custom', threshold: null,
    evalKey: 'phDegraded', persist_s: 0.0, severity: 'WARN', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },
  { id: 'ALM-CND-01', name: 'Conductivity out of range', signal: null, op: 'custom', threshold: 0.20,
    evalKey: 'condRange', persist_s: 60.0, severity: 'WARN', action: 'WARN',
    suppressWhen: ['GRADIENT'], latching: false, ackRequired: false },                   // relative
  { id: 'ALM-FRC-01', name: 'Fraction ports exhausted', signal: null, op: 'custom', threshold: null,
    evalKey: 'portsExhausted', persist_s: 0.0, severity: 'WARN', action: 'WARN',
    suppressWhen: [], latching: false, ackRequired: false },
  { id: 'ALM-MTH-01', name: 'Watch timeout with onTimeout=ALARM', signal: null, op: 'custom',
    threshold: null, evalKey: 'methodTimeout', persist_s: 0.0, severity: 'ALARM', action: 'HOLD',
    suppressWhen: [], latching: false, ackRequired: false },
  { id: 'ALM-MTH-02', name: 'Method loop limit', signal: null, op: 'custom', threshold: null,
    evalKey: 'methodLoops', persist_s: 0.0, severity: 'ALARM', action: 'HOLD',
    suppressWhen: [], latching: false, ackRequired: false },
  { id: 'ALM-SYS-01', name: 'Simulation watchdog (NaN in state)', signal: null, op: 'custom',
    threshold: null, evalKey: 'nanTripwire', persist_s: 0.0, severity: 'FAULT', action: 'TRIP',
    suppressWhen: [], latching: true, ackRequired: true },
];

/** id -> row index, built once from the const table. */
const ROW_INDEX = new Map(ALARM_TABLE.map((r, i) => [r.id, i]));

/** Per-config derived lookups, computed once and cached. No allocation on the hot path. */
const CONFIG_CACHE = new WeakMap();

function cacheFor(config) {
  let c = CONFIG_CACHE.get(config);
  if (c) return c;
  const tankIdxOfPort = new Map();
  const assign = config.inletAssignments || {};
  const tanks = config.tanks || [];
  for (const port of Object.keys(assign)) {
    const id = assign[port];
    if (!id) continue;
    for (let k = 0; k < tanks.length; k++) if (tanks[k].id === id) { tankIdxOfPort.set(port, k); break; }
  }
  let airTrap_mL = 0;
  const segs = config.skid.segments || [];
  for (let i = 0; i < segs.length; i++) if (segs[i].id === 'G5') { airTrap_mL = segs[i].V_mL; break; }
  c = { tankIdxOfPort, airTrap_mL };
  CONFIG_CACHE.set(config, c);
  return c;
}

/** The alarm rows actually in force: the ingest-resolved `config.alarms`, else the const table. */
function tableOf(config) {
  return (config.alarms && config.alarms.length) ? config.alarms : ALARM_TABLE;
}

/** Read a row's signal without ever parsing a string on the hot path (§5.2). */
function readRowSignal(config, run, def) {
  const r = def.signalResolved;
  if (r && r.base === 'TANK_LEVEL') {
    return (r.tankIdx >= 0) ? run.tankVolume_mL[r.tankIdx] : NaN;
  }
  return sensorSignal(config, run, r ? r.base : def.signal);
}

/** The block the method engine is currently running, or null. */
function currentBlock(config, run) {
  const m = config.method;
  if (!m || !Array.isArray(m.blocks)) return null;
  return m.blocks[run.blockIndex] || null;
}

/** The three inlet branches, hoisted: a literal here would allocate on every 10 Hz evaluation. */
const SIDES = ['A', 'B', 'S'];

/** Is a branch drawing from a tank right now? Returns the tank index, or -1. */
function activeTankIdx(config, run, side) {
  const c = cacheFor(config);
  const v = run.valves;
  if (side === 'A') return (run.QA_mLs > 0 && v.inletA) ? (c.tankIdxOfPort.get(v.inletA) ?? -1) : -1;
  if (side === 'B') return (run.QB_mLs > 0 && v.inletB) ? (c.tankIdxOfPort.get(v.inletB) ?? -1) : -1;
  return (run.QS_mLs > 0 && v.inletS) ? (c.tankIdxOfPort.get(v.inletS) ?? -1) : -1;
}

// ---------------------------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------------------------

/**
 * Is a §5.6.1 suppression key active right now?
 *
 * @param {object} config
 * @param {object} run
 * @param {string} key  one of `SUPPRESSION_KEYS`
 * @returns {boolean}
 */
export function isSuppressed(config, run, key) {
  switch (key) {
    case 'BYPASS':
      return run.valves.columnValve === 'BYPASS' || run.valves.columnValve === 'ISOLATED';
    case 'VALVE_MOVE':
      // `run.alarmSuppressUntil_s` is written with the SAME value for every row while the column
      // valve is in transit, so index 0 is representative (see `evaluateAlarms`).
      return run.valves.moveRemaining_s > 0
        || (run.alarmSuppressUntil_s.length > 0 && run.t_s < run.alarmSuppressUntil_s[0]);
    case 'CIP': {
      const b = currentBlock(config, run);
      return !!b && b.type === 'CIP';
    }
    case 'FLOW_REDUCTION':
      return !!run.flowReduction.active;
    case 'RAMP': {
      const target = Math.min(run.Q_set_mLs, run.Q_limit_mLs);
      return Math.abs(run.Q_actual_mLs - target) > 1e-9;
    }
    case 'LOW_FLOW':
      return run.Q_actual_mLs < 0.20 * config.skid.Qmax_mLs;
    case 'NO_TRAP':
      return config.skid.airTrap === false;
    case 'PH_INVALID':
      return sensorQuality(run, 'PH') !== 'OK';
    case 'GRADIENT': {
      const b = currentBlock(config, run);
      return !!b && !!b.gradient && b.gradient.shape !== 'ISOCRATIC';
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// the 23 custom evaluators — keys match ALARM_TABLE[].evalKey exactly
// ---------------------------------------------------------------------------------------------

/**
 * The named predicates the declarative table dispatches to. Each is `(config, run) => boolean` and
 * reads its own numeric constant from its row via `thresholdOf`, so the table stays the single
 * source of every limit.
 */
export const CUSTOM_EVALUATORS = {
  /** Row 6 — gas at the inlet bubble sensor, or arriving at the (air-blocked, D4) column inlet. */
  airInlet(config, run) {
    const t = thresholdOf(config, 'ALM-AIR-01', 0.02);
    return run.fAirInletSensor > t || run.fAirColIn > t;
  },
  /** Row 8 — the air trap's headspace has grown past 60 % of the trap volume. */
  trapFill(config, run) {
    if (config.skid.airTrap === false) return false;
    const V = cacheFor(config).airTrap_mL;
    if (!(V > 0)) return false;
    return run.trapHeadspace_mL / V > thresholdOf(config, 'WRN-AIR-03', 0.60);
  },
  /**
   * Row 9 — suction starvation short of a full run-dry (§5.6, normative): high flow AND the selected
   * inlet tank below 2x its empty level AND measurable gas at the inlet sensor. Fires BEFORE
   * `dryRun` by design: cavitation is the warning, running dry is the trip.
   */
  cavitation(config, run) {
    if (!(run.Q_actual_mLs > 0.5 * config.skid.Qmax_mLs)) return false;
    if (!(run.fAirInletSensor > thresholdOf(config, 'ALM-PMP-01', 0.005))) return false;
    const tanks = config.tanks || [];
    for (let s = 0; s < SIDES.length; s++) {
      const k = activeTankIdx(config, run, SIDES[s]);
      if (k >= 0 && run.tankVolume_mL[k] < 2 * (tanks[k].emptyLevel_mL || 0)) return true;
    }
    return false;
  },
  /** Row 10 — the pump is turning against essentially pure gas: a disconnected or drained line. */
  dryRun(config, run) {
    return run.Q_actual_mLs > 0 && run.fAirInletSensor > 0.5;
  },
  /** Row 11 — delivered flow deviates from the commanded setpoint by more than 10 %. */
  flowDeviation(config, run) {
    const set = run.Q_set_mLs;
    if (!(set > 0)) return false;
    return Math.abs(run.Q_actual_mLs - set) / set > thresholdOf(config, 'ALM-PMP-03', 0.10);
  },
  /** Row 12 — any monitored wavelength above `uv.overrange_AU`. */
  uvOverrange(config, run) { return !!run.uv.overrange; },
  /** Row 13 — lamp failed or drifting faster than 50 mAU/h. */
  uvLampFault(config, run) { return !!run.uv.lampFault; },
  /** Row 14 — an autozero was taken on a moving baseline or with gas in the cell. */
  azUnstable(config, run) { return (run.qualityFlags & QF.UV_AUTOZERO_UNSTABLE) !== 0; },
  /** Row 15 — any source tank below its own `lowLevelPct` of nominal. */
  tankLow(config, run) {
    const tanks = config.tanks || [];
    const fallback = thresholdOf(config, 'WRN-TNK-01', 0.10);
    for (let k = 0; k < tanks.length; k++) {
      const nominal = tanks[k].nominalVolume_mL;
      if (!(nominal > 0)) continue;
      const frac = (typeof tanks[k].lowLevelPct === 'number') ? tanks[k].lowLevelPct / 100 : fallback;
      if (run.tankVolume_mL[k] / nominal < frac) return true;
    }
    return false;
  },
  /** Row 16 — a tank that is being drawn from has reached its dip-tube (`emptyLevel_mL`). */
  tankEmpty(config, run) {
    const tanks = config.tanks || [];
    for (let s = 0; s < SIDES.length; s++) {
      const k = activeTankIdx(config, run, SIDES[s]);
      if (k >= 0 && run.tankVolume_mL[k] <= (tanks[k].emptyLevel_mL || 0)) return true;
    }
    return false;
  },
  /** Row 17 — §5.6 normative: `wasteVolume_mL / skid.wasteCapacity_mL > 0.95`. There is no waste tank. */
  wasteFull(config, run) {
    const cap = config.skid.wasteCapacity_mL;
    return cap > 0 && run.wasteVolume_mL / cap > thresholdOf(config, 'ALM-TNK-03', 0.95);
  },
  /** Row 18 — the same ratio above 0.85. */
  wasteHigh(config, run) {
    const cap = config.skid.wasteCapacity_mL;
    return cap > 0 && run.wasteVolume_mL / cap > thresholdOf(config, 'WRN-TNK-04', 0.85);
  },
  /** Row 19 — fluid or conductivity-cell temperature outside [2, 30] °C. */
  tempRange(config, run) {
    return run.T_fluid_C < TEMP_RANGE_C[0] || run.T_fluid_C > TEMP_RANGE_C[1]
      || run.T_cell_C < TEMP_RANGE_C[0] || run.T_cell_C > TEMP_RANGE_C[1];
  },
  /** Row 21 — the method wants the column in line and the valve is not (and is not moving there). */
  colNotInLine(config, run) {
    const b = currentBlock(config, run);
    if (!b) return false;
    if (b.columnValve !== 'DOWN' && b.columnValve !== 'UP') return false;
    if (run.valves.moveRemaining_s > 0) return false;
    return run.valves.columnValve !== b.columnValve;
  },
  /**
   * Row 22 — a column-valve move was REJECTED because the flow exceeded the interlock.
   *
   * The condition is the REJECTION, not "a move is pending while flow is high" (§6.12: the
   * request "is rejected unless `Q_actual <= QswitchMax_frac*Qmax` or the pumps are stopped;
   * rejection raises `ALM-CV-02`"). It cannot be re-derived from valve state, for two reasons:
   * a rejection stops the move from ever starting, so there is no pending move to observe; and
   * a LEGITIMATE move — requested at Q = 0, as every block boundary does — stays in transit for
   * up to 1.2 s while the pump ramps up past the interlock, which the derived form reported as a
   * spurious ALARM on essentially every block start.
   *
   * `skid/fluidics.js` (L3) cannot import this module (L4), so `requestColumnValve` raises the
   * flag on `run.valves` and it auto-clears 1.0 s later in `updateValves`.
   */
  cvMoveUnderFlow(config, run) {
    return run.valves.cvMoveUnderFlow === true;
  },
  /** Row 23 — the valve's position feedback disagrees with its command (`run.valves.mismatch_s`). */
  cvMismatch(config, run) { return run.valves.mismatch_s > 0; },
  /**
   * Row 24 — measured pH more than 1.0 unit from the blended target pH of the selected inlets.
   * Tanks with no authored `targetPH` (WFI, NaOH) make the check inapplicable, not failed.
   */
  phRange(config, run) {
    const c = cacheFor(config);
    const tanks = config.tanks || [];
    const kA = run.valves.inletA ? (c.tankIdxOfPort.get(run.valves.inletA) ?? -1) : -1;
    const kB = run.valves.inletB ? (c.tankIdxOfPort.get(run.valves.inletB) ?? -1) : -1;
    const pHA = (kA >= 0 && tanks[kA].composition) ? tanks[kA].composition.targetPH : null;
    const pHB = (kB >= 0 && tanks[kB].composition) ? tanks[kB].composition.targetPH : null;
    const x = Math.min(Math.max(run.pctB_actual / 100, 0), 1);
    let expected;
    if (typeof pHA === 'number' && typeof pHB === 'number') expected = (1 - x) * pHA + x * pHB;
    else if (typeof pHA === 'number' && x < 0.5) expected = pHA;
    else if (typeof pHB === 'number' && x >= 0.5) expected = pHB;
    else return false;
    return Math.abs(run.ph.pHfilt - expected) > thresholdOf(config, 'ALM-PH-01', 1.0);
  },
  /** Row 25 — calibration slope below 92 % or offset beyond ±30 mV. */
  phDegraded(config, run) {
    return run.ph.slopePct < 92 || Math.abs(run.ph.offset_mV) > 30;
  },
  /**
   * Row 26 — the displayed conductivity has drifted more than 20 % from the physically true value
   * (`run.cond.kappa25_mScm`), i.e. a compensation or cell-constant fault. Suppressed during a
   * gradient, where the plane-to-plane lag dominates. The cold-room artefact is 9.8 % and stays
   * below this limit on purpose (§7.4.1).
   */
  condRange(config, run) {
    const truth = run.cond.kappa25_mScm;
    if (!(truth > 0.05)) return false;
    return Math.abs(run.cond.kappaDisp_mScm - truth) / truth > thresholdOf(config, 'ALM-CND-01', 0.20);
  },
  /** Row 27 — every fraction port has been used and the collector has nowhere left to go. */
  portsExhausted(config, run) {
    const ports = (config.skid.fracValve && config.skid.fracValve.ports) || [];
    return run.frac.mode !== 'OFF' && run.frac.nextPortIdx >= ports.length;
  },
  /**
   * Row 28 — a block hit its duration with `onTimeout: 'ALARM'`. `skid/engine.js` sets the marker
   * `run.extensionCount['#timeoutAlarm']` (a container `core/state.js` allocates as a plain object
   * and `engine.js` owns) and clears it at the next block start; this row only reads it.
   */
  methodTimeout(config, run) { return (run.extensionCount['#timeoutAlarm'] || 0) > 0; },
  /** Row 29 — a backward `GOTO_BLOCK` has looped more than `maxLoops = 10` times. */
  methodLoops(config, run) {
    const lc = run.loopCount;
    for (const k in lc) if (lc[k] > MAX_LOOPS) return true;
    return false;
  },
  /** Row 30 — the watchdog: a non-finite number anywhere in the load-bearing state. */
  nanTripwire(config, run) {
    return !Number.isFinite(run.Q_actual_mLs) || !Number.isFinite(run.V_tot_mL)
      || !Number.isFinite(run.P1_bar) || !Number.isFinite(run.dP_bar)
      || !Number.isFinite(run.uv.Afilt[0]) || !Number.isFinite(run.cond.kappaFilt_mScm)
      || !Number.isFinite(run.ph.pHfilt) || !Number.isFinite(run.yColOut_mM[0]);
  },
};

/** The in-force threshold for a row, by id, with a literal fallback for a hand-built config. */
function thresholdOf(config, id, fallback) {
  const table = tableOf(config);
  const k = ROW_INDEX.get(id);
  const row = (k !== undefined && table[k] && table[k].id === id) ? table[k] : null;
  const t = row ? row.threshold : null;
  return (typeof t === 'number' && Number.isFinite(t)) ? t : fallback;
}

// ---------------------------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------------------------

function compare(op, x, threshold) {
  if (!Number.isFinite(x)) return false;               // NaN never trips an alarm
  switch (op) {
    case '>': return x > threshold;
    case '<': return x < threshold;
    case 'abs>': return Math.abs(x) > threshold;
    default: return false;
  }
}

function rowSuppressed(config, run, def, k) {
  const keys = def.suppressWhen;
  if (!keys || keys.length === 0) return false;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === 'VALVE_MOVE') {
      if (run.valves.moveRemaining_s > 0 || run.t_s < run.alarmSuppressUntil_s[k]) return true;
    } else if (isSuppressed(config, run, keys[i])) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluate every alarm row: persistence, latching, suppression and the automatic flow reduction.
 * Called from `engine.controlTick` step (a) at 10 Hz. Zero allocation; the only allocations are the
 * event records logged on a raise/clear transition.
 *
 * `run.alarmSuppressUntil_s[k]` is refreshed to `t_s + 5 s` for EVERY row while the column valve is
 * in transit, so it reads "within 5.0 s of any column-valve move completing" (§5.6.1) with no edge
 * detection and no extra state.
 *
 * @param {object} config
 * @param {object} run
 * @param {number} dtCtrl_s  control-tick period, s (persistence is integrated in seconds)
 * @returns {void}
 */
export function evaluateAlarms(config, run, dtCtrl_s) {
  const table = tableOf(config);
  const n = Math.min(table.length, run.alarmActive.length);

  if (run.valves.moveRemaining_s > 0) {
    const until = run.t_s + VALVE_MOVE_SUPPRESS_S;
    for (let k = 0; k < run.alarmSuppressUntil_s.length; k++) run.alarmSuppressUntil_s[k] = until;
  }

  const wasReducing = !!run.flowReduction.active;
  let reduceDemand = false;

  for (let k = 0; k < n; k++) {
    const def = table[k];
    let cond;
    if (rowSuppressed(config, run, def, k)) {
      cond = false;
    } else if (def.op === 'custom') {
      const fn = CUSTOM_EVALUATORS[def.evalKey];
      cond = fn ? !!fn(config, run) : false;
    } else {
      cond = compare(def.op, readRowSignal(config, run, def), def.threshold);
    }

    if (cond) {
      run.alarmPersist_s[k] += dtCtrl_s;
      if (run.alarmPersist_s[k] >= def.persist_s && !run.alarmActive[k]) {
        raiseAlarm(config, run, def.id, null);
      }
    } else {
      run.alarmPersist_s[k] = 0;
      if (run.alarmActive[k] && !def.latching) clearAlarm(config, run, def.id);
      else if (run.alarmLatched[k] && run.alarmAcked[k]) clearAlarm(config, run, def.id);
    }
    if (run.alarmActive[k] && !run.alarmAcked[k] && def.action === 'REDUCE_FLOW') reduceDemand = true;
  }

  // The flow-reduction controller lives in fluidics; alarms only supply the demand bit.
  applyFlowReduction(config, run, dtCtrl_s, reduceDemand);
  const isReducing = !!run.flowReduction.active;
  if (isReducing !== wasReducing) {
    logEvent(config, run, {
      type: isReducing ? 'FLOW_REDUCTION_START' : 'FLOW_REDUCTION_END',
      severity: isReducing ? 'WARN' : 'INFO', source: 'ALARM', blockId: blockIdOf(config, run),
      message: isReducing ? 'Automatic flow reduction engaged' : 'Automatic flow reduction released',
      detail: { Q_limit_mLs: run.Q_limit_mLs },
    });
  }
}

function blockIdOf(config, run) {
  const b = currentBlock(config, run);
  return b ? b.id : null;
}

/**
 * Raise an alarm by id: set active/latched, clear its acknowledgement, and log `ALARM_RAISED`.
 * The state-machine consequence of `def.action` is applied by `engine.controlTick`, which reads
 * `run.alarmActive` against this table (alarms may not import the engine, §4).
 *
 * @param {object} config
 * @param {object} run
 * @param {string} alarmId  a row id, e.g. `'ALM-DP-02'`
 * @param {object|null} detail  free-form detail attached to the event record
 * @returns {void}
 */
export function raiseAlarm(config, run, alarmId, detail) {
  const table = tableOf(config);
  const k = ROW_INDEX.get(alarmId);
  if (k === undefined || !table[k] || k >= run.alarmActive.length) return;
  if (run.alarmActive[k]) return;
  const def = table[k];
  run.alarmActive[k] = 1;
  run.alarmAcked[k] = 0;
  if (def.latching) run.alarmLatched[k] = 1;
  logEvent(config, run, {
    type: 'ALARM_RAISED', severity: def.severity, source: 'ALARM', blockId: blockIdOf(config, run),
    message: def.id + ' ' + def.name,
    detail: detail || { action: def.action, threshold: def.threshold },
  });
  if (def.evalKey === 'airInlet' || def.id === 'ALM-AIR-02') {
    logEvent(config, run, {
      type: 'AIR_DETECTED', severity: 'WARN', source: 'ALARM', blockId: blockIdOf(config, run),
      message: 'Air detected in the flow path',
      detail: { fAirInletSensor: run.fAirInletSensor, fAirDet: run.fAirDet },
    });
  }
}

/**
 * Clear an alarm by id: drop active, latched and the persistence accumulator, and log
 * `ALARM_CLEARED`. Idempotent.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} alarmId
 * @returns {void}
 */
export function clearAlarm(config, run, alarmId) {
  const table = tableOf(config);
  const k = ROW_INDEX.get(alarmId);
  if (k === undefined || !table[k] || k >= run.alarmActive.length) return;
  if (!run.alarmActive[k] && !run.alarmLatched[k]) return;
  run.alarmActive[k] = 0;
  run.alarmLatched[k] = 0;
  run.alarmPersist_s[k] = 0;
  logEvent(config, run, {
    type: 'ALARM_CLEARED', severity: 'INFO', source: 'ALARM', blockId: blockIdOf(config, run),
    message: table[k].id + ' cleared', detail: null,
  });
}

const ACK_OK = Object.freeze({ ok: true });

/**
 * Acknowledge an alarm. A latched alarm whose condition has already gone away is cleared outright;
 * one whose condition still holds stays active but stops demanding its state transition.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} alarmId
 * @returns {{ok:boolean, reason?:string}} a frozen shared success singleton, or a fresh failure
 */
export function acknowledgeAlarm(config, run, alarmId) {
  const table = tableOf(config);
  const k = ROW_INDEX.get(alarmId);
  if (k === undefined || !table[k] || k >= run.alarmActive.length) {
    return { ok: false, reason: 'Unknown alarm id ' + alarmId };
  }
  if (!run.alarmActive[k] && !run.alarmLatched[k]) {
    return { ok: false, reason: table[k].id + ' is not active' };
  }
  run.alarmAcked[k] = 1;
  logEvent(config, run, {
    type: 'ALARM_ACK', severity: 'INFO', source: 'OPERATOR', blockId: blockIdOf(config, run),
    message: table[k].id + ' acknowledged', detail: null,
  });
  if (table[k].evalKey === 'methodTimeout') run.extensionCount['#timeoutAlarm'] = 0;
  if (run.alarmPersist_s[k] === 0) clearAlarm(config, run, alarmId);
  return ACK_OK;
}

/**
 * The highest severity currently active.
 *
 * @param {object} config
 * @param {object} run
 * @returns {'NONE'|'INFO'|'WARN'|'ALARM'|'CRITICAL'|'FAULT'}
 */
export function activeSeverity(config, run) {
  const table = tableOf(config);
  const n = Math.min(table.length, run.alarmActive.length);
  let worst = -1;
  for (let k = 0; k < n; k++) {
    if (!run.alarmActive[k] && !run.alarmLatched[k]) continue;
    const r = SEVERITIES.indexOf(table[k].severity);
    if (r > worst) worst = r;
  }
  return worst < 0 ? 'NONE' : SEVERITIES[worst];
}
