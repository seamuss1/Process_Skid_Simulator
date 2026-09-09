/**
 * tests/reference.test.js — the reference shelf.
 *
 * A table of numbers is only worth having if something checks that the numbers are the ones they
 * claim to be, so the three headline tests here are the three ways this module can be wrong
 * without anybody noticing: a glossary entry with no definition, a tuning rule that hands back an
 * Infinity on an ordinary process, and a pipe bore that does not match the wall thickness beside
 * it. The fourth is the one that would do the most damage — a rule here disagreeing with the same
 * rule in `control/autotune.js`, so that the reference and the autotuner give the operator two
 * different answers to the same question.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CITATIONS, cite, TUNING_RULES, RULE_INPUT, RULE_INTENT, ruleById, rulesFor, evaluateRule,
  PIPE_SCHEDULES, PIPE_SCHEDULE_NOTES, pipeBore, DESIGN_VELOCITY_MS, ROUGHNESS_REF, FITTING_K_REF,
  VIBRATION_ZONES, isoZone, INSTRUMENT_CLASSES, rtdTolerance_C, MOTOR_EFFICIENCY,
  MOTOR_CLASS_NOTES, motorEfficiency, motorPartLoadEfficiency, MOTOR_PART_LOAD, driveEfficiency,
  ENERGY_REFERENCE, annualEnergy, VALVE_CHARACTERISTICS, TYPICAL_KV, kvToCv, cvToKv,
  valveAuthority, PRESSURE_CLASSES, pressureRating_bar, GLOSSARY, GLOSSARY_AREAS, glossaryTerm,
  searchGlossary, glossaryByArea,
} from '../src/content/reference.js';
import { tuningRules, modelRules } from '../src/control/autotune.js';
import { ROUGHNESS_MM, FITTING_K } from '../src/process/pipe.js';
import { VIB_ZONES } from '../src/process/pump.js';
import { ultimateFOPDT, near, nearRel } from './helpers.js';

/** A thoroughly ordinary self-regulating loop: some gain, some lag, some dead time. */
const WELL_CONDITIONED = Object.freeze({ K: 1, tau: 10, theta: 2 });

/** The same process seen through a relay experiment. */
const ULTIMATE = ultimateFOPDT(WELL_CONDITIONED.K, WELL_CONDITIONED.tau, WELL_CONDITIONED.theta);

/** Everything a rule of either kind might want, for the "no rule blows up" sweep. */
const FULL_INPUT = Object.freeze({ ...WELL_CONDITIONED, Ku: ULTIMATE.Ku, Tu: ULTIMATE.Tu });

// =============================================================================================
// The glossary
// =============================================================================================

test('every glossary entry has a term, an area and a real definition', () => {
  assert.ok(GLOSSARY.length >= 200,
    `the glossary is meant to cover the terms this simulator uses; only ${GLOSSARY.length} of them`);
  for (const g of GLOSSARY) {
    assert.equal(typeof g.term, 'string', `a glossary entry has no term: ${JSON.stringify(g)}`);
    assert.ok(g.term.trim().length > 0, 'a glossary entry has an empty term');
    assert.equal(typeof g.def, 'string', `${g.term}: definition is not a string`);
    assert.ok(g.def.trim().length > 0, `${g.term}: empty definition`);
    // A one-word "definition" is the shape a placeholder takes when somebody meant to come back
    // to it, and it is exactly what this test exists to catch.
    assert.ok(g.def.trim().split(/\s+/).length >= 6,
      `${g.term}: "${g.def}" is too short to be a definition an operator would accept`);
    assert.ok(g.def.trim().endsWith('.'), `${g.term}: definition is not a sentence`);
    assert.ok(GLOSSARY_AREAS.some((a) => a.id === g.area),
      `${g.term}: area "${g.area}" is not one of the declared areas`);
  }
});

test('no glossary term is defined twice', () => {
  const seen = new Map();
  for (const g of GLOSSARY) {
    const key = g.term.toLowerCase();
    assert.ok(!seen.has(key), `"${g.term}" is defined twice, in ${seen.get(key)} and ${g.area}`);
    seen.set(key, g.area);
  }
});

test('no glossary definition defines a term with itself', () => {
  // "Cavitation is when a pump cavitates" is the circular definition this catches. The test looks
  // for the whole term appearing inside its own definition, which is the form the failure takes.
  for (const g of GLOSSARY) {
    const bare = g.term.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase();
    if (bare.split(/\s+/).length < 2) continue;
    assert.ok(!g.def.toLowerCase().includes(bare),
      `${g.term}: the definition contains the term itself, which defines nothing`);
  }
});

test('every glossary area has entries and every entry is reachable from its area', () => {
  let total = 0;
  for (const area of GLOSSARY_AREAS) {
    const entries = glossaryByArea(area.id);
    assert.ok(entries.length > 0, `no glossary entries in area ${area.id}`);
    total += entries.length;
  }
  assert.equal(total, GLOSSARY.length, 'some glossary entry is in an area nothing lists');
});

