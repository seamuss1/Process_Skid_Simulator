/**
 * src/process/fluids2.js — the fluid side pushed past clean single-phase liquid: entrained gas,
 * shear-thinning rheology, settling solids, slurry wear, and a second library of real fluids.
 *
 * Layer L1: imports `core/util.js`, `process/fluid.js` and `process/pipe.js`. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 *
 * `fluid.js` describes liquids that are clean, single-phase and Newtonian. Almost nothing on a
 * real plant is all three, and every one of the departures has a cliff in it:
 *
 *   ENTRAINED GAS      a centrifugal pump tolerates a couple of percent of free gas with a
 *                      measurable but survivable loss of head, and then it stops. Not degrades —
 *                      STOPS. Gas collects in the low-pressure region of the impeller passage,
 *                      the liquid stops being pushed through it, and the machine gas locks. The
 *                      flow transmitter goes to zero, the ammeter goes DOWN, and an operator who
 *                      has only ever seen cavitation reads the quiet motor as a healthy one.
 *
 *   NON-NEWTONIAN      a shear-thinning slurry has no single viscosity. It is 400 cSt in a
 *                      sample jar and 10 cSt in an impeller eye, and the Reynolds number that
 *                      decides whether the line is laminar has to be redefined before it means
 *                      anything. Size the pump off the jar figure and it is enormous; size the
 *                      line off the impeller figure and it silts up.
 *
 *   SETTLING SOLIDS    below a critical velocity the solids drop out and the line starts to
 *                      build a bed. Pressure drop then RISES as flow FALLS, which is positive
 *                      feedback: a flow controller trimming a valve shut to hold setpoint on a
 *                      silting line is closing the loop the wrong way round, and the line plugs
 *                      while every indication still reads normal.
 *
 *   WEAR               abrasive solids remove metal at close to the 2.5 power of velocity. That
 *                      exponent is the entire argument for running a slurry pump slowly and
 *                      large rather than quickly and small, and it is the number the maintenance
 *                      layer needs in order to say when an impeller is due.
 *
 * NOTHING HERE MUTATES ANYTHING. Every function is pure, every constant table is frozen, and
 * every model that can be handed nonsense returns `{ ok:false, reason }` instead of throwing.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT MODELLED
 *
 * Slug flow, flow-pattern maps, and the transition to annular flow. This rig pumps a liquid that
 * happens to carry gas; it is not a multiphase flowline. The gas model is a homogeneous bubbly
 * one with a breakdown point, which is the part a pump engineer has to reason about and the part
 * that is well enough documented to be worth reproducing.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, G } from '../core/util.js';
import { waltherFit, clausius, waterVapourPressure_bar } from './fluid.js';
import { velocity_ms } from './pipe.js';

/** Universal gas constant, J/(mol K). */
const R_GAS = 8.314462618;

/** Standard conditions a "standard cubic metre" of entrained gas is referred to. */
const P_STD_BARA = 1.01325;
const T_STD_K = 288.15;

// =============================================================================================
// ENTRAINED GAS
// =============================================================================================

/**
 * How much free gas different impeller geometries survive before they gas lock, as an inlet
 * volumetric gas fraction at the best-efficiency flow with an atmospheric suction.
 *
 * SOURCE. The closed-radial figure is the consensus of the experimental two-phase pump
 * literature — Murakami & Minemura, Bull. JSME 17(110), 1974, whose air-water tests on a
 * conventional radial machine show progressive head loss from about 1% air and complete
 * breakdown (their "surging" condition) in the 6 to 8% range. The remaining entries are the
 * usual vendor and Hydraulic Institute guidance for the alternative geometries, all of which
 * exist precisely because 7% is not enough for some services.
 */
export const GAS_HANDLING = Object.freeze({
  /** The ordinary process pump. Closed impeller, narrow passages, nowhere for gas to go. */
  CLOSED_RADIAL: Object.freeze({ alphaBreakdown: 0.07, label: 'closed radial impeller' }),
  /** Open or semi-open impeller: wider passages sweep gas through instead of trapping it. */
  OPEN_RADIAL: Object.freeze({ alphaBreakdown: 0.10, label: 'open impeller' }),
  /** An inducer ahead of the eye raises the local pressure before the gas has to turn. */
  INDUCER: Object.freeze({ alphaBreakdown: 0.15, label: 'inducer' }),
  /** Self-priming: designed to clear its own suction line, so it must survive being gassy. */
  SELF_PRIMING: Object.freeze({ alphaBreakdown: 0.12, label: 'self-priming' }),
  /** Recessed / torque-flow (vortex): most of the liquid never enters the impeller at all. */
  VORTEX: Object.freeze({ alphaBreakdown: 0.25, label: 'recessed vortex impeller' }),
  /** A genuine multiphase machine. Handles gas as a design case, not as an insult. */
  HELICO_AXIAL: Object.freeze({ alphaBreakdown: 0.70, label: 'helico-axial multiphase' }),
});

