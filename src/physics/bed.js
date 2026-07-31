/**
 * src/physics/bed.js — the ONLY module the skid talks to about the column (architecture-v2 §6.11).
 *
 * Owns the volume-exact batching of §3.4, the `ns <-> nsCol` species index mapping, and the axial
 * snapshot the P&ID renders. Layer L3: it imports `core/util.js` and `physics/column.js` and
 * NOTHING from `skid/*` — which is why the column-valve flow-sign table is recomputed inline here
 * rather than calling `fluidics.columnFlowSign`.
 *
 * UNITS (§1). Volume mL, time s, flow mL/s, superficial velocity cm/s, concentration mM, amount
 * umol (= mM * mL), pressure bar.
 *
 * THE TWO LENGTHS (§1.2). `ns` is `config.ns`, the species REGISTRY length; `nsCol` is
 * `config.nsCol`, the TRANSPORTED count. Everything that crosses into `physics/column.js` is
 * nsCol-long; everything that lives on `run` is ns-long. `colIdxOf[i]` is -1 for the species where
 * they diverge.
 *
 * THIS MODULE OWNS THREE `run` FIELDS and writes all three on every flush (§6.11 / R-S1):
 *   run.yColOut_mM      from `r.cOut` through skidIdxOf, or the zero-order hold between flushes
 *   run.massDefect_umol ASSIGNED (never +=) from col.massClamped_umol, which is itself cumulative
 *   run.diag            everything except run.diag.ms*, which core/sim.js owns
 * It also clears `run.blockBoundaryFlag` (it is that flag's only consumer) and zeroes
 * `run.fAirColIn` when the column is in line (D4: gas does not enter a packed bed here).
 * It does NOT touch `run.dPbed_bar` — `hydraulics.updateHydraulics` is that field's single writer
 * and zeroes it itself for the out-of-line valve positions (§6.10).
 */

import { clamp } from '../core/util.js';
import {
  createColumn,
  resetColumn,
  stepColumn,
  totalMass_umol,
  setFlowDependentCoefficients,
} from './column.js';

/** Number of protein bands the P&ID bed painter draws (§9.2 step 4). */
const SNAPSHOT_BANDS = 4;
/** Bed-top offset ceiling, px (§9.2 step 8 / §6.11). */
const BED_TOP_OFFSET_MAX_PX = 18;

/**
 * The column-valve -> flow-sign table, INLINE.
 *
 * `physics/*` may not import `skid/*` (§4), so this is deliberately NOT a call to
 * `fluidics.columnFlowSign`. That function is the skid-side copy of these identical three lines
 * and the two must agree by inspection: if this table changes, both change.
 *
 * @param {string} valve one of 'DOWN'|'UP'|'BYPASS'|'ISOLATED'|'CIP_DETECTOR_BYPASS'.
 * @returns {number} +1 down-flow, -1 up-flow, 0 out of line.
 */
function columnSignOf(valve) {
  return valve === 'DOWN' ? 1 : valve === 'UP' ? -1 : 0;
}

/**
 * Assemble the one and only `createColumn` cfg.
 *
 * THE only assembler (§6.9, §6.11): `createBedModel` calls it, and so does `ui/app.js`'s startup
 * benchmark. Pure and allocating; called at construction, never per tick.
 *
 * @param {object} config the frozen app config (§2.1).
 * @returns {object} `{ ...config.column, comps: ColumnSpeciesConfig[], chem: config.chem }`.
 *   `comps` is in COLUMN index order (transported species only, in species order) per §5.8.2,
 *   including `charge` and `ionisedFraction` — without both, `computeQStar` cannot form the
 *   Donnan group sums (§7.2.4). `chem` is what carries CS_MIN_mM / C_MIN_mM / C_KT_mM / KT_MIN /
 *   KT_MAX to `makeIsothermModel`.
 */
export function buildColumnCfg(config) {
  const species = config.species;
  const ns = config.ns;
  const comps = [];
  for (let i = 0; i < ns; i++) {
    const s = species[i];
    if (!s.transported) continue;
    comps.push({
      id: s.id,
      colIdx: comps.length,            // equals config.colIdxOf[i] by construction
      MW_gmol: s.MW_gmol,
      kind: s.kind,
      donnanRole: s.donnanRole,
      charge: s.charge,
      ionisedFraction: s.ionisedFraction,
      epsPi: s.epsPi,
      concScale_mM: s.concScale_mM,
      Dm_cm2s: s.Dm_cm2s,
      Dp_cm2s: s.Dp_cm2s,
      keffScale: s.keffScale,
      nu: s.nu,
      sigma: s.sigma,
      Keq: s.Keq,
      qmax_mM: s.qmax_mM,
      b0_mM1: s.b0_mM1,
      beta_mM1: s.beta_mM1,
      csRef_mM: s.csRef_mM,
      Klin: s.Klin,
    });
  }
  return { ...config.column, comps, chem: config.chem };
}