test('the glossary can be looked up and searched, and says so when it cannot', () => {
  const npsh = glossaryTerm('NPSH margin');
  assert.equal(npsh.ok, true);
  assert.match(npsh.def, /available minus required/i);

  assert.equal(glossaryTerm('npsh MARGIN').ok, true, 'lookup must be case-insensitive');
  assert.equal(glossaryTerm('  NPSH margin  ').ok, true, 'lookup must tolerate stray spaces');

  const missing = glossaryTerm('flux capacitor');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no glossary entry/);
  assert.equal(glossaryTerm('').ok, false, 'an empty query is a guarded failure, not a match');
  assert.equal(glossaryTerm(null).ok, false);

  const hits = searchGlossary('npsh');
  assert.ok(hits.length >= 3, 'searching for npsh should find the NPSH family');
  assert.ok(hits[0].term.toLowerCase().includes('npsh'),
    'a term match must rank above a definition match');
  assert.equal(searchGlossary('').length, 0);
  assert.ok(searchGlossary('the', 5).length <= 5, 'the limit must be honoured');
});

// =============================================================================================
// The tuning rules
// =============================================================================================

test('every tuning rule produces finite, usable gains on a well-conditioned FOPDT model', () => {
  assert.ok(TUNING_RULES.length >= 25, 'the rule table is meant to cover the published families');
  for (const rule of TUNING_RULES) {
    const got = evaluateRule(rule.id, FULL_INPUT);
    assert.equal(got.ok, true, `${rule.name}: ${got.reason}`);
    assert.ok(Number.isFinite(got.Kc), `${rule.name}: Kc is ${got.Kc}`);
    assert.ok(Number.isFinite(got.Ti), `${rule.name}: Ti is ${got.Ti}`);
    assert.ok(Number.isFinite(got.Td), `${rule.name}: Td is ${got.Td}`);
    // A negative gain on a reverse-acting loop would drive the process away from setpoint, and a
    // negative time is not a time. Neither is a rounding error; either is a transcription error.
    assert.ok(got.Kc > 0, `${rule.name}: gain ${got.Kc} is not positive`);
    assert.ok(got.Ti >= 0, `${rule.name}: integral time ${got.Ti} is negative`);
    assert.ok(got.Td >= 0, `${rule.name}: derivative time ${got.Td} is negative`);
    // Nothing published lands outside these by an order of magnitude on this model; anything that
    // does is a formula that has been mistyped rather than a rule with an unusual opinion.
    assert.ok(got.Kc < 200, `${rule.name}: gain ${got.Kc} is implausible on K=1, tau=10, theta=2`);
    assert.ok(got.Ti < 500, `${rule.name}: integral time ${got.Ti} s is implausible`);
    assert.ok(got.Td < 100, `${rule.name}: derivative time ${got.Td} s is implausible`);
  }
});

