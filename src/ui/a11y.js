/**
 * src/ui/a11y.js — the accessibility layer: live regions, canvas alternatives, focus management
 * and a DOM audit.
 *
 * Layer L6: imports `ui/dom.js` and `data/config.js`, reads the sim context, writes no state.
 *
 * ------------------------------------------------------------------------------------------
 * WHY AN INDUSTRIAL HMI IS A HARD CASE, AND WHAT EACH PART HERE IS FOR
 *
 * Three properties of this application each break a different assumption that ordinary web
 * accessibility rests on:
 *
 *   1. THE INFORMATION IS ON CANVASES. A trend, a P&ID and a Bode plot are pixels. `role="img"`
 *      with a fixed label is a lie the moment the plant moves, so every canvas view gets a LIVE
 *      TEXTUAL DESCRIPTION regenerated from the same state the pixels came from. The generators
 *      are pure functions of a plain state record — `describeTrend`, `describeMimic`,
 *      `describeBode` — which is what makes them testable, and what stops them drifting away
 *      from the drawing.
 *
 *   2. THE INTERACTION IS POINTER-DRIVEN. Chip groups are drawn as rows of buttons, which is
 *      twenty tab stops to reach one view. The roving-tabindex machine below turns each group
 *      into ONE tab stop with arrow keys inside it, which is the ARIA toolbar pattern and the
 *      difference between navigable and merely present.
 *
 *   3. THE IMPORTANT EVENTS ARRIVE ASYNCHRONOUSLY. An alarm is not a response to anything the
 *      user did. It has to interrupt, once, at a politeness that matches its severity — and it
 *      must not flood. At 20x time compression this rig can raise more events per second than
 *      speech can deliver, and the failure mode of a flooding live region is not "verbose": it
 *      is a user who turns announcements off and then misses the one alarm that mattered. So
 *      every announcement goes through a rate limiter that suppresses repeats, holds a minimum
 *      gap, caps a rolling window, and COALESCES a backlog into a count rather than dropping it
 *      silently.
 *
 * NOTHING IN SECTIONS 1-7 TOUCHES THE DOM OR READS A CLOCK. Times are passed in. That keeps the
 * whole of the interesting behaviour testable under `node --test`, where there is no document.
 * Section 8 is the thin DOM shim that supplies the clock and the elements.
 * ------------------------------------------------------------------------------------------
 */

import { h, setText, setAttr } from './dom.js';
import { LOOP_EU } from '../data/config.js';

// ============================================================================================
// 1. POLITENESS AND THE ANNOUNCEMENT RATE LIMITER
// ============================================================================================

/** ARIA live-region politeness levels. */
export const POLITENESS = Object.freeze({
  /** Interrupts whatever is being spoken. Reserved for conditions that need a response NOW. */
  ASSERTIVE: 'assertive',
  /** Queued behind the current utterance. Everything else. */
  POLITE: 'polite',
  /** Not announced at all. */
  OFF: 'off',
});

/**
 * Severity to politeness.
 *
 * Only a real ALARM is allowed to interrupt. Making warnings assertive too is the commonest way
 * a live region becomes unusable: on a rig that raises a low-NPSH warning every time the tank
 * drifts, an interrupting warning means the operator never hears the end of a sentence.
 *
 * @param {string} sev one of 'ALARM', 'WARN', 'INFO'
 * @returns {string} the {@link POLITENESS} level
 */
export function severityPoliteness(sev) {
  return sev === 'ALARM' ? POLITENESS.ASSERTIVE : POLITENESS.POLITE;
}

/**
 * Rate-limiter defaults, in wall milliseconds.
 *
 * `minGap_ms` is the floor between two polite utterances: below about 800 ms a screen reader is
 * still speaking the previous one, and the new text either queues without bound or cuts it off.
 * `maxPerWindow` is the honest admission that ten seconds of speech is roughly six short lines.
 */
export const ANNOUNCE_DEFAULTS = Object.freeze({
  /** Minimum spacing between polite announcements, ms. */
  minGap_ms: 900,
  /** Minimum spacing between assertive announcements, ms. An alarm may interrupt sooner. */
  assertiveGap_ms: 300,
  /** Length of the rolling budget window, ms. */
  window_ms: 10000,
  /** How many announcements may be delivered inside one window. */
  maxPerWindow: 6,
  /** How long the same key stays suppressed after it was spoken, ms. */
  repeat_ms: 30000,
  /** Backlog size at which a class of messages is collapsed into one counted line. */
  coalesceAt: 3,
  /** Hard cap on the queue, so a stalled consumer cannot grow it without bound. */
  maxPending: 40,
  /** How long a polite message may wait before it is stale and dropped, ms. */
  stale_ms: 20000,
});

/**
 * Build an announcement queue.
 * @param {object} [opts] overrides for {@link ANNOUNCE_DEFAULTS}
 * @returns {object} the announcer state, for {@link offerAnnouncement} and
 *   {@link drainAnnouncements}
 */
export function createAnnouncer(opts) {
  return {
    opts: Object.freeze({ ...ANNOUNCE_DEFAULTS, ...(opts || {}) }),
    /** @type {Array<{text:string, politeness:string, key:string, at_ms:number, seq:number}>} */
    pending: [],
    /** Delivery timestamps inside the current window, oldest first. */
    stamps: [],
    /** Key -> the time it was last SPOKEN. Offers dedupe against delivery, not against offers. */
    seen: new Map(),
    lastAt_ms: -Infinity,
    /** Counters, for the diagnostics line and for the tests. */
    delivered: 0,
    suppressed: 0,
    coalesced: 0,
    seq: 0,
  };
}

/**
 * Offer a message to the queue. It may be refused as a repeat, as a duplicate already queued, or
 * because the queue is full — a refusal is normal here, not an error.
 *
 * @param {object} st announcer state from {@link createAnnouncer}
 * @param {object} item the message
 * @param {string} item.text what to say
 * @param {string} [item.politeness] one of {@link POLITENESS}; defaults to polite
 * @param {string} [item.key] identity for repeat suppression; defaults to the text
 * @param {number} now_ms the current wall time
 * @returns {{ok:boolean, reason?:string}} accepted, or refused with the reason
 */
export function offerAnnouncement(st, item, now_ms) {
  if (!st || !item) return { ok: false, reason: 'nothing to announce' };
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return { ok: false, reason: 'empty announcement' };
  const politeness = item.politeness === POLITENESS.ASSERTIVE ? POLITENESS.ASSERTIVE
    : item.politeness === POLITENESS.OFF ? POLITENESS.OFF : POLITENESS.POLITE;
  if (politeness === POLITENESS.OFF) return { ok: false, reason: 'politeness off' };
  const key = item.key || text;

  // A standing alarm re-raises on every scan. Announcing it once is the entire point of the key;
  // announcing it every scan is the flood.
  const spokeAt = st.seen.get(key);
  if (spokeAt !== undefined && now_ms - spokeAt < st.opts.repeat_ms) {
    st.suppressed += 1;
    return { ok: false, reason: 'already announced' };
  }
  if (st.pending.some((p) => p.key === key)) {
    st.suppressed += 1;
    return { ok: false, reason: 'already queued' };
  }

  st.pending.push({ text, politeness, key, at_ms: now_ms, seq: st.seq });
  st.seq += 1;

  // Over the cap, polite messages give way to assertive ones. Dropping the newest would hide the
  // most recent state of the plant, so the oldest polite entry goes instead.
  while (st.pending.length > st.opts.maxPending) {
    const i = st.pending.findIndex((p) => p.politeness === POLITENESS.POLITE);
    st.pending.splice(i >= 0 ? i : 0, 1);
    st.suppressed += 1;
  }
  return { ok: true };
}

/**
 * Collapse a backlog into one counted line.
 * @param {Array<{text:string}>} items the queued messages, oldest first
 * @param {string} politeness the class being collapsed
 * @returns {string} the summary line
 */
export function summariseAnnouncements(items, politeness) {
  const n = items ? items.length : 0;
  if (n === 0) return '';
  if (n === 1) return items[0].text;
  if (politeness === POLITENESS.ASSERTIVE) {
    // Oldest first: the condition that STARTED the cascade is the one worth naming, because it
    // is usually the cause and the rest are usually its consequences.
    return `${n} alarms. ${items[0].text}. And ${n - 1} more — press A to acknowledge, or open `
      + 'the alarm list for all of them.';
  }
  return `${n} status messages. ${items[n - 1].text}. And ${n - 1} earlier.`;
}

/**
 * Take whatever may be spoken now.
 *
 * Returns zero or one message: a live region written twice in one frame announces only the
 * second write, so handing back a list would silently lose everything but its last entry.
 *
 * @param {object} st announcer state
 * @param {number} now_ms the current wall time
 * @returns {Array<{text:string, politeness:string, count:number}>} zero or one message
 */
