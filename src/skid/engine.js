/**
 * src/skid/engine.js — the 10 Hz supervisor: the run state machine, block sequencing and timeout,
 * and watch evaluation.
 *
 * Owner: `skid-method`. Contract §5.4.4c, §5.5, §5.5.1, §6.16, §3.3 step 12.
 *
 * `controlTick` is the SOLE writer of `run.slopeRing`: exactly one push per control tick, at the
 * top, before the alarms and the watches, sampling every signal in `slopeRing.signalIds` into its
 * own lane (`y[sig*64 + slot]`). The ring is multi-signal because a block routinely needs several
 * signals at once, and with one shared lane two watches read each other's history and both misfire.
 *
 * Layer L5. Imports util, log, method, alarms, fractionator, sensors, fluidics and `physics/bed.js`
 * (a downward L5 -> L3 edge, taken only for `forceFlush` at block boundaries — §3.4). It imports
 * NEITHER analytics module: the PACKING_TEST analysis belongs to `ui/view_results.js` (§5.4.3).
 */

import { clamp } from '../core/util.js';
import { logEvent } from '../core/log.js';
import { blockFlow_mLs, targetPctB, methodDemand } from './method.js';
import { ALARM_TABLE, raiseAlarm } from './alarms.js';
import * as alarms from './alarms.js';
import * as fractionator from './fractionator.js';
import { sensorSignal, autozeroUV } from './sensors.js';
import { switchInlet, requestColumnValve, requestOutlet } from './fluidics.js';
import { forceFlush } from '../physics/bed.js';

/** The eight run states (§5.5). */
export const RUN_STATES = ['IDLE', 'READY', 'RUNNING', 'HELD', 'PAUSED', 'ALARM', 'ENDED', 'FAULT'];

/**
 * The legal transition graph (§5.5). Notably illegal, each rejected with its own message:
 * `IDLE -> RUNNING`, `READY -> HELD|PAUSED|ALARM`, `ENDED -> RUNNING`, `FAULT -> anything but IDLE`,
 * and `ALARM -> RUNNING` (an alarm is left through HELD or PAUSED, never straight back to running).
 */
export const LEGAL_TRANSITIONS = {
  IDLE: ['READY'],
  READY: ['IDLE', 'RUNNING'],
  RUNNING: ['HELD', 'PAUSED', 'ALARM', 'ENDED', 'FAULT'],
  HELD: ['RUNNING', 'PAUSED', 'ENDED', 'ALARM', 'FAULT'],
  PAUSED: ['RUNNING', 'HELD', 'ENDED', 'ALARM', 'FAULT'],
  ALARM: ['HELD', 'PAUSED', 'ENDED', 'FAULT'],
  ENDED: ['IDLE'],
  FAULT: ['IDLE'],
};

/** What each state does to the pumps, the clock and the valves (§5.5). */
export const STATE_TABLE = {
  IDLE: { pumps: 'ZERO', clock: 'STOPPED', valves: 'SAFE', ackRequired: false },
  READY: { pumps: 'ZERO', clock: 'RESET', valves: 'PRESET', ackRequired: false },
  RUNNING: { pumps: 'SETPOINT', clock: 'RUN', valves: 'METHOD', ackRequired: false },
  HELD: { pumps: 'SETPOINT', clock: 'FROZEN', valves: 'FROZEN', ackRequired: false },
  PAUSED: { pumps: 'RAMP_ZERO', clock: 'FROZEN', valves: 'FROZEN', ackRequired: false },
  ALARM: { pumps: 'PER_ALARM', clock: 'FROZEN', valves: 'DIVERT', ackRequired: true },
  ENDED: { pumps: 'ZERO', clock: 'FINAL', valves: 'ENDSTATE', ackRequired: false },
  FAULT: { pumps: 'ZERO_NOW', clock: 'FROZEN', valves: 'FROZEN', ackRequired: true },
};

/** `run.slopeRing` capacity — must match `core/state.js` (§2.2). */
const RING_LEN = 64;
/** Slope-ring lane cap (§6.16); a method needing a seventh is a `validateMethod` error. */
const NSIG_MAX = 6;
/** Minimum samples in the window for an OLS slope (§5.4.4c rule 6). */
const MIN_SLOPE_SAMPLES = 8;
/** §5.4.4c rule 14. */
const MAX_LOOPS = 10;
/** §5.4.4c rule 10. */
const MAX_EXTENSIONS = 3;

const SLOPE_OPERATORS = ['SLOPE_ABOVE', 'SLOPE_BELOW', 'ABS_SLOPE_BELOW', 'STABLE', 'PLATEAU'];
const TERMINAL_ACTIONS = ['END_BLOCK', 'GOTO_BLOCK', 'HOLD', 'PAUSE', 'RAISE_ALARM'];

/** Automatic alarm actions, most severe first — the order `applyAlarmDemand` resolves them in. */
const ACTION_PRIORITY = ['TRIP', 'STOP', 'PAUSE', 'HOLD', 'REDUCE_FLOW', 'WARN', 'NONE'];

const OK_RESULT = Object.freeze({ ok: true });

// ---------------------------------------------------------------------------------------------
// method access helpers
// ---------------------------------------------------------------------------------------------

function blocksOf(config) {
  const m = config.method;
  return (m && Array.isArray(m.blocks)) ? m.blocks : null;
}

function currentBlock(config, run) {
  const b = blocksOf(config);
  return b ? (b[run.blockIndex] || null) : null;
}

function blockIdOf(config, run) {
  const b = currentBlock(config, run);
  return b ? b.id : null;
}

function firstEnabledIndex(config) {
  const b = blocksOf(config);
  if (!b) return -1;
  for (let i = 0; i < b.length; i++) if (b[i].enabled) return i;
  return -1;
}

function nextEnabledIndex(config, from) {
  const b = blocksOf(config);
  if (!b) return -1;
  for (let i = from + 1; i < b.length; i++) if (b[i].enabled) return i;
  return -1;
}

function prevEnabledBlock(config, index) {
  const b = blocksOf(config);
  if (!b) return null;
  for (let i = index - 1; i >= 0; i--) if (b[i].enabled) return b[i];
  return null;
}

/** Read a watch's signal without ever parsing a string on the hot path (§5.2). */
function readWatchSignal(config, run, row) {
  const r = row.signalResolved;
  if (r && r.base === 'TANK_LEVEL') return (r.tankIdx >= 0) ? run.tankVolume_mL[r.tankIdx] : NaN;
  return sensorSignal(config, run, r ? r.base : row.signal);
}

