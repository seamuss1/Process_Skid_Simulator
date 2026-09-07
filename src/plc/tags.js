/**
 * src/plc/tags.js — the tag database: every name the ladder program is allowed to say, what type
 * it is, what it is currently worth, and whether an engineer has forced it.
 *
 * Layer L3 (`src/plc`): imports `core/util.js` and nothing else. No DOM, no `window`, no
 * `Date.now()`, no `Math.random()` — the whole module is unit-tested under `node --test`, and
 * anything time-dependent arrives as an argument to the caller, never to this file.
 *
 * ------------------------------------------------------------------------------------------
 * WHY A TAG DATABASE AND NOT A PLAIN OBJECT
 *
 * A ladder program is only readable because its operands mean something before you find where
 * they are written. `M.LEAD_IS_P1` tells you it is a bit, that it lives in memory rather than on
 * a terminal, and that nothing outside the program can move it. A bare `{ leadIsP1: true }` tells
 * you none of that, and the moment two modules disagree about whether a value is a percent or a
 * fraction the program starts lying quietly. So four rules are enforced here rather than trusted:
 *
 *   1. THE PREFIX MUST MATCH THE SCOPE. `I.` is wired to a terminal, `Q.` drives one, `M.` is
 *      internal, `T.`/`C.` are timers and counters, `R.` is recipe data, `S.` belongs to the
 *      processor. A tag whose name lies about where it lives is how a program becomes
 *      unreadable, and it is the first thing that happens when nobody checks.
 *   2. TYPES ARE CHECKED ON WRITE. A REAL landing in a BOOL is not "truthy", it is a defect: a
 *      rung that reads a bit worth 0.5 no longer means what it says on the screen.
 *   3. RANGES CLAMP ON WRITE. The setpoint tag cannot be handed 900 bar by a rung with a bad
 *      divide, because the clamp is on the tag, not on the forty places that write it.
 *   4. FORCES ARE HONOURED ON EVERY READ. See below.
 *
 * FORCING. On a real processor a force overrides what every reader sees while leaving the
 * program's own writes going into the underlying value, so that the instant you remove the force
 * the plant jumps to whatever the logic has been computing all along. That surprise is the whole
 * lesson, so it is reproduced exactly: {@link writeTag} always updates the stored value,
 * {@link readTag} always returns the force, and {@link forcedTags} exists so the UI can shout
 * about it. Forcing an input is how you test a rung without breaking a pump, and forgetting a
 * force is how commissioning engineers lose an afternoon.
 *
 * SUB-ELEMENTS. Timers and counters are structures, and ladder addresses their bits directly:
 * `T.STAGE_DLY.DN`, `C.P1_STARTS.ACC`. {@link readTag}, {@link writeTag}, {@link forceTag},
 * {@link tagExists} and {@link tagInfo} all accept that dotted member form, so an instruction
 * never has to special-case a structure operand, and a single timer bit can be forced on its own.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/** Data types a tag may take. */
export const TYPE = Object.freeze({
  /** A single bit. */
  BOOL: 'BOOL',
  /** A whole number. Fractional writes truncate, as a MOV into an integer file does. */
  INT: 'INT',
  /** A floating-point engineering value. */
  REAL: 'REAL',
  /** An on-delay/off-delay/retentive timer structure: `{pre, acc, en, tt, dn}`. */
  TIMER: 'TIMER',
  /** An up/down counter structure: `{pre, acc, cu, cd, dn, ov, un}`. */
  COUNTER: 'COUNTER',
  /** Text, for step names and annunciator messages. */
  STRING: 'STRING',
});

/** Where a tag lives, which is also what is allowed to write it. */
export const SCOPE = Object.freeze({
  /** Written by the input scan from the plant, read by the program. */
  INPUT: 'INPUT',
  /** Written by the program, read by the output scan and applied to the plant. */
  OUTPUT: 'OUTPUT',
  /** Internal to the program: latches, flags, working numbers. */
  MEMORY: 'MEMORY',
  /** Timer structures. */
  TIMER: 'TIMER',
  /** Counter structures. */
  COUNTER: 'COUNTER',
  /** Recipe data and the sequencer's published step state. */
  RECIPE: 'RECIPE',
  /** The processor's own status: scan time, first scan, free-running bits. */
  SYSTEM: 'SYSTEM',
});