export function drainAnnouncements(st, now_ms) {
  if (!st) return [];
  const o = st.opts;
  st.stamps = st.stamps.filter((t) => now_ms - t < o.window_ms);

  // A polite message about something twenty seconds gone is noise, not information.
  if (st.pending.length) {
    const keep = st.pending.filter((p) => p.politeness === POLITENESS.ASSERTIVE
      || now_ms - p.at_ms < o.stale_ms);
    st.suppressed += st.pending.length - keep.length;
    st.pending = keep;
  }
  if (!st.pending.length) return [];

  // Assertive first, then in the order they arrived.
  st.pending.sort((a, b) => (a.politeness === b.politeness
    ? a.seq - b.seq
    : (a.politeness === POLITENESS.ASSERTIVE ? -1 : 1)));

  const head = st.pending[0];
  const gap = head.politeness === POLITENESS.ASSERTIVE ? o.assertiveGap_ms : o.minGap_ms;
  if (now_ms - st.lastAt_ms < gap) return [];
  if (st.stamps.length >= o.maxPerWindow) return [];

  const sameClass = st.pending.filter((p) => p.politeness === head.politeness);
  const collapse = sameClass.length >= o.coalesceAt;
  const taken = collapse ? sameClass : [head];
  const text = collapse ? summariseAnnouncements(taken, head.politeness) : head.text;

  st.pending = st.pending.filter((p) => !taken.includes(p));
  for (const p of taken) st.seen.set(p.key, now_ms);
  st.lastAt_ms = now_ms;
  st.stamps.push(now_ms);
  st.delivered += 1;
  if (collapse) st.coalesced += taken.length - 1;

  return [{ text, politeness: head.politeness, count: taken.length }];
}

/**
 * Forget every suppression, so the next offer of a standing condition is spoken again. Called
 * when the operator acknowledges the alarm list, or when a run is reset.
 * @param {object} st announcer state
 * @returns {void}
 */
export function resetAnnouncer(st) {
  if (!st) return;
  st.pending.length = 0;
  st.stamps.length = 0;
  st.seen.clear();
  st.lastAt_ms = -Infinity;
}

// ============================================================================================
// 2. THE LANGUAGE OF NUMBERS
//
// Every generator below speaks through these, so a value is never read out as a bare token and a
// direction is never described in one view and left undescribed in another.
// ============================================================================================

/** Units as they should be READ, not as they are printed on a faceplate. */
const UNIT_WORDS = Object.freeze({
  'm³/h': 'cubic metres per hour',
  'm3/h': 'cubic metres per hour',
  '%': 'percent',
  bar: 'bar',
  m: 'metres',
  s: 'seconds',
  kW: 'kilowatts',
  'kWh/m³': 'kilowatt hours per cubic metre',
  'mm/s': 'millimetres per second',
  C: 'degrees Celsius',
  'rad/s': 'radians per second',
  deg: 'degrees',
  dB: 'decibels',
});

/**
 * Spell a unit for speech.
 * @param {string} u the printed unit
 * @returns {string} the spoken form, or the unit unchanged
 */
export function sayUnit(u) {
  return UNIT_WORDS[u] || u || '';
}

/**
 * A number with its unit, spoken rather than printed: no superscripts, no em dashes, and never
 * the string "NaN" — a screen reader pronounces that, and it means nothing to an operator.
 * @param {number} v the value
 * @param {number} [dp=1] decimals
 * @param {string} [unit] the engineering unit
 * @returns {string} e.g. `3.21 bar`, or `not available`
 */
export function say(v, dp = 1, unit) {
  if (!Number.isFinite(v)) return 'not available';
  const x = Math.abs(v) < 0.5 / 10 ** dp ? 0 : v;
  const n = x.toFixed(dp);
  return unit ? `${n} ${sayUnit(unit)}` : n;
}

/**
 * A duration in words.
 * @param {number} t_s seconds
 * @returns {string} e.g. `45 seconds`, `4.0 minutes`
 */
export function sayDuration(t_s) {
  if (!Number.isFinite(t_s) || t_s < 0) return 'an unknown time';
  if (t_s < 90) return `${Math.round(t_s)} seconds`;
  const min = t_s / 60;
  if (min < 60) return `${min.toFixed(min < 10 ? 1 : 0)} minutes`;
  return `${(min / 60).toFixed(1)} hours`;
}

/**
 * A trend window in words.
 * @param {number} span_s the window length, s
 * @returns {string} e.g. `the last 4 minutes`
 */
export function sayWindow(span_s) {
  return `the last ${sayDuration(span_s)}`;
}

/**
 * Join a list the way a sentence does.
 * @param {string[]} parts the items
 * @returns {string} `a`, `a and b`, or `a, b and c`
 */
