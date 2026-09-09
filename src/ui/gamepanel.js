/**
 * src/ui/gamepanel.js — the GAME tab on the control rail: what the shift is doing right now, the
 * switches that do not deserve a full screen, and the player's own record.
 *
 * Layer L6, exactly like `panels.js`: it reads the sim context, and it writes through the bound
 * actions in `A` and through nothing else.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS IS A RAIL TAB AND NOT PART OF THE HUD
 *
 * The HUD is drawn over the trend while a shift is being played, and everything on it has to be
 * readable at a glance by somebody whose attention is on the trace. That is the wrong home for a
 * volume slider, a share code you type with two hands, or a destructive reset. Those live here,
 * beside RUN, TUNE, PLANT and TEST, where the player is already stopped and looking.
 *
 * The split has one consequence worth stating: this file must render sensibly when there is no
 * game at all. A player who never opens the GAME tab still has one, and it opens on the sandbox.
 * Every readout therefore degrades to an em dash rather than disappearing, and every button that
 * needs a live session refuses with a sentence instead of throwing.
 *
 * ------------------------------------------------------------------------------------------
 * THE PURE HALF
 *
 * Everything above `createGamePanel` is free of the DOM and is unit-tested in Node. That is not
 * tidiness: the share code, the reset guard and the status formatting are the three places in this
 * file where a mistake is expensive — a code that loads the wrong rig, a reset that fires on one
 * click, a countdown that reads `NaN:aN` in front of the player — and none of them are things a
 * browser is needed to check.
 * ------------------------------------------------------------------------------------------
 */

import {
  h, setText, cls, num, dur, panel, slider, readout,
} from './dom.js';
import { seedCode, parseSeedCode } from '../game/rng.js';
import {
  RANKS, UNLOCKS, UNLOCK_ORDER, rankFor, nextRankFor, exportProfile, importProfile,
} from '../game/profile.js';
import { MISSIONS, missionById, missionCleared } from '../game/missions.js';
import { download, timestampedName } from '../io/export.js';

// ==============================================================================================
// Constants
// ==============================================================================================

/** Where the display and sound preferences are kept. Namespaced alongside the profile's key. */
export const PREFS_KEY = 'skid.game.prefs';

/**
 * The preferences this panel owns, and their defaults.
 *
 * Volume starts at 0.6 rather than 1.0 because the cue set is synthesised from bare oscillators:
 * at full scale a square-wave alarm on a laptop speaker is genuinely unpleasant, and a player who
 * turns the sound off in the first ten seconds never turns it back on.
 */
export const DEFAULT_PREFS = Object.freeze({
  audio: true,
  volume: 0.6,
  ghost: true,
  band: true,
});

/**
 * How long a guarded button stays armed, in milliseconds.
 *
 * Long enough to move the mouse back and read the changed label; short enough that an arming
 * click forgotten a minute ago cannot be completed by an unrelated click later. Four seconds is
 * the figure the alarm-acknowledge guards on real HMIs tend to use for the same reason.
 */
export const CONFIRM_WINDOW_MS = 4000;

/**
 * Phase names as the player should read them. The session's own ids are machine words; `RESULT`
 * on a panel reads like an error, `DEBRIEF` reads like a shift.
 */
export const PHASE_LABEL = Object.freeze({
  IDLE: 'STANDBY',
  BRIEF: 'BRIEFING',
  COUNTDOWN: 'STARTING',
  PLAY: 'ON SHIFT',
  DIAGNOSE: 'DIAGNOSE',
  RESULT: 'DEBRIEF',
  FAILED: 'FAILED',
});

/** Mode names as the player should read them. */
export const MODE_LABEL = Object.freeze({
  CAMPAIGN: 'CAMPAIGN',
  ENDLESS: 'ENDLESS',
  DAILY: 'DAILY',
  FAULT: 'FAULT HUNT',
  SANDBOX: 'FREE PLAY',
});

/** The share-code length this build produces, excluding the dash. */
const CODE_GLYPHS = 8;

// ==============================================================================================
// Pure helpers — no DOM, no clock, no storage of their own
// ==============================================================================================

/**
 * The player-facing name of a session phase.
 * @param {string|null|undefined} phase the session's phase id
 * @returns {string} the label, the id upper-cased if it is unknown, or an em dash
 */
export function phaseLabel(phase) {
  if (typeof phase !== 'string' || phase.length === 0) return '—';
  const key = phase.toUpperCase();
  return PHASE_LABEL[key] || key;
}

/**
 * The player-facing name of a game mode.
 * @param {string|null|undefined} mode the session's mode id
 * @returns {string} the label, the id upper-cased if it is unknown, or an em dash
 */
export function modeLabel(mode) {
  if (typeof mode !== 'string' || mode.length === 0) return '—';
  const key = mode.toUpperCase();
  return MODE_LABEL[key] || key;
}

