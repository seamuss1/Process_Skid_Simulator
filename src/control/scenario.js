/**
 * src/control/scenario.js — scripted disturbance tests and the scorecard that grades them.
 *
 * Layer L3: imports `core/util.js` only, and is handed the plant and controller state by the sim.
 * No DOM.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A SCORECARD
 *
 * "That looks better" is how most tuning is done and it is why most loops are tuned badly. Two
 * tunings can only be compared if they face the SAME disturbance from the SAME starting point,
 * and if what counts as better is agreed before either is tried. That is all a scripted test is.
 *
 * The metrics are the standard ones, and each of them is here because it catches a failure the
 * others miss:
 *
 *   IAE     integral of absolute error. The headline number. Penalises being wrong for a long
 *           time as much as being very wrong briefly, which is usually what a process cares about.
 *   ITAE    the same, weighted by elapsed time. Forgives the unavoidable error just after a
 *           disturbance and punishes the tail. A loop that settles slowly scores badly here even
 *           when its IAE looks respectable.
 *   Overshoot  peak excursion past setpoint as a percentage of the step. The one an operator
 *           notices, and the one that lifts relief valves and stages pumps you did not want.
 *   Settling  time to enter and stay inside a band. Quarter-amplitude tunings look fast on the
 *           rise and lose here.
 *   CO travel  total variation of the controller output. The wear term. A loop that holds
 *           setpoint by hunting the drive up and down all shift has a wonderful IAE and destroys
 *           the machine, and this is the only column that says so.
 *   Starts   pump transitions. On a dual-pump set this is the wear term that actually costs
 *           money, and it is the one a scorecard without staging cannot see at all.
 *
 * The composite grade weights them roughly the way a plant would, and its breakdown is published
 * so nobody has to trust the single number.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { trip as tripDrive, reset as resetDrive } from '../process/motor.js';

/**
 * The scripted tests. Times are seconds from the start of the run; `value` is interpreted by the
 * action. `settle` is the lead-in the rig gets before anything is disturbed, so a test never
 * grades a transient it inherited.
 */
