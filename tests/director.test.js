/**
 * tests/director.test.js — the upset director: the telegraph, the firing guarantee, the
 * reversibility guarantee, and the escalation.
 *
 * The timing claims are tested against a hand-driven clock rather than against the sim's own
 * accumulator, because they are claims about the director's arithmetic and mixing them with the
 * plant would only make a failure harder to read. The reversibility claims are tested against a
 * real sim context, because that is the only thing that can prove an upset put the rig back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from '../src/core/sim.js';
import {
  UPSETS, TELEGRAPH_FLOOR_S, createDirector, stepDirector, upcoming, endlessWave, revertAll,
} from '../src/game/director.js';
import { simFor } from './helpers.js';

/** The controller scan the rig ships with, and therefore the director's natural step. */
const SCAN = 0.2;

/**
 * A seeded PRNG, written out here rather than imported so this file tests the director and not
 * somebody else's generator.
 * @param {number} seed any 32-bit integer
 * @returns {function():number} a generator on [0,1)
 */
function rngOf(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Step a director for a number of seconds at the scan rate, collecting everything it did.
 * @param {object} dir the director
 * @param {object} ctx the sim context
 * @param {number} seconds how long to run
 * @param {number} [dt] the step, s
 * @returns {{fired:object[], armed:object[]}} everything that fired and armed, in order
 */
function drive(dir, ctx, seconds, dt = SCAN) {
  const fired = [];
  const armed = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i += 1) {
    const r = stepDirector(dir, ctx, sim, dt);
    for (const f of r.fired) fired.push({ ...f, t_s: dir.t_s });
    for (const a of r.armed) armed.push({ ...a, t_s: dir.t_s });
  }
  return { fired, armed };
}

/**
 * Everything an upset is allowed to touch, so a revert can be checked field by field.
 *
 * Drive state is deliberately absent: an overload that has been reset comes back STOPPED rather
 * than RUNNING, which is what the real relay does, and the sequence restarts it on the next scan.
 * That is checked separately.
 *
 * @param {object} ctx the sim context
 * @returns {object} the snapshot
 */
function snapshot(ctx) {
  const p = ctx.plant;
  return {
    demandTarget: p.demandTarget,
    foul: p.foul,
    level_m: p.level_m,
    V_m3: p.V_m3,
    makeupAuto: p.makeupAuto,
    fluidId: p.fluidId,
    pAtm_bar: p.pAtm_bar,
    hDischarge_m: p.hDischarge_m,
    Tsupply_C: p.Tsupply_C,
    fcv: { ...p.valveOverride.fcv },
    pcv: { ...p.valveOverride.pcv },
    finalElement: p.finalElement,
    recircMode: p.recircMode,
    fixedSpeed_pct: p.fixedSpeed_pct,
    scan_s: ctx.config.scan_s,
    spTarget: ctx.pid.spTarget,
    hand: ctx.staging.hand.slice(),
  };
}

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

test('every upset declares everything the ticker and the debrief need from it', () => {
  const ids = Object.keys(UPSETS);
  assert.ok(ids.length >= 12, `the table has only ${ids.length} upsets — a wave built from that few repeats itself`);
  for (const id of ids) {
    const u = UPSETS[id];
    assert.equal(u.id, id, `${id} does not carry its own key, so a detached record cannot name itself`);
    assert.ok(typeof u.label === 'string' && u.label.length > 0, `${id} has no ticker label`);
    assert.ok(typeof u.glyph === 'string' && u.glyph.length > 0, `${id} has no glyph`);
    assert.ok(u.telegraph_s > 0, `${id} has no telegraph, so it would land with no warning at all`);
    assert.ok(Number.isInteger(u.severity) && u.severity >= 1 && u.severity <= 5,
      `${id} severity ${u.severity} is outside 1..5, so the endless pool cannot gate on it`);
    for (const mag of [0, 0.5, 1]) {
      const d = u.describe(mag);
      assert.ok(typeof d === 'string' && d.length > 10,
        `${id}.describe(${mag}) returned nothing a brief could print`);
    }
    assert.equal(typeof u.apply, 'function', `${id} cannot be applied`);
    assert.equal(typeof u.revert, 'function', `${id} cannot be reverted, so a run after it starts dirty`);
  }
});

