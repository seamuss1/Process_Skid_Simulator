/**
 * src/process/plant.js — the rig. Two pumps in parallel on a common header, a surge vessel, a
 * throttle valve, a demand valve to process, and an automatic recirculation back to the tank.
 *
 *      TK-101 ──┬──[ STR-101 ]──[ P-101 / VFD-101 ]──[ NRV-101 ]──┐
 *               │                                                 ├─ HDR ─[PCV-101]─[FCV-101]─▶
 *               ├──[ STR-102 ]──[ P-102 / VFD-102 ]──[ NRV-102 ]──┤    │
 *               │                                                 │  PT/FT/TT
 *               └◀───────────── [ RO-101 / ARV min-flow ] ◀───────┘
 *
 * Layer L2: imports `core/util.js` and the L1 process modules. No DOM, no controller, no UI.
 *
 * ------------------------------------------------------------------------------------------
 * HOW THE NETWORK IS SOLVED — TWO STATES, NOT ONE
 *
 * The header contains a bladder vessel, so it is a capacitance. The discharge line contains a
 * column of liquid, so it is an inertance. Together they make the plant a SECOND-order system in
 * two states — the header head H and the flow leaving through the discharge line Qd:
 *
 *     C(H) * dH/dt  = sum_i Qpump_i(H) - Qd - Qbypass(H)
 *     I     * dQd/dt = H - h_discharge - (Kpcv + Kfcv + Kpipe) * Qd^2
 *
 * with C = rho*g*Vgas/p_abs from Boyle's law on the trapped gas, and I = L/(g*A) from the
 * momentum equation for a rigid liquid column. The pump branches stay algebraic — each one's flow
 * is still the positive root of a quadratic — because they are short and because keeping them
 * closed-form is what makes the whole thing solvable without an iteration that can fail.
 *
 * WHY THE INERTANCE EARNS ITS PLACE. Without it, closing a valve produces a new steady state
 * instantly and the only thing that resists is the vessel. With it, the moving column has to be
 * DECELERATED, and the only thing available to do that with is pressure — so a fast closure
 * produces a genuine surge. At the duty point the two poles are about 3 s and 20 ms apart, so the
 * inertance costs the loop nothing it did not already have; slam the valve and it is the whole
 * story. That is exactly the right split.
 *
 * INTEGRATION is one linearly-implicit Euler step on the 2x2 system,
 *
 *     x(k+1) = x(k) + dt * (I - dt*J)^-1 * f(x)
 *
 * with J assembled analytically. Both diagonal terms of J are negative and the off-diagonals have
 * opposite signs, so `(I - dt*J)` is diagonally dominant for any dt and the step is
 * unconditionally stable — however hard anybody slams anything.
 * ------------------------------------------------------------------------------------------
 */

import {
  clamp, lag, headToBar, hydraulicPower_kW, G, S_PER_H,
  nextPink, createPinkState, createRng, RNG_STREAMS,
} from '../core/util.js';
import { fluidAt } from './fluid.js';
import {
  deratedPump, viscousCorrection, solveBranchFlow, headAt, shaftPower_kW, efficiencyAt,
  npshRequired_m, npshAvailable_m, cavitationFactor, heatIntoLiquid_kW, temperatureRise_K,
  thermalMinFlow_m3h, vibration_mms, wearRate_perH,
} from './pump.js';
import { kvAt, kvToK, flowThrough, flowSlope, createStem, stepStem } from './valve.js';
import { resistanceK, headLoss_m, reynolds, inertiaCoefficient, velocity_ms } from './pipe.js';
import {
  createDriveState, stepDrive, loadTorque_Nm, speedToReference, DRIVE, STOP_MODE,
} from './motor.js';

/** How the minimum-flow recirculation is operated. */
export const RECIRC = Object.freeze({
  /** The operator sets the travel and it stays there. */
  MANUAL: 'MANUAL',
  /** A self-contained automatic recirculation valve opens it as forward flow falls. */
  ARV: 'ARV',
  /** Shut. The way to find out what minimum-flow protection is for. */
  CLOSED: 'CLOSED',
});

/** Which element the controller modulates. */
export const FINAL = Object.freeze({
  /** The drives. Variable speed. */
  VFD: 'VFD',
  /** PCV-101, with the pumps held at a fixed speed. Constant speed and throttle. */
  THROTTLE: 'THROTTLE',
});

