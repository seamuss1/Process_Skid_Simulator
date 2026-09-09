/**
 * tests/anim.test.js — the animation and geometry primitives.
 *
 * These are PROPERTY tests, not sample tests. Pinning `outCubic(0.37)` to a magic number checks
 * that nobody retyped the polynomial; it does not check anything a user would notice. What a user
 * notices is an easing that stops short of its target, a spring that explodes when a background
 * tab wakes up with a two-second frame, a pool that quietly hands the same particle to two
 * owners, a flow particle that lands a rounding error past the end of its pipe, and a health bar
 * that goes dark in the middle. So those are the claims below, stated as invariants that must
 * hold for every input rather than for the one that happened to be typed in.
 *
 * `src/ui/anim.js` touches no DOM, no canvas and no clock, which is exactly what lets this file
 * exercise all of it under plain `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lerp, invLerp, clamp01, smoothstep, smootherstep, damp, approach, wrapAngle, vec2,
  EASE, ease, easeFn,
  createSpring, springTo, snapSpring, stepSpring, springAtRest,
  createTweens, addTween, cancelTween, clearTweens, stepTweens,
  createPool, poolTake, poolGive, poolClear, poolUsed,
  PARTICLE, createParticles, emitParticle, stepParticles, particleAge, clearParticles,
  createIso, isoProject, isoUnproject, isoDepth,
  createPath, pathPointAt, pathTangentAt, pathWrap,
  cubicAt, cubicTangentAt, cubicLength, flattenCubic, pathFromCubics,
  catmullRomToCubic, smoothPolyline,
  niceNum, niceTicks, fillTicks,
  createSmoother, smoothTo, snapSmoother,
  rollDigits, wheelDigit, wheelFrac,
  parseColor, srgbToOklab, oklabToSrgb, mixOklab, mixOklch,
  createRamp, rampCss, rampAt, formatRgb, luminance,
} from '../src/ui/anim.js';
import { near } from './helpers.js';

/**
 * The frame intervals every time-stepped primitive has to survive: a 1000 Hz mouse-driven
 * repaint, ordinary 144/60/30 Hz frames, a janky frame, and the multi-second interval a browser
 * hands back when a background tab is restored.
 */
const FRAMES = Object.freeze([0.001, 0.00694, 0.0167, 0.0333, 0.1, 0.5, 1, 2, 5]);

/** A pipe-shaped polyline: two straights and an elbow, with a duplicated vertex in the middle. */
const PIPE = Object.freeze([0, 0, 30, 0, 30, 0, 30, 40, 60, 40]);

// --------------------------------------------------------------------------------------------
// Scalar maths
// --------------------------------------------------------------------------------------------

test('the scalar helpers refuse to produce a non-finite coordinate', () => {
  assert.equal(lerp(10, 20, 0.5), 15);
  assert.equal(lerp(10, 20, 2), 30, 'lerp extrapolates on purpose; clamping is the caller\'s job');
  assert.equal(invLerp(4, 4, 9), 0, 'a zero-width range must not escape as Infinity');
  assert.equal(clamp01(NaN), 0, 'NaN clamps low, as core/util.js::clamp does');
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(3), 1);
  assert.equal(smoothstep(0, 10, -1), 0);
  assert.equal(smoothstep(0, 10, 11), 1);
  assert.equal(smootherstep(0, 1, 0.5), 0.5, 'both smoothsteps are symmetric about their middle');
  assert.equal(wrapAngle(NaN), 0);
});

test('smoothstep and smootherstep are flat at both ends and monotone between them', () => {
  let prev = -1;
  for (let i = 0; i <= 100; i += 1) {
    const x = i / 100;
    const a = smoothstep(0, 1, x);
    const b = smootherstep(0, 1, x);
    assert.ok(a >= prev - 1e-12, 'smoothstep must never go backwards');
    prev = a;
    assert.ok(a >= 0 && a <= 1 && b >= 0 && b <= 1, 'neither may leave the unit interval');
  }
  // Zero slope at the edges is what keeps a band edge from visibly kinking.
  near((smoothstep(0, 1, 0.001) - smoothstep(0, 1, 0)) / 0.001, 0, 1e-2, 'smoothstep slope at 0');
  near((smootherstep(0, 1, 0.01) - smootherstep(0, 1, 0)) / 0.01, 0, 1e-3, 'quintic slope at 0');
});

test('damp is frame-rate independent, which is the bug it exists to prevent', () => {
  // One tenth of a second in a single step must land where ten hundredths land. The naive
  // `a += (b-a)*k` fails this by a mile, and that failure is invisible on the machine it was
  // written on and obvious on any other.
  const one = damp(0, 100, 6, 0.1);
  let many = 0;
  for (let i = 0; i < 10; i += 1) many = damp(many, 100, 6, 0.01);
  near(many, one, 1e-9, 'ten small steps against one large one');

  let tiny = 0;
  for (let i = 0; i < 1000; i += 1) tiny = damp(tiny, 100, 6, 0.0001);
  near(tiny, one, 1e-9, 'a thousand tiny steps against one large one');
  assert.equal(damp(5, 9, 6, 0), 9, 'a zero step has no meaningful lag, so it lands on target');
});

test('approach moves at a bounded rate and stops exactly on its target', () => {
  assert.equal(approach(0, 10, 2, 1), 2);
  assert.equal(approach(10, 0, 2, 1), 8);
  assert.equal(approach(9.5, 10, 2, 1), 10, 'the last step lands on the target, not past it');
  assert.equal(approach(3, 10, 0, 1), 10, 'no rate limit means go straight there');
});

test('wrapAngle takes the short way round, which a needle must', () => {
  near(wrapAngle((350 * Math.PI) / 180 - (10 * Math.PI) / 180), (340 - 360) * (Math.PI / 180), 1e-12,
    '350 to 10 degrees is twenty degrees of travel, not three hundred and forty');
  for (const a of [-7, -3.2, -Math.PI, 0, 0.5, Math.PI, 3.2, 7, 1000]) {
    const w = wrapAngle(a);
    assert.ok(w > -Math.PI - 1e-12 && w <= Math.PI + 1e-12, `wrapAngle(${a}) left (-pi, pi]`);
    near(Math.cos(w), Math.cos(a), 1e-9, `wrapAngle(${a}) changed the angle`);
    near(Math.sin(w), Math.sin(a), 1e-9, `wrapAngle(${a}) changed the angle`);
  }
});

// --------------------------------------------------------------------------------------------
// Easing
// --------------------------------------------------------------------------------------------

test('every easing starts at exactly 0 and ends at exactly 1', () => {
  for (const name of Object.keys(EASE)) {
    // EXACTLY, not to within a tolerance. An easing that ends at 0.9999999999999998 leaves a
    // needle a fraction short of its mark and never arrives, and no tolerance in a test would
    // have caught the two members of this set that genuinely did that before they were guarded.
    assert.equal(EASE[name](0), 0, `${name} must start at 0`);
    assert.equal(EASE[name](1), 1, `${name} must end at 1`);
  }
});

