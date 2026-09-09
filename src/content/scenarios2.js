/**
 * src/content/scenarios2.js — twenty more scripted tests: the situations a station actually meets
 * on a shift, and a grading weight for each that matches what the situation is really about.
 *
 * Layer: content. Imports `core/util.js`, the scenario runner in `control/scenario.js` and the
 * action surface in `core/sim.js`. No DOM, no clock, no randomness.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A SECOND TABLE
 *
 * The thirteen tests in `control/scenario.js` are TUNING tests. They ask one question — given this
 * disturbance, how well does the loop hold the header — and they are the right questions to ask
 * while somebody is learning what a gain does.
 *
 * A station does not spend its life taking setpoint steps. It wakes up at six when the first draw
 * starts, goes to sleep at one in the morning, loses a machine at the worst moment, has a strainer
 * that blinds over an hour so slowly nobody notices the speed creeping up, and once a year gets
 * asked to deliver everything it has into a fire main. These are the events that decide whether the
 * set survives its warranty, and none of them is a setpoint step.
 *
 * So this table scripts them, against the same runner, with the same action vocabulary. Nothing in
 * `control/scenario.js` changes: `stepScenario` reads `duration_s`, `steps` and `setup`, and every
 * step below uses an action that `applyStep` already implements. A step with an action the runner
 * does not know would be silently ignored, which is exactly the kind of test that passes while
 * measuring nothing, so there are none here.
 *
 * ------------------------------------------------------------------------------------------
 * WHY EACH TEST CARRIES ITS OWN WEIGHTING
 *
 * The scorecard in `control/scenario.js` grades every test the same way: integrated error, over-
 * shoot, settling, output travel, pump starts, weighted 34/20/18/18/10. That is a defensible
 * average of what a plant cares about, and it is wrong for at least half of the events below.
 *
 * Grade a fire-water draw on output travel and you have built a scorecard that rewards a set for
 * moving slowly while the main is empty. Grade a stage-chatter test on integrated error and it will
 * hand a distinction to a sequence that started the standby fourteen times in an hour, because
 * short-cycling holds pressure beautifully right up to the morning the starter welds shut. Grade a
 * commissioning walk-up on pump starts and you have penalised the engineer for the stage-up they
 * were sent out to prove.
 *
 * So each definition carries `weights`, and {@link gradeScenario2} regrades the runner's result
 * with them. The five standard components keep the runner's own reference values, so a scenario
 * weighted like the runner scores exactly what the runner scored — that is asserted in the tests,
 * not assumed. Three more components are available because these events need them: peak deviation
 * (what an operator watches during an upset), time saturated (whether the set had anything left)
 * and specific energy (the number the bill is written from). Cavitation and minimum-flow stay hard
 * penalties rather than weighted components, because they are not trade-offs against a better IAE,
 * but a scenario may SCALE them: running the tank dry during a fire is a worse sin than doing it
 * during a leisurely turndown, and `penaltyScale` says so.
 * ------------------------------------------------------------------------------------------
 */

import { clamp, deepFreeze } from '../core/util.js';
import { startScenario } from '../control/scenario.js';
import {
  outputOwner, setLoopMode, setSetpoint, setTuning, setStaging, setStrategy, setDisturbance,
  setControllerMode,
} from '../core/sim.js';

/**
 * Span of the controlled variable assumed when grading, engineering units.
 *
 * PT-101 is ranged 0..8 bar and every test in this table is a pressure test, so this is the right
 * default. A flow test must pass its own span: FT-101 spans 150 m3/h, and grading a flow run
 * against a span of 8 would judge its integrated error against a reference nineteen times too
 * small and report a competent loop as a failure.
 */
const DEFAULT_SPAN_EU = 8;

/**
 * The graded components, and what a competent station achieves on each.
 *
 * `value` pulls the raw number out of a runner result; `ref` is what that number is compared
 * against. The first five reproduce `control/scenario.js` exactly, deliberately — two scorecards
 * that disagree about what a good IAE is are two scorecards nobody trusts.
 */
const COMPONENTS = Object.freeze({
  iae: Object.freeze({
    label: 'Integrated error',
    value: (r) => r.iae,
    ref: (r, span) => 0.008 * span * r.t_s,
    unit: 'EU-s',
  }),
  overshoot: Object.freeze({
    label: 'Overshoot',
    value: (r) => r.overshootPct,
    ref: () => 8,
    unit: '%',
  }),
  settle: Object.freeze({
    label: 'Settling time',
    value: (r) => r.settle_s,
    ref: () => 20,
    unit: 's',
  }),
  travel: Object.freeze({
    label: 'Output travel',
    value: (r) => r.coTravel,
    ref: (r) => 10 * (r.t_s / 60),
    unit: '%',
  }),
  starts: Object.freeze({
    label: 'Pump starts',
    value: (r) => r.starts,
    ref: () => 2,
    unit: '',
  }),
  // --- the three the standard card does not have --------------------------------------------
  peak: Object.freeze({
    label: 'Peak deviation',
    // The number an operator actually watches during an upset. A loop can have a respectable IAE
    // and still have put the header somewhere that lifted a relief valve on the way past.
    value: (r) => r.peakErr,
    ref: (r, span) => 0.05 * span,
    unit: 'EU',
  }),
  saturation: Object.freeze({
    label: 'Time at a limit',
    // Fraction of the run with the output pinned. Not a fault in itself — a fire draw SHOULD
    // saturate — but it is the only column that says whether the set had anything left to give.
    value: (r) => (r.t_s > 0 ? r.satTime_s / r.t_s : NaN),
    ref: () => 0.05,
    unit: 'fraction',
  }),
  energy: Object.freeze({
    label: 'Specific energy',
    // kWh per m3 delivered. Roughly what this rig costs at its design duty with the valve open
    // and the drives doing the work; a throttled or recirculating station lands well above it.
    value: (r) => r.specific_kWh_m3,
    ref: () => 0.15,
    unit: 'kWh/m3',
  }),
});

