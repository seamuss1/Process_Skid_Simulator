/**
 * src/ui/anim.js — the animation and geometry primitives every visual surface draws with.
 *
 * Layer L5, beside `ui/dom.js`: it may be imported by every other `src/ui` module and it imports
 * only `core/util.js`. There is NO DOM here, no canvas, no `requestAnimationFrame` and no clock.
 * Time arrives as an argument.
 *
 * WHY PURITY IS THE WHOLE DESIGN, AND NOT AN AFFECTATION
 *
 *   · It is testable. Every claim in `tests/anim.test.js` runs under `node --test` with no DOM
 *     shim, because none of this needs one. Geometry that is only exercised by looking at it is
 *     geometry nobody has checked.
 *   · Reduced motion becomes one line. A tween set carries a `scale`; a spring carries a `scale`;
 *     setting either to zero makes the motion complete instantly and leaves the FINAL value on
 *     the screen. Views do not grow a second, untested, no-animation code path.
 *   · A background tab cannot break it. The browser hands back a two-second frame when a tab
 *     wakes; a spring integrated with a naive Euler step at dt = 2 s does not settle, it
 *     explodes, and the operator returns to a gauge needle wrapped round its stop. Every
 *     time-stepped thing in this file is solved in closed form or through an exact discrete pole,
 *     so it is unconditionally stable at any dt from a microsecond to a minute.
 *
 * ALLOCATION IS A CORRECTNESS PROPERTY HERE. These surfaces animate at 60 fps beside a simulator
 * that is already integrating a plant, and the garbage collector does not care whose frame budget
 * it spends. So: particle state is one flat `Float32Array`, the pool hands back objects it built
 * at construction, every routine that produces a point writes into a caller-supplied `out`, and
 * the colour ramp pre-renders its CSS strings because building `rgb(...)` per fill is a string
 * allocation per particle per frame. Signatures are positional wherever a function is called more
 * than a few times a frame — an options object at an emitter's call site is one allocation per
 * particle, which is exactly the allocation the pool exists to avoid.
 *
 * COLOUR. This module holds no palette. Every colour arrives from the caller, which reads it out
 * of `styles/tokens.css` through `getComputedStyle` the way `ui/trend.js` and `ui/curves.js`
 * already do. What this module owns is the ARITHMETIC between two of those colours, and it does
 * it in OKLab/OKLCh rather than sRGB: a health bar interpolated from `--ok` to `--alarm` in sRGB
 * passes through a dark olive at its midpoint, which reads as "worse than either end" at exactly
 * the moment the value is halfway. Perceptual lightness is preserved by construction below.
 */

import { clamp, lag } from '../core/util.js';

// --------------------------------------------------------------------------------------------
// Scalar maths
// --------------------------------------------------------------------------------------------

/**
 * Linear interpolation, un-clamped so it can extrapolate deliberately.
 * @param {number} a value at t = 0
 * @param {number} b value at t = 1
 * @param {number} t the parameter
 * @returns {number} the interpolated value
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Where `x` sits between `a` and `b`, as a fraction. A zero-width range returns 0 rather than
 * escaping as Infinity — an axis whose data has not arrived yet must not poison a coordinate.
 * @param {number} a the low end
 * @param {number} b the high end
 * @param {number} x the value
 * @returns {number} the fraction, un-clamped
 */
export function invLerp(a, b, x) {
  const d = b - a;
  return d === 0 ? 0 : (x - a) / d;
}

/**
 * Clamp to the unit interval. NaN clamps to 0, inheriting `core/util.js::clamp`'s rule.
 * @param {number} x the value
 * @returns {number} `x` in [0, 1]
 */
export function clamp01(x) {
  return clamp(x, 0, 1);
}

/**
 * Hermite smoothstep between two edges: zero slope at both ends.
 * @param {number} e0 lower edge
 * @param {number} e1 upper edge
 * @param {number} x the value
 * @returns {number} the eased fraction in [0, 1]
 */
