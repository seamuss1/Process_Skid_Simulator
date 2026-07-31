/**
 * @file src/ui/chart.js
 * The three-layer canvas chromatogram engine (architecture-v2 §6.26, §9.3).
 *
 * Three stacked canvases in one wrapper, each sized `cssW*dpr x cssH*dpr` with the
 * context scaled by `dpr`:
 *   1. static  — axes, gridlines, phase bands, fraction ticks, peak labels, pool region.
 *   2. traces  — the data, min/max decimated to at most 2W vertices per series.
 *   3. overlay — crosshair, drag rectangle, live-edge marker; cleared every frame.
 *
 * Decimation bins on the X-CHANNEL VALUE, never the row index (§6.2): the log is uniform
 * in TIME, not in volume, so index binning makes retention volume unreadable off the chart
 * in the `volume` and `cv` x-modes. The hierarchical pyramid is DEFERRED (§12 D25); the
 * brute-force pass is amortised with a cached `pixelStart` boundary table that every series
 * reuses, and the append-only blit path is load-bearing rather than a nicety.
 *
 * Full repaint on: zoom · theme change · channel toggle · ANY y-axis bound change ·
 * unconditionally every 2000 frames as a drift guard.
 *
 * This module mutates neither `config` nor `run`; it reads a `ChannelStore` only.
 */

import { NUMERIC_CHANNELS, column, xIndexRange, decimateMinMax } from '../core/log.js';
import { h, setText, cls, readThemeTokens } from './format.js';

/* -------------------------------------------------------------------------- */
/* 0. CONSTANTS                                                               */
/* -------------------------------------------------------------------------- */

/** Frames between unconditional full repaints — the blit drift guard (§6.26). */
const DRIFT_GUARD_FRAMES = 2000;
/** Autoscale re-measure period, ms (§9.3.5). */
const MEASURE_PERIOD_MS = 250;
/** Axis shrink ease duration, ms (§9.3.5). */
const SHRINK_EASE_MS = 4000;
/** Hysteresis band below which a shrink is not started (§9.3.5). */
const SHRINK_HYSTERESIS = 0.20;
/** Top / bottom headroom on an autoscaled axis (§9.3.5). */
const HEADROOM_TOP = 0.08;
const HEADROOM_BOTTOM = 0.04;
/** Nested right-hand axis spacing, css px (§9.3.1). */
const RIGHT_AXIS_STEP = 46;
/** Live edge sits at this fraction of the plot width while following (§9.3.4). */
const LIVE_EDGE_FRAC = 0.85;
/** Below this samples-per-pixel the decimator is bypassed and raw points are drawn. */
const RAW_SPP = 1.5;
/** Overview strip height, css px (§9.3.4). */
const OVERVIEW_H = 36;
/** aria-live announcement throttle, ms (§9.7). */
const ARIA_PERIOD_MS = 400;
/** Nice-number mantissa ladder for axis bounds (§9.3.5). */
const NICE_LADDER = [1, 2, 2.5, 5, 10];
/** Finer ladder for the auto-fit window span, so growth still happens in rungs. */
const SPAN_LADDER = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Default x-channel names per x-mode (§5.1). */
const XCH_DEFAULT = Object.freeze({ volume: 'V_mL', time: 't_s', cv: 'V_CV' });

/** Axis titles per x-mode. Time is logged in seconds and displayed in minutes. */
const X_TITLE = Object.freeze({
  volume: 'Volume (mL)',
  time: 'Time (min)',
  cv: 'Column volumes (CV)',
});

/** Short x unit suffix per mode, for the cursor card. */
const X_UNIT = Object.freeze({ volume: 'mL', time: 'min', cv: 'CV' });

/**
 * The default y-axis stack of §9.3.1. L1 left; R1/R2/R3 right, nested 46 px apart.
 * R2 is the fixed context axis: pH 2–12 is its primary scale and %B 0–100 is its
 * `alt` scale, which is an exact affine remap, so both channels read correctly off
 * one 46 px gutter.
 */
const DEFAULT_Y_AXES = Object.freeze([
  { id: 'l1', label: 'Absorbance', unit: 'mAU', side: 'left', mode: 'auto-sticky', min: 0, max: 100 },
  { id: 'r1', label: 'Conductivity', unit: 'mS/cm', side: 'right', mode: 'auto-sticky', min: 0, max: 10 },
  {
    id: 'r2', label: 'pH', unit: '', side: 'right', mode: 'manual', min: 2, max: 12,
    alt: { label: '%B', unit: '%', min: 0, max: 100 },
  },
  { id: 'r3', label: 'Pressure / flow', unit: 'bar', side: 'right', mode: 'auto-sticky', min: 0, max: 5 },
]);

/**
 * The eight default series of §9.3.1. Every channel carries a dash signature as well as
 * a colour, so colour is never the sole encoder.
 */
const DEFAULT_SERIES = Object.freeze([
  { id: 'uv280', label: 'UV 280', channel: 'UV_280_mAU', yAxis: 'l1', colorVar: '--ch-uv280', dash: [], width: 1.5, visible: true },
  { id: 'uv260', label: 'UV 260', channel: 'UV_260_mAU', yAxis: 'l1', colorVar: '--ch-uv260', dash: [], width: 2, visible: false },
  { id: 'uv300', label: 'UV 300', channel: 'UV_300_mAU', yAxis: 'l1', colorVar: '--ch-uv300', dash: [1, 4], width: 1, visible: false },
  { id: 'cond', label: 'Conductivity', channel: 'cond_mS_cm', yAxis: 'r1', colorVar: '--ch-cond', dash: [], width: 1.5, visible: true },
  { id: 'ph', label: 'pH', channel: 'pH', yAxis: 'r2', colorVar: '--ch-ph', dash: [6, 3], width: 1.5, visible: true },
  { id: 'pctb', label: '%B', channel: 'pctB_column_inlet', yAxis: 'r2', alt: true, fill: 0.10, colorVar: '--ch-pctb', dash: [], width: 1.5, visible: true },
  { id: 'press', label: 'Pressure', channel: 'P1_bar', yAxis: 'r3', colorVar: '--ch-press', dash: [3, 3], width: 1.5, visible: true },
  { id: 'flow', label: 'Flow', channel: 'flow_mL_min', yAxis: 'r3', colorVar: '--ch-flow', dash: [8, 2, 2, 2], width: 1.5, visible: false },
]);

/** Channel-token fallbacks, used when styles/tokens.css has not defined them (§9.3.1). */
const FALLBACK_CH = Object.freeze({
  dark: {
    '--ch-uv280': '#4CC9F0', '--ch-uv260': '#B388FF', '--ch-uv300': '#FF8FA3',
    '--ch-cond': '#F2A93B', '--ch-ph': '#4ADE80', '--ch-pctb': '#E5E9EF',
    '--ch-press': '#FF6B57', '--ch-flow': '#64D9C4',
  },
  light: {
    '--ch-uv280': '#0B7EA8', '--ch-uv260': '#6D3FD1', '--ch-uv300': '#C2185B',
    '--ch-cond': '#B26A00', '--ch-ph': '#0F8A4A', '--ch-pctb': '#37414D',
    '--ch-press': '#C4341C', '--ch-flow': '#0E7C6B',
  },
});

/** Theme-token fallbacks, used when styles/tokens.css has not loaded (§9.4.1). */
const FALLBACK_THEME = Object.freeze({
  dark: {
    '--bg-1': '#121821', '--surface-1': '#161E29', '--surface-2': '#1C2733',
    '--line': '#2A3441', '--line-soft': '#212A35', '--line-strong': '#3A4757',
    '--text-1': '#E6EDF5', '--text-2': '#A7B4C4', '--text-3': '#71818F',
    '--accent': '#5DA9FF', '--accent-soft': 'rgba(93,169,255,0.14)',
    '--grid': 'rgba(255,255,255,0.06)', '--grid-strong': 'rgba(255,255,255,0.11)',
    '--warn': '#E8A33D', '--alarm': '#F2544B', '--focus': '#8FD0FF',
  },
  light: {
    '--bg-1': '#F6F8FA', '--surface-1': '#FFFFFF', '--surface-2': '#F2F5F8',
    '--line': '#D3DAE3', '--line-soft': '#E3E8EE', '--line-strong': '#AAB6C4',
    '--text-1': '#0F1720', '--text-2': '#48566A', '--text-3': '#6B7A8C',
    '--accent': '#0B72D8', '--accent-soft': 'rgba(11,114,216,0.12)',
    '--grid': 'rgba(15,23,32,0.08)', '--grid-strong': 'rgba(15,23,32,0.16)',
    '--warn': '#9A6300', '--alarm': '#C42B22', '--focus': '#0B72D8',
  },
});

/**
 * Phase-band tints (§9.3.3): load amber 6 %, wash blue 5 %, elute violet 7 %,
 * strip/CIP teal 6 %, everything else neutral. Keyed on BOTH the raw §5.4 block type
 * and the short kind slug a caller may already have collapsed it to, so a band set
 * built either way tints identically.
 */
const TINT_LOAD = 'rgba(242,169,59,0.06)';
const TINT_WASH = 'rgba(76,201,240,0.05)';
const TINT_ELUTE = 'rgba(179,136,255,0.07)';
const TINT_STRIP = 'rgba(125,242,184,0.06)';
const BAND_TINT = Object.freeze({
  LOAD: TINT_LOAD, load: TINT_LOAD,
  WASH: TINT_WASH, wash: TINT_WASH,
  ELUTION_ISOCRATIC: TINT_ELUTE,
  ELUTION_LINEAR: TINT_ELUTE,
  ELUTION_STEP: TINT_ELUTE,
  elute: TINT_ELUTE,
  STRIP: TINT_STRIP, CIP: TINT_STRIP, strip: TINT_STRIP,
});

/** name -> { unit, decimals } for every fixed numeric log channel (§5.1). */
const CHANNEL_META = (() => {
  const m = new Map();
  for (let i = 0; i < NUMERIC_CHANNELS.length; i++) {
    const row = NUMERIC_CHANNELS[i];
    m.set(row[0], { unit: row[1], decimals: row[3] });
  }
  return m;
})();

/** Canvas font stacks. `ctx.font` is a CSS font shorthand and cannot resolve var(). */
const FONT_UI = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const FONT_NUM = 'ui-monospace, "Cascadia Mono", "Segoe UI Mono", Menlo, Consolas, monospace';

/* -------------------------------------------------------------------------- */
/* 1. SMALL NUMERIC HELPERS                                                   */
/* -------------------------------------------------------------------------- */

/**
 * First index with `x[i] >= target` over `x[0..n)`. Local copy so the hot decimation
 * loop never crosses a module boundary and stays monomorphic.
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
 * Clamp helper (chart-local; ui/* may not import core/util.js under §4).
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
 * Nice tick step for an axis span (§9.3.2, §9.3.5).
 * @param {number} raw Raw step estimate, axis unit.
 * @returns {number} Step on the 1/2/2.5/5x10^n ladder.
 */
function niceStep(raw) {
  return ladderCeil(raw, NICE_LADDER);
}

