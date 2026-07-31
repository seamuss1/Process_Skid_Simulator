/**
 * src/skid/fluidics.js — pumps, gradient proportioner, all valves, tank draw/refill.
 * Everything that moves or gates fluid.  Layer L3 (architecture-v2 §4): imports core only.
 *
 * UNITS (§1.1, absolute): flow mL/s (`_mLs`), volume mL (`_mL`), time s (`_s`),
 * concentration mM (`_mM`), pressure bar (`_bar`), %B as 0..100 (`pctB*`).
 *
 * RNG (§5.9, definitive):
 *   - `pctBError` draws RNG_STREAMS.PUMP_WALK EXACTLY ONCE per tick, unconditionally.
 *     `updateProportioner` (tick step 2) calls it exactly once.  That is the only PUMP_WALK draw
 *     in the program.
 *   - `drawTanks` draws RNG_STREAMS.TANK EXACTLY ONCE per tick, unconditionally (tick step 4).
 *   - `updatePumps` draws NOTHING: the flow ripple is a deterministic phase accumulator (§7.4.3).
 *   - PUMP_BIAS is drawn once per run in core/state.js::createRunState, never here.
 *
 * ZERO ALLOCATION in the per-tick path (DoD 5).  `requestColumnValve`, `requestOutlet`,
 * `switchInlet` and `refillTank` return one of two MODULE-LEVEL SINGLETONS — read `reason`
 * immediately, never retain the object.  Those four are operator-rate, but the singleton keeps
 * the contract uniform.
 *
 * SHARED STRUCTURE `run.topo.inlet` (allocated by skid.js::createSkid, written here, read by
 * skid.js::advanceSegments / advanceAir).  It is the boundary condition of the suction cascade:
 *   { tankA, tankB, tankS : int  — index into config.tanks, -1 when the branch has no source
 *     airA, airB, airS   : 0..1  — gas volume fraction entering that branch (dip-tube slurp)
 *     runoutA_s, runoutB_s, runoutS_s : s — elapsed run-out time, drives the 2.0 s cross-fade }
 * `skid/fluidics.js` does not import `skid/skid.js` (that would be a cycle); it only reads and
 * writes the plain object hanging off `run`.
 */

import { clamp, RNG_STREAMS, nextGaussian } from '../core/util.js';
import { logEvent } from '../core/log.js';

// ---------------------------------------------------------------------------------------------
// Module-level result singletons (DoD 5).  OK_RESULT is frozen; FAIL_RESULT cannot be frozen
// because its `reason` is written immediately before every return — the contract's phrase
// "frozen singletons ... whose reason is set before return" is self-contradictory, and this is
// the reading that satisfies the stated behaviour (one object, no per-call allocation).
// ---------------------------------------------------------------------------------------------
const OK_RESULT = Object.freeze({ ok: true });
const FAIL_RESULT = { ok: false, reason: '' };

/** @param {string} reason @returns {{ok:boolean, reason:string}} the shared failure singleton */
function fail(reason) {
  FAIL_RESULT.reason = reason;
  return FAIL_RESULT;
}

/** The five column-valve positions, in ring order (§6.13). */
export const COLUMN_POSITIONS = ['BYPASS', 'DOWN', 'UP', 'ISOLATED', 'CIP_DETECTOR_BYPASS'];

// --- constants the contract does not pin, chosen here and documented -------------------------
/** s per position stepped by the multiposition column valve. 4 steps = 2.4 s < ALM-CV-03's 3.0 s
 *  persistence, so a legitimate transit can never latch the position-mismatch FAULT. */
const COLUMN_VALVE_STEP_S = 0.6;
/** s, hard cap on a column-valve transit. */
const COLUMN_VALVE_MAX_MOVE_S = 2.4;
/** s, the `VALVE_MOVE` suppression window of §5.6.1, applied on move completion. */
const VALVE_MOVE_SUPPRESS_S = 5.0;
/** s, the dip-tube slurp: inlet gas fraction ramps 0 -> 1 over this long once a tank reaches
 *  `emptyLevel_mL` (§6.13). This is what makes ALM-TNK-02 and ALM-AIR-01 fire at different times. */
const TANK_RUNOUT_S = 2.0;
/** AR(1) %B walk: correlation time and stationary standard deviation, in percentage points.
 *  PUMP_BIAS (§5.9) supplies the once-per-run N(0, 0.4) offset; this is the slow wander on top. */
