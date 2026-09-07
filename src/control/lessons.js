/**
 * src/control/lessons.js — the guided curriculum: a sequence of exercises that arrange the rig
 * into a situation, state what has to be achieved, and watch until it is.
 *
 * Layer L3: imports `core/util.js` and the control modules whose settings the lessons arrange.
 * No DOM. The runner is handed a context object assembled by the sim each scan.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT A LESSON IS FOR
 *
 * A simulator with every knob exposed and no direction teaches almost nothing, because the thing
 * that has to be learned is not what the knobs do — that is in the manual — but WHICH ONE to
 * reach for when the plant is behaving in a particular way. That skill is built by seeing a
 * specific misbehaviour, forming a hypothesis, changing one thing, and being right or wrong
 * quickly.
 *
 * So every lesson here has the same shape. It sets the rig up so that a particular failure is
 * unavoidable. It says what "fixed" means in numbers, not adjectives. It watches continuously
 * and tells you the moment each objective is met. And it ends with the thing that was actually
 * being taught, which is usually not what the objectives were measuring.
 *
 * The objectives deliberately include ones you cannot satisfy by turning the gain up. Several
 * lessons cannot be passed by tuning at all, because the answer is a different control structure
 * or a maintenance ticket, and learning to recognise those is most of the job.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { MODE } from './pid.js';
import { STRUCTURE, SCHED_ON } from './strategy.js';
import { CRITERION, SHARE, HAND } from './staging.js';
import { RECIRC, FINAL } from '../process/plant.js';

/**
 * How an objective is judged.
 */
export const OBJ = Object.freeze({
  /** Latches the first time the check passes. */
  ONCE: 'ONCE',
  /** Must pass continuously for `hold_s`. */
  HOLD: 'HOLD',
  /** Fails the lesson if it ever passes. A trap. */
  NEVER: 'NEVER',
});

/**
 * Build one objective record.
 * @param {object} o the objective fields
 * @returns {object} the objective
 */
function obj(o) {
  return { mode: OBJ.ONCE, hold_s: 0, hint: '', ...o };
}

/**
 * The curriculum, in the order it should be taken.
 *
 * Each lesson's `setup` receives the whole sim context and arranges the rig. Each objective's
 * `check` receives the same context every scan and returns a boolean. `track` is optional and
 * maintains a per-lesson memory object for objectives that need history rather than a snapshot.
 */