/**
 * Fixed decimal count implied by a tick step, so digits never change width (§9.7).
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
 * Read one CSS custom property out of a cached token map, tolerating both `--name`
 * and `name` keying, with a documented fallback.
 * @param {object|null} tokens Cached map from `format.readThemeTokens`.
 * @param {string} name Custom property name including the leading `--`.
 * @param {string} fallback Value used when the token is absent.
 * @returns {string} A CSS colour string.
 */
function tokenOf(tokens, name, fallback) {
  if (tokens) {
    const a = tokens[name];
    if (typeof a === 'string' && a.length > 0) return a.trim();
    const b = tokens[name.slice(2)];
    if (typeof b === 'string' && b.length > 0) return b.trim();
  }
  return fallback;
}

/**
 * The theme the document is currently showing.
 * @returns {'dark'|'light'} Active theme name.
 */
function activeTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/* -------------------------------------------------------------------------- */
/* 2. STYLES                                                                  */
/* -------------------------------------------------------------------------- */

const CHART_CSS = `
.chart{position:relative;display:flex;flex-direction:column;width:100%;height:100%;
  min-height:180px;min-width:220px;font-family:var(--font-ui,system-ui,sans-serif);
  color:var(--text-1,#E6EDF5);user-select:none}
.chart__plot{position:relative;flex:1 1 auto;min-height:120px;cursor:crosshair;outline:none}
.chart__plot:focus-visible{outline:2px solid var(--focus,#8FD0FF);outline-offset:-2px}
.chart__plot--pan{cursor:grab}
.chart__plot--panning{cursor:grabbing}
.chart__plot--pool{cursor:cell}
.chart__layer{position:absolute;inset:0;width:100%;height:100%;display:block}
.chart__layer--static{z-index:1}
.chart__layer--traces{z-index:2}
.chart__layer--overlay{z-index:3;touch-action:none}
.chart__ov{position:relative;flex:0 0 auto;height:36px;margin-top:4px;cursor:ew-resize}
.chart__ov canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.chart__card{position:absolute;top:0;left:0;z-index:4;pointer-events:none;
  min-width:172px;max-width:260px;padding:6px 8px;border-radius:6px;
  background:var(--surface-2,#1C2733);border:1px solid var(--line,#2A3441);
  box-shadow:var(--shadow-2,0 6px 20px rgba(0,0,0,.45));
  font-size:var(--fs-11,11px);line-height:1.45;opacity:0;transition:opacity 90ms linear;
  will-change:transform}
.chart__card--on{opacity:1;pointer-events:auto;user-select:text}
.chart__card-x{font-family:var(--font-num,ui-monospace,monospace);
  font-variant-numeric:tabular-nums lining-nums;color:var(--text-2,#A7B4C4);
  padding-bottom:4px;margin-bottom:4px;border-bottom:1px solid var(--line-soft,#212A35)}
.chart__card-row{display:flex;align-items:center;gap:6px;white-space:nowrap}
.chart__sw{flex:0 0 auto;width:14px;height:0;border-top-width:2px;border-top-style:solid}
.chart__card-lab{flex:1 1 auto;color:var(--text-2,#A7B4C4);overflow:hidden;
  text-overflow:ellipsis}
.chart__card-val{flex:0 0 auto;font-family:var(--font-num,ui-monospace,monospace);
  font-variant-numeric:tabular-nums lining-nums;color:var(--text-1,#E6EDF5);font-weight:600}
.chart__card-unit{flex:0 0 auto;color:var(--text-3,#71818F);font-size:var(--fs-10,10px)}
.chart__tools{position:absolute;top:6px;right:8px;z-index:5;display:flex;gap:4px}
.chart__btn{height:22px;padding:0 8px;border-radius:var(--r-pill,999px);
  border:1px solid var(--line,#2A3441);background:var(--surface-2,#1C2733);
  color:var(--text-2,#A7B4C4);font:600 11px/1 var(--font-ui,system-ui,sans-serif);
  cursor:pointer}
.chart__btn:hover{background:var(--surface-3,#243040);color:var(--text-1,#E6EDF5)}
.chart__btn:focus-visible{outline:2px solid var(--focus,#8FD0FF);outline-offset:2px}
.chart__btn[aria-pressed="true"]{background:var(--accent-soft,rgba(93,169,255,.14));
  border-color:var(--accent,#5DA9FF);color:var(--text-1,#E6EDF5)}
.chart__live{position:absolute;bottom:48px;right:12px;z-index:5;height:24px;padding:0 10px;
  border-radius:var(--r-pill,999px);border:1px solid var(--accent,#5DA9FF);
  background:var(--accent-soft,rgba(93,169,255,.14));color:var(--text-1,#E6EDF5);
  font:600 11px/22px var(--font-ui,system-ui,sans-serif);cursor:pointer;display:none}
.chart__live--on{display:block}
.chart__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.chart__table{display:none;flex:0 0 auto;max-height:220px;overflow:auto;margin-top:6px;
  border:1px solid var(--line,#2A3441);border-radius:var(--r-2,5px);
  background:var(--surface-1,#161E29)}
.chart__table--on{display:block}
.chart__table table{border-collapse:collapse;width:100%;font-size:var(--fs-11,11px)}
.chart__table caption{text-align:left;padding:6px 8px;color:var(--text-3,#71818F);
  font-size:var(--fs-10,10px);text-transform:uppercase;letter-spacing:.06em}
.chart__table th,.chart__table td{padding:2px 8px;text-align:right;
  border-bottom:1px solid var(--line-soft,#212A35);
  font-family:var(--font-num,ui-monospace,monospace);
  font-variant-numeric:tabular-nums lining-nums;white-space:nowrap}
.chart__table th{position:sticky;top:0;background:var(--surface-2,#1C2733);
  color:var(--text-3,#71818F);font-weight:600;text-transform:uppercase;
  font-size:var(--fs-10,10px);letter-spacing:.04em}
.chart__table td:first-child,.chart__table th:first-child{text-align:left}
@media (prefers-reduced-motion: reduce){ .chart__card{transition:none} }
`;

/**
 * Inject the chart stylesheet once. `styles/app.css` belongs to another owner, so the
 * chart carries its own scoped rules and consumes theme tokens through `var()` with
 * spec-accurate fallbacks.
 * @returns {void}
 */
function ensureStyles() {
  if (document.getElementById('chart-css')) return;
  const st = document.createElement('style');
  st.id = 'chart-css';
  st.textContent = CHART_CSS;
  document.head.appendChild(st);
}

/* -------------------------------------------------------------------------- */
/* 3. COLOURS AND GEOMETRY                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve every colour the painters need for one theme, once per theme change.
 * Reading CSS custom properties per frame is a layout-thrash trap (§6.25).
 * @param {'dark'|'light'|'current'} theme Theme to resolve.
 * @param {Array<object>} series Series list, for the per-series channel tokens.
 * @returns {object} A flat colour map plus a `series[id]` stroke map.
 */
function resolveColors(theme, series) {
  const name = theme === 'current' ? activeTheme() : theme;
  let tokens = null;
  try {
    tokens = readThemeTokens(theme);
  } catch (err) {
    tokens = null;
  }
  const fb = FALLBACK_THEME[name] || FALLBACK_THEME.dark;
  const fc = FALLBACK_CH[name] || FALLBACK_CH.dark;
  const c = {
    theme: name,
    bg: tokenOf(tokens, '--surface-1', fb['--surface-1']),
    panel: tokenOf(tokens, '--bg-1', fb['--bg-1']),
    surface2: tokenOf(tokens, '--surface-2', fb['--surface-2']),
    line: tokenOf(tokens, '--line', fb['--line']),
    lineSoft: tokenOf(tokens, '--line-soft', fb['--line-soft']),
    lineStrong: tokenOf(tokens, '--line-strong', fb['--line-strong']),
    text1: tokenOf(tokens, '--text-1', fb['--text-1']),
    text2: tokenOf(tokens, '--text-2', fb['--text-2']),
    text3: tokenOf(tokens, '--text-3', fb['--text-3']),
    accent: tokenOf(tokens, '--accent', fb['--accent']),
    accentSoft: tokenOf(tokens, '--accent-soft', fb['--accent-soft']),
    grid: tokenOf(tokens, '--grid', fb['--grid']),
    gridStrong: tokenOf(tokens, '--grid-strong', fb['--grid-strong']),
    warn: tokenOf(tokens, '--warn', fb['--warn']),
    alarm: tokenOf(tokens, '--alarm', fb['--alarm']),
    bandA: name === 'light' ? 'rgba(15,23,32,0.030)' : 'rgba(255,255,255,0.028)',
    bandB: name === 'light' ? 'rgba(15,23,32,0.055)' : 'rgba(255,255,255,0.055)',
    series: Object.create(null),
  };
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    c.series[s.id] = tokenOf(tokens, s.colorVar, fc[s.colorVar] || c.text2);
  }
  return c;
}

/**
 * True when at least one visible series draws on the given axis.
 * @param {object} chart The chart.
 * @param {string} axisId Axis id.
 * @returns {boolean} Whether the axis must be drawn.
 */
function axisHasVisibleSeries(chart, axisId) {
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (s.visible && s.yAxis === axisId) return true;
  }
  return false;
}

/**
 * Recompute the plot rectangle from the cached element size and the visible axis set.
 * Never reads the DOM — sizes come from the `ResizeObserver` callback (§6.24).
 * @param {object} chart The chart.
 * @returns {void}
 */
function layout(chart) {
  const g = chart.geom;
  let nRight = 0;
  let hasLeft = false;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    a.visible = axisHasVisibleSeries(chart, a.id);
    if (!a.visible) continue;
    if (a.side === 'left') hasLeft = true;
    else nRight++;
  }
  g.padL = hasLeft ? 56 : 14;
  g.padR = 14 + RIGHT_AXIS_STEP * nRight;
  g.padT = 22;
  g.padB = 42;
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
 * Grow the per-series min/max buffers and the shared boundary tables to the current
 * pixel width. Caller-owned outputs, zero allocation once the size is stable (§6.26).
 * @param {object} chart The chart.
 * @returns {void}
 */
function ensureBuffers(chart) {
  const p = chart.geom.pixels;
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (!s.minBuf || s.minBuf.length < p) {
      s.minBuf = new Float32Array(p);
      s.maxBuf = new Float32Array(p);
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
    cx.lineJoin = 'round';
    cx.miterLimit = 2;
  }
  chart.blit.w = w;
  chart.blit.h = hp;
  chart.blit.valid = false;
  chart.blit.validPx = 0;
  if (chart.ovCanvas) {
    const ow = w;
    const oh = Math.max(1, Math.round(OVERVIEW_H * g.dpr));
    if (chart.ovCanvas.width !== ow) chart.ovCanvas.width = ow;
    if (chart.ovCanvas.height !== oh) chart.ovCanvas.height = oh;
    chart.gOv.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    chart.ovDirty = true;
  }
  ensureBuffers(chart);
}