/** The one prefix each scope must be named with. */
export const SCOPE_PREFIX = Object.freeze({
  [SCOPE.INPUT]: 'I',
  [SCOPE.OUTPUT]: 'Q',
  [SCOPE.MEMORY]: 'M',
  [SCOPE.TIMER]: 'T',
  [SCOPE.COUNTER]: 'C',
  [SCOPE.RECIPE]: 'R',
  [SCOPE.SYSTEM]: 'S',
});

/**
 * Prefix to scope, including the one alias in the system.
 *
 * `REC` is accepted for the recipe scope because the sequencer publishes its step state as
 * `REC.STEP`, `REC.HOLD` and friends, and those names are already written into the stock ladder
 * programs and into the lessons. One documented alias is cheaper than a rename that would make
 * every screenshot of the recipe walker wrong; a second alias would not be, so there is not one.
 */
const PREFIX_SCOPE = Object.freeze({
  I: SCOPE.INPUT,
  Q: SCOPE.OUTPUT,
  M: SCOPE.MEMORY,
  T: SCOPE.TIMER,
  C: SCOPE.COUNTER,
  R: SCOPE.RECIPE,
  REC: SCOPE.RECIPE,
  S: SCOPE.SYSTEM,
});

/** Snapshot format version, so a stored snapshot from an older build can be recognised. */
export const TAGDB_VERSION = 1;

/** Longest string a STRING tag holds. Longer writes truncate rather than being refused. */
export const STRING_LEN = 128;

/** `PREFIX.NAME`, upper case, digits and underscores allowed after the first letter. */
const NAME_RE = /^([A-Z][A-Z0-9]*)\.([A-Z][A-Z0-9_]*)$/;

/** The addressable members of a timer structure, and the type each one presents as. */
const TIMER_MEMBERS = Object.freeze({
  PRE: Object.freeze({ key: 'pre', type: TYPE.INT, unit: 'ms', min: 0, desc: 'preset, ms' }),
  ACC: Object.freeze({ key: 'acc', type: TYPE.INT, unit: 'ms', min: 0, desc: 'accumulated, ms' }),
  EN: Object.freeze({ key: 'en', type: TYPE.BOOL, unit: '', desc: 'enabled — the rung is true' }),
  TT: Object.freeze({ key: 'tt', type: TYPE.BOOL, unit: '', desc: 'timing — accumulating now' }),
  DN: Object.freeze({ key: 'dn', type: TYPE.BOOL, unit: '', desc: 'done — the preset was reached' }),
});

/** The addressable members of a counter structure. */
const COUNTER_MEMBERS = Object.freeze({
  PRE: Object.freeze({ key: 'pre', type: TYPE.INT, unit: '', desc: 'preset count' }),
  ACC: Object.freeze({ key: 'acc', type: TYPE.INT, unit: '', desc: 'accumulated count' }),
  CU: Object.freeze({ key: 'cu', type: TYPE.BOOL, unit: '', desc: 'count-up rung state' }),
  CD: Object.freeze({ key: 'cd', type: TYPE.BOOL, unit: '', desc: 'count-down rung state' }),
  DN: Object.freeze({ key: 'dn', type: TYPE.BOOL, unit: '', desc: 'done — accumulated reached preset' }),
  OV: Object.freeze({ key: 'ov', type: TYPE.BOOL, unit: '', desc: 'overflow' }),
  UN: Object.freeze({ key: 'un', type: TYPE.BOOL, unit: '', desc: 'underflow' }),
});

/**
 * The processor's own tags.
 *
 * They are declared here rather than in the IO map because they describe the PLC, not the plant,
 * and because every stock program needs `S.ALWAYS_ON` before it can hold a single unconditional
 * coil. {@link installSystemTags} defines them and sets the two constants.
 */
