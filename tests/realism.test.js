/**
 * tests/realism.test.js — the switchboard for the optional realism layer.
 *
 * Four claims carry this file, and they are the four a user's trust in the whole layer rests on.
 *
 * OFF IS INERT. Not "mostly off", not "off except the rate you left at 2.5 last session". Every
 * feature false and every rate back at its documented default, whatever the configuration was
 * doing a moment earlier. If this ever fails, the lesson curriculum starts producing results
 * nobody can reproduce and nobody will know why.
 *
 * THE PRESETS ARE COHERENT. Each of the four is a complete configuration that validates clean,
 * and each one is what its description says it is — LIGHT teaches without breaking anything,
 * PUNISHING is harsher than FULL on every severity knob and on none of them by accident.
 *
 * AN UNKNOWN NAME IS REFUSED. A typo'd feature id has to come back as a sentence, because the
 * alternative is a user who believes they threw a switch, sees nothing happen for twenty minutes,
 * and concludes the simulator is broken.
 *
 * THE ACCELERATION FACTOR LIVES IN ONE PLACE. `agedHours()` is the only conversion from wall time
 * to plant age in the layer; if it can be got at any other way the number in the UI stops being
 * true.
 *
 * The storage cases are exercised against a real fake storage rather than a stub of the module,
 * because the claim is about behaviour at the boundary and a stub would only test the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REALISM_VERSION, STORAGE_KEY, FEATURE, FEATURE_ORDER, FEATURE_INFO, RATES, PRESET,
  PRESET_ORDER, CUSTOM, DEFAULT_AGEING,
  createRealismConfig, isOn, anyOn, setFeature, setPreset, setRate, rateOf, setSeed,
  agedHours, agedDays, describeAgeing, describePreset, describeFeature,
  validateRealismConfig, saveRealismConfig, loadRealismConfig,
} from '../src/realism/config.js';

/**
 * A storage that behaves. `fail` selects a method to make throw, the way a private-mode browser
 * does.
 * @param {object} [seed] initial contents, key to string
 * @param {string} [fail] 'read', 'write' or nothing
 * @returns {object} a storage with getItem/setItem
 */
function fakeStorage(seed, fail) {
  const map = { ...(seed || {}) };
  return {
    map,
    /**
     * @param {string} k the key
     * @returns {string|null} the stored text
     */
    getItem(k) {
      if (fail === 'read') throw new Error('SecurityError: the operation is insecure');
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    },
    /**
     * @param {string} k the key
     * @param {string} v the text
     * @returns {void}
     */
    setItem(k, v) {
      if (fail === 'write') throw new Error('QuotaExceededError');
      map[k] = String(v);
    },
  };
}

/** The rate keys, for the many places a test wants to sweep all of them. */
const RATE_KEYS = RATES.map((r) => r.key);

/** The severity knobs PUNISHING is supposed to raise. Deliberately excludes `ageing`. */
const SEVERITY = ['wear', 'drift', 'fouling', 'failure', 'consumption', 'leadTime', 'cost', 'humanError', 'fatigue'];

// ---------------------------------------------------------------------------------------------
// The tables

test('there are exactly seven features and every one of them is described', () => {
  assert.equal(FEATURE_ORDER.length, 7, 'the brief specifies seven mechanisms; the UI lays out seven switches');
  assert.equal(new Set(FEATURE_ORDER).size, 7, 'two features sharing an id would make isOn ambiguous');
  assert.equal(FEATURE_INFO.length, FEATURE_ORDER.length,
    'FEATURE_INFO and FEATURE_ORDER disagree, so the dialog would either miss a switch or invent one');
  for (const id of FEATURE_ORDER) {
    assert.equal(FEATURE[id], id, `FEATURE.${id} must be its own id so it can be passed straight to isOn`);
    const info = describeFeature(id);
    assert.ok(info, `${id} has no entry in FEATURE_INFO, so its switch would appear unlabelled`);
    assert.ok(info.name.length > 3, `${id} has no usable name for the dialog`);
    assert.ok(info.blurb.length > 120, `${id} has a blurb too short to tell an operator what they are switching on`);
    for (const need of info.needs) {
      assert.ok(FEATURE_ORDER.includes(need), `${id} declares a dependency on ${need}, which is not a feature`);
    }
  }
});