/** Shape parameters of the head-degradation curve. See {@link gasDegradation}. */
const GAS_SHAPE_LINEAR_W = 0.35;
const GAS_SHAPE_POWER = 4;
/** Head ratio a fully gas-locked machine retains — not zero, because the eye is still wetted. */
const GAS_LOCK_RESIDUAL = 0.04;
/** The head loss that defines "onset": the point an operator would first see on a gauge. */
const GAS_ONSET_LOSS = 0.02;

/**
 * Bunsen coefficient for air in water at 20 C: volumes of gas, reduced to standard conditions,
 * dissolved in one volume of water under one atmosphere of air. 18.7 mL/L is the standard
 * handbook figure, and it is the reason a suction lift makes its own gas.
 */
export const AIR_IN_WATER_BUNSEN = 0.0187;

/**
 * In-situ volumetric gas fraction at the pump suction, from a gas load quoted at standard
 * conditions.
 *
 * The gas obeys the ideal gas law and the liquid does not compress, so a gas load that is 2% of
 * the stream at atmospheric pressure is 0.4% of it at 5 bar absolute. THAT IS THE ENTIRE REASON
 * PRESSURISING A SUCTION VESSEL FIXES A GASSY PUMP: the machine never sees the gas the process
 * put in, it sees what is left of it after compression.
 *
 * @param {object} args the gas load and the conditions it arrives at
 * @param {number} args.gvfStd free-gas volume fraction referred to standard conditions, 0..1
 * @param {number} args.pSuction_bara absolute pressure at the pump suction, bar
 * @param {number} args.T_C liquid temperature, C
 * @param {number} [args.Z=1] gas compressibility factor; 1 is right below about 20 bar
 * @returns {{alpha:number, ratio:number, expansion:number}} the in-situ void fraction, the
 *   in-situ gas-to-liquid volume ratio, and the factor the gas volume has changed by
 */
export function inSituVoidFraction({ gvfStd, pSuction_bara, T_C, Z = 1 }) {
  const g0 = clamp(gvfStd, 0, 0.999);
  const p = Math.max(pSuction_bara, 0.05);
  const T = Math.max(T_C + 273.15, 100);
  const rStd = g0 / (1 - g0);
  // V ~ Z*R*T/p, referred to the standard state the gas load was quoted at.
  const expansion = Z * (P_STD_BARA / p) * (T / T_STD_K);
  const r = rStd * expansion;
  return { alpha: r / (1 + r), ratio: r, expansion };
}

/**
 * Free gas released from solution when the suction pressure falls below the pressure the liquid
 * was saturated at, as a standard-conditions gas fraction.
 *
 * Henry's law, and a badly under-appreciated failure. Water in a vented tank is saturated with
 * air at one atmosphere. Put it on a six-metre suction lift and the pressure at the pump eye is
 * about 0.4 bar absolute, so roughly 60% of that dissolved air comes back out — of order 1% free
 * gas, arriving exactly where the machine can least tolerate it, with no gas source anywhere on
 * the P&ID. The symptom is a pump that will not hold prime and a suction line nobody can find a
 * leak in.
 *
 * @param {object} args saturation and suction conditions
 * @param {number} args.pSaturation_bara pressure the liquid last equilibrated with gas at, bar a
 * @param {number} args.pSuction_bara absolute pressure at the pump suction, bar
 * @param {number} [args.bunsen=AIR_IN_WATER_BUNSEN] solubility, standard gas volume per liquid
 *   volume per atmosphere of partial pressure
 * @returns {{gvfStd:number, releasedRatio:number}} the released gas as a standard-conditions void
 *   fraction, and as a gas-to-liquid volume ratio
 */
export function dissolvedGasBreakout({
  pSaturation_bara, pSuction_bara, bunsen = AIR_IN_WATER_BUNSEN,
}) {
  const drop = Math.max(0, pSaturation_bara - Math.max(pSuction_bara, 0));
  const r = Math.max(0, bunsen) * (drop / P_STD_BARA);
  return { gvfStd: r / (1 + r), releasedRatio: r };
}

