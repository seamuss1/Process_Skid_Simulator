/**
 * @file src/ui/view_run.js — the main operator screen, in the HMI-2012 idiom.
 *
 * LAYER: `ui-panels`. This module COMPOSES `ui/pid.js` and `ui/chart.js` and re-implements
 * neither: the schematic brings its own symbols and interactions, the trend brings its own
 * toolbar, pen rail, limit lines and history strip. What lives here is the screen that holds them
 * together and the two process widgets neither of them owns.
 *
 * SCREEN, top to bottom:
 *   1. P&ID panel      `flex: 1 1 0` — it claims every pixel the fixed bands leave behind.
 *   2. Fraction strip  waste + 12 ports, recessed cells that fill with product green as they
 *                      collect, the port under the head lamped and ringed.
 *   3. Splitter        6 px, `role="separator"`, drag / arrow keys / three snap points.
 *   4. Phase rail      a segmented progress bar: one block per segment, a service-tint cap, an
 *                      accent fill that sweeps across the active segment.
 *   5. Trend panel     the chromatogram, holding `ui/chart.js` whole.
 *
 * There is NO bottom value strip. It duplicated numbers that already sit beside their instruments
 * on the schematic and in the trend's pen rail, and it cost the two panels that matter their
 * height. Run state and quality indication live in the title bar, beside the alarm summary.
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

/** Event types that earn an axis chevron on the trend. */
const MARKER_EVENTS = Object.freeze({
  RUN_START: 'run start', ALARM_RAISED: 'alarm', WATCH_FIRED: 'watch',
  OPERATOR_ACTION: 'operator', AUTOZERO: 'autozero', PEAK_MAX: 'peak max',
  AIR_DETECTED: 'air', FLOW_REDUCTION_START: 'flow reduced', STATE_CHANGE: 'state',
});

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

/** Fraction strip band height, px. Published as `--rv-frac-h`, which `styles/app.css` reads. */
const FRAC_H = 34;

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
  /* -- bands (fraction strip, phase rail) ---------------------------------------------------- */
  '.rv-band{flex:0 0 auto;display:flex;align-items:center;gap:var(--sp-5);',
  'padding:0 var(--sp-5);min-width:0}',
  '.rv-frac{flex-basis:var(--rv-frac-h)}',
  '.rv-vials{display:flex;align-items:stretch;gap:2px;flex:1 1 auto;min-width:0;height:26px}',
  '.rv-vials>li{flex:1 1 0;min-width:0;display:flex}',
  '.rv-vials>li.rv-wasteli{flex:0 0 36px}',
  '.rv-vial{width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;',
  'padding:0 1px 1px;overflow:hidden;cursor:pointer}',
  /* -- phase rail --------------------------------------------------------------------------- */
  '.rv-railbar{flex-basis:26px;height:26px}',
  '.rv-rail{display:flex;align-items:stretch;gap:1px;flex:1 1 auto;min-width:0;height:18px;',
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
  '.rv.is-short .rv-blk-t{display:none}',
  '.rv.is-short .rv-railbar{flex-basis:18px;height:18px}',
  '.rv.is-short .rv-rail{height:14px}',
].join('') + '}';

/**
 * The chrome this screen OWNS — panel frames, the phase rail, the fraction strip, the splitter.
 *
 * Deliberately UNLAYERED and scoped under `.rv`, so it wins on both specificity and layer order:
 * these four widgets are this module's responsibility, not the shell's.
 *
 * Every surface below is one of the depth recipes `styles/tokens.css` publishes: raised is
 * `--surface-raised` + `--border-edge` + `--elev-raised`, recessed is `--fld-bg` +
 * `--border-field` + `--elev-sunken`. Nothing here hand-rolls a border, a gradient or a shadow,
 * which is also why the light theme needs no rule of its own — those recipes invert themselves.
 * No colour literal appears in this file at all.
 */
