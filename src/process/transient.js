/**
 * src/process/transient.js — water hammer and surge: the method of characteristics on the
 * discharge line, and the four things a pump station actually worries about.
 *
 * Layer L1: imports `core/util.js` and the other `process/` modules. No DOM, no controller, no
 * `Date.now()`. Time arrives as an argument like everywhere else.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THE RIG NEEDS A SECOND HYDRAULIC MODEL AT ALL
 *
 * `plant.js` already carries an inertance: the discharge column has mass, so it has to be
 * decelerated by pressure, and slamming a valve produces a genuine surge. That model is the
 * RIGID COLUMN limit — the whole column accelerates as one body, which is what you get when the
 * pressure wave speed goes to infinity. It is correct for everything slower than a round trip of
 * the line, and it is silently, badly wrong for everything faster.
 *
 * The line is not rigid and the liquid is not incompressible. A disturbance travels at a finite
 * speed `a`, typically 1000-1400 m/s in a steel water line, and the column does not know it has
 * been stopped until the wave gets there. Everything a pump station worries about lives in that
 * gap:
 *
 *   JOUKOWSKY        stop a velocity `v` faster than the reflection can get back and the head
 *                    rise is `a*v/g`, independent of how long the line is and of how much head
 *                    the pump was making. 2 m/s in a steel line is 250 m — 25 bar — on top of
 *                    whatever the header was already at. That is a burst pipe, and it is
 *                    produced by an actuator doing exactly what it was told.
 *   REFLECTION       the wave bounces between the closed valve and the header and the pressure
 *                    at the valve alternates about the static head with period 4L/a. A relief
 *                    valve that opens in longer than 2L/a arrives after the peak has been and
 *                    gone and does nothing at all.
 *   DOWN-SURGE       trip a pump and the first thing that happens is NOT a pressure rise. The
 *                    column keeps going, the pressure behind it collapses, and if it reaches the
 *                    vapour pressure the column separates. The vapour cavity then collapses when
 *                    the column comes back, and the rejoinder is far more violent than the
 *                    original event.
 *   CHECK-VALVE SLAM the reverse flow that follows a trip shuts the check valve. If the valve is
 *                    slow — a heavy swing disc, no damping — reverse velocity builds before the
 *                    disc lands, and it is that reverse velocity, not the original forward one,
 *                    that sets the slam. This is the failure that breaks pump stations.
 *
 * None of it is reachable from a rigid-column model, because in a rigid-column model there is
 * only one velocity and it is the same everywhere.
 *
 * ------------------------------------------------------------------------------------------
 * HOW THIS COEXISTS WITH THE PLANT MODEL — READ THIS BEFORE WIRING IT IN
 *
 * The two models are stepped at different rates and they are NOT two solvers competing for one
 * state. The plant owns the slow story; this file is an optional fast sub-model, armed for an
 * event, driven by the plant, and reporting diagnostics back.
 *
 *   STEP SIZES.   The plant ticks at 20 ms. This line's step is pinned to `dx/a` — for 25 m of
 *                 150 mm steel at 1250 m/s in 8 reaches, 2.5 ms. They cannot share a step and no
 *                 amount of arranging will make them.
 *
 *   INFORMATION FLOWS ONE WAY. Once per plant tick the caller hands the sub-model the header
 *                 head and the valve travel, and calls `advanceSurge` with the plant's `dt_s`;
 *                 that runs as many whole MOC steps as fit. The boundary values are HELD across
 *                 those sub-steps, which is exact enough because the header cannot move
 *                 appreciably in 2.5 ms — that is the same separation of time scales that made
 *                 the sub-model necessary. What comes back is a pressure envelope and a set of
 *                 event flags. Nothing in this file writes to the plant state.
 *
 *   DO NOT DOUBLE-COUNT THE COLUMN. It is tempting to feed this model's node-0 flow back into
 *                 the plant as the discharge flow. If you do, you must ALSO remove the plant's
 *                 own inertance, because the two are the same physics at different fidelities
 *                 and running both puts the mass of the column into the model twice. The
 *                 supported arrangement is: plant integrates, sub-model observes.
 *
 *   WHEN TO STEP IT. Never in normal operation — it costs `N` node solves every 2.5 ms to tell
 *                 you that nothing is happening. Arm it from the steady state at the moment
 *                 something fast begins (a closure command, a trip, a power failure) and step it
 *                 for a few seconds of transient.
 *
 *   THE STABILITY LIMIT. The method of characteristics is stable, and EXACT, when the Courant
 *                 number `Cr = a*dt/dx` is exactly 1: the characteristic launched from a
 *                 neighbouring node lands precisely on this node one step later, and no
 *                 interpolation is needed. `Cr > 1` is unconditionally unstable — the
 *                 characteristic comes from outside the reach and the scheme is reading data it
 *                 does not have. `Cr < 1` requires interpolating the foot of the characteristic,
 *                 and that interpolation is numerically dissipative in a way that is
 *                 indistinguishable, on a plot, from friction damping — it would quietly flatter
 *                 every surge number in this file. So `dt` is NOT a free parameter here: it is
 *                 computed at build as `dx/a` and frozen. Choose it by choosing `reaches`.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT THIS MODEL DOES NOT DO, STATED PLAINLY
 *
 *   QUASI-STEADY FRICTION. The friction term uses the steady-flow Darcy factor at the reach's
 *   instantaneous flow. That is the classical formulation and it is right for the first cycle,
 *   but a real transient carries a reversing velocity profile whose wall shear is much larger
 *   than the steady value at the same mean flow — so a measured trace decays faster than this
 *   one after the first few reflections. The correction is an unsteady-friction term (Brunone's
 *   local-acceleration model, with the coefficient from Vardy and Brown's shear-decay theory).
 *   It is not implemented, because implementing it would break the one property that makes this
 *   file testable against theory: with quasi-steady laminar friction the decay per half period
 *   is exactly `exp(-h_f0/dH_Joukowsky)`, and that is what the test suite checks.
 *
 *   TWO-QUADRANT PUMP DATA. The pump boundary extends the ordinary head-capacity quadratic to
 *   negative flow. That is the standard first approximation and it is fine up to the moment the
 *   shaft reverses; past that a real analysis needs complete four-quadrant (Suter) curves, which
 *   this rig has no data for. The model shuts the check valve before it gets there, which is
 *   both the physical answer and the honest one.
 *
 *   DISCRETE VAPOUR CAVITIES. Column separation is modelled by holding a node at vapour head and
 *   accumulating the volume imbalance there. It is the standard DVCM, it reproduces the
 *   separation and the rejoinder correctly, and it is known to produce spurious pressure spikes
 *   if too many nodes cavitate at once. `surgeSummary` reports how many did, so the reader can
 *   tell a physical rejoinder from a numerical artefact.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, ssqrt, headToBar, G, S_PER_H, ATM_BAR } from '../core/util.js';
import { createPipe, frictionFactor, reynolds, joukowsky_m } from './pipe.js';
import { KV_HEAD } from './valve.js';
import { shaftPower_kW } from './pump.js';

// ---------------------------------------------------------------------------------------------
// Material data — the two elasticities that set the wave speed
// ---------------------------------------------------------------------------------------------

/**
 * Isentropic bulk modulus of liquids, Pa. Source: CRC Handbook / Perry's, at 20 C and
 * atmospheric pressure unless stated. These vary a few percent with temperature and pressure and
 * the wave speed varies as the square root of them, so a few percent here is well inside the
 * uncertainty of the pipe restraint condition and is not worth correlating.
 */
export const BULK_MODULUS_PA = Object.freeze({
  /** Fresh water at 20 C. The reference value in every water-hammer text. */
  WATER: 2.19e9,
  /** Seawater, 3.5% salinity, 20 C — slightly stiffer than fresh. */
  SEAWATER: 2.34e9,
  /** 50% ethylene glycol / water. */
  GLYCOL_50: 2.45e9,
  /** Diesel / light fuel oil. */
  DIESEL: 1.49e9,
  /** Mineral hydraulic and gear oils. The value hydraulic designers use for stiffness sums. */
  MINERAL_OIL: 1.60e9,
});

/**
 * Young's modulus of pipe materials, Pa, and the Poisson ratio that goes with each. Source: the
 * usual mechanical-design tables (ASME B31.3 Appendix C for the metals). The plastics matter
 * more than they look: HDPE is two orders of magnitude softer than steel, which drops the wave
 * speed from about 1250 m/s to about 300 and takes the Joukowsky rise down with it. Buying a
 * plastic line is buying surge protection, and this is the number that says so.
 */
