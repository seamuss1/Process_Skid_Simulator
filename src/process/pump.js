/**
 * src/process/pump.js — one centrifugal pump: its curve, its efficiency, its power and its
 * suction margin. No state of its own; every function is pure and takes the pump's frozen
 * geometry plus the operating point.
 *
 * Layer L1: imports `core/util.js` and nothing else. No DOM.
 *
 * THE CURVE. A centrifugal pump's head-capacity characteristic is taken as the quadratic
 *
 *     H(Q) = H0 - a1*Q - a2*Q^2                                        (at rated speed)
 *
 * and referred to part speed by the affinity laws, which say that a geometrically identical
 * machine running at speed ratio s = N/Nrated passes s times the flow at s^2 times the head:
 *
 *     H(Q, s) = s^2 * H(Q/s) = s^2*H0 - s*a1*Q - a2*Q^2                (homologous form)
 *
 * That substitution is the whole reason the model is worth having. It is why a VFD pump is a
 * genuinely nonlinear final element: halving the speed does not halve the flow into a system
 * with static head, it stops the pump delivering altogether once s^2*H0 falls below the head the
 * discharge already sits at. A loop tuned at 90% speed and retuned at 40% is a different loop,
 * and this is the term that makes it one.
 *
 * `a1` is required to be non-negative so dH/dQ <= 0 everywhere: a curve that rises toward shutoff
 * is real (and unstable, which is why it is avoided in specification) but it would make the
 * flow-for-head solve below multivalued, and a simulator that silently picks a root is worse than
 * one that declines to model the case.
 */

import { clamp, hydraulicPower_kW, ATM_BAR, G } from '../core/util.js';

/**
 * Build a frozen pump characteristic from nameplate points.
 *
 * The three head coefficients are derived, not asked for: an engineer knows shutoff head, and
 * the duty point, and the best-efficiency flow. Nobody knows `a2`.
 *
 * @param {object} spec pump nameplate
 * @param {string} spec.tag equipment tag, e.g. 'P-101'
 * @param {number} spec.H0_m shutoff (zero-flow) head at rated speed, m
 * @param {number} spec.Qbep_m3h best-efficiency-point flow at rated speed, m3/h
 * @param {number} spec.Hbep_m head at the BEP at rated speed, m
 * @param {number} spec.etaBep best-efficiency hydraulic efficiency, 0..1
 * @param {number} spec.a1 linear head coefficient, m per (m3/h); must be >= 0
 * @param {number} spec.nRated_rpm rated shaft speed, rpm
 * @param {number} spec.motor_kW motor nameplate rating, kW
 * @param {number} spec.motorI_A motor full-load current, A
 * @param {number} spec.npshr0_m NPSH required at zero flow, m
 * @param {number} spec.npshrBep_m NPSH required at the BEP, m
 * @param {number} spec.minFlowFrac minimum continuous stable flow, as a fraction of Qbep
 * @returns {object} the frozen pump model
 */
export function createPump(spec) {
  const H0 = spec.H0_m;
  const Qb = spec.Qbep_m3h;
  const Hb = spec.Hbep_m;
  const a1 = Math.max(0, spec.a1);
  // H0 - a1*Qb - a2*Qb^2 = Hb  =>  a2 = (H0 - a1*Qb - Hb) / Qb^2
  const a2 = (H0 - a1 * Qb - Hb) / (Qb * Qb);
  if (!(a2 > 0)) {
    throw new Error(`${spec.tag}: head curve is not drooping — check H0_m, Hbep_m, Qbep_m3h, a1`);
  }
  // NPSHr(q) = npshr0 + cn*q^2, fitted through the BEP point.
  const cn = (spec.npshrBep_m - spec.npshr0_m) / (Qb * Qb);
  return Object.freeze({
    tag: spec.tag,
    H0_m: H0,
    a1,
    a2,
    Qbep_m3h: Qb,
    Hbep_m: Hb,
    etaBep: spec.etaBep,
    nRated_rpm: spec.nRated_rpm,
    motor_kW: spec.motor_kW,
    motorI_A: spec.motorI_A,
    npshr0_m: spec.npshr0_m,
    npshrCoef: cn,
    minFlow_m3h: spec.minFlowFrac * Qb,
    /** Runout: where the rated-speed curve reaches zero head. The far edge of the envelope. */
    Qmax_m3h: (-a1 + Math.sqrt(a1 * a1 + 4 * a2 * H0)) / (2 * a2),
  });
}