const PCTB_WALK_TAU_S = 60.0;
const PCTB_WALK_SIGMA = 0.25;
/** s of continuous "below warn" before flow-reduction recovery starts (§6.13). */
const FLOW_REDUCTION_RECOVER_DELAY_S = 30.0;
/** s the `cvMoveUnderFlow` flag stays raised after a rejected move, for alarms.js to sample. */
const CV_MOVE_UNDER_FLOW_HOLD_S = 1.0;

const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------------------------
// Small allocation-free lookups
// ---------------------------------------------------------------------------------------------

/**
 * Resolve an inlet port name to an index into `config.tanks`.
 * @param {object} config frozen config
 * @param {string|null} port inlet port name ('A1'...'S3'), or null
 * @returns {number} index into config.tanks, or -1 when unassigned/unknown
 */
function tankIndexOfPort(config, port) {
  if (port === null || port === undefined) return -1;
  const asg = config.inletAssignments;
  if (!asg) return -1;
  const id = asg[port];
  if (!id) return -1;
  return tankIndexOfId(config, id);
}

/**
 * Resolve a tank id to an index into `config.tanks`.
 * @param {object} config frozen config
 * @param {string} id tank id, e.g. 'TK-EQ'
 * @returns {number} index, or -1
 */
function tankIndexOfId(config, id) {
  const tanks = config.tanks;
  if (!tanks) return -1;
  for (let k = 0; k < tanks.length; k++) if (tanks[k].id === id) return k;
  return -1;
}

// ---------------------------------------------------------------------------------------------
// 1. PUMPS
// ---------------------------------------------------------------------------------------------

/**
 * Tick step 1. Ramp the delivered flow toward `min(Q_set, Q_limit)` at `rampRate_mLs2`, apply the
 * deterministic twin-piston ripple, and split off the sample-pump flow.
 *
 * `run.Q_actual_mLs` is the DELIVERED flow including the +/-`rippleFlow_frac` ripple, and it is
 * what every totaliser integrates — never `Q_set` (§6.13). The ramp state is carried in
 * `Q_actual_mLs` itself: because the ramp step (rampRate*dt) exceeds the ripple amplitude at every
 * flow the pilot skid can reach, the loop settles on exactly `target*(1+r)` and no extra run field
 * is needed.
 *
 * Sample split (documented reading — the contract fixes only `QA=(1-x)Q, QB=xQ`):
 *   - `DIRECT` / `LOOP_INJECT`  -> the sample pump carries the whole column flow: QS = Q_actual,
 *     buffer flow 0. The stream joins the gradient path at the injection tee (segment G6).
 *   - `LOOP_FILL`              -> the sample pump fills the loop off-line at Q_actual while the
 *     buffer pumps keep feeding the column; nothing reaches the injection tee.
 *   - `null`                   -> QS = 0.
 *
 * DRAWS NO RNG.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {void}
 */
export function updatePumps(config, run, dt_s) {
  const sk = config.skid;
  const st = run.state;

  let target = run.Q_set_mLs;
  if (!(target > 0)) target = 0;
  const lim = run.Q_limit_mLs;
  if (Number.isFinite(lim) && lim < target) target = lim;
  // STATE_TABLE (§5.5): ZERO in IDLE/READY/ENDED, RAMP_ZERO in PAUSED, ZERO_NOW in FAULT.
  if (st === 'IDLE' || st === 'READY' || st === 'ENDED' || st === 'PAUSED' || st === 'FAULT') {
    target = 0;
  }
  target = clamp(target, 0, sk.Qmax_mLs);

  let base = run.Q_actual_mLs;
  if (!Number.isFinite(base) || base < 0) base = 0;
  if (st === 'FAULT') {
    base = 0;                                   // no ramp: FAULT drops flow immediately (§5.5)
  } else {
    const step = Math.max(sk.rampRate_mLs2, 0) * dt_s;
    if (base < target) base = Math.min(target, base + step);
    else if (base > target) base = Math.max(target, base - step);
  }

  run.Q_actual_mLs = base;                      // mean flow, so flowRipple sees the right frequency
  const r = flowRipple(config, run, dt_s);      // advances run.ripplePhase_rad; draws no RNG
  run.Q_actual_mLs = base > 0 ? base * (1 + r) : 0;

  // ---- sample pump ---------------------------------------------------------------------------
  const mode = run.valves.sampleMode;
  const running = (mode === 'DIRECT' || mode === 'LOOP_INJECT' || mode === 'LOOP_FILL');
  run.QS_mLs = running ? run.Q_actual_mLs : 0;
  if (mode === 'LOOP_FILL') run.valves.loopFilled_mL += run.QS_mLs * dt_s;
}