export function sayList(parts) {
  const p = (parts || []).filter(Boolean);
  if (!p.length) return '';
  if (p.length === 1) return p[0];
  return `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
}

/**
 * Describe where a series has been going.
 *
 * The classification is deliberately coarse — five words — because a screen-reader user hearing
 * this every few seconds needs a shape, not a slope. `swinging` is tested FIRST: a signal that
 * ends where it started after four excursions is not steady, and calling it steady would hide
 * the single most important thing a trend can show a control engineer.
 *
 * @param {ArrayLike<number>} values the samples, oldest first
 * @param {object} [opts] thresholds
 * @param {number} [opts.scale] the engineering span the signal lives on; defaults to its own range
 * @param {number} [opts.noise] movement below this is not movement; defaults to 2% of the scale
 * @returns {{word:string, delta:number, first:number, last:number, min:number, max:number,
 *   range:number, swings:number}} the shape
 */
export function trendDirection(values, opts = {}) {
  const n = values ? values.length : 0;
  if (n < 2) {
    const only = n === 1 ? Number(values[0]) : NaN;
    return {
      word: n === 1 && Number.isFinite(only) ? 'steady' : 'not available',
      delta: 0, first: only, last: only, min: only, max: only, range: 0, swings: 0,
    };
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    return {
      word: 'not available', delta: NaN, first: NaN, last: NaN,
      min: NaN, max: NaN, range: NaN, swings: 0,
    };
  }
  const first = Number(values[0]);
  const last = Number(values[n - 1]);
  const range = max - min;
  const scale = Number.isFinite(opts.scale) && opts.scale > 0
    ? opts.scale : (range || Math.abs(last) || 1);
  const noise = Number.isFinite(opts.noise) && opts.noise > 0 ? opts.noise : scale * 0.02;
  const delta = last - first;

  // Count direction reversals against a moving anchor, so sample noise does not read as an
  // oscillation: only an excursion bigger than half the noise band moves the anchor at all.
  let swings = 0;
  let dir = 0;
  let anchor = first;
  for (let i = 1; i < n; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    const d = v - anchor;
    if (Math.abs(d) < noise * 0.5) continue;
    const sgn = d > 0 ? 1 : -1;
    if (dir !== 0 && sgn !== dir) swings += 1;
    dir = sgn;
    anchor = v;
  }

  let word;
  if (swings >= 3) word = 'swinging';
  else if (Math.abs(delta) < noise) word = 'steady';
  else if (Math.abs(delta) > noise * 6) word = delta > 0 ? 'rising quickly' : 'falling quickly';
  else word = delta > 0 ? 'rising' : 'falling';
  return { word, delta, first, last, min, max, range, swings };
}

/**
 * How the measurement stands against its setpoint, in the words a panel operator would use.
 * @param {number} pv the measurement
 * @param {number} sp the setpoint
 * @param {number} span the engineering span, for judging "close"
 * @param {number} [dp=2] decimals
 * @param {string} [unit] engineering unit
 * @returns {string} e.g. `on setpoint`, `0.42 bar below setpoint`
 */
export function sayError(pv, sp, span, dp = 2, unit) {
  if (!Number.isFinite(pv) || !Number.isFinite(sp)) return 'setpoint comparison not available';
  const e = pv - sp;
  const band = Math.abs(span || 0) * 0.005;
  if (Math.abs(e) <= band) return 'on setpoint';
  return `${say(Math.abs(e), dp, unit)} ${e > 0 ? 'above' : 'below'} setpoint`;
}

// ============================================================================================
// 3. THE DESCRIPTION GENERATORS
//
// Each takes a plain state record — never the sim context, never a canvas — and returns the same
// shape: `{ text, rows }`. `text` is the prose a live region speaks; `rows` are label/value pairs
// the same information rendered as a definition list, so a user can ARROW THROUGH the numbers
// instead of listening to the whole paragraph again to hear the third one.
// ============================================================================================

/**
 * Wrap a description in the standard shape.
 * @param {string[]} sentences the prose, already punctuated
 * @param {Array<{label:string, value:string}>} rows the table form
 * @returns {{text:string, rows:Array<{label:string, value:string}>}} the description
 */
function description(sentences, rows) {
  return { text: sentences.filter(Boolean).join(' '), rows };
}

/**
 * Describe the trend as a spoken trace: what each pen reads now, and what it has been doing.
 *
 * @param {object} t the trend state, from {@link readTrendState}
 * @param {number} t.span_s the window shown, s
 * @param {{tag:string, label:string, unit:string, dp:number, span:number}} t.loop the loop
 * @param {number} t.sp the setpoint
 * @param {number} t.pv the measurement
 * @param {Array<{key:string, label:string, unit:string, dp:number, scale:number,
 *   values:ArrayLike<number>}>} t.pens the pens, the controlled variable FIRST
 * @param {number} [t.settled_s] how long the loop has been inside the settling band, s
 * @param {boolean} [t.saturated] whether the output has been at a limit inside the window
 * @returns {{text:string, rows:Array<{label:string, value:string}>}} the description
 */
export function describeTrend(t) {
  if (!t || !t.pens || !t.pens.length) {
    return description(['The trend has no samples yet.'], []);
  }
  const loop = t.loop || { tag: 'the loop', label: 'the controlled variable', unit: '', dp: 2, span: 1 };
  const rows = [];
  const S = [`Trend for ${loop.tag}, ${loop.label}, over ${sayWindow(t.span_s)}.`];

  const pv = t.pens[0];
  const d = trendDirection(pv.values, { scale: pv.scale });
  S.push(`The measurement is ${say(t.pv, loop.dp, loop.unit)} against a setpoint of `
    + `${say(t.sp, loop.dp, loop.unit)} — ${sayError(t.pv, t.sp, loop.span, loop.dp, loop.unit)}.`);
  rows.push({ label: `${loop.label} (PV)`, value: say(t.pv, loop.dp, loop.unit) });
  rows.push({ label: 'setpoint', value: say(t.sp, loop.dp, loop.unit) });

  if (d.word === 'swinging') {
    // The number that matters about a cycle is its amplitude, not its endpoints.
    S.push(`Over ${sayWindow(t.span_s)} it has been swinging between `
      + `${say(d.min, loop.dp)} and ${say(d.max, loop.dp, loop.unit)} — `
      + `${d.swings} reversals, so this loop is cycling.`);
  } else if (d.word === 'steady') {
    S.push(`It has held within ${say(d.range, loop.dp, loop.unit)} across the whole window.`);
  } else {
    S.push(`Over the window it went from ${say(d.first, loop.dp)} to `
      + `${say(d.last, loop.dp, loop.unit)} and is ${d.word}.`);
  }
  rows.push({ label: 'trace', value: `${d.word}, between ${say(d.min, loop.dp)} and ${say(d.max, loop.dp, loop.unit)}` });

  if (Number.isFinite(t.settled_s) && t.settled_s > 0) {
    S.push(`It has been inside the settling band for ${sayDuration(t.settled_s)}.`);
  }

  const rest = t.pens.slice(1);
  if (rest.length) {
    const parts = rest.map((p) => {
      const pd = trendDirection(p.values, { scale: p.scale });
      rows.push({ label: p.label, value: `${say(p.last, p.dp, p.unit)}, ${pd.word}` });
      return `${p.label} ${say(p.last, p.dp, p.unit)}, ${pd.word}`;
    });
    S.push(`${rest.length === 1 ? 'One other pen' : `${rest.length} other pens`}: ${sayList(parts)}.`);
  }
  if (t.saturated) {
    S.push('The controller output has been at a limit inside this window, so the loop has '
      + 'spent part of it with no authority left.');
  }
  return description(S, rows);
}

/**
 * Describe the P&ID as a structured status list: the loop, each machine, the process, and what
 * is in alarm.
 *
 * This is the one description that has to be COMPLETE rather than short. It is the substitute
 * for looking at the schematic, and an operator looking at the schematic can see every symbol at
 * once; a list that omits the stopped pump is a list that cannot be used to run the rig.
 *
 * @param {object} m the mimic state, from {@link readMimicState}
 * @returns {{text:string, rows:Array<{label:string, value:string}>,
 *   sections:Array<{heading:string, rows:Array<{label:string, value:string}>}>}} the description
 */
export function describeMimic(m) {
  if (!m || !m.loop) return description(['The schematic is not available.'], []);
  const { loop } = m;
  const S = [];
  const sections = [];

  // ---- the loop -----------------------------------------------------------------------------
  const loopRows = [
    { label: 'controller', value: `${loop.tag}, ${m.mode.toLowerCase()}` },
    { label: 'setpoint', value: say(m.sp, loop.dp, loop.unit) },
    { label: 'measurement', value: say(m.pv, loop.dp, loop.unit) },
    { label: 'output', value: say(m.co, 1, '%') },
  ];
  S.push(`${loop.tag} controls ${loop.label} in ${m.mode.toLowerCase()}: setpoint `
    + `${say(m.sp, loop.dp, loop.unit)}, measurement ${say(m.pv, loop.dp, loop.unit)}, `
    + `${sayError(m.pv, m.sp, loop.span, loop.dp, loop.unit)}, output ${say(m.co, 1, '%')}.`);
  if (m.owner && m.owner !== 'the controller') {
    S.push(`${m.owner} currently owns the output, not the controller.`);
    loopRows.push({ label: 'output owner', value: m.owner });
  }
  if (Number.isFinite(m.ff) && Math.abs(m.ff) > 0.05) {
    loopRows.push({ label: 'feedforward', value: say(m.ff, 1, '%') });
  }
  sections.push({ heading: 'Loop', rows: loopRows });

  // ---- the machines ---------------------------------------------------------------------------
  const machineRows = [];
  const machineWords = [];
  for (const p of m.pumps || []) {
    const role = p.lead ? 'lead' : 'lag';
    const bits = [];
    if (p.state === 'RUNNING') {
      bits.push(`running at ${say(p.n_pct, 0, '%')} speed`);
      bits.push(`delivering ${say(p.q_m3h, 1, 'm3/h')}`);
      if (Number.isFinite(p.eta_pct)) bits.push(`${say(p.eta_pct, 0, '%')} efficient`);
    } else if (p.state === 'TRIPPED') {
      bits.push('TRIPPED and locked out until it is reset');
    } else if (p.state === 'STARTING' || p.state === 'STOPPING' || p.state === 'COASTING') {
      bits.push(`${p.state.toLowerCase()}, ${say(p.n_pct, 0, '%')} speed`);
    } else {
      bits.push(p.hand === 'OFF' ? 'stopped and locked out of the sequence' : 'stopped and available');
    }
    if (p.checkShut) bits.push('its check valve is holding shut, so it is making no flow into the header');
    if (p.cavitating) bits.push('CAVITATING');
    else if (Number.isFinite(p.npshMargin_m) && p.npshMargin_m < 1) {
      bits.push(`only ${say(p.npshMargin_m, 1, 'm')} of NPSH margin left`);
    }
    if (p.hand === 'HAND') bits.push('placed in hand by the operator');
    machineWords.push(`${p.tag}, the ${role} machine, is ${sayList(bits)}`);
    machineRows.push({ label: p.tag, value: `${role}, ${p.state.toLowerCase()}, ${sayList(bits)}` });
  }
  if (machineWords.length) {
    S.push(`${sayList(machineWords)}.`);
    sections.push({ heading: 'Machines', rows: machineRows });
  }

  // ---- the process ---------------------------------------------------------------------------
  const pr = m.process || {};
  const procRows = [
    { label: 'header pressure', value: say(pr.p_bar, 2, 'bar') },
    { label: 'flow to process', value: say(pr.qDemand_m3h, 1, 'm3/h') },
    { label: 'recirculation', value: say(pr.qBypass_m3h, 1, 'm3/h') },
    { label: 'suction tank level', value: say(pr.level_m, 2, 'm') },
    { label: 'demand valve FCV-101', value: say(pr.fcv_pct, 0, '%') },
    { label: 'electrical power', value: say(pr.electrical_kW, 2, 'kW') },
  ];
  S.push(`The header is at ${say(pr.p_bar, 2, 'bar')} with ${say(pr.qDemand_m3h, 1, 'm3/h')} `
    + `going to process and ${say(pr.qBypass_m3h, 1, 'm3/h')} recirculating; the suction tank is `
    + `at ${say(pr.level_m, 2, 'm')} and the set is drawing ${say(pr.electrical_kW, 2, 'kW')}.`);
  sections.push({ heading: 'Process', rows: procRows });

  // ---- the sequence ---------------------------------------------------------------------------
  if (m.sequence && m.sequence.lastAction) {
    S.push(`The sequence last ${m.sequence.lastAction}.`
      + (m.sequence.holdReason ? ` It is holding because ${m.sequence.holdReason}.` : ''));
    sections.push({
      heading: 'Sequence',
      rows: [
        { label: 'last action', value: m.sequence.lastAction },
        { label: 'holding', value: m.sequence.holdReason || 'not holding' },
        { label: 'sleeping', value: m.sequence.sleeping ? 'yes' : 'no' },
      ],
    });
  }

  // ---- alarms ---------------------------------------------------------------------------------
  const alarms = m.alarms || [];
  const active = alarms.filter((a) => a.active);
  const stale = alarms.filter((a) => !a.active && !a.ack);
  if (!active.length && !stale.length) {
    S.push('Nothing is in alarm.');
  } else {
    const named = active.slice(0, 3).map((a) => `${a.tag}, ${a.sev.toLowerCase()}, ${a.message}`);
    S.push(`${active.length} active ${active.length === 1 ? 'alarm' : 'alarms'}`
      + (named.length ? `: ${sayList(named)}` : '')
      + (active.length > named.length ? `, and ${active.length - named.length} more` : '')
      + (stale.length ? `. ${stale.length} cleared but unacknowledged.` : '.'));
  }
  sections.push({
    heading: 'Alarms',
    rows: alarms.length
      ? alarms.map((a) => ({
        label: `${a.tag} ${a.sev}`,
        value: `${a.active ? 'active' : 'cleared'}${a.ack ? ', acknowledged' : ', unacknowledged'} — ${a.message}`,
      }))
      : [{ label: 'alarms', value: 'none' }],
  });

  const out = description(S, sections.flatMap((sec) => sec.rows));
  out.sections = sections;
  return out;
}

/**
 * Describe the Bode plot in the words the plot exists to produce: where the loop crosses over,
 * what margin it has there, and what that means for the operator.
 *
 * A crossover frequency in radians per second is not information to most people, so every one is
 * given its period as well: "0.08 radians per second, about 78 seconds a cycle" is a number an
 * operator can compare against the upset they just watched.
 *
 * @param {object} b the analysis state, from {@link readBodeState}
 * @param {?object} b.margins the record from `control/analysis.js::margins`
 * @param {?object} b.model the identified FOPDT model, or null
 * @param {string} [b.modelSource] where the model came from
 * @param {{tag:string, label:string}} b.loop the loop
 * @returns {{text:string, rows:Array<{label:string, value:string}>}} the description
 */
export function describeBode(b) {
  const loop = (b && b.loop) || { tag: 'the loop', label: 'the controlled variable' };
  if (!b || !b.margins) {
    return description([
      `Frequency response for ${loop.tag}.`,
      'There is no process model yet, so there is nothing to plot.',
      'Run a relay test, a step test or a frequency sweep from the identification panel and the '
      + 'response, the margins and the crossover frequencies all appear here.',
    ], [{ label: 'model', value: 'none identified yet' }]);
  }
  const mg = b.margins;
  const rows = [];
  const S = [`Open-loop frequency response for ${loop.tag}, ${loop.label}, `
    + 'with the tuning currently in the controller.'];

  if (b.model) {
    S.push(`The model behind it is a gain of ${say(b.model.K, 3)} per percent, a time constant of `
      + `${sayDuration(b.model.tau)} and ${sayDuration(b.model.theta)} of dead time`
      + `${b.modelSource ? `, identified by ${b.modelSource}` : ''}.`);
    rows.push({ label: 'process model', value: `K ${say(b.model.K, 3)}, tau ${say(b.model.tau, 1, 's')}, dead time ${say(b.model.theta, 1, 's')}` });
  }

  if (Number.isFinite(mg.wgc) && mg.wgc > 0) {
    S.push(`The gain crosses one at ${say(mg.wgc, 3, 'rad/s')} — about `
      + `${sayDuration((2 * Math.PI) / mg.wgc)} a cycle — with `
      + `${say(mg.pm_deg, 0, 'deg')} of phase margin.`);
    rows.push({ label: 'gain crossover', value: say(mg.wgc, 3, 'rad/s') });
    rows.push({ label: 'phase margin', value: say(mg.pm_deg, 0, 'deg') });
  } else {
    S.push('The gain never crosses one over the frequencies plotted, so the loop has no gain '
      + 'crossover: it is far slower than the process.');
  }

  if (Number.isFinite(mg.wpc) && mg.wpc > 0) {
    S.push(`Phase reaches minus 180 degrees at ${say(mg.wpc, 3, 'rad/s')}, where the gain is `
      + `${say(mg.gm_dB, 1, 'dB')} below one — a gain margin of ${say(mg.gm, 2)}, meaning the `
      + `process gain could rise by ${say((mg.gm - 1) * 100, 0, '%')} before this loop went unstable.`);
    rows.push({ label: 'phase crossover', value: say(mg.wpc, 3, 'rad/s') });
    rows.push({ label: 'gain margin', value: `${say(mg.gm, 2)}, ${say(mg.gm_dB, 1, 'dB')}` });
  } else {
    S.push('The phase never reaches minus 180 degrees, so there is no finite gain margin to '
      + 'report — on this model no amount of extra gain alone destabilises the loop.');
  }

  S.push(`Peak sensitivity is ${say(mg.ms, 2)} at ${say(mg.wms, 3, 'rad/s')}: ${mg.verdict}.`);
  rows.push({ label: 'peak sensitivity', value: `${say(mg.ms, 2)} at ${say(mg.wms, 3, 'rad/s')}` });
  rows.push({ label: 'verdict', value: mg.verdict });

  if (Number.isFinite(mg.delayMargin_s)) {
    S.push(`It tolerates ${sayDuration(mg.delayMargin_s)} of extra dead time before it goes `
      + 'unstable, which is the margin that disappears first when a transmitter is refiltered '
      + 'or a scan is slowed.');
    rows.push({ label: 'delay margin', value: say(mg.delayMargin_s, 1, 's') });
  }
  if (!mg.stable) {
    S.push('This tuning is UNSTABLE against this model: it will oscillate and keep oscillating.');
  }
  return description(S, rows);
}

// ============================================================================================
// 4. STATE COLLECTORS
//
// These read the sim context and return the plain records section 3 consumes. They are pure and
// DOM-free, which is what lets the tests build a real simulator and check the prose against a
// plant rather than against a fixture nobody maintains.
// ============================================================================================

/**
 * Read the last `n` values of one trend channel, oldest first.
 *
 * The ring is indexed in place — `(head - len + i) % cap` — for the same reason `ui/trend.js`
 * does it: copying whole channels out per frame is thousands of pointless writes a second.
 *
 * @param {object} ring the trend ring
 * @param {string} name the channel
 * @param {number} n how many samples
 * @param {number} [stride=1] take every nth sample
 * @returns {number[]} the samples, oldest first
 */
export function ringTail(ring, name, n, stride = 1) {
  if (!ring || !ring.data || !ring.data[name] || ring.len === 0) return [];
  const arr = ring.data[name];
  const take = Math.min(n, ring.len);
  const start = ring.len - take;
  const out = [];
  for (let i = start; i < ring.len; i += stride) {
    out.push(arr[(ring.head - ring.len + i + ring.cap * 2) % ring.cap]);
  }
  return out;
}

/** Extra pens described alongside the controlled variable, per loop mode. */
const EXTRA_PENS = Object.freeze({
  PRESSURE: [
    { key: 'co', label: 'controller output', unit: '%', dp: 1, scale: 100 },
    { key: 'qdem', label: 'flow to process', unit: 'm3/h', dp: 1, scale: 150 },
    { key: 'n1', label: 'P-101 speed', unit: '%', dp: 0, scale: 100 },
  ],
  FLOW: [
    { key: 'co', label: 'controller output', unit: '%', dp: 1, scale: 100 },
    { key: 'p_bar', label: 'header pressure', unit: 'bar', dp: 2, scale: 8 },
    { key: 'n1', label: 'P-101 speed', unit: '%', dp: 0, scale: 100 },
  ],
  LEVEL: [
    { key: 'co', label: 'controller output', unit: '%', dp: 1, scale: 100 },
    { key: 'qdem', label: 'flow to process', unit: 'm3/h', dp: 1, scale: 150 },
  ],
});

/**
 * Collect the trend state for {@link describeTrend}.
 * @param {object} ctx the sim context
 * @param {object} [opts] options
 * @param {number} [opts.span_s=180] how far back to describe, s
 * @param {number} [opts.points=48] how many samples per pen; the shape survives downsampling
 * @returns {object} the trend state
 */
export function readTrendState(ctx, opts = {}) {
  const span_s = opts.span_s || 180;
  const points = opts.points || 48;
  const eu = LOOP_EU[ctx.run.mode];
  const ring = ctx.trend;
  const dt = ctx.config.trend_s || ctx.config.scan_s || 0.2;
  const want = Math.max(2, Math.min(ring.len, Math.round(span_s / dt)));
  const stride = Math.max(1, Math.round(want / points));

  const pvVals = ringTail(ring, 'pv', want, stride);
  const pens = [{
    key: 'pv',
    label: `${eu.pv} ${loopLabel(ctx.run.mode)}`,
    unit: eu.unit,
    dp: eu.dp,
    scale: eu.hi - eu.lo,
    values: pvVals,
    last: pvVals.length ? pvVals[pvVals.length - 1] : NaN,
  }];
  for (const spec of EXTRA_PENS[ctx.run.mode] || []) {
    const vals = ringTail(ring, spec.key, want, stride);
    pens.push({ ...spec, values: vals, last: vals.length ? vals[vals.length - 1] : NaN });
  }

  // How long the measurement has been inside a half-percent-of-span band around setpoint. Walked
  // backwards from now, because what an operator wants is "how long has it been good", not "how
  // often was it ever good".
  const band = (eu.hi - eu.lo) * 0.005;
  const spTail = ringTail(ring, 'sp', want, 1);
  const pvTail = ringTail(ring, 'pv', want, 1);
  let settled = 0;
  for (let i = pvTail.length - 1; i >= 0; i -= 1) {
    if (Math.abs(pvTail[i] - spTail[i]) > band) break;
    settled += dt;
  }
  const coTail = ringTail(ring, 'co', want, stride);
  const saturated = coTail.some((v) => v >= 99.5 || v <= 0.5);

  return {
    span_s: Math.min(span_s, ring.len * dt),
    loop: { tag: eu.tag, label: loopLabel(ctx.run.mode), unit: eu.unit, dp: eu.dp, span: eu.hi - eu.lo },
    sp: ctx.pid.sp,
    pv: pvVals.length ? pvVals[pvVals.length - 1] : NaN,
    settled_s: settled,
    saturated,
    pens,
  };
}

/**
 * The plain-English name of a loop mode.
 * @param {string} mode one of `LOOP`
 * @returns {string} the name
 */
export function loopLabel(mode) {
  if (mode === 'FLOW') return 'flow to process';
  if (mode === 'LEVEL') return 'suction tank level';
  return 'header pressure';
}

/**
 * Collect the schematic state for {@link describeMimic}.
 * @param {object} ctx the sim context
 * @param {object} [summary] the record from `core/sim.js::summary`, if the caller already has one
 * @returns {object} the mimic state
 */
export function readMimicState(ctx, summary) {
  const eu = LOOP_EU[ctx.run.mode];
  const { plant, config } = ctx;
  const pumps = plant.drv.map((d, i) => ({
    tag: config.pumps[i].tag,
    state: d.state,
    hand: ctx.staging.hand[i],
    lead: ctx.staging.lead === i,
    n_pct: d.n_pct,
    i_pct: d.i_pct,
    q_m3h: plant.Q_m3h[i],
    head_m: plant.Hp_m[i],
    eta_pct: plant.eta[i] * 100,
    npshMargin_m: plant.npsha_m[i] - plant.npshr_m[i],
    cavitating: plant.cav[i] < 0.995,
    checkShut: !!plant.checkShut[i],
    vib_mms: plant.vib_mms[i],
  }));
  return {
    loop: { tag: eu.tag, label: loopLabel(ctx.run.mode), unit: eu.unit, dp: eu.dp, span: eu.hi - eu.lo },
    mode: ctx.pid.mode,
    sp: ctx.pid.sp,
    pv: ctx.pid.pvRaw,
    co: ctx.run.co_pct,
    ff: ctx.run.ff_pct,
    owner: summary ? summary.owner : null,
    pumps,
    process: {
      p_bar: plant.p_bar,
      qDemand_m3h: plant.Qdemand_m3h,
      qBypass_m3h: plant.Qbypass_m3h,
      qTotal_m3h: plant.Qtotal_m3h,
      level_m: plant.level_m,
      temp_C: plant.T_tank_C,
      fcv_pct: plant.fcv.x * 100,
      pcv_pct: plant.pcv.x * 100,
      electrical_kW: summary ? summary.electrical_kW : NaN,
    },
    sequence: {
      lastAction: ctx.staging.lastAction,
      holdReason: ctx.staging.holdReason,
      sleeping: ctx.staging.sleeping,
    },
    alarms: (ctx.run.alarmList || []).map((a) => ({
      tag: a.tag, sev: a.sev, message: a.message, active: a.active, ack: a.ack, id: a.id,
    })),
  };
}

/**
 * Collect the frequency-response state for {@link describeBode}.
 * @param {object} ctx the sim context
 * @returns {object} the analysis state
 */
export function readBodeState(ctx) {
  const eu = LOOP_EU[ctx.run.mode];
  return {
    loop: { tag: eu.tag, label: loopLabel(ctx.run.mode) },
    margins: ctx.margins,
    model: ctx.model,
    modelSource: ctx.modelSource,
  };
}

// ============================================================================================
// 5. CONTRAST
//
// WCAG 2.x relative luminance and contrast ratio, so the audit can say a number instead of an
// opinion. The dark palette in styles/tokens.css passes on its primary ink and fails on its
// tertiary; knowing WHICH pairs fail, and by how much, is the difference between a finding and
// a complaint.
// ============================================================================================

/**
 * Parse a CSS colour into 8-bit RGBA. Understands `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and
 * `rgba()` — which is everything `getComputedStyle` ever returns.
 * @param {string} css the colour
 * @returns {?{r:number, g:number, b:number, a:number}} the colour, or null if unparseable
 */
export function parseColor(css) {
  if (typeof css !== 'string') return null;
  const s = css.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const grab = (i, n) => parseInt(n === 1 ? hex[i] + hex[i] : hex.slice(i * 2, i * 2 + 2), 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: grab(0, 1), g: grab(1, 1), b: grab(2, 1),
        a: hex.length === 4 ? grab(3, 1) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: grab(0, 2), g: grab(1, 2), b: grab(2, 2),
        a: hex.length === 8 ? grab(3, 2) / 255 : 1,
      };
    }
    return null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((x) => !Number.isFinite(x))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

/**
 * Composite a possibly-translucent colour over an opaque one.
 * @param {{r:number,g:number,b:number,a:number}} fg the front colour
 * @param {{r:number,g:number,b:number,a:number}} bg the backdrop, treated as opaque
 * @returns {{r:number,g:number,b:number,a:number}} the flattened colour
 */
export function flatten(fg, bg) {
  const a = fg.a === undefined ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/**
 * WCAG relative luminance.
 * @param {{r:number,g:number,b:number}} c an opaque colour, channels 0..255
 * @returns {number} the luminance, 0..1
 */
export function relativeLuminance(c) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG contrast ratio between two colours.
 * @param {string|object} fg foreground, as CSS or as a parsed colour
 * @param {string|object} bg background, as CSS or as a parsed colour
 * @returns {number} the ratio, 1..21, or NaN if either colour is unparseable
 */
export function contrastRatio(fg, bg) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return NaN;
  const bo = { ...b, a: 1 };
  const fo = flatten(f, bo);
  const l1 = relativeLuminance(fo);
  const l2 = relativeLuminance(bo);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Grade a contrast ratio against WCAG 2.2 for text of a given size.
 *
 * "Large" is 18.66px bold or 24px regular, which on this rig means almost nothing is large: the
 * type scale is capped at 16px. That is deliberate here — grading an 11px label against the
 * large-text threshold would pass a label nobody can read.
 *
 * @param {number} ratio the contrast ratio
 * @param {object} [text] the text it applies to
 * @param {number} [text.size_px=12] font size
 * @param {number|string} [text.weight=400] font weight
 * @returns {{grade:string, pass:boolean, required:number, large:boolean}} the grade
 */
export function contrastGrade(ratio, text = {}) {
  const size = Number(text.size_px) || 12;
  const weight = Number(text.weight) || 400;
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  const required = large ? 3 : 4.5;
  const enhanced = large ? 4.5 : 7;
  if (!Number.isFinite(ratio)) return { grade: 'unknown', pass: true, required, large };
  if (ratio >= enhanced) return { grade: 'AAA', pass: true, required, large };
  if (ratio >= required) return { grade: 'AA', pass: true, required, large };
  return { grade: 'fail', pass: false, required, large };
}

// ============================================================================================
// 6. ROVING TABINDEX
//
// The ARIA toolbar/radiogroup pattern: the GROUP is one tab stop, and the arrow keys move within
// it. Twenty view chips are otherwise twenty tab stops between the toolbar and the workspace.
//
// The machine is pure and returns a NEW state, so a group can be re-rendered from it and the
// tests can drive a whole key sequence without a DOM.
// ============================================================================================

/**
 * Build a roving-tabindex group.
 * @param {object} spec the group
 * @param {number} spec.count how many items
 * @param {number} [spec.index=0] the initially focused item
 * @param {boolean} [spec.wrap=true] whether the ends join up
 * @param {string} [spec.orientation='horizontal'] 'horizontal', 'vertical' or 'both'
 * @param {number[]} [spec.disabled] indices that cannot take focus
 * @returns {object} the roving state
 */
export function createRoving({ count, index = 0, wrap = true, orientation = 'horizontal', disabled = [] } = {}) {
  const n = Math.max(0, Math.floor(count || 0));
  const dis = new Set((disabled || []).filter((i) => i >= 0 && i < n));
  const st = {
    count: n, wrap, orientation, disabled: dis, index: 0,
  };
  st.index = firstEnabled(st, Math.min(Math.max(index, 0), Math.max(n - 1, 0)), 1);
  return st;
}

/**
 * The first index at or after `from` that is not disabled, searching in `step` direction.
 * @param {object} st the roving state
 * @param {number} from where to start
 * @param {number} step +1 or -1
 * @returns {number} the index, or `from` if every item is disabled
 */
function firstEnabled(st, from, step) {
  if (st.count === 0) return 0;
  for (let k = 0; k < st.count; k += 1) {
    const i = (from + step * k + st.count * st.count) % st.count;
    if (!st.disabled.has(i)) return i;
  }
  return from;
}

/** Keys that move to the next item, by orientation. */
const NEXT_KEYS = Object.freeze({
  horizontal: ['ArrowRight'], vertical: ['ArrowDown'], both: ['ArrowRight', 'ArrowDown'],
});
/** Keys that move to the previous item, by orientation. */
const PREV_KEYS = Object.freeze({
  horizontal: ['ArrowLeft'], vertical: ['ArrowUp'], both: ['ArrowLeft', 'ArrowUp'],
});

/**
 * Apply a key to a roving group.
 *
 * A key this group does not own comes back `handled: false` and unchanged, so the caller knows
 * not to call `preventDefault` — swallowing ArrowDown on a horizontal toolbar would take page
 * scrolling away from a keyboard user, which is its own kind of trap.
 *
 * @param {object} st the roving state
 * @param {string} key the `KeyboardEvent.key`
 * @returns {{state:object, index:number, handled:boolean, moved:boolean}} the result
 */
export function rovingKey(st, key) {
  const same = { state: st, index: st.index, handled: false, moved: false };
  if (!st || st.count === 0) return same;
  const next = NEXT_KEYS[st.orientation] || NEXT_KEYS.horizontal;
  const prev = PREV_KEYS[st.orientation] || PREV_KEYS.horizontal;

  let target = null;
  if (next.includes(key)) {
    target = st.index + 1 >= st.count && !st.wrap ? st.index : firstEnabled(st, st.index + 1, 1);
    if (!st.wrap && st.index + 1 >= st.count) target = st.index;
  } else if (prev.includes(key)) {
    target = st.index - 1 < 0 && !st.wrap ? st.index : firstEnabled(st, st.index - 1, -1);
    if (!st.wrap && st.index - 1 < 0) target = st.index;
  } else if (key === 'Home') {
    target = firstEnabled(st, 0, 1);
  } else if (key === 'End') {
    target = firstEnabled(st, st.count - 1, -1);
  } else {
    return same;
  }
  const state = { ...st, index: target };
  return { state, index: target, handled: true, moved: target !== st.index };
}

/**
 * Move focus explicitly, e.g. after a click.
 * @param {object} st the roving state
 * @param {number} index the item to focus
 * @returns {object} the new state
 */
export function rovingSet(st, index) {
  if (!st || st.count === 0) return st;
  const i = Math.min(Math.max(Math.floor(index), 0), st.count - 1);
  return { ...st, index: st.disabled.has(i) ? st.index : i };
}

/**
 * The `tabindex` one item should carry.
 * @param {object} st the roving state
 * @param {number} i the item index
 * @returns {number} 0 for the one tab stop, -1 for the rest
 */
export function rovingTabIndex(st, i) {
  return st && st.index === i ? 0 : -1;
}

// ============================================================================================
// 7. THE AUDIT RULES
//
// `auditDom` in section 8 walks the live DOM and turns each element into a plain FACTS record;
// these rules turn facts into findings. Splitting it that way is what makes the rules testable
// under `node --test`, and it means a rule can be argued about without a browser open.
// ============================================================================================

/** Elements that are interactive and therefore need an accessible name. */
const CONTROL_TAGS = Object.freeze(['button', 'a', 'input', 'select', 'textarea', 'summary']);
/** Roles that are interactive for the same reason. */
const CONTROL_ROLES = Object.freeze([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'slider', 'spinbutton',
  'combobox', 'textbox', 'option',
]);

/**
 * Whether a facts record describes something a user can operate.
 * @param {object} f the facts record
 * @returns {boolean} true if it is a control
 */
export function isControl(f) {
  if (!f) return false;
  if (f.role && CONTROL_ROLES.includes(f.role)) return true;
  if (f.tag === 'input' && f.type === 'hidden') return false;
  return CONTROL_TAGS.includes(f.tag);
}

/**
 * Turn one element's facts into findings.
 *
 * @param {object} f the facts record
 * @param {string} f.tag lower-case tag name
 * @param {string} [f.role] explicit role
 * @param {string} [f.type] input type
 * @param {string} [f.name] the computed accessible name, or empty
 * @param {string} [f.path] a human-readable locator, for the report
 * @param {number} [f.tabIndex] the tabindex property
 * @param {boolean} [f.focusable] whether it can take focus
 * @param {boolean} [f.insideAriaHidden] whether an ancestor is aria-hidden
 * @param {boolean} [f.hasText] whether it carries visible text
 * @param {string} [f.color] resolved foreground colour
 * @param {string} [f.background] resolved background colour
 * @param {number} [f.size_px] font size
 * @param {number} [f.weight] font weight
 * @param {boolean} [f.isCanvas] whether it is a canvas or an svg
 * @param {boolean} [f.described] whether it has aria-describedby or a description sibling
 * @returns {Array<{level:string, code:string, message:string, path:string, detail?:object}>}
 *   the findings, possibly empty
 */
export function auditFacts(f) {
  const out = [];
  const path = (f && f.path) || (f && f.tag) || 'unknown element';
  /**
   * @param {string} level 'error' or 'warn'
   * @param {string} code machine-readable code
   * @param {string} message what is wrong and what it costs
   * @param {object} [detail] extra numbers
   * @returns {void}
   */
  const add = (level, code, message, detail) => {
    out.push(detail ? { level, code, message, path, detail } : { level, code, message, path });
  };
  if (!f) return out;

  if (isControl(f) && !(f.name || '').trim()) {
    add('error', 'unlabelled-control',
      'A control with no accessible name. A screen reader announces it as "button" and nothing '
      + 'else, so it can be reached and not identified.');
  }
  if (f.isCanvas && !(f.name || '').trim() && !f.described) {
    add('error', 'undescribed-canvas',
      'A canvas or diagram with neither a label nor a description. Everything it shows is '
      + 'invisible to anyone not looking at the pixels.');
  }
  if (Number(f.tabIndex) > 0) {
    add('warn', 'positive-tabindex',
      `tabindex="${f.tabIndex}" pulls this control out of document order. Mixing positive `
      + 'tabindex with natural order makes the tab sequence unpredictable for everyone.');
  }
  if (f.focusable && f.insideAriaHidden) {
    add('error', 'focusable-in-hidden',
      'A focusable control inside an aria-hidden subtree. Focus can land on it and a screen '
      + 'reader will say nothing at all — the classic keyboard trap.');
  }
  if (f.hasText && f.color && f.background) {
    const ratio = contrastRatio(f.color, f.background);
    const g = contrastGrade(ratio, { size_px: f.size_px, weight: f.weight });
    if (!g.pass) {
      add('error', 'low-contrast',
        `Text contrast is ${ratio.toFixed(2)} to 1 against its background; ${g.required} to 1 is `
        + 'the minimum for text this size.',
        { ratio, required: g.required, color: f.color, background: f.background });
    }
  }
  return out;
}

/**
 * Run the rules over a set of facts records and sort the findings worst first.
 * @param {object[]} records the facts, one per element
 * @returns {{ok:boolean, errors:number, warnings:number,
 *   problems:Array<object>, checked:number}} the report
 */
export function auditRecords(records) {
  const problems = [];
  const ids = new Map();
  for (const f of records || []) {
    for (const p of auditFacts(f)) problems.push(p);
    if (f && f.id) ids.set(f.id, (ids.get(f.id) || 0) + 1);
  }
  for (const [id, n] of ids) {
    if (n > 1) {
      problems.push({
        level: 'error',
        code: 'duplicate-id',
        path: `#${id}`,
        message: `The id "${id}" appears ${n} times. Every aria-labelledby and aria-describedby `
          + 'that points at it resolves to the first one, so the rest are silently mislabelled.',
      });
    }
  }
  problems.sort((a, b) => (a.level === b.level ? 0 : (a.level === 'error' ? -1 : 1)));
  const errors = problems.filter((p) => p.level === 'error').length;
  return {
    ok: errors === 0,
    errors,
    warnings: problems.length - errors,
    checked: (records || []).length,
    problems,
  };
}

// ============================================================================================
// 8. THE DOM LAYER
//
// Everything above is pure. This is the part that needs a document: it builds the live regions,
// binds descriptions to canvases, manages focus across the lazy pane swap, wires roving groups,
// and collects the facts the audit consumes.
// ============================================================================================

/** Where the stylesheet lives, resolved against this module so the page's depth never matters. */
const SHEET_URL = new URL('../../styles/a11y.css', import.meta.url).href;

/**
 * Add the accessibility stylesheet once.
 * @param {Document} doc the document
 * @returns {void}
 */
function ensureSheet(doc) {
  if (doc.querySelector('link[data-a11y-sheet]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = SHEET_URL;
  link.setAttribute('data-a11y-sheet', '');
  (doc.head || doc.documentElement).appendChild(link);
}

/**
 * Visually hidden text that is still in the accessibility tree.
 * @param {string} [text] initial content
 * @param {object} [attrs] extra attributes
 * @returns {HTMLElement} the element
 */
export function srOnly(text, attrs) {
  return h('span', { class: 'a11y-sr', ...(attrs || {}) }, text || '');
}

/**
 * The accessible name of an element, computed the way a screen reader would — near enough for an
 * audit. aria-label wins, then aria-labelledby, then a wrapping or associated label, then the
 * element's own text, then title, then alt.
 * @param {Element} el the element
 * @returns {string} the name, possibly empty
 */
export function accessibleName(el) {
  if (!el || !el.getAttribute) return '';
  const label = el.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const doc = el.ownerDocument;
    const parts = by.split(/\s+/).map((id) => {
      const t = doc.getElementById(id);
      return t ? (t.textContent || '').trim() : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if (el.id) {
    const lab = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab && (lab.textContent || '').trim()) return lab.textContent.trim();
  }
  const wrapping = el.closest ? el.closest('label') : null;
  if (wrapping && (wrapping.textContent || '').trim()) return wrapping.textContent.trim();
  const text = (el.textContent || '').trim();
  if (text) return text;
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  const alt = el.getAttribute('alt');
  return alt && alt.trim() ? alt.trim() : '';
}

/** Selector for everything that can take keyboard focus. */
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, iframe, '
  + 'object, embed, [tabindex], [contenteditable="true"]';

/**
 * Whether an element can currently take focus.
 * @param {Element} el the element
 * @returns {boolean} true if focusable
 */
function focusable(el) {
  if (!el || !el.matches || !el.matches(FOCUSABLE)) return false;
  if (el.disabled) return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  return !el.closest('[hidden]');
}

/**
 * Install the accessibility layer into a booted application.
 *
 * Everything here is additive: it adds regions, attributes and key handlers and changes no
 * existing behaviour, so it can be installed after `boot()` without the shell knowing about it.
 * That is deliberate — an accessibility layer that has to be threaded through every view is one
 * that gets half-threaded.
 *
 * @param {HTMLElement} host the element `boot()` was given
 * @param {object} ctx the sim context `boot()` returned
 * @param {object} [opts] options
 * @param {number} [opts.refresh_ms=1000] how often the canvas descriptions are regenerated
 * @param {number} [opts.trendSpan_s=180] how far back the trend description reaches
 * @param {boolean} [opts.autoRefresh=true] run the refresh on an interval of its own
 * @returns {{ok:boolean, reason?:string, announce?:Function, refresh?:Function,
 *   audit?:Function, destroy?:Function, describe?:Function}} the handle, or a refusal
 */
export function installA11y(host, ctx, opts = {}) {
  if (!host || !host.ownerDocument) return { ok: false, reason: 'no host element to install into' };
  if (!ctx || !ctx.run) return { ok: false, reason: 'no simulation context' };
  const doc = host.ownerDocument;
  if (host.querySelector('.a11y-live')) return { ok: false, reason: 'already installed' };
  ensureSheet(doc);

  const refresh_ms = opts.refresh_ms || 1000;
  const trendSpan_s = opts.trendSpan_s || 180;
  const announcer = createAnnouncer(opts.announce);
  /** @returns {number} the wall clock, ms — the only clock this module reads */
  const now = () => (globalThis.performance ? globalThis.performance.now() : 0);

  // ---- live regions ---------------------------------------------------------------------------
  // Two regions, because one region cannot be two politenesses. Both are LOGS rather than plain
  // live regions: appending a child announces the addition, which means the same text twice in a
  // row is announced twice — and "LOW SUCTION" arriving again after it cleared is news.
  const alerts = h('div', {
    class: 'a11y-live', id: 'a11y-alerts', role: 'log',
    'aria-live': 'assertive', 'aria-relevant': 'additions', 'aria-atomic': 'false',
    'aria-label': 'Alarm announcements',
  });
  const statusRegion = h('div', {
    class: 'a11y-live', id: 'a11y-status', role: 'log',
    'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-atomic': 'false',
    'aria-label': 'Status announcements',
  });

  /**
   * Write one message into the matching region, keeping a short scrollback so a user can read
   * back what was said rather than only hear it once.
   * @param {{text:string, politeness:string}} msg the message
   * @returns {void}
   */
  function emit(msg) {
    const region = msg.politeness === POLITENESS.ASSERTIVE ? alerts : statusRegion;
    region.appendChild(h('p', { class: 'a11y-live__line', text: msg.text }));
    while (region.children.length > 12) region.firstChild.remove();
  }

  /**
   * Offer a message to the rate limiter. It may not be spoken, and that is the point.
   * @param {string} text what to say
   * @param {string} [politeness] one of {@link POLITENESS}
   * @param {string} [key] identity for repeat suppression
   * @returns {{ok:boolean, reason?:string}} whether it was queued
   */
  function announce(text, politeness, key) {
    return offerAnnouncement(announcer, { text, politeness, key }, now());
  }

  // ---- skip link ------------------------------------------------------------------------------
  // First focusable thing in the document, and visible only while focused. Without it, reaching
  // the P&ID from the address bar is a walk through the whole toolbar on every page load.
  const skip = h('a', {
    class: 'a11y-skip', href: '#a11y-main', text: 'Skip to the process view',
    onClick: (ev) => {
      ev.preventDefault();
      const main = host.querySelector('#a11y-main');
      if (main) { main.focus(); main.scrollIntoView({ block: 'nearest' }); }
    },
  });

  // ---- structure ------------------------------------------------------------------------------
  // The shell is a flat stack of divs. Landmarks cost nothing and turn it into a document a
  // screen reader can navigate by region instead of by tab.
  const shell = host.querySelector('.shell');
  const stage = host.querySelector('.panel--stage');
  const stageBody = host.querySelector('.panel__body--stage');
  const railCol = host.querySelector('.col--rail');
  const banner = host.querySelector('.alarmbar');
  const toolbars = Array.from(host.querySelectorAll('.toolbar'));

  if (stage) {
    setAttr(stage, 'role', 'region');
    setAttr(stage, 'aria-label', 'Process view');
    setAttr(stage, 'id', 'a11y-main');
    setAttr(stage, 'tabindex', '-1');
  }
  if (railCol) {
    setAttr(railCol, 'role', 'complementary');
    setAttr(railCol, 'aria-label', 'Control rail');
  }
  if (banner) {
    // The banner is not a live region: the announcer already speaks alarms, and a banner that
    // also announced would say everything twice.
    setAttr(banner, 'role', 'status');
    setAttr(banner, 'aria-live', 'off');
  }
  for (const tb of toolbars) {
    setAttr(tb, 'role', 'toolbar');
    if (!tb.getAttribute('aria-label')) {
      setAttr(tb, 'aria-label', tb.classList.contains('toolbar--views') ? 'View selection' : 'Run control');
    }
  }

  // ---- the description panel --------------------------------------------------------------------
  // Visually hidden, in the accessibility tree, and REACHABLE: a region with a heading, a live
  // paragraph and a definition list of the same numbers. The paragraph is what gets spoken when
  // it changes; the list is what a user arrows through when they want the third number again.
  const descText = h('p', { class: 'a11y-desc__text', id: 'a11y-desc-text' });
  const descList = h('dl', { class: 'a11y-desc__rows' });
  const descPanel = h('section', {
    class: 'a11y-sr a11y-desc', id: 'a11y-desc', role: 'region',
    'aria-label': 'Live description of the current view', tabindex: '-1',
  },
    h('h2', { class: 'a11y-desc__head', text: 'Live description of the current view' }),
    h('div', { 'aria-live': 'polite', 'aria-atomic': 'true' }, descText),
    descList);

  const live = h('div', { class: 'a11y-root' }, alerts, statusRegion, descPanel);
  host.insertBefore(skip, host.firstChild);
  host.appendChild(live);
  if (shell) setAttr(shell, 'aria-describedby', 'a11y-desc-text');

  // ---- roving tabindex on the chip groups -------------------------------------------------------
  /** @type {Array<{container:Element, items:Element[], state:object}>} */
  const groups = [];

  /**
   * Turn a container of buttons into one tab stop with arrow keys inside it.
   * @param {Element} container the group element
   * @param {object} [o] options
   * @param {string} [o.orientation='horizontal'] arrow-key axis
   * @param {string} [o.selector='button'] which children are items
   * @param {string} [o.label] an aria-label for the group
   * @returns {?object} the group record, or null if it has no items
   */
  function rovingGroup(container, o = {}) {
    if (!container) return null;
    const items = Array.from(container.querySelectorAll(o.selector || 'button'));
    if (items.length < 2) return null;
    const rec = {
      container,
      items,
      state: createRoving({ count: items.length, orientation: o.orientation || 'horizontal' }),
    };
    setAttr(container, 'role', container.getAttribute('role') || 'group');
    if (o.label) setAttr(container, 'aria-label', o.label);

    /**
     * Write the tabindex of every item from the state, and optionally move focus.
     * @param {boolean} focus whether to focus the current item
     * @returns {void}
     */
    const paint = (focus) => {
      for (let i = 0; i < rec.items.length; i += 1) {
        setAttr(rec.items[i], 'tabindex', String(rovingTabIndex(rec.state, i)));
      }
      if (focus && rec.items[rec.state.index]) rec.items[rec.state.index].focus();
    };
    container.addEventListener('keydown', (ev) => {
      const r = rovingKey(rec.state, ev.key);
      if (!r.handled) return;
      ev.preventDefault();
      rec.state = r.state;
      paint(true);
    });
    container.addEventListener('focusin', (ev) => {
      const i = rec.items.indexOf(ev.target);
      if (i >= 0) { rec.state = rovingSet(rec.state, i); paint(false); }
    });
    paint(false);
    groups.push(rec);
    return rec;
  }

  for (const grp of host.querySelectorAll('.tb__grp')) rovingGroup(grp);
  const viewRow = host.querySelector('.toolbar--views');
  if (viewRow) rovingGroup(viewRow, { label: 'Views in the current group' });

  // ---- focus restoration across the lazy pane swap ------------------------------------------------
  // `ensurePane` REPLACES the placeholder node with the built pane. If focus was inside the
  // placeholder — and it is, whenever the view was reached from the keyboard — it lands on
  // document.body, which is the point at which a keyboard user has to tab in from the top again.
  let lastFocus = null;
  const trackFocus = (ev) => {
    if (ev.target && ev.target !== doc.body && host.contains(ev.target)) lastFocus = ev.target;
  };
  doc.addEventListener('focusin', trackFocus, true);

  /** @type {?MutationObserver} */
  let paneWatch = null;
  if (stageBody && globalThis.MutationObserver) {
    paneWatch = new globalThis.MutationObserver(() => {
      const lost = doc.activeElement === doc.body || doc.activeElement === null;
      if (!lost) return;
      const target = (lastFocus && host.contains(lastFocus)) ? lastFocus : stage;
      if (target && target.focus) target.focus();
    });
    paneWatch.observe(stageBody, { childList: true });
  }

  // ---- events -> announcements ---------------------------------------------------------------
  const off = [];
  if (ctx.bus && ctx.bus.on) {
    off.push(ctx.bus.on('alarm', (a) => {
      if (!a) return;
      const state = a.active === false ? 'cleared' : 'in';
      announce(`${a.sev === 'ALARM' ? 'Alarm' : 'Warning'}. ${a.tag}. ${a.message}`,
        severityPoliteness(a.sev), `alarm:${a.id || a.tag}:${state}`);
    }));
    off.push(ctx.bus.on('trip', (ev) => {
      announce(`Trip. ${ev.tag}. ${ev.message}`, POLITENESS.ASSERTIVE, `trip:${ev.tag}:${ev.message}`);
    }));
    off.push(ctx.bus.on('sequence', (msg) => announce(`Sequence: ${msg}`, POLITENESS.POLITE, `seq:${msg}`)));
    off.push(ctx.bus.on('scenario', (msg) => announce(`Test: ${msg}`, POLITENESS.POLITE, `scn:${msg}`)));
    off.push(ctx.bus.on('lesson', (msg) => announce(`Lesson: ${msg}`, POLITENESS.POLITE, `les:${msg}`)));
    off.push(ctx.bus.on('scored', (r) => announce(
      `${r.scenario} scored ${Math.round(r.score)} out of 100.`, POLITENESS.POLITE,
      `score:${r.scenario}:${Math.round(r.score)}`)));
  }

  // Mode and view changes are polled rather than subscribed, because nothing emits them. Polling
  // one string a second is free and it survives another agent rewriting the shell.
  let lastMode = ctx.pid.mode;
  let lastLoop = ctx.run.mode;
  let lastState = ctx.run.state;
  let lastSpeed = ctx.run.speed;
  let lastView = '';

  /**
   * Which view is on the stage, read from the title the shell already writes.
   * @returns {string} the view label
   */
  const currentView = () => {
    const t = host.querySelector('.panel--stage .panel__title');
    return t ? (t.textContent || '').trim() : '';
  };

  /**
   * Pick the description generator matching the view on the stage.
   * @param {string} label the view label
   * @returns {{text:string, rows:Array<object>}} the description
   */
  function describe(label) {
    const v = (label || '').toUpperCase();
    if (v.includes('BODE') || v.includes('NYQUIST')) return describeBode(readBodeState(ctx));
    if (v.includes('P&ID') || v.includes('ISOMETRIC') || v.includes('WALL') || v === '') {
      return describeMimic(readMimicState(ctx, safeSummary()));
    }
    // Every other view is a table or a form and describes itself; the trend below the stage is
    // present on all of them, so that is the useful thing to say about the screen.
    return describeTrend(readTrendState(ctx, { span_s: trendSpan_s }));
  }

  /**
   * `sim.summary` without importing `core/sim.js` — the shell already binds it onto the context
   * for the views, and this layer must not care whether it is there.
   * @returns {?object} the summary, or null
   */
  function safeSummary() {
    try {
      return ctx.summary ? ctx.summary() : null;
    } catch {
      return null;
    }
  }

  /**
   * Regenerate the description and drain one announcement. Called on an interval, and by the
   * shell's frame loop if it wants tighter coupling.
   * @returns {void}
   */
  function refresh() {
    const label = currentView();
    if (label !== lastView) {
      lastView = label;
      announce(`${label} view.`, POLITENESS.POLITE, `view:${label}:${ctx.run.t_s.toFixed(0)}`);
    }
    if (ctx.pid.mode !== lastMode) {
      lastMode = ctx.pid.mode;
      announce(`Controller in ${lastMode.toLowerCase()}.`, POLITENESS.POLITE, `mode:${lastMode}:${ctx.run.t_s.toFixed(0)}`);
    }
    if (ctx.run.mode !== lastLoop) {
      lastLoop = ctx.run.mode;
      announce(`Now controlling ${loopLabel(lastLoop)}.`, POLITENESS.POLITE, `loop:${lastLoop}:${ctx.run.t_s.toFixed(0)}`);
    }
    if (ctx.run.state !== lastState) {
      lastState = ctx.run.state;
      announce(lastState === 'RUNNING' ? 'Plant running.' : 'Plant frozen.', POLITENESS.POLITE,
        `state:${lastState}:${ctx.run.t_s.toFixed(0)}`);
    }
    if (ctx.run.speed !== lastSpeed) {
      lastSpeed = ctx.run.speed;
      announce(`Time compression ${lastSpeed} times.`, POLITENESS.POLITE, `speed:${lastSpeed}:${ctx.run.t_s.toFixed(0)}`);
    }

    const d = describe(label);
    setText(descText, d.text);
    // The list is rebuilt rather than patched: it is at most thirty rows, once a second, and a
    // patched list whose row COUNT changed is the one place setText cannot help.
    if (descList.dataset.sig !== d.rows.length + d.text.length.toString()) {
      descList.textContent = '';
      for (const r of d.rows) {
        descList.appendChild(h('dt', { text: r.label }));
        descList.appendChild(h('dd', { text: r.value }));
      }
      descList.dataset.sig = d.rows.length + d.text.length.toString();
    }

    for (const msg of drainAnnouncements(announcer, now())) emit(msg);
  }

  const timer = opts.autoRefresh === false ? null
    : globalThis.setInterval(refresh, refresh_ms);
  refresh();

  // ---- the audit ---------------------------------------------------------------------------------
  /**
   * Walk the live DOM and report what is wrong with it.
   *
   * Deliberately run on demand rather than at boot: it reads computed styles for every element,
   * which forces layout, and doing that on every load to produce a console message nobody asked
   * for is a cost the operator pays for a developer's benefit.
   *
   * @param {Element} [root] where to start; defaults to the host
   * @returns {{ok:boolean, errors:number, warnings:number, checked:number,
   *   problems:Array<object>}} the report
   */
  function audit(root) {
    const start = root || host;
    const win = doc.defaultView;
    const records = [];
    /**
     * The nearest opaque background behind an element, walking up until one is found.
     * @param {Element} el the element
     * @returns {string} a CSS colour
     */
    const backdrop = (el) => {
      let n = el;
      while (n && n.nodeType === 1) {
        const c = win.getComputedStyle(n).backgroundColor;
        const p = parseColor(c);
        if (p && p.a > 0.95) return c;
        n = n.parentElement;
      }
      return win.getComputedStyle(doc.body).backgroundColor || 'rgb(0,0,0)';
    };
    /**
     * A locator a developer can act on.
     * @param {Element} el the element
     * @returns {string} tag, id and classes
     */
    const locate = (el) => `${el.tagName.toLowerCase()}`
      + `${el.id ? `#${el.id}` : ''}`
      + `${el.classList.length ? `.${Array.from(el.classList).join('.')}` : ''}`;

    for (const el of start.querySelectorAll('*')) {
      if (el.closest('.a11y-root, .a11y-skip')) continue;
      if (el.hidden || el.closest('[hidden]')) continue;
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const tag = el.tagName.toLowerCase();
      const ownText = Array.from(el.childNodes)
        .some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 0);
      records.push({
        tag,
        id: el.id || '',
        role: el.getAttribute('role') || '',
        type: el.getAttribute('type') || '',
        name: accessibleName(el),
        path: locate(el),
        tabIndex: el.tabIndex,
        focusable: focusable(el),
        insideAriaHidden: !!el.closest('[aria-hidden="true"]'),
        hasText: ownText,
        color: cs.color,
        background: ownText ? backdrop(el) : '',
        size_px: parseFloat(cs.fontSize) || 12,
        weight: parseInt(cs.fontWeight, 10) || 400,
        isCanvas: tag === 'canvas' || tag === 'svg',
        described: !!el.getAttribute('aria-describedby') || !!el.getAttribute('aria-label'),
      });
    }
    return auditRecords(records);
  }

  /**
   * Remove everything this layer added.
   * @returns {void}
   */
  function destroy() {
    if (timer) globalThis.clearInterval(timer);
    if (paneWatch) paneWatch.disconnect();
    doc.removeEventListener('focusin', trackFocus, true);
    for (const fn of off) { if (typeof fn === 'function') fn(); }
    skip.remove();
    live.remove();
  }

  return {
    ok: true,
    announce,
    refresh,
    audit,
    describe,
    destroy,
    rovingGroup,
    announcer,
    /** @returns {object} the groups wired for roving tabindex, for the tests and the console */
    groups: () => groups.slice(),
  };
}
