/**
 * src/skid/fractionator.js — peak-based and fixed-volume fractionation, the volume-keyed execution
 * queue, the valve cross-fade, the dead leg and the fraction record.
 *
 * Owner: `skid-method`. Contract §5.4.5, §5.11.2, §6.17, §7.4.4.
 *
 * THE DELAY IS THE WHOLE POINT. A decision taken from the UV signal at `V_tot = V_d` is not
 * executed: it is pushed onto a queue keyed on `V_exec_mL = V_d + holdup.VuvToFracValve_mL` and
 * executed when `run.V_tot_mL + run.Q_actual_mLs * fracValve.tSwitch_s >= V_exec_mL`, with the lead
 * term re-evaluated every tick from the CURRENT flow — which is what keeps the cut correct through a
 * ramp (the pilot's 50.25 mL is 15.4 s at 196.35 mL/min and 7.7 s at 392.7 mL/min).
 *
 * Two planes, and they are never mixed:
 *   DETECTOR plane — `startVolume_mL` / `endVolume_mL`, the window of material the decisions meant.
 *   VALVE plane    — `startVolumeValve_mL` / `endVolumeValve_mL`, where the valve actually moved.
 * `offsetError_mL = VuvToFracValve_mL − (valvePlaneStart − detectorPlaneStart)`, so it is 0 under
 * `COMPENSATED` and the full hold-up under `UNCOMPENSATED` — the classic error, made visible.
 *
 * Layer L4. Imports `core/util.js`, `core/log.js`, `skid/sensors.js`, `skid/fluidics.js` (§4). It
 * may not import `skid/engine.js`, so the OLS slope over `run.slopeRing` is recomputed here; the
 * ring's SOLE writer is `engine.controlTick` and this file only ever reads it.
 */

import { logEvent } from '../core/log.js';
import { sensorSignal, sensorQuality } from './sensors.js';
import { requestOutlet } from './fluidics.js';

/** `run.slopeRing` capacity — must match `core/state.js` (§2.2). */
const RING_LEN = 64;

/** Minimum samples for an OLS slope (§5.4.4c rule 6). */
const MIN_SLOPE_SAMPLES = 8;

/** Half-width of the peak-max search window, in CV (§6.17). */
const PEAK_MAX_HALFWINDOW_CV = 0.02;

/** Quality ranks for the "worst seen while open" downgrade (§5.3). */
const QUALITY_RANK = { OK: 0, SUSPECT: 1, BYPASSED: 2, INVALID: 3 };
const QUALITY_NAME = ['OK', 'SUSPECT', 'BYPASSED', 'INVALID'];

/**
 * Derived per-run scratch that §2.2 does not allocate, added once on the first tick.
 * `run.frac` is owned by this module, so extending it is legal; nothing else reads these fields.
 *   acc / accClosed — the DETECTOR-plane statistics accumulator for the window under decision, and
 *                     the one already closed by a stop decision but not yet executed at the valve.
 */
function ensureScratch(f) {
  if (f.seq !== undefined) return;
  f.seq = 0;
  f.startCount = 0;
  f.stopCount = 0;
  f.divertRemaining_mL = 0;
  f.prevPort = 'WASTE';
  f.execV_mL = NaN;        // the V_exec_mL of the queue event being executed, if any
  f.acc = newAcc();
  f.accClosed = newAcc();
}

function newAcc() {
  return { active: false, pending: false, V0_mL: 0, V1_mL: 0, prevV_mL: 0, n: 0,
    uvStart_AUcm: NaN, uvEnd_AUcm: NaN, uvMax_AUcm: -Infinity, area_AUcm_mL: 0,
    condSum: 0, phSum: 0, qualityRank: 0, containsPeakMax: false };
}

function openAcc(acc, V_mL) {
  acc.active = true;
  acc.V0_mL = V_mL; acc.V1_mL = V_mL; acc.prevV_mL = V_mL; acc.n = 0;
  acc.uvStart_AUcm = NaN; acc.uvEnd_AUcm = NaN; acc.uvMax_AUcm = -Infinity;
  acc.area_AUcm_mL = 0; acc.condSum = 0; acc.phSum = 0; acc.qualityRank = 0;
  acc.containsPeakMax = false;
}

