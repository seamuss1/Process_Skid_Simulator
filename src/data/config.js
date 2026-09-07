/**
 * src/data/config.js — the rig as built. Every number an engineer would find on a datasheet,
 * in one file, frozen at boot.
 *
 * Layer L3: imports the L1 process factories and `core/util.js`. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THESE NUMBERS AND NOT OTHERS
 *
 * A simulator is only worth tuning if the interesting things are REACHABLE. This plant was sized
 * backwards from four behaviours that all have to be available from the default operating point
 * without the operator hunting for them:
 *
 *   1. One pump comfortably in control.       FCV at 45% puts P-101 at 67% speed, CO 40%.
 *   2. Saturation.                            FCV above about 70% asks for more head than one
 *                                             machine can make; the output pins at 100%.
 *   3. A stage-up with real hysteresis.       Two pumps then settle near CO 50%, so the
 *                                             stage-down threshold at 40% is not tripped by the
 *                                             stage-up itself. That gap is the whole defence
 *                                             against short-cycling, and it had to be designed,
 *                                             not hoped for.
 *   4. Cavitation.                            Not on the default settings, and not by accident:
 *                                             it needs the temperature above about 93 C, or a
 *                                             strainer blinded past 80%, or a low tank — or a
 *                                             combination, which is how it actually happens.
 *
 * THE VFD REFERENCE SCALING is worth one more paragraph. The controller output is 0..100% and the
 * drive maps that onto 45..100% shaft speed, which is how every VFD on a pressure loop is
 * configured. It is not cosmetic: below about 58% speed this pump cannot make the setpoint head
 * at all, so an unscaled output would have had a dead band across its whole bottom half. Scaling
 * the reference puts the controller's range where the process actually lives.
 * ------------------------------------------------------------------------------------------
 */

import { deepFreeze, deepMerge } from '../core/util.js';
import { createPump } from '../process/pump.js';
import { createDrive } from '../process/motor.js';
import { createValve, TRIM } from '../process/valve.js';

/** Which variable the loop controls. */
export const LOOP = Object.freeze({
  /** PIC-101: header pressure, bar. Slow, dominated by the surge vessel. */
  PRESSURE: 'PRESSURE',
  /** FIC-101: flow to process, m3/h. Fast, dominated by the drive ramp. */
  FLOW: 'FLOW',
});

/** Engineering-unit metadata for each loop mode, used by the faceplate and the trend. */
export const LOOP_EU = Object.freeze({
  PRESSURE: { tag: 'PIC-101', pv: 'PT-101', unit: 'bar', lo: 0, hi: 8, dp: 2, step: 0.1 },
  FLOW: { tag: 'FIC-101', pv: 'FT-101', unit: 'm3/h', lo: 0, hi: 150, dp: 1, step: 1 },
});

