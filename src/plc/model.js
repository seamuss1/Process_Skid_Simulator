/**
 * src/plc/model.js — the ladder program document: its tree, the editing operations that address
 * that tree by path, and the text format programs are shared, diffed and hand written in.
 *
 * Layer L3 (src/plc): imports nothing at all. No DOM, no window, no document, no performance, no
 * Date.now, no Math.random — this module is a pure document layer and is unit-tested in Node.
 * It deliberately does NOT import `tags.js` or `instructions.js`: the document has to be loadable,
 * printable and editable before a processor or a tag database exists, and a parser that needs the
 * rest of the system to be booted is a parser you cannot use in a test or a file dialog.
 *
 * ------------------------------------------------------------------------------------------
 * THE TREE, AND WHY IT IS SHAPED LIKE THIS
 *
 * A rung is a SERIES list of nodes evaluated left to right. A node is either an ELEMENT (one
 * instruction) or a BRANCH, and a branch holds two or more LEGS, each of which is itself a series
 * list of nodes. That two-level alternation — series of nodes, node may be a branch, branch holds
 * series — is the whole of ladder. Series is AND, a branch is OR, and nesting gives you every
 * expression a rung can express. Everything else in this file is bookkeeping on top of it.
 *
 * A NODE IS ADDRESSED BY A PATH: an array of indices that alternates node index and leg index.
 *
 *     [2]           the third node of the rung
 *     [2, 0]        leg 0 of the branch at node 2            (an even length addresses a LEG)
 *     [2, 0, 1]     the second node inside that leg          (an odd length addresses a NODE)
 *     [2, 0, 1, 3, 0]   ... and so on, as deep as the branches nest
 *
 * Odd length means node, even length means leg. That one rule is what keeps the editor, the
 * solver's power map and the cross-reference tool all talking about the same place.
 *
 * INVARIANTS, held after every mutation. They are enforced in one place, `normalizeRung`, rather
 * than at each call site, because the failure they prevent is a tree that is only slightly wrong:
 * a branch with one leg still renders, still parses, and silently changes what the rung means.
 *
 *   1. A branch has at least two legs. Drop to one and the branch collapses — its surviving leg is
 *      spliced into the parent series in its place. Drop to none and the branch is removed.
 *   2. A leg may be EMPTY. That is not a defect: an empty leg is a short across the branch, which
 *      is exactly how a seal-in or a bypass is drawn.
 *   3. A rung may be empty. Removing the last element leaves `nodes: []`, never a hole.
 *   4. Rung ids are unique within a program, because the solver's power map and the editor's
 *      selection are both keyed on them.
 *
 * Rung ids are RUNTIME HANDLES, not part of the document's identity, so they are not written to
 * the text format. Two loads of the same file are the same program with different handles.
 *
 * ------------------------------------------------------------------------------------------
 * THE TEXT FORMAT
 *
 * The grammar, in full. It is line-oriented outside a rung and token-oriented inside one, so a
 * rung may be written on one line or spread over twenty and it parses to the same tree.
 *
 *     program     := { blank | comment | header | rung }
 *     comment     := ';' <anything to end of line>
 *     header      := 'PROGRAM' <name to end of line>
 *                  | 'VERSION' <integer>
 *                  | 'META' <key> '=' <value to end of line>
 *     rung        := [ 'DISABLED' ] 'RUNG' [ <comment to end of line> ]
 *                        { node } 'END'
 *     node        := element | branch
 *     branch      := '[' leg { '|' leg } ']'
 *     leg         := { node }                         -- may be empty: an empty leg is a short
 *     element     := MNEMONIC [ '(' [ operand { ',' operand } ] ')' ]
 *     operand     := <dotted tag name> | <number> | <bare name> | <'quoted string'>
 *
 * An example, which is also the shape `programToText` emits:
 *
 *     PROGRAM Default station
 *     VERSION 1
 *     META author = house
 *
 *     RUNG P-101 seals in once started and drops out on stop or trip
 *       [ XIC(M.P1_START_PB) | XIC(Q.P1_START) ] XIO(M.P1_STOP_PB) XIO(I.P1_FAULT) OTE(Q.P1_START)
 *     END
 *
 *     DISABLED RUNG commissioning override — left in the file, skipped by the scan
 *       XIC(M.OVERRIDE) OTE(Q.P2_START)
 *     END
 *
 * WHY OPERANDS ARE PARENTHESISED. Without a delimiter the parser cannot know where one
 * instruction's operands stop and the next instruction starts without consulting an instruction
 * table — and then the document layer cannot read a file written for an instruction set it does
 * not own. `MNEMONIC(a, b)` is self-delimiting, it is how every ladder cell is captioned on a real
 * terminal anyway, and it means an unknown instruction still parses and still renders instead of
 * poisoning the whole load.
 *
 * ROUND TRIP. `programToText` emits a CANONICAL form: uppercase mnemonics, one space between
 * elements, `, ` between operands, two-space rung bodies, blank line between rungs. Canonical text
 * survives text -> program -> text byte for byte, and any accepted text survives program -> text ->
 * program structurally. Hand-written text that differs only in spacing is reformatted on the way
 * out, which is the point: a formatter that leaves the file alone is a formatter that lets two
 * identical programs diff as different.
 * ------------------------------------------------------------------------------------------
 */

/** Document format version, written to the text as `VERSION` and to `prog.v`. */
export const MODEL_VERSION = 1;

/** What an element draws as. The instruction set owns the truth; this is how it renders. */
export const KIND = Object.freeze({
  /** An input element on the left of the rung: it conditions power flow. */
  CONTACT: 'CONTACT',
  /** An output element on the right of the rung: it consumes power flow. */
  COIL: 'COIL',
  /** A boxed instruction — timer, counter, maths, process block. */
  BLOCK: 'BLOCK',
});

/**
 * The `kind` carried by a branch node. Kept out of {@link KIND} on purpose: a branch is not an
 * instruction and nothing that switches on an element kind should ever see it by accident.
 */
export const BRANCH = 'BRANCH';

/** Problem severities, ordered worst first by {@link validateProgram}. */
export const SEVERITY = Object.freeze({
  /** The program will not do what it says. Refuse to run it. */
  ERROR: 'error',
  /** Legal, but almost certainly not what was meant. */
  WARNING: 'warning',
  /** Worth saying once. */
  INFO: 'info',
});

/** How an operand's source text reads. */
export const OPERAND = Object.freeze({
  /** A dotted symbolic tag name, `I.PT101`. Resolvable against the tag database. */
  TAG: 'tag',
  /** A numeric literal, `8000` or `-1.5`. */
  NUMBER: 'number',
  /** A quoted string literal. */
  STRING: 'string',
  /** A bare word that is not a tag: a JMP/LBL label, an enum, a mode name. */
  NAME: 'name',
});