/* -------------------------------------------------------------------------- */
/* 4. X WINDOW                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The store channel name backing the current x-mode.
 * @param {object} chart The chart.
 * @returns {string} Channel name, 'V_mL' | 't_s' | 'V_CV'.
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
 *  - auto-fit: `x0 = 0` and the span is snapped up the {@link SPAN_LADDER}, so the span
 *    changes only when it crosses a rung and the blit buffer survives between rungs;
 *  - fixed-span follow (after a zoom, then "Jump to live"): the window scrolls so the
 *    live edge sits at 85 % width, quantised to whole device pixels so the self-blit
 *    accumulates no sub-pixel error.
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
  // ACCUMULATE, never assign: a frame that scrolls but then takes the full-repaint
  // branch must not leave its delta behind for the next append to re-apply. The full
  // repaint zeroes it; the append path consumes it.
  chart.scrollPx += dPx;
  return true;
}

/**
 * Map the visible window through the row index when the x-mode changes, so the same
 * samples stay on screen (§9.3.2). Uses `log.xIndexRange`, which is legal because every
 * x channel is monotone non-decreasing (§6.2).
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
  let a = nx[i0];
  let b = nx[i1];
  if (!(b > a)) b = a + (chart.xMode === 'time' ? 60 : 1);
  chart.x0 = a;
  chart.x1 = b;
}

/* -------------------------------------------------------------------------- */
/* 5. Y AXES AND AUTOSCALE                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Series value -> axis value. Identity unless the series rides the axis' `alt` scale
 * (the %B-on-the-pH-gutter case of §9.3.1), which is an exact affine remap.
 * @param {object} s Series.
 * @param {object} a Axis.
 * @param {number} v Series value.
 * @returns {number} Value in the axis' primary unit.
 */
function toAxisValue(s, a, v) {
  if (!s.alt || !a.alt) return v;
  const span = a.alt.max - a.alt.min;
  if (!(span !== 0)) return v;
  return a.min + ((v - a.alt.min) / span) * (a.max - a.min);
}

/**
 * Recompute every autoscaled axis from the freshly decimated per-series buffers.
 * The max grows immediately; a shrink is armed only outside a 20 % hysteresis band and
 * then eased over 4 s (§9.3.5). Reduced motion applies the shrink at once (§9.7).
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
    for (let j = 0; j < chart.series.length; j++) {
      const s = chart.series[j];
      if (!s.visible || s.yAxis !== a.id || !s.hasData) continue;
      const mn = s.dataMin;
      const mx = s.dataMax;
      if (mn !== mn || mx !== mx) continue;
      const av0 = toAxisValue(s, a, mn);
      const av1 = toAxisValue(s, a, mx);
      if (av0 < lo) lo = av0;
      if (av1 > hi) hi = av1;
    }
    if (!(lo <= hi)) {
      lo = 0;
      hi = a.mode === 'auto' ? 1 : Math.max(1, a.targetMax);
    }
    if (lo > 0) lo = 0; // chromatography axes are anchored at zero unless data goes negative
    let span = hi - lo;
    if (!(span > 0)) span = Math.abs(hi) > 0 ? Math.abs(hi) : 1;
    const wantMax = hi + span * HEADROOM_TOP;
    const wantMin = lo - (lo < 0 ? span * HEADROOM_BOTTOM : 0);

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
    a.targetMin = Math.min(0, wantMin);
  }
}

/**
 * Advance the shrink ease and quantise the applied bounds onto the nice-number ladder.
 * Quantising is what keeps a 4 s shrink to a handful of full repaints instead of 240
 * (§6.26): the eased value moves continuously, the applied bound only steps at a rung.
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
      lo = lo < 0 ? -Math.ceil(-lo / step - 1e-9) * step : 0;
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
 * Precompute the per-series pixel mapping `py = bPix - v*kPix`, folding the axis
 * transform and any `alt` remap into two scalars so the point loop never branches.
 * @param {object} chart The chart.
 * @param {object} g Geometry (may be an export geometry, not the live one).
 * @returns {void}
 */
function prepareMapping(chart, g) {
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    const span = a.aMax - a.aMin;
    a.k = span !== 0 ? g.plotH / span : 0;
    a.b = g.py1 + a.aMin * a.k;
  }
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    const a = chart.axisById.get(s.yAxis);
    if (!a) {
      s.kPix = 0;
      s.bPix = g.py1;
      continue;
    }
    let ka = 1;
    let ba = 0;
    if (s.alt && a.alt) {
      const as = a.alt.max - a.alt.min;
      if (as !== 0) {
        ka = (a.aMax - a.aMin) / as;
        ba = a.aMin - a.alt.min * ka;
      }
    }
    s.kPix = a.k * ka;
    s.bPix = a.b - ba * a.k;
  }
}

/* -------------------------------------------------------------------------- */
/* 6. DECIMATION                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the shared `pixelStart` boundary table for the current window. Recomputed
 * only when the window bounds, the pixel width or `store.n` change — not per frame and
 * not per series (§6.2, §6.26); every series then reuses one table and the inner loop
 * stays index-based.
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
 * Min/max fold over a half-open run of rows per bin, using a precomputed boundary
 * table. Empty bins receive `NaN`; `NaN` samples are skipped so a `NaN` in e.g.
 * `UV_ratio_260_280` cannot poison a bin (matches `log.decimateMinMax`).
 * @param {Float32Array} y Series channel view.
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
 * Decimate every visible series over the whole window into its own buffers and record
 * the per-series data range for the autoscaler. This is the measured ~1.3 ms pass for
 * 50 k rows x 8 series (§12 D25); it runs at 4 Hz, not per frame.
 * @param {object} chart The chart.
 * @returns {void}
 */
function decimateAllVisible(chart) {
  const g = chart.geom;
  const p = g.pixels;
  const haveTable = ensurePixelTable(chart);
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    s.hasData = false;
    s.dataMin = NaN;
    s.dataMax = NaN;
    if (!s.visible || !chart.store) continue;
    const y = column(chart.store, s.channel);
    if (y.length === 0) continue;
    if (haveTable) {
      decimateBins(y, chart.pixelStart, 0, 0, p, s.minBuf, s.maxBuf);
    } else {
      decimateMinMax(chart.store, xChannel(chart), s.channel, chart.x0, chart.x1, p, s.minBuf, s.maxBuf);
    }
    let mn = NaN;
    let mx = NaN;
    for (let b = 0; b < p; b++) {
      const a = s.minBuf[b];
      if (a === a) {
        if (mn !== mn || a < mn) mn = a;
        const c = s.maxBuf[b];
        if (mx !== mx || c > mx) mx = c;
      }
    }
    s.dataMin = mn;
    s.dataMax = mx;
    s.hasData = mn === mn;
  }
  chart.dataBinsValid = true;
  chart.dataBinsX0 = chart.x0;
  chart.dataBinsX1 = chart.x1;
  chart.dataBinsN = chart.store ? chart.store.n : 0;
}

/* -------------------------------------------------------------------------- */
/* 7. TRACE PAINTING                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Samples per device pixel column over the current window. Below {@link RAW_SPP} the
 * decimator is bypassed and raw points are drawn (§6.26).
 * @param {object} chart The chart.
 * @param {object} g Geometry in use.
 * @returns {number} Samples per pixel, 0 when there is no source.
 */
function samplesPerPixel(chart, g) {
  if (!chart.store || chart.store.n === 0) return 0;
  const r = xIndexRange(chart.store, xChannel(chart), chart.x0, chart.x1);
  return (r.i1 - r.i0) / Math.max(1, g.pixels);
}

/**
 * Stroke one series across a bin range from its decimated envelope. Emits at most two
 * vertices per pixel column: `lineTo(x, yMin); lineTo(x, yMax)` (§6.26). Empty bins
 * break the path so a gap in the log is never bridged by a straight line.
 * @param {CanvasRenderingContext2D} ctx Target context, already dpr-scaled.
 * @param {object} s Series with `minBuf`/`maxBuf` filled for `[bStart,bEnd)`.
 * @param {object} g Geometry in use.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @returns {void}
 */