/**
 * The void fraction at which this machine, on this duty, gas locks.
 *
 * The tabulated figure in {@link GAS_HANDLING} is for the best-efficiency flow at full speed with
 * an atmospheric suction. Three things move it, and all three are things the operator controls:
 *
 *   FLOW      gas handling is best at the BEP and collapses toward shutoff. At low flow the
 *             relative velocity through the impeller passage is small, so a bubble that has
 *             separated is not swept out — it grows. A throttled gassy pump locks; the same
 *             machine opened up runs.
 *   SUCTION   raising the absolute suction pressure shrinks the bubbles at a given void fraction
 *             and raises the fraction the machine survives. The exponent is mild — a quarter
 *             power — and capped, because the mechanism saturates.
 *   SPEED     more head per stage breaks bubbles up and re-entrains them. Slowing a gassy pump
 *             down on the VFD to "be gentle with it" makes the gas problem worse, not better.
 *
 * @param {object} [args] the duty
 * @param {number} [args.alphaBreakdown] override the tabulated breakdown fraction
 * @param {string} [args.impeller='CLOSED_RADIAL'] a key of {@link GAS_HANDLING}
 * @param {number} [args.flowRatio=1] Q / (s * Qbep) — flow referred to the BEP at this speed
 * @param {number} [args.pSuction_bara=1.01325] absolute suction pressure, bar
 * @param {number} [args.speedRatio=1] N/Nrated
 * @returns {number} the in-situ void fraction at which head collapses, 0..1
 */
export function breakdownVoidFraction({
  alphaBreakdown, impeller = 'CLOSED_RADIAL', flowRatio = 1,
  pSuction_bara = P_STD_BARA, speedRatio = 1,
} = {}) {
  const table = GAS_HANDLING[impeller] || GAS_HANDLING.CLOSED_RADIAL;
  const base = alphaBreakdown === undefined ? table.alphaBreakdown : alphaBreakdown;
  const q = clamp(flowRatio, 0, 2);
  // Far harsher to the left of the BEP, where the passage velocity is low, than to the right.
  const fq = q < 1
    ? clamp(1 - (1 - q) * (1 - q), 0.08, 1)
    : clamp(1 - 0.3 * (q - 1) * (q - 1), 0.4, 1);
  const fp = clamp(Math.pow(Math.max(pSuction_bara, 0.1) / P_STD_BARA, 0.25), 0.5, 2);
  const fs = Math.sqrt(clamp(speedRatio, 0.2, 1.2));
  return clamp(base * fq * fp * fs, 0.0005, 0.95);
}

/**
 * Head and efficiency multipliers from entrained gas, and the regime the machine is in.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE. Published air-water pump tests all show the same three
 * features, and this curve reproduces exactly those three with nothing else asserted:
 *
 *   1. a gentle, near-linear initial droop — a couple of percent of gas costs of order ten
 *      percent of the head, which is a nuisance rather than a failure;
 *   2. a distinct KNEE, beyond which the slope steepens by nearly an order of magnitude;
 *   3. a breakdown point at which head falls to essentially nothing and stays there.
 *
 *     ratio(x) = 1 - (1 - residual) * [ w*x + (1-w)*x^p ]        x = alpha / alphaBreakdown
 *
 * The linear term carries feature 1, the quartic term carries features 2 and 3, and `w` sets
 * where the knee sits. At w = 0.35 the model loses 10% of head at 2% gas against a 7% breakdown,
 * and the slope at breakdown is seven times the slope at onset — both of which are what the
 * Murakami & Minemura curves do.
 *
 * A cubic and a plain exponential were both tried and rejected: neither has a knee sharp enough,
 * and a model without a knee lets an operator believe there is a gentle warning before gas lock.
 * There is not. That is the whole point.
 *
 * EFFICIENCY falls faster than head, because gas is being compressed and re-expanded inside the
 * impeller passage and that work is never recovered.
 *
 * @param {number} alpha in-situ volumetric gas fraction at the impeller eye, 0..1
 * @param {object} [duty] passed straight to {@link breakdownVoidFraction}
 * @returns {{headMul:number, effMul:number, alphaBreakdown:number, alphaOnset:number,
 *   margin:number, regime:string, locked:boolean}} the derating, the breakdown fraction it was
 *   computed against, the fraction at which the loss first reaches 2%, the remaining margin in
 *   void fraction, a regime label, and whether the machine has gas locked
 */
