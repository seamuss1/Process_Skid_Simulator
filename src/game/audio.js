/**
 * src/game/audio.js — the game's sound layer. Thirteen cues, every one of them synthesised on the
 * spot from oscillators and gain envelopes. No assets, no network, no decoding: the whole file is
 * arithmetic on frequencies and times.
 *
 * Layer L4 (src/game): imports `core/util.js` and nothing else. It never touches `window`,
 * `document`, `AudioContext` or `performance` by name. The one environment-dependent thing it
 * needs — a way to make an audio context — arrives as an injected zero-argument factory, and when
 * that factory is absent the whole module is a silent, allocation-free, throw-free no-op. That is
 * not a convenience for the tests; it is the two states this module actually ships in:
 *
 *   1. Node, under `node --test`, where there is no Web Audio at all.
 *   2. The browser BEFORE the operator's first click, where constructing a context is either
 *      refused outright or yields a suspended one that will never make a sound. Nothing may be
 *      built until {@link resume} is called from inside a real gesture handler.
 *
 * WHY THE FACTORY IS CALLED LATE. `createAudio` deliberately does not call it. A context built at
 * page load on a browser that requires a gesture is a context stuck in `suspended` forever, and
 * the usual symptom is a game that is silent for its whole first shift and works fine on reload —
 * which nobody can reproduce. So the factory is called on the first sound that is actually allowed
 * to make noise, and `resume` exists to be wired to the first click.
 *
 * WHY IT GIVES UP. If the factory throws, or a node constructor throws, the layer latches broken
 * and stops trying. A Web Audio graph that refuses to build once will refuse again, and retrying
 * inside `onScan` means paying for a thrown exception on every controller scan of the run.
 *
 * ------------------------------------------------------------------------------------------
 * THE VOICING, AND WHY IT IS NOT A SLOT MACHINE
 *
 * The player is meant to read this rig as a control room, not a casino, so the cues borrow from
 * panel hardware: the multiplier tick is a short dry blip that climbs a semitone a step, so the
 * hold is AUDIBLE as a rising line and the player can hear the combo without looking away from
 * the trace; leaving the band is a soft muted thunk rather than a buzzer, because leaving the band
 * is a mistake and not a failure; the alarm is the two-tone chirp an annunciator makes; a medal is
 * a brief arpeggio; failure is a descending pair. Everything is short — the longest cue here is
 * half a second — because these fire on top of a live trend that the player is reading.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/** Ratio of one equal-tempered semitone. The multiplier tick climbs by exactly this per step. */
const SEMITONE = 2 ** (1 / 12);

/**
 * Seconds of lead time between "now" and the first scheduled event.
 *
 * Scheduling at exactly `currentTime` asks the audio thread to start a voice in the block it is
 * already rendering, and the usual result is a click or a dropped note. Five milliseconds is
 * inaudible as latency and puts every event safely in the next block.
 */
const LEAD_S = 0.005;

/** Envelope attack, s. Short enough to read as percussive, long enough not to click. */
const ATTACK_S = 0.004;

/** Extra seconds a voice is left running past its envelope, so the stop never clips the tail. */
const RELEASE_S = 0.02;

/**
 * Ordinary polyphony cap. A burst of scoring events — band-out, alarm, thrash and a multiplier
 * reset can all land on the same scan — must not stack into a roar, so once this many voices are
 * still sounding, further low-priority cues are dropped rather than queued. Dropping is right and
 * delaying is wrong: a cue that arrives late is a cue that describes the wrong moment on the trace.
 */
const SOFT_VOICES = 8;

/** Hard cap. Cues that carry information the player must not miss may exceed {@link SOFT_VOICES}. */
const HARD_VOICES = 14;

/** Every cue id the layer knows. The UI imports this rather than spelling ids out. */
export const SOUNDS = Object.freeze([
  'tick',
  'combo',
  'bandIn',
  'bandOut',
  'alarm',
  'medal',
  'fail',
  'stage',
  'click',
  'countdown',
  'warn',
  'cash',
  'unlock',
]);

/**
 * Set an AudioParam without assuming the host implements the whole automation API.
 *
 * Shipped Web Audio implementations differ at the edges, and a missing `linearRampToValueAtTime`
 * on some embedded browser must degrade to a step change rather than take the game down.
 *
 * @param {object} pm the AudioParam, or anything at all
 * @param {string} method the automation method to prefer
 * @param {number} value the target value
 * @param {number} at_s the context time to apply it at, s
 * @returns {void}
 */