test('every rate has a defensible range, a default inside it, and a stated reason', () => {
  assert.equal(new Set(RATE_KEYS).size, RATE_KEYS.length, 'a duplicated rate key would make setRate write the wrong knob');
  for (const r of RATES) {
    assert.ok(r.min < r.max, `${r.key} has an empty range, so no value could ever be set`);
    assert.ok(r.def >= r.min && r.def <= r.max, `${r.key} defaults to ${r.def}, outside its own ${r.min}..${r.max}`);
    assert.ok(r.why.length > 60, `${r.key} has no stated reason, and every number here has to be arguable`);
    assert.ok(r.feature === null || FEATURE_ORDER.includes(r.feature),
      `${r.key} is governed by ${r.feature}, which is not a feature`);
  }
});

test('the acceleration factor is one documented number, defaulting to 720', () => {
  const ageing = RATES.find((r) => r.key === 'ageing');
  assert.equal(DEFAULT_AGEING, 720, 'the brief and the UI copy both quote 720x; changing it silently invalidates both');
  assert.equal(ageing.def, DEFAULT_AGEING, 'the rate table and the exported constant have drifted apart');
  assert.equal(ageing.feature, null, 'time compression governs the whole layer, not one feature');
});

// ---------------------------------------------------------------------------------------------
// Defaults, and OFF

test('a configuration created with no argument has every feature switched off', () => {
  const cfg = createRealismConfig();
  assert.equal(cfg.preset, 'OFF', 'a user who did not ask for realism must not be given any');
  for (const id of FEATURE_ORDER) {
    assert.equal(isOn(cfg, id), false, `${id} is on by default, so the clean teaching rig is no longer clean`);
  }
  assert.equal(anyOn(cfg), false, 'anyOn is how sim.js skips the layer entirely; it must be false on the default');
});

test('an unrecognised preset argument falls back to OFF rather than to something interesting', () => {
  for (const bad of [undefined, null, 'HARD', 42, {}, { id: 'HARD' }]) {
    const cfg = createRealismConfig(bad);
    assert.equal(cfg.preset, 'OFF', `createRealismConfig(${JSON.stringify(bad)}) has to fail towards OFF`);
    assert.equal(anyOn(cfg), false, 'a defaulting mistake must never switch realism on');
  }
});

test('OFF restores every rate as well as every switch, so no knob survives a preset change', () => {
  const cfg = createRealismConfig('PUNISHING');
  assert.equal(anyOn(cfg), true, 'PUNISHING with nothing on would make the rest of this test vacuous');
  assert.notDeepEqual(cfg.rates, PRESET.OFF.rates, 'PUNISHING is supposed to move some rates');

  assert.deepEqual(setPreset(cfg, 'OFF'), { ok: true }, 'OFF has to be reachable from anywhere');
  for (const id of FEATURE_ORDER) {
    assert.equal(cfg.features[id], false, `${id} survived a switch to OFF`);
  }
  for (const r of RATES) {
    assert.equal(cfg.rates[r.key], r.def,
      `${r.key} is still ${cfg.rates[r.key]} after switching to OFF; it should be back at its default ${r.def}`);
  }
  assert.equal(anyOn(cfg), false, 'OFF must be inert, and this is the one-line proof of it');
});

