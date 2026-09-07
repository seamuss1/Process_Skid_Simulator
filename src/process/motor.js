/**
 * src/process/motor.js — the VFD, the motor and the shaft: the drive state machine, the speed
 * regulator and its torque limit, the rotating inertia, the electrical losses and the thermal
 * overload.
 *
 * Layer L1: imports `core/util.js` only. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE, AND WHY IT IS NOT TRIVIAL
 *
 * The controller's output is not the pump's speed. Between them sit a permissive delay, a
 * reference ramp, a speed regulator with a torque limit, a rotating inertia, and a thermal
 * overload — six places where the loop's final element refuses to do what it was told. Every one
 * of them shows up in a trend as something a tuner will misread as process behaviour:
 *
 *   the reference ramp is a rate limit, so a large controller step arrives as a slope, and
 *     integral action that does not know about it winds up while the drive is still on its way;
 *   the torque limit means the ramp is a REQUEST — a drive accelerating a loaded pump against a
 *     current limit takes longer than its accel time says, and nothing on the faceplate says so
 *     except the current;
 *   the inertia means a tripped machine coasts rather than stops, and the flow it is still
 *     passing on the way down is real;
 *   the start delay is pure dead time, and dead time is the one thing no amount of gain fixes.
 *
 * ------------------------------------------------------------------------------------------
 * THE SHAFT IS INTEGRATED, NOT INTERPOLATED
 *
 * Speed is a state with inertia, not a number that is slewed toward a target:
 *
 *     J * dw/dt = T_motor - T_load
 *
 * with `T_motor` from a speed regulator inside the drive, clamped at the torque limit, and
 * `T_load` the pump's own torque. That is what a vector drive actually does, and it is what makes
 * a controlled stop and a coast-down look different from each other — which they should, because
 * one of them is a trip.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, slew } from '../core/util.js';

/** Drive states, in the order a healthy start passes through them. */
export const DRIVE = Object.freeze({
  /** At rest, ready to accept a start. */
  STOPPED: 'STOPPED',
  /** Start accepted; running out the permissive delay before the ramp begins. */
  STARTING: 'STARTING',
  /** Energised and regulating to the reference. */
  RUNNING: 'RUNNING',
  /** Stop accepted; the drive is ramping the shaft down under control. */
  STOPPING: 'STOPPING',
  /** Output disabled; the shaft is coasting on its own inertia. */
  COASTING: 'COASTING',
  /** Locked out. Requires an explicit reset. */
  TRIPPED: 'TRIPPED',
});

/** How a stop is executed. */
export const STOP_MODE = Object.freeze({
  /** The drive decelerates the shaft under control. */
  RAMP: 'RAMP',
  /** The output is disabled and the shaft coasts. What a trip always does. */
  COAST: 'COAST',
});

/**
 * Build a frozen drive and motor specification.
 * @param {object} spec drive data
 * @param {string} spec.tag drive tag, e.g. 'VFD-101'
 * @param {number} spec.minSpeed_pct shaft speed at 0% reference, percent of rated
 * @param {number} spec.maxSpeed_pct shaft speed at 100% reference, percent of rated
 * @param {number} spec.accel_s time to ramp the REFERENCE across the full range, s
 * @param {number} spec.decel_s time to ramp it back down, s
 * @param {number} spec.startDelay_s permissive/contactor delay before the ramp begins, s
 * @param {number} spec.motor_kW motor nameplate rating, kW
 * @param {number} spec.nRated_rpm rated shaft speed, rpm
 * @param {number} spec.motorI_A full-load current, A
 * @param {number} spec.etaMotor rated motor efficiency, 0..1
 * @param {number} spec.inertia_kgm2 combined motor, coupling and pump inertia
 * @param {number} spec.torqueLimit_pct drive torque limit, percent of rated torque
 * @param {number} spec.tripCurrent_pct instantaneous overcurrent trip, percent of FLA
 * @param {number} spec.thermalTau_s motor thermal time constant, s
 * @param {number} spec.thermalTripPct thermal capacity at which the overload trips, percent
 * @returns {object} the frozen drive model
 */