/** Read a signal by its §5.2 name (used for the slope-ring push, where lanes are named). */
function readNamedSignal(config, run, name) {
  return sensorSignal(config, run, name);
}

/** `{basis, value}` on the BLOCK's own totaliser: volumes in mL, times in s. */
function spanIsTime(basis) { return basis === 'min' || basis === 's'; }

function spanVolume_mL(config, basis, value) {
  if (basis === 'CV') return value * config.column.V_mL;
  if (basis === 'CV_OF_SAMPLE') {
    const s = (config.load && config.load.derived) ? config.load.derived.volume_mL : 0;
    return value * s;
  }
  return value;
}

function spanTime_s(basis, value) {
  return (basis === 'min') ? value * 60 : value;
}

/**
 * Per-block key cache. `advanceBlockClock` runs at 10 Hz and building `'#ext:' + block.id` there
 * would allocate a string every control tick, which the §13 zero-allocation budget forbids.
 */
const BLOCK_KEYS = new WeakMap();

function keysFor(block) {
  let k = BLOCK_KEYS.get(block);
  if (k) return k;
  k = { ext: '#ext:' + block.id, latch: '#timeoutHold:' + block.id, repeat: '#repeat:' + block.id };
  BLOCK_KEYS.set(block, k);
  return k;
}

/**
 * The block's duration target, extensions included (§5.4.4c rule 10).
 * Returns a MODULE-OWNED SINGLETON — read it immediately, never retain it (§13).
 */
const TARGET = { volume_mL: Infinity, time_s: Infinity, timeBased: false };