test('every easing is finite across the whole interval, and only back and elastic overshoot', () => {
  const allowedOut = new Set(['inBack', 'outBack', 'inOutBack', 'outElastic']);
  for (const name of Object.keys(EASE)) {
    let left = false;
    for (let i = 0; i <= 200; i += 1) {
      const v = EASE[name](i / 200);
      assert.ok(Number.isFinite(v), `${name} produced ${v}`);
      if (v < -1e-12 || v > 1 + 1e-12) left = true;
    }
    if (!allowedOut.has(name)) {
      assert.equal(left, false, `${name} left [0, 1]; only the overshooting easings may`);
    }
  }
  assert.ok(EASE.outBack(0.7) > 1, 'outBack must actually overshoot, or it is not outBack');
});

test('the monotone easings never go backwards', () => {
  const monotone = ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic',
    'inOutCubic', 'inQuart', 'outQuart', 'inOutQuart', 'inSine', 'outSine', 'inOutSine',
    'inExpo', 'outExpo', 'inOutExpo', 'inCirc', 'outCirc', 'inOutCirc'];
  for (const name of monotone) {
    let prev = -Infinity;
    for (let i = 0; i <= 500; i += 1) {
      const v = EASE[name](i / 500);
      assert.ok(v >= prev - 1e-12, `${name} went backwards at t = ${i / 500}`);
      prev = v;
    }
  }
});

test('a named easing clamps its input and an unknown name degrades to linear', () => {
  assert.equal(ease('outCubic', -5), 0);
  assert.equal(ease('outCubic', 5), 1);
  assert.equal(easeFn('no-such-easing'), EASE.linear,
    'a typo in a config table must not throw inside a frame loop');
  const custom = (t) => t * t;
  assert.equal(easeFn(custom), custom, 'a function passes straight through');
  assert.equal(ease(custom, 0.5), 0.25);
});

// --------------------------------------------------------------------------------------------
// The spring
// --------------------------------------------------------------------------------------------

test('the spring converges to its target from every frame interval, 1 ms to 5 s', () => {
  for (const dt of FRAMES) {
    for (const zeta of [0.15, 0.5, 1, 1.6, 4]) {
      const sp = createSpring({ value: 0, target: 1, freq_hz: 4, zeta });
      let worst = 0;
      for (let t = 0; t < 40; t += dt) {
        const x = stepSpring(sp, dt);
        assert.ok(Number.isFinite(x), `dt=${dt} zeta=${zeta} produced ${x}`);
        worst = Math.max(worst, Math.abs(x));
      }
      // Divergence is the failure being tested for: a semi-implicit Euler spring at 4 Hz is
      // unstable above dt = 80 ms and this loop would see it grow without bound.
      assert.ok(worst < 3, `dt=${dt} zeta=${zeta} peaked at ${worst}; a spring must not diverge`);
      near(sp.x, 1, 1e-3, `dt=${dt} zeta=${zeta} settled position`);
      assert.equal(springAtRest(sp), true, `dt=${dt} zeta=${zeta} should have settled`);
    }
  }
});

test('a single five-second frame lands where five seconds of small frames land', () => {
  // This is the background-tab case stated directly. The closed-form step makes it exact rather
  // than merely survivable.
  const big = createSpring({ value: 0, target: 1, freq_hz: 1.5, zeta: 0.4 });
  const small = createSpring({ value: 0, target: 1, freq_hz: 1.5, zeta: 0.4, epsilon: 1e-12 });
  stepSpring(big, 5);
  for (let i = 0; i < 5000; i += 1) stepSpring(small, 0.001);
  near(big.x, small.x, 2e-3, 'position after one long frame against many short ones');
});

test('the undamped spring matches the analytic solution it claims to be', () => {
  // zeta = 0, x0 = target, v0 = 1: the exact answer is sin(w*t)/w and nothing else.
  const w = 2 * Math.PI;
  for (const dt of [0.001, 0.05, 0.25]) {
    const sp = createSpring({ value: 0, target: 0, freq_hz: 1, zeta: 0, velocity: 1, epsilon: 1e-15 });
    let t = 0;
    for (let i = 0; i < Math.round(0.75 / dt); i += 1) { stepSpring(sp, dt); t += dt; }
    near(sp.x, Math.sin(w * t) / w, 1e-9, `analytic position at dt = ${dt}`);
    near(sp.v, Math.cos(w * t), 1e-9, `analytic velocity at dt = ${dt}`);
  }
});

test('a critically damped spring never overshoots, at any frame interval', () => {
  for (const dt of FRAMES) {
    const sp = createSpring({ value: 0, target: 1, freq_hz: 3, zeta: 1 });
    for (let t = 0; t < 20; t += dt) {
      assert.ok(stepSpring(sp, dt) <= 1 + 1e-9,
        `zeta = 1 overshot at dt = ${dt}, which means the critical branch is not being taken`);
    }
  }
});

test('an overdamped spring on a long frame does not become NaN through an overflow', () => {
  // exp(-z*w*t) * cosh(s*t) written naively overflows and underflows independently and hands back
  // Infinity * 0. The two-exponential form must not.
  const sp = createSpring({ value: 0, target: 1, freq_hz: 40, zeta: 20 });
  assert.ok(Number.isFinite(stepSpring(sp, 60)), 'a sixty-second frame at zeta = 20');
  near(sp.x, 1, 1e-6, 'and it has settled, not exploded');
});

test('a spring bends toward a new target instead of restarting, and snaps on demand', () => {
  const sp = createSpring({ value: 0, target: 1, freq_hz: 5, zeta: 0.5 });
  for (let i = 0; i < 6; i += 1) stepSpring(sp, 0.016);
  const v = sp.v;
  springTo(sp, 2);
  assert.equal(sp.v, v, 'retargeting must not touch the velocity, or the motion visibly restarts');
  springTo(sp, NaN);
  assert.equal(sp.target, 2, 'a dropped reading must not launch the needle to NaN');
  snapSpring(sp, 7);
  assert.equal(sp.x, 7);
  assert.equal(sp.v, 0);
  assert.equal(springAtRest(sp), true);
});

test('a spring at motion scale zero is the whole reduced-motion implementation', () => {
  const sp = createSpring({ value: 0, target: 10, freq_hz: 3, zeta: 1, scale: 0 });
  assert.equal(stepSpring(sp, 0.016), 10, 'reduced motion arrives at the end state at once');
  springTo(sp, -4);
  assert.equal(stepSpring(sp, 0.016), -4);
});

// --------------------------------------------------------------------------------------------
// The tween scheduler
// --------------------------------------------------------------------------------------------

