/**
 * src/process/motor.js — the VFD and motor in front of each pump: the drive state machine, the
 * speed ramp, motor current and the overload.
 *
 * Layer L1: imports `core/util.js` only. No DOM.
 *
 * WHY THIS IS A SEPARATE MODULE. The controller's output is not the pump's speed. Between them
 * sit a permissive delay, an acceleration ramp, a minimum drive speed and a trip — four places
 * where the loop's final element refuses to do what it was told. Every one of them shows up in a
 * trend as something a tuner will misread as process behaviour if the model does not have it:
 *
 *   - the ramp is a rate limit, so a large controller step arrives as a slope, and integral
 *     action that does not know about it winds up while the drive is still on its way;
 *   - the minimum speed is a dead zone at the bottom of the output range, so a loop asked to sit
 *     below it cycles rather than settling;
 *   - the start delay is pure dead time, and dead time is the one thing no amount of gain fixes.
 */

import { clamp, slew } from '../core/util.js';

/** Drive states, in the order a healthy start passes through them. */
export const DRIVE = Object.freeze({
  /** At rest, ready to accept a start. */
  STOPPED: 'STOPPED',
  /** Start accepted; running out the permissive delay before the ramp begins. */
  STARTING: 'STARTING',
  /** Energised and following the speed command through the ramp. */
  RUNNING: 'RUNNING',
  /** Stop accepted; ramping down to rest. */
  STOPPING: 'STOPPING',
  /** Locked out by the overload. Requires an explicit reset. */
  TRIPPED: 'TRIPPED',
});

/**
 * Build a frozen drive specification.
 * @param {object} spec drive data
 * @param {string} spec.tag drive tag, e.g. 'VFD-101'
 * @param {number} spec.minSpeed_pct shaft speed at 0% reference, percent of rated
 * @param {number} spec.maxSpeed_pct shaft speed at 100% reference, percent of rated
 * @param {number} spec.accel_s time to ramp 0 to 100 percent, s
 * @param {number} spec.decel_s time to ramp 100 to 0 percent, s
 * @param {number} spec.startDelay_s permissive/contactor delay before the ramp begins, s
 * @param {number} spec.tripCurrent_pct current at which the overload starts timing, percent of FLA
 * @param {number} spec.tripDelay_s time above the trip current before lockout, s
 * @returns {object} the frozen drive model
 */
export function createDrive(spec) {
  return Object.freeze({
    tag: spec.tag,
    minSpeed_pct: spec.minSpeed_pct,
    maxSpeed_pct: spec.maxSpeed_pct,
    accelRate_pctps: 100 / spec.accel_s,
    decelRate_pctps: 100 / spec.decel_s,
    startDelay_s: spec.startDelay_s,
    tripCurrent_pct: spec.tripCurrent_pct,
    tripDelay_s: spec.tripDelay_s,
  });
}

/**
 * Allocate the mutable per-drive state.
 * @returns {object} drive run state
 */
export function createDriveState() {
  return {
    state: DRIVE.STOPPED,
    /** Speed the controller asked for, percent. */
    cmd_pct: 0,
    /** Speed the shaft is actually at, percent. Never jumps. */
    n_pct: 0,
    /** Seconds remaining on the start permissive. */
    startTimer_s: 0,
    /** Seconds accumulated above the trip current. */
    overloadTimer_s: 0,
    /** Motor current, percent of full-load amps. */
    i_pct: 0,
    /** Cumulative energised time, hours — the basis for duty rotation. */
    runtime_h: 0,
    /** Cumulative start count. Short-cycling shows up here before it shows up in a failure. */
    starts: 0,
    /** Why the drive tripped, or null. */
    trip: null,
  };
}

/**
 * True when the drive is turning or about to be.
 * @param {object} d drive state
 * @returns {boolean} whether a start has been accepted and not yet completed
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
 * Request a stop. Ignored when already stopped or tripped.
 * @param {object} d drive state (mutated)
 * @returns {boolean} whether the request was accepted
 */
export function stop(d) {
  if (d.state === DRIVE.STOPPED || d.state === DRIVE.TRIPPED) return false;
  d.state = DRIVE.STOPPING;
  return true;
}

/**
 * Clear an overload lockout. The drive returns to STOPPED, never straight to RUNNING: a trip
 * that restarts the machine on acknowledgement is a trip that teaches an operator nothing.
 * @param {object} d drive state (mutated)
 * @returns {boolean} whether anything was reset
 */