test('the rules the autotuner also implements agree with it exactly', () => {
  // The failure this prevents is the worst one available to a reference module: the operator
  // reads a formula here, applies the autotuner's button, and gets a different number.
  const byId = new Map();
  for (const r of tuningRules(ULTIMATE.Ku, ULTIMATE.Tu)) byId.set(r.id, r);
  for (const r of modelRules(WELL_CONDITIONED)) byId.set(r.id, r);

  let checked = 0;
  for (const rule of TUNING_RULES) {
    if (!rule.autotuneId) continue;
    const theirs = byId.get(rule.autotuneId);
    assert.ok(theirs, `${rule.id} claims to mirror autotune's ${rule.autotuneId}, which is gone`);
    const mine = evaluateRule(rule.id, FULL_INPUT);
    assert.equal(mine.ok, true, mine.reason);
    near(mine.Kc, theirs.Kc, 1e-9, `${rule.id} vs autotune ${rule.autotuneId}: Kc`);
    near(mine.Ti, theirs.Ti, 1e-9, `${rule.id} vs autotune ${rule.autotuneId}: Ti`);
    near(mine.Td, theirs.Td, 1e-9, `${rule.id} vs autotune ${rule.autotuneId}: Td`);
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} rules cross-checked against the autotuner`);
});

test('the classical rules reproduce their published numbers', () => {
  // Spot checks against the printed tables, so a refactor of the arithmetic cannot quietly
  // change what the module claims the literature says.
  const zn = evaluateRule('ZN_CL_PID', FULL_INPUT);
  near(zn.Kc, 0.6 * ULTIMATE.Ku, 1e-9, 'Ziegler-Nichols closed-loop PID gain');
  near(zn.Ti, ULTIMATE.Tu / 2, 1e-9, 'Ziegler-Nichols closed-loop PID reset');
  near(zn.Td, ULTIMATE.Tu / 8, 1e-9, 'Ziegler-Nichols closed-loop PID rate');

  const znOl = evaluateRule('ZN_OL_PI', WELL_CONDITIONED);
  near(znOl.Kc, 4.5, 1e-9, '0.9 tau / (K theta) with tau=10, theta=2');
  near(znOl.Ti, 6.66, 1e-9, '3.33 theta');

  // Cohen-Coon PI at theta/tau = 0.2: Kc = (1/K)(5)(0.9 + 0.2/12).
  const cc = evaluateRule('CC_PI', WELL_CONDITIONED);
  near(cc.Kc, 5 * (0.9 + 0.2 / 12), 1e-9, 'Cohen-Coon PI gain');
  near(cc.Ti, (2 * (30 + 0.6)) / (9 + 4), 1e-9, 'Cohen-Coon PI reset');

  // AMIGO PID: Kc = 0.2 + 0.45*5, Ti = theta(0.4 theta + 0.8 tau)/(theta + 0.1 tau).
  const amigo = evaluateRule('AMIGO_PID', WELL_CONDITIONED);
  near(amigo.Kc, 2.45, 1e-9, 'AMIGO PID gain');
  near(amigo.Ti, (2 * (0.8 + 8)) / 3, 1e-9, 'AMIGO PID reset');
  near(amigo.Td, (0.5 * 2 * 10) / (0.6 + 10), 1e-9, 'AMIGO PID rate');

  // Chien-Hrones-Reswick: the tracking and regulation halves must actually differ, which is the
  // entire reason the family is in the table.
  const track = evaluateRule('CHR_TRACK_0_PI', WELL_CONDITIONED);
  const reg = evaluateRule('CHR_REG_0_PI', WELL_CONDITIONED);
  near(track.Ti, 12, 1e-9, 'CHR tracking reset is 1.2 tau');
  near(reg.Ti, 8, 1e-9, 'CHR regulation reset is 4 theta');
  assert.ok(reg.Kc > track.Kc,
    'the regulator half of CHR carries more gain than the servo half, which is the point of it');
});

test('lambda and IMC PI are the same rule, and SIMC caps the reset that lambda does not', () => {
  const lam = evaluateRule('LAMBDA_PI', { ...WELL_CONDITIONED, lambda_s: 6 });
  const imc = evaluateRule('IMC_PI', { ...WELL_CONDITIONED, lambda_s: 6 });
  near(lam.Kc, imc.Kc, 1e-12, 'lambda and IMC PI gain');
  near(lam.Ti, imc.Ti, 1e-12, 'lambda and IMC PI reset');

  // A lag-dominant process is where the uncapped rule fails: Ti = tau = 400 s means the loop
  // never rejects a load. SIMC's cap is the fix, and this is the case that shows it.
  const lagDominant = { K: 1, tau: 400, theta: 2 };
  const lamSlow = evaluateRule('LAMBDA_PI', lagDominant);
  const simc = evaluateRule('SIMC_PI', lagDominant);
  near(lamSlow.Ti, 400, 1e-9, 'lambda leaves the reset at the process time constant');
  near(simc.Ti, 16, 1e-9, 'SIMC caps the reset at 4 (tc + theta)');
  assert.ok(simc.Ti < lamSlow.Ti / 10, 'the cap is what makes SIMC usable on a lag-dominant loop');
});

test('a rule that divides by the dead time refuses a process that has none', () => {
  const noDeadTime = { K: 1, tau: 10, theta: 0 };
  const cc = evaluateRule('CC_PI', noDeadTime);
  assert.equal(cc.ok, false);
  assert.match(cc.reason, /dead time/i);
  assert.match(cc.reason, /lambda|IMC|SIMC/,
    'the refusal must name the rules that would work instead');

  // The model-based family takes its closed-loop speed from the user, so it survives.
  const simc = evaluateRule('SIMC_PI', { ...noDeadTime, tc_s: 4 });
  assert.equal(simc.ok, true, simc.reason);
  assert.ok(Number.isFinite(simc.Kc) && simc.Kc > 0);
});

test('evaluateRule guards every way it can be called wrongly', () => {
  assert.equal(evaluateRule('NO_SUCH_RULE', FULL_INPUT).ok, false);
  assert.match(evaluateRule('NO_SUCH_RULE', FULL_INPUT).reason, /no tuning rule/);
  assert.equal(evaluateRule('ZN_CL_PI', null).ok, false);
  assert.equal(evaluateRule('ZN_CL_PI', {}).ok, false, 'an ULTIMATE rule needs Ku and Tu');
  assert.match(evaluateRule('ZN_CL_PI', {}).reason, /relay|cycling/i);
  assert.equal(evaluateRule('CC_PI', { K: 0, tau: 10, theta: 2 }).ok, false,
    'a process with no gain cannot be tuned for');
  assert.equal(evaluateRule('CC_PI', { K: 1, tau: -1, theta: 2 }).ok, false);
  assert.match(evaluateRule('CC_PI', {}).reason, /step or sweep/i,
    'the refusal must say which experiment to run');
});

test('the rule table is well formed and every rule is cited', () => {
  const ids = new Set();
  for (const rule of TUNING_RULES) {
    assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    assert.equal(ruleById(rule.id), rule, `${rule.id} is not reachable by id`);
    assert.ok(Object.values(RULE_INPUT).includes(rule.needs), `${rule.id}: bad needs`);
    assert.ok(Object.values(RULE_INTENT).includes(rule.intent), `${rule.id}: bad intent`);
    assert.ok(CITATIONS[rule.source], `${rule.id} cites ${rule.source}, which is not in CITATIONS`);
    assert.ok(Array.isArray(rule.assumes) && rule.assumes.length > 0,
      `${rule.id} states no assumptions, which is the one thing a rule table must carry`);
    assert.ok(rule.useFor && rule.avoid, `${rule.id} does not say what it is for and against`);
    assert.equal(typeof rule.formula, 'string');
    assert.equal(rule.standing, 'standard', `${rule.id}: every published rule is standard`);
  }
  assert.ok(rulesFor(RULE_INPUT.ULTIMATE).length >= 5);
  assert.ok(rulesFor(RULE_INPUT.FOPDT).length >= 15);
  assert.equal(rulesFor('NONSENSE').length, 0);
});

// =============================================================================================
// The pipe table
// =============================================================================================

test('every tabulated bore is consistent with its own outside diameter and wall', () => {
  // The check the table exists for: id = od - 2*wall. The tolerance is the rounding between the
  // inch and metric editions of B36.10M and nothing else, so it is tight enough that a
  // transposed digit cannot hide inside it.
  for (const row of PIPE_SCHEDULES) {
    for (const [sched, wall] of Object.entries(row.walls)) {
      const id = row.ids[sched];
      assert.equal(typeof id, 'number', `DN${row.dn} schedule ${sched} has a wall but no bore`);
      const derived = row.od_mm - 2 * wall;
      near(id, derived, 0.12,
        `DN${row.dn} schedule ${sched}: bore ${id} against od ${row.od_mm} less 2 x ${wall}`);
      assert.ok(id > 0 && id < row.od_mm, `DN${row.dn} schedule ${sched}: impossible bore`);
    }
  }
});

test('a heavier schedule always has a thicker wall and a smaller bore at the same size', () => {
  for (const row of PIPE_SCHEDULES) {
    assert.ok(row.walls['10S'] <= row.walls[40], `DN${row.dn}: 10S is not thinner than 40`);
    assert.ok(row.walls[40] < row.walls[80], `DN${row.dn}: 40 is not thinner than 80`);
    assert.ok(row.ids['10S'] > row.ids[40], `DN${row.dn}: 10S bore is not larger than 40`);
    assert.ok(row.ids[40] > row.ids[80], `DN${row.dn}: 40 bore is not larger than 80`);
  }
});

test('the pipe table is monotonic in size and every schedule is explained', () => {
  for (let i = 1; i < PIPE_SCHEDULES.length; i += 1) {
    const a = PIPE_SCHEDULES[i - 1];
    const b = PIPE_SCHEDULES[i];
    assert.ok(b.dn > a.dn, `DN${b.dn} does not follow DN${a.dn}`);
    assert.ok(b.nps_in > a.nps_in, `NPS ${b.nps_in} does not follow NPS ${a.nps_in}`);
    assert.ok(b.od_mm > a.od_mm, `DN${b.dn} outside diameter does not exceed DN${a.dn}`);
    assert.ok(b.ids[40] > a.ids[40], `DN${b.dn} bore does not exceed DN${a.dn}`);
  }
  for (const sched of Object.keys(PIPE_SCHEDULES[0].walls)) {
    const note = PIPE_SCHEDULE_NOTES[sched];
    assert.ok(note, `schedule ${sched} is tabulated but never explained`);
    assert.ok(CITATIONS[note.source], `schedule ${sched} cites a missing source`);
  }
});

test('the DN150 line the rig is built around comes out where it should', () => {
  // A cross-check against a number an engineer knows by heart: 6 inch schedule 40 is 154 mm.
  const b = pipeBore(150, 40);
  assert.equal(b.ok, true, b.reason);
  near(b.id_mm, 154.1, 0.1, 'DN150 schedule 40 bore');
  near(b.od_mm, 168.3, 1e-9, 'DN150 outside diameter');

  const thin = pipeBore(150, '10S');
  assert.ok(thin.id_mm > b.id_mm, 'the thin-wall stainless bore must be larger');

  assert.equal(pipeBore(175, 40).ok, false, 'DN175 is not a standard size');
  assert.match(pipeBore(175, 40).reason, /no standard pipe/);
  assert.equal(pipeBore(150, 160).ok, false, 'schedule 160 is not tabulated here');
  assert.match(pipeBore(150, 160).reason, /not tabulated/);
});

test('the design velocity guidance keeps a suction line slower than a discharge line', () => {
  const v = DESIGN_VELOCITY_MS;
  assert.equal(v.standing, 'typical', 'design velocities are guidance, not a standard');
  assert.ok(v.pumpSuction.hi <= v.pumpDischarge.hi,
    'a suction line sized for discharge velocity eats the NPSH margin — the table must say so');
  for (const key of ['pumpSuction', 'pumpDischarge', 'headerLongRun', 'gravityDrain',
    'slurryMinimum']) {
    assert.ok(v[key].lo < v[key].hi, `${key}: the band is inverted`);
    assert.ok(v[key].why.length > 10, `${key}: no reason given for the band`);
  }
});

// =============================================================================================
// Roughness and fittings — the two tables that must not drift from the model
// =============================================================================================

test('the roughness reference quotes the simulator\'s own values, not a second copy of them', () => {
  const byId = Object.fromEntries(ROUGHNESS_REF.map((r) => [r.id, r]));
  for (const [id, eps] of Object.entries(ROUGHNESS_MM)) {
    assert.ok(byId[id], `process/pipe.js defines roughness ${id} and the reference omits it`);
    assert.equal(byId[id].eps_mm, eps,
      `${id}: the reference and process/pipe.js disagree about the roughness`);
  }
  for (const r of ROUGHNESS_REF) {
    assert.equal(r.standing, 'typical',
      `${r.id}: roughness is a property of a line's history, never a standard value`);
    assert.ok(CITATIONS[r.source], `${r.id} cites a missing source`);
    assert.ok(r.eps_mm > 0 && r.eps_mm < 20, `${r.id}: ${r.eps_mm} mm is not a pipe roughness`);
  }
});

