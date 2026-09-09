/**
 * tests/missions.test.js — the campaign table.
 *
 * A mission table is data, so almost every way it can be wrong is a typo that no code path
 * notices until a player reaches that mission and it does nothing, or does the wrong thing, or
 * hands out a feature twice. `validateMissions` is where those checks live and the first test
 * here is simply that it finds nothing; the rest guard the claims the campaign makes about
 * itself — the difficulty curve, the unlock order, the progression — and the nonsense inputs the
 * lookup functions get handed by a UI that is drawing before a profile has loaded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MISSIONS, TIERS, UNLOCK_IDS, UPSET_IDS, UPSET_MAG, SETUP_ACTIONS, RULE_DEFAULTS,
  DEMAND_CEILING, missionById, missionsForTier, availableMissions, nextMission,
  validateMissions, bandFraction, missionCleared, missionNeeds,
} from '../src/game/missions.js';
import { UNLOCKS, BASE_UNLOCK } from '../src/game/profile.js';
import { UPSETS } from '../src/game/director.js';
import { LOOP_EU } from '../src/data/config.js';

/**
 * A profile with a given set of missions cleared.
 * @param {...string} ids mission ids to mark cleared
 * @returns {object} a profile-shaped object
 */
function cleared(...ids) {
  const missions = {};
  for (const id of ids) missions[id] = { best: 4000, medal: 'silver', clears: 1 };
  return { missions };
}

/** @returns {object} a profile with the whole campaign cleared */
function allCleared() {
  return cleared(...MISSIONS.map((m) => m.id));
}

test('the shipped campaign passes its own validator', () => {
  const problems = validateMissions();
  assert.deepEqual(problems, [],
    'every one of these is a mission a player would reach and find broken');
});

test('the campaign is five tiers and at least twenty missions', () => {
  assert.equal(TIERS.length, 5, 'the tier structure is what the unlock order hangs off');
  assert.ok(MISSIONS.length >= 20,
    `a campaign of ${MISSIONS.length} missions cannot pace out ${UNLOCK_IDS.length} unlocks`);
  for (const t of TIERS) {
    assert.ok(missionsForTier(t.n).length >= 4,
      `tier ${t.n} has too few missions to teach ${t.feature} and then test it`);
  }
});

test('the band never widens as the campaign goes on', () => {
  // Compared as a fraction of transmitter span, because two missions run on FIC-101 and 2.6 m3/h
  // is not comparable with 0.15 bar in any other way.
  let prev = Infinity;
  for (const m of MISSIONS) {
    const frac = bandFraction(m);
    assert.ok(Number.isFinite(frac) && frac > 0, `${m.id} has no usable band`);
    assert.ok(frac <= prev + 1e-12,
      `${m.id} is easier to hold than the mission before it — the curve has gone backwards`);
    prev = frac;
  }
  // And the same claim tier by tier, on the headline number the player actually reads.
  let prevTierMax = Infinity;
  for (const t of TIERS) {
    const worst = Math.max(...missionsForTier(t.n).map(bandFraction));
    assert.ok(worst <= prevTierMax + 1e-12,
      `tier ${t.n} opens wider than tier ${t.n - 1} closed`);
    prevTierMax = worst;
  }
});

test('the gold threshold never falls as the campaign goes on', () => {
  let prev = -Infinity;
  for (const m of MISSIONS) {
    assert.ok(m.par.gold >= prev,
      `${m.id} asks ${m.par.gold} for gold after a mission that asked ${prev} — a later shift `
      + 'that is cheaper to medal makes the campaign order meaningless');
    prev = m.par.gold;
  }
});

test('every mission has three ascending medal thresholds', () => {
  for (const m of MISSIONS) {
    assert.ok(m.par.bronze > 0, `${m.id} has a bronze threshold of ${m.par.bronze}`);
    assert.ok(m.par.silver > m.par.bronze, `${m.id} silver is not above bronze`);
    assert.ok(m.par.gold > m.par.silver, `${m.id} gold is not above silver`);
  }
});

