/**
 * src/game/rng.js — the seeded randomness the game layer plays from, and the share code that
 * carries a seed between machines.
 *
 * Layer L4 (game): imports NOTHING. No DOM, no `Date.now`, no `Math.random`. Every module above
 * this one draws its randomness from here, which is what lets a run be reproduced from eight
 * characters an operator can read down a phone line.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A SECOND RNG, WHEN `core/util.js` ALREADY HAS ONE
 *
 * `core/util.js` owns the PLANT's randomness: named xorshift32 streams, one per stochastic
 * effect, deliberately kept apart so that switching off transmitter noise does not shift the
 * sequence the demand walk sees. Those streams belong to the physics and they advance on a scan
 * clock the game does not control.
 *
 * The game needs something different: a generator it can hold in a closure, hand to a mission
 * builder, and rewind by rebuilding it from a number. If it drew from the plant's streams, the
 * upset script would change whenever the physics changed how often it sampled noise — a mission
 * would stop being the same mission after an unrelated edit to the pump model. So the two are
 * separate on purpose, and neither one is allowed to touch the other's state.
 *
 * mulberry32 is the generator because it is nine lines, has a full 2^32 period, passes gjrand's
 * small-crush suite, needs no seeding ritual (a seed of 0 is as good as any other, since the
 * increment is applied before the mix), and is in the public domain. FNV-1a is the string hash
 * for the same reasons: short, byte-wise, well-distributed at 32 bits, no licence attached.
 * Neither is cryptographic and neither is pretending to be — the threat model here is "does the
 * daily challenge feel random", not "can it be predicted".
 *
 * WHY THE HELPERS ALWAYS DRAW EXACTLY ONE NUMBER
 *
 * Every helper below consumes a fixed, documented number of raw draws no matter what arguments
 * it is given. A helper that skipped its draw on a degenerate range — an empty array, a
 * zero-width band, a NaN bound — would leave the stream one step out of position, and every
 * later event in the run would shift. That failure is invisible in a unit test and fatal to a
 * share code, so the rule is: validate the ARGUMENTS, never the DRAW.
 *
 * WHY THERE IS NO `{ok:false, reason}` HERE
 *
 * The house refusal pattern needs a result object to carry the reason. These functions return
 * bare values on hot paths, so instead they follow `clamp`'s precedent from `core/util.js`: a
 * poisoned input degrades to a defined, finite fallback rather than escaping as NaN. The one
 * function that genuinely has to say no — `parseSeedCode`, which is fed whatever a human typed —
 * returns `null`, and the caller turns that into an operator-readable sentence.
 * ------------------------------------------------------------------------------------------
 */

/** FNV-1a 32-bit offset basis, from the reference implementation. */
const FNV_OFFSET = 0x811c9dc5;

/** FNV-1a 32-bit prime, 2^24 + 2^8 + 0x93, from the reference implementation. */
const FNV_PRIME = 0x01000193;

/** mulberry32's increment: 2^32 divided by the golden ratio, the usual Weyl step. */
const MULBERRY_INC = 0x6d2b79f5;

/**
 * The seed used when the caller supplies something that is not a seed at all.
 *
 * Deliberately NOT zero. `NaN >>> 0` is 0, so an undefined or NaN seed folded through the usual
 * coercion would silently alias the perfectly legitimate seed-0 run, and two different bugs would
 * produce the same trend. 0x9E3779B9 is the golden-ratio constant `core/util.js` already uses for
 * the same purpose, so a fallback stream is recognisable in both layers.
 */
const FALLBACK_SEED = 0x9e3779b9;

/**
 * Crockford base32. The point of the alphabet is the four glyphs it leaves OUT — I, L, O and U.
 * A share code gets read aloud, written on a whiteboard and typed back in by someone else, and
 * 0/O and 1/I/L are where that goes wrong. U is excluded by Crockford so that a code cannot
 * accidentally spell an obscenity.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** How many base32 glyphs a share code carries, before the grouping dash. */
const CODE_LEN = 8;

/** Glyphs per group; a code is printed as two groups so the eye can hold it. */
const GROUP = 4;

/** 2^32, the divisor that maps a uint32 onto [0, 1). */
const TWO32 = 4294967296;

/**
 * Reverse lookup for {@link ALPHABET}, including the ambiguous glyphs Crockford says to accept on
 * input: O reads as zero, I and L read as one. Built once at load.
 */
const GLYPH_VALUE = (() => {
  const m = new Map();
  for (let i = 0; i < ALPHABET.length; i += 1) m.set(ALPHABET[i], i);
  m.set('O', 0);
  m.set('I', 1);
  m.set('L', 1);
  return m;
})();