test('the upsets a shift actually throws at an operator are all in the table', () => {
  const required = [
    'DEMAND_SURGE', 'DEMAND_COLLAPSE', 'DEMAND_RAMP', 'LEVEL_SWING', 'FLUID_CHANGE',
    'FOULING', 'STICTION', 'NOISE', 'SCAN_SLOW', 'PUMP_TRIP', 'SUPPLY_SAG', 'SP_CHANGE',
  ];
  for (const id of required) {
    assert.ok(UPSETS[id], `${id} is missing — the design names it as a kind the director must cover`);
  }
});

test('the upset table is frozen, so one run cannot leave state in it for the next', () => {
  assert.ok(Object.isFrozen(UPSETS), 'UPSETS is not frozen');
  for (const id of Object.keys(UPSETS)) {
    assert.ok(Object.isFrozen(UPSETS[id]), `${id} is not frozen — an apply could stash state on it`);
  }
});

// ---------------------------------------------------------------------------------------------
// The telegraph
// ---------------------------------------------------------------------------------------------

test('a ten-second telegraph appears on the ticker when the upset is ten seconds out, not before', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 20, upset: 'DEMAND_SURGE', mag: 0.5, telegraph_s: 10 }] });

  assert.equal(upcoming(dir).length, 0, 'an upset twenty seconds out is on the ticker before its telegraph has opened');
  drive(dir, ctx, 9.8);
  assert.equal(upcoming(dir).length, 0,
    `at T-10.2 the ticker already shows the upset — the countdown an operator reads must be the one they get (t=${dir.t_s})`);

  stepDirector(dir, ctx, sim, SCAN);
  const shown = upcoming(dir);
  assert.equal(shown.length, 1, `at T-10.0 the upset is still not on the ticker (t=${dir.t_s})`);
  assert.ok(Math.abs(shown[0].in_s - 10) < 1e-6,
    `the ticker says T-${shown[0].in_s.toFixed(6)} when the upset is ten seconds away`);
  assert.equal(shown[0].id, 'DEMAND_SURGE', 'the ticket does not name its upset');
  assert.equal(shown[0].label, 'DEMAND SURGE', 'the ticket has no label to draw');
});

test('an upset fires once, at its scheduled second, and never again', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 20, upset: 'DEMAND_SURGE', mag: 0.5, telegraph_s: 10 }] });
  const { fired, armed } = drive(dir, ctx, 120);

  assert.equal(fired.length, 1, `the upset fired ${fired.length} times — a scored run cannot survive a double disturbance`);
  assert.equal(armed.length, 1, `the upset armed ${armed.length} times, so the ticker would announce it repeatedly`);
  assert.ok(Math.abs(fired[0].t_s - 20) <= SCAN + 1e-9,
    `the upset fired at ${fired[0].t_s.toFixed(3)} s instead of 20 s`);
  assert.equal(fired[0].in_s, 0, 'a firing ticket must read T-0');
  assert.ok(typeof fired[0].describe === 'string' && fired[0].describe.length > 10,
    'a firing ticket carries no description for the event feed');
});

test('a fired upset leaves the ticker instead of counting down past zero', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 5, upset: 'DEMAND_SURGE', mag: 0.4, telegraph_s: 10 }] });
  drive(dir, ctx, 4.8);
  assert.equal(upcoming(dir).length, 1, 'the upset should be on the ticker just before it lands');
  drive(dir, ctx, 1);
  assert.equal(upcoming(dir).length, 0, 'a fired upset is still being advertised as upcoming');
});

