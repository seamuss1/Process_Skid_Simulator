/**
 * tests/model.test.js — the ladder program document: the tree, the paths that address it, the
 * editing operations that must never leave it malformed, and the text format.
 *
 * The tree tests are the ones that matter. A branch left with a single leg, or an element removed
 * along with the leg that held it, still renders and still evaluates — it just quietly means
 * something else, and nobody traces that back to the edit that caused it. So every operation is
 * checked for what it leaves behind, not only for what it returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_VERSION, KIND, BRANCH, SEVERITY, OPERAND,
  createProgram, createRung, createElement, createBranch, cloneProgram,
  addRung, removeRung, moveRung, rungById,
  addElement, removeElement, replaceElement,
  addBranch, removeBranch, addBranchLeg, removeBranchLeg,
  elementAt, legAt, walkElements, pathsOf, branchPathsOf, isBranch, isElement,
  operandKind, operandValue,
  validateProgram, programToText, programFromText,
} from '../src/plc/model.js';

/** A program in canonical form whose one long rung nests branches three deep. */
const NESTED = [
  'PROGRAM Nested branches',
  'VERSION 1',
  'META author = house',
  'META revision = 3',
  '',
  'RUNG three deep: a bypass inside a bypass inside a bypass',
  '  XIC(I.SUCT) [ XIC(M.A) [ XIC(M.B) [ XIC(M.C) | XIC(M.D) ] | ] | XIO(M.E) ] OTE(Q.P1_START)',
  'END',
  '',
  'RUNG a second rung, to prove the blank line between rungs survives',
  '  XIC(M.RUN) TON(T.DLY, 8000) OTE(Q.HORN)',
  'END',
  '',
].join('\n');

/**
 * The structure of a program with the runtime-only rung handles stripped, for comparing two loads
 * of the same document.
 * @param {object} prog the program
 * @returns {object} a plain comparable shape
 */
function shape(prog) {
  return {
    v: prog.v,
    name: prog.name,
    meta: prog.meta,
    rungs: prog.rungs.map((r) => ({ comment: r.comment, enabled: r.enabled, nodes: r.nodes })),
  };
}

/**
 * Parse text that is expected to be good.
 * @param {string} text program text
 * @returns {object} the program
 */
function parse(text) {
  const res = programFromText(text);
  assert.ok(res.ok, `this text should parse: ${JSON.stringify(res.problems)}`);
  return res.prog;
}

/**
 * A rung carrying `XIC(M.A) XIC(M.B) OTE(Q.C)`.
 * @returns {object} the rung
 */
function simpleRung() {
  const r = createRung('three in series');
  addElement(r, [0], createElement('XIC', ['M.A']));
  addElement(r, [1], createElement('XIC', ['M.B']));
  addElement(r, [2], createElement('OTE', ['Q.C']));
  return r;
}

// --- construction and the rung list -----------------------------------------------------------

test('a new program is versioned, named and empty', () => {
  const p = createProgram('Station');
  assert.equal(p.v, MODEL_VERSION, 'the document version is what tells a future load what it is reading');
  assert.equal(p.name, 'Station', 'the name is the title the editor shows');
  assert.deepEqual(p.rungs, [], 'a new program holds no logic');
  assert.deepEqual(p.meta, {}, 'and no metadata');
});

test('an element knows how it draws and a branch is never mistaken for one', () => {
  const el = createElement('xic', ['I.PT101']);
  assert.equal(el.mnemonic, 'XIC', 'mnemonics are case-insensitive on the way in and uppercase in the model');
  assert.equal(el.kind, KIND.CONTACT, 'XIC has to render as a contact or the rung is undrawable');
  assert.equal(createElement('TON', ['T.A', '8000']).kind, KIND.BLOCK, 'a timer draws as a box');
  assert.equal(createElement('WIDGET', []).kind, KIND.BLOCK,
    'an instruction this file has never heard of must still render, not break the load');
  const br = createBranch();
  assert.equal(br.kind, BRANCH, 'a branch carries its own kind so nothing switching on KIND sees it');
  assert.equal(br.legs.length, 2, 'a branch with fewer than two legs is not a branch');
  assert.ok(isBranch(br) && !isElement(br), 'isBranch and isElement must disagree about a branch');
  assert.ok(isElement(el) && !isBranch(el), 'and about an element');
});

