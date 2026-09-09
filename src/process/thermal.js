/**
 * src/process/thermal.js — the thermal side of the skid: a heat exchanger on the discharge, a
 * heated tank, the heat the pipework gives away to the shed, and the transport delay between
 * them.
 *
 * Layer L1: imports `core/util.js` only. No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY TEMPERATURE IS THE HARD LOOP
 *
 * A flow loop is fast, nearly linear and forgiving; retune it badly and it hunts a little. A
 * temperature loop is none of those things, and every reason is in this file.
 *
 *   DEAD TIME THAT MOVES WITH THE FLOW.  Between the exchanger and the transmitter there is a
 *      length of pipe, and the liquid in it has to physically arrive before the measurement can
 *      change. That delay is the pipe volume divided by the volumetric flow — L*A/Q — so it is
 *      not a property of the plant, it is a property of the OPERATING POINT. Halve the throughput
 *      and the dead time doubles. Nothing else in this simulator does that.
 *
 *   GAIN THAT MOVES WITH THE FLOW TOO, IN THE SAME DIRECTION.  Putting a fixed duty into a
 *      stream raises its temperature by Q/(mdot*cp), so the process gain also goes as 1/flow.
 *      Both of the things that destabilise a loop therefore get worse together at low load. A
 *      controller tuned at full flow, with the usual first-order-plus-dead-time reasoning behind
 *      it, needs its gain multiplied by roughly the SQUARE of the flow ratio to keep the same
 *      margin at part load — see {@link loopScaling}. That single fact is the entire commercial
 *      case for gain scheduling on temperature, and it is the most valuable thing in this module.
 *
 *   A LAG THAT IS NOT THE RESIDENCE TIME.  An exchanger does not respond at the speed of its
 *      liquid holdup; it responds at the speed of its METAL. A plate unit with 30 kg of plates
 *      turns round in seconds, a shell-and-tube with 900 kg of shell and tubes takes a minute,
 *      and the two are otherwise the same specification on paper.
 *
 *   A PROCESS THAT DOES NOT SETTLE.  Close the outlet valve on a well-insulated heated tank and
 *      there is no longer any mechanism that removes heat. Temperature then RAMPS: the process
 *      has become a pure integrator, its steady-state gain is infinite, and the integral action
 *      that was helping five minutes ago is now the second integrator in a loop that has to
 *      oscillate. See {@link tankDynamics}, which reports that condition rather than hiding it.
 *
 *   FOULING THAT ARRIVES OVER WEEKS.  UA falls slowly and asymptotically, so the loop that was
 *      commissioned with good margin is a different loop by the next shutdown.
 *
 * ------------------------------------------------------------------------------------------
 * EFFECTIVENESS-NTU, AND WHY NOT LMTD
 *
 * Both are in here, because they answer different questions and an engineer uses both.
 *
 *   LMTD is a RATING method. Given all four terminal temperatures it tells you the duty. It is
 *   what a datasheet is checked with. It cannot be used in a simulation, because three of the
 *   four temperatures are what we are trying to find.
 *
 *   EFFECTIVENESS-NTU is a SIZING/SIMULATION method. Given the two inlet temperatures, the two
 *   capacity rates and UA, it gives the duty directly with no iteration — which is exactly the
 *   shape of the problem inside a tick. That is why it is the one the model runs on.
 *
 * They are the same physics, so `exchangerDuty` computes the duty by NTU and then reports the
 * LMTD and the correction factor F implied by the answer. For pure counterflow and pure parallel
 * flow F must come out at exactly 1; anything else is a bug, and the test file checks it.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, lag, S_PER_H } from '../core/util.js';

/** Specific heat of carbon steel over 0..200 C, J/(kg K). Standard property table value. */
export const STEEL_CP_JkgK = 490;

// ---------------------------------------------------------------------------------------------
// Effectiveness-NTU
// ---------------------------------------------------------------------------------------------

/** Exchanger flow arrangements, each with its own published effectiveness relation. */
export const ARRANGEMENT = Object.freeze({
  /** Pure counterflow: the best an exchanger can do, and the only one that can approach eps = 1. */
  COUNTERFLOW: 'COUNTERFLOW',
  /** Pure parallel (co-current) flow: capped at 1/(1+Cr) however much surface is bought. */
  PARALLEL: 'PARALLEL',
  /** Single-pass crossflow, both streams unmixed — the air-cooler arrangement. */
  CROSSFLOW_UNMIXED: 'CROSSFLOW_UNMIXED',
  /** One shell pass, two (or any even number of) tube passes — the ordinary shell-and-tube. */
  SHELL_TUBE_1N: 'SHELL_TUBE_1N',
});

/**
 * Effectiveness of an exchanger, from its NTU and capacity-rate ratio.
 *
 * The published relations, all four in the form eps = f(NTU, Cr) with Cr = Cmin/Cmax:
 *
 *   COUNTERFLOW        eps = (1 - e^-N(1-Cr)) / (1 - Cr*e^-N(1-Cr)),   eps = N/(1+N) at Cr = 1
 *   PARALLEL           eps = (1 - e^-N(1+Cr)) / (1 + Cr)
 *   CROSSFLOW UNMIXED  eps = 1 - exp{ (N^0.22/Cr) * [ e^(-Cr*N^0.78) - 1 ] }     (approximate)
 *   SHELL-AND-TUBE 1-N eps = 2 / { 1 + Cr + sqrt(1+Cr^2) * (1+e^-N*r)/(1-e^-N*r) },  r = sqrt(1+Cr^2)
 *
 * Source: Kays & London, *Compact Heat Exchangers*, and reproduced in every heat-transfer text
 * (Incropera Table 11.3). The crossflow expression is the standard curve fit rather than the
 * series solution; it is within about 1% over the range of engineering interest and there is no
 * closed form to be had.
 *
 * Cr = 0 — one stream boiling or condensing, or simply so much larger than the other that its
 * temperature does not move — collapses ALL of them to eps = 1 - e^-N. That is not a special case
 * bolted on; it is the common limit, and it is what the tank jacket in this file runs on.
 *
 * @param {string} arrangement one of {@link ARRANGEMENT}
 * @param {number} NTU number of transfer units, UA/Cmin
 * @param {number} Cr capacity-rate ratio Cmin/Cmax, 0..1
 * @returns {number} effectiveness, 0..1
 */
