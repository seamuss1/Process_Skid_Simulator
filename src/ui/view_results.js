/**
 * @file `src/ui/view_results.js` — the Results tab (architecture-v2 §6.30, §9.3, §9.7).
 *
 * The full-width chromatogram, the peak table, the pooling tool, the metrics cards, the mass
 * balance, the packing-test analysis, the exports and the post-run "What happened" panel.
 *
 * THIS MODULE OWNS THE GRID AND THE PACKING-TEST ANALYSIS (§6.30). It calls
 * `peaks.buildVolumeGrid(config, run)` — the single object cached on `run.grid` (§6.19) — and hands
 * that one object to `detectPeaks`, `poolMetrics`, `rePool` and `autoPool`, so a pool index produced
 * by a chart drag and a peak index produced by the detector always mean the same sample. It is also
 * the only module that imports both analytics modules, which is why `skid/engine.js` runs no
 * `PACKING_TEST` analysis of its own (§5.4.3).
 *
 * The view is READ-ONLY over `config` and `run` with exactly two contract-mandated exceptions, both
 * at operator rate and both named in §6.30:
 *   - `bed.forceFlush(config, run, 'MASS_AUDIT')` before any mass-balance display — `pooling.js` is
 *     L2 and cannot flush itself (§3.4);
 *   - `log.logEvent(..., 'PACKING_TEST_RESULT', ...)` once per analysed packing-test block.
 * Everything else goes through `ctx.sim`.
 *
 * Layout and component classes come from `styles/app.css` (§21 results view plus the shared panel,
 * button, numfield, segmented, table, metric, poolbar and empty-state vocabulary); this module adds
 * only the handful of `rv-*` utilities that file does not define.
 */

import {
  createChart, setSource, setSeriesChannel, setSeriesVisible, setWindow, setXMode, setFollow,
  invalidate, frame as chartFrame, setBands, setMarkers, setPoolWindow, attachInteractions,
  exportPNG, destroyChart,
} from './chart.js';
import {
  h, setText, setAttr, cls, reconcileList,
  fmtVolume, fmtCond, fmtPH, fmtTime,
} from './format.js';
import { createOverlayHost, showGlossaryPopover, showToast, dismiss } from './overlay.js';
import * as peaks from '../analytics/peaks.js';
import * as pooling from '../analytics/pooling.js';
import * as bed from '../physics/bed.js';
import { column as logColumn, xIndexRange, logEvent } from '../core/log.js';
import {
  exportDataCSV, exportEventsCSV, exportFractionsCSV, exportRunJSON,
  downloadText, downloadBlob,
} from '../io/export.js';
import { SCENARIOS } from '../data/presets.js';
import { glossaryFor } from '../data/glossary.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

const STYLE_ID = 'resultsview-style';

/** Peak/pool analysis is operator-rate: never more often than this, in ms. */
const ANALYSIS_MS = 600;
/** Pool metrics during a live drag, in ms. */
const POOL_MS = 100;
/** The mass balance forces a column flush, so it is explicitly rate-limited, in ms. */
const AUDIT_MS = 2000;
/** Rows in the accessible data-table alternative (§9.7): every 1 % of the run. */
const DATA_TABLE_ROWS = 101;
/** |xi| above which a mass-balance row is called open (§5.11.4, DoD 7). */
const XI_TOL = 1e-6;

/**
 * Quality bits (§5.3) that make the UV trace SUSPECT or INVALID. §5.3 requires this view to flag
 * any peak whose window overlaps such an interval.
 */
const UV_SUSPECT_MASK = 0x0001 /* UV_OVERRANGE */ | 0x0002 /* UV_SATURATED */
  | 0x0004 /* UV_LAMP_FAULT */ | 0x0008 /* UV_AUTOZERO_UNSTABLE */
  | 0x0200 /* DETECTORS_BYPASSED */ | 0x0400 /* AIR_IN_PATH */;

/**
 * Chart y-axes. §9.3.1 lists pH and %B both on `R2` with mutually exclusive fixed ranges
 * (2–12 and 0–100), which no single axis can satisfy, so %B is given its own fixed 0–100 axis.
 */
const Y_AXES = [
  { id: 'L1', label: 'Absorbance', unit: 'mAU', side: 'left', mode: 'auto-sticky', min: 0, max: 100 },
  { id: 'R1', label: 'Conductivity', unit: 'mS/cm', side: 'right', mode: 'auto-sticky', min: 0, max: 10 },
  { id: 'R2', label: 'pH', unit: '', side: 'right', mode: 'manual', min: 2, max: 12 },
  { id: 'R3', label: 'Pressure / flow', unit: 'bar', side: 'right', mode: 'auto-sticky', min: 0, max: 2 },
  { id: 'R4', label: '%B', unit: '%', side: 'right', mode: 'manual', min: 0, max: 100 },
];

/** The eight channels of §9.3.1, with their log channel and dash signature. */
const SERIES = [
  { id: 'uv280', channel: 'UV_280_mAU', yAxis: 'L1', colorVar: '--ch-uv280',
    dash: [], width: 1.5, label: 'UV 280', unit: 'mAU', visible: true },
  { id: 'uv260', channel: 'UV_260_mAU', yAxis: 'L1', colorVar: '--ch-uv260',
    dash: [], width: 2, label: 'UV 260', unit: 'mAU', visible: false },
  { id: 'uv300', channel: 'UV_300_mAU', yAxis: 'L1', colorVar: '--ch-uv300',
    dash: [1, 4], width: 1, label: 'UV 300', unit: 'mAU', visible: false },
  { id: 'cond', channel: 'cond_mS_cm', yAxis: 'R1', colorVar: '--ch-cond',
    dash: [], width: 1.5, label: 'Conductivity', unit: 'mS/cm', visible: true },
  { id: 'ph', channel: 'pH', yAxis: 'R2', colorVar: '--ch-ph',
    dash: [6, 3], width: 1.5, label: 'pH', unit: '', visible: false },
  { id: 'pctb', channel: 'pctB_column_inlet', yAxis: 'R4', colorVar: '--ch-pctb',
    dash: [], width: 1.5, label: '%B', unit: '%', visible: true },
  { id: 'press', channel: 'P1_bar', yAxis: 'R3', colorVar: '--ch-press',
    dash: [3, 3], width: 1.5, label: 'P1', unit: 'bar', visible: false },
  { id: 'flow', channel: 'flow_mL_min', yAxis: 'R3', colorVar: '--ch-flow',
    dash: [8, 2, 2, 2], width: 1.5, label: 'Flow', unit: 'mL/min', visible: false },
];

/** Phase-band tint keys by block type (§9.3.3). */
const BAND_KIND = {
  EQUILIBRATION: 'neutral', RE_EQUILIBRATION: 'neutral', HOLD: 'neutral',
  LOAD: 'load', WASH: 'wash',
  ELUTION_ISOCRATIC: 'elute', ELUTION_LINEAR: 'elute', ELUTION_STEP: 'elute',
  STRIP: 'cip', CIP: 'cip', COLUMN_BYPASS: 'neutral', PACKING_TEST: 'wash',
};

const X_MODES = [
  { id: 'volume', label: 'Volume' },
  { id: 'time', label: 'Time' },
  { id: 'cv', label: 'CV' },
];

/** The pool metric cards, in display order. `truth` marks the ones only the simulator can know. */
const POOL_CARDS = [
  { key: 'yield', label: 'Yield', unit: '%', glossary: 'yield', truth: false },
  { key: 'purityMass', label: 'Purity (mass)', unit: '%', glossary: 'purity', truth: true },
  { key: 'purityArea', label: 'Purity (area)', unit: '%', glossary: 'purity', truth: true },
  { key: 'aggregate', label: 'Aggregate', unit: '%', glossary: 'aggregate', truth: true },
  { key: 'mass', label: 'Product mass', unit: 'mg', glossary: null, truth: false },
  { key: 'conc', label: 'Concentration', unit: 'g/L', glossary: null, truth: false },
  { key: 'volume', label: 'Pool volume', unit: '', glossary: null, truth: false },
  { key: 'cfactor', label: 'Conc. factor', unit: '×', glossary: 'concentration-factor', truth: false },
  { key: 'cond', label: 'Pool cond.', unit: '', glossary: 'conductivity', truth: false },
  { key: 'ph', label: 'Pool pH', unit: '', glossary: 'ph', truth: false },
  { key: 'productivity', label: 'Productivity', unit: 'g/L/h', glossary: 'productivity', truth: false },
  { key: 'buffer', label: 'Buffer use', unit: 'L/g', glossary: 'buffer-consumption', truth: false },
];