/**
 * Developed head at a flow and speed ratio, by the homologous form.
 * @param {object} pump from {@link createPump}
 * @param {number} Q_m3h flow through the pump, m3/h
 * @param {number} s speed ratio N/Nrated, 0..~1.05
 * @returns {number} head, m (may go negative past runout, which is physical)
 */
export function headAt(pump, Q_m3h, s) {
  return s * s * pump.H0_m - s * pump.a1 * Q_m3h - pump.a2 * Q_m3h * Q_m3h;
}

/**
 * Shutoff head at a speed ratio — the most head this pump can produce, and therefore the head
 * above which its check valve stays shut and it delivers nothing.
 * @param {object} pump the pump
 * @param {number} s speed ratio
 * @returns {number} head, m
 */
export function shutoffHead(pump, s) {
  return s * s * pump.H0_m;
}

/**
 * Hydraulic efficiency at an operating point.
 *
 * A parabola through zero at no flow and at twice the BEP flow, peaking at the BEP. Efficiency is
 * a function of the flow REFERRED TO RATED SPEED (`Q/s`), which is the affinity-law statement
 * that a pump run slower stays on the same efficiency island — the reason VFD throttling beats
 * valve throttling, and worth having correct because the power trend is one of the things an
 * operator watches while staging.
 *
 * @param {object} pump the pump
 * @param {number} Q_m3h flow, m3/h
 * @param {number} s speed ratio
 * @returns {number} efficiency, 0.05..etaBep
 */
export function efficiencyAt(pump, Q_m3h, s) {
  if (!(s > 0.02) || !(Q_m3h > 0)) return 0.05;
  const x = (Q_m3h / s) / pump.Qbep_m3h;
  return clamp(pump.etaBep * (2 * x - x * x), 0.05, pump.etaBep);
}

/**
 * Shaft power absorbed at an operating point.
 *
 * Hydraulic power over efficiency, plus a windage/friction floor proportional to s^3 so a pump
 * spinning against a shut check valve still draws something — a deadheaded pump is not a free
 * pump, and its power is the only clue on the panel that it is running blind.
 *
 * @param {object} pump the pump
 * @param {number} Q_m3h flow, m3/h
 * @param {number} H_m head developed, m
 * @param {number} s speed ratio
 * @param {number} rho_kgm3 liquid density, kg/m3
 * @returns {number} shaft power, kW
 */
export function shaftPower_kW(pump, Q_m3h, H_m, s, rho_kgm3) {
  const idle = 0.06 * pump.motor_kW * s * s * s;
  if (!(Q_m3h > 0) || !(H_m > 0)) return idle;
  return idle + hydraulicPower_kW(Q_m3h, H_m, rho_kgm3) / efficiencyAt(pump, Q_m3h, s);
}

/**
 * NPSH required at an operating point, m. Rises with the square of flow and scales with s^2.
 * @param {object} pump the pump
 * @param {number} Q_m3h flow, m3/h
 * @param {number} s speed ratio
 * @returns {number} NPSH required, m
 */
export function npshRequired_m(pump, Q_m3h, s) {
  if (!(s > 0.02)) return 0;
  const q = Q_m3h / s;
  return s * s * (pump.npshr0_m + pump.npshrCoef * q * q);
}

