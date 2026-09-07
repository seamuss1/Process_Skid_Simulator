/**
 * src/process/plant.js — the rig. Two pumps in parallel on a common header, a surge vessel, a
 * demand valve to process and a minimum-flow recirculation back to the suction tank.
 *
 *      TK-101 ──┬──[ STR-101 ]──[ P-101 / VFD-101 ]──[ NRV-101 ]──┐
 *               │                                                 ├── HEADER ──[ FCV-101 ]──▶ process
 *               ├──[ STR-102 ]──[ P-102 / VFD-102 ]──[ NRV-102 ]──┤        │
 *               │                                                 │      PT-101
 *               └◀────────────── [ RO-101 min-flow ] ◀────────────┘      FT-101
 *
 * Layer L2: imports `core/util.js` and the L1 process modules. No DOM, no controller, no UI. The
 * controller writes `run.drv[i].cmd_pct` and `run.fcvCmd`; nothing else crosses the boundary.
 *
 * ------------------------------------------------------------------------------------------
 * HOW THE NETWORK IS SOLVED
 *
 * The header is not an algebraic junction. It contains a bladder vessel, so it is a capacitance,
 * and the whole plant reduces to ONE differential equation in ONE state — the header head H:
 *
 *     C(H) * dH/dt = sum_i Qpump_i(H) - Qdemand(H) - Qbypass(H)  =  g(H)
 *
 * where C is the vessel's compliance from Boyle's law on the trapped gas,
 *
 *     C = rho*g*Vgas / p_abs        [m3 of liquid per metre of head]
 *
 * Every term of g is available in closed form: each pump's flow is the positive root of a
 * quadratic (`pump.solveBranchFlow`) and each outlet is a square-root orifice. g is strictly
 * decreasing in H — more header head means less pump flow and more outlet flow — so the equation
 * has exactly one equilibrium and it is stable. That is not an accident of the numbers; it is a
 * property of the topology, and it is why this simulator never needs a solver that can fail.
 *
 * Integration is one linearly-implicit Euler step,
 *
 *     H(k+1) = H(k) + dt*g(H) / (C - dt*g'(H))
 *
 * with g' assembled analytically alongside g. Because g' < 0 the denominator always exceeds C, so
 * the step is unconditionally stable for any dt and any valve movement, and as dt grows it
 * degenerates gracefully into the steady-state solve rather than ringing. A plain explicit step
 * would blow up the instant somebody slammed the demand valve, which is precisely the transient
 * this rig exists to let people slam.
 * ------------------------------------------------------------------------------------------
 */

import {
  clamp, lag, slew, headToBar, G, S_PER_H, nextPink, createPinkState, createRng, RNG_STREAMS,
} from '../core/util.js';
import { fluidAt } from './fluid.js';
import {
  solveBranchFlow, headAt, shaftPower_kW, npshRequired_m, npshAvailable_m, cavitationFactor,
} from './pump.js';
import { kvAt, kvToK, flowThrough, flowSlope, headLoss } from './valve.js';
import { createDriveState, stepDrive, DRIVE } from './motor.js';

/**
 * A discrete transport delay: the dead time between the process and the number the controller
 * sees. Scan rate, transmitter update and comms all land here.
 *
 * Dead time is the reason PID tuning is a skill. Without it, a loop tolerates unbounded gain and
 * every tuning question has the same boring answer, so this rig has some and it is adjustable.
 * @param {number} n number of samples of delay (0 gives a pass-through)
 * @param {number} seed the value the buffer starts filled with
 * @returns {{buf:Float64Array, i:number}} delay-line state
 */
function createDelay(n, seed) {
  const len = Math.max(1, n | 0);
  const buf = new Float64Array(len);
  buf.fill(seed);
  return { buf, i: 0 };
}

/**
 * Push a sample into a delay line and take the one that falls out.
 * @param {{buf:Float64Array,i:number}} d delay state (mutated)
 * @param {number} v the new sample
 * @returns {number} the sample from `buf.length` ticks ago
 */
function pushDelay(d, v) {
  const out = d.buf[d.i];
  d.buf[d.i] = v;
  d.i = (d.i + 1) % d.buf.length;
  return out;
}