/** The few utilities `styles/app.css` does not define. Everything else comes from that file. */
const CSS = `
.view > .resultsview{height:100%}
.rv-chartroot{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}
.rv-chartroot.is-pooling,.rv-chartroot.is-pooling *{cursor:cell}
.rv-stack{display:flex;flex-direction:column;gap:var(--gap);min-height:0;min-width:0}
.rv-stack > .panel{flex:0 0 auto}
.rv-details > summary{cursor:pointer;padding:var(--sp-3) 0;font:600 var(--fs-10)/1 var(--font-ui);
  text-transform:uppercase;letter-spacing:var(--ls-caps);color:var(--text-3)}
.rv-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--sp-2) var(--sp-5);margin:0;
  font:400 var(--fs-11)/1.3 var(--font-ui)}
.rv-kv dt{color:var(--text-3);white-space:nowrap}
.rv-kv dd{margin:0;text-align:right;color:var(--text-1);
  font-variant-numeric:tabular-nums lining-nums}
.rv-notes{margin:0;padding-left:var(--sp-6)}
.rv-notes li{list-style:disc;margin-bottom:var(--sp-3)}
.rv-flag{margin-left:var(--sp-2);padding:0 4px;border-radius:var(--r-1);
  font:700 var(--fs-9)/14px var(--font-ui);letter-spacing:.04em}
.rv-flag[data-kind="warn"]{background:var(--warn-soft);color:var(--warn)}
.rv-flag[data-kind="alarm"]{background:var(--alarm-soft);color:var(--alarm)}
.rv-status{min-height:16px;font:400 var(--fs-11)/1.3 var(--font-ui);color:var(--text-3)}
.rv-status[data-kind="warn"]{color:var(--warn)}
.rv-tools{display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap}
.rv-caps{font:400 var(--fs-9)/1 var(--font-ui);text-transform:uppercase;
  letter-spacing:var(--ls-caps);color:var(--text-3)}
`;

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

/** Inject the handful of utilities app.css does not carry, once per document. */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Fixed-decimal display; a non-finite value is an em dash, never a guess. */
function num(x, d) {
  return Number.isFinite(x) ? x.toFixed(d) : '—';
}

/** Grow a Float64Array to at least `n`, reusing the buffer when it already fits. */
function ensureF64(buf, n) {
  if (buf && buf.length >= n) return buf;
  return new Float64Array(Math.max(n, 256));
}

