/**
 * tests/scenarios2.test.js — the twenty station scenarios, and the weighting that grades them.
 *
 * Two kinds of claim are made here and they need different evidence.
 *
 * The cheap kind is structural: every step names an action the runner actually implements, every
 * weight names a component that exists, the times are ordered and inside the duration. Those are
 * checked against the whole table, because the failure they prevent is the worst one available to
 * a scripted test — a step with a misspelled action is silently ignored by `applyStep`, so the
 * scenario still runs, still completes and still produces a confident score, having measured
 * nothing that it claimed to.
 *
 * The expensive kind is behavioural, and there is no substitute for running the plant: eight of
 * these are driven end to end through a real simulation and asked to prove they did what their
 * briefing says — that the sag actually stopped both machines, that the stuck bypass really was
 * pumping back to the tank, that the fire draw really did pull the header down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, advance } from '../src/core/sim.js';
import { SCENARIOS } from '../src/control/scenario.js';
import { DRIVE } from '../src/process/motor.js';
import {
  SCENARIOS2, SCENARIOS2_BY_ID, DEFAULT_WEIGHTS, findScenario2, beginScenario2, gradeScenario2,
} from '../src/content/scenarios2.js';

/**
 * Every action `control/scenario.js::applyStep` implements.
 *
 * Written out rather than imported because there is nothing to import — the runner's vocabulary is
 * a switch statement. That makes this list the contract, and a scenario naming anything outside it
 * would be dead script rather than a failing test.
 */
const RUNNER_ACTIONS = new Set([
  'spDelta', 'sp', 'demand', 'slam', 'discharge', 'foul', 'fluid', 'supplyTemp', 'tankTemp',
  'makeup', 'level', 'finalElement', 'recirc', 'stiction', 'wear', 'trip', 'reset',
]);

/** The components {@link gradeScenario2} knows how to grade. */
const COMPONENT_IDS = new Set([
  'iae', 'overshoot', 'settle', 'travel', 'starts', 'peak', 'saturation', 'energy',
]);

/**
 * A plausible finished result, for grading tests that have no business running a plant.
 * @param {object} [over] fields to override
 * @returns {object} a result of the shape `control/scenario.js::summarise` returns
 */
function fakeResult(over) {
  return {
    t_s: 600,
    iae: 30,
    itae: 9000,
    peakErr: 0.4,
    coTravel: 120,
    starts: 2,
    energy_kWh: 0.6,
    volume_m3: 4,
    specific_kWh_m3: 0.15,
    satTime_s: 20,
    minFlowTime_s: 0,
    cavTime_s: 0,
    overshootPct: 8,
    settle_s: 20,
    steps: [],
    ...over,
  };
}

/**
 * Run a scenario end to end on a real simulation, sampling the plant on the way through.
 * @param {string} id one of the {@link SCENARIOS2} ids
 * @param {Array<{at_s:number, check:(ctx:object)=>void}>} [probes] mid-run assertions
 * @returns {object} the sim context, after the test has completed and been scored
 */
function runScenario(id, probes = []) {
  const ctx = createSim();
  const dt = ctx.config.dt_s;
  const tick = () => advance(ctx, dt);
  // A short lead-in first: the rig boots settled, but a scenario that starts on tick zero is
  // grading the very first controller scan, and none of these are tests of that.
  for (let i = 0; i < Math.round(20 / dt); i += 1) tick();

  const started = beginScenario2(ctx, id);
  assert.equal(started.ok, true, `${id} refused to start: ${started.reason}`);
  const def = started.def;
  const t0 = ctx.run.t_s;
  const pending = probes.slice().sort((a, b) => a.at_s - b.at_s);

  for (let i = 0; i < Math.round((def.duration_s + 5) / dt); i += 1) {
    tick();
    while (pending.length && ctx.run.t_s - t0 >= pending[0].at_s) pending.shift().check(ctx);
  }
  assert.equal(pending.length, 0, `${id}: ${pending.length} probes never fired`);
  return ctx;
}

