/**
 * src/plc/instructions.js — the instruction set: fifty-two mnemonics with IEC 61131-3 / Allen
 * Bradley semantics, the help text that goes next to them in the palette, and the evaluator the
 * scan engine calls once per element per scan.
 *
 * Layer L4: may import `core`, `control` and `process`, and other `plc` modules. It imports none
 * of them except `core/util.js`, and it must never touch the DOM, `window`, `performance`,
 * `Date.now` or `Math.random` — every line here runs under `node --test`. Time arrives as `dt_s`.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS FILE OWNS NO STATE THAT MATTERS
 *
 * Everything an instruction remembers between scans lives in exactly one of two places: the TAG
 * DATABASE (bits, numbers, timer and counter structures — reachable by the operator, forceable,
 * snapshot-able) or a per-ELEMENT-INSTANCE side table keyed by the element object itself.
 *
 * The side table is the whole reason ONS works. A one-shot remembers whether its input was true
 * last scan. Store that on the TAG and two one-shots watching the same bit fight each other: the
 * first one to run each scan consumes the edge and the second never sees it. Every real platform
 * makes you allocate a distinct storage bit per one-shot for this reason; here the element object
 * IS the storage, so the mistake is impossible to make. The table is a WeakMap, so re-parsing a
 * program throws every one-shot, deadband and rolling average away with the old element objects —
 * which is correct: a program you just downloaded has no history.
 *
 * ------------------------------------------------------------------------------------------
 * POWER FLOW IN, POWER FLOW OUT
 *
 * `evaluate(rung, el, io, dt_s)` returns the power flow LEAVING the element. The power flow
 * ARRIVING at it is `io.power`, which the scan engine sets before each call — use
 * {@link evaluateElement}, which does it for you. Two rules follow and both matter:
 *
 *   1. The solver must take the returned value AS the power leaving the element. It must not AND
 *      it with what went in. Every input instruction already ANDs `io.power` itself, so for
 *      contacts the two are identical — but OSF exists precisely to emit a pulse on the scan its
 *      input goes FALSE, and an outer AND would swallow it.
 *   2. Every element on an enabled rung is evaluated every scan, whether power reaches it or not.
 *      That is not an optimisation to remove: a TOF times while its rung is false, an OTE has to
 *      write a zero, and a one-shot has to see the falling edge to arm again. Skipping false
 *      elements is the single most common way a hand-rolled scan engine goes subtly wrong.
 *
 * When `io.power` is undefined the element is treated as powered. That is for the bench and for
 * the editor's "evaluate this one element" probe; the scan engine always sets it.
 *
 * ------------------------------------------------------------------------------------------
 * TIMERS, AND A SCAN THAT IS LONGER THAN THE PRESET
 *
 * Presets and accumulators are in MILLISECONDS, like every platform an operator has met. This
 * simulator runs at up to twenty times real time, so a 100 ms controller scan can be handed two
 * seconds of `dt_s`, and a timer can be asked to cross a preset it should have crossed twenty
 * times over inside one scan.
 *
 * WHAT WE DO: the accumulator takes the whole of `dt_s`, DN sets in the scan the accumulator
 * reaches the preset, and the overshoot is then DISCARDED — the accumulator sits on the preset
 * rather than carrying the remainder forward. It is not carried because carrying it would let a
 * self-resetting timer complete more than once in a scan, and no PLC on earth does that: a scan
 * is atomic, the outputs are written once at the end of it, and a "pulse" that never reached the
 * output image did not happen. The visible consequence is honest and worth teaching: an
 * oscillator built from a TON with a 100 ms preset ticks ONCE PER SCAN, not ten times a second,
 * and at 20x compression that is a tenth of the pulses the programmer expected. Time compression
 * does not compress the scan. If a lesson needs pulses that survive compression, count `dt_s`
 * with TOTAL, not edges with a timer.
 *
 * ------------------------------------------------------------------------------------------
 * ARITHMETIC THAT HAS NO ANSWER
 *
 * DIV and MOD by zero, SQR of a negative, SCL across a zero-width input span: all four are asked
 * for by beginners within the first hour. The house rule is one rule, applied to all of them:
 * LEAVE THE DESTINATION ALONE AND DROP POWER FLOW. Nothing is written, so the last good value
 * survives and no downstream comparison is poisoned by a NaN; and because power stops, the rung
 * can be written to notice — a coil after the DIV goes out, and that is a fault light. A minor
 * fault is also reported through `io.control.fault` when the scan engine offers one.
 *
 * ------------------------------------------------------------------------------------------
 * OPERANDS
 *
 * An element is `{mnemonic, operands: []}`. Each operand is either a TAG NAME, or a literal:
 * a number (`88`, `-1.5`, `2e3`), a quoted string (`'AUTO'`), or `TRUE` / `FALSE`. Destination
 * operands must be tag names; a literal in a destination slot writes nothing and drops power.
 * Reading a name the database does not know yields zero — {@link checkOperands} and
 * `compile.unresolvedTags` are what catch that before the program is ever put in RUN.
 *
 * A timer or counter member may be addressed as `T.STAGE_DLY.DN`. If the database resolves the
 * dotted name itself, that value is used; if it does not, the structure is fetched with
 * `io.timer` / `io.counter` and the member read from it. Either database is therefore fine.
 * ------------------------------------------------------------------------------------------
 */

import { clamp } from '../core/util.js';

/**
 * Element kinds, mirroring the frozen table in `plc/model.js`.
 *
 * Duplicated rather than imported on purpose: `model.validateProgram` needs {@link INSTRUCTIONS}
 * to check operands, so importing the document model back into the instruction set would close a
 * cycle, and the instruction table would stop being loadable on its own for a unit test.
 */
export const ELEMENT_KIND = Object.freeze({
  /** Drawn as a pair of rails: an input instruction. */
  CONTACT: 'CONTACT',
  /** Drawn as a coil at the right-hand rail: an output instruction. */
  COIL: 'COIL',
  /** Drawn as a box with its operands listed inside it. */
  BLOCK: 'BLOCK',
});

/** Palette groups, in the order the editor should show them. */
export const CATEGORY = Object.freeze({
  BIT: 'bit',
  TIMER: 'timer',
  COUNTER: 'counter',
  COMPARE: 'compare',
  MATH: 'math',
  LOGIC: 'logic',
  CONTROL: 'control',
  PROCESS: 'process',
});

/** Human labels for {@link CATEGORY}, for the palette headings. */
export const CATEGORY_LABEL = Object.freeze({
  bit: 'Bit',
  timer: 'Timers',
  counter: 'Counters',
  compare: 'Compare',
  math: 'Math',
  logic: 'Logic',
  control: 'Program control',
  process: 'Process',
});

/**
 * Operand data types, mirroring `plc/tags.js` TYPE so an operand spec can be checked against a
 * tag definition by string equality without this module importing the database.
 */
export const OPERAND_KIND = Object.freeze({
  BOOL: 'BOOL',
  INT: 'INT',
  REAL: 'REAL',
  TIMER: 'TIMER',
  COUNTER: 'COUNTER',
  STRING: 'STRING',
});

/** What an operand slot does, which is how the cross-reference tells a read from a write. */
export const ROLE = Object.freeze({
  /** Read every scan the instruction executes. */
  SOURCE: 'source',
  /** Written by the instruction. Must be a tag name, never a literal. */
  DEST: 'dest',
  /** A timer or counter structure the instruction advances. */
  STRUCT: 'struct',
  /** A JMP/LBL label. Not a tag at all. */
  LABEL: 'label',
});

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

// --------------------------------------------------------------------------------------------
// Per-element instance state
// --------------------------------------------------------------------------------------------

/** @type {WeakMap<object, object>} scan-to-scan memory belonging to one element, not one tag. */
const ELEMENT_STATE = new WeakMap();

/**
 * The side table entry for one element instance, created on first use.
 *
 * An element that is not an object (a malformed document) gets a throwaway record, so evaluation
 * degrades to "no memory" instead of throwing in the middle of a scan.
 *
 * @param {object} el the element
 * @returns {object} its mutable per-instance state
 */
