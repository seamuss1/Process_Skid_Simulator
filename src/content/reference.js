/**
 * src/content/reference.js — the reference shelf: the published tuning rules with their
 * assumptions, the engineering tables a pump station is designed and judged against, and a
 * glossary of the terms this simulator puts on a screen.
 *
 * Layer L3 (content): imports `core/util.js` and the process modules whose constants it must not
 * contradict. No DOM, no state, no clock, no randomness — every export here is frozen data or a
 * pure function of its arguments.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A REFERENCE MODULE AT ALL
 *
 * The rig can already identify a process and hand back a tuning. What it could not do was say
 * WHERE the number came from, WHAT was assumed when it was derived, and WHEN the assumption
 * stops holding. That gap is the one that gets loops tuned badly by people who are otherwise
 * being careful: Ziegler-Nichols is applied to a lag-dominant level loop, Cohen-Coon is applied
 * to a process with no measurable dead time and divides by zero in spirit if not in arithmetic,
 * and a Kv is guessed from a pipe size. Every entry below therefore carries three things a bare
 * table does not: its citation, its assumption, and the failure it produces when the assumption
 * is broken.
 *
 * WHAT IS STANDARD AND WHAT IS TYPICAL. Half of what a pump station needs is written down in a
 * standard — ASME B36.10M says what a schedule 40 wall is, ISO 10816-3 says where the vibration
 * zones sit, ASME B16.5 says what a Class 300 flange is rated for at 200 C. The other half is
 * not: nobody has standardised the Kv of a DN100 butterfly valve, the price of electricity, or
 * the roughness of a line that has been in service for ten years. Mixing the two silently is how
 * a number that was somebody's rule of thumb ends up being defended as a code requirement, so
 * EVERY entry here carries a `standing` field that is either 'standard' or 'typical', and the
 * typical ones say what they vary with.
 *
 * WHAT THIS MODULE MUST NOT DO is disagree with the running simulator. Where `process/pipe.js`,
 * `process/pump.js` or `process/valve.js` already define a constant, this module IMPORTS it and
 * annotates it rather than restating it, so the reference and the model can never drift apart.
 * Where `control/autotune.js` already implements a rule, the entry here carries its `autotuneId`
 * and the test file asserts the two produce the same gains to the last digit.
 * ------------------------------------------------------------------------------------------
 */

import { ROUGHNESS_MM, FITTING_K } from '../process/pipe.js';
import { VIB_ZONES } from '../process/pump.js';
import { TRIM } from '../process/valve.js';

/* ============================================================================================
 * CITATIONS
 *
 * Every table row names a key in here. Keeping the citations in one place rather than repeating
 * a string per row is not tidiness: it means a reference can be corrected once, and it makes the
 * unsourced row impossible to hide, because a row with no key does not render an attribution.
 * ============================================================================================ */

/** Where each number in this module comes from. */
export const CITATIONS = Object.freeze({
  ZN42: 'Ziegler, J.G. and Nichols, N.B., "Optimum Settings for Automatic Controllers", '
    + 'Transactions of the ASME, 64, pp. 759-768, 1942.',
  CC53: 'Cohen, G.H. and Coon, G.A., "Theoretical Consideration of Retarded Control", '
    + 'Transactions of the ASME, 75, pp. 827-834, 1953.',
  CHR52: 'Chien, K.L., Hrones, J.A. and Reswick, J.B., "On the Automatic Control of Generalized '
    + 'Passive Systems", Transactions of the ASME, 74, pp. 175-185, 1952.',
  IMC86: 'Rivera, D.E., Morari, M. and Skogestad, S., "Internal Model Control: 4. PID Controller '
    + 'Design", Ind. Eng. Chem. Process Des. Dev., 25(1), pp. 252-265, 1986.',
  SIMC03: 'Skogestad, S., "Simple analytic rules for model reduction and PID controller tuning", '
    + 'Journal of Process Control, 13(4), pp. 291-309, 2003.',
  TL92: 'Tyreus, B.D. and Luyben, W.L., "Tuning PI Controllers for Integrator/Dead Time '
    + 'Processes", Ind. Eng. Chem. Res., 31(11), pp. 2625-2628, 1992.',
  AMIGO06: 'Astrom, K.J. and Hagglund, T., "Advanced PID Control", ISA, 2006, chapter 7 '
    + '(the AMIGO rules; first published in "Revisiting the Ziegler-Nichols step response method '
    + 'for PID control", Journal of Process Control, 14, pp. 635-650, 2004).',
  RELAY84: 'Astrom, K.J. and Hagglund, T., "Automatic Tuning of Simple Regulators with '
    + 'Specifications on Phase and Amplitude Margins", Automatica, 20(5), pp. 645-651, 1984.',
  DAHLIN68: 'Dahlin, E.B., "Designing and Tuning Digital Controllers", Instruments and Control '
    + 'Systems, 41(6), pp. 77-83, 1968 — the origin of the lambda (direct synthesis) form.',
  PESSEN54: 'Pessen, D.W., "A New Look at PID-Controller Tuning", Journal of Basic Engineering, '
    + '76, 1954 — the "some overshoot" and "no overshoot" modifications to Ziegler-Nichols.',
  SEBORG: 'Seborg, D.E., Edgar, T.F., Mellichamp, D.A. and Doyle, F.J., "Process Dynamics and '
    + 'Control", 4th ed., Wiley, 2016 — the standard restatement of the classical rule tables.',
  B36_10M: 'ASME B36.10M, "Welded and Seamless Wrought Steel Pipe" — outside diameters and wall '
    + 'thicknesses for schedules 10 through XXS.',
  B36_19M: 'ASME B36.19M, "Stainless Steel Pipe" — the S schedules (5S, 10S, 40S, 80S).',
  B16_5: 'ASME B16.5, "Pipe Flanges and Flanged Fittings NPS 1/2 through NPS 24" — the '
    + 'pressure-temperature ratings by material group.',
  EN1092: 'EN 1092-1, "Flanges and their joints" — the metric PN designations.',
  CRANE410: 'Crane Co., Technical Paper No. 410, "Flow of Fluids Through Valves, Fittings and '
    + 'Pipe" — resistance coefficients for fittings in fully turbulent flow.',
  MOODY44: 'Moody, L.F., "Friction Factors for Pipe Flow", Transactions of the ASME, 66, '
    + 'pp. 671-684, 1944 — the absolute roughness values in general use.',
  COLEBROOK: 'Colebrook, C.F., "Turbulent Flow in Pipes", Journal of the ICE, 11(4), 1939, and '
    + 'Swamee, P.K. and Jain, A.K., Journal of the Hydraulics Division, 102(5), 1976.',
  ISO10816_3: 'ISO 10816-3:2009, "Mechanical vibration — Evaluation of machine vibration by '
    + 'measurements on non-rotating parts, Part 3: Industrial machines with nominal power above '
    + '15 kW".',
  ISO20816_3: 'ISO 20816-3:2022, the current revision of ISO 10816-3; the zone boundaries for '
    + 'this class of machine are unchanged.',
  IEC60034_30_1: 'IEC 60034-30-1:2014, "Rotating electrical machines — Part 30-1: Efficiency '
    + 'classes of line operated AC motors (IE code)".',
  IEC60034_30_2: 'IEC TS 60034-30-2:2016, the efficiency classes for variable-speed AC motors.',
  IEC60034_2_1: 'IEC 60034-2-1:2014, "Standard methods for determining losses and efficiency '
    + 'from tests" — the method the IE values are measured by.',
  IEC60751: 'IEC 60751:2022, "Industrial platinum resistance thermometers and platinum '
    + 'temperature sensors" — the tolerance classes AA, A, B and C.',
  IEC60584: 'IEC 60584-1:2013, "Thermocouples — Part 1: EMF specifications and tolerances".',
  IEC60770: 'IEC 60770-1:2010, "Transmitters for use in industrial-process control systems — '
    + 'Part 1: Methods for performance evaluation".',
  ISO5167: 'ISO 5167-2:2022, "Measurement of fluid flow by means of pressure differential '
    + 'devices — Part 2: Orifice plates".',
  IEC60534_2_1: 'IEC 60534-2-1:2011, "Industrial-process control valves — Part 2-1: Flow '
    + 'capacity — Sizing equations for fluid flow under installed conditions".',
  IEC60534_8_4: 'IEC 60534-8-4:2015, the hydrodynamic-noise and cavitation-index definitions.',
  ISA75_11: 'ANSI/ISA-75.11.01, "Inherent Flow Characteristic and Rangeability of Control '
    + 'Valves".',
  ISA51_1: 'ANSI/ISA-51.1-1979 (R1993), "Process Instrumentation Terminology" — the definitions '
    + 'of accuracy, span, turndown, hysteresis and repeatability used throughout this glossary.',
  ANSI_HI: 'ANSI/HI 9.6.3, "Rotodynamic Pumps — Guideline for Operating Regions", and ANSI/HI '
    + '9.6.1, "NPSH Margin", Hydraulic Institute.',
  IEA2024: 'International Energy Agency, "Electricity 2024" and the IEA Emissions Factors '
    + 'database — national average grid carbon intensities. Annual averages, not marginal.',
  EIA2024: 'U.S. Energy Information Administration, Electric Power Monthly, average retail price '
    + 'to the industrial sector.',
  EUROSTAT2024: 'Eurostat nrg_pc_205, electricity prices for non-household consumers, band IC.',
  HARRIS89: 'Harris, T.J., "Assessment of Control Loop Performance", Canadian Journal of '
    + 'Chemical Engineering, 67, pp. 856-861, 1989.',
  ISO13709: 'ISO 13709 / API 610, "Centrifugal pumps for petroleum, petrochemical and natural '
    + 'gas industries".',
  RIG: 'This simulator: the value is defined in `src/data/config.js` or a `src/process` module '
    + 'and is reproduced here only so the reference and the model cannot drift apart.',
});

/**
 * Resolve a citation key to its full text.
 * @param {string} key a key of {@link CITATIONS}
 * @returns {string} the citation, or a marker naming the missing key
 */
export function cite(key) {
  return CITATIONS[key] || `[uncited: ${key}]`;
}

/* ============================================================================================
 * THE PUBLISHED TUNING RULES
 *
 * Every rule below turns a two- or three-number description of a process into a Kc, a Ti and a
 * Td. They disagree with each other by more than an order of magnitude on the same process, and
 * that is not a defect in any of them — it is because each was derived against a different
 * definition of "good":
 *
 *   Ziegler-Nichols        quarter-amplitude decay. Fast load rejection, and it rings.
 *   Cohen-Coon             also quarter-amplitude, but derived for dead-time-dominant processes
 *                          where ZN is far too aggressive.
 *   Chien-Hrones-Reswick   an explicit choice of 0% or 20% overshoot, and — uniquely — separate
 *                          tables for setpoint tracking and for load regulation.
 *   IMC / lambda / SIMC    a chosen closed-loop speed, with robustness as the primary object.
 *   Tyreus-Luyben          robustness on integrating and long-dead-time processes.
 *   AMIGO                  a constrained optimisation: maximum load rejection subject to a hard
 *                          sensitivity limit (Ms <= 1.4).
 *
 * UNITS. The rig's controller gain is in output percent per engineering unit, and a FOPDT model's
 * gain K is in engineering units per output percent, so every Kc below is 1/K times something
 * dimensionless and comes out in the controller's units without conversion. Ti and Td are in
 * seconds, in the ISA standard (dependent-gain) form — `control/pid.js` converts to parallel or
 * series form on request, and the SERIES form is the one Ziegler and Nichols actually had in
 * front of them in 1942, which is worth a moment's thought before quoting their numbers to three
 * decimal places.
 * ============================================================================================ */

/** What a tuning rule needs to be evaluated. */
export const RULE_INPUT = Object.freeze({
  /** Ultimate gain and period, from a continuous-cycling or relay test. */
  ULTIMATE: 'ULTIMATE',
  /** A first-order-plus-dead-time model, from a step or sweep test. */
  FOPDT: 'FOPDT',
});

/** What a rule was derived to be good at. */
export const RULE_INTENT = Object.freeze({
  /** Following a setpoint change. Servo response. */
  TRACKING: 'TRACKING',
  /** Rejecting a load change. Regulation, which is what a header loop does all day. */
  REGULATION: 'REGULATION',
  /** Derived without separating the two. */
  BOTH: 'BOTH',
});

/**
 * Guarded division, so a rule that divides by a dead time of zero fails loudly at the entry
 * point rather than returning an Infinity that only shows up as a saturated output later.
 * @param {number} x the value to test
 * @returns {boolean} true when x is a usable positive finite number
 */
function pos(x) {
  return Number.isFinite(x) && x > 0;
}

/**
 * The rule table.
 *
 * Each entry's `gains` is a pure function of an input record `{K, tau, theta, Ku, Tu, lambda_s,
 * tc_s}` — only the fields its `needs` declares are read — and returns `{Kc, Ti, Td}` in the ISA
 * standard form, with `Ti = Infinity` never used: a P-only rule returns `Ti: 0`, which
 * `control/pid.js` reads as "no reset", matching the faceplate.
 *
 * `autotuneId` names the equivalent entry in `control/autotune.js` where one exists. The test
 * file asserts the two agree exactly; if a rule is ever corrected in one place the other fails.
 */
