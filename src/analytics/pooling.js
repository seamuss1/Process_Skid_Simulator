/**
 * src/analytics/pooling.js — pool metrics, the species mass balance, auto-pooling and the
 * packing-test HETP correction (architecture-v2 §5.11.3–§5.11.5, §6.20, §7.6).
 *
 * Layer L2: imports `core/util.js`, `core/log.js` and `analytics/peaks.js` ONLY.
 * It must NOT import `physics/bed.js` — §4 deleted that edge as an upward layer violation, and
 * `massBalance` therefore treats a prior `bed.forceFlush` as a PRECONDITION it validates and
 * reports (`flushed`), never as something it triggers.
 *
 * UNITS (§1). Amounts are µmol (R-U4: `mM * mL = µmol`), masses mg, concentrations g/L at the
 * reporting boundary only (R-U3), volumes mL, conductivity mS/cm, pressure bar, length cm.
 *
 * ALLOCATION. Everything here runs at operator rate, where §13 item 5 permits allocation.
 */

import { clamp, mg_from_umol } from '../core/util.js';
import { column as logColumnRaw } from '../core/log.js';
import { trapzArea, resampleUniformV } from './peaks.js';

/** Species roles that make up the "protein" basis for purity and aggregate fractions. */
const PROTEIN_ROLES = { product: 1, impurity: 1, aggregate: 1 };

/** DoD item 7 closure tolerance (§13). */
const XI_TOL = 1e-6;

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                        */
/* -------------------------------------------------------------------------- */

function logColumn(store, name) {
  if (!store || !store.index || !store.index.has(name)) return null;
  return logColumnRaw(store, name);
}

function productIndex(config) {
  const id = config.load && config.load.productSpeciesId;
  if (id && config.idxById && config.idxById[id] !== undefined) return config.idxById[id];
  for (let i = 0; i < config.ns; i++) if (config.species[i].role === 'product') return i;
  return -1;
}

function isProtein(sp) {
  return PROTEIN_ROLES[sp.role] === 1;
}

function ensureF64(buf, n) {
  if (buf && buf.length >= n) return buf;
  return new Float64Array(Math.max(n, 16));
}

/* -------------------------------------------------------------------------- */
/* Grid-aligned auxiliary series (conductivity, pH, per-species truth)         */
/* -------------------------------------------------------------------------- */

/**
 * Auxiliary traces resampled onto THE grid. Index-aligned with `grid.V` by construction: the same
 * source `V_mL` channel and the same `dV_mL` produce the same abscissa (§6.19).
 */
const _series = {
  grid: null, logN: -1, n: 0,
  outV: null, cond: null, ph: null,
  truth: null, truthBuf: null, truthLogN: -1, truthGrid: null,
};

function fillNaN(arr, from, to) {
  for (let k = from; k < to; k++) arr[k] = NaN;
}

function buildSeries(config, run, grid, wantTruth) {
  const store = run.log;
  const logN = store && store.n ? store.n : 0;
  const nGrid = grid.n | 0;

  if (_series.grid !== grid || _series.logN !== logN) {
    _series.grid = grid;
    _series.logN = logN;
    _series.n = 0;
    _series.truth = null;
    _series.truthLogN = -1;
    _series.truthGrid = null;

    const V = logColumn(store, 'V_mL');
    if (V && logN > 0 && nGrid > 0) {
      _series.outV = ensureF64(_series.outV, nGrid);
      _series.cond = ensureF64(_series.cond, nGrid);
      _series.ph = ensureF64(_series.ph, nGrid);
      const condSrc = logColumn(store, 'cond_mS_cm');
      const phSrc = logColumn(store, 'pH');
      let count = nGrid;
      if (condSrc) {
        const c = resampleUniformV(V, condSrc, logN, grid.dV_mL, _series.outV, _series.cond);
        fillNaN(_series.cond, c, nGrid);
        count = Math.min(count, c);
      } else {
        fillNaN(_series.cond, 0, nGrid);
      }
      if (phSrc) {
        const c = resampleUniformV(V, phSrc, logN, grid.dV_mL, _series.outV, _series.ph);
        fillNaN(_series.ph, c, nGrid);
        count = Math.min(count, c);
      } else {
        fillNaN(_series.ph, 0, nGrid);
      }
      _series.n = Math.min(count, nGrid);
    }
  }

  if (wantTruth && (_series.truth === null || _series.truthLogN !== logN || _series.truthGrid !== grid)) {
    const V = logColumn(store, 'V_mL');
    const ns = config.ns;
    if (V && store && store.truth && store.truth.length >= ns && logN > 0 && nGrid > 0) {
      if (!_series.truthBuf || _series.truthBuf.length !== ns) _series.truthBuf = new Array(ns).fill(null);
      const scratchV = ensureF64(_series.outV, nGrid);
      _series.outV = scratchV;
      for (let i = 0; i < ns; i++) {
        const dst = ensureF64(_series.truthBuf[i], nGrid);
        _series.truthBuf[i] = dst;
        const src = store.truth[i] ? store.truth[i].subarray(0, logN) : null;
        if (src) fillNaN(dst, resampleUniformV(V, src, logN, grid.dV_mL, scratchV, dst), nGrid);
        else fillNaN(dst, 0, nGrid);
      }
      _series.truth = _series.truthBuf;
    } else {
      _series.truth = null;
    }
    _series.truthLogN = logN;
    _series.truthGrid = grid;
  }

  return _series;
}

