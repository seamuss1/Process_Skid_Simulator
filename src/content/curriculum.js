/**
 * src/content/curriculum.js — twenty-four further exercises, continuing the fourteen in
 * `src/control/lessons.js` rather than replacing them.
 *
 * Layer L3 content: imports `core/util.js`, the control modules whose settings the lessons
 * arrange, and the process modules whose numbers the objectives are judged against. No DOM.
 * The shape of a lesson is exactly the shape `startLesson`/`stepLesson` already consume —
 * `setup(ctx, api)`, an optional `track(ctx, mem, dt_s)`, `objectives[]` and a `debrief` — so
 * this table is concatenated onto {@link LESSONS} and the runner needs no change at all.
 *
 * ------------------------------------------------------------------------------------------
 * WHERE THESE GO THAT THE FIRST FOURTEEN DO NOT
 *
 * The first fourteen teach the loop: what a process gain is, what reset does, what happens when
 * the output pins, how to tell a tuning problem from a valve problem. They are the right first
 * fourteen and nothing here repeats them.
 *
 * These twenty-four are about the awkward parts, which is to say the parts a plant is actually
 * made of. Every one of them exists because a real loop somewhere is running badly for that
 * exact reason and nobody has noticed:
 *
 *   - the things you add to a loop are never free. A filter is dead time. A slower scan is dead
 *     time. A compensator is a model you now have to maintain.
 *   - one tuning cannot be best at two different jobs, and the escape is structural, not a
 *     better compromise.
 *   - the limits that hurt are the ones the algorithm cannot see: a rate-limited element, a
 *     sampler, a wild stream that ran out of valve.
 *   - the number on the screen is a measurement, with all a measurement's failure modes, and at
 *     a slow scan it can be a shadow of something that is not there at all.
 *   - and the last question in tuning is not "how tight can this be" but "how tight does this
 *     need to be", which is why the Harris index and the travel budget get a lesson each.
 *
 * Every objective is judged from the running plant. Several lessons cannot be passed by tuning,
 * and two of them cannot be passed without deciding that something other than the controller is
 * wrong, which remains most of the job.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { OBJ, LESSONS } from '../control/lessons.js';
import { MODE, ALGO, FORM, convertForm } from '../control/pid.js';
import { SHARE } from '../control/staging.js';
import { HAND } from '../control/staging.js';
import { SCHED_ON } from '../control/strategy.js';
import { RECIRC, FINAL } from '../process/plant.js';

/** Gravity, m/s2 — only used to price a head in bar for the readouts an objective quotes. */
const G = 9.80665;

/**
 * Build one objective record, with the same defaults the first fourteen lessons use.
 * @param {object} o the objective fields
 * @returns {object} the objective
 */
function obj(o) {
  return { mode: OBJ.ONCE, hold_s: 0, hint: '', ...o };
}

/**
 * The worst flow margin over the machines that are actually turning.
 *
 * A stopped pump passes no flow, so counting it would report a minimum-flow violation on every
 * idle standby and the objective would be meaningless.
 *
 * @param {object} ctx the lesson context
 * @returns {number} the smallest (flow minus that pump's minimum continuous flow), m3/h, or
 *   Infinity when nothing is running
 */
function worstFlowMargin(ctx) {
  let worst = Infinity;
  for (let i = 0; i < ctx.plant.Q_m3h.length; i += 1) {
    if (ctx.plant.drv[i].n_pct > 5) {
      worst = Math.min(worst, ctx.plant.Q_m3h[i] - ctx.config.pumps[i].minFlow_m3h);
    }
  }
  return worst;
}

/**
 * How many machines are energised and turning.
 * @param {object} ctx the lesson context
 * @returns {number} the count
 */
function running(ctx) {
  let n = 0;
  for (const d of ctx.plant.drv) if (d.n_pct > 5) n += 1;
  return n;
}

/**
 * Output travel per minute, which is the wear number. The diagnostic window reports a total over
 * a window whose length changes as the window fills, so the total on its own is not comparable
 * with itself ten seconds later.
 * @param {object} r the diagnostics report, or null
 * @returns {number} percent of output travel per minute, or NaN before the window has anything
 */
function travelPerMin(r) {
  if (!r || !(r.window_min > 0)) return NaN;
  return r.travel / r.window_min;
}

/**
 * The most recent closed step-analysis record of a kind, from the live scorecard.
 * @param {object} score the scorecard accumulator
 * @param {string} kind 'servo' or 'load'
 * @returns {object|null} the record, or null if no step of that kind has closed yet
 */
function lastStep(score, kind) {
  const all = score && score.steps ? score.steps.filter((s) => s.kind === kind) : [];
  return all.length ? all[all.length - 1] : null;
}

/**
 * Whether the diagnostics are calling a genuine sustained cycle rather than noise.
 * @param {object} ctx the lesson context
 * @param {number} [strength=0.5] the autocorrelation strength to insist on
 * @returns {boolean} true when the loop is cycling that hard
 */
function cycling(ctx, strength = 0.5) {
  const r = ctx.diagReport;
  return !!r && r.oscillating === true && r.strength > strength;
}

/**
 * The twenty-four further lessons, in the order they should be taken. Concatenate onto
 * {@link LESSONS} with {@link mergeCurriculum}.
 */