export const SCENARIOS = Object.freeze([
  {
    id: 'SP_STEP',
    name: 'Setpoint step',
    blurb: 'A step up, then back down. Grades servo response: overshoot, settling, and whether '
      + 'derivative kick throws the drive.',
    duration_s: 240,
    steps: [
      { t: 20, action: 'spDelta', value: +0.5, label: 'SP step up' },
      { t: 130, action: 'spDelta', value: 0, label: 'SP step back' },
    ],
  },
  {
    id: 'LOAD_STEP',
    name: 'Load step',
    blurb: 'The downstream demand opens hard, then closes. Grades regulation — the job the loop '
      + 'actually does all day.',
    duration_s: 260,
    steps: [
      { t: 20, action: 'demand', value: 0.62, label: 'demand valve to 62%' },
      { t: 140, action: 'demand', value: 0.45, label: 'demand valve back to 45%' },
    ],
  },
  {
    id: 'STAGE',
    name: 'Stage up and back',
    blurb: 'Demand pushed past what one machine can hold, then withdrawn. The hybrid test: the '
      + 'continuous loop and the discrete sequence have to agree.',
    duration_s: 420,
    steps: [
      { t: 20, action: 'demand', value: 0.78, label: 'demand valve to 78% — beyond one pump' },
      { t: 230, action: 'demand', value: 0.45, label: 'demand valve back to 45%' },
    ],
  },
  {
    id: 'DUTY',
    name: 'Shift duty cycle',
    blurb: 'Six demand changes of different sizes and directions, the way a real header is used. '
      + 'The hardest test to score well on, and the most honest.',
    duration_s: 720,
    steps: [
      { t: 20, action: 'demand', value: 0.58, label: 'demand 58%' },
      { t: 120, action: 'demand', value: 0.74, label: 'demand 74%' },
      { t: 240, action: 'demand', value: 0.50, label: 'demand 50%' },
      { t: 350, action: 'demand', value: 0.80, label: 'demand 80%' },
      { t: 480, action: 'demand', value: 0.34, label: 'demand 34%' },
      { t: 600, action: 'demand', value: 0.45, label: 'demand 45%' },
    ],
  },
  {
    id: 'UPSET',
    name: 'Suction upset',
    blurb: 'The strainer blinds while the process keeps asking for flow. Watch NPSH margin, not '
      + 'the setpoint — this one is not primarily a tuning test.',
    duration_s: 400,
    steps: [
      { t: 20, action: 'demand', value: 0.65, label: 'demand 65%' },
      { t: 60, action: 'foul', value: 0.55, label: 'strainer 55% blinded' },
      { t: 150, action: 'foul', value: 0.80, label: 'strainer 80% blinded' },
      { t: 250, action: 'foul', value: 0.0, label: 'strainer cleaned' },
    ],
  },
  {
    id: 'MIN_FLOW',
    name: 'Deadhead',
    blurb: 'Demand closes almost completely. Everything the pump does with the energy it can no '
      + 'longer put into flow goes into the liquid in the casing, and the temperature rise is '
      + 'what minimum continuous flow actually means. Watch the recirculation valve earn its keep.',
    duration_s: 420,
    steps: [
      { t: 20, action: 'demand', value: 0.50, label: 'demand 50%' },
      { t: 60, action: 'demand', value: 0.06, label: 'demand valve slams to 6%' },
      { t: 260, action: 'demand', value: 0.50, label: 'demand back to 50%' },
    ],
  },
  {
    id: 'SURGE',
    name: 'Valve slam',
    blurb: 'The demand valve shuts in a second and opens again just as fast. Watch the header: '
      + 'the transient is large but it is not a water hammer, because the bladder vessel takes '
      + 'the flow the valve stopped passing. That is what the vessel is for, and the trace is the '
      + 'argument for having one.',
    duration_s: 260,
    steps: [
      { t: 20, action: 'demand', value: 0.72, label: 'demand 72%' },
      { t: 70, action: 'slam', value: 0.05, label: 'valve slams shut' },
      { t: 110, action: 'slam', value: 0.72, label: 'valve slams open' },
      { t: 170, action: 'demand', value: 0.45, label: 'demand back to 45%' },
    ],
  },
  {
    id: 'VISCOSITY',
    name: 'Wrong liquid',
    blurb: 'The rig is filled with ISO VG 150 gear oil instead of water. Nothing in the control '
      + 'system changes and everything in the process does: head, flow and efficiency all derate '
      + 'together, and the tuning that was right for water is now wrong.',
    duration_s: 480,
    steps: [
      { t: 20, action: 'demand', value: 0.55, label: 'demand 55% on water' },
      { t: 90, action: 'fluid', value: 'VG150', label: 'filled with VG 150 oil' },
      { t: 260, action: 'demand', value: 0.68, label: 'demand 68% on oil' },
      { t: 380, action: 'fluid', value: 'WATER', label: 'flushed back to water' },
    ],
  },
  {
    id: 'CAVITATION',
    name: 'Losing suction',
    blurb: 'The tank runs down and the contents warm up at the same time. Two effects that are '
      + 'survivable apart are not survivable together — this is the classic hot-well failure, '
      + 'and the NPSH margin trace tells the story before the flow does.',
    duration_s: 520,
    steps: [
      { t: 20, action: 'demand', value: 0.62, label: 'demand 62%' },
      { t: 60, action: 'makeup', value: 0, label: 'make-up isolated — tank starts running down' },
      { t: 120, action: 'supplyTemp', value: 92, label: 'supply water at 92 C' },
      { t: 380, action: 'makeup', value: 1, label: 'make-up restored' },
    ],
  },
  {
    id: 'TRIP',
    name: 'Motor trip',
    blurb: 'The lead machine trips on overload with the header loaded. The sequence has to notice, '
      + 'promote the standby, and the loop has to survive the hole in the middle.',
    duration_s: 360,
    steps: [
      { t: 20, action: 'demand', value: 0.70, label: 'demand 70%' },
      { t: 90, action: 'trip', value: 0, label: 'P-101 trips' },
      { t: 250, action: 'reset', value: 0, label: 'P-101 reset' },
    ],
  },
  {
    id: 'STICTION',
    name: 'Sticking valve',
    blurb: 'Friction is added to the final element and the loop is left alone. The cycle that '
      + 'starts is not a tuning problem, and the point of the test is that the diagnostics can '
      + 'tell you so from the waveform without anyone going out to look at the valve.',
    duration_s: 600,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.55 });
      api.setDisturbance({ finalElement: 'THROTTLE' });
    },
    steps: [
      { t: 90, action: 'stiction', value: 3.5, label: 'PCV stickband to 3.5%' },
    ],
  },
  {
    id: 'ENERGY',
    name: 'Throttle against speed',
    blurb: 'The same 22 m3/h held two ways: once by throttling a valve with the pumps at a fixed '
      + '80%, once by opening the valve and slowing the pumps down. Same flow, same duty, and the '
      + 'kWh/m3 figures are not remotely the same. The whole argument for a drive, in one test.',
    duration_s: 620,
    setup(ctx, api) {
      api.setLoopMode('FLOW');
      api.setSetpoint(22);
      api.setStaging({ enabled: false });
      api.setDisturbance({ demandTarget: 0.55, fixedSpeed_pct: 80 });
    },
    steps: [
      { t: 20, action: 'finalElement', value: 'THROTTLE', label: 'hold 22 m3/h by throttling' },
      { t: 320, action: 'finalElement', value: 'VFD', label: 'hold 22 m3/h on speed instead' },
    ],
  },
  {
    id: 'SLEEP',
    name: 'Overnight',
    setup(ctx, api) {
      api.setStaging({ sleepEnabled: true, sleepDelay_s: 40, sleepFlow_m3h: 6, wakeDroop: 0.06 });
    },
    blurb: 'Demand falls away to nothing. With sleep enabled the set stops and lets the gas '
      + 'cushion hold the header; without it the last pump runs all night against a closed '
      + 'system. Compare the energy totals.',
    duration_s: 720,
    steps: [
      { t: 20, action: 'demand', value: 0.45, label: 'demand 45%' },
      { t: 80, action: 'demand', value: 0, label: 'demand falls away completely' },
      { t: 560, action: 'demand', value: 0.45, label: 'morning — demand back to 45%' },
    ],
  },
]);