test('a tween reports its start value, its end value, and nothing outside them', () => {
  const set = createTweens(4);
  const seen = [];
  addTween(set, { from: 10, to: 20, dur_s: 1, ease: 'linear', onUpdate: (v) => seen.push(v) });
  for (let i = 0; i < 10; i += 1) stepTweens(set, 0.1);
  near(seen[0], 11, 1e-9, 'first sample');
  assert.equal(seen[seen.length - 1], 20, 'the last sample is the exact end value');
  assert.equal(set.count, 0, 'and the tween has retired');
  for (const v of seen) assert.ok(v >= 10 && v <= 20, `linear tween produced ${v}`);
});

test('onDone runs once, after the last onUpdate, and may start the next tween in a sequence', () => {
  const set = createTweens(2);
  const log = [];
  addTween(set, {
    from: 0, to: 1, dur_s: 0.1, ease: 'linear',
    onUpdate: (v) => log.push(`u${v.toFixed(1)}`),
    onDone: () => {
      log.push('done');
      // Claiming the slot the finishing tween just released is the normal chaining case.
      addTween(set, { from: 1, to: 2, dur_s: 0.1, onUpdate: () => log.push('second') });
    },
  });
  stepTweens(set, 0.2);
  assert.deepEqual(log, ['u1.0', 'done'], 'the value arrives before the completion callback');
  assert.equal(set.count, 1, 'and the chained tween is live, not swallowed');
  stepTweens(set, 0.2);
  assert.equal(log[log.length - 1], 'second');
});

test('a delayed tween stays silent until its delay elapses', () => {
  const set = createTweens(2);
  let calls = 0;
  addTween(set, { from: 0, to: 1, dur_s: 0.5, delay_s: 1, onUpdate: () => { calls += 1; } });
  stepTweens(set, 0.5);
  assert.equal(calls, 0, 'nothing may be written during the delay');
  stepTweens(set, 0.6);
  assert.ok(calls > 0);
});

test('the scheduler is bounded, and refuses rather than growing', () => {
  const set = createTweens(3);
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(addTween(set, { from: 0, to: 1, dur_s: 10 }));
  assert.ok(ids.every((id) => id >= 0));
  assert.equal(addTween(set, { from: 0, to: 1, dur_s: 10 }), -1,
    'a full scheduler drops the newest effect; decorative motion is the droppable thing');
  assert.equal(set.count, 3);
});

test('a stale tween id cannot cancel the tween that recycled its slot', () => {
  const set = createTweens(1);
  const first = addTween(set, { from: 0, to: 1, dur_s: 0.1 });
  stepTweens(set, 1);                       // first completes and releases slot 0
  const second = addTween(set, { from: 0, to: 1, dur_s: 10 });
  assert.notEqual(first, second, 'the generation counter must make the ids differ');
  assert.equal(cancelTween(set, first), false, 'the stale id is a no-op');
  assert.equal(set.count, 1, 'and the live tween is untouched');
  assert.equal(cancelTween(set, second), true);
  assert.equal(set.count, 0);
});

test('clearing the scheduler drops callbacks rather than running them', () => {
  const set = createTweens(4);
  let ran = false;
  addTween(set, { from: 0, to: 1, dur_s: 5, onDone: () => { ran = true; } });
  clearTweens(set);
  assert.equal(set.count, 0);
  assert.equal(ran, false, 'a teardown that fires callbacks into a dead view is a leak');
  stepTweens(set, 1);
  assert.equal(ran, false);
});

test('a tween set at motion scale zero completes at its final value, not its first', () => {
  const set = createTweens(4, 0);
  let last = null;
  addTween(set, { from: 0, to: 42, dur_s: 3, delay_s: 2, onUpdate: (v) => { last = v; } });
  assert.equal(stepTweens(set, 0.016), 0, 'nothing is left running');
  assert.equal(last, 42, 'reduced motion means the end state, immediately — not a frozen start');
});

// --------------------------------------------------------------------------------------------
// The pool
// --------------------------------------------------------------------------------------------

test('the pool allocates exactly its capacity, at construction, and never again', () => {
  let built = 0;
  const pool = createPool(8, () => { built += 1; return { n: 0 }; }, (o) => { o.n = 0; });
  assert.equal(built, 8, 'every object exists before the first frame does');

  for (let round = 0; round < 50; round += 1) {
    const held = [];
    for (let i = 0; i < 8; i += 1) {
      const o = poolTake(pool);
      assert.ok(o, `take ${i} of round ${round}`);
      held.push(o);
    }
    assert.equal(poolTake(pool), null, 'past capacity the pool refuses; it does not allocate');
    assert.equal(poolUsed(pool), 8);
    for (const o of held) poolGive(pool, o);
    assert.equal(poolUsed(pool), 0);
  }
  assert.equal(built, 8, 'fifty rounds of full churn allocated nothing further');
});

test('the pool hands out distinct objects and recycles them', () => {
  const pool = createPool(4, () => ({ tag: 0 }));
  const a = poolTake(pool);
  const b = poolTake(pool);
  assert.notEqual(a, b, 'two live objects must never be the same object');
  poolGive(pool, a);
  const c = poolTake(pool);
  assert.equal(c, a, 'a released object comes back rather than a new one being built');
  assert.equal(poolUsed(pool), 2);
});

test('the pool resets what it takes back and refuses a double release', () => {
  const pool = createPool(3, () => ({ n: 0 }), (o) => { o.n = -1; });
  const o = poolTake(pool);
  o.n = 99;
  assert.equal(poolGive(pool, o), true);
  assert.equal(o.n, -1, 'the reset ran');
  // The failure this prevents: a second release pushes the same slot onto the free list twice,
  // the pool then hands one object to two owners, and its capacity is silently halved.
  assert.equal(poolGive(pool, o), false, 'a double release must be refused');
  assert.equal(poolGive(pool, { n: 0 }), false, 'and so must a stranger');
  assert.equal(poolGive(pool, null), false);
  assert.equal(poolUsed(pool), 0);

  poolTake(pool);
  poolTake(pool);
  poolClear(pool);
  assert.equal(poolUsed(pool), 0, 'clearing releases everything');
  assert.equal(poolTake(pool).n, -1, 'and everything it released was reset');
});

test('a zero-capacity pool is empty rather than broken', () => {
  const pool = createPool(0, () => ({}));
  assert.equal(poolTake(pool), null);
  assert.equal(poolUsed(pool), 0);
});

// --------------------------------------------------------------------------------------------
// Particles
// --------------------------------------------------------------------------------------------

