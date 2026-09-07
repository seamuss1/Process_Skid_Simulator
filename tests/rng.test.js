/**
 * tests/rng.test.js — the reproducibility floor.
 *
 * Everything else in the game layer is allowed to be approximately right. This file is not: if a
 * seed stops producing the same stream, or a share code stops round-tripping, then two players
 * comparing a daily score are comparing two different plants and nothing above this file can
 * detect it. So the claims here are about PROPERTIES that must hold forever — determinism,
 * bounds, round-trip, refusal of a mistyped code — and not about the particular numbers mulberry32
 * happens to emit, which are an implementation detail nobody should be pinning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashSeed, makeRng, rngRange, rngInt, rngPick, rngShuffle, rngNormal,
  seedCode, parseSeedCode, dailySeed,
} from '../src/game/rng.js';

/** The Crockford glyphs a share code is allowed to contain. */
const GLYPHS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Take a run of raw draws from a fresh generator.
 * @param {number|string} seed the seed
 * @param {number} n how many draws
 * @returns {number[]} the samples
 */
function stream(seed, n) {
  const rng = makeRng(seed);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = rng();
  return out;
}

/**
 * Assert a value is a uint32 — an integer in [0, 2^32).
 * @param {number} x the value
 * @param {string} what what it was supposed to be, for the failure message
 * @returns {void}
 */
function assertU32(x, what) {
  assert.equal(typeof x, 'number', `${what} must be a number`);
  assert.ok(Number.isInteger(x), `${what} must be a whole number, got ${x}`);
  assert.ok(x >= 0 && x < 4294967296, `${what} must fit in 32 unsigned bits, got ${x}`);
}

// --------------------------------------------------------------------------------------------
// hashSeed
// --------------------------------------------------------------------------------------------

test('the string hash is stable, unsigned, and sensitive to the order of characters', () => {
  assertU32(hashSeed('mission-tier-3'), 'a hash');
  assert.equal(hashSeed('mission-tier-3'), hashSeed('mission-tier-3'),
    'a hash that is not a pure function of its input cannot seed a reproducible run');
  assert.notEqual(hashSeed('abc'), hashSeed('acb'),
    'FNV-1a must see order — an order-blind hash would give two different missions one stream');
  assert.notEqual(hashSeed('demand-surge'), hashSeed('demand-collapse'),
    'ids that differ must hash apart, or two upsets would share a random sequence');
});

test('the string hash accepts an empty string and non-string input without throwing', () => {
  assertU32(hashSeed(''), 'the hash of an empty string');
  assertU32(hashSeed(null), 'the hash of null');
  assertU32(hashSeed(undefined), 'the hash of undefined');
  assertU32(hashSeed(42), 'the hash of a number');
  assert.equal(hashSeed(null), hashSeed(''),
    'null is documented to hash as the empty string; changing that would move every default seed');
});

test('the string hash spreads a family of similar ids across the whole 32-bit range', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(hashSeed(`mission-${i}`));
  assert.equal(seen.size, 2000,
    'a collision among 2000 sequential ids would mean the hash is barely mixing the low bits');
});

// --------------------------------------------------------------------------------------------
// makeRng
// --------------------------------------------------------------------------------------------

test('the same seed always produces the same stream', () => {
  assert.deepEqual(stream(1234, 500), stream(1234, 500),
    'this is the entire promise of a share code: same seed, same run, on any machine');
});

test('two seeds one apart produce streams that diverge from the very first draw', () => {
  const a = stream(1, 64);
  const b = stream(2, 64);
  let same = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) same += 1;
  assert.equal(same, 0,
    'adjacent seeds must not share draws, or consecutive daily challenges would replay each other');
});

test('a seed of zero produces a live stream rather than a stuck one', () => {
  const s = stream(0, 500);
  const distinct = new Set(s).size;
  assert.ok(distinct > 490,
    `seed 0 must mix like any other seed; only ${distinct} distinct values in 500 draws`);
  assert.notDeepEqual(s, stream(1, 500), 'seed 0 must not be an alias for seed 1');
});

test('every draw lies in the half-open unit interval', () => {
  const rng = makeRng(0xdecafbad);
  for (let i = 0; i < 20000; i += 1) {
    const r = rng();
    assert.ok(r >= 0 && r < 1,
      `a draw escaped [0,1) at index ${i} with ${r}; every helper below assumes it cannot`);
  }
});