export function smoothstep(e0, e1, x) {
  const t = clamp01(invLerp(e0, e1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Ken Perlin's quintic smoothstep: zero slope AND zero curvature at both ends, which is what
 * stops a band edge from visibly kinking as it crosses a gridline.
 * @param {number} e0 lower edge
 * @param {number} e1 upper edge
 * @param {number} x the value
 * @returns {number} the eased fraction in [0, 1]
 */
export function smootherstep(e0, e1, x) {
  const t = clamp01(invLerp(e0, e1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Frame-rate independent approach: move `a` toward `b` by an exponential decay of rate `lambda`.
 *
 * The naive `a += (b - a) * 0.1` every frame is the most common animation bug in the world: its
 * speed is a function of the frame rate, so the same code settles in a third of a second at
 * 144 Hz and a second and a half at 30 Hz, and overshoots into oscillation the moment a frame
 * takes longer than 1/0.1 of a step. This uses the exact pole and is correct at every dt.
 * @param {number} a the current value
 * @param {number} b the target
 * @param {number} lambda decay rate, per second (larger is faster)
 * @param {number} dt_s the step, s
 * @returns {number} the new value
 */
export function damp(a, b, lambda, dt_s) {
  if (!(lambda > 0) || !(dt_s > 0)) return b;
  return b + (a - b) * Math.exp(-lambda * dt_s);
}

/**
 * Move toward a target at no more than `rate` per second, stopping exactly on it. This is
 * `core/util.js::slew` in UI clothing and exists so a view does not have to reach across into the
 * physics layer for it.
 * @param {number} a the current value
 * @param {number} b the target
 * @param {number} rate maximum magnitude of change per second
 * @param {number} dt_s the step, s
 * @returns {number} the new value
 */
export function approach(a, b, rate, dt_s) {
  if (!(rate > 0)) return b;
  const step = rate * Math.max(0, dt_s);
  const d = b - a;
  if (d > step) return a + step;
  if (d < -step) return a - step;
  return b;
}

/**
 * Wrap an angle into (-pi, pi]. Needed wherever a needle interpolates: 350 degrees to 10 degrees
 * is twenty degrees of travel, not three hundred and forty.
 * @param {number} rad the angle, radians
 * @returns {number} the equivalent angle in (-pi, pi]
 */
export function wrapAngle(rad) {
  if (!Number.isFinite(rad)) return 0;
  const t = (rad + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/**
 * Allocate a mutable 2-vector, for use as an `out` parameter.
 *
 * Every point-producing routine in this file writes into one of these rather than returning a
 * fresh object, so a particle system that samples a path for two hundred particles a frame does
 * two hundred property writes instead of two hundred allocations.
 * @param {number} [x=0] initial x
 * @param {number} [y=0] initial y
 * @returns {{x:number, y:number}} the vector
 */
export function vec2(x = 0, y = 0) {
  return { x, y };
}

// --------------------------------------------------------------------------------------------
// Easing
// --------------------------------------------------------------------------------------------

/** `back`'s overshoot constant, the CSS/Penner value: a 10% excursion past the target. */
const BACK_C = 1.70158;

/** `elastic`'s angular frequency: three visible bounces before it settles. */
const ELASTIC_W = (2 * Math.PI) / 3;

/**
 * The easing curves, as written. Use {@link EASE}, which is this table with the endpoints pinned.
 *
 * The exported set satisfies `f(0) === 0` and `f(1) === 1` EXACTLY — not to within a tolerance —
 * because an easing that ends at 0.9999 leaves a needle a pixel short of its mark forever, and
 * that is a defect the eye finds long before a test does. Several of the curves below miss that by
 * an ulp when evaluated in floating point, so {@link pinned} enforces it rather than each formula
 * being tuned to hit it by hand.
 *
 * `back` and `elastic` deliberately leave [0, 1] in the middle; that overshoot is the effect.
 * Nothing else does.
 */
const RAW_EASE = Object.freeze({
  /** @param {number} t 0..1 @returns {number} t */
  linear: (t) => t,
  /** @param {number} t 0..1 @returns {number} eased */
  inQuad: (t) => t * t,
  /** @param {number} t 0..1 @returns {number} eased */
  outQuad: (t) => t * (2 - t),
  /** @param {number} t 0..1 @returns {number} eased */
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
  /** @param {number} t 0..1 @returns {number} eased */
  inCubic: (t) => t * t * t,
  /** @param {number} t 0..1 @returns {number} eased */
  outCubic: (t) => 1 - (1 - t) ** 3,
  /** @param {number} t 0..1 @returns {number} eased */
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2),
  /** @param {number} t 0..1 @returns {number} eased */
  inQuart: (t) => t ** 4,
  /** @param {number} t 0..1 @returns {number} eased */
  outQuart: (t) => 1 - (1 - t) ** 4,
  /** @param {number} t 0..1 @returns {number} eased */
  inOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - ((-2 * t + 2) ** 4) / 2),
  // `1 - cos(pi/2)` is 0.9999999999999999, not 1: `Math.cos(Math.PI/2)` is 6.1e-17 rather than
  // zero and the subtraction rounds the wrong way. Guarded, so the endpoint is exact.
  /** @param {number} t 0..1 @returns {number} eased */
  inSine: (t) => (t >= 1 ? 1 : 1 - Math.cos((t * Math.PI) / 2)),
  /** @param {number} t 0..1 @returns {number} eased */
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  /** @param {number} t 0..1 @returns {number} eased */
  // Written as (1 - cos)/2 rather than -(cos - 1)/2, which is the same curve but returns NEGATIVE
  // ZERO at t=0. Every easing here is expected to start at exactly 0, and -0 fails a strict
  // comparison against 0 while printing as "0" — the kind of difference that costs an hour.
  inOutSine: (t) => (1 - Math.cos(Math.PI * t)) / 2,
  // The exponential family is written with the endpoints special-cased rather than with the usual
  // 2^(10t-10) trick alone: that expression is 0.0009765625 at t = 0, not zero, and the resulting
  // one-pixel jump at the start of every expo animation is visible on a 200 px travel.
  /** @param {number} t 0..1 @returns {number} eased */
  inExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  /** @param {number} t 0..1 @returns {number} eased */
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  /** @param {number} t 0..1 @returns {number} eased */
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1
    : t < 0.5 ? (2 ** (20 * t - 10)) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  /** @param {number} t 0..1 @returns {number} eased */
  inCirc: (t) => 1 - Math.sqrt(1 - t * t),
  /** @param {number} t 0..1 @returns {number} eased */
  outCirc: (t) => Math.sqrt(1 - (t - 1) ** 2),
  /** @param {number} t 0..1 @returns {number} eased */
  inOutCirc: (t) => (t < 0.5
    ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
    : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2),
  // Guarded for the same reason as `inSine`: 2.70158 - 1.70158 is 0.9999999999999998 in binary
  // floating point, and an easing that ends a part in 10^16 short is still an easing that does
  // not end where it says it does.
  /** @param {number} t 0..1 @returns {number} eased, overshooting below 0 */
  inBack: (t) => (t >= 1 ? 1 : (BACK_C + 1) * t * t * t - BACK_C * t * t),
  /** @param {number} t 0..1 @returns {number} eased, overshooting past 1 */
  outBack: (t) => 1 + (BACK_C + 1) * (t - 1) ** 3 + BACK_C * (t - 1) ** 2,
  /** @param {number} t 0..1 @returns {number} eased, overshooting at both ends */
  inOutBack: (t) => {
    const c = BACK_C * 1.525;
    return t < 0.5
      ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2
      : (((2 * t - 2) ** 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
  },
  /** @param {number} t 0..1 @returns {number} eased, ringing about 1 */
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1
    : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_W) + 1),
  /** @param {number} t 0..1 @returns {number} eased, settling onto 1 */
  outBounce: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) { const u = t - 1.5 / d; return n * u * u + 0.75; }
    if (t < 2.5 / d) { const u = t - 2.25 / d; return n * u * u + 0.9375; }
    const u = t - 2.625 / d;
    return n * u * u + 0.984375;
  },
});

/**
 * Pin an easing's endpoints to exactly 0 and 1.
 *
 * The docblock above promises f(0) === 0 and f(1) === 1 exactly, and several of these curves miss
 * it by an ulp: `outBack` evaluates 1 - c3 + c1 at zero, which is zero in real arithmetic and
 * 2.2e-16 in floating point, and `inOutSine` used to return negative zero. Those are invisible on
 * screen and fatal to a strict comparison, and — more to the point — the promise is the useful
 * thing here. Rather than hand-tune eleven formulae into exactness and hope the next one added is
 * also exact, the guarantee is enforced in one place, so it holds for every curve in the table and
 * for any curve added later.
 *
 * @param {(t:number)=>number} fn the raw curve
 * @returns {(t:number)=>number} the same curve, exact at both ends
 */
function pinned(fn) {
  return (t) => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return fn(t);
  };
}

/**
 * The easing set, with the endpoint guarantee enforced. See {@link RAW_EASE} for the curves.
 * @type {Readonly<Record<string, (t:number)=>number>>}
 */
export const EASE = Object.freeze(Object.fromEntries(
  Object.entries(RAW_EASE).map(([name, fn]) => [name, pinned(fn)]),
));

/**
 * Look up an easing function by name, falling back to `linear`.
 *
 * Views name their easing in a config table; a typo there must degrade to a straight line rather
 * than throw inside a frame loop and take the whole repaint down.
 * @param {string|Function} name a key of {@link EASE}, or a function passed straight through
 * @returns {(t:number)=>number} the easing function
 */
export function easeFn(name) {
  if (typeof name === 'function') return name;
  return EASE[name] || EASE.linear;
}

/**
 * Evaluate a named easing with the input clamped to [0, 1].
 * @param {string|Function} name a key of {@link EASE}, or a function
 * @param {number} t the parameter, clamped
 * @returns {number} the eased value
 */
export function ease(name, t) {
  return easeFn(name)(clamp01(t));
}

// --------------------------------------------------------------------------------------------
// The spring
// --------------------------------------------------------------------------------------------

/** Below this distance from `zeta = 1` the critically damped branch is used: `wd` underflows. */
const CRIT_BAND = 1e-4;

/** Default settle tolerance: a thousandth of the travel, well under a pixel on any real gauge. */
const SPRING_EPS = 1e-3;

/**
 * Allocate a damped-harmonic-oscillator spring.
 *
 * The step below is the CLOSED-FORM solution of `x'' = -w^2 (x - target) - 2*zeta*w*x'`, not a
 * numerical integration of it. That choice is the whole point: a semi-implicit Euler step is
 * stable only while `dt < 2/w`, so a spring tuned to a comfortable 4 Hz becomes unstable at
 * dt = 40 ms and diverges outright on the two-second frame a browser hands back when a
 * background tab is restored. The analytic solution has no such bound, costs one `exp` and two
 * trigonometric calls whatever the interval, and is EXACT rather than merely stable.
 *
 * @param {object} [spec] the spring
 * @param {number} [spec.value=0] initial position
 * @param {number} [spec.target=value] initial target
 * @param {number} [spec.freq_hz=3] undamped natural frequency, Hz
 * @param {number} [spec.zeta=1] damping ratio: 1 is critical, below 1 overshoots, above crawls
 * @param {number} [spec.velocity=0] initial velocity, units per second
 * @param {number} [spec.epsilon=1e-3] the distance and speed below which it counts as at rest
 * @param {number} [spec.scale=1] motion scale; 0 makes every step snap (reduced motion)
 * @returns {object} the mutable spring state
 */
export function createSpring({
  value = 0, target = value, freq_hz = 3, zeta = 1, velocity = 0,
  epsilon = SPRING_EPS, scale = 1,
} = {}) {
  return {
    x: Number.isFinite(value) ? value : 0,
    v: Number.isFinite(velocity) ? velocity : 0,
    target: Number.isFinite(target) ? target : 0,
    w: Math.max(0, 2 * Math.PI * (Number.isFinite(freq_hz) ? freq_hz : 0)),
    zeta: Math.max(0, Number.isFinite(zeta) ? zeta : 1),
    eps: epsilon > 0 ? epsilon : SPRING_EPS,
    scale: scale >= 0 ? scale : 1,
  };
}

/**
 * Aim a spring at a new target, leaving its position and velocity alone so it bends rather than
 * restarts. A non-finite target is ignored: a dropped transmitter reading must not launch a
 * needle to NaN and blank the gauge for the rest of the session.
 * @param {object} sp the spring
 * @param {number} target the new target
 * @returns {void}
 */
export function springTo(sp, target) {
  if (Number.isFinite(target)) sp.target = target;
}

/**
 * Place a spring on a value immediately, killing its velocity. Used on a mode change, where
 * animating from the old loop's engineering units to the new one's would be meaningless motion.
 * @param {object} sp the spring
 * @param {number} [value=sp.target] where to put it
 * @returns {void}
 */
export function snapSpring(sp, value = sp.target) {
  if (Number.isFinite(value)) { sp.x = value; sp.target = value; }
  sp.v = 0;
}

/**
 * Advance a spring by `dt_s` and return its new position.
 * @param {object} sp the spring, mutated in place
 * @param {number} dt_s the step, s — any interval, including a background tab's
 * @returns {number} the new position
 */
export function stepSpring(sp, dt_s) {
  const dt = (Number.isFinite(dt_s) ? Math.max(0, dt_s) : 0) * sp.scale;
  // scale 0 is the reduced-motion path, and a zero-stiffness spring has no restoring force at
  // all; both mean "be where you are asked to be", which is the honest degenerate answer.
  if (dt === 0 || !(sp.w > 0)) {
    if (sp.scale === 0 || !(sp.w > 0)) snapSpring(sp);
    return sp.x;
  }

  const w = sp.w;
  const z = sp.zeta;
  const d0 = sp.x - sp.target;
  const v0 = sp.v;
  let d;
  let v;

  if (z < 1 - CRIT_BAND) {
    // Underdamped: it rings on the way in.
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w * dt);
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    d = e * (d0 * c + ((v0 + z * w * d0) / wd) * s);
    v = e * (v0 * c - ((w * w * d0 + z * w * v0) / wd) * s);
  } else if (z <= 1 + CRIT_BAND) {
    // Critically damped: the repeated-root solution. Taking the underdamped branch here would
    // divide by a `wd` that has underflowed to zero and hand back NaN for the rest of the run.
    const e = Math.exp(-w * dt);
    const k = v0 + w * d0;
    d = e * (d0 + k * dt);
    v = e * (v0 - w * k * dt);
  } else {
    // Overdamped. Written as two decaying exponentials rather than `exp(-z*w*t) * cosh(s*t)`:
    // both factors of that product overflow independently on a long frame even though their
    // product is tiny, so the naive form returns Infinity * 0 = NaN at exactly the dt this
    // module exists to survive.
    const r = w * Math.sqrt(z * z - 1);
    const e1 = Math.exp((r - z * w) * dt);
    const e2 = Math.exp(-(r + z * w) * dt);
    const ch = 0.5 * (e1 + e2);
    const sh = 0.5 * (e1 - e2);
    d = d0 * ch + ((v0 + z * w * d0) / r) * sh;
    v = v0 * ch - ((w * w * d0 + z * w * v0) / r) * sh;
  }

  // A last guard, not a substitute for the algebra above: if a caller has poisoned the state with
  // a non-finite target, park on it rather than letting NaN spread into every coordinate drawn
  // from this spring for the remainder of the session.
  if (!Number.isFinite(d) || !Number.isFinite(v)) { snapSpring(sp); return sp.x; }

  sp.x = sp.target + d;
  sp.v = v;
  // The velocity gate is scaled by the natural frequency because velocity and position carry
  // different units: a stiff spring that is within epsilon of its target is still moving fast
  // enough to leave again, and calling that "at rest" is how a needle ends up parked mid-swing.
  if (Math.abs(d) < sp.eps && Math.abs(v) < sp.eps * Math.max(w, 1)) { sp.x = sp.target; sp.v = 0; }
  return sp.x;
}

/**
 * Whether a spring has settled. A view that repaints only while something moves asks this.
 * @param {object} sp the spring
 * @returns {boolean} true when it is on its target and still
 */
export function springAtRest(sp) {
  return Math.abs(sp.x - sp.target) < sp.eps && Math.abs(sp.v) < sp.eps * Math.max(sp.w, 1);
}

// --------------------------------------------------------------------------------------------
// The tween scheduler
// --------------------------------------------------------------------------------------------

/**
 * Allocate a fixed-capacity tween scheduler.
 *
 * Fixed capacity on purpose. Decorative motion is the one thing on this screen that may be
 * dropped, and a scheduler that grows without bound is a scheduler that will one day be holding
 * ten thousand tweens because a repeating alarm started one per scan. {@link addTween} refuses
 * instead, and says so in its return value.
 *
 * @param {number} [capacity=32] how many tweens may run at once
 * @param {number} [scale=1] motion scale; 0 completes every tween on its next step
 * @returns {object} the scheduler
 */
export function createTweens(capacity = 32, scale = 1) {
  const cap = Math.max(1, Math.floor(capacity));
  const slots = new Array(cap);
  for (let i = 0; i < cap; i += 1) {
    slots[i] = {
      active: false, gen: 0, from: 0, to: 0, dur: 0, delay: 0, t: 0,
      fn: EASE.linear, onUpdate: null, onDone: null,
    };
  }
  return { cap, slots, count: 0, scale: scale >= 0 ? scale : 1 };
}

/**
 * Start a tween. Returns an id that stays valid only until the tween ends and its slot is
 * recycled — the generation counter baked into the id is what makes a stale {@link cancelTween}
 * a no-op instead of a cancellation of whatever unrelated tween now holds that slot.
 *
 * @param {object} set the scheduler
 * @param {object} spec the tween
 * @param {number} spec.from starting value
 * @param {number} spec.to ending value
 * @param {number} spec.dur_s duration, s; zero or less completes on the first step
 * @param {number} [spec.delay_s=0] a wait before it starts, s
 * @param {string|Function} [spec.ease='outCubic'] a key of {@link EASE} or a function
 * @param {(v:number, t:number)=>void} [spec.onUpdate] called with the value and the eased fraction
 * @param {()=>void} [spec.onDone] called once, after the final `onUpdate`
 * @returns {number} the tween id, or -1 when the scheduler is full
 */
export function addTween(set, { from, to, dur_s, delay_s = 0, ease: e = 'outCubic', onUpdate, onDone }) {
  for (let i = 0; i < set.cap; i += 1) {
    const s = set.slots[i];
    if (s.active) continue;
    s.active = true;
    s.from = Number.isFinite(from) ? from : 0;
    s.to = Number.isFinite(to) ? to : 0;
    s.dur = Number.isFinite(dur_s) && dur_s > 0 ? dur_s : 0;
    s.delay = Number.isFinite(delay_s) && delay_s > 0 ? delay_s : 0;
    s.t = 0;
    s.fn = easeFn(e);
    s.onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
    s.onDone = typeof onDone === 'function' ? onDone : null;
    set.count += 1;
    return s.gen * set.cap + i;
  }
  return -1;
}

/**
 * Stop a tween without running its `onDone`. A cancelled tween leaves the value where it was;
 * the caller decides whether that needs correcting.
 * @param {object} set the scheduler
 * @param {number} id the id from {@link addTween}
 * @returns {boolean} true if a live tween was cancelled
 */
export function cancelTween(set, id) {
  if (!(id >= 0)) return false;
  const i = id % set.cap;
  const gen = Math.floor(id / set.cap);
  const s = set.slots[i];
  if (!s.active || s.gen !== gen) return false;
  s.active = false;
  s.gen += 1;
  s.onUpdate = null;
  s.onDone = null;
  set.count -= 1;
  return true;
}

/**
 * Stop every tween. Callbacks are dropped, not run — this is teardown, and a callback that
 * writes to a view being destroyed is a listener leak wearing a disguise.
 * @param {object} set the scheduler
 * @returns {void}
 */
export function clearTweens(set) {
  for (let i = 0; i < set.cap; i += 1) {
    const s = set.slots[i];
    if (!s.active) continue;
    s.active = false;
    s.gen += 1;
    s.onUpdate = null;
    s.onDone = null;
  }
  set.count = 0;
}

/**
 * Advance every live tween by `dt_s`, calling their callbacks.
 *
 * With `set.scale` at zero — the reduced-motion setting — every tween completes on this step at
 * its FINAL value. It does not freeze at its starting value and it does not stall forever
 * consuming a slot; the operator gets the end state, immediately, which is what reduced motion
 * asks for.
 *
 * @param {object} set the scheduler
 * @param {number} dt_s the step, s
 * @returns {number} how many tweens are still running
 */
export function stepTweens(set, dt_s) {
  const raw = Number.isFinite(dt_s) ? Math.max(0, dt_s) : 0;
  const instant = !(set.scale > 0);
  const dt = raw * set.scale;
  for (let i = 0; i < set.cap; i += 1) {
    const s = set.slots[i];
    if (!s.active) continue;

    let done = false;
    let v;
    let f;
    if (instant) {
      done = true;
      f = 1;
      v = s.to;
    } else {
      s.t += dt;
      const el = s.t - s.delay;
      if (el < 0) continue;                       // still in its delay: no callback, no value yet
      // The epsilon is not fussiness, it is the difference between a tween that retires and one
      // that does not. Callers advance this by a fixed timestep, and a run of steps that ought to
      // sum to the duration does not: ten additions of 0.1 reach 0.9999999999999999, so a
      // one-second tween stepped at 100 ms arrives one ulp short of done, hands out its end value,
      // and then sits in its slot forever holding a callback nobody will call again. A nanosecond
      // of slack is many orders below any frame interval, so it can never finish a tween early
      // enough to see; the relative term keeps that true for long durations, where the accumulated
      // error grows with the number of steps.
      const eps = Math.max(1e-9, s.dur * 1e-12);
      done = s.dur <= 0 || el + eps >= s.dur;
      f = done ? 1 : s.fn(el / s.dur);
      v = done ? s.to : s.from + (s.to - s.from) * f;
    }

    // The callbacks are read into locals and the slot is retired BEFORE they run: an `onDone`
    // that starts the next tween in a sequence is the normal case, and it must be free to claim
    // this very slot without the loop then treating the new tween as the old one.
    const up = s.onUpdate;
    const fin = s.onDone;
    if (done) {
      s.active = false;
      s.gen += 1;
      s.onUpdate = null;
      s.onDone = null;
      set.count -= 1;
    }
    if (up) up(v, f);
    if (done && fin) fin();
  }
  return set.count;
}

// --------------------------------------------------------------------------------------------
// The object pool
// --------------------------------------------------------------------------------------------

/** The property a pooled object carries its own slot index in. */
const SLOT = 'poolSlot';

/**
 * Allocate a fixed-capacity object pool, fully populated at construction.
 *
 * Every object exists before the first frame does, so a particle burst allocates nothing: it
 * takes objects that were already there. Past capacity {@link poolTake} returns `null` and the
 * caller drops the effect, which is the correct failure — a visual flourish is never worth a
 * frame drop, and an unbounded pool is just a memory leak with a friendly name.
 *
 * @param {number} capacity how many objects to build
 * @param {()=>object} factory builds one object; called exactly `capacity` times, at construction
 * @param {(o:object)=>void} [reset] returns an object to its rest state on release
 * @returns {object} the pool
 */
export function createPool(capacity, factory, reset) {
  const cap = Math.max(0, Math.floor(capacity));
  const items = new Array(cap);
  const free = new Int32Array(cap);
  const live = new Uint8Array(cap);
  for (let i = 0; i < cap; i += 1) {
    const o = factory();
    // The slot index rides on the object so that a release is O(1) and, more importantly, so a
    // DOUBLE release is detectable. A pool that silently accepts the same object twice pushes one
    // index onto the free list twice, hands it to two owners at once, and halves its own
    // capacity — a bug that shows up as particles flickering between two trajectories, hours
    // after the mistake, in a completely different file.
    o[SLOT] = i;
    items[i] = o;
    free[i] = cap - 1 - i;
  }
  return { cap, items, free, live, top: cap, reset: typeof reset === 'function' ? reset : null };
}

/**
 * Take an object from the pool.
 * @param {object} pool the pool
 * @returns {object|null} an object, or null when the pool is exhausted
 */
export function poolTake(pool) {
  if (pool.top <= 0) return null;
  pool.top -= 1;
  const i = pool.free[pool.top];
  pool.live[i] = 1;
  return pool.items[i];
}

/**
 * Return an object to the pool. Releasing something the pool does not own, or releasing the same
 * object twice, is refused rather than corrupting the free list.
 * @param {object} pool the pool
 * @param {object|null} o the object
 * @returns {boolean} true if it was live and has now been released
 */
export function poolGive(pool, o) {
  if (!o) return false;
  const i = o[SLOT];
  if (!(i >= 0 && i < pool.cap) || pool.items[i] !== o || !pool.live[i]) return false;
  pool.live[i] = 0;
  if (pool.reset) pool.reset(o);
  pool.free[pool.top] = i;
  pool.top += 1;
  return true;
}

/**
 * Release everything, resetting each live object. Reuses the same objects — nothing is discarded.
 * @param {object} pool the pool
 * @returns {void}
 */
export function poolClear(pool) {
  pool.top = 0;
  for (let i = 0; i < pool.cap; i += 1) {
    if (pool.live[i] && pool.reset) pool.reset(pool.items[i]);
    pool.live[i] = 0;
    pool.free[i] = pool.cap - 1 - i;
  }
  pool.top = pool.cap;
}

/**
 * How many objects are currently out on loan.
 * @param {object} pool the pool
 * @returns {number} the count
 */
export function poolUsed(pool) {
  return pool.cap - pool.top;
}

// --------------------------------------------------------------------------------------------
// The particle system
// --------------------------------------------------------------------------------------------

/**
 * Field offsets within one particle's stride in the flat state array.
 *
 * One `Float32Array` rather than an array of objects, because eight hundred particle objects is
 * eight hundred pointer chases per frame and a nursery collection every couple of seconds; a flat
 * array is one contiguous walk and zero garbage. `SEED` is a per-particle random constant so a
 * renderer can vary size, phase or hue without needing its own RNG in the frame loop.
 */
export const PARTICLE = Object.freeze({
  X: 0, Y: 1, VX: 2, VY: 3, AGE: 4, LIFE: 5, SIZE: 6, SEED: 7, STRIDE: 8,
});

/**
 * Allocate a particle system.
 *
 * Live particles are kept PACKED into `[0, count)` by swap-removal, so a renderer walks a dense
 * prefix and never tests a liveness flag. The consequence, and it is the only rule callers must
 * respect: an index is valid for the current frame only. Retiring a particle moves the last one
 * into its place, so nothing may hold an index across a {@link stepParticles}.
 *
 * @param {number} capacity the maximum number of live particles
 * @returns {object} the system
 */
export function createParticles(capacity) {
  const cap = Math.max(0, Math.floor(capacity));
  return { cap, count: 0, data: new Float32Array(cap * PARTICLE.STRIDE) };
}

/**
 * Emit one particle.
 *
 * Positional arguments, not an options bag: this is called once per particle per emission and an
 * options object here would be exactly the per-frame allocation the flat array is here to avoid.
 *
 * @param {object} ps the system
 * @param {number} x position
 * @param {number} y position
 * @param {number} vx velocity, units per second
 * @param {number} vy velocity, units per second
 * @param {number} life_s how long it lives, s
 * @param {number} [size=1] a size the renderer interprets
 * @param {number} [seed=0] a per-particle constant, conventionally in [0, 1)
 * @returns {number} the new particle's index, or -1 when the system is full
 */
export function emitParticle(ps, x, y, vx, vy, life_s, size = 1, seed = 0) {
  if (ps.count >= ps.cap) return -1;
  const i = ps.count;
  const o = i * PARTICLE.STRIDE;
  const d = ps.data;
  d[o + PARTICLE.X] = x;
  d[o + PARTICLE.Y] = y;
  d[o + PARTICLE.VX] = vx;
  d[o + PARTICLE.VY] = vy;
  d[o + PARTICLE.AGE] = 0;
  d[o + PARTICLE.LIFE] = life_s > 0 ? life_s : 0;
  d[o + PARTICLE.SIZE] = size;
  d[o + PARTICLE.SEED] = seed;
  ps.count = i + 1;
  return i;
}

/**
 * Advance every live particle and retire the expired ones.
 *
 * Drag is applied as `v *= exp(-drag*dt)`, the exact solution of `v' = -drag*v`, for the same
 * reason the spring is solved in closed form: the naive `v *= (1 - drag*dt)` reverses the
 * velocity when `drag*dt > 1`, and a two-second frame from a restored background tab makes that
 * true for any drag above 0.5, sending every particle backwards up its pipe.
 *
 * @param {object} ps the system
 * @param {number} dt_s the step, s
 * @param {number} [ax=0] acceleration, units per second squared
 * @param {number} [ay=0] acceleration, units per second squared
 * @param {number} [drag=0] velocity decay rate, per second
 * @returns {number} the number of live particles after the step
 */
export function stepParticles(ps, dt_s, ax = 0, ay = 0, drag = 0) {
  const dt = Number.isFinite(dt_s) ? Math.max(0, dt_s) : 0;
  if (dt === 0) return ps.count;
  const d = ps.data;
  const S = PARTICLE.STRIDE;
  const k = drag > 0 ? Math.exp(-drag * dt) : 1;
  let i = 0;
  while (i < ps.count) {
    const o = i * S;
    const age = d[o + PARTICLE.AGE] + dt;
    if (age >= d[o + PARTICLE.LIFE]) {
      // Swap-remove: the last live particle takes this slot, and this index is re-examined.
      const last = (ps.count - 1) * S;
      if (last !== o) for (let f = 0; f < S; f += 1) d[o + f] = d[last + f];
      ps.count -= 1;
      continue;
    }
    const vx = (d[o + PARTICLE.VX] + ax * dt) * k;
    const vy = (d[o + PARTICLE.VY] + ay * dt) * k;
    d[o + PARTICLE.VX] = vx;
    d[o + PARTICLE.VY] = vy;
    d[o + PARTICLE.X] += vx * dt;
    d[o + PARTICLE.Y] += vy * dt;
    d[o + PARTICLE.AGE] = age;
    i += 1;
  }
  return ps.count;
}

/**
 * A particle's age as a fraction of its life, for fading and shrinking.
 * @param {object} ps the system
 * @param {number} i the particle index, valid this frame only
 * @returns {number} 0 at birth, approaching 1 at death
 */
export function particleAge(ps, i) {
  const o = i * PARTICLE.STRIDE;
  const life = ps.data[o + PARTICLE.LIFE];
  return life > 0 ? clamp01(ps.data[o + PARTICLE.AGE] / life) : 1;
}

/**
 * Retire every particle without reallocating the state array.
 * @param {object} ps the system
 * @returns {void}
 */
export function clearParticles(ps) {
  ps.count = 0;
}

// --------------------------------------------------------------------------------------------
// Isometric projection
// --------------------------------------------------------------------------------------------

/**
 * Build an isometric projection.
 *
 * The inverse is not a nicety: without it, hit-testing an isometric scene means either keeping a
 * second copy of every symbol's screen-space bounds in step with the projection by hand, or
 * painting an off-screen picking buffer. Both are how isometric views rot. One `unproject` on the
 * pointer, against the plane a symbol stands on, and the hit test happens in world coordinates
 * where the geometry is already written.
 *
 * @param {object} [spec] the projection
 * @param {number} [spec.tileW=32] screen width of one world unit along x or y
 * @param {number} [spec.tileH=16] screen height of one world unit — half of `tileW` is the
 *   classic 2:1 "isometric" of games, which is a dimetric projection and reads correctly
 * @param {number} [spec.zScale=16] screen rise per world unit of height
 * @param {number} [spec.originX=0] screen position of the world origin
 * @param {number} [spec.originY=0] screen position of the world origin
 * @returns {object} the frozen projection
 */
export function createIso({
  tileW = 32, tileH = 16, zScale = 16, originX = 0, originY = 0,
} = {}) {
  return Object.freeze({
    sx: tileW / 2, sy: tileH / 2, zScale, originX, originY,
  });
}

/**
 * World to screen.
 * @param {object} iso the projection
 * @param {number} x world x
 * @param {number} y world y
 * @param {number} z world height
 * @param {{x:number,y:number}} out written in place
 * @returns {{x:number,y:number}} `out`
 */
export function isoProject(iso, x, y, z, out) {
  out.x = (x - y) * iso.sx + iso.originX;
  out.y = (x + y) * iso.sy - z * iso.zScale + iso.originY;
  return out;
}

/**
 * Screen back to world, on the horizontal plane at height `z`.
 *
 * A screen point does not determine a world point — it determines a ray — so the caller states
 * which plane it means. For hit-testing a symbol standing on the floor that is `z = 0`; for the
 * top of a vessel it is the vessel's height.
 *
 * @param {object} iso the projection
 * @param {number} sx screen x
 * @param {number} sy screen y
 * @param {number} z the world height of the plane being tested
 * @param {{x:number,y:number}} out written in place
 * @returns {{x:number,y:number}} `out`
 */
export function isoUnproject(iso, sx, sy, z, out) {
  const a = (sx - iso.originX) / iso.sx;          // x - y
  const b = (sy - iso.originY + z * iso.zScale) / iso.sy;  // x + y
  out.x = (a + b) / 2;
  out.y = (b - a) / 2;
  return out;
}

/**
 * Painter's-algorithm sort key: larger draws later, and therefore in front.
 * @param {number} x world x
 * @param {number} y world y
 * @param {number} z world height
 * @returns {number} the depth key
 */
export function isoDepth(x, y, z) {
  return x + y + z * 1e-3;
}

// --------------------------------------------------------------------------------------------
// Path arithmetic
// --------------------------------------------------------------------------------------------

/**
 * Build an arc-length-parameterised polyline from flat `[x0, y0, x1, y1, ...]` coordinates.
 *
 * The cumulative length table is what turns "put this particle 12.4 units along the discharge
 * header" into a point. Without it, a particle walking a pipe by parameter rather than by
 * distance speeds up on the long straight and crawls round the elbows, and the animation stops
 * being a picture of a flow rate.
 *
 * @param {ArrayLike<number>} coords flat x, y pairs; an odd trailing value is ignored
 * @returns {object} the path: `xs`, `ys`, `cum`, `n`, `length`
 */
export function createPath(coords) {
  const n = Math.max(0, Math.floor(coords.length / 2));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i += 1) { xs[i] = coords[2 * i]; ys[i] = coords[2 * i + 1]; }
  for (let i = 1; i < n; i += 1) {
    cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  // `hint` is a search cursor. Particles walk a path monotonically, so the segment they want is
  // almost always the one the last query landed in; checking it first turns the common case into
  // two comparisons and leaves the binary search for the seeks that really are random.
  return { xs, ys, cum, n, length: n > 0 ? cum[n - 1] : 0, hint: 0 };
}

/**
 * Find the index of the segment containing distance `s`.
 * @param {object} path the path
 * @param {number} s distance along it, already clamped to [0, length]
 * @returns {number} the index `i` with `cum[i] <= s <= cum[i+1]`, in [0, n-2]
 */
function segmentAt(path, s) {
  const { cum, n } = path;
  const last = n - 2;
  const h = path.hint;
  if (h >= 0 && h <= last && cum[h] <= s && s <= cum[h + 1]) return h;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid - 1;
  }
  path.hint = lo;
  return lo;
}

/**
 * The point at a distance along a path.
 *
 * `s` is clamped, and `s >= length` returns the LAST VERTEX EXACTLY rather than a value
 * accumulated through the segment parameter — a particle that reaches the end of a pipe must land
 * on the end of the pipe, not a rounding error away from it.
 *
 * A path with no vertices writes the origin instead of throwing: a view whose layout has not been
 * measured yet still gets a repaint, it just draws nothing.
 *
 * @param {object} path the path
 * @param {number} s distance from the start
 * @param {{x:number,y:number}} out written in place
 * @returns {{x:number,y:number}} `out`
 */
export function pathPointAt(path, s, out) {
  const { xs, ys, cum, n } = path;
  if (n === 0) { out.x = 0; out.y = 0; return out; }
  if (n === 1 || !(s > 0)) { out.x = xs[0]; out.y = ys[0]; return out; }
  if (s >= path.length) { out.x = xs[n - 1]; out.y = ys[n - 1]; return out; }
  const i = segmentAt(path, s);
  const seg = cum[i + 1] - cum[i];
  const t = seg > 0 ? (s - cum[i]) / seg : 0;
  out.x = xs[i] + (xs[i + 1] - xs[i]) * t;
  out.y = ys[i] + (ys[i + 1] - ys[i]) * t;
  return out;
}

/**
 * The unit tangent at a distance along a path.
 *
 * Zero-length segments are stepped over in both directions before giving up: a duplicated vertex
 * in hand-written path data would otherwise produce a zero tangent, and a rotation built from it
 * collapses the sprite it was meant to orient. A path with no direction at all reports `(1, 0)`,
 * which leaves such a sprite unrotated rather than degenerate.
 *
 * @param {object} path the path
 * @param {number} s distance from the start
 * @param {{x:number,y:number}} out written in place
 * @returns {{x:number,y:number}} `out`, a unit vector
 */
export function pathTangentAt(path, s, out) {
  const { xs, ys, n } = path;
  out.x = 1; out.y = 0;
  if (n < 2) return out;
  const start = clamp(s, 0, path.length);
  const i = start >= path.length ? n - 2 : segmentAt(path, start);
  for (let k = i; k < n - 1; k += 1) {
    const dx = xs[k + 1] - xs[k];
    const dy = ys[k + 1] - ys[k];
    const L = Math.hypot(dx, dy);
    if (L > 0) { out.x = dx / L; out.y = dy / L; return out; }
  }
  for (let k = i - 1; k >= 0; k -= 1) {
    const dx = xs[k + 1] - xs[k];
    const dy = ys[k + 1] - ys[k];
    const L = Math.hypot(dx, dy);
    if (L > 0) { out.x = dx / L; out.y = dy / L; return out; }
  }
  return out;
}

/**
 * Wrap a distance into [0, length), for a particle that recirculates along a pipe forever.
 * @param {object} path the path
 * @param {number} s any distance, positive or negative
 * @returns {number} the equivalent distance within the path
 */
export function pathWrap(path, s) {
  const L = path.length;
  if (!(L > 0) || !Number.isFinite(s)) return 0;
  const m = s % L;
  return m < 0 ? m + L : m;
}

// --------------------------------------------------------------------------------------------
// Cubic Béziers
// --------------------------------------------------------------------------------------------

/** 8-point Gauss-Legendre abscissae on [-1, 1]; exact for polynomials up to degree 15. */
const GL8_X = Object.freeze([
  -0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
  0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363,
]);

/** The matching Gauss-Legendre weights. */
const GL8_W = Object.freeze([
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
  0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
]);

/**
 * A point on a cubic Bézier.
 * @param {number} x0 start
 * @param {number} y0 start
 * @param {number} x1 first control point
 * @param {number} y1 first control point
 * @param {number} x2 second control point
 * @param {number} y2 second control point
 * @param {number} x3 end
 * @param {number} y3 end
 * @param {number} t the parameter, 0..1
 * @param {{x:number,y:number}} out written in place
 * @returns {{x:number,y:number}} `out`
 */
export function cubicAt(x0, y0, x1, y1, x2, y2, x3, y3, t, out) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  out.x = a * x0 + b * x1 + c * x2 + d * x3;
  out.y = a * y0 + b * y1 + c * y2 + d * y3;
  return out;
}