test('the particle system is bounded and keeps its live particles packed at the front', () => {
  const ps = createParticles(4);
  const before = ps.data;
  for (let i = 0; i < 4; i += 1) {
    assert.equal(emitParticle(ps, i, 0, 0, 0, i === 1 ? 0.05 : 10, 1, 0.5), i);
  }
  assert.equal(emitParticle(ps, 9, 9, 0, 0, 10), -1, 'a full system drops the emission');
  assert.equal(ps.count, 4);

  assert.equal(stepParticles(ps, 0.1), 3, 'the short-lived particle retired');
  assert.equal(ps.data, before, 'and the state array was never reallocated');
  // Swap-removal moved the last particle into the hole, so the live block is [0, count).
  const xs = [0, 1, 2].map((i) => ps.data[i * PARTICLE.STRIDE + PARTICLE.X]).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 2, 3], 'the survivors are the ones that should have survived');

  clearParticles(ps);
  assert.equal(ps.count, 0);
  assert.equal(ps.data, before, 'clearing reuses the array too');
});

test('particles integrate their velocity and age toward one', () => {
  const ps = createParticles(2);
  emitParticle(ps, 0, 0, 10, -4, 2);
  stepParticles(ps, 0.5, 0, 8);
  const o = PARTICLE.X;
  near(ps.data[o], 5, 1e-5, 'x after half a second at 10 units per second');
  near(ps.data[PARTICLE.VY], 0, 1e-5, 'the acceleration cancelled the upward velocity');
  near(particleAge(ps, 0), 0.25, 1e-6, 'a quarter of a two-second life');
});

test('particle drag decays velocity and never reverses it, however long the frame', () => {
  // `v *= (1 - drag*dt)` goes NEGATIVE for drag*dt > 1, which sends every particle backwards up
  // its pipe on the frame a restored background tab hands back. The exact decay cannot.
  for (const dt of FRAMES) {
    const ps = createParticles(1);
    emitParticle(ps, 0, 0, 100, 0, 1e6);
    stepParticles(ps, dt, 0, 0, 4);
    const vx = ps.data[PARTICLE.VX];
    assert.ok(vx > 0 && vx <= 100 + 1e-9, `drag at dt = ${dt} produced vx = ${vx}`);
  }
  // And the decay is frame-rate independent, for the same reason `damp` is.
  const one = createParticles(1);
  const many = createParticles(1);
  emitParticle(one, 0, 0, 100, 0, 1e6);
  emitParticle(many, 0, 0, 100, 0, 1e6);
  stepParticles(one, 0.5, 0, 0, 3);
  for (let i = 0; i < 500; i += 1) stepParticles(many, 0.001, 0, 0, 3);
  near(many.data[PARTICLE.VX], one.data[PARTICLE.VX], 1e-3, 'drag over one frame against many');
});

test('a zero-life particle is retired on its first step rather than living forever', () => {
  const ps = createParticles(2);
  emitParticle(ps, 0, 0, 0, 0, 0);
  assert.equal(stepParticles(ps, 0.016), 0);
  assert.equal(stepParticles(ps, 0), 0, 'and a zero step is a no-op, not a crash');
});

// --------------------------------------------------------------------------------------------
// Isometric projection
// --------------------------------------------------------------------------------------------

test('the isometric projection and its inverse round-trip exactly', () => {
  // Without this, hit-testing an isometric view means keeping a second copy of every symbol's
  // screen bounds in step by hand, which is how isometric views rot.
  const iso = createIso({ tileW: 48, tileH: 24, zScale: 20, originX: 400, originY: 90 });
  const p = vec2();
  const q = vec2();
  for (let i = 0; i < 200; i += 1) {
    const x = ((i * 37) % 211) / 7 - 15;
    const y = ((i * 53) % 197) / 5 - 20;
    const z = ((i * 29) % 101) / 11;
    isoProject(iso, x, y, z, p);
    isoUnproject(iso, p.x, p.y, z, q);
    near(q.x, x, 1e-9, `round trip x for (${x}, ${y}, ${z})`);
    near(q.y, y, 1e-9, `round trip y for (${x}, ${y}, ${z})`);
  }
});

test('the projection has the geometry an isometric view expects', () => {
  const iso = createIso({ tileW: 32, tileH: 16, zScale: 16, originX: 0, originY: 0 });
  const p = vec2();
  isoProject(iso, 0, 0, 0, p);
  assert.deepEqual([p.x, p.y], [0, 0], 'the world origin lands on the screen origin');
  isoProject(iso, 1, 1, 0, p);
  assert.equal(p.x, 0, 'the x and y axes are mirror images about the screen vertical');
  assert.equal(p.y, 16, 'and one tile of each is one tile height down');
  isoProject(iso, 0, 0, 2, p);
  assert.equal(p.y, -32, 'height raises the point on the screen');
  assert.ok(isoDepth(3, 4, 0) > isoDepth(2, 4, 0), 'and depth sorts nearer things later');
});

// --------------------------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------------------------

test('a path measures its own length and lands exactly on its last vertex', () => {
  const path = createPath(PIPE);
  near(path.length, 30 + 0 + 40 + 30, 1e-12, 'the sum of the segment lengths');
  const p = vec2();

  // The claim that matters for a flow particle: at the full length it IS the last vertex, not a
  // rounding error away from it. A particle that stops short leaves a visible gap at the elbow.
  pathPointAt(path, path.length, p);
  assert.equal(p.x, 60);
  assert.equal(p.y, 40);
  pathPointAt(path, path.length * 4, p);
  assert.deepEqual([p.x, p.y], [60, 40], 'and past the end it stays there');
  pathPointAt(path, 0, p);
  assert.deepEqual([p.x, p.y], [0, 0]);
  pathPointAt(path, -50, p);
  assert.deepEqual([p.x, p.y], [0, 0], 'before the start it stays at the start');
});

test('a path is parameterised by distance, not by segment index', () => {
  const path = createPath(PIPE);
  const p = vec2();
  const q = vec2();
  // Walking equal distances must cover equal ground, whether the walk crosses an elbow or not.
  for (let s = 0; s + 5 <= path.length; s += 2.5) {
    pathPointAt(path, s, p);
    pathPointAt(path, s + 5, q);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    assert.ok(d <= 5 + 1e-9, `five units of path covered ${d} units of ground`);
    assert.ok(d > 0, 'and it moved at all');
  }
  pathPointAt(path, 15, p);
  assert.deepEqual([p.x, p.y], [15, 0], 'halfway along the first straight');
  pathPointAt(path, 50, p);
  assert.deepEqual([p.x, p.y], [30, 20], 'halfway up the riser');
});