export const TUNING_RULES = Object.freeze([
  // ---------------------------------------------------------------------------------------
  // Ziegler-Nichols, closed loop (the ultimate-sensitivity method)
  // ---------------------------------------------------------------------------------------
  {
    id: 'ZN_CL_P',
    name: 'Ziegler-Nichols closed loop, P',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.ULTIMATE,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'ZN42',
    formula: 'Kc = 0.5 Ku',
    gains: (m) => ({ Kc: 0.5 * m.Ku, Ti: 0, Td: 0 }),
    assumes: [
      'The loop can be driven to a sustained oscillation without harm, or a relay test can stand '
        + 'in for that (Astrom-Hagglund 1984).',
      'Quarter-amplitude decay is an acceptable closed-loop response.',
      'The controller is in the SERIES (interacting) form the 1942 paper was written for; in ISA '
        + 'standard form the PID variants are slightly more aggressive than intended.',
    ],
    useFor: 'A first, deliberately crude number on a loop whose ultimate point you have measured '
      + 'and whose process you have not modelled.',
    avoid: 'Anything where an offset is unacceptable — P-only always leaves one, and on this rig '
      + 'that offset is a header pressure that never reaches setpoint.',
    note: 'The benchmark the rest of the table is compared against, not a recommendation.',
  },
  {
    id: 'ZN_CL_PI',
    name: 'Ziegler-Nichols closed loop, PI',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.ULTIMATE,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'ZN42',
    autotuneId: 'ZN_PI',
    formula: 'Kc = 0.45 Ku, Ti = Tu / 1.2',
    gains: (m) => ({ Kc: 0.45 * m.Ku, Ti: m.Tu / 1.2, Td: 0 }),
    assumes: [
      'Quarter-amplitude decay is acceptable — each overshoot a quarter of the last.',
      'The measurement is clean enough that a gain of 0.45 Ku does not amplify noise into the '
        + 'final element.',
    ],
    useFor: 'Load rejection on a flow or pressure loop where a little ringing costs nothing.',
    avoid: 'A header with staging: the overshoot is large enough to trip a stage-up threshold, '
      + 'which is the whole of lesson eight.',
    note: 'Sensitivity peak Ms typically lands near 2.0, which is outside the 1.2-2.0 band most '
      + 'plant standards will accept.',
  },
  {
    id: 'ZN_CL_PID',
    name: 'Ziegler-Nichols closed loop, PID',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.ULTIMATE,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'ZN42',
    autotuneId: 'ZN_PID',
    formula: 'Kc = 0.6 Ku, Ti = Tu / 2, Td = Tu / 8',
    gains: (m) => ({ Kc: 0.6 * m.Ku, Ti: m.Tu / 2, Td: m.Tu / 8 }),
    assumes: [
      'The measurement can be differentiated — a noisy signal makes Td a noise amplifier.',
      'The derivative acts on the measurement, not on the error, or a setpoint step throws the '
        + 'drive against its limit.',
    ],
    useFor: 'Demonstrating what aggressive looks like, and for temperature loops where the '
      + 'measurement is genuinely smooth.',
    avoid: 'Anything with a noisy transmitter or a slow final element.',
    note: 'The 1942 classic. It is in every textbook because it was first, not because it is best.',
  },
  {
    id: 'ZN_CL_PESSEN',
    name: 'Pessen integral rule',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.ULTIMATE,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'PESSEN54',
    autotuneId: 'PESSEN',
    formula: 'Kc = 0.7 Ku, Ti = 0.4 Tu, Td = 0.15 Tu',
    gains: (m) => ({ Kc: 0.7 * m.Ku, Ti: 0.4 * m.Tu, Td: 0.15 * m.Tu }),
    assumes: ['Integrated error is what is being paid for and overshoot is cheap.'],
    useFor: 'Loops graded on IAE where a transient excursion has no consequence.',
    avoid: 'Any loop feeding a relief valve, a trip, or a staging threshold.',
    note: 'Tighter than Ziegler-Nichols, which is saying something.',
  },
  {
    id: 'ZN_CL_NO_OS',
    name: 'Ziegler-Nichols, no overshoot',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.ULTIMATE,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'PESSEN54',
    autotuneId: 'NO_OS',
    formula: 'Kc = 0.2 Ku, Ti = Tu / 2, Td = Tu / 3',
    gains: (m) => ({ Kc: 0.2 * m.Ku, Ti: m.Tu / 2, Td: m.Tu / 3 }),
    assumes: ['A slow, monotonic approach to setpoint is worth more than a fast one.'],
    useFor: 'When an overshoot would lift a relief valve or stage a pump you did not want.',
    avoid: 'Load rejection: at a fifth of the ultimate gain the loop takes a long time to notice '
      + 'a disturbance at all.',
    note: 'Heavily detuned, and honest about it.',
  },

  // ---------------------------------------------------------------------------------------
  // Ziegler-Nichols, open loop (the process reaction curve)
  // ---------------------------------------------------------------------------------------
  {
    id: 'ZN_OL_P',
    name: 'Ziegler-Nichols open loop, P',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'ZN42',
    formula: 'Kc = tau / (K theta)',
    gains: (m) => ({ Kc: m.tau / (m.K * m.theta), Ti: 0, Td: 0 }),
    assumes: [
      'The open-loop step response is well fitted by a single lag and a dead time.',
      'The process is self-regulating — the reaction curve reaches a new steady state.',
      'Dead time is a meaningful fraction of the response; as theta goes to zero the gain goes '
        + 'to infinity, which is the rule announcing it has left its range of validity.',
    ],
    useFor: 'A sanity check on the gain a lag-dominant loop can carry.',
    avoid: 'Processes with almost no dead time, where it divides by nearly nothing.',
    note: 'The reaction-curve half of the 1942 paper, expressed in FOPDT terms.',
  },
  {
    id: 'ZN_OL_PI',
    name: 'Ziegler-Nichols open loop, PI',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'ZN42',
    formula: 'Kc = 0.9 tau / (K theta), Ti = 3.33 theta',
    gains: (m) => ({ Kc: (0.9 * m.tau) / (m.K * m.theta), Ti: 3.33 * m.theta, Td: 0 }),
    assumes: ['As ZN_OL_P, plus that reset three dead times long is fast enough for the load.'],
    useFor: 'The open-loop counterpart of the ultimate-sensitivity PI rule, when a step test was '
      + 'cheaper to run than a relay test.',
    avoid: 'Lag-dominant processes: with theta/tau below about 0.1 this rule asks for a gain no '
      + 'real final element will carry.',
    note: 'On a well-conditioned process it lands within about 20% of the closed-loop rule, which '
      + 'is a useful check that the identification was honest.',
  },
  {
    id: 'ZN_OL_PID',
    name: 'Ziegler-Nichols open loop, PID',
    family: 'Ziegler-Nichols',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'ZN42',
    formula: 'Kc = 1.2 tau / (K theta), Ti = 2 theta, Td = 0.5 theta',
    gains: (m) => ({
      Kc: (1.2 * m.tau) / (m.K * m.theta), Ti: 2 * m.theta, Td: 0.5 * m.theta,
    }),
    assumes: ['As ZN_OL_PI, plus a measurement clean enough to differentiate.'],
    useFor: 'Dead-time-bearing loops with a quiet measurement.',
    avoid: 'Anything where theta/tau is under about 0.1 or over about 1.',
    note: 'Ti and Td are set purely by the dead time — the lag does not enter them at all, which '
      + 'is the assumption most often quietly violated.',
  },

  // ---------------------------------------------------------------------------------------
  // Cohen-Coon
  // ---------------------------------------------------------------------------------------
  {
    id: 'CC_P',
    name: 'Cohen-Coon P',
    family: 'Cohen-Coon',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'CC53',
    formula: 'Kc = (1/K)(tau/theta)(1 + theta/(3 tau))',
    gains: (m) => ({
      Kc: (1 / m.K) * (m.tau / m.theta) * (1 + m.theta / (3 * m.tau)), Ti: 0, Td: 0,
    }),
    assumes: [
      'A FOPDT process, and quarter-amplitude decay as the target.',
      'Dead time is a substantial share of the response — the rule was derived to correct '
        + 'Ziegler-Nichols on processes with theta/tau above about 0.6, and it is at its best '
        + 'there.',
    ],
    useFor: 'Dead-time-dominant loops where the open-loop ZN rule is too slow.',
    avoid: 'Lag-dominant loops, where Cohen-Coon is markedly more aggressive than ZN and the '
      + 'resulting Ms is often above 2.5.',
    note: 'Frequently misapplied as a general-purpose rule; it is a dead-time correction.',
  },
  {
    id: 'CC_PI',
    name: 'Cohen-Coon PI',
    family: 'Cohen-Coon',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'CC53',
    formula: 'Kc = (1/K)(tau/theta)(0.9 + theta/(12 tau)); '
      + 'Ti = theta (30 + 3 theta/tau) / (9 + 20 theta/tau)',
    gains: (m) => {
      const r = m.theta / m.tau;
      return {
        Kc: (1 / m.K) * (m.tau / m.theta) * (0.9 + r / 12),
        Ti: (m.theta * (30 + 3 * r)) / (9 + 20 * r),
        Td: 0,
      };
    },
    assumes: ['As CC_P.'],
    useFor: 'The workhorse of the Cohen-Coon family, on processes with real transport delay.',
    avoid: 'Noisy loops — the gain is high and there is no filter in the rule.',
    note: 'The reset time depends on theta/tau, which is the refinement over Ziegler-Nichols.',
  },
  {
    id: 'CC_PID',
    name: 'Cohen-Coon PID',
    family: 'Cohen-Coon',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'CC53',
    formula: 'Kc = (1/K)(tau/theta)(4/3 + theta/(4 tau)); '
      + 'Ti = theta (32 + 6 theta/tau)/(13 + 8 theta/tau); Td = 4 theta / (11 + 2 theta/tau)',
    gains: (m) => {
      const r = m.theta / m.tau;
      return {
        Kc: (1 / m.K) * (m.tau / m.theta) * (4 / 3 + r / 4),
        Ti: (m.theta * (32 + 6 * r)) / (13 + 8 * r),
        Td: (4 * m.theta) / (11 + 2 * r),
      };
    },
    assumes: ['As CC_P, plus a differentiable measurement.'],
    useFor: 'Dead-time-dominant temperature and composition loops.',
    avoid: 'Pressure and flow loops on this rig — the measurement noise is larger than the '
      + 'derivative can survive.',
    note: 'The most aggressive rule in the table on a lag-dominant process; check the margins '
      + 'before applying it.',
  },

  // ---------------------------------------------------------------------------------------
  // Chien-Hrones-Reswick — the only classical family with separate servo and regulator tables
  // ---------------------------------------------------------------------------------------
  {
    id: 'CHR_TRACK_0_PI',
    name: 'Chien-Hrones-Reswick PI, tracking, 0% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 0.35 tau / (K theta), Ti = 1.2 tau',
    gains: (m) => ({ Kc: (0.35 * m.tau) / (m.K * m.theta), Ti: 1.2 * m.tau, Td: 0 }),
    assumes: [
      'The disturbance of interest is a setpoint change, not a load change.',
      'A FOPDT process with theta/tau roughly between 0.1 and 1.',
    ],
    useFor: 'A loop whose job is to follow a schedule or a cascade master without overshooting.',
    avoid: 'Load rejection: reset set by the lag rather than the dead time is far too slow to '
      + 'catch a demand step.',
    note: 'CHR is the rule that makes the servo/regulator distinction explicit, and comparing its '
      + 'two halves on the same process is the clearest demonstration that the distinction is '
      + 'real.',
  },
  {
    id: 'CHR_TRACK_20_PI',
    name: 'Chien-Hrones-Reswick PI, tracking, 20% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 0.6 tau / (K theta), Ti = tau',
    gains: (m) => ({ Kc: (0.6 * m.tau) / (m.K * m.theta), Ti: m.tau, Td: 0 }),
    assumes: ['As CHR_TRACK_0_PI, with 20% overshoot accepted in exchange for speed.'],
    useFor: 'Setpoint tracking where arriving quickly matters more than arriving cleanly.',
    avoid: 'Loops feeding a high alarm close to setpoint.',
    note: 'Roughly twice the gain of the 0% variant for a fifth of the settling time.',
  },
  {
    id: 'CHR_TRACK_0_PID',
    name: 'Chien-Hrones-Reswick PID, tracking, 0% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 0.6 tau / (K theta), Ti = tau, Td = 0.5 theta',
    gains: (m) => ({
      Kc: (0.6 * m.tau) / (m.K * m.theta), Ti: m.tau, Td: 0.5 * m.theta,
    }),
    assumes: ['As CHR_TRACK_0_PI, plus a differentiable measurement.'],
    useFor: 'Temperature setpoint ramps.',
    avoid: 'Noisy flow measurements.',
    note: 'Derivative sized from the dead time, integral from the lag — the usual CHR pattern.',
  },
  {
    id: 'CHR_TRACK_20_PID',
    name: 'Chien-Hrones-Reswick PID, tracking, 20% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 0.95 tau / (K theta), Ti = 1.36 tau, Td = 0.47 theta',
    gains: (m) => ({
      Kc: (0.95 * m.tau) / (m.K * m.theta), Ti: 1.36 * m.tau, Td: 0.47 * m.theta,
    }),
    assumes: ['As CHR_TRACK_0_PID, with 20% overshoot accepted.'],
    useFor: 'Fast setpoint tracking on a clean measurement.',
    avoid: 'Anything where the overshoot lands on an interlock.',
    note: 'The fastest tracking rule in the table.',
  },
  {
    id: 'CHR_REG_0_PI',
    name: 'Chien-Hrones-Reswick PI, regulation, 0% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 0.6 tau / (K theta), Ti = 4 theta',
    gains: (m) => ({ Kc: (0.6 * m.tau) / (m.K * m.theta), Ti: 4 * m.theta, Td: 0 }),
    assumes: [
      'The disturbance of interest is a load change entering at the process input.',
      'A FOPDT process with theta/tau roughly between 0.1 and 1.',
    ],
    useFor: 'A header pressure loop, which spends its life rejecting demand changes and almost '
      + 'never sees a setpoint move.',
    avoid: 'Setpoint tracking — reset four dead times long will overshoot a step.',
    note: 'Compare the reset time with the tracking variant: 4 theta against 1.2 tau. On this '
      + 'rig those differ by a factor of five, and that is the whole point of the pair.',
  },
  {
    id: 'CHR_REG_20_PI',
    name: 'Chien-Hrones-Reswick PI, regulation, 20% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 0.7 tau / (K theta), Ti = 2.3 theta',
    gains: (m) => ({ Kc: (0.7 * m.tau) / (m.K * m.theta), Ti: 2.3 * m.theta, Td: 0 }),
    assumes: ['As CHR_REG_0_PI, with 20% overshoot accepted.'],
    useFor: 'Load rejection where recovering quickly matters more than recovering smoothly.',
    avoid: 'Loops where the recovery overshoot stages a pump.',
    note: 'Close to Ziegler-Nichols PI on most processes, and derived from a stated objective '
      + 'rather than from a decay ratio.',
  },
  {
    id: 'CHR_REG_0_PID',
    name: 'Chien-Hrones-Reswick PID, regulation, 0% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 0.95 tau / (K theta), Ti = 2.4 theta, Td = 0.42 theta',
    gains: (m) => ({
      Kc: (0.95 * m.tau) / (m.K * m.theta), Ti: 2.4 * m.theta, Td: 0.42 * m.theta,
    }),
    assumes: ['As CHR_REG_0_PI, plus a differentiable measurement.'],
    useFor: 'Load rejection on a slow, quiet loop.',
    avoid: 'Noisy pressure loops.',
    note: 'Every time constant in this rule is a multiple of the dead time, which is what a '
      + 'regulator rule looks like.',
  },
  {
    id: 'CHR_REG_20_PID',
    name: 'Chien-Hrones-Reswick PID, regulation, 20% overshoot',
    family: 'Chien-Hrones-Reswick',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'CHR52',
    formula: 'Kc = 1.2 tau / (K theta), Ti = 2 theta, Td = 0.42 theta',
    gains: (m) => ({
      Kc: (1.2 * m.tau) / (m.K * m.theta), Ti: 2 * m.theta, Td: 0.42 * m.theta,
    }),
    assumes: ['As CHR_REG_0_PID, with 20% overshoot accepted.'],
    useFor: 'The fastest load rejection in the classical tables.',
    avoid: 'Any loop with a marginal stability margin to begin with.',
    note: 'Numerically almost identical to Ziegler-Nichols open-loop PID, arrived at from a '
      + 'completely different starting point.',
  },

  // ---------------------------------------------------------------------------------------
  // Model-based: IMC, lambda, SIMC
  // ---------------------------------------------------------------------------------------
  {
    id: 'IMC_PI',
    name: 'IMC PI',
    family: 'IMC',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'IMC86',
    formula: 'Kc = tau / (K (lambda + theta)), Ti = tau',
    gains: (m) => {
      const lam = pos(m.lambda_s) ? m.lambda_s : Math.max(m.tau, m.theta);
      return { Kc: m.tau / (m.K * (lam + m.theta)), Ti: m.tau, Td: 0 };
    },
    assumes: [
      'The model is right. IMC cancels the process pole with the integral time, so a 30% error '
        + 'in tau is a 30% error in the cancellation and shows up as a slow tail.',
      'Lambda is at least 0.8 theta — asking for a closed loop faster than the dead time is '
        + 'asking for something the physics does not have.',
    ],
    useFor: 'Any loop where a settling time can be specified rather than argued about.',
    avoid: 'Lag-dominant processes at face value: Ti = tau makes the reset so slow the loop never '
      + 'rejects a load, which is exactly what SIMC caps.',
    note: 'Algebraically identical to lambda tuning; the two names are the same rule reached from '
      + 'internal model control and from direct synthesis respectively.',
  },
  {
    id: 'IMC_PID',
    name: 'IMC PID (first-order Pade)',
    family: 'IMC',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'IMC86',
    formula: 'Kc = (tau + theta/2) / (K (lambda + theta/2)); Ti = tau + theta/2; '
      + 'Td = tau theta / (2 tau + theta)',
    gains: (m) => {
      const lam = pos(m.lambda_s) ? m.lambda_s : Math.max(m.tau, m.theta);
      return {
        Kc: (m.tau + m.theta / 2) / (m.K * (lam + m.theta / 2)),
        Ti: m.tau + m.theta / 2,
        Td: (m.tau * m.theta) / (2 * m.tau + m.theta),
      };
    },
    assumes: [
      'The dead time is approximated by a first-order Pade, which is good to roughly theta/tau '
        + 'below 1 and degrades beyond it.',
      'The measurement can carry derivative action.',
    ],
    useFor: 'A model-based PID when the dead time is real but not dominant.',
    avoid: 'Dead-time-dominant processes, where the Pade approximation is the error.',
    note: 'The derivative term here is not a tuning choice — it is what the Pade approximation '
      + 'leaves behind, which is a good argument for understanding where a Td came from.',
  },
  {
    id: 'LAMBDA_PI',
    name: 'Lambda (direct synthesis) PI',
    family: 'Lambda',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.TRACKING,
    standing: 'standard',
    source: 'DAHLIN68',
    autotuneId: 'LAMBDA_1',
    formula: 'Kc = tau / (K (lambda + theta)), Ti = tau',
    gains: (m) => {
      const lam = pos(m.lambda_s) ? m.lambda_s : Math.max(m.tau, m.theta);
      return { Kc: m.tau / (m.K * (lam + m.theta)), Ti: m.tau, Td: 0 };
    },
    assumes: [
      'Lambda — the closed-loop time constant you are asking for — is between one and three times '
        + 'the dead time. Below the dead time the request is not physically available and the '
        + 'rule hands back a gain that oscillates.',
    ],
    useFor: 'Talking to an operator, because its one knob means "settle in about this long".',
    avoid: 'Using it as a robustness rule without checking Ms: a small lambda is a fast loop and '
      + 'a fragile one, and nothing in the formula warns you.',
    note: 'Implemented in `control/autotune.js` as `lambdaTuning`; the same arithmetic.',
  },
  {
    id: 'SIMC_PI',
    name: 'SIMC PI (Skogestad)',
    family: 'SIMC',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.BOTH,
    standing: 'standard',
    source: 'SIMC03',
    autotuneId: 'SIMC',
    formula: 'Kc = tau / (K (tc + theta)); Ti = min(tau, 4 (tc + theta)); recommended tc = theta',
    gains: (m) => {
      const tc = pos(m.tc_s) ? m.tc_s : m.theta;
      return {
        Kc: m.tau / (m.K * (tc + m.theta)),
        Ti: Math.min(m.tau, 4 * (tc + m.theta)),
        Td: 0,
      };
    },
    assumes: [
      'tc >= theta for robustness; tc = theta is the recommended tight setting and gives roughly '
        + '30 degrees of phase margin and Ms near 1.6 on almost anything.',
      'The half-rule has already been used to reduce a higher-order process to FOPDT.',
    ],
    useFor: 'The sane modern default, and the rule to reach for first on an unfamiliar loop.',
    avoid: 'Nothing much — but note that on an integrating process the SIMC form is different '
      + '(Kc = 1/(K\' (tc + theta)), Ti = 4(tc + theta)) and this entry is the self-regulating one.',
    note: 'The Ti cap at 4(tc + theta) is the part that matters: an uncapped IMC rule sets '
      + 'Ti = tau, and on a lag-dominant process that is a reset so slow the loop never rejects a '
      + 'load at all.',
  },
  {
    id: 'SIMC_PI_SLOW',
    name: 'SIMC PI, tc = 3 theta',
    family: 'SIMC',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.BOTH,
    standing: 'standard',
    source: 'SIMC03',
    autotuneId: 'SIMC_SLOW',
    formula: 'As SIMC_PI with tc = 3 theta',
    gains: (m) => {
      const tc = 3 * m.theta;
      return {
        Kc: m.tau / (m.K * (tc + m.theta)),
        Ti: Math.min(m.tau, 4 * (tc + m.theta)),
        Td: 0,
      };
    },
    assumes: ['As SIMC_PI, asked for a slower closed loop.'],
    useFor: 'A noisy measurement, or a final element that is expensive to move.',
    avoid: 'Loops that must catch a fast disturbance.',
    note: 'The same rule with the knob turned down — which is the advantage of a rule that has a '
      + 'knob at all.',
  },

  // ---------------------------------------------------------------------------------------
  // Tyreus-Luyben
  // ---------------------------------------------------------------------------------------
  {
    id: 'TL_PI',
    name: 'Tyreus-Luyben PI',
    family: 'Tyreus-Luyben',
    needs: RULE_INPUT.ULTIMATE,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'TL92',
    autotuneId: 'TL_PI',
    formula: 'Kc = Ku / 3.2, Ti = 2.2 Tu',
    gains: (m) => ({ Kc: m.Ku / 3.2, Ti: 2.2 * m.Tu, Td: 0 }),
    assumes: [
      'Robustness matters more than speed, and the process may be integrating or have long dead '
        + 'time — which is what the rule was derived for.',
    ],
    useFor: 'The right first choice for a pump header: slow reset keeps the loop from fighting '
      + 'the staging sequence.',
    avoid: 'Loops that are genuinely required to be fast; this one deliberately is not.',
    note: 'Roughly half the gain and nearly three times the reset time of Ziegler-Nichols PI.',
  },
  {
    id: 'TL_PID',
    name: 'Tyreus-Luyben PID',
    family: 'Tyreus-Luyben',
    needs: RULE_INPUT.ULTIMATE,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'TL92',
    autotuneId: 'TL_PID',
    formula: 'Kc = Ku / 2.2, Ti = 2.2 Tu, Td = Tu / 6.3',
    gains: (m) => ({ Kc: m.Ku / 2.2, Ti: 2.2 * m.Tu, Td: m.Tu / 6.3 }),
    assumes: ['As TL_PI, plus a measurement clean enough to differentiate.'],
    useFor: 'A robust loop that still needs some phase lead.',
    avoid: 'Noisy loops; the rate action is small but it is not free.',
    note: 'Worth it only when the measurement is clean enough to differentiate.',
  },

  // ---------------------------------------------------------------------------------------
  // AMIGO
  // ---------------------------------------------------------------------------------------
  {
    id: 'AMIGO_PI',
    name: 'AMIGO PI',
    family: 'AMIGO',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'AMIGO06',
    formula: 'Kc = 0.15/K + (0.35 - theta tau/(theta+tau)^2)(tau/(K theta)); '
      + 'Ti = 0.35 theta + 13 theta tau^2 / (tau^2 + 12 theta tau + 7 theta^2)',
    gains: (m) => {
      const s = m.theta + m.tau;
      const Kc = 0.15 / m.K
        + (0.35 - (m.theta * m.tau) / (s * s)) * (m.tau / (m.K * m.theta));
      const Ti = 0.35 * m.theta
        + (13 * m.theta * m.tau * m.tau)
          / (m.tau * m.tau + 12 * m.theta * m.tau + 7 * m.theta * m.theta);
      return { Kc, Ti, Td: 0 };
    },
    assumes: [
      'The design objective is maximum load rejection subject to a hard robustness constraint of '
        + 'Ms <= 1.4 — the constraint is in the derivation, not in the user\'s judgement.',
      'A FOPDT model, over theta/tau from about 0.1 to 10 — the fit was made over that whole '
        + 'range, which is why it does not blow up at either end the way the classical rules do.',
    ],
    useFor: 'A defensible default when nobody wants to argue about robustness: the margin was '
      + 'fixed before the gains were computed.',
    avoid: 'Situations where you actually need a faster loop than Ms 1.4 permits.',
    note: 'The additive 0.15/K term is what keeps the gain finite as the dead time grows, which '
      + 'is the failure mode of every rule with a bare tau/theta in it.',
  },
  {
    id: 'AMIGO_PID',
    name: 'AMIGO PID',
    family: 'AMIGO',
    needs: RULE_INPUT.FOPDT,
    intent: RULE_INTENT.REGULATION,
    standing: 'standard',
    source: 'AMIGO06',
    formula: 'Kc = (1/K)(0.2 + 0.45 tau/theta); Ti = theta (0.4 theta + 0.8 tau)/(theta + 0.1 tau); '
      + 'Td = 0.5 theta tau / (0.3 theta + tau)',
    gains: (m) => ({
      Kc: (1 / m.K) * (0.2 + (0.45 * m.tau) / m.theta),
      Ti: (m.theta * (0.4 * m.theta + 0.8 * m.tau)) / (m.theta + 0.1 * m.tau),
      Td: (0.5 * m.theta * m.tau) / (0.3 * m.theta + m.tau),
    }),
    assumes: ['As AMIGO_PI, plus a differentiable measurement.'],
    useFor: 'The best-supported general-purpose PID rule in the table.',
    avoid: 'Noisy loops without a derivative filter — AMIGO assumes one is present.',
    note: 'Compare its Kc with Cohen-Coon PID on the same model: AMIGO is markedly gentler, and '
      + 'the difference is the sensitivity constraint doing its job.',
  },
]);

