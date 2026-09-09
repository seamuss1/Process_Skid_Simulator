/**
 * src/plc/recipe.js — the recipe book and the step sequencer: the batch an operator edits in a
 * grid, and the small machine that walks it while the ladder decides when to take the next step.
 *
 * Layer L3 (`src/plc`): imports `core/util.js`, `data/config.js` and `plc/tags.js`. No DOM, no
 * `window`, no `Date.now()`, no `Math.random()` — storage is injected and degrades to a silent
 * no-op when it is absent, because every line here is unit-tested under `node --test`. The
 * sequencer's clock is the `dt_s` it is handed.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THE SEQUENCER DOES NOT ADVANCE ITSELF
 *
 * The obvious design is a sequencer that reads the step table, waits out the timer and moves on.
 * It is also the design that makes the ladder program a decoration: the plant would do the same
 * thing whether or not a single rung existed, and the player's edits would change nothing.
 *
 * So the split here is the one a real batch station uses. The SEQUENCER owns the data and the
 * arithmetic — which step is current, how long it has been running, whether the transition
 * condition is satisfied, what the ramped setpoint is worth right now — and it publishes all of
 * that as `REC.*` tags. The LADDER owns the decisions. Nothing advances until a rung energises
 * `REC.ADVANCE`, and the stock program's rung is exactly:
 *
 *     XIC REC.STEP_DN   XIO REC.HOLD   XIO I.ALM_CRITICAL   OTE REC.ADVANCE
 *
 * Which is why the recipe behaviour is editable in two places. Change the numbers in the grid and
 * the same logic walks a different profile; change that rung — hold on a critical alarm, require
 * both pumps proved, add a permissive — and the same numbers get walked differently. Delete the
 * rung and the recipe stops dead on step one, which is a lesson worth the five seconds it costs.
 *
 * FOUR BITS THE LADDER OWNS, EVERYTHING ELSE THE SEQUENCER OWNS. `REC.START`, `REC.ADVANCE`,
 * `REC.ABORT` and `REC.HOLD` are written by the program or the panel and only READ here. Every
 * other `REC.*` tag is published here and must not be driven by a coil — the cross-reference will
 * show you both writers if you try, and the sequencer wins on the scan after yours.
 *
 * WHY THE RECIPE IS COPIED WHEN IT STARTS. {@link startRecipe} deep-clones. An operator editing
 * step 5 in the grid while step 2 is running is normal, and a batch whose steps changed underneath
 * it halfway through is unreproducible — the record of what ran would be a record of the last
 * edit. The copy in `seq.recipe` is what ran; the book holds what will run next time.
 *
 * WHY VALIDATION HAPPENS AT THE DOOR. {@link startRecipe} refuses a recipe carrying any error.
 * A loop mode this rig does not have, a setpoint outside the transmitter's range, a transition
 * condition with no threshold — every one of those is discoverable before a pump turns, and
 * finding it halfway through step four means the plant is left in the middle of a batch that
 * cannot finish. The refusal is a sentence the operator can read and act on.
 *
 * TIME COMPRESSION. This rig runs at up to 20x, so a 100 ms scan is regularly handed 2 s of `dt`.
 * Every timer here INTEGRATES `dt_s` rather than counting scans, so no step ever loses time at
 * speed; the only consequence of a long `dt` is that a transition can be recognised up to one
 * scan late, which is true of every real processor as well. A `dt` beyond {@link MAX_DT_S} is
 * treated as a stall in the host rather than as elapsed process time and is clamped, because a
 * tab that was backgrounded for ten minutes must not silently retire four steps.
 *
 * ------------------------------------------------------------------------------------------
 * THE TEXT FORMAT — the shareable, diffable representation. `recipeFromText(recipeToText(r))`
 * returns `r` exactly for any recipe built through this module's own functions.
 *
 *     recipe   := "RECIPE" quoted NL header* step*
 *     header   := "VERSION" int | "NOTES" rest-of-line
 *     step     := "STEP" int quoted NL field* "END"
 *     field    := "LOOP" ident                     -- PRESSURE | FLOW | LEVEL
 *               | "SP" number                      -- in that step's engineering units
 *               | "PUMPS" ident                    -- AUTO | LEAD | BOTH | P1 | P2 | NONE
 *               | "MINUTES" number                 -- nominal duration; drives REC.TIME_DN
 *               | "BAND" number                    -- hold band, EU, for IN_BAND and the display
 *               | "RAMP" number                    -- seconds to ramp the setpoint into the step
 *               | "NEXT" ident [number] ["AFTER" number]
 *               | "DO" tag "=" value               -- one write, on step entry
 *     value    := "ON" | "OFF" | number | quoted
 *     comment  := ";" to end of line; blank lines are ignored
 *
 * Defaults are omitted on write and assumed on read: a missing `AFTER` is zero, a missing value
 * on a condition that takes none is zero. Everything else is always written, because a step table
 * you have to remember the defaults of is not a step table you can review at three in the morning.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';
import { LOOP, LOOP_EU } from '../data/config.js';
import {
  TYPE, SCOPE, defineTags, readTag, writeTag, tagExists,
} from './tags.js';

/**
 * Bumped when the persisted shape changes in a way {@link createRecipeBook} cannot absorb
 * quietly. The storage key deliberately does not carry the version — a newer build must be able
 * to find an older book and salvage what it understands rather than present an empty shelf.
 */
export const RECIPE_VERSION = 1;

/** Where the book lives in the injected storage. Stable across versions; see above. */
export const STORAGE_KEY = 'skid.plc.recipes';

/** Problem severities, matching `model.js` so one list can be rendered by one component. */
export const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});

/**
 * How a step wants the machines placed.
 *
 * This is the pump configuration column in the grid, and it is published as bits rather than only
 * as text so that a rung can act on it without a string compare: `REC.WANT_P1`, `REC.WANT_P2`,
 * `REC.WANT_LEAD` and `REC.SEQ_AUTO`.
 */
export const PUMPS = Object.freeze({
  /** Hand the machines back to the staging sequence and let it decide. */
  AUTO: 'AUTO',
  /** Exactly one machine, whichever is lead. Staging held off. */
  LEAD: 'LEAD',
  /** Both machines called, whatever the load says. A duty test, or a CIP circulation rate. */
  BOTH: 'BOTH',
  /** P-101 only, so the other machine can be worked on. */
  P1: 'P1',
  /** P-102 only. */
  P2: 'P2',
  /** Nothing turning — a soak, a drain-down on gravity, or a hand-back step. */
  NONE: 'NONE',
});

/**
 * The transition conditions a step may advance on.
 *
 * A closed table rather than an expression language, for two reasons. It is a dropdown in a grid,
 * and every entry can be rendered as a sentence an operator reads back to you; and every one of
 * them names a transmitter this rig actually has, so a recipe cannot be written against an
 * instrument that does not exist.
 */
export const NEXT = Object.freeze({
  /** The step timer alone. `MINUTES` is the whole condition. */
  TIME: 'TIME',
  /** The measurement has sat inside the hold band for `AFTER` seconds. */
  IN_BAND: 'IN_BAND',
  /** The controlled measurement has risen above the threshold. */
  PV_ABOVE: 'PV_ABOVE',
  /** The controlled measurement has fallen below the threshold. */
  PV_BELOW: 'PV_BELOW',
  /** Flow to process above the threshold. */
  FLOW_ABOVE: 'FLOW_ABOVE',
  /** Flow to process below the threshold. */
  FLOW_BELOW: 'FLOW_BELOW',
  /** Suction tank level above the threshold. */
  LEVEL_ABOVE: 'LEVEL_ABOVE',
  /** Suction tank level below the threshold. */
  LEVEL_BELOW: 'LEVEL_BELOW',
  /** Volume delivered SINCE THIS STEP STARTED has reached the threshold. A rinse, in m3. */
  VOLUME: 'VOLUME',
  /** Nothing here advances it. The step waits for a person, through `REC.ADVANCE`. */
  OPERATOR: 'OPERATOR',
});

/**
 * What each transition condition reads and how it reads back in English.
 *
 * `source` is the input tag the condition is measured on, `delta` says the threshold is counted
 * from the value at step entry rather than absolutely, and `needsValue` is what makes a missing
 * threshold an error rather than a silently-zero one.
 */
export const NEXT_SPECS = Object.freeze({
  [NEXT.TIME]: Object.freeze({
    id: NEXT.TIME, label: 'the step timer', source: null, needsValue: false, delta: false, unit: '',
  }),
  [NEXT.IN_BAND]: Object.freeze({
    id: NEXT.IN_BAND, label: 'the measurement inside the hold band', source: 'I.PIC_PV', needsValue: false, delta: false, unit: 'EU',
  }),
  [NEXT.PV_ABOVE]: Object.freeze({
    id: NEXT.PV_ABOVE, label: 'the measurement above a threshold', source: 'I.PIC_PV', needsValue: true, delta: false, unit: 'EU',
  }),
  [NEXT.PV_BELOW]: Object.freeze({
    id: NEXT.PV_BELOW, label: 'the measurement below a threshold', source: 'I.PIC_PV', needsValue: true, delta: false, unit: 'EU',
  }),
  [NEXT.FLOW_ABOVE]: Object.freeze({
    id: NEXT.FLOW_ABOVE, label: 'FT-101 above a threshold', source: 'I.FT101', needsValue: true, delta: false, unit: 'm3/h',
  }),
  [NEXT.FLOW_BELOW]: Object.freeze({
    id: NEXT.FLOW_BELOW, label: 'FT-101 below a threshold', source: 'I.FT101', needsValue: true, delta: false, unit: 'm3/h',
  }),
  [NEXT.LEVEL_ABOVE]: Object.freeze({
    id: NEXT.LEVEL_ABOVE, label: 'LT-101 above a threshold', source: 'I.LT101', needsValue: true, delta: false, unit: 'm',
  }),
  [NEXT.LEVEL_BELOW]: Object.freeze({
    id: NEXT.LEVEL_BELOW, label: 'LT-101 below a threshold', source: 'I.LT101', needsValue: true, delta: false, unit: 'm',
  }),
  [NEXT.VOLUME]: Object.freeze({
    id: NEXT.VOLUME, label: 'volume delivered this step', source: 'I.M3_TOTAL', needsValue: true, delta: true, unit: 'm3',
  }),
  [NEXT.OPERATOR]: Object.freeze({
    id: NEXT.OPERATOR, label: 'an operator', source: null, needsValue: false, delta: false, unit: '',
  }),
});