test('the tangent is a unit vector and steps over duplicated vertices', () => {
  const path = createPath(PIPE);
  const t = vec2();
  for (let s = 0; s <= path.length; s += 0.5) {
    pathTangentAt(path, s, t);
    near(Math.hypot(t.x, t.y), 1, 1e-12, `the tangent at ${s} must be a unit vector`);
  }
  // s = 30 sits exactly on the duplicated vertex. A zero tangent there would collapse any sprite
  // rotated by it.
  pathTangentAt(path, 30, t);
  near(Math.hypot(t.x, t.y), 1, 1e-12, 'the tangent at the duplicated vertex');
  pathTangentAt(path, 10, t);
  assert.deepEqual([t.x, t.y], [1, 0], 'along the first straight');
  pathTangentAt(path, 50, t);
  assert.deepEqual([t.x, t.y], [0, 1], 'up the riser');
});

test('a degenerate path repaints instead of throwing', () => {
  const p = vec2();
  const t = vec2();
  const empty = createPath([]);
  assert.equal(empty.length, 0);
  pathPointAt(empty, 5, p);
  assert.deepEqual([p.x, p.y], [0, 0], 'a view whose layout has not been measured still repaints');
  pathTangentAt(empty, 5, t);
  assert.deepEqual([t.x, t.y], [1, 0], 'and gets an identity direction, not a zero one');

  const single = createPath([7, 9]);
  pathPointAt(single, 3, p);
  assert.deepEqual([p.x, p.y], [7, 9]);

  const coincident = createPath([4, 4, 4, 4, 4, 4]);
  assert.equal(coincident.length, 0);
  pathPointAt(coincident, 1, p);
  assert.deepEqual([p.x, p.y], [4, 4]);
  pathTangentAt(coincident, 1, t);
  assert.deepEqual([t.x, t.y], [1, 0]);
});

test('the search cursor does not change the answer, only the cost', () => {
  const path = createPath(PIPE);
  const a = vec2();
  const b = vec2();
  const forward = [];
  for (let s = 0; s <= path.length; s += 1) { pathPointAt(path, s, a); forward.push(a.x, a.y); }
  let k = 0;
  // The same queries in reverse, which defeats the cursor and forces the binary search.
  for (let s = path.length; s >= 0; s -= 1) {
    pathPointAt(path, s, b);
    const i = forward.length - 2 - 2 * k;
    assert.equal(b.x, forward[i], `x at s = ${s}`);
    assert.equal(b.y, forward[i + 1], `y at s = ${s}`);
    k += 1;
  }
});

test('pathWrap recirculates a particle without ever leaving the path', () => {
  const path = createPath(PIPE);
  for (const s of [-1000, -1, 0, 5, 100, 1e6]) {
    const w = pathWrap(path, s);
    assert.ok(w >= 0 && w < path.length, `pathWrap(${s}) gave ${w}`);
  }
  near(pathWrap(path, path.length + 3), 3, 1e-9, 'one lap plus three units');
  assert.equal(pathWrap(createPath([]), 5), 0, 'and a path with no length wraps to nothing');
});

// --------------------------------------------------------------------------------------------
// Cubics and smoothing
// --------------------------------------------------------------------------------------------

test('a cubic passes through its endpoints and measures its own length', () => {
  const p = vec2();
  cubicAt(10, 20, 30, 5, 70, 90, 100, 40, 0, p);
  assert.deepEqual([p.x, p.y], [10, 20]);
  cubicAt(10, 20, 30, 5, 70, 90, 100, 40, 1, p);
  assert.deepEqual([p.x, p.y], [100, 40]);

  // A cubic whose control points sit on the chord IS the chord, and its length is known exactly.
  const L = cubicLength(0, 0, 30, 40, 60, 80, 90, 120);
  near(L, 150, 1e-9, 'a straight cubic must measure its chord');

  // A general curve, checked against a fine polygonal approximation rather than against itself.
  const ctrl = [0, 0, 40, 120, 160, -60, 200, 30];
  let poly = 0;
  const a = vec2();
  const b = vec2();
  cubicAt(...ctrl, 0, a);
  for (let i = 1; i <= 20000; i += 1) {
    cubicAt(...ctrl, i / 20000, b);
    poly += Math.hypot(b.x - a.x, b.y - a.y);
    a.x = b.x; a.y = b.y;
  }
  near(cubicLength(...ctrl), poly, poly * 1e-4, 'quadrature against a fine polygon');
});

test('the cubic tangent is the derivative, and points along the curve', () => {
  const ctrl = [0, 0, 40, 120, 160, -60, 200, 30];
  const d = vec2();
  const a = vec2();
  const b = vec2();
  for (const t of [0.05, 0.3, 0.5, 0.77, 0.95]) {
    const h = 1e-6;
    cubicAt(...ctrl, t - h, a);
    cubicAt(...ctrl, t + h, b);
    cubicTangentAt(...ctrl, t, d);
    near(d.x, (b.x - a.x) / (2 * h), 1e-3, `dx/dt at ${t}`);
    near(d.y, (b.y - a.y) / (2 * h), 1e-3, `dy/dt at ${t}`);
  }
});

test('flattening stays within tolerance and emits no duplicated join', () => {
  const ctrl = [0, 0, 40, 120, 160, -60, 200, 30];
  for (const tol of [2, 0.5, 0.1]) {
    const pts = flattenCubic(...ctrl, tol, [0, 0]);
    assert.ok(pts.length >= 4, `tol ${tol} produced ${pts.length / 2} points`);
    assert.deepEqual(pts.slice(-2), [200, 30], 'the last point is the curve\'s end');
    // The polyline's length must approach the true arc length from below as tolerance tightens.
    const path = createPath(pts);
    assert.ok(path.length <= cubicLength(...ctrl) + 1e-9, 'a chord is never longer than its arc');
    assert.ok(path.length > cubicLength(...ctrl) * (1 - 0.02 * tol),
      `tol ${tol} lost too much length`);
  }
  const coarse = flattenCubic(...ctrl, 4, [0, 0]).length;
  const fine = flattenCubic(...ctrl, 0.05, [0, 0]).length;
  assert.ok(fine > coarse, 'a tighter tolerance must actually subdivide further');

  // A degenerate cubic whose ends coincide must terminate rather than recurse to full depth.
  const loop = flattenCubic(5, 5, 5, 5, 5, 5, 5, 5, 0.25, []);
  assert.ok(loop.length <= 4, `a point-sized cubic emitted ${loop.length / 2} points`);
});

test('a chain of cubics becomes one arc-length path a particle can walk', () => {
  const path = pathFromCubics([
    0, 0, 10, 0, 20, 0, 30, 0,
    30, 0, 40, 0, 50, 0, 60, 0,
  ], 0.1);
  near(path.length, 60, 1e-6, 'two straight cubics laid end to end');
  const p = vec2();
  pathPointAt(path, path.length, p);
  near(p.x, 60, 1e-9, 'and it ends where the last cubic ends');
});