test('isOn is false for a missing configuration and for a name that is not a feature', () => {
  const cfg = createRealismConfig('FULL');
  assert.equal(isOn(null, FEATURE.WEAR), false, 'a module handed no realism config must behave as if it were off');
  assert.equal(isOn(undefined, FEATURE.WEAR), false, 'ditto for undefined');
  assert.equal(isOn({}, FEATURE.WEAR), false, 'an object with no features is not a configuration');
  assert.equal(isOn(cfg, 'WARE'), false, 'a typo must read as off rather than as truthy');
  assert.equal(isOn(cfg, FEATURE.WEAR), true, 'FULL has wear on; if this fails the guards have gone too far');
});

// ---------------------------------------------------------------------------------------------
// The presets

test('all four presets are complete configurations and every one of them validates clean', () => {
  assert.deepEqual(PRESET_ORDER.slice(), ['OFF', 'LIGHT', 'FULL', 'PUNISHING'],
    'the four shipped presets, least reality first');
  for (const id of PRESET_ORDER) {
    const p = PRESET[id];
    assert.equal(p.id, id, `PRESET.${id} disagrees with its own id, so setPreset(cfg, PRESET.${id}) would misfire`);
    for (const f of FEATURE_ORDER) {
      assert.equal(typeof p.features[f], 'boolean', `${id} does not say whether ${f} is on, so applying it would leave a stale switch`);
    }
    for (const r of RATES) {
      assert.equal(typeof p.rates[r.key], 'number', `${id} does not set ${r.key}, so applying it would leave a stale rate`);
    }
    const cfg = createRealismConfig(id);
    assert.deepEqual(validateRealismConfig(cfg), [], `the shipped ${id} preset does not validate`);
  }
});

test('LIGHT teaches without punishing: drift and slow fouling on, nothing that can break', () => {
  const cfg = createRealismConfig('LIGHT');
  assert.equal(isOn(cfg, FEATURE.CALIBRATION), true, 'LIGHT exists mainly to teach that the indication is not the truth');
  assert.equal(isOn(cfg, FEATURE.WEAR), true, 'the slow fouling LIGHT promises lives in the wear model');
  for (const id of [FEATURE.CONSUMABLES, FEATURE.OPERATORS, FEATURE.WORKORDERS, FEATURE.FAILURES, FEATURE.COSTS]) {
    assert.equal(isOn(cfg, id), false, `${id} is on in LIGHT, which is supposed to add nothing that punishes`);
  }
  assert.ok(rateOf(cfg, 'wear') < rateOf(createRealismConfig('FULL'), 'wear'),
    'LIGHT must wear the machinery more slowly than a real plant does, or it is not light');
  assert.ok(rateOf(cfg, 'fouling') < rateOf(createRealismConfig('FULL'), 'fouling'),
    'LIGHT promises a SLOW fouling rate');
  assert.ok(rateOf(cfg, 'drift') > rateOf(createRealismConfig('FULL'), 'drift'),
    'LIGHT runs drift deliberately fast — a lesson you cannot see inside one session is not a lesson');
});

test('PUNISHING is a bad site rather than a fast clock', () => {
  const full = createRealismConfig('FULL');
  const bad = createRealismConfig('PUNISHING');
  assert.equal(rateOf(bad, 'ageing'), rateOf(full, 'ageing'),
    'PUNISHING must not move the acceleration factor; if it did, "ageing 720x" would stop being checkable');
  for (const key of SEVERITY) {
    assert.ok(rateOf(bad, key) > rateOf(full, key),
      `PUNISHING leaves ${key} at ${rateOf(bad, key)}, no harder than FULL — it is meant to be harder on every severity knob`);
  }
  assert.ok(rateOf(bad, 'stock') < rateOf(full, 'stock'), 'a thin store is the point of PUNISHING');
  assert.ok(rateOf(bad, 'budget') < rateOf(full, 'budget'), 'PUNISHING is supposed to force a choice about what to spend');
  for (const id of FEATURE_ORDER) {
    assert.equal(isOn(bad, id), true, `${id} is off in PUNISHING, which is meant to be everything on and worse`);
  }
});