/**
 * How each mnemonic renders and roughly how many operands it takes.
 *
 * This table is a READER'S AID, not the instruction set. `instructions.js` owns behaviour and
 * owns the real operand contract; duplicating that here would guarantee the two drift. So the
 * arity is used only to warn, never to reject, and an unknown mnemonic renders as a block. Pass
 * `opts.specs` to any function that takes options to hand in the real table once it exists.
 */
export const ELEMENT_SPECS = Object.freeze({
  // bit
  XIC: { kind: KIND.CONTACT, min: 1, max: 1 },
  XIO: { kind: KIND.CONTACT, min: 1, max: 1 },
  OTE: { kind: KIND.COIL, min: 1, max: 1 },
  OTL: { kind: KIND.COIL, min: 1, max: 1 },
  OTU: { kind: KIND.COIL, min: 1, max: 1 },
  ONS: { kind: KIND.CONTACT, min: 1, max: 1 },
  OSR: { kind: KIND.COIL, min: 1, max: 2 },
  OSF: { kind: KIND.COIL, min: 1, max: 2 },
  // timer
  TON: { kind: KIND.BLOCK, min: 1, max: 3 },
  TOF: { kind: KIND.BLOCK, min: 1, max: 3 },
  RTO: { kind: KIND.BLOCK, min: 1, max: 3 },
  RES: { kind: KIND.COIL, min: 1, max: 1 },
  // counter
  CTU: { kind: KIND.BLOCK, min: 1, max: 3 },
  CTD: { kind: KIND.BLOCK, min: 1, max: 3 },
  // compare
  EQU: { kind: KIND.CONTACT, min: 2, max: 2 },
  NEQ: { kind: KIND.CONTACT, min: 2, max: 2 },
  LES: { kind: KIND.CONTACT, min: 2, max: 2 },
  GRT: { kind: KIND.CONTACT, min: 2, max: 2 },
  LEQ: { kind: KIND.CONTACT, min: 2, max: 2 },
  GEQ: { kind: KIND.CONTACT, min: 2, max: 2 },
  LIM: { kind: KIND.CONTACT, min: 3, max: 3 },
  MEQ: { kind: KIND.CONTACT, min: 3, max: 3 },
  // math
  ADD: { kind: KIND.BLOCK, min: 3, max: 3 },
  SUB: { kind: KIND.BLOCK, min: 3, max: 3 },
  MUL: { kind: KIND.BLOCK, min: 3, max: 3 },
  DIV: { kind: KIND.BLOCK, min: 3, max: 3 },
  MOD: { kind: KIND.BLOCK, min: 3, max: 3 },
  MOV: { kind: KIND.BLOCK, min: 2, max: 2 },
  CLR: { kind: KIND.BLOCK, min: 1, max: 1 },
  SQR: { kind: KIND.BLOCK, min: 2, max: 2 },
  NEG: { kind: KIND.BLOCK, min: 2, max: 2 },
  ABS: { kind: KIND.BLOCK, min: 2, max: 2 },
  SCL: { kind: KIND.BLOCK, min: 4, max: 6 },
  SCP: { kind: KIND.BLOCK, min: 4, max: 6 },
  AVE: { kind: KIND.BLOCK, min: 2, max: 3 },
  // logic
  AND: { kind: KIND.BLOCK, min: 3, max: 3 },
  OR: { kind: KIND.BLOCK, min: 3, max: 3 },
  XOR: { kind: KIND.BLOCK, min: 3, max: 3 },
  NOT: { kind: KIND.BLOCK, min: 2, max: 2 },
  // control
  JMP: { kind: KIND.COIL, min: 1, max: 1 },
  LBL: { kind: KIND.CONTACT, min: 1, max: 1 },
  MCR: { kind: KIND.COIL, min: 0, max: 0 },
  NOP: { kind: KIND.BLOCK, min: 0, max: 0 },
  AFI: { kind: KIND.CONTACT, min: 0, max: 0 },
  // process
  PID: { kind: KIND.BLOCK, min: 1, max: 4 },
  SETPT: { kind: KIND.COIL, min: 1, max: 2 },
  RAMP: { kind: KIND.BLOCK, min: 3, max: 4 },
  TOTAL: { kind: KIND.BLOCK, min: 2, max: 3 },
  DEADBAND: { kind: KIND.BLOCK, min: 3, max: 3 },
  ALARM: { kind: KIND.COIL, min: 1, max: 3 },
  ALTERNATE: { kind: KIND.COIL, min: 2, max: 3 },
  RUNHOURS: { kind: KIND.BLOCK, min: 2, max: 3 },
});

/** Canonical line width the formatter tries to stay under before it breaks a rung up. */
const WRAP_COLS = 96;

/** How deep branches may nest before the parser calls the file pathological. */
const MAX_DEPTH = 12;

/**
 * Monotonic source of rung handles.
 *
 * A counter, not a random or time-based id, because every module under `src/plc` has to be
 * reproducible in a Node test: two identical edit sequences must produce two identical documents.
 */
let idSeq = 0;

/**
 * Mint a rung handle.
 * @returns {string} a fresh id, unique for the life of the process
 */
function nextRungId() {
  idSeq += 1;
  return `R${idSeq}`;
}

// ---------------------------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------------------------

/**
 * Create an empty program document.
 * @param {string} [name] program name, as shown in the editor title and written to the text
 * @returns {object} a program `{v, name, rungs, meta}`
 */
export function createProgram(name) {
  return {
    v: MODEL_VERSION,
    name: cleanLine(name == null ? 'untitled' : String(name)),
    rungs: [],
    meta: {},
  };
}

/**
 * Create an empty rung.
 * @param {string} [comment] the plain-English line above the rung — write one, always
 * @returns {object} a rung `{id, comment, nodes, enabled}`
 */
export function createRung(comment) {
  return {
    id: nextRungId(),
    comment: cleanLine(comment == null ? '' : String(comment)),
    nodes: [],
    enabled: true,
  };
}

/**
 * Create one instruction element.
 *
 * @param {string} mnemonic instruction mnemonic; case-insensitive, stored uppercase
 * @param {Array<string|number>} [operands] operand source texts, in order
 * @param {object} [opts] options
 * @param {object} [opts.specs] mnemonic table to classify against, default {@link ELEMENT_SPECS}
 * @param {string} [opts.kind] force the render kind, for an instruction the table has never heard of
 * @returns {object} an element `{kind, mnemonic, operands}`
 */
export function createElement(mnemonic, operands, opts) {
  const mn = String(mnemonic == null ? '' : mnemonic).trim().toUpperCase();
  const list = Array.isArray(operands) ? operands.map((o) => String(o).trim()) : [];
  return { kind: (opts && opts.kind) || kindOfMnemonic(mn, opts), mnemonic: mn, operands: list };
}

/**
 * Create a branch node with the legs given, or two empty legs.
 * @param {Array<Array<object>>} [legs] parallel series lists
 * @returns {object} a branch node `{kind:'BRANCH', legs}`
 */
