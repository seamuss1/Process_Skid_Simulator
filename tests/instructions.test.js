/**
 * tests/instructions.test.js — the instruction set, checked against its truth tables and against
 * hand-computed sequences of scans.
 *
 * The instructions are tested against a BENCH database rather than against `plc/tags.js`, for the
 * same reason `tests/staging.test.js` tests the sequence against drive states rather than through
 * the plant: these are discrete-logic claims, and a failure should point at one instruction and
 * not at four modules. The bench honours the same two rules the real database does — a timer lives
 * under `T.` and a counter under `C.` — because that prefix is what tells RES which of the two it
 * is holding.
 *
 * The awkward cases have their own tests on purpose: divide by zero, a zero-width scaling span,
 * inverted LIM limits, a counter at its rollover, two one-shots on one bit, and a scan longer than
 * the timer preset it is asked to cross.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCTIONS, CATEGORY, ELEMENT_KIND, OPERAND_KIND, ROLE,
  instructionsByCategory, createElement, evaluateElement, describeElement, checkOperands,
  elementState, clearElementState,
} from '../src/plc/instructions.js';

// --------------------------------------------------------------------------------------------
// The bench
// --------------------------------------------------------------------------------------------

/**
 * A minimal stand-in for the tag database and the scan engine's control surface.
 * @param {object} [seed] initial tag values, keyed by name
 * @returns {object} the instruction's world, plus the recorders the tests read
 */
function world(seed) {
  const vals = new Map(Object.entries(seed || {}));
  const timers = new Map();
  const counters = new Map();
  const io = {
    vals,
    faults: [],
    jumps: [],
    mcrOffs: 0,
    /**
     * @param {string} n tag name
     * @returns {*} the value, or undefined
     */
    read(n) { return vals.get(n); },
    /**
     * @param {string} n tag name
     * @param {*} v the value
     * @returns {{ok:boolean}} acceptance
     */
    write(n, v) { vals.set(n, v); return { ok: true }; },
    /**
     * @param {string} n tag name
     * @returns {object|undefined} the timer structure, if that name is a timer
     */
    timer(n) {
      if (!String(n).startsWith('T.')) return undefined;
      if (!timers.has(n)) timers.set(n, { pre: 0, acc: 0, en: false, tt: false, dn: false });
      return timers.get(n);
    },
    /**
     * @param {string} n tag name
     * @returns {object|undefined} the counter structure, if that name is a counter
     */
    counter(n) {
      if (!String(n).startsWith('C.')) return undefined;
      if (!counters.has(n)) {
        counters.set(n, { pre: 0, acc: 0, cu: false, cd: false, dn: false, ov: false, un: false });
      }
      return counters.get(n);
    },
    control: {
      /**
       * @param {string} label the jump target
       * @returns {void}
       */
      jump(label) { io.jumps.push(label); },
      /** @returns {void} */
      mcrOff() { io.mcrOffs += 1; },
      /**
       * @param {string} m the fault text
       * @returns {void}
       */
      fault(m) { io.faults.push(m); },
    },
  };
  return io;
}

/**
 * Build an element, asserting the mnemonic exists.
 * @param {string} mnemonic the instruction
 * @param {...*} operands operand tokens
 * @returns {object} the element
 */
function el(mnemonic, ...operands) {
  const r = createElement(mnemonic, operands);
  assert.ok(r.ok, `createElement refused ${mnemonic}: ${r.reason}`);
  return r.el;
}

/**
 * Evaluate one element for one scan.
 * @param {object} element the element
 * @param {object} io the bench world
 * @param {boolean} power incoming power flow
 * @param {number} [dt_s=0.1] scan period, s
 * @returns {boolean} outgoing power flow
 */
function scan(element, io, power, dt_s = 0.1) {
  return evaluateElement(null, element, io, dt_s, power);
}

// --------------------------------------------------------------------------------------------
// The table itself
// --------------------------------------------------------------------------------------------

test('every instruction in the contract is present, and every entry is a complete specification',
  () => {
    const required = [
      'XIC', 'XIO', 'OTE', 'OTL', 'OTU', 'ONS', 'OSR', 'OSF',
      'TON', 'TOF', 'RTO', 'RES', 'CTU', 'CTD',
      'EQU', 'NEQ', 'LES', 'GRT', 'LEQ', 'GEQ', 'LIM', 'MEQ',
      'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'MOV', 'CLR', 'SQR', 'NEG', 'ABS', 'SCL', 'SCP', 'AVE',
      'AND', 'OR', 'XOR', 'NOT',
      'JMP', 'LBL', 'MCR', 'NOP', 'AFI',
      'PID', 'SETPT', 'RAMP', 'TOTAL', 'DEADBAND', 'ALARM', 'ALTERNATE', 'RUNHOURS',
    ];
    for (const m of required) {
      assert.ok(INSTRUCTIONS[m], `${m} is in the module contract and the editor palette will look `
        + 'for it; without it the stock programs will not parse');
    }
    for (const [key, spec] of Object.entries(INSTRUCTIONS)) {
      assert.equal(spec.mnemonic, key, `${key} is filed under a different mnemonic than it carries`);
      assert.ok(Object.values(ELEMENT_KIND).includes(spec.kind), `${key} has no drawable kind`);
      assert.ok(Object.values(CATEGORY).includes(spec.category), `${key} is in no palette group`);
      assert.ok(spec.glyph && spec.glyph.length > 0, `${key} has no glyph for the editor to draw`);
      assert.ok(spec.help && spec.help.length > 40,
        `${key} has no help a learner could read — the help IS the teaching`);
      assert.ok(typeof spec.template === 'string' && spec.template.length > 0,
        `${key} has no template, so describeRung cannot say what it does in English`);
      assert.equal(typeof spec.evaluate, 'function', `${key} cannot be executed`);
      for (const o of spec.operands) {
        assert.ok(o.name, `${key} has an unnamed operand slot`);
        assert.ok(Object.values(ROLE).includes(o.role),
          `${key} operand "${o.name}" has no role, so the cross-reference cannot tell a read `
          + 'from a write');
        assert.ok(Array.isArray(o.kinds) && o.kinds.length > 0,
          `${key} operand "${o.name}" accepts no type`);
        for (const k of o.kinds) {
          assert.ok(Object.values(OPERAND_KIND).includes(k),
            `${key} operand "${o.name}" wants a type the tag database does not have: ${k}`);
        }
      }
    }
  });

