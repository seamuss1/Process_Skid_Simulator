/**
 * src/skid/method.js — the method / block / watch / fractionation schema.
 *
 * Owner: `skid-method`. Contract §5.4, §5.4.6, §6.15.
 *
 * This module is the METHOD INGEST BOUNDARY (rule R-U1): authored human units are converted to the
 * canonical set exactly once, in `normalizeMethod`, and nothing downstream ever sees a human unit.
 * Every threshold this file writes is canonical:
 *   UV thresholds        AU/cm      (never mAU, never AU — swapping the flow cell must not move a cut)
 *   slope thresholds     <unit>/mL  (every slope in the contract is per mL, §5.2)
 *   flows                mL/s
 *   volumes              mL
 *   times                s
 *
 * Layer L3. Imports `core/util.js` and `physics/hydraulics.js` and nothing else (§4).
 */

import { clamp } from '../core/util.js';
import { dpBed_bar, solveCompression } from '../physics/hydraulics.js';

/** The twelve block types (§5.4.3). Order is normative for the editor's picker. */
export const BLOCK_TYPES = ['EQUILIBRATION', 'LOAD', 'WASH', 'ELUTION_ISOCRATIC', 'ELUTION_LINEAR',
  'ELUTION_STEP', 'STRIP', 'CIP', 'RE_EQUILIBRATION', 'HOLD', 'COLUMN_BYPASS', 'PACKING_TEST'];

const GRADIENT_SHAPES = ['ISOCRATIC', 'LINEAR', 'STEP', 'CONVEX', 'CONCAVE', 'MULTI_SEGMENT'];
const FLOW_MODES = ['ML_MIN', 'CM_H', 'RESIDENCE_TIME_MIN', 'CV_PER_H', 'INHERIT'];
const TERMINAL_ACTIONS = ['END_BLOCK', 'GOTO_BLOCK', 'HOLD', 'PAUSE', 'RAISE_ALARM'];
const SLOPE_OPERATORS = ['SLOPE_ABOVE', 'SLOPE_BELOW', 'ABS_SLOPE_BELOW', 'STABLE', 'PLATEAU'];

/** Every unit string the §5.2 conversion table accepts. A unit outside this set is a warning. */
const KNOWN_UNITS = new Set(['mAU', 'AU', 'AU/cm', 'mS/cm', 'bar', 'mL/min', 'cm/h', 'CV', 'mL',
  'min', 's', '%', '-', 'C', '°C', 'mAU/CV', 'mAU/mL', 'AU/cm/mL', 'mS/cm/CV', 'mS/cm/mL',
  'bar/min', 'mL/s', 'pH', 'frac']);

/** Slope-ring lane cap (§6.16). A block needing a seventh distinct signal is a validation error. */
const NSIG_MAX = 6;

/** The §8.4.1 default PEAK fractionation, used by the `frac:'PEAK'` shorthand (§8.4.3). */
function defaultPeakFractionation() {
  return {
    mode: 'PEAK', signal: 'UV_280',
    startThreshold: { type: 'ABSOLUTE', value: 2.00, slopeValue: 0, pctOfMax: 0,
      authoredAs: { value: 40, unit: 'mAU' } },
    stopThreshold: { type: 'ABSOLUTE', value: 2.00, slopeValue: 0, pctOfMax: 10,
      authoredAs: { value: 40, unit: 'mAU' } },
    fixedVolume: { basis: 'CV', value: 0.10 },
    minFractionVolume: { basis: 'CV', value: 0.05 },
    maxFractionVolume: { basis: 'CV', value: 0.25 },
    slopeWindow: { basis: 'CV', value: 0.05 },
    peakMaxDetection: true, peakMaxProminence: 1.5,
    firstPort: 'F1', portCount: 12, overflowTo: 'WASTE',
    delayCompensation: 'COMPENSATED', deadLegPolicy: 'REPORT', persistence_ticks: 5,
  };
}

// ---------------------------------------------------------------------------------------------
// unit conversion — §5.2, applied exactly once, here
// ---------------------------------------------------------------------------------------------

/**
 * Convert one authored threshold to its canonical value using the §5.2 table.
 *
 * @param {object} config  frozen config; reads `skid.uv.pathlength_cm`, `column.V_mL`, `column.A_cm2`
 * @param {number} value   authored magnitude, in `unit`
 * @param {string|null} unit  a §5.2 unit string; null/undefined/unknown means "already canonical"
 * @returns {number} the canonical value (AU/cm, mS/cm, bar, mL/s, mL, s, ... or the same per mL)
 */
function convertUnit(config, value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const path_cm = config.skid.uv.pathlength_cm;
  const V_mL = config.column.V_mL;
  const A_cm2 = config.column.A_cm2;
  switch (unit) {
    case 'mAU': return value / 1000 / path_cm;
    case 'AU': return value / path_cm;
    case 'mL/min': return value / 60;
    case 'cm/h': return value * A_cm2 / 3600;
    case 'CV': return value * V_mL;
    case 'min': return value * 60;
    case 'mAU/CV': return value / 1000 / path_cm / V_mL;
    case 'mAU/mL': return value / 1000 / path_cm;
    case 'mS/cm/CV': return value / V_mL;
    case 'bar/min': return value / 60;
    // identity rows: 'AU/cm','mS/cm','bar','mL','s','%','-','C','°C','AU/cm/mL','mS/cm/mL','mL/s',
    // 'pH','frac', and the null/undefined "already canonical" case.
    default: return value;
  }
}

/**
 * Resolve a §5.2 signal name into its hot-path form. `TANK_LEVEL:<id>` is split ONCE, here, so the
 * 10 Hz path never parses a string (§5.2).
 *
 * @param {object} config
 * @param {string} name  a §5.2 signal name
 * @returns {{base:string, tankIdx:number}} `tankIdx` is -1 for every non-tank signal, and -1 for an
 *   unknown tank id (which `validateMethod` reports as an error).
 */