export const PIPE_MATERIAL = Object.freeze({
  STEEL: { E_Pa: 2.07e11, poisson: 0.30 },
  STAINLESS: { E_Pa: 1.93e11, poisson: 0.30 },
  DUCTILE_IRON: { E_Pa: 1.66e11, poisson: 0.28 },
  COPPER: { E_Pa: 1.10e11, poisson: 0.34 },
  GRP: { E_Pa: 1.60e10, poisson: 0.30 },
  PVC_U: { E_Pa: 2.70e9, poisson: 0.38 },
  HDPE_PE100: { E_Pa: 9.0e8, poisson: 0.45 },
});

/**
 * The axial-restraint constant `c1` in the thin-walled wave-speed formula, as a function of the
 * Poisson ratio. Source: Wylie & Streeter, *Fluid Transients in Systems*, the three standard
 * support cases. The spread between them is only a few percent for steel and it is larger for
 * plastics, but the case still has to be chosen rather than assumed, because choosing it is what
 * forces the reader to notice that the pipe's support is part of its hydraulics.
 */
export const RESTRAINT = Object.freeze({
  /** Anchored at the upstream end only, free to move axially elsewhere. */
  ANCHORED_UPSTREAM: 'ANCHORED_UPSTREAM',
  /** Anchored against axial movement throughout — the usual buried or heavily guided line. */
  ANCHORED_THROUGHOUT: 'ANCHORED_THROUGHOUT',
  /** Expansion joints throughout: no axial stress is carried at all. */
  EXPANSION_JOINTS: 'EXPANSION_JOINTS',
});

/**
 * The restraint constant for a case and a Poisson ratio.
 * @param {string} restraint one of {@link RESTRAINT}
 * @param {number} poisson Poisson ratio of the pipe material
 * @returns {number} c1, dimensionless
 */
function restraintC1(restraint, poisson) {
  switch (restraint) {
    case RESTRAINT.ANCHORED_UPSTREAM: return 1 - poisson / 2;
    case RESTRAINT.ANCHORED_THROUGHOUT: return 1 - poisson * poisson;
    default: return 1;
  }
}

/**
 * Pressure wave speed in a liquid-filled pipe, m/s.
 *
 *     a = sqrt( (K/rho) / (1 + (K/E)*(D/e)*c1) )
 *
 * The numerator alone is the speed of sound in the unconfined liquid — 1481 m/s in water. The
 * denominator is the pipe giving way: every increment of pressure swells the bore, that swelling
 * stores liquid, and stored liquid is indistinguishable from compressed liquid as far as the wave
 * is concerned. A thin large-bore pipe is a soft pipe.
 *
 * FREE GAS. The optional void fraction is not a refinement, it is the single largest uncertainty
 * in any real surge calculation. Gas is enormously more compressible than either the liquid or
 * the pipe, so a very small amount of it dominates both: at 1 bar absolute, two parts in ten
 * thousand of entrained air takes water in a steel line from about 1250 m/s to below 800. The
 * mixture bulk modulus is the series sum
 *
 *     1/K_mix = (1 - alpha)/K_liquid + alpha/(n * p_abs)
 *
 * with `n` the polytropic exponent of the gas. This is why a surge study on a line that has just
 * been filled and not properly vented is worth very little, and why the same line gives a
 * different answer in the morning.
 *
 * @param {object} spec the line and its liquid
 * @param {number} spec.bulk_Pa liquid bulk modulus, Pa — see {@link BULK_MODULUS_PA}
 * @param {number} spec.rho_kgm3 liquid density, kg/m3
 * @param {number} spec.id_mm pipe internal diameter, mm
 * @param {number} spec.wall_mm pipe wall thickness, mm
 * @param {number} spec.youngs_Pa pipe Young's modulus, Pa — see {@link PIPE_MATERIAL}
 * @param {number} [spec.poisson=0.3] pipe Poisson ratio
 * @param {string} [spec.restraint='ANCHORED_THROUGHOUT'] one of {@link RESTRAINT}
 * @param {number} [spec.gasFraction=0] volumetric free-gas fraction at `pAbs_bar`, 0..0.05
 * @param {number} [spec.pAbs_bar=1.01325] absolute pressure the gas fraction is quoted at, bar
 * @param {number} [spec.gasPolytropic=1.2] polytropic exponent of the entrained gas
 * @returns {number} wave speed, m/s
 */
export function waveSpeed_ms(spec) {
  const poisson = spec.poisson === undefined ? 0.3 : spec.poisson;
  const c1 = restraintC1(spec.restraint || RESTRAINT.ANCHORED_THROUGHOUT, poisson);
  const alpha = clamp(spec.gasFraction || 0, 0, 0.05);
  const pAbs = Math.max((spec.pAbs_bar === undefined ? ATM_BAR : spec.pAbs_bar) * 1e5, 1e3);
  const n = spec.gasPolytropic === undefined ? 1.2 : spec.gasPolytropic;

  const Kliq = spec.bulk_Pa;
  const Kmix = alpha > 0 ? 1 / ((1 - alpha) / Kliq + alpha / (n * pAbs)) : Kliq;
  const rhoMix = spec.rho_kgm3 * (1 - alpha);

  const D = spec.id_mm / 1000;
  const e = Math.max(spec.wall_mm, 0.05) / 1000;
  const compliance = 1 + (Kmix / spec.youngs_Pa) * (D / e) * c1;
  return Math.sqrt(Kmix / rhoMix / compliance);
}

// ---------------------------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------------------------

/** What sits at the upstream end of the modelled line. */
export const UPSTREAM = Object.freeze({
  /**
   * A fixed head. This is the header seen from the fast model: over one MOC step it is a
   * reservoir, because the surge vessel and the rest of the plant cannot move in 2.5 ms.
   */
  RESERVOIR: 'RESERVOIR',
  /** A pump behind a check valve, with shaft inertia so it can be tripped and coast down. */
  PUMP: 'PUMP',
});

/** What sits at the downstream end. */
export const DOWNSTREAM = Object.freeze({
  /** A valve discharging to a fixed downstream head. Its opening is the transient's driver. */
  VALVE: 'VALVE',
  /** A blank flange. No flow ever leaves; the line is a closed organ pipe. */
  DEAD_END: 'DEAD_END',
});

/**
 * Build a frozen surge line: geometry, wave speed, discretisation, and the boundary devices.
 *
 * The reach count is the only discretisation knob, and it buys two different things at once —
 * spatial resolution of the envelope, and the time step, which is `L/(N*a)`. More reaches is a
 * finer picture and a proportionally slower model, and there is no accuracy argument for going
 * past the point where the envelope stops changing shape.
 *
 * Throws rather than returning a reason, because a line that cannot be discretised is a
 * programming error at build time and not a runtime condition — the same call the pump
 * constructor makes.
 *
 * @param {object} spec the line
 * @param {string} spec.tag line number, e.g. '150-PL-103'
 * @param {number} spec.length_m developed length from the upstream device to the valve, m
 * @param {number} spec.id_mm internal diameter, mm
 * @param {number} spec.waveSpeed_ms pressure wave speed, from {@link waveSpeed_ms}
 * @param {number} spec.rho_kgm3 liquid density, kg/m3
 * @param {number} spec.nu_cSt kinematic viscosity, mm2/s
 * @param {number} spec.pVap_bar liquid vapour pressure, bar absolute
 * @param {number} [spec.pAtm_bar=1.01325] site barometric pressure, bar absolute
 * @param {number} [spec.roughness_mm=0.045] absolute roughness, mm
 * @param {number} [spec.reaches=8] number of reaches; nodes are `reaches + 1`
 * @param {boolean} [spec.frictionless=false] drop the friction term entirely. For validation
 *   against Joukowsky and for showing what friction is actually worth — not for design.
 * @param {number} [spec.zUp_m=0] elevation of the upstream end above the head datum, m
 * @param {number} [spec.zDown_m=0] elevation of the downstream end, m
 * @param {number[]} [spec.profile_m] explicit node elevations, `reaches + 1` of them. A knee or a
 *   summit is where a line separates on a trip, and a straight interpolation hides it.
 * @param {string} [spec.upstream='RESERVOIR'] one of {@link UPSTREAM}
 * @param {object} [spec.pump] the pump, when `upstream` is `PUMP` — a pump object from
 *   `pump.js`, derated or not
 * @param {number} [spec.pumpInertia_kgm2] combined pump, coupling and motor rotor inertia, kg m2.
 *   The coast-down time is proportional to it, so it is the number that decides whether a trip
 *   produces a gentle deceleration or a column separation.
 * @param {number} [spec.suctionHead_m=0] head at the pump suction, m — the pump curve stands on it
 * @param {number} [spec.checkCloseDelay_s=0] how long after flow reversal the check valve lands.
 *   Zero is an ideal valve and produces no slam at all; a slow swing check is 0.2 to 1 s and
 *   produces the classic one.
 * @param {number} [spec.dragTorque_Nm=0] bearing and windage torque, so a coasting shaft stops
 * @param {string} [spec.downstream='VALVE'] one of {@link DOWNSTREAM}
 * @param {object} [spec.vessel] an air vessel at the upstream node — see {@link sizeAirVessel}
 * @param {number} spec.vessel.gasVolume_m3 gas volume at the initial steady head
 * @param {number} [spec.vessel.polytropic=1.2] polytropic exponent of the gas
 * @param {number} [spec.vessel.outK] resistance out of the vessel, m per (m3/s)^2
 * @param {number} [spec.vessel.inK] resistance back into it — deliberately larger, see below
 * @param {number} [spec.vessel.z_m=0] elevation of the vessel connection, m
 * @returns {object} the frozen line
 */