/**
 * The weighting `control/scenario.js` applies to every test. Any scenario given these weights and
 * unscaled penalties scores exactly what the runner scored.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  iae: 34, overshoot: 20, settle: 18, travel: 18, starts: 10,
});

/** Penalty scaling that changes nothing, for the scenarios that want the standard severity. */
const PLAIN_PENALTIES = Object.freeze({ cavitation: 1, minFlow: 1 });

/**
 * The station's year, in twenty tests.
 *
 * Times are seconds from the start of the run. Every `action` is one the runner already implements
 * — `spDelta`, `sp`, `demand`, `slam`, `discharge`, `foul`, `fluid`, `supplyTemp`, `tankTemp`,
 * `makeup`, `level`, `finalElement`, `recirc`, `stiction`, `wear`, `trip`, `reset` — so this table
 * is data to `stepScenario` and nothing more.
 *
 * Three fields beyond what the runner reads are for {@link gradeScenario2}, which ignores nothing
 * and validates all three:
 *
 *   `weights`       component id -> weight. Renormalised, so they need not sum to 100.
 *   `refs`          component id -> the reference THIS duty should be measured against, where the
 *                   generic one would be meaningless.
 *   `penaltyScale`  how much worse cavitating or running below minimum flow is during this event
 *                   than during an ordinary one.
 */