function strokeEnvelope(ctx, s, g, bStart, bEnd) {
  const invDpr = 1 / g.dpr;
  const x0 = g.px0;
  const kPix = s.kPix;
  const bPix = s.bPix;
  const yTop = g.py0 - 2;
  const yBot = g.py1 + 2;
  let pen = false;
  ctx.beginPath();
  for (let b = bStart; b < bEnd; b++) {
    const lo = s.minBuf[b];
    if (lo !== lo) {
      pen = false;
      continue;
    }
    const hi = s.maxBuf[b];
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
 * Fill the area under a series' envelope down to the axis floor — the %B context band
 * of §9.3.1, alpha 0.10. Drawn before any stroke so it never sits over data.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} s Series with buffers filled.
 * @param {object} g Geometry in use.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @returns {void}
 */
function fillEnvelope(ctx, s, g, bStart, bEnd) {
  const invDpr = 1 / g.dpr;
  const x0 = g.px0;
  const kPix = s.kPix;
  const bPix = s.bPix;
  const base = g.py1;
  let run = -1;
  ctx.beginPath();
  for (let b = bStart; b <= bEnd; b++) {
    const hi = b < bEnd ? s.maxBuf[b] : NaN;
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
 * Draw one series as raw points, used when `samplesPerPixel < 1.5` (§6.26).
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} chart The chart.
 * @param {object} s Series.
 * @param {object} g Geometry in use.
 * @param {number} xa Window start of the drawn range, x-channel unit.
 * @param {number} xb Window end of the drawn range, x-channel unit.
 * @returns {void}
 */
function strokeRaw(ctx, chart, s, g, xa, xb) {
  const xcol = column(chart.store, xChannel(chart));
  const y = column(chart.store, s.channel);
  let n = xcol.length;
  if (y.length < n) n = y.length;
  if (n === 0) return;
  const kx = g.plotW / (chart.x1 - chart.x0);
  const bx = g.px0 - chart.x0 * kx;
  const kPix = s.kPix;
  const bPix = s.bPix;
  const yTop = g.py0 - 2;
  const yBot = g.py1 + 2;
  let i = lowerBoundF32(xcol, n, xa);
  if (i > 0) i--; // one sample of lead-in so the segment entering the range is drawn
  let pen = false;
  ctx.beginPath();
  for (; i < n; i++) {
    const xv = xcol[i];
    if (xv > xb) {
      // draw one trailing sample so the segment leaving the range is closed
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
 * Configure a context for one series' stroke: colour, width, dash. Set once per series,
 * never per segment (§9.3.5).
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} chart The chart.
 * @param {object} s Series.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function applyStrokeStyle(ctx, chart, s, colors) {
  ctx.strokeStyle = colors.series[s.id] || colors.text2;
  let w = s.width;
  if (chart.contrastMore && w < 2) w = 2;
  ctx.lineWidth = w;
  ctx.globalAlpha = s.dim ? 0.2 : 1;
  if (s.dash && s.dash.length > 0) ctx.setLineDash(s.dash);
  else ctx.setLineDash(EMPTY_DASH);
}

const EMPTY_DASH = [];

/**
 * Paint every visible series over a bin range into a context, decimating first.
 * Draw order is %B fill, then lines in reverse legend order so UV 280 ends up on top
 * (§9.3.5).
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @param {number} bStart First bin, absolute.
 * @param {number} bEnd One past the last bin, absolute.
 * @param {Int32Array|null} starts Boundary table covering `[bStart,bEnd]`, or null to
 *   use the chart's cached full-window table.
 * @param {number} off Bin index that `starts[0]` refers to.
 * @returns {void}
 */
function paintSeriesBins(chart, ctx, g, colors, bStart, bEnd, starts, off) {
  if (bEnd <= bStart || !chart.store) return;
  const table = starts || chart.pixelStart;
  const tOff = starts ? off : 0;
  const raw = chart.rawMode;
  const xa = chart.x0 + ((bStart - 0.5) * (chart.x1 - chart.x0)) / g.pixels;
  const xb = chart.x0 + ((bEnd + 0.5) * (chart.x1 - chart.x0)) / g.pixels;

  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (!s.visible) continue;
    const y = column(chart.store, s.channel);
    if (y.length === 0) continue;
    if (!raw) decimateBins(y, table, tOff, bStart, bEnd, s.minBuf, s.maxBuf);
    if (!s.fill) continue;
    ctx.globalAlpha = s.dim ? s.fill * 0.2 : s.fill;
    ctx.fillStyle = colors.series[s.id] || colors.text2;
    if (raw) {
      fillRaw(ctx, chart, s, g, xa, xb);
    } else {
      fillEnvelope(ctx, s, g, bStart, bEnd);
    }
  }
  ctx.globalAlpha = 1;

  for (let i = chart.series.length - 1; i >= 0; i--) {
    const s = chart.series[i];
    if (!s.visible) continue;
    const y = column(chart.store, s.channel);
    if (y.length === 0) continue;
    applyStrokeStyle(ctx, chart, s, colors);
    if (raw) strokeRaw(ctx, chart, s, g, xa, xb);
    else strokeEnvelope(ctx, s, g, bStart, bEnd);
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash(EMPTY_DASH);
}

/**
 * Filled area under a raw-mode trace.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} chart The chart.
 * @param {object} s Series.
 * @param {object} g Geometry in use.
 * @param {number} xa Range start, x-channel unit.
 * @param {number} xb Range end, x-channel unit.
 * @returns {void}
 */
function fillRaw(ctx, chart, s, g, xa, xb) {
  const xcol = column(chart.store, xChannel(chart));
  const y = column(chart.store, s.channel);
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
    const py = clamp(s.bPix - v * s.kPix, g.py0, base);
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
 * Clear the plot rectangle of a dpr-scaled context.
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {object} g Geometry in use.
 * @returns {void}
 */
function clearPlot(ctx, g) {
  ctx.clearRect(g.px0 - 1, g.py0 - 1, g.plotW + 2, g.plotH + 2);
}

/**
 * Full traces repaint over the whole window. When following, the result is painted into
 * the detached blit buffer and composited; otherwise it goes straight to the traces
 * canvas.
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
  paintSeriesBins(chart, ctx, g, colors, 0, g.pixels, null, 0);
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
 * Composite the finalized buffer onto the traces canvas and paint the newest <=3 px
 * column live. The buffer is blitted with an identity transform so the copy is an exact
 * integer device-pixel move with no resampling (§6.26, §11 C-38).
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
    paintSeriesBins(chart, ctx, g, chart.colors, from, edge, starts, from);
    ctx.restore();
  }
}

/**
 * The append-only fast path: shift the buffer by whole device pixels, finalize any
 * columns that have fallen more than 2 px behind the live edge, then composite.
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
    paintSeriesBins(chart, ctx, g, chart.colors, from, newValid, starts, from);
    ctx.restore();
    b.validPx = newValid;
  }
  clearBufferRight(chart, b.validPx);
  compositeAndLive(chart);
  chart.lastPaintedN = chart.store ? chart.store.n : 0;
  return true;
}

/* -------------------------------------------------------------------------- */
/* 8. STATIC LAYER — axes, bands, ticks, annotations                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute the x tick positions for the current window, in display units.
 * Nice-number spacing targeting 60–110 px (§9.3.2).
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
  const target = clamp(Math.round(g.plotH / 48), 2, 12);
  const step = niceStep(span / target);
  const first = Math.ceil(a.aMin / step - 1e-9) * step;
  const count = Math.max(0, Math.floor((a.aMax - first) / step + 1e-9) + 1);
  return { first, step, count: Math.min(count, 32), decimals: decimalsFor(step) };
}

/**
 * Truncate a label to a pixel budget with an ellipsis (§9.3.3).
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
 * Paint the phase/block shading bands and their labels (§9.3.3).
 * @param {object} chart The chart.
 * @param {CanvasRenderingContext2D} ctx Static context.
 * @param {object} g Geometry in use.
 * @param {object} colors Colour map in use.
 * @returns {void}
 */
function paintBands(chart, ctx, g, colors) {
  const bands = chart.bands;
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
  chart.bandLabelSpots.length = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.x1 <= chart.x0 || b.x0 >= chart.x1) continue;
    const a0 = Math.max(b.x0, chart.x0) * kx + bx;
    const a1 = Math.min(b.x1, chart.x1) * kx + bx;
    const w = a1 - a0;
    if (!(w > 0)) continue;
    if (chart.contrastMore) {
      ctx.strokeStyle = colors.lineStrong;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(a0) + 0.5, g.py0);
      ctx.lineTo(Math.round(a0) + 0.5, g.py1);
      ctx.stroke();
    } else {
      ctx.fillStyle = i % 2 === 0 ? colors.bandA : colors.bandB;
      ctx.fillRect(a0, g.py0, w, g.plotH);
      const tint = BAND_TINT[b.kind];
      if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(a0, g.py0, w, g.plotH);
      }
      ctx.fillStyle = colors.lineSoft;
      ctx.fillRect(Math.round(a0), g.py0, 1, g.plotH);
    }
    const label = b.label ? String(b.label).toUpperCase() : '';
    if (!label) continue;
    if (w < 34) {
      chart.bandLabelSpots.push({ x0: a0, x1: a1, text: label });
      continue;
    }
    ctx.fillStyle = colors.text3;
    const fitted = ellipsize(ctx, label, w - 8);
    if (fitted) ctx.fillText(fitted, a0 + 4, g.py0 - 15);
  }
  ctx.restore();
}

/**
 * Paint the pooled-fraction region: a translucent accent rect with solid edges and a
 * top drag handle (§9.3.3).
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
  ctx.fillStyle = colors.accentSoft;
  ctx.fillRect(a0, g.py0, a1 - a0, g.plotH);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(a0, g.py0);
  ctx.lineTo(a0, g.py1);
  ctx.moveTo(a1, g.py0);
  ctx.lineTo(a1, g.py1);
  ctx.stroke();
  ctx.fillStyle = colors.accent;
  ctx.fillRect(a0, g.py0, a1 - a0, 4);
}

/**
 * Paint fraction ticks, event markers and peak flags (§9.3.3). Tick ids are drawn on
 * every fifth mark, or on every mark once they are more than 40 px apart. Peak flags use
 * greedy anti-overlap in 14 px steps, capped at three rows, then a leader line.
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

  // --- ticks -------------------------------------------------------------
  ctx.save();
  ctx.font = '9px ' + FONT_NUM;
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
    ctx.strokeStyle = colors.text3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, g.py1);
    ctx.lineTo(Math.round(px) + 0.5, g.py1 + 8);
    ctx.stroke();
    if (m.label && (tickIdx - 1) % labelEvery === 0) {
      ctx.fillStyle = colors.text3;
      ctx.fillText(String(m.label), px, g.py1 + 9);
    }
  }
  ctx.restore();

  // --- full-height lines and axis chevrons -------------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.px0, g.py0 - g.padT, g.plotW, g.plotH + g.padT);
  ctx.clip();
  ctx.font = '9px ' + FONT_UI;
  ctx.textBaseline = 'top';
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.kind !== 'line') continue;
    const px = m.x * kx + bx;
    if (px < g.px0 - 1 || px > g.px1 + 1) continue;
    ctx.strokeStyle = m.severity === 'ALARM' || m.severity === 'CRITICAL' ? colors.alarm
      : m.severity === 'WARN' ? colors.warn : colors.lineStrong;
    ctx.lineWidth = 1;
    ctx.setLineDash(MARKER_DASH);
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, g.py0);
    ctx.lineTo(Math.round(px) + 0.5, g.py1);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
    // chevron at the bottom axis
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(px - 4, g.py1 + 1);
    ctx.lineTo(px + 4, g.py1 + 1);
    ctx.lineTo(px, g.py1 + 7);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // --- peak flags --------------------------------------------------------
  const flags = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.kind !== 'flag') continue;
    const px = m.x * kx + bx;
    if (px < g.px0 - 40 || px > g.px1 + 40) continue;
    const s = m.seriesId ? chart.seriesById.get(m.seriesId) : null;
    const apexY = s && typeof m.y === 'number' && isFinite(m.y)
      ? clamp(s.bPix - m.y * s.kPix, g.py0, g.py1)
      : g.py0 + 10;
    flags.push({ m, px, apexY, seriesId: m.seriesId });
  }
  flags.sort((a, b) => a.apexY - b.apexY);
  const placed = [];
  ctx.save();
  ctx.font = '600 10px ' + FONT_UI;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'center';
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const text = String(f.m.label || '');
    const w = ctx.measureText(text).width + 8;
    let row = 0;
    let ly = f.apexY - 8;
    for (; row < 3; row++) {
      ly = f.apexY - 8 - row * 14;
      let hit = false;
      for (let k = 0; k < placed.length; k++) {
        const q = placed[k];
        if (Math.abs(q.y - ly) < 12 && Math.abs(q.x - f.px) < (q.w + w) / 2) {
          hit = true;
          break;
        }
      }
      if (!hit) break;
    }
    const leader = row >= 3;
    if (leader) ly = f.apexY - 8 - 2 * 14;
    ly = Math.max(g.py0 + 10, ly);
    placed.push({ x: f.px, y: ly, w });
    // A flag anchored to a series takes that series' colour; an unanchored event flag
    // takes its severity colour, so an alarm annotation is never mistaken for a peak.
    const sev = f.m.severity;
    const col = f.seriesId && chart.colors.series[f.seriesId]
      ? chart.colors.series[f.seriesId]
      : sev === 'ALARM' || sev === 'CRITICAL' || sev === 'FAULT' ? colors.alarm
        : sev === 'WARN' ? colors.warn : colors.text2;
    // drop line at the apex
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(f.px) + 0.5, f.apexY);
    ctx.lineTo(Math.round(f.px) + 0.5, ly + 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (leader) {
      ctx.strokeStyle = colors.text3;
      ctx.beginPath();
      ctx.moveTo(f.px, ly + 2);
      ctx.lineTo(f.px + 10, ly - 4);
      ctx.stroke();
    }
    // integration boundaries
    if (typeof f.m.x0 === 'number' && typeof f.m.x1 === 'number') {
      ctx.strokeStyle = colors.text3;
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
    }
    if (text) {
      ctx.fillStyle = colors.text1;
      ctx.fillText(text, leader ? f.px + 10 + w / 2 : f.px, ly);
    }
  }
  ctx.restore();
}

const MARKER_DASH = [3, 3];

/**
 * Paint the axes, gridlines, band shading, annotations and the empty state.
 * Repainted only on window/zoom/theme/visibility change or when a band, marker or pool
 * set changes — under 5 repaints per second even during a run (§6.26).
 * @param {object} chart The chart.
 * @param {object} rc Render target: `{ ctx, geom, colors, background }`.
 * @returns {void}
 */
function paintStatic(chart, rc) {
  const ctx = rc.ctx;
  const g = rc.geom;
  const colors = rc.colors;
  ctx.clearRect(0, 0, g.cssW, g.cssH);
  if (rc.background) {
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, g.cssW, g.cssH);
  }
  prepareMapping(chart, g);
  paintBands(chart, ctx, g, colors);
  paintPool(chart, ctx, g, colors);

  const xp = xTickPlan(chart, g);
  const kx = g.plotW / (chart.x1 - chart.x0);
  const bx = g.px0 - chart.x0 * kx;

  // vertical gridlines
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < xp.count; i++) {
    const dv = xp.first + i * xp.step;
    const px = Math.round(fromDisp(chart, dv) * kx + bx) + 0.5;
    if (px < g.px0 || px > g.px1) continue;
    ctx.moveTo(px, g.py0);
    ctx.lineTo(px, g.py1);
  }
  ctx.stroke();

  // horizontal gridlines from the first visible axis
  const gridAxis = chart.yAxes.find((a) => a.visible) || null;
  if (gridAxis) {
    const yp = yTickPlan(gridAxis, g);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    for (let i = 0; i < yp.count; i++) {
      const v = yp.first + i * yp.step;
      const py = Math.round(gridAxis.b - v * gridAxis.k) + 0.5;
      if (py < g.py0 || py > g.py1) continue;
      ctx.moveTo(g.px0, py);
      ctx.lineTo(g.px1, py);
    }
    ctx.stroke();
  }

  paintMarkers(chart, ctx, g, colors);

  // plot frame
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(g.px0) + 0.5, Math.round(g.py0) + 0.5, Math.round(g.plotW) - 1, Math.round(g.plotH) - 1);

  // x tick labels and title
  ctx.fillStyle = colors.text2;
  ctx.font = '10px ' + FONT_NUM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < xp.count; i++) {
    const dv = xp.first + i * xp.step;
    const px = fromDisp(chart, dv) * kx + bx;
    if (px < g.px0 - 1 || px > g.px1 + 1) continue;
    ctx.fillText(dv.toFixed(xp.decimals), px, g.py1 + 18);
  }
  ctx.fillStyle = colors.text3;
  ctx.font = '10px ' + FONT_UI;
  ctx.textAlign = 'right';
  ctx.fillText(X_TITLE[chart.xMode], g.px1, g.py1 + 30);

  paintYAxes(chart, ctx, g, colors);

  if (!chart.store || chart.store.n === 0) {
    ctx.fillStyle = colors.text3;
    ctx.font = '12px ' + FONT_UI;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No run yet. Load a scenario or press Start.', (g.px0 + g.px1) / 2, (g.py0 + g.py1) / 2);
  }
}