export function reset(d) {
  if (d.state !== DRIVE.TRIPPED) return false;
  d.state = DRIVE.STOPPED;
  d.overloadTimer_s = 0;
  d.trip = null;
  return true;
}

/**
 * Map a controller output onto a shaft speed — the VFD's reference scaling.
 *
 * 0..100% of reference spans `minSpeed_pct`..`maxSpeed_pct` of rated shaft speed, exactly as a
 * drive's minimum- and maximum-frequency parameters do. This is not decoration: a pump on a
 * pressure loop cannot make the setpoint head at all below some speed, so an unscaled output
 * would carry a dead band across the bottom of its range. Scaling the reference puts the
 * controller's 0..100% where the process actually responds.
 *
 * @param {object} drive frozen drive spec
 * @param {number} cmd_pct controller output, percent
 * @returns {number} shaft speed, percent of rated
 */
export function referenceToSpeed(drive, cmd_pct) {
  const u = clamp(cmd_pct, 0, 100) / 100;
  return drive.minSpeed_pct + (drive.maxSpeed_pct - drive.minSpeed_pct) * u;
}

/**
 * Advance one drive by one tick.
 *
 * `cmd_pct` is written by the caller before this runs, in CONTROLLER PERCENT; the shaft speed the
 * pump actually sees is `d.n_pct` afterwards, through {@link referenceToSpeed} and the ramp. The
 * difference between the two over a transient is the rate limit doing its job.
 *
 * @param {object} drive frozen drive spec
 * @param {object} d drive state (mutated)
 * @param {number} shaft_kW shaft power the pump is absorbing right now, kW
 * @param {number} motor_kW motor nameplate rating, kW
 * @param {number} dt_s tick, s
 * @returns {string|null} a trip reason if this tick tripped the drive, else null
 */
export function stepDrive(drive, d, shaft_kW, motor_kW, dt_s) {
  // --- speed ------------------------------------------------------------------------------
  let target = 0;
  switch (d.state) {
    case DRIVE.STARTING:
      d.startTimer_s -= dt_s;
      if (d.startTimer_s <= 0) { d.state = DRIVE.RUNNING; d.startTimer_s = 0; }
      target = 0;
      break;
    case DRIVE.RUNNING:
      target = referenceToSpeed(drive, d.cmd_pct);
      break;
    case DRIVE.STOPPING:
    case DRIVE.TRIPPED:
    case DRIVE.STOPPED:
    default:
      target = 0;
  }
  const rate = target > d.n_pct ? drive.accelRate_pctps : drive.decelRate_pctps;
  d.n_pct = clamp(slew(d.n_pct, target, rate, dt_s), 0, drive.maxSpeed_pct);
  if (d.state === DRIVE.STOPPING && d.n_pct <= 0.01) { d.n_pct = 0; d.state = DRIVE.STOPPED; }

  if (d.state === DRIVE.RUNNING) d.runtime_h += dt_s / 3600;

  // --- current ----------------------------------------------------------------------------
  // A magnetising component that is there whenever the drive is energised, plus a load component
  // proportional to shaft power. Not a phasor model: it exists so the overload has something
  // physical to time out on, and so a deadheaded or a runout pump reads differently on the panel.
  const load = motor_kW > 0 ? shaft_kW / motor_kW : 0;
  const energised = d.state === DRIVE.RUNNING || d.state === DRIVE.STOPPING;
  d.i_pct = energised ? clamp(22 * (d.n_pct / 100) + 78 * load, 0, 400) : 0;

  // --- overload ---------------------------------------------------------------------------
  if (d.i_pct > drive.tripCurrent_pct) {
    d.overloadTimer_s += dt_s;
    if (d.overloadTimer_s >= drive.tripDelay_s && d.state !== DRIVE.TRIPPED) {
      d.state = DRIVE.TRIPPED;
      d.trip = `motor overload — ${d.i_pct.toFixed(0)}% FLA for ${drive.tripDelay_s} s`;
      d.overloadTimer_s = 0;
      return d.trip;
    }
  } else {
    // Thermal memory decays rather than resetting: a load that cycles either side of the trip
    // point still accumulates, which is exactly how a real overload relay behaves.
    d.overloadTimer_s = Math.max(0, d.overloadTimer_s - dt_s * 0.5);
  }
  return null;
}