/**
 * Allocate the complete mutable plant state for a frozen config.
 *
 * Nothing here is derived at read time: the tick writes every field, and the views read them.
 * That is the whole contract between the physics and the screen.
 *
 * @param {object} config frozen config from `data/config.js`
 * @returns {object} the mutable plant run state
 */
export function createPlantState(config) {
  const nP = config.pumps.length;
  const level0 = config.tank.level0_m;
  const st = {
    /** Simulated time, s. Advanced only by {@link stepPlant}. */
    t_s: 0,
    /** Tick counter. */
    tick: 0,

    // --- the ODE state -----------------------------------------------------------------
    /** Header head, metres of liquid. THE state variable of the plant. */
    H_m: 0,
    /** Header gauge pressure, bar — `H_m` expressed through the current density. */
    p_bar: 0,

    // --- vessels -----------------------------------------------------------------------
    /** Liquid inventory in the suction tank, m3. */
    V_m3: level0 * config.tank.area_m2,
    /** Suction tank level, m. */
    level_m: level0,
    /** Liquid surface height above the pump centreline, m. Negative is a suction lift. */
    zStatic_m: 0,
    /** Make-up flow into the tank, m3/h. */
    inflow_m3h: 0,

    // --- final elements ----------------------------------------------------------------
    /** Demand-valve travel command from the load model, 0..1. */
    fcvCmd: config.demand.x0,
    /** Demand-valve actual travel, 0..1. Follows the command at the stroke rate. */
    fcv: config.demand.x0,
    /** Recirculation valve travel, 0..1. */
    bypass: config.bypass.x0,

    // --- flows -------------------------------------------------------------------------
    /** Flow delivered to process through FCV-101, m3/h. */
    Qdemand_m3h: 0,
    /** Flow recirculated to tank through RO-101, m3/h. */
    Qbypass_m3h: 0,
    /** Sum of the pump flows, m3/h. */
    Qtotal_m3h: 0,

    // --- per pump ----------------------------------------------------------------------
    /** @type {object[]} drive state, one per pump */
    drv: [],
    /** Flow through each pump, m3/h. */
    Q_m3h: new Float64Array(nP),
    /** Head developed by each pump, m. */
    Hp_m: new Float64Array(nP),
    /** Shaft power of each pump, kW. */
    P_kW: new Float64Array(nP),
    /** NPSH available at each suction, m. */
    npsha_m: new Float64Array(nP),
    /** NPSH required by each pump at its duty, m. */
    npshr_m: new Float64Array(nP),
    /** Cavitation head multiplier, 1 when healthy. */
    cav: new Float64Array(nP).fill(1),
    /** True while a check valve is holding shut against the header. */
    checkShut: new Uint8Array(nP),
    /** Efficiency at duty, 0..1. */
    eta: new Float64Array(nP),

    // --- disturbances (operator-writable) ----------------------------------------------
    /** Liquid temperature, C. Sets density and vapour pressure. */
    T_C: config.fluid.T_C,
    /** Suction strainer blinding, 0 (clean) .. 0.95. */
    foul: 0,
    /** Static head the demand valve discharges against, m. The load's back pressure. */
    hDischarge_m: config.demand.hDischarge_m,
    /** Load-model demand valve target, 0..1, before the stroke limit. */
    demandTarget: config.demand.x0,
    /** Whether the make-up controller holds tank level. */
    makeupAuto: true,

    // --- instruments -------------------------------------------------------------------
    /** PT-101 indicated header pressure, bar — delayed, noisy, filtered. */
    pt_bar: 0,
    /** FT-101 indicated flow to process, m3/h — delayed, noisy, filtered. */
    ft_m3h: 0,
    /** LT-101 indicated tank level, m. */
    lt_m: level0,

    /** Fluid properties for this tick. */
    fluid: fluidAt(config.fluid.T_C),

    /** Trip reasons raised during this tick, drained by the caller. */
    events: [],
  };

  for (let i = 0; i < nP; i += 1) st.drv.push(createDriveState());

  // Instrument signal conditioning: one delay line, one filter pole and one noise generator each.
  const ins = config.instruments;
  st._sig = {
    ptDelay: createDelay(Math.round(ins.pt.deadTime_s / config.dt_s), 0),
    ftDelay: createDelay(Math.round(ins.ft.deadTime_s / config.dt_s), 0),
    ptPink: createPinkState(),
    ftPink: createPinkState(),
    ltPink: createPinkState(),
    ptRng: createRng(config.seed ^ RNG_STREAMS.PT_NOISE),
    ftRng: createRng(config.seed ^ RNG_STREAMS.FT_NOISE),
    ltRng: createRng(config.seed ^ RNG_STREAMS.LT_NOISE),
  };

  // Start the header at the steady state for the initial valve and speed, so the first frame is
  // not a transient nobody asked for.
  st.H_m = solveHeaderSteady(config, st);
  st.p_bar = headToBar(st.H_m, st.fluid.rho_kgm3);
  st.pt_bar = st.p_bar;
  evaluateNetwork(config, st, st.H_m, true);
  st.ft_m3h = st.Qdemand_m3h;
  st._sig.ptDelay.buf.fill(st.p_bar);
  st._sig.ftDelay.buf.fill(st.ft_m3h);
  return st;
}