export function createBranch(legs) {
  const use = Array.isArray(legs) ? legs.map((leg) => (Array.isArray(leg) ? leg.slice() : [])) : [];
  while (use.length < 2) use.push([]);
  return { kind: BRANCH, legs: use };
}

/**
 * Classify a mnemonic for rendering.
 * @param {string} mn uppercase mnemonic
 * @param {object} [opts] options carrying an alternative `specs` table
 * @returns {string} one of {@link KIND}; unknown instructions render as a block
 */
function kindOfMnemonic(mn, opts) {
  const specs = (opts && opts.specs) || ELEMENT_SPECS;
  const spec = specs[mn];
  if (spec && spec.kind && KIND[spec.kind]) return spec.kind;
  return KIND.BLOCK;
}

/**
 * True when a node is a branch rather than an instruction.
 * @param {object} node any node
 * @returns {boolean} whether it holds parallel legs
 */
export function isBranch(node) {
  return !!node && node.kind === BRANCH && Array.isArray(node.legs);
}

/**
 * True when a node is a single instruction.
 * @param {object} node any node
 * @returns {boolean} whether it is an element
 */
export function isElement(node) {
  return !!node && typeof node.mnemonic === 'string' && !isBranch(node);
}

/**
 * Deep copy a rung, handle and all.
 * @param {object} rung the rung to copy
 * @param {boolean} [freshId] mint a new handle instead of keeping the old one
 * @returns {object} an independent rung
 */
export function cloneRung(rung, freshId) {
  return {
    id: freshId ? nextRungId() : rung.id,
    comment: rung.comment,
    enabled: rung.enabled !== false,
    nodes: cloneNodes(rung.nodes),
  };
}

/**
 * Deep copy a node list.
 * @param {object[]} nodes series list
 * @returns {object[]} an independent series list
 */
function cloneNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (isBranch(n)) out.push({ kind: BRANCH, legs: n.legs.map(cloneNodes) });
    else out.push({ kind: n.kind, mnemonic: n.mnemonic, operands: n.operands.slice() });
  }
  return out;
}

/**
 * Deep copy a whole program. The editor's undo stack is built out of these, so it copies
 * everything a mutation could reach — a shallow copy means undo silently shares a rung.
 * @param {object} prog the program to copy
 * @returns {object} an independent program with the same rung handles
 */
export function cloneProgram(prog) {
  return {
    v: prog.v || MODEL_VERSION,
    name: prog.name,
    rungs: (prog.rungs || []).map((r) => cloneRung(r, false)),
    meta: { ...(prog.meta || {}) },
  };
}

// ---------------------------------------------------------------------------------------------
// rung list operations
// ---------------------------------------------------------------------------------------------

/**
 * Find a rung by its handle.
 * @param {object} prog the program
 * @param {string} id rung id
 * @returns {object|null} the rung, or null when the program has no such rung
 */
export function rungById(prog, id) {
  if (!prog || !Array.isArray(prog.rungs)) return null;
  for (const r of prog.rungs) if (r.id === id) return r;
  return null;
}

/**
 * Insert a rung into a program.
 *
 * A rung arriving with an id the program already uses — a paste, a duplicate, an undo of a
 * delete — is given a fresh handle rather than refused, because a duplicate id does not fail
 * loudly: it makes the solver's power map light the wrong rung and the editor select the wrong
 * one, and nobody connects that to the paste they did five minutes ago.
 *
 * @param {object} prog the program (mutated)
 * @param {object} rung the rung to insert
 * @param {number} [index] position; defaults to the end, clamped into range
 * @returns {{ok:boolean, reason?:string, id?:string, index?:number}} the outcome
 */
export function addRung(prog, rung, index) {
  if (!prog || !Array.isArray(prog.rungs)) return { ok: false, reason: 'no program to add a rung to' };
  if (!rung || !Array.isArray(rung.nodes)) return { ok: false, reason: 'that is not a rung' };
  if (!rung.id || rungById(prog, rung.id)) rung.id = nextRungId();
  if (typeof rung.comment !== 'string') rung.comment = '';
  if (typeof rung.enabled !== 'boolean') rung.enabled = true;
  let at = index == null ? prog.rungs.length : Math.trunc(index);
  if (!Number.isFinite(at)) at = prog.rungs.length;
  at = Math.max(0, Math.min(prog.rungs.length, at));
  prog.rungs.splice(at, 0, rung);
  return { ok: true, id: rung.id, index: at };
}

/**
 * Delete a rung.
 * @param {object} prog the program (mutated)
 * @param {string} id rung id
 * @returns {{ok:boolean, reason?:string}} the outcome
 */
export function removeRung(prog, id) {
  if (!prog || !Array.isArray(prog.rungs)) return { ok: false, reason: 'no program to remove from' };
  const at = prog.rungs.findIndex((r) => r.id === id);
  if (at < 0) return { ok: false, reason: `there is no rung ${id} in this program` };
  prog.rungs.splice(at, 1);
  return { ok: true };
}

/**
 * Move a rung up or down the program.
 *
 * Order is not cosmetic in ladder — the scan runs top to bottom and a coil written after it is
 * read behaves differently by one scan — so this is a real edit and it refuses rather than
 * silently clamping, which would leave the operator thinking the move happened.
 *
 * @param {object} prog the program (mutated)
 * @param {string} id rung id
 * @param {number} delta how far to move; negative is towards the top of the program
 * @returns {{ok:boolean, reason?:string, index?:number}} the outcome
 */
export function moveRung(prog, id, delta) {
  if (!prog || !Array.isArray(prog.rungs)) return { ok: false, reason: 'no program to reorder' };
  const at = prog.rungs.findIndex((r) => r.id === id);
  if (at < 0) return { ok: false, reason: `there is no rung ${id} in this program` };
  const step = Math.trunc(Number(delta) || 0);
  if (step === 0) return { ok: false, reason: 'a move of zero rungs does nothing' };
  const to = at + step;
  if (to < 0 || to >= prog.rungs.length) {
    return { ok: false, reason: `${id} cannot move ${step < 0 ? 'above the first' : 'below the last'} rung` };
  }
  const [r] = prog.rungs.splice(at, 1);
  prog.rungs.splice(to, 0, r);
  return { ok: true, index: to };
}

// ---------------------------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------------------------

/**
 * Check a path is a list of non-negative integers.
 * @param {number[]} path candidate path
 * @returns {boolean} whether it is well formed
 */
function pathOk(path) {
  if (!Array.isArray(path) || path.length === 0) return false;
  for (const k of path) if (!Number.isInteger(k) || k < 0) return false;
  return true;
}

/**
 * Render a path for a refusal message.
 * @param {*} path the path
 * @returns {string} a printable form
 */
function pathText(path) {
  return Array.isArray(path) ? `[${path.join(', ')}]` : String(path);
}

/**
 * Resolve the series list a path's last index lives in.
 *
 * @param {object} rung the rung
 * @param {number[]} path an odd-length path addressing a node position
 * @returns {{list:object[], index:number}|null} the parent list and the index, or null
 */
