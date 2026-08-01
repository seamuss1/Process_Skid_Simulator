/**
 * @file src/ui/view_run.js — the main operator screen, in the HMI-2012 idiom.
 *
 * LAYER: `ui-panels`. This module COMPOSES `ui/pid.js` and `ui/chart.js` and re-implements
 * neither: the schematic brings its own symbols and interactions, the trend brings its own
 * toolbar, pen rail, limit lines and history strip. What lives here is the screen that holds them
 * together and the two process widgets neither of them owns.
 *
 * SCREEN, top to bottom:
 *   1. Simulation band a standing SIMULATION — NOT PLANT marker carrying the commanded speed.
 *   2. P&ID panel      `flex: 1 1 0` — it claims every pixel the fixed bands leave behind.
 *   3. Process band    ONE band, not two: the collector on the left, the phase rail on the right.
 *   4. Splitter        6 px, `role="separator"`, drag / arrow keys / three snap points.
 *   5. Trend panel     the chromatogram, holding `ui/chart.js` whole.
 *
 * There is NO bottom value strip. It duplicated numbers that already sit beside their instruments
 * on the schematic and in the trend's pen rail, and it cost the two panels that matter their
 * height. Run state and quality indication live in the title bar, beside the alarm summary.
 *
 * THREE THINGS THIS SCREEN IS OPINIONATED ABOUT:
 *
 * · THE SIMULATION BAND is permanent, quiet and undismissable. It does not blink and it does not
 *   borrow `--alarm` or `--warn`: a blinking marker is an event, and this is a condition that will
 *   never clear. It carries the commanded speed inside itself on purpose — a 1000× button is only
 *   safe on an operator screen while the screen itself says, without being asked, that nothing
 *   here is connected to plant.
 *
 * · THE COLLECTOR spends its width on the one thing that changes: the ACTIVE destination, as a
 *   sunken plaque naming the port, the volume it has taken and whether flow is being diverted to
 *   waste. Every other port compresses to a 12 px cell that still carries its fill height and its
 *   lamp, so "which have collected, and how full" survives the compaction. The width that buys is
 *   handed to the phase rail, which now shares the band — one band where there were two.
 *
 * · EVENT MARKERS are DE-COLLIDED HERE, not in the trend. `ui/chart.js` places a flag label at a
 *   fixed row under the plot's top edge, so two events a few millilitres apart overprint into a
 *   smear. This view therefore measures every label at the trend's current pixel scale and merges
 *   any that would touch into one chevron carrying `×N`, expanded on hover. The merge is redone
 *   the moment the scale moves, which is what makes "nothing overprints" true at every zoom.
 *
 * BUS: this view listens, it does not drive. `key-action` carries the shortcuts `ui/app.js` does
 * not handle itself; `request-pane` carries `{ pane: 'pid' | 'trend' }` from the two nav buttons
 * that select this one screen, and is answered by biasing the splitter toward that pane and moving
 * the keyboard into it — never by hiding the other pane.
 *
 * TEXT BUDGET: no sentence appears on this screen. Every control is an icon with `title` and
 * `aria-label`; every number lives in a label box carrying its ISA tag and its engineering unit;
 * every explanation is a tooltip or a `data/glossary.js` popover.
 *
 * STYLES: two blocks, and the split is deliberate.
 *   · `@layer skid-run` holds the SKELETON — sizes and flex behaviour only. A layered declaration
 *     always loses to an unlayered one, so `styles/app.css` stays free to re-lay-out the screen.
 *   · The unlayered `.rv …` block holds the chrome this screen OWNS: the panel frames, the phase
 *     rail, the fraction strip and the splitter. Those four are this module's brief, so they are
 *     scoped under `.rv` and win on both specificity and layer order.
 * Shared furniture — `.lbox`, `.tagblk`, `.lamp`, `.btn` — is still `styles/app.css`'s to define.
 */

import * as fmt from './format.js';
import * as chartlib from './chart.js';
import * as pidlib from './pid.js';
import * as overlaylib from './overlay.js';
import * as simlib from '../core/sim.js';
import * as engine from '../skid/engine.js';
import * as methodlib from '../skid/method.js';
import { column, QF } from '../core/log.js';
import { glossaryFor } from '../data/glossary.js';

/* ============================================================================================ */
/* 1. STATIC TABLES                                                                             */
/* ============================================================================================ */

/** Log channel names that carry the trend's x axis, one per x mode. */
const X_CHANNELS = Object.freeze({ volume: 'V_mL', time: 't_s', cv: 'V_CV' });

/** X modes in the order the `x-axis-cycle` shortcut steps through them. */
const X_MODES = Object.freeze(['volume', 'time', 'cv']);

/** Block-type → service slug, which picks the phase-rail segment's service cap. */
const BLOCK_KIND = Object.freeze({
  EQUILIBRATION: 'equil', RE_EQUILIBRATION: 'equil', LOAD: 'load', WASH: 'wash',
  ELUTION_ISOCRATIC: 'elute', ELUTION_LINEAR: 'elute', ELUTION_STEP: 'elute',
  STRIP: 'strip', CIP: 'strip', HOLD: 'hold', COLUMN_BYPASS: 'bypass', PACKING_TEST: 'test',
});

/**
 * Event types that earn an axis chevron on the trend, as `[code, name]`.
 *
 * The CODE is what the plot draws — five characters at most, because the label is centred on the
 * event's own x and every character it carries is a character that can collide with the next
 * event's. The NAME, and the event's own message, are the hover card's, which is where a sentence
 * is allowed to live.
 */
const MARKER_EVENTS = Object.freeze({
  RUN_START: ['START', 'Run start'],
  ALARM_RAISED: ['ALARM', 'Alarm raised'],
  WATCH_FIRED: ['WATCH', 'Watch fired'],
  OPERATOR_ACTION: ['OPR', 'Operator action'],
  AUTOZERO: ['ZERO', 'Autozero'],
  PEAK_MAX: ['PEAK', 'Peak maximum'],
  AIR_DETECTED: ['AIR', 'Air detected'],
  FLOW_REDUCTION_START: ['FLOW', 'Flow reduced'],
  STATE_CHANGE: ['STATE', 'State change'],
});

/**
 * The font `ui/chart.js` paints a marker label in, mirrored here so this view can measure a label
 * before handing it over. It is deliberately a copy and not an import: the trend owns its painter,
 * this owns the decision about what is safe to give it. The `MARK_PAD` and `MARK_GAP` slack below
 * absorb any drift between the two.
 */
const MARK_FONT = '700 9px "Roboto Mono", Consolas, ui-monospace, "Cascadia Mono", Menlo, '
  + 'monospace';

/** Padding `ui/chart.js` adds around a marker label, px. */
const MARK_PAD = 6;

/** Clear space demanded between two marker labels before they count as separable, px. */
const MARK_GAP = 8;

/** How far the pointer may sit from a chevron and still open its card, px. */
const MARK_HIT = 9;

/** Depth of the hoverable marker row below the plot's top edge, px. */
const MARK_ROW_H = 26;

/** Relative change in px-per-x-unit that forces the marker clusters to be recomputed. */
const MARK_RESCALE = 0.004;

/** Events listed in full on a cluster's hover card before it summarises the remainder. */
const MARK_CARD_ROWS = 10;

/** Severity rank, worst first — a cluster shows the worst thing inside it. */
const SEVERITY_RANK = Object.freeze({ INFO: 0, WARN: 1, ALARM: 2, FAULT: 2, CRITICAL: 3 });

/** Quality-flag lamps in the P&ID header, worst first. Four characters or fewer. */
const QF_LAMPS = Object.freeze([
  ['BED', QF.BED_COLLAPSED, 'is-alarm', 'Bed collapsed'],
  ['SAT', QF.UV_SATURATED, 'is-alarm', 'UV detector saturated'],
  ['LAMP', QF.UV_LAMP_FAULT, 'is-alarm', 'UV lamp fault'],
  ['DRY', QF.COND_DRY, 'is-alarm', 'Conductivity cell dry'],
  ['pH', QF.PH_FROZEN_AIR, 'is-warn', 'pH reading frozen by air'],
  ['AIR', QF.AIR_IN_PATH, 'is-warn', 'Air in the flow path'],
  ['BYP', QF.DETECTORS_BYPASSED, 'is-warn', 'Detectors bypassed'],
  ['OVR', QF.UV_OVERRANGE, 'is-warn', 'UV over range'],
  ['RED', QF.FLOW_REDUCED, 'is-warn', 'Flow reduced by an interlock'],
  ['MAN', QF.MANUAL_OVERRIDE, 'is-warn', 'Manual override engaged'],
  ['SPD', QF.SPEED_LIMITED, 'is-warn', 'Simulation speed limited'],
  ['ELEC', QF.PH_ELECTRODE_DEGRADED, 'is-warn', 'pH electrode degraded'],
  ['PRS', QF.PRESS_SUSPECT, 'is-warn', 'Pressure signal suspect'],
]);

/** Readout refresh period, ms. 10 Hz is the HMI convention and matches the control tick. */
const READOUT_MS = 100;

/** Trend-height snap points, as a fraction of the screen height. */
const SNAP_FRAC = Object.freeze([0.3, 0.45, 0.6]);

/**
 * Trend height as a fraction of the screen when the navigation publishes `request-pane`, by pane
 * id: asking for the schematic leaves it 70 % of the screen, asking for the trend gives the trend
 * 70 %. Neither pane is ever hidden — the screen only changes which one has the room.
 */
const PANE_FRAC = Object.freeze({ pid: 0.3, trend: 0.7 });

/** Screen height assumed before the `ResizeObserver` has measured one, px. */
const FALLBACK_H = 800;

/**
 * Process band height, px — the collector and the phase rail share one band now, so this is the
 * only band height the screen owns. Published as `--rv-frac-h`, which `styles/app.css` reads.
 */
const FRAC_H = 30;

/** Simulation band height, px. */
const SIM_H = 18;

/**
 * Icon geometry, 16×16, stroked with `currentColor`. Only the two controls this screen owns need
 * one — the trend brings its own toolbar and the schematic its own symbols.
 */
const ICONS = Object.freeze({
  mark: [['path', { d: 'M4.2 2v12' }], ['path', { d: 'M4.2 2.8h8L10 5.6l2.2 2.8h-8' }]],
  clear: [['path', { d: 'M4 4l8 8M12 4l-8 8' }]],
});

/* ============================================================================================ */
/* 2. SMALL HELPERS                                                                             */
/* ============================================================================================ */

/**
 * Shorthand over `format.h` for the common "tag + class + text" case.
 *
 * @param {string} tag Tag name.
 * @param {string} [className] Space-separated class list, or '' for none.
 * @param {string} [text] Text content.
 * @returns {HTMLElement} The new element, not yet attached.
 */
function mk(tag, className, text) {
  return fmt.h(tag, className ? { class: className } : null,
    (text === undefined || text === null) ? null : text);
}

/**
 * Fixed-decimal formatting through the display boundary, so a readout never changes width and
 * never shows `NaN`.
 *
 * @param {number} v Value.
 * @param {number} d Decimal places.
 * @returns {string} Formatted value, or `format.NO_VALUE`.
 */
function nfix(v, d) {
  return fmt.fmtFixed(v, d);
}

/**
 * Clamp helper, local so this module keeps its import surface to the declared dependencies.
 *
 * @param {number} x Value.
 * @param {number} lo Lower bound.
 * @param {number} hi Upper bound.
 * @returns {number} `x` clamped into `[lo, hi]`.
 */
function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * The 2D context this module measures marker labels with. Built on first use, never attached to
 * the document, and shared by every run view in the page.
 * @type {CanvasRenderingContext2D|null}
 */
let measureCtx = null;

/**
 * The painted width of a marker label, in px, at the exact font `ui/chart.js` will use.
 *
 * Falls back to a deliberately GENEROUS per-character estimate when no 2D context can be had, so
 * a environment without canvas over-merges rather than overprints.
 *
 * @param {string} text The label.
 * @returns {number} Width including the padding `ui/chart.js` adds around it, px.
 */
function labelWidth(text) {
  const s = String(text);
  if (measureCtx === null) {
    const cv = typeof document.createElement === 'function' ? document.createElement('canvas')
      : null;
    measureCtx = (cv && typeof cv.getContext === 'function') ? cv.getContext('2d') : null;
    if (measureCtx) measureCtx.font = MARK_FONT;
  }
  if (!measureCtx) return s.length * 7 + MARK_PAD;
  return measureCtx.measureText(s).width + MARK_PAD;
}

/**
 * Rank an event severity so a collapsed cluster can be coloured by the worst thing inside it.
 * @param {string} [sev] An event severity.
 * @returns {number} 0 for INFO or unknown, 3 for CRITICAL.
 */
function severityRank(sev) {
  const r = SEVERITY_RANK[sev];
  return r === undefined ? 0 : r;
}

/**
 * Build one 16×16 inline SVG icon from the `ICONS` table.
 *
 * @param {string} name An `ICONS` key.
 * @returns {SVGElement} The glyph, marked `aria-hidden` — its control carries the label.
 */