test('the first tier starts wide enough to hold by hand and the last finishes tight', () => {
  const first = MISSIONS[0];
  const last = MISSIONS[MISSIONS.length - 1];
  assert.equal(first.band, 0.25, 'a quarter of a bar is what a beginner can hold in manual');
  assert.equal(last.band, 0.05,
    'the final exam has to be tight enough that only a correct tuning holds it');
  // 0.05 bar against PT-101 noise of 0.006 bar: the band is about eight sigma, so it is a test of
  // control and not a test of luck.
  assert.ok(last.band > 6 * 0.006,
    'the final band must not be inside the transmitter noise, or nobody can hold it at all');
});

test('every shift is between ninety seconds and five minutes', () => {
  for (const m of MISSIONS) {
    assert.ok(m.duration_s >= 90,
      `${m.id} is ${m.duration_s} s — too short to reach the top multiplier, so holding well pays nothing`);
    assert.ok(m.duration_s <= 300,
      `${m.id} is ${m.duration_s} s — long enough that the player is waiting rather than deciding`);
  }
});

test('every scripted upset can be telegraphed and recovered from inside the shift', () => {
  for (const m of MISSIONS) {
    assert.ok(m.script.length > 0, `${m.id} has nothing happening in it`);
    let prev = -Infinity;
    for (const e of m.script) {
      assert.ok(e.at_s >= 12,
        `${m.id} fires ${e.upset} at ${e.at_s} s — the ticker cannot count it down in time`);
      assert.ok(e.at_s <= m.duration_s - 20,
        `${m.id} fires ${e.upset} with under 20 s left, which scores the upset and not the recovery`);
      assert.ok(e.at_s > prev, `${m.id} scripts ${e.upset} out of order`);
      assert.ok(typeof e.label === 'string' && e.label.length > 0,
        `${m.id} gives the ticker nothing to say about ${e.upset}`);
      assert.ok(Number.isFinite(e.mag), `${m.id} gives ${e.upset} a magnitude that is not a number`);
      prev = e.at_s;
    }
  }
});

test('the campaign uses every upset it declares and declares every upset it uses', () => {
  const used = new Set();
  for (const m of MISSIONS) for (const e of m.script) used.add(e.upset);
  for (const id of UPSET_IDS) {
    assert.ok(used.has(id), `${id} is declared with a magnitude convention nothing exercises`);
    assert.ok(UPSET_MAG[id], `${id} has no documented magnitude convention`);
  }
  for (const id of used) {
    assert.ok(UPSET_IDS.includes(id), `${id} is scripted but the director is never told about it`);
  }
  // The required set, spelled out, so dropping one is a failure here rather than a thin campaign.
  for (const id of ['DEMAND_SURGE', 'DEMAND_COLLAPSE', 'DEMAND_RAMP', 'LEVEL_SWING',
    'FLUID_CHANGE', 'FOULING', 'STICTION', 'NOISE', 'SCAN_SLOW', 'PUMP_TRIP', 'SUPPLY_SAG',
    'SP_CHANGE', 'VALVE_SLAM', 'BACKPRESSURE']) {
    assert.ok(used.has(id), `the campaign never puts the player through ${id}`);
  }
});

