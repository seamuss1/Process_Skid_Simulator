/**
 * src/game/replay.js — the ghost: a recording of one run's PV, setpoint and output, small enough
 * to keep a dozen of them in localStorage, so a player can race the best shift they ever ran.
 *
 * Layer L3 (game): imports nothing at all. No DOM, no `performance`, no `Date`, no `Math.random`.
 * Time arrives as an argument and storage arrives as an argument, because every function here is
 * unit-tested in Node and the browser's storage is allowed to be absent, full, or lying.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A GHOST AND NOT A SCORE
 *
 * A score says you did better. A ghost drawn behind the live trace says WHERE you did better —
 * that the old run wandered for six seconds after the surge and this one came back in two. That
 * is the only feedback on this rig that points at a moment rather than at a total, and pointing
 * at a moment is what makes a player change what they do next time.
 *
 * THE STORAGE BUDGET, AND WHY THE ENCODING IS NOT JSON
 *
 * `JSON.stringify` of three arrays of 600 doubles is roughly 40 kB, and it is 40 kB of digits
 * nobody will ever look at: the trace is drawn a couple of pixels wide and a hundredth of a bar
 * is already below what it can show. A dozen of those crowds a 5 MB origin quota far faster than
 * it looks once the profile, the run library and the daily results are in there too, and the
 * failure mode when it does fill is the ugly one — `setItem` throws, and the thing that gets lost
 * is whatever was being written at the time, which is usually the profile.
 *
 * So each channel is quantised to a step the trend cannot draw past ({@link EU_STEP},
 * {@link CO_STEP}), delta-encoded down the time axis, and written as zig-zag varints in a
 * 64-glyph alphabet — one character per sample for a well-behaved loop, two when it is moving.
 * A 300 s ghost at the default period lands near 2 kB against the 8 kB
 * {@link GHOST_BUDGET_BYTES} allows, which is a fifth of the JSON and leaves the dozen ghosts the
 * game keeps costing under 4% of the quota.
 *
 * TRUNCATION IS NOT A HYPOTHETICAL
 *
 * A tab closed mid-write leaves a half-written localStorage entry, and a ghost is the longest
 * string this application writes, so it is the one that gets caught. Every encoded ghost
 * therefore carries a checksum over its own body, and {@link decodeGhost} returns null — never
 * throws, never returns a half-length ghost — when the checksum, the sample count and the
 * payload do not all agree with each other.
 * ------------------------------------------------------------------------------------------
 */

/** Ghost object format version. Bumped when a field's MEANING changes, not when one is added. */
export const GHOST_VERSION = 1;

/** Prefix and version tag on the encoded string. Decoding anything else is a refusal. */
const ENCODING_TAG = 'G1';

/**
 * Quantisation step for PV and setpoint, engineering units.
 *
 * A hundredth of a bar, or a hundredth of a m3/h, is finer than the transmitter resolves and far
 * finer than one pixel of the trend at any zoom the UI offers, so nothing visible is lost. It is
 * also the tie tolerance in {@link compareGhosts}: two runs cannot meaningfully differ by less
 * than the step they were recorded on.
 */
export const EU_STEP = 0.01;

/**
 * Quantisation step for controller output, percent. A faceplate shows output to one decimal and
 * no drive on this rig resolves a command finer than that.
 */
export const CO_STEP = 0.1;

/** Recording period used when the caller asks for one that makes no sense, s. */
export const DEFAULT_PERIOD_S = 0.5;

/** Shortest recording period allowed, s. Below this the ghost costs more than it shows. */
const MIN_PERIOD_S = 0.05;

/** Longest recording period allowed, s. Beyond this the interpolation is a straight line lie. */
const MAX_PERIOD_S = 10;

/**
 * Hard cap on samples in one ghost. At the default period that is a shift of about 66 minutes,
 * which is longer than any mission or endless run this game will ask for; the cap exists so that
 * a caller who passes a wild `t_s` cannot make the gap-fill loop allocate without bound.
 */
export const MAX_SAMPLES = 8000;