/**
 * The derivative of a cubic Bézier — the tangent, NOT normalised, because its magnitude is the
 * speed the arc-length integral below needs.
 * @param {number} x0 start
 * @param {number} y0 start
 * @param {number} x1 first control point
 * @param {number} y1 first control point
 * @param {number} x2 second control point
 * @param {number} y2 second control point
 * @param {number} x3 end
 * @param {number} y3 end
 * @param {number} t the parameter, 0..1
 * @param {{x:number,y:number}} out written in place
 * @returns {{x:number,y:number}} `out`
 */
export function cubicTangentAt(x0, y0, x1, y1, x2, y2, x3, y3, t, out) {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  out.x = a * (x1 - x0) + b * (x2 - x1) + c * (x3 - x2);
  out.y = a * (y1 - y0) + b * (y2 - y1) + c * (y3 - y2);
  return out;
}

/**
 * The arc length of a cubic Bézier, by 8-point Gauss-Legendre quadrature of the speed.
 *
 * There is no closed form for this integral. Quadrature over the speed is exact for any curve
 * whose speed is a polynomial of degree 15 or less, which a cubic's rarely is — but the residual
 * on a pipe-shaped curve is parts per million, and it is two orders of magnitude cheaper than
 * flattening the curve just to measure it.
 *
 * @param {number} x0 start
 * @param {number} y0 start
 * @param {number} x1 first control point
 * @param {number} y1 first control point
 * @param {number} x2 second control point
 * @param {number} y2 second control point
 * @param {number} x3 end
 * @param {number} y3 end
 * @returns {number} the arc length
 */