function blockTarget(config, run, block) {
  const t = TARGET;
  if (!block || block.type === 'HOLD') {
    t.volume_mL = Infinity; t.time_s = Infinity; t.timeBased = false;
    return t;
  }
  const d = block.duration;
  const value = d.value + (run.extensionCount[keysFor(block).ext] || 0);
  const Q = blockFlow_mLs(config, block, null);
  t.timeBased = spanIsTime(d.basis);
  if (t.timeBased) {
    t.time_s = spanTime_s(d.basis, value);
    t.volume_mL = Number.isFinite(Q) ? t.time_s * Q : Infinity;
  } else {
    t.volume_mL = spanVolume_mL(config, d.basis, value);
    t.time_s = (Number.isFinite(Q) && Q > 0) ? t.volume_mL / Q : Infinity;
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------------------------

/**
 * Is `from -> to` in `LEGAL_TRANSITIONS`? A self-transition is always legal and is a no-op.
 *
 * @param {string} from  a `RUN_STATES` value
 * @param {string} to    a `RUN_STATES` value
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true;
  const allowed = LEGAL_TRANSITIONS[from];
  return !!allowed && allowed.indexOf(to) >= 0;
}

function applyStateTable(config, run, to) {
  const row = STATE_TABLE[to];
  if (!row) return;
  const block = currentBlock(config, run);

  switch (row.pumps) {
    case 'ZERO':
    case 'ZERO_NOW':
      run.Q_set_mLs = 0;
      run.Q_actual_mLs = 0;
      break;
    case 'RAMP_ZERO':
      run.Q_set_mLs = 0;
      break;
    case 'SETPOINT':
      if (block) {
        const Q = blockFlow_mLs(config, block, prevEnabledBlock(config, run.blockIndex));
        if (Number.isFinite(Q)) run.Q_set_mLs = clamp(Q, 0, config.skid.Qmax_mLs);
      }
      break;
    default: break;                                   // PER_ALARM: whatever the alarm action left
  }

  if (row.clock === 'RESET') {
    run.blockIndex = firstEnabledIndex(config) < 0 ? 0 : firstEnabledIndex(config);
    run.blockElapsed_s = 0;
    run.blockStartV_mL = run.V_tot_mL;
    run.V_block_mL = 0;
    run.gradElapsed_mL = 0;
  }

  switch (row.valves) {
    case 'SAFE':
      requestColumnValve(config, run, 'BYPASS');
      requestOutlet(config, run, 'WASTE');
      break;
    case 'PRESET': {
      const first = blocksOf(config) ? blocksOf(config)[firstEnabledIndex(config)] : null;
      if (first) {
        requestColumnValve(config, run, first.columnValve);
        requestOutlet(config, run, first.outletDefault);
      }
      break;
    }
    case 'DIVERT':
      requestOutlet(config, run, 'WASTE');             // an ALARM never moves the column valve
      break;
    case 'ENDSTATE': {
      const end = config.method && config.method.endState;
      if (end) {
        requestColumnValve(config, run, end.columnValve || 'BYPASS');
        requestOutlet(config, run, end.outletValve || 'WASTE');
      }
      break;
    }
    default: break;                                    // METHOD / FROZEN: nothing to do here
  }

  if (to === 'RUNNING') run.manualOverride = false;    // §5.5: manual is force-cleared into RUNNING
}

/**
 * The single state-transition implementation (§5.5). Validates against `LEGAL_TRANSITIONS`, applies
 * `STATE_TABLE[to]`, logs `STATE_CHANGE`, and NEVER throws.
 *
 * Entering `RUNNING` from `READY` also logs `RUN_START` and starts the first enabled block; entering
 * `ENDED` logs `RUN_END` after the end-state valves are applied.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} to      target state, a `RUN_STATES` value
 * @param {string} reason  free text recorded on the event
 * @returns {{ok:boolean, reason?:string}} a shared frozen success singleton, or a fresh failure
 */
export function setRunState(config, run, to, reason) {
  if (RUN_STATES.indexOf(to) < 0) return { ok: false, reason: 'Unknown run state ' + to };
  const from = run.state;
  if (from === to) return OK_RESULT;
  if (!canTransition(from, to)) {
    return { ok: false, reason: from + ' -> ' + to + ' is not a legal transition' };
  }
  const wasReady = (from === 'READY');
  run.state = to;
  applyStateTable(config, run, to);
  logEvent(config, run, {
    type: 'STATE_CHANGE', severity: to === 'FAULT' ? 'FAULT' : 'INFO', source: 'SYSTEM',
    blockId: blockIdOf(config, run), message: from + ' -> ' + to,
    detail: { from, to, reason: reason || '' },
  });
  if (to === 'RUNNING' && wasReady) {
    logEvent(config, run, {
      type: 'RUN_START', severity: 'INFO', source: 'OPERATOR', blockId: null,
      message: 'Run started', detail: { methodId: config.method ? config.method.methodId : null },
    });
    const first = firstEnabledIndex(config);
    if (first >= 0) startBlock(config, run, first);
  }
  if (to === 'ENDED') {
    if (run.frac.open) fractionator.closeFraction(config, run, 'BLOCK_END');
    logEvent(config, run, {
      type: 'RUN_END', severity: 'INFO', source: 'SYSTEM', blockId: null,
      message: 'Run ended: ' + (reason || 'method complete'),
      detail: { t_s: run.t_s, V_mL: run.V_tot_mL, reason: reason || '' },
    });
  }
  return OK_RESULT;
}

/**
 * Derive and apply the run-state consequence of whatever alarms are currently active.
 *
 * `skid/alarms.js` is L4 and may not import this module, so it records the alarm and this function —
 * called from `controlTick` immediately after `evaluateAlarms` — reads `run.alarmActive` against the
 * table and applies the most severe demanded action. An ACKNOWLEDGED alarm stops demanding, which is
 * what lets the operator leave `HELD`/`ALARM`.
 */
function applyAlarmDemand(config, run) {
  if (run.state !== 'RUNNING' && run.state !== 'HELD' && run.state !== 'PAUSED') return;
  const table = (config.alarms && config.alarms.length) ? config.alarms : ALARM_TABLE;
  const n = Math.min(table.length, run.alarmActive.length);
  let bestRank = ACTION_PRIORITY.length;
  let bestRow = null;
  for (let k = 0; k < n; k++) {
    if (!run.alarmActive[k] || run.alarmAcked[k]) continue;
    const rank = ACTION_PRIORITY.indexOf(table[k].action);
    if (rank >= 0 && rank < bestRank) { bestRank = rank; bestRow = table[k]; }
  }
  if (!bestRow) return;
  switch (bestRow.action) {
    case 'TRIP':
      setRunState(config, run, bestRow.severity === 'FAULT' ? 'FAULT' : 'ALARM', bestRow.id);
      break;
    case 'STOP':                                       // no shipped row uses STOP; treated as PAUSE
    case 'PAUSE':
      setRunState(config, run, 'PAUSED', bestRow.id);
      break;
    case 'HOLD':
      setRunState(config, run, 'HELD', bestRow.id);
      break;
    default: break;                                    // REDUCE_FLOW is applied inside alarms.js
  }
}

// ---------------------------------------------------------------------------------------------
// pre-run checks
// ---------------------------------------------------------------------------------------------

/**
 * The twelve READY-gate checks of §5.5.1. ALL are evaluated and ALL failures are reported at once.
 *
 * @param {object} config
 * @param {object} run
 * @returns {{ok:boolean, failures:Array<{code:string, message:string, acknowledgeable:boolean}>}}
 *   `ok` is true iff every NON-acknowledgeable failure is absent.
 */
export function preRunChecks(config, run) {
  const failures = [];
  const fail = (code, message, acknowledgeable) => failures.push({ code, message, acknowledgeable });
  const blocks = blocksOf(config) || [];
  const method = config.method;
  const assign = config.inletAssignments || {};
  const tanks = config.tanks || [];
  const demand = method ? methodDemand(config, method) : { perTank: {}, totalVolume_mL: 0, perBlock: [] };

  // PRC-01 — every inlet an enabled block references is assigned to a tank.
  for (const b of blocks) {
    if (!b.enabled) continue;
    const ports = [b.inlets.a, b.inlets.b, b.inlets.sample];
    const needsB = b.gradient.shape !== 'ISOCRATIC' || b.gradient.startPctB > 0 || b.gradient.endPctB > 0;
    for (let i = 0; i < ports.length; i++) {
      const p = ports[i];
      if (!p) continue;
      if (i === 1 && !needsB) continue;
      if (i === 2 && !b.sample.mode) continue;
      if (!assign[p]) fail('PRC-01', 'Block ' + b.id + ' uses inlet ' + p + ', which has no tank.', false);
    }
  }
  // PRC-02 — every referenced tank holds at least its demand.
  for (let k = 0; k < tanks.length; k++) {
    const need = demand.perTank[tanks[k].id] || 0;
    if (need > run.tankVolume_mL[k]) {
      fail('PRC-02', 'Tank ' + tanks[k].id + ' holds ' + Math.round(run.tankVolume_mL[k])
        + ' mL but the method needs ' + Math.round(need) + ' mL.', true);
    }
  }
  // PRC-03 — waste headroom against the volume that will not be collected.
  let collected_mL = 0;
  for (const b of blocks) {
    if (!b.enabled || b.fractionation.mode === 'OFF') continue;
    const t = blockTarget(config, run, b);
    const maxFrac_mL = spanVolume_mL(config, b.fractionation.maxFractionVolume.basis,
      b.fractionation.maxFractionVolume.value);
    const cap_mL = maxFrac_mL * Math.max(1, b.fractionation.portCount);
    collected_mL += Math.min(Number.isFinite(t.volume_mL) ? t.volume_mL : 0, cap_mL);
  }
  const headroom_mL = config.skid.wasteCapacity_mL - run.wasteVolume_mL;
  if (headroom_mL < demand.totalVolume_mL - collected_mL) {
    fail('PRC-03', 'Waste headroom is ' + Math.round(headroom_mL) + ' mL against '
      + Math.round(demand.totalVolume_mL - collected_mL) + ' mL to waste.', true);
  }
  // PRC-04 — every block's resolved flow is inside the pump envelope.
  // HOLD is exempt: a hold parks the skid with the pumps stopped, so Q = 0 is its correct and
  // only sensible flow. Requiring Q >= QminAbs here would force a terminal HOLD to keep pumping,
  // and a HOLD that also moves the column valve would then trip the valve-under-flow interlock
  // (ALM-CV-02) and park the run in ALARM, where advanceWall stops ticking. Same exemption in
  // spirit as PRC-08/rule 12, which already excuses HOLD from the duration rule.
  let prev = null;
  for (const b of blocks) {
    if (!b.enabled || b.type === 'HOLD') continue;
    const Q = blockFlow_mLs(config, b, prev);
    prev = b;
    if (!Number.isFinite(Q) || Q < config.skid.QminAbs_mLs || Q > config.skid.Qmax_mLs) {
      fail('PRC-04', 'Block ' + b.id + ' resolves to '
        + (Number.isFinite(Q) ? (Q * 60).toFixed(1) + ' mL/min' : 'an unresolvable flow')
        + ', outside the pump range.', false);
    }
  }
  // PRC-05 — the P1 trip must sit at or below the hardware rating.
  const table = (config.alarms && config.alarms.length) ? config.alarms : ALARM_TABLE;
  let p1Trip_bar = 0;
  for (const r of table) if (r.id === 'ALM-P1-02') p1Trip_bar = r.threshold;
  if (!(p1Trip_bar <= config.column.hardwarePressureLimit_bar)) {
    fail('PRC-05', 'P1 trip ' + p1Trip_bar + ' bar exceeds the hardware limit '
      + config.column.hardwarePressureLimit_bar + ' bar.', false);
  }
  // PRC-06 — the column geometry is self-consistent.
  const geomErr = Math.abs(config.column.A_cm2 * config.column.L_cm - config.column.V_mL)
    / config.column.V_mL;
  if (!(geomErr < 1e-3)) {
    fail('PRC-06', 'Column geometry is inconsistent: A*L differs from V by '
      + (geomErr * 100).toFixed(2) + ' %.', false);
  }
  // PRC-07 — the smallest fraction is long enough, and there are ports (or an overflow) for it.
  const tSwitch_s = config.skid.fracValve.tSwitch_s;
  prev = null;
  for (const b of blocks) {
    if (!b.enabled) { continue; }
    const Q = blockFlow_mLs(config, b, prev);
    prev = b;
    if (b.fractionation.mode === 'OFF') continue;
    const min_mL = spanVolume_mL(config, b.fractionation.minFractionVolume.basis,
      b.fractionation.minFractionVolume.value);
    if (Number.isFinite(Q) && Q > 0 && min_mL / Q < 10 * tSwitch_s) {
      fail('PRC-07', 'Block ' + b.id + ' can produce a fraction of only ' + (min_mL / Q).toFixed(1)
        + ' s, below 10 x the ' + tSwitch_s + ' s valve switch.', false);
    }
    const ports = config.skid.fracValve.ports.length;
    if (b.fractionation.portCount > ports && !b.fractionation.overflowTo) {
      fail('PRC-07', 'Block ' + b.id + ' wants ' + b.fractionation.portCount + ' ports; the collector has '
        + ports + ' and no overflow destination.', false);
    }
  }
  // PRC-08 — no enabled block has a non-positive duration.
  for (const b of blocks) {
    if (!b.enabled || b.type === 'HOLD') continue;
    if (!(b.duration.value > 0)) fail('PRC-08', 'Block ' + b.id + ' has a non-positive duration.', false);
  }
  // PRC-09 — every GOTO target exists.
  const ids = new Set(blocks.map((b) => b.id));
  for (const b of blocks) {
    if (!b.enabled) continue;
    for (const w of b.watches) {
      if (w.action === 'GOTO_BLOCK' && !ids.has(w.actionParam)) {
        fail('PRC-09', 'Watch ' + w.id + ' in ' + b.id + ' jumps to missing block "'
          + String(w.actionParam) + '".', false);
      }
    }
  }
  // PRC-10 — the pH electrode is calibrated well enough to be believed.
  if (run.ph.slopePct < 92) {
    fail('PRC-10', 'pH electrode slope is ' + run.ph.slopePct.toFixed(1) + ' %, below 92 %.', true);
  }
  // PRC-11 — a LOAD block exists if the preset defines a load.
  if (config.load && !blocks.some((b) => b.enabled && b.type === 'LOAD')) {
    fail('PRC-11', 'The preset defines a load but the method has no enabled LOAD block.', true);
  }
  // PRC-12 — no CIP block runs a pH > 12 inlet with the probe in line.
  for (const b of blocks) {
    if (!b.enabled || b.type !== 'CIP') continue;
    if (b.columnValve === 'CIP_DETECTOR_BYPASS') continue;
    const tankId = assign[b.inlets.a];
    const tank = tanks.find((t) => t.id === tankId);
    if (!tank || !tank.composition) continue;
    const strongBase_mM = tank.composition.strongBase_mM || 0;
    const targetPH = tank.composition.targetPH;
    if (strongBase_mM >= 100 || (typeof targetPH === 'number' && targetPH > 12)) {
      fail('PRC-12', 'CIP block ' + b.id + ' runs ' + tank.id
        + ' (pH > 12) with the pH probe in line — the electrode will degrade.', true);
    }
  }
  const ok = failures.every((f) => f.acknowledgeable);
  return { ok, failures };
}

// ---------------------------------------------------------------------------------------------
// block sequencing
// ---------------------------------------------------------------------------------------------

/**
 * Enter a block: flush the column batch, reset the block totalisers, apply the block's inlets,
 * valves, flow and %B, arm its watches, rebuild the slope-ring lanes, and log `BLOCK_START`.
 *
 * @param {object} config
 * @param {object} run
 * @param {number} index  index into `config.method.blocks`
 * @returns {void}
 */
export function startBlock(config, run, index) {
  const blocks = blocksOf(config);
  if (!blocks || !blocks[index]) return;
  const block = blocks[index];

  forceFlush(config, run, 'BLOCK_START');              // §3.4: flush BEFORE the boundary event
  run.blockIndex = index;
  run.blockElapsed_s = 0;
  run.blockStartV_mL = run.V_tot_mL;
  run.V_block_mL = 0;
  run.gradElapsed_mL = 0;
  run.blockBoundaryFlag = true;
  run.extensionCount['#timeoutAlarm'] = 0;
  run.extensionCount[keysFor(block).latch] = 0;

  // Inlets, valves, flow, %B.
  if (block.inlets.a) switchInlet(config, run, 'A', block.inlets.a);
  if (block.inlets.b) switchInlet(config, run, 'B', block.inlets.b);
  switchInlet(config, run, 'S', block.inlets.sample || null);
  run.valves.sampleMode = block.sample ? block.sample.mode : null;
  // The column valve is DEFERRED, not commanded outright. At a block boundary the pumps are still
  // running at the previous block's flow, so a move requested here is rejected by the
  // valve-under-flow interlock and raises ALM-CV-02 — which is what a terminal HOLD that bypasses
  // the column used to do on every single run. A real skid ramps the pumps down first and then
  // moves the valve, which is what serviceColumnValve does from the control tick.
  run.valves.cvPending = block.columnValve;
  serviceColumnValve(config, run);
  requestOutlet(config, run, block.outletDefault);
  const Q = blockFlow_mLs(config, block, prevEnabledBlock(config, index));
  if (Number.isFinite(Q)) run.Q_set_mLs = clamp(Q, 0, config.skid.Qmax_mLs);
  run.pctB_set = targetPctB(config, block, 0);

  // Fractionation.
  run.frac.mode = block.fractionation ? block.fractionation.mode : 'OFF';
  if (run.frac.mode !== 'OFF' && run.frac.records.length === 0) {
    const ports = config.skid.fracValve.ports;
    const first = ports.indexOf(block.fractionation.firstPort);
    run.frac.nextPortIdx = first >= 0 ? first : 0;
  }
  run.frac.peakMax_AU = 0;
  run.frac.peakMax_V_mL = 0;
  run.frac.peakMaxSeen = false;

  if (block.autozero) autozeroUV(config, run, 'all');

  initWatchStates(config, run, index);

  logEvent(config, run, {
    type: 'BLOCK_START', severity: 'INFO', source: 'PHASE_ENGINE', blockId: block.id,
    message: 'Block ' + block.id + ' (' + block.name + ') started',
    detail: { type: block.type, index, Q_mLs: run.Q_set_mLs, pctB: run.pctB_set },
  });
}

/** Finalise the current block without deciding what comes next. */
function finaliseBlock(config, run, reason) {
  const block = currentBlock(config, run);
  if (!block) return;
  if (run.frac.open) fractionator.closeFraction(config, run, 'BLOCK_END');
  forceFlush(config, run, 'BLOCK_END');                // §3.4: the mass audit must see a flushed bed
  run.blockBoundaryFlag = true;
  const detail = { reason, index: run.blockIndex, V_block_mL: run.V_block_mL,
    elapsed_s: run.blockElapsed_s };
  if (block.type === 'PACKING_TEST') detail.packingTest = true;
  logEvent(config, run, {
    type: 'BLOCK_END', severity: 'INFO', source: 'PHASE_ENGINE', blockId: block.id,
    message: 'Block ' + block.id + ' ended (' + reason + ')', detail,
  });
  if (block.type === 'CIP') {
    run.cycleIndex++;
    logEvent(config, run, {
      type: 'CIP_COMPLETE', severity: 'INFO', source: 'PHASE_ENGINE', blockId: block.id,
      message: 'CIP cycle ' + run.cycleIndex + ' complete', detail: { cycleIndex: run.cycleIndex },
    });
  }
}

/**
 * End the current block and advance.
 *
 * `reason === 'GOTO'` finalises WITHOUT advancing — the jump's caller starts the target block. A
 * block with `holdAtEnd` enters `HELD` instead of advancing. With no enabled block left the run
 * transitions to `ENDED`.
 *
 * @param {object} config
 * @param {object} run
 * @param {'DURATION'|'WATCH'|'OPERATOR'|'GOTO'|'TIMEOUT'} reason
 * @returns {void}
 */
export function endBlock(config, run, reason) {
  const block = currentBlock(config, run);
  finaliseBlock(config, run, reason);
  if (reason === 'GOTO') return;
  if (block && block.holdAtEnd) {
    setRunState(config, run, 'HELD', 'holdAtEnd');
    return;
  }
  const next = nextEnabledIndex(config, run.blockIndex);
  if (next < 0) {
    setRunState(config, run, 'ENDED', 'method complete');
    return;
  }
  startBlock(config, run, next);
}

/**
 * Advance the block clock, drive the gradient, and enforce the duration timeout.
 *
 * Progress uses the integral of `Q_actual dt` (`run.V_block_mL`) for the `CV`/`mL` bases and
 * simulated time for `min`/`s`, so a flow-reduced block still delivers exactly its CV
 * (§5.4.4c rule 13). `%B` is recomputed every control tick for a non-ISOCRATIC block; on an
 * ISOCRATIC block it is left alone so a `SET_PCTB` watch action sticks.
 *
 * @param {object} config
 * @param {object} run
 * @param {number} dtCtrl_s  control-tick period, s
 * @returns {void}
 */
export function advanceBlockClock(config, run, dtCtrl_s) {
  if (run.state !== 'RUNNING') return;                 // HELD / PAUSED freeze the block clock
  const block = currentBlock(config, run);
  if (!block) return;
  run.blockElapsed_s += dtCtrl_s;

  const t = blockTarget(config, run, block);
  const frac = t.timeBased
    ? (t.time_s > 0 ? run.blockElapsed_s / t.time_s : 1)
    : (Number.isFinite(t.volume_mL) && t.volume_mL > 0 ? run.V_block_mL / t.volume_mL : 0);

  if (block.gradient.shape !== 'ISOCRATIC') {
    run.pctB_set = targetPctB(config, block, frac);
    const L = Math.max(block.gradient.lengthFraction, 1e-9);
    run.gradElapsed_mL = Math.min(run.V_block_mL,
      Number.isFinite(t.volume_mL) ? t.volume_mL * L : run.V_block_mL);
  }

  if (block.type === 'HOLD') return;                   // §5.4.4c rule 12: never ends on duration
  if (frac < 1) return;

  const keys = keysFor(block);
  const latchKey = keys.latch;
  if (run.extensionCount[latchKey]) return;            // already handled once for this block entry

  const onTimeout = block.duration.onTimeout || 'NEXT';
  const repeatKey = keys.repeat;
  logEvent(config, run, {
    type: 'WATCH_TIMEOUT',
    severity: onTimeout === 'ALARM' ? 'ALARM' : (onTimeout === 'HOLD' ? 'WARN' : 'INFO'),
    source: 'PHASE_ENGINE', blockId: block.id,
    message: 'Block ' + block.id + ' reached its duration with no watch firing (' + onTimeout + ')',
    detail: { onTimeout, V_block_mL: run.V_block_mL, elapsed_s: run.blockElapsed_s },
  });

  switch (onTimeout) {
    case 'HOLD':
      run.extensionCount[latchKey] = 1;
      setRunState(config, run, 'HELD', 'duration timeout');
      break;
    case 'ALARM':
      run.extensionCount[latchKey] = 1;
      run.extensionCount['#timeoutAlarm'] = 1;         // read by alarms.CUSTOM_EVALUATORS.methodTimeout
      raiseAlarm(config, run, 'ALM-MTH-01', { blockId: block.id });
      break;
    case 'REPEAT': {
      const done = run.extensionCount[repeatKey] || 0;
      if (done < block.duration.repeatLimit) {
        const idx = run.blockIndex;
        finaliseBlock(config, run, 'TIMEOUT');
        startBlock(config, run, idx);                  // re-enter the SAME block, clocks reset
        run.extensionCount[repeatKey] = done + 1;      // set after: startBlock clears no '#' keys
      } else {
        endBlock(config, run, 'TIMEOUT');
      }
      break;
    }
    default:
      endBlock(config, run, 'TIMEOUT');
      break;
  }
}

/**
 * How far through the current block the run is.
 *
 * @param {object} config
 * @param {object} run
 * @returns {{fraction:number, remaining_mL:number, remaining_s:number}} `fraction` 0..1;
 *   `remaining_mL` mL at the block totaliser; `remaining_s` s at the current flow (Infinity for HOLD)
 */
export function blockProgress(config, run) {
  const block = currentBlock(config, run);
  if (!block) return { fraction: 0, remaining_mL: 0, remaining_s: 0 };
  const t = blockTarget(config, run, block);
  if (!Number.isFinite(t.volume_mL)) {
    return { fraction: 0, remaining_mL: Infinity, remaining_s: Infinity };
  }
  const remaining_mL = Math.max(0, t.volume_mL - run.V_block_mL);
  const fraction = t.timeBased
    ? clamp(t.time_s > 0 ? run.blockElapsed_s / t.time_s : 0, 0, 1)
    : clamp(t.volume_mL > 0 ? run.V_block_mL / t.volume_mL : 0, 0, 1);
  const Q = run.Q_actual_mLs;
  const remaining_s = t.timeBased
    ? Math.max(0, t.time_s - run.blockElapsed_s)
    : (Q > 1e-9 ? remaining_mL / Q : Infinity);
  return { fraction, remaining_mL, remaining_s };
}

// ---------------------------------------------------------------------------------------------
// watches
// ---------------------------------------------------------------------------------------------

/**
 * Rebuild `run.watchState` and the slope-ring lanes for the block being entered.
 *
 * `signalIds` is every distinct `watch.signal` whose operator is SLOPE_ABOVE / SLOPE_BELOW /
 * ABS_SLOPE_BELOW / STABLE / PLATEAU, plus the block's `fractionation.signal` when the mode is not
 * `OFF`, deduplicated, in that order, capped at NSIG_MAX = 6. History does not cross a block
 * boundary — the lane assignment changed — so `n` and `head` are reset.
 *
 * @param {object} config
 * @param {object} run
 * @param {number} blockIndex
 * @returns {void}
 */
export function initWatchStates(config, run, blockIndex) {
  const blocks = blocksOf(config);
  const block = blocks ? blocks[blockIndex] : null;
  const watches = block ? block.watches : [];

  while (run.watchState.length < watches.length) {
    run.watchState.push({ armed: false, armedAtV_mL: 0, count: 0, fired: false, prevSide: 0,
      valueAtArm: NaN, prevValue: NaN });
  }
  run.watchState.length = watches.length;
  for (let i = 0; i < watches.length; i++) {
    const st = run.watchState[i];
    st.armed = false; st.armedAtV_mL = 0; st.count = 0; st.fired = false; st.prevSide = 0;
    st.valueAtArm = NaN; st.prevValue = NaN;
  }

  const ring = run.slopeRing;
  ring.signalIds.length = 0;
  for (let i = 0; i < watches.length; i++) {
    const w = watches[i];
    if (SLOPE_OPERATORS.indexOf(w.operator) < 0) continue;
    if (w.signalResolved && w.signalResolved.base === 'TANK_LEVEL') continue;  // not a ring signal
    if (ring.signalIds.indexOf(w.signal) < 0 && ring.signalIds.length < NSIG_MAX) {
      ring.signalIds.push(w.signal);
    }
  }
  if (block && block.fractionation && block.fractionation.mode !== 'OFF') {
    const s = block.fractionation.signal;
    if (ring.signalIds.indexOf(s) < 0 && ring.signalIds.length < NSIG_MAX) ring.signalIds.push(s);
  }
  ring.nSig = ring.signalIds.length;
  ring.n = 0;
  ring.head = 0;
}

/** One push per control tick, into every lane. `controlTick` is the ring's SOLE writer (§6.16). */
function pushSlopeSamples(config, run) {
  const ring = run.slopeRing;
  if (ring.nSig <= 0) return;
  const slot = (ring.n === 0) ? 0 : (ring.head + 1) % RING_LEN;
  ring.V_mL[slot] = run.V_tot_mL;
  for (let s = 0; s < ring.nSig; s++) {
    ring.y[s * RING_LEN + slot] = readNamedSignal(config, run, ring.signalIds[s]);
  }
  ring.head = slot;
  if (ring.n < RING_LEN) ring.n++;
}

/**
 * OLS d(signal)/dV over that signal's lane of `run.slopeRing`, in signal units PER mL.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} signalName    a §5.2 name; must be in `run.slopeRing.signalIds`
 * @param {number} windowVolume_mL  the trailing volume window, mL
 * @returns {number} slope in signal-units/mL, or NaN with fewer than 8 samples in the window or when
 *   the signal has no lane
 */
export function signalSlope(config, run, signalName, windowVolume_mL) {
  const ring = run.slopeRing;
  const sig = ring.signalIds.indexOf(signalName);
  if (sig < 0 || ring.n < MIN_SLOPE_SAMPLES) return NaN;
  const base = sig * RING_LEN;
  const x0 = ring.V_mL[ring.head];
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < ring.n; i++) {
    const slot = (ring.head - i + RING_LEN * 2) % RING_LEN;
    const dx = ring.V_mL[slot] - x0;                   // <= 0; shifted so the fit stays conditioned
    if (-dx > windowVolume_mL) break;
    const y = ring.y[base + slot];
    if (!Number.isFinite(y)) continue;
    n++; sx += dx; sy += y; sxx += dx * dx; sxy += dx * y;
  }
  if (n < MIN_SLOPE_SAMPLES) return NaN;
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-30) return NaN;
  return (n * sxy - sx * sy) / den;
}