/**
 * The twin-piston flow ripple (§7.4.3). Advances the phase accumulator by `dt_s` and returns the
 * ripple at the NEW phase. `f_Hz = 2*Q_mLs/Vstroke_mL`; integrating the waveform at 20 Hz would
 * alias, so the phase is accumulated and the value sampled analytically.
 *
 * Called EXACTLY ONCE per tick, from `updatePumps`. `skid/sensors.js` reads `run.ripplePhase_rad`
 * directly for the +/-`ripplePress_frac` pressure ripple and must not call this.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state (writes run.ripplePhase_rad, rad)
 * @param {number} dt_s timestep, s
 * @returns {number} fractional flow ripple, dimensionless, +/-config.skid.rippleFlow_frac
 */
export function flowRipple(config, run, dt_s) {
  const sk = config.skid;
  const f_Hz = 2 * Math.abs(run.Q_actual_mLs) / Math.max(sk.Vstroke_mL, 1e-9);
  let ph = run.ripplePhase_rad + TWO_PI * f_Hz * dt_s;
  if (!Number.isFinite(ph)) ph = 0;
  if (ph >= TWO_PI || ph < 0) ph -= TWO_PI * Math.floor(ph / TWO_PI);
  run.ripplePhase_rad = ph;
  return sk.rippleFlow_frac * Math.sin(ph);
}

/**
 * The proportioner's %B error: the once-per-run bias plus a slow AR(1) random walk.
 * DRAWS RNG_STREAMS.PUMP_WALK EXACTLY ONCE, UNCONDITIONALLY, on every call — and it is called
 * exactly once per tick, from `updateProportioner`. This is the only PUMP_WALK draw in the
 * program (§5.9, §6.13).
 *
 * @param {object} config frozen config (unused; kept per the signature contract, DoD 1)
 * @param {object} run mutable run state (writes run.walkPctB, percentage points)
 * @param {number} dt_s timestep, s
 * @returns {number} %B error in PERCENTAGE POINTS (0..100 scale), may be negative
 */
export function pctBError(config, run, dt_s) {
  const stream = run.rng ? run.rng.streams[RNG_STREAMS.PUMP_WALK] : null;
  const g = stream ? nextGaussian(stream) : 0;          // ALWAYS drawn, even if discarded
  const a = Math.exp(-dt_s / PCTB_WALK_TAU_S);
  const w = a * run.walkPctB + Math.sqrt(Math.max(0, 1 - a * a)) * PCTB_WALK_SIGMA * g;
  run.walkPctB = w;
  return run.biasPctB + w;
}

/**
 * Tick step 2. Blend the two buffer streams into `run.yTee_mM` and publish `run.pctB_actual`.
 *
 * HPGF: `QA = (1-x)Q_buf`, `QB = x*Q_buf`, and the tee is their flow-weighted blend of the two
 * suction-branch outlets `run.yPumpA_mM` / `run.yPumpB_mM` (written by skid.advanceSegments).
 *
 * LPGF: the duty is quantised to `tMinOpen_s/chopPeriod_s`; the tee composition is the EXACT
 * time-average of the chopped stream (`(1-x_q)*yA + x_q*yB`) and the chop ripple of §7.4.2 is
 * ADDED ANALYTICALLY to `run.pctB_actual` at the sample instant. The square wave is never
 * integrated: the duty quantum is 40 ms against a 50 ms tick, so sampling it would alias and move
 * the MEAN delivered %B by up to 2.5 percentage points. The mixer chamber (segment G2) then
 * supplies the physical hold-up, and `atten` in the analytic term is that same first-order
 * attenuation evaluated at the chop frequency.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state (writes run.yTee_mM mM, QA/QB_mLs, pctB_actual %, chopPhase_s s)
 * @param {number} dt_s timestep, s
 * @returns {void}
 */