/**
 * A remaining time as `M:SS`.
 *
 * Deliberately not `dur()` from `dom.js`: a shift clock counting down has to keep its shape as it
 * passes a minute boundary, and `dur()` switches from `3.4 min` to `54 s` halfway through, which
 * reads as the clock jumping.
 *
 * @param {number} left_s seconds remaining
 * @returns {string} the clock, floored at zero, or an em dash for nonsense
 */
export function formatCountdown(left_s) {
  if (!Number.isFinite(left_s)) return '—';
  const t = Math.max(0, Math.ceil(left_s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * A score as a whole number with thousands separated.
 *
 * Grouped by hand rather than through `toLocaleString`, so that the panel reads the same on a
 * machine whose locale groups by lakhs or separates with a full stop; a score is a game number,
 * not a local currency.
 *
 * @param {number} n the score
 * @returns {string} e.g. `12,480`, or an em dash for nonsense
 */
export function formatPoints(n) {
  if (!Number.isFinite(n)) return '—';
  const v = Math.round(n);
  const sign = v < 0 ? '-' : '';
  const digits = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
}

/**
 * The score multiplier.
 * @param {number} mult the multiplier
 * @returns {string} e.g. `×3`, or an em dash for nonsense
 */
export function formatMult(mult) {
  if (!Number.isFinite(mult)) return '—';
  const m = Math.max(0, mult);
  // Whole multipliers are the normal case and `×3.0` reads like a measurement rather than a prize.
  return Number.isInteger(m) ? `×${m}` : `×${m.toFixed(1)}`;
}

/**
 * The tolerance band, as the half-width either side of setpoint.
 * @param {number} band the half-width in engineering units
 * @param {string} [unit] the engineering unit, from `loopEU(ctx)`
 * @returns {string} e.g. `±0.15 bar`, or an em dash
 */
export function formatBand(band, unit) {
  if (!Number.isFinite(band) || band <= 0) return '—';
  const dp = band < 1 ? 2 : 1;
  return `±${num(band, dp)}${unit ? ` ${unit}` : ''}`;
}

/**
 * One line of the event ticker.
 *
 * The countdown is rounded UP, so a ticket showing `T-1s` still has time on it. Rounding down
 * would show `T-0s` for a whole second while the player can still act, which teaches them that
 * the number is a lie.
 *
 * @param {object} ticket an entry from the director's `upcoming()`
 * @returns {string} e.g. `T-8s  DEMAND SURGE`, or an empty string for a malformed ticket
 */
export function formatTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return '';
  const label = typeof ticket.label === 'string' && ticket.label
    ? ticket.label
    : (typeof ticket.id === 'string' ? ticket.id : '');
  if (!label) return '';
  if (!Number.isFinite(ticket.in_s)) return label.toUpperCase();
  const t = Math.max(0, Math.ceil(ticket.in_s));
  return `T-${t}s  ${label.toUpperCase()}`;
}

/**
 * The mission title carried by a view, whether the view holds the record or only its id.
 * @param {object|null} view a `gameView()` snapshot
 * @returns {string} the title, or an em dash
 */
function missionTitle(view) {
  const m = view && view.mission;
  if (!m) return '—';
  if (typeof m === 'string') {
    const rec = missionById(m);
    return rec ? rec.title : m;
  }
  if (typeof m === 'object' && typeof m.title === 'string') return m.title;
  return '—';
}

/**
 * The eight status readouts, as data.
 *
 * Returned as descriptors rather than written straight to elements so that the rules about what
 * turns amber — the last ten seconds, a trace outside the band, a failed shift — are testable
 * without a browser. Those rules are the whole content of this function; the strings around them
 * are trivial.
 *
 * @param {object|null} view a `gameView()` snapshot, or null when no session exists
 * @param {string} [unit] the controlled variable's engineering unit
 * @returns {Array<{key:string, tag:string, value:string, unit:string, mod:string}>} the readouts,
 *   always the same eight in the same order
 */
export function statusReadouts(view, unit) {
  const v = (view && typeof view === 'object') ? view : null;
  const phase = v && typeof v.phase === 'string' ? v.phase.toUpperCase() : '';
  const idle = !phase || phase === 'IDLE';
  const playing = phase === 'PLAY';
  const failed = phase === 'FAILED';

  // Nothing is running: show the shape of the panel, not eight zeroes that look like a score of 0.
  if (idle) {
    return [
      ['mode', 'MODE'], ['phase', 'PHASE'], ['mission', 'SHIFT'], ['left', 'TIME LEFT'],
      ['score', 'SCORE'], ['mult', 'MULTIPLIER'], ['band', 'BAND'], ['hold', 'HELD'],
    ].map(([key, tag]) => ({
      key,
      tag,
      value: key === 'phase' ? phaseLabel(phase || 'IDLE') : '—',
      unit: '',
      mod: 'off',
    }));
  }

  const lowTime = playing && Number.isFinite(v.left_s) && v.left_s <= 10;
  const outOfBand = playing && v.inBand === false;

  return [
    { key: 'mode', tag: 'MODE', value: modeLabel(v.mode), unit: '', mod: '' },
    { key: 'phase', tag: 'PHASE', value: phaseLabel(phase), unit: '', mod: failed ? 'alarm' : '' },
    { key: 'mission', tag: 'SHIFT', value: missionTitle(v), unit: '', mod: '' },
    {
      key: 'left',
      tag: 'TIME LEFT',
      value: formatCountdown(v.left_s),
      unit: '',
      mod: lowTime ? 'warn' : '',
    },
    {
      key: 'score',
      tag: 'SCORE',
      value: formatPoints(v.score),
      unit: '',
      mod: failed ? 'alarm' : '',
    },
    { key: 'mult', tag: 'MULTIPLIER', value: formatMult(v.mult), unit: '', mod: '' },
    {
      key: 'band',
      tag: 'BAND',
      value: formatBand(v.band, unit),
      unit: '',
      mod: outOfBand ? 'warn' : '',
    },
    {
      key: 'hold',
      tag: 'HELD',
      value: Number.isFinite(v.holdTime_s) ? dur(v.holdTime_s) : '—',
      unit: '',
      mod: '',
    },
  ];
}

/**
 * Render a seed as the share code the player copies out.
 * @param {number|string|null|undefined} seed the run's seed
 * @returns {string} the code, or an em dash when there is no seed to show
 */
export function formatSeedCode(seed) {
  if (seed === null || seed === undefined || seed === '') return '—';
  if (typeof seed === 'number' && !Number.isFinite(seed)) return '—';
  return seedCode(seed);
}

/**
 * Read a share code the player typed.
 *
 * The length is checked before the code is parsed only so the refusal can say something useful.
 * `parseSeedCode` already refuses everything this does; it simply cannot say WHICH thing was
 * wrong, and "that is seven characters" is the difference between a player fixing the typo and a
 * player deciding the feature is broken.
 *
 * @param {string} text the code as typed, dashes and case as they like
 * @returns {{ok:true, seed:number, code:string}|{ok:false, reason:string}} the seed, or a refusal
 */
export function readSeedCode(text) {
  const raw = typeof text === 'string' ? text : '';
  const clean = raw.toUpperCase().replace(/[\s-]+/g, '');
  if (clean.length === 0) {
    return { ok: false, reason: 'Type a share code first — eight characters, like ABCD-EFGH.' };
  }
  if (clean.length !== CODE_GLYPHS) {
    return {
      ok: false,
      reason: `A share code is ${CODE_GLYPHS} characters, like ABCD-EFGH. That one is ${clean.length}.`,
    };
  }
  const seed = parseSeedCode(clean);
  if (seed === null) {
    return {
      ok: false,
      reason: 'That is not a code this build produced — check for a mistyped character.',
    };
  }
  return { ok: true, seed, code: seedCode(seed) };
}

/**
 * What the RETRY button should do, given what is on screen.
 *
 * Kept out of the click handler because "retry" means four different things across the modes and
 * one of them is not possible: an endless or daily run can be replayed from its seed, a mission
 * from its id, and a fault hunt from its seed, but free play has nothing to restart.
 *
 * @param {object|null} view a `gameView()` snapshot
 * @returns {{ok:true, action:string, args:Array}|{ok:false, reason:string}} the call to make
 */
export function retryPlan(view) {
  const v = (view && typeof view === 'object') ? view : null;
  if (!v) return { ok: false, reason: 'There is no shift to run again.' };
  const mode = typeof v.mode === 'string' ? v.mode.toUpperCase() : '';
  const m = v.mission;
  const missionId = typeof m === 'string' ? m : (m && typeof m.id === 'string' ? m.id : null);

  if (mode === 'CAMPAIGN' || (missionId && mode !== 'ENDLESS' && mode !== 'DAILY' && mode !== 'FAULT')) {
    if (!missionId) return { ok: false, reason: 'No mission is loaded to run again.' };
    return { ok: true, action: 'startMission', args: [missionId] };
  }
  if (mode === 'ENDLESS') {
    if (!Number.isFinite(v.seed)) return { ok: false, reason: 'This endless run carries no seed to repeat.' };
    return { ok: true, action: 'startEndless', args: [v.seed] };
  }
  if (mode === 'DAILY') {
    if (typeof v.dateStr !== 'string' || !v.dateStr) {
      return { ok: false, reason: 'This daily run carries no date to repeat.' };
    }
    return { ok: true, action: 'startDaily', args: [v.dateStr] };
  }
  if (mode === 'FAULT') {
    if (!Number.isFinite(v.seed)) return { ok: false, reason: 'This fault hunt carries no seed to repeat.' };
    return { ok: true, action: 'startFaultHunt', args: [v.seed] };
  }
  return { ok: false, reason: 'Free play has nothing to restart — pick a mission first.' };
}

/**
 * A two-click guard for a destructive button.
 *
 * A browser `confirm()` would be one line, and it is banned here for two reasons: it stops the
 * animation frame dead, which on a running rig means the trend and the plant freeze mid-shift, and
 * it is styled by the browser rather than by the control room. The replacement is a button that
 * changes its own label and disarms itself after a few seconds.
 *
 * Time arrives as an argument on every call so the machine can be tested without waiting, and so
 * the panel can feed it the same clock the rest of the frame uses.
 *
 * @param {number} [window_ms] how long the armed state survives; the default for nonsense input
 * @returns {{window_ms:number, press:Function, isArmed:Function, remaining_s:Function,
 *   label:Function, cancel:Function}} the machine
 */
export function createConfirm(window_ms = CONFIRM_WINDOW_MS) {
  const win = Number.isFinite(window_ms) && window_ms > 0 ? window_ms : CONFIRM_WINDOW_MS;
  let armedAt = null;

  /**
   * Whether the guard is armed at a given instant.
   * @param {number} now_ms the clock
   * @returns {boolean} true while the window is open
   */
  function isArmed(now_ms) {
    if (armedAt === null || !Number.isFinite(now_ms)) return false;
    // A clock that has gone backwards is not evidence that the player just clicked twice.
    return now_ms >= armedAt && now_ms - armedAt < win;
  }

  return {
    window_ms: win,
    isArmed,

    /**
     * Register a click.
     * @param {number} now_ms the clock, in milliseconds
     * @returns {string} `'armed'` on the first click, `'fired'` on the confirming one, or
     *   `'refused'` when the clock could not be read
     */
    press(now_ms) {
      if (!Number.isFinite(now_ms)) {
        // Never confirm a destructive action against a clock we cannot read: disarm and say so.
        armedAt = null;
        return 'refused';
      }
      if (isArmed(now_ms)) { armedAt = null; return 'fired'; }
      armedAt = now_ms;
      return 'armed';
    },

    /**
     * Seconds left on the armed window.
     * @param {number} now_ms the clock
     * @returns {number} the remaining seconds, or 0 when not armed
     */
    remaining_s(now_ms) {
      if (!isArmed(now_ms)) return 0;
      return (win - (now_ms - armedAt)) / 1000;
    },

    /**
     * The label the button should be showing.
     * @param {number} now_ms the clock
     * @param {string} idle the resting label
     * @param {string} armed the label while the guard is open
     * @returns {string} whichever applies
     */
    label(now_ms, idle, armed) {
      return isArmed(now_ms) ? armed : idle;
    },

    /**
     * Disarm, without firing. Called when the panel is hidden or the pointer leaves.
     * @returns {void}
     */
    cancel() { armedAt = null; },
  };
}

/**
 * Coerce anything that came back out of storage into a usable preference set.
 *
 * `'false'` is accepted as false because these values are also the ones a curious player edits by
 * hand in devtools, and a string `'false'` read as truthy is the one mistake that turns a
 * deliberate "off" into an "on".
 *
 * @param {*} raw the parsed candidate
 * @returns {{audio:boolean, volume:number, ghost:boolean, band:boolean}} a complete preference set
 */
export function normalisePrefs(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  /**
   * @param {string} k the key
   * @returns {boolean} the stored flag, or its default
   */
  const flag = (k) => {
    const v = src[k];
    if (v === undefined || v === null) return DEFAULT_PREFS[k];
    if (v === 'false' || v === '0') return false;
    return !!v;
  };
  const vol = Number(src.volume);
  return {
    audio: flag('audio'),
    volume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : DEFAULT_PREFS.volume,
    ghost: flag('ghost'),
    band: flag('band'),
  };
}

/**
 * Read the preferences from a storage that may be absent, empty, full of junk, or throwing.
 * @param {{getItem:Function}|null} storage anything localStorage-shaped, or null
 * @returns {{audio:boolean, volume:number, ghost:boolean, band:boolean}} a complete set; the
 *   defaults whenever the stored value cannot be used
 */
export function loadPrefs(storage) {
  if (!storage || typeof storage.getItem !== 'function') return normalisePrefs(null);
  let text = null;
  try {
    text = storage.getItem(PREFS_KEY);
  } catch {
    // Private browsing and blocked site data both throw here rather than returning null.
    return normalisePrefs(null);
  }
  if (typeof text !== 'string' || !text) return normalisePrefs(null);
  try {
    return normalisePrefs(JSON.parse(text));
  } catch {
    return normalisePrefs(null);
  }
}

/**
 * Write the preferences back, refusing rather than throwing when storage will not take them.
 * @param {{setItem:Function}|null} storage anything localStorage-shaped, or null
 * @param {object} prefs the preferences to keep
 * @returns {{ok:boolean, reason?:string}} whether they were kept
 */
export function savePrefs(storage, prefs) {
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, reason: 'This browser is not offering any storage, so the settings will not survive a reload.' };
  }
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(normalisePrefs(prefs)));
    return { ok: true };
  } catch {
    return { ok: false, reason: 'The browser refused to store the settings — its storage is full or blocked.' };
  }
}