/** Sequencer states, published as `REC.STATE` for the batch header on the HMI. */
export const SEQ_STATE = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  HELD: 'HELD',
  DONE: 'DONE',
  ABORTED: 'ABORTED',
});

/**
 * The limits. They exist so that a recipe pasted in from somewhere else cannot make the grid
 * unusable or the sequencer run for a simulated month.
 */
export const LIMITS = Object.freeze({
  /** Longest recipe or step name. */
  name: 60,
  /** Longest notes block, characters. */
  notes: 600,
  /** Most steps in one recipe. */
  steps: 32,
  /** Longest a single step may be, minutes. */
  minutes: 720,
  /** Longest a transition dwell may be, s. */
  after_s: 3600,
  /** Longest a setpoint ramp may be, s. */
  ramp_s: 3600,
  /** Most entry actions on one step. */
  actions: 8,
  /** Deepest the step history is kept. */
  history: 64,
});

/**
 * The largest `dt` treated as elapsed process time, s.
 *
 * Anything longer is a stalled host — a backgrounded tab, a breakpoint, a laptop lid — and
 * crediting it to the step timer would retire several steps the instant the tab came back.
 */
export const MAX_DT_S = 5;

/** `PREFIX.NAME`, matching the tag database's own rule. */
const TAG_RE = /^([A-Z][A-Z0-9]*)\.([A-Z][A-Z0-9_]*)$/;

/** Which scopes a step action is allowed to write. See {@link validateRecipe}. */
const ACTION_PREFIXES = Object.freeze(['Q', 'M', 'R', 'REC']);

/**
 * Every tag the sequencer publishes or reads.
 *
 * The four command bits are marked in their descriptions, because a tag browser sorted by name is
 * the only place most people will ever see this list, and "who writes this" is the one thing a
 * reader needs and cannot infer.
 */