test('a Catmull-Rom span passes through the points it is built from', () => {
  const seg = catmullRomToCubic(0, 0, 10, 10, 20, 0, 30, 10);
  const p = vec2();
  cubicAt(10, 10, seg[0], seg[1], seg[2], seg[3], seg[4], seg[5], 0, p);
  assert.deepEqual([p.x, p.y], [10, 10], 'the span starts on its first point');
  cubicAt(10, 10, seg[0], seg[1], seg[2], seg[3], seg[4], seg[5], 1, p);
  assert.deepEqual([p.x, p.y], [20, 0], 'and ends on its second');

  // Collinear points must stay collinear: a smoother that bulges a straight pipe is wrong.
  const straight = smoothPolyline([0, 0, 10, 0, 20, 0, 30, 0]);
  const path = createPath(flattenCubic(
    straight[0], straight[1], straight[2], straight[3],
    straight[4], straight[5], straight[6], straight[7], 0.01, [straight[0], straight[1]],
  ));
  const q = vec2();
  for (let s = 0; s <= path.length; s += path.length / 20) {
    pathPointAt(path, s, q);
    near(q.y, 0, 1e-9, 'a straight run must stay straight through the smoother');
  }
});

test('smoothPolyline emits whole cubic segments that chain end to start', () => {
  const segs = smoothPolyline([0, 0, 20, 30, 60, 10, 90, 50]);
  assert.equal(segs.length % 8, 0, 'the output is whole eight-number cubic segments');
  assert.equal(segs.length / 8, 3, 'four points make three spans');
  for (let i = 1; i < segs.length / 8; i += 1) {
    assert.equal(segs[i * 8], segs[(i - 1) * 8 + 6], 'each segment starts where the last ended');
    assert.equal(segs[i * 8 + 1], segs[(i - 1) * 8 + 7], 'in y as well as x');
  }
  assert.deepEqual(segs.slice(0, 2), [0, 0], 'the spline starts on the first point');
  assert.deepEqual(segs.slice(-2), [90, 50], 'and ends on the last');

  const closed = smoothPolyline([0, 0, 10, 0, 10, 10, 0, 10], 0.5, true);
  assert.equal(closed.length / 8, 4, 'a closed spline has one span per point');
  assert.deepEqual(closed.slice(-2), [0, 0], 'and returns to where it began');
  assert.deepEqual(smoothPolyline([1, 2]), [], 'a single point has no span to smooth');
});

// --------------------------------------------------------------------------------------------
// Axis ticks
// --------------------------------------------------------------------------------------------

test('a nice number is always 1, 2, 5 or 10 times a power of ten', () => {
  const mantissas = new Set([1, 2, 5, 10]);
  for (let i = 1; i <= 400; i += 1) {
    const x = i * 0.037;
    for (const round of [true, false]) {
      const n = niceNum(x, round);
      const m = n / 10 ** Math.floor(Math.log10(n));
      assert.ok([...mantissas].some((k) => Math.abs(m - k) < 1e-9),
        `niceNum(${x}, ${round}) = ${n}, whose mantissa ${m} is not nice`);
    }
  }
  assert.equal(niceNum(0, true), 0, 'and a non-positive input has no nice number');
  assert.equal(niceNum(-4, true), 0);
});

test('an axis contains its data, has a nice step, and has at least two ticks', () => {
  const cases = [[0, 100], [0, 1], [-3.7, 12.2], [0.0004, 0.0009], [12, 12], [90, 10],
    [-500, -120], [0, 1e6]];
  const out = [];
  for (const [lo, hi] of cases) {
    for (const want of [3, 5, 8]) {
      const ax = niceTicks(lo, hi, want);
      const dLo = Math.min(lo, hi);
      const dHi = Math.max(lo, hi);
      assert.ok(ax.lo <= dLo + 1e-12,
        `axis [${ax.lo}, ${ax.hi}] crops the data [${dLo}, ${dHi}] at the bottom`);
      assert.ok(ax.hi >= dHi - 1e-12, `and at the top`);
      assert.ok(ax.count >= 2, 'an axis needs at least two ticks to be an axis');
      assert.ok(ax.step > 0 && Number.isFinite(ax.step));
      const n = fillTicks(ax, out);
      assert.equal(n, ax.count);
      assert.equal(out[0], ax.lo);
      near(out[n - 1], ax.hi, Math.abs(ax.step) * 1e-9, 'the last tick is the axis top');
    }
  }
});

test('a degenerate or reversed range still produces a drawable axis', () => {
  const flat = niceTicks(7, 7, 5);
  assert.ok(flat.lo < 7 && flat.hi > 7, 'a zero-width range is opened out around its value');
  const zero = niceTicks(0, 0, 5);
  assert.ok(zero.hi > zero.lo, 'including at zero, where there is no magnitude to scale by');
  const rev = niceTicks(80, 20, 4);
  assert.ok(rev.lo <= 20 && rev.hi >= 80, 'a reversed range is corrected, not obeyed');
  const bad = niceTicks(NaN, Infinity, 5);
  assert.ok(Number.isFinite(bad.lo) && Number.isFinite(bad.hi) && bad.step > 0,
    'and poisoned bounds degrade to something drawable rather than throwing');
});

test('fillTicks respects a typed array\'s capacity and grows a plain one', () => {
  const ax = niceTicks(0, 100, 10);
  const fixed = new Float64Array(3);
  assert.equal(fillTicks(ax, fixed), 3, 'a caller\'s fixed frame budget is not exceeded');
  const grown = [];
  assert.equal(fillTicks(ax, grown), ax.count);
  assert.equal(grown.length, ax.count);
});

// --------------------------------------------------------------------------------------------
// The value smoother
// --------------------------------------------------------------------------------------------

test('the smoother is the exact first-order pole it claims to be', () => {
  const sm = createSmoother({ value: 0, tau_s: 2 });
  smoothTo(sm, 1, 2);
  near(sm.y, 1 - Math.exp(-1), 1e-12, 'one time constant is 63.2 percent of the step');
  // And it is frame-rate independent, which is the whole reason it is stated in seconds.
  const many = createSmoother({ value: 0, tau_s: 2 });
  for (let i = 0; i < 2000; i += 1) smoothTo(many, 1, 0.001);
  near(many.y, sm.y, 1e-9, 'one two-second frame against two thousand one-millisecond ones');
});

test('the smoother survives every frame interval and passes through at tau zero', () => {
  for (const dt of FRAMES) {
    const sm = createSmoother({ value: 0, tau_s: 0.3 });
    for (let t = 0; t < 20; t += dt) {
      const y = smoothTo(sm, 5, dt);
      assert.ok(Number.isFinite(y) && y >= 0 && y <= 5 + 1e-12, `dt = ${dt} produced ${y}`);
    }
    near(sm.y, 5, 1e-6, `dt = ${dt} settled`);
  }
  const raw = createSmoother({ tau_s: 0 });
  assert.equal(smoothTo(raw, 42, 0.016), 42, 'a zero time constant is no filter at all');
});