export function updateProportioner(config, run, dt_s) {
  const sk = config.skid;
  const ns = config.ns;
  const err = pctBError(config, run, dt_s);      // exactly one PUMP_WALK draw per tick

  const mode = run.valves.sampleMode;
  const sampleLive = (mode === 'DIRECT' || mode === 'LOOP_INJECT');
  const Qbuf = sampleLive ? 0 : run.Q_actual_mLs;

  // The bias + walk perturb an ACTIVE proportioner only. At a commanded 0 %B or 100 %B the
  // corresponding pump is commanded off and stays off — a closed valve does not leak. Without
  // this guard an isocratic 0 %B block silently draws buffer B, and the tank inventory then
  // fails to tie against the volume totaliser.
  const xSet = clamp(run.pctB_set / 100, 0, 1);
  const xCmd = (xSet <= 0 || xSet >= 1) ? xSet : clamp(xSet + err / 100, 0, 1);
  let x = xCmd;

  if (sk.gradientMode === 'LPGF') {
    const Tc = Math.max(sk.chopPeriod_s, 1e-6);
    const tMin = Math.max(sk.tMinOpen_s, 1e-9);
    const nQ = Math.max(1, Math.round(Tc / tMin));          // 2.0 s / 0.040 s = 50 quanta
    x = clamp(Math.round(xCmd * nQ) / nQ, 0, 1);

    let ph = run.chopPhase_s + dt_s;
    if (ph >= Tc) ph -= Tc * Math.floor(ph / Tc);
    run.chopPhase_s = ph;

    const Q = Math.max(Math.abs(run.Q_actual_mLs), 1e-9);
    const tauMix_s = Math.max(sk.mixerVolume_mL, 0) / Q;
    const wt = TWO_PI * (1 / Tc) * tauMix_s;
    const atten = 1 / Math.sqrt(1 + wt * wt);
    const ripplePk = (4 / Math.PI) * Math.min(x, 1 - x) * atten;   // %B amplitude, fraction
    const sq = (ph / Tc) < 0.5 ? 1 : -1;                            // zero-mean square wave
    run.pctB_actual = clamp(100 * x + 100 * ripplePk * sq, 0, 100);
  } else {
    run.pctB_actual = 100 * x;
  }

  run.QA_mLs = Qbuf * (1 - x);
  run.QB_mLs = Qbuf * x;

  const yA = run.yPumpA_mM, yB = run.yPumpB_mM, yT = run.yTee_mM;
  for (let i = 0; i < ns; i++) yT[i] = (1 - x) * yA[i] + x * yB[i];
}

/**
 * Alarm-driven flow reduction (§6.13). `Q_limit *= (1 - 0.5*dtCtrl_s)` while active, floored at
 * `0.05*Qmax`; recovery is `+5 %/s` once the condition has been clear for 30 s.
 * Called from skid/alarms.js at control rate, never per physics tick.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state (writes run.Q_limit_mLs mL/s and run.flowReduction)
 * @param {number} dtCtrl_s control-tick period, s
 * @param {boolean} active true while a REDUCE_FLOW alarm is asserted
 * @returns {void}
 */
export function applyFlowReduction(config, run, dtCtrl_s, active) {
  const sk = config.skid;
  const Qmax = sk.Qmax_mLs;
  const floor_mLs = 0.05 * Qmax;
  const fr = run.flowReduction;
  let cur = run.Q_limit_mLs;
  if (!Number.isFinite(cur)) cur = Qmax;

  if (active) {
    if (!fr.active) {
      fr.active = true;
      fr.since_s = run.t_s;
      logEvent(config, run, {
        type: 'FLOW_REDUCTION_START', severity: 'WARN', source: 'ALARM', blockId: null,
        message: 'Flow reduction engaged', detail: { Q_limit_mLs: cur },
      });
    }
    fr.recoverSince_s = -1;
    run.Q_limit_mLs = Math.max(floor_mLs, cur * (1 - 0.5 * dtCtrl_s));
    return;
  }

  if (!fr.active) return;
  if (fr.recoverSince_s < 0) fr.recoverSince_s = run.t_s;
  if (run.t_s - fr.recoverSince_s < FLOW_REDUCTION_RECOVER_DELAY_S) return;

  const next = cur * (1 + 0.05 * dtCtrl_s);
  if (next >= Qmax) {
    run.Q_limit_mLs = Infinity;
    fr.active = false;
    fr.recoverSince_s = -1;
    logEvent(config, run, {
      type: 'FLOW_REDUCTION_END', severity: 'INFO', source: 'ALARM', blockId: null,
      message: 'Flow reduction cleared', detail: null,
    });
  } else {
    run.Q_limit_mLs = next;
  }
}

// ---------------------------------------------------------------------------------------------
// 2. VALVES
// ---------------------------------------------------------------------------------------------

