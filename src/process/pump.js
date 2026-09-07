/**
 * src/process/pump.js — one centrifugal pump: its curve, its power, its efficiency, its suction
 * margin, its vibration and the heat it puts into the liquid.
 *
 * Layer L1: imports `core/util.js` and `process/fluid.js`. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * THE CURVE
 *
 * The head-capacity characteristic is a quadratic referred to part speed by the affinity laws,
 * which say a geometrically identical machine at speed ratio s = N/Nrated passes s times the flow
 * at s^2 times the head:
 *
 *     H(Q, s) = s^2 * H(Q/s) = s^2*H0 - s*a1*Q - a2*Q^2                (homologous form)
 *
 * That substitution is the whole reason the model is worth having. It is why a VFD pump is a
 * genuinely nonlinear final element: halving the speed does not halve the flow into a system with
 * static head, it stops the pump delivering altogether once s^2*H0 falls below the head the
 * discharge already sits at.
 *
 * `a1` is required to be non-negative so dH/dQ <= 0 everywhere. A curve that rises toward shutoff
 * is real, and unstable, and is avoided in specification for exactly that reason — but it would
 * make the flow-for-head solve multivalued, and a simulator that silently picks a root is worse
 * than one that declines to model the case.
 *
 * ------------------------------------------------------------------------------------------
 * POWER, AND WHY EFFICIENCY IS DERIVED RATHER THAN ASSUMED
 *
 * The shaft power curve is stated directly, as a radial pump's is: roughly linear in flow from a
 * shutoff value of about 45% of the best-efficiency power, rising past the BEP so the machine is
 * not non-overloading. Efficiency then FALLS OUT of it:
 *
 *     eta(Q) = rho*g*Q*H(Q) / P_shaft(Q)
 *
 * rather than being a parabola asserted alongside. The two are then automatically consistent:
 * efficiency is exactly zero at shutoff (all the power is going into churning) and exactly zero at
 * runout (no head), and it peaks where the datasheet says it does without anybody arranging for
 * it. Asserting a separate efficiency curve lets the two drift apart, and the first place that
 * shows up is a power reading that is wrong at the two operating points people most want to
 * understand.
 *
 * ------------------------------------------------------------------------------------------
 * EVERYTHING THAT DERATES THE MACHINE FOLDS INTO THE SAME THREE COEFFICIENTS
 *
 * Viscosity, impeller trim, wear-ring wear and cavitation all change what the pump can do, and
 * all four can be folded into H0, a1 and a2 without leaving the quadratic:
 *
 *   IMPELLER TRIM     H scales with d^2 and Q with d, which is the SAME homologous form as
 *                     speed. So a trim ratio d gives H0' = d^2*H0, a1' = d*a1, a2' = a2.
 *   VISCOSITY         the Hydraulic Institute correction scales head by CH and flow by CQ, so
 *                     H_visc(Q) = CH * H_water(Q/CQ), which is again a quadratic.
 *   WEAR AND CAVITATION  both multiply the developed head.
 *
 * `deratedPump()` performs all of that once per machine per tick and hands back something with
 * the same shape as a pump. Everything downstream — the branch solve, the curve chart, the
 * efficiency — then works on the derated machine without knowing that it is one.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, hydraulicPower_kW, ATM_BAR, G, S_PER_H } from '../core/util.js';

/** Density the pump's nameplate power was rated at, kg/m3. Cold water. */
const RATED_RHO = 998.2;

/** Shutoff power as a fraction of best-efficiency power. Typical for a radial impeller. */
const SHUTOFF_POWER_FRAC = 0.45;

/**
 * Build a frozen pump characteristic from nameplate points.
 *
 * The head coefficients and the best-efficiency power are derived, not asked for: an engineer
 * knows the shutoff head, the duty point and the efficiency there. Nobody knows `a2`.
 *
 * @param {object} spec pump nameplate
 * @param {string} spec.tag equipment tag, e.g. 'P-101'
 * @param {number} spec.H0_m shutoff (zero-flow) head at rated speed, m
 * @param {number} spec.Qbep_m3h best-efficiency-point flow at rated speed, m3/h
 * @param {number} spec.Hbep_m head at the BEP at rated speed, m
 * @param {number} spec.etaBep best-efficiency total efficiency, 0..1
 * @param {number} spec.a1 linear head coefficient, m per (m3/h); must be >= 0
 * @param {number} spec.nRated_rpm rated shaft speed, rpm
 * @param {number} spec.motor_kW motor nameplate rating, kW
 * @param {number} spec.motorI_A motor full-load current, A
 * @param {number} spec.npshr0_m NPSH required at zero flow, m
 * @param {number} spec.npshrBep_m NPSH required at the BEP, m
 * @param {number} spec.minFlowFrac minimum continuous STABLE flow, as a fraction of Qbep
 * @param {number} [spec.casingVolume_L] liquid held in the casing, litres, for the thermal model
 * @param {number} [spec.casingMass_kg] metal mass heated with it, kg
 * @returns {object} the frozen pump model
 */