export function createDrive(spec) {
  const wRated = (2 * Math.PI * spec.nRated_rpm) / 60;
  const Trated = (spec.motor_kW * 1000) / wRated;
  // Motor losses split into a fixed part (iron and windage) and a variable part (copper, going
  // with the square of load). At the rated point they sum to the nameplate loss; the split is the
  // usual 40/60 for a totally-enclosed induction motor.
  const lossRated_kW = spec.motor_kW * (1 / spec.etaMotor - 1);
  return Object.freeze({
    tag: spec.tag,
    minSpeed_pct: spec.minSpeed_pct,
    maxSpeed_pct: spec.maxSpeed_pct,
    accelRate_pctps: 100 / spec.accel_s,
    decelRate_pctps: 100 / spec.decel_s,
    startDelay_s: spec.startDelay_s,
    motor_kW: spec.motor_kW,
    nRated_rpm: spec.nRated_rpm,
    wRated_rads: wRated,
    Trated_Nm: Trated,
    motorI_A: spec.motorI_A,
    etaMotor: spec.etaMotor,
    lossFixed_kW: 0.4 * lossRated_kW,
    lossVar_kW: 0.6 * lossRated_kW,
    inertia_kgm2: spec.inertia_kgm2,
    torqueLimit_Nm: Trated * (spec.torqueLimit_pct / 100),
    torqueLimit_pct: spec.torqueLimit_pct,
    tripCurrent_pct: spec.tripCurrent_pct,
    thermalTau_s: spec.thermalTau_s,
    thermalTripPct: spec.thermalTripPct,
  });
}

/**
 * Allocate the mutable per-drive state.
 * @returns {object} drive run state
 */
export function createDriveState() {
  return {
    state: DRIVE.STOPPED,
    /** Speed the controller asked for, in controller percent (0..100). */
    cmd_pct: 0,
    /** The drive's internal speed reference after the ramp, percent of rated shaft speed. */
    ref_pct: 0,
    /** Actual shaft speed, percent of rated. An integrated state — it never jumps. */
    n_pct: 0,
    /** Shaft speed, rad/s. */
    w_rads: 0,
    /** Torque the drive is producing, N m. */
    torque_Nm: 0,
    /** Integral term of the drive's own speed regulator, N m. */
    speedInt_Nm: 0,
    /** True while the drive is holding its torque limit and the ramp is therefore a request. */
    torqueLimited: false,
    /** Motor current, percent of full-load amps. */
    i_pct: 0,
    /** Electrical power drawn at the drive input, kW. */
    pElec_kW: 0,
    /** Motor plus drive losses, kW. */
    pLoss_kW: 0,
    /** Thermal capacity used, percent. The number a modern overload actually displays. */
    thermal_pct: 0,
    /** Seconds remaining on the start permissive. */
    startTimer_s: 0,
    /** Cumulative energised time, hours — the basis for duty rotation. */
    runtime_h: 0,
    /** Cumulative electrical energy, kWh. */
    energy_kWh: 0,
    /** Cumulative start count. Short-cycling shows up here before it shows up in a failure. */
    starts: 0,
    /** How the current stop is being executed. */
    stopMode: STOP_MODE.RAMP,
    /** Why the drive tripped, or null. */
    trip: null,
  };
}

/**
 * True when the drive is turning under power or about to be.
 * @param {object} d drive state
 * @returns {boolean} whether a start has been accepted and not yet withdrawn
 */
export function isCalled(d) {
  return d.state === DRIVE.STARTING || d.state === DRIVE.RUNNING;
}

/**
 * Request a start. Ignored while tripped or already called.
 * @param {object} drive frozen drive spec
 * @param {object} d drive state (mutated)
 * @returns {boolean} whether the request was accepted
 */
export function start(drive, d) {
  if (d.state === DRIVE.TRIPPED || isCalled(d)) return false;
  d.state = DRIVE.STARTING;
  d.startTimer_s = drive.startDelay_s;
  d.starts += 1;
  return true;
}