/**
 * Request a column-valve position. Rejected unless `Q_actual <= QswitchMax_frac*Qmax` (or the
 * pumps are stopped); a rejection raises ALM-CV-02 by setting `run.valves.cvMoveUnderFlow` for
 * skid/alarms.js to sample, logs the attempt, and returns `{ok:false, reason}`.
 *
 * On acceptance the valve enters transit: `run.valves.columnValve` reads `'ISOLATED'` for the
 * duration (a multiposition valve isolates while rotating), `cmdColumnValve` holds the target and
 * `moveRemaining_s` counts down at `COLUMN_VALVE_STEP_S` per position stepped.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {string} pos one of COLUMN_POSITIONS
 * @returns {{ok:boolean, reason?:string}} a MODULE-LEVEL SINGLETON — read `reason` immediately
 */
export function requestColumnValve(config, run, pos) {
  const v = run.valves;
  const to = COLUMN_POSITIONS.indexOf(pos);
  if (to < 0) return fail('unknown column valve position: ' + pos);
  if (v.cmdColumnValve === pos && v.columnValve === pos && v.moveRemaining_s <= 0) return OK_RESULT;

  const sk = config.skid;
  const gate_mLs = sk.QswitchMax_frac * sk.Qmax_mLs;
  if (run.Q_actual_mLs > gate_mLs) {
    v.cvMoveUnderFlow = true;
    v.cvMoveUnderFlow_s = CV_MOVE_UNDER_FLOW_HOLD_S;
    logEvent(config, run, {
      type: 'VALVE_CHANGE', severity: 'ALARM', source: 'SYSTEM', blockId: null,
      message: 'Column valve move to ' + pos + ' rejected: flow too high',
      detail: { requested: pos, Q_mLs: run.Q_actual_mLs, limit_mLs: gate_mLs, alarm: 'ALM-CV-02' },
    });
    return fail('column valve move requires Q_actual <= ' + gate_mLs + ' mL/s (ALM-CV-02)');
  }

  const from = COLUMN_POSITIONS.indexOf(v.columnValve);
  const steps = from < 0 ? 1 : Math.max(1, Math.abs(to - from));
  v.cmdColumnValve = pos;
  v.moveRemaining_s = Math.min(COLUMN_VALVE_MAX_MOVE_S, COLUMN_VALVE_STEP_S * steps);
  v.columnValve = 'ISOLATED';
  logEvent(config, run, {
    type: 'VALVE_CHANGE', severity: 'INFO', source: 'SYSTEM', blockId: null,
    message: 'Column valve moving to ' + pos,
    detail: { to: pos, transit_s: v.moveRemaining_s },
  });
  return OK_RESULT;
}

/**
 * Tick step 3. Advance the column-valve transit timer, maintain the position-feedback mismatch
 * counter that ALM-CV-03 reads, apply the `VALVE_MOVE` suppression window on completion (§5.6.1),
 * and run the fraction-valve cross-fade timer.
 *
 * Runs BEFORE `drawTanks` so the inlet vector is never sampled against a stale valve position
 * (§3.3).
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s timestep, s
 * @returns {void}
 */
export function updateValves(config, run, dt_s) {
  const v = run.valves;
  const sk = config.skid;

  if (v.moveRemaining_s > 0) {
    v.moveRemaining_s -= dt_s;
    if (v.moveRemaining_s <= 0) {
      v.moveRemaining_s = 0;
      v.columnValve = v.cmdColumnValve;
      const alarms = config.alarms;
      const sup = run.alarmSuppressUntil_s;
      if (alarms && sup) {
        for (let k = 0; k < alarms.length; k++) {
          const sw = alarms[k].suppressWhen;
          if (sw && sw.indexOf('VALVE_MOVE') >= 0) sup[k] = run.t_s + VALVE_MOVE_SUPPRESS_S;
        }
      }
      logEvent(config, run, {
        type: 'VALVE_CHANGE', severity: 'INFO', source: 'SYSTEM', blockId: null,
        message: 'Column valve in position: ' + v.columnValve, detail: { position: v.columnValve },
      });
    } else {
      v.columnValve = 'ISOLATED';
    }
  }

  v.mismatch_s = (v.columnValve === v.cmdColumnValve) ? 0 : v.mismatch_s + dt_s;

  if (v.cvMoveUnderFlow_s > 0) {
    v.cvMoveUnderFlow_s -= dt_s;
    if (v.cvMoveUnderFlow_s <= 0) { v.cvMoveUnderFlow_s = 0; v.cvMoveUnderFlow = false; }
  }

  const fr = run.frac;
  if (fr && fr.moving) {
    fr.moveElapsed_s += dt_s;
    const tSwitch_s = sk.fracValve.tSwitch_s;
    if (fr.moveElapsed_s >= tSwitch_s) {
      fr.moveElapsed_s = tSwitch_s;
      fr.moving = false;
      v.outletValve = fr.port;
    }
  }
}

