/**
 * src/plc/compile.js — everything a program can be asked ABOUT without running it: where each tag
 * is used and by what, which coils are fighting, which names the database has never heard of,
 * which rungs the scan never reaches, what the scan order does behind the programmer's back, the
 * numbers for the status bar, and one line of plain English per rung.
 *
 * Layer L4 (src/plc): imports `model.js`, `instructions.js` and `tags.js` and nothing else. No
 * DOM, no `window`, no `document`, no `performance`, no `Date.now`, no `Math.random` — every line
 * here runs under `node --test`, and nothing in it needs a clock, because analysis is a question
 * about a document rather than about a moment.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 *
 * A ladder program is legible one rung at a time and illegible in the large. Every question an
 * engineer actually asks of an unfamiliar program — "what else writes this bit?", "why does this
 * rung never light?", "what is this rung FOR?" — is a whole-program question, and the tools that
 * answer them are the difference between a program you can edit and a program you can only stare
 * at. On a real terminal they are the cross-reference, the verify pass and the rung comment; here
 * they are {@link crossReference}, {@link lintProgram} and {@link describeRung}.
 *
 * WHERE THE LINE IS DRAWN AGAINST model.js. `model.validateProgram` makes claims about the
 * DOCUMENT: a branch with one leg, an instruction that does not exist, an operand that is not a
 * tag. This file makes claims about BEHAVIOUR: the order rungs scan in, what a jump skips, which
 * of two writers wins. `lintProgram` runs the document checks and then adds the behavioural ones,
 * and it is careful never to say the same thing twice — a linter that reports one fault as three
 * findings is a linter whose output stops being read.
 *
 * THE VALIDATION SPEC TABLE. `model.js` deliberately owns only a reader's-aid table of mnemonics,
 * because it must stay loadable without the instruction set. This file has no such constraint, so
 * it builds the real table out of {@link INSTRUCTIONS} and hands it to `validateProgram`: the
 * operand counts then come from the instructions themselves, and an instruction the processor
 * cannot execute is reported as an error rather than rendered as a mystery box.
 *
 * ------------------------------------------------------------------------------------------
 * REFUSALS
 *
 * The house pattern is `{ok:false, reason}`, and none of these functions can use it: their return
 * types are a map, a list of findings or a sentence, with nowhere to put a refusal record. So the
 * guard here is the same promise in a different shape — a malformed program yields an EMPTY
 * result and never an exception, and `describeRung` yields an honest sentence saying it cannot
 * read the rung. Analysis runs on every keystroke in the editor; a throw would take the editor
 * down over a half-finished rung, which is precisely when the operator needs it most.
 * ------------------------------------------------------------------------------------------
 */

import {
  KIND, SEVERITY, OPERAND,
  isBranch, isElement, walkElements, operandKind, operandValue, validateProgram,
} from './model.js';
import { INSTRUCTIONS, ROLE } from './instructions.js';
import { tagExists, tagInfo } from './tags.js';

/** Which check produced a lint finding, so the editor can group and filter them. */
export const CHECK = Object.freeze({
  /** From `model.validateProgram`: a claim about the document itself. */
  DOCUMENT: 'document',
  /** The same bit driven destructively more than once. */
  DUPLICATE_COIL: 'duplicate-coil',
  /** A rung the scan can never reach. */
  UNREACHABLE: 'unreachable',
  /** A rung switched off in the editor. */
  DISABLED: 'disabled',
  /** Something the top-to-bottom scan order does that the rung does not show. */
  SCAN_ORDER: 'scan-order',
});

/** How a cross-reference entry touches its tag. */
export const MODE = Object.freeze({
  /** The instruction reads the value. */
  READ: 'read',
  /** The instruction writes it — a coil, a destination, or a timer the instruction advances. */
  WRITE: 'write',
});

/**
 * The operand contract as the INSTRUCTION SET states it, in the shape `model.validateProgram`
 * wants: `{kind, min, max}` per mnemonic.
 *
 * `kind` collapses to CONTACT or COIL rather than carrying BLOCK through, because the only thing
 * the validator uses it for is "does this element condition power flow or consume it", and for
 * that question a TON is a coil and a GRT is a contact. Rendering is `model.ELEMENT_SPECS`'s job
 * and this table must never be handed to the parser, or every box in the editor would redraw as a
 * contact.
 */
const VALIDATION_SPECS = Object.freeze(buildValidationSpecs());

/**
 * Derive {@link VALIDATION_SPECS} once, at load.
 * @returns {object} mnemonic -> `{kind, min, max}`
 */
