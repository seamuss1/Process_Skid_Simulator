/**
 * src/process/pipe.js — pipe friction the way it is actually calculated: Darcy-Weisbach, with a
 * Reynolds-dependent friction factor and explicit fitting losses.
 *
 * Layer L1: imports `core/util.js` only. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY NOT JUST A Kv
 *
 * A single quadratic resistance — `dH = K*Q^2` — is exactly right for a valve and only
 * approximately right for a pipe, because it assumes the friction factor is constant. It is not.
 *
 *     h_f = f * (L/D) * v^2 / (2g)          with f = f(Re, roughness)
 *
 * In fully rough turbulent flow `f` really is nearly constant and the square law holds. In laminar
 * flow it is not: `f = 64/Re`, so `h_f` becomes proportional to flow rather than flow squared, and
 * proportional to viscosity. That is the difference between a system curve that is a parabola and
 * one that is nearly a straight line, and it is why a system designed on water behaves completely
 * differently on a cold oil — the pump is derated by the Hydraulic Institute correction AND the
 * system it is pumping into has gone stiff at the same time.
 *
 * Reynolds number for a 150 mm line at 45 m3/h:
 *   water at 20 C  (1.0 cSt)  ->  Re = 106 000, fully turbulent, square law
 *   VG 150 at 40 C (150 cSt)  ->  Re = 700, laminar, linear law
 *
 * Both of those are ordinary duties. A model that cannot tell them apart cannot be used to think
 * about either.
 *
 * NUMERICAL NOTE. The friction factor is evaluated at the PREVIOUS tick's flow, which turns the
 * pipe back into a constant `K` for the current tick and keeps the branch solve a closed-form
 * quadratic. `f` varies slowly with flow, so the lag is immaterial; the alternative is a nested
 * iteration inside every branch of every tick, which is a great deal of machinery to buy an
 * accuracy nobody can measure.
 * ------------------------------------------------------------------------------------------
 */

import { G, S_PER_H, clamp } from '../core/util.js';

/** Absolute roughness of common pipe materials, mm. */
export const ROUGHNESS_MM = Object.freeze({
  /** Drawn tubing, plastic. */
  SMOOTH: 0.0015,
  /** New commercial steel — the default for a process line. */
  STEEL: 0.045,
  /** Stainless, as-welded. */
  STAINLESS: 0.015,
  /** Galvanised steel. */
  GALVANISED: 0.15,
  /** Old steel with light scaling. */
  SCALED: 0.5,
});

/**
 * Build a frozen pipe run.
 * @param {object} spec pipe data
 * @param {string} spec.tag line number
 * @param {number} spec.id_mm internal diameter, mm
 * @param {number} spec.length_m developed length, m
 * @param {number} [spec.roughness_mm=0.045] absolute roughness, mm
 * @param {number} [spec.sumK=0] the sum of the velocity-head K factors of the fittings on the run
 * @returns {object} the frozen pipe
 */
export function createPipe(spec) {
  const d = spec.id_mm / 1000;
  const A = (Math.PI * d * d) / 4;
  return Object.freeze({
    tag: spec.tag,
    id_m: d,
    area_m2: A,
    length_m: spec.length_m,
    roughness_m: (spec.roughness_mm === undefined ? ROUGHNESS_MM.STEEL : spec.roughness_mm) / 1000,
    sumK: spec.sumK || 0,
    /** Fluid inertia coefficient, L/(g*A) in s^2/m^2 — how hard this column is to accelerate. */
    inertia: spec.length_m / (G * A),
  });
}

/**
 * Mean velocity in a pipe.
 * @param {object} pipe the pipe
 * @param {number} Q_m3h flow, m3/h
 * @returns {number} velocity, m/s
 */
export function velocity_ms(pipe, Q_m3h) {
  return (Q_m3h / S_PER_H) / pipe.area_m2;
}

/**
 * Reynolds number.
 * @param {object} pipe the pipe
 * @param {number} Q_m3h flow, m3/h
 * @param {number} nu_cSt kinematic viscosity, mm2/s
 * @returns {number} Reynolds number
 */
export function reynolds(pipe, Q_m3h, nu_cSt) {
  const nu = Math.max(nu_cSt, 0.05) * 1e-6;
  return (Math.abs(velocity_ms(pipe, Q_m3h)) * pipe.id_m) / nu;
}

/**
 * Darcy friction factor.
 *
 * Laminar below Re = 2300 from the exact `64/Re`; turbulent above Re = 4000 from the Swamee-Jain
 * explicit approximation to Colebrook-White, which is within about 1% of it over the whole range
 * of engineering interest and needs no iteration:
 *
 *     f = 0.25 / [ log10( eps/(3.7*D) + 5.74/Re^0.9 ) ]^2
 *
 * The critical zone between them has no reliable correlation because the flow itself is not
 * reliable there; a smooth blend is used, and it is flagged rather than dressed up as physics.
 *
 * @param {object} pipe the pipe
 * @param {number} Re Reynolds number
 * @returns {number} the Darcy friction factor
 */
export function frictionFactor(pipe, Re) {
  if (!(Re > 1e-6)) return 0;
  const laminar = 64 / Math.max(Re, 1e-3);
  if (Re < 2300) return laminar;
  const turb = (r) => {
    const t = Math.log10(pipe.roughness_m / (3.7 * pipe.id_m) + 5.74 / Math.pow(r, 0.9));
    return 0.25 / (t * t);
  };
  if (Re > 4000) return turb(Re);
  // Critical zone: blend the two, because neither is valid and the truth is unrepeatable anyway.
  const t = (Re - 2300) / 1700;
  return laminar * (1 - t) + turb(4000) * t;
}