/**
 * The SKID-SIDE copy of the column-valve -> flow-sign table (§3.4, §6.13).
 * `physics/bed.js` may not import this module, so it recomputes these identical three lines
 * inline. If this table ever changes, both change.
 *
 * @param {object} run run state
 * @returns {1|-1|0} +1 DOWN, -1 UP, 0 for BYPASS | ISOLATED | CIP_DETECTOR_BYPASS
 */
export function columnFlowSign(run) {
  const v = run.valves.columnValve;
  return (v === 'DOWN') ? 1 : (v === 'UP') ? -1 : 0;
}

/**
 * Are the UV / conductivity / pH detectors in the flow path?
 * @param {object} run run state
 * @returns {boolean} false only in CIP_DETECTOR_BYPASS
 */
export function detectorsInPath(run) {
  return run.valves.columnValve !== 'CIP_DETECTOR_BYPASS';
}

/**
 * Command the outlet (fraction) valve to a port or to waste. Starts the `tSwitch_s` cross-fade;
 * `updateValves` completes it and writes `run.valves.outletValve`.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {string} port a member of config.skid.fracValve.ports, or 'WASTE'
 * @returns {{ok:boolean, reason?:string}} a MODULE-LEVEL SINGLETON — read `reason` immediately
 */
export function requestOutlet(config, run, port) {
  const ports = config.skid.fracValve.ports;
  if (port !== 'WASTE' && ports.indexOf(port) < 0) return fail('unknown outlet port: ' + port);
  const fr = run.frac;
  if (run.valves.outletValve === port && !(fr && fr.moving)) return OK_RESULT;
  if (fr) {
    fr.moveFrom = run.valves.outletValve;
    fr.moveStart_mL = run.V_tot_mL;
    fr.moveElapsed_s = 0;
    fr.moving = true;
    fr.port = port;                      // the COMMANDED port; updateValves latches it on arrival
  } else {
    run.valves.outletValve = port;
  }
  logEvent(config, run, {
    type: 'VALVE_CHANGE', severity: 'INFO', source: 'SYSTEM', blockId: null,
    message: 'Outlet valve to ' + port, detail: { to: port },
  });
  return OK_RESULT;
}

/**
 * Select the tank feeding one of the three inlet sides.
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {'A'|'B'|'S'} side inlet side
 * @param {string|null} port port name ('A1'...'S3'); null is legal for side 'S' only
 * @returns {{ok:boolean, reason?:string}} a MODULE-LEVEL SINGLETON — read `reason` immediately
 */
export function switchInlet(config, run, side, port) {
  if (side !== 'A' && side !== 'B' && side !== 'S') return fail('unknown inlet side: ' + side);
  const key = side === 'A' ? 'inletA' : side === 'B' ? 'inletB' : 'inletS';
  if (port === null || port === undefined) {
    if (side !== 'S') return fail('inlet side ' + side + ' cannot be deselected');
    if (run.valves[key] === null) return OK_RESULT;
    run.valves[key] = null;
    logEvent(config, run, {
      type: 'INLET_CHANGE', severity: 'INFO', source: 'SYSTEM', blockId: null,
      message: 'Sample inlet deselected', detail: { side: side, port: null },
    });
    return OK_RESULT;
  }
  const asg = config.inletAssignments;
  if (!asg || !(port in asg)) return fail('unknown inlet port: ' + port);
  if (port.charAt(0) !== side) return fail('port ' + port + ' does not belong to inlet side ' + side);
  if (!asg[port]) return fail('inlet port ' + port + ' has no tank assigned');
  if (run.valves[key] === port) return OK_RESULT;
  run.valves[key] = port;
  logEvent(config, run, {
    type: 'INLET_CHANGE', severity: 'INFO', source: 'SYSTEM', blockId: null,
    message: 'Inlet ' + side + ' -> ' + port + ' (' + asg[port] + ')',
    detail: { side: side, port: port, tankId: asg[port] },
  });
  return OK_RESULT;
}

// ---------------------------------------------------------------------------------------------
// 3. TANKS
// ---------------------------------------------------------------------------------------------