/**
 * Total branch resistance for one pump: strainer plus suction line plus discharge spool plus
 * check valve, as a single `K` in `dH = K*Q^2`. Fouling shrinks the strainer's Kv, which is what
 * makes a blinded strainer show up as lost NPSH rather than as lost head.
 * @param {object} config frozen config
 * @param {object} st plant state
 * @returns {{K:number, kvSuction:number}} branch coefficient and the effective suction Kv
 */
function branchResistance(config, st) {
  const kvSuction = config.suction.kv_m3h * (1 - clamp(st.foul, 0, 0.95));
  const K = kvToK(kvSuction) + kvToK(config.discharge.kv_m3h) + kvToK(config.discharge.checkKv_m3h);
  return { K, kvSuction };
}

/**
 * Evaluate the network at a trial header head: every branch flow, and the residual `g(H)` with
 * its analytic derivative.
 *
 * @param {object} config frozen config
 * @param {object} st plant state — READ for speeds, valve travel and cavitation factors; only
 *   written when `commit` is true
 * @param {number} H_m trial header head, m
 * @param {boolean} commit whether to write the resulting flows back onto the state
 * @returns {{g:number, dg:number}} residual, m3/h, and its slope, (m3/h) per m (always negative)
 */
function evaluateNetwork(config, st, H_m, commit) {
  const { K } = branchResistance(config, st);
  let sum = 0;
  let slope = 0;
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    const r = solveBranchFlow(config.pumps[i], s, H_m, st.zStatic_m, K, st.cav[i]);
    sum += r.Q_m3h;
    slope += r.dQdH;
    if (commit) {
      st.Q_m3h[i] = r.Q_m3h;
      st.checkShut[i] = r.checkShut ? 1 : 0;
      st.Hp_m[i] = headAt(config.pumps[i], r.Q_m3h, s) * st.cav[i];
    }
  }

  const kvDem = kvAt(config.demand, st.fcv);
  const dHdem = H_m - st.hDischarge_m;
  const Qdem = flowThrough(kvDem, dHdem);
  slope -= flowSlope(kvDem, dHdem);

  const kvByp = kvAt(config.bypass, st.bypass);
  const dHbyp = H_m - st.zStatic_m;
  const Qbyp = flowThrough(kvByp, dHbyp);
  slope -= flowSlope(kvByp, dHbyp);

  if (commit) {
    st.Qdemand_m3h = Qdem;
    st.Qbypass_m3h = Qbyp;
    st.Qtotal_m3h = sum;
  }
  return { g: sum - Qdem - Qbyp, dg: slope };
}

/**
 * Assess the suction condition of every machine: NPSH available, NPSH required, and the head
 * multiplier that follows from the difference.
 *
 * NPSH available is evaluated at the flow the pump was passing on the PREVIOUS tick. The coupling
 * back into head is weak, and taking it explicitly is what keeps the branch solve a closed-form
 * quadratic instead of a nested iteration.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (mutated: npsha_m, npshr_m, cav)
 * @param {number} dt_s tick, s — or 0 to apply the cavitation multiplier without its lag, which
 *   is what a settle wants and what a running tick must never do
 * @returns {void}
 */