export function createSurgeLine(spec) {
  const N = Math.max(2, Math.round(spec.reaches === undefined ? 8 : spec.reaches));
  if (!(spec.length_m > 0)) throw new Error(`${spec.tag}: length_m must be positive`);
  if (!(spec.waveSpeed_ms > 0)) throw new Error(`${spec.tag}: waveSpeed_ms must be positive`);
  if (!(spec.id_mm > 0)) throw new Error(`${spec.tag}: id_mm must be positive`);

  const dx = spec.length_m / N;
  // Cr = a*dt/dx == 1 exactly. See the header: this is not a tuning parameter.
  const dt = dx / spec.waveSpeed_ms;
  const D = spec.id_mm / 1000;
  const A = (Math.PI * D * D) / 4;

  // One reach, as an ordinary pipe, so the friction factor comes from the same Swamee-Jain
  // implementation the steady model uses instead of a second opinion written here.
  const reachPipe = createPipe({
    tag: `${spec.tag}/reach`,
    id_mm: spec.id_mm,
    length_m: dx,
    roughness_mm: spec.roughness_mm,
    sumK: 0,
  });

  const zUp = spec.zUp_m || 0;
  const zDown = spec.zDown_m || 0;
  const z = new Float64Array(N + 1);
  for (let i = 0; i <= N; i += 1) {
    z[i] = spec.profile_m && spec.profile_m.length === N + 1
      ? spec.profile_m[i]
      : zUp + ((zDown - zUp) * i) / N;
  }

  // Vapour head at each node, as a PIEZOMETRIC head on the same datum as H. The liquid boils
  // when its absolute pressure reaches p_vap, i.e. when H - z + p_atm/(rho g) = p_vap/(rho g).
  const pAtm = spec.pAtm_bar === undefined ? ATM_BAR : spec.pAtm_bar;
  const vapourOffset = ((spec.pVap_bar - pAtm) * 1e5) / (spec.rho_kgm3 * G);
  const hVap = new Float64Array(N + 1);
  for (let i = 0; i <= N; i += 1) hVap[i] = z[i] + vapourOffset;

  const vessel = spec.vessel
    ? Object.freeze({
      gasVolume_m3: spec.vessel.gasVolume_m3,
      polytropic: spec.vessel.polytropic === undefined ? 1.2 : spec.vessel.polytropic,
      // Differential throttling: cheap on the way out, expensive on the way back. The vessel
      // must be free to feed the line the instant the pump stops, or it protects nothing; but
      // the returning column has to be dissipated, or the vessel simply hands the surge back.
      // Four to one is the usual ratio and the reason air-vessel connections carry an orifice
      // plate with a bypass check valve rather than a plain nozzle.
      outK: spec.vessel.outK === undefined ? 2 : spec.vessel.outK,
      inK: spec.vessel.inK === undefined ? 8 : spec.vessel.inK,
      z_m: spec.vessel.z_m || 0,
    })
    : null;

  const upstream = spec.upstream || UPSTREAM.RESERVOIR;
  if (vessel && upstream !== UPSTREAM.PUMP) {
    throw new Error(`${spec.tag}: an air vessel only means anything behind a pump check valve`);
  }
  if (upstream === UPSTREAM.PUMP && !spec.pump) {
    throw new Error(`${spec.tag}: upstream PUMP needs a pump object`);
  }

  return Object.freeze({
    tag: spec.tag,
    N,
    nodes: N + 1,
    length_m: spec.length_m,
    dx_m: dx,
    /** The MOC step, s. Pinned to dx/a; the Courant number is exactly 1 by construction. */
    dt_s: dt,
    a_ms: spec.waveSpeed_ms,
    id_m: D,
    area_m2: A,
    rho_kgm3: spec.rho_kgm3,
    nu_cSt: spec.nu_cSt,
    pVap_bar: spec.pVap_bar,
    pAtm_bar: pAtm,
    /** The characteristic impedance a/(gA), m of head per m3/s. Joukowsky is `B*Q`. */
    B: spec.waveSpeed_ms / (G * A),
    reachPipe,
    frictionless: !!spec.frictionless,
    z_m: z,
    hVap_m: hVap,
    upstream,
    downstream: spec.downstream || DOWNSTREAM.VALVE,
    pump: spec.pump || null,
    pumpInertia_kgm2: spec.pumpInertia_kgm2 === undefined ? 0.5 : spec.pumpInertia_kgm2,
    suctionHead_m: spec.suctionHead_m || 0,
    checkCloseDelay_s: spec.checkCloseDelay_s || 0,
    dragTorque_Nm: spec.dragTorque_Nm || 0,
    vessel,
    /** Round-trip time. Anything faster than this is a "rapid" closure and gets full Joukowsky. */
    criticalTime_s: (2 * spec.length_m) / spec.waveSpeed_ms,
    /** The natural period of the closed line: the wave has to go down and back twice. */
    period_s: (4 * spec.length_m) / spec.waveSpeed_ms,
  });
}

/**
 * Allocate the mutable state of a surge line. Every array is one entry per NODE.
 *
 * Each node carries two flows, not one. Ordinarily they are equal and the split is redundant —
 * but when a node separates, the liquid arriving from upstream and the liquid leaving downstream
 * are genuinely different flows with a vapour cavity between them, and that difference is the
 * cavity's growth rate. Carrying the split everywhere costs one array and removes the special
 * case entirely.
 *
 * @param {object} line from {@link createSurgeLine}
 * @returns {object} the mutable state
 */
export function createSurgeState(line) {
  const n = line.nodes;
  return {
    /** Elapsed transient time, s. Advanced only by {@link stepSurge}. */
    t_s: 0,
    /** MOC steps taken since arming. */
    steps: 0,
    /** Piezometric head at each node, m. */
    H_m: new Float64Array(n),
    /** Flow arriving at each node from upstream, m3/s. */
    Qu_m3s: new Float64Array(n),
    /** Flow leaving each node downstream, m3/s. */
    Qd_m3s: new Float64Array(n),
    /** Vapour cavity volume at each node, m3. Zero everywhere in a healthy line. */
    cavity_m3: new Float64Array(n),
    /** Largest cavity each node has held, m3 — the number a separation study reports. */
    maxCavity_m3: new Float64Array(n),
    /** Highest head each node has seen since arming, m. */
    maxH_m: new Float64Array(n),
    /** Lowest head each node has seen since arming, m. */
    minH_m: new Float64Array(n),
    /** Reach friction coefficients, m per (m3/s)^2, refreshed each step. */
    reachR: new Float64Array(line.N),
    /** Scratch for the new time level; the MOC is not an in-place update. */
    _H: new Float64Array(n),
    _Qu: new Float64Array(n),
    _Qd: new Float64Array(n),
    /** Steady-state flow the line was armed at, m3/s. Joukowsky is measured against it. */
    Q0_m3s: 0,
    /** Steady head at the upstream node when armed, m. */
    H0_m: 0,
    /** The downstream system head the valve discharges to, m. */
    Hdown_m: 0,
    /** Valve discharge coefficient at full opening, m3/s per sqrt(m). */
    valveCd: 0,
    /** Pump speed ratio, N/Nrated. Held while running; integrated once tripped. */
    s: 0,
    /** True once the pump has lost its supply. */
    tripped: false,
    /** True while the discharge check valve is passing. */
    checkOpen: true,
    /** When flow first reversed through the check valve, s; negative when it has not. */
    reverseSince_s: -1,
    /** The slam event, once the check valve has landed. Null until then. */
    slam: null,
    /** Gas volume in the air vessel, m3. */
    vesselGas_m3: 0,
    /** The polytropic constant p*V^n for the vessel gas, Pa m^(3n). */
    vesselPV: 0,
    /** Flow out of the vessel into the line, m3/s. Negative when the surge is refilling it. */
    vesselQ_m3s: 0,
    /** Seconds of plant time not yet consumed by whole MOC steps. */
    carry_s: 0,
    /** True once any node has held a vapour cavity. */
    separated: false,
    /** True once the line has been armed; stepping before that is refused. */
    armed: false,
  };
}