export const SCENARIOS2 = deepFreeze([
  // ============================================================================================
  // THE ORDINARY DAY
  // ============================================================================================
  {
    id: 'MORNING_RAMP',
    name: 'Morning demand ramp',
    blurb: 'Six o clock. The set has been asleep on a satisfied header and the first draws of the '
      + 'day arrive one after another until the site is at full load. Nothing here is a fault — '
      + 'this is the shape of the load on every morning of the year — and the question is whether '
      + 'the sequence walks up it once or hunts across the staging point six times on the way.',
    duration_s: 900,
    setup(ctx, api) {
      api.setStaging({ sleepEnabled: true, sleepDelay_s: 30, sleepFlow_m3h: 5, wakeDroop: 0.09 });
      api.setDisturbance({ demandTarget: 0.04 });
    },
    steps: [
      { t: 70, action: 'demand', value: 0.12, label: 'first draw of the day — 12%' },
      { t: 160, action: 'demand', value: 0.24, label: 'demand 24%' },
      { t: 270, action: 'demand', value: 0.36, label: 'demand 36%' },
      { t: 390, action: 'demand', value: 0.48, label: 'demand 48%' },
      { t: 510, action: 'demand', value: 0.60, label: 'demand 60%' },
      { t: 640, action: 'demand', value: 0.72, label: 'full site load — 72%' },
      { t: 780, action: 'demand', value: 0.62, label: 'first shift settles at 62%' },
    ],
    weights: { iae: 28, settle: 18, travel: 18, starts: 24, saturation: 12 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
  {
    id: 'NIGHT_TURNDOWN',
    name: 'Night turndown into sleep',
    blurb: 'The other end of the same day. Demand walks down through the evening and stops, and a '
      + 'set with sleep enabled should notice, stop the last machine and let the gas cushion hold '
      + 'the header until something is drawn. Then at three in the morning one tap opens. Graded '
      + 'mostly on energy and starts, because those are the only two things a sleeping set can get '
      + 'wrong, and a wake droop set too tight gets both wrong at once.',
    duration_s: 900,
    setup(ctx, api) {
      api.setStaging({ sleepEnabled: true, sleepDelay_s: 60, sleepFlow_m3h: 5, wakeDroop: 0.08 });
      api.setDisturbance({ demandTarget: 0.58 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.44, label: 'evening — demand 44%' },
      { t: 150, action: 'demand', value: 0.30, label: 'demand 30%' },
      { t: 270, action: 'demand', value: 0.16, label: 'demand 16%' },
      { t: 390, action: 'demand', value: 0.06, label: 'last of the site shuts down' },
      { t: 500, action: 'demand', value: 0, label: 'nothing drawing — the set should sleep' },
      { t: 760, action: 'demand', value: 0.05, label: '03:00 — one tap opens' },
    ],
    weights: { energy: 30, starts: 28, iae: 14, travel: 10, peak: 18 },
    // A night is legitimately dearer per m3 than a day — almost no flow, and a machine that
    // still has to hold a header. This is what a well-run night on this rig costs.
    refs: { energy: 0.20 },
    penaltyScale: { cavitation: 1, minFlow: 2 },
  },

  // ============================================================================================
  // THE EVENTS
  // ============================================================================================
  {
    id: 'FIRE_DRAW',
    name: 'Fire-water draw',
    blurb: 'A hydrant opens onto the header and takes everything the station has for four minutes. '
      + 'The output will saturate and the pressure will not be held — that is not the failure, and '
      + 'a scorecard that grades this on output travel is telling the set to move slowly while the '
      + 'main is empty. What is graded is how deep the excursion went, how fast the header came '
      + 'back when the draw closed, and whether the break tank was still supplying liquid at the '
      + 'end of it: losing suction during a fire draw is the one unforgivable outcome here.',
    duration_s: 600,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5, makeupAuto: true });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.5, label: 'normal site load' },
      { t: 70, action: 'slam', value: 0.90, label: 'hydrant opens — 90% on FCV-101' },
      { t: 310, action: 'slam', value: 0.5, label: 'hydrant shut' },
      { t: 430, action: 'demand', value: 0.45, label: 'back to normal load' },
    ],
    weights: { peak: 30, settle: 24, iae: 24, saturation: 12, energy: 10 },
    penaltyScale: { cavitation: 2, minFlow: 1 },
  },
  {
    id: 'VALVE_SLAM_SHUT',
    name: 'Downstream valve slams shut',
    blurb: 'An isolation valve on the process side shuts in a second and stays shut for three '
      + 'minutes. Two separate things are being tested and they fail differently: the transient, '
      + 'which the bladder vessel should absorb, and what follows it, which is a pump running '
      + 'against a closed system with nowhere for its energy to go but the liquid in the casing. '
      + 'The minimum-flow penalty is doubled here because that is the whole point of the test.',
    duration_s: 420,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.6 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.70, label: 'demand 70%' },
      { t: 90, action: 'slam', value: 0.02, label: 'isolation valve slams shut' },
      { t: 270, action: 'slam', value: 0.70, label: 'valve reopened' },
      { t: 350, action: 'demand', value: 0.45, label: 'demand back to 45%' },
    ],
    weights: { peak: 32, settle: 20, iae: 16, saturation: 14, travel: 10, starts: 8 },
    penaltyScale: { cavitation: 1, minFlow: 2 },
  },
  {
    id: 'TANK_LOW',
    name: 'Supply tank running low',
    blurb: 'The make-up to the break tank is isolated — a shut valve nobody logged — while the site '
      + 'draws two thirds of full load. The level walks down, the static suction head goes with it, '
      + 'and the NPSH margin follows. The loop will hold setpoint for most of this and the trend '
      + 'that matters is not the loop\'s. Make-up is restored late, so the recovery is graded too.',
    duration_s: 720,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.68, label: 'demand 68%' },
      { t: 80, action: 'makeup', value: 0, label: 'make-up isolated' },
      { t: 520, action: 'makeup', value: 1, label: 'make-up restored' },
      { t: 640, action: 'demand', value: 0.45, label: 'demand back to 45%' },
    ],
    weights: { iae: 20, peak: 20, settle: 14, saturation: 16, energy: 10, travel: 10, starts: 10 },
    penaltyScale: { cavitation: 2, minFlow: 1 },
  },
  {
    id: 'STRAINER_HOUR',
    name: 'Strainer blinding over an hour',
    blurb: 'The suction strainer picks up debris and closes over a full hour, in steps small enough '
      + 'that no single one is visible on a trend anybody is watching. This is the most common real '
      + 'fault on a station like this and it is almost never caught by an alarm: the loop simply '
      + 'takes more and more speed to make the same flow, the specific energy climbs, and the first '
      + 'anyone knows is a cavitation complaint. Energy and saturation carry real weight here '
      + 'because they are the two numbers that were moving all along.',
    duration_s: 3600,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5, foul: 0 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.60, label: 'demand 60%' },
      { t: 300, action: 'foul', value: 0.15, label: 'strainer 15% blinded' },
      { t: 800, action: 'foul', value: 0.30, label: 'strainer 30% blinded' },
      { t: 1300, action: 'foul', value: 0.45, label: 'strainer 45% blinded' },
      { t: 1800, action: 'foul', value: 0.58, label: 'strainer 58% blinded' },
      { t: 2300, action: 'foul', value: 0.70, label: 'strainer 70% blinded' },
      { t: 2800, action: 'foul', value: 0.80, label: 'strainer 80% blinded' },
      { t: 3200, action: 'foul', value: 0.88, label: 'strainer 88% blinded' },
    ],
    weights: { iae: 24, saturation: 20, energy: 20, peak: 14, travel: 12, starts: 10 },
    // The specific energy this duty showed with the strainer clean. Nothing else in the test
    // moves; that is the whole point of comparing against it.
    refs: { energy: 0.125 },
    penaltyScale: { cavitation: 2, minFlow: 1 },
  },
  {
    id: 'FLUID_SWAP',
    name: 'Fluid changeover',
    blurb: 'The system is drained of water and refilled with 30% ethylene glycol for the winter, '
      + 'then flushed back in the spring. Denser and more viscous: every pump curve derates, the '
      + 'system curve steepens, the motor draws more for the same duty, and not one line of the '
      + 'control system was changed. Two demand moves are taken on each fluid so the difference is '
      + 'measured rather than asserted.',
    duration_s: 900,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5, fluidId: 'WATER' });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.55, label: 'demand 55% on water' },
      { t: 130, action: 'fluid', value: 'EG30', label: 'filled with 30% glycol' },
      { t: 320, action: 'demand', value: 0.68, label: 'demand 68% on glycol' },
      { t: 470, action: 'demand', value: 0.50, label: 'demand 50% on glycol' },
      { t: 620, action: 'fluid', value: 'WATER', label: 'flushed back to water' },
      { t: 780, action: 'demand', value: 0.62, label: 'demand 62% on water' },
    ],
    weights: { iae: 28, settle: 20, overshoot: 16, travel: 14, energy: 12, saturation: 10 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
  {
    id: 'TRIP_LOADED',
    name: 'Pump trips under load',
    blurb: 'Both machines are running near the top of the duty when the lead trips on overload. '
      + 'The survivor cannot hold the header on its own and the loop will saturate; what is being '
      + 'graded is that the sequence noticed at once, that the header was brought back as far as '
      + 'one machine can bring it, and that nothing was thrashed in the process. The trip is reset '
      + 'four minutes later, which is its own transient and is graded as well.',
    duration_s: 600,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.6 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.72, label: 'demand 72% — the lead near its limit' },
      { t: 150, action: 'trip', value: 0, label: 'P-101 trips on overload' },
      { t: 400, action: 'reset', value: 0, label: 'P-101 reset' },
      { t: 510, action: 'demand', value: 0.50, label: 'demand back to 50%' },
    ],
    weights: { peak: 26, settle: 24, iae: 20, saturation: 14, travel: 10, starts: 6 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
  {
    id: 'VFD_BYPASS',
    name: 'VFD faults to bypass',
    blurb: 'VFD-101 fails and the motor is thrown across the line on its bypass contactor: full '
      + 'speed, no modulation, and control handed to PCV-101. The rig models that exactly — fixed '
      + 'speed with the throttle valve as the final element — and the controller action has to '
      + 'reverse to suit, because opening a valve downstream of the header lets the header DOWN '
      + 'while opening a drive brings it up. The energy component is weighted hard: this is the '
      + 'configuration the whole variable-speed investment exists to avoid, and the kWh/m3 says so.',
    duration_s: 720,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5, fixedSpeed_pct: 100 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.55, label: 'demand 55% on the drive' },
      { t: 130, action: 'finalElement', value: 'THROTTLE', label: 'VFD-101 faulted — motor on bypass, control on PCV-101' },
      { t: 280, action: 'demand', value: 0.68, label: 'demand 68% on the throttle' },
      { t: 440, action: 'demand', value: 0.44, label: 'demand 44% on the throttle' },
      { t: 590, action: 'finalElement', value: 'VFD', label: 'drive replaced — back on speed control' },
    ],
    weights: { iae: 24, settle: 18, overshoot: 10, travel: 14, energy: 24, saturation: 10 },
    // What the same duty costs on the drive. Grading a throttled station against a generic
    // figure lets the bypass look thrifty, which is the one thing it never is.
    refs: { energy: 0.115 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },

  // ============================================================================================
  // THE INSTRUMENT
  //
  // The plant has no instrument-fault injector: `measuredPV` reads the transmitter, and nothing in
  // the action vocabulary can bias it. What CAN be scripted is the thing the controller does about
  // it, and the controller acts on sp - pv, so a transmitter reading high by 0.9 bar is arithmet-
  // ically indistinguishable, at the controller, from a setpoint 0.9 bar low. That is how these
  // three are built, and the briefings say so rather than pretending otherwise.
  //
  // The consequence for the grading is stated plainly: the deviation column is measuring against
  // the setpoint the LIE implies, so it is nearly worthless here and is weighted accordingly. What
  // is graded is the damage — energy, starts, saturation, minimum flow — because that is what a
  // failed transmitter actually costs, and it is what the operator has to spot on the mimic when
  // the faceplate is sitting contentedly on setpoint.
  // ============================================================================================
  {
    id: 'TX_FAIL_HIGH',
    name: 'Transmitter fails high',
    blurb: 'PT-101 develops a 0.9 bar high offset. PIC-101 believes the header is above setpoint '
      + 'and slows the machines until its reading comes back — which means the real header sits '
      + '0.9 bar low all shift, the faceplate looks perfect, and the complaints come from the far '
      + 'end of the site. Scripted as the equivalent setpoint offset, which is what the controller '
      + 'is doing arithmetically. Graded on what it costs, not on a deviation measured against a '
      + 'setpoint the transmitter invented.',
    duration_s: 600,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.55, label: 'demand 55%' },
      { t: 110, action: 'spDelta', value: -0.9, label: 'PT-101 reading 0.9 bar high' },
      { t: 440, action: 'spDelta', value: 0, label: 'transmitter replaced and calibrated' },
    ],
    weights: { peak: 22, settle: 16, starts: 16, saturation: 12, energy: 16, travel: 10, iae: 8 },
    penaltyScale: { cavitation: 1, minFlow: 2 },
  },
  {
    id: 'TX_FAIL_LOW',
    name: 'Transmitter fails low',
    blurb: 'The same fault the other way: PT-101 reads 1.1 bar low, so the controller pushes the '
      + 'header up by 1.1 bar to satisfy itself. Every joint on the site now sees a pressure it was '
      + 'not commissioned at, the standby stages in to help, and the energy bill goes up by a third '
      + 'for flow nobody asked for. The high alarm on PT-101 will not save you — the transmitter '
      + 'that would raise it is the one that is lying.',
    duration_s: 600,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.55, label: 'demand 55%' },
      { t: 110, action: 'spDelta', value: 1.1, label: 'PT-101 reading 1.1 bar low' },
      { t: 440, action: 'spDelta', value: 0, label: 'transmitter replaced and calibrated' },
    ],
    weights: { energy: 24, starts: 16, peak: 20, saturation: 14, travel: 14, iae: 12 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
  {
    id: 'TX_DRIFT',
    name: 'Transmitter drift nobody notices',
    blurb: 'Not a failure — a calibration walking away at about 0.15 bar an hour, in steps far too '
      + 'small for anyone to see against normal demand movement. Half an hour of this is invisible; '
      + 'half a year of it is a station running a header nobody chose at a cost nobody accounted '
      + 'for. This is the argument for a scheduled calibration check written as a test: the only '
      + 'evidence anything is wrong is the specific energy, which is why it carries the weight.',
    duration_s: 1800,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.55 });
    },
    steps: [
      { t: 200, action: 'spDelta', value: 0.08, label: 'drift: 0.08 bar' },
      { t: 400, action: 'spDelta', value: 0.16, label: 'drift: 0.16 bar' },
      { t: 600, action: 'spDelta', value: 0.24, label: 'drift: 0.24 bar' },
      { t: 800, action: 'spDelta', value: 0.32, label: 'drift: 0.32 bar' },
      { t: 1000, action: 'spDelta', value: 0.40, label: 'drift: 0.40 bar' },
      { t: 1200, action: 'spDelta', value: 0.48, label: 'drift: 0.48 bar' },
      { t: 1400, action: 'spDelta', value: 0.56, label: 'drift: 0.56 bar' },
      { t: 1600, action: 'spDelta', value: 0.64, label: 'drift: 0.64 bar' },
    ],
    weights: { energy: 32, starts: 18, saturation: 14, travel: 16, peak: 20 },
    // The commissioned figure for this duty. A drift is invisible in every other column — it
    // only shows against the number the same load produced before the calibration moved.
    refs: { energy: 0.105 },
    penaltyScale: { cavitation: 1, minFlow: 2 },
  },

  // ============================================================================================
  // THE MECHANICAL FAULTS
  // ============================================================================================
  {
    id: 'CHECK_STUCK',
    name: 'Recirculation check stuck open',
    blurb: 'Overnight the draw falls to almost nothing and the automatic recirculation valve opens '
      + 'to protect the running machine — exactly as it should. In the morning it does not close: '
      + 'the disc has stuck open, and the set now pumps a quarter of its output straight back to '
      + 'the tank all day. Every controlled variable looks right. The flow to process is short, the '
      + 'machines run harder than the duty needs, and the only column that shows it is kWh/m3. '
      + 'Scripted through the recirculation mode, which is the modelled path to a valve that stays '
      + 'where it was rather than where it should be.',
    duration_s: 720,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5, recircMode: 'ARV' });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.06, label: 'overnight — the ARV opens' },
      { t: 110, action: 'recirc', value: 'MANUAL', label: 'the ARV sticks where it is' },
      { t: 180, action: 'demand', value: 0.55, label: 'morning load — the bypass never closed' },
      { t: 420, action: 'demand', value: 0.68, label: 'demand 68% with the bypass open' },
      { t: 600, action: 'recirc', value: 'ARV', label: 'valve freed — recirculation back in auto' },
    ],
    weights: { energy: 34, iae: 20, saturation: 14, travel: 12, starts: 10, peak: 10 },
    // What this duty costs with the recirculation shut. Everything the operator can see says
    // the station is healthy; this is the only number that disagrees.
    refs: { energy: 0.14 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
  {
    id: 'AIR_POCKET',
    name: 'Air pocket in the suction',
    blurb: 'A slug of air trapped at a high point in the suction main breaks loose and passes '
      + 'through the pump. There is no way to inject gas into this model, so the pocket is scripted '
      + 'as what the impeller feels while it goes past: the suction head collapsing and the '
      + 'strainer loss spiking together for a few seconds, then clearing. The step in level is a '
      + 'discontinuity and is deliberately one — this is a transient event, not a slow drain, and '
      + 'the cavitation penalty is tripled because surviving the transient IS the test.',
    duration_s: 420,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5, level_m: 2.4 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.62, label: 'demand 62%' },
      { t: 100, action: 'level', value: 0.45, label: 'the pocket arrives — suction head collapses' },
      { t: 108, action: 'foul', value: 0.82, label: 'suction loss spikes' },
      { t: 133, action: 'foul', value: 0, label: 'the pocket passes' },
      { t: 141, action: 'level', value: 2.4, label: 'suction head restored' },
      { t: 300, action: 'demand', value: 0.45, label: 'demand back to 45%' },
    ],
    weights: { peak: 26, settle: 22, iae: 20, saturation: 16, travel: 16 },
    penaltyScale: { cavitation: 1.5, minFlow: 1 },
  },

  // ============================================================================================
  // THE SEQUENCE TESTS
  // ============================================================================================
  {
    id: 'STAGE_CHATTER',
    name: 'Stage-up and stage-down chatter test',
    blurb: 'The sequence is set up the way a hurried commissioning leaves it: six points of '
      + 'hysteresis between stage-up and stage-down, three-second delays, no staging bias, and the '
      + 'minimum run and stop timers shortened until they no longer defend anything. The demand is '
      + 'then parked right on the staging point and nudged around it. The header will look '
      + 'excellent throughout. The starter will not last the year. This test is graded almost '
      + 'entirely on transitions, because that is the only place the damage appears.',
    duration_s: 900,
    setup(ctx, api) {
      api.setStaging({
        stageUp_pct: 72,
        stageDown_pct: 66,
        stageUpDelay_s: 3,
        stageDownDelay_s: 4,
        minRun_s: 20,
        minStop_s: 15,
        stageUpBias: 1,
        stageDownBias: 1,
      });
      api.setDisturbance({ demandTarget: 0.6 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.66, label: 'demand 66% — on the staging point' },
      { t: 150, action: 'demand', value: 0.70, label: 'demand 70%' },
      { t: 300, action: 'demand', value: 0.67, label: 'demand 67%' },
      { t: 450, action: 'demand', value: 0.71, label: 'demand 71%' },
      { t: 600, action: 'demand', value: 0.68, label: 'demand 68%' },
      { t: 760, action: 'demand', value: 0.72, label: 'demand 72%' },
    ],
    weights: { starts: 44, travel: 20, iae: 14, peak: 12, saturation: 10 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
  {
    id: 'START_RATE',
    name: 'Start-rate limit test',
    blurb: 'The same swinging load, with the timers set the way the starter\'s duty rating actually '
      + 'requires: four minutes minimum run, three minutes minimum stop. Now the sequence is not '
      + 'allowed to answer every swing, so it must ride them on two machines and let the loop take '
      + 'the strain. The header is measurably worse than it was under the chattering sequence, and '
      + 'that trade is the correct one — six starts an hour is a motor rewind, and 0.1 bar of extra '
      + 'excursion is nothing at all.',
    duration_s: 1200,
    setup(ctx, api) {
      api.setStaging({
        minRun_s: 240, minStop_s: 180, stageUpDelay_s: 6, stageDownDelay_s: 25,
      });
      api.setDisturbance({ demandTarget: 0.6 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.74, label: 'demand 74% — stage up' },
      { t: 160, action: 'demand', value: 0.42, label: 'demand 42%' },
      { t: 300, action: 'demand', value: 0.75, label: 'demand 75%' },
      { t: 440, action: 'demand', value: 0.40, label: 'demand 40%' },
      { t: 590, action: 'demand', value: 0.73, label: 'demand 73%' },
      { t: 730, action: 'demand', value: 0.44, label: 'demand 44%' },
      { t: 880, action: 'demand', value: 0.74, label: 'demand 74%' },
      { t: 1030, action: 'demand', value: 0.45, label: 'demand 45%' },
    ],
    weights: { starts: 38, iae: 20, peak: 16, travel: 14, saturation: 12 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },

  // ============================================================================================
  // THE TWO ENDS OF A PLANT'S LIFE
  // ============================================================================================
  {
    id: 'COLD_START',
    name: 'Cold start commissioning',
    blurb: 'The rig as it is on the first morning: cold liquid, the tank part filled, nothing '
      + 'drawing, and a setpoint deliberately set below the duty. The pressure is walked up in '
      + 'three stages and load is added between them, which is how a station is actually '
      + 'commissioned — you prove each rung before you climb the next one, because a loop that '
      + 'overshoots at 2.2 bar with no load will overshoot far harder at 3.2 with the site on it. '
      + 'Overshoot and settling carry the weight, and the cavitation penalty is doubled: a low tank '
      + 'and a cold start is precisely when a first fill breaks suction.',
    duration_s: 900,
    setup(ctx, api) {
      api.setSetpoint(1.8);
      api.setStaging({ sleepEnabled: false });
      api.setDisturbance({ demandTarget: 0.05, level_m: 1.2, T_tank_C: 8, makeupAuto: true });
    },
    steps: [
      { t: 40, action: 'sp', value: 2.2, label: 'first rung — SP 2.2 bar' },
      { t: 140, action: 'demand', value: 0.20, label: 'load on — demand 20%' },
      { t: 250, action: 'sp', value: 2.7, label: 'second rung — SP 2.7 bar' },
      { t: 360, action: 'demand', value: 0.35, label: 'demand 35%' },
      { t: 470, action: 'sp', value: 3.2, label: 'duty setpoint — SP 3.2 bar' },
      { t: 580, action: 'demand', value: 0.50, label: 'demand 50%' },
      { t: 700, action: 'demand', value: 0.68, label: 'prove the stage-up — demand 68%' },
      { t: 820, action: 'demand', value: 0.45, label: 'back to duty — demand 45%' },
    ],
    weights: { overshoot: 26, settle: 24, iae: 20, travel: 14, saturation: 10, starts: 6 },
    penaltyScale: { cavitation: 2, minFlow: 1 },
  },
  {
    id: 'SHUTDOWN',
    name: 'Shutdown to a safe state',
    blurb: 'Taking the station down for a planned outage, in the order that leaves nothing hot or '
      + 'dry: load off in stages, setpoint walked down with it, the recirculation confirmed in auto '
      + 'before the forward flow disappears, and the make-up left running so the tank is full for '
      + 'the restart. Almost nobody grades a shutdown, which is why so many of them end with a '
      + 'casing at ninety degrees. The minimum-flow penalty is tripled here — a deviation during a '
      + 'shutdown costs nothing and a dry-running pump costs an impeller.',
    duration_s: 720,
    setup(ctx, api) {
      api.setStaging({ sleepEnabled: true, sleepDelay_s: 45, sleepFlow_m3h: 4, wakeDroop: 0.12 });
      api.setDisturbance({ demandTarget: 0.62, makeupAuto: true });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.45, label: 'load off — demand 45%' },
      { t: 130, action: 'demand', value: 0.30, label: 'demand 30%' },
      { t: 220, action: 'sp', value: 2.8, label: 'setpoint down to 2.8 bar' },
      { t: 310, action: 'recirc', value: 'ARV', label: 'recirculation confirmed in auto' },
      { t: 380, action: 'demand', value: 0.12, label: 'demand 12%' },
      { t: 470, action: 'demand', value: 0, label: 'last valve shut' },
      { t: 560, action: 'sp', value: 2.4, label: 'setpoint parked at 2.4 bar' },
      { t: 640, action: 'makeup', value: 1, label: 'make-up left in auto for the restart' },
    ],
    weights: { energy: 22, starts: 20, iae: 14, settle: 14, travel: 10, peak: 20 },
    penaltyScale: { cavitation: 1, minFlow: 3 },
  },

  // ============================================================================================
  // THE SUPPLY, AND THE FINAL EXAM
  // ============================================================================================
  {
    id: 'GRID_SAG',
    name: 'Grid voltage sag',
    blurb: 'A fault somewhere on the incoming supply takes the voltage down for a few hundred '
      + 'milliseconds. Neither drive has ride-through, so both trip on undervoltage and the whole '
      + 'station is off with a loaded header; twelve seconds later the bus is healthy and the '
      + 'faults are cleared. What is graded is the hole and the recovery — how deep the header '
      + 'went, how long it took to come back, and whether the restart was orderly. The starts are '
      + 'not the operator\'s doing and carry no weight here.',
    duration_s: 480,
    setup(ctx, api) {
      api.setDisturbance({ demandTarget: 0.5 });
    },
    steps: [
      { t: 30, action: 'demand', value: 0.62, label: 'demand 62%' },
      { t: 110, action: 'trip', value: 0, label: 'supply sag — VFD-101 undervoltage trip' },
      { t: 111, action: 'trip', value: 1, label: 'VFD-102 undervoltage trip' },
      { t: 123, action: 'reset', value: 0, label: 'bus healthy — VFD-101 fault cleared' },
      { t: 124, action: 'reset', value: 1, label: 'VFD-102 fault cleared' },
      { t: 330, action: 'demand', value: 0.45, label: 'demand back to 45%' },
    ],
    weights: { peak: 30, settle: 26, iae: 20, saturation: 12, travel: 12 },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
  {
    id: 'ACCEPTANCE',
    name: 'Full station acceptance test',
    blurb: 'Thirty minutes, everything, in one run: servo steps in both directions, the load walked '
      + 'up through a stage-up and back down through a stage-down, a valve slam, a machine lost and '
      + 'returned, a peak draw, a strainer partly blinded and cleaned, and a final pair of setpoint '
      + 'steps to prove the loop is where it started. This is the test that is signed, so nothing '
      + 'is excluded from the grading and nothing dominates it: if a set can only pass by trading '
      + 'one column away against another, it has not passed.',
    duration_s: 1800,
    setup(ctx, api) {
      api.setStaging({ sleepEnabled: false });
      api.setDisturbance({ demandTarget: 0.45, foul: 0, makeupAuto: true });
    },
    steps: [
      { t: 40, action: 'spDelta', value: 0.4, label: 'SP step up 0.4 bar' },
      { t: 160, action: 'spDelta', value: 0, label: 'SP step back' },
      { t: 280, action: 'demand', value: 0.62, label: 'demand 62%' },
      { t: 400, action: 'demand', value: 0.78, label: 'demand 78% — stage up' },
      { t: 560, action: 'demand', value: 0.45, label: 'demand 45% — stage down' },
      { t: 700, action: 'slam', value: 0.05, label: 'valve slam shut' },
      { t: 760, action: 'slam', value: 0.55, label: 'valve slam open' },
      { t: 880, action: 'trip', value: 0, label: 'P-101 tripped' },
      { t: 1040, action: 'reset', value: 0, label: 'P-101 reset' },
      { t: 1160, action: 'demand', value: 0.88, label: 'peak draw — demand 88%' },
      { t: 1300, action: 'foul', value: 0.5, label: 'strainer 50% blinded' },
      { t: 1420, action: 'foul', value: 0, label: 'strainer cleaned' },
      { t: 1520, action: 'demand', value: 0.32, label: 'demand 32%' },
      { t: 1640, action: 'spDelta', value: 0.3, label: 'final SP step up' },
      { t: 1730, action: 'spDelta', value: 0, label: 'final SP step back' },
    ],
    weights: {
      iae: 22, overshoot: 13, settle: 13, travel: 12, starts: 10, peak: 12, saturation: 8, energy: 10,
    },
    penaltyScale: { cavitation: 1, minFlow: 1 },
  },
]);

/** The same table indexed by id, so a lookup is not a linear scan through twenty definitions. */
export const SCENARIOS2_BY_ID = Object.freeze(Object.fromEntries(
  SCENARIOS2.map((s) => [s.id, s]),
));

/**
 * Look one up.
 * @param {string} id one of the {@link SCENARIOS2} ids
 * @returns {object|null} the definition, or null if there is no such test
 */
export function findScenario2(id) {
  return SCENARIOS2_BY_ID[id] || null;
}

/**
 * Start one of these tests on a live simulation.
 *
 * The same shape as `core/sim.js::beginScenario` and for the same reasons: the setup is applied
 * through the validated action surface rather than by writing plant fields, so a script cannot put
 * the rig anywhere the panel would have refused to, and the refusals are the same ones an operator
 * would have been given.
 *
 * @param {object} ctx the sim context
 * @param {string} id one of the {@link SCENARIOS2} ids
 * @returns {{ok:boolean, reason?:string, def?:object}} the result
 */
export function beginScenario2(ctx, id) {
  if (!ctx || !ctx.scenario || !ctx.pid) return { ok: false, reason: 'no simulation was supplied' };
  const def = findScenario2(id);
  if (!def) return { ok: false, reason: `unknown test ${id}` };
  if (ctx.scenario.def) return { ok: false, reason: 'a test is already running' };
  const owner = outputOwner(ctx);
  if (owner) return { ok: false, reason: `${owner} is running — abort it first` };
  if (def.setup) def.setup(ctx, scriptApi2(ctx));
  startScenario(ctx.scenario, def, ctx.run.t_s, ctx.pid.spTarget);
  return { ok: true, def };
}

/**
 * The action surface a setup arranges the rig through — the sim's own exported operator actions,
 * bound to one context. Deliberately the same seven a lesson gets.
 * @param {object} ctx the sim context
 * @returns {object} the bound actions
 */
function scriptApi2(ctx) {
  return {
    setLoopMode: (m) => setLoopMode(ctx, m),
    setSetpoint: (v) => setSetpoint(ctx, v),
    setTuning: (p) => setTuning(ctx, p),
    setStaging: (p) => setStaging(ctx, p),
    setStrategy: (p) => setStrategy(ctx, p),
    setDisturbance: (p) => setDisturbance(ctx, p),
    setControllerMode: (m) => setControllerMode(ctx, m),
  };
}

/**
 * Regrade a finished run with the weighting the test declares.
 *
 * The arithmetic is the runner's: a ratio of 1 against the reference earns full marks, 2 earns
 * half, 4 a quarter, and a component whose evidence is missing — no setpoint move, so nothing to
 * say about overshoot — is dropped and the remaining weights renormalised rather than awarded free
 * marks. Awarding them would flatter a load test over a servo one, which is the specific way a
 * composite score stops meaning anything.
 *
 * @param {object|string} defOrId the scenario definition, or its id
 * @param {object} result a frozen result from `control/scenario.js`, i.e. `ctx.scenario.last`
 * @param {object} [opts] grading options
 * @param {number} [opts.span] span of the controlled variable, EU; defaults to PT-101's 8 bar
 * @returns {{ok:boolean, reason?:string, score?:number, parts?:object[], penalties?:object}} the grade
 */
export function gradeScenario2(defOrId, result, opts) {
  const def = typeof defOrId === 'string' ? findScenario2(defOrId) : defOrId;
  if (!def) return { ok: false, reason: `unknown test ${defOrId}` };
  if (!result || !Number.isFinite(result.t_s) || result.t_s <= 0) {
    return { ok: false, reason: 'that result has no accumulated time to grade' };
  }
  const span = (opts && Number.isFinite(opts.span) && opts.span > 0) ? opts.span : DEFAULT_SPAN_EU;
  const weights = def.weights || DEFAULT_WEIGHTS;
  for (const [id, value] of Object.entries(def.refs || {})) {
    // A reference for a component that is not graded here, or one that is not a number, is a typo
    // that would otherwise do nothing at all — and "the override I wrote had no effect" is the
    // hardest kind of grading bug to see, because the score it produces looks perfectly reasonable.
    if (!COMPONENTS[id]) return { ok: false, reason: `${def.id}: no graded component named ${id}` };
    if (!(value > 0)) return { ok: false, reason: `${def.id}: the ${id} reference must be positive` };
  }

  const parts = [];
  for (const [id, weight] of Object.entries(weights)) {
    const comp = COMPONENTS[id];
    // A weight naming a component that does not exist is a typo in the table, and silently
    // ignoring it would quietly shift the whole grade onto the components that were spelled right.
    if (!comp) return { ok: false, reason: `${def.id}: no graded component named ${id}` };
    if (!(weight > 0)) continue;
    const value = comp.value(result);
    // A scenario may state its own reference for a component, and several have to. "What a
    // competent station achieves" on specific energy is a property of the DUTY, not of the plant:
    // a night at almost no flow legitimately costs more per m3 than a morning at full load, and
    // grading both against one figure only reports that nights are expensive. Worse, a drift or a
    // stuck bypass hides completely behind a generic reference — the only thing that catches
    // either is the number this same duty produced when it was commissioned, which is what these
    // overrides are.
    const own = def.refs ? def.refs[id] : undefined;
    const ref = Number.isFinite(own) ? own : comp.ref(result, span);
    parts.push({
      id,
      label: comp.label,
      weight,
      value,
      ratio: value / ref,
      ref: `${ref.toPrecision(3)} ${comp.unit}`.trim(),
      applicable: false,
      earned: NaN,
    });
  }
  const scored = parts.filter((p) => Number.isFinite(p.ratio));
  const totalWeight = scored.reduce((a, p) => a + p.weight, 0) || 1;
  let score = 0;
  for (const p of scored) {
    p.applicable = true;
    p.earned = ((p.weight * 100) / totalWeight) / Math.max(1, p.ratio);
    score += p.earned;
  }

  // The hard penalties, at this test's severity. Scaling them is the only lever a scenario has
  // over them: no weighting may buy a set out of having cavitated, it can only decide how much
  // worse cavitating during THIS event is than cavitating during an ordinary one.
  const scale = def.penaltyScale || PLAIN_PENALTIES;
  const cavitation = Math.min(40, (result.cavTime_s / result.t_s) * 400) * (scale.cavitation ?? 1);
  const minFlow = Math.min(20, (result.minFlowTime_s / result.t_s) * 100) * (scale.minFlow ?? 1);

  return {
    ok: true,
    scenario: def.name,
    score: clamp(score - cavitation - minFlow, 0, 100),
    parts,
    penalties: { cavitation, minFlow },
  };
}
