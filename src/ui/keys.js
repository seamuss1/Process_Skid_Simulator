/**
 * src/ui/keys.js — the keyboard layer: one registry of every shortcut, chord matching, a help
 * card generated from that registry, and a command palette that enumerates the bound action
 * surface instead of listing it by hand.
 *
 * Layer L6. Imports `data/config.js`, `control/pid.js` and `./dom.js`. Everything above the
 * `installKeys` line is pure and is what `tests/tour.test.js` exercises; the DOM is touched only
 * inside the two factory functions at the bottom, and only when they are called.
 *
 * ------------------------------------------------------------------------------------------
 * THREE PROBLEMS, ONE TABLE
 *
 * A keyboard layer that grows organically fails in three ways, and all three have the same root
 * cause — the binding and the documentation of the binding are two different pieces of code.
 *
 *   THE HELP CARD DRIFTS.  Somebody rebinds a key and forgets the card. Now the card is worse
 *                          than nothing: it teaches the wrong key and destroys trust in every
 *                          other line on it. Here the card is BUILT FROM the registry, and
 *                          `register()` refuses a binding with no label or section, so a shortcut
 *                          that is not documented cannot exist in the first place.
 *
 *   TWO BINDINGS COLLIDE.  The second one silently never fires, or both fire. `register()`
 *                          refuses the second one and says which binding it would have shadowed.
 *                          The same check catches the subtler PREFIX collision: once `g` fires on
 *                          its own, the chord `g p` can never complete, because the first stroke
 *                          has already run something.
 *
 *   THE BROWSER WINS.      Ctrl-T, Ctrl-W and Ctrl-N never reach the page at all, so a rig that
 *                          binds them appears broken to the user in the most alarming way
 *                          available: their work disappears into a new tab. `BROWSER_KEYS` below
 *                          splits those from the merely CONTESTED ones (Ctrl-K, Ctrl-F, Ctrl-S),
 *                          which do reach the page and can be taken — but only deliberately, by a
 *                          binding that passes a `claim` string saying what it is taking and why.
 * ------------------------------------------------------------------------------------------
 */

import { LOOP } from '../data/config.js';
import { MODE } from '../control/pid.js';
import { h } from './dom.js';

// =============================================================================================
// 1. STROKES AND CHORDS
// =============================================================================================

/**
 * Names for keys whose `KeyboardEvent.key` is not what a human would write in a help card, plus
 * the spellings people actually type into a binding table. Everything here resolves to the
 * canonical form on the right, which is the exact string `KeyboardEvent.key` reports — except
 * `Space`, whose real key value is a single blank and would be invisible in every table it
 * appeared in.
 */
const KEY_ALIASES = Object.freeze({
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  slash: '/',
  comma: ',',
  period: '.',
  question: '?',
  plus: '+',
  minus: '-',
});

/** Modifier spellings accepted in a binding string. */
const MOD_ALIASES = Object.freeze({
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'ctrl',
  command: 'ctrl',
  meta: 'ctrl',
  super: 'ctrl',
  win: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
});

/**
 * How long a half-finished chord waits for its second stroke. Long enough to be typed by a person
 * reading the help card, short enough that a stray `g` does not swallow the next real keystroke.
 */
export const CHORD_TIMEOUT_MS = 1500;

/**
 * Canonicalise one key name.
 * @param {string} raw the name as written or as reported by the browser
 * @returns {string} the canonical name: a lower-case single character, or a `KeyboardEvent.key`
 *   spelling such as `Escape`, `ArrowUp`, `F5`, or the pseudo-name `Space`
 */
function canonKey(raw) {
  const t = String(raw);
  const lower = t.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower)) return KEY_ALIASES[lower];
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, t)) return KEY_ALIASES[t];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return `F${lower.slice(1)}`;
  if (t.length === 1) return lower;
  // An unknown multi-character name is passed through with its first letter capitalised, which is
  // how every `KeyboardEvent.key` spelling of a named key is written.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Build a stroke.
 * @param {string} key canonical key name
 * @param {object} [mods] modifier flags
 * @returns {{key:string, ctrl:boolean, alt:boolean, shift:boolean}} the stroke
 */
function stroke(key, mods) {
  return {
    key,
    ctrl: !!(mods && mods.ctrl),
    alt: !!(mods && mods.alt),
    shift: !!(mods && mods.shift),
  };
}

/**
 * True when a stroke's key is a printable character that is not a letter — `?`, `/`, `1`, `+`.
 *
 * These are the keys whose shift state is already baked into the character: the browser reports
 * `?` with `shiftKey` true, because `?` IS shift-slash on a US layout and something else entirely
 * on a German one. Comparing the shift flag on those would mean `?` never matched anything, which
 * is exactly the bug that makes a help key mysteriously dead on some keyboards.
 * @param {string} key canonical key name
 * @returns {boolean} whether shift must be ignored when matching this key
 */
function shiftIsImplicit(key) {
  return key.length === 1 && !/[a-z]/.test(key);
}

/**
 * Parse a binding string into a chord.
 *
 * Accepts `Ctrl-K`, `ctrl+k`, `Shift-?`, `Space`, and multi-stroke chords written either as
 * `g p` or as `g then p`. Modifier separators are `-` and `+`; a trailing separator is read as
 * the literal key, so `Ctrl+-` and `Ctrl++` parse the way they look.
 * @param {string} text the binding string
 * @returns {{ok:true, chord:object}|{ok:false, reason:string}} the parsed chord, or why not
 */