test('every feature is unlocked exactly once, and by a mission before it is needed', () => {
  const seen = new Set();
  for (const m of MISSIONS) {
    for (const u of m.unlocks) {
      assert.ok(UNLOCK_IDS.includes(u), `${m.id} unlocks ${u}, which is not a declared feature`);
      assert.ok(!seen.has(u), `${u} is handed out twice — the second time it is a dead reward`);
      seen.add(u);
    }
  }
  for (const u of UNLOCK_IDS) {
    assert.ok(seen.has(u), `${u} is declared but no mission ever grants it, so it is unreachable`);
  }
  const order = MISSIONS.map((m) => m.id);
  const grantedAt = (u) => order.findIndex((id) => missionById(id).unlocks.includes(u));
  const usesAt = (id) => order.indexOf(id);
  // The three features whose own mission would be impossible without them.
  assert.ok(grantedAt('cascade') < usesAt('INNER_LOOP'), 'the cascade mission needs cascade');
  assert.ok(grantedAt('feedforward') < usesAt('AHEAD_OF_IT'), 'the feedforward mission needs feedforward');
  assert.ok(grantedAt('gainSchedule') < usesAt('MOVING_TARGET'), 'the scheduling mission needs scheduling');
  // And the teaching order the campaign is built on.
  assert.ok(grantedAt('proportional') < grantedAt('reset'), 'reset before proportional teaches nothing');
  assert.ok(grantedAt('reset') < grantedAt('derivative'), 'derivative arrives after reset');
  assert.ok(grantedAt('derivative') < grantedAt('staging'), 'the loop is finished before the plant starts');
  assert.ok(grantedAt('staging') < grantedAt('cascade'), 'structures come last');
  assert.ok(grantedAt('autotune') > grantedAt('gainSchedule'),
    'the autotuner is the last thing earned — it is a shortcut past everything before it');
});

test('no shift is built on a feature the campaign has not handed over yet', () => {
  // The needs are recomputed here rather than taken from `missionNeeds`, so a derivation rule
  // that quietly stops firing shows up as a failure instead of as two modules agreeing about
  // nothing. Then the two are compared, which is the check that they have not drifted apart.
  const needsOf = (m) => {
    const out = new Set(m.needs);
    for (const s of m.setup) {
      const o = (s.args && typeof s.args[0] === 'object' && s.args[0]) || {};
      if (s.action === 'setControllerMode' && s.args[0] === 'AUTO') out.add('proportional');
      if (s.action === 'setStaging' && o.enabled === true) out.add('staging');
      if (s.action === 'setTuning') {
        // Ti is 1e6 and not Infinity in the rows where reset is switched out, because a mission
        // has to survive a JSON round trip. So integral is live only below a sane ceiling.
        if (Number.isFinite(o.Ti) && o.Ti < 1e5) out.add('reset');
        if (Number.isFinite(o.Td) && o.Td > 0) out.add('derivative');
      }
      if (s.action === 'setStrategy') {
        if (o.structure === 'CASCADE') out.add('cascade');
        if (o.ff) out.add('feedforward');
        if (o.sched) out.add('gainSchedule');
      }
    }
    return [...out].sort();
  };
  const granted = new Set();
  for (const m of MISSIONS) {
    assert.ok(Array.isArray(m.needs), `${m.id} has no needs list — [] if it needs nothing`);
    for (const f of needsOf(m)) {
      assert.ok(UNLOCK_IDS.includes(f), `${m.id} needs ${f}, which is not a declared feature`);
      assert.ok(granted.has(f),
        `${m.id} is built around ${f} but no mission before it grants it — the player arrives at `
        + 'this shift with the button its brief talks about still greyed out');
    }
    assert.deepEqual(missionNeeds(m).slice().sort(), needsOf(m),
      `missionNeeds(${m.id}) disagrees with what the mission row plainly says it stands on`);
    // Its own reward cannot be the thing it needs, or the gate is in front of the key.
    for (const u of m.unlocks) {
      assert.ok(!needsOf(m).includes(u), `${m.id} needs ${u} and also grants it`);
    }
    for (const u of m.unlocks) granted.add(u);
  }
});

test('missionNeeds survives the junk a share code can hand it', () => {
  for (const junk of [null, undefined, 0, '', 'MISSION', [], {}, { setup: 'no' },
    { needs: 'staging' }, { setup: [null, { action: 'setTuning' }] }]) {
    assert.ok(Array.isArray(missionNeeds(junk)),
      `missionNeeds(${JSON.stringify(junk)}) must be a list — the mission browser calls this while `
      + 'drawing, and a throw there is a blank campaign screen');
  }
  assert.deepEqual(missionNeeds({ needs: ['cascade'], setup: [] }), ['cascade']);
});