export const SYSTEM_TAGS = Object.freeze([
  Object.freeze({ name: 'S.ALWAYS_ON', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'always true — an unconditional rung' }),
  Object.freeze({ name: 'S.ALWAYS_OFF', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'always false — a disabled rung' }),
  Object.freeze({ name: 'S.FIRST_SCAN', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'true for the first scan after the processor goes to RUN' }),
  Object.freeze({ name: 'S.PULSE_1S', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'free-running 1 s square wave, for flashing lamps' }),
  Object.freeze({ name: 'S.PULSE_5S', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'free-running 5 s square wave' }),
  Object.freeze({ name: 'S.SCAN_MS', type: TYPE.REAL, scope: SCOPE.SYSTEM, unit: 'ms', min: 0, desc: 'last scan time' }),
  Object.freeze({ name: 'S.SCAN_MAX_MS', type: TYPE.REAL, scope: SCOPE.SYSTEM, unit: 'ms', min: 0, desc: 'longest scan since the last mode change' }),
  Object.freeze({ name: 'S.SCAN_COUNT', type: TYPE.INT, scope: SCOPE.SYSTEM, min: 0, desc: 'scans executed since the processor went to RUN' }),
  Object.freeze({ name: 'S.PLC_RUN', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'the processor is scanning the program' }),
  Object.freeze({ name: 'S.PLC_FAULT', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'the processor has faulted and stopped scanning' }),
  Object.freeze({ name: 'S.FORCES_ACTIVE', type: TYPE.BOOL, scope: SCOPE.SYSTEM, desc: 'at least one tag is forced — the program is not telling the truth' }),
  Object.freeze({ name: 'S.TIME_S', type: TYPE.REAL, scope: SCOPE.SYSTEM, unit: 's', min: 0, desc: 'simulated plant clock' }),
]);

/**
 * A fresh timer structure. Presets are in milliseconds throughout the PLC layer.
 * @returns {{pre:number, acc:number, en:boolean, tt:boolean, dn:boolean}} the structure
 */
function newTimer() {
  return { pre: 0, acc: 0, en: false, tt: false, dn: false };
}

/**
 * A fresh counter structure.
 * @returns {{pre:number, acc:number, cu:boolean, cd:boolean, dn:boolean, ov:boolean, un:boolean}}
 *   the structure
 */
function newCounter() {
  return { pre: 0, acc: 0, cu: false, cd: false, dn: false, ov: false, un: false };
}

/**
 * A tag's lower bound, spelled out because `clamp` handed an undefined bound returns undefined
 * and a tag that quietly initialises to undefined poisons every comparison downstream of it.
 * @param {object} ranged anything carrying an optional `min`
 * @returns {number} the bound, or -Infinity when there is none
 */
function lowOf(ranged) {
  return ranged.min === undefined ? -Infinity : ranged.min;
}

/**
 * A tag's upper bound.
 * @param {object} ranged anything carrying an optional `max`
 * @returns {number} the bound, or Infinity when there is none
 */
function highOf(ranged) {
  return ranged.max === undefined ? Infinity : ranged.max;
}

/**
 * The value a tag holds before anything has written to it.
 * @param {object} tag the tag record
 * @returns {*} the default value for its type, respecting a lower range limit
 */
function defaultValue(tag) {
  switch (tag.type) {
    case TYPE.BOOL: return false;
    case TYPE.STRING: return '';
    case TYPE.TIMER: return newTimer();
    case TYPE.COUNTER: return newCounter();
    default: return clamp(0, lowOf(tag), highOf(tag));
  }
}

/**
 * Create an empty tag database.
 *
 * The tag map is a `Map` so definition order survives: the tag browser and the cross-reference
 * both list tags in the order the IO map declared them, which is the order the terminals are
 * numbered in, and an alphabetical shuffle would lose that.
 *
 * @returns {object} the database
 */
export function createTagDb() {
  return {
    /** name -> tag record. Definition order is preserved and is the display order. */
    tags: new Map(),
    /** reference (tag or `TAG.MEMBER`) -> forced value. */
    forces: new Map(),
    /**
     * Bumped whenever the SHAPE changes — a definition, a force, a restore — and deliberately
     * not on an ordinary write. A UI that redrew on every write would redraw a thousand times a
     * second and learn nothing; a UI that redraws when this changes has just been told that the
     * list it is showing is out of date.
     */
    rev: 0,
  };
}

/**
 * Split a reference into its tag and optional member.
 * @param {string} ref a tag name, optionally with a `.MEMBER` suffix
 * @returns {{name:string, member:string|null}|null} the parts, or null if it is not a reference
 */
function splitRef(ref) {
  if (typeof ref !== 'string') return null;
  const parts = ref.split('.');
  if (parts.length === 2) return { name: ref, member: null };
  if (parts.length === 3) return { name: `${parts[0]}.${parts[1]}`, member: parts[2] };
  return null;
}

/**
 * The member table for a structure type.
 * @param {string} type one of {@link TYPE}
 * @returns {object|null} the member table, or null for a scalar type
 */
function membersOf(type) {
  if (type === TYPE.TIMER) return TIMER_MEMBERS;
  if (type === TYPE.COUNTER) return COUNTER_MEMBERS;
  return null;
}