/**
 * Request a stop.
 * @param {object} d drive state (mutated)
 * @param {string} [mode='RAMP'] one of {@link STOP_MODE}
 * @returns {boolean} whether the request was accepted
 */
export function stop(d, mode) {
  if (d.state === DRIVE.STOPPED || d.state === DRIVE.TRIPPED) return false;
  d.stopMode = mode || STOP_MODE.RAMP;
  d.state = d.stopMode === STOP_MODE.COAST ? DRIVE.COASTING : DRIVE.STOPPING;
  return true;
}

/**
 * Trip the drive: the output is disabled at once and the shaft coasts.
 * @param {object} d drive state (mutated)
 * @param {string} reason what to show the operator
 * @returns {boolean} whether anything changed
 */
export function trip(d, reason) {
  if (d.state === DRIVE.TRIPPED) return false;
  d.state = DRIVE.TRIPPED;
  d.trip = reason;
  d.torque_Nm = 0;
  return true;
}

/**
 * Clear a lockout. The drive returns to STOPPED, never straight to RUNNING: a trip that restarts
 * the machine on acknowledgement is a trip that teaches an operator nothing.
 * @param {object} d drive state (mutated)
 * @returns {boolean} whether anything was reset
 */
export function reset(d) {
  if (d.state !== DRIVE.TRIPPED) return false;
  if (d.thermal_pct > 60) return false;  // an overload relay will not reset while still hot
  d.state = DRIVE.STOPPED;
  d.trip = null;
  return true;
}

/**
 * Map a controller output onto a shaft speed — the VFD's reference scaling.
 *
 * 0..100% of reference spans `minSpeed_pct`..`maxSpeed_pct` of rated shaft speed, exactly as a
 * drive's minimum- and maximum-frequency parameters do. This is not decoration: a pump on a
 * pressure loop cannot make the setpoint head at all below some speed, so an unscaled output
 * would carry a dead band across the bottom of its range.
 *
 * @param {object} drive frozen drive spec
 * @param {number} cmd_pct controller output, percent
 * @returns {number} shaft speed reference, percent of rated
 */
export function referenceToSpeed(drive, cmd_pct) {
  const u = clamp(cmd_pct, 0, 100) / 100;
  return drive.minSpeed_pct + (drive.maxSpeed_pct - drive.minSpeed_pct) * u;
}

/**
 * The inverse: the controller output that would hold a given shaft speed.
 * @param {object} drive frozen drive spec
 * @param {number} n_pct shaft speed, percent of rated
 * @returns {number} controller output, percent
 */
export function speedToReference(drive, n_pct) {
  const span = drive.maxSpeed_pct - drive.minSpeed_pct;
  return span > 0 ? clamp(((n_pct - drive.minSpeed_pct) / span) * 100, 0, 100) : 0;
}

/** Speed-regulator gain: this fraction of rated speed error demands full torque limit. */
const SPEED_REG_BAND = 0.06;
/** Integral time of the drive's speed regulator, s. */
const SPEED_REG_TI = 0.30;

/**
 * Advance one drive by one tick.
 *
 * `cmd_pct` is written by the caller before this runs, in CONTROLLER percent. The shaft speed the
 * pump actually sees is `d.n_pct` afterwards, having been through the reference scaling, the
 * reference ramp, the speed regulator, the torque limit and the inertia.
 *
 * @param {object} drive frozen drive spec
 * @param {object} d drive state (mutated)
 * @param {number} loadTorque_Nm the torque the pump is absorbing right now
 * @param {number} dt_s tick, s
 * @returns {string|null} a trip reason if this tick tripped the drive, else null
 */