export function effectivenessNTU(arrangement, NTU, Cr) {
  const N = Math.max(0, NTU);
  const C = clamp(Cr, 0, 1);
  if (!(N > 0)) return 0;
  // The common limit. Taken first because every relation below degenerates to it and two of them
  // divide by Cr on the way.
  if (C < 1e-9) return -Math.expm1(-N);

  if (arrangement === ARRANGEMENT.PARALLEL) {
    return -Math.expm1(-N * (1 + C)) / (1 + C);
  }
  if (arrangement === ARRANGEMENT.CROSSFLOW_UNMIXED) {
    return -Math.expm1((Math.pow(N, 0.22) / C) * Math.expm1(-C * Math.pow(N, 0.78)));
  }
  if (arrangement === ARRANGEMENT.SHELL_TUBE_1N) {
    const r = Math.sqrt(1 + C * C);
    const e = Math.exp(-N * r);
    return 2 / (1 + C + (r * (1 + e)) / (1 - e));
  }
  // Counterflow. At Cr = 1 the published expression is 0/0 — both the numerator and the
  // denominator vanish — and its limit is N/(1+N). A balanced exchanger is not an exotic case,
  // it is the design intent of most water-to-water duties, so the limit is taken explicitly
  // rather than left to cancel in floating point where it produces noise or a NaN.
  if (Math.abs(1 - C) < 1e-6) return N / (1 + N);
  const x = -N * (1 - C);
  return -Math.expm1(x) / (1 - C * Math.exp(x));
}

/**
 * Log-mean temperature difference between two terminal differences, K.
 *
 * The mean that makes `Q = UA * dTm` exact for a counterflow exchanger with constant properties.
 * Two degenerate cases have to be handled or the rating arithmetic breaks:
 *
 *   EQUAL TERMINALS   dT1 = dT2 gives 0/0. The limit is the common value, which the arithmetic
 *                     mean returns exactly, so the switch is taken slightly early — at a ratio
 *                     within 1e-6 — where the two agree to well past double precision anyway.
 *   A TEMPERATURE CROSS  a terminal difference that is zero or of the opposite sign describes an
 *                     exchanger that cannot exist in this arrangement. NaN is returned rather
 *                     than a clamped number, because a clamped LMTD silently reports a duty for
 *                     impossible equipment and that error has been sold to customers before.
 *
 * @param {number} dT1_K temperature difference at one end, K
 * @param {number} dT2_K temperature difference at the other end, K
 * @returns {number} the log-mean difference, K — NaN if the terminals cross
 */
export function lmtd_K(dT1_K, dT2_K) {
  if (!(dT1_K > 0) || !(dT2_K > 0)) return NaN;
  const r = dT1_K / dT2_K;
  if (Math.abs(r - 1) < 1e-6) return 0.5 * (dT1_K + dT2_K);
  return (dT1_K - dT2_K) / Math.log(r);
}

/**
 * Capacity rate of a stream, W/K — the watts it carries per kelvin of temperature change.
 *
 * The bridge between this file, which thinks in mass flow and specific heat, and the rest of the
 * plant, which thinks in m3/h.
 *
 * @param {number} Q_m3h volumetric flow, m3/h
 * @param {number} rho_kgm3 density, kg/m3
 * @param {number} cp_JkgK specific heat, J/(kg K)
 * @returns {number} capacity rate, W/K
 */
export function capacityRate_WK(Q_m3h, rho_kgm3, cp_JkgK) {
  return (Math.max(0, Q_m3h) / S_PER_H) * rho_kgm3 * cp_JkgK;
}

// ---------------------------------------------------------------------------------------------
// The exchanger
// ---------------------------------------------------------------------------------------------

/**
 * TEMA design fouling resistances, m2 K/W.
 *
 * TEMA RGP-T-2.4 tabulates these in hr ft2 F/Btu; 0.001 of those is 0.000176 m2 K/W, which is the
 * conversion applied here. They are the allowances a designer adds to the CLEAN resistance before
 * buying surface, which is why an exchanger is always oversized when new and why its outlet
 * temperature drifts for months after commissioning.
 */
export const FOULING_TEMA = Object.freeze({
  /** Distilled or demineralised water. */
  CLEAN_WATER: 0.000088,
  /** Treated closed-circuit cooling water. The default for this skid. */
  TREATED_WATER: 0.000176,
  /** Once-through river water, screened. */
  RIVER_WATER: 0.000352,
  /** Untreated cooling-tower water, the classic fouler. */
  TOWER_WATER: 0.000528,
  /** Light fuel oil. */
  FUEL_OIL: 0.000880,
});

/**
 * Build a frozen heat exchanger.
 *
 * The clean UA is split into three series resistances — hot film, wall, cold film — because that
 * split is what makes the exchanger's gain move with flow. Only the two FILM resistances change
 * when a flow changes, so an exchanger whose resistance sits mostly in the wall barely responds
 * to a utility flow change while one that is film-limited responds strongly. Guessing at a single
 * lumped UA loses that entirely, and with it the reason a temperature loop's gain is not
 * constant.
 *
 * @param {object} spec exchanger data
 * @param {string} spec.tag equipment tag, e.g. 'HX-101'
 * @param {string} [spec.arrangement] one of {@link ARRANGEMENT}, default counterflow
 * @param {number} spec.UAdesign_WK overall UA at the design flows, clean, W/K
 * @param {number} spec.area_m2 heat transfer surface, m2 — needed to turn a fouling RESISTANCE
 *   (m2 K/W) into a UA penalty
 * @param {number} spec.mHotDesign_kgs design hot-side mass flow, kg/s
 * @param {number} spec.mColdDesign_kgs design cold-side mass flow, kg/s
 * @param {number} [spec.resHot=0.45] hot film share of the clean resistance
 * @param {number} [spec.resWall=0.10] wall (and metal) share of the clean resistance
 * @param {number} [spec.hotExp=0.8] hot-side film exponent on mass flow
 * @param {number} [spec.coldExp=0.8] cold-side film exponent on mass flow
 * @param {number} [spec.holdupHot_kg=40] liquid held on the hot side, kg
 * @param {number} [spec.holdupCold_kg=40] liquid held on the cold side, kg
 * @param {number} [spec.metalMass_kg=120] plates or tubes and shell, kg
 * @param {number} [spec.metalCp_JkgK=490] specific heat of that metal
 * @param {number} [spec.metalToHot=0.5] share of the metal mass that follows the hot side
 * @param {number} [spec.RfMax_m2KW] asymptotic fouling resistance at the reference velocity
 * @param {number} [spec.foulTau_h=1400] fouling time constant at the reference velocity, hours
 * @param {number} [spec.foulVelocity_ms=1.5] the velocity those two figures were quoted at
 * @returns {object} the frozen exchanger
 */