test('no instruction throws when it is executed with no operands at all', () => {
  // The editor puts an empty element on the rung the moment you drop one, and it is scanned from
  // that instant. An exception here would take the whole processor down mid-edit.
  for (const key of Object.keys(INSTRUCTIONS)) {
    const io = world();
    for (const power of [true, false]) {
      const out = scan({ mnemonic: key, operands: [] }, io, power);
      assert.equal(typeof out, 'boolean',
        `${key} with no operands must still answer with a power flow, not ${out}`);
    }
  }
});

test('the palette groups every instruction exactly once, in teaching order', () => {
  const groups = instructionsByCategory();
  assert.deepEqual(groups.map((g) => g.category),
    ['bit', 'timer', 'counter', 'compare', 'math', 'logic', 'control', 'process'],
    'the palette order is the order the lessons introduce them in');
  const seen = groups.flatMap((g) => g.instructions.map((s) => s.mnemonic));
  assert.equal(seen.length, Object.keys(INSTRUCTIONS).length,
    'an instruction that is in no palette group is an instruction nobody can find');
  assert.equal(new Set(seen).size, seen.length, 'an instruction appears in two groups');
});

// --------------------------------------------------------------------------------------------
// Bit instructions
// --------------------------------------------------------------------------------------------

test('XIC and XIO are the truth table of a normally-open and a normally-closed contact', () => {
  const io = world({ 'I.RUN': false });
  const open = el('XIC', 'I.RUN');
  const closed = el('XIO', 'I.RUN');
  const cases = [
    { power: true, bit: true, xic: true, xio: false },
    { power: true, bit: false, xic: false, xio: true },
    { power: false, bit: true, xic: false, xio: false },
    { power: false, bit: false, xic: false, xio: false },
  ];
  for (const c of cases) {
    io.vals.set('I.RUN', c.bit);
    assert.equal(scan(open, io, c.power), c.xic,
      `XIC with power ${c.power} and bit ${c.bit} must pass ${c.xic}`);
    assert.equal(scan(closed, io, c.power), c.xio,
      `XIO with power ${c.power} and bit ${c.bit} must pass ${c.xio} — a contact with no power in `
      + 'cannot pass power out, however the bit is examined');
  }
});

test('OTE writes the rung condition every scan, in both directions', () => {
  const io = world();
  const coil = el('OTE', 'Q.P1_START');
  scan(coil, io, true);
  assert.equal(io.vals.get('Q.P1_START'), true, 'a powered OTE must energise its bit');
  scan(coil, io, false);
  assert.equal(io.vals.get('Q.P1_START'), false,
    'an unpowered OTE must DE-energise its bit — an OTE that only ever writes true is a latch, '
    + 'and the difference is a pump that will not stop');
});

test('OTL sets and leaves alone; only OTU clears it', () => {
  const io = world();
  const latch = el('OTL', 'M.ALM_LATCH');
  const unlatch = el('OTU', 'M.ALM_LATCH');
  scan(latch, io, true);
  assert.equal(io.vals.get('M.ALM_LATCH'), true, 'a powered OTL must set the bit');
  scan(latch, io, false);
  assert.equal(io.vals.get('M.ALM_LATCH'), true,
    'the condition going away must NOT clear a latch — that is the whole point of one');
  scan(unlatch, io, false);
  assert.equal(io.vals.get('M.ALM_LATCH'), true, 'an unpowered OTU must not clear anything');
  scan(unlatch, io, true);
  assert.equal(io.vals.get('M.ALM_LATCH'), false, 'a powered OTU must clear the bit');
});

test('a one-shot passes power for exactly one scan and rearms only after power is lost', () => {
  const io = world();
  const ons = el('ONS');
  assert.equal(scan(ons, io, true), true, 'the first powered scan must pulse');
  assert.equal(scan(ons, io, true), false, 'the second must not — a one-shot is an edge, not a level');
  assert.equal(scan(ons, io, true), false, 'and it must stay blocked while power is held');
  assert.equal(scan(ons, io, false), false, 'losing power rearms it but does not pulse');
  assert.equal(scan(ons, io, true), true, 'the next rising edge must pulse again');
});

test('two one-shots watching the same bit each get their own edge', () => {
  // The classic failure: one-shot state kept per TAG instead of per element. The first instruction
  // to run consumes the edge and the second never fires, and the bug only shows up in the rung
  // somebody added last.
  const io = world({ 'I.START_PB': false });
  const a = el('ONS');
  const b = el('ONS');
  io.vals.set('I.START_PB', true);
  const pa = scan(a, io, io.vals.get('I.START_PB'));
  const pb = scan(b, io, io.vals.get('I.START_PB'));
  assert.equal(pa, true, 'the first one-shot must see the edge');
  assert.equal(pb, true,
    'so must the second — one-shot memory belongs to the element, never to the bit it watches');
  assert.equal(scan(a, io, true), false, 'and both must block on the next scan');
  assert.equal(scan(b, io, true), false, 'and both must block on the next scan');
});