/**
 * Head loss along a run at a given flow, m.
 * @param {object} pipe the pipe
 * @param {number} Q_m3h flow, m3/h
 * @param {number} nu_cSt kinematic viscosity, mm2/s
 * @returns {number} head loss, m (always positive)
 */
export function headLoss_m(pipe, Q_m3h, nu_cSt) {
  const v = velocity_ms(pipe, Q_m3h);
  const f = frictionFactor(pipe, reynolds(pipe, Q_m3h, nu_cSt));
  return ((f * pipe.length_m) / pipe.id_m + pipe.sumK) * ((v * v) / (2 * G));
}

/**
 * The equivalent quadratic resistance coefficient at a working point: the `K` in `dH = K*Q^2`
 * that reproduces this run's loss at this flow and viscosity.
 *
 * Evaluated once per tick from the previous tick's flow, which is what lets the branch solve stay
 * a closed-form quadratic while still carrying a Reynolds-dependent friction factor.
 *
 * @param {object} pipe the pipe
 * @param {number} Q_m3h the flow to linearise about, m3/h
 * @param {number} nu_cSt kinematic viscosity, mm2/s
 * @returns {number} K, m per (m3/h)^2
 */
export function resistanceK(pipe, Q_m3h, nu_cSt) {
  // Below a threshold flow the square law's coefficient is unbounded (laminar loss is linear in
  // Q, so K = h/Q^2 goes as 1/Q). Evaluate at a small floor flow instead, which is the right
  // answer everywhere the pump is actually running and a finite one everywhere else.
  const Q = Math.max(Math.abs(Q_m3h), 0.5);
  return headLoss_m(pipe, Q, nu_cSt) / (Q * Q);
}

/**
 * The flow regime, for display.
 * @param {number} Re Reynolds number
 * @returns {string} 'laminar', 'critical' or 'turbulent'
 */
export function regime(Re) {
  if (Re < 2300) return 'laminar';
  if (Re < 4000) return 'critical';
  return 'turbulent';
}

/**
 * Velocity-head K factors for the fittings on a run, so `sumK` can be assembled from a takeoff
 * rather than guessed. Values are the usual Crane TP-410 figures for fully turbulent flow.
 */
export const FITTING_K = Object.freeze({
  ENTRY_SHARP: 0.5,
  ENTRY_BELLMOUTH: 0.05,
  EXIT: 1.0,
  ELBOW_90_LR: 0.3,
  ELBOW_90_SR: 0.9,
  ELBOW_45: 0.2,
  TEE_THROUGH: 0.2,
  TEE_BRANCH: 1.0,
  GATE_OPEN: 0.15,
  CHECK_SWING: 2.0,
  STRAINER_CLEAN: 1.5,
  REDUCER: 0.15,
});

/**
 * Sum a list of fitting K factors.
 * @param {Array<[string, number]>} items pairs of fitting name and count
 * @returns {number} the total K
 */
export function sumFittings(items) {
  let k = 0;
  for (const [name, n] of items) k += (FITTING_K[name] || 0) * n;
  return k;
}

/**
 * Fluid inertia of a run, expressed for the head-and-m3/h basis the plant integrates in.
 *
 * The momentum equation for a rigid liquid column is `rho*(L/A)*dQ/dt = rho*g*dH`, so
 * `(L/(g*A))*dQ/dt = dH` with Q in m3/s. Dividing by 3600 puts it on the m3/h basis:
 *
 *     inertia_h * dQ[m3/h]/dt = dH[m]
 *
 * This is what turns a valve slam into a pressure surge instead of an instant new steady state.
 * The column has to be decelerated, and the only thing available to do it with is pressure.
 *
 * @param {object} pipe the pipe
 * @returns {number} the coefficient, m per (m3/h per s)
 */
export function inertiaCoefficient(pipe) {
  return pipe.inertia / S_PER_H;
}

/**
 * Joukowsky pressure rise for an instantaneous full stop, m of head.
 *
 * The textbook upper bound on water hammer: `dH = a*v/g` with `a` the pressure wave speed. This
 * rig integrates a rigid-column model rather than the method of characteristics, so it does not
 * reproduce the wave reflections — but the Joukowsky value is worth reporting alongside, because
 * it is the number that says whether a fast closure is a nuisance or a burst pipe.
 *
 * @param {number} v_ms velocity being stopped, m/s
 * @param {number} [waveSpeed_ms=1200] pressure wave speed in the line
 * @returns {number} the head rise, m
 */
export function joukowsky_m(v_ms, waveSpeed_ms = 1200) {
  return (waveSpeed_ms * Math.abs(v_ms)) / G;
}

/**
 * The critical closure time below which a valve closure is "rapid" and the full Joukowsky rise
 * applies, s. Above it the reflected wave arrives in time to relieve the surge.
 * @param {object} pipe the pipe
 * @param {number} [waveSpeed_ms=1200] pressure wave speed
 * @returns {number} 2L/a, s
 */
export function criticalClosureTime_s(pipe, waveSpeed_ms = 1200) {
  return (2 * pipe.length_m) / waveSpeed_ms;
}

/**
 * Clamp a velocity into the range this model is honest about, for display purposes.
 * @param {number} v_ms velocity, m/s
 * @returns {number} the clamped velocity
 */
export function displayVelocity(v_ms) {
  return clamp(v_ms, -20, 20);
}
