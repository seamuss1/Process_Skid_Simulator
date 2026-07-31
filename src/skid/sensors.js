/**
 * @file src/skid/sensors.js — UV, conductivity, pH, pressure and temperature transducers,
 * the watch/fraction signal lookup surface, autozero, and the quality bitfield.
 *
 * Contract: architecture-v2.md §5.2 (the 22 `sensorSignal` names and their units), §5.3
 * (`run.qualityFlags` and `sensorQuality`), §6.14 (this module), §7.4.1 (conductivity
 * temperature), §7.5 (UV / stray light). Layer L3: imports core/util, core/log,
 * chem/solution, chem/ph and nothing else. No DOM, no wall clock, no `Math.random`.
 *
 * ALL sensor RNG draws in the program happen here, at tick step 10 of §3.3, unconditionally
 * and with a FIXED count per tick (§5.9): UV 3 white + 12 pink, COND 2 white + 1 pink,
 * PH 1, PRESS 2. Values are drawn even when they are discarded, because that is what makes
 * replay bit-identical at 1× and at 1000×.
 *
 * Zero allocation per tick: every compound value is written into caller-owned state in place,
 * and the per-config lookup tables are (re)built only when the `config` object identity changes
 * (§2.4 rebuilds config, it never mutates one).
 */

import { clamp, nextGaussian, RNG_STREAMS, R_GAS, F_FARADAY } from '../core/util.js';
import { QF, logEvent } from '../core/log.js';
import { kappa25_mScm, kappaRaw_mScm, kappaDisplay_mScm } from '../chem/solution.js';
import { solvePH, sodiumError } from '../chem/ph.js';

// ---------------------------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------------------------

/** Fixed UV channel count. `config.skid.uv.channels_nm = [280, 260, 300]`, so idx 0=280, 1=260,
 *  2=300 (§6.14). Every Float64Array(3) in `run.uv` uses this order. */
const N_UV = 3;

/** Per-channel weight of the refractive-index artefact, in channel order [280, 260, 300] (§6.14). */
const RI_CHANNEL_WEIGHT = [1.4, 1.0, 0.6];

/** The RI artefact is `kRI * (kappa_now - kappa_1s_ago) / 1 s` (§6.14). `run.uv.condPrev_mScm` is a
 *  one-second first-order lag of the conductivity, which for a steady ramp `r` settles at
 *  `kappa - r*1 s`, so `(kappa - condPrev)/1 s` is exactly the ramp rate. One scalar of state,
 *  correct at any `dt_s`, no 20-sample ring needed. */
const RI_WINDOW_S = 1.0;

/** Correlation time of the conductivity pink-noise source. The contract fixes its AMPLITUDE
 *  (`cond.noisePinkRel`) but not its correlation time; 10 s is chosen an order of magnitude above
 *  the 1 s conductivity filter so the term survives filtering as baseline wander, which is the
 *  entire point of a pink term. Documented choice, not a derived constant. */
const COND_PINK_TAU_S = 10.0;

/** `COND_TEMP_RANGE` window on the conductivity cell's Pt1000 (§5.3). */
const COND_TEMP_OK_LO_C = 2.0;
const COND_TEMP_OK_HI_C = 30.0;

/** `PH_ELECTRODE_DEGRADED` thresholds (§5.3): slope below 92 % or |offset| above 30 mV. */
const PH_DEGRADED_SLOPE_PCT = 92.0;
const PH_DEGRADED_OFFSET_MV = 30.0;

/** Isopotential point of a glass pH electrode: the calibration slope pivots about pH 7. */
const PH_ISOPOTENTIAL = 7.0;

/** `PRESS_SUSPECT` (§5.3) mirrors the ALM-DP-04 row of §5.6 (dP < -0.20 bar for 5 s). It is
 *  duplicated here as a constant because `skid/sensors.js` (L3) may not import `skid/alarms.js`
 *  (L4); if the alarm row moves, this moves with it. */
const PRESS_SUSPECT_DP_bar = -0.20;

/** Under-range rail of a gauge pressure transducer, as a fraction of full scale. The reading is
 *  clamped to `[-PRESS_UNDERRANGE_FRAC_FS*FS, FS]`. Clamping the low end at exactly zero instead
 *  would cap `dP` at `-P2` (about -0.09 bar at the pilot's nominal flow) and make the authored
 *  ALM-DP-04 row (-0.20 bar) unreachable at any legal flow, so a real transducer's small vacuum
 *  range is modelled. */
const PRESS_UNDERRANGE_FRAC_FS = 0.05;

/** `UV_LAMP_FAULT` (§5.3): sustained drift above 50 mAU/h. The warm-up transient
 *  (`driftStart_AU` decaying with `driftTau_s`) is EXCLUDED — at t=0 it runs at 225 mAU/h by
 *  construction (0.025/400 AU/s), so testing the instantaneous rate would fault every cold start.
 *  Only the sustained term `driftWarm_AU_s`, which a scenario raises, can trip it. */
const LAMP_FAULT_DRIFT_AU_PER_H = 0.050;

/** `SPEED_LIMITED` (§5.3). */
const SPEED_LIMIT_DEFICIT = 1.01;

/** An autozero is flagged `UV_AUTOZERO_UNSTABLE` when the filter residual on any zeroed channel
 *  exceeds this many times the total authored noise amplitude, or when air is in the path (§5.3).
 *  Derived from `uv.noiseWhite_AU + uv.noisePink_AU`, not invented. */
const AZ_UNSTABLE_NOISE_FACTOR = 10.0;