/**
 * The per-ghost storage budget, in characters of encoded text.
 *
 * Browsers give an origin about 5 MB of localStorage and charge two bytes per character, so this
 * is 16 kB of quota per ghost and under 200 kB for the dozen the game keeps — under 4% of what is
 * available, which leaves the profile, the run library and the daily records in no danger. The
 * headroom is deliberate: a 300 s ghost of a working loop actually encodes to about 2 kB, and the
 * budget is set at the size a pathological run — one thrashing the output every scan — would
 * reach. {@link saveGhost} refuses anything over it rather than letting one bad run eat the
 * quota, and the tests hold a 300 s recording under it. If a change to the encoding pushes past
 * this line, the encoding is what is wrong, not the budget.
 */
export const GHOST_BUDGET_BYTES = 8192;

/**
 * Payload alphabet: 64 glyphs, all of them safe unescaped inside JSON, a URL and a localStorage
 * value, and none of them the '.' that separates the fields of the encoded string.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Reverse lookup for {@link ALPHABET}; any character absent from it decodes as -1. */
const GLYPH = (() => {
  const m = Object.create(null);
  for (let i = 0; i < ALPHABET.length; i += 1) m[ALPHABET[i]] = i;
  return m;
})();

/**
 * Most characters one varint may occupy. Five bits of payload each, so seven characters cover
 * every quantum count {@link MAX_QUANTA} allows; more than that means the payload is corrupt.
 */
const MAX_VARINT_CHARS = 7;

/** Largest magnitude, in quanta, any sample may encode. 1e9 quanta is 1e7 EU — nonsense already. */
const MAX_QUANTA = 1e9;

/**
 * Slack on the sample-due test, in periods. Accumulated floating point error in the caller's
 * clock must not be able to cost a sample every few hundred scans, which is how a ghost ends up
 * silently shorter than the run it recorded.
 */
const DUE_EPS = 1e-9;

/**
 * Snap a value onto a quantisation grid, carrying a substitute when it is not a number.
 * @param {number} v the raw value
 * @param {number} step the quantisation step
 * @param {number} fallback the value to use when `v` is not finite
 * @returns {number} the snapped value
 */
function snap(v, step, fallback) {
  const x = Number.isFinite(v) ? v : fallback;
  const q = Math.round(x / step);
  if (!Number.isFinite(q)) return 0;
  const clamped = q > MAX_QUANTA ? MAX_QUANTA : (q < -MAX_QUANTA ? -MAX_QUANTA : q);
  return clamped * step;
}

/**
 * Quantum count for a value, as an integer.
 * @param {number} v the value
 * @param {number} step the quantisation step
 * @returns {number} the count of quanta, clamped to {@link MAX_QUANTA}
 */
function quanta(v, step) {
  const q = Math.round((Number.isFinite(v) ? v : 0) / step);
  if (!Number.isFinite(q)) return 0;
  if (q > MAX_QUANTA) return MAX_QUANTA;
  if (q < -MAX_QUANTA) return -MAX_QUANTA;
  return q;
}

/**
 * Zig-zag a signed integer into an unsigned one, so that small negative deltas stay one character
 * long. A straight two's-complement cast would make every negative delta the longest possible.
 * @param {number} n a signed integer
 * @returns {number} the unsigned image
 */
function zigzag(n) {
  return n >= 0 ? n * 2 : (-n * 2) - 1;
}

/**
 * Undo {@link zigzag}.
 * @param {number} u an unsigned integer
 * @returns {number} the signed original
 */
function unzigzag(u) {
  return (u % 2) === 0 ? u / 2 : -((u + 1) / 2);
}

/**
 * Write an unsigned integer as base-32 varint characters, least significant group first, with the
 * top bit of each glyph set while more groups follow.
 *
 * The arithmetic is deliberately `%` and `Math.floor` rather than shifts: a zig-zagged delta can
 * exceed 2^31, and JavaScript's bitwise operators would silently truncate it.
 *
 * @param {number} u the value
 * @returns {string} one to seven glyphs
 */
