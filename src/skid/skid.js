/**
 * src/skid/skid.js — the fluid network: topology construction, the tanks-in-series cascade,
 * the physics tick assembly, and every totaliser.  Layer L6 (architecture-v2 §4).
 *
 * UNITS (§1.1): volume mL (`_mL`), flow mL/s (`_mLs`), time s (`_s`), concentration mM (`_mM`),
 * amount umol (`_umol`), mass mg (`_mg`).  Gas fractions are dimensionless 0..1.
 *
 * THE SEGMENT INTEGRATOR IS EXPONENTIAL, ALWAYS (§6.12, §7.4.5):
 *     a = exp(-|Q_mLs| * dt_s / Vtank_mL) ;   C_i <- C_in + (C_i - C_in) * a
 * applied strictly upstream -> downstream, EACH TANK USING THE PREVIOUS TANK'S PRE-UPDATE VALUE.
 * Zero flow gives a = 1 and nothing moves.  Explicit Euler is unconditionally forbidden here:
 * tank volumes span 0.02 mL to 1500 mL, so it blows up.  Segments are never run backwards.
 *
 * WHAT THIS FILE OWNS in `run` (§2.2 R-S1):
 *   topo, segC_mM, segAir, yPumpA/B/S_mM, yColIn_mM, yDet_mM, yCond_mM, yPh_mM,
 *   fAirColIn, fAirDet, fAirInletSensor, trapHeadspace_mL, pctB_colInlet,
 *   V_tot/V_run/V_block/V_held/V_load/cycleVolume_mL, wasteVolume_mL, portVolume_mL,
 *   massIn/massOut/massPool/massLoad_umol, neumaier, filterLoad_mg, tick, t_s.
 * It does NOT write run.dPbed_bar (physics/hydraulics.js is the single writer, §6.10) and it does
 * NOT write run.massDefect_umol (physics/bed.js owns it, §6.11).
 */

import { clamp } from '../core/util.js';
import { pushRingRow, appendLogRow } from '../core/log.js';
import { SEGMENT_TABLE } from '../data/library.js';
import { createBedModel, accumulate } from '../physics/bed.js';
import { updateHydraulics } from '../physics/hydraulics.js';
import { updateSensors } from './sensors.js';
import { controlTick } from './engine.js';
import {
  updatePumps, updateProportioner, updateValves, drawTanks,
} from './fluidics.js';

// --- normative segment ids (§5.7). Roles are resolved by id, with positional fallbacks. -------
const ID_MIXER = 'G2';
const ID_FILTER = 'G4';
const ID_AIR_TRAP = 'G5';
const ID_INJECTION_TEE = 'G6';
const ID_UV_CELL = 'D3';
const ID_COND_CELL = 'D5';
const ID_PH_CELL = 'D7';

/** Minimum tank volume used in the exponential kernel, mL — guards the V = 0 pass-through case
 *  produced by `inlineFilter: false` (§5.7.2). */
const V_TANK_FLOOR_mL = 1e-12;

/** Neumaier compensation slots, in the order §2.2 mandates for run.neumaier (length ns*4). */
const NEUMAIER_SLOT = { massIn_umol: 0, massOut_umol: 1, massPool_umol: 2, massLoad_umol: 3 };

/** Species with MW at or above this are treated as protein for the inline-filter fouling load. */
const PROTEIN_MW_MIN_gmol = 5000;

// =============================================================================================
// 1. TOPOLOGY
// =============================================================================================

/**
 * Resolve the effective segment table: `config.skid.segments` when present, otherwise the
 * per-scale table from `data/library.js`, with the three authored substitutions of §5.7.2
 * applied.  The substitutions are IDEMPOTENT, so applying them here is safe whether or not
 * `normalizePreset` already did.
 *
 * @param {object} config config (may be partial: only `scale` and `skid` are read)
 * @returns {Array<{id:string, group:string, V_mL:number, N:number}>} a fresh SegmentDef array
 */
function resolveSegments(config) {
  const sk = config.skid || {};
  const authored = (Array.isArray(sk.segments) && sk.segments.length) ? sk.segments : null;
  const src = authored || SEGMENT_TABLE[config.scale] || SEGMENT_TABLE.PILOT || [];
  const out = new Array(src.length);
  for (let k = 0; k < src.length; k++) {
    const s = src[k];
    let V_mL = s.V_mL;
    let N = s.N;
    if (s.id === ID_MIXER && Number.isFinite(sk.mixerVolume_mL) && sk.mixerVolume_mL > 0) {
      V_mL = sk.mixerVolume_mL;
      if (Number.isFinite(sk.mixerN) && sk.mixerN >= 1) N = sk.mixerN;
    }
    if (s.id === ID_FILTER && sk.inlineFilter === false) { V_mL = 0; N = 1; }
    if (s.id === ID_AIR_TRAP && sk.airTrap === false) { V_mL = 0.05; N = 1; }
    if (!(N >= 1)) N = 1;
    out[k] = { id: s.id, group: s.group, V_mL: Math.max(0, V_mL), N: Math.max(1, Math.round(N)) };
  }
  return out;
}

/**
 * Total variance of a set of segments treated as tanks-in-series, `SUM V^2/N` (mL^2).
 * @param {Array<{V_mL:number, N:number}>} segments segment definitions
 * @returns {number} variance, mL^2
 */
export function segmentVariance_mL2(segments) {
  let v = 0;
  for (let k = 0; k < segments.length; k++) {
    const s = segments[k];
    const n = s.N >= 1 ? s.N : 1;
    v += (s.V_mL * s.V_mL) / n;
  }
  return v;
}