test('every prerequisite names a mission that is strictly earlier in the table', () => {
  const before = new Set();
  for (const m of MISSIONS) {
    for (const req of m.requires) {
      assert.ok(before.has(req),
        `${m.id} requires ${req}, which is not a mission before it — a shift that requires itself, `
        + 'or requires one further down the table, is a shift nobody is ever offered');
    }
    before.add(m.id);
  }
});

test('the prerequisite chain is acyclic and reaches every mission from a cold start', () => {
  const reached = new Set();
  let profile = null;
  for (let i = 0; i < MISSIONS.length + 2; i += 1) {
    const next = nextMission(profile);
    if (!next) break;
    assert.ok(!reached.has(next.id), `${next.id} was offered twice — the chain does not advance`);
    reached.add(next.id);
    profile = cleared(...reached);
  }
  assert.equal(reached.size, MISSIONS.length,
    'a player who clears everything offered must reach the end of the campaign');
  assert.equal(nextMission(allCleared()), null,
    'a finished campaign must report that it is finished rather than looping');
});

test('a fresh player is offered exactly one mission and it is the first one', () => {
  const open = availableMissions(null);
  assert.equal(open.length, 1, 'a cold start must not present a wall of locked-looking missions');
  assert.equal(open[0].id, MISSIONS[0].id);
  assert.equal(open[0].requires.length, 0, 'the opening mission cannot require anything');
});

test('a cleared mission stays available so it can be replayed for a better medal', () => {
  const p = cleared(MISSIONS[0].id);
  const open = availableMissions(p).map((m) => m.id);
  assert.ok(open.includes(MISSIONS[0].id), 'medals are pointless if a mission cannot be retaken');
  assert.ok(open.includes(MISSIONS[1].id), 'and clearing one must open the next');
  assert.equal(nextMission(p).id, MISSIONS[1].id,
    'the next mission is the first UNcleared one, not the first available one');
});

test('every mission sets the rig up through real, declarative sim actions', () => {
  for (const m of MISSIONS) {
    assert.ok(m.setup.length > 0, `${m.id} does not arrange the rig at all`);
    for (const s of m.setup) {
      assert.ok(SETUP_ACTIONS.includes(s.action),
        `${m.id} setup calls ${s.action}, which the campaign is not allowed to call`);
      assert.ok(Array.isArray(s.args), `${m.id} setup step ${s.action} has no argument list`);
      assert.equal(typeof s, 'object');
      assert.notEqual(typeof s.action, 'function',
        'setup must be serialisable — a closure cannot be shown on a brief card or shared');
    }
    assert.equal(JSON.parse(JSON.stringify(m.setup)).length, m.setup.length,
      `${m.id} setup does not survive a JSON round trip, so it cannot go in a share code`);
  }
});

test('a mission that names a loop mode sets a setpoint that fits inside that transmitter', () => {
  for (const m of MISSIONS) {
    const eu = LOOP_EU[m.loop];
    assert.ok(eu, `${m.id} names loop mode ${m.loop}`);
    const sp = m.setup.filter((s) => s.action === 'setSetpoint').map((s) => s.args[0]);
    for (const v of sp) {
      assert.ok(v > eu.lo && v < eu.hi,
        `${m.id} sets ${v} ${eu.unit}, which ${eu.pv} cannot measure — the action would refuse it`);
    }
    // SP_CHANGE carries a severity, not a setpoint: the director moves the header 6..16% of span
    // in the direction of the sign, and CLAMPS the result to the middle 15..75% of the
    // transmitter. A mission that walks the setpoint into that clamp gets a smaller step than it
    // scripted and a shift that quietly stops matching its own brief, so the walk is checked here.
    const span = eu.hi - eu.lo;
    let target = sp.length ? sp[sp.length - 1] : 3.2;
    for (const e of m.script.filter((x) => x.upset === 'SP_CHANGE')) {
      const moved = target + Math.sign(e.mag || 1) * (0.06 + 0.10 * Math.abs(e.mag)) * span;
      assert.ok(moved >= eu.lo + 0.15 * span && moved <= eu.lo + 0.75 * span,
        `${m.id} has the supervisor order ${moved.toFixed(2)} ${eu.unit}, which the director will `
        + 'clamp — the player would be scored against a step that never happened');
      target = moved;
    }
  }
});