test('OSR pulses as power arrives and OSF pulses as power is lost', () => {
  const io = world();
  const rise = el('OSR', 'M.STARTED');
  const fall = el('OSF', 'M.STOPPED');

  assert.equal(scan(rise, io, true), true, 'OSR must pulse on the rising edge');
  assert.equal(io.vals.get('M.STARTED'), true, 'and set its output bit for that scan');
  assert.equal(scan(rise, io, true), false, 'and only for that scan');
  assert.equal(io.vals.get('M.STARTED'), false, 'clearing the bit again on the next scan');

  scan(fall, io, true);
  assert.equal(io.vals.get('M.STOPPED'), false, 'OSF must not pulse while power is arriving');
  assert.equal(scan(fall, io, false), true,
    'OSF must emit power on the scan its input goes FALSE — which is why the solver takes an '
    + 'instruction\'s returned power as-is instead of ANDing it with the rung condition');
  assert.equal(io.vals.get('M.STOPPED'), true, 'and set its output bit for that one scan');
  assert.equal(scan(fall, io, false), false, 'and not again while power stays away');
});

// --------------------------------------------------------------------------------------------
// Timers
// --------------------------------------------------------------------------------------------

test('a TON accumulates only while its rung is true and is done on the scan it reaches preset',
  () => {
    const io = world();
    const t = el('TON', 'T.STAGE_DLY', 3000);
    const s = io.timer('T.STAGE_DLY');
    // Six scans of 500 ms against a 3000 ms preset: hand-computed, one line per scan.
    const expect = [
      { acc: 500, dn: false, tt: true },
      { acc: 1000, dn: false, tt: true },
      { acc: 1500, dn: false, tt: true },
      { acc: 2000, dn: false, tt: true },
      { acc: 2500, dn: false, tt: true },
      { acc: 3000, dn: true, tt: false },
    ];
    expect.forEach((want, i) => {
      scan(t, io, true, 0.5);
      assert.equal(s.acc, want.acc, `after scan ${i + 1} the accumulator must read ${want.acc} ms`);
      assert.equal(s.dn, want.dn, `after scan ${i + 1} DN must be ${want.dn}`);
      assert.equal(s.tt, want.tt, `after scan ${i + 1} TT must be ${want.tt} — TT means "timing", `
        + 'and it must drop the moment DN sets');
      assert.equal(s.en, true, 'EN follows the rung condition and the rung is true');
    });
    scan(t, io, true, 0.5);
    assert.equal(s.acc, 3000, 'a done TON must hold its accumulator at the preset, not run past it');
  });

test('a TON resets completely the moment its rung goes false', () => {
  const io = world();
  const t = el('TON', 'T.STAGE_DLY', 3000);
  const s = io.timer('T.STAGE_DLY');
  scan(t, io, true, 1.0);
  scan(t, io, true, 1.0);
  assert.equal(s.acc, 2000, 'two seconds accumulated');
  scan(t, io, false, 1.0);
  assert.deepEqual({ acc: s.acc, dn: s.dn, tt: s.tt, en: s.en },
    { acc: 0, dn: false, tt: false, en: false },
    'a TON does not remember: losing the rung zeroes the accumulator and every status bit. If it '
    + 'remembered, the stage-up delay would fire on the sum of scattered excursions rather than on '
    + 'one sustained one');
  scan(t, io, true, 1.0);
  assert.equal(s.acc, 1000, 'and it starts again from zero');
});

test('a TOF is the mirror of a TON: done at once, and off only after the preset has run out', () => {
  const io = world();
  const t = el('TOF', 'T.MIN_RUN', 2000);
  const s = io.timer('T.MIN_RUN');
  assert.equal(s.dn, false, 'a TOF that has never been energised is not done');
  assert.equal(scan(t, io, true, 0.5), true, 'a powered TOF passes power');
  assert.equal(s.dn, true, 'and DN goes true immediately — that is the difference from a TON');
  assert.equal(s.acc, 0, 'with the accumulator held at zero while the rung is true');

  const expect = [
    { acc: 500, dn: true, tt: true },
    { acc: 1000, dn: true, tt: true },
    { acc: 1500, dn: true, tt: true },
    { acc: 2000, dn: false, tt: false },
  ];
  expect.forEach((want, i) => {
    scan(t, io, false, 0.5);
    assert.equal(s.acc, want.acc, `after ${i + 1} scans without power the accumulator is ${want.acc}`);
    assert.equal(s.dn, want.dn, `and DN is ${want.dn} — the minimum-run timer holds the pump on `
      + 'for the whole preset after the call goes away');
    assert.equal(s.tt, want.tt, `and TT is ${want.tt}`);
  });
});

test('an RTO keeps its accumulator across a false rung and only a RES clears it', () => {
  const io = world();
  const t = el('RTO', 'T.SERVICE', 1000);
  const res = el('RES', 'T.SERVICE');
  const s = io.timer('T.SERVICE');

  scan(t, io, true, 0.4);
  scan(t, io, true, 0.4);
  assert.equal(s.acc, 800, 'two scans of 400 ms accumulate 800 ms');
  scan(t, io, false, 0.4);
  scan(t, io, false, 0.4);
  assert.equal(s.acc, 800,
    'a retentive timer must NOT lose the accumulator when the rung goes false — totalling '
    + 'scattered running periods is the only reason it exists');
  assert.equal(s.tt, false, 'though it is no longer timing');
  scan(t, io, true, 0.4);
  assert.equal(s.acc, 1000, 'the accumulator resumes where it stopped and stops at the preset');
  assert.equal(s.dn, true, 'and DN sets');
  scan(t, io, false, 0.4);
  assert.equal(s.dn, true,
    'DN on an RTO stays latched with the rung false; forgetting the RES is why one is stuck done '
    + 'forever');
  scan(res, io, true);
  assert.deepEqual({ acc: s.acc, dn: s.dn, tt: s.tt, en: s.en },
    { acc: 0, dn: false, tt: false, en: false }, 'RES clears the accumulator and every status bit');
});