function param(pm, method, value, at_s) {
  if (!pm) return;
  if (typeof pm[method] === 'function') {
    pm[method](value, at_s);
  } else if (typeof pm.setValueAtTime === 'function') {
    pm.setValueAtTime(value, at_s);
  } else {
    pm.value = value;
  }
}

/**
 * Schedule one oscillator voice through its own envelope, and optionally a lowpass.
 *
 * Every sound in the table below is some number of calls to this. Keeping the graph to
 * oscillator -> gain -> [lowpass] -> master means the only node constructors this module needs are
 * the three every implementation has had since Web Audio shipped.
 *
 * @param {object} a the audio handle
 * @param {object} ac the live audio context
 * @param {object} v the voice: {type, f0, f1, at, dur, peak, cutoff}
 * @param {string} v.type oscillator waveform
 * @param {number} v.f0 starting frequency, Hz
 * @param {number} [v.f1] frequency at the end of the voice, Hz; omit for a steady tone
 * @param {number} v.at context time to start at, s
 * @param {number} v.dur envelope length, s
 * @param {number} v.peak envelope peak, relative to the master gain
 * @param {number} [v.cutoff] lowpass corner, Hz. This is what makes a thunk a thunk rather than
 *   a beep: the harmonics of a square or a saw are the difference between panel hardware and a toy
 * @returns {void}
 */
function voice(a, ac, v) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const t0 = v.at;
  const t1 = t0 + v.dur;

  osc.type = v.type;
  param(osc.frequency, 'setValueAtTime', v.f0, t0);
  if (v.f1 && v.f1 !== v.f0) param(osc.frequency, 'linearRampToValueAtTime', v.f1, t1);

  // Down to a small positive value rather than to zero: some hosts treat a ramp to exactly zero as
  // a discontinuity and click on it, and 1e-4 is 80 dB down, which is silence by any measure.
  param(gain.gain, 'setValueAtTime', 0, t0);
  param(gain.gain, 'linearRampToValueAtTime', v.peak, t0 + Math.min(ATTACK_S, v.dur * 0.5));
  param(gain.gain, 'linearRampToValueAtTime', 1e-4, t1);

  osc.connect(gain);
  if (v.cutoff && typeof ac.createBiquadFilter === 'function') {
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    param(lp.frequency, 'setValueAtTime', v.cutoff, t0);
    gain.connect(lp);
    lp.connect(a.master);
  } else {
    gain.connect(a.master);
  }

  osc.start(t0);
  osc.stop(t1 + RELEASE_S);
  a.until.push(t1 + RELEASE_S);
}

/**
 * The multiplier tick: one short dry blip, a semitone higher for every multiplier step, so a
 * player who is holding the band hears the combo climb without taking their eyes off the trace.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @param {number} step multiplier step, 0-based
 * @returns {void}
 */
function cueTick(a, ac, t, step) {
  // C6. High enough to sit above the alarm and the thunk, short enough to disappear under them.
  const f = 1046.5 * SEMITONE ** step;
  voice(a, ac, { type: 'triangle', f0: f, f1: f * 1.01, at: t, dur: 0.05, peak: 0.5 });
}

/**
 * Multiplier gained: the tick, answered a fifth above. A confirmation, not a jackpot.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @param {number} step multiplier step, 0-based
 * @returns {void}
 */
function cueCombo(a, ac, t, step) {
  const f = 880 * SEMITONE ** step;
  voice(a, ac, { type: 'triangle', f0: f, at: t, dur: 0.07, peak: 0.42 });
  voice(a, ac, { type: 'triangle', f0: f * 1.5, at: t + 0.06, dur: 0.1, peak: 0.38 });
}