/**
 * Effective plate count of a set of segments in series, `(SUM V)^2 / SUM(V^2/N)`.
 * @param {Array<{V_mL:number, N:number}>} segments segment definitions
 * @returns {number} dimensionless effective plate number; NaN when the variance is 0
 */
export function effectivePlates(segments) {
  let sum_mL = 0;
  for (let k = 0; k < segments.length; k++) sum_mL += segments[k].V_mL;
  const varr = segmentVariance_mL2(segments);
  return varr > 0 ? (sum_mL * sum_mL) / varr : NaN;
}

/**
 * The global tank index of a segment's MEASUREMENT PLANE — the tank after which half the
 * segment's volume has been passed (§5.7.3, "the measurement planes are cell centres").
 * For the shipped N = 2 flow cells this is the first of the two tanks.
 * @param {object} topo topology
 * @param {number} segIdx segment index
 * @returns {number} global tank index
 */
function planeTankOf(topo, segIdx) {
  const n = topo.tanksPerSegment[segIdx];
  return topo.segOffset[segIdx] + Math.max(0, Math.ceil(n / 2) - 1);
}

/** @param {object} topo @param {number} segIdx @returns {number} global index of a segment's LAST tank */
function lastTankOf(topo, segIdx) {
  return topo.segOffset[segIdx] + topo.tanksPerSegment[segIdx] - 1;
}

/**
 * Build the complete fluid topology from `config`: every segment expanded into `N` equal CSTRs,
 * the traversal orders, the measurement-plane tank indices and the derived hold-up table of
 * §5.7.3 (which `data/presets.js` caches into `config.skid.holdup`).
 *
 * Pure and allocating; called at ingest and once per `createSkid`, never per tick.
 *
 * @param {object} config config (frozen or partial: reads `scale`, `ns`, `skid`)
 * @returns {object} Topology:
 *   { segments:SegmentDef[], nSeg:number,
 *     tanksPerSegment:Int32Array(nSeg), segOffset:Int32Array(nSeg+1), nTanksTotal:number,
 *     Vtank_mL:Float64Array(nTanksTotal), segOf:Int32Array(nTanksTotal),
 *     segIndexById:Map<string,number>,
 *     order:{ upstream:number[], downstream:number[] },
 *     branchA/branchB/branchS/sampleChain/gradient/detector/deadLeg/waste : number[],
 *     injectAt:number, airTrapSeg:number, uvTank/condTank/phTank/colInTank/valveTank:number,
 *     ns:number, chainIn/chainHold/scratchOut:Float64Array(ns),
 *     proteinMask:Uint8Array(ns), mgPerMmol:Float64Array(ns),
 *     modulatorIdx:number, inlet:{...},
 *     holdup:{ Vsuction_mL, Vgrad_mL, VcolOutToUV_mL, VuvToCond_mL, VcondToPh_mL,
 *              VphToFracValve_mL, VuvToFracValve_mL, VfracDeadLeg_mL, VsampleLine_mL,
 *              sigmaGrad_mL, NeffGrad, sigmaInjToUV_mL } }
 */