/**
 * Build the BedModel: the column plus everything the batching and the index mapping need.
 *
 * @param {object} config the frozen app config.
 * @returns {object} BedModel — `{ col, comps, colIdxOf, skidIdxOf, cInCol, cOutCol, cMaxRef,
 *   dtColTarget_s, lastFlushTick, lastFlushReason, prevColumnValve, prevState, ... }`.
 *   `cInCol`/`cOutCol`/`cMaxRef` are Float64Array(nsCol) in mM; `dtColTarget_s` is s.
 */
export function createBedModel(config) {
  const cfg = buildColumnCfg(config);
  const col = createColumn(cfg);
  const ns = config.ns;
  const nsCol = cfg.comps.length;

  // Index maps. config.colIdxOf / skidIdxOf are authoritative when present; rebuild otherwise so
  // the bed is usable from a hand-built test config.
  let colIdxOf = config.colIdxOf;
  let skidIdxOf = config.skidIdxOf;
  if (!colIdxOf || !skidIdxOf) {
    colIdxOf = new Int32Array(ns).fill(-1);
    skidIdxOf = new Int32Array(nsCol);
    let j = 0;
    for (let i = 0; i < ns; i++) {
      if (!config.species[i].transported) continue;
      colIdxOf[i] = j;
      skidIdxOf[j] = i;
      j++;
    }
  }

  // cMaxRef floor: 5 % of the species' feed concentration, taken as the largest concentration any
  // tank holds for it. The floor is what stops a blank column painting noise at full opacity.
  const cMaxRef = new Float64Array(nsCol);
  const tanks = config.tanks || [];
  for (let j = 0; j < nsCol; j++) {
    const si = skidIdxOf[j];
    let feed_mM = 0;
    for (let k = 0; k < tanks.length; k++) {
      const y = tanks[k].y_mM;
      if (y && y.length > si && y[si] > feed_mM) feed_mM = y[si];
    }
    cMaxRef[j] = Math.max(0.05 * feed_mM, 1e-9);
  }

  // The four bands the P&ID paints: the transported species with the largest eps280_Lgcm.
  const ranked = [];
  for (let j = 0; j < nsCol; j++) {
    ranked.push({ j, eps: config.species[skidIdxOf[j]].eps280_Lgcm || 0 });
  }
  ranked.sort((a, b) => b.eps - a.eps || a.j - b.j);
  const snapshotCols = new Int32Array(SNAPSHOT_BANDS).fill(-1);
  const snapshotIds = new Array(SNAPSHOT_BANDS).fill('');
  const snapshotCMaxRef = new Float64Array(SNAPSHOT_BANDS);
  for (let b = 0; b < SNAPSHOT_BANDS && b < ranked.length; b++) {
    const j = ranked[b].j;
    snapshotCols[b] = j;
    snapshotIds[b] = cfg.comps[j].id;
    snapshotCMaxRef[b] = cMaxRef[j];
  }

  const tankIndexById = new Map();
  for (let k = 0; k < tanks.length; k++) tankIndexById.set(tanks[k].id, k);

  // The product species, for bedDiagnostics().dbc_gL.
  let productColIdx = -1;
  const productId = config.load ? config.load.productSpeciesId : null;
  for (let j = 0; j < nsCol; j++) {
    if (cfg.comps[j].id === productId) { productColIdx = j; break; }
  }
  if (productColIdx < 0) {
    let bestMW = -1;
    for (let j = 0; j < nsCol; j++) {
      const cm = cfg.comps[j];
      if (cm.kind === 'binding' && cm.MW_gmol > bestMW) { bestMW = cm.MW_gmol; productColIdx = j; }
    }
  }

  return {
    col,
    comps: cfg.comps,
    colIdxOf,
    skidIdxOf,
    cInCol: new Float64Array(nsCol),
    cOutCol: new Float64Array(nsCol),
    cMaxRef,
    dtColTarget_s: config.sim ? config.sim.dtPhys_s : 0.05,
    lastFlushTick: -1,
    lastFlushReason: '',
    prevColumnValve: null,
    prevState: null,

    // ---- private, bed-owned ----
    scratchCol_umol: new Float64Array(nsCol),
    snapshotCols,
    snapshotIds,
    /**
     * Band-indexed mirror of cMaxRef, so the P&ID painter's literal `cMaxRef[j]` of §9.2 step 4
     * (j = band index 0..3) resolves. `cMaxRef` itself stays COLUMN-indexed, as declared.
     */
    snapshotCMaxRef,
    tankIndexById,
    productColIdx,
    stepsInWindow: 0,
    stepWindowStart_s: 0,
    colStepsThisSecond: 0,
  };
}

