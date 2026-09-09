/**
 * tests/faults.test.js — the fault library and the marking of a diagnosis.
 *
 * Two claims are being defended here and they need different machinery.
 *
 * The first is BOOKKEEPING: that the library is well formed, that a fault can be injected and
 * taken out again without leaving anything behind, and that the question put to the player always
 * contains the right answer exactly once. Those are checked against the records directly.
 *
 * The second is that a fault ACTUALLY DOES SOMETHING — that it reaches the rig through a real
 * mechanism rather than decorating a display. That one cannot be checked against a record; it is
 * checked by running the whole plant twice from the same seed, once clean and once faulted, and
 * insisting the two rigs end up in measurably different places. It is the slowest test in the
 * file and the only one that would catch a fault whose `apply` had quietly stopped working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../src/core/sim.js';
import { makeRng } from '../src/game/rng.js';
import {
  CATEGORY, GRADE, FAULTS, faultById, createFaultState, injectFault, stepFaults, clearFaults,
  activeFaults, faultChoices, gradeDiagnosis,
} from '../src/game/faults.js';
import { simFor, run, near } from './helpers.js';

/** Ids of the faults that only bite when PCV-101 is the final control element. */
const THROTTLE_FAULTS = FAULTS.filter((f) => f.category === CATEGORY.FINAL).map((f) => f.id);

/**
 * A settled rig with a fault state wired into the one hook `sim` offers, so that stepping the
 * plant steps the faults exactly the way the game session will.
 * @param {object} [opts] bench options
 * @param {boolean} [opts.throttle] put PCV-101 in charge instead of the drives
 * @param {boolean} [opts.bothPumps] run the standby machine as well
 * @returns {{ctx:object, fs:object}} the bench
 */
function bench(opts = {}) {
  const ctx = simFor(15);
  if (opts.bothPumps) {
    sim.setDisturbance(ctx, { demandTarget: 0.62 });
    sim.startPump(ctx, 1);
    run(ctx, 25);
  }
  if (opts.throttle) {
    sim.setDisturbance(ctx, { finalElement: 'THROTTLE' });
    // A fixed speed that puts the 3.2 bar setpoint in the MIDDLE of the throttle valve's
    // reachable band. Leave it where the automatic choice puts it and the valve sits near the
    // top of its travel with authority in one direction only, so a fault in the stem has
    // almost nothing to show — the bench, not the fault, would be what failed.
    sim.setDisturbance(ctx, { fixedSpeed_pct: 60 });
    run(ctx, 70);
  }
  const fs = createFaultState();
  ctx.game = {
    /**
     * @param {object} c the sim context
     * @param {number} dt_s the scan period, s
     * @returns {void}
     */
    onScan(c, dt_s) { stepFaults(fs, c, sim, dt_s); },
  };
  return { ctx, fs };
}

/**
 * Everything a fault in this library is capable of writing, in one flat record.
 * @param {object} ctx the sim context
 * @returns {object} the snapshot
 */
function snapshot(ctx) {
  const p = ctx.plant;
  return {
    scan_s: ctx.config.scan_s,
    Td: ctx.pidCfg.Td,
    outHi: ctx.pidCfg.outHi,
    action: ctx.pidCfg.action,
    foul: p.foul,
    wear: Array.from(p.wear),
    trim: Array.from(p.trim),
    hDischarge_m: p.hDischarge_m,
    fluidId: p.fluidId,
    makeupAuto: p.makeupAuto,
    Tsupply_C: p.Tsupply_C,
    T_tank_C: p.T_tank_C,
    level_m: p.level_m,
    thermal: p.drv.map((d) => d.thermal_pct),
    pt_bar: p.pt_bar,
    ft_m3h: p.ft_m3h,
    fcv: { ...p.valveOverride.fcv },
    pcv: { ...p.valveOverride.pcv },
  };
}

/**
 * The same snapshot minus the fields the PLANT integrates on its own, which no fault promises to
 * put back because the plant will have moved them whether a fault was injected or not.
 * @param {object} ctx the sim context
 * @returns {object} the settings-only snapshot
 */