test('rungs go in where they are asked to and come back by handle', () => {
  const p = createProgram('p');
  const a = createRung('a');
  const b = createRung('b');
  const c = createRung('c');
  addRung(p, a);
  addRung(p, b);
  addRung(p, c, 1);
  assert.deepEqual(p.rungs.map((r) => r.comment), ['a', 'c', 'b'],
    'an index inserts before the rung that is there, because scan order is the program');
  assert.equal(rungById(p, c.id).comment, 'c', 'the handle is how the solver and editor find a rung');
  assert.equal(rungById(p, 'nope'), null, 'an unknown handle is null, not a throw');
});

test('a rung pasted in under a handle the program already uses is given a fresh one', () => {
  const p = createProgram('p');
  const a = createRung('original');
  addRung(p, a);
  const copy = { id: a.id, comment: 'pasted', nodes: [], enabled: true };
  const res = addRung(p, copy);
  assert.ok(res.ok, 'a paste must not be refused');
  assert.notEqual(copy.id, a.id,
    'two rungs sharing a handle make the power monitor light the wrong rung, and nobody links that to the paste');
  assert.equal(p.rungs.length, 2, 'and both rungs are in the program');
});

test('addRung refuses anything that is not a rung instead of corrupting the program', () => {
  const p = createProgram('p');
  const res = addRung(p, { comment: 'not a rung' });
  assert.equal(res.ok, false, 'an object with no node list is not a rung');
  assert.match(res.reason, /rung/i, 'the refusal has to say what was wrong');
  assert.equal(p.rungs.length, 0, 'and nothing may be left in the program');
});

test('a rung refuses to move off either end of the program rather than silently staying put', () => {
  const p = createProgram('p');
  const a = createRung('a');
  const b = createRung('b');
  addRung(p, a);
  addRung(p, b);
  assert.equal(moveRung(p, a.id, -1).ok, false, 'the first rung cannot move up');
  assert.match(moveRung(p, b.id, 3).reason, /below the last/, 'and the reason must name the end it hit');
  assert.ok(moveRung(p, a.id, 1).ok, 'a legal move is allowed');
  assert.deepEqual(p.rungs.map((r) => r.comment), ['b', 'a'], 'and it actually moves the rung');
  assert.equal(removeRung(p, 'ghost').ok, false, 'removing a rung that is not there is a refusal');
  assert.ok(removeRung(p, a.id).ok, 'and removing one that is there works');
});

// --- paths ------------------------------------------------------------------------------------

test('elements are addressed by path and walked in the order the scan evaluates them', () => {
  const prog = parse(NESTED);
  const rung = prog.rungs[0];
  const seen = [];
  walkElements(rung, (el) => seen.push(el.operands[0]));
  assert.deepEqual(seen, ['I.SUCT', 'M.A', 'M.B', 'M.C', 'M.D', 'M.E', 'Q.P1_START'],
    'the walk must follow power flow: series left to right, and each branch leg from the top');
  const paths = pathsOf(rung);
  assert.equal(paths.length, seen.length, 'every element walked must have a path');
  for (let i = 0; i < paths.length; i += 1) {
    assert.equal(elementAt(rung, paths[i]).operands[0], seen[i],
      'a path must resolve back to the element it was collected from, or the editor selects the wrong cell');
  }
});

test('a path alternates node index and leg index, so its length says what it addresses', () => {
  const rung = parse(NESTED).rungs[0];
  assert.equal(elementAt(rung, [1, 0, 1, 0, 1, 0, 0]).operands[0], 'M.C',
    'seven indices address a node three branches deep');
  assert.ok(isBranch(elementAt(rung, [1, 0, 1])), 'three indices land on the middle branch');
  assert.equal(elementAt(rung, [1, 0]), null,
    'an even-length path addresses a leg, and asking for an element there must return nothing');
  assert.equal(legAt(rung, [1, 1]).length, 1, 'leg 1 of the outer branch holds the single XIO');
  assert.equal(legAt(rung, [1, 0, 1, 1]).length, 0, 'and the empty leg is a short, not a missing leg');
  assert.equal(legAt(rung, [1]), null, 'an odd-length path is not a leg');
  assert.equal(elementAt(rung, [99]), null, 'a path past the end is null, never a throw');
  assert.equal(elementAt(rung, 'nonsense'), null, 'and so is a path that is not even a path');
  assert.deepEqual(branchPathsOf(rung), [[1], [1, 0, 1], [1, 0, 1, 0, 1]],
    'branch paths come back outermost first so the editor can offer the enclosing branch');
});