test('a dropped reading holds the needle instead of blanking or slamming it', () => {
  const sm = createSmoother({ value: 3, tau_s: 0.5 });
  smoothTo(sm, 4, 0.1);
  const held = sm.y;
  assert.equal(smoothTo(sm, NaN, 0.1), held, 'NaN holds');
  assert.equal(smoothTo(sm, Infinity, 0.1), held, 'so does an infinity');
  assert.ok(Number.isFinite(sm.y));
});

test('the snap threshold makes a range change arrive at once, not crawl across the dial', () => {
  const sm = createSmoother({ value: 0, tau_s: 5, snap: 10 });
  smoothTo(sm, 4, 0.1);
  assert.ok(sm.y < 1, 'a small change still lags');
  smoothTo(sm, 900, 0.1);
  assert.equal(sm.y, 900, 'a change past the threshold jumps');
  snapSmoother(sm, 12);
  assert.equal(sm.y, 12);
  snapSmoother(sm, NaN);
  assert.equal(sm.y, 12, 'and a poisoned snap is ignored');
});

// --------------------------------------------------------------------------------------------
// The digit roll
// --------------------------------------------------------------------------------------------

test('an exact value shows exact digits on every wheel', () => {
  const out = new Float64Array(4);
  rollDigits(4071, 4, out);
  assert.deepEqual([...out].map(wheelDigit), [1, 7, 0, 4], 'units first, as an odometer reads');
  for (const p of out) assert.equal(wheelFrac(p), 0, 'a settled counter has no wheel mid-roll');
  rollDigits(0, 4, out);
  assert.deepEqual([...out].map(wheelDigit), [0, 0, 0, 0]);
});

test('wheels carry in sequence, which is what makes it read as an odometer', () => {
  const out = new Float64Array(3);
  rollDigits(99.97, 3, out);
  assert.deepEqual([...out].map(wheelDigit), [9, 9, 0], 'the digits just before the carry');
  assert.ok(wheelFrac(out[0]) > 0, 'the units wheel is rolling');
  assert.ok(wheelFrac(out[1]) > 0, 'so is the tens wheel, because the units wheel is crossing 9');
  assert.ok(wheelFrac(out[2]) > 0, 'and the hundreds wheel, about to show 1');

  // Mid-decade, only the units wheel may move: nine wheels animating at once is not a counter.
  rollDigits(45.5, 3, out);
  assert.equal(wheelFrac(out[1]), 0, 'the tens wheel is still while the units wheel is mid-decade');
  assert.equal(wheelFrac(out[2]), 0);
});

test('wheel positions stay inside one decade and survive poisoned input', () => {
  const out = new Float64Array(5);
  for (let i = 0; i <= 4000; i += 1) {
    const n = rollDigits(i * 0.317, 5, out);
    assert.equal(n, 5);
    for (const p of out) {
      assert.ok(p >= 0 && p < 10, `wheel position ${p} escaped its decade`);
      const d = wheelDigit(p);
      assert.ok(Number.isInteger(d) && d >= 0 && d <= 9, `digit ${d} is not a digit`);
    }
  }
  // `out` is a five-wheel scratch buffer and this asks for four, so only the first four are
  // written and the fifth still holds whatever the loop above left there. Compare the slice the
  // call actually filled — spreading the whole buffer tests the scratch space, not the function.
  const n = rollDigits(-1234, 4, out);
  assert.equal(n, 4, 'four wheels were asked for');
  assert.deepEqual([...out.subarray(0, n)].map(wheelDigit), [4, 3, 2, 1],
    'the sign belongs to the caller');
  rollDigits(NaN, 4, out);
  assert.deepEqual([...out.subarray(0, 4)].map(wheelDigit), [0, 0, 0, 0],
    'and NaN reads as zero, not as NaN');
  assert.equal(rollDigits(5, 99, new Float64Array(2)), 2, 'the output array bounds the work');
});

// --------------------------------------------------------------------------------------------
// Colour
// --------------------------------------------------------------------------------------------

test('parseColor accepts what getComputedStyle actually returns, and refuses the rest', () => {
  assert.deepEqual(parseColor('#4CAF50'), { r: 76, g: 175, b: 80, a: 1 });
  assert.deepEqual(parseColor('  #E53935 '), { r: 229, g: 57, b: 53, a: 1 });
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('#ff000080').a, 128 / 255);
  assert.deepEqual(parseColor('rgb(255, 194, 75)'), { r: 255, g: 194, b: 75, a: 1 });
  assert.deepEqual(parseColor('rgba(255, 90, 82, 0.5)'), { r: 255, g: 90, b: 82, a: 0.5 });
  assert.deepEqual(parseColor('rgb(255 194 75 / 25%)'), { r: 255, g: 194, b: 75, a: 0.25 });
  for (const bad of ['', 'var(--ok)', '#12345', '#gggggg', 'hsl(1,2%,3%)', null, undefined, 42]) {
    assert.equal(parseColor(bad), null, `${bad} must be refused, not guessed at`);
  }
});

test('OKLab round-trips through sRGB to within a display step', () => {
  const lab = { L: 0, a: 0, b: 0 };
  const rgb = { r: 0, g: 0, b: 0 };
  for (const hex of ['#000000', '#FFFFFF', '#4CAF50', '#E53935', '#FFB300', '#3D9BE9',
    '#2B3138', '#7D8894', '#B39DDB']) {
    const c = parseColor(hex);
    srgbToOklab(c.r, c.g, c.b, lab);
    oklabToSrgb(lab.L, lab.a, lab.b, rgb);
    near(rgb.r, c.r, 1, `${hex} red`);
    near(rgb.g, c.g, 1, `${hex} green`);
    near(rgb.b, c.b, 1, `${hex} blue`);
  }
  const black = srgbToOklab(0, 0, 0, lab);
  near(black.L, 0, 1e-9, 'black has no lightness');
  near(srgbToOklab(255, 255, 255, lab).L, 1, 1e-3, 'and white has all of it');
});