function settings(ctx) {
  const s = snapshot(ctx);
  delete s.level_m;
  delete s.T_tank_C;
  delete s.thermal;
  delete s.wear;
  delete s.pt_bar;
  delete s.ft_m3h;
  return s;
}

/**
 * The numbers that say where the rig has got to. Used to prove a fault changed something.
 * @param {object} ctx the sim context
 * @returns {number[]} the observables
 */
function observables(ctx) {
  const p = ctx.plant;
  return [
    p.pt_bar, p.p_bar, p.Qdemand_m3h, p.Qtotal_m3h, p.level_m, p.T_tank_C,
    ctx.run.co_pct, ctx.pid.co, p.fcv.x, p.pcv.x, p.foul, p.hDischarge_m,
    p.wear[0], p.wear[1], p.trim[1], p.Q_m3h[0], p.Q_m3h[1],
    p.drv[0].thermal_pct, p.drv[1].thermal_pct, p.drv[0].n_pct, p.drv[1].n_pct,
  ];
}

/**
 * Whether two observable vectors are meaningfully apart anywhere.
 * @param {number[]} a one rig
 * @param {number[]} b the other
 * @returns {number} the largest scaled difference between them
 */
function biggestGap(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]) / (1 + Math.abs(a[i]));
    if (d > worst) worst = d;
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------
// The library itself
// ---------------------------------------------------------------------------------------------

test('the library offers at least twelve faults spread over all five categories', () => {
  assert.ok(FAULTS.length >= 12,
    `Fault Hunt needs a library, not a handful: only ${FAULTS.length} faults are defined`);
  for (const cat of Object.values(CATEGORY)) {
    const n = FAULTS.filter((f) => f.category === cat).length;
    assert.ok(n >= 2,
      `category ${cat} has ${n} fault(s) — with fewer than two it cannot supply its own decoys`);
  }
});

test('every fault record carries the fields the injector and the diagnosis screen both read', () => {
  const seen = new Set();
  for (const f of FAULTS) {
    assert.ok(!seen.has(f.id), `${f.id} appears twice — ids are the key everything else uses`);
    seen.add(f.id);
    assert.ok(Object.values(CATEGORY).includes(f.category),
      `${f.id} has category ${f.category}, which is not one the UI can group by`);
    assert.ok(f.label && f.label.length > 4, `${f.id} has no readable label`);
    assert.ok(f.blurb && f.blurb.length > 40, `${f.id} has no explanation to show after the round`);
    assert.ok(f.symptoms.length >= 3,
      `${f.id} lists ${f.symptoms.length} symptom(s) — too few to identify it from`);
    assert.ok(f.evidence.length >= 2,
      `${f.id} lists ${f.evidence.length} piece(s) of evidence — a diagnosis needs a confirmation`);
    assert.equal(typeof f.apply, 'function', `${f.id} cannot be applied`);
    assert.equal(typeof f.clear, 'function', `${f.id} cannot be cleared, so it would poison the rig`);
    assert.equal(f.progressive, !!f.step,
      `${f.id} claims progressive=${f.progressive} but ${f.step ? 'has' : 'has no'} step function`);
  }
});

test('every decoy a fault names is a real fault and never the fault itself', () => {
  for (const f of FAULTS) {
    assert.ok(f.confusable.length >= 3,
      `${f.id} names ${f.confusable.length} confusable fault(s) — a four-option question needs three`);
    for (const id of f.confusable) {
      assert.ok(faultById(id), `${f.id} names ${id} as confusable and there is no such fault`);
      assert.notEqual(id, f.id, `${f.id} lists itself as its own decoy`);
    }
  }
});

test('the library and its records are frozen, so a round cannot corrupt the next one', () => {
  assert.throws(() => { FAULTS.push({}); }, 'the fault list can be appended to');
  assert.throws(() => { FAULTS[0].label = 'x'; }, 'a fault record can be relabelled in place');
  assert.throws(() => { FAULTS[0].symptoms.push('x'); }, 'a symptom list can be appended to');
});

// ---------------------------------------------------------------------------------------------
// Injecting and clearing
// ---------------------------------------------------------------------------------------------