function updateSuction(config, st, dt_s) {
  const { kvSuction } = branchResistance(config, st);
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    st.npsha_m[i] = npshAvailable_m({
      pTank_bar: config.tank.pTank_bar,
      pVap_bar: st.fluid.pVap_bar,
      zStatic_m: st.zStatic_m,
      hFriction_m: headLoss(kvSuction, st.Q_m3h[i]),
      rho_kgm3: st.fluid.rho_kgm3,
    });
    st.npshr_m[i] = npshRequired_m(config.pumps[i], st.Q_m3h[i], s);
    const target = cavitationFactor(st.npsha_m[i], st.npshr_m[i]);
    // The multiplier is taken through a short lag rather than applied instantly.
    //
    // Physically, vapour cavities take a finite time to form and to collapse — a pump does not
    // lose and regain its head within one 20 ms tick. Numerically, that lag is also what makes
    // the explicit coupling safe: without it, a pump sitting exactly at zero suction margin gets
    // into a tick-rate limit cycle (margin goes negative, head collapses, flow falls, NPSHr falls
    // with it, margin recovers, head returns, flow rises...) and the trend fills with a 25 Hz
    // oscillation that is entirely an artefact of the discretisation. One time constant removes
    // it, and it is a time constant the real machine has.
    st.cav[i] = dt_s > 0 ? lag(st.cav[i], target, config.cavTau_s, dt_s) : target;
  }
}

/**
 * Solve the header head at steady state, by bisection on `g(H) = 0`.
 *
 * Used for the initial condition and by the tests; the running plant integrates instead. The
 * bracket is provable rather than guessed: at the lower bound every outlet differential is
 * non-positive so `g >= 0`, and at the highest shutoff head every check valve is shut so `g <= 0`.
 * Sixty bisections take the interval below a micrometre of head, which costs nothing at a call
 * site that runs once.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (read only; cavitation factors and speeds are taken as given)
 * @returns {number} the equilibrium header head, m
 */
export function solveHeaderSteady(config, st) {
  st.zStatic_m = config.tank.zBase_m + st.level_m;
  let hi = Math.max(st.zStatic_m, st.hDischarge_m);
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    hi = Math.max(hi, st.zStatic_m + st.cav[i] * s * s * config.pumps[i].H0_m);
  }
  let lo = Math.min(st.zStatic_m, st.hDischarge_m) - 1;
  hi += 1;
  for (let k = 0; k < 60; k += 1) {
    const mid = 0.5 * (lo + hi);
    if (evaluateNetwork(config, st, mid, false).g > 0) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Put the plant on its steady state for the current speeds, valve travel and disturbances, and
 * prime every instrument to agree with it.
 *
 * Used at boot and after any change that would otherwise open on a transient the operator did not
 * cause — starting the lead pump, for instance. It is NOT used while running: a settle is a
 * teleport, and the whole value of the rig is in the journey.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (mutated)
 * @returns {void}
 */
export function settlePlant(config, st) {
  st.fluid = fluidAt(st.T_C);
  st.zStatic_m = config.tank.zBase_m + st.level_m;
  st.fcv = clamp(st.demandTarget, 0, 1);
  // Two passes. The suction condition depends on the flow and the flow depends on the cavitation
  // multiplier, so the first pass finds the flows, the second finds the margins those flows
  // imply, and the third re-solves with them. The running tick takes that coupling explicitly
  // across ticks; a settle has no previous tick to take it from.
  for (let pass = 0; pass < 3; pass += 1) {
    st.H_m = solveHeaderSteady(config, st);
    evaluateNetwork(config, st, st.H_m, true);
    updateSuction(config, st, 0);
  }
  st.p_bar = headToBar(st.H_m, st.fluid.rho_kgm3);
  st.pt_bar = st.p_bar;
  st.ft_m3h = st.Qdemand_m3h;
  st.lt_m = st.level_m;
  st._sig.ptDelay.buf.fill(st.p_bar);
  st._sig.ftDelay.buf.fill(st.ft_m3h);
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    st.Hp_m[i] = headAt(config.pumps[i], st.Q_m3h[i], s) * st.cav[i];
    st.P_kW[i] = shaftPower_kW(config.pumps[i], st.Q_m3h[i], st.Hp_m[i], s, st.fluid.rho_kgm3);
  }
}