/**
 * Set the line to its steady operating point and reset every peak tracker.
 *
 * The initial condition is the DISCRETE steady state, not the continuous one: the head profile
 * is stepped down reach by reach with the same friction coefficient the stepper will use. If it
 * were seeded from the continuous solution instead, the very first step would find a residual
 * and the line would ring before anybody touched anything — and that ringing would then be
 * indistinguishable from the transient under study.
 *
 * @param {object} line the frozen line
 * @param {object} st state from {@link createSurgeState} (mutated)
 * @param {object} init the steady point
 * @param {number} init.Q_m3h steady flow along the line, m3/h
 * @param {number} init.Hup_m head at the upstream node, m
 * @param {number} [init.Hdown_m] head of the system the valve discharges into, m. Defaults to
 *   the head just downstream of a fully open valve taking a tenth of the line's friction loss.
 * @param {number} [init.s=1] pump speed ratio, when there is a pump
 * @returns {{ok:boolean, reason?:string, Hvalve_m?:number, Hdown_m?:number, dHvalve_m?:number}}
 *   whether the arm succeeded and the steady heads it produced
 */
export function armSurge(line, st, init) {
  const Q0 = (init.Q_m3h || 0) / S_PER_H;
  if (!Number.isFinite(Q0) || !Number.isFinite(init.Hup_m)) {
    return { ok: false, reason: 'Q_m3h and Hup_m must be finite' };
  }
  if (line.downstream === DOWNSTREAM.DEAD_END && Math.abs(Q0) > 1e-9) {
    return { ok: false, reason: 'a dead-ended line cannot carry a steady flow' };
  }

  refreshFriction(line, st, Q0);
  st.H_m[0] = init.Hup_m;
  st.Qu_m3s[0] = Q0;
  st.Qd_m3s[0] = Q0;
  for (let i = 1; i <= line.N; i += 1) {
    st.H_m[i] = st.H_m[i - 1] - st.reachR[i - 1] * Q0 * Math.abs(Q0);
    st.Qu_m3s[i] = Q0;
    st.Qd_m3s[i] = Q0;
  }

  const Hvalve = st.H_m[line.N];
  let Hdown = init.Hdown_m;
  if (Hdown === undefined) {
    const drop = Math.max(0.1 * Math.abs(init.Hup_m - Hvalve), 1);
    Hdown = Hvalve - drop;
  }
  if (line.downstream === DOWNSTREAM.VALVE && Math.abs(Q0) > 1e-9 && !(Hvalve - Hdown > 0)) {
    return { ok: false, reason: 'the valve needs a positive differential to pass the steady flow' };
  }

  st.t_s = 0;
  st.steps = 0;
  st.carry_s = 0;
  st.Q0_m3s = Q0;
  st.H0_m = init.Hup_m;
  st.Hdown_m = Hdown;
  // The classical dimensionless valve opening: tau = 1 is whatever the valve was passing when
  // the transient started, tau = 0 is shut. Referring it to the steady point rather than to a
  // catalogue Kv is what lets a surge study be run on a valve nobody has the datasheet for.
  st.valveCd = Math.abs(Q0) > 1e-12 ? Q0 / Math.sqrt(Math.max(Hvalve - Hdown, 1e-9)) : 0;
  st.s = init.s === undefined ? 1 : init.s;
  st.tripped = false;
  st.checkOpen = true;
  st.reverseSince_s = -1;
  st.slam = null;
  st.separated = false;
  st.armed = true;
  st.cavity_m3.fill(0);
  st.maxCavity_m3.fill(0);
  st.vesselQ_m3s = 0;

  if (line.vessel) {
    st.vesselGas_m3 = line.vessel.gasVolume_m3;
    const pAbs = line.pAtm_bar * 1e5 + line.rho_kgm3 * G * (init.Hup_m - line.vessel.z_m);
    st.vesselPV = Math.max(pAbs, 1e3) * Math.pow(st.vesselGas_m3, line.vessel.polytropic);
  }

  for (let i = 0; i <= line.N; i += 1) {
    st.maxH_m[i] = st.H_m[i];
    st.minH_m[i] = st.H_m[i];
  }
  return { ok: true, Hvalve_m: Hvalve, Hdown_m: Hdown, dHvalve_m: Hvalve - Hdown };
}

/**
 * Refresh the per-reach friction coefficient `R` in `h_f = R*Q*|Q|`.
 *
 *     R = f * dx / (2 * g * D * A^2)
 *
 * `f` comes from `pipe.js` at the reach's own Reynolds number, which means the laminar branch is
 * carried automatically: there `f = 64/Re` varies as `1/|Q|`, so `R*|Q|` is a constant and the
 * damping becomes linear in flow. That is not a special case bolted on — it is the physics, and
 * it is the case for which the decay has a closed form.
 *
 * @param {object} line the line
 * @param {object} st state (its `reachR` is written)
 * @param {number} [Quniform_m3s] a single flow to evaluate every reach at, for arming
 * @returns {void}
 */
function refreshFriction(line, st, Quniform_m3s) {
  if (line.frictionless) { st.reachR.fill(0); return; }
  const k = line.dx_m / (2 * G * line.id_m * line.area_m2 * line.area_m2);
  for (let i = 0; i < line.N; i += 1) {
    const Q = Quniform_m3s === undefined
      ? 0.5 * (st.Qd_m3s[i] + st.Qu_m3s[i + 1])
      : Quniform_m3s;
    const Re = reynolds(line.reachPipe, Math.abs(Q) * S_PER_H, line.nu_cSt);
    st.reachR[i] = k * frictionFactor(line.reachPipe, Re);
  }
}

// ---------------------------------------------------------------------------------------------
// The stepper
// ---------------------------------------------------------------------------------------------

/**
 * Advance the line by exactly one MOC step of `line.dt_s`.
 *
 * ------------------------------------------------------------------------------------------
 * THE METHOD, IN THE FORM THAT IS ACTUALLY CODED
 *
 * The two partial differential equations of unsteady closed-conduit flow — continuity and
 * momentum — combine along the two characteristic directions `dx/dt = +/-a` into two ordinary
 * differential equations. Integrated over one step at Cr = 1 they become two straight lines in
 * the (H, Q) plane at the node being solved:
 *
 *     C+ (from the upstream neighbour):   H = C_P - B_P*Q      C_P = H[i-1] + B*Qd[i-1]
 *     C- (from the downstream neighbour): H = C_M + B_M*Q      C_M = H[i+1] - B*Qu[i+1]
 *
 * with `B = a/(gA)` the characteristic impedance and `B_P`, `B_M` carrying the friction of the
 * reach each characteristic crossed, `B + R*|Q|`. Putting friction into the SLOPE rather than
 * into the intercept is what keeps the scheme stable when the friction term is large; the
 * explicit form goes unstable exactly where a long viscous line needs it most.
 *
 * An interior node has both characteristics, so its two unknowns are fully determined and the
 * solve is two lines of arithmetic with no iteration. A boundary node has only one, and the
 * missing equation is the device: a reservoir head, a valve's square-root law, a pump curve.
 * That is the whole architecture, and it is why a boundary device can be as nonlinear as it
 * likes without threatening the interior.
 *
 * COLUMN SEPARATION overrides all of it. If the head a node wants is below the local vapour
 * head, the liquid cannot be there: the node is pinned at vapour head, the two characteristics
 * are solved SEPARATELY for the flow arriving and the flow leaving, and the difference
 * accumulates as cavity volume. The cavity collapses when that volume returns to zero, and the
 * collapse is what produces the second, larger pressure peak on a pump trip.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} line the frozen line
 * @param {object} st state (mutated)
 * @param {object} [bc] boundary conditions for this step, held constant across it
 * @param {number} [bc.Hup_m] upstream head, m — for an `UPSTREAM.RESERVOIR` line
 * @param {number} [bc.tau=1] valve opening, 1 at the armed steady state and 0 shut
 * @param {number} [bc.Hdown_m] downstream system head, m; defaults to the armed value
 * @param {boolean} [bc.tripped] set once to trip the pump; it then coasts on its own inertia
 * @param {number} [bc.s] pump speed ratio while it is still driven
 * @returns {{ok:boolean, reason?:string}} refusal rather than a throw, so a UI can step blindly
 */