function parentOf(rung, path) {
  if (!rung || !Array.isArray(rung.nodes)) return null;
  if (!pathOk(path) || path.length % 2 === 0) return null;
  let list = rung.nodes;
  for (let k = 0; k < path.length - 1; k += 2) {
    const node = list[path[k]];
    if (!isBranch(node)) return null;
    const leg = node.legs[path[k + 1]];
    if (!Array.isArray(leg)) return null;
    list = leg;
  }
  return { list, index: path[path.length - 1] };
}

/**
 * The node at a path.
 * @param {object} rung the rung
 * @param {number[]} path an odd-length path
 * @returns {object|null} the element or branch node, or null when nothing is there
 */
export function elementAt(rung, path) {
  const p = parentOf(rung, path);
  if (!p) return null;
  return p.list[p.index] || null;
}

/**
 * The series list of one branch leg.
 * @param {object} rung the rung
 * @param {number[]} path an even-length path, `[...branchPath, legIndex]`
 * @returns {object[]|null} the leg's node list, or null
 */
export function legAt(rung, path) {
  if (!pathOk(path) || path.length % 2 !== 0) return null;
  const branch = elementAt(rung, path.slice(0, -1));
  if (!isBranch(branch)) return null;
  const leg = branch.legs[path[path.length - 1]];
  return Array.isArray(leg) ? leg : null;
}

/**
 * Visit every element in a rung in evaluation order: series left to right, and inside a branch,
 * each leg in turn from the top.
 * @param {object} rung the rung
 * @param {(el:object, path:number[])=>void} fn called for each element; branches are descended
 *   into but not themselves passed
 * @returns {void}
 */
export function walkElements(rung, fn) {
  if (!rung || !Array.isArray(rung.nodes) || typeof fn !== 'function') return;
  walkList(rung.nodes, [], (node, path) => { if (isElement(node)) fn(node, path); });
}

/**
 * Walk a series list, passing every node — branches included — with its path.
 * @param {object[]} list the series list
 * @param {number[]} base path of the list's parent
 * @param {(node:object, path:number[])=>void} fn visitor
 * @returns {void}
 */
function walkList(list, base, fn) {
  for (let i = 0; i < list.length; i += 1) {
    const path = base.concat(i);
    const node = list[i];
    fn(node, path);
    if (isBranch(node)) {
      for (let g = 0; g < node.legs.length; g += 1) walkList(node.legs[g], path.concat(g), fn);
    }
  }
}

/**
 * Every element path in a rung, in evaluation order.
 * @param {object} rung the rung
 * @returns {number[][]} the paths
 */
export function pathsOf(rung) {
  const out = [];
  walkElements(rung, (el, path) => out.push(path));
  return out;
}

/**
 * Every branch node path in a rung, outermost first. The editor needs these to let an operator
 * select a branch rather than one of the elements inside it.
 * @param {object} rung the rung
 * @returns {number[][]} the paths
 */
export function branchPathsOf(rung) {
  const out = [];
  if (!rung || !Array.isArray(rung.nodes)) return out;
  walkList(rung.nodes, [], (node, path) => { if (isBranch(node)) out.push(path); });
  return out;
}

// ---------------------------------------------------------------------------------------------
// tree invariants
// ---------------------------------------------------------------------------------------------

/**
 * Restore the tree invariants after an edit: collapse any branch left with one leg into its
 * parent, and delete any branch left with none.
 *
 * Called from every mutator. A one-legged branch is the dangerous case — it renders, it parses,
 * it evaluates, and it quietly means something different from what the operator drew.
 *
 * @param {object} rung the rung (mutated)
 * @returns {void}
 */
function normalizeRung(rung) {
  if (rung && Array.isArray(rung.nodes)) normalizeList(rung.nodes);
}

/**
 * Normalise one series list, depth first.
 * @param {object[]} list the list (mutated)
 * @returns {void}
 */
