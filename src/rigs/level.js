/**
 * src/rigs/level.js — a surge drum level, the classic non-self-regulating process.
 *
 * Layer L2: imports `core/util.js` only. No DOM, no timers, no randomness.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A LEVEL LOOP IS NOT A FLOW LOOP
 *
 * A flow loop is self-regulating: put the valve somewhere and the flow settles there. A drum is
 * not. Its level is the running integral of everything that has ever gone in minus everything
 * that has ever come out, so there is no output that "holds" the level — every output either
 * fills the vessel or empties it, and the only question is how fast. That single fact changes
 * everything about how it must be tuned:
 *
 *   NO OFFSET WITHOUT INTEGRAL — a pure integrator with proportional-only control has no steady
 *   -state offset in the OUTPUT, it has one in the LEVEL. The loop will sit happily at the wrong
 *   level forever, passing exactly the right flow. On a surge drum that is not a fault, it is the
 *   feature.
 *
 *   INTEGRAL IS THE DESTABILISER — two integrators in series (the vessel and the reset term) is a
 *   180 degree phase lag before the process has done anything at all. This is why level loops
 *   with a flow-loop reset time cycle with a slow, sinusoidal, unmistakable period, and why the
 *   correct reset time on a drum is measured in tens of minutes.
 *
 * ------------------------------------------------------------------------------------------
 * AVERAGING LEVEL CONTROL: THE OBJECTIVE IS NOT THE LEVEL
 *
 * A surge drum exists to absorb variation. Upstream is a batch-ish, lumpy, upset-prone unit;
 * downstream is a column, a reactor or a fired heater whose own controls are only stable if their
 * feed rate is smooth. The drum is the shock absorber between them, and its capacity is the whole
 * point: liquid parked in the drum is variation that never reached the downstream unit.
 *
 * So a well-tuned surge drum level controller:
 *
 *   - lets the level wander over most of the vessel, on purpose;
 *   - moves the outlet flow slowly, smoothly, and as little as the vessel allows;
 *   - only tightens up as the level approaches the alarms, because the ONE thing it must never do
 *     is flood the drum or lose the pump's suction.
 *
 * A controller tuned to hold the level pinned at 50 percent is the worst of both worlds: it
 * passes every upstream wobble straight through to the downstream unit, and it does it while
 * using none of the capacity that was bought and installed to prevent exactly that. Shinskey's
 * classical averaging rule — proportional gain of about 1, so that the full level span buys the
 * full flow span — is the tuning shipped here as `natural`, and it looks *wrong* to anybody whose
 * only tuning experience is a flow loop. That reaction is the lesson.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT IS MODELLED, AND WHAT IS NOT
 *
 * MODELLED
 *   - Vessel geometry. A horizontal drum's liquid surface is a chord, so its area — and therefore
 *     the integrating gain — is largest at half full and collapses at both ends. The loop that was
 *     comfortable at 50 percent is twice as fast at 10 percent. `surfaceArea_m2` is the exact
 *     chord relation; `volumeAt_m3` is the exact circular-segment volume (Perry 7th ed., Table
 *     6-x / any pressure-vessel handbook).
 *   - The outlet pump and its flow controller, as a level-to-flow CASCADE. The slave is modelled
 *     by its closed-loop response, two lags in series, which is what a well-tuned flow loop
 *     actually looks like from outside.
 *   - The transmitter: a differential-pressure level transmitter spans between two taps, so the
 *     reading saturates at 0 and 100 percent while the real liquid keeps going.
 *   - The downstream unit, as a washout (high-pass) filter on the outlet flow. A downstream column
 *     tracks a slow ramp in feed without complaint and is upset by a fast change, so what hurts it
 *     is the part of the feed signal ABOVE its own bandwidth. That is a high-pass, and its output
 *     is the number the level controller is really being graded on.
 *
 * SIMPLIFIED
 *   - The vapour space is not modelled: the drum is assumed to be on pressure control, so the
 *     liquid balance is decoupled from the gas balance. On a real flash drum they are not.
 *   - The outlet pump's own curve is hidden behind the flow slave. That is the point of building
 *     the cascade, but it does mean this rig cannot teach what happens when the slave saturates
 *     against the pump curve; the main pump rig teaches that.
 *   - Liquid is incompressible and of constant density, and the drum has no internals.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, lag } from '../core/util.js';

/** Vessel orientations. Horizontal gives a level-dependent gain; vertical gives the textbook one. */
export const ORIENTATION = Object.freeze({
  /** A cylinder lying on its side: surface area is a chord, widest at half full. */
  HORIZONTAL: 'HORIZONTAL',
  /** A cylinder standing up: constant surface area, a pure integrator with constant gain. */
  VERTICAL: 'VERTICAL',
});