export function elementState(el) {
  if (!el || typeof el !== 'object') return {};
  let st = ELEMENT_STATE.get(el);
  if (!st) { st = {}; ELEMENT_STATE.set(el, st); }
  return st;
}

/**
 * Forget one element's scan-to-scan memory — its one-shot arm bit, its deadband reference, its
 * rolling average window. The editor calls this after an operand is changed, so a half-filled
 * average from the previous tag cannot leak into the new one.
 * @param {object} el the element
 * @returns {void}
 */
export function clearElementState(el) {
  if (el && typeof el === 'object') ELEMENT_STATE.delete(el);
}

// --------------------------------------------------------------------------------------------
// Reading and writing the world
// --------------------------------------------------------------------------------------------

/**
 * The power flow arriving at an element. Undefined means "assume powered", which is what an
 * isolated bench call or the editor's single-element probe wants.
 * @param {object} io the instruction's world
 * @returns {boolean} incoming power flow
 */
function powerIn(io) {
  return !io || io.power === undefined ? true : !!io.power;
}

/**
 * Report a minor fault to the processor, if this scan engine offers a way to.
 * @param {object} io the instruction's world
 * @param {object} el the offending element
 * @param {string} why an operator-readable sentence
 * @returns {boolean} always false, so callers can `return refuse(...)`
 */
function refuse(io, el, why) {
  const fault = io && io.control && io.control.fault;
  if (typeof fault === 'function') {
    try { fault(`${(el && el.mnemonic) || 'instruction'}: ${why}`); } catch { /* optional */ }
  }
  return false;
}

/**
 * Whether a token is a literal rather than a tag name.
 * @param {*} tok the operand token
 * @returns {boolean} true when it is a literal
 */
function isLiteral(tok) {
  if (typeof tok === 'number' || typeof tok === 'boolean') return true;
  if (typeof tok !== 'string') return false;
  const s = tok.trim();
  if (s === '') return true;
  const q = s[0];
  if ((q === '\'' || q === '"') && s.length > 1 && s[s.length - 1] === q) return true;
  return NUMERIC.test(s) || s === 'TRUE' || s === 'FALSE';
}

/**
 * Pull a member out of a timer or counter structure by a dotted suffix.
 * @param {object} io the instruction's world
 * @param {string} name a dotted name such as `T.STAGE_DLY.DN`
 * @returns {*} the member value, or undefined
 */
function dottedMember(io, name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const base = name.slice(0, dot);
  const member = name.slice(dot + 1).toLowerCase();
  const st = structFor(io, base);
  return st && Object.prototype.hasOwnProperty.call(st, member) ? st[member] : undefined;
}

/**
 * Fetch a timer or counter structure by name, whichever the database has.
 * @param {object} io the instruction's world
 * @param {string} name the structure's tag name
 * @returns {object|null} the structure, or null
 */
function structFor(io, name) {
  if (!io) return null;
  if (typeof io.timer === 'function') {
    try { const t = io.timer(name); if (t && typeof t === 'object') return t; } catch { /* wrong type */ }
  }
  if (typeof io.counter === 'function') {
    try { const c = io.counter(name); if (c && typeof c === 'object') return c; } catch { /* wrong type */ }
  }
  return null;
}

/**
 * Resolve one operand token to a value: a literal as itself, anything else as a tag read.
 * @param {object} io the instruction's world
 * @param {*} tok the operand token
 * @returns {*} the value, or undefined when nothing answers to that name
 */
function resolve(io, tok) {
  if (typeof tok === 'number' || typeof tok === 'boolean') return tok;
  if (typeof tok !== 'string') return undefined;
  const s = tok.trim();
  if (s === '') return undefined;
  const q = s[0];
  if ((q === '\'' || q === '"') && s.length > 1 && s[s.length - 1] === q) return s.slice(1, -1);
  if (NUMERIC.test(s)) return Number(s);
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  let v;
  if (io && typeof io.read === 'function') {
    try { v = io.read(s); } catch { v = undefined; }
  }
  if (v !== undefined) return v;
  // A name the value table does not answer to may still be a structure or one of its members.
  // Members are tried FIRST: `T.STAGE_DLY.DN` must resolve through the timer `T.STAGE_DLY`, and
  // asking the database for a timer called `T.STAGE_DLY.DN` would be asking the wrong question.
  const member = dottedMember(io, s);
  if (member !== undefined) return member;
  return structFor(io, s) || undefined;
}

/**
 * Write a value to a destination operand.
 * @param {object} io the instruction's world
 * @param {*} tok the destination token
 * @param {*} value the value to store
 * @returns {boolean} true when the database took it
 */
function store(io, tok, value) {
  if (typeof tok !== 'string' || isLiteral(tok)) return false;
  if (!io || typeof io.write !== 'function') return false;
  try {
    const r = io.write(tok.trim(), value);
    return !(r && r.ok === false);
  } catch { return false; }
}

/**
 * Coerce anything the database can hold to a bit.
 *
 * A timer or counter structure reads as its DN bit, so `XIC T.STAGE_DLY` means what an operator
 * expects it to mean even on a database that does not resolve dotted members.
 *
 * @param {*} v the value
 * @returns {boolean} the bit
 */
function bitOf(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase();
    return s !== '' && s !== '0' && s !== 'FALSE' && s !== 'OFF';
  }
  if (v && typeof v === 'object' && 'dn' in v) return !!v.dn;
  return false;
}

/**
 * Coerce anything the database can hold to a number. A timer or counter reads as its accumulator,
 * so `GRT T.STAGE_DLY.ACC 4000` and `GRT T.STAGE_DLY 4000` both say something sensible.
 * @param {*} v the value
 * @returns {number} the number, or 0 when there is not one
 */
function numOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') { const n = Number(v.trim()); return Number.isFinite(n) ? n : 0; }
  if (v && typeof v === 'object' && typeof v.acc === 'number') return v.acc;
  return 0;
}

/**
 * A 32-bit signed integer view of a value, for the bitwise and masked instructions.
 * @param {*} v the value
 * @returns {number} the value as int32
 */
function intOf(v) {
  return numOf(v) | 0;
}

/**
 * The element's operand list, defensively.
 * @param {object} el the element
 * @returns {Array} the operands, possibly empty
 */
function ops(el) {
  return el && Array.isArray(el.operands) ? el.operands : [];
}

/**
 * Read operand `i` of an element as a number.
 * @param {object} io the instruction's world
 * @param {object} el the element
 * @param {number} i operand index
 * @param {number} [dflt=0] value to use when the operand is absent
 * @returns {number} the number
 */
function nAt(io, el, i, dflt = 0) {
  const tok = ops(el)[i];
  if (tok === undefined || tok === null || tok === '') return dflt;
  const v = resolve(io, tok);
  return v === undefined ? dflt : numOf(v);
}

/**
 * Read operand `i` of an element as a bit.
 * @param {object} io the instruction's world
 * @param {object} el the element
 * @param {number} i operand index
 * @returns {boolean} the bit
 */
function bAt(io, el, i) {
  return bitOf(resolve(io, ops(el)[i]));
}

/**
 * The raw destination token at operand `i`, trimmed.
 * @param {object} el the element
 * @param {number} i operand index
 * @returns {string} the token, or '' when absent
 */
function destAt(el, i) {
  const tok = ops(el)[i];
  return typeof tok === 'string' ? tok.trim() : '';
}

/**
 * Finish a math instruction: write the result, or apply the arithmetic-refusal rule.
 * @param {object} io the instruction's world
 * @param {object} el the element
 * @param {number} destIndex which operand is the destination
 * @param {number} value the computed result
 * @returns {boolean} outgoing power flow
 */
function mathOut(io, el, destIndex, value) {
  const dest = destAt(el, destIndex);
  if (!Number.isFinite(value)) return refuse(io, el, 'the arithmetic has no answer');
  if (!dest) return refuse(io, el, 'has no destination tag');
  if (!store(io, dest, value)) return refuse(io, el, `could not write ${dest}`);
  return true;
}