export function createExchanger(spec) {
  const resHot = spec.resHot === undefined ? 0.45 : clamp(spec.resHot, 0.01, 0.98);
  const resWall = spec.resWall === undefined ? 0.10 : clamp(spec.resWall, 0, 0.98);
  // The cold film takes whatever is left. Deriving it rather than asking for it means the three
  // shares always sum to one, which is the only way the design-point UA comes back exactly.
  const resCold = Math.max(0.01, 1 - resHot - resWall);
  const Rdesign = 1 / spec.UAdesign_WK;
  return Object.freeze({
    tag: spec.tag,
    arrangement: spec.arrangement || ARRANGEMENT.COUNTERFLOW,
    UAdesign_WK: spec.UAdesign_WK,
    area_m2: spec.area_m2,
    mHotDesign_kgs: spec.mHotDesign_kgs,
    mColdDesign_kgs: spec.mColdDesign_kgs,
    /** Series resistances at the design point, K/W. They sum to 1/UAdesign by construction. */
    Rhot_KW: resHot * Rdesign,
    Rwall_KW: resWall * Rdesign,
    Rcold_KW: resCold * Rdesign,
    // Dittus-Boelter gives Nu ~ Re^0.8 for turbulent tube flow, so the film coefficient — and
    // therefore the inverse of the film resistance — goes as mass flow to the 0.8. Shell-side
    // crossflow (Kern) is nearer 0.6, so a shell-and-tube is specified with the two different.
    hotExp: spec.hotExp === undefined ? 0.8 : spec.hotExp,
    coldExp: spec.coldExp === undefined ? 0.8 : spec.coldExp,
    // Defaults sized for a gasketed plate unit of a few hundred kW: tens of kilograms of liquid
    // per side and rather more plate than that. A shell-and-tube of the same duty holds five to
    // ten times the metal, and specifying it that way is what makes it respond in a minute
    // instead of in seconds.
    holdupHot_kg: spec.holdupHot_kg === undefined ? 40 : spec.holdupHot_kg,
    holdupCold_kg: spec.holdupCold_kg === undefined ? 40 : spec.holdupCold_kg,
    metalMass_kg: spec.metalMass_kg === undefined ? 120 : spec.metalMass_kg,
    metalCp_JkgK: spec.metalCp_JkgK === undefined ? STEEL_CP_JkgK : spec.metalCp_JkgK,
    metalToHot: spec.metalToHot === undefined ? 0.5 : clamp(spec.metalToHot, 0, 1),
    RfMax_m2KW: spec.RfMax_m2KW === undefined ? FOULING_TEMA.TREATED_WATER : spec.RfMax_m2KW,
    // Asymptotic fouling on treated cooling water is reached over months, not weeks: published
    // Kern-Seaton time constants for waterside particulate fouling run from about 500 to 2500
    // hours, and 1400 h — two months of continuous running — sits in the middle of that. The
    // reference velocity is the 1.5 m/s a designer aims for in exchanger tubes, being fast enough
    // to keep the surface swept and slow enough not to erode it.
    foulTau_h: spec.foulTau_h === undefined ? 1400 : Math.max(1, spec.foulTau_h),
    foulVelocity_ms: spec.foulVelocity_ms === undefined ? 1.5 : Math.max(0.1, spec.foulVelocity_ms),
  });
}

/** Below this fraction of design flow a film is treated as if it were at that fraction. */
const FILM_FLOOR = 0.02;

/**
 * Overall UA at off-design flows and a given fouling resistance, W/K.
 *
 * Three resistances in series plus the fouling film:
 *
 *     1/UA = R_hot*(m_hot,design/m_hot)^n + R_wall + R_cold*(m_cold,design/m_cold)^n + Rf/A
 *
 * The flow exponents are the film correlations' — see `hotExp` in {@link createExchanger}. This
 * is where the exchanger's flow-dependent gain actually comes from: turn the utility flow down to
 * a third and its film resistance rises by 3^0.8 = 2.4, so UA falls, so the effectiveness falls,
 * on top of the capacity-rate change that the NTU relation already accounts for.
 *
 * At vanishing flow the correlation would send UA to zero and NTU to infinity together. The film
 * is floored at 2% of design instead: the duty at that point is set by the capacity rate, which is
 * already essentially zero, and an unbounded resistance in a tick's arithmetic is a NaN waiting
 * to be integrated into the state.
 *
 * @param {object} hx from {@link createExchanger}
 * @param {number} mHot_kgs hot-side mass flow, kg/s
 * @param {number} mCold_kgs cold-side mass flow, kg/s
 * @param {number} [Rf_m2KW=0] fouling resistance referred to the transfer area
 * @returns {number} overall UA, W/K
 */
export function exchangerUA_WK(hx, mHot_kgs, mCold_kgs, Rf_m2KW) {
  const rh = clamp(mHot_kgs / hx.mHotDesign_kgs, FILM_FLOOR, 20);
  const rc = clamp(mCold_kgs / hx.mColdDesign_kgs, FILM_FLOOR, 20);
  const foul = hx.area_m2 > 0 ? Math.max(0, Rf_m2KW || 0) / hx.area_m2 : 0;
  const R = hx.Rhot_KW * Math.pow(rh, -hx.hotExp)
    + hx.Rwall_KW
    + hx.Rcold_KW * Math.pow(rc, -hx.coldExp)
    + foul;
  return 1 / R;
}

/**
 * Solve an exchanger's steady duty by effectiveness-NTU, and report the LMTD it implies.
 *
 * Sign convention: heat always flows from the hot stream to the cold one, so a "hot" inlet that
 * is actually colder gives a negative duty and the two streams swap roles physically without the
 * caller having to notice. The effectiveness relations are symmetric in the two streams, so this
 * costs nothing and it saves a whole class of bug on a rig where the utility can be either.
 *
 * @param {object} hx from {@link createExchanger}
 * @param {object} u the operating condition
 * @param {number} u.ThotIn_C hot stream inlet temperature, C
 * @param {number} u.TcoldIn_C cold stream inlet temperature, C
 * @param {number} u.mHot_kgs hot-side mass flow, kg/s
 * @param {number} u.mCold_kgs cold-side mass flow, kg/s
 * @param {number} u.cpHot_JkgK hot stream specific heat
 * @param {number} u.cpCold_JkgK cold stream specific heat
 * @param {number} [u.fouling_m2KW=0] current fouling resistance
 * @returns {object} `{ok:true, Q_W, ThotOut_C, TcoldOut_C, UA_WK, NTU, Cr, eff, lmtd_K, F,
 *   gainUtility, flowing}` or `{ok:false, reason}`
 */