function buildValidationSpecs() {
  const out = {};
  for (const mn of Object.keys(INSTRUCTIONS)) {
    const spec = INSTRUCTIONS[mn];
    const ops = Array.isArray(spec.operands) ? spec.operands : [];
    let min = 0;
    for (const o of ops) if (!o.optional) min += 1;
    out[mn] = Object.freeze({
      kind: spec.side === 'output' ? KIND.COIL : KIND.CONTACT,
      min,
      max: ops.length,
    });
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------------------------

/**
 * The rungs of a program, or an empty list when it is not a program.
 * @param {object} prog the program
 * @returns {object[]} the rungs, each with a node list
 */
function rungsOf(prog) {
  if (!prog || !Array.isArray(prog.rungs)) return [];
  return prog.rungs.filter((r) => r && Array.isArray(r.nodes));
}

/**
 * An element's operand list, whatever state the document is in mid-edit.
 * @param {object} el the element
 * @returns {string[]} the operands
 */
function operandsOf(el) {
  return el && Array.isArray(el.operands) ? el.operands : [];
}

/**
 * The structure a dotted reference belongs to: `T.STAGE_DLY.DN` lives in `T.STAGE_DLY`.
 *
 * The cross-reference is keyed on the base, never on the member, because an engineer asking
 * "where is this timer used" must be shown the rung that examines its DN bit. The member is kept
 * on the entry so the answer can still say which bit was meant.
 *
 * @param {string} ref an operand's source text
 * @returns {string} the base tag name
 */
function baseOf(ref) {
  const parts = String(ref).split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : String(ref);
}

/**
 * The member of a dotted reference, if it addresses one.
 * @param {string} ref an operand's source text
 * @returns {string|null} `DN`, `ACC`… or null for a whole tag
 */
function memberOf(ref) {
  const parts = String(ref).split('.');
  return parts.length >= 3 ? parts.slice(2).join('.').toUpperCase() : null;
}

/**
 * A `JMP`/`LBL` operand with any quotes stripped, matching how the solver builds its label table.
 * @param {object} el the element
 * @returns {string} the label
 */
function labelOf(el) {
  const raw = String(operandsOf(el)[0] == null ? '' : operandsOf(el)[0]).trim();
  const q = raw[0];
  if ((q === '\'' || q === '"') && raw.length > 1 && raw[raw.length - 1] === q) return raw.slice(1, -1);
  return raw;
}

/**
 * Ask whatever was handed in as a tag database whether it knows a name.
 *
 * This is the reason `unresolvedTags` takes the database and `model.validateProgram` is given a
 * PREDICATE built here rather than the database itself: the document layer cannot import
 * `tags.js`, so it can only look names up in the tag map, and `T.STAGE_DLY.DN` is not in the tag
 * map — it is a member of a structure that is. Every dotted member in every stock program would
 * be reported as a missing tag. This file can import `tags.js`, so it resolves the reference
 * properly and hands the answer down.
 *
 * @param {*} db a tag database, a `Set`/array of names, or a `(name)=>boolean` predicate
 * @returns {((name:string)=>boolean)|null} a lookup, or null when there is nothing to ask
 */
export function tagLookup(db) {
  if (!db) return null;
  if (typeof db === 'function') return (n) => !!db(n);
  if (db instanceof Set) return (n) => db.has(n) || db.has(baseOf(n));
  if (Array.isArray(db)) return (n) => db.includes(n) || db.includes(baseOf(n));
  if (db.tags instanceof Map) {
    return (n) => {
      try {
        return !!tagExists(db, n);
      } catch {
        return db.tags.has(baseOf(n));
      }
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// cross reference
// ---------------------------------------------------------------------------------------------

/**
 * Every place every tag is used, keyed by the tag it belongs to.
 *
 * Disabled rungs are INCLUDED and marked. A cross-reference that hides them is a cross-reference
 * that lets an operator re-enable a rung and be surprised by what it drives; the `enabled` flag on
 * each entry is what lets the editor grey them instead.
 *
 * @param {object} prog the program
 * @returns {{byTag: Map<string, object[]>, byRung: Map<string, object[]>}} the references, each
 *   `{rungId, path, mnemonic, mode, ref, base, member, operand, enabled}`, in program order
 */
export function crossReference(prog) {
  const byTag = new Map();
  const byRung = new Map();
  for (const rung of rungsOf(prog)) {
    const here = [];
    byRung.set(rung.id, here);
    walkElements(rung, (el, path) => {
      const spec = INSTRUCTIONS[el.mnemonic];
      operandsOf(el).forEach((op, i) => {
        if (operandKind(op) !== OPERAND.TAG) return;
        const slot = spec && Array.isArray(spec.operands) ? spec.operands[i] : null;
        if (slot && slot.role === ROLE.LABEL) return;
        // An operand the instruction set does not describe — an extra one, or one belonging to a
        // mnemonic this processor has never heard of — is recorded as a READ. Guessing "write"
        // would invent a writer, and an invented writer silently changes the answer the scan-order
        // and duplicate-coil checks give.
        const write = !!slot && (slot.role === ROLE.DEST || slot.role === ROLE.STRUCT);
        const entry = {
          rungId: rung.id,
          path: path.slice(),
          mnemonic: el.mnemonic,
          mode: write ? MODE.WRITE : MODE.READ,
          ref: op,
          base: baseOf(op),
          member: memberOf(op),
          operand: i,
          enabled: rung.enabled !== false,
        };
        const list = byTag.get(entry.base);
        if (list) list.push(entry);
        else byTag.set(entry.base, [entry]);
        here.push(entry);
      });
    });
  }
  return { byTag, byRung };
}

/**
 * Every reference to one tag, whether the caller asks by base name or by member.
 * @param {{byTag: Map<string, object[]>}} xref a {@link crossReference} result
 * @param {string} name a tag name or `TAG.MEMBER`
 * @returns {object[]} the references, empty when the tag is used nowhere
 */
export function referencesTo(xref, name) {
  if (!xref || !(xref.byTag instanceof Map)) return [];
  const all = xref.byTag.get(baseOf(name)) || [];
  const member = memberOf(name);
  return member ? all.filter((e) => e.member === member) : all.slice();
}

// ---------------------------------------------------------------------------------------------
// duplicate coils
// ---------------------------------------------------------------------------------------------

/**
 * Bits driven by more than one OTE.
 *
 * Only OTE counts. OTE is DESTRUCTIVE — it writes the rung condition every scan, true or false —
 * so a second one anywhere in the program is not a second opinion, it is the only opinion: the
 * last one to scan wins and the first one appears to do nothing. A latch and an unlatch on the
 * same bit are the opposite: that is the correct way to drive a bit from two places, and flagging
 * it would train the operator to ignore this check. A MOV into a tag an OTE also drives is a
 * different fault with a different explanation, and {@link scanOrderHazards} reports that one.
 *
 * Disabled rungs are excluded, because a rung the scan skips cannot fight anything.
 *
 * @param {object} prog the program
 * @returns {Array<{tag:string, rungs:string[], count:number}>} one entry per contended bit, in the
 *   order the first coil appears; `count` is the number of coils, which may exceed `rungs.length`
 *   when one rung carries two of them
 */
export function duplicateCoils(prog) {
  /** @type {Map<string, {tag:string, rungs:string[], count:number}>} */
  const found = new Map();
  for (const rung of rungsOf(prog)) {
    if (rung.enabled === false) continue;
    walkElements(rung, (el) => {
      if (el.mnemonic !== 'OTE') return;
      const tag = operandsOf(el)[0];
      if (!tag || operandKind(tag) !== OPERAND.TAG) return;
      let rec = found.get(tag);
      if (!rec) { rec = { tag, rungs: [], count: 0 }; found.set(tag, rec); }
      rec.count += 1;
      if (rec.rungs[rec.rungs.length - 1] !== rung.id) rec.rungs.push(rung.id);
    });
  }
  const out = [];
  for (const rec of found.values()) if (rec.count > 1) out.push(rec);
  return out;
}

// ---------------------------------------------------------------------------------------------
// unresolved tags
// ---------------------------------------------------------------------------------------------

/**
 * Every tag reference the database cannot resolve, in the order an operator meets them.
 *
 * References are returned AS WRITTEN, member and all, because `T.STAGE_DLY.ACC` and a misspelt
 * `T.STAGE_DELAY` are different mistakes and the operator has to be shown the text to fix.
 *
 * @param {object} prog the program
 * @param {*} db a tag database, a `Set`/array of names, or a `(name)=>boolean` predicate
 * @returns {string[]} the unresolved references, deduplicated
 */
export function unresolvedTags(prog, db) {
  const known = tagLookup(db);
  if (!known) return [];
  const seen = new Set();
  const out = [];
  for (const rung of rungsOf(prog)) {
    walkElements(rung, (el) => {
      const spec = INSTRUCTIONS[el.mnemonic];
      operandsOf(el).forEach((op, i) => {
        if (operandKind(op) !== OPERAND.TAG) return;
        const slot = spec && Array.isArray(spec.operands) ? spec.operands[i] : null;
        if (slot && slot.role === ROLE.LABEL) return;
        if (seen.has(op)) return;
        seen.add(op);
        if (!known(op)) out.push(op);
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Whether an element always passes power on, whatever the plant is doing.
 *
 * Kept deliberately small: a label, a no-op, and an examine of the processor's own always-on bit.
 * Anything else is treated as conditional, because the cost of being wrong in that direction is
 * one missing finding, and the cost of being wrong in the other is telling an operator that a
 * live rung is dead.
 *
 * @param {object} node a node
 * @returns {boolean} whether power reaches whatever is to its right unconditionally
 */
function alwaysPasses(node) {
  if (!isElement(node)) return false;
  if (node.mnemonic === 'LBL' || node.mnemonic === 'NOP') return true;
  return node.mnemonic === 'XIC' && operandsOf(node)[0] === 'S.ALWAYS_ON';
}

/**
 * The label of a jump this rung takes every scan it is reached, or null when it has none.
 *
 * Only a TOP-LEVEL jump with nothing conditional to its left counts. A JMP inside a branch, or one
 * with a contact in front of it, is conditional, and rungs below a conditional jump are perfectly
 * reachable.
 *
 * @param {object} rung the rung
 * @returns {string|null} the label
 */
function unconditionalJumpOf(rung) {
  for (const node of rung.nodes) {
    if (isElement(node) && node.mnemonic === 'JMP') return labelOf(node);
    if (!alwaysPasses(node)) return null;
  }
  return null;
}

/**
 * The rungs the scan never reaches: the ones switched off in the editor, and the ones an
 * unconditional jump steps over.
 *
 * The label table is built over EVERY rung, disabled ones included, because that is what the
 * solver does — a jump lands on a rung index, and a disabled rung at that index simply falls
 * through to the one below rather than redirecting the jump somewhere else.
 *
 * @param {object} prog the program
 * @returns {string[]} the rung ids, in program order
 */
export function unreachableRungs(prog) {
  const rungs = rungsOf(prog);
  const labels = new Map();
  rungs.forEach((rung, i) => {
    walkElements(rung, (el) => {
      if (el.mnemonic !== 'LBL') return;
      const name = labelOf(el);
      if (name && !labels.has(name)) labels.set(name, i);
    });
  });

  const hasLabel = rungs.map((rung) => {
    let found = false;
    walkElements(rung, (el) => { if (el.mnemonic === 'LBL') found = true; });
    return found;
  });

  const skipped = new Array(rungs.length).fill(false);
  for (let i = 0; i < rungs.length; i += 1) {
    if (skipped[i] || rungs[i].enabled === false) continue;
    const label = unconditionalJumpOf(rungs[i]);
    if (label === null) continue;
    const target = labels.get(label);
    if (target === undefined) continue;
    if (target > i) {
      // Everything between the jump and its label, except a rung carrying a label of its own —
      // some other jump may land there.
      for (let k = i + 1; k < target; k += 1) if (!hasLabel[k]) skipped[k] = true;
    } else {
      // A jump backwards to a label above it never comes back. Everything below it is dead, and
      // the watchdog is what ends the scan; `scanOrderHazards` says so in as many words.
      for (let k = i + 1; k < rungs.length; k += 1) skipped[k] = true;
    }
  }

  const out = [];
  rungs.forEach((rung, i) => {
    if (rung.enabled === false || skipped[i]) out.push(rung.id);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// scan-order hazards
// ---------------------------------------------------------------------------------------------

/**
 * The faults that live in the ORDER of the rungs rather than in any one of them.
 *
 * Everything here is invisible on the rung an operator is looking at, which is exactly why it has
 * to be reported: the rung is correct, and the program still does not work.
 *
 * @param {object} prog the program
 * @returns {Array<{message:string, rungId:string|null, severity:string, tag:string|null}>} the
 *   hazards, in program order
 */
export function scanOrderHazards(prog) {
  const rungs = rungsOf(prog);
  const out = [];
  const order = new Map();
  rungs.forEach((rung, i) => order.set(rung.id, i));

  /**
   * Record a hazard.
   * @param {string|null} rungId where to point the operator
   * @param {string} severity one of {@link SEVERITY}
   * @param {string|null} tag the tag it concerns, for grouping in the editor
   * @param {string} message a sentence an operator could read
   * @returns {void}
   */
  function say(rungId, severity, tag, message) {
    out.push({ message, rungId, severity, tag });
  }

  // --- a bit used before the rung that makes it -------------------------------------------
  const xref = crossReference(prog);
  for (const [tag, entries] of xref.byTag) {
    const live = entries.filter((e) => e.enabled);
    if (live.length === 0) continue;
    // The input image is written by the input scan before rung one, so reading it early is
    // correct, not a hazard. `model.validateProgram` already objects to a coil driving one.
    if (/^[IS]\./.test(tag)) continue;
    let firstRead = -1;
    let firstWrite = -1;
    for (const e of live) {
      const at = order.get(e.rungId);
      if (at === undefined) continue;
      if (e.mode === MODE.READ && (firstRead < 0 || at < firstRead)) firstRead = at;
      if (e.mode === MODE.WRITE && (firstWrite < 0 || at < firstWrite)) firstWrite = at;
    }
    if (firstRead < 0 || firstWrite < 0 || firstRead >= firstWrite) continue;
    say(rungs[firstRead].id, SEVERITY.WARNING, tag,
      `${tag} is read on rung ${firstRead + 1} but not written until rung ${firstWrite + 1}, so it`
      + ' carries last scan\'s value there — one scan of lag, and a stale one after a program'
      + ' change');
  }

  // --- more than one writer -----------------------------------------------------------------
  for (const [tag, entries] of xref.byTag) {
    const writers = entries.filter((e) => e.enabled && e.mode === MODE.WRITE
      && e.mnemonic !== 'OTL' && e.mnemonic !== 'OTU' && e.mnemonic !== 'RES');
    const ids = [];
    for (const w of writers) if (!ids.includes(w.rungId)) ids.push(w.rungId);
    if (ids.length < 2) continue;
    const mnemonics = [];
    for (const w of writers) if (!mnemonics.includes(w.mnemonic)) mnemonics.push(w.mnemonic);
    // Two OTEs are a duplicate coil and are reported as one; this is for the mixed case, which
    // reads as two working rungs and is the harder one to see.
    if (mnemonics.length === 1 && mnemonics[0] === 'OTE') continue;
    const isStruct = /^[TC]\./.test(tag);
    say(ids[ids.length - 1], SEVERITY.WARNING, tag,
      isStruct
        ? `${tag} is driven by ${mnemonics.join(' and ')} on rungs ${ids.join(', ')}; one structure`
          + ' cannot be two timers, and the two instructions will fight over its accumulator'
        : `${tag} is written by ${mnemonics.join(' and ')} on rungs ${ids.join(', ')}; the last one`
          + ' to scan wins and the others never appear to work');
  }

  // --- latches nothing clears ----------------------------------------------------------------
  for (const [tag, entries] of xref.byTag) {
    const latch = entries.find((e) => e.enabled && e.mnemonic === 'OTL');
    if (!latch) continue;
    if (entries.some((e) => e.enabled && e.mnemonic === 'OTU')) continue;
    say(latch.rungId, SEVERITY.WARNING, tag,
      `${tag} is latched on and nothing in this program ever unlatches it, so once it is set it`
      + ' stands until the processor is stopped');
  }

  // --- retentive timers nothing resets --------------------------------------------------------
  for (const [tag, entries] of xref.byTag) {
    const rto = entries.find((e) => e.enabled && e.mnemonic === 'RTO');
    if (!rto) continue;
    if (entries.some((e) => e.enabled && e.mnemonic === 'RES')) continue;
    say(rto.rungId, SEVERITY.WARNING, tag,
      `${tag} is a retentive timer and no RES ever resets it, so it reaches its preset once and`
      + ' stays done for ever');
  }

  // --- a jump that never comes back ------------------------------------------------------------
  const labels = new Map();
  rungs.forEach((rung, i) => {
    walkElements(rung, (el) => {
      if (el.mnemonic !== 'LBL') return;
      const name = labelOf(el);
      if (name && !labels.has(name)) labels.set(name, i);
    });
  });
  rungs.forEach((rung, i) => {
    if (rung.enabled === false) return;
    const label = unconditionalJumpOf(rung);
    if (label === null) return;
    const target = labels.get(label);
    if (target === undefined) return;
    if (target <= i) {
      say(rung.id, SEVERITY.ERROR, null,
        `rung ${i + 1} jumps back to LBL ${label} on rung ${target + 1} every scan and nothing can`
        + ' break the loop, so the scan never reaches the end of the program and the watchdog will'
        + ' fault the processor');
    }
  });

  out.sort((a, b) => (order.get(a.rungId) || 0) - (order.get(b.rungId) || 0));
  return out;
}

// ---------------------------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------------------------

/**
 * The numbers for the status bar.
 *
 * `timers` and `counters` count the distinct STRUCTURES the program uses rather than the
 * instructions that drive them, because that is the number that matters when the question is "how
 * much of the processor is this program using" — and because two instructions on one timer is a
 * fault, not two timers.
 *
 * @param {object} prog the program
 * @returns {{rungs:number, disabledRungs:number, elements:number, contacts:number, coils:number,
 *   blocks:number, unknown:number, branches:number, timers:number, counters:number,
 *   tagsUsed:number}} the counts
 */
export function programStats(prog) {
  const stats = {
    rungs: 0,
    disabledRungs: 0,
    elements: 0,
    contacts: 0,
    coils: 0,
    blocks: 0,
    unknown: 0,
    branches: 0,
    timers: 0,
    counters: 0,
    tagsUsed: 0,
  };
  const timers = new Set();
  const counters = new Set();
  const tags = new Set();

  for (const rung of rungsOf(prog)) {
    stats.rungs += 1;
    if (rung.enabled === false) stats.disabledRungs += 1;
    const seen = new Set();
    walkElements(rung, (el, path) => {
      stats.elements += 1;
      // Every branch is the parent of at least one element, so counting the distinct branch paths
      // met on the way down counts each branch exactly once without a second walk.
      for (let d = 1; d < path.length; d += 2) {
        const key = path.slice(0, d).join('.');
        if (!seen.has(key)) { seen.add(key); stats.branches += 1; }
      }
      const spec = INSTRUCTIONS[el.mnemonic];
      if (!spec) stats.unknown += 1;
      else if (spec.kind === KIND.CONTACT) stats.contacts += 1;
      else if (spec.kind === KIND.COIL) stats.coils += 1;
      else stats.blocks += 1;
      operandsOf(el).forEach((op, i) => {
        if (operandKind(op) !== OPERAND.TAG) return;
        const slot = spec && Array.isArray(spec.operands) ? spec.operands[i] : null;
        if (slot && slot.role === ROLE.LABEL) return;
        tags.add(baseOf(op));
        if (!slot || slot.role !== ROLE.STRUCT) return;
        if (spec.category === 'timer') timers.add(baseOf(op));
        if (spec.category === 'counter') counters.add(baseOf(op));
      });
    });
  }

  stats.timers = timers.size;
  stats.counters = counters.size;
  stats.tagsUsed = tags.size;
  return stats;
}

// ---------------------------------------------------------------------------------------------
// plain English
// ---------------------------------------------------------------------------------------------

/**
 * Words that mean something in this plant, for tags the phrasebook does not name outright.
 *
 * The fallback path exists because a program is editable: the operator will invent `M.MY_FLAG`
 * five minutes after opening the editor, and a summary that gives up on it is a summary nobody
 * trusts. Expanding the abbreviations gets most of the way, and where it does not the raw name
 * survives, which is honest.
 */
const WORDS = Object.freeze({
  P1: 'P-101', P2: 'P-102', PIC: 'PIC-101',
  ALM: 'alarm', ACK: 'acknowledge', PB: 'pushbutton', DLY: 'delay', SEQ: 'sequence',
  SP: 'setpoint', PV: 'measurement', CO: 'output', ERR: 'error', HDR: 'header', REC: 'recipe',
  MINQ: 'minimum flow', MINFLOW: 'minimum flow', RECIRC: 'recirculation', CAV: 'cavitation',
  NPSH: 'suction margin', THERM: 'motor overload', TCAS: 'casing temperature',
  TCASE: 'casing temperature', VIB: 'vibration', DEV: 'deviation', SAT: 'saturation',
  AVAIL: 'available', RUN: 'running', CMD: 'command', POS: 'position', HRS: 'run hours',
  HOURS: 'run hours', STARTS: 'starts', KW: 'power', KWH: 'energy', MAN: 'manual',
  HH: 'high high', LL: 'low low', HI: 'high', LO: 'low', DN: 'down', UP: 'up', PCT: 'percent',
  MINRUN: 'minimum run', MINSTOP: 'minimum stop', FLT: 'fault', OK: 'healthy', REQ: 'request',
});

/**
 * The rig's own tags, said the way an engineer says them.
 *
 * Each entry may carry `noun` (what to call it), `on` and `off` (whole fragments for an examine of
 * the bit, so that XIC reads "P-101 is running" rather than "P-101 running is on"), and `act`
 * (what energising it DOES, so that OTE reads "start P-102" rather than "energise Q.P2_START").
 * That is the difference between a summary an operator reads and one they skip.
 */
const TAG_PHRASES = Object.freeze(buildTagPhrases());

/**
 * Build {@link TAG_PHRASES}, generating the two pumps from one description so the pair cannot
 * drift apart in a hand-typed table.
 * @returns {object} tag name -> `{noun?, on?, off?, act?}`
 */
function buildTagPhrases() {
  const out = {};
  for (const n of [1, 2]) {
    const P = `P-10${n}`;
    Object.assign(out, {
      [`I.P${n}_RUN`]: { noun: P, on: `${P} is running`, off: `${P} is stopped` },
      [`I.P${n}_CALLED`]: { noun: `the ${P} call`, on: `${P} has been called`, off: `${P} has not been called` },
      [`I.P${n}_AVAIL`]: { noun: `${P} availability`, on: `${P} is available`, off: `${P} is not available` },
      [`I.P${n}_FAULT`]: { noun: `the ${P} trip`, on: `${P} has tripped`, off: `${P} has not tripped` },
      [`I.P${n}_AUTO`]: { noun: `the ${P} selector`, on: `${P} is in auto`, off: `${P} is not in auto` },
      [`I.P${n}_CAV`]: { noun: `${P} cavitation`, on: `${P} is cavitating`, off: `${P} is not cavitating` },
      [`I.P${n}_MINFLOW`]: { noun: `the ${P} minimum-flow bit`, on: `${P} is below minimum flow`, off: `${P} is above minimum flow` },
      [`I.P${n}_CHECK_SHUT`]: { noun: `the ${P} check valve`, on: `the ${P} check valve is shut`, off: `the ${P} check valve is open` },
      [`I.P${n}_SPEED`]: { noun: `the ${P} speed` },
      [`I.P${n}_CURRENT`]: { noun: `the ${P} current` },
      [`I.P${n}_POWER`]: { noun: `the ${P} power` },
      [`I.P${n}_FLOW`]: { noun: `the ${P} flow` },
      [`I.P${n}_HOURS`]: { noun: `the ${P} run hours` },
      [`I.P${n}_STARTS`]: { noun: `the ${P} start count` },
      [`I.P${n}_NPSH_M`]: { noun: `the ${P} suction margin` },
      [`I.ALM_P${n}_TRIP`]: { noun: `the ${P} trip alarm`, on: `${P} is tripped`, off: `${P} is not tripped` },
      [`Q.P${n}_START`]: { noun: `the ${P} start command`, on: `${P} is called to start`, off: `${P} is not called to start`, act: `start ${P}` },
      [`Q.P${n}_STOP`]: { noun: `the ${P} stop command`, act: `stop ${P}` },
      [`Q.P${n}_AUTO`]: { noun: `the ${P} auto command`, act: `put ${P} in auto` },
      [`Q.P${n}_RESET`]: { noun: `the ${P} reset`, act: `reset the ${P} overload` },
      [`Q.LAMP_P${n}`]: { noun: `the ${P} lamp`, act: `light the ${P} running lamp` },
    });
  }
  Object.assign(out, {
    'I.PT101': { noun: 'the header pressure' },
    'I.PT102': { noun: 'the suction pressure' },
    'I.FT101': { noun: 'the flow to process' },
    'I.FT102': { noun: 'the discharge flow' },
    'I.FT103': { noun: 'the recirculation flow' },
    'I.LT101': { noun: 'the suction tank level' },
    'I.TT101': { noun: 'the tank temperature' },
    'I.PIC_PV': { noun: 'the loop measurement' },
    'I.PIC_SP': { noun: 'the setpoint' },
    'I.PIC_CO': { noun: 'the controller output' },
    'I.PIC_ERR': { noun: 'the loop error' },
    'I.PIC_AUTO': { noun: 'the loop auto bit', on: 'the loop is in automatic', off: 'the loop is not in automatic' },
    'I.PIC_SAT': { noun: 'the output saturation bit', on: 'the controller output is pinned at a limit', off: 'the controller output is off its limits' },
    'I.SEQ_ENABLED': { noun: 'the sequence enable', on: 'the built-in sequence is enabled', off: 'the built-in sequence is off' },
    'I.SEQ_LEAD': { noun: 'the lead machine' },
    'I.SEQ_RUNNING': { noun: 'the number of machines running' },
    'I.SEQ_SLEEPING': { noun: 'the sleep bit', on: 'the set is asleep', off: 'the set is awake' },
    'I.SEQ_STARTS_H': { noun: 'the starts per hour' },
    'I.ALM_ANY': { noun: 'the alarm summary', on: 'something is in alarm', off: 'nothing is in alarm' },
    'I.ALM_CRITICAL': { noun: 'the critical alarm summary', on: 'a critical alarm is standing', off: 'no critical alarm is standing' },
    'I.ALM_UNACK': { noun: 'the unacknowledged alarm count' },
    'I.ALM_PT_HI': { noun: 'the header pressure high alarm', on: 'the header pressure is high', off: 'the header pressure is not high' },
    'I.ALM_PT_LO': { noun: 'the header pressure low alarm', on: 'the header pressure is low', off: 'the header pressure is not low' },
    'I.ALM_LT_LO': { noun: 'the tank level low alarm', on: 'the tank level is low', off: 'the tank level is not low' },
    'I.ALM_LT_LL': { noun: 'the tank level low low alarm', on: 'the tank is nearly empty', off: 'the tank is not nearly empty' },
    'I.RUN_TIME': { noun: 'the run clock' },
    'I.KW_TOTAL': { noun: 'the skid power' },
    'I.KWH_PER_M3': { noun: 'the specific energy' },
    'Q.PIC_SP': { noun: 'the controller setpoint', act: 'hold the controller setpoint on' },
    'Q.PIC_AUTO': { noun: 'the loop auto command', act: 'put the loop in automatic' },
    'Q.PIC_MAN_CO': { noun: 'the manual output' },
    'Q.SEQ_ENABLE': { noun: 'the sequence enable command', act: 'enable the built-in staging sequence' },
    'Q.SEQ_LEAD': { noun: 'the duty selection' },
    'Q.ALARM_ACK': { noun: 'the alarm acknowledge', act: 'acknowledge the alarms' },
    'Q.HORN': { noun: 'the horn', act: 'sound the horn' },
    'Q.LAMP_ALARM': { noun: 'the alarm lamp', act: 'light the alarm lamp' },
    'Q.LAMP_WARN': { noun: 'the warning lamp', act: 'light the warning lamp' },
    'Q.RECIRC_POS': { noun: 'the recirculation valve command' },
    'Q.FCV101_CMD': { noun: 'the demand valve command' },
    'Q.REC_STEP': { noun: 'the recipe step number' },
    'Q.REC_HOLD': { noun: 'the recipe hold', act: 'hold the recipe' },
    'REC.STEP': { noun: 'the recipe step' },
    'REC.STEP_DN': { noun: 'the step complete bit', on: 'the recipe step is complete', off: 'the recipe step is not complete' },
    'REC.HOLD': { noun: 'the recipe hold', on: 'the recipe is held', off: 'the recipe is running' },
    'REC.SP': { noun: 'the recipe setpoint' },
    'S.ALWAYS_ON': { noun: 'the always-on bit', on: 'always', off: 'never' },
    'S.FIRST_SCAN': { noun: 'the first scan bit', on: 'this is the first scan', off: 'this is not the first scan' },
  });
  return Object.freeze(out);
}

/**
 * Expand a tag name into words: `T.STAGE_DLY` becomes "stage delay".
 * @param {string} base a tag name without its member
 * @returns {string} the expanded words
 */
function wordsOf(base) {
  const body = String(base).includes('.') ? String(base).split('.').slice(1).join('_') : String(base);
  return body.split('_').filter((w) => w !== '').map((w) => {
    const up = w.toUpperCase();
    if (WORDS[up]) return WORDS[up];
    // An instrument tag — PT101, FCV101 — reads as PT-101 the way it is stencilled on the pipe.
    const m = /^([A-Z]{2,4})(\d{3})$/.exec(up);
    if (m) return `${m[1]}-${m[2]}`;
    return up.length <= 3 ? up : up.toLowerCase();
  }).join(' ');
}

/**
 * A duration an operator would say out loud. Presets are milliseconds everywhere in this
 * processor, and "8000 ms" is not how anybody describes a stage-up delay.
 * @param {number} ms the preset, milliseconds
 * @returns {string} the duration
 */
function durationText(ms) {
  if (!Number.isFinite(ms)) return 'its preset';
  const round = (x) => String(Number(x.toFixed(2)));
  if (Math.abs(ms) >= 120000) return `${round(ms / 60000)} min`;
  if (Math.abs(ms) >= 1000) return `${round(ms / 1000)} s`;
  return `${round(ms)} ms`;
}

/**
 * The phrasebook entry for a tag, or an empty record.
 * @param {string} base the base tag name
 * @returns {object} `{noun?, on?, off?, act?}`
 */
function phraseOf(base) {
  return TAG_PHRASES[base] || {};
}

/**
 * A short noun for a tag the phrasebook does not name, taken from its description in the database.
 *
 * Only the leading clause is used, and only when it is short: descriptions in this repo open with
 * the name of the thing and then explain it, so the first clause is a noun phrase and everything
 * after the dash is a paragraph nobody wants in the middle of a sentence.
 *
 * @param {*} db a tag database, or nothing
 * @param {string} base the base tag name
 * @returns {string|null} the noun, or null
 */
function nounFromDb(db, base) {
  if (!db || !(db.tags instanceof Map)) return null;
  let info = null;
  try { info = tagInfo(db, base); } catch { info = null; }
  if (!info || typeof info.desc !== 'string' || info.desc === '') return null;
  const head = info.desc.split(/\s+[—-]\s+|,/)[0].trim();
  return head !== '' && head.length <= 48 ? head : null;
}

/**
 * What to call a tag inside a sentence.
 * @param {string} ref the operand as written, member and all
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the noun phrase
 */
export function tagNoun(ref, ctx) {
  const base = baseOf(ref);
  const member = memberOf(ref);
  const named = phraseOf(base).noun || nounFromDb(ctx && ctx.db, base);
  const plain = named || defaultNoun(base, ctx);
  if (!member) return plain;
  if (member === 'ACC') return `the count in ${plain}`;
  if (member === 'PRE') return `the preset of ${plain}`;
  return plain;
}

/**
 * The last-resort noun, built out of the name itself.
 * @param {string} base the base tag name
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the noun phrase
 */
function defaultNoun(base, ctx) {
  const words = wordsOf(base);
  if (/^T\./.test(base)) return `the ${timerLabel(base, ctx)}`;
  if (/^C\./.test(base)) return `the ${words} counter`;
  return `the ${words}`;
}

/**
 * A timer's name with its preset in it, which is how an engineer refers to one: not "the stage
 * delay timer" but "the 8 s stage delay timer". Presets come from the TON/TOF/RTO that drives the
 * timer, so the summary of the rung that only EXAMINES the timer still says how long it waits.
 * @param {string} base the timer's tag name
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the label, without a leading article
 */
function timerLabel(base, ctx) {
  const words = wordsOf(base);
  const pre = ctx && ctx.presets ? ctx.presets.get(base) : undefined;
  return Number.isFinite(pre) ? `${durationText(pre)} ${words} timer` : `${words} timer`;
}

/**
 * Render one operand inside an instruction template.
 * @param {object} el the element
 * @param {number} i the operand index
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the rendered operand
 */
function operandText(el, i, ctx) {
  const op = operandsOf(el)[i];
  if (op === undefined) return 'nothing';
  const kind = operandKind(op);
  if (kind === OPERAND.TAG) return tagNoun(op, ctx);
  if (kind === OPERAND.STRING) return `'${operandValue(op)}'`;
  if (kind === OPERAND.NUMBER) {
    const spec = INSTRUCTIONS[el.mnemonic];
    const slot = spec && Array.isArray(spec.operands) ? spec.operands[i] : null;
    if (slot && /\bms\b/.test(slot.name)) return durationText(Number(operandValue(op)));
    return String(operandValue(op));
  }
  return String(op);
}

/**
 * Fill an instruction's one-line template from its operands.
 * @param {object} el the element
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the phrase
 */
function fillTemplate(el, ctx) {
  const spec = INSTRUCTIONS[el.mnemonic];
  if (!spec || typeof spec.template !== 'string') {
    // An instruction this processor does not know. Printing the element as it is written is the
    // honest answer: inventing a description for a mnemonic nobody can execute would be worse
    // than useless in the one place an operator is trying to work out what went wrong.
    const ops = operandsOf(el).join(', ');
    return ops === '' ? el.mnemonic : `${el.mnemonic}(${ops})`;
  }
  return spec.template.replace(/\$(\d)/g, (_, d) => operandText(el, Number(d), ctx));
}

/**
 * The fragment for examining a bit, in the sense the rung asks for it.
 * @param {string} ref the operand as written
 * @param {boolean} want true for XIC, false for XIO
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the phrase
 */
function bitText(ref, want, ctx) {
  const base = baseOf(ref);
  const member = memberOf(ref);
  if (member) {
    const isTimer = /^T\./.test(base);
    const label = isTimer ? `the ${timerLabel(base, ctx)}` : tagNoun(base, ctx);
    if (member === 'DN') {
      return isTimer
        ? `${label} ${want ? 'has timed out' : 'has not timed out'}`
        : `${label} ${want ? 'has reached its preset' : 'has not reached its preset'}`;
    }
    if (member === 'TT') return `${label} ${want ? 'is timing' : 'is not timing'}`;
    if (member === 'EN') return `${label} ${want ? 'is enabled' : 'is not enabled'}`;
  }
  const phrase = phraseOf(base);
  if (want && phrase.on) return phrase.on;
  if (!want && phrase.off) return phrase.off;
  return `${tagNoun(ref, ctx)} is ${want ? 'on' : 'off'}`;
}

/**
 * The fragment for one element, in the role the rung gives it.
 * @param {object} el the element
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the phrase
 */
function elementText(el, ctx) {
  const ops = operandsOf(el);
  const first = ops[0];
  switch (el.mnemonic) {
    case 'XIC': return bitText(first, true, ctx);
    case 'XIO': return bitText(first, false, ctx);
    case 'ONS': return 'just as that becomes true';
    case 'OTE': return phraseOf(baseOf(first || '')).act || `energise ${tagNoun(first, ctx)}`;
    case 'OTL': return `latch ${tagNoun(first, ctx)} on`;
    case 'OTU': return `unlatch ${tagNoun(first, ctx)}`;
    case 'TON': return `run ${tagNoun(first, ctx)} for ${presetText(el, ctx)}`;
    case 'TOF': return `hold ${tagNoun(first, ctx)} on for ${presetText(el, ctx)} after power is lost`;
    case 'RTO': return `accumulate ${tagNoun(first, ctx)} toward ${presetText(el, ctx)}`;
    case 'RES': return `reset ${tagNoun(first, ctx)}`;
    case 'CTU': return `count ${tagNoun(first, ctx)} up to ${countText(el, ctx)}`;
    case 'CTD': return `count ${tagNoun(first, ctx)} down toward ${countText(el, ctx)}`;
    case 'JMP': return `jump to ${labelOf(el)}`;
    case 'LBL': return `labelled ${labelOf(el)}`;
    default: return fillTemplate(el, ctx);
  }
}

/**
 * A timer instruction's preset, said as a duration, from the operand or from the timer itself.
 * @param {object} el the timer element
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the duration
 */
function presetText(el, ctx) {
  const op = operandsOf(el)[1];
  if (op !== undefined && operandKind(op) === OPERAND.NUMBER) return durationText(Number(operandValue(op)));
  const pre = ctx && ctx.presets ? ctx.presets.get(baseOf(operandsOf(el)[0] || '')) : undefined;
  return Number.isFinite(pre) ? durationText(pre) : 'its preset';
}

/**
 * A counter instruction's preset.
 * @param {object} el the counter element
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string} the count
 */
function countText(el, ctx) {
  const op = operandsOf(el)[1];
  if (op === undefined) return 'its preset';
  return operandKind(op) === OPERAND.NUMBER ? String(operandValue(op)) : tagNoun(op, ctx);
}

/**
 * Which side of the rung a node belongs to.
 * @param {object} node an element or a branch
 * @returns {string} `'input'`, `'output'`, or `'mixed'` for a branch that holds both
 */
function sideOfNode(node) {
  if (isElement(node)) {
    const spec = INSTRUCTIONS[node.mnemonic];
    return spec && spec.side === 'output' ? 'output' : 'input';
  }
  if (!isBranch(node)) return 'input';
  let side = null;
  for (const leg of node.legs) {
    for (const inner of leg) {
      const s = sideOfNode(inner);
      if (s === 'mixed') return 'mixed';
      if (side === null) side = s;
      else if (side !== s) return 'mixed';
    }
  }
  return side || 'input';
}

/**
 * Whether a node is, or contains, an AFI.
 * @param {object} node an element or a branch
 * @returns {boolean} whether the rung is inhibited by it
 */
function isInhibit(node) {
  return isElement(node) && node.mnemonic === 'AFI';
}

/**
 * Describe a series list of input nodes as a condition.
 * @param {object[]} list the series list
 * @param {object} ctx describe context `{presets, db}`
 * @returns {{text:string, group:boolean}|null} the condition, or null when it conditions nothing
 */
function conditionOf(list, ctx) {
  const parts = [];
  for (const node of list) {
    const part = isBranch(node) ? branchCondition(node, ctx) : { text: elementText(node, ctx), group: false };
    if (part) parts.push(part);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { text: joinConditions(parts), group: false };
}

/**
 * Describe a branch of input nodes: legs are alternatives, so they are joined with "or".
 *
 * A branch with an EMPTY leg is dropped entirely and returns null. An empty leg is a wire across
 * the branch — power always gets past it — so the branch conditions nothing at all, and saying
 * "the start button is on or nothing" would describe a rung that does not exist.
 *
 * @param {object} branch the branch node
 * @param {object} ctx describe context `{presets, db}`
 * @returns {{text:string, group:boolean}|null} the condition, or null when the branch is shorted
 */
function branchCondition(branch, ctx) {
  const legs = [];
  for (const leg of branch.legs) {
    if (leg.length === 0) return null;
    const part = conditionOf(leg, ctx);
    if (!part) return null;
    legs.push(part.text);
  }
  if (legs.length === 0) return null;
  if (legs.length === 1) return { text: legs[0], group: false };
  return { text: legs.join(' or '), group: true };
}

/**
 * Join conditions with "and", bracketing any "or" group so the sense cannot be misread.
 * @param {Array<{text:string, group:boolean}>} parts the conditions
 * @returns {string} the joined text
 */
function joinConditions(parts) {
  if (parts.length === 1) return parts[0].text;
  return parts.map((p) => (p.group ? `(${p.text})` : p.text)).join(' and ');
}

/**
 * Every output phrase a node contributes. Parallel outputs in a branch are simply several
 * outputs, so the legs are flattened rather than joined with "or".
 * @param {object} node an element or a branch
 * @param {object} ctx describe context `{presets, db}`
 * @returns {string[]} the phrases
 */
function actionsOf(node, ctx) {
  if (isElement(node)) return [elementText(node, ctx)];
  if (!isBranch(node)) return [];
  const out = [];
  for (const leg of node.legs) for (const inner of leg) out.push(...actionsOf(inner, ctx));
  return out;
}

/**
 * Every timer and counter preset the program states, keyed by structure.
 *
 * `describeRung` builds this for the rung it is given, which is enough for the rung that STARTS
 * the timer; pass the whole-program map in `opts.presets` and the rung that only examines
 * `T.STAGE_DLY.DN` can say how long the wait is too.
 *
 * @param {object} prog the program
 * @returns {Map<string, number>} structure tag -> preset, in the instruction's own units
 */
export function timerPresets(prog) {
  const out = new Map();
  for (const rung of rungsOf(prog)) collectPresets(rung, out);
  return out;
}

/**
 * Gather the presets stated on one rung.
 * @param {object} rung the rung
 * @param {Map<string, number>} into the map to fill
 * @returns {void}
 */
function collectPresets(rung, into) {
  walkElements(rung, (el) => {
    if (!['TON', 'TOF', 'RTO', 'CTU', 'CTD'].includes(el.mnemonic)) return;
    const struct = operandsOf(el)[0];
    const pre = operandsOf(el)[1];
    if (!struct || pre === undefined || operandKind(pre) !== OPERAND.NUMBER) return;
    const key = baseOf(struct);
    if (!into.has(key)) into.set(key, Number(operandValue(pre)));
  });
}

/**
 * Finish a sentence: a capital at the front and a full stop at the back.
 * @param {string} s the body
 * @returns {string} the sentence
 */
function sentence(s) {
  const body = s.trim();
  if (body === '') return '';
  const head = body[0].toUpperCase() + body.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/**
 * One line of plain English saying what a rung does.
 *
 * The shape is always the same, because an operator scanning forty of these should not have to
 * parse a new sentence structure each time: conditions, then what happens. Series is "and",
 * branches are "or", XIO is "not", and a timer is named by how long it waits.
 *
 * It degrades rather than guesses. A rung whose branches mix conditions with outputs is described
 * by its shape and no further; an instruction the processor does not know is printed as it is
 * written. Confident nonsense about a rung is worse than an admission, because the whole value of
 * this line is that it can be trusted without checking it against the ladder.
 *
 * @param {object} rung the rung
 * @param {object} [opts] options
 * @param {Map<string, number>} [opts.presets] whole-program presets from {@link timerPresets}
 * @param {object} [opts.db] a tag database, for the descriptions of tags the phrasebook has never
 *   heard of
 * @returns {string} one sentence
 */
export function describeRung(rung, opts) {
  if (!rung || !Array.isArray(rung.nodes)) return 'This is not a rung.';
  const presets = new Map(opts && opts.presets instanceof Map ? opts.presets : []);
  collectPresets(rung, presets);
  const ctx = { presets, db: (opts && opts.db) || null };
  const lead = rung.enabled === false ? 'disabled — ' : '';

  if (rung.nodes.length === 0) return sentence(`${lead}this rung is empty and does nothing`);

  const labels = [];
  const nodes = [];
  for (const node of rung.nodes) {
    if (isElement(node) && node.mnemonic === 'LBL') { labels.push(labelOf(node)); continue; }
    if (isElement(node) && node.mnemonic === 'NOP') continue;
    nodes.push(node);
  }
  const labelled = labels.length > 0 ? `labelled ${labels.join(' and ')} — ` : '';

  if (nodes.some((n) => isInhibit(n))) {
    return sentence(`${lead}${labelled}this rung is inhibited by AFI and never energises anything`);
  }
  if (nodes.some((n) => sideOfNode(n) === 'mixed')) {
    return sentence(`${lead}${labelled}${shapeOf(rung)}, and the conditions and outputs are mixed`
      + ' together inside a branch, which this summary cannot put into words — read the rung');
  }

  const clauses = [];
  let conds = [];
  let i = 0;
  while (i < nodes.length) {
    if (sideOfNode(nodes[i]) === 'input') {
      const part = isBranch(nodes[i])
        ? branchCondition(nodes[i], ctx)
        : { text: elementText(nodes[i], ctx), group: false };
      if (part) conds.push(part);
      i += 1;
      continue;
    }
    const acts = [];
    while (i < nodes.length && sideOfNode(nodes[i]) === 'output') {
      acts.push(...actionsOf(nodes[i], ctx));
      i += 1;
    }
    clauses.push({ conds, acts });
    conds = [];
  }

  if (clauses.length === 0) {
    return sentence(`${lead}${labelled}${joinConditions(conds)} — but this rung drives no output,`
      + ' so nothing happens');
  }

  const said = clauses.map((c) => (c.conds.length === 0
    ? `always ${c.acts.join(' and ')}`
    : `if ${joinConditions(c.conds)}, ${c.acts.join(' and ')}`));
  const trailing = conds.length > 0
    ? '; the contacts after the last output condition nothing'
    : '';
  return sentence(`${lead}${labelled}${said.join('; then ')}${trailing}`);
}

/**
 * A rung described by its shape alone, for when its logic is beyond this summary.
 * @param {object} rung the rung
 * @returns {string} the description, without a leading capital or a full stop
 */
function shapeOf(rung) {
  let elements = 0;
  let outputs = 0;
  walkElements(rung, (el) => {
    elements += 1;
    const spec = INSTRUCTIONS[el.mnemonic];
    if (spec && spec.side === 'output') outputs += 1;
  });
  const plural = elements === 1 ? 'element' : 'elements';
  return `this rung has ${elements} ${plural}, ${outputs} of them outputs`;
}

/**
 * One line per rung, for a program listing or a printed hand-over.
 * @param {object} prog the program
 * @param {object} [opts] options passed to {@link describeRung}, with `presets` filled in from the
 *   whole program when the caller does not supply them
 * @returns {Array<{rungId:string, comment:string, text:string}>} the lines, in program order
 */
export function describeProgram(prog, opts) {
  const use = { presets: timerPresets(prog), ...(opts || {}) };
  return rungsOf(prog).map((rung) => ({
    rungId: rung.id,
    comment: rung.comment || '',
    text: describeRung(rung, use),
  }));
}

// ---------------------------------------------------------------------------------------------
// the merged lint
// ---------------------------------------------------------------------------------------------

/**
 * Sort key for a severity, worst first.
 * @param {string} severity one of {@link SEVERITY}
 * @returns {number} 0 for an error, rising with harmlessness
 */
function severityRank(severity) {
  if (severity === SEVERITY.ERROR) return 0;
  if (severity === SEVERITY.WARNING) return 1;
  if (severity === SEVERITY.INFO) return 2;
  return 3;
}

/**
 * Everything wrong with a program, in one list, worst first.
 *
 * This is what the editor shows and what a download should be refused on. It runs the document
 * checks in `model.validateProgram` — with the real instruction table, so operand counts come from
 * the instructions rather than from a reader's aid — and then adds the behavioural ones. It adds
 * nothing the document check has already said: the duplicate-coil entry here covers only the case
 * `validateProgram` cannot see, two destructive coils on the SAME rung, because it dedupes by rung.
 *
 * @param {object} prog the program
 * @param {*} [db] a tag database, a `Set`/array of names, or a `(name)=>boolean` predicate; when
 *   absent the tag checks are skipped rather than guessed at
 * @returns {Array<{rungId:string|null, path:number[]|null, severity:string, message:string,
 *   check:string}>} the problems, errors first and then in program order
 */
export function lintProgram(prog, db) {
  if (!prog || !Array.isArray(prog.rungs)) {
    return [{
      rungId: null,
      path: null,
      severity: SEVERITY.ERROR,
      message: 'this is not a program document',
      check: CHECK.DOCUMENT,
    }];
  }

  const known = tagLookup(db);
  const problems = validateProgram(prog, known, { specs: VALIDATION_SPECS })
    .map((p) => ({ ...p, check: CHECK.DOCUMENT }));

  for (const dup of duplicateCoils(prog)) {
    if (dup.rungs.length > 1) continue;
    problems.push({
      rungId: dup.rungs[0],
      path: null,
      severity: SEVERITY.ERROR,
      message: `${dup.tag} is driven by ${dup.count} OTEs on this one rung; the right-hand one wins`
        + ' and the others never appear to work',
      check: CHECK.DUPLICATE_COIL,
    });
  }

  for (const hazard of scanOrderHazards(prog)) {
    problems.push({
      rungId: hazard.rungId,
      path: null,
      severity: hazard.severity,
      message: hazard.message,
      check: CHECK.SCAN_ORDER,
    });
  }

  const byId = new Map();
  prog.rungs.forEach((rung, i) => { if (rung && rung.id) byId.set(rung.id, { rung, i }); });
  for (const id of unreachableRungs(prog)) {
    const at = byId.get(id);
    const disabled = at && at.rung.enabled === false;
    problems.push({
      rungId: id,
      path: null,
      severity: disabled ? SEVERITY.INFO : SEVERITY.WARNING,
      message: disabled
        ? 'this rung is disabled, so the scan steps over it and everything it drives holds its'
          + ' last state'
        : 'the scan never reaches this rung — an unconditional JMP above it steps over it, and'
          + ' every output on it holds whatever it was left at',
      check: disabled ? CHECK.DISABLED : CHECK.UNREACHABLE,
    });
  }

  const order = (id) => (byId.has(id) ? byId.get(id).i : Number.MAX_SAFE_INTEGER);
  problems.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    return bySeverity !== 0 ? bySeverity : order(a.rungId) - order(b.rungId);
  });
  return problems;
}