/**
 * Paint every visible y axis: the spine, its ticks and its title. R2 additionally draws
 * its `alt` scale in the alt series' colour, which is how pH and %B share one 46 px
 * gutter without either becoming unreadable (§9.3.1).
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
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(spineX, g.py0);
    ctx.lineTo(spineX, g.py1);
    ctx.stroke();

    // Does any visible series on this axis use the primary scale?
    let primaryUsed = false;
    let altSeries = null;
    for (let j = 0; j < chart.series.length; j++) {
      const s = chart.series[j];
      if (!s.visible || s.yAxis !== a.id) continue;
      if (s.alt && a.alt) altSeries = s;
      else primaryUsed = true;
    }
    const showPrimary = primaryUsed || !altSeries;
    const yp = yTickPlan(a, g);
    ctx.font = '10px ' + FONT_NUM;
    ctx.textAlign = left ? 'right' : 'left';
    for (let k = 0; k < yp.count; k++) {
      const v = yp.first + k * yp.step;
      const py = a.b - v * a.k;
      if (py < g.py0 - 1 || py > g.py1 + 1) continue;
      ctx.strokeStyle = colors.line;
      ctx.beginPath();
      ctx.moveTo(spineX, Math.round(py) + 0.5);
      ctx.lineTo(spineX + (left ? -4 : 4), Math.round(py) + 0.5);
      ctx.stroke();
      if (!showPrimary) continue;
      ctx.fillStyle = colors.text2;
      ctx.fillText(v.toFixed(yp.decimals), spineX + (left ? -7 : 7), py);
    }
    if (altSeries && a.alt) {
      const span = a.aMax - a.aMin;
      const aspan = a.alt.max - a.alt.min;
      ctx.fillStyle = colors.series[altSeries.id] || colors.text3;
      ctx.font = '9px ' + FONT_NUM;
      ctx.textAlign = left ? 'right' : 'left';
      const off = showPrimary ? (left ? -34 : 34) : (left ? -7 : 7);
      for (let k = 0; k < yp.count; k++) {
        const v = yp.first + k * yp.step;
        const py = a.b - v * a.k;
        if (py < g.py0 - 1 || py > g.py1 + 1) continue;
        const av = a.alt.min + ((v - a.aMin) / span) * aspan;
        ctx.fillText(av.toFixed(0), spineX + off, py);
      }
    }

    // title
    ctx.save();
    ctx.translate(spineX + (left ? -40 : 40), (g.py0 + g.py1) / 2);
    ctx.rotate(left ? -Math.PI / 2 : Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colors.text3;
    ctx.font = '10px ' + FONT_UI;
    const unit = a.unit ? ' (' + a.unit + ')' : '';
    let title = a.label + unit;
    if (altSeries && a.alt) title += '  ·  ' + a.alt.label;
    ctx.fillText(ellipsize(ctx, title, g.plotH - 8), 0, left ? 0 : 10);
    ctx.restore();
  }
}

/* -------------------------------------------------------------------------- */
/* 9. OVERLAY LAYER                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Paint the crosshair, the drag rectangle, the live-edge marker and the hover ribbon
 * for narrow phase bands. Cleared and repainted every frame; budget 0.2 ms (§6.26).
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

  // live edge
  if (chart.store && chart.store.n > 0) {
    const lx = liveX(chart) * kx + bx;
    if (lx >= g.px0 && lx <= g.px1) {
      ctx.strokeStyle = colors.accent;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(lx) + 0.5, g.py0);
      ctx.lineTo(Math.round(lx) + 0.5, g.py1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      ctx.moveTo(lx - 3, g.py0);
      ctx.lineTo(lx + 3, g.py0);
      ctx.lineTo(lx, g.py0 + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  // crosshair
  if (chart.cursor.on && chart.cursor.x === chart.cursor.x) {
    const cx = chart.cursor.x * kx + bx;
    if (cx >= g.px0 - 1 && cx <= g.px1 + 1) {
      ctx.strokeStyle = colors.text3;
      ctx.lineWidth = 1;
      ctx.setLineDash(CROSS_DASH);
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, g.py0);
      ctx.lineTo(Math.round(cx) + 0.5, g.py1);
      ctx.stroke();
      ctx.setLineDash(EMPTY_DASH);
      for (let i = 0; i < chart.series.length; i++) {
        const s = chart.series[i];
        if (!s.visible || !(s.cursorValue === s.cursorValue)) continue;
        const py = s.bPix - s.cursorValue * s.kPix;
        if (py < g.py0 || py > g.py1) continue;
        ctx.fillStyle = colors.series[s.id] || colors.text2;
        ctx.beginPath();
        ctx.arc(cx, py, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // drag rectangle
  const d = chart.drag;
  if (d.active && (d.mode === 'zoomX' || d.mode === 'zoomXY')) {
    const a0 = Math.min(d.px0, d.pxNow);
    const a1 = Math.max(d.px0, d.pxNow);
    const b0 = d.mode === 'zoomXY' ? Math.min(d.py0, d.pyNow) : g.py0;
    const b1 = d.mode === 'zoomXY' ? Math.max(d.py0, d.pyNow) : g.py1;
    ctx.fillStyle = colors.accentSoft;
    ctx.fillRect(a0, b0, a1 - a0, b1 - b0);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a0) + 0.5, Math.round(b0) + 0.5, Math.round(a1 - a0), Math.round(b1 - b0));
  }

  // hover ribbon for narrow bands
  if (chart.hoverPx >= 0 && chart.bandLabelSpots.length > 0) {
    for (let i = 0; i < chart.bandLabelSpots.length; i++) {
      const sp = chart.bandLabelSpots[i];
      if (chart.hoverPx < sp.x0 || chart.hoverPx > sp.x1) continue;
      ctx.font = '600 10px ' + FONT_UI;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const w = ctx.measureText(sp.text).width + 10;
      const rx = clamp(sp.x0, g.px0, g.px1 - w);
      ctx.fillStyle = colors.surface2;
      ctx.fillRect(rx, g.py0 - 20, w, 16);
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(rx) + 0.5, Math.round(g.py0 - 20) + 0.5, Math.round(w), 16);
      ctx.fillStyle = colors.text2;
      ctx.fillText(sp.text, rx + 5, g.py0 - 12);
      break;
    }
  }
}

const CROSS_DASH = [2, 3];

/* -------------------------------------------------------------------------- */
/* 10. OVERVIEW STRIP                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Repaint the 36 px overview strip: the whole run decimated with
 * `log.decimateMinMax`, plus the draggable window brush (§9.3.4). Throttled to 4 Hz.
 * @param {object} chart The chart.
 * @returns {void}
 */
function paintOverview(chart) {
  if (!chart.ovCanvas) return;
  const g = chart.geom;
  const ctx = chart.gOv;
  const colors = chart.colors;
  const w = g.cssW;
  const hgt = OVERVIEW_H;
  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, w, hgt);
  ctx.strokeStyle = colors.lineSoft;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, hgt - 1);
  if (!chart.store || chart.store.n === 0) return;

  const xName = xChannel(chart);
  const xcol = column(chart.store, xName);
  const full1 = xcol.length > 0 ? xcol[xcol.length - 1] : 1;
  const full0 = 0;
  const span = full1 - full0 > 0 ? full1 - full0 : 1;
  const px0 = 2;
  const px1 = w - 2;
  const pix = Math.max(1, Math.round((px1 - px0) * g.dpr));
  if (!chart.ovMin || chart.ovMin.length < pix) {
    chart.ovMin = new Float32Array(pix);
    chart.ovMax = new Float32Array(pix);
  }
  const invDpr = 1 / g.dpr;
  for (let i = chart.series.length - 1; i >= 0; i--) {
    const s = chart.series[i];
    if (!s.visible) continue;
    decimateMinMax(chart.store, xName, s.channel, full0, full1, pix, chart.ovMin, chart.ovMax);
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
    const k = (hgt - 6) / (hi - lo);
    const base = hgt - 3 + lo * k;
    ctx.strokeStyle = colors.series[s.id] || colors.text3;
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

  // brush
  const kx = (px1 - px0) / span;
  const a0 = clamp(px0 + (chart.x0 - full0) * kx, px0, px1);
  const a1 = clamp(px0 + (chart.x1 - full0) * kx, px0, px1);
  ctx.fillStyle = colors.accentSoft;
  ctx.fillRect(a0, 1, Math.max(2, a1 - a0), hgt - 2);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(a0) + 0.5, 1.5, Math.max(2, Math.round(a1 - a0)), hgt - 3);
  chart.ovGeom = { px0, px1, full0, full1, kx };
  chart.ovDirty = false;
}