test('a scan longer than the preset finishes the timer once, and the overshoot is discarded', () => {
  // Twenty times real time hands a 100 ms scan two seconds of dt. A 100 ms preset is then crossed
  // twenty times over inside one scan, and the honest answer is that a scan is atomic: it happens
  // once, the remainder is dropped, and a "pulse" that never reached the output image did not
  // happen.
  const io = world();
  const t = el('TON', 'T.FAST', 100);
  const s = io.timer('T.FAST');
  assert.equal(scan(t, io, true, 2.0), true, 'the timer executes');
  assert.equal(s.dn, true, 'a preset shorter than the scan is done in that scan');
  assert.equal(s.acc, 100,
    'and the accumulator sits on the preset — carrying the 1900 ms of overshoot forward would let '
    + 'a self-resetting timer complete more than once in one scan, which no processor does');

  const osc = el('TON', 'T.OSC', 100);
  const o = io.timer('T.OSC');
  let ticks = 0;
  for (let k = 0; k < 10; k += 1) {
    scan(osc, io, !o.dn, 2.0);
    if (o.dn) ticks += 1;
  }
  assert.equal(ticks, 5,
    'an oscillator built from a 100 ms TON ticks once every two scans, not two hundred times in '
    + 'twenty simulated seconds. Time compression compresses the process, not the scan — count '
    + 'dt with TOTAL if you need pulses that survive it');
});

test('a timer preset can be driven from a tag, so a recipe can retune a delay without editing logic',
  () => {
    const io = world({ 'R.STAGE_DELAY_MS': 800 });
    const t = el('TON', 'T.STAGE_DLY', 'R.STAGE_DELAY_MS');
    const s = io.timer('T.STAGE_DLY');
    scan(t, io, true, 0.4);
    assert.equal(s.pre, 800, 'the preset is taken from the tag every scan');
    scan(t, io, true, 0.4);
    assert.equal(s.dn, true, 'and the timer completes against it');
    io.vals.set('R.STAGE_DELAY_MS', 2000);
    scan(t, io, false, 0.4);
    scan(t, io, true, 0.4);
    assert.equal(s.pre, 2000, 'a new recipe step raises the delay');
    assert.equal(s.dn, false, 'and the timer is no longer done at 400 ms');
  });

// --------------------------------------------------------------------------------------------
// Counters
// --------------------------------------------------------------------------------------------

test('CTU counts rising edges and not scans, and sets DN at its preset', () => {
  const io = world();
  const c = el('CTU', 'C.P1_STARTS', 3);
  const s = io.counter('C.P1_STARTS');
  for (let k = 0; k < 5; k += 1) scan(c, io, true);
  assert.equal(s.acc, 1,
    'five scans of a held rung are ONE count — a counter that counted scans would read the scan '
    + 'rate, not the number of starts');
  assert.equal(s.cu, true, 'CU follows the rung condition');
  for (const p of [false, true, false, true]) scan(c, io, p);
  assert.equal(s.acc, 3, 'each fresh rising edge adds one');
  assert.equal(s.dn, true, 'and DN sets once the accumulator reaches the preset');
  scan(c, io, false);
  scan(c, io, true);
  assert.equal(s.acc, 4, 'a done counter keeps counting');
  assert.equal(s.dn, true, 'and stays done until it is reset');
});

test('a counter at its rollover wraps to the negative limit and latches the overflow bit', () => {
  const io = world();
  const up = el('CTU', 'C.TOTAL', 10);
  const s = io.counter('C.TOTAL');
  s.acc = 2147483647;
  scan(up, io, false);
  scan(up, io, true);
  assert.equal(s.acc, -2147483648,
    'past the 32-bit limit the accumulator wraps negative, exactly as it does on a real processor');
  assert.equal(s.ov, true, 'and OV latches so the wrap is visible instead of silent');

  const down = el('CTD', 'C.LEVEL', 0);
  const d = io.counter('C.LEVEL');
  d.acc = -2147483648;
  scan(down, io, false);
  scan(down, io, true);
  assert.equal(d.acc, 2147483647, 'counting below the limit wraps the other way');
  assert.equal(d.un, true, 'and UN latches');
});

test('CTD subtracts on each rising edge and RES clears the counter and its status bits', () => {
  const io = world();
  const down = el('CTD', 'C.LEVEL', 2);
  const res = el('RES', 'C.LEVEL');
  const s = io.counter('C.LEVEL');
  s.acc = 3;
  for (const p of [true, false, true]) scan(down, io, p);
  assert.equal(s.acc, 1, 'two rising edges took two off');
  assert.equal(s.dn, false, 'and DN dropped once the accumulator fell below the preset');
  scan(res, io, true);
  assert.deepEqual({ acc: s.acc, dn: s.dn, ov: s.ov, un: s.un },
    { acc: 0, dn: false, ov: false, un: false },
    'RES on a counter zeroes it — and it must find the counter even though RES also serves timers');
});

// --------------------------------------------------------------------------------------------
// Compare
// --------------------------------------------------------------------------------------------

test('the six comparisons agree with their truth tables', () => {
  const io = world({ 'M.A': 5, 'M.B': 9 });
  const cases = [
    ['EQU', false], ['NEQ', true], ['LES', true], ['GRT', false], ['LEQ', true], ['GEQ', false],
  ];
  for (const [m, want] of cases) {
    assert.equal(scan(el(m, 'M.A', 'M.B'), io, true), want,
      `${m} of 5 against 9 must pass ${want}`);
  }
  io.vals.set('M.B', 5);
  for (const [m, want] of [['EQU', true], ['NEQ', false], ['LES', false], ['GRT', false],
    ['LEQ', true], ['GEQ', true]]) {
    assert.equal(scan(el(m, 'M.A', 'M.B'), io, true), want,
      `${m} of two equal values must pass ${want}`);
  }
  assert.equal(scan(el('GRT', 'M.A', '1'), io, false), false,
    'a comparison with no power in cannot pass power out, however it compares');
});