/**
 * A discrete transport delay: the dead time between the process and the number the controller
 * sees. Scan rate, transmitter update and comms all land here.
 * @param {number} n number of samples of delay
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

    // --- the two ODE states --------------------------------------------------------------
    /** Header head, metres of liquid. */
    H_m: 0,
    /** Flow leaving through the discharge line, m3/h. A STATE: the column has inertia. */
    Qdem_m3h: 0,
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
    /** Bulk temperature of the tank contents, C. A state: recirculation heats it. */
    T_tank_C: config.fluid.T_C,

    // --- final elements ----------------------------------------------------------------
    /** Demand-valve stem — the LOAD. */
    fcv: createStem(config.demand.x0),
    /** Throttle-valve stem — a possible final control element. */
    pcv: createStem(1),
    /**
     * Live overrides on the final elements.
     *
     * The valve records in the config are the NAMEPLATE — what was bought. Friction in the
     * packing and a slow positioner are maintenance state: they appear over years, an operator
     * can make them worse by overtightening the gland, and the whole point of the stiction
     * exercise is to introduce them without rebuilding the plant. So they live here, and the
     * effective valve each tick is the nameplate with these laid over it.
     */
    valveOverride: {
      fcv: { strokeTime_s: null, stickband: 0, slipJump: 0 },
      pcv: { strokeTime_s: null, stickband: 0, slipJump: 0 },
    },
    /** Recirculation valve travel, 0..1. */
    bypass: config.bypass.x0,
    /** How the recirculation is being operated, one of {@link RECIRC}. */
    recircMode: RECIRC.ARV,
    /** Which element the controller modulates, one of {@link FINAL}. */
    finalElement: FINAL.VFD,
    /**
     * Fixed SHAFT speed the pumps run at in THROTTLE mode, percent of rated. Not a controller
     * reference — the number an operator would read off the drive.
     *
     * Not 100. A throttle valve can only hold a pressure the pump is already making MORE than
     * (see {@link throttleRange}), so the fixed speed sets the floor of the controllable band —
     * and at full speed on this rig that floor is above the header's own high alarm. 75% puts the
     * normal setpoint comfortably inside the band while still leaving about a bar of head for the
     * valve to destroy, which is the point of the exercise.
     */
    fixedSpeed_pct: 75,

    // --- flows -------------------------------------------------------------------------
    /** Flow delivered to process, m3/h. Mirrors `Qdem_m3h`, kept for name clarity. */
    Qdemand_m3h: 0,
    /** Flow recirculated to tank, m3/h. */
    Qbypass_m3h: 0,
    /** Sum of the pump flows, m3/h. */
    Qtotal_m3h: 0,
    /** Velocity in the discharge line, m/s. */
    vDischarge_ms: 0,

    // --- per pump ----------------------------------------------------------------------
    /** @type {object[]} drive state, one per pump */
    drv: [],
    /** @type {object[]} the derated machine each pump currently IS, rebuilt every tick */
    eff: new Array(nP).fill(null),
    Q_m3h: new Float64Array(nP),
    Hp_m: new Float64Array(nP),
    /** Shaft power, kW. */
    P_kW: new Float64Array(nP),
    /** Total efficiency at duty, 0..1. */
    eta: new Float64Array(nP),
    npsha_m: new Float64Array(nP),
    npshr_m: new Float64Array(nP),
    /** Cavitation head multiplier, 1 when healthy. */
    cav: new Float64Array(nP).fill(1),
    /** True while a check valve is holding shut against the header. */
    checkShut: new Uint8Array(nP),
    /** Casing liquid temperature, C. A state. */
    Tcasing_C: new Float64Array(nP).fill(config.fluid.T_C),
    /** Steady temperature rise this duty implies, K. Infinite at zero flow. */
    dT_K: new Float64Array(nP),
    /** Overall vibration velocity, mm/s RMS. */
    vib_mms: new Float64Array(nP),
    /** Wear-ring wear, 0 (new) .. 1 (scrap). Accumulates. */
    wear: new Float64Array(nP),
    /** Impeller diameter ratio. A permanent difference between the machines. */
    trim: new Float64Array(nP).fill(1),
    /** Reynolds number in each suction branch. */
    Re: new Float64Array(nP),

    // --- disturbances (operator-writable) ----------------------------------------------
    /** Which liquid the rig is filled with. */
    fluidId: config.fluid.id,
    /** Temperature of the make-up supply, C. The tank mixes toward it. */
    Tsupply_C: config.fluid.T_C,
    /** Suction strainer blinding, 0 (clean) .. 0.95. */
    foul: 0,
    /** Static head the demand valve discharges against, m. */
    hDischarge_m: config.demand.hDischarge_m,
    /** Load-model demand valve target, 0..1. */
    demandTarget: config.demand.x0,
    /** Whether the make-up controller holds tank level. */
    makeupAuto: true,
    /** Site barometric pressure, bar absolute. Falls with altitude and takes NPSH with it. */
    pAtm_bar: config.site.pAtm_bar,

    // --- instruments -------------------------------------------------------------------
    pt_bar: 0,
    ft_m3h: 0,
    lt_m: level0,
    /** TT-101, tank temperature as the transmitter reads it, C. */
    tt_C: config.fluid.T_C,

    /** Fluid properties at the tank temperature, for this tick. */
    fluid: fluidAt(config.fluid.id, config.fluid.T_C),
    /** The viscous correction the current fluid implies for these machines. */
    visc: { B: 0, CQ: 1, CH: 1, CE: 1, applies: false, beyondScope: false },

    /** Events raised during this tick, drained by the caller. */
    events: [],
  };

  for (let i = 0; i < nP; i += 1) {
    st.drv.push(createDriveState());
    st.trim[i] = config.pumpTrim[i];
  }

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

  settlePlant(config, st);
  return st;
}

/**
 * The band of header pressures the throttle valve can actually reach at the present fixed speed.
 *
 * ------------------------------------------------------------------------------------------
 * THIS IS THE WHOLE DIFFERENCE BETWEEN A VALVE AND A DRIVE, AND IT DESERVES SAYING PLAINLY.
 *
 * PCV-101 sits in the discharge line, DOWNSTREAM of PT-101. Closing it raises the header; opening
 * it lowers the header. So at a fixed pump speed the reachable range runs from the pressure with
 * the valve wide open — the lowest the header can be made to sit — up to very nearly the pump's
 * shutoff head with the valve nearly closed.
 *
 * A drive has no such floor: it can take the header down to nothing. A throttle valve can only
 * ADD resistance, which means it can only hold a pressure the pump is ALREADY making more than.
 * Everything between the two is head the pump produced and the valve destroyed, and that is
 * precisely the energy the variable-speed argument is about.
 *
 * A setpoint below the wide-open pressure is not a tuning problem and no controller can reach it.
 * The rig therefore checks this before letting anyone try.
 * ------------------------------------------------------------------------------------------
 *
 * @param {object} config frozen config
 * @param {object} st plant state (restored before returning)
 * @param {number} [speed_pct] the fixed speed to evaluate at, defaulting to the current one
 * @returns {{lo_bar:number, hi_bar:number, ok:boolean}} the reachable band, and whether any
 *   machine was running to produce one
 */
