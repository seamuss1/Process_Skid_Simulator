/**
 * @file src/ui/chart.js
 * The HMI-2012 process trend: a three-layer canvas plot well, a legend rail of ISA tags and
 * value fields, and a slim history strip — styled as a Wonderware InTouch 2012 / FactoryTalk
 * View SE 7 / Ignition 7 operator trend rather than as a web chart.
 *
 * THE SKIN. Depth is a 1px border plus a subtle vertical gradient, never a hard bevel: the
 * plot well and every value field use the SUNKEN recipe, the toolbar and the rail use the
 * RAISED one, 2 px of radius on panels, buttons, fields and chips, 3 px on the well. Digits
 * are WHITE for a PV and amber for an SP on a recessed near-black field — the single change
 * that separates a 2012 screen from a 1996 one. The graticule is a low-contrast cool grey,
 * axis furniture is `--edge`, axis labels are `--ink-2`, and saturated colour is spent only
 * on the pens, on state and on alarms.
 *
 * WHY PV-VERSUS-SP IS THE WHOLE DESIGN
 * Every pen is a pair. The process variable is a SOLID 1.5 px stroke; its setpoint is the
 * SAME HUE, DASHED 5-4, at 1 px. FIC-101 (flow) and AIC-101 (%B) are true closed loops.
 * UV-101, CE-101, AE-101 and TT-101 are bare measurements and show a PV field only. The rail
 * never invents a setpoint.
 *
 * A SETPOINT IS NOT AN ALARM LIMIT, AND THE RAIL MUST NOT PRETEND OTHERWISE
 * A setpoint is a control TARGET the operator may move; an alarm limit is a protection
 * THRESHOLD he may not. This rail used to print `LIM 1.60` in the SP field of PT-101 and
 * PDT-101, which invites exactly the wrong assumption at 3 am — that the number is something
 * the loop is driving towards. It does not any more:
 *   - the SP column carries ONLY a real control setpoint, and is EMPTY for a tag that has
 *     none. It is never reused and never borrowed;
 *   - a LIMIT column of its own carries the ISA designation ({@link LIMIT_CODES} — HI, HH,
 *     LO, LL), the threshold, its unit and its ALARM STATE (normal, in alarm, acknowledged);
 *   - a setpoint is amber, the colour of a target. A limit is `--warn-ink` at rest and
 *     `--alarm-ink` once the PV is through it, the colours of a protection threshold;
 *   - on the plot the limit line is likewise NOT the pen's own hue on the setpoint's 5-4
 *     dash. It is warn/alarm ink on a DASH-DOT of its own, captioned in full — `PT-101 HI
 *     1.60 bar` — so it can be confused with neither the PV it guards nor any controller SP.
 *
 * WHICH PENS ARE LIT ON ARRIVAL. Pressure is the safety-critical variable on a column skid,
 * so PT-101 carries the default view together with its trip limit; UV-101 is the product
 * signal and FIC-101 is the loop the operator drives. AIC-101 and CE-101 stay dark on
 * arrival — five pens on three gutters is a readable screen, seven is not — and every one of
 * them is a single click away in the rail.
 *
 * A setpoint is a HELD value, so it is stroked as a STAIRCASE — horizontal run, vertical
 * jump — in every mode and at every zoom level. A measurement is interpolated between
 * samples; a command is not, and zoom must never turn an instantaneous step into a ramp.
 *
 * LAYERS (each `cssW*dpr x cssH*dpr`, context scaled by `dpr`)
 *   1. static  — graphite well, cool-grey graticule, phase bands, fraction ticks, pooled
 *                region, peak flags, axis furniture.
 *   2. traces  — PV and SP pens, min/max decimated to at most two vertices per device
 *                pixel column, with the append-only blit fast path at the live edge.
 *   3. overlay — alarm limit lines, live edge, crosshair, drag rectangle; every frame.
 *
 * Decimation bins on the X-CHANNEL VALUE, never the row index: the log is uniform in TIME,
 * not in volume, so index binning makes retention volume unreadable in the `volume` and
 * `cv` x-modes. One shared `pixelStart` boundary table serves every trace. A full repaint
 * happens on zoom, theme change, pen toggle, any y-bound change, and unconditionally every
 * 2000 frames as a drift guard.
 *
 * SIZING. The backing store is sized from an EXPLICIT measurement on mount, from the
 * `ResizeObserver`, on `visibilitychange`, and again from `frame` whenever the plot is
 * still degenerate. A `ResizeObserver` does not fire in a background tab, so a page that
 * loaded hidden used to sit at a 1x1 backing store forever; measuring on mount and
 * re-measuring from `frame` is what makes that impossible.
 *
 * This module mutates neither `config` nor `run`. It reads a `ChannelStore` and a handful
 * of caller-supplied annotations, and it never schedules a frame of its own — `ui/app.js`
 * owns the single rAF loop and calls {@link frame}.
 */

import { NUMERIC_CHANNELS, column, xIndexRange, decimateMinMax } from '../core/log.js';
import { h, setText, setAttr, cls } from './format.js';
import { glossaryFor } from '../data/glossary.js';

/* -------------------------------------------------------------------------- */
/* 0. CONSTANTS                                                               */
/* -------------------------------------------------------------------------- */

/** Frames between unconditional full repaints — the blit drift guard. */
const DRIFT_GUARD_FRAMES = 2000;
/** Decimate/autoscale re-measure period, ms. */
const MEASURE_PERIOD_MS = 250;
/** Legend rail refresh period, ms. The rail is DOM; 10 Hz is plenty and costs nothing. */
const RAIL_PERIOD_MS = 100;
/** Re-measure period for a degenerate plot rectangle, ms. */
const REMEASURE_PERIOD_MS = 250;
/** Axis shrink ease duration, ms. */
const SHRINK_EASE_MS = 4000;
/** Hysteresis band below which a shrink is not started. */
const SHRINK_HYSTERESIS = 0.2;
/** Top / bottom headroom on an autoscaled axis. */
const HEADROOM_TOP = 0.08;
const HEADROOM_BOTTOM = 0.04;
/** Nested right-hand axis gutter width, css px. Wide enough for a whole ISA tag. */
const RIGHT_AXIS_STEP = 46;
/** Left-hand axis gutter width, css px, when a left axis is in use. */
const LEFT_AXIS_W = 48;
/** Line height of the axis ownership caption block, css px. */
const AXIS_LABEL_LINE = 10;
/** Tag lines a single gutter may print before it collapses the rest into `+N`. */
const AXIS_TAG_LINES_MAX = 2;
/** Live edge sits at this fraction of the plot width while following. */
const LIVE_EDGE_FRAC = 0.85;
/** Below this samples-per-pixel the decimator is bypassed and raw points are drawn. */
const RAW_SPP = 1.5;
/** History strip height, css px. */
const OVERVIEW_H = 26;
/** aria-live announcement throttle, ms. */
const ARIA_PERIOD_MS = 400;
/** Nice-number mantissa ladder for axis bounds. */
const NICE_LADDER = [1, 2, 2.5, 5, 10];
/** Finer ladder for the auto-fit window span, so growth still happens in rungs. */
const SPAN_LADDER = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
/** The SP dash signature. Binding: 5 on, 4 off, 1 px wide. Setpoints only. */
const SP_DASH = [5, 4];
/**
 * The ALARM LIMIT signature: dash-DOT, never the setpoint's plain 5-4 dash. A protection
 * threshold and a control target must not share a stroke, because they do not share a
 * meaning — and the operator reads the plot before he reads any caption.
 */
const LIMIT_DASH = [7, 3, 2, 3];
/** One period of {@link LIMIT_DASH}, for the phase-stable dash offset. */
const LIMIT_DASH_PERIOD = 15;
/** Limit line width, css px, at rest and while the PV is through the threshold. */
const LIMIT_WIDTH = 1;
const LIMIT_WIDTH_ALARM = 2;
/** PV stroke width, css px. Binding: solid 1.5 px. */
const PV_WIDTH = 1.5;
/** SP stroke width, css px. */
const SP_WIDTH = 1;
/** Shared empty dash array, so `setLineDash` never allocates on the hot path. */
const EMPTY_DASH = [];
/** Crosshair dash. */
const CROSS_DASH = [2, 3];
/** Marker dash. */
const MARKER_DASH = [3, 3];
/** SVG namespace, for the icon builder. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Log channels that carry a COMMANDED value: the controller is told a number and holds it
 * until it is told another one. Nothing happens between two consecutive samples of such a
 * channel, so it is drawn as a staircase at EVERY zoom level — a step that becomes a ramp
 * when the operator zooms in is a lie about what the controller did. Every SP trace is
 * held by construction; this set catches the same channels when a caller points a PV pen
 * straight at one.
 */
const HELD_CHANNELS = new Set(['flow_setpoint_mL_min', 'pctB_setpoint']);

/** Focusable controls inside the legend rail, in DOM order. */
const RAIL_FOCUSABLE = 'input,button,select,textarea,a[href],[tabindex]';

/**
 * The four ISA-18.2 limit designations the rail can print. `HI` is the first high threshold
 * an operator is expected to act on and `HH` the high-high one that trips; `LO` and `LL` are
 * their falling twins. The designation is DERIVED from the alarm row that supplied the
 * threshold — its comparison sense and its severity — never guessed from the value.
 */
const LIMIT_CODES = Object.freeze({ HI: 'HI', HH: 'HH', LO: 'LO', LL: 'LL' });

/** Alarm severities that mean TRIP, and so designate `HH`/`LL` rather than `HI`/`LO`. */
const TRIP_SEVERITIES = new Set(['CRITICAL', 'FAULT']);

/**
 * The three alarm states a limit field can show, and the word each one prints. Colour alone
 * never carries this: a state an operator cannot read is a state he cannot hand over.
 */
const LIMIT_STATE_WORD = Object.freeze({ norm: 'NORM', alarm: 'ALM', ack: 'ACK' });

/** The same three states spelled out for the screen reader and the tooltip. */
const LIMIT_STATE_SAID = Object.freeze({
  norm: 'normal',
  alarm: 'in alarm, unacknowledged',
  ack: 'in alarm, acknowledged',
});

/** Default x-channel names per x-mode. */
const XCH_DEFAULT = Object.freeze({ volume: 'V_mL', time: 't_s', cv: 'V_CV' });

/** Engineering unit of each x-mode. Time is logged in seconds and displayed in minutes. */
const X_EU = Object.freeze({ volume: 'mL', time: 'min', cv: 'CV' });

/**
 * The default y-axis stack. Axes are labelled by ENGINEERING UNIT only — an operator
 * trend never carries a sentence. `pct` is the fixed context axis: %B 0–100 is its primary
 * scale and pH 0–14 its `alt` scale, an exact affine remap, so both read off one gutter.
 */
const DEFAULT_Y_AXES = Object.freeze([
  { id: 'uv', eu: 'mAU', side: 'left', mode: 'auto-sticky', min: 0, max: 100 },
  { id: 'cond', eu: 'mS/cm', side: 'right', mode: 'auto-sticky', min: 0, max: 10 },
  { id: 'pct', eu: '%', side: 'right', mode: 'manual', min: 0, max: 100, alt: { eu: 'pH', min: 0, max: 14 } },
  // A closed loop gets a BANDED axis, not a zero-anchored one: FIC-101 running 190 against
  // a 196 setpoint is two pixels of deviation on a 0–250 scale and unreadable. Banding is
  // what makes the PV/SP pair do its job.
  { id: 'flow', eu: 'mL/min', side: 'right', mode: 'auto-band', min: 0, max: 10 },
  // Pressure is zero-anchored and sticky, and the autoscaler folds PT-101's trip limit into
  // its range, so the pen and the line it must not cross share one gutter at a readable
  // scale from the first sample. This is the axis the default view is built around.
  { id: 'press', eu: 'bar', side: 'right', mode: 'auto-sticky', min: 0, max: 2 },
  { id: 'temp', eu: 'C', side: 'right', mode: 'auto-sticky', min: 0, max: 40 },
]);

/**
 * The eight default pens, in rail order. `sp` names a real log channel and fills the SP
 * column; `limitSignal` names an `ALARM_TABLE` signal whose threshold fills the separate
 * LIMIT column and draws the limit line. The two are different columns because they are
 * different kinds of number — a pen may carry either, or neither.
 */
const DEFAULT_PENS = Object.freeze([
  {
    id: 'uv', tag: 'UV-101', channel: 'UV_280_mAU', sp: null, eu: 'mAU', dec: 1,
    axis: 'uv', penVar: '--pen-uv', gloss: 'UV-101', visible: true,
  },
  {
    id: 'flow', tag: 'FIC-101', channel: 'flow_mL_min', sp: 'flow_setpoint_mL_min',
    eu: 'mL/min', dec: 1, axis: 'flow', penVar: '--pen-flow', gloss: 'FT-101', visible: true,
  },
  {
    id: 'pctb', tag: 'AIC-101', channel: 'pctB_column_inlet', sp: 'pctB_setpoint',
    eu: '%', dec: 1, axis: 'pct', penVar: '--pen-pctb', gloss: 'pctB', visible: false, fill: 0.1,
  },
  {
    id: 'cond', tag: 'CE-101', channel: 'cond_mS_cm', sp: null, eu: 'mS/cm', dec: 2,
    axis: 'cond', penVar: '--pen-cond', gloss: 'CE-101', visible: false,
  },
  {
    id: 'press', tag: 'PT-101', channel: 'P1_bar', sp: null, limitSignal: 'P1', eu: 'bar',
    dec: 2, axis: 'press', penVar: '--pen-press', gloss: 'PT-101', visible: true,
  },
  {
    id: 'dp', tag: 'PDT-101', channel: 'dP_bar', sp: null, limitSignal: 'DP', eu: 'bar',
    dec: 2, axis: 'press', penVar: '--pen-dp', gloss: 'PDT-101', visible: false,
  },
  {
    id: 'ph', tag: 'AE-101', channel: 'pH', sp: null, eu: 'pH', dec: 2,
    axis: 'pct', alt: true, penVar: '--pen-ph', gloss: 'AE-101', visible: false,
  },
  {
    id: 'temp', tag: 'TT-101', channel: 'temp_fluid_C', sp: null, eu: 'C', dec: 1,
    axis: 'temp', penVar: '--pen-temp', gloss: 'TT-101', visible: false,
  },
]);

/**
 * Pen-token fallbacks, used when `styles/tokens.css` has not defined them.
 *
 * WHY LITERALS EXIST AT ALL IN THIS FILE. `ctx.fillStyle` cannot resolve `var()`, so every
 * canvas painter needs a resolved string; {@link readTokens} reads the real token off the
 * document element and only reaches these tables when the palette does not define the name.
 * They are the module's ONLY colour literals, they are dead the moment `styles/tokens.css`
 * declares the token, and nothing outside these four tables hard-codes a colour.
 *
 * A trend is the one place saturated colour earns its keep, because the operator tells the
 * pens apart by hue — but the hues are the HMI-2012 ones, NOT the CRT set this file used to
 * carry. Every value below is a byte-for-byte copy of the GRAPHITE block of
 * `styles/tokens.css`, so a build that somehow renders before the palette lands paints the
 * same muted pens it will paint a frame later, instead of flashing lime on graphite.
 * Ten entries: `--pen-uv2` and `--pen-uv3` are here for the results chromatogram's pens.
 */
const FALLBACK_PEN = Object.freeze({
  '--pen-flow': '#4FC3F7',
  '--pen-pctb': '#CE93D8',
  '--pen-press': '#FFB74D',
  '--pen-uv': '#66BB6A',
  '--pen-uv2': '#9CCC65',
  '--pen-uv3': '#26A69A',
  '--pen-cond': '#FF8A65',
  '--pen-ph': '#B39DDB',
  '--pen-temp': '#E8ECF0',
  '--pen-dp': '#F06292',
});

/**
 * Rotating pen palette for a caller-supplied pen whose token resolves to nothing. Same ten
 * hues, ordered so adjacent pens never share a family.
 */
const PEN_CYCLE = Object.freeze([
  '#66BB6A', '#4FC3F7', '#CE93D8', '#FFB74D', '#FF8A65',
  '#B39DDB', '#E8ECF0', '#F06292', '#9CCC65', '#26A69A',
]);

/**
 * Value-field, state and service tokens the CANVAS resolves. Theme-independent by design: a
 * recessed field reads the same in a lit control room and a dark one, and so must an alarm.
 * Only tokens a painter actually asks for appear here — the rest of the field palette is
 * consumed by the stylesheet through `var()`, where a JS fallback could not help anyway.
 */
const FIXED_TOKENS = Object.freeze({
  '--fld-sp': '#FFC24B',
  '--fld-stale': '#6B7681',
  '--warn': '#FFB300',
  '--alarm': '#E53935',
  // The two INK variants, for warn/alarm text and hairlines drawn ON the plot well rather
  // than for a filled state chip. They are read live off the active theme like every other
  // entry here, so the light palette's darker pair reaches the pale well correctly.
  '--warn-ink': '#FFC24B',
  '--alarm-ink': '#FF6B63',
  '--svc-a': '#4A7FB5',
  '--svc-b': '#8267AD',
  '--svc-sample': '#B58141',
  '--svc-cip': '#3F9E8C',
});

/**
 * The cool-graphite chrome. HMI-2012 is ONE palette, so both theme entries below point at
 * this single set; the pair survives because {@link exportPNG} still takes a theme and
 * {@link readTokens} may only read the ACTIVE theme's values off the document element.
 */
const GRAPHITE = Object.freeze({
  '--panel': '#2B3138',
  '--panel-hi': '#333A42',
  '--panel-lo': '#1B1F24',
  '--edge': '#454E58',
  '--edge-soft': '#383F47',
  '--ink': '#E8ECF0',
  '--ink-2': '#9AA5B1',
  '--ink-3': '#6B7681',
  '--accent': '#3D9BE9',
});

/** Chrome tokens per theme, used when `styles/tokens.css` has not loaded. */
const FALLBACK_CHROME = Object.freeze({ light: GRAPHITE, dark: GRAPHITE });

/** Every custom property the canvas painters resolve, read once per theme change. */
const TOKEN_NAMES = Object.freeze(
  Object.keys(FIXED_TOKENS)
    .concat(Object.keys(FALLBACK_CHROME.light))
    .concat(Object.keys(FALLBACK_PEN))
);

/**
 * Phase-band tints, keyed on BOTH the raw block type and the short kind slug a caller may
 * already have collapsed it to, so a band set built either way tints identically. Each entry
 * names a SERVICE colour in the resolved map rather than an rgba literal: the band is
 * painted through `globalAlpha`, so the tint follows the palette's desaturated service hues
 * instead of shadowing them with a second, stale copy.
 */
const BAND_TINT = Object.freeze({
  LOAD: 'svcSample', load: 'svcSample',
  WASH: 'svcA', wash: 'svcA',
  ELUTION_ISOCRATIC: 'svcB',
  ELUTION_LINEAR: 'svcB',
  ELUTION_STEP: 'svcB',
  elute: 'svcB',
  STRIP: 'svcCip', CIP: 'svcCip', strip: 'svcCip',
});

/** Phase-band tint strength over the graphite well. */
const BAND_TINT_ALPHA = 0.13;
/**
 * Alternating band wash strengths, so consecutive blocks are separable without colour. Kept
 * very faint: every wash is additive over the well, and the graticule must survive it.
 */
const BAND_WASH_A = 0.022;
const BAND_WASH_B = 0.042;
/** Pooled-region wash strength; its edges are drawn solid in the SP amber. */
const POOL_FILL_ALPHA = 0.13;
/** Selection wash strength — the zoom rectangle and the history strip's window brush. */
const SELECT_FILL_ALPHA = 0.16;

/** name -> { unit, decimals } for every fixed numeric log channel. */
const CHANNEL_META = (() => {
  const m = new Map();
  for (let i = 0; i < NUMERIC_CHANNELS.length; i++) {
    const row = NUMERIC_CHANNELS[i];
    m.set(row[0], { unit: row[1], decimals: row[3] });
  }
  return m;
})();

/**
 * Canvas font stacks, mirroring `--font-ui` and `--font-num`. `ctx.font` is a CSS font
 * shorthand and cannot resolve `var()`, so the stacks are repeated here. System fonts only —
 * the trend never waits on a web font to paint an axis.
 */
const FONT_UI = '"Segoe UI", Roboto, system-ui, -apple-system, Arial, sans-serif';
const FONT_NUM = '"Roboto Mono", Consolas, ui-monospace, "Cascadia Mono", Menlo, monospace';

/* -------------------------------------------------------------------------- */
/* 1. SMALL NUMERIC HELPERS                                                   */
/* -------------------------------------------------------------------------- */

/**
 * First index with `x[i] >= target` over `x[0..n)`. Local copy so the hot decimation loop
 * never crosses a module boundary and stays monomorphic.
 * @param {Float32Array} x Monotone non-decreasing channel.
 * @param {number} n Valid sample count.
 * @param {number} target Search value, x-channel unit.
 * @returns {number} Index in [0, n].
 */