test('a long frame does not make an upset fire late, and does not swallow one either', () => {
  const ctx = simFor(0);
  const dir = createDirector({
    script: [
      { at_s: 5, upset: 'DEMAND_SURGE', mag: 0.3 },
      { at_s: 7, upset: 'BACKPRESSURE', mag: 0.3 },
      { at_s: 90, upset: 'NOISE', mag: 0.3 },
    ],
  });
  // One thirty-second step: a backgrounded tab, or time compression at 30x on a slow machine.
  const r = stepDirector(dir, ctx, sim, 30);
  assert.equal(r.ok, true, `the director refused a long but legitimate step: ${r.reason}`);
  assert.equal(r.fired.length, 2,
    `${r.fired.length} upsets fired across a step that contained two — a skipped upset scores a run that never happened`);
  assert.deepEqual(r.fired.map((f) => f.id), ['DEMAND_SURGE', 'BACKPRESSURE'],
    'upsets inside one long step did not fire in scheduled order');
  assert.equal(dir.queue.length, 1, 'the third upset was consumed by the long step');
  assert.equal(upcoming(dir, 120).length, 0,
    'an upset sixty seconds out is on the ticker even though its own telegraph is six seconds — the horizon must not override the telegraph');
});

test('a zero-length step advances nothing and fires nothing twice', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 2, upset: 'DEMAND_SURGE', mag: 0.5 }] });
  drive(dir, ctx, 3);
  const t = dir.t_s;
  const demand = ctx.plant.demandTarget;
  for (let i = 0; i < 20; i += 1) {
    const r = stepDirector(dir, ctx, sim, 0);
    assert.equal(r.fired.length, 0, 'a zero-length step re-fired an upset that had already landed');
  }
  assert.equal(dir.t_s, t, 'a zero-length step moved the director clock');
  assert.equal(ctx.plant.demandTarget, demand, 'a zero-length step disturbed the plant');
});

test('an upset due at exactly zero seconds fires on the first step rather than being missed', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 0, upset: 'DEMAND_SURGE', mag: 0.5 }] });
  const r = stepDirector(dir, ctx, sim, SCAN);
  assert.equal(r.fired.length, 1, 'an upset scheduled at t=0 never landed');
});

test('the intensity multiplier scales magnitude without reversing a supervisor order', () => {
  const dir = createDirector({
    intensity: 2,
    script: [
      { at_s: 5, upset: 'DEMAND_SURGE', mag: 0.3 },
      { at_s: 6, upset: 'SP_CHANGE', mag: -0.3 },
    ],
  });
  const t = upcoming(dir, 60);
  const surge = t.find((x) => x.id === 'DEMAND_SURGE');
  const spc = t.find((x) => x.id === 'SP_CHANGE');
  assert.ok(Math.abs(surge.mag - 0.6) < 1e-9, `intensity 2 turned mag 0.3 into ${surge.mag}`);
  assert.ok(spc.mag < 0, `a downward setpoint order came back as ${spc.mag} — intensity must not flip direction`);
  assert.ok(Math.abs(spc.mag + 0.6) < 1e-9, `intensity 2 turned mag -0.3 into ${spc.mag}`);
});

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

test('the director refuses nonsense rather than throwing it at the render loop', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 1, upset: 'DEMAND_SURGE', mag: 0.5 }] });

  for (const bad of [NaN, -1, undefined, 'soon']) {
    const r = stepDirector(dir, ctx, sim, bad);
    assert.equal(r.ok, false, `a step of ${String(bad)} was accepted`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `a refusal of ${String(bad)} carried no reason`);
    assert.deepEqual(r.fired, [], 'a refused step still fired something');
  }
  assert.equal(dir.t_s, 0, 'a refused step still moved the clock');
  assert.equal(stepDirector(null, ctx, sim, 1).ok, false, 'a missing director was not refused');
  assert.equal(stepDirector(dir, null, sim, 1).ok, false, 'a missing sim context was not refused');
  assert.equal(stepDirector(dir, ctx, null, 1).ok, false, 'a missing action surface was not refused');
  assert.deepEqual(upcoming(null), [], 'upcoming on a missing director should be empty, not an exception');
});

