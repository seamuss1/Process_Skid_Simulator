/**
 * tests/replay.test.js — the ghost: decimation, quantisation, the encoded form and the size it
 * has to fit in, and the comparison a player is actually shown.
 *
 * Two of these tests matter more than they look. The budget test is the only thing standing
 * between a dozen saved ghosts and a localStorage quota error that eats whatever was being
 * written at the time — usually the profile. The corruption tests are the only thing standing
 * between a half-written entry, which a closed tab produces routinely, and a game that will not
 * start.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecorder, recordSample, finishRecording, encodeGhost, decodeGhost, ghostAt,
  saveGhost, loadGhost, compareGhosts,
  EU_STEP, CO_STEP, DEFAULT_PERIOD_S, GHOST_BUDGET_BYTES, MAX_SAMPLES, GHOST_VERSION,
} from '../src/game/replay.js';

/**
 * A deterministic pseudo-random stream, local to this file so the tests do not depend on another
 * module's seeding while it is still being written.
 * @param {number} seed any integer
 * @returns {() => number} a generator of numbers in [0, 1)
 */
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Record a ghost by driving a recorder with a function of time.
 * @param {object} opts fixture options
 * @param {number} opts.seconds simulated seconds to record
 * @param {number} [opts.period_s] recording period
 * @param {number} [opts.dt_s] how often a sample is offered
 * @param {(t:number)=>{pv:number,sp:number,co:number}} opts.at the trace
 * @returns {object} the finished ghost
 */
function ghostOf({ seconds, period_s = 0.5, dt_s = 0.1, at }) {
  const rec = createRecorder(period_s);
  const steps = Math.round(seconds / dt_s);
  for (let i = 0; i <= steps; i += 1) {
    const t = i * dt_s;
    const s = at(t);
    recordSample(rec, t, s.pv, s.sp, s.co);
  }
  return finishRecording(rec);
}

/** A storage stub that behaves like localStorage does when it is working. */
function memStore() {
  const m = new Map();
  return {
    /**
     * @param {string} k key
     * @returns {string|null} the stored text
     */
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    /**
     * @param {string} k key
     * @param {string} v value
     * @returns {void}
     */
    setItem: (k, v) => { m.set(k, String(v)); },
    /** @returns {Map<string,string>} the backing map, for the tests to corrupt */
    _map: m,
  };
}

test('a recorder keeps one sample per period however fast it is offered them', () => {
  const g = ghostOf({ seconds: 10, period_s: 0.5, dt_s: 0.05, at: (t) => ({ pv: t, sp: 4, co: 50 }) });
  assert.equal(g.n, 21, 'ten seconds at half-second decimation is twenty-one samples, not two hundred');
  assert.equal(g.v, GHOST_VERSION, 'a ghost states its format so a later build can refuse it');
  assert.ok(Math.abs(g.pv[0] - 0) < 1e-9, 'the first offered sample is the one that starts the ghost');
  assert.ok(Math.abs(g.pv[20] - 10) < EU_STEP, 'and sample i must be the trace at i * period');
});

test('a recorded value is preserved to the quantisation step and no better', () => {
  const rec = createRecorder(0.5);
  recordSample(rec, 0, 3.14159, 2.71828, 61.2345);
  const g = finishRecording(rec);
  assert.ok(Math.abs(g.pv[0] - 3.14159) <= EU_STEP / 2,
    `pv must land within half a step of the truth, got ${g.pv[0]}`);
  assert.ok(Math.abs(g.sp[0] - 2.71828) <= EU_STEP / 2,
    `sp must land within half a step of the truth, got ${g.sp[0]}`);
  assert.ok(Math.abs(g.co[0] - 61.2345) <= CO_STEP / 2,
    `co must land within half a step of the truth, got ${g.co[0]}`);
  assert.ok(Math.abs(Math.round(g.pv[0] / EU_STEP) * EU_STEP - g.pv[0]) < 1e-9,
    'a stored value must already sit on the grid, so encoding it changes nothing');
});