export function parseChord(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'a binding needs a key: got an empty string' };
  }
  const words = text.trim().split(/\s+/).filter((w) => w.toLowerCase() !== 'then');
  if (!words.length) return { ok: false, reason: `"${text}" names no key at all` };
  if (words.length > 3) {
    return { ok: false, reason: `"${text}" is ${words.length} strokes; nobody remembers past three` };
  }
  const steps = [];
  for (const word of words) {
    // Split on separators but keep a trailing one as the key itself: 'ctrl+-' -> ['ctrl',''] with
    // the '-' lost, so the empty tail is restored from the original text.
    const parts = word.split(/[-+]/);
    if (parts[parts.length - 1] === '') parts[parts.length - 1] = word.charAt(word.length - 1);
    const mods = { ctrl: false, alt: false, shift: false };
    for (let i = 0; i < parts.length - 1; i += 1) {
      const m = MOD_ALIASES[parts[i].toLowerCase()];
      if (!m) return { ok: false, reason: `"${parts[i]}" in "${text}" is not a modifier` };
      mods[m] = true;
    }
    const key = canonKey(parts[parts.length - 1]);
    if (!key) return { ok: false, reason: `"${word}" names no key` };
    if (shiftIsImplicit(key)) mods.shift = false;
    steps.push(stroke(key, mods));
  }
  const chord = { steps, id: chordIdOf(steps) };
  chord.text = formatChord(chord);
  return { ok: true, chord: Object.freeze({ ...chord, steps: Object.freeze(steps.map(Object.freeze)) }) };
}

/**
 * The canonical identity of a stroke sequence, used as the collision key.
 * @param {Array<object>} steps the strokes
 * @returns {string} e.g. `ctrl+k`, or `g|p`
 */
function chordIdOf(steps) {
  return steps.map((s) => `${s.ctrl ? 'ctrl+' : ''}${s.alt ? 'alt+' : ''}${s.shift ? 'shift+' : ''}${s.key}`)
    .join('|');
}

/**
 * Render a chord the way the help card shows it.
 * @param {object} chord a parsed chord
 * @returns {string} e.g. `Ctrl-K`, `G then P`, `Shift-?`
 */
export function formatChord(chord) {
  if (!chord || !Array.isArray(chord.steps)) return '';
  const one = (s) => {
    const bits = [];
    if (s.ctrl) bits.push('Ctrl');
    if (s.alt) bits.push('Alt');
    if (s.shift) bits.push('Shift');
    bits.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
    return bits.join('-');
  };
  return chord.steps.map(one).join(' then ');
}

/**
 * Normalise a keyboard event into a stroke.
 *
 * The Command key is folded into `ctrl`. The rig has no binding that needs to tell them apart,
 * and a Mac user pressing Cmd-K expects the palette rather than a lecture about platforms.
 * @param {object} ev a `KeyboardEvent`, or anything carrying `key`, `ctrlKey`, `metaKey`,
 *   `altKey` and `shiftKey`
 * @returns {{key:string, ctrl:boolean, alt:boolean, shift:boolean}} the stroke
 */
export function strokeFromEvent(ev) {
  if (!ev || typeof ev.key !== 'string') return stroke('', {});
  const key = canonKey(ev.key);
  return stroke(key, {
    ctrl: !!(ev.ctrlKey || ev.metaKey),
    alt: !!ev.altKey,
    shift: shiftIsImplicit(key) ? false : !!ev.shiftKey,
  });
}

/**
 * Compare two strokes.
 * @param {object} a first stroke
 * @param {object} b second stroke
 * @returns {boolean} whether they are the same keystroke
 */
export function sameStroke(a, b) {
  if (!a || !b) return false;
  return a.key === b.key && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt
    && (shiftIsImplicit(a.key) || !!a.shift === !!b.shift);
}

// =============================================================================================
// 2. WHAT THE BROWSER ALREADY OWNS
// =============================================================================================

/**
 * Keystrokes the browser has already spent.
 *
 * `UNREACHABLE` never arrives at the page — Chrome and Firefox consume it in the chrome and no
 * `preventDefault` exists to run, because no event is dispatched. Binding one of these produces a
 * shortcut that appears to destroy the user's session, so `register()` refuses it outright and no
 * flag overrides that.
 *
 * `CONTESTED` does arrive and can be taken with `preventDefault`, but the browser has a visible
 * meaning for it and taking it costs the user something. A binding may claim one by passing
 * `claim: 'why this is worth taking'`, which is stored and shown on the help card, so the trade is
 * recorded next to the key rather than argued about later.
 */
export const BROWSER_KEYS = Object.freeze({
  'ctrl+t': Object.freeze({ level: 'UNREACHABLE', owner: 'new tab' }),
  'ctrl+n': Object.freeze({ level: 'UNREACHABLE', owner: 'new window' }),
  'ctrl+w': Object.freeze({ level: 'UNREACHABLE', owner: 'close tab' }),
  'ctrl+q': Object.freeze({ level: 'UNREACHABLE', owner: 'quit the browser' }),
  'ctrl+shift+t': Object.freeze({ level: 'UNREACHABLE', owner: 'reopen closed tab' }),
  'ctrl+shift+n': Object.freeze({ level: 'UNREACHABLE', owner: 'private window' }),
  'ctrl+shift+w': Object.freeze({ level: 'UNREACHABLE', owner: 'close window' }),
  'ctrl+Tab': Object.freeze({ level: 'UNREACHABLE', owner: 'next tab' }),
  'alt+F4': Object.freeze({ level: 'UNREACHABLE', owner: 'close window' }),
  F5: Object.freeze({ level: 'UNREACHABLE', owner: 'reload' }),
  F11: Object.freeze({ level: 'UNREACHABLE', owner: 'full screen' }),
  F12: Object.freeze({ level: 'UNREACHABLE', owner: 'developer tools' }),
  'ctrl+k': Object.freeze({ level: 'CONTESTED', owner: 'address-bar search' }),
  'ctrl+f': Object.freeze({ level: 'CONTESTED', owner: 'find in page' }),
  'ctrl+s': Object.freeze({ level: 'CONTESTED', owner: 'save page' }),
  'ctrl+p': Object.freeze({ level: 'CONTESTED', owner: 'print' }),
  'ctrl+d': Object.freeze({ level: 'CONTESTED', owner: 'bookmark' }),
  'ctrl+l': Object.freeze({ level: 'CONTESTED', owner: 'focus the address bar' }),
  'ctrl+o': Object.freeze({ level: 'CONTESTED', owner: 'open a file' }),
  'ctrl+h': Object.freeze({ level: 'CONTESTED', owner: 'history' }),
  'ctrl+j': Object.freeze({ level: 'CONTESTED', owner: 'downloads' }),
});

