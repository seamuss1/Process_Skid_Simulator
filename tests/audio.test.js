/**
 * tests/audio.test.js — the sound layer.
 *
 * There is no Web Audio in Node, which is exactly the first thing worth guaranteeing: the module
 * ships in a runtime where its whole reason for existing is absent, and it has to be inert there
 * rather than defensive. So the tests come in three environments —
 *
 *   1. no factory at all, the Node case and the pre-gesture browser case;
 *   2. a factory that throws, the case where the browser has Web Audio and refuses to hand it over;
 *   3. a hand-written fake context that records every node, connection and scheduled event, which
 *      is the only way to make claims about WHAT was built rather than merely that nothing broke.
 *
 * The fake is deliberately minimal and slightly hostile: it implements exactly the API surface the
 * module is allowed to rely on and nothing else, so a future edit that reaches for
 * `createBufferSource` or `decodeAudioData` fails here rather than in a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOUNDS, createAudio, play, setEnabled, isEnabled, setVolume, resume,
} from '../src/game/audio.js';

/**
 * A recording stand-in for an AudioContext.
 *
 * `currentTime` does not advance on its own — the tests move it by hand, because the polyphony cap
 * and the per-cue retrigger gap are both claims about time and a wall clock would make them flaky.
 *
 * @param {object} [over] overrides: {state, breakOn} where `breakOn` is a node factory name that
 *   should throw when called
 * @returns {object} the fake context, with a `log` of everything that was built
 */
function fakeContext(over) {
  const o = over || {};
  const log = {
    oscillators: [],
    gains: [],
    filters: [],
    connections: [],
    resumes: 0,
  };

  /**
   * A recording AudioParam.
   * @param {string} owner what the param belongs to, for readable failures
   * @param {string} name the param name
   * @returns {object} the param
   */
  function fakeParam(owner, name) {
    const events = [];
    return {
      owner,
      name,
      events,
      value: 0,
      /**
       * @param {number} v value
       * @param {number} t time, s
       * @returns {void}
       */
      setValueAtTime(v, t) { events.push({ kind: 'set', v, t }); this.value = v; },
      /**
       * @param {number} v value
       * @param {number} t time, s
       * @returns {void}
       */
      linearRampToValueAtTime(v, t) { events.push({ kind: 'ramp', v, t }); },
    };
  }

  const ac = {
    currentTime: 0,
    state: o.state || 'running',
    destination: { id: 'destination', inputs: [] },
    log,
    /** @returns {void} */
    resume() { log.resumes += 1; ac.state = 'running'; },
    /** @returns {object} an oscillator node */
    createOscillator() {
      if (o.breakOn === 'createOscillator') throw new Error('no oscillators today');
      const n = {
        id: `osc${log.oscillators.length}`,
        type: 'sine',
        frequency: fakeParam('osc', 'frequency'),
        started: null,
        stopped: null,
        /**
         * @param {object} dst downstream node
         * @returns {void}
         */
        connect(dst) { log.connections.push([n.id, dst.id]); },
        /**
         * @param {number} t time, s
         * @returns {void}
         */
        start(t) { n.started = t; },
        /**
         * @param {number} t time, s
         * @returns {void}
         */
        stop(t) { n.stopped = t; },
      };
      log.oscillators.push(n);
      return n;
    },
    /** @returns {object} a gain node */
    createGain() {
      if (o.breakOn === 'createGain') throw new Error('no gain today');
      const n = {
        id: `gain${log.gains.length}`,
        gain: fakeParam('gain', 'gain'),
        /**
         * @param {object} dst downstream node
         * @returns {void}
         */
        connect(dst) { log.connections.push([n.id, dst.id]); },
      };
      log.gains.push(n);
      return n;
    },
    /** @returns {object} a biquad node */
    createBiquadFilter() {
      if (o.breakOn === 'createBiquadFilter') throw new Error('no filters today');
      const n = {
        id: `lp${log.filters.length}`,
        type: 'lowpass',
        frequency: fakeParam('lp', 'frequency'),
        /**
         * @param {object} dst downstream node
         * @returns {void}
         */
        connect(dst) { log.connections.push([n.id, dst.id]); },
      };
      log.filters.push(n);
      return n;
    },
  };
  return ac;
}