test('a five-minute ghost of a working loop encodes to under the per-ghost storage budget', () => {
  const rnd = lcg(20260907);
  let co = 55;
  const g = ghostOf({
    seconds: 300,
    period_s: DEFAULT_PERIOD_S,
    dt_s: 0.1,
    at: (t) => {
      co += (rnd() - 0.5) * 3;
      return {
        pv: 4 + 0.35 * Math.sin(t / 7) + (rnd() - 0.5) * 0.06,
        sp: t < 150 ? 4 : 4.4,
        co,
      };
    },
  });
  assert.equal(g.n, 601, 'three hundred seconds at half a second is six hundred and one samples');
  const text = encodeGhost(g);
  assert.ok(text.length < GHOST_BUDGET_BYTES,
    `a 300 s ghost encodes to ${text.length} chars against a ${GHOST_BUDGET_BYTES} budget; over `
    + 'this line a dozen ghosts start competing with the profile for the quota');
  assert.ok(text.length < JSON.stringify([g.pv, g.sp, g.co]).length / 4,
    'and it must be a large multiple smaller than the JSON it replaces, or it is not worth having');
});

test('an encoded ghost decodes back to exactly the values that went into it', () => {
  const rnd = lcg(7);
  const g = ghostOf({
    seconds: 120,
    period_s: 0.25,
    dt_s: 0.05,
    at: (t) => ({ pv: 3 + Math.sin(t) + (rnd() - 0.5) * 0.2, sp: 3, co: 40 + 25 * Math.cos(t / 3) }),
  });
  const back = decodeGhost(encodeGhost(g));
  assert.ok(back, 'a ghost this build wrote must decode');
  assert.equal(back.n, g.n, 'the sample count must survive the trip');
  assert.ok(Math.abs(back.period_s - g.period_s) < 1e-9, 'and so must the period');
  for (let i = 0; i < g.n; i += 1) {
    assert.ok(Math.abs(back.pv[i] - g.pv[i]) < 1e-9, `pv sample ${i} changed in the round trip`);
    assert.ok(Math.abs(back.sp[i] - g.sp[i]) < 1e-9, `sp sample ${i} changed in the round trip`);
    assert.ok(Math.abs(back.co[i] - g.co[i]) < 1e-9, `co sample ${i} changed in the round trip`);
  }
});

test('a large negative excursion round-trips as accurately as a small positive one', () => {
  const rec = createRecorder(1);
  const values = [0, -12.5, 999.99, -999.99, 0.01, -0.01];
  for (let i = 0; i < values.length; i += 1) recordSample(rec, i, values[i], -values[i], 100 - i);
  const back = decodeGhost(encodeGhost(finishRecording(rec)));
  assert.ok(back, 'wide swings must not break the varint encoding');
  for (let i = 0; i < values.length; i += 1) {
    assert.ok(Math.abs(back.pv[i] - values[i]) <= EU_STEP / 2,
      `sample ${i} came back as ${back.pv[i]} instead of ${values[i]}`);
  }
});

test('decodeGhost refuses truncated, corrupted and foreign text instead of throwing', () => {
  const g = ghostOf({ seconds: 20, at: (t) => ({ pv: t / 10, sp: 2, co: 50 }) });
  const text = encodeGhost(g);
  assert.ok(decodeGhost(text), 'the fixture itself must be decodable, or this test proves nothing');

  const truncated = text.slice(0, Math.floor(text.length * 0.6));
  assert.equal(decodeGhost(truncated), null,
    'a tab closed mid-write leaves exactly this, and it must not become a short ghost');
  assert.equal(decodeGhost(text.slice(0, -1)), null, 'a single lost character is still corruption');

  const flipped = `${text.slice(0, 12)}${text[12] === 'A' ? 'B' : 'A'}${text.slice(13)}`;
  assert.notEqual(flipped, text, 'the fixture must actually differ for this assertion to mean anything');
  assert.equal(decodeGhost(flipped), null, 'a flipped character must fail the checksum');

  assert.equal(decodeGhost(`${text}AAAA`), null, 'trailing rubbish is corruption too');
  for (const junk of ['', 'G1', 'G1.500.3', 'G2.500.3.A.A.A.0', '{"pv":[1,2,3]}', 'null']) {
    assert.equal(decodeGhost(junk), null, `"${junk}" must decode to null`);
  }
  for (const junk of [null, undefined, 42, {}, [], NaN]) {
    assert.equal(decodeGhost(junk), null, `${String(junk)} must decode to null rather than throw`);
  }
});

test('a ghost with an impossible sample count is refused before it is read', () => {
  // Hand-built rather than recorded: this is what a hostile or bit-rotted entry looks like.
  const body = `G1.500.${MAX_SAMPLES + 1}.A.A.A`;
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const text = `${body}.${(h >>> 0).toString(36)}`;
  assert.equal(decodeGhost(text), null,
    'a count past the cap must be refused, not allocated');
});