export const RECIPE_TAGS = Object.freeze([
  // --- commands: written by the ladder or the panel, only read here -----------------------------
  Object.freeze({ name: 'REC.START', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'COMMAND (ladder writes): start the loaded recipe at step 1 on the rising edge' }),
  Object.freeze({ name: 'REC.ADVANCE', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'COMMAND (ladder writes): take the next step on the rising edge — nothing else advances the recipe' }),
  Object.freeze({ name: 'REC.ABORT', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'COMMAND (ladder writes): abandon the batch on the rising edge' }),
  Object.freeze({ name: 'REC.HOLD', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'COMMAND (ladder writes): freeze the step timer and refuse to advance' }),

  // --- published: written here every scan -------------------------------------------------------
  Object.freeze({ name: 'REC.NAME', type: TYPE.STRING, scope: SCOPE.RECIPE, desc: 'Name of the recipe in the sequencer' }),
  Object.freeze({ name: 'REC.STATE', type: TYPE.STRING, scope: SCOPE.RECIPE, desc: 'IDLE, RUNNING, HELD, DONE or ABORTED' }),
  Object.freeze({ name: 'REC.STEP', type: TYPE.INT, scope: SCOPE.RECIPE, min: 0, max: 999, desc: 'Current step number, 0 when no batch has been started' }),
  Object.freeze({ name: 'REC.STEPS', type: TYPE.INT, scope: SCOPE.RECIPE, min: 0, max: 999, desc: 'How many steps the loaded recipe has' }),
  Object.freeze({ name: 'REC.STEP_NAME', type: TYPE.STRING, scope: SCOPE.RECIPE, desc: 'Name of the current step' }),
  Object.freeze({ name: 'REC.RUNNING', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'A batch is in progress' }),
  Object.freeze({ name: 'REC.DONE', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The last step completed and the batch finished normally' }),
  Object.freeze({ name: 'REC.FAULT', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The sequencer could not do something it was asked to — see REC.NOTE' }),
  Object.freeze({ name: 'REC.NOTE', type: TYPE.STRING, scope: SCOPE.RECIPE, desc: 'The last thing the sequencer did, or the last thing it could not do' }),
  Object.freeze({ name: 'REC.SP', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 'EU', desc: 'Setpoint the step wants NOW, part-way along its ramp — MOV this to Q.PIC_SP' }),
  Object.freeze({ name: 'REC.SP_TARGET', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 'EU', desc: 'Setpoint the step ends at, before the ramp is applied' }),
  Object.freeze({ name: 'REC.RAMPING', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The published setpoint is still moving toward the step target' }),
  Object.freeze({ name: 'REC.LOOP', type: TYPE.STRING, scope: SCOPE.RECIPE, desc: 'Loop mode the step wants: PRESSURE, FLOW or LEVEL — MOV this to Q.LOOP_MODE' }),
  Object.freeze({ name: 'REC.PUMPS', type: TYPE.STRING, scope: SCOPE.RECIPE, desc: 'Pump configuration the step wants: AUTO, LEAD, BOTH, P1, P2 or NONE' }),
  Object.freeze({ name: 'REC.WANT_P1', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The step wants P-101 called' }),
  Object.freeze({ name: 'REC.WANT_P2', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The step wants P-102 called' }),
  Object.freeze({ name: 'REC.WANT_LEAD', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The step wants exactly one machine, whichever I.SEQ_LEAD says is lead' }),
  Object.freeze({ name: 'REC.SEQ_AUTO', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The step hands the machines back to the staging sequence' }),
  Object.freeze({ name: 'REC.BAND', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 'EU', min: 0, desc: 'Hold band of the current step' }),
  Object.freeze({ name: 'REC.IN_BAND', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The measurement is inside the hold band right now' }),
  Object.freeze({ name: 'REC.MINUTES', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 'min', min: 0, desc: 'Nominal duration of the current step' }),
  Object.freeze({ name: 'REC.ELAPSED', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 's', min: 0, desc: 'Time in the current step, frozen while REC.HOLD is on' }),
  Object.freeze({ name: 'REC.REMAIN', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 's', min: 0, desc: 'Time left on the current step timer' }),
  Object.freeze({ name: 'REC.BATCH_S', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 's', min: 0, desc: 'Time since the batch started' }),
  Object.freeze({ name: 'REC.PROGRESS', type: TYPE.REAL, scope: SCOPE.RECIPE, min: 0, max: 1, desc: 'Fraction of the whole recipe completed, by step time' }),
  Object.freeze({ name: 'REC.VOLUME', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 'm3', min: 0, desc: 'Volume delivered since the current step started' }),
  Object.freeze({ name: 'REC.DWELL', type: TYPE.REAL, scope: SCOPE.RECIPE, unit: 's', min: 0, desc: 'How long the transition condition has been continuously true' }),
  Object.freeze({ name: 'REC.TIME_DN', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The step timer has run out — true whatever the step advances on, so a rung can use it as a timeout' }),
  Object.freeze({ name: 'REC.COND_DN', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The transition condition has been satisfied for its dwell time' }),
  Object.freeze({ name: 'REC.STEP_DN', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The step is complete on its own criterion and is asking to be advanced' }),
  Object.freeze({ name: 'REC.FIRST_STEP', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The current step is step 1' }),
  Object.freeze({ name: 'REC.LAST_STEP', type: TYPE.BOOL, scope: SCOPE.RECIPE, desc: 'The current step is the last one — advancing from here finishes the batch' }),
]);

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

/**
 * Whether a value is a plain record we can read fields off.
 * @param {*} v anything
 * @returns {boolean} true for a non-null, non-array object
 */
function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Whether something is a usable tag database, duck-typed the way the solver does it so a field
 * rename cannot stop a batch.
 * @param {*} db candidate
 * @returns {boolean} true when tags can be read and written on it
 */
function hasDb(db) {
  return !!db && db.tags instanceof Map;
}

/**
 * A finite number, or a fallback.
 * @param {*} v candidate
 * @param {number} dflt what to use when `v` is not a finite number
 * @returns {number} the number
 */
function finite(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Text, trimmed and cut to a length. Never returns anything but a string.
 * @param {*} v candidate
 * @param {number} max longest result
 * @returns {string} the text
 */
function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * Format a number for the text file so the round trip is exact.
 *
 * `String()` on a JS number is the shortest text that reads back as the same double, which is
 * precisely the property a diffable file format needs. The only special cases are the values that
 * would read back as something else.
 * @param {number} v the number
 * @returns {string} its text
 */
function num(v) {
  if (!Number.isFinite(v)) return '0';
  return Object.is(v, -0) ? '0' : String(v);
}

/**
 * Quote a name for the text file.
 * @param {string} s the name
 * @returns {string} the quoted, escaped form
 */
function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Read a quoted string off the front of a line.
 * @param {string} src the remaining text
 * @returns {{ok:boolean, value?:string, rest?:string, reason?:string}} the string and what follows
 */
function readQuoted(src) {
  const s = src.trimStart();
  if (s[0] !== '"') return { ok: false, reason: 'a name in double quotes was expected' };
  let out = '';
  for (let i = 1; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 1; continue; }
    if (c === '"') return { ok: true, value: out, rest: s.slice(i + 1).trim() };
    out += c;
  }
  return { ok: false, reason: 'the name is missing its closing quote' };
}

/**
 * A problem record, in the shape `model.js` uses so one component can render both lists.
 * @param {number} step the step number the problem is on, or 0 for the recipe itself
 * @param {string} field which column it is in
 * @param {string} severity one of {@link SEVERITY}
 * @param {string} message a sentence an operator could read
 * @returns {object} the problem
 */
function problem(step, field, severity, message) {
  return { step, field, severity, message };
}

// ---------------------------------------------------------------------------------------------
// the recipe document
// ---------------------------------------------------------------------------------------------

/**
 * A step with every field present and legal, ready to be edited.
 *
 * Steps are created whole rather than merged into existence, because a step table where some rows
 * carry a field and others do not is the shape that makes a grid renderer full of `?? 0`.
 *
 * @param {number} n the step number, 1-based
 * @param {object} [over] initial field overrides
 * @returns {object} a step
 */
export function createStep(n, over) {
  const step = {
    n: Math.max(1, Math.round(finite(n, 1))),
    name: `Step ${Math.max(1, Math.round(finite(n, 1)))}`,
    /** Which variable the loop controls during this step, one of {@link LOOP}. */
    loop: LOOP.PRESSURE,
    /** The setpoint the step ends at, in that loop's engineering units. */
    sp: 0,
    /** How the machines are placed, one of {@link PUMPS}. */
    pumps: PUMPS.AUTO,
    /** Nominal duration, minutes. Always drives `REC.TIME_DN`, even when the step advances on a condition. */
    minutes: 1,
    /** Hold band around the setpoint, engineering units. */
    holdBand: 0,
    /** Seconds to ramp the published setpoint from where it was into this step's target. */
    ramp_s: 0,
    /** What advances the step. */
    next: { on: NEXT.TIME, value: 0, after_s: 0 },
    /** Tag writes made once, on entry to the step. */
    actions: [],
  };
  return normaliseStep(isRecord(over) ? { ...step, ...over, n: step.n } : step, step.n);
}

/**
 * A canonical copy of a step: every field present, every field the right type, defaults where the
 * condition in force makes a field meaningless.
 *
 * Zeroing the threshold on a condition that takes none is what makes the text round trip exact —
 * a value nobody can see must not survive a save and reappear in a diff.
 *
 * @param {*} raw anything shaped like a step
 * @param {number} n the step number to stamp on it
 * @returns {object} a fresh, normalised step
 */
function normaliseStep(raw, n) {
  const r = isRecord(raw) ? raw : {};
  const on = typeof r.next === 'object' && r.next && NEXT[r.next.on] ? r.next.on : NEXT.TIME;
  const spec = NEXT_SPECS[on];
  const rawNext = isRecord(r.next) ? r.next : {};
  const actions = Array.isArray(r.actions) ? r.actions : [];
  return {
    n: Math.max(1, Math.round(finite(n, 1))),
    name: text(r.name, LIMITS.name) || `Step ${n}`,
    loop: LOOP[r.loop] ? r.loop : (typeof r.loop === 'string' ? r.loop : LOOP.PRESSURE),
    sp: finite(r.sp, 0),
    pumps: PUMPS[r.pumps] ? r.pumps : (typeof r.pumps === 'string' ? r.pumps : PUMPS.AUTO),
    minutes: finite(r.minutes, 0),
    holdBand: finite(r.holdBand, 0),
    ramp_s: finite(r.ramp_s, 0),
    next: {
      on: NEXT[rawNext.on] ? rawNext.on : (typeof rawNext.on === 'string' ? rawNext.on : NEXT.TIME),
      value: spec && !spec.needsValue ? 0 : finite(rawNext.value, 0),
      after_s: finite(rawNext.after_s, 0),
    },
    actions: actions.slice(0, LIMITS.actions).filter(isRecord).map((a) => ({
      tag: typeof a.tag === 'string' ? a.tag.trim().toUpperCase() : '',
      value: normaliseActionValue(a.value),
    })),
  };
}

/**
 * An action's value, reduced to the three things a tag can hold.
 * @param {*} v the value as written
 * @returns {boolean|number|string} the value the write will use
 */
function normaliseActionValue(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') return v.slice(0, LIMITS.name);
  return 0;
}

/**
 * An empty recipe with one step, which is the shape the grid opens on.
 * @param {string} name what to call it
 * @returns {object} the recipe
 */
export function createRecipe(name) {
  return {
    v: RECIPE_VERSION,
    name: text(name, LIMITS.name) || 'New recipe',
    notes: '',
    steps: [createStep(1)],
  };
}

/**
 * A canonical deep copy. Everything that leaves this module — a load from the book, a parse from
 * text, the batch the sequencer took — goes through here, so no two parts of the program can end
 * up holding the same mutable step.
 * @param {*} raw anything shaped like a recipe
 * @returns {object} a fresh, normalised recipe
 */
export function cloneRecipe(raw) {
  const r = isRecord(raw) ? raw : {};
  const steps = Array.isArray(r.steps) ? r.steps.slice(0, LIMITS.steps) : [];
  const notes = typeof r.notes === 'string'
    ? r.notes.split('\n').map((l) => l.trim()).join('\n').trim().slice(0, LIMITS.notes)
    : '';
  return {
    v: RECIPE_VERSION,
    name: text(r.name, LIMITS.name) || 'Untitled recipe',
    notes,
    steps: steps.map((s, i) => normaliseStep(s, i + 1)),
  };
}

/**
 * Total nominal duration of a recipe, minutes. What the grid puts in its footer.
 * @param {object} recipe the recipe
 * @returns {number} the sum of the step durations
 */
export function recipeMinutes(recipe) {
  if (!isRecord(recipe) || !Array.isArray(recipe.steps)) return 0;
  let total = 0;
  for (const s of recipe.steps) total += Math.max(0, finite(s && s.minutes, 0));
  return total;
}

/**
 * Renumber the steps so `n` is always the row index plus one.
 * @param {object} recipe the recipe (mutated)
 * @returns {void}
 */
function renumber(recipe) {
  for (let i = 0; i < recipe.steps.length; i += 1) recipe.steps[i].n = i + 1;
}

/**
 * Add a step.
 * @param {object} recipe the recipe (mutated)
 * @param {object} [patch] the step's fields; anything missing takes its default
 * @param {number} [index] where to insert it, 0-based; appended when omitted
 * @returns {{ok:boolean, reason?:string, n?:number}} the new step's number, or a refusal
 */
export function addStep(recipe, patch, index) {
  if (!isRecord(recipe) || !Array.isArray(recipe.steps)) {
    return { ok: false, reason: 'There is no recipe to add a step to.' };
  }
  if (recipe.steps.length >= LIMITS.steps) {
    return {
      ok: false,
      reason: `A recipe is limited to ${LIMITS.steps} steps — split a longer batch into two `
        + 'recipes so an operator can see the whole table at once.',
    };
  }
  const at = Number.isFinite(index)
    ? clamp(Math.round(index), 0, recipe.steps.length)
    : recipe.steps.length;
  const step = createStep(at + 1, patch);
  const bad = stepProblems(step, at + 1).find((p) => p.severity === SEVERITY.ERROR);
  if (bad) return { ok: false, reason: bad.message };
  recipe.steps.splice(at, 0, step);
  renumber(recipe);
  return { ok: true, n: at + 1 };
}

/**
 * Remove a step.
 * @param {object} recipe the recipe (mutated)
 * @param {number} n the step number
 * @returns {{ok:boolean, reason?:string}} ok, or a refusal
 */
export function removeStep(recipe, n) {
  if (!isRecord(recipe) || !Array.isArray(recipe.steps)) {
    return { ok: false, reason: 'There is no recipe to remove a step from.' };
  }
  const at = recipe.steps.findIndex((s) => s.n === n);
  if (at < 0) return { ok: false, reason: `There is no step ${n} in this recipe.` };
  if (recipe.steps.length === 1) {
    return {
      ok: false,
      reason: 'A recipe needs at least one step. Edit this one rather than deleting it.',
    };
  }
  recipe.steps.splice(at, 1);
  renumber(recipe);
  return { ok: true };
}

/**
 * Move a step up or down the table.
 * @param {object} recipe the recipe (mutated)
 * @param {number} n the step number
 * @param {number} delta how far to move it; negative is earlier
 * @returns {{ok:boolean, reason?:string, n?:number}} the step's new number, or a refusal
 */
export function moveStep(recipe, n, delta) {
  if (!isRecord(recipe) || !Array.isArray(recipe.steps)) {
    return { ok: false, reason: 'There is no recipe to reorder.' };
  }
  const at = recipe.steps.findIndex((s) => s.n === n);
  if (at < 0) return { ok: false, reason: `There is no step ${n} in this recipe.` };
  const to = clamp(at + Math.round(finite(delta, 0)), 0, recipe.steps.length - 1);
  if (to === at) return { ok: false, reason: `Step ${n} is already at the end of the table.` };
  const [step] = recipe.steps.splice(at, 1);
  recipe.steps.splice(to, 0, step);
  renumber(recipe);
  return { ok: true, n: to + 1 };
}

/**
 * Edit a step.
 *
 * The patch is applied to a copy and validated there, so a refused edit leaves the recipe exactly
 * as it was. A grid that half-applies a bad row is how a recipe ends up with a setpoint from one
 * loop mode and the units of another.
 *
 * @param {object} recipe the recipe (mutated only on success)
 * @param {number} n the step number
 * @param {object} patch the fields to change
 * @returns {{ok:boolean, reason?:string}} ok, or a sentence saying what is wrong with the edit
 */
export function setStep(recipe, n, patch) {
  if (!isRecord(recipe) || !Array.isArray(recipe.steps)) {
    return { ok: false, reason: 'There is no recipe to edit.' };
  }
  const at = recipe.steps.findIndex((s) => s.n === n);
  if (at < 0) return { ok: false, reason: `There is no step ${n} in this recipe.` };
  if (!isRecord(patch)) return { ok: false, reason: 'An edit needs at least one field to change.' };

  const merged = { ...recipe.steps[at], ...patch };
  // `next` is a record of its own, so a patch that changes only the threshold must not throw the
  // condition away with it.
  if (isRecord(patch.next)) merged.next = { ...recipe.steps[at].next, ...patch.next };
  const step = normaliseStep(merged, n);
  const bad = stepProblems(step, n).find((p) => p.severity === SEVERITY.ERROR);
  if (bad) return { ok: false, reason: bad.message };
  recipe.steps[at] = step;
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

/**
 * Everything wrong with one step.
 * @param {object} step a normalised step
 * @param {number} n the step number to report against
 * @returns {object[]} problems, in {@link problem} shape
 */
function stepProblems(step, n) {
  const out = [];
  const where = `Step ${n} '${step.name}'`;

  if (!step.name) {
    out.push(problem(n, 'name', SEVERITY.WARNING,
      `Step ${n} has no name, so the batch record will only say what number it was.`));
  }

  if (!LOOP[step.loop]) {
    out.push(problem(n, 'loop', SEVERITY.ERROR,
      `${where} selects the loop mode ${step.loop || '(blank)'}, and this rig can control `
      + `${Object.keys(LOOP).join(', ')}. Nothing else is instrumented.`));
  } else {
    const eu = LOOP_EU[step.loop];
    if (!Number.isFinite(step.sp)) {
      out.push(problem(n, 'sp', SEVERITY.ERROR, `${where} has no setpoint.`));
    } else if (step.sp < eu.lo || step.sp > eu.hi) {
      out.push(problem(n, 'sp', SEVERITY.ERROR,
        `${where} asks for ${step.sp} ${eu.unit} and ${eu.pv} only reads ${eu.lo} to ${eu.hi} `
        + `${eu.unit}. The loop would sit against its limit for the whole step.`));
    }
    if (step.holdBand > (eu.hi - eu.lo)) {
      out.push(problem(n, 'holdBand', SEVERITY.WARNING,
        `${where} has a hold band wider than the whole ${eu.pv} range, so it is always satisfied.`));
    }
  }

  if (!PUMPS[step.pumps]) {
    out.push(problem(n, 'pumps', SEVERITY.ERROR,
      `${where} asks for the pump configuration ${step.pumps || '(blank)'}; the choices are `
      + `${Object.keys(PUMPS).join(', ')}.`));
  }

  if (!(step.minutes >= 0) || step.minutes > LIMITS.minutes) {
    out.push(problem(n, 'minutes', SEVERITY.ERROR,
      `${where} runs for ${step.minutes} minutes; a step is between 0 and ${LIMITS.minutes}.`));
  }
  if (!(step.holdBand >= 0)) {
    out.push(problem(n, 'holdBand', SEVERITY.ERROR,
      `${where} has a negative hold band, and a band is a distance either side of the setpoint.`));
  }
  if (!(step.ramp_s >= 0) || step.ramp_s > LIMITS.ramp_s) {
    out.push(problem(n, 'ramp_s', SEVERITY.ERROR,
      `${where} ramps over ${step.ramp_s} s; a ramp is between 0 and ${LIMITS.ramp_s} s.`));
  }

  const spec = NEXT_SPECS[step.next.on];
  if (!spec) {
    out.push(problem(n, 'next', SEVERITY.ERROR,
      `${where} advances on ${step.next.on || '(blank)'}, which is not one of the conditions this `
      + `sequencer measures: ${Object.keys(NEXT).join(', ')}.`));
  } else {
    if (spec.needsValue && !Number.isFinite(step.next.value)) {
      out.push(problem(n, 'next', SEVERITY.ERROR,
        `${where} advances on ${spec.label} but names no threshold to compare against.`));
    }
    if (!(step.next.after_s >= 0) || step.next.after_s > LIMITS.after_s) {
      out.push(problem(n, 'next', SEVERITY.ERROR,
        `${where} holds its condition for ${step.next.after_s} s; that dwell is between 0 and `
        + `${LIMITS.after_s} s.`));
    }
    if (step.next.on === NEXT.IN_BAND && !(step.holdBand > 0)) {
      out.push(problem(n, 'holdBand', SEVERITY.ERROR,
        `${where} advances when the measurement is inside the hold band, and the band is zero. `
        + 'No real measurement ever sits exactly on setpoint, so the step would never end.'));
    }
    if (step.next.on === NEXT.TIME && step.minutes === 0) {
      out.push(problem(n, 'minutes', SEVERITY.WARNING,
        `${where} advances on its timer and is zero minutes long, so it completes on the scan it `
        + 'starts. That is a legal way to fire the entry actions and nothing else.'));
    }
    if (step.next.on === NEXT.TIME && step.ramp_s > step.minutes * 60) {
      out.push(problem(n, 'ramp_s', SEVERITY.WARNING,
        `${where} ramps for ${step.ramp_s} s inside a ${step.minutes} minute step, so it advances `
        + 'before the setpoint has arrived.'));
    }
    if (step.next.on === NEXT.OPERATOR) {
      out.push(problem(n, 'next', SEVERITY.INFO,
        `${where} waits for a person. Nothing but REC.ADVANCE will move it on.`));
    }
  }

  const seen = new Set();
  for (const a of step.actions) {
    const m = TAG_RE.exec(a.tag);
    if (!m) {
      out.push(problem(n, 'actions', SEVERITY.ERROR,
        `${where} writes '${a.tag || '(blank)'}' on entry, which is not a tag name.`));
      continue;
    }
    if (!ACTION_PREFIXES.includes(m[1])) {
      out.push(problem(n, 'actions', SEVERITY.ERROR,
        `${where} writes ${a.tag} on entry. A step may only write ${ACTION_PREFIXES.map((x) => `${x}.`).join(', ')} `
        + 'tags — the input image is overwritten from the plant every scan, so a write to it '
        + 'would not survive to the next rung.'));
      continue;
    }
    if (seen.has(a.tag)) {
      out.push(problem(n, 'actions', SEVERITY.WARNING,
        `${where} writes ${a.tag} twice on entry; only the last write survives.`));
    }
    seen.add(a.tag);
  }
  if (step.actions.length > LIMITS.actions) {
    out.push(problem(n, 'actions', SEVERITY.ERROR,
      `${where} has more than ${LIMITS.actions} entry actions.`));
  }
  return out;
}

/**
 * Everything wrong with a recipe, worst first.
 *
 * This is the gate {@link startRecipe} stands behind. The point of running it over the whole table
 * rather than checking each step as it is entered is that a recipe fails at the door or not at
 * all: a batch that stops halfway through step four leaves the plant in a state nobody designed,
 * with the operator holding a recipe they cannot finish and cannot cleanly abandon.
 *
 * @param {object} recipe the recipe
 * @param {object} [db] a tag database; when given, entry-action tags are checked for existence
 * @returns {object[]} problems as `{step, field, severity, message}`, errors first
 */
export function validateRecipe(recipe, db) {
  if (!isRecord(recipe)) {
    return [problem(0, 'recipe', SEVERITY.ERROR, 'There is no recipe here to check.')];
  }
  const out = [];
  if (!text(recipe.name, LIMITS.name)) {
    out.push(problem(0, 'name', SEVERITY.ERROR,
      'The recipe has no name, and the book is indexed by name.'));
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    out.push(problem(0, 'steps', SEVERITY.ERROR,
      'The recipe has no steps, so there is nothing for the sequencer to walk.'));
    return out;
  }
  if (recipe.steps.length > LIMITS.steps) {
    out.push(problem(0, 'steps', SEVERITY.ERROR,
      `The recipe has ${recipe.steps.length} steps and the limit is ${LIMITS.steps}.`));
  }

  const seen = new Set();
  for (let i = 0; i < recipe.steps.length; i += 1) {
    const raw = recipe.steps[i];
    if (!isRecord(raw)) {
      out.push(problem(i + 1, 'step', SEVERITY.ERROR, `Row ${i + 1} of the table is not a step.`));
      continue;
    }
    if (raw.n !== i + 1) {
      out.push(problem(i + 1, 'n', SEVERITY.ERROR,
        `Row ${i + 1} is numbered ${raw.n}. Step numbers are the row order and the sequencer `
        + 'walks them in that order, so a gap or a repeat means the table does not say what runs '
        + 'next.'));
    }
    if (seen.has(raw.n)) {
      out.push(problem(i + 1, 'n', SEVERITY.ERROR, `There are two steps numbered ${raw.n}.`));
    }
    seen.add(raw.n);
    out.push(...stepProblems(normaliseStep(raw, i + 1), i + 1));
  }

  if (hasDb(db)) {
    for (const step of recipe.steps) {
      if (!isRecord(step) || !Array.isArray(step.actions)) continue;
      for (const a of step.actions) {
        if (!isRecord(a) || !TAG_RE.test(String(a.tag))) continue;
        if (!tagExists(db, a.tag)) {
          out.push(problem(step.n, 'actions', SEVERITY.ERROR,
            `Step ${step.n} writes ${a.tag} on entry and there is no such tag in this processor.`));
        }
      }
    }
  }

  const rank = { [SEVERITY.ERROR]: 0, [SEVERITY.WARNING]: 1, [SEVERITY.INFO]: 2 };
  out.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (a.step - b.step));
  return out;
}

/**
 * The first error in a recipe, as a sentence, or null when it is fit to run.
 * @param {object} recipe the recipe
 * @param {object} [db] a tag database, as {@link validateRecipe} takes
 * @returns {string|null} the refusal, or null
 */
export function recipeRefusal(recipe, db) {
  const bad = validateRecipe(recipe, db).find((p) => p.severity === SEVERITY.ERROR);
  return bad ? bad.message : null;
}

// ---------------------------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------------------------

/**
 * Write a recipe out as text.
 *
 * The recipe is normalised on the way out, so a recipe assembled by hand somewhere else still
 * produces a file that reads back as itself.
 *
 * @param {object} recipe the recipe
 * @returns {string} the text, ending in a newline
 */
export function recipeToText(recipe) {
  const r = cloneRecipe(recipe);
  const out = [];
  out.push(`RECIPE ${quote(r.name)}`);
  out.push(`VERSION ${RECIPE_VERSION}`);
  if (r.notes) for (const line of r.notes.split('\n')) out.push(`NOTES ${line}`);
  for (const s of r.steps) {
    out.push('');
    out.push(`STEP ${s.n} ${quote(s.name)}`);
    out.push(`  LOOP ${s.loop}`);
    out.push(`  SP ${num(s.sp)}`);
    out.push(`  PUMPS ${s.pumps}`);
    out.push(`  MINUTES ${num(s.minutes)}`);
    out.push(`  BAND ${num(s.holdBand)}`);
    out.push(`  RAMP ${num(s.ramp_s)}`);
    const spec = NEXT_SPECS[s.next.on];
    let next = `  NEXT ${s.next.on}`;
    if (spec && spec.needsValue) next += ` ${num(s.next.value)}`;
    if (s.next.after_s > 0) next += ` AFTER ${num(s.next.after_s)}`;
    out.push(next);
    for (const a of s.actions) out.push(`  DO ${a.tag} = ${actionValueToText(a.value)}`);
    out.push('END');
  }
  return `${out.join('\n')}\n`;
}

/**
 * An action value as text.
 * @param {boolean|number|string} v the value
 * @returns {string} its text form
 */
function actionValueToText(v) {
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  if (typeof v === 'number') return num(v);
  return quote(v);
}

/**
 * An action value read back from text.
 * @param {string} src the token text
 * @returns {{ok:boolean, value?:boolean|number|string, reason?:string}} the value
 */
function actionValueFromText(src) {
  const s = src.trim();
  if (/^(ON|TRUE|1)$/i.test(s)) return { ok: true, value: /^1$/.test(s) ? 1 : true };
  if (/^(OFF|FALSE)$/i.test(s)) return { ok: true, value: false };
  if (s[0] === '"') {
    const q = readQuoted(s);
    return q.ok ? { ok: true, value: q.value } : { ok: false, reason: q.reason };
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, reason: `'${s}' is not a value a tag can hold` };
  return { ok: true, value: n };
}

/**
 * Read a recipe back from text.
 *
 * Parse problems and validation problems come back in one list, both carrying the line they are
 * on, because someone editing a shared file wants one list to work down rather than two rounds of
 * "fix this, now fix that".
 *
 * @param {string} src the text
 * @returns {{ok:boolean, recipe?:object, problems?:object[]}} the recipe, or what is wrong with it
 */
export function recipeFromText(src) {
  if (typeof src !== 'string' || src.trim() === '') {
    return { ok: false, problems: [{ line: 1, severity: SEVERITY.ERROR, message: 'There is no recipe text to read.' }] };
  }
  const problems = [];
  /**
   * Record a parse problem.
   * @param {number} line 1-based line number
   * @param {string} severity one of {@link SEVERITY}
   * @param {string} message a sentence an operator could read
   * @returns {void}
   */
  const bad = (line, severity, message) => problems.push({ line, severity, message });

  const recipe = { v: RECIPE_VERSION, name: '', notes: '', steps: [] };
  const notes = [];
  const stepLine = new Map();
  let step = null;
  let sawRecipe = false;

  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const ln = i + 1;
    const raw = lines[i].replace(/\s+;.*$/, '').trim();
    if (raw === '' || raw.startsWith(';')) continue;
    const sp = raw.indexOf(' ');
    const key = (sp < 0 ? raw : raw.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : raw.slice(sp + 1).trim();

    if (key === 'RECIPE') {
      const q = readQuoted(rest);
      if (!q.ok) { bad(ln, SEVERITY.ERROR, `RECIPE: ${q.reason}`); continue; }
      recipe.name = q.value;
      sawRecipe = true;
      continue;
    }
    if (!sawRecipe) {
      bad(ln, SEVERITY.ERROR, 'The file must open with a RECIPE line naming the recipe.');
      sawRecipe = true;
      continue;
    }
    if (key === 'VERSION') {
      const v = Number(rest);
      if (!Number.isFinite(v)) bad(ln, SEVERITY.WARNING, `VERSION ${rest} is not a number and was ignored.`);
      else if (v > RECIPE_VERSION) {
        bad(ln, SEVERITY.WARNING,
          `This recipe was written by a newer build (version ${v}). Anything this one does not `
          + 'understand has been dropped.');
      }
      continue;
    }
    if (key === 'NOTES') { notes.push(rest); continue; }

    if (key === 'STEP') {
      if (step) {
        bad(ln, SEVERITY.ERROR, `Step ${step.n} was never closed with END.`);
        recipe.steps.push(step);
      }
      const m = /^(\d+)\s*(.*)$/.exec(rest);
      if (!m) { bad(ln, SEVERITY.ERROR, 'STEP needs a number, as in: STEP 1 "Soft fill".'); continue; }
      const n = Number(m[1]);
      const q = readQuoted(m[2]);
      step = createStep(n, { name: q.ok ? q.value : `Step ${n}` });
      if (!q.ok) bad(ln, SEVERITY.WARNING, `Step ${n} has no name in quotes, so it was called '${step.name}'.`);
      stepLine.set(n, ln);
      continue;
    }
    if (key === 'END') {
      if (!step) { bad(ln, SEVERITY.ERROR, 'END without a STEP.'); continue; }
      recipe.steps.push(step);
      step = null;
      continue;
    }
    if (!step) {
      bad(ln, SEVERITY.ERROR, `'${key}' is outside any step; a field belongs between STEP and END.`);
      continue;
    }

    switch (key) {
      case 'LOOP':
        step.loop = rest.toUpperCase();
        break;
      case 'PUMPS':
        step.pumps = rest.toUpperCase();
        break;
      case 'SP': case 'MINUTES': case 'BAND': case 'RAMP': {
        const v = Number(rest);
        if (!Number.isFinite(v)) { bad(ln, SEVERITY.ERROR, `${key} ${rest} is not a number.`); break; }
        if (key === 'SP') step.sp = v;
        else if (key === 'MINUTES') step.minutes = v;
        else if (key === 'BAND') step.holdBand = v;
        else step.ramp_s = v;
        break;
      }
      case 'NEXT': {
        const parts = rest.split(/\s+/).filter(Boolean);
        const on = (parts.shift() || '').toUpperCase();
        step.next.on = on;
        const spec = NEXT_SPECS[on];
        if (parts.length && parts[0].toUpperCase() !== 'AFTER') {
          const v = Number(parts.shift());
          if (!Number.isFinite(v)) bad(ln, SEVERITY.ERROR, `NEXT ${on}: the threshold is not a number.`);
          else step.next.value = spec && !spec.needsValue ? 0 : v;
        }
        if (parts.length) {
          if (parts[0].toUpperCase() !== 'AFTER') {
            bad(ln, SEVERITY.ERROR, `NEXT ${on}: '${parts[0]}' was not expected — the dwell reads AFTER 20.`);
          } else {
            const v = Number(parts[1]);
            if (!Number.isFinite(v)) bad(ln, SEVERITY.ERROR, `NEXT ${on}: AFTER needs a number of seconds.`);
            else step.next.after_s = v;
          }
        }
        break;
      }
      case 'DO': {
        const m = /^([A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(rest);
        if (!m) { bad(ln, SEVERITY.ERROR, 'DO reads: DO Q.SEQ_ENABLE = OFF'); break; }
        const val = actionValueFromText(m[2]);
        if (!val.ok) { bad(ln, SEVERITY.ERROR, `DO ${m[1]}: ${val.reason}`); break; }
        step.actions.push({ tag: m[1].toUpperCase(), value: val.value });
        break;
      }
      default:
        bad(ln, SEVERITY.ERROR, `'${key}' is not a step field.`);
    }
  }
  if (step) {
    bad(lines.length, SEVERITY.ERROR, `Step ${step.n} was never closed with END.`);
    recipe.steps.push(step);
  }
  recipe.notes = notes.join('\n').trim().slice(0, LIMITS.notes);

  const out = cloneRecipe(recipe);
  for (const p of validateRecipe(out)) {
    problems.push({ line: stepLine.get(p.step) || 1, severity: p.severity, message: p.message });
  }
  if (problems.some((p) => p.severity === SEVERITY.ERROR)) return { ok: false, problems };
  return { ok: true, recipe: out, problems };
}

// ---------------------------------------------------------------------------------------------
// the book
// ---------------------------------------------------------------------------------------------

/**
 * The three recipes the rig ships with, as text so they are read, reviewed and edited in exactly
 * the form a shared recipe arrives in.
 */
export const STOCK_RECIPES = Object.freeze([
  Object.freeze({
    id: 'PRESSURE_PROFILE',
    name: 'Header pressure profile',
    blurb: 'Three setpoints, walked the way a shift walks them by hand.',
    text: `RECIPE "Header pressure profile"
VERSION 1
NOTES The simplest thing a recipe can be: three pressures, each held for a while.
NOTES Step 1 keeps one machine on so the fill is gentle; step 2 hands the set back to
NOTES staging for the duty period; step 3 trims back before the batch is handed over.

STEP 1 "Soft fill"
  LOOP PRESSURE
  SP 2.2
  PUMPS LEAD
  MINUTES 3
  BAND 0.15
  RAMP 60
  NEXT IN_BAND AFTER 20
  DO Q.SEQ_ENABLE = OFF
END

STEP 2 "Run at duty"
  LOOP PRESSURE
  SP 3.4
  PUMPS AUTO
  MINUTES 10
  BAND 0.1
  RAMP 30
  NEXT TIME
  DO Q.SEQ_ENABLE = ON
END

STEP 3 "Trim back"
  LOOP PRESSURE
  SP 2.8
  PUMPS AUTO
  MINUTES 5
  BAND 0.1
  RAMP 45
  NEXT TIME
END
`,
  }),
  Object.freeze({
    id: 'CIP',
    name: 'CIP circulation',
    blurb: 'Fill, ramp to a circulation rate, soak, rinse by volume, drain and hand back.',
    text: `RECIPE "CIP circulation"
VERSION 1
NOTES A clean-in-place shaped batch, and the one that shows what the extra columns are for:
NOTES a ramped setpoint so the header is not stepped, a soak that ends on its timer, a rinse
NOTES that ends on VOLUME delivered rather than on time, and a drain that ends on level.
NOTES Steps 2 to 4 control FLOW rather than pressure. Changing loop mode resets the tuning to
NOTES the default for the new variable, which is deliberate — gains carry units — so expect the
NOTES first minute after each change to be softer than the tuning you left behind.

STEP 1 "Fill and vent"
  LOOP PRESSURE
  SP 1.6
  PUMPS LEAD
  MINUTES 4
  BAND 0.1
  RAMP 0
  NEXT PV_ABOVE 1.4 AFTER 10
  DO Q.SEQ_ENABLE = OFF
END

STEP 2 "Ramp to circulation"
  LOOP FLOW
  SP 95
  PUMPS BOTH
  MINUTES 6
  BAND 4
  RAMP 180
  NEXT IN_BAND AFTER 30
END

STEP 3 "Wash soak"
  LOOP FLOW
  SP 95
  PUMPS BOTH
  MINUTES 20
  BAND 4
  RAMP 0
  NEXT TIME
END

STEP 4 "Rinse to volume"
  LOOP FLOW
  SP 70
  PUMPS AUTO
  MINUTES 15
  BAND 5
  RAMP 120
  NEXT VOLUME 12
  DO Q.SEQ_ENABLE = ON
END

STEP 5 "Drain down"
  LOOP LEVEL
  SP 0.6
  PUMPS LEAD
  MINUTES 8
  BAND 0.05
  RAMP 0
  NEXT LEVEL_BELOW 0.7 AFTER 15
  DO Q.SEQ_ENABLE = OFF
END

STEP 6 "Hand back"
  LOOP PRESSURE
  SP 3.2
  PUMPS AUTO
  MINUTES 2
  BAND 0.1
  RAMP 30
  NEXT OPERATOR
  DO Q.SEQ_ENABLE = ON
END
`,
  }),
  Object.freeze({
    id: 'DUTY_TEST',
    name: 'Duty test',
    blurb: 'Each machine alone, then both together, so a weekly test proves the standby runs.',
    text: `RECIPE "Duty test"
VERSION 1
NOTES The test a maintenance department actually asks for: prove the standby machine will
NOTES start and hold the header on its own, because the one that never runs is the one that
NOTES has seized. Staging is held off for the solo steps so the sequence cannot quietly bring
NOTES the other machine in and hide a failure.

STEP 1 "P-101 alone"
  LOOP PRESSURE
  SP 3
  PUMPS P1
  MINUTES 5
  BAND 0.15
  RAMP 20
  NEXT TIME
  DO Q.SEQ_ENABLE = OFF
END

STEP 2 "Changeover overlap"
  LOOP PRESSURE
  SP 3
  PUMPS BOTH
  MINUTES 1
  BAND 0.15
  RAMP 0
  NEXT TIME
END

STEP 3 "P-102 alone"
  LOOP PRESSURE
  SP 3
  PUMPS P2
  MINUTES 5
  BAND 0.15
  RAMP 0
  NEXT TIME
END

STEP 4 "Both at high demand"
  LOOP FLOW
  SP 120
  PUMPS BOTH
  MINUTES 4
  BAND 5
  RAMP 60
  NEXT IN_BAND AFTER 30
END

STEP 5 "Back to auto"
  LOOP PRESSURE
  SP 3.2
  PUMPS AUTO
  MINUTES 1
  BAND 0.1
  RAMP 30
  NEXT TIME
  DO Q.SEQ_ENABLE = ON
END
`,
  }),
]);

/** The stock recipes parsed once, keyed by name. Built lazily so the module loads cheaply. */
let STOCK_BY_NAME = null;

/**
 * The parsed stock recipes, keyed by name.
 * @returns {Map<string, object>} name to recipe
 */
function stockMap() {
  if (STOCK_BY_NAME) return STOCK_BY_NAME;
  STOCK_BY_NAME = new Map();
  for (const s of STOCK_RECIPES) {
    const r = recipeFromText(s.text);
    // A stock recipe that does not parse is a defect in this file, not in the operator's input.
    // The test parses all three; here we simply skip it rather than take the whole book down.
    if (r.ok) STOCK_BY_NAME.set(r.recipe.name, r.recipe);
  }
  return STOCK_BY_NAME;
}

/**
 * A fresh copy of a shipped recipe.
 * @param {string} id one of the {@link STOCK_RECIPES} ids
 * @returns {object|null} a normalised recipe, or null when the id is unknown
 */
export function stockRecipe(id) {
  const spec = STOCK_RECIPES.find((s) => s.id === id);
  if (!spec) return null;
  const r = stockMap().get(spec.name);
  return r ? cloneRecipe(r) : null;
}

/**
 * Open the recipe book.
 *
 * The shipped recipes are always present. A user recipe saved under a shipped name shadows it,
 * and deleting that copy brings the shipped one back — which means an operator can experiment on
 * `Duty test` and get the original back without a reinstall.
 *
 * Storage is whatever the UI was handed and all four of its failure modes are ordinary: absent,
 * `getItem` throws, the text is truncated, the text came from a newer build. None of them throws
 * out of here and none of them costs more than the entries that could not be understood.
 *
 * @param {{getItem:Function, setItem:Function}|null} [storage] injected storage, or null
 * @returns {object} the book
 */
export function createRecipeBook(storage) {
  const book = {
    v: RECIPE_VERSION,
    storage: storage && typeof storage.getItem === 'function' ? storage : null,
    /** User recipes, by name. The shipped ones are not in here — see {@link listRecipes}. */
    recipes: new Map(),
    /** What could not be read back, for the panel to show once. */
    problems: [],
  };
  if (!book.storage) return book;

  let raw = null;
  try {
    const t = book.storage.getItem(STORAGE_KEY);
    if (typeof t === 'string' && t !== '') raw = JSON.parse(t);
  } catch {
    book.problems.push('The saved recipes could not be read back and were left alone.');
    return book;
  }
  if (!isRecord(raw) || !isRecord(raw.recipes)) return book;
  for (const key of Object.keys(raw.recipes)) {
    const r = cloneRecipe(raw.recipes[key]);
    const refusal = recipeRefusal(r);
    if (refusal) {
      book.problems.push(`'${key}' was saved but is no longer valid and was not loaded: ${refusal}`);
      continue;
    }
    book.recipes.set(r.name, r);
  }
  return book;
}

/**
 * Write the book back to storage.
 * @param {object} book the book
 * @returns {{ok:boolean, reason?:string}} ok, or why it could not be persisted
 */
function persist(book) {
  if (!book.storage || typeof book.storage.setItem !== 'function') {
    return {
      ok: false,
      reason: 'This browser is not offering any storage, so the recipe will only last until the '
        + 'tab closes. Copy it out as text to keep it.',
    };
  }
  const recipes = {};
  for (const [name, r] of book.recipes) recipes[name] = r;
  let t = '';
  try {
    t = JSON.stringify({ v: RECIPE_VERSION, recipes });
  } catch {
    return { ok: false, reason: 'The recipe book could not be turned into text and was not saved.' };
  }
  try {
    book.storage.setItem(STORAGE_KEY, t);
  } catch {
    return {
      ok: false,
      reason: 'The browser refused to save — private browsing, or the storage quota is full. The '
        + 'recipe is still loaded and still runs until you close the tab.',
    };
  }
  return { ok: true };
}

/**
 * Every recipe name the book can offer, shipped and saved, in one sorted list.
 * @param {object} book the book
 * @returns {string[]} the names
 */
export function listRecipes(book) {
  if (!isRecord(book) || !(book.recipes instanceof Map)) return [];
  const names = new Set(stockMap().keys());
  for (const name of book.recipes.keys()) names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The same list with enough on each entry to draw a picker.
 * @param {object} book the book
 * @returns {object[]} `{name, steps, minutes, stock, saved, notes}` per recipe
 */
export function recipeSummaries(book) {
  return listRecipes(book).map((name) => {
    const r = loadRecipe(book, name);
    return {
      name,
      steps: r ? r.steps.length : 0,
      minutes: r ? recipeMinutes(r) : 0,
      stock: stockMap().has(name),
      saved: isRecord(book) && book.recipes instanceof Map ? book.recipes.has(name) : false,
      notes: r ? r.notes : '',
    };
  });
}

/**
 * Take a recipe out of the book.
 *
 * Always a fresh copy: two panels holding the same object would edit each other's rows.
 * @param {object} book the book
 * @param {string} name the recipe's name
 * @returns {object|null} a normalised recipe, or null when the name is not in the book
 */
export function loadRecipe(book, name) {
  if (isRecord(book) && book.recipes instanceof Map && book.recipes.has(name)) {
    return cloneRecipe(book.recipes.get(name));
  }
  const stock = stockMap().get(name);
  return stock ? cloneRecipe(stock) : null;
}

/**
 * Put a recipe in the book and persist it.
 *
 * A recipe carrying an error is refused outright — the book is what the next shift loads from,
 * and a recipe that cannot start is worse there than not being there at all. A recipe that saved
 * into memory but could not reach storage returns `ok` with a `reason`, because the operator's
 * work is not lost and telling them it was would be a lie.
 *
 * @param {object} book the book
 * @param {object} recipe the recipe
 * @returns {{ok:boolean, reason?:string, stored?:boolean}} what happened
 */
export function saveRecipe(book, recipe) {
  if (!isRecord(book) || !(book.recipes instanceof Map)) {
    return { ok: false, reason: 'There is no recipe book open.' };
  }
  const r = cloneRecipe(recipe);
  const refusal = recipeRefusal(r);
  if (refusal) return { ok: false, reason: refusal };
  book.recipes.set(r.name, r);
  const p = persist(book);
  return { ok: true, stored: p.ok, reason: p.ok ? undefined : p.reason };
}

/**
 * Remove a saved recipe.
 * @param {object} book the book
 * @param {string} name the recipe's name
 * @returns {{ok:boolean, reason?:string, restored?:boolean}} ok; `restored` when a shipped recipe
 *   of the same name has come back into view
 */
export function deleteRecipe(book, name) {
  if (!isRecord(book) || !(book.recipes instanceof Map)) {
    return { ok: false, reason: 'There is no recipe book open.' };
  }
  if (!book.recipes.has(name)) {
    if (stockMap().has(name)) {
      return {
        ok: false,
        reason: `'${name}' is a shipped recipe and cannot be deleted. Edit it and save it under `
          + 'another name instead.',
      };
    }
    return { ok: false, reason: `There is no recipe called '${name}'.` };
  }
  book.recipes.delete(name);
  const p = persist(book);
  return { ok: true, restored: stockMap().has(name), reason: p.ok ? undefined : p.reason };
}

// ---------------------------------------------------------------------------------------------
// the sequencer
// ---------------------------------------------------------------------------------------------

/**
 * Define the `REC.*` tags in a database.
 *
 * Idempotent, because {@link stepSequencer} calls it whenever it finds the tags missing and a
 * program load re-installs the whole IO map anyway.
 * @param {object} db the tag database
 * @returns {{ok:boolean, defined:number, problems:string[]}} what happened
 */
export function installRecipeTags(db) {
  if (!hasDb(db)) return { ok: false, defined: 0, problems: ['no tag database was given'] };
  return defineTags(db, RECIPE_TAGS);
}

/**
 * Allocate the sequencer.
 *
 * It starts empty and idle: a processor that came up running somebody's batch because the tab was
 * refreshed is not a processor anybody would trust.
 *
 * @returns {object} sequencer state
 */
export function createSequencer() {
  return {
    /** The copy of the recipe this batch is running. Not the one in the book. */
    recipe: null,
    /** One of {@link SEQ_STATE}. */
    state: SEQ_STATE.IDLE,
    /** True while a batch is in progress, held or not. */
    running: false,
    /** True once the last step has been retired normally. */
    done: false,
    /** Current step number, 1-based; 0 before the first batch. */
    step: 0,
    /** Seconds in the current step. Frozen while held. */
    elapsed_s: 0,
    /** Seconds since the batch started. Frozen while held. */
    batch_s: 0,
    /** Seconds the transition condition has been continuously true. */
    dwell_s: 0,
    /** The sequencer's own clock, integrated from `dt_s`. There is no other clock in `src/plc`. */
    clock_s: 0,
    /** True while `REC.HOLD` is on. */
    held: false,
    /** The published setpoint, part-way along the step's ramp. */
    sp: 0,
    /** Where this step's ramp started from. */
    spFrom: 0,
    /** Where this step's ramp ends. */
    spTo: 0,
    /** `I.M3_TOTAL` at step entry, so VOLUME can be counted from here. */
    m3At: 0,
    /** Volume delivered since the step started, m3. */
    volume_m3: 0,
    /** Latched flags, published every scan. */
    timeDone: false,
    condDone: false,
    stepDone: false,
    inBand: false,
    /** True when the sequencer could not do something it was asked to. */
    fault: false,
    /** The last thing the sequencer did, or could not do. */
    note: 'no recipe loaded',
    /** Edge memories on the four command bits the ladder owns. */
    cmd: { start: false, advance: false, abort: false },
    /** When it advances the sequencer without a rung. Off; see the module header. */
    autoAdvance: false,
    /** The batch record: one entry per step entered, capped at {@link LIMITS.history}. */
    history: [],
  };
}

/**
 * Load a recipe and start it at step 1.
 *
 * Validation happens here and nowhere later. See the module header: a batch either fails at the
 * door or runs to the end.
 *
 * @param {object} seq the sequencer (mutated)
 * @param {object} recipe the recipe to run; deep-copied, so later edits to it do not reach the batch
 * @param {object} [opts] options
 * @param {object} [opts.db] a tag database; when given, the entry actions of step 1 are applied
 *   and the `REC.*` tags are published immediately rather than on the next scan
 * @param {boolean} [opts.autoAdvance=false] advance without a rung asking. For a bench and for a
 *   lesson that has not taught the advance rung yet; the plant never runs this way.
 * @returns {{ok:boolean, reason?:string}} ok, or a sentence saying why the batch cannot start
 */
export function startRecipe(seq, recipe, opts) {
  if (!isRecord(seq)) return { ok: false, reason: 'There is no sequencer to start.' };
  const db = isRecord(opts) && hasDb(opts.db) ? opts.db : null;
  const refusal = recipeRefusal(recipe, db);
  if (refusal) {
    seq.fault = true;
    seq.note = refusal;
    if (db) publish(seq, db);
    return { ok: false, reason: refusal };
  }

  seq.recipe = cloneRecipe(recipe);
  seq.state = SEQ_STATE.RUNNING;
  seq.running = true;
  seq.done = false;
  seq.fault = false;
  seq.held = false;
  seq.batch_s = 0;
  seq.history = [];
  seq.autoAdvance = isRecord(opts) && opts.autoAdvance === true;
  // Take the edge memories FROM the database rather than zeroing them. A rung holding REC.START
  // on while the panel starts the same recipe would otherwise look like a fresh rising edge on
  // the next scan, and the batch would restart itself once a scan forever.
  seq.cmd = {
    start: db ? readTag(db, 'REC.START') === true : false,
    advance: db ? readTag(db, 'REC.ADVANCE') === true : false,
    abort: db ? readTag(db, 'REC.ABORT') === true : false,
  };
  // The ramp into step 1 starts from wherever the loop is actually sitting, not from zero: a
  // recipe that opens by stepping the setpoint to zero and back is a recipe nobody runs twice.
  seq.sp = db ? finite(readTag(db, 'I.PIC_SP'), seq.recipe.steps[0].sp) : seq.recipe.steps[0].sp;
  enterStep(seq, db, 1, 'batch started');
  if (db) publish(seq, db);
  return { ok: true };
}

/**
 * Abandon the batch where it stands.
 *
 * Nothing is written to the plant on the way out. The recipe published a wish through `REC.*` and
 * the ladder is what turned those into commands, so the ladder is what decides what a stopped
 * batch leaves behind — which is the only arrangement where the abort behaviour is editable.
 *
 * @param {object} seq the sequencer (mutated)
 * @param {object} [db] a tag database, to publish the new state at once
 * @returns {{ok:boolean, reason?:string}} ok, or a refusal
 */
export function abortRecipe(seq, db) {
  if (!isRecord(seq)) return { ok: false, reason: 'There is no sequencer to abort.' };
  if (!seq.running) return { ok: false, reason: 'No batch is running.' };
  seq.running = false;
  seq.held = false;
  seq.done = false;
  seq.state = SEQ_STATE.ABORTED;
  seq.stepDone = false;
  seq.condDone = false;
  seq.note = `batch abandoned at step ${seq.step} '${stepAt(seq, seq.step).name}'`;
  record(seq, seq.step, 'aborted');
  if (hasDb(db)) publish(seq, db);
  return { ok: true };
}

/**
 * Put the batch on hold, or take it off hold.
 *
 * Hold is a command bit the ladder owns, so this simply writes it: the sequencer reads `REC.HOLD`
 * and does not care whether a rung, a pushbutton or this function put it there.
 *
 * @param {object} db the tag database
 * @param {boolean} on true to hold
 * @returns {{ok:boolean, reason?:string}} ok, or a refusal
 */
export function holdRecipe(db, on) {
  if (!hasDb(db)) return { ok: false, reason: 'There is no tag database to hold the batch with.' };
  if (!tagExists(db, 'REC.HOLD')) installRecipeTags(db);
  return writeTag(db, 'REC.HOLD', on === true);
}

/**
 * The step with a given number, or a blank stand-in so nothing downstream has to null-check.
 * @param {object} seq the sequencer
 * @param {number} n the step number
 * @returns {object} the step
 */
function stepAt(seq, n) {
  const steps = seq.recipe && Array.isArray(seq.recipe.steps) ? seq.recipe.steps : [];
  return steps[n - 1] || createStep(Math.max(1, n), { name: '', minutes: 0 });
}

/**
 * Add a line to the batch record.
 * @param {object} seq the sequencer (mutated)
 * @param {number} n the step number
 * @param {string} why what happened
 * @returns {void}
 */
function record(seq, n, why) {
  seq.history.push({ step: n, name: stepAt(seq, n).name, at_s: seq.clock_s, why });
  if (seq.history.length > LIMITS.history) seq.history.shift();
}

/**
 * Enter a step: reset the timers, take the ramp's starting point, count the entry actions off.
 * @param {object} seq the sequencer (mutated)
 * @param {object|null} db the tag database, or null when running headless
 * @param {number} n the step number to enter
 * @param {string} why what caused the entry, for the batch record
 * @returns {void}
 */
function enterStep(seq, db, n, why) {
  const step = stepAt(seq, n);
  seq.step = n;
  seq.elapsed_s = 0;
  seq.dwell_s = 0;
  seq.timeDone = false;
  seq.condDone = false;
  seq.stepDone = false;
  seq.inBand = false;
  seq.spFrom = seq.sp;
  seq.spTo = step.sp;
  if (!(step.ramp_s > 0)) seq.sp = step.sp;
  seq.m3At = db ? finite(readTag(db, 'I.M3_TOTAL'), 0) : 0;
  seq.volume_m3 = 0;
  seq.note = `step ${n} '${step.name}' — ${why}`;
  record(seq, n, why);

  if (db) {
    for (const a of step.actions) {
      const r = writeTag(db, a.tag, a.value);
      if (!r.ok) {
        seq.fault = true;
        seq.note = `step ${n} could not write ${a.tag}: ${r.reason}`;
      }
    }
  }
}

/**
 * Read the transition condition's raw state — before the dwell timer is applied.
 * @param {object} seq the sequencer (mutated: a missing source tag raises the fault)
 * @param {object|null} db the tag database
 * @param {object} step the current step
 * @returns {boolean} whether the condition is true this instant
 */
function conditionNow(seq, db, step) {
  const spec = NEXT_SPECS[step.next.on];
  if (!spec) return false;
  if (spec.id === NEXT.TIME) return seq.elapsed_s >= step.minutes * 60;
  if (spec.id === NEXT.OPERATOR) return false;
  if (!db) return false;

  const v = readTag(db, spec.source);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    seq.fault = true;
    seq.note = `step ${step.n} advances on ${spec.source} and that tag has no reading`;
    return false;
  }
  switch (spec.id) {
    case NEXT.IN_BAND: return Math.abs(v - seq.spTo) <= step.holdBand;
    case NEXT.PV_ABOVE: case NEXT.FLOW_ABOVE: case NEXT.LEVEL_ABOVE: return v >= step.next.value;
    case NEXT.PV_BELOW: case NEXT.FLOW_BELOW: case NEXT.LEVEL_BELOW: return v <= step.next.value;
    case NEXT.VOLUME: return (v - seq.m3At) >= step.next.value;
    default: return false;
  }
}

/**
 * Advance the sequencer one scan and publish the `REC.*` tags.
 *
 * Call it once per controller scan, AFTER the input image has been read and BEFORE the ladder is
 * solved — the step state a rung reads must be the state that goes with the inputs it is reading,
 * and `REC.ADVANCE` written by that rung is acted on at the top of the next scan. That one scan
 * of latency is what a real batch station has and it is why the advance rung is visibly a rung
 * rather than an instant, invisible jump.
 *
 * @param {object} seq the sequencer (mutated)
 * @param {object} db the tag database
 * @param {number} dt_s the scan period, s
 * @returns {void}
 */
export function stepSequencer(seq, db, dt_s) {
  if (!isRecord(seq)) return;
  const live = hasDb(db);
  if (live && !tagExists(db, 'REC.STEP')) installRecipeTags(db);

  // A negative, absent or absurd dt is a host problem, never elapsed process time. See MAX_DT_S.
  const raw = finite(dt_s, 0);
  const dt = raw > 0 ? Math.min(raw, MAX_DT_S) : 0;
  seq.clock_s += dt;

  // --- the four bits the ladder owns ---------------------------------------------------------
  const hold = live ? readTag(db, 'REC.HOLD') === true : false;
  const startCmd = live ? readTag(db, 'REC.START') === true : false;
  const advCmd = live ? readTag(db, 'REC.ADVANCE') === true : false;
  const abortCmd = live ? readTag(db, 'REC.ABORT') === true : false;
  const startEdge = startCmd && !seq.cmd.start;
  const advEdge = advCmd && !seq.cmd.advance;
  const abortEdge = abortCmd && !seq.cmd.abort;
  seq.cmd = { start: startCmd, advance: advCmd, abort: abortCmd };

  if (abortEdge && seq.running) abortRecipe(seq, null);
  if (startEdge && !seq.running && seq.recipe) {
    // Re-running the batch already loaded, which is what the panel's START button does. The
    // recipe is re-validated because the operator may have edited and re-loaded it since.
    startRecipe(seq, seq.recipe, { db: live ? db : undefined, autoAdvance: seq.autoAdvance });
  }

  if (!seq.running) {
    seq.held = false;
    if (live) publish(seq, db);
    return;
  }

  seq.held = hold;
  seq.state = hold ? SEQ_STATE.HELD : SEQ_STATE.RUNNING;
  const step = stepAt(seq, seq.step);

  // --- timers ---------------------------------------------------------------------------------
  // Hold freezes the step timer, the batch timer and the dwell alike. An operator who holds a
  // batch to deal with something and comes back to find the step retired itself anyway has been
  // given a hold button that does not hold.
  if (!hold) {
    seq.elapsed_s += dt;
    seq.batch_s += dt;
  }

  // --- the ramped setpoint --------------------------------------------------------------------
  if (step.ramp_s > 0) {
    const f = clamp(seq.elapsed_s / step.ramp_s, 0, 1);
    seq.sp = seq.spFrom + (seq.spTo - seq.spFrom) * f;
  } else {
    seq.sp = seq.spTo;
  }

  // --- conditions -------------------------------------------------------------------------------
  if (live) seq.volume_m3 = Math.max(0, finite(readTag(db, 'I.M3_TOTAL'), seq.m3At) - seq.m3At);
  seq.timeDone = seq.elapsed_s >= step.minutes * 60;
  const pv = live ? readTag(db, 'I.PIC_PV') : undefined;
  seq.inBand = typeof pv === 'number' && Number.isFinite(pv) && step.holdBand > 0
    && Math.abs(pv - seq.spTo) <= step.holdBand;

  const now = conditionNow(seq, live ? db : null, step);
  if (now && !hold) seq.dwell_s += dt; else if (!now) seq.dwell_s = 0;
  seq.condDone = now && seq.dwell_s >= step.next.after_s;
  seq.stepDone = (step.next.on === NEXT.TIME ? seq.timeDone : seq.condDone) && !hold;

  // --- the advance ------------------------------------------------------------------------------
  // The rung is the only thing that moves the batch on. `autoAdvance` exists for a bench and for
  // a lesson that has not taught the rung yet, and the plant never sets it.
  const wants = (advEdge || (seq.autoAdvance && seq.stepDone)) && !hold;
  if (wants) {
    const last = seq.recipe.steps.length;
    if (seq.step >= last) {
      seq.running = false;
      seq.done = true;
      seq.state = SEQ_STATE.DONE;
      seq.stepDone = false;
      seq.note = `batch complete after ${seq.recipe.steps.length} steps`;
      record(seq, seq.step, 'batch complete');
    } else {
      enterStep(seq, live ? db : null, seq.step + 1, advEdge ? 'advanced by the program' : 'advanced');
    }
  }

  if (live) publish(seq, db);
}

/**
 * Write the whole published set.
 *
 * Every scan, unconditionally. A published tag that is only refreshed when it changes looks fine
 * until someone forces it and removes the force, and then sits at the forced value until the
 * sequencer happens to move.
 *
 * @param {object} seq the sequencer
 * @param {object} db the tag database
 * @returns {void}
 */
function publish(seq, db) {
  const step = seq.recipe ? stepAt(seq, seq.step) : createStep(1, { name: '', minutes: 0 });
  const steps = seq.recipe ? seq.recipe.steps.length : 0;
  const running = seq.running === true;
  const wantP1 = running && (step.pumps === PUMPS.P1 || step.pumps === PUMPS.BOTH);
  const wantP2 = running && (step.pumps === PUMPS.P2 || step.pumps === PUMPS.BOTH);

  writeTag(db, 'REC.NAME', seq.recipe ? seq.recipe.name : '');
  writeTag(db, 'REC.STATE', seq.state);
  writeTag(db, 'REC.STEP', running || seq.done ? seq.step : 0);
  writeTag(db, 'REC.STEPS', steps);
  writeTag(db, 'REC.STEP_NAME', running || seq.done ? step.name : '');
  writeTag(db, 'REC.RUNNING', running);
  writeTag(db, 'REC.DONE', seq.done === true);
  writeTag(db, 'REC.FAULT', seq.fault === true);
  writeTag(db, 'REC.NOTE', seq.note);
  writeTag(db, 'REC.SP', running ? seq.sp : 0);
  writeTag(db, 'REC.SP_TARGET', running ? seq.spTo : 0);
  writeTag(db, 'REC.RAMPING', running && step.ramp_s > 0 && seq.elapsed_s < step.ramp_s);
  writeTag(db, 'REC.LOOP', running ? step.loop : '');
  writeTag(db, 'REC.PUMPS', running ? step.pumps : '');
  writeTag(db, 'REC.WANT_P1', wantP1);
  writeTag(db, 'REC.WANT_P2', wantP2);
  writeTag(db, 'REC.WANT_LEAD', running && step.pumps === PUMPS.LEAD);
  writeTag(db, 'REC.SEQ_AUTO', running && step.pumps === PUMPS.AUTO);
  writeTag(db, 'REC.BAND', running ? step.holdBand : 0);
  writeTag(db, 'REC.IN_BAND', seq.inBand === true);
  writeTag(db, 'REC.MINUTES', running ? step.minutes : 0);
  writeTag(db, 'REC.ELAPSED', running ? seq.elapsed_s : 0);
  writeTag(db, 'REC.REMAIN', running ? Math.max(0, step.minutes * 60 - seq.elapsed_s) : 0);
  writeTag(db, 'REC.BATCH_S', seq.batch_s);
  writeTag(db, 'REC.PROGRESS', progressOf(seq));
  writeTag(db, 'REC.VOLUME', running ? seq.volume_m3 : 0);
  writeTag(db, 'REC.DWELL', running ? seq.dwell_s : 0);
  writeTag(db, 'REC.TIME_DN', running && seq.timeDone);
  writeTag(db, 'REC.COND_DN', running && seq.condDone);
  writeTag(db, 'REC.STEP_DN', running && seq.stepDone);
  writeTag(db, 'REC.FIRST_STEP', running && seq.step === 1);
  writeTag(db, 'REC.LAST_STEP', running && steps > 0 && seq.step === steps);
}

/**
 * How far through the whole recipe the batch is, by step time.
 * @param {object} seq the sequencer
 * @returns {number} 0 to 1
 */
function progressOf(seq) {
  if (!seq.recipe || seq.recipe.steps.length === 0) return 0;
  if (seq.done) return 1;
  if (!seq.running) return 0;
  const step = stepAt(seq, seq.step);
  const within = step.minutes > 0 ? clamp(seq.elapsed_s / (step.minutes * 60), 0, 1) : 0;
  return clamp((seq.step - 1 + within) / seq.recipe.steps.length, 0, 1);
}

/**
 * A sentence saying what the current step is waiting for.
 * @param {object} seq the sequencer
 * @returns {string} the sentence, or '' when nothing is running
 */
export function nextWhenText(seq) {
  if (!isRecord(seq) || !seq.running || !seq.recipe) return '';
  const step = stepAt(seq, seq.step);
  const spec = NEXT_SPECS[step.next.on];
  if (!spec) return 'waiting on a condition this sequencer does not recognise';
  const eu = LOOP_EU[step.loop] || { unit: '', dp: 2, pv: 'PV' };
  /**
   * A threshold at the decimal places its own instrument is read to.
   * @param {number} v the number
   * @returns {string} the text
   */
  const dp = (v) => v.toFixed(spec.unit === 'EU' ? eu.dp : 2);
  const dwell = step.next.after_s > 0 ? `, held for ${step.next.after_s} s` : '';
  switch (spec.id) {
    case NEXT.TIME:
      return `after ${step.minutes} min${step.minutes === 1 ? '' : 's'}`;
    case NEXT.OPERATOR:
      return 'when an operator advances it';
    case NEXT.IN_BAND:
      return `when ${eu.pv} sits within ${dp(step.holdBand)} ${eu.unit} of `
        + `${dp(step.sp)} ${eu.unit}${dwell}`;
    case NEXT.VOLUME:
      return `when ${step.next.value} m3 have been delivered this step${dwell}`;
    default:
      return `when ${spec.label} passes ${dp(step.next.value)} ${spec.unit === 'EU' ? eu.unit : spec.unit}${dwell}`;
  }
}

/**
 * Everything a panel needs to draw the batch header, in one call.
 * @param {object} seq the sequencer
 * @returns {object} `{running, held, done, state, recipe, step, steps, stepName, elapsed_s,
 *   remaining_s, batch_s, progress, nextWhen, sp, loop, pumps, note, stepDone}`
 */
export function sequencerView(seq) {
  if (!isRecord(seq)) {
    return {
      running: false, held: false, done: false, state: SEQ_STATE.IDLE, recipe: '', step: 0,
      steps: 0, stepName: '', elapsed_s: 0, remaining_s: 0, batch_s: 0, progress: 0,
      nextWhen: '', sp: 0, loop: '', pumps: '', note: '', stepDone: false,
    };
  }
  const step = seq.recipe ? stepAt(seq, seq.step) : createStep(1, { name: '', minutes: 0 });
  return {
    running: seq.running === true,
    held: seq.held === true,
    done: seq.done === true,
    state: seq.state,
    recipe: seq.recipe ? seq.recipe.name : '',
    step: seq.running || seq.done ? seq.step : 0,
    steps: seq.recipe ? seq.recipe.steps.length : 0,
    stepName: seq.running || seq.done ? step.name : '',
    elapsed_s: seq.elapsed_s,
    remaining_s: seq.running ? Math.max(0, step.minutes * 60 - seq.elapsed_s) : 0,
    batch_s: seq.batch_s,
    progress: progressOf(seq),
    nextWhen: nextWhenText(seq),
    sp: seq.running ? seq.sp : 0,
    loop: seq.running ? step.loop : '',
    pumps: seq.running ? step.pumps : '',
    note: seq.note,
    stepDone: seq.stepDone === true,
  };
}

/**
 * One line per step, in plain English — what the grid shows in its summary column and what the
 * batch record prints.
 * @param {object} recipe the recipe
 * @returns {string[]} one sentence per step
 */
export function describeRecipe(recipe) {
  const r = cloneRecipe(recipe);
  return r.steps.map((s) => {
    const eu = LOOP_EU[s.loop] || { unit: '', dp: 2 };
    const spec = NEXT_SPECS[s.next.on];
    const ramp = s.ramp_s > 0 ? ` over a ${s.ramp_s} s ramp` : '';
    const pumps = {
      [PUMPS.AUTO]: 'staging in charge of the machines',
      [PUMPS.LEAD]: 'the lead machine only',
      [PUMPS.BOTH]: 'both machines',
      [PUMPS.P1]: 'P-101 only',
      [PUMPS.P2]: 'P-102 only',
      [PUMPS.NONE]: 'nothing turning',
    }[s.pumps] || s.pumps;
    const when = spec && spec.id === NEXT.TIME
      ? `for ${s.minutes} min`
      : `until ${spec ? spec.label : s.next.on}`
        + (spec && spec.needsValue ? ` reaches ${s.next.value}` : '')
        + (s.next.after_s > 0 ? ` for ${s.next.after_s} s` : '')
        + `, or ${s.minutes} min at the outside`;
    return `${s.n}. ${s.name}: hold ${s.loop.toLowerCase()} at ${s.sp.toFixed(eu.dp)} ${eu.unit}`
      + `${ramp} with ${pumps}, ${when}.`;
  });
}