export function stepSurge(line, st, bc) {
  if (!st.armed) return { ok: false, reason: 'armSurge first' };
  const b = bc || {};
  const dt = line.dt_s;
  const N = line.N;
  const B = line.B;
  const tau = b.tau === undefined ? 1 : Math.max(0, b.tau);
  const Hdown = b.Hdown_m === undefined ? st.Hdown_m : b.Hdown_m;

  if (b.tripped) st.tripped = true;
  refreshFriction(line, st);

  const H = st.H_m;
  const Qu = st.Qu_m3s;
  const Qd = st.Qd_m3s;
  const nH = st._H;
  const nQu = st._Qu;
  const nQd = st._Qd;

  // --- interior nodes ------------------------------------------------------------------------
  for (let i = 1; i < N; i += 1) {
    const Bp = B + st.reachR[i - 1] * Math.abs(Qd[i - 1]);
    const Bm = B + st.reachR[i] * Math.abs(Qu[i + 1]);
    const Cp = H[i - 1] + B * Qd[i - 1];
    const Cm = H[i + 1] - B * Qu[i + 1];
    solveNode(line, st, i, Cp, Bp, Cm, Bm, dt, nH, nQu, nQd);
  }

  // --- upstream node -------------------------------------------------------------------------
  {
    const Bm = B + st.reachR[0] * Math.abs(Qu[1]);
    const Cm = H[1] - B * Qu[1];
    upstreamNode(line, st, Cm, Bm, b, dt, nH, nQu, nQd);
  }

  // --- downstream node -----------------------------------------------------------------------
  {
    const Bp = B + st.reachR[N - 1] * Math.abs(Qd[N - 1]);
    const Cp = H[N - 1] + B * Qd[N - 1];
    downstreamNode(line, st, Cp, Bp, tau, Hdown, dt, nH, nQu, nQd);
  }

  H.set(nH);
  Qu.set(nQu);
  Qd.set(nQd);

  st.t_s += dt;
  st.steps += 1;
  for (let i = 0; i <= N; i += 1) {
    if (H[i] > st.maxH_m[i]) st.maxH_m[i] = H[i];
    if (H[i] < st.minH_m[i]) st.minH_m[i] = H[i];
    if (st.cavity_m3[i] > st.maxCavity_m3[i]) st.maxCavity_m3[i] = st.cavity_m3[i];
  }
  return { ok: true };
}

/**
 * Solve one node from its two characteristics, honouring column separation.
 * @param {object} line the line
 * @param {object} st state (its cavity volume is advanced)
 * @param {number} i node index
 * @param {number} Cp C+ intercept, m
 * @param {number} Bp C+ slope, m per (m3/s)
 * @param {number} Cm C- intercept, m
 * @param {number} Bm C- slope, m per (m3/s)
 * @param {number} dt step, s
 * @param {Float64Array} nH new heads
 * @param {Float64Array} nQu new upstream-side flows
 * @param {Float64Array} nQd new downstream-side flows
 * @returns {void}
 */
function solveNode(line, st, i, Cp, Bp, Cm, Bm, dt, nH, nQu, nQd) {
  const Q = (Cp - Cm) / (Bp + Bm);
  const h = Cp - Bp * Q;
  const hv = line.hVap_m[i];
  if (st.cavity_m3[i] <= 0 && h >= hv) {
    nH[i] = h;
    nQu[i] = Q;
    nQd[i] = Q;
    return;
  }
  // Separated: the node is a vapour pocket at constant pressure, and the two characteristics
  // no longer see one flow.
  const qIn = (Cp - hv) / Bp;
  const qOut = (hv - Cm) / Bm;
  const vol = st.cavity_m3[i] + (qOut - qIn) * dt;
  if (vol > 0) {
    st.cavity_m3[i] = vol;
    st.separated = true;
    nH[i] = hv;
    nQu[i] = qIn;
    nQd[i] = qOut;
    return;
  }
  // The cavity has just closed. The column rejoins and the node returns to ordinary liquid —
  // which is where the rejoinder spike comes from, and it is not a numerical artefact.
  st.cavity_m3[i] = 0;
  nH[i] = h;
  nQu[i] = Q;
  nQd[i] = Q;
}

/**
 * Solve the upstream node: a reservoir, or a pump with its check valve and optional air vessel.
 * @param {object} line the line
 * @param {object} st state (mutated: pump speed, check valve, vessel, cavity)
 * @param {number} Cm C- intercept, m
 * @param {number} Bm C- slope, m per (m3/s)
 * @param {object} b boundary conditions for this step
 * @param {number} dt step, s
 * @param {Float64Array} nH new heads
 * @param {Float64Array} nQu new upstream-side flows
 * @param {Float64Array} nQd new downstream-side flows
 * @returns {void}
 */
function upstreamNode(line, st, Cm, Bm, b, dt, nH, nQu, nQd) {
  if (line.upstream === UPSTREAM.RESERVOIR) {
    const h = b.Hup_m === undefined ? st.H0_m : b.Hup_m;
    const q = (h - Cm) / Bm;
    nH[0] = h;
    nQu[0] = q;
    nQd[0] = q;
    return;
  }

  // A pump. Its shaft speed is either held by the drive or, once tripped, integrated against the
  // shaft inertia: the machine is being braked by the liquid it is still trying to pump, and the
  // rate at which it loses speed is the rate at which the line loses its supply.
  if (st.tripped) {
    const omegaRated = (2 * Math.PI * line.pump.nRated_rpm) / 60;
    const omega = Math.max(st.s * omegaRated, 1e-6);
    const shaft_W = shaftPower_kW(line.pump, Math.max(st.Qd_m3s[0], 0) * S_PER_H, st.s,
      line.rho_kgm3) * 1000;
    const torque = shaft_W / omega + line.dragTorque_Nm;
    const domega = (-torque / Math.max(line.pumpInertia_kgm2, 1e-6)) * dt;
    st.s = Math.max(0, (omega + domega) / omegaRated);
  } else if (b.s !== undefined) {
    st.s = b.s;
  }

  // The check valve's state is the one held from the END of the previous step, and the node is
  // solved with it. Closing on the same step it reverses would need a nested solve — decide the
  // state, resolve the node, discover the state was wrong — and at 2.5 ms the one-step lag is
  // three millimetres of disc travel. The lag is the cheap answer and it is also the honest one:
  // a real disc does not know it has to move until flow has already reversed past it.
  // Everything feeding the node, as a function of the head the node ends up at. The pump only
  // counts while its check valve is passing; the vessel counts either way, because a vessel is
  // fitted DOWNSTREAM of the check valve and staying connected after the valve shuts is the
  // entire reason it is there.
  const hVes = line.vessel ? vesselHead(line, st) : 0;
  const supply = (h) => (st.checkOpen ? pumpFlow(line, st, h) : 0)
    + (line.vessel ? vesselFlow(line, hVes, h) : 0);

  let h0;
  if (line.vessel) {
    // Pump, vessel and line meet at one node, so the node head is whatever balances the three
    // flows. Every branch flow is monotone in that head — the pump falls with it, the vessel
    // falls with it, the line rises with it — so the residual is strictly decreasing and a
    // bisection on a bracket that cannot fail is the right solver. No iteration here can diverge
    // mid-transient, which matters more than the handful of arithmetic operations it costs.
    let lo = -1e4;
    let hi = 1e5;
    for (let k = 0; k < 60; k += 1) {
      const mid = 0.5 * (lo + hi);
      if (supply(mid) - (mid - Cm) / Bm > 0) lo = mid; else hi = mid;
    }
    h0 = 0.5 * (lo + hi);
  } else if (st.checkOpen) {
    // No vessel: the pump curve and the C- characteristic are one quadratic, solved in closed
    // form. See `solveBranchFlow` in pump.js — this is the same algebra with the header's
    // resistance replaced by the line's characteristic impedance.
    const A1 = line.pump.a1 * S_PER_H;
    const A2 = line.pump.a2 * S_PER_H * S_PER_H;
    const beta = st.s * A1 + Bm;
    const gamma = Cm - line.suctionHead_m - st.s * st.s * line.pump.H0_m;
    const disc = beta * beta - 4 * A2 * gamma;
    h0 = Cm + Bm * (disc > 0 ? (-beta + Math.sqrt(disc)) / (2 * A2) : 0);
  } else {
    h0 = Cm;
  }

  // Column separation at the pump. If the head the node wants is below vapour it cannot have it,
  // so the node is pinned at vapour head and the SOURCES ARE RE-EVALUATED THERE — a pump
  // discharging into a vapour pocket is working against vapour pressure, not against the head it
  // would have made had the pocket not been there. Getting that wrong makes the check valve
  // reverse at the wrong instant and puts the slam in the wrong place.
  const hv = line.hVap_m[0];
  let cavitating = false;
  let qIn = supply(h0);
  let qOut = qIn;
  if (st.cavity_m3[0] > 0 || h0 < hv) {
    qIn = supply(hv);
    qOut = (hv - Cm) / Bm;
    const vol = st.cavity_m3[0] + (qOut - qIn) * dt;
    if (vol > 0) {
      st.cavity_m3[0] = vol;
      st.separated = true;
      cavitating = true;
    } else {
      st.cavity_m3[0] = 0;
      qIn = supply(h0);
      qOut = qIn;
    }
  }
  nH[0] = cavitating ? hv : h0;
  nQu[0] = qIn;
  nQd[0] = qOut;

  if (line.vessel) {
    const qVes = vesselFlow(line, hVes, nH[0]);
    // Trapezoidal on the vessel volume. Explicit Euler here drifts the gas mass over a few
    // thousand steps, and a vessel that has quietly changed size is a sizing study that lies.
    st.vesselGas_m3 = Math.max(1e-9, st.vesselGas_m3 + 0.5 * (st.vesselQ_m3s + qVes) * dt);
    st.vesselQ_m3s = qVes;
  }

  // The check valve, decided here for the NEXT step. It passes forward flow without comment; on
  // reversal it starts to land, and `checkCloseDelay_s` is how long that takes. An ideal valve
  // (zero delay) makes almost no slam at all, which is exactly the point: the slam is manufactured
  // by the disc's own travel time, and the fix for it is a better valve, not a thicker pipe.
  const through = st.checkOpen ? pumpFlow(line, st, nH[0]) : 0;
  if (st.checkOpen) {
    if (through < 0) {
      if (st.reverseSince_s < 0) st.reverseSince_s = st.t_s;
      if (st.t_s - st.reverseSince_s >= line.checkCloseDelay_s) {
        st.checkOpen = false;
        const vRev = Math.abs(through) / line.area_m2;
        st.slam = {
          t_s: st.t_s,
          vReverse_ms: vRev,
          /** What shutting on that reverse velocity is worth, by Joukowsky. */
          joukowsky_m: joukowsky_m(vRev, line.a_ms),
          /** Head at the pump discharge the instant before the disc landed, m. */
          hBefore_m: nH[0],
          /** The rise the landing actually produced, filled in on the following step, m. */
          dH_m: 0,
        };
      }
    } else {
      st.reverseSince_s = -1;
    }
  } else if (pumpFlow(line, st, nH[0]) > 0) {
    // The pump has recovered enough head to push the disc off its seat again. A station that
    // restarts into a live line does exactly this, and so does a vessel that has finished
    // refilling.
    st.checkOpen = true;
    st.reverseSince_s = -1;
  }
  if (st.slam && st.slam.dH_m === 0 && st.t_s > st.slam.t_s) {
    st.slam.dH_m = nH[0] - st.slam.hBefore_m;
  }
}