test('every fault applies and clears again without leaving a mark on the rig', () => {
  for (const f of FAULTS) {
    const { ctx, fs } = bench({ throttle: THROTTLE_FAULTS.includes(f.id) });
    const before = snapshot(ctx);
    const r = injectFault(fs, ctx, sim, f.id, 1);
    assert.ok(r.ok, `${f.id} refused injection on a rig arranged for it: ${r.reason}`);
    assert.deepEqual(activeFaults(fs), [f.id], `${f.id} did not register as active`);
    clearFaults(fs, ctx, sim);
    assert.deepEqual(activeFaults(fs), [], `${f.id} was still active after clearFaults`);
    assert.deepEqual(snapshot(ctx), before,
      `${f.id} did not put the rig back exactly as it found it — every later round inherits this`);
  }
});

test('a fault left running for a minute still restores every setting it changed', () => {
  for (const f of FAULTS) {
    const { ctx, fs } = bench({ throttle: THROTTLE_FAULTS.includes(f.id) });
    const before = settings(ctx);
    assert.ok(injectFault(fs, ctx, sim, f.id, 1).ok, `${f.id} refused injection`);
    run(ctx, 60);
    clearFaults(fs, ctx, sim);
    assert.deepEqual(settings(ctx), before,
      `${f.id} left a setting behind after a minute of running — the rig is now permanently wrong`);
  }
});

test('every fault measurably changes what the rig does, so none of them is decoration', () => {
  for (const f of FAULTS) {
    const throttle = THROTTLE_FAULTS.includes(f.id);
    const clean = bench({ throttle, bothPumps: !throttle });
    const dirty = bench({ throttle, bothPumps: !throttle });
    assert.ok(injectFault(dirty.fs, dirty.ctx, sim, f.id, 1).ok, `${f.id} refused injection`);

    // The rigs are compared all the way along rather than only at the end. A slow positioner
    // and a slow scan both arrive at the same steady state a healthy rig does — the whole of
    // their signature is in the transient, and a test that looked only at the finish would
    // declare them decoration.
    let gap = 0;
    for (let k = 0; k < 24; k += 1) {
      // The same move on both rigs at the same moment: several faults — a sticking demand valve,
      // a slow positioner — only show themselves when something asks the plant to change. On the
      // throttle rig it has to be the SETPOINT that moves, because a load change there is
      // answered by a valve that ambles, and a positioner fault cannot be seen against a command
      // that was never in a hurry.
      for (const b of [clean, dirty]) {
        if (k === 3) {
          if (throttle) sim.setSetpoint(b.ctx, 3.05);
          else sim.setDisturbance(b.ctx, { demandTarget: 0.78 });
        }
        run(b.ctx, 3);
      }
      gap = Math.max(gap, biggestGap(observables(clean.ctx), observables(dirty.ctx)));
    }
    assert.ok(gap > 5e-3,
      `${f.id} left the rig doing what a clean rig does at every moment of a load change `
      + `(largest scaled difference ${gap.toExponential(2)}) — it is not reaching the process `
      + 'through any real mechanism');
  }
});

test('a progressive fault advances only on the time it is handed', () => {
  const { ctx, fs } = bench();
  assert.ok(injectFault(fs, ctx, sim, 'STRAINER_BLOCKED', 1).ok, 'the strainer fault was refused');
  const start = ctx.plant.foul;
  for (let i = 0; i < 50; i += 1) stepFaults(fs, ctx, sim, 0);
  assert.equal(ctx.plant.foul, start,
    'fifty scans of zero elapsed time advanced a progressive fault — it is reading a clock '
    + 'somewhere instead of its dt');
  for (let i = 0; i < 50; i += 1) stepFaults(fs, ctx, sim, 0.2);
  assert.ok(ctx.plant.foul > start + 0.05,
    `ten seconds of scans moved the strainer from ${start} to ${ctx.plant.foul} — too slow to `
    + 'be legible inside a round');
});