function normalizeList(list) {
  let i = 0;
  while (i < list.length) {
    const node = list[i];
    if (!isBranch(node)) { i += 1; continue; }
    for (const leg of node.legs) normalizeList(leg);
    if (node.legs.length === 0) {
      list.splice(i, 1);
      continue;
    }
    if (node.legs.length === 1) {
      list.splice(i, 1, ...node.legs[0]);
      continue;
    }
    i += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// element operations
// ---------------------------------------------------------------------------------------------

/**
 * Insert an element at a position.
 *
 * The path addresses the position the element takes, so `[2]` inserts before the node currently
 * at index 2 and a path one past the end appends.
 *
 * @param {object} rung the rung (mutated)
 * @param {number[]} path odd-length insertion path
 * @param {object} el an element from {@link createElement}
 * @returns {{ok:boolean, reason?:string}} the outcome
 */
export function addElement(rung, path, el) {
  if (!isElement(el)) return { ok: false, reason: 'that is not an instruction — use addBranch for a branch' };
  const p = parentOf(rung, path);
  if (!p) return { ok: false, reason: `${pathText(path)} does not address a place in this rung` };
  if (p.index > p.list.length) {
    return { ok: false, reason: `${pathText(path)} is past the end of that series` };
  }
  p.list.splice(p.index, 0, el);
  normalizeRung(rung);
  return { ok: true };
}

/**
 * Delete the element at a path. Removing the last element of a rung leaves an empty rung, and
 * removing the last element of a leg leaves an empty leg — a short across the branch — because
 * both are legal drawings and neither should cost the operator their branch structure.
 *
 * @param {object} rung the rung (mutated)
 * @param {number[]} path odd-length path to an element
 * @returns {{ok:boolean, reason?:string}} the outcome
 */
export function removeElement(rung, path) {
  const p = parentOf(rung, path);
  const node = p ? p.list[p.index] : null;
  if (!node) return { ok: false, reason: `there is no element at ${pathText(path)}` };
  if (isBranch(node)) return { ok: false, reason: `${pathText(path)} holds a branch — use removeBranch` };
  p.list.splice(p.index, 1);
  normalizeRung(rung);
  return { ok: true };
}

/**
 * Swap the element at a path for another.
 * @param {object} rung the rung (mutated)
 * @param {number[]} path odd-length path to an element
 * @param {object} el the replacement
 * @returns {{ok:boolean, reason?:string}} the outcome
 */
export function replaceElement(rung, path, el) {
  if (!isElement(el)) return { ok: false, reason: 'that is not an instruction' };
  const p = parentOf(rung, path);
  const node = p ? p.list[p.index] : null;
  if (!node) return { ok: false, reason: `there is no element at ${pathText(path)}` };
  if (isBranch(node)) return { ok: false, reason: `${pathText(path)} holds a branch, not an instruction` };
  p.list[p.index] = el;
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// branch operations
// ---------------------------------------------------------------------------------------------

/**
 * Wrap the node at a path in a new branch: leg 0 keeps the node, leg 1 is an empty short.
 *
 * That is what "add a branch here" means on a real terminal — you get the parallel path around
 * what you had selected, and you fill it in.
 *
 * @param {object} rung the rung (mutated)
 * @param {number[]} path odd-length path to the node to branch around
 * @returns {{ok:boolean, reason?:string, path?:number[]}} the outcome and the branch's path
 */
export function addBranch(rung, path) {
  const p = parentOf(rung, path);
  const node = p ? p.list[p.index] : null;
  if (!node) return { ok: false, reason: `there is nothing at ${pathText(path)} to branch around` };
  if (depthOf(path) + 1 > MAX_DEPTH) {
    return { ok: false, reason: `branches may not nest deeper than ${MAX_DEPTH}` };
  }
  p.list[p.index] = createBranch([[node], []]);
  return { ok: true, path: path.slice() };
}

/**
 * Add another parallel leg to a branch.
 * @param {object} rung the rung (mutated)
 * @param {number[]} path odd-length path to the branch node
 * @returns {{ok:boolean, reason?:string, leg?:number}} the outcome and the new leg's index
 */
export function addBranchLeg(rung, path) {
  const node = elementAt(rung, path);
  if (!isBranch(node)) return { ok: false, reason: `there is no branch at ${pathText(path)}` };
  node.legs.push([]);
  return { ok: true, leg: node.legs.length - 1 };
}

/**
 * Delete one leg of a branch.
 *
 * When that leaves a single leg the branch itself goes and the survivor is spliced into the
 * series in its place, which is the only sane reading of "the parallel path is gone".
 *
 * @param {object} rung the rung (mutated)
 * @param {number[]} path even-length path, `[...branchPath, legIndex]`
 * @returns {{ok:boolean, reason?:string}} the outcome
 */
export function removeBranchLeg(rung, path) {
  if (!pathOk(path) || path.length % 2 !== 0) {
    return { ok: false, reason: `${pathText(path)} does not address a branch leg` };
  }
  const branch = elementAt(rung, path.slice(0, -1));
  if (!isBranch(branch)) return { ok: false, reason: `there is no branch at ${pathText(path.slice(0, -1))}` };
  const leg = path[path.length - 1];
  if (leg >= branch.legs.length) return { ok: false, reason: `that branch has no leg ${leg}` };
  branch.legs.splice(leg, 1);
  normalizeRung(rung);
  return { ok: true };
}

/**
 * Delete a whole branch, keeping the contents of its first leg in the series.
 *
 * Keeping leg 0 rather than deleting everything is deliberate: the first leg is the main path an
 * operator drew before they branched around it, and losing it to a mis-click is unrecoverable in
 * an editor without undo.
 *
 * @param {object} rung the rung (mutated)
 * @param {number[]} path odd-length path to the branch node
 * @returns {{ok:boolean, reason?:string}} the outcome
 */
export function removeBranch(rung, path) {
  const p = parentOf(rung, path);
  const node = p ? p.list[p.index] : null;
  if (!isBranch(node)) return { ok: false, reason: `there is no branch at ${pathText(path)}` };
  p.list.splice(p.index, 1, ...node.legs[0]);
  normalizeRung(rung);
  return { ok: true };
}

/**
 * How many branches a path passes through.
 * @param {number[]} path a path
 * @returns {number} nesting depth, 0 at the top level of a rung
 */
function depthOf(path) {
  return Math.floor(path.length / 2);
}

// ---------------------------------------------------------------------------------------------
// operands
// ---------------------------------------------------------------------------------------------

/** A symbolic tag reference: a scope prefix, a dot, and a name. */
const TAG_RE = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+$/;

/**
 * How an operand's source text reads.
 *
 * The dot is what separates a tag from a label: `T.STAGE_DLY` is a tag the database must know,
 * `SKIP_LAG` is a JMP label that belongs to the program alone. Without that rule every label
 * would be reported as an unresolved tag and the tag check would be noise.
 *
 * @param {string} op operand source text
 * @returns {string} one of {@link OPERAND}
 */
export function operandKind(op) {
  const s = String(op == null ? '' : op).trim();
  if (s === '') return OPERAND.NAME;
  if ((s.startsWith("'") && s.endsWith("'") && s.length >= 2)
    || (s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return OPERAND.STRING;
  if (s !== '' && Number.isFinite(Number(s))) return OPERAND.NUMBER;
  if (TAG_RE.test(s)) return OPERAND.TAG;
  return OPERAND.NAME;
}

/**
 * Decode an operand's literal value.
 * @param {string} op operand source text
 * @returns {number|string} the number for a numeric literal, the unquoted body for a string, and
 *   the text itself for a tag or a name — resolving a tag is the runtime's job, not the document's
 */
export function operandValue(op) {
  const s = String(op == null ? '' : op).trim();
  const kind = operandKind(s);
  if (kind === OPERAND.NUMBER) return Number(s);
  if (kind === OPERAND.STRING) return s.slice(1, -1);
  return s;
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

/**
 * Ask whatever was handed in as a tag database whether it knows a name.
 *
 * The document layer must not import `tags.js` — see the header — so it duck-types instead, and
 * accepts a plain predicate function as the friendliest form. When nothing usable is supplied the
 * tag check is skipped rather than guessed at: reporting every tag as missing because the caller
 * passed the wrong object would bury the real problems.
 *
 * @param {*} db a tag database, a `Set`/array of names, or a `(name)=>boolean` predicate
 * @returns {((name:string)=>boolean)|null} a lookup, or null when there is nothing to ask
 */
function tagLookup(db) {
  if (!db) return null;
  if (typeof db === 'function') return (n) => !!db(n);
  if (db instanceof Set) return (n) => db.has(n);
  if (Array.isArray(db)) return (n) => db.includes(n);
  if (typeof db.tagExists === 'function') return (n) => !!db.tagExists(n);
  const table = db.tags || db.byName;
  if (table instanceof Map) return (n) => table.has(n);
  if (table && typeof table === 'object') return (n) => Object.prototype.hasOwnProperty.call(table, n);
  return null;
}

/**
 * Check a program for the mistakes that make it do something other than it reads.
 *
 * Everything here is a claim about the DOCUMENT. Claims about behaviour — scan-order hazards,
 * unreachable rungs, statistics — belong in `compile.js`, which lints on top of this.
 *
 * @param {object} prog the program
 * @param {*} [db] a tag database or predicate; when absent the tag checks are skipped
 * @param {object} [opts] options
 * @param {object} [opts.specs] mnemonic table, default {@link ELEMENT_SPECS}
 * @returns {Array<{rungId:string, path:number[]|null, severity:string, message:string}>} problems,
 *   errors first
 */
export function validateProgram(prog, db, opts) {
  const problems = [];
  if (!prog || !Array.isArray(prog.rungs)) {
    return [{ rungId: null, path: null, severity: SEVERITY.ERROR, message: 'this is not a program document' }];
  }
  const specs = (opts && opts.specs) || ELEMENT_SPECS;
  const known = tagLookup(db);
  /** @type {Map<string, string[]>} destructive coil tag -> the rungs that drive it */
  const coils = new Map();

  /**
   * Record a problem.
   * @param {string|null} rungId the rung
   * @param {number[]|null} path the element
   * @param {string} severity one of {@link SEVERITY}
   * @param {string} message a sentence an operator could read
   * @returns {void}
   */
  function say(rungId, path, severity, message) {
    problems.push({ rungId, path, severity, message });
  }

  for (const rung of prog.rungs) {
    if (!rung || !Array.isArray(rung.nodes)) {
      say(rung && rung.id, null, SEVERITY.ERROR, 'a rung in this program has no node list');
      continue;
    }
    if (rung.nodes.length === 0) {
      say(rung.id, null, SEVERITY.WARNING, 'this rung is empty and does nothing');
    }

    let outputs = 0;
    walkList(rung.nodes, [], (node, path) => {
      if (isBranch(node)) {
        if (node.legs.length < 2) {
          say(rung.id, path, SEVERITY.ERROR, 'a branch with fewer than two legs is not a branch');
        }
        return;
      }
      if (!isElement(node)) {
        say(rung.id, path, SEVERITY.ERROR, 'this node is neither an instruction nor a branch');
        return;
      }
      const spec = specs[node.mnemonic];
      if (!spec) {
        say(rung.id, path, SEVERITY.ERROR, `${node.mnemonic} is not an instruction this processor knows`);
      } else {
        const n = node.operands.length;
        if (n === 0 && spec.min > 0) {
          say(rung.id, path, SEVERITY.ERROR, `${node.mnemonic} needs an operand and has none`);
        } else if (n < spec.min || n > spec.max) {
          const want = spec.min === spec.max ? `${spec.min}` : `${spec.min} to ${spec.max}`;
          say(rung.id, path, SEVERITY.WARNING,
            `${node.mnemonic} usually takes ${want} operands and this one has ${n}`);
        }
      }
      if (spec && spec.kind === KIND.COIL) outputs += 1;

      for (const op of node.operands) {
        if (operandKind(op) !== OPERAND.TAG) continue;
        if (known && !known(op)) {
          say(rung.id, path, SEVERITY.ERROR, `there is no tag named ${op} in the database`);
        }
      }

      // A coil onto the input image is the classic first-week mistake: the value survives until
      // the next input scan overwrites it, so the rung appears to work for exactly one scan.
      if (spec && spec.kind === KIND.COIL && node.operands.length > 0
        && /^I\./i.test(node.operands[0])) {
        say(rung.id, path, SEVERITY.WARNING,
          `${node.mnemonic} writes ${node.operands[0]}, which the input scan overwrites every scan`);
      }

      if (node.mnemonic === 'OTE' && node.operands.length > 0) {
        const tag = node.operands[0];
        if (!coils.has(tag)) coils.set(tag, []);
        const list = coils.get(tag);
        if (list[list.length - 1] !== rung.id) list.push(rung.id);
      }
    });

    checkSeriesOrder(rung, rung.nodes, [], specs, say);

    if (outputs === 0 && rung.nodes.length > 0) {
      say(rung.id, null, SEVERITY.WARNING, 'this rung has no output instruction, so it changes nothing');
    }
  }

  for (const [tag, ids] of coils) {
    if (ids.length > 1) {
      problems.push({
        rungId: ids[1],
        path: null,
        severity: SEVERITY.ERROR,
        message: `${tag} is driven by an OTE on more than one rung (${ids.join(', ')}); the last one`
          + ' to scan wins and the others never appear to work',
      });
    }
  }

  // A stable sort, so problems on the same severity stay in the order they were found — which is
  // rung order, which is the order an operator works down the program.
  problems.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return problems;
}

/**
 * Sort key for a severity, worst first.
 *
 * Spelled out rather than looked up with a `||` default, because the worst severity ranks zero and
 * `0 || fallback` is the fallback — which silently sorts every error to the bottom of the list.
 *
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
 * Point out input instructions placed to the right of an output.
 *
 * This is legal ladder, it is not a defect, and it is deliberate more often than not — `XIC OTE
 * XIC OTE` energises the first coil on the first condition and the second on both, which is how
 * every latch-then-unlatch annunciator rung is drawn. So it is an INFO and never a warning: a
 * linter that scolds an operator for the commonest multi-output rung in the plant is a linter
 * whose output stops being read, and then the real findings go with it.
 *
 * @param {object} rung the rung, for its id
 * @param {object[]} list a series list
 * @param {number[]} base the list's path
 * @param {object} specs mnemonic table
 * @param {Function} say problem sink
 * @returns {void}
 */
function checkSeriesOrder(rung, list, base, specs, say) {
  let seenOutput = false;
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i];
    const path = base.concat(i);
    if (isBranch(node)) {
      for (let g = 0; g < node.legs.length; g += 1) {
        checkSeriesOrder(rung, node.legs[g], path.concat(g), specs, say);
      }
      continue;
    }
    const spec = specs[node.mnemonic];
    if (!spec) continue;
    if (spec.kind === KIND.COIL) { seenOutput = true; continue; }
    if (seenOutput && spec.kind === KIND.CONTACT) {
      say(rung.id, path, SEVERITY.INFO,
        `${node.mnemonic} sits to the right of an output, so it conditions only the outputs after`
        + ' it and not the one before it');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// text out
// ---------------------------------------------------------------------------------------------

/**
 * Strip anything that would break the line-oriented header syntax.
 * @param {string} s raw text
 * @returns {string} a single trimmed line
 */
function cleanLine(s) {
  return String(s).replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * Render one element to its canonical token.
 * @param {object} el the element
 * @returns {string} `MNEMONIC` or `MNEMONIC(a, b)`
 */
function renderElement(el) {
  const mn = String(el.mnemonic || 'NOP').toUpperCase();
  if (!el.operands || el.operands.length === 0) return mn;
  return `${mn}(${el.operands.join(', ')})`;
}

/**
 * Render a series list on one line.
 *
 * An empty leg renders as nothing between its delimiters — `[ XIC(M.CALL) | ]` — which is exactly
 * how a short across a branch is drawn, and it re-parses to the same empty leg.
 *
 * @param {object[]} list the list
 * @returns {string} the tokens, space separated
 */
function renderList(list) {
  const parts = [];
  for (const node of list) {
    if (isBranch(node)) {
      const legs = node.legs.map((leg) => {
        const body = renderList(leg);
        return body === '' ? ' ' : ` ${body} `;
      });
      parts.push(`[${legs.join('|')}]`);
    } else {
      parts.push(renderElement(node));
    }
  }
  return parts.join(' ');
}

/**
 * Render a branch across several lines, one leg per line.
 *
 * Legs are never themselves broken up. A leg long enough to want breaking is a rung that wants
 * splitting, and a formatter that reflows arbitrarily deep is a formatter whose output nobody can
 * predict — which defeats the point of having a canonical form to diff.
 *
 * @param {object} branch the branch node
 * @param {string} ind the indent
 * @returns {string[]} the lines
 */
function renderBranchLines(branch, ind) {
  const lines = [];
  for (let g = 0; g < branch.legs.length; g += 1) {
    const body = renderList(branch.legs[g]);
    lines.push(`${ind}${g === 0 ? '[' : '|'} ${body}`.trimEnd());
  }
  lines.push(`${ind}]`);
  return lines;
}

/**
 * Render one rung: header, body, END.
 *
 * The body is filled greedily up to the page width rather than broken one element per line. A
 * rung is one thought and it should read as one — a listing that stacks five contacts vertically
 * makes a single series look like five separate things, which is exactly the misreading the text
 * format exists to prevent. Only a branch too wide to fit on its own is opened out, one leg per
 * line, where the vertical layout is what a branch means anyway.
 *
 * The wrapping is a function of the tree alone, never of the source text, so printing is
 * idempotent and two identical programs print identically however they were typed.
 *
 * @param {object} rung the rung
 * @returns {string[]} the lines, header through END
 */
function renderRung(rung) {
  const lines = [];
  const head = `${rung.enabled === false ? 'DISABLED RUNG' : 'RUNG'} ${cleanLine(rung.comment || '')}`;
  lines.push(head.trimEnd());

  let cur = '';
  /**
   * Emit whatever has been filled so far.
   * @returns {void}
   */
  function flush() {
    if (cur !== '') lines.push(cur);
    cur = '';
  }

  for (const node of rung.nodes) {
    const piece = renderList([node]);
    if (isBranch(node) && `  ${piece}`.length > WRAP_COLS) {
      flush();
      lines.push(...renderBranchLines(node, '  '));
      continue;
    }
    const next = cur === '' ? `  ${piece}` : `${cur} ${piece}`;
    if (cur !== '' && next.length > WRAP_COLS) {
      flush();
      cur = `  ${piece}`;
    } else {
      cur = next;
    }
  }
  flush();

  lines.push('END');
  return lines;
}

/**
 * Render a program to its canonical text.
 * @param {object} prog the program
 * @returns {string} the text, newline terminated
 */
export function programToText(prog) {
  if (!prog || !Array.isArray(prog.rungs)) return '';
  const lines = [];
  lines.push(`PROGRAM ${cleanLine(prog.name || '')}`.trimEnd());
  lines.push(`VERSION ${Number(prog.v) || MODEL_VERSION}`);
  const meta = prog.meta || {};
  // Sorted, because a program that diffs differently depending on key insertion order is a
  // program whose history is unreadable.
  for (const key of Object.keys(meta).sort()) {
    const v = meta[key];
    if (v == null || typeof v === 'object') continue;
    lines.push(`META ${cleanLine(key)} = ${cleanLine(String(v))}`);
  }
  for (const rung of prog.rungs) {
    lines.push('');
    lines.push(...renderRung(rung));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// text in
// ---------------------------------------------------------------------------------------------

/**
 * Split one body line into tokens, keeping the line number on each so a problem can point at it.
 *
 * `[`, `|` and `]` are always their own tokens whether or not they are spaced, an operand list is
 * swallowed whole from `(` to its matching `)` so a comma or a bracket inside quotes cannot be
 * mistaken for structure, and `;` ends the line.
 *
 * @param {string} line the source line
 * @param {number} lineNo 1-based line number
 * @param {object[]} out token sink, `{t, line}`
 * @param {object[]} problems problem sink
 * @returns {void}
 */
function tokenize(line, lineNo, out, problems) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ';') return;
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '[' || c === ']' || c === '|') { out.push({ t: c, line: lineNo }); i += 1; continue; }
    let j = i;
    let word = '';
    while (j < line.length) {
      const d = line[j];
      if (d === ' ' || d === '\t' || d === '\r' || d === ';' || d === '[' || d === ']' || d === '|') break;
      if (d === '(') {
        let depth = 0;
        let quote = '';
        let k = j;
        let closed = false;
        while (k < line.length) {
          const e = line[k];
          if (quote) {
            if (e === quote) quote = '';
          } else if (e === "'" || e === '"') {
            quote = e;
          } else if (e === '(') {
            depth += 1;
          } else if (e === ')') {
            depth -= 1;
            if (depth === 0) { closed = true; k += 1; break; }
          }
          k += 1;
        }
        if (!closed) {
          problems.push({
            line: lineNo,
            severity: SEVERITY.ERROR,
            message: `line ${lineNo}: an operand list opens with "(" and is never closed`,
          });
          return;
        }
        word += line.slice(j, k);
        j = k;
        break;
      }
      word += d;
      j += 1;
    }
    if (word !== '') out.push({ t: word, line: lineNo });
    i = j;
  }
}

/**
 * Split an operand list body on commas that are not inside quotes or nested parentheses.
 * @param {string} inner the text between the parentheses
 * @returns {string[]} the operand source texts, trimmed
 */
function splitOperands(inner) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Turn one word token into an element.
 * @param {object} tok token `{t, line}`
 * @param {object[]} problems problem sink
 * @param {object} [opts] options passed through to {@link createElement}
 * @returns {object|null} the element, or null when the token is not one
 */
function elementFromToken(tok, problems, opts) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\(([\s\S]*)\))?$/.exec(tok.t);
  if (!m) {
    problems.push({
      line: tok.line,
      severity: SEVERITY.ERROR,
      message: `line ${tok.line}: "${tok.t}" is not an instruction — expected a mnemonic, optionally`
        + ' followed by its operands in parentheses',
    });
    return null;
  }
  const mn = m[1].toUpperCase();
  let operands = [];
  if (m[2] != null) {
    const body = m[2].trim();
    if (body !== '') {
      operands = splitOperands(body);
      for (const op of operands) {
        if (op === '') {
          problems.push({
            line: tok.line,
            severity: SEVERITY.ERROR,
            message: `line ${tok.line}: ${mn} has an empty operand — check for a stray comma`,
          });
          return null;
        }
      }
    }
  }
  return createElement(mn, operands, opts);
}

/**
 * Parse a series of nodes out of the token stream until a terminator.
 *
 * @param {object[]} toks the token list
 * @param {number} start index to read from
 * @param {number} depth current branch nesting
 * @param {object[]} problems problem sink
 * @param {object} [opts] parse options
 * @returns {{nodes:object[], next:number, stop:string}|null} the nodes, the index of the
 *   terminator, and which terminator it was; null when the stream is unrecoverable
 */
function parseSeries(toks, start, depth, problems, opts) {
  const nodes = [];
  let i = start;
  while (i < toks.length) {
    const tok = toks[i];
    if (tok.t === '|' || tok.t === ']') return { nodes, next: i, stop: tok.t };
    if (tok.t === '[') {
      if (depth + 1 > MAX_DEPTH) {
        problems.push({
          line: tok.line,
          severity: SEVERITY.ERROR,
          message: `line ${tok.line}: branches nest deeper than ${MAX_DEPTH}, which no rung needs`,
        });
        return null;
      }
      const legs = [];
      let j = i + 1;
      for (;;) {
        const leg = parseSeries(toks, j, depth + 1, problems, opts);
        if (!leg) return null;
        legs.push(leg.nodes);
        if (leg.stop === '|') { j = leg.next + 1; continue; }
        if (leg.stop === ']') { j = leg.next + 1; break; }
        problems.push({
          line: tok.line,
          severity: SEVERITY.ERROR,
          message: `line ${tok.line}: this branch opens with "[" and is never closed with "]"`,
        });
        return null;
      }
      if (legs.length === 1) {
        // Harmless, but say so: a one-legged branch is a series wearing brackets, and leaving it
        // in the tree would break the invariant every editing operation relies on.
        problems.push({
          line: tok.line,
          severity: SEVERITY.WARNING,
          message: `line ${tok.line}: a branch with one leg is just a series — the brackets were dropped`,
        });
        nodes.push(...legs[0]);
      } else {
        nodes.push(createBranch(legs));
      }
      i = j;
      continue;
    }
    const el = elementFromToken(tok, problems, opts);
    if (!el) return null;
    nodes.push(el);
    i += 1;
  }
  return { nodes, next: i, stop: '' };
}

/**
 * Parse program text.
 *
 * Never throws. A file the parser cannot read comes back as `{ok:false, problems}` where every
 * problem names its line and says what was expected, because "unexpected token" with no line is
 * the reason people give up on text formats.
 *
 * @param {string} text the source
 * @param {object} [opts] options
 * @param {object} [opts.specs] mnemonic table used to classify elements for rendering
 * @returns {{ok:boolean, prog?:object, problems?:Array<{line:number, severity:string, message:string}>}}
 *   the program and any warnings, or the refusal and its problems
 */
export function programFromText(text, opts) {
  const problems = [];
  try {
    if (typeof text !== 'string') {
      return { ok: false, problems: [{ line: 0, severity: SEVERITY.ERROR, message: 'there is no text to parse' }] };
    }
    const prog = createProgram('');
    const lines = text.split(/\r?\n/);
    let rung = null;
    let toks = [];
    let openedAt = 0;

    /**
     * Close the rung being accumulated and add it to the program.
     * @returns {boolean} whether the rung parsed
     */
    function closeRung() {
      const parsed = parseSeries(toks, 0, 0, problems, opts);
      if (!parsed) return false;
      if (parsed.stop === ']') {
        problems.push({
          line: toks[parsed.next].line,
          severity: SEVERITY.ERROR,
          message: `line ${toks[parsed.next].line}: a "]" closes a branch that was never opened`,
        });
        return false;
      }
      if (parsed.stop === '|') {
        problems.push({
          line: toks[parsed.next].line,
          severity: SEVERITY.ERROR,
          message: `line ${toks[parsed.next].line}: a "|" separates branch legs and this one is`
            + ' outside any branch',
        });
        return false;
      }
      rung.nodes = parsed.nodes;
      normalizeRung(rung);
      prog.rungs.push(rung);
      rung = null;
      toks = [];
      return true;
    }

    for (let n = 0; n < lines.length; n += 1) {
      const lineNo = n + 1;
      const raw = lines[n];
      const trimmed = raw.trim();

      if (rung) {
        if (/^END\b/i.test(trimmed)) {
          if (!closeRung()) return { ok: false, problems };
          continue;
        }
        if (/^(DISABLED\s+)?RUNG\b/i.test(trimmed) || /^PROGRAM\b/i.test(trimmed)) {
          problems.push({
            line: lineNo,
            severity: SEVERITY.ERROR,
            message: `line ${lineNo}: the rung opened on line ${openedAt} was never closed with END`,
          });
          return { ok: false, problems };
        }
        const before = toks.length;
        tokenize(raw, lineNo, toks, problems);
        if (problems.some((p) => p.severity === SEVERITY.ERROR)) return { ok: false, problems };
        // An END written inline, `XIC(I.A) OTE(Q.B) END`, terminates the rung just as a line of
        // its own does — hand-written files do this constantly and refusing them is pedantry.
        for (let k = before; k < toks.length; k += 1) {
          if (/^END$/i.test(toks[k].t)) {
            toks.length = k;
            if (!closeRung()) return { ok: false, problems };
            break;
          }
        }
        continue;
      }

      if (trimmed === '' || trimmed.startsWith(';')) continue;

      let m = /^PROGRAM\b\s*(.*)$/i.exec(trimmed);
      if (m) { prog.name = cleanLine(m[1]); continue; }

      m = /^VERSION\b\s*(.*)$/i.exec(trimmed);
      if (m) {
        const v = Number(m[1].trim());
        if (!Number.isFinite(v)) {
          problems.push({
            line: lineNo,
            severity: SEVERITY.ERROR,
            message: `line ${lineNo}: VERSION wants a number and got "${m[1].trim()}"`,
          });
          return { ok: false, problems };
        }
        prog.v = v;
        continue;
      }

      m = /^META\b\s*([^=\s]+)\s*=\s*(.*)$/i.exec(trimmed);
      if (m) { prog.meta[m[1]] = m[2].trim(); continue; }

      if (/^META\b/i.test(trimmed)) {
        problems.push({
          line: lineNo,
          severity: SEVERITY.ERROR,
          message: `line ${lineNo}: META wants "META key = value"`,
        });
        return { ok: false, problems };
      }

      m = /^(DISABLED\s+)?RUNG\b\s*(.*)$/i.exec(trimmed);
      if (m) {
        rung = createRung(m[2]);
        rung.enabled = !m[1];
        openedAt = lineNo;
        toks = [];
        continue;
      }

      if (/^END\b/i.test(trimmed)) {
        problems.push({
          line: lineNo,
          severity: SEVERITY.ERROR,
          message: `line ${lineNo}: END without a RUNG to close`,
        });
        return { ok: false, problems };
      }

      problems.push({
        line: lineNo,
        severity: SEVERITY.ERROR,
        message: `line ${lineNo}: expected PROGRAM, VERSION, META, RUNG or a ";" comment, and got`
          + ` "${trimmed.slice(0, 40)}"`,
      });
      return { ok: false, problems };
    }

    if (rung) {
      problems.push({
        line: openedAt,
        severity: SEVERITY.ERROR,
        message: `line ${openedAt}: this rung reaches the end of the file without an END`,
      });
      return { ok: false, problems };
    }

    return { ok: true, prog, problems };
  } catch (err) {
    // A parser that throws takes the editor down with it. Whatever went wrong, it comes back as
    // a problem the operator can read.
    return {
      ok: false,
      problems: [{
        line: 0,
        severity: SEVERITY.ERROR,
        message: `the program text could not be read: ${err && err.message ? err.message : String(err)}`,
      }],
    };
  }
}