test('a script naming an upset that does not exist is reported, not thrown', () => {
  const dir = createDirector({
    script: [
      { at_s: 1, upset: 'NOT_A_REAL_UPSET', mag: 0.5 },
      { at_s: 2, upset: 'DEMAND_SURGE', mag: 0.5 },
      null,
    ],
  });
  assert.equal(dir.queue.length, 1, 'a bad script entry was queued anyway');
  assert.equal(dir.problems.length, 2, `the bad entries were not reported: ${JSON.stringify(dir.problems)}`);
  assert.match(dir.problems[0], /NOT_A_REAL_UPSET/, 'the problem does not name the upset it could not find');
});

test('a director built with no options at all is inert rather than broken', () => {
  const ctx = simFor(0);
  const dir = createDirector();
  const r = stepDirector(dir, ctx, sim, 10);
  assert.equal(r.ok, true, `an empty director refused to run: ${r.reason}`);
  assert.deepEqual(r.fired, [], 'an empty director fired something');
  assert.deepEqual(upcoming(dir), [], 'an empty director has something on its ticker');
});

test('endless mode without a generator schedules nothing rather than inventing randomness', () => {
  const dir = createDirector({ endless: true });
  assert.equal(dir.queue.length, 0, 'endless mode composed a wave with no seeded generator to compose it from');
  assert.deepEqual(endlessWave(null, 3), [], 'endlessWave invented a wave without a generator');
});

// ---------------------------------------------------------------------------------------------
// Reversibility
// ---------------------------------------------------------------------------------------------

test('every upset in the table can be applied and reverted, and the rig comes back to where it started', () => {
  for (const id of Object.keys(UPSETS)) {
    const ctx = simFor(0);
    const before = snapshot(ctx);
    const dir = createDirector({ script: [{ at_s: 0, upset: id, mag: 0.7 }], rng: rngOf(7) });
    const r = stepDirector(dir, ctx, sim, SCAN);
    assert.equal(r.fired.length, 1, `${id} did not fire`);
    // Let the ones that develop over time develop, so the revert has something to undo.
    drive(dir, ctx, 200);
    revertAll(dir, ctx, sim);
    assert.deepEqual(snapshot(ctx), before,
      `${id} did not put the rig back — the next mission of the session would be played on its wreckage`);
    assert.deepEqual(dir.problems, [], `${id} reported problems: ${JSON.stringify(dir.problems)}`);
  }
});

test('the whole table applied at once unwinds to the state it started from', () => {
  const ctx = simFor(0);
  const before = snapshot(ctx);
  const ids = Object.keys(UPSETS);
  const dir = createDirector({
    rng: rngOf(11),
    script: ids.map((id, i) => ({ at_s: i * 2, upset: id, mag: 0.6 })),
  });
  drive(dir, ctx, ids.length * 2 + 300);
  assert.equal(dir.active.length, ids.length, 'not every upset stayed active to be reverted');
  revertAll(dir, ctx, sim);
  assert.deepEqual(snapshot(ctx), before,
    'the table applied together did not unwind — a restore must undo what it personally overwrote, newest first');
  assert.notEqual(ctx.plant.drv[0].state, 'TRIPPED', 'a machine was left locked out for the next run');
  assert.notEqual(ctx.plant.drv[1].state, 'TRIPPED', 'a machine was left locked out for the next run');
  assert.deepEqual(dir.active, [], 'revertAll left upsets on the active list');
});