function writeVarint(u) {
  let x = u;
  let out = '';
  for (;;) {
    const group = x % 32;
    x = Math.floor(x / 32);
    out += ALPHABET[x > 0 ? group + 32 : group];
    if (x === 0) return out;
  }
}

/**
 * Delta-encode a channel.
 * @param {ArrayLike<number>} values the samples
 * @param {number} n how many of them to write
 * @param {number} step the quantisation step
 * @returns {string} the payload
 */
function encodeChannel(values, n, step) {
  let prev = 0;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const q = quanta(values[i], step);
    out += writeVarint(zigzag(q - prev));
    prev = q;
  }
  return out;
}

/**
 * Decode a channel payload back to values.
 * @param {string} text the payload
 * @param {number} n how many samples are expected
 * @param {number} step the quantisation step
 * @returns {number[]|null} the samples, or null if the payload is malformed or the wrong length
 */
function decodeChannel(text, n, step) {
  const out = new Array(n);
  let prev = 0;
  let i = 0;
  for (let k = 0; k < n; k += 1) {
    let value = 0;
    let mult = 1;
    let chars = 0;
    for (;;) {
      if (i >= text.length) return null;
      const g = GLYPH[text[i]];
      i += 1;
      if (g === undefined) return null;
      chars += 1;
      if (chars > MAX_VARINT_CHARS) return null;
      value += (g % 32) * mult;
      if (g < 32) break;
      mult *= 32;
    }
    const q = prev + unzigzag(value);
    if (!Number.isFinite(q) || Math.abs(q) > MAX_QUANTA) return null;
    prev = q;
    out[k] = q * step;
  }
  // Trailing characters mean the string is not the string that was written, whatever the
  // checksum says about the part we read.
  return i === text.length ? out : null;
}

/**
 * FNV-1a over a string, as an unsigned 32-bit integer. Not a security hash — a truncation and
 * bit-rot detector, which is exactly the failure a half-written localStorage entry produces.
 * @param {string} s the text
 * @returns {number} the hash
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Allocate a ghost recorder.
 *
 * A period that is missing or nonsense yields {@link DEFAULT_PERIOD_S} rather than a throw,
 * because the recorder is created on the path that starts a mission and a bad number there must
 * cost the player a slightly coarse ghost, not the shift.
 *
 * @param {number} period_s seconds between recorded samples; rounded to the millisecond, and
 *   clamped to [{@link MIN_PERIOD_S}, {@link MAX_PERIOD_S}]
 * @returns {object} the recorder state
 */
export function createRecorder(period_s) {
  let p = Number.isFinite(period_s) && period_s > 0 ? period_s : DEFAULT_PERIOD_S;
  if (p < MIN_PERIOD_S) p = MIN_PERIOD_S;
  if (p > MAX_PERIOD_S) p = MAX_PERIOD_S;
  // The encoded form carries the period as whole milliseconds, so the recorder has to record on
  // a period that survives that trip — otherwise a decoded ghost's timebase drifts from the one
  // the samples were actually taken on.
  p = Math.round(p * 1000) / 1000;
  return {
    /** Seconds between samples. */
    period_s: p,
    /** Caller time of the first sample, s. The ghost's own timebase starts at zero. */
    t0_s: 0,
    /** Samples taken so far. */
    n: 0,
    /** True once {@link MAX_SAMPLES} is reached and the recorder has stopped taking samples. */
    full: false,
    /** Controlled variable, engineering units, quantised to {@link EU_STEP}. */
    pv: [],
    /** Setpoint, engineering units, quantised to {@link EU_STEP}. */
    sp: [],
    /** Controller output, percent, quantised to {@link CO_STEP}. */
    co: [],
  };
}

/**
 * Append one sample to a recorder, holding the previous values.
 * @param {object} rec the recorder (mutated)
 * @param {number} pv controlled variable
 * @param {number} sp setpoint
 * @param {number} co controller output
 * @returns {void}
 */