export function gasDegradation(alpha, duty) {
  const aBd = breakdownVoidFraction(duty);
  const a = Math.max(0, alpha || 0);
  const shape = (x) => GAS_SHAPE_LINEAR_W * x
    + (1 - GAS_SHAPE_LINEAR_W) * Math.pow(x, GAS_SHAPE_POWER);

  // Where the loss first reaches 2%. `shape` is strictly increasing on [0,1], so bisection is
  // unconditionally safe and needs no derivative.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = 0.5 * (lo + hi);
    if ((1 - GAS_LOCK_RESIDUAL) * shape(mid) < GAS_ONSET_LOSS) lo = mid; else hi = mid;
  }
  const alphaOnset = 0.5 * (lo + hi) * aBd;

  const x = a / aBd;
  const locked = x >= 1;
  const headMul = locked
    ? GAS_LOCK_RESIDUAL
    : clamp(1 - (1 - GAS_LOCK_RESIDUAL) * shape(x), GAS_LOCK_RESIDUAL, 1);
  let regime;
  if (a <= 0) regime = 'clear';
  else if (locked) regime = 'gas-locked';
  else if (a < alphaOnset) regime = 'dispersed';
  else if (x < 0.6) regime = 'degrading';
  else regime = 'surging';
  return {
    headMul,
    effMul: clamp(Math.pow(headMul, 1.25), 0.02, 1),
    alphaBreakdown: aBd,
    alphaOnset,
    margin: aBd - a,
    regime,
    locked,
  };
}

/**
 * Homogeneous mixture density, kg/m3.
 *
 * Worth stating on its own, because a gassy pump loses discharge PRESSURE twice over: it develops
 * fewer metres of head, and each metre is worth less because the mixture is lighter. A 10% head
 * loss at 5% gas is a 14% pressure loss, and the motor current falls with it — which is the
 * signature that separates gas from cavitation, where the current does not fall.
 *
 * @param {number} rhoL_kgm3 liquid density
 * @param {number} rhoG_kgm3 gas density at suction conditions
 * @param {number} alpha in-situ void fraction, 0..1
 * @returns {number} mixture density, kg/m3
 */
export function mixtureDensity_kgm3(rhoL_kgm3, rhoG_kgm3, alpha) {
  const a = clamp(alpha, 0, 1);
  return a * rhoG_kgm3 + (1 - a) * rhoL_kgm3;
}

/**
 * Speed of sound in a bubbly mixture, by Wood's equation.
 *
 *     1 / (rho_m * c_m^2) = alpha / (rho_g * c_g^2) + (1 - alpha) / (rho_l * c_l^2)
 *
 * The compressibilities add while the densities average, and the result is spectacular:
 * air-water at half void fraction carries sound at about 24 m/s, fourteen times slower than air
 * and sixty times slower than water. Since the Joukowsky surge in `pipe.js` is proportional to
 * wave speed, A LITTLE ENTRAINED GAS IS THE CHEAPEST SURGE SUPPRESSOR THERE IS — and equally, a
 * line that has just been purged of gas will hammer far harder than the same line did last week.
 *
 * @param {number} alpha void fraction, 0..1
 * @param {number} rhoL_kgm3 liquid density
 * @param {number} rhoG_kgm3 gas density
 * @param {number} cL_ms sonic velocity in the liquid, or the effective value for the pipe, m/s
 * @param {number} [cG_ms=340] sonic velocity in the gas, m/s
 * @returns {number} mixture sonic velocity, m/s
 */
export function woodSoundSpeed_ms(alpha, rhoL_kgm3, rhoG_kgm3, cL_ms, cG_ms = 340) {
  const a = clamp(alpha, 0, 1);
  const rhoM = mixtureDensity_kgm3(rhoL_kgm3, rhoG_kgm3, a);
  const comp = a / (rhoG_kgm3 * cG_ms * cG_ms) + (1 - a) / (rhoL_kgm3 * cL_ms * cL_ms);
  return Math.sqrt(1 / (rhoM * comp));
}

// =============================================================================================
// NON-NEWTONIAN RHEOLOGY
// =============================================================================================