function copyAcc(src, dst) {
  dst.active = false;
  dst.pending = true;                            // a closed window waiting for its valve event
  dst.V0_mL = src.V0_mL; dst.V1_mL = src.V1_mL; dst.prevV_mL = src.prevV_mL; dst.n = src.n;
  dst.uvStart_AUcm = src.uvStart_AUcm; dst.uvEnd_AUcm = src.uvEnd_AUcm;
  dst.uvMax_AUcm = src.uvMax_AUcm; dst.area_AUcm_mL = src.area_AUcm_mL;
  dst.condSum = src.condSum; dst.phSum = src.phSum; dst.qualityRank = src.qualityRank;
  dst.containsPeakMax = src.containsPeakMax;
}

/** The fractionation parameters of the block the engine is running, or null. */
function currentFractionation(config, run) {
  const m = config.method;
  if (!m || !Array.isArray(m.blocks)) return null;
  const b = m.blocks[run.blockIndex];
  return b ? b.fractionation : null;
}

function currentBlock(config, run) {
  const m = config.method;
  if (!m || !Array.isArray(m.blocks)) return null;
  return m.blocks[run.blockIndex] || null;
}

/** Read the fractionation signal without parsing a string on the hot path (§5.2). */
function readSignal(config, run, fr) {
  const r = fr.signalResolved;
  if (r && r.base === 'TANK_LEVEL') return (r.tankIdx >= 0) ? run.tankVolume_mL[r.tankIdx] : NaN;
  return sensorSignal(config, run, r ? r.base : fr.signal);
}

/** `{basis, value}` to millilitres, on the block's own volume basis. */
function span_mL(config, run, span) {
  if (!span) return NaN;
  const v = span.value;
  switch (span.basis) {
    case 'CV': return v * config.column.V_mL;
    case 'mL': return v;
    case 'min': return v * 60 * run.Q_actual_mLs;
    case 's': return v * run.Q_actual_mLs;
    default: return v;
  }
}

/**
 * OLS d(signal)/dV over one lane of `run.slopeRing`, in signal units per mL.
 * The read-only twin of `engine.signalSlope`; the fractionator may not import the engine (§4).
 * Volumes are shifted by the newest sample before the fit, so the normal equations never lose
 * precision against a 70 000 mL totaliser.
 */