// --- editing, and the invariants it must leave behind -----------------------------------------

test('an element goes in at the position its path names and appends one past the end', () => {
  const r = simpleRung();
  assert.ok(addElement(r, [1], createElement('XIO', ['M.X'])).ok, 'inserting mid-rung is allowed');
  assert.deepEqual(pathsOf(r).map((p) => elementAt(r, p).operands[0]), ['M.A', 'M.X', 'M.B', 'Q.C'],
    'the new element takes the index it asked for and pushes the rest right');
  assert.ok(addElement(r, [4], createElement('OTE', ['Q.D'])).ok, 'a path one past the end appends');
  assert.equal(addElement(r, [9], createElement('OTE', ['Q.E'])).ok, false,
    'but a path beyond that is a refusal, not a hole in the list');
  assert.equal(addElement(r, [0], createBranch()).ok, false, 'addElement must not accept a branch');
});

test('a branch wraps the element it is added around and leaves an empty leg beside it', () => {
  const r = simpleRung();
  assert.ok(addBranch(r, [0]).ok, 'branching around the first contact is the commonest edit there is');
  const br = elementAt(r, [0]);
  assert.ok(isBranch(br), 'the element must have been replaced by a branch');
  assert.equal(br.legs[0][0].operands[0], 'M.A', 'leg 0 keeps what was selected');
  assert.deepEqual(br.legs[1], [], 'and leg 1 is the empty parallel path waiting to be filled in');
  assert.ok(addElement(r, [0, 1, 0], createElement('XIC', ['Q.C'])).ok, 'which is where the seal-in goes');
  assert.equal(elementAt(r, [0, 1, 0]).operands[0], 'Q.C', 'and it lands inside the leg');
  assert.equal(addBranch(r, [7]).ok, false, 'branching around nothing is a refusal');
});

test('removing the last leg of a branch removes the branch and keeps its survivor in the series', () => {
  const r = simpleRung();
  addBranch(r, [0]);
  addElement(r, [0, 1, 0], createElement('XIC', ['Q.C']));
  assert.ok(removeBranchLeg(r, [0, 1]).ok, 'deleting the parallel path is allowed');
  assert.ok(isElement(elementAt(r, [0])), 'a one-legged branch may not survive the edit');
  assert.equal(elementAt(r, [0]).operands[0], 'M.A', 'the surviving leg is spliced back into the series');
  assert.deepEqual(pathsOf(r).map((p) => elementAt(r, p).operands[0]), ['M.A', 'M.B', 'Q.C'],
    'and the rung reads exactly as it did before the branch was ever added');
  assert.equal(removeBranchLeg(r, [0, 1]).ok, false, 'there is no branch left to take a leg from');
});

test('a branch with three legs loses one and stays a branch', () => {
  const r = simpleRung();
  addBranch(r, [0]);
  addBranchLeg(r, [0]);
  assert.equal(elementAt(r, [0]).legs.length, 3, 'a branch takes as many parallel paths as are asked for');
  assert.ok(removeBranchLeg(r, [0, 2]).ok, 'and gives one back');
  assert.equal(elementAt(r, [0]).legs.length, 2, 'two legs is still a branch and must not collapse');
  assert.equal(addBranchLeg(r, [1]).ok, false, 'asking a plain element for another leg is a refusal');
});

test('removing a whole branch keeps its first leg, because that is the path drawn first', () => {
  const r = simpleRung();
  addBranch(r, [0]);
  addElement(r, [0, 1, 0], createElement('XIC', ['Q.C']));
  assert.ok(removeBranch(r, [0]).ok, 'the branch can be taken out in one operation');
  assert.deepEqual(pathsOf(r).map((p) => elementAt(r, p).operands[0]), ['M.A', 'M.B', 'Q.C'],
    'leg 0 stays in the series; losing it to one mis-click would be unrecoverable');
  assert.equal(removeBranch(r, [0]).ok, false, 'and removing a branch that is not there is refused');
});

test('removing the last element of a rung leaves an empty rung, not a broken one', () => {
  const r = createRung('one contact');
  addElement(r, [0], createElement('XIC', ['M.A']));
  assert.ok(removeElement(r, [0]).ok, 'the last element can be deleted');
  assert.deepEqual(r.nodes, [], 'and what is left is an empty node list');
  assert.deepEqual(pathsOf(r), [], 'an empty rung has no paths and must not throw when walked');
  assert.equal(programToText(createProgram('p')).includes('undefined'), false,
    'and an empty document prints without a hole in it');
});