/** Rules by id, for lookup without a linear scan. */
const RULE_INDEX = Object.freeze(Object.fromEntries(TUNING_RULES.map((r) => [r.id, r])));

/**
 * Look a tuning rule up by id.
 * @param {string} id a `TUNING_RULES` id
 * @returns {object|null} the rule, or null
 */
export function ruleById(id) {
  return RULE_INDEX[id] || null;
}

/**
 * The rules that can be evaluated from what has actually been identified.
 * @param {string} needs one of {@link RULE_INPUT}
 * @returns {Array<object>} the applicable rules, in table order
 */
export function rulesFor(needs) {
  return TUNING_RULES.filter((r) => r.needs === needs);
}

/**
 * Evaluate one rule against an identified process.
 *
 * Guarded at the entry point because every failure here is silent otherwise: a Cohen-Coon gain on
 * a process with theta = 0 is Infinity, and an Infinity written into a faceplate becomes a
 * saturated output ten minutes later with nothing to show what caused it.
 *
 * @param {string} id a `TUNING_RULES` id
 * @param {object} model the identified process: `{Ku, Tu}` for an ULTIMATE rule, `{K, tau, theta}`
 *   for a FOPDT one, optionally with `lambda_s` or `tc_s`
 * @returns {{ok:boolean, reason?:string, id?:string, name?:string, Kc?:number, Ti?:number,
 *   Td?:number}} the tuning, or why it could not be produced
 */
export function evaluateRule(id, model) {
  const rule = RULE_INDEX[id];
  if (!rule) return { ok: false, reason: `no tuning rule with id ${id}` };
  if (!model || typeof model !== 'object') return { ok: false, reason: 'no process model given' };

  if (rule.needs === RULE_INPUT.ULTIMATE) {
    if (!pos(model.Ku) || !pos(model.Tu)) {
      return {
        ok: false,
        reason: `${rule.name} needs an ultimate gain and period; run a relay or continuous-cycling `
          + 'test first',
      };
    }
  } else {
    if (!Number.isFinite(model.K) || model.K === 0 || !pos(model.tau)) {
      return {
        ok: false,
        reason: `${rule.name} needs a FOPDT model with a non-zero gain and a positive time `
          + 'constant; run a step or sweep test first',
      };
    }
    // Every FOPDT rule except the IMC/lambda/SIMC family divides by the dead time. Saying so is
    // more useful than returning a gain of 1e12.
    const needsTheta = !['IMC', 'Lambda', 'SIMC'].includes(rule.family);
    if (needsTheta && !pos(model.theta)) {
      return {
        ok: false,
        reason: `${rule.name} divides by the dead time and this model has none; use a lambda, IMC `
          + 'or SIMC rule, which take the closed-loop speed from you instead',
      };
    }
  }

  const g = rule.gains(model);
  if (!Number.isFinite(g.Kc) || !Number.isFinite(g.Ti) || !Number.isFinite(g.Td)) {
    return { ok: false, reason: `${rule.name} produced a non-finite tuning from this model` };
  }
  return { ok: true, id: rule.id, name: rule.name, Kc: g.Kc, Ti: g.Ti, Td: g.Td };
}

/* ============================================================================================
 * PIPE
 *
 * Wall thickness is the whole story: a schedule number is not a size, it is a pressure rating
 * dressed as a size, and the internal diameter — the only number the hydraulics cares about —
 * falls out of it. A DN150 line is 168.3 mm outside whatever schedule it is; inside it is 161.5,
 * 154.1 or 146.4 mm depending on whether it is 10S, 40 or 80, and a system curve computed on the
 * wrong one is out by 15% in velocity head before anything else has gone wrong.
 * ============================================================================================ */

/**
 * Standard wrought steel pipe.
 *
 * `od_mm` and `wall_mm` are the ASME tables. `id_mm` is the published internal diameter, carried
 * separately RATHER than computed, so that the test file can check it against `od - 2*wall` and
 * catch a transcription error — which is the failure this table actually has to defend against.
 * The two agree to about a tenth of a millimetre; the residue is rounding between the inch and
 * metric editions of the standard and is not worth pretending away.
 */
export const PIPE_SCHEDULES = Object.freeze([
  { nps_in: 0.5, dn: 15, od_mm: 21.3, walls: { '10S': 2.11, 40: 2.77, 80: 3.73 }, ids: { '10S': 17.08, 40: 15.80, 80: 13.87 } },
  { nps_in: 0.75, dn: 20, od_mm: 26.7, walls: { '10S': 2.11, 40: 2.87, 80: 3.91 }, ids: { '10S': 22.48, 40: 20.93, 80: 18.85 } },
  { nps_in: 1, dn: 25, od_mm: 33.4, walls: { '10S': 2.77, 40: 3.38, 80: 4.55 }, ids: { '10S': 27.86, 40: 26.64, 80: 24.31 } },
  { nps_in: 1.5, dn: 40, od_mm: 48.3, walls: { '10S': 2.77, 40: 3.68, 80: 5.08 }, ids: { '10S': 42.76, 40: 40.89, 80: 38.10 } },
  { nps_in: 2, dn: 50, od_mm: 60.3, walls: { '10S': 2.77, 40: 3.91, 80: 5.54 }, ids: { '10S': 54.76, 40: 52.50, 80: 49.25 } },
  { nps_in: 3, dn: 80, od_mm: 88.9, walls: { '10S': 3.05, 40: 5.49, 80: 7.62 }, ids: { '10S': 82.80, 40: 77.93, 80: 73.66 } },
  { nps_in: 4, dn: 100, od_mm: 114.3, walls: { '10S': 3.05, 40: 6.02, 80: 8.56 }, ids: { '10S': 108.20, 40: 102.26, 80: 97.18 } },
  { nps_in: 6, dn: 150, od_mm: 168.3, walls: { '10S': 3.40, 40: 7.11, 80: 10.97 }, ids: { '10S': 161.50, 40: 154.05, 80: 146.33 } },
  { nps_in: 8, dn: 200, od_mm: 219.1, walls: { '10S': 3.76, 40: 8.18, 80: 12.70 }, ids: { '10S': 211.58, 40: 202.72, 80: 193.68 } },
  { nps_in: 10, dn: 250, od_mm: 273.0, walls: { '10S': 4.19, 40: 9.27, 80: 15.09 }, ids: { '10S': 264.62, 40: 254.51, 80: 242.87 } },
  { nps_in: 12, dn: 300, od_mm: 323.8, walls: { '10S': 4.57, 40: 10.31, 80: 17.48 }, ids: { '10S': 314.66, 40: 303.23, 80: 288.90 } },
]);

/** What each schedule is, and which standard it lives in. */
export const PIPE_SCHEDULE_NOTES = Object.freeze({
  '10S': {
    standing: 'standard',
    source: 'B36_19M',
    what: 'Thin-wall stainless. The usual choice for a clean process line where the wall is set '
      + 'by handling rather than by pressure.',
  },
  40: {
    standing: 'standard',
    source: 'B36_10M',
    what: 'The general-purpose carbon steel wall, and what "standard weight" means up to NPS 10.',
  },
  80: {
    standing: 'standard',
    source: 'B36_10M',
    what: 'Extra strong. Used where the pressure rating or the corrosion allowance demands it, '
      + 'and where the smaller bore is a cost you have to remember to price in head loss.',
  },
});

/** Pipe rows by DN, for lookup. */
const PIPE_BY_DN = Object.freeze(Object.fromEntries(PIPE_SCHEDULES.map((p) => [p.dn, p])));

/**
 * The internal diameter of a standard pipe.
 * @param {number} dn nominal diameter, e.g. 150
 * @param {string|number} schedule '10S', 40 or 80
 * @returns {{ok:boolean, reason?:string, id_mm?:number, od_mm?:number, wall_mm?:number}} the size
 */
export function pipeBore(dn, schedule) {
  const row = PIPE_BY_DN[dn];
  if (!row) return { ok: false, reason: `no standard pipe at DN${dn} in this table` };
  const id = row.ids[schedule];
  if (id === undefined) {
    return { ok: false, reason: `DN${dn} is not tabulated in schedule ${schedule} here` };
  }
  return { ok: true, id_mm: id, od_mm: row.od_mm, wall_mm: row.walls[schedule] };
}

/**
 * Typical design velocities, for sizing a line rather than analysing one.
 *
 * TYPICAL, not standard — these are the numbers a hydraulic designer starts from and then argues
 * with. The suction figure is the one that matters on this rig: a suction line sized for
 * discharge velocity eats NPSH available at exactly the flow where you have least of it.
 */
export const DESIGN_VELOCITY_MS = Object.freeze({
  standing: 'typical',
  source: 'ANSI_HI',
  pumpSuction: { lo: 0.6, hi: 1.5, why: 'Low enough that friction does not eat the NPSH margin.' },
  pumpDischarge: { lo: 1.5, hi: 3.0, why: 'The economic balance of pipe cost against pumping cost.' },
  headerLongRun: { lo: 1.0, hi: 2.5, why: 'Friction dominates the cost over a long run.' },
  gravityDrain: { lo: 0.3, hi: 1.0, why: 'Set by the available fall, not by economics.' },
  slurryMinimum: { lo: 1.2, hi: 2.0, why: 'Below the deposition velocity the solids drop out.' },
});

/**
 * Absolute roughness by material.
 *
 * The five values the simulator actually uses are IMPORTED from `process/pipe.js` rather than
 * restated, so the reference cannot drift from the model. The rest are the usual Moody figures.
 * All of them are typical: roughness is a property of a specific line's history, and the spread
 * between a new pipe and the same pipe after ten years of service is larger than the spread
 * between materials.
 */
export const ROUGHNESS_REF = Object.freeze([
  {
    id: 'SMOOTH', material: 'Drawn tubing, glass, plastic', eps_mm: ROUGHNESS_MM.SMOOTH,
    standing: 'typical', source: 'MOODY44',
    note: 'Effectively hydraulically smooth; the friction factor depends on Reynolds number alone.',
  },
  {
    id: 'STAINLESS', material: 'Stainless steel, as welded', eps_mm: ROUGHNESS_MM.STAINLESS,
    standing: 'typical', source: 'MOODY44',
    note: 'The rig\'s process lines. Stays near this value in clean service, which is why it was '
      + 'chosen.',
  },
  {
    id: 'STEEL', material: 'New commercial steel', eps_mm: ROUGHNESS_MM.STEEL,
    standing: 'typical', source: 'MOODY44',
    note: 'The default for a process line, and the number every textbook example uses.',
  },
  {
    id: 'GALVANISED', material: 'Galvanised steel', eps_mm: ROUGHNESS_MM.GALVANISED,
    standing: 'typical', source: 'MOODY44',
    note: 'Three times commercial steel, which on a long run is a visible slice of the pump head.',
  },
  {
    id: 'SCALED', material: 'Steel with light scaling', eps_mm: ROUGHNESS_MM.SCALED,
    standing: 'typical', source: 'MOODY44',
    note: 'What an old line actually is. Fouling raises roughness and reduces bore at the same '
      + 'time, and the bore term is usually the bigger of the two.',
  },
  {
    id: 'CAST_IRON', material: 'Cast iron, uncoated', eps_mm: 0.26,
    standing: 'typical', source: 'MOODY44',
    note: 'Common on old water mains; assume worse if the line has ever been out of service wet.',
  },
  {
    id: 'CONCRETE', material: 'Concrete, smooth finish', eps_mm: 0.3,
    standing: 'typical', source: 'MOODY44',
    note: 'Ranges from 0.3 to 3 mm depending entirely on the formwork.',
  },
  {
    id: 'RIVETED', material: 'Riveted steel', eps_mm: 3.0,
    standing: 'typical', source: 'MOODY44',
    note: 'Ranges from 0.9 to 9 mm. Included because it is the top of the Moody chart and shows '
      + 'what "fully rough" means.',
  },
  {
    id: 'HEAVY_SCALE', material: 'Steel, heavily tuberculated', eps_mm: 3.0,
    standing: 'typical', source: 'MOODY44',
    note: 'A line in this condition has usually lost more head to the lost bore than to the '
      + 'roughness; measure it rather than looking it up.',
  },
]);