/**
 * Fetch the current game snapshot from the action surface, whichever way the integrator wired it.
 *
 * Deliberately does not import `src/game/session.js`. This panel has to render — and be tested —
 * in a build where the session module is absent or half-written, and an import would take the
 * whole rail down with it.
 *
 * @param {object|null} A the bound action surface
 * @returns {object|null} the view snapshot, or null when there is no session
 */
export function readGameView(A) {
  if (!A || typeof A !== 'object') return null;
  try {
    if (typeof A.gameView === 'function') return A.gameView() || null;
    const g = A.game;
    if (!g) return null;
    if (typeof g.view === 'function') return g.view() || null;
    if (g.view && typeof g.view === 'object') return g.view;
    return null;
  } catch {
    // A view that throws must cost the panel one frame, not the whole rail.
    return null;
  }
}

// ==============================================================================================
// The panels
// ==============================================================================================

/**
 * A labelled on/off switch. A private copy of the one in `panels.js` — that one is not exported,
 * and reaching into another agent's file for it would couple two panels that have no other reason
 * to know about each other.
 * @param {string} label the text
 * @param {boolean} value initial state
 * @param {string} hint title text
 * @param {(v:boolean)=>void} onChange called with the new state
 * @returns {HTMLElement} the row, with `.set(v)`
 */