/**
 * An audio handle wired to a fresh fake, with the fake to hand.
 * @param {object} [over] fake context overrides
 * @returns {object} {a, ac}
 */
function bench(over) {
  const ac = fakeContext(over);
  const a = createAudio(() => ac);
  return { a, ac };
}

/**
 * Advance the fake's clock far enough that every scheduled voice has finished and the retrigger
 * gaps have expired.
 * @param {object} ac fake context
 * @param {number} [dt] seconds
 * @returns {void}
 */
function settle(ac, dt) {
  ac.currentTime += dt === undefined ? 5 : dt;
}

// --- the silent cases -----------------------------------------------------------------------

test('every sound plays without throwing when no audio context factory was injected', () => {
  const a = createAudio(null);
  for (const id of SOUNDS) {
    assert.doesNotThrow(() => play(a, id), `${id} must be a silent no-op in Node`);
  }
  assert.equal(a.ac, null, 'nothing may be constructed when there is no factory to construct it');
});

test('the layer survives every shape of nonsense at its entry points', () => {
  const a = createAudio(undefined);
  assert.doesNotThrow(() => {
    play(null, 'tick');
    play(a, undefined);
    play(a, '');
    play(a, 'no-such-cue');
    play(a, 'constructor');
    play(a, 'toString');
    play(a, 'tick', { step: NaN });
    play(a, 'tick', { step: -1e9 });
    play(a, 'tick', null);
    setEnabled(null, true);
    setVolume(null, 0.5);
    setVolume(a, NaN);
    resume(null);
    resume(a);
  }, 'nothing in the sound layer may be able to stop a run');
  assert.equal(isEnabled(null), false, 'a missing handle is not an enabled handle');
});

test('a factory that throws leaves the layer silent and is never called a second time', () => {
  let calls = 0;
  const a = createAudio(() => {
    calls += 1;
    throw new Error('AudioContext is not allowed here');
  });
  for (const id of SOUNDS) play(a, id);
  assert.equal(calls, 1,
    'a host that refuses once refuses always — retrying would cost a throw on every scan');
  assert.equal(a.broken, true, 'the layer must latch broken rather than keep trying');
});

test('a factory returning something that is not an audio context is refused, not used', () => {
  const a = createAudio(() => ({ currentTime: 0 }));
  assert.doesNotThrow(() => play(a, 'alarm'));
  assert.equal(a.broken, true, 'an object with no createOscillator cannot be played through');
});

test('a context whose node constructors throw mid-cue does not propagate the failure', () => {
  const { a } = bench({ breakOn: 'createOscillator' });
  assert.doesNotThrow(() => play(a, 'medal'), 'a broken graph must not reach the caller');
  assert.equal(a.broken, true, 'and must not be retried afterwards');
});

// --- the recording cases --------------------------------------------------------------------

test('the factory is not called until something actually needs to make a sound', () => {
  let calls = 0;
  const ac = fakeContext();
  const a = createAudio(() => { calls += 1; return ac; });
  assert.equal(calls, 0,
    'a context built before the first gesture is a context suspended for the whole shift');
  play(a, 'click');
  assert.equal(calls, 1, 'and it must exist by the time a cue is played');
});

test('every sound builds at least one oscillator against a real-shaped context', () => {
  for (const id of SOUNDS) {
    const { a, ac } = bench();
    play(a, id);
    assert.ok(ac.log.oscillators.length >= 1, `${id} produced no sound at all`);
    for (const osc of ac.log.oscillators) {
      assert.ok(Number.isFinite(osc.started) && Number.isFinite(osc.stopped),
        `${id} left a voice running forever, which leaks a node per event`);
      assert.ok(osc.stopped > osc.started, `${id} scheduled a voice that stops before it starts`);
      const f = osc.frequency.events[0];
      assert.ok(f && f.v > 20 && f.v < 12000,
        `${id} scheduled ${f && f.v} Hz, which is outside anything a person can hear as a cue`);
    }
  }
});