test('injection refuses everything it cannot honour, rather than half-applying it', () => {
  const { ctx, fs } = bench();
  assert.equal(injectFault(fs, ctx, sim, 'NO_SUCH_FAULT', 1).ok, false,
    'an unknown fault id was accepted');
  assert.equal(injectFault(fs, ctx, sim, 'STRAINER_BLOCKED', NaN).ok, false,
    'a NaN magnitude was accepted, which would put a NaN into the plant');
  assert.equal(injectFault(fs, null, sim, 'STRAINER_BLOCKED', 1).ok, false,
    'a missing simulation context was accepted');
  assert.equal(injectFault(fs, ctx, {}, 'STRAINER_BLOCKED', 1).ok, false,
    'a fault needing setDisturbance was accepted against an action surface that has none');
  assert.deepEqual(activeFaults(fs), [],
    'a refused injection still registered a fault, so clearFaults would try to undo nothing');

  assert.ok(injectFault(fs, ctx, sim, 'STRAINER_BLOCKED', 1).ok, 'a good injection was refused');
  const twice = injectFault(fs, ctx, sim, 'STRAINER_BLOCKED', 1);
  assert.equal(twice.ok, false, 'the same fault was injected twice, which loses the first memo');
  assert.ok(/already/i.test(twice.reason), `the refusal does not say why: "${twice.reason}"`);
});

test('a valve fault refuses the rig it cannot reach and says which one it wants', () => {
  const { ctx, fs } = bench();          // drives are the final element here
  const r = injectFault(fs, ctx, sim, 'VALVE_STICTION', 1);
  assert.equal(r.ok, false, 'stiction in PCV-101 was injected while the valve is wide open and idle');
  assert.ok(/final control element/i.test(r.reason),
    `the refusal should name the reason an operator would check: "${r.reason}"`);

  const flow = bench();
  sim.setLoopMode(flow.ctx, 'FLOW');
  const s = injectFault(flow.fs, flow.ctx, sim, 'PT_DRIFT', 1);
  assert.equal(s.ok, false, 'a PT-101 fault was injected into a loop that is not reading PT-101');
});

// ---------------------------------------------------------------------------------------------
// The transmitter layer
// ---------------------------------------------------------------------------------------------

test('a drifting transmitter really pulls the header away from setpoint, and clears cleanly', () => {
  const { ctx, fs } = bench();
  const sp = ctx.pid.sp;
  assert.ok(injectFault(fs, ctx, sim, 'PT_DRIFT', 1).ok, 'the drift was refused');
  run(ctx, 100);

  near(ctx.plant.pt_bar, sp, 0.08,
    'the controller should still be holding the READING on setpoint while the drift develops');
  const gap = ctx.plant.pt_bar - ctx.plant.p_bar;
  near(gap, 1.0, 0.3,
    'the gap between what PT-101 reports and what the header is actually at — this is the whole '
    + 'fault, and if it is near zero the offset is being washed out by the transmitter filter');

  clearFaults(fs, ctx, sim);

  // Measured at the INSTANT of the clear, which is what "clears cleanly" means. Sampling a few
  // seconds later instead measures something quite different and much less interesting: the loop
  // has just discovered the header is a whole bar below setpoint and is driving hard to fix it,
  // and a transmitter with a dead time and a filter necessarily reads low all the way up that
  // ramp. That lag is the instrument working correctly, not the fault still being present — it
  // peaks near 0.1 bar at two seconds and decays monotonically to a thousandth by eighty. So the
  // residue is checked here, tightly, and the recovery is checked separately below.
  near(ctx.plant.pt_bar - ctx.plant.p_bar, 0, 0.005,
    'clearing the drift left a bias behind on the transmitter chain');

  run(ctx, 120);
  near(ctx.plant.pt_bar - ctx.plant.p_bar, 0, 0.01,
    'once the recovery is over the transmitter should agree with the header again');
  near(ctx.plant.p_bar, sp, 0.05,
    'and the loop should have brought the TRUE header back to setpoint, now that it can see it');
});