/** Mean of a grid-aligned series over [i0,i1]; NaN when unavailable. */
function meanOver(arr, i0, i1) {
  if (!arr) return NaN;
  let s = 0;
  let n = 0;
  for (let k = i0; k <= i1; k++) {
    const v = arr[k];
    if (Number.isFinite(v)) { s += v; n++; }
  }
  return n > 0 ? s / n : NaN;
}

/* -------------------------------------------------------------------------- */
/* poolMetrics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Metrics for a pool defined as an index window on THE uniform-volume grid.
 *
 * `mode: 'truth'` reads the per-species `run.log.truth` channels (detector-plane `run.yDet_mM`,
 * §5.11.3) and resolves every species. `mode: 'detector'` has only the single-wavelength UV trace,
 * so the ONLY per-species number an operator could actually produce is the product mass from
 * `area / eps280_product`; every quantity that requires a species split — purity, aggregate
 * fraction, per-species LRV — is returned as NaN, which is this contract's "not evaluable" value
 * (§5.2). It is not returned as 1.0: a detector cannot see purity, and reporting 1.0 would state
 * the opposite.
 *
 * @param {object} config - frozen config (§2.1).
 * @param {object} run - mutable run state (§2.2).
 * @param {{V:Float64Array, y:Float64Array, n:number, dV_mL:number}} grid - the
 *   `peaks.buildVolumeGrid` object, PASSED IN and never rebuilt here (§6.20).
 * @param {number} i0 - first grid index of the pool (inclusive).
 * @param {number} i1 - last grid index of the pool (inclusive).
 * @param {'detector'|'truth'} mode - data source.
 * @returns {{V_pool_mL:number, mass_mg:Float64Array, meanConc_gL:Float64Array, yield_frac:number,
 *   purityMass_frac:number, purityArea_frac:number, aggregate_frac:number, lrv:Float64Array,
 *   concentrationFactor:number, productivity_gLh:number, bufferConsumption_L_per_g:number,
 *   meanCond_mScm:number, meanPH:number, mode:string}} PoolMetrics (§5.11.3). `V_pool_mL` mL,
 *   `mass_mg` mg per species (length ns), `meanConc_gL` g/L per species, fractions dimensionless
 *   0..1, `lrv` log10 per species, `productivity_gLh` g of product per L of column volume per hour,
 *   `bufferConsumption_L_per_g` L of mobile phase per g of product, `meanCond_mScm` mS/cm,
 *   `meanPH` pH.
 */