/**
 * The liquid surface is clamped to no thinner than this fraction of the vessel height when the
 * integrator uses it. Without the floor the level's rate of change is unbounded at an empty or
 * full horizontal drum and one long step would send `h` to infinity; with it, the ends are merely
 * very fast, which is what they physically are.
 */
const AREA_FLOOR_FRAC = 0.02;

/** Shipped configuration: a small horizontal surge drum on a 180 m3/h stream. */
export const LEVEL_DEFAULTS = Object.freeze({
  tag: 'LIC-201',
  orientation: ORIENTATION.HORIZONTAL,
  /** Vessel inside diameter, m. */
  diameter_m: 2.2,
  /** Tangent-to-tangent length of a horizontal drum, m. Ignored when vertical. */
  length_m: 5.5,
  /** Height of a vertical drum, m. Ignored when horizontal. */
  height_m: 3.0,
  /** Height of the lower transmitter tap above the vessel bottom, m — the zero of the reading. */
  tapLo_m: 0.11,
  /** Distance between the taps, m — the span of the reading. */
  tapSpan_m: 1.98,
  /** Nominal inflow from the upstream unit, m3/h. */
  inflowNom_m3h: 180,
  /** Outlet flow at 100 percent controller output, m3/h. */
  outflowMax_m3h: 300,
  /** Dominant lag of the outlet flow slave loop, s. */
  slaveTau1_s: 5,
  /** Secondary lag of the outlet flow slave loop, s. */
  slaveTau2_s: 3,
  /** Level transmitter damping, s. */
  ltTau_s: 2,
  /** Bandwidth of the downstream unit, expressed as the washout time constant, s. */
  downstreamTau_s: 300,
  /** The flow the downstream unit was designed for, m3/h — the base of its deviation. */
  designFlow_m3h: 180,
  /** Alarm levels, percent of the transmitter span. */
  alarms: Object.freeze({ LL: 8, L: 20, H: 80, HH: 92 }),
});

/**
 * Liquid surface area at a wetted depth — the exact geometry, with no floor applied.
 *
 * For a horizontal cylinder the surface is a rectangle whose width is the chord at depth `h`:
 * `w = 2*sqrt(2*R*h - h^2)`, so `A = L * w`. It is zero at both ends and maximal, `A = L*D`, at
 * exactly half full. That is the whole reason a horizontal drum's level loop is nonlinear.
 *
 * @param {object} cfg rig configuration
 * @param {number} h_m wetted depth above the vessel bottom, m
 * @returns {number} liquid surface area, m2
 */
export function surfaceArea_m2(cfg, h_m) {
  if (cfg.orientation === ORIENTATION.VERTICAL) {
    return (Math.PI * cfg.diameter_m * cfg.diameter_m) / 4;
  }
  const R = cfg.diameter_m / 2;
  const h = clamp(h_m, 0, cfg.diameter_m);
  return cfg.length_m * 2 * Math.sqrt(Math.max(2 * R * h - h * h, 0));
}