function toggle(label, value, hint, onChange) {
  const input = h('input', { type: 'checkbox', class: 'tog__box', onChange: () => onChange(input.checked) });
  input.checked = !!value;
  const el = h('label', { class: 'tog', title: hint || '' },
    input, h('span', { class: 'tog__label', text: label }));
  el.set = (v) => { if (document.activeElement !== input) input.checked = !!v; };
  return el;
}

/**
 * The live shift: what is running, how it is going, and the two buttons that change that.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @param {{get:Function}} view a holder giving the current snapshot
 * @returns {HTMLElement} the panel, with `.update()`
 */
function shiftPanel(ctx, A, view) {
  const ros = new Map();
  const grid = h('div', { class: 'ro__grid' });
  for (const d of statusReadouts(null)) {
    const r = readout(d.tag, '', '');
    ros.set(d.key, r);
    grid.append(r);
  }

  const ticker = h('div', { class: 'gp__ticker' });
  const message = h('div', { class: 'note note--sm' });

  const btnAbort = h('button', {
    class: 'btn', type: 'button', text: 'Abort shift',
    title: 'End the shift now. Nothing is scored and nothing is recorded against the profile.',
    onClick: () => {
      if (typeof A.abortGame !== 'function') { A.toast('this build has no game session to abort', 'warn'); return; }
      A.abortGame();
    },
  });
  const btnRetry = h('button', {
    class: 'btn', type: 'button', text: 'Run it again',
    title: 'Start the same shift over, on the same rig and the same script.',
    onClick: () => {
      const plan = retryPlan(view.get());
      if (!plan.ok) { A.toast(plan.reason, 'warn'); return; }
      const fn = A[plan.action];
      if (typeof fn !== 'function') { A.toast(`this build cannot ${plan.action}`, 'warn'); return; }
      fn(...plan.args);
    },
  });

  const phaseChip = h('span', { class: 'chip gp__phase', text: '—' });
  const el = panel('SHIFT', { cls: 'panel--game', tools: phaseChip },
    grid, ticker, message,
    h('div', { class: 'btnrow' }, btnAbort, btnRetry));

  el.update = () => {
    const v = view.get();
    const unit = loopUnit(ctx);
    for (const d of statusReadouts(v, unit)) {
      const r = ros.get(d.key);
      if (r) r.set(d.value, d.mod);
    }

    const phase = v && typeof v.phase === 'string' ? v.phase.toUpperCase() : 'IDLE';
    setText(phaseChip, phaseLabel(phase));
    cls(phaseChip, 'is-on', phase === 'PLAY');
    cls(phaseChip, 'is-alarm', phase === 'FAILED');

    // The ticker is rebuilt only when its text changes: it is three short lines, and diffing them
    // is cheaper than replacing three elements sixty times a second for a countdown that only
    // moves once a second.
    const tickets = (v && Array.isArray(v.upcoming) ? v.upcoming : []).slice(0, 3)
      .map(formatTicket).filter((s) => s.length > 0);
    if (tickets.length !== ticker.childElementCount
        || tickets.some((t, i) => ticker.children[i].textContent !== t)) {
      ticker.textContent = '';
      for (const t of tickets) ticker.append(h('div', { class: 'gp__ticket', text: t }));
    }

    const live = phase !== 'IDLE';
    btnAbort.disabled = !live;
    btnRetry.disabled = !retryPlan(v).ok;
    setText(message, (v && typeof v.message === 'string' && v.message)
      ? v.message
      : 'Nothing is running. Pick a shift from the arcade, or work the rig in free play.');
  };
  return el;
}