export function poolMetrics(config, run, grid, i0, i1, mode) {
  const ns = config.ns;
  const useTruth = mode === 'truth';
  const nGrid = grid.n | 0;

  let a = clamp(i0 | 0, 0, Math.max(0, nGrid - 1));
  let b = clamp(i1 | 0, 0, Math.max(0, nGrid - 1));
  if (b < a) { const t = a; a = b; b = t; }

  const mass_mg = new Float64Array(ns);
  const meanConc_gL = new Float64Array(ns);
  const lrv = new Float64Array(ns);
  mass_mg.fill(0);
  meanConc_gL.fill(NaN);
  lrv.fill(NaN);

  const V_pool_mL = (b - a) * grid.dV_mL;
  const series = buildSeries(config, run, grid, useTruth);
  const iProd = productIndex(config);

  let purityMass_frac = NaN;
  let purityArea_frac = NaN;
  let aggregate_frac = NaN;

  if (nGrid > 0 && b > a) {
    if (useTruth && series.truth) {
      for (let i = 0; i < ns; i++) {
        const umol = trapzArea(grid.V, series.truth[i], a, b, null);   // mM * mL = umol (R-U4)
        mass_mg[i] = mg_from_umol(umol, config.species[i].MW_gmol);
      }
      let protMass = 0;
      let protArea = 0;
      let aggMass = 0;
      for (let i = 0; i < ns; i++) {
        const sp = config.species[i];
        if (!isProtein(sp)) continue;
        protMass += mass_mg[i];
        protArea += (sp.eps280_Lgcm || 0) * mass_mg[i];
        if (sp.role === 'aggregate') aggMass += mass_mg[i];
      }
      if (iProd >= 0 && protMass > 0) {
        purityMass_frac = mass_mg[iProd] / protMass;
        aggregate_frac = aggMass / protMass;
      }
      if (iProd >= 0 && protArea > 0) {
        purityArea_frac = (config.species[iProd].eps280_Lgcm || 0) * mass_mg[iProd] / protArea;
      }
    } else if (iProd >= 0) {
      // Detector mode: the whole 280 nm area is attributed to the product, using the product's own
      // mass extinction coefficient. This over-reads by whatever the impurities absorb — which is
      // exactly the error an operator makes with an A280 pool assay, and is why the truth-mode
      // purity carries the "you would not know this in the lab" hint in the results view.
      const area_AUcm_mL = trapzArea(grid.V, grid.y, a, b, null);
      const eps = config.species[iProd].eps280_Lgcm;
      mass_mg[iProd] = eps > 0 ? area_AUcm_mL / eps : NaN;   // (AU/cm * mL)/(L/g/cm) = mg
    }

    if (useTruth && !series.truth) mass_mg.fill(NaN);   // truth requested, no truth store: say so

    if (V_pool_mL > 0) {
      const resolved = useTruth ? series.truth !== null : false;
      for (let i = 0; i < ns; i++) {
        // mg / mL is g/L exactly.
        meanConc_gL[i] = (resolved || i === iProd) ? mass_mg[i] / V_pool_mL : NaN;
      }
    }
  }

  // Log reduction values against what was actually delivered from the sample tank.
  for (let i = 0; i < ns; i++) {
    const loaded_mg = mg_from_umol(run.massLoad_umol[i], config.species[i].MW_gmol);
    if (!(loaded_mg > 0)) { lrv[i] = NaN; continue; }
    const pooled = mass_mg[i];
    if (!Number.isFinite(pooled)) { lrv[i] = NaN; continue; }
    lrv[i] = pooled > 0 ? Math.log10(loaded_mg / pooled) : Infinity;
  }

  // Yield: pooled product against product delivered. Falls back to the planned load when nothing
  // has been delivered yet (config.load.derived.mass_g is grams).
  let yield_frac = NaN;
  if (iProd >= 0) {
    let loadedProd_mg = mg_from_umol(run.massLoad_umol[iProd], config.species[iProd].MW_gmol);
    if (!(loadedProd_mg > 0) && config.load && config.load.derived) {
      loadedProd_mg = config.load.derived.mass_g * 1000;
    }
    if (loadedProd_mg > 0) yield_frac = mass_mg[iProd] / loadedProd_mg;
  }

  const prodMass_mg = iProd >= 0 ? mass_mg[iProd] : NaN;
  const prodConc_gL = iProd >= 0 ? meanConc_gL[iProd] : NaN;
  const titer_gL = config.load ? config.load.productTiter_gL : NaN;
  const concentrationFactor = titer_gL > 0 ? prodConc_gL / titer_gL : NaN;
  const hours = run.t_s / 3600;
  const productivity_gLh = hours > 0 ? (prodMass_mg / config.column.V_mL) / hours : NaN;
  const bufferConsumption_L_per_g = prodMass_mg > 0 ? run.V_run_mL / prodMass_mg : NaN;

  return {
    V_pool_mL,
    mass_mg,
    meanConc_gL,
    yield_frac,
    purityMass_frac,
    purityArea_frac,
    aggregate_frac,
    lrv,
    concentrationFactor,
    productivity_gLh,
    bufferConsumption_L_per_g,
    meanCond_mScm: meanOver(series.cond, a, b),
    meanPH: meanOver(series.ph, a, b),
    mode: useTruth ? 'truth' : 'detector',
  };
}