test('two upsets writing the same field unwind to the value the first of them found', () => {
  const ctx = simFor(0);
  const start = ctx.plant.demandTarget;
  const dir = createDirector({
    script: [
      { at_s: 0, upset: 'DEMAND_SURGE', mag: 0.8 },
      { at_s: 2, upset: 'DEMAND_COLLAPSE', mag: 0.8 },
    ],
  });
  drive(dir, ctx, 5);
  assert.notEqual(ctx.plant.demandTarget, start, 'neither upset moved the demand valve');
  revertAll(dir, ctx, sim);
  assert.ok(Math.abs(ctx.plant.demandTarget - start) < 1e-12,
    `demand came back to ${ctx.plant.demandTarget} instead of ${start} — unwinding forwards leaves the second overwrite in place`);
});

test('revertAll on a director that never fired anything is a no-op, not a crash', () => {
  const ctx = simFor(0);
  const before = snapshot(ctx);
  const dir = createDirector({ script: [{ at_s: 500, upset: 'PUMP_TRIP', mag: 1 }] });
  revertAll(dir, ctx, sim);
  revertAll(dir, null, null);
  assert.deepEqual(snapshot(ctx), before, 'reverting nothing changed the rig');
});

test('an upset that develops over time keeps moving the plant while it is active and stops when reverted', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 0, upset: 'FOULING', mag: 1 }] });
  stepDirector(dir, ctx, sim, SCAN);
  const early = ctx.plant.foul;
  drive(dir, ctx, 60);
  const later = ctx.plant.foul;
  assert.ok(later > early + 0.05,
    `the strainer only blinded from ${early.toFixed(3)} to ${later.toFixed(3)} in a minute — a ramp that does not ramp is a step nobody warned about`);
  revertAll(dir, ctx, sim);
  const clean = ctx.plant.foul;
  drive(dir, ctx, 60);
  assert.equal(ctx.plant.foul, clean, 'a reverted ramp kept running');
});

test('transmitter noise moves the reading and not the header, and stops when it is reverted', () => {
  const ctx = simFor(0);
  const dir = createDirector({ script: [{ at_s: 0, upset: 'NOISE', mag: 1 }], rng: rngOf(3) });
  const trueP = ctx.plant.p_bar;
  stepDirector(dir, ctx, sim, SCAN);
  let moved = 0;
  let prev = ctx.plant.pt_bar;
  for (let i = 0; i < 40; i += 1) {
    stepDirector(dir, ctx, sim, SCAN);
    if (ctx.plant.pt_bar !== prev) moved += 1;
    prev = ctx.plant.pt_bar;
  }
  assert.ok(moved > 30, `the transmitter reading only changed on ${moved} of 40 scans`);
  assert.equal(ctx.plant.p_bar, trueP, 'the noise upset moved the actual header pressure — it is an instrument fault, not a process one');

  revertAll(dir, ctx, sim);
  const held = ctx.plant.pt_bar;
  drive(dir, ctx, 10);
  assert.equal(ctx.plant.pt_bar, held, 'the noise kept being injected after the upset was reverted');
});

// ---------------------------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------------------------

/**
 * How hard a wave is: the severity-weighted magnitude it delivers per second of wall time, which
 * is the only figure that folds "more upsets", "bigger upsets" and "closer together" into one
 * number an assertion can compare.
 * @param {Array<object>} wave the wave
 * @returns {number} pressure, severity-magnitude per second
 */
function pressureOf(wave) {
  if (!wave.length) return 0;
  const span = Math.max(1, wave[wave.length - 1].at_s - wave[0].at_s + 20);
  let sum = 0;
  for (const e of wave) sum += UPSETS[e.upset].severity * Math.abs(e.mag);
  return sum / span;
}