test('FULL is everything on at honest rates', () => {
  const cfg = createRealismConfig('FULL');
  for (const id of FEATURE_ORDER) {
    assert.equal(isOn(cfg, id), true, `${id} is off in FULL`);
  }
  for (const r of RATES) {
    assert.equal(cfg.rates[r.key], r.def,
      `FULL moves ${r.key} to ${cfg.rates[r.key]}; it is supposed to be the published rates untouched`);
  }
});

test('every preset carries a paragraph long enough to be worth reading, and unknown ones do not', () => {
  for (const id of PRESET_ORDER) {
    const text = describePreset(id);
    assert.ok(typeof text === 'string' && text.length > 300,
      `${id} has no usable description; switching a preset on blind is how a user concludes the rig is broken`);
    assert.equal(describePreset(PRESET[id]), text, 'passing the preset object must describe the same preset');
  }
  assert.ok(describePreset('PUNISHING').includes('720'),
    'the PUNISHING copy has to say the clock is unchanged, because that is the thing users assume otherwise');
  assert.equal(describePreset('HARD'), null, 'an unknown preset must not be given prose that reads as if it exists');
  assert.equal(describePreset(null), null, 'nor must a missing one');
  assert.ok(describePreset(CUSTOM).length > 100, 'a hand-built configuration still needs something said about it');
});

// ---------------------------------------------------------------------------------------------
// Refusals

test('an unknown feature is refused with a sentence naming the seven that exist', () => {
  const cfg = createRealismConfig('OFF');
  const r = setFeature(cfg, 'WARE', true);
  assert.equal(r.ok, false, 'a typo\'d feature id must not be silently ignored');
  assert.ok(/WARE/.test(r.reason), 'the refusal has to quote what the caller actually asked for');
  assert.ok(/WEAR/.test(r.reason), 'the refusal should list the ids that do exist');
  assert.equal(anyOn(cfg), false, 'a refused switch must not have changed anything');

  for (const bad of [null, undefined, 42, {}, 'wear']) {
    assert.equal(setFeature(cfg, bad, true).ok, false, `setFeature accepted ${JSON.stringify(bad)} as a feature id`);
  }
  assert.equal(setFeature(null, FEATURE.WEAR, true).ok, false, 'setFeature on no configuration must refuse, not throw');
});

test('an unknown preset is refused and leaves the configuration exactly as it was', () => {
  const cfg = createRealismConfig('LIGHT');
  const before = JSON.stringify(cfg);
  const r = setPreset(cfg, 'HARD');
  assert.equal(r.ok, false, 'an unknown preset must be refused rather than falling back to something');
  assert.ok(/HARD/.test(r.reason), 'the refusal has to quote what was asked for');
  assert.ok(/PUNISHING/.test(r.reason), 'the refusal should list the presets that do exist');
  assert.equal(JSON.stringify(cfg), before, 'a refused preset change must be a no-op');
  assert.equal(setPreset(null, 'OFF').ok, false, 'setPreset on no configuration must refuse, not throw');
  assert.equal(setPreset(cfg, PRESET.FULL).ok, true, 'passing the preset object itself is the mistake every caller makes once');
  assert.equal(cfg.preset, 'FULL', 'and it has to actually apply FULL');
});

test('a rate is refused rather than clamped when the user asks for something out of range', () => {
  const cfg = createRealismConfig('FULL');
  const meta = RATES.find((r) => r.key === 'wear');

  const tooBig = setRate(cfg, 'wear', meta.max + 1);
  assert.equal(tooBig.ok, false, 'silently clamping is a disagreement the user never finds out about');
  assert.ok(tooBig.reason.includes(String(meta.max)), 'the refusal must say what the allowed range is');
  assert.equal(cfg.rates.wear, meta.def, 'a refused rate must not have been written');

  assert.equal(setRate(cfg, 'wear', meta.min - 1).ok, false, 'below the range is refused too');
  assert.equal(setRate(cfg, 'wear', NaN).ok, false, 'NaN would poison every plant value downstream of it');
  assert.equal(setRate(cfg, 'wear', Infinity).ok, false, 'so would an infinity');
  const unknown = setRate(cfg, 'were', 2);
  assert.equal(unknown.ok, false, 'an unknown rate key must be refused');
  assert.ok(/ageing/.test(unknown.reason), 'the refusal should list the keys that do exist');
  assert.equal(setRate(null, 'wear', 2).ok, false, 'setRate on no configuration must refuse, not throw');

  assert.deepEqual(setRate(cfg, 'wear', 2), { ok: true }, 'a value inside the range is accepted');
  assert.equal(cfg.rates.wear, 2, 'and written');
});