/**
 * Allocate scorecard and scenario-runner state.
 * @returns {object} the state
 */
export function createScenarioState() {
  return {
    /** The running scenario definition, or null. */
    def: null,
    /** Simulated time the scenario started, s. */
    t0_s: 0,
    /** Index of the next step to fire. */
    next: 0,
    /** Setpoint the scenario started from, for `spDelta`. */
    spBase: 0,
    /** Elapsed scenario time, s. */
    elapsed_s: 0,
    /** True once the duration has run out. */
    done: false,

    /** Live accumulators. Reset by {@link resetScore} and by starting a scenario. */
    m: blankMetrics(),
    /** Frozen copy of the metrics from the last completed scenario. */
    last: null,
    /** Scenario id of the last completed run. */
    lastId: null,
    /** Log of what fired and when. */
    log: [],
  };
}

/**
 * A fresh, zeroed metric accumulator.
 * @returns {object} metrics
 */
function blankMetrics() {
  return {
    /** Seconds of accumulation. */
    t_s: 0,
    /** Integral of absolute error, EU-seconds. */
    iae: 0,
    /** Integral of time-weighted absolute error, EU-second-squared. */
    itae: 0,
    /** Largest absolute error seen, EU. */
    peakErr: 0,
    /** Total variation of the controller output, percent. */
    coTravel: 0,
    /** Previous output, for the travel difference. */
    coPrev: NaN,
    /** Pump start and stop transitions. */
    starts: 0,
    /** Shaft energy, kWh. */
    energy_kWh: 0,
    /** Volume delivered to process, m3. */
    volume_m3: 0,
    /** Seconds spent with a controller output pinned at a limit. */
    satTime_s: 0,
    /** Seconds spent with any pump below its minimum continuous flow. */
    minFlowTime_s: 0,
    /** Seconds spent with any running pump cavitating. */
    cavTime_s: 0,
    /** Per-step servo/regulatory analysis, one entry per scripted step. */
    steps: [],
    /** The step currently being analysed, or null. */
    open: null,
  };
}

/**
 * Reset the live metrics without disturbing a running scenario.
 * @param {object} sc scenario state (mutated)
 * @returns {void}
 */
export function resetScore(sc) {
  sc.m = blankMetrics();
}

/**
 * Start a scripted test.
 * @param {object} sc scenario state (mutated)
 * @param {object} def one of {@link SCENARIOS}
 * @param {number} t_s simulated time now, s
 * @param {number} sp the setpoint to treat as the baseline
 * @returns {void}
 */
export function startScenario(sc, def, t_s, sp) {
  sc.def = def;
  sc.t0_s = t_s;
  sc.next = 0;
  sc.spBase = sp;
  sc.elapsed_s = 0;
  sc.done = false;
  sc.m = blankMetrics();
  sc.log = [{ t_s: 0, label: `${def.name} started` }];
}