test('a mission that changes loop mode does it before anything that depends on the mode', () => {
  for (const m of MISSIONS) {
    const at = m.setup.findIndex((s) => s.action === 'setLoopMode');
    if (at < 0) continue;
    const dependents = ['setSetpoint', 'setTuning', 'setControllerMode', 'setManualOutput'];
    for (let i = 0; i < at; i += 1) {
      assert.ok(!dependents.includes(m.setup[i].action),
        `${m.id} calls ${m.setup[i].action} before setLoopMode, and the mode switch resets both `
        + 'the setpoint and the tuning — the mission would start on the defaults');
    }
  }
});

test('every mission carries scoring rules that agree with its own band', () => {
  for (const m of MISSIONS) {
    assert.equal(m.rules.band, m.band,
      `${m.id} draws one band on the trend and scores against another`);
    assert.ok(m.rules.bandEU, `${m.id} has no unit for its band`);
    assert.equal(m.rules.inBandRate, RULE_DEFAULTS.inBandRate,
      `${m.id} changes the in-band rate, which would make its thresholds incomparable`);
    assert.equal(m.rules.maxMult, RULE_DEFAULTS.maxMult, `${m.id} changes the multiplier ceiling`);
    assert.ok(m.rules.thrashPenalty >= RULE_DEFAULTS.thrashPenalty,
      `${m.id} charges less than standard for output travel — a mission may be harsher about wear, never softer`);
    assert.equal(m.rules.alarmPenalty, RULE_DEFAULTS.alarmPenalty);
    assert.equal(m.rules.cavPenalty, RULE_DEFAULTS.cavPenalty);
  }
});

test('par energy implies a load this rig could actually draw', () => {
  for (const m of MISSIONS) {
    const kW = (m.parEnergy_kWh * 3600) / m.duration_s;
    assert.ok(kW >= 1 && kW <= 30,
      `${m.id} pars ${m.parEnergy_kWh} kWh over ${m.duration_s} s — ${kW.toFixed(1)} kW, which is `
      + 'either free energy or four motors');
  }
});

test('the mission table is frozen all the way down', () => {
  assert.ok(Object.isFrozen(MISSIONS));
  const m = MISSIONS[0];
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.par) && Object.isFrozen(m.script)
    && Object.isFrozen(m.script[0]) && Object.isFrozen(m.rules),
    'a session that mutated a mission would corrupt every later run in the same page load');
  assert.throws(() => { MISSIONS[0].band = 9; }, TypeError);
});

test('the campaign validates against the real director and profile tables', () => {
  assert.deepEqual(validateMissions({ upsets: UPSETS, unlocks: UNLOCKS, actions: SETUP_ACTIONS }), [],
    'the campaign has to hold up against the modules it will actually run with, not only against '
    + 'its own copy of their id lists');

  const short = validateMissions({ unlocks: { proportional: { id: 'proportional' } } });
  assert.ok(short.length > 0,
    'a profile that has never heard of most of the unlocks must be reported, not ignored');
  assert.ok(short.some((x) => x.includes('reset')),
    'and the message has to name the feature that is missing');

  const noUpsets = validateMissions({ upsets: {} });
  assert.ok(noUpsets.length > 0, 'a director with no upsets makes every script unplayable');
});

