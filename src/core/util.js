/**
 * src/core/util.js — units, small maths, the seeded RNG, the trend ring and the event bus.
 *
 * Layer L0: imports nothing, touches no DOM, and must import cleanly under `node --test`.
 *
 * UNITS. The whole simulator is metric-hydraulic and every name carries its unit:
 *
 *   Q_m3h   volumetric flow, m3/h        H_m     head, metres of the pumped liquid
 *   p_bar   gauge pressure, bar          P_kW    shaft/electrical power, kW
 *   n_pct   VFD speed, percent of rated  V_m3    volume, m3
 *   t_s     time, seconds                I_A     motor current, amperes
 *
 * Head and pressure are two views of the same quantity and are converted through the CURRENT
 * liquid density, never through a hard-coded 10.2. `headToBar`/`barToHead` are the only two
 * places allowed to make that trip.
 */

/** Standard gravity, m/s^2. */
export const G = 9.80665;

/** Standard atmosphere, bar absolute. Sea-level barometric reference for NPSH. */
export const ATM_BAR = 1.01325;

/** Seconds in an hour — the m3/h to m3/s bridge, spelled out so it is greppable. */
export const S_PER_H = 3600;

/**
 * Convert a head to a gauge pressure through the liquid density.
 * @param {number} H_m head, metres of liquid
 * @param {number} rho_kgm3 liquid density, kg/m3
 * @returns {number} pressure, bar
 */
export function headToBar(H_m, rho_kgm3) {
  return (rho_kgm3 * G * H_m) * 1e-5;
}

/**
 * Convert a gauge pressure to a head through the liquid density.
 * @param {number} p_bar pressure, bar
 * @param {number} rho_kgm3 liquid density, kg/m3
 * @returns {number} head, metres of liquid
 */
export function barToHead(p_bar, rho_kgm3) {
  return (p_bar * 1e5) / (rho_kgm3 * G);
}

/**
 * Hydraulic power delivered to the liquid.
 * @param {number} Q_m3h flow, m3/h
 * @param {number} H_m head, m
 * @param {number} rho_kgm3 density, kg/m3
 * @returns {number} power, kW
 */
export function hydraulicPower_kW(Q_m3h, H_m, rho_kgm3) {
  return (rho_kgm3 * G * (Q_m3h / S_PER_H) * H_m) / 1000;
}

/**
 * Clamp to an inclusive range. NaN clamps to `lo`, so a poisoned intermediate can never escape
 * into the state as NaN and quietly kill every downstream comparison.
 * @param {number} x value
 * @param {number} lo lower bound
 * @param {number} hi upper bound
 * @returns {number} clamped value
 */