test('a non-finite seed falls back to a fixed stream instead of aliasing the seed-zero run', () => {
  assert.notDeepEqual(stream(NaN, 32), stream(0, 32),
    'NaN >>> 0 is 0, so a careless coercion would make a bug indistinguishable from seed 0');
  assert.deepEqual(stream(NaN, 32), stream(undefined, 32),
    'every unusable seed must land on the same documented fallback, not on scattered ones');
  assert.deepEqual(stream(Infinity, 32), stream(undefined, 32),
    'an infinite seed is as unusable as a missing one');
  for (const r of stream(NaN, 32)) {
    assert.ok(Number.isFinite(r), 'a bad seed must never leak NaN into the stream');
  }
});

test('a string seed is hashed rather than folded to zero', () => {
  assert.deepEqual(stream('2026-09-07', 32), stream(hashSeed('2026-09-07'), 32),
    'makeRng(someString) is the natural mistake; it must mean what the caller obviously meant');
  assert.notDeepEqual(stream('alpha', 32), stream('beta', 32),
    'two different string seeds must give two different runs');
});

test('a negative or oversized seed is folded into range instead of producing NaN', () => {
  for (const seed of [-1, -999999, 2 ** 33, 4294967295, 2.9]) {
    const s = stream(seed, 16);
    for (const r of s) {
      assert.ok(r >= 0 && r < 1, `seed ${seed} produced a draw outside [0,1): ${r}`);
    }
  }
  assert.deepEqual(stream(-1, 16), stream(4294967295, 16),
    '-1 and 0xFFFFFFFF are the same 32 bits and must therefore be the same run');
});

// --------------------------------------------------------------------------------------------
// range helpers
// --------------------------------------------------------------------------------------------

test('rngRange never escapes its bounds, in either argument order', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 5000; i += 1) {
    const x = rngRange(rng, 2, 7);
    assert.ok(x >= 2 && x < 7.0000001, `rngRange escaped [2,7] with ${x}`);
    const y = rngRange(rng, 7, 2);
    assert.ok(y >= 2 && y < 7.0000001,
      `reversed bounds must describe the same interval, not an empty one; got ${y}`);
  }
});

test('rngRange over a zero-width band returns that value exactly', () => {
  const rng = makeRng(11);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(rngRange(rng, 3.5, 3.5), 3.5,
      'a band with no width is a legitimate mission setting and must not drift off it');
  }
});

test('rngRange with a non-finite bound returns a finite number rather than poisoning a mission', () => {
  const rng = makeRng(3);
  for (const [lo, hi] of [[NaN, 5], [0, NaN], [NaN, NaN], [Infinity, 1], [undefined, 4]]) {
    const x = rngRange(rng, lo, hi);
    assert.ok(Number.isFinite(x),
      `rngRange(${String(lo)}, ${String(hi)}) returned ${x}; a NaN here disables every later comparison`);
  }
});

test('rngInt covers both endpoints and never returns anything between or beyond them', () => {
  const rng = makeRng(99);
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const n = rngInt(rng, 0, 3);
    assert.ok(Number.isInteger(n), `rngInt returned a non-integer: ${n}`);
    assert.ok(n >= 0 && n <= 3, `rngInt escaped its inclusive range with ${n}`);
    seen.add(n);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3],
    'an inclusive range that never yields its top value is an off-by-one waiting to be shipped');
});

test('rngInt handles a single-value range, negative bounds and reversed bounds', () => {
  const rng = makeRng(5);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(rngInt(rng, 5, 5), 5, 'a one-value range must return that value, not 5 or 6');
    const n = rngInt(rng, -2, 2);
    assert.ok(n >= -2 && n <= 2, `negative bounds escaped with ${n}`);
    const m = rngInt(rng, 9, 4);
    assert.ok(m >= 4 && m <= 9, `reversed bounds escaped with ${m}`);
  }
});

test('rngInt refuses to throw on a range that contains no integer at all', () => {
  const rng = makeRng(1);
  const n = rngInt(rng, 1.2, 1.8);
  assert.ok(Number.isInteger(n),
    'an ill-posed range is a caller bug, but crashing a shift over it is a worse one');
});

test('a helper draws the same number of samples whatever nonsense it is handed', () => {
  // The failure this prevents is invisible and total: a helper that skips its draw on a
  // degenerate argument leaves the stream one step out of position, and every upset after it
  // lands at the wrong time — on one machine and not the other.
  const control = makeRng(4242);
  for (let i = 0; i < 6; i += 1) control();
  const expected = control();

  const rng = makeRng(4242);
  rngRange(rng, NaN, NaN);
  rngRange(rng, 5, 5);
  rngInt(rng, 3, 3);
  rngInt(rng, NaN, 2);
  rngPick(rng, []);
  rngPick(rng, null);
  assert.equal(rng(), expected,
    'six helper calls must consume exactly six draws, degenerate arguments included');
});