export function cubicLength(x0, y0, x1, y1, x2, y2, x3, y3) {
  const d = vec2();
  let sum = 0;
  for (let i = 0; i < GL8_X.length; i += 1) {
    const t = 0.5 * (GL8_X[i] + 1);
    cubicTangentAt(x0, y0, x1, y1, x2, y2, x3, y3, t, d);
    sum += GL8_W[i] * Math.hypot(d.x, d.y);
  }
  return 0.5 * sum;
}

/** Deepest recursion in {@link flattenCubic}: 2^14 segments is far past any useful tolerance. */
const FLATTEN_DEPTH = 14;

/**
 * Flatten a cubic into line segments, appending `x, y` pairs to `out`.
 *
 * Adaptive rather than fixed-step: a fixed subdivision either over-samples the straight runs of a
 * pipe or under-samples its elbows, and the whole point of measuring flatness is that the curve
 * says how many segments it needs. The START point is NOT appended, so segments chain into one
 * continuous list without a duplicated vertex at every join — a duplicate there is a zero-length
 * segment, and a zero-length segment is exactly the case {@link pathTangentAt} has to work
 * around.
 *
 * This allocates into `out` and belongs in layout, not in a frame loop.
 *
 * @param {number} x0 start
 * @param {number} y0 start
 * @param {number} x1 first control point
 * @param {number} y1 first control point
 * @param {number} x2 second control point
 * @param {number} y2 second control point
 * @param {number} x3 end
 * @param {number} y3 end
 * @param {number} [tol=0.25] maximum deviation from the true curve, in the same units
 * @param {number[]} [out=[]] the array appended to
 * @param {number} [depth=0] recursion guard; callers leave this alone
 * @returns {number[]} `out`
 */
