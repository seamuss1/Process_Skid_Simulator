/**
 * src/data/config.js — the rig as built. Every number an engineer would find on a datasheet, a
 * line list or a site survey, in one file, frozen at boot.
 *
 * Layer L3: imports the L1 process factories and `core/util.js`. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THESE NUMBERS AND NOT OTHERS
 *
 * A simulator is only worth tuning if the interesting things are REACHABLE. This plant was sized
 * backwards from the behaviours that all have to be available from the default operating point
 * without the operator hunting for them:
 *
 *   1. One pump comfortably in control.       FCV at 45% puts P-101 near 67% speed, CO 40%.
 *   2. Saturation.                            FCV above about 70% asks for more head than one
 *                                             machine can make; the output pins at 100%.
 *   3. A stage-up with real hysteresis.       Two pumps then settle near CO 50%, so the
 *                                             stage-down threshold at 40% is not tripped by the
 *                                             stage-up itself.
 *   4. Cavitation.                            Not on the defaults, and not by accident: it needs
 *                                             heat, or a blinded strainer, or a low tank, or
 *                                             altitude — or a combination, which is how it
 *                                             actually happens.
 *   5. Minimum-flow damage.                   Shut the recirculation at low demand and the casing
 *                                             temperature climbs on its own thermal time constant.
 *   6. Surge.                                 The discharge line holds a real column of liquid.
 *                                             Slam FCV-101 and it has to be stopped by pressure.
 *   7. A visible price for throttling.        The same duty on a throttle valve instead of the
 *                                             drives costs far more energy, and the wire-to-water
 *                                             figure says so.
 *
 * THE VFD REFERENCE SCALING. The controller output is 0..100% and the drive maps that onto
 * 45..100% shaft speed, which is how every VFD on a pressure loop is configured. It is not
 * cosmetic: below about 58% speed this pump cannot make the setpoint head at all, so an unscaled
 * output would carry a dead band across its whole bottom half.
 * ------------------------------------------------------------------------------------------
 */

import { deepFreeze, deepMerge } from '../core/util.js';
import { createPump } from '../process/pump.js';
import { createDrive } from '../process/motor.js';
import { createValve, TRIM } from '../process/valve.js';
import { createPipe, ROUGHNESS_MM, sumFittings } from '../process/pipe.js';

/** Which variable the loop controls. */
export const LOOP = Object.freeze({
  /** PIC-101: header pressure, bar. Slow — the surge vessel dominates. */
  PRESSURE: 'PRESSURE',
  /** FIC-101: flow to process, m3/h. Fast — the drive ramp dominates. */
  FLOW: 'FLOW',
  /** LIC-101: suction tank level, m. An integrating process, and a different animal entirely. */
  LEVEL: 'LEVEL',
});

/** Engineering-unit metadata for each loop mode, used by the faceplate, trend and scorecard. */
export const LOOP_EU = Object.freeze({
  PRESSURE: { tag: 'PIC-101', pv: 'PT-101', unit: 'bar', lo: 0, hi: 8, dp: 2, step: 0.05 },
  FLOW: { tag: 'FIC-101', pv: 'FT-101', unit: 'm³/h', lo: 0, hi: 150, dp: 1, step: 1 },
  LEVEL: { tag: 'LIC-101', pv: 'LT-101', unit: 'm', lo: 0, hi: 4, dp: 2, step: 0.05 },
});

/** Default setpoints for each loop mode, in that mode's engineering units. */
export const DEFAULT_SP = Object.freeze({ PRESSURE: 3.2, FLOW: 30, LEVEL: 2.4 });

/** Conservative starting tunings for each loop mode. Gains carry units; these do not transfer. */
export const DEFAULT_TUNING = Object.freeze({
  PRESSURE: { Kc: 18, Ti: 12, Td: 0 },
  FLOW: { Kc: 1.4, Ti: 6, Td: 0 },
  LEVEL: { Kc: 30, Ti: 900, Td: 0 },
});