export function clamp(x, lo, hi) {
  if (!(x > lo)) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Signed square root, `sign(x) * sqrt(abs(x))`. Every orifice in the plant flows both ways when
 * the differential reverses; this keeps that arithmetic in one place instead of scattering guards.
 * @param {number} x argument
 * @returns {number} signed square root
 */
export function ssqrt(x) {
  return x >= 0 ? Math.sqrt(x) : -Math.sqrt(-x);
}

/**
 * A first-order lag applied over one step, using the exact discrete pole rather than the Euler
 * approximation, so the filter is stable for any `dt_s` and any `tau_s` including zero.
 * @param {number} y previous output
 * @param {number} u current input
 * @param {number} tau_s time constant, s (zero or less passes the input straight through)
 * @param {number} dt_s step, s
 * @returns {number} the new output
 */
export function lag(y, u, tau_s, dt_s) {
  if (!(tau_s > 0)) return u;
  const a = Math.exp(-dt_s / tau_s);
  return u * (1 - a) + y * a;
}

/**
 * Move `y` toward `target` at no more than `rate` units per second.
 * @param {number} y previous value
 * @param {number} target desired value
 * @param {number} rate maximum magnitude of change per second (zero or less means no limit)
 * @param {number} dt_s step, s
 * @returns {number} the rate-limited value
 */
export function slew(y, target, rate, dt_s) {
  if (!(rate > 0)) return target;
  const step = rate * dt_s;
  const d = target - y;
  if (d > step) return y + step;
  if (d < -step) return y - step;
  return target;
}

/**
 * Freeze an object graph in place. Config is frozen at build so a view cannot write to it: every
 * mutable number in this application lives on `run`, and that rule is enforced, not merely stated.
 * @param {*} obj root of the graph
 * @returns {*} the same object, deeply frozen
 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return obj;
}

/**
 * Recursive merge of a patch into a base, returning a new object. Arrays are replaced wholesale,
 * never merged element-wise.
 * @param {object} base the defaults
 * @param {object|null|undefined} patch the overrides
 * @returns {object} a new merged object
 */
export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const b = out[k];
    const p = patch[k];
    const mergeable = p && typeof p === 'object' && !Array.isArray(p)
      && b && typeof b === 'object' && !Array.isArray(b);
    out[k] = mergeable ? deepMerge(b, p) : p;
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// Deterministic randomness
// --------------------------------------------------------------------------------------------

/**
 * Named RNG streams. Every stochastic effect draws from its own stream so that turning one of
 * them off — say, transmitter noise — does not shift the sequence any other effect sees. A run is
 * reproducible from its seed alone, which is what makes two tuning scores comparable.
 */
export const RNG_STREAMS = Object.freeze({
  PT_NOISE: 0x5017,
  FT_NOISE: 0x51f7,
  LT_NOISE: 0x4c47,
  DEMAND_WALK: 0x4457,
  PUMP_WEAR: 0x5057,
});

/**
 * Allocate a 32-bit xorshift RNG state.
 * @param {number} seed_int32 any integer; folded into the state
 * @returns {{s:number}} mutable RNG state
 */
export function createRng(seed_int32) {
  return { s: (seed_int32 | 0) >>> 0 || 0x9e3779b9 };
}

/**
 * Next 32-bit unsigned integer (xorshift32). Advances the state in place.
 * @param {{s:number}} st RNG state
 * @returns {number} an integer in [0, 2^32)
 */
export function nextU32(st) {
  let x = st.s >>> 0;
  x ^= (x << 13) >>> 0; x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0; x >>>= 0;
  st.s = x >>> 0;
  return st.s;
}

/**
 * Next float in [0, 1).
 * @param {{s:number}} st RNG state
 * @returns {number} the sample
 */
export function nextFloat(st) {
  return nextU32(st) / 4294967296;
}

/**
 * Next standard normal sample, by the polar Box-Muller method with the spare discarded so the
 * stream advances by a predictable amount per call.
 * @param {{s:number}} st RNG state
 * @returns {number} a sample from N(0, 1)
 */
export function nextGaussian(st) {
  let u = 0;
  let v = 0;
  let s = 0;
  for (let i = 0; i < 8; i += 1) {
    u = nextFloat(st) * 2 - 1;
    v = nextFloat(st) * 2 - 1;
    s = u * u + v * v;
    if (s > 0 && s < 1) break;
  }
  if (!(s > 0 && s < 1)) return 0;
  return u * Math.sqrt((-2 * Math.log(s)) / s);
}

/**
 * Allocate a pink-ish noise generator: three first-order lags of one white source, summed.
 *
 * Transmitter noise that is pure white looks wrong on a trend — it has no texture, and a filter
 * annihilates it. Real noise has low-frequency wander, which is exactly what a derivative term
 * amplifies, so the sim has to have it for the D discussion to be honest.
 * @returns {{a:number,b:number,c:number}} filter state, all poles at rest
 */
export function createPinkState() {
  return { a: 0, b: 0, c: 0 };
}

/**
 * Advance a pink noise generator one step.
 * @param {{a:number,b:number,c:number}} st filter state (mutated)
 * @param {{s:number}} rng RNG state (mutated; exactly one gaussian draw)
 * @param {number} dt_s step, s
 * @returns {number} a zero-mean sample of order unity
 */
export function nextPink(st, rng, dt_s) {
  const w = nextGaussian(rng);
  st.a = lag(st.a, w, 0.08, dt_s);
  st.b = lag(st.b, w, 0.6, dt_s);
  st.c = lag(st.c, w, 4.0, dt_s);
  return 0.55 * st.a + 0.85 * st.b + 1.35 * st.c;
}

// --------------------------------------------------------------------------------------------
// The trend ring
// --------------------------------------------------------------------------------------------

/**
 * Allocate a fixed-capacity ring of parallel Float32 channels. The trend never allocates while
 * running: it overwrites the oldest row.
 * @param {string[]} names channel names, in the order values are pushed
 * @param {number} rows capacity in samples
 * @returns {{names:string[], data:Object<string,Float32Array>, cap:number, head:number, len:number}} the ring
 */
export function createRing(names, rows) {
  const data = Object.create(null);
  for (const n of names) data[n] = new Float32Array(rows);
  return { names: names.slice(), data, cap: rows, head: 0, len: 0 };
}

/**
 * Append one row. `values` must be in `ring.names` order; a short array leaves the rest at zero.
 * @param {object} ring ring from {@link createRing}
 * @param {ArrayLike<number>} values one value per channel
 * @returns {void}
 */
export function pushRing(ring, values) {
  const i = ring.head;
  for (let c = 0; c < ring.names.length; c += 1) {
    const v = values[c];
    ring.data[ring.names[c]][i] = Number.isFinite(v) ? v : 0;
  }
  ring.head = (i + 1) % ring.cap;
  if (ring.len < ring.cap) ring.len += 1;
}

/*
 * There is deliberately no "read a channel out" helper. The trend indexes the ring IN PLACE —
 * `(head - len + i) % cap` — because copying fifteen thousand samples per channel per frame, for
 * nine channels at sixty frames a second, is eight million pointless writes a second to produce
 * exactly the numbers the ring already holds.
 */

/**
 * Reset a ring to empty without reallocating.
 * @param {object} ring the ring
 * @returns {void}
 */
export function clearRing(ring) {
  ring.head = 0;
  ring.len = 0;
  for (const n of ring.names) ring.data[n].fill(0);
}

// --------------------------------------------------------------------------------------------
// The event bus
// --------------------------------------------------------------------------------------------

/**
 * A minimal synchronous publish/subscribe bus. The physics never subscribes to anything; this
 * exists so views can hear `tick`, `alarm` and `action` without the sim knowing they are there.
 * @returns {{on:Function, off:Function, emit:Function}} the bus
 */
export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  return {
    /**
     * @param {string} name event name
     * @param {Function} fn handler
     * @returns {Function} an unsubscribe thunk
     */
    on(name, fn) {
      let set = subs.get(name);
      if (!set) { set = new Set(); subs.set(name, set); }
      set.add(fn);
      return () => set.delete(fn);
    },
    /**
     * @param {string} name event name
     * @param {Function} fn handler to remove
     * @returns {void}
     */
    off(name, fn) {
      const set = subs.get(name);
      if (set) set.delete(fn);
    },
    /**
     * @param {string} name event name
     * @param {*} payload passed to every handler
     * @returns {void}
     */
    emit(name, payload) {
      const set = subs.get(name);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(payload); } catch (err) { console.error(`bus handler for "${name}"`, err); }
      }
    },
  };
}