/**
 * Sound and the two overlays the player is allowed to turn off.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @param {object} prefs the live preference set, mutated in place
 * @param {Function} commit called after any change, to persist and to apply
 * @returns {HTMLElement} the panel, with `.update()`
 */
function optionsPanel(ctx, A, prefs, commit) {
  const togAudio = toggle('Sound', prefs.audio,
    'Cues for the band edge, the multiplier, the countdown and the alarms. Everything is '
    + 'synthesised in the page — there are no files and no network.',
    (on) => { prefs.audio = on; commit(); });

  const volume = slider({
    label: 'Volume', unit: '%', value: Math.round(prefs.volume * 100), min: 0, max: 100, step: 5, dp: 0,
    hint: 'Master level for every cue.',
    onInput: (v) => { prefs.volume = Math.min(1, Math.max(0, v / 100)); commit(); },
  });

  const togBand = toggle('Show the tolerance band', prefs.band,
    'The shaded band either side of setpoint on the trend. Turning it off does not change the '
    + 'scoring — the band is still there, you just cannot see it.',
    (on) => { prefs.band = on; commit(); });

  const togGhost = toggle('Show the ghost trace', prefs.ghost,
    'Your best previous run of this shift, drawn faintly behind the live trace.',
    (on) => { prefs.ghost = on; commit(); });

  const note = h('div', { class: 'note note--sm' });
  const el = panel('DISPLAY & SOUND', { cls: 'panel--game' },
    togAudio, volume, togBand, togGhost, note);

  el.update = () => {
    togAudio.set(prefs.audio);
    togBand.set(prefs.band);
    togGhost.set(prefs.ghost);
    cls(volume, 'is-disabled', !prefs.audio);
    volume.input.disabled = !prefs.audio;
    if (document.activeElement !== volume.input) {
      const pct = Math.round(prefs.volume * 100);
      volume.input.value = String(pct);
      setText(volume.read, `${pct} %`);
    }
    setText(note, prefs.stored === false
      ? 'These settings will not survive a reload — this browser is not offering storage.'
      : 'Kept in this browser only.');
  };
  return el;
}