/**
 * Fitting resistance coefficients, K in `h = K v^2 / 2g`.
 *
 * The twelve the simulator uses are IMPORTED from `process/pipe.js`. The remainder extend the
 * takeoff without changing any value the model already relies on.
 *
 * THE ASSUMPTION EVERY ONE OF THESE CARRIES is fully turbulent flow. Crane's K values are the
 * fully-rough asymptote; at Reynolds numbers below about 10^4 the true K rises, sharply for
 * valves, and a takeoff done on a viscous fluid at low velocity will underestimate the losses.
 */
export const FITTING_K_REF = Object.freeze([
  { id: 'ENTRY_SHARP', what: 'Sharp-edged pipe entrance from a vessel', K: FITTING_K.ENTRY_SHARP, standing: 'standard', source: 'CRANE410' },
  { id: 'ENTRY_BELLMOUTH', what: 'Bellmouth or well-rounded entrance', K: FITTING_K.ENTRY_BELLMOUTH, standing: 'standard', source: 'CRANE410' },
  { id: 'ENTRY_PROJECTING', what: 'Inward-projecting (Borda) entrance', K: 0.78, standing: 'standard', source: 'CRANE410' },
  { id: 'EXIT', what: 'Pipe exit into a vessel — the whole velocity head is lost', K: FITTING_K.EXIT, standing: 'standard', source: 'CRANE410' },
  { id: 'ELBOW_90_LR', what: '90 degree long-radius elbow (R/D = 1.5)', K: FITTING_K.ELBOW_90_LR, standing: 'standard', source: 'CRANE410' },
  { id: 'ELBOW_90_SR', what: '90 degree short-radius elbow (R/D = 1)', K: FITTING_K.ELBOW_90_SR, standing: 'standard', source: 'CRANE410' },
  { id: 'ELBOW_90_MITRE', what: '90 degree mitre bend, unvaned', K: 1.1, standing: 'standard', source: 'CRANE410' },
  { id: 'ELBOW_45', what: '45 degree elbow', K: FITTING_K.ELBOW_45, standing: 'standard', source: 'CRANE410' },
  { id: 'BEND_180', what: '180 degree return bend', K: 0.6, standing: 'standard', source: 'CRANE410' },
  { id: 'TEE_THROUGH', what: 'Tee, flow straight through the run', K: FITTING_K.TEE_THROUGH, standing: 'standard', source: 'CRANE410' },
  { id: 'TEE_BRANCH', what: 'Tee, flow turning into or out of the branch', K: FITTING_K.TEE_BRANCH, standing: 'standard', source: 'CRANE410' },
  { id: 'GATE_OPEN', what: 'Gate valve, fully open', K: FITTING_K.GATE_OPEN, standing: 'standard', source: 'CRANE410' },
  { id: 'GATE_HALF', what: 'Gate valve, half open', K: 5.6, standing: 'typical', source: 'CRANE410' },
  { id: 'GLOBE_OPEN', what: 'Globe valve, fully open', K: 10.0, standing: 'standard', source: 'CRANE410' },
  { id: 'ANGLE_OPEN', what: 'Angle valve, fully open', K: 5.0, standing: 'standard', source: 'CRANE410' },
  { id: 'BALL_FULL_OPEN', what: 'Full-bore ball valve, fully open', K: 0.05, standing: 'standard', source: 'CRANE410' },
  { id: 'BUTTERFLY_OPEN', what: 'Butterfly valve, fully open, DN100-200', K: 0.35, standing: 'typical', source: 'CRANE410' },
  { id: 'PLUG_OPEN', what: 'Plug valve, straightway, fully open', K: 0.4, standing: 'standard', source: 'CRANE410' },
  { id: 'CHECK_SWING', what: 'Swing check valve, fully open', K: FITTING_K.CHECK_SWING, standing: 'standard', source: 'CRANE410' },
  { id: 'CHECK_LIFT', what: 'Lift check valve, fully open', K: 12.0, standing: 'standard', source: 'CRANE410' },
  { id: 'CHECK_DUAL_PLATE', what: 'Dual-plate wafer check valve', K: 1.4, standing: 'typical', source: 'CRANE410' },
  { id: 'FOOT_VALVE', what: 'Foot valve with strainer', K: 15.0, standing: 'typical', source: 'CRANE410' },
  { id: 'STRAINER_CLEAN', what: 'Y-strainer, clean basket', K: FITTING_K.STRAINER_CLEAN, standing: 'typical', source: 'CRANE410' },
  { id: 'STRAINER_DIRTY', what: 'Y-strainer, half blinded', K: 8.0, standing: 'typical', source: 'CRANE410' },
  { id: 'REDUCER', what: 'Gradual reducer, based on the smaller bore', K: FITTING_K.REDUCER, standing: 'typical', source: 'CRANE410' },
  { id: 'EXPANDER', what: 'Gradual expander, based on the smaller bore', K: 0.3, standing: 'typical', source: 'CRANE410' },
  { id: 'SUDDEN_CONTRACTION', what: 'Sudden contraction, large ratio, on the smaller bore', K: 0.5, standing: 'standard', source: 'CRANE410' },
  { id: 'SUDDEN_ENLARGEMENT', what: 'Sudden enlargement, large ratio, on the smaller bore', K: 1.0, standing: 'standard', source: 'CRANE410' },
  { id: 'ORIFICE_BETA_05', what: 'Orifice plate, beta 0.5, permanent loss', K: 6.0, standing: 'typical', source: 'ISO5167' },
  { id: 'FLOW_NOZZLE', what: 'Flow nozzle, permanent loss', K: 2.0, standing: 'typical', source: 'ISO5167' },
]);

/* ============================================================================================
 * MACHINE CONDITION
 * ============================================================================================ */

/**
 * ISO 10816-3 (now ISO 20816-3) vibration evaluation zones, overall velocity in mm/s RMS in the
 * 10-1000 Hz band, measured on the bearing housing.
 *
 * WHAT THE ZONES MEAN, because the letters carry more than the numbers do:
 *   A  newly commissioned machinery.
 *   B  acceptable for unrestricted long-term operation.
 *   C  unsatisfactory for long-term operation; run until there is an opportunity to fix it.
 *   D  severe enough to cause damage.
 *
 * The rig's own limits (`VIB_ZONES` in `process/pump.js`) are the 2.3 / 4.5 / 7.1 row. ISO gives
 * that row for a Group 2 machine on a FLEXIBLE support, and identically for a Group 1 machine on
 * a rigid one — a skid-mounted set on rails is normally evaluated flexible, so the row is the
 * right one for this rig even though the machine is a 15 kW Group 2 pump.
 */
export const VIBRATION_ZONES = Object.freeze([
  {
    id: 'GROUP2_RIGID',
    machine: 'Group 2: medium machines, 15 kW to 300 kW, or motors up to 315 mm shaft height',
    support: 'rigid',
    ab_mms: 1.4, bc_mms: 2.8, cd_mms: 4.5,
    standing: 'standard', source: 'ISO10816_3',
  },
  {
    id: 'GROUP2_FLEXIBLE',
    machine: 'Group 2: medium machines, 15 kW to 300 kW',
    support: 'flexible',
    ab_mms: VIB_ZONES.AB, bc_mms: VIB_ZONES.BC, cd_mms: VIB_ZONES.CD,
    standing: 'standard', source: 'ISO10816_3',
    note: 'The row this simulator ships, via `VIB_ZONES` in `process/pump.js`.',
  },
  {
    id: 'GROUP1_RIGID',
    machine: 'Group 1: large machines, 300 kW to 50 MW, or motors above 315 mm shaft height',
    support: 'rigid',
    ab_mms: 2.3, bc_mms: 4.5, cd_mms: 7.1,
    standing: 'standard', source: 'ISO10816_3',
  },
  {
    id: 'GROUP1_FLEXIBLE',
    machine: 'Group 1: large machines, 300 kW to 50 MW',
    support: 'flexible',
    ab_mms: 3.5, bc_mms: 7.1, cd_mms: 11.0,
    standing: 'standard', source: 'ISO10816_3',
  },
]);

/** Vibration classes by id. */
const VIB_INDEX = Object.freeze(Object.fromEntries(VIBRATION_ZONES.map((z) => [z.id, z])));

/**
 * The ISO evaluation zone for a reading, in a chosen machine class.
 *
 * `process/pump.js` has its own `vibrationZone` for the machine the rig ships; this one exists so
 * a lesson can ask what the SAME reading would mean on a different class of machine, which is the
 * point that gets missed — 5 mm/s is a maintenance ticket on a 15 kW pump and unremarkable on a
 * 2 MW one.
 *
 * @param {number} v_mms overall velocity, mm/s RMS
 * @param {string} [classId='GROUP2_FLEXIBLE'] a `VIBRATION_ZONES` id
 * @returns {{ok:boolean, reason?:string, zone?:string, meaning?:string}} the zone letter
 */
export function isoZone(v_mms, classId = 'GROUP2_FLEXIBLE') {
  const c = VIB_INDEX[classId];
  if (!c) return { ok: false, reason: `no machine class ${classId}` };
  if (!Number.isFinite(v_mms) || v_mms < 0) {
    return { ok: false, reason: 'vibration must be a non-negative velocity in mm/s RMS' };
  }
  const zone = v_mms <= c.ab_mms ? 'A' : v_mms <= c.bc_mms ? 'B' : v_mms <= c.cd_mms ? 'C' : 'D';
  const meaning = {
    A: 'newly commissioned machinery',
    B: 'acceptable for unrestricted long-term operation',
    C: 'unsatisfactory for long-term operation — run it until you can take it off line',
    D: 'severe enough to cause damage',
  }[zone];
  return { ok: true, zone, meaning };
}

/* ============================================================================================
 * INSTRUMENTS
 *
 * An accuracy figure is meaningless without its BASIS, and mixing the bases is how a flow
 * measurement gets believed at 5% of span. "0.5% of rate" on a Coriolis meter at 10% of span is
 * 0.5% of the reading. "0.5% of span" on an orifice plate at 10% of span is 5% of the reading,
 * because the differential is a hundredth of full scale and the square root doubles the relative
 * error. Every row below therefore says what the percentage is a percentage OF.
 * ============================================================================================ */

/** How an accuracy statement is referred. */
export const ACCURACY_BASIS = Object.freeze({
  /** Percent of the calibrated span. Constant in engineering units, worsens as a fraction of a
   * small reading. */
  SPAN: 'SPAN',
  /** Percent of the reading itself. Constant as a fraction, which is what a totaliser needs. */
  RATE: 'RATE',
  /** Percent of the upper range limit, regardless of how the transmitter is spanned. */
  URL: 'URL',
});

/**
 * Instrument accuracy classes.
 *
 * The `accuracy_pct` figures for transmitters are the manufacturers' reference accuracies, which
 * is the number on the datasheet and NOT the number the loop achieves: total probable error adds
 * ambient temperature effect, static pressure effect, drift since calibration, and the primary
 * element's own uncertainty in quadrature, and is routinely two to four times the reference
 * figure. That gap is why a control loop is never better than its measurement and why the first
 * question about a badly performing loop is when the transmitter was last checked.
 */
export const INSTRUMENT_CLASSES = Object.freeze([
  {
    id: 'PT_PREMIUM', device: 'Pressure transmitter, premium', accuracy_pct: 0.04,
    basis: ACCURACY_BASIS.SPAN, standing: 'typical', source: 'IEC60770',
    note: 'Reference accuracy only, and only within a stated turndown — typically 10:1.',
  },
  {
    id: 'PT_STANDARD', device: 'Pressure transmitter, standard', accuracy_pct: 0.075,
    basis: ACCURACY_BASIS.SPAN, standing: 'typical', source: 'IEC60770',
    note: 'The class of the rig\'s PT-101. At 8 bar span this is 6 mbar, which is comparable with '
      + 'the noise band the simulator models.',
  },
  {
    id: 'PT_UTILITY', device: 'Pressure transmitter, utility / gauge-class', accuracy_pct: 0.25,
    basis: ACCURACY_BASIS.SPAN, standing: 'typical', source: 'IEC60770',
    note: 'Adequate for an indication, not for a controlled variable with a tight band.',
  },
  {
    id: 'DP_ORIFICE', device: 'Orifice plate with DP transmitter', accuracy_pct: 1.0,
    basis: ACCURACY_BASIS.RATE, standing: 'standard', source: 'ISO5167',
    note: 'ISO 5167 discharge-coefficient uncertainty is 0.5-0.75% before the transmitter is '
      + 'added; the square-root relationship means the usable turndown is about 3:1.',
  },
  {
    id: 'MAGFLOW', device: 'Electromagnetic flowmeter', accuracy_pct: 0.25,
    basis: ACCURACY_BASIS.RATE, standing: 'typical', source: 'IEC60770',
    note: 'The rig\'s FT-101. Needs a conductive liquid and a full pipe, and reads nothing useful '
      + 'below about 0.3 m/s.',
  },
  {
    id: 'CORIOLIS', device: 'Coriolis mass flowmeter', accuracy_pct: 0.1,
    basis: ACCURACY_BASIS.RATE, standing: 'typical', source: 'IEC60770',
    note: 'The best available, and it measures mass directly so density changes do not corrupt it.',
  },
  {
    id: 'VORTEX', device: 'Vortex shedding flowmeter', accuracy_pct: 0.75,
    basis: ACCURACY_BASIS.RATE, standing: 'typical', source: 'IEC60770',
    note: 'Loses its signal below a Reynolds number of about 20 000, which is a low-flow cutoff '
      + 'in disguise.',
  },
  {
    id: 'TURBINE', device: 'Turbine flowmeter', accuracy_pct: 0.25,
    basis: ACCURACY_BASIS.RATE, standing: 'typical', source: 'IEC60770',
    note: 'Excellent repeatability, and viscosity-sensitive enough that a calibration on water '
      + 'does not transfer to an oil.',
  },
  {
    id: 'ULTRASONIC_CLAMP', device: 'Clamp-on ultrasonic flowmeter', accuracy_pct: 2.0,
    basis: ACCURACY_BASIS.RATE, standing: 'typical', source: 'IEC60770',
    note: 'A survey instrument. Convenient, non-invasive, and not a basis for custody transfer or '
      + 'for a tight control loop.',
  },
  {
    id: 'RTD_AA', device: 'Pt100 RTD, class AA', accuracy_pct: 0, basis: ACCURACY_BASIS.RATE,
    standing: 'standard', source: 'IEC60751',
    tolerance_C: '±(0.10 + 0.0017 |t|)',
    note: 'Valid -50 to +250 C for a wire-wound element. Use `rtdTolerance_C`.',
  },
  {
    id: 'RTD_A', device: 'Pt100 RTD, class A', accuracy_pct: 0, basis: ACCURACY_BASIS.RATE,
    standing: 'standard', source: 'IEC60751',
    tolerance_C: '±(0.15 + 0.0020 |t|)',
    note: 'The usual process class, and what the rig\'s TT-101 would be.',
  },
  {
    id: 'RTD_B', device: 'Pt100 RTD, class B', accuracy_pct: 0, basis: ACCURACY_BASIS.RATE,
    standing: 'standard', source: 'IEC60751',
    tolerance_C: '±(0.30 + 0.0050 |t|)',
    note: 'At 100 C this is ±0.8 C, which is more than most people assume an RTD is capable of.',
  },
  {
    id: 'TC_K1', device: 'Type K thermocouple, class 1', accuracy_pct: 0, basis: ACCURACY_BASIS.RATE,
    standing: 'standard', source: 'IEC60584',
    tolerance_C: '±1.5 C or ±0.004 |t|, whichever is greater',
    note: 'Before the cold-junction compensation and the extension cable add their own errors.',
  },
  {
    id: 'TC_K2', device: 'Type K thermocouple, class 2', accuracy_pct: 0, basis: ACCURACY_BASIS.RATE,
    standing: 'standard', source: 'IEC60584',
    tolerance_C: '±2.5 C or ±0.0075 |t|, whichever is greater',
    note: 'The default unless somebody specified otherwise.',
  },
  {
    id: 'LEVEL_RADAR', device: 'Guided-wave radar level', accuracy_pct: 0, basis: ACCURACY_BASIS.RATE,
    standing: 'typical', source: 'IEC60770',
    tolerance_C: '', absolute_mm: 3,
    note: 'Quoted as an absolute distance error, not a percentage — a rare and honest datasheet '
      + 'habit.',
  },
  {
    id: 'LEVEL_DP', device: 'Level by differential pressure', accuracy_pct: 0.1,
    basis: ACCURACY_BASIS.SPAN, standing: 'typical', source: 'IEC60770',
    note: 'Accurate in pressure and only as accurate in level as the density is known — which on '
      + 'a warming tank it is not.',
  },
  {
    id: 'VIB_ACCEL', device: 'Piezoelectric accelerometer, integrated to velocity',
    accuracy_pct: 5.0, basis: ACCURACY_BASIS.RATE, standing: 'typical', source: 'ISO10816_3',
    note: 'Mounting matters more than the sensor: a magnetic base loses the high-frequency '
      + 'content the bearing faults live in.',
  },
]);