/**
 * What the browser does with the first stroke of a chord.
 *
 * Only the FIRST stroke matters: once `g` has been swallowed by the page, the `p` that follows is
 * an ordinary letter and the browser has no opinion about it.
 * @param {object} chord a parsed chord
 * @returns {{level:string, owner:string}|null} the browser's claim, or null if the key is free
 */
export function browserClaim(chord) {
  if (!chord || !Array.isArray(chord.steps) || !chord.steps.length) return null;
  const first = chordIdOf([chord.steps[0]]);
  return BROWSER_KEYS[first] || null;
}

// =============================================================================================
// 3. THE REGISTRY
// =============================================================================================

/** The context every binding lives in unless it names a view. */
export const GLOBAL = 'global';

/**
 * The sections of the help card, in the order it prints them. A binding must name one of these,
 * which is what stops the card from growing an "other" bucket that nobody reads.
 */
export const SECTIONS = Object.freeze([
  Object.freeze({ id: 'transport', title: 'Running the plant' }),
  Object.freeze({ id: 'views', title: 'Moving around' }),
  Object.freeze({ id: 'loop', title: 'The controller' }),
  Object.freeze({ id: 'tests', title: 'Tests and tuning' }),
  Object.freeze({ id: 'help', title: 'Help and command' }),
]);

const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));

/**
 * Create an empty registry.
 * @returns {{bindings:Array<object>, byId:Map<string,object>}} the registry
 */
export function createRegistry() {
  return { bindings: [], byId: new Map() };
}

/**
 * Find what a chord would collide with.
 *
 * Two bindings collide when their contexts can be live at the same time — a global binding shares
 * a context with every view — and either their chords are identical, or one chord is a strict
 * prefix of the other. The prefix case is the one that is easy to miss and impossible to debug
 * from the outside: a single `g` fires the moment it is pressed, so a `g p` registered alongside
 * it is dead code that the user experiences as "the shortcut sometimes does the wrong thing".
 * @param {object} reg the registry
 * @param {object} chord a parsed chord
 * @param {string} context the context the new binding would live in
 * @returns {{kind:string, binding:object}|null} the collision, or null
 */
export function findConflict(reg, chord, context) {
  if (!reg || !chord) return null;
  const overlaps = (a, b) => a === b || a === GLOBAL || b === GLOBAL;
  for (const b of reg.bindings) {
    if (!overlaps(b.context, context)) continue;
    if (b.chord.id === chord.id) return { kind: 'duplicate', binding: b };
    if (chord.id.startsWith(`${b.chord.id}|`)) return { kind: 'shadowed', binding: b };
    if (b.chord.id.startsWith(`${chord.id}|`)) return { kind: 'shadows', binding: b };
  }
  return null;
}

/**
 * Register one binding.
 *
 * Refuses rather than warns. A keyboard layer that logs a warning and carries on ships with two
 * bindings on one key, and which of them runs depends on module load order.
 * @param {object} reg the registry
 * @param {object} spec the binding
 * @param {string} spec.id a stable identity, unique in the registry
 * @param {string} spec.keys the binding string, e.g. `Ctrl-K` or `g b`
 * @param {string} spec.label what the help card and the palette call it
 * @param {string} spec.section one of {@link SECTIONS}
 * @param {string} [spec.detail] a sentence for the help card
 * @param {string} [spec.context=GLOBAL] the view id this binding is live in
 * @param {Function} [spec.run] what to do, called with `(env)`
 * @param {string} [spec.action] the name of an action on `A` to call instead of `run`
 * @param {Array<*>} [spec.args] arguments for `spec.action`
 * @param {string} [spec.claim] why this binding may take a CONTESTED browser key
 * @param {boolean} [spec.hidden] keep it off the palette (it stays on the help card)
 * @returns {{ok:true, binding:object}|{ok:false, reason:string}} the result
 */
export function registerBinding(reg, spec) {
  if (!reg || !Array.isArray(reg.bindings)) return { ok: false, reason: 'no registry' };
  if (!spec || typeof spec !== 'object') return { ok: false, reason: 'no binding given' };
  if (!spec.id) return { ok: false, reason: 'a binding needs an id' };
  if (reg.byId.has(spec.id)) return { ok: false, reason: `binding "${spec.id}" is already registered` };
  // Discoverability is enforced here, not documented and hoped for: an unlabelled binding cannot
  // appear on the help card, and a shortcut nobody can find is a shortcut nobody uses.
  if (!spec.label) return { ok: false, reason: `binding "${spec.id}" has no label, so nothing could list it` };
  if (!SECTION_IDS.has(spec.section)) {
    return { ok: false, reason: `binding "${spec.id}" names section "${spec.section}", which is not on the help card` };
  }
  if (!spec.run && !spec.action) {
    return { ok: false, reason: `binding "${spec.id}" does nothing: give it run() or action` };
  }
  const parsed = parseChord(spec.keys);
  if (!parsed.ok) return parsed;
  const chord = parsed.chord;

  const claim = browserClaim(chord);
  if (claim && claim.level === 'UNREACHABLE') {
    return {
      ok: false,
      reason: `${formatChord(chord)} never reaches the page — the browser uses it for ${claim.owner}`,
    };
  }
  if (claim && claim.level === 'CONTESTED' && !spec.claim) {
    return {
      ok: false,
      reason: `${formatChord(chord)} is the browser's ${claim.owner}; pass claim: "why" to take it`,
    };
  }

  const context = spec.context || GLOBAL;
  const clash = findConflict(reg, chord, context);
  if (clash) {
    const how = clash.kind === 'duplicate'
      ? 'is already bound to'
      : (clash.kind === 'shadowed' ? 'can never fire, because its first stroke runs' : 'would shadow');
    return { ok: false, reason: `${formatChord(chord)} ${how} "${clash.binding.label}"` };
  }

  const binding = {
    id: spec.id,
    chord,
    keys: formatChord(chord),
    label: spec.label,
    detail: spec.detail || '',
    section: spec.section,
    context,
    run: spec.run || null,
    action: spec.action || '',
    args: spec.args ? spec.args.slice() : [],
    claim: spec.claim || '',
    browser: claim,
    hidden: !!spec.hidden,
  };
  reg.bindings.push(binding);
  reg.byId.set(binding.id, binding);
  return { ok: true, binding };
}