/**
 * Build a frozen rheology from Herschel-Bulkley parameters.
 *
 *     tau = tau0 + K * gammaDot^n
 *
 * Three special cases fall out of the same three numbers, and the model reports which one it is
 * because the engineering consequences differ sharply:
 *
 *   NEWTONIAN            tau0 = 0, n = 1. `K` is then the dynamic viscosity in Pa s, exactly.
 *   POWER-LAW            tau0 = 0, n < 1. Shear-thinning. Thick at rest, thin in an impeller.
 *   HERSCHEL-BULKLEY     tau0 > 0. A YIELD STRESS: below it the fluid does not flow at all, it
 *                        just sits there as a solid plug. That is what makes a settled drilling
 *                        mud or a cement slurry impossible to restart with the pump you used to
 *                        move it, and it is why {@link yieldStartHead_m} exists.
 *
 * @param {object} spec the rheogram
 * @param {number} spec.K_Pasn consistency index, Pa s^n
 * @param {number} [spec.n=1] flow behaviour index; below 1 is shear-thinning
 * @param {number} [spec.tau0_Pa=0] yield stress, Pa
 * @param {string} [spec.name] a label for display
 * @returns {object} the frozen rheology, or `{ ok:false, reason }` if the spec is not physical
 */
export function createRheology(spec) {
  if (!spec || !(spec.K_Pasn > 0)) {
    return { ok: false, reason: 'the consistency index K must be greater than zero' };
  }
  const n = spec.n === undefined ? 1 : spec.n;
  if (!(n > 0.05) || !(n <= 1.6)) {
    return { ok: false, reason: `flow behaviour index ${n} is outside the modelled 0.05..1.6` };
  }
  const tau0 = Math.max(0, spec.tau0_Pa || 0);
  let model = 'power-law';
  if (tau0 > 0) model = n === 1 ? 'bingham' : 'herschel-bulkley';
  else if (n === 1) model = 'newtonian';
  return Object.freeze({
    ok: true,
    name: spec.name || model,
    K_Pasn: spec.K_Pasn,
    n,
    tau0_Pa: tau0,
    model,
  });
}

/** A Newtonian rheology built from a dynamic viscosity, for comparing like with like. */
export const newtonianRheology = (mu_Pas) => createRheology({ K_Pasn: mu_Pas, n: 1, tau0_Pa: 0 });

/**
 * Shear stress at a shear rate, Pa. The rheogram itself.
 * @param {object} rheo a rheology from {@link createRheology}
 * @param {number} gammaDot_s shear rate, 1/s
 * @returns {number} shear stress, Pa
 */
export function shearStress_Pa(rheo, gammaDot_s) {
  const gd = Math.max(gammaDot_s, 0);
  return rheo.tau0_Pa + rheo.K_Pasn * Math.pow(gd, rheo.n);
}

/**
 * Apparent viscosity at a shear rate, Pa s — the Newtonian viscosity that would give the same
 * stress at that one shear rate, and nowhere else.
 *
 * This is the number every datasheet quotes and every sizing mistake comes from. It is only
 * meaningful with the shear rate stated alongside it, which is why this function will not accept
 * a default.
 *
 * A yield fluid's apparent viscosity is unbounded as the shear rate goes to zero — physically
 * correct, numerically useless — so it is capped, and the cap is stated rather than hidden.
 *
 * @param {object} rheo a rheology
 * @param {number} gammaDot_s shear rate, 1/s
 * @returns {number} apparent viscosity, Pa s, capped at 1e4
 */
export function apparentViscosity_Pas(rheo, gammaDot_s) {
  const gd = Math.max(gammaDot_s, 1e-9);
  return Math.min(shearStress_Pa(rheo, gd) / gd, 1e4);
}

/**
 * The equivalent kinematic viscosity in the mm2/s the rest of the rig speaks, so a non-Newtonian
 * fluid can be handed to `pump.js`'s Hydraulic Institute correction at the shear rate the
 * impeller actually imposes.
 *
 * @param {object} rheo a rheology
 * @param {number} gammaDot_s shear rate, 1/s
 * @param {number} rho_kgm3 density
 * @returns {number} kinematic viscosity, mm2/s
 */
export function equivalentKinematic_cSt(rheo, gammaDot_s, rho_kgm3) {
  return (apparentViscosity_Pas(rheo, gammaDot_s) / Math.max(rho_kgm3, 1)) * 1e6;
}