/**
 * Flow a pump passes into a given node head, extended to negative flow.
 * @param {object} line the line
 * @param {object} st state, for the current speed ratio
 * @param {number} h node head, m
 * @returns {number} pump flow, m3/s
 */
function pumpFlow(line, st, h) {
  const A1 = line.pump.a1 * S_PER_H;
  const A2 = line.pump.a2 * S_PER_H * S_PER_H;
  const avail = line.suctionHead_m + st.s * st.s * line.pump.H0_m - h;
  const disc = st.s * st.s * A1 * A1 + 4 * A2 * avail;
  if (!(disc > 0)) return 0;
  return (-st.s * A1 + Math.sqrt(disc)) / (2 * A2);
}

/**
 * Piezometric head at the air vessel's gas, from the polytropic law on the current gas volume.
 * @param {object} line the line
 * @param {object} st state
 * @returns {number} head, m
 */
function vesselHead(line, st) {
  const pAbs = st.vesselPV / Math.pow(Math.max(st.vesselGas_m3, 1e-9), line.vessel.polytropic);
  return (pAbs - line.pAtm_bar * 1e5) / (line.rho_kgm3 * G) + line.vessel.z_m;
}

/**
 * Flow out of the air vessel into the node, through its differential throttle.
 * @param {object} line the line
 * @param {number} hVes vessel gas head, m
 * @param {number} hNode node head, m
 * @returns {number} flow out of the vessel, m3/s; negative when the line is refilling it
 */
function vesselFlow(line, hVes, hNode) {
  const dh = hVes - hNode;
  const K = Math.max(dh >= 0 ? line.vessel.outK : line.vessel.inK, 1e-9);
  return ssqrt(dh / K);
}

/**
 * Solve the downstream node when nothing leaves it — a shut valve or a blank flange.
 *
 * With no outflow the C+ characteristic alone fixes the head, and `H = C_P` is the Joukowsky
 * jump written out: `C_P = H_upstream + B*Q`, and `B*Q` is `a*v/g`. The rise does not come from
 * anywhere else in the model, which is why the frictionless closure test pins it exactly.
 *
 * @param {object} line the line
 * @param {object} st state (its cavity is advanced)
 * @param {number} i node index — the downstream end
 * @param {number} Cp C+ intercept, m
 * @param {number} Bp C+ slope, m per (m3/s)
 * @param {number} dt step, s
 * @param {Float64Array} nH new heads
 * @param {Float64Array} nQu new upstream-side flows
 * @param {Float64Array} nQd new downstream-side flows
 * @returns {void}
 */
function solveClosedEnd(line, st, i, Cp, Bp, dt, nH, nQu, nQd) {
  const hv = line.hVap_m[i];
  if (st.cavity_m3[i] <= 0 && Cp >= hv) {
    nH[i] = Cp;
    nQu[i] = 0;
    nQd[i] = 0;
    return;
  }
  // Below vapour head the arriving characteristic still delivers flow; nothing leaves, so all of
  // it goes into the cavity — or, on the way back, out of it.
  const qIn = (Cp - hv) / Bp;
  const vol = st.cavity_m3[i] - qIn * dt;
  if (vol > 0) {
    st.cavity_m3[i] = vol;
    st.separated = true;
    nH[i] = hv;
    nQu[i] = qIn;
    nQd[i] = 0;
    return;
  }
  st.cavity_m3[i] = 0;
  nH[i] = Cp;
  nQu[i] = 0;
  nQd[i] = 0;
}

/**
 * Solve the downstream node: a valve on a fixed downstream head, or a blank flange.
 * @param {object} line the line
 * @param {object} st state (mutated)
 * @param {number} Cp C+ intercept, m
 * @param {number} Bp C+ slope, m per (m3/s)
 * @param {number} tau dimensionless valve opening, 1 at the armed point and 0 shut
 * @param {number} Hdown downstream system head, m
 * @param {number} dt step, s
 * @param {Float64Array} nH new heads
 * @param {Float64Array} nQu new upstream-side flows
 * @param {Float64Array} nQd new downstream-side flows
 * @returns {void}
 */
function downstreamNode(line, st, Cp, Bp, tau, Hdown, dt, nH, nQu, nQd) {
  const N = line.N;
  if (line.downstream === DOWNSTREAM.DEAD_END || !(tau > 0) || !(st.valveCd > 0)) {
    solveClosedEnd(line, st, N, Cp, Bp, dt, nH, nQu, nQd);
    return;
  }
  // Q = tau*Cd*sqrt(H - Hdown) together with H = Cp - Bp*Q is one quadratic in Q. Written this
  // way it stays exact as tau goes to zero rather than dividing by a vanishing opening.
  const E = (tau * st.valveCd) * (tau * st.valveCd);
  const drive = Cp - Hdown;
  let Q;
  if (drive >= 0) {
    Q = 0.5 * (-E * Bp + Math.sqrt(E * Bp * E * Bp + 4 * E * drive));
  } else {
    Q = -0.5 * (-E * Bp + Math.sqrt(E * Bp * E * Bp - 4 * E * drive));
  }
  const h = Cp - Bp * Q;
  const hv = line.hVap_m[N];
  if (st.cavity_m3[N] <= 0 && h >= hv) {
    nH[N] = h;
    nQu[N] = Q;
    nQd[N] = Q;
    return;
  }
  const qIn = (Cp - hv) / Bp;
  const qOut = tau * st.valveCd * ssqrt(hv - Hdown);
  const vol = st.cavity_m3[N] + (qOut - qIn) * dt;
  if (vol > 0) {
    st.cavity_m3[N] = vol;
    st.separated = true;
    nH[N] = hv;
    nQu[N] = qIn;
    nQd[N] = qOut;
    return;
  }
  st.cavity_m3[N] = 0;
  nH[N] = h;
  nQu[N] = Q;
  nQd[N] = Q;
}

/**
 * Advance the sub-model far enough to cover one tick of the plant's clock.
 *
 * This is the coexistence entry point. The plant's tick is not a whole number of MOC steps and
 * never will be, so the remainder is carried rather than rounded — rounding it would make the
 * sub-model's clock drift away from the plant's, and a surge peak reported at the wrong instant
 * is worse than no surge peak at all.
 *
 * @param {object} line the frozen line
 * @param {object} st state (mutated)
 * @param {number} dt_s the plant's tick, s
 * @param {object} [bc] boundary conditions, held constant across every sub-step
 * @returns {{ok:boolean, reason?:string, steps?:number, t_s?:number}} how many MOC steps ran
 */