/** max − min of a lane over the window; NaN with too few samples. */
function laneRange(run, signalName, windowVolume_mL) {
  const ring = run.slopeRing;
  const sig = ring.signalIds.indexOf(signalName);
  if (sig < 0 || ring.n < MIN_SLOPE_SAMPLES) return NaN;
  const base = sig * RING_LEN;
  const x0 = ring.V_mL[ring.head];
  let n = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < ring.n; i++) {
    const slot = (ring.head - i + RING_LEN * 2) % RING_LEN;
    if (x0 - ring.V_mL[slot] > windowVolume_mL) break;
    const y = ring.y[base + slot];
    if (!Number.isFinite(y)) continue;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    n++;
  }
  return (n < MIN_SLOPE_SAMPLES) ? NaN : hi - lo;
}

/**
 * The STABLE test of §5.4.4c rule 7: `|slope| <= tolerance/window` AND `(max − min) <= tolerance`.
 * BOTH — slope alone passes on a noisy plateau with a wandering mean.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} signalName
 * @param {number} tolerance         in the signal's canonical units
 * @param {number} windowVolume_mL   trailing volume window, mL
 * @returns {boolean}
 */
export function isStable(config, run, signalName, tolerance, windowVolume_mL) {
  if (!(windowVolume_mL > 0)) return false;
  const s = signalSlope(config, run, signalName, windowVolume_mL);
  if (!Number.isFinite(s)) return false;
  if (Math.abs(s) > tolerance / windowVolume_mL) return false;
  const r = laneRange(run, signalName, windowVolume_mL);
  return Number.isFinite(r) && r <= tolerance;
}