test('the seed is guarded, because a maintenance history has to be reproducible from it', () => {
  const cfg = createRealismConfig('FULL');
  assert.ok(Number.isInteger(cfg.seed) && cfg.seed >= 0, 'a configuration ships with a usable seed');
  assert.equal(setSeed(cfg, 7).ok, true, 'a whole number is a seed');
  assert.equal(cfg.seed, 7, 'and it is written');
  assert.equal(setSeed(cfg, 1.5).ok, false, 'a fractional seed would not survive a round trip through storage');
  assert.equal(setSeed(cfg, -1).ok, false, 'nor would a negative one');
  assert.equal(cfg.seed, 7, 'a refused seed must not have been written');
});

// ---------------------------------------------------------------------------------------------
// The CUSTOM label

test('changing anything by hand relabels the configuration, and undoing it labels it back', () => {
  const cfg = createRealismConfig('OFF');
  assert.equal(setFeature(cfg, FEATURE.WEAR, true).ok, true, 'every feature is individually switchable');
  assert.equal(cfg.preset, CUSTOM, 'OFF with wear on is not OFF, and the label must say so');

  assert.equal(setFeature(cfg, FEATURE.WEAR, false).ok, true, 'and switchable back');
  assert.equal(cfg.preset, 'OFF', 'a user who undoes a change should not be stuck on CUSTOM for the session');

  setPreset(cfg, 'FULL');
  setRate(cfg, 'cost', 1.25);
  assert.equal(cfg.preset, CUSTOM, 'a moved rate is a custom configuration too');
  setRate(cfg, 'cost', RATES.find((r) => r.key === 'cost').def);
  assert.equal(cfg.preset, 'FULL', 'restoring the rate restores the label');
});

// ---------------------------------------------------------------------------------------------
// The clock

test('agedHours is the single conversion from wall time to plant age', () => {
  const cfg = createRealismConfig('FULL');
  assert.equal(agedHours(cfg, 3600), DEFAULT_AGEING,
    'an hour of running at 720x has to be 720 equipment hours, or the number in the UI is a lie');
  assert.equal(agedHours(cfg, 1), DEFAULT_AGEING / 3600, 'and it has to be linear in the scan interval');
  assert.equal(agedDays(cfg, 3600), DEFAULT_AGEING / 24, 'the days conversion is the same number divided by 24');

  setRate(cfg, 'ageing', 1);
  assert.equal(agedHours(cfg, 3600), 1, 'at 1x an hour of running is an hour on the machine');

  const off = createRealismConfig('OFF');
  assert.equal(agedHours(off, 3600), DEFAULT_AGEING,
    'OFF is inert because nothing reads the clock, not because the clock was zeroed — a user who then '
    + 'switches wear on must get an honest plant rather than a frozen one');
});

test('a bad scan interval ages the plant by nothing rather than by NaN', () => {
  const cfg = createRealismConfig('FULL');
  for (const bad of [0, -1, NaN, Infinity, undefined, null, 'ten']) {
    const h = agedHours(cfg, bad);
    assert.equal(h, 0, `agedHours returned ${h} for a scan interval of ${String(bad)}; a bad dt must not age anything`);
  }
  assert.equal(agedHours(null, 3600), DEFAULT_AGEING, 'a missing configuration still ages at the documented default');
});