/**
 * Detect a rising or falling edge of a boolean, remembered on the element instance.
 * @param {object} el the element
 * @param {boolean} now the current value
 * @param {string} [slot='edge'] which remembered bit to use, for instructions with two
 * @returns {{rise:boolean, fall:boolean}} the transitions since last scan
 */
function edge(el, now, slot = 'edge') {
  const st = elementState(el);
  const was = st[slot] === true;
  st[slot] = now;
  return { rise: now && !was, fall: !now && was };
}

// --------------------------------------------------------------------------------------------
// Timers
// --------------------------------------------------------------------------------------------

/**
 * Fetch the timer structure an element addresses and refresh its preset from the operand.
 *
 * The preset is re-applied every scan rather than only at download, because that is what lets a
 * recipe drive a delay: `TON T.STAGE_DLY R.STAGE_DELAY_MS` retunes the sequence from the step
 * table without touching the ladder.
 *
 * @param {object} io the instruction's world
 * @param {object} el the element
 * @returns {object|null} the timer structure, or null when the tag is not a timer
 */
function timerFor(io, el) {
  const name = destAt(el, 0);
  if (!name) return null;
  let t = null;
  if (io && typeof io.timer === 'function') {
    try { t = io.timer(name); } catch { t = null; }
  }
  if (!t || typeof t !== 'object') return null;
  const pre = ops(el)[1];
  if (pre !== undefined && pre !== null && pre !== '') {
    const v = resolve(io, pre);
    if (v !== undefined && numOf(v) >= 0) t.pre = numOf(v);
  }
  // A structure that arrives without numbers in it would make every comparison below NaN, and a
  // NaN accumulator is a timer that never finishes and never says why.
  if (!Number.isFinite(t.pre)) t.pre = 0;
  if (!Number.isFinite(t.acc)) t.acc = 0;
  return t;
}

/**
 * Fetch the counter structure an element addresses and refresh its preset.
 * @param {object} io the instruction's world
 * @param {object} el the element
 * @returns {object|null} the counter structure, or null
 */
function counterFor(io, el) {
  const name = destAt(el, 0);
  if (!name) return null;
  let c = null;
  if (io && typeof io.counter === 'function') {
    try { c = io.counter(name); } catch { c = null; }
  }
  if (!c || typeof c !== 'object') return null;
  const pre = ops(el)[1];
  if (pre !== undefined && pre !== null && pre !== '') {
    const v = resolve(io, pre);
    if (v !== undefined) c.pre = Math.trunc(numOf(v));
  }
  if (!Number.isFinite(c.pre)) c.pre = 0;
  if (!Number.isFinite(c.acc)) c.acc = 0;
  return c;
}

/**
 * Milliseconds elapsed this scan, floored at zero so a rewound clock cannot run a timer backwards.
 * @param {number} dt_s the scan period, s
 * @returns {number} the step, ms
 */
function ms(dt_s) {
  return Number.isFinite(dt_s) && dt_s > 0 ? dt_s * 1000 : 0;
}

// --------------------------------------------------------------------------------------------
// The instruction table
// --------------------------------------------------------------------------------------------

/**
 * Build one instruction specification.
 * @param {object} spec the fields
 * @returns {object} the frozen specification
 */
function inst(spec) {
  return Object.freeze({
    side: spec.kind === ELEMENT_KIND.COIL ? 'output' : 'input',
    ...spec,
    operands: Object.freeze((spec.operands || []).map((o) => Object.freeze({ optional: false, ...o }))),
  });
}

/**
 * Shorthand for an operand slot.
 * @param {string} name slot name
 * @param {string[]} kinds acceptable {@link OPERAND_KIND} values
 * @param {string} role one of {@link ROLE}
 * @param {boolean} [optional=false] whether the slot may be left empty
 * @returns {object} the operand spec
 */
function op(name, kinds, role, optional = false) {
  return { name, kinds, role, optional };
}

const NUM = [OPERAND_KIND.REAL, OPERAND_KIND.INT];
const BIT = [OPERAND_KIND.BOOL];

/**
 * The instruction set, keyed by mnemonic.
 *
 * Each entry is `{mnemonic, name, kind, category, side, glyph, operands, template, help,
 * evaluate}`. `template` is a one-line English rendering with `$0`, `$1`… standing for operands;
 * it is what `compile.describeRung` builds a plain-English summary out of, so keep it a phrase
 * that reads inside a sentence rather than a sentence of its own.
 */