/**
 * Abandon a running scenario, keeping whatever metrics accumulated.
 * @param {object} sc scenario state (mutated)
 * @returns {void}
 */
export function abortScenario(sc) {
  if (!sc.def) return;
  sc.log.push({ t_s: sc.elapsed_s, label: 'aborted' });
  sc.def = null;
}

/**
 * Advance the scorecard, and the scenario if one is running.
 *
 * @param {object} config frozen config
 * @param {object} sc scenario state (mutated)
 * @param {object} io the tick's context
 * @param {number} io.t_s simulated time, s
 * @param {number} io.dt_s scan period, s
 * @param {number} io.sp working setpoint, EU
 * @param {number} io.pv true process variable, EU
 * @param {number} io.co controller output, percent
 * @param {boolean} io.saturated whether the output is pinned
 * @param {object} io.plant plant state, for the energy, flow and protection counters
 * @param {object} io.pid controller state, mutated only when a scenario steps the setpoint
 * @returns {string[]} labels of any scenario steps that fired on this scan
 */
export function stepScenario(config, sc, io) {
  const { t_s, dt_s, sp, pv, co, plant } = io;
  const m = sc.m;
  const fired = [];

  // --- live accumulation ---------------------------------------------------------------------
  const err = sp - pv;
  const ae = Math.abs(err);
  m.t_s += dt_s;
  m.iae += ae * dt_s;
  m.itae += m.t_s * ae * dt_s;
  if (ae > m.peakErr) m.peakErr = ae;
  if (Number.isFinite(m.coPrev)) m.coTravel += Math.abs(co - m.coPrev);
  m.coPrev = co;
  if (io.saturated) m.satTime_s += dt_s;

  let anyMinFlow = false;
  let anyCav = false;
  for (let i = 0; i < config.pumps.length; i += 1) {
    m.energy_kWh += (plant.P_kW[i] * dt_s) / 3600;
    if (plant.drv[i].n_pct > 5) {
      if (plant.Q_m3h[i] < config.pumps[i].minFlow_m3h) anyMinFlow = true;
      if (plant.cav[i] < 0.999) anyCav = true;
    }
  }
  if (anyMinFlow) m.minFlowTime_s += dt_s;
  if (anyCav) m.cavTime_s += dt_s;
  m.volume_m3 += (plant.Qdemand_m3h * dt_s) / 3600;

  // --- per-step analysis --------------------------------------------------------------------
  // A servo step is judged on how it approaches a NEW setpoint; a load step on how far it is
  // pushed off the one it already had. Those are different questions and they are measured
  // differently: `peakSigned` is progress toward the new setpoint, `peakAbsDev` is the worst
  // excursion from it. Settling time is the last moment outside the band and is asked of both.
  if (m.open) {
    const st = m.open;
    st.elapsed_s += dt_s;
    const signed = st.dir * (pv - st.pv0);
    if (signed > st.peakSigned) { st.peakSigned = signed; st.peakAt_s = st.elapsed_s; }
    const dev = Math.abs(sp - pv);
    if (dev > st.peakAbsDev) st.peakAbsDev = dev;
    if (st.size > 0 && !Number.isFinite(st.rise_s) && signed >= 0.9 * st.size) {
      st.rise_s = st.elapsed_s;
    }
    if (dev > st.band) st.settle_s = st.elapsed_s;
    st.iae += ae * dt_s;
    if (st.elapsed_s >= st.window_s) closeStep(sc, st);
  }

  // --- scenario stepping ------------------------------------------------------------------------
  if (sc.def) {
    sc.elapsed_s = t_s - sc.t0_s;
    while (sc.next < sc.def.steps.length && sc.elapsed_s >= sc.def.steps[sc.next].t) {
      const step = sc.def.steps[sc.next];
      applyStep(config, sc, io, step);
      sc.log.push({ t_s: sc.elapsed_s, label: step.label });
      fired.push(step.label);
      sc.next += 1;
    }
    if (sc.elapsed_s >= sc.def.duration_s) {
      if (m.open) closeStep(sc, m.open);
      sc.last = summarise(config, sc, io);
      sc.lastId = sc.def.id;
      sc.log.push({ t_s: sc.elapsed_s, label: `${sc.def.name} complete` });
      sc.def = null;
      sc.done = true;
    }
  }
  return fired;
}

/**
 * Apply one scripted step to the plant or the controller, and open a servo-analysis window.
 * @param {object} config frozen config
 * @param {object} sc scenario state (mutated)
 * @param {object} io tick context
 * @param {object} step the step definition
 * @returns {void}
 */