/**
 * Copy `col.diag` into `run.diag`.
 *
 * ------------------------------------------------------------------------------------------
 * CONTRACT DEFECT, CLOSED HERE — DO NOT REPLACE THIS WITH A LOOP.
 *
 * architecture-v2 asserts in four places (§2.2, §3.4, §6.9.5 and §6.11) that `run.diag` is a
 * "field-for-field" copy of `col.diag` with "byte-identical" key names, so "the copy is a loop
 * and not a translation". IT IS NOT. The two declared key sets differ, and a blind loop silently
 * leaves three `run.diag` fields dead forever:
 *
 *   SHARED (14) — assigned below:
 *     isoIterAvg, activeCells, fullPassCounter, smaFrozen, smaNonConverged, clampCount,
 *     hetpTarget_cm, hetpNumerical_cm, hetpKinetic_cm, hetpDispersive_cm, hetpSimulated_cm,
 *     hetpExcess_cm, sigmaInflation, plateNumberSim
 *
 *   col.diag ONLY (§6.9.5): kPrime, KtBar. `run.diag` (§2.2) never declares them. They are
 *     per-species Float64Arrays and §6.9.5 says the per-species arrays are shared BY REFERENCE,
 *     so they are exposed here under the same names rather than dropped — `run.diag` is the only
 *     documented path the UI has to them.
 *
 *   run.diag ONLY (§2.2): nSubLast, courant, colStepsThisSecond. `col.diag` never declares them.
 *     nSubLast and courant live on the StepResult (§6.9.1) and colStepsThisSecond is a bed-owned
 *     rate, so all three are assigned from their real sources — a loop over col.diag cannot.
 *
 *   run.diag ONLY, NOT OURS (§2.2): msPerSimSecond, msLastTick. Owned by core/sim.js. Never
 *     written here, which an explicit assignment guarantees and a loop only happens to.
 *
 * Note also that §2.2 initialises the hetp*, sigmaInflation and plateNumberSim fields to NUMBERS while
 * `col.diag` declares them as Float64Array(nsCol). After the first flush they are typed arrays.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} colDiag `col.diag` (§6.9.5).
 * @param {object} runDiag `run.diag` (§2.2).
 * @param {object} r the StepResult just returned by `stepColumn`.
 * @param {object} bed the BedModel.
 * @returns {void}
 */
function copyColDiagIntoRunDiag(colDiag, runDiag, r, bed) {
  // --- shared scalars ---
  runDiag.isoIterAvg = colDiag.isoIterAvg;
  runDiag.activeCells = colDiag.activeCells;
  runDiag.fullPassCounter = colDiag.fullPassCounter;
  runDiag.smaFrozen = colDiag.smaFrozen;
  runDiag.smaNonConverged = colDiag.smaNonConverged;
  runDiag.clampCount = colDiag.clampCount;
  // --- shared per-species arrays, shared BY REFERENCE (the UI reads them, never writes) ---
  runDiag.hetpTarget_cm = colDiag.hetpTarget_cm;
  runDiag.hetpNumerical_cm = colDiag.hetpNumerical_cm;
  runDiag.hetpKinetic_cm = colDiag.hetpKinetic_cm;
  runDiag.hetpDispersive_cm = colDiag.hetpDispersive_cm;
  runDiag.hetpSimulated_cm = colDiag.hetpSimulated_cm;
  runDiag.hetpExcess_cm = colDiag.hetpExcess_cm;
  runDiag.sigmaInflation = colDiag.sigmaInflation;
  runDiag.plateNumberSim = colDiag.plateNumberSim;
  // --- col.diag-only per-species arrays, exposed under the same names ---
  runDiag.kPrime = colDiag.kPrime;
  runDiag.KtBar = colDiag.KtBar;
  // --- run.diag-only, from their real sources (a loop over col.diag would leave these dead) ---
  runDiag.nSubLast = r.nSub;
  runDiag.courant = r.courant;
  runDiag.colStepsThisSecond = bed.colStepsThisSecond;
  // --- runDiag.msPerSimSecond / msLastTick: owned by core/sim.js. NOT WRITTEN HERE. ---
}

/**
 * Zero the accumulating half of the batch. `carry*` and `sign` are deliberately untouched.
 * @param {object} b `run.colBatch`.
 * @returns {void}
 */