export const INSTRUCTIONS = Object.freeze({

  // --- bit ----------------------------------------------------------------------------------

  XIC: inst({
    mnemonic: 'XIC',
    name: 'Examine if closed',
    kind: ELEMENT_KIND.CONTACT,
    category: CATEGORY.BIT,
    glyph: '-| |-',
    operands: [op('bit', BIT, ROLE.SOURCE)],
    template: '$0 is on',
    help: 'Passes power while the bit is ON. The normally-open contact: it examines the bit, it '
      + 'does not switch it.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && bAt(io, el, 0);
    },
  }),

  XIO: inst({
    mnemonic: 'XIO',
    name: 'Examine if open',
    kind: ELEMENT_KIND.CONTACT,
    category: CATEGORY.BIT,
    glyph: '-|/|-',
    operands: [op('bit', BIT, ROLE.SOURCE)],
    template: '$0 is off',
    help: 'Passes power while the bit is OFF. The normally-closed contact — how a permissive, a '
      + 'trip and a stop button are wired, so that a broken wire stops the plant.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && !bAt(io, el, 0);
    },
  }),

  OTE: inst({
    mnemonic: 'OTE',
    name: 'Output energise',
    kind: ELEMENT_KIND.COIL,
    category: CATEGORY.BIT,
    glyph: '-( )-',
    operands: [op('bit', BIT, ROLE.DEST)],
    template: 'energise $0',
    help: 'Copies the rung condition to the bit every scan — ON when power reaches it, OFF when '
      + 'it does not. Two OTEs on one bit is the classic duplicate-coil bug: the last rung wins '
      + 'and the first one appears to do nothing.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      if (!store(io, destAt(el, 0), p)) return refuse(io, el, `could not write ${destAt(el, 0)}`);
      return p;
    },
  }),

  OTL: inst({
    mnemonic: 'OTL',
    name: 'Output latch',
    kind: ELEMENT_KIND.COIL,
    category: CATEGORY.BIT,
    glyph: '-(L)-',
    operands: [op('bit', BIT, ROLE.DEST)],
    template: 'latch $0 on',
    help: 'Sets the bit when power arrives and then leaves it alone. Nothing clears it but an OTU, '
      + 'so a latched alarm survives the condition that caused it going away.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      if (p && !store(io, destAt(el, 0), true)) return refuse(io, el, `could not set ${destAt(el, 0)}`);
      return p;
    },
  }),

  OTU: inst({
    mnemonic: 'OTU',
    name: 'Output unlatch',
    kind: ELEMENT_KIND.COIL,
    category: CATEGORY.BIT,
    glyph: '-(U)-',
    operands: [op('bit', BIT, ROLE.DEST)],
    template: 'unlatch $0',
    help: 'Clears the bit when power arrives and then leaves it alone. The other half of an OTL: '
      + 'an acknowledge push-button is an OTU on the latched alarm.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      if (p && !store(io, destAt(el, 0), false)) return refuse(io, el, `could not clear ${destAt(el, 0)}`);
      return p;
    },
  }),

  ONS: inst({
    mnemonic: 'ONS',
    name: 'One shot',
    kind: ELEMENT_KIND.CONTACT,
    category: CATEGORY.BIT,
    glyph: '-[ONS]-',
    operands: [],
    template: 'on the scan power first arrives',
    help: 'Passes power for exactly one scan each time power arrives, then blocks until power has '
      + 'gone away again. Its memory belongs to this element, so two one-shots watching the same '
      + 'bit cannot steal each other\'s edge.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return edge(el, powerIn(io)).rise;
    },
  }),

  OSR: inst({
    mnemonic: 'OSR',
    name: 'One shot rising',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.BIT,
    side: 'output',
    glyph: '[OSR]',
    operands: [op('bit', BIT, ROLE.DEST, true)],
    template: 'pulse $0 as power arrives',
    help: 'Emits one scan of power on the rising edge of the rung, and sets the optional bit for '
      + 'that scan. Use it to start something once: an edge, not a level.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const pulse = edge(el, powerIn(io)).rise;
      const dest = destAt(el, 0);
      if (dest) store(io, dest, pulse);
      return pulse;
    },
  }),

  OSF: inst({
    mnemonic: 'OSF',
    name: 'One shot falling',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.BIT,
    side: 'output',
    glyph: '[OSF]',
    operands: [op('bit', BIT, ROLE.DEST, true)],
    template: 'pulse $0 as power is lost',
    help: 'Emits one scan of power on the FALLING edge of the rung — power out while power in has '
      + 'just gone false. That is exactly what you want to log a pump stopping, and it is why the '
      + 'solver must take an instruction\'s returned power as-is rather than ANDing it.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const pulse = edge(el, powerIn(io)).fall;
      const dest = destAt(el, 0);
      if (dest) store(io, dest, pulse);
      return pulse;
    },
  }),

  // --- timers -------------------------------------------------------------------------------

  TON: inst({
    mnemonic: 'TON',
    name: 'Timer on delay',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.TIMER,
    side: 'output',
    glyph: '[TON]',
    operands: [op('timer', [OPERAND_KIND.TIMER], ROLE.STRUCT), op('preset ms', NUM, ROLE.SOURCE, true)],
    template: 'time $0 for $1 ms',
    help: 'Accumulates while the rung is true and sets DN when the accumulator reaches the preset. '
      + 'The rung going false resets it to zero — it does not remember. This is the stage-up delay, '
      + 'the seal failure delay, and nine of every ten timers in a real program.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const t = timerFor(io, el);
      if (!t) return refuse(io, el, `${destAt(el, 0) || '(no operand)'} is not a timer`);
      t.en = p;
      if (!p) { t.acc = 0; t.tt = false; t.dn = false; return false; }
      if (!t.dn) {
        t.acc += ms(dt_s);
        if (t.acc >= t.pre) { t.acc = t.pre; t.dn = true; t.tt = false; } else { t.tt = true; }
      } else {
        t.tt = false;
      }
      return true;
    },
  }),

  TOF: inst({
    mnemonic: 'TOF',
    name: 'Timer off delay',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.TIMER,
    side: 'output',
    glyph: '[TOF]',
    operands: [op('timer', [OPERAND_KIND.TIMER], ROLE.STRUCT), op('preset ms', NUM, ROLE.SOURCE, true)],
    template: 'hold $0 on for $1 ms after power is lost',
    help: 'The mirror of TON. DN goes on the instant the rung goes true and stays on for the preset '
      + 'AFTER the rung goes false. A minimum-run timer, a fan overrun, a lamp that stays lit long '
      + 'enough to be seen.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const t = timerFor(io, el);
      if (!t) return refuse(io, el, `${destAt(el, 0) || '(no operand)'} is not a timer`);
      t.en = p;
      if (p) { t.acc = 0; t.tt = false; t.dn = true; return true; }
      if (t.dn) {
        t.acc += ms(dt_s);
        if (t.acc >= t.pre) { t.acc = t.pre; t.dn = false; t.tt = false; } else { t.tt = true; }
      } else {
        t.tt = false;
      }
      return false;
    },
  }),

  RTO: inst({
    mnemonic: 'RTO',
    name: 'Retentive timer on',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.TIMER,
    side: 'output',
    glyph: '[RTO]',
    operands: [op('timer', [OPERAND_KIND.TIMER], ROLE.STRUCT), op('preset ms', NUM, ROLE.SOURCE, true)],
    template: 'accumulate $0 toward $1 ms',
    help: 'Like TON but it KEEPS the accumulator when the rung goes false, so it totals scattered '
      + 'periods rather than one continuous one. Only a RES clears it. This is how you count time '
      + 'to a service interval; forgetting the RES is why one is stuck at DN forever.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const t = timerFor(io, el);
      if (!t) return refuse(io, el, `${destAt(el, 0) || '(no operand)'} is not a timer`);
      t.en = p;
      if (p && !t.dn) {
        t.acc += ms(dt_s);
        if (t.acc >= t.pre) { t.acc = t.pre; t.dn = true; t.tt = false; } else { t.tt = true; }
      } else {
        t.tt = false;
      }
      return p;
    },
  }),

  RES: inst({
    mnemonic: 'RES',
    name: 'Reset',
    kind: ELEMENT_KIND.COIL,
    category: CATEGORY.TIMER,
    glyph: '-(RES)-',
    operands: [op('structure', [OPERAND_KIND.TIMER, OPERAND_KIND.COUNTER], ROLE.STRUCT)],
    template: 'reset $0',
    help: 'Zeroes a timer or counter and clears all of its status bits. The only thing that will '
      + 'clear an RTO or a counter that has reached its preset.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      if (!p) return false;
      const st = structFor(io, destAt(el, 0));
      if (!st) return refuse(io, el, `${destAt(el, 0) || '(no operand)'} is not a timer or counter`);
      st.acc = 0;
      st.dn = false;
      if ('tt' in st) st.tt = false;
      if ('en' in st) st.en = false;
      if ('ov' in st) st.ov = false;
      if ('un' in st) st.un = false;
      return true;
    },
  }),

  // --- counters -----------------------------------------------------------------------------

  CTU: inst({
    mnemonic: 'CTU',
    name: 'Count up',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COUNTER,
    side: 'output',
    glyph: '[CTU]',
    operands: [op('counter', [OPERAND_KIND.COUNTER], ROLE.STRUCT), op('preset', NUM, ROLE.SOURCE, true)],
    template: 'count $0 up to $1',
    help: 'Adds one on each RISING EDGE of the rung — not once per scan — and sets DN once the '
      + 'accumulator reaches the preset. Counting starts per hour is what tells you a set is '
      + 'short-cycling. Past 2147483647 it rolls negative and latches OV, exactly like the real thing.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const c = counterFor(io, el);
      if (!c) return refuse(io, el, `${destAt(el, 0) || '(no operand)'} is not a counter`);
      c.cu = p;
      if (edge(el, p).rise) {
        if (c.acc >= INT32_MAX) { c.acc = INT32_MIN; c.ov = true; } else { c.acc += 1; }
      }
      c.dn = c.acc >= c.pre;
      return p;
    },
  }),

  CTD: inst({
    mnemonic: 'CTD',
    name: 'Count down',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COUNTER,
    side: 'output',
    glyph: '[CTD]',
    operands: [op('counter', [OPERAND_KIND.COUNTER], ROLE.STRUCT), op('preset', NUM, ROLE.SOURCE, true)],
    template: 'count $0 down toward $1',
    help: 'Subtracts one on each rising edge of the rung. Pair it with a CTU on the same counter to '
      + 'track how many of something are in the system. DN still means accumulator at or above '
      + 'preset; below -2147483648 it wraps positive and latches UN.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const c = counterFor(io, el);
      if (!c) return refuse(io, el, `${destAt(el, 0) || '(no operand)'} is not a counter`);
      c.cd = p;
      if (edge(el, p).rise) {
        if (c.acc <= INT32_MIN) { c.acc = INT32_MAX; c.un = true; } else { c.acc -= 1; }
      }
      c.dn = c.acc >= c.pre;
      return p;
    },
  }),

  // --- compare ------------------------------------------------------------------------------

  EQU: inst({
    mnemonic: 'EQU',
    name: 'Equal',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[A=B]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE)],
    template: '$0 equals $1',
    help: 'Passes power while the two values are equal. On REAL tags this is an exact comparison, '
      + 'so compare integers — a step number, a mode — and use LIM for anything measured.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && nAt(io, el, 0) === nAt(io, el, 1);
    },
  }),

  NEQ: inst({
    mnemonic: 'NEQ',
    name: 'Not equal',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[A<>B]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE)],
    template: '$0 differs from $1',
    help: 'Passes power while the two values are not equal.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && nAt(io, el, 0) !== nAt(io, el, 1);
    },
  }),

  LES: inst({
    mnemonic: 'LES',
    name: 'Less than',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[A<B]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE)],
    template: '$0 is below $1',
    help: 'Passes power while the first value is less than the second.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && nAt(io, el, 0) < nAt(io, el, 1);
    },
  }),

  GRT: inst({
    mnemonic: 'GRT',
    name: 'Greater than',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[A>B]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE)],
    template: '$0 is above $1',
    help: 'Passes power while the first value is greater than the second. A bare GRT on a measured '
      + 'value chatters at the threshold — put a TON after it, or use ALARM, which has a deadband.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && nAt(io, el, 0) > nAt(io, el, 1);
    },
  }),

  LEQ: inst({
    mnemonic: 'LEQ',
    name: 'Less than or equal',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[A<=B]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE)],
    template: '$0 is at or below $1',
    help: 'Passes power while the first value is less than or equal to the second.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && nAt(io, el, 0) <= nAt(io, el, 1);
    },
  }),

  GEQ: inst({
    mnemonic: 'GEQ',
    name: 'Greater than or equal',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[A>=B]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE)],
    template: '$0 is at or above $1',
    help: 'Passes power while the first value is greater than or equal to the second.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io) && nAt(io, el, 0) >= nAt(io, el, 1);
    },
  }),

  LIM: inst({
    mnemonic: 'LIM',
    name: 'Limit test',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[LIM]',
    operands: [op('low', NUM, ROLE.SOURCE), op('test', NUM, ROLE.SOURCE), op('high', NUM, ROLE.SOURCE)],
    template: '$1 is between $0 and $2',
    help: 'Passes power while the test value is inside the band. If the low limit is GREATER than '
      + 'the high limit the test inverts and the band becomes everything OUTSIDE the two — that is '
      + 'not a bug, it is how you write an out-of-range test in one instruction, and it is why '
      + 'swapping the two limits by accident makes a rung behave backwards.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const lo = nAt(io, el, 0);
      const x = nAt(io, el, 1);
      const hi = nAt(io, el, 2);
      const inside = lo <= hi ? (x >= lo && x <= hi) : (x >= lo || x <= hi);
      return powerIn(io) && inside;
    },
  }),

  MEQ: inst({
    mnemonic: 'MEQ',
    name: 'Masked equal',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.COMPARE,
    glyph: '[MEQ]',
    operands: [op('source', NUM, ROLE.SOURCE), op('mask', NUM, ROLE.SOURCE), op('compare', NUM, ROLE.SOURCE)],
    template: '$0 matches $2 under mask $1',
    help: 'Compares only the bits the mask has set. How you test a handful of bits inside a packed '
      + 'status word without caring what the rest of it is doing.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const m = intOf(nAt(io, el, 1));
      return powerIn(io) && (intOf(nAt(io, el, 0)) & m) === (intOf(nAt(io, el, 2)) & m);
    },
  }),

  // --- math ---------------------------------------------------------------------------------

  ADD: inst({
    mnemonic: 'ADD',
    name: 'Add',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[ADD]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put $0 plus $1 in $2',
    help: 'Adds the two sources into the destination while the rung is true.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 2, nAt(io, el, 0) + nAt(io, el, 1));
    },
  }),

  SUB: inst({
    mnemonic: 'SUB',
    name: 'Subtract',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[SUB]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put $0 minus $1 in $2',
    help: 'Subtracts the second source from the first. Deviation from setpoint is a SUB.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 2, nAt(io, el, 0) - nAt(io, el, 1));
    },
  }),

  MUL: inst({
    mnemonic: 'MUL',
    name: 'Multiply',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[MUL]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put $0 times $1 in $2',
    help: 'Multiplies the two sources into the destination.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 2, nAt(io, el, 0) * nAt(io, el, 1));
    },
  }),

  DIV: inst({
    mnemonic: 'DIV',
    name: 'Divide',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[DIV]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put $0 divided by $1 in $2',
    help: 'Divides the first source by the second. A zero divisor writes NOTHING and drops power, '
      + 'so the destination keeps its last good value and a coil after the DIV can annunciate it.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const b = nAt(io, el, 1);
      if (b === 0) return refuse(io, el, 'divide by zero — the destination was left alone');
      return mathOut(io, el, 2, nAt(io, el, 0) / b);
    },
  }),

  MOD: inst({
    mnemonic: 'MOD',
    name: 'Modulo',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[MOD]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put the remainder of $0 over $1 in $2',
    help: 'The remainder after division. How a duty index wraps around the number of pumps. A zero '
      + 'divisor is refused the same way DIV refuses it.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const b = nAt(io, el, 1);
      if (b === 0) return refuse(io, el, 'modulo by zero — the destination was left alone');
      return mathOut(io, el, 2, nAt(io, el, 0) % b);
    },
  }),

  MOV: inst({
    mnemonic: 'MOV',
    name: 'Move',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[MOV]',
    operands: [op('source', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'move $0 into $1',
    help: 'Copies the source into the destination every scan the rung is true. The destination is '
      + 'clamped to its engineering range by the tag database, so a MOV can never put a setpoint '
      + 'somewhere the plant cannot go.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 1, nAt(io, el, 0));
    },
  }),

  CLR: inst({
    mnemonic: 'CLR',
    name: 'Clear',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[CLR]',
    operands: [op('dest', NUM, ROLE.DEST)],
    template: 'zero $0',
    help: 'Writes zero to the destination. A shift totaliser reset is one CLR behind a one-shot.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 0, 0);
    },
  }),

  SQR: inst({
    mnemonic: 'SQR',
    name: 'Square root',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[SQR]',
    operands: [op('source', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put the square root of $0 in $1',
    help: 'Square root. This is the one an orifice plate needs: differential pressure goes with the '
      + 'square of flow, so flow goes with the root of the differential. A negative source is '
      + 'refused rather than made into a NaN.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const a = nAt(io, el, 0);
      if (a < 0) return refuse(io, el, 'square root of a negative — the destination was left alone');
      return mathOut(io, el, 1, Math.sqrt(a));
    },
  }),

  NEG: inst({
    mnemonic: 'NEG',
    name: 'Negate',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[NEG]',
    operands: [op('source', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put minus $0 in $1',
    help: 'Changes the sign of the source into the destination.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 1, -nAt(io, el, 0));
    },
  }),

  ABS: inst({
    mnemonic: 'ABS',
    name: 'Absolute value',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[ABS]',
    operands: [op('source', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put the size of $0 in $1',
    help: 'Magnitude without the sign. Deviation alarms want the absolute error, not the signed one.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 1, Math.abs(nAt(io, el, 0)));
    },
  }),

  SCL: inst({
    mnemonic: 'SCL',
    name: 'Scale',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[SCL]',
    operands: [
      op('source', NUM, ROLE.SOURCE), op('in low', NUM, ROLE.SOURCE), op('in high', NUM, ROLE.SOURCE),
      op('out low', NUM, ROLE.SOURCE), op('out high', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST),
    ],
    template: 'scale $0 from $1..$2 into $3..$4 and put it in $5',
    help: 'Straight-line scaling between two ranges, NOT clamped: a source outside the input span '
      + 'gives a result outside the output span, which is how an over-range transmitter stays '
      + 'visible instead of being quietly pinned at 100%. Use SCP when the result commands '
      + 'something. An input span of zero has no answer, so nothing is written and power drops.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const inLo = nAt(io, el, 1);
      const inHi = nAt(io, el, 2);
      if (inHi === inLo) return refuse(io, el, 'the input span is zero — there is no scale to apply');
      const f = (nAt(io, el, 0) - inLo) / (inHi - inLo);
      const outLo = nAt(io, el, 3);
      return mathOut(io, el, 5, outLo + f * (nAt(io, el, 4) - outLo));
    },
  }),

  SCP: inst({
    mnemonic: 'SCP',
    name: 'Scale with parameters',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[SCP]',
    operands: [
      op('source', NUM, ROLE.SOURCE), op('in low', NUM, ROLE.SOURCE), op('in high', NUM, ROLE.SOURCE),
      op('out low', NUM, ROLE.SOURCE), op('out high', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST),
    ],
    template: 'scale $0 from $1..$2 into $3..$4, clamped, and put it in $5',
    help: 'SCL with the result held inside the output range. This is the one that drives a valve or '
      + 'a speed reference: whatever the source does, the command stays between the two limits.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const inLo = nAt(io, el, 1);
      const inHi = nAt(io, el, 2);
      if (inHi === inLo) return refuse(io, el, 'the input span is zero — there is no scale to apply');
      const outLo = nAt(io, el, 3);
      const outHi = nAt(io, el, 4);
      const f = (nAt(io, el, 0) - inLo) / (inHi - inLo);
      const y = outLo + f * (outHi - outLo);
      return mathOut(io, el, 5, clamp(y, Math.min(outLo, outHi), Math.max(outLo, outHi)));
    },
  }),

  AVE: inst({
    mnemonic: 'AVE',
    name: 'Average',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.MATH,
    side: 'output',
    glyph: '[AVE]',
    operands: [op('source', NUM, ROLE.SOURCE), op('samples', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'average the last $1 samples of $0 into $2',
    help: 'A rolling mean of the last N scans, taken once per scan the rung is true. The window '
      + 'lives on this element, so it starts empty after a download and fills as it goes — the '
      + 'destination is the mean of what it has, never a mean of zeros. Deviates from the file-based '
      + 'AVE on a Logix processor, which averages an array; this rig has no files.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const want = Math.max(1, Math.min(1000, Math.trunc(nAt(io, el, 1, 8))));
      const st = elementState(el);
      if (!Array.isArray(st.samples) || st.size !== want) { st.samples = []; st.size = want; }
      st.samples.push(nAt(io, el, 0));
      while (st.samples.length > want) st.samples.shift();
      let sum = 0;
      for (const v of st.samples) sum += v;
      return mathOut(io, el, 2, sum / st.samples.length);
    },
  }),

  // --- logic --------------------------------------------------------------------------------

  AND: inst({
    mnemonic: 'AND',
    name: 'Bitwise and',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.LOGIC,
    side: 'output',
    glyph: '[AND]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put $0 AND $1 in $2',
    help: 'Bit-by-bit AND of two 32-bit words. This is masking a status word, not series contacts — '
      + 'series contacts are what AND logic looks like in ladder.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 2, intOf(nAt(io, el, 0)) & intOf(nAt(io, el, 1)));
    },
  }),

  OR: inst({
    mnemonic: 'OR',
    name: 'Bitwise or',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.LOGIC,
    side: 'output',
    glyph: '[OR]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put $0 OR $1 in $2',
    help: 'Bit-by-bit OR of two 32-bit words — how alarm bits get packed into one summary word.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 2, intOf(nAt(io, el, 0)) | intOf(nAt(io, el, 1)));
    },
  }),

  XOR: inst({
    mnemonic: 'XOR',
    name: 'Bitwise exclusive or',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.LOGIC,
    side: 'output',
    glyph: '[XOR]',
    operands: [op('a', NUM, ROLE.SOURCE), op('b', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put $0 XOR $1 in $2',
    help: 'Bit-by-bit exclusive OR: set where the two words differ. A cheap change detector.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 2, intOf(nAt(io, el, 0)) ^ intOf(nAt(io, el, 1)));
    },
  }),

  NOT: inst({
    mnemonic: 'NOT',
    name: 'Bitwise complement',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.LOGIC,
    side: 'output',
    glyph: '[NOT]',
    operands: [op('source', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'put the complement of $0 in $1',
    help: 'Inverts every bit of a 32-bit word. To invert a single bit in ladder, use XIO.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      return mathOut(io, el, 1, ~intOf(nAt(io, el, 0)));
    },
  }),

  // --- program control ------------------------------------------------------------------------

  JMP: inst({
    mnemonic: 'JMP',
    name: 'Jump to label',
    kind: ELEMENT_KIND.COIL,
    category: CATEGORY.CONTROL,
    glyph: '-(JMP)-',
    operands: [op('label', [OPERAND_KIND.STRING], ROLE.LABEL)],
    template: 'jump to $0',
    help: 'Skips forward to the rung carrying the matching LBL. Everything jumped over keeps the '
      + 'state it had — outputs are NOT cleared, timers do not run. Jumping BACKWARDS is legal and '
      + 'is how you write an endless loop; the processor watchdog will fault before the browser '
      + 'freezes, which is the point of having one.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      if (!p) return false;
      const label = String(ops(el)[0] === undefined ? '' : ops(el)[0]).trim().replace(/^['"]|['"]$/g, '');
      const jump = io && io.control && io.control.jump;
      if (typeof jump !== 'function') return refuse(io, el, 'this scan engine offers no jump');
      try { jump(label); } catch { return refuse(io, el, `could not jump to ${label}`); }
      return true;
    },
  }),

  LBL: inst({
    mnemonic: 'LBL',
    name: 'Label',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.CONTROL,
    glyph: '[LBL]',
    operands: [op('label', [OPERAND_KIND.STRING], ROLE.LABEL)],
    template: 'labelled $0',
    help: 'The target of a JMP. It does nothing itself and must be the first element on its rung.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io);
    },
  }),

  MCR: inst({
    mnemonic: 'MCR',
    name: 'Master control reset',
    kind: ELEMENT_KIND.COIL,
    category: CATEGORY.CONTROL,
    glyph: '-(MCR)-',
    operands: [],
    template: 'control the zone below',
    help: 'Opens and closes a zone. While the rung holding the first MCR is FALSE every non-retentive '
      + 'output in the zone is held off, and the zone ends at the next MCR on a rung of its own. It '
      + 'is not a safety device and never has been: latches, timers with retained accumulators and '
      + 'anything hard-wired stay exactly where they were.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const off = io && io.control && io.control.mcrOff;
      if (!p && typeof off === 'function') {
        try { off(); } catch { /* the scan engine owns the zone, not us */ }
      }
      return p;
    },
  }),

  NOP: inst({
    mnemonic: 'NOP',
    name: 'No operation',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.CONTROL,
    glyph: '[NOP]',
    operands: [],
    template: 'do nothing',
    help: 'A placeholder that passes power straight through. Useful while you are building a rung '
      + 'and have not decided what goes here yet.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return powerIn(io);
    },
  }),

  AFI: inst({
    mnemonic: 'AFI',
    name: 'Always false',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.CONTROL,
    glyph: '[AFI]',
    operands: [],
    template: 'never',
    help: 'Never passes power, whatever reaches it. Drop one at the front of a rung to disable that '
      + 'rung while you test — and leave a comment saying why, because an AFI you forgot about is '
      + 'indistinguishable from logic that does not work.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      return false;
    },
  }),

  // --- process ------------------------------------------------------------------------------

  PID: inst({
    mnemonic: 'PID',
    name: 'Loop command',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[PID]',
    operands: [
      op('setpoint', NUM, ROLE.SOURCE),
      op('mode', [OPERAND_KIND.STRING], ROLE.SOURCE, true),
      op('output', NUM, ROLE.DEST, true),
    ],
    template: 'command the loop to $0 in $1 mode, output to $2',
    help: 'Commands the rig\'s own PID controller — it does not re-implement one. While the rung is '
      + 'true the setpoint is applied and, if a mode is given (AUTO, MAN or CASCADE), so is that; '
      + 'the loop\'s live output is copied to the optional destination every scan either way. The '
      + 'supervisory PLC decides WHAT the loop should hold; the loop decides how hard to work.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const ctx = io && io.ctx;
      const sim = io && io.sim;
      const dest = destAt(el, 2);
      if (dest && ctx && ctx.run && Number.isFinite(ctx.run.co_pct)) store(io, dest, ctx.run.co_pct);
      if (!p) return false;
      if (!ctx || !sim) return refuse(io, el, 'no loop is attached to this processor');
      if (typeof sim.setSetpoint === 'function') {
        const r = sim.setSetpoint(ctx, nAt(io, el, 0));
        if (r && r.ok === false) return refuse(io, el, r.reason || 'the loop refused the setpoint');
      }
      const modeTok = ops(el)[1];
      if (modeTok !== undefined && modeTok !== null && modeTok !== ''
          && typeof sim.setControllerMode === 'function') {
        const mode = String(resolve(io, modeTok)).toUpperCase();
        const r = sim.setControllerMode(ctx, mode);
        if (r && r.ok === false) return refuse(io, el, r.reason || `the loop refused mode ${mode}`);
      }
      return true;
    },
  }),

  SETPT: inst({
    mnemonic: 'SETPT',
    name: 'Guarded setpoint',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[SETPT]',
    operands: [
      op('source', NUM, ROLE.SOURCE), op('low', NUM, ROLE.SOURCE), op('high', NUM, ROLE.SOURCE),
      op('dest', NUM, ROLE.DEST),
    ],
    template: 'set $3 to $0, held between $1 and $2',
    help: 'Writes a value to a tag but never outside the band. This is what a recipe step should go '
      + 'through: the data in the grid is editable by anyone, and this is the rung that says what '
      + 'the plant will actually accept. Power drops when the value had to be clipped, so the rung '
      + 'can tell the operator the recipe asked for something out of reach.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const want = nAt(io, el, 0);
      const lo = nAt(io, el, 1);
      const hi = nAt(io, el, 2);
      const held = clamp(want, Math.min(lo, hi), Math.max(lo, hi));
      if (!mathOut(io, el, 3, held)) return false;
      return held === want;
    },
  }),

  RAMP: inst({
    mnemonic: 'RAMP',
    name: 'Ramp to target',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[RAMP]',
    operands: [
      op('target', NUM, ROLE.SOURCE), op('rate per s', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST),
    ],
    template: 'ramp $2 toward $0 at $1 a second',
    help: 'Moves the destination toward the target at no more than the given rate while the rung is '
      + 'true, and passes power once it has ARRIVED — which is the "step complete" a recipe walker '
      + 'wants. A rate of zero or less steps straight there. Rung false holds the value where it is.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const dest = destAt(el, 2);
      const target = nAt(io, el, 0);
      const rate = nAt(io, el, 1);
      const now = numOf(resolve(io, dest));
      let next = target;
      if (rate > 0 && Number.isFinite(dt_s) && dt_s > 0) {
        const step = rate * dt_s;
        const d = target - now;
        if (d > step) next = now + step; else if (d < -step) next = now - step;
      }
      if (!mathOut(io, el, 2, next)) return false;
      return next === target;
    },
  }),

  TOTAL: inst({
    mnemonic: 'TOTAL',
    name: 'Totaliser',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[TOTAL]',
    operands: [
      op('rate', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST), op('per', NUM, ROLE.SOURCE, true),
    ],
    template: 'total $0 into $1',
    help: 'Integrates a rate into a total: destination plus rate times the scan period, divided by '
      + 'the third operand. That divisor defaults to 3600 because every rate on this rig is per '
      + 'hour — m3/h into m3, kW into kWh. Unlike a timer this counts the WHOLE of a long scan, so '
      + 'it stays honest at twenty times real time. Reset it with a CLR.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const per = nAt(io, el, 2, 3600);
      if (per === 0) return refuse(io, el, 'a divisor of zero has no answer');
      const step = Number.isFinite(dt_s) && dt_s > 0 ? dt_s : 0;
      const dest = destAt(el, 1);
      return mathOut(io, el, 1, numOf(resolve(io, dest)) + (nAt(io, el, 0) * step) / per);
    },
  }),

  DEADBAND: inst({
    mnemonic: 'DEADBAND',
    name: 'Report by exception',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[DB]',
    operands: [op('source', NUM, ROLE.SOURCE), op('band', NUM, ROLE.SOURCE), op('dest', NUM, ROLE.DEST)],
    template: 'pass $0 to $2 when it moves by $1',
    help: 'Copies the source to the destination only once it has moved further than the band from '
      + 'the value last copied, and passes power on the scan it does. Noise on a transmitter stops '
      + 'being a hundred writes a second; the operator sees a number that means something changed.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const st = elementState(el);
      const x = nAt(io, el, 0);
      const band = Math.abs(nAt(io, el, 1));
      if (st.passed !== undefined && Math.abs(x - st.passed) < band) return false;
      if (!mathOut(io, el, 2, x)) return false;
      st.passed = x;
      return true;
    },
  }),

  ALARM: inst({
    mnemonic: 'ALARM',
    name: 'Alarm with deadband',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[ALM]',
    operands: [
      op('source', NUM, ROLE.SOURCE), op('low', NUM, ROLE.SOURCE), op('high', NUM, ROLE.SOURCE),
      op('dest', BIT, ROLE.DEST), op('deadband', NUM, ROLE.SOURCE, true),
    ],
    template: 'alarm $3 when $0 leaves $1..$2',
    help: 'Sets the destination bit while the source is outside the band, and does not clear it '
      + 'again until the source is back inside by the deadband. That hysteresis is the whole '
      + 'instruction: without it a measurement sitting on its limit produces an alarm an operator '
      + 'learns to ignore. Rung false clears the bit and forgets the state.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const st = elementState(el);
      if (!powerIn(io)) {
        st.alarm = false;
        store(io, destAt(el, 3), false);
        return false;
      }
      const x = nAt(io, el, 0);
      const lo = nAt(io, el, 1);
      const hi = nAt(io, el, 2);
      const db = Math.abs(nAt(io, el, 4, 0));
      let on = st.alarm === true;
      if (x > hi || x < lo) on = true;
      else if (x <= hi - db && x >= lo + db) on = false;
      st.alarm = on;
      if (!store(io, destAt(el, 3), on)) return refuse(io, el, `could not write ${destAt(el, 3)}`);
      return on;
    },
  }),

  ALTERNATE: inst({
    mnemonic: 'ALTERNATE',
    name: 'Duty alternation',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[ALT]',
    operands: [
      op('duty', [OPERAND_KIND.INT, OPERAND_KIND.BOOL], ROLE.DEST),
      op('count', NUM, ROLE.SOURCE, true),
    ],
    template: 'advance the duty in $0',
    help: 'Advances a duty selector on each RISING edge of the rung, wrapping at the machine count '
      + '(two by default). A BOOL destination simply toggles. Alternating on an edge and not on a '
      + 'level is what stops the set swapping lead pump every scan; feed it a one-shot off "all '
      + 'stopped" or off a run-hours comparison.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      const p = powerIn(io);
      const dest = destAt(el, 0);
      if (!dest) return refuse(io, el, 'has no duty tag');
      if (!edge(el, p).rise) return p;
      const now = resolve(io, dest);
      if (typeof now === 'boolean') {
        if (!store(io, dest, !now)) return refuse(io, el, `could not write ${dest}`);
        return p;
      }
      const count = Math.max(1, Math.trunc(nAt(io, el, 1, 2)));
      if (!store(io, dest, (Math.trunc(numOf(now)) + 1) % count)) {
        return refuse(io, el, `could not write ${dest}`);
      }
      return p;
    },
  }),

  RUNHOURS: inst({
    mnemonic: 'RUNHOURS',
    name: 'Run hours',
    kind: ELEMENT_KIND.BLOCK,
    category: CATEGORY.PROCESS,
    side: 'output',
    glyph: '[HRS]',
    operands: [op('dest', NUM, ROLE.DEST)],
    template: 'log run hours into $0',
    help: 'Adds the scan period, in hours, to the destination while the rung is true. Two of these '
      + 'behind the two run bits are the entire input to duty rotation: rotate on the difference '
      + 'between them and the set wears evenly.',
    /**
     * @param {object} rung the rung being solved
     * @param {object} el the element
     * @param {object} io the instruction's world
     * @param {number} dt_s scan period, s
     * @returns {boolean} outgoing power flow
     */
    evaluate(rung, el, io, dt_s) {
      if (!powerIn(io)) return false;
      const step = Number.isFinite(dt_s) && dt_s > 0 ? dt_s : 0;
      const dest = destAt(el, 0);
      return mathOut(io, el, 0, numOf(resolve(io, dest)) + step / 3600);
    },
  }),
});