// --------------------------------------------------------------------------------------------
// pick and shuffle
// --------------------------------------------------------------------------------------------

test('rngPick returns an element of the array and eventually returns every one of them', () => {
  const rng = makeRng(31);
  const pool = ['drift', 'spike', 'freeze', 'stiction'];
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const x = rngPick(rng, pool);
    assert.ok(pool.includes(x), `rngPick invented an element: ${String(x)}`);
    seen.add(x);
  }
  assert.equal(seen.size, pool.length,
    'a pick that can never reach the last element would quietly retire a fault from the game');
});

test('rngPick on an empty or missing array returns undefined instead of throwing', () => {
  const rng = makeRng(8);
  assert.equal(rngPick(rng, []), undefined, 'an empty pool is a real state during mission setup');
  assert.equal(rngPick(rng, null), undefined, 'a missing pool must refuse, not crash');
  assert.equal(rngPick(rng, 'abcd'), undefined, 'a string is not an array and must not be treated as one');
});

test('a shuffle is a permutation of the input and leaves the original untouched', () => {
  const rng = makeRng(77);
  const source = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
  for (let i = 0; i < 200; i += 1) {
    const out = rngShuffle(rng, source);
    assert.equal(out.length, source.length, 'a shuffle must not lose or duplicate elements');
    assert.deepEqual([...out].sort((a, b) => a - b), [...source],
      'the shuffled array must hold exactly the same elements');
    assert.deepEqual(source, [1, 2, 3, 4, 5, 6, 7, 8],
      'the caller is usually holding a frozen constant table; shuffling it in place would corrupt it');
  }
});

test('a shuffle actually reorders rather than handing back the input order', () => {
  const rng = makeRng(1010);
  const source = [1, 2, 3, 4, 5, 6, 7, 8];
  let moved = 0;
  for (let i = 0; i < 100; i += 1) {
    if (rngShuffle(rng, source).some((v, k) => v !== source[k])) moved += 1;
  }
  assert.ok(moved > 90,
    `only ${moved} of 100 shuffles changed the order; a shuffle that mostly does nothing is not one`);
});

test('a shuffle of zero or one element is the identity and does not throw', () => {
  const rng = makeRng(2);
  assert.deepEqual(rngShuffle(rng, []), [], 'an empty pool is reached whenever every fault is used up');
  assert.deepEqual(rngShuffle(rng, ['only']), ['only'], 'one element has exactly one order');
  assert.deepEqual(rngShuffle(rng, null), [], 'a missing array must refuse with an empty result');
  assert.deepEqual(rngShuffle(rng, undefined), [], 'so must a missing argument');
});

test('the same seed shuffles the same way', () => {
  const source = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(rngShuffle(makeRng(555), source), rngShuffle(makeRng(555), source),
    'fault-hunt decoys are shuffled from the run seed; two players must see the same list');
});

// --------------------------------------------------------------------------------------------
// rngNormal
// --------------------------------------------------------------------------------------------

test('rngNormal has roughly the mean and standard deviation it was asked for over 20000 draws', () => {
  const rng = makeRng(0xc0ffee);
  const n = 20000;
  const mean = 5;
  const sd = 2;
  let sum = 0;
  let sumsq = 0;
  for (let i = 0; i < n; i += 1) {
    const x = rngNormal(rng, mean, sd);
    assert.ok(Number.isFinite(x), `rngNormal produced ${x}, which would poison a plant parameter`);
    sum += x;
    sumsq += x * x;
  }
  const m = sum / n;
  const s = Math.sqrt(sumsq / n - m * m);
  // The standard error of the mean here is sd/sqrt(n) = 0.0141, so 0.08 is a shade under six of
  // them: wide enough that no correct generator trips it, tight enough to catch a lost factor.
  assert.ok(Math.abs(m - mean) < 0.08, `sample mean ${m.toFixed(4)} is not ${mean}`);
  assert.ok(Math.abs(s - sd) < 0.06, `sample sd ${s.toFixed(4)} is not ${sd}`);
});

test('rngNormal produces both tails and does not collapse onto its mean', () => {
  const rng = makeRng(17);
  let below = 0;
  let above = 0;
  let far = 0;
  for (let i = 0; i < 5000; i += 1) {
    const x = rngNormal(rng, 0, 1);
    if (x < 0) below += 1;
    if (x > 0) above += 1;
    if (Math.abs(x) > 2) far += 1;
  }
  assert.ok(below > 2200 && above > 2200,
    `the distribution must be symmetric about the mean; got ${below} below and ${above} above`);
  assert.ok(far > 100 && far < 400,
    `about 4.6% of draws should exceed two sigma; got ${far} in 5000, which is the wrong shape`);
});