export function exchangerDuty(hx, u) {
  if (!hx || !u) return { ok: false, reason: 'an exchanger and an operating condition are required' };
  const Th = u.ThotIn_C;
  const Tc = u.TcoldIn_C;
  if (!Number.isFinite(Th) || !Number.isFinite(Tc)) {
    return { ok: false, reason: 'both inlet temperatures must be finite' };
  }
  const Ch = Math.max(0, u.mHot_kgs) * Math.max(0, u.cpHot_JkgK);
  const Cc = Math.max(0, u.mCold_kgs) * Math.max(0, u.cpCold_JkgK);
  const UA = exchangerUA_WK(hx, Math.max(0, u.mHot_kgs), Math.max(0, u.mCold_kgs), u.fouling_m2KW);

  // A stopped stream transfers nothing, however much surface there is. Reported as a valid
  // answer rather than a refusal, because it is an ordinary operating state — the utility pump
  // is off — and the caller has to be able to integrate through it.
  if (!(Ch > 0) || !(Cc > 0)) {
    return {
      ok: true,
      Q_W: 0,
      ThotOut_C: Th,
      TcoldOut_C: Tc,
      UA_WK: UA,
      NTU: 0,
      Cr: 0,
      eff: 0,
      lmtd_K: NaN,
      F: NaN,
      gainUtility: 0,
      flowing: false,
    };
  }

  const Cmin = Math.min(Ch, Cc);
  const Cmax = Math.max(Ch, Cc);
  const Cr = Cmin / Cmax;
  const NTU = UA / Cmin;
  const eff = effectivenessNTU(hx.arrangement, NTU, Cr);
  const Q = eff * Cmin * (Th - Tc);
  const ThOut = Th - Q / Ch;
  const TcOut = Tc + Q / Cc;

  // The terminal differences depend on which end is which, and that is the ONLY place the
  // arrangement enters the LMTD. Parallel flow pairs inlet with inlet; everything else is
  // referred to counterflow, which is what makes F the honest penalty for not being counterflow.
  const parallel = hx.arrangement === ARRANGEMENT.PARALLEL;
  const dT1 = parallel ? Th - Tc : Th - TcOut;
  const dT2 = parallel ? ThOut - TcOut : ThOut - Tc;
  const dTm = lmtd_K(dT1, dT2);
  const F = Number.isFinite(dTm) && dTm > 0 ? Q / (UA * dTm) : NaN;

  return {
    ok: true,
    Q_W: Q,
    ThotOut_C: ThOut,
    TcoldOut_C: TcOut,
    UA_WK: UA,
    NTU,
    Cr,
    eff,
    lmtd_K: dTm,
    F,
    /**
     * How far the controlled outlet moves per kelvin of utility inlet, dimensionless. This is the
     * process gain of a loop that manipulates utility TEMPERATURE rather than flow, and it is
     * bounded by 1 — which is why such loops go sluggish long before they go unstable.
     */
    gainUtility: (eff * Cmin) / Ch,
    flowing: true,
  };
}

/**
 * Allocate the mutable state of an exchanger's outlet temperatures.
 * @param {number} T0_C initial temperature of both outlets, C
 * @returns {object} exchanger state
 */
export function createExchangerState(T0_C) {
  return {
    /** Hot-side outlet temperature, C — what a TT on the process line reads. */
    ThotOut_C: T0_C,
    /** Cold-side outlet temperature, C. */
    TcoldOut_C: T0_C,
    /** The steady duty the outlets are heading toward, W. */
    Q_W: 0,
    /** Hot-side lag, s. Recomputed every tick because it moves with flow. */
    tauHot_s: 0,
    /** Cold-side lag, s. */
    tauCold_s: 0,
  };
}

/**
 * Advance an exchanger's outlet temperatures one tick.
 *
 * ------------------------------------------------------------------------------------------
 * THE LAG IS THE METAL, NOT THE LIQUID
 *
 * Effectiveness-NTU gives the STEADY answer instantly. A real exchanger takes time to get there,
 * and the time is set by everything that has to change temperature on the way:
 *
 *     tau = (liquid holdup + its share of the metal) * cp / (capacity rate)
 *
 * The metal term is usually the larger one and it is the one people forget. A gasketed plate unit
 * holds 30 kg of steel and turns round in seconds; a shell-and-tube of the same duty holds most of
 * a tonne and takes a minute. Both are "a heat exchanger" on the P&ID, and a loop tuned for one
 * will not control the other.
 *
 * The lag is applied with the exact discrete pole, so it is stable at any tick and any flow —
 * including the moment a pump stops and the capacity rate goes to zero, where tau goes to
 * infinity and the outlets correctly stop moving instead of dividing by zero.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} hx from {@link createExchanger}
 * @param {object} st state from {@link createExchangerState}, mutated
 * @param {object} u the operating condition, as {@link exchangerDuty} takes it
 * @param {number} dt_s tick, s
 * @returns {object} the duty result, with the LAGGED outlet temperatures substituted, or
 *   `{ok:false, reason}`
 */
export function stepExchanger(hx, st, u, dt_s) {
  if (!st || !(dt_s > 0)) return { ok: false, reason: 'a state and a positive step are required' };
  const steady = exchangerDuty(hx, u);
  if (!steady.ok) return steady;

  const Ch = Math.max(0, u.mHot_kgs) * Math.max(0, u.cpHot_JkgK);
  const Cc = Math.max(0, u.mCold_kgs) * Math.max(0, u.cpCold_JkgK);
  const metalHot = hx.metalToHot * hx.metalMass_kg * hx.metalCp_JkgK;
  const metalCold = (1 - hx.metalToHot) * hx.metalMass_kg * hx.metalCp_JkgK;
  const capHot = hx.holdupHot_kg * Math.max(0, u.cpHot_JkgK) + metalHot;
  const capCold = hx.holdupCold_kg * Math.max(0, u.cpCold_JkgK) + metalCold;

  st.tauHot_s = Ch > 0 ? capHot / Ch : Infinity;
  st.tauCold_s = Cc > 0 ? capCold / Cc : Infinity;
  st.ThotOut_C = lag(st.ThotOut_C, steady.ThotOut_C, st.tauHot_s, dt_s);
  st.TcoldOut_C = lag(st.TcoldOut_C, steady.TcoldOut_C, st.tauCold_s, dt_s);
  st.Q_W = steady.Q_W;

  return {
    ...steady,
    ThotOut_C: st.ThotOut_C,
    TcoldOut_C: st.TcoldOut_C,
    tauHot_s: st.tauHot_s,
    tauCold_s: st.tauCold_s,
  };
}

// ---------------------------------------------------------------------------------------------
// Fouling
// ---------------------------------------------------------------------------------------------

/**
 * Allocate fouling state.
 * @param {number} [Rf0_m2KW=0] initial fouling resistance — zero for a freshly cleaned unit
 * @returns {{Rf_m2KW:number, hours:number}} the state
 */
export function createFoulingState(Rf0_m2KW) {
  return { Rf_m2KW: Math.max(0, Rf0_m2KW || 0), hours: 0 };
}

/**
 * Grow the fouling layer over one tick, by the Kern-Seaton asymptotic model.
 *
 *     dRf/dt = phi_deposition - phi_removal * Rf
 *
 * Deposition is roughly constant, removal is shear-driven and therefore proportional to velocity
 * squared, so the layer approaches an asymptote rather than growing without bound:
 *
 *     Rf(t) = Rf_inf * (1 - e^(-t/tau)),  Rf_inf = phi_d/phi_r,  tau = 1/phi_r
 *
 * Source: Kern & Seaton (1959), the model every fouling monitoring programme is built on. The
 * consequence worth understanding is in the velocity dependence. Deposition does not care much
 * about velocity but removal is shear-driven, so BOTH the asymptote and the time constant go as
 * 1/v^2 while their product — the initial fouling rate — stays put. An exchanger run at half its
 * design velocity, which is exactly what happens when a plant is turned down, therefore starts
 * fouling at the same rate as before but keeps going four times as long, to four times the
 * resistance. It is dirtier at every moment after commissioning, and it never appears to settle.
 * Turndown is not free, and this is one of the bills.
 *
 * The step is taken with the exact exponential rather than an Euler increment, so a fast-forward
 * of many hours in one call lands in the right place instead of overshooting the asymptote.
 *
 * @param {object} hx from {@link createExchanger}
 * @param {object} st state from {@link createFoulingState}, mutated
 * @param {number} velocity_ms tube or channel velocity, m/s
 * @param {number} dt_s tick, s
 * @returns {number} the new fouling resistance, m2 K/W
 */