/**
 * Draw one branch's volume out of its source tank and update the run-out cross-fade.
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {number} tankIdx index into config.tanks, or -1
 * @param {number} Q_mLs branch flow, mL/s (magnitude taken)
 * @param {number} dt_s timestep, s
 * @param {number} g one N(0,1) sample, shared by all three branches (fixed draw count, §5.9)
 * @param {object|null} inlet run.topo.inlet, or null before createSkid
 * @param {string} keyAir field name on `inlet` for the gas fraction
 * @param {string} keyRunout field name on `inlet` for the run-out timer, s
 * @returns {void}
 */
function drawBranch(config, run, tankIdx, Q_mLs, dt_s, g, inlet, keyAir, keyRunout) {
  if (tankIdx < 0) {
    if (inlet) { inlet[keyAir] = 0; inlet[keyRunout] = 0; }
    return;
  }
  const dV_mL = Math.abs(Q_mLs) * dt_s;
  let level_mL = run.tankVolume_mL[tankIdx] - dV_mL;
  if (!(level_mL > 0)) level_mL = 0;
  run.tankVolume_mL[tankIdx] = level_mL;
  if (!inlet) return;

  const empty_mL = config.tanks[tankIdx].emptyLevel_mL || 0;
  let t_s = inlet[keyRunout];
  if (level_mL <= empty_mL) t_s = Math.min(TANK_RUNOUT_S, t_s + dt_s);
  else t_s = 0;
  inlet[keyRunout] = t_s;

  let f = t_s / TANK_RUNOUT_S;                 // 0 -> 1 dip-tube slurp over 2.0 s
  if (f > 0 && f < 1) f = clamp(f + 0.05 * g * f * (1 - f), 0, 1);   // deterministic slurp jitter
  inlet[keyAir] = f;
}

/**
 * Tick step 4. Decrement every selected SOURCE tank by `|Q_branch| * dt`, and once a tank reaches
 * `emptyLevel_mL` cross-fade that branch's inlet gas fraction from 0 to 1 over 2.0 s — the
 * dip-tube slurp that makes ALM-TNK-02 and ALM-AIR-01 fire at deliberately different times.
 *
 * OWNERSHIP NOTE: §6.12 lists `run.tankVolume_mL` under `updateTotalisers`, but §6.13 and the
 * manifest both state explicitly that `drawTanks` decrements the source tanks, and the run-out
 * cross-fade needs the level it just wrote. The decrement therefore lives here; `refillTank` is
 * the only other writer. `skid.js::updateTotalisers` owns waste, ports, volumes and mass.
 *
 * DRAWS RNG_STREAMS.TANK EXACTLY ONCE, UNCONDITIONALLY.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state (writes run.tankVolume_mL mL and run.topo.inlet)
 * @param {number} dt_s timestep, s
 * @returns {void}
 */
export function drawTanks(config, run, dt_s) {
  const stream = run.rng ? run.rng.streams[RNG_STREAMS.TANK] : null;
  const g = stream ? nextGaussian(stream) : 0;        // ALWAYS drawn — one per tick, no branches

  const inlet = run.topo ? run.topo.inlet : null;
  const v = run.valves;
  const iA = tankIndexOfPort(config, v.inletA);
  const iB = tankIndexOfPort(config, v.inletB);
  const iS = tankIndexOfPort(config, v.inletS);
  if (inlet) { inlet.tankA = iA; inlet.tankB = iB; inlet.tankS = iS; }

  drawBranch(config, run, iA, run.QA_mLs, dt_s, g, inlet, 'airA', 'runoutA_s');
  drawBranch(config, run, iB, run.QB_mLs, dt_s, g, inlet, 'airB', 'runoutB_s');
  drawBranch(config, run, iS, run.QS_mLs, dt_s, g, inlet, 'airS', 'runoutS_s');
}

/**
 * Operator refill of a source tank, capped at its nominal volume.
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {string} tankId id of a config.tanks entry
 * @param {number} volume_mL volume to add, mL (> 0)
 * @returns {{ok:boolean, reason?:string}} a MODULE-LEVEL SINGLETON — read `reason` immediately
 */