/** The as-built plant. Overridable through {@link buildConfig} for the tests and the lessons. */
const BASE = {
  /** Physics tick, s. 50 Hz — fast enough that the drive ramp and the vessel are both resolved. */
  dt_s: 0.02,
  /** Controller scan, s. A real DCS scans far slower than the process moves, and it matters. */
  scan_s: 0.2,
  /** Master seed. Every stochastic effect derives its stream from this, so a run repeats. */
  seed: 0x50494431,
  /** Time constant of cavitation inception and recovery, s. */
  cavTau_s: 0.4,

  site: {
    name: 'Unit 101',
    /** Site elevation, m above sea level. Only used to derive the barometric pressure. */
    elevation_m: 0,
    /** Barometric pressure, bar absolute. Derived from elevation in {@link buildConfig}. */
    pAtm_bar: 1.01325,
    /** Ambient air temperature, C. Sets where casings and tanks lose their heat to. */
    ambient_C: 20,
  },

  fluid: {
    /** Which liquid the rig is filled with at boot, one of the `FLUIDS` ids. */
    id: 'WATER',
    /** Temperature at boot, C. */
    T_C: 20,
  },

  thermal: {
    /** Specific heat of the casing metal, J/(kg K). Cast iron and steel are both about 490. */
    metalCp_JkgK: 490,
    /** Heat leak from a pump casing to ambient, W/K. Small — a casing is not a radiator. */
    casingUA_WK: 12,
    /** Heat leak from the tank to ambient, W/K. */
    tankUA_WK: 90,
    /** Allowable temperature rise across a pump, K. Sets the thermal minimum flow. */
    dTlimit_K: 10,
  },

  wear: {
    /** Wear fraction accrued per running hour at the best-efficiency point. */
    baseRate_perH: 2.0e-5,
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

  /** Line data. Real pipe, so viscosity reaches the SYSTEM curve and not only the pump. */
  lines: {
    /** Common suction manifold and the branch to each pump. */
    suction: {
      tag: '150-PL-101', id_mm: 154, length_m: 12, roughness_mm: ROUGHNESS_MM.STEEL,
      fittings: [['ENTRY_SHARP', 1], ['ELBOW_90_LR', 3], ['TEE_BRANCH', 1], ['GATE_OPEN', 1]],
    },
    /** Each pump's discharge spool up to the header. */
    pumpDischarge: {
      tag: '125-PL-102', id_mm: 131, length_m: 4, roughness_mm: ROUGHNESS_MM.STEEL,
      fittings: [['REDUCER', 1], ['ELBOW_90_LR', 1], ['TEE_BRANCH', 1]],
    },
    /**
     * The header out to the process. Its LENGTH is the number that matters most here: it sets the
     * inertia of the moving column, and therefore how violent a fast valve closure is.
     */
    discharge: {
      tag: '150-PL-103', id_mm: 154, length_m: 25, roughness_mm: ROUGHNESS_MM.STEEL,
      fittings: [['ELBOW_90_LR', 4], ['EXIT', 1]],
    },
  },

  /** The strainer in each suction branch. Fouling acts on this Kv. */
  suction: { tag: 'STR-101', strainerKv_m3h: 300 },

  /** Each pump's non-return valve. */
  discharge: { checkKv_m3h: 500 },

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
    stickband: 0,
    slipJump: 0,
  },
  demand: {
    /** Travel at boot, 0..1. */
    x0: 0.45,
    /** Static head downstream of the valve, m. The process's own back pressure. */
    hDischarge_m: 6,
  },

  /**
   * PCV-101 — the throttle valve. Wide open in variable-speed mode, and the final control element
   * when the rig is run the old way. Equal-percentage trim, because in a system whose loss is
   * dominated by everything else, that is the trim that gives a roughly linear installed
   * characteristic.
   */
  pcvSpec: {
    tag: 'PCV-101',
    kvMax_m3h: 150,
    trim: TRIM.EQUAL_PCT,
    rangeability: 50,
    leakFrac: 0.0006,
    strokeTime_s: 4,
    /** Stem friction, as a fraction of travel. Zero is a valve that has just been serviced. */
    stickband: 0,
    slipJump: 0,
  },

  /** RO-101 — the minimum-flow recirculation back to the tank. */
  bypassSpec: {
    tag: 'RO-101',
    kvMax_m3h: 12,
    trim: TRIM.LINEAR,
    rangeability: 20,
    leakFrac: 0.01,
    strokeTime_s: 4,
  },
  bypass: {
    /** Travel at boot, 0..1, used when the recirculation is in MANUAL. */
    x0: 0.35,
    /** Forward flow per running pump below which the ARV starts to open, m3/h. */
    arvSetpoint_m3h: 12,
  },

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
    casingVolume_L: 15,
    casingMass_kg: 60,
  },

  /** Impeller diameter ratio of each machine. Identical by default; a lever for mismatch. */
  pumpTrim: [1.0, 1.0],

  driveSpec: {
    /** Shaft speed at 0% controller output, percent of rated. The VFD's minimum frequency. */
    minSpeed_pct: 45,
    /** Shaft speed at 100% controller output, percent of rated. */
    maxSpeed_pct: 100,
    /** Seconds to ramp the reference across the full speed range on the way up. */
    accel_s: 10,
    /** Seconds to ramp it back down. */
    decel_s: 14,
    /** Contactor and permissive delay before the ramp starts, s. Pure dead time. */
    startDelay_s: 1.5,
    /** Rated motor efficiency at full load. An IE3 15 kW machine. */
    etaMotor: 0.926,
    /** Combined motor, coupling and pump rotating inertia, kg m2. */
    inertia_kgm2: 0.13,
    /** Drive torque limit, percent of rated torque. */
    torqueLimit_pct: 150,
    /** Instantaneous overcurrent trip, percent of FLA. */
    tripCurrent_pct: 220,
    /** Motor thermal time constant, s. About twenty minutes for a 15 kW TEFC machine. */
    thermalTau_s: 1200,
    /** Thermal capacity used at which the overload trips, percent. */
    thermalTripPct: 115,
  },

  instruments: {
    /** PT-101, on the header. */
    pt: { tag: 'PT-101', lo_bar: 0, hi_bar: 8, deadTime_s: 0.4, filter_s: 0.5, noise_bar: 0.006 },
    /** FT-101, on the line to process. Magflows are noisier than pressure transmitters. */
    ft: { tag: 'FT-101', lo_m3h: 0, hi_m3h: 150, deadTime_s: 0.6, filter_s: 0.8, noise_m3h: 0.35 },
    /** LT-101, on the suction tank. */
    lt: { tag: 'LT-101', filter_s: 2.0, noise_m: 0.004 },
    /** TT-101, tank temperature. Slow, because a thermowell is. */
    tt: { tag: 'TT-101', filter_s: 12 },
  },

  alarms: {
    /** Header pressure, bar. */
    ptHH: 6.2, ptHI: 5.4, ptLO: 1.8, ptLL: 1.0,
    /** Tank level, m. */
    ltLO: 0.65, ltLL: 0.25,
    /** NPSH margin below which the suction is called marginal, m. */
    npshMargin_m: 0.8,
    /**
     * Seconds a machine must stay below its minimum continuous flow before it is called.
     *
     * Longer than any legitimate start transient — a drive takes a few seconds to build enough
     * head to crack its own check valve, and a make-before-break changeover deliberately runs a
     * machine against a shut valve for the whole overlap — and far shorter than the time it takes
     * to do any damage.
     */
    minFlowDelay_s: 25,
    /** Casing temperature above the tank temperature at which minimum flow is being violated, K. */
    casingRise_K: 12,
    /** Absolute casing temperature that is an emergency, C. */
    casingHigh_C: 95,
    /** Vibration, mm/s RMS. ISO 10816-3 zone boundaries for a medium machine on a rigid base. */
    vibWarn_mms: 4.5, vibAlarm_mms: 7.1,
    /** Wear fraction at which the machine should be scheduled for overhaul. */
    wearWarn: 0.55, wearAlarm: 0.85,
    /** Motor thermal capacity used, percent. */
    thermalWarn_pct: 85,
    /**
     * Header pressure rate of change that counts as a surge event, bar/s.
     *
     * Set from what this rig can actually produce, not from a textbook Joukowsky figure. The
     * bladder vessel sits directly on the header, so slamming the demand valve does NOT give a
     * classical water hammer — the vessel takes the flow the valve stopped passing, and the rise
     * is limited by the capacitance rather than by the celerity. Slamming from 25 m3/h gives
     * about 0.6 bar/s and a 1.6 bar excursion, so 0.45 is a threshold that catches a genuine
     * slam and ignores a stage transition.
     */
    surgeRate_barps: 0.45,
    /** Deviation from setpoint, as a fraction of the loop's span, and how long it must persist. */
    devFrac: 0.06, devDelay_s: 25,
    /** Stage transitions within this window that count as short-cycling. */
    cycleWindow_s: 600, cycleCount: 4,
  },

  energy: {
    /** Electricity price, currency per kWh, for the running-cost readout. */
    tariff_perkWh: 0.18,
    /** Currency symbol. */
    symbol: '$',
  },

  /** Trend capacity, samples. At 5 Hz logging this is fifty minutes of history. */
  trendRows: 15000,
  /** Trend logging period, s. */
  trendPeriod_s: 0.2,
};