function resetBatchAccumulator(b) {
  b.dt_s = 0;
  b.dV_mL = 0;
  b.uSum = 0;
  b.n = 0;
  b.yAcc_mM.fill(0);
}

/**
 * Step the column with everything the batch (plus any carry) holds, then re-arm the batch.
 *
 * The flux average is over the TOTAL advanced volume, carry included: dividing by |b.dV_mL| alone
 * while stepping dVTot injects carryDV millilitres at the NEXT batch's concentration (§3.4).
 * The un-advanced remainder is carried as dt, dV AND SOLUTE — carrying volume alone loses
 * composition.
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @param {string} reason flush reason, recorded on `bed.lastFlushReason`.
 * @returns {number} the column speed deficit, >= 1.
 */
function flushBatch(config, run, reason) {
  const bed = run.bed;
  const col = bed.col;
  const b = run.colBatch;
  const ns = config.ns;
  const nsCol = bed.skidIdxOf.length;

  const dtTot_s = b.dt_s + b.carryDt_s;
  if (!(dtTot_s > 0)) return 1.0;

  const dVTot_mL = b.dV_mL + b.carryDV_mL;
  const invV = 1 / Math.max(Math.abs(dVTot_mL), 1e-12);
  const skidIdxOf = bed.skidIdxOf;

  // Flux-averaged inlet composition over the total advanced volume, mapped to COLUMN indices.
  for (let j = 0; j < nsCol; j++) {
    const si = skidIdxOf[j];
    bed.cInCol[j] = (b.yAcc_mM[si] + b.carryYAcc_mM[si]) * invV;
  }
  // Non-transported species have no column state: they pass through at the same batch-average
  // concentration. This is what keeps the skid-plane totalisers self-consistent for them; the
  // mass audit falls back to run.massIn/massOut for exactly these species (§5.11.4).
  for (let i = 0; i < ns; i++) {
    run.colHold_mM[i] = (b.yAcc_mM[i] + b.carryYAcc_mM[i]) * invV;
  }

  const flow_mLs = dVTot_mL / dtTot_s;
  setFlowDependentCoefficients(
    col, Math.abs(flow_mLs) / col.A_cm2, run.T_fluid_C, run.mu_cP, run.rho_gmL);
  const r = stepColumn(col, dtTot_s, flow_mLs, bed.cInCol, dVTot_mL);

  // The substep cap may advance LESS than asked. Carry the remainder; never inflate dt (§3.5).
  const frac = r.dtAdvanced_s / dtTot_s;
  const rem = 1 - frac;
  for (let i = 0; i < ns; i++) {
    b.carryYAcc_mM[i] = (b.yAcc_mM[i] + b.carryYAcc_mM[i]) * rem;
  }
  b.carryDt_s = dtTot_s - r.dtAdvanced_s;
  b.carryDV_mL = dVTot_mL * rem;

  // Outlet: the column's own answer for transported species, over the pass-through default.
  for (let j = 0; j < nsCol; j++) {
    bed.cOutCol[j] = r.cOut[j];
    run.colHold_mM[skidIdxOf[j]] = r.cOut[j];
  }
  for (let i = 0; i < ns; i++) run.yColOut_mM[i] = run.colHold_mM[i];

  // ASSIGN, never +=: col.massClamped_umol is itself cumulative (§6.11).
  columnDefect_umol(config, run, run.massDefect_umol);

  // Column steps per simulated second — a bed-owned rate, tumbling 1 s window.
  bed.stepsInWindow++;
  const elapsed_s = run.t_s - bed.stepWindowStart_s;
  if (elapsed_s >= 1.0) {
    bed.colStepsThisSecond = bed.stepsInWindow / elapsed_s;
    bed.stepsInWindow = 0;
    bed.stepWindowStart_s = run.t_s;
  } else if (elapsed_s > 0) {
    bed.colStepsThisSecond = bed.stepsInWindow / elapsed_s;
  }

  copyColDiagIntoRunDiag(col.diag, run.diag, r, bed);

  resetBatchAccumulator(b);
  bed.lastFlushTick = run.tick;
  bed.lastFlushReason = reason;
  return r.speedDeficit;
}

/**
 * Accumulate one physics tick into the column batch, stepping the column when a flush trigger
 * fires. Tick step 7 of §3.3.
 *
 * The column is deliberately NOT stepped every tick: numerical dispersion in the bed is
 * `H_num = dz*(1 - nu/R)`, so a LARGER column timestep is MORE accurate and CHEAPER. Stepping at
 * 0.05 s would inflate the conductivity front by ~30 % in sigma and cost ~8x the CPU (§3.4).
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @param {number} dt_s the physics timestep, s.
 * @returns {number} the column speed deficit, >= 1 (`sim.advanceWall` is the sole writer of
 *   `run.speedDeficit`; this function only reports).
 */