function lowerBoundF32(x, n, target) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (x[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Clamp helper (chart-local; `ui/*` may not import `core/util.js`).
 * @param {number} v Value.
 * @param {number} lo Lower bound.
 * @param {number} hi Upper bound.
 * @returns {number} Clamped value.
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Snap a positive magnitude up onto a mantissa ladder.
 * @param {number} v Positive magnitude.
 * @param {number[]} ladder Ascending mantissa ladder ending in 10.
 * @returns {number} The smallest ladder rung >= `v`.
 */
function ladderCeil(v, ladder) {
  if (!(v > 0) || !isFinite(v)) return 1;
  const e = Math.floor(Math.log10(v));
  const p = Math.pow(10, e);
  const f = v / p;
  for (let i = 0; i < ladder.length; i++) {
    if (f <= ladder[i] * (1 + 1e-9)) return ladder[i] * p;
  }
  return 10 * p;
}

/**
 * Nice tick step for an axis span.
 * @param {number} raw Raw step estimate, axis unit.
 * @returns {number} Step on the 1/2/2.5/5x10^n ladder.
 */
function niceStep(raw) {
  return ladderCeil(raw, NICE_LADDER);
}

/**
 * Fixed decimal count implied by a tick step, so digits never change width.
 * @param {number} step Tick step.
 * @returns {number} Decimals, 0..6.
 */
function decimalsFor(step) {
  if (!(step > 0) || !isFinite(step)) return 0;
  const e = Math.floor(Math.log10(step) + 1e-9);
  let d = e < 0 ? -e : 0;
  const scaled = step * Math.pow(10, d);
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) d += 1;
  return Math.min(6, d);
}

/**
 * Format a value for a label box: fixed decimals, or the classic dash when absent.
 * @param {number} v Value.
 * @param {number} dec Decimals.
 * @returns {string} Digits, or `'----'`.
 */
function fmtBox(v, dec) {
  return v === v && isFinite(v) ? v.toFixed(dec) : '----';
}

/* -------------------------------------------------------------------------- */
/* 2. TOKENS AND COLOURS                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The theme the document is currently showing.
 *
 * GRAPHITE is the default, because `styles/tokens.css` block 1 is `:root, [data-theme="dark"]`
 * and no rule in that file is scoped to `prefers-color-scheme` — so with the attribute absent
 * the chrome is graphite whatever the workstation is set to, and the painters must agree.
 * `activeTheme()` in ui/format.js resolves the same way.
 * @returns {'dark'|'light'} Active theme name.
 */
function activeTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

/**
 * Read every token the painters need off the document element. Called once per theme
 * change, never per frame: reading custom properties inside a frame is a layout-thrash
 * trap. Values absent from `styles/tokens.css` fall back to the HMI-2012 constants above.
 * @param {'dark'|'light'|'current'} theme Theme to resolve.
 * @returns {object} `{ theme, <token>: value, ... }`.
 */
function readTokens(theme) {
  const name = theme === 'current' || theme === undefined ? activeTheme() : theme;
  const live = name === activeTheme();
  const chrome = FALLBACK_CHROME[name] || FALLBACK_CHROME.light;
  const out = { theme: name };
  let cs = null;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch (err) {
    cs = null;
  }
  for (let i = 0; i < TOKEN_NAMES.length; i++) {
    const key = TOKEN_NAMES[i];
    const fb = FIXED_TOKENS[key] !== undefined
      ? FIXED_TOKENS[key]
      : chrome[key] !== undefined ? chrome[key] : FALLBACK_PEN[key];
    // Chrome tokens differ per theme, so only the ACTIVE theme may be read live. Pens and
    // field colours are theme-independent and are read live whichever theme is asked for.
    const readable = cs && (live || chrome[key] === undefined);
    let v = '';
    if (readable) v = cs.getPropertyValue(key).trim();
    out[key] = v.length > 0 ? v : fb;
  }
  return out;
}

/**
 * Resolve the full colour map for one theme, including a stroke colour per pen.
 *
 * The three plot roles are DERIVED from the palette rather than given their own tokens, so
 * the well can never drift away from the panels around it: the well is `--panel-lo`, the
 * graticule is `--edge-soft` (a low-contrast cool grey, not a green CRT phosphor), the axis
 * furniture — spines, frame, tick marks — is `--edge`, and every axis LABEL is `--ink-2`.
 * @param {'dark'|'light'|'current'} theme Theme to resolve.
 * @param {Array<object>} pens Pen list, for the per-pen tokens.
 * @returns {object} Colour map with a `pen[id]` stroke table.
 */
function resolveColors(theme, pens) {
  const t = readTokens(theme);
  const c = {
    theme: t.theme,
    panel: t['--panel'],
    panelHi: t['--panel-hi'],
    edge: t['--edge'],
    ink: t['--ink'],
    ink2: t['--ink-2'],
    ink3: t['--ink-3'],
    accent: t['--accent'],
    plotBg: t['--panel-lo'],
    plotGrid: t['--edge-soft'],
    plotFrame: t['--edge'],
    plotAxis: t['--ink-2'],
    fldSp: t['--fld-sp'],
    fldStale: t['--fld-stale'],
    warn: t['--warn'],
    alarm: t['--alarm'],
    warnInk: t['--warn-ink'],
    alarmInk: t['--alarm-ink'],
    svcA: t['--svc-a'],
    svcB: t['--svc-b'],
    svcSample: t['--svc-sample'],
    svcCip: t['--svc-cip'],
    pen: Object.create(null),
  };
  for (let i = 0; i < pens.length; i++) {
    const p = pens[i];
    let v = t[p.penVar];
    if (!v) {
      // A caller-supplied token this build does not define: resolve it live, then fall
      // back onto the rotating pen palette so no pen is ever invisible.
      try {
        v = getComputedStyle(document.documentElement).getPropertyValue(p.penVar).trim();
      } catch (err) {
        v = '';
      }
      if (!v) v = PEN_CYCLE[i % PEN_CYCLE.length];
    }
    c.pen[p.id] = v;
  }
  return c;
}

/* -------------------------------------------------------------------------- */
/* 3. STYLES                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * THE DEPTH RECIPE. Three declarations, applied nowhere else and never hand-rolled — and each
 * one is now assembled entirely from the surface/border/elevation triples that
 * `styles/tokens.css` §2 publishes, rather than from hand-rolled gradients and rgba opacities.
 * That matters beyond tidiness: the black and white alphas this used to carry were tuned for
 * graphite, so on STEEL a `rgba(0,0,0,.5)` inner shadow read as a smudge and a
 * `rgba(255,255,255,.06)` highlight vanished. `--shade*` and `--spec*` invert with the theme;
 * the literals could not. There is no colour literal left in this stylesheet.
 */
const RAISED =
  'background:var(--surface-raised);border:var(--border-edge);' +
  'box-shadow:var(--elev-raised)';
const PRESSED =
  'background:var(--surface-pressed);border:var(--border-edge);' +
  'box-shadow:var(--elev-pressed)';
const SUNKEN =
  'background:var(--fld-bg);border:var(--border-field);' +
  'box-shadow:var(--elev-sunken)';
/** The focus ring, identical on every focusable control in the trend. */
const FOCUS = 'outline:2px solid var(--accent);outline-offset:-2px';

/**
 * THE PEN RAIL'S NUMERIC GRID, declared once and consumed by both the sticky column header
 * and every row, so PV sits under PV, SP under SP and LIMIT under LIMIT down the whole rail
 * whatever each row happens to carry. `fr` rather than `px` because the rail may shrink on a
 * narrow host: the three columns then compress together instead of one of them clipping.
 *
 * The tracks are sized from their WORST CASE, not their typical one, and the ratios below are
 * a measured budget rather than a guess: 41 px buys the six monospace digits of `2500.0` mAU,
 * 10 px a two-letter caption, 20 px a four-character unit, 24 px the widest state word, plus
 * the padding and the internal gaps. LIMIT is the widest track because `HH 1.60 bar ALM` is
 * the whole point of the column, and abbreviating it back into ambiguity would undo the fix.
 */
const RAIL_COLS = 'minmax(0,50fr) minmax(0,62fr) minmax(0,110fr)';

const CHART_CSS = `
.ftx{position:relative;display:flex;flex-direction:column;width:100%;height:100%;
  min-height:150px;min-width:420px;background:var(--panel);color:var(--ink);
  font-family:var(--font-ui);user-select:none;overflow:hidden;
  --ftx-rail-cols:${RAIL_COLS}}
.ftx *{box-sizing:border-box}
.ftx__bar{flex:0 0 auto;display:flex;align-items:center;gap:3px;height:28px;padding:0 4px;
  background:var(--surface-raised);
  border-bottom:1px solid var(--edge)}
.ftx__grp{display:flex;align-items:center;gap:3px}
.ftx__sep{flex:0 0 auto;width:1px;height:16px;margin:0 4px;background:var(--edge-soft)}
.ftx__sp{flex:1 1 auto}
/* Width tracks --ctl-lg because styles/app.css names .ftx__btn in its own button group and
   sets min-width on it; agreeing with that metric is cheaper than fighting it. */
.ftx__btn{flex:0 0 auto;width:var(--ctl-lg);height:22px;padding:0;display:inline-flex;
  align-items:center;justify-content:center;border-radius:2px;color:var(--ink-2);
  cursor:pointer;transition:color var(--dur-2,100ms) linear;${RAISED}}
.ftx__btn:hover{color:var(--ink)}
.ftx__btn:focus-visible{${FOCUS}}
.ftx__btn:active{color:var(--ink);${PRESSED}}
.ftx__btn[aria-pressed="true"]{color:var(--accent);${PRESSED}}
.ftx__btn[disabled]{color:var(--ink-3);cursor:default}
.ftx__btn svg{display:block;width:14px;height:14px;fill:none;stroke:currentColor;
  stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.ftx__btn svg [fill]{stroke:none}
.ftx__body{flex:1 1 auto;display:flex;min-height:0;min-width:0;gap:4px;padding:4px}
/* The well and the history strip take the SUNKEN recipe but fill with --panel-lo rather than
   --fld-bg: they are recessed workspace, not value fields, and the canvas paints the same
   --panel-lo underneath so the two can never disagree at the rounded corners. 3px radius. */
.ftx__well{position:relative;flex:1 1 auto;min-width:120px;min-height:70px;
  border-radius:var(--r-plot);
  background:var(--panel-lo);border:var(--border-field);
  box-shadow:var(--elev-sunken);cursor:crosshair;outline:none}
.ftx__well:focus-visible{${FOCUS}}
.ftx__well--pan{cursor:grab}
.ftx__well--panning{cursor:grabbing}
.ftx__well--pool{cursor:col-resize}
.ftx__host{position:absolute;inset:3px}
.ftx__layer{position:absolute;inset:0;width:100%;height:100%;display:block}
.ftx__layer--s{z-index:1}
.ftx__layer--t{z-index:2}
.ftx__layer--o{z-index:3;touch-action:none}
/* THE PEN RAIL. Wide enough for three labelled numeric columns and a real line-style sample,
   because everything above it is unreadable without them. The column header SCROLLS WITH the
   rows inside one scroller and sticks to its top: a header in a separate box would sit one
   scrollbar-width wider than the rows beneath it and put every caption a few pixels off its
   own column, which is the alignment complaint this rail was rebuilt to answer. */
/* 292 px by design, and it may give back four of them and no more: 288 is the MEASURED width
   at which the widest reading — six monospace digits — still fits every one of the three
   columns. Below that a number would start to clip, and a clipped number on an operator
   screen is worse than no number, so the rail stops shrinking and the well gives instead. */
.ftx__rail{flex:0 1 auto;width:292px;min-width:288px;display:flex;flex-direction:column;
  min-height:0;border-radius:2px;overflow:hidden;${RAISED}}
.ftx__rows{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}
.ftx__railhd{position:sticky;top:0;z-index:2;display:grid;
  grid-template-columns:30px minmax(0,1fr) 14px;gap:3px 5px;align-items:center;padding:4px 5px;
  font-size:10px;font-weight:600;line-height:1.2;letter-spacing:.02em;text-transform:uppercase;
  color:var(--ink-2);background:var(--surface-raised);
  border-bottom:1px solid var(--edge)}
.ftx__railhd em{grid-column:1;grid-row:1;font-style:normal;font-size:9px;color:var(--ink-3)}
.ftx__railhd b{grid-column:2;grid-row:1;display:flex;justify-content:space-between;gap:6px;
  font-weight:600}
.ftx__railhd b span:last-child{color:var(--ink-3)}
.ftx__railhd i{grid-column:2/4;grid-row:2;display:grid;
  grid-template-columns:var(--ftx-rail-cols);gap:3px;font-style:normal}
.ftx__railhd i span{padding:0 4px;text-align:right;white-space:nowrap;overflow:hidden}
/* SP is a target and LIMIT is a threshold, so the two captions do not even share an ink. */
.ftx__railhd i span.sp{color:var(--fld-sp)}
.ftx__railhd i span.lim{text-align:left;color:var(--warn-ink)}
.ftx__rowbox{display:block}
.ftx__row{display:grid;grid-template-columns:30px minmax(0,1fr) 14px;gap:3px 5px;
  align-items:center;padding:4px 5px;border-bottom:1px solid var(--edge-soft)}
.ftx__row--focus{background:var(--accent-soft)}
.ftx__row--off .ftx__tag,.ftx__row--off .ftx__eu{color:var(--ink-3)}
.ftx__row--off .ftx__chip{opacity:.4}
/* THE PEN SAMPLE. Sixteen pixels of tinted chip identified nothing; this is a real specimen
   of every stroke the pen puts on the plot — solid PV, 5-4 dashed SP, dash-dot LIMIT — at the
   same three heights in every row, so a line on the trend can be named from the rail. */
.ftx__chip{grid-column:1;grid-row:1/3;align-self:center;position:relative;width:30px;
  height:24px;border-radius:2px;overflow:hidden;background:var(--fld-bg);
  border:1px solid var(--fld-edge)}
.ftx__chip i{position:absolute;left:3px;right:3px;display:block;font-style:normal}
.ftx__chip i.pv{top:5px;height:2px;background:currentColor}
.ftx__chip i.sp{top:11px;height:1px;
  background:repeating-linear-gradient(90deg,currentColor 0 5px,transparent 5px 9px)}
.ftx__chip i.lim{top:16px;height:1px;background:repeating-linear-gradient(90deg,
  var(--warn-ink) 0 7px,transparent 7px 10px,var(--warn-ink) 10px 12px,transparent 12px 15px)}
.ftx__row--alm .ftx__chip i.lim{background:repeating-linear-gradient(90deg,
  var(--alarm-ink) 0 7px,transparent 7px 10px,var(--alarm-ink) 10px 12px,transparent 12px 15px)}
.ftx__hd{grid-column:2;grid-row:1;display:flex;align-items:baseline;gap:6px;min-width:0}
.ftx__tag{flex:1 1 auto;min-width:0;font-size:11px;font-weight:600;letter-spacing:.02em;
  color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:help}
/* Every row states its engineering unit, once, beside its tag: it governs the PV, the SP and
   the limit alike, and one statement per row is what keeps the three numeric columns pure. */
.ftx__eu{flex:0 0 auto;font:400 10px/1.3 var(--font-ui);letter-spacing:.02em;
  color:var(--ink-2);white-space:nowrap}
.ftx__cb{grid-column:3;grid-row:1;appearance:none;-webkit-appearance:none;margin:0;
  width:13px;height:13px;position:relative;border-radius:2px;cursor:pointer;${SUNKEN}}
.ftx__cb:checked::after{content:'';position:absolute;left:2px;top:2px;width:7px;height:7px;
  border-radius:1px;background:currentColor}
/* The one focus ring that sits OUTSIDE its control: a 2px inset ring on a 13px checkbox
   would cover the tick it exists to reveal. Same width, same accent. */
.ftx__cb:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.ftx__flds{grid-column:2/4;grid-row:2;display:grid;
  grid-template-columns:var(--ftx-rail-cols);gap:3px;min-width:0}
.ftx__fld{min-width:0;display:flex;align-items:baseline;gap:2px;padding:2px 3px;
  border-radius:2px;overflow:hidden;
  font:500 12px/1.35 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  letter-spacing:.01em;${SUNKEN}}
/* Explicit tracks, so a tag with no setpoint leaves the SP cell EMPTY rather than letting the
   limit slide left into it. An empty column is the honest answer; a borrowed one is not. */
.ftx__fld--pv{grid-column:1}
.ftx__fld--sp{grid-column:2}
.ftx__fld--lim{grid-column:3}
.ftx__fld em{flex:0 0 auto;font-style:normal;font-size:9px;font-weight:600;
  letter-spacing:.02em;color:var(--ink-3)}
/* An absent caption or unit must not spend a flex gap: the digits need every pixel. */
.ftx__fld em:empty,.ftx__fld u:empty,.ftx__fld s:empty{display:none}
.ftx__fld b{flex:1 1 auto;min-width:0;font-weight:500;text-align:right;overflow:hidden;
  white-space:nowrap;color:var(--fld-pv)}
.ftx__fld u{flex:0 0 auto;text-decoration:none;font-size:9px;font-weight:400;
  letter-spacing:.02em;white-space:nowrap;color:var(--ink-3)}
.ftx__fld s{flex:0 0 auto;text-decoration:none;font:700 8.5px/1 var(--font-ui);
  letter-spacing:.02em;white-space:nowrap;color:var(--ink-3)}
.ftx__fld--sp b{color:var(--fld-sp)}
.ftx__fld--sp em{color:var(--fld-sp)}
.ftx__fld--x b{color:var(--fld-out)}
.ftx__fld--alarm b{color:var(--fld-alarm)}
.ftx__fld--stale b{color:var(--fld-stale)}
/* THE LIMIT CELL. A protection threshold, not a target: warn ink at rest, alarm ink and a
   tinted field once the PV is through it. It is a button because a limit in alarm can be
   ACKNOWLEDGED here, and it is disabled — and so skipped by the rail's keyboard walk —
   whenever there is nothing to acknowledge. */
.ftx__fld--lim{appearance:none;-webkit-appearance:none;margin:0;text-align:left;
  cursor:pointer;color:inherit}
.ftx__fld--lim em,.ftx__fld--lim b,.ftx__fld--lim u{color:var(--warn-ink)}
.ftx__fld--lim[disabled]{cursor:default}
.ftx__fld--lim:focus-visible{${FOCUS}}
.ftx__fld--lim.is-alm{border-color:var(--alarm);
  background-image:linear-gradient(var(--alarm-soft),var(--alarm-soft))}
.ftx__fld--lim.is-alm em,.ftx__fld--lim.is-alm b,.ftx__fld--lim.is-alm u,
.ftx__fld--lim.is-alm s{color:var(--alarm-ink)}
.ftx__fld--lim.is-ack{border-color:var(--warn);
  background-image:linear-gradient(var(--warn-soft),var(--warn-soft))}
.ftx__fld--lim.is-ack em,.ftx__fld--lim.is-ack b,.ftx__fld--lim.is-ack u{color:var(--alarm-ink)}
.ftx__fld--lim.is-ack s{color:var(--warn-ink)}
/* An unacknowledged alarm blinks its state word and nothing else — the digits stay readable. */
@keyframes ftx-blink{0%,49%{opacity:1}50%,100%{opacity:.2}}
.ftx__fld--lim.is-alm s{animation:ftx-blink 1.1s steps(1,end) infinite}
.ftx__card{position:absolute;top:0;left:0;z-index:4;display:none;padding:3px;gap:3px;
  border-radius:2px;pointer-events:none;${RAISED}}
.ftx__card--on{display:flex}
.ftx__card .ftx__fld{flex:0 0 auto;min-width:64px}
.ftx__ov{flex:0 0 auto;position:relative;height:${OVERVIEW_H}px;margin:0 4px 4px 4px;
  border-radius:var(--r-2);background:var(--panel-lo);border:var(--border-field);
  box-shadow:var(--elev-sunken);cursor:ew-resize}
.ftx__ovhost{position:absolute;inset:2px}
.ftx__ovhost canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.ftx__table{display:none;flex:0 0 auto;max-height:172px;overflow:auto;margin:0 4px 4px 4px;
  border-radius:2px;${SUNKEN}}
.ftx__table--on{display:block}
.ftx__table table{border-collapse:collapse;width:100%}
.ftx__table th,.ftx__table td{padding:2px 7px;text-align:right;white-space:nowrap;
  font:400 11px/1.4 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  color:var(--fld-pv)}
.ftx__table th{position:sticky;top:0;z-index:1;color:var(--ink-2);
  background:var(--surface-raised);
  font:600 10px/1.6 var(--font-ui);letter-spacing:.02em;text-transform:uppercase;
  border-bottom:1px solid var(--edge)}
.ftx__table th small{display:block;font-size:9px;font-weight:400;color:var(--ink-3)}
.ftx__table td:first-child,.ftx__table th:first-child{text-align:left;color:var(--fld-out)}
.ftx__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){.ftx__btn{transition:none}
  .ftx__fld--lim.is-alm s{animation:none}}
`;

/**
 * Inject the chart stylesheet once. `styles/app.css` belongs to another owner, so the trend
 * carries its own scoped rules and consumes the HMI-2012 tokens through `var()`. No colour
 * literal appears above: the CSS side resolves every hue from `styles/tokens.css`, and only
 * the canvas painters — which cannot resolve `var()` — keep a fallback table.
 * @returns {void}
 */
function ensureStyles() {
  if (document.getElementById('ftx-css')) return;
  const st = document.createElement('style');
  st.id = 'ftx-css';
  st.textContent = CHART_CSS;
  document.head.appendChild(st);
}

/* -------------------------------------------------------------------------- */
/* 4. ICONS                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build one inline SVG icon. Every icon is authored here: no icon font, no CDN.
 * @param {Array<object>} parts Element descriptors; `tag` defaults to `'path'`, every
 *   other key becomes an attribute.
 * @returns {SVGElement} A 14x14 icon on a 16x16 grid.
 */
function svgIcon(parts) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const el = document.createElementNS(SVG_NS, p.tag || 'path');
    const keys = Object.keys(p);
    for (let k = 0; k < keys.length; k++) {
      if (keys[k] !== 'tag') el.setAttribute(keys[k], p[keys[k]]);
    }
    svg.appendChild(el);
  }
  return svg;
}

/** X axis in volume: a graduated cylinder. */
const ICON_VOL = [{ d: 'M5 2h6v9.5a3 3 0 0 1-6 0Z' }, { d: 'M5 7h6M5 9.5h6' }];
/** X axis in time: a clock. */
const ICON_TIME = [{ tag: 'circle', cx: '8', cy: '8', r: '5.5' }, { d: 'M8 4.5V8l2.5 1.5' }];
/** X axis in column volumes: a packed column with a downward flow arrow. */
const ICON_CV = [
  { d: 'M5 2h6v12H5z' }, { d: 'M5 5h6M5 11h6' }, { d: 'M8 6.5v3M6.5 8.5 8 10l1.5-1.5' },
];
/** Jump to the live edge. */
const ICON_LIVE = [{ d: 'M3 3v10l7-5z', fill: 'currentColor' }, { d: 'M12.5 3v10' }];
/** Reset the view: fit everything. */
const ICON_FIT = [{ d: 'M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4' }];
/** Y autoscale. */
const ICON_YAUTO = [{ d: 'M3 2v12h11' }, { d: 'M6 11 9 6l2 3 2.5-4' }];
/** The accessible data table. */
const ICON_TABLE = [{ d: 'M2 3h12v10H2z' }, { d: 'M2 6.5h12M6.5 3v10' }];

/* -------------------------------------------------------------------------- */
/* 5. GEOMETRY AND SIZING                                                     */
/* -------------------------------------------------------------------------- */

/**
 * True when at least one lit pen draws on the given axis.
 * @param {object} chart The chart.
 * @param {string} axisId Axis id.
 * @returns {boolean} Whether the axis must be drawn.
 */
function axisHasVisiblePen(chart, axisId) {
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    if (p.visible && p.axis === axisId) return true;
  }
  return false;
}

/**
 * Recompute the plot rectangle from the cached element size and the visible axis set.
 * Never reads the DOM — sizes arrive through {@link applySize}.
 * @param {object} chart The chart.
 * @returns {void}
 */
function layout(chart) {
  const g = chart.geom;
  let nRight = 0;
  let hasLeft = false;
  let tagLines = 0;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    a.visible = axisHasVisiblePen(chart, a.id);
    if (!a.tagPens) a.tagPens = [];
    a.tagPens.length = 0;
    if (!a.visible) continue;
    // WHO OWNS THIS SCALE. Collected here rather than in the painter because the answer sets
    // the headroom the caption block needs, and headroom is a layout decision.
    for (let j = 0; j < chart.pens.length; j++) {
      const p = chart.pens[j];
      if (p.visible && axisOf(chart, p) === a) a.tagPens.push(p);
    }
    const lines = Math.min(AXIS_TAG_LINES_MAX, a.tagPens.length);
    if (lines > tagLines) tagLines = lines;
    if (a.side === 'left') hasLeft = true;
    else nRight++;
  }
  g.padL = hasLeft ? LEFT_AXIS_W : 8;
  g.padR = 8 + RIGHT_AXIS_STEP * nRight;
  // Room for one caption line per tag the busiest gutter names, plus one for its unit.
  g.padT = Math.max(16, 5 + AXIS_LABEL_LINE * (tagLines + 1));
  g.padB = 26;
  g.px0 = g.padL;
  g.py0 = g.padT;
  g.px1 = Math.max(g.padL + 8, g.cssW - g.padR);
  g.py1 = Math.max(g.padT + 8, g.cssH - g.padB);
  g.plotW = g.px1 - g.px0;
  g.plotH = g.py1 - g.py0;
  g.pixels = Math.max(1, Math.round(g.plotW * g.dpr));
  let slot = 0;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    if (!a.visible) continue;
    a.gutterX = a.side === 'left' ? g.px0 : g.px1 + slot * RIGHT_AXIS_STEP;
    if (a.side === 'right') slot++;
  }
}

/**
 * Grow the per-trace min/max buffers and the shared boundary tables to the current pixel
 * width. Caller-owned outputs, zero allocation once the size is stable.
 * @param {object} chart The chart.
 * @returns {void}
 */
function ensureBuffers(chart) {
  const p = chart.geom.pixels;
  for (let i = 0; i < chart.traces.length; i++) {
    const t = chart.traces[i];
    if (!t.minBuf || t.minBuf.length < p) {
      t.minBuf = new Float32Array(p);
      t.maxBuf = new Float32Array(p);
    }
  }
  if (chart.pixelStart.length < p + 1) chart.pixelStart = new Int32Array(p + 1);
  if (chart.stripStart.length < p + 1) chart.stripStart = new Int32Array(p + 1);
  chart.tableValid = false;
}

/**
 * Size the three canvases and the detached blit buffer to `cssW*dpr x cssH*dpr`, then
 * scale every context by `dpr` so all painting is expressed in css px.
 * @param {object} chart The chart.
 * @returns {void}
 */
function resizeCanvases(chart) {
  const g = chart.geom;
  const w = Math.max(1, Math.round(g.cssW * g.dpr));
  const hp = Math.max(1, Math.round(g.cssH * g.dpr));
  const cvs = [chart.cvStatic, chart.cvTraces, chart.cvOverlay, chart.blit.canvas];
  const cxs = [chart.gStatic, chart.gTraces, chart.gOverlay, chart.blit.ctx];
  for (let i = 0; i < cvs.length; i++) {
    if (cvs[i].width !== w) cvs[i].width = w;
    if (cvs[i].height !== hp) cvs[i].height = hp;
    const cx = cxs[i];
    cx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    cx.imageSmoothingEnabled = false;
    cx.lineJoin = 'miter';
    cx.miterLimit = 2;
  }
  chart.blit.w = w;
  chart.blit.h = hp;
  chart.blit.valid = false;
  chart.blit.validPx = 0;
  ensureBuffers(chart);
}

/**
 * Size the history strip's backing store.
 * @param {object} chart The chart.
 * @returns {void}
 */
function resizeOverview(chart) {
  if (!chart.ovCanvas) return;
  const dpr = chart.geom.dpr;
  const w = Math.max(1, Math.round(chart.ovW * dpr));
  const hgt = Math.max(1, Math.round(chart.ovH * dpr));
  if (chart.ovCanvas.width !== w) chart.ovCanvas.width = w;
  if (chart.ovCanvas.height !== hgt) chart.ovCanvas.height = hgt;
  chart.gOv.setTransform(dpr, 0, 0, dpr, 0, 0);
  chart.gOv.imageSmoothingEnabled = false;
  chart.ovDirty = true;
}

/**
 * Adopt a new css size for the plot host. No-ops when nothing moved, so it is safe to call
 * from a `ResizeObserver`, from `visibilitychange` and from `frame` alike.
 * @param {object} chart The chart.
 * @param {number} wCss Host width, css px.
 * @param {number} hCss Host height, css px.
 * @returns {boolean} True when the backing store was resized.
 */
function applySize(chart, wCss, hCss) {
  const g = chart.geom;
  const w = Math.max(1, Math.round(wCss));
  const hh = Math.max(1, Math.round(hCss));
  const dpr = window.devicePixelRatio || 1;
  if (g.cssW === w && g.cssH === hh && g.dpr === dpr) return false;
  g.cssW = w;
  g.cssH = hh;
  g.dpr = dpr;
  layout(chart);
  resizeCanvases(chart);
  resizeOverview(chart);
  invalidate(chart, 'all');
  return true;
}

/**
 * Measure the plot host and the history strip explicitly and adopt those sizes.
 *
 * THIS IS THE FIX for the 1x1 backing store: a `ResizeObserver` never fires while the tab
 * is in the background, and the observed box never changes afterwards, so a chart built on
 * a hidden page would otherwise stay at its construction-time size forever. Measuring on
 * mount, on unhide and from `frame` closes every one of those paths.
 * @param {object} chart The chart.
 * @returns {void}
 */