test('rngNormal with a zero standard deviation returns the mean exactly', () => {
  const rng = makeRng(6);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(rngNormal(rng, 12.5, 0), 12.5,
      'a mission that asks for no scatter must get none, not a value that is merely close');
  }
});

test('rngNormal survives the extremes of the generator without returning NaN or Infinity', () => {
  // The log in Box-Muller is the trap: a generator pinned at either end of [0,1) must not be able
  // to produce log(0). These fake generators are the only way to reach that corner on purpose.
  assert.ok(Number.isFinite(rngNormal(() => 0, 0, 1)), 'a generator stuck at 0 must not yield NaN');
  assert.ok(Number.isFinite(rngNormal(() => 0.9999999999, 0, 1)),
    'a generator pinned just below 1 must not yield an infinite sample');
  assert.ok(Number.isFinite(rngNormal(() => NaN, 0, 1)),
    'a broken generator must degrade, not spread NaN through the plant');
  assert.ok(Number.isFinite(rngNormal(null, 0, 1)), 'a missing generator must not throw');
  assert.ok(Number.isFinite(rngNormal(makeRng(1), NaN, NaN)), 'non-finite parameters must degrade');
});

test('rngNormal draws exactly two samples per call, whatever it is asked for', () => {
  const control = makeRng(313);
  for (let i = 0; i < 6; i += 1) control();
  const expected = control();

  const rng = makeRng(313);
  rngNormal(rng, 0, 1);
  rngNormal(rng, 100, 0);
  rngNormal(rng, NaN, NaN);
  assert.equal(rng(), expected,
    'caching the spare Box-Muller variate would halve the draws and desync every seeded run');
});

// --------------------------------------------------------------------------------------------
// share codes
// --------------------------------------------------------------------------------------------

test('a share code is eight Crockford glyphs in two groups and contains no ambiguous letter', () => {
  const rng = makeRng(24);
  for (let i = 0; i < 500; i += 1) {
    const code = seedCode(rngInt(rng, 0, 4294967295));
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      `${code} is not a well-formed share code`);
    assert.ok(!/[ILOU]/.test(code),
      `${code} contains a glyph an operator would misread down a phone line`);
  }
});