export function stepDrive(drive, d, loadTorque_Nm, dt_s) {
  // --- 1. the drive's internal speed reference ------------------------------------------------
  let refTarget = 0;
  switch (d.state) {
    case DRIVE.STARTING:
      d.startTimer_s -= dt_s;
      if (d.startTimer_s <= 0) { d.state = DRIVE.RUNNING; d.startTimer_s = 0; }
      refTarget = 0;
      break;
    case DRIVE.RUNNING:
      refTarget = referenceToSpeed(drive, d.cmd_pct);
      break;
    default:
      refTarget = 0;
  }
  const rampRate = refTarget > d.ref_pct ? drive.accelRate_pctps : drive.decelRate_pctps;
  d.ref_pct = clamp(slew(d.ref_pct, refTarget, rampRate, dt_s), 0, drive.maxSpeed_pct);

  // --- 2 and 3. the speed regulator and the shaft ----------------------------------------------
  // The speed regulator inside the drive is a PI controller, not a droop. A modern vector drive
  // holds the commanded speed regardless of load, and a proportional-only regulator would leave a
  // load-dependent speed error of a percent or two — which is not what a VFD does, and would put
  // a spurious nonlinearity between the controller output and the shaft.
  //
  // SUB-STEPPING. The shaft equation is integrated linearly-implicitly and is unconditionally
  // stable, but the regulator's INTEGRAL term is explicit and its reset time is 0.3 s. Handed a
  // one-second step it winds far past where it should and the speed hunts; handed two seconds it
  // slams into the torque limit and stays there. The plant's own step is 20 ms so this never
  // arises in the application — but "never arises today" is not a property, so the regulator and
  // the shaft are integrated in sub-steps short enough for the loop they represent. At the
  // shipped step size that is exactly one sub-step and costs nothing.
  const powered = d.state === DRIVE.STARTING || d.state === DRIVE.RUNNING || d.state === DRIVE.STOPPING;
  const Tlim = drive.torqueLimit_Nm;
  const J = drive.inertia_kgm2;
  const nSub = Math.max(1, Math.ceil(dt_s / (SPEED_REG_TI * 0.5)));
  const h = dt_s / nSub;

  for (let k = 0; k < nSub; k += 1) {
    let Tdem = 0;
    if (powered) {
      const err = (d.ref_pct - d.n_pct) / 100;
      const prop = (err / SPEED_REG_BAND) * Tlim;
      Tdem = prop + d.speedInt_Nm;
      const Tsat = clamp(Tdem, -Tlim, Tlim);
      // Back-calculation: the regulator's own anti-windup, so a drive that has been sitting on
      // its torque limit does not overshoot the speed when the load finally lets go.
      d.speedInt_Nm = clamp(
        d.speedInt_Nm + ((prop * h) / SPEED_REG_TI) + (Tsat - Tdem) * (h / SPEED_REG_TI),
        -2 * Tlim, 2 * Tlim,
      );
      Tdem = Tsat;
    } else {
      d.speedInt_Nm = 0;
    }
    d.torqueLimited = powered && Math.abs(Tdem) >= Tlim - 1e-9;
    d.torque_Nm = powered ? Tdem : 0;

    // J*dw/dt = T_motor - T_load, implicit in both the load term and the regulator's own
    // proportional gain, so a pump whose torque rises with the square of speed cannot make the
    // step unstable.
    const w = d.w_rads;
    const dTload_dw = w > 1 ? (2 * loadTorque_Nm) / w : 0;   // load torque goes as w^2
    const dTmot_dw = powered && !d.torqueLimited
      ? -(drive.torqueLimit_Nm / (SPEED_REG_BAND * drive.wRated_rads)) : 0;
    const denom = 1 - (h / J) * (dTmot_dw - dTload_dw);
    const wNext = w + ((h / J) * (d.torque_Nm - loadTorque_Nm)) / Math.max(denom, 1e-6);
    d.w_rads = clamp(wNext, 0, drive.wRated_rads * 1.15);
    d.n_pct = (d.w_rads / drive.wRated_rads) * 100;
  }

  // A controlled stop finishes when the shaft is down; a coast finishes when friction stops it.
  if ((d.state === DRIVE.STOPPING || d.state === DRIVE.COASTING) && d.n_pct <= 0.4) {
    d.w_rads = 0;
    d.n_pct = 0;
    d.torque_Nm = 0;
    d.state = DRIVE.STOPPED;
  }
  if (d.state === DRIVE.RUNNING) d.runtime_h += dt_s / 3600;

  // --- 4. current and electrical power ---------------------------------------------------------
  // Torque current and magnetising current are in quadrature, so they add in RMS. Magnetising
  // current is drawn whenever the drive is energised, which is why a deadheaded pump still reads
  // 30% on the ammeter.
  const tPu = drive.Trated_Nm > 0 ? Math.abs(d.torque_Nm) / drive.Trated_Nm : 0;
  const energised = powered || d.state === DRIVE.COASTING;
  d.i_pct = energised ? 100 * Math.sqrt(0.09 + Math.pow(0.954 * tPu, 2)) : 0;

  const shaft_kW = (Math.max(0, d.torque_Nm) * d.w_rads) / 1000;
  if (energised) {
    const load = drive.motor_kW > 0 ? shaft_kW / drive.motor_kW : 0;
    const sSpeed = Math.max(d.n_pct / 100, 0.05);
    // Iron and windage fall away as the machine slows; copper losses go with the square of load.
    const motorLoss = drive.lossFixed_kW * Math.pow(sSpeed, 1.5) + drive.lossVar_kW * load * load;
    // A drive's own losses are mostly switching: a small fixed part plus a share of throughput.
    const driveLoss = 0.005 * drive.motor_kW + 0.02 * (shaft_kW + motorLoss);
    d.pLoss_kW = motorLoss + driveLoss;
    d.pElec_kW = shaft_kW + d.pLoss_kW;
  } else {
    d.pLoss_kW = 0;
    d.pElec_kW = 0;
  }
  d.energy_kWh += (d.pElec_kW * dt_s) / 3600;

  // --- 5. thermal overload ---------------------------------------------------------------------
  // A first-order I^2t model, which is what an electronic overload relay actually implements: the
  // winding heats toward the steady rise that the present current would eventually produce, with
  // the motor's own thermal time constant. It therefore tolerates a large current briefly and a
  // small overcurrent not at all, which is the whole point of a thermal relay and is not
  // reproducible with a timer.
  const iPu = d.i_pct / 100;
  const target = 100 * iPu * iPu;
  const a = Math.exp(-dt_s / drive.thermalTau_s);
  d.thermal_pct = target * (1 - a) + d.thermal_pct * a;

  if (d.state !== DRIVE.TRIPPED) {
    if (d.thermal_pct >= drive.thermalTripPct) {
      trip(d, `thermal overload — ${d.thermal_pct.toFixed(0)}% thermal capacity used`);
      return d.trip;
    }
    if (d.i_pct > drive.tripCurrent_pct) {
      trip(d, `instantaneous overcurrent — ${d.i_pct.toFixed(0)}% FLA`);
      return d.trip;
    }
  }
  return null;
}

/**
 * The pump's load torque at its current duty.
 * @param {number} shaft_kW shaft power the pump is absorbing, kW
 * @param {number} w_rads shaft speed, rad/s
 * @param {number} stalled_Nm breakaway torque to use at rest, N m
 * @returns {number} load torque, N m
 */
export function loadTorque_Nm(shaft_kW, w_rads, stalled_Nm) {
  if (w_rads < 1) return stalled_Nm;
  return (shaft_kW * 1000) / w_rads;
}

/**
 * Wire-to-water efficiency: hydraulic power out over electrical power in.
 *
 * The only efficiency number that means anything to whoever pays the bill, and the one that makes
 * the case for variable speed against throttling. A pump at 78% hydraulic efficiency behind a 93%
 * motor and a 97% drive is a 70% machine at best — and if a control valve downstream is then
 * burning half the head it produced, the real figure is 35%.
 *
 * @param {number} hydraulic_kW useful hydraulic power delivered, kW
 * @param {number} electrical_kW power drawn at the drive input, kW
 * @returns {number} efficiency, 0..1
 */
export function wireToWater(hydraulic_kW, electrical_kW) {
  if (!(electrical_kW > 0.01)) return 0;
  return clamp(hydraulic_kW / electrical_kW, 0, 1);
}