/** Reference viscosity of the pressure model, cP — water at 20 °C (§7.1.4). */
const MU_REF_cP = 1.002;

// ---------------------------------------------------------------------------------------------
// Per-config caches (rebuilt only when the config or run object identity changes)
// ---------------------------------------------------------------------------------------------

const cache = {
  config: null,
  run: null,
  ns: 0,
  /** Float64Array(N_UV * ns): `eps_lambda_i [L/g/cm] * MW_i [g/mol] / 1000`, i.e. AU per cm per mM.
   *  Channel-major: `epsMW[ch * ns + i]`. */
  epsMW: null,
  /** Float64Array(ns): frozen mean charge `charge_i * ionisedFraction_i` (§5.8.1/§5.8.2). */
  zbar: null,
  /** The `{ zbar }` speciation object `chem/solution.js` consumes. Reused, never reallocated. */
  speciation: null,
  /** Map<tankId, index into config.tanks>. Used only off the hot path. */
  tankIndexById: null,
  naIdx: -1,
  prevSmaFrozen: 0,
};

/** Caller-owned scratch for `chem/ph.js::solvePH` (§6.6): one pH solve per tick, no allocation. */
const PH_SCRATCH = { tj: new Float64Array(8), charges: new Float64Array(16) };
const PH_OUT = { pH: 7, I_molL: 0, iterations: 0 };

/**
 * Rebuild the per-config lookup tables when the config object identity changes.
 * `config` is frozen and replaced wholesale by `sim.rebuild` (§2.4), so identity is a sound key
 * and this never runs on the hot path after the first tick.
 * @param {object} config canonical frozen config
 * @returns {void}
 */
function syncConfigCache(config) {
  if (cache.config === config) return;
  const ns = config.ns;
  const species = config.species;
  const epsMW = new Float64Array(N_UV * ns);
  const zbar = new Float64Array(ns);
  for (let i = 0; i < ns; i++) {
    const sp = species[i];
    const mw = sp.MW_gmol || 0;
    epsMW[0 * ns + i] = (sp.eps280_Lgcm || 0) * mw / 1000;
    epsMW[1 * ns + i] = (sp.eps260_Lgcm || 0) * mw / 1000;
    epsMW[2 * ns + i] = (sp.eps300_Lgcm || 0) * mw / 1000;
    // Frozen speciation (§5.8.1): the ionised fraction is solved once at ingest and never
    // re-solved per tick. `zbar` is the signed mean charge chem/solution.js takes |z| from.
    zbar[i] = (sp.charge || 0) * (sp.ionisedFraction === undefined ? 1 : sp.ionisedFraction);
  }
  const tankIndexById = new Map();
  for (let k = 0; k < config.tanks.length; k++) tankIndexById.set(config.tanks[k].id, k);

  cache.config = config;
  cache.ns = ns;
  cache.epsMW = epsMW;
  cache.zbar = zbar;
  cache.speciation = { zbar };
  cache.tankIndexById = tankIndexById;
  cache.naIdx = (config.idxById && config.idxById.Na !== undefined) ? config.idxById.Na : -1;
}

/**
 * Resynchronise the one piece of cross-tick state this module keeps outside `run`: the previous
 * tick's `run.diag.smaFrozen`, which `QF.SOLVER_FROZEN` is an edge on.
 * @param {object} run mutable run state
 * @returns {void}
 */
function syncRunCache(run) {
  if (cache.run === run) return;
  cache.run = run;
  cache.prevSmaFrozen = run.diag ? run.diag.smaFrozen : 0;
}

/**
 * Both caches at once — the per-tick entry points call this.
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @returns {void}
 */
function syncCaches(config, run) {
  syncConfigCache(config);
  syncRunCache(run);
}

/**
 * First-order blend factor for a time constant.
 * @param {number} dt_s timestep, s
 * @param {number} tau_s time constant, s
 * @returns {number} alpha in [0,1]; `x += (target - x) * alpha` is exact for a constant target
 */
function alphaFor(dt_s, tau_s) {
  if (!(tau_s > 0)) return 1;
  return 1 - Math.exp(-dt_s / tau_s);
}

/**
 * Temperature of the source tank feeding an inlet port.
 * @param {object} config canonical config
 * @param {string|null} port inlet port id, e.g. 'A1'
 * @param {number} fallback_C temperature to use when the port is unassigned, °C
 * @returns {number} tank temperature, °C
 */
function tankTempForPort_C(config, port, fallback_C) {
  if (!port) return fallback_C;
  const id = config.inletAssignments ? config.inletAssignments[port] : null;
  if (!id) return fallback_C;
  const k = cache.tankIndexById.get(id);
  if (k === undefined) return fallback_C;
  const T = config.tanks[k].T_C;
  return (typeof T === 'number') ? T : fallback_C;
}

// ---------------------------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------------------------

/**
 * Tick step 10 of §3.3. Updates every transducer and the quality bitfield, in the fixed order
 * `updateTemperature, updatePressure, updateCond, updatePH, updateUV, updateQualityFlags`,
 * UNCONDITIONALLY — the order is normative (§6.14) and the unconditional call is what keeps the
 * per-tick RNG draw count fixed at 3 white + 12 pink (UV) + 2 white + 1 pink (COND) + 1 (PH)
 * + 2 (PRESS) = 21 draws (§5.9).
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {void} writes `run.T_fluid_C`, `run.T_cell_C`, `run.press.*`, `run.cond.*`,
 *   `run.ph.*`, `run.uv.*`, `run.P1_bar`, `run.P2_bar`, `run.dP_bar`, `run.Ppump_bar`,
 *   `run.qualityFlags` in place
 */