/* -------------------------------------------------------------------------- */
/* massBalance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The species mass balance, off the SOLVER-SIDE accumulators (§5.11.4).
 *
 * It CANNOT flush the column batch — `analytics/pooling.js` is L2 and `physics/bed.js` is L3 — so
 * the flush is a precondition it validates: with `run.colBatch.dt_s + carryDt_s` non-zero it
 * returns `flushed:false, ok:false`. Callers (`ui/view_results.js`, `tests/*`) call
 * `bed.forceFlush(config, run, 'MASS_AUDIT')` first.
 *
 * `in`/`out` come off the COLUMN plane (`run.col.massIn_umol` / `massOut_umol` through
 * `config.colIdxOf`), falling back to the skid-plane totals only for non-transported species; the
 * skid-plane numbers lead and lag by up to one batch (|xi| ~ 1.7e-4) and are not the audit.
 *
 * AMBIGUITY RESOLVED, recorded here: §5.11.4 writes `column_umol` as the column HOLD-UP, but the
 * declared signature takes no caller-supplied array, and the raw hold-up cannot close the balance
 * for a species the column already held at equilibration (Na fills the pores without ever having
 * "entered"). `column_umol` is therefore the column hold-up NET OF ITS INITIAL CHARGE,
 * `totalMass_umol - col.mass0_umol`, computed inline from `run.col` — the only reading under which
 * DoD item 7's |xi| < 1e-6 is reachable.
 *
 * @param {object} config - frozen config (§2.1); reads `ns`, `colIdxOf`, `species[].MW_gmol`.
 * @param {object} run - mutable run state (§2.2); reads `colBatch`, `col`, `massIn/Out/Pool_umol`,
 *   `massDefect_umol`, `log`.
 * @returns {{xi:Float64Array, ok:boolean, flushed:boolean, in_umol:Float64Array,
 *   out_umol:Float64Array, column_umol:Float64Array, pool_umol:Float64Array,
 *   defect_umol:Float64Array, logDerived_umol:Float64Array}} MassBalance (§5.11.4). Every array is
 *   length `ns` and in µmol except `xi`, which is dimensionless.
 */