function measureNow(chart) {
  if (chart.destroyed) return;
  const r = chart.hostEl.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) applySize(chart, r.width, r.height);
  if (chart.ovHostEl) {
    const q = chart.ovHostEl.getBoundingClientRect();
    if (q.width > 0 && q.height > 0) {
      const w = Math.max(1, Math.round(q.width));
      const hh = Math.max(1, Math.round(q.height));
      if (w !== chart.ovW || hh !== chart.ovH) {
        chart.ovW = w;
        chart.ovH = hh;
        resizeOverview(chart);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 6. X WINDOW                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The store channel name backing the current x-mode.
 * @param {object} chart The chart.
 * @returns {string} Channel name, `'V_mL' | 't_s' | 'V_CV'`.
 */
function xChannel(chart) {
  return chart.xChannels[chart.xMode] || XCH_DEFAULT[chart.xMode];
}

/**
 * Channel value -> display value. Time is logged in seconds and displayed in minutes.
 * @param {object} chart The chart.
 * @param {number} x Value in the x channel's unit.
 * @returns {number} Value in the displayed unit.
 */
function toDisp(chart, x) {
  return chart.xMode === 'time' ? x / 60 : x;
}

/**
 * Display value -> channel value.
 * @param {object} chart The chart.
 * @param {number} d Value in the displayed unit.
 * @returns {number} Value in the x channel's unit.
 */
function fromDisp(chart, d) {
  return chart.xMode === 'time' ? d * 60 : d;
}

/**
 * The x value of the newest logged row, in the current x channel's unit.
 * @param {object} chart The chart.
 * @returns {number} Live-edge x, or 0 when the store is empty.
 */
function liveX(chart) {
  if (!chart.store) return 0;
  const x = column(chart.store, xChannel(chart));
  return x.length > 0 ? x[x.length - 1] : 0;
}

/**
 * Recompute the follow window. Two regimes, both cheap:
 *  - auto-fit: `x0 = 0` and the span snaps up {@link SPAN_LADDER}, so the span changes only
 *    when it crosses a rung and the blit buffer survives between rungs;
 *  - fixed-span follow: the window scrolls so the live edge sits at 85 % width, quantised
 *    to whole device pixels so the self-blit accumulates no sub-pixel error.
 * @param {object} chart The chart.
 * @returns {boolean} True when the window changed.
 */
function updateFollowWindow(chart) {
  if (!chart.follow) return false;
  const lx = liveX(chart);
  const minSpan = chart.xMode === 'time' ? 60 : 1;
  if (chart.autoFit) {
    const want = Math.max(lx / LIVE_EDGE_FRAC, minSpan);
    const span = ladderCeil(want, SPAN_LADDER);
    if (chart.x0 !== 0 || Math.abs(chart.x1 - span) > 1e-12) {
      chart.x0 = 0;
      chart.x1 = span;
      return true;
    }
    return false;
  }
  const span = chart.x1 - chart.x0;
  if (!(span > 0)) return false;
  const kx = chart.geom.pixels / span;
  const desired = lx - LIVE_EDGE_FRAC * span;
  const dPx = Math.round((desired - chart.x0) * kx);
  if (dPx === 0) return false;
  chart.x0 += dPx / kx;
  chart.x1 = chart.x0 + span;
  // ACCUMULATE, never assign: a frame that scrolls but then takes the full-repaint branch
  // must not leave its delta behind for the next append to re-apply. The full repaint
  // zeroes it; the append path consumes it.
  chart.scrollPx += dPx;
  return true;
}

/**
 * Map the visible window through the row index when the x-mode changes, so the same
 * samples stay on screen. Legal because every x channel is monotone non-decreasing.
 * @param {object} chart The chart.
 * @param {string} fromCh Previous x channel name.
 * @param {string} toCh New x channel name.
 * @returns {void}
 */
function remapWindow(chart, fromCh, toCh) {
  if (!chart.store || chart.store.n === 0) {
    chart.x0 = 0;
    chart.x1 = chart.xMode === 'time' ? 600 : 100;
    return;
  }
  const r = xIndexRange(chart.store, fromCh, chart.x0, chart.x1);
  const nx = column(chart.store, toCh);
  const n = nx.length;
  if (n === 0) return;
  const i0 = clamp(r.i0, 0, n - 1);
  const i1 = clamp(r.i1 - 1, 0, n - 1);
  const a = nx[i0];
  let b = nx[i1];
  if (!(b > a)) b = a + (chart.xMode === 'time' ? 60 : 1);
  chart.x0 = a;
  chart.x1 = b;
}

/* -------------------------------------------------------------------------- */
/* 7. Y AXES AND AUTOSCALE                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The axis a pen rides, with a documented fallback so a caller-supplied pen that names an
 * axis this stack does not define still draws instead of collapsing onto the floor.
 * @param {object} chart The chart.
 * @param {object} pen Pen.
 * @returns {object|null} Axis record.
 */
function axisOf(chart, pen) {
  const a = chart.axisById.get(pen.axis);
  if (a) return a;
  return chart.yAxes.length > 0 ? chart.yAxes[0] : null;
}

/**
 * Pen value -> axis value. Identity unless the pen rides the axis' `alt` scale (the
 * pH-on-the-%B-gutter case), which is an exact affine remap.
 * @param {object} pen Pen.
 * @param {object} a Axis.
 * @param {number} v Pen value.
 * @returns {number} Value in the axis' primary unit.
 */
function toAxisValue(pen, a, v) {
  if (!pen.alt || !a.alt) return v;
  const span = a.alt.max - a.alt.min;
  if (span === 0) return v;
  return a.min + ((v - a.alt.min) / span) * (a.max - a.min);
}

/**
 * Recompute every autoscaled axis from the freshly decimated per-trace buffers. The
 * maximum grows immediately; a shrink is armed only outside a 20 % hysteresis band and
 * then eased over 4 s. Reduced motion applies the shrink at once.
 *
 * SP traces and alarm limits take part: an operator must never lose the setpoint or the
 * trip line off the top of the trend.
 *
 * AN AXIS WITH NOTHING TO MEASURE HOLDS. Before a run there are no samples, so no trace and
 * possibly no limit contributes a bound. This used to substitute the axis' OWN current
 * target as the measured maximum and then add 8 % headroom to it, which made an idle axis
 * inflate by 8 % every 250 ms — a screen left sitting at the operator's desk reached 25
 * million mAU inside a minute and read as a broken instrument. An unmeasured axis now keeps
 * exactly the bounds it already has: the declared range at rest, the last good range if the
 * operator pans off the data mid-run.
 * @param {object} chart The chart.
 * @param {number} now_ms Frame timestamp.
 * @returns {void}
 */
function measureAxes(chart, now_ms) {
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    if (a.mode === 'manual' || !a.visible) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < chart.traces.length; j++) {
      const t = chart.traces[j];
      const pen = t.pen;
      if (!pen.visible || axisOf(chart, pen) !== a || !t.hasData) continue;
      const mn = t.dataMin;
      const mx = t.dataMax;
      if (mn !== mn || mx !== mx) continue;
      const av0 = toAxisValue(pen, a, mn);
      const av1 = toAxisValue(pen, a, mx);
      if (av0 < lo) lo = av0;
      if (av1 > hi) hi = av1;
    }
    for (let j = 0; j < chart.pens.length; j++) {
      const pen = chart.pens[j];
      if (!pen.visible || axisOf(chart, pen) !== a) continue;
      if (!(pen.limit === pen.limit)) continue;
      const lv = toAxisValue(pen, a, pen.limit);
      if (lv < lo) lo = lv;
      if (lv > hi) hi = lv;
    }
    if (!(lo <= hi)) {
      // Nothing measurable on this axis. Hold, and cancel any shrink still in flight so the
      // bounds cannot drift while there is no data to justify the move.
      a.easeT0 = 0;
      continue;
    }
    const band = a.mode === 'auto-band';
    // Process axes are anchored at zero unless the data goes negative; a banded control
    // axis is not, so its deviation stays legible.
    if (!band && lo > 0) lo = 0;
    let span = hi - lo;
    if (!(span > 0)) span = Math.abs(hi) > 0 ? Math.abs(hi) : 1;
    const wantMax = hi + span * HEADROOM_TOP;
    const wantMin = lo - (band || lo < 0 ? span * HEADROOM_BOTTOM : 0);

    if (a.targetMax === undefined || !(a.targetMax > -Infinity)) a.targetMax = wantMax;
    if (wantMax > a.targetMax) {
      a.targetMax = wantMax;
      a.easeFrom = a.targetMax;
      a.easeT0 = 0;
    } else if (wantMax < a.targetMax * (1 - SHRINK_HYSTERESIS)) {
      if (a.easeT0 === 0 || wantMax < a.easeTo) {
        a.easeFrom = a.targetMax;
        a.easeTo = wantMax;
        a.easeT0 = chart.reducedMotion ? 0 : now_ms;
        if (chart.reducedMotion) a.targetMax = wantMax;
      }
    }
    a.targetMin = band ? wantMin : Math.min(0, wantMin);
  }
}

/**
 * Advance the shrink ease and quantise the applied bounds onto the nice-number ladder.
 * Quantising is what keeps a 4 s shrink to a handful of full repaints instead of 240: the
 * eased value moves continuously, the applied bound only steps at a rung.
 * @param {object} chart The chart.
 * @param {number} now_ms Frame timestamp.
 * @returns {boolean} True when any applied bound changed.
 */
function applyAxisBounds(chart, now_ms) {
  let changed = false;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    let lo;
    let hi;
    if (a.mode === 'manual') {
      lo = a.min;
      hi = a.max;
    } else {
      if (a.easeT0 > 0) {
        const t = (now_ms - a.easeT0) / SHRINK_EASE_MS;
        if (t >= 1) {
          a.targetMax = a.easeTo;
          a.easeT0 = 0;
        } else {
          a.targetMax = a.easeFrom + (a.easeTo - a.easeFrom) * t;
        }
      }
      hi = a.targetMax;
      lo = a.targetMin === undefined ? 0 : a.targetMin;
      const mag = Math.abs(hi - lo);
      const step = niceStep(mag / 5);
      hi = Math.ceil(hi / step - 1e-9) * step;
      if (a.mode === 'auto-band') lo = Math.floor(lo / step + 1e-9) * step;
      else lo = lo < 0 ? -Math.ceil(-lo / step - 1e-9) * step : 0;
      if (!(hi > lo)) hi = lo + step;
    }
    if (!isFinite(lo) || !isFinite(hi) || !(hi > lo)) {
      lo = 0;
      hi = 1;
    }
    if (a.aMin !== lo || a.aMax !== hi) {
      a.aMin = lo;
      a.aMax = hi;
      changed = true;
    }
  }
  return changed;
}

/**
 * Precompute the per-trace pixel mapping `py = bPix - v*kPix`, folding the axis transform
 * and any `alt` remap into two scalars so the point loop never branches.
 * @param {object} chart The chart.
 * @param {object} g Geometry in use (may be an export geometry, not the live one).
 * @returns {void}
 */