function slopeOnRing(run, signalName, windowVolume_mL) {
  const ring = run.slopeRing;
  const sig = ring.signalIds.indexOf(signalName);
  if (sig < 0 || ring.n < MIN_SLOPE_SAMPLES) return NaN;
  const base = sig * RING_LEN;
  const x0 = ring.V_mL[ring.head];
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < ring.n; i++) {
    const slot = (ring.head - i + RING_LEN * 2) % RING_LEN;
    const dx = ring.V_mL[slot] - x0;
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

// ---------------------------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------------------------

/**
 * Push a fractionation decision onto the volume-keyed execution queue (§5.4.5).
 *
 * `COMPENSATED` keys the event on `run.V_tot_mL + holdup.VuvToFracValve_mL`; `UNCOMPENSATED` keys it
 * on `run.V_tot_mL` (immediate, and every resulting fraction carries the full `offsetError_mL`);
 * `FIXED_TIME` converts the hold-up to a time delay ONCE, at decision time, from the then-current
 * flow, and is therefore executed on `run.t_s` rather than on volume.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} action  'OPEN' | 'CLOSE' | 'ADVANCE'
 * @param {*} param        the §5.11.2 `trigger` string carried to the record
 * @returns {void}
 */
export function enqueue(config, run, action, param) {
  const f = run.frac;
  ensureScratch(f);
  const fr = currentFractionation(config, run);
  const delay_mL = config.skid.holdup.VuvToFracValve_mL;
  const mode = fr ? fr.delayCompensation : 'COMPENSATED';
  let V_exec_mL = run.V_tot_mL + delay_mL;
  let t_exec_s = NaN;
  if (mode === 'UNCOMPENSATED') {
    V_exec_mL = run.V_tot_mL;
  } else if (mode === 'FIXED_TIME') {
    const Q = run.Q_actual_mLs;
    t_exec_s = run.t_s + ((Q > 1e-9) ? delay_mL / Q : 0);
    V_exec_mL = run.V_tot_mL + delay_mL;      // retained for reporting; the time key decides
  }
  const ev = { V_exec_mL, t_exec_s, action, param, seq: f.seq++ };
  const q = f.queue;
  let i = q.length;
  while (i > 0 && q[i - 1].V_exec_mL > V_exec_mL) i--;
  q.splice(i, 0, ev);
}

/**
 * Execute every queued event that is due. The lead term `run.Q_actual_mLs * tSwitch_s` is
 * re-evaluated here on every control tick, from the current flow, so a ramp cannot shift a cut.
 *
 * @param {object} config
 * @param {object} run
 * @returns {void}
 */
export function drainQueue(config, run) {
  const f = run.frac;
  ensureScratch(f);
  const tSwitch_s = config.skid.fracValve.tSwitch_s;
  const lead_mL = run.V_tot_mL + run.Q_actual_mLs * tSwitch_s;
  while (f.queue.length > 0) {
    const ev = f.queue[0];
    const due = Number.isFinite(ev.t_exec_s) ? (run.t_s >= ev.t_exec_s) : (lead_mL >= ev.V_exec_mL);
    if (!due) break;
    f.queue.shift();
    // The lead term fires the command up to Q*tSwitch_s EARLY so the valve has finished travelling
    // when the material arrives; the fraction's VALVE-plane volume is therefore the event's own
    // V_exec_mL, not the totaliser at the instant the command was issued.
    f.execV_mL = ev.V_exec_mL;
    executeEvent(config, run, ev);
    f.execV_mL = NaN;
  }
}

function executeEvent(config, run, ev) {
  const f = run.frac;
  if (ev.action === 'OPEN') {
    openFraction(config, run, nextPortId(config, run));
  } else if (ev.action === 'CLOSE') {
    if (f.open) closeFraction(config, run, ev.param || 'PEAK_STOP');
  } else if (ev.action === 'ADVANCE') {
    if (f.open) closeFraction(config, run, ev.param || 'FIXED');
    if (ev.param !== 'PEAK_STOP') openFraction(config, run, nextPortId(config, run));
  }
}

/** The port the next fraction would use, or the overflow destination once they are exhausted. */
function nextPortId(config, run) {
  const ports = config.skid.fracValve.ports;
  const fr = currentFractionation(config, run);
  const limit = fr ? Math.min(fr.portCount, ports.length) : ports.length;
  const idx = run.frac.nextPortIdx;
  if (idx < 0 || idx >= limit) return (fr && fr.overflowTo) || config.skid.fracValve.overflowTo || 'WASTE';
  return ports[idx];
}

// ---------------------------------------------------------------------------------------------
// open / close
// ---------------------------------------------------------------------------------------------

/**
 * Open a fraction on `port` and route the outlet to it. Starts the `tSwitch_s` cross-fade and, under
 * `deadLegPolicy: 'DIVERT'`, holds the outlet on waste for the first `VfracDeadLeg_mL`.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} port  a `config.skid.fracValve.ports` id, or the overflow destination
 * @returns {void}
 */
export function openFraction(config, run, port) {
  const f = run.frac;
  ensureScratch(f);
  if (f.open) closeFraction(config, run, 'OPERATOR');
  const fr = currentFractionation(config, run);
  const ports = config.skid.fracValve.ports;
  const isPort = ports.indexOf(port) >= 0;
  const tSwitch_s = config.skid.fracValve.tSwitch_s;

  if (!f.acc.active) openAcc(f.acc, run.V_tot_mL - config.skid.holdup.VuvToFracValve_mL);

  f.moving = true;
  f.moveFrom = f.port;
  f.moveStart_mL = run.V_tot_mL;
  f.moveElapsed_s = 0;
  f.prevPort = f.port;
  f.port = port;

  if (!isPort) {
    // Ports exhausted: the stream goes to the overflow destination and no record is opened.
    // `ALM-FRC-01` fires from `alarms.CUSTOM_EVALUATORS.portsExhausted`, which reads nextPortIdx.
    f.open = false;
    f.current = null;
    requestOutlet(config, run, port);
    return;
  }

  f.nextPortIdx = Math.max(0, f.nextPortIdx) + 1;
  f.open = true;
  const policy = fr ? fr.deadLegPolicy : 'REPORT';
  const deadLeg_mL = config.skid.holdup.VfracDeadLeg_mL;
  f.divertRemaining_mL = (policy === 'DIVERT') ? deadLeg_mL : 0;
  const valveV_mL = Number.isFinite(f.execV_mL) ? f.execV_mL : run.V_tot_mL;
  f.current = {
    index: f.records.length,
    port,
    startTime_s: run.t_s,
    startVolume_mL: f.acc.V0_mL,                 // DETECTOR plane — the decision volume
    startVolumeValve_mL: valveV_mL,              // VALVE plane — where the valve is fully over
    carryoverFrom: f.prevPort,
    switchOverlap_mL: 0.5 * run.Q_actual_mLs * tSwitch_s,
    divertedVolume_mL: 0,
  };
  requestOutlet(config, run, (policy === 'DIVERT') ? (config.skid.fracValve.overflowTo || 'WASTE') : port);
  logEvent(config, run, {
    type: 'FRACTION_START', severity: 'INFO', source: 'PHASE_ENGINE',
    blockId: blockIdOf(config, run), message: 'Fraction ' + port + ' started',
    detail: { port, V_mL: run.V_tot_mL, detectorV_mL: f.acc.V0_mL },
  });
}

/**
 * Close the open fraction, finalise its record and return the outlet to the block default.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} trigger  a §5.11.2 trigger: 'PEAK_START'|'PEAK_STOP'|'MAX_VOLUME'|'MIN_VOLUME'|
 *   'FIXED'|'PORT_EXHAUSTED'|'OPERATOR'|'BLOCK_END'
 * @returns {void}
 */
export function closeFraction(config, run, trigger) {
  const f = run.frac;
  ensureScratch(f);
  if (!f.open || !f.current) {
    // Nothing to attach a closed window to (ports exhausted, or already closed): drop it, or the
    // next real fraction would inherit the wrong statistics.
    f.accClosed.pending = false;
    return;
  }
  const rec = finaliseFraction(config, run, trigger);
  f.records.push(rec);
  f.open = false;
  f.current = null;
  f.divertRemaining_mL = 0;
  f.prevPort = f.port;
  const b = currentBlock(config, run);
  const back = (b && b.outletDefault) || 'WASTE';
  f.moving = true;
  f.moveFrom = f.port;
  f.moveStart_mL = run.V_tot_mL;
  f.moveElapsed_s = 0;
  f.port = back;
  requestOutlet(config, run, back);
  logEvent(config, run, {
    type: 'FRACTION_END', severity: 'INFO', source: 'PHASE_ENGINE', blockId: blockIdOf(config, run),
    message: 'Fraction ' + rec.port + ' closed (' + trigger + ')',
    detail: { port: rec.port, volume_mL: rec.volume_mL, trigger },
  });
}

/**
 * Build the §5.11.2 `FractionRecord` for the fraction that is closing.
 *
 * Volumes: `startVolume_mL`/`endVolume_mL` are DETECTOR-plane decision volumes; the `*Valve_mL`
 * pair is the valve plane; `volume_mL` is the valve-plane span less any diverted dead leg.
 * `estimatedMass_mg = area_AUcm_mL / eps280_Lgcm` of the product species (an AU/cm x mL integral
 * divided by L/(g·cm) is mg — R-U3/R-U4).
 *
 * CONSUMES the detector-plane accumulator it reads: the closed window is released, and a still-live
 * window is stopped at the current detector volume. Call it once per fraction, from `closeFraction`.
 *
 * @param {object} config
 * @param {object} run
 * @param {string} trigger  the §5.11.2 trigger string
 * @returns {object} FractionRecord (§5.11.2), plus `divertedVolume_mL` under `deadLegPolicy:'DIVERT'`
 */
export function finaliseFraction(config, run, trigger) {
  const f = run.frac;
  const cur = f.current;
  const fr = currentFractionation(config, run);
  // A window closed by a STOP decision is waiting in `accClosed`; the live `acc` already belongs to
  // the NEXT fraction. Only a close with no stop decision (BLOCK_END, OPERATOR) consumes the live
  // one — and then it is deactivated here, because its window has just ended.
  const useClosed = f.accClosed.pending === true;
  const a = useClosed ? f.accClosed : f.acc;
  if (!useClosed && f.acc.active) {
    f.acc.V1_mL = run.V_tot_mL;
    f.acc.active = false;
  }
  const tSwitch_s = config.skid.fracValve.tSwitch_s;
  const deadLeg_mL = config.skid.holdup.VfracDeadLeg_mL;
  const policy = fr ? fr.deadLegPolicy : 'REPORT';

  const endValve_mL = Number.isFinite(f.execV_mL) ? f.execV_mL : run.V_tot_mL;
  const spanValve_mL = Math.max(0, endValve_mL - cur.startVolumeValve_mL);
  const diverted_mL = cur.divertedVolume_mL;
  const volume_mL = Math.max(0, spanValve_mL - diverted_mL);
  const detStart_mL = cur.startVolume_mL;
  const detEnd_mL = Number.isFinite(a.V1_mL) && a.V1_mL > detStart_mL ? a.V1_mL : detStart_mL + volume_mL;
  const offsetError_mL = config.skid.holdup.VuvToFracValve_mL - (cur.startVolumeValve_mL - detStart_mL);

  let carryover_mL = 0;
  if (policy === 'REPORT') carryover_mL = Math.min(deadLeg_mL, volume_mL);
  else if (policy === 'DIVERT') carryover_mL = 0;

  const path_cm = config.skid.uv.pathlength_cm;
  const uvStart_mAU = Number.isFinite(a.uvStart_AUcm) ? a.uvStart_AUcm * path_cm * 1000 : NaN;
  const uvEnd_mAU = Number.isFinite(a.uvEnd_AUcm) ? a.uvEnd_AUcm * path_cm * 1000 : NaN;
  const uvMax_mAU = Number.isFinite(a.uvMax_AUcm) && a.uvMax_AUcm > -Infinity
    ? a.uvMax_AUcm * path_cm * 1000 : NaN;

  const prodIdx = (config.idxById && config.load) ? config.idxById[config.load.productSpeciesId] : undefined;
  const eps280_Lgcm = (prodIdx !== undefined && config.species && config.species[prodIdx])
    ? config.species[prodIdx].eps280_Lgcm : 0;
  const estimatedMass_mg = (eps280_Lgcm > 0) ? a.area_AUcm_mL / eps280_Lgcm : NaN;
  if (useClosed) f.accClosed.pending = false;

  return {
    index: cur.index,
    port: cur.port,
    startTime_s: cur.startTime_s,
    endTime_s: run.t_s,
    startVolume_mL: detStart_mL,
    endVolume_mL: detEnd_mL,
    startVolumeValve_mL: cur.startVolumeValve_mL,
    endVolumeValve_mL: endValve_mL,
    volume_mL,
    carryover_mL,
    carryoverFrom: cur.carryoverFrom,
    switchOverlap_mL: cur.switchOverlap_mL + 0.5 * run.Q_actual_mLs * tSwitch_s,
    offsetError_mL,
    divertedVolume_mL: diverted_mL,
    uvStart_mAU,
    uvEnd_mAU,
    uvMax_mAU,
    containsPeakMax: !!a.containsPeakMax,
    area_AUcm_mL: a.area_AUcm_mL,
    estimatedMass_mg,
    meanCond_mScm: a.n > 0 ? a.condSum / a.n : NaN,
    meanPH: a.n > 0 ? a.phSum / a.n : NaN,
    trigger,
    quality: QUALITY_NAME[a.qualityRank] || 'OK',
  };
}

function blockIdOf(config, run) {
  const b = currentBlock(config, run);
  return b ? b.id : null;
}

// ---------------------------------------------------------------------------------------------
// peak maximum
// ---------------------------------------------------------------------------------------------

/**
 * Has the peak apex just been confirmed?
 *
 * The apex is confirmed RETROSPECTIVELY, which is the only causal way to do it: the running maximum
 * since peak start is the largest sample in the window before it; once the signal has travelled a
 * further ±0.02 CV without exceeding that maximum, and has fallen more than `peakMaxProminence`
 * below it, the maximum is the largest sample in the whole sliding window and is prominent.
 * Updates `run.frac.peakMax_AU` / `peakMax_V_mL` (canonical AU/cm and mL) on the way through.
 *
 * @param {object} config
 * @param {object} run
 * @returns {boolean} true exactly once per peak, on the tick the apex is confirmed
 */
export function peakMaxDetect(config, run) {
  const f = run.frac;
  const fr = currentFractionation(config, run);
  if (!fr || f.peakMaxSeen) return false;
  const x = readSignal(config, run, fr);
  if (!Number.isFinite(x)) return false;
  if (x > f.peakMax_AU) { f.peakMax_AU = x; f.peakMax_V_mL = run.V_tot_mL; return false; }
  const half_mL = PEAK_MAX_HALFWINDOW_CV * config.column.V_mL;
  if (run.V_tot_mL - f.peakMax_V_mL < half_mL) return false;
  return (f.peakMax_AU - x) > fr.peakMaxProminence;
}

// ---------------------------------------------------------------------------------------------
// the control tick
// ---------------------------------------------------------------------------------------------

function updateAccumulator(config, run, fr) {
  const f = run.frac;
  const a = f.acc;
  if (!a.active || !fr) return;
  const V = run.V_tot_mL;
  const dV = V - a.prevV_mL;
  a.prevV_mL = V;
  a.V1_mL = V;                         // run.V_tot_mL IS the detector plane (§2.2)
  const uv_AUcm = run.uv.Afilt[0] / config.skid.uv.pathlength_cm;
  if (a.n === 0) a.uvStart_AUcm = uv_AUcm;
  a.uvEnd_AUcm = uv_AUcm;
  if (uv_AUcm > a.uvMax_AUcm) a.uvMax_AUcm = uv_AUcm;
  if (dV > 0) a.area_AUcm_mL += uv_AUcm * dV;
  a.condSum += run.cond.kappaDisp_mScm;
  a.phSum += run.ph.pHfilt;
  a.n++;
  const r = QUALITY_RANK[sensorQuality(run, 'UV')] || 0;
  if (r > a.qualityRank) a.qualityRank = r;
}

function serviceDivert(config, run) {
  const f = run.frac;
  if (!(f.divertRemaining_mL > 0) || !f.open || !f.current) return;
  const dV = Math.max(0, run.V_tot_mL - (f.current.startVolumeValve_mL + f.current.divertedVolume_mL));
  const take = Math.min(dV, f.divertRemaining_mL);
  f.current.divertedVolume_mL += take;
  f.divertRemaining_mL -= take;
  if (f.divertRemaining_mL <= 1e-9) {
    f.divertRemaining_mL = 0;
    requestOutlet(config, run, f.port);
  }
}

function startConditionMet(config, run, fr, x) {
  const th = fr.startThreshold;
  const win_mL = span_mL(config, run, fr.slopeWindow);
  const abs = x >= th.value;
  const slope = slopeOnRing(run, fr.signal, win_mL);
  const slopeOk = Number.isFinite(slope) && slope >= th.slopeValue;
  switch (th.type) {
    case 'SLOPE': return slopeOk;
    case 'BOTH': return abs && slopeOk;
    case 'EITHER': return abs || slopeOk;
    default: return abs;
  }
}

function stopConditionMet(config, run, fr, x) {
  const th = fr.stopThreshold;
  const win_mL = span_mL(config, run, fr.slopeWindow);
  const abs = x <= th.value;
  const slope = slopeOnRing(run, fr.signal, win_mL);
  const slopeOk = Number.isFinite(slope) && slope <= th.slopeValue;
  const pct = (run.frac.peakMax_AU > 0) && (x <= th.pctOfMax / 100 * run.frac.peakMax_AU);
  switch (th.type) {
    case 'SLOPE': return slopeOk;
    case 'PCT_OF_PEAK_MAX': return pct;
    case 'BOTH': return abs && slopeOk;
    case 'EITHER': return abs || slopeOk;
    default: return abs;
  }
}

/**
 * The fractionator's control tick — step (d) of `engine.controlTick`, at 10 Hz.
 *
 * Order: drain anything due, advance the cross-fade and dead-leg timers, accumulate the
 * detector-plane statistics, confirm a peak apex, then apply the §5.4.5 advance precedence —
 * `maxFractionVolume` > peak start/stop > `minFractionVolume` (which SUPPRESSES) > `fixedVolume` >
 * port exhaustion.
 *
 * @param {object} config
 * @param {object} run
 * @param {number} dtCtrl_s  control-tick period, s
 * @returns {void}
 */
export function tickFractionator(config, run, dtCtrl_s) {
  const f = run.frac;
  ensureScratch(f);

  // The fraction-valve cross-fade timer is NOT advanced here. `fluidics.updateValves` owns it
  // (§3.3 tick step 3: "move timers, 5-position transit, cross-fade"), and only that copy latches
  // `run.valves.outletValve = run.frac.port` on completion. Advancing the same
  // `f.moving`/`f.moveElapsed_s` pair a second time from the control tick made the two race: at
  // dtCtrl_s = 0.10 s this copy crossed tSwitch_s (0.20 s) FIRST, cleared `f.moving` without
  // latching the valve, and `outletValve` stayed 'WASTE' for the whole run — every fraction was
  // recorded normally while the product physically went to waste and portVolume_mL stayed zero.

  drainQueue(config, run);

  const fr = currentFractionation(config, run);
  updateAccumulator(config, run, fr);
  serviceDivert(config, run);

  if (!fr || f.mode === 'OFF') {
    if (f.open) closeFraction(config, run, 'BLOCK_END');
    f.acc.active = false;                        // any un-executed window is abandoned with the mode
    f.startCount = 0;
    f.stopCount = 0;
    return;
  }
  if (run.state !== 'RUNNING' && run.state !== 'HELD') return;

  const x = readSignal(config, run, fr);
  if (fr.peakMaxDetection && peakMaxDetect(config, run)) {
    f.peakMaxSeen = true;
    if (f.acc.active) f.acc.containsPeakMax = true;
    logEvent(config, run, {
      type: 'PEAK_MAX', severity: 'INFO', source: 'PHASE_ENGINE', blockId: blockIdOf(config, run),
      message: 'Peak maximum confirmed',
      detail: { signal: fr.signal, value_AUcm: f.peakMax_AU, V_mL: f.peakMax_V_mL },
    });
  }

  const persist = Math.max(1, fr.persistence_ticks);

  if (!f.acc.active) {
    // ---- looking for a start -----------------------------------------------------------------
    if (f.mode === 'FIXED_VOLUME' || f.mode === 'FIXED_TIME') {
      openAcc(f.acc, run.V_tot_mL);
      f.peakMax_AU = Number.isFinite(x) ? x : 0;
      f.peakMax_V_mL = run.V_tot_mL;
      f.peakMaxSeen = false;
      enqueue(config, run, 'OPEN', 'FIXED');
    } else if (f.mode === 'PEAK' && Number.isFinite(x) && startConditionMet(config, run, fr, x)) {
      f.startCount++;
      if (f.startCount >= persist) {
        f.startCount = 0;
        f.stopCount = 0;
        openAcc(f.acc, run.V_tot_mL);
        f.peakMax_AU = x;
        f.peakMax_V_mL = run.V_tot_mL;
        f.peakMaxSeen = false;
        enqueue(config, run, 'OPEN', 'PEAK_START');
      }
    } else {
      f.startCount = 0;
    }
    return;
  }

  // ---- a collection window is open: look for the advance --------------------------------------
  const v_mL = run.V_tot_mL - f.acc.V0_mL;
  const max_mL = span_mL(config, run, fr.maxFractionVolume);
  const min_mL = span_mL(config, run, fr.minFractionVolume);
  const fix_mL = span_mL(config, run, fr.fixedVolume);
  let trigger = null;

  if (Number.isFinite(max_mL) && max_mL > 0 && v_mL >= max_mL) {
    trigger = 'MAX_VOLUME';                                   // precedence 1 — overrides everything
  } else if (f.mode === 'PEAK') {
    if (Number.isFinite(x) && stopConditionMet(config, run, fr, x)) {
      f.stopCount++;
      if (f.stopCount >= persist) {
        if (!Number.isFinite(min_mL) || v_mL >= min_mL) {     // precedence 3 — min SUPPRESSES
          f.stopCount = 0;
          trigger = 'PEAK_STOP';
        }
      }
    } else {
      f.stopCount = 0;
    }
  } else if (Number.isFinite(fix_mL) && fix_mL > 0 && v_mL >= fix_mL
             && (!Number.isFinite(min_mL) || v_mL >= min_mL)) {
    trigger = 'FIXED';                                        // precedence 4
  }

  if (trigger) {
    copyAcc(f.acc, f.accClosed);
    f.acc.active = false;
    enqueue(config, run, 'ADVANCE', trigger);
    if (trigger !== 'PEAK_STOP') {
      openAcc(f.acc, run.V_tot_mL);
    } else {
      f.peakMaxSeen = false;
      f.peakMax_AU = 0;
      f.peakMax_V_mL = 0;
    }
  }
}