/**
 * Liquid volume at a wetted depth — the exact circular-segment relation for a horizontal drum,
 *
 *     V(h) = L * [ R^2 * acos((R - h)/R) - (R - h) * sqrt(2*R*h - h^2) ]
 *
 * which integrates to the full `pi*R^2*L` at `h = D`, as it must.
 *
 * @param {object} cfg rig configuration
 * @param {number} h_m wetted depth, m
 * @returns {number} liquid volume, m3
 */
export function volumeAt_m3(cfg, h_m) {
  if (cfg.orientation === ORIENTATION.VERTICAL) {
    const h = clamp(h_m, 0, cfg.height_m);
    return ((Math.PI * cfg.diameter_m * cfg.diameter_m) / 4) * h;
  }
  const R = cfg.diameter_m / 2;
  const h = clamp(h_m, 0, cfg.diameter_m);
  const d = R - h;
  return cfg.length_m * (R * R * Math.acos(clamp(d / R, -1, 1)) - d * Math.sqrt(Math.max(2 * R * h - h * h, 0)));
}

/**
 * Total height of liquid the vessel can hold, m.
 * @param {object} cfg rig configuration
 * @returns {number} the vessel's internal height, m
 */
export function vesselHeight_m(cfg) {
  return cfg.orientation === ORIENTATION.VERTICAL ? cfg.height_m : cfg.diameter_m;
}

/**
 * Surface area as the integrator uses it: the exact area, floored so the ends stay finite.
 * @param {object} cfg rig configuration
 * @param {number} h_m wetted depth, m
 * @returns {number} area, m2, never below the area at `AREA_FLOOR_FRAC` of the height
 */
function effectiveArea_m2(cfg, h_m) {
  const floor = surfaceArea_m2(cfg, AREA_FLOOR_FRAC * vesselHeight_m(cfg));
  return Math.max(surfaceArea_m2(cfg, h_m), floor);
}

/**
 * Convert a wetted depth to the transmitter reading. A d/p level transmitter reads between its
 * taps and nowhere else, so it saturates while the liquid keeps moving — which is exactly how an
 * operator ends up believing a flooded drum is at 100 percent and stable.
 * @param {object} cfg rig configuration
 * @param {number} h_m wetted depth, m
 * @returns {number} indicated level, percent of span, clamped to 0..100
 */
export function levelPercent(cfg, h_m) {
  return clamp((100 * (h_m - cfg.tapLo_m)) / cfg.tapSpan_m, 0, 100);
}

/**
 * Convert a transmitter reading back to a wetted depth.
 * @param {object} cfg rig configuration
 * @param {number} pct indicated level, percent of span
 * @returns {number} wetted depth, m
 */
export function depthAt_m(cfg, pct) {
  return cfg.tapLo_m + (pct / 100) * cfg.tapSpan_m;
}

/**
 * The integrating process gain: how fast the indicated level ramps per percent of controller
 * output, at a given depth.
 *
 *     Ki = -(outflowMax/100 / 3600) / A(h) * (100 / tapSpan)     [%level per second per %output]
 *
 * It is NEGATIVE because opening the outlet lowers the level, which is why the controller is
 * direct-acting. This number, not a gain and a time constant, is what integrating-process tuning
 * rules take as their argument.
 *
 * @param {object} cfg rig configuration
 * @param {number} h_m wetted depth, m
 * @returns {number} integrating gain, percent of span per second per percent of output
 */
export function integratingGain(cfg, h_m) {
  const perPct_m3s = cfg.outflowMax_m3h / 100 / 3600;
  return -((perPct_m3s / effectiveArea_m2(cfg, h_m)) * (100 / cfg.tapSpan_m));
}

/**
 * The rate at which the indicated level ramps under a given flow imbalance — the analytic answer
 * this rig is tested against, because for a non-self-regulating process the ramp rate IS the
 * process model.
 * @param {object} cfg rig configuration
 * @param {number} imbalance_m3h inflow minus outflow, m3/h
 * @param {number} h_m wetted depth, m
 * @returns {number} rate of change of the indicated level, percent of span per second
 */