export function stepFouling(hx, st, velocity_ms, dt_s) {
  if (!st || !(dt_s > 0)) return st ? st.Rf_m2KW : 0;
  const vr = Math.max(velocity_ms, 0.05) / hx.foulVelocity_ms;
  const shear = vr * vr;
  const asymptote = hx.RfMax_m2KW / shear;
  const tau_h = hx.foulTau_h / shear;
  const dt_h = dt_s / 3600;
  st.Rf_m2KW = asymptote + (st.Rf_m2KW - asymptote) * Math.exp(-dt_h / tau_h);
  st.hours += dt_h;
  return st.Rf_m2KW;
}

/**
 * Clean an exchanger — a chemical clean or a strip-down, both of which return the surface to
 * bare metal and reset the clock.
 * @param {object} st fouling state, mutated
 * @returns {void}
 */
export function cleanExchanger(st) {
  if (!st) return;
  st.Rf_m2KW = 0;
  st.hours = 0;
}

// ---------------------------------------------------------------------------------------------
// The transport delay — the most important thing in this file
// ---------------------------------------------------------------------------------------------

/**
 * Build a frozen transport line: a length of pipe between where the temperature is changed and
 * where it is measured.
 *
 * @param {object} spec line data
 * @param {string} spec.tag line number
 * @param {number} [spec.volume_m3] liquid volume of the run — give this OR a length and bore
 * @param {number} [spec.length_m] developed length, m
 * @param {number} [spec.id_mm] internal diameter, mm
 * @param {number} [spec.UA_WK=0] heat loss coefficient of the whole run to ambient, W/K
 * @param {number} [spec.metalMass_kg=0] pipe metal that cools with the liquid when it is standing
 * @param {number} [spec.capacity=4096] history samples held; sets the longest dead time the line
 *   can reproduce before it admits it has forgotten
 * @returns {object} the frozen line
 */
export function createTransportLine(spec) {
  const area = spec.id_mm ? (Math.PI * (spec.id_mm / 1000) * (spec.id_mm / 1000)) / 4 : 0;
  const volume = spec.volume_m3 !== undefined ? spec.volume_m3 : area * (spec.length_m || 0);
  return Object.freeze({
    tag: spec.tag,
    volume_m3: Math.max(1e-9, volume),
    length_m: spec.length_m || 0,
    area_m2: area,
    UA_WK: spec.UA_WK || 0,
    metalMass_kg: spec.metalMass_kg || 0,
    capacity: Math.max(16, Math.floor(spec.capacity || 4096)),
  });
}

/**
 * The dead time of a line at a flow, s. The whole point of the module:
 *
 *     theta = V/Q = L*A/Q
 *
 * @param {object} line from {@link createTransportLine}
 * @param {number} Q_m3h volumetric flow, m3/h
 * @returns {number} dead time, s — `Infinity` at zero flow, because nothing ever arrives
 */
export function deadTime_s(line, Q_m3h) {
  if (!(Q_m3h > 0)) return Infinity;
  return (line.volume_m3 * S_PER_H) / Q_m3h;
}

/**
 * Allocate the mutable state of a transport line, full of liquid at one temperature.
 *
 * The history is two parallel rings — cumulative volume passed, and the inlet temperature and
 * clock time at that point — plus a read index that only ever moves forward. Nothing is allocated
 * after this call.
 *
 * @param {object} line from {@link createTransportLine}
 * @param {number} T0_C the temperature the line is full of, C
 * @returns {object} line state
 */
export function createTransportState(line, T0_C) {
  const cap = line.capacity;
  const st = {
    vol: new Float64Array(cap),
    temp: new Float64Array(cap),
    time: new Float64Array(cap),
    cap,
    /** Total samples ever written. The physical index of the newest is `n - 1`. */
    n: 0,
    /** Index of the sample at or just before the parcel now leaving. Monotonic. */
    read: 0,
    /** Cumulative volume that has passed the inlet, m3. */
    cum_m3: 0,
    /** Clock, s. */
    time_s: 0,
    /** Outlet temperature, C — what the downstream transmitter sees. */
    out_C: T0_C,
    /** Dead time measured from the history, s. Equals V/Q when the flow has been steady. */
    deadTime_s: Infinity,
    /** True when the history no longer reaches back to the parcel now leaving. */
    starved: false,
    /** True when the flow was negative and was clamped. */
    reversed: false,
  };
  // Prime the line: two samples spanning exactly one line volume, both at T0, so the outlet reads
  // T0 for exactly one residence time and only then starts to see what the inlet has been doing.
  // Without this the first tick would interpolate between an undefined past and the present.
  st.vol[0] = -line.volume_m3;
  st.temp[0] = T0_C;
  st.time[0] = 0;
  st.vol[1] = 0;
  st.temp[1] = T0_C;
  st.time[1] = 0;
  st.n = 2;
  return st;
}

/**
 * Advance a plug-flow transport line one tick.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS IS NOT A SHIFT REGISTER
 *
 * The obvious implementation of a transport delay is a queue of slugs, shifted one place per
 * tick. It is wrong in a way that matters here. A shift register can only produce dead times that
 * are whole multiples of the tick, so as the flow varies the dead time moves in STEPS — and the
 * loop's phase lag, which is the thing the whole exercise is about, jumps discontinuously at
 * arbitrary flows. An engineer sweeping the throughput to see the margin collapse would be
 * watching a staircase of numerical artefacts.
 *
 * So the line is stored as a history of (cumulative volume, temperature) instead, and the parcel
 * now leaving is found by asking where the cumulative volume was exactly one line-volume ago:
 *
 *     find t' such that  integral of Q dt from t' to t  =  V
 *
 * That is the exact statement of plug flow. It is correct for any flow history, not just a steady
 * one — a parcel that entered while the pump was fast keeps its place in the queue when the pump
 * slows — it has no numerical diffusion at all, and it resolves the dead time continuously
 * between ticks. Interpolating linearly in volume makes it exact, to floating point, for any
 * inlet temperature that is linear in time, which is what the test file checks it against.
 *
 * The read index only moves forward, so the search is O(1) amortised however long the history is.
 *
 * SCOPE. Reverse flow is not modelled: the cumulative volume must be monotonic for the read index
 * to be valid, so a negative flow is clamped to zero and flagged. Nor is the in-place cooling of
 * individual parcels tracked; ambient loss is applied to the delivered stream, which is exactly
 * right while liquid is moving and is replaced by a lumped cool-down when it is not.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} line from {@link createTransportLine}
 * @param {object} st state from {@link createTransportState}, mutated
 * @param {object} u the operating condition
 * @param {number} u.Tin_C temperature entering the line now, C
 * @param {number} u.Q_m3h volumetric flow, m3/h
 * @param {number} u.rho_kgm3 density, kg/m3
 * @param {number} u.cp_JkgK specific heat, J/(kg K)
 * @param {number} [u.Tamb_C=20] ambient temperature, C
 * @param {number} dt_s tick, s
 * @returns {{ok:true, T_C:number, deadTime_s:number, starved:boolean, stagnant:boolean}} the
 *   outlet, or `{ok:false, reason}`
 */