test('ghostAt interpolates between samples and refuses times outside the recording', () => {
  const g = ghostOf({ seconds: 10, period_s: 1, dt_s: 0.5, at: (t) => ({ pv: t, sp: 5, co: 10 * t }) });
  assert.equal(g.n, 11, 'the fixture is eleven samples one second apart');

  const mid = ghostAt(g, 3.5);
  assert.ok(mid, 'a time inside the recording must return a sample');
  assert.ok(Math.abs(mid.pv - 3.5) < 1e-6,
    `halfway between 3 and 4 must read 3.5, got ${mid.pv} — a hold here puts a staircase on the trace`);
  assert.ok(Math.abs(mid.co - 35) < 1e-6, 'and the output channel interpolates with it');

  const quarter = ghostAt(g, 6.25);
  assert.ok(Math.abs(quarter.pv - 6.25) < 1e-6, 'interpolation must be linear, not nearest-sample');

  assert.ok(ghostAt(g, 0), 'the first sample is inside the recording');
  assert.ok(ghostAt(g, 10), 'and so is the last');
  assert.equal(ghostAt(g, -0.5), null, 'before the start there is nothing to draw');
  assert.equal(ghostAt(g, 10.5), null, 'and after the end the ghost must stop, not flatline');
  assert.equal(ghostAt(g, NaN), null, 'a NaN time is not a time');
  assert.equal(ghostAt(null, 1), null, 'and a missing ghost is not a ghost');
});

test('compareGhosts names which run was closer to setpoint over which interval', () => {
  // A holds the setpoint for the first ten seconds and drifts a bar off it for the second ten;
  // B does the reverse. The answer is not a matter of opinion.
  const a = ghostOf({ seconds: 20, period_s: 1, dt_s: 1, at: (t) => ({ pv: t < 10 ? 4 : 5, sp: 4, co: 50 }) });
  const b = ghostOf({ seconds: 20, period_s: 1, dt_s: 1, at: (t) => ({ pv: t < 10 ? 3 : 4, sp: 4, co: 50 }) });

  const cmp = compareGhosts(a, b);
  assert.equal(cmp.samples, 21, 'twenty seconds on a one-second grid is twenty-one comparisons');
  assert.ok(Math.abs(cmp.span_s - 20) < 1e-9, 'the compared span is the overlap of the two runs');
  assert.equal(cmp.leadAt.length, 2, 'there are exactly two intervals here, and merging them is a bug');
  assert.equal(cmp.leadAt[0].lead, 'a', 'A held the setpoint first, so A leads first');
  assert.ok(Math.abs(cmp.leadAt[0].from_s - 0) < 1e-9, 'A leads from the very start');
  assert.ok(Math.abs(cmp.leadAt[0].to_s - 9) < 1e-9, 'until the second it drifts off');
  assert.equal(cmp.leadAt[1].lead, 'b', 'and B leads for the rest');
  assert.ok(Math.abs(cmp.leadAt[1].to_s - 20) < 1e-9, 'right to the end of the overlap');
  assert.ok(Math.abs(cmp.betterFraction - 10 / 21) < 1e-9,
    `A was closer for ten of twenty-one samples, got ${cmp.betterFraction}`);
  assert.ok(Math.abs(cmp.maxGap - 1) < 1e-6,
    `the two runs were never more than one EU apart in deviation, got ${cmp.maxGap}`);

  const flipped = compareGhosts(b, a);
  assert.ok(Math.abs(flipped.betterFraction - 11 / 21) < 1e-9,
    'swapping the arguments must swap who is winning');
});

test('compareGhosts calls a difference below the recording step a tie, not a win', () => {
  const a = ghostOf({ seconds: 5, period_s: 1, dt_s: 1, at: () => ({ pv: 4, sp: 4, co: 50 }) });
  const b = ghostOf({ seconds: 5, period_s: 1, dt_s: 1, at: () => ({ pv: 4.005, sp: 4, co: 50 }) });
  const cmp = compareGhosts(a, b);
  assert.equal(cmp.leadAt.length, 1, 'one uninterrupted interval');
  assert.equal(cmp.leadAt[0].lead, 'tie', 'a difference finer than the quantisation is noise, not skill');
  assert.equal(cmp.betterFraction, 0, 'and it wins nobody anything');
});