export function throttleRange(config, st, speed_pct) {
  const n = speed_pct === undefined ? st.fixedSpeed_pct : speed_pct;
  const savedSpeeds = st.drv.map((d) => d.n_pct);
  const savedPcv = st.pcv.x;
  const savedH = st.H_m;
  const savedQ = st.Qdem_m3h;
  let live = 0;
  for (let i = 0; i < st.drv.length; i += 1) {
    if (st.drv[i].state === DRIVE.RUNNING || st.drv[i].state === DRIVE.STARTING) {
      st.drv[i].n_pct = n;
      live += 1;
    }
  }
  let lo = NaN;
  let hi = NaN;
  if (live > 0) {
    st.pcv.x = 1;
    lo = headToBar(solveSteady(config, st).H_m, st.fluid.rho_kgm3);
    st.pcv.x = 0.04;
    hi = headToBar(solveSteady(config, st).H_m, st.fluid.rho_kgm3);
  }
  for (let i = 0; i < st.drv.length; i += 1) st.drv[i].n_pct = savedSpeeds[i];
  st.pcv.x = savedPcv;
  st.H_m = savedH;
  st.Qdem_m3h = savedQ;
  return { lo_bar: lo, hi_bar: hi, ok: live > 0 };
}

/**
 * The fixed speed that puts a wanted header pressure comfortably inside the throttle valve's
 * reachable band, with room below it to open into.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (restored before returning)
 * @param {number} target_bar the setpoint that has to be reachable
 * @returns {number} a fixed speed, percent, or NaN when nothing is running
 */
export function speedForThrottleSetpoint(config, st, target_bar) {
  const probe = throttleRange(config, st, 100);
  if (!probe.ok) return NaN;
  // Centre the setpoint in the band rather than merely clearing its floor. A setpoint sitting
  // just above the wide-open pressure has authority in one direction only: the valve can raise
  // the header but has almost nothing left to lower it with, and the loop behaves as if it were
  // permanently half-saturated. Centring gives it room both ways.
  let lo = 25;
  let hi = 100;
  for (let k = 0; k < 34; k += 1) {
    const mid = 0.5 * (lo + hi);
    const band = throttleRange(config, st, mid);
    const centre = 0.5 * (band.lo_bar + band.hi_bar);
    if (centre < target_bar) lo = mid; else hi = mid;
  }
  return clamp(0.5 * (lo + hi), 25, 100);
}

/**
 * Solve the plant for a hypothetical set of running machines at the duty that satisfies a target,
 * and report what it would cost.
 *
 * This is what the energy-optimal staging criterion runs on, and it has to be done on the plant
 * itself rather than on a curve, because the answer depends on where the system curve crosses and
 * that moves with every valve on the rig. The state is put where the hypothesis says, read, and
 * put back exactly as it was — nothing here is allowed to leave a mark.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (restored before returning)
 * @param {number[]} running indices of the machines to assume are turning
 * @param {number} target the setpoint to satisfy
 * @param {string} mode 'PRESSURE' or 'FLOW'
 * @returns {{ok:boolean, co_pct:number, electrical_kW:number, Q_m3h:number, p_bar:number}} the
 *   predicted operating point; `ok` is false when the target is not reachable that way
 */
export function predictOperatingPoint(config, st, running, target, mode) {
  const nP = config.pumps.length;
  const saved = {
    states: st.drv.map((d) => d.state),
    speeds: st.drv.map((d) => d.n_pct),
    H: st.H_m,
    Qd: st.Qdem_m3h,
    Q: Float64Array.from(st.Q_m3h),
    Hp: Float64Array.from(st.Hp_m),
    Qb: st.Qbypass_m3h,
    Qt: st.Qtotal_m3h,
    Qdem: st.Qdemand_m3h,
    check: Uint8Array.from(st.checkShut),
    Re: Float64Array.from(st.Re),
  };
  const out = { ok: false, co_pct: NaN, electrical_kW: NaN, Q_m3h: NaN, p_bar: NaN };
  try {
    for (let i = 0; i < nP; i += 1) {
      st.drv[i].state = running.includes(i) ? DRIVE.RUNNING : DRIVE.STOPPED;
      if (!running.includes(i)) st.drv[i].n_pct = 0;
    }
    if (!running.length) return out;
    const sol = outputForSetpoint(config, st, target, mode);
    if (!sol.achievable) return out;
    for (const i of running) {
      const d = config.drives[i];
      st.drv[i].n_pct = d.minSpeed_pct + (d.maxSpeed_pct - d.minSpeed_pct) * (sol.co_pct / 100);
    }
    const eq = solveSteady(config, st);
    st.H_m = eq.H_m;
    st.Qdem_m3h = eq.Qd_m3h;
    evaluateNetwork(config, st, st.H_m, st.Qdem_m3h, true);

    let elec = 0;
    for (const i of running) {
      const drive = config.drives[i];
      const s = st.drv[i].n_pct / 100;
      const shaft = shaftPower_kW(st.eff[i], st.Q_m3h[i], s, st.fluid.rho_kgm3);
      // The same loss model `stepDrive` uses, evaluated statically. Keeping the two in step
      // matters: a prediction that is optimistic about losses stages the set differently from
      // the meter, and nothing looks worse than a controller that disagrees with the tariff.
      const load = drive.motor_kW > 0 ? shaft / drive.motor_kW : 0;
      const sSpeed = Math.max(s, 0.05);
      const motorLoss = drive.lossFixed_kW * Math.pow(sSpeed, 1.5) + drive.lossVar_kW * load * load;
      const driveLoss = 0.005 * drive.motor_kW + 0.02 * (shaft + motorLoss);
      elec += shaft + motorLoss + driveLoss;
    }
    out.ok = true;
    out.co_pct = sol.co_pct;
    out.electrical_kW = elec;
    out.Q_m3h = st.Qdemand_m3h;
    out.p_bar = headToBar(st.H_m, st.fluid.rho_kgm3);
  } finally {
    for (let i = 0; i < nP; i += 1) {
      st.drv[i].state = saved.states[i];
      st.drv[i].n_pct = saved.speeds[i];
    }
    st.H_m = saved.H;
    st.Qdem_m3h = saved.Qd;
    st.Q_m3h.set(saved.Q);
    st.Hp_m.set(saved.Hp);
    st.Qbypass_m3h = saved.Qb;
    st.Qtotal_m3h = saved.Qt;
    st.Qdemand_m3h = saved.Qdem;
    st.checkShut.set(saved.check);
    st.Re.set(saved.Re);
  }
  return out;
}