export function advanceSurge(line, st, dt_s, bc) {
  if (!st.armed) return { ok: false, reason: 'armSurge first' };
  if (!(dt_s > 0) || !Number.isFinite(dt_s)) return { ok: false, reason: 'dt_s must be positive' };
  st.carry_s += dt_s;
  let n = 0;
  // A hard ceiling: if a caller hands in a stupid dt the model refuses to spend the afternoon on
  // it rather than locking the frame.
  const maxSteps = 100000;
  while (st.carry_s >= line.dt_s && n < maxSteps) {
    const r = stepSurge(line, st, bc);
    if (!r.ok) return r;
    st.carry_s -= line.dt_s;
    n += 1;
  }
  return { ok: true, steps: n, t_s: st.t_s };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/**
 * The pressure envelope: the highest and lowest head every node has seen since arming, against
 * the pipe profile and the vapour line.
 *
 * This is the deliverable of a surge study. Not a time trace — an envelope, because what the
 * designer needs to know is whether any point on the line went above its rating or below the
 * vapour pressure at ANY instant, and where.
 *
 * @param {object} line the line
 * @param {object} st state
 * @returns {{x_m:Float64Array, profile_m:Float64Array, maxH_m:Float64Array, minH_m:Float64Array,
 *   vapour_m:Float64Array, maxP_bar:Float64Array, minP_bar:Float64Array}} the envelope
 */
export function surgeEnvelope(line, st) {
  const n = line.nodes;
  const x = new Float64Array(n);
  const maxP = new Float64Array(n);
  const minP = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    x[i] = i * line.dx_m;
    // Gauge pressure AT the pipe, which is the head above the pipe itself and not above the
    // datum. On a line with any profile at all the two are different numbers and it is the
    // second one that bursts things.
    maxP[i] = headToBar(st.maxH_m[i] - line.z_m[i], line.rho_kgm3);
    minP[i] = headToBar(st.minH_m[i] - line.z_m[i], line.rho_kgm3);
  }
  return {
    x_m: x,
    profile_m: line.z_m,
    maxH_m: st.maxH_m,
    minH_m: st.minH_m,
    vapour_m: line.hVap_m,
    maxP_bar: maxP,
    minP_bar: minP,
  };
}

/**
 * The headline numbers of a transient, in the order somebody reads them.
 * @param {object} line the line
 * @param {object} st state
 * @returns {{t_s:number, steps:number, peakH_m:number, peakAt_m:number, minH_m:number,
 *   minAt_m:number, peakP_bar:number, minP_bar:number, riseAboveSteady_m:number,
 *   joukowsky_m:number, joukowskyRatio:number, separated:boolean, separatedNodes:number,
 *   maxCavity_m3:number, slam:object|null, pumpSpeed:number, checkOpen:boolean,
 *   vesselGas_m3:number}} the summary
 */
export function surgeSummary(line, st) {
  let peak = -Infinity;
  let peakAt = 0;
  let low = Infinity;
  let lowAt = 0;
  let sepNodes = 0;
  let maxCav = 0;
  for (let i = 0; i <= line.N; i += 1) {
    if (st.maxH_m[i] > peak) { peak = st.maxH_m[i]; peakAt = i * line.dx_m; }
    if (st.minH_m[i] < low) { low = st.minH_m[i]; lowAt = i * line.dx_m; }
    if (st.maxCavity_m3[i] > 0) sepNodes += 1;
    if (st.maxCavity_m3[i] > maxCav) maxCav = st.maxCavity_m3[i];
  }
  const jouk = joukowskyRise_m(line, st.Q0_m3s * S_PER_H);
  const rise = peak - st.H0_m;
  return {
    t_s: st.t_s,
    steps: st.steps,
    peakH_m: peak,
    peakAt_m: peakAt,
    minH_m: low,
    minAt_m: lowAt,
    peakP_bar: headToBar(peak, line.rho_kgm3),
    minP_bar: headToBar(low, line.rho_kgm3),
    riseAboveSteady_m: rise,
    joukowsky_m: jouk,
    /** How much of the theoretical maximum the event actually produced. Above 1 means line
     *  packing, a cavity rejoinder, or a resonance — all three are worth chasing down. */
    joukowskyRatio: jouk > 0 ? rise / jouk : 0,
    separated: st.separated,
    separatedNodes: sepNodes,
    maxCavity_m3: maxCav,
    slam: st.slam,
    pumpSpeed: st.s,
    checkOpen: st.checkOpen,
    vesselGas_m3: st.vesselGas_m3,
  };
}

// ---------------------------------------------------------------------------------------------
// The closed-form results a designer checks the model against
// ---------------------------------------------------------------------------------------------

/**
 * The Joukowsky head rise for stopping a flow instantaneously in this line, m.
 *
 * `dH = a*v/g`. Note what is NOT in it: the length of the line, the head the pump was making,
 * and the pressure rating of the pipe. A short line and a long one give the same peak; the long
 * one merely holds it for longer.
 *
 * @param {object} line the line
 * @param {number} Q_m3h the flow being stopped, m3/h
 * @returns {number} the head rise, m
 */
export function joukowskyRise_m(line, Q_m3h) {
  const v = Math.abs(Q_m3h / S_PER_H) / line.area_m2;
  return joukowsky_m(v, line.a_ms);
}

/**
 * The round-trip time 2L/a, s: the longest a closure can take and still be "rapid".
 * @param {object} line the line
 * @returns {number} seconds
 */
export function criticalTime_s(line) {
  return line.criticalTime_s;
}

/**
 * The natural period 4L/a, s, at which a closed line rings.
 *
 * Two round trips, not one, because the wave has to reflect once off the closed end (same sign)
 * and once off the header (opposite sign) before the pressure at the valve is back where it
 * started. A pressure trace at a slammed valve is a square wave of this period, and reading the
 * period off a real trace is the cheapest way there is to MEASURE the wave speed of a line that
 * has already been built.
 *
 * @param {object} line the line
 * @returns {number} seconds
 */
export function reflectionPeriod_s(line) {
  return line.period_s;
}

/**
 * The Allievi-Michaud peak for a slow linear closure, m.
 *
 *     dH = dH_Joukowsky * (2L/a) / t_close       for t_close > 2L/a
 *
 * Below the round-trip time nothing that happens at the header can reach the valve in time to
 * relieve anything, so the answer is the full Joukowsky rise no matter how the valve is moved.
 * Above it the reflection is already arriving while the valve is still moving and the peak falls
 * off inversely with closing time. This is the whole engineering argument for stroke time, and
 * the two-second rule of thumb that gets applied to every actuator is really this formula being
 * remembered badly.
 *
 * It assumes a linear closure of a valve whose flow is proportional to its opening, so it is an
 * estimate; the MOC in this file is what settles it. They should agree within a few percent for
 * a friction-light line, and the MOC will read HIGHER for a long one because of line packing.
 *
 * @param {object} line the line
 * @param {number} Q_m3h the steady flow, m3/h
 * @param {number} closeTime_s the closing time, s
 * @returns {number} the peak head rise above the steady head, m
 */
export function michaudPeak_m(line, Q_m3h, closeTime_s) {
  const jouk = joukowskyRise_m(line, Q_m3h);
  if (!(closeTime_s > line.criticalTime_s)) return jouk;
  return (jouk * line.criticalTime_s) / closeTime_s;
}

// ---------------------------------------------------------------------------------------------
// Surge control: sizing the two devices that are actually fitted
// ---------------------------------------------------------------------------------------------