export function accumulate(config, run, dt_s) {
  const bed = run.bed;
  const col = bed.col;
  const b = run.colBatch;
  const ns = config.ns;
  const sign = columnSignOf(run.valves.columnValve);

  // Target batch length. u_i is the INTERSTITIAL velocity, so this is the same dtMax the column's
  // own substep limiter uses (§3.4, §3.5).
  const absQ_mLs = Math.abs(run.Q_actual_mLs);
  const u_s_cms = absQ_mLs / col.A_cm2;
  const u_i_cms = u_s_cms / col.epsC;
  const dtPhys_s = (config.sim && config.sim.dtPhys_s) ? config.sim.dtPhys_s : dt_s;
  bed.dtColTarget_s = clamp(
    col.nuTarget * col.dz_cm / Math.max(u_i_cms, 1e-9), dtPhys_s, col.dtCap_s);

  if (sign === 0) {
    // BYPASS | ISOLATED | CIP_DETECTOR_BYPASS. The column is out of line: the stream goes round
    // it unchanged. It does NOT touch run.dPbed_bar — hydraulics.updateHydraulics owns that field
    // and zeroes it itself for these three positions (§6.10).
    let deficit = 1.0;
    // Contract strengthening, deliberate: §3.4 says "reset b" here. A batch (or carry) that is
    // still outstanding when the valve leaves the line is real liquid that entered the column, so
    // it is stepped first. Discarding it would open a hole in the 1e-6 mass audit at exactly the
    // COLUMN_BYPASS boundary the audit is hardest at. Flushing an empty batch is a no-op.
    if (b.dt_s > 0 || b.carryDt_s > 0) {
      deficit = flushBatch(config, run, 'VALVE_OUT_OF_LINE');
    }
    for (let i = 0; i < ns; i++) {
      run.yColOut_mM[i] = run.yColIn_mM[i];
      run.colHold_mM[i] = run.yColIn_mM[i];
    }
    resetBatchAccumulator(b);
    b.sign = 0;
    bed.prevColumnValve = run.valves.columnValve;
    bed.prevState = run.state;
    run.blockBoundaryFlag = false;
    return deficit;
  }

  // D4 — gas is blocked at the column inlet plane. advanceAir (step 6) has already propagated it
  // through the cascade; advanceSegments DOWNSTREAM (step 8) reads what we leave here.
  run.fAirColIn = 0;

  // --- PRE-accumulation triggers -------------------------------------------------------------
  // Evaluated BEFORE this tick is folded in. A sign flip or a valve change must not mix opposite-
  // direction volume into one batch: b.dV_mL is signed while b.yAcc_mM is not, so the flux
  // average would be wrong by the cancelled volume.
  let deficit = 1.0;
  const signFlip = (b.sign !== 0 && sign !== b.sign);
  const valveChanged = run.valves.columnValve !== bed.prevColumnValve;
  const stateChanged = run.state !== bed.prevState;
  if (signFlip || valveChanged || stateChanged || run.blockBoundaryFlag === true) {
    if (b.dt_s > 0 || b.carryDt_s > 0) {
      const reason = signFlip ? 'SIGN_CHANGE'
        : valveChanged ? 'VALVE_CHANGE'
          : stateChanged ? 'STATE_CHANGE' : 'BLOCK_BOUNDARY';
      deficit = flushBatch(config, run, reason);
    }
    bed.prevColumnValve = run.valves.columnValve;
    bed.prevState = run.state;
    // bed.js is the ONLY consumer of run.blockBoundaryFlag, and it clears it.
    run.blockBoundaryFlag = false;
  }

  // --- accumulate ----------------------------------------------------------------------------
  if (b.n === 0 && b.dt_s === 0) b.sign = sign;
  b.dt_s += dt_s;
  b.dV_mL += run.Q_actual_mLs * dt_s * sign;
  for (let i = 0; i < ns; i++) {
    b.yAcc_mM[i] += run.yColIn_mM[i] * absQ_mLs * dt_s;   // volume-weighted, mM*mL
  }
  b.uSum += u_s_cms * dt_s;
  b.n++;

  // --- POST-accumulation triggers ------------------------------------------------------------
  let flushReason = null;
  if (b.dt_s >= bed.dtColTarget_s) {
    flushReason = 'DT_TARGET';
  } else if (b.dt_s > 0) {
    const uMean_cms = b.uSum / b.dt_s;
    if (Math.abs(u_s_cms - uMean_cms) / Math.max(uMean_cms, 1e-9) > 0.25) {
      flushReason = 'VELOCITY_CHANGE';
    }
  }

  if (flushReason !== null) {
    const d = flushBatch(config, run, flushReason);
    if (d > deficit) deficit = d;
    b.sign = sign;
    bed.prevColumnValve = run.valves.columnValve;
    bed.prevState = run.state;
    run.blockBoundaryFlag = false;
    return deficit;
  }

  // Between flushes run.yColOut_mM is the zero-order hold run.colHold_mM. Safe because the first
  // downstream segment has a tank time constant an order of magnitude above the 0.2-0.4 s hold.
  for (let i = 0; i < ns; i++) run.yColOut_mM[i] = run.colHold_mM[i];
  return deficit;
}