/** The as-built plant. Overridable through {@link buildConfig} for the tests. */
const BASE = {
  /** Physics tick, s. 50 Hz — fast enough that the drive ramp and the vessel are both resolved. */
  dt_s: 0.02,
  /** Controller scan, s. A real DCS scans far slower than the process moves, and it matters. */
  scan_s: 0.2,
  /** Master seed. Every stochastic effect derives its stream from this, so a run repeats. */
  seed: 0x50494431,
  /**
   * Time constant of cavitation inception and recovery, s. Vapour cavities do not form or
   * collapse instantly, and this lag is also what keeps the explicit suction coupling from
   * limit-cycling at the tick rate when a pump sits exactly on its NPSH curve.
   */
  cavTau_s: 0.4,

  fluid: {
    /** Liquid temperature at boot, C. */
    T_C: 20,
  },

  tank: {
    tag: 'TK-101',
    /** Plan area, m2 — a 2 m diameter vessel. */
    area_m2: 3.14,
    /** Straight side, m. */
    height_m: 4.0,
    /** Height of the tank floor above the pump centreline, m. Negative: the pumps sit above it. */
    zBase_m: -1.6,
    /** Level at boot, m. */
    level0_m: 2.4,
    /** Level the make-up controller holds when it is in auto, m. */
    levelSP_m: 2.4,
    /** Make-up proportional gain, m3/h per m of level error. */
    makeupGain: 30,
    /** Make-up valve capacity, m3/h. */
    makeupMax_m3h: 160,
    /** Tank surface pressure, bar gauge. Zero: the vessel is vented. */
    pTank_bar: 0,
  },

  /** Common suction manifold and each pump's strainer. Fouling acts on this Kv. */
  suction: { tag: 'STR-101', kv_m3h: 300 },

  /** Each pump's discharge spool and its non-return valve. */
  discharge: { kv_m3h: 400, checkKv_m3h: 500 },

  header: {
    tag: 'HDR-101',
    /**
     * Gas volume in the bladder vessel, m3. THE dominant lag of the pressure loop: the
     * capacitance is rho*g*Vgas/p_abs, about 3e-3 m3 per metre of head at duty, which against a
     * network slope of some 4 m3/h per metre gives a process time constant near three seconds.
     * Shrink it and the loop gets faster and much harder to tune; that is a legitimate experiment
     * and it is why the number is here rather than buried.
     */
    gasVolume_m3: 0.12,
  },

  /** FCV-101 — the LOAD, not the final control element. The operator drives it as a disturbance. */
  demandSpec: {
    tag: 'FCV-101',
    kvMax_m3h: 130,
    trim: TRIM.EQUAL_PCT,
    rangeability: 50,
    leakFrac: 0.0008,
    strokeTime_s: 6,
  },
  demand: {
    /** Travel at boot, 0..1. */
    x0: 0.45,
    /** Static head downstream of the valve, m. The process's own back pressure. */
    hDischarge_m: 6,
    /** Stroke time, s — mirrored here so the plant does not have to reach into the valve spec. */
    strokeTime_s: 6,
  },

  /** RO-101 — the minimum-flow recirculation back to the tank. Linear trim, hand-set. */
  bypassSpec: {
    tag: 'RO-101',
    kvMax_m3h: 10,
    trim: TRIM.LINEAR,
    rangeability: 20,
    leakFrac: 0.01,
    strokeTime_s: 4,
  },
  bypass: { x0: 0.35 },

  pumpSpec: {
    H0_m: 95,
    Qbep_m3h: 45,
    Hbep_m: 72,
    a1: 0.06,
    etaBep: 0.78,
    nRated_rpm: 2950,
    motor_kW: 15,
    motorI_A: 28.5,
    npshr0_m: 1.2,
    npshrBep_m: 4.5,
    minFlowFrac: 0.15,
  },

  driveSpec: {
    /** Shaft speed at 0% controller output, percent of rated. The VFD's minimum frequency. */
    minSpeed_pct: 45,
    /** Shaft speed at 100% controller output, percent of rated. */
    maxSpeed_pct: 100,
    /** Seconds to ramp across the full speed range on the way up. */
    accel_s: 10,
    /** Seconds to ramp across the full speed range on the way down. */
    decel_s: 14,
    /** Contactor and permissive delay before the ramp starts, s. Pure dead time. */
    startDelay_s: 1.5,
    /** Overload pickup, percent of full-load amps. */
    tripCurrent_pct: 118,
    /** Time above pickup before lockout, s. */
    tripDelay_s: 8,
  },

  instruments: {
    /** PT-101, on the header. */
    pt: { tag: 'PT-101', lo_bar: 0, hi_bar: 8, deadTime_s: 0.4, filter_s: 0.5, noise_bar: 0.006 },
    /** FT-101, on the line to process. Magflows are noisier than pressure transmitters. */
    ft: { tag: 'FT-101', lo_m3h: 0, hi_m3h: 150, deadTime_s: 0.6, filter_s: 0.8, noise_m3h: 0.35 },
    /** LT-101, on the suction tank. */
    lt: { tag: 'LT-101', filter_s: 2.0, noise_m: 0.004 },
  },

  alarms: {
    /** Header pressure, bar. */
    ptHH: 6.2, ptHI: 5.4, ptLO: 1.8, ptLL: 1.0,
    /** Tank level, m. */
    ltLO: 0.65, ltLL: 0.25,
    /** NPSH margin below which the suction is called marginal, m. */
    npshMargin_m: 0.8,
    /** Deviation from setpoint, as a fraction of the loop's span, and how long it must persist. */
    devFrac: 0.06, devDelay_s: 25,
    /** Stage transitions within this window that count as short-cycling. */
    cycleWindow_s: 600, cycleCount: 4,
  },

  /** Trend capacity, samples. At 5 Hz logging this is fifty minutes of history. */
  trendRows: 15000,
  /** Trend logging period, s. */
  trendPeriod_s: 0.2,
};

/**
 * Build the frozen config, optionally patched.
 *
 * The pump, drive and valve MODELS are constructed here rather than declared, so their derived
 * coefficients — the head curve's `a2`, the NPSH coefficient, the runout flow — can never fall
 * out of step with the datasheet points they came from.
 *
 * @param {object} [patch] a deep patch over {@link BASE}, for tests and scenarios
 * @returns {object} the deeply frozen config
 */
export function buildConfig(patch) {
  const c = deepMerge(BASE, patch);
  const pumps = [
    createPump({ ...c.pumpSpec, tag: 'P-101' }),
    createPump({ ...c.pumpSpec, tag: 'P-102' }),
  ];
  const drives = [
    createDrive({ ...c.driveSpec, tag: 'VFD-101' }),
    createDrive({ ...c.driveSpec, tag: 'VFD-102' }),
  ];
  return deepFreeze({
    ...c,
    pumps,
    drives,
    demandValve: createValve(c.demandSpec),
    bypassValve: createValve(c.bypassSpec),
    // The plant reads `config.demand` and `config.bypass` for state, and needs the valve models
    // under the same names, so they are aliased in rather than looked up by a second path.
    demand: { ...c.demand, ...createValve(c.demandSpec) },
    bypass: { ...c.bypass, ...createValve(c.bypassSpec) },
  });
}

/** Default setpoints for each loop mode, in that mode's engineering units. */
export const DEFAULT_SP = Object.freeze({
  PRESSURE: 3.2,
  FLOW: 30,
});