/**
 * Back inside the tolerance band: a soft rise, the sound of something latching.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueBandIn(a, ac, t) {
  voice(a, ac, { type: 'sine', f0: 520, f1: 784, at: t, dur: 0.12, peak: 0.34, cutoff: 2200 });
}

/**
 * Out of the band: a muted thunk. Deliberately not a buzzer — leaving the band costs points and
 * the player can see that on the trace; the cue only has to say WHEN, and a harsh sound here makes
 * an already-behind operator flinch at exactly the wrong moment.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueBandOut(a, ac, t) {
  voice(a, ac, { type: 'sine', f0: 190, f1: 96, at: t, dur: 0.22, peak: 0.5, cutoff: 420 });
}

/**
 * The annunciator: two tones, high then low, squarish and filtered. This is the one cue in the set
 * copied from real hardware rather than invented, because an operator who has heard a panel chirp
 * knows what it means before they have finished turning their head.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueAlarm(a, ac, t) {
  voice(a, ac, { type: 'square', f0: 932, at: t, dur: 0.12, peak: 0.3, cutoff: 2400 });
  voice(a, ac, { type: 'square', f0: 699, at: t + 0.14, dur: 0.16, peak: 0.3, cutoff: 2000 });
}

/**
 * Medal: a brief major arpeggio. Four notes and done — the result screen is already telling the
 * story, and a fanfare that outlasts the reading of it is a fanfare the player turns the sound off
 * to avoid.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueMedal(a, ac, t) {
  const notes = [659.25, 830.61, 987.77, 1318.5];
  for (let i = 0; i < notes.length; i += 1) {
    voice(a, ac, { type: 'triangle', f0: notes[i], at: t + i * 0.07, dur: 0.16, peak: 0.36 });
  }
}

/**
 * Failure: a descending pair, filtered down until it is more of a sag than a note.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueFail(a, ac, t) {
  voice(a, ac, { type: 'sawtooth', f0: 311.1, f1: 233.1, at: t, dur: 0.18, peak: 0.34, cutoff: 1200 });
  voice(a, ac, { type: 'sawtooth', f0: 233.1, f1: 155.6, at: t + 0.16, dur: 0.34, peak: 0.34, cutoff: 900 });
}

/**
 * A pump staged in or out: the contactor thunk, then the drive's confirm blip.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueStage(a, ac, t) {
  voice(a, ac, { type: 'sine', f0: 120, f1: 80, at: t, dur: 0.14, peak: 0.45, cutoff: 300 });
  voice(a, ac, { type: 'triangle', f0: 523.25, at: t + 0.09, dur: 0.09, peak: 0.28 });
}

/**
 * A control acknowledging a touch. Quiet by design: this one fires the most often of anything here.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueClick(a, ac, t) {
  voice(a, ac, { type: 'square', f0: 2200, at: t, dur: 0.018, peak: 0.16, cutoff: 3200 });
}

/**
 * The telegraph countdown pip. It climbs two semitones a step so that T-3, T-2, T-1 are audibly a
 * sequence rather than three identical beeps — the player should be able to tell how long is left
 * while looking at the trend rather than at the ticker.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @param {number} step how many pips have already gone, 0-based
 * @returns {void}
 */
function cueCountdown(a, ac, t, step) {
  voice(a, ac, {
    type: 'triangle', f0: 587.33 * SEMITONE ** (2 * step), at: t, dur: 0.07, peak: 0.34,
  });
}

/**
 * Caution — an upset is armed, a limit is close. Two tones falling, softer and lower than the
 * annunciator, so the two can never be confused in a hurry.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueWarn(a, ac, t) {
  voice(a, ac, { type: 'triangle', f0: 587.33, at: t, dur: 0.1, peak: 0.28, cutoff: 1800 });
  voice(a, ac, { type: 'triangle', f0: 466.16, at: t + 0.11, dur: 0.14, peak: 0.28, cutoff: 1600 });
}

/**
 * Points banked: three quick rising blips, quiet enough to fire repeatedly without becoming the
 * loudest thing in the room.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueCash(a, ac, t) {
  const notes = [880, 1108.7, 1318.5];
  for (let i = 0; i < notes.length; i += 1) {
    voice(a, ac, { type: 'triangle', f0: notes[i], at: t + i * 0.045, dur: 0.05, peak: 0.26 });
  }
}

/**
 * A feature unlocked. Longer and wider-spaced than the medal so the two do not blur together on a
 * results screen that fires both.
 * @param {object} a audio handle
 * @param {object} ac live context
 * @param {number} t start time, s
 * @returns {void}
 */
function cueUnlock(a, ac, t) {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < notes.length; i += 1) {
    voice(a, ac, { type: 'triangle', f0: notes[i], at: t + i * 0.09, dur: 0.2, peak: 0.32 });
  }
}