test('compareGhosts stops at the end of the shorter run rather than inventing the rest', () => {
  const long = ghostOf({ seconds: 30, period_s: 1, dt_s: 1, at: () => ({ pv: 4, sp: 4, co: 50 }) });
  const short = ghostOf({ seconds: 8, period_s: 2, dt_s: 1, at: () => ({ pv: 6, sp: 4, co: 50 }) });
  const cmp = compareGhosts(long, short);
  assert.ok(Math.abs(cmp.span_s - 8) < 1e-9, 'the overlap is eight seconds, not thirty');
  assert.equal(cmp.samples, 5, 'and it is compared on the coarser two-second grid');
  assert.equal(cmp.betterFraction, 1, 'the run that sat on setpoint led every one of them');
});

test('compareGhosts returns an empty comparison rather than throwing on a missing run', () => {
  const g = ghostOf({ seconds: 5, at: () => ({ pv: 4, sp: 4, co: 50 }) });
  const emptyGhost = finishRecording(createRecorder(0.5));
  for (const pair of [[null, g], [g, undefined], [g, emptyGhost], [emptyGhost, emptyGhost], [{}, g]]) {
    const cmp = compareGhosts(pair[0], pair[1]);
    assert.deepEqual(cmp.leadAt, [], 'nothing to compare means no intervals');
    assert.equal(cmp.betterFraction, 0, 'and nobody won');
    assert.equal(cmp.samples, 0, 'and nothing was sampled');
  }
});

test('a recorder given a zero, negative or absent period still records on a sane one', () => {
  for (const bad of [0, -1, NaN, undefined, null, 'half a second', Infinity]) {
    const rec = createRecorder(bad);
    assert.ok(rec.period_s > 0 && Number.isFinite(rec.period_s),
      `a period of ${String(bad)} must fall back to a usable one, got ${rec.period_s}`);
    recordSample(rec, 0, 1, 1, 1);
    recordSample(rec, 60, 2, 2, 2);
    const g = finishRecording(rec);
    assert.ok(g.n >= 2 && g.n < MAX_SAMPLES,
      'and the fallback must produce a ghost of sane length, not one sample or a million');
  }
  assert.equal(createRecorder(undefined).period_s, DEFAULT_PERIOD_S, 'the documented default applies');
});

test('a dt of zero and a clock that runs backwards add no samples', () => {
  const rec = createRecorder(0.5);
  recordSample(rec, 10, 4, 4, 50);
  for (let i = 0; i < 100; i += 1) recordSample(rec, 10, 9, 9, 99);
  assert.equal(rec.n, 1, 'a hundred offers at the same instant is one sample');
  recordSample(rec, 5, 9, 9, 99);
  assert.equal(rec.n, 1, 'and a time before the recording started is not a new sample either');
  const g = finishRecording(rec);
  assert.ok(Math.abs(g.pv[0] - 4) < 1e-9, 'the sample that was kept is the first one offered');
});

test('a NaN in a sample never reaches the ghost', () => {
  const rec = createRecorder(1);
  recordSample(rec, 0, 4.2, 4, 55);
  recordSample(rec, 1, NaN, 4, Infinity);
  recordSample(rec, 2, 4.4, NaN, 57);
  const g = finishRecording(rec);
  assert.equal(g.n, 3, 'a poisoned frame is still a frame — the timebase must not shift');
  for (const ch of ['pv', 'sp', 'co']) {
    for (let i = 0; i < g.n; i += 1) {
      assert.ok(Number.isFinite(g[ch][i]),
        `${ch}[${i}] is ${g[ch][i]}; one NaN turns every later comparison into a silent no-op`);
    }
  }
  assert.ok(Math.abs(g.pv[1] - 4.2) < 1e-9, 'a non-finite value holds the last good one');
  assert.ok(Math.abs(g.co[1] - 55) < 1e-9, 'on every channel');
  assert.ok(decodeGhost(encodeGhost(g)), 'and the ghost still encodes');
});

test('a gap in recording holds the last value so sample i still means time i times the period', () => {
  const rec = createRecorder(1);
  recordSample(rec, 0, 4, 4, 50);
  recordSample(rec, 1, 5, 4, 50);
  // The sim was paused here for eight seconds, which is a thing a player does mid-mission.
  recordSample(rec, 9, 6, 4, 50);
  const g = finishRecording(rec);
  assert.equal(g.n, 10, 'the ghost must span the pause, or every later sample is drawn early');
  assert.ok(Math.abs(g.pv[5] - 5) < 1e-9, 'the paused span holds the last value that was seen');
  assert.ok(Math.abs(g.pv[9] - 6) < 1e-9, 'and the sample after the gap lands at the time it happened');
  const at = ghostAt(g, 9);
  assert.ok(Math.abs(at.pv - 6) < 1e-9, 'so reading by time agrees with reading by index');
});