/**
 * Hash a string to a uint32 by FNV-1a.
 *
 * Each UTF-16 code unit is hashed as two bytes, low then high, unconditionally. Hashing only the
 * low byte of an ASCII character would be faster and is what most one-line FNV cribs do, but it
 * makes every non-Latin title collide in blocks, and mission and badge ids are hashed through
 * here. A uniform two-byte rule costs nothing measurable and has no such hole.
 *
 * Stability is the whole contract: this value ends up inside a share code, so it must be the same
 * number on every machine and in every future version. Do not "improve" the mixing.
 *
 * @param {string} str the string to hash; anything else is coerced, and null/undefined hash as ''
 * @returns {number} a uint32 in [0, 2^32)
 */
export function hashSeed(str) {
  const s = (str === null || str === undefined) ? '' : String(str);
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((c >>> 8) & 0xff), FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * Coerce whatever the caller called a seed into a uint32.
 *
 * Strings are hashed rather than rejected, because `makeRng('2026-09-07')` is the natural mistake
 * and quietly producing the seed-0 stream from it would be worse than either hashing or throwing.
 *
 * @param {number|string} seed a number, or a string to hash
 * @returns {number} a uint32 seed, never NaN
 */
function toSeed(seed) {
  if (typeof seed === 'string') return hashSeed(seed);
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) >>> 0;
  return FALLBACK_SEED;
}

/**
 * Build a seeded generator.
 *
 * The returned closure is the only handle on the state — there is no way to reach in and set it,
 * which is intentional: a run is defined by its seed and the number of draws taken since, and an
 * external write would make that untrue.
 *
 * @param {number|string} seed any uint32; a string is hashed, and a non-finite value falls back
 *   to {@link FALLBACK_SEED} rather than aliasing seed 0
 * @returns {() => number} a function returning the next sample in [0, 1)
 */
export function makeRng(seed) {
  let a = toSeed(seed);
  return function next() {
    a = (a + MULBERRY_INC) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO32;
  };
}

/**
 * Take one raw draw from something that claims to be a generator.
 *
 * A caller who passes a non-function, or a generator that has been wrapped and now returns
 * rubbish, gets 0 rather than NaN spreading through a mission script.
 *
 * @param {() => number} rng the generator
 * @returns {number} a sample in [0, 1)
 */
function draw(rng) {
  if (typeof rng !== 'function') return 0;
  const r = rng();
  if (!Number.isFinite(r)) return 0;
  if (r < 0) return 0;
  if (r >= 1) return 0.9999999999;
  return r;
}

/**
 * Coerce a bound to a finite number.
 *
 * Follows `clamp` in `core/util.js`: a poisoned intermediate becomes a defined value here rather
 * than escaping into a mission table as NaN, where it would silently disable every comparison it
 * later touched.
 *
 * @param {number} x the bound
 * @returns {number} `x` if finite, else 0
 */
function finite(x) {
  return Number.isFinite(x) ? x : 0;
}

/**
 * A uniform sample from a closed-open interval. Draws exactly one number.
 *
 * The bounds are sorted, so `rngRange(rng, 7, 2)` is the same interval as `rngRange(rng, 2, 7)`
 * instead of a silently empty one.
 *
 * @param {() => number} rng the generator
 * @param {number} lo one end of the interval
 * @param {number} hi the other end
 * @returns {number} a finite sample between the two bounds inclusive of the lower one
 */
export function rngRange(rng, lo, hi) {
  const r = draw(rng);
  const a = finite(lo);
  const b = finite(hi);
  const min = a < b ? a : b;
  const max = a < b ? b : a;
  return min + r * (max - min);
}

/**
 * A uniform integer in an inclusive range. Draws exactly one number.
 *
 * The window is narrowed to the integers actually inside the bounds — `ceil(lo)` to `floor(hi)` —
 * so the result can never sit outside the range the caller asked for. A range containing no
 * integer at all (1.2 to 1.8) is ill-posed; the nearest integer to `lo` is returned rather than
 * throwing, because a mission table is not worth crashing a shift over.
 *
 * @param {() => number} rng the generator
 * @param {number} lo one end of the range
 * @param {number} hi the other end
 * @returns {number} an integer in [lo, hi]
 */
export function rngInt(rng, lo, hi) {
  const r = draw(rng);
  const a = finite(lo);
  const b = finite(hi);
  const min = Math.ceil(a < b ? a : b);
  const max = Math.floor(a < b ? b : a);
  if (min > max) return Math.round(a < b ? a : b);
  const n = min + Math.floor(r * (max - min + 1));
  // The floor above can land on max + 1 only through floating-point slop at r just below 1, but
  // "only through slop" is how out-of-range indices reach an array. Clamp it and be done.
  return n > max ? max : n;
}

/**
 * Pick one element of an array. Draws exactly one number.
 *
 * @param {() => number} rng the generator
 * @param {*[]} array the candidates
 * @returns {*} an element, or `undefined` when there is nothing to pick from
 */
export function rngPick(rng, array) {
  const r = draw(rng);
  if (!Array.isArray(array) || array.length === 0) return undefined;
  const i = Math.floor(r * array.length);
  return array[i >= array.length ? array.length - 1 : i];
}