/** Clamp helper (local: `core/util.js` is not a dependency of this view). */
function clampInt(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Passes of the detection-scale moving average. Three passes ≈ a Gaussian. */
const BOX_PASSES = 3;
/** Doublings the auto-widening may take before it gives up. */
const BOX_STEPS_MAX = 14;

/** One moving-average pass over `[0,len)`, half-width `hw` samples, O(n) by running sum. */
function boxPass(src, dst, len, hw) {
  let acc = 0;
  let cnt = 0;
  for (let k = 0; k <= hw && k < len; k++) { acc += src[k]; cnt++; }
  for (let k = 0; k < len; k++) {
    dst[k] = acc / cnt;
    const add = k + hw + 1;
    const sub = k - hw;
    if (add < len) { acc += src[add]; cnt++; }
    if (sub >= 0) { acc -= src[sub]; cnt--; }
  }
}

/**
 * The DETECTION-SCALE filter, `BOX_PASSES` moving-average passes; the result lands in `dst`.
 *
 * This is not a second copy of `peaks.smooth` — it does a different job. Savitzky–Golay is a
 * LOCAL noise filter whose window `selectWindow` caps at 9 samples × 12 passes, i.e. a few
 * millilitres; a preparative elution band is thousands of millilitres wide and carries real
 * shoulder structure on its top. `detectPeaks` splits a peak at the valley between ADJACENT
 * apexes, so every one of those shoulders becomes its own sliver with a prominence of hundredths
 * of a mAU, and the whole band is then rejected by `p_min` — the 100 mAU product peak of the
 * shipped preset disappears from the table entirely (measured). Smoothing at the SCALE OF THE
 * BAND is what makes it a single apex again. Detection only: every number in the table is still
 * measured by `detectPeaks` on the raw trace `grid.y`.
 *
 * @param {ArrayLike<number>} src input trace, AU/cm.
 * @param {Float64Array} dst output, AU/cm.
 * @param {Float64Array} tmp scratch of the same length.
 * @param {number} len valid sample count.
 * @param {number} hw half-width in samples.
 * @returns {void}
 */
function boxcar(src, dst, tmp, len, hw) {
  let a = src;
  let b = BOX_PASSES % 2 === 1 ? dst : tmp;
  for (let p = 0; p < BOX_PASSES; p++) {
    boxPass(a, b, len, hw);
    a = b;
    b = (b === dst) ? tmp : dst;
  }
}

/** Local maxima at or above `gate` — the count the auto-widening drives down. */
function countApexes(y, len, gate) {
  let c = 0;
  for (let k = 1; k < len - 1; k++) {
    if (y[k] > y[k - 1] && y[k + 1] < y[k] && y[k] >= gate) c++;
  }
  return c;
}

/** Monotone clock, the same timebase as the rAF timestamps. */
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** One overlay host per document, reused across mounts; `ui/app.js`'s own host wins if exposed. */
let sharedOverlayHost = null;

/**
 * The overlay host to float popovers and toasts from. `ui/app.js` owns one host for the whole
 * application (§6.33) but does not put it on `ctx`, so this mirrors `ui/view_run.js`: prefer a host
 * exposed on `ctx`, otherwise create one shared host for this module.
 */
function overlayHostFor(ctx) {
  if (ctx && ctx.overlayHost) return ctx.overlayHost;
  if (ctx && ctx.overlay) return ctx.overlay;
  if (!sharedOverlayHost) sharedOverlayHost = createOverlayHost(document.body);
  return sharedOverlayHost;
}

/**
 * Normalise the several plausible shapes a chart interaction callback may use into `{x0,x1}`.
 * `ui/chart.js` declares `attachInteractions(chart, {onZoom, onCursor, onSelect, onPoolDrag})`
 * without pinning the payload, so `(x0, x1)`, `[x0, x1]` and `({x0, x1})` are all accepted.
 */
function xPair(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return { x0: a, x1: b };
  if (Array.isArray(a) && a.length >= 2) return { x0: +a[0], x1: +a[1] };
  if (a && typeof a === 'object') {
    const x0 = a.x0 !== undefined ? +a.x0 : (a.start !== undefined ? +a.start : NaN);
    const x1 = a.x1 !== undefined ? +a.x1 : (a.end !== undefined ? +a.end : NaN);
    if (Number.isFinite(x0) && Number.isFinite(x1)) return { x0, x1 };
  }
  return null;
}

/** A `.numfield` with a unit suffix (§9.4.2 markup). Returns `{ el, input }`. */
function numfield(value, unit, ariaLabel) {
  const input = h('input', {
    class: 'numfield__input', type: 'text', inputmode: 'decimal',
    value: String(value), 'aria-label': ariaLabel || unit || 'value',
  });
  const el = h('div', { class: 'numfield' }, input,
    unit ? h('span', { class: 'numfield__unit' }, unit) : null);
  return { el, input };
}

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

/**
 * Create the Results panel.
 *
 * @param {Element} rootEl - the element the panel mounts into (the tab host built by `ui/app.js`).
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx -
 *   the one §2.4 context. `ctx.config` / `ctx.run` are re-read every frame and re-bound on
 *   `config-replaced`; the view never mutates them and drives the simulation only through
 *   `ctx.sim`.
 * @returns {{el:Element, mount:function():void,
 *   update:function({now_ms:number, dt_ms:number, tick:number, structural:boolean}):void,
 *   destroy:function():void}} the §6.24 Panel.
 */
export function createResultsView(rootEl, ctx) {
  injectStyles();

  /* ---------------------------------------------------------------- state */

  const dom = {};
  let overlayHost = null;
  let chart = null;
  let mounted = false;
  let visible = true;
  let observer = null;

  let xMode = (ctx.config.ui && ctx.config.ui.xMode) || 'volume';
  let poolMode = false;
  let altHeld = false;

  let grid = null;
  let ySmooth = null;
  let dySmooth = null;
  let boxTmp = null;
  let detectWidth_mL = NaN;
  let peakList = [];
  let peakRows = [];
  let selectedPeak = -1;
  let hoverPeak = -1;

  let pool = null;               // { i0, i1, metrics }
  let poolMetricsMode = 'truth'; // 'detector' | 'truth'
  let audit = null;              // MassBalance (§5.11.4)
  let packing = [];              // [{ blockId, result }]
  const packingLogged = new Set();

  let lastLogN = -1;
  let lastAnalysisMs = -1e9;
  let lastPoolMs = -1e9;
  let lastAuditMs = -1e9;
  let poolPending = null;
  let poolTimer = 0;
  let winX0 = NaN;
  let winX1 = NaN;
  let dragWin = null;
  let restoreTimer = 0;
  let lastBandKey = '';
  let lastMarkerKey = '';
  let dataTableOpen = false;

  const params = {
    A_on_mAU: 5,
    f_on_pct: 0.5,
    p_min_mAU: 2,
    w_min_CV: 0.01,
    W50_CV: 0.05,
    maxPeaks: 8,
    baseline: 'anchored',
  };
  const autoPoolCriterion = { type: 'APEX_PCT', value: 10, signal: 'UV_280' };

  const busHandlers = [];
  const listeners = [];
  let openPopover = null;

  /* -------------------------------------------------------------- plumbing */

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function subscribe(name, fn) {
    if (ctx.bus && typeof ctx.bus.on === 'function') {
      ctx.bus.on(name, fn);
      busHandlers.push([name, fn]);
    }
  }

  /** Inline aria-live status line plus a toast; the status line is the guaranteed path. */
  function notify(message, kind) {
    if (dom.status) {
      setText(dom.status, message);
      setAttr(dom.status, 'data-kind', kind === 'warn' || kind === 'blocked' ? 'warn' : 'info');
    }
    try {
      if (overlayHost) showToast(overlayHost, { message, kind: kind || 'info', ms: 4000 });
    } catch (err) {
      // The aria-live status line above has already carried the message.
    }
  }

  /**
   * The ⓘ affordance of §9.6. Returns null when the glossary has no entry, which §6.22.1 makes the
   * condition for rendering no affordance at all. The listener is attached directly to the button
   * so it is collected with the node — these are rebuilt whenever the metrics grid is rebuilt.
   */
  function info(glossaryId) {
    const entry = glossaryFor(glossaryId);
    if (!entry) return null;
    const btn = h('button', {
      type: 'button', class: 'info-dot', 'aria-label': `About ${entry.term}`, title: entry.term,
    }, 'i');
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        if (openPopover) dismiss(openPopover);
        openPopover = showGlossaryPopover(overlayHost, {
          anchorEl: btn, entry, placement: 'right',
          onSeeAlso: (id) => {
            const next = glossaryFor(id);
            if (!next) return;
            if (openPopover) dismiss(openPopover);
            openPopover = showGlossaryPopover(overlayHost,
              { anchorEl: btn, entry: next, placement: 'right' });
          },
        });
      } catch (err) {
        notify(`${entry.term}: ${entry.short}`, 'info');
      }
    });
    return btn;
  }

  /** A labelled control using the shell's `.field` vocabulary. */
  function field(labelText, control, glossaryId) {
    return h('label', { class: 'field' },
      h('span', { class: 'field__label' }, labelText, glossaryId ? info(glossaryId) : null),
      control);
  }

  /* ------------------------------------------------------- unit conversion */

  /** mAU as the detector reports it -> AU/cm, the canonical detector unit of §5.2. */
  function mAUtoAUcm(mAU) {
    return mAU / 1000 / ctx.config.skid.uv.pathlength_cm;
  }

  /** AU/cm -> mAU as the detector reports it. */
  function AUcmToMAU(auCm) {
    return auCm * 1000 * ctx.config.skid.uv.pathlength_cm;
  }

  /** The log channel the chart's current x-mode reads. */
  function xChannel() {
    return xMode === 'time' ? 't_s' : (xMode === 'cv' ? 'V_CV' : 'V_mL');
  }

  /**
   * Detector-plane volume -> chart x in the current x-mode's unit. Time mode goes through the log
   * so the mapping is the run's own, not an assumed constant flow.
   */
  function volumeToX(V_mL) {
    if (xMode === 'volume') return V_mL;
    if (xMode === 'cv') return V_mL / ctx.config.column.V_mL;
    const store = ctx.run.log;
    if (!store || !store.n) return 0;
    const r = xIndexRange(store, 'V_mL', V_mL, V_mL);
    const t = logColumn(store, 't_s');
    if (!t.length) return 0;
    return t[clampInt(r.i0, 0, t.length - 1)];
  }

  /** Chart x -> detector-plane volume, the exact inverse of {@link volumeToX}. */
  function xToVolume(x) {
    if (xMode === 'volume') return x;
    if (xMode === 'cv') return x * ctx.config.column.V_mL;
    const store = ctx.run.log;
    if (!store || !store.n) return 0;
    const r = xIndexRange(store, 't_s', x, x);
    const V = logColumn(store, 'V_mL');
    if (!V.length) return 0;
    return V[clampInt(r.i0, 0, V.length - 1)];
  }

  /** Grid index for a detector-plane volume. */
  function gridIndexOf(V_mL) {
    if (!grid || grid.n < 1) return 0;
    const k = Math.round((V_mL - grid.V[0]) / grid.dV_mL);
    return clampInt(k, 0, grid.n - 1);
  }

  /* --------------------------------------------------------------- analysis */

  /** Volume intervals over which the UV trace was SUSPECT or INVALID (§5.3). */
  function uvSuspectRanges() {
    const store = ctx.run.log;
    if (!store || !store.discrete || !store.discrete.qualityFlags) return [];
    const runs = store.discrete.qualityFlags.runs || [];
    const V = logColumn(store, 'V_mL');
    if (!V.length) return [];
    const out = [];
    for (const entry of runs) {
      const raw = entry[0];
      const start = entry[1] | 0;
      const len = entry[2] | 0;
      const bits = typeof raw === 'string'
        ? parseInt(String(raw).replace(/^0x/i, ''), 16) : (raw | 0);
      if (!Number.isFinite(bits) || !(bits & UV_SUSPECT_MASK)) continue;
      const i0 = clampInt(start, 0, V.length - 1);
      const i1 = clampInt(start + Math.max(len, 1) - 1, 0, V.length - 1);
      out.push([V[i0], V[i1]]);
    }
    return out;
  }

  /** Product mass extinction coefficient, L/(g·cm) — the area→mass constant. */
  function productEps() {
    const i = ctx.config.idxById[ctx.config.load.productSpeciesId];
    return (i === undefined || i < 0) ? NaN : ctx.config.species[i].eps280_Lgcm;
  }

  /** Derive every peak-table cell once, so rendering is pure text writing. */
  function buildPeakRows() {
    let totalArea = 0;
    for (const p of peakList) if (Number.isFinite(p.area_AUcm_mL)) totalArea += p.area_AUcm_mL;
    const eps = productEps();
    const suspect = uvSuspectRanges();
    peakRows = peakList.map((p, i) => {
      const V0 = grid.V[p.iStart];
      const V1 = grid.V[p.iEnd];
      let qualitySuspect = false;
      for (const [a, b] of suspect) if (b >= V0 && a <= V1) { qualitySuspect = true; break; }
      return {
        key: `p${i}`,
        i,
        p,
        V0,
        V1,
        areaPct: totalArea > 0 ? 100 * p.area_AUcm_mL / totalArea : NaN,
        mass_mg: eps > 0 ? p.area_AUcm_mL / eps : NaN,
        rs: i > 0 ? peaks.resolution(peakList[i - 1], p).Rs_half : NaN,
        qualitySuspect,
      };
    });
  }

  /** Rebuild the shared grid and re-run peak detection with the current integration parameters. */
  function recomputePeaks() {
    const { config, run } = ctx;
    grid = peaks.buildVolumeGrid(config, run);
    if (!grid || grid.n < 8) {
      peakList = [];
      peakRows = [];
      return;
    }
    ySmooth = ensureF64(ySmooth, grid.n);
    dySmooth = ensureF64(dySmooth, grid.n);
    boxTmp = ensureF64(boxTmp, grid.n);

    const W50_mL = Math.max(params.W50_CV * config.column.V_mL, grid.dV_mL * 4);
    const sel = peaks.selectWindow(W50_mL, grid.dV_mL);

    // Build the detection trace at the scale of the band: start from the expected peak width and
    // widen by doubling until no more than `maxPeaks` apexes clear the height gate. Bounded by
    // BOX_STEPS_MAX and by a quarter of the record, so it always terminates.
    const gate = mAUtoAUcm(params.A_on_mAU);
    const target = Math.max(1, params.maxPeaks | 0);
    const hwCap = Math.max(2, grid.n >> 2);
    let hw = clampInt(Math.round(W50_mL / grid.dV_mL / 8), 2, hwCap);
    for (let step = 0; step < BOX_STEPS_MAX; step++) {
      boxcar(grid.y, ySmooth, boxTmp, grid.n, hw);
      if (countApexes(ySmooth, grid.n, gate) <= target) break;
      const next = hw * 2;
      if (next > hwCap) break;
      hw = next;
    }
    detectWidth_mL = hw * grid.dV_mL;
    peaks.derivative1(ySmooth, grid.n, sel.m, grid.dV_mL, dySmooth);

    peakList = peaks.detectPeaks(config, grid, ySmooth, dySmooth, {
      A_on_AUcm: mAUtoAUcm(params.A_on_mAU),
      f_on: params.f_on_pct / 100,
      s_on: 0,
      s_off: 0,
      p_min: mAUtoAUcm(params.p_min_mAU),
      w_min: params.w_min_CV * config.column.V_mL,
      path_cm: config.skid.uv.pathlength_cm,
      baseline: params.baseline,
    });
    buildPeakRows();
  }

  /** Fraction boundary volumes (start and end of every fraction), ascending. */
  function fractionBoundaries() {
    const recs = (ctx.run.frac && ctx.run.frac.records) || [];
    const out = [];
    for (const r of recs) {
      if (Number.isFinite(r.startVolume_mL)) out.push(r.startVolume_mL);
      if (Number.isFinite(r.endVolume_mL)) out.push(r.endVolume_mL);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** Snap a volume to the nearest fraction boundary within 8 grid steps; Alt disables it (§6.30). */
  function snapVolume(V_mL) {
    if (altHeld || !grid) return V_mL;
    const tol = 8 * grid.dV_mL;
    let best = V_mL;
    let bestD = tol;
    for (const b of fractionBoundaries()) {
      const d = Math.abs(b - V_mL);
      if (d <= bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** Apply a pool window given in grid indices; refresh its metrics and the chart overlay. */
  function setPool(i0, i1) {
    if (!grid || grid.n < 2) return;
    let a = clampInt(i0 | 0, 0, grid.n - 1);
    let b = clampInt(i1 | 0, 0, grid.n - 1);
    if (b < a) { const t = a; a = b; b = t; }
    if (b === a) b = Math.min(grid.n - 1, a + 1);
    const metrics = pooling.poolMetrics(ctx.config, ctx.run, grid, a, b, poolMetricsMode);
    pool = { i0: a, i1: b, metrics };
    if (chart) setPoolWindow(chart, volumeToX(grid.V[a]), volumeToX(grid.V[b]));
    renderPool();
    renderOutcome();          // the run summary quotes the pool's yield and purity
  }

  /** Clear the pool selection. */
  function clearPool() {
    pool = null;
    if (chart) setPoolWindow(chart, null, null);
    renderPool();
    renderOutcome();
  }

  /**
   * Recompute the mass balance. `analytics/pooling.js` is L2 and cannot flush the column batch, so
   * this view flushes first — the §3.4 precondition, which `massBalance` reports mechanically as
   * `flushed:false` when it is not met.
   */
  function refreshAudit(force) {
    const t = nowMs();
    if (!force && t - lastAuditMs < AUDIT_MS) return;
    lastAuditMs = t;
    bed.forceFlush(ctx.config, ctx.run, 'MASS_AUDIT');
    audit = pooling.massBalance(ctx.config, ctx.run);
    renderAudit();
  }

  /**
   * Run the §7.6 packing-test analysis for every block whose `BLOCK_END` carries
   * `detail.packingTest === true`, and log one `PACKING_TEST_RESULT` per block (§6.30).
   */
  function refreshPackingTests() {
    const { config, run } = ctx;
    const events = run.events || [];
    const starts = new Map();
    const windows = [];
    for (const e of events) {
      if (e.type === 'BLOCK_START') starts.set(e.blockId, e);
      if (e.type !== 'BLOCK_END' || !e.detail || e.detail.packingTest !== true) continue;
      const s = starts.get(e.blockId);
      windows.push({ blockId: e.blockId, V0: s ? s.V_mL : 0, V1: e.V_mL });
    }
    if (windows.length === 0) { packing = []; return; }
    if (!grid || grid.n < 8) return;

    const out = [];
    for (const w of windows) {
      let best = null;
      for (const p of peakList) {
        if (p.VR_mL < w.V0 || p.VR_mL > w.V1) continue;
        if (!best || p.area_AUcm_mL > best.area_AUcm_mL) best = p;
      }
      if (!best) continue;
      const result = pooling.analysePackingTest(
        config, best, config.column.L_cm, config.skid.holdup.sigmaInjToUV_mL);
      out.push({ blockId: w.blockId, result });
      if (!packingLogged.has(w.blockId)) {
        packingLogged.add(w.blockId);
        logEvent(config, run, {
          type: 'PACKING_TEST_RESULT',
          severity: 'INFO',
          source: 'SYSTEM',
          blockId: w.blockId,
          message: `Packing test ${w.blockId}: ${result.verdict}, ` +
            `${num(result.N_per_m, 0)} plates/m (corrected)`,
          detail: {
            VR_mL: result.VR_mL, W50_mL: result.W50_mL,
            N_apparent: result.N_apparent, N_corrected: result.N_corrected,
            HETP_corrected_cm: result.HETP_corrected_cm,
            sigma_measured_mL: result.sigma_measured_mL,
            sigma_extracolumn_mL: result.sigma_extracolumn_mL,
            As10: result.As10, verdict: result.verdict,
          },
        });
      }
    }
    packing = out;
  }

  /** The whole operator-rate analysis pass. */
  function refreshAnalysis() {
    recomputePeaks();
    if (pool && grid) setPool(pool.i0, pool.i1);
    refreshPackingTests();
    renderPeakTable();
    renderPool();
    renderPacking();
    renderOutcome();
    refreshAnnotations();
    if (dataTableOpen) renderDataTable();
  }

  /* ------------------------------------------------------------ annotations */

  /** Block id -> block type, from the loaded method. */
  function blockTypeMap() {
    const map = new Map();
    const blocks = (ctx.config.method && ctx.config.method.blocks) || [];
    for (const b of blocks) map.set(b.id, b.type);
    return map;
  }

  /** Phase bands from the run's own BLOCK_START/BLOCK_END events, in chart x units. */
  function buildBands() {
    const events = ctx.run.events || [];
    const types = blockTypeMap();
    const open = new Map();
    const bands = [];
    const key = xMode === 'time' ? 't_s' : (xMode === 'cv' ? 'V_CV' : 'V_mL');
    for (const e of events) {
      if (e.type === 'BLOCK_START') {
        open.set(e.blockId, e);
      } else if (e.type === 'BLOCK_END') {
        const s = open.get(e.blockId);
        if (!s) continue;
        open.delete(e.blockId);
        bands.push({
          x0: s[key], x1: e[key], label: e.blockId,
          kind: BAND_KIND[types.get(e.blockId)] || 'neutral',
        });
      }
    }
    const liveX = xMode === 'time' ? ctx.run.t_s
      : (xMode === 'cv' ? ctx.run.V_tot_mL / ctx.config.column.V_mL : ctx.run.V_tot_mL);
    for (const s of open.values()) {
      bands.push({
        x0: s[key], x1: liveX, label: s.blockId,
        kind: BAND_KIND[types.get(s.blockId)] || 'neutral',
      });
    }
    if (hoverPeak >= 0 && hoverPeak < peakRows.length) {
      const r = peakRows[hoverPeak];
      bands.push({
        x0: volumeToX(r.V0), x1: volumeToX(r.V1), label: `P${hoverPeak + 1}`, kind: 'peak',
      });
    }
    return bands;
  }

  /** Peak apex flags plus fraction ticks, in chart x units. */
  function buildMarkers() {
    const markers = [];
    for (let i = 0; i < peakList.length; i++) {
      const p = peakList[i];
      markers.push({
        x: volumeToX(p.VR_mL),
        label: `P${i + 1} · ${num(p.VR_mL, 1)} mL · ${num(AUcmToMAU(p.Amax_AUcm), 0)} mAU`,
        kind: 'flag',
      });
    }
    const recs = (ctx.run.frac && ctx.run.frac.records) || [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const x = xMode === 'time' ? r.startTime_s
        : (xMode === 'cv' ? r.startVolume_mL / ctx.config.column.V_mL : r.startVolume_mL);
      markers.push({ x, label: (i % 5 === 0) ? r.port : '', kind: 'tick' });
    }
    return markers;
  }

  /** Push bands and markers to the chart only when the set actually changed (§6.26). */
  function refreshAnnotations() {
    if (!chart) return;
    const bands = buildBands();
    const markers = buildMarkers();
    const last = bands.length ? bands[bands.length - 1] : null;
    const bandKey = `${xMode}|${bands.length}|${hoverPeak}|${last ? last.x1.toFixed(2) : ''}`;
    const markerKey = `${xMode}|${markers.length}|${peakList.length}`;
    if (bandKey !== lastBandKey) { lastBandKey = bandKey; setBands(chart, bands); }
    if (markerKey !== lastMarkerKey) { lastMarkerKey = markerKey; setMarkers(chart, markers); }
  }

  /* ------------------------------------------------------------ chart panel */

  function toolButton(label, title, fn, extraClass) {
    const b = h('button', {
      type: 'button', class: `btn btn--sm${extraClass ? ` ${extraClass}` : ''}`, title: title || label,
    }, label);
    on(b, 'click', fn);
    return b;
  }

  function buildChartPanel() {
    const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'X axis mode' });
    dom.xModeButtons = {};
    for (const m of X_MODES) {
      const b = h('button', {
        type: 'button', class: 'segmented__btn', role: 'radio',
        'aria-checked': m.id === xMode ? 'true' : 'false', title: `X axis: ${m.label} (X)`,
      }, m.label);
      on(b, 'click', () => applyXMode(m.id));
      dom.xModeButtons[m.id] = b;
      seg.appendChild(b);
    }

    dom.poolBtn = h('button', {
      type: 'button', class: 'btn btn--sm', 'aria-pressed': 'false',
      title: 'Pool mode: drag across the chromatogram to select a pool (Shift+P). ' +
        'Hold Alt while dragging to ignore fraction boundaries.',
    }, 'Pool mode');
    on(dom.poolBtn, 'click', () => setPoolMode(!poolMode));

    dom.tableBtn = h('button', {
      type: 'button', class: 'btn btn--sm', 'aria-pressed': 'false',
      title: 'Accessible table of the chart data, decimated to 1 % of the run',
    }, 'Data table');
    on(dom.tableBtn, 'click', () => {
      dataTableOpen = !dataTableOpen;
      setAttr(dom.tableBtn, 'aria-pressed', dataTableOpen ? 'true' : 'false');
      dom.dataTableDetails.open = dataTableOpen;
      if (dataTableOpen) renderDataTable();
    });

    dom.chartRoot = h('div', {
      class: 'rv-chartroot', role: 'img',
      'aria-label': 'Chromatogram. The Data table button gives the same data as a table.',
    });

    return h('section', { class: 'panel' },
      h('div', { class: 'panel__header' },
        h('span', { class: 'panel__title' }, 'Chromatogram'),
        h('div', { class: 'panel__tools' },
          seg,
          dom.poolBtn,
          toolButton('Fit all', 'Fit the whole run (A)', fitAll),
          dom.tableBtn,
          h('span', { class: 'rv-caps' }, 'Export'),
          toolButton('PNG', 'Chromatogram as PNG, light theme', doExportPNG),
          toolButton('Data', 'Full 2 Hz data CSV', () => doExport('data')),
          toolButton('Peaks', 'Peak table CSV', () => doExport('peaks')),
          toolButton('Fractions', 'Fraction records CSV', () => doExport('fractions')),
          toolButton('Events', 'Event log CSV', () => doExport('events')),
          toolButton('JSON', 'Complete run record as JSON', () => doExport('json')))),
      h('div', { class: 'panel__body panel__body--flush panel__body--fill' }, dom.chartRoot));
  }

  function applyXMode(mode) {
    if (mode === xMode) return;
    const poolV = pool && grid ? [grid.V[pool.i0], grid.V[pool.i1]] : null;
    xMode = mode;
    for (const id of Object.keys(dom.xModeButtons)) {
      setAttr(dom.xModeButtons[id], 'aria-checked', id === mode ? 'true' : 'false');
    }
    if (!chart) return;
    setXMode(chart, mode);
    lastBandKey = '';
    lastMarkerKey = '';
    refreshAnnotations();
    if (poolV) setPoolWindow(chart, volumeToX(poolV[0]), volumeToX(poolV[1]));
    invalidate(chart, 'all');
  }

  function setPoolMode(next) {
    poolMode = next;
    setAttr(dom.poolBtn, 'aria-pressed', poolMode ? 'true' : 'false');
    cls(dom.chartRoot, 'is-pooling', poolMode);
    notify(poolMode
      ? 'Pool mode: drag across the chromatogram. Hold Alt to ignore fraction boundaries.'
      : 'Pool mode off.', 'info');
  }

  function fitAll() {
    if (!chart) return;
    const store = ctx.run.log;
    if (!store || !store.n) { notify('Nothing logged yet.', 'warn'); return; }
    const x = logColumn(store, xChannel());
    if (!x.length) return;
    setFollow(chart, false);
    winX0 = x[0];
    winX1 = x[x.length - 1];
    setWindow(chart, winX0, winX1);
    invalidate(chart, 'all');
  }

  /* ------------------------------------------------------------ peak panel */

  const PEAK_COLUMNS = ['#', 'Start (mL)', 'Apex (mL)', 'End (mL)', 'Height (mAU)',
    'Area (mAU·mL)', 'Area %', 'W50 (mL)', 'As', 'N', 'HETP (cm)', 'Rs prev', 'Est. mass (mg)'];

  function buildParams() {
    const group = h('div', { class: 'fieldgroup' });

    const mk = (label, key, unit, decimals, glossaryId) => {
      const nf = numfield(params[key], unit, label);
      on(nf.input, 'change', () => {
        const v = parseFloat(nf.input.value);
        if (!Number.isFinite(v) || v < 0) {
          cls(nf.el, 'numfield--invalid', true);
          setAttr(nf.input, 'aria-invalid', 'true');
          notify(`${label} must be a non-negative number.`, 'warn');
          return;
        }
        cls(nf.el, 'numfield--invalid', false);
        setAttr(nf.input, 'aria-invalid', null);
        params[key] = v;
        nf.input.value = v.toFixed(decimals);
        lastAnalysisMs = -1e9;
        refreshAnalysis();
      });
      group.appendChild(field(label, nf.el, glossaryId));
    };

    mk('Height gate', 'A_on_mAU', 'mAU', 2, 'peak-max');
    mk('Relative gate', 'f_on_pct', '%', 2, null);
    mk('Min prominence', 'p_min_mAU', 'mAU', 2, null);
    mk('Min width', 'w_min_CV', 'CV', 3, 'cv');
    mk('Expected W50', 'W50_CV', 'CV', 3, 'peak-width-w50');
    mk('Max peaks', 'maxPeaks', '–', 0, null);

    const sel = h('select', { class: 'input', 'aria-label': 'Integration baseline' },
      h('option', { value: 'anchored' }, 'Anchored baseline'),
      h('option', { value: 'zero' }, 'Zero baseline'));
    sel.value = params.baseline;
    on(sel, 'change', () => {
      params.baseline = sel.value;
      lastAnalysisMs = -1e9;
      refreshAnalysis();
    });
    group.appendChild(field('Baseline', sel, null));

    dom.detectNote = h('div', { class: 'field__hint' }, '');
    return h('details', { class: 'rv-details' },
      h('summary', {}, 'Integration parameters'), group, dom.detectNote);
  }

  function buildDataTable() {
    dom.dataTableBody = h('tbody', {});
    dom.dataTableDetails = h('details', { class: 'rv-details' },
      h('summary', {}, 'Chart data, 1 % steps'),
      h('div', { class: 'table-wrap', style: 'max-height:260px' },
        h('table', { class: 'table table--compact' },
          h('thead', {}, h('tr', {},
            h('th', { class: 'num', scope: 'col' }, 'V (mL)'),
            h('th', { class: 'num', scope: 'col' }, 'CV'),
            h('th', { class: 'num', scope: 'col' }, 't (s)'),
            ...SERIES.map((s) => h('th', { class: 'num', scope: 'col' },
              `${s.label}${s.unit ? ` (${s.unit})` : ''}`)))),
          dom.dataTableBody)));
    return dom.dataTableDetails;
  }

  function buildPeakPanel() {
    dom.peakCount = h('span', { class: 'rv-caps' }, '0 peaks');
    dom.peakBody = h('tbody', {});
    dom.peakEmpty = h('div', { class: 'empty' },
      h('div', { class: 'empty__title' }, 'No peaks detected'),
      h('div', {}, 'Run a method, or lower the height gate in the integration parameters.'));

    return h('section', { class: 'panel' },
      h('div', { class: 'panel__header' },
        h('span', { class: 'panel__title' }, 'Peaks'),
        info('plate-number'),
        h('div', { class: 'panel__tools' }, dom.peakCount)),
      h('div', { class: 'panel__body' },
        buildParams(),
        buildDataTable(),
        h('div', { class: 'table-wrap' },
          h('table', { class: 'table table--compact' },
            h('thead', {}, h('tr', {}, ...PEAK_COLUMNS.map((c, i) => h('th',
              { class: i === 0 ? '' : 'num', scope: 'col' }, c)))),
            dom.peakBody)),
        dom.peakEmpty));
  }

  function renderPeakTable() {
    setText(dom.peakCount, `${peakRows.length} peak${peakRows.length === 1 ? '' : 's'}`);
    dom.peakEmpty.hidden = peakRows.length > 0;
    if (dom.detectNote) {
      setText(dom.detectNote, Number.isFinite(detectWidth_mL)
        ? `Detection trace smoothed over ±${num(detectWidth_mL, 0)} mL ` +
          `(${num(detectWidth_mL / ctx.config.column.V_mL, 3)} CV), widened automatically until at ` +
          `most ${params.maxPeaks} apexes cleared the height gate. Every number in the table is ` +
          'measured on the raw trace.'
        : 'No data to integrate yet.');
    }

    reconcileList(dom.peakBody, peakRows, (r) => r.key,
      (r) => {
        const tr = h('tr', {
          tabindex: '0', role: 'button', 'aria-label': `Peak ${r.i + 1}, zoom to it`,
        });
        for (let c = 0; c < PEAK_COLUMNS.length; c++) {
          tr.appendChild(h('td', c === 0 ? {} : { class: 'num' }, ''));
        }
        tr.addEventListener('mouseenter', () => { hoverPeak = r.i; refreshAnnotations(); });
        tr.addEventListener('mouseleave', () => { hoverPeak = -1; refreshAnnotations(); });
        tr.addEventListener('focus', () => { hoverPeak = r.i; refreshAnnotations(); });
        tr.addEventListener('blur', () => { hoverPeak = -1; refreshAnnotations(); });
        tr.addEventListener('click', () => zoomToPeak(r.i));
        tr.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); zoomToPeak(r.i); }
        });
        return tr;
      },
      (tr, r) => {
        const p = r.p;
        const c = tr.children;
        setText(c[0], `P${r.i + 1}`);
        if (p.flags.INDETERMINATE) {
          c[0].appendChild(h('span', { class: 'rv-flag', 'data-kind': 'warn',
            title: 'A width could not be measured; everything derived from it is unreliable.' }, 'IND'));
        }
        if (p.flags.FLAT_APEX) {
          c[0].appendChild(h('span', { class: 'rv-flag', 'data-kind': 'warn',
            title: 'Flat or saturated apex.' }, 'FLAT'));
        }
        if (p.flags.SUSPECT) {
          c[0].appendChild(h('span', { class: 'rv-flag', 'data-kind': 'warn',
            title: 'Truncated at a window edge, or poorly resolved from its neighbour.' }, 'SUS'));
        }
        if (r.qualitySuspect) {
          c[0].appendChild(h('span', { class: 'rv-flag', 'data-kind': 'alarm',
            title: 'The UV signal was SUSPECT or INVALID somewhere in this peak window (§5.3).' }, 'UV?'));
        }
        setText(c[1], num(r.V0, 1));
        setText(c[2], num(p.VR_mL, 2));
        setText(c[3], num(r.V1, 1));
        setText(c[4], num(AUcmToMAU(p.Amax_AUcm), 1));
        setText(c[5], num(AUcmToMAU(p.area_AUcm_mL), 1));
        setText(c[6], num(r.areaPct, 1));
        setText(c[7], num(p.W50_mL, 2));
        setText(c[8], num(p.As10, 2));
        setText(c[9], num(p.Nhalf, 0));
        setText(c[10], num(p.HETP_cm, 4));
        setText(c[11], num(r.rs, 2));
        setText(c[12], num(r.mass_mg, 1));
        cls(tr, 'is-selected', r.i === selectedPeak);
      });
  }

  function zoomToPeak(i) {
    if (!chart || !grid || i < 0 || i >= peakRows.length) return;
    selectedPeak = i;
    const r = peakRows[i];
    const pad = Math.max(2 * (r.p.W50_mL || grid.dV_mL * 8), grid.dV_mL * 16);
    setFollow(chart, false);
    winX0 = volumeToX(r.V0 - pad);
    winX1 = volumeToX(r.V1 + pad);
    setWindow(chart, winX0, winX1);
    invalidate(chart, 'all');
    renderPeakTable();
  }

  /* ------------------------------------------------------------- pool panel */

  function buildPoolPanel() {
    dom.poolLabel = h('span', {}, 'No pool selected');
    const poolbar = h('div', { class: 'poolbar' }, dom.poolLabel);

    const typeSel = h('select', { class: 'input', 'aria-label': 'Auto-pool criterion' },
      h('option', { value: 'APEX_PCT' }, '% of apex'),
      h('option', { value: 'THRESHOLD' }, 'Signal threshold'),
      h('option', { value: 'PURITY' }, 'Purity constraint'));
    typeSel.value = autoPoolCriterion.type;
    on(typeSel, 'change', () => { autoPoolCriterion.type = typeSel.value; });

    const valueField = numfield(autoPoolCriterion.value, '', 'Auto-pool value');
    on(valueField.input, 'change', () => {
      const v = parseFloat(valueField.input.value);
      if (Number.isFinite(v)) autoPoolCriterion.value = v;
      else notify('The auto-pool value must be a number.', 'warn');
    });

    const sigSel = h('select', { class: 'input', 'aria-label': 'Auto-pool signal' },
      h('option', { value: 'UV_280' }, 'UV 280'),
      h('option', { value: 'UV_260' }, 'UV 260'),
      h('option', { value: 'COND' }, 'Conductivity'),
      h('option', { value: 'PH' }, 'pH'));
    sigSel.value = autoPoolCriterion.signal;
    on(sigSel, 'change', () => { autoPoolCriterion.signal = sigSel.value; });

    const modeSel = h('select', { class: 'input', 'aria-label': 'Metrics data source' },
      h('option', { value: 'truth' }, 'Truth (simulator)'),
      h('option', { value: 'detector' }, 'Detector only'));
    modeSel.value = poolMetricsMode;
    on(modeSel, 'change', () => {
      poolMetricsMode = modeSel.value;
      if (pool) setPool(pool.i0, pool.i1);
      else renderPool();
    });

    const autoBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Auto-pool');
    on(autoBtn, 'click', () => {
      if (!grid || grid.n < 4) { notify('There is no data to pool yet.', 'warn'); return; }
      const r = pooling.rePool(ctx.config, ctx.run, grid,
        { type: 'CRITERION', criterion: autoPoolCriterion, mode: poolMetricsMode });
      setPool(r.i0, r.i1);
      notify('Auto-pool applied.', 'info');
    });

    const peakBtn = h('button', { type: 'button', class: 'btn btn--sm' }, 'Pool selected peak');
    on(peakBtn, 'click', () => {
      if (selectedPeak < 0 || selectedPeak >= peakList.length) {
        notify('Select a peak in the table first.', 'warn');
        return;
      }
      const p = peakList[selectedPeak];
      setPool(p.iStart, p.iEnd);
    });

    const clearBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Clear');
    on(clearBtn, 'click', clearPool);

    dom.poolMetrics = h('div', { class: 'metrics' });
    dom.poolValues = {};
    dom.poolCards = {};
    for (const card of POOL_CARDS) {
      const value = h('span', {}, '—');
      const el = h('div', { class: 'metric' },
        h('div', { class: 'metric__label' }, card.label, info(card.glossary)),
        h('div', { class: 'metric__value' }, value,
          card.unit ? h('span', { class: 'metric__unit' }, ` ${card.unit}`) : null));
      dom.poolValues[card.key] = value;
      dom.poolCards[card.key] = el;
      dom.poolMetrics.appendChild(el);
    }

    dom.poolHint = h('div', { class: 'metric__truthnote' },
      'Purity, aggregate content and per-species mass come from the simulator\'s ground truth — ' +
      'you would not know this in the lab from a single UV trace.');
    dom.poolEmpty = h('div', { class: 'empty' },
      h('div', { class: 'empty__title' }, 'No pool selected'),
      h('div', {}, 'Turn on Pool mode and drag across the chromatogram, pool the selected peak, ' +
        'or use Auto-pool.'));

    dom.status = h('div', { class: 'rv-status', role: 'status', 'aria-live': 'polite' }, '');

    return h('section', { class: 'panel' },
      h('div', { class: 'panel__header' },
        h('span', { class: 'panel__title' }, 'Pool'), info('pool')),
      h('div', { class: 'panel__body' },
        poolbar,
        h('div', { class: 'fieldgroup' },
          field('Criterion', typeSel, null),
          field('Value', valueField.el, null),
          field('Signal', sigSel, null),
          field('Metrics from', modeSel, 'purity')),
        h('div', { class: 'btn-row' }, autoBtn, peakBtn, clearBtn),
        dom.poolEmpty,
        dom.poolMetrics,
        dom.poolHint,
        dom.status));
  }

  function renderPool() {
    const has = !!pool;
    dom.poolEmpty.hidden = has;
    dom.poolMetrics.hidden = !has;
    dom.poolHint.hidden = !has || poolMetricsMode !== 'truth';
    for (const card of POOL_CARDS) {
      cls(dom.poolCards[card.key], 'metric--truth', card.truth && poolMetricsMode === 'truth');
    }
    if (!has) {
      setText(dom.poolLabel, 'No pool selected');
      return;
    }
    const m = pool.metrics;
    const { config } = ctx;
    const V0 = grid.V[pool.i0];
    const V1 = grid.V[pool.i1];
    const recs = (ctx.run.frac && ctx.run.frac.records) || [];
    const inPool = recs.filter((r) => r.endVolume_mL > V0 && r.startVolume_mL < V1);
    const ports = inPool.length
      ? (inPool.length === 1
        ? inPool[0].port
        : `${inPool[0].port}–${inPool[inPool.length - 1].port}`)
      : 'free window';
    setText(dom.poolLabel,
      `Pool: ${ports} · ${num(m.V_pool_mL, 1)} mL · ${num(V0, 1)}–${num(V1, 1)} mL`);

    const iProd = config.idxById[config.load.productSpeciesId];
    const hasProd = iProd !== undefined && iProd >= 0;
    const values = {
      yield: num(m.yield_frac * 100, 1),
      purityMass: num(m.purityMass_frac * 100, 2),
      purityArea: num(m.purityArea_frac * 100, 2),
      aggregate: num(m.aggregate_frac * 100, 2),
      mass: num(hasProd ? m.mass_mg[iProd] : NaN, 1),
      conc: num(hasProd ? m.meanConc_gL[iProd] : NaN, 3),
      volume: fmtVolume(m.V_pool_mL, config),
      cfactor: num(m.concentrationFactor, 2),
      cond: fmtCond(m.meanCond_mScm),
      ph: fmtPH(m.meanPH),
      productivity: num(m.productivity_gLh, 3),
      buffer: num(m.bufferConsumption_L_per_g, 2),
    };
    for (const card of POOL_CARDS) setText(dom.poolValues[card.key], values[card.key]);
  }

  /* ------------------------------------------------------- audit / packing */

  function buildAuditPanel() {
    const refresh = h('button', { type: 'button', class: 'btn btn--sm' }, 'Refresh audit');
    on(refresh, 'click', () => refreshAudit(true));

    dom.auditState = h('span', { class: 'pill', 'data-variant': 'neutral' }, 'not run');
    dom.auditRows = h('div', {});
    dom.auditNote = h('div', { class: 'field__hint' },
      'Not computed yet — the audit flushes the column batch first, so it runs on demand.');

    dom.packingBody = h('div', { class: 'panel__body' });
    dom.outcomeBody = h('div', { class: 'panel__body' });

    return h('div', { class: 'rv-stack' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel__header' },
          h('span', { class: 'panel__title' }, 'Mass balance'), info('mass-balance'),
          h('div', { class: 'panel__tools' }, dom.auditState, refresh)),
        h('div', { class: 'panel__body' }, dom.auditRows, dom.auditNote)),
      h('section', { class: 'panel' },
        h('div', { class: 'panel__header' },
          h('span', { class: 'panel__title' }, 'Packing test'), info('packing-test')),
        dom.packingBody),
      h('section', { class: 'panel' },
        h('div', { class: 'panel__header' }, h('span', { class: 'panel__title' }, 'What happened')),
        dom.outcomeBody));
  }

  function renderAudit() {
    if (!audit) return;
    const { config } = ctx;
    const rows = [];
    for (let i = 0; i < config.ns; i++) {
      rows.push({
        key: config.species[i].id,
        id: config.species[i].id,
        inU: audit.in_umol[i],
        outU: audit.out_umol[i],
        colU: audit.column_umol[i],
        defU: audit.defect_umol[i],
        poolU: audit.pool_umol[i],
        xi: audit.xi[i],
      });
    }
    reconcileList(dom.auditRows, rows, (r) => r.key,
      () => h('div', { class: 'massbalance__row' },
        h('span', {}, ''), h('span', { class: 'num' }, ''), h('span', { class: 'num' }, '')),
      (el, r) => {
        const ok = Number.isFinite(r.xi) && Math.abs(r.xi) < XI_TOL;
        setAttr(el, 'data-ok', ok ? 'true' : 'false');
        setAttr(el, 'title',
          `in ${num(r.inU, 3)} · out ${num(r.outU, 3)} · column ${num(r.colU, 3)} · ` +
          `defect ${num(r.defU, 6)} · pooled ${num(r.poolU, 3)} µmol`);
        setText(el.children[0], r.id);
        setText(el.children[1], num(r.inU, 2));
        setText(el.children[2], Number.isFinite(r.xi) ? r.xi.toExponential(2) : '—');
      });

    const ok = audit.ok === true;
    setText(dom.auditState, !audit.flushed ? 'unflushed' : (ok ? 'closed' : 'open'));
    setAttr(dom.auditState, 'data-variant', !audit.flushed ? 'warn' : (ok ? 'ok' : 'alarm'));
    setText(dom.auditNote, audit.flushed
      ? (ok
        ? 'Every species closes to better than 1e-6 relative. ' +
          'ξ = (in − out − column − defect) / in, read at the column plane. Hover a row for the terms.'
        : 'At least one species is outside 1e-6. The column-plane terms are the audit; the ' +
          'skid-plane totals lead and lag by up to one column batch and are not used here.')
      : 'The column batch was not flushed, so the audit is not valid. Press Refresh audit.');
  }

  function renderPacking() {
    while (dom.packingBody.firstChild) dom.packingBody.removeChild(dom.packingBody.firstChild);
    if (packing.length === 0) {
      dom.packingBody.appendChild(h('div', { class: 'empty' },
        h('div', { class: 'empty__title' }, 'No packing test has run'),
        h('div', {}, 'A PACKING_TEST block injects a tracer; this panel then reports N with and ' +
          'without the extra-column correction.')));
      return;
    }
    for (const entry of packing) {
      const r = entry.result;
      dom.packingBody.appendChild(h('div', {},
        h('div', { class: 'field__label' }, entry.blockId,
          h('span', { class: 'verdict', 'data-verdict': r.verdict }, r.verdict)),
        h('dl', { class: 'rv-kv' },
          h('dt', {}, 'V_R'), h('dd', {}, `${num(r.VR_mL, 2)} mL`),
          h('dt', {}, 'W50'), h('dd', {}, `${num(r.W50_mL, 3)} mL`),
          h('dt', {}, 'N apparent'), h('dd', {}, num(r.N_apparent, 0)),
          h('dt', {}, 'N corrected'), h('dd', {}, num(r.N_corrected, 0)),
          h('dt', {}, 'HETP corrected'), h('dd', {}, `${num(r.HETP_corrected_cm, 4)} cm`),
          h('dt', {}, 'Plates / m'), h('dd', {}, num(r.N_per_m, 0)),
          h('dt', {}, 'σ measured'), h('dd', {}, `${num(r.sigma_measured_mL, 4)} mL`),
          h('dt', {}, 'σ extra-column'), h('dd', {}, `${num(r.sigma_extracolumn_mL, 4)} mL`),
          h('dt', {}, 'As (10 %)'), h('dd', {}, num(r.As10, 2)))));
    }
  }

  /** The active scenario, from the last SCENARIO_APPLIED event. */
  function activeScenario() {
    const events = ctx.run.events || [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== 'SCENARIO_APPLIED' || !e.detail) continue;
      for (const s of SCENARIOS) if (s.id === e.detail.scenarioId) return s;
    }
    return null;
  }

  function renderOutcome() {
    const { config, run } = ctx;
    while (dom.outcomeBody.firstChild) dom.outcomeBody.removeChild(dom.outcomeBody.firstChild);

    if (!run.log || run.log.n === 0) {
      dom.outcomeBody.appendChild(h('div', { class: 'empty' },
        h('div', { class: 'empty__title' }, 'No run yet'),
        h('div', {}, 'Load a scenario or press Start. Replay and scrubbing are deferred, so this ' +
          'tab is the post-run surface.')));
      return;
    }

    const alarms = { WARN: 0, ALARM: 0, CRITICAL: 0, FAULT: 0 };
    for (const e of run.events || []) {
      if (e.type === 'ALARM_RAISED' && alarms[e.severity] !== undefined) alarms[e.severity]++;
    }
    let worstRs = NaN;
    for (let i = 1; i < peakList.length; i++) {
      const rs = peaks.resolution(peakList[i - 1], peakList[i]).Rs_half;
      if (!Number.isFinite(worstRs) || rs < worstRs) worstRs = rs;
    }
    const m = pool ? pool.metrics : null;

    const body = h('div', { class: 'whathappened' },
      h('dl', { class: 'rv-kv' },
        h('dt', {}, 'State'), h('dd', {}, run.state),
        h('dt', {}, 'Duration'), h('dd', {}, fmtTime(run.t_s)),
        h('dt', {}, 'Total volume'),
        h('dd', {}, `${num(run.V_tot_mL, 1)} mL · ${num(run.V_tot_mL / config.column.V_mL, 2)} CV`),
        h('dt', {}, 'Peaks'), h('dd', {}, String(peakList.length)),
        h('dt', {}, 'Worst Rs'), h('dd', {}, num(worstRs, 2)),
        h('dt', {}, 'Fractions'),
        h('dd', {}, String((run.frac && run.frac.records && run.frac.records.length) || 0)),
        h('dt', {}, 'Pool yield'), h('dd', {}, m ? `${num(m.yield_frac * 100, 1)} %` : '—'),
        h('dt', {}, 'Pool purity'), h('dd', {}, m ? `${num(m.purityMass_frac * 100, 2)} %` : '—'),
        h('dt', {}, 'Alarms'),
        h('dd', {}, `${alarms.WARN} W · ${alarms.ALARM} A · ${alarms.CRITICAL} C · ` +
          `${alarms.FAULT} F`)));
    dom.outcomeBody.appendChild(body);

    const sc = activeScenario();
    if (!sc) {
      body.appendChild(h('div', { class: 'field__hint' },
        'No scenario is loaded — this is a free run against the loaded method.'));
      return;
    }
    body.appendChild(h('div', { class: 'whathappened__note' },
      h('strong', {}, sc.name), sc.expectedOutcome ? ` — ${sc.expectedOutcome}` : ''));
    if (Array.isArray(sc.teachingNotes) && sc.teachingNotes.length) {
      body.appendChild(h('ul', { class: 'rv-notes' },
        ...sc.teachingNotes.map((t) => h('li', {}, t))));
    }
  }

  /* -------------------------------------------------------- accessible table */

  function renderDataTable() {
    const store = ctx.run.log;
    const n = store ? store.n : 0;
    if (!n) {
      reconcileList(dom.dataTableBody, [], (r) => r.key, () => h('tr', {}), () => {});
      return;
    }
    const cols = SERIES.map((s) => logColumn(store, s.channel));
    const V = logColumn(store, 'V_mL');
    const CV = logColumn(store, 'V_CV');
    const T = logColumn(store, 't_s');
    const rows = [];
    for (let k = 0; k < DATA_TABLE_ROWS; k++) {
      const i = Math.min(n - 1, Math.round((n - 1) * k / (DATA_TABLE_ROWS - 1)));
      rows.push({
        key: `d${k}`,
        V: V[i], CV: CV[i], t: T[i],
        v: cols.map((c) => (c && c.length > i ? c[i] : NaN)),
      });
    }
    reconcileList(dom.dataTableBody, rows, (r) => r.key,
      () => {
        const tr = h('tr', {});
        for (let c = 0; c < 3 + SERIES.length; c++) tr.appendChild(h('td', { class: 'num' }, ''));
        return tr;
      },
      (tr, r) => {
        const c = tr.children;
        setText(c[0], num(r.V, 1));
        setText(c[1], num(r.CV, 3));
        setText(c[2], num(r.t, 1));
        for (let k = 0; k < SERIES.length; k++) setText(c[3 + k], num(r.v[k], 2));
      });
  }

  /* ---------------------------------------------------------------- exports */

  function runId() {
    const id = String(ctx.config.presetId || 'run').replace(/[^A-Za-z0-9_-]/g, '-');
    return `${id}_${Math.round(ctx.run.t_s)}s`;
  }

  function peaksCSV() {
    const head = ['index', 'start_mL', 'apex_mL', 'end_mL', 'height_mAU', 'area_mAU_mL',
      'area_pct', 'W50_mL', 'W10_mL', 'As10', 'Tf', 'N_half', 'N_moment', 'HETP_cm',
      'sigma_mL', 'skew', 'Rs_prev', 'est_mass_mg', 'flags'];
    const lines = [head.join(',')];
    const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
    for (const r of peakRows) {
      const p = r.p;
      const flags = Object.keys(p.flags).filter((k) => p.flags[k])
        .concat(r.qualitySuspect ? ['UV_QUALITY'] : []).join(';');
      lines.push([
        r.i + 1, fx(r.V0, 2), fx(p.VR_mL, 3), fx(r.V1, 2),
        fx(AUcmToMAU(p.Amax_AUcm), 2), fx(AUcmToMAU(p.area_AUcm_mL), 3), fx(r.areaPct, 2),
        fx(p.W50_mL, 3), fx(p.W10_mL, 3), fx(p.As10, 3), fx(p.Tf, 3),
        fx(p.Nhalf, 0), fx(p.Nmoment, 0), fx(p.HETP_cm, 5),
        fx(p.sigma_mL, 4), fx(p.skew, 3), fx(r.rs, 3), fx(r.mass_mg, 3),
        `"${flags}"`,
      ].join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  function doExport(kind) {
    const { config, run } = ctx;
    try {
      if (kind === 'data') {
        downloadText(`${runId()}_data.csv`, exportDataCSV(config, run), 'text/csv;charset=utf-8');
      } else if (kind === 'events') {
        downloadText(`${runId()}_events.csv`, exportEventsCSV(config, run), 'text/csv;charset=utf-8');
      } else if (kind === 'fractions') {
        downloadText(`${runId()}_fractions.csv`, exportFractionsCSV(config, run),
          'text/csv;charset=utf-8');
      } else if (kind === 'peaks') {
        downloadText(`${runId()}_peaks.csv`, peaksCSV(), 'text/csv;charset=utf-8');
      } else if (kind === 'json') {
        refreshAudit(true);
        const obj = exportRunJSON(config, run, {
          peaks: peakList,
          pool: pool ? pool.metrics : null,
          massBalance: audit,
          packingTest: packing.length ? packing[0].result : null,
        });
        downloadText(`${runId()}.json`, JSON.stringify(obj, null, 2), 'application/json');
      }
      notify(`Exported ${kind}.`, 'info');
    } catch (err) {
      notify(`Export failed: ${(err && err.message) || String(err)}`, 'warn');
    }
  }

  function doExportPNG() {
    if (!chart) return;
    const { config } = ctx;
    const footer = `${config.name} · ${config.scale} · ${config.column.id_cm} × ` +
      `${config.column.L_cm} cm · seed ${config.seed}`;
    let promise = null;
    try {
      promise = exportPNG(chart, {
        width: 1600, height: 900, theme: 'light',
        title: (config.method && config.method.name) ? config.method.name : 'Chromatogram',
        footer,
      });
    } catch (err) {
      notify(`PNG export failed: ${(err && err.message) || String(err)}`, 'warn');
      return;
    }
    Promise.resolve(promise).then((blob) => {
      if (!blob) throw new Error('the chart returned no image');
      downloadBlob(`${runId()}_chromatogram.png`, blob);
      notify('Chromatogram exported as PNG.', 'info');
    }).catch((err) => {
      notify(`PNG export failed: ${(err && err.message) || String(err)}`, 'warn');
    });
  }

  /* ------------------------------------------------------------------ chart */

  function applyPoolFromX(x0, x1) {
    if (!grid || grid.n < 2) return;
    const t = nowMs();
    if (t - lastPoolMs < POOL_MS) {
      poolPending = [x0, x1];
      if (!poolTimer) {
        poolTimer = setTimeout(() => {
          poolTimer = 0;
          const p = poolPending;
          poolPending = null;
          if (p) applyPoolFromX(p[0], p[1]);
        }, POOL_MS);
      }
      return;
    }
    lastPoolMs = t;
    const V0 = snapVolume(xToVolume(Math.min(x0, x1)));
    const V1 = snapVolume(xToVolume(Math.max(x0, x1)));
    setPool(gridIndexOf(V0), gridIndexOf(V1));
  }

  function buildChart() {
    chart = createChart(dom.chartRoot, {
      xAxis: { mode: xMode },
      yAxes: Y_AXES.map((a) => Object.assign({}, a)),
      series: SERIES.map((s) => ({
        id: s.id, yAxis: s.yAxis, colorVar: s.colorVar, dash: s.dash.slice(),
        width: s.width, visible: s.visible, label: s.label,
      })),
      overview: true,
    });
    for (const s of SERIES) {
      setSeriesChannel(chart, s.id, s.channel);
      setSeriesVisible(chart, s.id, s.visible);
    }
    if (ctx.run.log) setSource(chart, ctx.run.log, { volume: 'V_mL', time: 't_s', cv: 'V_CV' });
    attachInteractions(chart, {
      onZoom: (a) => {
        const p = xPair(a, undefined);
        if (p) { winX0 = p.x0; winX1 = p.x1; }
        setFollow(chart, false);
        refreshAnnotations();
      },
      onCursor: () => {},
      // A plain drag is the chart's own x-zoom select; in pool mode it is how the FIRST pool
      // window is created, because the chart only enters its pool-drag mode on an existing
      // handle. The chart applies the zoom right after this callback, so the pre-drag window is
      // restored on the next task — otherwise selecting a pool would silently zoom the trace.
      onSelect: (a) => {
        if (!poolMode) return;
        const p = xPair(a, undefined);
        if (!p) return;
        applyPoolFromX(p.x0, p.x1);
        const w = dragWin;
        if (!w) return;
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          restoreTimer = 0;
          setWindow(chart, w[0], w[1]);
          invalidate(chart, 'all');
        }, 0);
      },
      onPoolDrag: (a) => {
        const p = xPair(a, undefined);
        if (p) applyPoolFromX(p.x0, p.x1);
      },
    });
  }

  /* ------------------------------------------------------------ build tree */

  const el = h('div', { class: 'resultsview' });
  const chartPanel = buildChartPanel();
  const peakPanel = buildPeakPanel();
  const poolPanel = buildPoolPanel();
  const auditPanel = buildAuditPanel();

  el.appendChild(chartPanel);
  el.appendChild(h('div', { class: 'resultsview__lower' }, peakPanel, poolPanel, auditPanel));

  /* --------------------------------------------------------------- lifecycle */

  /** Drop every cached reference to the replaced run and rebuild from the new one. */
  function rebind() {
    lastLogN = -1;
    lastAnalysisMs = -1e9;
    lastBandKey = '';
    lastMarkerKey = '';
    grid = null;
    peakList = [];
    peakRows = [];
    pool = null;
    audit = null;
    packing = [];
    packingLogged.clear();
    selectedPeak = -1;
    hoverPeak = -1;
    setText(dom.auditState, 'not run');
    setAttr(dom.auditState, 'data-variant', 'neutral');
    if (chart) {
      setPoolWindow(chart, null, null);
      if (ctx.run.log) setSource(chart, ctx.run.log, { volume: 'V_mL', time: 't_s', cv: 'V_CV' });
      invalidate(chart, 'all');
    }
    refreshAnalysis();
  }

  function mount() {
    if (mounted) return;
    // `styles/app.css` styles the tab host as `.view` and carries a `.view--results` modifier for
    // this view's scrolling; `ui/app.js` builds the host generically, so the modifier is applied
    // here, by the view that owns the content.
    if (rootEl.classList) rootEl.classList.add('view--results');
    rootEl.appendChild(el);
    mounted = true;
    try {
      overlayHost = overlayHostFor(ctx);
    } catch (err) {
      overlayHost = null;   // popovers and toasts degrade to the inline status line
    }
    buildChart();

    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) visible = e.isIntersecting;
      }, { root: null, threshold: 0 });
      observer.observe(el);
    }

    on(window, 'keydown', (ev) => { if (ev.key === 'Alt') altHeld = true; });
    on(window, 'keyup', (ev) => { if (ev.key === 'Alt') altHeld = false; });
    on(dom.chartRoot, 'pointerdown', (ev) => {
      altHeld = ev.altKey === true;
      dragWin = (Number.isFinite(winX0) && Number.isFinite(winX1)) ? [winX0, winX1] : null;
    });
    on(dom.chartRoot, 'pointermove', (ev) => { if (ev.buttons) altHeld = ev.altKey === true; });

    subscribe('config-replaced', rebind);
    subscribe('preset-loaded', rebind);
    subscribe('run-reset', rebind);
    subscribe('scenario-applied', renderOutcome);
    subscribe('run-ended', () => {
      lastAnalysisMs = -1e9;
      refreshAnalysis();
      refreshAudit(true);
      fitAll();
    });

    refreshAnalysis();
  }

  function update(frameInfo) {
    if (!mounted || !visible) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    if (chart) chartFrame(chart, frameInfo.now_ms);

    const store = ctx.run.log;
    const n = store ? store.n : 0;
    if (n !== lastLogN && frameInfo.now_ms - lastAnalysisMs >= ANALYSIS_MS) {
      lastLogN = n;
      lastAnalysisMs = frameInfo.now_ms;
      refreshAnalysis();
    } else if (frameInfo.structural === true) {
      renderPeakTable();
      renderOutcome();
      refreshAnnotations();
    }
  }

  function destroy() {
    for (const [name, fn] of busHandlers) {
      if (ctx.bus && typeof ctx.bus.off === 'function') ctx.bus.off(name, fn);
    }
    busHandlers.length = 0;
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
    if (poolTimer) { clearTimeout(poolTimer); poolTimer = 0; }
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0; }
    if (observer) { observer.disconnect(); observer = null; }
    if (openPopover) {
      try { dismiss(openPopover); } catch (err) { /* the host may already be gone */ }
      openPopover = null;
    }
    if (chart) { destroyChart(chart); chart = null; }
    if (rootEl.classList) rootEl.classList.remove('view--results');
    if (el.parentNode) el.parentNode.removeChild(el);
    mounted = false;
  }

  return { el, mount, update, destroy };
}