/**
 * The cue table: how each sound is built, how hard it may push past the polyphony cap, and how
 * often it is allowed to retrigger.
 *
 * `minGap_s` is the anti-machine-gun guard. The scoring engine runs on the controller scan, which
 * can be as fast as 50 ms, and a cue fired every scan is not a cue, it is a tone. Every gap here is
 * therefore comfortably longer than the fastest scan. The gaps are per-id, so a tick and a thunk in
 * the same scan both sound; only a repeat of the SAME cue is swallowed.
 *
 * `voices` is how many oscillators the build function schedules, and it is what the polyphony cap
 * counts against. Admitting a cue on the strength of one voice and then letting it schedule four is
 * how a "cap" of eight turns into a wall of eleven; `tests/audio.test.js` fires real bursts at both
 * caps and pins the totals, so a number here that drifts away from its builder fails there.
 */
const CUES = Object.freeze({
  tick: Object.freeze({ build: cueTick, voices: 1, minGap_s: 0.12, critical: false }),
  combo: Object.freeze({ build: cueCombo, voices: 2, minGap_s: 0.2, critical: false }),
  bandIn: Object.freeze({ build: cueBandIn, voices: 1, minGap_s: 0.25, critical: false }),
  bandOut: Object.freeze({ build: cueBandOut, voices: 1, minGap_s: 0.25, critical: false }),
  alarm: Object.freeze({ build: cueAlarm, voices: 2, minGap_s: 0.4, critical: true }),
  medal: Object.freeze({ build: cueMedal, voices: 4, minGap_s: 0.5, critical: true }),
  fail: Object.freeze({ build: cueFail, voices: 2, minGap_s: 0.5, critical: true }),
  stage: Object.freeze({ build: cueStage, voices: 2, minGap_s: 0.25, critical: false }),
  click: Object.freeze({ build: cueClick, voices: 1, minGap_s: 0.08, critical: false }),
  countdown: Object.freeze({ build: cueCountdown, voices: 1, minGap_s: 0.15, critical: false }),
  warn: Object.freeze({ build: cueWarn, voices: 2, minGap_s: 0.3, critical: true }),
  cash: Object.freeze({ build: cueCash, voices: 3, minGap_s: 0.12, critical: false }),
  unlock: Object.freeze({ build: cueUnlock, voices: 4, minGap_s: 0.5, critical: true }),
});

/**
 * Create the sound layer.
 *
 * The factory is stored, not called: see the note at the top of this file about the browser's
 * gesture requirement. Passing null, undefined or anything that is not a function produces a
 * handle that is valid, inert and free to call.
 *
 * @param {(() => object)|null} [factory] a zero-argument function returning an AudioContext, or
 *   null/undefined in Node and anywhere Web Audio is unavailable
 * @returns {object} the audio handle every other function here takes as its first argument
 */
export function createAudio(factory) {
  return {
    /** The injected constructor, called at most once. */
    factory: typeof factory === 'function' ? factory : null,
    /** The live context, once something has been allowed to make a sound. */
    ac: null,
    /** The single gain node everything is mixed through; also where the volume lives. */
    master: null,
    /** Latched true the first time anything throws, after which the layer stays silent forever. */
    broken: false,
    /** Operator's sound switch. */
    enabled: true,
    /** Master volume, 0..1. */
    volume: 0.6,
    /** Context times at which currently scheduled voices finish, for the polyphony cap. */
    until: [],
    /** Context time each cue id last fired at, for the per-cue retrigger gap. */
    lastAt: Object.create(null),
  };
}

/**
 * Bring the context up, building it on first use.
 *
 * @param {object} a audio handle
 * @returns {object|null} the live context, or null if there is not going to be one
 */
function context(a) {
  if (a.broken) return null;
  if (a.ac) return a.ac;
  if (!a.factory) return null;
  try {
    const ac = a.factory();
    if (!ac || typeof ac.createOscillator !== 'function' || typeof ac.createGain !== 'function') {
      a.broken = true;
      return null;
    }
    const master = ac.createGain();
    param(master.gain, 'setValueAtTime', a.volume, ac.currentTime || 0);
    master.connect(ac.destination);
    a.ac = ac;
    a.master = master;
    return ac;
  } catch {
    // A host that refuses to build a context is not going to change its mind mid-shift, and
    // retrying on every scoring event would cost a thrown exception per controller scan.
    a.broken = true;
    return null;
  }
}