test('rateOf falls back to the documented default rather than to undefined', () => {
  assert.equal(rateOf(null, 'wear'), 1, 'a module with no configuration reads the published rate');
  assert.equal(rateOf({}, 'ageing'), DEFAULT_AGEING, 'an empty object is not a configuration but must not break the clock');
  assert.equal(rateOf(createRealismConfig('FULL'), 'nosuchrate'), 1,
    'an unknown key returns a neutral multiplier rather than undefined, which would be NaN downstream');
  const cfg = createRealismConfig('FULL');
  delete cfg.rates.wear;
  assert.equal(rateOf(cfg, 'wear'), 1, 'a rate missing from an older save reads as its default');
});

test('the ageing sentence states the factor, because the UI is required to show it', () => {
  const cfg = createRealismConfig('FULL');
  const text = describeAgeing(cfg);
  assert.ok(text.includes('720'), 'the sentence has to name the factor; that is its entire job');
  assert.ok(text.includes('30 days') || text.includes('30 day'), 'and say what it means in practice');
  setRate(cfg, 'ageing', 1);
  assert.ok(/real time/.test(describeAgeing(cfg)), 'at 1x the sentence should say nothing will visibly age');
});

// ---------------------------------------------------------------------------------------------
// Validation

test('validation reports an incoherent combination instead of quietly doing nothing', () => {
  const cfg = createRealismConfig('OFF');
  setFeature(cfg, FEATURE.FAILURES, true);
  const problems = validateRealismConfig(cfg);
  assert.equal(problems.length, 1, `failures with no wear underneath should raise exactly one warning, got ${problems.length}`);
  assert.ok(/WEAR/.test(problems[0]), 'the warning has to name the switch that is missing');

  setFeature(cfg, FEATURE.WEAR, true);
  assert.deepEqual(validateRealismConfig(cfg), [], 'turning the substrate on clears the warning');

  setRate(cfg, 'failure', 0);
  assert.ok(validateRealismConfig(cfg).some((p) => /ever break/.test(p)),
    'failures on at a zero hazard is legal, useless, and worth saying out loud');
});

test('validation catches a structurally damaged configuration rather than trusting it', () => {
  assert.deepEqual(validateRealismConfig(null), ['There is no realism configuration at all.'],
    'a missing configuration is a problem, not an empty list of problems');

  const cfg = createRealismConfig('FULL');
  cfg.features.WEAR = 'yes';
  cfg.features.SABOTAGE = true;
  cfg.rates.wear = 99;
  cfg.rates.nonsense = 1;
  cfg.seed = 'x';
  cfg.version = REALISM_VERSION + 5;
  const problems = validateRealismConfig(cfg);
  assert.ok(problems.some((p) => /WEAR switch/.test(p)), 'a switch that is neither on nor off has to be reported');
  assert.ok(problems.some((p) => /SABOTAGE/.test(p)), 'a feature this build does not have has to be reported');
  assert.ok(problems.some((p) => /outside/.test(p)), 'a rate outside its range has to be reported');
  assert.ok(problems.some((p) => /nonsense/.test(p)), 'a rate this build does not have has to be reported');
  assert.ok(problems.some((p) => /seed/.test(p)), 'an unusable seed has to be reported');
  assert.ok(problems.some((p) => /newer build/.test(p)), 'a configuration from the future has to be reported');
});

// ---------------------------------------------------------------------------------------------
// Persistence

test('a configuration round-trips through a storage that works', () => {
  const store = fakeStorage();
  const cfg = createRealismConfig('PUNISHING');
  setRate(cfg, 'cost', 1.75);
  setFeature(cfg, FEATURE.OPERATORS, false);
  setSeed(cfg, 991);

  assert.deepEqual(saveRealismConfig(store, cfg), { ok: true }, 'a working storage should accept the write');
  assert.ok(typeof store.map[STORAGE_KEY] === 'string', 'the settings should be under the documented key');

  const back = loadRealismConfig(store);
  assert.deepEqual(back.features, cfg.features, 'every switch has to survive the round trip');
  assert.deepEqual(back.rates, cfg.rates, 'every rate has to survive the round trip');
  assert.equal(back.seed, 991, 'the seed has to survive, or the plant history is not reproducible');
  assert.equal(back.preset, CUSTOM, 'the label is recomputed from what was actually restored');
  assert.deepEqual(validateRealismConfig(back), [], 'what comes back out of storage has to be sound');
});