test('removing the last element of a branch leg leaves the leg as a short across the branch', () => {
  const r = simpleRung();
  addBranch(r, [0]);
  addElement(r, [0, 1, 0], createElement('XIC', ['Q.C']));
  assert.ok(removeElement(r, [0, 1, 0]).ok, 'the element in the parallel path can be deleted');
  const br = elementAt(r, [0]);
  assert.ok(isBranch(br), 'emptying a leg must not destroy the branch the operator drew');
  assert.deepEqual(br.legs[1], [], 'the leg stays, empty — that is a short, and it is legal ladder');
});

test('every editing operation refuses a path that is not in the tree rather than throwing', () => {
  const r = simpleRung();
  const bad = [
    () => addElement(r, [0, 4, 0], createElement('XIC', ['M.Z'])),
    () => removeElement(r, [17]),
    () => removeElement(r, []),
    () => replaceElement(r, [17], createElement('XIC', ['M.Z'])),
    () => replaceElement(r, [0], createBranch()),
    () => addBranch(r, [-1]),
    () => addBranchLeg(r, [0, 0]),
    () => removeBranchLeg(r, [0]),
    () => removeBranch(r, [1, 0, 0]),
  ];
  for (const call of bad) {
    const res = call();
    assert.equal(res.ok, false, 'a bad path must come back as a refusal');
    assert.equal(typeof res.reason, 'string', 'and the refusal must carry a sentence an operator can read');
    assert.ok(res.reason.length > 8, `a reason worth reading, not "${res.reason}"`);
  }
  assert.deepEqual(pathsOf(r).map((p) => elementAt(r, p).operands[0]), ['M.A', 'M.B', 'Q.C'],
    'and none of them may have touched the rung');
});

test('replaceElement swaps one instruction for another and leaves the tree alone', () => {
  const r = simpleRung();
  assert.ok(replaceElement(r, [1], createElement('XIO', ['M.B'])).ok, 'swapping a contact is allowed');
  assert.equal(elementAt(r, [1]).mnemonic, 'XIO', 'and the instruction really changes');
  assert.equal(r.nodes.length, 3, 'without changing the shape of the rung');
});

test('cloneProgram is deep, so an undo snapshot cannot be edited from under the editor', () => {
  const p = parse(NESTED);
  const copy = cloneProgram(p);
  copy.rungs[0].nodes[0].operands[0] = 'M.CHANGED';
  copy.rungs[0].comment = 'changed';
  copy.meta.author = 'someone else';
  assert.equal(p.rungs[0].nodes[0].operands[0], 'I.SUCT', 'the original element must not move');
  assert.equal(p.rungs[0].comment, 'three deep: a bypass inside a bypass inside a bypass',
    'nor the original comment');
  assert.equal(p.meta.author, 'house', 'nor the original metadata');
});

// --- the text format --------------------------------------------------------------------------

test('a program with branches nested three deep survives the text round trip exactly', () => {
  const prog = parse(NESTED);
  assert.equal(programToText(prog), NESTED,
    'canonical text must be a fixed point, or two identical programs diff as different');
  const again = parse(programToText(prog));
  assert.deepEqual(shape(again), shape(prog),
    'and the second load must be the same document, not merely a similar one');
});

test('the round trip preserves the empty leg, which is the difference between a short and a gap', () => {
  const prog = parse(NESTED);
  const mid = elementAt(prog.rungs[0], [1, 0, 1]);
  assert.equal(mid.legs.length, 2, 'the middle branch has two legs');
  assert.deepEqual(mid.legs[1], [], 'and the second is empty on the way in');
  const back = parse(programToText(prog));
  assert.deepEqual(elementAt(back.rungs[0], [1, 0, 1]).legs[1], [],
    'an empty leg that comes back populated, or missing, changes what the rung means');
});

test('a disabled rung keeps its comment and its logic through the round trip', () => {
  const text = [
    'PROGRAM p',
    'VERSION 1',
    '',
    'DISABLED RUNG commissioning override, left in the file on purpose',
    '  XIC(M.OVERRIDE) OTE(Q.P2_START)',
    'END',
    '',
  ].join('\n');
  const prog = parse(text);
  assert.equal(prog.rungs[0].enabled, false, 'DISABLED is what keeps a rung in the file but out of the scan');
  assert.equal(prog.rungs[0].nodes.length, 2, 'a disabled rung still holds its logic');
  assert.equal(programToText(prog), text, 'and it prints back exactly as it was written');
});