test('every id the campaign hands out is a real unlock, and manual is never awarded', () => {
  for (const id of UNLOCK_IDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(UNLOCKS, id),
      `${id} is granted by a mission but profile.js has no such unlock, so the award is lost`);
  }
  assert.ok(!UNLOCK_IDS.includes(BASE_UNLOCK),
    'manual output is the starting condition, not a reward — awarding it would waste a mission');
  const missing = Object.keys(UNLOCKS).filter((id) => id !== BASE_UNLOCK && !UNLOCK_IDS.includes(id));
  assert.deepEqual(missing, [],
    'every unlock the profile can hold must be reachable through the campaign');
});

test('every upset the campaign scripts exists in the director with the same id', () => {
  for (const id of UPSET_IDS) {
    assert.ok(UPSETS[id], `${id} is scripted but the director has no such upset — it would never fire`);
    assert.equal(UPSETS[id].id, id, `${id} disagrees with the id inside its own director record`);
    assert.ok(UPSETS[id].telegraph_s <= 12,
      `${id} needs ${UPSETS[id].telegraph_s} s of warning, more than the 12 s a mission guarantees`);
  }
});

test('no script walks the demand valve past what the machines can carry', () => {
  // Measured on the shipped rig: one machine at 0.90 travel draws 17.9 kW against a 15 kW motor,
  // and two at full travel draw 34 kW. Either trips, and a trip fails the shift outright.
  const step = (d, e) => {
    const g = Math.min(1, Math.abs(e.mag));
    if (e.upset === 'DEMAND_SURGE') return Math.min(1, d + 0.10 + 0.32 * g);
    if (e.upset === 'DEMAND_RAMP') return Math.min(1, d + 0.14 + 0.30 * g);
    if (e.upset === 'DEMAND_COLLAPSE') return Math.max(0, d - (0.12 + 0.30 * g));
    if (e.upset === 'VALVE_SLAM') return d * (1 - (0.55 + 0.40 * g));
    return d;
  };
  for (const m of MISSIONS) {
    // Only the pressure missions: on a flow loop the controller holds the flow whatever the valve
    // does, so a wide-open valve lets the pumps slow down instead of working them harder.
    if (m.loop !== 'PRESSURE') continue;
    const staged = m.setup.some((s) => s.action === 'setStaging' && s.args[0].enabled === true)
      && !m.setup.some((s) => s.action === 'stopPump');
    const ceiling = staged ? DEMAND_CEILING.twoPumps : DEMAND_CEILING.onePump;
    let d = 0.45;
    for (const s of m.setup) {
      if (s.action === 'setDisturbance' && Number.isFinite(s.args[0].demandTarget)) {
        d = s.args[0].demandTarget;
      }
    }
    for (const e of m.script) {
      d = step(d, e);
      assert.ok(d <= ceiling + 1e-9,
        `${m.id} walks the demand valve to ${(d * 100).toFixed(0)}% after ${e.upset}, past the `
        + `${(ceiling * 100).toFixed(0)}% ${staged ? 'two machines' : 'one machine'} can carry `
        + 'without an overload trip');
    }
  }
});

test('every scripted magnitude is a severity and not an engineering value', () => {
  for (const m of MISSIONS) {
    for (const e of m.script) {
      assert.ok(Math.abs(e.mag) <= 1,
        `${m.id} gives ${e.upset} a mag of ${e.mag}; the director clamps |mag| to 1, so anything `
        + 'larger is a number written in the wrong units and silently maxes the upset out');
    }
  }
});

test('validateMissions ignores nonsense in place of its reference tables', () => {
  for (const junk of [null, undefined, 0, '', 'refs', [], NaN, { unlocks: null, upsets: undefined }]) {
    assert.deepEqual(validateMissions(junk), [],
      `validateMissions(${String(junk)}) must fall back to the declared ids rather than reporting `
      + 'the whole campaign as broken');
  }
});

test('missionById refuses anything that is not an id it knows', () => {
  assert.equal(missionById(MISSIONS[0].id).title, MISSIONS[0].title);
  for (const junk of [null, undefined, '', 0, NaN, {}, [], 'NO_SUCH_MISSION', 'constructor',
    '__proto__', 'toString']) {
    assert.equal(missionById(junk), null,
      `missionById(${String(junk)}) must be null — a prototype key must not come back as a mission`);
  }
});

