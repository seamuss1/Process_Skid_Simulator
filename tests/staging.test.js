/**
 * tests/staging.test.js — the sequence: thresholds, delays, the anti-short-cycling timers, the
 * staging bias, duty rotation and what happens when a machine is lost.
 *
 * The sequence is tested against drive states directly rather than through the plant, because
 * these are discrete-logic claims and mixing them with hydraulics would only make a failure
 * harder to read. `tests/sim.test.js` covers the two working together.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStagingConfig, createStagingState, stepStaging, HAND, SHARE, ROTATE,
} from '../src/control/staging.js';
import { createPidConfig, createPidState, resetPid } from '../src/control/pid.js';
import { createDriveState, stepDrive, DRIVE, referenceToSpeed } from '../src/process/motor.js';
import { DRIVE_SPEC, near } from './helpers.js';

const SCAN = 0.2;

/**
 * A sequence bench: two drives, a controller whose output the test drives by hand, and a runner
 * that steps both for a given number of seconds.
 * @param {object} [over] staging config overrides
 * @returns {object} the bench
 */
function bench(over) {
  const cfg = createStagingConfig(over);
  cfg._drives = [DRIVE_SPEC, DRIVE_SPEC];
  const sq = createStagingState(2);
  const pidCfg = createPidConfig({ outLo: 0, outHi: 100 });
  const pid = createPidState(0, 50);
  resetPid(pid, 0, 50);
  const drv = [createDriveState(), createDriveState()];
  let t = 0;
  const actions = [];
  return {
    cfg, sq, pid, pidCfg, drv, actions,
    /** @returns {number} the current bench time, s */
    t: () => t,
    /**
     * Hold the controller output at a value for a number of seconds.
     * @param {number} co the output to hold, percent
     * @param {number} seconds duration
     * @returns {void}
     */
    hold(co, seconds) {
      for (let k = 0; k * SCAN < seconds; k += 1) {
        pid.co = co;
        const a = stepStaging(cfg, sq, pidCfg, pid, drv, t, SCAN);
        if (a) actions.push({ t, a });
        for (let i = 0; i < 2; i += 1) stepDrive(DRIVE_SPEC, drv[i], 1, 15, SCAN);
        t += SCAN;
      }
    },
    /** @returns {number} how many drives have been called */
    running: () => drv.filter((d) => d.state === DRIVE.RUNNING || d.state === DRIVE.STARTING).length,
  };
}

test('the sequence starts a machine when there is none running', () => {
  const b = bench();
  assert.equal(b.running(), 0);
  b.hold(50, 1);
  assert.equal(b.running(), 1, 'a header with no pump on it is not a state the sequence permits');
  assert.match(b.actions[0].a, /started/);
});

test('the lag pump joins only after the output has been held above the threshold', () => {
  const b = bench({ stageUp_pct: 88, stageUpDelay_s: 8 });
  b.hold(50, 5);
  assert.equal(b.running(), 1);

  b.hold(90, 6);
  assert.equal(b.running(), 1, 'six seconds is not eight — the delay is what stops a transient staging a pump');
  b.hold(90, 4);
  assert.equal(b.running(), 2, 'ten seconds is');
});

test('a dip below the threshold resets the stage-up timer', () => {
  const b = bench({ stageUp_pct: 88, stageUpDelay_s: 8 });
  b.hold(50, 2);
  b.hold(90, 6);
  b.hold(70, 0.4);           // one brief dip
  b.hold(90, 6);
  assert.equal(b.running(), 1, 'the timer must have restarted, so six more seconds is not enough');
  b.hold(90, 3);
  assert.equal(b.running(), 2);
});

test('the hysteresis band means a stage-up does not immediately undo itself', () => {
  const cfg = createStagingConfig();
  assert.ok(cfg.stageUp_pct > cfg.stageDown_pct + 20,
    'the shipped thresholds must leave a band wider than the disturbance a stage itself causes');
  assert.ok(cfg.stageDownDelay_s > cfg.stageUpDelay_s,
    'stopping a machine should be harder than starting one');
});

test('the staging bias steps the output down as the machine joins, through the integral', () => {
  const b = bench({ stageUp_pct: 88, stageUpDelay_s: 4, stageUpBias: 0.7 });
  b.hold(50, 2);
  b.hold(95, 5);
  assert.equal(b.running(), 2);
  // The bias is a preload, not a fudge on the output: the terms must sum to the new value, so
  // the loop resumes from the biased point instead of winding straight back up.
  near(b.pid.prop + b.pid.integ + b.pid.deriv, 95 * 0.7, 1e-9,
    'the controller must have been preloaded to the biased output');
});

test('the minimum run timer refuses a stage-down, however far the output falls', () => {
  const b = bench({ stageUp_pct: 80, stageUpDelay_s: 2, stageDown_pct: 40, stageDownDelay_s: 5, minRun_s: 60 });
  b.hold(90, 4);
  assert.equal(b.running(), 2);
  b.hold(5, 40);
  assert.equal(b.running(), 2, 'forty seconds of nothing to do must not beat a sixty second minimum run');
  b.hold(5, 30);
  assert.equal(b.running(), 1, 'but seventy seconds does');
});