export function massBalance(config, run) {
  const ns = config.ns;
  const res = {
    xi: new Float64Array(ns),
    ok: false,
    flushed: false,
    in_umol: new Float64Array(ns),
    out_umol: new Float64Array(ns),
    column_umol: new Float64Array(ns),
    pool_umol: new Float64Array(ns),
    defect_umol: new Float64Array(ns),
    logDerived_umol: new Float64Array(ns),
  };

  const cb = run.colBatch;
  const pending = cb ? Math.abs(cb.dt_s || 0) + Math.abs(cb.carryDt_s || 0) : 0;
  res.flushed = !(pending > 0);

  const colIdxOf = config.colIdxOf;
  const col = run.col;

  // Column hold-up, net of the initial charge, mapped registry index <- column index.
  if (col && col.c && col.q) {
    const nz = col.nz;
    const epsC = col.epsC;
    const solidFrac = 1 - epsC;
    const Vcell_mL = col.Vcell_mL;
    for (let i = 0; i < ns; i++) {
      const j = colIdxOf[i];
      if (j < 0) continue;
      const base = j * nz;
      let sum = 0;
      let comp = 0;
      for (let cell = 0; cell < nz; cell++) {
        const term = epsC * col.c[base + cell] + solidFrac * col.q[base + cell];
        const t = sum + term;
        if (Math.abs(sum) >= Math.abs(term)) comp += (sum - t) + term;
        else comp += (term - t) + sum;
        sum = t;
      }
      const total_umol = (sum + comp) * Vcell_mL;               // mM * mL = umol
      const initial_umol = col.mass0_umol ? col.mass0_umol[j] : 0;
      res.column_umol[i] = total_umol - initial_umol;
    }
  }

  for (let i = 0; i < ns; i++) {
    const j = colIdxOf[i];
    const inU = (j >= 0 && col && col.massIn_umol) ? col.massIn_umol[j] : run.massIn_umol[i];
    const outU = (j >= 0 && col && col.massOut_umol) ? col.massOut_umol[j] : run.massOut_umol[i];
    res.in_umol[i] = inU;
    res.out_umol[i] = outU;
    res.pool_umol[i] = run.massPool_umol[i];
    res.defect_umol[i] = run.massDefect_umol[i];
    res.xi[i] = (inU - outU - res.column_umol[i] - res.defect_umol[i]) / Math.max(inU, 1e-12);
  }

  // Logging-fidelity diagnostic: re-integrate the detector-plane truth channels against the logged
  // volume. Reported separately and NEVER used in xi.
  const store = run.log;
  const logN = store && store.n ? store.n : 0;
  const V = logColumn(store, 'V_mL');
  if (V && logN > 1 && store.truth && store.truth.length >= ns) {
    for (let i = 0; i < ns; i++) {
      const src = store.truth[i] ? store.truth[i].subarray(0, logN) : null;
      res.logDerived_umol[i] = src ? trapzArea(V, src, 0, logN - 1, null) : NaN;
    }
  } else {
    res.logDerived_umol.fill(NaN);
  }

  let ok = res.flushed;
  for (let i = 0; i < ns && ok; i++) {
    if (!(Math.abs(res.xi[i]) < XI_TOL)) ok = false;
  }
  res.ok = ok;
  return res;
}

/* -------------------------------------------------------------------------- */
/* Signal selection on the grid                                                */
/* -------------------------------------------------------------------------- */

/** §5.2 signal name -> §5.1 log channel and the factor that converts it to canonical units. */
const SIGNAL_CHANNEL = {
  UV_260: { channel: 'UV_260_mAU', uvScaled: true },
  UV_300: { channel: 'UV_300_mAU', uvScaled: true },
  COND: { channel: 'cond_mS_cm', scale: 1 },
  COND_TEMP_COMP: { channel: 'cond_mS_cm', scale: 1 },
  COND_RAW: { channel: 'cond_raw_mS_cm', scale: 1 },
  PH: { channel: 'pH', scale: 1 },
  P1: { channel: 'P1_bar', scale: 1 },
  P2: { channel: 'P2_bar', scale: 1 },
  DP: { channel: 'dP_bar', scale: 1 },
  PCTB: { channel: 'pctB_column_inlet', scale: 1 },
  AIR: { channel: 'air_fraction', scale: 1 },
  FLOW: { channel: 'flow_mL_min', scale: 1 / 60 },
};

let _signalScratch = null;
let _signalScratchV = null;

/**
 * A grid-aligned series for a §5.2 signal name. `UV_280` (and any unrecognised name) resolves to
 * `grid.y`, which already carries the source channel in AU/cm.
 */
function signalSeries(config, run, grid, name) {
  if (!name || name === 'UV_280') return grid.y;
  const spec = SIGNAL_CHANNEL[name];
  if (!spec) return grid.y;
  const store = run.log;
  const logN = store && store.n ? store.n : 0;
  const V = logColumn(store, 'V_mL');
  const src = logColumn(store, spec.channel);
  if (!V || !src || logN < 1 || grid.n < 1) return grid.y;
  const path_cm = (config.skid && config.skid.uv && config.skid.uv.pathlength_cm) || 1;
  const scale = spec.uvScaled ? 1 / (1000 * path_cm) : spec.scale;
  _signalScratchV = ensureF64(_signalScratchV, grid.n);
  _signalScratch = ensureF64(_signalScratch, grid.n);
  const tmp = ensureF64(null, logN);
  for (let k = 0; k < logN; k++) tmp[k] = src[k] * scale;
  const count = resampleUniformV(V, tmp, logN, grid.dV_mL, _signalScratchV, _signalScratch);
  for (let k = count; k < grid.n; k++) _signalScratch[k] = NaN;   // never extrapolate past the log
  return _signalScratch;
}