export function updateSensors(config, run, dt_s) {
  syncCaches(config, run);
  updateTemperature(config, run, dt_s);
  updatePressure(config, run, dt_s);
  updateCond(config, run, dt_s);
  updatePH(config, run, dt_s);
  updateUV(config, run, dt_s);
  updateQualityFlags(config, run);
}

// ---------------------------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------------------------

/**
 * Fluid and conductivity-cell temperatures.
 *
 * The fluid enters at the flow-weighted temperature of the selected source tanks and warms toward
 * `config.skid.ambientT_C` over its transit of the gradient path; the detector-plane temperature
 * therefore follows the inlet temperature with the transit time as its lag. With no flow the line
 * is stagnant and relaxes to ambient with `config.skid.fluidTau_s`. `run.T_cell_C` is the cell's
 * Pt1000, lagging the fluid by `config.skid.cond.ptTau_s` (§6.14). No invented constants: every
 * time constant here is `fluidTau_s`, `ptTau_s` or the hold-up transit time `Vgrad_mL/Q`.
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {void} writes `run.T_fluid_C` (°C) and `run.T_cell_C` (°C)
 */
export function updateTemperature(config, run, dt_s) {
  syncCaches(config, run);
  const skid = config.skid;
  const ambient_C = skid.ambientT_C;

  const qa = Math.abs(run.QA_mLs);
  const qb = Math.abs(run.QB_mLs);
  const qs = Math.abs(run.QS_mLs);
  const qTot = qa + qb + qs;

  let Tin_C = ambient_C;
  if (qTot > 1e-9) {
    const Ta_C = tankTempForPort_C(config, run.valves.inletA, ambient_C);
    const Tb_C = tankTempForPort_C(config, run.valves.inletB, ambient_C);
    const Ts_C = tankTempForPort_C(config, run.valves.inletS, ambient_C);
    Tin_C = (qa * Ta_C + qb * Tb_C + qs * Ts_C) / qTot;
  }

  const Q_mLs = Math.abs(run.Q_actual_mLs);
  let target_C;
  let tau_s;
  if (Q_mLs > 1e-9) {
    const transit_s = clamp(skid.holdup.Vgrad_mL / Q_mLs, dt_s, skid.fluidTau_s);
    const warmFrac = 1 - Math.exp(-transit_s / skid.fluidTau_s);
    target_C = Tin_C + (ambient_C - Tin_C) * warmFrac;
    tau_s = transit_s;
  } else {
    target_C = ambient_C;
    tau_s = skid.fluidTau_s;
  }

  run.T_fluid_C += (target_C - run.T_fluid_C) * alphaFor(dt_s, tau_s);
  run.T_cell_C += (run.T_fluid_C - run.T_cell_C) * alphaFor(dt_s, skid.cond.ptTau_s);
}

// ---------------------------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------------------------

/**
 * Pre- and post-column pressure transducers (§6.14, §7.1.4). Writes `run.press.*` IN PLACE and
 * returns nothing — this is the zero-allocation form required by §13 item 5.
 *
 * `P2 = Rdown_bar_per_mLs * Q_mLs * (mu_cP / 1.002)`;
 * `P1 = P2 + dPbed + dPhw + dPfilter` (all supplied by `physics/hydraulics.js` at tick step 9).
 * Both readings then carry the pump ripple at ±`ripplePress_frac`, a common-mode span error of
 * `(1 + accuracyFS)` (a matched transducer pair calibrated against one standard — common mode, so
 * it cancels out of dP and cannot manufacture an ALM-DP-04), and `noiseFS * FS` of white noise
 * (2 PRESS draws, always). Each transducer is then filtered TWICE: `tauDisp_s` for the display
 * value and `tauAlarm_s` for the alarm evaluator. `sensorSignal('P1'|'P2'|'DP')` returns the
 * ALARM-filtered value (§5.2).
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {void} writes `run.press.{P1raw_bar,P1disp_bar,P1alm_bar,P2raw_bar,P2disp_bar,P2alm_bar}`
 *   and the run-level `run.P1_bar`, `run.P2_bar`, `run.dP_bar`, `run.Ppump_bar`, all bar gauge
 */