test('a frozen transmitter draws a ruler while the header moves underneath it', () => {
  const { ctx, fs } = bench();
  assert.ok(injectFault(fs, ctx, sim, 'PT_FREEZE', 1).ok, 'the freeze was refused');
  const frozen = ctx.plant.pt_bar;
  sim.setDisturbance(ctx, { demandTarget: 0.85 });
  run(ctx, 40);

  near(ctx.plant.pt_bar, frozen, 0.02,
    'PT-101 is supposed to be stuck at its last good value and it has moved');
  assert.ok(Math.abs(ctx.plant.p_bar - frozen) > 0.15,
    `the real header only moved to ${ctx.plant.p_bar.toFixed(2)} bar against a frozen `
    + `${frozen.toFixed(2)} — with the loop blind to a load change it should have moved plainly`);
});

test('a transmitter fault flushes out of the instrument once it is cleared', () => {
  const { ctx, fs } = bench();
  injectFault(fs, ctx, sim, 'PT_SPAN', 1);
  run(ctx, 30);
  assert.ok(Math.abs(ctx.plant.pt_bar - ctx.plant.p_bar) > 0.1,
    'the span error never took hold: PT-101 is still agreeing with the header');
  clearFaults(fs, ctx, sim);
  run(ctx, 25);
  near(ctx.plant.pt_bar - ctx.plant.p_bar, 0, 0.03,
    'a cleared span error is still colouring the reading — the bias is being re-applied somewhere '
    + 'after the fault has gone');
});

/**
 * Run a bench and report how far the measurement wandered and how far the output travelled to
 * chase it. The two together are what separates a noisy process from a noisy measurement and
 * both from a controller that is amplifying one.
 * @param {object} ctx the sim context
 * @param {number} seconds how long to watch, s
 * @returns {{span:number, travel:number}} the peak-to-peak PV and the total output travel
 */
function watch(ctx, seconds) {
  const n = Math.round(seconds / ctx.config.dt_s);
  let lo = Infinity;
  let hi = -Infinity;
  let travel = 0;
  let prev = ctx.run.co_pct;
  for (let i = 0; i < n; i += 1) {
    run(ctx, ctx.config.dt_s);
    lo = Math.min(lo, ctx.plant.pt_bar);
    hi = Math.max(hi, ctx.plant.pt_bar);
    travel += Math.abs(ctx.run.co_pct - prev);
    prev = ctx.run.co_pct;
  }
  return { span: hi - lo, travel };
}

test('a noisy transmitter puts grass on the pen and sends the output chasing it', () => {
  const quiet = watch(bench().ctx, 60);
  const noisy = bench();
  injectFault(noisy.fs, noisy.ctx, sim, 'PT_NOISE', 1);
  run(noisy.ctx, 10);
  const got = watch(noisy.ctx, 60);
  assert.ok(got.span > 8 * quiet.span,
    `the faulted transmitter moved ${got.span.toFixed(3)} bar peak to peak against a healthy `
    + `${quiet.span.toFixed(3)} — that is not grass, it is a rounding error`);
  assert.ok(got.travel > 10 * quiet.travel,
    `the output travelled ${got.travel.toFixed(0)}% against a healthy ${quiet.travel.toFixed(0)}% `
    + '— a noisy measurement is supposed to cost the final element something');
});

test('a spiking transmitter throws excursions the header could not physically make', () => {
  const b = bench();
  injectFault(b.fs, b.ctx, sim, 'PT_SPIKE', 1);
  run(b.ctx, 10);
  const got = watch(b.ctx, 60);
  assert.ok(got.span > 0.4,
    `the largest spike was ${got.span.toFixed(3)} bar — too small to read off a trend`);
  assert.ok(Math.abs(b.ctx.plant.p_bar - b.ctx.pid.sp) < 0.3,
    'the real header should be more or less where it was: spikes are on the measurement, and a '
    + 'fault that actually moved the process would be a different diagnosis');
});