test('the fitting table quotes the simulator\'s own K factors and adds to them', () => {
  const byId = Object.fromEntries(FITTING_K_REF.map((f) => [f.id, f]));
  for (const [id, k] of Object.entries(FITTING_K)) {
    assert.ok(byId[id], `process/pipe.js defines fitting ${id} and the reference omits it`);
    assert.equal(byId[id].K, k, `${id}: the reference and process/pipe.js disagree about K`);
  }
  assert.ok(FITTING_K_REF.length > Object.keys(FITTING_K).length,
    'the reference is meant to extend the takeoff, not restate it');
  for (const f of FITTING_K_REF) {
    assert.ok(f.K >= 0 && f.K < 50, `${f.id}: K of ${f.K} is not a velocity-head coefficient`);
    assert.ok(f.what && f.what.length > 5, `${f.id}: no description`);
    assert.ok(CITATIONS[f.source], `${f.id} cites a missing source`);
    assert.ok(['standard', 'typical'].includes(f.standing), `${f.id}: bad standing`);
  }
  // The one relationship in the table that is physics rather than a measurement.
  assert.equal(byId.EXIT.K, 1.0, 'a pipe exit loses exactly one velocity head');
});

// =============================================================================================
// Machine condition, instruments, motors
// =============================================================================================