/* -------------------------------------------------------------------------- */
/* autoPool                                                                    */
/* -------------------------------------------------------------------------- */

/** Cumulative trapezoid of `y` against `grid.V`; C[k] = integral from index 0 to k. */
function cumulative(grid, y, n) {
  const C = new Float64Array(n);
  let s = 0;
  for (let k = 1; k < n; k++) {
    s += 0.5 * (y[k - 1] + y[k]) * (grid.V[k] - grid.V[k - 1]);
    C[k] = s;
  }
  return C;
}

/**
 * Choose a pool window automatically.
 *
 * `THRESHOLD` and `APEX_PCT` grow a contiguous window outward from the tallest sample of the named
 * signal while it stays at or above the cut (`value` in canonical signal units for `THRESHOLD`;
 * a percentage of the apex — or a 0..1 fraction — for `APEX_PCT`).
 *
 * `PURITY` needs a species split, so it uses the `run.log.truth` channels: starting at the product
 * apex it repeatedly extends the side that adds more product mass, and stops as soon as neither
 * side can be added without the pool's mass purity falling below `value`. This is the standard
 * "maximum yield at a purity constraint" cut. With no truth store available it degrades to
 * `APEX_PCT` at 10 %, which is recorded here rather than failing silently.
 *
 * @param {object} config - frozen config.
 * @param {object} run - run state.
 * @param {{V:Float64Array, y:Float64Array, n:number, dV_mL:number}} grid - the shared grid.
 * @param {{type:'THRESHOLD'|'PURITY'|'APEX_PCT', value:number, signal:string}} criterion -
 *   `value` is in the canonical unit of `signal` for THRESHOLD (AU/cm for UV, mS/cm for COND,
 *   bar for pressure), a percent or 0..1 fraction for APEX_PCT and PURITY.
 * @returns {{i0:number, i1:number}} inclusive grid indices of the chosen pool.
 */
export function autoPool(config, run, grid, criterion) {
  const n = grid.n | 0;
  if (n < 2) return { i0: 0, i1: 0 };
  const crit = criterion || {};
  const type = crit.type || 'THRESHOLD';
  const rawValue = crit.value;

  if (type === 'PURITY') {
    const series = buildSeries(config, run, grid, true);
    const iProd = productIndex(config);
    if (series.truth && iProd >= 0) {
      const target = rawValue > 1 ? rawValue / 100 : rawValue;
      const ns = config.ns;
      const protIdx = [];
      for (let i = 0; i < ns; i++) if (isProtein(config.species[i])) protIdx.push(i);
      const cum = {};
      for (let p = 0; p < protIdx.length; p++) {
        const i = protIdx[p];
        cum[i] = cumulative(grid, series.truth[i], n);
      }
      const prodTrace = series.truth[iProd];
      let apex = 0;
      for (let k = 1; k < n; k++) if (prodTrace[k] > prodTrace[apex]) apex = k;
      // Seed one interval wide: a zero-width window integrates to zero mass on every species and
      // would report purity 0, so the greedy loop could never take its first step.
      let a = Math.max(0, apex - 1);
      let b = Math.min(n - 1, apex + 1);
      const purityOf = (lo, hi) => {
        let prod = 0;
        let tot = 0;
        for (let p = 0; p < protIdx.length; p++) {
          const i = protIdx[p];
          const umol = cum[i][hi] - cum[i][lo];
          const mg = mg_from_umol(umol, config.species[i].MW_gmol);
          tot += mg;
          if (i === iProd) prod = mg;
        }
        return tot > 0 ? prod / tot : 0;
      };
      for (;;) {
        const canL = a > 0;
        const canR = b < n - 1;
        if (!canL && !canR) break;
        const gainL = canL ? prodTrace[a - 1] : -Infinity;
        const gainR = canR ? prodTrace[b + 1] : -Infinity;
        const order = gainL >= gainR ? [0, 1] : [1, 0];
        let moved = false;
        for (let s = 0; s < 2 && !moved; s++) {
          if (order[s] === 0 && canL && purityOf(a - 1, b) >= target) { a--; moved = true; }
          else if (order[s] === 1 && canR && purityOf(a, b + 1) >= target) { b++; moved = true; }
        }
        if (!moved) break;
      }
      return { i0: a, i1: b };
    }
    // Fall through to APEX_PCT at 10 % when there is no truth store.
    return autoPool(config, run, grid, { type: 'APEX_PCT', value: 10, signal: crit.signal });
  }

  const sig = signalSeries(config, run, grid, crit.signal);
  let apex = 0;
  for (let k = 1; k < n; k++) if (sig[k] > sig[apex]) apex = k;
  let threshold;
  if (type === 'APEX_PCT') {
    const frac = rawValue > 1 ? rawValue / 100 : rawValue;
    threshold = sig[apex] * frac;
  } else {
    threshold = rawValue;
  }
  let a = apex;
  let b = apex;
  while (a > 0 && sig[a - 1] >= threshold) a--;
  while (b < n - 1 && sig[b + 1] >= threshold) b++;
  return { i0: a, i1: b };
}