function prepareMapping(chart, g) {
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    const span = a.aMax - a.aMin;
    a.k = span !== 0 ? g.plotH / span : 0;
    a.b = g.py1 + a.aMin * a.k;
  }
  for (let i = 0; i < chart.pens.length; i++) {
    const pen = chart.pens[i];
    const a = axisOf(chart, pen);
    if (!a) {
      pen.kPix = 0;
      pen.bPix = g.py1;
    } else {
      let ka = 1;
      let ba = 0;
      if (pen.alt && a.alt) {
        const as = a.alt.max - a.alt.min;
        if (as !== 0) {
          ka = (a.aMax - a.aMin) / as;
          ba = a.aMin - a.alt.min * ka;
        }
      }
      pen.kPix = a.k * ka;
      pen.bPix = a.b - ba * a.k;
    }
    if (pen.pvTrace) {
      pen.pvTrace.kPix = pen.kPix;
      pen.pvTrace.bPix = pen.bPix;
    }
    if (pen.spTrace) {
      pen.spTrace.kPix = pen.kPix;
      pen.spTrace.bPix = pen.bPix;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 8. DECIMATION                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the shared `pixelStart` boundary table for the current window. Recomputed only
 * when the window bounds, the pixel width or `store.n` change — not per frame and not per
 * trace; every trace then reuses one table and the inner loop stays index-based.
 * @param {object} chart The chart.
 * @returns {boolean} True when a usable table exists.
 */
function ensurePixelTable(chart) {
  const store = chart.store;
  const g = chart.geom;
  if (!store) return false;
  const n = store.n | 0;
  const p = g.pixels;
  const span = chart.x1 - chart.x0;
  if (!(span > 0) || p <= 0) return false;
  if (
    chart.tableValid &&
    chart.tableX0 === chart.x0 &&
    chart.tableX1 === chart.x1 &&
    chart.tablePixels === p &&
    chart.tableN === n &&
    chart.tableCh === xChannel(chart)
  ) {
    return true;
  }
  const x = column(store, xChannel(chart));
  const nx = x.length;
  const starts = chart.pixelStart;
  for (let b = 0; b <= p; b++) {
    starts[b] = lowerBoundF32(x, nx, chart.x0 + (b * span) / p);
  }
  // The last bin is inclusive of x1, matching log.decimateMinMax's clamped final bin.
  let e = starts[p];
  while (e < nx && x[e] <= chart.x1) e++;
  starts[p] = e;
  chart.tableValid = true;
  chart.tableX0 = chart.x0;
  chart.tableX1 = chart.x1;
  chart.tablePixels = p;
  chart.tableN = n;
  chart.tableCh = xChannel(chart);
  return true;
}

/**
 * Min/max fold over a half-open run of rows per bin, using a precomputed boundary table.
 * Empty bins receive `NaN`; `NaN` samples are skipped so one bad sample cannot poison a
 * bin (matches `log.decimateMinMax`).
 * @param {Float32Array} y Channel view.
 * @param {Int32Array} starts Row boundary per bin, length >= bEnd+1 relative to `off`.
 * @param {number} off Bin index that `starts[0]` refers to.
 * @param {number} bStart First bin to fill, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @param {Float32Array} outMin Caller-owned minima, indexed absolutely.
 * @param {Float32Array} outMax Caller-owned maxima, indexed absolutely.
 * @returns {void}
 */
function decimateBins(y, starts, off, bStart, bEnd, outMin, outMax) {
  const ny = y.length;
  for (let b = bStart; b < bEnd; b++) {
    let i = starts[b - off];
    let e = starts[b - off + 1];
    if (e > ny) e = ny;
    let mn = NaN;
    let mx = NaN;
    for (; i < e; i++) {
      const v = y[i];
      if (v !== v) continue;
      if (mn !== mn || v < mn) mn = v;
      if (mx !== mx || v > mx) mx = v;
    }
    outMin[b] = mn;
    outMax[b] = mx;
  }
}

/**
 * Build a boundary table for a narrow pixel strip, for the append-only path.
 * @param {object} chart The chart.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @returns {Int32Array} `chart.stripStart`, filled with `bEnd-bStart+1` entries.
 */
function buildStripTable(chart, bStart, bEnd) {
  const x = column(chart.store, xChannel(chart));
  const nx = x.length;
  const p = chart.geom.pixels;
  const span = chart.x1 - chart.x0;
  const out = chart.stripStart;
  const count = bEnd - bStart;
  for (let k = 0; k <= count; k++) {
    out[k] = lowerBoundF32(x, nx, chart.x0 + ((bStart + k) * span) / p);
  }
  if (bEnd >= p) {
    let e = out[count];
    while (e < nx && x[e] <= chart.x1) e++;
    out[count] = e;
  }
  return out;
}

/**
 * Decimate every lit trace over the whole window into its own buffers and record the
 * per-trace data range for the autoscaler. Runs at 4 Hz, not per frame.
 * @param {object} chart The chart.
 * @returns {void}
 */
function decimateAllVisible(chart) {
  const g = chart.geom;
  const p = g.pixels;
  const haveTable = ensurePixelTable(chart);
  for (let i = 0; i < chart.traces.length; i++) {
    const t = chart.traces[i];
    t.hasData = false;
    t.dataMin = NaN;
    t.dataMax = NaN;
    if (!t.pen.visible || !chart.store) continue;
    const y = column(chart.store, t.channel);
    if (y.length === 0) continue;
    if (haveTable) {
      decimateBins(y, chart.pixelStart, 0, 0, p, t.minBuf, t.maxBuf);
    } else {
      decimateMinMax(chart.store, xChannel(chart), t.channel, chart.x0, chart.x1, p, t.minBuf, t.maxBuf);
    }
    let mn = NaN;
    let mx = NaN;
    for (let b = 0; b < p; b++) {
      const a = t.minBuf[b];
      if (a === a) {
        if (mn !== mn || a < mn) mn = a;
        const c = t.maxBuf[b];
        if (mx !== mx || c > mx) mx = c;
      }
    }
    t.dataMin = mn;
    t.dataMax = mx;
    t.hasData = mn === mn;
  }
}

/**
 * Samples per device pixel column over the current window. Below {@link RAW_SPP} the
 * decimator is bypassed and raw points are drawn.
 * @param {object} chart The chart.
 * @param {object} g Geometry in use.
 * @returns {number} Samples per pixel, 0 when there is no source.
 */
function samplesPerPixel(chart, g) {
  if (!chart.store || chart.store.n === 0) return 0;
  const r = xIndexRange(chart.store, xChannel(chart), chart.x0, chart.x1);
  return (r.i1 - r.i0) / Math.max(1, g.pixels);
}

/* -------------------------------------------------------------------------- */
/* 9. TRACE PAINTING                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Stroke one PV trace across a bin range from its decimated envelope. Emits at most two
 * vertices per pixel column: `lineTo(x, yMin); lineTo(x, yMax)`. Empty bins break the path
 * so a gap in the log is never bridged by a straight line.
 * @param {CanvasRenderingContext2D} ctx Target context, already dpr-scaled.
 * @param {object} t Trace with `minBuf`/`maxBuf` filled for `[bStart,bEnd)`.
 * @param {object} g Geometry in use.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @returns {void}
 */
function strokeEnvelope(ctx, t, g, bStart, bEnd) {
  const invDpr = 1 / g.dpr;
  const x0 = g.px0;
  const kPix = t.kPix;
  const bPix = t.bPix;
  const yTop = g.py0 - 2;
  const yBot = g.py1 + 2;
  let pen = false;
  ctx.beginPath();
  for (let b = bStart; b < bEnd; b++) {
    const lo = t.minBuf[b];
    if (lo !== lo) {
      pen = false;
      continue;
    }
    const hi = t.maxBuf[b];
    const px = x0 + (b + 0.5) * invDpr;
    let a = bPix - lo * kPix;
    let c = bPix - hi * kPix;
    if (a > yBot) a = yBot;
    else if (a < yTop) a = yTop;
    if (c > yBot) c = yBot;
    else if (c < yTop) c = yTop;
    if (!pen) {
      ctx.moveTo(px, a);
      pen = true;
    } else {
      ctx.lineTo(px, a);
    }
    ctx.lineTo(px, c);
  }
  ctx.stroke();
}

/**
 * Stroke one HELD trace as a STAIRCASE — horizontal run, then vertical jump — because a
 * setpoint is a held value, not a signal. Drawing it as steps also keeps the 5-4 dash
 * phase proportional to x, which is what lets the append-only blit path re-enter the same
 * pattern at the live edge instead of jittering the dashes.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} t Trace with buffers filled.
 * @param {object} g Geometry in use.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @returns {void}
 */
function strokeStep(ctx, t, g, bStart, bEnd) {
  const invDpr = 1 / g.dpr;
  const x0 = g.px0;
  const kPix = t.kPix;
  const bPix = t.bPix;
  const yTop = g.py0 - 2;
  const yBot = g.py1 + 2;
  const period = SP_DASH[0] + SP_DASH[1];
  const startX = x0 + (bStart + 0.5) * invDpr;
  ctx.lineDashOffset = startX % period;
  let pen = false;
  let lastY = 0;
  ctx.beginPath();
  for (let b = bStart; b < bEnd; b++) {
    const v = t.maxBuf[b];
    if (v !== v) {
      pen = false;
      continue;
    }
    const px = x0 + (b + 0.5) * invDpr;
    let y = bPix - v * kPix;
    if (y > yBot) y = yBot;
    else if (y < yTop) y = yTop;
    if (!pen) {
      ctx.moveTo(px, y);
      pen = true;
    } else {
      ctx.lineTo(px, lastY);
      ctx.lineTo(px, y);
    }
    lastY = y;
  }
  ctx.stroke();
  ctx.lineDashOffset = 0;
}

/**
 * Fill the area under a trace's envelope down to the axis floor — the %B context band.
 * Drawn before any stroke so it never sits over data.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} t Trace with buffers filled.
 * @param {object} g Geometry in use.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @returns {void}
 */
function fillEnvelope(ctx, t, g, bStart, bEnd) {
  const invDpr = 1 / g.dpr;
  const x0 = g.px0;
  const kPix = t.kPix;
  const bPix = t.bPix;
  const base = g.py1;
  let run = -1;
  ctx.beginPath();
  for (let b = bStart; b <= bEnd; b++) {
    const hi = b < bEnd ? t.maxBuf[b] : NaN;
    if (hi !== hi) {
      if (run >= 0) {
        ctx.lineTo(x0 + (b - 0.5) * invDpr, base);
        ctx.closePath();
        run = -1;
      }
      continue;
    }
    const px = x0 + (b + 0.5) * invDpr;
    let c = bPix - hi * kPix;
    if (c < g.py0) c = g.py0;
    else if (c > base) c = base;
    if (run < 0) {
      ctx.moveTo(px, base);
      ctx.lineTo(px, c);
      run = b;
    } else {
      ctx.lineTo(px, c);
    }
  }
  ctx.fill();
}

/**
 * Draw one INTERPOLATED trace as raw points, used when `samplesPerPixel < 1.5`. A held
 * trace goes to {@link strokeRawStep} instead.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} chart The chart.
 * @param {object} t Trace.
 * @param {object} g Geometry in use.
 * @param {number} xa Window start of the drawn range, x-channel unit.
 * @param {number} xb Window end of the drawn range, x-channel unit.
 * @returns {void}
 */
function strokeRaw(ctx, chart, t, g, xa, xb) {
  const xcol = column(chart.store, xChannel(chart));
  const y = column(chart.store, t.channel);
  let n = xcol.length;
  if (y.length < n) n = y.length;
  if (n === 0) return;
  const kx = g.plotW / (chart.x1 - chart.x0);
  const bx = g.px0 - chart.x0 * kx;
  const kPix = t.kPix;
  const bPix = t.bPix;
  const yTop = g.py0 - 2;
  const yBot = g.py1 + 2;
  let i = lowerBoundF32(xcol, n, xa);
  if (i > 0) i--; // one sample of lead-in so the segment entering the range is drawn
  let pen = false;
  ctx.beginPath();
  for (; i < n; i++) {
    const xv = xcol[i];
    if (xv > xb) {
      const v0 = y[i];
      if (v0 === v0 && pen) ctx.lineTo(bx + xv * kx, clamp(bPix - v0 * kPix, yTop, yBot));
      break;
    }
    const v = y[i];
    if (v !== v) {
      pen = false;
      continue;
    }
    const px = bx + xv * kx;
    const py = clamp(bPix - v * kPix, yTop, yBot);
    if (!pen) {
      ctx.moveTo(px, py);
      pen = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}

/**
 * Draw one HELD trace as raw points, used when `samplesPerPixel < 1.5`. Identical walk to
 * {@link strokeRaw} except that consecutive samples are joined by a horizontal run and a
 * vertical jump instead of a slope, exactly as {@link strokeStep} joins them in decimated
 * mode. This is what keeps a setpoint step reading as a step at every zoom level: the raw
 * painter is reached early in a run and whenever the operator zooms into a block boundary,
 * which is precisely where a ramp would be most convincing and most wrong.
 *
 * The dash phase is locked to the drawn range's own left edge, the same way and for the
 * same reason as in {@link strokeStep}: the append-only blit path re-enters the pattern at
 * the live edge rather than restarting it.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} chart The chart.
 * @param {object} t Trace.
 * @param {object} g Geometry in use.
 * @param {number} xa Window start of the drawn range, x-channel unit.
 * @param {number} xb Window end of the drawn range, x-channel unit.
 * @returns {void}
 */
function strokeRawStep(ctx, chart, t, g, xa, xb) {
  const xcol = column(chart.store, xChannel(chart));
  const y = column(chart.store, t.channel);
  let n = xcol.length;
  if (y.length < n) n = y.length;
  if (n === 0) return;
  const kx = g.plotW / (chart.x1 - chart.x0);
  const bx = g.px0 - chart.x0 * kx;
  const kPix = t.kPix;
  const bPix = t.bPix;
  const yTop = g.py0 - 2;
  const yBot = g.py1 + 2;
  const period = SP_DASH[0] + SP_DASH[1];
  ctx.lineDashOffset = (bx + xa * kx) % period;
  let i = lowerBoundF32(xcol, n, xa);
  if (i > 0) i--; // one sample of lead-in so the run entering the range is drawn
  let pen = false;
  let lastY = 0;
  ctx.beginPath();
  for (; i < n; i++) {
    const xv = xcol[i];
    if (xv > xb) {
      // Hold the last value out to the sample past the range; the clip does the trimming.
      if (pen) ctx.lineTo(bx + xv * kx, lastY);
      break;
    }
    const v = y[i];
    if (v !== v) {
      pen = false;
      continue;
    }
    const px = bx + xv * kx;
    const py = clamp(bPix - v * kPix, yTop, yBot);
    if (!pen) {
      ctx.moveTo(px, py);
      pen = true;
    } else {
      ctx.lineTo(px, lastY);
      ctx.lineTo(px, py);
    }
    lastY = py;
  }
  ctx.stroke();
  ctx.lineDashOffset = 0;
}

/**
 * Filled area under a raw-mode trace.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} chart The chart.
 * @param {object} t Trace.
 * @param {object} g Geometry in use.
 * @param {number} xa Range start, x-channel unit.
 * @param {number} xb Range end, x-channel unit.
 * @returns {void}
 */
function fillRaw(ctx, chart, t, g, xa, xb) {
  const xcol = column(chart.store, xChannel(chart));
  const y = column(chart.store, t.channel);
  let n = xcol.length;
  if (y.length < n) n = y.length;
  if (n === 0) return;
  const kx = g.plotW / (chart.x1 - chart.x0);
  const bx = g.px0 - chart.x0 * kx;
  const base = g.py1;
  let i = lowerBoundF32(xcol, n, xa);
  if (i > 0) i--;
  let started = false;
  let lastPx = 0;
  ctx.beginPath();
  for (; i < n && xcol[i] <= xb; i++) {
    const v = y[i];
    if (v !== v) continue;
    const px = bx + xcol[i] * kx;
    const py = clamp(t.bPix - v * t.kPix, g.py0, base);
    if (!started) {
      ctx.moveTo(px, base);
      started = true;
    }
    ctx.lineTo(px, py);
    lastPx = px;
  }
  if (started) {
    ctx.lineTo(lastPx, base);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Paint every lit trace over a bin range into a context, decimating first. Draw order is:
 * the %B context fill, then PV pens in reverse rail order so the first pen ends on top,
 * then SP pens last of all — a setpoint must always be legible against its own PV.
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @param {Int32Array|null} starts Boundary table covering `[bStart,bEnd]`, or null to use
 *   the chart's cached full-window table.
 * @param {number} off Bin index that `starts[0]` refers to.
 * @returns {void}
 */
function paintTraceBins(chart, ctx, g, colors, bStart, bEnd, starts, off) {
  if (bEnd <= bStart || !chart.store) return;
  const table = starts || chart.pixelStart;
  const tOff = starts ? off : 0;
  const raw = chart.rawMode;
  const span = chart.x1 - chart.x0;
  const xa = chart.x0 + ((bStart - 0.5) * span) / g.pixels;
  const xb = chart.x0 + ((bEnd + 0.5) * span) / g.pixels;

  for (let i = 0; i < chart.traces.length; i++) {
    const t = chart.traces[i];
    if (!t.pen.visible) continue;
    const y = column(chart.store, t.channel);
    if (y.length === 0) continue;
    if (!raw) decimateBins(y, table, tOff, bStart, bEnd, t.minBuf, t.maxBuf);
  }

  for (let i = 0; i < chart.traces.length; i++) {
    const t = chart.traces[i];
    // A HELD trace is never filled — the %B band says what solvent the column actually
    // saw, and an area under a commanded number says nothing. This is the existing rule
    // for SP traces, stated over the semantics instead of over the trace's role, so the
    // filled edge can never disagree with the staircase stroked on top of it.
    const fill = t.held ? 0 : t.pen.fill;
    if (!t.pen.visible || !(fill > 0)) continue;
    if (column(chart.store, t.channel).length === 0) continue;
    ctx.globalAlpha = t.pen.dim ? fill * 0.25 : fill;
    ctx.fillStyle = colors.pen[t.pen.id];
    if (raw) fillRaw(ctx, chart, t, g, xa, xb);
    else fillEnvelope(ctx, t, g, bStart, bEnd);
  }
  ctx.globalAlpha = 1;

  for (let pass = 0; pass < 2; pass++) {
    for (let i = chart.traces.length - 1; i >= 0; i--) {
      const t = chart.traces[i];
      if (!t.pen.visible) continue;
      if ((pass === 0) === t.isSp) continue;
      if (column(chart.store, t.channel).length === 0) continue;
      ctx.strokeStyle = colors.pen[t.pen.id];
      ctx.lineWidth = t.isSp ? SP_WIDTH : chart.contrastMore ? 2 : PV_WIDTH;
      ctx.globalAlpha = t.pen.dim ? 0.22 : 1;
      ctx.setLineDash(t.isSp ? SP_DASH : EMPTY_DASH);
      // A held trace is a staircase in BOTH modes. Choosing the painter on `t.held` rather
      // than on `raw` is the whole point: zoom changes the sampling, never the meaning.
      if (t.held) {
        if (raw) strokeRawStep(ctx, chart, t, g, xa, xb);
        else strokeStep(ctx, t, g, bStart, bEnd);
      } else if (raw) {
        strokeRaw(ctx, chart, t, g, xa, xb);
      } else {
        strokeEnvelope(ctx, t, g, bStart, bEnd);
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash(EMPTY_DASH);
}

/**
 * Clear the plot rectangle of a dpr-scaled context.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} g Geometry in use.
 * @returns {void}
 */
function clearPlot(ctx, g) {
  ctx.clearRect(g.px0 - 1, g.py0 - 1, g.plotW + 2, g.plotH + 2);
}

/**
 * Device-pixel column of the live edge inside the current window.
 * @param {object} chart The chart.
 * @returns {number} Bin index, clamped to [0, pixels].
 */
function liveEdgeBin(chart) {
  const g = chart.geom;
  const span = chart.x1 - chart.x0;
  if (!(span > 0)) return 0;
  const b = Math.round(((liveX(chart) - chart.x0) / span) * g.pixels);
  return clamp(b, 0, g.pixels);
}

/**
 * Clear the blit buffer from a bin to the right edge of the plot.
 * @param {object} chart The chart.
 * @param {number} fromBin First bin to clear, absolute.
 * @returns {void}
 */
function clearBufferRight(chart, fromBin) {
  const g = chart.geom;
  const ctx = chart.blit.ctx;
  const x = g.px0 + fromBin / g.dpr;
  const w = g.px1 - x + 2;
  if (w > 0) ctx.clearRect(x, g.py0 - 1, w, g.plotH + 2);
}

/**
 * Composite the finalized buffer onto the traces canvas and paint the newest columns live.
 * The buffer is blitted with an identity transform so the copy is an exact integer
 * device-pixel move with no resampling.
 * @param {object} chart The chart.
 * @returns {void}
 */
function compositeAndLive(chart) {
  const g = chart.geom;
  const ctx = chart.gTraces;
  const sx = Math.round(g.px0 * g.dpr);
  const sy = Math.round(g.py0 * g.dpr);
  const sw = g.pixels;
  const sh = Math.max(1, Math.round(g.plotH * g.dpr));
  clearPlot(ctx, g);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(chart.blit.canvas, sx, sy, sw, sh, sx, sy, sw, sh);
  ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);

  const edge = liveEdgeBin(chart);
  const from = Math.max(0, chart.blit.validPx - 1);
  if (edge > from) {
    const starts = buildStripTable(chart, from, edge);
    ctx.save();
    ctx.beginPath();
    const cx = g.px0 + chart.blit.validPx / g.dpr;
    ctx.rect(cx, g.py0 - 1, g.px1 - cx + 1, g.plotH + 2);
    ctx.clip();
    paintTraceBins(chart, ctx, g, chart.colors, from, edge, starts, from);
    ctx.restore();
  }
}

/**
 * Full traces repaint over the whole window. When following, the result is painted into
 * the detached blit buffer and composited; otherwise it goes straight to the traces canvas.
 * @param {object} chart The chart.
 * @returns {void}
 */
function paintTracesFull(chart) {
  const g = chart.geom;
  const colors = chart.colors;
  chart.rawMode = samplesPerPixel(chart, g) < RAW_SPP;
  if (!chart.rawMode) ensurePixelTable(chart);
  prepareMapping(chart, g);

  chart.scrollPx = 0; // the buffer is about to be repainted at the CURRENT window
  const useBuf = chart.follow && !chart.interacting;
  const ctx = useBuf ? chart.blit.ctx : chart.gTraces;
  clearPlot(ctx, g);
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.px0, g.py0 - 1, g.plotW, g.plotH + 2);
  ctx.clip();
  paintTraceBins(chart, ctx, g, colors, 0, g.pixels, null, 0);
  ctx.restore();

  chart.blit.valid = useBuf;
  if (useBuf) {
    chart.blit.validPx = Math.max(0, liveEdgeBin(chart) - 2);
    // Everything right of the finalized edge is repainted from live data every frame.
    clearBufferRight(chart, chart.blit.validPx);
    compositeAndLive(chart);
  }
  chart.lastPaintedN = chart.store ? chart.store.n : 0;
  chart.dirty.traces = false;
}

/**
 * The append-only fast path: shift the buffer by whole device pixels, finalize any columns
 * that have fallen more than 2 px behind the live edge, then composite.
 * @param {object} chart The chart.
 * @returns {boolean} True when the fast path ran; false when a full repaint is required.
 */
function paintTracesAppend(chart) {
  const g = chart.geom;
  const b = chart.blit;
  if (!b.valid) return false;
  const dPx = chart.scrollPx | 0;
  chart.scrollPx = 0;
  if (dPx < 0 || dPx > g.pixels) return false;

  const ctx = b.ctx;
  const sx = Math.round(g.px0 * g.dpr);
  const sy = Math.round(g.py0 * g.dpr);
  const sh = Math.max(1, Math.round(g.plotH * g.dpr));
  if (dPx > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const keep = g.pixels - dPx;
    if (keep > 0) ctx.drawImage(b.canvas, sx + dPx, sy, keep, sh, sx, sy, keep, sh);
    ctx.clearRect(sx + Math.max(0, keep), sy, dPx, sh);
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    b.validPx = Math.max(0, b.validPx - dPx);
  }

  prepareMapping(chart, g);
  chart.rawMode = samplesPerPixel(chart, g) < RAW_SPP;
  const newValid = Math.max(0, liveEdgeBin(chart) - 2);
  if (newValid > b.validPx) {
    const from = Math.max(0, b.validPx - 1);
    const starts = buildStripTable(chart, from, newValid);
    ctx.save();
    ctx.beginPath();
    const cx = g.px0 + b.validPx / g.dpr;
    ctx.rect(cx, g.py0 - 1, (newValid - b.validPx) / g.dpr + 1, g.plotH + 2);
    ctx.clip();
    paintTraceBins(chart, ctx, g, chart.colors, from, newValid, starts, from);
    ctx.restore();
    b.validPx = newValid;
  }
  clearBufferRight(chart, b.validPx);
  compositeAndLive(chart);
  chart.lastPaintedN = chart.store ? chart.store.n : 0;
  return true;
}

/* -------------------------------------------------------------------------- */
/* 10. STATIC LAYER — well, graticule, bands, ticks, annotations               */
/* -------------------------------------------------------------------------- */

/**
 * Compute the x tick positions for the current window, in display units. Nice-number
 * spacing targeting 60–110 px.
 * @param {object} chart The chart.
 * @param {object} g Geometry in use.
 * @returns {{first:number, step:number, count:number, decimals:number}} Tick plan.
 */
function xTickPlan(chart, g) {
  const d0 = toDisp(chart, chart.x0);
  const d1 = toDisp(chart, chart.x1);
  const span = d1 - d0;
  const target = clamp(Math.round(g.plotW / 85), 2, 16);
  const step = niceStep(span / target);
  const first = Math.ceil(d0 / step - 1e-9) * step;
  const count = Math.max(0, Math.floor((d1 - first) / step + 1e-9) + 1);
  return { first, step, count: Math.min(count, 64), decimals: decimalsFor(step) };
}

/**
 * Compute the y tick positions for one axis.
 * @param {object} a Axis with applied bounds.
 * @param {object} g Geometry in use.
 * @returns {{first:number, step:number, count:number, decimals:number}} Tick plan.
 */
function yTickPlan(a, g) {
  const span = a.aMax - a.aMin;
  const target = clamp(Math.round(g.plotH / 44), 2, 12);
  const step = niceStep(span / target);
  const first = Math.ceil(a.aMin / step - 1e-9) * step;
  const count = Math.max(0, Math.floor((a.aMax - first) / step + 1e-9) + 1);
  return { first, step, count: Math.min(count, 32), decimals: decimalsFor(step) };
}

/**
 * Truncate a label to a pixel budget with an ellipsis.
 * @param {CanvasRenderingContext2D} ctx Context with the final font set.
 * @param {string} text Source text.
 * @param {number} maxW Budget, css px.
 * @returns {string} Fitted text, possibly empty.
 */
function ellipsize(ctx, text, maxW) {
  if (maxW <= 6) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

/**
 * Paint the phase/block shading bands and their labels.
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Static context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintBands(chart, ctx, g, colors) {
  const bands = chart.bands;
  chart.bandLabelSpots.length = 0;
  if (!bands || bands.length === 0) return;
  const span = chart.x1 - chart.x0;
  const kx = g.plotW / span;
  const bx = g.px0 - chart.x0 * kx;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.px0, g.py0 - g.padT, g.plotW, g.plotH + g.padT);
  ctx.clip();
  ctx.font = '600 10px ' + FONT_UI;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.x1 <= chart.x0 || b.x0 >= chart.x1) continue;
    const a0 = Math.max(b.x0, chart.x0) * kx + bx;
    const a1 = Math.min(b.x1, chart.x1) * kx + bx;
    const w = a1 - a0;
    if (!(w > 0)) continue;
    ctx.globalAlpha = i % 2 === 0 ? BAND_WASH_A : BAND_WASH_B;
    ctx.fillStyle = colors.ink;
    ctx.fillRect(a0, g.py0, w, g.plotH);
    const tint = BAND_TINT[b.kind];
    if (tint && colors[tint]) {
      ctx.globalAlpha = BAND_TINT_ALPHA;
      ctx.fillStyle = colors[tint];
      ctx.fillRect(a0, g.py0, w, g.plotH);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.plotFrame;
    ctx.fillRect(Math.round(a0), g.py0, 1, g.plotH);
    const label = b.label ? String(b.label).toUpperCase() : '';
    if (!label) continue;
    if (w < 34) {
      chart.bandLabelSpots.push({ x0: a0, x1: a1, text: label });
      continue;
    }
    ctx.fillStyle = colors.plotAxis;
    const fitted = ellipsize(ctx, label, w - 6);
    if (fitted) ctx.fillText(fitted, a0 + 3, g.py0 - 12);
  }
  ctx.restore();
}

/**
 * Paint the pooled-fraction region: an amber wash with solid edges and a top drag handle.
 * The amber is the SP amber, painted through `globalAlpha` rather than as a second literal.
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Static context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintPool(chart, ctx, g, colors) {
  const p = chart.pool;
  if (!p.on) return;
  const span = chart.x1 - chart.x0;
  const kx = g.plotW / span;
  const bx = g.px0 - chart.x0 * kx;
  const a0 = clamp(p.x0 * kx + bx, g.px0, g.px1);
  const a1 = clamp(p.x1 * kx + bx, g.px0, g.px1);
  if (!(a1 > a0)) return;
  ctx.globalAlpha = POOL_FILL_ALPHA;
  ctx.fillStyle = colors.fldSp;
  ctx.fillRect(a0, g.py0, a1 - a0, g.plotH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors.fldSp;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(a0) + 0.5, g.py0);
  ctx.lineTo(Math.round(a0) + 0.5, g.py1);
  ctx.moveTo(Math.round(a1) + 0.5, g.py0);
  ctx.lineTo(Math.round(a1) + 0.5, g.py1);
  ctx.stroke();
  ctx.fillStyle = colors.fldSp;
  ctx.fillRect(a0, g.py0, a1 - a0, 3);
}

/**
 * Paint fraction ticks, event chevrons and peak flags. Tick ids are drawn on every fifth
 * mark, or on every mark once they are more than 40 px apart. Peak flags use greedy
 * anti-overlap in 13 px steps, capped at three rows, then a leader line.
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Static context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintMarkers(chart, ctx, g, colors) {
  const ms = chart.markers;
  if (!ms || ms.length === 0) return;
  const span = chart.x1 - chart.x0;
  const kx = g.plotW / span;
  const bx = g.px0 - chart.x0 * kx;

  // --- fraction ticks ------------------------------------------------------
  ctx.save();
  ctx.font = '8px ' + FONT_NUM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let tickIdx = 0;
  let prevTickPx = -1e9;
  let minGap = 1e9;
  for (let i = 0; i < ms.length; i++) {
    if (ms[i].kind !== 'tick') continue;
    const px = ms[i].x * kx + bx;
    if (prevTickPx > -1e8) minGap = Math.min(minGap, px - prevTickPx);
    prevTickPx = px;
  }
  const labelEvery = minGap > 40 ? 1 : 5;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.kind !== 'tick') continue;
    const px = m.x * kx + bx;
    tickIdx++;
    if (px < g.px0 - 1 || px > g.px1 + 1) continue;
    ctx.strokeStyle = colors.plotFrame;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, g.py1 + 1);
    ctx.lineTo(Math.round(px) + 0.5, g.py1 + 5);
    ctx.stroke();
    if (m.label && (tickIdx - 1) % labelEvery === 0) {
      ctx.fillStyle = colors.plotAxis;
      ctx.fillText(String(m.label), px, g.py1 + 5);
    }
  }
  ctx.restore();

  // --- full-height event lines --------------------------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.px0, g.py0 - g.padT, g.plotW, g.plotH + g.padT);
  ctx.clip();
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.kind !== 'line') continue;
    const px = m.x * kx + bx;
    if (px < g.px0 - 1 || px > g.px1 + 1) continue;
    ctx.strokeStyle = m.severity === 'ALARM' || m.severity === 'CRITICAL' ? colors.alarm
      : m.severity === 'WARN' ? colors.warn : colors.plotAxis;
    ctx.lineWidth = 1;
    ctx.setLineDash(MARKER_DASH);
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, g.py0);
    ctx.lineTo(Math.round(px) + 0.5, g.py1);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(px - 3, g.py0);
    ctx.lineTo(px + 3, g.py0);
    ctx.lineTo(px, g.py0 + 5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // --- peak flags ----------------------------------------------------------
  const flags = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.kind !== 'flag') continue;
    const px = m.x * kx + bx;
    if (px < g.px0 - 40 || px > g.px1 + 40) continue;
    const pen = m.seriesId ? chart.penById.get(m.seriesId) : null;
    const apexY = pen && typeof m.y === 'number' && isFinite(m.y)
      ? clamp(pen.bPix - m.y * pen.kPix, g.py0, g.py1)
      : g.py0 + 10;
    flags.push({ m, px, apexY, pen });
  }
  flags.sort((a, b) => a.apexY - b.apexY);
  const placed = [];
  ctx.save();
  ctx.font = '700 9px ' + FONT_NUM;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'center';
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const text = String(f.m.label || '');
    const w = ctx.measureText(text).width + 6;
    let row = 0;
    let ly = f.apexY - 7;
    for (; row < 3; row++) {
      ly = f.apexY - 7 - row * 13;
      let hit = false;
      for (let k = 0; k < placed.length; k++) {
        const q = placed[k];
        if (Math.abs(q.y - ly) < 11 && Math.abs(q.x - f.px) < (q.w + w) / 2) {
          hit = true;
          break;
        }
      }
      if (!hit) break;
    }
    const leader = row >= 3;
    if (leader) ly = f.apexY - 7 - 2 * 13;
    ly = Math.max(g.py0 + 9, ly);
    placed.push({ x: f.px, y: ly, w });
    const sev = f.m.severity;
    const col = f.pen && chart.colors.pen[f.pen.id]
      ? chart.colors.pen[f.pen.id]
      : sev === 'ALARM' || sev === 'CRITICAL' || sev === 'FAULT' ? colors.alarm
        : sev === 'WARN' ? colors.warn : colors.plotAxis;
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(f.px) + 0.5, f.apexY);
    ctx.lineTo(Math.round(f.px) + 0.5, ly + 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (leader) {
      ctx.strokeStyle = colors.plotFrame;
      ctx.beginPath();
      ctx.moveTo(f.px, ly + 2);
      ctx.lineTo(f.px + 9, ly - 4);
      ctx.stroke();
    }
    if (typeof f.m.x0 === 'number' && typeof f.m.x1 === 'number') {
      ctx.strokeStyle = colors.plotFrame;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash(MARKER_DASH);
      ctx.beginPath();
      const b0 = f.m.x0 * kx + bx;
      const b1 = f.m.x1 * kx + bx;
      ctx.moveTo(b0, g.py1);
      ctx.lineTo(b0, f.apexY);
      ctx.moveTo(b1, g.py1);
      ctx.lineTo(b1, f.apexY);
      ctx.stroke();
      ctx.setLineDash(EMPTY_DASH);
      ctx.globalAlpha = 1;
    }
    if (text) {
      // Keep the label INSIDE the plot. It is centre-aligned on the chevron, so a mark at the head
      // of a run — where the event cluster always sits — hangs half its width into the left gutter
      // and prints straight over the y-axis tick labels ("x3" landing on "30"). The chevron itself
      // stays on the true x; only the text slides, which is the standard behaviour for an
      // annotation that would otherwise leave its frame.
      const half = w / 2;
      const wanted = leader ? f.px + 9 + half : f.px;
      const lo = g.px0 + half;
      const hi = g.px1 - half;
      ctx.fillStyle = col;
      ctx.fillText(text, hi > lo ? clamp(wanted, lo, hi) : wanted, ly);
    }
  }
  ctx.restore();
}

/**
 * Paint the well: the graphite ground, the cool-grey graticule, phase bands, pooled region,
 * fraction ticks and every axis. Repainted only on a window, zoom, theme, pen or annotation
 * change — a handful of times per second even during a run.
 *
 * EVERY ONE OF THOSE IS DRAWN WITH ZERO SAMPLES. An instrument at rest is not a blank box:
 * it shows its graticule, its frame, both axes, their tick labels and their engineering
 * units, at the bounds its axes declare. The only thing an empty log adds is one quiet
 * caption at the foot of the plot — never a slab across the middle of it.
 * @param {object} chart The chart.
 * @param {object} rc Render target `{ ctx, geom, colors }`.
 * @returns {void}
 */
function paintStatic(chart, rc) {
  const ctx = rc.ctx;
  const g = rc.geom;
  const colors = rc.colors;
  ctx.clearRect(0, 0, g.cssW, g.cssH);
  ctx.fillStyle = colors.plotBg;
  ctx.fillRect(0, 0, g.cssW, g.cssH);
  prepareMapping(chart, g);
  paintBands(chart, ctx, g, colors);
  paintPool(chart, ctx, g, colors);

  const xp = xTickPlan(chart, g);
  const kx = g.plotW / (chart.x1 - chart.x0);
  const bx = g.px0 - chart.x0 * kx;

  ctx.strokeStyle = colors.plotGrid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < xp.count; i++) {
    const dv = xp.first + i * xp.step;
    const px = Math.round(fromDisp(chart, dv) * kx + bx) + 0.5;
    if (px < g.px0 || px > g.px1) continue;
    ctx.moveTo(px, g.py0);
    ctx.lineTo(px, g.py1);
  }
  const gridAxis = chart.yAxes.find((a) => a.visible) || null;
  if (gridAxis) {
    const yp = yTickPlan(gridAxis, g);
    for (let i = 0; i < yp.count; i++) {
      const v = yp.first + i * yp.step;
      const py = Math.round(gridAxis.b - v * gridAxis.k) + 0.5;
      if (py < g.py0 || py > g.py1) continue;
      ctx.moveTo(g.px0, py);
      ctx.lineTo(g.px1, py);
    }
  }
  ctx.stroke();

  paintMarkers(chart, ctx, g, colors);

  ctx.strokeStyle = colors.plotFrame;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.round(g.px0) + 0.5, Math.round(g.py0) + 0.5,
    Math.max(1, Math.round(g.plotW) - 1), Math.max(1, Math.round(g.plotH) - 1)
  );

  // x tick labels, then the engineering unit hard against the right end
  ctx.fillStyle = colors.plotAxis;
  ctx.font = '10px ' + FONT_NUM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const euGuard = g.px1 - 26;
  for (let i = 0; i < xp.count; i++) {
    const dv = xp.first + i * xp.step;
    const px = fromDisp(chart, dv) * kx + bx;
    if (px < g.px0 - 1 || px > euGuard) continue;
    ctx.fillText(dv.toFixed(xp.decimals), px, g.py1 + 14);
  }
  ctx.font = '600 10px ' + FONT_UI;
  ctx.textAlign = 'right';
  ctx.fillText(X_EU[chart.xMode], g.px1, g.py1 + 14);

  paintYAxes(chart, ctx, g, colors);

  if (!chart.store || chart.store.n === 0) paintRestCaption(ctx, g, colors);
}

/**
 * The at-rest caption: one small, dim line at the foot of the plot saying the log is empty.
 * It replaces the old centred `NO DATA` slab, which read as a disconnected instrument rather
 * than a powered-on one — the scales around it were always there, and they say far more than
 * the slab did. Sentence case, 10 px, tertiary ink, left-aligned inside the plot so it never
 * lands on top of a pen the moment the first sample arrives.
 * @param {CanvasRenderingContext2D} ctx Static context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintRestCaption(ctx, g, colors) {
  ctx.fillStyle = colors.ink3 || colors.fldStale;
  ctx.font = '10px ' + FONT_UI;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(ellipsize(ctx, 'Standby — no samples logged', g.plotW - 12), g.px0 + 6, g.py1 - 5);
}

/**
 * Paint every visible y axis: the spine, its ticks and its engineering unit. The `pct`
 * gutter additionally draws its `alt` scale in the alt pen's colour, which is how %B and
 * pH share one 40 px gutter without either becoming unreadable.
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Static context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintYAxes(chart, ctx, g, colors) {
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    if (!a.visible) continue;
    const left = a.side === 'left';
    const spineX = Math.round(a.gutterX) + 0.5;
    ctx.strokeStyle = colors.plotFrame;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(spineX, g.py0);
    ctx.lineTo(spineX, g.py1);
    ctx.stroke();

    let primaryUsed = false;
    let altPen = null;
    let ownPen = null;
    for (let j = 0; j < chart.pens.length; j++) {
      const p = chart.pens[j];
      if (!p.visible || axisOf(chart, p) !== a) continue;
      if (p.alt && a.alt) altPen = p;
      else {
        primaryUsed = true;
        if (!ownPen) ownPen = p;
      }
    }
    const showPrimary = primaryUsed || !altPen;
    const yp = yTickPlan(a, g);
    // A gutter serving exactly ONE pen is tinted with that pen, which is how an operator finds
    // the right scale without reading anything. A gutter serving several is left in neutral
    // axis ink and names its owners instead: tinting a shared scale with whichever pen
    // happened to be first in the rail claims an ownership that is not true.
    const soleOwner = ownPen && !altPen && (a.tagPens || []).length === 1;
    const primaryInk = soleOwner ? colors.pen[ownPen.id] : colors.plotAxis;
    ctx.font = '10px ' + FONT_NUM;
    ctx.textAlign = left ? 'right' : 'left';
    for (let k = 0; k < yp.count; k++) {
      const v = yp.first + k * yp.step;
      const py = a.b - v * a.k;
      if (py < g.py0 - 1 || py > g.py1 + 1) continue;
      ctx.strokeStyle = colors.plotFrame;
      ctx.beginPath();
      ctx.moveTo(spineX, Math.round(py) + 0.5);
      ctx.lineTo(spineX + (left ? -3 : 3), Math.round(py) + 0.5);
      ctx.stroke();
      if (!showPrimary) continue;
      ctx.fillStyle = primaryInk;
      ctx.fillText(v.toFixed(yp.decimals), spineX + (left ? -5 : 5), py);
    }
    if (altPen && a.alt) {
      const span = a.aMax - a.aMin;
      const aspan = a.alt.max - a.alt.min;
      // Clear the WIDEST primary label, rather than assuming a fixed 28 px of it. The primary can
      // read "1000.0" or "30", so one constant either overprints the wide case or leaves a hole
      // after the narrow one — the observed "x3" sitting on top of "30". Measured once per axis.
      let widest = 0;
      if (showPrimary) {
        for (let k = 0; k < yp.count; k++) {
          const w = ctx.measureText((yp.first + k * yp.step).toFixed(yp.decimals)).width;
          if (w > widest) widest = w;
        }
      }
      ctx.fillStyle = colors.pen[altPen.id];
      ctx.font = '9px ' + FONT_NUM;
      const clear = 5 + widest + 6;
      const off = showPrimary ? (left ? -clear : clear) : (left ? -5 : 5);
      for (let k = 0; k < yp.count; k++) {
        const v = yp.first + k * yp.step;
        const py = a.b - v * a.k;
        if (py < g.py0 - 1 || py > g.py1 + 1) continue;
        const av = a.alt.min + ((v - a.aMin) / span) * aspan;
        ctx.fillText(av.toFixed(0), spineX + off, py);
      }
    }

    // SCALE OWNERSHIP, at the top of the gutter: the ISA TAG or tags this scale serves, and
    // then its engineering unit. A matching pen colour is a hint, not a statement — an
    // operator reading a number off a gutter has to be able to say whose number it is, and
    // on a shared gutter each tag is drawn in its own pen's hue so the pairing is exact.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const labelX = spineX + (left ? -g.padL + 2 : 2);
    const budget = (left ? g.padL : RIGHT_AXIS_STEP) - 3;
    ctx.font = '600 10px ' + FONT_UI;
    ctx.fillStyle = primaryInk;
    const euText = a.eu + (altPen && a.alt && a.alt.eu ? '/' + a.alt.eu : '');
    ctx.fillText(ellipsize(ctx, euText, budget), labelX, g.py0 - 3);
    const owners = a.tagPens || [];
    const shown = Math.min(AXIS_TAG_LINES_MAX, owners.length);
    ctx.font = '600 9px ' + FONT_UI;
    for (let k = 0; k < shown; k++) {
      const p = owners[k];
      const more = owners.length - shown;
      const txt = k === shown - 1 && more > 0 ? p.tag + ' +' + more : p.tag;
      ctx.fillStyle = owners.length > 1 ? colors.pen[p.id] : primaryInk;
      ctx.fillText(
        ellipsize(ctx, txt, budget), labelX, g.py0 - 3 - AXIS_LABEL_LINE * (shown - k)
      );
    }
    ctx.textBaseline = 'middle';
  }
}

/* -------------------------------------------------------------------------- */
/* 11. OVERLAY LAYER                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The full caption of one pen's alarm limit: tag, ISA designation, threshold and unit —
 * `PT-101 HI 1.60 bar`. A bare `1.60` floating on a dashed line names neither the instrument
 * it guards nor the quantity it is measured in, and a line nobody can name is a line nobody
 * acts on.
 * @param {object} pen Pen carrying a finite `limit`.
 * @returns {string} Caption text.
 */
function limitCaption(pen) {
  return pen.tag + ' ' + (pen.limitCode || LIMIT_CODES.HI) + ' ' +
    pen.limit.toFixed(pen.dec) + (pen.eu ? ' ' + pen.eu : '');
}

/**
 * Draw a small captioned plate over the plot well, so a caption laid across live traces stays
 * readable without hiding them.
 * @param {CanvasRenderingContext2D} ctx Overlay context.
 * @param {object} colors Colour map in use.
 * @param {string} text Caption, already ellipsized by the caller if needed.
 * @param {number} x Left edge of the plate, css px.
 * @param {number} yBase Text baseline, css px.
 * @param {string} ink Text and border colour.
 * @returns {number} Plate width, css px.
 */
function captionPlate(ctx, colors, text, x, yBase, ink) {
  const w = ctx.measureText(text).width + 6;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = colors.plotBg;
  ctx.fillRect(x, yBase - 9, w, 11);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(yBase - 9) + 0.5, Math.round(w) - 1, 10);
  ctx.fillStyle = ink;
  ctx.fillText(text, x + 3, yBase);
  return w;
}

/**
 * Find a baseline near `want` that no caption already occupies, so two limit lines a few
 * pixels apart — or two loops whose setpoints happen to land together — print one above the
 * other instead of on top of each other. Pushes DOWN first, then up, then gives up and takes
 * the clamped position, because an overlapped caption is still better than a missing one.
 * @param {number[]} used Baselines already taken this pass; the chosen one is appended.
 * @param {number} want Preferred baseline, css px.
 * @param {number} lo Lowest legal baseline.
 * @param {number} hi Highest legal baseline.
 * @returns {number} The baseline to use.
 */
function freeCaptionY(used, want, lo, hi) {
  const step = 12;
  let y = clamp(want, lo, hi);
  for (let pass = 0; pass < 2; pass++) {
    const dir = pass === 0 ? step : -step;
    let cand = y;
    for (let k = 0; k < 8; k++) {
      let hit = false;
      for (let i = 0; i < used.length; i++) {
        if (Math.abs(used[i] - cand) < step) {
          hit = true;
          break;
        }
      }
      if (!hit && cand >= lo && cand <= hi) {
        used.push(cand);
        return cand;
      }
      cand += dir;
    }
  }
  used.push(y);
  return y;
}

/**
 * Format a PV-minus-SP deviation with an explicit sign, at the pen's own precision.
 *
 * A deviation that ROUNDS to zero prints as a plain `0.0`, never `-0.0`: a signed zero on an
 * operator screen reads as a sign error in the instrument, not as a loop sitting on target.
 * @param {number} dev PV minus SP, pen units.
 * @param {number} dec Fixed decimals.
 * @returns {string} Signed deviation, e.g. `'+1.2'`, `'-0.4'`, `'0.0'`.
 */
function signedDev(dev, dec) {
  const body = Math.abs(dev).toFixed(dec);
  if (parseFloat(body) === 0) return body;
  return (dev < 0 ? '-' : '+') + body;
}

/**
 * The newest logged row inside the visible window, or -1 when the window holds none. Used to
 * anchor the setpoint chips at the live end of each loop.
 * @param {object} chart The chart.
 * @returns {number} Row index, or -1.
 */
function lastRowInWindow(chart) {
  if (!chart.store || chart.store.n === 0) return -1;
  const x = column(chart.store, xChannel(chart));
  const n = x.length;
  if (n === 0) return -1;
  let i = lowerBoundF32(x, n, chart.x1);
  if (i >= n || x[i] > chart.x1) i--;
  if (i < 0 || x[i] < chart.x0) return -1;
  return i;
}

/**
 * Paint every visible pen's alarm limit line.
 *
 * NOT A SETPOINT, AND NOT DRESSED AS ONE. The line takes `--warn-ink` while the PV is inside
 * it and `--alarm-ink`, one step heavier, once the PV is through — never the pen's own hue,
 * which is what used to make a trip threshold look like the same kind of number as FIC-101's
 * setpoint. Its dash is the dash-DOT of {@link LIMIT_DASH}, not the setpoint's 5-4. And it
 * carries its whole identity — `PT-101 HI 1.60 bar` — on a plate at the left of the plot,
 * where the axis gutters are not competing for the space.
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Overlay context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintLimitLines(chart, ctx, g, colors) {
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.font = '600 9px ' + FONT_UI;
  const used = chart.captionY;
  used.length = 0;
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    if (!p.visible || !(p.limit === p.limit)) continue;
    const py = p.bPix - p.limit * p.kPix;
    if (py < g.py0 || py > g.py1) continue;
    const bad = p.limitState !== 'norm';
    const ink = bad ? colors.alarmInk : colors.warnInk;
    ctx.strokeStyle = ink;
    ctx.lineWidth = bad ? LIMIT_WIDTH_ALARM : LIMIT_WIDTH;
    ctx.setLineDash(LIMIT_DASH);
    ctx.lineDashOffset = g.px0 % LIMIT_DASH_PERIOD;
    ctx.beginPath();
    ctx.moveTo(g.px0, Math.round(py) + 0.5);
    ctx.lineTo(g.px1, Math.round(py) + 0.5);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
    ctx.lineDashOffset = 0;
    // Two limits on one gutter can land within a caption's height of each other; the second
    // one steps clear rather than printing on top of the first.
    const cy = freeCaptionY(used, Math.round(py) - 3, g.py0 + 10, g.py1);
    const text = ellipsize(ctx, limitCaption(p), Math.max(0, g.plotW - 12));
    if (text) captionPlate(ctx, colors, text, g.px0 + 3, cy, ink);
  }
}

/**
 * Name every setpoint where it lives, at the live end of its own dashed line.
 *
 * A LOOP DOING ITS JOB HIDES ITS OWN SETPOINT. FIC-101 running 196.2 against 196.0 puts the
 * PV and the SP within a pixel of each other, and two coincident lines in one hue identify
 * nothing. So each closed loop gets, at the right of the window: a leader spanning PV to SP
 * — visible as a tick even when the deviation is a fraction of a pixel — and a chip on the SP
 * line reading `SP +0.2`, the signed deviation of the PV from its target. The chip is small,
 * 9 px and quiet, so the setpoint stays subordinate to the measurement; it is unmistakable
 * because it is captioned, and the deviation is legible precisely when the lines are not.
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Overlay context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintSpChips(chart, ctx, g, colors) {
  const row = lastRowInWindow(chart);
  if (row < 0) return;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.font = '600 9px ' + FONT_UI;
  // Shared with the limit captions this pass: the right edge is one crowded strip, and a
  // setpoint chip must not land on a threshold caption any more than on another setpoint's.
  const used = chart.captionY;
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    if (!p.visible || p.dim || !p.spChannel) continue;
    const spCol = column(chart.store, p.spChannel);
    const sv = row < spCol.length ? spCol[row] : NaN;
    if (!(sv === sv)) continue;
    const spY = p.bPix - sv * p.kPix;
    if (spY < g.py0 || spY > g.py1) continue;
    const pvCol = column(chart.store, p.channel);
    const pv = row < pvCol.length ? pvCol[row] : NaN;
    const pvY = pv === pv ? clamp(p.bPix - pv * p.kPix, g.py0, g.py1) : NaN;
    const ink = colors.pen[p.id];

    // the PV-to-SP leader, with a cap at each end so a zero deviation still reads as a mark
    const lx = Math.round(g.px1 - 5) + 0.5;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (pvY === pvY) {
      ctx.moveTo(lx, Math.round(pvY) + 0.5);
      ctx.lineTo(lx, Math.round(spY) + 0.5);
      ctx.moveTo(lx - 3, Math.round(pvY) + 0.5);
      ctx.lineTo(lx + 3, Math.round(pvY) + 0.5);
    }
    ctx.moveTo(lx - 3, Math.round(spY) + 0.5);
    ctx.lineTo(lx + 3, Math.round(spY) + 0.5);
    ctx.stroke();

    const text = pv === pv ? 'SP ' + signedDev(pv - sv, p.dec) : 'SP';
    const w = ctx.measureText(text).width + 6;
    // Sit the chip on the far side of the setpoint from the PV, so it never covers the pen
    // whose deviation it is reporting.
    const below = !(pvY === pvY) || spY >= pvY;
    const cy = freeCaptionY(used, below ? spY + 11 : spY - 2, g.py0 + 10, g.py1);
    const x = clamp(g.px1 - 9 - w, g.px0 + 2, g.px1 - w - 2);
    if (w <= g.plotW - 4) captionPlate(ctx, colors, text, x, cy, ink);
  }
}

/**
 * Paint the alarm limit lines, the setpoint chips, the live edge, the crosshair, the drag
 * rectangle and the hover ribbon for narrow phase bands. Cleared and repainted every frame.
 *
 * The limit lines live here, above the traces, because a trip threshold that a trace can
 * hide is worse than no threshold at all.
 * @param {object} chart The chart.
 * @returns {void}
 */
function paintOverlay(chart) {
  const g = chart.geom;
  const ctx = chart.gOverlay;
  const colors = chart.colors;
  ctx.clearRect(0, 0, g.cssW, g.cssH);
  if (g.plotW <= 0) return;

  const span = chart.x1 - chart.x0;
  const kx = g.plotW / span;
  const bx = g.px0 - chart.x0 * kx;

  paintLimitLines(chart, ctx, g, colors);
  paintSpChips(chart, ctx, g, colors);

  // live edge
  if (chart.store && chart.store.n > 0) {
    const lx = liveX(chart) * kx + bx;
    if (lx >= g.px0 && lx <= g.px1) {
      ctx.strokeStyle = colors.plotAxis;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(lx) + 0.5, g.py0);
      ctx.lineTo(Math.round(lx) + 0.5, g.py1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.plotAxis;
      ctx.beginPath();
      ctx.moveTo(lx - 3, g.py0);
      ctx.lineTo(lx + 3, g.py0);
      ctx.lineTo(lx, g.py0 + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  // crosshair and per-pen dots
  if (chart.cursor.on && chart.cursor.x === chart.cursor.x) {
    const cx = chart.cursor.x * kx + bx;
    if (cx >= g.px0 - 1 && cx <= g.px1 + 1) {
      // The readout cursor is the one line that must survive crossing every pen, so it takes
      // primary ink rather than the quieter axis grey.
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 1;
      ctx.setLineDash(CROSS_DASH);
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, g.py0);
      ctx.lineTo(Math.round(cx) + 0.5, g.py1);
      ctx.stroke();
      ctx.setLineDash(EMPTY_DASH);
      for (let i = 0; i < chart.traces.length; i++) {
        const t = chart.traces[i];
        if (!t.pen.visible || !(t.cursorValue === t.cursorValue)) continue;
        const py = t.bPix - t.cursorValue * t.kPix;
        if (py < g.py0 || py > g.py1) continue;
        ctx.fillStyle = colors.pen[t.pen.id];
        if (t.isSp) ctx.fillRect(cx - 2.5, py - 2.5, 5, 5);
        else {
          ctx.beginPath();
          ctx.arc(cx, py, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // drag rectangle — a SELECTION, so it wears the accent, not the pooled-region amber
  const d = chart.drag;
  if (d.active && (d.mode === 'zoomX' || d.mode === 'zoomXY')) {
    const a0 = Math.min(d.px0, d.pxNow);
    const a1 = Math.max(d.px0, d.pxNow);
    const b0 = d.mode === 'zoomXY' ? Math.min(d.py0, d.pyNow) : g.py0;
    const b1 = d.mode === 'zoomXY' ? Math.max(d.py0, d.pyNow) : g.py1;
    ctx.globalAlpha = SELECT_FILL_ALPHA;
    ctx.fillStyle = colors.accent;
    ctx.fillRect(a0, b0, a1 - a0, b1 - b0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a0) + 0.5, Math.round(b0) + 0.5, Math.round(a1 - a0), Math.round(b1 - b0));
  }

  // hover ribbon for a band too narrow to carry its own label
  if (chart.hoverPx >= 0 && chart.bandLabelSpots.length > 0) {
    for (let i = 0; i < chart.bandLabelSpots.length; i++) {
      const sp = chart.bandLabelSpots[i];
      if (chart.hoverPx < sp.x0 || chart.hoverPx > sp.x1) continue;
      ctx.font = '600 10px ' + FONT_UI;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const w = ctx.measureText(sp.text).width + 8;
      const rx = clamp(sp.x0, g.px0, Math.max(g.px0, g.px1 - w));
      ctx.fillStyle = colors.panelHi;
      ctx.fillRect(rx, g.py0 - 15, w, 14);
      ctx.strokeStyle = colors.edge;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(rx) + 0.5, Math.round(g.py0 - 15) + 0.5, Math.round(w), 14);
      ctx.fillStyle = colors.ink;
      ctx.fillText(sp.text, rx + 4, g.py0 - 8);
      break;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 12. HISTORY STRIP                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Repaint the history strip: the whole run decimated with `log.decimateMinMax`, plus the
 * draggable window brush. Throttled to 4 Hz.
 * @param {object} chart The chart.
 * @returns {void}
 */
function paintOverview(chart) {
  if (!chart.ovCanvas) return;
  const ctx = chart.gOv;
  const colors = chart.colors;
  const w = chart.ovW;
  const hgt = chart.ovH;
  const dpr = chart.geom.dpr;
  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = colors.plotBg;
  ctx.fillRect(0, 0, w, hgt);
  chart.ovDirty = false;
  if (!chart.store || chart.store.n === 0) {
    // Empty, but not blank: one centre rule, so the strip reads as a powered instrument
    // waiting for history rather than as a dead bar.
    ctx.strokeStyle = colors.plotGrid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(hgt / 2) + 0.5);
    ctx.lineTo(w, Math.round(hgt / 2) + 0.5);
    ctx.stroke();
    return;
  }

  const xName = xChannel(chart);
  const xcol = column(chart.store, xName);
  const full1 = xcol.length > 0 ? xcol[xcol.length - 1] : 1;
  const full0 = 0;
  const span = full1 - full0 > 0 ? full1 - full0 : 1;
  const px0 = 1;
  const px1 = Math.max(px0 + 1, w - 1);
  const pix = Math.max(1, Math.round((px1 - px0) * dpr));
  if (!chart.ovMin || chart.ovMin.length < pix) {
    chart.ovMin = new Float32Array(pix);
    chart.ovMax = new Float32Array(pix);
  }
  const invDpr = 1 / dpr;
  for (let i = chart.traces.length - 1; i >= 0; i--) {
    const t = chart.traces[i];
    if (!t.pen.visible || t.isSp) continue;
    decimateMinMax(chart.store, xName, t.channel, full0, full1, pix, chart.ovMin, chart.ovMax);
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = 0; b < pix; b++) {
      const a = chart.ovMin[b];
      if (a !== a) continue;
      if (a < lo) lo = a;
      const c = chart.ovMax[b];
      if (c > hi) hi = c;
    }
    if (!(lo <= hi)) continue;
    if (hi === lo) hi = lo + 1;
    const k = (hgt - 4) / (hi - lo);
    const base = hgt - 2 + lo * k;
    ctx.strokeStyle = colors.pen[t.pen.id];
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let pen = false;
    for (let b = 0; b < pix; b++) {
      const a = chart.ovMin[b];
      if (a !== a) {
        pen = false;
        continue;
      }
      const x = px0 + (b + 0.5) * invDpr;
      const ya = base - a * k;
      const yb = base - chart.ovMax[b] * k;
      if (!pen) {
        ctx.moveTo(x, ya);
        pen = true;
      } else {
        ctx.lineTo(x, ya);
      }
      ctx.lineTo(x, yb);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // The brush marks WHICH SLICE of the run is on screen — a selection, so it wears the accent
  const kx = (px1 - px0) / span;
  const a0 = clamp(px0 + (chart.x0 - full0) * kx, px0, px1);
  const a1 = clamp(px0 + (chart.x1 - full0) * kx, px0, px1);
  ctx.globalAlpha = SELECT_FILL_ALPHA;
  ctx.fillStyle = colors.accent;
  ctx.fillRect(a0, 0, Math.max(2, a1 - a0), hgt);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(a0) + 0.5, 0.5, Math.max(2, Math.round(a1 - a0)), hgt - 1);
  chart.ovGeom = { px0, px1, full0, full1, kx };
}

/* -------------------------------------------------------------------------- */
/* 13. THE LEGEND RAIL                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build one recessed value field: an optional caption, the digits, an optional EU suffix.
 * The field carries the SUNKEN recipe and 2 px of radius; the digits are white for a PV,
 * amber for an SP and cyan for the cursor card, and both the caption and the unit sit in
 * tertiary ink so the number is the only thing that reads at a glance.
 * @param {string} kind Digit class suffix — `'pv'`, `'sp'` or `'x'`.
 * @param {string} caption Caption inside the box, uppercase, or `''`.
 * @param {string} eu Engineering unit suffix, or `''`.
 * @returns {{el:Element, val:Element, eu:Element, cap:Element|null}} The box.
 */
function labelBox(kind, caption, eu) {
  const cap = caption ? h('em', {}, caption) : null;
  const val = h('b', {}, '----');
  const euEl = h('u', {}, eu || '');
  const el = h('span', { class: 'ftx__fld ftx__fld--' + kind });
  if (cap) el.appendChild(cap);
  el.appendChild(val);
  el.appendChild(euEl);
  return { el, val, eu: euEl, cap };
}

/**
 * True when this pen owns an alarm limit and so earns a cell in the LIMIT column — either
 * because it watches an `ALARM_TABLE` signal or because a caller set a threshold outright.
 * @param {object} pen Pen.
 * @returns {boolean} Whether the LIMIT column has anything to say about this pen.
 */
function hasLimit(pen) {
  return !!pen.limitSignal || pen.limit === pen.limit;
}

/**
 * Build the LIMIT cell: designation, threshold, unit and alarm state, in one recessed field
 * that shares nothing but its geometry with the SP column beside it.
 *
 * It is a `button` because the one operator action a limit affords is ACKNOWLEDGE, and the
 * place to acknowledge an alarm is the field that is announcing it. Disabled — and therefore
 * skipped by {@link focusPenRail} and by the tab order — whenever nothing is in alarm.
 * @returns {{el:Element, val:Element, eu:Element, cap:Element, state:Element}} The cell.
 */
function limitCell() {
  const cap = h('em', {}, LIMIT_CODES.HI);
  const val = h('b', {}, '----');
  const euEl = h('u', {}, '');
  const stEl = h('s', {}, LIMIT_STATE_WORD.norm);
  const el = h(
    'button',
    { class: 'ftx__fld ftx__fld--lim', type: 'button', disabled: true },
    cap, val, euEl, stEl
  );
  return { el, val, eu: euEl, cap, state: stEl };
}

/**
 * Recompute one pen's alarm state from its newest PV, and return it.
 *
 * The excursion, not the acknowledgement, is what persists: an ACK holds only for as long as
 * the PV stays through the threshold. A PV that recovers and then breaks the limit a second
 * time is a NEW alarm and demands a new acknowledgement, which is the behaviour of every
 * non-latching alarm on the skid and the only one an operator can trust at handover.
 * @param {object} pen Pen.
 * @param {number} pv Newest PV, or `NaN`.
 * @returns {'norm'|'alarm'|'ack'} The alarm state, also cached on `pen.limitState`.
 */
function updateLimitState(pen, pv) {
  if (!(pen.limit === pen.limit)) {
    pen.limitAck = false;
    pen.limitState = 'norm';
    return 'norm';
  }
  const through = pv === pv && (pen.limitRising ? pv > pen.limit : pv < pen.limit);
  if (!through) pen.limitAck = false;
  pen.limitState = !through ? 'norm' : pen.limitAck ? 'ack' : 'alarm';
  return pen.limitState;
}

/**
 * Write one pen's LIMIT cell: the ISA designation, the threshold at the pen's own precision,
 * the engineering unit and the state word. Nothing here is ever borrowed from the SP column.
 * @param {object} pen Pen.
 * @param {{el:Element, val:Element, eu:Element, cap:Element, state:Element}} box The cell.
 * @param {'norm'|'alarm'|'ack'} state Current alarm state.
 * @returns {void}
 */
function writeLimitCell(pen, box, state) {
  const code = pen.limitCode || LIMIT_CODES.HI;
  setText(box.cap, code);
  setText(box.val, fmtBox(pen.limit, pen.dec));
  setText(box.eu, pen.eu || '');
  setText(box.state, LIMIT_STATE_WORD[state]);
  cls(box.el, 'is-alm', state === 'alarm');
  cls(box.el, 'is-ack', state === 'ack');
  const canAck = state === 'alarm';
  if (box.el.disabled === canAck) box.el.disabled = !canAck;
  const said = pen.tag + ' ' + code + ' alarm limit ' + fmtBox(pen.limit, pen.dec) +
    (pen.eu ? ' ' + pen.eu : '') + ', ' + LIMIT_STATE_SAID[state] +
    (canAck ? '. Activate to acknowledge.' : '.');
  setAttr(box.el, 'aria-label', said);
  setAttr(box.el, 'title', said);
}

/**
 * The tooltip for one pen, taken verbatim from `data/glossary.js`. The screen carries no
 * prose; every word of explanation lives here.
 * @param {object} pen Pen.
 * @returns {string} Title text, possibly empty.
 */
function penTitle(pen) {
  const ids = [pen.gloss, pen.tag, pen.channel];
  for (let i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    const e = glossaryFor(ids[i]);
    if (e) return e.term + '\n' + e.short;
  }
  return pen.tag + (pen.eu ? ' (' + pen.eu + ')' : '');
}

/**
 * Build the legend rail: one row per pen — a line-style sample carrying every stroke that pen
 * puts on the plot, its ISA tag, its engineering unit, its on/off checkbox, and then the
 * three-column numeric grid PV | SP | LIMIT.
 *
 * THE THREE COLUMNS ARE NOT INTERCHANGEABLE. PV is the measurement. SP is a control target
 * and appears ONLY for a tag that has a controller behind it — FIC-101 and AIC-101 here; for
 * every other tag that cell is empty, and it is never filled with something else because
 * there was room. LIMIT is a protection threshold, in its own column, in its own ink, with
 * its own ISA designation and its own alarm state.
 *
 * The rail is fully populated before the first sample: an extinguished pen and an unstarted
 * run both show a field of dashes in the stale ink, never an empty row.
 * @param {object} chart The chart.
 * @returns {void}
 */
function buildRail(chart) {
  const rows = chart.railRows;
  // Drop the previous pass' row listeners before their elements go, so a rail rebuilt
  // twenty times over a session does not leave twenty dead entries behind.
  for (let i = 0; i < chart.railListeners.length; i++) {
    const rec = chart.railListeners[i];
    try {
      rec[0].removeEventListener(rec[1], rec[2]);
    } catch (err) {
      /* element already gone */
    }
    const at = chart.listeners.indexOf(rec);
    if (at >= 0) chart.listeners.splice(at, 1);
  }
  chart.railListeners.length = 0;
  while (rows.firstChild) rows.removeChild(rows.firstChild);
  for (let i = 0; i < chart.pens.length; i++) {
    const pen = chart.pens[i];
    const limited = hasLimit(pen);
    const chip = h('span', { class: 'ftx__chip' }, h('i', { class: 'pv' }));
    if (pen.spChannel) chip.appendChild(h('i', { class: 'sp' }));
    if (limited) chip.appendChild(h('i', { class: 'lim' }));
    const tagEl = h('span', { class: 'ftx__tag', title: penTitle(pen) }, pen.tag);
    const euEl = h('span', {
      class: 'ftx__eu',
      title: pen.eu ? pen.tag + ' engineering unit: ' + pen.eu : '',
    }, pen.eu || '');
    const hdEl = h('span', { class: 'ftx__hd' }, tagEl, euEl);
    const cb = h('input', {
      class: 'ftx__cb',
      type: 'checkbox',
      'aria-label': pen.tag + ' pen on trend',
      title: pen.tag + ' pen on trend',
    });
    cb.checked = pen.visible;
    // The unit is stated once on the row's own header line, so the three numeric columns
    // carry nothing but numbers and stay aligned across the whole rail.
    const pv = labelBox('pv', '', '');
    setAttr(pv.el, 'title', pen.tag + ' process variable' + (pen.eu ? ', ' + pen.eu : ''));
    const flds = h('div', { class: 'ftx__flds' }, pv.el);
    let sp = null;
    if (pen.spChannel) {
      sp = labelBox('sp', 'SP', '');
      setAttr(sp.el, 'title', pen.tag + ' control setpoint' + (pen.eu ? ', ' + pen.eu : ''));
      flds.appendChild(sp.el);
    }
    let lim = null;
    if (limited) {
      lim = limitCell();
      flds.appendChild(lim.el);
    }
    const row = h('div', { class: 'ftx__row' }, chip, hdEl, cb, flds);
    row.style.color = chart.colors.pen[pen.id];
    rows.appendChild(row);

    const onToggle = () => {
      setPenVisible(chart, pen.id, cb.checked);
    };
    cb.addEventListener('change', onToggle);
    const onFocus = () => {
      setPenFocus(chart, chart.focusPen === pen.id ? null : pen.id);
    };
    tagEl.addEventListener('click', onFocus);
    const recA = [cb, 'change', onToggle];
    const recB = [tagEl, 'click', onFocus];
    chart.listeners.push(recA, recB);
    chart.railListeners.push(recA, recB);
    if (lim) {
      const onAck = () => {
        acknowledgeLimit(chart, pen.id);
      };
      lim.el.addEventListener('click', onAck);
      const recC = [lim.el, 'click', onAck];
      chart.listeners.push(recC);
      chart.railListeners.push(recC);
    }

    pen.row = { el: row, chip, tagEl, euEl, cb, pv, sp, lim };
  }
  chart.railKey = railKey(chart);
  paintRailChips(chart);
  updateRail(chart);
}

/**
 * A cheap signature of the rail's structure, so it is rebuilt only when it must be.
 * @param {object} chart The chart.
 * @returns {string} Signature.
 */
function railKey(chart) {
  let k = '';
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    // Whether the LIMIT column exists at all is structural, so a threshold that arrives after
    // the rail was built — the usual order, since `config.alarms` is applied after mount —
    // grows the cell on the next rail tick instead of waiting for an unrelated rebuild.
    k += p.id + ',' + p.tag + ',' + p.eu + ',' + (p.spChannel || '') +
      ',' + (hasLimit(p) ? '1' : '0') + '|';
  }
  return k;
}

/**
 * Re-tint every rail row after a theme change: `currentColor` carries the pen hue into the
 * chip, the checkbox tick and nothing else.
 * @param {object} chart The chart.
 * @returns {void}
 */
function paintRailChips(chart) {
  for (let i = 0; i < chart.pens.length; i++) {
    const pen = chart.pens[i];
    if (pen.row) pen.row.el.style.color = chart.colors.pen[pen.id];
  }
}

/**
 * The newest logged value of a channel.
 * @param {object} chart The chart.
 * @param {string} name Channel name.
 * @returns {number} Value, or `NaN`.
 */
function lastValue(chart, name) {
  if (!chart.store) return NaN;
  const y = column(chart.store, name);
  return y.length > 0 ? y[y.length - 1] : NaN;
}

/**
 * Refresh every label box in the rail. Shows the value AT THE CURSOR while the crosshair
 * is down and the live value otherwise, which is the classic trend behaviour. Throttled to
 * 10 Hz; the DOM is never rebuilt here.
 * @param {object} chart The chart.
 * @returns {void}
 */
function updateRail(chart) {
  const atCursor = chart.cursor.on;
  for (let i = 0; i < chart.pens.length; i++) {
    const pen = chart.pens[i];
    const r = pen.row;
    if (!r) continue;
    cls(r.el, 'ftx__row--off', !pen.visible);
    cls(r.el, 'ftx__row--focus', chart.focusPen === pen.id);
    if (r.cb.checked !== pen.visible) r.cb.checked = pen.visible;
    setText(r.euEl, pen.eu || '');

    const pv = atCursor && pen.pvTrace ? pen.pvTrace.cursorValue : lastValue(chart, pen.channel);
    setText(r.pv.val, fmtBox(pv, pen.dec));
    // ALARM STATE IS COMPUTED FROM THE LIMIT, in the limit's own sense: a rising threshold is
    // broken from above and a falling one from below. It is evaluated for every pen, lit or
    // not, so extinguishing a pen never extinguishes its alarm.
    const state = updateLimitState(pen, pv);
    cls(r.pv.el, 'ftx__fld--alarm', state !== 'norm');
    cls(r.pv.el, 'ftx__fld--stale', !(pv === pv));
    cls(r.el, 'ftx__row--alm', state !== 'norm');

    // The SP cell exists only where a controller does. There is no fallback branch here on
    // purpose: nothing else may ever be written into this field.
    if (r.sp) {
      const sv = atCursor && pen.spTrace
        ? pen.spTrace.cursorValue
        : lastValue(chart, pen.spChannel);
      setText(r.sp.val, fmtBox(sv, pen.dec));
      cls(r.sp.el, 'ftx__fld--stale', !(sv === sv));
    }
    if (r.lim) writeLimitCell(pen, r.lim, state);
  }
}

/* -------------------------------------------------------------------------- */
/* 14. CURSOR READOUT                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Nearest logged row to an x position, and the x values of that row in all three units.
 * @param {object} chart The chart.
 * @param {number} x Target x, current x-channel unit.
 * @returns {{index:number, x:number, volume:number, time:number, cv:number}|null} Sample.
 */
function sampleAt(chart, x) {
  if (!chart.store || chart.store.n === 0) return null;
  const xc = column(chart.store, xChannel(chart));
  const n = xc.length;
  if (n === 0) return null;
  let i = lowerBoundF32(xc, n, x);
  if (i >= n) i = n - 1;
  if (i > 0 && Math.abs(xc[i - 1] - x) <= Math.abs(xc[i] - x)) i--;
  const v = column(chart.store, chart.xChannels.volume || XCH_DEFAULT.volume);
  const t = column(chart.store, chart.xChannels.time || XCH_DEFAULT.time);
  const c = column(chart.store, chart.xChannels.cv || XCH_DEFAULT.cv);
  return {
    index: i,
    x: xc[i],
    volume: i < v.length ? v[i] : NaN,
    time: i < t.length ? t[i] : NaN,
    cv: i < c.length ? c[i] : NaN,
  };
}

/**
 * Update the cursor card — three label boxes carrying the x position in volume, time and
 * column volumes — and cache every trace's value at the cursor for the rail, the overlay
 * dots and {@link hitTest}.
 * @param {object} chart The chart.
 * @param {number} pxCss Pointer x in host-local css px, or `NaN` to hide.
 * @param {number} pyCss Pointer y in host-local css px.
 * @returns {void}
 */
function updateCursor(chart, pxCss, pyCss) {
  const g = chart.geom;
  if (!(pxCss === pxCss) || !chart.store || chart.store.n === 0) {
    chart.cursor.on = false;
    cls(chart.card, 'ftx__card--on', false);
    for (let i = 0; i < chart.traces.length; i++) chart.traces[i].cursorValue = NaN;
    chart.railDue = 0;
    if (chart.handlers.onCursor) chart.handlers.onCursor(null);
    return;
  }
  const span = chart.x1 - chart.x0;
  const xVal = chart.x0 + ((pxCss - g.px0) / g.plotW) * span;
  const smp = sampleAt(chart, xVal);
  if (!smp) return;
  chart.cursor.on = true;
  chart.cursor.x = smp.x;
  chart.cursor.index = smp.index;

  // Every trace is read, lit or not: an extinguished pen still owes the operator its
  // number in the rail. Only the overlay dots and the strokes honour visibility.
  const values = Object.create(null);
  for (let i = 0; i < chart.traces.length; i++) {
    const t = chart.traces[i];
    const y = column(chart.store, t.channel);
    const v = smp.index < y.length ? y[smp.index] : NaN;
    t.cursorValue = v;
    if (!t.isSp) values[t.pen.id] = v;
  }

  setText(chart.cardV.val, fmtBox(smp.volume, 1));
  setText(chart.cardT.val, fmtBox(smp.time === smp.time ? smp.time / 60 : NaN, 2));
  setText(chart.cardC.val, fmtBox(smp.cv, 3));

  const cardW = 200;
  const rightRoom = g.px1 - pxCss;
  const left = rightRoom < cardW + 12 ? pxCss - cardW - 10 : pxCss + 10;
  const top = clamp(pyCss - 8, g.py0, Math.max(g.py0, g.py1 - 24));
  chart.card.style.transform =
    'translate(' + Math.round(clamp(left, 1, Math.max(1, g.cssW - cardW - 1))) + 'px,' +
    Math.round(top) + 'px)';
  cls(chart.card, 'ftx__card--on', true);
  chart.dirty.overlay = true;
  chart.railDue = 0;
  if (chart.handlers.onCursor) {
    chart.handlers.onCursor({
      x: smp.x, index: smp.index, volume: smp.volume, time: smp.time, cv: smp.cv, values,
    });
  }
}

/**
 * Announce the readout cursor into the polite live region, throttled to one announcement
 * per 400 ms. Screen-reader text is the one place a full sentence belongs.
 * @param {object} chart The chart.
 * @param {number} now_ms Frame or event timestamp.
 * @returns {void}
 */
function announceCursor(chart, now_ms) {
  if (now_ms - chart.lastAria_ms < ARIA_PERIOD_MS) return;
  chart.lastAria_ms = now_ms;
  if (!chart.cursor.on) return;
  let msg = 'At ' + toDisp(chart, chart.cursor.x).toFixed(2) + ' ' + X_EU[chart.xMode] + '. ';
  for (let i = 0; i < chart.traces.length; i++) {
    const t = chart.traces[i];
    if (!t.pen.visible || !(t.cursorValue === t.cursorValue)) continue;
    msg += t.pen.tag + (t.isSp ? ' setpoint ' : ' ') +
      t.cursorValue.toFixed(t.pen.dec) + ' ' + (t.pen.eu || '') + '. ';
  }
  setText(chart.srLive, msg);
}

/**
 * Refresh the traces canvas' `aria-label` summary, at most once per second.
 * @param {object} chart The chart.
 * @param {number} now_ms Frame timestamp.
 * @returns {void}
 */
function updateAriaLabel(chart, now_ms) {
  if (now_ms - chart.lastLabel_ms < 1000) return;
  chart.lastLabel_ms = now_ms;
  let n = 0;
  let latest = '';
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    if (!p.visible) continue;
    n++;
    if (chart.store && chart.store.n > 0 && latest.length < 140) {
      const v = lastValue(chart, p.channel);
      if (v === v) latest += p.tag + ' ' + v.toFixed(p.dec) + ' ' + (p.eu || '') + '; ';
    }
  }
  const label =
    'Process trend. X axis ' + chart.xMode + ', ' + toDisp(chart, chart.x0).toFixed(1) +
    ' to ' + toDisp(chart, chart.x1).toFixed(1) + ' ' + X_EU[chart.xMode] + '. ' + n +
    ' pens shown. ' + (latest ? 'Latest ' + latest : 'No data yet.');
  chart.cvTraces.setAttribute('aria-label', label);
}

/* -------------------------------------------------------------------------- */
/* 15. ACCESSIBLE DATA TABLE                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the accessible data table: the run sampled at every 1 % of its x range. This is
 * the accessible alternative to the canvas, not an afterthought. Column headers are the
 * ISA tag with its engineering unit underneath — never a phrase.
 * @param {object} chart The chart.
 * @returns {void}
 */
function rebuildTable(chart) {
  const wrap = chart.tableWrap;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  chart.tableCells = null;
  if (!chart.store || chart.store.n === 0) {
    wrap.appendChild(h('table', {}, h('caption', { class: 'ftx__sr' }, 'Trend data: no samples yet')));
    return;
  }
  const vis = [];
  for (let i = 0; i < chart.traces.length; i++) {
    if (chart.traces[i].pen.visible) vis.push(chart.traces[i]);
  }
  const head = [h('th', { scope: 'col' }, X_EU[chart.xMode])];
  for (let i = 0; i < vis.length; i++) {
    const t = vis[i];
    head.push(h(
      'th', { scope: 'col' },
      t.pen.tag + (t.isSp ? ' SP' : ''),
      h('small', {}, t.pen.eu || '')
    ));
  }
  const rows = [];
  const cells = [];
  for (let k = 0; k <= 100; k++) {
    const tds = [h('td', {}, '')];
    const rowCells = [];
    for (let i = 0; i < vis.length; i++) {
      const td = h('td', {}, '');
      tds.push(td);
      rowCells.push(td);
    }
    cells.push({ x: tds[0], vals: rowCells });
    rows.push(h('tr', {}, ...tds));
  }
  wrap.appendChild(h(
    'table', {},
    h('caption', { class: 'ftx__sr' }, 'Trend data, sampled every 1 % of the run'),
    h('thead', {}, h('tr', {}, ...head)),
    h('tbody', {}, ...rows)
  ));
  chart.tableCells = cells;
  chart.tableTraces = vis;
  fillTable(chart);
}

/**
 * Refresh the data table's cell text without rebuilding any DOM.
 * @param {object} chart The chart.
 * @returns {void}
 */
function fillTable(chart) {
  if (!chart.tableCells || !chart.store || chart.store.n === 0) return;
  const xc = column(chart.store, xChannel(chart));
  const n = xc.length;
  if (n === 0) return;
  const x1 = xc[n - 1];
  const vis = chart.tableTraces;
  const cols = new Array(vis.length);
  for (let i = 0; i < vis.length; i++) cols[i] = column(chart.store, vis[i].channel);
  for (let k = 0; k <= 100; k++) {
    const target = (x1 * k) / 100;
    let idx = lowerBoundF32(xc, n, target);
    if (idx >= n) idx = n - 1;
    const cell = chart.tableCells[k];
    setText(cell.x, toDisp(chart, xc[idx]).toFixed(2));
    for (let i = 0; i < vis.length; i++) {
      const v = idx < cols[i].length ? cols[i][idx] : NaN;
      setText(cell.vals[i], v === v ? v.toFixed(vis[i].pen.dec) : '');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 16. INTERACTION                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Apply a new x window, clamping the span so a zoom can never invert or collapse.
 * @param {object} chart The chart.
 * @param {number} x0 New start, x-channel unit.
 * @param {number} x1 New end, x-channel unit.
 * @param {boolean} manual True when the change came from the operator, which drops follow
 *   and auto-fit.
 * @returns {void}
 */
function applyWindow(chart, x0, x1, manual) {
  let a = x0;
  let b = x1;
  if (!(isFinite(a) && isFinite(b))) return;
  if (b < a) {
    const t = a;
    a = b;
    b = t;
  }
  const minSpan = chart.xMode === 'time' ? 0.5 : 1e-4;
  if (b - a < minSpan) {
    const c = (a + b) / 2;
    a = c - minSpan / 2;
    b = c + minSpan / 2;
  }
  chart.x0 = a;
  chart.x1 = b;
  if (manual && (chart.follow || chart.autoFit)) {
    chart.follow = false;
    chart.autoFit = false;
    syncToolbar(chart);
  }
  chart.blit.valid = false;
  chart.tableValid = false;
  chart.ovDirty = true;
  chart.dirty.static = true;
  chart.dirty.traces = true;
  chart.dirty.overlay = true;
  if (chart.handlers.onZoom) chart.handlers.onZoom({ x0: chart.x0, x1: chart.x1, mode: chart.xMode });
}

/**
 * Reset to the whole run: auto-fit plus live follow, and every y axis back to autoscale.
 * @param {object} chart The chart.
 * @returns {void}
 */
function resetView(chart) {
  chart.autoFit = true;
  chart.follow = true;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    if (a.userManual) {
      a.mode = a.baseMode;
      a.userManual = false;
    }
  }
  chart.blit.valid = false;
  chart.dirty.static = true;
  chart.dirty.traces = true;
  chart.ovDirty = true;
  updateFollowWindow(chart);
  syncToolbar(chart);
  if (chart.handlers.onZoom) chart.handlers.onZoom({ x0: chart.x0, x1: chart.x1, mode: chart.xMode });
}

/**
 * True when at least one axis is under a manual y override.
 * @param {object} chart The chart.
 * @returns {boolean} Manual override state.
 */
function anyManualY(chart) {
  for (let i = 0; i < chart.yAxes.length; i++) {
    if (chart.yAxes[i].userManual) return true;
  }
  return false;
}

/**
 * Return every autoscaled axis to autoscale, dropping a manual y override.
 * @param {object} chart The chart.
 * @returns {void}
 */
function releaseManualY(chart) {
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    if (!a.userManual) continue;
    a.mode = a.baseMode;
    a.userManual = false;
    a.easeT0 = 0;
    a.targetMax = a.aMax;
  }
  chart.blit.valid = false;
  chart.dirty.static = true;
  chart.dirty.traces = true;
  syncToolbar(chart);
}

/**
 * Push chart state back onto the toolbar's pressed states. Icon buttons carry no text, so
 * `aria-pressed` and the sunken bevel are the entire status vocabulary.
 * @param {object} chart The chart.
 * @returns {void}
 */
function syncToolbar(chart) {
  const b = chart.btn;
  if (!b) return;
  b.xVol.setAttribute('aria-pressed', chart.xMode === 'volume' ? 'true' : 'false');
  b.xTime.setAttribute('aria-pressed', chart.xMode === 'time' ? 'true' : 'false');
  b.xCV.setAttribute('aria-pressed', chart.xMode === 'cv' ? 'true' : 'false');
  b.live.setAttribute('aria-pressed', chart.follow ? 'true' : 'false');
  b.yAuto.setAttribute('aria-pressed', anyManualY(chart) ? 'false' : 'true');
  b.table.setAttribute('aria-pressed', chart.tableOpen ? 'true' : 'false');
}

/**
 * Pixel x -> x-channel value.
 * @param {object} chart The chart.
 * @param {number} px Host-local css px.
 * @returns {number} x value.
 */
function pxToX(chart, px) {
  const g = chart.geom;
  return chart.x0 + ((px - g.px0) / g.plotW) * (chart.x1 - chart.x0);
}

/**
 * Which pool handle, if any, is under a pointer position.
 * @param {object} chart The chart.
 * @param {number} px Host-local css px.
 * @param {number} py Host-local css px.
 * @returns {'left'|'right'|'move'|null} Handle identity.
 */
function poolHandleAt(chart, px, py) {
  const p = chart.pool;
  if (!p.on) return null;
  const g = chart.geom;
  const kx = g.plotW / (chart.x1 - chart.x0);
  const bx = g.px0 - chart.x0 * kx;
  const a0 = p.x0 * kx + bx;
  const a1 = p.x1 * kx + bx;
  if (py < g.py0 || py > g.py1) return null;
  if (Math.abs(px - a0) <= 5) return 'left';
  if (Math.abs(px - a1) <= 5) return 'right';
  if (px > a0 && px < a1 && py <= g.py0 + 8) return 'move';
  return null;
}

/**
 * Scale every autoscaled axis about a pixel anchor (ctrl+wheel). Axes move to manual so
 * the operator's choice is not immediately overwritten by the autoscaler.
 * @param {object} chart The chart.
 * @param {number} py Anchor, host-local css px.
 * @param {number} factor Zoom factor > 0.
 * @returns {void}
 */
function zoomYAbout(chart, py, factor) {
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    if (!a.visible) continue;
    const anchor = (a.b - py) / (a.k || 1);
    const lo = anchor - (anchor - a.aMin) * factor;
    const hi = anchor + (a.aMax - anchor) * factor;
    if (!(hi > lo)) continue;
    a.mode = 'manual';
    a.userManual = true;
    a.min = lo;
    a.max = hi;
  }
  chart.blit.valid = false;
  chart.dirty.static = true;
  chart.dirty.traces = true;
  syncToolbar(chart);
}

/**
 * Zoom the y axes to a pixel band (shift-drag box zoom).
 * @param {object} chart The chart.
 * @param {number} pyTop Top of the band, css px.
 * @param {number} pyBot Bottom of the band, css px.
 * @returns {void}
 */
function zoomYToRect(chart, pyTop, pyBot) {
  if (pyBot - pyTop < 6) return;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    if (!a.visible || !(a.k > 0)) continue;
    const hi = (a.b - pyTop) / a.k;
    const lo = (a.b - pyBot) / a.k;
    if (!(hi > lo)) continue;
    a.mode = 'manual';
    a.userManual = true;
    a.min = lo;
    a.max = hi;
  }
  syncToolbar(chart);
}

/**
 * Step the accessible readout cursor by whole samples and announce it.
 * @param {object} chart The chart.
 * @param {number} dir -1, 0 or +1 samples.
 * @returns {void}
 */
function moveReadout(chart, dir) {
  if (!chart.store || chart.store.n === 0) return;
  const g = chart.geom;
  let i = chart.cursor.index + dir;
  i = clamp(i, 0, chart.store.n - 1);
  const xc = column(chart.store, xChannel(chart));
  if (i >= xc.length) i = xc.length - 1;
  const xv = xc[i];
  const px = g.px0 + ((xv - chart.x0) / (chart.x1 - chart.x0)) * g.plotW;
  updateCursor(chart, clamp(px, g.px0, g.px1), (g.py0 + g.py1) / 2);
  chart.cursor.index = i;
  announceCursor(chart, performance.now());
  chart.dirty.overlay = true;
}

/**
 * Wire pointer, wheel and keyboard interaction on the plot well.
 * @param {object} chart The chart.
 * @returns {void}
 */
function bindInteractions(chart) {
  const el = chart.cvOverlay;

  const onDown = (e) => {
    if (chart.destroyed) return;
    const px = e.offsetX;
    const py = e.offsetY;
    const g = chart.geom;
    chart.wellEl.focus({ preventScroll: true });
    const handle = poolHandleAt(chart, px, py);
    if (handle && e.button === 0) {
      chart.drag.active = true;
      chart.drag.mode = 'pool';
      chart.drag.handle = handle;
      chart.drag.px0 = px;
      chart.drag.poolX0 = chart.pool.x0;
      chart.drag.poolX1 = chart.pool.x1;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (px < g.px0 || px > g.px1) return;
    const pan = e.button === 1 || chart.spaceDown;
    chart.drag.active = true;
    chart.drag.mode = pan ? 'pan' : e.shiftKey ? 'zoomXY' : 'zoomX';
    chart.drag.px0 = px;
    chart.drag.py0 = py;
    chart.drag.pxNow = px;
    chart.drag.pyNow = py;
    chart.drag.winX0 = chart.x0;
    chart.drag.winX1 = chart.x1;
    chart.interacting = true;
    chart.blit.valid = false;
    cls(chart.wellEl, 'ftx__well--panning', pan);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onMove = (e) => {
    if (chart.destroyed) return;
    const px = e.offsetX;
    const py = e.offsetY;
    chart.hoverPx = px;
    const d = chart.drag;
    if (!d.active) {
      updateCursor(chart, px, py);
      chart.dirty.overlay = true;
      const hh = poolHandleAt(chart, px, py);
      cls(chart.wellEl, 'ftx__well--pool', hh !== null);
      cls(chart.wellEl, 'ftx__well--pan', chart.spaceDown);
      return;
    }
    d.pxNow = px;
    d.pyNow = py;
    if (d.mode === 'pan') {
      const span = d.winX1 - d.winX0;
      const dx = ((d.px0 - px) / chart.geom.plotW) * span;
      applyWindow(chart, d.winX0 + dx, d.winX1 + dx, true);
    } else if (d.mode === 'pool') {
      const xv = pxToX(chart, px);
      if (d.handle === 'left') chart.pool.x0 = Math.min(xv, chart.pool.x1);
      else if (d.handle === 'right') chart.pool.x1 = Math.max(xv, chart.pool.x0);
      else {
        const dx = xv - pxToX(chart, d.px0);
        chart.pool.x0 = d.poolX0 + dx;
        chart.pool.x1 = d.poolX1 + dx;
      }
      chart.dirty.static = true;
      if (chart.handlers.onPoolDrag) chart.handlers.onPoolDrag({ x0: chart.pool.x0, x1: chart.pool.x1 });
    }
    chart.dirty.overlay = true;
  };

  const onUp = (e) => {
    if (chart.destroyed) return;
    const d = chart.drag;
    if (!d.active) return;
    d.active = false;
    chart.interacting = false;
    cls(chart.wellEl, 'ftx__well--panning', false);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* pointer already released */
    }
    if (d.mode === 'zoomX' || d.mode === 'zoomXY') {
      const dx = Math.abs(d.pxNow - d.px0);
      if (dx >= 6) {
        const a = pxToX(chart, Math.min(d.px0, d.pxNow));
        const b = pxToX(chart, Math.max(d.px0, d.pxNow));
        if (chart.handlers.onSelect) chart.handlers.onSelect({ x0: a, x1: b, mode: chart.xMode });
        if (d.mode === 'zoomXY') zoomYToRect(chart, Math.min(d.py0, d.pyNow), Math.max(d.py0, d.pyNow));
        applyWindow(chart, a, b, true);
      }
    } else if (d.mode === 'pool' && chart.handlers.onPoolDrag) {
      chart.handlers.onPoolDrag({ x0: chart.pool.x0, x1: chart.pool.x1, done: true });
    }
    chart.dirty.overlay = true;
  };

  const onLeave = () => {
    chart.hoverPx = -1;
    if (!chart.drag.active && !chart.readoutMode) updateCursor(chart, NaN, NaN);
    chart.dirty.overlay = true;
  };

  const onWheel = (e) => {
    if (chart.destroyed) return;
    const g = chart.geom;
    const px = e.offsetX;
    if (px < g.px0 || px > g.px1) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    if (e.ctrlKey) {
      zoomYAbout(chart, e.offsetY, factor);
      return;
    }
    const anchor = pxToX(chart, px);
    const a = anchor - (anchor - chart.x0) * factor;
    const b = anchor + (chart.x1 - anchor) * factor;
    applyWindow(chart, a, b, true);
  };

  const onDbl = (e) => {
    e.preventDefault();
    resetView(chart);
  };

  const onKeyDown = (e) => {
    if (chart.destroyed) return;
    const k = e.key;
    if (k === ' ') {
      chart.spaceDown = true;
      cls(chart.wellEl, 'ftx__well--pan', true);
      e.preventDefault();
      return;
    }
    if (k === 'Escape') {
      if (chart.readoutMode) {
        chart.readoutMode = false;
        updateCursor(chart, NaN, NaN);
        chart.dirty.overlay = true;
        e.preventDefault();
      }
      return;
    }
    if (k === 'Enter') {
      chart.readoutMode = !chart.readoutMode;
      if (chart.readoutMode) {
        chart.cursor.index = chart.store && chart.store.n > 0 ? chart.store.n - 1 : -1;
        moveReadout(chart, 0);
      } else {
        updateCursor(chart, NaN, NaN);
      }
      e.preventDefault();
      return;
    }
    if (k === 'Home' || k === 'End') {
      if (k === 'Home') applyWindow(chart, 0, chart.x1 - chart.x0, true);
      else setFollow(chart, true);
      e.preventDefault();
      return;
    }
    if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    e.preventDefault();
    const dir = k === 'ArrowRight' ? 1 : -1;
    if (chart.readoutMode) {
      moveReadout(chart, dir);
      return;
    }
    const span = chart.x1 - chart.x0;
    const step = span * (e.shiftKey ? 0.25 : 0.05) * dir;
    applyWindow(chart, chart.x0 + step, chart.x1 + step, true);
  };

  const onKeyUp = (e) => {
    if (e.key === ' ') {
      chart.spaceDown = false;
      cls(chart.wellEl, 'ftx__well--pan', false);
    }
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', onDbl);
  chart.wellEl.addEventListener('keydown', onKeyDown);
  chart.wellEl.addEventListener('keyup', onKeyUp);
  chart.listeners.push(
    [el, 'pointerdown', onDown], [el, 'pointermove', onMove], [el, 'pointerup', onUp],
    [el, 'pointercancel', onUp], [el, 'pointerleave', onLeave], [el, 'wheel', onWheel],
    [el, 'dblclick', onDbl], [chart.wellEl, 'keydown', onKeyDown], [chart.wellEl, 'keyup', onKeyUp]
  );

  if (chart.ovCanvas) bindOverview(chart);
}

/**
 * Wire the history strip's window brush.
 * @param {object} chart The chart.
 * @returns {void}
 */
function bindOverview(chart) {
  const el = chart.ovCanvas;
  const state = { active: false, mode: 'move', w0: 0 };

  const xAt = (px) => {
    const og = chart.ovGeom;
    if (!og) return 0;
    return og.full0 + (px - og.px0) / (og.kx || 1);
  };

  const onDown = (e) => {
    const og = chart.ovGeom;
    if (!og) return;
    const px = e.offsetX;
    const a0 = og.px0 + (chart.x0 - og.full0) * og.kx;
    const a1 = og.px0 + (chart.x1 - og.full0) * og.kx;
    state.active = true;
    state.w0 = chart.x1 - chart.x0;
    if (Math.abs(px - a0) <= 5) state.mode = 'left';
    else if (Math.abs(px - a1) <= 5) state.mode = 'right';
    else {
      state.mode = 'move';
      const c = xAt(px);
      applyWindow(chart, c - state.w0 / 2, c + state.w0 / 2, true);
    }
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!state.active) return;
    const v = xAt(e.offsetX);
    if (state.mode === 'left') applyWindow(chart, v, chart.x1, true);
    else if (state.mode === 'right') applyWindow(chart, chart.x0, v, true);
    else applyWindow(chart, v - state.w0 / 2, v + state.w0 / 2, true);
    chart.ovDirty = true;
  };
  const onUp = (e) => {
    state.active = false;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* already released */
    }
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  chart.listeners.push(
    [el, 'pointerdown', onDown], [el, 'pointermove', onMove],
    [el, 'pointerup', onUp], [el, 'pointercancel', onUp]
  );
}

/* -------------------------------------------------------------------------- */
/* 17. CONSTRUCTION                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Normalise one pen descriptor. The engineering unit and the fixed decimal count come from
 * the log channel table unless the caller overrode them.
 *
 * The PV stroke is ALWAYS solid 1.5 px and the SP stroke ALWAYS the same hue dashed 5-4 at
 * 1 px: a caller-supplied `dash` or `width` is accepted for compatibility and ignored, so
 * the pairing an operator reads the screen by can never be broken from outside.
 * @param {object} src Caller descriptor.
 * @param {number} idx Rail position, for the fallback pen colour.
 * @returns {object} A live pen record.
 */
function makePen(src, idx) {
  const channel = src.channel || 'UV_280_mAU';
  const meta = CHANNEL_META.get(channel);
  const spChannel = src.sp || src.spChannel || null;
  const id = src.id !== undefined ? String(src.id) : 'pen' + idx;
  // The log writes '-' for a dimensionless channel; a label box shows nothing at all.
  const metaEu = meta && meta.unit !== '-' ? meta.unit : '';
  return {
    id,
    tag: src.tag || src.label || id.toUpperCase(),
    channel,
    spChannel,
    limitSignal: src.limitSignal || null,
    limit: typeof src.limit === 'number' ? src.limit : NaN,
    // The LIMIT column's own state, never shared with anything in the SP column.
    limitCode: src.limitCode || LIMIT_CODES.HI,
    limitRising: src.limitRising !== false,
    limitState: 'norm',
    limitAck: false,
    eu: src.eu !== undefined ? src.eu : src.unit !== undefined ? src.unit : metaEu,
    dec: typeof src.dec === 'number' ? src.dec
      : typeof src.decimals === 'number' ? src.decimals : meta ? meta.decimals : 2,
    axis: src.axis || src.yAxis || '',
    alt: src.alt === true,
    fill: typeof src.fill === 'number' ? src.fill : 0,
    penVar: src.penVar || src.colorVar || '--pen-uv',
    gloss: src.gloss || src.glossary || '',
    visible: src.visible !== false,
    dim: false,
    kPix: 0,
    bPix: 0,
    pvTrace: null,
    spTrace: null,
    row: null,
  };
}

/**
 * Normalise one y-axis descriptor. Axes carry an ENGINEERING UNIT, never a title.
 * @param {object} src Caller descriptor.
 * @returns {object} A live axis record.
 */
function makeAxis(src) {
  const mode = src.mode || 'auto-sticky';
  const eu = src.eu !== undefined ? src.eu : src.unit !== undefined ? src.unit : '';
  return {
    id: src.id,
    eu,
    side: src.side === 'left' ? 'left' : 'right',
    mode,
    baseMode: mode,
    userManual: false,
    min: typeof src.min === 'number' ? src.min : 0,
    max: typeof src.max === 'number' ? src.max : 1,
    alt: src.alt
      ? {
        eu: src.alt.eu !== undefined ? src.alt.eu : src.alt.unit || '',
        min: src.alt.min,
        max: src.alt.max,
      }
      : null,
    aMin: typeof src.min === 'number' ? src.min : 0,
    aMax: typeof src.max === 'number' ? src.max : 1,
    targetMax: typeof src.max === 'number' ? src.max : 1,
    targetMin: 0,
    easeFrom: 0,
    easeTo: 0,
    easeT0: 0,
    visible: true,
    gutterX: 0,
    k: 0,
    b: 0,
  };
}

/**
 * Rebuild the flat trace list: one PV trace per pen, plus one SP trace for every pen that
 * has a setpoint channel. Painting and decimation iterate traces; the rail iterates pens.
 *
 * `held` is the trace's SEMANTICS, not its style: true when the value is commanded and
 * holds between samples, which is every SP trace and any PV pen a caller has pointed at a
 * {@link HELD_CHANNELS} channel. It selects the staircase painter in both raw and
 * decimated mode; `isSp` still selects the dash, the width and the paint order.
 * @param {object} chart The chart.
 * @returns {void}
 */
function rebuildTraces(chart) {
  const out = [];
  for (let i = 0; i < chart.pens.length; i++) {
    const pen = chart.pens[i];
    const pv = {
      pen, isSp: false, channel: pen.channel, held: HELD_CHANNELS.has(pen.channel),
      minBuf: null, maxBuf: null, kPix: 0, bPix: 0,
      hasData: false, dataMin: NaN, dataMax: NaN, cursorValue: NaN,
    };
    pen.pvTrace = pv;
    out.push(pv);
    if (pen.spChannel) {
      const sp = {
        pen, isSp: true, channel: pen.spChannel, held: true,
        minBuf: null, maxBuf: null, kPix: 0, bPix: 0,
        hasData: false, dataMin: NaN, dataMax: NaN, cursorValue: NaN,
      };
      pen.spTrace = sp;
      out.push(sp);
    } else {
      pen.spTrace = null;
    }
  }
  chart.traces = out;
  ensureBuffers(chart);
}

/**
 * Build one beveled icon button.
 * @param {string} label Accessible name; also the tooltip.
 * @param {Array<object>} icon Icon descriptor for {@link svgIcon}.
 * @param {boolean} toggle Whether the button reports an `aria-pressed` state.
 * @returns {HTMLButtonElement} The button.
 */
function iconButton(label, icon, toggle) {
  const attrs = { class: 'ftx__btn', type: 'button', 'aria-label': label, title: label };
  if (toggle) attrs['aria-pressed'] = 'false';
  const b = h('button', attrs);
  b.appendChild(svgIcon(icon));
  return b;
}

/**
 * Build the toolbar: icon-only buttons in beveled groups separated by sunken rules. No
 * button ever carries a word on its face.
 * @param {object} chart The chart.
 * @returns {Element} The toolbar element.
 */
function buildToolbar(chart) {
  const b = {
    xVol: iconButton('X axis: volume, mL', ICON_VOL, true),
    xTime: iconButton('X axis: time, min', ICON_TIME, true),
    xCV: iconButton('X axis: column volumes, CV', ICON_CV, true),
    yAuto: iconButton('Y axes: autoscale', ICON_YAUTO, true),
    fit: iconButton('Reset the view to the whole run', ICON_FIT, false),
    live: iconButton('Follow the live edge', ICON_LIVE, true),
    table: iconButton('Data table', ICON_TABLE, true),
  };
  chart.btn = b;

  const wire = (el, fn) => {
    el.addEventListener('click', fn);
    chart.listeners.push([el, 'click', fn]);
  };
  wire(b.xVol, () => setXMode(chart, 'volume'));
  wire(b.xTime, () => setXMode(chart, 'time'));
  wire(b.xCV, () => setXMode(chart, 'cv'));
  wire(b.yAuto, () => {
    if (anyManualY(chart)) releaseManualY(chart);
    else zoomYAbout(chart, (chart.geom.py0 + chart.geom.py1) / 2, 1);
  });
  wire(b.fit, () => resetView(chart));
  wire(b.live, () => setFollow(chart, !chart.follow));
  wire(b.table, () => {
    chart.tableOpen = !chart.tableOpen;
    cls(chart.tableWrap, 'ftx__table--on', chart.tableOpen);
    if (chart.tableOpen) rebuildTable(chart);
    syncToolbar(chart);
    measureNow(chart);
  });

  return h(
    'div', { class: 'ftx__bar', role: 'toolbar', 'aria-label': 'Trend controls' },
    h('div', { class: 'ftx__grp' }, b.xVol, b.xTime, b.xCV),
    h('span', { class: 'ftx__sep' }),
    h('div', { class: 'ftx__grp' }, b.yAuto, b.fit),
    h('span', { class: 'ftx__sep' }),
    h('div', { class: 'ftx__grp' }, b.live),
    h('span', { class: 'ftx__sp' }),
    h('div', { class: 'ftx__grp' }, b.table)
  );
}

/**
 * Create the trend. Builds the toolbar, the sunken plot well with its three stacked
 * canvases, the legend rail, the history strip and the accessible data table, then wires
 * the `ResizeObserver`, `IntersectionObserver`, theme observer and visibility listener
 * that keep the chart from ever reading layout inside {@link frame}.
 *
 * @param {Element} rootEl Host element; the chart appends one wrapper to it.
 * @param {object} [opts] Options.
 * @param {{mode:'volume'|'time'|'cv'}} [opts.xAxis] Initial x-axis mode. Default volume.
 * @param {Array<object>} [opts.yAxes] Axis stack `{id, eu, side, mode, min, max, alt}`;
 *   `mode` is `'auto-sticky'` (zero-anchored, eased shrink), `'auto'`, `'auto-band'`
 *   (fits the data band without anchoring at zero — for a closed loop) or `'manual'`.
 *   Defaults to the six-gutter FT stack.
 * @param {Array<object>} [opts.series] Pens in rail order
 *   `{id, tag, channel, sp, limitSignal, eu, dec, axis, alt, fill, penVar, gloss, visible}`;
 *   defaults to the eight ISA-tagged pens. `label`/`unit`/`decimals`/`yAxis`/`colorVar`
 *   are accepted as aliases.
 * @param {Array<object>} [opts.pens] Alias of `opts.series`.
 * @param {boolean} [opts.overview] Draw the history strip. Default true.
 * @param {Array<object>} [opts.alarms] `config.alarms` rows, so PT-101 and PDT-101 can
 *   draw their limit lines immediately.
 * @returns {object} The Chart handle, passed back into every other export. It also carries
 *   one method of its own, `focusPenRail()` — see {@link focusPenRail}.
 */
export function createChart(rootEl, opts) {
  ensureStyles();
  const o = opts || {};

  const wrap = h('div', { class: 'ftx' });
  const wellEl = h('div', {
    class: 'ftx__well',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Process trend, interactive',
  });
  const hostEl = h('div', { class: 'ftx__host' });
  const cvStatic = h('canvas', { class: 'ftx__layer ftx__layer--s', 'aria-hidden': 'true' });
  const cvTraces = h('canvas', {
    class: 'ftx__layer ftx__layer--t',
    role: 'img',
    'aria-label': 'Process trend. No data yet.',
  });
  const cvOverlay = h('canvas', { class: 'ftx__layer ftx__layer--o', 'aria-hidden': 'true' });
  const cardV = labelBox('x', 'V', 'mL');
  const cardT = labelBox('x', 'T', 'min');
  const cardC = labelBox('x', 'CV', '');
  const card = h('div', { class: 'ftx__card' }, cardV.el, cardT.el, cardC.el);
  const srLive = h('div', { class: 'ftx__sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  hostEl.appendChild(cvStatic);
  hostEl.appendChild(cvTraces);
  hostEl.appendChild(cvOverlay);
  hostEl.appendChild(card);
  wellEl.appendChild(hostEl);
  wellEl.appendChild(srLive);

  // The rail's column header scrolls WITH its rows and sticks to the top of the same
  // scroller, which is the only way the captions and the numbers can share one grid: a header
  // in its own box is a scrollbar wider than the rows below it, and every caption then sits
  // a few pixels off the column it names.
  const railRows = h('div', { class: 'ftx__rowbox' });
  const rail = h(
    'div', { class: 'ftx__rail' },
    h(
      'div', { class: 'ftx__rows' },
      h(
        'div', { class: 'ftx__railhd' },
        h('em', {}, 'PEN'),
        h('b', {}, h('span', {}, 'TAG'), h('span', {}, 'UNIT')),
        h(
          'i', {},
          h('span', { class: 'pv' }, 'PV'),
          h('span', { class: 'sp', title: 'Control setpoint — a target the loop drives to' }, 'SP'),
          h('span', {
            class: 'lim',
            title: 'Alarm limit — a protection threshold, with its ISA designation and state',
          }, 'Limit')
        )
      ),
      railRows
    )
  );
  const body = h('div', { class: 'ftx__body' }, wellEl, rail);

  const wantOverview = o.overview !== false;
  let ovEl = null;
  let ovHostEl = null;
  let ovCanvas = null;
  if (wantOverview) {
    ovCanvas = h('canvas', { 'aria-hidden': 'true' });
    ovHostEl = h('div', { class: 'ftx__ovhost' }, ovCanvas);
    ovEl = h('div', { class: 'ftx__ov' }, ovHostEl);
  }
  const tableWrap = h('div', { class: 'ftx__table' });

  const blitCanvas = document.createElement('canvas');
  const penSrc = o.pens || o.series || DEFAULT_PENS;
  const pens = penSrc.map(makePen);
  const yAxes = (o.yAxes || DEFAULT_Y_AXES).map(makeAxis);

  const chart = {
    root: rootEl,
    el: wrap,
    wellEl,
    hostEl,
    cvStatic,
    cvTraces,
    cvOverlay,
    gStatic: cvStatic.getContext('2d'),
    gTraces: cvTraces.getContext('2d'),
    gOverlay: cvOverlay.getContext('2d'),
    card,
    cardV,
    cardT,
    cardC,
    rail,
    railRows,
    railKey: '',
    railDue: 0,
    railListeners: [],
    focusPen: null,
    srLive,
    btn: null,
    tableWrap,
    tableCells: null,
    tableTraces: [],
    tableOpen: false,
    ovEl,
    ovHostEl,
    ovCanvas,
    gOv: ovCanvas ? ovCanvas.getContext('2d') : null,
    ovMin: null,
    ovMax: null,
    ovGeom: null,
    ovDirty: true,
    ovW: 1,
    ovH: OVERVIEW_H - 6,
    blit: { canvas: blitCanvas, ctx: blitCanvas.getContext('2d'), w: 0, h: 0, valid: false, validPx: 0 },

    store: null,
    xChannels: Object.assign({}, XCH_DEFAULT),
    xMode: (o.xAxis && o.xAxis.mode) || 'volume',
    x0: 0,
    x1: 100,
    autoFit: true,
    follow: true,
    scrollPx: 0,

    pens,
    penById: new Map(pens.map((p) => [p.id, p])),
    traces: [],
    yAxes,
    axisById: new Map(yAxes.map((a) => [a.id, a])),

    bands: [],
    markers: [],
    bandLabelSpots: [],
    // Baselines already spent by a limit caption or a setpoint chip this overlay pass, so the
    // two painters can keep out of each other's way without allocating per frame.
    captionY: [],
    pool: { on: false, x0: 0, x1: 0 },

    pixelStart: new Int32Array(1),
    stripStart: new Int32Array(1),
    tableValid: false,
    tableX0: NaN,
    tableX1: NaN,
    tablePixels: 0,
    tableN: -1,
    tableCh: '',
    rawMode: false,
    lastPaintedN: -1,

    geom: {
      cssW: 0, cssH: 0, dpr: window.devicePixelRatio || 1,
      padL: LEFT_AXIS_W, padR: 48, padT: 16, padB: 26,
      px0: 42, py0: 16, px1: 100, py1: 100, plotW: 58, plotH: 84, pixels: 1,
    },
    colors: null,
    visible: true,
    interacting: false,
    spaceDown: false,
    hoverPx: -1,
    readoutMode: false,
    cursor: { on: false, x: NaN, index: -1 },
    drag: {
      active: false, mode: '', px0: 0, py0: 0, pxNow: 0, pyNow: 0,
      winX0: 0, winX1: 0, handle: '', poolX0: 0, poolX1: 0,
    },
    handlers: { onZoom: null, onCursor: null, onSelect: null, onPoolDrag: null },
    listeners: [],
    dirty: { static: true, traces: true, overlay: true },
    frameCount: 0,
    lastMeasure_ms: -1e9,
    lastRemeasure_ms: -1e9,
    lastAria_ms: -1e9,
    lastLabel_ms: -1e9,
    lastOverview_ms: -1e9,
    reducedMotion: false,
    contrastMore: false,
    destroyed: false,
    ro: null,
    io: null,
    mo: null,
    mqMotion: null,
    mqContrast: null,
  };

  chart.colors = resolveColors('current', chart.pens);
  rebuildTraces(chart);

  wrap.appendChild(buildToolbar(chart));
  wrap.appendChild(body);
  if (ovEl) wrap.appendChild(ovEl);
  wrap.appendChild(tableWrap);
  rootEl.appendChild(wrap);

  buildRail(chart);
  if (Array.isArray(o.alarms)) setLimitsFromAlarms(chart, o.alarms);

  if (window.matchMedia) {
    chart.mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    chart.mqContrast = window.matchMedia('(prefers-contrast: more)');
    chart.reducedMotion = chart.mqMotion.matches;
    chart.contrastMore = chart.mqContrast.matches;
    const onMq = () => {
      chart.reducedMotion = chart.mqMotion.matches;
      chart.contrastMore = chart.mqContrast.matches;
      invalidate(chart, 'all');
    };
    chart.mqMotion.addEventListener('change', onMq);
    chart.mqContrast.addEventListener('change', onMq);
    chart.listeners.push([chart.mqMotion, 'change', onMq], [chart.mqContrast, 'change', onMq]);
  }

  chart.ro = new ResizeObserver((entries) => {
    if (chart.destroyed) return;
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i];
      const r = en.contentRect;
      if (en.target === chart.hostEl) {
        if (r.width > 0 && r.height > 0) applySize(chart, r.width, r.height);
      } else if (r.width > 0 && r.height > 0) {
        chart.ovW = Math.max(1, Math.round(r.width));
        chart.ovH = Math.max(1, Math.round(r.height));
        resizeOverview(chart);
      }
    }
  });
  chart.ro.observe(hostEl);
  if (ovHostEl) chart.ro.observe(ovHostEl);

  chart.io = new IntersectionObserver((entries) => {
    const on = entries[0].isIntersecting;
    const was = chart.visible;
    chart.visible = on;
    // Becoming visible is one of the paths a ResizeObserver never reports.
    if (on && !was) measureNow(chart);
  }, { threshold: 0 });
  chart.io.observe(wrap);

  chart.mo = new MutationObserver(() => {
    invalidate(chart, 'all');
  });
  chart.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const onVis = () => {
    if (!document.hidden) measureNow(chart);
  };
  document.addEventListener('visibilitychange', onVis);
  chart.listeners.push([document, 'visibilitychange', onVis]);
  const onWinResize = () => measureNow(chart);
  window.addEventListener('resize', onWinResize);
  chart.listeners.push([window, 'resize', onWinResize]);

  // The one export the run view reaches through the handle rather than through the module,
  // because its `L` shortcut only ever holds the chart object. See {@link focusPenRail}.
  chart.focusPenRail = () => focusPenRail(chart);

  bindInteractions(chart);
  layout(chart);
  resizeCanvases(chart);
  syncToolbar(chart);
  // Explicit measurement on mount. A ResizeObserver does not fire in a background tab, so
  // this is the only thing standing between a hidden page load and a 1x1 backing store.
  measureNow(chart);
  return chart;
}

/* -------------------------------------------------------------------------- */
/* 18. PUBLIC API                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Point the trend at a channel store. Column views are never cached across frames —
 * `pushRow` invalidates them on growth — only the store object is held.
 * @param {object} chart The chart.
 * @param {object} store A `core/log.js` ChannelStore, or null to clear.
 * @param {{volume:string, time:string, cv:string}} [xChannels] Monotone x channel names
 *   per x-mode. Defaults to `{volume:'V_mL', time:'t_s', cv:'V_CV'}`.
 * @param {object} [config] The frozen config. When present its `alarms` rows set the
 *   PT-101 and PDT-101 limit lines, so the caller need not do it separately.
 * @returns {void}
 */
export function setSource(chart, store, xChannels, config) {
  chart.store = store || null;
  if (xChannels) chart.xChannels = Object.assign({}, XCH_DEFAULT, xChannels);
  chart.tableValid = false;
  chart.lastPaintedN = -1;
  chart.blit.valid = false;
  chart.cursor.on = false;
  chart.cursor.index = -1;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    a.easeT0 = 0;
    a.targetMax = a.mode === 'manual' ? a.max : Math.max(1, a.max);
  }
  if (config && Array.isArray(config.alarms)) setLimitsFromAlarms(chart, config.alarms);
  if (chart.tableOpen) rebuildTable(chart);
  invalidate(chart, 'all');
}

/**
 * Re-point one pen at a different log channel, taking its unit and fixed decimal count
 * from the channel table.
 * @param {object} chart The chart.
 * @param {string} penId Pen id.
 * @param {string} channelName Numeric log channel name.
 * @returns {void}
 */
export function setSeriesChannel(chart, penId, channelName) {
  const p = chart.penById.get(penId);
  if (!p || p.channel === channelName) return;
  p.channel = channelName;
  const meta = CHANNEL_META.get(channelName);
  if (meta) {
    p.eu = meta.unit === '-' ? '' : meta.unit;
    p.dec = meta.decimals;
  }
  rebuildTraces(chart);
  buildRail(chart);
  if (chart.tableOpen) rebuildTable(chart);
  invalidate(chart, 'all');
}

/**
 * Light or extinguish one pen. Both its PV and its SP go with it, because a setpoint
 * without its process variable is not a reading an operator can act on.
 * @param {object} chart The chart.
 * @param {string} penId Pen id.
 * @param {boolean} visible Desired state.
 * @returns {void}
 */
export function setPenVisible(chart, penId, visible) {
  const p = chart.penById.get(penId);
  if (!p || p.visible === !!visible) return;
  p.visible = !!visible;
  if (p.row && p.row.cb.checked !== p.visible) p.row.cb.checked = p.visible;
  layout(chart);
  ensureBuffers(chart);
  if (chart.tableOpen) rebuildTable(chart);
  invalidate(chart, 'all');
}

/**
 * Light or extinguish one pen. Compatibility alias of {@link setPenVisible}.
 * @param {object} chart The chart.
 * @param {string} penId Pen id.
 * @param {boolean} visible Desired state.
 * @returns {void}
 */
export function setSeriesVisible(chart, penId, visible) {
  setPenVisible(chart, penId, visible);
}

/**
 * Focus one pen: every other lit pen dims to 22 % so a single loop can be read out of a
 * crowded trend. Pass null to clear.
 * @param {object} chart The chart.
 * @param {string|null} penId Pen id, or null.
 * @returns {void}
 */
export function setPenFocus(chart, penId) {
  const want = penId || null;
  if (chart.focusPen === want) return;
  chart.focusPen = want;
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    p.dim = want !== null && p.id !== want;
  }
  chart.railDue = 0;
  invalidate(chart, 'traces');
}

/**
 * Move KEYBOARD focus into the legend rail, landing on the first control there — the
 * leading pen's on/off checkbox. The run view binds `L` to this so an operator can reach
 * the pen list without tabbing the whole toolbar, and so the rail is reachable at all when
 * the trend well itself holds focus.
 *
 * Also published as a method on the handle {@link createChart} returns, which is how the
 * run view calls it: `chart.focusPenRail()`.
 * @param {object} chart The chart.
 * @returns {boolean} True when focus moved into the rail; false when the rail carries no
 *   focusable control, or when it cannot take focus because it is not displayed — a
 *   caller that wants a fallback target needs to know the difference.
 */
export function focusPenRail(chart) {
  if (!chart || chart.destroyed || !chart.railRows) return false;
  const all = chart.railRows.querySelectorAll(RAIL_FOCUSABLE);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.disabled) continue;
    el.focus();
    // Verified, not assumed: focus() on a control inside a hidden pane is a no-op.
    if (document.activeElement === el) return true;
  }
  return false;
}

/**
 * Focus one pen. Compatibility alias of {@link setPenFocus}.
 * @param {object} chart The chart.
 * @param {string|null} penId Pen id, or null.
 * @returns {void}
 */
export function setSeriesFocus(chart, penId) {
  setPenFocus(chart, penId);
}

/**
 * Dim or undim one pen directly.
 * @param {object} chart The chart.
 * @param {string} penId Pen id.
 * @param {number} alpha 1 for full strength, anything less to dim.
 * @returns {void}
 */
export function setSeriesAlpha(chart, penId, alpha) {
  const p = chart.penById.get(penId);
  if (!p) return;
  const dim = !(alpha >= 1);
  if (p.dim === dim) return;
  p.dim = dim;
  invalidate(chart, 'traces');
}

/**
 * Set one pen's alarm limit line explicitly, in the pen's own engineering unit.
 *
 * The DESIGNATION travels with the value, because a threshold with no designation is exactly
 * the ambiguity this column exists to remove: `HI` and `HH` are the same kind of number at
 * very different consequences, and only the caller knows which one it just handed over.
 * @param {object} chart The chart.
 * @param {string} penId Pen id.
 * @param {number|null} value Limit, or null to remove the line.
 * @param {'HI'|'HH'|'LO'|'LL'} [code] ISA designation. Default `'HI'`; `'LO'` and `'LL'` also
 *   set the limit's sense, so the alarm state is evaluated from below rather than above.
 * @returns {void}
 */
export function setSeriesLimit(chart, penId, value, code) {
  const p = chart.penById.get(penId);
  if (!p) return;
  const v = typeof value === 'number' && isFinite(value) ? value : NaN;
  const want = LIMIT_CODES[code] || (v === v ? p.limitCode || LIMIT_CODES.HI : LIMIT_CODES.HI);
  const same = (p.limit === v) || (p.limit !== p.limit && v !== v);
  if (same && p.limitCode === want) return;
  p.limit = v;
  p.limitCode = want;
  p.limitRising = want === LIMIT_CODES.HI || want === LIMIT_CODES.HH;
  if (!same) p.limitAck = false;
  chart.railDue = 0;
  chart.dirty.overlay = true;
}

/**
 * Acknowledge one pen's limit alarm from the rail.
 *
 * An acknowledgement is a PRESENTATION act here — it steadies the field the operator is
 * looking at and records that he has seen it. It never clears the alarm, never touches the
 * threshold and never reaches the simulation: the PV is still through the limit, the line is
 * still drawn in alarm ink, and the state word says `ACK`, not `NORM`.
 * @param {object} chart The chart.
 * @param {string} penId Pen id.
 * @returns {boolean} True when an unacknowledged alarm was acknowledged.
 */
export function acknowledgeLimit(chart, penId) {
  const p = chart.penById.get(penId);
  if (!p || p.limitState !== 'alarm') return false;
  p.limitAck = true;
  p.limitState = 'ack';
  if (p.row && p.row.lim) writeLimitCell(p, p.row.lim, 'ack');
  chart.railDue = 0;
  chart.dirty.overlay = true;
  return true;
}

/**
 * Derive every pen's limit line and ISA designation from `config.alarms`.
 *
 * A pen declares which ALARM_TABLE `signal` it watches. Among the RISING rows on that signal
 * the LOWEST threshold at severity ALARM wins, falling back to the lowest rising threshold of
 * any severity, because the first line an operator must not cross is the one that matters.
 * When a signal carries no rising row at all the HIGHEST falling threshold wins, for the same
 * reason read the other way up.
 *
 * The designation follows the chosen row rather than the number: a trip severity — CRITICAL
 * or FAULT — designates `HH`/`LL`, anything else `HI`/`LO`. That is what lets the rail print
 * `HI 1.60 bar` for PT-101 and mean it.
 * @param {object} chart The chart.
 * @param {Array<object>} alarms `config.alarms` rows.
 * @returns {void}
 */
export function setLimitsFromAlarms(chart, alarms) {
  if (!Array.isArray(alarms)) return;
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    if (!p.limitSignal) continue;
    let up = null;
    let upAny = null;
    let down = null;
    let downAny = null;
    for (let k = 0; k < alarms.length; k++) {
      const row = alarms[k];
      if (!row || row.signal !== p.limitSignal) continue;
      const th = row.threshold;
      if (typeof th !== 'number' || !isFinite(th)) continue;
      if (row.op === '>') {
        if (!upAny || th < upAny.threshold) upAny = row;
        if (row.severity === 'ALARM' && (!up || th < up.threshold)) up = row;
      } else if (row.op === '<') {
        if (!downAny || th > downAny.threshold) downAny = row;
        if (row.severity === 'ALARM' && (!down || th > down.threshold)) down = row;
      }
    }
    const win = up || upAny || down || downAny;
    if (!win) {
      setSeriesLimit(chart, p.id, null);
      continue;
    }
    const trip = TRIP_SEVERITIES.has(win.severity);
    const code = win.op === '<'
      ? trip ? LIMIT_CODES.LL : LIMIT_CODES.LO
      : trip ? LIMIT_CODES.HH : LIMIT_CODES.HI;
    setSeriesLimit(chart, p.id, win.threshold, code);
  }
}

/**
 * Set the visible x window explicitly, in the current x-mode's channel unit. A non-finite
 * pair restores auto-fit plus live follow.
 * @param {object} chart The chart.
 * @param {number} x0 Window start, x-channel unit (mL, s or CV).
 * @param {number} x1 Window end, same unit.
 * @returns {void}
 */
export function setWindow(chart, x0, x1) {
  if (!isFinite(x0) || !isFinite(x1)) {
    resetView(chart);
    return;
  }
  applyWindow(chart, x0, x1, true);
}

/**
 * Switch the x axis between volume, time and CV, preserving the visible window by mapping
 * its bounds through the row index.
 * @param {object} chart The chart.
 * @param {'volume'|'time'|'cv'} mode New x-mode.
 * @returns {void}
 */
export function setXMode(chart, mode) {
  if (mode !== 'volume' && mode !== 'time' && mode !== 'cv') return;
  if (mode === chart.xMode) return;
  const from = xChannel(chart);
  chart.xMode = mode;
  const to = xChannel(chart);
  if (!chart.autoFit) remapWindow(chart, from, to);
  chart.tableValid = false;
  chart.blit.valid = false;
  chart.ovDirty = true;
  if (chart.tableOpen) rebuildTable(chart);
  syncToolbar(chart);
  invalidate(chart, 'all');
}

/**
 * Enable or disable live follow. Enabling keeps the current span and scrolls the live edge
 * to 85 % width; disabling freezes the window.
 * @param {object} chart The chart.
 * @param {boolean} on Desired follow state.
 * @returns {void}
 */
export function setFollow(chart, on) {
  const want = !!on;
  if (chart.follow === want) return;
  chart.follow = want;
  chart.blit.valid = false;
  chart.dirty.traces = true;
  chart.dirty.static = true;
  syncToolbar(chart);
}

/**
 * Mark a layer dirty. `'all'` also re-reads the theme tokens, which is what a theme change
 * requires.
 * @param {object} chart The chart.
 * @param {'static'|'traces'|'overlay'|'all'} layer Layer to invalidate.
 * @returns {void}
 */
export function invalidate(chart, layer) {
  if (layer === 'all') {
    chart.colors = resolveColors('current', chart.pens);
    paintRailChips(chart);
    chart.dirty.static = true;
    chart.dirty.traces = true;
    chart.dirty.overlay = true;
    chart.blit.valid = false;
    chart.tableValid = false;
    chart.ovDirty = true;
    chart.railDue = 0;
    return;
  }
  if (layer === 'static') chart.dirty.static = true;
  else if (layer === 'traces') {
    chart.dirty.traces = true;
    chart.blit.valid = false;
  } else if (layer === 'overlay') chart.dirty.overlay = true;
}

/**
 * Set the phase/block shading bands.
 * @param {object} chart The chart.
 * @param {Array<{x0:number, x1:number, label:string, kind:string}>} bands Bands in the
 *   current x-channel unit; `kind` is the block type, which selects the tint.
 * @returns {void}
 */
export function setBands(chart, bands) {
  chart.bands = Array.isArray(bands) ? bands : [];
  chart.dirty.static = true;
}

/**
 * Set the marker set: fraction ticks, event chevrons and peak flags.
 * @param {object} chart The chart.
 * @param {Array<{x:number, label:string, kind:'line'|'flag'|'tick', y?:number,
 *   seriesId?:string, x0?:number, x1?:number, severity?:string}>} markers Markers in the
 *   current x-channel unit. `y` plus `seriesId` anchors a peak flag at its apex;
 *   `x0`/`x1` draw dashed integration boundaries.
 * @returns {void}
 */
export function setMarkers(chart, markers) {
  chart.markers = Array.isArray(markers) ? markers : [];
  chart.dirty.static = true;
}

/**
 * Set or clear the shaded pooled region.
 * @param {object} chart The chart.
 * @param {number|null} x0 Pool start in the current x-channel unit, or null to clear.
 * @param {number|null} x1 Pool end, or null to clear.
 * @returns {void}
 */
export function setPoolWindow(chart, x0, x1) {
  if (x0 === null || x1 === null || !isFinite(x0) || !isFinite(x1)) {
    chart.pool.on = false;
  } else {
    chart.pool.on = true;
    chart.pool.x0 = Math.min(x0, x1);
    chart.pool.x1 = Math.max(x0, x1);
  }
  chart.dirty.static = true;
}

/**
 * Find the nearest lit PV trace to a point.
 * @param {object} chart The chart.
 * @param {number} px Pointer x in css px, relative to the plot host.
 * @param {number} py Pointer y in css px, relative to the plot host.
 * @returns {{seriesId:string, index:number, x:number, y:number}|null} The hit, or null when
 *   no lit trace passes within 12 px.
 */
export function hitTest(chart, px, py) {
  if (!chart.store || chart.store.n === 0) return null;
  const g = chart.geom;
  if (px < g.px0 || px > g.px1 || py < g.py0 || py > g.py1) return null;
  const smp = sampleAt(chart, pxToX(chart, px));
  if (!smp) return null;
  prepareMapping(chart, g);
  let best = null;
  let bestD = 12;
  for (let i = 0; i < chart.pens.length; i++) {
    const p = chart.pens[i];
    if (!p.visible) continue;
    const y = column(chart.store, p.channel);
    const v = smp.index < y.length ? y[smp.index] : NaN;
    if (v !== v) continue;
    const d = Math.abs(p.bPix - v * p.kPix - py);
    if (d < bestD) {
      bestD = d;
      best = { seriesId: p.id, index: smp.index, x: smp.x, y: v };
    }
  }
  return best;
}

/**
 * Register interaction callbacks. All are optional and all are called synchronously.
 * @param {object} chart The chart.
 * @param {{onZoom?:Function, onCursor?:Function, onSelect?:Function,
 *   onPoolDrag?:Function}} handlers Callback set. `onZoom({x0,x1,mode})` fires on every
 *   window change; `onCursor(sample|null)` on every crosshair move;
 *   `onSelect({x0,x1,mode})` on a drag-selection; `onPoolDrag({x0,x1,done?})` while the
 *   pool region is dragged.
 * @returns {void}
 */
export function attachInteractions(chart, handlers) {
  const hs = handlers || {};
  chart.handlers.onZoom = hs.onZoom || null;
  chart.handlers.onCursor = hs.onCursor || null;
  chart.handlers.onSelect = hs.onSelect || null;
  chart.handlers.onPoolDrag = hs.onPoolDrag || null;
}

/**
 * Render one frame. Called at most once per rAF frame by `ui/app.js`; the trend never owns
 * a rAF loop of its own and never calls `sim.advanceWall`.
 *
 * Order: re-measure if the plot is degenerate, follow-window update, the 4 Hz decimate and
 * autoscale pass, axis easing, then the three layers and the 10 Hz rail refresh. A trend
 * scrolled out of view or in a hidden tab returns immediately.
 *
 * @param {object} chart The chart.
 * @param {number} now_ms Frame timestamp, `performance.now()` domain.
 * @returns {void}
 */
export function frame(chart, now_ms) {
  if (chart.destroyed || !chart.visible) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const g = chart.geom;
  // The backing store is degenerate when the host was never measured at a real size: the
  // panel was built hidden, or laid out after mount. Test the HOST box, not just the plot
  // rectangle — an unmeasured host still yields a nominally positive plot rectangle out of
  // the padding alone, which is exactly how the old build sat at 1x1 forever.
  if (g.cssW <= 16 || g.cssH <= 16 || g.plotW <= 2 || g.plotH <= 2) {
    if (now_ms - chart.lastRemeasure_ms >= REMEASURE_PERIOD_MS) {
      chart.lastRemeasure_ms = now_ms;
      measureNow(chart);
    }
    if (g.cssW <= 16 || g.cssH <= 16 || g.plotW <= 2 || g.plotH <= 2) return;
  }
  chart.frameCount++;

  const measureDue = now_ms - chart.lastMeasure_ms >= MEASURE_PERIOD_MS;
  if (measureDue) {
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== g.dpr) {
      g.dpr = dpr;
      layout(chart);
      resizeCanvases(chart);
      resizeOverview(chart);
      chart.dirty.static = true;
      chart.dirty.traces = true;
    }
  }

  if (updateFollowWindow(chart)) {
    chart.dirty.static = true;
    chart.ovDirty = true;
    chart.tableValid = false;
    if (chart.autoFit) {
      // The span crossed a ladder rung: every pixel maps somewhere new.
      chart.blit.valid = false;
      chart.dirty.traces = true;
    }
  }

  if (measureDue) {
    chart.lastMeasure_ms = now_ms;
    decimateAllVisible(chart);
    measureAxes(chart, now_ms);
    if (chart.tableOpen) fillTable(chart);
  }

  if (applyAxisBounds(chart, now_ms)) {
    // MANDATORY full repaint: the y mapping moved, so blitted history would be drawn at a
    // stale scale and the trace would step against its own axis.
    chart.dirty.static = true;
    chart.dirty.traces = true;
    chart.blit.valid = false;
  }

  if (chart.frameCount % DRIFT_GUARD_FRAMES === 0) {
    chart.dirty.traces = true;
    chart.blit.valid = false;
  }

  if (chart.dirty.static) {
    paintStatic(chart, { ctx: chart.gStatic, geom: g, colors: chart.colors });
    chart.dirty.static = false;
  }

  if (chart.follow && !chart.interacting) {
    if (chart.dirty.traces || !chart.blit.valid) paintTracesFull(chart);
    else if (!paintTracesAppend(chart)) paintTracesFull(chart);
  } else {
    const grew = chart.store !== null && chart.store.n !== chart.lastPaintedN;
    if (chart.dirty.traces || (grew && measureDue)) paintTracesFull(chart);
  }

  paintOverlay(chart);

  if (chart.ovCanvas && (chart.ovDirty || now_ms - chart.lastOverview_ms >= MEASURE_PERIOD_MS)) {
    chart.lastOverview_ms = now_ms;
    paintOverview(chart);
  }

  if (now_ms >= chart.railDue) {
    chart.railDue = now_ms + RAIL_PERIOD_MS;
    if (railKey(chart) !== chart.railKey) buildRail(chart);
    updateRail(chart);
  }
  updateAriaLabel(chart, now_ms);
}

/**
 * Render the current view into a standalone PNG at an arbitrary size and theme. The plot
 * well is black in both themes, so only the surrounding furniture changes.
 *
 * @param {object} chart The chart.
 * @param {object} [opts] Export options.
 * @param {number} [opts.width] Image width in px. Default 1600.
 * @param {number} [opts.height] Image height in px. Default 900.
 * @param {'dark'|'light'|'current'} [opts.theme] Theme to render. Default 'current'.
 * @param {string} [opts.title] Title drawn above the plot.
 * @param {string} [opts.footer] Footer drawn below the plot.
 * @returns {Promise<Blob>} Resolves with an `image/png` Blob.
 */
export function exportPNG(chart, opts) {
  const o = opts || {};
  const width = Math.max(320, Math.round(o.width || 1600));
  const height = Math.max(240, Math.round(o.height || 900));
  const title = o.title || '';
  const footer = o.footer || '';
  const colors = resolveColors(o.theme || 'current', chart.pens);

  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, width, height);

  const titleH = title ? 30 : 20;
  const footerH = footer ? 24 : 8;
  const geom = {
    cssW: width,
    cssH: height - titleH - footerH,
    dpr: 1,
    padL: LEFT_AXIS_W, padR: 48, padT: 16, padB: 26,
    px0: 42, py0: 16, px1: width - 48, py1: height - titleH - footerH - 26,
    plotW: 1, plotH: 1, pixels: 1,
  };

  const savedGeom = chart.geom;
  const savedColors = chart.colors;
  const savedStrip = chart.stripStart;
  const savedRaw = chart.rawMode;
  const savedBufs = [];
  chart.geom = geom;
  chart.colors = colors;
  layout(chart);
  geom.pixels = Math.max(1, Math.round(geom.plotW));
  chart.stripStart = new Int32Array(geom.pixels + 1);
  for (let i = 0; i < chart.traces.length; i++) {
    const t = chart.traces[i];
    savedBufs.push([t.minBuf, t.maxBuf]);
    t.minBuf = new Float32Array(geom.pixels);
    t.maxBuf = new Float32Array(geom.pixels);
  }

  try {
    ctx.save();
    ctx.translate(0, titleH);
    paintStatic(chart, { ctx, geom, colors });
    chart.rawMode = samplesPerPixel(chart, geom) < RAW_SPP;
    prepareMapping(chart, geom);
    if (chart.store && chart.store.n > 0) {
      const starts = buildStripTable(chart, 0, geom.pixels);
      ctx.save();
      ctx.beginPath();
      ctx.rect(geom.px0, geom.py0 - 1, geom.plotW, geom.plotH + 2);
      ctx.clip();
      paintTraceBins(chart, ctx, geom, colors, 0, geom.pixels, starts, 0);
      ctx.restore();
    }
    // limit lines, exactly as the operator sees them — same ink, same dash-dot, same caption
    paintLimitLines(chart, ctx, geom, colors);
    ctx.restore();

    if (title) {
      ctx.fillStyle = colors.ink;
      ctx.font = '700 14px ' + FONT_UI;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, 12, titleH / 2);
    }
    if (footer) {
      ctx.fillStyle = colors.ink2;
      ctx.font = '10px ' + FONT_UI;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(footer, 12, height - footerH / 2);
    }
    // pen strip: tag plus EU, the same vocabulary as the rail
    let lx = width - 12;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '700 10px ' + FONT_UI;
    const ty = titleH / 2;
    for (let i = chart.pens.length - 1; i >= 0; i--) {
      const p = chart.pens[i];
      if (!p.visible) continue;
      const label = p.tag + (p.eu ? ' ' + p.eu : '');
      const w = ctx.measureText(label).width;
      ctx.fillStyle = colors.ink;
      ctx.fillText(label, lx, ty);
      lx -= w + 6;
      ctx.strokeStyle = colors.pen[p.id];
      ctx.lineWidth = PV_WIDTH;
      ctx.beginPath();
      ctx.moveTo(lx - 14, ty - 3);
      ctx.lineTo(lx, ty - 3);
      ctx.stroke();
      // The same two signatures the rail's line sample carries: a setpoint dashes in the
      // pen's hue, a limit dash-dots in warn ink. They are never drawn as the same stroke.
      if (p.spChannel) {
        ctx.lineWidth = SP_WIDTH;
        ctx.setLineDash(SP_DASH);
        ctx.beginPath();
        ctx.moveTo(lx - 14, ty + 1);
        ctx.lineTo(lx, ty + 1);
        ctx.stroke();
        ctx.setLineDash(EMPTY_DASH);
      }
      if (p.limit === p.limit) {
        ctx.strokeStyle = p.limitState === 'norm' ? colors.warnInk : colors.alarmInk;
        ctx.lineWidth = LIMIT_WIDTH;
        ctx.setLineDash(LIMIT_DASH);
        ctx.beginPath();
        ctx.moveTo(lx - 14, ty + 5);
        ctx.lineTo(lx, ty + 5);
        ctx.stroke();
        ctx.setLineDash(EMPTY_DASH);
      }
      lx -= 14 + 12;
      if (lx < 220) break;
    }
  } finally {
    chart.geom = savedGeom;
    chart.colors = savedColors;
    chart.stripStart = savedStrip;
    chart.rawMode = savedRaw;
    for (let i = 0; i < chart.traces.length; i++) {
      chart.traces[i].minBuf = savedBufs[i][0];
      chart.traces[i].maxBuf = savedBufs[i][1];
    }
    layout(chart);
    prepareMapping(chart, chart.geom);
    chart.dirty.static = true;
    chart.dirty.traces = true;
    chart.blit.valid = false;
  }

  return new Promise((resolve, reject) => {
    cv.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('chart.exportPNG: canvas.toBlob returned null'));
    }, 'image/png');
  });
}

/**
 * Tear the trend down: disconnect every observer, remove every listener and detach the
 * wrapper. Safe to call twice.
 * @param {object} chart The chart.
 * @returns {void}
 */
export function destroyChart(chart) {
  if (chart.destroyed) return;
  chart.destroyed = true;
  if (chart.ro) chart.ro.disconnect();
  if (chart.io) chart.io.disconnect();
  if (chart.mo) chart.mo.disconnect();
  for (let i = 0; i < chart.listeners.length; i++) {
    const target = chart.listeners[i][0];
    const type = chart.listeners[i][1];
    const fn = chart.listeners[i][2];
    try {
      target.removeEventListener(type, fn);
    } catch (err) {
      /* target already gone */
    }
  }
  chart.listeners.length = 0;
  chart.store = null;
  chart.bands = [];
  chart.markers = [];
  chart.tableCells = null;
  if (chart.el && chart.el.parentNode) chart.el.parentNode.removeChild(chart.el);
}