export function buildTopology(config) {
  const segments = resolveSegments(config);
  const nSeg = segments.length;
  const ns = (config.ns > 0) ? config.ns : 1;

  const tanksPerSegment = new Int32Array(nSeg);
  const segOffset = new Int32Array(nSeg + 1);
  let nTanksTotal = 0;
  for (let k = 0; k < nSeg; k++) {
    tanksPerSegment[k] = segments[k].N;
    segOffset[k] = nTanksTotal;
    nTanksTotal += segments[k].N;
  }
  segOffset[nSeg] = nTanksTotal;

  const Vtank_mL = new Float64Array(nTanksTotal);
  const segOf = new Int32Array(nTanksTotal);
  for (let k = 0; k < nSeg; k++) {
    const vt = segments[k].V_mL / segments[k].N;
    for (let t = segOffset[k]; t < segOffset[k + 1]; t++) { Vtank_mL[t] = vt; segOf[t] = k; }
  }

  const segIndexById = new Map();
  for (let k = 0; k < nSeg; k++) segIndexById.set(segments[k].id, k);

  // ---- role lists, in array order (which is upstream -> downstream within each group) --------
  const branchA = [], branchB = [], branchS = [], gradient = [];
  const detector = [], deadLeg = [], sampleSegs = [], waste = [];
  for (let k = 0; k < nSeg; k++) {
    switch (segments[k].group) {
      case 'SUCTION_A': branchA.push(k); break;
      case 'SUCTION_B': branchB.push(k); break;
      case 'SUCTION_S': branchS.push(k); break;
      case 'GRADIENT': gradient.push(k); break;
      case 'DETECTOR': detector.push(k); break;
      case 'DEAD_LEG': deadLeg.push(k); break;
      case 'SAMPLE': sampleSegs.push(k); break;
      case 'WASTE': waste.push(k); break;
      default: break;
    }
  }
  // The sample stream runs inlet valve -> sample pump (SUCTION_S) -> sample line (SAMPLE) ->
  // injection tee. Both groups exist in §5.7 and the §5.7.5 tank budget counts both.
  const sampleChain = branchS.concat(sampleSegs);

  const idxOf = (id) => (segIndexById.has(id) ? segIndexById.get(id) : -1);
  const posIn = (list, segIdx) => list.indexOf(segIdx);

  const teeSeg = idxOf(ID_INJECTION_TEE);
  let injectAt = posIn(gradient, teeSeg);
  if (injectAt < 0) injectAt = 0;                 // fallback: sample joins at the head of the path
  const airTrapSeg = idxOf(ID_AIR_TRAP);

  // ---- measurement planes -------------------------------------------------------------------
  const uvSeg = idxOf(ID_UV_CELL) >= 0 ? idxOf(ID_UV_CELL) : (detector.length > 2 ? detector[2] : -1);
  const condSeg = idxOf(ID_COND_CELL) >= 0 ? idxOf(ID_COND_CELL) : (detector.length > 4 ? detector[4] : -1);
  const phSeg = idxOf(ID_PH_CELL) >= 0 ? idxOf(ID_PH_CELL) : (detector.length > 6 ? detector[6] : -1);

  const topo = {
    segments, nSeg,
    tanksPerSegment, segOffset, nTanksTotal, Vtank_mL, segOf, segIndexById,
    order: {
      upstream: branchA.concat(branchB, sampleChain, gradient),
      downstream: detector.concat(deadLeg),
    },
    branchA, branchB, branchS, sampleChain, gradient, detector, deadLeg, waste,
    injectAt, airTrapSeg,
    uvTank: 0, condTank: 0, phTank: 0, colInTank: 0, valveTank: 0, deadLegTank: 0,
    ns,
    chainIn: new Float64Array(ns),
    chainHold: new Float64Array(ns),
    scratchOut: new Float64Array(ns),
    proteinMask: new Uint8Array(ns),
    mgPerMmol: new Float64Array(ns),
    modulatorIdx: (config.column && config.column.modulatorIdx >= 0) ? config.column.modulatorIdx : -1,
    inlet: {
      tankA: -1, tankB: -1, tankS: -1,
      airA: 0, airB: 0, airS: 0,
      runoutA_s: 0, runoutB_s: 0, runoutS_s: 0,
    },
    holdup: null,
  };

  topo.uvTank = uvSeg >= 0 ? planeTankOf(topo, uvSeg) : (nTanksTotal > 0 ? nTanksTotal - 1 : 0);
  topo.condTank = condSeg >= 0 ? planeTankOf(topo, condSeg) : topo.uvTank;
  topo.phTank = phSeg >= 0 ? planeTankOf(topo, phSeg) : topo.condTank;
  topo.colInTank = gradient.length ? lastTankOf(topo, gradient[gradient.length - 1]) : 0;
  topo.valveTank = detector.length ? lastTankOf(topo, detector[detector.length - 1]) : topo.phTank;
  topo.deadLegTank = deadLeg.length ? lastTankOf(topo, deadLeg[deadLeg.length - 1]) : topo.valveTank;

  // ---- per-species helper tables (inline-filter fouling load) --------------------------------
  const species = config.species || [];
  for (let i = 0; i < ns; i++) {
    const sp = species[i];
    const MW_gmol = sp && Number.isFinite(sp.MW_gmol) ? sp.MW_gmol : 0;
    topo.mgPerMmol[i] = MW_gmol / 1000;                       // c_mM * mL * MW/1000 = mg
    topo.proteinMask[i] = MW_gmol >= PROTEIN_MW_MIN_gmol ? 1 : 0;
  }

  // ---- derived hold-ups, §5.7.3 --------------------------------------------------------------
  const V = (id) => { const k = idxOf(id); return k < 0 ? 0 : segments[k].V_mL; };
  const varOf = (id) => {
    const k = idxOf(id);
    if (k < 0) return 0;
    const s = segments[k];
    return (s.V_mL * s.V_mL) / s.N;
  };
  const sumV = (list) => { let v = 0; for (let k = 0; k < list.length; k++) v += segments[list[k]].V_mL; return v; };
  const sumVar = (list) => {
    let v = 0;
    for (let k = 0; k < list.length; k++) {
      const s = segments[list[k]];
      v += (s.V_mL * s.V_mL) / s.N;
    }
    return v;
  };

  const Vgrad_mL = sumV(gradient);
  const varGrad = sumVar(gradient);
  const sigmaGrad_mL = Math.sqrt(varGrad);
  const D3_mL = V('D3');
  const halfD3_mL = D3_mL / 2;

  topo.holdup = {
    Vsuction_mL: branchA.length ? sumV(branchA) : sumV(branchB),
    Vgrad_mL,
    VcolOutToUV_mL: V('D1') + V('D2') + halfD3_mL,
    VuvToCond_mL: halfD3_mL + V('D4') + V('D5') / 2,
    VcondToPh_mL: V('D5') / 2 + V('D6') + V('D7') / 2,
    VphToFracValve_mL: V('D7') / 2 + V('D8'),
    VuvToFracValve_mL: halfD3_mL + V('D4') + V('D5') + V('D6') + V('D7') + V('D8'),
    VfracDeadLeg_mL: V('D9'),
    VsampleLine_mL: sumV(sampleSegs),
    sigmaGrad_mL,
    NeffGrad: varGrad > 0 ? (Vgrad_mL * Vgrad_mL) / varGrad : NaN,
    // The half-cell contributes as ONE tank of volume D3/2, i.e. variance (D3/2)^2. Verified
    // against all three printed values: LAB 0.25606, PILOT 16.155, PROCESS 291.90 mL.
    sigmaInjToUV_mL: Math.sqrt(
      varOf('G6') + varOf('G7') + varOf('G8') + varOf('G9') +
      varOf('D1') + varOf('D2') + halfD3_mL * halfD3_mL,
    ),
  };

  return topo;
}

/**
 * Total liquid volume of the inclusive segment span between two segment ids, in topology order.
 * @param {object} topo topology from buildTopology
 * @param {string} fromId first segment id
 * @param {string} toId last segment id (either order is accepted)
 * @returns {number} volume, mL; NaN if an id is unknown
 */
export function pathVolume_mL(topo, fromId, toId) {
  const a = topo.segIndexById.get(fromId);
  const b = topo.segIndexById.get(toId);
  if (a === undefined || b === undefined) return NaN;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let v_mL = 0;
  for (let k = lo; k <= hi; k++) v_mL += topo.segments[k].V_mL;
  return v_mL;
}