test('the ISO 10816 table contains the row the simulator ships, unaltered', () => {
  const flexible = VIBRATION_ZONES.find((z) => z.id === 'GROUP2_FLEXIBLE');
  assert.ok(flexible, 'the rig\'s own machine class must be in the table');
  assert.equal(flexible.ab_mms, VIB_ZONES.AB);
  assert.equal(flexible.bc_mms, VIB_ZONES.BC);
  assert.equal(flexible.cd_mms, VIB_ZONES.CD);
  for (const z of VIBRATION_ZONES) {
    assert.ok(z.ab_mms < z.bc_mms && z.bc_mms < z.cd_mms, `${z.id}: zone boundaries out of order`);
    assert.equal(z.standing, 'standard');
    assert.ok(CITATIONS[z.source], `${z.id} cites a missing source`);
  }
});

test('the same reading means different things on different machines, and isoZone says so', () => {
  // 5 mm/s: zone D on a rigidly mounted medium machine, zone C on a flexible one, zone C on a
  // large machine. That spread is the reason the function takes a class at all.
  assert.equal(isoZone(5.0, 'GROUP2_RIGID').zone, 'D');
  assert.equal(isoZone(5.0, 'GROUP2_FLEXIBLE').zone, 'C');
  assert.equal(isoZone(5.0, 'GROUP1_FLEXIBLE').zone, 'B');
  assert.equal(isoZone(1.0).zone, 'A', 'the default class is the one the rig ships');
  assert.match(isoZone(5.0).meaning, /unsatisfactory/);
  assert.equal(isoZone(-1).ok, false, 'a negative velocity is a guarded failure');
  assert.equal(isoZone(3, 'NO_SUCH_CLASS').ok, false);
});

test('instrument accuracy always says what the percentage is a percentage of', () => {
  for (const i of INSTRUMENT_CLASSES) {
    assert.ok(['SPAN', 'RATE', 'URL'].includes(i.basis),
      `${i.id}: an accuracy with no basis is not an accuracy`);
    assert.ok(CITATIONS[i.source], `${i.id} cites a missing source`);
    assert.ok(i.note && i.note.length > 10, `${i.id}: no note saying what the figure hides`);
    assert.ok(i.accuracy_pct >= 0 && i.accuracy_pct < 20, `${i.id}: implausible accuracy`);
  }
  // The point the module is making: a premium transmitter is better than a utility one by an
  // order of magnitude, and both are quoted on span.
  const premium = INSTRUMENT_CLASSES.find((i) => i.id === 'PT_PREMIUM');
  const utility = INSTRUMENT_CLASSES.find((i) => i.id === 'PT_UTILITY');
  assert.ok(premium.accuracy_pct < utility.accuracy_pct / 4);
});