test('every voice is connected through a gain envelope and reaches the destination', () => {
  const { a, ac } = bench();
  play(a, 'bandOut');
  const pairs = ac.log.connections.map((c) => c.join('->'));
  assert.ok(pairs.some((p) => p.startsWith('osc0->gain')),
    'an oscillator wired straight to the output is a click, not an envelope');
  assert.ok(pairs.some((p) => p.endsWith('->destination')),
    'the mix has to reach the destination or none of this makes a sound');
  assert.equal(ac.log.filters.length, 1,
    'the band-out thunk is a filtered voice — without the lowpass it is a beep');
});

test('the multiplier tick rises exactly a semitone per step', () => {
  const { a, ac } = bench();
  const heard = [];
  for (let step = 0; step < 4; step += 1) {
    play(a, 'tick', { step });
    heard.push(ac.log.oscillators[ac.log.oscillators.length - 1].frequency.events[0].v);
    settle(ac, 0.5);
  }
  for (let i = 1; i < heard.length; i += 1) {
    const ratio = heard[i] / heard[i - 1];
    assert.ok(Math.abs(ratio - 2 ** (1 / 12)) < 1e-6,
      `step ${i} moved by a ratio of ${ratio}; the combo is meant to be audible as a rising line`);
  }
});

test('the tick step is clamped, so a runaway multiplier cannot reach an inaudible pitch', () => {
  const { a, ac } = bench();
  play(a, 'tick', { step: 500 });
  const f = ac.log.oscillators[0].frequency.events[0].v;
  assert.ok(f < 4000, `a step of 500 produced ${f} Hz — the clamp is not holding`);
});

test('failure descends and the medal ascends, which is the whole point of them', () => {
  const fb = bench();
  play(fb.a, 'fail');
  const fails = fb.ac.log.oscillators.map((o) => o.frequency.events[0].v);
  assert.equal(fails.length, 2, 'fail is a descending pair');
  assert.ok(fails[1] < fails[0], 'the second note of the failure cue must fall below the first');

  const mb = bench();
  play(mb.a, 'medal');
  const medal = mb.ac.log.oscillators.map((o) => o.frequency.events[0].v);
  assert.ok(medal.length >= 3, 'a medal fanfare is an arpeggio, not one note');
  for (let i = 1; i < medal.length; i += 1) {
    assert.ok(medal[i] > medal[i - 1], 'the arpeggio must climb');
  }
  const starts = mb.ac.log.oscillators.map((o) => o.started);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] > starts[i - 1], 'an arpeggio played as a chord is a chord');
  }
});

test('the annunciator alarm is two tones, high then low, and not a single beep', () => {
  const { a, ac } = bench();
  play(a, 'alarm');
  const notes = ac.log.oscillators.map((o) => o.frequency.events[0].v);
  assert.equal(notes.length, 2, 'the two-tone chirp is what makes it read as a panel alarm');
  assert.ok(notes[0] > notes[1], 'the annunciator chirp falls');
  assert.ok(ac.log.oscillators[1].started > ac.log.oscillators[0].started,
    'the second tone must follow the first rather than sound with it');
});

test('nothing is scheduled in the past, which is where a click comes from', () => {
  const { a, ac } = bench();
  ac.currentTime = 12.5;
  play(a, 'stage');
  for (const osc of ac.log.oscillators) {
    assert.ok(osc.started > ac.currentTime,
      'a voice started in the block already being rendered clicks or is dropped');
  }
});

// --- the switches ---------------------------------------------------------------------------