/**
 * Dispersion sigma of the inclusive segment span between two segment ids, `sqrt(SUM V^2/N)`.
 * @param {object} topo topology from buildTopology
 * @param {string} fromId first segment id
 * @param {string} toId last segment id (either order is accepted)
 * @returns {number} sigma, mL; NaN if an id is unknown
 */
export function pathSigma_mL(topo, fromId, toId) {
  const a = topo.segIndexById.get(fromId);
  const b = topo.segIndexById.get(toId);
  if (a === undefined || b === undefined) return NaN;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let varr = 0;
  for (let k = lo; k <= hi; k++) {
    const s = topo.segments[k];
    varr += (s.V_mL * s.V_mL) / s.N;
  }
  return Math.sqrt(varr);
}

// =============================================================================================
// 2. CONSTRUCTION
// =============================================================================================

/**
 * Build `run.topo`, allocate the cascade arrays that only the topology can size, seed the whole
 * fluid path with the A1 tank's composition, and create the bed model.
 *
 * `core/state.js::createRunState` leaves `run.segC_mM` and `run.segAir` null precisely because
 * their length is `topo.nTanksTotal`-derived (§6.3); calling `createRunState` without a following
 * `createSkid` is a documented error and `physicsTick` asserts it.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state from createRunState
 * @returns {void}
 */
export function createSkid(config, run) {
  const ns = config.ns;
  const topo = buildTopology(config);
  run.topo = topo;
  run.segC_mM = new Float64Array(topo.nTanksTotal * ns);
  run.segAir = new Float64Array(topo.nTanksTotal);
  run.trapHeadspace_mL = 0;
  run.filterLoad_mg = 0;

  // fluidics.js scratch that core/state.js does not know about (see its header note).
  run.valves.cvMoveUnderFlow = false;
  run.valves.cvMoveUnderFlow_s = 0;

  // Seed from the tank on inlet A1 (§6.12).
  const asg = config.inletAssignments || {};
  const seedId = asg.A1 || null;
  let seed = null;
  if (seedId && config.tanks) {
    for (let k = 0; k < config.tanks.length; k++) {
      if (config.tanks[k].id === seedId) { seed = config.tanks[k].y_mM; break; }
    }
  }
  const y0 = seed || new Float64Array(ns);
  seedSegments(config, run, y0);

  // Give every plane a sane starting composition so tick 1 is not a step from zero.
  copyVec(y0, run.yPumpA_mM, ns);
  copyVec(y0, run.yPumpB_mM, ns);
  copyVec(y0, run.yPumpS_mM, ns);
  copyVec(y0, run.yTee_mM, ns);
  copyVec(y0, run.yColIn_mM, ns);
  copyVec(y0, run.yColOut_mM, ns);
  copyVec(y0, run.colHold_mM, ns);
  copyVec(y0, run.yDet_mM, ns);
  copyVec(y0, run.yCond_mM, ns);
  copyVec(y0, run.yPh_mM, ns);

  run.bed = createBedModel(config);
  run.col = run.bed.col;
}

/**
 * Fill every tank of the cascade with one composition vector and clear all gas.
 * @param {object} config frozen config
 * @param {object} run mutable run state (writes run.segC_mM mM, run.segAir, run.trapHeadspace_mL mL)
 * @param {Float64Array} y_mM composition, length config.ns, mM
 * @returns {void}
 */
export function seedSegments(config, run, y_mM) {
  const ns = config.ns;
  const segC = run.segC_mM;
  const nT = run.topo.nTanksTotal;
  for (let t = 0; t < nT; t++) {
    const base = t * ns;
    for (let i = 0; i < ns; i++) segC[base + i] = y_mM[i];
  }
  run.segAir.fill(0);
  run.trapHeadspace_mL = 0;
}

/**
 * Read a segment's outlet composition (the state of its LAST tank).
 * @param {object} run run state
 * @param {number} segIdx segment index
 * @param {Float64Array} out_mM caller-owned output, length >= config.ns, mM
 * @returns {Float64Array} `out_mM`
 */
export function segmentOutlet(run, segIdx, out_mM) {
  const topo = run.topo;
  const ns = topo.ns;
  const base = lastTankOf(topo, segIdx) * ns;
  const segC = run.segC_mM;
  for (let i = 0; i < ns; i++) out_mM[i] = segC[base + i];
  return out_mM;
}

/**
 * Place gas in a segment's FIRST tank — the scenario hook for an injected air slug.
 * @param {object} run mutable run state (writes run.segAir)
 * @param {number} segIdx segment index
 * @param {number} fAir gas volume fraction, 0..1
 * @returns {void}
 */
export function injectAir(run, segIdx, fAir) {
  run.segAir[run.topo.segOffset[segIdx]] = clamp(fAir, 0, 1);
}

// =============================================================================================
// 3. THE CASCADE
// =============================================================================================

/** @param {Float64Array} src @param {Float64Array} dst @param {number} ns @returns {void} */
function copyVec(src, dst, ns) {
  for (let i = 0; i < ns; i++) dst[i] = src[i];
}

/** @param {Float64Array} segC @param {number} ns @param {number} tank @param {Float64Array} dst @returns {void} */
function copyFromTank(segC, ns, tank, dst) {
  const base = tank * ns;
  for (let i = 0; i < ns; i++) dst[i] = segC[base + i];
}