test('metadata and the program name survive, and metadata prints in a fixed order', () => {
  const p = createProgram('Station 12');
  p.meta.zeta = 'last';
  p.meta.alpha = 'first';
  addRung(p, simpleRung());
  const text = programToText(p);
  assert.ok(text.indexOf('META alpha') < text.indexOf('META zeta'),
    'unsorted metadata makes a program diff against itself depending on key order');
  const back = parse(text);
  assert.equal(back.name, 'Station 12', 'the name has to survive');
  assert.deepEqual(back.meta, { alpha: 'first', zeta: 'last' }, 'and so does every key');
});

test('a rung too long for one line is broken up and still parses to the same tree', () => {
  const r = createRung('a rung with more contacts than fit on a line');
  for (let i = 0; i < 14; i += 1) addElement(r, [i], createElement('XIC', [`M.CONDITION_${i}`]));
  addElement(r, [14], createElement('OTE', ['Q.SOMETHING_LONG']));
  const p = createProgram('wide');
  addRung(p, r);
  const text = programToText(p);
  const body = text.split('\n').filter((l) => l.startsWith('  '));
  assert.ok(body.length > 1, 'a rung wider than the page must be broken across lines');
  for (const line of body) assert.ok(line.length <= 120, `a wrapped line stayed absurdly long: ${line}`);
  assert.deepEqual(shape(parse(text)), shape(p), 'and the broken-up form must parse to the same rung');
  assert.equal(programToText(parse(text)), text, 'and reprint identically');
});

test('a branch too wide for one line is printed one leg per line and reads the same way back', () => {
  const r = createRung('wide branch');
  const legs = [];
  for (let g = 0; g < 4; g += 1) {
    legs.push([createElement('XIC', [`M.PERMISSIVE_NUMBER_${g}`]), createElement('XIO', [`M.INHIBIT_${g}`])]);
  }
  addElement(r, [0], createElement('XIC', ['I.SUCT']));
  const p = createProgram('wide branch');
  addRung(p, r);
  r.nodes.push(createBranch(legs));
  r.nodes.push(createElement('OTE', ['Q.P1_START']));
  const text = programToText(p);
  assert.ok(text.includes('\n  | '), 'each parallel leg gets its own line so the branch can be read');
  assert.deepEqual(shape(parse(text)), shape(p), 'and it parses back to the same four legs');
  assert.equal(programToText(parse(text)), text, 'and reprints identically');
});

test('whitespace, case and an inline END are all accepted, and normalised on the way out', () => {
  const prog = parse('program p\n; a comment\nrung seal in\nxic(M.A)[xic(M.B)|xic(Q.C)]ote(Q.C) end\n');
  assert.equal(prog.name, 'p', 'headers are case-insensitive');
  assert.equal(prog.rungs.length, 1, 'an END written on the same line as the logic still closes the rung');
  assert.equal(prog.rungs[0].nodes.length, 3, 'brackets need no spaces around them');
  assert.equal(prog.rungs[0].nodes[0].mnemonic, 'XIC', 'mnemonics come out uppercase');
  assert.ok(programToText(prog).includes('  XIC(M.A) [ XIC(M.B) | XIC(Q.C) ] OTE(Q.C)\n'),
    'and the canonical form is what a hand-written file is reformatted to');
});

test('an operand keeps the case it was written in, because a tag name is not a keyword', () => {
  const prog = parse("PROGRAM p\nRUNG c\n  xic(I.Pt101) alarm(M.A, 'Low Flow')\nEND\n");
  assert.equal(prog.rungs[0].nodes[0].operands[0], 'I.Pt101',
    'folding a tag name would break every lookup against a database that stores it as written');
  assert.equal(operandValue(prog.rungs[0].nodes[1].operands[1]), 'Low Flow',
    'and an operator-facing message must not be shouted at them either');
});