export function updatePressure(config, run, dt_s) {
  syncCaches(config, run);
  const p = config.skid.press;
  const st = run.press;
  const stream = run.rng.streams[RNG_STREAMS.PRESS];

  // Two PRESS draws per tick, unconditionally (§5.9).
  const g1 = nextGaussian(stream);
  const g2 = nextGaussian(stream);

  const ripple = 1 + config.skid.ripplePress_frac * Math.sin(run.ripplePhase_rad);
  const span = 1 + p.accuracyFS;

  const P2true_bar = p.Rdown_bar_per_mLs * Math.abs(run.Q_actual_mLs) * (run.mu_cP / MU_REF_cP);
  const P1true_bar = P2true_bar + run.dPbed_bar + run.dPhw_bar + run.dPfilter_bar;

  const P1lo_bar = -PRESS_UNDERRANGE_FRAC_FS * p.P1FS_bar;
  const P2lo_bar = -PRESS_UNDERRANGE_FRAC_FS * p.P2FS_bar;
  const P1raw_bar = clamp(
    P1true_bar * ripple * span + g1 * p.noiseFS * p.P1FS_bar, P1lo_bar, p.P1FS_bar,
  );
  const P2raw_bar = clamp(
    P2true_bar * ripple * span + g2 * p.noiseFS * p.P2FS_bar, P2lo_bar, p.P2FS_bar,
  );

  st.P1raw_bar = P1raw_bar;
  st.P2raw_bar = P2raw_bar;

  const aDisp = alphaFor(dt_s, p.tauDisp_s);
  const aAlm = alphaFor(dt_s, p.tauAlarm_s);
  st.P1disp_bar += (P1raw_bar - st.P1disp_bar) * aDisp;
  st.P2disp_bar += (P2raw_bar - st.P2disp_bar) * aDisp;
  st.P1alm_bar += (P1raw_bar - st.P1alm_bar) * aAlm;
  st.P2alm_bar += (P2raw_bar - st.P2alm_bar) * aAlm;

  // The run-level mirrors. §6.10 makes hydraulics the sole writer of dPbed/dPhw/dPfilter and
  // explicitly does NOT list P1/P2/dP: "P1/P2 assembly lives in skid/sensors.js".
  run.P1_bar = P1raw_bar;
  run.P2_bar = P2raw_bar;
  run.dP_bar = P1raw_bar - P2raw_bar;
  // No suction-side resistance is modelled, so pump discharge is the pre-column pressure.
  run.Ppump_bar = P1raw_bar;
}

// ---------------------------------------------------------------------------------------------
// Conductivity
// ---------------------------------------------------------------------------------------------

/**
 * Conductivity cell (§6.14, §7.4.1).
 *
 * Chain: `kappa25` from `chem/solution.js` at the conductivity plane (`run.yCond_mM`) →
 * the QUADRATIC temperature model → air dropout `kappa*(1-fAir)^1.5` → drift, cell fouling and
 * noise (2 white + 1 pink draws, always) → first-order filter `cond.tau_s` → the LINEAR meter
 * compensation for the displayed value. The quadratic-physics / linear-meter mismatch is a
 * modelled instrument artefact and reads ~9.8 % HIGH at 5 °C — do not "fix" it (§7.4.1).
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {void} writes `run.cond.{kappa25_mScm,kappaRaw_mScm,kappaFilt_mScm,kappaDisp_mScm,
 *   pink,drift,foul,dry}` — every conductivity in mS/cm
 */
export function updateCond(config, run, dt_s) {
  syncCaches(config, run);
  const cfg = config.skid.cond;
  const st = run.cond;
  const stream = run.rng.streams[RNG_STREAMS.COND];

  // Two white draws + one pink source draw per tick, unconditionally (§5.9).
  const gAbs = nextGaussian(stream);
  const gRel = nextGaussian(stream);
  const gPink = nextGaussian(stream);

  // The frozen speciation of §5.8.1 (charge * ionisedFraction) is what chem/solution.js needs;
  // it is not re-solved per tick, exactly as the Donnan group sums are not (§5.8.2, §11 C-03).
  const kappa25 = kappa25_mScm(config, run.yCond_mM, cache.speciation);
  st.kappa25_mScm = kappa25;

  const kappaT = kappaRaw_mScm(kappa25, run.T_cell_C);

  const fAir = clamp(run.fAirDet, 0, 1);
  const kappaAir = kappaT * Math.pow(1 - fAir, 1.5);
  st.dry = fAir > cfg.dryThreshold_frac;

  // Slow relative drift and per-CIP-cycle cell fouling (foulPerCycle is negative: a fouled cell
  // reads low).
  st.drift += cfg.driftRel_s * dt_s;
  st.foul = cfg.foulPerCycle * run.cycleIndex;

  // Unit-variance AR(1) pink source; the contract fixes the amplitude, not the correlation time.
  const aPink = Math.exp(-dt_s / COND_PINK_TAU_S);
  st.pink = aPink * st.pink + Math.sqrt(Math.max(0, 1 - aPink * aPink)) * gPink;

  const noise_mScm = gAbs * cfg.noiseAbs_mScm
    + gRel * cfg.noiseRel * kappaAir
    + st.pink * cfg.noisePinkRel * kappaAir;

  const kappaRaw = Math.max(0, kappaAir * (1 + st.drift + st.foul) + noise_mScm);
  st.kappaRaw_mScm = kappaRaw;

  st.kappaFilt_mScm += (kappaRaw - st.kappaFilt_mScm) * alphaFor(dt_s, cfg.tau_s);
  st.kappaDisp_mScm = kappaDisplay_mScm(
    st.kappaFilt_mScm, run.T_cell_C, config.chem.condTref_C, config.chem.condAlphaMeter_perC,
  );
}

// ---------------------------------------------------------------------------------------------
// pH
// ---------------------------------------------------------------------------------------------

/**
 * pH electrode (§6.14).
 *
 * Chain: `solvePH` at the pH-chamber plane (`run.yPh_mM`) → the alkaline (sodium) error →
 * the electrode's own first-order lag, `ph.tau_s` multiplied by `ph.tauAsymRising` when the
 * reading is RISING (a glass electrode is slower into alkali) → calibration slope about the
 * pH 7 isopotential plus the mV offset converted at the Nernst slope for the current temperature
 * → drift and white noise (1 PH draw, always) → electronic filter `ph.tauElec_s`.
 * Above `ph.freezeAir_frac` of gas the reading FREEZES (a dry junction reads nothing new) while
 * the RNG draw still happens.
 *
 * Electrode calibration decays with the CIP count: `slopePct` loses `ph.slopeDecayPerCycle` and
 * `offset_mV` gains `ph.offsetDecayPerCycle` per completed CIP block (`run.cycleIndex`, owner
 * `skid/engine.js`). `run.ph.highPHminutes` accumulates exposure above pH 12 and is reported;
 * it is deliberately NOT a second decay path, because the contract gives per-CYCLE constants only
 * and inventing a per-minute rate would change PRC-10 silently.
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {void} writes `run.ph.{pHtrue,pHelec,pHfilt,drift,slopePct,offset_mV,highPHminutes,
 *   frozen}` — pH units, except `offset_mV` (mV) and `highPHminutes` (min)
 */