function applyStep(config, sc, io, step) {
  const { plant, pid } = io;
  const before = io.pv;
  let size = 0;
  switch (step.action) {
    case 'spDelta':
      // The value is an offset from the setpoint the TEST started at, not from the current one,
      // so a zero returns to where it began however many steps have been taken. The step size
      // that overshoot is measured against is the actual movement, which is not the same number.
      pid.spTarget = sc.spBase + step.value;
      size = Math.abs(pid.spTarget - before);
      break;
    case 'sp':
      pid.spTarget = step.value;
      size = Math.abs(step.value - before);
      break;
    case 'demand':
      plant.demandTarget = step.value;
      plant.valveOverride.fcv.strokeTime_s = null;
      break;
    case 'slam':
      // A slam is the same valve moved in a second instead of six. Closure time is the whole
      // difference between a pressure transient and a water hammer, so it is a property of the
      // step, not of the valve.
      plant.valveOverride.fcv.strokeTime_s = 1.0;
      plant.demandTarget = step.value;
      break;
    case 'discharge':
      plant.hDischarge_m = step.value;
      break;
    case 'foul':
      plant.foul = step.value;
      break;
    case 'fluid':
      io.api.setDisturbance({ fluidId: step.value });
      break;
    case 'supplyTemp':
      plant.Tsupply_C = step.value;
      break;
    case 'tankTemp':
      plant.T_tank_C = step.value;
      break;
    case 'makeup':
      plant.makeupAuto = step.value > 0;
      break;
    case 'level':
      plant.level_m = step.value;
      plant.V_m3 = step.value * config.tank.area_m2;
      break;
    case 'finalElement':
      // Through the action, so the controller action is re-aligned and the output preloaded to
      // whatever the new element is already at. Writing the field directly makes the loop take a
      // step nobody asked for at the moment of the switch.
      io.api.setDisturbance({ finalElement: step.value });
      break;
    case 'recirc':
      plant.recircMode = step.value;
      break;
    case 'stiction': {
      const which = plant.finalElement === 'THROTTLE' ? 'pcv' : 'fcv';
      plant.valveOverride[which].stickband = step.value / 100;
      plant.valveOverride[which].slipJump = (step.value / 100) * 0.5;
      break;
    }
    case 'wear':
      for (let i = 0; i < plant.wear.length; i += 1) plant.wear[i] = step.value;
      break;
    case 'trip':
      tripDrive(plant.drv[step.value | 0], 'scripted trip');
      break;
    case 'reset':
      resetDrive(plant.drv[step.value | 0]);
      break;
    default:
      break;
  }
  const span = io.mode === 'FLOW' ? config.instruments.ft.hi_m3h : config.instruments.pt.hi_bar;
  // A step that lands while the previous one is still being measured closes it first, so a
  // fast-moving scenario reports two short windows rather than silently discarding one.
  if (sc.m.open) closeStep(sc, sc.m.open);
  sc.m.open = {
    label: step.label,
    at_s: sc.elapsed_s,
    kind: step.action === 'spDelta' || step.action === 'sp' ? 'servo' : 'load',
    pv0: before,
    sp0: pid.spTarget,
    size,
    dir: size > 0 ? Math.sign(pid.spTarget - before) || 1 : 1,
    band: 0.01 * span,
    peakSigned: -Infinity,
    peakAbsDev: 0,
    peakAt_s: 0,
    rise_s: NaN,
    settle_s: 0,
    iae: 0,
    elapsed_s: 0,
    window_s: 100,
  };
}

/**
 * Finalise one step's analysis into the metric list.
 * @param {object} sc scenario state (mutated)
 * @param {object} st the open step record
 * @returns {void}
 */
function closeStep(sc, st) {
  const overshootPct = st.kind === 'servo' && st.size > 0 && Number.isFinite(st.peakSigned)
    ? Math.max(0, ((st.peakSigned - st.size) / st.size) * 100)
    : NaN;
  sc.m.steps.push({
    label: st.label,
    kind: st.kind,
    at_s: st.at_s,
    overshootPct,
    rise_s: st.rise_s,
    settle_s: st.settle_s,
    peakDev: st.peakAbsDev,
    iae: st.iae,
  });
  sc.m.open = null;
}