/**
 * Characteristic shear rate inside a centrifugal impeller: the peripheral velocity divided by the
 * exit width.
 *
 *     gammaDot ~ u2 / b2,        u2 = pi * d2 * N / 60
 *
 * A 250 mm impeller 12 mm wide at 2950 rpm shears the liquid at about 3200 1/s. THIS IS THE
 * SINGLE MOST USEFUL NUMBER IN THE WHOLE NON-NEWTONIAN SECTION. A bentonite mud measured at
 * 10 1/s in a viscometer looks like 380 cSt; the same mud in that impeller is 11 cSt, and the
 * Hydraulic Institute derate goes from crippling to negligible. An engineer who sizes the pump
 * off the viscometer reading buys twice the machine that is needed — and then runs it far left
 * of its BEP for the next twenty years.
 *
 * @param {object} args impeller geometry and speed
 * @param {number} args.d2_m impeller outside diameter, m
 * @param {number} args.b2_m impeller exit width, m
 * @param {number} args.n_rpm shaft speed, rpm
 * @returns {number} characteristic shear rate, 1/s
 */
export function impellerShearRate_s({ d2_m, b2_m, n_rpm }) {
  const u2 = (Math.PI * d2_m * n_rpm) / 60;
  return u2 / Math.max(b2_m, 1e-4);
}

/**
 * The local power-law that best represents a Herschel-Bulkley fluid at one shear rate.
 *
 * Every correlation worth having — Metzner-Reed, Dodge-Metzner, Ryan-Johnson — is written for a
 * power-law fluid. Rather than reject yield fluids, take the tangent to the rheogram in log-log
 * coordinates, which is exactly the "effective n and K" the drilling industry computes from a
 * pair of Fann readings:
 *
 *     n' = d(ln tau) / d(ln gammaDot) = n*K*gd^n / (tau0 + K*gd^n)
 *     K' = tau / gd^n'
 *
 * For a fluid with no yield stress this is an IDENTITY — n' = n and K' = K at every shear rate —
 * so nothing is approximated for the fluids that do not need it.
 *
 * @param {object} rheo a rheology
 * @param {number} gammaDot_s the shear rate to linearise about, 1/s
 * @returns {{n_eff:number, K_eff:number}} the local power-law
 */
export function effectivePowerLaw(rheo, gammaDot_s) {
  const gd = Math.max(gammaDot_s, 1e-9);
  const visc = rheo.K_Pasn * Math.pow(gd, rheo.n);
  const tau = rheo.tau0_Pa + visc;
  const nEff = clamp(tau > 0 ? (rheo.n * visc) / tau : rheo.n, 0.05, 1.6);
  return { n_eff: nEff, K_eff: tau / Math.pow(gd, nEff) };
}

/**
 * The Metzner-Reed generalised Reynolds number.
 *
 *     Re_MR = rho * V^(2-n) * D^n / [ K * 8^(n-1) * ((3n+1)/(4n))^n ]
 *
 * The definition is not arbitrary and it is not a fit. It is constructed so that the laminar
 * friction factor is EXACTLY 64/Re_MR for any n, which is what makes it worth having: every
 * piece of Newtonian intuition about Reynolds number — the laminar law, the critical value, the
 * turbulent correlations — transfers across unchanged.
 *
 * At n = 1 the bracket collapses to K, and Re_MR becomes rho*V*D/mu identically. That is the
 * check this function is validated by.
 *
 * @param {number} n flow behaviour index
 * @param {number} K_Pasn consistency index, Pa s^n
 * @param {object} args the duty
 * @param {number} args.v_ms mean velocity, m/s
 * @param {number} args.id_m internal diameter, m
 * @param {number} args.rho_kgm3 density
 * @returns {number} the generalised Reynolds number
 */
export function metznerReedReynolds(n, K_Pasn, { v_ms, id_m, rho_kgm3 }) {
  const v = Math.abs(v_ms);
  if (!(v > 0) || !(id_m > 0) || !(K_Pasn > 0)) return 0;
  const denom = K_Pasn * Math.pow(8, n - 1) * Math.pow((3 * n + 1) / (4 * n), n);
  return (rho_kgm3 * Math.pow(v, 2 - n) * Math.pow(id_m, n)) / denom;
}