/**
 * Register a table of bindings, collecting the refusals instead of stopping at the first.
 * @param {object} reg the registry
 * @param {Array<object>} specs the bindings
 * @returns {{ok:boolean, registered:number, problems:Array<{id:string, reason:string}>}} the result
 */
export function registerAll(reg, specs) {
  const problems = [];
  let registered = 0;
  for (const spec of specs || []) {
    const res = registerBinding(reg, spec);
    if (res.ok) registered += 1;
    else problems.push({ id: (spec && spec.id) || '(no id)', reason: res.reason });
  }
  return { ok: problems.length === 0, registered, problems };
}

/**
 * The bindings live in a context, global ones included.
 * @param {object} reg the registry
 * @param {string} context the current view id
 * @returns {Array<object>} the live bindings
 */
export function bindingsInContext(reg, context) {
  if (!reg) return [];
  return reg.bindings.filter((b) => b.context === GLOBAL || b.context === context);
}

/**
 * The help card's content, straight from the registry.
 *
 * This function is the reason the card cannot drift: there is no second list to update.
 * @param {object} reg the registry
 * @returns {Array<{id:string, title:string, rows:Array<object>}>} sections with at least one row
 */
export function helpCard(reg) {
  const out = [];
  for (const sec of SECTIONS) {
    const rows = (reg ? reg.bindings : [])
      .filter((b) => b.section === sec.id)
      .map((b) => ({
        keys: b.keys,
        label: b.label,
        detail: b.detail,
        context: b.context,
        claim: b.claim,
      }));
    if (rows.length) out.push({ id: sec.id, title: sec.title, rows });
  }
  return out;
}

// =============================================================================================
// 4. CHORD MATCHING
// =============================================================================================

/**
 * The state a half-typed chord lives in.
 * @returns {{pending:Array<object>, at_ms:number}} a fresh, empty chord state
 */
export function createChordState() {
  return { pending: [], at_ms: 0 };
}

/**
 * Feed one stroke to the chord matcher.
 *
 * Pure: the caller owns the clock and the returned state. A pending chord older than
 * {@link CHORD_TIMEOUT_MS} is discarded before the stroke is considered, so a `g` pressed a minute
 * ago cannot turn a later `p` into a view change.
 * @param {object} reg the registry
 * @param {object} state the chord state
 * @param {object} stroke0 the stroke, from {@link strokeFromEvent}
 * @param {object} env matching environment
 * @param {string} [env.context=GLOBAL] the current view id
 * @param {number} [env.now_ms=0] the clock, supplied by the caller
 * @returns {{status:string, state:object, binding:object|null}} `status` is `fired`, `pending`,
 *   `abort` (a pending chord that this stroke cannot continue) or `none`
 */
export function feedStroke(reg, state, stroke0, env) {
  const now = (env && Number.isFinite(env.now_ms)) ? env.now_ms : 0;
  const context = (env && env.context) || GLOBAL;
  const st = state && Array.isArray(state.pending) ? state : createChordState();
  const stale = st.pending.length > 0 && (now - st.at_ms) > CHORD_TIMEOUT_MS;
  const prefix = stale ? [] : st.pending;
  const seq = prefix.concat([stroke0]);
  const live = bindingsInContext(reg, context);

  let exact = null;
  let partial = false;
  for (const b of live) {
    const steps = b.chord.steps;
    if (steps.length < seq.length) continue;
    let hit = true;
    for (let i = 0; i < seq.length; i += 1) {
      if (!sameStroke(steps[i], seq[i])) { hit = false; break; }
    }
    if (!hit) continue;
    if (steps.length === seq.length) { if (!exact) exact = b; } else partial = true;
  }

  if (exact) return { status: 'fired', state: createChordState(), binding: exact };
  if (partial) return { status: 'pending', state: { pending: seq, at_ms: now }, binding: null };
  // A stroke that continues nothing clears any half-typed chord, so the next key starts clean.
  if (prefix.length) return { status: 'abort', state: createChordState(), binding: null };
  return { status: 'none', state: createChordState(), binding: null };
}

// =============================================================================================
// 5. FUZZY SEARCH
// =============================================================================================

/**
 * Whether the character at `i` starts a word.
 * @param {string} t the lower-cased haystack
 * @param {number} i the index
 * @returns {boolean} whether a word starts here
 */
function isBoundary(t, i) {
  return i === 0 || !/[a-z0-9]/.test(t.charAt(i - 1));
}