function icon(name) {
  const parts = ICONS[name] || [];
  const kids = parts.map(([tag, attrs]) => fmt.hSvg(tag, attrs));
  return fmt.hSvg('svg', {
    viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false',
    class: 'btn__glyph btn__glyph--sm',
  }, ...kids);
}

/**
 * A beveled 26 px icon button: icon only, `title` and `aria-label` mandatory, and a visually
 * hidden `.btn__label` so the name is in the DOM as well as in the accessibility tree.
 *
 * @param {string} iconName An `ICONS` key.
 * @param {string} label The accessible name and tooltip.
 * @param {string} short The hidden text label, one uppercase word.
 * @param {function(Event):void} onClick Click handler.
 * @returns {HTMLButtonElement} The button.
 */
function iconButton(iconName, label, short, onClick) {
  const b = mk('button', 'btn btn--sm btn--icon');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(icon(iconName));
  b.appendChild(mk('span', 'btn__label', short));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * A round glassy status lamp, styled by `styles/app.css`.
 *
 * @param {string} [state] Initial state class: `''`, `is-run`, `is-warn` or `is-alarm`.
 * @returns {HTMLElement} The lamp element; drive it with {@link setLamp}.
 */
function lamp(state) {
  const l = mk('span', 'lamp' + (state ? ' ' + state : ''));
  l.setAttribute('aria-hidden', 'true');
  return l;
}

/**
 * Set a lamp's colour state without touching its other classes.
 *
 * @param {Element} node The lamp.
 * @param {string} state `''`, `is-run`, `is-warn` or `is-alarm`.
 * @returns {void}
 */
function setLamp(node, state) {
  fmt.cls(node, 'is-run', state === 'is-run');
  fmt.cls(node, 'is-warn', state === 'is-warn');
  fmt.cls(node, 'is-alarm', state === 'is-alarm');
}

/**
 * A lamp with a four-character code beside it, for the quality-flag row.
 *
 * @param {string} code Up to four uppercase characters.
 * @param {string} title The tooltip that explains the code.
 * @returns {{el:HTMLElement, lamp:HTMLElement}} The pair; `el` starts hidden.
 */
function codeLamp(code, title) {
  const el = mk('span', 'rv-code');
  el.title = title;
  const l = lamp('');
  el.appendChild(l);
  el.appendChild(mk('span', 'rv-code-t', code));
  el.hidden = true;
  return { el, lamp: l };
}

/**
 * The workhorse of this design: an ISA tag beside a sunken label box holding right-aligned
 * tabular digits and a smaller, dimmer engineering-unit suffix. The chrome is
 * `styles/app.css`'s `.tagblk--row` / `.lbox`; this only wires the text.
 *
 * @param {string} tag The ISA tag, uppercase.
 * @param {string} unit The engineering unit, or '' for a dimensionless value.
 * @param {{title?:string, tone?:string, onInfo?:function(Element):void}} [opts] `onInfo` makes the
 *   block a button that opens a glossary popover.
 * @returns {{el:HTMLElement, set:function(string,string=):void, setUnit:function(string):void}}
 *   `set(text, tone)` writes the digits and the digit role: `pv`, `sp`, `out`, `alarm`, `stale`.
 */
function labelBox(tag, unit, opts) {
  const o = opts || {};
  const el = mk(o.onInfo ? 'button' : 'span', 'tagblk tagblk--row rv-tb');
  if (o.onInfo) {
    el.type = 'button';
    el.addEventListener('click', () => o.onInfo(el));
  }
  if (o.title) el.title = o.title;
  const t = mk('span', 'tagblk__lbl', tag);
  const box = mk('span', 'lbox');
  const v = mk('span', 'lbox__v', fmt.NO_VALUE);
  const u = mk('span', 'lbox__eu', unit);
  box.appendChild(v);
  box.appendChild(u);
  el.appendChild(t);
  el.appendChild(box);

  /** Digit-role class suffixes, as `styles/app.css` names them. */
  const TONE_CLS = {
    pv: '', sp: ' lbox--sp', out: ' lbox--out', alarm: ' is-alarm', stale: ' is-stale',
  };
  let tone = null;
  const applyTone = (next) => {
    const want = TONE_CLS[next] === undefined ? '' : TONE_CLS[next];
    if (want === tone) return;
    tone = want;
    box.className = 'lbox' + want;
  };
  applyTone(o.tone || 'pv');

  return {
    el,
    set(text, nextTone) {
      fmt.setText(v, text);
      if (nextTone) applyTone(nextTone);
    },
    setUnit(next) { fmt.setText(u, next); },
  };
}

/**
 * Resolve the overlay host: the one `ui/app.js` built if it published it on `ctx`, otherwise a
 * lazily created singleton on `document.body`. Cached per document so two views never build two.
 *
 * @param {object} ctx The application context.
 * @returns {object} An OverlayHost as returned by `overlay.createOverlayHost`.
 */
let sharedOverlayHost = null;
function overlayHostFor(ctx) {
  if (ctx && ctx.overlayHost) return ctx.overlayHost;
  if (ctx && ctx.overlay) return ctx.overlay;
  if (!sharedOverlayHost) sharedOverlayHost = overlaylib.createOverlayHost(document.body);
  return sharedOverlayHost;
}

/**
 * Invoke a `core/sim.js` action through `ctx.sim` when the shell published it, falling back to the
 * module import. Both are the same module; the fallback only guards a partially built `ctx`.
 *
 * @param {object} ctx The application context.
 * @param {string} name The action name, e.g. `'markFraction'`.
 * @param {...any} args Extra arguments after `ctx`.
 * @returns {{ok:boolean, reason?:string}} The action's result.
 */
function callSim(ctx, name, ...args) {
  const bag = (ctx && ctx.sim && typeof ctx.sim[name] === 'function') ? ctx.sim : simlib;
  const fn = bag[name];
  if (typeof fn !== 'function') return { ok: false, reason: 'action ' + name + ' is unavailable' };
  return fn(ctx, ...args);
}

/* ============================================================================================ */
/* 3. SCOPED STYLESHEET                                                                         */
/* ============================================================================================ */

const STYLE_ID = 'rv-run-view-styles';

/**
 * The run screen's SKELETON — sizes and flex behaviour, nothing else.
 *
 * Wrapped in a cascade layer on purpose: an unlayered declaration always beats a layered one, so
 * `styles/app.css` can re-lay-out any of this without a specificity war.
 */
const STYLE_SKELETON = '@layer skid-run{' + [
  // `height:100%` AND `flex:1 1 auto`, because ui/app.js may hand this view either a block pane
  // (the composite main screen) or a flex column. Without a DEFINITE height here the trend's
  // percentage flex-basis degrades to `auto` and the schematic collapses to nothing.
  '.rv{height:100%;flex:1 1 auto;min-height:0;min-width:0}',
  '.rv,.rv *{box-sizing:border-box}',
  '.rv button.rv-tb{border:0;padding:0;background:none;font:inherit;color:inherit;',
  'text-align:left;cursor:pointer}',
  '.rv ol,.rv ul{list-style:none;margin:0;padding:0}',
  /* -- P&ID: the panel that must claim the leftover height ---------------------------------- */
  // Without an explicit grow this panel inherits `0 1 auto` and collapses to its header while the
  // column sits empty. `flex:1 1 0` plus `min-height:0` is set INLINE on the element, because
  // styles/app.css declares `flex` for the shared host classes.
  '.rv-pid-host{display:flex;flex-direction:column;margin:2px}',
  /* -- header furniture --------------------------------------------------------------------- */
  '.rv-codes{display:flex;align-items:center;gap:3px;min-width:0;overflow:hidden}',
  '.rv-tb{flex:0 0 auto;min-width:0}',
  /* -- simulation band ------------------------------------------------------------------------ */
  '.rv-sim{flex:0 0 auto;display:flex;align-items:center;gap:var(--sp-5);min-width:0;',
  'height:' + SIM_H + 'px;padding:0 var(--sp-5) 0 0;overflow:hidden}',
  '.rv-sim-t,.rv-sim-s,.rv-sim-x{flex:0 0 auto;white-space:nowrap}',
  '.rv-sim-s{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.rv-sim-x{margin-left:auto}',
  /* -- the one process band: collector on the left, phase rail on the right ------------------- */
  '.rv-band{flex:0 0 auto;display:flex;align-items:center;gap:var(--sp-5);',
  'padding:0 var(--sp-5);min-width:0}',
  // Clipped, because below the narrow breakpoint's own budget the band's fixed readouts still
  // outgrow the glass. Spilling would break the panel frame across the whole screen; clipping
  // costs the trailing readout and nothing else.
  '.rv-proc{flex-basis:var(--rv-frac-h);overflow:hidden}',
  '.rv-band .lbl{flex:0 0 auto}',
  /* -- collector: a prominent destination plaque, then a dense strip of the rest -------------- */
  '.rv-dest{flex:0 0 auto;display:flex;align-items:center;gap:var(--sp-4);height:24px;',
  'padding:0 var(--sp-5)}',
  '.rv-dest-p{min-width:40px;text-align:right}',
  // `0 0 12px` and not `1 1 0`: a cell is 12 px because 12 px is enough to read a fill height and
  // a lamp, and no wider — the width a collector does not need is the phase rail's. The basis is
  // rigid on purpose. A shrinkable one contributes its MINIMUM, not its basis, to the strip's own
  // intrinsic width, and the strip then asks for half the room it needs and squeezes every cell to
  // a hairline. The narrow screen gets a smaller rigid cell instead, below.
  '.rv-vials{display:flex;align-items:stretch;gap:2px;flex:0 0 auto;min-width:0;height:22px}',
  '.rv-vials>li{flex:0 0 12px;display:flex}',
  '.rv-vials>li.rv-wasteli{flex:0 0 24px}',
  '.rv-vial{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;',
  'padding:0 1px 1px;overflow:hidden;cursor:pointer}',
  /* -- phase rail: the width the collector gave back ----------------------------------------- */
  '.rv-rail{display:flex;align-items:stretch;gap:1px;flex:1 1 auto;min-width:60px;height:18px;',
  'padding:1px}',
  '.rv-rail>li{min-width:7px;display:flex}',
  '.rv-blk{position:relative;width:100%;height:100%;display:flex;align-items:center;',
  'padding:0 4px;overflow:hidden;cursor:pointer}',
  /* -- trend: the panel is a frame, ui/chart.js is the whole content ------------------------- */
  // `0 1` not `0 0`: the trend holds its share of the height but yields it on a short viewport,
  // so the schematic is never squeezed out of existence. Their co-visibility is the point.
  '.rv-trend{flex:0 1 var(--rv-trend-h)}',
  '.rv-trend>.rv-chart-host{margin:2px}',
  /* -- responsive ---------------------------------------------------------------------------- */
  '.rv.is-narrow .rv-codes{max-width:180px}',
  '.rv.is-narrow .rv-band .lbl,.rv.is-narrow .rv-sim-s,.rv.is-narrow .rv-opt{display:none}',
  '.rv.is-narrow .rv-vials>li{flex:0 0 9px}',
  '.rv.is-narrow .rv-vials>li.rv-wasteli{flex:0 0 18px}',
  '.rv.is-short .rv-blk-t{display:none}',
  '.rv.is-short .rv-proc{flex-basis:26px}',
  '.rv.is-short .rv-rail{height:14px}',
  '.rv.is-short .rv-vials{height:20px}',
  '.rv.is-short .rv-dest{height:22px}',
].join('') + '}';

/**
 * The chrome this screen OWNS — the simulation band, the panel frames, the phase rail, the
 * collector and the splitter.
 *
 * Deliberately UNLAYERED and scoped under `.rv`, so it wins on both specificity and layer order:
 * these widgets are this module's responsibility, not the shell's. The last group is the one
 * exception and says why: an overlay card and its anchor are mounted on `document.body`, so they
 * are never inside `.rv` to be scoped by it.
 *
 * Every surface below is one of the depth recipes `styles/tokens.css` publishes: raised is
 * `--surface-raised` + `--border-edge` + `--elev-raised`, recessed is `--fld-bg` +
 * `--border-field` + `--elev-sunken`. Nothing here hand-rolls a border, a gradient or a shadow,
 * which is also why the light theme needs no rule of its own — those recipes invert themselves.
 * No colour literal appears in this file at all.
 */
const STYLE_CHROME = [
  // The gutter between the panels is hatched, not flat. It is the quietest surface on the screen
  // and it is now the one surface that is never plant: whatever the operator is looking at, the
  // frame around it says simulator. It costs no space and it cannot be dismissed.
  '.rv{gap:3px;padding:3px;background:',
  'repeating-linear-gradient(135deg,var(--screen) 0 7px,var(--neutral-soft) 7px 14px),',
  'var(--screen)}',
  /* -- simulation band: a standing condition, so no blink and no alarm colour ----------------- */
  '.rv .rv-sim{background:',
  'repeating-linear-gradient(135deg,var(--neutral-soft) 0 6px,var(--panel-lo) 6px 12px),',
  'var(--panel-lo);border:var(--border-edge);border-left:3px solid var(--info);',
  'border-radius:2px;box-shadow:var(--elev-raised)}',
  '.rv .rv-sim-t{padding:2px var(--sp-5);background:var(--panel-lo);border-radius:2px;',
  'color:var(--ink);font:700 10px/1 var(--font-ui);letter-spacing:.14em}',
  '.rv .rv-sim-s{color:var(--ink-3);font:600 9px/1 var(--font-ui);letter-spacing:.06em}',
  '.rv .rv-sim-x{padding:2px var(--sp-5);background:var(--panel-lo);border-radius:2px;',
  'color:var(--ink-2);font:700 10px/1 var(--font-num);letter-spacing:.02em}',
  '.rv .rv-sim-x.is-fast{color:var(--info-ink)}',
  /* -- panel frames -------------------------------------------------------------------------- */
  '.rv .rv-panel{background:var(--panel);border:var(--border-edge);border-radius:2px;',
  'box-shadow:var(--elev-raised)}',
  '.rv .rv-hd{height:22px;min-height:22px;margin:0;padding:0 6px;',
  'background:var(--surface-header);border:0;border-bottom:var(--border-soft);',
  'border-radius:2px 2px 0 0;box-shadow:none;color:var(--ink-2);',
  'font:600 11px/1 var(--font-ui);letter-spacing:.02em;text-transform:uppercase}',
  '.rv .rv-hd-t{color:var(--ink)}',
  '.rv .rv-pidpanel.is-manual{border-color:var(--warn);',
  'box-shadow:var(--elev-raised),0 0 0 1px var(--warn)}',
  /* -- splitter: a 1px-ruled bar with an accent grip ----------------------------------------- */
  '.rv .splitter{background:var(--surface-raised);border:0;border-top:var(--border-soft);',
  'border-bottom:var(--border-soft);box-shadow:none}',
  '.rv .splitter::before{background:var(--ink-3);border-radius:2px;box-shadow:none}',
  '.rv .splitter:hover::before{background:var(--accent)}',
  '.rv .splitter:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}',
  /* -- bands: raised strips that carry the rail and the strip -------------------------------- */
  '.rv .rv-band{background:var(--surface-raised);border:var(--border-edge);border-radius:2px;',
  'box-shadow:var(--elev-raised)}',
  /* -- quality-flag code chips --------------------------------------------------------------- */
  '.rv .rv-code{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;height:16px;',
  'padding:0 5px;background:var(--panel-lo);border:var(--border-edge);border-radius:2px}',
  '.rv .rv-code-t{font:600 9px/1 var(--font-ui);letter-spacing:.02em;color:var(--ink-2)}',
  /* -- destination plaque: the one collector fact that changes, at readable size -------------- */
  '.rv .rv-dest{background:var(--fld-bg);border:var(--border-field);border-radius:2px;',
  'box-shadow:var(--elev-sunken)}',
  '.rv .rv-dest-k{color:var(--ink-2);font:600 9px/1 var(--font-ui);letter-spacing:.06em}',
  '.rv .rv-dest-p{color:var(--fld-pv);font:700 14px/1 var(--font-num);letter-spacing:.02em}',
  '.rv .rv-dest.is-waste .rv-dest-p{color:var(--fld-stale)}',
  '.rv .rv-dest-v{color:var(--ink);font:600 11px/1 var(--font-num)}',
  '.rv .rv-dest-u{margin-left:2px;color:var(--fld-eu);font:600 9px/1 var(--font-num)}',
  // The divert chip is a STATE, not an alarm: it is outlined in the waste service tint and never
  // borrows --alarm. Flow going to drain is normal for most of a run.
  '.rv .rv-dest-w{padding:1px var(--sp-4);background:var(--neutral-soft);',
  'border:1px solid var(--svc-waste);border-radius:2px;color:var(--ink-2);',
  'font:700 9px/1 var(--font-ui);letter-spacing:.06em}',
  /* -- fraction strip: recessed cells that fill with product green ---------------------------- */
  '.rv .rv-vials{background:none;border:0;box-shadow:none;overflow:visible}',
  '.rv .rv-vial{position:relative;background:var(--fld-bg);border:var(--border-field);',
  'border-radius:2px;box-shadow:var(--elev-sunken)}',
  '.rv .rv-vial-f{position:absolute;left:0;right:0;bottom:0;height:0;z-index:0;',
  'background:var(--svc-product);pointer-events:none}',
  '.rv .rv-vial.is-waste .rv-vial-f{background:var(--svc-waste)}',
  // A 12 px cell has no room for an 8 px lamp AND a fill, so the lamp compresses to a 4 px pip at
  // the head of the cell. It still carries the whole three-state code: green under the head, amber
  // collected, dark empty.
  '.rv .rv-vial .lamp{position:absolute;top:2px;left:50%;margin-left:-2px;width:4px;height:4px;',
  'z-index:2}',
  '.rv .rv-vial.is-waste .lamp{margin-left:-4px;width:8px;height:8px}',
  // Twelve port names at 12 px would be twelve ellipses. The name of the port that matters is on
  // the plaque; the rest carry theirs in `title` and `aria-label`.
  '.rv .rv-vial-id{display:none}',
  '.rv .rv-vial.is-waste .rv-vial-id{position:relative;z-index:2;display:block;',
  'pointer-events:none;white-space:nowrap;overflow:hidden;color:var(--ink-2);',
  'font:600 8px/1 var(--font-num);letter-spacing:.02em}',
  // A fraction that caught the peak is the one an operator hunts for, so it keeps a mark of its
  // own even at 12 px: a full-height product-green edge down the cell.
  '.rv .rv-vial.has-peak{border-color:var(--svc-product)}',
  '.rv .rv-vial.is-pooling{background:var(--accent-soft);border-color:var(--accent)}',
  '.rv .rv-vial.is-pooling .rv-vial-f{background:var(--svc-product)}',
  // The port under the head is lamped AND ringed, and carries the same 25 % outer glow a lit lamp
  // does — colour is state, and this is the one cell whose state is changing.
  '.rv .rv-vial.is-open{border-color:var(--ok);',
  'box-shadow:var(--elev-sunken),0 0 0 1px var(--ok),0 0 6px var(--glow-run)}',
  '.rv .rv-vial:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}',
  /* -- phase rail: a segmented progress bar -------------------------------------------------- */
  '.rv .rv-rail{position:relative;background:var(--fld-bg);border:var(--border-field);',
  'border-radius:2px;box-shadow:var(--elev-sunken);overflow:hidden}',
  '.rv .rv-blk{background:var(--surface-raised);border:var(--border-edge);border-radius:2px;',
  'color:var(--ink-2);font:600 10px/1 var(--font-ui);letter-spacing:.02em;',
  'text-transform:uppercase}',
  // The service tint survives as a 2px cap, not as the whole segment: on a high-performance HMI
  // the process is grey and the saturated fill is reserved for the state — here, for progress.
  '.rv .rv-blk::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;z-index:2;',
  'background:var(--pipe-idle);pointer-events:none}',
  '.rv .rv-blk[data-kind="equil"]::before{background:var(--svc-a)}',
  '.rv .rv-blk[data-kind="load"]::before{background:var(--svc-sample)}',
  '.rv .rv-blk[data-kind="wash"]::before{background:var(--svc-a)}',
  '.rv .rv-blk[data-kind="elute"]::before{background:var(--svc-b)}',
  '.rv .rv-blk[data-kind="strip"]::before{background:var(--svc-cip)}',
  '.rv .rv-blk[data-kind="bypass"]::before{background:var(--svc-waste)}',
  '.rv .rv-blk[data-kind="test"]::before{background:var(--info)}',
  // One fill, two intensities: a spent segment carries the accent quietly, the segment running
  // now carries it at half strength. That is what makes the rail read as a progress bar.
  '.rv .rv-blk-f{position:absolute;left:0;top:0;bottom:0;width:100%;z-index:0;',
  'transform:scaleX(0);transform-origin:left center;background:var(--accent);opacity:.22;',
  'pointer-events:none}',
  '.rv .rv-blk-t{position:relative;z-index:1;pointer-events:none;white-space:nowrap;',
  'overflow:hidden;text-overflow:ellipsis}',
  '.rv .rv-blk.is-active{border-color:var(--accent);color:var(--ink)}',
  '.rv .rv-blk.is-active .rv-blk-f{opacity:.5}',
  '.rv .rv-blk.is-done .rv-blk-t{color:var(--ink-3)}',
  '.rv .rv-blk.is-off{opacity:.45}',
  '.rv .rv-blk:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}',
  /* -- the label boxes the band carries ------------------------------------------------------- */
  '.rv .rv-band .lbl{color:var(--ink-2);font:600 10px/1 var(--font-ui);letter-spacing:.02em}',
  '.rv .rv-band .tb-sep{width:1px;height:14px;flex:0 0 1px;margin:0 2px;',
  'background:var(--edge-soft);box-shadow:none}',
  /* -- the trend's marker anchor and cluster card --------------------------------------------- */
  // The last two groups are the only rules here NOT scoped under `.rv`: the anchor lives on
  // document.body, where nothing can become its containing block, and the card is built by the
  // overlay host, which mounts it there too.
  '.rv-markanchor{position:fixed;left:0;top:0;width:1px;height:1px;',
  'pointer-events:none;opacity:0}',
  '.rv-mark-h{color:var(--ink);font:700 10px/1.2 var(--font-ui);letter-spacing:.04em}',
  '.rv-mark-l{display:grid;grid-template-columns:auto auto 1fr;gap:2px var(--sp-5);',
  'align-items:baseline;margin-top:var(--sp-4);font:600 10px/1.3 var(--font-num)}',
  '.rv-mark-x{color:var(--ink-3);white-space:nowrap}',
  '.rv-mark-c{color:var(--ink-2);white-space:nowrap}',
  '.rv-mark-c.is-warn{color:var(--warn-ink)}',
  '.rv-mark-c.is-alarm{color:var(--alarm-ink)}',
  '.rv-mark-m{color:var(--ink)}',
  '.rv-mark-more{margin-top:var(--sp-4);color:var(--ink-3);font:600 9px/1 var(--font-ui);',
  'letter-spacing:.04em}',
].join('');

const STYLE_TEXT = STYLE_SKELETON + STYLE_CHROME;

/**
 * Inject the run view's scoped stylesheet once per document.
 * @returns {void}
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE_TEXT;
  document.head.appendChild(s);
}

/* ============================================================================================ */
/* 4. THE VIEW                                                                                  */
/* ============================================================================================ */

/**
 * Build the main operator screen.
 *
 * The returned panel obeys the shell's panel contract exactly: `update(frameInfo)` is called at
 * most once per rAF frame by `ui/app.js`, never starts a rAF loop of its own, never calls
 * `sim.advanceWall`, never mutates `config` or `run`, and does no layout reads — every size it
 * needs is cached from a `ResizeObserver`.
 *
 * @param {Element} rootEl The element the view mounts into.
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx
 *   The application context.
 * @returns {{el:Element, mount:function():void, update:function(object):void,
 *            destroy:function():void}} The panel.
 */
export function createRunView(rootEl, ctx) {
  injectStyles();

  /* ---- mutable view state (never simulation state) ---------------------------------------- */
  let mounted = false;
  let pid = null;
  let chart = null;
  let boundStore = null;
  let xMode = (ctx.config && ctx.config.ui && ctx.config.ui.xMode) || 'volume';
  let lastReadout = -1e9;
  let evCursor = 0;
  let annotationsDirty = true;
  let cachedW = 0;
  let cachedH = 0;
  let cachedTrendH = 0;
  let pendingStructural = true;

  /** Chart annotation buffers, rebuilt only when the event log or the x mode changes. */
  let bands = [];
  let markers = [];
  const openBands = [];
  let lastBandExtend = -1e9;

  /**
   * Every event that earns a chevron, in x order, each carrying its own painted label width. The
   * width is measured once here because the clustering below runs whenever the trend rescales.
   * @type {Array<{x:number, code:string, name:string, message:string, severity:string,
   *   t_s:number, V_mL:number, w:number}>}
   */
  let evMarks = [];

  /** The fraction ticks, kept apart from the chevrons because only chevrons carry a label. */
  let tickMarks = [];

  /**
   * The chevrons as they are currently drawn: one per non-overlapping label box, each owning the
   * events it swallowed.
   * @type {Array<{x:number, lo:number, hi:number, w:number, items:Array<object>}>}
   */
  let markClusters = [];

  /** px per x unit at the last clustering. The clusters are only correct at this scale. */
  let lastScale = NaN;

  /** The cluster whose card is open, its handle, and the timer that will open the next one. */
  let hoverCluster = null;
  let hoverHandle = null;
  let hoverTimer = 0;

  /** The trend element the marker-row listeners are on, so they can be taken off again. */
  let markHoverEl = null;

  /** The last window this view asked the trend for, used before the trend owns one. */
  const viewWindow = { x0: NaN, x1: NaN };

  /** Fraction selection: a contiguous port-index range, or -1 for none. */
  let selFrom = -1;
  let selTo = -1;

  /** Trend band height in px once something has set one; NaN while the CSS default stands. */
  let trendPx = NaN;

  /** The height the operator last chose themselves, restored when a pane bias is lifted. */
  let manualTrendPx = NaN;

  /** The pane the navigation currently favours, '' when the operator's own split stands. */
  let panePref = '';

  /** True when the pane bias was sized against {@link FALLBACK_H} and owes a restatement. */
  let paneStale = false;

  /** Cached node references — no `innerHTML` and no query after mount. */
  const nodes = {
    railBlocks: [], railFills: [],
    vials: [], vialFills: [], vialLamps: [],
    qfLamps: [],
  };

  let railSig = '';
  let vialSig = '';

  const host = overlayHostFor(ctx);
  const openHandles = [];

  /* ---- DOM -------------------------------------------------------------------------------- */
  const el = mk('div', 'rv rv-stack');
  el.setAttribute('data-view', 'run');
  // 40, not 45. The P&ID host takes the remainder (flex:1 1 0), and its drawing is a 1640x430
  // viewBox rendered xMidYMid meet: at 45% the host fell to ~352 px, the drawing scaled to 0.80 and
  // left ~471 px of dead grey down each side. At 40% the host gets ~448 px, the drawing scales to
  // ~1.04 and the dead margin drops to ~96 px. The trend is still ~340 px tall across the full
  // width, and the splitter lets the operator rebalance either way.
  el.style.setProperty('--rv-trend-h', '40%');
  el.style.setProperty('--rv-frac-h', FRAC_H + 'px');

  /* -- 1. simulation band: the one thing on this screen that is never a process value -- */
  // It is NOT a lamp, NOT an alarm and NOT dismissible: no blink, no --alarm, no close control. A
  // banner that can be silenced is a banner an operator eventually silences, and the condition it
  // reports — that nothing here is wired to a column — will not clear for the life of the session.
  // Not `.rv-band`: the band recipe would repaint the hatch flat, and this strip is not one of the
  // process bands anyway. Its skeleton rule carries the same flex behaviour.
  const simBand = mk('div', 'rv-sim');
  simBand.setAttribute('role', 'note');
  simBand.setAttribute('aria-label',
    'Simulation. This screen is not connected to plant and no value on it is measured.');
  simBand.appendChild(mk('span', 'rv-sim-t', 'SIMULATION — NOT PLANT'));
  simBand.appendChild(mk('span', 'rv-sim-s', 'MODELLED VALUES · NO PLANT I/O'));
  const simSpeed = mk('span', 'rv-sim-x', fmt.NO_VALUE);
  simSpeed.title = 'Commanded simulation speed — a multiplier on simulated time, not on the '
    + 'process';
  simBand.appendChild(simSpeed);
  el.appendChild(simBand);

  /* -- 2. P&ID panel -- */
  const pidPanel = mk('section', 'rv-panel rv-pidpanel');
  pidPanel.setAttribute('aria-label', 'Process schematic');
  // The one layout fact this view must guarantee: the schematic claims the leftover height.
  // Inline, because styles/app.css declares `flex` for the shared panel classes unlayered and an
  // unlayered declaration beats anything this module's own cascade layer can say.
  pidPanel.style.flex = '1 1 0';
  pidPanel.style.minHeight = '0';
  const pidHd = mk('div', 'rv-hd');
  pidHd.appendChild(mk('span', 'rv-hd-t', 'COLUMN SKID'));
  const pidTools = mk('span', 'rv-tools');
  const qfWrap = mk('span', 'rv-codes');
  pidTools.appendChild(qfWrap);
  pidTools.appendChild(mk('span', 'tb-sep'));
  const almBox = labelBox('ALM', '', {
    title: 'Alarms active now — detail in the alarm banner',
    onInfo: (anchor) => openGlossary(anchor, 'ALARM'),
  });
  pidTools.appendChild(almBox.el);
  pidHd.appendChild(pidTools);
  const pidHost = mk('div', 'rv-pid-host');
  // Programmatically focusable, out of the tab order: `request-pane` needs somewhere to land when
  // the schematic has not drawn its interactive symbols yet.
  pidHost.setAttribute('tabindex', '-1');
  pidPanel.appendChild(pidHd);
  pidPanel.appendChild(pidHost);
  el.appendChild(pidPanel);

  for (let i = 0; i < QF_LAMPS.length; i++) {
    const c = codeLamp(QF_LAMPS[i][0], QF_LAMPS[i][3]);
    qfWrap.appendChild(c.el);
    nodes.qfLamps.push(c);
  }

  /* -- 3. the process band: collector left, phase rail right, ONE row -- */
  // Twelve empty cells across a metre of glass told the operator nothing twelve times over. What
  // changes is the DESTINATION, so the destination gets the plaque and the rest of the carousel
  // gets 12 px each — and the width that buys is handed straight to the phase rail, which used to
  // need a band of its own.
  const procBand = mk('div', 'rv-band rv-proc');
  procBand.setAttribute('role', 'group');
  procBand.setAttribute('aria-label', 'Fraction collector and method progress');
  procBand.appendChild(mk('span', 'lbl', 'FC-101'));
  const fracModeLamp = lamp('');
  procBand.appendChild(fracModeLamp);

  const destBox = mk('div', 'rv-dest');
  destBox.setAttribute('role', 'group');
  destBox.setAttribute('aria-label', 'Active collector destination');
  destBox.title = 'Where the column outlet is going right now, and how much that port holds';
  destBox.appendChild(mk('span', 'rv-dest-k', 'DEST'));
  const destPort = mk('span', 'rv-dest-p', fmt.NO_VALUE);
  const destVol = mk('span', 'rv-dest-v', fmt.NO_VALUE);
  const destUnit = mk('span', 'rv-dest-u', 'mL');
  const destWaste = mk('span', 'rv-dest-w', 'DIVERT');
  destWaste.title = 'The outlet is going to waste, not to a port';
  destWaste.hidden = true;
  destBox.appendChild(destPort);
  destBox.appendChild(destVol);
  destBox.appendChild(destUnit);
  destBox.appendChild(destWaste);
  procBand.appendChild(destBox);

  const vialList = mk('ul', 'rv-vials');
  vialList.setAttribute('role', 'listbox');
  vialList.setAttribute('aria-label', 'Fraction collector positions');
  procBand.appendChild(vialList);
  const fracCountBox = labelBox('FR', '', {
    title: 'Fractions collected so far',
    onInfo: (anchor) => openGlossary(anchor, 'FRACTION'),
  });
  procBand.appendChild(fracCountBox.el);
  const fracMarkBtn = iconButton('mark', 'Mark a fraction now (M)', 'MARK',
    () => act('markFraction'));
  const fracClearBtn = iconButton('clear', 'Clear the pool selection', 'CLEAR', () => {
    selFrom = -1;
    selTo = -1;
    applySelection();
  });
  procBand.appendChild(fracMarkBtn);
  procBand.appendChild(fracClearBtn);
  procBand.appendChild(mk('span', 'tb-sep'));

  procBand.appendChild(mk('span', 'lbl', 'PHASE'));
  const railList = mk('ol', 'rv-rail');
  railList.setAttribute('aria-label', 'Method blocks, widths proportional to volume');
  procBand.appendChild(railList);
  const blkBox = labelBox('BLK', '', { title: 'Current block of the method total' });
  const progBox = labelBox('PROG', '%', { title: 'Progress through the current block' });
  const remBox = labelBox('REM', 'mL', { title: 'Volume remaining in the current block' });
  // The first readout to go on a narrow screen, and the only one that can: the rail's own sweep
  // already draws the same fraction, so PROG is the one number the screen says twice.
  progBox.el.classList.add('rv-opt');
  procBand.appendChild(blkBox.el);
  procBand.appendChild(progBox.el);
  procBand.appendChild(remBox.el);
  el.appendChild(procBand);

  /* -- 4. splitter -- */
  const splitter = mk('div', 'splitter splitter--h');
  el.appendChild(splitter);

  /* -- 5. trend panel: a frame around ui/chart.js, which owns its own toolbar and pen rail -- */
  const trendPanel = mk('section', 'rv-panel rv-trend');
  trendPanel.setAttribute('aria-label', 'Chromatogram');
  trendPanel.setAttribute('tabindex', '-1');
  const chartHost = mk('div', 'rv-chart-host');
  trendPanel.appendChild(chartHost);
  el.appendChild(trendPanel);

  /* There is deliberately no further band. The FLOW / %B / P1 / dP / UV / COND / pH / CV strip that
     used to run along the bottom of this screen is gone: every one of those numbers already sits
     beside its instrument on the schematic above and on the trend's pen rail below, and the strip
     was charging the two panels that matter 24 px for the duplication. Run state and quality
     indication are the title bar's, next to the alarm summary. */

  // The rect the trend's marker cards are placed against. On document.body because a `position:
  // fixed` element is only viewport-relative while no ancestor has a transform, and body is the
  // one ancestor nothing can style out from under this view.
  const markAnchor = mk('span', 'rv-markanchor');
  markAnchor.setAttribute('aria-hidden', 'true');
  document.body.appendChild(markAnchor);

  rootEl.appendChild(el);

  /* ========================================================================================== */
  /* 4.1 phase rail                                                                             */
  /* ========================================================================================== */

  /**
   * Rebuild the phase rail. Segment widths are proportional to the volume each block delivers; a
   * HOLD block has no finite volume, so it gets a fixed narrow slot rather than being dropped —
   * the operator still has to see it coming.
   * @returns {void}
   */
  function buildRail() {
    const config = ctx.config;
    const method = config && config.method;
    const blocks = (method && method.blocks) || [];
    railList.textContent = '';
    nodes.railBlocks.length = 0;
    nodes.railFills.length = 0;

    const vols = new Array(blocks.length);
    let total = 0;
    for (let i = 0; i < blocks.length; i++) {
      const v = methodlib.blockVolume_mL(config, blocks[i]);
      vols[i] = Number.isFinite(v) ? Math.max(v, 0) : NaN;
      if (Number.isFinite(vols[i])) total += vols[i];
    }
    const holdSlot = total > 0 ? total * 0.06 : 1;
    for (let i = 0; i < vols.length; i++) if (!Number.isFinite(vols[i])) vols[i] = holdSlot;
    let grand = 0;
    for (let i = 0; i < vols.length; i++) grand += vols[i];
    if (grand <= 0) grand = 1;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const li = mk('li');
      li.style.flex = (vols[i] / grand).toFixed(6) + ' 1 0';
      const btn = mk('button', 'rv-blk');
      btn.type = 'button';
      btn.dataset.kind = BLOCK_KIND[b.type] || 'other';
      btn.dataset.index = String(i);
      btn.title = b.id + ' · ' + b.name + ' · ' + b.type + ' — click for parameters';
      btn.setAttribute('aria-label', 'Block ' + (i + 1) + ' of ' + blocks.length + ', ' + b.name);
      if (b.enabled === false) btn.classList.add('is-off');
      const fill = mk('span', 'rv-blk-f');
      const label = mk('span', 'rv-blk-t', b.name);
      btn.appendChild(fill);
      btn.appendChild(label);
      btn.addEventListener('click', () => openBlockPopover(btn, i));
      btn.addEventListener('keydown', onRailKey);
      li.appendChild(btn);
      railList.appendChild(li);
      nodes.railBlocks.push(btn);
      nodes.railFills.push(fill);
    }
    railSig = methodSig();
  }

  /**
   * The rail's structural signature: block identity, type and enablement.
   * @returns {string} A signature that changes exactly when the rail must be rebuilt.
   */
  function methodSig() {
    const blocks = (ctx.config.method && ctx.config.method.blocks) || [];
    return blocks.map((b) => b.id + ':' + b.type + ':' + (b.enabled === false ? '0' : '1'))
      .join('|');
  }

  /**
   * Arrow-key navigation across the rail.
   * @param {KeyboardEvent} e The key event.
   * @returns {void}
   */
  function onRailKey(e) {
    const n = nodes.railBlocks.length;
    if (n === 0) return;
    const i = Number(e.currentTarget.dataset.index);
    let j = -1;
    if (e.key === 'ArrowRight') j = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j < 0) return;
    e.preventDefault();
    nodes.railBlocks[j].focus();
  }

  /**
   * The block parameter popover — the click target on every rail segment. All of the block's
   * numbers, in a definition grid, off-screen until asked for.
   *
   * @param {Element} anchorEl The rail button.
   * @param {number} i Block index.
   * @returns {void}
   */
  function openBlockPopover(anchorEl, i) {
    const config = ctx.config;
    const b = (config.method && config.method.blocks) ? config.method.blocks[i] : null;
    if (!b) return;
    const wrap = mk('div', 'rv-pop');
    wrap.appendChild(mk('div', 'rv-pop-h', b.id + ' · ' + b.name));
    const dl = mk('dl');
    dl.style.display = 'grid';
    dl.style.gridTemplateColumns = 'auto 1fr';
    dl.style.columnGap = '10px';
    dl.style.rowGap = '3px';
    dl.style.margin = '4px 0 0';
    const row = (k, v) => {
      const dt = mk('dt', 'lbl', k);
      const dd = mk('dd', 'num', v);
      dd.style.margin = '0';
      dl.appendChild(dt);
      dl.appendChild(dd);
    };
    const d = b.duration || {};
    const f = b.flow || {};
    const g = b.gradient || {};
    const inl = b.inlets || {};
    const fr = b.fractionation || {};
    const Q = methodlib.blockFlow_mLs(config, b, i > 0 ? config.method.blocks[i - 1] : null);
    row('TYPE', b.type);
    row('ENABLED', b.enabled === false ? 'NO' : 'YES');
    row('DURATION', nfix(d.value, 2) + ' ' + (d.basis || '') + ' → ' + (d.onTimeout || 'NEXT'));
    row('VOLUME', fmt.fmtVolume(methodlib.blockVolume_mL(config, b), config));
    row('FLOW', (f.mode || 'INHERIT') + ' ' + nfix(f.value, 2) + ' → ' + fmt.fmtFlow(Q, config));
    row('GRADIENT', (g.shape || 'ISOCRATIC') + ' ' + nfix(g.startPctB, 1) + ' → '
      + nfix(g.endPctB, 1) + ' %B / ' + nfix(100 * (g.lengthFraction ?? 1), 0) + ' %');
    row('INLETS', 'A ' + (inl.a || '–') + '  B ' + (inl.b || '–') + '  S ' + (inl.sample || '–'));
    row('CV-101', b.columnValve || '–');
    row('OUTLET', b.outletDefault || '–');
    row('FC-101', (fr.mode || 'OFF') + (fr.signal ? ' / ' + fr.signal : ''));
    row('AUTOZERO', b.autozero ? 'YES' : 'NO');
    row('HOLD END', b.holdAtEnd ? 'YES' : 'NO');
    row('WATCHES', String((b.watches && b.watches.length) || 0));
    wrap.appendChild(dl);
    track(overlaylib.showPopover(host, {
      anchorEl, content: wrap, placement: 'top', maxWidth: 340,
    }));
  }

  /* ========================================================================================== */
  /* 4.2 fraction strip                                                                         */
  /* ========================================================================================== */

  /**
   * The collector slot list: WASTE first, so the head always has a home to park in, then every
   * configured port.
   * @returns {string[]} Slot names, slot 0 being WASTE.
   */
  function slotNames() {
    const fv = ctx.config.skid && ctx.config.skid.fracValve;
    return ['WASTE'].concat((fv && fv.ports) || []);
  }

  /**
   * Rebuild the fraction strip: one small beveled cell per slot, each with a fill that rises as
   * the port collects and a lamp that lights when the head is over it.
   * @returns {void}
   */
  function buildVials() {
    const slots = slotNames();
    vialList.textContent = '';
    nodes.vials.length = 0;
    nodes.vialFills.length = 0;
    nodes.vialLamps.length = 0;

    for (let i = 0; i < slots.length; i++) {
      const isWaste = i === 0;
      const li = mk('li', isWaste ? 'rv-wasteli' : '');
      const btn = mk('button', 'rv-vial' + (isWaste ? ' is-waste' : ''));
      btn.type = 'button';
      btn.dataset.slot = String(i);
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      btn.setAttribute('aria-label', isWaste ? 'Waste' : 'Fraction ' + slots[i]);
      btn.title = isWaste ? 'WASTE — the outlet default'
        : slots[i] + ' — click to select for pooling, shift-click to extend';
      const fill = mk('span', 'rv-vial-f');
      const l = lamp('');
      const id = mk('span', 'rv-vial-id', isWaste ? 'WST' : slots[i]);
      btn.appendChild(fill);
      btn.appendChild(l);
      btn.appendChild(id);
      if (!isWaste) {
        btn.addEventListener('click', (e) => onVialClick(i - 1, e.shiftKey));
        btn.addEventListener('keydown', onVialKey);
      }
      li.appendChild(btn);
      vialList.appendChild(li);
      nodes.vials.push(btn);
      nodes.vialFills.push(fill);
      nodes.vialLamps.push(l);
    }
    vialSig = slots.join(',');
    selFrom = -1;
    selTo = -1;
    applySelection();
  }

  /**
   * Select a fraction, or extend the selection with shift.
   * @param {number} portIdx Index into `config.skid.fracValve.ports`.
   * @param {boolean} extend True to extend the current range.
   * @returns {void}
   */
  function onVialClick(portIdx, extend) {
    if (extend && selFrom >= 0) {
      selTo = portIdx;
    } else if (selFrom === portIdx && selTo === portIdx) {
      selFrom = -1;
      selTo = -1;
    } else {
      selFrom = portIdx;
      selTo = portIdx;
    }
    applySelection();
  }

  /**
   * Arrow-key navigation and selection across the fraction strip.
   * @param {KeyboardEvent} e The key event.
   * @returns {void}
   */
  function onVialKey(e) {
    const n = nodes.vials.length;
    const i = Number(e.currentTarget.dataset.slot);
    let j = -1;
    if (e.key === 'ArrowRight') j = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') j = Math.max(1, i - 1);
    else if (e.key === 'Home') j = 1;
    else if (e.key === 'End') j = n - 1;
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onVialClick(i - 1, e.shiftKey);
      return;
    }
    if (j < 1) return;
    e.preventDefault();
    nodes.vials[j].focus();
    if (e.shiftKey) onVialClick(j - 1, true);
  }

  /**
   * Push the current fraction selection to the trend's pool window, the strip's classes and the
   * bus, in the trend's current x units.
   * @returns {void}
   */
  function applySelection() {
    const config = ctx.config;
    const run = ctx.run;
    const fv = config.skid && config.skid.fracValve;
    const ports = (fv && fv.ports) || [];
    const lo = Math.min(selFrom, selTo);
    const hi = Math.max(selFrom, selTo);
    for (let i = 0; i < ports.length; i++) {
      const on = selFrom >= 0 && i >= lo && i <= hi;
      const btn = nodes.vials[i + 1];
      if (!btn) continue;
      fmt.cls(btn, 'is-pooling', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (selFrom < 0) {
      if (chart) chartlib.setPoolWindow(chart, null, null);
      emit('fraction-selection', { from: null, to: null, records: [] });
      return;
    }
    const recs = run.frac.records.filter((r) => {
      const k = ports.indexOf(r.port);
      return k >= lo && k <= hi;
    });
    let x0 = NaN;
    let x1 = NaN;
    for (let i = 0; i < recs.length; i++) {
      const a = toX(recs[i].startVolume_mL, recs[i].startTime_s);
      const b = toX(recs[i].endVolume_mL, recs[i].endTime_s);
      if (!Number.isFinite(x0) || a < x0) x0 = a;
      if (!Number.isFinite(x1) || b > x1) x1 = b;
    }
    if (chart) {
      if (Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0) {
        chartlib.setPoolWindow(chart, x0, x1);
      } else {
        chartlib.setPoolWindow(chart, null, null);
      }
    }
    emit('fraction-selection', { from: ports[lo], to: ports[hi], records: recs });
  }

  /* ========================================================================================== */
  /* 4.3 trend plumbing                                                                         */
  /* ========================================================================================== */

  /**
   * Convert a (volume, time) pair to the trend's current x channel value.
   * @param {number} v_mL Detector-plane volume, mL.
   * @param {number} t_s Simulated time, s.
   * @returns {number} x in the current mode's channel units.
   */
  function toX(v_mL, t_s) {
    const mode = chart ? chart.xMode : xMode;
    if (mode === 'time') return t_s;
    if (mode === 'cv') return v_mL / ctx.config.column.V_mL;
    return v_mL;
  }

  /**
   * Build the trend. `ui/chart.js` owns its pens, axes, toolbar, pen rail, limit lines and history
   * strip — this passes it the x mode, the log store and `config.alarms`, and nothing else.
   * @returns {void}
   */
  function buildChart() {
    unwireMarkHover();
    if (chart) {
      chartlib.destroyChart(chart);
      chart = null;
      chartHost.textContent = '';
    }
    chart = chartlib.createChart(chartHost, {
      xAxis: { mode: xMode },
      // No history strip on the operating screen. It was a 26 px band across the full width that
      // spent most of a run as an empty box, and the operator reads the plot, not a navigator.
      // The Results screen keeps it, where scrubbing a finished run is the actual task.
      overview: false,
      alarms: ctx.config.alarms,
    });
    boundStore = ctx.run.log;
    chartlib.setSource(chart, boundStore, X_CHANNELS, ctx.config);
    chartlib.attachInteractions(chart, {
      onZoom: onChartZoom,
      onSelect: onChartZoom,
      onPoolDrag: onChartPool,
    });
    lastScale = NaN;
    wireMarkHover();
    annotationsDirty = true;
    applySelection();
  }

  /**
   * Listen for the pointer over the trend's marker row. Added ALONGSIDE `ui/chart.js`'s own
   * handlers on the same element rather than in front of them — the chevron cards are this view's
   * annotation of the trend, never an interception of it.
   * @returns {void}
   */
  function wireMarkHover() {
    if (!chart || !chart.wellEl) return;
    markHoverEl = chart.wellEl;
    markHoverEl.addEventListener('mousemove', onWellMove);
    markHoverEl.addEventListener('mouseleave', closeMarkCard);
  }

  /**
   * Drop the marker-row listeners and any card they left open.
   * @returns {void}
   */
  function unwireMarkHover() {
    closeMarkCard();
    if (!markHoverEl) return;
    markHoverEl.removeEventListener('mousemove', onWellMove);
    markHoverEl.removeEventListener('mouseleave', closeMarkCard);
    markHoverEl = null;
  }

  /**
   * Remember the window the trend published, so the keyboard zoom and pan actions have a base
   * even before the operator has touched the plot.
   * @param {object} [info] `{x0, x1, mode}`.
   * @returns {void}
   */
  function onChartZoom(info) {
    if (info && Number.isFinite(info.x0) && info.x1 > info.x0) {
      viewWindow.x0 = info.x0;
      viewWindow.x1 = info.x1;
    }
  }

  /**
   * A pool drag on the trend maps back onto whole fractions, which is the unit a pool is actually
   * made of.
   * @param {object|null} info `{x0, x1}` in chart x units, or null to clear.
   * @returns {void}
   */
  function onChartPool(info) {
    const config = ctx.config;
    const run = ctx.run;
    const fv = config.skid && config.skid.fracValve;
    const ports = (fv && fv.ports) || [];
    if (!info) {
      selFrom = -1;
      selTo = -1;
      applySelection();
      return;
    }
    const a = Math.min(info.x0, info.x1);
    const b = Math.max(info.x0, info.x1);
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < run.frac.records.length; i++) {
      const r = run.frac.records[i];
      const rs = toX(r.startVolume_mL, r.startTime_s);
      const re = toX(r.endVolume_mL, r.endTime_s);
      if (re < a || rs > b) continue;
      const k = ports.indexOf(r.port);
      if (k < 0) continue;
      if (lo < 0 || k < lo) lo = k;
      if (hi < 0 || k > hi) hi = k;
    }
    selFrom = lo;
    selTo = hi;
    applySelection();
  }

  /**
   * Rebuild the phase bands, event chevrons and fraction ticks from `run.events` and
   * `run.frac.records`. The whole set is re-projected whenever the x mode changes, because band
   * coordinates are in chart x units.
   * @returns {void}
   */
  function rebuildAnnotations() {
    const config = ctx.config;
    const run = ctx.run;
    const events = run.events || [];
    bands = [];
    evMarks = [];
    tickMarks = [];
    openBands.length = 0;

    let open = null;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'BLOCK_START') {
        if (open) {
          open.x1 = toX(ev.V_mL, ev.t_s);
          bands.push(open);
        }
        const blk = findBlock(config, ev.blockId);
        open = {
          x0: toX(ev.V_mL, ev.t_s), x1: toX(ev.V_mL, ev.t_s),
          label: blk ? blk.name : (ev.blockId || ''),
          kind: blk ? (BLOCK_KIND[blk.type] || 'other') : 'other',
        };
      } else if (ev.type === 'BLOCK_END' && open) {
        open.x1 = toX(ev.V_mL, ev.t_s);
        bands.push(open);
        open = null;
      }
      const m = MARKER_EVENTS[ev.type];
      if (m) {
        if (ev.type === 'STATE_CHANGE'
          && !(ev.message && /HELD|PAUSED|ALARM|FAULT/.test(ev.message))) continue;
        // The CODE goes on the plot and the MESSAGE goes on the hover card. The message used to be
        // the label, which is how "Autozero all UV channels" came to be painted across "pH out of
        // range" — a plot label may not be a sentence, and this one now never is.
        evMarks.push({
          x: toX(ev.V_mL, ev.t_s), code: m[0], name: m[1], message: ev.message || '',
          severity: ev.severity || 'INFO', t_s: ev.t_s, V_mL: ev.V_mL, w: labelWidth(m[0]),
        });
      }
    }
    if (open) {
      open.x1 = toX(run.V_tot_mL, run.t_s);
      bands.push(open);
      openBands.push(open);
    }
    const recs = run.frac.records;
    for (let i = 0; i < recs.length; i++) {
      tickMarks.push({
        x: toX(recs[i].endVolume_mL, recs[i].endTime_s), label: recs[i].port, kind: 'tick',
      });
    }
    // Clustering sweeps left to right, so it needs x order. Events are logged in time order and
    // every x channel is monotonic in time, but a re-projection is not the place to bet on that.
    evMarks.sort((a, b) => a.x - b.x);
    evCursor = events.length;
    xMode = chart ? chart.xMode : xMode;
    if (chart) {
      chartlib.setBands(chart, bands);
      chartlib.invalidate(chart, 'static');
    }
    projectMarkers(true);
    annotationsDirty = false;
    lastBandExtend = -1e9;
  }

  /**
   * Fold one event into a cluster and restate the cluster's centre and label width.
   *
   * The centre is the midpoint of the events the cluster actually spans, not their mean, so the
   * chevron sits over the middle of the run of events it stands for however lopsided that run is.
   *
   * @param {object} c The cluster.
   * @param {object} m The event mark.
   * @returns {void}
   */
  function absorbMark(c, m) {
    c.items.push(m);
    if (m.x < c.lo) c.lo = m.x;
    if (m.x > c.hi) c.hi = m.x;
    c.x = 0.5 * (c.lo + c.hi);
    c.w = c.items.length === 1 ? c.items[0].w : labelWidth(clusterLabel(c.items.length));
  }

  /**
   * The label a cluster carries: its own code when it stands for one event, otherwise the count.
   * @param {number} n Events in the cluster.
   * @returns {string} The label text.
   */
  function clusterLabel(n) {
    return '×' + n;
  }

  /**
   * Merge the event marks into as many chevrons as will fit WITHOUT their labels touching, at one
   * given pixel scale.
   *
   * This is the whole defect fix. `ui/chart.js` paints every flag label on one fixed row under the
   * plot's top edge — its three-row stagger collapses because each row is clamped back to that
   * same y — so two labels that overlap in x overprint, and at the head of a run half a dozen of
   * them land inside a few millilitres of each other. Nothing downstream can separate them, so
   * nothing overlapping is ever handed downstream.
   *
   * The sweep is left to right and a merge is allowed to cascade backwards: swallowing an event
   * moves a cluster's centre and changes its label from a code to a count, either of which can
   * push it into the cluster before it. The backward loop settles that before moving on, so the
   * result is stable — the property "no two boxes are closer than `MARK_GAP`" holds over the whole
   * array when the sweep ends, not just over the pair last examined.
   *
   * @param {Array<object>} list Event marks in ascending x, each carrying its label width.
   * @param {number} scale px per x unit.
   * @returns {Array<object>} The clusters, in ascending x.
   */
  function clusterMarks(list, scale) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!Number.isFinite(m.x)) continue;
      let last = out.length ? out[out.length - 1] : null;
      if (last && m.x * scale - m.w / 2 < last.x * scale + last.w / 2 + MARK_GAP) {
        absorbMark(last, m);
        while (out.length > 1) {
          const prev = out[out.length - 2];
          if (last.x * scale - last.w / 2 >= prev.x * scale + prev.w / 2 + MARK_GAP) break;
          for (let k = 0; k < last.items.length; k++) absorbMark(prev, last.items[k]);
          out.pop();
          last = prev;
        }
      } else {
        out.push({ x: m.x, lo: m.x, hi: m.x, w: m.w, items: [m] });
      }
    }
    return out;
  }

  /**
   * Whether two cluster arrays group the same events at the same places.
   *
   * Cluster centres are derived from event positions, which only move when the annotations are
   * rebuilt — and that path forces a publish — so identical counts at identical centres means an
   * identical marker set.
   *
   * @param {Array<object>} a One cluster array.
   * @param {Array<object>} b The other.
   * @returns {boolean} True when nothing the trend can see has changed.
   */
  function sameClusters(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].items.length !== b[i].items.length || a[i].x !== b[i].x) return false;
    }
    return true;
  }

  /**
   * Re-cluster the chevrons for the trend's CURRENT pixel scale and publish the marker set.
   *
   * Only the scale matters, never the pan: two labels keep the same pixel gap wherever the window
   * sits, so panning cannot create a collision and does not cost a repaint. A zoom changes the
   * scale and is picked up on the very next frame, which is what makes the guarantee hold at every
   * zoom rather than at the one the run started on.
   *
   * @param {boolean} force True to re-cluster even when the scale has not moved.
   * @returns {void}
   */
  function projectMarkers(force) {
    if (!chart) return;
    const g = chart.geom;
    const span = chart.x1 - chart.x0;
    const scale = (g && g.plotW > 0 && span > 0) ? g.plotW / span : NaN;
    if (!Number.isFinite(scale)) return;
    if (!force && Number.isFinite(lastScale)
      && Math.abs(scale - lastScale) <= Math.abs(lastScale) * MARK_RESCALE) return;
    lastScale = scale;
    const next = clusterMarks(evMarks, scale);
    // A following window rescales on nearly every frame, and almost none of those rescales change
    // which events group together. Re-clustering is cheap; a static repaint is not, so the trend
    // only hears about it when the grouping actually moved.
    if (!force && sameClusters(next, markClusters)) return;
    markClusters = next;
    markers = tickMarks.slice();
    for (let i = 0; i < markClusters.length; i++) {
      const c = markClusters[i];
      const n = c.items.length;
      let worst = c.items[0];
      for (let k = 1; k < n; k++) {
        if (severityRank(c.items[k].severity) > severityRank(worst.severity)) worst = c.items[k];
      }
      const m = {
        x: c.x, label: n === 1 ? c.items[0].code : clusterLabel(n), kind: 'flag',
        severity: worst.severity,
      };
      // A count has to point at something. `x0`/`x1` collapsed onto the chevron's own x draw the
      // one dashed rule down to the axis that says WHICH millilitre the ×N stands for; a single
      // named event does not need it and does not get it.
      if (n > 1) {
        m.x0 = c.x;
        m.x1 = c.x;
      }
      markers.push(m);
    }
    chartlib.setMarkers(chart, markers);
    chartlib.invalidate(chart, 'static');
    if (hoverCluster && markClusters.indexOf(hoverCluster) < 0) closeMarkCard();
  }

  /**
   * The chevron under the pointer, if any.
   *
   * Both coordinates are canvas-relative — `offsetX`/`offsetY` on a canvas target are exactly the
   * space `chart.geom` is expressed in, which is how this reads the trend's geometry without ever
   * measuring the document.
   *
   * @param {number} px Pointer x in canvas px.
   * @param {number} py Pointer y in canvas px.
   * @returns {{cluster:object, px:number}|null} The cluster and its own pixel x, or null.
   */
  function clusterAt(px, py) {
    if (!chart || markClusters.length === 0) return null;
    const g = chart.geom;
    const span = chart.x1 - chart.x0;
    if (!(span > 0) || !(g.plotW > 0)) return null;
    if (py < g.py0 - 4 || py > g.py0 + MARK_ROW_H) return null;
    const kx = g.plotW / span;
    const bx = g.px0 - chart.x0 * kx;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < markClusters.length; i++) {
      const c = markClusters[i];
      const cx = c.x * kx + bx;
      if (cx < g.px0 - MARK_HIT || cx > g.px1 + MARK_HIT) continue;
      const d = Math.abs(cx - px);
      if (d <= Math.max(MARK_HIT, c.w / 2) && d < bestD) {
        bestD = d;
        best = { cluster: c, px: cx };
      }
    }
    return best;
  }

  /**
   * The card a chevron expands into: every event it stands for, in x order, with the position it
   * happened at, its code and the message the plot is no longer allowed to paint.
   *
   * @param {object} c The cluster.
   * @returns {HTMLElement} The card body.
   */
  function markCard(c) {
    const config = ctx.config;
    const n = c.items.length;
    // `c.lo`/`c.hi` are in the trend's CURRENT x channel, which is seconds or column volumes as
    // often as it is millilitres. The card states volume, so it takes it from the events.
    let v0 = c.items[0].V_mL;
    let v1 = v0;
    for (let i = 1; i < n; i++) {
      if (c.items[i].V_mL < v0) v0 = c.items[i].V_mL;
      if (c.items[i].V_mL > v1) v1 = c.items[i].V_mL;
    }
    const wrap = mk('div', 'rv-pop');
    wrap.appendChild(mk('div', 'rv-mark-h', n === 1
      ? c.items[0].name
      : n + ' EVENTS · ' + fmt.fmtVolume(v0, config) + ' – ' + fmt.fmtVolume(v1, config)));
    const list = mk('div', 'rv-mark-l');
    const shown = Math.min(n, MARK_CARD_ROWS);
    for (let i = 0; i < shown; i++) {
      const m = c.items[i];
      const rank = severityRank(m.severity);
      list.appendChild(mk('span', 'rv-mark-x', fmt.fmtVolume(m.V_mL, config)));
      list.appendChild(mk('span', 'rv-mark-c'
        + (rank >= 2 ? ' is-alarm' : (rank === 1 ? ' is-warn' : '')), m.code));
      list.appendChild(mk('span', 'rv-mark-m', m.message || m.name));
    }
    wrap.appendChild(list);
    if (n > shown) wrap.appendChild(mk('div', 'rv-mark-more', 'AND ' + (n - shown) + ' MORE'));
    return wrap;
  }

  /**
   * Close the open chevron card and cancel any card that was about to open.
   * @returns {void}
   */
  function closeMarkCard() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = 0;
    }
    if (hoverHandle) {
      overlaylib.dismiss(hoverHandle);
      hoverHandle = null;
    }
    hoverCluster = null;
  }

  /**
   * Track the pointer across the trend's marker row and open, move or close the cluster card.
   *
   * This listener never calls `preventDefault` or `stopPropagation`: the trend's own zoom, pan and
   * pool handlers are bound to the same element and must keep every event this one sees.
   *
   * @param {MouseEvent} e The pointer move.
   * @returns {void}
   */
  function onWellMove(e) {
    const target = e.target;
    if (!target || target.tagName !== 'CANVAS') {
      closeMarkCard();
      return;
    }
    const hit = clusterAt(e.offsetX, e.offsetY);
    if (!hit) {
      closeMarkCard();
      return;
    }
    if (hit.cluster === hoverCluster) return;
    closeMarkCard();
    hoverCluster = hit.cluster;
    // The canvas' own viewport origin, free: the pointer is at `clientX` and, in the canvas' own
    // coordinates, at `offsetX`. No rect is read on a pointer move.
    const left = Math.round(e.clientX - e.offsetX + hit.px);
    const top = Math.round(e.clientY - e.offsetY + chart.geom.py0);
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (!hoverCluster || !mounted) return;
      markAnchor.style.left = left + 'px';
      markAnchor.style.top = top + 'px';
      hoverHandle = overlaylib.showPopover(host, {
        anchorEl: markAnchor,
        content: markCard(hoverCluster),
        placement: 'top',
        maxWidth: 340,
        role: 'tooltip',
        closeOnOutside: true,
        onDismiss: () => { hoverHandle = null; hoverCluster = null; },
      });
    }, 180);
  }

  /**
   * Stretch the in-progress phase band out to the live edge, at 2 Hz rather than per frame: the
   * static layer's repaint budget is small and the band edge is at the live edge either way.
   *
   * @param {number} now Frame timestamp, ms.
   * @returns {void}
   */
  function extendOpenBand(now) {
    if (openBands.length === 0 || !chart) return;
    if (now - lastBandExtend < 500) return;
    lastBandExtend = now;
    openBands[0].x1 = toX(ctx.run.V_tot_mL, ctx.run.t_s);
    chartlib.setBands(chart, bands);
    chartlib.invalidate(chart, 'static');
  }

  /**
   * Find a method block by id.
   * @param {object} config The frozen config.
   * @param {string} id Block id.
   * @returns {object|null} The block, or null.
   */
  function findBlock(config, id) {
    const blocks = (config.method && config.method.blocks) || [];
    for (let i = 0; i < blocks.length; i++) if (blocks[i].id === id) return blocks[i];
    return null;
  }

  /**
   * The window the trend is showing. The trend is the authority; the view's own record is the
   * fallback before it owns one, and the whole run is the last resort.
   * @returns {{x0:number, x1:number}} The window in the current x mode's channel units.
   */
  function currentWindow() {
    if (chart && Number.isFinite(chart.x0) && chart.x1 > chart.x0) {
      return { x0: chart.x0, x1: chart.x1 };
    }
    if (Number.isFinite(viewWindow.x0) && viewWindow.x1 > viewWindow.x0) {
      return { x0: viewWindow.x0, x1: viewWindow.x1 };
    }
    const col = column(ctx.run.log, X_CHANNELS[chart ? chart.xMode : xMode]);
    const last = col.length ? col[col.length - 1] : 0;
    return { x0: 0, x1: last > 0 ? last : 1 };
  }

  /**
   * Zoom about the window centre.
   * @param {number} factor Span multiplier; below 1 zooms in.
   * @returns {void}
   */
  function zoomBy(factor) {
    if (!chart) return;
    const w = currentWindow();
    const c = 0.5 * (w.x0 + w.x1);
    const half = 0.5 * (w.x1 - w.x0) * factor;
    if (!(half > 0)) return;
    chartlib.setWindow(chart, c - half, c + half);
  }

  /**
   * Pan by a fraction of the window span.
   * @param {number} frac Signed fraction of the span, e.g. -0.05.
   * @returns {void}
   */
  function panBy(frac) {
    if (!chart) return;
    const w = currentWindow();
    const d = (w.x1 - w.x0) * frac;
    if (!Number.isFinite(d) || d === 0) return;
    chartlib.setWindow(chart, w.x0 + d, w.x1 + d);
  }

  /**
   * Fit the whole run into the window.
   * @returns {void}
   */
  function fitAll() {
    if (!chart) return;
    const col = column(ctx.run.log, X_CHANNELS[chart.xMode]);
    const last = col.length ? col[col.length - 1] : 0;
    chartlib.setWindow(chart, 0, last > 0 ? last : 1);
  }

  /**
   * Re-enable live following.
   * @returns {void}
   */
  function jumpToLive() {
    if (chart) chartlib.setFollow(chart, true);
  }

  /**
   * Advance the x axis to the next mode.
   * @returns {void}
   */
  function cycleXMode() {
    if (!chart) return;
    let k = 0;
    for (let i = 0; i < X_MODES.length; i++) if (X_MODES[i] === chart.xMode) k = i;
    chartlib.setXMode(chart, X_MODES[(k + 1) % X_MODES.length]);
  }

  /**
   * Hand the keyboard to the trend's pen rail. The rail's rows are built and owned by
   * `ui/chart.js`, which exposes `focusPenRail()` on the handle `createChart` returns; this view
   * only asks for it.
   *
   * @returns {boolean} True when the rail took the focus. False when there is no chart, no such
   *   entry point or no row to land on, which leaves the shortcut to its caller's fallback.
   */
  function focusPenRail() {
    if (!chart || typeof chart.focusPenRail !== 'function') return false;
    const res = chart.focusPenRail();
    if (res === false) return false;
    if (res === true) return true;
    // An implementation that answers with nothing has still either moved the focus or not; the
    // document is the authority on which.
    const active = document.activeElement;
    return !!(chart.el && active && active !== document.body && chart.el.contains(active));
  }

  /* ========================================================================================== */
  /* 4.4 misc UI plumbing                                                                       */
  /* ========================================================================================== */

  /**
   * Run a `core/sim.js` action and let the overlay host explain a refusal. Interlocks are always
   * explained, never silently refused.
   * @param {string} name The action name.
   * @param {...any} args Arguments after `ctx`.
   * @returns {boolean} True when the action succeeded.
   */
  function act(name, ...args) {
    return overlaylib.reportResult(host, callSim(ctx, name, ...args));
  }

  /**
   * Open the glossary popover for an id, when `data/glossary.js` has an entry.
   * @param {Element} anchorEl The anchor.
   * @param {string} id A glossary id, tag or alias.
   * @returns {void}
   */
  function openGlossary(anchorEl, id) {
    const entry = glossaryFor(id);
    if (!entry) return;
    track(overlaylib.showGlossaryPopover(host, {
      anchorEl,
      entry,
      placement: 'top',
      onSeeAlso: (seeAlsoId) => openGlossary(anchorEl, seeAlsoId),
    }));
  }

  /**
   * Remember an overlay handle so `destroy` can dismiss it.
   * @param {any} handle An overlay handle.
   * @returns {any} The same handle.
   */
  function track(handle) {
    if (handle) openHandles.push(handle);
    return handle;
  }

  /**
   * Emit on the app bus, tolerating a context without one.
   * @param {string} name Event name.
   * @param {any} payload Payload.
   * @returns {void}
   */
  function emit(name, payload) {
    if (ctx.bus && typeof ctx.bus.emit === 'function') ctx.bus.emit(name, payload);
  }

  /**
   * The trend, schematic and pooling shortcuts. `ui/app.js` owns the one document key listener and
   * forwards every action it does not handle itself on the bus as `'key-action'`, so this view
   * never installs a second listener and nothing is ever double-handled.
   *
   * @param {{action:string}} payload The bus payload from `ui/app.js`.
   * @returns {void}
   */
  function onKeyAction(payload) {
    if (!mounted || !payload || cachedW <= 0) return;    // a hidden screen owns no shortcut
    switch (payload.action) {
      case 'x-axis-cycle': cycleXMode(); return;
      case 'autoscale': fitAll(); return;
      case 'follow-toggle':
        if (chart) chartlib.setFollow(chart, !chart.follow);
        return;
      case 'zoom-in': zoomBy(1 / 1.6); return;
      case 'zoom-out': zoomBy(1.6); return;
      case 'pan-left': panBy(-0.05); return;
      case 'pan-right': panBy(0.05); return;
      case 'pan-left-fast': panBy(-0.25); return;
      case 'pan-right-fast': panBy(0.25); return;
      case 'legend-focus':
        // The rail belongs to the trend. Only when it cannot take the focus does the key fall back
        // to the fraction strip, which is this screen's own list of pickable things.
        if (!focusPenRail() && nodes.vials.length > 1) nodes.vials[1].focus();
        return;
      case 'pool-selection': {
        if (selFrom < 0) {
          overlaylib.showToast(host, {
            message: 'Select one or more fractions in the strip first, then press Shift+P.',
            kind: 'info', ms: 4000,
          });
          return;
        }
        const ports = ctx.config.skid.fracValve.ports;
        const lo = Math.min(selFrom, selTo);
        const hi = Math.max(selFrom, selTo);
        emit('pool-request', { from: ports[lo], to: ports[hi] });
        return;
      }
      default:
    }
  }

  /* ---- splitter ---------------------------------------------------------------------------- */

  /**
   * The screen height the sizing maths works from: the observed one, or a sane default before the
   * `ResizeObserver` has reported anything.
   * @returns {number} Height in px.
   */
  function screenH() {
    return cachedH > 0 ? cachedH : FALLBACK_H;
  }

  /**
   * The legal range for the trend band: the trend never collapses below 120 px and the schematic
   * always keeps 200 px.
   * @returns {{lo:number, hi:number}} Inclusive bounds, px.
   */
  function trendBounds() {
    return { lo: 120, hi: Math.max(160, screenH() - 200) };
  }

  /**
   * The trend band height: the one this view set, or the last one the observer measured.
   * @returns {number} Height in px.
   */
  function trendHeight() {
    return Number.isFinite(trendPx) ? trendPx : cachedTrendH;
  }

  /**
   * Size the trend band and keep the separator's ARIA values in step. Every size comes from the
   * `ResizeObserver` cache, so this never reads layout.
   *
   * @param {number} px The requested trend height, px; clamped to {@link trendBounds}.
   * @param {boolean} manual True when the operator moved the splitter themselves, which lifts any
   *   navigation bias and makes this the position a later `request-pane` toggle returns to.
   * @returns {void}
   */
  function setTrendHeight(px, manual) {
    const b = trendBounds();
    trendPx = clamp(px, b.lo, b.hi);
    el.style.setProperty('--rv-trend-h', Math.round(trendPx) + 'px');
    splitter.setAttribute('aria-valuemin', String(Math.round(b.lo)));
    splitter.setAttribute('aria-valuemax', String(Math.round(b.hi)));
    splitter.setAttribute('aria-valuenow', String(Math.round(trendPx)));
    if (manual) {
      manualTrendPx = trendPx;
      panePref = '';
    }
    if (chart) chartlib.invalidate(chart, 'all');
  }

  /**
   * Act on the navigation's `request-pane` hint. The P&ID and TREND buttons select the same screen,
   * so the only thing they can honestly change is which pane has the room and where the keyboard
   * is: the splitter is biased to {@link PANE_FRAC} and the focus moves into the pane. Neither pane
   * is ever hidden. Asking again for the pane that is already favoured hands the split back to
   * wherever the operator last put it themselves, so the bias is always reversible.
   *
   * @param {{pane:string}|string} payload The bus payload, `{ pane: 'pid' | 'trend' }`; a bare
   *   pane id is accepted too, because that is what older emitters send.
   * @returns {void}
   */
  function onRequestPane(payload) {
    const pane = (payload && typeof payload === 'object') ? payload.pane : payload;
    if (!mounted || (pane !== 'pid' && pane !== 'trend')) return;
    // The nav publishes this in the same turn as it reveals the screen, so the observer may not
    // have measured it yet; `update` restates the bias against the real height when it has.
    paneStale = cachedH <= 0;
    if (panePref === pane) {
      setTrendHeight(Number.isFinite(manualTrendPx) ? manualTrendPx : SNAP_FRAC[1] * screenH(),
        false);
      panePref = '';
    } else {
      const now = trendHeight();
      if (!panePref && Number.isFinite(now) && now > 0) manualTrendPx = now;
      setTrendHeight(PANE_FRAC[pane] * screenH(), false);
      panePref = pane;
    }
    focusPane(pane);
  }

  /**
   * Move the keyboard into one pane: the trend's plot well, or the first interactive symbol on the
   * schematic. Both hosts carry `tabindex="-1"`, so there is always somewhere to land.
   * @param {string} pane `'pid'` or `'trend'`.
   * @returns {void}
   */
  function focusPane(pane) {
    let target = null;
    if (pane === 'trend') {
      target = (chart && chart.wellEl) || trendPanel;
    } else {
      target = pidHost.querySelector('[tabindex]:not([tabindex="-1"])') || pidHost;
    }
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  /**
   * Wire the schematic / trend splitter: pointer drag, arrow-key resizing (10 px, shift 40 px) and
   * three snap points at 30 / 45 / 60 % of the screen, exposing `role="separator"` with a live
   * `aria-valuenow` in px.
   *
   * @returns {function():void} A teardown function.
   */
  function wireSplitter() {
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'horizontal');
    splitter.setAttribute('aria-label', 'Resize the trend against the schematic');
    splitter.setAttribute('tabindex', '0');
    splitter.title = 'Drag to resize the trend; arrow keys move it in 10 px steps';

    // Everything the splitter does is the operator's own choice, so every path is a manual move:
    // it becomes the position the navigation bias hands back to.
    const current = trendHeight;
    const apply = (v) => setTrendHeight(v, true);

    let dragging = false;
    let startY = 0;
    let startSize = 0;
    const onDown = (e) => {
      dragging = true;
      startY = e.clientY;
      startSize = current();
      fmt.cls(splitter, 'is-dragging', true);
      splitter.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      apply(startSize - (e.clientY - startY));
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      fmt.cls(splitter, 'is-dragging', false);
      try { splitter.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (cachedH <= 0) return;
      let best = NaN;
      let bestD = Infinity;
      for (let i = 0; i < SNAP_FRAC.length; i++) {
        const target = SNAP_FRAC[i] * cachedH;
        const d = Math.abs(target - current());
        if (d < bestD) { bestD = d; best = target; }
      }
      if (bestD <= 20) apply(best);
    };
    const onKey = (e) => {
      const step = e.shiftKey ? 40 : 10;
      if (e.key === 'ArrowUp') { apply(current() + step); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { apply(current() - step); e.preventDefault(); }
      else if (e.key === 'Home' && cachedH > 0) {
        apply(SNAP_FRAC[0] * cachedH);
        e.preventDefault();
      } else if (e.key === 'End' && cachedH > 0) {
        apply(SNAP_FRAC[SNAP_FRAC.length - 1] * cachedH);
        e.preventDefault();
      }
    };
    splitter.addEventListener('pointerdown', onDown);
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
    splitter.addEventListener('keydown', onKey);
    return () => {
      splitter.removeEventListener('pointerdown', onDown);
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      splitter.removeEventListener('keydown', onKey);
    };
  }

  /* ---- bus + observers -------------------------------------------------------------------- */
  const busHandlers = [];

  /**
   * Subscribe to a bus event and remember the pair for teardown.
   * @param {string} name Event name.
   * @param {Function} fn Handler.
   * @returns {void}
   */
  function on(name, fn) {
    if (!ctx.bus || typeof ctx.bus.on !== 'function') return;
    ctx.bus.on(name, fn);
    busHandlers.push([name, fn]);
  }

  /** Full rebind after the config or run object was replaced. */
  const onReplaced = () => {
    pendingStructural = true;
    annotationsDirty = true;
    evCursor = 0;
    selFrom = -1;
    selTo = -1;
    if (chart) {
      boundStore = ctx.run.log;
      chartlib.setSource(chart, boundStore, X_CHANNELS, ctx.config);
      chartlib.invalidate(chart, 'all');
    }
  };

  /** Display-unit preferences changed: force the next readout to re-label and re-convert. */
  const onUnitsChanged = () => {
    lastReadout = -1e9;
  };

  const ro = new ResizeObserver((entries) => {
    for (let i = 0; i < entries.length; i++) {
      const r = entries[i].contentRect;
      if (entries[i].target === trendPanel) {
        cachedTrendH = r.height;
      } else {
        cachedW = r.width;
        cachedH = r.height;
      }
    }
    fmt.cls(el, 'is-narrow', cachedW > 0 && cachedW < 900);
    fmt.cls(el, 'is-short', cachedH > 0 && cachedH < 620);
    if (chart) chartlib.invalidate(chart, 'all');
  });

  let unwireSplitter = null;

  /* ========================================================================================== */
  /* 4.5 per-frame update                                                                       */
  /* ========================================================================================== */

  /**
   * Refresh the P&ID header: the quality-flag lamps, the manual-override ring and the active
   * alarm count. The simulation band's speed readout rides along, because it changes on the same
   * cadence and for the same reason — it is a statement about the machine, not about the process.
   * @param {Set<string>} activeIds Ids of the alarms currently active.
   * @returns {void}
   */
  function updateHeader(activeIds) {
    const run = ctx.run;
    const qf = run.qualityFlags | 0;
    for (let i = 0; i < nodes.qfLamps.length; i++) {
      const set = (qf & QF_LAMPS[i][1]) !== 0;
      const node = nodes.qfLamps[i];
      if (node.el.hidden === set) node.el.hidden = !set;
      setLamp(node.lamp, set ? QF_LAMPS[i][2] : '');
    }
    fmt.cls(pidPanel, 'is-manual', !!run.manualOverride);
    const n = activeIds.size;
    almBox.set(String(n), n > 0 ? 'alarm' : 'pv');
    // The speed lives INSIDE the simulation band and nowhere else on this screen. A 1000× that is
    // only ever read next to the words SIMULATION — NOT PLANT cannot be mistaken for a plant rate.
    const spd = run.speed;
    fmt.setText(simSpeed,
      'SPEED ' + (Number.isFinite(spd) ? nfix(spd, 0) + '×' : fmt.NO_VALUE));
    fmt.cls(simSpeed, 'is-fast', Number.isFinite(spd) && spd > 1);
  }

  /**
   * Refresh the phase rail: segment classes, the sweep transform and the three label boxes.
   * @returns {void}
   */
  function updateRail() {
    const config = ctx.config;
    const run = ctx.run;
    const blocks = (config.method && config.method.blocks) || [];
    const cur = run.blockIndex;
    const prog = engine.blockProgress(config, run);
    const running = run.state !== 'IDLE' && run.state !== 'READY';
    for (let i = 0; i < nodes.railBlocks.length; i++) {
      const btn = nodes.railBlocks[i];
      const done = i < cur;
      const isCur = i === cur && running;
      fmt.cls(btn, 'is-done', done);
      fmt.cls(btn, 'is-active', isCur);
      if (isCur) btn.setAttribute('aria-current', 'step');
      else btn.removeAttribute('aria-current');
      const f = done ? 1 : (isCur ? clamp(prog.fraction, 0, 1) : 0);
      const next = 'scaleX(' + f.toFixed(4) + ')';
      if (nodes.railFills[i].style.transform !== next) nodes.railFills[i].style.transform = next;
    }
    blkBox.set(blocks.length ? (running ? cur + 1 : 0) + '/' + blocks.length : fmt.NO_VALUE,
      running ? 'pv' : 'stale');
    progBox.set(nfix(100 * clamp(prog.fraction, 0, 1), 0), running ? 'pv' : 'stale');
    if (Number.isFinite(prog.remaining_mL)) {
      const d = fmt.toDisplay('volume', prog.remaining_mL, config);
      remBox.setUnit(d.unit);
      remBox.set(nfix(d.value, d.decimals), 'pv');
    } else {
      remBox.set(fmt.NO_VALUE, 'stale');
    }
  }

  /**
   * Refresh the collector: the destination plaque, every cell's fill and state, and the counters.
   *
   * The plaque is the prominent half of this and the strip is the dense half, but both are driven
   * from the same reads they always were — `run.frac`, `run.portVolume_mL` and `run.wasteVolume_mL`
   * — because the compaction was a decision about width, not about what is true.
   * @returns {void}
   */
  function updateFractions() {
    const config = ctx.config;
    const run = ctx.run;
    const fv = config.skid.fracValve;
    const ports = fv.ports;
    const cap = fv.portCapacity_mL || 1;

    const byPort = new Map();
    for (let i = 0; i < run.frac.records.length; i++) {
      byPort.set(run.frac.records[i].port, run.frac.records[i]);
    }
    for (let i = 0; i < ports.length; i++) {
      const btn = nodes.vials[i + 1];
      if (!btn) continue;
      const v = run.portVolume_mL ? run.portVolume_mL[i] : 0;
      const pct = clamp(100 * v / cap, 0, 100).toFixed(1) + '%';
      if (nodes.vialFills[i + 1].style.height !== pct) nodes.vialFills[i + 1].style.height = pct;
      const rec = byPort.get(ports[i]);
      const isOpen = !!run.frac.open && run.frac.port === ports[i];
      fmt.cls(btn, 'is-open', isOpen);
      fmt.cls(btn, 'has-peak', !!(rec && rec.containsPeakMax));
      setLamp(nodes.vialLamps[i + 1], isOpen ? 'is-run' : (rec ? 'is-warn' : ''));
      btn.title = rec
        ? ports[i] + ' · ' + fmt.fmtVolume(rec.volume_mL, config) + ' · max '
          + nfix(rec.uvMax_mAU, 1) + ' mAU · ' + rec.trigger + ' · ' + rec.quality
        : ports[i] + ' — empty';
    }
    const wasteVial = nodes.vials[0];
    if (wasteVial) {
      const toWaste = run.frac.port === 'WASTE' || !run.frac.open;
      setLamp(nodes.vialLamps[0], toWaste ? 'is-warn' : '');
      const wcap = config.skid.wasteCapacity_mL || 1;
      const wpct = clamp(100 * run.wasteVolume_mL / wcap, 0, 100).toFixed(1) + '%';
      if (nodes.vialFills[0].style.height !== wpct) nodes.vialFills[0].style.height = wpct;
      wasteVial.title = 'WASTE · ' + fmt.fmtVolume(run.wasteVolume_mL, config);
    }

    const mode = run.frac.mode || 'OFF';
    setLamp(fracModeLamp, mode === 'OFF' ? '' : 'is-run');
    fracModeLamp.title = 'FC-101 mode: ' + mode;
    fracCountBox.set(String(run.frac.records.length), 'pv');

    // The destination plaque. `k < 0` means the head is not over a configured port, which is the
    // same condition the waste cell lamps on: the outlet is going to drain.
    const k = ports.indexOf(run.frac.port);
    const diverting = k < 0 || !run.frac.open;
    const pv = k >= 0 && run.portVolume_mL ? run.portVolume_mL[k] : run.wasteVolume_mL;
    const d = fmt.toDisplay('volume', pv, config);
    fmt.setText(destPort, k >= 0 ? ports[k] : 'WASTE');
    fmt.setText(destVol, nfix(d.value, d.decimals));
    fmt.setText(destUnit, d.unit);
    fmt.cls(destBox, 'is-waste', diverting);
    if (destWaste.hidden === diverting) destWaste.hidden = !diverting;
    fmt.setAttr(destBox, 'aria-label', 'Destination '
      + (k >= 0 ? ports[k] : 'waste') + ', ' + nfix(d.value, d.decimals) + ' ' + d.unit
      + (diverting ? ', diverting to waste' : ''));

    fracMarkBtn.disabled = !(run.state === 'RUNNING' || run.state === 'HELD') || mode === 'OFF';
  }

  /**
   * The ids of every alarm whose condition is active right now.
   * @returns {Set<string>} Alarm ids.
   */
  function activeAlarmIds() {
    const run = ctx.run;
    const table = ctx.config.alarms || [];
    const out = new Set();
    for (let k = 0; k < table.length; k++) if (run.alarmActive[k] === 1) out.add(table[k].id);
    return out;
  }

  /* ========================================================================================== */
  /* 5. PANEL                                                                                   */
  /* ========================================================================================== */

  /**
   * Mount: build the children that need a laid-out DOM (the trend and the schematic), take the
   * first render and start observing.
   * @returns {void}
   */
  function mount() {
    if (mounted) return;
    mounted = true;

    buildRail();
    buildVials();

    pid = pidlib.createPID(pidHost, ctx);
    if (pid && typeof pid.mount === 'function') pid.mount();
    // ui/pid.js floors `.pid-root` at 320 px in its own injected sheet, which on a short screen
    // pushes the schematic out of its well instead of letterboxing it. The SVG already carries
    // `preserveAspectRatio="xMidYMid meet"`, so releasing the floor HERE — on the instance, not
    // in that module — makes it scale down and stay whole.
    if (pid && pid.el && pid.el.style) pid.el.style.minHeight = '0';

    buildChart();
    unwireSplitter = wireSplitter();

    on('config-replaced', onReplaced);
    on('preset-loaded', onReplaced);
    on('scenario-applied', onReplaced);
    on('run-reset', onReplaced);
    on('run-started', () => { pendingStructural = true; annotationsDirty = true; jumpToLive(); });
    on('run-ended', () => { pendingStructural = true; annotationsDirty = true; fitAll(); });
    on('estop', () => { pendingStructural = true; });
    on('display-units-changed', onUnitsChanged);
    on('key-action', onKeyAction);
    on('request-pane', onRequestPane);

    ro.observe(el);
    ro.observe(trendPanel);
    // Seed the size cache with ONE measurement, here, outside the frame loop. `update` refuses to
    // run at zero size, and a `ResizeObserver` callback is delivered with the rendering steps — a
    // host that is laid out but not compositing would otherwise leave this screen frozen at its
    // mount-time values forever. Every later size comes from the observer; this is the only read.
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      cachedW = box.width;
      cachedH = box.height;
      cachedTrendH = trendPanel.getBoundingClientRect().height;
      // The responsive classes were the observer's alone, which left the first frame laid out for
      // a screen this may not be. The process band is one row now and has no slack to spare, so
      // the breakpoints are stated here too, from the measurement already in hand.
      fmt.cls(el, 'is-narrow', cachedW < 900);
      fmt.cls(el, 'is-short', cachedH < 620);
    }

    updateHeader(activeAlarmIds());
    updateRail();
    updateFractions();
  }

  /**
   * The per-frame render. Physics is not touched here: `ui/app.js` has already called
   * `sim.advanceWall` for this frame.
   *
   * @param {{now_ms:number, dt_ms:number, tick:number, structural:boolean}} frameInfo
   *   The frame descriptor from `ui/app.js`.
   * @returns {void}
   */
  function update(frameInfo) {
    if (!mounted) return;
    if (cachedW <= 0 || cachedH <= 0) return;      // hidden screen or zero size: cost nothing

    const now = (frameInfo && Number.isFinite(frameInfo.now_ms))
      ? frameInfo.now_ms : performance.now();
    const structural = pendingStructural || !!(frameInfo && frameInfo.structural);
    pendingStructural = false;
    const run = ctx.run;

    if (run.log !== boundStore && chart) {
      boundStore = run.log;
      chartlib.setSource(chart, boundStore, X_CHANNELS, ctx.config);
      chartlib.invalidate(chart, 'all');
    }

    // A pane bias applied before the observer had measured this screen was sized against the
    // fallback height; the real one is known here, so restate it once.
    if (paneStale) {
      paneStale = false;
      if (panePref) setTrendHeight(PANE_FRAC[panePref] * cachedH, false);
      else if (!Number.isFinite(manualTrendPx)) setTrendHeight(SNAP_FRAC[1] * cachedH, false);
    }

    if (structural) {
      if (methodSig() !== railSig) buildRail();
      if (slotNames().join(',') !== vialSig) buildVials();
      annotationsDirty = true;
    }

    // The trend's own toolbar can change the x mode, and band coordinates are in x units.
    const xModeChanged = !!chart && chart.xMode !== xMode;
    if (xModeChanged) annotationsDirty = true;

    if (annotationsDirty || (run.events && run.events.length !== evCursor)) {
      rebuildAnnotations();
    } else {
      extendOpenBand(now);
      // Every frame, not every 500 ms: a zoom changes the pixel scale and therefore which labels
      // collide, and a frame of overprint is still overprint. The call costs two divisions and a
      // comparison unless the scale actually moved.
      projectMarkers(false);
    }

    // `rebuildAnnotations` re-projects the bands and the markers, but the pool window belongs to
    // the fraction selection: without this the shaded pool keeps its old units and millilitres are
    // read as seconds. Only on the transition — the projection filters records and publishes on
    // the bus, which is not per-frame work.
    if (xModeChanged) applySelection();

    if (now - lastReadout >= READOUT_MS) {
      lastReadout = now;
      updateHeader(activeAlarmIds());
      updateRail();
      updateFractions();
    }

    if (pid && typeof pid.update === 'function') pid.update(frameInfo);
    if (chart) chartlib.frame(chart, now);
  }

  /**
   * Tear everything down: observers, bus subscriptions, the splitter handlers, overlays, the trend
   * and the schematic. After this the view holds no references into `run` or `config`.
   * @returns {void}
   */
  function destroy() {
    mounted = false;
    ro.disconnect();
    for (let i = 0; i < busHandlers.length; i++) {
      if (ctx.bus && typeof ctx.bus.off === 'function') {
        ctx.bus.off(busHandlers[i][0], busHandlers[i][1]);
      }
    }
    busHandlers.length = 0;
    if (unwireSplitter) unwireSplitter();
    unwireMarkHover();
    for (let i = 0; i < openHandles.length; i++) overlaylib.dismiss(openHandles[i]);
    openHandles.length = 0;
    if (chart) { chartlib.destroyChart(chart); chart = null; }
    if (pid && typeof pid.destroy === 'function') pid.destroy();
    pid = null;
    boundStore = null;
    evMarks = [];
    tickMarks = [];
    markClusters = [];
    if (markAnchor.parentNode) markAnchor.parentNode.removeChild(markAnchor);
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return { el, mount, update, destroy };
}
