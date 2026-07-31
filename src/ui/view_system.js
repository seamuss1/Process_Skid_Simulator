/**
 * @file `src/ui/view_system.js` — the System tab (architecture-v2 §6.31, §9.1.1, §9.4.2).
 *
 * Three configuration cards (Column + resin, Skid, Buffers / sample / chemistry / species) with a
 * live schematic thumbnail, plus the **event and alarm log** and the **alarm limit table** beside
 * it. §9.1.1 merges the log into this tab deliberately: configuring a limit and reading what it did
 * are one task.
 *
 * CONFIG IS IMMUTABLE (§2.3). Nothing here writes to `config` or `run`; every edit goes through the
 * §2.4 rebuild protocol:
 *   - column geometry, packing and numerics -> `ctx.sim.reconfigureColumn(ctx, partialColumn)`,
 *     which is legal in IDLE / READY only and enforces that itself;
 *   - everything else (scale, resin, skid, chemistry, load, tanks, species, alarm limits) ->
 *     `ctx.sim.rebuild(ctx, overrides)`, which has no state guard of its own, so this view gates it
 *     to IDLE / READY exactly as §6.31 requires and disables the control WITH a tooltip otherwise.
 * `ctx.overrides` accumulates across rebuilds (§2.4), so successive edits compose.
 *
 * Layout and component classes come from `styles/app.css` (§22 system view plus the shared card,
 * panel, field, numfield, table, pill and filterbar vocabulary); this module adds only the handful
 * of `sv-*` utilities that file does not define.
 */

import {
  h, setText, setAttr, cls, reconcileList,
  fmtVolume, fmtTime, fmtPressure, fmtCond, fmtPH,
  linkedFlowGroup, readThemeTokens,
} from './format.js';
import { createOverlayHost, showGlossaryPopover, showToast, dismiss } from './overlay.js';
import { SEVERITIES } from '../skid/alarms.js';
import { RESINS, SCALES } from '../data/library.js';
import { glossaryFor } from '../data/glossary.js';
import { describeColumn, describeSpecies } from '../physics/column.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

const STYLE_ID = 'systemview-style';

/** Live readouts (alarm state, log rows, thumbnail) refresh at most this often, in ms. */
const LIVE_MS = 250;
/** Log rows rendered per page. */
const LOG_PAGE = 250;

const ISOTHERM_MODES = ['SMA', 'LANGMUIR', 'HIC', 'SEC', 'LINEAR', 'INERT'];
const SOURCES = ['PHASE_ENGINE', 'ALARM', 'OPERATOR', 'MANUAL', 'SYSTEM'];

/**
 * Column fields. `get` reads the frozen config; `patch` returns a partial `config.column` for
 * `sim.reconfigureColumn`. Values are shown in the authoring unit and converted here, once.
 */
const COLUMN_FIELDS = [
  { label: 'Inner diameter', unit: 'cm', dec: 2, glossary: 'column.id_cm', min: 0.1, max: 200,
    get: (c) => c.column.id_cm, patch: (v) => ({ id_cm: v }) },
  { label: 'Bed height', unit: 'cm', dec: 2, glossary: 'column.L_cm', min: 0.5, max: 100,
    get: (c) => c.column.L_cm, patch: (v) => ({ L_cm: v }) },
  { label: 'Interstitial porosity', unit: '–', dec: 3, glossary: 'column.epsC', min: 0.15, max: 0.6,
    get: (c) => c.column.epsC, patch: (v) => ({ epsC: v, compression: { eps0: v } }) },
  { label: 'Particle porosity', unit: '–', dec: 3, glossary: 'column.epsP', min: 0, max: 0.98,
    get: (c) => c.column.epsP, patch: (v) => ({ epsP: v }) },
  { label: 'Bead diameter', unit: 'µm', dec: 1, glossary: 'column.dp_cm', min: 5, max: 500,
    get: (c) => c.column.dp_cm * 1e4, patch: (v) => ({ dp_cm: v * 1e-4 }) },
  { label: 'Pore radius', unit: 'nm', dec: 1, glossary: 'column.rPore_cm', min: 1, max: 500,
    get: (c) => c.column.rPore_cm * 1e7, patch: (v) => ({ rPore_cm: v * 1e-7 }) },
  { label: 'Ionic capacity Λ', unit: 'mM', dec: 1, glossary: 'column.Lambda_mM', min: 0, max: 5000,
    get: (c) => c.column.Lambda_mM, patch: (v) => ({ Lambda_mM: v }) },
  { label: 'Packing quality λ', unit: '–', dec: 3, glossary: 'column.lambdaPack', min: 0, max: 20,
    get: (c) => c.column.lambdaPack, patch: (v) => ({ lambdaPack: v }) },
  { label: 'Obstruction γ', unit: '–', dec: 3, glossary: 'column.gammaObstruction', min: 0, max: 2,
    get: (c) => c.column.gammaObstruction, patch: (v) => ({ gammaObstruction: v }) },
  { label: 'Kozeny constant', unit: '–', dec: 0, glossary: 'column.kKozeny', min: 50, max: 500,
    get: (c) => c.column.kKozeny, patch: (v) => ({ kKozeny: v }) },
  { label: 'Hardware limit', unit: 'bar', dec: 2, glossary: 'column.hardwarePressureLimit_bar',
    min: 0.5, max: 100, get: (c) => c.column.hardwarePressureLimit_bar,
    patch: (v) => ({ hardwarePressureLimit_bar: v }) },
  { label: 'Frit resistance', unit: 'bar/(cm/s)', dec: 5, glossary: 'column.rFrit_bar_per_cms',
    min: 0, max: 10, get: (c) => c.column.rFrit_bar_per_cms,
    patch: (v) => ({ rFrit_bar_per_cms: v }) },
  { label: 'Fouling factor', unit: '×', dec: 1, glossary: 'column.foulingFactor', min: 1, max: 500,
    get: (c) => c.column.foulingFactor, patch: (v) => ({ foulingFactor: v }) },
  { label: 'Channelling', unit: '0–1', dec: 2, glossary: 'column.channellingFactor', min: 0, max: 1,
    get: (c) => c.column.channellingFactor, patch: (v) => ({ channellingFactor: v }) },
  { label: 'Compression P_c', unit: 'bar', dec: 2, glossary: 'column.compression', min: 0.1, max: 50,
    get: (c) => c.column.compression.Pc_bar, patch: (v) => ({ compression: { Pc_bar: v } }) },
  { label: 'Compression ε_min', unit: '–', dec: 3, glossary: 'column.compression', min: 0.05, max: 0.6,
    get: (c) => c.column.compression.epsMin, patch: (v) => ({ compression: { epsMin: v } }) },
  { label: 'Axial cells n_z', unit: 'cells', dec: 0, glossary: 'column.nz', min: 20, max: 2000,
    get: (c) => c.column.nz, patch: (v) => ({ nz: Math.round(v) }) },
  { label: 'Courant target ν', unit: '–', dec: 2, glossary: 'column.nuTarget', min: 0.05, max: 1,
    get: (c) => c.column.nuTarget, patch: (v) => ({ nuTarget: v }) },
];