// --------------------------------------------------------------------------------------------
// Public helpers
// --------------------------------------------------------------------------------------------

/**
 * The instruction set grouped for the editor's palette, in teaching order.
 * @returns {Array<{category:string, label:string, instructions:object[]}>} the groups
 */
export function instructionsByCategory() {
  const order = [
    CATEGORY.BIT, CATEGORY.TIMER, CATEGORY.COUNTER, CATEGORY.COMPARE,
    CATEGORY.MATH, CATEGORY.LOGIC, CATEGORY.CONTROL, CATEGORY.PROCESS,
  ];
  return order.map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    instructions: Object.values(INSTRUCTIONS).filter((s) => s.category === category),
  }));
}

/**
 * Build an element, refusing a mnemonic the processor does not have rather than letting a typo
 * become a rung that silently never does anything.
 * @param {string} mnemonic the instruction
 * @param {Array} [operands] operand tokens, in order
 * @returns {{ok:boolean, el?:object, reason?:string}} the element, or a refusal
 */
export function createElement(mnemonic, operands) {
  const key = typeof mnemonic === 'string' ? mnemonic.trim().toUpperCase() : '';
  const spec = INSTRUCTIONS[key];
  if (!spec) return { ok: false, reason: `there is no instruction called "${mnemonic}"` };
  return {
    ok: true,
    el: { kind: spec.kind, mnemonic: key, operands: Array.isArray(operands) ? operands.slice() : [] },
  };
}