test('rate action on a clean measurement thrashes the output without moving the process', () => {
  const quiet = watch(bench().ctx, 60);
  const b = bench();
  injectFault(b.fs, b.ctx, sim, 'DERIV_ON_NOISE', 1);
  run(b.ctx, 10);
  const got = watch(b.ctx, 60);
  assert.ok(got.travel > 10 * quiet.travel,
    `the output travelled ${got.travel.toFixed(0)}% against a healthy ${quiet.travel.toFixed(0)}% `
    + '— derivative on the transmitter noise is supposed to be visible on the final element');
  assert.ok(got.span < 4 * quiet.span,
    `the measurement moved ${got.span.toFixed(3)} bar peak to peak, which means the controller is `
    + 'now disturbing the process rather than merely wearing the drive out — that is a different '
    + 'fault from the one this record describes');
});

test('a seized stem stays put while the controller wears itself out against it', () => {
  const b = bench({ throttle: true });
  injectFault(b.fs, b.ctx, sim, 'VALVE_STUCK', 1);
  const parked = b.ctx.plant.pcv.x;
  const co0 = b.ctx.run.co_pct;
  sim.setDisturbance(b.ctx, { demandTarget: 0.62 });
  run(b.ctx, 90);
  // Not bolted: seized. Once the controller has wound far enough past it the stem does creep,
  // and then sticks again — which is what a seized stem does, and is a hundredth of the travel
  // the output covered looking for a response.
  near(b.ctx.plant.pcv.x, parked, 0.06,
    'PCV-101 is supposed to be seized and its travel has followed the output');
  assert.ok(Math.abs(b.ctx.run.co_pct - co0) > 5,
    `the output only moved ${Math.abs(b.ctx.run.co_pct - co0).toFixed(1)}% against a valve that `
    + 'is not responding at all; it should be winding away looking for a response');
});

test('the noisy and spiking transmitters are reproducible from the same call sequence', () => {
  const trace = () => {
    const { ctx, fs } = bench();
    injectFault(fs, ctx, sim, 'PT_NOISE', 1);
    const out = [];
    for (let i = 0; i < 40; i += 1) {
      stepFaults(fs, ctx, sim, 0.2);
      out.push(ctx.plant.pt_bar);
    }
    return out;
  };
  assert.deepEqual(trace(), trace(),
    'two identical runs produced different noise — a Fault Hunt round would not replay from its '
    + 'seed code');
});

// ---------------------------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------------------------

test('the options always contain the true fault exactly once and never repeat', () => {
  for (const f of FAULTS) {
    for (const seed of [0, 1, 7, 12345, 0xffffffff]) {
      for (const n of [1, 2, 3, 4, 6]) {
        const opts = faultChoices(makeRng(seed), f.id, n);
        assert.equal(opts.length, n,
          `${f.id} with seed ${seed} produced ${opts.length} options, not ${n}`);
        assert.equal(opts.filter((id) => id === f.id).length, 1,
          `${f.id} with seed ${seed} produced a question its own answer appears ${
            opts.filter((id) => id === f.id).length} times in`);
        assert.equal(new Set(opts).size, opts.length,
          `${f.id} with seed ${seed} offered the same option twice: ${opts.join(', ')}`);
        for (const id of opts) assert.ok(faultById(id), `${id} is not a fault in the library`);
      }
    }
  }
});

test('the decoys are drawn from the faults that genuinely look like the true one', () => {
  for (const f of FAULTS) {
    const opts = faultChoices(makeRng(99), f.id, 4);
    const decoys = opts.filter((id) => id !== f.id);
    for (const id of decoys) {
      assert.ok(f.confusable.includes(id),
        `${f.id} was offered ${id} as a decoy and does not consider it confusable — a question `
        + 'with an absurd option is answered without reading the trend');
    }
  }
});

test('the option list refuses to invent a question for a fault that does not exist', () => {
  assert.deepEqual(faultChoices(makeRng(1), 'NOT_A_FAULT', 4), [],
    'an unknown fault produced a plausible-looking question with no right answer in it');
  assert.deepEqual(faultChoices(makeRng(1), undefined, 4), [], 'an undefined fault id was accepted');
});

test('the option list survives a broken generator and a nonsense count', () => {
  const f = FAULTS[0].id;
  assert.ok(faultChoices(null, f, 4).includes(f), 'a missing generator lost the right answer');
  assert.ok(faultChoices(makeRng(0), f, NaN).length > 0, 'a NaN count produced no question at all');
  assert.equal(faultChoices(makeRng(0), f, 0).length, 1,
    'a zero count should still leave the true fault on screen, not an empty question');
  assert.equal(faultChoices(makeRng(0), f, 9999).length, FAULTS.length,
    'a count larger than the library should stop at the library');
});