export function updatePH(config, run, dt_s) {
  syncCaches(config, run);
  const cfg = config.skid.ph;
  const st = run.ph;
  const stream = run.rng.streams[RNG_STREAMS.PH];

  // Exactly one PH draw per tick, unconditionally (§5.9) — drawn before any early exit.
  const gNoise = nextGaussian(stream);

  solvePH(config, run.yPh_mM, run.T_fluid_C, PH_SCRATCH, PH_OUT);
  const pHtrue = PH_OUT.pH;
  st.pHtrue = pHtrue;

  if (pHtrue > 12) st.highPHminutes += dt_s / 60;

  const cNa_molL = (cache.naIdx >= 0) ? run.yPh_mM[cache.naIdx] / 1000 : 0;
  const pHsense = pHtrue + sodiumError(config, pHtrue, cNa_molL);

  const fAir = clamp(run.fAirDet, 0, 1);
  st.frozen = fAir > cfg.freezeAir_frac;

  st.drift += cfg.drift_pH_s * dt_s;
  st.slopePct = clamp(cfg.slopePct - cfg.slopeDecayPerCycle * run.cycleIndex, 0, 100);
  st.offset_mV = cfg.offset_mV + cfg.offsetDecayPerCycle * run.cycleIndex;

  if (!st.frozen) {
    const tauEff_s = (pHsense > st.pHelec) ? cfg.tau_s * cfg.tauAsymRising : cfg.tau_s;
    st.pHelec += (pHsense - st.pHelec) * alphaFor(dt_s, tauEff_s);

    // Nernst slope in mV/pH at the fluid temperature: 2.303*R*T/F, in mV.
    const mVperPH = 1000 * Math.LN10 * R_GAS * (run.T_fluid_C + 273.15) / F_FARADAY;
    const pHcal = PH_ISOPOTENTIAL
      + (st.pHelec - PH_ISOPOTENTIAL) * (st.slopePct / 100)
      + st.offset_mV / mVperPH
      + st.drift
      + gNoise * cfg.noise_pH;

    st.pHfilt += (pHcal - st.pHfilt) * alphaFor(dt_s, cfg.tauElec_s);
  }
}

// ---------------------------------------------------------------------------------------------
// UV
// ---------------------------------------------------------------------------------------------

/**
 * Beer–Lambert absorbance of a composition vector on one UV channel (§7.5).
 * `A = (1/dilutionRatio) * path_cm * SUM_i eps_lambda_i[L/g/cm] * (c_mM_i * MW_i / 1000)`.
 *
 * @param {object} config canonical frozen config
 * @param {Float64Array} y_mM composition vector, length `config.ns`, mM
 * @param {0|1|2} channelIdx UV channel index — 0 = 280 nm, 1 = 260 nm, 2 = 300 nm (fixed, §6.14)
 * @param {number} path_cm optical pathlength, cm
 * @returns {number} true absorbance, AU (NaN for an out-of-range channel index)
 */
export function beerLambert_AU(config, y_mM, channelIdx, path_cm) {
  if (!(channelIdx >= 0) || channelIdx >= N_UV) return NaN;
  syncConfigCache(config);
  const ns = cache.ns;
  const epsMW = cache.epsMW;
  const base = channelIdx * ns;
  let sum = 0;
  for (let i = 0; i < ns; i++) sum += epsMW[base + i] * y_mM[i];
  const dilution = config.skid.uv.dilutionRatio || 1;
  return (path_cm / dilution) * sum;
}

/**
 * Stray-light saturation of a photometric detector (§7.5).
 * `A_meas = -log10((1-s)*10^(-A_true) + s)`. With `s = 3.0e-3` the ceiling is 2.5228787 AU.
 * Verified: 0.5/1.0/2.0/3.0 AU -> 0.4971910 / 0.9884266 / 1.8870601 / 2.5228787.
 *
 * @param {number} Atrue_AU true absorbance, AU
 * @param {number} s stray-light fraction, dimensionless 0–1
 * @returns {number} measured absorbance, AU
 */
export function strayLight_AU(Atrue_AU, s) {
  if (!(s > 0)) return Atrue_AU;
  const t = (1 - s) * Math.pow(10, -Atrue_AU) + s;
  return -Math.log10(t);
}

/**
 * The refractive-index artefact: a UV baseline excursion proportional to the RATE of conductivity
 * change, which is why a salt STEP produces a spike and a slow gradient produces almost nothing.
 * `ri = kRI_AU_per_mScm_s * (kappa_now - kappa_1s_ago) / 1 s`, with `run.uv.condPrev_mScm` acting
 * as the one-second lag (see `RI_WINDOW_S`). The per-channel weights 1.4 / 1.0 / 0.6 (§6.14) are
 * applied by `updateUV`; this function returns the UNWEIGHTED base value and also stores it in
 * `run.uv.ri_AU`.
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {number} base RI artefact, AU
 */