/**
 * Turn the accumulators into a graded result.
 *
 * The grade is deliberately blunt: five components, each a soft penalty against a reference value
 * a competent tuning would meet on this rig, summed and subtracted from 100. The reference values
 * are stated in the returned breakdown so a disagreement about the grade is a disagreement about
 * numbers rather than about taste.
 *
 * @param {object} config frozen config
 * @param {object} sc scenario state
 * @param {object} io tick context, for the loop's span
 * @returns {object} the frozen result
 */
function summarise(config, sc, io) {
  const m = sc.m;
  const span = io.mode === 'FLOW' ? config.instruments.ft.hi_m3h : config.instruments.pt.hi_bar;
  const servo = m.steps.filter((s) => Number.isFinite(s.overshootPct));
  const overshoot = servo.length
    ? servo.reduce((a, s) => a + s.overshootPct, 0) / servo.length : NaN;
  const settle = m.steps.length
    ? m.steps.reduce((a, s) => a + s.settle_s, 0) / m.steps.length : NaN;

  // Reference values: what a well-tuned loop achieves on this plant over a test of this length.
  const refIae = 0.008 * span * m.t_s;
  const refTravel = 10 * (m.t_s / 60);
  const refSettle = 20;
  const refOvershoot = 8;

  const parts = [
    { id: 'iae', label: 'Integrated error', weight: 34, ratio: m.iae / refIae, ref: `${refIae.toPrecision(3)} EU-s` },
    { id: 'overshoot', label: 'Overshoot', weight: 20, ratio: overshoot / refOvershoot, ref: `${refOvershoot}%` },
    { id: 'settle', label: 'Settling time', weight: 18, ratio: settle / refSettle, ref: `${refSettle} s` },
    { id: 'travel', label: 'Output travel', weight: 18, ratio: m.coTravel / refTravel, ref: `${refTravel.toPrecision(3)}%` },
    { id: 'starts', label: 'Pump starts', weight: 10, ratio: m.starts / 2, ref: '2' },
  ];
  // A test with no setpoint change has nothing to say about overshoot, and one with no analysed
  // step has nothing to say about settling. Rather than award those components full marks for
  // absent evidence — which would flatter a load test over a servo one — they are dropped and
  // the remaining weights are renormalised to 100.
  const scored = parts.filter((p) => Number.isFinite(p.ratio));
  for (const p of parts) p.applicable = scored.includes(p);
  const totalWeight = scored.reduce((a, p) => a + p.weight, 0) || 1;
  let score = 0;
  for (const p of parts) {
    if (!p.applicable) { p.earned = NaN; continue; }
    // A ratio of 1 earns full marks; 2 earns half; 4 earns a quarter. Never negative.
    p.earned = ((p.weight * 100) / totalWeight) / Math.max(1, p.ratio);
    score += p.earned;
  }
  // Hard penalties for running the machinery outside its envelope. These are not trade-offs.
  const cavPenalty = Math.min(40, (m.cavTime_s / Math.max(m.t_s, 1)) * 400);
  const minQPenalty = Math.min(20, (m.minFlowTime_s / Math.max(m.t_s, 1)) * 100);
  score = clamp(score - cavPenalty - minQPenalty, 0, 100);

  return Object.freeze({
    scenario: sc.def ? sc.def.name : 'free run',
    t_s: m.t_s,
    iae: m.iae,
    itae: m.itae,
    peakErr: m.peakErr,
    coTravel: m.coTravel,
    starts: m.starts,
    energy_kWh: m.energy_kWh,
    volume_m3: m.volume_m3,
    /** kWh per m3 delivered — the number a plant manager actually asks about. */
    specific_kWh_m3: m.volume_m3 > 0.01 ? m.energy_kWh / m.volume_m3 : NaN,
    satTime_s: m.satTime_s,
    minFlowTime_s: m.minFlowTime_s,
    cavTime_s: m.cavTime_s,
    overshootPct: overshoot,
    settle_s: settle,
    steps: m.steps.slice(),
    score,
    parts,
    penalties: { cavitation: cavPenalty, minFlow: minQPenalty },
  });
}

/**
 * Grade whatever has accumulated so far, without a scenario having to finish. Used by the
 * "score the last N minutes" button.
 * @param {object} config frozen config
 * @param {object} sc scenario state (mutated — `last` is written)
 * @param {object} io tick context
 * @returns {object} the result
 */
export function scoreNow(config, sc, io) {
  sc.last = summarise(config, sc, io);
  sc.lastId = sc.def ? sc.def.id : 'FREE';
  return sc.last;
}
