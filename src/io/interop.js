/**
 * src/io/interop.js — the exits. Everything a user builds here in a form some other system will
 * take: the ladder as PLCopen TC6 XML and as a structured-text listing, a tuning as the parameter
 * sheet each family of controllers actually asks for, and a loop audit as one file.
 *
 * Layer L4: imports `plc/model.js`, `control/pid.js`, `control/analysis.js` and `io/export.js`.
 * No DOM, no `Date.now`, no `Math.random` — a timestamp is a string the caller hands in, because
 * an export that stamps itself is an export that cannot be diffed against yesterday's.
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 *
 * A trainer that cannot export is a toy. The two things a user makes here that are worth
 * anything outside the tab are the LOGIC and the TUNING, and both have a specific way of
 * escaping badly.
 *
 * THE LOGIC escapes badly as a screenshot. IEC 61131-3 has exactly one genuinely open
 * interchange format — PLCopen TC6 XML — and every serious platform can at least read it. So
 * that is the primary export, written as a real connection graph rather than as a picture, and
 * it is read back in again: an export nobody has ever re-imported is an export that is quietly
 * wrong. For the platforms that will not read XML there is a structured-text listing, which is
 * not a compilable POU and does not pretend to be — it is the rung logic written down in a
 * language a controls engineer can retype into anything.
 *
 * THE TUNING escapes badly as three numbers. `Kc = 5, Ti = 100, Td = 16` is not a tuning; it is
 * a tuning PLUS an unstated algorithm form and an unstated set of units. Hand those three
 * numbers to a controller in the interacting series form and it runs `Kc = 4, Ti = 80, Td = 20`.
 * Hand them to one whose reset is in repeats per minute and it runs an integral 100 times too
 * fast. Both mistakes are ordinary, both are silent, and both have shut plants down. So a tuning
 * leaves here as a SHEET: named target convention, converted numbers, units spelled out, and a
 * refusal where the conversion does not exist rather than a plausible-looking number.
 *
 * ------------------------------------------------------------------------------------------
 * WHAT "TOLERANT" MEANS ON THE WAY BACK IN
 *
 * {@link programFromPlcOpenXml} never throws and never stops at the first element it has not
 * seen before. A foreign file is full of things this rig has no concept of — SFC bodies, vendor
 * `addData`, edge-triggered contacts, function blocks with instance data. Every one of those
 * comes back as a line in `notes` naming what was dropped and where, and the rest of the program
 * still arrives. A file that gives up on rung 3 of 40 is a file the operator throws away; a file
 * that lands 40 rungs and says "these four things did not survive" is a file they can work with.
 * ------------------------------------------------------------------------------------------
 */

import { FORM, convertForm } from '../control/pid.js';
import {
  createProgram, createRung, createElement, createBranch, addRung,
  isBranch, KIND, ELEMENT_SPECS,
} from '../plc/model.js';
import { loopResponse, margins as readMargins, DEFAULT_GRID } from '../control/analysis.js';
import { trendToCsv } from './export.js';

// =============================================================================================
// PLCopen TC6 — out
// =============================================================================================

/** The TC6 namespace this module writes and the one it recognises without complaint on import. */
export const PLCOPEN_NS = 'http://www.plcopen.org/xml/tc6_0201';

/**
 * The `addData` name under which the one thing PLCopen has no word for is carried.
 *
 * PLCopen can say everything about a network except that the operator has switched it off, so
 * `enabled` rides in a vendor extension marked `handleUnknown="implementation"` — the standard's
 * own way of saying "you may ignore this and the program still means what it says".
 */
const RUNG_DATA_NAME = 'http://process-skid-simulator/plc/rung';

/** The `addData` name under which the program's own header fields ride. */
const PROG_DATA_NAME = 'http://process-skid-simulator/plc/program';

/** Grid pitch for the cosmetic `<position>` elements, in PLCopen's own arbitrary units. */
const GRID_X = 40;
/** Row pitch. Rows are allocated strictly increasing so leg ORDER survives the round trip. */
const GRID_Y = 20;

/**
 * The bit instructions that are a native PLCopen `<contact>` or `<coil>` rather than a block.
 *
 * The test is not "is it a contact in the editor" — `EQU` and `GRT` draw as contacts here and
 * cannot be PLCopen contacts, because a `<contact>` carries exactly one `<variable>` and a
 * comparison needs two operands. So this table is keyed on the instructions that carry ONE bit
 * and nothing else, and everything else in the instruction set becomes a `<block>`, which is
 * both truthful and lossless.
 */
const NATIVE_BITS = Object.freeze({
  XIC: Object.freeze({ tag: 'contact' }),
  XIO: Object.freeze({ tag: 'contact', negated: true }),
  ONS: Object.freeze({ tag: 'contact', edge: 'rising' }),
  OTE: Object.freeze({ tag: 'coil' }),
  OTL: Object.freeze({ tag: 'coil', storage: 'set' }),
  OTU: Object.freeze({ tag: 'coil', storage: 'reset' }),
  OSR: Object.freeze({ tag: 'coil', edge: 'rising' }),
  OSF: Object.freeze({ tag: 'coil', edge: 'falling' }),
});

/**
 * Escape text for an XML attribute or element body.
 *
 * Apostrophes are escaped as well as quotes even though this module always writes double-quoted
 * attributes, because a tag comment containing an apostrophe is ordinary and a reader that
 * re-emits attributes single-quoted is not this module's business.
 *
 * @param {*} v the value
 * @returns {string} the escaped text
 */
function xmlEscape(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render an attribute list, skipping anything undefined so optional attributes simply do not
 * appear rather than appearing empty.
 * @param {Record<string, *>} attrs attribute name to value
 * @returns {string} the attribute text, with a leading space when non-empty
 */
function attrText(attrs) {
  const parts = [];
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}="${xmlEscape(v)}"`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Write a ladder program as PLCopen TC6 XML.
 *
 * Each rung becomes one network: a `<leftPowerRail>`, the elements, and a `<rightPowerRail>`,
 * all in a single `<LD>` body, which is how every tool that writes TC6 LD represents a multi-rung
 * routine. Series is a chain of `connectionPointIn` references. A BRANCH is the one construct
 * worth pointing at: PLCopen expresses an OR by putting SEVERAL `<connection>` children inside
 * ONE `<connectionPointIn>`, which is a wired-or and is exactly what a ladder branch is. An empty
 * leg — the short an operator draws around a contact — is that same wired-or including the
 * branch's own input, so it needs no element and invents nothing.
 *
 * Block operands become `<inVariable>` nodes wired to formal parameters `IN0`, `IN1`, … in
 * operand order, and power enters a block on `EN` and leaves on `ENO`. That is more verbose than
 * stuffing the operands into a vendor extension, and it is the difference between a file another
 * tool can read and a file only this one can.
 *
 * @param {object} prog the program document from `plc/model.js`
 * @param {object} [opts] options
 * @param {string} [opts.pouName] the POU name; defaults to the program name, cleaned to an
 *   IEC identifier
 * @param {string} [opts.at] creation timestamp as an ISO 8601 string. Supplied by the caller,
 *   never read from the clock — see the module header
 * @param {string} [opts.companyName] `fileHeader/@companyName`
 * @param {string} [opts.productName] `fileHeader/@productName`
 * @param {string} [opts.productVersion] `fileHeader/@productVersion`
 * @returns {{ok:boolean, reason?:string, xml?:string}} the document, or a refusal
 */
export function programToPlcOpenXml(prog, opts = {}) {
  if (!prog || !Array.isArray(prog.rungs)) {
    return { ok: false, reason: 'that is not a ladder program document' };
  }
  const at = typeof opts.at === 'string' && opts.at ? opts.at : '1970-01-01T00:00:00';
  const pouName = iecIdentifier(opts.pouName || prog.name || 'Main');

  const body = [];
  const state = { id: 0, row: 0 };
  /**
   * Mint the next `localId`. PLCopen requires them unique within a body, not meaningful.
   * @returns {number} the id
   */
  const nextId = () => { state.id += 1; return state.id; };

  for (const rung of prog.rungs) {
    state.row += 1;
    const rowBase = state.row;
    if (rung.comment) {
      body.push(`      <comment localId="${nextId()}">`);
      body.push(`        <position x="0" y="${(rowBase - 1) * GRID_Y}"/>`);
      body.push('        <content>');
      body.push(`          <xhtml xmlns="http://www.w3.org/1999/xhtml">${xmlEscape(rung.comment)}</xhtml>`);
      body.push('        </content>');
      body.push('      </comment>');
    }
    state.row += 1;
    const railId = nextId();
    body.push(`      <leftPowerRail localId="${railId}">`);
    body.push(`        <position x="0" y="${state.row * GRID_Y}"/>`);
    body.push('        <connectionPointOut formalParameter="none"/>');
    body.push('        <addData>');
    body.push(`          <data name="${RUNG_DATA_NAME}" handleUnknown="implementation">`);
    body.push(`            <rung enabled="${rung.enabled === false ? 'false' : 'true'}"/>`);
    body.push('          </data>');
    body.push('        </addData>');
    body.push('      </leftPowerRail>');

    const ctx = { body, nextId, state, col: 1, row: state.row };
    const out = emitSeries(Array.isArray(rung.nodes) ? rung.nodes : [], [railId], ctx);

    const endId = nextId();
    body.push(`      <rightPowerRail localId="${endId}">`);
    body.push(`        <position x="${(ctx.col + 1) * GRID_X}" y="${ctx.row * GRID_Y}"/>`);
    body.push('        <connectionPointIn>');
    for (const src of out) body.push(`          <connection refLocalId="${src.id}"${src.fp ? ` formalParameter="${src.fp}"` : ''}/>`);
    body.push('        </connectionPointIn>');
    body.push('      </rightPowerRail>');
  }

  const meta = prog.meta && typeof prog.meta === 'object' ? prog.meta : {};
  const metaLines = [];
  for (const key of Object.keys(meta).sort()) {
    const v = meta[key];
    if (v == null || typeof v === 'object') continue;
    metaLines.push(`            <meta${attrText({ key, value: String(v) })}/>`);
  }

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<project xmlns="${PLCOPEN_NS}">`,
    `  <fileHeader${attrText({
      companyName: opts.companyName || 'Process Skid Simulator',
      productName: opts.productName || 'Process Skid Simulator',
      productVersion: opts.productVersion || '1',
      creationDateTime: at,
    })}/>`,
    `  <contentHeader${attrText({ name: prog.name || 'untitled', modificationDateTime: at })}>`,
    '    <coordinateInfo>',
    '      <fbd><scaling x="1" y="1"/></fbd>',
    '      <ld><scaling x="1" y="1"/></ld>',
    '      <sfc><scaling x="1" y="1"/></sfc>',
    '    </coordinateInfo>',
    '  </contentHeader>',
    '  <types>',
    '    <dataTypes/>',
    '    <pous>',
    `      <pou${attrText({ name: pouName, pouType: 'program' })}>`,
    '        <interface>',
    '          <localVars/>',
    '        </interface>',
    '        <body>',
    '          <LD>',
    ...body.map((l) => `    ${l}`),
    '          </LD>',
    '        </body>',
    '        <addData>',
    `          <data name="${PROG_DATA_NAME}" handleUnknown="implementation">`,
    `            <program${attrText({ name: prog.name || 'untitled', v: prog.v })}/>`,
    ...metaLines,
    '          </data>',
    '        </addData>',
    '      </pou>',
    '    </pous>',
    '  </types>',
    '  <instances>',
    '    <configurations/>',
    '  </instances>',
    '</project>',
    '',
  ].join('\n');

  return { ok: true, xml };
}