function push(rec, pv, sp, co) {
  const i = rec.n;
  const lastPv = i > 0 ? rec.pv[i - 1] : 0;
  const lastSp = i > 0 ? rec.sp[i - 1] : 0;
  const lastCo = i > 0 ? rec.co[i - 1] : 0;
  rec.pv.push(snap(pv, EU_STEP, lastPv));
  rec.sp.push(snap(sp, EU_STEP, lastSp));
  rec.co.push(snap(co, CO_STEP, lastCo));
  rec.n = i + 1;
}

/**
 * Offer a sample to the recorder. Samples arriving faster than the recording period are dropped;
 * gaps longer than one period are filled by holding the last value, so that sample `i` always
 * means time `i * period_s` and {@link ghostAt} never has to carry a time axis of its own.
 *
 * Anything not finite is refused entry: a single NaN written into a ghost turns every later
 * comparison against it into a silent no-op, which is far harder to notice than a flat line.
 *
 * @param {object} rec recorder from {@link createRecorder} (mutated)
 * @param {number} t_s caller time, s — any origin; the first sample defines zero
 * @param {number} pv controlled variable, engineering units
 * @param {number} sp setpoint, engineering units
 * @param {number} co controller output, percent
 * @returns {void}
 */
export function recordSample(rec, t_s, pv, sp, co) {
  if (!rec || rec.full || !Number.isFinite(t_s) || !(rec.period_s > 0)) return;
  if (rec.n === 0) {
    rec.t0_s = t_s;
    push(rec, pv, sp, co);
    return;
  }
  const due = Math.floor((t_s - rec.t0_s) / rec.period_s + DUE_EPS) + 1;
  // A time that has not advanced a whole period — or has gone backwards, which is what a
  // scenario restart looks like from here — is simply not a new sample.
  if (!(due > rec.n)) return;
  const target = due > MAX_SAMPLES ? MAX_SAMPLES : due;
  while (rec.n < target - 1) push(rec, rec.pv[rec.n - 1], rec.sp[rec.n - 1], rec.co[rec.n - 1]);
  if (rec.n < target) push(rec, pv, sp, co);
  if (rec.n >= MAX_SAMPLES) rec.full = true;
}

/**
 * Close a recording and hand back the ghost. The arrays are copied, so a recorder that keeps
 * running cannot mutate a ghost somebody is already drawing.
 * @param {object} rec the recorder
 * @returns {object} ghost `{v, period_s, n, pv, sp, co}`; empty when there was nothing to record
 */
export function finishRecording(rec) {
  if (!rec || !(rec.n > 0)) {
    return {
      v: GHOST_VERSION,
      period_s: rec && rec.period_s > 0 ? rec.period_s : DEFAULT_PERIOD_S,
      n: 0,
      pv: [],
      sp: [],
      co: [],
    };
  }
  return {
    v: GHOST_VERSION,
    period_s: rec.period_s,
    n: rec.n,
    pv: rec.pv.slice(0, rec.n),
    sp: rec.sp.slice(0, rec.n),
    co: rec.co.slice(0, rec.n),
  };
}

/**
 * True when an object has the shape of a ghost and its three channels agree with its count.
 * @param {*} g the candidate
 * @returns {boolean} whether it can be encoded or read
 */
function isGhost(g) {
  if (!g || typeof g !== 'object') return false;
  if (!Number.isFinite(g.period_s) || g.period_s <= 0) return false;
  if (!Number.isInteger(g.n) || g.n < 0 || g.n > MAX_SAMPLES) return false;
  for (const k of ['pv', 'sp', 'co']) {
    const a = g[k];
    if (!a || typeof a.length !== 'number' || a.length < g.n) return false;
  }
  return true;
}

/**
 * Encode a ghost to a compact string.
 *
 * @param {object} ghost a ghost from {@link finishRecording}
 * @returns {string} the encoded text, or an empty string when the ghost is not one. An empty
 *   string is never a valid ghost, so a caller that stores the result without checking stores
 *   something {@link decodeGhost} will refuse rather than something it will misread.
 */