export const CURRICULUM = Object.freeze([
  // -----------------------------------------------------------------------------------------
  {
    id: 'FILTER_COST',
    title: 'What a filter costs you',
    minutes: 9,
    blurb: 'Filtering the noise out of a loop also filters the process out of it.',
    brief: [
      'Rate action is on and the measurement is a real transmitter with real noise. The output '
        + 'is chattering, and you already know the cure from the noise lesson: filter it.',
      'This time, price the cure. Take a load step with the loop as it is, then put a proper '
        + 'measurement filter in, then take exactly the same load step again.',
      'The filter will quieten the output. It will also make the loop worse at its job, and the '
        + 'amount it makes it worse by is the number nobody publishes.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 24;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 3.0;
      ctx.pidCfg.N = 60;
      ctx.pidCfg.pvFilter_s = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const r = ctx.diagReport;
      if (r) mem.peakReversals = Math.max(mem.peakReversals ?? 0, r.reversalsPerMin);
      const load = lastStep(ctx.score, 'load');
      // Which column a load step lands in is decided by the filter that was in when it happened,
      // not by the order the operator did things in — so the comparison survives being done
      // backwards, which is how it usually gets done.
      if (load && load !== mem.lastLoadRef) {
        mem.lastLoadRef = load;
        if (ctx.pidCfg.pvFilter_s < 0.2) mem.cleanDev = load.peakDev;
        else if (ctx.pidCfg.pvFilter_s >= 1.0) mem.filteredDev = load.peakDev;
      }
    },
    objectives: [
      obj({
        id: 'chatter',
        text: 'Observe more than 100 output reversals a minute with the rate action unfiltered',
        check: (ctx, mem) => (mem.peakReversals ?? 0) > 100,
        hint: 'Let the loop-health window fill. Nothing needs changing to meet this one.',
      }),
      obj({
        id: 'base',
        text: 'Record a load step with no measurement filter at all',
        check: (ctx, mem) => (mem.cleanDev ?? 0) > 0,
        hint: 'Scenario runner, LOAD STEP, with the PV filter still on zero.',
      }),
      obj({
        id: 'quiet',
        text: 'Put in a measurement filter of at least 1.0 s and get below 30 reversals a minute',
        check: (ctx) => ctx.pidCfg.pvFilter_s >= 1.0 && ctx.pidCfg.Td >= 1.0
          && (ctx.diagReport?.reversalsPerMin ?? 999) < 30,
        hint: 'The filter is on the tuning panel. Leave the rate action where it is.',
      }),
      obj({
        id: 'cost',
        text: 'Show the same load step is now at least 15% worse',
        check: (ctx, mem) => (mem.filteredDev ?? 0) > (mem.cleanDev ?? 0) * 1.15
          && (mem.cleanDev ?? 0) > 0,
        hint: 'Run exactly the same scenario again with the filter in and compare the peak '
          + 'deviations. If it is not worse, the filter is not doing anything yet.',
      }),
      obj({
        id: 'notd',
        mode: OBJ.NEVER,
        text: 'Do not switch the rate action off to get out of it',
        check: (ctx) => ctx.pidCfg.Td < 0.3,
        hint: 'Whether you wanted derivative is a different lesson. This one is about the price '
          + 'of the filter, and you cannot price it by removing the thing it is filtering.',
      }),
    ],
    debrief: 'A filter is a lag, and a lag in the measurement path is indistinguishable, from the '
      + 'controller\'s point of view, from a lag in the process — except that a process lag at '
      + 'least does something useful. You did not remove the noise; you moved your knowledge of '
      + 'the process later in time and paid for the quiet with response. That trade is sometimes '
      + 'worth making and it is never free, and the only honest way to decide is the one you just '
      + 'did: measure the loop\'s real job before and after. The cheap noise fixes are all '
      + 'upstream of the controller — a longer averaging time in the transmitter, a snubber on '
      + 'the impulse line, or a transmitter that is not mounted on a pump discharge.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'FILTER_WHERE',
    title: 'Filter the measurement, or filter the derivative',
    minutes: 8,
    blurb: 'Two filters, two very different bills.',
    brief: [
      'There are two places to put a filter in a PID and they are not interchangeable. N rolls '
        + 'the DERIVATIVE off at Td/N and touches nothing else. The PV filter sits in front of '
        + 'the whole algorithm and slows the proportional and integral paths down with it.',
      'Quieten this loop twice: once using only N, once using only the PV filter. Both will '
        + 'work. Then decide which one you would actually commission, and why.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 2.0;
      ctx.pidCfg.N = 100;
      ctx.pidCfg.pvFilter_s = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const r = ctx.diagReport;
      const c = ctx.pidCfg;
      if (!r || !(r.window_min > 1.5)) return;      // a half-filled window says nothing yet
      const quiet = r.reversalsPerMin < 40;
      if (quiet && c.Td > 0.5 && c.N <= 8 && c.pvFilter_s < 0.2) mem.byN = true;
      if (quiet && c.Td > 0.5 && c.N >= 40 && c.pvFilter_s >= 1.0) mem.byPv = true;
    },
    objectives: [
      obj({
        id: 'byn',
        text: 'Get below 40 reversals a minute using only the derivative filter (N at 8 or less)',
        check: (ctx, mem) => mem.byN === true,
        hint: 'Leave the PV filter on zero. N is the roll-off frequency of the rate term and '
          + 'nothing else.',
      }),
      obj({
        id: 'bypv',
        text: 'Do it again with N back above 40 and a PV filter of 1 s or more instead',
        check: (ctx, mem) => mem.byPv === true,
        hint: 'Both routes reach the same reversal count. The loop does not feel the same '
          + 'getting there.',
      }),
      obj({
        id: 'hold',
        mode: OBJ.HOLD,
        hold_s: 40,
        text: 'Hold setpoint within 0.03 bar with whichever you settled on',
        check: (ctx) => Math.abs(ctx.err) < 0.03 && ctx.pid.mode === MODE.AUTO,
      }),
      obj({
        id: 'both',
        mode: OBJ.NEVER,
        text: 'Do not stack both filters on top of each other',
        check: (ctx) => ctx.pidCfg.N <= 8 && ctx.pidCfg.pvFilter_s >= 1.0,
        hint: 'Two lags, one problem. You now have a loop nobody can tune and two numbers nobody '
          + 'can justify.',
      }),
    ],
    debrief: 'Noise gets into a controller through whichever term amplifies it most, and that is '
      + 'almost always the derivative, because differentiating is multiplying by frequency. N is '
      + 'therefore the cheap fix: it attacks the term that is guilty and leaves the other two '
      + 'alone. The PV filter is the expensive one, because it delays everything the controller '
      + 'knows — and it is the right one only when the proportional term is the path the noise is '
      + 'coming in through, which means the gain is high and the derivative is already off. Ask '
      + 'which term is amplifying the noise before you choose which filter to reach for.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'SERVO_LOAD',
    title: 'Setpoint tracking is not disturbance rejection',
    minutes: 10,
    blurb: 'Two jobs, one controller, and a tuning that cannot be best at both.',
    brief: [
      'Almost every tuning anybody shows you was judged on a setpoint step, because a setpoint '
        + 'step is easy to make and looks impressive on a trend. Almost every loop on a plant '
        + 'spends its entire life rejecting load changes and never sees a setpoint step at all.',
      'Tune this loop until a setpoint step is beautiful. Write the numbers down. Then take a '
        + 'load step with those numbers and look at what it does.',
      'Then tune it for the load step instead, and go back and look at the setpoint step.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 12;
      ctx.pidCfg.Ti = 30;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.b = 1;
      ctx.pidCfg.spRate = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const servo = lastStep(ctx.score, 'servo');
      if (servo && servo !== mem.lastServoRef) {
        mem.lastServoRef = servo;
        if (servo.overshootPct <= 5 && servo.settle_s > 0 && servo.settle_s <= 20) {
          mem.servoTune = { Kc: ctx.pidCfg.Kc, Ti: ctx.pidCfg.Ti };
        }
      }
      const load = lastStep(ctx.score, 'load');
      if (load && load !== mem.lastLoadRef) {
        mem.lastLoadRef = load;
        if (load.peakDev <= 0.12) mem.loadTune = { Kc: ctx.pidCfg.Kc, Ti: ctx.pidCfg.Ti };
      }
    },
    objectives: [
      obj({
        id: 'servo',
        text: 'Land a setpoint step with 5% overshoot or less, settled inside 20 s',
        check: (ctx, mem) => !!mem.servoTune,
        hint: 'Scenario runner, SETPOINT STEP. A long reset time and a modest gain is the '
          + 'classic servo answer.',
      }),
      obj({
        id: 'load',
        text: 'Hold a load step to a peak deviation of 0.12 bar or less',
        check: (ctx, mem) => !!mem.loadTune,
        hint: 'Scenario runner, LOAD STEP. Rejecting a load needs reset, and much more of it than '
          + 'a pretty setpoint step wants.',
      }),
      obj({
        id: 'trade',
        text: 'Show the two answers are genuinely different tunings',
        check: (ctx, mem) => !!mem.servoTune && !!mem.loadTune
          && (Math.abs(mem.servoTune.Ti - mem.loadTune.Ti) / Math.max(mem.loadTune.Ti, 1e-6) > 0.3
            || Math.abs(mem.servoTune.Kc - mem.loadTune.Kc) / Math.max(mem.loadTune.Kc, 1e-6) > 0.3),
        hint: 'If one set of numbers did both, one of the two results was not as good as you '
          + 'thought. Look at the reset time in particular.',
      }),
      obj({
        id: 'nocheat',
        mode: OBJ.NEVER,
        text: 'Do not soften the setpoint step with a ramp or a setpoint weight',
        check: (ctx) => ctx.pidCfg.spRate > 0 || ctx.pidCfg.b < 0.98,
        hint: 'Those work, and they are the whole of the next lesson. Here the point is to feel '
          + 'the trade that a one-degree-of-freedom controller cannot escape.',
      }),
    ],
    debrief: 'A setpoint enters the loop at one point and a load disturbance enters it at another, '
      + 'so they travel through different transfer functions and no single set of three numbers '
      + 'is optimal for both. Reset is where you feel it: load rejection wants a short reset time '
      + 'because the integral is the only term that can remove a sustained disturbance, and a '
      + 'short reset time is exactly what makes a setpoint step overshoot. Tune for the job the '
      + 'loop actually does — which is regulation, on nearly every loop you will ever meet — and '
      + 'then fix the setpoint response separately. The next lesson is how.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'TWO_DOF',
    title: 'Two degrees of freedom',
    minutes: 8,
    blurb: 'The knob that fixes setpoint response and costs nothing.',
    brief: [
      'The loop has been tuned hard for load rejection: high gain, short reset. It rejects a '
        + 'disturbance beautifully and it overshoots a setpoint step badly, which is exactly the '
        + 'trade the last lesson made you feel.',
      'The setpoint weight b scales the setpoint in the PROPORTIONAL term only. At b = 1 the '
        + 'controller sees the full step and kicks. At b = 0.4 it barely sees it at all, and the '
        + 'integral term takes the loop to setpoint on its own.',
      'The disturbance path does not contain b. So this is free.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 30;
      ctx.pidCfg.Ti = 7;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.b = 1;
      ctx.pidCfg.spRate = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const servo = lastStep(ctx.score, 'servo');
      if (servo && servo !== mem.lastServoRef) {
        mem.lastServoRef = servo;
        if (ctx.pidCfg.b > 0.9) mem.servoAtOne = servo.overshootPct;
        else if (ctx.pidCfg.b <= 0.5) mem.servoAtLow = servo.overshootPct;
      }
      const load = lastStep(ctx.score, 'load');
      if (load && load !== mem.lastLoadRef) {
        mem.lastLoadRef = load;
        if (ctx.pidCfg.b > 0.9) mem.loadAtOne = load.peakDev;
        else if (ctx.pidCfg.b <= 0.5) mem.loadAtLow = load.peakDev;
      }
    },
    objectives: [
      obj({
        id: 'kick',
        text: 'Record a setpoint step overshooting more than 20% at b = 1',
        check: (ctx, mem) => (mem.servoAtOne ?? 0) > 20,
        hint: 'Scenario runner, SETPOINT STEP, with the tuning exactly as delivered.',
      }),
      obj({
        id: 'weight',
        text: 'Drop b to 0.5 or less and land the same step inside 8% overshoot',
        check: (ctx, mem) => (mem.servoAtLow ?? 999) <= 8 && ctx.pidCfg.b <= 0.5,
        hint: 'Change nothing else. Kc and Ti stay where they are.',
      }),
      obj({
        id: 'free',
        text: 'Show the load rejection did not get worse for it',
        check: (ctx, mem) => (mem.loadAtOne ?? 0) > 0 && (mem.loadAtLow ?? 0) > 0
          && mem.loadAtLow <= mem.loadAtOne * 1.1,
        hint: 'Run the LOAD STEP scenario at b = 1 and again at the low b. The two peak '
          + 'deviations should be within a few percent of each other.',
      }),
    ],
    debrief: 'That is what "two degrees of freedom" means, and it is why b belongs on every '
      + 'faceplate and is missing from most. The controller now has one response for a setpoint '
      + 'and a different one for a disturbance, so the compromise the previous lesson forced on '
      + 'you does not have to be made. The setpoint ramp does the same job by a different route '
      + 'and is easier to explain to an operator; the derivative weight c does it for the rate '
      + 'term, and is why the default here is c = 0 — nobody has ever wanted a derivative spike '
      + 'on a setpoint change.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'DEADTIME',
    title: 'Dead time, and the rules that stop working',
    minutes: 12,
    blurb: 'Every tuning rule ever published is a function of one ratio. Move it and watch.',
    brief: [
      'Identify this process at the scan it ships with and write down theta over tau — the dead '
        + 'time divided by the time constant. It will be small, which is why the loop is easy.',
      'Now slow the controller scan to 1.5 s or more. A scan period is dead time: the controller '
        + 'holds its last answer while the plant carries on, and on average half a scan of it is '
        + 'pure delay. Identify again and look at what happened to the ratio.',
      'Then try to tune the slow-scan plant to the same standard. You will not manage it, and '
        + 'the interesting part is exactly how much you have to give up.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 12;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const m = ctx.model;
      // A new model object, not a new number: the step test writes a fresh record each time it
      // completes, and it is the scan the test RAN at that decides which column it belongs in.
      if (m && m !== mem.lastModelRef) {
        mem.lastModelRef = m;
        const ratio = m.theta / Math.max(m.tau, 1e-6);
        if (ctx.config.scan_s <= 0.5) mem.easyRatio = ratio;
        else if (ctx.config.scan_s >= 1.2) mem.hardRatio = ratio;
      }
      if (ctx.config.scan_s >= 1.2 && ctx.margins?.stable) mem.slowMs = ctx.margins.ms;
    },
    objectives: [
      obj({
        id: 'easy',
        text: 'Identify the process at the shipped scan and record theta/tau',
        check: (ctx, mem) => Number.isFinite(mem.easyRatio),
        hint: 'Analysis panel, STEP TEST, with the scan at 0.2 s. The test reports theta/tau in '
          + 'its own message.',
      }),
      obj({
        id: 'hard',
        text: 'Slow the scan past 1.2 s, identify again, and at least double theta/tau',
        check: (ctx, mem) => Number.isFinite(mem.hardRatio) && Number.isFinite(mem.easyRatio)
          && mem.hardRatio > mem.easyRatio * 2,
        hint: 'The scan period is on the tuning panel. Nothing about the pumps has changed — you '
          + 'have made the process harder purely by looking at it less often.',
      }),
      obj({
        id: 'tune',
        mode: OBJ.HOLD,
        hold_s: 45,
        text: 'Hold setpoint within 0.05 bar on the slow plant with Ms no worse than 2.0',
        check: (ctx, mem) => ctx.config.scan_s >= 1.2 && Math.abs(ctx.err) < 0.05
          && (mem.slowMs ?? 9) <= 2.0 && ctx.pid.mode === MODE.AUTO,
        hint: 'Every rule you have gives less gain and more reset as theta grows. Apply one from '
          + 'the ranked table rather than guessing.',
      }),
      obj({
        id: 'back',
        mode: OBJ.HOLD,
        hold_s: 25,
        text: 'Put the scan back to 0.3 s or faster and hold within 0.03 bar',
        check: (ctx) => ctx.config.scan_s <= 0.3 && Math.abs(ctx.err) < 0.03,
        hint: 'Leaving a training rig on a one-and-a-half second scan is how the next person '
          + 'concludes it is broken.',
      }),
      obj({
        id: 'ring',
        mode: OBJ.NEVER,
        text: 'Do not carry the fast-scan tuning across and let it ring',
        check: (ctx) => ctx.config.scan_s >= 1.2 && ctx.pidCfg.Kc > 15 && cycling(ctx, 0.6),
        hint: 'The gain that was right at 0.2 s is not right at 1.5 s, and the loop is telling '
          + 'you so.',
      }),
    ],
    debrief: 'Theta over tau is the difficulty of a loop reduced to one number, and every '
      + 'published rule is a formula in it. Below about 0.1 the loop is lag-dominant and almost '
      + 'any sensible tuning works. Around 0.3 the rules start to disagree with each other and '
      + 'you have to pick one on purpose. Above 1 the process is dead-time dominant, the rules '
      + 'become useless, and the honest answer is that no tuning will fix it — you need a shorter '
      + 'delay, a closer measurement, or a compensator. That last option is the next lesson, and '
      + 'it comes with its own bill.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'SMITH',
    title: 'Compensating for dead time, and being wrong about it',
    minutes: 12,
    blurb: 'The one structure that beats dead time, and the one thing that destroys it.',
    brief: [
      'A Smith predictor puts a model of the process inside the controller and lets the feedback '
        + 'act on the model\'s undelayed prediction instead of on the delayed measurement. When '
        + 'the model is right, the loop behaves as though the dead time were not there.',
      'Slow the scan to at least 1.2 s so there is a dead time worth compensating, identify the '
        + 'process, and load the model into the compensator.',
      'Then get the compensator\'s dead time deliberately wrong and watch what a predictor does '
        + 'when its prediction is a lie.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 18;
      ctx.pidCfg.Ti = 14;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.smith.enabled = false;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const s = ctx.pidCfg.smith;
      const m = ctx.model;
      if (!s || !m || !(m.theta > 0)) return;
      mem.thetaErr = Math.abs(s.theta - m.theta) / Math.max(m.theta, 1e-6);
      mem.tauErr = Math.abs(s.tau - m.tau) / Math.max(m.tau, 1e-6);
      if (s.enabled && s.theta < 0.5 * m.theta && cycling(ctx, 0.55)) mem.sawTheLie = true;
    },
    objectives: [
      obj({
        id: 'slow',
        text: 'Slow the scan past 1.2 s and identify the process on it',
        check: (ctx) => ctx.config.scan_s >= 1.2 && !!ctx.model && ctx.model.theta > 0,
        hint: 'There is no point compensating a dead time you have not measured.',
      }),
      obj({
        id: 'comp',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Load the identified model into the compensator and hold within 0.04 bar',
        check: (ctx, mem) => ctx.pidCfg.smith?.enabled === true
          && (mem.thetaErr ?? 9) <= 0.4 && (mem.tauErr ?? 9) <= 0.5
          && Math.abs(ctx.err) < 0.04,
        hint: 'Gain, time constant and dead time all have to be entered. The compensator is only '
          + 'as good as the worst of the three.',
      }),
      obj({
        id: 'wrong',
        text: 'Halve the compensator\'s dead time and watch the loop come apart',
        check: (ctx, mem) => mem.sawTheLie === true,
        hint: 'It will not degrade gracefully. A predictor that is confident and wrong is worse '
          + 'than no predictor at all, which is the whole point of doing this on a simulator.',
      }),
      obj({
        id: 'back',
        mode: OBJ.HOLD,
        hold_s: 25,
        text: 'Switch the compensator off, put the scan back to 0.3 s, and hold within 0.03 bar',
        check: (ctx) => ctx.pidCfg.smith?.enabled === false && ctx.config.scan_s <= 0.3
          && Math.abs(ctx.err) < 0.03,
      }),
      obj({
        id: 'blind',
        mode: OBJ.NEVER,
        text: 'Never commission the compensator without a model',
        check: (ctx) => ctx.pidCfg.smith?.enabled === true && !ctx.model,
        hint: 'The default numbers in the compensator are somebody else\'s process.',
      }),
    ],
    debrief: 'A Smith predictor is the only structure that genuinely removes dead time from a '
      + 'loop, and its price is that you now own a model for the life of the plant. Fouling, a '
      + 'changed duty, a different liquid, a second pump on the header — every one of those moves '
      + 'the real process away from the model, and the compensator degrades far less gracefully '
      + 'than a plain PID would. That is why they are rare outside the process industries that '
      + 'can maintain them. Before reaching for one, ask whether the dead time can simply be '
      + 'made smaller: a faster scan, a closer transmitter, a shorter impulse line. That is '
      + 'cheaper, permanent, and needs no maintenance.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'HIDDEN_SAT',
    title: 'The limit the controller cannot see',
    minutes: 10,
    blurb: 'Windup with the output nowhere near a limit.',
    brief: [
      'The loop is on the throttle valve and the positioner has been left in a state you will '
        + 'meet on any plant with big dampers or old actuators: it takes a minute and a half to '
        + 'stroke from end to end.',
      'Take a setpoint step. The controller will demand a position, the valve will start '
        + 'crawling toward it, the error will not go away, and the integral will keep '
        + 'accumulating against an element that is doing its best.',
      'Watch the output and the valve position at the same time. Then notice what anti-windup '
        + 'did about it, which is nothing, because the output never hit a limit.',
    ],
    setup(ctx, api) {
      ctx.pid.spTarget = 3.2;
      ctx.pid.sp = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      // Through the action: switching the final element re-aligns the controller and preloads the
      // output to where the valve already is. A raw assignment would step the plant at the switch
      // and the first thing the operator saw would be an artefact of the lesson setup.
      api.setDisturbance({ finalElement: FINAL.THROTTLE });
      api.setDisturbance({ valveOverride: { pcv: { strokeTime_s: 90, stickband: 0, slipJump: 0 } } });
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 8;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.spRate = 0;
      ctx.pid.mode = MODE.AUTO;
    },
    track(ctx, mem, dt_s) {
      const gap = Math.abs(ctx.co - ctx.plant.pcv.x * 100);
      mem.gap = gap;
      mem.peakGap = Math.max(mem.peakGap ?? 0, gap);
      if (ctx.pid.saturated) mem.satTime_s = (mem.satTime_s || 0) + dt_s;
      const servo = lastStep(ctx.score, 'servo');
      if (servo && servo !== mem.lastServoRef) {
        mem.lastServoRef = servo;
        mem.lastOvershoot = servo.overshootPct;
        mem.lastSize = servo.peakDev;
        // The trap this lesson is built around: a huge overshoot with the output never once
        // against a limit, so every anti-windup scheme on the panel had nothing to act on.
        if (servo.overshootPct > 35 && (mem.satTime_s ?? 0) < 1 && mem.peakGap > 25) {
          mem.windupWithoutSaturation = true;
        }
        if (servo.overshootPct <= 12 && ctx.plant.valveOverride.pcv.strokeTime_s >= 30) {
          mem.tamed = true;
        }
      }
    },
    objectives: [
      obj({
        id: 'gap',
        text: 'Open a gap of more than 25% between what the controller asks for and where the '
          + 'valve is',
        check: (ctx, mem) => (mem.peakGap ?? 0) > 25,
        hint: 'Step the setpoint. The valve card shows the actual travel; the faceplate shows the '
          + 'demand.',
      }),
      obj({
        id: 'over',
        text: 'Overshoot a setpoint step by more than 35%',
        check: (ctx, mem) => (mem.lastOvershoot ?? 0) > 35,
        hint: 'Scenario runner, SETPOINT STEP. It will do this on its own.',
      }),
      obj({
        id: 'nosat',
        text: 'Confirm the output never touched a limit while that happened',
        check: (ctx, mem) => mem.windupWithoutSaturation === true,
        hint: 'This is the point of the lesson. Back-calculation unwinds the integral toward the '
          + 'output that actually left the controller — and the output that left was exactly the '
          + 'one that was asked for.',
      }),
      obj({
        id: 'fix',
        text: 'Get the overshoot inside 12% with the valve still taking 90 s to stroke',
        check: (ctx, mem) => mem.tamed === true,
        hint: 'The controller has to become slower than the element. Reset time is the knob that '
          + 'matters; a setpoint ramp helps as well, because a step the valve cannot follow is a '
          + 'step nobody needed to make.',
      }),
      obj({
        id: 'repair',
        mode: OBJ.NEVER,
        text: 'Do not make the valve fast again to get out of it',
        check: (ctx) => (ctx.plant.valveOverride.pcv.strokeTime_s ?? 4) < 30,
        hint: 'On a plant that is a new actuator and a six-week lead time. The loop has to work '
          + 'in the meantime.',
      }),
    ],
    debrief: 'Anti-windup is not a general defence against the plant failing to do what it is '
      + 'told; it is a defence against ONE specific failure, the output limit, and it works by '
      + 'being told the truth about what left the controller. A rate-limited element, a slipping '
      + 'coupling, a valve whose air supply has dropped, a drive in torque limit — none of those '
      + 'appear in the output, so none of them are seen. The general fix is external reset: feed '
      + 'the element\'s actual position back into the integrator instead of the controller\'s own '
      + 'demand, and the loop can no longer wind up against anything at all. Failing that, the '
      + 'controller must be slower than the slowest thing it drives, and the rule of thumb — a '
      + 'reset time longer than the element\'s full stroke — is not conservative, it is arithmetic.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'VALVE_SIZE',
    title: 'Sizing, and the characteristic you actually get',
    minutes: 11,
    blurb: 'The curve in the catalogue is not the curve in the pipe.',
    brief: [
      'The loop is in MANUAL on the throttle valve, so the controller output IS the valve travel. '
        + 'Park it at 20%, then 35, 50, 65, 80, 90, and let the flow settle at each.',
      'Plot the flow you get against the travel you asked for. That is the INSTALLED '
        + 'characteristic, and it is not the equal-percentage curve on the datasheet, because the '
        + 'valve is in series with a pump curve and a pipe that both push back.',
      'The slope of that plot is the process gain the controller will see. Look at how much it '
        + 'changes from one end to the other, and then ask what a single Kc is supposed to do '
        + 'about it.',
    ],
    setup(ctx, api) {
      ctx.plant.demandTarget = 0.55;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      ctx.pid.spTarget = 3.0;
      ctx.pid.sp = 3.0;
      api.setDisturbance({ finalElement: FINAL.THROTTLE });
      api.setDisturbance({ valveOverride: { pcv: { strokeTime_s: null, stickband: 0, slipJump: 0 } } });
      ctx.pidCfg.Kc = 14;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.MAN;
      ctx.pid.coMan = 60;
    },
    track(ctx, mem, dt_s) {
      if (!mem.points) mem.points = new Map();
      const travel = ctx.plant.pcv.x * 100;
      // A point is a SETTLED operating point. Reading the flow while the valve is still moving
      // measures the stroke, not the characteristic, and the gain that comes out is nonsense.
      const still = Math.abs(travel - (mem.lastTravel ?? travel)) < 0.15;
      mem.lastTravel = travel;
      mem.dwell_s = still ? (mem.dwell_s || 0) + dt_s : 0;
      if (mem.dwell_s > 10 && travel >= 8) {
        mem.points.set(Math.round(travel / 15) * 15, {
          x: travel, q: ctx.plant.Qdemand_m3h,
        });
      }
      if (travel < 8 && ctx.plant.drv[0].n_pct > 5) mem.onSeat_s = (mem.onSeat_s || 0) + dt_s;

      // The installed gain between neighbouring points, and the ratio of its extremes. That ratio
      // is the number a single fixed gain has to cover, and it is why oversized valves are a
      // control problem rather than a piping one.
      const pts = [...mem.points.values()].sort((a, b) => a.x - b.x);
      let lo = Infinity;
      let hi = 0;
      for (let i = 1; i < pts.length; i += 1) {
        const dx = pts[i].x - pts[i - 1].x;
        if (dx < 5) continue;
        const g = Math.abs(pts[i].q - pts[i - 1].q) / dx;
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
      }
      mem.gainRatio = lo > 0 && Number.isFinite(lo) ? hi / lo : NaN;
      if (ctx.pid.mode === MODE.AUTO && travel < 25 && Math.abs(ctx.err) < 0.05
        && !cycling(ctx, 0.5)) {
        mem.nearSeat_s = (mem.nearSeat_s || 0) + dt_s;
      }
    },
    objectives: [
      obj({
        id: 'map',
        text: 'Record five settled points spread across the travel, 20% to 90%',
        check: (ctx, mem) => (mem.points?.size ?? 0) >= 5,
        hint: 'Set the output, wait for the flow to stop moving, then move on. Ten seconds of '
          + 'stillness counts as a point.',
      }),
      obj({
        id: 'ratio',
        text: 'Show the installed gain varies by more than 2.5 to 1 across that range',
        check: (ctx, mem) => (mem.gainRatio ?? 0) > 2.5,
        hint: 'Spread the points further apart. The gain is smallest near the seat and smallest '
          + 'again near wide open, where the valve has run out of authority.',
      }),
      obj({
        id: 'seat',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Then hold setpoint in AUTO with the valve sitting below 25% open',
        check: (ctx, mem) => (mem.nearSeat_s ?? 0) > 0.5,
        hint: 'Lower the setpoint until the valve comes down near its seat, then get it stable '
          + 'there. This is what an oversized valve makes you do every day.',
      }),
      obj({
        id: 'shut',
        mode: OBJ.NEVER,
        text: 'Do not run the valve below 8% travel for more than half a minute',
        check: (ctx, mem) => (mem.onSeat_s ?? 0) > 30,
        hint: 'On the seat there is no characteristic left at all, only the trim wearing out.',
      }),
    ],
    debrief: 'Sizing a valve is a control decision that gets made by a piping engineer with a '
      + 'safety factor. The number that matters is the fraction of the total system pressure drop '
      + 'that the valve takes at design flow: below about a fifth, the valve has almost no '
      + 'authority near wide open and the installed characteristic collapses into a plateau; a '
      + 'valve sized with two safety factors on top of that spends its life in the bottom quarter '
      + 'of its travel where the resolution is worst and the seat is being cut. Equal-percentage '
      + 'trim exists precisely to fight this — its inherent gain rises with travel just as the '
      + 'system\'s authority falls — and the product of the two is what you just plotted. Measure '
      + 'the installed curve before you tune, and if the gain ratio is worse than about three to '
      + 'one, the answer is a smaller valve or a gain schedule, not a compromise Kc.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'SPLIT_RANGE',
    title: 'Split range, and the seam in the middle',
    minutes: 11,
    blurb: 'Two final elements, one output, and one place where it all goes wrong.',
    brief: [
      'The loop controls flow to process, and it has been given two elements instead of one. '
        + 'Below 45% output the recirculation valve is open and spilling flow back to the tank; '
        + 'above 45% the recirculation is shut and only pump speed acts. One output, two '
        + 'elements, split at 45%.',
      'Work both halves and watch the trend. Then park the setpoint so the output sits right on '
        + 'the seam and leave it there.',
      'The output is perfectly continuous across the crossover. The PROCESS GAIN is not, and the '
        + 'loop is about to tell you the difference.',
    ],
    setup(ctx, api) {
      api.setLoopMode('FLOW');
      ctx.pid.spTarget = 18;
      ctx.pid.sp = 18;
      ctx.plant.demandTarget = 0.55;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      ctx.plant.recircMode = RECIRC.MANUAL;
      ctx.pidCfg.Kc = 1.6;
      ctx.pidCfg.Ti = 6;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
    },
    track(ctx, mem, dt_s) {
      const cross = 45;
      mem.cross = cross;
      // The rig has no split-range block, so the lesson is one. This is the only hook that runs
      // every scan, and driving the recirculation from the output here is exactly what a
      // split-range signal selector would be doing in the DCS.
      ctx.plant.recircMode = RECIRC.MANUAL;
      ctx.plant.bypass = clamp((cross - ctx.co) / cross, 0, 1);

      if (ctx.co < cross - 7) mem.workedLow = true;
      if (ctx.co > cross + 7) mem.workedHigh = true;
      if (Math.abs(ctx.co - cross) < 5) mem.onSeam_s = (mem.onSeam_s || 0) + dt_s;
      const r = ctx.diagReport;
      if (r) mem.peakReversals = Math.max(mem.peakReversals ?? 0, r.reversalsPerMin);
    },
    objectives: [
      obj({
        id: 'both',
        text: 'Work both halves: take the output below 38% and above 52%',
        check: (ctx, mem) => mem.workedLow === true && mem.workedHigh === true,
        hint: 'Move the flow setpoint. Low setpoints need the recirculation; high ones need speed.',
      }),
      obj({
        id: 'seam',
        mode: OBJ.HOLD,
        hold_s: 90,
        text: 'Sit on the crossover — output within 5% of 45 — and hold flow within 1.0 m3/h',
        check: (ctx) => Math.abs(ctx.co - 45) < 5 && Math.abs(ctx.err) < 1.0
          && ctx.pid.mode === MODE.AUTO,
        hint: 'Find the setpoint that puts you there and then make the loop tolerable at it. '
          + 'The gain that works in one half is not the gain that works in the other.',
      }),
      obj({
        id: 'hunt',
        mode: OBJ.NEVER,
        text: 'Do not let it hunt across the seam — more than 90 output reversals a minute',
        check: (ctx) => (ctx.diagReport?.reversalsPerMin ?? 0) > 90,
        hint: 'Every reversal across the crossover is both elements moving. That is two pieces of '
          + 'machinery being worn out by one badly-shaped signal.',
      }),
    ],
    debrief: 'Bumpless does not mean the output is continuous — it always is, it is one number. '
      + 'Bumpless means the PROCESS GAIN is continuous, so that the loop does not discover a '
      + 'different plant every time it crosses over. Here the recirculation half and the speed '
      + 'half have quite different gains, and a controller tuned for one is wrong for the other; '
      + 'sitting on the seam it is wrong for both, alternately. The industrial fixes are '
      + 'characterisation — shape each half so their gains meet at the crossover — and an '
      + 'overlap or deadband so the loop is never asked to modulate both at once. Turning the '
      + 'gain down is not one of them: it makes the seam slower to find, not smaller.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'RATIO',
    title: 'Ratio control, and the wild stream',
    minutes: 11,
    blurb: 'The controlled variable is a ratio, and the other stream is not yours.',
    brief: [
      'The tank make-up has been put on ratio: the make-up flow is held at one to one with the '
        + 'flow the pumps deliver, so whatever leaves is replaced. Nothing is measuring the '
        + 'level. The ratio is the controlled variable.',
      'Move the demand valve about and watch the level. It will sit still, because a mass '
        + 'balance held by a ratio station does not care what the flow is, only that the two '
        + 'agree.',
      'Then ask for more flow than the make-up line can pass, and watch the ratio stop being a '
        + 'ratio. Getting it back is not a control problem.',
    ],
    setup(ctx) {
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.pid.sp = 3.2;
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 12;
      ctx.pidCfg.Td = 0;
      ctx.plant.demandTarget = 0.42;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      // The make-up level controller is taken out of service so the ratio station can own the
      // valve. With `makeupAuto` false the plant leaves `inflow_m3h` alone, which is what makes
      // the ratio station below possible at all.
      ctx.plant.makeupAuto = false;
    },
    track(ctx, mem, dt_s) {
      const RATIO = 1.0;
      const CAP_M3H = 26;                    // the make-up line this rig was actually given
      mem.cap = CAP_M3H;
      ctx.plant.makeupAuto = false;
      const want = RATIO * ctx.plant.Qdemand_m3h;
      ctx.plant.inflow_m3h = Math.min(want, CAP_M3H);

      mem.level0 = mem.level0 ?? ctx.plant.level_m;
      mem.qMin = Math.min(mem.qMin ?? ctx.plant.Qdemand_m3h, ctx.plant.Qdemand_m3h);
      mem.qMax = Math.max(mem.qMax ?? ctx.plant.Qdemand_m3h, ctx.plant.Qdemand_m3h);
      mem.drop = Math.max(mem.drop ?? 0, mem.level0 - ctx.plant.level_m);

      if (want > CAP_M3H) {
        mem.starved = true;
        mem.starved_s = (mem.starved_s || 0) + dt_s;
      } else {
        mem.starved = false;
      }
      mem.rising = ctx.plant.level_m > (mem.lastLevel ?? ctx.plant.level_m) - 1e-6;
      mem.lastLevel = ctx.plant.level_m;
    },
    objectives: [
      obj({
        id: 'hold',
        mode: OBJ.HOLD,
        hold_s: 120,
        text: 'Swing the delivered flow by at least 12 m3/h and keep the level within 0.06 m',
        check: (ctx, mem) => (mem.qMax ?? 0) - (mem.qMin ?? 0) > 12
          && Math.abs(ctx.plant.level_m - (mem.level0 ?? ctx.plant.level_m)) < 0.06,
        hint: 'Move the demand valve between about 30% and 60% and leave the tank alone. Nothing '
          + 'is controlling the level and the level is not moving — that is the point.',
      }),
      obj({
        id: 'break',
        text: 'Ask for more than the make-up line can pass, and lose 0.25 m of level for it',
        check: (ctx, mem) => (mem.starved_s ?? 0) > 30 && (mem.drop ?? 0) > 0.25,
        hint: 'Open the demand valve wide. The make-up caps out around 26 m3/h and the ratio '
          + 'cannot be held past that, whatever the ratio station would like.',
      }),
      obj({
        id: 'recover',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Bring the wild stream back inside range and get the level climbing again',
        check: (ctx, mem) => mem.starved === false && mem.rising === true
          && ctx.plant.level_m > 0.8,
        hint: 'Close the demand valve down. The only way to restore a ratio whose follower has '
          + 'run out of range is to reduce the stream that is not being controlled.',
      }),
      obj({
        id: 'empty',
        mode: OBJ.NEVER,
        text: 'Do not let the tank fall below its low-low level',
        check: (ctx) => ctx.plant.level_m < 0.25,
        hint: 'Below that the pumps lose suction and this stops being a control exercise.',
      }),
    ],
    debrief: 'A ratio station is feedforward with the arithmetic made explicit: it measures the '
      + 'stream you cannot command, multiplies by a number, and hands the answer to a controller '
      + 'on the stream you can. It holds a ratio, not a flow, which is exactly right for '
      + 'combustion air, for dilution, for reagent dosing and for a mass balance like this one. '
      + 'Two things kill it and both were on the trend. The first is applying the ratio to the '
      + 'wild stream\'s SETPOINT instead of its MEASUREMENT, so that the follower dutifully '
      + 'tracks a flow that is not happening. The second is what you just did: the follower ran '
      + 'out of valve. A ratio is only a ratio while the controlled stream has range left, and '
      + 'the alarm that matters on a ratio loop is not deviation, it is the follower at its '
      + 'limit.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'SCAN_RATE',
    title: 'The sampled-data penalty',
    minutes: 10,
    blurb: 'You did not change the plant. You changed how often you look at it.',
    brief: [
      'Identify the process and read the margins the analysis panel gives your current tuning. '
        + 'Write down Ms.',
      'Now slow the controller scan to 1 s and change nothing else at all. The pumps, the pipe, '
        + 'the valve and the three tuning constants are exactly as they were, and the margins are '
        + 'not.',
      'Retune for the slow scan until the margins are respectable again, and notice what it cost '
        + 'you in settling time. That number is the price of the scan.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const m = ctx.margins;
      if (!m || !Number.isFinite(m.ms)) return;
      if (ctx.config.scan_s <= 0.35) mem.msFast = m.ms;
      if (ctx.config.scan_s >= 1.0) mem.msSlow = Math.max(mem.msSlow ?? 0, m.ms);
      if (ctx.config.scan_s >= 1.0 && m.stable && m.ms <= 1.9) mem.retunedMs = m.ms;
    },
    objectives: [
      obj({
        id: 'model',
        text: 'Identify the process and get margins for the tuning as delivered',
        check: (ctx, mem) => !!ctx.model && Number.isFinite(mem.msFast),
        hint: 'Analysis panel, STEP TEST or RELAY. The margins need a model — there is nothing to '
          + 'compute them from otherwise.',
      }),
      obj({
        id: 'penalty',
        text: 'Slow the scan to 1 s or more, touch nothing else, and watch Ms rise by a quarter',
        check: (ctx, mem) => Number.isFinite(mem.msFast) && Number.isFinite(mem.msSlow)
          && mem.msSlow > mem.msFast * 1.25,
        hint: 'The scan period is on the tuning panel. The margins are recomputed against it, '
          + 'because a zero-order hold really is part of the loop.',
      }),
      obj({
        id: 'retune',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Retune for the slow scan: Ms back to 1.9 or better, holding within 0.05 bar',
        check: (ctx, mem) => ctx.config.scan_s >= 1.0 && Number.isFinite(mem.retunedMs)
          && Math.abs(ctx.err) < 0.05,
        hint: 'Less gain, more reset. There is no tuning that gets the fast-scan performance back '
          + '— that is what "penalty" means.',
      }),
      obj({
        id: 'back',
        mode: OBJ.HOLD,
        hold_s: 25,
        text: 'Put the scan back to 0.3 s or faster and hold within 0.03 bar',
        check: (ctx) => ctx.config.scan_s <= 0.3 && Math.abs(ctx.err) < 0.03,
      }),
      obj({
        id: 'ring',
        mode: OBJ.NEVER,
        text: 'Do not leave it cycling on the slow scan',
        check: (ctx) => ctx.config.scan_s >= 1.0 && cycling(ctx, 0.6),
      }),
    ],
    debrief: 'A sampled controller adds, on average, half a scan period of pure dead time, plus '
      + 'the hold that keeps its last answer on the output between scans. Both cost phase where '
      + 'the loop can least afford it, at the crossover frequency. The usual rules — scan at a '
      + 'tenth of the process time constant, or a quarter of the dead time, whichever is smaller '
      + '— are not fussiness; they are the point at which the penalty stops being visible. It '
      + 'matters most on fast loops, which is why flow and pressure loops belong on a fast '
      + 'scanner and a temperature loop does not care. And it is the reason a tuning worked out '
      + 'against a continuous model is always a little livelier in the plant than it was on the '
      + 'desk.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'ALIAS',
    title: 'The cycle that is not there',
    minutes: 11,
    blurb: 'At a slow scan the trend stops being the process.',
    brief: [
      'Let the loop-health window fill at the scan the rig ships with and note the error standard '
        + 'deviation. That is what the noise on this transmitter really looks like.',
      'Now slow the scan to 1.5 s and let the window fill again. The noise did not go anywhere — '
        + 'everything above half the sample rate folded back down into the band you are watching, '
        + 'and it is now indistinguishable from a slow process wander.',
      'Then try to filter it out from inside the controller, and find out that you are too late.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.pvFilter_s = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const r = ctx.diagReport;
      // Changing the scan resets the diagnostic window, so each phase gets measured on its own
      // history rather than on a smear of both. Wait for a genuinely full window before believing
      // a standard deviation.
      if (!r || !(r.window_min > 2.5) || !Number.isFinite(r.sdPct)) return;
      if (ctx.config.scan_s <= 0.35) mem.fastSd = r.sdPct;
      if (ctx.config.scan_s >= 1.5) {
        if (ctx.pidCfg.pvFilter_s < 0.3) mem.slowSd = r.sdPct;
        if (ctx.pidCfg.pvFilter_s >= 2.0) mem.slowFilteredSd = r.sdPct;
      }
    },
    objectives: [
      obj({
        id: 'fast',
        text: 'Fill the health window at the shipped scan and record the error spread',
        check: (ctx, mem) => Number.isFinite(mem.fastSd),
        hint: 'Nothing to change. It needs about three minutes of history.',
      }),
      obj({
        id: 'slow',
        text: 'Slow the scan past 1.5 s and fill the window again',
        check: (ctx, mem) => Number.isFinite(mem.slowSd),
        hint: 'Give it another three minutes at the new scan.',
      }),
      obj({
        id: 'worse',
        text: 'Show the sampled error got no better for looking less often',
        check: (ctx, mem) => Number.isFinite(mem.fastSd) && Number.isFinite(mem.slowSd)
          && mem.slowSd >= mem.fastSd,
        hint: 'People expect fewer samples to mean a quieter trend. It means a quieter-LOOKING '
          + 'trend with the same energy in it, redistributed to frequencies you can no longer '
          + 'tell from the process.',
      }),
      obj({
        id: 'toolate',
        text: 'Put a 2 s filter in the controller and show it cannot undo it',
        check: (ctx, mem) => Number.isFinite(mem.slowFilteredSd) && Number.isFinite(mem.fastSd)
          && mem.slowFilteredSd >= mem.fastSd,
        hint: 'The filter is behind the sampler. Whatever folded, folded before the filter ever '
          + 'saw it, and it is now sitting at frequencies the filter is meant to pass.',
      }),
      obj({
        id: 'back',
        mode: OBJ.HOLD,
        hold_s: 25,
        text: 'Put the scan back under 0.3 s, take the filter out, and hold within 0.03 bar',
        check: (ctx) => ctx.config.scan_s <= 0.3 && ctx.pidCfg.pvFilter_s <= 0.5
          && Math.abs(ctx.err) < 0.03,
      }),
    ],
    debrief: 'Aliasing is the one signal-processing fact a control engineer cannot get away with '
      + 'not knowing, because it makes the instrument lie in a way that looks exactly like a '
      + 'process problem. Everything above half the sample rate comes back as something below it, '
      + 'and once it has folded no amount of digital filtering can separate it from the real '
      + 'thing. The defence has to sit AHEAD of the sampler: an analogue filter in the '
      + 'transmitter, a longer damping time in the field device, or a sample rate fast enough '
      + 'that there is nothing up there to fold. The next time a trend shows a slow wander that '
      + 'no disturbance explains, check the scan rate before you check the tuning — and be '
      + 'especially suspicious when the wander appeared on the day somebody moved the loop to a '
      + 'busier controller.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'DELAY_MARGIN',
    title: 'Where the transmitter is, and what the delay costs',
    minutes: 10,
    blurb: 'How much transport delay this tuning can afford, to two decimal places.',
    brief: [
      'Transport delay is transport delay whatever produced it: fifty metres of impulse line, a '
        + 'thermowell, a sample loop to an analyser, a transmitter mounted where the scaffolding '
        + 'was easy, or a controller that only looks every second. The loop cannot tell them '
        + 'apart and neither should you.',
      'Identify the process and read the DELAY MARGIN off the analysis panel. It is the extra '
        + 'dead time your present tuning can absorb before the loop goes unstable — the single '
        + 'most useful number to have in your head when somebody asks whether the transmitter can '
        + 'be moved somewhere more convenient.',
      'Then tune the loop up until that margin is under two and a half seconds, add more delay '
        + 'than that with the scan slider, and see whether the number was telling the truth.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 12;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const m = ctx.margins;
      if (m && m.stable && Number.isFinite(m.delayMargin_s) && ctx.config.scan_s <= 0.35) {
        mem.delayMargin_s = m.delayMargin_s;
        mem.tightest = Math.min(mem.tightest ?? Infinity, m.delayMargin_s);
      }
      const added = ctx.config.scan_s - 0.2;
      if (Number.isFinite(mem.tightest) && added > mem.tightest && cycling(ctx, 0.55)) {
        mem.predictionHeld = true;
      }
    },
    objectives: [
      obj({
        id: 'read',
        text: 'Identify the process and get a delay margin for your tuning',
        check: (ctx, mem) => !!ctx.model && Number.isFinite(mem.delayMargin_s),
        hint: 'Analysis panel. The delay margin is the phase margin divided by the crossover '
          + 'frequency — it is phase margin expressed in seconds, which is the unit a plant '
          + 'actually argues in.',
      }),
      obj({
        id: 'tighten',
        text: 'Tune until that margin is under 2.5 s',
        check: (ctx, mem) => (mem.tightest ?? 99) < 2.5,
        hint: 'More gain, less reset. Watch the margin fall as you do — this is the same '
          + 'robustness you have been trading all along, priced in seconds.',
      }),
      obj({
        id: 'spend',
        text: 'Add more delay than the margin allows and confirm the loop goes unstable',
        check: (ctx, mem) => mem.predictionHeld === true,
        hint: 'Slow the scan past 0.2 s plus your margin. The prediction is quantitative, so it '
          + 'either holds or the model is wrong.',
      }),
      obj({
        id: 'back',
        mode: OBJ.HOLD,
        hold_s: 25,
        text: 'Put the scan back under 0.3 s and hold setpoint within 0.03 bar',
        check: (ctx) => ctx.config.scan_s <= 0.3 && Math.abs(ctx.err) < 0.03,
      }),
    ],
    debrief: 'Carry the delay margin around with you. It converts a vague argument — "can we put '
      + 'the transmitter on the other side of the exchanger, it is easier to get at" — into '
      + 'arithmetic: the extra delay is the transport time of the fluid between the two points, '
      + 'and either it fits inside the margin or the loop has to be detuned to make room. The '
      + 'same number prices a slower scan, a longer analyser cycle, a filter, and a fieldbus '
      + 'segment somebody wants to load up. And when the margin comes out at half a second, the '
      + 'right conclusion is not that the tuning is clever; it is that this loop has no room left '
      + 'and the next small change anybody makes will be blamed on the tuning.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'INTERACT',
    title: 'Two loops sharing one header',
    minutes: 12,
    blurb: 'Detune the one you care about less. Deciding which that is, is the lesson.',
    brief: [
      'There are two control loops on this header now. The pressure controller is one. The '
        + 'setpoint reset schedule is the other: it measures flow and moves the pressure setpoint, '
        + 'which changes the flow, which moves the setpoint.',
      'That is a loop around a loop, and the schedule as delivered is steep enough for the pair '
        + 'to argue. Widen the span if it does not — spMin down, spMax up — until the header will '
        + 'not settle.',
      'The PID has not been touched and is not the problem. Prove it, then fix the loop that IS '
        + 'the problem.',
    ],
    setup(ctx, api) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.pid.sp = 3.2;
      ctx.plant.demandTarget = 0.55;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      api.setStrategy({
        reset: { enabled: true, spMin_bar: 1.4, spMax_bar: 4.4, qDesign_m3h: 28 },
      });
    },
    track(ctx, mem, dt_s) {
      const r = ctx.stratCfg.reset;
      mem.span = r.spMax_bar - r.spMin_bar;
      if (r.enabled && mem.span >= 2.5 && cycling(ctx, 0.5) && ctx.pidCfg.Kc >= 15) {
        mem.sawTheFight = true;
      }
      if (!r.enabled && ctx.pidCfg.Kc >= 15 && !cycling(ctx, 0.4) && Math.abs(ctx.err) < 0.05) {
        mem.quietAlone_s = (mem.quietAlone_s || 0) + dt_s;
      }
      mem.minKc = Math.min(mem.minKc ?? ctx.pidCfg.Kc, ctx.pidCfg.Kc);
    },
    objectives: [
      obj({
        id: 'fight',
        text: 'Get the pair cycling with a schedule span of 2.5 bar or more',
        check: (ctx, mem) => mem.sawTheFight === true,
        hint: 'Strategy panel. Pull the two schedule limits apart. Leave Kc and Ti alone — the '
          + 'whole claim is that they are innocent.',
      }),
      obj({
        id: 'innocent',
        text: 'Switch the schedule off and show the same tuning is quiet for a full minute',
        check: (ctx, mem) => (mem.quietAlone_s ?? 0) > 60,
        hint: 'Same three numbers, no cycle. That is the evidence, and it is the evidence you '
          + 'need before anybody lets you touch the schedule.',
      }),
      obj({
        id: 'gentle',
        mode: OBJ.HOLD,
        hold_s: 90,
        text: 'Put the schedule back with a span of 1.2 bar or less and stay quiet',
        check: (ctx, mem) => ctx.stratCfg.reset.enabled === true && (mem.span ?? 9) <= 1.2
          && !cycling(ctx, 0.4) && ctx.pidCfg.Kc >= 15,
        hint: 'The schedule keeps most of its energy saving with a much gentler slope. Detune the '
          + 'loop whose job matters least.',
      }),
      obj({
        id: 'wrongloop',
        mode: OBJ.NEVER,
        text: 'Do not fix it by taking the pressure controller\'s gain below 10',
        check: (ctx) => ctx.pidCfg.Kc < 10,
        hint: 'That is detuning the loop you care about most to protect the one you added for '
          + 'convenience. It works, and it is the wrong answer.',
      }),
    ],
    debrief: 'When two loops share a plant, their bandwidths have to be separated or they will '
      + 'trade the disturbance back and forth forever — and the one to slow down is the one whose '
      + 'job you would miss least. Here that is obvious: the pressure loop keeps the plant '
      + 'running and the reset schedule saves electricity, so the schedule gets detuned and the '
      + 'pressure loop keeps its gain. On a real unit the choice is rarely that clean, and the '
      + 'temptation is always to detune whichever loop happens to be in front of you. Ask instead '
      + 'which loop the plant would notice first if it were slower. That question also explains '
      + 'why level loops on surge drums are tuned to be nearly useless on purpose: they are the '
      + 'loop everybody cares about least, and slowing them down is what protects everything '
      + 'downstream.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'ANTISURGE',
    title: 'Ride the limit line, not the cliff',
    minutes: 11,
    blurb: 'A constraint controller has to take over before the machine gets there, not when.',
    brief: [
      'The mechanical recirculation has been isolated, so nothing protects these machines except '
        + 'what you configure. The loop is on flow, and you are about to ask it for less flow '
        + 'than the pump is allowed to make.',
      'First do it with no protection at all and watch the machine go below its minimum '
        + 'continuous flow. That is the cliff.',
      'Then put the minimum-flow override in service. It is a second controller with its own '
        + 'measurement and its own setpoint, and it takes the output away from the flow '
        + 'controller whenever the machine needs it more than the process does.',
    ],
    setup(ctx, api) {
      api.setLoopMode('FLOW');
      ctx.pid.spTarget = 15;
      ctx.pid.sp = 15;
      ctx.pidCfg.Kc = 1.4;
      ctx.pidCfg.Ti = 6;
      ctx.pidCfg.Td = 0;
      ctx.plant.demandTarget = 0.35;
      ctx.plant.recircMode = RECIRC.CLOSED;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      api.setStrategy({ override: { minFlow: { enabled: false, limit_m3h: 11 } } });
      ctx.pid.mode = MODE.AUTO;
    },
    track(ctx, mem, dt_s) {
      const margin = worstFlowMargin(ctx);
      mem.margin = margin;
      const guarded = ctx.stratCfg.override.minFlow.enabled === true;
      if (!guarded && Number.isFinite(margin) && margin < 0 && running(ctx) > 0) {
        mem.below_s = (mem.below_s || 0) + dt_s;
      }
      // Where the constraint controller actually took the output. If it only wins once the
      // machine is already under its limit, the margin is zero and the override is decoration.
      const sel = ctx.stratCfg.override.selected;
      if (sel === 'MIN-FLOW' && mem.lastSel !== 'MIN-FLOW' && Number.isFinite(margin)) {
        mem.takeoverMargin = Math.max(mem.takeoverMargin ?? -Infinity, margin);
      }
      mem.lastSel = sel;
      if (guarded && Number.isFinite(margin) && margin >= 0 && sel === 'MIN-FLOW') {
        mem.guarded_s = (mem.guarded_s || 0) + dt_s;
      }
    },
    objectives: [
      obj({
        id: 'cliff',
        text: 'With no override, run a machine below its minimum continuous flow for 10 s',
        check: (ctx, mem) => (mem.below_s ?? 0) > 10,
        hint: 'Lower the flow setpoint toward 6 m3/h. With the recirculation shut there is '
          + 'nowhere else for the flow to come from.',
      }),
      obj({
        id: 'guard',
        mode: OBJ.HOLD,
        hold_s: 90,
        text: 'Put the override in service and hold the machine safe while asking for less',
        check: (ctx, mem) => ctx.stratCfg.override.minFlow.enabled === true
          && (mem.margin ?? -1) >= 0 && ctx.stratCfg.override.selected === 'MIN-FLOW',
        hint: 'Strategy panel, minimum flow override. Then set a flow setpoint below what it '
          + 'allows and watch the selector report who actually has the output.',
      }),
      obj({
        id: 'margin',
        text: 'Confirm it took over with a margin, not at the limit',
        check: (ctx, mem) => (mem.takeoverMargin ?? -1) > 1.5,
        hint: 'The override is set above the datasheet minimum on purpose. The gap is the '
          + 'distance the machine travels while the controller is still making up its mind.',
      }),
      obj({
        id: 'stop',
        mode: OBJ.NEVER,
        text: 'Do not get the margin by stopping the pump',
        check: (ctx) => running(ctx) === 0,
        hint: 'A stopped machine is safe and useless. The exercise is to keep it running inside '
          + 'its envelope.',
      }),
    ],
    debrief: 'This is anti-surge thinking, and it transfers straight to a compressor. Three '
      + 'things make a constraint controller work and all three are unusual. It has its own '
      + 'measurement and its own setpoint, so it is a real loop and not a trip. It is set with a '
      + 'MARGIN ahead of the physical limit, because the machine keeps moving while the loop '
      + 'responds and the margin is that distance in engineering units. And it is asymmetric: on '
      + 'a compressor the recycle valve opens fast and closes slowly, because opening late '
      + 'destroys the machine and closing early only costs a little power. Note also what did not '
      + 'happen — the flow setpoint was simply not met, and nothing raised an alarm about it. '
      + 'That is correct. When a constraint binds, the process objective is what gives way, and a '
      + 'plant whose operators do not understand that will disable the override the first time it '
      + 'costs them throughput.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'SP_RESET',
    title: 'The economics of setpoint reset',
    minutes: 11,
    blurb: 'The cheapest control improvement on a booster set, and the promise it makes.',
    brief: [
      'The header is being held at 3.2 bar because that is what the design flow needs. The demand '
        + 'is nowhere near design, so most of that pressure is being made and then thrown away '
        + 'across a part-shut valve.',
      'Run at this low demand for two minutes with the schedule off and let the energy meter '
        + 'settle. Then switch the reset schedule on and run the same two minutes again.',
      'The saving is real money. What it costs is a promise about the system, and the last '
        + 'objective is there to stop you making a promise you cannot keep.',
    ],
    setup(ctx, api) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 12;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.pid.sp = 3.2;
      ctx.plant.demandTarget = 0.35;
      ctx.stagingCfg.enabled = true;
      ctx.sq.hand[1] = HAND.AUTO;
      api.setStrategy({
        reset: { enabled: false, spMin_bar: 2.4, spMax_bar: 3.4, qDesign_m3h: 60 },
      });
    },
    track(ctx, mem, dt_s) {
      const on = ctx.stratCfg.reset.enabled === true;
      const key = on ? 'on' : 'off';
      // Only accumulate while the loop is genuinely holding whatever setpoint it has been given.
      // Comparing a settled run against a transient is how energy studies get the answer their
      // author wanted rather than the one the plant would give.
      if (Math.abs(ctx.err) < 0.06 && ctx.plant.Qdemand_m3h > 4) {
        mem[key] = mem[key] || { kWh: 0, m3: 0, s: 0 };
        mem[key].kWh += (ctx.electrical_kW * dt_s) / 3600;
        mem[key].m3 += (ctx.plant.Qdemand_m3h * dt_s) / 3600;
        mem[key].s += dt_s;
        mem[`${key}Q`] = ctx.plant.Qdemand_m3h;
      }
      for (const k of ['on', 'off']) {
        if (mem[k] && mem[k].m3 > 0.05) mem[`${k}Specific`] = mem[k].kWh / mem[k].m3;
      }
      if (mem.onSpecific && mem.offSpecific) {
        mem.saving = 1 - mem.onSpecific / mem.offSpecific;
      }
    },
    objectives: [
      obj({
        id: 'base',
        text: 'Hold the low demand for two minutes with the schedule off',
        check: (ctx, mem) => (mem.off?.s ?? 0) > 120,
      }),
      obj({
        id: 'reset',
        text: 'Switch the schedule on and hold the same demand for two minutes',
        check: (ctx, mem) => (mem.on?.s ?? 0) > 120,
        hint: 'Strategy panel, setpoint reset. The setpoint is no longer yours while it is on — '
          + 'the schedule owns it, and the panel will say so if you try.',
      }),
      obj({
        id: 'saving',
        text: 'Demonstrate at least 10% less energy per cubic metre delivered',
        check: (ctx, mem) => (mem.saving ?? 0) > 0.10,
        hint: 'If the saving is small, the schedule is not asking for much less pressure. Lower '
          + 'the setpoint at zero flow — within reason.',
      }),
      obj({
        id: 'starve',
        mode: OBJ.NEVER,
        text: 'Do not starve the process — no more than a quarter off the delivered flow',
        check: (ctx, mem) => (mem.onQ ?? 0) > 0 && (mem.offQ ?? 0) > 0
          && mem.onQ < mem.offQ * 0.75,
        hint: 'Energy per cubic metre is only an honest number if the cubic metres still turn up. '
          + 'Pull the schedule down far enough and you are saving money by not doing the job.',
      }),
    ],
    debrief: 'Setpoint reset is the largest easy saving on a variable-speed booster set, because '
      + 'the head a system needs falls with the square of flow while a fixed setpoint keeps '
      + 'making the design head all day. But look at what the schedule actually is: an open-loop '
      + 'model of the system curve, with nothing measuring whether the far end of the plant is '
      + 'satisfied. It is a promise that the pipework is what it was when the curve was fitted, '
      + 'and the day somebody commissions a new branch off the header, the promise is void and '
      + 'the first anybody knows is a complaint from the furthest user. The honest version puts a '
      + 'transmitter at the worst-case user and resets the setpoint until that user\'s control '
      + 'valve is nearly wide open — most-open-valve control — which measures the thing the '
      + 'schedule was only guessing at. Start with the schedule because it is free; move to the '
      + 'measurement when the saving is big enough to justify the cable.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'GAIN_SCHED',
    title: 'One tuning for a curved process',
    minutes: 11,
    blurb: 'The gain you measured is only the gain where you measured it.',
    brief: [
      'The controller has been tuned properly — at low demand. Sit there and confirm it: quiet, '
        + 'on setpoint, nothing to complain about.',
      'Now take the demand up to about 75% and watch the same three numbers turn into a different '
        + 'controller. Nothing changed except where on the pump and system curves you are '
        + 'standing.',
      'Then switch the gain schedule on and get both ends behaving at once.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 30;
      ctx.pidCfg.Ti = 9;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.30;
      ctx.stagingCfg.enabled = true;
      ctx.sq.hand[1] = HAND.AUTO;
      ctx.stratCfg.sched.enabled = false;
      ctx.stratCfg.sched.on = SCHED_ON.FLOW;
    },
    track(ctx, mem, dt_s) {
      const x = ctx.plant.fcv.x;
      const quiet = !cycling(ctx, 0.45) && Math.abs(ctx.err) < 0.05;
      if (x <= 0.4 && quiet && ctx.pidCfg.Kc >= 25 && !ctx.stratCfg.sched.enabled) {
        mem.lowQuiet_s = (mem.lowQuiet_s || 0) + dt_s;
      }
      if (x >= 0.65 && cycling(ctx, 0.5) && !ctx.stratCfg.sched.enabled) mem.highCycled = true;
      if (ctx.stratCfg.sched.enabled) {
        if (x <= 0.4 && quiet) mem.schedLow = true;
        if (x >= 0.65 && quiet) mem.schedHigh = true;
      }
    },
    objectives: [
      obj({
        id: 'low',
        text: 'Run a minute quiet and on setpoint at low demand with the delivered tuning',
        check: (ctx, mem) => (mem.lowQuiet_s ?? 0) > 60,
        hint: 'Nothing to do. The demand valve is already down at 30%.',
      }),
      obj({
        id: 'high',
        text: 'Take the demand to 65% or more and make the same tuning cycle',
        check: (ctx, mem) => mem.highCycled === true,
        hint: 'Process panel, demand valve. Give the health window a couple of minutes to call '
          + 'the cycle.',
      }),
      obj({
        id: 'sched',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Enable the schedule and get both ends quiet',
        check: (ctx, mem) => ctx.stratCfg.sched.enabled === true && mem.schedLow === true
          && mem.schedHigh === true && !cycling(ctx, 0.45),
        hint: 'Strategy panel, gain scheduling, on flow. Then visit both operating points again — '
          + 'the objective wants evidence from both ends, not a claim.',
      }),
      obj({
        id: 'alarm',
        mode: OBJ.NEVER,
        text: 'Do not let the header reach its high alarm at 5.4 bar',
        check: (ctx) => ctx.plant.pt_bar > 5.4,
      }),
    ],
    debrief: 'The process gain of a pump on a header is not a constant and never was: the pump '
      + 'curve is flat near shutoff and steep near runout, the system curve is a square law, and '
      + 'the two intersect somewhere different at every demand. One Kc has to cover all of it, '
      + 'and the usual compromise is to tune where the gain is highest and be sluggish everywhere '
      + 'else. Gain scheduling is not adaptive control and does not deserve the suspicion it '
      + 'attracts — it is three tunings and a lookup table, entirely inspectable, and it fails '
      + 'safely because the worst case is that you get one of three tunings you already approved. '
      + 'Schedule on the variable the gain actually varies with, which is almost always a '
      + 'throughput measurement. Never schedule on the error: that is a nonlinear controller '
      + 'pretending to be a table, and nobody will be able to work out what it did afterwards.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'OVERRIDE',
    title: 'The low selector, and its losers',
    minutes: 10,
    blurb: 'Selecting the winner is easy. Keeping the losers ready is the whole job.',
    brief: [
      'Ask this loop for 5.2 bar with nothing protecting the header, and it will go and get it. '
        + 'Note where it ends up.',
      'Now put the maximum-pressure override in service and ask for the same thing. A second '
        + 'controller, with its own measurement and its own setpoint, takes the output away and '
        + 'holds the header at the limit instead.',
      'Then put the setpoint back to 3.2 and watch the handover in the other direction. That '
        + 'handover is where badly built selector schemes announce themselves.',
    ],
    setup(ctx, api) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.pid.sp = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      api.setStrategy({
        override: {
          current: { enabled: false },
          minFlow: { enabled: false },
          maxPressure: { enabled: false, limit_bar: 4.6 },
        },
      });
    },
    track(ctx, mem, dt_s) {
      const o = ctx.stratCfg.override;
      if (!o.maxPressure.enabled) mem.freeMax = Math.max(mem.freeMax ?? 0, ctx.plant.pt_bar);
      const sel = o.selected;
      if (sel !== mem.lastSel) {
        mem.handoverFrom = mem.lastSel;
        mem.handoverTo = sel;
        mem.handoverCo = ctx.co;
        mem.handoverAge_s = 0;
        mem.lastSel = sel;
      } else if (mem.handoverAge_s !== undefined && mem.handoverAge_s < 1.0) {
        mem.handoverAge_s += dt_s;
        const jump = Math.abs(ctx.co - mem.handoverCo);
        // A selector handover should move the output only as fast as the winning controller
        // wants to. A step at the moment of the swap is an untracked integral, every time.
        if (mem.handoverFrom === 'MAX-P' && mem.handoverTo === 'PRIMARY' && jump < 4) {
          mem.cleanHandback = true;
        }
      }
      if (o.maxPressure.enabled && sel === 'MAX-P'
        && Math.abs(ctx.plant.pt_bar - o.maxPressure.limit_bar) < 0.15) {
        mem.atLimit_s = (mem.atLimit_s || 0) + dt_s;
      }
    },
    objectives: [
      obj({
        id: 'free',
        text: 'With no override, drive the header above 5.0 bar',
        check: (ctx, mem) => (mem.freeMax ?? 0) > 5.0,
        hint: 'Raise the setpoint. Nothing is stopping it, which is exactly the problem.',
      }),
      obj({
        id: 'catch',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Enable the maximum-pressure override and sit on its limit instead',
        check: (ctx, mem) => ctx.stratCfg.override.maxPressure.enabled === true
          && ctx.stratCfg.override.selected === 'MAX-P' && (mem.atLimit_s ?? 0) > 0.5,
        hint: 'Strategy panel. Keep asking for 5.2 bar — the primary controller has to be losing '
          + 'for there to be anything to look at.',
      }),
      obj({
        id: 'handback',
        text: 'Bring the setpoint back to normal and hand over to the primary without a bump',
        check: (ctx, mem) => mem.cleanHandback === true,
        hint: 'Watch the output at the instant the selector changes. It should not step. If it '
          + 'does, somebody\'s integral has been drifting while it was not selected.',
      }),
      obj({
        id: 'blow',
        mode: OBJ.NEVER,
        text: 'Do not let the header exceed 5.6 bar at any point',
        check: (ctx) => ctx.plant.pt_bar > 5.6,
        hint: 'The override exists so that this cannot happen. If it happens with the override in '
          + 'service, the override is too slow.',
      }),
    ],
    debrief: 'A selector scheme is two lines of logic and a great deal of care. The two lines '
      + 'pick the lowest output when the constraints can only ask for less, and the highest when '
      + 'they can only ask for more — and a constraint that can do both belongs in a different '
      + 'structure entirely, because a single comparison cannot express it. The care goes into '
      + 'the losers: every controller that was not selected has just spent that time with its '
      + 'measurement uncontrolled and its integral free to wander, so unless each one is preloaded '
      + 'every scan to the output that actually left, the day it finally wins it takes over from '
      + 'wherever it drifted to. That is the bump you were told to look for, and when a plant has '
      + 'an override scheme that everybody leaves switched off, this is nearly always why.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'VELOCITY_FORM',
    title: 'The algorithm that cannot wind up',
    minutes: 10,
    blurb: 'Positional or velocity: the same tuning, a different failure.',
    brief: [
      'The output has been limited to 70% and back-calculation has been switched off, so this is '
        + 'the windup you already know. Push the demand past what 70% can hold, then withdraw it, '
        + 'and count how long the controller ignores you.',
      'Now switch the algorithm to VELOCITY. It computes the CHANGE in output and adds it, which '
        + 'means the output is its own integrator — and an integrator that is clamped at 70% '
        + 'cannot accumulate past 70%. No anti-windup scheme is involved because there is nothing '
        + 'to unwind.',
      'Then transfer it from manual to auto and confirm the other half of the story.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 8;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.outHi = 70;
      ctx.pidCfg.Tt = 1e9;                    // back-calculation effectively disabled
      ctx.pidCfg.algorithm = ALGO.POSITION;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.45;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      // The honest measure of windup: time spent pinned at the high limit while the measurement
      // is ALREADY past setpoint. Every one of those seconds is the controller acting on history
      // instead of on the plant.
      const algo = ctx.pidCfg.algorithm;
      const lagging = ctx.pid.saturated && ctx.err < -0.01;
      const key = `${algo}Lag_s`;
      if (lagging) mem[key] = (mem[key] || 0) + dt_s;
      if (algo === ALGO.VELOCITY) mem.velTime_s = (mem.velTime_s || 0) + dt_s;

      if (ctx.pid.mode !== mem.lastMode) {
        mem.transferFrom = mem.lastMode;
        mem.transferCo = ctx.co;
        mem.transferAge_s = 0;
        mem.lastMode = ctx.pid.mode;
      } else if (mem.transferAge_s !== undefined && mem.transferAge_s < 1.0) {
        mem.transferAge_s += dt_s;
        if (mem.transferFrom === MODE.MAN && ctx.pid.mode === MODE.AUTO
          && algo === ALGO.VELOCITY && Math.abs(ctx.co - mem.transferCo) < 2) {
          mem.bumpless = true;
        }
      }
    },
    objectives: [
      obj({
        id: 'wind',
        text: 'In the positional form, spend 15 s pinned high with the pressure already above '
          + 'setpoint',
        check: (ctx, mem) => (mem[`${ALGO.POSITION}Lag_s`] ?? 0) > 15,
        hint: 'Open the demand valve past what 70% output can hold, leave it a while, then close '
          + 'it again. The lag afterwards is the windup.',
      }),
      obj({
        id: 'velocity',
        mode: OBJ.HOLD,
        hold_s: 45,
        text: 'Repeat it in the velocity form and accumulate almost none of that lag',
        check: (ctx, mem) => ctx.pidCfg.algorithm === ALGO.VELOCITY
          && (mem.velTime_s ?? 0) > 60 && (mem[`${ALGO.VELOCITY}Lag_s`] ?? 0) < 2,
        hint: 'Tuning panel, algorithm. Same three constants, same 70% limit, same upset.',
      }),
      obj({
        id: 'bump',
        text: 'Transfer manual to auto in the velocity form without a bump',
        check: (ctx, mem) => mem.bumpless === true,
        hint: 'Go to MAN, move the output somewhere, then back to AUTO. The output must not step '
          + 'at the transfer.',
      }),
      obj({
        id: 'aw',
        mode: OBJ.NEVER,
        text: 'Do not re-enable back-calculation to get the answer',
        check: (ctx) => Number.isFinite(ctx.pidCfg.Tt) && ctx.pidCfg.Tt < 1e6,
        hint: 'The claim under test is that the velocity form needs none. Give it the chance to '
          + 'be true or false on its own.',
      }),
    ],
    debrief: 'The velocity form gets its immunity honestly: it never holds an integral of its own, '
      + 'so there is nothing to accumulate and nothing to unwind, and every limit applied to the '
      + 'output is automatically a limit on the integral as well. That also explains its two '
      + 'costs. It cannot be preloaded — you cannot put an output there, only add to whatever is '
      + 'there — so bumpless transfer works by arithmetic rather than by assignment, and any '
      + 'scheme that needs to place the output (a selector loser, a cascade slave being '
      + 'initialised, a tracking signal from the field) has to be built differently. And a pure '
      + 'proportional controller cannot be expressed in it at all, because with no integral term '
      + 'the increments have nothing to reference. Most DCS controllers are positional with '
      + 'careful anti-windup; most PLC and drive controllers are velocity, and that is why '
      + 'porting a tuning between them sometimes behaves in a way the numbers do not explain.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'FORM_TRAP',
    title: 'The same three numbers, three different controllers',
    minutes: 9,
    blurb: 'Where a factor of two in gain hides in plain sight.',
    brief: [
      'The faceplate can show this tuning in three forms. Switch between them and watch the '
        + 'numbers change while the loop does not move at all — the algorithm is always the same, '
        + 'and the form is only how the numbers are written down.',
      'Note what the SERIES form shows for Kc. That is the number a Ziegler-Nichols table gives '
        + 'you, because ZN was derived on pneumatic controllers and a pneumatic controller was '
        + 'interacting.',
      'Then type that number into a standard-form controller, which is what everybody does, and '
        + 'watch what you actually built.',
    ],
    setup(ctx) {
      ctx.pidCfg.form = FORM.STANDARD;
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 1.4;
      ctx.pidCfg.N = 10;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      const c = ctx.pidCfg;
      const shown = convertForm(c, FORM.SERIES);
      if (shown.ok && c.form === FORM.SERIES) mem.seriesKc = shown.values[0];

      if (c.form !== mem.lastForm) {
        mem.formChanges = (mem.formChanges || 0) + 1;
        mem.formCo = ctx.co;
        mem.formAge_s = 0;
        mem.lastForm = c.form;
      } else if (mem.formAge_s !== undefined && mem.formAge_s < 1.0) {
        mem.formAge_s += dt_s;
        mem.formJump = Math.max(mem.formJump ?? 0, Math.abs(ctx.co - mem.formCo));
      }
      if (c.form === FORM.STANDARD && Number.isFinite(mem.seriesKc)
        && c.Kc >= mem.seriesKc * 1.5
        && (cycling(ctx, 0.45) || (ctx.diagReport?.reversalsPerMin ?? 0) > 80)) {
        mem.sawTheTrap = true;
      }
    },
    objectives: [
      obj({
        id: 'series',
        text: 'Put the faceplate into series form with a rate time of at least 1 s',
        check: (ctx) => ctx.pidCfg.form === FORM.SERIES && ctx.pidCfg.Td >= 1.0,
        hint: 'Tuning panel, form selector. Note the three numbers it shows you.',
      }),
      obj({
        id: 'same',
        text: 'Switch forms at least twice and confirm the plant never noticed',
        check: (ctx, mem) => (mem.formChanges ?? 0) >= 3 && (mem.formJump ?? 9) < 1.0,
        hint: 'The output must not move at the moment you change the display. If it did, the '
          + 'conversion would be wrong.',
      }),
      obj({
        id: 'trap',
        text: 'Now type the series gain into the standard form and watch it get lively',
        check: (ctx, mem) => mem.sawTheTrap === true,
        hint: 'Back to standard form, then set Kc to at least one and a half times what series '
          + 'was showing. That is the mistake, made deliberately and safely.',
      }),
      obj({
        id: 'back',
        mode: OBJ.HOLD,
        hold_s: 40,
        text: 'Convert them properly and hold setpoint within 0.03 bar again',
        check: (ctx) => Math.abs(ctx.err) < 0.03 && !cycling(ctx, 0.45)
          && ctx.pid.mode === MODE.AUTO,
      }),
    ],
    debrief: 'Three forms, three meanings for the same three symbols, and no way to tell from the '
      + 'numbers alone which one a tuning was written for. Series to standard multiplies the gain '
      + 'and the reset by the same interaction factor and divides the rate by it; parallel to '
      + 'standard divides the integral gain by Kc, which on this rig is a factor of twenty. A '
      + 'tuning table is therefore useless without knowing the form it was derived in, and every '
      + 'classical table — Ziegler-Nichols, Cohen-Coon, most of the ones printed on the back of a '
      + 'controller manual — was derived for the series form because that is what the hardware '
      + 'was in 1942. Whenever a tuning that "worked at the last plant" turns out to be twice as '
      + 'aggressive here, look at the form before you look at the process.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'TRAVEL',
    title: 'The travel budget',
    minutes: 9,
    blurb: 'How tight does this need to be, rather than how tight can it be.',
    brief: [
      'This loop has been tuned to win an IAE competition. It sits beautifully on setpoint and it '
        + 'never stops moving to do it, and every one of those movements is a drive accelerating '
        + 'a wet rotor or a stem dragging through packing.',
      'The loop health panel measures output travel. Look at it per minute, not as a total.',
      'Now get the travel down to something a machine can live with while keeping the error '
        + 'spread inside 1% of span. Both numbers at once, or it does not count.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 40;
      ctx.pidCfg.Ti = 5;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.pvFilter_s = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const r = ctx.diagReport;
      if (!r || !(r.window_min > 1.0)) return;
      mem.travelPerMin = travelPerMin(r);
      mem.peakTravel = Math.max(mem.peakTravel ?? 0, mem.travelPerMin);
      mem.sdPct = r.sdPct;
    },
    objectives: [
      obj({
        id: 'busy',
        text: 'Observe more than 120% of output travel per minute',
        check: (ctx, mem) => (mem.peakTravel ?? 0) > 120,
        hint: 'Nothing to change. Let the health window fill and read the travel against the '
          + 'window length.',
      }),
      obj({
        id: 'calm',
        mode: OBJ.HOLD,
        hold_s: 90,
        text: 'Get travel under 45% a minute AND the error spread under 1% of span, together',
        check: (ctx, mem) => (mem.travelPerMin ?? 999) < 45 && (mem.sdPct ?? 99) < 1.0
          && ctx.pid.mode === MODE.AUTO,
        hint: 'Less gain is the obvious lever and it costs you error. A modest measurement filter '
          + 'is the cheaper one here, because most of that travel is the gain chasing noise.',
      }),
      obj({
        id: 'man',
        mode: OBJ.NEVER,
        text: 'Do not buy the quiet by putting the controller in manual',
        check: (ctx) => ctx.pid.mode === MODE.MAN,
      }),
    ],
    debrief: 'Control performance has two columns and almost every tuning exercise only looks at '
      + 'one. The error column is what the process feels; the travel column is what the machinery '
      + 'feels, and it is paid in packing, seals, bearings, contactors and drive capacitors. A '
      + 'loop that halves its integrated error by doubling its output travel has usually made the '
      + 'plant worse, and nobody will connect the two when the actuator is rebuilt eighteen '
      + 'months later. The right question at the end of a tuning session is not how tight the '
      + 'loop can be made but how tight it needs to be — and for a header that feeds a buffer, '
      + 'the honest answer is usually far looser than the tuning that wins on paper.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'SHARE_LOAD',
    title: 'Two machines that are not the same',
    minutes: 11,
    blurb: 'Common-speed control shares the load only when the machines really do match.',
    brief: [
      'P-102 has been running longer and its impeller has been trimmed on a previous overhaul. It '
        + 'is a smaller machine now, and nothing on the sequence panel knows that.',
      'Run both in parallel on common speed and look at what each one is actually delivering. The '
        + 'speeds are identical. The flows are not, and the weaker machine is the one that ends '
        + 'up near its minimum with all the recirculation heat.',
      'Then get both machines into their envelopes without stopping either one.',
    ],
    setup(ctx, api) {
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.62;
      ctx.stagingCfg.enabled = true;
      ctx.stagingCfg.share = SHARE.COMMON;
      ctx.sq.hand[0] = HAND.AUTO;
      ctx.sq.hand[1] = HAND.AUTO;
      api.setDisturbance({ trim: [1.0, 0.93] });
    },
    track(ctx, mem, dt_s) {
      const q0 = ctx.plant.Q_m3h[0];
      const q1 = ctx.plant.Q_m3h[1];
      const both = ctx.plant.drv[0].n_pct > 5 && ctx.plant.drv[1].n_pct > 5;
      if (!both) { mem.bothRunning = false; return; }
      mem.bothRunning = true;
      const big = Math.max(q0, q1);
      const small = Math.min(q0, q1);
      mem.split = big > 0 ? (big - small) / big : 0;
      mem.worstSplit = Math.max(mem.worstSplit ?? 0, mem.split);
      if (big > 0 && small < 0.7 * big) mem.thin_s = (mem.thin_s || 0) + dt_s;
      mem.margin = worstFlowMargin(ctx);
    },
    objectives: [
      obj({
        id: 'split',
        text: 'With both machines on common speed, see more than 18% difference in their flows',
        check: (ctx, mem) => (mem.worstSplit ?? 0) > 0.18,
        hint: 'Both machines have to be on line. The machine cards show what each one is passing.',
      }),
      obj({
        id: 'thin',
        text: 'Watch the weaker machine sit under 70% of the stronger one\'s flow for 20 s',
        check: (ctx, mem) => (mem.thin_s ?? 0) > 20,
        hint: 'Identical speeds, identical discharge header, different pumps. The head-flow curve '
          + 'decides the split and nothing else gets a vote.',
      }),
      obj({
        id: 'fix',
        mode: OBJ.HOLD,
        hold_s: 120,
        text: 'Put the set on base-plus-trim, keep both machines above minimum flow, and hold '
          + 'setpoint within 0.06 bar',
        check: (ctx, mem) => ctx.stagingCfg.share === SHARE.BASE_TRIM
          && mem.bothRunning === true && (mem.margin ?? -1) >= 0
          && Math.abs(ctx.err) < 0.06,
        hint: 'Sequence panel, output distribution. The lag machine takes a fixed speed and the '
          + 'lead does the modulating, so the split stops being an accident of the curves.',
      }),
      obj({
        id: 'giveup',
        mode: OBJ.NEVER,
        text: 'Do not solve it by stopping a machine',
        check: (ctx) => running(ctx) < 2 && ctx.plant.demandTarget > 0.55,
        hint: 'At this demand one machine cannot hold the header. Stopping the weak one moves the '
          + 'problem to the pressure loop.',
      }),
    ],
    debrief: 'Two identical pumps on a common header share load by construction: same speed, same '
      + 'curve, same head, so the same flow, and nothing has to be controlled to make it happen. '
      + 'The moment they stop being identical — a trimmed impeller, a worn wear ring, a different '
      + 'suction line, one machine bought eight years later — the head they can each make at a '
      + 'given speed differs, and the header decides the split without consulting anybody. The '
      + 'weak machine runs thin, takes the recirculation duty, heats up, and wears faster, which '
      + 'makes it weaker still. Common-speed control is not a default; it is a statement about '
      + 'the machinery. Base-plus-trim is the admission that the statement is no longer true, and '
      + 'the day you find yourself configuring it is the day to also ask when that impeller is '
      + 'due to be replaced.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'HARRIS',
    title: 'Knowing when to stop',
    minutes: 10,
    blurb: 'How much of the remaining variance is yours, and how much is the plant\'s.',
    brief: [
      'Every loop has a floor. Given its dead time, there is a minimum error variance that no '
        + 'controller of any kind could beat, because for one dead time after any disturbance '
        + 'nothing you do has reached the measurement yet.',
      'The Harris index is your variance measured against that floor. An index near zero means '
        + 'there is a great deal of performance still on the table. An index near one means the '
        + 'controller has taken nearly everything there is to take, and the remaining wander is '
        + 'the process and the instrument.',
      'Get it above 0.6 and then stop, deliberately, with the travel still reasonable.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 10;
      ctx.pidCfg.Ti = 30;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.pvFilter_s = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem) {
      const r = ctx.diagReport;
      if (!r || r.harrisOk !== true || !Number.isFinite(r.harris)) return;
      mem.harris = r.harris;
      mem.bestHarris = Math.max(mem.bestHarris ?? 0, r.harris);
      mem.reversals = r.reversalsPerMin;
    },
    objectives: [
      obj({
        id: 'read',
        text: 'Get a Harris index reported at all',
        check: (ctx, mem) => Number.isFinite(mem.harris),
        hint: 'The estimator needs several minutes of history and a loop that is actually doing '
          + 'something. It refuses to guess.',
      }),
      obj({
        id: 'sluggish',
        text: 'Confirm the delivered tuning is leaving performance on the table — index below 0.3',
        check: (ctx, mem) => Number.isFinite(mem.harris) && mem.harris < 0.3,
        hint: 'Nothing to change yet. Kc 10 with a 30 s reset is a genuinely sluggish loop and '
          + 'the index is meant to say so.',
      }),
      obj({
        id: 'push',
        text: 'Tune until the index is above 0.6',
        check: (ctx, mem) => (mem.bestHarris ?? 0) > 0.6,
        hint: 'More gain, shorter reset. Watch the index rather than the trend — a trend at this '
          + 'timescale is very good at flattering a tuning.',
      }),
      obj({
        id: 'stop',
        mode: OBJ.HOLD,
        hold_s: 90,
        text: 'Hold it there with fewer than 45 output reversals a minute and no cycle',
        check: (ctx, mem) => (mem.harris ?? 0) > 0.6 && (mem.reversals ?? 999) < 45
          && !cycling(ctx, 0.45),
        hint: 'This is the objective the lesson is actually about: stopping while you are ahead.',
      }),
      obj({
        id: 'chase',
        mode: OBJ.NEVER,
        text: 'Do not chase a higher index into an oscillation',
        check: (ctx) => cycling(ctx, 0.7),
        hint: 'A cycling loop can score respectably on variance for a while and it is not a good '
          + 'loop. The index is a benchmark, not a target to be maximised.',
      }),
    ],
    debrief: 'The Harris index answers the question every tuning session eventually reaches and '
      + 'almost nobody asks out loud: is there anything left to get? A low index says yes, and '
      + 'the next hour at the keyboard is worth spending. A high index says no, and everything '
      + 'you do from here buys travel and risk instead of performance — the remaining variance '
      + 'belongs to the dead time, the transmitter and the process itself, and the next real '
      + 'improvement is a work order. That distinction is the whole of loop performance '
      + 'monitoring, and it is why a plant with a thousand loops ranks them by achievable '
      + 'improvement rather than by error: the loops worth visiting are the ones with a low index '
      + 'and a large variance, and there are usually about thirty of them.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'COMMISSION',
    title: 'Commission the station',
    minutes: 25,
    blurb: 'Cold start. Nothing running, nothing tuned, nothing measured. Do the whole job.',
    brief: [
      'The station is dead. Both machines are off, the controller is in manual at zero, and the '
        + 'tuning in it is the number the vendor ships, which is to say a number that has never '
        + 'met this plant.',
      'Commission it. There is an order to this and the order is the lesson: machinery first, '
        + 'then a loop that is merely stable, then a measurement of the process, then a tuning '
        + 'you chose on purpose, then the sequence, and last a test you did not design the tuning '
        + 'for.',
      'Nothing may be damaged on the way. A commissioning that cavitates a pump has not '
        + 'commissioned anything.',
    ],
    setup(ctx) {
      ctx.pid.mode = MODE.MAN;
      ctx.pid.coMan = 0;
      ctx.pidCfg.Kc = 2;
      ctx.pidCfg.Ti = 400;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.N = 10;
      ctx.pidCfg.b = 1;
      ctx.pidCfg.pvFilter_s = 0;
      ctx.pidCfg.spRate = 0;
      ctx.pid.spTarget = 3.2;
      ctx.pid.sp = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.plant.recircMode = RECIRC.ARV;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[0] = HAND.OFF;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      if (running(ctx) > 0 && ctx.plant.Qdemand_m3h > 5) mem.delivering = true;
      if (ctx.margins?.stable) mem.ms = ctx.margins.ms;
      if (ctx.lastResult) mem.result = ctx.lastResult;
      // Damage is cumulative and it is counted across the whole exercise, not per attempt.
      let cav = false;
      for (let i = 0; i < ctx.plant.cav.length; i += 1) {
        if (ctx.plant.drv[i].n_pct > 5 && ctx.plant.cav[i] < 0.999) cav = true;
      }
      if (cav) mem.cav_s = (mem.cav_s || 0) + dt_s;
      if (running(ctx) > 0 && worstFlowMargin(ctx) < 0) {
        mem.thin_s = (mem.thin_s || 0) + dt_s;
      }
    },
    objectives: [
      obj({
        id: 'running',
        text: 'Get a machine running and delivering to process',
        check: (ctx, mem) => mem.delivering === true,
        hint: 'Machine cards, start P-101. Then give it something to do with the output.',
      }),
      obj({
        id: 'auto',
        mode: OBJ.HOLD,
        hold_s: 45,
        text: 'Get to AUTO and hold 3.2 bar within 0.06 bar — stable, not good',
        check: (ctx) => ctx.pid.mode === MODE.AUTO && Math.abs(ctx.err) < 0.06,
        hint: 'A conservative tuning is enough here. You are buying yourself a stable loop to run '
          + 'the identification from, nothing more.',
      }),
      obj({
        id: 'model',
        text: 'Measure the process and get a model with usable margins',
        check: (ctx) => !!ctx.model && ctx.margins?.stable === true,
        hint: 'Relay first if you want it quick, step test if you want a model. The rest of the '
          + 'commissioning needs the model.',
      }),
      obj({
        id: 'tuned',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Apply a tuning from the ranked table and hold within 0.03 bar with Ms of 1.9 or '
          + 'better',
        check: (ctx, mem) => ctx.appliedRuleId != null && Math.abs(ctx.err) < 0.03
          && (mem.ms ?? 9) <= 1.9,
        hint: 'Pick a rule, look at what it predicts, and apply it. Choosing on purpose is the '
          + 'part that separates this from turning knobs.',
      }),
      obj({
        id: 'staged',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Put the sequence in service with both machines available',
        check: (ctx) => ctx.stagingCfg.enabled === true && ctx.sq.hand[0] === HAND.AUTO
          && ctx.sq.hand[1] === HAND.AUTO,
        hint: 'A single machine on a header is not a station. The standby has to be in AUTO or '
          + 'the sequence has nothing to promote.',
      }),
      obj({
        id: 'shift',
        text: 'Score 70 or better on the shift duty cycle',
        check: (ctx, mem) => mem.result && mem.result.scenario === 'Shift duty cycle'
          && mem.result.score >= 70,
        hint: 'Scenario runner, DUTY. This is the acceptance test, and it is deliberately not one '
          + 'of the disturbances you tuned against.',
      }),
      obj({
        id: 'damage',
        mode: OBJ.NEVER,
        text: 'Do not cavitate or run a machine thin for more than 20 s in total',
        check: (ctx, mem) => (mem.cav_s ?? 0) + (mem.thin_s ?? 0) > 20,
        hint: 'The counter runs for the whole exercise. A commissioning is judged on the state '
          + 'the plant is handed over in.',
      }),
    ],
    debrief: 'That order is not a preference, it is a dependency graph. You cannot tune a loop '
      + 'you have not measured; you cannot measure a process from a controller that is not '
      + 'stable; you cannot make it stable without machinery running; and you cannot claim any of '
      + 'it works until something you did not design for has been thrown at it. Every '
      + 'commissioning that goes badly has skipped a step in that list, usually the measurement, '
      + 'and usually because somebody already had a number from a similar plant. The other half '
      + 'of the job is the one the damage counter was watching: a loop that holds setpoint '
      + 'beautifully while cavitating an impeller has not been commissioned, it has been '
      + 'demonstrated. Hand the plant over in the state you would want to inherit it.',
  },
]);