test('a comment inside a rung body is dropped and the logic around it is kept', () => {
  const prog = parse('PROGRAM p\nRUNG c\n  XIC(M.A) ; this contact proves the suction\n  OTE(Q.B)\nEND\n');
  assert.equal(prog.rungs[0].nodes.length, 2, 'a trailing comment must not swallow the next line');
  assert.equal(prog.rungs[0].nodes[1].operands[0], 'Q.B', 'and the coil after it survives');
});

test('a rung comment containing a semicolon is kept whole, because the header is a whole line', () => {
  const text = 'PROGRAM p\nVERSION 1\n\nRUNG start the lead pump; then wait for the header\n  XIC(M.A) OTE(Q.B)\nEND\n';
  const prog = parse(text);
  assert.equal(prog.rungs[0].comment, 'start the lead pump; then wait for the header',
    'a rung comment is prose and must not be truncated at a punctuation mark');
  assert.equal(programToText(prog), text, 'and it round-trips whole');
});

test('a branch written with one leg is flattened with a warning rather than left as a fake branch', () => {
  const res = programFromText('PROGRAM p\nRUNG c\n  [ XIC(M.A) ] OTE(Q.B)\nEND\n');
  assert.ok(res.ok, 'brackets round a single leg are harmless and must not fail the load');
  assert.equal(res.prog.rungs[0].nodes.length, 2, 'the brackets are dropped and the contact stays in series');
  assert.ok(res.problems.some((p) => p.severity === SEVERITY.WARNING && p.line === 3),
    'but the operator is told, on the line it happened, that their branch was not a branch');
});

// --- refusing bad text ------------------------------------------------------------------------

test('malformed text is refused with the line and the reason, and never by throwing', () => {
  const cases = [
    ['PROGRAM p\nRUNG a\n  XIC(M.A) [ XIC(M.B) | XIC(M.C)\nEND\n', 3, /never closed/i],
    ['PROGRAM p\nRUNG a\n  XIC(M.A) ] OTE(Q.B)\nEND\n', 3, /never opened/i],
    ['PROGRAM p\nRUNG a\n  XIC(M.A) | XIC(M.B)\nEND\n', 3, /outside any branch/i],
    ['PROGRAM p\nEND\n', 2, /END without a RUNG/i],
    ['PROGRAM p\nHELLO SAILOR\n', 2, /expected PROGRAM/i],
    ['PROGRAM p\nRUNG a\n  XIC(M.A\nEND\n', 3, /never closed/i],
    ['PROGRAM p\nRUNG a\n  TON(T.A,)\nEND\n', 3, /empty operand/i],
    ['PROGRAM p\nRUNG a\n  XIC(M.A) OTE(Q.B)\n', 2, /without an END/i],
    ['PROGRAM p\nRUNG a\n  XIC(M.A)\nRUNG b\n  XIC(M.B)\nEND\n', 4, /never closed with END/i],
    ['PROGRAM p\nVERSION banana\n', 2, /wants a number/i],
    ['PROGRAM p\nMETA nokeyvalue\n', 2, /META key = value/i],
    ['PROGRAM p\nRUNG a\n  9LIVES(M.A)\nEND\n', 3, /not an instruction/i],
  ];
  for (const [text, line, re] of cases) {
    const res = programFromText(text);
    assert.equal(res.ok, false, `this should have been refused: ${JSON.stringify(text)}`);
    assert.ok(Array.isArray(res.problems) && res.problems.length > 0, 'a refusal must come with problems');
    const hit = res.problems.filter((p) => p.severity === SEVERITY.ERROR);
    assert.ok(hit.length > 0, 'and at least one of them must be an error');
    assert.ok(hit.some((p) => p.line === line),
      `the problem must point at line ${line}, got ${JSON.stringify(hit.map((p) => p.line))}`);
    assert.ok(hit.some((p) => re.test(p.message)),
      `the message must say why: ${JSON.stringify(hit.map((p) => p.message))}`);
  }
});

test('the parser refuses rubbish of any type without taking the editor down with it', () => {
  for (const junk of [null, undefined, 42, {}, [], ' ', 'RUNG', '[[[[[[[[[[[[[[[[']) {
    const res = programFromText(junk);
    assert.equal(typeof res.ok, 'boolean', `programFromText must answer for ${JSON.stringify(junk)}`);
    if (!res.ok) {
      assert.ok(res.problems.length > 0, 'a refusal always says something');
      for (const p of res.problems) {
        assert.equal(typeof p.line, 'number', 'every problem carries a line, even if it is 0');
        assert.equal(typeof p.message, 'string', 'and a message');
      }
    }
  }
});