export function stepTransport(line, st, u, dt_s) {
  if (!line || !st) return { ok: false, reason: 'a line and its state are required' };
  if (!(dt_s > 0)) return { ok: false, reason: 'the step must be positive' };
  if (!Number.isFinite(u.Tin_C)) return { ok: false, reason: 'the inlet temperature must be finite' };

  const cap = st.cap;
  const Q = Math.max(0, u.Q_m3h);
  st.reversed = u.Q_m3h < 0;
  const Tamb = u.Tamb_C === undefined ? 20 : u.Tamb_C;

  st.cum_m3 += (Q / S_PER_H) * dt_s;
  st.time_s += dt_s;
  st.vol[st.n % cap] = st.cum_m3;
  st.temp[st.n % cap] = u.Tin_C;
  st.time[st.n % cap] = st.time_s;
  st.n += 1;

  const target = st.cum_m3 - line.volume_m3;
  const oldest = Math.max(0, st.n - cap);
  if (st.read < oldest) st.read = oldest;
  while (st.read + 1 < st.n && st.vol[(st.read + 1) % cap] <= target) st.read += 1;

  let plug_C;
  if (st.vol[st.read % cap] > target) {
    // The ring has wrapped past the parcel we need. That happens only at flows so low that the
    // residence time exceeds the whole history, so the honest answer is the oldest thing we still
    // hold, said out loud rather than dressed up as a measurement.
    st.starved = true;
    plug_C = st.temp[oldest % cap];
    st.deadTime_s = st.time_s - st.time[oldest % cap];
  } else {
    st.starved = false;
    const i = st.read % cap;
    const j = (st.read + 1) % cap;
    const span = st.vol[j] - st.vol[i];
    const f = span > 0 ? (target - st.vol[i]) / span : 0;
    plug_C = st.temp[i] + (st.temp[j] - st.temp[i]) * f;
    st.deadTime_s = st.time_s - (st.time[i] + (st.time[j] - st.time[i]) * f);
  }

  // Ambient loss along the run. For a stream in steady flow the classic result is
  //     (T_out - T_amb)/(T_in - T_amb) = exp(-UA/(mdot*cp))
  // which is itself flow-dependent, and severely so: the same lagged line that costs half a
  // kelvin at full flow delivers very nearly ambient at 5% flow. That is a second, quieter reason
  // a temperature loop misbehaves at turndown, and operators usually blame the controller for it.
  const mdot = (Q / S_PER_H) * u.rho_kgm3;
  const C = mdot * u.cp_JkgK;
  const stagnant = !(C > 1e-9) || st.starved;
  if (!stagnant) {
    const f = line.UA_WK > 0 ? Math.exp(-line.UA_WK / C) : 1;
    st.out_C = Tamb + (plug_C - Tamb) * f;
  } else {
    // Standing liquid cools in place at the line's own time constant instead. With no insulation
    // figure given (UA = 0) the tau is infinite and the reading simply holds, which is the right
    // answer for a perfectly lagged line and an honest one for a line nobody has specified.
    const tau = line.UA_WK > 0
      ? (line.volume_m3 * u.rho_kgm3 * u.cp_JkgK + line.metalMass_kg * STEEL_CP_JkgK) / line.UA_WK
      : Infinity;
    st.out_C = lag(st.out_C, Tamb, tau, dt_s);
  }

  return {
    ok: true,
    T_C: st.out_C,
    deadTime_s: st.deadTime_s,
    starved: st.starved,
    stagnant,
  };
}

// ---------------------------------------------------------------------------------------------
// Ambient losses
// ---------------------------------------------------------------------------------------------

/** Thermal conductivity of common insulation, W/(m K), at around 50 C mean. */
export const INSULATION_K = Object.freeze({
  /** Mineral wool pipe section — the ordinary process lagging. */
  MINERAL_WOOL: 0.040,
  /** Calcium silicate, for hot service. */
  CALCIUM_SILICATE: 0.055,
  /** Closed-cell elastomeric, for chilled lines. */
  ELASTOMERIC: 0.036,
  /** No insulation at all: a bare pipe, whose "conductivity" is never used. */
  BARE: 0,
});

/** Outside film coefficients, W/(m2 K). ISO 12241 default figures. */
export const OUTSIDE_FILM = Object.freeze({
  /** Still indoor air. */
  INDOOR: 10,
  /** Sheltered outdoor, light wind. */
  OUTDOOR: 25,
});

/**
 * Heat loss coefficient of an insulated pipe run, W/K.
 *
 * Two resistances in series, per metre of run:
 *
 *     R' = ln(r2/r1)/(2*pi*k)  +  1/(2*pi*r2*h_out)
 *
 * The inside film and the pipe wall are neglected. That is not laziness: for a liquid line with
 * any insulation at all they are two orders of magnitude smaller than the two terms above, and
 * carrying them would add inputs nobody has to hand in exchange for a change in the third decimal
 * place. For a BARE pipe the first term vanishes and the result is the outside film alone, which
 * is the right answer and the reason bare lines lose so much.
 *
 * @param {object} spec the run
 * @param {number} spec.od_mm pipe outside diameter, mm
 * @param {number} spec.length_m run length, m
 * @param {number} [spec.insulation_mm=0] insulation thickness, mm
 * @param {number} [spec.k_WmK] insulation conductivity, from {@link INSULATION_K}
 * @param {number} [spec.hOut_Wm2K] outside film, from {@link OUTSIDE_FILM}
 * @returns {number} UA for the whole run, W/K
 */
export function insulatedPipeUA_WK(spec) {
  const r1 = Math.max(1e-4, spec.od_mm / 2000);
  const t = Math.max(0, (spec.insulation_mm || 0) / 1000);
  const r2 = r1 + t;
  const k = spec.k_WmK === undefined ? INSULATION_K.MINERAL_WOOL : spec.k_WmK;
  const h = spec.hOut_Wm2K === undefined ? OUTSIDE_FILM.INDOOR : spec.hOut_Wm2K;
  const cond = t > 0 && k > 0 ? Math.log(r2 / r1) / (2 * Math.PI * k) : 0;
  const film = 1 / (2 * Math.PI * r2 * h);
  return Math.max(0, spec.length_m) / (cond + film);
}

// ---------------------------------------------------------------------------------------------
// The tank
// ---------------------------------------------------------------------------------------------