// ============================================================================================
// The table itself
// ============================================================================================

test('twenty scenarios, each with a unique id that does not collide with the shipped table', () => {
  assert.equal(SCENARIOS2.length, 20);
  const ids = SCENARIOS2.map((s) => s.id);
  assert.equal(new Set(ids).size, 20, 'duplicate id in scenarios2');
  const shipped = new Set(SCENARIOS.map((s) => s.id));
  for (const id of ids) {
    assert.ok(!shipped.has(id), `${id} collides with a scenario in control/scenario.js`);
    assert.equal(SCENARIOS2_BY_ID[id].id, id);
    assert.equal(findScenario2(id).id, id);
  }
  assert.equal(findScenario2('NOT_A_TEST'), null);
});

test('every step is something the runner can actually apply, in order and inside the run', () => {
  for (const def of SCENARIOS2) {
    assert.ok(def.name && def.blurb, `${def.id} needs a name and a briefing`);
    assert.ok(def.duration_s > 0, `${def.id} has no duration`);
    assert.ok(def.steps.length > 0, `${def.id} scripts nothing`);
    let last = -1;
    for (const s of def.steps) {
      assert.ok(RUNNER_ACTIONS.has(s.action), `${def.id}: "${s.action}" is not a runner action`);
      assert.ok(s.label, `${def.id}: a step with no label is a blank line in the log`);
      assert.ok(s.t >= 0 && s.t < def.duration_s,
        `${def.id}: step at ${s.t} s is outside the ${def.duration_s} s run`);
      assert.ok(s.t >= last, `${def.id}: steps must be in time order — ${s.t} follows ${last}`);
      last = s.t;
      if (s.action === 'demand' || s.action === 'slam' || s.action === 'foul') {
        assert.ok(s.value >= 0 && s.value <= 1, `${def.id}: ${s.action} takes a fraction`);
      }
      if (s.action === 'trip' || s.action === 'reset') {
        assert.ok(s.value === 0 || s.value === 1, `${def.id}: ${s.action} takes a pump index`);
      }
    }
  }
});

test('every weight and reference names a component that is graded', () => {
  for (const def of SCENARIOS2) {
    assert.ok(def.weights, `${def.id} has no weighting`);
    let total = 0;
    for (const [id, w] of Object.entries(def.weights)) {
      assert.ok(COMPONENT_IDS.has(id), `${def.id}: no component named ${id}`);
      assert.ok(w > 0, `${def.id}: ${id} has a non-positive weight`);
      total += w;
    }
    assert.ok(total > 0, `${def.id} weights nothing`);
    for (const [id, v] of Object.entries(def.refs || {})) {
      assert.ok(COMPONENT_IDS.has(id), `${def.id}: reference for unknown component ${id}`);
      assert.ok(v > 0, `${def.id}: the ${id} reference must be positive`);
    }
    for (const [k, v] of Object.entries(def.penaltyScale || {})) {
      assert.ok(k === 'cavitation' || k === 'minFlow', `${def.id}: unknown penalty ${k}`);
      assert.ok(v >= 0, `${def.id}: negative penalty scale`);
    }
    // Every definition must grade cleanly against a plausible result, so a typo in the table is a
    // failing test here rather than a refusal on somebody's screen an hour into a run.
    const g = gradeScenario2(def, fakeResult());
    assert.equal(g.ok, true, `${def.id}: ${g.reason}`);
    assert.ok(Number.isFinite(g.score) && g.score >= 0 && g.score <= 100);
  }
});

test('the table is frozen, so a UI cannot edit the test it is running', () => {
  assert.ok(Object.isFrozen(SCENARIOS2));
  assert.ok(Object.isFrozen(SCENARIOS2[0].steps));
  assert.ok(Object.isFrozen(SCENARIOS2[0].weights));
});

