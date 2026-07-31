/**
 * @file src/ui/hmi.js — the shared FT-CLASSIC widget kit.
 *
 * Every other module under `src/ui/` builds its chrome out of the eight factories exported here.
 * The house style is a classic Rockwell FactoryTalk View SE / Wonderware InTouch operator screen:
 * beveled grey panels, sunken near-black label boxes, round glassy lamps, ISA-5.1 instrument
 * bubbles and process symbols, and icon-only controls that carry their meaning in `title` /
 * `aria-label` rather than on their face.
 *
 * Three rules bind this file.
 *
 *  1. **Presentation only.** Nothing here imports anything — not `ctx`, not `sim`, not `format`,
 *     not even a sibling in `src/ui/`. A widget receives numbers and strings and returns DOM. It
 *     never reads `run`/`config` and it never mutates simulation state.
 *  2. **Tokens, not literals.** Every colour resolves through `var(--token)` out of
 *     `styles/tokens.css`, so the light (default) and dark themes both fall out of the same
 *     markup. The only literal in the stylesheet below is the white specular highlight on a lamp
 *     and the white glyph on the E-STOP button, both behind a `var(--x, fallback)` so the token
 *     file can still claim them later.
 *  3. **Allocation-free on the hot path.** `labelBox().set()` and `lamp().set()` run for ~20
 *     widgets every animation frame. Both compare against a cached value first and touch the DOM
 *     only when the rendered result actually changes.
 *
 * The kit ships its own stylesheet, injected once as the **first** child of `<head>` so that
 * `styles/app.css` — linked later in the document — wins every specificity tie and can restyle any
 * of it without `!important`.
 *
 * Stable hooks other modules may rely on (they are part of the contract, like the exports):
 *   `.hmi-raised` `.hmi-sunken`                                        bevel utilities
 *   `.hmi-panel` `.hmi-panel-hd` `.hmi-panel-bd`                       panel parts
 *   `.hmi-btn` `.hmi-btn--danger` `.hmi-icon`                          controls
 *   `.hmi-lb` `.hmi-lb-tag` `.hmi-lb-field` `.hmi-lb-val` `.hmi-lb-eu` label box parts
 *   `.hmi-lamp` `.hmi-lamp-body`                                       lamp parts
 *   `.hmi-isa` `.hmi-isa-ring` `.hmi-isa-fn` `.hmi-isa-loop`           bubble parts
 *   `.hmi-sym` `.hmi-sym--<kind>` `[data-part]`                        process symbol parts
 *
 * @module ui/hmi
 */

/* =================================================================================================
 * 0. PRIVATE CONSTANTS AND DOM HELPERS
 * ===============================================================================================*/

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Rendered in a label box when the value is not evaluable. Matches `ui/format.NO_VALUE`. */
const NO_VALUE = '—';

/** Monotonic counter behind the per-instance ids a few symbols need (clip paths). */
let uidSeq = 0;

/**
 * A document-unique id with a stable prefix.
 * @param {string} prefix
 * @returns {string}
 */
function uid(prefix) {
  uidSeq += 1;
  return `hmi-${prefix}-${uidSeq}`;
}

/**
 * Create an HTML element with a class.
 * @param {string} tag
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function h(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

/**
 * Create an SVG element with a class.
 * @param {string} tag
 * @param {string} [className]
 * @returns {SVGElement}
 */
function s(tag, className) {
  const el = document.createElementNS(SVG_NS, tag);
  if (className) el.setAttribute('class', className);
  return el;
}

/**
 * Set several attributes at once. Numbers are stringified by the DOM.
 * @param {Element} el
 * @param {Record<string, string|number>} attrs
 * @returns {Element}
 */
function attr(el, attrs) {
  for (const k in attrs) {
    if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, String(attrs[k]));
  }
  return el;
}

/**
 * Write an attribute only when it differs — the whole point of the hot-path widgets.
 * @param {Element} el
 * @param {string} name
 * @param {string} value
 */