/**
 * A shuffled copy, by Fisher-Yates from the top down. Draws exactly `length - 1` numbers.
 *
 * The input is copied, never shuffled in place: the caller is usually holding a frozen constant
 * table — the fault list, a mission's upset pool — and shuffling that in place would corrupt
 * every later run in the same session.
 *
 * @param {() => number} rng the generator
 * @param {*[]} array the array to shuffle
 * @returns {*[]} a new array holding the same elements in a new order
 */
export function rngShuffle(rng, array) {
  if (!Array.isArray(array)) return [];
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const r = draw(rng);
    let j = Math.floor(r * (i + 1));
    if (j > i) j = i;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * A normal sample, by the basic Box-Muller transform. Draws exactly two numbers, always.
 *
 * The second variate that Box-Muller produces for free is discarded rather than cached. Caching
 * it would halve the draws, and would also make the number of draws depend on how many times the
 * function had been called before — which is precisely the thing that makes a seeded run stop
 * reproducing when unrelated code changes its call pattern.
 *
 * `1 - r` rather than `r` for the logarithm's argument, because the generator's range is [0, 1)
 * and `log(0)` is -Infinity; the shifted argument is in (0, 1] and `log(1)` is a harmless zero.
 *
 * @param {() => number} rng the generator
 * @param {number} mean the distribution mean
 * @param {number} sd the standard deviation; a negative value is taken as its magnitude
 * @returns {number} a finite sample from N(mean, sd^2)
 */
export function rngNormal(rng, mean, sd) {
  const u1 = 1 - draw(rng);
  const u2 = draw(rng);
  const m = finite(mean);
  const s = Math.abs(finite(sd));
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return m + s * z;
}

/**
 * The 8-bit check byte carried inside a share code.
 *
 * A share code is read out loud and typed back in, and 32 bits of seed leave 8 bits spare in the
 * eight glyphs the format uses. Spending them on a checksum means a mistyped glyph is refused at
 * the door instead of loading a DIFFERENT valid rig — which is the failure that would otherwise
 * have two players comparing scores on two different plants and blaming the scoring engine.
 *
 * One wrong glyph slips through with probability 1/256; that is the price of a code short enough
 * to say aloud, and it is a wrong-rig risk, not a crash.
 *
 * @param {number} seed a uint32 seed
 * @returns {number} a byte in [0, 256)
 */
function checkByte(seed) {
  return hashSeed(String(seed >>> 0)) & 0xff;
}

/**
 * Render a seed as a share code: eight Crockford glyphs in two groups of four.
 *
 * @param {number|string} seed the seed to encode; coerced the same way {@link makeRng} coerces it
 * @returns {string} a code of the form 'ABCD-EFGH'
 */
export function seedCode(seed) {
  const s = toSeed(seed);
  // 40 bits: the seed in the high 32, the check byte in the low 8. Well inside the 53 bits a
  // double holds exactly, so this arithmetic is not lossy despite looking like it might be.
  let rest = s * 256 + checkByte(s);
  const sym = new Array(CODE_LEN);
  for (let i = CODE_LEN - 1; i >= 0; i -= 1) {
    sym[i] = ALPHABET[rest % 32];
    rest = Math.floor(rest / 32);
  }
  return `${sym.slice(0, GROUP).join('')}-${sym.slice(GROUP).join('')}`;
}

/**
 * Read a share code back into a seed.
 *
 * Forgiving about everything a human does to a code — lower case, missing or extra dashes,
 * surrounding spaces, O typed for zero, I or L typed for one — and unforgiving about anything
 * that would produce the wrong rig: a bad length, a glyph outside the alphabet, or a check byte
 * that does not match.
 *
 * @param {string} code the code as typed
 * @returns {number|null} the uint32 seed, or null if the code is not one this build produced
 */
export function parseSeedCode(code) {
  if (typeof code !== 'string') return null;
  const clean = code.toUpperCase().replace(/[\s-]+/g, '');
  if (clean.length !== CODE_LEN) return null;
  let v = 0;
  for (let i = 0; i < CODE_LEN; i += 1) {
    const d = GLYPH_VALUE.get(clean[i]);
    if (d === undefined) return null;
    v = v * 32 + d;
  }
  const seed = Math.floor(v / 256) >>> 0;
  if (v % 256 !== checkByte(seed)) return null;
  return seed;
}

/**
 * The seed for a calendar day's challenge.
 *
 * Namespaced before hashing so that a date can never collide with some other string hashed
 * through {@link hashSeed} — a mission id, a badge id — which would tie two unrelated things to
 * the same stream and make one of them change whenever the other was renamed.
 *
 * The date is supplied by the caller, never read from a clock here: nothing in `src/game` is
 * allowed to call `Date.now`, because a test has to be able to play any day it likes.
 *
 * @param {string} dateStr the day, 'YYYY-MM-DD'
 * @returns {number} a uint32 seed, stable for that date forever
 */
export function dailySeed(dateStr) {
  const s = (dateStr === null || dateStr === undefined) ? '' : String(dateStr).trim();
  return hashSeed(`daily:${s}`);
}