export function refillTank(config, run, tankId, volume_mL) {
  const k = tankIndexOfId(config, tankId);
  if (k < 0) return fail('unknown tank: ' + tankId);
  if (!(volume_mL > 0)) return fail('refill volume must be > 0 mL');
  const nominal_mL = config.tanks[k].nominalVolume_mL;
  const before_mL = run.tankVolume_mL[k];
  const after_mL = Math.min(nominal_mL, before_mL + volume_mL);
  run.tankVolume_mL[k] = after_mL;
  logEvent(config, run, {
    type: 'TANK_REFILL', severity: 'INFO', source: 'OPERATOR', blockId: null,
    message: 'Refilled ' + tankId + ' to ' + after_mL.toFixed(1) + ' mL',
    detail: { tankId: tankId, added_mL: after_mL - before_mL, level_mL: after_mL },
  });
  return OK_RESULT;
}

/**
 * How much more each tank must still supply for the remainder of the method.
 *
 * Takes a PRECOMPUTED demand object so this module never imports `skid/method.js` (§4). Blocks
 * before `run.blockIndex` are already spent; the current block is credited with the volume it has
 * already delivered (`run.V_block_mL`). Within a block the volume is attributed to the A and B
 * inlets by the block's mean %B, or entirely to the sample inlet when the block applies sample.
 *
 * Operator-rate only — it allocates.
 *
 * @param {object} config frozen config
 * @param {object} run run state
 * @param {{perTank:object, perBlock:Array<{id:string, volume_mL:number, time_s:number}>}} demand
 *        the product of `method.methodDemand(config, method)`
 * @returns {{[tankId:string]: number}} remaining demand per tank id, mL
 */
export function remainingDemand_mL(config, run, demand) {
  const out = {};
  if (!demand) return out;
  const perTank = demand.perTank || {};
  for (const id in perTank) out[id] = 0;

  const volById = new Map();
  const perBlock = demand.perBlock || [];
  for (let k = 0; k < perBlock.length; k++) volById.set(perBlock[k].id, perBlock[k].volume_mL);

  const method = config.method;
  const blocks = (method && method.blocks) ? method.blocks : [];
  const asg = config.inletAssignments || {};

  const add = (port, mL) => {
    const id = port ? asg[port] : null;
    if (!id || !(mL > 0)) return;
    out[id] = (out[id] || 0) + mL;
  };

  for (let j = Math.max(0, run.blockIndex | 0); j < blocks.length; j++) {
    const b = blocks[j];
    if (!b || b.enabled === false) continue;
    let vol_mL = volById.has(b.id) ? volById.get(b.id) : 0;
    if (j === run.blockIndex) vol_mL = Math.max(0, vol_mL - run.V_block_mL);
    if (!(vol_mL > 0)) continue;

    const smp = b.sample;
    if (smp && smp.mode) { add(b.inlets ? b.inlets.sample : null, vol_mL); continue; }

    const gr = b.gradient || {};
    const shape = gr.shape || 'ISOCRATIC';
    let meanPctB;
    if (shape === 'LINEAR' || shape === 'CONVEX' || shape === 'CONCAVE' || shape === 'MULTI_SEGMENT') {
      meanPctB = 0.5 * ((gr.startPctB || 0) + (gr.endPctB || 0));
    } else if (shape === 'STEP') {
      meanPctB = gr.endPctB || 0;
    } else {
      meanPctB = gr.startPctB || 0;
    }
    const xB = clamp(meanPctB / 100, 0, 1);
    const inl = b.inlets || {};
    add(inl.a, vol_mL * (1 - xB));
    add(inl.b, vol_mL * xB);
  }

  for (const id in out) {
    const need = perTank[id];
    if (Number.isFinite(need)) out[id] = Math.min(out[id], need);
  }
  return out;
}

/**
 * Time until a tank reaches its `emptyLevel_mL` at the CURRENT draw rate.
 * @param {object} config frozen config
 * @param {object} run run state
 * @param {string} tankId id of a config.tanks entry
 * @returns {number} seconds; Infinity when the tank is not being drawn; NaN for an unknown tank
 */
export function timeToEmpty_s(config, run, tankId) {
  const k = tankIndexOfId(config, tankId);
  if (k < 0) return NaN;
  const v = run.valves;
  let q_mLs = 0;
  if (tankIndexOfPort(config, v.inletA) === k) q_mLs += Math.abs(run.QA_mLs);
  if (tankIndexOfPort(config, v.inletB) === k) q_mLs += Math.abs(run.QB_mLs);
  if (tankIndexOfPort(config, v.inletS) === k) q_mLs += Math.abs(run.QS_mLs);
  if (q_mLs <= 1e-12) return Infinity;
  const usable_mL = run.tankVolume_mL[k] - (config.tanks[k].emptyLevel_mL || 0);
  return usable_mL <= 0 ? 0 : usable_mL / q_mLs;
}