function setAttrIfChanged(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * Append an SVG `<title>` child, which is how an icon or a symbol gets a native tooltip.
 * @param {SVGElement} el
 * @param {string} text
 */
function svgTitle(el, text) {
  const t = s('title');
  t.textContent = text;
  el.insertBefore(t, el.firstChild);
}

/* =================================================================================================
 * 1. THE KIT STYLESHEET
 * -------------------------------------------------------------------------------------------------
 * Injected once, as the first child of <head>, so styles/app.css always outranks it on a tie.
 * ===============================================================================================*/

const KIT_CSS = `
.hmi-panel,.hmi-panel-hd,.hmi-panel-bd,.hmi-btn,.hmi-lb,.hmi-lb-field,.hmi-lamp,.hmi-chip{
  box-sizing:border-box;border-radius:0;
}

/* -- bevel utilities ------------------------------------------------------------------------- */
.hmi-raised{
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
             inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh);
}
.hmi-sunken{
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
             inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt);
}

/* -- panel ----------------------------------------------------------------------------------- */
.hmi-panel{
  position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;
  background:var(--face);color:var(--ink);
  font-family:var(--font-ui,system-ui,"Segoe UI",Tahoma,sans-serif);
}
.hmi-panel-hd{
  flex:0 0 auto;display:flex;align-items:center;gap:6px;height:18px;padding:0 5px;
  background:var(--face-2);color:var(--ink-2);
  font:700 10px/1 var(--font-ui,system-ui,"Segoe UI",Tahoma,sans-serif);
  text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;
}
.hmi-panel-hd:empty{display:none;}
.hmi-panel-hd-title{margin-right:auto;}
.hmi-panel-bd{flex:1 1 auto;position:relative;min-width:0;min-height:0;padding:3px;}
.hmi-panel-bd[data-scroll="1"]{overflow:auto;}

/* -- icon ------------------------------------------------------------------------------------ */
.hmi-icon{display:block;flex:0 0 auto;pointer-events:none;}

/* -- icon button ----------------------------------------------------------------------------- */
.hmi-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:3px;
  width:34px;height:34px;padding:0;border:0;
  background:var(--face);color:var(--ink);
  font:700 11px/1 var(--font-ui,system-ui,"Segoe UI",Tahoma,sans-serif);
  font-variant-numeric:tabular-nums lining-nums;letter-spacing:.02em;
  cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;
}
.hmi-btn:hover:not(:disabled){background:var(--face-3);}
.hmi-btn:active:not(:disabled),.hmi-btn[aria-pressed="true"]:not(:disabled){
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
             inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt);
}
.hmi-btn:active:not(:disabled)>*,.hmi-btn[aria-pressed="true"]:not(:disabled)>*{
  transform:translate(1px,1px);
}
.hmi-btn:disabled{color:var(--ink-off);cursor:default;}
.hmi-btn:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-3px;}
.hmi-btn--danger{background:var(--lamp-alarm);color:var(--estop-ink);}
.hmi-btn--danger:hover:not(:disabled){background:var(--lamp-alarm);filter:brightness(1.12);}
.hmi-btn-txt{pointer-events:none;padding:0 4px;}

/* -- label box ------------------------------------------------------------------------------- */
.hmi-lb{
  display:inline-flex;flex-direction:column;gap:1px;min-width:0;
  font-family:var(--font-ui,system-ui,"Segoe UI",Tahoma,sans-serif);
}
.hmi-lb[data-layout="inline"]{flex-direction:row;align-items:center;gap:4px;}
.hmi-lb-tag{
  font:700 10px/1.1 var(--font-ui,system-ui,"Segoe UI",Tahoma,sans-serif);
  text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.hmi-lb-field{
  display:flex;align-items:baseline;justify-content:flex-end;gap:3px;
  padding:2px 3px;min-width:0;background:var(--fld-bg);
}
.hmi-lb-val{
  font:700 13px/1.2 var(--font-num,ui-monospace,Consolas,"Courier New",monospace);
  font-variant-numeric:tabular-nums lining-nums;
  color:var(--fld-pv);white-space:nowrap;
}
.hmi-lb-eu{
  font:600 10.4px/1 var(--font-num,ui-monospace,Consolas,"Courier New",monospace);
  color:var(--fld-eu);white-space:nowrap;
}
.hmi-lb[data-size="sm"] .hmi-lb-val{font-size:11px;}
.hmi-lb[data-size="sm"] .hmi-lb-eu{font-size:8.8px;}
.hmi-lb[data-size="lg"] .hmi-lb-val{font-size:16px;}
.hmi-lb[data-size="lg"] .hmi-lb-eu{font-size:12.8px;}
.hmi-lb[data-size="xl"] .hmi-lb-val{font-size:20px;}
.hmi-lb[data-size="xl"] .hmi-lb-eu{font-size:16px;}
.hmi-lb[data-kind="sp"] .hmi-lb-val{color:var(--fld-sp);}
.hmi-lb[data-kind="out"] .hmi-lb-val{color:var(--fld-out);}
.hmi-lb-field[data-q="SUSPECT"] .hmi-lb-val,
.hmi-lb-field[data-q="INVALID"] .hmi-lb-val,
.hmi-lb-field[data-empty="1"] .hmi-lb-val{color:var(--fld-stale);}
.hmi-lb-field[data-alarm="1"] .hmi-lb-val{color:var(--fld-alarm);}
.hmi-lb-field[data-blink="1"] .hmi-lb-val{animation:hmi-blink 900ms steps(1,end) infinite;}

/* -- lamp ------------------------------------------------------------------------------------ */
.hmi-lamp{display:inline-block;line-height:0;flex:0 0 auto;}
.hmi-lamp svg{display:block;overflow:visible;}
.hmi-lamp-body{fill:var(--lamp-off);}
.hmi-lamp-ring{fill:none;stroke:var(--bev-dk);stroke-width:1;}
.hmi-lamp-gloss{fill:var(--lamp-gloss,rgba(255,255,255,.55));stroke:none;}
.hmi-lamp[data-state="run"] .hmi-lamp-body{fill:var(--lamp-run);}
.hmi-lamp[data-state="warn"] .hmi-lamp-body{fill:var(--lamp-warn);}
.hmi-lamp[data-state="alarm"] .hmi-lamp-body{fill:var(--lamp-alarm);}
.hmi-lamp[data-blink="1"] .hmi-lamp-body{animation:hmi-blink 900ms steps(1,end) infinite;}

@keyframes hmi-blink{0%,55%{opacity:1;}56%,100%{opacity:.16;}}

/* -- ISA bubble ------------------------------------------------------------------------------ */
.hmi-isa-ring{fill:var(--bubble-fill,var(--face-3));stroke:var(--ink);stroke-width:1.25;}
.hmi-isa-line{stroke:var(--ink);stroke-width:1.25;fill:none;}
.hmi-isa-fn,.hmi-isa-loop{
  fill:var(--ink);stroke:none;text-anchor:middle;
  font-family:var(--font-ui,system-ui,"Segoe UI",Tahoma,sans-serif);font-weight:700;
}
.hmi-isa[data-alarm="1"] .hmi-isa-ring{stroke:var(--lamp-alarm);stroke-width:2;}
.hmi-isa[data-alarm="1"] .hmi-isa-fn,.hmi-isa[data-alarm="1"] .hmi-isa-loop{fill:var(--lamp-alarm);}

/* -- process symbols ------------------------------------------------------------------------- */
.hmi-sym{color:var(--ink);}
.hmi-sym-fill{fill:var(--face-3);}

@media (prefers-reduced-motion:reduce){
  .hmi-lb-field[data-blink="1"] .hmi-lb-val,
  .hmi-lamp[data-blink="1"] .hmi-lamp-body{animation:none;}
}
`;

let stylesInstalled = false;

/** Inject the kit stylesheet exactly once. Safe to call in a non-DOM environment. */
function ensureStyles() {
  if (stylesInstalled) return;
  if (typeof document === 'undefined' || !document.head) return;
  stylesInstalled = true;
  if (document.getElementById('hmi-kit-styles')) return;
  const style = document.createElement('style');
  style.id = 'hmi-kit-styles';
  style.textContent = KIT_CSS;
  document.head.insertBefore(style, document.head.firstChild);
}

ensureStyles();

/* =================================================================================================
 * 2. ICONS
 * -------------------------------------------------------------------------------------------------
 * One path-data table on a 24x24 grid. Every glyph is authored as a 1.75-weight stroke drawing with
 * round caps, or as a solid silhouette where a stroke would collapse at 16px (triangles, bars). No
 * interior detail smaller than ~2 grid units survives the 16px render, so there is none.
 *
 * Part encoding — a terse tuple so the table stays readable end to end:
 *   ['S', d, w?]                 stroked path            (w overrides the stroke width)
 *   ['F', d]                     filled path
 *   ['L', x1, y1, x2, y2, w?]    stroked line
 *   ['C', cx, cy, r, w?]         stroked circle
 *   ['D', cx, cy, r]             filled dot
 *   ['R', x, y, w, h]            stroked rect
 *   ['B', x, y, w, h]            filled rect
 * ===============================================================================================*/

/** @type {Record<string, Array<Array<string|number>>>} */
const ICONS = {
  /* -- run / method commands ----------------------------------------------------------------- */
  run: [['F', 'M7 4.5 20 12 7 19.5Z']],
  hold: [['C', 12, 12, 8.6], ['B', 9.3, 8.3, 1.9, 7.4], ['B', 12.8, 8.3, 1.9, 7.4]],
  continue: [['C', 12, 12, 8.6], ['F', 'M10 8.2 16.4 12 10 15.8Z']],
  skip: [['F', 'M5.5 5 14.8 12 5.5 19Z'], ['B', 16.4, 5, 2.4, 14]],
  stop: [['B', 6, 6, 12, 12]],
  estop: [['S', 'M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z'], ['D', 12, 12, 3.4]],
  reset: [['S', 'M12 4A8 8 0 1 1 5.1 8'], ['F', 'M11.8 1.6 15.2 4 11.8 6.4Z']],
  pause: [['B', 6.8, 4.8, 3.4, 14.4], ['B', 13.8, 4.8, 3.4, 14.4]],
  play: [['S', 'M8 5.2 18.2 12 8 18.8Z']],
  speed: [['F', 'M3.4 6 11 12 3.4 18Z'], ['F', 'M12.4 6 20 12 12.4 18Z']],

  /* -- alarms -------------------------------------------------------------------------------- */
  bell: [
    ['S', 'M18.2 16.2v-4.6a6.2 6.2 0 0 0-12.4 0v4.6L4 18.8h16z'],
    ['S', 'M10 21.2a2.4 2.4 0 0 0 4 0'],
  ],
  ack: [
    ['S', 'M16.4 12.6V9.4a4.6 4.6 0 0 0-9.2 0v3.2L5.6 14.6h12.4z'],
    ['S', 'M13.6 18.4 16.2 21l4.8-5.4', 2.1],
  ],

  /* -- screen navigation --------------------------------------------------------------------- */
  theme: [['C', 12, 12, 8.4], ['F', 'M12 3.6a8.4 8.4 0 0 1 0 16.8z']],
  pid: [['R', 13.5, 6.5, 7.5, 11], ['L', 2.5, 12, 7.2, 12], ['C', 9.8, 12, 2.6], ['L', 12.4, 12, 13.5, 12]],
  trend: [['S', 'M4 3.6v16.8h16.4'], ['S', 'M6.6 16.4 10 11.4 13 14 17.8 6.8']],
  method: [
    ['D', 5, 6.6, 1.5], ['L', 9, 6.6, 20, 6.6],
    ['D', 5, 12, 1.5], ['L', 9, 12, 20, 12],
    ['D', 5, 17.4, 1.5], ['L', 9, 17.4, 20, 17.4],
  ],
  results: [
    ['L', 3.8, 20.2, 20.2, 20.2],
    ['B', 6, 11, 3.6, 9.2], ['B', 11.2, 6.6, 3.6, 13.6], ['B', 16.4, 14, 3.6, 6.2],
  ],
  config: [
    ['C', 12, 12, 6.2], ['C', 12, 12, 2.5],
    ['L', 18.2, 12, 20.9, 12, 2], ['L', 16.38, 16.38, 18.29, 18.29, 2],
    ['L', 12, 18.2, 12, 20.9, 2], ['L', 7.62, 16.38, 5.71, 18.29, 2],
    ['L', 5.8, 12, 3.1, 12, 2], ['L', 7.62, 7.62, 5.71, 5.71, 2],
    ['L', 12, 5.8, 12, 3.1, 2], ['L', 16.38, 7.62, 18.29, 5.71, 2],
  ],
  export: [['L', 12, 3.4, 12, 14.6], ['S', 'M7.6 10.6 12 15 16.4 10.6'], ['S', 'M4.2 16.6v4h15.6v-4']],

  /* -- trend tools --------------------------------------------------------------------------- */
  zoomIn: [
    ['C', 10.2, 10.2, 6.4], ['L', 14.9, 14.9, 20.6, 20.6, 2],
    ['L', 10.2, 7.4, 10.2, 13], ['L', 7.4, 10.2, 13, 10.2],
  ],
  zoomOut: [['C', 10.2, 10.2, 6.4], ['L', 14.9, 14.9, 20.6, 20.6, 2], ['L', 7.4, 10.2, 13, 10.2]],
  fit: [['S', 'M4 9.2V4h5.2'], ['S', 'M14.8 4H20v5.2'], ['S', 'M20 14.8V20h-5.2'], ['S', 'M9.2 20H4v-5.2']],
  follow: [['L', 20, 4, 20, 20, 2.2], ['L', 3.6, 12, 15.4, 12], ['S', 'M12 8.4 15.6 12 12 15.6']],
  cursor: [['L', 12, 2.8, 12, 21.2], ['L', 2.8, 12, 21.2, 12], ['C', 12, 12, 4.2]],
  pool: [
    ['S', 'M3.6 16.6c3.2 0 2.6-9.6 8.4-9.6s4.8 9.6 8 9.6'],
    ['L', 6.8, 20, 17.2, 20], ['L', 6.8, 17.4, 6.8, 20], ['L', 17.2, 17.4, 17.2, 20],
  ],

  /* -- generic affordances ------------------------------------------------------------------- */
  chevronUp: [['S', 'M6.2 15.2 12 9.4 17.8 15.2']],
  chevronDown: [['S', 'M6.2 9.4 12 15.2 17.8 9.4']],
  chevronLeft: [['S', 'M15.2 6.2 9.4 12 15.2 17.8']],
  chevronRight: [['S', 'M8.8 6.2 14.6 12 8.8 17.8']],
  plus: [['L', 12, 4.8, 12, 19.2], ['L', 4.8, 12, 19.2, 12]],
  minus: [['L', 4.8, 12, 19.2, 12]],
  trash: [['L', 3.8, 6.8, 20.2, 6.8], ['S', 'M9.4 6.8V4.4h5.2v2.4'], ['S', 'M6.6 6.8 7.7 20.4h8.6L17.4 6.8']],
  copy: [['R', 8.4, 8.4, 11.8, 11.8], ['S', 'M15.6 4.4H4.4v11.2']],
  up: [['L', 12, 20, 12, 4.8], ['S', 'M6.4 10.4 12 4.8 17.6 10.4']],
  down: [['L', 12, 4, 12, 19.2], ['S', 'M6.4 13.6 12 19.2 17.6 13.6']],
  lock: [['R', 4.8, 10.6, 14.4, 9.4], ['S', 'M8.4 10.6V7.9a3.6 3.6 0 0 1 7.2 0v2.7']],
  unlock: [['R', 4.8, 10.6, 14.4, 9.4], ['S', 'M8.4 10.6V7.9a3.6 3.6 0 0 1 6.9-1.4']],

  /* -- process vocabulary -------------------------------------------------------------------- */
  wrench: [['S', 'M20.5 9.8A4.6 4.6 0 1 1 17 3.7', 2.4], ['L', 13.6, 11.4, 5.2, 19.2, 2.6]],
  flask: [
    ['S', 'M9.4 3.2v6.4L4.5 18.6a1.7 1.7 0 0 0 1.5 2.6h12a1.7 1.7 0 0 0 1.5-2.6L14.6 9.6V3.2'],
    ['L', 8.2, 3.2, 15.8, 3.2], ['L', 7, 14.4, 17, 14.4],
  ],
  drop: [['S', 'M12 3.2c4.1 4.9 6.2 7.9 6.2 10.6a6.2 6.2 0 1 1-12.4 0c0-2.7 2.1-5.7 6.2-10.6z']],
  thermo: [
    ['S', 'M10.1 14.4V5.4a1.9 1.9 0 0 1 3.8 0v9a4.2 4.2 0 1 1-3.8 0z'],
    ['D', 12, 17.6, 2.1], ['L', 15.4, 8.2, 17.6, 8.2], ['L', 15.4, 11.4, 17.6, 11.4],
  ],
  gauge: [['S', 'M4.2 17.4a7.8 7.8 0 0 1 15.6 0'], ['L', 12, 17.4, 16.4, 11.6, 2], ['D', 12, 17.4, 1.6]],
  valve: [
    ['F', 'M4 6.6 12 12 4 17.4Z'], ['F', 'M20 6.6 12 12 20 17.4Z'],
    ['L', 12, 12, 12, 6.4], ['L', 8.6, 5.6, 15.4, 5.6, 2.2],
  ],
  pump: [['C', 12, 12, 7.6], ['F', 'M9.6 8.2 16.2 12 9.6 15.8Z']],

  /* -- annunciation -------------------------------------------------------------------------- */
  warn: [['S', 'M12 4 21.2 20.2H2.8z'], ['L', 12, 10.2, 12, 14.6], ['D', 12, 17.4, 1.05]],
  info: [['C', 12, 12, 8.6], ['L', 12, 11.2, 12, 16.8], ['D', 12, 7.9, 1.05]],
  check: [['S', 'M4.6 12.6 9.8 17.8 19.4 6.6', 2]],
  cross: [['L', 6, 6, 18, 18], ['L', 18, 6, 6, 18]],

  /* -- convenience glyphs (not in the mandated list, but cheap and obvious) -------------------- */
  help: [['C', 12, 12, 8.6], ['S', 'M9.3 9.4a2.8 2.8 0 1 1 3.4 3.5v1.6'], ['D', 12.7, 17.4, 1.05]],
  clock: [['C', 12, 12, 8.6], ['S', 'M12 7.2V12l3.4 2.2']],
  eye: [['S', 'M2.6 12s3.6-6.4 9.4-6.4S21.4 12 21.4 12s-3.6 6.4-9.4 6.4S2.6 12 2.6 12z'], ['C', 12, 12, 2.9]],
  edit: [['S', 'M4.4 19.6 5.2 15.8 15.6 5.4l3 3L8.2 18.8z'], ['L', 14.4, 6.4, 17.6, 9.6]],
  save: [['S', 'M4.6 4.6h11.2l3.6 3.6v11.2H4.6z'], ['R', 8.4, 4.6, 7.2, 4.8], ['R', 7.4, 13, 9.2, 6.6]],
  dots: [['D', 5.4, 12, 1.5], ['D', 12, 12, 1.5], ['D', 18.6, 12, 1.5]],
  unknown: [['R', 4.5, 4.5, 15, 15], ['L', 4.5, 19.5, 19.5, 4.5]],
};

/**
 * Every icon name `icon()` will render. Frozen: the table is a contract, not a suggestion.
 * @type {ReadonlyArray<string>}
 */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** Names already reported as missing, so a bad name warns once rather than once per frame. */
const warnedIcons = new Set();

/**
 * Build one part of an icon from its tuple.
 * @param {Array<string|number>} part
 * @returns {SVGElement}
 */
function iconPart(part) {
  const kind = part[0];
  let el;
  switch (kind) {
    case 'S':
      el = s('path');
      attr(el, { d: String(part[1]) });
      if (part[2] !== undefined) attr(el, { 'stroke-width': Number(part[2]) });
      break;
    case 'F':
      el = s('path');
      attr(el, { d: String(part[1]), fill: 'currentColor', stroke: 'none' });
      break;
    case 'L':
      el = s('line');
      attr(el, { x1: Number(part[1]), y1: Number(part[2]), x2: Number(part[3]), y2: Number(part[4]) });
      if (part[5] !== undefined) attr(el, { 'stroke-width': Number(part[5]) });
      break;
    case 'C':
      el = s('circle');
      attr(el, { cx: Number(part[1]), cy: Number(part[2]), r: Number(part[3]) });
      if (part[4] !== undefined) attr(el, { 'stroke-width': Number(part[4]) });
      break;
    case 'D':
      el = s('circle');
      attr(el, { cx: Number(part[1]), cy: Number(part[2]), r: Number(part[3]), fill: 'currentColor', stroke: 'none' });
      break;
    case 'R':
      el = s('rect');
      attr(el, { x: Number(part[1]), y: Number(part[2]), width: Number(part[3]), height: Number(part[4]) });
      break;
    case 'B':
      el = s('rect');
      attr(el, {
        x: Number(part[1]), y: Number(part[2]), width: Number(part[3]), height: Number(part[4]),
        fill: 'currentColor', stroke: 'none',
      });
      break;
    default:
      el = s('g');
  }
  return el;
}

/**
 * Render an icon as a standalone `<svg>`.
 *
 * The glyph inherits `currentColor`, so it takes the colour of whatever it is dropped into — a
 * toolbar button, a table cell, a red E-STOP face. An unknown name renders the `unknown` glyph and
 * warns once instead of throwing, because a missing icon must never take a screen down.
 *
 * @param {string} name One of {@link ICON_NAMES}.
 * @param {{size?: number, title?: string, className?: string, strokeWidth?: number}} [opts]
 *   `size` is the rendered box in px (default 16). `title` makes the icon meaningful to assistive
 *   technology (`role="img"` + `<title>`); without it the icon is `aria-hidden`, which is what you
 *   want inside a labelled button.
 * @returns {SVGSVGElement} A detached `<svg class="hmi-icon">`.
 */
export function icon(name, opts) {
  const o = opts || {};
  const size = o.size === undefined ? 16 : o.size;
  let parts = ICONS[name];
  if (!parts) {
    if (!warnedIcons.has(name)) {
      warnedIcons.add(name);
      console.warn(`[hmi] unknown icon "${name}"`);
    }
    parts = ICONS.unknown;
  }

  const svg = /** @type {SVGSVGElement} */ (s('svg', o.className ? `hmi-icon ${o.className}` : 'hmi-icon'));
  attr(svg, {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': o.strokeWidth === undefined ? 1.75 : o.strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  });
  for (let i = 0; i < parts.length; i += 1) svg.appendChild(iconPart(parts[i]));

  if (o.title) {
    attr(svg, { role: 'img', 'aria-label': o.title });
    svgTitle(svg, o.title);
  } else {
    attr(svg, { 'aria-hidden': 'true' });
  }
  return svg;
}

/* =================================================================================================
 * 3. ISA-5.1 INSTRUMENT BUBBLE
 * ===============================================================================================*/

/**
 * Mounting conventions from ISA-5.1, expressed as the line (or lines) drawn across the bubble.
 * @type {Record<string, 'none'|'solid'|'double'|'dashed'>}
 */
const MOUNT_LINE = {
  field: 'none',        // no line — field mounted, accessible to the operator
  panel: 'solid',       // one solid line — primary location (the control room / this HMI)
  local: 'double',      // two solid lines — local panel, field mounted
  behind: 'dashed',     // dashed line — behind the panel, normally inaccessible
};

/**
 * Draw an ISA-5.1 instrument bubble: a circle carrying the function letters on the upper line and
 * the loop number on the lower, split by the mounting line.
 *
 * This is the identity of every tag on the P&ID — `FIC 101`, `PDT 101`, `AIC 101` — so it is drawn
 * to the standard proportions rather than to whatever looked nice: text is 52 % / 48 % of the
 * radius, and the mounting line spans the full diameter through the centre.
 *
 * @param {string} fnLetters Function letters, e.g. `'FIC'`, `'PDT'`, `'UV'`. Upper-cased on render.
 * @param {string|number} loopNo Loop number, e.g. `101`.
 * @param {{x?: number, y?: number, r?: number, mounted?: 'field'|'panel'|'local'|'behind',
 *          title?: string, className?: string, alarm?: boolean}} [opts]
 *   `x`/`y` place the centre in the parent's user space (default 0,0); `r` is the radius
 *   (default 17); `mounted` picks the ISA mounting line (default `'field'`).
 * @returns {SVGGElement} A detached `<g class="hmi-isa">` holding `.hmi-isa-ring`, an optional
 *   `.hmi-isa-line`, `.hmi-isa-fn` and `.hmi-isa-loop`.
 */
export function isaBubble(fnLetters, loopNo, opts) {
  const o = opts || {};
  const cx = o.x === undefined ? 0 : o.x;
  const cy = o.y === undefined ? 0 : o.y;
  const r = o.r === undefined ? 17 : o.r;
  const mount = MOUNT_LINE[o.mounted] || 'none';

  const g = /** @type {SVGGElement} */ (s('g', o.className ? `hmi-isa ${o.className}` : 'hmi-isa'));
  attr(g, { 'data-mounted': o.mounted || 'field' });
  if (o.alarm) attr(g, { 'data-alarm': '1' });

  const ring = s('circle', 'hmi-isa-ring');
  attr(ring, { cx, cy, r });
  g.appendChild(ring);

  if (mount === 'solid' || mount === 'dashed') {
    const line = s('line', 'hmi-isa-line');
    attr(line, { x1: cx - r, y1: cy, x2: cx + r, y2: cy });
    if (mount === 'dashed') attr(line, { 'stroke-dasharray': `${(r * 0.24).toFixed(2)} ${(r * 0.18).toFixed(2)}` });
    g.appendChild(line);
  } else if (mount === 'double') {
    const dy = r * 0.1;
    for (let i = -1; i <= 1; i += 2) {
      const line = s('line', 'hmi-isa-line');
      const half = Math.sqrt(Math.max(0, r * r - (dy * i) * (dy * i)));
      attr(line, { x1: cx - half, y1: cy + dy * i, x2: cx + half, y2: cy + dy * i });
      g.appendChild(line);
    }
  }

  const fn = s('text', 'hmi-isa-fn');
  attr(fn, { x: cx, y: cy - r * 0.15, 'font-size': (r * 0.52).toFixed(2) });
  fn.textContent = String(fnLetters).toUpperCase();
  g.appendChild(fn);

  const loop = s('text', 'hmi-isa-loop');
  attr(loop, { x: cx, y: cy + r * 0.53, 'font-size': (r * 0.48).toFixed(2) });
  loop.textContent = String(loopNo);
  g.appendChild(loop);

  if (o.title) svgTitle(g, o.title);
  return g;
}

/* =================================================================================================
 * 4. ISA PROCESS SYMBOLS
 * -------------------------------------------------------------------------------------------------
 * Each symbol is authored around a local origin (0,0) at its centre and is positioned, scaled and
 * rotated by the caller through `opts`. `SYMBOL_EXTENTS` publishes the local bounding box so the
 * P&ID can lay pipework out against real geometry instead of guessing.
 *
 * Convention inside a symbol:
 *   - outlines inherit `stroke: currentColor`, `fill: none` from the group;
 *   - a shape that must read solid sets `fill="currentColor" stroke="none"` itself;
 *   - anything the P&ID needs to animate or measure carries `data-part`.
 * ===============================================================================================*/

/**
 * Local bounding boxes, in the symbol's own user units before `scale`.
 * @type {Readonly<Record<string, {x: number, y: number, w: number, h: number}>>}
 */
export const SYMBOL_EXTENTS = Object.freeze({
  pump: { x: -17, y: -17, w: 34, h: 34 },
  valve2: { x: -19, y: -28, w: 38, h: 40 },
  valve3: { x: -19, y: -28, w: 38, h: 47 },
  valveN: { x: -24, y: -33, w: 48, h: 54 },
  tank: { x: -17, y: -20.5, w: 34, h: 41 },
  column: { x: -17, y: -36, w: 34, h: 72 },
  filter: { x: -15, y: -11, w: 30, h: 22 },
  mixer: { x: -19, y: -10, w: 38, h: 20 },
  airtrap: { x: -10, y: -23, w: 20, h: 37 },
  detector: { x: -17, y: -12, w: 34, h: 24 },
  collector: { x: -20, y: -23, w: 40, h: 34 },
  check: { x: -19, y: -12, w: 38, h: 24 },
});

/**
 * Every kind {@link isaSymbol} can draw.
 * @type {ReadonlyArray<string>}
 */
export const ISA_SYMBOL_KINDS = Object.freeze(Object.keys(SYMBOL_EXTENTS));

/** Shorthand: a stroked path with an optional `data-part`. */
function symPath(d, part, className) {
  const el = s('path', className);
  attr(el, { d });
  if (part) attr(el, { 'data-part': part });
  return el;
}

/** Shorthand: a filled path. */
function symFill(d, part) {
  const el = s('path');
  attr(el, { d, fill: 'currentColor', stroke: 'none' });
  if (part) attr(el, { 'data-part': part });
  return el;
}

/** Shorthand: a stroked line. */
function symLine(x1, y1, x2, y2, width) {
  const el = s('line');
  attr(el, { x1, y1, x2, y2 });
  if (width !== undefined) attr(el, { 'stroke-width': width });
  return el;
}

/** Shorthand: a stroked rect. */
function symRect(x, y, w, hgt, part) {
  const el = s('rect');
  attr(el, { x, y, width: w, height: hgt });
  if (part) attr(el, { 'data-part': part });
  return el;
}

/** The two apex-to-apex triangles every valve body is built from. */
function valveBody(g) {
  g.appendChild(symPath('M-18 -11 0 0 -18 11Z', 'body', 'hmi-sym-body'));
  g.appendChild(symPath('M18 -11 0 0 18 11Z', 'body', 'hmi-sym-body'));
}

/** Stem plus the rectangular actuator that makes a valve an *automated* valve. */
function valveActuator(g) {
  g.appendChild(symLine(0, 0, 0, -19));
  g.appendChild(symRect(-9, -27, 18, 8, 'actuator'));
}

/**
 * Draw a process symbol from the P&ID vocabulary.
 *
 * @param {'pump'|'valve2'|'valve3'|'valveN'|'tank'|'column'|'filter'|'mixer'|'airtrap'|'detector'
 *         |'collector'|'check'} kind
 * @param {{x?: number, y?: number, scale?: number, rotate?: number, flip?: boolean,
 *          title?: string, className?: string, id?: string}} [opts]
 *   `x`/`y` translate the local origin; `rotate` is degrees clockwise about it; `flip` mirrors on
 *   the vertical axis (a pump discharging left, a valve fed from the right).
 * @returns {SVGGElement} A detached `<g class="hmi-sym hmi-sym--<kind>">` carrying `data-w` /
 *   `data-h` (its local extent) so callers can lay out against it.
 */
export function isaSymbol(kind, opts) {
  const o = opts || {};
  const g = /** @type {SVGGElement} */ (s('g'));
  const known = Object.prototype.hasOwnProperty.call(SYMBOL_EXTENTS, kind);
  const k = known ? kind : 'filter';
  if (!known) console.warn(`[hmi] unknown ISA symbol "${kind}"`);

  attr(g, {
    class: o.className ? `hmi-sym hmi-sym--${k} ${o.className}` : `hmi-sym hmi-sym--${k}`,
    'data-sym': k,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.5,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  if (o.id) attr(g, { id: o.id });

  const ext = SYMBOL_EXTENTS[k];
  attr(g, { 'data-w': ext.w, 'data-h': ext.h });

  const tx = o.x === undefined ? 0 : o.x;
  const ty = o.y === undefined ? 0 : o.y;
  const sc = o.scale === undefined ? 1 : o.scale;
  const rot = o.rotate === undefined ? 0 : o.rotate;
  let transform = '';
  if (tx || ty) transform += `translate(${tx} ${ty})`;
  if (rot) transform += `${transform ? ' ' : ''}rotate(${rot})`;
  if (sc !== 1 || o.flip) transform += `${transform ? ' ' : ''}scale(${o.flip ? -sc : sc} ${sc})`;
  if (transform) attr(g, { transform });

  switch (k) {
    /* -- rotating equipment ------------------------------------------------------------------ */
    case 'pump': {
      const c = s('circle');
      attr(c, { cx: 0, cy: 0, r: 16 });
      attr(c, { 'data-part': 'body' });
      g.appendChild(c);
      g.appendChild(symFill('M-6.5 -8.5 10.5 0 -6.5 8.5Z', 'rotor'));
      break;
    }

    /* -- valves ------------------------------------------------------------------------------ */
    case 'valve2':
      valveBody(g);
      valveActuator(g);
      break;

    case 'valve3':
      valveBody(g);
      g.appendChild(symPath('M-11 18 0 0 11 18Z', 'body', 'hmi-sym-body'));
      valveActuator(g);
      break;

    case 'valveN': {
      const c = s('circle');
      attr(c, { cx: 0, cy: 0, r: 15, 'data-part': 'body' });
      g.appendChild(c);
      const ports = [0, 60, 120, 180, 240, 300];
      for (let i = 0; i < ports.length; i += 1) {
        const a = (ports[i] * Math.PI) / 180;
        g.appendChild(symLine(
          (15 * Math.cos(a)).toFixed(2), (15 * Math.sin(a)).toFixed(2),
          (23 * Math.cos(a)).toFixed(2), (23 * Math.sin(a)).toFixed(2),
        ));
      }
      const rotor = symLine(0, 0, 13, 0, 3);
      attr(rotor, { 'data-part': 'rotor' });
      g.appendChild(rotor);
      const hub = s('circle');
      attr(hub, { cx: 0, cy: 0, r: 3, fill: 'currentColor', stroke: 'none' });
      g.appendChild(hub);
      g.appendChild(symLine(0, -15, 0, -24));
      g.appendChild(symRect(-9, -32, 18, 8, 'actuator'));
      break;
    }

    /* -- vessels ----------------------------------------------------------------------------- */
    case 'tank': {
      const bodyD = 'M-16 -13A16 6.5 0 0 1 16 -13L16 13A16 6.5 0 0 1 -16 13Z';
      const clipId = uid('clip');
      const defs = s('defs');
      const clip = s('clipPath');
      attr(clip, { id: clipId });
      const clipShape = s('path');
      attr(clipShape, { d: bodyD });
      clip.appendChild(clipShape);
      defs.appendChild(clip);
      g.appendChild(defs);

      const level = s('rect', 'hmi-sym-level');
      attr(level, {
        x: -17, y: -20, width: 34, height: 40,
        'clip-path': `url(#${clipId})`, 'data-part': 'level', fill: 'none', stroke: 'none',
      });
      g.appendChild(level);

      g.appendChild(symPath(bodyD, 'body'));
      const rim = s('ellipse');
      attr(rim, { cx: 0, cy: -13, rx: 16, ry: 6.5, 'data-part': 'rim' });
      g.appendChild(rim);
      break;
    }

    case 'column':
      g.appendChild(symRect(-13, -30, 26, 60, 'body'));
      g.appendChild(symRect(-16.5, -35, 33, 5.5, 'flange-top'));
      g.appendChild(symRect(-16.5, 29.5, 33, 5.5, 'flange-bottom'));
      g.appendChild(symLine(-13, -24, 13, -24));
      g.appendChild(symLine(-13, 26, 13, 26));
      g.appendChild(symRect(-13, -24, 26, 50, 'bed'));
      /* The bed rect is a measurement target for the canvas overlay, never a drawn shape. */
      attr(g.lastChild, { fill: 'none', stroke: 'none', 'pointer-events': 'none' });
      break;

    /* -- inline devices ---------------------------------------------------------------------- */
    case 'filter':
      g.appendChild(symRect(-14, -10, 28, 20, 'body'));
      g.appendChild(symLine(-14, 10, 14, -10));
      break;

    case 'mixer':
      g.appendChild(symRect(-18, -9, 36, 18, 'body'));
      g.appendChild(symLine(-18, 9, -6, -9));
      g.appendChild(symLine(-6, 9, 6, -9));
      g.appendChild(symLine(6, 9, 18, -9));
      break;

    case 'airtrap':
      g.appendChild(symPath('M-9 -8A9 4 0 0 1 9 -8L9 10A9 4 0 0 1 -9 10Z', 'body'));
      g.appendChild(symLine(0, -12, 0, -19));
      g.appendChild(symFill('M-3.2 -17 3.2 -17 0 -22.4Z', 'vent'));
      {
        const b1 = s('circle');
        attr(b1, { cx: -3.4, cy: 0.5, r: 1.7 });
        g.appendChild(b1);
        const b2 = s('circle');
        attr(b2, { cx: 2.2, cy: -3.2, r: 1.2 });
        g.appendChild(b2);
      }
      break;

    case 'detector': {
      g.appendChild(symRect(-16, -11, 32, 22, 'body'));
      const lamp = s('circle');
      attr(lamp, { cx: -9, cy: 0, r: 3, fill: 'currentColor', stroke: 'none', 'data-part': 'lamp' });
      g.appendChild(lamp);
      const beam = symLine(-5, 0, 5.5, 0);
      attr(beam, { 'stroke-dasharray': '3 2.5', 'data-part': 'beam' });
      g.appendChild(beam);
      const plate = s('rect');
      attr(plate, { x: 6.5, y: -5, width: 4.5, height: 10, fill: 'currentColor', stroke: 'none' });
      g.appendChild(plate);
      break;
    }

    case 'collector': {
      g.appendChild(symLine(0, -22, 0, -13));
      const nozzle = s('circle');
      attr(nozzle, { cx: 0, cy: -11.2, r: 1.9, fill: 'currentColor', stroke: 'none', 'data-part': 'nozzle' });
      g.appendChild(nozzle);
      g.appendChild(symLine(-20, -9, 20, -9));
      const xs = [-13, 0, 13];
      for (let i = 0; i < xs.length; i += 1) {
        g.appendChild(symPath(
          `M${xs[i] - 4.5} -8V6a4.5 4.5 0 0 0 9 0V-8`,
          'tube',
        ));
      }
      break;
    }

    case 'check':
      valveBody(g);
      g.appendChild(symLine(2, -6, 2, 6, 2.4));
      break;

    default:
      break;
  }

  if (o.title) svgTitle(g, o.title);
  return g;
}

/* =================================================================================================
 * 5. LABEL BOX — the sunken numeric display
 * ===============================================================================================*/

/**
 * Format a value for a label box without regexes or intermediate allocations beyond the one
 * `toFixed` string. Negative zero is normalised, because `-0.0` on a process display is a bug.
 * @param {number|string|null|undefined} v
 * @param {number} decimals
 * @returns {string}
 */
function formatValue(v, decimals) {
  if (typeof v === 'string') return v;
  if (typeof v !== 'number' || !Number.isFinite(v)) return NO_VALUE;
  let out = v.toFixed(decimals);
  if (out.charCodeAt(0) === 45 && Number(out) === 0) out = out.slice(1);
  return out;
}

/**
 * Build the workhorse of this design: a tag caption over (or beside) a sunken near-black field
 * holding right-aligned tabular digits and a smaller, dimmer engineering-unit suffix.
 *
 * `set()` is written for the animation frame. It bails on an unchanged value *and* on a changed
 * value that renders to the same string (1.234 → 1.237 at one decimal), so a screen full of boxes
 * costs a handful of comparisons per frame rather than a hundred DOM writes.
 *
 * @param {{tag?: string, eu?: string, decimals?: number, width?: number|string,
 *          kind?: 'pv'|'sp'|'out', title?: string, layout?: 'stack'|'inline',
 *          size?: 'sm'|'md'|'lg'|'xl', className?: string}} opts
 *   `tag` is the ISA tag name shown in 10px caps; `eu` the engineering unit; `decimals` the fixed
 *   decimal count (default 1); `kind` picks the digit colour — PV lime, SP amber, OUT cyan;
 *   `width` sizes the field (number = px).
 * @returns {{el: HTMLElement, set: (value: number|string|null|undefined,
 *            opts2?: {quality?: 'OK'|'SUSPECT'|'INVALID', alarm?: boolean, blink?: boolean}) => void}}
 *   `el` is the wrapper; `set` writes the value and its state.
 */
export function labelBox(opts) {
  ensureStyles();
  const o = opts || {};
  const decimals = o.decimals === undefined ? 1 : o.decimals;

  const el = h('div', o.className ? `hmi-lb ${o.className}` : 'hmi-lb');
  el.dataset.kind = o.kind || 'pv';
  el.dataset.layout = o.layout || 'stack';
  if (o.size) el.dataset.size = o.size;
  if (o.title) el.title = o.title;

  if (o.tag) {
    const tag = h('span', 'hmi-lb-tag');
    tag.textContent = o.tag;
    el.appendChild(tag);
  }

  const field = h('span', 'hmi-lb-field hmi-sunken');
  if (o.width !== undefined) {
    const w = typeof o.width === 'number' ? `${o.width}px` : o.width;
    field.style.width = w;
    field.style.minWidth = w;
  }
  const val = h('span', 'hmi-lb-val');
  val.textContent = NO_VALUE;
  field.appendChild(val);
  if (o.eu) {
    const eu = h('span', 'hmi-lb-eu');
    eu.textContent = o.eu;
    field.appendChild(eu);
  }
  el.appendChild(field);

  /* Hot-path cache. `lastValue` starts as a sentinel no caller can pass. */
  let lastValue = Symbol('unset');
  let lastText = NO_VALUE;
  let lastQ = 'OK';
  let lastAlarm = false;
  let lastBlink = false;
  let lastEmpty = true;
  field.dataset.empty = '1';

  /**
   * Write the value and its quality/alarm state. Idempotent and allocation-light.
   * @param {number|string|null|undefined} value
   * @param {{quality?: 'OK'|'SUSPECT'|'INVALID', alarm?: boolean, blink?: boolean}} [opts2]
   */
  function set(value, opts2) {
    const q = (opts2 && opts2.quality) || 'OK';
    const alarm = !!(opts2 && opts2.alarm);
    const blink = !!(opts2 && opts2.blink);

    if (Object.is(value, lastValue) && q === lastQ && alarm === lastAlarm && blink === lastBlink) return;
    lastValue = value;

    const text = formatValue(value, decimals);
    if (text !== lastText) {
      lastText = text;
      val.textContent = text;
      const empty = text === NO_VALUE;
      if (empty !== lastEmpty) {
        lastEmpty = empty;
        setAttrIfChanged(field, 'data-empty', empty ? '1' : '0');
      }
    }
    if (q !== lastQ) {
      lastQ = q;
      setAttrIfChanged(field, 'data-q', q);
    }
    if (alarm !== lastAlarm) {
      lastAlarm = alarm;
      setAttrIfChanged(field, 'data-alarm', alarm ? '1' : '0');
    }
    if (blink !== lastBlink) {
      lastBlink = blink;
      setAttrIfChanged(field, 'data-blink', blink ? '1' : '0');
    }
  }

  return { el, set };
}

/* =================================================================================================
 * 6. STATUS LAMP
 * ===============================================================================================*/

/** The only states a lamp understands. Anything else falls back to `off`. */
const LAMP_STATES = { off: 1, run: 1, warn: 1, alarm: 1 };

/**
 * Build a round glassy status lamp: a filled disc, a dark ring, and a specular highlight arc at the
 * top left. Drawn as SVG rather than a gradient so it stays crisp at any size and any zoom.
 *
 * @param {{size?: number, title?: string, label?: string, state?: 'off'|'run'|'warn'|'alarm',
 *          className?: string}} [opts]
 *   `size` is the diameter in px (default 12). Give `label` when the lamp carries meaning on its
 *   own — it becomes `role="img"` and its `aria-label` tracks the state. Without one the lamp is
 *   `aria-hidden`, which is right when an adjacent label box already says what it means.
 * @returns {{el: HTMLElement, set: (state: 'off'|'run'|'warn'|'alarm', blink?: boolean) => void}}
 */
export function lamp(opts) {
  ensureStyles();
  const o = opts || {};
  const size = o.size === undefined ? 12 : o.size;

  const el = h('span', o.className ? `hmi-lamp ${o.className}` : 'hmi-lamp');
  if (o.title) el.title = o.title;
  if (o.label) {
    attr(el, { role: 'img', 'aria-label': `${o.label} off` });
  } else {
    attr(el, { 'aria-hidden': 'true' });
  }

  const svg = s('svg');
  attr(svg, { viewBox: '0 0 16 16', width: size, height: size, focusable: 'false', 'aria-hidden': 'true' });

  const body = s('circle', 'hmi-lamp-body');
  attr(body, { cx: 8, cy: 8, r: 6.4 });
  svg.appendChild(body);

  const ring = s('circle', 'hmi-lamp-ring');
  attr(ring, { cx: 8, cy: 8, r: 6.4 });
  svg.appendChild(ring);

  const gloss = s('ellipse', 'hmi-lamp-gloss');
  attr(gloss, { cx: 5.9, cy: 5.6, rx: 2.5, ry: 1.4, transform: 'rotate(-38 5.9 5.6)' });
  svg.appendChild(gloss);

  el.appendChild(svg);

  let lastState = 'off';
  let lastBlink = false;
  el.dataset.state = 'off';

  /**
   * Set the lamp state. Idempotent: repeating the current state touches nothing.
   * @param {'off'|'run'|'warn'|'alarm'} state
   * @param {boolean} [blink] Blink the lamp (suppressed under `prefers-reduced-motion`).
   */
  function set(state, blink) {
    const st = LAMP_STATES[state] ? state : 'off';
    const bl = !!blink;
    if (st === lastState && bl === lastBlink) return;
    if (st !== lastState) {
      lastState = st;
      el.dataset.state = st;
      if (o.label) setAttrIfChanged(el, 'aria-label', `${o.label} ${st}`);
    }
    if (bl !== lastBlink) {
      lastBlink = bl;
      setAttrIfChanged(el, 'data-blink', bl ? '1' : '0');
    }
  }

  return { el, set };
}

/* =================================================================================================
 * 7. BEVEL UTILITY
 * ===============================================================================================*/

/**
 * Apply the house bevel to an element. This is the only sanctioned way to get an edge: never write
 * an ad-hoc `border` in this application.
 *
 * @param {HTMLElement} el
 * @param {'raised'|'sunken'|'flat'} [kind='raised'] `'flat'` removes both classes.
 * @returns {HTMLElement} The same element, for chaining.
 */
export function bevel(el, kind) {
  const k = kind || 'raised';
  el.classList.toggle('hmi-raised', k === 'raised');
  el.classList.toggle('hmi-sunken', k === 'sunken');
  return el;
}

/* =================================================================================================
 * 8. ICON BUTTON
 * ===============================================================================================*/

/**
 * Build a beveled icon-only button — the toolbar's entire vocabulary.
 *
 * The face never carries a word: meaning lives in `title` (the hover tooltip) and `ariaLabel` (the
 * accessible name). Pressing swaps the bevel to sunken and nudges the glyph 1px down-right, exactly
 * like the physical panel buttons this imitates. The one concession is `opts.text`, for the speed
 * chips, which are numerals rather than prose.
 *
 * @param {string|null} name Icon name from {@link ICON_NAMES}, or `null` when using `opts.text`.
 * @param {{title?: string, ariaLabel?: string, onClick?: (ev: MouseEvent, pressed: boolean) => void,
 *          toggle?: boolean, pressed?: boolean, size?: number, iconSize?: number, text?: string,
 *          danger?: boolean, disabled?: boolean, className?: string, id?: string}} [opts]
 *   `toggle` makes the button a latching control reported through `aria-pressed`.
 * @returns {HTMLButtonElement} A detached button. It carries a `setPressed(bool)` method for
 *   toggles, so a toolbar can reflect state without re-querying the DOM.
 */
export function iconButton(name, opts) {
  ensureStyles();
  const o = opts || {};
  const btn = /** @type {HTMLButtonElement} */ (h('button', 'hmi-btn hmi-raised'));
  btn.type = 'button';
  if (o.className) btn.classList.add(...o.className.split(/\s+/).filter(Boolean));
  if (o.danger) btn.classList.add('hmi-btn--danger');
  if (o.id) btn.id = o.id;

  const size = o.size === undefined ? 34 : o.size;
  btn.style.width = `${size}px`;
  btn.style.height = `${size}px`;

  if (o.title) btn.title = o.title;
  btn.setAttribute('aria-label', o.ariaLabel || o.title || o.text || String(name || 'button'));

  if (name) btn.appendChild(icon(name, { size: o.iconSize === undefined ? 16 : o.iconSize }));
  if (o.text) {
    const txt = h('span', 'hmi-btn-txt');
    txt.textContent = o.text;
    btn.appendChild(txt);
    if (o.size === undefined) btn.style.width = 'auto';
  }

  if (o.disabled) btn.disabled = true;

  let pressed = !!o.pressed;
  if (o.toggle || o.pressed !== undefined) btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');

  /**
   * Reflect latched state without a click.
   * @param {boolean} next
   */
  btn.setPressed = function setPressed(next) {
    const v = !!next;
    if (v === pressed) return;
    pressed = v;
    setAttrIfChanged(btn, 'aria-pressed', v ? 'true' : 'false');
  };

  btn.addEventListener('click', (ev) => {
    if (btn.disabled) return;
    if (o.toggle) {
      pressed = !pressed;
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
    if (o.onClick) o.onClick(ev, pressed);
  });

  return btn;
}

/* =================================================================================================
 * 9. PANEL
 * ===============================================================================================*/

/**
 * Build a raised panel: the grey slab everything else sits on.
 *
 * The header is created unconditionally but collapses through `:empty` when there is no title and
 * nothing has been appended to it, so a caller can add tool buttons to a bare panel later and have
 * the strip appear on its own.
 *
 * @param {string} [titleText] Optional 10px caps caption. Also becomes the panel's accessible name.
 * @param {{className?: string, scroll?: boolean, pad?: number|false, id?: string,
 *          role?: string}} [opts]
 *   `scroll` makes the body scrollable; `pad` overrides the 3px body padding (`false` = none).
 * @returns {{el: HTMLElement, body: HTMLElement, header: HTMLElement}}
 *   `el` is the panel, `body` the content area, `header` the caption strip (append tool buttons to
 *   it — they float right of the title).
 */
export function panel(titleText, opts) {
  ensureStyles();
  const o = opts || {};
  const el = h('div', o.className ? `hmi-panel hmi-raised ${o.className}` : 'hmi-panel hmi-raised');
  if (o.id) el.id = o.id;
  el.setAttribute('role', o.role || 'group');
  if (titleText) el.setAttribute('aria-label', titleText);

  const header = h('div', 'hmi-panel-hd');
  if (titleText) {
    const t = h('span', 'hmi-panel-hd-title');
    t.textContent = titleText;
    header.appendChild(t);
  }
  el.appendChild(header);

  const body = h('div', 'hmi-panel-bd');
  if (o.scroll) body.dataset.scroll = '1';
  if (o.pad === false) body.style.padding = '0';
  else if (typeof o.pad === 'number') body.style.padding = `${o.pad}px`;
  el.appendChild(body);

  return { el, body, header };
}