/**
 * The seed for the run on the bench, and the field for playing somebody else's.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @param {{get:Function}} view a holder giving the current snapshot
 * @returns {HTMLElement} the panel, with `.update()`
 */
function seedPanel(ctx, A, view) {
  const code = h('b', { class: 'gp__code', text: '—' });
  const btnCopy = h('button', {
    class: 'btn btn--sm', type: 'button', text: 'Copy',
    title: 'Put the code on the clipboard, to send to somebody who wants the same rig.',
    onClick: () => {
      const text = code.textContent;
      if (!text || text === '—') { A.toast('this run has no share code', 'warn'); return; }
      copyText(text).then((ok) => {
        A.toast(ok ? `share code ${text} copied` : `share code is ${text}`, ok ? '' : 'warn');
      });
    },
  });

  const entry = h('input', {
    class: 'field__input gp__entry', type: 'text', spellcheck: 'false',
    autocapitalize: 'characters', placeholder: 'ABCD-EFGH', maxlength: '12',
    onKeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); useCode(); } },
  });
  const btnUse = h('button', {
    class: 'btn', type: 'button', text: 'Play this rig',
    title: 'Start an endless run on the rig and upset script that code describes.',
    onClick: () => useCode(),
  });

  /**
   * Validate what was typed and start the run it names.
   * @returns {void}
   */
  function useCode() {
    const res = readSeedCode(entry.value);
    if (!res.ok) { A.toast(res.reason, 'warn'); return; }
    if (typeof A.startEndless !== 'function') { A.toast('this build cannot start an endless run', 'warn'); return; }
    entry.value = res.code;
    A.startEndless(res.seed);
  }

  const el = panel('SHARE CODE', { cls: 'panel--game', tools: btnCopy },
    h('div', { class: 'gp__seed' }, code),
    h('div', { class: 'gp__entryrow' }, entry, btnUse),
    h('div', {
      class: 'note note--sm',
      text: 'A code names one rig and one upset script exactly. The same code plays the same '
        + 'shift on any machine, which is what makes two scores worth comparing.',
    }));

  el.update = () => {
    const v = view.get();
    setText(code, formatSeedCode(v && Number.isFinite(v.seed) ? v.seed : null));
  };
  return el;
}

/**
 * The player's record, and the three things they can do to it.
 * @param {object} ctx the sim context
 * @param {object} A the bound actions
 * @param {Function} nowMs the clock, in milliseconds
 * @returns {HTMLElement} the panel, with `.update()`
 */