function resolveSignal(config, name) {
  if (typeof name === 'string' && name.lastIndexOf('TANK_LEVEL:', 0) === 0) {
    const id = name.slice('TANK_LEVEL:'.length);
    const tanks = config.tanks || [];
    let idx = -1;
    for (let k = 0; k < tanks.length; k++) if (tanks[k].id === id) { idx = k; break; }
    return { base: 'TANK_LEVEL', tankIdx: idx };
  }
  return { base: name, tankIdx: -1 };
}

// ---------------------------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------------------------

function num(v, fallback) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
}

function pick(v, fallback) {
  return (v === undefined || v === null) ? fallback : v;
}

function titleCase(type) {
  const s = String(type || '').toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Convert a `{basis, value}` pair to millilitres.
 *
 * @param {object} config
 * @param {string} basis   'CV' | 'mL' | 'min' | 's' | 'CV_OF_SAMPLE'
 * @param {number} value   magnitude in `basis`
 * @param {number} flow_mLs  volumetric flow, mL/s — only read for the time bases
 * @returns {number} volume, mL
 */
function basisToVolume_mL(config, basis, value, flow_mLs) {
  const v = num(value, 0);
  switch (basis) {
    case 'CV': return v * config.column.V_mL;
    case 'mL': return v;
    case 'min': return v * 60 * num(flow_mLs, 0);
    case 's': return v * num(flow_mLs, 0);
    case 'CV_OF_SAMPLE': {
      const sample_mL = config.load && config.load.derived ? num(config.load.derived.volume_mL, 0) : 0;
      return v * sample_mL;
    }
    default: return v;
  }
}

// ---------------------------------------------------------------------------------------------
// per-block resolution
// ---------------------------------------------------------------------------------------------

/**
 * The volume a block delivers, in mL, from its `duration` (§5.4.2).
 *
 * `HOLD` blocks return `Infinity`: §5.4.3 and §5.4.4c rule 12 say a HOLD block NEVER ends on its
 * duration, so it has no finite volume. `methodDemand` treats a non-finite volume as zero.
 *
 * @param {object} config  frozen config
 * @param {object} block   a NORMALISED block (INHERIT already resolved)
 * @returns {number} block volume, mL (Infinity for HOLD)
 */
export function blockVolume_mL(config, block) {
  if (!block) return 0;
  if (block.type === 'HOLD') return Infinity;
  const d = block.duration || {};
  const flow_mLs = blockFlow_mLs(config, block, null);
  return basisToVolume_mL(config, d.basis, d.value, flow_mLs);
}

/**
 * Resolve a block's flow setpoint to mL/s (§5.4.2).
 *
 * @param {object} config
 * @param {object} block      the block whose flow is wanted
 * @param {object|null} prevBlock  the previous ENABLED block, used only for `INHERIT`
 * @returns {number} flow, mL/s. NaN when `INHERIT` cannot be resolved (no previous block and no
 *   `config.method.globalDefaults.flow`) — `validateMethod` reports that as a flow-range error.
 */
export function blockFlow_mLs(config, block, prevBlock) {
  if (!block) return NaN;
  const f = block.flow || {};
  const mode = f.mode || 'CM_H';
  const value = num(f.value, NaN);
  switch (mode) {
    case 'ML_MIN': return value / 60;
    case 'CM_H': return value * config.column.A_cm2 / 3600;
    case 'RESIDENCE_TIME_MIN': return (value > 0) ? config.column.V_mL / (value * 60) : NaN;
    case 'CV_PER_H': return value * config.column.V_mL / 3600;
    case 'INHERIT': {
      if (prevBlock) return blockFlow_mLs(config, prevBlock, null);
      const gd = config.method && config.method.globalDefaults ? config.method.globalDefaults.flow : null;
      if (gd) return blockFlow_mLs(config, { flow: gd }, null);
      return NaN;
    }
    default: return NaN;
  }
}

/**
 * The commanded %B at a given fractional progress through a block (§5.4.2 `gradient`).
 *
 * Shapes: ISOCRATIC holds `startPctB`; LINEAR ramps start→end over `lengthFraction` of the block and
 * then holds `endPctB`; STEP jumps to `endPctB` at block start; CONVEX/CONCAVE apply the exponent
 * `n = 1 + |curvature|/2` (curvature 0 reproduces LINEAR exactly, ±5 gives n = 3.5) with a negative
 * `curvature` mirroring the two shapes into each other; MULTI_SEGMENT interpolates the ascending
 * `segments` array piecewise-linearly, anchored at (0, startPctB) and held after the last point.
 *
 * @param {object} config
 * @param {object} block
 * @param {number} progressFraction  0..1, the block's own progress (volume or time basis)
 * @returns {number} %B, 0..100
 */
export function targetPctB(config, block, progressFraction) {
  if (!block) return 0;
  const g = block.gradient || {};
  const start = clamp(num(g.startPctB, 0), 0, 100);
  const end = clamp(num(g.endPctB, start), 0, 100);
  const shape = g.shape || 'ISOCRATIC';
  const L = clamp(num(g.lengthFraction, 1), 0, 1);
  const f = clamp(num(progressFraction, 0), 0, 1);
  const u = (L > 0) ? clamp(f / L, 0, 1) : 1;
  switch (shape) {
    case 'ISOCRATIC': return start;
    case 'STEP': return end;
    case 'LINEAR': return start + (end - start) * u;
    case 'CONVEX':
    case 'CONCAVE': {
      const curv = num(g.curvature, 0);
      const n = 1 + Math.abs(curv) / 2;
      const convex = (shape === 'CONVEX') === (curv >= 0);
      const shapeU = convex ? (1 - Math.pow(1 - u, n)) : Math.pow(u, n);
      return start + (end - start) * shapeU;
    }
    case 'MULTI_SEGMENT': {
      const segs = Array.isArray(g.segments) ? g.segments : null;
      if (!segs || segs.length === 0) return start + (end - start) * u;
      let prevF = 0, prevP = start;
      for (let i = 0; i < segs.length; i++) {
        const sf = clamp(num(segs[i].atFraction, 0), 0, 1);
        const sp = clamp(num(segs[i].pctB, prevP), 0, 100);
        if (u <= sf) {
          const span = sf - prevF;
          return (span <= 0) ? sp : prevP + (sp - prevP) * ((u - prevF) / span);
        }
        prevF = sf; prevP = sp;
      }
      return prevP;
    }
    default: return start;
  }
}

/**
 * Darcy + hardware pressure estimate for the method editor's preview lane (§6.15).
 *
 * Returns the COLUMN differential the §5.6 ΔP ladder watches: `dP_bed + dP_hw + dP_filter`
 * (i.e. P1 − P2 with a clean filter). Viscosity is taken as the canonical reference 1.002 cP —
 * this is a design-time estimate and has no access to `run.mu_cP`.
 *
 * @param {object} config
 * @param {object} block  a normalised block
 * @returns {number} estimated ΔP, bar (0 for a block whose column valve is out of line)
 */
export function blockPressureEstimate_bar(config, block) {
  if (!block) return 0;
  const pos = block.columnValve || 'DOWN';
  const Q_mLs = blockFlow_mLs(config, block, null);
  if (!Number.isFinite(Q_mLs) || Q_mLs <= 0) return 0;
  const col = config.column;
  const u_cms = Q_mLs / col.A_cm2;
  const mu_cP = 1.002;
  let dPbed_bar = 0;
  if (pos === 'DOWN' || pos === 'UP') {
    const rigid_bar = dpBed_bar({ kKozeny: col.kKozeny, mu_cP, u_cms, L_cm: col.L_cm,
      eps: col.compression ? col.compression.eps0 : col.epsC, dp_cm: col.dp_cm });
    if (col.compression && col.compression.enabled) {
      dPbed_bar = solveCompression(col, rigid_bar).dp_bar;
    } else {
      dPbed_bar = rigid_bar;
    }
  }
  const dPhw_bar = num(col.rFrit_bar_per_cms, 0) * u_cms * num(col.foulingFactor, 1);
  const filt = config.skid.filter || {};
  const dPfilter_bar = config.skid.inlineFilter === false ? 0 : num(filt.R0_bar_per_mLs, 0) * Q_mLs;
  return dPbed_bar + dPhw_bar + dPfilter_bar;
}

// ---------------------------------------------------------------------------------------------
// normalisation — the ingest boundary
// ---------------------------------------------------------------------------------------------

function normalizeArm(arm, gd) {
  const a = arm || gd;
  return { basis: pick(a && a.basis, 'CV'), value: num(a && a.value, 0.05) };
}

function normalizeSpan(span, defBasis, defValue) {
  const s = span || {};
  return { basis: pick(s.basis, defBasis), value: num(s.value, defValue) };
}

/**
 * Normalise one threshold-bearing object in place on a fresh copy.
 * `authoredAs` is the source of truth when present, which makes normalisation IDEMPOTENT: running
 * `normalizeMethod` twice cannot convert the same number twice.
 */
function normalizeThresholdBlock(config, th, defaults) {
  const t = th || {};
  const authored = t.authoredAs || null;
  const out = {
    type: pick(t.type, defaults.type),
    value: num(t.value, defaults.value),
    slopeValue: num(t.slopeValue, defaults.slopeValue),
    pctOfMax: num(t.pctOfMax, defaults.pctOfMax),
    authoredAs: null,
  };
  if (authored) {
    if (authored.value !== undefined) out.value = convertUnit(config, num(authored.value, out.value), authored.unit);
    if (authored.slopeValue !== undefined) {
      out.slopeValue = convertUnit(config, num(authored.slopeValue, out.slopeValue), authored.slopeUnit);
    }
    if (authored.pctOfMax !== undefined) out.pctOfMax = num(authored.pctOfMax, out.pctOfMax);
    out.authoredAs = {
      value: num(authored.value, out.value), unit: pick(authored.unit, null),
      slopeValue: num(authored.slopeValue, out.slopeValue), slopeUnit: pick(authored.slopeUnit, null),
      pctOfMax: num(authored.pctOfMax, out.pctOfMax),
      pathlength_cm: config.skid.uv.pathlength_cm,
    };
  } else {
    out.authoredAs = { value: out.value, unit: null, slopeValue: out.slopeValue, slopeUnit: null,
      pctOfMax: out.pctOfMax, pathlength_cm: config.skid.uv.pathlength_cm };
  }
  return out;
}

function normalizeFractionation(config, frac) {
  const f = frac || {};
  const mode = pick(f.mode, 'OFF');
  const out = {
    mode,
    signal: pick(f.signal, 'UV_280'),
    signalResolved: null,
    startThreshold: normalizeThresholdBlock(config, f.startThreshold,
      { type: 'ABSOLUTE', value: 0, slopeValue: 0, pctOfMax: 0 }),
    stopThreshold: normalizeThresholdBlock(config, f.stopThreshold,
      { type: 'ABSOLUTE', value: 0, slopeValue: 0, pctOfMax: 10 }),
    fixedVolume: normalizeSpan(f.fixedVolume, 'CV', 0.10),
    minFractionVolume: normalizeSpan(f.minFractionVolume, 'CV', 0.05),
    maxFractionVolume: normalizeSpan(f.maxFractionVolume, 'CV', 0.25),
    slopeWindow: normalizeSpan(f.slopeWindow, 'CV', 0.05),
    peakMaxDetection: pick(f.peakMaxDetection, true),
    peakMaxProminence: num(f.peakMaxProminence, 1.5),
    firstPort: pick(f.firstPort, 'F1'),
    portCount: num(f.portCount, (config.skid.fracValve && config.skid.fracValve.ports)
      ? config.skid.fracValve.ports.length : 12),
    overflowTo: pick(f.overflowTo, (config.skid.fracValve && config.skid.fracValve.overflowTo) || 'WASTE'),
    delayCompensation: pick(f.delayCompensation, 'COMPENSATED'),
    deadLegPolicy: pick(f.deadLegPolicy, 'REPORT'),
    persistence_ticks: Math.max(1, Math.round(num(f.persistence_ticks, 5))),
  };
  out.signalResolved = resolveSignal(config, out.signal);
  return out;
}

function normalizeWatch(config, w, gd, index) {
  const src = w || {};
  const authored = src.authoredAs || null;
  const out = {
    id: pick(src.id, 'W' + String(index + 1).padStart(2, '0')),
    signal: pick(src.signal, 'UV_280'),
    signalResolved: null,
    operator: pick(src.operator, 'ABOVE'),
    threshold: num(src.threshold, 0),
    authoredAs: null,
    slopeWindow: normalizeSpan(src.slopeWindow, 'CV', 0.05),
    stableTolerance: num(src.stableTolerance, 0),
    arm: normalizeArm(src.arm, gd.arm),
    persistence_ticks: Math.max(1, Math.round(num(src.persistence_ticks, gd.persistence_ticks))),
    action: pick(src.action, 'END_BLOCK'),
    actionParam: pick(src.actionParam, null),
    actionParamUnit: pick(src.actionParamUnit, null),
    oneShot: pick(src.oneShot, true),
    useDelayCompensated: pick(src.useDelayCompensated, false),
  };
  if (authored && authored.value !== undefined) {
    out.threshold = convertUnit(config, num(authored.value, out.threshold), authored.unit);
    out.authoredAs = { value: num(authored.value, out.threshold), unit: pick(authored.unit, null),
      pathlength_cm: config.skid.uv.pathlength_cm };
    if (authored.stableTolerance !== undefined) {
      out.stableTolerance = convertUnit(config, num(authored.stableTolerance, out.stableTolerance),
        authored.stableToleranceUnit);
      out.authoredAs.stableTolerance = num(authored.stableTolerance, out.stableTolerance);
      out.authoredAs.stableToleranceUnit = pick(authored.stableToleranceUnit, null);
    }
  } else {
    out.authoredAs = { value: out.threshold, unit: null, pathlength_cm: config.skid.uv.pathlength_cm };
  }
  // SET_FLOW / SET_PCTB parameters travel through the same table so a method may author mL/min.
  if (out.actionParamUnit && typeof out.actionParam === 'number') {
    out.actionParam = convertUnit(config, out.actionParam, out.actionParamUnit);
  }
  out.signalResolved = resolveSignal(config, out.signal);
  return out;
}

function normalizeBlock(config, b, gd, prevEnabled, index) {
  const src = b || {};
  const type = BLOCK_TYPES.indexOf(src.type) >= 0 ? src.type : 'WASH';
  const dur = src.duration || {};
  const flowSrc = src.flow || gd.flow;
  const grad = src.gradient || {};
  const sample = src.sample || {};
  const out = {
    id: pick(src.id, 'B' + String(index + 1).padStart(2, '0')),
    name: pick(src.name, titleCase(type)),
    type,
    enabled: pick(src.enabled, true),
    duration: {
      basis: pick(dur.basis, 'CV'),
      value: num(dur.value, type === 'HOLD' ? 0 : 1),
      onTimeout: pick(dur.onTimeout, 'NEXT'),
      repeatLimit: Math.max(0, Math.round(num(dur.repeatLimit, 0))),
    },
    flow: {
      mode: FLOW_MODES.indexOf(flowSrc.mode) >= 0 ? flowSrc.mode : 'CM_H',
      value: num(flowSrc.value, num(gd.flow.value, 0)),
      rampOverride_mLs2: pick(src.rampOverride_mLs2, pick(src.flow && src.flow.rampOverride_mLs2, null)),
    },
    inlets: {
      a: pick(src.inlets && src.inlets.a, 'A1'),
      b: pick(src.inlets && src.inlets.b, 'B1'),
      sample: pick(src.inlets && src.inlets.sample, null),
    },
    gradient: {
      startPctB: num(grad.startPctB, 0),
      endPctB: num(grad.endPctB, num(grad.startPctB, 0)),
      shape: GRADIENT_SHAPES.indexOf(grad.shape) >= 0 ? grad.shape : 'ISOCRATIC',
      curvature: clamp(num(grad.curvature, 0), -5, 5),
      segments: Array.isArray(grad.segments)
        ? grad.segments.map((s) => ({ atFraction: clamp(num(s.atFraction, 0), 0, 1), pctB: clamp(num(s.pctB, 0), 0, 100) }))
          .sort((p, q) => p.atFraction - q.atFraction)
        : null,
      lengthFraction: clamp(num(grad.lengthFraction, 1), 0, 1),
    },
    columnValve: pick(src.columnValve, 'DOWN'),
    outletDefault: pick(src.outletDefault, 'WASTE'),
    sample: {
      mode: pick(sample.mode, null),
      loopVolume_mL: pick(sample.loopVolume_mL, null),
      sampleFlow: sample.sampleFlow
        ? { mode: pick(sample.sampleFlow.mode, 'CM_H'), value: num(sample.sampleFlow.value, 0) }
        : null,
      chaseVolume_CV: num(sample.chaseVolume_CV, 0),
    },
    fractionation: normalizeFractionation(config, src.fractionation),
    autozero: pick(src.autozero, false),
    holdAtEnd: pick(src.holdAtEnd, false),
    watches: (Array.isArray(src.watches) ? src.watches : []).map((w, i) => normalizeWatch(config, w, gd, i)),
    notes: pick(src.notes, ''),
  };

  // Per-type enforcement, §5.4.3.
  if (type === 'EQUILIBRATION' || type === 'WASH' || type === 'RE_EQUILIBRATION'
      || type === 'ELUTION_ISOCRATIC' || type === 'STRIP') {
    out.gradient.shape = 'ISOCRATIC';
  }
  if (type === 'ELUTION_STEP') out.gradient.shape = 'STEP';
  if (type === 'COLUMN_BYPASS') out.columnValve = 'BYPASS';
  if (type === 'CIP' && ['DOWN', 'UP', 'CIP_DETECTOR_BYPASS'].indexOf(out.columnValve) < 0) {
    out.columnValve = 'DOWN';
  }
  if (type === 'EQUILIBRATION' && out.fractionation.mode === undefined) out.fractionation.mode = 'OFF';
  if (type === 'PACKING_TEST' && !out.sample.mode) out.sample.mode = 'LOOP_INJECT';

  // Resolve INHERIT against the previous ENABLED block, once, here (§5.4.6).
  if (out.flow.mode === 'INHERIT') {
    const resolved_mLs = blockFlow_mLs(config, out, prevEnabled);
    if (Number.isFinite(resolved_mLs)) {
      out.flow = { mode: 'ML_MIN', value: resolved_mLs * 60, rampOverride_mLs2: out.flow.rampOverride_mLs2 };
    }
  }
  return out;
}

/**
 * The method ingest boundary (§5.4.6).
 *
 * Fills every default from `globalDefaults`, resolves `INHERIT` flow against the previous ENABLED
 * block, converts every authored threshold through the §5.2 table (writing canonical numbers into
 * `threshold` / `startThreshold.value` / `slopeValue` and preserving `authoredAs` for a lossless
 * round trip), sorts `MULTI_SEGMENT` segments ascending, pre-splits every `TANK_LEVEL:<id>` signal
 * into `signalResolved = {base, tankIdx}`, and preserves `method._raw` untouched.
 *
 * Never mutates its input. Idempotent: conversion always reads `authoredAs`, so normalising an
 * already-normalised method returns the same numbers.
 *
 * @param {object} config  frozen config (units: canonical)
 * @param {object} method  a method in the §5.4.1 shape, authored or already normalised
 * @returns {object} a new normalised method; thresholds canonical (AU/cm, mS/cm, bar, mL, s, per mL)
 */
export function normalizeMethod(config, method) {
  const src = method || {};
  const gdSrc = src.globalDefaults || {};
  const gd = {
    flow: { mode: pick(gdSrc.flow && gdSrc.flow.mode, 'CM_H'), value: num(gdSrc.flow && gdSrc.flow.value, 150) },
    arm: { basis: pick(gdSrc.arm && gdSrc.arm.basis, 'CV'), value: num(gdSrc.arm && gdSrc.arm.value, 0.05) },
    persistence_ticks: Math.max(1, Math.round(num(gdSrc.persistence_ticks, 5))),
  };
  const blocksSrc = Array.isArray(src.blocks) ? src.blocks : [];
  const blocks = [];
  let prevEnabled = null;
  for (let i = 0; i < blocksSrc.length; i++) {
    const nb = normalizeBlock(config, blocksSrc[i], gd, prevEnabled, i);
    blocks.push(nb);
    if (nb.enabled) prevEnabled = nb;
  }
  return {
    schemaVersion: pick(src.schemaVersion, '2.0'),
    methodId: pick(src.methodId, 'm_local'),
    name: pick(src.name, 'Untitled method'),
    scale: pick(src.scale, config.scale),
    notes: pick(src.notes, ''),
    globalDefaults: gd,
    endState: {
      columnValve: pick(src.endState && src.endState.columnValve, 'BYPASS'),
      outletValve: pick(src.endState && src.endState.outletValve, 'WASTE'),
    },
    blocks,
    _raw: pick(src._raw, src),
  };
}

/**
 * Expand the §8.4.3 authoring shorthand into a full, normalised method.
 *
 * Ids are assigned `B01`, `B02`, … in array order; `name` defaults to a title-cased type; every
 * omitted field takes its §5.4 default. `frac:'PEAK'` expands to the §8.4.1 peak fractionation.
 *
 * @param {object} config
 * @param {Array<object>} shorthandPhases  §8.4.3 rows: {type, cv|mL|min, flow (cm/h), pctB (number
 *   or [start,end]), shape, inlets, sample, columnValve, outlet, frac, watch}
 * @returns {object} a normalised method (§5.4.1); every threshold canonical
 */
export function expandPresetMethod(config, shorthandPhases) {
  const phases = Array.isArray(shorthandPhases) ? shorthandPhases : [];
  const blocks = phases.map((p, i) => {
    const s = p || {};
    let duration;
    if (s.mL !== undefined) duration = { basis: 'mL', value: num(s.mL, 0) };
    else if (s.min !== undefined) duration = { basis: 'min', value: num(s.min, 0) };
    else duration = { basis: 'CV', value: num(s.cv, s.type === 'HOLD' ? 0 : 1) };
    const pctB = s.pctB;
    let gradient;
    if (Array.isArray(pctB)) {
      gradient = { startPctB: num(pctB[0], 0), endPctB: num(pctB[1], 0), shape: pick(s.shape, 'LINEAR') };
    } else {
      const p0 = num(pctB, 0);
      gradient = { startPctB: p0, endPctB: p0, shape: pick(s.shape, 'ISOCRATIC') };
    }
    let watches = [];
    if (s.watch) watches = Array.isArray(s.watch) ? s.watch.slice() : [s.watch];
    const frac = (s.frac === 'PEAK') ? defaultPeakFractionation() : (s.frac || { mode: 'OFF' });
    return {
      id: 'B' + String(i + 1).padStart(2, '0'),
      name: pick(s.name, titleCase(s.type)),
      type: s.type,
      enabled: pick(s.enabled, true),
      duration,
      flow: s.flow !== undefined ? { mode: 'CM_H', value: num(s.flow, 0) } : undefined,
      inlets: s.inlets,
      gradient,
      columnValve: s.columnValve,
      outletDefault: s.outlet,
      sample: s.sample ? { mode: s.sample, loopVolume_mL: pick(s.loopVolume_mL, null),
        chaseVolume_CV: num(s.chase_CV, 0) } : undefined,
      fractionation: frac,
      autozero: s.autozero,
      watches,
      notes: pick(s.notes, ''),
    };
  });
  return normalizeMethod(config, {
    schemaVersion: '2.0',
    methodId: 'm_preset',
    name: 'Preset method',
    scale: config.scale,
    globalDefaults: { flow: { mode: 'CM_H', value: 150 }, arm: { basis: 'CV', value: 0.05 },
      persistence_ticks: 5 },
    endState: { columnValve: 'BYPASS', outletValve: 'WASTE' },
    blocks,
    _raw: { shorthandPhases: phases },
  });
}

// ---------------------------------------------------------------------------------------------
// demand
// ---------------------------------------------------------------------------------------------

/**
 * Nominal static capacity for the product, mg per mL of COLUMN volume — the denominator of the
 * "load > 60 % of DBC" warning. SMA: `q_max = Lambda/(nu+sigma)` mM per mL of BEAD (BASIS N1), so
 * `mg/mL_col = q_max_mM * (1 - epsC) * MW_gmol / 1000` (R-U4). Returns 0 when it is not derivable,
 * which suppresses the warning rather than inventing a number.
 */
function nominalCapacity_mgPerMLcolumn(config) {
  const load = config.load;
  if (!load || !config.idxById) return 0;
  const idx = config.idxById[load.productSpeciesId];
  if (idx === undefined || !config.species || !config.species[idx]) return 0;
  const sp = config.species[idx];
  const col = config.column;
  let qmax_mM = 0;
  if (col.isothermMode === 'SMA') {
    const denom = num(sp.nu, 0) + num(sp.sigma, 0);
    if (denom > 0) qmax_mM = num(col.Lambda_mM, 0) / denom;
  } else {
    qmax_mM = num(sp.qmax_mM, 0);
  }
  if (!(qmax_mM > 0)) return 0;
  return qmax_mM * (1 - col.epsC) * num(sp.MW_gmol, 0) / 1000;
}

/** Mean %B over a block, by 21-point trapezoid on `targetPctB` — exact for every shipped shape. */
function meanPctB(config, block) {
  const N = 20;
  let sum = 0;
  for (let k = 0; k <= N; k++) {
    const w = (k === 0 || k === N) ? 0.5 : 1.0;
    sum += w * targetPctB(config, block, k / N);
  }
  return sum / N;
}

/**
 * Buffer demand for a whole method, used by PRC-02/PRC-03 and by `fluidics.remainingDemand_mL`.
 *
 * A/B demand is the integral of the %B split over each enabled block. A `LOAD` block with a sample
 * mode draws its whole volume from the sample tank plus `chaseVolume_CV` from the A tank. A `HOLD`
 * block has no finite volume (§5.4.3) and contributes nothing.
 *
 * @param {object} config
 * @param {object} method  a normalised method
 * @returns {{perTank:Object<string,number>, totalVolume_mL:number, totalTime_s:number,
 *           perBlock:Array<{id:string, volume_mL:number, time_s:number}>}}
 *   `perTank` values are mL, `totalVolume_mL` mL, `totalTime_s` s.
 */
export function methodDemand(config, method) {
  const perTank = Object.create(null);
  const perBlock = [];
  let totalVolume_mL = 0;
  let totalTime_s = 0;
  const blocks = (method && Array.isArray(method.blocks)) ? method.blocks : [];
  const assign = config.inletAssignments || {};
  const add = (port, mL) => {
    if (!port || !(mL > 0)) return;
    const tankId = assign[port];
    if (!tankId) return;
    perTank[tankId] = (perTank[tankId] || 0) + mL;
  };
  let prevEnabled = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.enabled) continue;
    const flow_mLs = blockFlow_mLs(config, b, prevEnabled);
    prevEnabled = b;
    let vol_mL = blockVolume_mL(config, b);
    if (!Number.isFinite(vol_mL) || vol_mL < 0) vol_mL = 0;      // HOLD: unbounded, counted as zero
    const time_s = (Number.isFinite(flow_mLs) && flow_mLs > 0) ? vol_mL / flow_mLs : 0;
    perBlock.push({ id: b.id, volume_mL: vol_mL, time_s });
    totalVolume_mL += vol_mL;
    totalTime_s += time_s;
    if (b.type === 'LOAD' && b.sample && b.sample.mode) {
      add(b.inlets.sample, vol_mL);
      add(b.inlets.a, num(b.sample.chaseVolume_CV, 0) * config.column.V_mL);
    } else {
      const xB = clamp(meanPctB(config, b), 0, 100) / 100;
      add(b.inlets.a, vol_mL * (1 - xB));
      add(b.inlets.b, vol_mL * xB);
    }
  }
  return { perTank, totalVolume_mL, totalTime_s, perBlock };
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function issue(list, blockId, field, level, code, message, fix) {
  list.push({ blockId, field, level, code, message, fix: fix || undefined });
}