export function rampRate_pctPerS(cfg, imbalance_m3h, h_m) {
  return ((imbalance_m3h / 3600) / effectiveArea_m2(cfg, h_m)) * (100 / cfg.tapSpan_m);
}

/**
 * Allocate the drum's state at its nominal operating point: half full, inflow equal to outflow,
 * everything at rest. The controller output that holds it is `100 * inflowNom / outflowMax`.
 * @param {object} cfg rig configuration
 * @returns {object} mutable rig state
 */
export function createState(cfg) {
  const h0 = depthAt_m(cfg, 50);
  const pct0 = levelPercent(cfg, h0);
  return {
    /** Simulated time since the state was created, s. */
    t_s: 0,
    /** Wetted depth, m — the true state. */
    h_m: h0,
    /** True indicated level before transmitter damping, percent. */
    levelRaw_pct: pct0,
    /** Damped transmitter reading, percent. This is the PV. */
    level_pct: pct0,
    /** DISTURBANCE. Inflow from the upstream unit, m3/h. Write it between steps. */
    inflow_m3h: cfg.inflowNom_m3h,
    /** Flow the level controller has asked the outlet slave for, m3/h. */
    outflowCmd_m3h: cfg.inflowNom_m3h,
    /** First state of the outlet slave's closed-loop response, m3/h. */
    slave1_m3h: cfg.inflowNom_m3h,
    /** Actual outlet flow, m3/h. What the downstream unit receives. */
    outflow_m3h: cfg.inflowNom_m3h,
    /** Rate of change of the outlet flow, m3/h per minute — the number a downstream operator sees. */
    outflowRate_m3hpmin: 0,
    /** Washout filter state: the part of the outlet flow the downstream unit cannot absorb. */
    downstreamHp_m3h: 0,
    /** Downstream unit deviation, percent of its design feed rate. */
    downstreamDev_pct: 0,
    /** Integral of the absolute downstream deviation, percent-seconds. The grade. */
    downstreamIae: 0,
    /** Worst downstream deviation seen, percent. */
    downstreamPeak_pct: 0,
    /** Liquid inventory, m3. */
    holdup_m3: volumeAt_m3(cfg, h0),
    /** Lowest and highest indicated level seen, percent — their difference is the capacity used. */
    minLevel_pct: pct0,
    maxLevel_pct: pct0,
    /** Volume that overflowed the vessel, m3. Non-zero means the drum flooded. */
    spilled_m3: 0,
    /** Time the drum spent empty, s. Non-zero means the outlet pump lost its suction. */
    starved_s: 0,
    /** Latched alarm flags. */
    alarmLoLo: false,
    alarmLo: false,
    alarmHi: false,
    alarmHiHi: false,
    /** Previous outlet flow, for the rate and the washout. */
    prevOutflow_m3h: cfg.inflowNom_m3h,
  };
}

/**
 * Advance the drum one step.
 *
 * The volume balance is integrated at the midpoint rather than by plain Euler. On a horizontal
 * drum the surface area changes with the level being solved for, and near the ends it changes
 * fast; the midpoint rule keeps the ramp rate honest there without needing a small step, and it
 * is exact for the constant-area vertical case.
 *
 * @param {object} st rig state (mutated)
 * @param {object} cfg rig configuration
 * @param {number} u controller output, percent — the outlet flow demand
 * @param {number} dt_s step, s
 * @returns {number} the new measured level, percent of span
 */