/**
 * Resolve a reference to the tag record and, when one is addressed, the member spec.
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @returns {{ok:true, tag:object, member:object|null, ref:string}|{ok:false, reason:string}}
 *   the resolution or a refusal an operator could read
 */
function resolve(db, ref) {
  const parts = splitRef(ref);
  if (!parts) return { ok: false, reason: `'${ref}' is not a tag reference` };
  const tag = db.tags.get(parts.name);
  if (!tag) return { ok: false, reason: `there is no tag called ${parts.name}` };
  if (!parts.member) return { ok: true, tag, member: null, ref };
  const table = membersOf(tag.type);
  if (!table) {
    return { ok: false, reason: `${tag.name} is a ${tag.type} and has no .${parts.member} member` };
  }
  const member = table[parts.member];
  if (!member) {
    return {
      ok: false,
      reason: `${tag.name} has no member .${parts.member} — try ${Object.keys(table).join(', ')}`,
    };
  }
  return { ok: true, tag, member, ref };
}

/**
 * Coerce and check a value against a type, applying the tag's range.
 *
 * BOOL accepts a boolean, and also exactly 0 or 1 because bit arithmetic in the maths
 * instructions legitimately produces those. It refuses everything else, 0.5 and 3.7 included: a
 * bit that quietly accepts a REAL is a rung that no longer means what it says on the screen, and
 * that is a worse failure than a refused write, which at least says so.
 *
 * @param {object} ranged whatever carries the range: the tag record, or the member spec when a
 *   member is addressed — a timer preset clamps at zero whatever the parent tag's range says
 * @param {*} value the incoming value
 * @param {string} what the reference being written, for the refusal message
 * @returns {{ok:true, value:*, clamped:boolean}|{ok:false, reason:string}} the coerced value or a
 *   refusal
 */
function coerce(ranged, type, value, what) {
  switch (type) {
    case TYPE.BOOL: {
      if (typeof value === 'boolean') return { ok: true, value, clamped: false };
      if (value === 0 || value === 1) return { ok: true, value: value === 1, clamped: false };
      return { ok: false, reason: `${what} is a bit — write true or false, not ${describe(value)}` };
    }
    case TYPE.INT:
    case TYPE.REAL: {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: `${what} is a ${type} — write a finite number, not ${describe(value)}` };
      }
      const held = clamp(value, lowOf(ranged), highOf(ranged));
      const out = type === TYPE.INT ? Math.trunc(held) : held;
      return { ok: true, value: out, clamped: held !== value };
    }
    case TYPE.STRING: {
      if (typeof value !== 'string') {
        return { ok: false, reason: `${what} is text — write a string, not ${describe(value)}` };
      }
      return value.length > STRING_LEN
        ? { ok: true, value: value.slice(0, STRING_LEN), clamped: true }
        : { ok: true, value, clamped: false };
    }
    default:
      return {
        ok: false,
        reason: `${what} is a ${type} structure — write its members, such as ${what}.PRE`,
      };
  }
}

/**
 * Name a value in a refusal message without dumping an object into it.
 * @param {*} v the offending value
 * @returns {string} a short description
 */
function describe(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return `the number ${v}`;
  if (typeof v === 'string') return `the text '${v.length > 20 ? `${v.slice(0, 20)}...` : v}'`;
  if (typeof v === 'object') return 'an object';
  return `a ${typeof v}`;
}

/**
 * Define a tag.
 *
 * Defining the same tag twice with the same shape succeeds and leaves the value alone, because
 * the IO map is installed again on every program load and an install that refused the second time
 * would make loading a program a one-shot operation. A definition that CONFLICTS with an existing
 * one is refused, because two modules disagreeing about a tag's type is exactly the fault this
 * database exists to catch.
 *
 * @param {object} db the database
 * @param {object} spec the definition
 * @param {string} spec.name symbolic name, `PREFIX.NAME`, matching the scope's prefix
 * @param {string} spec.type one of {@link TYPE}
 * @param {string} spec.scope one of {@link SCOPE}
 * @param {string} [spec.desc] what the tag means, shown in the tag browser and the cross-reference
 * @param {string} [spec.unit] engineering unit, for display
 * @param {number} [spec.min] lower range limit; writes clamp to it
 * @param {number} [spec.max] upper range limit; writes clamp to it
 * @param {boolean} [spec.retain=false] survives {@link clearNonRetained}, as a retentive file does
 * @returns {{ok:boolean, reason?:string}} ok, or a refusal an operator could read
 */