/**
 * Build a frozen heated tank — jacketed, electrically heated, or both.
 *
 * @param {object} spec tank data
 * @param {string} spec.tag equipment tag, e.g. 'T-101'
 * @param {number} [spec.metalMass_kg=0] shell metal that heats with the contents
 * @param {number} [spec.metalCp_JkgK=490] its specific heat
 * @param {number} [spec.UAambient_WK=0] loss coefficient of the whole vessel to the room, W/K
 * @param {number} [spec.heater_kW=0] installed electric element rating
 * @param {number} [spec.heaterEff=1] fraction of the element's watts that reach the liquid
 * @param {number} [spec.heaterTau_s=30] sheath thermal lag of the element, s
 * @param {number} [spec.jacketUA_WK=0] jacket-to-contents UA at full jacket flow, W/K
 * @returns {object} the frozen tank
 */
export function createTank(spec) {
  return Object.freeze({
    tag: spec.tag,
    metalMass_kg: spec.metalMass_kg || 0,
    metalCp_JkgK: spec.metalCp_JkgK === undefined ? STEEL_CP_JkgK : spec.metalCp_JkgK,
    UAambient_WK: spec.UAambient_WK || 0,
    heater_kW: spec.heater_kW || 0,
    // An immersion element really is very nearly 100% efficient, because every watt it dissipates
    // is already inside the thing being heated. The only loss worth naming is what the vessel
    // gives to the room, and that is modelled separately as UAambient. This knob exists for an
    // element in a thermowell or a jacket-mounted pad, where some of the heat never gets in.
    heaterEff: spec.heaterEff === undefined ? 1 : clamp(spec.heaterEff, 0, 1),
    // A sheathed immersion element has to heat its own stainless sheath and the magnesium oxide
    // packed round the coil before the liquid sees anything. Manufacturers quote a warm-up of
    // half a minute or so for a standard 16 mm element in liquid, which is where 30 s comes from.
    heaterTau_s: spec.heaterTau_s === undefined ? 30 : spec.heaterTau_s,
    jacketUA_WK: spec.jacketUA_WK || 0,
  });
}

/**
 * Allocate tank state.
 * @param {number} T0_C initial bulk temperature, C
 * @returns {object} tank state
 */
export function createTankState(T0_C) {
  return {
    /** Bulk liquid temperature, C. The tank is treated as perfectly mixed. */
    T_C: T0_C,
    /** Heat currently reaching the liquid from the element, W — lagged behind the command. */
    heater_W: 0,
    /** Jacket outlet temperature, C. */
    jacketOut_C: T0_C,
  };
}

/**
 * The tank's own dynamics at an operating condition, before anything is integrated.
 *
 * The energy balance on a perfectly mixed vessel is
 *
 *     C * dT/dt = mIn*cp*(Tin - T) + UA_amb*(Tamb - T) + eps*Cj*(Tj_in - T) + Q_heater + Q_other
 *
 * which is `dT/dt = b - a*T`, and the two coefficients say everything a control engineer needs:
 *
 *     tau = 1/a       the open-loop time constant
 *     K   = 1/(a*C)   the steady-state gain from watts to kelvin
 *
 * NOTE ON WHAT IS ABSENT. The OUTFLOW does not appear. Work through d(m*T)/dt for a vessel whose
 * level is changing and the outflow terms cancel exactly, because what leaves is already at the
 * tank temperature and carries no information. A model that subtracts an outflow enthalpy term as
 * well as an inflow one is double-counting, and it shows up as a tank that cools while it drains.
 *
 * THE JACKET. One pass of jacket fluid past a vessel whose contents are effectively isothermal is
 * a Cr = 0 exchanger, so its effectiveness is `1 - exp(-UA/Cj)` and the heat it actually delivers
 * is `eps*Cj*(Tj_in - T)`. The effective UA that produces saturates at the jacket's UA when there
 * is plenty of flow and at the CAPACITY RATE when there is not — which is why turning a jacket
 * pump down eventually stops helping and starts simply delivering less hot water.
 *
 * @param {object} tank from {@link createTank}
 * @param {object} u the operating condition, as {@link stepTank} takes it
 * @returns {{a_perS:number, C_JK:number, tau_s:number, gain_KperW:number, UAjacket_WK:number,
 *   epsJacket:number, integrating:boolean}} the coefficients
 */
export function tankDynamics(tank, u) {
  const cp = Math.max(1, u.cp_JkgK);
  const C = Math.max(1, u.mass_kg * cp + tank.metalMass_kg * tank.metalCp_JkgK);
  const Cj = Math.max(0, u.jacketFlow_kgs || 0) * Math.max(0, u.jacketCp_JkgK || 0);
  const eps = Cj > 0 && tank.jacketUA_WK > 0 ? -Math.expm1(-tank.jacketUA_WK / Cj) : 0;
  const UAj = eps * Cj;
  const a = (Math.max(0, u.mIn_kgs || 0) * cp + tank.UAambient_WK + UAj) / C;
  const tau = a > 0 ? 1 / a : Infinity;
  return {
    a_perS: a,
    C_JK: C,
    tau_s: tau,
    gain_KperW: a > 0 ? 1 / (a * C) : Infinity,
    UAjacket_WK: UAj,
    epsJacket: eps,
    /**
     * True when the tank has no meaningful path for heat to leave over the horizon a controller
     * cares about. Half an hour is the threshold: a loop being tuned on a five-minute settling
     * time cannot tell a two-hour time constant from a ramp, so for tuning purposes it IS a ramp —
     * an integrating process, on which a PI controller is two integrators and will oscillate
     * unless the integral is backed right off.
     */
    integrating: !(tau < 1800),
  };
}

/**
 * Advance a heated tank one tick.
 *
 * The linear part is integrated in closed form — `T -> Tss + (T - Tss)*exp(-a*dt)` — rather than
 * by Euler, for the case this module exists to show: when `a` goes to zero the tank stops being a
 * first-order lag and becomes a pure integrator, and an Euler step of a stiff first-order system
 * near that boundary is the classic way to get an oscillation that belongs to the solver rather
 * than to the plant. The `-expm1(-a*dt)/a` form is one expression that is exact at both ends and
 * does not divide by zero in between.
 *
 * @param {object} tank from {@link createTank}
 * @param {object} st state from {@link createTankState}, mutated
 * @param {object} u the operating condition
 * @param {number} u.mass_kg liquid currently in the tank, kg
 * @param {number} u.cp_JkgK its specific heat
 * @param {number} u.mIn_kgs inflow, kg/s
 * @param {number} u.Tin_C inflow temperature, C
 * @param {number} [u.Tamb_C=20] room temperature, C
 * @param {number} [u.heaterCmd=0] element demand, 0..1
 * @param {number} [u.jacketFlow_kgs=0] jacket fluid flow, kg/s
 * @param {number} [u.jacketCp_JkgK=4182] jacket fluid specific heat
 * @param {number} [u.jacketIn_C] jacket supply temperature, C
 * @param {number} [u.extraHeat_W=0] anything else putting heat in — pump churn, for instance
 * @param {number} dt_s tick, s
 * @returns {object} `{ok:true, T_C, Qheater_W, Qjacket_W, Qambient_W, jacketOut_C, tau_s,
 *   integrating}` or `{ok:false, reason}`
 */