export function step(st, cfg, u, dt_s) {
  if (!(dt_s > 0) || !Number.isFinite(u)) return st.level_pct;
  st.t_s += dt_s;

  // The level controller is the master of a level-to-flow cascade: its output is a flow setpoint,
  // and the slave's closed-loop response is two lags. Modelling the slave rather than the pump is
  // the point of the cascade — the slave rejects the pump curve, the suction head and the
  // discharge pressure before the level loop can see any of them.
  st.outflowCmd_m3h = (clamp(u, 0, 100) / 100) * cfg.outflowMax_m3h;
  st.slave1_m3h = lag(st.slave1_m3h, st.outflowCmd_m3h, cfg.slaveTau1_s, dt_s);
  const outflow = lag(st.outflow_m3h, st.slave1_m3h, cfg.slaveTau2_s, dt_s);

  // Volume balance, integrated at the midpoint.
  const net_m3s = (st.inflow_m3h - outflow) / 3600;
  const k1 = net_m3s / effectiveArea_m2(cfg, st.h_m);
  const hMid = st.h_m + 0.5 * dt_s * k1;
  const k2 = net_m3s / effectiveArea_m2(cfg, hMid);
  let h = st.h_m + dt_s * k2;

  // The vessel has ends. Liquid that will not fit leaves through the vapour line or the relief,
  // and liquid that is not there cannot be pumped — both are recorded rather than silently
  // clamped, because "the level came back on its own" is exactly the trap.
  const hMax = vesselHeight_m(cfg);
  if (h > hMax) {
    st.spilled_m3 += (h - hMax) * effectiveArea_m2(cfg, hMax);
    h = hMax;
  } else if (h < 0) {
    st.starved_s += dt_s;
    h = 0;
  }
  st.h_m = h;
  st.holdup_m3 = volumeAt_m3(cfg, h);

  st.outflowRate_m3hpmin = ((outflow - st.prevOutflow_m3h) / dt_s) * 60;

  // The downstream unit as a washout filter, y = a*y + (u - u_prev) with a = exp(-dt/tau): unity
  // gain to fast changes, zero gain to steady flow. A slow ramp in feed passes through the
  // downstream unit's own controls untouched; a step does not, and this is the part that hurts.
  const a = Math.exp(-dt_s / Math.max(cfg.downstreamTau_s, 1e-6));
  st.downstreamHp_m3h = a * (st.downstreamHp_m3h + outflow - st.prevOutflow_m3h);
  st.downstreamDev_pct = (100 * st.downstreamHp_m3h) / cfg.designFlow_m3h;
  st.downstreamIae += Math.abs(st.downstreamDev_pct) * dt_s;
  const mag = Math.abs(st.downstreamDev_pct);
  if (mag > st.downstreamPeak_pct) st.downstreamPeak_pct = mag;

  st.prevOutflow_m3h = outflow;
  st.outflow_m3h = outflow;

  st.levelRaw_pct = levelPercent(cfg, h);
  st.level_pct = lag(st.level_pct, st.levelRaw_pct, cfg.ltTau_s, dt_s);

  if (st.level_pct < st.minLevel_pct) st.minLevel_pct = st.level_pct;
  if (st.level_pct > st.maxLevel_pct) st.maxLevel_pct = st.level_pct;
  st.alarmLoLo = st.level_pct <= cfg.alarms.LL;
  st.alarmLo = st.level_pct <= cfg.alarms.L;
  st.alarmHi = st.level_pct >= cfg.alarms.H;
  st.alarmHiHi = st.level_pct >= cfg.alarms.HH;

  return st.level_pct;
}

/**
 * Read the rig out.
 * @param {object} st rig state
 * @returns {object} the measurement: `pv` plus every channel the descriptor declares
 */
export function measure(st) {
  return {
    pv: st.level_pct,
    level_pct: st.level_pct,
    inflow_m3h: st.inflow_m3h,
    outflow_m3h: st.outflow_m3h,
    outflowRate_m3hpmin: st.outflowRate_m3hpmin,
    downstreamDev_pct: st.downstreamDev_pct,
    holdup_m3: st.holdup_m3,
    usedSpan_pct: st.maxLevel_pct - st.minLevel_pct,
  };
}

/**
 * The rig descriptor. See `src/rigs/library.js` for the contract every field satisfies.
 * @type {object}
 */