/**
 * IEC 60751 platinum resistance thermometer tolerance.
 * @param {string} cls 'AA', 'A', 'B' or 'C'
 * @param {number} t_C temperature, C
 * @returns {{ok:boolean, reason?:string, tol_C?:number}} the permitted deviation, plus or minus
 */
export function rtdTolerance_C(cls, t_C) {
  const table = { AA: [0.10, 0.0017], A: [0.15, 0.0020], B: [0.30, 0.0050], C: [0.60, 0.0100] };
  const row = table[cls];
  if (!row) return { ok: false, reason: `no IEC 60751 tolerance class ${cls}` };
  if (!Number.isFinite(t_C)) return { ok: false, reason: 'temperature must be a number' };
  return { ok: true, tol_C: row[0] + row[1] * Math.abs(t_C) };
}

/* ============================================================================================
 * MOTORS
 * ============================================================================================ */

/**
 * IEC 60034-30-1 efficiency classes, 4-pole, 50 Hz, in percent.
 *
 * These are MINIMA. A motor sold as IE3 must reach the IE3 value; it usually beats it, and the
 * rig's shipped 15 kW machine at 92.6% sits between the IE3 minimum (92.1%) and the IE4 one
 * (93.3%), which is entirely ordinary and is why quoting a class is not the same as quoting an
 * efficiency.
 *
 * IE5 is defined in IEC TS 60034-30-2 rather than -30-1 and is DERIVED here rather than
 * tabulated: each IE step is defined as roughly a 20% reduction in losses, so IE5 is computed
 * from IE4 on that basis and marked as such.
 */
export const MOTOR_EFFICIENCY = Object.freeze({
  standing: 'standard',
  source: 'IEC60034_30_1',
  basis: '4-pole, 50 Hz, at rated load, measured to IEC 60034-2-1',
  kW: Object.freeze([0.75, 1.1, 1.5, 2.2, 3, 4, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75,
    90, 110, 132, 160, 200, 250, 315]),
  IE1: Object.freeze([72.1, 75.0, 77.2, 79.7, 81.5, 83.1, 84.7, 86.0, 87.6, 88.7, 89.3, 89.9,
    90.7, 91.2, 91.7, 92.1, 92.7, 93.0, 93.3, 93.5, 93.8, 94.0, 94.0, 94.0]),
  IE2: Object.freeze([79.6, 81.4, 82.8, 84.3, 85.5, 86.6, 87.7, 88.7, 89.8, 90.6, 91.2, 91.6,
    92.3, 92.7, 93.1, 93.5, 94.0, 94.2, 94.5, 94.7, 94.9, 95.1, 95.1, 95.1]),
  IE3: Object.freeze([82.5, 84.1, 85.3, 86.7, 87.7, 88.6, 89.6, 90.4, 91.4, 92.1, 92.6, 93.0,
    93.6, 93.9, 94.2, 94.6, 95.0, 95.2, 95.4, 95.6, 95.8, 96.0, 96.0, 96.0]),
  IE4: Object.freeze([85.7, 87.2, 88.2, 89.5, 90.4, 91.1, 91.9, 92.6, 93.3, 93.9, 94.2, 94.5,
    94.9, 95.2, 95.4, 95.7, 96.0, 96.1, 96.3, 96.4, 96.6, 96.7, 96.7, 96.7]),
});

/** What each class is, in the terms a purchase order argues about. */
export const MOTOR_CLASS_NOTES = Object.freeze({
  IE1: { name: 'Standard efficiency', standing: 'standard', source: 'IEC60034_30_1', note: 'No longer placeable on the EU or most other markets for general-purpose duty.' },
  IE2: { name: 'High efficiency', standing: 'standard', source: 'IEC60034_30_1', note: 'The floor for a motor supplied with a VFD in some jurisdictions; otherwise superseded.' },
  IE3: { name: 'Premium efficiency', standing: 'standard', source: 'IEC60034_30_1', note: 'The general minimum for line-fed motors from 0.75 to 1000 kW in the EU. What this rig ships.' },
  IE4: { name: 'Super-premium efficiency', standing: 'standard', source: 'IEC60034_30_1', note: 'Mandatory in the EU for 75-200 kW; usually a synchronous-reluctance or PM machine at small ratings.' },
  IE5: { name: 'Ultra-premium efficiency', standing: 'derived', source: 'IEC60034_30_2', note: 'Defined as roughly 20% lower losses than IE4; the values this module reports for IE5 are computed on that basis, not transcribed from a table.' },
});

/**
 * Rated-load efficiency for a motor of a given class and rating.
 *
 * Interpolates logarithmically in rating, because the efficiency-versus-rating curve is close to
 * a straight line against log(kW) and linear interpolation between 132 and 160 kW is visibly
 * wrong otherwise.
 *
 * @param {string} cls 'IE1', 'IE2', 'IE3', 'IE4' or 'IE5'
 * @param {number} kW rated shaft power
 * @returns {{ok:boolean, reason?:string, eta?:number, derived?:boolean}} efficiency, 0..1
 */
export function motorEfficiency(cls, kW) {
  const derived = cls === 'IE5';
  const key = derived ? 'IE4' : cls;
  const row = MOTOR_EFFICIENCY[key];
  if (!row) return { ok: false, reason: `no IEC 60034-30-1 class ${cls}` };
  if (!pos(kW)) return { ok: false, reason: 'rating must be a positive shaft power in kW' };

  const ks = MOTOR_EFFICIENCY.kW;
  const x = Math.log(Math.min(Math.max(kW, ks[0]), ks[ks.length - 1]));
  let i = 0;
  while (i < ks.length - 2 && Math.log(ks[i + 1]) < x) i += 1;
  const x0 = Math.log(ks[i]);
  const x1 = Math.log(ks[i + 1]);
  const u = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
  let eta = (row[i] + u * (row[i + 1] - row[i])) / 100;
  // IE5 by the standard's own definition of a class step: one fifth of the losses removed.
  if (derived) eta = 1 - 0.8 * (1 - eta);
  return { ok: true, eta, derived };
}

/**
 * Motor efficiency against load, as a multiplier on the rated-load value.
 *
 * TYPICAL, and it has to be: the shape depends on the split between the losses that scale with
 * current squared and the ones that do not, and that split is a design choice. What is general is
 * the SHAPE — peak efficiency near three-quarter load, a gentle droop at full load because the
 * copper losses have grown, and a collapse below about a third of load because the constant iron
 * and windage losses are now a large fraction of a small output.
 *
 * This is the curve that makes the energy case for variable speed on a pump. A throttled pump at
 * 40% flow still draws most of its rated power and the motor is near its best point; a
 * speed-controlled pump at 40% flow draws about a tenth of the power by the affinity laws, and
 * the motor is at 10% load where this curve says it has lost a fifth of its efficiency. The
 * saving is still enormous — but it is smaller than the cube law alone predicts, and the
 * difference is exactly this curve plus the drive's own losses.
 */
export const MOTOR_PART_LOAD = Object.freeze({
  standing: 'typical',
  source: 'IEC60034_2_1',
  load: Object.freeze([0.10, 0.125, 0.25, 0.375, 0.50, 0.625, 0.75, 0.875, 1.00, 1.15]),
  factor: Object.freeze([0.74, 0.80, 0.90, 0.955, 0.980, 0.995, 1.000, 0.999, 0.995, 0.985]),
});

/** Typical VFD efficiency against output, including the rectifier, DC link and inverter. */
export const DRIVE_PART_LOAD = Object.freeze({
  standing: 'typical',
  source: 'IEC60034_30_2',
  load: Object.freeze([0.10, 0.25, 0.50, 0.75, 1.00]),
  eta: Object.freeze([0.90, 0.945, 0.965, 0.972, 0.975]),
  note: 'A drive at 10% load is losing a tenth of what passes through it, which is why sleeping a '
    + 'lag machine beats running two drives at a quarter load each.',
});

/**
 * Linear interpolation on a monotonic x table.
 * @param {ArrayLike<number>} xs ascending x values
 * @param {ArrayLike<number>} ys the matching y values
 * @param {number} x where to evaluate; clamped to the table's ends
 * @returns {number} the interpolated y
 */
function interp(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && xs[i + 1] < x) i += 1;
  const u = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + u * (ys[i + 1] - ys[i]);
}

/**
 * Motor efficiency at a part load.
 * @param {string} cls an efficiency class, 'IE1' to 'IE5'
 * @param {number} kW rated shaft power
 * @param {number} loadFrac shaft power as a fraction of rated
 * @returns {{ok:boolean, reason?:string, eta?:number, etaRated?:number, standing?:string}} the
 *   efficiency at that load, 0..1
 */
export function motorPartLoadEfficiency(cls, kW, loadFrac) {
  const rated = motorEfficiency(cls, kW);
  if (!rated.ok) return rated;
  if (!Number.isFinite(loadFrac) || loadFrac < 0) {
    return { ok: false, reason: 'load fraction must be a non-negative number' };
  }
  const f = interp(MOTOR_PART_LOAD.load, MOTOR_PART_LOAD.factor, loadFrac);
  return { ok: true, eta: rated.eta * f, etaRated: rated.eta, standing: 'typical' };
}

/**
 * VFD efficiency at a part load.
 * @param {number} loadFrac output power as a fraction of rated
 * @returns {{ok:boolean, reason?:string, eta?:number, standing?:string}} drive efficiency, 0..1
 */
export function driveEfficiency(loadFrac) {
  if (!Number.isFinite(loadFrac) || loadFrac < 0) {
    return { ok: false, reason: 'load fraction must be a non-negative number' };
  }
  return {
    ok: true,
    eta: interp(DRIVE_PART_LOAD.load, DRIVE_PART_LOAD.eta, loadFrac),
    standing: 'typical',
  };
}

/* ============================================================================================
 * ENERGY AND CARBON
 * ============================================================================================ */

/**
 * Electricity prices and grid carbon intensity.
 *
 * ALL TYPICAL, and dated. Prices move by a factor of two within a year and carbon intensity moves
 * by an order of magnitude within a day, so these are annual averages for orientation and nothing
 * more — the right number for a business case comes off the site's own bill and the grid
 * operator's own data.
 *
 * THE DISTINCTION THAT MATTERS is average against marginal. The intensities below are annual
 * AVERAGE intensities: total emissions divided by total generation. The carbon actually saved by
 * turning a pump down is the MARGINAL intensity — the emissions of whatever plant is at the top
 * of the merit order at that moment — and on most grids that is a gas turbine at 350-500 g/kWh
 * regardless of how clean the annual average looks. Reporting a saving against the average
 * flatters a project on a clean grid and understates it on a dirty one.
 */
export const ENERGY_REFERENCE = Object.freeze({
  standing: 'typical',
  tariffs: Object.freeze([
    { region: 'This simulator', perkWh: 0.18, currency: '$', source: 'RIG', note: 'Set in `src/data/config.js` as `energy.tariff_perkWh`.' },
    { region: 'United States, industrial', perkWh: 0.081, currency: '$', year: 2024, source: 'EIA2024' },
    { region: 'European Union, band IC industrial', perkWh: 0.19, currency: 'EUR', year: 2024, source: 'EUROSTAT2024' },
    { region: 'United Kingdom, industrial', perkWh: 0.26, currency: 'GBP', year: 2024, source: 'EUROSTAT2024' },
    { region: 'Germany, industrial', perkWh: 0.22, currency: 'EUR', year: 2024, source: 'EUROSTAT2024' },
    { region: 'France, industrial', perkWh: 0.16, currency: 'EUR', year: 2024, source: 'EUROSTAT2024' },
    { region: 'Norway, industrial', perkWh: 0.09, currency: 'EUR', year: 2024, source: 'EUROSTAT2024' },
  ]),
  /** Annual average grid carbon intensity, grams CO2-equivalent per kWh delivered. */
  carbon_gPerkWh: Object.freeze([
    { region: 'World average', value: 480, year: 2023, source: 'IEA2024' },
    { region: 'European Union', value: 245, year: 2023, source: 'IEA2024' },
    { region: 'United States', value: 369, year: 2023, source: 'IEA2024' },
    { region: 'United Kingdom', value: 207, year: 2023, source: 'IEA2024' },
    { region: 'France', value: 56, year: 2023, source: 'IEA2024' },
    { region: 'Norway', value: 30, year: 2023, source: 'IEA2024' },
    { region: 'Germany', value: 381, year: 2023, source: 'IEA2024' },
    { region: 'China', value: 582, year: 2023, source: 'IEA2024' },
    { region: 'India', value: 713, year: 2023, source: 'IEA2024' },
    { region: 'Australia', value: 550, year: 2023, source: 'IEA2024' },
  ]),
  /** A gas-fired marginal plant, for the marginal-intensity argument above. */
  marginal_gPerkWh: Object.freeze({
    value: 400, standing: 'typical', source: 'IEA2024',
    note: 'A CCGT at 50% net efficiency emits about 400 g/kWh; an open-cycle peaker nearer 600.',
  }),
  /** Hours in a year, so an annual cost is one multiplication away. */
  hoursPerYear: 8760,
});

/**
 * Annual running cost and emissions of a continuous electrical load.
 * @param {number} kW average electrical demand
 * @param {number} hours running hours per year
 * @param {number} perkWh electricity price
 * @param {number} [gPerkWh=480] grid carbon intensity, grams CO2e per kWh
 * @returns {{ok:boolean, reason?:string, kWh?:number, cost?:number, tCO2e?:number}} the totals
 */
export function annualEnergy(kW, hours, perkWh, gPerkWh = 480) {
  if (!Number.isFinite(kW) || kW < 0) return { ok: false, reason: 'demand must be non-negative' };
  if (!Number.isFinite(hours) || hours < 0) return { ok: false, reason: 'hours must be non-negative' };
  if (!Number.isFinite(perkWh) || perkWh < 0) return { ok: false, reason: 'price must be non-negative' };
  const kWh = kW * hours;
  return { ok: true, kWh, cost: kWh * perkWh, tCO2e: (kWh * gPerkWh) / 1e6 };
}

/* ============================================================================================
 * VALVES
 * ============================================================================================ */

/**
 * Inherent flow characteristics.
 *
 * INHERENT is what the trim does on a constant pressure drop, which is the only condition under
 * which the curve in the catalogue is the curve you get. INSTALLED is what happens on a real
 * system, where opening the valve raises the flow, which raises the friction, which takes the
 * differential away from the valve. The ratio between the valve's drop at full flow and the
 * system's total drop is the valve AUTHORITY, and it is what turns an equal-percentage inherent
 * characteristic into a roughly linear installed one — which is the entire reason
 * equal-percentage trim exists.
 *
 * The three the simulator implements are IMPORTED from `process/valve.js` so the ids cannot
 * drift; the fourth is listed because it is common and the rig does not model it.
 */
export const VALVE_CHARACTERISTICS = Object.freeze([
  {
    id: TRIM.LINEAR,
    name: 'Linear',
    formula: 'Kv/Kv_max = x',
    standing: 'standard',
    source: 'ISA75_11',
    useFor: 'Systems where the valve takes most of the total pressure drop — authority above '
      + 'about 0.5 — so the inherent and installed curves are nearly the same.',
    avoid: 'Low-authority service, where a linear valve installs as quick-opening and the loop '
      + 'gain triples between 20% and 80% open.',
  },
  {
    id: TRIM.EQUAL_PCT,
    name: 'Equal percentage',
    formula: 'Kv/Kv_max = R^(x-1), with R the rangeability, typically 30 or 50',
    standing: 'standard',
    source: 'ISA75_11',
    useFor: 'The default for throttling on a friction-dominated system: its rising inherent curve '
      + 'cancels the falling available differential and the installed characteristic comes out '
      + 'close to linear.',
    avoid: 'High-authority service, where it installs as it is drawn and the loop gain then varies '
      + 'by the full rangeability across the travel.',
    note: 'The name means what it says: equal increments of travel give equal PERCENTAGE changes '
      + 'in flow, so the gain is proportional to the flow.',
  },
  {
    id: TRIM.QUICK,
    name: 'Quick opening',
    formula: 'Kv/Kv_max = sqrt(x) in this simulator; catalogue curves vary',
    standing: 'typical',
    source: 'ISA75_11',
    useFor: 'On-off and relief service, where most of the capacity is wanted in the first third '
      + 'of travel.',
    avoid: 'Throttling of any kind — the gain near the seat is enormous and near the top is zero.',
  },
  {
    id: 'MODIFIED_PARABOLIC',
    name: 'Modified parabolic',
    formula: 'Between linear and equal percentage; vendor-specific',
    standing: 'typical',
    source: 'ISA75_11',
    useFor: 'A compromise where the authority varies over the operating range. Not modelled here.',
    avoid: 'Any calculation that needs a closed form, because there is not one.',
  },
]);