/**
 * Validate a normalised method (§6.15). `Start` is disabled while any `error` exists.
 *
 * Errors: non-positive duration; %B outside 0–100; resolved flow outside [QminAbs, Qmax]; estimated
 * ΔP above the trip threshold; `ELUTION_LINEAR` with no `endPctB`; `LOOP_INJECT` with no loop
 * volume; a missing `GOTO_BLOCK` target; the smallest possible fraction shorter than 10·tSwitch_s;
 * an unknown tank in a `TANK_LEVEL:` signal; a slope-family watch on a tank level; and a block that
 * needs more than NSIG_MAX = 6 distinct slope-ring signals.
 * Warnings: gradient steeper than 10 %B/CV; load above 60 % of the nominal capacity; wash shorter
 * than 3 CV before an elution; buffer demand above tank volume; a flow change above 3× between
 * adjacent blocks; no `EQUILIBRATION` before a `LOAD`; an unrecognised authored unit.
 *
 * @param {object} config
 * @param {object} method  a normalised method
 * @returns {{ok:boolean, errors:Array<object>, warnings:Array<object>}} each entry is
 *   `{blockId, field, level, code, message, fix?}` with `fix = {label, apply(method)->method}`
 */
export function validateMethod(config, method) {
  const errors = [];
  const warnings = [];
  const blocks = (method && Array.isArray(method.blocks)) ? method.blocks : [];
  const ids = new Set(blocks.map((b) => b.id));
  const Qmin = config.skid.QminAbs_mLs;
  const Qmax = config.skid.Qmax_mLs;
  const tripRow = 1.00;   // ALM-DP-03, §5.6; the editor previews against the ΔP trip
  const tSwitch_s = (config.skid.fracValve && config.skid.fracValve.tSwitch_s) || 0.8;
  const seen = { equilibration: false };
  let prevEnabled = null;
  let prevFlow_mLs = NaN;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.enabled) continue;
    if (b.type === 'EQUILIBRATION') seen.equilibration = true;

    // duration
    if (b.type !== 'HOLD' && !(b.duration.value > 0)) {
      issue(errors, b.id, 'duration.value', 'error', 'DUR_NONPOSITIVE',
        'Block duration must be greater than zero.',
        { label: 'Set to 1 CV', apply: (m) => patchBlock(m, b.id, (x) => { x.duration.value = 1; x.duration.basis = 'CV'; }) });
    }
    // %B range
    if (b.gradient.startPctB < 0 || b.gradient.startPctB > 100
        || b.gradient.endPctB < 0 || b.gradient.endPctB > 100) {
      issue(errors, b.id, 'gradient', 'error', 'PCTB_RANGE', '%B must be between 0 and 100.',
        { label: 'Clamp to 0–100', apply: (m) => patchBlock(m, b.id, (x) => {
          x.gradient.startPctB = clamp(x.gradient.startPctB, 0, 100);
          x.gradient.endPctB = clamp(x.gradient.endPctB, 0, 100);
        }) });
    }
    // flow — HOLD is exempt, exactly as it is in engine.js's PRC-04. A hold parks the skid with
    // the pumps stopped, so Q = 0 is its correct flow; demanding Q >= Qmin here rejected three of
    // the four shipped presets outright and left Start doing nothing, because a terminal HOLD that
    // also bypasses the column must be at zero flow or the valve interlock trips.
    const Q_mLs = blockFlow_mLs(config, b, prevEnabled);
    if (b.type !== 'HOLD' && (!Number.isFinite(Q_mLs) || Q_mLs < Qmin || Q_mLs > Qmax)) {
      issue(errors, b.id, 'flow.value', 'error', 'FLOW_RANGE',
        'Resolved flow ' + (Number.isFinite(Q_mLs) ? (Q_mLs * 60).toFixed(2) + ' mL/min' : 'unresolved')
        + ' is outside [' + (Qmin * 60).toFixed(2) + ', ' + (Qmax * 60).toFixed(2) + '] mL/min.',
        { label: 'Clamp to the pump range', apply: (m) => patchBlock(m, b.id, (x) => {
          const q = clamp(Number.isFinite(Q_mLs) ? Q_mLs : Qmin, Qmin, Qmax);
          x.flow = { mode: 'ML_MIN', value: q * 60, rampOverride_mLs2: x.flow.rampOverride_mLs2 };
        }) });
    }
    // pressure
    const dP_bar = blockPressureEstimate_bar(config, b);
    if (dP_bar > tripRow) {
      issue(errors, b.id, 'flow.value', 'error', 'PRESSURE_TRIP',
        'Estimated column dP ' + dP_bar.toFixed(2) + ' bar exceeds the ' + tripRow.toFixed(2)
        + ' bar trip at this flow.');
    }
    // gradient completeness
    if (b.type === 'ELUTION_LINEAR' && !(Number.isFinite(b.gradient.endPctB))) {
      issue(errors, b.id, 'gradient.endPctB', 'error', 'NO_END_PCTB',
        'A linear elution needs an end %B.',
        { label: 'Set end %B to 100', apply: (m) => patchBlock(m, b.id, (x) => { x.gradient.endPctB = 100; }) });
    }
    // sample loop
    if (b.sample.mode === 'LOOP_INJECT' && (b.sample.loopVolume_mL === null || !(b.sample.loopVolume_mL > 0))) {
      issue(errors, b.id, 'sample.loopVolume_mL', 'error', 'LOOP_VOLUME_MISSING',
        'LOOP_INJECT needs a loop volume.');
    }
    // watches
    const slopeSignals = [];
    for (let k = 0; k < b.watches.length; k++) {
      const w = b.watches[k];
      if (w.action === 'GOTO_BLOCK' && !ids.has(w.actionParam)) {
        issue(errors, b.id, 'watches[' + k + '].actionParam', 'error', 'GOTO_TARGET_MISSING',
          'GOTO_BLOCK target "' + String(w.actionParam) + '" does not exist.');
      }
      if (w.signalResolved && w.signalResolved.base === 'TANK_LEVEL' && w.signalResolved.tankIdx < 0) {
        issue(errors, b.id, 'watches[' + k + '].signal', 'error', 'TANK_UNKNOWN',
          'Signal "' + w.signal + '" names a tank that does not exist.');
      }
      if (SLOPE_OPERATORS.indexOf(w.operator) >= 0) {
        if (w.signalResolved && w.signalResolved.base === 'TANK_LEVEL') {
          issue(errors, b.id, 'watches[' + k + '].operator', 'error', 'SLOPE_ON_TANK_LEVEL',
            'Slope, STABLE and PLATEAU watches cannot run on a tank level.');
        } else if (slopeSignals.indexOf(w.signal) < 0) {
          slopeSignals.push(w.signal);
        }
      }
      if (w.authoredAs && w.authoredAs.unit && !KNOWN_UNITS.has(w.authoredAs.unit)) {
        issue(warnings, b.id, 'watches[' + k + '].authoredAs.unit', 'warn', 'UNIT_UNKNOWN',
          'Unrecognised unit "' + w.authoredAs.unit + '"; the value was taken as already canonical.');
      }
    }
    if (b.fractionation.mode !== 'OFF' && slopeSignals.indexOf(b.fractionation.signal) < 0) {
      slopeSignals.push(b.fractionation.signal);
    }
    if (slopeSignals.length > NSIG_MAX) {
      issue(errors, b.id, 'watches', 'error', 'TOO_MANY_SLOPE_SIGNALS',
        'This block needs ' + slopeSignals.length + ' slope-ring signals; the limit is ' + NSIG_MAX + '.');
    }
    // fractionation timing
    if (b.fractionation.mode !== 'OFF' && Number.isFinite(Q_mLs) && Q_mLs > 0) {
      const f = b.fractionation;
      const smallest_mL = (f.mode === 'FIXED_VOLUME' || f.mode === 'FIXED_TIME')
        ? Math.min(basisToVolume_mL(config, f.fixedVolume.basis, f.fixedVolume.value, Q_mLs),
          basisToVolume_mL(config, f.minFractionVolume.basis, f.minFractionVolume.value, Q_mLs) || Infinity)
        : basisToVolume_mL(config, f.minFractionVolume.basis, f.minFractionVolume.value, Q_mLs);
      const smallest_s = smallest_mL / Q_mLs;
      if (smallest_s < 10 * tSwitch_s) {
        issue(errors, b.id, 'fractionation.minFractionVolume', 'error', 'FRACTION_TOO_SHORT',
          'The smallest fraction lasts ' + smallest_s.toFixed(2) + ' s, below the '
          + (10 * tSwitch_s).toFixed(2) + ' s minimum (10 x valve switch time).');
      }
    }
    // ---- warnings -------------------------------------------------------------------------
    const vol_mL = blockVolume_mL(config, b);
    if (b.gradient.shape !== 'ISOCRATIC' && Number.isFinite(vol_mL) && vol_mL > 0) {
      const cv = vol_mL / config.column.V_mL * Math.max(b.gradient.lengthFraction, 1e-9);
      const slope = Math.abs(b.gradient.endPctB - b.gradient.startPctB) / Math.max(cv, 1e-9);
      if (slope > 10) {
        issue(warnings, b.id, 'gradient', 'warn', 'STEEP_GRADIENT',
          'Gradient is ' + slope.toFixed(1) + ' %B/CV — steep, expect co-elution.');
      }
    }
    if (b.type === 'LOAD' && config.load && config.load.basis === 'MG_PER_ML_RESIN') {
      const dbc_mgmL = nominalCapacity_mgPerMLcolumn(config);
      if (dbc_mgmL > 0 && config.load.value > 0.6 * dbc_mgmL) {
        issue(warnings, b.id, 'duration.value', 'warn', 'HIGH_LOAD',
          'Load is above 60 % of the nominal capacity — expect breakthrough.');
      }
    }
    if (b.type === 'WASH' && Number.isFinite(vol_mL) && vol_mL < 3 * config.column.V_mL) {
      const next = blocks[i + 1];
      if (next && next.enabled && String(next.type).indexOf('ELUTION') === 0) {
        issue(warnings, b.id, 'duration.value', 'warn', 'SHORT_WASH',
          'Wash is shorter than 3 CV before an elution — expect a dirty peak.');
      }
    }
    if (Number.isFinite(prevFlow_mLs) && Number.isFinite(Q_mLs) && prevFlow_mLs > 0 && Q_mLs > 0) {
      const r = Q_mLs / prevFlow_mLs;
      if (r > 3 || r < 1 / 3) {
        issue(warnings, b.id, 'flow.value', 'warn', 'FLOW_SHOCK',
          'Flow changes by ' + (r > 1 ? r.toFixed(1) + 'x up' : (1 / r).toFixed(1) + 'x down')
          + ' from the previous block — pressure shock.');
      }
    }
    if (b.type === 'LOAD' && !seen.equilibration) {
      issue(warnings, b.id, 'type', 'warn', 'NO_EQUILIBRATION',
        'No EQUILIBRATION block runs before this LOAD.');
    }
    prevEnabled = b;
    prevFlow_mLs = Q_mLs;
  }

  // whole-method demand vs tank volumes
  const demand = methodDemand(config, method);
  const tanks = config.tanks || [];
  for (let k = 0; k < tanks.length; k++) {
    const need = demand.perTank[tanks[k].id] || 0;
    if (need > num(tanks[k].startVolume_mL, 0)) {
      issue(warnings, null, 'tanks', 'warn', 'TANK_SHORT',
        'Tank ' + tanks[k].id + ' needs ' + Math.round(need) + ' mL but holds '
        + Math.round(num(tanks[k].startVolume_mL, 0)) + ' mL.');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Deep-ish clone of a method with one block patched — the substrate of every one-click `fix`. */
function patchBlock(method, blockId, mutate) {
  const out = { ...method, blocks: method.blocks.map((b) => (b.id === blockId ? deepCopyBlock(b) : b)) };
  const target = out.blocks.find((b) => b.id === blockId);
  if (target) mutate(target);
  return out;
}

function deepCopyBlock(b) {
  return {
    ...b,
    duration: { ...b.duration },
    flow: { ...b.flow },
    inlets: { ...b.inlets },
    gradient: { ...b.gradient, segments: b.gradient.segments ? b.gradient.segments.map((s) => ({ ...s })) : null },
    sample: { ...b.sample },
    fractionation: { ...b.fractionation },
    watches: b.watches.map((w) => ({ ...w })),
  };
}