/**
 * Advance a chain of segments with the exponential tanks-in-series kernel.  `topo.chainIn` must
 * already hold the chain's inlet composition; on return `run.segC_mM` holds the updated states and
 * the chain outlet is the LAST tank of `list[i1-1]`.  Zero allocation.
 *
 * @param {object} run run state
 * @param {object} topo topology
 * @param {number} ns species-registry length
 * @param {number[]} list segment-index list
 * @param {number} i0 first index into `list`, inclusive
 * @param {number} i1 last index into `list`, exclusive
 * @param {number} Q_mLs chain flow, mL/s (magnitude taken)
 * @param {number} dt_s timestep, s
 * @returns {void}
 */
function runChain(run, topo, ns, list, i0, i1, Q_mLs, dt_s) {
  const qdt_mL = Math.abs(Q_mLs) * dt_s;
  const segC = run.segC_mM;
  const Vt = topo.Vtank_mL;
  let a = topo.chainIn, b = topo.chainHold;
  for (let s = i0; s < i1; s++) {
    const seg = list[s];
    const t0 = topo.segOffset[seg];
    const t1 = t0 + topo.tanksPerSegment[seg];
    for (let t = t0; t < t1; t++) {
      const V_mL = Vt[t] > V_TANK_FLOOR_mL ? Vt[t] : V_TANK_FLOOR_mL;
      const k = qdt_mL <= 0 ? 1 : Math.exp(-qdt_mL / V_mL);
      const base = t * ns;
      for (let i = 0; i < ns; i++) {
        const c0 = segC[base + i];
        b[i] = c0;                                   // the PRE-update value feeds the next tank
        segC[base + i] = a[i] + (c0 - a[i]) * k;
      }
      const tmp = a; a = b; b = tmp;
    }
  }
}

/**
 * The scalar (gas-fraction) form of `runChain`, with the air-trap capture applied when the chain
 * crosses the trap segment.
 *
 * @param {object} config frozen config
 * @param {object} run run state (writes run.segAir and run.trapHeadspace_mL, mL)
 * @param {object} topo topology
 * @param {number[]} list segment-index list
 * @param {number} i0 first index into `list`, inclusive
 * @param {number} i1 last index into `list`, exclusive
 * @param {number} Q_mLs chain flow, mL/s (magnitude taken)
 * @param {number} dt_s timestep, s
 * @param {number} inAir gas fraction entering the chain, 0..1
 * @returns {number} gas fraction leaving the chain, 0..1
 */
function runChainAir(config, run, topo, list, i0, i1, Q_mLs, dt_s, inAir) {
  const qdt_mL = Math.abs(Q_mLs) * dt_s;
  const segAir = run.segAir;
  const Vt = topo.Vtank_mL;
  let cin = inAir;
  let outAir = inAir;
  for (let s = i0; s < i1; s++) {
    const seg = list[s];
    const t0 = topo.segOffset[seg];
    const t1 = t0 + topo.tanksPerSegment[seg];

    // Air trap: gas is removed from the stream AS IT ENTERS the trap, and collects in the
    // headspace until the trap is full; the remainder passes through. The capture must be taken
    // off the trap's INLET, never off its outlet — draining the trap tank's own contents makes
    // the capture starve itself and the headspace creeps up at ~(qdt/V) per tick instead of
    // filling.
    if (seg === topo.airTrapSeg && config.skid.airTrap === true && cin > 0 && qdt_mL > 0) {
      const room_mL = Math.max(0, topo.segments[seg].V_mL - run.trapHeadspace_mL);
      const taken_mL = Math.min(room_mL, cin * qdt_mL);
      if (taken_mL > 0) {
        run.trapHeadspace_mL += taken_mL;
        cin = Math.max(0, cin - taken_mL / qdt_mL);
      }
    }

    for (let t = t0; t < t1; t++) {
      const V_mL = Vt[t] > V_TANK_FLOOR_mL ? Vt[t] : V_TANK_FLOOR_mL;
      const k = qdt_mL <= 0 ? 1 : Math.exp(-qdt_mL / V_mL);
      const c0 = segAir[t];
      segAir[t] = cin + (c0 - cin) * k;
      cin = c0;
      outAir = segAir[t];
    }
  }
  return outAir;
}

/**
 * Advance one suction branch from its source tank and publish the pump-discharge composition.
 * @param {object} config frozen config
 * @param {object} run run state
 * @param {number[]} list branch segment indices
 * @param {number} tankIdx source tank index, or -1 (branch then self-feeds and holds)
 * @param {number} Q_mLs branch flow, mL/s
 * @param {number} dt_s timestep, s
 * @param {Float64Array} out_mM destination for the branch outlet composition, mM
 * @returns {void}
 */
function advanceBranch(config, run, list, tankIdx, Q_mLs, dt_s, out_mM) {
  const topo = run.topo;
  const ns = topo.ns;
  if (!list.length) return;
  const src = (tankIdx >= 0 && config.tanks && config.tanks[tankIdx].y_mM)
    ? config.tanks[tankIdx].y_mM
    : null;
  if (src) copyVec(src, topo.chainIn, ns);
  else copyFromTank(run.segC_mM, ns, topo.segOffset[list[0]], topo.chainIn);
  runChain(run, topo, ns, list, 0, list.length, Q_mLs, dt_s);
  copyFromTank(run.segC_mM, ns, lastTankOf(topo, list[list.length - 1]), out_mM);
}