/**
 * Step the column with whatever the batch holds, right now.
 *
 * Called by `engine.startBlock` / `engine.endBlock` before they log, so the mass audit sees a
 * flushed column (§3.4), and by any caller above L3 before `pooling.massBalance`.
 *
 * IDEMPOTENT: returns immediately when the batch and the carry are both empty, so calling it
 * twice in a row costs one comparison.
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @param {string} reason flush reason, recorded on `bed.lastFlushReason`.
 * @returns {void}
 */
export function forceFlush(config, run, reason) {
  const b = run.colBatch;
  if (b.dt_s === 0 && b.carryDt_s === 0) return;
  flushBatch(config, run, reason);
  run.blockBoundaryFlag = false;
}

/**
 * Live bed diagnostics for the UI.
 *
 * Deliberately does NOT re-report HETP or plate numbers: those live on `run.diag` under the
 * `col.diag` names, and there is exactly one naming set (§6.9.5).
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @returns {{boundFraction:number, dbc_gL:number, isoIterAvg:number, activeCells:number}}
 *   `boundFraction` is the mean fraction of the resin's ionic capacity currently occupied
 *   (charge-equivalent basis, using the SMA steric factor `nu + sigma` where the mode is SMA),
 *   dimensionless 0..1. `dbc_gL` is the product currently bound, in g per L of COLUMN volume.
 *   `isoIterAvg` and `activeCells` are copied from `col.diag`.
 */
export function bedDiagnostics(config, run) {
  const bed = run.bed;
  const col = bed.col;
  const nz = col.nz;
  const nsCol = col.nsCol;
  const isSMA = config.column.isothermMode === 'SMA';
  const Lambda_mM = config.column.Lambda_mM;

  let boundEquivSum_mM = 0;   // sum over cells of the charge-equivalent bound content
  let productBound_mM = 0;    // sum over cells of the product's adsorbed content
  for (let j = 0; j < nsCol; j++) {
    const cm = bed.comps[j];
    if (cm.kind !== 'binding') continue;
    const base = j * nz;
    const epsPi = cm.epsPi;
    let ads_mM = 0;
    for (let n = 0; n < nz; n++) {
      // q is the TOTAL particle content; the ADSORBED part is q - epsPi*c (BASIS N1).
      const a = col.q[base + n] - epsPi * col.c[base + n];
      if (a > 0) ads_mM += a;
    }
    const steric = isSMA ? ((cm.nu || 0) + (cm.sigma || 0)) : 1;
    boundEquivSum_mM += steric * ads_mM;
    if (j === bed.productColIdx) productBound_mM = ads_mM;
  }

  const boundFraction = (Lambda_mM > 0) ? boundEquivSum_mM / (Lambda_mM * nz) : 0;

  // Amount bound: mean q_ads over the bed (mM per bead volume) x bead volume (mL) = umol.
  const Vbead_mL = (1 - col.epsC) * col.V_mL;
  const bound_umol = (productBound_mM / nz) * Vbead_mL;
  const MW_gmol = (bed.productColIdx >= 0) ? bed.comps[bed.productColIdx].MW_gmol : 0;
  // umol * g/mol / 1000 = mg ; mg / mL = g/L.
  const dbc_gL = (col.V_mL > 0) ? (bound_umol * MW_gmol / 1000) / col.V_mL : 0;

  return {
    boundFraction,
    dbc_gL,
    isoIterAvg: col.diag.isoIterAvg,
    activeCells: col.diag.activeCells,
  };
}

/**
 * Reset the bed to equilibrium with a stated composition and clear every batch, hold, defect and
 * diagnostic.
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @param {Float64Array} yEq_mM length ns, mM — the equilibrating composition, in SPECIES registry
 *   order. Non-transported entries are ignored by the column and used only to seed the holds.
 * @returns {void}
 */