export function defineTag(db, spec) {
  if (!db || !(db.tags instanceof Map)) return { ok: false, reason: 'no tag database was given' };
  if (!spec || typeof spec !== 'object') return { ok: false, reason: 'a tag definition is required' };

  const { name, type, scope } = spec;
  const m = typeof name === 'string' ? NAME_RE.exec(name) : null;
  if (!m) {
    return {
      ok: false,
      reason: `'${name}' is not a legal tag name — use an upper-case SCOPE.NAME, such as I.PT101`,
    };
  }
  if (!TYPE[type]) return { ok: false, reason: `${name}: '${type}' is not a tag type` };
  if (!SCOPE[scope]) return { ok: false, reason: `${name}: '${scope}' is not a tag scope` };

  const prefix = m[1];
  if (PREFIX_SCOPE[prefix] !== scope) {
    const want = SCOPE_PREFIX[scope];
    return {
      ok: false,
      reason: `${name} is scoped ${scope} but named '${prefix}.' — a ${scope} tag must be `
        + `named '${want}.${m[2]}', or the name lies about where the value lives`,
    };
  }
  if (type === TYPE.TIMER && scope !== SCOPE.TIMER) {
    return { ok: false, reason: `${name} is a timer, so it belongs in the TIMER scope as T.${m[2]}` };
  }
  if (type === TYPE.COUNTER && scope !== SCOPE.COUNTER) {
    return { ok: false, reason: `${name} is a counter, so it belongs in the COUNTER scope as C.${m[2]}` };
  }
  const ranged = type === TYPE.INT || type === TYPE.REAL;
  if (!ranged && (spec.min !== undefined || spec.max !== undefined)) {
    return { ok: false, reason: `${name} is a ${type}, so a min/max range means nothing on it` };
  }
  if (ranged && spec.min !== undefined && spec.max !== undefined && !(spec.max >= spec.min)) {
    return { ok: false, reason: `${name}: the range ${spec.min}..${spec.max} is inside out` };
  }

  const existing = db.tags.get(name);
  if (existing) {
    const same = existing.type === type && existing.scope === scope
      && existing.min === spec.min && existing.max === spec.max;
    if (same) return { ok: true };
    return {
      ok: false,
      reason: `${name} is already defined as a ${existing.scope} ${existing.type} and the new `
        + `definition disagrees — two modules cannot own one tag`,
    };
  }

  const tag = {
    name,
    type,
    scope,
    desc: typeof spec.desc === 'string' ? spec.desc : '',
    unit: typeof spec.unit === 'string' ? spec.unit : '',
    min: spec.min,
    max: spec.max,
    retain: spec.retain === true,
    value: undefined,
  };
  tag.value = defaultValue(tag);
  db.tags.set(name, tag);
  db.rev += 1;
  return { ok: true };
}

/**
 * Define a list of tags, collecting the refusals instead of stopping at the first one — an IO map
 * with one bad point should still install the other thirty-nine and tell you which one failed.
 * @param {object} db the database
 * @param {object[]} specs definitions, as {@link defineTag} takes
 * @returns {{ok:boolean, defined:number, problems:string[]}} what happened
 */
export function defineTags(db, specs) {
  if (!Array.isArray(specs)) return { ok: false, defined: 0, problems: ['a list of tags is required'] };
  const problems = [];
  let defined = 0;
  for (const spec of specs) {
    const r = defineTag(db, spec);
    if (r.ok) defined += 1; else problems.push(r.reason);
  }
  return { ok: problems.length === 0, defined, problems };
}

/**
 * Define the processor's own tags and set the two that never change.
 * @param {object} db the database
 * @returns {{ok:boolean, defined:number, problems:string[]}} what happened
 */
export function installSystemTags(db) {
  const r = defineTags(db, SYSTEM_TAGS);
  rawWrite(db, 'S.ALWAYS_ON', true);
  rawWrite(db, 'S.ALWAYS_OFF', false);
  return r;
}

/**
 * Whether a reference names something that exists — including a structure member, so the
 * cross-reference can resolve `T.STAGE_DLY.DN` without knowing what a timer is.
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @returns {boolean} true if it resolves
 */
export function tagExists(db, ref) {
  if (!db || !(db.tags instanceof Map)) return false;
  return resolve(db, ref).ok;
}

/**
 * Everything the UI needs to render one tag, as a copy — the live record is not handed out, so a
 * panel cannot accidentally retype a tag by assigning to what it was shown.
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @returns {object|null} the description, or null when the reference does not resolve
 */