/**
 * How many scheduled voices are still sounding, dropping the finished ones as it counts.
 * @param {object} a audio handle
 * @param {number} now context time, s
 * @returns {number} live voice count
 */
function liveVoices(a, now) {
  const list = a.until;
  let kept = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] > now) {
      list[kept] = list[i];
      kept += 1;
    }
  }
  list.length = kept;
  return kept;
}

/**
 * Play a cue.
 *
 * Guarded at every step and silent rather than loud about it: an unknown id, a dead handle, a
 * missing context, a muted layer and a cue that fired a millisecond ago all return without
 * building anything. Nothing here throws, because this is called from the scoring path and a
 * sound effect must never be able to stop a run.
 *
 * @param {object} a audio handle from {@link createAudio}
 * @param {string} id one of {@link SOUNDS}
 * @param {object} [opts] cue options
 * @param {number} [opts.step] multiplier or countdown step, 0-based, for the cues that climb
 * @returns {void}
 */
export function play(a, id, opts) {
  if (!a || a.broken || !a.enabled) return;
  const cue = CUES[id];
  // `CUES` has a null prototype's behaviour enforced by hand here: an id of 'constructor' or
  // 'toString' would otherwise find an inherited function and be treated as a real cue.
  if (!cue || !Object.prototype.hasOwnProperty.call(CUES, id)) return;

  const ac = context(a);
  if (!ac) return;

  try {
    const now = ac.currentTime;
    if (!Number.isFinite(now)) return;

    const last = a.lastAt[id];
    if (last !== undefined && now - last < cue.minGap_s) return;

    const cap = cue.critical ? HARD_VOICES : SOFT_VOICES;
    // The WHOLE cue has to fit under the cap. Admitting it and then scheduling its four notes is
    // how the count walks past a limit that looks like it is being enforced.
    if (liveVoices(a, now) + cue.voices > cap) return;

    const rawStep = opts && Number.isFinite(opts.step) ? Math.floor(opts.step) : 0;
    const step = clamp(rawStep, 0, 11);

    a.lastAt[id] = now;
    cue.build(a, ac, now + LEAD_S, step);
  } catch {
    a.broken = true;
  }
}

/**
 * Turn the sound on or off.
 *
 * Off means OFF: {@link play} returns before the context is ever asked for a node, so a disabled
 * layer costs nothing and — on a first run where the operator has muted before their first click —
 * never constructs an audio context at all.
 *
 * @param {object} a audio handle
 * @param {boolean} on whether cues may sound
 * @returns {void}
 */
export function setEnabled(a, on) {
  if (!a) return;
  a.enabled = !!on;
}

/**
 * @param {object} a audio handle
 * @returns {boolean} whether cues are currently allowed to sound
 */
export function isEnabled(a) {
  return !!(a && a.enabled);
}

/**
 * Set the master volume.
 *
 * Nonsense in is ignored rather than applied: a NaN written into a gain param poisons the whole
 * mix downstream of it and the only symptom is permanent silence with no error anywhere.
 *
 * @param {object} a audio handle
 * @param {number} x volume, 0..1
 * @returns {void}
 */
export function setVolume(a, x) {
  if (!a || !Number.isFinite(x)) return;
  a.volume = clamp(x, 0, 1);
  if (a.master && a.ac) {
    try {
      param(a.master.gain, 'setValueAtTime', a.volume, a.ac.currentTime || 0);
    } catch {
      a.broken = true;
    }
  }
}

/**
 * Resume the context, building it if this is the first time.
 *
 * Wire this to the first real operator gesture. Browsers will not let a page make a sound until
 * one has happened, and a context built before it stays suspended: the game is silent for the
 * whole shift and works perfectly on reload, which is the least debuggable bug in the set.
 *
 * @param {object} a audio handle
 * @returns {void}
 */
export function resume(a) {
  if (!a || a.broken || !a.enabled) return;
  const ac = context(a);
  if (!ac) return;
  try {
    if (ac.state !== 'running' && typeof ac.resume === 'function') ac.resume();
  } catch {
    a.broken = true;
  }
}