/**
 * Evaluate one element with an explicit incoming power flow. This is the call the scan engine
 * should make: it sets `io.power` for the instruction and restores whatever was there before, so
 * a nested evaluation (a branch leg) cannot leak its power into the leg after it.
 *
 * Never throws. A malformed element or a database that refuses a write costs the element its
 * power flow and, where the engine offers one, a minor fault.
 *
 * @param {object} rung the rung being solved
 * @param {object} el the element
 * @param {object} io the instruction's world
 * @param {number} dt_s scan period, s
 * @param {boolean} [power=true] the power flow arriving at this element
 * @returns {boolean} the power flow leaving it
 */
export function evaluateElement(rung, el, io, dt_s, power = true) {
  const spec = el && typeof el.mnemonic === 'string' ? INSTRUCTIONS[el.mnemonic.toUpperCase()] : null;
  if (!spec) {
    refuse(io, el, 'unknown instruction — the rung cannot be solved');
    return false;
  }
  const world = io || {};
  const had = world.power;
  world.power = !!power;
  try {
    return !!spec.evaluate(rung, el, world, dt_s);
  } catch (err) {
    return refuse(io, el, `faulted while executing: ${err && err.message ? err.message : err}`);
  } finally {
    world.power = had;
  }
}

/**
 * Render one element as a phrase, from its `template`. `compile.describeRung` stitches these
 * together; the editor uses it for the tooltip.
 * @param {object} el the element
 * @returns {string} the phrase, or the mnemonic when there is no template
 */