export function tagInfo(db, ref) {
  if (!db || !(db.tags instanceof Map)) return null;
  const r = resolve(db, ref);
  if (!r.ok) return null;
  const { tag, member } = r;
  const forced = db.forces.has(ref);
  return {
    name: ref,
    base: tag.name,
    member: member ? ref.split('.')[2] : null,
    type: member ? member.type : tag.type,
    scope: tag.scope,
    desc: member ? `${tag.desc || tag.name} — ${member.desc}` : tag.desc,
    unit: member ? member.unit : tag.unit,
    min: member ? member.min : tag.min,
    max: member ? member.max : tag.max,
    retain: tag.retain,
    forced,
    forcedValue: forced ? db.forces.get(ref) : undefined,
    value: readTag(db, ref),
  };
}

/**
 * List tag names.
 *
 * The filter is deliberately forgiving because it is typed into a search box: a {@link SCOPE}
 * name or a bare prefix selects a scope, a function is used as a predicate on the tag record, an
 * object matches every field it lists, and anything else is treated as a case-insensitive
 * substring of the name.
 *
 * @param {object} db the database
 * @param {string|Function|object} [filter] what to keep
 * @returns {string[]} matching names, in definition order
 */
export function tagNames(db, filter) {
  if (!db || !(db.tags instanceof Map)) return [];
  const all = [...db.tags.values()];
  if (filter === undefined || filter === null || filter === '') return all.map((t) => t.name);

  if (typeof filter === 'function') return all.filter((t) => filter(t)).map((t) => t.name);

  if (typeof filter === 'string') {
    const up = filter.toUpperCase();
    if (SCOPE[up]) return all.filter((t) => t.scope === up).map((t) => t.name);
    if (PREFIX_SCOPE[up]) {
      const scope = PREFIX_SCOPE[up];
      return all.filter((t) => t.scope === scope).map((t) => t.name);
    }
    return all.filter((t) => t.name.includes(up) || t.desc.toUpperCase().includes(up))
      .map((t) => t.name);
  }

  if (typeof filter === 'object') {
    return all.filter((t) => (filter.scope === undefined || t.scope === filter.scope)
      && (filter.type === undefined || t.type === filter.type)
      && (filter.retain === undefined || t.retain === filter.retain)
      && (filter.forced === undefined || db.forces.has(t.name) === filter.forced))
      .map((t) => t.name);
  }
  return [];
}

/**
 * Read the member of a structure.
 * @param {object} tag the tag record
 * @param {object} member the member spec
 * @returns {*} the member's value
 */
function readMember(tag, member) {
  return tag.value[member.key];
}

/**
 * Read a tag, honouring a force.
 *
 * This is what every instruction uses, which is what makes a force mean anything: there is no
 * second path that sees around it except {@link rawRead}, and only the IO scan uses that.
 *
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @returns {*} the value, or undefined when the reference does not resolve
 */
export function readTag(db, ref) {
  if (!db || !(db.tags instanceof Map)) return undefined;
  if (db.forces.has(ref)) return db.forces.get(ref);
  const r = resolve(db, ref);
  if (!r.ok) return undefined;
  return r.member ? readMember(r.tag, r.member) : r.tag.value;
}

/**
 * Read a tag ignoring any force — the underlying value the program is actually computing.
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @returns {*} the stored value, or undefined when the reference does not resolve
 */
export function rawRead(db, ref) {
  if (!db || !(db.tags instanceof Map)) return undefined;
  const r = resolve(db, ref);
  if (!r.ok) return undefined;
  return r.member ? readMember(r.tag, r.member) : r.tag.value;
}

/**
 * Store a checked value, with no force logic of any kind.
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @param {*} value the value to write
 * @returns {{ok:boolean, reason?:string, value?:*, clamped?:boolean}} the outcome
 */
function store(db, ref, value) {
  if (!db || !(db.tags instanceof Map)) return { ok: false, reason: 'no tag database was given' };
  const r = resolve(db, ref);
  if (!r.ok) return r;
  const holder = r.member || r.tag;
  const c = coerce(holder, holder.type, value, ref);
  if (!c.ok) return c;
  if (r.member) r.tag.value[r.member.key] = c.value;
  else r.tag.value = c.value;
  return { ok: true, value: c.value, clamped: c.clamped };
}