export function flattenCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol = 0.25, out = [], depth = 0) {
  // Flatness measured as the control points' distance from the chord — the standard cheap test,
  // and conservative, which is the direction an error should point.
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  const chord2 = dx * dx + dy * dy;
  if (depth >= FLATTEN_DEPTH) { out.push(x3, y3); return out; }
  if (chord2 === 0) {
    // A closed loop: the chord test is degenerate because the chord has no length, so fall back
    // to how far the control points stray from the coincident ends. Without this the recursion
    // runs to its full depth on every such segment and emits 16384 points for a dot.
    const c1 = Math.hypot(x1 - x0, y1 - y0);
    const c2 = Math.hypot(x2 - x0, y2 - y0);
    if (c1 + c2 <= tol) { out.push(x3, y3); return out; }
  } else if ((d1 + d2) ** 2 <= tol * tol * chord2) {
    out.push(x3, y3);
    return out;
  }

  // de Casteljau split at the midpoint.
  const x01 = (x0 + x1) / 2; const y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2; const y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2; const y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2; const ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2; const yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2; const ym = (ya + yb) / 2;
  flattenCubic(x0, y0, x01, y01, xa, ya, xm, ym, tol, out, depth + 1);
  flattenCubic(xm, ym, xb, yb, x23, y23, x3, y3, tol, out, depth + 1);
  return out;
}