/** Has the watch's arm dead time elapsed on the BLOCK's own totaliser (§5.4.4c rule 3)? */
function armElapsed(config, run, watch) {
  const a = watch.arm;
  if (spanIsTime(a.basis)) return run.blockElapsed_s >= spanTime_s(a.basis, a.value);
  return run.V_block_mL >= spanVolume_mL(config, a.basis, a.value);
}

function windowVolume_mL(config, run, watch) {
  const w = watch.slopeWindow;
  if (!w) return NaN;
  if (spanIsTime(w.basis)) return spanTime_s(w.basis, w.value) * run.Q_actual_mLs;
  return spanVolume_mL(config, w.basis, w.value);
}

/** Evaluate one operator. Returns true when THIS tick satisfies the condition. */
function conditionMet(config, run, watch, st, x) {
  const t = watch.threshold;
  switch (watch.operator) {
    case 'ABOVE': return x > t;
    case 'BELOW': return x < t;
    case 'RISES_ABOVE': return x > t && st.prevSide < 0;
    case 'FALLS_BELOW': return x < t && st.prevSide > 0;
    case 'REACHES': return Math.abs(x - t) <= 0.01 * Math.abs(t);
    case 'CHANGES_BY': return Math.abs(x - st.valueAtArm) >= t;   // NaN valueAtArm => false, by design
    case 'SLOPE_ABOVE': {
      const s = signalSlope(config, run, watch.signal, windowVolume_mL(config, run, watch));
      return Number.isFinite(s) && s > t;
    }
    case 'SLOPE_BELOW': {
      const s = signalSlope(config, run, watch.signal, windowVolume_mL(config, run, watch));
      return Number.isFinite(s) && s < t;
    }
    case 'ABS_SLOPE_BELOW': {
      const s = signalSlope(config, run, watch.signal, windowVolume_mL(config, run, watch));
      return Number.isFinite(s) && Math.abs(s) <= t;
    }
    case 'STABLE':
      return isStable(config, run, watch.signal, watch.stableTolerance,
        windowVolume_mL(config, run, watch));
    case 'PLATEAU': {
      const win = windowVolume_mL(config, run, watch);
      const s = signalSlope(config, run, watch.signal, win);
      if (!Number.isFinite(s) || Math.abs(s) > t) return false;
      const r = laneRange(run, watch.signal, win);
      return Number.isFinite(r) && r <= watch.stableTolerance;
    }
    default: return false;
  }
}