test('an empty document and an empty rung both print and parse without complaint', () => {
  const p = createProgram('empty');
  addRung(p, createRung('nothing here yet'));
  const text = programToText(p);
  assert.equal(text, 'PROGRAM empty\nVERSION 1\n\nRUNG nothing here yet\nEND\n',
    'an empty rung prints as its header and its END, which is what an editor shows for a new rung');
  assert.deepEqual(shape(parse(text)), shape(p), 'and it reads back as the same empty rung');
});

// --- operands ---------------------------------------------------------------------------------

test('operands are classified so a jump label is never mistaken for a missing tag', () => {
  assert.equal(operandKind('I.PT101'), OPERAND.TAG, 'the dot is what makes a name a tag reference');
  assert.equal(operandKind('T.STAGE_DLY'), OPERAND.TAG, 'and it holds for every scope');
  assert.equal(operandKind('8000'), OPERAND.NUMBER, 'a timer preset is a literal');
  assert.equal(operandKind('-1.5'), OPERAND.NUMBER, 'and so is a negative one');
  assert.equal(operandKind("'first out'"), OPERAND.STRING, 'an alarm message is a string');
  assert.equal(operandKind('SKIP_LAG'), OPERAND.NAME,
    'a JMP label has no dot, and calling it a tag would report every jump as unresolved');
  assert.equal(operandValue('8000'), 8000, 'a numeric operand decodes to a number');
  assert.equal(operandValue("'first out'"), 'first out', 'a string operand loses its quotes');
  assert.equal(operandValue('I.PT101'), 'I.PT101', 'and a tag stays text — resolving it is the runtime job');
});

test('a quoted operand carrying a comma or a bracket does not break the parser', () => {
  const prog = parse("PROGRAM p\nRUNG c\n  XIC(M.A) ALARM(M.TRIP, 'low flow, stage down [check]')\nEND\n");
  const el = prog.rungs[0].nodes[1];
  assert.equal(el.operands.length, 2, 'the comma inside the quotes is text, not an operand separator');
  assert.equal(operandValue(el.operands[1]), 'low flow, stage down [check]',
    'and the bracket inside the quotes is text, not a branch');
  assert.equal(programToText(prog).includes("'low flow, stage down [check]'"), true,
    'and it prints back with its quotes intact');
});

// --- validation ---------------------------------------------------------------------------------

test('a clean program validates with nothing to say', () => {
  const prog = parse('PROGRAM p\nVERSION 1\n\nRUNG start P-101\n  XIC(I.RUN_PB) XIO(I.P1_FAULT) OTE(Q.P1_START)\nEND\n');
  const db = new Set(['I.RUN_PB', 'I.P1_FAULT', 'Q.P1_START']);
  assert.deepEqual(validateProgram(prog, db), [],
    'a validator that complains about correct logic is one nobody reads the output of');
});

test('validateProgram names the instruction it does not know and the tag the database has not got', () => {
  const prog = parse('PROGRAM p\nRUNG c\n  XIC(I.MISSING) FLOOB(M.A) OTE(Q.P1_START)\nEND\n');
  const problems = validateProgram(prog, new Set(['Q.P1_START']));
  const errors = problems.filter((p) => p.severity === SEVERITY.ERROR);
  assert.ok(errors.some((p) => /FLOOB/.test(p.message)), 'an unknown mnemonic is an error and must be named');
  assert.ok(errors.some((p) => /I\.MISSING/.test(p.message)), 'and so is a tag the database has never heard of');
  for (const p of errors) {
    assert.equal(p.rungId, prog.rungs[0].id, 'every problem names the rung it is on');
    assert.ok(Array.isArray(p.path), 'and the path to the element, so the editor can jump to it');
    assert.ok(elementAt(prog.rungs[0], p.path), 'and that path must actually resolve');
  }
});

test('validateProgram skips the tag check when there is no database to ask', () => {
  const prog = parse('PROGRAM p\nRUNG c\n  XIC(I.WHATEVER) OTE(Q.ANYTHING)\nEND\n');
  assert.deepEqual(validateProgram(prog), [],
    'reporting every tag as missing because no database was passed would bury the real problems');
});