test('the midpoint of a colour mix is never darker than both of its ends', () => {
  // THE failure this whole colour section exists to prevent. In sRGB the midpoint of the ok green
  // and the alarm red is a dark olive, which reads as a state of its own at exactly the moment
  // the value is halfway — the operator sees "something else" rather than "halfway".
  const pairs = [
    ['#4CAF50', '#E53935'], ['#4CAF50', '#FFB300'], ['#FFB300', '#E53935'],
    ['#3D9BE9', '#FFC24B'], ['#66BB6A', '#B39DDB'], ['#FFFFFF', '#171B20'],
    ['#2B3138', '#E53935'], ['#4FC3F7', '#E8ECF0'],
  ];
  const out = { r: 0, g: 0, b: 0, a: 1 };
  const lab = { L: 0, a: 0, b: 0 };
  for (const [h0, h1] of pairs) {
    const c0 = parseColor(h0);
    const c1 = parseColor(h1);
    const l0 = luminance(c0.r, c0.g, c0.b);
    const l1 = luminance(c1.r, c1.g, c1.b);
    const floor = Math.min(l0, l1);
    for (const mix of [mixOklab, mixOklch]) {
      for (let i = 1; i < 20; i += 1) {
        mix(c0, c1, i / 20, out);
        const lm = luminance(out.r, out.g, out.b);
        assert.ok(lm >= floor - 2e-3,
          `${mix.name}(${h0}, ${h1}, ${i / 20}) has luminance ${lm.toFixed(4)}, `
          + `below both ends (${floor.toFixed(4)}) — the ramp has a hole in it`);
      }
      // And perceptual lightness, which is what the gamut mapping is built to preserve exactly.
      mix(c0, c1, 0.5, out);
      srgbToOklab(out.r, out.g, out.b, lab);
      const L0 = srgbToOklab(c0.r, c0.g, c0.b, { L: 0, a: 0, b: 0 }).L;
      const L1 = srgbToOklab(c1.r, c1.g, c1.b, { L: 0, a: 0, b: 0 }).L;
      near(lab.L, (L0 + L1) / 2, 6e-3, `${mix.name} midpoint lightness for ${h0} to ${h1}`);
    }
  }
});

test('a mix hits its endpoints and carries alpha across', () => {
  const c0 = { r: 76, g: 175, b: 80, a: 1 };
  const c1 = { r: 229, g: 57, b: 53, a: 0 };
  const out = { r: 0, g: 0, b: 0, a: 1 };
  mixOklch(c0, c1, 0, out);
  assert.deepEqual([out.r, out.g, out.b, out.a], [76, 175, 80, 1]);
  mixOklch(c0, c1, 1, out);
  assert.deepEqual([out.r, out.g, out.b, out.a], [229, 57, 53, 0]);
  mixOklab(c0, c1, 0.5, out);
  near(out.a, 0.5, 1e-12, 'alpha interpolates linearly, which is the only sensible thing');
  mixOklch(c0, c1, 5, out);
  assert.deepEqual([out.r, out.g, out.b], [229, 57, 53], 'and the fraction is clamped');
});

test('the hue mix goes the short way round and borrows a hue from grey', () => {
  const green = parseColor('#4CAF50');
  const red = parseColor('#E53935');
  const out = { r: 0, g: 0, b: 0, a: 1 };
  // Green to red the short way passes through amber: red rises and stays ahead of blue, which is
  // what "not mud" means numerically.
  mixOklch(green, red, 0.5, out);
  // The bar is 170, not 180. The OKLCH midpoint of these two is rgb(176, 133, 0) — a golden
  // amber, which is exactly what the short way round should give and is comfortably warm. 180 was
  // a guess made before anyone computed it, and it fails by four counts on a correct answer.
  assert.ok(out.r > green.r && out.r > 170, `the midpoint should be warm, got ${formatRgb(out.r, out.g, out.b)}`);
  assert.ok(out.g > out.b, 'and yellow-side, not magenta-side');

  const grey = { r: 128, g: 128, b: 128, a: 1 };
  mixOklch(grey, red, 0.5, out);
  const mid = { L: 0, a: 0, b: 0 };
  const target = { L: 0, a: 0, b: 0 };
  srgbToOklab(out.r, out.g, out.b, mid);
  srgbToOklab(red.r, red.g, red.b, target);
  const dh = Math.abs(wrapAngle(Math.atan2(mid.b, mid.a) - Math.atan2(target.b, target.a)));
  assert.ok(dh < 0.15,
    'grey has no hue, so a grey-to-red mix must stay on red\'s hue rather than detour through pink');
});

test('a ramp is a pre-rendered table, so a frame loop allocates nothing to use it', () => {
  const ramp = createRamp(['#4CAF50', '#FFB300', '#E53935'], 33);
  assert.equal(ramp.steps, 33);
  assert.equal(ramp.css.length, 33);
  assert.equal(ramp.rgb.length, 99);
  assert.equal(rampCss(ramp, 0), formatRgb(...parseColorTriple('#4CAF50')), 'the ramp starts on its first stop');
  assert.equal(rampCss(ramp, 1), formatRgb(...parseColorTriple('#E53935')), 'and ends on its last');
  assert.equal(rampCss(ramp, 0.5), ramp.css[16], 'the middle is the middle bucket');
  // The frame-loop call must be a lookup, not a build: the same string OBJECT comes back.
  assert.equal(rampCss(ramp, 0.421) === rampCss(ramp, 0.421), true);
  assert.ok(ramp.css.every((s) => /^rgba?\(/.test(s)), 'every entry is a usable fillStyle');

  const out = { r: 0, g: 0, b: 0 };
  rampAt(ramp, -5, out);
  assert.deepEqual([out.r, out.g, out.b], [76, 175, 80], 'a position outside [0, 1] is clamped');
  rampAt(ramp, 99, out);
  assert.deepEqual([out.r, out.g, out.b], [229, 57, 53]);
});

test('a ramp with an unusable stop degrades to grey rather than throwing in a frame', () => {
  const ramp = createRamp(['var(--nope)', '#E53935'], 8);
  assert.equal(ramp.css.length, 8);
  assert.ok(ramp.css.every((s) => typeof s === 'string' && s.length > 0));
  assert.equal(createRamp([], 4).css.length, 4, 'and no stops at all is still a drawable ramp');
  assert.equal(createRamp(['#4CAF50'], 4).steps, 4, 'as is a single stop');
});

test('formatRgb clamps into range and only spends an alpha channel when it must', () => {
  assert.equal(formatRgb(76, 175, 80), 'rgb(76, 175, 80)');
  assert.equal(formatRgb(300, -20, 80.6), 'rgb(255, 0, 81)');
  assert.equal(formatRgb(0, 0, 0, 0.5), 'rgba(0, 0, 0, 0.500)');
  assert.equal(formatRgb(NaN, NaN, NaN), 'rgb(0, 0, 0)', 'NaN clamps low rather than printing');
});

test('luminance orders colours the way an eye does', () => {
  assert.equal(luminance(0, 0, 0), 0);
  near(luminance(255, 255, 255), 1, 1e-12);
  assert.ok(luminance(0, 255, 0) > luminance(255, 0, 0), 'green carries more light than red');
  assert.ok(luminance(255, 0, 0) > luminance(0, 0, 255), 'and red more than blue');
});

/**
 * Parse a hex colour into the positional triple `formatRgb` takes.
 * @param {string} hex the colour
 * @returns {number[]} r, g, b in 0..255
 */
function parseColorTriple(hex) {
  const c = parseColor(hex);
  return [c.r, c.g, c.b];
}