/**
 * The Ryan-Johnson critical Reynolds number: where a power-law fluid stops being laminar.
 *
 *     Re_c = 6464 * n * (2+n)^((2+n)/(1+n)) / (1+3n)^2
 *
 * It reduces to 2100 at n = 1, which is the classical Newtonian value and the check this is
 * validated by. Shear-thinning fluids stay laminar to HIGHER Reynolds numbers — a mud at n = 0.5
 * does not go turbulent until about 2400 — which matters because laminar slurry transport is
 * exactly the condition under which solids settle out.
 *
 * @param {number} n flow behaviour index
 * @returns {number} the critical generalised Reynolds number
 */
export function criticalReynolds(n) {
  const nn = clamp(n, 0.05, 1.6);
  return (6464 * nn * Math.pow(2 + nn, (2 + nn) / (1 + nn))) / ((1 + 3 * nn) * (1 + 3 * nn));
}

/**
 * The Dodge-Metzner turbulent friction factor for a power-law fluid, solved for the Darcy form.
 *
 *     1/sqrt(f_F) = (4.0/n^0.75) * log10( Re_MR * f_F^(1 - n/2) ) - 0.4/n^1.2
 *
 * Dodge & Metzner, AIChE J. 5(2), 1959 — still the standard smooth-pipe correlation for
 * shear-thinning fluids sixty years on. It is implicit, so it is solved by damped fixed-point
 * iteration on y = 1/sqrt(f_F); damping is what keeps it from oscillating at low n, where the
 * log coefficient is large.
 *
 * At n = 1 the correlation IS the Nikuradse smooth-pipe law, and it agrees with the Swamee-Jain
 * smooth-pipe factor in `pipe.js` to about 1% across the whole turbulent range. That agreement
 * is the check, and it also means a Newtonian fluid gets the same answer from either module.
 *
 * SMOOTH PIPE ONLY. There is no accepted roughness term for non-Newtonian turbulent flow, and
 * inventing one would be worse than saying so: shear-thinning fluids carry a thick viscous
 * sublayer that buries ordinary commercial roughness anyway.
 *
 * @param {number} n flow behaviour index
 * @param {number} Re the generalised Reynolds number
 * @returns {number} the DARCY friction factor (four times the Fanning one)
 */
export function dodgeMetznerFactor(n, Re) {
  if (!(Re > 0)) return 0;
  const a = 4.0 / Math.pow(n, 0.75);
  const b = 0.4 / Math.pow(n, 1.2);
  const p = 1 - n / 2;
  const logRe = Math.log10(Re);
  let y = Math.max(4, a * logRe - b);
  for (let i = 0; i < 200; i += 1) {
    const yn = a * (logRe - 2 * p * Math.log10(Math.max(y, 1e-3))) - b;
    if (!(yn > 0.5)) break;
    const d = yn - y;
    y += 0.6 * d;
    if (Math.abs(d) < 1e-12) break;
  }
  return 4 / (y * y);
}

/**
 * Everything about a non-Newtonian fluid in a pipe at one working point.
 *
 * The wall shear rate comes from the Rabinowitsch-Mooney correction,
 *
 *     gammaDot_w = (8V/D) * (3n+1)/(4n)
 *
 * which is where the (3n+1)/(4n) in the Metzner-Reed number comes from and why the two must be
 * computed together. For a yield fluid, `n` here is the LOCAL n' from {@link effectivePowerLaw},
 * which itself depends on the wall shear rate — so the pair is iterated. It converges in a
 * handful of passes, and for a fluid with no yield stress it converges in exactly one because
 * n' is then a constant.
 *
 * @param {object} rheo a rheology from {@link createRheology}
 * @param {object} args the duty
 * @param {number} args.v_ms mean velocity, m/s
 * @param {number} args.id_m internal diameter, m
 * @param {number} args.rho_kgm3 density
 * @returns {{ok:boolean, reason?:string, gammaW_s?:number, n_eff?:number, K_eff?:number,
 *   muApparent_Pas?:number, Re?:number, ReCrit?:number, regime?:string, f?:number}} the wall
 *   shear rate, the local power law, the apparent viscosity there, the generalised Reynolds
 *   number, its critical value, the regime, and the Darcy friction factor
 */