test('setEnabled(false) stops nodes being created rather than merely muting them', () => {
  const { a, ac } = bench();
  play(a, 'tick');
  const built = ac.log.oscillators.length;
  assert.ok(built > 0, 'the bench has to be able to make a sound for this test to mean anything');

  setEnabled(a, false);
  assert.equal(isEnabled(a), false);
  settle(ac);
  for (const id of SOUNDS) play(a, id);
  assert.equal(ac.log.oscillators.length, built,
    'a muted layer that still builds a graph per event is a leak with the volume down');

  setEnabled(a, true);
  settle(ac);
  play(a, 'tick');
  assert.ok(ac.log.oscillators.length > built, 'and it has to come back when switched on again');
});

test('a layer muted before the first gesture never constructs a context at all', () => {
  let calls = 0;
  const a = createAudio(() => { calls += 1; return fakeContext(); });
  setEnabled(a, false);
  for (const id of SOUNDS) play(a, id);
  resume(a);
  assert.equal(calls, 0, 'muted means no context, no nodes, no hardware wake-up');
});

test('the volume rides the master gain and refuses values that would poison the mix', () => {
  const { a, ac } = bench();
  play(a, 'click');
  const master = ac.log.gains[0];
  assert.equal(master.gain.value, 0.6, 'the master must be opened to the current volume on build');

  setVolume(a, 0.25);
  assert.equal(master.gain.value, 0.25, 'setVolume has to reach the live graph, not just the state');

  setVolume(a, 4);
  assert.equal(a.volume, 1, 'volume is clamped to unity');
  setVolume(a, -3);
  assert.equal(a.volume, 0, 'and to zero');

  setVolume(a, NaN);
  assert.equal(a.volume, 0, 'a NaN in a gain param is permanent silence with no error anywhere');
});

test('a volume of zero still builds the cue, because silent is not the same as disabled', () => {
  const { a, ac } = bench();
  setVolume(a, 0);
  play(a, 'cash');
  assert.ok(ac.log.oscillators.length > 0,
    'turning the volume down must not quietly change which cues exist');
});

test('resume wakes a suspended context and is harmless when there is nothing to wake', () => {
  const { a, ac } = bench({ state: 'suspended' });
  resume(a);
  assert.equal(ac.log.resumes, 1, 'the first gesture is the only chance to start the audio hardware');
  assert.equal(ac.state, 'running');
  resume(a);
  assert.equal(ac.log.resumes, 1, 'a running context does not need waking again');

  const quiet = createAudio(null);
  assert.doesNotThrow(() => resume(quiet), 'resume in Node must do nothing, loudly or otherwise');
});

// --- the guards against a roar -----------------------------------------------------------------

test('the same cue fired every scan is swallowed rather than becoming a tone', () => {
  const { a, ac } = bench();
  // The controller scan can be 50 ms; a scoring event that fires each scan must not machine-gun.
  for (let k = 0; k < 20; k += 1) {
    play(a, 'tick', { step: 0 });
    ac.currentTime += 0.05;
  }
  assert.ok(ac.log.oscillators.length <= 8,
    `twenty scans produced ${ac.log.oscillators.length} voices — the retrigger gap is not holding`);
  assert.ok(ac.log.oscillators.length >= 3,
    'but a handful over a full second of holding is too few — the gap must not be a latch');
});

test('the retrigger gap is per cue, so different events in one scan all sound', () => {
  const { a, ac } = bench();
  play(a, 'bandOut');
  const afterFirst = ac.log.oscillators.length;
  play(a, 'alarm');
  play(a, 'stage');
  assert.ok(ac.log.oscillators.length > afterFirst + 1,
    'a band-out must not swallow the alarm that landed in the same scan');
});

test('a burst of different cues is capped rather than allowed to stack into a roar', () => {
  const { a, ac } = bench();
  // Everything the scoring engine can plausibly raise on one bad scan, plus more.
  for (let k = 0; k < 3; k += 1) for (const id of SOUNDS) play(a, id);
  assert.ok(ac.log.oscillators.length <= 14,
    `a single instant produced ${ac.log.oscillators.length} voices; the polyphony cap is not holding`);
});