/* -------------------------------------------------------------------------- */
/* 11. CURSOR READOUT (DOM)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the cursor card's rows when the visible series set changes. Rendered in DOM,
 * not canvas, so the text is selectable and reachable by assistive technology (§9.3.4).
 * @param {object} chart The chart.
 * @returns {void}
 */
function rebuildCursorRows(chart) {
  let key = '';
  for (let i = 0; i < chart.series.length; i++) {
    if (chart.series[i].visible) key += chart.series[i].id + '|';
  }
  if (key === chart.cursorRowsKey) return;
  chart.cursorRowsKey = key;
  while (chart.cardBody.firstChild) chart.cardBody.removeChild(chart.cardBody.firstChild);
  chart.cardRows.length = 0;
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (!s.visible) continue;
    const sw = h('span', { class: 'chart__sw' });
    const lab = h('span', { class: 'chart__card-lab' }, s.label);
    const val = h('span', { class: 'chart__card-val' }, '—');
    const unit = h('span', { class: 'chart__card-unit' }, s.unit || '');
    const row = h('div', { class: 'chart__card-row' }, sw, lab, val, unit);
    chart.cardBody.appendChild(row);
    chart.cardRows.push({ id: s.id, sw, val });
  }
  styleSwatches(chart);
}

/**
 * Paint each cursor-card swatch as the series' actual stroke sample — colour plus dash
 * signature — so colour is never the sole encoder (§9.3.1).
 * @param {object} chart The chart.
 * @returns {void}
 */
function styleSwatches(chart) {
  for (let i = 0; i < chart.cardRows.length; i++) {
    const r = chart.cardRows[i];
    const s = chart.seriesById.get(r.id);
    if (!s) continue;
    const col = chart.colors.series[s.id] || chart.colors.text2;
    if (s.dash && s.dash.length > 0) {
      const on = s.dash[0];
      const off = s.dash[1] === undefined ? on : s.dash[1];
      r.sw.style.borderTopStyle = 'none';
      r.sw.style.height = '2px';
      r.sw.style.background =
        'repeating-linear-gradient(90deg,' + col + ' 0 ' + on + 'px,transparent ' + on + 'px ' + (on + off) + 'px)';
    } else {
      r.sw.style.background = 'none';
      r.sw.style.height = '0';
      r.sw.style.borderTopStyle = 'solid';
      r.sw.style.borderTopColor = col;
      r.sw.style.borderTopWidth = Math.max(2, s.width) + 'px';
    }
  }
}

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
 * Update the cursor card's text and position, and cache each series' value at the
 * cursor for the overlay dots and for `hitTest`.
 * @param {object} chart The chart.
 * @param {number} pxCss Pointer x in plot-local css px, or NaN to hide.
 * @param {number} pyCss Pointer y in plot-local css px.
 * @returns {void}
 */
function updateCursor(chart, pxCss, pyCss) {
  const g = chart.geom;
  if (!(pxCss === pxCss) || !chart.store || chart.store.n === 0) {
    chart.cursor.on = false;
    cls(chart.card, 'chart__card--on', false);
    for (let i = 0; i < chart.series.length; i++) chart.series[i].cursorValue = NaN;
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

  rebuildCursorRows(chart);
  const volTxt = smp.volume === smp.volume ? smp.volume.toFixed(1) + ' mL' : '— mL';
  const timeTxt = smp.time === smp.time ? (smp.time / 60).toFixed(2) + ' min' : '— min';
  const cvTxt = smp.cv === smp.cv ? smp.cv.toFixed(3) + ' CV' : '— CV';
  setText(chart.cardX, volTxt + '  ·  ' + timeTxt + '  ·  ' + cvTxt);

  const values = Object.create(null);
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (!s.visible) {
      s.cursorValue = NaN;
      continue;
    }
    const y = column(chart.store, s.channel);
    const v = smp.index < y.length ? y[smp.index] : NaN;
    s.cursorValue = v;
    values[s.id] = v;
  }
  for (let i = 0; i < chart.cardRows.length; i++) {
    const r = chart.cardRows[i];
    const s = chart.seriesById.get(r.id);
    const v = s ? s.cursorValue : NaN;
    setText(r.val, v === v ? v.toFixed(s.decimals) : '—');
  }

  // place the card on the side with more room
  const rightRoom = g.px1 - pxCss;
  const cardW = 190;
  const left = rightRoom < cardW + 16 ? pxCss - cardW - 14 : pxCss + 14;
  const top = clamp(pyCss - 10, g.py0, Math.max(g.py0, g.py1 - 120));
  chart.card.style.transform = 'translate(' + Math.round(clamp(left, 2, Math.max(2, g.cssW - cardW - 2))) + 'px,' + Math.round(top) + 'px)';
  cls(chart.card, 'chart__card--on', true);
  chart.dirty.overlay = true;
  if (chart.handlers.onCursor) {
    chart.handlers.onCursor({ x: smp.x, index: smp.index, volume: smp.volume, time: smp.time, cv: smp.cv, values });
  }
}

/**
 * Announce the readout cursor into the polite live region, throttled to one
 * announcement per 400 ms (§9.7).
 * @param {object} chart The chart.
 * @param {number} now_ms Frame or event timestamp.
 * @returns {void}
 */
function announceCursor(chart, now_ms) {
  if (now_ms - chart.lastAria_ms < ARIA_PERIOD_MS) return;
  chart.lastAria_ms = now_ms;
  if (!chart.cursor.on) return;
  let msg = 'At ' + toDisp(chart, chart.cursor.x).toFixed(2) + ' ' + X_UNIT[chart.xMode] + '. ';
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (!s.visible || !(s.cursorValue === s.cursorValue)) continue;
    msg += s.label + ' ' + s.cursorValue.toFixed(s.decimals) + ' ' + (s.unit || '') + '. ';
  }
  setText(chart.srLive, msg);
}

/**
 * Refresh the traces canvas' `aria-label` summary, at most once per second (§9.7).
 * @param {object} chart The chart.
 * @param {number} now_ms Frame timestamp.
 * @returns {void}
 */
function updateAriaLabel(chart, now_ms) {
  if (now_ms - chart.lastLabel_ms < 1000) return;
  chart.lastLabel_ms = now_ms;
  let n = 0;
  let latest = '';
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (!s.visible) continue;
    n++;
    if (chart.store && chart.store.n > 0 && latest.length < 120) {
      const y = column(chart.store, s.channel);
      const v = y.length > 0 ? y[y.length - 1] : NaN;
      if (v === v) latest += s.label + ' ' + v.toFixed(s.decimals) + ' ' + (s.unit || '') + '; ';
    }
  }
  const label =
    'Chromatogram. X axis ' + chart.xMode + ', ' + toDisp(chart, chart.x0).toFixed(1) + ' to ' +
    toDisp(chart, chart.x1).toFixed(1) + ' ' + X_UNIT[chart.xMode] + '. ' + n + ' channels shown. ' +
    (latest ? 'Latest ' + latest : 'No data yet.');
  chart.cvTraces.setAttribute('aria-label', label);
}

/* -------------------------------------------------------------------------- */
/* 12. ACCESSIBLE DATA TABLE                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the accessible data table: the run decimated to every 1 % of its x range.
 * This is the accessible alternative to the canvas, not an afterthought (§9.7).
 * @param {object} chart The chart.
 * @returns {void}
 */
function rebuildTable(chart) {
  const wrap = chart.tableWrap;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  chart.tableCells = null;
  if (!chart.store || chart.store.n === 0) {
    wrap.appendChild(h('table', {}, h('caption', {}, 'Chromatogram data — no samples yet')));
    return;
  }
  const vis = chart.series.filter((s) => s.visible);
  const head = [h('th', { scope: 'col' }, X_TITLE[chart.xMode])];
  for (let i = 0; i < vis.length; i++) {
    head.push(h('th', { scope: 'col' }, vis[i].label + (vis[i].unit ? ' (' + vis[i].unit + ')' : '')));
  }
  const thead = h('thead', {}, h('tr', {}, ...head));
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
  const tbody = h('tbody', {}, ...rows);
  wrap.appendChild(
    h('table', {}, h('caption', {}, 'Chromatogram data, sampled every 1 % of the run'), thead, tbody)
  );
  chart.tableCells = cells;
  chart.tableSeries = vis;
  fillTable(chart);
}

/**
 * Refresh the data table's cell text without rebuilding any DOM.
 * @param {object} chart The chart.
 * @returns {void}
 */
function fillTable(chart) {
  if (!chart.tableCells || !chart.store || chart.store.n === 0) return;
  const xName = xChannel(chart);
  const xc = column(chart.store, xName);
  const n = xc.length;
  if (n === 0) return;
  const x1 = xc[n - 1];
  const vis = chart.tableSeries;
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
      setText(cell.vals[i], v === v ? v.toFixed(vis[i].decimals) : '');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 13. INTERACTION                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Apply a new x window, clamping the span so a zoom can never invert or collapse.
 * @param {object} chart The chart.
 * @param {number} x0 New start, x-channel unit.
 * @param {number} x1 New end, x-channel unit.
 * @param {boolean} manual True when the change came from the operator, which drops
 *   follow and auto-fit (§9.3.4).
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
  if (manual) {
    chart.follow = false;
    chart.autoFit = false;
    cls(chart.livePill, 'chart__live--on', true);
  }
  chart.blit.valid = false;
  chart.tableValid = false;
  chart.dirty.static = true;
  chart.dirty.traces = true;
  chart.dirty.overlay = true;
  if (chart.handlers.onZoom) chart.handlers.onZoom({ x0: chart.x0, x1: chart.x1, mode: chart.xMode });
}

/**
 * Reset to the whole run: auto-fit plus live follow (double-click, §9.3.4).
 * @param {object} chart The chart.
 * @returns {void}
 */
function resetView(chart) {
  chart.autoFit = true;
  chart.follow = true;
  cls(chart.livePill, 'chart__live--on', false);
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
  updateFollowWindow(chart);
  if (chart.handlers.onZoom) chart.handlers.onZoom({ x0: chart.x0, x1: chart.x1, mode: chart.xMode });
}

/**
 * Pixel x -> x-channel value.
 * @param {object} chart The chart.
 * @param {number} px Plot-local css px.
 * @returns {number} x value.
 */
function pxToX(chart, px) {
  const g = chart.geom;
  return chart.x0 + ((px - g.px0) / g.plotW) * (chart.x1 - chart.x0);
}