/**
 * Advance the whole plant by one fixed tick.
 *
 * Order matters and is fixed: final elements move first (they are what the LAST controller output
 * asked for), then the suction condition is assessed, then the network integrates, then the
 * inventories, then the instruments. Reversing any two of those would let a controller output
 * affect the measurement inside the same tick, which is the classic way a simulator ends up
 * flattering a tuning that would not survive contact with a real scan cycle.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (mutated)
 * @param {number} dt_s tick, s
 * @returns {void}
 */
export function stepPlant(config, st, dt_s) {
  st.tick += 1;
  st.t_s += dt_s;
  st.events.length = 0;

  // 1 — fluid properties, which everything downstream depends on.
  st.fluid = fluidAt(st.T_C);
  const rho = st.fluid.rho_kgm3;

  // 2 — final elements. The demand valve strokes toward the load model's target at its rated
  //     speed; an instantaneous valve would hide the fastest disturbance this rig can produce.
  st.fcvCmd = clamp(st.demandTarget, 0, 1);
  st.fcv = slew(st.fcv, st.fcvCmd, 1 / config.demand.strokeTime_s, dt_s);

  // 3 — suction condition.
  st.zStatic_m = config.tank.zBase_m + st.level_m;
  updateSuction(config, st, dt_s);

  // 4 — the network. One linearly-implicit Euler step on the header capacitance.
  const pAbs_Pa = Math.max((headToBar(st.H_m, rho) + 1.01325) * 1e5, 2e4);
  const C_m3_per_m = (rho * G * config.header.gasVolume_m3) / pAbs_Pa;
  const { g, dg } = evaluateNetwork(config, st, st.H_m, false);
  const dH = (dt_s * (g / S_PER_H)) / (C_m3_per_m - dt_s * (dg / S_PER_H));
  st.H_m = clamp(st.H_m + dH, -50, 400);
  evaluateNetwork(config, st, st.H_m, true);
  st.p_bar = headToBar(st.H_m, rho);

  // 5 — pump power and the drives. Power is computed from the flows just committed, and it is
  //     what the overload times out on, so the two must be in this order.
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    st.P_kW[i] = shaftPower_kW(config.pumps[i], st.Q_m3h[i], st.Hp_m[i], s, rho);
    st.eta[i] = st.Q_m3h[i] > 0 && s > 0.02
      ? clamp(config.pumps[i].etaBep
        * (2 * ((st.Q_m3h[i] / s) / config.pumps[i].Qbep_m3h)
          - ((st.Q_m3h[i] / s) / config.pumps[i].Qbep_m3h) ** 2), 0.05, config.pumps[i].etaBep)
      : 0;
    const trip = stepDrive(config.drives[i], st.drv[i], st.P_kW[i], config.pumps[i].motor_kW, dt_s);
    if (trip) st.events.push({ tag: config.pumps[i].tag, severity: 'ALARM', message: trip });
  }

  // 6 — inventory. The recirculation returns to the tank; the demand leaves the system. Make-up
  //     is trimmed by a slow proportional controller when it is in auto, so an unattended rig
  //     holds level, and drifts honestly toward a cavitation event when it is not.
  const draw = st.Qtotal_m3h - st.Qbypass_m3h;
  if (st.makeupAuto) {
    const err = config.tank.levelSP_m - st.level_m;
    st.inflow_m3h = clamp(draw + config.tank.makeupGain * err, 0, config.tank.makeupMax_m3h);
  }
  st.V_m3 = clamp(
    st.V_m3 + ((st.inflow_m3h + st.Qbypass_m3h - st.Qtotal_m3h) / S_PER_H) * dt_s,
    0, config.tank.area_m2 * config.tank.height_m,
  );
  st.level_m = st.V_m3 / config.tank.area_m2;

  // 7 — instruments. Dead time first, then noise, then the filter pole: the order a signal
  //     actually meets them on its way from the tapping point to the faceplate.
  const ins = config.instruments;
  const sg = st._sig;
  const ptRaw = pushDelay(sg.ptDelay, st.p_bar)
    + ins.pt.noise_bar * nextPink(sg.ptPink, sg.ptRng, dt_s);
  st.pt_bar = clamp(lag(st.pt_bar, ptRaw, ins.pt.filter_s, dt_s), ins.pt.lo_bar, ins.pt.hi_bar);

  const ftRaw = pushDelay(sg.ftDelay, st.Qdemand_m3h)
    + ins.ft.noise_m3h * nextPink(sg.ftPink, sg.ftRng, dt_s);
  st.ft_m3h = clamp(lag(st.ft_m3h, ftRaw, ins.ft.filter_s, dt_s), ins.ft.lo_m3h, ins.ft.hi_m3h);

  const ltRaw = st.level_m + ins.lt.noise_m * nextPink(sg.ltPink, sg.ltRng, dt_s);
  st.lt_m = clamp(lag(st.lt_m, ltRaw, ins.lt.filter_s, dt_s), 0, config.tank.height_m);
}