test('an ordinary cue is refused whole when only part of it would fit under the cap', () => {
  const { a, ac } = bench();
  // Eight voices of ordinary cues, built in one instant so nothing expires between them.
  play(a, 'cash');                                    // 3
  play(a, 'combo');                                   // 5
  play(a, 'stage');                                   // 7
  play(a, 'tick');                                    // 8
  assert.equal(ac.log.oscillators.length, 8, 'the ordinary cap is eight sounding voices');
  play(a, 'bandOut');
  play(a, 'countdown');
  assert.equal(ac.log.oscillators.length, 8,
    'a cue admitted on its first note and then allowed to schedule the rest is not a cap');
});

test('the critical cues have their own ceiling and it is also whole-cue', () => {
  const { a, ac } = bench();
  play(a, 'medal');                                   // 4
  play(a, 'unlock');                                  // 8
  play(a, 'alarm');                                   // 10
  play(a, 'fail');                                    // 12
  play(a, 'warn');                                    // 14
  assert.equal(ac.log.oscillators.length, 14, 'fourteen is the hard ceiling');
  play(a, 'stage');
  assert.equal(ac.log.oscillators.length, 14,
    'and past it nothing at all is built, however important it thinks it is');
});

test('the voice cap frees up again once the scheduled voices have finished', () => {
  const { a, ac } = bench();
  for (const id of SOUNDS) play(a, id);
  const burst = ac.log.oscillators.length;
  settle(ac);
  play(a, 'medal');
  assert.ok(ac.log.oscillators.length > burst,
    'the cap counts sounding voices, not lifetime voices — otherwise the game goes silent');
  assert.ok(a.until.length < 8, 'and the finished voices must be dropped rather than accumulated');
});

test('a critical cue can push past the cap that an ordinary one is held to', () => {
  const { a, ac } = bench();
  play(a, 'cash');
  play(a, 'combo');
  play(a, 'stage');
  play(a, 'tick');
  const full = ac.log.oscillators.length;
  assert.equal(full, 8, 'the ordinary cap has to be reached for this test to mean anything');

  play(a, 'click');
  assert.equal(ac.log.oscillators.length, full, 'an ordinary cue is dropped at the ordinary cap');

  play(a, 'alarm');
  assert.equal(ac.log.oscillators.length, full + 2,
    'a trip alarm the player never hears because the tick queue was full is a lost shift');
});

// --- the contract itself ----------------------------------------------------------------------

test('SOUNDS lists the thirteen documented cues and cannot be edited at run time', () => {
  assert.equal(SOUNDS.length, 13, 'the UI codes against this list');
  assert.ok(Object.isFrozen(SOUNDS), 'a shared constant table has to be frozen');
  for (const id of ['tick', 'combo', 'bandIn', 'bandOut', 'alarm', 'medal', 'fail', 'stage',
    'click', 'countdown', 'warn', 'cash', 'unlock']) {
    assert.ok(SOUNDS.includes(id), `${id} is named in the module contract and must exist`);
  }
  assert.equal(new Set(SOUNDS).size, SOUNDS.length, 'a duplicate id would hide a missing cue');
});

test('the layer only uses the audio API it is allowed to rely on', () => {
  const ac = fakeContext();
  // No createBufferSource, no decodeAudioData, no fetch: every cue is arithmetic.
  const a = createAudio(() => ac);
  for (const id of SOUNDS) {
    settle(ac);
    assert.doesNotThrow(() => play(a, id), `${id} reached for an API the fake does not implement`);
  }
  assert.equal(a.broken, false, 'and none of them may latch the layer broken');
});

test('a context with no filter support degrades to an unfiltered voice instead of failing', () => {
  const ac = fakeContext();
  delete ac.createBiquadFilter;
  const a = createAudio(() => ac);
  play(a, 'bandOut');
  assert.equal(ac.log.oscillators.length, 1, 'the thunk must still sound on a minimal host');
  assert.equal(a.broken, false, 'a missing optional node type is not a broken audio layer');
});