/**
 * Evaluate every watch of the current block and apply the actions that fired (§5.4.4c).
 *
 * Returns VOID and applies actions directly — a per-tick compound return is 36 000 allocations an
 * hour and collides with the zero-allocation DoD (§13). Array order decides: ALL satisfied
 * non-terminal actions execute in order first, then the FIRST satisfied terminal action executes and
 * ends evaluation for that tick.
 *
 * @param {object} config
 * @param {object} run
 * @param {number} dtCtrl_s  control-tick period, s (unused: persistence is counted in ticks here,
 *   per §5.4.4c rule 4, which specifies consecutive CONTROL TICKS, not seconds)
 * @returns {void}
 */
export function evaluateWatches(config, run, dtCtrl_s) {
  const block = currentBlock(config, run);
  if (!block) return;
  const watches = block.watches;
  if (!watches || watches.length === 0) return;
  if (run.watchState.length !== watches.length) initWatchStates(config, run, run.blockIndex);

  let terminalIdx = -1;
  for (let i = 0; i < watches.length; i++) {
    const w = watches[i];
    const st = run.watchState[i];
    if (st.fired && w.oneShot) continue;

    const x = readWatchSignal(config, run, w);

    if (!st.armed) {
      if (!armElapsed(config, run, w)) { st.prevValue = x; continue; }
      st.armed = true;
      st.armedAtV_mL = run.V_block_mL;
      st.valueAtArm = x;                              // written ONCE, on the tick armed flips true
      st.prevSide = Number.isFinite(x) ? (x > w.threshold ? 1 : (x < w.threshold ? -1 : 0)) : 0;
      st.count = 0;
    }

    // A NaN sample satisfies nothing: every comparison against NaN is false, which is exactly the
    // required behaviour for an unevaluable signal (§5.2).
    const met = Number.isFinite(x) && conditionMet(config, run, w, st, x);

    if (met) {
      st.count++;
    } else {
      st.count = 0;
      if (Number.isFinite(x)) {
        if (x > w.threshold) st.prevSide = 1;
        else if (x < w.threshold) st.prevSide = -1;
      }
    }
    st.prevValue = x;

    if (st.count >= Math.max(1, w.persistence_ticks)) {
      st.count = 0;
      if (w.oneShot) {
        st.fired = true;
      } else if (w.operator === 'RISES_ABOVE') {
        st.prevSide = 1;                              // must cross back down before it can re-fire
      } else if (w.operator === 'FALLS_BELOW') {
        st.prevSide = -1;
      }
      logEvent(config, run, {
        type: 'WATCH_FIRED', severity: 'INFO', source: 'PHASE_ENGINE', blockId: block.id,
        message: 'Watch ' + w.id + ' fired (' + w.operator + ' ' + w.signal + ')',
        detail: { watchId: w.id, signal: w.signal, value: x, threshold: w.threshold, action: w.action },
      });
      if (TERMINAL_ACTIONS.indexOf(w.action) >= 0) {
        if (terminalIdx < 0) terminalIdx = i;
      } else {
        applyWatchAction(config, run, w.action, w.actionParam, w.id);
      }
    }
  }

  if (terminalIdx >= 0) {
    const w = watches[terminalIdx];
    applyWatchAction(config, run, w.action, w.actionParam, w.id);
  }
}