/**
 * One subsequence scan.
 * @param {string} t the lower-cased haystack
 * @param {string} q the lower-cased needle, spaces removed
 * @param {boolean} preferBoundary whether to jump ahead to a word start when one exists
 * @returns {Array<number>|null} the matched indices, or null when `q` is not a subsequence
 */
function scan(t, q, preferBoundary) {
  const positions = [];
  let from = 0;
  for (let k = 0; k < q.length; k += 1) {
    const ch = q.charAt(k);
    let first = -1;
    let bound = -1;
    for (let i = from; i < t.length; i += 1) {
      if (t.charAt(i) !== ch) continue;
      if (first < 0) first = i;
      if (isBoundary(t, i)) { bound = i; break; }
      if (!preferBoundary) break;
    }
    const at = preferBoundary && bound >= 0 ? bound : first;
    if (at < 0) return null;
    positions.push(at);
    from = at + 1;
  }
  return positions;
}

/**
 * Score a set of matched positions.
 * @param {string} t the lower-cased haystack
 * @param {string} q the lower-cased needle
 * @param {Array<number>} positions matched indices
 * @returns {number} the score
 */
function scorePositions(t, q, positions) {
  let sc = 0;
  for (let k = 0; k < positions.length; k += 1) {
    const i = positions[k];
    sc += 10;
    if (k > 0 && i === positions[k - 1] + 1) sc += 14;
    if (isBoundary(t, i)) sc += 16;
  }
  sc -= Math.min(20, positions[0]);
  sc -= Math.min(15, Math.max(0, t.length - q.length) * 0.35);
  if (t.startsWith(q)) sc += 25;
  if (t === q) sc += 50;
  return sc;
}

/**
 * Fuzzy-match a query against a label.
 *
 * Two scans, best of. A purely greedy left-most scan wins on contiguous typing (`ste` in
 * "Step test"); a boundary-preferring scan wins on initials (`st` for "Step Test", `bs` for
 * "Begin sweep"). Running both and keeping the higher score costs two linear passes over a string
 * that is never more than a line long, and removes the whole class of "why does this rank third"
 * complaints that a single heuristic produces.
 * @param {string} query what the user typed
 * @param {string} text the label
 * @returns {{score:number, positions:Array<number>}|null} the match, or null when there is none
 */
export function fuzzyMatch(query, text) {
  const t = String(text == null ? '' : text).toLowerCase();
  const q = String(query == null ? '' : query).toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, positions: [] };
  if (!t) return null;
  const a = scan(t, q, false);
  const b = scan(t, q, true);
  if (!a && !b) return null;
  const sa = a ? scorePositions(t, q, a) : -Infinity;
  const sb = b ? scorePositions(t, q, b) : -Infinity;
  return sa >= sb ? { score: sa, positions: a } : { score: sb, positions: b };
}

/**
 * The score alone.
 * @param {string} query what the user typed
 * @param {string} text the label
 * @returns {number} the score, or -1 when the query is not a subsequence of the label
 */
export function fuzzyScore(query, text) {
  const m = fuzzyMatch(query, text);
  return m ? m.score : -1;
}

/**
 * Rank commands against a query.
 *
 * Ordering is total and deterministic — score, then shorter label, then alphabetical — because a
 * palette whose top hit depends on registration order will one day run the wrong action on Enter.
 * @param {Array<object>} items palette items carrying `label` and optionally `keywords`
 * @param {string} query the search text
 * @param {number} [limit=12] how many to return
 * @returns {Array<object>} the items that matched, each with `score` and `positions`
 */
export function rankCommands(items, query, limit = 12) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query == null ? '' : query).trim();
  const out = [];
  for (const it of list) {
    const m = fuzzyMatch(q, it.label);
    if (!m) {
      // A second chance against the keywords, scored a little lower: matching "cavitation" on the
      // NPSH readout is useful, but never at the expense of something whose NAME the user typed.
      const km = it.keywords ? fuzzyMatch(q, it.keywords) : null;
      if (!km) continue;
      out.push({ ...it, score: km.score - 20, positions: [] });
      continue;
    }
    out.push({ ...it, score: m.score, positions: m.positions });
  }
  out.sort((x, y) => (y.score - x.score)
    || (x.label.length - y.label.length)
    || (x.label < y.label ? -1 : (x.label > y.label ? 1 : 0)));
  return out.slice(0, Math.max(0, limit));
}

// =============================================================================================
// 6. THE COMMAND PALETTE'S CONTENTS
// =============================================================================================

/**
 * Names on the action surface that are queries or plumbing rather than commands. Everything else
 * `A` carries becomes a palette entry, including actions added after this file was written.
 */
const NOT_COMMANDS = Object.freeze(new Set(['raw', 'toast', 'summary', 'tuningCandidates', 'deleteRun']));

/**
 * Argument sets for the actions that cannot be run bare, and better wording for the ones whose
 * function name reads badly. An action absent from this table still reaches the palette, under a
 * name derived from its identifier — which is the point: a module added by somebody else appears
 * in the palette on the day it is bound, rather than on the day this table is remembered.
 */