test('validateProgram accepts a predicate as well as a database, so it needs nothing imported', () => {
  const prog = parse('PROGRAM p\nRUNG c\n  XIC(I.A) OTE(Q.B)\nEND\n');
  const asked = [];
  const problems = validateProgram(prog, (name) => { asked.push(name); return name === 'I.A'; });
  assert.deepEqual(asked, ['I.A', 'Q.B'], 'the predicate is asked about every tag operand and nothing else');
  assert.equal(problems.length, 1, 'and only the unknown one is reported');
  assert.match(problems[0].message, /Q\.B/, 'by name');
});

test('validateProgram catches two rungs driving the same coil, which is the classic broken program', () => {
  const prog = parse([
    'PROGRAM p',
    'RUNG first',
    '  XIC(M.A) OTE(Q.P1_START)',
    'END',
    'RUNG second',
    '  XIC(M.B) OTE(Q.P1_START)',
    'END',
  ].join('\n'));
  const dup = validateProgram(prog).filter((p) => p.severity === SEVERITY.ERROR && /Q\.P1_START/.test(p.message));
  assert.equal(dup.length, 1, 'a duplicate destructive coil must be reported exactly once');
  assert.match(dup[0].message, /last one/i,
    'and the message has to explain the symptom: the last rung to scan wins and the first looks dead');
});

test('validateProgram warns about the mistakes that are legal but almost never meant', () => {
  const prog = parse([
    'PROGRAM p',
    'RUNG a coil onto the input image',
    '  XIC(M.A) OTE(I.P1_RUN)',
    'END',
    'RUNG no output at all',
    '  XIC(M.A) XIC(M.B)',
    'END',
    'RUNG nothing here',
    'END',
    'RUNG a contact after a coil',
    '  XIC(M.A) OTE(Q.B) XIC(M.C) OTE(Q.D)',
    'END',
  ].join('\n'));
  const problems = validateProgram(prog);
  assert.equal(problems.filter((p) => p.severity === SEVERITY.ERROR).length, 0,
    'none of these is illegal, and calling them errors would stop a program that runs');
  const warns = problems.filter((p) => p.severity === SEVERITY.WARNING).map((p) => p.message).join(' | ');
  assert.match(warns, /input scan overwrites/, 'a coil onto an input is undone every scan and must be flagged');
  assert.match(warns, /no output instruction/, 'a rung with no output changes nothing');
  assert.match(warns, /empty/, 'and an empty rung is worth one line');
  assert.doesNotMatch(warns, /right of an output/,
    'a contact after a coil is how every latch/unlatch rung is drawn; warning about it is the noise'
    + ' that stops anyone reading the other three');
  const notes = problems.filter((p) => p.severity === SEVERITY.INFO).map((p) => p.message).join(' | ');
  assert.match(notes, /right of an output/, 'it is still worth saying once, at the severity it deserves');
});

test('validateProgram sorts errors above warnings, because that is the order they get fixed in', () => {
  const prog = parse('PROGRAM p\nRUNG c\n  XIC(M.A) OTE(I.P1_RUN) FLOOB(M.B)\nEND\n');
  const problems = validateProgram(prog);
  const first = problems.findIndex((p) => p.severity === SEVERITY.ERROR);
  const lastError = problems.map((p) => p.severity).lastIndexOf(SEVERITY.ERROR);
  const firstWarn = problems.findIndex((p) => p.severity === SEVERITY.WARNING);
  assert.equal(first, 0, 'the first problem shown must be one that stops the program running');
  assert.ok(firstWarn > lastError, 'and no warning may be listed above an error');
});

test('validateProgram refuses to pretend a non-program is fine', () => {
  const problems = validateProgram(null);
  assert.equal(problems.length, 1, 'something that is not a document gets exactly one problem');
  assert.equal(problems[0].severity, SEVERITY.ERROR, 'and it is an error');
});

test('a malformed tree is reported rather than crashing the validator', () => {
  const p = createProgram('bad');
  const r = createRung('hand-built rubbish');
  r.nodes.push({ kind: BRANCH, legs: [[createElement('XIC', ['M.A'])]] });
  r.nodes.push({ kind: 'CONTACT' });
  addRung(p, r);
  const errors = validateProgram(p).filter((x) => x.severity === SEVERITY.ERROR);
  assert.ok(errors.some((x) => /two legs/.test(x.message)),
    'a branch with one leg renders and evaluates but means something else, so it has to be caught');
  assert.ok(errors.some((x) => /neither an instruction nor a branch/.test(x.message)),
    'and a node that is neither must be named, not skipped');
});