test('RTD tolerance widens with class and with temperature', () => {
  const a0 = rtdTolerance_C('A', 0);
  const a100 = rtdTolerance_C('A', 100);
  const b100 = rtdTolerance_C('B', 100);
  assert.equal(a0.ok, true);
  near(a0.tol_C, 0.15, 1e-12, 'class A at the ice point');
  near(a100.tol_C, 0.35, 1e-12, 'class A at 100 C');
  near(b100.tol_C, 0.80, 1e-12, 'class B at 100 C');
  assert.ok(b100.tol_C > a100.tol_C, 'class B must be looser than class A');
  near(rtdTolerance_C('A', -100).tol_C, 0.35, 1e-12, 'the tolerance is on the magnitude');
  assert.equal(rtdTolerance_C('Z', 0).ok, false);
  assert.equal(rtdTolerance_C('A', NaN).ok, false);
});

test('the motor efficiency table is monotonic in class and in rating', () => {
  const classes = ['IE1', 'IE2', 'IE3', 'IE4'];
  for (let i = 0; i < MOTOR_EFFICIENCY.kW.length; i += 1) {
    for (let c = 1; c < classes.length; c += 1) {
      assert.ok(MOTOR_EFFICIENCY[classes[c]][i] > MOTOR_EFFICIENCY[classes[c - 1]][i],
        `at ${MOTOR_EFFICIENCY.kW[i]} kW, ${classes[c]} is not better than ${classes[c - 1]}`);
    }
    if (i > 0) {
      for (const c of classes) {
        assert.ok(MOTOR_EFFICIENCY[c][i] >= MOTOR_EFFICIENCY[c][i - 1],
          `${c}: efficiency falls between ${MOTOR_EFFICIENCY.kW[i - 1]} and `
            + `${MOTOR_EFFICIENCY.kW[i]} kW`);
      }
      assert.ok(MOTOR_EFFICIENCY.kW[i] > MOTOR_EFFICIENCY.kW[i - 1], 'ratings out of order');
    }
    for (const c of classes) {
      assert.ok(MOTOR_EFFICIENCY[c][i] > 50 && MOTOR_EFFICIENCY[c][i] < 100,
        `${c} at ${MOTOR_EFFICIENCY.kW[i]} kW: ${MOTOR_EFFICIENCY[c][i]}% is not an efficiency`);
    }
    assert.equal(MOTOR_EFFICIENCY[classes[0]].length, MOTOR_EFFICIENCY.kW.length);
  }
  for (const c of [...classes, 'IE5']) {
    assert.ok(MOTOR_CLASS_NOTES[c], `${c} is tabulated but never explained`);
  }
});

test('motorEfficiency interpolates, derives IE5, and refuses nonsense', () => {
  const ie3at15 = motorEfficiency('IE3', 15);
  assert.equal(ie3at15.ok, true);
  near(ie3at15.eta, 0.921, 1e-9, 'the IE3 minimum for a 15 kW 4-pole machine');
  assert.equal(ie3at15.derived, false);

  // The rig's own motor at 92.6% sits between IE3 and IE4 for its rating, which is the point the
  // module makes about a class being a floor rather than a value.
  const ie4at15 = motorEfficiency('IE4', 15);
  assert.ok(0.926 > ie3at15.eta && 0.926 < ie4at15.eta,
    'the shipped 15 kW motor should sit between the IE3 and IE4 minima');

  const between = motorEfficiency('IE3', 13);
  assert.ok(between.eta > motorEfficiency('IE3', 11).eta && between.eta < ie3at15.eta,
    'interpolation between tabulated ratings must be monotonic');

  const ie5 = motorEfficiency('IE5', 15);
  assert.equal(ie5.derived, true, 'IE5 is derived from IE4 and must say so');
  assert.ok(ie5.eta > ie4at15.eta, 'IE5 must beat IE4');
  near(1 - ie5.eta, 0.8 * (1 - ie4at15.eta), 1e-12, 'IE5 is a 20% loss reduction on IE4');

  assert.equal(motorEfficiency('IE9', 15).ok, false);
  assert.equal(motorEfficiency('IE3', 0).ok, false);
  assert.equal(motorEfficiency('IE3', -5).ok, false);
  // Off the ends of the table the value is clamped rather than extrapolated into nonsense.
  assert.ok(motorEfficiency('IE3', 0.1).eta > 0.5);
  assert.ok(motorEfficiency('IE3', 5000).eta < 1);
});

test('the part-load curve peaks near three-quarter load and collapses at a tenth', () => {
  const rated = motorEfficiency('IE3', 15).eta;
  const at75 = motorPartLoadEfficiency('IE3', 15, 0.75);
  const at100 = motorPartLoadEfficiency('IE3', 15, 1.0);
  const at10 = motorPartLoadEfficiency('IE3', 15, 0.10);
  assert.equal(at75.ok, true);
  near(at75.eta, rated, 1e-12, 'the curve is normalised to one at three-quarter load');
  assert.ok(at100.eta < at75.eta, 'copper losses make full load slightly worse than three-quarter');
  assert.ok(at10.eta < 0.8 * rated,
    'at a tenth of load the constant losses dominate — this is what limits the affinity-law saving');
  assert.equal(at75.standing, 'typical', 'the shape is general; the numbers are not a standard');
  assert.equal(MOTOR_PART_LOAD.load.length, MOTOR_PART_LOAD.factor.length);
  assert.equal(motorPartLoadEfficiency('IE3', 15, -1).ok, false);
  assert.equal(motorPartLoadEfficiency('IE9', 15, 0.5).ok, false);

  const drive = driveEfficiency(0.10);
  assert.ok(drive.eta < driveEfficiency(1.0).eta, 'a drive is worse at a tenth of load');
  assert.ok(drive.eta > 0.85 && driveEfficiency(1.0).eta < 1);
  assert.equal(driveEfficiency(NaN).ok, false);
});