/**
 * The valve a stem is actually attached to today: the nameplate record with any maintenance
 * state laid over it.
 *
 * @param {object} base the frozen valve from the config
 * @param {{strokeTime_s:(number|null), stickband:number, slipJump:number}} ov the overrides
 * @returns {object} a valve record for {@link stepStem}
 */
export function effectiveValve(base, ov) {
  if (!ov || (!ov.stickband && !ov.slipJump && ov.strokeTime_s == null)) return base;
  return {
    ...base,
    strokeTime_s: ov.strokeTime_s == null ? base.strokeTime_s : ov.strokeTime_s,
    stickband: ov.stickband || 0,
    // A stem that sticks and then does not jump is a deadband, not stiction, and it does not
    // produce a limit cycle. Default the slip to half the stickband, which is the usual shape.
    slipJump: ov.slipJump || (ov.stickband ? ov.stickband * 0.5 : 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Resistances
// ---------------------------------------------------------------------------------------------

/**
 * The resistance of one pump's branch: suction pipe, strainer, discharge spool and check valve,
 * as a single `K` in `dH = K*Q^2`, evaluated at the previous tick's flow and viscosity.
 * @param {object} config frozen config
 * @param {object} st plant state
 * @param {number} i pump index
 * @returns {{K:number, kvStrainer:number, Ksuction:number}} the branch coefficient, the fouled
 *   strainer's Kv, and the suction-only part (which is what NPSH cares about)
 */
function branchResistance(config, st, i) {
  const Q = st.Q_m3h[i];
  const nu = st.fluid.nu_cSt;
  const kvStrainer = config.suction.strainerKv_m3h * (1 - clamp(st.foul, 0, 0.97));
  const Ksuction = resistanceK(config.pipes.suction, Q, nu) + kvToK(kvStrainer);
  const Kdischarge = resistanceK(config.pipes.pumpDischarge, Q, nu)
    + kvToK(config.discharge.checkKv_m3h);
  return { K: Ksuction + Kdischarge, kvStrainer, Ksuction };
}

/**
 * The total resistance of the discharge line, from the header to the process: the throttle valve,
 * the demand valve and the pipe between them.
 * @param {object} config frozen config
 * @param {object} st plant state
 * @returns {number} K, m per (m3/h)^2
 */
function dischargeResistance(config, st) {
  return kvToK(kvAt(config.pcvValve, st.pcv.x))
    + kvToK(kvAt(config.demandValve, st.fcv.x))
    + resistanceK(config.pipes.discharge, st.Qdem_m3h, st.fluid.nu_cSt);
}

/**
 * Rebuild the derated machine each pump currently is: viscosity, impeller trim, accumulated wear
 * and the cavitation it is presently suffering, all folded into one set of curve coefficients.
 * @param {object} config frozen config
 * @param {object} st plant state (mutated: `eff`)
 * @returns {void}
 */
function rebuildDerated(config, st) {
  for (let i = 0; i < config.pumps.length; i += 1) {
    st.eff[i] = deratedPump(config.pumps[i], {
      trim: st.trim[i],
      wear: st.wear[i],
      cav: st.cav[i],
      visc: st.visc,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------------------------

/**
 * Evaluate the network at a trial state: every branch flow, the two residuals, and the analytic
 * 2x2 Jacobian the implicit step needs.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (read; written only when `commit`)
 * @param {number} H_m trial header head, m
 * @param {number} Qd_m3h trial discharge-line flow, m3/h
 * @param {boolean} commit whether to write the resulting flows back onto the state
 * @returns {{fH:number, fQ:number, j11:number, j12:number, j21:number, j22:number}} the residuals
 *   in state units per second and the Jacobian of them
 */
function evaluateNetwork(config, st, H_m, Qd_m3h, commit) {
  const rho = st.fluid.rho_kgm3;

  // --- pump branches, each a closed-form quadratic ------------------------------------------
  let sum = 0;
  let dSum = 0;
  let delivering = false;
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    const { K } = branchResistance(config, st, i);
    const r = solveBranchFlow(st.eff[i], s, H_m, st.zStatic_m, K);
    sum += r.Q_m3h;
    dSum += r.dQdH;
    if (!r.checkShut && st.drv[i].n_pct > 2) delivering = true;
    if (commit) {
      st.Q_m3h[i] = r.Q_m3h;
      st.checkShut[i] = r.checkShut ? 1 : 0;
      st.Hp_m[i] = headAt(st.eff[i], r.Q_m3h, s);
    }
  }

  // --- recirculation, algebraic: a short line straight back to the tank -----------------------
  // An automatic recirculation valve lives on the PUMP DISCHARGE, upstream of the check valve —
  // in real hardware it is usually the same casting as the check valve. That placement is not an
  // accident of layout: it means the recirculation line cannot drain the header backwards when
  // the machines stop. Put it downstream of the check valve instead and every stopped set
  // depressurises itself through its own minimum-flow line, which among other things makes sleep
  // mode impossible. So the path exists only while something is actually delivering.
  // `delivering` comes from THIS evaluation's branch solves, not from the committed state. The
  // steady solve calls this function dozens of times at trial heads without committing, and a
  // bypass whose existence depended on the last committed answer would make the whole bisection
  // self-inconsistent — it would converge on a header the integrator then walks away from.
  const kvByp = delivering ? kvAt(config.bypassValve, st.bypass) : 0;
  const dHbyp = H_m - st.zStatic_m;
  const Qbyp = flowThrough(kvByp, dHbyp);
  const dQbyp = flowSlope(kvByp, dHbyp);

  // --- the header capacitance ------------------------------------------------------------------
  const pAbs_Pa = Math.max((headToBar(H_m, rho) + st.pAtm_bar) * 1e5, 2e4);
  const C = (rho * G * config.header.gasVolume_m3) / pAbs_Pa;
  const invC = 1 / (C * S_PER_H);

  // --- the discharge line inertance ---------------------------------------------------------
  const I = inertiaCoefficient(config.pipes.discharge);
  const Kd = dischargeResistance(config, st);
  const loss = Kd * Qd_m3h * Math.abs(Qd_m3h);
  const fQ = (H_m - st.hDischarge_m - loss) / I;
  const dfQ_dQ = (-2 * Kd * Math.abs(Qd_m3h)) / I;

  const fH = (sum - Qd_m3h - Qbyp) * invC;

  if (commit) {
    st.Qtotal_m3h = sum;
    st.Qbypass_m3h = Qbyp;
    st.Qdemand_m3h = Qd_m3h;
  }
  return {
    fH,
    fQ,
    j11: (dSum - dQbyp) * invC,
    j12: -invC,
    j21: 1 / I,
    j22: dfQ_dQ,
  };
}

/**
 * Solve the network at steady state, by bisection on the header head with the discharge flow
 * taken at its own equilibrium for each trial.
 *
 * Used for the initial condition and by the tests; the running plant integrates instead. The
 * bracket is provable rather than guessed: at the lower bound every outlet differential is
 * non-positive so the residual is non-negative, and at the highest shutoff head every check valve
 * is shut so it is non-positive.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (read only)
 * @returns {{H_m:number, Qd_m3h:number}} the equilibrium
 */
export function solveSteady(config, st) {
  const Kd = dischargeResistance(config, st);
  /**
   * The discharge-line flow that balances at a given header head.
   * @param {number} H header head, m
   * @returns {number} flow, m3/h
   */
  const qdOf = (H) => {
    const dh = H - st.hDischarge_m;
    return Math.sign(dh) * Math.sqrt(Math.abs(dh) / Kd);
  };
  let hi = Math.max(st.zStatic_m, st.hDischarge_m);
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    hi = Math.max(hi, st.zStatic_m + s * s * st.eff[i].H0_m);
  }
  let lo = Math.min(st.zStatic_m, st.hDischarge_m) - 1;
  hi += 1;
  for (let k = 0; k < 70; k += 1) {
    const mid = 0.5 * (lo + hi);
    const r = evaluateNetwork(config, st, mid, qdOf(mid), false);
    if (r.fH > 0) lo = mid; else hi = mid;
  }
  const H = 0.5 * (lo + hi);
  return { H_m: H, Qd_m3h: qdOf(H) };
}

/**
 * Assess the suction condition of every machine.
 *
 * NPSH available is evaluated at the flow the pump was passing on the PREVIOUS tick. The coupling
 * back into head is weak, and taking it explicitly is what keeps the branch solve a closed-form
 * quadratic instead of a nested iteration.
 *
 * The vapour pressure is taken at the temperature the liquid is AT THE IMPELLER EYE, which is the
 * tank temperature under normal throughflow but the casing temperature when the pump is churning
 * — because then the liquid at the eye is the same liquid the pump has been heating. That is what
 * makes a deadheaded pump vapour-lock rather than merely get hot.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (mutated)
 * @param {number} dt_s tick, s — 0 to apply the cavitation multiplier without its lag
 * @returns {void}
 */
function updateSuction(config, st, dt_s) {
  const f = config.pumps[0];
  const Qeye = 0.02 * f.Qbep_m3h;
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    const { kvStrainer } = branchResistance(config, st, i);
    const hFric = headLoss_m(config.pipes.suction, st.Q_m3h[i], st.fluid.nu_cSt)
      + (st.Q_m3h[i] / (0.313155 * Math.max(kvStrainer, 1e-6))) ** 2;
    // Blend tank and casing temperature by how much fresh liquid is actually passing.
    const blend = Math.exp(-Math.abs(st.Q_m3h[i]) / Qeye);
    const Teye = st.T_tank_C + (st.Tcasing_C[i] - st.T_tank_C) * blend;
    const eye = fluidAt(st.fluidId, Teye);
    st.npsha_m[i] = npshAvailable_m({
      pTank_bar: config.tank.pTank_bar,
      pVap_bar: eye.pVap_bar,
      zStatic_m: st.zStatic_m,
      hFriction_m: hFric,
      rho_kgm3: st.fluid.rho_kgm3,
      pAtm_bar: st.pAtm_bar,
    });
    st.npshr_m[i] = npshRequired_m(st.eff[i], st.Q_m3h[i], s);
    st.Re[i] = reynolds(config.pipes.suction, st.Q_m3h[i], st.fluid.nu_cSt);
    const target = cavitationFactor(st.npsha_m[i], st.npshr_m[i]);
    // The multiplier is taken through a short lag rather than applied instantly. Physically,
    // vapour cavities take a finite time to form and collapse. Numerically, that lag is also what
    // makes the explicit coupling safe: without it a pump sitting exactly at zero suction margin
    // gets into a tick-rate limit cycle that is entirely an artefact of the discretisation.
    st.cav[i] = dt_s > 0 ? lag(st.cav[i], target, config.cavTau_s, dt_s) : target;
  }
}

/**
 * Put the plant on its steady state for the current speeds, valve travel and disturbances, and
 * prime every instrument to agree with it.
 *
 * Used at boot and after any change that would otherwise open on a transient the operator did not
 * cause. NOT used while running: a settle is a teleport, and the whole value of the rig is in the
 * journey.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (mutated)
 * @returns {void}
 */
export function settlePlant(config, st) {
  st.fluid = fluidAt(st.fluidId, st.T_tank_C);
  st.visc = viscousCorrection(config.pumps[0], st.fluid.nu_cSt);
  st.zStatic_m = config.tank.zBase_m + st.level_m;
  st.fcv.x = clamp(st.demandTarget, 0, 1);
  st.fcv.cmd = st.fcv.x;
  // Three passes: flows, then the suction margins those flows imply, then the flows again with
  // the resulting derating. A running tick takes that coupling across ticks; a settle has no
  // previous tick to take it from.
  for (let pass = 0; pass < 4; pass += 1) {
    rebuildDerated(config, st);
    const eq = solveSteady(config, st);
    st.H_m = eq.H_m;
    st.Qdem_m3h = eq.Qd_m3h;
    evaluateNetwork(config, st, st.H_m, st.Qdem_m3h, true);
    updateSuction(config, st, 0);
    // The recirculation valve is part of the network, so a settle that leaves it wherever it
    // happened to be is not a settle: the flows it produces are for a plant with a different
    // valve position, and the very first tick walks away from them. It is a mechanical device
    // with no dynamics of its own, so it settles in the same passes as everything else.
    updateRecirc(config, st);
  }
  st.p_bar = headToBar(st.H_m, st.fluid.rho_kgm3);
  st.pt_bar = st.p_bar;
  st.ft_m3h = st.Qdemand_m3h;
  st.lt_m = st.level_m;
  st.tt_C = st.T_tank_C;
  st._sig.ptDelay.buf.fill(st.p_bar);
  st._sig.ftDelay.buf.fill(st.ft_m3h);
  for (let i = 0; i < config.pumps.length; i += 1) {
    const s = st.drv[i].n_pct / 100;
    st.P_kW[i] = shaftPower_kW(st.eff[i], st.Q_m3h[i], s, st.fluid.rho_kgm3);
    st.eta[i] = efficiencyAt(st.eff[i], st.Q_m3h[i], st.Hp_m[i], s, st.fluid.rho_kgm3);
    st.Tcasing_C[i] = st.T_tank_C;
  }
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

/**
 * Advance the whole plant by one fixed tick.
 *
 * Order matters and is fixed: final elements move first (they are what the LAST controller output
 * asked for), then fluid properties and the suction condition, then the network integrates, then
 * the machines, then the inventories, then the instruments. Reversing any two of those would let
 * a controller output affect the measurement inside the same tick, which is the classic way a
 * simulator ends up flattering a tuning that would not survive contact with a real scan cycle.
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

  // --- 1. final elements -----------------------------------------------------------------
  stepStem(effectiveValve(config.demandValve, st.valveOverride.fcv), st.fcv,
    clamp(st.demandTarget, 0, 1), dt_s);
  stepStem(effectiveValve(config.pcvValve, st.valveOverride.pcv), st.pcv, st.pcv.cmd, dt_s);
  updateRecirc(config, st);

  // --- 2. fluid properties -----------------------------------------------------------------
  st.fluid = fluidAt(st.fluidId, st.T_tank_C);
  st.visc = viscousCorrection(config.pumps[0], st.fluid.nu_cSt);
  const rho = st.fluid.rho_kgm3;

  // --- 3. suction condition, then the derated machines it implies ---------------------------
  st.zStatic_m = config.tank.zBase_m + st.level_m;
  rebuildDerated(config, st);
  updateSuction(config, st, dt_s);
  rebuildDerated(config, st);

  // --- 4. the network: one linearly-implicit Euler step on the 2x2 system --------------------
  const r = evaluateNetwork(config, st, st.H_m, st.Qdem_m3h, false);
  const a11 = 1 - dt_s * r.j11;
  const a12 = -dt_s * r.j12;
  const a21 = -dt_s * r.j21;
  const a22 = 1 - dt_s * r.j22;
  const det = a11 * a22 - a12 * a21;
  let dH;
  let dQ;
  if (Math.abs(det) > 1e-12) {
    dH = (dt_s * (a22 * r.fH - a12 * r.fQ)) / det;
    dQ = (dt_s * (-a21 * r.fH + a11 * r.fQ)) / det;
  } else {
    dH = dt_s * r.fH;
    dQ = dt_s * r.fQ;
  }
  st.H_m = clamp(st.H_m + dH, -60, 500);
  st.Qdem_m3h = clamp(st.Qdem_m3h + dQ, -400, 400);
  evaluateNetwork(config, st, st.H_m, st.Qdem_m3h, true);
  st.p_bar = headToBar(st.H_m, rho);
  st.vDischarge_ms = velocity_ms(config.pipes.discharge, st.Qdem_m3h);

  // --- 5. the machines: power, condition, drives ---------------------------------------------
  let recircHeat_kW = 0;
  let recircFlow = 0;
  for (let i = 0; i < config.pumps.length; i += 1) {
    const d = st.drv[i];
    const s = d.n_pct / 100;
    const eff = st.eff[i];
    st.P_kW[i] = shaftPower_kW(eff, st.Q_m3h[i], s, rho);
    st.eta[i] = efficiencyAt(eff, st.Q_m3h[i], st.Hp_m[i], s, rho);
    st.dT_K[i] = temperatureRise_K(eff, st.Q_m3h[i], st.Hp_m[i], s, rho, st.fluid.cp_JkgK);
    st.vib_mms[i] = vibration_mms(eff, st.Q_m3h[i], s, st.cav[i], st.wear[i]);

    // Casing thermal balance. The casing holds liquid and metal; the pump pours heat into it and
    // throughflow carries heat away. At zero flow there is nowhere for the heat to go.
    const Cth = (eff.casingVolume_L * rho * 1e-3) * st.fluid.cp_JkgK
      + eff.casingMass_kg * config.thermal.metalCp_JkgK;
    const heat_W = heatIntoLiquid_kW(eff, st.Q_m3h[i], st.Hp_m[i], s, rho) * 1000;
    const mdot = (Math.max(0, st.Q_m3h[i]) / S_PER_H) * rho;
    const carried_WK = mdot * st.fluid.cp_JkgK;
    const toAmbient_WK = config.thermal.casingUA_WK;
    // Backward Euler on the casing temperature: the loss terms are stiff at high flow.
    const num = st.Tcasing_C[i] + (dt_s / Cth)
      * (heat_W + carried_WK * st.T_tank_C + toAmbient_WK * config.site.ambient_C);
    const den = 1 + (dt_s / Cth) * (carried_WK + toAmbient_WK);
    st.Tcasing_C[i] = clamp(num / den, -50, 250);

    if (st.Q_m3h[i] > 0) { recircHeat_kW += st.Q_m3h[i] * st.Tcasing_C[i]; recircFlow += st.Q_m3h[i]; }

    // Wear accumulates only while turning, and much faster off-BEP or cavitating.
    if (s > 0.05) {
      st.wear[i] = clamp(
        st.wear[i] + wearRate_perH(eff, st.Q_m3h[i], s, st.cav[i], config.wear.baseRate_perH)
          * (dt_s / 3600),
        0, 1,
      );
    }

    const stalled = 0.15 * config.drives[i].Trated_Nm;
    const tripReason = stepDrive(
      config.drives[i], d, loadTorque_Nm(st.P_kW[i], d.w_rads, stalled), dt_s,
    );
    if (tripReason) st.events.push({ tag: eff.tag, severity: 'ALARM', message: tripReason });
  }
  const Tdischarge_C = recircFlow > 0 ? recircHeat_kW / recircFlow : st.T_tank_C;

  // --- 6. inventory and tank temperature ------------------------------------------------------
  const draw = st.Qtotal_m3h - st.Qbypass_m3h;
  if (st.makeupAuto) {
    const err = config.tank.levelSP_m - st.level_m;
    st.inflow_m3h = clamp(draw + config.tank.makeupGain * err, 0, config.tank.makeupMax_m3h);
  }
  st.V_m3 = clamp(
    st.V_m3 + ((st.inflow_m3h + st.Qbypass_m3h - st.Qtotal_m3h) / S_PER_H) * dt_s,
    0.001, config.tank.area_m2 * config.tank.height_m,
  );
  st.level_m = st.V_m3 / config.tank.area_m2;

  // The tank mixes cold make-up with hot recirculation. This is the loop that turns a shut
  // minimum-flow line from a nuisance into a runaway: the recirculation heats the tank, the hotter
  // tank raises the vapour pressure, and the suction margin that was adequate stops being so.
  {
    const mass = st.V_m3 * rho;
    const cin = (st.inflow_m3h / S_PER_H) * rho;
    const crec = (Math.max(0, st.Qbypass_m3h) / S_PER_H) * rho;
    const num = st.T_tank_C * (mass / dt_s) + cin * st.Tsupply_C + crec * Tdischarge_C
      + (config.thermal.tankUA_WK / st.fluid.cp_JkgK) * config.site.ambient_C;
    const den = (mass / dt_s) + cin + crec + config.thermal.tankUA_WK / st.fluid.cp_JkgK;
    st.T_tank_C = clamp(num / den, -50, 200);
  }

  // --- 7. instruments ---------------------------------------------------------------------------
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
  st.tt_C = lag(st.tt_C, st.T_tank_C, ins.tt.filter_s, dt_s);
}

/**
 * Position the minimum-flow recirculation according to how it is being operated.
 *
 * An automatic recirculation valve is a self-contained mechanical device, not a control loop: a
 * flow-sensing element opens a bypass as the forward flow falls below its setting, with no
 * controller, no setpoint and no way for a tuning mistake to defeat it. That independence is the
 * entire reason it exists, and it is why it is modelled here in the plant rather than in
 * `src/control` alongside things an operator can detune.
 *
 * @param {object} config frozen config
 * @param {object} st plant state (mutated: `bypass`)
 * @returns {void}
 */
function updateRecirc(config, st) {
  switch (st.recircMode) {
    case RECIRC.CLOSED:
      st.bypass = 0;
      break;
    case RECIRC.ARV: {
      let running = 0;
      for (const d of st.drv) if (d.n_pct > 5) running += 1;
      const need = config.bypass.arvSetpoint_m3h * Math.max(1, running);
      const forward = Math.max(0, st.Qdemand_m3h);
      st.bypass = clamp((need - forward) / Math.max(need, 1e-6), 0, 1);
      break;
    }
    default:
      break;   // MANUAL: whatever the operator left it at
  }
}

// ---------------------------------------------------------------------------------------------
// Readings the rest of the application asks for
// ---------------------------------------------------------------------------------------------

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
 * Total electrical power drawn by the skid, kW.
 * @param {object} st plant state
 * @returns {number} power, kW
 */
export function electricalPower_kW(st) {
  let p = 0;
  for (const d of st.drv) p += d.pElec_kW;
  return p;
}

/**
 * Useful hydraulic power delivered to the process, kW.
 *
 * Deliberately NOT the power the pumps produced: head burned across a throttle valve, and flow
 * sent round the recirculation, are both work the plant paid for and did not deliver. Measuring
 * from the process side is the only way the throttling and variable-speed strategies can be
 * compared honestly.
 *
 * @param {object} st plant state
 * @param {object} config frozen config
 * @returns {number} power, kW
 */
export function usefulPower_kW(st, config) {
  const Q = Math.max(0, st.Qdemand_m3h);
  if (!(Q > 0)) return 0;
  // The head the PROCESS asked for: its static lift plus the loss through its own valve and the
  // line feeding it. Anything the pumps made above that was burned across the throttle valve, and
  // anything they passed through the recirculation never left the skid at all.
  const Kload = kvToK(kvAt(config.demandValve, st.fcv.x))
    + resistanceK(config.pipes.discharge, Q, st.fluid.nu_cSt);
  return hydraulicPower_kW(Q, st.hDischarge_m + Kload * Q * Q, st.fluid.rho_kgm3);
}

/**
 * Head burned across the throttle valve, m — zero in variable-speed mode by construction, and the
 * entire argument for variable speed when it is not.
 * @param {object} config frozen config
 * @param {object} st plant state
 * @returns {number} head lost across PCV-101, m
 */
export function throttleLoss_m(config, st) {
  const Q = Math.max(0, st.Qdemand_m3h);
  return kvToK(kvAt(config.pcvValve, st.pcv.x)) * Q * Q;
}

/**
 * Sample the combined pump characteristic and the system resistance curve over a flow range, for
 * the operating-point chart.
 *
 * Both curves are evaluated from the same functions the tick uses, so the chart can never drift
 * away from the simulation it is drawing.
 *
 * @param {object} config frozen config
 * @param {object} st plant state
 * @param {number} n number of samples
 * @returns {{Q:Float64Array, Hpump:Float64Array, Hsys:Float64Array, Href:Float64Array,
 *   Qmax:number, nRun:number}} the curves
 */
export function characteristicCurves(config, st, n) {
  const Qmax = config.pumps[0].Qmax_m3h * 2.2;
  const Q = new Float64Array(n);
  const Hpump = new Float64Array(n);
  const Hsys = new Float64Array(n);
  const Href = new Float64Array(n);
  const running = [];
  for (let i = 0; i < config.pumps.length; i += 1) if (st.drv[i].n_pct > 1) running.push(i);

  const kvByp = kvAt(config.bypassValve, st.bypass);
  const Kd = dischargeResistance(config, st);
  const nu = st.fluid.nu_cSt;

  for (let j = 0; j < n; j += 1) {
    const q = (Qmax * j) / (n - 1);
    Q[j] = q;

    if (running.length === 0) {
      Hpump[j] = NaN;
    } else {
      let h = 0;
      for (const i of running) {
        const s = st.drv[i].n_pct / 100;
        const qi = q / running.length;
        const { K } = branchResistance(config, st, i);
        h += st.zStatic_m + headAt(st.eff[i], qi, s) - K * qi * qi;
      }
      Hpump[j] = h / running.length;
    }
    // Reference: the same machines at full speed on a clean, cold, water duty.
    {
      const qi = q / Math.max(1, running.length || 1);
      const K = resistanceK(config.pipes.suction, qi, 1) + kvToK(config.suction.strainerKv_m3h)
        + resistanceK(config.pipes.pumpDischarge, qi, 1) + kvToK(config.discharge.checkKv_m3h);
      Href[j] = st.zStatic_m + headAt(config.pumps[0], qi, 1) - K * qi * qi;
    }
    // System: the demand path and the recirculation in parallel, inverted onto a head.
    {
      let lo = st.zStatic_m - 5;
      let hi = st.zStatic_m + 600;
      for (let k = 0; k < 44; k += 1) {
        const mid = 0.5 * (lo + hi);
        const dh = mid - st.hDischarge_m;
        const qd = Math.sign(dh) * Math.sqrt(Math.abs(dh) / Kd);
        const qb = flowThrough(kvByp, mid - st.zStatic_m);
        if (qd + qb < q) lo = mid; else hi = mid;
      }
      Hsys[j] = 0.5 * (lo + hi);
    }
  }
  return { Q, Hpump, Hsys, Href, Qmax, nRun: running.length, nu };
}

/**
 * Invert the steady-state plant: what controller output would hold a given measurement, at the
 * valve position and machine line-up the rig is in right now?
 *
 * This is the model-based feedforward, and it is the reason a feedforward on this rig can be very
 * good rather than merely helpful. A conventional feedforward is a hand-fitted curve from the
 * disturbance to the output; this one asks the actual network what output the actual machines
 * would need, including the pump curve, the viscosity derating, how many pumps are running and
 * where the demand valve is. The answer is exact at steady state by construction.
 *
 * What it CANNOT know is anything dynamic — it is a steady-state inverse, so it arrives too early
 * or too late unless it is passed through the lead-lag in `control/strategy.js`. That division of
 * labour is the honest one: the model handles the magnitude, and a two-parameter filter handles
 * the timing.
 *
 * The search is a bisection on output, which is monotone because more speed is more head and more
 * flow, everywhere. Forty iterations put it well inside the resolution of anything downstream.
 *
 * @param {object} config frozen config
 * @param {object} st plant state — READ ONLY; the speeds it perturbs are restored before return
 * @param {number} target the measurement to hold, in `mode`'s engineering units
 * @param {string} mode 'PRESSURE' or 'FLOW'
 * @returns {{co_pct:number, achievable:boolean}} the output, and whether the rig can get there at
 *   all at this line-up
 */
export function outputForSetpoint(config, st, target, mode) {
  const saved = st.drv.map((d) => d.n_pct);
  const live = [];
  for (let i = 0; i < st.drv.length; i += 1) {
    if (st.drv[i].state === DRIVE.RUNNING || st.drv[i].state === DRIVE.STARTING) live.push(i);
  }
  /**
   * The measurement the rig would settle at for a trial controller output.
   * @param {number} co controller output, percent
   * @returns {number} the measurement, in `mode` units
   */
  const pvAt = (co) => {
    for (const i of live) {
      st.drv[i].n_pct = config.drives[i].minSpeed_pct
        + (config.drives[i].maxSpeed_pct - config.drives[i].minSpeed_pct) * (co / 100);
    }
    const eq = solveSteady(config, st);
    if (mode === 'FLOW') return eq.Qd_m3h;
    return headToBar(eq.H_m, st.fluid.rho_kgm3);
  };
  let result = 100;
  let achievable = true;
  if (live.length === 0) {
    result = 100;
    achievable = false;
  } else {
    const atLo = pvAt(0);
    const atHi = pvAt(100);
    if (target <= atLo) { result = 0; achievable = target >= atLo - 1e-9; }
    else if (target >= atHi) { result = 100; achievable = false; }
    else {
      let lo = 0;
      let hi = 100;
      for (let k = 0; k < 40; k += 1) {
        const mid = 0.5 * (lo + hi);
        if (pvAt(mid) < target) lo = mid; else hi = mid;
      }
      result = 0.5 * (lo + hi);
    }
  }
  for (let i = 0; i < st.drv.length; i += 1) st.drv[i].n_pct = saved[i];
  return { co_pct: result, achievable };
}

/**
 * The minimum flow this machine needs right now, and why.
 * @param {object} config frozen config
 * @param {object} st plant state
 * @param {number} i pump index
 * @returns {{stable_m3h:number, thermal_m3h:number, governing_m3h:number, reason:string}} the two
 *   criteria and whichever of them is binding
 */
export function minimumFlow(config, st, i) {
  const eff = st.eff[i] || config.pumps[i];
  const s = Math.max(st.drv[i].n_pct / 100, 0.05);
  const stable = eff.minFlow_m3h * s;
  const thermal = thermalMinFlow_m3h(
    eff, s, st.fluid.rho_kgm3, st.fluid.cp_JkgK, config.thermal.dTlimit_K,
  );
  return stable >= thermal
    ? { stable_m3h: stable, thermal_m3h: thermal, governing_m3h: stable, reason: 'recirculation' }
    : { stable_m3h: stable, thermal_m3h: thermal, governing_m3h: thermal, reason: 'temperature rise' };
}

/** Re-exported so callers do not need a second import for the common enums. */
export { DRIVE, STOP_MODE, speedToReference };