/**
 * The process variable a loop in a given mode is controlling, taken from the INSTRUMENT rather
 * than from the state — the controller never gets to see the truth.
 * @param {object} st plant state
 * @param {string} mode 'PRESSURE' or 'FLOW'
 * @returns {number} the measured PV in that mode's engineering units
 */
export function measuredPV(st, mode) {
  return mode === 'FLOW' ? st.ft_m3h : st.pt_bar;
}

/**
 * The true value of the controlled variable, for scoring and for the "truth" pen on the trend.
 * The gap between this and {@link measuredPV} is the instrument, and showing both is the point.
 * @param {object} st plant state
 * @param {string} mode 'PRESSURE' or 'FLOW'
 * @returns {number} the actual PV
 */
export function truePV(st, mode) {
  return mode === 'FLOW' ? st.Qdemand_m3h : st.p_bar;
}

/**
 * Count the pumps that are energised and turning.
 * @param {object} st plant state
 * @returns {number} how many drives are in RUNNING
 */
export function runningCount(st) {
  let n = 0;
  for (const d of st.drv) if (d.state === DRIVE.RUNNING) n += 1;
  return n;
}

/**
 * Sample the combined pump characteristic and the system resistance curve over a flow range, for
 * the operating-point chart.
 *
 * The two curves crossing IS the operating point; a tuner who can see where the crossing sits,
 * and how far it is from the best-efficiency flow, understands in one glance why the loop behaves
 * differently at 20 m3/h than at 60. Both curves are evaluated from the same functions the tick
 * uses, so the chart can never drift away from the simulation it is drawing.
 *
 * @param {object} config frozen config
 * @param {object} st plant state
 * @param {number} n number of samples
 * @returns {{Q:Float64Array, Hpump:Float64Array, Hsys:Float64Array, Qmax:number}} the curves
 */
export function characteristicCurves(config, st, n) {
  const { K } = branchResistance(config, st);
  const Qmax = config.pumps[0].Qmax_m3h * 2;
  const Q = new Float64Array(n);
  const Hpump = new Float64Array(n);
  const Hsys = new Float64Array(n);
  const kvDem = kvAt(config.demand, st.fcv);
  const kvByp = kvAt(config.bypass, st.bypass);
  const running = [];
  for (let i = 0; i < config.pumps.length; i += 1) {
    if (st.drv[i].n_pct > 1) running.push(i);
  }
  for (let j = 0; j < n; j += 1) {
    const q = (Qmax * j) / (n - 1);
    Q[j] = q;
    // Combined pump curve: identical machines in parallel each pass q/N at the same header head.
    if (running.length === 0) {
      Hpump[j] = NaN;
    } else {
      let h = 0;
      for (const i of running) {
        const s = st.drv[i].n_pct / 100;
        const qi = q / running.length;
        h += st.zStatic_m + st.cav[i] * headAt(config.pumps[i], qi, s) - K * qi * qi;
      }
      Hpump[j] = h / running.length;
    }
    // System curve: the head the header must stand at for the outlets to swallow q in total.
    // Demand and recirculation are in parallel, so invert their combined square-root law.
    const kEq = kvDem + kvByp;
    const share = kEq > 0 ? kvDem / kEq : 1;
    const hDown = share * st.hDischarge_m + (1 - share) * st.zStatic_m;
    const dh = kEq > 0 ? (q / (0.313155 * kEq)) ** 2 : 0;
    Hsys[j] = hDown + dh;
  }
  return { Q, Hpump, Hsys, Qmax };
}