export const ACTION_COMMANDS = Object.freeze({
  togglePause: { label: 'Run or freeze the plant', section: 'transport' },
  setSpeed: {
    label: 'Time compression',
    section: 'transport',
    args: [
      { suffix: '1× — real time', value: [1] },
      { suffix: '5×', value: [5] },
      { suffix: '20×', value: [20] },
    ],
  },
  setLoopMode: {
    label: 'Control',
    section: 'loop',
    args: [
      { suffix: 'header pressure (PIC-101)', value: [LOOP.PRESSURE] },
      { suffix: 'flow to process (FIC-101)', value: [LOOP.FLOW] },
      { suffix: 'suction level (LIC-101)', value: [LOOP.LEVEL] },
    ],
  },
  setControllerMode: {
    label: 'Controller to',
    section: 'loop',
    args: [
      { suffix: 'AUTO', value: [MODE.AUTO] },
      { suffix: 'MANUAL', value: [MODE.MAN] },
      { suffix: 'CASCADE', value: [MODE.CASCADE] },
    ],
  },
  startPump: {
    label: 'Start',
    section: 'transport',
    args: [{ suffix: 'P-101', value: [0] }, { suffix: 'P-102', value: [1] }],
  },
  stopPump: {
    label: 'Stop',
    section: 'transport',
    args: [{ suffix: 'P-101', value: [0] }, { suffix: 'P-102', value: [1] }],
  },
  autoPump: {
    label: 'Hand to the sequence:',
    section: 'transport',
    args: [{ suffix: 'P-101', value: [0] }, { suffix: 'P-102', value: [1] }],
  },
  resetPump: {
    label: 'Reset the trip on',
    section: 'transport',
    args: [{ suffix: 'P-101', value: [0] }, { suffix: 'P-102', value: [1] }],
  },
  forceTrip: {
    label: 'Trip',
    section: 'transport',
    args: [{ suffix: 'P-101', value: [0] }, { suffix: 'P-102', value: [1] }],
  },
  beginAutotune: { label: 'Relay autotune', section: 'tests', keywords: 'identification ultimate gain relay' },
  cancelAutotune: { label: 'Cancel the relay autotune', section: 'tests' },
  beginStepTest: { label: 'Step test', section: 'tests', keywords: 'bump open loop fopdt model' },
  cancelStepTest: { label: 'Cancel the step test', section: 'tests' },
  beginSweep: { label: 'Frequency sweep', section: 'tests', keywords: 'bode measured response' },
  cancelSweep: { label: 'Cancel the frequency sweep', section: 'tests' },
  gradeNow: { label: 'Grade this run', section: 'tests', keywords: 'score iae scorecard' },
  clearScore: { label: 'Clear the scorecard', section: 'tests' },
  ackAlarms: { label: 'Acknowledge all alarms', section: 'transport', keywords: 'ack silence horn' },
  clearTrend: { label: 'Clear the trend', section: 'views' },
  resetEnergy: { label: 'Reset the energy totals', section: 'transport', keywords: 'kwh specific energy' },
  endLesson: { label: 'Leave the lesson', section: 'views' },
  cancelScenario: { label: 'Cancel the scenario', section: 'tests' },
});

/**
 * Turn `setManualOutput` into `Set manual output`.
 * @param {string} name a camelCase identifier
 * @returns {string} a sentence-cased label
 */