test('every seed round-trips through its share code', () => {
  const corners = [0, 1, 2, 255, 256, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
  for (const seed of corners) {
    const code = seedCode(seed);
    assert.equal(parseSeedCode(code), seed,
      `seed ${seed} encoded to ${code} and did not come back; the corners are where this breaks`);
  }
  const rng = makeRng(0xabcdef);
  for (let i = 0; i < 1000; i += 1) {
    const seed = rngInt(rng, 0, 4294967295);
    assert.equal(parseSeedCode(seedCode(seed)), seed, `seed ${seed} failed to round-trip`);
  }
});

test('a share code parses back regardless of case, spacing or dashes', () => {
  const seed = 0x1234abcd;
  const code = seedCode(seed);
  const bare = code.replace('-', '');
  for (const variant of [
    code,
    code.toLowerCase(),
    bare,
    bare.toLowerCase(),
    `  ${code}  `,
    `${bare.slice(0, 2)}-${bare.slice(2, 5)}-${bare.slice(5)}`,
    code.replace('-', ' '),
  ]) {
    assert.equal(parseSeedCode(variant), seed,
      `"${variant}" is how a human types a code and must still resolve to the same rig`);
  }
});

test('the glyphs an operator confuses are accepted as their Crockford equivalents', () => {
  // Find real codes containing a 0 and a 1, then type them the way somebody would say them.
  let zeroCode = null;
  let oneCode = null;
  for (let seed = 0; seed < 5000 && (!zeroCode || !oneCode); seed += 1) {
    const code = seedCode(seed);
    if (!zeroCode && code.includes('0')) zeroCode = { seed, code };
    if (!oneCode && code.includes('1')) oneCode = { seed, code };
  }
  assert.ok(zeroCode && oneCode, 'the search itself failed — the alphabet is not what it should be');
  assert.equal(parseSeedCode(zeroCode.code.replace(/0/g, 'O')), zeroCode.seed,
    'O read for zero is the classic phone-line error and must resolve, not fail');
  assert.equal(parseSeedCode(oneCode.code.replace(/1/g, 'I')), oneCode.seed,
    'I read for one must resolve too');
  assert.equal(parseSeedCode(oneCode.code.replace(/1/g, 'l')), oneCode.seed,
    'and so must a lowercase l');
});

test('a malformed share code returns null rather than throwing', () => {
  for (const bad of [
    '', 'ABC', 'ABCD-EFG', 'ABCD-EFGHI', 'ABCD-EFGH-JKMN', 'ABCD-EFG!', 'ABCD EFGU',
    '--------', '________', null, undefined, 12345, {}, [], NaN, 'UUUU-UUUU',
  ]) {
    let out;
    assert.doesNotThrow(() => { out = parseSeedCode(bad); },
      `parseSeedCode(${JSON.stringify(bad)}) threw; this input comes straight from a text box`);
    assert.equal(out, null, `parseSeedCode(${JSON.stringify(bad)}) should refuse, got ${String(out)}`);
  }
});

test('a single mistyped glyph is caught by the check byte instead of loading a different rig', () => {
  const seed = 0x5eed1234;
  const bare = seedCode(seed).replace('-', '');
  let total = 0;
  let rejected = 0;
  for (let i = 0; i < bare.length; i += 1) {
    for (const g of GLYPHS) {
      if (g === bare[i]) continue;
      const mutant = `${bare.slice(0, i)}${g}${bare.slice(i + 1)}`;
      total += 1;
      if (parseSeedCode(mutant) !== seed) {
        // It either refused outright or decoded to some other seed; only refusal is safe.
        if (parseSeedCode(mutant) === null) rejected += 1;
      }
    }
  }
  // Eight spare bits means about one mutant in 256 slips through with a valid-looking checksum.
  // The claim is that the overwhelming majority do not, which is what stops two players silently
  // playing different plants.
  assert.ok(rejected / total > 0.9,
    `only ${rejected} of ${total} single-glyph typos were refused; the check byte is not working`);
});

test('a share code depends on the whole seed, not just part of it', () => {
  const seen = new Set();
  for (let seed = 0; seed < 3000; seed += 1) seen.add(seedCode(seed));
  assert.equal(seen.size, 3000,
    'two seeds sharing a code would make a share link ambiguous, which is unrecoverable');
});

test('seedCode coerces a bad seed the same way makeRng does', () => {
  assert.equal(seedCode(NaN), seedCode(undefined),
    'a code and the run it names must agree on what an unusable seed falls back to');
  assert.equal(parseSeedCode(seedCode('2026-09-07')), hashSeed('2026-09-07'),
    'a string seed must encode as the seed it actually plays');
  assert.equal(parseSeedCode(seedCode(-1)), 4294967295, 'a negative seed folds into 32 bits');
});

// --------------------------------------------------------------------------------------------
// dailySeed
// --------------------------------------------------------------------------------------------

test('the daily seed depends only on the date and differs from one day to the next', () => {
  const a = dailySeed('2026-09-07');
  assertU32(a, 'a daily seed');
  assert.equal(a, dailySeed('2026-09-07'),
    'the daily challenge must be the same rig for everyone who plays it that day');
  const days = ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2027-09-07'];
  assert.equal(new Set(days.map(dailySeed)).size, days.length,
    'consecutive days must not replay each other');
});

test('the daily seed is namespaced so a date cannot collide with any other hashed id', () => {
  assert.notEqual(dailySeed('2026-09-07'), hashSeed('2026-09-07'),
    'without a namespace a mission id that happened to be a date would share the daily stream');
});

test('the daily seed tolerates surrounding whitespace and refuses to throw on nonsense', () => {
  assert.equal(dailySeed('  2026-09-07 '), dailySeed('2026-09-07'),
    'a date arriving with whitespace must not silently become a different day');
  for (const bad of [null, undefined, '', 'not-a-date', 20260907, {}]) {
    let out;
    assert.doesNotThrow(() => { out = dailySeed(bad); },
      `dailySeed(${JSON.stringify(bad)}) threw; the daily must never be the thing that kills a boot`);
    assertU32(out, `the daily seed for ${JSON.stringify(bad)}`);
  }
});

test('a daily challenge is reproducible end to end from its share code', () => {
  const seed = dailySeed('2026-09-07');
  const code = seedCode(seed);
  const parsed = parseSeedCode(code);
  assert.equal(parsed, seed, 'the code must name the day it came from');
  assert.deepEqual(stream(parsed, 200), stream(seed, 200),
    'this is the whole feature: a code on a whiteboard rebuilds the run exactly');
});