/** Skid fields. `patch` returns a whole-config override object for `sim.rebuild`. */
const SKID_FIELDS = [
  { label: 'Mixer volume', unit: 'mL', dec: 1, glossary: 'skid.mixerVolume_mL', min: 0.1, max: 5000,
    get: (c) => c.skid.mixerVolume_mL, patch: (v) => ({ skid: { mixerVolume_mL: v } }) },
  { label: 'Mixer stages N', unit: '–', dec: 0, glossary: 'skid.mixerN', min: 1, max: 50,
    get: (c) => c.skid.mixerN, patch: (v) => ({ skid: { mixerN: Math.round(v) } }) },
  { label: 'Chop period', unit: 's', dec: 2, glossary: 'skid.chopPeriod_s', min: 0.1, max: 20,
    get: (c) => c.skid.chopPeriod_s, patch: (v) => ({ skid: { chopPeriod_s: v } }) },
  { label: 'Pump stroke', unit: 'mL', dec: 2, glossary: 'skid.Vstroke_mL', min: 0.01, max: 200,
    get: (c) => c.skid.Vstroke_mL, patch: (v) => ({ skid: { Vstroke_mL: v } }) },
  { label: 'Max flow', unit: 'mL/min', dec: 1, glossary: 'skid.Qmax_mLs', min: 0.1, max: 100000,
    get: (c) => c.skid.Qmax_mLs * 60, patch: (v) => ({ skid: { Qmax_mLs: v / 60 } }) },
  { label: 'Ramp rate', unit: 'mL/s²', dec: 4, glossary: 'skid.rampRate_mLs2', min: 1e-4, max: 1000,
    get: (c) => c.skid.rampRate_mLs2, patch: (v) => ({ skid: { rampRate_mLs2: v } }) },
  { label: 'Valve-switch flow', unit: 'frac', dec: 3, glossary: 'skid.QswitchMax_frac',
    min: 0, max: 1, get: (c) => c.skid.QswitchMax_frac,
    patch: (v) => ({ skid: { QswitchMax_frac: v } }) },
  { label: 'UV path length', unit: 'mm', dec: 2, glossary: 'skid.uv.pathlength_cm',
    min: 0.01, max: 100, get: (c) => c.skid.uv.pathlength_cm * 10,
    patch: (v) => ({ skid: { uv: { pathlength_cm: v / 10 } } }) },
  { label: 'UV stray light', unit: 'frac', dec: 5, glossary: 'skid.uv.strayLight', min: 0, max: 0.2,
    get: (c) => c.skid.uv.strayLight, patch: (v) => ({ skid: { uv: { strayLight: v } } }) },
  { label: 'UV filter τ', unit: 's', dec: 2, glossary: 'skid.uv.tau_s', min: 0, max: 60,
    get: (c) => c.skid.uv.tau_s, patch: (v) => ({ skid: { uv: { tau_s: v } } }) },
  { label: 'Cond. cell constant', unit: '1/cm', dec: 2, glossary: 'skid.cond.Kcell_cm1',
    min: 0.01, max: 100, get: (c) => c.skid.cond.Kcell_cm1,
    patch: (v) => ({ skid: { cond: { Kcell_cm1: v } } }) },
  { label: 'pH electrode slope', unit: '%', dec: 1, glossary: 'skid.ph.slopePct', min: 50, max: 105,
    get: (c) => c.skid.ph.slopePct, patch: (v) => ({ skid: { ph: { slopePct: v } } }) },
  { label: 'Downstream resistance', unit: 'bar/(mL/s)', dec: 5,
    glossary: 'skid.press.Rdown_bar_per_mLs', min: 0, max: 100,
    get: (c) => c.skid.press.Rdown_bar_per_mLs,
    patch: (v) => ({ skid: { press: { Rdown_bar_per_mLs: v } } }) },
  { label: 'Filter fouling', unit: '1/mg', dec: 7, glossary: 'skid.filter.kFoul_per_mg',
    min: 0, max: 1, get: (c) => c.skid.filter.kFoul_per_mg,
    patch: (v) => ({ skid: { filter: { kFoul_per_mg: v } } }) },
  { label: 'Fraction valve switch', unit: 's', dec: 2, glossary: 'skid.fracValve.tSwitch_s',
    min: 0.01, max: 20, get: (c) => c.skid.fracValve.tSwitch_s,
    patch: (v) => ({ skid: { fracValve: { tSwitch_s: v } } }) },
  { label: 'Bubble threshold', unit: 'frac', dec: 3, glossary: 'skid.bubbleSensorThreshold_frac',
    min: 0, max: 1, get: (c) => c.skid.bubbleSensorThreshold_frac,
    patch: (v) => ({ skid: { bubbleSensorThreshold_frac: v } }) },
  { label: 'Fluid thermal τ', unit: 's', dec: 0, glossary: 'skid.fluidTau_s', min: 1, max: 100000,
    get: (c) => c.skid.fluidTau_s, patch: (v) => ({ skid: { fluidTau_s: v } }) },
  { label: 'Waste capacity', unit: 'L', dec: 1, glossary: 'skid.wasteCapacity_mL',
    min: 0.1, max: 100000, get: (c) => c.skid.wasteCapacity_mL / 1000,
    patch: (v) => ({ skid: { wasteCapacity_mL: v * 1000 } }) },
  { label: 'Ambient temperature', unit: '°C', dec: 1, glossary: null, min: -10, max: 60,
    get: (c) => c.skid.ambientT_C, patch: (v) => ({ skid: { ambientT_C: v } }) },
];

/** Chemistry constants (§2.1 `config.chem`). */
const CHEM_FIELDS = [
  { label: 'Cond. reference T', unit: '°C', dec: 1, glossary: 'temperature-compensation',
    min: 0, max: 40, get: (c) => c.chem.condTref_C, patch: (v) => ({ chem: { condTref_C: v } }) },
  { label: 'Meter α', unit: '1/°C', dec: 4, glossary: 'temperature-compensation', min: 0, max: 0.1,
    get: (c) => c.chem.condAlphaMeter_perC,
    patch: (v) => ({ chem: { condAlphaMeter_perC: v } }) },
  { label: 'Sodium error k', unit: '–', dec: 3, glossary: 'ph', min: 0, max: 5,
    get: (c) => c.chem.sodiumErrorK, patch: (v) => ({ chem: { sodiumErrorK: v } }) },
  { label: 'Davies A', unit: '–', dec: 3, glossary: 'davies', min: 0.1, max: 1,
    get: (c) => c.chem.daviesA, patch: (v) => ({ chem: { daviesA: v } }) },
  { label: 'Modulator floor', unit: 'mM', dec: 3, glossary: 'modulator', min: 1e-6, max: 100,
    get: (c) => c.chem.CS_MIN_mM, patch: (v) => ({ chem: { CS_MIN_mM: v } }) },
];

/** Load specification (§2.1 `config.load`). */
const LOAD_FIELDS = [
  { label: 'Load value', unit: '–', dec: 3, glossary: 'load-challenge', min: 0, max: 1e6,
    get: (c) => c.load.value, patch: (v) => ({ load: { value: v } }) },
  { label: 'Feed titre (total)', unit: 'g/L', dec: 3, glossary: 'titre', min: 0, max: 500,
    get: (c) => c.load.feedTiterTotal_gL, patch: (v) => ({ load: { feedTiterTotal_gL: v } }) },
  { label: 'Product titre', unit: 'g/L', dec: 3, glossary: 'load.productTiter_gL', min: 1e-6, max: 500,
    get: (c) => c.load.productTiter_gL, patch: (v) => ({ load: { productTiter_gL: v } }) },
];

/** The few utilities `styles/app.css` does not define. */
const CSS = `
.view > .systemview{height:100%;overflow:auto}
.sv-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--sp-2) var(--sp-5);margin:0;
  font:400 var(--fs-11)/1.3 var(--font-ui)}
.sv-kv dt{color:var(--text-3);white-space:nowrap}
.sv-kv dd{margin:0;text-align:right;color:var(--text-1);
  font-variant-numeric:tabular-nums lining-nums}
.sv-details > summary{cursor:pointer;padding:var(--sp-3) 0;font:600 var(--fs-10)/1 var(--font-ui);
  text-transform:uppercase;letter-spacing:var(--ls-caps);color:var(--text-3)}
.sv-scroll{max-height:300px;overflow:auto}
.sv-thumb{display:block;width:100%;height:auto;border-radius:var(--r-2);background:var(--bg-1)}
.sv-tank{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--sp-2) var(--sp-4);
  padding:var(--sp-3) 0;border-bottom:1px solid var(--line-soft)}
.sv-tank__name{font:600 var(--fs-11)/1.2 var(--font-ui);color:var(--text-1)}
.sv-tank__sub{font:400 var(--fs-10)/1.3 var(--font-ui);color:var(--text-3);
  font-variant-numeric:tabular-nums lining-nums}
.sv-level{grid-column:1 / -1;height:6px;border-radius:var(--r-pill);background:var(--surface-3);
  overflow:hidden}
.sv-level > i{display:block;height:100%;background:var(--accent)}
.sv-level[data-low="true"] > i{background:var(--warn)}
.sv-inline{display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap}
.sv-status{min-height:16px;font:400 var(--fs-11)/1.3 var(--font-ui);color:var(--text-3)}
.sv-status[data-kind="warn"]{color:var(--warn)}
.sv-num{font-variant-numeric:tabular-nums lining-nums}
.sv-search{min-width:140px}
`;

/* ========================================================================== */
/* Helpers                                                                    */
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

/** A `.numfield` with a unit suffix (§9.4.2 markup). Returns `{ el, input }`. */
function numfield(unit, ariaLabel) {
  const input = h('input', {
    class: 'numfield__input', type: 'text', inputmode: 'decimal', 'aria-label': ariaLabel,
  });
  const el = h('div', { class: 'numfield' }, input,
    unit ? h('span', { class: 'numfield__unit' }, unit) : null);
  return { el, input };
}