// ============================================================================================
// Eight of them, end to end, against the plant
// ============================================================================================

const END_TO_END = [
  'MORNING_RAMP', 'FIRE_DRAW', 'VALVE_SLAM_SHUT', 'TRIP_LOADED',
  'CHECK_STUCK', 'GRID_SAG', 'STAGE_CHATTER', 'COLD_START',
];

for (const id of END_TO_END) {
  test(`${id} runs to completion on a real sim and produces a finite score`, () => {
    const def = findScenario2(id);
    const ctx = runScenario(id);

    assert.equal(ctx.scenario.def, null, `${id} was still running after its duration`);
    assert.equal(ctx.scenario.lastId, id);
    const r = ctx.scenario.last;
    assert.ok(r, `${id} produced no result`);
    assert.ok(Number.isFinite(r.score), `${id} scored ${r.score}`);
    assert.ok(r.score >= 0 && r.score <= 100);
    assert.ok(Number.isFinite(r.iae) && r.iae > 0, `${id} accumulated no error at all`);
    assert.ok(Number.isFinite(r.coTravel));
    assert.ok(Math.abs(r.t_s - def.duration_s) < 2,
      `${id} graded ${r.t_s} s of a ${def.duration_s} s test`);

    // Every scripted step must appear in the log. A step whose time is past the duration, or that
    // the runner declined to apply, would otherwise vanish without trace.
    const logged = ctx.scenario.log.map((l) => l.label);
    for (const s of def.steps) assert.ok(logged.includes(s.label), `${id}: "${s.label}" never fired`);

    const g = gradeScenario2(id, r);
    assert.equal(g.ok, true, `${id}: ${g.reason}`);
    assert.ok(Number.isFinite(g.score) && g.score >= 0 && g.score <= 100,
      `${id} regraded to ${g.score}`);
    assert.ok(g.parts.length > 0);
    assert.ok(g.parts.some((p) => p.applicable), `${id} graded on no evidence at all`);
  });
}

// ============================================================================================
// Each of those did what its briefing says it does
// ============================================================================================

test('the grid sag stops both machines and the station comes back', () => {
  let sagged = false;
  const ctx = runScenario('GRID_SAG', [
    {
      at_s: 118,
      check: (c) => {
        sagged = c.plant.drv.every((d) => d.state === DRIVE.TRIPPED);
        assert.ok(sagged, 'the sag left a drive running');
      },
    },
  ]);
  assert.ok(sagged);
  const running = ctx.plant.drv.filter((d) => d.state === DRIVE.RUNNING).length;
  assert.ok(running >= 1, 'nothing restarted after the bus recovered');
  assert.ok(ctx.plant.p_bar > 2.5, `the header never recovered — ${ctx.plant.p_bar.toFixed(2)} bar`);
});

test('the stuck recirculation really is pumping back to the tank', () => {
  let bypassWhileDrawing = 0;
  let demandFlow = 0;
  const ctx = runScenario('CHECK_STUCK', [
    {
      at_s: 400,
      check: (c) => { bypassWhileDrawing = c.plant.Qbypass_m3h; demandFlow = c.plant.Qdemand_m3h; },
    },
  ]);
  assert.ok(demandFlow > 15, `the process was not drawing — ${demandFlow.toFixed(1)} m3/h`);
  assert.ok(bypassWhileDrawing > 1,
    `the bypass closed when it was supposed to be stuck — ${bypassWhileDrawing.toFixed(2)} m3/h`);
  // And once it is freed the recirculation shuts on its own, or the test has proved nothing.
  assert.ok(ctx.plant.Qbypass_m3h < bypassWhileDrawing,
    'the recirculation never closed after being put back in auto');
});