test('a recorder stops at its cap instead of allocating without bound', () => {
  const rec = createRecorder(0.05);
  recordSample(rec, 0, 4, 4, 50);
  recordSample(rec, 1e9, 5, 4, 50);
  assert.equal(rec.n, MAX_SAMPLES, 'a wild timestamp fills to the cap and no further');
  assert.equal(rec.full, true, 'and the recorder says it is done');
  recordSample(rec, 1e10, 6, 4, 50);
  assert.equal(rec.n, MAX_SAMPLES, 'a full recorder ignores everything after it');
});

test('an untouched recorder yields an empty ghost that everything downstream tolerates', () => {
  const g = finishRecording(createRecorder(0.5));
  assert.equal(g.n, 0, 'nothing recorded is nothing to show');
  assert.equal(ghostAt(g, 0), null, 'an empty ghost has no sample at any time');
  const text = encodeGhost(g);
  const back = decodeGhost(text);
  assert.ok(back, 'an empty ghost is still a valid ghost and must survive the round trip');
  assert.equal(back.n, 0, 'and come back empty');
  assert.equal(encodeGhost(null), '', 'while a missing ghost encodes to nothing at all');
  assert.equal(encodeGhost({ period_s: 1, n: 3, pv: [1], sp: [1], co: [1] }), '',
    'and a ghost whose channels disagree with its count is refused rather than half-written');
  assert.equal(finishRecording(null).n, 0, 'finishing a missing recorder is not a crash');
});

test('a ghost round-trips through a storage that behaves', () => {
  const store = memStore();
  const g = ghostOf({ seconds: 30, at: (t) => ({ pv: 4 + Math.sin(t), sp: 4, co: 50 }) });
  const res = saveGhost(store, 'ghost:best:m01', g);
  assert.equal(res.ok, true, `saving a normal ghost must succeed, got: ${res.reason}`);
  const back = loadGhost(store, 'ghost:best:m01');
  assert.ok(back, 'and it must come back');
  assert.equal(back.n, g.n, 'with every sample intact');
  assert.ok(Math.abs(back.pv[10] - g.pv[10]) < 1e-9, 'and the right values in them');
  assert.equal(loadGhost(store, 'ghost:best:nothing'), null, 'a key nobody wrote reads as null');
});

test('a storage that throws leaves a refusal an operator could read, not an exception', () => {
  const g = ghostOf({ seconds: 10, at: () => ({ pv: 4, sp: 4, co: 50 }) });
  const full = {
    /** @returns {string|null} nothing is ever there */
    getItem: () => { throw new Error('SecurityError'); },
    /** @returns {void} always refuses, as a full quota does */
    setItem: () => { const e = new Error('quota exceeded'); e.name = 'QuotaExceededError'; throw e; },
  };
  const res = saveGhost(full, 'k', g);
  assert.equal(res.ok, false, 'a quota error must be reported, not swallowed');
  assert.ok(typeof res.reason === 'string' && res.reason.length > 10,
    'and the reason must be a sentence, not a code');
  assert.equal(loadGhost(full, 'k'), null, 'a storage that throws on read must read as absent');

  assert.equal(saveGhost(null, 'k', g).ok, false, 'no storage at all is a refusal, not a throw');
  assert.equal(loadGhost(null, 'k'), null, 'and reads nothing');
  assert.equal(saveGhost({ setItem: () => {} }, '', g).ok, false, 'an empty key is a refusal');
  assert.equal(saveGhost(memStore(), 'k', null).ok, false, 'and so is a missing ghost');
});

test('a half-written storage entry loads as null rather than as a short ghost', () => {
  const store = memStore();
  const g = ghostOf({ seconds: 60, at: (t) => ({ pv: 4 + Math.sin(t), sp: 4, co: 50 }) });
  saveGhost(store, 'k', g);
  const whole = store.getItem('k');
  store._map.set('k', whole.slice(0, whole.length - 40));
  assert.equal(loadGhost(store, 'k'), null,
    'the entry a closed tab leaves behind must not come back as a ghost of the wrong length');
});