/**
 * Typical rated Kv by valve type and size, m3/h of water at 1 bar differential, fully open.
 *
 * TYPICAL and nothing more. Kv is a property of a specific trim from a specific vendor and varies
 * by a factor of two between a reduced-trim and a full-bore version of the same nominal size. Use
 * these to sanity-check a number, never to size a valve.
 *
 * The relationship to the American coefficient is exact: Cv = Kv / 0.865, because Cv is US gallons
 * per minute at 1 psi and Kv is m3/h at 1 bar.
 */
export const TYPICAL_KV = Object.freeze({
  standing: 'typical',
  source: 'IEC60534_2_1',
  dn: Object.freeze([25, 40, 50, 80, 100, 150, 200, 250, 300]),
  globe: Object.freeze([16, 40, 63, 160, 250, 550, 1000, 1600, 2300]),
  butterfly: Object.freeze([28, 70, 110, 300, 550, 1400, 2600, 4300, 6500]),
  ballSegmented: Object.freeze([45, 110, 190, 450, 800, 1900, 3400, 5400, 7800]),
  gate: Object.freeze([90, 230, 380, 950, 1700, 4000, 7300, 11500, 16500]),
});

/** Kv to Cv, exactly. */
export const KV_TO_CV = 1 / 0.865;

/**
 * Convert a Kv to the US Cv.
 * @param {number} kv flow coefficient, m3/h at 1 bar
 * @returns {number} Cv, US gpm at 1 psi
 */
export function kvToCv(kv) {
  return kv * KV_TO_CV;
}

/**
 * Convert a US Cv to Kv.
 * @param {number} cv flow coefficient, US gpm at 1 psi
 * @returns {number} Kv, m3/h at 1 bar
 */
export function cvToKv(cv) {
  return cv * 0.865;
}

/**
 * Valve authority: the share of the total system pressure drop that the valve takes when it is
 * fully open and passing design flow.
 *
 * Below about 0.25 the installed characteristic is so distorted that the loop gain varies by more
 * than the tuning can follow, and the answer is a smaller valve rather than a cleverer controller.
 *
 * @param {number} dpValve_bar pressure drop across the fully open valve at design flow
 * @param {number} dpSystem_bar total system drop at design flow, valve included
 * @returns {{ok:boolean, reason?:string, authority?:number, verdict?:string}} the authority
 */
export function valveAuthority(dpValve_bar, dpSystem_bar) {
  if (!pos(dpSystem_bar)) return { ok: false, reason: 'system drop must be positive' };
  if (!Number.isFinite(dpValve_bar) || dpValve_bar < 0) {
    return { ok: false, reason: 'valve drop must be non-negative' };
  }
  const a = dpValve_bar / dpSystem_bar;
  const verdict = a >= 0.5 ? 'high — inherent and installed characteristics are nearly the same'
    : a >= 0.25 ? 'usual — equal-percentage trim will install close to linear'
      : 'low — the valve does most of its work in the first quarter of travel; size it down';
  return { ok: true, authority: a, verdict };
}

/* ============================================================================================
 * FLANGES AND PRESSURE CLASSES
 * ============================================================================================ */

/**
 * ASME B16.5 pressure-temperature ratings, bar gauge.
 *
 * A pressure class is NOT a pressure. A Class 150 flange in carbon steel is good for 19.6 bar at
 * 38 C and 6.5 bar at 400 C, and the number 150 refers to neither; it is a historical label. The
 * whole point of the table is that the rating falls with temperature, and the failure it prevents
 * is a hydrotest passed cold on a system that is not rated hot.
 *
 * Material group 1.1 is the ordinary carbon steel case (ASTM A105 forgings, A216 WCB castings).
 * Group 2.2 is austenitic stainless (316/316L), which starts slightly lower and falls far more
 * gently — at 400 C it is nearly twice the carbon steel rating.
 */
export const PRESSURE_CLASSES = Object.freeze({
  standing: 'standard',
  source: 'B16_5',
  temps_C: Object.freeze([38, 100, 200, 300, 400]),
  groups: Object.freeze({
    '1.1': {
      material: 'Carbon steel — A105 forgings, A216 WCB castings, A106 B pipe',
      ratings_bar: Object.freeze({
        150: Object.freeze([19.6, 17.7, 13.8, 10.2, 6.5]),
        300: Object.freeze([51.1, 46.6, 45.1, 42.2, 34.7]),
        400: Object.freeze([68.1, 62.1, 60.1, 56.3, 46.3]),
        600: Object.freeze([102.1, 93.2, 90.2, 84.4, 69.4]),
        900: Object.freeze([153.2, 139.8, 135.2, 126.6, 104.2]),
        1500: Object.freeze([255.3, 233.0, 225.4, 211.0, 173.6]),
        2500: Object.freeze([425.5, 388.3, 375.6, 351.6, 289.3]),
      }),
    },
    2.2: {
      material: 'Austenitic stainless — 316 / 316L',
      ratings_bar: Object.freeze({
        150: Object.freeze([19.0, 16.5, 14.2, 12.8, 11.9]),
        300: Object.freeze([49.6, 42.9, 37.0, 33.3, 31.0]),
        600: Object.freeze([99.3, 85.7, 74.0, 66.8, 62.0]),
        900: Object.freeze([148.9, 128.6, 111.0, 100.1, 93.0]),
        1500: Object.freeze([248.2, 214.4, 185.0, 166.9, 155.1]),
      }),
    },
  }),
  /** The EN 1092-1 metric designations, for orientation only — they are not interchangeable. */
  pnEquivalents: Object.freeze([
    { pn: 10, roughly: 'below Class 150', source: 'EN1092' },
    { pn: 16, roughly: 'close to Class 150 at ambient', source: 'EN1092' },
    { pn: 25, roughly: 'between Class 150 and 300', source: 'EN1092' },
    { pn: 40, roughly: 'close to Class 300 at ambient', source: 'EN1092' },
    { pn: 63, roughly: 'between Class 300 and 600', source: 'EN1092' },
    { pn: 100, roughly: 'close to Class 600 at ambient', source: 'EN1092' },
  ]),
});

/**
 * The allowable working pressure of a flanged joint at a temperature.
 *
 * Interpolates linearly between the tabulated temperatures, which is what B16.5 itself permits.
 * Extrapolation is refused rather than guessed: a rating outside the table is a materials
 * question, not an arithmetic one.
 *
 * @param {string} group material group, '1.1' or '2.2'
 * @param {number|string} cls pressure class, e.g. 300
 * @param {number} t_C temperature, C
 * @returns {{ok:boolean, reason?:string, bar?:number}} the rating, bar gauge
 */
export function pressureRating_bar(group, cls, t_C) {
  const g = PRESSURE_CLASSES.groups[group];
  if (!g) return { ok: false, reason: `no B16.5 material group ${group} in this table` };
  const row = g.ratings_bar[cls];
  if (!row) return { ok: false, reason: `no Class ${cls} tabulated for group ${group} here` };
  const ts = PRESSURE_CLASSES.temps_C;
  if (!Number.isFinite(t_C) || t_C < ts[0] || t_C > ts[ts.length - 1]) {
    return {
      ok: false,
      reason: `this table covers ${ts[0]} to ${ts[ts.length - 1]} C; outside it the rating is a `
        + 'materials question rather than an interpolation',
    };
  }
  return { ok: true, bar: interp(ts, row, t_C) };
}

/* ============================================================================================
 * GLOSSARY
 *
 * One sentence each, and the sentence has to be one an operator would accept — which rules out
 * both the circular definition ("cavitation is when a pump cavitates") and the derivation. Where
 * a term has a precise standard definition and a looser plant usage, the plant usage wins and the
 * standard is named.
 * ============================================================================================ */

/**
 * Every term this simulator puts on a screen or in a lesson, defined once.
 * @type {ReadonlyArray<{term:string, def:string, area:string}>}
 */