export function createPump(spec) {
  const H0 = spec.H0_m;
  const Qb = spec.Qbep_m3h;
  const Hb = spec.Hbep_m;
  const a1 = Math.max(0, spec.a1);
  const a2 = (H0 - a1 * Qb - Hb) / (Qb * Qb);
  if (!(a2 > 0)) {
    throw new Error(`${spec.tag}: head curve is not drooping — check H0_m, Hbep_m, Qbep_m3h, a1`);
  }
  const cn = (spec.npshrBep_m - spec.npshr0_m) / (Qb * Qb);
  const Pbep = hydraulicPower_kW(Qb, Hb, RATED_RHO) / spec.etaBep;

  // Specific speed and suction specific speed, in the metric (rpm, m3/s, m) convention. Both are
  // design fingerprints rather than model inputs: Ns says what shape of impeller this is, and Nss
  // says how hard its inlet has been pushed, which is what decides how wide its stable operating
  // window is. A machine above about 11 000 (metric) is known to have a narrow one.
  const Qb_m3s = Qb / S_PER_H;
  const Ns = (spec.nRated_rpm * Math.sqrt(Qb_m3s)) / Math.pow(Hb, 0.75);
  const Nss = (spec.nRated_rpm * Math.sqrt(Qb_m3s)) / Math.pow(spec.npshrBep_m, 0.75);

  return Object.freeze({
    tag: spec.tag,
    H0_m: H0,
    a1,
    a2,
    Qbep_m3h: Qb,
    Hbep_m: Hb,
    etaBep: spec.etaBep,
    Pbep_kW: Pbep,
    nRated_rpm: spec.nRated_rpm,
    motor_kW: spec.motor_kW,
    motorI_A: spec.motorI_A,
    npshr0_m: spec.npshr0_m,
    npshrBep_m: spec.npshrBep_m,
    npshrCoef: cn,
    /** Minimum continuous STABLE flow — the recirculation limit, not the thermal one. */
    minFlow_m3h: spec.minFlowFrac * Qb,
    /** Runout: where the rated-speed curve reaches zero head. */
    Qmax_m3h: (-a1 + Math.sqrt(a1 * a1 + 4 * a2 * H0)) / (2 * a2),
    casingVolume_L: spec.casingVolume_L === undefined ? 15 : spec.casingVolume_L,
    casingMass_kg: spec.casingMass_kg === undefined ? 60 : spec.casingMass_kg,
    Ns,
    Nss,
    /** Identity marker so `deratedPump` output can be told from a raw nameplate in a debugger. */
    derated: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Viscosity correction — Hydraulic Institute 9.6.7
// ---------------------------------------------------------------------------------------------

/**
 * The Hydraulic Institute viscous performance correction, in metric units.
 *
 * The method reduces the whole problem to one dimensionless parameter,
 *
 *     B = 16.5 * nu^0.5 * H_BEP^0.0625 / (Q_BEP^0.375 * N^0.25)
 *
 * with nu in mm2/s, H in m, Q in m3/h and N in rpm, and then reads three correction factors off
 * it: CQ on flow, CH on head and CE on efficiency. Below B = 1 there is no correction at all,
 * which is why cold water needs none — this pump comes out at B = 0.70 on water.
 *
 *     CQ = CH = exp(-0.165 * (log10 B)^3.15)          CE = B^(-0.0547 * B^0.69)
 *
 * NOTE ON SCOPE. The standard varies CH modestly with flow across four tabulated points; this
 * implementation applies the best-efficiency value across the curve, which is slightly
 * conservative below the BEP and very close above it. The standard is also only validated to
 * B = 40; beyond that the factors are extrapolated and `beyondScope` says so rather than
 * pretending otherwise.
 *
 * @param {object} pump the nameplate pump
 * @param {number} nu_cSt kinematic viscosity, mm2/s
 * @returns {{B:number, CQ:number, CH:number, CE:number, applies:boolean, beyondScope:boolean}}
 *   the correction
 */
export function viscousCorrection(pump, nu_cSt) {
  const B = (16.5 * Math.sqrt(Math.max(nu_cSt, 0.1)) * Math.pow(pump.Hbep_m, 0.0625))
    / (Math.pow(pump.Qbep_m3h, 0.375) * Math.pow(pump.nRated_rpm, 0.25));
  if (!(B > 1)) return { B, CQ: 1, CH: 1, CE: 1, applies: false, beyondScope: false };
  const logB = Math.log10(B);
  const C = Math.exp(-0.165 * Math.pow(logB, 3.15));
  const CE = Math.pow(B, -0.0547 * Math.pow(B, 0.69));
  return {
    B,
    CQ: clamp(C, 0.2, 1),
    CH: clamp(C, 0.2, 1),
    CE: clamp(CE, 0.1, 1),
    applies: true,
    beyondScope: B > 40,
  };
}

/**
 * Head multiplier from cavitation.
 *
 * NPSHr is by convention the suction margin at which developed head has ALREADY fallen 3%, so a
 * pump at zero margin is not healthy — it is at the edge. Below it, head collapses over a further
 * band; this model takes full breakdown at half the NPSHr below the curve, which is the shape of
 * a published suction-performance test. Above the curve the multiplier is exactly 1, so a
 * well-supplied pump carries no cavitation arithmetic at all.
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
 * Apply every derating a machine is carrying, and hand back something shaped exactly like a pump.
 *
 * @param {object} pump the nameplate pump from {@link createPump}
 * @param {object} mods what this particular machine is suffering from
 * @param {number} [mods.trim=1] impeller diameter ratio, 0.7..1. A permanent geometric difference.
 * @param {number} [mods.wear=0] wear-ring wear, 0 (new) .. 1 (scrap)
 * @param {number} [mods.cav=1] cavitation head multiplier from {@link cavitationFactor}
 * @param {object} [mods.visc] the {@link viscousCorrection} result, or omitted for none
 * @returns {object} a derated pump, usable anywhere a pump is
 */
export function deratedPump(pump, mods) {
  const d = clamp(mods && mods.trim !== undefined ? mods.trim : 1, 0.6, 1.05);
  const wear = clamp(mods && mods.wear !== undefined ? mods.wear : 0, 0, 1);
  const cav = mods && mods.cav !== undefined ? mods.cav : 1;
  const v = (mods && mods.visc) || { CQ: 1, CH: 1, CE: 1 };

  // Wear opens the wear-ring clearance. Liquid short-circuits from discharge back to suction, so
  // developed head falls, the power that produced it is wasted, and the inlet is disturbed enough
  // that the machine needs more suction margin than it used to.
  const wearHead = 1 - 0.18 * wear;
  const wearEta = 1 - 0.35 * wear;
  const wearNpshr = 1 + 0.45 * wear;
  // A trimmed impeller is slightly less efficient than a full-diameter one of the same casing.
  const trimEta = 1 - 0.15 * (1 - d);

  const headMul = cav * wearHead * v.CH;
  const H0 = headMul * d * d * pump.H0_m;
  const a1 = (headMul * d * pump.a1) / v.CQ;
  const a2 = (headMul * pump.a2) / (v.CQ * v.CQ);

  return {
    tag: pump.tag,
    H0_m: H0,
    a1,
    a2,
    Qbep_m3h: pump.Qbep_m3h * d * v.CQ,
    Hbep_m: pump.Hbep_m * headMul * d * d,
    etaBep: pump.etaBep * v.CE * wearEta * trimEta,
    Pbep_kW: pump.Pbep_kW * d * d * d,
    /** Efficiency multiplier, applied to POWER rather than asserted on a curve. */
    etaMul: v.CE * wearEta * trimEta,
    nRated_rpm: pump.nRated_rpm,
    motor_kW: pump.motor_kW,
    motorI_A: pump.motorI_A,
    npshr0_m: pump.npshr0_m * wearNpshr * d * d,
    npshrBep_m: pump.npshrBep_m * wearNpshr * d * d,
    npshrCoef: (pump.npshrCoef * wearNpshr * d * d) / (v.CQ * v.CQ),
    minFlow_m3h: pump.minFlow_m3h * d * v.CQ,
    Qmax_m3h: a2 > 0 ? (-a1 + Math.sqrt(a1 * a1 + 4 * a2 * H0)) / (2 * a2) : pump.Qmax_m3h,
    casingVolume_L: pump.casingVolume_L,
    casingMass_kg: pump.casingMass_kg,
    Ns: pump.Ns,
    Nss: pump.Nss,
    derated: true,
  };
}

// ---------------------------------------------------------------------------------------------
// The operating point
// ---------------------------------------------------------------------------------------------

/**
 * Developed head at a flow and speed ratio, by the homologous form.
 * @param {object} pump a pump, derated or not
 * @param {number} Q_m3h flow through the pump, m3/h
 * @param {number} s speed ratio N/Nrated
 * @returns {number} head, m (may go negative past runout, which is physical)
 */
export function headAt(pump, Q_m3h, s) {
  return s * s * pump.H0_m - s * pump.a1 * Q_m3h - pump.a2 * Q_m3h * Q_m3h;
}

/**
 * Shutoff head at a speed ratio — the most head this pump can produce, and therefore the head
 * above which its check valve stays shut and it delivers nothing.
 * @param {object} pump a pump
 * @param {number} s speed ratio
 * @returns {number} head, m
 */
export function shutoffHead(pump, s) {
  return s * s * pump.H0_m;
}

/**
 * Shaft power absorbed at an operating point.
 *
 * The power curve is stated, not derived: roughly linear in the flow referred to rated speed,
 * from `SHUTOFF_POWER_FRAC` of the best-efficiency power up through and past the BEP. It scales
 * with the cube of speed and linearly with density, and is divided by the efficiency multiplier
 * so that a viscous or worn machine draws MORE for the same duty, which is what the Hydraulic
 * Institute correction actually means.
 *
 * @param {object} pump a pump, derated or not
 * @param {number} Q_m3h flow, m3/h
 * @param {number} s speed ratio
 * @param {number} rho_kgm3 liquid density, kg/m3
 * @returns {number} shaft power, kW
 */
export function shaftPower_kW(pump, Q_m3h, s, rho_kgm3) {
  if (!(s > 0.02)) return 0;
  const q = Math.max(0, Q_m3h) / s;
  const shape = SHUTOFF_POWER_FRAC + (1 - SHUTOFF_POWER_FRAC) * (q / pump.Qbep_m3h);
  const etaMul = pump.etaMul === undefined ? 1 : Math.max(0.05, pump.etaMul);
  return (pump.Pbep_kW * s * s * s * shape * (rho_kgm3 / RATED_RHO)) / etaMul;
}

/**
 * Total efficiency at an operating point, DERIVED from the head and power curves.
 * @param {object} pump a pump, derated or not
 * @param {number} Q_m3h flow, m3/h
 * @param {number} H_m head developed, m
 * @param {number} s speed ratio
 * @param {number} rho_kgm3 density, kg/m3
 * @returns {number} efficiency, 0..1
 */
export function efficiencyAt(pump, Q_m3h, H_m, s, rho_kgm3) {
  if (!(Q_m3h > 0) || !(H_m > 0) || !(s > 0.02)) return 0;
  const shaft = shaftPower_kW(pump, Q_m3h, s, rho_kgm3);
  if (!(shaft > 0)) return 0;
  return clamp(hydraulicPower_kW(Q_m3h, H_m, rho_kgm3) / shaft, 0, 0.95);
}

/**
 * Heat the pump is putting into the liquid, kW.
 *
 * Everything the shaft absorbs that does not leave as hydraulic power ends up as heat, and most
 * of that heat ends up in the liquid rather than in the bearings or the air. This is the physical
 * basis of minimum continuous flow: a pump at shutoff is a 5 kW immersion heater in a 15 litre
 * casing, and the temperature rise is what destroys it long before anything mechanical does.
 *
 * @param {object} pump a pump, derated or not
 * @param {number} Q_m3h flow, m3/h
 * @param {number} H_m head developed, m
 * @param {number} s speed ratio
 * @param {number} rho_kgm3 density, kg/m3
 * @returns {number} heat into the liquid, kW
 */
export function heatIntoLiquid_kW(pump, Q_m3h, H_m, s, rho_kgm3) {
  const shaft = shaftPower_kW(pump, Q_m3h, s, rho_kgm3);
  const hyd = Q_m3h > 0 && H_m > 0 ? hydraulicPower_kW(Q_m3h, H_m, rho_kgm3) : 0;
  return Math.max(0, shaft - hyd) * 0.9;
}

/**
 * The steady-state temperature rise across a pump at a given flow, K.
 *
 * `deltaT = heat / (mass flow * specific heat)`. It is the number a minimum-flow line is sized
 * from — typically to hold the rise under 8 to 15 K — and it goes to infinity as the flow goes to
 * zero, which is why a deadheaded pump is an emergency and not an inconvenience.
 *
 * @param {object} pump a pump
 * @param {number} Q_m3h flow, m3/h
 * @param {number} H_m head, m
 * @param {number} s speed ratio
 * @param {number} rho_kgm3 density, kg/m3
 * @param {number} cp_JkgK specific heat, J/(kg K)
 * @returns {number} temperature rise, K — `Infinity` at zero flow
 */
export function temperatureRise_K(pump, Q_m3h, H_m, s, rho_kgm3, cp_JkgK) {
  if (!(Q_m3h > 1e-6)) return Infinity;
  const mdot = (Q_m3h / S_PER_H) * rho_kgm3;
  return (heatIntoLiquid_kW(pump, Q_m3h, H_m, s, rho_kgm3) * 1000) / (mdot * cp_JkgK);
}

/**
 * The flow below which the temperature rise exceeds a limit, m3/h.
 *
 * Solved directly rather than searched: at low flow the heat input is essentially the shutoff
 * power, so the relation is a straight inverse.
 *
 * @param {object} pump a pump
 * @param {number} s speed ratio
 * @param {number} rho_kgm3 density, kg/m3
 * @param {number} cp_JkgK specific heat, J/(kg K)
 * @param {number} dTlimit_K the allowable rise, K
 * @returns {number} the thermal minimum flow, m3/h
 */
export function thermalMinFlow_m3h(pump, s, rho_kgm3, cp_JkgK, dTlimit_K) {
  if (!(s > 0.02) || !(dTlimit_K > 0)) return 0;
  const heat_W = heatIntoLiquid_kW(pump, 0, 0, s, rho_kgm3) * 1000;
  return (heat_W / (rho_kgm3 * cp_JkgK * dTlimit_K)) * S_PER_H;
}

// ---------------------------------------------------------------------------------------------
// Suction
// ---------------------------------------------------------------------------------------------

/**
 * NPSH required at an operating point, m. Rises with the square of flow and scales with s^2.
 * @param {object} pump a pump, derated or not
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
 * @param {number} args.zStatic_m liquid surface height above the pump centreline, m
 * @param {number} args.hFriction_m suction-side friction loss at the current flow, m
 * @param {number} args.rho_kgm3 liquid density, kg/m3
 * @param {number} [args.pAtm_bar] site barometric pressure, bar absolute
 * @returns {number} NPSH available, m
 */
export function npshAvailable_m({ pTank_bar, pVap_bar, zStatic_m, hFriction_m, rho_kgm3, pAtm_bar }) {
  const atm = pAtm_bar === undefined ? ATM_BAR : pAtm_bar;
  return (((atm + pTank_bar - pVap_bar) * 1e5) / (rho_kgm3 * G)) + zStatic_m - hFriction_m;
}

/**
 * Solve, in closed form, the flow a pump passes into a header at a known head.
 *
 * The branch balance from the tank surface to the header is
 *
 *     zStatic + H(Q, s) - K*Q^2 = Hheader
 *
 * with `K` the total branch resistance. Substituting the homologous curve makes it a quadratic:
 *
 *     (a2 + K)*Q^2 + (s*a1)*Q - (zStatic + s^2*H0 - Hheader) = 0
 *
 * whose positive root is taken directly — no iteration, no convergence test, no chance of a
 * solver failing mid-transient. When the constant term is negative the header already stands
 * above anything this pump can produce, the check valve is shut, and the answer is exactly zero.
 * That discontinuity in the DERIVATIVE (not the value) is the single most important nonlinearity
 * in a parallel-pump system and is reproduced exactly rather than smoothed away.
 *
 * Every derating — viscosity, trim, wear, cavitation — is already folded into the coefficients by
 * {@link deratedPump}, so this function does not need to know about any of them.
 *
 * @param {object} pump a pump, normally a derated one
 * @param {number} s speed ratio
 * @param {number} Hheader_m header head, m
 * @param {number} zStatic_m suction static head available at the pump, m
 * @param {number} K branch resistance coefficient, m per (m3/h)^2
 * @returns {{Q_m3h:number, dQdH:number, checkShut:boolean}} the flow, its sensitivity to header
 *   head (negative), and whether the check valve is holding shut
 */
export function solveBranchFlow(pump, s, Hheader_m, zStatic_m, K) {
  const alpha = pump.a2 + K;
  const beta = s * pump.a1;
  const gamma = zStatic_m + s * s * pump.H0_m - Hheader_m;
  if (!(gamma > 0) || !(alpha > 0)) return { Q_m3h: 0, dQdH: 0, checkShut: true };
  const Q = (-beta + Math.sqrt(beta * beta + 4 * alpha * gamma)) / (2 * alpha);
  const denom = Math.max(2 * alpha * Q + beta, 1e-9);
  return { Q_m3h: Q, dQdH: -1 / denom, checkShut: false };
}

// ---------------------------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------------------------

/** ISO 10816-3 evaluation zones for a medium machine (15-300 kW) on a rigid foundation, mm/s RMS. */
export const VIB_ZONES = Object.freeze({ AB: 2.3, BC: 4.5, CD: 7.1 });

/**
 * Overall vibration velocity, mm/s RMS, as a condition-monitoring instrument would read it.
 *
 * Four contributions, because four different faults show up here and an operator is expected to
 * tell them apart:
 *
 *   BASELINE      residual unbalance and alignment, rising with speed.
 *   OFF-BEP       suction and discharge recirculation. A centrifugal pump is hydraulically quiet
 *                 only near its best-efficiency flow; pushed to either end of its curve it
 *                 develops rotating stall in the impeller passages, and that is what actually
 *                 destroys pumps that are run at 30% of BEP "to save energy".
 *   CAVITATION    broadband, and loud. Collapsing vapour cavities are the noisiest thing a pump
 *                 can do short of a mechanical failure.
 *   WEAR          growing unbalance as clearances open up.
 *
 * @param {object} pump a pump, derated or not
 * @param {number} Q_m3h flow, m3/h
 * @param {number} s speed ratio
 * @param {number} cav cavitation head multiplier, 1 when healthy
 * @param {number} wear wear fraction, 0..1
 * @returns {number} overall velocity, mm/s RMS
 */
export function vibration_mms(pump, Q_m3h, s, cav, wear) {
  if (!(s > 0.02)) return 0;
  const base = 0.75 * s;
  const x = pump.Qbep_m3h > 0 ? Q_m3h / (s * pump.Qbep_m3h) : 1;
  // Quiet between 0.7 and 1.15 of BEP; rising steeply outside it, worse to the left where
  // suction recirculation lives.
  const low = x < 0.7 ? (0.7 - x) / 0.7 : 0;
  const high = x > 1.15 ? (x - 1.15) / 0.5 : 0;
  const offBep = (5.2 * low * low + 3.0 * high * high) * s * s;
  const cavitation = cav < 1 ? 9.0 * Math.pow(1 - cav, 0.7) * s : 0;
  const unbalance = 3.5 * wear * wear * s * s;
  return base + offBep + cavitation + unbalance;
}

/**
 * The ISO 10816-3 zone letter for an overall velocity reading.
 * @param {number} v_mms overall velocity, mm/s RMS
 * @returns {string} 'A', 'B', 'C' or 'D'
 */
export function vibrationZone(v_mms) {
  if (v_mms <= VIB_ZONES.AB) return 'A';
  if (v_mms <= VIB_ZONES.BC) return 'B';
  if (v_mms <= VIB_ZONES.CD) return 'C';
  return 'D';
}

/**
 * How fast this machine is wearing out, in wear-fraction per hour.
 *
 * A pump run at its best-efficiency flow with a healthy suction lasts decades. The same pump run
 * hard off-BEP, or cavitating, does not — and the whole argument for duty rotation, for
 * minimum-flow protection and for keeping the operating point where it belongs is that this
 * number is not constant.
 *
 * @param {object} pump a pump
 * @param {number} Q_m3h flow, m3/h
 * @param {number} s speed ratio
 * @param {number} cav cavitation head multiplier
 * @param {number} baseRate_perH wear fraction per running hour at the BEP
 * @returns {number} wear fraction per hour
 */
export function wearRate_perH(pump, Q_m3h, s, cav, baseRate_perH) {
  if (!(s > 0.02)) return 0;
  const x = pump.Qbep_m3h > 0 ? Q_m3h / (s * pump.Qbep_m3h) : 1;
  const offBep = 1 + 6 * (x - 1) * (x - 1);
  const cavitating = cav < 1 ? 1 + 14 * (1 - cav) : 1;
  return baseRate_perH * s * s * offBep * cavitating;
}