/**
 * Build an arc-length path from a chain of cubic segments.
 * @param {ArrayLike<number>} segs flat `x0,y0,x1,y1,x2,y2,x3,y3` per segment; each segment's end
 *   is expected to be the next one's start, but nothing here requires it
 * @param {number} [tol=0.25] flattening tolerance
 * @returns {object} a path, as {@link createPath}
 */
export function pathFromCubics(segs, tol = 0.25) {
  const pts = [];
  const n = Math.floor(segs.length / 8);
  for (let i = 0; i < n; i += 1) {
    const o = i * 8;
    if (i === 0) pts.push(segs[o], segs[o + 1]);
    flattenCubic(segs[o], segs[o + 1], segs[o + 2], segs[o + 3],
      segs[o + 4], segs[o + 5], segs[o + 6], segs[o + 7], tol, pts);
  }
  return createPath(pts);
}

// --------------------------------------------------------------------------------------------
// Catmull-Rom smoothing
// --------------------------------------------------------------------------------------------

/**
 * Convert one Catmull-Rom span into the cubic Bézier that draws it.
 *
 * Cubics, not sampled points, because that is what a canvas takes: `bezierCurveTo` renders the
 * span at the device's own resolution, so it stays smooth when the canvas is scaled for a
 * high-DPR display, where a curve pre-sampled into segments visibly facets.
 *
 * The spline passes THROUGH `p1` and `p2`; `p0` and `p3` only set the slopes there. That is the
 * property that makes it right for drawing a smooth pipe through surveyed corner points, and
 * wrong for anything that must not overshoot — the curve can bulge outside the hull of its
 * points, so a value trace is not a candidate for it.
 *
 * @param {number} x0 the point before the span
 * @param {number} y0 the point before the span
 * @param {number} x1 the span's start, which the curve passes through
 * @param {number} y1 the span's start
 * @param {number} x2 the span's end, which the curve passes through
 * @param {number} y2 the span's end
 * @param {number} x3 the point after the span
 * @param {number} y3 the point after the span
 * @param {number} [tension=0.5] 0.5 is the uniform Catmull-Rom; 0 is a straight line
 * @param {number[]} [out=[]] appended with `c1x, c1y, c2x, c2y, x2, y2`
 * @returns {number[]} `out`
 */
export function catmullRomToCubic(x0, y0, x1, y1, x2, y2, x3, y3, tension = 0.5, out = []) {
  const k = tension / 3;
  out.push(
    x1 + (x2 - x0) * k, y1 + (y2 - y0) * k,
    x2 - (x3 - x1) * k, y2 - (y3 - y1) * k,
    x2, y2,
  );
  return out;
}

/**
 * Smooth a polyline into a chain of cubic segments through its own points.
 *
 * The ends are handled by reflecting the neighbouring point rather than by duplicating the
 * endpoint: duplication leaves a zero-length tangent and the curve leaves the first point in a
 * visibly wrong direction.
 *
 * @param {ArrayLike<number>} coords flat x, y pairs
 * @param {number} [tension=0.5] as {@link catmullRomToCubic}
 * @param {boolean} [closed=false] whether to join the last point back to the first
 * @returns {number[]} flat `x0,y0,x1,y1,x2,y2,x3,y3` per cubic segment
 */