test('LIM tests inside the band, and inverted limits test outside it', () => {
  const io = world();
  const normal = el('LIM', 20, 'M.X', 80);
  const inverted = el('LIM', 80, 'M.X', 20);
  const table = [
    { x: 10, normal: false, inverted: true },
    { x: 20, normal: true, inverted: true },
    { x: 50, normal: true, inverted: false },
    { x: 80, normal: true, inverted: true },
    { x: 90, normal: false, inverted: true },
  ];
  for (const row of table) {
    io.vals.set('M.X', row.x);
    assert.equal(scan(normal, io, true), row.normal,
      `LIM 20..80 with ${row.x} must pass ${row.normal}`);
    assert.equal(scan(inverted, io, true), row.inverted,
      `LIM 80..20 with ${row.x} must pass ${row.inverted} — a low limit above the high limit is an `
      + 'OUTSIDE test, not a mistake the instruction corrects, and swapping the two by accident is '
      + 'why a rung sometimes behaves backwards');
  }
});

test('MEQ compares only the bits the mask selects', () => {
  const io = world({ 'M.STATUS': 0b1011 });
  assert.equal(scan(el('MEQ', 'M.STATUS', 0b0110, 0b0010), io, true), true,
    'the masked bits of 1011 match 0010, whatever the unmasked bits are doing');
  assert.equal(scan(el('MEQ', 'M.STATUS', 0b0110, 0b0110), io, true), false,
    'and differ from 0110');
  assert.equal(scan(el('MEQ', 'M.STATUS', 0, 12345), io, true), true,
    'an empty mask compares nothing, so everything matches');
});

// --------------------------------------------------------------------------------------------
// Math
// --------------------------------------------------------------------------------------------