// =============================================================================================
// Energy, valves, flanges
// =============================================================================================

test('the energy reference is dated, cited, and flagged as typical throughout', () => {
  assert.equal(ENERGY_REFERENCE.standing, 'typical');
  const rig = ENERGY_REFERENCE.tariffs.find((t) => t.source === 'RIG');
  assert.ok(rig, 'the simulator\'s own tariff must appear so the two cannot drift');
  assert.equal(rig.perkWh, 0.18, 'and it must be the value src/data/config.js actually ships');
  for (const t of ENERGY_REFERENCE.tariffs) {
    assert.ok(t.perkWh > 0 && t.perkWh < 2, `${t.region}: implausible tariff`);
    assert.ok(CITATIONS[t.source], `${t.region} cites a missing source`);
  }
  for (const c of ENERGY_REFERENCE.carbon_gPerkWh) {
    assert.ok(c.value > 0 && c.value < 1200, `${c.region}: implausible carbon intensity`);
    assert.ok(c.year >= 2020, `${c.region}: an undated intensity is not usable`);
    assert.ok(CITATIONS[c.source], `${c.region} cites a missing source`);
  }
  const france = ENERGY_REFERENCE.carbon_gPerkWh.find((c) => c.region === 'France');
  assert.ok(france.value < ENERGY_REFERENCE.marginal_gPerkWh.value,
    'the average-versus-marginal point only lands if a clean grid is cleaner than a gas turbine');
});

test('annualEnergy multiplies out and guards its inputs', () => {
  const e = annualEnergy(10, 8760, 0.18, 400);
  assert.equal(e.ok, true);
  near(e.kWh, 87600, 1e-9, 'ten kilowatts for a year');
  near(e.cost, 15768, 1e-6, 'at eighteen cents');
  near(e.tCO2e, 35.04, 1e-9, 'at 400 g/kWh');
  assert.equal(annualEnergy(-1, 8760, 0.18).ok, false);
  assert.equal(annualEnergy(10, -1, 0.18).ok, false);
  assert.equal(annualEnergy(10, 8760, -0.18).ok, false);
  assert.equal(annualEnergy(0, 8760, 0.18).cost, 0, 'a stopped pump costs nothing');
});

test('the valve characteristics cover the trims the simulator implements', () => {
  const ids = VALVE_CHARACTERISTICS.map((c) => c.id);
  for (const trim of ['LINEAR', 'EQUAL_PCT', 'QUICK']) {
    assert.ok(ids.includes(trim), `process/valve.js implements ${trim} and the reference omits it`);
  }
  for (const c of VALVE_CHARACTERISTICS) {
    assert.ok(CITATIONS[c.source], `${c.id} cites a missing source`);
    assert.ok(c.useFor && c.avoid, `${c.id} does not say what it is for and against`);
    assert.ok(['standard', 'typical'].includes(c.standing));
  }
});

test('typical Kv rises with size and with how much bore the valve type leaves', () => {
  assert.equal(TYPICAL_KV.standing, 'typical', 'nobody has standardised a Kv');
  for (const type of ['globe', 'butterfly', 'ballSegmented', 'gate']) {
    assert.equal(TYPICAL_KV[type].length, TYPICAL_KV.dn.length, `${type}: length mismatch`);
    for (let i = 1; i < TYPICAL_KV[type].length; i += 1) {
      assert.ok(TYPICAL_KV[type][i] > TYPICAL_KV[type][i - 1],
        `${type}: Kv does not rise from DN${TYPICAL_KV.dn[i - 1]} to DN${TYPICAL_KV.dn[i]}`);
    }
  }
  for (let i = 0; i < TYPICAL_KV.dn.length; i += 1) {
    assert.ok(TYPICAL_KV.gate[i] > TYPICAL_KV.butterfly[i],
      'a full-bore gate valve passes more than a butterfly of the same size');
    assert.ok(TYPICAL_KV.butterfly[i] > TYPICAL_KV.globe[i],
      'a globe valve is the most tortuous path of the four and must have the lowest Kv');
  }
});

test('Kv and Cv convert exactly and reversibly', () => {
  near(kvToCv(100), 115.607, 1e-3, 'Cv = Kv / 0.865');
  near(cvToKv(115.607), 100, 1e-3, 'and back again');
  near(cvToKv(kvToCv(37)), 37, 1e-9, 'the round trip must be exact');
});