/**
 * First-pass sizing of an air vessel against the DOWN-surge on a pump trip.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT AN AIR VESSEL IS FOR, AND WHY IT IS SIZED ON THE MINIMUM AND NOT THE MAXIMUM
 *
 * The dangerous half of a pump trip is the first half. The pump stops, the check valve shuts,
 * and the column carries on up the line under its own momentum with nothing behind it — so the
 * pressure at the pump collapses, and if it reaches vapour pressure the column separates. The
 * peak that everybody photographs comes later, when it comes back and the cavity closes; but the
 * device is sized to stop the cavity forming at all, because if it never forms there is nothing
 * to collapse.
 *
 * The vessel does that by having liquid ready to push into the line at the instant the pump
 * stops. It has to hold enough that the gas can expand — and therefore keep feeding — for as
 * long as it takes to bring the column to rest.
 *
 * THE ENERGY METHOD. This is the sizing method in the surge literature (Parmakian's charts and
 * Thorley's treatment both reduce to it) and it is a quasi-static energy balance rather than a
 * wave calculation, which is legitimate precisely BECAUSE a correctly sized vessel makes the
 * event slow compared with 2L/a. At the instant the column stops:
 *
 *     (1/2)*rho*L*A*v0^2  +  W_gas  =  p_delivery_abs * dV
 *
 * The kinetic energy of the column plus the work the expanding gas does on it must equal the work
 * of pushing the delivered volume out against the delivery pressure. The gas work for a
 * polytropic expansion from `V0` to `V1` is
 *
 *     W_gas = p0*V0/(n-1) * [ 1 - (V0/V1)^(n-1) ]
 *
 * and the constraint is that `p1 = p0*(V0/V1)^n` must not fall below the pressure floor the
 * designer will accept.
 *
 * BOTH PRESSURES ARE ABSOLUTE, and that is not a detail. The gas obeys an absolute law, so the
 * work it does is an absolute-pressure integral; the delivery term has to be written the same way
 * or the balance is comparing an absolute quantity with a gauge one. On a low-head station the
 * atmospheric term is most of the delivery pressure, and dropping it makes the required vessel
 * come out negative — which is to say, makes the method silently claim no vessel is needed.
 *
 * Friction is left out, which is conservative: friction dissipates the column's energy and
 * therefore reduces the drawdown, so a vessel sized without it is a little large. Being a little
 * large is the correct direction to be wrong in.
 *
 * THIS IS A STARTING SIZE, NOT A DESIGN. Fit it as `spec.vessel`, arm the line, trip the pump
 * and read the envelope. The two living in the same file is not a coincidence: a sizing formula
 * that is never checked against a transient is how undersized vessels get installed.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} spec the duty
 * @param {number} spec.length_m line length the column occupies, m
 * @param {number} spec.id_mm line internal diameter, mm
 * @param {number} spec.Q_m3h steady flow at the moment of the trip, m3/h
 * @param {number} spec.staticHead_m the delivery head ABOVE THE VESSEL, m. This is what actually
 *   stops the column, and it is the one input people get wrong: it is an elevation difference,
 *   not the pump's discharge head.
 * @param {number} spec.vesselHead_m steady head at the vessel when the pump was running, m gauge
 * @param {number} spec.minHead_m the lowest head at the vessel the designer will accept, m gauge.
 *   Usually a few metres above the vapour head, not at it.
 * @param {number} spec.rho_kgm3 liquid density, kg/m3
 * @param {number} [spec.pAtm_bar=1.01325] barometric pressure, bar absolute
 * @param {number} [spec.polytropic=1.2] polytropic exponent — 1.0 for a slow isothermal
 *   expansion, 1.4 for a fast adiabatic one, 1.2 for the compromise that is normally used
 * @returns {{ok:boolean, reason?:string, gasVolume_m3?:number, expandedVolume_m3?:number,
 *   drawdown_m3?:number, vesselVolume_m3?:number, p0_bara?:number, p1_bara?:number,
 *   expansionRatio?:number}} the sizing, or a reason it cannot be done
 */
export function sizeAirVessel(spec) {
  const n = spec.polytropic === undefined ? 1.2 : spec.polytropic;
  const pAtm = (spec.pAtm_bar === undefined ? ATM_BAR : spec.pAtm_bar) * 1e5;
  if (!(spec.Q_m3h > 0)) return { ok: false, reason: 'no flow to arrest' };
  if (!(n > 1)) return { ok: false, reason: 'polytropic exponent must exceed 1' };
  if (!(spec.minHead_m < spec.vesselHead_m)) {
    return { ok: false, reason: 'the accepted minimum head must be below the running head' };
  }
  if (!(spec.staticHead_m > 0)) {
    return { ok: false, reason: 'without a static head opposing it the column is never arrested' };
  }

  const D = spec.id_mm / 1000;
  const A = (Math.PI * D * D) / 4;
  const v0 = spec.Q_m3h / S_PER_H / A;
  const rho = spec.rho_kgm3;
  const p0 = pAtm + rho * G * spec.vesselHead_m;
  const p1 = pAtm + rho * G * spec.minHead_m;
  if (!(p1 > 0)) return { ok: false, reason: 'the accepted minimum head is below a hard vacuum' };

  // The expansion ratio is fixed by the two pressures alone; only the SIZE is unknown.
  const ratio = Math.pow(p0 / p1, 1 / n);
  const Ek = 0.5 * rho * spec.length_m * A * v0 * v0;

  // Energy balance, as a function of the initial gas volume. Both the gas work and the static
  // work scale linearly with V0, so this is exact algebra rather than a search — but writing it
  // as a residual keeps the derivation legible and costs nothing at build time.
  const gasWorkPerV0 = (p0 / (n - 1)) * (1 - Math.pow(1 / ratio, n - 1));
  const deliveryWorkPerV0 = (pAtm + rho * G * spec.staticHead_m) * (ratio - 1);
  const net = deliveryWorkPerV0 - gasWorkPerV0;
  if (!(net > 0)) {
    return {
      ok: false,
      reason: 'the gas does more work than the delivery absorbs — the accepted minimum head is '
        + 'too close to the running head for any vessel to hold it, so lower minHead_m',
    };
  }
  const V0 = Ek / net;
  const V1 = V0 * ratio;
  return {
    ok: true,
    gasVolume_m3: V0,
    expandedVolume_m3: V1,
    drawdown_m3: V1 - V0,
    // A real vessel needs the drawdown as liquid too, plus freeboard for the level instrument
    // and for the compressor to work against. Two and a half times the gas volume is the usual
    // shell size and it is where the money is.
    vesselVolume_m3: 2.5 * V0,
    p0_bara: p0 / 1e5,
    p1_bara: p1 / 1e5,
    expansionRatio: ratio,
  };
}

/**
 * Sizing a surge relief valve against the UP-surge from a closure.
 *
 * ------------------------------------------------------------------------------------------
 * A surge relief valve does not work the way a thermal relief valve works. It is not there to
 * pass a steady overpressure; it is there to give the column somewhere to go during the round
 * trip, and it is judged on two numbers:
 *
 *   CAPACITY  Joukowsky says the head rise is `a*dv/g` for whatever velocity change the pipe is
 *             made to absorb. If the valve carries away `Q_relief`, the pipe only has to absorb
 *             the rest, so the allowable overshoot above the set head fixes the capacity:
 *
 *                 dH_allow = a*(v0 - Q_relief/A)/g   ->   Q_relief = A*(v0 - g*dH_allow/a)
 *
 *             If the allowable overshoot already exceeds the full Joukowsky rise, no valve is
 *             needed and the function says so rather than sizing one.
 *
 *   SPEED     it must be fully open within the round-trip time 2L/a. A relief valve that takes
 *             longer than that arrives after the wave has already reflected off the header and
 *             come back, and it relieves a peak that has been and gone. This is the commonest
 *             reason a correctly sized relief valve fails to protect anything, and it is why
 *             these are pilot-operated or nitrogen-loaded rather than spring-loaded.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} line the line, from {@link createSurgeLine}
 * @param {object} spec the duty
 * @param {number} spec.Q_m3h the steady flow being stopped, m3/h
 * @param {number} spec.setHead_m the head the valve starts to open at, m
 * @param {number} spec.maxHead_m the highest head the line may see, m
 * @param {number} [spec.dischargeHead_m=0] the head the valve discharges to, m
 * @param {number} [spec.openTime_s] the valve's full opening time, s — checked against 2L/a
 * @returns {{ok:boolean, reason?:string, required:boolean, relief_m3h?:number, kv?:number,
 *   dH_allow_m?:number, joukowsky_m?:number, openWithin_s?:number, fastEnough?:boolean}}
 *   the sizing
 */
export function sizeSurgeRelief(line, spec) {
  if (!(spec.Q_m3h > 0)) return { ok: false, required: false, reason: 'no flow to relieve' };
  if (!(spec.maxHead_m > spec.setHead_m)) {
    return { ok: false, required: true, reason: 'maxHead_m must be above setHead_m' };
  }
  const dHallow = spec.maxHead_m - spec.setHead_m;
  const jouk = joukowskyRise_m(line, spec.Q_m3h);
  const openWithin = line.criticalTime_s;
  if (dHallow >= jouk) {
    return {
      ok: true,
      required: false,
      reason: 'the allowable overshoot already covers the full Joukowsky rise',
      relief_m3h: 0,
      dH_allow_m: dHallow,
      joukowsky_m: jouk,
      openWithin_s: openWithin,
      fastEnough: true,
    };
  }
  const v0 = spec.Q_m3h / S_PER_H / line.area_m2;
  const vRelief = v0 - (G * dHallow) / line.a_ms;
  const relief = vRelief * line.area_m2 * S_PER_H;
  const dHvalve = spec.maxHead_m - (spec.dischargeHead_m || 0);
  const kv = dHvalve > 0 ? relief / (KV_HEAD * Math.sqrt(dHvalve)) : Infinity;
  return {
    ok: true,
    required: true,
    relief_m3h: relief,
    kv,
    dH_allow_m: dHallow,
    joukowsky_m: jouk,
    openWithin_s: openWithin,
    fastEnough: spec.openTime_s === undefined ? true : spec.openTime_s <= openWithin,
  };
}