function profilePanel(ctx, A, nowMs) {
  const ros = {
    rank: readout('RANK', '', 'Earned across every mode. The roster runs Trainee to Plant Superintendent.'),
    xp: readout('XP', '', 'Experience: points scored, medals taken, waves survived.'),
    cleared: readout('CAMPAIGN', '', 'Missions cleared at least once, of the whole campaign.'),
    medals: readout('MEDALS', '', 'Gold, silver and bronze held across the campaign.'),
    badges: readout('BADGES', '', 'Awarded for things the scoring engine actually measured.'),
    unlocks: readout('FEATURES', '', 'Controller features earned. Each one arrives after the shift that needed it.'),
  };
  const bar = h('i', { class: 'gp__progfill' });
  const progNote = h('div', { class: 'note note--sm' });

  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', class: 'hidden-file',
    onChange: async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const p = A.profile;
      if (!p) { A.toast('there is no profile to import into', 'warn'); return; }
      let text = '';
      try {
        text = await f.text();
      } catch (e) {
        A.toast(`could not read that file: ${e.message}`, 'warn');
        return;
      }
      const res = importProfile(p, text);
      if (!res.ok) { A.toast(res.problems[0] || 'that file held no profile', 'warn'); return; }
      if (typeof A.saveProfile === 'function') A.saveProfile();
      A.toast(res.problems.length
        ? `profile imported with ${res.problems.length} problem(s): ${res.problems[0]}`
        : 'profile imported', res.problems.length ? 'warn' : '');
    },
  });

  const btnExport = h('button', {
    class: 'btn', type: 'button', text: 'Export profile',
    title: 'Save the whole record — XP, medals, unlocks, badges and bests — as a JSON file.',
    onClick: () => {
      const p = A.profile;
      if (!p) { A.toast('there is no profile to export', 'warn'); return; }
      download(timestampedName('skid-profile', 'json'), exportProfile(p), 'application/json');
    },
  });
  const btnImport = h('button', {
    class: 'btn', type: 'button', text: 'Import profile',
    title: 'Replace the record with one from a file. Everything currently held is overwritten.',
    onClick: () => fileInput.click(),
  });

  // The reset is the only control on the rail that destroys something the player cannot get back,
  // so it is the only one that is armed rather than pressed.
  const guard = createConfirm(CONFIRM_WINDOW_MS);
  const btnReset = h('button', {
    class: 'btn btn--danger', type: 'button', text: 'Reset profile',
    title: 'Erase XP, medals, unlocks, badges and every best score. Takes two clicks.',
    onClick: () => {
      const state = guard.press(nowMs());
      if (state === 'refused') { A.toast('could not read the clock — nothing was erased', 'warn'); return; }
      if (state === 'armed') { A.toast('click again to erase the profile', 'warn'); return; }
      if (typeof A.resetProfile !== 'function') { A.toast('this build cannot reset the profile', 'warn'); return; }
      A.resetProfile();
      A.toast('profile erased — back to Trainee');
    },
    onMouseleave: () => { guard.cancel(); },
  });

  const el = panel('PROFILE', { cls: 'panel--game' },
    h('div', { class: 'ro__grid' }, Object.values(ros)),
    h('div', { class: 'gp__prog' }, bar),
    progNote,
    h('div', { class: 'btnrow' }, btnExport, btnImport),
    h('div', { class: 'btnrow' }, btnReset),
    fileInput);

  el.update = () => {
    const p = A.profile;
    if (!p) {
      for (const r of Object.values(ros)) r.set('—', 'off');
      bar.style.width = '0%';
      setText(progNote, 'No profile is loaded, so nothing is being recorded.');
      return;
    }
    const xp = Number.isFinite(p.xp) ? p.xp : 0;
    const rank = rankFor(xp);
    const next = nextRankFor(xp);
    ros.rank.set(rank.title);
    ros.xp.set(formatPoints(xp));

    const cleared = MISSIONS.filter((m) => missionCleared(p, m.id)).length;
    ros.cleared.set(`${cleared} / ${MISSIONS.length}`, cleared === 0 ? 'off' : '');

    const st = (p.stats && typeof p.stats === 'object') ? p.stats : {};
    const g = Number.isFinite(st.gold) ? st.gold : 0;
    const s = Number.isFinite(st.silver) ? st.silver : 0;
    const b = Number.isFinite(st.bronze) ? st.bronze : 0;
    ros.medals.set(`${g} / ${s} / ${b}`, g + s + b === 0 ? 'off' : '');

    const badges = Array.isArray(p.badges) ? p.badges.length : 0;
    ros.badges.set(String(badges), badges === 0 ? 'off' : '');

    const held = Array.isArray(p.unlocks) ? p.unlocks.filter((id) => id in UNLOCKS).length : 0;
    ros.unlocks.set(`${held} / ${UNLOCK_ORDER.length}`, held <= 1 ? 'off' : '');

    if (next) {
      const span = Math.max(1, next.xp - rank.xp);
      bar.style.width = `${Math.min(100, Math.max(0, ((xp - rank.xp) / span) * 100))}%`;
      setText(progNote, `${formatPoints(next.xp - xp)} XP to ${next.title}.`);
    } else {
      bar.style.width = '100%';
      setText(progNote, `${RANKS[RANKS.length - 1].title} — the top of the roster.`);
    }

    setText(btnReset, guard.label(nowMs(), 'Reset profile', 'Click again to erase everything'));
    cls(btnReset, 'is-armed', guard.isArmed(nowMs()));
  };
  return el;
}