export function describeElement(el) {
  const spec = el && typeof el.mnemonic === 'string' ? INSTRUCTIONS[el.mnemonic.toUpperCase()] : null;
  if (!spec) return el && el.mnemonic ? `${el.mnemonic} (unknown)` : '(empty)';
  if (!spec.template) return spec.name;
  return spec.template.replace(/\$(\d+)/g, (m, i) => {
    const tok = ops(el)[Number(i)];
    return tok === undefined || tok === null || tok === '' ? '?' : String(tok);
  });
}

/**
 * Check one element's operands against its specification, for `model.validateProgram` and
 * `compile.lintProgram`. Returns problems rather than throwing, and returns an empty array for
 * anything it is happy with.
 *
 * @param {object} el the element
 * @param {object} [db] the tag database, for the type check; omit to check arity and literals only
 * @param {(db:object, name:string)=>object|undefined} [lookup] how to ask that database about a
 *   tag. `tags.tagInfo` is a free function rather than a method, so pass it in; without it this
 *   falls back to duck-typing the database and, failing that, skips the type check rather than
 *   inventing an error about a tag that may well exist
 * @returns {Array<{severity:string, message:string}>} the problems found
 */
export function checkOperands(el, db, lookup) {
  const out = [];
  const spec = el && typeof el.mnemonic === 'string' ? INSTRUCTIONS[el.mnemonic.toUpperCase()] : null;
  if (!spec) {
    out.push({ severity: 'error', message: `there is no instruction called "${el && el.mnemonic}"` });
    return out;
  }
  const given = ops(el);
  const required = spec.operands.filter((o) => !o.optional).length;
  if (given.length < required) {
    out.push({
      severity: 'error',
      message: `${spec.mnemonic} needs ${required} operand(s), got ${given.length}`,
    });
  }
  if (given.length > spec.operands.length) {
    out.push({
      severity: 'warn',
      message: `${spec.mnemonic} takes at most ${spec.operands.length} operand(s)`,
    });
  }
  spec.operands.forEach((o, i) => {
    const tok = given[i];
    const empty = tok === undefined || tok === null || tok === '';
    if (empty) return;
    if (o.role === ROLE.DEST || o.role === ROLE.STRUCT) {
      if (isLiteral(tok)) {
        out.push({
          severity: 'error',
          message: `${spec.mnemonic} operand "${o.name}" must be a tag, not the literal ${tok}`,
        });
        return;
      }
    }
    if (o.role === ROLE.LABEL) return;
    if (!db || isLiteral(tok)) return;
    const info = infoOf(db, String(tok).trim(), lookup);
    if (info === undefined) return;
    if (!info) {
      out.push({ severity: 'error', message: `${spec.mnemonic} operand "${o.name}" names no tag: ${tok}` });
      return;
    }
    if (info.type && !o.kinds.includes(info.type)) {
      out.push({
        severity: 'warn',
        message: `${spec.mnemonic} operand "${o.name}" wants ${o.kinds.join('/')} but ${tok} is ${info.type}`,
      });
    }
  });
  return out;
}

/**
 * Look a tag up in whichever shape the database hands us, tolerating a dotted member name so a
 * `T.STAGE_DLY.DN` operand is not reported as a missing tag.
 * @param {object} db the tag database
 * @param {string} name the operand token
 * @param {Function} [lookup] an explicit `(db, name) => info` accessor
 * @returns {object|null|undefined} the tag info; null when the database is sure it has no such
 *   tag; undefined when there was no way to ask, which is not the same thing and must not be
 *   reported as a missing tag
 */
function infoOf(db, name, lookup) {
  if (typeof lookup === 'function') {
    try {
      return lookup(db, name) || lookup(db, baseName(name)) || null;
    } catch { return undefined; }
  }
  const table = db && (db.info || db.tags);
  if (table instanceof Map) return table.get(name) || table.get(baseName(name)) || null;
  if (table && typeof table === 'object') return table[name] || table[baseName(name)] || null;
  return undefined;
}

/**
 * Strip a trailing structure member, so `T.STAGE_DLY.DN` asks about `T.STAGE_DLY`.
 * @param {string} name the dotted name
 * @returns {string} the name without its last segment, or the name itself when it has one
 */
function baseName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