test('missionsForTier accepts a tier number or a tier id and refuses everything else', () => {
  assert.equal(missionsForTier(1)[0].id, MISSIONS[0].id);
  assert.deepEqual(missionsForTier('HANDS').map((m) => m.id), missionsForTier(1).map((m) => m.id),
    'the tier id and the tier number have to select the same shifts');
  for (const junk of [0, 6, -1, NaN, null, undefined, '', 'NOPE', {}]) {
    assert.deepEqual(missionsForTier(junk), [],
      `missionsForTier(${String(junk)}) must be an empty list, not a crash and not everything`);
  }
});

test('bandFraction returns NaN rather than a misleading number for a broken mission', () => {
  assert.ok(Math.abs(bandFraction(MISSIONS[0]) - 0.25 / 8) < 1e-12);
  for (const junk of [null, undefined, {}, { loop: 'PRESSURE' }, { loop: 'PRESSURE', band: 0 },
    { loop: 'PRESSURE', band: NaN }, { loop: 'NOPE', band: 0.1 }, { loop: 'PRESSURE', band: -1 }]) {
    assert.ok(Number.isNaN(bandFraction(junk)),
      `bandFraction(${JSON.stringify(junk)}) must be NaN — a zero would read as an impossibly hard mission`);
  }
});

test('missionCleared reads any shape a saved profile might come back in', () => {
  const id = MISSIONS[0].id;
  assert.equal(missionCleared({ missions: { [id]: { clears: 1 } } }, id), true);
  assert.equal(missionCleared({ missions: { [id]: { best: 1200 } } }, id), true);
  assert.equal(missionCleared({ missions: { [id]: { medal: 'bronze' } } }, id), true);
  assert.equal(missionCleared({ missions: { [id]: { cleared: true } } }, id), true);
  assert.equal(missionCleared({ missions: [{ id, clears: 2 }] }, id), true,
    'an older profile stored the missions as a list and must still count');

  assert.equal(missionCleared({ missions: { [id]: { medal: 'none', best: 0 } } }, id), false,
    'an attempt that scored nothing is not a clear');
  for (const junk of [null, undefined, {}, { missions: null }, { missions: [] },
    { missions: 'yes' }, { missions: { [id]: 0 } }, { missions: { [id]: false } }]) {
    assert.equal(missionCleared(junk, id), false,
      `missionCleared(${JSON.stringify(junk)}) must be false, not a thrown error at first paint`);
  }
  assert.equal(missionCleared({ missions: { [id]: { clears: 1 } } }, ''), false);
  assert.equal(missionCleared({ missions: { [id]: { clears: 1 } } }, null), false);
});

test('a profile whose storage throws on read leaves the campaign playable', () => {
  // `importProfile` is fed a paste box, so a profile can be any object at all.
  const hostile = { get missions() { throw new Error('storage unavailable'); } };
  assert.equal(missionCleared(hostile, MISSIONS[0].id), false,
    'reading a broken profile must fail closed');
  const open = availableMissions(hostile);
  assert.equal(open.length, 1,
    'and the player must still be offered the opening mission rather than an empty campaign');
  assert.equal(nextMission(hostile).id, MISSIONS[0].id);
});

test('an empty or hostile profile object behaves exactly like a new player', () => {
  for (const p of [null, undefined, {}, { missions: {} }, { xp: 0 }]) {
    assert.equal(availableMissions(p).length, 1, `${JSON.stringify(p)} must look like a cold start`);
    assert.equal(nextMission(p).id, MISSIONS[0].id);
  }
});

test('a profile claiming a mission that no longer exists does not strand the player', () => {
  const p = cleared('MISSION_THAT_WAS_RENAMED', MISSIONS[0].id);
  assert.equal(nextMission(p).id, MISSIONS[1].id,
    'stale ids from an older campaign version must be ignored, not counted');
});