export function pipeFlowState(rheo, { v_ms, id_m, rho_kgm3 }) {
  if (!rheo || rheo.ok !== true) return { ok: false, reason: 'no valid rheology supplied' };
  const v = Math.abs(v_ms);
  if (!(id_m > 0) || !(rho_kgm3 > 0)) {
    return { ok: false, reason: 'pipe diameter and density must be greater than zero' };
  }
  if (!(v > 1e-9)) {
    return {
      ok: true,
      gammaW_s: 0,
      n_eff: rheo.n,
      K_eff: rheo.K_Pasn,
      muApparent_Pas: apparentViscosity_Pas(rheo, 0),
      Re: 0,
      ReCrit: criticalReynolds(rheo.n),
      regime: 'stagnant',
      f: 0,
    };
  }
  const nominal = (8 * v) / id_m;
  let n = rheo.n;
  let K = rheo.K_Pasn;
  let gw = nominal * ((3 * n + 1) / (4 * n));
  for (let i = 0; i < 12; i += 1) {
    const eff = effectivePowerLaw(rheo, gw);
    n = eff.n_eff;
    K = eff.K_eff;
    gw = nominal * ((3 * n + 1) / (4 * n));
  }
  const Re = metznerReedReynolds(n, K, { v_ms: v, id_m, rho_kgm3 });
  const ReCrit = criticalReynolds(n);
  let f;
  let regime;
  if (Re < ReCrit) {
    // The definition of Re_MR exists to make this line exact for every n.
    f = 64 / Re;
    regime = 'laminar';
  } else if (Re > 2 * ReCrit) {
    f = dodgeMetznerFactor(n, Re);
    regime = 'turbulent';
  } else {
    // The same honest blend `pipe.js` uses: neither law holds here and the flow itself is not
    // repeatable, so the answer is interpolated and labelled rather than dressed up.
    const t = (Re - ReCrit) / ReCrit;
    f = (64 / ReCrit) * (1 - t) + dodgeMetznerFactor(n, 2 * ReCrit) * t;
    regime = 'critical';
  }
  return {
    ok: true,
    gammaW_s: gw,
    n_eff: n,
    K_eff: K,
    muApparent_Pas: apparentViscosity_Pas(rheo, gw),
    Re,
    ReCrit,
    regime,
    f,
  };
}

/**
 * Head loss along a `pipe.js` run for a non-Newtonian fluid, m of the flowing liquid.
 *
 * Identical in form to `pipe.js`'s `headLoss_m` — the same Darcy-Weisbach line loss plus the same
 * velocity-head fittings — with only the friction factor coming from the generalised correlation.
 * At n = 1 with K = mu the two functions return the same number, which is how a Newtonian fluid
 * is prevented from getting two different answers depending on which module asked.
 *
 * The fitting term uses the ordinary turbulent K factors. They are optimistic in laminar flow,
 * where a fitting's loss is higher than its velocity head suggests, but the standard practice is
 * to use them anyway and the line term dominates on any run long enough to matter.
 *
 * @param {object} rheo a rheology
 * @param {object} pipe a pipe from `pipe.js`
 * @param {number} Q_m3h flow, m3/h
 * @param {number} rho_kgm3 density
 * @returns {number} head loss, m (always positive), or 0 if the state could not be evaluated
 */
export function nonNewtonianHeadLoss_m(rheo, pipe, Q_m3h, rho_kgm3) {
  const v = velocity_ms(pipe, Q_m3h);
  const st = pipeFlowState(rheo, { v_ms: v, id_m: pipe.id_m, rho_kgm3 });
  if (st.ok !== true || !(st.f > 0)) return 0;
  return ((st.f * pipe.length_m) / pipe.id_m + pipe.sumK) * ((v * v) / (2 * G));
}

/**
 * The head that must be applied across a run before a yield fluid moves at all, m.
 *
 * Force balance on the plug: the wall stress has to reach the yield stress over the whole
 * surface, `dp * (pi D^2/4) = tau0 * (pi D L)`, so
 *
 *     dp = 4 * tau0 * L / D          h = dp / (rho * g)
 *
 * It is exact, not correlated, and it is the number that decides whether a line that has been
 * standing over a shutdown can be restarted. It scales with 1/D, so the small-bore lines gel
 * first — which is why they are the ones that get flushed.
 *
 * @param {object} rheo a rheology
 * @param {object} pipe a pipe from `pipe.js`
 * @param {number} rho_kgm3 density
 * @returns {number} the gel-break head, m (zero for a fluid with no yield stress)
 */
export function yieldStartHead_m(rheo, pipe, rho_kgm3) {
  if (!rheo || !(rheo.tau0_Pa > 0)) return 0;
  return (4 * rheo.tau0_Pa * pipe.length_m) / (pipe.id_m * rho_kgm3 * G);
}

// SECTION-MARKER-SOLIDS