export function resetBed(config, run, yEq_mM) {
  const bed = run.bed;
  const col = bed.col;
  const ns = config.ns;
  const nsCol = bed.skidIdxOf.length;

  for (let j = 0; j < nsCol; j++) bed.cInCol[j] = yEq_mM ? yEq_mM[bed.skidIdxOf[j]] : 0;
  resetColumn(col, yEq_mM ? bed.cInCol : null);
  bed.cOutCol.set(bed.cInCol);

  const b = run.colBatch;
  resetBatchAccumulator(b);
  b.sign = 0;
  b.carryDt_s = 0;
  b.carryDV_mL = 0;
  b.carryYAcc_mM.fill(0);

  for (let i = 0; i < ns; i++) {
    const v = yEq_mM ? yEq_mM[i] : 0;
    run.colHold_mM[i] = v;
    run.yColOut_mM[i] = v;
  }
  run.massDefect_umol.fill(0);

  for (let j = 0; j < nsCol; j++) {
    const si = bed.skidIdxOf[j];
    let feed_mM = 0;
    const tanks = config.tanks || [];
    for (let k = 0; k < tanks.length; k++) {
      const y = tanks[k].y_mM;
      if (y && y.length > si && y[si] > feed_mM) feed_mM = y[si];
    }
    bed.cMaxRef[j] = Math.max(0.05 * feed_mM, 1e-9);
  }
  for (let bnd = 0; bnd < SNAPSHOT_BANDS; bnd++) {
    const j = bed.snapshotCols[bnd];
    bed.snapshotCMaxRef[bnd] = (j >= 0) ? bed.cMaxRef[j] : 0;
  }

  bed.dtColTarget_s = (config.sim && config.sim.dtPhys_s) ? config.sim.dtPhys_s : 0.05;
  bed.lastFlushTick = -1;
  bed.lastFlushReason = '';
  bed.prevColumnValve = run.valves ? run.valves.columnValve : null;
  bed.prevState = run.state;
  bed.stepsInWindow = 0;
  bed.stepWindowStart_s = run.t_s;
  bed.colStepsThisSecond = 0;

  copyColDiagIntoRunDiag(col.diag, run.diag, col.result, bed);
}

/**
 * Total amount of every species currently held in the column, mapped back to registry indices.
 * This is the `column_umol` term of the mass audit (§5.11.4).
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @param {Float64Array} out_umol length **ns** (the registry length); overwritten.
 * @returns {Float64Array} `out_umol` in umol; 0 for non-transported species.
 */
export function columnHoldup_umol(config, run, out_umol) {
  const bed = run.bed;
  const nsCol = bed.skidIdxOf.length;
  totalMass_umol(bed.col, bed.scratchCol_umol);
  out_umol.fill(0);
  for (let j = 0; j < nsCol; j++) out_umol[bed.skidIdxOf[j]] = bed.scratchCol_umol[j];
  return out_umol;
}

/**
 * The column's cumulative UNSAFE-clamp defect, mapped back to registry indices.
 *
 * `col.massClamped_umol` is itself cumulative, so this ASSIGNS and never increments — a `+=`
 * would double-count on every flush (§6.11).
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @param {Float64Array} out_umol length **ns**; overwritten.
 * @returns {Float64Array} `out_umol` in umol; 0 for non-transported species.
 */
export function columnDefect_umol(config, run, out_umol) {
  const bed = run.bed;
  const clamped = bed.col.massClamped_umol;
  const nsCol = bed.skidIdxOf.length;
  out_umol.fill(0);
  for (let j = 0; j < nsCol; j++) out_umol[bed.skidIdxOf[j]] = clamped[j];
  return out_umol;
}

/**
 * Resolve the modulator concentration of the tank currently feeding an inlet port.
 * @param {object} config the frozen app config.
 * @param {object} bed the BedModel.
 * @param {string|null} portId e.g. 'A1'.
 * @returns {number} modulator concentration, mM, or NaN when unresolvable.
 */
function modulatorEndpoint_mM(config, bed, portId) {
  if (!portId || !config.inletAssignments) return NaN;
  const tankId = config.inletAssignments[portId];
  if (!tankId) return NaN;
  const k = bed.tankIndexById.get(tankId);
  if (k === undefined) return NaN;
  const y = config.tanks[k].y_mM;
  const mi = config.column.modulatorIdx;
  if (!y || mi == null || mi < 0 || mi >= y.length) return NaN;
  return y[mi];
}