export const LEVEL_RIG = Object.freeze({
  id: 'LEVEL',
  name: 'Surge drum level',
  subtitle: 'LIC-201 — averaging level control on a horizontal drum',
  kind: 'INTEGRATING',
  purpose: 'A non-self-regulating process where holding the setpoint is the WRONG objective. '
    + 'The drum was installed to absorb upstream variation; the loop is graded on how smooth the '
    + 'flow leaving it is, not on how close the level is to 50 percent.',
  teaches: Object.freeze([
    'integrating processes have no steady state, so a step test never levels off',
    'proportional-only control is a legitimate, finished answer on a surge drum',
    'reset time on a level loop is tens of minutes, and a flow-loop reset time makes it cycle',
    'a horizontal drum\'s gain doubles between half full and nearly empty',
    'the grade is the smoothness of the outlet flow, not the error on the level',
  ]),
  pv: Object.freeze({ key: 'level_pct', tag: 'LT-201', label: 'Drum level', units: '%', lo: 0, hi: 100 }),
  co: Object.freeze({ key: 'co', tag: 'FIC-202.SP', label: 'Outlet flow demand', units: '%', lo: 0, hi: 100 }),
  /** Opening the outlet LOWERS the level, so an increase in PV must decrease the output. */
  action: 'DIRECT',
  sp0: 50,
  co0: 60,
  /**
   * Shinskey's averaging rule: a proportional gain of 1 maps the whole level span onto the whole
   * flow span, so the vessel absorbs the entire disturbance before the outlet has to. The reset
   * time is set for a damping ratio near 0.5 on the integrator-plus-controller pair,
   * `zeta = 0.5*sqrt(Kc*|Ki|*Ti)`, which lands at about five minutes for this drum.
   */
  tuning: Object.freeze({
    Kc: 1.0, Ti: 300, Td: 0, N: 10, b: 0.6, c: 0,
    pvFilter_s: 4, outLo: 0, outHi: 100, outRate: 0, action: 'DIRECT',
  }),
  /** A deliberately wrong alternative: flow-loop tuning on a drum, for the contrast. */
  alternativeTunings: Object.freeze({
    tight: Object.freeze({ Kc: 8, Ti: 45, Td: 0, N: 10, b: 1, c: 0, pvFilter_s: 0, outLo: 0, outHi: 100, action: 'DIRECT' }),
  }),
  /**
   * An integrator is not a FOPDT process. This is the long-time-constant approximation the
   * frequency-domain machinery needs: `K = |Ki| * tau` with `tau` far beyond the loop bandwidth.
   * Margins read off it are trustworthy above about `1/tau` and meaningless below.
   */
  model: Object.freeze({ K: 3.48, tau: 1000, theta: 10 }),
  /** The exact description: a pure integrator of this gain, plus the slave and transmitter lags. */
  integrator: Object.freeze({ Ki: -3.478e-3, lags_s: Object.freeze([5, 3, 2]) }),
  channels: Object.freeze([
    Object.freeze({ key: 'level_pct', label: 'Level', units: '%', lo: 0, hi: 100 }),
    Object.freeze({ key: 'inflow_m3h', label: 'Inflow', units: 'm3/h', lo: 0, hi: 320 }),
    Object.freeze({ key: 'outflow_m3h', label: 'Outflow', units: 'm3/h', lo: 0, hi: 320 }),
    Object.freeze({ key: 'outflowRate_m3hpmin', label: 'Outflow rate', units: 'm3/h/min', lo: -60, hi: 60 }),
    Object.freeze({ key: 'downstreamDev_pct', label: 'Downstream upset', units: '%', lo: -40, hi: 40 }),
    Object.freeze({ key: 'holdup_m3', label: 'Inventory', units: 'm3', lo: 0, hi: 22 }),
    Object.freeze({ key: 'usedSpan_pct', label: 'Capacity used', units: '%', lo: 0, hi: 100 }),
  ]),
  disturbances: Object.freeze([
    Object.freeze({ key: 'inflow_m3h', label: 'Upstream inflow', units: 'm3/h', lo: 0, hi: 300, nominal: 180 }),
  ]),
  defaults: LEVEL_DEFAULTS,
  createState,
  step,
  measure,
});