test('the fire draw empties the header and the set stages up to answer it', () => {
  const ctx = runScenario('FIRE_DRAW');
  const r = ctx.scenario.last;
  assert.ok(r.peakErr > 0.3, `the draw barely moved the header — ${r.peakErr.toFixed(2)} bar`);
  assert.ok(r.starts >= 1, 'the standby never joined for a full-bore draw');
  assert.ok(r.volume_m3 > 8, `only ${r.volume_m3.toFixed(1)} m3 was delivered`);
});

test('the chattering sequence short-cycles, and the score says so where it hurts', () => {
  const ctx = runScenario('STAGE_CHATTER');
  const r = ctx.scenario.last;
  assert.ok(r.starts > 8, `only ${r.starts} transitions — the sequence did not chatter`);
  const g = gradeScenario2('STAGE_CHATTER', r);
  const starts = g.parts.find((p) => p.id === 'starts');
  assert.ok(starts.earned < 0.25 * starts.weight, 'short-cycling was not punished');
  assert.ok(g.score < 40, `a set that started ${r.starts} times scored ${g.score.toFixed(0)}`);
});

test('the lead trip is picked up by the standby', () => {
  let trippedUnderLoad = false;
  const ctx = runScenario('TRIP_LOADED', [
    { at_s: 200, check: (c) => { trippedUnderLoad = c.plant.drv[0].state === DRIVE.TRIPPED; } },
  ]);
  assert.ok(trippedUnderLoad, 'P-101 was not tripped after its trip step');
  assert.ok(ctx.plant.drv.some((d) => d.state === DRIVE.RUNNING), 'the station never recovered');
  assert.ok(ctx.plant.p_bar > 2.5, `the header was left at ${ctx.plant.p_bar.toFixed(2)} bar`);
});

test('the commissioning walk-up ends on the duty setpoint with the load on', () => {
  const ctx = runScenario('COLD_START');
  assert.ok(Math.abs(ctx.pid.sp - 3.2) < 0.01, `finished on SP ${ctx.pid.sp}`);
  assert.ok(Math.abs(ctx.plant.p_bar - 3.2) < 0.25,
    `the header finished at ${ctx.plant.p_bar.toFixed(2)} bar`);
  assert.ok(ctx.plant.level_m > 1.2, 'the make-up never refilled the tank');
});

// ============================================================================================
// The grading
// ============================================================================================

test('the runner weighting regrades to exactly what the runner scored', () => {
  const ctx = runScenario('VALVE_SLAM_SHUT');
  const r = ctx.scenario.last;
  const g = gradeScenario2({
    id: 'CHECK', name: 'check', weights: DEFAULT_WEIGHTS, penaltyScale: { cavitation: 1, minFlow: 1 },
  }, r);
  assert.equal(g.ok, true);
  // Not "close enough": the five standard components deliberately reuse the runner's own reference
  // values, and any drift between the two scorecards would make every comparison between a shipped
  // test and one of these meaningless.
  assert.ok(Math.abs(g.score - r.score) < 1e-9,
    `regraded ${g.score} against the runner's ${r.score}`);
});

test('a scenario weighting changes the verdict on the same run', () => {
  const r = fakeResult({ starts: 12, coTravel: 400, iae: 20 });
  const chatter = gradeScenario2('STAGE_CHATTER', r);
  const fire = gradeScenario2('FIRE_DRAW', r);
  assert.equal(chatter.ok, true);
  assert.equal(fire.ok, true);
  // Twelve starts is a disaster for a sequence test and irrelevant during a fire draw. A scorecard
  // that returns the same number for both is not weighting anything.
  assert.ok(chatter.score < fire.score - 10,
    `chatter ${chatter.score.toFixed(1)} vs fire ${fire.score.toFixed(1)}`);
});