/**
 * Write a tag from the program.
 *
 * A forced tag still takes the write. The force only changes what readers see, so removing it
 * hands the plant straight to whatever the logic has been computing behind it — which is exactly
 * how a real processor behaves and exactly the surprise an engineer needs to have had once.
 *
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @param {*} value the value to write; type-checked, and clamped to the tag's range
 * @returns {{ok:boolean, reason?:string, value?:*, clamped?:boolean}} ok with the value actually
 *   stored, or a refusal an operator could read
 */
export function writeTag(db, ref, value) {
  return store(db, ref, value);
}

/**
 * Write a tag bypassing forces — but not bypassing the type check, because a scan that can put
 * rubbish in the input image only moves the failure somewhere harder to see.
 *
 * `rawWrite` and `writeTag` do the same thing to the stored value; they are separate names
 * because the IO scan writing the input image is a different act from a rung writing a coil, and
 * a reader of `iomap.js` should be able to tell which is happening.
 *
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @param {*} value the value to write
 * @returns {{ok:boolean, reason?:string, value?:*, clamped?:boolean}} the outcome
 */
export function rawWrite(db, ref, value) {
  return store(db, ref, value);
}

/**
 * Force a tag to a value.
 *
 * The force is checked exactly as a write is, so a force cannot smuggle a REAL into a bit. A
 * whole timer or counter cannot be forced — force the member you actually mean, `T.STAGE_DLY.DN`,
 * which is what an engineer does anyway when they want to prove out a rung without waiting.
 *
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @param {*} value the value every reader will see until the force is removed
 * @returns {{ok:boolean, reason?:string, value?:*}} ok with the forced value, or a refusal
 */
export function forceTag(db, ref, value) {
  if (!db || !(db.tags instanceof Map)) return { ok: false, reason: 'no tag database was given' };
  const r = resolve(db, ref);
  if (!r.ok) return r;
  if (!r.member && membersOf(r.tag.type)) {
    return {
      ok: false,
      reason: `${r.tag.name} is a ${r.tag.type} structure — force the bit you mean, `
        + `such as ${r.tag.name}.DN`,
    };
  }
  const holder = r.member || r.tag;
  const c = coerce(holder, holder.type, value, ref);
  if (!c.ok) return c;
  db.forces.set(ref, c.value);
  db.rev += 1;
  return { ok: true, value: c.value };
}

/**
 * Remove a force. The tag immediately reads as whatever the program has been writing to it.
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @returns {{ok:boolean, reason?:string}} ok, or a refusal if it was not forced
 */
export function unforceTag(db, ref) {
  if (!db || !(db.tags instanceof Map)) return { ok: false, reason: 'no tag database was given' };
  if (!db.forces.has(ref)) return { ok: false, reason: `${ref} is not forced` };
  db.forces.delete(ref);
  db.rev += 1;
  return { ok: true };
}

/**
 * Every forced reference, so the UI can shout about it. A forgotten force is the most expensive
 * thing in this whole module, so it must never be possible to have one and not see it.
 * @param {object} db the database
 * @returns {string[]} the forced references, in the order they were forced
 */
export function forcedTags(db) {
  if (!db || !(db.forces instanceof Map)) return [];
  return [...db.forces.keys()];
}

/**
 * Whether a specific reference is forced — the cheap check a renderer makes per element.
 * @param {object} db the database
 * @param {string} ref a tag name or `TAG.MEMBER`
 * @returns {boolean} true when a force is in place
 */
export function isForced(db, ref) {
  if (!db || !(db.forces instanceof Map)) return false;
  return db.forces.has(ref);
}

/**
 * Remove every force at once, for the "clear all forces" button and for going to PROGRAM mode.
 * @param {object} db the database
 * @returns {number} how many forces were removed
 */
export function clearForces(db) {
  if (!db || !(db.forces instanceof Map)) return 0;
  const n = db.forces.size;
  db.forces.clear();
  if (n > 0) db.rev += 1;
  return n;
}

/**
 * The live timer structure, for the timer instructions to drive.
 *
 * This hands out the real object rather than a copy, because TON has to accumulate into it every
 * scan and copying would be a lie about where the state lives. Anything that only wants to
 * display a timer should go through {@link readTag}, which honours forces on the bits.
 *
 * @param {object} db the database
 * @param {string} name a `T.` tag name
 * @returns {{pre:number, acc:number, en:boolean, tt:boolean, dn:boolean}|null} the structure, or
 *   null when the name is not a timer
 */
export function timerOf(db, name) {
  if (!db || !(db.tags instanceof Map)) return null;
  const tag = db.tags.get(name);
  return tag && tag.type === TYPE.TIMER ? tag.value : null;
}