/* -------------------------------------------------------------------------- */
/* rePool                                                                      */
/* -------------------------------------------------------------------------- */

function indexOfVolume(grid, V_mL) {
  const k = Math.round((V_mL - grid.V[0]) / grid.dV_mL);
  return clamp(k, 0, Math.max(0, grid.n - 1));
}

/**
 * Re-cut the pool from a rule and return the window together with its metrics.
 *
 * Supported rules (`rule.type`, defaulted from the fields present):
 *   `{ type:'INDEX', i0, i1 }`                     — explicit grid indices.
 *   `{ type:'VOLUME', startV_mL, endV_mL }`        — detector-plane volumes, mL.
 *   `{ type:'CV', startV_CV, endV_CV }`            — column volumes.
 *   `{ type:'FRACTIONS', ports:string[] }` or `{ type:'FRACTIONS', indices:number[] }`
 *                                                  — the union span of the named fraction records.
 *   `{ type:'CRITERION', criterion:{...} }`        — delegates to `autoPool`.
 * `rule.mode` ('detector' | 'truth', default 'detector') selects the metrics data source.
 *
 * @param {object} config - frozen config.
 * @param {object} run - run state.
 * @param {{V:Float64Array, y:Float64Array, n:number, dV_mL:number}} grid - the shared grid.
 * @param {object} rule - as above.
 * @returns {{i0:number, i1:number, metrics:object}} inclusive grid indices and the PoolMetrics
 *   (§5.11.3) for that window.
 */
export function rePool(config, run, grid, rule) {
  const r = rule || {};
  const n = grid.n | 0;
  let type = r.type;
  if (!type) {
    if (r.i0 !== undefined) type = 'INDEX';
    else if (r.startV_mL !== undefined) type = 'VOLUME';
    else if (r.startV_CV !== undefined) type = 'CV';
    else if (r.ports || r.indices) type = 'FRACTIONS';
    else type = 'CRITERION';
  }

  let i0 = 0;
  let i1 = Math.max(0, n - 1);

  if (type === 'INDEX') {
    i0 = r.i0 | 0;
    i1 = r.i1 | 0;
  } else if (type === 'VOLUME') {
    i0 = indexOfVolume(grid, r.startV_mL);
    i1 = indexOfVolume(grid, r.endV_mL);
  } else if (type === 'CV') {
    i0 = indexOfVolume(grid, r.startV_CV * config.column.V_mL);
    i1 = indexOfVolume(grid, r.endV_CV * config.column.V_mL);
  } else if (type === 'FRACTIONS') {
    const records = (run.frac && run.frac.records) || [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < records.length; k++) {
      const rec = records[k];
      const wanted = r.ports ? r.ports.indexOf(rec.port) >= 0 : r.indices.indexOf(rec.index) >= 0;
      if (!wanted) continue;
      if (rec.startVolume_mL < lo) lo = rec.startVolume_mL;
      if (rec.endVolume_mL > hi) hi = rec.endVolume_mL;
    }
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      i0 = indexOfVolume(grid, lo);
      i1 = indexOfVolume(grid, hi);
    } else {
      i0 = 0;
      i1 = 0;
    }
  } else {
    const auto = autoPool(config, run, grid, r.criterion || r);
    i0 = auto.i0;
    i1 = auto.i1;
  }

  i0 = clamp(i0, 0, Math.max(0, n - 1));
  i1 = clamp(i1, 0, Math.max(0, n - 1));
  if (i1 < i0) { const t = i0; i0 = i1; i1 = t; }

  return { i0, i1, metrics: poolMetrics(config, run, grid, i0, i1, r.mode === 'truth' ? 'truth' : 'detector') };
}