/**
 * Apply one watch action (§5.4.4b).
 *
 * Terminal: END_BLOCK, GOTO_BLOCK, HOLD, PAUSE, RAISE_ALARM.
 * Non-terminal: MARK, START_FRACTIONATION, STOP_FRACTIONATION, SET_PCTB, SET_FLOW, OUTLET_TO,
 * EXTEND_BLOCK.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} action    one of the eleven action names
 * @param {*} param          the action's parameter, already canonical (mL/s for SET_FLOW, % for
 *                           SET_PCTB, a block id for GOTO_BLOCK, an alarm id for RAISE_ALARM,
 *                           duration-basis units for EXTEND_BLOCK)
 * @param {string} watchId   the firing watch, for the event record
 * @returns {void}
 */
export function applyWatchAction(config, run, action, param, watchId) {
  const block = currentBlock(config, run);
  switch (action) {
    case 'END_BLOCK':
      endBlock(config, run, 'WATCH');
      break;
    case 'GOTO_BLOCK': {
      const blocks = blocksOf(config);
      if (!blocks) return;
      let target = -1;
      for (let i = 0; i < blocks.length; i++) if (blocks[i].id === param) { target = i; break; }
      if (target < 0) return;
      if (target <= run.blockIndex) {
        const id = blocks[target].id;
        run.loopCount[id] = (run.loopCount[id] || 0) + 1;
        if (run.loopCount[id] > MAX_LOOPS) raiseAlarm(config, run, 'ALM-MTH-02', { blockId: id });
      }
      endBlock(config, run, 'GOTO');
      startBlock(config, run, target);
      break;
    }
    case 'HOLD':
      setRunState(config, run, 'HELD', 'watch ' + watchId);
      break;
    case 'PAUSE':
      setRunState(config, run, 'PAUSED', 'watch ' + watchId);
      break;
    case 'RAISE_ALARM':
      raiseAlarm(config, run, (typeof param === 'string' && param) ? param : 'ALM-MTH-01',
        { watchId });
      break;
    case 'MARK':
      logEvent(config, run, {
        type: 'NOTE', severity: 'INFO', source: 'PHASE_ENGINE', blockId: blockIdOf(config, run),
        message: 'Mark from watch ' + watchId,
        detail: { V_mL: run.V_tot_mL, t_s: run.t_s, param },
      });
      break;
    case 'START_FRACTIONATION': {
      let mode = (typeof param === 'string' && param) ? param : null;
      if (!mode) {
        mode = (block && block.fractionation && block.fractionation.mode !== 'OFF')
          ? block.fractionation.mode : 'PEAK';
      }
      run.frac.mode = mode;
      break;
    }
    case 'STOP_FRACTIONATION':
      if (run.frac.open) fractionator.closeFraction(config, run, 'OPERATOR');
      run.frac.mode = 'OFF';
      break;
    case 'SET_PCTB':
      run.pctB_set = clamp(Number(param) || 0, 0, 100);
      break;
    case 'SET_FLOW':
      run.Q_set_mLs = clamp(Number(param) || 0, 0, config.skid.Qmax_mLs);
      logEvent(config, run, {
        type: 'SETPOINT_CHANGE', severity: 'INFO', source: 'PHASE_ENGINE',
        blockId: blockIdOf(config, run), message: 'Flow setpoint from watch ' + watchId,
        detail: { Q_set_mLs: run.Q_set_mLs },
      });
      break;
    case 'OUTLET_TO':
      requestOutlet(config, run, param);
      break;
    case 'EXTEND_BLOCK': {
      if (!block) return;
      const n = run.extensionCount[block.id] || 0;
      if (n >= MAX_EXTENSIONS) return;
      run.extensionCount[block.id] = n + 1;
      const key = keysFor(block).ext;
      run.extensionCount[key] = (run.extensionCount[key] || 0) + (Number(param) || 0);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// the control tick
// ---------------------------------------------------------------------------------------------

/**
 * The 10 Hz supervisor tick — step 12 of `skid.physicsTick` (§3.3).
 *
 * Order, normative: 0) push ONE sample into every slope-ring lane (this is the ring's sole write),
 * a) `alarms.evaluateAlarms` and the run-state consequence its actions demand, b) `evaluateWatches`
 * when RUNNING, c) `advanceBlockClock`, d) `fractionator.tickFractionator`.
 *
 * @param {object} config
 * @param {object} run
 * @param {number} dtCtrl_s  `DT_PHYS * config.sim.ctrlEvery`, s
 * @returns {void}
 */
/**
 * Command a deferred column-valve move once the flow has fallen below the interlock gate.
 *
 * `startBlock` records the block's target position in `run.valves.cvPending` instead of commanding
 * it immediately, because at a block boundary the pumps are still at the previous block's flow and
 * `fluidics.requestColumnValve` would reject the move and raise ALM-CV-02. This retries, silently,
 * every control tick until the gate opens — the sequence a real skid follows.
 *
 * Requesting a position the valve already holds is a no-op in fluidics, so the common case (a
 * block that does not move the valve) clears on the first call with no interlock check at all.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @returns {void} clears `run.valves.cvPending` once the move is accepted
 */
export function serviceColumnValve(config, run) {
  const v = run.valves;
  const target = v.cvPending;
  if (target == null) return;
  if (v.cmdColumnValve === target) { v.cvPending = null; return; }
  // Same gate fluidics.requestColumnValve applies. Checking it here keeps a deferred move from
  // raising ALM-CV-02 once per control tick while the pumps coast down.
  const gate_mLs = config.skid.QswitchMax_frac * config.skid.Qmax_mLs;
  if (run.Q_actual_mLs > gate_mLs) return;
  if (requestColumnValve(config, run, target).ok) v.cvPending = null;
}

export function controlTick(config, run, dtCtrl_s) {
  pushSlopeSamples(config, run);
  serviceColumnValve(config, run);
  alarms.evaluateAlarms(config, run, dtCtrl_s);
  applyAlarmDemand(config, run);
  if (run.state === 'RUNNING') evaluateWatches(config, run, dtCtrl_s);
  advanceBlockClock(config, run, dtCtrl_s);
  fractionator.tickFractionator(config, run, dtCtrl_s);
}