/**
 * The live counter structure, for the counter instructions to drive.
 * @param {object} db the database
 * @param {string} name a `C.` tag name
 * @returns {{pre:number, acc:number, cu:boolean, cd:boolean, dn:boolean, ov:boolean, un:boolean}|null}
 *   the structure, or null when the name is not a counter
 */
export function counterOf(db, name) {
  if (!db || !(db.tags instanceof Map)) return null;
  const tag = db.tags.get(name);
  return tag && tag.type === TYPE.COUNTER ? tag.value : null;
}

/**
 * Reset every tag that is not marked retentive back to its default.
 *
 * This is a power cycle. Retentive tags — run-hour counters, duty selection, the recipe the plant
 * was last making — survive it, which is the distinction the `retain` flag exists to draw, and
 * which is why a retentive timer keeps its accumulator across a stop.
 *
 * @param {object} db the database
 * @returns {number} how many tags were cleared
 */
export function clearNonRetained(db) {
  if (!db || !(db.tags instanceof Map)) return 0;
  let n = 0;
  for (const tag of db.tags.values()) {
    if (tag.retain) continue;
    tag.value = defaultValue(tag);
    n += 1;
  }
  db.rev += 1;
  return n;
}

/**
 * Take a plain, JSON-safe copy of every value and every force.
 *
 * Structures are deep-copied. Handing out the live timer objects here would produce a "snapshot"
 * that kept changing under the caller, which is the sort of bug that only shows up in the one
 * lesson that restores a state ten minutes later.
 *
 * @param {object} db the database
 * @returns {{v:number, values:object, forces:object}} the snapshot
 */
export function snapshotTags(db) {
  const snap = { v: TAGDB_VERSION, values: {}, forces: {} };
  if (!db || !(db.tags instanceof Map)) return snap;
  for (const tag of db.tags.values()) {
    snap.values[tag.name] = membersOf(tag.type) ? { ...tag.value } : tag.value;
  }
  for (const [ref, value] of db.forces) snap.forces[ref] = value;
  return snap;
}

/**
 * Restore a snapshot.
 *
 * Names that no longer exist, and names that did not exist when the snapshot was taken, are not
 * an error: a snapshot is data from another moment, and refusing the whole restore because one
 * tag has been added since would make snapshots useless the first time the IO map grows. Those
 * names are reported instead, and every tag the snapshot does not mention keeps what it has.
 *
 * @param {object} db the database
 * @param {object} snap a snapshot from {@link snapshotTags}
 * @returns {{ok:boolean, reason?:string, applied:number, skipped:string[]}} what was restored, and
 *   which names could not be
 */
export function restoreTags(db, snap) {
  if (!db || !(db.tags instanceof Map)) {
    return { ok: false, reason: 'no tag database was given', applied: 0, skipped: [] };
  }
  if (!snap || typeof snap !== 'object' || !snap.values || typeof snap.values !== 'object') {
    return { ok: false, reason: 'that is not a tag snapshot', applied: 0, skipped: [] };
  }
  if (snap.v !== TAGDB_VERSION) {
    return {
      ok: false,
      reason: `that snapshot is version ${snap.v} and this processor reads version ${TAGDB_VERSION}`,
      applied: 0,
      skipped: [],
    };
  }

  const skipped = [];
  let applied = 0;
  for (const [name, value] of Object.entries(snap.values)) {
    const tag = db.tags.get(name);
    if (!tag) { skipped.push(name); continue; }
    const table = membersOf(tag.type);
    if (table) {
      if (!value || typeof value !== 'object') { skipped.push(name); continue; }
      let bad = false;
      for (const member of Object.values(table)) {
        const r = coerce(member, member.type, value[member.key], `${name}.${member.key}`);
        if (!r.ok) { bad = true; break; }
        tag.value[member.key] = r.value;
      }
      if (bad) skipped.push(name); else applied += 1;
      continue;
    }
    const r = coerce(tag, tag.type, value, name);
    if (!r.ok) { skipped.push(name); continue; }
    tag.value = r.value;
    applied += 1;
  }

  if (snap.forces && typeof snap.forces === 'object') {
    db.forces.clear();
    for (const [ref, value] of Object.entries(snap.forces)) {
      const r = forceTag(db, ref, value);
      if (!r.ok) skipped.push(ref);
    }
  }

  db.rev += 1;
  return { ok: true, applied, skipped };
}