/**
 * Barometric pressure from site elevation, by the ISA standard atmosphere.
 *
 * Worth having as a slider rather than a constant: a pump installed at 2000 m has lost a fifth of
 * its atmospheric contribution to NPSH available before anything else has gone wrong, and a duty
 * that is comfortable at sea level can be marginal on the same day at altitude.
 *
 * @param {number} elevation_m metres above sea level
 * @returns {number} pressure, bar absolute
 */
export function barometric_bar(elevation_m) {
  return 1.01325 * Math.pow(1 - 2.25577e-5 * Math.max(0, elevation_m), 5.25588);
}

/**
 * Build the frozen config, optionally patched.
 *
 * The pump, drive, valve and pipe MODELS are constructed here rather than declared, so their
 * derived coefficients — the head curve's `a2`, the best-efficiency power, the specific speed, the
 * fluid inertia of a line — can never fall out of step with the datasheet points they came from.
 *
 * @param {object} [patch] a deep patch over the as-built plant, for tests, lessons and scenarios
 * @returns {object} the deeply frozen config
 */
export function buildConfig(patch) {
  const c = deepMerge(BASE, patch);
  const pumps = [
    createPump({ ...c.pumpSpec, tag: 'P-101' }),
    createPump({ ...c.pumpSpec, tag: 'P-102' }),
  ];
  const drives = [
    createDrive({ ...c.driveSpec, ...c.pumpSpec, tag: 'VFD-101' }),
    createDrive({ ...c.driveSpec, ...c.pumpSpec, tag: 'VFD-102' }),
  ];
  const pipe = (spec) => createPipe({ ...spec, sumK: sumFittings(spec.fittings) });
  const patchedAtm = patch && patch.site && patch.site.pAtm_bar !== undefined;

  const out = {
    ...c,
    site: {
      ...c.site,
      pAtm_bar: patchedAtm ? patch.site.pAtm_bar : barometric_bar(c.site.elevation_m),
    },
    pumps,
    drives,
    pipes: {
      suction: pipe(c.lines.suction),
      pumpDischarge: pipe(c.lines.pumpDischarge),
      discharge: pipe(c.lines.discharge),
    },
    demandValve: createValve(c.demandSpec),
    pcvValve: createValve(c.pcvSpec),
    bypassValve: createValve(c.bypassSpec),
  };

  // ------------------------------------------------------------------------------------------
  // THE ONE FIELD THAT IS NOT FROZEN, AND WHY IT IS DONE THIS WAY
  //
  // Everything in the config is nameplate: the pipe was welded, the impeller was cut, the
  // transmitter was ranged, and none of it changes while the rig is running. Freezing it means a
  // module cannot quietly reach in and adjust the plant instead of controlling it, which is a
  // real class of bug and an expensive one to find later.
  //
  // The controller scan period is the exception. It is genuinely a commissioning decision — a
  // number an engineer picks, argues about, and should be able to change here to watch a good
  // tuning decay as the scan slows down. So it is stored in a closure and exposed as an ACCESSOR
  // property. `Object.freeze` makes data properties read-only but leaves accessors working, so
  // this is the one field that stays writable through a frozen object, and it is writable
  // deliberately rather than by having forgotten to freeze it.
  // ------------------------------------------------------------------------------------------
  let scan_s = c.scan_s;
  delete out.scan_s;
  Object.defineProperty(out, 'scan_s', {
    enumerable: true,
    configurable: false,
    get() { return scan_s; },
    set(v) { scan_s = v; },
  });
  return deepFreeze(out);
}