test('a storage that throws on write reports why and leaves the settings in force', () => {
  const store = fakeStorage({}, 'write');
  const cfg = createRealismConfig('FULL');
  const before = JSON.stringify(cfg);

  const r = saveRealismConfig(store, cfg);
  assert.equal(r.ok, false, 'a quota or private-mode failure has to be reported, not swallowed');
  assert.ok(r.reason.length > 20, 'the reason has to be a sentence the UI can show an operator');
  assert.equal(JSON.stringify(cfg), before,
    'a failed save must never damage the configuration in memory — the settings still apply until the tab closes');
  assert.equal(anyOn(cfg), true, 'and in particular the user has not silently been dropped back to OFF');

  assert.equal(saveRealismConfig(null, cfg).ok, false, 'no storage at all is reported the same way');
  assert.equal(saveRealismConfig({}, cfg).ok, false, 'so is an object that is not a storage');
  assert.equal(saveRealismConfig(fakeStorage(), null).ok, false, 'there is nothing to save without a configuration');
});

test('every way storage can misbehave on the way back in lands on OFF', () => {
  assert.equal(loadRealismConfig(null).preset, 'OFF', 'no storage means no saved settings');
  assert.equal(loadRealismConfig({}).preset, 'OFF', 'an object that is not a storage is not a storage');
  assert.equal(anyOn(loadRealismConfig(fakeStorage({}, 'read'))), false,
    'a getItem that throws must not leave the user running something they cannot see');
  assert.equal(anyOn(loadRealismConfig(fakeStorage({ [STORAGE_KEY]: '{not json' }))), false,
    'a truncated save must not be half-believed');
  assert.equal(anyOn(loadRealismConfig(fakeStorage({ [STORAGE_KEY]: '"a string"' }))), false,
    'a JSON value that is not an object must not be believed');
  assert.equal(anyOn(loadRealismConfig(fakeStorage({ [STORAGE_KEY]: '' }))), false, 'an empty entry is nothing');
});

test('a hand-edited save is repaired field by field rather than trusted or thrown away', () => {
  const store = fakeStorage({
    [STORAGE_KEY]: JSON.stringify({
      version: 1,
      preset: 'IMPOSSIBLE',
      features: { WEAR: true, SABOTAGE: true, CALIBRATION: 'yes' },
      rates: { wear: 500, drift: 2, nonsense: 3 },
      seed: -4,
    }),
  });
  const cfg = loadRealismConfig(store);

  assert.equal(cfg.features.WEAR, true, 'a legible switch should be kept');
  assert.equal(cfg.features.CALIBRATION, false, 'a switch that is not a boolean falls back to off');
  assert.equal('SABOTAGE' in cfg.features, false, 'a feature this build does not have is dropped, not inherited');
  assert.equal(cfg.rates.drift, 2, 'a legible rate should be kept');
  assert.equal(cfg.rates.wear, RATES.find((r) => r.key === 'wear').max,
    'a rate edited past its limit is clamped on load — this is a repair of a file, not a user asking for something');
  assert.equal('nonsense' in cfg.rates, false, 'a rate this build does not have is dropped');
  assert.ok(Number.isInteger(cfg.seed) && cfg.seed >= 0, 'an unusable seed falls back to the default');
  assert.equal(cfg.preset, CUSTOM, 'the label is recomputed rather than believed');
  assert.deepEqual(validateRealismConfig(cfg), [], 'whatever comes back has to be a configuration the layer can run on');
});