export function humanizeAction(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Build the palette's command list by ENUMERATING the bound action surface.
 *
 * Nothing here is a hard-coded list of what the application can do. `A` is walked for callable
 * properties, the registry contributes everything that also has a key, and `extra` carries the
 * few commands that live only in the UI (switch view, start a tour). An action that takes a
 * required argument and has no entry in {@link ACTION_COMMANDS} is listed as `runnable: false`
 * rather than dropped, so the gap is visible in the palette instead of invisible in this file.
 * @param {object} A the bound action surface
 * @param {object} [reg] the key registry, for the shortcut column
 * @param {Array<object>} [extra] UI-only commands: `{id, label, section, run, keywords}`
 * @returns {Array<object>} palette items
 */
export function paletteCommands(A, reg, extra) {
  const items = [];
  const seen = new Set();
  const keyFor = (action, args) => {
    if (!reg) return '';
    const hit = reg.bindings.find((b) => b.action === action
      && JSON.stringify(b.args) === JSON.stringify(args || []));
    return hit ? hit.keys : '';
  };

  for (const it of extra || []) {
    if (!it || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push({
      id: it.id,
      label: it.label || humanizeAction(it.id),
      section: it.section || 'views',
      keywords: it.keywords || '',
      keys: it.keys || '',
      runnable: typeof it.run === 'function',
      run: it.run || null,
    });
  }

  for (const name of A && typeof A === 'object' ? Object.keys(A) : []) {
    if (NOT_COMMANDS.has(name)) continue;
    const fn = A[name];
    if (typeof fn !== 'function') continue;
    const meta = ACTION_COMMANDS[name] || null;
    const variants = meta && meta.args ? meta.args : [null];
    for (const v of variants) {
      const id = v ? `${name}:${v.suffix}` : name;
      if (seen.has(id)) continue;
      seen.add(id);
      const label = v
        ? `${meta.label} ${v.suffix}`
        : (meta && meta.label ? meta.label : humanizeAction(name));
      const args = v ? v.value : [];
      // An action declaring parameters it was not given arguments for would be run with
      // `undefined`, and `sim.setSetpoint(ctx, undefined)` is exactly the sort of thing that
      // leaves a rig in a state nobody typed. Those are shown, greyed, and not run.
      const runnable = !!v || fn.length === 0;
      items.push({
        id,
        label,
        section: (meta && meta.section) || 'loop',
        keywords: (meta && meta.keywords) || name,
        keys: keyFor(name, args),
        runnable,
        action: name,
        args,
        run: runnable ? () => fn(...args) : null,
      });
    }
  }

  for (const b of reg ? reg.bindings : []) {
    // A binding that names an action is already in the list above, under that action's entry;
    // only the ones carrying their own `run` — the palette, the help card, the view jumps — are
    // new here.
    if (b.hidden || !b.run || seen.has(`key:${b.id}`)) continue;
    seen.add(`key:${b.id}`);
    items.push({
      id: `key:${b.id}`,
      label: b.label,
      section: b.section,
      keywords: b.detail,
      keys: b.keys,
      runnable: true,
      run: b.run,
    });
  }
  return items;
}

// =============================================================================================
// 7. THE DEFAULT BINDINGS
// =============================================================================================

/**
 * Every shortcut the rig ships with.
 *
 * The first five mirror what `ui/app.js` already listened for, deliberately and to the letter: the
 * help card describes the running application, and a card that documents an improved keyboard the
 * user does not have is a card that lies. `run` receives the environment given to
 * {@link installKeys}, which carries the bound actions, the current view and the view setter.
 * @param {object} [opts] table options
 * @param {Array<string>} [opts.viewIds] the view ids `g` chords cycle through
 * @returns {Array<object>} binding specs, ready for {@link registerAll}
 */
export function defaultBindings(opts = {}) {
  const views = opts.viewIds || ['pid', 'curves', 'bode', 'nyquist', 'health', 'lessons'];
  const viewKeys = { pid: 'd', curves: 'c', bode: 'b', nyquist: 'n', health: 'r', lessons: 'l' };
  const viewNames = {
    pid: 'the process schematic',
    curves: 'the head-capacity chart',
    bode: 'the Bode plot',
    nyquist: 'the Nyquist plot',
    health: 'the reports',
    lessons: 'the lessons',
  };
  const list = [
    {
      id: 'transport.pause',
      keys: 'Space',
      label: 'Run or freeze the plant',
      detail: 'Freezing stops the clock; it does not reset anything.',
      section: 'transport',
      action: 'togglePause',
    },
    {
      id: 'transport.ack',
      keys: 'a',
      label: 'Acknowledge all alarms',
      detail: 'An alarm stays on the list until it is acknowledged, not until it clears.',
      section: 'transport',
      action: 'ackAlarms',
    },
    {
      id: 'transport.speed1',
      keys: '1',
      label: 'Time compression 1× — real time',
      section: 'transport',
      action: 'setSpeed',
      args: [1],
    },
    {
      id: 'transport.speed5',
      keys: '2',
      label: 'Time compression 5×',
      section: 'transport',
      action: 'setSpeed',
      args: [5],
    },
    {
      id: 'transport.speed20',
      keys: '3',
      label: 'Time compression 20×',
      detail: 'The controller still runs at its own scan; only the wall clock is compressed.',
      section: 'transport',
      action: 'setSpeed',
      args: [20],
    },
    {
      id: 'views.next',
      keys: 'p',
      label: 'Next view',
      detail: 'Cycles the stage through all six pages.',
      section: 'views',
      run: (env) => {
        const i = views.indexOf(env.view());
        env.setView(views[(i + 1) % views.length]);
      },
    },
    {
      id: 'help.palette',
      keys: 'Ctrl-K',
      label: 'Command palette',
      detail: 'Every action in the application, searchable by name.',
      section: 'help',
      claim: 'the palette is how a first-time user finds anything; the address bar is one click away',
      run: (env) => env.openPalette(),
    },
    {
      id: 'help.card',
      keys: '?',
      label: 'Keyboard help',
      detail: 'This card. Generated from the same table the keys are bound from.',
      section: 'help',
      run: (env) => env.toggleHelp(),
    },
    {
      id: 'help.tour',
      keys: 'g t',
      label: 'Guided tours',
      detail: 'Pick a tour, or resume the one that was interrupted.',
      section: 'help',
      run: (env) => env.openTours(),
    },
    {
      id: 'loop.auto',
      keys: 'm',
      label: 'Controller to AUTO',
      section: 'loop',
      action: 'setControllerMode',
      args: [MODE.AUTO],
    },
    {
      id: 'loop.manual',
      keys: 'Shift-M',
      label: 'Controller to MANUAL',
      detail: 'The algorithm tracks the output, so the transfer back is bumpless.',
      section: 'loop',
      action: 'setControllerMode',
      args: [MODE.MAN],
    },
    {
      id: 'tests.relay',
      keys: 'g a',
      label: 'Relay autotune',
      detail: 'Cycles the output about the setpoint to measure the ultimate gain and period.',
      section: 'tests',
      action: 'beginAutotune',
    },
    {
      id: 'tests.step',
      keys: 'g s',
      label: 'Step test',
      detail: 'An open-loop bump, fitted to a first-order-plus-dead-time model.',
      section: 'tests',
      action: 'beginStepTest',
    },
  ];
  for (const id of views) {
    if (!viewKeys[id]) continue;
    list.push({
      id: `views.${id}`,
      keys: `g ${viewKeys[id]}`,
      label: `Go to ${viewNames[id] || id}`,
      section: 'views',
      run: (env) => env.setView(id),
    });
  }
  return list;
}

// =============================================================================================
// 8. THE DOM LAYER — nothing below here runs until it is called
// =============================================================================================

/**
 * Whether a keystroke belongs to whatever the user is typing into.
 *
 * A setpoint field is the one place on this screen where `3` must mean three and not twenty-times
 * speed, and where Space must be a space.
 * @param {object|null} el the event target
 * @returns {boolean} whether the keyboard layer must keep its hands off
 */
export function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

/**
 * Install the keyboard layer on a window.
 * @param {object} env the environment
 * @param {object} env.reg the registry
 * @param {object} env.A the bound actions, for bindings that name one
 * @param {()=>string} env.view the current view id, for context-sensitive bindings
 * @param {(v:string)=>void} env.setView switch view
 * @param {(msg:string, kind?:string)=>void} [env.toast] where a pending-chord hint goes
 * @param {object} [env.target=globalThis] what to listen on
 * @param {()=>number} [env.now] the clock, ms — injected so the chord timeout is testable
 * @returns {{dispose:Function, pending:()=>Array<object>}} the installed layer
 */
export function installKeys(env) {
  if (!env || !env.reg) return { ok: false, reason: 'installKeys needs a registry' };
  const target = env.target || globalThis;
  const now = env.now || (() => (globalThis.performance ? globalThis.performance.now() : 0));
  let state = createChordState();

  /**
   * Handle one key down.
   * @param {object} ev the keyboard event
   * @returns {void}
   */
  function onKey(ev) {
    if (isTypingTarget(ev.target)) return;
    // Never eat a browser accelerator we did not deliberately claim: a Ctrl or Alt combination
    // that no binding wants must reach the browser untouched.
    const st = strokeFromEvent(ev);
    const res = feedStroke(env.reg, state, st, { context: env.view ? env.view() : GLOBAL, now_ms: now() });
    state = res.state;
    if (res.status === 'none') return;
    ev.preventDefault();
    if (res.status === 'pending') {
      if (env.toast) env.toast(`${formatChord({ steps: res.state.pending })} …`, '');
      return;
    }
    if (res.status !== 'fired') return;
    const b = res.binding;
    if (b.run) b.run(env);
    else if (b.action && env.A && typeof env.A[b.action] === 'function') env.A[b.action](...b.args);
  }

  target.addEventListener('keydown', onKey);
  return {
    ok: true,
    /** @returns {void} remove the listener */
    dispose() { target.removeEventListener('keydown', onKey); },
    /** @returns {Array<object>} the half-typed chord, for a status readout */
    pending() { return state.pending.slice(); },
  };
}

/**
 * Build the help card.
 * @param {object} reg the registry
 * @returns {{el:HTMLElement, toggle:Function, close:Function, isOpen:()=>boolean}} the card
 */
export function createHelpCard(reg) {
  const body = h('div', { class: 'keyhelp__body' });
  const el = h('div', { class: 'keyhelp', hidden: true, role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('header', { class: 'keyhelp__head' },
      h('b', { text: 'KEYBOARD' }),
      h('span', { class: 'keyhelp__hint', text: 'generated from the binding table — it cannot drift' }),
      h('button', {
        class: 'keyhelp__x', type: 'button', text: '✕', 'aria-label': 'Close',
        onClick: () => { el.hidden = true; },
      })),
    body);

  for (const sec of helpCard(reg)) {
    body.append(h('div', { class: 'keyhelp__sec' },
      h('div', { class: 'keyhelp__sectitle', text: sec.title }),
      ...sec.rows.map((r) => h('div', { class: 'keyhelp__row' },
        h('kbd', { class: 'keyhelp__keys', text: r.keys }),
        h('div', { class: 'keyhelp__what' },
          h('b', { text: r.label }),
          r.detail ? h('span', { class: 'keyhelp__detail', text: r.detail }) : null,
          r.context !== GLOBAL ? h('span', { class: 'keyhelp__ctx', text: `only on ${r.context}` }) : null)))));
  }

  return {
    el,
    /** @returns {void} show or hide */
    toggle() { el.hidden = !el.hidden; },
    /** @returns {void} hide */
    close() { el.hidden = true; },
    /** @returns {boolean} whether it is showing */
    isOpen() { return !el.hidden; },
  };
}

/**
 * Build the command palette.
 * @param {object} env the environment
 * @param {object} env.A the bound actions
 * @param {object} env.reg the registry
 * @param {()=>Array<object>} [env.extra] UI-only commands, evaluated when the palette opens
 * @returns {{el:HTMLElement, open:Function, close:Function, isOpen:()=>boolean}} the palette
 */
export function createPalette(env) {
  const input = h('input', {
    class: 'palette__input', type: 'text', placeholder: 'Type a command…',
    autocomplete: 'off', spellcheck: false,
  });
  const list = h('div', { class: 'palette__list', role: 'listbox' });
  const box = h('div', { class: 'palette__box' },
    h('div', { class: 'palette__top' }, input),
    list,
    h('div', { class: 'palette__foot', text: '↑↓ to choose · Enter to run · Esc to close' }));
  const el = h('div', { class: 'palette', hidden: true }, box);

  let items = [];
  let shown = [];
  let cursor = 0;

  /**
   * Repaint the result list.
   * @returns {void}
   */
  function paint() {
    shown = rankCommands(items, input.value, 12);
    if (cursor >= shown.length) cursor = Math.max(0, shown.length - 1);
    list.textContent = '';
    for (let i = 0; i < shown.length; i += 1) {
      const it = shown[i];
      const row = h('button', {
        class: `palette__row${i === cursor ? ' is-on' : ''}${it.runnable ? '' : ' is-off'}`,
        type: 'button', role: 'option', title: it.runnable ? '' : 'needs a value — set it on the panel',
        onClick: () => runAt(i),
      },
      h('span', { class: 'palette__label', text: it.label }),
      it.keys ? h('kbd', { class: 'palette__keys', text: it.keys }) : null);
      list.append(row);
    }
    if (!shown.length) list.append(h('div', { class: 'palette__none', text: 'Nothing matches.' }));
  }

  /**
   * Run the nth result.
   * @param {number} i the index into the shown list
   * @returns {void}
   */
  function runAt(i) {
    const it = shown[i];
    if (!it || !it.runnable || !it.run) return;
    close();
    it.run();
  }

  /**
   * Close the palette.
   * @returns {void}
   */
  function close() { el.hidden = true; }

  input.addEventListener('input', paint);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); cursor = Math.min(cursor + 1, shown.length - 1); paint(); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); runAt(cursor); }
  });
  el.addEventListener('mousedown', (ev) => { if (ev.target === el) close(); });

  return {
    el,
    /** @returns {void} show it, rebuilding the command list from the live action surface */
    open() {
      items = paletteCommands(env.A, env.reg, env.extra ? env.extra() : []);
      input.value = '';
      cursor = 0;
      el.hidden = false;
      paint();
      input.focus();
    },
    close,
    /** @returns {boolean} whether it is showing */
    isOpen() { return !el.hidden; },
    /**
     * Update the shortcut column after a rebind.
     * @returns {void}
     */
    refresh() { if (!el.hidden) paint(); },
  };
}