/**
 * Reduce a name to something an IEC 61131-3 tool will accept as a POU identifier.
 *
 * Spaces and punctuation become underscores and a leading digit gets a letter in front of it,
 * because `pou/@name` is an identifier in the standard and a tool that validates its input will
 * reject the file outright over a space in a name nobody reads.
 *
 * @param {string} s the desired name
 * @returns {string} a legal identifier
 */
function iecIdentifier(s) {
  const cleaned = String(s).trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (cleaned === '') return 'Main';
  return /^[0-9]/.test(cleaned) ? `P_${cleaned}` : cleaned;
}

/**
 * Emit one series list and return the power sources leaving it.
 *
 * A "source" is `{id, fp}` — a `localId` and, for a block, the formal parameter its power leaves
 * on. A series list threads one source through; a branch fans the incoming sources across its
 * legs and hands back the union of the legs' outputs, which is the wired-or.
 *
 * @param {object[]} list the series list
 * @param {Array<{id:number, fp?:string}>|number[]} sources incoming power sources
 * @param {object} ctx emitter state: `body`, `nextId`, `state`, `col`, `row`
 * @returns {Array<{id:number, fp?:string}>} the outgoing power sources
 */
function emitSeries(list, sources, ctx) {
  let cur = sources.map((s) => (typeof s === 'number' ? { id: s } : s));
  for (const node of list) {
    if (isBranch(node)) {
      const outs = [];
      const seen = new Set();
      for (let g = 0; g < node.legs.length; g += 1) {
        // Leg 0 stays on the parent's row; every later leg takes a fresh, strictly higher row.
        // The importer orders legs by their lowest y, so allocating rows in leg order is what
        // makes the drawing order survive a round trip.
        if (g > 0) { ctx.state.row += 1; ctx.row = ctx.state.row; }
        const legCol = ctx.col;
        const got = emitSeries(node.legs[g], cur, ctx);
        ctx.col = Math.max(ctx.col, legCol);
        for (const s of got) {
          const key = `${s.id}#${s.fp || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          outs.push(s);
        }
      }
      cur = outs;
      continue;
    }
    cur = [emitElement(node, cur, ctx)];
  }
  return cur;
}

/**
 * Emit one instruction and return the power source leaving it.
 * @param {object} el the element
 * @param {Array<{id:number, fp?:string}>} sources incoming power
 * @param {object} ctx emitter state
 * @returns {{id:number, fp?:string}} the outgoing power source
 */
function emitElement(el, sources, ctx) {
  const mn = String(el.mnemonic || 'NOP').toUpperCase();
  const ops = Array.isArray(el.operands) ? el.operands : [];
  const native = NATIVE_BITS[mn];
  const x = ctx.col * GRID_X;
  const y = ctx.row * GRID_Y;
  ctx.col += 1;

  /**
   * Render the incoming connections.
   * @param {string} pad indent
   * @returns {string[]} the lines
   */
  const inLines = (pad) => {
    const out = [`${pad}<connectionPointIn>`];
    for (const s of sources) {
      out.push(`${pad}  <connection${attrText({ refLocalId: s.id, formalParameter: s.fp })}/>`);
    }
    out.push(`${pad}</connectionPointIn>`);
    return out;
  };

  if (native && ops.length === 1) {
    const id = ctx.nextId();
    ctx.body.push(`      <${native.tag}${attrText({
      localId: id,
      negated: native.negated ? 'true' : 'false',
      edge: native.edge,
      storage: native.storage,
    })}>`);
    ctx.body.push(`        <position x="${x}" y="${y}"/>`);
    ctx.body.push(...inLines('        '));
    ctx.body.push('        <connectionPointOut/>');
    ctx.body.push(`        <variable>${xmlEscape(ops[0])}</variable>`);
    ctx.body.push(`      </${native.tag}>`);
    return { id };
  }

  // A block. Operands ride on their own `<inVariable>` nodes, in operand order, so a reader
  // that knows nothing about this instruction set still sees what the instruction was given.
  const operandIds = [];
  for (let i = 0; i < ops.length; i += 1) {
    const vid = ctx.nextId();
    operandIds.push(vid);
    ctx.body.push(`      <inVariable localId="${vid}">`);
    ctx.body.push(`        <position x="${x}" y="${y + (i + 1) * 4}"/>`);
    ctx.body.push('        <connectionPointOut/>');
    ctx.body.push(`        <expression>${xmlEscape(ops[i])}</expression>`);
    ctx.body.push('      </inVariable>');
  }
  const id = ctx.nextId();
  ctx.body.push(`      <block${attrText({ localId: id, typeName: mn })}>`);
  ctx.body.push(`        <position x="${x}" y="${y}"/>`);
  ctx.body.push('        <inputVariables>');
  ctx.body.push('          <variable formalParameter="EN">');
  ctx.body.push(...inLines('            '));
  ctx.body.push('          </variable>');
  for (let i = 0; i < operandIds.length; i += 1) {
    ctx.body.push(`          <variable formalParameter="IN${i}">`);
    ctx.body.push('            <connectionPointIn>');
    ctx.body.push(`              <connection refLocalId="${operandIds[i]}"/>`);
    ctx.body.push('            </connectionPointIn>');
    ctx.body.push('          </variable>');
  }
  ctx.body.push('        </inputVariables>');
  ctx.body.push('        <inOutVariables/>');
  ctx.body.push('        <outputVariables>');
  ctx.body.push('          <variable formalParameter="ENO">');
  ctx.body.push('            <connectionPointOut/>');
  ctx.body.push('          </variable>');
  ctx.body.push('        </outputVariables>');
  ctx.body.push('      </block>');
  return { id, fp: 'ENO' };
}

// =============================================================================================
// A very small XML reader
// =============================================================================================

/**
 * Parse XML into a plain tree.
 *
 * Written here rather than taken from the browser because this module has to run under Node in a
 * test and the repo has no dependencies. It handles what a TC6 file contains — the declaration,
 * comments, CDATA, a doctype, attributes in either quote — and nothing it does not: there is no
 * DTD processing, no entity declaration and therefore no XXE surface at all.
 *
 * Namespace prefixes are stripped from element names. PLCopen files in the wild put the TC6
 * namespace on the default prefix, on `ns1:`, or nowhere at all, and refusing two of those three
 * would make the importer useless for exactly the files it exists to read.
 *
 * @param {string} text the source
 * @returns {{ok:boolean, root?:object, reason?:string}} the tree, or a refusal naming the offset
 */
function parseXml(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'there is no XML to read' };
  }
  let i = 0;
  const stack = [];
  let root = null;
  let guard = 0;

  while (i < text.length) {
    guard += 1;
    if (guard > 4e6) return { ok: false, reason: 'this file is too large or too deeply nested to read' };
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i && stack.length) {
      stack[stack.length - 1].text += text.slice(i, lt);
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      if (end < 0) return { ok: false, reason: 'a comment is never closed' };
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      if (end < 0) return { ok: false, reason: 'a CDATA section is never closed' };
      if (stack.length) stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      if (end < 0) return { ok: false, reason: 'a processing instruction is never closed' };
      i = end + 1;
      continue;
    }
    const end = findTagEnd(text, lt);
    if (end < 0) return { ok: false, reason: `a tag opened at character ${lt} is never closed` };
    const raw = text.slice(lt + 1, end);
    i = end + 1;

    if (raw.startsWith('/')) {
      if (stack.length === 0) return { ok: false, reason: `a closing tag </${raw.slice(1).trim()}> has nothing open` };
      stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const inner = selfClosing ? raw.slice(0, -1) : raw;
    const node = readTag(inner);
    if (!node) return { ok: false, reason: `<${inner.slice(0, 40)}> is not a tag this reader can make sense of` };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) return { ok: false, reason: 'this file has more than one root element' };
    else root = node;
    if (!selfClosing) stack.push(node);
  }
  if (!root) return { ok: false, reason: 'this file has no root element' };
  if (stack.length) return { ok: false, reason: `<${stack[stack.length - 1].name}> is never closed` };
  return { ok: true, root };
}

/**
 * Find the `>` that ends a tag, skipping any inside a quoted attribute value.
 * @param {string} text the source
 * @param {number} from the index of the `<`
 * @returns {number} the index of the `>`, or -1
 */
function findTagEnd(text, from) {
  let quote = '';
  for (let k = from + 1; k < text.length; k += 1) {
    const c = text[k];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return k;
  }
  return -1;
}

/**
 * Read a tag's name and attributes.
 * @param {string} inner the text between `<` and `>`, without any trailing `/`
 * @returns {{name:string, attrs:object, children:object[], text:string}|null} the node
 */
function readTag(inner) {
  const m = /^\s*([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)/.exec(inner);
  if (!m) return null;
  const name = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : m[1];
  const attrs = {};
  const re = /([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)\s*=\s*("([^"]*)"|'([^']*)')/g;
  re.lastIndex = m[0].length;
  let a = re.exec(inner);
  while (a) {
    const key = a[1].includes(':') ? a[1].slice(a[1].indexOf(':') + 1) : a[1];
    attrs[key] = xmlUnescape(a[3] !== undefined ? a[3] : a[4]);
    a = re.exec(inner);
  }
  return { name, attrs, children: [], text: '' };
}

/**
 * Decode the five predefined entities and numeric character references.
 * @param {string} s the raw text
 * @returns {string} the decoded text
 */
function xmlUnescape(s) {
  return String(s).replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, (whole, body) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
  });
}

/**
 * The children of a node with a given name, matched without regard to case.
 * @param {object} node the parent, or null
 * @param {string} name the child name
 * @returns {object[]} the matching children
 */
function kids(node, name) {
  if (!node || !Array.isArray(node.children)) return [];
  const want = name.toLowerCase();
  return node.children.filter((c) => c.name.toLowerCase() === want);
}

/**
 * The first child with a given name.
 * @param {object} node the parent, or null
 * @param {string} name the child name
 * @returns {object|null} the child, or null
 */
function kid(node, name) {
  const all = kids(node, name);
  return all.length ? all[0] : null;
}

/**
 * All the text under a node, children included.
 * @param {object} node the node, or null
 * @returns {string} the concatenated text, trimmed
 */
function deepText(node) {
  if (!node) return '';
  let s = node.text || '';
  for (const c of node.children) s += deepText(c);
  return s.trim();
}

/**
 * Depth-first search for the first descendant with a given name.
 * @param {object} node the root
 * @param {string} name the name to find
 * @returns {object|null} the node, or null
 */
function findDeep(node, name) {
  if (!node) return null;
  const want = name.toLowerCase();
  if (node.name.toLowerCase() === want) return node;
  for (const c of node.children) {
    const got = findDeep(c, name);
    if (got) return got;
  }
  return null;
}

// =============================================================================================
// PLCopen TC6 — in
// =============================================================================================

/** How deeply a branch may nest before the importer calls the file pathological. */
const MAX_IMPORT_DEPTH = 16;

/**
 * Read a ladder program back out of PLCopen TC6 XML.
 *
 * Tolerant by construction. The only things that come back `ok:false` are a file that is not
 * well-formed XML and a file with no LD body in it at all; everything else that this rig cannot
 * represent is imported as closely as it can be and named in `notes`. See the module header for
 * why that trade is the right way round.
 *
 * @param {string} xml the document text
 * @param {object} [opts] options
 * @param {object} [opts.specs] mnemonic table used to classify imported elements for rendering,
 *   default {@link ELEMENT_SPECS}
 * @returns {{ok:boolean, reason?:string, prog?:object, notes:string[],
 *   problems:Array<{severity:string, message:string}>}} the program, what could not be
 *   represented, and anything that was outright wrong with the file
 */
export function programFromPlcOpenXml(xml, opts = {}) {
  const notes = [];
  const problems = [];
  const parsed = parseXml(xml);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, notes, problems };

  const root = parsed.root;
  if (root.name.toLowerCase() !== 'project') {
    notes.push(`the root element is <${root.name}>, not <project>; reading it as one anyway`);
  }

  const pous = [];
  const pousNode = findDeep(root, 'pous');
  for (const p of kids(pousNode, 'pou')) pous.push(p);
  if (pous.length === 0) {
    const lone = findDeep(root, 'pou');
    if (lone) pous.push(lone);
  }
  if (pous.length === 0) return { ok: false, reason: 'this file contains no POU', notes, problems };
  if (pous.length > 1) {
    notes.push(`this file holds ${pous.length} POUs; only the first, ${pous[0].attrs.name || 'unnamed'}, was imported`);
  }
  const pou = pous[0];

  const bodies = kids(pou, 'body');
  let ld = null;
  for (const b of bodies) {
    if (kid(b, 'LD')) { ld = kid(b, 'LD'); continue; }
    for (const other of ['FBD', 'SFC', 'ST', 'IL']) {
      if (kid(b, other)) notes.push(`a ${other} body in this POU was skipped — this rig runs ladder only`);
    }
  }
  if (!ld) return { ok: false, reason: 'this POU has no ladder (LD) body', notes, problems };

  // The program's own header fields, when this file came from here. A foreign file has none and
  // falls back to the POU name, which is what a foreign tool would show as the routine name.
  const progData = findAddData(pou, PROG_DATA_NAME);
  const header = progData ? kid(progData, 'program') : null;
  const prog = createProgram(
    (header && header.attrs.name) || pou.attrs.name || 'imported',
  );
  if (header && header.attrs.v && Number.isFinite(Number(header.attrs.v))) prog.v = Number(header.attrs.v);
  if (progData) {
    for (const m of kids(progData, 'meta')) {
      if (m.attrs.key) prog.meta[m.attrs.key] = m.attrs.value === undefined ? '' : m.attrs.value;
    }
  }

  const graph = indexBody(ld, notes, opts);
  const networks = splitNetworks(graph, notes);

  for (const net of networks) {
    const rung = createRung(net.comment);
    rung.enabled = net.enabled;
    const ctx = {
      graph,
      notes,
      problems,
      specs: (opts && opts.specs) || ELEMENT_SPECS,
    };
    rung.nodes = decomposeRegion(net.start, net.end, net.region, ctx, 0);
    const leftOver = [...net.region].filter((id) => !ctx.graph.used.has(id));
    if (leftOver.length) {
      notes.push(`rung ${networks.indexOf(net) + 1}: ${leftOver.length} element(s) sit on a `
        + 'connection pattern that is not a plain series/parallel ladder network and were dropped');
    }
    addRung(prog, rung);
  }

  return { ok: true, prog, notes, problems };
}

/**
 * Find a vendor `addData` block by its name.
 * @param {object} node the element carrying the `<addData>`
 * @param {string} name the data name
 * @returns {object|null} the `<data>` node, or null
 */
function findAddData(node, name) {
  for (const add of kids(node, 'addData')) {
    for (const data of kids(add, 'data')) {
      if (data.attrs.name === name) return data;
    }
  }
  return null;
}

/**
 * Build the connection graph of an LD body.
 *
 * Two kinds of node come out of this. POWER nodes — rails, contacts, coils and blocks — carry
 * power flow and are what a rung is made of. VALUE nodes — `inVariable` and `outVariable` — carry
 * operands and hang off blocks. Keeping them apart is the whole trick: a block's `EN` connection
 * is power and its `IN0` connection is an operand, and a reader that confuses the two turns every
 * numeric preset into a series contact.
 *
 * @param {object} ld the `<LD>` node
 * @param {string[]} notes sink for what could not be represented
 * @param {object} opts importer options
 * @returns {object} the graph
 */
function indexBody(ld, notes, opts) {
  const graph = {
    /** localId -> node record. */
    byId: new Map(),
    /** Document-ordered list of left power rail ids. */
    rails: [],
    /** localId -> the comment text that preceded it. */
    comments: new Map(),
    /** Elements already claimed by a rung, so leftovers can be reported. */
    used: new Set(),
    opts,
  };
  let pendingComment = '';

  for (const el of ld.children) {
    const tag = el.name.toLowerCase();
    if (tag === 'comment') {
      pendingComment = deepText(kid(el, 'content') || el);
      continue;
    }
    const id = Number(el.attrs.localId);
    if (!Number.isFinite(id)) {
      if (tag !== 'connector' && tag !== 'continuation') {
        notes.push(`a <${el.name}> with no localId was skipped`);
      }
      continue;
    }
    const pos = kid(el, 'position');
    const rec = {
      id,
      tag,
      raw: el,
      x: pos ? Number(pos.attrs.x) || 0 : 0,
      y: pos ? Number(pos.attrs.y) || 0 : 0,
      power: [],
      operands: [],
      isPower: false,
      isValue: false,
    };

    if (tag === 'leftpowerrail') {
      rec.isPower = true;
      graph.rails.push(id);
      if (pendingComment) { graph.comments.set(id, pendingComment); pendingComment = ''; }
      const data = findAddData(el, RUNG_DATA_NAME);
      const r = data ? kid(data, 'rung') : null;
      rec.enabled = !(r && r.attrs.enabled === 'false');
    } else if (tag === 'rightpowerrail') {
      rec.isPower = true;
      rec.power = connectionsOf(kid(el, 'connectionPointIn'));
    } else if (tag === 'contact' || tag === 'coil') {
      rec.isPower = true;
      rec.power = connectionsOf(kid(el, 'connectionPointIn'));
      rec.variable = deepText(kid(el, 'variable'));
      rec.negated = el.attrs.negated === 'true';
      rec.edge = (el.attrs.edge || 'none').toLowerCase();
      rec.storage = (el.attrs.storage || 'none').toLowerCase();
    } else if (tag === 'block') {
      rec.isPower = true;
      rec.typeName = el.attrs.typeName || 'NOP';
      const inputs = kids(kid(el, 'inputVariables'), 'variable');
      const positional = [];
      for (const v of inputs) {
        const fp = String(v.attrs.formalParameter || '');
        const conns = connectionsOf(kid(v, 'connectionPointIn'));
        if (fp.toUpperCase() === 'EN') { rec.power = conns; continue; }
        positional.push({ fp, conns });
      }
      if (rec.power.length === 0 && positional.length) {
        // A foreign block with no EN. Ladder power has to come from somewhere, so the first
        // input is taken as the power input and the operator is told, rather than the block
        // being silently orphaned out of its rung.
        notes.push(`block ${rec.typeName} (localId ${id}) has no EN input; its first input was `
          + 'read as the power connection');
        rec.power = positional.shift().conns;
      }
      // `IN0`, `IN1`, … is what this module writes. Anything else keeps document order, which is
      // the only ordering a foreign file offers.
      positional.sort((a, b) => {
        const na = /^IN(\d+)$/i.exec(a.fp);
        const nb = /^IN(\d+)$/i.exec(b.fp);
        if (na && nb) return Number(na[1]) - Number(nb[1]);
        return 0;
      });
      rec.operands = positional;
      const outs = kids(kid(el, 'outputVariables'), 'variable')
        .filter((v) => String(v.attrs.formalParameter || '').toUpperCase() !== 'ENO');
      if (outs.length) {
        notes.push(`block ${rec.typeName} (localId ${id}) has ${outs.length} output(s) besides ENO; `
          + 'this rig carries a block\'s destination as an operand, so they were dropped');
      }
    } else if (tag === 'invariable' || tag === 'outvariable' || tag === 'inoutvariable') {
      rec.isValue = true;
      rec.expression = deepText(kid(el, 'expression')) || deepText(kid(el, 'variable'));
    } else if (tag === 'jump' || tag === 'return' || tag === 'label') {
      rec.isPower = true;
      rec.power = connectionsOf(kid(el, 'connectionPointIn'));
      rec.jumpLabel = el.attrs.label || deepText(el);
      rec.tag = tag;
    } else {
      notes.push(`<${el.name}> (localId ${id}) is not a ladder element this rig knows and was skipped`);
      continue;
    }
    graph.byId.set(id, rec);
  }
  return graph;
}

/**
 * Read the `refLocalId` values out of a `connectionPointIn`.
 *
 * The `formalParameter` on a connection is deliberately thrown away. In ladder an element has one
 * power output, so which named pin the wire left from adds nothing, and honouring it would mean a
 * file that names its pin `ENO` and one that leaves it off describe different graphs when they
 * plainly describe the same rung.
 *
 * @param {object} cpi the `<connectionPointIn>` node, or null
 * @returns {number[]} the source ids, duplicates removed
 */
function connectionsOf(cpi) {
  const out = [];
  for (const c of kids(cpi, 'connection')) {
    const ref = Number(c.attrs.refLocalId);
    if (Number.isFinite(ref) && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * Split the graph into one network per left power rail.
 * @param {object} graph from {@link indexBody}
 * @param {string[]} notes sink
 * @returns {Array<{start:Set<number>, end:Set<number>, region:Set<number>, comment:string,
 *   enabled:boolean}>} the networks, in document order
 */
function splitNetworks(graph, notes) {
  const consumersOf = new Map();
  for (const rec of graph.byId.values()) {
    if (!rec.isPower) continue;
    for (const src of rec.power) {
      if (!consumersOf.has(src)) consumersOf.set(src, []);
      consumersOf.get(src).push(rec.id);
    }
  }

  const nets = [];
  const claimed = new Set();
  for (const railId of graph.rails) {
    const rail = graph.byId.get(railId);
    const region = new Set();
    const ends = [];
    const queue = [railId];
    let guard = 0;
    while (queue.length) {
      guard += 1;
      if (guard > 1e5) break;
      const id = queue.shift();
      for (const next of consumersOf.get(id) || []) {
        if (claimed.has(next) || region.has(next)) continue;
        const rec = graph.byId.get(next);
        if (!rec) continue;
        if (rec.tag === 'rightpowerrail') { ends.push(next); claimed.add(next); continue; }
        region.add(next);
        claimed.add(next);
        queue.push(next);
      }
    }
    if (ends.length > 1) {
      notes.push(`a network has ${ends.length} right power rails; only the first was used as its end`);
    }
    const endRec = ends.length ? graph.byId.get(ends[0]) : null;
    nets.push({
      start: new Set([railId]),
      end: new Set(endRec ? endRec.power : []),
      region,
      comment: graph.comments.get(railId) || '',
      enabled: rail ? rail.enabled !== false : true,
    });
  }
  return nets;
}

/**
 * Are two sets equal?
 * @param {Set<number>} a first
 * @param {Set<number>} b second
 * @returns {boolean} whether they hold the same members
 */
function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Does `a` contain every member of `b`?
 * @param {Set<number>|number[]} a the candidate superset
 * @param {Set<number>} b the candidate subset
 * @returns {boolean} whether a ⊇ b
 */
function superset(a, b) {
  const s = a instanceof Set ? a : new Set(a);
  for (const v of b) if (!s.has(v)) return false;
  return true;
}

/**
 * Do the two share any member?
 * @param {number[]} a first
 * @param {Set<number>} b second
 * @returns {boolean} whether they intersect
 */
function intersects(a, b) {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

/**
 * Rebuild a rung tree from the connection graph of one network.
 *
 * Ladder is a SERIES-PARALLEL graph, and this is its decomposition, which is the only genuinely
 * interesting part of reading PLCopen back. Walking forward from the cut `A`:
 *
 *   - if exactly ONE element consumes that cut, it is the next thing in the series;
 *   - if SEVERAL do, a branch opens here, and it closes at the first cut that a single element
 *     consumes whole — {@link findMerge} finds that by pushing the frontier forward until some
 *     element downstream is waiting on all of it;
 *   - each key in that merge cut is one leg's output, and a key belonging to the branch's own
 *     INPUT cut is an empty leg, the short an operator drew around the branch.
 *
 * Legs are recovered by decomposing backwards from each output key, so a branch nested inside a
 * leg comes back nested rather than flattened into its parent.
 *
 * @param {Set<number>} A the cut power arrives on
 * @param {Set<number>} D the cut this region ends on
 * @param {Set<number>} region the element ids in play
 * @param {object} ctx importer context: `graph`, `notes`, `problems`, `specs`
 * @param {number} depth recursion depth, for the nesting guard
 * @returns {object[]} the series list
 */
function decomposeRegion(A, D, region, ctx, depth) {
  const list = [];
  if (depth > MAX_IMPORT_DEPTH) {
    ctx.notes.push(`branches nest deeper than ${MAX_IMPORT_DEPTH} here; the rest of that rung was dropped`);
    return list;
  }
  const remaining = new Set(region);
  let cur = new Set(A);
  let guard = 0;

  while (!setEq(cur, D)) {
    guard += 1;
    if (guard > 4096) {
      ctx.problems.push({ severity: 'error', message: 'a network in this file loops back on itself and could not be read' });
      break;
    }
    const consumers = [...remaining].filter((id) => intersects(ctx.graph.byId.get(id).power, cur));
    if (consumers.length === 0) break;

    if (consumers.length === 1 && setEq(new Set(ctx.graph.byId.get(consumers[0]).power), cur)) {
      const id = consumers[0];
      remaining.delete(id);
      ctx.graph.used.add(id);
      list.push(toElement(ctx.graph.byId.get(id), ctx));
      cur = new Set([id]);
      continue;
    }

    const merge = findMerge(cur, remaining, D, ctx);
    const built = buildLegs(cur, merge, remaining, ctx, depth);
    if (built.legs.length >= 2) list.push(createBranch(built.legs));
    else for (const n of built.legs[0] || []) list.push(n);
    for (const id of built.consumed) { remaining.delete(id); ctx.graph.used.add(id); }
    if (setEq(merge, cur)) break;
    cur = merge;
  }
  return list;
}

/**
 * Push the power frontier forward from a cut until a branch has closed.
 *
 * The frontier is the set of live power keys: a key goes in when its element is processed and
 * comes out when the last element inside the region that was waiting on it has been processed.
 * The branch has closed the moment some element still ahead — or the right rail — is waiting on
 * the WHOLE frontier, because that is precisely what "the legs have come back together" means.
 *
 * @param {Set<number>} A the cut the branch starts on
 * @param {Set<number>} remaining unprocessed element ids
 * @param {Set<number>} D the region's end cut, which can itself be the merge
 * @param {object} ctx importer context
 * @returns {Set<number>} the merge cut
 */
function findMerge(A, remaining, D, ctx) {
  const pool = new Set(remaining);
  const live = new Map();
  /**
   * How many unprocessed elements are still waiting on a key.
   * @param {number} key the power key
   * @returns {number} the count
   */
  const waiting = (key) => {
    let n = 0;
    for (const id of pool) if (ctx.graph.byId.get(id).power.includes(key)) n += 1;
    return n;
  };
  for (const k of A) live.set(k, waiting(k));

  let processed = 0;
  let guard = 0;
  while (guard < 4096) {
    guard += 1;
    if (processed > 0) {
      const frontier = new Set(live.keys());
      if (frontier.size && superset(D, frontier)) return frontier;
      let closer = false;
      for (const id of pool) {
        if (superset(ctx.graph.byId.get(id).power, frontier)) { closer = true; break; }
      }
      if (closer) return frontier;
    }
    let pick = -1;
    for (const id of pool) {
      if (superset(new Set(live.keys()), new Set(ctx.graph.byId.get(id).power))) { pick = id; break; }
    }
    if (pick < 0) break;
    pool.delete(pick);
    for (const k of ctx.graph.byId.get(pick).power) {
      const n = (live.has(k) ? live.get(k) : 1) - 1;
      if (n <= 0) live.delete(k); else live.set(k, n);
    }
    live.set(pick, waiting(pick));
    processed += 1;
  }
  return new Set(live.keys());
}

/**
 * Recover the legs of a branch that runs from cut `A` to cut `M`.
 *
 * Every key of `M` is one leg's output. A key that is also in `A` is a leg with nothing in it —
 * a short. Everything else is decomposed backwards from its producing element, which is what
 * keeps a nested branch nested.
 *
 * @param {Set<number>} A the branch's input cut
 * @param {Set<number>} M the branch's merge cut
 * @param {Set<number>} remaining unprocessed element ids
 * @param {object} ctx importer context
 * @param {number} depth recursion depth
 * @returns {{legs:Array<object[]>, consumed:Set<number>}} the legs, drawing order first, and
 *   every element they claimed
 */
function buildLegs(A, M, remaining, ctx, depth) {
  const consumed = new Set();
  const specs = [];
  for (const key of M) {
    if (A.has(key)) {
      // A short. It carries no element and therefore no position, so it cannot be ordered
      // against the drawn legs and is placed last. OR is commutative, so the rung means the
      // same thing; only the drawing moves.
      specs.push({ empty: true, y: Infinity, id: Infinity });
      continue;
    }
    const sub = backReach(key, A, remaining, ctx);
    let y = Infinity;
    for (const id of sub) y = Math.min(y, ctx.graph.byId.get(id).y);
    specs.push({ empty: false, key, sub, y, id: key });
  }
  specs.sort((a, b) => (a.y - b.y) || (a.id - b.id));

  const legs = [];
  for (const spec of specs) {
    if (spec.empty) { legs.push([]); continue; }
    legs.push(decomposeRegion(A, new Set([spec.key]), spec.sub, ctx, depth + 1));
    for (const id of spec.sub) consumed.add(id);
  }
  return { legs, consumed };
}

/**
 * Everything that feeds an element, back as far as the cut power arrived on.
 * @param {number} id the element to walk back from
 * @param {Set<number>} A the stopping cut
 * @param {Set<number>} region the elements in play
 * @param {object} ctx importer context
 * @returns {Set<number>} the sub-region, including `id`
 */
function backReach(id, A, region, ctx) {
  const seen = new Set();
  const queue = [id];
  let guard = 0;
  while (queue.length) {
    guard += 1;
    if (guard > 1e5) break;
    const cur = queue.shift();
    if (seen.has(cur) || !region.has(cur)) continue;
    seen.add(cur);
    for (const src of ctx.graph.byId.get(cur).power) {
      if (A.has(src) || seen.has(src)) continue;
      if (region.has(src)) queue.push(src);
    }
  }
  return seen;
}

/**
 * Turn one graph node back into a model element.
 * @param {object} rec the graph node
 * @param {object} ctx importer context
 * @returns {object} the element
 */
function toElement(rec, ctx) {
  const opts = { specs: ctx.specs };
  if (rec.tag === 'contact') {
    if (rec.edge === 'rising') {
      if (rec.negated) ctx.notes.push(`a negated rising-edge contact on ${rec.variable} became a plain ONS`);
      return createElement('ONS', [rec.variable], opts);
    }
    if (rec.edge === 'falling') {
      ctx.notes.push(`a falling-edge contact on ${rec.variable} became a plain contact — this rig `
        + 'has no falling-edge contact, only a falling-edge coil (OSF)');
      return createElement(rec.negated ? 'XIO' : 'XIC', [rec.variable], opts);
    }
    return createElement(rec.negated ? 'XIO' : 'XIC', [rec.variable], opts);
  }
  if (rec.tag === 'coil') {
    if (rec.negated) {
      ctx.notes.push(`a negated coil on ${rec.variable} became a plain OTE — this rig has no `
        + 'inverted coil');
    }
    if (rec.storage === 'set') return createElement('OTL', [rec.variable], opts);
    if (rec.storage === 'reset') return createElement('OTU', [rec.variable], opts);
    if (rec.edge === 'rising') return createElement('OSR', [rec.variable], opts);
    if (rec.edge === 'falling') return createElement('OSF', [rec.variable], opts);
    return createElement('OTE', [rec.variable], opts);
  }
  if (rec.tag === 'jump' || rec.tag === 'label') {
    return createElement(rec.tag === 'jump' ? 'JMP' : 'LBL', [rec.jumpLabel || 'L'], opts);
  }
  if (rec.tag === 'return') {
    ctx.notes.push('a <return> element became an unconditional NOP — this rig has no RET instruction');
    return createElement('NOP', [], opts);
  }

  const ops = [];
  for (const slot of rec.operands) {
    const src = slot.conns.length ? ctx.graph.byId.get(slot.conns[0]) : null;
    if (src && src.isValue) { ops.push(src.expression); continue; }
    if (src) {
      ctx.notes.push(`operand ${slot.fp || '?'} of ${rec.typeName} is wired from another block, `
        + 'not from a value; this rig takes operands as literals and it was dropped');
      continue;
    }
    ctx.notes.push(`operand ${slot.fp || '?'} of ${rec.typeName} has no source and was dropped`);
  }
  const mn = String(rec.typeName || 'NOP').toUpperCase();
  if (!ctx.specs[mn]) {
    ctx.notes.push(`${mn} is not an instruction this rig knows; it was imported as a block and `
      + 'will fail validation until it is replaced');
  }
  return createElement(mn, ops, opts);
}

// =============================================================================================
// Structured text
// =============================================================================================

/**
 * Rung conditions that have an exact ST equivalent. Keyed by mnemonic; each returns the boolean
 * expression, already parenthesised where it is compound.
 */
const ST_CONDITION = Object.freeze({
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  XIC: (o) => `${o[0]}`,
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  XIO: (o) => `NOT ${o[0]}`,
  /**
   * @returns {string} the expression
   */
  AFI: () => 'FALSE',
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  EQU: (o) => `(${o[0]} = ${o[1]})`,
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  NEQ: (o) => `(${o[0]} <> ${o[1]})`,
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  LES: (o) => `(${o[0]} < ${o[1]})`,
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  GRT: (o) => `(${o[0]} > ${o[1]})`,
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  LEQ: (o) => `(${o[0]} <= ${o[1]})`,
  /**
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  GEQ: (o) => `(${o[0]} >= ${o[1]})`,
  /**
   * LIM is `low, test, high`.
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  LIM: (o) => `(${o[1]} >= ${o[0]} AND ${o[1]} <= ${o[2]})`,
  /**
   * MEQ is `source, mask, compare`.
   * @param {string[]} o operands
   * @returns {string} the expression
   */
  MEQ: (o) => `((${o[0]} AND ${o[1]}) = ${o[2]})`,
});

/**
 * Outputs that have an exact ST equivalent. Each returns the statement, given the operands and
 * the rung condition that reaches it.
 */
const ST_STATEMENT = Object.freeze({
  /**
   * A coil FOLLOWS power — it drops when the rung goes false — so it is an assignment and not an
   * `IF`. Writing it as an `IF` is the commonest way a hand translation turns an output coil into
   * a latch by accident.
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  OTE: (o, c) => [`${o[0]} := ${c};`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  OTL: (o, c) => [`IF ${c} THEN ${o[0]} := TRUE; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  OTU: (o, c) => [`IF ${c} THEN ${o[0]} := FALSE; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  MOV: (o, c) => [`IF ${c} THEN ${o[1]} := ${o[0]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  CLR: (o, c) => [`IF ${c} THEN ${o[0]} := 0; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  ADD: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} + ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  SUB: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} - ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  MUL: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} * ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  DIV: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} / ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  MOD: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} MOD ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  SQR: (o, c) => [`IF ${c} THEN ${o[1]} := SQRT(${o[0]}); END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  NEG: (o, c) => [`IF ${c} THEN ${o[1]} := -${o[0]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  ABS: (o, c) => [`IF ${c} THEN ${o[1]} := ABS(${o[0]}); END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  AND: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} AND ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  OR: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} OR ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  XOR: (o, c) => [`IF ${c} THEN ${o[2]} := ${o[0]} XOR ${o[1]}; END_IF;`],
  /**
   * @param {string[]} o operands
   * @param {string} c the rung condition
   * @returns {string[]} the statement lines
   */
  NOT: (o, c) => [`IF ${c} THEN ${o[1]} := NOT ${o[0]}; END_IF;`],
});

/**
 * Write a ladder program as a structured-text listing.
 *
 * This is a LISTING, not a POU. It has no variable declarations, because the tags live in a
 * database with dotted scope prefixes that are structure access in ST and would need a type
 * definition per scope to compile — and inventing one would make the listing look like something
 * that will build, which it will not. What it IS good for is the thing an engineer actually needs
 * from a platform that cannot read XML: the logic, unambiguously, in a language they can retype.
 *
 * Anything without an exact ST equivalent is written as a call in this rig's own mnemonic and
 * named in `notes`, so the reader is told which lines they have to think about rather than being
 * handed a translation that is quietly approximate.
 *
 * @param {object} prog the program document
 * @param {object} [opts] options
 * @param {string} [opts.name] the POU name; defaults to the program name
 * @returns {{ok:boolean, reason?:string, text?:string, notes?:string[]}} the listing
 */
export function programToStructuredText(prog, opts = {}) {
  if (!prog || !Array.isArray(prog.rungs)) {
    return { ok: false, reason: 'that is not a ladder program document' };
  }
  const noteSet = new Set();
  const lines = [];
  lines.push(`(* ${String(prog.name || 'untitled').replace(/\*\)/g, '* )')} *)`);
  lines.push('(* Structured-text LISTING of a ladder program. This is the logic written down, not');
  lines.push('   a compilable POU: the tags live in a PLC tag database and are named SCOPE.NAME, so');
  lines.push('   declare them to suit the target system before this will build. *)');
  lines.push('');
  lines.push(`PROGRAM ${iecIdentifier(opts.name || prog.name || 'Main')}`);

  for (let r = 0; r < prog.rungs.length; r += 1) {
    const rung = prog.rungs[r];
    const body = [];
    emitStList(Array.isArray(rung.nodes) ? rung.nodes : [], null, body, noteSet);
    lines.push('');
    const head = `(* rung ${r + 1}${rung.comment ? ` — ${String(rung.comment).replace(/\*\)/g, '* )')}` : ''}`
      + `${rung.enabled === false ? ' [DISABLED]' : ''} *)`;
    lines.push(`  ${head}`);
    if (body.length === 0) {
      lines.push('  (* this rung has no outputs and does nothing *)');
    } else if (rung.enabled === false) {
      // Commented line by line rather than wrapped in one block comment, because ST comments do
      // not nest and a rung containing a comment would end the block early and leave the rest of
      // the disabled logic live.
      for (const b of body) lines.push(`  (* ${b} *)`);
    } else {
      for (const b of body) lines.push(`  ${b}`);
    }
  }

  lines.push('');
  lines.push('END_PROGRAM');
  lines.push('');
  return { ok: true, text: lines.join('\n'), notes: [...noteSet] };
}

/**
 * Combine two conditions with AND, treating null as "always true".
 * @param {string|null} a the outer condition
 * @param {string|null} b the inner condition
 * @returns {string|null} the conjunction, or null when both are absent
 */
function andOf(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return `${a} AND ${b}`;
}

/**
 * Walk one series list, appending statements and returning the condition it contributes.
 * @param {object[]} list the series list
 * @param {string|null} base the condition already true when power reaches this list
 * @param {string[]} out statement sink
 * @param {Set<string>} notes note sink
 * @returns {string|null} the list's own condition, or null when it is unconditional
 */
function emitStList(list, base, out, notes) {
  let local = null;
  for (const node of list) {
    if (isBranch(node)) {
      const legs = node.legs.map((leg) => emitStList(leg, andOf(base, local), out, notes));
      // A leg with nothing in it is a short: the OR is true whatever the other legs do, so the
      // branch conditions nothing. Dropping it is not a simplification, it is what the rung says.
      if (legs.some((e) => e === null)) continue;
      local = andOf(local, legs.length === 1 ? legs[0] : `(${legs.join(' OR ')})`);
      continue;
    }
    const mn = String(node.mnemonic || '').toUpperCase();
    const ops = (node.operands || []).map(String);
    const cond = andOf(base, local);
    const kind = node.kind || (ELEMENT_SPECS[mn] ? ELEMENT_SPECS[mn].kind : KIND.BLOCK);

    if (ST_CONDITION[mn]) { local = andOf(local, ST_CONDITION[mn](ops)); continue; }
    if (ST_STATEMENT[mn]) { out.push(...ST_STATEMENT[mn](ops, cond === null ? 'TRUE' : cond)); continue; }

    const call = `${mn}(${ops.join(', ')})`;
    notes.add(`${mn} has no exact IEC 61131-3 structured-text equivalent and was written as a call`);
    if (kind === KIND.CONTACT) {
      local = andOf(local, call);
    } else {
      out.push(`IF ${cond === null ? 'TRUE' : cond} THEN ${call}; END_IF;`);
    }
  }
  return local;
}

// =============================================================================================
// Tuning parameter sheets
// =============================================================================================

/**
 * The conventions a tuning has to be converted INTO before it is typed into something else.
 *
 * Three independent choices, and every combination of them exists in a real product:
 *
 *   FORM     standard (ISA, dependent), parallel (independent), or series (interacting).
 *   GAIN     dimensionless gain, or proportional band, which is 100/gain in percent.
 *   RESET    a TIME per repeat, or a RATE in repeats per unit time, which is its reciprocal —
 *            and the unit is minutes about as often as it is seconds.
 *
 * Writing a target down as a row in this table rather than as a special case in the converter is
 * the point: it makes it obvious that "Kc, Ti, Td" is meaningless until all three columns are
 * fixed, which is exactly the thing that gets forgotten.
 */
export const TUNING_TARGETS = Object.freeze([
  Object.freeze({
    id: 'isa-gain-sec',
    label: 'ISA standard form — gain, seconds',
    form: FORM.STANDARD,
    gain: 'gain',
    reset: 'time',
    unit: 's',
    systems: 'The form this rig computes in, and the one most modern DCS and library PID blocks '
      + 'use. Every published tuning rule since about 1980 is written for it.',
  }),
  Object.freeze({
    id: 'isa-gain-min',
    label: 'ISA standard form — gain, minutes per repeat',
    form: FORM.STANDARD,
    gain: 'gain',
    reset: 'time',
    unit: 'min',
    systems: 'The same algorithm with the reset and rate times in minutes, which is how a great '
      + 'many process controllers present them. Typing seconds into this one runs the integral '
      + 'sixty times too slowly.',
  }),
  Object.freeze({
    id: 'isa-band-rpm',
    label: 'Proportional band and repeats per minute',
    form: FORM.STANDARD,
    gain: 'band',
    reset: 'rate',
    unit: 'min',
    systems: 'The classic faceplate convention, inherited from analogue controllers and still on '
      + 'plenty of panels. Both numbers are RECIPROCALS of the usual ones, so a transcription '
      + 'error here does not look wrong, it looks like a different tuning.',
  }),
  Object.freeze({
    id: 'isa-band-rps',
    label: 'Proportional band and repeats per second',
    form: FORM.STANDARD,
    gain: 'band',
    reset: 'rate',
    unit: 's',
    systems: 'The same reciprocal convention with the reset rate per second rather than per '
      + 'minute — a sixty-fold difference that is invisible on a faceplate showing only a number.',
  }),
  Object.freeze({
    id: 'parallel-sec',
    label: 'Parallel (independent) gains — seconds',
    form: FORM.PARALLEL,
    gain: 'gain',
    reset: 'time',
    unit: 's',
    systems: 'Independent gains: Kp, Ki and Kd act on their own terms and changing Kp does not '
      + 'move the integral or the derivative. This is the form most software libraries and many '
      + 'controller "independent" modes use.',
  }),
  Object.freeze({
    id: 'parallel-min',
    label: 'Parallel (independent) gains — minutes',
    form: FORM.PARALLEL,
    gain: 'gain',
    reset: 'time',
    unit: 'min',
    systems: 'Independent gains with the time base in minutes, so Ki is repeats per minute of '
      + 'output per engineering unit and Kd is in per-minute units.',
  }),
  Object.freeze({
    id: 'series-gain-sec',
    label: 'Series (interacting) form — gain, seconds',
    form: FORM.SERIES,
    gain: 'gain',
    reset: 'time',
    unit: 's',
    systems: 'The interacting arrangement a pneumatic controller physically was, and what '
      + 'Ziegler-Nichols was derived on. Several major platforms still run it. Only exists when '
      + 'the reset time is at least four times the derivative time.',
  }),
  Object.freeze({
    id: 'series-band-rpm',
    label: 'Series (interacting) form — band, repeats per minute',
    form: FORM.SERIES,
    gain: 'band',
    reset: 'rate',
    unit: 'min',
    systems: 'The interacting form on an analogue-style faceplate — the worst case for a '
      + 'transcription error, because the form, the gain convention and the reset convention are '
      + 'all different from the rig at once.',
  }),
]);

/**
 * Convert a standard-form tuning into one target convention.
 *
 * The form conversion itself is `control/pid.js`'s {@link convertForm} — not re-derived here,
 * because two implementations of the series factorisation is two chances to get the factor wrong.
 * What this adds is the units and the gain convention, and the refusals:
 *
 *   SERIES with Ti < 4·Td   has no answer at all. A standard-form controller whose zeros are
 *                           COMPLEX cannot be written as two real first-order factors, and the
 *                           honest output is a refusal naming the constraint. Fudging it — the
 *                           usual dodge is to clamp Td to Ti/4 — hands over a tuning that is not
 *                           the one that was tested, which is precisely the failure this whole
 *                           module exists to prevent.
 *   BAND with Kc <= 0       has no answer either: proportional band is 100/Kc.
 *
 * An integral switched off (Ti infinite) is not a refusal. Reset time is infinite and reset rate
 * is zero, and both are the truth.
 *
 * @param {{Kc:number, Ti:number, Td:number, N?:number, b?:number, c?:number, action?:string}} std
 *   the standard-form tuning
 * @param {string} targetId one of the ids in {@link TUNING_TARGETS}
 * @returns {{ok:boolean, id:string, label?:string, systems?:string, form?:string,
 *   rows?:Array<{key:string, label:string, value:number, unit:string}>, caveats?:string[],
 *   reason?:string}} the sheet
 */
export function tuningSheet(std, targetId) {
  const target = TUNING_TARGETS.find((t) => t.id === targetId);
  if (!target) return { ok: false, id: String(targetId), reason: `there is no tuning target called '${targetId}'` };
  if (!std || !Number.isFinite(std.Kc)) {
    return { ok: false, id: target.id, label: target.label, reason: 'that is not a tuning' };
  }
  const Ti = std.Ti;
  const Td = Number.isFinite(std.Td) ? std.Td : 0;
  const integrating = Number.isFinite(Ti) && Ti > 0;

  const conv = convertForm({ Kc: std.Kc, Ti, Td }, target.form);
  if (!conv.ok) return { ok: false, id: target.id, label: target.label, form: target.form, reason: conv.note };

  const scale = target.unit === 'min' ? 60 : 1;
  const per = target.unit === 'min' ? '/min' : '/s';
  const timeUnit = target.unit === 'min' ? 'min' : 's';
  const rows = [];
  const caveats = [];

  if (target.form === FORM.PARALLEL) {
    const [Kp, KiPerSec, KdSec] = conv.values;
    rows.push({ key: 'Kp', label: 'Proportional gain', value: Kp, unit: '%/EU' });
    rows.push({ key: 'Ki', label: 'Integral gain', value: KiPerSec * scale, unit: `%/EU${per}` });
    rows.push({ key: 'Kd', label: 'Derivative gain', value: KdSec / scale, unit: `%·${timeUnit}/EU` });
    caveats.push('Independent gains: raising Kp here does NOT strengthen the integral or the '
      + 'derivative, which it does in every dependent form. A tuning rule that says "double the '
      + 'gain" means something different on this controller.');
  } else {
    const [K, TiOut, TdOut] = conv.values;
    if (target.gain === 'band') {
      if (!(K > 0)) {
        return {
          ok: false,
          id: target.id,
          label: target.label,
          form: target.form,
          reason: `proportional band is 100/gain, and this gain is ${K} — there is no band that `
            + 'means the same thing',
        };
      }
      rows.push({ key: 'PB', label: 'Proportional band', value: 100 / K, unit: '%' });
    } else {
      rows.push({ key: target.form === FORM.SERIES ? 'Kc′' : 'Kc', label: 'Proportional gain', value: K, unit: '%/EU' });
    }
    if (target.reset === 'rate') {
      rows.push({
        key: 'RESET',
        label: 'Reset rate',
        value: integrating ? scale / TiOut : 0,
        unit: `repeats${per}`,
      });
    } else {
      rows.push({
        key: target.form === FORM.SERIES ? 'Ti′' : 'Ti',
        label: 'Reset time',
        value: integrating ? TiOut / scale : Infinity,
        unit: `${timeUnit}/repeat`,
      });
    }
    rows.push({
      key: target.form === FORM.SERIES ? 'Td′' : 'Td',
      label: 'Derivative time',
      value: TdOut / scale,
      unit: timeUnit,
    });
    if (target.form === FORM.SERIES) {
      caveats.push('Interacting form: the derivative multiplies the proportional-plus-integral '
        + 'stage, so all three numbers differ from the standard-form ones whenever the derivative '
        + 'is switched on. With Td = 0 the two forms are identical.');
    }
  }

  if (!integrating) caveats.push('The integral is switched off in this tuning.');
  if (Td > 0) {
    const N = Number.isFinite(std.N) && std.N > 0 ? std.N : 10;
    rows.push({ key: 'N', label: 'Derivative filter divisor', value: N, unit: '' });
    caveats.push(`The derivative is rolled off at Td/N with N = ${N}. Many controllers fix N `
      + 'internally, often between 8 and 20, and a different N is a different controller — check '
      + 'the target before trusting the derivative number.');
  }
  if (std.b !== undefined && std.b !== 1) {
    rows.push({ key: 'b', label: 'Setpoint weight, proportional', value: std.b, unit: '' });
    caveats.push('This tuning uses setpoint weighting. A controller without it will overshoot '
      + 'more on a setpoint step than this one does, with identical disturbance rejection.');
  }
  if (std.c) rows.push({ key: 'c', label: 'Setpoint weight, derivative', value: std.c, unit: '' });
  if (std.action) rows.push({ key: 'action', label: 'Controller action', value: NaN, unit: String(std.action) });

  return {
    ok: true,
    id: target.id,
    label: target.label,
    systems: target.systems,
    form: target.form,
    rows,
    caveats,
  };
}

/**
 * Convert a tuning into every target convention at once.
 * @param {object} std the standard-form tuning
 * @param {string[]} [ids] which targets, defaulting to all of them
 * @returns {{sheets:object[], refused:object[]}} the sheets that exist and the ones that do not,
 *   each refusal carrying the reason
 */
export function tuningSheets(std, ids) {
  const want = ids && ids.length ? ids : TUNING_TARGETS.map((t) => t.id);
  const sheets = [];
  const refused = [];
  for (const id of want) {
    const sheet = tuningSheet(std, id);
    if (sheet.ok) sheets.push(sheet); else refused.push(sheet);
  }
  return { sheets, refused };
}

/**
 * Render tuning sheets as CSV, one block per target.
 * @param {{sheets:object[], refused:object[]}} result from {@link tuningSheets}
 * @returns {string} the CSV text
 */
export function tuningSheetsToCsv(result) {
  const lines = ['target,parameter,value,unit,note'];
  for (const s of result.sheets) {
    for (const r of s.rows) {
      lines.push([csvCell(s.label), csvCell(r.key), csvCell(numText(r.value)), csvCell(r.unit), ''].join(','));
    }
    for (const c of s.caveats) lines.push([csvCell(s.label), '', '', '', csvCell(c)].join(','));
  }
  for (const s of result.refused) {
    lines.push([csvCell(s.label || s.id), 'REFUSED', '', '', csvCell(s.reason)].join(','));
  }
  return `${lines.join('\n')}\n`;
}

// =============================================================================================
// The loop audit bundle
// =============================================================================================

/**
 * Gather everything that was learned about a loop into one record.
 *
 * Every section is optional and a missing one says so in the file rather than vanishing, because
 * "the diagnostics are not in this audit" and "the diagnostics were clean" are very different
 * findings and a blank space reads as the second.
 *
 * The margins are COMPUTED here when a model and a tuning are given without them, using
 * `control/analysis.js`. That is deliberate reuse: the number in the audit is then the same
 * number the Bode screen showed, computed by the same code, and cannot drift from it.
 *
 * @param {object} input the parts
 * @param {string} [input.title] what this loop is called
 * @param {string} [input.at] timestamp, ISO 8601. Supplied by the caller — see the module header
 * @param {object} [input.tuning] the standard-form tuning record
 * @param {number} [input.scan_s] controller scan period, s
 * @param {{K:number, tau:number, theta:number}} [input.model] the identified process model
 * @param {string} [input.modelSource] how the model was identified
 * @param {object} [input.margins] margins from `control/analysis.js`, computed if absent
 * @param {object} [input.diagnostics] a report from `control/diagnostics.js`
 * @param {object} [input.recommendation] `{label, Kc, Ti, Td, why}` — the tuning being advised
 * @param {object} [input.trend] the trend ring from `core/util.js`
 * @param {Record<string,string>} [input.trendUnits] channel name to unit
 * @param {string[]} [input.trendChannels] which channels to include
 * @returns {{ok:boolean, reason?:string, audit?:object}} the bundle
 */
export function buildLoopAudit(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'there is nothing to audit' };

  const tuning = input.tuning || null;
  const model = input.model && Number.isFinite(input.model.K) ? input.model : null;

  let margins = input.margins || null;
  if (!margins && tuning && model) {
    margins = readMargins(loopResponse(tuning, model, DEFAULT_GRID, input.scan_s || 0));
  }

  const sheets = tuning ? tuningSheets(tuning) : { sheets: [], refused: [] };

  return {
    ok: true,
    audit: {
      title: input.title || 'loop audit',
      at: typeof input.at === 'string' ? input.at : '',
      tuning,
      scan_s: Number.isFinite(input.scan_s) ? input.scan_s : NaN,
      model,
      modelSource: input.modelSource || '',
      margins,
      diagnostics: input.diagnostics || null,
      recommendation: input.recommendation || null,
      sheets,
      trend: input.trend || null,
      trendUnits: input.trendUnits || {},
      trendChannels: input.trendChannels || null,
    },
  };
}

/**
 * Render a loop audit as one self-contained CSV file.
 *
 * Sectioned rather than split across files, because an audit that arrives as five attachments is
 * an audit whose trend gets separated from the margins it explains within a week. The narrow
 * sections come first so the top of the file reads as a report; the trend goes last, where a
 * spreadsheet can find it and where it does not push the findings off the screen.
 *
 * @param {object} audit from {@link buildLoopAudit}
 * @returns {string} the file text
 */
export function loopAuditToCsv(audit) {
  if (!audit || typeof audit !== 'object') return 'section,name,value,unit\nerror,,no audit was given,\n';
  const out = [];

  out.push('section,name,value,unit');
  out.push(row('audit', 'title', audit.title, ''));
  out.push(row('audit', 'exported at', audit.at || 'not recorded', ''));

  if (audit.tuning) {
    const t = audit.tuning;
    out.push(row('tuning', 'form', 'ISA standard (dependent gains), seconds', ''));
    out.push(row('tuning', 'gain Kc', numText(t.Kc), '%/EU'));
    out.push(row('tuning', 'reset time Ti', numText(t.Ti), 's/repeat'));
    out.push(row('tuning', 'derivative time Td', numText(t.Td), 's'));
    if (Number.isFinite(t.N)) out.push(row('tuning', 'derivative filter N', numText(t.N), ''));
    if (t.b !== undefined) out.push(row('tuning', 'setpoint weight b', numText(t.b), ''));
    if (t.action) out.push(row('tuning', 'action', t.action, ''));
    if (Number.isFinite(audit.scan_s)) out.push(row('tuning', 'scan period', numText(audit.scan_s), 's'));
  } else {
    out.push(row('tuning', 'not recorded', '', ''));
  }

  if (audit.model) {
    out.push(row('model', 'identified by', audit.modelSource || 'not recorded', ''));
    out.push(row('model', 'process gain K', numText(audit.model.K), 'EU/%'));
    out.push(row('model', 'time constant tau', numText(audit.model.tau), 's'));
    out.push(row('model', 'dead time theta', numText(audit.model.theta), 's'));
    const ratio = audit.model.tau > 0 ? audit.model.theta / audit.model.tau : Infinity;
    out.push(row('model', 'dead time / time constant', numText(ratio), ''));
  } else {
    out.push(row('model', 'no model identified', '', ''));
  }

  if (audit.margins) {
    const m = audit.margins;
    out.push(row('margins', 'gain margin', numText(m.gm), 'x'));
    out.push(row('margins', 'gain margin', numText(m.gm_dB), 'dB'));
    out.push(row('margins', 'phase margin', numText(m.pm_deg), 'deg'));
    out.push(row('margins', 'delay margin', numText(m.delayMargin_s), 's'));
    out.push(row('margins', 'gain crossover', numText(m.wgc), 'rad/s'));
    out.push(row('margins', 'sensitivity peak Ms', numText(m.ms), ''));
    out.push(row('margins', 'stable', m.stable ? 'yes' : 'no', ''));
    out.push(row('margins', 'verdict', m.verdict, ''));
  } else {
    out.push(row('margins', 'not computed — no model', '', ''));
  }

  if (audit.diagnostics) {
    const d = audit.diagnostics;
    out.push(row('diagnostics', 'window', numText(d.window_min), 'min'));
    out.push(row('diagnostics', 'error standard deviation', numText(d.sdPct), '% of span'));
    out.push(row('diagnostics', 'oscillating', d.oscillating ? 'yes' : 'no', ''));
    if (d.oscillating) out.push(row('diagnostics', 'cycle period', numText(d.period_s), 's'));
    out.push(row('diagnostics', 'Harris index', numText(d.harris), ''));
    out.push(row('diagnostics', 'output travel', numText(d.travel), '%'));
    out.push(row('diagnostics', 'output reversals', numText(d.reversalsPerMin), '/min'));
    if (d.stiction && Number.isFinite(d.stiction.stickband_pct)) {
      out.push(row('diagnostics', 'estimated stickband', numText(d.stiction.stickband_pct), '%'));
    }
    out.push(row('diagnostics', 'verdict', d.verdict, ''));
    out.push(row('diagnostics', 'advice', d.advice, ''));
  } else {
    out.push(row('diagnostics', 'not recorded', '', ''));
  }

  if (audit.recommendation) {
    const r = audit.recommendation;
    out.push(row('recommendation', 'rule', r.label || 'unnamed', ''));
    if (Number.isFinite(r.Kc)) out.push(row('recommendation', 'gain Kc', numText(r.Kc), '%/EU'));
    if (r.Ti !== undefined) out.push(row('recommendation', 'reset time Ti', numText(r.Ti), 's/repeat'));
    if (Number.isFinite(r.Td)) out.push(row('recommendation', 'derivative time Td', numText(r.Td), 's'));
    if (r.why) out.push(row('recommendation', 'why', r.why, ''));
  } else {
    out.push(row('recommendation', 'none recorded', '', ''));
  }

  const sheets = audit.sheets || { sheets: [], refused: [] };
  if (sheets.sheets.length || sheets.refused.length) {
    out.push('');
    out.push(tuningSheetsToCsv(sheets).trimEnd());
  }

  out.push('');
  if (audit.trend && Array.isArray(audit.trend.names)) {
    out.push(trendToCsv(audit.trend, audit.trendUnits || {}, { channels: audit.trendChannels || undefined }).trimEnd());
  } else {
    out.push('trend');
    out.push('no trend was captured with this audit');
  }
  return `${out.join('\n')}\n`;
}

/**
 * One `section,name,value,unit` row, quoted where it has to be.
 * @param {string} section the section name
 * @param {string} name the row name
 * @param {string|number} value the value
 * @param {string} unit the unit
 * @returns {string} the CSV row
 */
function row(section, name, value, unit) {
  return [section, csvCell(name), csvCell(value), csvCell(unit)].join(',');
}

/**
 * Quote a CSV cell if it needs it.
 *
 * A local copy: `io/export.js` keeps its own private and exporting it would make a formatting
 * helper part of that module's contract for no gain.
 *
 * @param {string|number} v the value
 * @returns {string} the cell
 */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Format a number for a sheet.
 *
 * Infinity prints as `off` and not as `Infinity`, because on a reset-time row that is what it
 * means and because a spreadsheet reading `Infinity` gives a text cell in a numeric column.
 *
 * @param {number|string} v the value
 * @returns {string} the text
 */
function numText(v) {
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return v === Infinity ? 'off' : '';
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}