export const GLOSSARY = Object.freeze([
  // --- The loop -------------------------------------------------------------------------
  { term: 'Process variable (PV)', area: 'loop', def: 'The measurement the controller is trying to hold at a value — on this rig, the header pressure.' },
  { term: 'Setpoint (SP)', area: 'loop', def: 'The value the process variable is supposed to have.' },
  { term: 'Controller output (CO)', area: 'loop', def: 'What the controller sends to the final element, in percent of its range.' },
  { term: 'Error', area: 'loop', def: 'Setpoint minus process variable, in engineering units, and the only thing a PID controller actually acts on.' },
  { term: 'Manual mode', area: 'loop', def: 'The operator owns the output and the algorithm is doing nothing but watching.' },
  { term: 'Automatic mode', area: 'loop', def: 'The algorithm owns the output and moves it to close the error.' },
  { term: 'Cascade mode', area: 'loop', def: 'An outer controller owns this controller\'s setpoint instead of an operator.' },
  { term: 'Bumpless transfer', area: 'loop', def: 'Switching between modes without the output jumping, achieved by making the idle algorithm track whatever the active one is doing.' },
  { term: 'Reverse acting', area: 'loop', def: 'The controller raises its output when the measurement falls below setpoint — the correct sense for a pump or a heater.' },
  { term: 'Direct acting', area: 'loop', def: 'The controller raises its output when the measurement rises above setpoint — the correct sense for a cooler or a let-down valve.' },
  { term: 'Proportional gain (Kc)', area: 'loop', def: 'How much output the controller moves per unit of error, and the term that does most of the work in most loops.' },
  { term: 'Proportional band', area: 'loop', def: 'The same setting expressed as the percentage of measurement span that drives the output across its full range, equal to 100 divided by the gain.' },
  { term: 'Integral time (Ti)', area: 'loop', def: 'Reset time: the time in which integral action repeats the proportional action, so a shorter Ti is faster reset.' },
  { term: 'Reset rate', area: 'loop', def: 'The reciprocal of integral time, in repeats per minute, which is how many older controllers were labelled.' },
  { term: 'Derivative time (Td)', area: 'loop', def: 'Rate time: how far ahead the controller extrapolates the measurement\'s trend, which adds phase lead and amplifies noise in the same breath.' },
  { term: 'Offset', area: 'loop', def: 'The steady error a proportional-only controller must keep in order to hold any output other than its bias.' },
  { term: 'Integral windup', area: 'loop', def: 'The integral term continuing to accumulate while the output is already at a limit, so the controller cannot respond until the excess has been unwound.' },
  { term: 'Anti-windup', area: 'loop', def: 'Any scheme that stops the integral accumulating once the output has saturated, usually by back-calculating from the limited output.' },
  { term: 'Derivative kick', area: 'loop', def: 'The output spike produced when derivative acts on error and the setpoint is stepped, cured by taking the derivative of the measurement instead.' },
  { term: 'Proportional kick', area: 'loop', def: 'The smaller output step a setpoint change produces through the proportional term, removed by setpoint weighting.' },
  { term: 'Setpoint weighting', area: 'loop', def: 'Feeding only a fraction of the setpoint into the proportional term, so tracking can be softened without detuning the regulation.' },
  { term: 'ISA standard form', area: 'loop', def: 'The PID arrangement in which the gain multiplies all three terms and Ti and Td are times — the form this simulator computes in.' },
  { term: 'Parallel form', area: 'loop', def: 'The PID arrangement with three independent gains Kp, Ki and Kd, where changing the gain does not change the integral or derivative action.' },
  { term: 'Series form', area: 'loop', def: 'The interacting arrangement of the classical pneumatic controller, in which the derivative section feeds the proportional-integral section.' },
  { term: 'Positional algorithm', area: 'loop', def: 'A controller that computes the output from an explicit integral state each scan.' },
  { term: 'Velocity algorithm', area: 'loop', def: 'A controller that computes the CHANGE in output each scan and lets the final element be its own integrator, which makes windup structurally impossible.' },
  { term: 'Scan time', area: 'loop', def: 'How often the controller executes, which adds an average of half a scan of dead time to the loop.' },
  { term: 'Deadband', area: 'loop', def: 'A region of error inside which the controller does not act, used to stop a loop chasing noise at the cost of a permanent uncertainty.' },
  { term: 'Output limits', area: 'loop', def: 'The high and low bounds on the controller output, which exist to protect the final element and which are where windup begins.' },
  { term: 'Output rate limit', area: 'loop', def: 'A cap on how fast the output may move, used to protect a machine from a step the controller would otherwise ask for.' },
  { term: 'Tracking', area: 'loop', def: 'Forcing an inactive controller\'s internal state to follow the active output so that a transfer into automatic is bumpless.' },
  { term: 'Servo response', area: 'loop', def: 'How the loop behaves when the setpoint moves.' },
  { term: 'Regulatory response', area: 'loop', def: 'How the loop behaves when a load disturbance moves the process, which on a real plant is nearly all of the time.' },
  { term: 'Load disturbance', area: 'loop', def: 'Anything that moves the process variable that is not the controller output — on this rig, the demand valve.' },
  { term: 'Overshoot', area: 'loop', def: 'How far past setpoint the measurement goes on the way to settling, as a percentage of the change asked for.' },
  { term: 'Settling time', area: 'loop', def: 'How long the measurement takes to enter and stay inside a stated band around setpoint.' },
  { term: 'Rise time', area: 'loop', def: 'How long the measurement takes to cover most of the distance to a new setpoint, usually 10% to 90%.' },
  { term: 'Decay ratio', area: 'loop', def: 'The ratio of one overshoot peak to the previous one, the classical target being one quarter.' },
  { term: 'Quarter-amplitude damping', area: 'loop', def: 'A closed-loop response in which each oscillation is a quarter the size of the one before, which Ziegler and Nichols chose as their design target in 1942.' },
  { term: 'IAE', area: 'loop', def: 'Integral of absolute error: the headline single number for how wrong a loop was over a test, penalising a long small error as much as a brief large one.' },
  { term: 'ITAE', area: 'loop', def: 'Integral of time-weighted absolute error: the same measure with late error weighted more heavily, which punishes a slow tail.' },
  { term: 'ISE', area: 'loop', def: 'Integral of squared error, which weights large excursions far more heavily than small ones and so tolerates a long tail.' },
  { term: 'CO travel', area: 'loop', def: 'The total distance the controller output moved over a test, which is the wear the final element actually suffers.' },
  { term: 'Loop gain', area: 'loop', def: 'The product of the gains all the way round the loop — transmitter, controller, drive, pump and process — and the quantity stability actually depends on.' },
  { term: 'Split range', area: 'loop', def: 'One controller output driving two final elements over different parts of its range.' },
  { term: 'Override control', area: 'loop', def: 'A selector that lets a constraint controller take the output away from the normal one whenever the constraint is closer to being violated.' },
  { term: 'Selector', area: 'loop', def: 'The high or low pick between two controller outputs that implements an override.' },
  { term: 'Cascade control', area: 'loop', def: 'A structure in which a slow outer loop sets the setpoint of a fast inner one, so the inner loop absorbs its own disturbances before the outer one has to notice.' },
  { term: 'Primary (master) loop', area: 'loop', def: 'The outer controller in a cascade, which owns the variable you actually care about.' },
  { term: 'Secondary (slave) loop', area: 'loop', def: 'The inner controller in a cascade, which must be at least three times faster than the outer one or the structure does more harm than good.' },
  { term: 'Feedforward', area: 'loop', def: 'Acting on a measured disturbance before it has affected the process, instead of waiting for the error it will cause.' },
  { term: 'Feedforward trim', area: 'loop', def: 'The feedback controller left in place to correct whatever the feedforward model got wrong, which is always something.' },
  { term: 'Gain scheduling', area: 'loop', def: 'Changing the tuning as a function of some measured operating condition, because the process gain is not the same everywhere.' },
  { term: 'Setpoint ramp', area: 'loop', def: 'Moving the setpoint at a limited rate rather than stepping it, so the loop is never asked for more than the plant can give.' },
  { term: 'Setpoint reset schedule', area: 'loop', def: 'Letting the setpoint float with a measured demand instead of holding it fixed, which on a pump header is where most of the energy saving is.' },
  { term: 'Smith predictor', area: 'loop', def: 'A structure that uses a process model to give the controller an estimate of what the process is doing now rather than what it did a dead time ago.' },

  // --- Identification and tuning --------------------------------------------------------
  { term: 'Process gain (K)', area: 'tuning', def: 'How far the measurement moves in the steady state per unit of output, in engineering units per percent.' },
  { term: 'Process time constant (tau)', area: 'tuning', def: 'How long the process takes to complete 63.2% of its response to a step, once it has started moving.' },
  { term: 'Dead time (theta)', area: 'tuning', def: 'The delay between the output moving and the measurement beginning to respond, during which no amount of control can do anything.' },
  { term: 'FOPDT model', area: 'tuning', def: 'A first-order-plus-dead-time description of a process by three numbers — gain, time constant and dead time — which is enough for every model-based tuning rule.' },
  { term: 'Controllability ratio', area: 'tuning', def: 'Dead time divided by time constant, the single number that says how hard a loop is: below 0.1 it is easy, above 1 no amount of gain will help.' },
  { term: 'Lag-dominant process', area: 'tuning', def: 'A process whose response is mostly time constant and hardly any dead time, which will carry a large controller gain.' },
  { term: 'Dead-time-dominant process', area: 'tuning', def: 'A process whose response is mostly delay, where the only real remedies are a better measurement, a shorter transport path, or a Smith predictor.' },
  { term: 'Self-regulating process', area: 'tuning', def: 'A process that reaches a new steady state on its own after a step in output, like a pressure header.' },
  { term: 'Integrating process', area: 'tuning', def: 'A process whose measurement ramps rather than settling after a step in output, like a tank level.' },
  { term: 'Open-loop step test', area: 'tuning', def: 'Putting the controller in manual, waiting for everything to stop moving, bumping the output once, and reading the gain, time constant and dead time off the response.' },
  { term: 'Process reaction curve', area: 'tuning', def: 'The recorded response to that step, and the object every open-loop tuning rule is a formula for.' },
  { term: 'Two-point method', area: 'tuning', def: 'Fitting a FOPDT model from the times at which the response reaches 28.3% and 63.2% of its total change.' },
  { term: 'Continuous cycling test', area: 'tuning', def: 'Raising the proportional gain of a live loop until it oscillates steadily, which finds the ultimate gain and period and has no upper bound on how badly it can go.' },
  { term: 'Ultimate gain (Ku)', area: 'tuning', def: 'The proportional gain at which the loop oscillates with constant amplitude — the edge of stability.' },
  { term: 'Ultimate period (Tu)', area: 'tuning', def: 'The period of that oscillation, which sets every time constant in the closed-loop tuning rules.' },
  { term: 'Relay feedback test', area: 'tuning', def: 'Replacing the controller with an on-off relay to force a bounded limit cycle at the frequency where the process lags by 180 degrees, giving Ku and Tu without the risk of the cycling test.' },
  { term: 'Describing function', area: 'tuning', def: 'The approximation that lets a relay\'s square wave be treated as its fundamental sine, which is what makes Ku = 4d/(pi a) work.' },
  { term: 'Relay hysteresis', area: 'tuning', def: 'A deadband on the relay\'s switching so it does not chatter on a noisy measurement, at the cost of a correction term in the gain estimate.' },
  { term: 'Frequency sweep test', area: 'tuning', def: 'Driving the output sinusoidally at a series of frequencies and measuring the amplitude and phase of what comes back, which gives the whole frequency response rather than one point of it.' },
  { term: 'Tuning rule', area: 'tuning', def: 'A published formula turning an identified process into controller settings, each one derived against a particular idea of what a good response is.' },
  { term: 'Ziegler-Nichols', area: 'tuning', def: 'The 1942 rules, in an open-loop and a closed-loop form, both aimed at quarter-amplitude decay for load rejection.' },
  { term: 'Cohen-Coon', area: 'tuning', def: 'A 1953 correction to Ziegler-Nichols for processes where the dead time is a large share of the response.' },
  { term: 'Chien-Hrones-Reswick', area: 'tuning', def: 'A 1952 set of rules that is unusual in giving separate tables for setpoint tracking and for load regulation, and in letting you choose 0% or 20% overshoot.' },
  { term: 'IMC tuning', area: 'tuning', def: 'Internal Model Control: derive the controller by inverting the process model and filtering the result at a chosen closed-loop speed.' },
  { term: 'Lambda tuning', area: 'tuning', def: 'The same arithmetic as IMC, presented with the closed-loop time constant as the single operator-facing knob.' },
  { term: 'SIMC tuning', area: 'tuning', def: 'Skogestad\'s refinement of IMC, whose capped integral time fixes the one place lambda tuning reliably fails.' },
  { term: 'Half rule', area: 'tuning', def: 'Skogestad\'s method for reducing a higher-order process to FOPDT by giving half the largest neglected lag to the time constant and half to the dead time.' },
  { term: 'Tyreus-Luyben', area: 'tuning', def: 'A deliberately conservative closed-loop rule, derived for integrating and long-dead-time processes, and the sane default on a pump header.' },
  { term: 'AMIGO', area: 'tuning', def: 'Astrom and Hagglund\'s rules, fitted by optimising load rejection subject to a hard robustness constraint of Ms no worse than 1.4.' },
  { term: 'Pessen rules', area: 'tuning', def: 'Two modifications to Ziegler-Nichols, one tighter for integrated error and one heavily detuned for no overshoot.' },
  { term: 'Detuning', area: 'tuning', def: 'Deliberately reducing gain or slowing reset to buy robustness, which is the correct response to a process whose gain you know varies.' },
  { term: 'Robustness', area: 'tuning', def: 'How much the process can change before the loop that was tuned for it becomes unstable.' },
  { term: 'Autotuner', area: 'tuning', def: 'Any automatic sequence that identifies the process and applies a rule, which is only ever as good as the experiment it ran.' },

  // --- Frequency domain -----------------------------------------------------------------
  { term: 'Bode plot', area: 'frequency', def: 'Amplitude ratio and phase against frequency on log axes, which is where stability margins are read off directly.' },
  { term: 'Nyquist plot', area: 'frequency', def: 'The same information drawn as a curve in the complex plane, where stability is a question of how close the curve comes to the point at minus one.' },
  { term: 'Gain margin', area: 'frequency', def: 'How much more gain the loop could take before it oscillates, quoted in decibels or as a multiplier, with 6 dB a usual minimum.' },
  { term: 'Phase margin', area: 'frequency', def: 'How much more phase lag the loop could take before it oscillates, with 30 to 60 degrees the usual range.' },
  { term: 'Crossover frequency', area: 'frequency', def: 'The frequency at which the open-loop amplitude ratio passes through one, which sets how fast the closed loop can be.' },
  { term: 'Sensitivity function', area: 'frequency', def: 'How much of a disturbance at each frequency survives into the measurement, and the honest measure of what feedback is buying.' },
  { term: 'Maximum sensitivity (Ms)', area: 'frequency', def: 'The peak of that function: the single best robustness number, where 1.2 to 2.0 is the range plant loops live in and 1.6 is a good target.' },
  { term: 'Complementary sensitivity', area: 'frequency', def: 'The closed-loop transfer from setpoint to measurement, whose peak says how much a setpoint step will overshoot.' },
  { term: 'Waterbed effect', area: 'frequency', def: 'The theorem that reducing sensitivity at one frequency necessarily raises it at another, which is why a loop tuned tight for one disturbance amplifies a different one.' },
  { term: 'Amplitude ratio', area: 'frequency', def: 'How much a sinusoid of a given frequency is magnified or attenuated on its way through a block.' },
  { term: 'Phase lag', area: 'frequency', def: 'How far a sinusoid is delayed on its way through a block, expressed as an angle rather than a time.' },
  { term: 'Corner frequency', area: 'frequency', def: 'The frequency at which a first-order lag starts to attenuate, equal to the reciprocal of its time constant.' },
  { term: 'Aliasing', area: 'frequency', def: 'A signal component above half the sampling rate reappearing as a lower-frequency one, which is why a fast oscillation can show up on a trend as a slow drift.' },
  { term: 'Nyquist frequency', area: 'frequency', def: 'Half the sampling rate, above which nothing can be measured honestly.' },

  // --- Diagnostics ----------------------------------------------------------------------
  { term: 'Loop performance monitoring', area: 'diagnostics', def: 'Watching a loop\'s own routine data for signs that it has stopped doing its job, without running any test on it.' },
  { term: 'Harris index', area: 'diagnostics', def: 'The ratio of a loop\'s achieved variance to the best any controller could achieve given its dead time, so a value near one means the tuning is not the problem.' },
  { term: 'Minimum variance benchmark', area: 'diagnostics', def: 'The variance a perfect controller would still be left with, which is set entirely by the dead time and is the floor no tuning can beat.' },
  { term: 'Oscillation index', area: 'diagnostics', def: 'A measure of how regular a loop\'s error signal is, used to separate a genuinely cycling loop from a noisy one.' },
  { term: 'Sinusoidality', area: 'diagnostics', def: 'How close an oscillation is to a pure sine, which distinguishes a tuning-induced cycle from the sawtooth a sticking valve produces.' },
  { term: 'Stiction', area: 'diagnostics', def: 'Static friction in a valve that makes it stick until the actuator force builds up and then jump past where it was asked for.' },
  { term: 'Stick-slip cycle', area: 'diagnostics', def: 'The self-sustaining limit cycle a sticking valve and an integrating controller produce together, recognisable by its square-and-triangle shape.' },
  { term: 'Backlash', area: 'diagnostics', def: 'Lost motion in a linkage or gearbox, which shows up as a deadband that depends on the direction of travel.' },
  { term: 'Hunting', area: 'diagnostics', def: 'A loop cycling continuously about setpoint, which wears the final element out whatever the error statistics say.' },
  { term: 'Limit cycle', area: 'diagnostics', def: 'A sustained oscillation of fixed amplitude produced by a nonlinearity rather than by instability.' },
  { term: 'Valve travel', area: 'diagnostics', def: 'The cumulative distance a final element has moved, which is the number a maintenance schedule should be written against.' },
  { term: 'Noise band', area: 'diagnostics', def: 'The amplitude of the measurement\'s own random content, below which no control action is meaningful.' },
  { term: 'Signal filtering', area: 'diagnostics', def: 'Smoothing a measurement to make it usable, at the cost of adding lag that the loop must then be detuned for.' },
  { term: 'Root cause', area: 'diagnostics', def: 'The thing that, if fixed, stops the symptom recurring — as opposed to the thing that was adjusted to make the symptom go away.' },

  // --- Pumps and hydraulics -------------------------------------------------------------
  { term: 'Centrifugal pump', area: 'pump', def: 'A machine that adds energy to a liquid by accelerating it through a rotating impeller and then recovering that velocity as pressure.' },
  { term: 'Head', area: 'pump', def: 'The energy a pump adds per unit weight of liquid, in metres, which is independent of density and is why pump curves are drawn in metres rather than bar.' },
  { term: 'Total dynamic head', area: 'pump', def: 'The head a pump must produce: the static lift plus every friction loss at the flow in question.' },
  { term: 'Static head', area: 'pump', def: 'The part of the required head that comes from elevation and vessel pressure, which does not change with flow.' },
  { term: 'Friction head', area: 'pump', def: 'The part of the required head that is lost to pipe and fitting resistance, which rises roughly as the square of flow.' },
  { term: 'Pump curve', area: 'pump', def: 'The head a pump produces against the flow it is passing, at a stated speed and impeller diameter.' },
  { term: 'System curve', area: 'pump', def: 'The head the system requires against flow, which is the static head plus the friction curve.' },
  { term: 'Operating point', area: 'pump', def: 'Where the pump curve and the system curve cross, which is the only flow the pump can actually deliver into that system.' },
  { term: 'Shut-off head', area: 'pump', def: 'The head a pump makes at zero flow, and the highest pressure it can generate against a closed valve.' },
  { term: 'Best efficiency point (BEP)', area: 'pump', def: 'The flow at which a pump converts the most of its shaft power into useful head, and the flow it is hydraulically quietest at.' },
  { term: 'Preferred operating region', area: 'pump', def: 'The band of flow around BEP — commonly 70% to 120% — inside which a pump can be run indefinitely without unusual wear.' },
  { term: 'Allowable operating region', area: 'pump', def: 'The wider band the manufacturer will accept, outside which vibration, temperature or thrust limits are being approached.' },
  { term: 'Minimum continuous flow', area: 'pump', def: 'The lowest flow at which a pump may run indefinitely, set by recirculation and by the heat it puts into the liquid it is not passing.' },
  { term: 'Suction recirculation', area: 'pump', def: 'Reverse flow at the impeller eye at low flow, which is loud, damaging, and the real reason a minimum-flow limit exists.' },
  { term: 'Discharge recirculation', area: 'pump', def: 'The corresponding reverse flow at the impeller discharge at low flow, which loads the shaft in ways it was not designed for.' },
  { term: 'Affinity laws', area: 'pump', def: 'The rules that flow scales with speed, head with speed squared and power with speed cubed, which is where the whole energy case for variable speed comes from.' },
  { term: 'Specific speed', area: 'pump', def: 'A dimensionless grouping of speed, flow and head that says what shape of impeller a duty needs and how steep its curve will be.' },
  { term: 'Suction specific speed', area: 'pump', def: 'The equivalent grouping using NPSH required, which is the standard measure of how hard a pump is on its suction.' },
  { term: 'NPSH available', area: 'pump', def: 'The absolute head available at the pump suction above the liquid\'s vapour pressure, which is a property of the system and not of the pump.' },
  { term: 'NPSH required', area: 'pump', def: 'The NPSH at which a pump has already lost 3% of its head to cavitation, which is a property of the pump and is not a safe operating limit.' },
  { term: 'NPSH margin', area: 'pump', def: 'Available minus required, which the Hydraulic Institute wants at 1 m or 1.1 times required, whichever is larger, precisely because NPSHr is a 3% head-drop point rather than an onset point.' },
  { term: 'Cavitation', area: 'pump', def: 'Vapour bubbles forming in the low-pressure region of the impeller and collapsing violently downstream, which sounds like gravel and removes metal.' },
  { term: 'Vapour pressure', area: 'pump', def: 'The pressure at which a liquid boils at its current temperature, and the datum every NPSH calculation is referred to.' },
  { term: 'Flashing', area: 'pump', def: 'Liquid vaporising and staying vapour because the downstream pressure is below the vapour pressure, which erodes differently from cavitation and cannot be cured by raising downstream pressure.' },
  { term: 'Air binding', area: 'pump', def: 'A gas pocket trapped in the impeller eye that stops the pump developing head at all, which looks like a failed pump and is a venting problem.' },
  { term: 'Priming', area: 'pump', def: 'Filling the suction line and casing with liquid, without which a centrifugal pump cannot generate suction.' },
  { term: 'Dead-heading', area: 'pump', def: 'Running a pump against a closed discharge, which converts the entire shaft power into heat in a few litres of trapped liquid.' },
  { term: 'Wire-to-water efficiency', area: 'pump', def: 'Hydraulic power out divided by electrical power in — the only efficiency number that means anything to whoever pays the bill.' },
  { term: 'Hydraulic power', area: 'pump', def: 'The useful power a pump delivers to the liquid, equal to density times gravity times flow times head.' },
  { term: 'Shaft power', area: 'pump', def: 'The mechanical power the motor must deliver to the pump, which is hydraulic power divided by pump efficiency.' },
  { term: 'Impeller wear ring', area: 'pump', def: 'The renewable close-clearance ring that limits internal leakage from discharge back to suction, and whose opening up is what "worn pump" usually means.' },
  { term: 'Mechanical seal', area: 'pump', def: 'The sealing arrangement between the rotating shaft and the stationary casing, which fails quickly if it is ever run dry.' },
  { term: 'Parallel operation', area: 'pump', def: 'Two pumps on a common header, whose combined curve is found by adding their flows at each head — never by adding their heads.' },
  { term: 'Series operation', area: 'pump', def: 'Two pumps one after the other, whose combined curve is found by adding their heads at each flow.' },
  { term: 'Check valve', area: 'pump', def: 'A one-way valve that stops a stopped pump being driven backwards by the header, and the component that decides whether a starting pump can join the header at all.' },
  { term: 'Water hammer', area: 'pump', def: 'A pressure wave produced by stopping a moving column of liquid too quickly, whose magnitude is the wave speed times the velocity divided by gravity.' },
  { term: 'Joukowsky pressure', area: 'pump', def: 'That theoretical maximum surge for an instantaneous stop, which is the number that says whether a fast closure is a nuisance or a burst pipe.' },
  { term: 'Surge vessel', area: 'pump', def: 'A gas-charged vessel on the header that absorbs flow transients and turns a hammer into a manageable pressure excursion.' },
  { term: 'Bladder accumulator', area: 'pump', def: 'A surge vessel with a membrane between the gas and the liquid, which keeps the charge from dissolving into the process.' },
  { term: 'Recirculation line', area: 'pump', def: 'A permanent or automatic bypass back to the suction vessel that guarantees a pump never runs below its minimum flow.' },
  { term: 'Darcy-Weisbach equation', area: 'pump', def: 'The proper way to compute pipe friction, in which the loss is a friction factor times the length-to-diameter ratio times the velocity head.' },
  { term: 'Friction factor', area: 'pump', def: 'The dimensionless coefficient in that equation, which depends on Reynolds number and relative roughness and is emphatically not a constant.' },
  { term: 'Reynolds number', area: 'pump', def: 'The ratio of inertial to viscous forces in a flow, which decides whether the flow is laminar, critical or turbulent.' },
  { term: 'Laminar flow', area: 'pump', def: 'Flow below a Reynolds number of about 2300, in which friction loss is proportional to flow and to viscosity rather than to flow squared.' },
  { term: 'Turbulent flow', area: 'pump', def: 'Flow above a Reynolds number of about 4000, in which friction loss is close to proportional to flow squared and viscosity barely matters.' },
  { term: 'Critical zone', area: 'pump', def: 'The Reynolds range between the two, where no correlation is reliable because the flow itself is not repeatable.' },
  { term: 'Relative roughness', area: 'pump', def: 'Absolute roughness divided by internal diameter, which is what the friction factor actually depends on.' },
  { term: 'Absolute roughness', area: 'pump', def: 'The average height of the surface irregularities inside a pipe, in millimetres, and a property of the line\'s history as much as its material.' },
  { term: 'Colebrook-White equation', area: 'pump', def: 'The implicit formula for the turbulent friction factor that the Moody chart is a plot of.' },
  { term: 'Swamee-Jain equation', area: 'pump', def: 'An explicit approximation to Colebrook-White, within about 1% over the whole engineering range and needing no iteration.' },
  { term: 'Moody chart', area: 'pump', def: 'The published plot of friction factor against Reynolds number for a family of relative roughnesses.' },
  { term: 'Velocity head', area: 'pump', def: 'The kinetic energy of the flow expressed as a head, v squared over 2g, and the unit every fitting loss coefficient is quoted in.' },
  { term: 'Resistance coefficient (K)', area: 'pump', def: 'The number of velocity heads a fitting costs, valid in fully turbulent flow and optimistic below it.' },
  { term: 'Equivalent length', area: 'pump', def: 'An older way of expressing the same loss, as the length of straight pipe that would cost as much.' },
  { term: 'Flow coefficient (Kv)', area: 'pump', def: 'The flow in cubic metres per hour of water a valve passes at one bar of differential, which is how valve capacity is specified.' },
  { term: 'Flow coefficient (Cv)', area: 'pump', def: 'The same idea in US units — gallons per minute at one psi — and exactly Kv divided by 0.865.' },
  { term: 'Rangeability', area: 'pump', def: 'The ratio between the largest and smallest flow a valve can control, typically 30 or 50 to one for a globe valve.' },
  { term: 'Turndown', area: 'pump', def: 'The ratio between the maximum and minimum of the range something can usefully cover, whether a valve, a transmitter or a pump set.' },
  { term: 'Seat leakage', area: 'pump', def: 'The flow a closed valve still passes, classified from Class I to Class VI, and the reason a shut valve is never quite a closed volume.' },
  { term: 'Valve authority', area: 'pump', def: 'The share of the total system pressure drop the fully open control valve takes, which determines how badly the installed characteristic differs from the inherent one.' },
  { term: 'Inherent characteristic', area: 'pump', def: 'The flow-versus-travel curve of a valve at constant pressure drop, which is what the catalogue shows.' },
  { term: 'Installed characteristic', area: 'pump', def: 'The flow-versus-travel curve on the real system, where opening the valve takes the differential away from it.' },
  { term: 'Cavitation index', area: 'pump', def: 'The ratio of available pressure differential to the differential at which a valve starts to cavitate, used to decide whether anti-cavitation trim is needed.' },
  { term: 'Choked flow', area: 'pump', def: 'The condition where lowering the downstream pressure of a valve no longer increases the flow through it, because vapour has formed in the vena contracta.' },

  // --- Motors, drives and electrical ----------------------------------------------------
  { term: 'Induction motor', area: 'electrical', def: 'The standard squirrel-cage AC machine, which runs slightly slower than its synchronous speed by an amount proportional to load.' },
  { term: 'Slip', area: 'electrical', def: 'That difference between synchronous and actual speed, usually 1% to 3% at full load, and the mechanism by which the machine develops torque at all.' },
  { term: 'Synchronous speed', area: 'electrical', def: 'The rotational speed of the stator field, equal to 120 times the supply frequency divided by the number of poles.' },
  { term: 'Full load amps (FLA)', area: 'electrical', def: 'The current the motor draws at its rated shaft power, and the number every protection setting is a percentage of.' },
  { term: 'Locked rotor current', area: 'electrical', def: 'The current a motor draws at standstill on a direct-on-line start, typically six to eight times FLA.' },
  { term: 'Service factor', area: 'electrical', def: 'A multiplier on rated power the motor may deliver continuously without exceeding its temperature rise, usually 1.0 or 1.15.' },
  { term: 'Insulation class', area: 'electrical', def: 'The temperature the winding insulation is rated for — F and H being usual — which is what an overload relay is ultimately protecting.' },
  { term: 'Thermal overload', area: 'electrical', def: 'A protection function that models the motor\'s heating from its current history and trips before the winding is damaged.' },
  { term: 'Thermal time constant', area: 'electrical', def: 'How long the motor takes to reach its steady temperature, typically twenty minutes for a small machine, and why a trip can happen long after the overload.' },
  { term: 'Variable frequency drive (VFD)', area: 'electrical', def: 'A converter that varies motor speed by varying the frequency and voltage supplied to it.' },
  { term: 'Volts per hertz', area: 'electrical', def: 'The control law that keeps the motor flux constant by scaling voltage with frequency, which is why a VFD can hold torque down to low speed.' },
  { term: 'Vector control', area: 'electrical', def: 'A drive control scheme that regulates torque and flux independently, giving far better dynamic response than volts-per-hertz.' },
  { term: 'DC link', area: 'electrical', def: 'The rectified and smoothed intermediate stage inside a drive, whose capacitance is what rides through a brief supply dip.' },
  { term: 'Carrier frequency', area: 'electrical', def: 'The switching rate of the drive\'s inverter, which trades audible noise against switching losses.' },
  { term: 'Acceleration ramp', area: 'electrical', def: 'The time the drive takes to move its speed reference across the full range on the way up, which is a rate limit the controller cannot see past.' },
  { term: 'Deceleration ramp', area: 'electrical', def: 'The same on the way down, usually longer, because the load\'s inertia has to be absorbed somewhere.' },
  { term: 'Torque limit', area: 'electrical', def: 'A cap on the torque the drive will command, which turns an impossible acceleration request into a slower one rather than a trip.' },
  { term: 'Regeneration', area: 'electrical', def: 'The load driving the motor and pushing energy back into the drive, which raises the DC link voltage and needs somewhere to go.' },
  { term: 'Braking resistor', area: 'electrical', def: 'Where that energy goes on a drive without a regenerative front end.' },
  { term: 'Minimum speed', area: 'electrical', def: 'The lowest speed a pump drive is allowed to run at, set by the pump\'s hydraulics and cooling rather than by the drive.' },
  { term: 'Ride-through', area: 'electrical', def: 'A drive\'s ability to keep running through a brief supply interruption using the energy stored in its DC link.' },
  { term: 'Harmonic distortion', area: 'electrical', def: 'The non-sinusoidal current a drive draws from the supply, which heats transformers and is why large drives get input reactors.' },
  { term: 'Power factor', area: 'electrical', def: 'The ratio of real to apparent power, which decides how much current is needed to deliver a given kilowatt.' },
  { term: 'IE efficiency class', area: 'electrical', def: 'The IEC 60034-30-1 banding of motor efficiency from IE1 to IE5, each step defined as roughly a fifth less loss than the one below.' },
  { term: 'Part-load efficiency', area: 'electrical', def: 'The efficiency a motor actually achieves below rated load, which peaks near three-quarter load and collapses below a third.' },
  { term: 'Soft starter', area: 'electrical', def: 'A device that ramps the voltage on a direct-on-line start to limit the inrush, with no ability to control speed afterwards.' },
  { term: 'Direct on line (DOL)', area: 'electrical', def: 'Starting a motor by connecting it straight to the supply, which is cheap, instant, and hard on everything downstream.' },

  // --- Instruments ----------------------------------------------------------------------
  { term: 'Transmitter', area: 'instrument', def: 'A device that converts a physical measurement into a standard signal a control system can read.' },
  { term: 'Span', area: 'instrument', def: 'The difference between the upper and lower range values a transmitter is calibrated over, and what most accuracy figures are a percentage of.' },
  { term: 'Range', area: 'instrument', def: 'The two values themselves, which need not start at zero.' },
  { term: 'Accuracy', area: 'instrument', def: 'How close a reading is to the true value, which is only meaningful once you know whether the percentage is of span, of reading or of upper range limit.' },
  { term: 'Repeatability', area: 'instrument', def: 'How close successive readings of the same true value are to each other, which is what a control loop actually needs and is usually much better than accuracy.' },
  { term: 'Hysteresis', area: 'instrument', def: 'The difference in reading between approaching a value from above and from below.' },
  { term: 'Drift', area: 'instrument', def: 'A slow change in a transmitter\'s reading over months with no change in the process, which is why calibration has an interval.' },
  { term: 'Resolution', area: 'instrument', def: 'The smallest change a device can represent, which on a 12-bit converter over an 8 bar span is 2 mbar.' },
  { term: 'Transmitter damping', area: 'instrument', def: 'A first-order filter inside the transmitter, which smooths the signal and adds lag the loop must then be detuned for.' },
  { term: 'Measurement dead time', area: 'instrument', def: 'The delay between the process changing and the transmitter reporting it, from transport, sampling and processing.' },
  { term: 'Signal noise', area: 'instrument', def: 'The random content of a measurement, which sets the floor on how tightly any loop can be controlled.' },
  { term: 'Thermowell', area: 'instrument', def: 'The protective pocket a temperature sensor sits in, which is also the reason a temperature measurement is slow.' },
  { term: 'Impulse line', area: 'instrument', def: 'The small-bore tubing connecting a pressure transmitter to the process, which adds lag when long and lies when blocked.' },
  { term: 'Calibration', area: 'instrument', def: 'Comparing an instrument against a reference and adjusting it, which is a different activity from ranging it.' },
  { term: '4-20 mA', area: 'instrument', def: 'The standard analogue signal, whose live zero at 4 mA is what lets a broken wire be told apart from a zero reading.' },
  { term: 'HART', area: 'instrument', def: 'A digital signal superimposed on the 4-20 mA loop, which is how a modern transmitter is configured and interrogated without disturbing the measurement.' },

  // --- Operations, alarms and staging ---------------------------------------------------
  { term: 'Lead pump', area: 'operations', def: 'The machine that runs first and is modulated by the controller.' },
  { term: 'Lag pump', area: 'operations', def: 'The machine that is started only when the lead cannot meet demand alone.' },
  { term: 'Staging', area: 'operations', def: 'The logic that decides when to start and stop machines as demand changes, which is the discrete half of a hybrid control problem.' },
  { term: 'Stage-up delay', area: 'operations', def: 'How long the stage-up condition must persist before a machine actually starts, which exists to stop a transient starting a pump.' },
  { term: 'Stage-down delay', area: 'operations', def: 'The same on the way down, and usually longer, because stopping a machine you immediately need again is the more expensive mistake.' },
  { term: 'Short cycling', area: 'operations', def: 'Starting and stopping a machine repeatedly in a short window, which destroys motors through thermal fatigue and is the failure staging hysteresis exists to prevent.' },
  { term: 'Starts per hour', area: 'operations', def: 'The rate limit a motor manufacturer sets on starting, and the number a staging scheme has to respect however good its pressure control is.' },
  { term: 'Duty rotation', area: 'operations', def: 'Swapping which machine is lead on a schedule so the run hours and the wear are shared.' },
  { term: 'Run hours', area: 'operations', def: 'Cumulative running time per machine, which is what rotation is trying to equalise and what maintenance is scheduled against.' },
  { term: 'Load sharing', area: 'operations', def: 'How flow is divided between running machines, whether equally, by an efficiency criterion, or by holding one at full load.' },
  { term: 'Make-before-break changeover', area: 'operations', def: 'Starting the incoming machine before stopping the outgoing one, which keeps the header up at the cost of a brief overlap.' },
  { term: 'Sleep mode', area: 'operations', def: 'Stopping the last running pump when demand falls to nothing, and waking it on a pressure drop, which saves the energy a pump uses to achieve nothing.' },
  { term: 'Hand-off-auto', area: 'operations', def: 'The three-position selection that decides whether a machine is under operator control, locked out, or available to the sequence.' },
  { term: 'Permissive', area: 'operations', def: 'A condition that must be true before a start is allowed, as opposed to a trip, which stops something already running.' },
  { term: 'Interlock', area: 'operations', def: 'A hard-wired or logic condition that prevents or forces an action regardless of what the control scheme wants.' },
  { term: 'Trip', area: 'operations', def: 'An automatic shutdown on a protective condition, which requires a deliberate reset before the machine can run again.' },
  { term: 'Alarm', area: 'operations', def: 'An audible or visible signal that requires an operator to do something, which is what distinguishes it from an event log entry.' },
  { term: 'Alarm flood', area: 'operations', def: 'More alarms arriving than an operator can process, at which point the alarm system has stopped helping and started hiding the problem.' },
  { term: 'Alarm rationalisation', area: 'operations', def: 'The exercise of deciding, for each alarm, what the operator is supposed to do about it, and deleting the ones with no answer.' },
  { term: 'Acknowledge', area: 'operations', def: 'The operator action that silences an alarm and records that it has been seen, which does not clear the condition.' },
  { term: 'Deviation alarm', area: 'operations', def: 'An alarm on the error rather than on the measurement, which catches a loop that has stopped controlling even when the process is nowhere near a limit.' },
  { term: 'Rate-of-change alarm', area: 'operations', def: 'An alarm on how fast a measurement is moving, which catches a surge or a leak long before an absolute limit does.' },
  { term: 'First-out indication', area: 'operations', def: 'Recording which condition tripped first when several arrive together, without which a cascade of trips has no diagnosable cause.' },
  { term: 'Bypass', area: 'operations', def: 'Deliberately disabling a protection for a defined reason and a defined time, which must be logged because it will otherwise be forgotten.' },
  { term: 'P&ID', area: 'operations', def: 'The piping and instrumentation diagram: the drawing that says what is connected to what and what every tag means.' },
  { term: 'Tag number', area: 'operations', def: 'The unique identifier of a piece of equipment or an instrument, whose letters say what it is and what it does.' },
  { term: 'HMI', area: 'operations', def: 'The human-machine interface: the screens through which an operator sees and commands the plant.' },
  { term: 'Faceplate', area: 'operations', def: 'The standard control-loop display, showing PV, SP, output and mode together because they are only meaningful together.' },
  { term: 'Trend', area: 'operations', def: 'A time plot of one or more measurements, and the single most useful diagnostic object on any control system.' },
  { term: 'Historian', area: 'operations', def: 'The archive of process data, without which no question about last Tuesday can be answered.' },
  { term: 'Commissioning', area: 'operations', def: 'The process of proving that what was built does what it was designed to do, which is when most tuning is first done and most of it badly.' },
  { term: 'Condition monitoring', area: 'operations', def: 'Watching vibration, temperature and current for the signature of a developing fault, so a machine is repaired on evidence rather than on a calendar.' },
  { term: 'ISO 10816 zone', area: 'operations', def: 'The A-to-D classification of overall machine vibration, where A is newly commissioned, B is fine indefinitely, C is unsatisfactory long-term and D does damage.' },
  { term: 'Specific energy', area: 'operations', def: 'Energy used per unit of product moved — on a pump station, kilowatt-hours per cubic metre — which is the only fair way to compare two ways of running the same duty.' },
  { term: 'Grid carbon intensity', area: 'operations', def: 'The mass of carbon dioxide equivalent emitted per unit of electricity, which differs between the annual average and the marginal plant by a factor that flatters or damns a project.' },
  { term: 'Marginal emissions', area: 'operations', def: 'The emissions of whichever generator actually responds to a change in demand, which is what a saving should honestly be measured against.' },
]);