export function riArtifact_AU(config, run, dt_s) {
  const uv = run.uv;
  // The physical (noise-free) conductivity, updated earlier this tick by updateCond, so the
  // detector noise is not fed back into the UV trace.
  const kappa_mScm = run.cond.kappa25_mScm;
  const ri_AU = config.skid.uv.kRI_AU_per_mScm_s * (kappa_mScm - uv.condPrev_mScm) / RI_WINDOW_S;
  uv.condPrev_mScm += (kappa_mScm - uv.condPrev_mScm) * alphaFor(dt_s, RI_WINDOW_S);
  uv.ri_AU = ri_AU;
  return ri_AU;
}

/**
 * UV detector, all three channels (§6.14, §7.5).
 *
 * Chain per channel, in order:
 * `A_true` (Beer–Lambert at the detector plane) → `+ RI artefact + air spike` →
 * `strayLight` → `+ white + pink + drift + fouling` → first-order filter `uv.tau_s` →
 * `- A_zero`. `UV_OVERRANGE` at 2.00 AU on the measured value; `UV_SATURATED` LATCHED at 2.40 AU.
 *
 * Noise: one white draw per channel plus a 4-octave Voss–McCartney pink generator per channel,
 * `pink[ch*4 + source]`, source `k` refreshed every `2^k` ticks — but ALL FOUR are DRAWN every
 * tick and the unused draws discarded, so the count is a fixed 3 white + 12 pink regardless of
 * `run.tick` (§5.9, §6.14).
 *
 * Drift is `driftStart_AU * exp(-t/driftTau_s) + driftWarm_AU_s * t`: a lamp warm-up transient on
 * top of a sustained rate. It is identical on all three channels — the contract authors one drift
 * pair, and inventing per-channel factors would be a fabricated constant.
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {number} dt_s physics timestep, s
 * @returns {void} writes `run.uv.{Atrue,Ameas,Afilt,pink,drift,foul_AU,ri_AU,condPrev_mScm,
 *   overrange,saturated,lampFault}` — absorbances in AU
 */
export function updateUV(config, run, dt_s) {
  syncCaches(config, run);
  const cfg = config.skid.uv;
  const uv = run.uv;
  const stream = run.rng.streams[RNG_STREAMS.UV];

  const ri_AU = riArtifact_AU(config, run, dt_s);
  const airSpike_AU = cfg.airSpike_AU * clamp(run.fAirDet, 0, 1);
  uv.foul_AU = cfg.foulPerCycle_AU * run.cycleIndex;

  const drift_AU = cfg.driftStart_AU * Math.exp(-run.t_s / cfg.driftTau_s)
    + cfg.driftWarm_AU_s * run.t_s;
  uv.lampFault = (cfg.driftWarm_AU_s * 3600) > LAMP_FAULT_DRIFT_AU_PER_H;

  const aFilt = alphaFor(dt_s, cfg.tau_s);
  const tick = run.tick;
  let overrange = false;

  for (let ch = 0; ch < N_UV; ch++) {
    // 1 white + 4 pink draws per channel, all unconditional (§6.14).
    const white = nextGaussian(stream) * cfg.noiseWhite_AU;
    let pinkSum = 0;
    for (let k = 0; k < 4; k++) {
      const g = nextGaussian(stream);                       // ALWAYS drawn...
      if ((tick & ((1 << k) - 1)) === 0) uv.pink[ch * 4 + k] = g;  // ...only sometimes kept
      pinkSum += uv.pink[ch * 4 + k];
    }
    const pink = pinkSum * cfg.noisePink_AU / 2;

    const Atrue_AU = beerLambert_AU(config, run.yDet_mM, ch, cfg.pathlength_cm);
    uv.Atrue[ch] = Atrue_AU;
    uv.drift[ch] = drift_AU;

    const optical_AU = Atrue_AU + ri_AU * RI_CHANNEL_WEIGHT[ch] + airSpike_AU;
    const Ameas_AU = strayLight_AU(optical_AU, cfg.strayLight)
      + white + pink + drift_AU + uv.foul_AU;
    uv.Ameas[ch] = Ameas_AU;

    if (Ameas_AU > cfg.overrange_AU) overrange = true;
    if (Ameas_AU > cfg.saturated_AU) uv.saturated = true;   // LATCHED until resetRunState

    // Filtering the ZEROED signal is identical to filtering then subtracting a constant zero, and
    // autozeroUV drives the output to 0 explicitly, so no extra filter state is needed.
    uv.Afilt[ch] += ((Ameas_AU - uv.Azero[ch]) - uv.Afilt[ch]) * aFilt;
  }

  uv.overrange = overrange;
}

/**
 * Autozero one UV channel or all three: the current absolute reading becomes the new baseline.
 * Called at operator rate (`core/sim.js::autozero`, and at block start when `block.autozero`),
 * never from the per-tick path, so its small result object is allowed to allocate.
 *
 * Sets `QF.UV_AUTOZERO_UNSTABLE` when the zero is taken with air in the path or with the trace
 * still moving (filter residual above `AZ_UNSTABLE_NOISE_FACTOR` times the authored noise), and
 * CLEARS it on a clean autozero. The bit is event-set rather than recomputed per tick — the
 * condition is an event, and `skid/alarms.js` must still see it at 10 Hz.
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {280|260|300|'all'} channel wavelength in nm, or 'all'
 * @returns {{ok:boolean, reason?:string}} freshly allocated result (operator rate only)
 */