// ---------------------------------------------------------------------------------------------
// The marking
// ---------------------------------------------------------------------------------------------

test('a fast correct diagnosis scores more than a slow one, and both beat nothing', () => {
  const fast = createFaultState();
  const slow = createFaultState();
  const { ctx } = bench();
  injectFault(fast, ctx, sim, 'STRAINER_BLOCKED', 1);
  injectFault(slow, ctx, sim, 'STRAINER_BLOCKED', 1);

  const a = gradeDiagnosis(fast, 'STRAINER_BLOCKED', 5);
  const b = gradeDiagnosis(slow, 'STRAINER_BLOCKED', 300);
  assert.ok(a.correct && b.correct, 'a correct answer was marked wrong');
  assert.ok(a.points > b.points,
    `answering in 5 s scored ${a.points} and answering in 300 s scored ${b.points} — speed is `
    + 'supposed to be worth something');
  assert.ok(b.points >= GRADE.base * 0.9,
    `a slow but correct diagnosis scored only ${b.points}; being right has to stay worth doing`);
  assert.ok(a.explain.length > 20, 'the verdict gives the player nothing to learn from');
});

test('answering inside the grace window is worth no more than answering at the end of it', () => {
  const at = (t) => {
    const fs = createFaultState();
    const { ctx } = bench();
    injectFault(fs, ctx, sim, 'STRAINER_BLOCKED', 1);
    return gradeDiagnosis(fs, 'STRAINER_BLOCKED', t).points;
  };
  assert.equal(at(0), at(GRADE.grace_s),
    'buzzing in at t=0 pays more than reading the trend for the whole grace window, which is '
    + 'exactly the incentive the grace window exists to remove');
  assert.ok(at(GRADE.grace_s + GRADE.halfLife_s) < at(GRADE.grace_s),
    'the bonus never decays, so there is no reason to hurry');
});

test('a blind guess among four options is worth nothing on average', () => {
  const fs = createFaultState();
  const { ctx } = bench();
  injectFault(fs, ctx, sim, 'STRAINER_BLOCKED', 1);
  const best = GRADE.base + GRADE.speedBonus;
  const ev = (best - (GRADE.choicesAssumed - 1) * GRADE.wrongPenalty) / GRADE.choicesAssumed;
  assert.ok(Math.abs(ev) < 1,
    `a blind guess is worth ${ev.toFixed(1)} points on average; the wrong-answer penalty has to `
    + 'price guessing out of the game');
  const wrong = gradeDiagnosis(fs, 'HOT_FEED', 5);
  assert.equal(wrong.correct, false, 'the wrong fault was marked correct');
  assert.equal(wrong.points, -GRADE.wrongPenalty, 'a wrong answer did not cost what it should');
});

test('working through the options one at a time costs what each wrong turn is worth', () => {
  const fs = createFaultState();
  const { ctx } = bench();
  injectFault(fs, ctx, sim, 'STRAINER_BLOCKED', 1);
  const clean = createFaultState();
  injectFault(clean, ctx, sim, 'STRAINER_BLOCKED', 1);

  gradeDiagnosis(fs, 'HOT_FEED', 5);
  gradeDiagnosis(fs, 'LOW_SUCTION', 6);
  const after = gradeDiagnosis(fs, 'STRAINER_BLOCKED', 7);
  const first = gradeDiagnosis(clean, 'STRAINER_BLOCKED', 7);
  assert.ok(after.correct && first.correct, 'the right answer stopped being right');
  near(first.points - after.points, 2 * GRADE.wrongPenalty, 1,
    'two wrong turns before the right answer should cost two penalties');
});