export function smoothPolyline(coords, tension = 0.5, closed = false) {
  const n = Math.floor(coords.length / 2);
  const out = [];
  if (n < 2) return out;
  /**
   * Fetch a point by index, wrapping when closed and reflecting past the ends when not.
   * @param {number} i the index, possibly out of range
   * @param {number} c 0 for x, 1 for y
   * @returns {number} the coordinate
   */
  const at = (i, c) => {
    if (closed) return coords[2 * (((i % n) + n) % n) + c];
    if (i < 0) return 2 * coords[c] - coords[2 + c];
    if (i > n - 1) return 2 * coords[2 * (n - 1) + c] - coords[2 * (n - 2) + c];
    return coords[2 * i + c];
  };
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i += 1) {
    const x1 = at(i, 0); const y1 = at(i, 1);
    out.push(x1, y1);
    catmullRomToCubic(
      at(i - 1, 0), at(i - 1, 1), x1, y1,
      at(i + 1, 0), at(i + 1, 1), at(i + 2, 0), at(i + 2, 1),
      tension, out,
    );
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// Nice-number axis ticks
// --------------------------------------------------------------------------------------------

/**
 * Round a positive number to a "nice" one: 1, 2, 5 or 10 times a power of ten.
 *
 * Heckbert's rule, from Graphics Gems. The point of it is that operators read axes by counting,
 * and counting in threes and sevens is work; the same chart with a 2.5 step is measurably slower
 * to read than one with a 2.
 *
 * @param {number} x a positive number
 * @param {boolean} round true to round to nearest, false to round up
 * @returns {number} the nice number, or 0 if `x` was not positive and finite
 */
export function niceNum(x, round) {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  const exp = Math.floor(Math.log10(x));
  const f = x / 10 ** exp;
  let nf;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/**
 * Choose an axis range and tick interval covering `[lo, hi]` in about `want` steps.
 *
 * The returned range always CONTAINS the data — never crops it, which would put a trace outside
 * its own frame — and always has at least two ticks. A reversed range is corrected; a
 * zero-width one is opened out, because an axis with no span cannot be drawn at all and a view
 * that is handed one must still repaint.
 *
 * @param {number} lo the data minimum
 * @param {number} hi the data maximum
 * @param {number} [want=5] the approximate number of intervals
 * @returns {{lo:number, hi:number, step:number, count:number}} the axis
 */
export function niceTicks(lo, hi, want = 5) {
  let a = Number.isFinite(lo) ? lo : 0;
  let b = Number.isFinite(hi) ? hi : 1;
  if (a > b) { const t = a; a = b; b = t; }
  if (a === b) {
    const pad = Math.abs(a) > 0 ? Math.abs(a) * 0.5 : 0.5;
    a -= pad;
    b += pad;
  }
  const n = Math.max(1, Math.floor(want));
  const step = niceNum(niceNum(b - a, false) / n, true) || 1;
  const tLo = Math.floor(a / step) * step;
  const tHi = Math.ceil(b / step) * step;
  return { lo: tLo, hi: tHi, step, count: Math.round((tHi - tLo) / step) + 1 };
}

/**
 * Write an axis's tick values into a caller-supplied array.
 *
 * Values are computed as `lo + i*step` rather than by repeated addition: accumulating a step
 * thirty times drifts, and a gridline labelled `0.30000000000000004` has happened to everyone.
 *
 * @param {{lo:number, step:number, count:number}} axis from {@link niceTicks}
 * @param {number[]|Float64Array} out written from index 0. A typed array is filled only as far as
 *   it goes — it is the caller's fixed frame budget and this must not try to grow it — while a
 *   plain array is extended, since that is what a layout pass wants.
 * @returns {number} how many were written
 */
export function fillTicks(axis, out) {
  const n = Array.isArray(out) ? axis.count : Math.min(axis.count, out.length);
  for (let i = 0; i < n; i += 1) out[i] = axis.lo + i * axis.step;
  return n;
}

// --------------------------------------------------------------------------------------------
// The value smoother
// --------------------------------------------------------------------------------------------

/**
 * Allocate a first-order value smoother for a gauge or a bar.
 *
 * WHY A GAUGE NEEDS ONE AND A TREND DOES NOT. The trend's job is to show the measurement,
 * including its noise — that noise is the diagnosis. A gauge's job is to be readable at a glance
 * from across a control room, and a needle redrawn from a raw noisy transmitter at 60 fps is a
 * blur with no readable position. So the gauge lags, the trend does not, and the lag is stated in
 * seconds rather than in per-frame fractions so it means the same thing on every machine.
 *
 * @param {object} [spec] the smoother
 * @param {number} [spec.value=0] initial output
 * @param {number} [spec.tau_s=0.25] time constant, s; zero passes the input straight through
 * @param {number} [spec.snap=Infinity] a step larger than this jumps instead of lagging, so a
 *   mode change or a range change arrives at once rather than crawling across the dial
 * @returns {object} the mutable smoother state
 */
export function createSmoother({ value = 0, tau_s = 0.25, snap = Infinity } = {}) {
  return {
    y: Number.isFinite(value) ? value : 0,
    tau: tau_s > 0 ? tau_s : 0,
    snap: snap > 0 ? snap : Infinity,
    valid: Number.isFinite(value),
  };
}

/**
 * Advance a smoother toward `u` and return its output.
 *
 * A non-finite input HOLDS the last good output rather than propagating. A transmitter that drops
 * out for one scan must leave the needle where it was — the alarm system's job is to say the
 * reading is bad, and a gauge that blanks or slams to zero says something different and worse.
 *
 * @param {object} sm the smoother
 * @param {number} u the raw input
 * @param {number} dt_s the step, s
 * @returns {number} the smoothed output
 */
export function smoothTo(sm, u, dt_s) {
  if (!Number.isFinite(u)) return sm.y;
  if (!sm.valid) { sm.y = u; sm.valid = true; return sm.y; }
  if (Math.abs(u - sm.y) >= sm.snap) { sm.y = u; return sm.y; }
  const dt = Number.isFinite(dt_s) ? Math.max(0, dt_s) : 0;
  // `core/util.js::lag` is the exact discrete pole, which is why the smoother is correct on a
  // two-second frame as well as a sixteen-millisecond one. It is deliberately the same function
  // the physics filters its transmitters with, so "a 0.25 s lag" means one thing in this
  // application and not two.
  sm.y = lag(sm.y, u, sm.tau, dt);
  return sm.y;
}

/**
 * Force a smoother onto a value, clearing its history.
 * @param {object} sm the smoother
 * @param {number} value the new output
 * @returns {void}
 */
export function snapSmoother(sm, value) {
  if (!Number.isFinite(value)) return;
  sm.y = value;
  sm.valid = true;
}

// --------------------------------------------------------------------------------------------
// The digit roll
// --------------------------------------------------------------------------------------------

/**
 * The fraction of a decade over which a wheel rolls to its next digit. Small on purpose: a
 * counter whose every wheel is permanently mid-roll is a counter nobody can read. At 0.12 the
 * units wheel is legible for seven-eighths of its travel and the carry still looks mechanical.
 */
const ROLL_LEAD = 0.12;

/**
 * Compute odometer wheel positions for a value.
 *
 * Each entry is a CONTINUOUS position: its integer part is the digit to draw and its fractional
 * part is how far that digit has rolled toward the next one. The renderer draws digit
 * `floor(p) % 10` offset up by `frac(p)` and digit `(floor(p)+1) % 10` below it.
 *
 * Wheels carry in sequence, not together — the tens wheel only moves while the units wheel is
 * crossing nine — which is what an odometer does and what makes the effect read as a counter
 * rather than as nine independent animations that happen to be in step.
 *
 * The sign is not encoded: the caller draws it. A wheel showing a minus is not a thing.
 *
 * @param {number} value the value; the magnitude is used
 * @param {number} places how many wheels, index 0 being the units
 * @param {number[]|Float64Array} out written from index 0
 * @returns {number} how many positions were written
 */
export function rollDigits(value, places, out) {
  const n = Math.min(Math.max(0, Math.floor(places)), out.length);
  const v = Number.isFinite(value) ? Math.abs(value) : 0;
  for (let p = 0; p < n; p += 1) {
    const pos = v / 10 ** p;
    const base = Math.floor(pos);
    const f = pos - base;
    const roll = f > 1 - ROLL_LEAD ? (f - (1 - ROLL_LEAD)) / ROLL_LEAD : 0;
    out[p] = (base % 10) + roll;
  }
  return n;
}

/**
 * The digit currently showing on a wheel.
 * @param {number} pos a position from {@link rollDigits}
 * @returns {number} a digit, 0..9
 */
export function wheelDigit(pos) {
  return Math.floor(pos) % 10;
}

/**
 * How far a wheel has rolled toward its next digit.
 * @param {number} pos a position from {@link rollDigits}
 * @returns {number} a fraction in [0, 1)
 */
export function wheelFrac(pos) {
  return pos - Math.floor(pos);
}

// --------------------------------------------------------------------------------------------
// Colour
// --------------------------------------------------------------------------------------------

/**
 * Parse a CSS colour into 0..255 components with an alpha in 0..1.
 *
 * Accepts what `getComputedStyle` actually hands back for a custom property in this
 * application — `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, and `rgb()`/`rgba()` in both the legacy
 * comma form and the modern space-and-slash form. Anything else returns `null`, and the caller
 * falls back to a literal it already has, because a view must never throw inside a frame.
 *
 * @param {string} str the colour
 * @param {{r:number,g:number,b:number,a:number}} [out] written in place; allocated if omitted
 * @returns {{r:number,g:number,b:number,a:number}|null} `out`, or null if unparseable
 */
export function parseColor(str, out = { r: 0, g: 0, b: 0, a: 1 }) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (s.charCodeAt(0) === 35) {          // '#'
    const hex = s.slice(1);
    const n = hex.length;
    if (n !== 3 && n !== 4 && n !== 6 && n !== 8) return null;
    const short = n <= 4;
    /**
     * Read one channel out of the hex body.
     * @param {number} i the channel index
     * @returns {number} 0..255, or NaN if the digits were not hex
     */
    const ch = (i) => {
      const t = short ? hex.slice(i, i + 1).repeat(2) : hex.slice(i * 2, i * 2 + 2);
      const v = Number.parseInt(t, 16);
      return /^[0-9a-fA-F]+$/.test(t) ? v : NaN;
    };
    out.r = ch(0); out.g = ch(1); out.b = ch(2);
    out.a = (short ? n === 4 : n === 8) ? ch(3) / 255 : 1;
    if (!Number.isFinite(out.r) || !Number.isFinite(out.g)
      || !Number.isFinite(out.b) || !Number.isFinite(out.a)) return null;
    return out;
  }
  const m = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter((x) => x.length > 0);
  if (parts.length < 3) return null;
  /**
   * Read one numeric component, resolving a percentage against `full`.
   * @param {string} t the token
   * @param {number} full what 100% means
   * @returns {number} the value, or NaN
   */
  const comp = (t, full) => {
    const pct = t.endsWith('%');
    const v = Number.parseFloat(pct ? t.slice(0, -1) : t);
    return pct ? (v / 100) * full : v;
  };
  out.r = comp(parts[0], 255);
  out.g = comp(parts[1], 255);
  out.b = comp(parts[2], 255);
  out.a = parts.length > 3 ? comp(parts[3], 1) : 1;
  if (!Number.isFinite(out.r) || !Number.isFinite(out.g)
    || !Number.isFinite(out.b) || !Number.isFinite(out.a)) return null;
  return out;
}

/**
 * The sRGB electro-optical transfer function: an 0..1 encoded value to linear light.
 * @param {number} c the encoded channel, 0..1
 * @returns {number} linear light, 0..1
 */
function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The inverse transfer function: linear light to an encoded 0..1 value.
 * @param {number} c linear light, 0..1
 * @returns {number} the encoded channel, 0..1
 */
function toEncoded(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Convert an sRGB colour to OKLab.
 *
 * Björn Ottosson's OKLab. It is the space this module does all its colour arithmetic in because
 * its `L` really is perceived lightness and its `a`/`b` really are perceptually uniform: the
 * midpoint of two colours in OKLab looks like the midpoint, which is precisely what sRGB
 * interpolation fails to deliver and why an sRGB green-to-red ramp sags into a dark olive halfway
 * along. In an HMI that sag reads as an alarm state of its own.
 *
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @param {{L:number,a:number,b:number}} [out] written in place
 * @returns {{L:number,a:number,b:number}} `out`
 */
export function srgbToOklab(r, g, b, out = { L: 0, a: 0, b: 0 }) {
  const lr = toLinear(clamp01(r / 255));
  const lg = toLinear(clamp01(g / 255));
  const lb = toLinear(clamp01(b / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out.L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out.a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out.b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return out;
}

/**
 * Convert OKLab back to sRGB, WITHOUT clipping. Used internally by the gamut search below, which
 * needs to know how far outside the cube a colour has fallen.
 * @param {number} L lightness
 * @param {number} a green-red axis
 * @param {number} bb blue-yellow axis
 * @param {{r:number,g:number,b:number}} out written in place, as encoded 0..1 channels
 * @returns {{r:number,g:number,b:number}} `out`
 */
function oklabToEncoded(L, a, bb, out) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  out.r = toEncoded(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  out.g = toEncoded(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  out.b = toEncoded(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  return out;
}

/** How far outside [0, 1] an encoded channel may stray before the gamut search kicks in. */
const GAMUT_SLOP = 1e-4;

/** Iterations of the chroma bisection. 2^-18 of the chroma range is far below a display step. */
const GAMUT_STEPS = 18;

/** Scratch used by the gamut search; this module is single-threaded, so one is enough. */
const gamutScratch = { r: 0, g: 0, b: 0 };

/**
 * Convert OKLab to sRGB, gamut-mapped by reducing chroma at constant lightness and hue.
 *
 * This is the step that makes the ramp's promise true. Naively clipping each channel into [0, 1]
 * changes the colour's LIGHTNESS as well as its saturation — a clipped bright cyan comes back
 * darker — so a ramp built with clipping can still sag in the middle even though the arithmetic
 * that produced it was perceptually uniform. Bisecting on chroma instead preserves `L` exactly,
 * so the guarantee "the midpoint is never darker than both ends" holds by construction rather
 * than by luck.
 *
 * @param {number} L lightness
 * @param {number} a green-red axis
 * @param {number} bb blue-yellow axis
 * @param {{r:number,g:number,b:number}} [out] written in place, as 0..255 channels
 * @returns {{r:number,g:number,b:number}} `out`
 */
export function oklabToSrgb(L, a, bb, out = { r: 0, g: 0, b: 0 }) {
  /**
   * Whether a chroma scale lands inside the sRGB cube.
   * @param {number} k the chroma scale
   * @returns {boolean} true when every channel is in range
   */
  const inGamut = (k) => {
    oklabToEncoded(L, a * k, bb * k, gamutScratch);
    return gamutScratch.r >= -GAMUT_SLOP && gamutScratch.r <= 1 + GAMUT_SLOP
      && gamutScratch.g >= -GAMUT_SLOP && gamutScratch.g <= 1 + GAMUT_SLOP
      && gamutScratch.b >= -GAMUT_SLOP && gamutScratch.b <= 1 + GAMUT_SLOP;
  };
  let k = 1;
  if (!inGamut(1)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < GAMUT_STEPS; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (inGamut(mid)) lo = mid; else hi = mid;
    }
    k = lo;
  }
  oklabToEncoded(L, a * k, bb * k, gamutScratch);
  // An L outside [0, 1] cannot be rescued by chroma alone; the final clamp catches that, and only
  // that, so it can no longer silently darken an in-range colour.
  out.r = Math.round(clamp01(gamutScratch.r) * 255);
  out.g = Math.round(clamp01(gamutScratch.g) * 255);
  out.b = Math.round(clamp01(gamutScratch.b) * 255);
  return out;
}

/** Scratch OKLab values for the two ends of a mix. */
const mixA = { L: 0, a: 0, b: 0 };
const mixB = { L: 0, a: 0, b: 0 };

/**
 * Mix two sRGB colours in OKLab: a straight line through the perceptual space.
 *
 * Use this between colours of similar hue, or wherever a hue path would be a distraction — a
 * dimmed panel edge, a hover tint, a lamp fading up. Between two strongly different hues prefer
 * {@link mixOklch}, which goes AROUND rather than THROUGH the desaturated middle.
 *
 * @param {{r:number,g:number,b:number,a?:number}} c0 the colour at t = 0, channels 0..255
 * @param {{r:number,g:number,b:number,a?:number}} c1 the colour at t = 1
 * @param {number} t the mix fraction, clamped to [0, 1]
 * @param {{r:number,g:number,b:number,a:number}} [out] written in place
 * @returns {{r:number,g:number,b:number,a:number}} `out`
 */
export function mixOklab(c0, c1, t, out = { r: 0, g: 0, b: 0, a: 1 }) {
  const k = clamp01(t);
  srgbToOklab(c0.r, c0.g, c0.b, mixA);
  srgbToOklab(c1.r, c1.g, c1.b, mixB);
  oklabToSrgb(lerp(mixA.L, mixB.L, k), lerp(mixA.a, mixB.a, k), lerp(mixA.b, mixB.b, k), out);
  out.a = lerp(c0.a === undefined ? 1 : c0.a, c1.a === undefined ? 1 : c1.a, k);
  return out;
}

/**
 * Mix two sRGB colours in OKLCh, taking the SHORT way round the hue circle.
 *
 * This is the health-bar mix. A bar running from `--ok` to `--alarm` is asking the operator to
 * read a magnitude off a colour, and every intermediate value must therefore look like an
 * intermediate value. In sRGB the midpoint is a dark olive that reads as its own state; in OKLab
 * it is a desaturated brown; going round the hue circle instead, the ramp passes through amber —
 * which is not a coincidence, it is the colour a control room already uses for "getting worse",
 * arrived at from the geometry rather than chosen.
 *
 * When one end is achromatic it borrows the other's hue instead of interpolating toward an
 * arbitrary one: grey has no hue, and pretending it has zero sends a grey-to-red ramp through
 * pink.
 *
 * @param {{r:number,g:number,b:number,a?:number}} c0 the colour at t = 0, channels 0..255
 * @param {{r:number,g:number,b:number,a?:number}} c1 the colour at t = 1
 * @param {number} t the mix fraction, clamped to [0, 1]
 * @param {{r:number,g:number,b:number,a:number}} [out] written in place
 * @returns {{r:number,g:number,b:number,a:number}} `out`
 */
export function mixOklch(c0, c1, t, out = { r: 0, g: 0, b: 0, a: 1 }) {
  const k = clamp01(t);
  srgbToOklab(c0.r, c0.g, c0.b, mixA);
  srgbToOklab(c1.r, c1.g, c1.b, mixB);
  const C0 = Math.hypot(mixA.a, mixA.b);
  const C1 = Math.hypot(mixB.a, mixB.b);
  const grey = 1e-4;
  const h0 = C0 > grey ? Math.atan2(mixA.b, mixA.a) : (C1 > grey ? Math.atan2(mixB.b, mixB.a) : 0);
  const h1 = C1 > grey ? Math.atan2(mixB.b, mixB.a) : h0;
  const h = h0 + wrapAngle(h1 - h0) * k;   // shortest arc, and never more than half a turn
  const C = lerp(C0, C1, k);
  oklabToSrgb(lerp(mixA.L, mixB.L, k), C * Math.cos(h), C * Math.sin(h), out);
  out.a = lerp(c0.a === undefined ? 1 : c0.a, c1.a === undefined ? 1 : c1.a, k);
  return out;
}

/**
 * Format 0..255 channels as a CSS colour string. ALLOCATES — never call it in a frame loop; use
 * {@link createRamp} and {@link rampCss}, which build their strings once.
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @param {number} [a=1] 0..1
 * @returns {string} `rgb(r, g, b)`, or `rgba(...)` when `a` is below 1
 */
export function formatRgb(r, g, b, a = 1) {
  const R = Math.round(clamp(r, 0, 255));
  const G = Math.round(clamp(g, 0, 255));
  const B = Math.round(clamp(b, 0, 255));
  return a >= 1 ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${clamp01(a).toFixed(3)})`;
}

/**
 * Pre-render a colour ramp to a table of CSS strings.
 *
 * THIS is how a health bar or a heat map gets its colour at 60 fps. Building `rgb(...)` per fill
 * is a string allocation per fill; a hundred bars at sixty frames is six thousand short-lived
 * strings a second, and the collector pauses that produce show up as exactly the stutter this
 * module exists to prevent. Sampling into a fixed table costs one array index per fill and
 * nothing else, and the quantisation is invisible: at 64 steps the largest jump across the whole
 * `--ok` to `--alarm` ramp is under one perceptual unit.
 *
 * Stops arrive as CSS colour strings — the caller has just read them out of `styles/tokens.css`
 * through `getComputedStyle` — and an unparseable one falls back to opaque mid grey rather than
 * throwing, because losing a colour is a cosmetic failure and losing the frame is not.
 *
 * @param {string[]} stops two or more CSS colours, evenly spaced across [0, 1]
 * @param {number} [steps=64] table resolution
 * @param {boolean} [viaHue=true] true mixes in OKLCh ({@link mixOklch}), false in OKLab
 * @returns {object} the ramp: `css` (the strings), `rgb` (a Uint8ClampedArray of triples), `steps`
 */
export function createRamp(stops, steps = 64, viaHue = true) {
  const n = Math.max(2, Math.floor(steps));
  const parsed = [];
  for (const s of stops) {
    const c = parseColor(s);
    parsed.push(c || { r: 128, g: 128, b: 128, a: 1 });
  }
  if (parsed.length === 0) parsed.push({ r: 128, g: 128, b: 128, a: 1 });
  if (parsed.length === 1) parsed.push(parsed[0]);

  const css = new Array(n);
  const rgb = new Uint8ClampedArray(n * 3);
  const mix = viaHue ? mixOklch : mixOklab;
  const tmp = { r: 0, g: 0, b: 0, a: 1 };
  const spans = parsed.length - 1;
  for (let i = 0; i < n; i += 1) {
    const x = i / (n - 1);
    const f = clamp(x * spans, 0, spans);
    const seg = Math.min(spans - 1, Math.floor(f));
    mix(parsed[seg], parsed[seg + 1], f - seg, tmp);
    css[i] = formatRgb(tmp.r, tmp.g, tmp.b, tmp.a);
    rgb[i * 3] = tmp.r;
    rgb[i * 3 + 1] = tmp.g;
    rgb[i * 3 + 2] = tmp.b;
  }
  return { css, rgb, steps: n };
}

/**
 * The CSS string for a position along a ramp. Zero allocation — this is the frame-loop call.
 * @param {object} ramp from {@link createRamp}
 * @param {number} x position, clamped to [0, 1]
 * @returns {string} a CSS colour
 */
export function rampCss(ramp, x) {
  const i = Math.round(clamp01(x) * (ramp.steps - 1));
  return ramp.css[i];
}

/**
 * The 0..255 channels at a position along a ramp, written into `out`.
 * @param {object} ramp from {@link createRamp}
 * @param {number} x position, clamped to [0, 1]
 * @param {{r:number,g:number,b:number}} out written in place
 * @returns {{r:number,g:number,b:number}} `out`
 */
export function rampAt(ramp, x, out) {
  const i = Math.round(clamp01(x) * (ramp.steps - 1)) * 3;
  out.r = ramp.rgb[i];
  out.g = ramp.rgb[i + 1];
  out.b = ramp.rgb[i + 2];
  return out;
}

/**
 * Relative luminance, per WCAG 2.x. Exposed because "is this colour darker than that one" is a
 * question the views and the tests both need to ask, and answering it by eye is how a ramp with a
 * hole in it ships.
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {number} luminance, 0..1
 */
export function luminance(r, g, b) {
  return 0.2126 * toLinear(clamp01(r / 255))
    + 0.7152 * toLinear(clamp01(g / 255))
    + 0.0722 * toLinear(clamp01(b / 255));
}