test('valve authority classifies the three cases and refuses a zero system drop', () => {
  const high = valveAuthority(6, 10);
  const usual = valveAuthority(3, 10);
  const low = valveAuthority(1, 10);
  near(high.authority, 0.6, 1e-12, 'six bar of ten');
  assert.match(high.verdict, /high/);
  assert.match(usual.verdict, /usual/);
  assert.match(low.verdict, /low/);
  assert.match(low.verdict, /size it down/, 'the verdict must say what to do, not just what it is');
  assert.equal(valveAuthority(1, 0).ok, false);
  assert.equal(valveAuthority(-1, 10).ok, false);
});

test('a pressure class is not a pressure, and the table proves it', () => {
  const cold = pressureRating_bar('1.1', 150, 38);
  const hot = pressureRating_bar('1.1', 150, 400);
  assert.equal(cold.ok, true);
  near(cold.bar, 19.6, 1e-9, 'Class 150 carbon steel at 38 C');
  near(hot.bar, 6.5, 1e-9, 'Class 150 carbon steel at 400 C');
  assert.ok(hot.bar < cold.bar / 2,
    'the whole point of the table is that a class number is not a working pressure');

  // Stainless starts lower and falls far more gently, which is the materials lesson.
  const ssHot = pressureRating_bar('2.2', 150, 400);
  const ssCold = pressureRating_bar('2.2', 150, 38);
  assert.ok(ssCold.bar < cold.bar, '316 starts below carbon steel at ambient');
  assert.ok(ssHot.bar > hot.bar * 1.5, 'and is far ahead of it by 400 C');

  const mid = pressureRating_bar('1.1', 300, 150);
  assert.ok(mid.bar < 46.6 && mid.bar > 45.1, 'interpolation must land between the table rows');

  assert.equal(pressureRating_bar('9.9', 150, 38).ok, false);
  assert.equal(pressureRating_bar('1.1', 175, 38).ok, false);
  assert.equal(pressureRating_bar('1.1', 150, 600).ok, false);
  assert.match(pressureRating_bar('1.1', 150, 600).reason, /materials question/,
    'extrapolation must be refused, not guessed');
  for (const [cls, row] of Object.entries(PRESSURE_CLASSES.groups['1.1'].ratings_bar)) {
    assert.equal(row.length, PRESSURE_CLASSES.temps_C.length, `Class ${cls}: wrong row length`);
    for (let i = 1; i < row.length; i += 1) {
      assert.ok(row[i] < row[i - 1], `Class ${cls}: the rating must fall with temperature`);
    }
  }
});

// =============================================================================================
// House rules
// =============================================================================================

test('every citation key used anywhere in the module resolves', () => {
  const used = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'source' && typeof val === 'string') used.add(val);
        else walk(val);
      }
    }
  };
  walk([TUNING_RULES, PIPE_SCHEDULE_NOTES, DESIGN_VELOCITY_MS, ROUGHNESS_REF, FITTING_K_REF,
    VIBRATION_ZONES, INSTRUMENT_CLASSES, MOTOR_EFFICIENCY, MOTOR_CLASS_NOTES, MOTOR_PART_LOAD,
    ENERGY_REFERENCE, VALVE_CHARACTERISTICS, TYPICAL_KV, PRESSURE_CLASSES]);
  assert.ok(used.size >= 15, `only ${used.size} distinct sources cited across the whole shelf`);
  for (const key of used) {
    assert.ok(CITATIONS[key], `something cites "${key}", which is not in CITATIONS`);
    assert.ok(CITATIONS[key].length > 20, `${key}: the citation is too short to find anything by`);
  }
  assert.match(cite('ZN42'), /Ziegler/);
  assert.match(cite('NOT_A_KEY'), /uncited/, 'a missing citation must be visible, not blank');
});

test('the exported tables are frozen, so nothing can edit the reference at run time', () => {
  for (const t of [CITATIONS, TUNING_RULES, PIPE_SCHEDULES, PIPE_SCHEDULE_NOTES, ROUGHNESS_REF,
    FITTING_K_REF, VIBRATION_ZONES, INSTRUMENT_CLASSES, MOTOR_EFFICIENCY, MOTOR_CLASS_NOTES,
    MOTOR_PART_LOAD, ENERGY_REFERENCE, VALVE_CHARACTERISTICS, TYPICAL_KV, PRESSURE_CLASSES,
    GLOSSARY, GLOSSARY_AREAS, RULE_INPUT, RULE_INTENT, DESIGN_VELOCITY_MS]) {
    assert.ok(Object.isFrozen(t), `${JSON.stringify(t).slice(0, 40)}... is not frozen`);
  }
});

test('the module is pure: the same call twice gives the same answer', () => {
  // No clock and no RNG anywhere in `src/content`, so this is cheap insurance against somebody
  // reaching for one later.
  const a = evaluateRule('SIMC_PI', WELL_CONDITIONED);
  const b = evaluateRule('SIMC_PI', WELL_CONDITIONED);
  assert.deepEqual(a, b);
  nearRel(motorEfficiency('IE3', 22).eta, motorEfficiency('IE3', 22).eta, 0, 'motor efficiency');
  assert.deepEqual(searchGlossary('pump', 5), searchGlossary('pump', 5));
});