/**
 * Merge this curriculum onto an existing lesson table, refusing rather than silently shadowing if
 * any id collides.
 *
 * The runner looks lessons up by id, so two lessons sharing one id is not a cosmetic problem: the
 * second becomes unreachable, its progress records collide with the first's, and the failure
 * shows up as a lesson that will not start with no explanation of why.
 *
 * @param {object[]} [base=LESSONS] the table to extend, defaulting to the shipped fourteen
 * @returns {{ok:boolean, reason?:string, lessons?:object[]}} the merged table, frozen
 */
export function mergeCurriculum(base = LESSONS) {
  if (!Array.isArray(base)) return { ok: false, reason: 'the base curriculum must be an array' };
  const seen = new Set();
  for (const l of base) {
    if (seen.has(l.id)) return { ok: false, reason: `the base table already repeats id ${l.id}` };
    seen.add(l.id);
  }
  for (const l of CURRICULUM) {
    if (seen.has(l.id)) return { ok: false, reason: `lesson id ${l.id} already exists` };
    seen.add(l.id);
  }
  return { ok: true, lessons: Object.freeze([...base, ...CURRICULUM]) };
}

/**
 * The pressure a head represents in this rig's liquid — used where an objective wants to quote a
 * head in the unit the operator's panel is showing.
 * @param {number} h_m head, m
 * @param {number} rho_kgm3 density, kg/m3
 * @returns {number} pressure, bar
 */
export function headToBar(h_m, rho_kgm3) {
  return (h_m * rho_kgm3 * G) / 1e5;
}