export function encodeGhost(ghost) {
  if (!isGhost(ghost)) return '';
  const ms = Math.round(ghost.period_s * 1000);
  if (!(ms > 0)) return '';
  const body = `${ENCODING_TAG}.${ms}.${ghost.n}`
    + `.${encodeChannel(ghost.pv, ghost.n, EU_STEP)}`
    + `.${encodeChannel(ghost.sp, ghost.n, EU_STEP)}`
    + `.${encodeChannel(ghost.co, ghost.n, CO_STEP)}`;
  return `${body}.${fnv1a(body).toString(36)}`;
}

/**
 * Decode a ghost, refusing anything that does not check out.
 *
 * Every refusal returns null. This function is on the path that reads localStorage at start-up,
 * and a throw there takes the whole game down over an entry that a closed tab left half written.
 *
 * @param {string} text encoded text from {@link encodeGhost}
 * @returns {object|null} the ghost, or null if the text is missing, truncated or corrupt
 */
export function decodeGhost(text) {
  try {
    if (typeof text !== 'string' || text.length === 0) return null;
    const parts = text.split('.');
    if (parts.length !== 7) return null;
    if (parts[0] !== ENCODING_TAG) return null;

    const body = parts.slice(0, 6).join('.');
    if (parts[6] !== fnv1a(body).toString(36)) return null;

    const ms = Number(parts[1]);
    if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_PERIOD_S * 1000) return null;
    const n = Number(parts[2]);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SAMPLES) return null;

    const pv = decodeChannel(parts[3], n, EU_STEP);
    const sp = decodeChannel(parts[4], n, EU_STEP);
    const co = decodeChannel(parts[5], n, CO_STEP);
    if (!pv || !sp || !co) return null;

    return { v: GHOST_VERSION, period_s: ms / 1000, n, pv, sp, co };
  } catch {
    // Unreachable by design, and kept anyway: the one job of this function is to never throw at
    // a caller who is reading somebody else's half-written string.
    return null;
  }
}

/**
 * Read a ghost at an arbitrary time, interpolating between the samples either side.
 *
 * The trend draws at the frame rate and the ghost was recorded at the scan rate, so nearly every
 * read lands between two samples. Holding the nearer sample instead would put a visible staircase
 * on a trace whose whole job is to be compared against a smooth one.
 *
 * @param {object} ghost the ghost
 * @param {number} t_s time since the start of the recording, s
 * @returns {{pv:number, sp:number, co:number}|null} the interpolated sample, or null when the
 *   ghost is empty or `t_s` falls outside the recorded span
 */
export function ghostAt(ghost, t_s) {
  if (!isGhost(ghost) || ghost.n === 0) return null;
  if (!Number.isFinite(t_s)) return null;
  const last = ghost.n - 1;
  let idx = t_s / ghost.period_s;
  if (!(idx >= 0)) return null;
  if (idx > last) {
    // `(n-1)*period / period` is not always exactly `n-1` in binary floating point, and a caller
    // asking for the very last sample by that arithmetic must not be told the ghost ended before
    // it did. Anything past a millionth of a period beyond the end is genuinely outside.
    if (idx - last > 1e-6) return null;
    idx = last;
  }
  const i0 = Math.floor(idx);
  const i1 = i0 + 1 < ghost.n ? i0 + 1 : i0;
  const f = idx - i0;
  return {
    pv: ghost.pv[i0] + (ghost.pv[i1] - ghost.pv[i0]) * f,
    sp: ghost.sp[i0] + (ghost.sp[i1] - ghost.sp[i0]) * f,
    co: ghost.co[i0] + (ghost.co[i1] - ghost.co[i0]) * f,
  };
}

/** Seconds of recording a ghost holds. */
function duration_s(g) {
  return g.n > 0 ? (g.n - 1) * g.period_s : 0;
}

/**
 * Store a ghost under a key.
 *
 * @param {{setItem:Function}|null} storage anything with `setItem`, or null in Node
 * @param {string} key the storage key
 * @param {object} ghost the ghost to store
 * @returns {{ok:boolean, reason?:string}} a refusal an operator could read, never a throw. The
 *   interesting failure is a full quota: `setItem` throws, and the caller has to be able to tell
 *   the player their ghost was not kept rather than pretend it was.
 */