/**
 * Decimate the axial bed state into the caller-owned struct the P&ID paints (§9.2, §6.11).
 *
 * Called at 10 Hz from `ui/pid.js`. Allocates nothing. This is the one physics->UI data path and
 * it is read-only from the UI's side. There is NO air field: D4 blocks gas at the column inlet
 * plane, so gas inside a packed bed that is in line is a state this program never enters.
 *
 * @param {object} config the frozen app config.
 * @param {object} run the mutable run state.
 * @param {{pctB:Float32Array, species:Float32Array, speciesIds:string[],
 *          bedTopOffset_px:number, channelling:number}} out caller-owned.
 *   `out.pctB` is `nCells` long and is written in **percent, 0..100**, index 0 = bed top (inlet).
 *   `out.species` is `nCells*4` long and is **SPECIES-MAJOR**: `species[band*nCells + cell]`,
 *   in **mM** (the raw interstitial concentration, i.e. `C` in §9.2 step 4). The band-indexed
 *   normaliser is `run.bed.snapshotCMaxRef[band]`, which this function keeps as a running max
 *   floored at 5 % of the species' feed concentration, so the painter's
 *   `alpha = clamp(C/cMaxRef[band],0,1)*0.85` works verbatim.
 *   `out.speciesIds[band]` is the species id of each band.
 * @returns {void}
 */
export function bedAxialSnapshot(config, run, out) {
  const bed = run.bed;
  const col = bed.col;
  const nCells = out.pctB.length;
  const nz = col.nz;

  for (let bnd = 0; bnd < SNAPSHOT_BANDS; bnd++) {
    const j = bed.snapshotCols[bnd];
    const off = bnd * nCells;
    out.speciesIds[bnd] = bed.snapshotIds[bnd];
    if (j < 0) {
      for (let k = 0; k < nCells; k++) out.species[off + k] = 0;
      continue;
    }
    const base = j * nz;
    let mx_mM = 0;
    for (let k = 0; k < nCells; k++) {
      const n0 = Math.floor(k * nz / nCells);
      const n1 = Math.max(n0 + 1, Math.floor((k + 1) * nz / nCells));
      let s = 0;
      for (let n = n0; n < n1; n++) s += col.c[base + n];
      const v = s / (n1 - n0);
      out.species[off + k] = v;
      if (v > mx_mM) mx_mM = v;
    }
    if (mx_mM > bed.cMaxRef[j]) bed.cMaxRef[j] = mx_mM;
    bed.snapshotCMaxRef[bnd] = bed.cMaxRef[j];
  }

  // Local %B from the modulator, against the currently selected A and B tanks — the same
  // definition as the pctB_column_inlet log channel (§5.1).
  const m = col.modulatorColIdx;
  if (m < 0 || m >= col.nsCol) {
    out.pctB.fill(0);
  } else {
    const csA_mM = modulatorEndpoint_mM(config, bed, run.valves ? run.valves.inletA : null);
    const csB_mM = modulatorEndpoint_mM(config, bed, run.valves ? run.valves.inletB : null);
    const haveSpan = Number.isFinite(csA_mM) && Number.isFinite(csB_mM)
      && (csB_mM - csA_mM) > 1e-9;
    const base = m * nz;
    // Fallback normaliser when the A/B endpoints are unresolvable: the modulator's own running max.
    let fallbackMax_mM = bed.cMaxRef[m];
    if (!haveSpan) {
      for (let n = 0; n < nz; n++) if (col.c[base + n] > fallbackMax_mM) fallbackMax_mM = col.c[base + n];
      if (fallbackMax_mM > bed.cMaxRef[m]) bed.cMaxRef[m] = fallbackMax_mM;
    }
    const span = haveSpan ? (csB_mM - csA_mM) : Math.max(fallbackMax_mM, 1e-9);
    const zero = haveSpan ? csA_mM : 0;
    for (let k = 0; k < nCells; k++) {
      const n0 = Math.floor(k * nz / nCells);
      const n1 = Math.max(n0 + 1, Math.floor((k + 1) * nz / nCells));
      let s = 0;
      for (let n = n0; n < n1; n++) s += col.c[base + n];
      const cs_mM = s / (n1 - n0);
      out.pctB[k] = 100 * clamp((cs_mM - zero) / span, 0, 1);
    }
  }

  const dPmax_bar = config.column.hardwarePressureLimit_bar;
  out.bedTopOffset_px = (dPmax_bar > 0)
    ? Math.min(BED_TOP_OFFSET_MAX_PX, run.dPbed_bar / dPmax_bar * BED_TOP_OFFSET_MAX_PX)
    : 0;
  // An AUTHORED scenario knob, copied verbatim: nothing in the physics produces radial
  // heterogeneity (there is no radial dimension, and D7 defers axial compression resolution).
  out.channelling = config.column.channellingFactor;
}