/**
 * Tick steps 5 and 8. Advance the tanks-in-series cascade one physics step.
 *
 * `'UPSTREAM'` walks the three parallel suction branches (each at its own pump flow, from its own
 * tank), then the gradient path: segments before the injection tee carry the BUFFER flow
 * (`|QA|+|QB|`), segments from the tee onward carry buffer plus the live sample stream, blended
 * flow-weighted at the tee. It finishes by writing `run.yColIn_mM`, `run.fAirColIn` and the
 * derived `run.pctB_colInlet`.
 *
 * `'DOWNSTREAM'` walks D1..D8 from `run.yColOut_mM` and writes `run.yDet_mM` (after D3/2),
 * `run.yCond_mM` (after D5/2), `run.yPh_mM` (after D7/2) and `run.fAirDet`; then the dead leg D9
 * when the fraction valve is open to a port, or the waste line otherwise.
 *
 * Zero allocation.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s timestep, s
 * @param {'UPSTREAM'|'DOWNSTREAM'} direction which half of the cascade to advance
 * @returns {void}
 */
export function advanceSegments(config, run, dt_s, direction) {
  const topo = run.topo;
  const ns = topo.ns;
  const segC = run.segC_mM;

  if (direction === 'UPSTREAM') {
    const QA_mLs = Math.abs(run.QA_mLs);
    const QB_mLs = Math.abs(run.QB_mLs);
    const QS_mLs = Math.abs(run.QS_mLs);
    const mode = run.valves.sampleMode;
    const sampleLive = (mode === 'DIRECT' || mode === 'LOOP_INJECT');
    const QSlive_mLs = sampleLive ? QS_mLs : 0;
    const Qbuf_mLs = QA_mLs + QB_mLs;

    advanceBranch(config, run, topo.branchA, topo.inlet.tankA, QA_mLs, dt_s, run.yPumpA_mM);
    advanceBranch(config, run, topo.branchB, topo.inlet.tankB, QB_mLs, dt_s, run.yPumpB_mM);
    advanceBranch(config, run, topo.sampleChain, topo.inlet.tankS, QS_mLs, dt_s, run.yPumpS_mM);

    const grad = topo.gradient;
    const tee = topo.injectAt;
    if (grad.length) {
      // pre-tee: buffer only
      copyVec(run.yTee_mM, topo.chainIn, ns);
      if (tee > 0) runChain(run, topo, ns, grad, 0, tee, Qbuf_mLs, dt_s);

      // the tee: flow-weighted blend of the buffer stream and the sample stream
      const upstream = (tee > 0) ? null : run.yTee_mM;
      if (upstream) copyVec(upstream, topo.chainIn, ns);
      else copyFromTank(segC, ns, lastTankOf(topo, grad[tee - 1]), topo.chainIn);
      const Qpost_mLs = Qbuf_mLs + QSlive_mLs;
      if (Qpost_mLs > 0 && QSlive_mLs > 0) {
        const yS = run.yPumpS_mM;
        const inv = 1 / Qpost_mLs;
        for (let i = 0; i < ns; i++) {
          topo.chainIn[i] = (Qbuf_mLs * topo.chainIn[i] + QSlive_mLs * yS[i]) * inv;
        }
      }
      runChain(run, topo, ns, grad, tee, grad.length, Qpost_mLs, dt_s);

      copyFromTank(segC, ns, topo.colInTank, run.yColIn_mM);
      run.fAirColIn = run.segAir[topo.colInTank];   // refreshed same-tick by advanceAir (step 6)
    }

    // Derived %B at the column inlet, §5.1: the physically meaningful one, from the modulator.
    const mi = topo.modulatorIdx;
    if (mi >= 0) {
      const tA = topo.inlet.tankA, tB = topo.inlet.tankB;
      const csA_mM = (tA >= 0 && config.tanks[tA].y_mM) ? config.tanks[tA].y_mM[mi] : 0;
      const csB_mM = (tB >= 0 && config.tanks[tB].y_mM) ? config.tanks[tB].y_mM[mi] : csA_mM;
      const span_mM = csB_mM - csA_mM;
      run.pctB_colInlet = (span_mM === 0)
        ? 0
        : 100 * clamp((run.yColIn_mM[mi] - csA_mM) / span_mM, 0, 1);
    }
    return;
  }

  // ---- DOWNSTREAM ----------------------------------------------------------------------------
  const Q_mLs = Math.abs(run.Q_actual_mLs);
  const det = topo.detector;
  if (det.length) {
    copyVec(run.yColOut_mM, topo.chainIn, ns);
    runChain(run, topo, ns, det, 0, det.length, Q_mLs, dt_s);
    copyFromTank(segC, ns, topo.uvTank, run.yDet_mM);
    copyFromTank(segC, ns, topo.condTank, run.yCond_mM);
    copyFromTank(segC, ns, topo.phTank, run.yPh_mM);
    run.fAirDet = run.segAir[topo.uvTank];
  }

  const collecting = isCollecting(config, run);
  const tail = collecting ? topo.deadLeg : topo.waste;
  if (tail.length) {
    copyFromTank(segC, ns, topo.valveTank, topo.chainIn);
    runChain(run, topo, ns, tail, 0, tail.length, Q_mLs, dt_s);
  }
}

/**
 * Is the outlet valve routed to a collection port (rather than waste)?
 * @param {object} config frozen config
 * @param {object} run run state
 * @returns {boolean} true when the stream is being collected
 */
function isCollecting(config, run) {
  const port = run.valves.outletValve;
  if (!port || port === 'WASTE') return false;
  return config.skid.fracValve.ports.indexOf(port) >= 0;
}