test('a diagnosis is marked once; a second bite at the same round earns nothing', () => {
  const fs = createFaultState();
  const { ctx } = bench();
  injectFault(fs, ctx, sim, 'HOT_FEED', 1);
  assert.ok(gradeDiagnosis(fs, 'HOT_FEED', 10).correct, 'the first correct answer was rejected');
  const again = gradeDiagnosis(fs, 'HOT_FEED', 10);
  assert.equal(again.points, 0, 'the same round was scored twice');
});

test('the marker refuses nonsense instead of paying for it', () => {
  const empty = createFaultState();
  const none = gradeDiagnosis(empty, 'HOT_FEED', 5);
  assert.equal(none.points, 0, 'a diagnosis was scored with no fault injected');
  assert.equal(none.correct, false, 'guessing at a clean rig was marked correct');

  const fs = createFaultState();
  const { ctx } = bench();
  injectFault(fs, ctx, sim, 'HOT_FEED', 1);
  const bogus = gradeDiagnosis(fs, 'NOT_A_FAULT', 5);
  assert.equal(bogus.points, 0, 'an unknown id was marked, which lets a client invent options');
  assert.equal(bogus.correct, false, 'an unknown id was marked correct');
  assert.equal(gradeDiagnosis(null, 'HOT_FEED', 5).points, 0, 'a missing fault state was marked');

  const nan = createFaultState();
  injectFault(nan, ctx, sim, 'HOT_FEED', 1);
  const slowest = gradeDiagnosis(nan, 'HOT_FEED', NaN);
  near(slowest.points, GRADE.base, 1,
    'a NaN clock should be treated as an eternity, never as an instant answer');
});

// ---------------------------------------------------------------------------------------------
// The boring cases that break things
// ---------------------------------------------------------------------------------------------

test('a fresh fault state is empty and safe to step, clear and read', () => {
  const fs = createFaultState();
  assert.deepEqual(activeFaults(fs), [], 'a fresh state already has faults in it');
  const { ctx } = bench();
  stepFaults(fs, ctx, sim, 0.2);
  clearFaults(fs, ctx, sim);
  assert.deepEqual(activeFaults(fs), [], 'clearing an empty state produced faults');
});

test('stepping and clearing survive a zero dt, a broken context and a missing state', () => {
  const { ctx, fs } = bench();
  injectFault(fs, ctx, sim, 'PT_DRIFT', 1);
  const before = ctx.plant.pt_bar;
  stepFaults(fs, ctx, sim, 0);
  stepFaults(fs, ctx, sim, NaN);
  stepFaults(fs, ctx, sim, -5);
  assert.ok(Number.isFinite(ctx.plant.pt_bar),
    `a nonsense dt put ${ctx.plant.pt_bar} into the transmitter`);
  near(ctx.plant.pt_bar, before, 0.02, 'a zero-length step still moved the reading');

  stepFaults(fs, null, sim, 0.2);
  stepFaults(null, ctx, sim, 0.2);
  clearFaults(null, ctx, sim);
  clearFaults(fs, null, sim);
  assert.deepEqual(activeFaults(null), [], 'reading a missing state should be empty, not a throw');
});

test('a zero magnitude is accepted and injects a fault that does almost nothing', () => {
  const { ctx, fs } = bench();
  assert.ok(injectFault(fs, ctx, sim, 'BACKPRESSURE', 0).ok,
    'a zero magnitude was refused; the mission table is entitled to ask for a gentle fault');
  assert.deepEqual(activeFaults(fs), ['BACKPRESSURE'], 'the gentle fault did not register');
  clearFaults(fs, ctx, sim);
});

test('two faults can run at once and each is undone by its own memo', () => {
  const { ctx, fs } = bench();
  const before = snapshot(ctx);
  assert.ok(injectFault(fs, ctx, sim, 'BACKPRESSURE', 1).ok, 'the first fault was refused');
  assert.ok(injectFault(fs, ctx, sim, 'PT_DRIFT', 0.5).ok, 'the second fault was refused');
  assert.deepEqual(activeFaults(fs), ['BACKPRESSURE', 'PT_DRIFT'],
    'faults are not listed in the order they were injected');
  clearFaults(fs, ctx, sim);
  assert.deepEqual(snapshot(ctx), before, 'clearing two faults at once left one of them behind');
});