export function saveGhost(storage, key, ghost) {
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, reason: 'No storage is available, so the ghost cannot be kept.' };
  }
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, reason: 'A ghost needs a name to be saved under.' };
  }
  const text = encodeGhost(ghost);
  if (!text) {
    return { ok: false, reason: 'That recording is empty or malformed, so there is nothing to save.' };
  }
  if (text.length > GHOST_BUDGET_BYTES) {
    return {
      ok: false,
      reason: `That ghost encodes to ${text.length} characters, over the ${GHOST_BUDGET_BYTES}`
        + ' allowed per recording. Record it at a longer period.',
    };
  }
  try {
    storage.setItem(key, text);
  } catch (err) {
    return {
      ok: false,
      reason: `Storage refused the ghost (${err && err.name ? err.name : 'error'}) — it is`
        + ' probably full. Clear some saved runs and try again.',
    };
  }
  return { ok: true };
}

/**
 * Read a ghost back.
 * @param {{getItem:Function}|null} storage anything with `getItem`, or null in Node
 * @param {string} key the storage key
 * @returns {object|null} the ghost, or null when it is absent, unreadable or corrupt
 */
export function loadGhost(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  if (typeof key !== 'string' || key.length === 0) return null;
  let text = null;
  try {
    text = storage.getItem(key);
  } catch {
    // Private-mode Safari throws on read as well as on write. That is not a reason to lose a run.
    return null;
  }
  return decodeGhost(text);
}

/**
 * Compare two ghosts on how close each held its own setpoint.
 *
 * Comparison runs on the coarser of the two periods, over the span both recordings cover, because
 * the shorter run has nothing to say about the time after it ended. "Closer" means a smaller
 * absolute deviation from that run's OWN setpoint — the two runs may have been given different
 * setpoints, and it is the control that is being compared, not the numbers.
 *
 * @param {object} a the first ghost, conventionally the current run
 * @param {object} b the second ghost, conventionally the ghost being raced
 * @returns {{leadAt:Array<{from_s:number,to_s:number,lead:string}>, betterFraction:number,
 *   maxGap:number, span_s:number, samples:number}} the intervals over which one run led, with
 *   `lead` one of 'a', 'b' or 'tie'; `betterFraction` the fraction of the compared span where `a`
 *   was strictly closer; `maxGap` the largest difference in deviation between them, EU
 */
export function compareGhosts(a, b) {
  const empty = { leadAt: [], betterFraction: 0, maxGap: 0, span_s: 0, samples: 0 };
  if (!isGhost(a) || !isGhost(b) || a.n === 0 || b.n === 0) return empty;

  const period = Math.max(a.period_s, b.period_s);
  const span = Math.min(duration_s(a), duration_s(b));
  const steps = Math.floor(span / period + DUE_EPS);
  const samples = steps + 1;

  const leadAt = [];
  let wins = 0;
  let maxGap = 0;
  let open = null;

  for (let k = 0; k <= steps; k += 1) {
    const t = k === steps ? span : k * period;
    const sa = ghostAt(a, t);
    const sb = ghostAt(b, t);
    if (!sa || !sb) continue;
    const ea = Math.abs(sa.pv - sa.sp);
    const eb = Math.abs(sb.pv - sb.sp);
    const gap = ea - eb;
    if (Math.abs(gap) > maxGap) maxGap = Math.abs(gap);
    // Differences finer than the step the runs were recorded on are not differences.
    const lead = gap < -EU_STEP ? 'a' : (gap > EU_STEP ? 'b' : 'tie');
    if (lead === 'a') wins += 1;
    if (open && open.lead === lead) {
      open.to_s = t;
    } else {
      open = { from_s: t, to_s: t, lead };
      leadAt.push(open);
    }
  }

  return {
    leadAt,
    betterFraction: samples > 0 ? wins / samples : 0,
    maxGap,
    span_s: span,
    samples,
  };
}