/**
 * Tick step 6. Propagate the gas fraction through the whole cascade, with the same exponential
 * kernel and the same traversal as `advanceSegments`.
 *
 * AIR AT THE COLUMN INLET IS BLOCKED (D4): with the column in line (`DOWN`/`UP`) the bed traps the
 * gas, so the detector chain receives zero air and the UV spike, the conductivity dropout and the
 * pH freeze are visible ONLY in `BYPASS` / `CIP_DETECTOR_BYPASS`. That is exactly why the
 * `air-in-the-line` scenario runs its slug through a `COLUMN_BYPASS` block (§6.12, §11 C-35).
 *
 * Runs AFTER `advanceSegments('UPSTREAM')` so `run.fAirColIn` and `run.fAirDet` carry the
 * SAME-TICK value that `bed.accumulate` (step 7) and `alarms.js` need (§3.3).
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state (writes run.segAir, fAirColIn, fAirDet, fAirInletSensor,
 *        trapHeadspace_mL mL)
 * @param {number} dt_s timestep, s
 * @returns {void}
 */
export function advanceAir(config, run, dt_s) {
  const topo = run.topo;
  const inlet = topo.inlet;
  const QA_mLs = Math.abs(run.QA_mLs);
  const QB_mLs = Math.abs(run.QB_mLs);
  const QS_mLs = Math.abs(run.QS_mLs);
  const mode = run.valves.sampleMode;
  const sampleLive = (mode === 'DIRECT' || mode === 'LOOP_INJECT');
  const QSlive_mLs = sampleLive ? QS_mLs : 0;
  const Qbuf_mLs = QA_mLs + QB_mLs;

  const airA = topo.branchA.length
    ? runChainAir(config, run, topo, topo.branchA, 0, topo.branchA.length, QA_mLs, dt_s, inlet.airA)
    : inlet.airA;
  const airB = topo.branchB.length
    ? runChainAir(config, run, topo, topo.branchB, 0, topo.branchB.length, QB_mLs, dt_s, inlet.airB)
    : inlet.airB;
  const airS = topo.sampleChain.length
    ? runChainAir(config, run, topo, topo.sampleChain, 0, topo.sampleChain.length, QS_mLs, dt_s, inlet.airS)
    : inlet.airS;

  // The bubble sensor sits immediately downstream of the inlet select valve, which is what makes
  // cavitation (ALM-PMP-01) and the inlet air alarm (ALM-AIR-01) respond before the post-column
  // air alarm (ALM-AIR-02).
  const wsum_mLs = QA_mLs + QB_mLs + QS_mLs;
  run.fAirInletSensor = wsum_mLs > 1e-12
    ? (QA_mLs * inlet.airA + QB_mLs * inlet.airB + QS_mLs * inlet.airS) / wsum_mLs
    : Math.max(inlet.airA, inlet.airB, inlet.airS);

  const grad = topo.gradient;
  if (grad.length) {
    const tee = topo.injectAt;
    let air = Qbuf_mLs > 1e-12 ? (QA_mLs * airA + QB_mLs * airB) / Qbuf_mLs : 0;
    if (tee > 0) air = runChainAir(config, run, topo, grad, 0, tee, Qbuf_mLs, dt_s, air);
    const Qpost_mLs = Qbuf_mLs + QSlive_mLs;
    if (Qpost_mLs > 0 && QSlive_mLs > 0) air = (Qbuf_mLs * air + QSlive_mLs * airS) / Qpost_mLs;
    runChainAir(config, run, topo, grad, tee, grad.length, Qpost_mLs, dt_s, air);
    run.fAirColIn = run.segAir[topo.colInTank];
  }

  const Q_mLs = Math.abs(run.Q_actual_mLs);
  const cv = run.valves.columnValve;
  const inLine = (cv === 'DOWN' || cv === 'UP');
  const inDet = inLine ? 0 : run.fAirColIn;         // D4: the bed traps the gas
  const det = topo.detector;
  if (det.length) {
    runChainAir(config, run, topo, det, 0, det.length, Q_mLs, dt_s, inDet);
    run.fAirDet = run.segAir[topo.uvTank];
  }
  const tail = isCollecting(config, run) ? topo.deadLeg : topo.waste;
  if (tail.length) {
    runChainAir(config, run, topo, tail, 0, tail.length, Q_mLs, dt_s, run.segAir[topo.valveTank]);
  }
}

// =============================================================================================
// 4. THE TICK
// =============================================================================================

/**
 * EXACTLY the 15 steps of §3.3, in that order, with those exact function names.
 * `run.t_s` is recomputed from `run.tick`, never accumulated with `+=`.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @returns {number} the column's substep-limiter speed deficit, >= 1. `core/sim.js::advanceWall`
 *          is the SOLE writer of `run.speedDeficit`; this function only returns its contribution.
 */
export function physicsTick(config, run) {
  if (!run.topo || !run.segC_mM) {
    throw new Error('skid.physicsTick: run.topo is null — call skid.createSkid(config, run) '
      + 'after core/state.js::createRunState (architecture-v2 §6.3)');
  }
  const DT_PHYS = config.sim.dtPhys_s;

  run.tick++;                                             // 0
  run.t_s = run.tick * DT_PHYS;

  updatePumps(config, run, DT_PHYS);                      // 1
  updateProportioner(config, run, DT_PHYS);               // 2
  updateValves(config, run, DT_PHYS);                     // 3
  drawTanks(config, run, DT_PHYS);                        // 4
  advanceSegments(config, run, DT_PHYS, 'UPSTREAM');      // 5
  advanceAir(config, run, DT_PHYS);                       // 6
  const deficit = accumulate(config, run, DT_PHYS);       // 7
  advanceSegments(config, run, DT_PHYS, 'DOWNSTREAM');    // 8
  updateHydraulics(config, run, DT_PHYS);                 // 9
  updateSensors(config, run, DT_PHYS);                    // 10
  updateTotalisers(config, run, DT_PHYS);                 // 11
  if (run.tick % config.sim.ctrlEvery === 0) {            // 12
    controlTick(config, run, DT_PHYS * config.sim.ctrlEvery);
  }
  pushRingRow(config, run);                               // 13
  if (run.tick % config.sim.logEvery === 0) appendLogRow(config, run);   // 14
  return deficit;                                         // 15
}