test('a scenario reference of its own is what catches a drift', () => {
  // 0.13 kWh/m3 is unremarkable against the generic 0.15 and poor against what this same duty
  // costs when the transmitter is right, which is exactly why the drift test states its own.
  const r = fakeResult({ specific_kWh_m3: 0.13 });
  const withOwn = gradeScenario2('TX_DRIFT', r);
  const withGeneric = gradeScenario2({ ...findScenario2('TX_DRIFT'), refs: undefined }, r);
  assert.equal(withOwn.ok, true);
  assert.equal(withGeneric.ok, true);
  assert.ok(withOwn.score < withGeneric.score - 5,
    `own ${withOwn.score.toFixed(1)} vs generic ${withGeneric.score.toFixed(1)}`);
});

test('cavitation is scaled by the event, and cannot be weighted away', () => {
  const r = fakeResult({ cavTime_s: 30 });
  const pocket = gradeScenario2('AIR_POCKET', r);
  const swap = gradeScenario2('FLUID_SWAP', r);
  assert.ok(pocket.penalties.cavitation > swap.penalties.cavitation,
    'breaking suction during an air pocket should cost more than during a fluid change');
  for (const def of SCENARIOS2) {
    const g = gradeScenario2(def, fakeResult({ cavTime_s: 300, minFlowTime_s: 300 }));
    assert.ok(g.score < 70, `${def.id} scored ${g.score.toFixed(0)} after half a run cavitating`);
  }
});

test('a component with no evidence is dropped, not awarded free marks', () => {
  // A load test never moves the setpoint, so `overshootPct` comes back NaN. Dropping it must
  // renormalise the rest rather than score a zero or a hundred for a question nobody asked.
  const r = fakeResult({ overshootPct: NaN });
  const g = gradeScenario2('ACCEPTANCE', r);
  assert.equal(g.ok, true);
  assert.ok(Number.isFinite(g.score));
  const overshoot = g.parts.find((p) => p.id === 'overshoot');
  assert.equal(overshoot.applicable, false);
  assert.ok(Number.isNaN(overshoot.earned));
  const applied = g.parts.filter((p) => p.applicable).reduce((a, p) => a + p.earned, 0);
  assert.ok(Math.abs(applied - g.score) < 1e-9, 'the surviving weights were not renormalised');
});

// ============================================================================================
// Refusals
// ============================================================================================

test('the entry points refuse rather than half-work', () => {
  assert.deepEqual(gradeScenario2('NOPE', fakeResult()), { ok: false, reason: 'unknown test NOPE' });
  assert.equal(gradeScenario2('FIRE_DRAW', null).ok, false);
  assert.equal(gradeScenario2('FIRE_DRAW', fakeResult({ t_s: 0 })).ok, false);

  const typo = gradeScenario2({ id: 'TYPO', weights: { iea: 10 } }, fakeResult());
  assert.equal(typo.ok, false);
  assert.match(typo.reason, /no graded component named iea/);

  const badRef = gradeScenario2({ id: 'BAD', weights: { iae: 10 }, refs: { energy: 0 } }, fakeResult());
  assert.equal(badRef.ok, false);
  assert.match(badRef.reason, /reference must be positive/);

  const ctx = createSim();
  assert.equal(beginScenario2(ctx, 'NOPE').ok, false);
  assert.equal(beginScenario2(null, 'FIRE_DRAW').ok, false);
  assert.equal(beginScenario2(ctx, 'FIRE_DRAW').ok, true);
  const second = beginScenario2(ctx, 'MORNING_RAMP');
  assert.equal(second.ok, false);
  assert.match(second.reason, /already running/);
});

test('a flow test would be graded against its own span, not PT-101\'s', () => {
  // The default span is 8 bar because every test here is a pressure test. Grading a 150 m3/h loop
  // against it would call a competent flow loop a failure, so the span is an argument.
  const r = fakeResult({ iae: 400 });
  const asPressure = gradeScenario2('ACCEPTANCE', r);
  const asFlow = gradeScenario2('ACCEPTANCE', r, { span: 150 });
  assert.ok(asFlow.score > asPressure.score + 10,
    `${asFlow.score.toFixed(1)} vs ${asPressure.score.toFixed(1)}`);
});