/**
 * NPSH available at the pump suction, m of liquid.
 *
 *     NPSHa = (p_atm + p_tank - p_vapour)/(rho*g) + z_static - h_friction
 *
 * The vapour-pressure term is why hot liquid cavitates a pump that handles the same duty cold,
 * and the friction term is why a blinding suction strainer does the same thing to a cold one.
 *
 * @param {object} args suction conditions
 * @param {number} args.pTank_bar tank surface pressure, bar gauge (0 for a vented tank)
 * @param {number} args.pVap_bar liquid vapour pressure at temperature, bar absolute
 * @param {number} args.zStatic_m liquid surface height above the pump centreline, m (negative is a lift)
 * @param {number} args.hFriction_m suction-side friction loss at the current flow, m
 * @param {number} args.rho_kgm3 liquid density, kg/m3
 * @returns {number} NPSH available, m
 */
export function npshAvailable_m({ pTank_bar, pVap_bar, zStatic_m, hFriction_m, rho_kgm3 }) {
  const absHead = ((ATM_BAR + pTank_bar - pVap_bar) * 1e5) / (rho_kgm3 * G);
  return absHead + zStatic_m - hFriction_m;
}

/**
 * Head multiplier from cavitation.
 *
 * NPSHr is by convention the suction margin at which developed head has already fallen 3%, so
 * the pump is not healthy at zero margin — it is at the edge. Below it, head collapses over a
 * further band; this model takes full breakdown at half the NPSHr below the curve, which is the
 * shape of a published suction-performance test. Above the curve the multiplier is exactly 1, so
 * a well-supplied pump carries no cavitation arithmetic at all.
 *
 * @param {number} npsha_m NPSH available, m
 * @param {number} npshr_m NPSH required, m
 * @returns {number} multiplier on developed head, 0.1..1
 */
export function cavitationFactor(npsha_m, npshr_m) {
  if (!(npshr_m > 0)) return 1;
  const margin = npsha_m - npshr_m;
  if (margin >= 0) return 1;
  return clamp(1 + margin / (0.5 * npshr_m), 0.1, 1);
}

/**
 * Solve, in closed form, the flow a pump passes into a header at a known head.
 *
 * The branch balance from the tank surface to the header is
 *
 *     zStatic + fc*H(Q, s) - K*Q^2 = Hheader
 *
 * with `K` the total branch resistance (suction line, strainer, discharge spool, check valve) and
 * `fc` the cavitation multiplier. Substituting the homologous curve makes it a quadratic in Q:
 *
 *     (fc*a2 + K)*Q^2 + (fc*s*a1)*Q - (zStatic + fc*s^2*H0 - Hheader) = 0
 *
 * whose positive root is taken directly — no iteration, no convergence test, no chance of a
 * solver failing mid-transient. When the constant term is negative the header already stands
 * above anything this pump can produce, the check valve is shut, and the answer is exactly zero.
 * That discontinuity in the DERIVATIVE (not the value) is the single most important nonlinearity
 * in a parallel-pump system, and it is reproduced here exactly rather than smoothed away.
 *
 * @param {object} pump the pump
 * @param {number} s speed ratio
 * @param {number} Hheader_m header head, m
 * @param {number} zStatic_m suction static head available at the pump, m
 * @param {number} K branch resistance coefficient, m per (m3/h)^2
 * @param {number} fc cavitation head multiplier from {@link cavitationFactor}
 * @returns {{Q_m3h:number, dQdH:number, checkShut:boolean}} the flow, its sensitivity to header
 *   head (negative), and whether the check valve is holding shut. The returned object is fresh;
 *   this is called at most twice per tick so the allocation is not worth avoiding.
 */
export function solveBranchFlow(pump, s, Hheader_m, zStatic_m, K, fc) {
  const alpha = fc * pump.a2 + K;
  const beta = fc * s * pump.a1;
  const gamma = zStatic_m + fc * s * s * pump.H0_m - Hheader_m;
  if (!(gamma > 0) || !(alpha > 0)) return { Q_m3h: 0, dQdH: 0, checkShut: true };
  const disc = beta * beta + 4 * alpha * gamma;
  const Q = (-beta + Math.sqrt(disc)) / (2 * alpha);
  // dQ/dHheader = -1 / (2*alpha*Q + beta), floored so a vanishing root cannot return -Infinity.
  const denom = Math.max(2 * alpha * Q + beta, 1e-9);
  return { Q_m3h: Q, dQdH: -1 / denom, checkShut: false };
}