test('the minimum stop timer refuses an immediate restart', () => {
  const b = bench({ stageUp_pct: 80, stageUpDelay_s: 2, stageDown_pct: 40, stageDownDelay_s: 4, minRun_s: 0, minStop_s: 40 });
  b.hold(90, 4);
  assert.equal(b.running(), 2);
  b.hold(5, 6);
  assert.equal(b.running(), 1);
  b.hold(95, 20);
  assert.equal(b.running(), 1, 'a machine that has just stopped must be left alone');
  b.hold(95, 30);
  assert.equal(b.running(), 2);
});

test('the sequence stops the machine with the most runtime, which levels the duty for free', () => {
  const b = bench({ stageUp_pct: 80, stageUpDelay_s: 2, stageDown_pct: 40, stageDownDelay_s: 4, minRun_s: 0 });
  b.hold(90, 4);
  b.drv[0].runtime_h = 12;
  b.drv[1].runtime_h = 3;
  b.hold(5, 8);
  assert.equal(b.drv[0].state, DRIVE.STOPPING, 'the tired machine is the one that gets to rest');
  assert.ok(b.drv[1].state === DRIVE.RUNNING || b.drv[1].state === DRIVE.STARTING);
});

test('losing the lead promotes the standby immediately, without waiting for a timer', () => {
  const b = bench();
  b.hold(50, 3);
  assert.equal(b.sq.lead, 0);
  b.drv[0].state = DRIVE.TRIPPED;
  b.drv[0].trip = 'injected';
  b.hold(50, 1);
  assert.equal(b.sq.lead, 1, 'the surviving machine must become lead');
  assert.ok(b.drv[1].state === DRIVE.STARTING || b.drv[1].state === DRIVE.RUNNING,
    'and it must be called at once — a header with no pump on it does not wait for a delay');
  assert.match(b.sq.lastAction, /tripped/);
});

test('runtime rotation performs a make-before-break changeover', () => {
  const b = bench({ rotate: ROTATE.RUNTIME, rotateAfter_h: 4, overlap_s: 10, minRun_s: 0 });
  b.hold(50, 3);
  assert.equal(b.running(), 1);
  b.drv[0].runtime_h = 9;
  b.drv[1].runtime_h = 1;
  b.hold(50, 1);
  assert.equal(b.running(), 2, 'the incoming machine starts BEFORE the outgoing one stops');
  assert.ok(b.sq.changeover, 'a changeover must be in progress');
  b.hold(50, 12);
  assert.equal(b.sq.lead, 1, 'and it must complete with the lead swapped');
  assert.equal(b.running(), 1, 'back to one machine');
});

test('rotation set to OFF never swaps the lead', () => {
  const b = bench({ rotate: ROTATE.OFF });
  b.hold(50, 3);
  b.drv[0].runtime_h = 500;
  b.hold(50, 60);
  assert.equal(b.sq.lead, 0);
  assert.equal(b.running(), 1);
});

test('an operator can force a machine to run, and lock one out', () => {
  const b = bench();
  b.hold(50, 3);
  b.sq.hand[1] = HAND.HAND;
  b.hold(50, 2);
  assert.equal(b.running(), 2, 'HAND must start it whatever the sequence wants');

  b.sq.hand[1] = HAND.OFF;
  b.hold(50, 2);
  assert.ok(b.drv[1].state === DRIVE.STOPPING || b.drv[1].state === DRIVE.STOPPED);
  b.hold(99, 40);
  assert.ok(b.drv[1].state === DRIVE.STOPPING || b.drv[1].state === DRIVE.STOPPED,
    'and OFF must keep it out however hard the loop asks for more');
});

test('common-speed sharing gives every running machine the same reference', () => {
  const b = bench({ share: SHARE.COMMON, stageUp_pct: 80, stageUpDelay_s: 2 });
  b.hold(90, 5);
  assert.equal(b.running(), 2);
  assert.equal(b.drv[0].cmd_pct, b.drv[1].cmd_pct,
    'identical machines in parallel must run at one speed');
});

test('base/trim sharing pins the lag and modulates the lead', () => {
  const b = bench({ share: SHARE.BASE_TRIM, baseSpeed_pct: 75, stageUp_pct: 80, stageUpDelay_s: 2 });
  b.hold(90, 5);
  assert.equal(b.running(), 2);
  const lead = b.sq.lead;
  const lag = lead === 0 ? 1 : 0;
  assert.equal(b.drv[lag].cmd_pct, 75, 'the lag sits at its base speed');
  assert.notEqual(b.drv[lead].cmd_pct, 75, 'and the lead does the work');
});

test('a stopped machine is commanded to zero, not left at its last reference', () => {
  const b = bench();
  b.hold(50, 3);
  assert.equal(b.drv[1].cmd_pct, 0);
});

test('the VFD reference scaling maps 0..100% of output onto the drive speed range', () => {
  near(referenceToSpeed(DRIVE_SPEC, 0), 45, 1e-12, 'zero output is the minimum frequency');
  near(referenceToSpeed(DRIVE_SPEC, 100), 100, 1e-12, 'full output is the maximum');
  near(referenceToSpeed(DRIVE_SPEC, 50), 72.5, 1e-12, 'and it is linear in between');
});