test('wave ten is meaningfully harder than wave one on every dial escalation moves', () => {
  const rng = rngOf(20240607);
  const w1 = endlessWave(rng, 1);
  const w10 = endlessWave(rng, 10);

  assert.ok(w10.length > w1.length,
    `wave 10 has ${w10.length} upsets against wave 1's ${w1.length} — escalation must add upsets`);

  const mean = (w) => w.reduce((a, e) => a + Math.abs(e.mag), 0) / w.length;
  assert.ok(mean(w10) > mean(w1) + 0.15,
    `mean magnitude only went from ${mean(w1).toFixed(2)} to ${mean(w10).toFixed(2)}`);

  const minTel = (w) => w.reduce((a, e) => Math.min(a, e.telegraph_s), Infinity);
  assert.ok(minTel(w10) < minTel(w1),
    `the shortest telegraph did not shorten: wave 1 ${minTel(w1)} s, wave 10 ${minTel(w10)} s`);

  assert.ok(pressureOf(w10) > 2 * pressureOf(w1),
    `severity-weighted pressure only went from ${pressureOf(w1).toFixed(3)} to ${pressureOf(w10).toFixed(3)} per second`);
});

test('escalation stops shortening the telegraph at the readable floor', () => {
  const rng = rngOf(5);
  for (let w = 1; w <= 40; w += 1) {
    for (const e of endlessWave(rng, w)) {
      assert.ok(e.telegraph_s >= TELEGRAPH_FLOOR_S,
        `wave ${w} issued a ${e.telegraph_s.toFixed(2)} s telegraph — below ${TELEGRAPH_FLOOR_S} s there is no time to read the label, decide and move a control`);
      assert.ok(Math.abs(e.mag) <= 1, `wave ${w} produced a magnitude of ${e.mag}, which no upset knows how to interpret`);
      assert.ok(e.at_s >= 0 && Number.isFinite(e.at_s), `wave ${w} scheduled an upset at ${e.at_s}`);
      assert.ok(UPSETS[e.upset], `wave ${w} named an upset that is not in the table: ${e.upset}`);
    }
  }
});

test('an early wave draws only from the nuisances and a late one from everything', () => {
  const rng = rngOf(99);
  let worstEarly = 0;
  for (let k = 0; k < 40; k += 1) {
    for (const e of endlessWave(rng, 1)) worstEarly = Math.max(worstEarly, UPSETS[e.upset].severity);
  }
  assert.ok(worstEarly <= 2,
    `wave 1 threw a severity-${worstEarly} upset — losing a machine in the first minute is not an escalation, it is an ambush`);

  let worstLate = 0;
  for (let k = 0; k < 40; k += 1) {
    for (const e of endlessWave(rng, 12)) worstLate = Math.max(worstLate, UPSETS[e.upset].severity);
  }
  assert.equal(worstLate, 5, 'by wave 12 the worst upsets should be in the pool');
});

test('the same seed gives the same wave, so a share code reproduces a run', () => {
  assert.deepEqual(endlessWave(rngOf(1234), 6), endlessWave(rngOf(1234), 6),
    'two generators seeded the same way composed different waves');
  assert.notDeepEqual(endlessWave(rngOf(1234), 6), endlessWave(rngOf(1235), 6),
    'two different seeds composed the same wave');
});

test('endless mode keeps the ticker fed without a script and never fires the same event twice', () => {
  const ctx = simFor(0);
  const dir = createDirector({ endless: true, rng: rngOf(77) });
  assert.ok(dir.wave >= 1, 'endless mode did not compose its first wave until it was stepped');

  const { fired } = drive(dir, ctx, 600);
  assert.ok(fired.length >= 8, `only ${fired.length} upsets landed in ten minutes of endless play`);
  assert.ok(dir.wave >= 3, `only ${dir.wave} waves were composed in ten minutes`);

  const seen = new Set();
  for (const f of fired) {
    const key = `${f.id}@${f.at_s}`;
    assert.ok(!seen.has(key), `${key} fired more than once`);
    seen.add(key);
  }
  const late = fired.filter((f) => f.t_s - f.at_s > SCAN + 1e-9);
  assert.equal(late.length, 0, `${late.length} endless upsets fired late`);

  revertAll(dir, ctx, sim);
  assert.deepEqual(dir.active, [], 'endless play left upsets applied at the end of the shift');
});