/**
 * Neumaier-compensated increment of one of the four mass accumulators.
 * The running compensation lives in `run.neumaier[slot*ns + i]`, with the slot order
 * massIn / massOut / massPool / massLoad mandated by §2.2. The compensated total is
 * `run[arrayName][i] + run.neumaier[slot*ns + i]`.
 *
 * `run.massDefect_umol` deliberately has NO Neumaier term (§2.2): it is a diagnostic that must
 * stay at zero, and compensating it would mask its own growth.
 *
 * @param {object} run mutable run state
 * @param {'massIn_umol'|'massOut_umol'|'massPool_umol'|'massLoad_umol'} arrayName accumulator
 * @param {number} i species-registry index
 * @param {number} value increment, umol
 * @returns {void}
 */
export function neumaierAdd(run, arrayName, i, value) {
  const arr = run[arrayName];
  const s = arr[i];
  const t = s + value;
  const k = NEUMAIER_SLOT[arrayName] * arr.length + i;
  run.neumaier[k] += (Math.abs(s) >= Math.abs(value)) ? ((s - t) + value) : ((value - t) + s);
  arr[i] = t;
}

/**
 * Tick step 11. Integrate every volume, inventory and mass totaliser from `Q_actual` — never from
 * `Q_set` (§6.13).
 *
 * `massIn_umol[i] += |dV_mL| * yColIn_mM[i]` (mM * mL = umol, R-U4), and likewise `massOut` from
 * `yColOut_mM`. BOTH ARE FROZEN while `run.valves.columnValve` is `BYPASS`, `ISOLATED` or
 * `CIP_DETECTOR_BYPASS`: nothing entered or left the column, and counting the stream that went
 * round it makes `xi` unclosable across a `COLUMN_BYPASS` block (§5.11.4, §6.12). Volume
 * totalisers, waste, ports, `massLoad` and `massPool` keep counting normally.
 *
 * This function does NOT write `run.massDefect_umol` — `physics/bed.js` owns it — and it is not
 * the source of the mass audit's in/out terms, which come off the column plane (§5.11.4).
 *
 * `run.filterLoad_mg` (the inline-filter fouling load that
 * `hydraulics.filterResistance_bar_per_mLs` reads) is the cumulative PROTEIN mass delivered past
 * the column-inlet plane: `mg = dV_mL * c_mM * MW_gmol / 1000` (R-U3). Over the shipped pilot load
 * that totals 27 720 mg, which is the number §5.6.2's `R0 x 1.554` is computed from.
 *
 * @param {object} config frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s timestep, s
 * @returns {void}
 */
export function updateTotalisers(config, run, dt_s) {
  const ns = config.ns;
  const topo = run.topo;
  const dV_mL = Math.abs(run.Q_actual_mLs) * dt_s;
  const st = run.state;

  run.V_tot_mL += dV_mL;
  if (st === 'RUNNING' || st === 'HELD' || st === 'PAUSED' || st === 'ALARM') run.V_run_mL += dV_mL;
  if (st === 'RUNNING') run.V_block_mL += dV_mL;
  if (st === 'HELD') run.V_held_mL += dV_mL;
  run.cycleVolume_mL += dV_mL;

  // ---- outlet inventory ----------------------------------------------------------------------
  const ports = config.skid.fracValve.ports;
  const outPort = run.valves.outletValve;
  let p = -1;
  if (outPort && outPort !== 'WASTE') {
    for (let k = 0; k < ports.length; k++) { if (ports[k] === outPort) { p = k; break; } }
  }
  if (p >= 0) run.portVolume_mL[p] += dV_mL;
  else run.wasteVolume_mL += dV_mL;

  if (dV_mL > 0) {
    // ---- column plane ------------------------------------------------------------------------
    const cv = run.valves.columnValve;
    if (cv === 'DOWN' || cv === 'UP') {
      const yIn = run.yColIn_mM, yOut = run.yColOut_mM;
      for (let i = 0; i < ns; i++) {
        neumaierAdd(run, 'massIn_umol', i, dV_mL * yIn[i]);
        neumaierAdd(run, 'massOut_umol', i, dV_mL * yOut[i]);
      }
    }

    // ---- collected pool, sampled at the FRACTION VALVE plane ---------------------------------
    if (p >= 0) {
      const tank = topo.deadLeg.length ? topo.deadLegTank : topo.valveTank;
      const yV = topo.scratchOut;
      copyFromTank(run.segC_mM, ns, tank, yV);
      for (let i = 0; i < ns; i++) neumaierAdd(run, 'massPool_umol', i, dV_mL * yV[i]);
    }

    // ---- inline-filter fouling load ----------------------------------------------------------
    const yIn = run.yColIn_mM;
    const mask = topo.proteinMask, mgPer = topo.mgPerMmol;
    let load_mg = 0;
    for (let i = 0; i < ns; i++) if (mask[i]) load_mg += yIn[i] * mgPer[i];
    if (load_mg > 0) run.filterLoad_mg += dV_mL * load_mg;
  }

  // ---- sample delivered to the column ---------------------------------------------------------
  const mode = run.valves.sampleMode;
  if (mode === 'DIRECT' || mode === 'LOOP_INJECT') {
    const dVs_mL = Math.abs(run.QS_mLs) * dt_s;
    if (dVs_mL > 0) {
      run.V_load_mL += dVs_mL;
      const yS = run.yPumpS_mM;
      for (let i = 0; i < ns; i++) neumaierAdd(run, 'massLoad_umol', i, dVs_mL * yS[i]);
    }
  }
}