/** Glossary by lower-cased term. */
const GLOSSARY_INDEX = Object.freeze(
  Object.fromEntries(GLOSSARY.map((g) => [g.term.toLowerCase(), g])),
);

/**
 * Look one term up.
 * @param {string} term the term, case-insensitive
 * @returns {{ok:boolean, reason?:string, term?:string, def?:string, area?:string}} the entry
 */
export function glossaryTerm(term) {
  if (typeof term !== 'string' || term.trim() === '') {
    return { ok: false, reason: 'no term given' };
  }
  const g = GLOSSARY_INDEX[term.trim().toLowerCase()];
  if (!g) return { ok: false, reason: `no glossary entry for "${term}"` };
  return { ok: true, term: g.term, def: g.def, area: g.area };
}

/**
 * Free-text search of the glossary, over both the term and the definition.
 *
 * Substring rather than fuzzy, deliberately: an operator looking up "npsh" wants the four NPSH
 * entries, and a scoring function that also returns "pump curve" because it shares some letters
 * makes the answer harder to read, not easier.
 *
 * @param {string} query what to look for, case-insensitive
 * @param {number} [limit=20] the most entries to return
 * @returns {Array<{term:string, def:string, area:string}>} matches, terms first then definitions
 */
export function searchGlossary(query, limit = 20) {
  if (typeof query !== 'string' || query.trim() === '') return [];
  const q = query.trim().toLowerCase();
  const inTerm = [];
  const inDef = [];
  for (const g of GLOSSARY) {
    if (g.term.toLowerCase().includes(q)) inTerm.push(g);
    else if (g.def.toLowerCase().includes(q)) inDef.push(g);
  }
  return inTerm.concat(inDef).slice(0, Math.max(0, limit));
}

/** The areas the glossary is divided into, for a filter control. */
export const GLOSSARY_AREAS = Object.freeze([
  { id: 'loop', name: 'The control loop' },
  { id: 'tuning', name: 'Identification and tuning' },
  { id: 'frequency', name: 'Frequency domain' },
  { id: 'diagnostics', name: 'Loop diagnostics' },
  { id: 'pump', name: 'Pumps and hydraulics' },
  { id: 'electrical', name: 'Motors, drives and electrical' },
  { id: 'instrument', name: 'Instruments' },
  { id: 'operations', name: 'Operations and maintenance' },
]);

/**
 * The glossary entries in one area.
 * @param {string} area a `GLOSSARY_AREAS` id
 * @returns {Array<{term:string, def:string, area:string}>} the entries, in table order
 */
export function glossaryByArea(area) {
  return GLOSSARY.filter((g) => g.area === area);
}