/* -------------------------------------------------------------------------- */
/* analysePackingTest                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Packing-test plate count with the extra-column correction (§7.6, §5.11.5).
 *
 * ```
 * N_apparent  = 5.54 * (V_R/W50)^2
 * sigma_meas  = V_R / sqrt(N_apparent)
 * sigma_col^2 = sigma_meas^2 - sigma_extracolumn^2      (must be > 0, else INDETERMINATE)
 * N_corrected = (V_R/sigma_col)^2
 * HETP        = L_cm / N
 * ```
 * `N_per_m` is reported from the CORRECTED count — the column's own quality — and drives the
 * verdict. `sigma_extracolumn_mL` is an ARGUMENT: `analytics/*` never imports `skid/*` (§4); the
 * caller supplies `config.skid.holdup.sigmaInjToUV_mL`.
 *
 * Fixture PT-1 (§7.6): `sigma_ec = 0.25606 mL`, `V_R = 7.08822 mL`, true `N = 500` gives
 * `N_apparent = 302.6` and `N_corrected = 500.0`.
 *
 * @param {object} config - frozen config (reserved; the geometry comes from `L_cm` so the caller
 *   can analyse a fixture column that is not `config.column`).
 * @param {object} peak - a Peak (§5.11.1); reads `VR_mL`, `W50_mL`, `As10`.
 * @param {number} L_cm - bed height, cm.
 * @param {number} sigmaExtra_mL - extra-column standard deviation, mL.
 * @returns {{VR_mL:number, W50_mL:number, N_apparent:number, HETP_apparent_cm:number,
 *   N_per_m:number, As10:number, sigma_measured_mL:number, sigma_extracolumn_mL:number,
 *   N_corrected:number, HETP_corrected_cm:number,
 *   verdict:'ACCEPT'|'INVESTIGATE'|'REJECT'|'INDETERMINATE'}} PackingTestResult (§5.11.5).
 *   Volumes and sigmas mL, HETP cm, plate counts dimensionless, `N_per_m` plates per metre.
 */
export function analysePackingTest(config, peak, L_cm, sigmaExtra_mL) {
  const VR_mL = peak.VR_mL;
  const W50_mL = peak.W50_mL;
  const As10 = peak.As10;

  const ratio = VR_mL / W50_mL;
  const N_apparent = 5.54 * ratio * ratio;
  const HETP_apparent_cm = L_cm / N_apparent;
  const sigma_measured_mL = N_apparent > 0 ? VR_mL / Math.sqrt(N_apparent) : NaN;

  const varCol = sigma_measured_mL * sigma_measured_mL - sigmaExtra_mL * sigmaExtra_mL;
  let N_corrected = NaN;
  let HETP_corrected_cm = NaN;
  let verdict = 'INDETERMINATE';
  let N_per_m = NaN;

  if (Number.isFinite(varCol) && varCol > 0) {
    const sigmaCol = Math.sqrt(varCol);
    N_corrected = (VR_mL / sigmaCol) * (VR_mL / sigmaCol);
    HETP_corrected_cm = L_cm / N_corrected;
    N_per_m = N_corrected * 100 / L_cm;
    verdict = N_per_m >= 10000 ? 'ACCEPT' : N_per_m >= 6000 ? 'INVESTIGATE' : 'REJECT';
  }

  return {
    VR_mL,
    W50_mL,
    N_apparent,
    HETP_apparent_cm,
    N_per_m,
    As10,
    sigma_measured_mL,
    sigma_extracolumn_mL: sigmaExtra_mL,
    N_corrected,
    HETP_corrected_cm,
    verdict,
  };
}