/**
 * Which pool handle, if any, is under a pointer position.
 * @param {object} chart The chart.
 * @param {number} px Plot-local css px.
 * @param {number} py Plot-local css px.
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
 * Wire pointer, wheel and keyboard interaction on the plot and the overview strip.
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
    chart.plotEl.focus({ preventScroll: true });
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
    cls(chart.plotEl, 'chart__plot--panning', pan);
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
      cls(chart.plotEl, 'chart__plot--pool', hh !== null);
      cls(chart.plotEl, 'chart__plot--pan', chart.spaceDown);
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
    cls(chart.plotEl, 'chart__plot--panning', false);
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
      cls(chart.plotEl, 'chart__plot--pan', true);
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
        const idx = chart.store && chart.store.n > 0 ? chart.store.n - 1 : -1;
        chart.cursor.index = idx;
        moveReadout(chart, 0);
      } else {
        updateCursor(chart, NaN, NaN);
      }
      e.preventDefault();
      return;
    }
    if (k === 'Home' || k === 'End') {
      const span = chart.x1 - chart.x0;
      if (k === 'Home') applyWindow(chart, 0, span, true);
      else {
        chart.follow = true;
        chart.autoFit = false;
        cls(chart.livePill, 'chart__live--on', false);
        chart.blit.valid = false;
        chart.dirty.traces = true;
      }
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
      cls(chart.plotEl, 'chart__plot--pan', false);
    }
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', onDbl);
  chart.plotEl.addEventListener('keydown', onKeyDown);
  chart.plotEl.addEventListener('keyup', onKeyUp);
  chart.listeners.push(
    [el, 'pointerdown', onDown], [el, 'pointermove', onMove], [el, 'pointerup', onUp],
    [el, 'pointercancel', onUp], [el, 'pointerleave', onLeave], [el, 'wheel', onWheel],
    [el, 'dblclick', onDbl], [chart.plotEl, 'keydown', onKeyDown], [chart.plotEl, 'keyup', onKeyUp]
  );

  if (chart.ovCanvas) bindOverview(chart);
}

/**
 * Step the accessible readout cursor by whole samples and announce it (§9.7).
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
 * Scale every autoscaled axis about a pixel anchor (ctrl+wheel, §9.3.4). Axes move to
 * manual so the operator's choice is not immediately overwritten by the autoscaler.
 * @param {object} chart The chart.
 * @param {number} py Anchor, plot-local css px.
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
}

/**
 * Wire the overview strip's window brush (§9.3.4).
 * @param {object} chart The chart.
 * @returns {void}
 */