export function autozeroUV(config, run, channel) {
  syncCaches(config, run);
  const cfg = config.skid.uv;
  const uv = run.uv;

  let first = 0;
  let last = N_UV - 1;
  if (channel !== 'all') {
    const idx = cfg.channels_nm.indexOf(channel);
    if (idx < 0) return { ok: false, reason: `unknown UV channel ${channel}` };
    first = idx;
    last = idx;
  }
  if (uv.lampFault) return { ok: false, reason: 'UV lamp fault — cannot autozero' };

  const noiseBand_AU = AZ_UNSTABLE_NOISE_FACTOR * (cfg.noiseWhite_AU + cfg.noisePink_AU);
  let unstable = run.fAirDet > config.skid.bubbleSensorThreshold_frac;
  for (let ch = first; ch <= last; ch++) {
    const residual_AU = Math.abs((uv.Ameas[ch] - uv.Azero[ch]) - uv.Afilt[ch]);
    if (residual_AU > noiseBand_AU) unstable = true;
  }
  for (let ch = first; ch <= last; ch++) {
    uv.Azero[ch] += uv.Afilt[ch];
    uv.Afilt[ch] = 0;
  }

  if (unstable) run.qualityFlags |= QF.UV_AUTOZERO_UNSTABLE;
  else run.qualityFlags &= ~QF.UV_AUTOZERO_UNSTABLE;

  const block = (config.method && config.method.blocks) ? config.method.blocks[run.blockIndex] : null;
  logEvent(config, run, {
    type: 'AUTOZERO',
    severity: unstable ? 'WARN' : 'INFO',
    source: 'OPERATOR',
    blockId: block ? block.id : null,
    message: channel === 'all' ? 'Autozero all UV channels' : `Autozero UV ${channel} nm`,
    detail: { channel, unstable, Azero_AU: Array.from(uv.Azero) },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Quality flags
// ---------------------------------------------------------------------------------------------

/**
 * Recompute `run.qualityFlags` (§5.3). Fixed cost, no branches on speed.
 *
 * `UV_SATURATED` and `BED_COLLAPSED` LATCH until `resetRunState`. `UV_AUTOZERO_UNSTABLE` is
 * event-set by `autozeroUV` and preserved here: it records something that HAPPENED, so a per-tick
 * recomputation would be meaningless, and `skid/alarms.js` row 14 needs it visible at 10 Hz.
 * Every other bit is recomputed from scratch each tick.
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @returns {void} writes `run.qualityFlags` (16-bit field)
 */
export function updateQualityFlags(config, run) {
  syncCaches(config, run);
  const prev = run.qualityFlags;
  let f = 0;

  // --- latched / event-set bits carried forward -------------------------------------------
  f |= prev & (QF.UV_SATURATED | QF.BED_COLLAPSED | QF.UV_AUTOZERO_UNSTABLE);

  // --- UV ----------------------------------------------------------------------------------
  if (run.uv.overrange) f |= QF.UV_OVERRANGE;
  if (run.uv.saturated) f |= QF.UV_SATURATED;
  if (run.uv.lampFault) f |= QF.UV_LAMP_FAULT;

  // --- conductivity --------------------------------------------------------------------------
  if (run.cond.dry) f |= QF.COND_DRY;
  if (run.T_cell_C < COND_TEMP_OK_LO_C || run.T_cell_C > COND_TEMP_OK_HI_C) f |= QF.COND_TEMP_RANGE;

  // --- pH ------------------------------------------------------------------------------------
  if (run.ph.frozen) f |= QF.PH_FROZEN_AIR;
  if (run.ph.slopePct < PH_DEGRADED_SLOPE_PCT || Math.abs(run.ph.offset_mV) > PH_DEGRADED_OFFSET_MV) {
    f |= QF.PH_ELECTRODE_DEGRADED;
  }

  // --- pressure ------------------------------------------------------------------------------
  const dPalm_bar = run.press.P1alm_bar - run.press.P2alm_bar;
  const pcfg = config.skid.press;
  const railed = run.press.P1raw_bar >= pcfg.P1FS_bar
    || run.press.P2raw_bar >= pcfg.P2FS_bar
    || run.press.P1raw_bar <= -PRESS_UNDERRANGE_FRAC_FS * pcfg.P1FS_bar
    || run.press.P2raw_bar <= -PRESS_UNDERRANGE_FRAC_FS * pcfg.P2FS_bar;
  if (dPalm_bar < PRESS_SUSPECT_DP_bar || railed) f |= QF.PRESS_SUSPECT;

  // --- path / system --------------------------------------------------------------------------
  if (run.valves.columnValve === 'CIP_DETECTOR_BYPASS') f |= QF.DETECTORS_BYPASSED;
  if (run.fAirDet > config.skid.bubbleSensorThreshold_frac) f |= QF.AIR_IN_PATH;
  if (run.flowReduction.active) f |= QF.FLOW_REDUCED;
  if (run.manualOverride) f |= QF.MANUAL_OVERRIDE;

  const smaFrozen = run.diag ? run.diag.smaFrozen : 0;
  if (smaFrozen > cache.prevSmaFrozen) f |= QF.SOLVER_FROZEN;
  cache.prevSmaFrozen = smaFrozen;

  if (run.speedDeficit > SPEED_LIMIT_DEFICIT) f |= QF.SPEED_LIMITED;
  if (run.bedCollapsed) f |= QF.BED_COLLAPSED;

  run.qualityFlags = f;
}

/**
 * Per-sensor quality verdict (§5.3). Resolution order, first match wins:
 * 1. `DETECTORS_BYPASSED` → `'BYPASSED'` (all four sensors);
 * 2. the sensor's INVALID bits → `'INVALID'`;
 * 3. the sensor's SUSPECT bits, or `AIR_IN_PATH` → `'SUSPECT'`;
 * 4. otherwise `'OK'`.
 *
 * @param {object} run mutable run state (reads `run.qualityFlags` only)
 * @param {'UV'|'COND'|'PH'|'PRESS'} sensor which transducer
 * @returns {'OK'|'SUSPECT'|'INVALID'|'BYPASSED'} verdict
 */
export function sensorQuality(run, sensor) {
  const f = run.qualityFlags;
  if (f & QF.DETECTORS_BYPASSED) return 'BYPASSED';

  let invalid = 0;
  let suspect = 0;
  switch (sensor) {
    case 'UV':
      invalid = QF.UV_LAMP_FAULT;
      suspect = QF.UV_OVERRANGE | QF.UV_SATURATED | QF.UV_AUTOZERO_UNSTABLE;
      break;
    case 'COND':
      invalid = QF.COND_DRY;
      suspect = QF.COND_TEMP_RANGE;
      break;
    case 'PH':
      invalid = QF.PH_FROZEN_AIR;
      suspect = QF.PH_ELECTRODE_DEGRADED;
      break;
    case 'PRESS':
      invalid = 0;
      suspect = QF.PRESS_SUSPECT;
      break;
    default:
      return 'OK';
  }
  if (f & invalid) return 'INVALID';
  if ((f & suspect) || (f & QF.AIR_IN_PATH)) return 'SUSPECT';
  return 'OK';
}

// ---------------------------------------------------------------------------------------------
// Signal lookup
// ---------------------------------------------------------------------------------------------

/**
 * The 22 watch / alarm / fractionation signal names of §5.2, with their units.
 * ALWAYS returns a number: `NaN` means "not evaluable this tick", and every comparison against
 * `NaN` is false, which is exactly the required behaviour. Names are UPPERCASE and are a DIFFERENT
 * namespace from the §5.1 log channels — `'temp_fluid'` is not a signal.
 *
 * Units returned:
 *   `UV_280`/`UV_260`/`UV_300` AU/cm · `UV_RATIO_260_280` – · `COND`/`COND_TEMP_COMP`/`COND_RAW`
 *   mS/cm · `PH` pH · `P1`/`P2`/`DP` bar (the ALARM filter, not the display filter) ·
 *   `FLOW` mL/s · `VOLUME_BLOCK`/`VOLUME_RUN` mL · `TIME_BLOCK`/`TIME_RUN` s · `PCTB` 0–100 %
 *   · `AIR` 0–1 · `LOAD_PROGRESS_PCT` 0–100 % · `TEMP_FLUID`/`TEMP_CELL` °C ·
 *   `TANK_LEVEL:<id>` mL.
 *
 * `TANK_LEVEL:<id>` must NOT be reached on the hot path: `normalizeMethod`/`normalizePreset`
 * pre-split it into `{ base, tankIdx }` on the watch/alarm row and the 10 Hz path reads
 * `run.tankVolume_mL[signalResolved.tankIdx]` directly (§5.2). The branch below exists only so an
 * off-path caller (editor preview, tests) is not silently wrong; it is last, after the switch, so
 * no hot-path name ever touches it.
 *
 * @param {object} config canonical frozen config
 * @param {object} run mutable run state
 * @param {string} name one of the 22 §5.2 names
 * @returns {number} the signal value in the unit above, or NaN when not evaluable
 */
export function sensorSignal(config, run, name) {
  const path_cm = config.skid.uv.pathlength_cm;
  switch (name) {
    case 'UV_280': return run.uv.Afilt[0] / path_cm;
    case 'UV_260': return run.uv.Afilt[1] / path_cm;
    case 'UV_300': return run.uv.Afilt[2] / path_cm;
    case 'UV_RATIO_260_280':
      return (run.uv.Afilt[0] < 0.01) ? NaN : run.uv.Afilt[1] / run.uv.Afilt[0];
    case 'COND':
    case 'COND_TEMP_COMP': return run.cond.kappaDisp_mScm;
    case 'COND_RAW': return run.cond.kappaFilt_mScm;
    case 'PH': return run.ph.pHfilt;
    case 'P1': return run.press.P1alm_bar;
    case 'P2': return run.press.P2alm_bar;
    case 'DP': return run.press.P1alm_bar - run.press.P2alm_bar;
    case 'FLOW': return run.Q_actual_mLs;
    case 'VOLUME_BLOCK': return run.V_block_mL;
    case 'VOLUME_RUN': return run.V_run_mL;
    case 'TIME_BLOCK': return run.blockElapsed_s;
    case 'TIME_RUN': return run.t_s;
    case 'PCTB': return run.pctB_colInlet;
    case 'AIR': return run.fAirDet;
    case 'LOAD_PROGRESS_PCT': {
      const target_mL = (config.load && config.load.derived) ? config.load.derived.volume_mL : 0;
      return (target_mL > 0) ? 100 * run.V_load_mL / target_mL : NaN;
    }
    case 'TEMP_FLUID': return run.T_fluid_C;
    case 'TEMP_CELL': return run.T_cell_C;
    default: break;
  }
  if (typeof name === 'string' && name.startsWith('TANK_LEVEL:')) {
    syncConfigCache(config);
    const idx = cache.tankIndexById.get(name.slice(11));
    return (idx === undefined) ? NaN : run.tankVolume_mL[idx];
  }
  return NaN;
}