const STYLE_CHROME = [
  '.rv{background:var(--screen);gap:3px;padding:3px}',
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
  /* -- fraction strip: recessed cells that fill with product green ---------------------------- */
  '.rv .rv-vials{background:none;border:0;box-shadow:none;overflow:visible}',
  '.rv .rv-vial{position:relative;background:var(--fld-bg);border:var(--border-field);',
  'border-radius:2px;box-shadow:var(--elev-sunken)}',
  '.rv .rv-vial-f{position:absolute;left:0;right:0;bottom:0;height:0;z-index:0;',
  'background:var(--svc-product);pointer-events:none}',
  '.rv .rv-vial.is-waste .rv-vial-f{background:var(--svc-waste)}',
  '.rv .rv-vial .lamp{position:absolute;top:2px;left:50%;margin-left:-4px;width:8px;height:8px;',
  'z-index:2}',
  '.rv .rv-vial-id{position:relative;z-index:2;pointer-events:none;white-space:nowrap;',
  'overflow:hidden;color:var(--ink-2);font:600 9px/1 var(--font-num);letter-spacing:.02em}',
  '.rv .rv-vial.has-peak .rv-vial-id{color:var(--ink)}',
  '.rv .rv-vial.is-pooling{background:var(--accent-soft);border-color:var(--accent)}',
  '.rv .rv-vial.is-pooling .rv-vial-f{background:var(--svc-product)}',
  '.rv .rv-vial.is-pooling .rv-vial-id{color:var(--ink)}',
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
  /* -- the two label boxes each band carries ------------------------------------------------- */
  '.rv .rv-band .lbl{color:var(--ink-2);font:600 10px/1 var(--font-ui);letter-spacing:.02em}',
  '.rv .rv-band .tb-sep{width:1px;height:14px;flex:0 0 1px;margin:0 2px;',
  'background:var(--edge-soft);box-shadow:none}',
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

  /* -- 1. P&ID panel -- */
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

  /* -- 2. fraction strip -- */
  const fracBand = mk('div', 'rv-band rv-frac');
  fracBand.setAttribute('role', 'group');
  fracBand.setAttribute('aria-label', 'Fraction collector');
  fracBand.appendChild(mk('span', 'lbl', 'FC-101'));
  const fracModeLamp = lamp('');
  fracBand.appendChild(fracModeLamp);
  const fracMarkBtn = iconButton('mark', 'Mark a fraction now (M)', 'MARK',
    () => act('markFraction'));
  const fracClearBtn = iconButton('clear', 'Clear the pool selection', 'CLEAR', () => {
    selFrom = -1;
    selTo = -1;
    applySelection();
  });
  fracBand.appendChild(fracMarkBtn);
  fracBand.appendChild(fracClearBtn);
  fracBand.appendChild(mk('span', 'tb-sep'));
  const vialList = mk('ul', 'rv-vials');
  vialList.setAttribute('role', 'listbox');
  vialList.setAttribute('aria-label', 'Fraction collector positions');
  fracBand.appendChild(vialList);
  fracBand.appendChild(mk('span', 'tb-sep'));
  const fracCountBox = labelBox('FR', '', {
    title: 'Fractions collected so far',
    onInfo: (anchor) => openGlossary(anchor, 'FRACTION'),
  });
  const fracVolBox = labelBox('PORT', 'mL', { title: 'Volume in the port now under the head' });
  fracBand.appendChild(fracCountBox.el);
  fracBand.appendChild(fracVolBox.el);
  el.appendChild(fracBand);

  /* -- 3. splitter -- */
  const splitter = mk('div', 'splitter splitter--h');
  el.appendChild(splitter);

  /* -- 4. phase rail -- */
  const railBand = mk('div', 'rv-band rv-railbar');
  railBand.appendChild(mk('span', 'lbl', 'PHASE'));
  const railList = mk('ol', 'rv-rail');
  railList.setAttribute('aria-label', 'Method blocks, widths proportional to volume');
  railBand.appendChild(railList);
  railBand.appendChild(mk('span', 'tb-sep'));
  const blkBox = labelBox('BLK', '', { title: 'Current block of the method total' });
  const progBox = labelBox('PROG', '%', { title: 'Progress through the current block' });
  const remBox = labelBox('REM', 'mL', { title: 'Volume remaining in the current block' });
  railBand.appendChild(blkBox.el);
  railBand.appendChild(progBox.el);
  railBand.appendChild(remBox.el);
  el.appendChild(railBand);

  /* -- 5. trend panel: a frame around ui/chart.js, which owns its own toolbar and pen rail -- */
  const trendPanel = mk('section', 'rv-panel rv-trend');
  trendPanel.setAttribute('aria-label', 'Chromatogram');
  trendPanel.setAttribute('tabindex', '-1');
  const chartHost = mk('div', 'rv-chart-host');
  trendPanel.appendChild(chartHost);
  el.appendChild(trendPanel);

  /* There is deliberately no sixth band. The FLOW / %B / P1 / dP / UV / COND / pH / CV strip that
     used to run along the bottom of this screen is gone: every one of those numbers already sits
     beside its instrument on the schematic above and on the trend's pen rail below, and the strip
     was charging the two panels that matter 24 px for the duplication. Run state and quality
     indication are the title bar's, next to the alarm summary. */

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
    if (chart) {
      chartlib.destroyChart(chart);
      chart = null;
      chartHost.textContent = '';
    }
    chart = chartlib.createChart(chartHost, {
      xAxis: { mode: xMode },
      overview: true,
      alarms: ctx.config.alarms,
    });
    boundStore = ctx.run.log;
    chartlib.setSource(chart, boundStore, X_CHANNELS, ctx.config);
    chartlib.attachInteractions(chart, {
      onZoom: onChartZoom,
      onSelect: onChartZoom,
      onPoolDrag: onChartPool,
    });
    annotationsDirty = true;
    applySelection();
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
    markers = [];
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
        markers.push({
          x: toX(ev.V_mL, ev.t_s), label: ev.message || m, kind: 'flag', severity: ev.severity,
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
      markers.push({
        x: toX(recs[i].endVolume_mL, recs[i].endTime_s), label: recs[i].port, kind: 'tick',
      });
    }
    evCursor = events.length;
    xMode = chart ? chart.xMode : xMode;
    if (chart) {
      chartlib.setBands(chart, bands);
      chartlib.setMarkers(chart, markers);
      chartlib.invalidate(chart, 'static');
    }
    annotationsDirty = false;
    lastBandExtend = -1e9;
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
   * alarm count.
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
   * Refresh the fraction strip: cell fills, per-cell state, the head lamp and the two label boxes.
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
    const k = ports.indexOf(run.frac.port);
    const pv = k >= 0 && run.portVolume_mL ? run.portVolume_mL[k] : run.wasteVolume_mL;
    const d = fmt.toDisplay('volume', pv, config);
    fracVolBox.setUnit(d.unit);
    fracVolBox.set(nfix(d.value, d.decimals), k >= 0 ? 'pv' : 'stale');
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
    for (let i = 0; i < openHandles.length; i++) overlaylib.dismiss(openHandles[i]);
    openHandles.length = 0;
    if (chart) { chartlib.destroyChart(chart); chart = null; }
    if (pid && typeof pid.destroy === 'function') pid.destroy();
    pid = null;
    boundStore = null;
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return { el, mount, update, destroy };
}