function bindOverview(chart) {
  const el = chart.ovCanvas;
  const state = { active: false, mode: 'move', x0: 0, w0: 0 };

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
/* 14. CONSTRUCTION                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Normalise one series descriptor, filling the unit and the fixed decimal count from
 * the log channel table (§5.1) unless the caller overrode them.
 * @param {object} src Caller descriptor.
 * @returns {object} A live series record.
 */
function makeSeries(src) {
  const meta = CHANNEL_META.get(src.channel);
  return {
    id: src.id,
    label: src.label || src.id,
    channel: src.channel,
    yAxis: src.yAxis,
    alt: src.alt === true,
    fill: typeof src.fill === 'number' ? src.fill : 0,
    colorVar: src.colorVar || '--text-2',
    dash: Array.isArray(src.dash) ? src.dash.slice() : [],
    width: typeof src.width === 'number' ? src.width : 1.5,
    visible: src.visible !== false,
    unit: src.unit !== undefined ? src.unit : meta ? meta.unit : '',
    decimals: typeof src.decimals === 'number' ? src.decimals : meta ? meta.decimals : 2,
    dim: false,
    minBuf: null,
    maxBuf: null,
    hasData: false,
    dataMin: NaN,
    dataMax: NaN,
    cursorValue: NaN,
    kPix: 0,
    bPix: 0,
  };
}

/**
 * Normalise one y-axis descriptor.
 * @param {object} src Caller descriptor.
 * @returns {object} A live axis record.
 */
function makeAxis(src) {
  const mode = src.mode || 'auto-sticky';
  return {
    id: src.id,
    label: src.label || src.id,
    unit: src.unit === undefined ? '' : src.unit,
    side: src.side === 'left' ? 'left' : 'right',
    mode,
    baseMode: mode,
    userManual: false,
    min: typeof src.min === 'number' ? src.min : 0,
    max: typeof src.max === 'number' ? src.max : 1,
    alt: src.alt ? { label: src.alt.label, unit: src.alt.unit || '', min: src.alt.min, max: src.alt.max } : null,
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
 * Create the chart. Builds the three stacked canvases, the DOM cursor card, the
 * optional overview strip and the accessible data-table toggle, then wires the
 * `ResizeObserver`, `IntersectionObserver` and theme observer that keep the chart from
 * ever reading layout inside `frame` (§6.24, §6.26).
 *
 * @param {Element} rootEl Host element; the chart appends one wrapper to it.
 * @param {object} [opts] Options.
 * @param {{mode:'volume'|'time'|'cv'}} [opts.xAxis] Initial x-axis mode.
 * @param {Array<{id:string,label:string,unit:string,side:'left'|'right',
 *   mode:'auto-sticky'|'auto'|'manual',min:number,max:number,
 *   alt?:{label:string,unit:string,min:number,max:number}}>} [opts.yAxes] Axis stack;
 *   defaults to L1/R1/R2/R3 of §9.3.1.
 * @param {Array<{id:string,label:string,channel:string,yAxis:string,colorVar:string,
 *   dash:number[],width:number,visible:boolean,alt?:boolean,fill?:number}>} [opts.series]
 *   Series list in legend order; defaults to the eight channels of §9.3.1.
 * @param {boolean} [opts.overview] Draw the 36 px overview strip. Default true.
 * @returns {object} The Chart handle, passed back into every other export.
 */
export function createChart(rootEl, opts) {
  ensureStyles();
  const o = opts || {};
  const wrap = h('div', { class: 'chart' });
  const plot = h('div', {
    class: 'chart__plot',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Chromatogram, interactive',
  });
  const cvStatic = h('canvas', { class: 'chart__layer chart__layer--static', 'aria-hidden': 'true' });
  const cvTraces = h('canvas', {
    class: 'chart__layer chart__layer--traces',
    role: 'img',
    'aria-label': 'Chromatogram. No data yet.',
  });
  const cvOverlay = h('canvas', { class: 'chart__layer chart__layer--overlay', 'aria-hidden': 'true' });
  const cardX = h('div', { class: 'chart__card-x' }, '');
  const cardBody = h('div', {});
  const card = h('div', { class: 'chart__card' }, cardX, cardBody);
  const livePill = h('button', { class: 'chart__live', type: 'button' }, 'Jump to live');
  const tableBtn = h(
    'button',
    { class: 'chart__btn', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Toggle the accessible data table' },
    'Data table'
  );
  const tools = h('div', { class: 'chart__tools' }, tableBtn);
  const srLive = h('div', { class: 'chart__sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  plot.appendChild(cvStatic);
  plot.appendChild(cvTraces);
  plot.appendChild(cvOverlay);
  plot.appendChild(card);
  plot.appendChild(livePill);
  plot.appendChild(tools);
  plot.appendChild(srLive);
  wrap.appendChild(plot);

  const wantOverview = o.overview !== false;
  let ovEl = null;
  let ovCanvas = null;
  if (wantOverview) {
    ovCanvas = h('canvas', { 'aria-hidden': 'true' });
    ovEl = h('div', { class: 'chart__ov' }, ovCanvas);
    wrap.appendChild(ovEl);
  }
  const tableWrap = h('div', { class: 'chart__table' });
  wrap.appendChild(tableWrap);
  rootEl.appendChild(wrap);

  const blitCanvas = document.createElement('canvas');
  const series = (o.series || DEFAULT_SERIES).map(makeSeries);
  const yAxes = (o.yAxes || DEFAULT_Y_AXES).map(makeAxis);

  const chart = {
    root: rootEl,
    el: wrap,
    plotEl: plot,
    cvStatic,
    cvTraces,
    cvOverlay,
    gStatic: cvStatic.getContext('2d'),
    gTraces: cvTraces.getContext('2d'),
    gOverlay: cvOverlay.getContext('2d'),
    card,
    cardX,
    cardBody,
    cardRows: [],
    cursorRowsKey: '',
    livePill,
    tableBtn,
    tableWrap,
    tableCells: null,
    tableSeries: [],
    tableOpen: false,
    srLive,
    ovEl,
    ovCanvas,
    gOv: ovCanvas ? ovCanvas.getContext('2d') : null,
    ovMin: null,
    ovMax: null,
    ovGeom: null,
    ovDirty: true,
    blit: { canvas: blitCanvas, ctx: blitCanvas.getContext('2d'), w: 0, h: 0, valid: false, validPx: 0 },

    store: null,
    xChannels: Object.assign({}, XCH_DEFAULT),
    xMode: (o.xAxis && o.xAxis.mode) || 'volume',
    x0: 0,
    x1: 100,
    autoFit: true,
    follow: true,
    scrollPx: 0,

    series,
    seriesById: new Map(series.map((s) => [s.id, s])),
    yAxes,
    axisById: new Map(yAxes.map((a) => [a.id, a])),

    bands: [],
    markers: [],
    bandLabelSpots: [],
    pool: { on: false, x0: 0, x1: 0 },

    pixelStart: new Int32Array(1),
    stripStart: new Int32Array(1),
    tableValid: false,
    tableX0: NaN,
    tableX1: NaN,
    tablePixels: 0,
    tableN: -1,
    tableCh: '',
    dataBinsValid: false,
    rawMode: false,
    lastPaintedN: -1,

    geom: {
      cssW: 0, cssH: 0, dpr: window.devicePixelRatio || 1,
      padL: 56, padR: 60, padT: 22, padB: 42,
      px0: 56, py0: 22, px1: 100, py1: 100, plotW: 44, plotH: 78, pixels: 1,
    },
    colors: null,
    visible: true,
    interacting: false,
    spaceDown: false,
    hoverPx: -1,
    readoutMode: false,
    cursor: { on: false, x: NaN, index: -1 },
    drag: { active: false, mode: '', px0: 0, py0: 0, pxNow: 0, pyNow: 0, winX0: 0, winX1: 0, handle: '', poolX0: 0, poolX1: 0 },
    handlers: { onZoom: null, onCursor: null, onSelect: null, onPoolDrag: null },
    listeners: [],
    dirty: { static: true, traces: true, overlay: true },
    frameCount: 0,
    lastMeasure_ms: -1e9,
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

  chart.colors = resolveColors('current', chart.series);

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
    const r = entries[0].contentRect;
    const hOv = wantOverview ? OVERVIEW_H + 4 : 0;
    const hTable = chart.tableOpen ? tableWrap.offsetHeight + 6 : 0;
    chart.geom.cssW = Math.max(1, Math.round(r.width));
    chart.geom.cssH = Math.max(1, Math.round(r.height - hOv - hTable));
    chart.geom.dpr = window.devicePixelRatio || 1;
    layout(chart);
    resizeCanvases(chart);
    invalidate(chart, 'all');
  });
  chart.ro.observe(wrap);

  chart.io = new IntersectionObserver((entries) => {
    chart.visible = entries[0].isIntersecting;
  }, { threshold: 0 });
  chart.io.observe(wrap);

  chart.mo = new MutationObserver(() => {
    invalidate(chart, 'all');
  });
  chart.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const onLive = () => {
    chart.follow = true;
    cls(chart.livePill, 'chart__live--on', false);
    chart.blit.valid = false;
    chart.dirty.traces = true;
    chart.dirty.static = true;
  };
  livePill.addEventListener('click', onLive);
  chart.listeners.push([livePill, 'click', onLive]);

  const onTable = () => {
    chart.tableOpen = !chart.tableOpen;
    cls(tableWrap, 'chart__table--on', chart.tableOpen);
    tableBtn.setAttribute('aria-pressed', chart.tableOpen ? 'true' : 'false');
    if (chart.tableOpen) rebuildTable(chart);
  };
  tableBtn.addEventListener('click', onTable);
  chart.listeners.push([tableBtn, 'click', onTable]);

  bindInteractions(chart);
  layout(chart);
  resizeCanvases(chart);
  return chart;
}

/* -------------------------------------------------------------------------- */
/* 15. PUBLIC API                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Point the chart at a channel store. The store's column views are never cached across
 * frames — `pushRow` invalidates them on growth (§6.2) — only the store object is held.
 * @param {object} chart The chart.
 * @param {object} store A `core/log.js` ChannelStore, or null to clear.
 * @param {{volume:string, time:string, cv:string}} [xChannels] Monotone x channel names
 *   per x-mode. Defaults to `{volume:'V_mL', time:'t_s', cv:'V_CV'}`.
 * @returns {void}
 */
export function setSource(chart, store, xChannels) {
  chart.store = store || null;
  if (xChannels) chart.xChannels = Object.assign({}, XCH_DEFAULT, xChannels);
  chart.tableValid = false;
  chart.dataBinsValid = false;
  chart.lastPaintedN = -1;
  chart.blit.valid = false;
  chart.cursor.on = false;
  chart.cursor.index = -1;
  for (let i = 0; i < chart.yAxes.length; i++) {
    const a = chart.yAxes[i];
    a.easeT0 = 0;
    a.targetMax = a.mode === 'manual' ? a.max : Math.max(1, a.max);
  }
  if (chart.tableOpen) rebuildTable(chart);
  invalidate(chart, 'all');
}

/**
 * Re-point one series at a different log channel, taking its unit and fixed decimal
 * count from the channel table (§5.1).
 * @param {object} chart The chart.
 * @param {string} seriesId Series id.
 * @param {string} channelName Numeric log channel name.
 * @returns {void}
 */
export function setSeriesChannel(chart, seriesId, channelName) {
  const s = chart.seriesById.get(seriesId);
  if (!s) return;
  s.channel = channelName;
  const meta = CHANNEL_META.get(channelName);
  if (meta) {
    s.unit = meta.unit;
    s.decimals = meta.decimals;
  }
  chart.cursorRowsKey = '';
  if (chart.tableOpen) rebuildTable(chart);
  invalidate(chart, 'all');
}

/**
 * Show or hide one series. A channel toggle forces a full repaint (§6.26) and may add
 * or remove a y-axis gutter, so the plot rectangle is recomputed.
 * @param {object} chart The chart.
 * @param {string} seriesId Series id.
 * @param {boolean} visible Desired visibility.
 * @returns {void}
 */
export function setSeriesVisible(chart, seriesId, visible) {
  const s = chart.seriesById.get(seriesId);
  if (!s || s.visible === !!visible) return;
  s.visible = !!visible;
  layout(chart);
  ensureBuffers(chart);
  chart.cursorRowsKey = '';
  if (chart.tableOpen) rebuildTable(chart);
  invalidate(chart, 'all');
}

/**
 * Set the visible x window explicitly, in the current x-mode's channel unit. Passing a
 * non-finite pair restores auto-fit plus live follow.
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
 * Switch the x axis between volume, time and CV, preserving the visible window by
 * mapping its bounds through the row index (§9.3.2).
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
  if (chart.tableOpen) rebuildTable(chart);
  invalidate(chart, 'all');
}

/**
 * Enable or disable live follow. Enabling keeps the current span and scrolls the live
 * edge to 85 % width; disabling freezes the window and reveals the "Jump to live" pill.
 * @param {object} chart The chart.
 * @param {boolean} on Desired follow state.
 * @returns {void}
 */
export function setFollow(chart, on) {
  const want = !!on;
  if (chart.follow === want) return;
  chart.follow = want;
  cls(chart.livePill, 'chart__live--on', !want);
  chart.blit.valid = false;
  chart.dirty.traces = true;
  chart.dirty.static = true;
}

/**
 * Mark a layer dirty. `'all'` also re-reads the theme tokens, which is what a theme
 * change requires (§6.26).
 * @param {object} chart The chart.
 * @param {'static'|'traces'|'overlay'|'all'} layer Layer to invalidate.
 * @returns {void}
 */
export function invalidate(chart, layer) {
  if (layer === 'all') {
    chart.colors = resolveColors('current', chart.series);
    styleSwatches(chart);
    chart.dirty.static = true;
    chart.dirty.traces = true;
    chart.dirty.overlay = true;
    chart.blit.valid = false;
    chart.tableValid = false;
    chart.ovDirty = true;
    return;
  }
  if (layer === 'static') chart.dirty.static = true;
  else if (layer === 'traces') {
    chart.dirty.traces = true;
    chart.blit.valid = false;
  } else if (layer === 'overlay') chart.dirty.overlay = true;
}

/**
 * Set the phase/block shading bands (§9.3.3).
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
 * Set the marker set: fraction ticks, event chevrons and peak flags (§9.3.3).
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
 * Set or clear the shaded pooled region (§9.3.3).
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
 * Find the nearest visible sample to a point.
 * @param {object} chart The chart.
 * @param {number} px Pointer x in css px, relative to the chart element.
 * @param {number} py Pointer y in css px, relative to the chart element.
 * @returns {{seriesId:string, index:number, x:number, y:number}|null} The hit, or null
 *   when no visible trace passes within 12 px.
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
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    if (!s.visible) continue;
    const y = column(chart.store, s.channel);
    const v = smp.index < y.length ? y[smp.index] : NaN;
    if (v !== v) continue;
    const d = Math.abs(s.bPix - v * s.kPix - py);
    if (d < bestD) {
      bestD = d;
      best = { seriesId: s.id, index: smp.index, x: smp.x, y: v };
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
 * Render one frame. Called at most once per rAF frame by `ui/app.js`; the chart never
 * owns a rAF loop of its own and never calls `sim.advanceWall` (§6.24, §0).
 *
 * Order: follow-window update, the 4 Hz measure pass, axis easing, then the three
 * layers. A chart that is scrolled out of view or in a hidden tab returns immediately,
 * so a hidden panel costs nothing per frame.
 *
 * @param {object} chart The chart.
 * @param {number} now_ms Frame timestamp, `performance.now()` domain.
 * @returns {void}
 */
export function frame(chart, now_ms) {
  if (chart.destroyed || !chart.visible) return;
  const g = chart.geom;
  if (g.plotW <= 2 || g.plotH <= 2) return;
  chart.frameCount++;

  const measureDue = now_ms - chart.lastMeasure_ms >= MEASURE_PERIOD_MS;
  if (measureDue) {
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== g.dpr) {
      g.dpr = dpr;
      layout(chart);
      resizeCanvases(chart);
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
    // MANDATORY full repaint: the y mapping moved, so blitted history would be drawn
    // at a stale scale and the trace would step against its own axis (§6.26).
    chart.dirty.static = true;
    chart.dirty.traces = true;
    chart.blit.valid = false;
  }

  if (chart.frameCount % DRIFT_GUARD_FRAMES === 0) {
    chart.dirty.traces = true;
    chart.blit.valid = false;
  }

  if (chart.dirty.static) {
    paintStatic(chart, { ctx: chart.gStatic, geom: g, colors: chart.colors, background: false });
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
  updateAriaLabel(chart, now_ms);
}

/**
 * Render the current view into a standalone PNG at an arbitrary size and theme.
 * The theme comes from `format.readThemeTokens(theme)`, which serves a cached map for
 * both themes, so exporting a light-theme figure from a dark session never flips
 * `data-theme` on the live document (§6.25).
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
  const colors = resolveColors(o.theme || 'current', chart.series);

  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);

  const titleH = title ? 34 : 8;
  const footerH = footer ? 26 : 8;
  const geom = {
    cssW: width,
    cssH: height - titleH - footerH,
    dpr: 1,
    padL: 56, padR: 60, padT: 22, padB: 42,
    px0: 56, py0: 22, px1: width - 60, py1: height - titleH - footerH - 42,
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
  for (let i = 0; i < chart.series.length; i++) {
    const s = chart.series[i];
    savedBufs.push([s.minBuf, s.maxBuf]);
    s.minBuf = new Float32Array(geom.pixels);
    s.maxBuf = new Float32Array(geom.pixels);
  }

  try {
    ctx.save();
    ctx.translate(0, titleH);
    paintStatic(chart, { ctx, geom, colors, background: false });
    chart.rawMode = samplesPerPixel(chart, geom) < RAW_SPP;
    prepareMapping(chart, geom);
    if (chart.store && chart.store.n > 0) {
      const starts = buildStripTable(chart, 0, geom.pixels);
      ctx.beginPath();
      ctx.rect(geom.px0, geom.py0 - 1, geom.plotW, geom.plotH + 2);
      ctx.save();
      ctx.clip();
      paintSeriesBins(chart, ctx, geom, colors, 0, geom.pixels, starts, 0);
      ctx.restore();
    }
    ctx.restore();

    if (title) {
      ctx.fillStyle = colors.text1;
      ctx.font = '600 18px ' + FONT_UI;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, 16, titleH / 2 + 2);
    }
    if (footer) {
      ctx.fillStyle = colors.text3;
      ctx.font = '11px ' + FONT_UI;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(footer, 16, height - footerH / 2);
    }
    // legend strip, so the exported figure stands alone
    let lx = width - 16;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '11px ' + FONT_UI;
    for (let i = chart.series.length - 1; i >= 0; i--) {
      const s = chart.series[i];
      if (!s.visible) continue;
      const label = s.label + (s.unit ? ' (' + s.unit + ')' : '');
      const w = ctx.measureText(label).width;
      ctx.fillStyle = colors.text2;
      ctx.fillText(label, lx, titleH / 2 + 2);
      lx -= w + 8;
      ctx.strokeStyle = colors.series[s.id] || colors.text2;
      ctx.lineWidth = Math.max(2, s.width);
      ctx.setLineDash(s.dash && s.dash.length ? s.dash : EMPTY_DASH);
      ctx.beginPath();
      ctx.moveTo(lx - 16, titleH / 2 + 2);
      ctx.lineTo(lx, titleH / 2 + 2);
      ctx.stroke();
      ctx.setLineDash(EMPTY_DASH);
      lx -= 16 + 14;
      if (lx < 240) break;
    }
  } finally {
    chart.geom = savedGeom;
    chart.colors = savedColors;
    chart.stripStart = savedStrip;
    chart.rawMode = savedRaw;
    for (let i = 0; i < chart.series.length; i++) {
      chart.series[i].minBuf = savedBufs[i][0];
      chart.series[i].maxBuf = savedBufs[i][1];
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
 * Tear the chart down: disconnect every observer, remove every listener and detach the
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
    const [target, type, fn] = chart.listeners[i];
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