/** Bed compression state, live from `run` (hydraulics owns both fields). */
function compressionText(run) {
  return `ε = ${num(run.epsCompressed, 4)}${run.bedCollapsed ? ' — BED COLLAPSED' : ''}`;
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

/* ========================================================================== */
/* The view                                                                   */
/* ========================================================================== */

/**
 * Create the System panel.
 *
 * @param {Element} rootEl - the element the panel mounts into (the tab host built by `ui/app.js`).
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx -
 *   the one §2.4 context. Config edits go through `ctx.sim.reconfigureColumn` / `ctx.sim.rebuild`;
 *   this view never mutates `config` or `run`.
 * @returns {{el:Element, mount:function():void,
 *   update:function({now_ms:number, dt_ms:number, tick:number, structural:boolean}):void,
 *   destroy:function():void}} the §6.24 Panel.
 */
export function createSystemView(rootEl, ctx) {
  injectStyles();

  /* ---------------------------------------------------------------- state */

  const dom = {};
  let overlayHost = null;
  let mounted = false;
  let visible = true;
  let observer = null;
  let openPopover = null;

  /** Every registered editable control: `{ input, read, apply, gated }`. */
  const controls = [];
  const busHandlers = [];
  const listeners = [];

  let tokens = null;
  let lastLiveMs = -1e9;
  let lastThumbKey = '';
  let lastEventCount = -1;
  let logLimit = LOG_PAGE;
  let speciesInfo = null;   // describeSpecies() output, refreshed on demand

  const flow = { Q_mLs: 0, u_cmh: 0, RT_min: 0, CVh: 0 };
  const logFilter = { severity: 'ALL', source: 'ALL', type: 'ALL', text: '' };

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

  /** The ⓘ affordance of §9.6; renders nothing when the glossary has no entry (§6.22.1). */
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

  /** Config edits are legal in IDLE and READY only (§6.31, §6.4). */
  function canEdit() {
    const s = ctx.run.state;
    return s === 'IDLE' || s === 'READY';
  }

  function lockReason() {
    return `The run is ${ctx.run.state}. Configuration can only be changed in IDLE or READY — ` +
      'reset the run first.';
  }

  /* --------------------------------------------------------- edit plumbing */

  /**
   * Apply a partial `config.column` through `sim.reconfigureColumn`, which enforces the IDLE/READY
   * gate itself and goes through the §2.4 rebuild protocol.
   */
  function applyColumn(patch, label) {
    const fn = ctx.sim && ctx.sim.reconfigureColumn;
    if (typeof fn !== 'function') { notify('The column cannot be reconfigured here.', 'blocked'); return false; }
    const r = fn(ctx, patch);
    if (!r || r.ok === false) {
      notify(r && r.reason ? String(r.reason) : `${label} was refused.`, 'blocked');
      syncValues();
      return false;
    }
    notify(`${label} applied. The run was rebuilt.`, 'info');
    return true;
  }

  /**
   * Apply a whole-config override through `sim.rebuild`. `rebuild` carries no state guard, so the
   * IDLE/READY gate of §6.31 is enforced here before the call.
   */
  function applyRebuild(overrides, label) {
    if (!canEdit()) {
      notify(lockReason(), 'blocked');
      syncValues();
      return false;
    }
    const fn = ctx.sim && ctx.sim.rebuild;
    if (typeof fn !== 'function') { notify('This build cannot be reconfigured.', 'blocked'); return false; }
    try {
      fn(ctx, overrides);
    } catch (err) {
      notify(`${label} rejected at ingest: ${(err && err.message) || String(err)}`, 'warn');
      syncValues();
      return false;
    }
    notify(`${label} applied. The run was rebuilt.`, 'info');
    return true;
  }

  /**
   * Register a numeric field driven by a descriptor from one of the tables above.
   * @param {object} spec the descriptor.
   * @param {'column'|'root'} scope which apply path the patch takes.
   * @returns {Element} the `.field` element.
   */
  function numericField(spec, scope) {
    const nf = numfield(spec.unit, spec.label);
    const read = () => num(spec.get(ctx.config), spec.dec);
    const commit = () => {
      const v = parseFloat(nf.input.value);
      const lo = spec.min !== undefined ? spec.min : -Infinity;
      const hi = spec.max !== undefined ? spec.max : Infinity;
      if (!Number.isFinite(v) || v < lo || v > hi) {
        cls(nf.el, 'numfield--invalid', true);
        setAttr(nf.input, 'aria-invalid', 'true');
        notify(`${spec.label} must be a number between ${lo} and ${hi} ${spec.unit}.`, 'warn');
        return;
      }
      cls(nf.el, 'numfield--invalid', false);
      setAttr(nf.input, 'aria-invalid', null);
      if (Math.abs(v - spec.get(ctx.config)) < 1e-12) return;
      const ok = scope === 'column'
        ? applyColumn(spec.patch(v), spec.label)
        : applyRebuild(spec.patch(v), spec.label);
      if (!ok) nf.input.value = read();
    };
    on(nf.input, 'change', commit);
    on(nf.input, 'keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { nf.input.value = read(); nf.input.blur(); }
    });
    controls.push({ input: nf.input, read, gated: true });
    return field(spec.label, nf.el, spec.glossary);
  }

  /** A `<select>` bound to a config value. */
  function selectField(labelText, options, readFn, applyFn, glossaryId) {
    const sel = h('select', { class: 'input', 'aria-label': labelText },
      ...options.map((o) => h('option', { value: o.value }, o.label)));
    on(sel, 'change', () => {
      if (!applyFn(sel.value)) sel.value = readFn();
    });
    controls.push({ input: sel, read: readFn, gated: true });
    return field(labelText, sel, glossaryId);
  }

  /** A `.toggle` bound to a boolean config value. */
  function toggleField(labelText, readFn, applyFn, glossaryId) {
    const input = h('input', { class: 'toggle__input', type: 'checkbox' });
    on(input, 'change', () => {
      if (!applyFn(input.checked)) input.checked = readFn() === 'true';
    });
    controls.push({ input, read: readFn, gated: true, boolean: true });
    return h('label', { class: 'toggle' },
      input,
      h('span', { class: 'toggle__track' }, h('span', { class: 'toggle__knob' })),
      h('span', { class: 'toggle__label' }, labelText, glossaryId ? info(glossaryId) : null));
  }

  /** Push every control's value back from the (possibly replaced) config. */
  function syncValues() {
    for (const c of controls) {
      if (document.activeElement === c.input) continue;
      const v = c.read();
      if (c.boolean) c.input.checked = v === 'true';
      else if (c.input.value !== v) c.input.value = v;
    }
    applyLocks();
  }

  /** Disable every gated control while the run is not IDLE/READY, with an explaining tooltip. */
  function applyLocks() {
    const editable = canEdit();
    const reason = editable ? '' : lockReason();
    for (const c of controls) {
      if (!c.gated) continue;
      c.input.disabled = !editable;
      setAttr(c.input, 'title', editable ? null : reason);
    }
    if (dom.lockPill) {
      setText(dom.lockPill, editable ? 'editable' : 'locked');
      setAttr(dom.lockPill, 'data-variant', editable ? 'ok' : 'warn');
      setAttr(dom.lockPill, 'title', editable
        ? 'The run is IDLE or READY, so the configuration can be changed.' : reason);
    }
  }

  /* ------------------------------------------------------------ column card */

  function buildFlowGroup() {
    const specs = [
      { key: 'Q_mLs', label: 'Flow', unit: 'mL/min', dec: 2,
        to: (g) => g.Q_mLs * 60, from: (v) => ({ Q_mLs: v / 60 }) },
      { key: 'u_cmh', label: 'Linear velocity', unit: 'cm/h', dec: 1,
        to: (g) => g.u_cmh, from: (v) => ({ u_cmh: v }) },
      { key: 'RT_min', label: 'Residence time', unit: 'min', dec: 2,
        to: (g) => g.RT_min, from: (v) => ({ RT_min: v }) },
      { key: 'CVh', label: 'Throughput', unit: 'CV/h', dec: 2,
        to: (g) => g.CVh, from: (v) => ({ CVh: v }) },
    ];
    dom.flowInputs = {};
    const group = h('div', { class: 'fieldgroup' });
    for (const s of specs) {
      const nf = numfield(s.unit, s.label);
      on(nf.input, 'change', () => {
        const v = parseFloat(nf.input.value);
        if (!Number.isFinite(v) || v <= 0) {
          notify(`${s.label} must be a positive number.`, 'warn');
          syncFlow();
          return;
        }
        const g = linkedFlowGroup(ctx.config, s.from(v));
        flow.Q_mLs = g.Q_mLs;
        flow.u_cmh = g.u_cmh;
        flow.RT_min = g.RT_min;
        flow.CVh = g.CVh;
        syncFlow();
      });
      dom.flowInputs[s.key] = { input: nf.input, spec: s };
      group.appendChild(field(s.label, nf.el, s.key === 'u_cmh' ? 'linear-velocity'
        : (s.key === 'RT_min' ? 'residence-time' : 'flow-rate')));
    }
    return group;
  }

  /** Seed the flow calculator from the live setpoint, or from a 150 cm/h nominal. */
  function seedFlow() {
    const Q = ctx.run.Q_set_mLs > 0 ? ctx.run.Q_set_mLs
      : (ctx.run.Q_actual_mLs > 0 ? ctx.run.Q_actual_mLs : 0);
    const g = Q > 0 ? linkedFlowGroup(ctx.config, { Q_mLs: Q })
      : linkedFlowGroup(ctx.config, { u_cmh: 150 });
    flow.Q_mLs = g.Q_mLs;
    flow.u_cmh = g.u_cmh;
    flow.RT_min = g.RT_min;
    flow.CVh = g.CVh;
    syncFlow();
  }

  function syncFlow() {
    for (const key of Object.keys(dom.flowInputs)) {
      const { input, spec } = dom.flowInputs[key];
      if (document.activeElement === input) continue;
      input.value = num(spec.to(flow), spec.dec);
    }
  }

  function buildColumnCard() {
    const fields = h('div', { class: 'fieldgroup' });
    for (const spec of COLUMN_FIELDS) fields.appendChild(numericField(spec, 'column'));

    const resinOptions = Object.keys(RESINS).map((id) => ({ value: id, label: RESINS[id].name || id }));
    const resinSel = selectField('Resin', resinOptions,
      () => String(ctx.config.column.resinId || ''),
      (id) => {
        const r = RESINS[id];
        if (!r) return false;
        // The authored preset pins isothermMode/resinChargeSign and the bead geometry in
        // `column`, and `column` wins over the resin row inside normalizePreset, so the resin's
        // own numbers are pushed explicitly. Lambda is sent already on BASIS N1
        // (mmol/mL bed * 1000 / (1 - epsC)) so a stale Lambda_mM override cannot survive.
        const epsC = r.epsC !== undefined ? r.epsC : ctx.config.column.epsC;
        const patch = {
          dp_cm: r.dp_cm, epsC, epsP: r.epsP, rPore_cm: r.rPore_cm,
          kKozeny: r.kKozeny, lambdaPack: r.lambdaPack, gammaObstruction: r.gammaObstruction,
          isothermMode: r.isothermMode, resinChargeSign: r.resinChargeSign,
          compression: Object.assign({}, r.compression || {}),
        };
        if (r.Lambda_mmolPerMLbed !== undefined) {
          patch.Lambda_mM = r.Lambda_mmolPerMLbed * 1000 / (1 - epsC);
        }
        return applyRebuild({ resinId: id, column: patch }, `Resin ${r.name || id}`);
      }, 'C-101');

    const scaleOptions = Object.keys(SCALES).map((id) => ({ value: id, label: SCALES[id].name || id }));
    const scaleSel = selectField('Skid scale', scaleOptions,
      () => String(ctx.config.scale),
      (id) => applyRebuild({ scale: id }, `Scale ${id}`), null);

    const modeSel = selectField('Isotherm mode',
      ISOTHERM_MODES.map((m) => ({ value: m, label: m })),
      () => String(ctx.config.column.isothermMode),
      (m) => applyColumn({ isothermMode: m }, `Isotherm ${m}`), 'column.isothermMode');

    const signSel = selectField('Resin charge',
      [{ value: '-1', label: 'Cation exchanger (−1)' },
        { value: '0', label: 'Non-ionic (0)' },
        { value: '1', label: 'Anion exchanger (+1)' }],
      () => String(ctx.config.column.resinChargeSign),
      (v) => applyColumn({ resinChargeSign: parseInt(v, 10) }, 'Resin charge sign'),
      'column.resinChargeSign');

    const donnan = toggleField('Donnan exclusion',
      () => String(ctx.config.column.enableDonnan === true),
      (v) => applyColumn({ enableDonnan: v }, 'Donnan exclusion'), 'column.enableDonnan');
    const protVisc = toggleField('Protein viscosity',
      () => String(ctx.config.column.enableProteinViscosity === true),
      (v) => applyColumn({ enableProteinViscosity: v }, 'Protein viscosity'),
      'column.enableProteinViscosity');
    const compEnabled = toggleField('Bed compression',
      () => String(ctx.config.column.compression.enabled === true),
      (v) => applyColumn({ compression: { enabled: v } }, 'Bed compression'), 'bed-compression');

    dom.columnDerived = h('dl', { class: 'sv-kv' });
    dom.speciesBody = h('tbody', {});
    const speciesRefresh = h('button', { type: 'button', class: 'btn btn--sm' },
      'Recompute at this flow');
    on(speciesRefresh, 'click', () => { refreshSpecies(); notify('Transport summary recomputed.', 'info'); });

    return h('section', { class: 'card' },
      h('div', { class: 'card__title' }, 'Column and resin'),
      h('div', { class: 'fieldgroup' }, resinSel, scaleSel, modeSel, signSel),
      h('div', { class: 'sv-inline' }, donnan, protVisc, compEnabled),
      fields,
      h('details', { class: 'sv-details' },
        h('summary', {}, 'Flow calculator (linked Q · u · RT · CV/h)'),
        buildFlowGroup(),
        h('div', { class: 'field__hint' },
          'A calculator, not a setpoint: the run flow is a method property. Entering any one of ' +
          'the four derives the other three from this column\'s geometry.')),
      h('details', { class: 'sv-details' },
        h('summary', {}, 'Derived geometry and transport'),
        dom.columnDerived,
        h('div', { class: 'sv-inline' }, speciesRefresh),
        h('div', { class: 'table-wrap sv-scroll' },
          h('table', { class: 'table table--compact' },
            h('thead', {}, h('tr', {},
              h('th', { scope: 'col' }, 'Species'),
              h('th', { class: 'num', scope: 'col' }, 'K_t'),
              h('th', { class: 'num', scope: 'col' }, "k'"),
              h('th', { class: 'num', scope: 'col' }, 'k_ov (1/s)'),
              h('th', { class: 'num', scope: 'col' }, 'HETP (cm)'),
              h('th', { class: 'num', scope: 'col' }, 'N'),
              h('th', { class: 'num', scope: 'col' }, 'V_R (CV)'))),
            dom.speciesBody))));
  }

  function renderColumnDerived() {
    const { config, run } = ctx;
    const c = config.column;
    const rows = [
      ['Cross-section', `${num(c.A_cm2, 3)} cm²`],
      ['Column volume (1 CV)', fmtVolume(c.V_mL, config)],
      ['Bead volume', `${num(c.Vbead_mL, 1)} mL`],
      ['Total porosity ε_T', num(c.epsT, 4)],
      ['Phase ratio φ', num(c.phi, 4)],
      ['Λ per mL bed', `${num(c.Lambda_mM * (1 - c.epsC) / 1000, 4)} mmol/mL`],
      ['Compression', compressionText(run)],
      ['ΔP bed', fmtPressure(run.dPbed_bar)],
    ];
    if (run.col) {
      const d = describeColumn(run.col);
      rows.push(['Void volume V₀', `${num(d.V0_mL, 1)} mL`]);
      rows.push(['Pore volume', `${num(d.Vpore_mL, 1)} mL`]);
      rows.push(['Total liquid V_t', `${num(d.Vt_mL, 1)} mL`]);
      rows.push(['Cell height dz', `${num(d.dz_cm, 5)} cm`]);
      rows.push(['Interstitial transit t₀', Number.isFinite(d.t0_s) ? fmtTime(d.t0_s) : '—']);
      rows.push(['Liquid residence', Number.isFinite(d.tResLiquid_s) ? fmtTime(d.tResLiquid_s) : '—']);
    }
    while (dom.columnDerived.firstChild) dom.columnDerived.removeChild(dom.columnDerived.firstChild);
    for (const [k, v] of rows) {
      dom.columnDerived.appendChild(h('dt', {}, k));
      dom.columnDerived.appendChild(h('dd', {}, v));
    }
  }

  /**
   * Refresh the per-species transport summary at the flow calculator's operating point.
   * `describeSpecies` forces a coefficient refresh on `run.col` (its own documented behaviour;
   * `stepColumn` refreshes again on its next call), so it is called on demand only — never per
   * frame and never while the answer is not being looked at.
   */
  function refreshSpecies() {
    const { config, run } = ctx;
    if (!run.col) { speciesInfo = null; renderSpecies(); return; }
    const u_cms = flow.u_cmh / 3600;
    speciesInfo = describeSpecies(run.col, u_cms, run.T_fluid_C, run.mu_cP, run.rho_gmL);
    renderSpecies();
  }

  function renderSpecies() {
    const rows = (speciesInfo || []).map((s, i) => Object.assign({ key: s.id || `s${i}` }, s));
    reconcileList(dom.speciesBody, rows, (r) => r.key,
      () => {
        const tr = h('tr', {}, h('td', {}, ''));
        for (let k = 0; k < 6; k++) tr.appendChild(h('td', { class: 'num' }, ''));
        return tr;
      },
      (tr, r) => {
        const c = tr.children;
        setText(c[0], r.id);
        setText(c[1], num(r.Kt, 4));
        setText(c[2], num(r.kPrime, 3));
        setText(c[3], num(r.kOv_s1, 4));
        setText(c[4], num(r.HETP_cm, 5));
        setText(c[5], num(r.N, 0));
        setText(c[6], num(r.VR_CV, 3));
      });
  }

  /* -------------------------------------------------------------- skid card */

  function buildSkidCard() {
    const fields = h('div', { class: 'fieldgroup' });
    for (const spec of SKID_FIELDS) fields.appendChild(numericField(spec, 'root'));

    const gradSel = selectField('Gradient mode',
      [{ value: 'LPGF', label: 'LPGF — low-pressure proportioner' },
        { value: 'HPGF', label: 'HPGF — two metering pumps' }],
      () => String(ctx.config.skid.gradientMode),
      (v) => applyRebuild({ skid: { gradientMode: v } }, `Gradient mode ${v}`),
      'skid.gradientMode');

    const airTrap = toggleField('Air trap fitted',
      () => String(ctx.config.skid.airTrap === true),
      (v) => applyRebuild({ skid: { airTrap: v } }, 'Air trap'), 'AT-101');
    const inlineFilter = toggleField('Inline filter fitted',
      () => String(ctx.config.skid.inlineFilter === true),
      (v) => applyRebuild({ skid: { inlineFilter: v } }, 'Inline filter'), 'F-101');

    dom.holdup = h('dl', { class: 'sv-kv' });

    return h('section', { class: 'card' },
      h('div', { class: 'card__title' }, 'Skid'),
      h('div', { class: 'fieldgroup' }, gradSel),
      h('div', { class: 'sv-inline' }, airTrap, inlineFilter),
      fields,
      h('details', { class: 'sv-details' },
        h('summary', {}, 'Hold-up and delay volumes'),
        dom.holdup,
        h('div', { class: 'field__hint' },
          'Derived by skid.buildTopology from the per-scale segment table (§5.7); they move ' +
          'every peak on the x axis, so they are reported, never authored here.')));
  }

  function renderHoldup() {
    const hu = ctx.config.skid.holdup || {};
    const rows = [
      ['Suction side', `${num(hu.Vsuction_mL, 2)} mL`],
      ['Gradient path', `${num(hu.Vgrad_mL, 2)} mL`],
      ['Column outlet → UV', `${num(hu.VcolOutToUV_mL, 2)} mL`],
      ['UV → conductivity', `${num(hu.VuvToCond_mL, 2)} mL`],
      ['Conductivity → pH', `${num(hu.VcondToPh_mL, 2)} mL`],
      ['pH → fraction valve', `${num(hu.VphToFracValve_mL, 2)} mL`],
      ['UV → fraction valve', `${num(hu.VuvToFracValve_mL, 2)} mL`],
      ['Fraction dead leg', `${num(hu.VfracDeadLeg_mL, 2)} mL`],
      ['Sample line', `${num(hu.VsampleLine_mL, 2)} mL`],
      ['Gradient σ', `${num(hu.sigmaGrad_mL, 2)} mL`],
      ['Gradient N_eff', num(hu.NeffGrad, 3)],
      ['σ injection → UV', `${num(hu.sigmaInjToUV_mL, 3)} mL`],
    ];
    while (dom.holdup.firstChild) dom.holdup.removeChild(dom.holdup.firstChild);
    for (const [k, v] of rows) {
      dom.holdup.appendChild(h('dt', {}, k));
      dom.holdup.appendChild(h('dd', {}, v));
    }
  }

  /* ------------------------------------------------------------ fluids card */

  function buildFluidsCard() {
    const chemFields = h('div', { class: 'fieldgroup' });
    for (const spec of CHEM_FIELDS) chemFields.appendChild(numericField(spec, 'root'));

    const loadFields = h('div', { class: 'fieldgroup' });
    for (const spec of LOAD_FIELDS) loadFields.appendChild(numericField(spec, 'root'));

    const basisSel = selectField('Load basis',
      [{ value: 'MG_PER_ML_RESIN', label: 'mg per mL resin' },
        { value: 'G_TOTAL', label: 'g total' },
        { value: 'CV', label: 'column volumes' },
        { value: 'ML', label: 'mL' }],
      () => String(ctx.config.load.basis),
      (v) => applyRebuild({ load: { basis: v } }, `Load basis ${v}`), 'load-challenge');

    dom.loadDerived = h('dl', { class: 'sv-kv' });
    dom.tanks = h('div', {});
    dom.speciesEditBody = h('tbody', {});
    dom.speciesEditHead = h('tr', {});

    return h('section', { class: 'card' },
      h('div', { class: 'card__title' }, 'Buffers, sample and chemistry'),
      dom.tanks,
      h('details', { class: 'sv-details' },
        h('summary', {}, 'Load specification'),
        h('div', { class: 'fieldgroup' }, basisSel), loadFields, dom.loadDerived),
      h('details', { class: 'sv-details' },
        h('summary', {}, 'Chemistry constants'), chemFields),
      h('details', { class: 'sv-details' },
        h('summary', {}, 'Species and isotherm parameters'),
        h('div', { class: 'table-wrap sv-scroll' },
          h('table', { class: 'table table--compact' },
            h('thead', {}, dom.speciesEditHead), dom.speciesEditBody)),
        h('div', { class: 'field__hint' },
          'Only the parameters the current isotherm mode reads are editable; ε_p,i is the ' +
          'species\' accessible pore porosity and feeds both q* and k_ov.')));
  }

  function renderTanks() {
    const { config, run } = ctx;
    const items = config.tanks.map((t, i) => ({ key: t.id, t, i }));
    reconcileList(dom.tanks, items, (r) => r.key,
      (r) => {
        const name = h('div', { class: 'sv-tank__name' }, '');
        const sub = h('div', { class: 'sv-tank__sub' }, '');
        const chem = h('div', { class: 'sv-tank__sub' }, '');
        const refill = h('button', { type: 'button', class: 'btn btn--sm' }, 'Refill');
        refill.addEventListener('click', () => {
          const fn = ctx.sim && ctx.sim.refillTank;
          if (typeof fn !== 'function') return;
          const res = fn(ctx, r.t.id, r.t.nominalVolume_mL);
          if (!res || res.ok === false) {
            notify(res && res.reason ? String(res.reason) : `${r.t.id} could not be refilled.`, 'blocked');
          } else {
            notify(`${r.t.id} refilled to ${num(r.t.nominalVolume_mL / 1000, 1)} L.`, 'info');
          }
        });
        const bar = h('div', { class: 'sv-level' }, h('i', {}));
        const el = h('div', { class: 'sv-tank' },
          h('div', {}, name, sub, chem), refill, bar);
        el._parts = { name, sub, chem, bar: bar.firstChild, barEl: bar };
        return el;
      },
      (el, r) => {
        const p = el._parts;
        const t = r.t;
        const level = run.tankVolume_mL ? run.tankVolume_mL[r.i] : t.startVolume_mL;
        const frac = t.nominalVolume_mL > 0 ? level / t.nominalVolume_mL : 0;
        setText(p.name, `${t.id} — ${t.label}`);
        setText(p.sub, `${t.port} · ${num(level / 1000, 2)} / ${num(t.nominalVolume_mL / 1000, 2)} L` +
          ` · ${num(frac * 100, 0)} %${t.isSample ? ' · SAMPLE' : ''}`);
        const d = t.derived || {};
        setText(p.chem, `pH ${fmtPH(d.pH)} · ${fmtCond(d.kappa25_mScm)} at 25 °C · ` +
          `I ${num(d.I_molL, 4)} M · Na ${num(d.Na_mM, 1)} mM · Cl ${num(d.Cl_mM, 1)} mM`);
        p.bar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
        setAttr(p.barEl, 'data-low', frac * 100 <= t.lowLevelPct ? 'true' : 'false');
      });
  }

  function renderLoadDerived() {
    const { config } = ctx;
    const d = config.load.derived || {};
    const rows = [
      ['Product species', String(config.load.productSpeciesId)],
      ['Load mass', `${num(d.mass_g, 3)} g`],
      ['Load volume', `${num(d.volume_mL, 1)} mL`],
      ['Load challenge', `${num(d.CV, 4)} CV`],
      ['Filter load', `${num(d.volume_mL * config.load.feedTiterTotal_gL, 0)} mg total protein`],
    ];
    while (dom.loadDerived.firstChild) dom.loadDerived.removeChild(dom.loadDerived.firstChild);
    for (const [k, v] of rows) {
      dom.loadDerived.appendChild(h('dt', {}, k));
      dom.loadDerived.appendChild(h('dd', {}, v));
    }
  }

  /** The isotherm parameters the current mode actually reads (§5.8.1). */
  function isothermParams(mode) {
    if (mode === 'SMA') {
      return [{ key: 'nu', label: 'ν', dec: 3 }, { key: 'sigma', label: 'σ', dec: 1 },
        { key: 'Keq', label: 'K_eq', dec: 5 }];
    }
    if (mode === 'LANGMUIR' || mode === 'HIC') {
      return [{ key: 'qmax_mM', label: 'q_max (mM)', dec: 3 },
        { key: 'b0_mM1', label: 'b₀ (1/mM)', dec: 6 },
        { key: 'beta_mM1', label: 'β (1/mM)', dec: 5 },
        { key: 'csRef_mM', label: 'c_s,ref (mM)', dec: 1 }];
    }
    if (mode === 'LINEAR') return [{ key: 'Klin', label: 'K_lin', dec: 4 }];
    return [];
  }

  function renderSpeciesEditor() {
    const { config } = ctx;
    const params = isothermParams(config.column.isothermMode);
    const cols = [{ key: 'epsPi', label: 'ε_p,i', dec: 3 },
      { key: 'keffScale', label: 'k_eff ×', dec: 3 }].concat(params);

    while (dom.speciesEditHead.firstChild) {
      dom.speciesEditHead.removeChild(dom.speciesEditHead.firstChild);
    }
    dom.speciesEditHead.appendChild(h('th', { scope: 'col' }, 'Species'));
    dom.speciesEditHead.appendChild(h('th', { scope: 'col' }, 'Role'));
    dom.speciesEditHead.appendChild(h('th', { class: 'num', scope: 'col' }, 'MW (kDa)'));
    for (const c of cols) dom.speciesEditHead.appendChild(h('th', { class: 'num', scope: 'col' }, c.label));

    // The column set depends on the isotherm mode, so it is part of the row identity: a mode change
    // must rebuild the rows, not reuse cells that no longer mean the same parameter.
    const colKey = cols.map((c) => c.key).join(',');
    const items = config.species.map((s, i) => ({ key: `${s.id}|${colKey}`, s, i, cols }));
    reconcileList(dom.speciesEditBody, items, (r) => r.key,
      (r) => {
        const tr = h('tr', {},
          h('td', {}, ''), h('td', {}, ''), h('td', { class: 'num' }, ''));
        tr._inputs = {};
        for (const c of r.cols) {
          const input = h('input', {
            class: 'numfield__input', type: 'text', inputmode: 'decimal',
            style: 'width:74px', 'aria-label': `${r.s.id} ${c.label}`,
          });
          const commit = () => {
            const v = parseFloat(input.value);
            if (!Number.isFinite(v)) {
              notify(`${r.s.id} ${c.label} must be a number.`, 'warn');
              input.value = num(ctx.config.species[r.i][c.key], c.dec);
              return;
            }
            const patch = {};
            patch[c.key] = v;
            const ok = applyRebuild({ speciesOverrides: { [r.s.id]: patch } },
              `${r.s.id} ${c.label}`);
            if (!ok) input.value = num(ctx.config.species[r.i][c.key], c.dec);
          };
          input.addEventListener('change', commit);
          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          });
          tr._inputs[c.key] = input;
          tr.appendChild(h('td', { class: 'num' }, input));
        }
        return tr;
      },
      (tr, r) => {
        const s = ctx.config.species[r.i] || r.s;
        setText(tr.children[0], s.id);
        setText(tr.children[1], `${s.role} · ${s.kind}`);
        setText(tr.children[2], num(s.MW_gmol / 1000, 1));
        const editable = canEdit();
        for (const c of r.cols) {
          const input = tr._inputs[c.key];
          if (!input) continue;
          if (document.activeElement !== input) input.value = num(s[c.key], c.dec);
          input.disabled = !editable;
          setAttr(input, 'title', editable ? null : lockReason());
        }
      });
  }

  /* --------------------------------------------------------- thumbnail card */

  function buildThumbCard() {
    dom.thumb = h('canvas', { class: 'sv-thumb', role: 'img',
      'aria-label': 'Scale drawing of the configured column' });
    dom.thumbCaption = h('div', { class: 'field__hint' }, '');
    dom.lockPill = h('span', { class: 'pill', 'data-variant': 'ok' }, 'editable');
    dom.status = h('div', { class: 'sv-status', role: 'status', 'aria-live': 'polite' }, '');
    return h('section', { class: 'card' },
      h('div', { class: 'card__title' }, 'Configuration'),
      dom.lockPill,
      dom.thumb,
      dom.thumbCaption,
      dom.status);
  }

  /** Draw the column to scale with its dimensions and the live compression state. */
  function drawThumb() {
    const canvas = dom.thumb;
    if (!canvas) return;
    const { config, run } = ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = 196;
    const H = 240;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.height = `${H}px`;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    if (!tokens) tokens = readThemeTokens('current');
    const t = tokens || {};
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const c = config.column;
    const aspect = c.id_cm / Math.max(c.L_cm, 1e-6);
    const maxH = H - 56;
    const maxW = W - 72;
    let colH = maxH;
    let colW = colH * aspect;
    if (colW > maxW) { colW = maxW; colH = colW / Math.max(aspect, 1e-6); }
    const x = (W - colW) / 2;
    const y = 28;

    // Glass tube.
    g.fillStyle = t['--col-glass'] || 'rgba(255,255,255,0.03)';
    g.strokeStyle = t['--line-strong'] || '#3A4757';
    g.lineWidth = 2;
    g.beginPath();
    g.rect(x, y, colW, colH);
    g.fill();
    g.stroke();

    // Bed, shortened by the compression offset.
    const eps0 = c.compression.eps0 || c.epsC;
    const shrink = eps0 > 0 ? Math.max(0, 1 - (1 - run.epsCompressed) / (1 - eps0)) : 0;
    const bedTop = y + Math.min(colH * 0.25, colH * shrink);
    g.fillStyle = t['--bed-bead'] || '#8E9AA8';
    g.globalAlpha = 0.35;
    g.fillRect(x + 2, bedTop, colW - 4, y + colH - bedTop - 2);
    g.globalAlpha = 1;

    // Adapters.
    g.fillStyle = t['--surface-3'] || '#243040';
    g.fillRect(x - 4, y - 8, colW + 8, 8);
    g.fillRect(x - 4, y + colH, colW + 8, 8);

    // Dimension labels.
    g.fillStyle = t['--text-3'] || '#71818F';
    g.font = `10px ${t['--font-ui'] || 'sans-serif'}`;
    g.textAlign = 'center';
    g.fillText(`${c.id_cm.toFixed(2)} cm ID`, W / 2, y - 14);
    g.save();
    g.translate(x - 14, y + colH / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(`${c.L_cm.toFixed(2)} cm bed`, 0, 0);
    g.restore();
    g.fillStyle = t['--text-2'] || '#A7B4C4';
    g.fillText(`1 CV = ${c.V_mL.toFixed(1)} mL`, W / 2, y + colH + 26);
    g.fillText(compressionText(run), W / 2, y + colH + 40);

    setText(dom.thumbCaption, `${config.name} · ${config.scale} · ` +
      `${config.column.resinId || 'custom resin'} · seed ${config.seed}`);
  }

  /* ------------------------------------------------------------ alarm table */

  const ALARM_COLUMNS = ['Alarm', 'Signal', 'Op', 'Limit', 'Persist (s)', 'Severity', 'Action',
    'State', ''];

  function buildAlarmPanel() {
    dom.alarmBody = h('tbody', {});
    return h('section', { class: 'panel' },
      h('div', { class: 'panel__header' },
        h('span', { class: 'panel__title' }, 'Alarm limits'), info('alarm-state'),
        h('div', { class: 'panel__tools' },
          dom.alarmSummary = h('span', { class: 'pill', 'data-variant': 'neutral' }, 'no alarms'))),
      h('div', { class: 'panel__body panel__body--flush' },
        h('div', { class: 'table-wrap', style: 'border:0;border-radius:0' },
          h('table', { class: 'table table--compact' },
            h('thead', {}, h('tr', {}, ...ALARM_COLUMNS.map((c, i) => h('th',
              { class: i === 3 || i === 4 ? 'num' : '', scope: 'col' }, c)))),
            dom.alarmBody))));
  }

  function renderAlarmTable(structural) {
    const { config, run } = ctx;
    const rows = config.alarms.map((a, i) => ({ key: a.id, a, i }));

    if (structural) {
      reconcileList(dom.alarmBody, rows, (r) => r.key,
        (r) => {
          const tr = h('tr', {});
          const name = h('td', { class: 'wrap' }, '');
          const signal = h('td', {}, '');
          const op = h('td', {}, '');
          const limitCell = h('td', { class: 'num' });
          let input = null;
          if (r.a.threshold !== null && r.a.threshold !== undefined) {
            input = h('input', {
              class: 'numfield__input', type: 'text', inputmode: 'decimal',
              style: 'width:78px', 'aria-label': `${r.a.id} limit`,
            });
            const commit = () => {
              const v = parseFloat(input.value);
              if (!Number.isFinite(v)) {
                notify(`${r.a.id} limit must be a number.`, 'warn');
                input.value = num(ctx.config.alarms[r.i].threshold, 3);
                return;
              }
              const ok = applyRebuild({ alarmThresholdOverrides: { [r.a.id]: v } },
                `${r.a.id} limit`);
              if (!ok) input.value = num(ctx.config.alarms[r.i].threshold, 3);
            };
            input.addEventListener('change', commit);
            input.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            });
            limitCell.appendChild(input);
          } else {
            limitCell.appendChild(document.createTextNode('—'));
          }
          const persist = h('td', { class: 'num' }, '');
          const sev = h('td', {}, '');
          const action = h('td', {}, '');
          const state = h('td', {}, h('span', { class: 'pill', 'data-variant': 'neutral' }, 'clear'));
          const ackCell = h('td', {});
          const ack = h('button', { type: 'button', class: 'btn btn--sm' }, 'Ack');
          ack.addEventListener('click', () => {
            const fn = ctx.sim && ctx.sim.acknowledgeAlarm;
            if (typeof fn !== 'function') return;
            const res = fn(ctx, r.a.id);
            if (!res || res.ok === false) {
              notify(res && res.reason ? String(res.reason) : `${r.a.id} could not be acknowledged.`,
                'blocked');
            } else {
              notify(`${r.a.id} acknowledged.`, 'info');
            }
          });
          ackCell.appendChild(ack);
          tr.appendChild(name);
          tr.appendChild(signal);
          tr.appendChild(op);
          tr.appendChild(limitCell);
          tr.appendChild(persist);
          tr.appendChild(sev);
          tr.appendChild(action);
          tr.appendChild(state);
          tr.appendChild(ackCell);
          tr._parts = { input, state: state.firstChild, ack };
          return tr;
        },
        (tr, r) => {
          const a = ctx.config.alarms[r.i] || r.a;
          const c = tr.children;
          setText(c[0], `${a.id} — ${a.name}`);
          setText(c[1], a.signal || (a.evalKey ? `${a.evalKey}()` : '—'));
          setText(c[2], a.op || '—');
          setText(c[4], num(a.persist_s, 1));
          setText(c[5], a.severity);
          setText(c[6], a.action);
          const p = tr._parts;
          if (p.input && document.activeElement !== p.input) {
            p.input.value = num(a.threshold, 3);
            p.input.disabled = !canEdit();
            setAttr(p.input, 'title', canEdit() ? null : lockReason());
          }
          setAttr(tr, 'title',
            `${a.latching ? 'Latching' : 'Non-latching'}` +
            `${a.suppressWhen && a.suppressWhen.length ? ` · suppressed by ${a.suppressWhen.join(', ')}` : ''}`);
        });
    }

    // Live state, every refresh.
    let worst = -1;
    let active = 0;
    const children = dom.alarmBody.children;
    for (let i = 0; i < children.length && i < config.alarms.length; i++) {
      const tr = children[i];
      const parts = tr._parts;
      if (!parts) continue;
      const isActive = run.alarmActive[i] === 1;
      const latched = run.alarmLatched[i] === 1;
      const acked = run.alarmAcked[i] === 1;
      const label = isActive ? (acked ? 'active · ack' : 'ACTIVE')
        : (latched ? (acked ? 'latched · ack' : 'LATCHED') : 'clear');
      setText(parts.state, label);
      setAttr(parts.state, 'data-variant',
        isActive ? 'alarm' : (latched ? 'warn' : 'neutral'));
      parts.ack.disabled = !(isActive || latched) || acked;
      if (isActive || latched) {
        active++;
        const rank = SEVERITIES.indexOf(config.alarms[i].severity);
        if (rank > worst) worst = rank;
      }
    }
    setText(dom.alarmSummary, active === 0 ? 'no alarms'
      : `${active} active · worst ${SEVERITIES[worst] || 'INFO'}`);
    setAttr(dom.alarmSummary, 'data-variant', active === 0 ? 'ok'
      : (worst >= SEVERITIES.indexOf('ALARM') ? 'alarm' : 'warn'));
  }

  /* -------------------------------------------------------------- event log */

  const LOG_COLUMNS = ['t (s)', 'CV', 'Type', 'Source', 'Severity', 'Message', ''];

  function buildLogPanel() {
    const sevSel = h('select', { class: 'input', 'aria-label': 'Filter by severity' },
      h('option', { value: 'ALL' }, 'All severities'),
      ...SEVERITIES.map((s) => h('option', { value: s }, s)));
    on(sevSel, 'change', () => { logFilter.severity = sevSel.value; renderLog(true); });

    const srcSel = h('select', { class: 'input', 'aria-label': 'Filter by source' },
      h('option', { value: 'ALL' }, 'All sources'),
      ...SOURCES.map((s) => h('option', { value: s }, s)));
    on(srcSel, 'change', () => { logFilter.source = srcSel.value; renderLog(true); });

    dom.typeSel = h('select', { class: 'input', 'aria-label': 'Filter by event type' },
      h('option', { value: 'ALL' }, 'All types'));
    on(dom.typeSel, 'change', () => { logFilter.type = dom.typeSel.value; renderLog(true); });

    const search = h('input', {
      class: 'input sv-search', type: 'search', placeholder: 'Search messages',
      'aria-label': 'Search event messages',
    });
    on(search, 'input', () => { logFilter.text = search.value.trim().toLowerCase(); renderLog(true); });

    const more = h('button', { type: 'button', class: 'btn btn--sm' }, 'Show more');
    on(more, 'click', () => { logLimit += LOG_PAGE; renderLog(true); });
    dom.logMore = more;

    const clear = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Reset filters');
    on(clear, 'click', () => {
      logFilter.severity = 'ALL';
      logFilter.source = 'ALL';
      logFilter.type = 'ALL';
      logFilter.text = '';
      sevSel.value = 'ALL';
      srcSel.value = 'ALL';
      dom.typeSel.value = 'ALL';
      search.value = '';
      logLimit = LOG_PAGE;
      renderLog(true);
    });

    dom.logBody = h('tbody', {});
    dom.logCount = h('span', { class: 'pill', 'data-variant': 'neutral' }, '0 events');
    dom.logEmpty = h('div', { class: 'empty' },
      h('div', { class: 'empty__title' }, 'No events yet'),
      h('div', {}, 'Every state change, block boundary, watch, alarm and operator action lands ' +
        'here as it happens.'));

    return h('section', { class: 'panel' },
      h('div', { class: 'panel__header' },
        h('span', { class: 'panel__title' }, 'Event and alarm log'),
        h('div', { class: 'panel__tools' }, dom.logCount)),
      h('div', { class: 'filterbar' }, sevSel, srcSel, dom.typeSel, search, more, clear),
      h('div', { class: 'panel__body panel__body--flush' },
        h('div', { class: 'table-wrap', style: 'border:0;border-radius:0' },
          h('table', { class: 'table table--compact logtable' },
            h('thead', {}, h('tr', {}, ...LOG_COLUMNS.map((c, i) => h('th',
              { class: i < 2 ? 'num' : '', scope: 'col' }, c)))),
            dom.logBody)),
        dom.logEmpty));
  }

  /** Alarm row index for an ALARM_RAISED event, matched on the id the message starts with. */
  function alarmIndexForEvent(e) {
    if (!e || typeof e.message !== 'string') return -1;
    const alarms = ctx.config.alarms;
    for (let i = 0; i < alarms.length; i++) {
      if (e.message.indexOf(alarms[i].id) === 0) return i;
    }
    return -1;
  }

  function refreshTypeOptions() {
    const seen = new Set();
    for (const e of ctx.run.events || []) seen.add(e.type);
    const wanted = ['ALL'].concat(Array.from(seen).sort());
    if (dom.typeSel.options.length === wanted.length) return;
    const current = dom.typeSel.value;
    while (dom.typeSel.firstChild) dom.typeSel.removeChild(dom.typeSel.firstChild);
    for (const v of wanted) {
      dom.typeSel.appendChild(h('option', { value: v }, v === 'ALL' ? 'All types' : v));
    }
    dom.typeSel.value = wanted.indexOf(current) >= 0 ? current : 'ALL';
  }

  function renderLog(force) {
    const { config, run } = ctx;
    const events = run.events || [];
    if (!force && events.length === lastEventCount) return;
    lastEventCount = events.length;
    refreshTypeOptions();

    const rows = [];
    for (let i = events.length - 1; i >= 0 && rows.length < logLimit; i--) {
      const e = events[i];
      if (logFilter.severity !== 'ALL' && e.severity !== logFilter.severity) continue;
      if (logFilter.source !== 'ALL' && e.source !== logFilter.source) continue;
      if (logFilter.type !== 'ALL' && e.type !== logFilter.type) continue;
      if (logFilter.text && String(e.message || '').toLowerCase().indexOf(logFilter.text) < 0) continue;
      rows.push({ key: `e${i}`, i, e, alarmIdx: e.type === 'ALARM_RAISED' ? alarmIndexForEvent(e) : -1 });
    }

    setText(dom.logCount, `${rows.length} shown · ${events.length} total`);
    dom.logEmpty.hidden = events.length > 0;
    dom.logMore.disabled = rows.length < logLimit;

    reconcileList(dom.logBody, rows, (r) => r.key,
      (r) => {
        const tr = h('tr', {},
          h('td', { class: 'num' }, ''), h('td', { class: 'num' }, ''),
          h('td', {}, ''), h('td', {}, ''), h('td', {}, ''),
          h('td', { class: 'msg wrap' }, ''));
        const ackCell = h('td', {});
        const ack = h('button', { type: 'button', class: 'btn btn--sm' }, 'Ack');
        ack.addEventListener('click', () => {
          const idx = r.alarmIdx;
          if (idx < 0) return;
          const fn = ctx.sim && ctx.sim.acknowledgeAlarm;
          if (typeof fn !== 'function') return;
          const res = fn(ctx, ctx.config.alarms[idx].id);
          if (!res || res.ok === false) {
            notify(res && res.reason ? String(res.reason) : 'Acknowledge refused.', 'blocked');
          } else {
            notify(`${ctx.config.alarms[idx].id} acknowledged.`, 'info');
          }
        });
        ackCell.appendChild(ack);
        tr.appendChild(ackCell);
        tr._ack = ack;
        return tr;
      },
      (tr, r) => {
        const e = r.e;
        const c = tr.children;
        setText(c[0], num(e.t_s, 1));
        setText(c[1], num(e.V_CV, 3));
        setText(c[2], e.type);
        setText(c[3], e.source);
        setText(c[4], e.severity);
        setAttr(c[4], 'data-severity', e.severity);
        setText(c[5], e.message + (e.blockId ? ` [${e.blockId}]` : ''));
        setAttr(c[5], 'data-severity', e.severity);
        if (e.detail) {
          let text = '';
          try {
            text = JSON.stringify(e.detail);
          } catch (err) {
            text = '[detail not serialisable]';
          }
          setAttr(c[5], 'title', text);
        }
        const idx = r.alarmIdx;
        const shown = idx >= 0 &&
          (ctx.run.alarmActive[idx] === 1 || ctx.run.alarmLatched[idx] === 1);
        tr._ack.hidden = !shown;
        tr._ack.disabled = !shown || ctx.run.alarmAcked[idx] === 1;
        setText(tr._ack, shown && ctx.run.alarmAcked[idx] === 1 ? 'Acked' : 'Ack');
      });
  }

  /* ------------------------------------------------------------ build tree */

  const el = h('div', { class: 'systemview' });
  const columnCard = buildColumnCard();
  const skidCard = buildSkidCard();
  const fluidsCard = buildFluidsCard();
  const thumbCard = buildThumbCard();
  const logPanel = buildLogPanel();
  const alarmPanel = buildAlarmPanel();

  el.appendChild(h('div', { class: 'systemview__cards' },
    columnCard, skidCard, fluidsCard, thumbCard));
  el.appendChild(h('div', { class: 'systemview__logs' }, logPanel, alarmPanel));

  /* --------------------------------------------------------------- lifecycle */

  /** Re-read everything from the (possibly replaced) config and run. */
  function rebind() {
    speciesInfo = null;
    lastEventCount = -1;
    lastThumbKey = '';
    syncValues();
    seedFlow();
    renderColumnDerived();
    renderHoldup();
    renderTanks();
    renderLoadDerived();
    renderSpeciesEditor();
    renderSpecies();
    renderAlarmTable(true);
    renderLog(true);
    drawThumb();
  }

  function mount() {
    if (mounted) return;
    // `styles/app.css` styles the tab host as `.view` and carries a `.view--system` modifier for
    // this view's scrolling; `ui/app.js` builds the host generically, so the modifier is applied
    // here, by the view that owns the content.
    if (rootEl.classList) rootEl.classList.add('view--system');
    rootEl.appendChild(el);
    mounted = true;
    try {
      overlayHost = overlayHostFor(ctx);
    } catch (err) {
      overlayHost = null;   // popovers and toasts degrade to the inline status line
    }
    try {
      tokens = readThemeTokens('current');
    } catch (err) {
      tokens = null;        // the canvas falls back to literal defaults
    }

    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) visible = e.isIntersecting;
      }, { root: null, threshold: 0 });
      observer.observe(el);
    }

    subscribe('config-replaced', rebind);
    subscribe('preset-loaded', rebind);
    subscribe('run-reset', rebind);
    subscribe('scenario-applied', rebind);
    subscribe('theme-changed', () => {
      try {
        tokens = readThemeTokens('current');
      } catch (err) {
        tokens = null;
      }
      lastThumbKey = '';
      drawThumb();
    });

    rebind();
    refreshSpecies();
  }

  function update(frameInfo) {
    if (!mounted || !visible) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const structural = frameInfo.structural === true;
    if (structural) {
      syncValues();
      renderSpeciesEditor();
      renderAlarmTable(true);
    }
    if (structural || frameInfo.now_ms - lastLiveMs >= LIVE_MS) {
      lastLiveMs = frameInfo.now_ms;
      renderAlarmTable(false);
      renderLog(false);
      renderTanks();
      applyLocks();
      const { run } = ctx;
      const key = `${run.epsCompressed.toFixed(4)}|${run.bedCollapsed}|${ctx.config.column.V_mL}`;
      if (key !== lastThumbKey) {
        lastThumbKey = key;
        renderColumnDerived();
        drawThumb();
      }
    }
  }

  function destroy() {
    for (const [name, fn] of busHandlers) {
      if (ctx.bus && typeof ctx.bus.off === 'function') ctx.bus.off(name, fn);
    }
    busHandlers.length = 0;
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
    if (observer) { observer.disconnect(); observer = null; }
    if (openPopover) {
      try { dismiss(openPopover); } catch (err) { /* the host may already be gone */ }
      openPopover = null;
    }
    if (rootEl.classList) rootEl.classList.remove('view--system');
    if (el.parentNode) el.parentNode.removeChild(el);
    mounted = false;
  }

  return { el, mount, update, destroy };
}