export const LESSONS = Object.freeze([
  // -----------------------------------------------------------------------------------------
  {
    id: 'FEEL',
    title: 'Feel the process',
    minutes: 4,
    blurb: 'Before tuning anything, find out what you are tuning.',
    brief: [
      'The controller is in MANUAL. Nothing is being corrected: whatever you set the output to '
        + 'is what the drives get, and the header does what physics says.',
      'Move the output around — try 30%, then 50%, then 70% — and watch two things. How far does '
        + 'the pressure move for each 10% of output? And how long does it take to get there?',
      'Those two numbers are the process gain and the process time constant, and every tuning '
        + 'rule ever published is a formula for turning them into a Kc and a Ti.',
    ],
    setup(ctx) {
      ctx.pid.mode = MODE.MAN;
      ctx.pid.coMan = 40;
      ctx.plant.demandTarget = 0.45;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      if (!mem.visited) mem.visited = new Set();
      if (ctx.pid.mode === MODE.MAN) {
        // A "visit" is a settled operating point, not a value the output swept through.
        if (Math.abs(ctx.co - (mem.lastCo ?? ctx.co)) < 0.2) mem.dwell_s = (mem.dwell_s || 0) + dt_s;
        else mem.dwell_s = 0;
        mem.lastCo = ctx.co;
        if (mem.dwell_s > 12) mem.visited.add(Math.round(ctx.co / 10) * 10);
      }
      // Track the widest pressure excursion so the gain can be estimated.
      mem.pMin = Math.min(mem.pMin ?? ctx.pv, ctx.pv);
      mem.pMax = Math.max(mem.pMax ?? ctx.pv, ctx.pv);
    },
    objectives: [
      obj({
        id: 'three',
        text: 'Hold three different output settings, at least 10% apart, for 12 s each',
        check: (ctx, mem) => (mem.visited ? mem.visited.size >= 3 : false),
        hint: 'Set the output, then leave it alone long enough for the header to finish moving.',
      }),
      obj({
        id: 'span',
        text: 'Cover at least 1.0 bar of header pressure between them',
        check: (ctx, mem) => (mem.pMax ?? 0) - (mem.pMin ?? 0) >= 1.0,
        hint: 'Go further apart — try 30% and 75%.',
      }),
    ],
    debrief: 'The gain you just measured is not a constant. Do the same experiment with the '
      + 'demand valve at 20% and again at 80% and you will get two different answers, because '
      + 'the pump curve is not a straight line and neither is the system curve. That single fact '
      + 'is why one set of tuning constants cannot be right everywhere, and it is what gain '
      + 'scheduling exists to deal with.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'PONLY',
    title: 'Proportional only, and the offset it leaves',
    minutes: 5,
    blurb: 'Why every industrial controller has an integral term.',
    brief: [
      'Reset has been switched off — Ti is infinite. The controller is now pure proportional: '
        + 'output equals bias plus gain times error, and nothing else.',
      'Put it in AUTO and watch where it settles. It will not settle ON setpoint. It cannot: the '
        + 'only way this controller produces any output at all is to have an error, so it has to '
        + 'keep one.',
      'Now raise the gain. The offset gets smaller — and the loop gets twitchier. Find the point '
        + 'where that trade stops being worth it.',
    ],
    setup(ctx) {
      ctx.pidCfg.Ti = Infinity;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.Kc = 8;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.55;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      if (Math.abs(ctx.err) < (mem.lastErrMag ?? Infinity)) mem.lastErrMag = Math.abs(ctx.err);
      mem.steady_s = Math.abs(ctx.dPv) < 0.002 ? (mem.steady_s || 0) + dt_s : 0;
      if (mem.steady_s > 15) mem.offset = Math.abs(ctx.err);
      mem.maxKc = Math.max(mem.maxKc ?? 0, ctx.pidCfg.Kc);
    },
    objectives: [
      obj({
        id: 'offset',
        text: 'Settle out and observe a steady offset the controller will not remove',
        check: (ctx, mem) => (mem.offset ?? 0) > 0.005 && (mem.steady_s ?? 0) > 15,
        hint: 'Go to AUTO and leave it. "Settled" means the pressure has genuinely stopped moving.',
      }),
      obj({
        id: 'shrink',
        text: 'Raise Kc to at least 25 and get the offset below 0.05 bar',
        check: (ctx, mem) => ctx.pidCfg.Kc >= 25 && (mem.offset ?? 9) < 0.05,
        hint: 'More gain, less offset. The relationship is offset = error needed to make the '
          + 'output the process requires.',
      }),
      obj({
        id: 'nocycle',
        mode: OBJ.NEVER,
        text: 'Do not let it break into a sustained oscillation',
        check: (ctx) => ctx.diagReport?.oscillating === true && ctx.diagReport.strength > 0.7,
        hint: 'You have gone past the point where more gain helps.',
      }),
    ],
    debrief: 'The offset is not a defect in proportional control; it is the definition of it. '
      + 'Output is proportional to error, so zero error means zero output, and a pump at zero '
      + 'speed does not hold 3.2 bar. Integral action fixes it by adding a term that keeps '
      + 'moving as long as any error remains — which is also exactly why integral action winds '
      + 'up when the output is stuck at a limit, and that is the next lesson but one.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'RESET',
    title: 'Adding reset',
    minutes: 6,
    blurb: 'Integral action removes the offset and costs you stability. Find the balance.',
    brief: [
      'Reset is back on. Ti is in seconds per repeat: the time the integral term takes to repeat '
        + 'what proportional did on its own. Small Ti is strong reset.',
      'Your job is a setpoint step that settles quickly with no more than 10% overshoot, and no '
        + 'offset once it gets there.',
      'Start with Ti around 15 s and work down. Watch what happens as you approach the point '
        + 'where the loop starts ringing — that is reset fighting the process dead time.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 30;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.0;
      ctx.plant.demandTarget = 0.55;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      mem.settled_s = Math.abs(ctx.err) < 0.02 ? (mem.settled_s || 0) + dt_s : 0;
      const step = ctx.score.steps.filter((s) => s.kind === 'servo');
      if (step.length) mem.lastServo = step[step.length - 1];
    },
    objectives: [
      obj({
        id: 'step',
        text: 'Make a setpoint step of at least 0.3 bar',
        check: (ctx, mem) => !!mem.lastServo,
        hint: 'Change the setpoint. Use the scenario runner\'s setpoint step if you prefer.',
      }),
      obj({
        id: 'overshoot',
        text: 'Overshoot no more than 10% on that step',
        check: (ctx, mem) => mem.lastServo && mem.lastServo.overshootPct <= 10,
        hint: 'Too much overshoot means too much gain, or reset that is too fast for the dead time.',
      }),
      obj({
        id: 'zero',
        mode: OBJ.HOLD,
        hold_s: 25,
        text: 'Hold within 0.02 bar of setpoint for 25 s',
        check: (ctx) => Math.abs(ctx.err) < 0.02,
        hint: 'Reset should take the offset out entirely. If it does not, Ti is far too long.',
      }),
    ],
    debrief: 'Notice what reset did to the phase of the loop: it added lag, exactly where you '
      + 'could least afford it. Proportional gain and reset are not independent knobs — every '
      + 'published tuning rule pairs them, and Ti is always quoted as a fraction of the process '
      + 'time constant or the ultimate period rather than as a number on its own.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'IDENTIFY',
    title: 'Identify the process',
    minutes: 8,
    blurb: 'Two ways to measure a process, and what each one can and cannot tell you.',
    brief: [
      'You have tuned by feel. Now measure instead.',
      'Run the RELAY autotune first. It puts the loop into a controlled limit cycle at the '
        + 'frequency where the phase reaches 180 degrees, and gives you the ultimate gain and '
        + 'period — everything the classical rule table needs, and nothing else.',
      'Then run the STEP test. It opens the loop, bumps the output once, and fits a first-order-'
        + 'plus-dead-time model. That model is what lets you draw a Bode plot, predict a step '
        + 'response, and use lambda or SIMC tuning.',
      'Compare what each test cost you in disturbance, and what each one bought.',
    ],
    setup(ctx) {
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    objectives: [
      obj({
        id: 'relay',
        text: 'Complete a relay autotune',
        check: (ctx) => ctx.autotune.phase === 'DONE' && ctx.autotune.Ku > 0,
        hint: 'Analysis panel, RELAY AUTOTUNE. It needs the loop sitting on setpoint first.',
      }),
      obj({
        id: 'steptest',
        text: 'Complete an open-loop step test and get a model',
        check: (ctx) => ctx.stepTest.phase === 'DONE' && !!ctx.stepTest.model,
        hint: 'Analysis panel, STEP TEST. It will refuse to start until the process is genuinely '
          + 'at rest, which is the point.',
      }),
      obj({
        id: 'apply',
        text: 'Apply one of the model-based tunings and hold setpoint with it',
        mode: OBJ.HOLD,
        hold_s: 30,
        check: (ctx) => Math.abs(ctx.err) < 0.03 && ctx.pid.mode === MODE.AUTO
          && ctx.appliedRuleId != null,
        hint: 'Pick a rule from the ranked table and press APPLY.',
      }),
    ],
    debrief: 'The relay test is safe and quick and gives you two numbers. The step test is '
      + 'disruptive and slow and gives you a model. On a plant you would use the relay for a loop '
      + 'you just need working, and the step test for a loop you need to understand — a slow one, '
      + 'an interacting one, or one where you are about to argue with someone about whether it '
      + 'can be made faster at all.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'WINDUP',
    title: 'Reset windup',
    minutes: 6,
    blurb: 'What happens when the controller asks for more than the plant can give.',
    brief: [
      'Anti-windup has been switched OFF and the output limited to 70%. The demand valve is about '
        + 'to open beyond what one pump at 70% can hold.',
      'Watch the integral term while the output is pinned. The error will not go away, so the '
        + 'integral keeps accumulating — into a number the output cannot express.',
      'Then close the demand valve back down and watch how long the loop takes to notice. That '
        + 'delay is the accumulated integral being unwound, and during it the controller is '
        + 'ignoring you.',
      'Turn anti-windup back on and repeat. Same disturbance, completely different recovery.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 8;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.outHi = 70;
      ctx.pidCfg.Tt = 1e9;      // effectively disables back-calculation
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.45;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      if (ctx.pid.saturated) mem.satTime_s = (mem.satTime_s || 0) + dt_s;
      mem.maxInteg = Math.max(mem.maxInteg ?? 0, ctx.pid.integ);
      if (ctx.pidCfg.Tt !== null && ctx.pidCfg.Tt < 1e6) mem.awOn = true;
      // Recovery time: from the moment the error changes sign after saturation, to the moment
      // the output comes off its limit.
      if (mem.satTime_s > 5 && !ctx.pid.saturated && mem.recover_s === undefined) {
        mem.recover_s = 0;
      }
    },
    objectives: [
      obj({
        id: 'wind',
        text: 'Drive the output into its limit and hold it there for 30 s',
        check: (ctx, mem) => (mem.satTime_s ?? 0) > 30,
        hint: 'Open the demand valve past what a single pump at 70% output can supply.',
      }),
      obj({
        id: 'observe',
        text: 'Observe the integral term wound past the output limit',
        check: (ctx, mem) => (mem.maxInteg ?? 0) > 85,
        hint: 'The integral is displayed in the controller faceplate. With anti-windup off it '
          + 'is not bounded by the output limit at all.',
      }),
      obj({
        id: 'fix',
        text: 'Re-enable back-calculation anti-windup and recover cleanly',
        mode: OBJ.HOLD,
        hold_s: 20,
        check: (ctx, mem) => mem.awOn && !ctx.pid.saturated && Math.abs(ctx.err) < 0.03,
        hint: 'Set Tt back to null so it follows Ti, then repeat the upset.',
      }),
    ],
    debrief: 'Windup is not caused by the integral term. It is caused by the controller and the '
      + 'plant disagreeing about what the output is, and the fix is to tell the controller the '
      + 'truth. Back-calculation does that by feeding the difference between the demanded and the '
      + 'actual output back into the integrator. The same mechanism is what makes mode switches '
      + 'bumpless and what lets an override selector work — one algorithm, three uses.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'NOISE',
    title: 'Derivative and noise',
    minutes: 5,
    blurb: 'Rate action is a microphone pointed at your instrument.',
    brief: [
      'The pressure transmitter has been given a realistic amount of noise, and derivative action '
        + 'has been switched on with the filter wide open (N = 100).',
      'Watch the controller output. The process is quiet; the output is not. Derivative amplifies '
        + 'high frequencies by definition, and measurement noise is nothing but high frequencies.',
      'Bring N down toward 5 and watch the output settle. Then ask whether the derivative is '
        + 'buying you anything at all on this loop.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 20;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 2.5;
      ctx.pidCfg.N = 100;
      ctx.pidCfg.outHi = 100;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    objectives: [
      obj({
        id: 'chatter',
        text: 'Observe more than 120 output reversals a minute',
        check: (ctx) => (ctx.diagReport?.reversalsPerMin ?? 0) > 120,
        hint: 'Let the diagnostics window fill. The reversal count is on the loop health panel.',
      }),
      obj({
        id: 'filter',
        text: 'Get the reversals below 40 a minute without removing derivative entirely',
        check: (ctx) => (ctx.diagReport?.reversalsPerMin ?? 999) < 40 && ctx.pidCfg.Td > 0.3
          && (ctx.pidCfg.N < 40 || ctx.pidCfg.pvFilter_s > 0.3),
        hint: 'Lower N — that moves the derivative roll-off down in frequency. A PV filter helps too.',
      }),
      obj({
        id: 'still',
        mode: OBJ.HOLD,
        hold_s: 30,
        text: 'Still hold setpoint within 0.03 bar afterwards',
        check: (ctx) => Math.abs(ctx.err) < 0.03,
      }),
    ],
    debrief: 'Fewer than one industrial loop in ten runs with derivative action, and this is why. '
      + 'It helps on genuinely lag-dominant processes with clean measurements — temperature, '
      + 'mostly — and it hurts everywhere else. On a pressure loop with a noisy transmitter and a '
      + 'variable-speed drive that has to physically move, the honest answer is usually Td = 0.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'STAGING',
    title: 'Make the set short-cycle, then stop it',
    minutes: 8,
    blurb: 'The continuous loop and the discrete sequence have to agree.',
    brief: [
      'The staging hysteresis band has been deliberately narrowed: stage up at 70% output, down '
        + 'at 62%, with four-second delays and no staging bias.',
      'Push the demand up until the lag pump starts. When it does, two machines arrive on a '
        + 'header that one was nearly holding — the output collapses, the stage-down threshold '
        + 'trips, the pump stops, and it all happens again.',
      'Your job is to stop it without switching staging off, and without making the set slow to '
        + 'respond. Every start you save is a starter contactor that lasts another year.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 10;
      ctx.pidCfg.Td = 0;
      ctx.pidCfg.outHi = 100;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.stagingCfg.enabled = true;
      ctx.stagingCfg.criterion = CRITERION.OUTPUT;
      ctx.stagingCfg.stageUp_pct = 70;
      ctx.stagingCfg.stageDown_pct = 62;
      ctx.stagingCfg.stageUpDelay_s = 4;
      ctx.stagingCfg.stageDownDelay_s = 4;
      ctx.stagingCfg.stageUpBias = 1;
      ctx.stagingCfg.stageDownBias = 1;
      ctx.stagingCfg.minRun_s = 5;
      ctx.stagingCfg.minStop_s = 5;
      ctx.sq.hand[1] = HAND.AUTO;
      ctx.plant.demandTarget = 0.74;
    },
    track(ctx, mem, dt_s) {
      mem.t_s = (mem.t_s || 0) + dt_s;
      if (mem.startsAt === undefined) mem.startsAt = totalStarts(ctx.sq);
      const now = totalStarts(ctx.sq);
      if (now - (mem.lastStarts ?? mem.startsAt) > 0) {
        mem.recent = (mem.recent || []).filter((t) => mem.t_s - t < 300);
        mem.recent.push(mem.t_s);
      }
      mem.lastStarts = now;
      mem.cycleRate = ((mem.recent || []).length) * (3600 / 300);
      mem.peak = Math.max(mem.peak ?? 0, mem.cycleRate);
      // Steady period: both pumps settled, nothing has started for a while.
      mem.quiet_s = (mem.recent || []).length === 0 || mem.t_s - mem.recent[mem.recent.length - 1] > 1
        ? (mem.quiet_s || 0) + dt_s : 0;
    },
    objectives: [
      obj({
        id: 'provoke',
        text: 'Provoke short-cycling: more than 12 starts an hour',
        check: (ctx, mem) => (mem.peak ?? 0) > 12,
        hint: 'Sit the demand right at the point where one pump is marginal.',
      }),
      obj({
        id: 'fix',
        mode: OBJ.HOLD,
        hold_s: 180,
        text: 'Then run 3 minutes at the same demand with no start at all',
        check: (ctx, mem) => (mem.quiet_s ?? 0) > 0.5 && ctx.stagingCfg.enabled,
        hint: 'Widen the gap between the thresholds, lengthen the delays, and put the staging '
          + 'bias back. All three do different things.',
      }),
      obj({
        id: 'usable',
        text: 'Keep the pressure within 0.15 bar of setpoint while you do it',
        mode: OBJ.HOLD,
        hold_s: 120,
        check: (ctx) => Math.abs(ctx.err) < 0.15,
        hint: 'Switching staging off is not a fix — you would never hold setpoint at high demand.',
      }),
    ],
    debrief: 'The staging bias is the interesting one. Widening the thresholds and lengthening '
      + 'the delays both work by making the sequence slower to react, and both cost you response. '
      + 'The bias works by removing the disturbance instead: it tells the controller in advance '
      + 'that the plant it is driving just changed, so the loop never has to discover it the hard '
      + 'way. That is feedforward, applied to a discrete event.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'NPSH',
    title: 'Losing suction',
    minutes: 7,
    blurb: 'The failure that is not a control problem, and cannot be tuned away.',
    brief: [
      'The make-up supply has been isolated and the tank contents are being warmed. The level '
        + 'falls and the vapour pressure rises at the same time, and both of them eat the same '
        + 'number: the net positive suction head available.',
      'Keep the process supplied for as long as you can. Watch the NPSH margin trace, not the '
        + 'pressure — by the time the pressure tells you something is wrong, the impeller has '
        + 'already been taking damage for a while.',
      'When the margin goes, notice what the controller does about it. It will ask for more speed, '
        + 'because that is what a pressure controller does when the pressure falls. More speed '
        + 'raises NPSH required. The loop makes it worse.',
    ],
    setup(ctx) {
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 10;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.62;
      ctx.plant.makeupAuto = false;
      ctx.plant.Tsupply_C = 92;
      ctx.plant.T_tank_C = Math.max(ctx.plant.T_tank_C, 70);
      ctx.stagingCfg.enabled = true;
      ctx.sq.hand[1] = HAND.AUTO;
    },
    track(ctx, mem, dt_s) {
      let worst = Infinity;
      for (let i = 0; i < ctx.plant.npsha_m.length; i += 1) {
        if (ctx.plant.drv[i].n_pct > 5) {
          worst = Math.min(worst, ctx.plant.npsha_m[i] - ctx.plant.npshr_m[i]);
        }
      }
      mem.margin = Number.isFinite(worst) ? worst : NaN;
      mem.worstEver = Math.min(mem.worstEver ?? Infinity, mem.margin);
      if (Number.isFinite(mem.margin) && mem.margin < 0.5) {
        mem.lowTime_s = (mem.lowTime_s || 0) + dt_s;
      }
      mem.recovered = mem.worstEver < 0.5 && mem.margin > 1.5;
    },
    objectives: [
      obj({
        id: 'see',
        text: 'Watch the NPSH margin fall below 0.5 m',
        check: (ctx, mem) => (mem.worstEver ?? 9) < 0.5,
        hint: 'It will get there on its own. This objective is about watching the right trace.',
      }),
      obj({
        id: 'recover',
        text: 'Recover the margin above 1.5 m with pumps still running',
        check: (ctx, mem) => mem.recovered === true,
        hint: 'Restore make-up, cool the supply, reduce the duty, or lower the setpoint. Several '
          + 'of those work and one of them is much faster than the others.',
      }),
      obj({
        id: 'damage',
        mode: OBJ.NEVER,
        text: 'Do not spend more than 90 s below 0.5 m of margin',
        check: (ctx, mem) => (mem.lowTime_s ?? 0) > 90,
        hint: 'Cavitation is cumulative mechanical damage. The wear counter is running.',
      }),
    ],
    debrief: 'Nothing on the tuning panel would have helped. The reachable actions were all on '
      + 'the process — restore the inventory, drop the temperature, or ask for less. That is the '
      + 'general shape of the hardest control problems: the loop is behaving exactly as designed '
      + 'and the design is being asked for something physically unavailable. Recognising that '
      + 'situation quickly is worth more than any tuning rule.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'MINFLOW',
    title: 'Minimum continuous flow',
    minutes: 6,
    blurb: 'Where the number on the datasheet comes from.',
    brief: [
      'The recirculation valve has been forced shut, the demand valve is closed, and PIC-101 has '
        + 'been left in MANUAL at 100%. The pump is deadheaded at full speed against a closed '
        + 'system — every watt on the shaft going into a few litres of trapped liquid.',
      'A pump at very low flow is not idling. It is putting nearly all its shaft power into a '
        + 'small volume of liquid that is not being replaced, and the casing temperature rise is '
        + 'the direct consequence. Watch it climb — and watch HOW it climbs, because the shape of '
        + 'that curve is the whole reason the datasheet number is where it is.',
      'Get the machine back inside its envelope. There is more than one way, and the automatic '
        + 'recirculation valve is only the most obvious.',
    ],
    setup(ctx) {
      // MANUAL at full output, which is exactly how this happens on a plant: somebody left the
      // controller in hand, somebody else shut a block valve, and nothing in between noticed.
      // In AUTO the controller would quietly protect the pump by slowing it down — which is
      // worth knowing, and is the first thing the debrief says.
      ctx.pid.mode = MODE.MAN;
      ctx.pid.coMan = 100;
      ctx.plant.recircMode = RECIRC.CLOSED;
      ctx.plant.demandTarget = 0;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      let hottest = -Infinity;
      let lowest = Infinity;
      for (let i = 0; i < ctx.plant.Q_m3h.length; i += 1) {
        if (ctx.plant.drv[i].n_pct > 5) {
          hottest = Math.max(hottest, ctx.plant.Tcasing_C[i] - ctx.plant.T_tank_C);
          lowest = Math.min(lowest, ctx.plant.Q_m3h[i]);
        }
      }
      mem.rise = Number.isFinite(hottest) ? hottest : 0;
      mem.peakRise = Math.max(mem.peakRise ?? 0, mem.rise);
      mem.minQ = Number.isFinite(lowest) ? lowest : NaN;
      mem.safe_s = Number.isFinite(mem.minQ) && mem.minQ >= ctx.config.pumps[0].minFlow_m3h
        ? (mem.safe_s || 0) + dt_s : 0;
    },
    objectives: [
      obj({
        id: 'heat',
        text: 'Watch the casing temperature rise past 5 K above the tank',
        check: (ctx, mem) => (mem.peakRise ?? 0) > 5,
        hint: 'It will happen by itself once the forward flow is nearly gone. Watch the machine '
          + 'cards, and note how little happens until the very end.',
      }),
      obj({
        id: 'vib',
        text: 'Watch the vibration climb into ISO 10816 zone C (above 4.5 mm/s)',
        check: (ctx) => ctx.plant.vib_mms.some((v, i) => ctx.plant.drv[i].n_pct > 5 && v > 4.5),
        hint: 'Suction recirculation at shutoff shakes a machine far harder than it heats it. '
          + 'This is the damage nobody sees on a temperature gauge.',
      }),
      obj({
        id: 'protect',
        mode: OBJ.HOLD,
        hold_s: 60,
        text: 'Hold every running pump above its minimum continuous flow for a minute',
        check: (ctx, mem) => (mem.safe_s ?? 0) > 0.5,
        hint: 'The automatic recirculation valve exists for this. So does opening the demand '
          + 'valve, and so does stopping the pump.',
      }),
    ],
    debrief: 'The first thing to notice is what AUTO would have done: a pressure controller on '
      + 'a closed system sees the pressure climb and slows the pump down, and a deadheaded pump '
      + 'at 55% speed makes barely a fifth of the heat one at 100% does. The controller was '
      + 'protecting the machine, and putting it in manual removed that protection. '
      + 'Look again at the shape of that temperature curve. At half the minimum flow the '
      + 'rise is a fraction of a degree; it only runs away in the last stretch toward true '
      + 'shutoff, because the rise is the lost power divided by the mass flow and the mass flow '
      + 'is what is going to zero. The datasheet minimum sits a long way up that curve on '
      + 'purpose — by the time temperature is the thing you can measure, suction recirculation '
      + 'has already been chewing the impeller for a while, and THAT is what the number is '
      + 'really protecting against. Note also that the recirculation valve is not a control '
      + 'element: it is a mechanical device that opens when the flow through it drops, with no '
      + 'controller involved and nothing to tune. A great deal of process safety works this way, '
      + 'and control engineers get into trouble when they try to replace it with something '
      + 'clever.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'CASCADE',
    title: 'Cascade control',
    minutes: 8,
    blurb: 'Put a fast loop inside a slow one and the slow one stops noticing the disturbance.',
    brief: [
      'A disturbance is being injected downstream. On a single pressure loop it takes a while to '
        + 'show up, because it has to move the header before the controller sees anything.',
      'Cascade puts a flow controller between the pressure controller and the drives. The flow '
        + 'loop sees the disturbance almost immediately — flow is much faster than pressure — and '
        + 'corrects it before the header moves at all.',
      'Set up the cascade, tune the SLAVE first (it has to be several times faster than the '
        + 'master or the structure is worse than useless), then close the master.',
    ],
    setup(ctx) {
      ctx.stratCfg.structure = STRUCTURE.SINGLE;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.55;
      ctx.stagingCfg.enabled = true;
      ctx.sq.hand[1] = HAND.AUTO;
    },
    track(ctx, mem, dt_s) {
      if (ctx.stratCfg.structure === STRUCTURE.CASCADE) mem.cascade_s = (mem.cascade_s || 0) + dt_s;
      const loads = ctx.score.steps.filter((s) => s.kind === 'load');
      if (loads.length) mem.lastLoad = loads[loads.length - 1];
    },
    objectives: [
      obj({
        id: 'single',
        text: 'Record a load-step peak deviation on the single loop',
        check: (ctx, mem) => !!mem.lastLoad && !mem.baselineTaken
          && ctx.stratCfg.structure === STRUCTURE.SINGLE,
        hint: 'Run the LOAD STEP scenario with the structure on SINGLE.',
      }),
      obj({
        id: 'build',
        text: 'Switch to cascade and get the slave loop stable',
        mode: OBJ.HOLD,
        hold_s: 40,
        check: (ctx) => ctx.stratCfg.structure === STRUCTURE.CASCADE
          && Math.abs(ctx.err) < 0.05 && !ctx.diagReport?.oscillating,
        hint: 'The slave is a flow loop: high gain, fast reset, no derivative.',
      }),
      obj({
        id: 'better',
        text: 'Beat the single-loop peak deviation on the same load step',
        check: (ctx, mem) => mem.lastLoad && mem.baseline
          && mem.lastLoad.peakDev < mem.baseline * 0.75,
        hint: 'Run exactly the same scenario again and compare.',
      }),
    ],
    debrief: 'Cascade only helps when the inner loop is genuinely faster than the outer one — the '
      + 'usual rule is a factor of three to five in time constant. Build one where they are '
      + 'similar and the two controllers fight, and the result is worse than either alone. When '
      + 'you see a cascade that has been left with the slave in manual for years, this is usually '
      + 'why.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'FEEDFORWARD',
    title: 'Feedforward',
    minutes: 7,
    blurb: 'Stop waiting for the error before you correct.',
    brief: [
      'Feedback is fundamentally reactive: the process has to go wrong before the controller '
        + 'knows anything happened. Feedforward measures the DISTURBANCE instead and corrects for '
        + 'it directly, before it has had an effect.',
      'The demand valve position is measured here, and the plant model can say what output that '
        + 'position requires. Turn it on and take the same load step.',
      'Then push the gain to 1.0 and watch what happens when the model is slightly wrong. There '
        + 'is a reason the default is 0.85.',
    ],
    setup(ctx) {
      ctx.stratCfg.structure = STRUCTURE.SINGLE;
      ctx.stratCfg.ff.enabled = false;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.5;
      ctx.stagingCfg.enabled = true;
      ctx.sq.hand[1] = HAND.AUTO;
    },
    track(ctx, mem) {
      const loads = ctx.score.steps.filter((s) => s.kind === 'load');
      if (loads.length) {
        const last = loads[loads.length - 1];
        if (!ctx.stratCfg.ff.enabled) mem.without = last.peakDev;
        else mem.with = last.peakDev;
      }
    },
    objectives: [
      obj({
        id: 'base',
        text: 'Record a load step with feedforward off',
        check: (ctx, mem) => mem.without > 0,
        hint: 'Run the LOAD STEP scenario.',
      }),
      obj({
        id: 'ff',
        text: 'Halve the peak deviation with feedforward on',
        check: (ctx, mem) => mem.with > 0 && mem.without > 0 && mem.with < mem.without * 0.5,
        hint: 'Strategy panel, FEEDFORWARD. Adjust the lead-lag so the correction arrives with '
          + 'the disturbance rather than before or after it.',
      }),
      obj({
        id: 'stable',
        mode: OBJ.NEVER,
        text: 'Do not let feedforward drive the loop into oscillation',
        check: (ctx) => ctx.stratCfg.ff.enabled && ctx.diagReport?.oscillating === true
          && ctx.diagReport.strength > 0.7,
      }),
    ],
    debrief: 'Feedforward has no stability of its own — it is open loop, so a wrong model just '
      + 'produces a wrong correction, and nothing detects that. It is always used WITH feedback, '
      + 'never instead of it, and the feedback loop is what cleans up the model error. The lead-'
      + 'lag block matters more than the gain: a perfectly sized correction delivered at the '
      + 'wrong moment makes the excursion worse in one direction and then worse in the other.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'DIAGNOSE',
    title: 'Diagnose the cycle',
    minutes: 8,
    blurb: 'Not every oscillation is a tuning problem. Telling which is which is the skill.',
    brief: [
      'This loop is cycling. Your first instinct will be to detune it. Resist that for a moment '
        + 'and look at the shape of the waveform instead.',
      'A cycle caused by too much gain is close to a sine wave, because the loop is a linear '
        + 'system sitting on the edge of instability. A cycle caused by friction in the valve is '
        + 'not: the stem moves in jumps, so the measurement is a series of ramps and the output '
        + 'is a sawtooth.',
      'The loop health panel measures exactly that. Use it, decide what kind of problem this is, '
        + 'and then act accordingly — including deciding that tuning is not the answer.',
    ],
    setup(ctx, api) {
      ctx.plant.demandTarget = 0.55;
      ctx.pid.spTarget = 3.0;
      ctx.pid.sp = 3.0;
      // Through the action, so the rig picks a fixed speed that puts 3.0 bar inside the throttle
      // valve's reachable band. A valve can only hold a pressure the pump already exceeds.
      // One machine only. The throttle valve's controllable band depends on how many pumps are
      // on the header, so a sequence that stages mid-lesson would move the band out from under
      // the setpoint and the exercise would be about something else entirely.
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
      api.setDisturbance({ finalElement: FINAL.THROTTLE });
      api.setDisturbance({ valveOverride: { pcv: { stickband: 0.035, slipJump: 0.018 } } });
      ctx.pidCfg.Kc = 22;
      ctx.pidCfg.Ti = 7;
      ctx.pidCfg.Td = 0;
      ctx.pid.mode = MODE.AUTO;
    },
    track(ctx, mem, dt_s) {
      const r = ctx.diagReport;
      if (r?.verdict === 'sticking final element') mem.identified_s = (mem.identified_s || 0) + dt_s;
      if (ctx.plant.valveOverride.pcv.stickband < 0.005) mem.repaired = true;
      if (mem.repaired) {
        mem.afterRepair_s = (mem.afterRepair_s || 0) + dt_s;
        if (r && !r.oscillating && mem.afterRepair_s > 120) mem.clean = true;
      }
      // The trap: detuning far enough to slow the cycle without removing it.
      if (r?.oscillating && ctx.pidCfg.Kc < 6) mem.detunedAndStillCycling = true;
    },
    objectives: [
      obj({
        id: 'identify',
        text: 'Get the loop health panel to report a sticking final element',
        check: (ctx, mem) => (mem.identified_s ?? 0) > 20,
        hint: 'The diagnostic window needs a few minutes of cycling before it can call it.',
      }),
      obj({
        id: 'repair',
        text: 'Repair the valve rather than retuning around it',
        check: (ctx, mem) => mem.repaired === true,
        hint: 'The stickband is on the final element card. On a real plant this is a work order, '
          + 'not a keystroke.',
      }),
      obj({
        id: 'clean',
        text: 'Run two minutes clean afterwards with a usable tuning',
        check: (ctx, mem) => mem.clean === true && ctx.pidCfg.Kc > 8,
        hint: 'If you detuned to mask the cycle, put the gain back now.',
      }),
    ],
    debrief: 'Detuning a sticking valve is the single most common wrong answer in process '
      + 'control, and it is wrong in a way that hides itself. Try it on this rig and watch what '
      + 'happens in two stages. Halve the gain and lengthen the reset: the cycle slows from about '
      + 'four minutes to nearly five and its amplitude does not change at all — the trend LOOKS '
      + 'calmer because the wiggles are further apart, the valve is being worked exactly as hard, '
      + 'and the loop is now sluggish as well. Detune further still and the cycle does stop, for '
      + 'the worst possible reason: the controller has become too weak to break the stem free, so '
      + 'the valve simply never moves and the loop sits on a permanent offset it can no longer '
      + 'correct. Neither outcome is a fix. Somewhere between a quarter and a third of industrial '
      + 'control loops are estimated to have a valve problem of this kind, and almost none of '
      + 'them have a tuning problem.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'ENERGY',
    title: 'Throttle against speed',
    minutes: 8,
    blurb: 'The same duty, held two ways, at two very different costs.',
    brief: [
      'The loop has been put on FLOW control at 22 m3/h, because that is the only way to make the '
        + 'comparison honest: same flow to process, same valve position, same duty — two ways of '
        + 'getting there.',
      'First, hold it by throttling. The pumps run at a fixed 80% and PCV-101 takes out whatever '
        + 'head is left over. Note the header pressure and the kW.',
      'Then switch the final element to VFD, so the valve opens fully and the pumps slow down '
        + 'instead. Same 22 m3/h. Look at the header now, and look at the kW.',
      'The head the throttle valve was destroying is the difference, and the affinity laws are '
        + 'why it is so large: head goes with the square of speed and power with the cube.',
    ],
    setup(ctx, api) {
      api.setLoopMode('FLOW');
      ctx.plant.demandTarget = 0.55;
      ctx.pid.spTarget = 22;
      ctx.pid.sp = 22;
      api.setDisturbance({ fixedSpeed_pct: 80, valveOverride: { pcv: { stickband: 0, slipJump: 0 } } });
      api.setDisturbance({ finalElement: FINAL.THROTTLE });
      ctx.pid.mode = MODE.AUTO;
      ctx.stagingCfg.enabled = false;
      ctx.sq.hand[1] = HAND.OFF;
    },
    track(ctx, mem, dt_s) {
      const key = ctx.plant.finalElement === FINAL.THROTTLE ? 'thr' : 'vfd';
      // Only count time when the loop is genuinely ON the flow setpoint, so the two halves are
      // the same duty and the kWh/m3 figures are comparable rather than merely both true.
      if (Math.abs(ctx.err) < 1.0 && ctx.plant.Qdemand_m3h > 5) {
        mem[key] = mem[key] || { kWh: 0, m3: 0, s: 0 };
        mem[key].kWh += (ctx.electrical_kW * dt_s) / 3600;
        mem[key].m3 += (ctx.plant.Qdemand_m3h * dt_s) / 3600;
        mem[key].s += dt_s;
      }
      for (const k of ['thr', 'vfd']) {
        if (mem[k] && mem[k].m3 > 0.05) mem[`${k}Specific`] = mem[k].kWh / mem[k].m3;
      }
      if (mem.thrSpecific && mem.vfdSpecific) {
        mem.saving = 1 - mem.vfdSpecific / mem.thrSpecific;
      }
    },
    objectives: [
      obj({
        id: 'throttle',
        text: 'Hold 22 m3/h on the throttle valve for 90 s',
        check: (ctx, mem) => (mem.thr?.s ?? 0) > 90,
      }),
      obj({
        id: 'vfd',
        text: 'Hold the same 22 m3/h on speed control for 90 s',
        check: (ctx, mem) => (mem.vfd?.s ?? 0) > 90,
        hint: 'Switch the final element to VFD. The setpoint and the demand valve stay where '
          + 'they are — that is the point of the comparison.',
      }),
      obj({
        id: 'saving',
        text: 'Demonstrate at least 25% less energy per cubic metre on speed control',
        check: (ctx, mem) => (mem.saving ?? 0) > 0.25,
        hint: 'Both halves have to be at the same duty for the comparison to mean anything.',
      }),
    ],
    debrief: 'The saving you just measured is the entire business case for a variable-speed '
      + 'drive, and it is why the payback on retrofitting one to a throttled pump is usually '
      + 'counted in months. Note where it comes from, though: the affinity laws apply to the '
      + 'FRICTION part of the system curve. On a system that is mostly static lift, slowing the '
      + 'pump down saves very little and can stop the flow entirely, and a salesman quoting the '
      + 'cube law at you on such a system is quoting the wrong law.',
  },

  // -----------------------------------------------------------------------------------------
  {
    id: 'ROBUST',
    title: 'Tune it for a plant that changes',
    minutes: 10,
    blurb: 'The final exam. Fast, quiet, and still working when the process moves under you.',
    brief: [
      'Anything can be tuned to look good on one step at one operating point. The test of a '
        + 'tuning is what happens when the process is not what it was when you tuned it.',
      'Achieve all of: a peak sensitivity Ms no worse than 1.8, settling inside 25 s on a '
        + 'setpoint step, and a full shift duty cycle run without cavitating, without dropping a '
        + 'pump below minimum flow, and with fewer than six starts.',
      'Ms is the one to watch. It is the closest thing to a single number for robustness — the '
        + 'reciprocal of the shortest distance from the open-loop response to the point where the '
        + 'loop would be unstable.',
    ],
    setup(ctx) {
      ctx.plant.finalElement = FINAL.VFD;
      ctx.pid.mode = MODE.AUTO;
      ctx.pid.spTarget = 3.2;
      ctx.plant.demandTarget = 0.45;
      ctx.stagingCfg.enabled = true;
      ctx.sq.hand[1] = HAND.AUTO;
      ctx.plant.valveOverride.pcv.stickband = 0;
    },
    track(ctx, mem) {
      if (ctx.margins?.stable) mem.ms = ctx.margins.ms;
      const servo = ctx.score.steps.filter((s) => s.kind === 'servo');
      if (servo.length) mem.lastServo = servo[servo.length - 1];
      if (ctx.lastResult && ctx.lastResult.scenario.includes('duty')) mem.duty = ctx.lastResult;
      if (ctx.lastResult) mem.result = ctx.lastResult;
    },
    objectives: [
      obj({
        id: 'ms',
        text: 'Peak sensitivity Ms of 1.8 or better',
        check: (ctx, mem) => Number.isFinite(mem.ms) && mem.ms <= 1.8,
        hint: 'The Bode panel computes it live from your current tuning and the identified model. '
          + 'You need a model first.',
      }),
      obj({
        id: 'fast',
        text: 'Settle a setpoint step inside 25 s',
        check: (ctx, mem) => mem.lastServo && mem.lastServo.settle_s > 0
          && mem.lastServo.settle_s <= 25,
      }),
      obj({
        id: 'shift',
        text: 'Score 70 or better on the shift duty cycle',
        check: (ctx, mem) => mem.result && mem.result.scenario === 'Shift duty cycle'
          && mem.result.score >= 70,
        hint: 'Scenario runner, DUTY. It is the hardest one and it is meant to be.',
      }),
      obj({
        id: 'clean',
        text: 'No cavitation and no minimum-flow violation during that run',
        check: (ctx, mem) => mem.result && mem.result.scenario === 'Shift duty cycle'
          && mem.result.cavTime_s < 1 && mem.result.minFlowTime_s < 1,
      }),
    ],
    debrief: 'You have now done, on a rig where mistakes cost nothing, the whole job: measure the '
      + 'process, choose a structure, pick a tuning that trades speed against robustness on '
      + 'purpose rather than by accident, verify it against a disturbance you did not design it '
      + 'for, and check that the machinery survived. That sequence is the same on a plant. The '
      + 'only difference is that there, the step test costs a batch.',
  },
]);

/**
 * Total starts across a staging state.
 * @param {object} sq staging state
 * @returns {number} the total
 */
function totalStarts(sq) {
  let n = 0;
  for (let i = 0; i < sq.starts.length; i += 1) n += sq.starts[i];
  return n;
}

/**
 * Allocate the lesson-runner state.
 * @returns {object} lesson state
 */
export function createLessonState() {
  return {
    /** The running lesson definition, or null. */
    def: null,
    /** Per-objective progress, keyed by objective id. */
    progress: {},
    /** The lesson's private memory, maintained by its `track`. */
    mem: {},
    /** Simulated seconds since the lesson started. */
    elapsed_s: 0,
    /** True once every non-trap objective is met. */
    complete: false,
    /** Set when a trap objective fires. */
    failed: null,
    /** Ids of lessons completed this session. */
    completed: new Set(),
    /** Newly met objective ids this scan, drained by the caller for the event feed. */
    newly: [],
  };
}

/**
 * Begin a lesson: arrange the rig and reset the progress.
 *
 * @param {object} ls lesson state (mutated)
 * @param {object} def one of {@link LESSONS}
 * @param {object} ctx the sim context, whose config objects the setup mutates
 * @param {object} api the sim's action functions, for the setups that need validation to run —
 *   switching the final element or the loop mode has consequences a raw assignment would skip
 * @returns {void}
 */
export function startLesson(ls, def, ctx, api) {
  ls.def = def;
  ls.progress = {};
  ls.mem = {};
  ls.elapsed_s = 0;
  ls.complete = false;
  ls.failed = null;
  ls.newly = [];
  for (const o of def.objectives) {
    ls.progress[o.id] = { met: false, held_s: 0, at_s: NaN };
  }
  if (def.setup) def.setup(ctx, api);
}

/**
 * Abandon a running lesson. The rig is left exactly as it is — walking away from a lesson should
 * not silently undo what you were doing.
 * @param {object} ls lesson state (mutated)
 * @returns {void}
 */
export function abortLesson(ls) {
  ls.def = null;
}

/**
 * Advance the lesson one scan.
 *
 * @param {object} ls lesson state (mutated)
 * @param {object} ctx the sim context
 * @param {number} dt_s scan period, s
 * @returns {string[]} descriptions of objectives newly met on this scan
 */
export function stepLesson(ls, ctx, dt_s) {
  const fired = [];
  if (!ls.def) return fired;
  ls.elapsed_s += dt_s;
  if (ls.def.track) ls.def.track(ctx, ls.mem, dt_s);

  let allMet = true;
  for (const o of ls.def.objectives) {
    const p = ls.progress[o.id];
    let pass = false;
    try {
      pass = !!o.check(ctx, ls.mem);
    } catch {
      pass = false;                       // a check that throws is simply not met yet
    }

    if (o.mode === OBJ.NEVER) {
      if (pass && !ls.failed) {
        ls.failed = o.text;
        p.met = false;
        fired.push(`FAILED: ${o.text}`);
      }
      continue;
    }
    if (p.met) continue;

    if (o.mode === OBJ.HOLD) {
      p.held_s = pass ? p.held_s + dt_s : 0;
      if (p.held_s >= o.hold_s) {
        p.met = true;
        p.at_s = ls.elapsed_s;
        fired.push(o.text);
      }
    } else if (pass) {
      p.met = true;
      p.at_s = ls.elapsed_s;
      fired.push(o.text);
    }
    if (!p.met) allMet = false;
  }

  if (allMet && !ls.complete) {
    ls.complete = true;
    ls.completed.add(ls.def.id);
    fired.push(`${ls.def.title} — complete`);
  }
  ls.newly = fired;
  return fired;
}

/**
 * How far through the running lesson the operator is.
 * @param {object} ls lesson state
 * @returns {{met:number, total:number, fraction:number}} the tally
 */
export function lessonProgress(ls) {
  if (!ls.def) return { met: 0, total: 0, fraction: 0 };
  const scored = ls.def.objectives.filter((o) => o.mode !== OBJ.NEVER);
  const met = scored.filter((o) => ls.progress[o.id]?.met).length;
  return { met, total: scored.length, fraction: scored.length ? met / scored.length : 0 };
}

/**
 * Restore the settings a lesson disturbed, so the rig is usable again afterwards.
 *
 * Lessons deliberately break things — infinite reset times, disabled anti-windup, jammed valves,
 * closed recirculation. Leaving those in place after the lesson ends is how a training simulator
 * earns a reputation for being broken.
 *
 * @param {object} ctx the sim context (mutated)
 * @param {object} defaults the tuning and staging defaults to restore
 * @returns {void}
 */
export function restoreDefaults(ctx, defaults) {
  Object.assign(ctx.pidCfg, defaults.pid);
  Object.assign(ctx.stagingCfg, defaults.staging);
  ctx.stratCfg.structure = STRUCTURE.SINGLE;
  ctx.stratCfg.ff.enabled = false;
  ctx.stratCfg.sched.enabled = false;
  ctx.stratCfg.sched.on = SCHED_ON.FLOW;
  ctx.stratCfg.reset.enabled = false;
  ctx.stagingCfg.share = SHARE.COMMON;
  ctx.plant.recircMode = RECIRC.ARV;
  ctx.plant.finalElement = FINAL.VFD;
  ctx.plant.makeupAuto = true;
  ctx.plant.foul = 0;
  ctx.plant.Tsupply_C = ctx.config.fluid.T_C;
  ctx.plant.valveOverride.fcv = { strokeTime_s: null, stickband: 0, slipJump: 0 };
  ctx.plant.valveOverride.pcv = { strokeTime_s: null, stickband: 0, slipJump: 0 };
  for (let i = 0; i < ctx.sq.hand.length; i += 1) ctx.sq.hand[i] = HAND.AUTO;
  ctx.pid.mode = MODE.AUTO;
  ctx.pidCfg.Tt = null;
  ctx.pidCfg.outLo = 0;
  ctx.pidCfg.outHi = 100;
  ctx.pid.spTarget = clamp(ctx.pid.spTarget, 1, 5);
}