// ==============================================================================================
// Small environment helpers — the only places this file touches anything outside the DOM
// ==============================================================================================

/**
 * The engineering unit of the controlled variable, without importing the sim's query surface.
 * @param {object} ctx the sim context
 * @returns {string} the unit, or an empty string when the context cannot be read
 */
function loopUnit(ctx) {
  try {
    const eu = ctx && ctx.run ? LOOP_UNITS[ctx.run.mode] : null;
    return eu || '';
  } catch {
    return '';
  }
}

/**
 * The unit of each loop mode. A two-entry table rather than an import of `loopEU(ctx)`, because
 * this panel wants a unit for a label and does not want the whole engineering-unit record, and
 * because it must still render if the context handed in is a stub.
 */
const LOOP_UNITS = Object.freeze({ PRESSURE: 'bar', FLOW: 'm³/h' });

/**
 * Put text on the clipboard, degrading to a refusal rather than throwing.
 *
 * The clipboard API is gated on a secure context and on a permission the player may have refused,
 * and it rejects rather than returning false. Anything that fails here is reported to the player
 * by showing them the code instead, which is not much worse than copying it.
 *
 * @param {string} text what to copy
 * @returns {Promise<boolean>} whether it landed
 */
function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard
        && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
  } catch { /* fall through */ }
  return Promise.resolve(false);
}

/**
 * The browser's own storage, if it is offering one.
 * @returns {{getItem:Function, setItem:Function}|null} the store, or null
 */
function browserStorage() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
  } catch {
    // Blocked site data throws on the property access itself, not on the first call.
    return null;
  }
}

// ==============================================================================================
// The tab
// ==============================================================================================

/**
 * Build the GAME tab: four panels for the rail's fifth tab.
 *
 * The returned object satisfies the module contract (`{el, update}`) and ALSO carries `update` on
 * the element itself, so it can be dropped straight into `createRail`'s `panels` array, which
 * expects elements that update themselves.
 *
 * @param {object} ctx the sim context
 * @param {object} A the bound actions, including `A.game`, `A.profile` and the game actions
 * @returns {{el:HTMLElement, update:Function, prefs:object}} the tab
 */
export function createGamePanel(ctx, A) {
  const store = browserStorage();
  const prefs = loadPrefs(store);
  // Recorded so the options panel can say the settings will not survive, rather than pretending.
  prefs.stored = savePrefs(store, prefs).ok;

  // The view is fetched once per frame and shared by the panels that need it: `gameView()` is
  // documented as allocation-light but it is not free, and three panels asking for it separately
  // is three snapshots of the same instant.
  let snapshot = null;
  const view = { get: () => snapshot };

  /**
   * Persist the preferences and push them at whatever the integrator wired up.
   * @returns {void}
   */
  function commit() {
    prefs.stored = savePrefs(store, prefs).ok;
    if (ctx && typeof ctx === 'object') {
      // The rest of the UI reads the prefs from the context, which is the one object every layer
      // already holds. See the integration notes: hud.js and trend.js read `showBand`/`showGhost`.
      ctx.gamePrefs = ctx.gamePrefs || {};
      ctx.gamePrefs.showBand = prefs.band;
      ctx.gamePrefs.showGhost = prefs.ghost;
      ctx.gamePrefs.audio = prefs.audio;
      ctx.gamePrefs.volume = prefs.volume;
    }
    if (typeof A.setAudio === 'function') A.setAudio(prefs.audio, prefs.volume);
  }
  commit();

  /**
   * The wall clock, in milliseconds, for the reset guard only.
   * @returns {number} the clock, or NaN when there is none — which the guard treats as a refusal
   */
  const nowMs = () => {
    try {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
      }
      return Date.now();
    } catch {
      return NaN;
    }
  };

  const panels = [
    shiftPanel(ctx, A, view),
    optionsPanel(ctx, A, prefs, commit),
    seedPanel(ctx, A, view),
    profilePanel(ctx, A, nowMs),
  ];
  const el = h('div', { class: 'gp' }, panels);

  /**
   * Repaint the tab. Cheap enough to call every frame the tab is visible.
   * @returns {void}
   */
  function update() {
    snapshot = readGameView(A);
    for (const p of panels) p.update();
  }

  el.update = update;
  return { el, update, prefs };
}