test('the four operations and the movers write their destination while the rung is true', () => {
  const io = world({ 'M.A': 12, 'M.B': 4 });
  scan(el('ADD', 'M.A', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 16, 'ADD');
  scan(el('SUB', 'M.A', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 8, 'SUB');
  scan(el('MUL', 'M.A', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 48, 'MUL');
  scan(el('DIV', 'M.A', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 3, 'DIV');
  scan(el('MOD', 'M.A', 5, 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 2, 'MOD');
  scan(el('NEG', 'M.A', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), -12, 'NEG');
  scan(el('ABS', 'M.R', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 12, 'ABS');
  scan(el('SQR', 144, 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 12, 'SQR');
  scan(el('MOV', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 4, 'MOV');
  scan(el('CLR', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 0, 'CLR');

  const before = io.vals.get('M.R');
  scan(el('ADD', 'M.A', 'M.B', 'M.R'), io, false);
  assert.equal(io.vals.get('M.R'), before,
    'an unpowered math instruction must write nothing at all — it is an output instruction');
});

test('arithmetic with no answer leaves the destination alone and drops power flow', () => {
  // One rule for all four, so a rung can be written to notice: a coil after the block goes out.
  const io = world({ 'M.R': 42, 'M.ZERO': 0 });
  const cases = [
    { name: 'divide by zero', element: el('DIV', 10, 'M.ZERO', 'M.R') },
    { name: 'modulo by zero', element: el('MOD', 10, 'M.ZERO', 'M.R') },
    { name: 'square root of a negative', element: el('SQR', -9, 'M.R') },
    { name: 'a scale across a zero-width input span', element: el('SCL', 12, 4, 4, 0, 100, 'M.R') },
    { name: 'SCP across a zero-width input span', element: el('SCP', 12, 4, 4, 0, 100, 'M.R') },
  ];
  for (const c of cases) {
    io.faults.length = 0;
    const out = scan(c.element, io, true);
    assert.equal(out, false, `${c.name} must drop power so the rung can annunciate it`);
    assert.equal(io.vals.get('M.R'), 42,
      `${c.name} must leave the last good value in place — a NaN written here poisons every `
      + 'comparison downstream of it and the fault appears somewhere else entirely');
    assert.equal(io.faults.length, 1, `${c.name} must report a minor fault to the processor`);
  }
});

test('SCL extrapolates outside its span and SCP clamps to the output range', () => {
  const io = world();
  scan(el('SCL', 12, 4, 20, 0, 100, 'M.PCT'), io, true);
  assert.equal(io.vals.get('M.PCT'), 50, 'midway up a 4-20 span is 50 percent');
  scan(el('SCL', 24, 4, 20, 0, 100, 'M.PCT'), io, true);
  assert.equal(io.vals.get('M.PCT'), 125,
    'SCL must NOT clamp: an over-range transmitter has to stay visible as over-range instead of '
    + 'being quietly pinned at full scale');
  scan(el('SCP', 24, 4, 20, 0, 100, 'M.CMD'), io, true);
  assert.equal(io.vals.get('M.CMD'), 100,
    'SCP clamps, because the thing on the end of it is a valve and 125 percent open does not exist');
  scan(el('SCP', 0, 4, 20, 0, 100, 'M.CMD'), io, true);
  assert.equal(io.vals.get('M.CMD'), 0, 'and it clamps at the bottom too');
  scan(el('SCP', 12, 20, 4, 0, 100, 'M.CMD'), io, true);
  assert.equal(io.vals.get('M.CMD'), 50, 'a reversed input span is a legitimate reversed scale');
});

test('AVE reports the mean of the samples it actually has, starting from the first scan', () => {
  const io = world({ 'I.PT101': 3 });
  const a = el('AVE', 'I.PT101', 3, 'M.PT_AVG');
  scan(a, io, true);
  assert.equal(io.vals.get('M.PT_AVG'), 3,
    'the first sample must average to itself — averaging it against a window of zeros would give '
    + 'an operator a number that is wrong by a factor of the window length');
  io.vals.set('I.PT101', 6);
  scan(a, io, true);
  assert.equal(io.vals.get('M.PT_AVG'), 4.5, 'then the mean of the two');
  io.vals.set('I.PT101', 9);
  scan(a, io, true);
  assert.equal(io.vals.get('M.PT_AVG'), 6, 'then of the three');
  io.vals.set('I.PT101', 12);
  scan(a, io, true);
  assert.equal(io.vals.get('M.PT_AVG'), 9,
    'and the window then rolls, dropping the oldest sample: mean of 6, 9 and 12');
});

// --------------------------------------------------------------------------------------------
// Logic
// --------------------------------------------------------------------------------------------

test('the logic instructions are bit-by-bit on 32-bit words', () => {
  const io = world({ 'M.A': 0b1100, 'M.B': 0b1010 });
  scan(el('AND', 'M.A', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 0b1000, 'AND keeps the bits both words have');
  scan(el('OR', 'M.A', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 0b1110, 'OR keeps the bits either word has');
  scan(el('XOR', 'M.A', 'M.B', 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), 0b0110, 'XOR keeps the bits that differ');
  scan(el('NOT', 0, 'M.R'), io, true);
  assert.equal(io.vals.get('M.R'), -1, 'the complement of zero is every bit set, which is -1');
});

// --------------------------------------------------------------------------------------------
// Program control
// --------------------------------------------------------------------------------------------

test('JMP asks the scan engine to jump only when power reaches it, and AFI never passes power',
  () => {
    const io = world();
    const jmp = el('JMP', 'SKIP');
    assert.equal(scan(jmp, io, false), false, 'an unpowered JMP does nothing');
    assert.deepEqual(io.jumps, [], 'and asks for no jump');
    assert.equal(scan(jmp, io, true), true, 'a powered JMP passes power');
    assert.deepEqual(io.jumps, ['SKIP'], 'and names its label to the scan engine');

    assert.equal(scan(el('LBL', 'SKIP'), io, true), true, 'a label passes power straight through');
    assert.equal(scan(el('NOP'), io, true), true, 'so does a NOP');
    assert.equal(scan(el('AFI'), io, true), false,
      'an AFI never passes power, which is how you disable a rung while you test');
  });

test('MCR tells the scan engine to open the zone when its rung goes false', () => {
  const io = world();
  const mcr = el('MCR');
  scan(mcr, io, true);
  assert.equal(io.mcrOffs, 0, 'a true MCR rung leaves the zone alone');
  scan(mcr, io, false);
  assert.equal(io.mcrOffs, 1, 'a false one opens it, and the scan engine decides how far it reaches');
});

// --------------------------------------------------------------------------------------------
// Process
// --------------------------------------------------------------------------------------------

test('PID commands the rig\'s own loop and mirrors its output, rather than re-implementing one',
  () => {
    const calls = [];
    const io = world();
    io.ctx = { run: { co_pct: 63.5 } };
    io.sim = {
      /**
       * @param {object} ctx the sim context
       * @param {number} sp the setpoint
       * @returns {void}
       */
      setSetpoint(ctx, sp) { calls.push(['sp', sp]); },
      /**
       * @param {object} ctx the sim context
       * @param {string} m the mode
       * @returns {void}
       */
      setControllerMode(ctx, m) { calls.push(['mode', m]); },
    };
    const p = el('PID', 4.2, "'AUTO'", 'M.CO');
    assert.equal(scan(p, io, true), true, 'a powered PID block passes power');
    assert.deepEqual(calls, [['sp', 4.2], ['mode', 'AUTO']],
      'the setpoint and the mode go to the loop through its own actions, so every guard the loop '
      + 'has still applies');
    assert.equal(io.vals.get('M.CO'), 63.5, 'and the live output is mirrored into the tag database');

    calls.length = 0;
    io.ctx.run.co_pct = 71;
    assert.equal(scan(p, io, false), false, 'an unpowered PID block commands nothing');
    assert.deepEqual(calls, [], 'no setpoint and no mode change');
    assert.equal(io.vals.get('M.CO'), 71,
      'but the output is still mirrored — a monitor tag that freezes when a rung goes false is a '
      + 'display that lies');
  });

test('PID refuses when the loop rejects the command, instead of pretending it worked', () => {
  const io = world();
  io.ctx = { run: { co_pct: 10 } };
  io.sim = {
    /**
     * @returns {{ok:boolean, reason:string}} the loop's refusal
     */
    setSetpoint() { return { ok: false, reason: 'setpoint is outside the transmitter range' }; },
  };
  assert.equal(scan(el('PID', 900), io, true), false,
    'the loop refused, so power must drop and the rung can light a lamp');
  assert.equal(io.faults.length, 1, 'and the reason must reach the processor as a minor fault');
  assert.match(io.faults[0], /transmitter range/,
    'carrying the loop\'s own words, not a generic failure');
});

test('SETPT writes inside its band and reports when the recipe asked for something out of reach',
  () => {
    const io = world();
    const s = el('SETPT', 'R.HEADER_SP', 1.5, 5.5, 'Q.SP');
    io.vals.set('R.HEADER_SP', 4.2);
    assert.equal(scan(s, io, true), true, 'an in-range value is accepted');
    assert.equal(io.vals.get('Q.SP'), 4.2, 'and written straight through');
    io.vals.set('R.HEADER_SP', 9);
    assert.equal(scan(s, io, true), false,
      'a value outside the band drops power, so the rung can tell the operator the recipe asked '
      + 'for something the plant will not do');
    assert.equal(io.vals.get('Q.SP'), 5.5,
      'and the setpoint is held at the limit rather than refused outright — the plant keeps running');
  });

test('RAMP moves a value at its rate and passes power only once it has arrived', () => {
  const io = world({ 'Q.SP': 0 });
  const r = el('RAMP', 10, 2, 'Q.SP');
  const seen = [];
  for (let k = 0; k < 6; k += 1) seen.push([scan(r, io, true, 1.0), io.vals.get('Q.SP')]);
  assert.deepEqual(seen.map((x) => x[1]), [2, 4, 6, 8, 10, 10],
    'two units a second for one second a scan');
  assert.deepEqual(seen.map((x) => x[0]), [false, false, false, false, true, true],
    'power passes only on arrival — that is the "step complete" a recipe walker sequences on');
  scan(r, io, false, 1.0);
  assert.equal(io.vals.get('Q.SP'), 10, 'a false rung holds the value where it is');
});

test('TOTAL integrates a per-hour rate into engineering units and counts the whole of a long scan',
  () => {
    const io = world({ 'I.FT101': 3600, 'M.TOTAL_M3': 0 });
    const t = el('TOTAL', 'I.FT101', 'M.TOTAL_M3');
    scan(t, io, true, 1.0);
    assert.equal(io.vals.get('M.TOTAL_M3'), 1,
      '3600 m3/h for one second is one m3 — the divisor defaults to 3600 because every rate on '
      + 'this rig is per hour');
    scan(t, io, true, 20.0);
    assert.equal(io.vals.get('M.TOTAL_M3'), 21,
      'and a twenty-second scan adds twenty m3: unlike a timer, a totaliser stays exact under time '
      + 'compression because it integrates dt instead of counting edges');
    scan(t, io, false, 20.0);
    assert.equal(io.vals.get('M.TOTAL_M3'), 21, 'a false rung totals nothing');
    scan(el('CLR', 'M.TOTAL_M3'), io, true);
    assert.equal(io.vals.get('M.TOTAL_M3'), 0, 'and a CLR is the shift reset');
  });

test('DEADBAND passes a value only once it has moved further than the band', () => {
  const io = world({ 'I.PT101': 4.00 });
  const d = el('DEADBAND', 'I.PT101', 0.2, 'M.PT_REPORTED');
  assert.equal(scan(d, io, true), true, 'the first execution always passes a value');
  assert.equal(io.vals.get('M.PT_REPORTED'), 4, 'so the destination is never left empty');
  io.vals.set('I.PT101', 4.1);
  assert.equal(scan(d, io, true), false, 'noise inside the band writes nothing');
  assert.equal(io.vals.get('M.PT_REPORTED'), 4, 'and the reported value does not move');
  io.vals.set('I.PT101', 4.25);
  assert.equal(scan(d, io, true), true, 'a real move passes');
  assert.equal(io.vals.get('M.PT_REPORTED'), 4.25, 'and updates the report');
});

test('ALARM latches on the excursion and needs the deadband before it will clear', () => {
  const io = world({ 'I.PT101': 5 });
  const a = el('ALARM', 'I.PT101', 2, 10, 'M.PT_HI', 2);
  assert.equal(scan(a, io, true), false, 'inside the band there is no alarm');
  assert.equal(io.vals.get('M.PT_HI'), false, 'and the bit is clear');
  io.vals.set('I.PT101', 11);
  assert.equal(scan(a, io, true), true, 'above the high limit the alarm comes in');
  assert.equal(io.vals.get('M.PT_HI'), true, 'and sets its bit');
  io.vals.set('I.PT101', 9);
  assert.equal(scan(a, io, true), true,
    'back below the limit but inside the deadband the alarm HOLDS — without that hysteresis a '
    + 'measurement sitting on its limit produces an alarm an operator learns to ignore');
  io.vals.set('I.PT101', 7.9);
  assert.equal(scan(a, io, true), false, 'clear of the deadband it resets');
  assert.equal(io.vals.get('M.PT_HI'), false, 'and clears the bit');
  io.vals.set('I.PT101', 1);
  assert.equal(scan(a, io, true), true, 'the low limit works the same way');
  assert.equal(scan(a, io, false), false, 'and a false rung clears the alarm outright');
  assert.equal(io.vals.get('M.PT_HI'), false, 'bit included');
});

test('ALTERNATE advances the duty on an edge, never on a level, and wraps at the machine count',
  () => {
    const io = world({ 'M.DUTY': 0 });
    const a = el('ALTERNATE', 'M.DUTY', 2);
    scan(a, io, true);
    assert.equal(io.vals.get('M.DUTY'), 1, 'the rising edge advances the duty');
    scan(a, io, true);
    scan(a, io, true);
    assert.equal(io.vals.get('M.DUTY'), 1,
      'holding the rung must NOT keep advancing it — a set that swapped lead pump every scan would '
      + 'never start anything');
    scan(a, io, false);
    scan(a, io, true);
    assert.equal(io.vals.get('M.DUTY'), 0, 'and the next edge wraps back around the two machines');

    io.vals.set('M.LEAD_IS_P1', true);
    const b = el('ALTERNATE', 'M.LEAD_IS_P1');
    scan(b, io, true);
    assert.equal(io.vals.get('M.LEAD_IS_P1'), false, 'a BOOL duty tag simply toggles');
  });

test('RUNHOURS accumulates the scan period in hours while its rung is true', () => {
  const io = world({ 'M.P1_HOURS': 0 });
  const h = el('RUNHOURS', 'M.P1_HOURS');
  scan(h, io, true, 1800);
  assert.equal(io.vals.get('M.P1_HOURS'), 0.5, 'half an hour of running');
  scan(h, io, false, 1800);
  assert.equal(io.vals.get('M.P1_HOURS'), 0.5, 'a stopped machine logs nothing');
  scan(h, io, true, 1800);
  assert.equal(io.vals.get('M.P1_HOURS'), 1, 'and the total carries on where it left off');
});

// --------------------------------------------------------------------------------------------
// Operands, validation and the helpers the other modules use
// --------------------------------------------------------------------------------------------

test('operands may be literals, quoted strings or tag names, and a timer member reads by its bit',
  () => {
    const io = world({ 'M.X': 7 });
    assert.equal(scan(el('GRT', 'M.X', '5'), io, true), true, 'a numeric literal reads as a number');
    assert.equal(scan(el('GRT', 'M.X', -2), io, true), true, 'so does a negative one');
    assert.equal(scan(el('XIC', 'TRUE'), io, true), true, 'TRUE is a literal, not a tag name');
    assert.equal(scan(el('XIC', 'FALSE'), io, true), false, 'and so is FALSE');

    const t = el('TON', 'T.DLY', 100);
    scan(t, io, true, 1.0);
    assert.equal(scan(el('XIC', 'T.DLY.DN'), io, true), true,
      'a dotted member resolves through the timer structure even on a database that does not '
      + 'define members as tags of their own');
    assert.equal(scan(el('XIC', 'T.DLY'), io, true), true,
      'and a bare timer name examines its DN bit, which is what an operator expects it to mean');
    assert.equal(scan(el('GEQ', 'T.DLY.ACC', 100), io, true), true,
      'while a numeric context reads the accumulator');
  });

test('a write the database refuses costs the element its power flow and raises a minor fault', () => {
  const io = world();
  io.write = () => ({ ok: false, reason: 'Q.P1_START is forced' });
  assert.equal(scan(el('OTE', 'Q.P1_START'), io, true), false,
    'an OTE whose bit will not take the write must not claim it energised');
  assert.equal(io.faults.length, 1, 'and the processor must hear about it');
});

test('checkOperands catches a missing operand, a literal where a tag belongs, and a typo', () => {
  const bad = checkOperands({ mnemonic: 'NOTAREALONE', operands: [] });
  assert.equal(bad.length, 1, 'an unknown mnemonic is one problem');
  assert.equal(bad[0].severity, 'error', 'and it is an error, not a warning');

  const short = checkOperands(el('ADD', 'M.A'));
  assert.ok(short.some((p) => p.severity === 'error' && /needs 3 operand/.test(p.message)),
    'ADD with one operand must be reported: two thirds of a math instruction does nothing useful');

  const literalDest = checkOperands({ mnemonic: 'OTE', operands: [12] });
  assert.ok(literalDest.some((p) => /must be a tag/.test(p.message)),
    'a coil on a literal can never be written, and the editor must say so before it is downloaded');

  assert.deepEqual(checkOperands(el('XIC', 'I.RUN')), [],
    'a well-formed element with no database to check against reports nothing');

  const db = { tags: { 'I.PT101': { name: 'I.PT101', type: 'REAL' } } };
  const wrongType = checkOperands(el('XIC', 'I.PT101'), db);
  assert.ok(wrongType.some((p) => p.severity === 'warn'),
    'examining a REAL as if it were a bit is worth a warning');
  const missing = checkOperands(el('XIC', 'I.NOPE'), db);
  assert.ok(missing.some((p) => p.severity === 'error' && /names no tag/.test(p.message)),
    'and a tag the database has never heard of is an error');
});

test('describeElement renders an element as the phrase a rung summary is built from', () => {
  assert.equal(describeElement(el('TON', 'T.STAGE_DLY', 8000)), 'time T.STAGE_DLY for 8000 ms',
    'the template fills from the operands in order');
  assert.equal(describeElement(el('XIO', 'I.P1_FAULT')), 'I.P1_FAULT is off',
    'and reads as a clause inside a sentence, not as a sentence of its own');
  assert.equal(describeElement(el('OSR')), 'pulse ? as power arrives',
    'a missing optional operand shows as a gap rather than the word undefined');
  assert.equal(describeElement({ mnemonic: 'WAT', operands: [] }), 'WAT (unknown)',
    'and an unknown instruction says so');
});

test('createElement refuses a mnemonic the processor does not have', () => {
  const r = createElement('TIMER', ['T.A']);
  assert.equal(r.ok, false, 'a plausible-looking typo must be refused, not silently accepted');
  assert.match(r.reason, /no instruction called/, 'with a sentence an operator could read');
  const ok = createElement('ton', ['T.A', 100]);
  assert.equal(ok.ok, true, 'and a mnemonic is case-insensitive on the way in');
  assert.equal(ok.el.mnemonic, 'TON', 'but is stored the one way the document format spells it');
});

test('evaluateElement never throws, and leaves the power it was handed the way it found it', () => {
  const io = world();
  io.read = () => { throw new Error('the database exploded'); };
  assert.equal(scan(el('XIC', 'I.RUN'), io, true), false,
    'a database that throws while being read costs the element its power flow — it does not take '
    + 'the processor down in the middle of a scan');

  const malformed = {
    mnemonic: 'XIC',
    /** @returns {Array} never: a document this broken should fault the processor, not the browser */
    get operands() { throw new Error('the document is malformed'); },
  };
  assert.equal(evaluateElement(null, malformed, io, 0.1, true), false,
    'and neither does an element whose operand list cannot even be read');
  assert.equal(io.faults.length, 1, 'that one must be reported as a fault');
  assert.match(io.faults[0], /malformed/, 'carrying what actually went wrong');

  const clean = world({ 'I.RUN': true });
  clean.power = 'branch';
  evaluateElement(null, el('XIC', 'I.RUN'), clean, 0.1, true);
  assert.equal(clean.power, 'branch',
    'the incoming power is restored afterwards, so evaluating a branch leg cannot leak its power '
    + 'into the leg that follows it');
});

test('an element\'s scan-to-scan memory belongs to the element and can be thrown away with it',
  () => {
    const io = world();
    const ons = el('ONS');
    scan(ons, io, true);
    assert.equal(scan(ons, io, true), false, 'the one-shot is armed against the held input');
    assert.ok(elementState(ons).edge === true, 'and its memory is on the element');
    clearElementState(ons);
    assert.equal(scan(ons, io, true), true,
      'forgetting the element state rearms it — which is what a fresh download of the program is');
  });