export function stepTank(tank, st, u, dt_s) {
  if (!tank || !st) return { ok: false, reason: 'a tank and its state are required' };
  if (!(dt_s > 0)) return { ok: false, reason: 'the step must be positive' };
  if (!(u.mass_kg > 0)) return { ok: false, reason: 'an empty tank has no temperature to integrate' };

  const cp = Math.max(1, u.cp_JkgK);
  const Tamb = u.Tamb_C === undefined ? 20 : u.Tamb_C;
  const Tj = u.jacketIn_C === undefined ? Tamb : u.jacketIn_C;
  const dyn = tankDynamics(tank, u);

  // The element's sheath has to heat up before the liquid sees the watts. It is a small lag and
  // it is why an electric heater on a fast loop is never quite the ideal actuator it looks like.
  const demand = clamp(u.heaterCmd || 0, 0, 1) * tank.heater_kW * 1000 * tank.heaterEff;
  st.heater_W = lag(st.heater_W, demand, tank.heaterTau_s, dt_s);

  const mIn = Math.max(0, u.mIn_kgs || 0);
  const source = mIn * cp * u.Tin_C
    + tank.UAambient_WK * Tamb
    + dyn.UAjacket_WK * Tj
    + st.heater_W
    + (u.extraHeat_W || 0);
  const b = source / dyn.C_JK;

  const T0 = st.T_C;
  const ad = dyn.a_perS * dt_s;
  const f = ad > 1e-9 ? -Math.expm1(-ad) / dyn.a_perS : dt_s;
  st.T_C = T0 + (b - dyn.a_perS * T0) * f;

  // Duties are reported at the START of the step, which is where the balance above was written.
  const Qj = dyn.UAjacket_WK * (Tj - T0);
  const Cj = Math.max(0, u.jacketFlow_kgs || 0) * Math.max(0, u.jacketCp_JkgK || 4182);
  st.jacketOut_C = Cj > 0 ? Tj - Qj / Cj : Tj;

  return {
    ok: true,
    T_C: st.T_C,
    Qheater_W: st.heater_W,
    Qjacket_W: Qj,
    Qambient_W: tank.UAambient_WK * (Tamb - T0),
    jacketOut_C: st.jacketOut_C,
    tau_s: dyn.tau_s,
    integrating: dyn.integrating,
  };
}

// ---------------------------------------------------------------------------------------------
// What all of that does to the loop
// ---------------------------------------------------------------------------------------------

/**
 * The first-order-plus-dead-time model of the temperature loop at one operating point.
 *
 * The manipulated variable is heat input in kilowatts — an element's duty, or a utility valve
 * expressed as the duty it admits — and the controlled variable is the temperature at a
 * transmitter one transport line downstream of the exchanger.
 *
 *     K     = 1000/(mdot*cp)      K per kW, from the steady enthalpy balance
 *     tau   = the exchanger's metal-dominated lag
 *     theta = V/Q, the transport delay
 *
 * The shape of this result is the whole argument. K and theta BOTH go as 1/Q. Turn the plant
 * down and the loop gets more sensitive and more delayed at the same time, and the controller
 * that was well tuned at full load now has a fraction of the margin it was commissioned with.
 *
 * @param {object} hx from {@link createExchanger}
 * @param {object} line from {@link createTransportLine}
 * @param {object} u the operating condition
 * @param {number} u.Q_m3h process flow through the exchanger and the line, m3/h
 * @param {number} u.rho_kgm3 process density
 * @param {number} u.cp_JkgK process specific heat
 * @param {number} [u.mUtility_kgs] utility flow, for the exchanger's own lag
 * @param {number} [u.cpUtility_JkgK] utility specific heat
 * @returns {{ok:true, K_KperkW:number, tau_s:number, theta_s:number, ratio:number,
 *   mdot_kgs:number}} the model, or `{ok:false, reason}`
 */
export function temperatureLoopModel(hx, line, u) {
  if (!hx || !line || !u) return { ok: false, reason: 'an exchanger, a line and a condition are required' };
  if (!(u.Q_m3h > 0)) return { ok: false, reason: 'there is no loop at zero flow — the gain and the dead time are both infinite' };
  const mdot = (u.Q_m3h / S_PER_H) * u.rho_kgm3;
  const C = mdot * u.cp_JkgK;
  if (!(C > 0)) return { ok: false, reason: 'the process capacity rate must be positive' };

  const metalHot = hx.metalToHot * hx.metalMass_kg * hx.metalCp_JkgK;
  const tau = (hx.holdupHot_kg * u.cp_JkgK + metalHot) / C;
  const theta = deadTime_s(line, u.Q_m3h);
  return {
    ok: true,
    K_KperkW: 1000 / C,
    tau_s: tau,
    theta_s: theta,
    /**
     * theta/tau, the controllability ratio. Below about 0.2 the loop is lag-dominant and easy;
     * above 1 it is dead-time dominant and no amount of tuning will make it fast. Turndown walks
     * a temperature loop from the first regime into the second.
     */
    ratio: tau > 0 ? theta / tau : Infinity,
    mdot_kgs: mdot,
  };
}

/**
 * How a controller tuned at one operating point has to be rescaled for another.
 *
 * Take any of the standard dead-time-aware tuning rules — SIMC with the closed-loop constant set
 * equal to the dead time is the cleanest to quote — and the proportional gain comes out as
 *
 *     Kc = tau / (K * (tc + theta))   ->   Kc proportional to 1/(K*theta) when theta dominates
 *
 * so a controller moved from a reference flow to a new one needs its gain multiplied by
 * `(K_ref*theta_ref)/(K_now*theta_now)`. Since both K and theta go as 1/Q on a transport-delayed
 * temperature loop, that factor is the SQUARE of the flow ratio: run at half throughput and the
 * controller needs a QUARTER of the gain it had. A fixed-gain temperature loop at half load is
 * carrying four times the loop gain it was commissioned with, and that is why it hunts every time
 * the plant is turned down — not because the tuning was ever wrong.
 *
 * The integral time is scaled by the dead time too, because reset that is fast relative to the
 * delay winds up before the measurement can answer.
 *
 * @param {object} ref the {@link temperatureLoopModel} at the point the controller was tuned
 * @param {object} now the model at the current operating point
 * @returns {{ok:true, kcFactor:number, tiFactor:number, gainRatio:number, deadTimeRatio:number}}
 *   multipliers to apply to the reference tuning, or `{ok:false, reason}`
 */
export function loopScaling(ref, now) {
  if (!ref || !now || !ref.ok || !now.ok) {
    return { ok: false, reason: 'both operating points need a valid loop model' };
  }
  if (!(now.K_KperkW > 0) || !(now.theta_s > 0) || !Number.isFinite(now.theta_s)) {
    return { ok: false, reason: 'the current operating point has no finite dead time' };
  }
  const gainRatio = now.K_KperkW / ref.K_KperkW;
  const deadTimeRatio = now.theta_s / ref.theta_s;
  return {
    ok: true,
    kcFactor: 1 / (gainRatio * deadTimeRatio),
    tiFactor: deadTimeRatio,
    gainRatio,
    deadTimeRatio,
  };
}
