/**
 * @file `src/ui/view_system.js` — the SYSTEM screen (architecture-v2 §6.31, §9.1.1), drawn in the
 * FT-CLASSIC operator vocabulary: beveled grey panels, sunken label boxes carrying a tag and an
 * engineering unit, icon-only controls with tooltips, classic sunken data grids with a severity
 * lamp in the first column.
 *
 * The screen keeps every function it had: column / resin, skid, chemistry, load, tanks, species and
 * isotherm parameters, the derived-geometry and hold-up reports, the alarm-limit table and the
 * event log with its filters.
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
 * TEXT POLICY: no sentence renders on this screen. Tags are 10 px uppercase, every number sits in a
 * sunken box with its unit, every control is an icon with `title` + `aria-label`, and all
 * explanation lives in `title` tooltips and in the `data/glossary.js` popovers.
 */

import {
  h, hSvg, setText, setAttr, cls, reconcileList,
  fmtVolume, fmtTime, fmtPressure, fmtCond, fmtPH,
  linkedFlowGroup,
} from './format.js';
import { createOverlayHost, showGlossaryPopover, showToast, dismiss } from './overlay.js';
import { SEVERITIES } from '../skid/alarms.js';
import { RESINS, SCALES } from '../data/library.js';
import { glossaryFor } from '../data/glossary.js';
import { describeColumn, describeSpecies } from '../physics/column.js';

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

const STYLE_ID = 'sv-ftclassic-style';

/** Live readouts (alarm state, log rows, thumbnail) refresh at most this often, in ms. */
const LIVE_MS = 250;
/** Log rows rendered per page. */
const LOG_PAGE = 250;

const ISOTHERM_MODES = ['SMA', 'LANGMUIR', 'HIC', 'SEC', 'LINEAR', 'INERT'];
const SOURCES = ['PHASE_ENGINE', 'ALARM', 'OPERATOR', 'MANUAL', 'SYSTEM'];

/** Severity -> lamp state. */
const SEV_LAMP = {
  INFO: 'off', WARN: 'warn', ALARM: 'alarm', CRITICAL: 'alarm', FAULT: 'alarm',
};

/** Canvas colours are resolved from the live custom properties once per theme. */
const TOKEN_NAMES = ['--face', '--face-2', '--face-3', '--bev-hi', '--bev-lt', '--bev-sh',
  '--bev-dk', '--ink', '--ink-2', '--ink-off', '--fld-bg', '--fld-pv', '--fld-eu', '--plot-axis',
  '--pipe-idle', '--svc-a'];

/**
 * Column fields. `tag` is the 10 px uppercase label, `label` the tooltip / aria text. `get` reads
 * the frozen config; `patch` returns a partial `config.column` for `sim.reconfigureColumn`.
 */
const COLUMN_FIELDS = [
  { tag: 'ID', label: 'Inner diameter', unit: 'cm', dec: 2, glossary: 'column.id_cm', min: 0.1, max: 200,
    get: (c) => c.column.id_cm, patch: (v) => ({ id_cm: v }) },
  { tag: 'BED L', label: 'Bed height', unit: 'cm', dec: 2, glossary: 'column.L_cm', min: 0.5, max: 100,
    get: (c) => c.column.L_cm, patch: (v) => ({ L_cm: v }) },
  { tag: 'EPS-C', label: 'Interstitial porosity', unit: '-', dec: 3, glossary: 'column.epsC', min: 0.15, max: 0.6,
    get: (c) => c.column.epsC, patch: (v) => ({ epsC: v, compression: { eps0: v } }) },
  { tag: 'EPS-P', label: 'Particle porosity', unit: '-', dec: 3, glossary: 'column.epsP', min: 0, max: 0.98,
    get: (c) => c.column.epsP, patch: (v) => ({ epsP: v }) },
  { tag: 'DP', label: 'Bead diameter', unit: 'um', dec: 1, glossary: 'column.dp_cm', min: 5, max: 500,
    get: (c) => c.column.dp_cm * 1e4, patch: (v) => ({ dp_cm: v * 1e-4 }) },
  { tag: 'R-PORE', label: 'Pore radius', unit: 'nm', dec: 1, glossary: 'column.rPore_cm', min: 1, max: 500,
    get: (c) => c.column.rPore_cm * 1e7, patch: (v) => ({ rPore_cm: v * 1e-7 }) },
  { tag: 'LAMBDA', label: 'Ionic capacity', unit: 'mM', dec: 1, glossary: 'column.Lambda_mM', min: 0, max: 5000,
    get: (c) => c.column.Lambda_mM, patch: (v) => ({ Lambda_mM: v }) },
  { tag: 'PACK', label: 'Packing quality lambda', unit: '-', dec: 3, glossary: 'column.lambdaPack', min: 0, max: 20,
    get: (c) => c.column.lambdaPack, patch: (v) => ({ lambdaPack: v }) },
  { tag: 'GAMMA', label: 'Obstruction factor', unit: '-', dec: 3, glossary: 'column.gammaObstruction', min: 0, max: 2,
    get: (c) => c.column.gammaObstruction, patch: (v) => ({ gammaObstruction: v }) },
  { tag: 'KOZENY', label: 'Kozeny constant', unit: '-', dec: 0, glossary: 'column.kKozeny', min: 50, max: 500,
    get: (c) => c.column.kKozeny, patch: (v) => ({ kKozeny: v }) },
  { tag: 'P-MAX', label: 'Hardware pressure limit', unit: 'bar', dec: 2,
    glossary: 'column.hardwarePressureLimit_bar', min: 0.5, max: 100,
    get: (c) => c.column.hardwarePressureLimit_bar, patch: (v) => ({ hardwarePressureLimit_bar: v }) },
  { tag: 'R-FRIT', label: 'Frit resistance', unit: 'bar/(cm/s)', dec: 5, glossary: 'column.rFrit_bar_per_cms',
    min: 0, max: 10, get: (c) => c.column.rFrit_bar_per_cms, patch: (v) => ({ rFrit_bar_per_cms: v }) },
  { tag: 'FOUL', label: 'Fouling factor', unit: 'x', dec: 1, glossary: 'column.foulingFactor', min: 1, max: 500,
    get: (c) => c.column.foulingFactor, patch: (v) => ({ foulingFactor: v }) },
  { tag: 'CHAN', label: 'Channelling factor', unit: '0-1', dec: 2, glossary: 'column.channellingFactor',
    min: 0, max: 1, get: (c) => c.column.channellingFactor, patch: (v) => ({ channellingFactor: v }) },
  { tag: 'PC', label: 'Compression characteristic pressure', unit: 'bar', dec: 2, glossary: 'column.compression',
    min: 0.1, max: 50, get: (c) => c.column.compression.Pc_bar, patch: (v) => ({ compression: { Pc_bar: v } }) },
  { tag: 'EPS-MIN', label: 'Compression floor porosity', unit: '-', dec: 3, glossary: 'column.compression',
    min: 0.05, max: 0.6, get: (c) => c.column.compression.epsMin, patch: (v) => ({ compression: { epsMin: v } }) },
  { tag: 'NZ', label: 'Axial cells', unit: 'cell', dec: 0, glossary: 'column.nz', min: 20, max: 2000,
    get: (c) => c.column.nz, patch: (v) => ({ nz: Math.round(v) }) },
  { tag: 'NU', label: 'Courant target', unit: '-', dec: 2, glossary: 'column.nuTarget', min: 0.05, max: 1,
    get: (c) => c.column.nuTarget, patch: (v) => ({ nuTarget: v }) },
];

/** Skid fields. `patch` returns a whole-config override object for `sim.rebuild`. */
const SKID_FIELDS = [
  { tag: 'MIX V', label: 'Mixer volume', unit: 'mL', dec: 1, glossary: 'skid.mixerVolume_mL', min: 0.1, max: 5000,
    get: (c) => c.skid.mixerVolume_mL, patch: (v) => ({ skid: { mixerVolume_mL: v } }) },
  { tag: 'MIX N', label: 'Mixer stages', unit: '-', dec: 0, glossary: 'skid.mixerN', min: 1, max: 50,
    get: (c) => c.skid.mixerN, patch: (v) => ({ skid: { mixerN: Math.round(v) } }) },
  { tag: 'CHOP', label: 'Chop period', unit: 's', dec: 2, glossary: 'skid.chopPeriod_s', min: 0.1, max: 20,
    get: (c) => c.skid.chopPeriod_s, patch: (v) => ({ skid: { chopPeriod_s: v } }) },
  { tag: 'STROKE', label: 'Pump stroke', unit: 'mL', dec: 2, glossary: 'skid.Vstroke_mL', min: 0.01, max: 200,
    get: (c) => c.skid.Vstroke_mL, patch: (v) => ({ skid: { Vstroke_mL: v } }) },
  { tag: 'Q MAX', label: 'Maximum flow', unit: 'mL/min', dec: 1, glossary: 'skid.Qmax_mLs', min: 0.1, max: 100000,
    get: (c) => c.skid.Qmax_mLs * 60, patch: (v) => ({ skid: { Qmax_mLs: v / 60 } }) },
  { tag: 'RAMP', label: 'Flow ramp rate', unit: 'mL/s2', dec: 4, glossary: 'skid.rampRate_mLs2', min: 1e-4, max: 1000,
    get: (c) => c.skid.rampRate_mLs2, patch: (v) => ({ skid: { rampRate_mLs2: v } }) },
  { tag: 'Q SW', label: 'Valve-switch flow fraction', unit: 'frac', dec: 3, glossary: 'skid.QswitchMax_frac',
    min: 0, max: 1, get: (c) => c.skid.QswitchMax_frac, patch: (v) => ({ skid: { QswitchMax_frac: v } }) },
  { tag: 'UV PATH', label: 'UV path length', unit: 'mm', dec: 2, glossary: 'skid.uv.pathlength_cm',
    min: 0.01, max: 100, get: (c) => c.skid.uv.pathlength_cm * 10,
    patch: (v) => ({ skid: { uv: { pathlength_cm: v / 10 } } }) },
  { tag: 'UV STRAY', label: 'UV stray light', unit: 'frac', dec: 5, glossary: 'skid.uv.strayLight', min: 0, max: 0.2,
    get: (c) => c.skid.uv.strayLight, patch: (v) => ({ skid: { uv: { strayLight: v } } }) },
  { tag: 'UV TAU', label: 'UV filter time constant', unit: 's', dec: 2, glossary: 'skid.uv.tau_s', min: 0, max: 60,
    get: (c) => c.skid.uv.tau_s, patch: (v) => ({ skid: { uv: { tau_s: v } } }) },
  { tag: 'K CELL', label: 'Conductivity cell constant', unit: '1/cm', dec: 2, glossary: 'skid.cond.Kcell_cm1',
    min: 0.01, max: 100, get: (c) => c.skid.cond.Kcell_cm1, patch: (v) => ({ skid: { cond: { Kcell_cm1: v } } }) },
  { tag: 'PH SLP', label: 'pH electrode slope', unit: '%', dec: 1, glossary: 'skid.ph.slopePct', min: 50, max: 105,
    get: (c) => c.skid.ph.slopePct, patch: (v) => ({ skid: { ph: { slopePct: v } } }) },
  { tag: 'R DOWN', label: 'Downstream resistance', unit: 'bar/(mL/s)', dec: 5,
    glossary: 'skid.press.Rdown_bar_per_mLs', min: 0, max: 100,
    get: (c) => c.skid.press.Rdown_bar_per_mLs, patch: (v) => ({ skid: { press: { Rdown_bar_per_mLs: v } } }) },
  { tag: 'K FOUL', label: 'Filter fouling coefficient', unit: '1/mg', dec: 7, glossary: 'skid.filter.kFoul_per_mg',
    min: 0, max: 1, get: (c) => c.skid.filter.kFoul_per_mg, patch: (v) => ({ skid: { filter: { kFoul_per_mg: v } } }) },
  { tag: 'FV SW', label: 'Fraction valve switch time', unit: 's', dec: 2, glossary: 'skid.fracValve.tSwitch_s',
    min: 0.01, max: 20, get: (c) => c.skid.fracValve.tSwitch_s,
    patch: (v) => ({ skid: { fracValve: { tSwitch_s: v } } }) },
  { tag: 'AIR THR', label: 'Bubble sensor threshold', unit: 'frac', dec: 3, glossary: 'skid.bubbleSensorThreshold_frac',
    min: 0, max: 1, get: (c) => c.skid.bubbleSensorThreshold_frac,
    patch: (v) => ({ skid: { bubbleSensorThreshold_frac: v } }) },
  { tag: 'T TAU', label: 'Fluid thermal time constant', unit: 's', dec: 0, glossary: 'skid.fluidTau_s',
    min: 1, max: 100000, get: (c) => c.skid.fluidTau_s, patch: (v) => ({ skid: { fluidTau_s: v } }) },
  { tag: 'WASTE', label: 'Waste capacity', unit: 'L', dec: 1, glossary: 'skid.wasteCapacity_mL',
    min: 0.1, max: 100000, get: (c) => c.skid.wasteCapacity_mL / 1000,
    patch: (v) => ({ skid: { wasteCapacity_mL: v * 1000 } }) },
  { tag: 'T AMB', label: 'Ambient temperature', unit: 'degC', dec: 1, glossary: null, min: -10, max: 60,
    get: (c) => c.skid.ambientT_C, patch: (v) => ({ skid: { ambientT_C: v } }) },
];

/** Chemistry constants (§2.1 `config.chem`). */
const CHEM_FIELDS = [
  { tag: 'T REF', label: 'Conductivity reference temperature', unit: 'degC', dec: 1,
    glossary: 'temperature-compensation', min: 0, max: 40,
    get: (c) => c.chem.condTref_C, patch: (v) => ({ chem: { condTref_C: v } }) },
  { tag: 'ALPHA', label: 'Meter temperature coefficient', unit: '1/degC', dec: 4,
    glossary: 'temperature-compensation', min: 0, max: 0.1,
    get: (c) => c.chem.condAlphaMeter_perC, patch: (v) => ({ chem: { condAlphaMeter_perC: v } }) },
  { tag: 'NA ERR', label: 'Sodium error coefficient', unit: '-', dec: 3, glossary: 'ph', min: 0, max: 5,
    get: (c) => c.chem.sodiumErrorK, patch: (v) => ({ chem: { sodiumErrorK: v } }) },
  { tag: 'DAVIES', label: 'Davies A constant', unit: '-', dec: 3, glossary: 'davies', min: 0.1, max: 1,
    get: (c) => c.chem.daviesA, patch: (v) => ({ chem: { daviesA: v } }) },
  { tag: 'CS MIN', label: 'Modulator floor', unit: 'mM', dec: 3, glossary: 'modulator', min: 1e-6, max: 100,
    get: (c) => c.chem.CS_MIN_mM, patch: (v) => ({ chem: { CS_MIN_mM: v } }) },
];

/** Load specification (§2.1 `config.load`). */
const LOAD_FIELDS = [
  { tag: 'LOAD', label: 'Load value in the selected basis', unit: '-', dec: 3, glossary: 'load-challenge',
    min: 0, max: 1e6, get: (c) => c.load.value, patch: (v) => ({ load: { value: v } }) },
  { tag: 'TITRE T', label: 'Feed titre, total protein', unit: 'g/L', dec: 3, glossary: 'titre', min: 0, max: 500,
    get: (c) => c.load.feedTiterTotal_gL, patch: (v) => ({ load: { feedTiterTotal_gL: v } }) },
  { tag: 'TITRE P', label: 'Feed titre, product', unit: 'g/L', dec: 3, glossary: 'load.productTiter_gL',
    min: 1e-6, max: 500, get: (c) => c.load.productTiter_gL, patch: (v) => ({ load: { productTiter_gL: v } }) },
];

/**
 * Icon geometry, authored here as 16×16 stroke paths — no icon font, no network (§0).
 * `f` marks a filled path (carets), everything else is stroked with `currentColor`.
 */
const ICONS = {
  refill: ['M8 1.5v6.5', 'M5 5.5 8 8.5l3-3', 'M3 10.5v3.5h10v-3.5'],
  ack: ['M2.5 8.5 6 12l7.5-7.5'],
  recompute: ['M13.5 8a5.5 5.5 0 1 1-1.7-4', 'M13.5 1.5v3.2h-3.2'],
  reset: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M5.5 5.5l5 5', 'M10.5 5.5l-5 5'],
  search: ['M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', 'M10.4 10.4 14 14'],
  more: ['M2.5 5.5 8 11l5.5-5.5'],
  lock: ['M3.5 7h9v7h-9z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'],
  unlock: ['M3.5 7h9v7h-9z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0'],
  on: ['M8 1.5v6', 'M4.4 4.4a5 5 0 1 0 7.2 0'],
  info: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M8 7v4.5', 'M8 4.4v.9'],
  caret: { f: ['M4 6h8l-4 5z'] },
  caretRight: { f: ['M6 4v8l5-4z'] },
};

/** The scoped FT-CLASSIC sheet. Every value is a token with the §palette hex as its fallback. */
const CSS = `
.sv-root{
  --screen:#6E6E6E;--face:#C7C3BC;--face-2:#BFBBB4;--face-3:#D2CEC7;
  --bev-hi:#FFFFFF;--bev-lt:#E6E2DA;--bev-sh:#85817B;--bev-dk:#4A4744;
  --ink:#101010;--ink-2:#3A3A3A;--ink-off:#7A7A7A;
  --fld-bg:#0A0F0A;--fld-pv:#12FF4B;--fld-sp:#FFD400;--fld-out:#00E5FF;--fld-alarm:#FF3B30;
  --fld-stale:#7A8A7A;--fld-eu:#9FB39F;
  --lamp-off:#4A4744;--lamp-run:#16C60C;--lamp-warn:#FFC000;--lamp-alarm:#E81123;
  --plot-axis:#C7C3BC;--pipe-idle:#4A4744;--svc-a:#2D6FB8;
  --font-ui:system-ui,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
  --font-num:ui-monospace,Consolas,'Cascadia Mono','Courier New',monospace;
  position:relative;height:100%;overflow:auto;background:var(--screen);color:var(--ink);
  font:400 11px/1.2 var(--font-ui);padding:3px;display:flex;flex-direction:column;gap:3px;
  -webkit-font-smoothing:antialiased;
}
:root[data-theme="dark"] .sv-root{
  --screen:#2A2A2A;--face:#4A4744;--face-2:#3E3B38;--face-3:#565250;
  --bev-hi:#7A7672;--bev-lt:#605C58;--bev-sh:#2E2B29;--bev-dk:#1A1817;
  --ink:#E8E4DC;--ink-2:#B8B4AC;--ink-off:#8A8680;--plot-axis:#C7C3BC;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme]) .sv-root{
    --screen:#2A2A2A;--face:#4A4744;--face-2:#3E3B38;--face-3:#565250;
    --bev-hi:#7A7672;--bev-lt:#605C58;--bev-sh:#2E2B29;--bev-dk:#1A1817;
    --ink:#E8E4DC;--ink-2:#B8B4AC;--ink-off:#8A8680;
  }
}
.sv-root *{box-sizing:border-box;border-radius:0}
.sv-rz{box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
  inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.sv-sk{box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
  inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)}
.sv-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(268px,1fr));gap:3px;align-items:start}
.sv-logs{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:3px;align-items:stretch}
@media (max-width:1080px){.sv-logs{grid-template-columns:minmax(0,1fr)}}
.sv-panel{background:var(--face);padding:3px;display:flex;flex-direction:column;min-width:0}
.sv-hd{height:20px;flex:0 0 20px;display:flex;align-items:center;gap:4px;padding:0 4px;
  background:var(--face-2);color:var(--ink);user-select:none;
  font:700 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em}
.sv-hd__sp{flex:1 1 auto}
.sv-grp{border-top:1px solid var(--bev-sh);margin-top:2px}
.sv-grp__hd{width:100%;height:18px;display:flex;align-items:center;gap:3px;padding:0 3px;border:0;
  background:var(--face-2);color:var(--ink);cursor:pointer;text-align:left;
  font:700 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em}
.sv-grp__hd svg{width:11px;height:11px;fill:currentColor;stroke:none;flex:0 0 11px}
.sv-grp.is-closed .sv-grp__b{display:none}
.sv-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:1px 6px;padding:3px 2px}
.sv-f{display:grid;grid-template-columns:66px minmax(0,1fr);align-items:center;gap:4px;height:20px}
.sv-f--w{grid-column:1/-1;grid-template-columns:110px minmax(0,1fr)}
.sv-lb{font:700 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:none;border:0;padding:0;text-align:left}
button.sv-lb{cursor:help;text-decoration:underline dotted 1px;text-underline-offset:2px}
button.sv-lb:hover{color:var(--ink)}
.sv-box{display:flex;align-items:center;height:18px;min-width:0;padding:0 2px;background:var(--fld-bg)}
.sv-box>input{flex:1 1 auto;min-width:0;width:100%;background:transparent;border:0;padding:0;margin:0;
  text-align:right;color:var(--fld-sp);font:700 12px/1 var(--font-num);
  font-variant-numeric:tabular-nums lining-nums}
.sv-box>input:focus{outline:none}
.sv-box>input:disabled{color:var(--fld-stale)}
.sv-box>.sv-v{flex:1 1 auto;min-width:0;text-align:right;color:var(--fld-pv);
  font:700 12px/1 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sv-box>.sv-v[data-q="alarm"]{color:var(--fld-alarm)}
.sv-box>.sv-v[data-q="stale"]{color:var(--fld-stale)}
.sv-box>.sv-eu{flex:0 0 auto;padding-left:3px;color:var(--fld-eu);
  font:400 10px/1 var(--font-num);white-space:nowrap}
.sv-box:focus-within{outline:2px solid #FFD400;outline-offset:-2px}
.sv-box--bad{outline:2px solid var(--fld-alarm);outline-offset:-2px}
.sv-sel{height:18px;min-width:0;width:100%;padding:0 2px;background:var(--face-3);color:var(--ink);
  border:0;font:400 11px/1 var(--font-ui);cursor:pointer}
.sv-sel:focus-visible{outline:2px solid #FFD400;outline-offset:-2px}
.sv-sel:disabled{color:var(--ink-off);cursor:not-allowed}
.sv-btn{width:22px;height:20px;flex:0 0 22px;padding:0;border:0;background:var(--face);color:var(--ink);
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),
    inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)}
.sv-btn svg{width:12px;height:12px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;
  stroke-linecap:square;stroke-linejoin:miter;pointer-events:none}
.sv-btn:active:not(:disabled),.sv-btn[aria-pressed="true"]{
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),
    inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)}
.sv-btn:active:not(:disabled) svg,.sv-btn[aria-pressed="true"] svg{transform:translate(1px,1px)}
.sv-btn:disabled{color:var(--ink-off);cursor:not-allowed}
.sv-btn:focus-visible{outline:2px solid #FFD400;outline-offset:1px}
.sv-btn--wide{width:auto;flex:0 0 auto;padding:0 5px;gap:3px;
  font:700 10px/1 var(--font-num);letter-spacing:.04em}
.sv-bar{display:flex;align-items:center;gap:2px;height:24px;flex:0 0 24px;padding:0 3px;
  background:var(--face-2);flex-wrap:nowrap;overflow:hidden}
.sv-sep{width:2px;height:16px;flex:0 0 2px;margin:0 3px;background:var(--face);
  box-shadow:inset 1px 0 0 var(--bev-dk),inset -1px 0 0 var(--bev-hi)}
.sv-lamp{width:10px;height:10px;flex:0 0 10px;border-radius:50%;border:1px solid #2A2A2A;
  background:radial-gradient(circle at 33% 28%,rgba(255,255,255,.8) 0 1.2px,rgba(255,255,255,0) 2.2px),
    var(--lamp-off)}
.sv-lamp[data-s="run"]{background:radial-gradient(circle at 33% 28%,rgba(255,255,255,.85) 0 1.2px,
  rgba(255,255,255,0) 2.2px),var(--lamp-run)}
.sv-lamp[data-s="warn"]{background:radial-gradient(circle at 33% 28%,rgba(255,255,255,.85) 0 1.2px,
  rgba(255,255,255,0) 2.2px),var(--lamp-warn)}
.sv-lamp[data-s="alarm"]{background:radial-gradient(circle at 33% 28%,rgba(255,255,255,.85) 0 1.2px,
  rgba(255,255,255,0) 2.2px),var(--lamp-alarm)}
.sv-lamp[data-blink="1"]{animation:sv-blink 900ms steps(1,end) infinite}
@keyframes sv-blink{50%{filter:brightness(.35)}}
.sv-tw{flex:1 1 auto;min-height:0;overflow:auto;background:var(--face-3)}
.sv-tw--h{max-height:266px}
.sv-tbl{width:100%;border-collapse:collapse;font:400 11px/1 var(--font-ui);color:var(--ink)}
.sv-tbl th{height:20px;padding:0 4px;text-align:left;white-space:nowrap;background:var(--face-2);
  color:var(--ink);position:sticky;top:0;z-index:1;
  font:700 10px/1 var(--font-ui);text-transform:uppercase;letter-spacing:.04em;
  box-shadow:inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-sh)}
.sv-tbl td{height:22px;padding:0 4px;white-space:nowrap;border-bottom:1px solid var(--bev-sh);
  overflow:hidden;text-overflow:ellipsis;max-width:340px}
.sv-tbl td.num,.sv-tbl th.num{text-align:right;font-family:var(--font-num);
  font-variant-numeric:tabular-nums lining-nums}
.sv-tbl td.lamp{width:18px;padding:0 0 0 4px}
.sv-tbl td.act{width:26px;padding:0 2px}
.sv-tbl tbody tr:nth-child(2n) td{background:rgba(0,0,0,.045)}
.sv-tbl tbody tr:hover td{background:var(--face)}
.sv-tbl td[data-sev="ALARM"],.sv-tbl td[data-sev="CRITICAL"],.sv-tbl td[data-sev="FAULT"]{color:#8E1710}
.sv-tbl td[data-sev="WARN"]{color:#7A5200}
:root[data-theme="dark"] .sv-tbl td[data-sev="ALARM"],
:root[data-theme="dark"] .sv-tbl td[data-sev="CRITICAL"],
:root[data-theme="dark"] .sv-tbl td[data-sev="FAULT"]{color:#FF8A80}
:root[data-theme="dark"] .sv-tbl td[data-sev="WARN"]{color:#FFC000}
.sv-tbl input{width:76px;height:16px;padding:0 2px;border:0;background:var(--fld-bg);color:var(--fld-sp);
  text-align:right;font:700 11px/1 var(--font-num);font-variant-numeric:tabular-nums lining-nums;
  box-shadow:inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi)}
.sv-tbl input:disabled{color:var(--fld-stale)}
.sv-tbl input:focus-visible{outline:2px solid #FFD400;outline-offset:-2px}
.sv-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:1px 6px;padding:3px 2px;margin:0}
.sv-tank{display:grid;grid-template-columns:52px minmax(60px,1fr) 62px 22px;gap:4px;align-items:center;
  padding:2px 3px;border-bottom:1px solid var(--bev-sh)}
.sv-tank__id{font:700 10px/1 var(--font-num);letter-spacing:.04em;color:var(--ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sv-lvl{position:relative;height:14px;background:var(--fld-bg);overflow:hidden}
.sv-lvl>i{position:absolute;left:0;top:0;bottom:0;display:block;background:var(--svc-a)}
.sv-lvl[data-low="true"]>i{background:var(--lamp-warn)}
.sv-thumb{display:block;width:100%;background:var(--fld-bg)}
.sv-status{height:18px;display:flex;align-items:center;gap:4px;padding:0 3px;background:var(--fld-bg);
  color:var(--fld-pv);font:700 10px/1 var(--font-num);letter-spacing:.04em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sv-status[data-kind="warn"]{color:var(--fld-alarm)}
.sv-empty{display:flex;align-items:center;gap:4px;padding:3px 4px;background:var(--fld-bg);
  color:var(--fld-stale);font:700 10px/1 var(--font-num);letter-spacing:.06em}
.sv-empty[hidden]{display:none}
.sv-logs>.sv-panel{max-height:452px}
.sv-search{display:flex;align-items:center;gap:3px;height:18px;padding:0 3px;background:var(--fld-bg);min-width:120px}
.sv-search input[type="search"]{-webkit-appearance:none;appearance:none}
.sv-search svg{width:11px;height:11px;flex:0 0 11px;fill:none;stroke:var(--fld-eu);stroke-width:1.5}
.sv-search input{flex:1 1 auto;min-width:0;background:transparent;border:0;color:var(--fld-pv);
  font:400 11px/1 var(--font-num)}
.sv-search input:focus{outline:none}
.sv-search:focus-within{outline:2px solid #FFD400;outline-offset:-2px}
.sv-row{display:flex;align-items:center;gap:3px;padding:2px 3px;flex-wrap:wrap}
@media (prefers-reduced-motion:reduce){
  .sv-lamp[data-blink="1"]{animation:none}
  .sv-btn:active:not(:disabled) svg,.sv-btn[aria-pressed="true"] svg{transform:none}
}
@media (prefers-contrast:more){
  .sv-root{--bev-sh:#5A5652;--ink-2:var(--ink)}
}
`;

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/** Inject the scoped FT-CLASSIC sheet once per document. */
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

/**
 * Where a message may be cut into clauses. A `.` or `;` counts ONLY when whitespace or the end of
 * the string follows it, so the decimal point in `60000.0 mL` is not mistaken for a full stop; the
 * dashes count only when spaced, so `TK-EQ` and `ALM-DP-03` survive intact.
 * @type {RegExp}
 */
const CLAUSE_BREAK = /[.;](?=\s|$)|\s[—-]\s/;

/**
 * The SHORT clause an FT-CLASSIC row may carry: the first clause of a message, capped at `max`
 * characters. Case is left alone — this feeds a data grid, not a caption. The whole sentence
 * always goes in the row's `title`, which is the only place explanation renders on this screen.
 *
 * @param {string} message the full message
 * @param {number} [max=48] the character cap
 * @returns {string} the clause
 */
function shortClause(message, max) {
  const cap = max || 48;
  const s = String(message || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.split(CLAUSE_BREAK)[0].trim() || s;
  return cut.length <= cap ? cut : cut.slice(0, cap - 1) + '…';
}

/**
 * One inline icon.
 * @param {string} name a key of {@link ICONS}
 * @returns {SVGElement} a 16×16 `<svg>`
 */
function icon(name) {
  const spec = ICONS[name];
  const filled = spec && !Array.isArray(spec);
  const paths = filled ? spec.f : spec;
  const svg = hSvg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
  for (const d of paths || []) svg.appendChild(hSvg('path', { d }));
  return svg;
}

/**
 * A beveled icon-only button. Icon plus `title` and `aria-label` — never a word on the face.
 * @param {string} name icon key
 * @param {string} label the tooltip and accessible name
 * @param {function(Event):void} onClick click handler
 * @param {{pressed?:boolean, text?:string}} [opts] `text` adds a numeric chip (speed-chip style)
 * @returns {HTMLButtonElement} the button
 */
function iconButton(name, label, onClick, opts) {
  const o = opts || {};
  const b = h('button', {
    type: 'button', class: 'sv-btn' + (o.text ? ' sv-btn--wide' : ''), title: label,
    'aria-label': label,
  }, name ? icon(name) : null, o.text ? h('span', {}, o.text) : null);
  if (o.pressed !== undefined) setAttr(b, 'aria-pressed', o.pressed ? 'true' : 'false');
  b.addEventListener('click', onClick);
  return b;
}

/** A round glassy status lamp. */
function lamp(state, title) {
  return h('span', {
    class: 'sv-lamp', 'data-s': state || 'off', role: 'img',
    'aria-label': title || state || 'off', title: title || '',
  });
}

/** A sunken label box: right-aligned value plus a dimmer EU suffix. */
function labelBox(unit, ariaLabel) {
  const v = h('span', { class: 'sv-v' }, '—');
  const el = h('div', { class: 'sv-box sv-sk', role: 'group', 'aria-label': ariaLabel || unit || '' },
    v, unit ? h('span', { class: 'sv-eu' }, unit) : null);
  return { el, v };
}

/** A sunken entry box: right-aligned tabular input plus a dimmer EU suffix. */
function entryBox(unit, ariaLabel) {
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off',
    spellcheck: 'false', 'aria-label': ariaLabel });
  const el = h('div', { class: 'sv-box sv-sk' }, input, unit ? h('span', { class: 'sv-eu' }, unit) : null);
  return { el, input };
}

/** One overlay host per document, reused across mounts; `ui/app.js`'s own host wins if exposed. */
let sharedOverlayHost = null;

/**
 * The overlay host to float popovers and toasts from. `ui/app.js` owns one host for the whole
 * application (§6.33) but does not put it on `ctx`, so a host exposed on `ctx` wins and otherwise
 * this module creates one shared host per document.
 *
 * @param {object} ctx the §2.4 context
 * @returns {object} the overlay host
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

  /** Every registered editable control: `{ input, read, gated, boolean }`. */
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

  /**
   * The status strip shows a SHORT uppercase code; the whole sentence lives in its tooltip and in
   * the transient toast, never on the face of the screen.
   */
  function notify(code, message, kind) {
    if (dom.status) {
      setText(dom.status, code);
      setAttr(dom.status, 'title', message);
      setAttr(dom.status, 'data-kind', kind === 'warn' || kind === 'blocked' ? 'warn' : 'info');
    }
    if (dom.statusLamp) {
      setAttr(dom.statusLamp, 'data-s', kind === 'warn' || kind === 'blocked' ? 'alarm' : 'run');
      setAttr(dom.statusLamp, 'title', message);
    }
    try {
      if (overlayHost) showToast(overlayHost, { message, kind: kind || 'info', ms: 4000 });
    } catch (err) {
      // The aria-live status strip above has already carried the message.
    }
  }

  /** Open the glossary popover for `glossaryId`, anchored at `anchor` (§6.33, §9.6). */
  function openGlossary(anchor, entry) {
    try {
      if (openPopover) dismiss(openPopover);
      openPopover = showGlossaryPopover(overlayHost, {
        anchorEl: anchor, entry, placement: 'right',
        onSeeAlso: (id) => {
          const next = glossaryFor(id);
          if (!next) return;
          if (openPopover) dismiss(openPopover);
          openPopover = showGlossaryPopover(overlayHost,
            { anchorEl: anchor, entry: next, placement: 'right' });
        },
      });
    } catch (err) {
      notify('HELP', `${entry.term}: ${entry.short}`, 'info');
    }
  }

  /**
   * The 10 px tag label. With a glossary entry it becomes a help button (§6.22.1 requires an entry
   * before any info affordance renders).
   */
  function tagLabel(tag, fullLabel, glossaryId) {
    const entry = glossaryId ? glossaryFor(glossaryId) : null;
    if (!entry) return h('span', { class: 'sv-lb', title: fullLabel }, tag);
    const b = h('button', {
      type: 'button', class: 'sv-lb', title: `${fullLabel} — ${entry.short}`,
      'aria-label': `About ${entry.term}`,
    }, tag);
    b.addEventListener('click', (ev) => { ev.preventDefault(); openGlossary(b, entry); });
    return b;
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
    if (typeof fn !== 'function') {
      notify('NO PATH', 'The column cannot be reconfigured in this build.', 'blocked');
      return false;
    }
    const r = fn(ctx, patch);
    if (!r || r.ok === false) {
      notify('REFUSED', r && r.reason ? String(r.reason) : `${label} was refused.`, 'blocked');
      syncValues();
      return false;
    }
    notify('APPLIED', `${label} applied. The run was rebuilt.`, 'info');
    return true;
  }

  /**
   * Apply a whole-config override through `sim.rebuild`. `rebuild` carries no state guard, so the
   * IDLE/READY gate of §6.31 is enforced here before the call.
   */
  function applyRebuild(overrides, label) {
    if (!canEdit()) {
      notify('LOCKED', lockReason(), 'blocked');
      syncValues();
      return false;
    }
    const fn = ctx.sim && ctx.sim.rebuild;
    if (typeof fn !== 'function') {
      notify('NO PATH', 'This build cannot be reconfigured.', 'blocked');
      return false;
    }
    try {
      fn(ctx, overrides);
    } catch (err) {
      notify('REJECTED', `${label} rejected at ingest: ${(err && err.message) || String(err)}`, 'warn');
      syncValues();
      return false;
    }
    notify('APPLIED', `${label} applied. The run was rebuilt.`, 'info');
    return true;
  }

  /**
   * Register a numeric entry driven by a descriptor from one of the tables above.
   * @param {object} spec the descriptor
   * @param {'column'|'root'} scope which apply path the patch takes
   * @returns {Array<Element>} the label and the sunken entry box
   */
  function numericField(spec, scope) {
    const box = entryBox(spec.unit, `${spec.label} in ${spec.unit}`);
    const read = () => num(spec.get(ctx.config), spec.dec);
    const commit = () => {
      const v = parseFloat(box.input.value);
      const lo = spec.min !== undefined ? spec.min : -Infinity;
      const hi = spec.max !== undefined ? spec.max : Infinity;
      if (!Number.isFinite(v) || v < lo || v > hi) {
        cls(box.el, 'sv-box--bad', true);
        setAttr(box.input, 'aria-invalid', 'true');
        notify('RANGE', `${spec.label} must be between ${lo} and ${hi} ${spec.unit}.`, 'warn');
        return;
      }
      cls(box.el, 'sv-box--bad', false);
      setAttr(box.input, 'aria-invalid', null);
      if (Math.abs(v - spec.get(ctx.config)) < 1e-12) return;
      const ok = scope === 'column'
        ? applyColumn(spec.patch(v), spec.label)
        : applyRebuild(spec.patch(v), spec.label);
      if (!ok) box.input.value = read();
    };
    on(box.input, 'change', commit);
    on(box.input, 'keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { box.input.value = read(); box.input.blur(); }
    });
    controls.push({ input: box.input, read, gated: true, title: `${spec.label} (${spec.unit})` });
    return [tagLabel(spec.tag, spec.label, spec.glossary), box.el];
  }

  /** A `<select>` bound to a config value. */
  function selectField(tag, label, options, readFn, applyFn, glossaryId) {
    const sel = h('select', { class: 'sv-sel sv-sk', 'aria-label': label, title: label },
      ...options.map((o) => h('option', { value: o.value, title: o.title || o.label }, o.label)));
    on(sel, 'change', () => {
      if (!applyFn(sel.value)) sel.value = readFn();
    });
    controls.push({ input: sel, read: readFn, gated: true, title: label });
    return [tagLabel(tag, label, glossaryId), sel];
  }

  /** A boolean, rendered as a lamp button: the label sits outside, the face carries only an icon. */
  function toggleField(tag, label, readFn, applyFn, glossaryId) {
    const lp = lamp('off', label);
    const btn = h('button', {
      type: 'button', class: 'sv-btn sv-btn--wide', title: label, 'aria-label': label,
      'aria-pressed': 'false',
    }, icon('on'), lp);
    const sync = () => {
      const onNow = readFn() === 'true';
      setAttr(btn, 'aria-pressed', onNow ? 'true' : 'false');
      setAttr(lp, 'data-s', onNow ? 'run' : 'off');
    };
    btn.addEventListener('click', () => {
      applyFn(readFn() !== 'true');
      sync();
    });
    controls.push({ input: btn, read: readFn, gated: true, boolean: true, sync, title: label });
    return [tagLabel(tag, label, glossaryId), h('div', { class: 'sv-row' }, btn)];
  }

  /** Push every control's value back from the (possibly replaced) config. */
  function syncValues() {
    for (const c of controls) {
      if (c.sync) { c.sync(); continue; }
      if (document.activeElement === c.input) continue;
      const v = c.read();
      if (c.input.value !== v) c.input.value = v;
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
      setAttr(c.input, 'title', editable ? (c.title || null) : reason);
    }
    if (dom.lockLamp) {
      setAttr(dom.lockLamp, 'data-s', editable ? 'run' : 'warn');
      setAttr(dom.lockLamp, 'title', editable
        ? 'The run is IDLE or READY, so the configuration can be changed.' : reason);
    }
    if (dom.lockIcon) {
      while (dom.lockIcon.firstChild) dom.lockIcon.removeChild(dom.lockIcon.firstChild);
      dom.lockIcon.appendChild(icon(editable ? 'unlock' : 'lock'));
      setAttr(dom.lockIcon, 'title', editable
        ? 'Configuration is editable (IDLE or READY).' : reason);
      setAttr(dom.lockIcon, 'aria-label', editable ? 'Configuration editable' : 'Configuration locked');
    }
    if (dom.stateBox) setText(dom.stateBox, String(ctx.run.state));
  }

  /* ------------------------------------------------------------ group shell */

  /**
   * A collapsible group: a face-2 header carrying a caret and one or two uppercase words, and a
   * body that is display:none while closed.
   */
  function group(title, closed, ...children) {
    const car = icon('caret');
    const body = h('div', { class: 'sv-grp__b' }, ...children);
    const hd = h('button', { type: 'button', class: 'sv-grp__hd', 'aria-expanded': closed ? 'false' : 'true',
      title }, car, h('span', {}, title));
    const sec = h('section', { class: 'sv-grp' + (closed ? ' is-closed' : '') }, hd, body);
    hd.addEventListener('click', () => {
      const nowClosed = !sec.classList.contains('is-closed');
      cls(sec, 'is-closed', nowClosed);
      setAttr(hd, 'aria-expanded', nowClosed ? 'false' : 'true');
      while (car.firstChild) car.removeChild(car.firstChild);
      const next = icon(nowClosed ? 'caretRight' : 'caret');
      while (next.firstChild) car.appendChild(next.firstChild);
    });
    return sec;
  }

  /** A panel: raised face with a face-2 header strip. */
  function panel(title, ...children) {
    const hd = h('div', { class: 'sv-hd sv-rz' }, h('span', {}, title), h('span', { class: 'sv-hd__sp' }));
    const p = h('section', { class: 'sv-panel sv-rz' }, hd, ...children);
    p._hd = hd;
    return p;
  }

  /** Wrap a `[label, control]` pair into one dense `[tag][field]` row. */
  function frow(parts) {
    return h('div', { class: 'sv-f' }, parts[0], parts[1]);
  }

  /* ------------------------------------------------------------ column card */

  function buildFlowGroup() {
    const specs = [
      { key: 'Q_mLs', tag: 'FIC-101', label: 'Flow', unit: 'mL/min', dec: 2, glossary: 'flow-rate',
        to: (g) => g.Q_mLs * 60, from: (v) => ({ Q_mLs: v / 60 }) },
      { key: 'u_cmh', tag: 'U-LIN', label: 'Linear velocity', unit: 'cm/h', dec: 1, glossary: 'linear-velocity',
        to: (g) => g.u_cmh, from: (v) => ({ u_cmh: v }) },
      { key: 'RT_min', tag: 'RT', label: 'Residence time', unit: 'min', dec: 2, glossary: 'residence-time',
        to: (g) => g.RT_min, from: (v) => ({ RT_min: v }) },
      { key: 'CVh', tag: 'CV/H', label: 'Throughput', unit: 'CV/h', dec: 2, glossary: 'cv',
        to: (g) => g.CVh, from: (v) => ({ CVh: v }) },
    ];
    dom.flowInputs = {};
    const grid = h('div', { class: 'sv-form' });
    for (const s of specs) {
      const box = entryBox(s.unit, `${s.label} in ${s.unit}`);
      on(box.input, 'change', () => {
        const v = parseFloat(box.input.value);
        if (!Number.isFinite(v) || v <= 0) {
          notify('RANGE', `${s.label} must be a positive number.`, 'warn');
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
      dom.flowInputs[s.key] = { input: box.input, spec: s };
      grid.appendChild(h('div', { class: 'sv-f' }, tagLabel(s.tag, s.label, s.glossary), box.el));
    }
    return grid;
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
    const head = h('div', { class: 'sv-form' });
    const resinOptions = Object.keys(RESINS).map((id) => ({ value: id, label: RESINS[id].name || id }));
    head.appendChild(frow(selectField('RESIN', 'Resin', resinOptions,
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
      }, 'C-101')));

    const scaleOptions = Object.keys(SCALES).map((id) => ({ value: id, label: SCALES[id].name || id }));
    head.appendChild(frow(selectField('SCALE', 'Skid scale', scaleOptions,
      () => String(ctx.config.scale),
      (id) => applyRebuild({ scale: id }, `Scale ${id}`), null)));

    head.appendChild(frow(selectField('ISO', 'Isotherm mode',
      ISOTHERM_MODES.map((m) => ({ value: m, label: m })),
      () => String(ctx.config.column.isothermMode),
      (m) => applyColumn({ isothermMode: m }, `Isotherm ${m}`), 'column.isothermMode')));

    head.appendChild(frow(selectField('CHARGE', 'Resin charge sign',
      [{ value: '-1', label: 'CEX (-1)', title: 'Cation exchanger' },
        { value: '0', label: 'NON-IONIC (0)', title: 'Non-ionic medium' },
        { value: '1', label: 'AEX (+1)', title: 'Anion exchanger' }],
      () => String(ctx.config.column.resinChargeSign),
      (v) => applyColumn({ resinChargeSign: parseInt(v, 10) }, 'Resin charge sign'),
      'column.resinChargeSign')));

    head.appendChild(frow(toggleField('DONNAN', 'Donnan exclusion',
      () => String(ctx.config.column.enableDonnan === true),
      (v) => applyColumn({ enableDonnan: v }, 'Donnan exclusion'), 'column.enableDonnan')));
    head.appendChild(frow(toggleField('VISC', 'Protein viscosity',
      () => String(ctx.config.column.enableProteinViscosity === true),
      (v) => applyColumn({ enableProteinViscosity: v }, 'Protein viscosity'),
      'column.enableProteinViscosity')));
    head.appendChild(frow(toggleField('COMPR', 'Bed compression',
      () => String(ctx.config.column.compression.enabled === true),
      (v) => applyColumn({ compression: { enabled: v } }, 'Bed compression'), 'bed-compression')));

    const fields = h('div', { class: 'sv-form' });
    for (const spec of COLUMN_FIELDS) {
      const row = h('div', { class: 'sv-f' }, ...numericField(spec, 'column'));
      fields.appendChild(row);
    }

    dom.columnDerived = h('div', { class: 'sv-kv' });
    dom.speciesBody = h('tbody', {});
    const recompute = iconButton('recompute', 'Recompute the transport summary at the calculator flow',
      () => { refreshSpecies(); notify('RECALC', 'Transport summary recomputed at the calculator flow.', 'info'); });

    return panel('C-101 COLUMN',
      head,
      group('GEOMETRY', false, fields),
      group('FLOW CALC', true, buildFlowGroup()),
      group('DERIVED', true, dom.columnDerived,
        h('div', { class: 'sv-row' }, recompute),
        h('div', { class: 'sv-tw sv-sk sv-tw--h' },
          h('table', { class: 'sv-tbl' },
            h('thead', {}, h('tr', {},
              h('th', { scope: 'col' }, 'SPECIES'),
              h('th', { class: 'num', scope: 'col', title: 'Total transport factor' }, 'K_T'),
              h('th', { class: 'num', scope: 'col', title: 'Retention factor' }, "K'"),
              h('th', { class: 'num', scope: 'col', title: 'Overall mass transfer coefficient, 1/s' }, 'K_OV'),
              h('th', { class: 'num', scope: 'col', title: 'Plate height, cm' }, 'HETP'),
              h('th', { class: 'num', scope: 'col', title: 'Plate number' }, 'N'),
              h('th', { class: 'num', scope: 'col', title: 'Retention volume, CV' }, 'V_R'))),
            dom.speciesBody))));
  }

  /** A read-only [tag][box][EU] row inside a `.sv-kv` grid. */
  function kvRow(tag, unit, title) {
    const box = labelBox(unit, title || tag);
    const row = h('div', { class: 'sv-f' }, h('span', { class: 'sv-lb', title: title || tag }, tag), box.el);
    return { row, v: box.v };
  }

  function renderKV(host, rows) {
    // rows: [tag, value, unit, title]
    reconcileList(host, rows.map((r, i) => ({ key: `${r[0]}|${i}`, r })), (o) => o.key,
      (o) => {
        const kv = kvRow(o.r[0], o.r[2], o.r[3]);
        kv.row._v = kv.v;
        return kv.row;
      },
      (el, o) => {
        setText(el._v, o.r[1]);
        setAttr(el, 'title', o.r[3] || o.r[0]);
      });
  }

  function renderColumnDerived() {
    const { config, run } = ctx;
    const c = config.column;
    const rows = [
      ['AREA', num(c.A_cm2, 3), 'cm2', 'Cross-sectional area'],
      ['CV', fmtVolume(c.V_mL, config), '', 'Column volume, 1 CV'],
      ['V-BEAD', num(c.Vbead_mL, 1), 'mL', 'Bead volume'],
      ['EPS-T', num(c.epsT, 4), '-', 'Total porosity'],
      ['PHI', num(c.phi, 4), '-', 'Phase ratio'],
      ['LAMBDA', num(c.Lambda_mM * (1 - c.epsC) / 1000, 4), 'mmol/mL', 'Ionic capacity per mL of bed'],
      ['EPS', num(run.epsCompressed, 4), '-',
        `Compressed interstitial porosity${run.bedCollapsed ? ' — BED COLLAPSED' : ''}`],
      ['DP-BED', fmtPressure(run.dPbed_bar), '', 'Bed pressure drop'],
    ];
    if (run.col) {
      const d = describeColumn(run.col);
      rows.push(['V0', num(d.V0_mL, 1), 'mL', 'Void volume']);
      rows.push(['V-PORE', num(d.Vpore_mL, 1), 'mL', 'Pore volume']);
      rows.push(['VT', num(d.Vt_mL, 1), 'mL', 'Total liquid volume']);
      rows.push(['DZ', num(d.dz_cm, 5), 'cm', 'Axial cell height']);
      rows.push(['T0', Number.isFinite(d.t0_s) ? fmtTime(d.t0_s) : '—', '', 'Interstitial transit time']);
      rows.push(['T-RES', Number.isFinite(d.tResLiquid_s) ? fmtTime(d.tResLiquid_s) : '—', '',
        'Liquid residence time']);
    }
    renderKV(dom.columnDerived, rows);
  }

  /**
   * Refresh the per-species transport summary at the flow calculator's operating point.
   * `describeSpecies` forces a coefficient refresh on `run.col` (its own documented behaviour;
   * `stepColumn` refreshes again on its next call), so it is called on demand only — never per
   * frame and never while the answer is not being looked at.
   */
  function refreshSpecies() {
    const { run } = ctx;
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
    const head = h('div', { class: 'sv-form' });
    head.appendChild(frow(selectField('GRAD', 'Gradient mode',
      [{ value: 'LPGF', label: 'LPGF', title: 'Low-pressure proportioning valve' },
        { value: 'HPGF', label: 'HPGF', title: 'Two metering pumps' }],
      () => String(ctx.config.skid.gradientMode),
      (v) => applyRebuild({ skid: { gradientMode: v } }, `Gradient mode ${v}`),
      'skid.gradientMode')));
    head.appendChild(frow(toggleField('AT-101', 'Air trap fitted',
      () => String(ctx.config.skid.airTrap === true),
      (v) => applyRebuild({ skid: { airTrap: v } }, 'Air trap'), 'AT-101')));
    head.appendChild(frow(toggleField('F-101', 'Inline filter fitted',
      () => String(ctx.config.skid.inlineFilter === true),
      (v) => applyRebuild({ skid: { inlineFilter: v } }, 'Inline filter'), 'F-101')));

    const fields = h('div', { class: 'sv-form' });
    for (const spec of SKID_FIELDS) {
      fields.appendChild(h('div', { class: 'sv-f' }, ...numericField(spec, 'root')));
    }

    dom.holdup = h('div', { class: 'sv-kv' });

    return panel('SKID',
      head,
      group('PARAMETERS', false, fields),
      group('HOLD-UP', true, dom.holdup));
  }

  function renderHoldup() {
    const hu = ctx.config.skid.holdup || {};
    renderKV(dom.holdup, [
      ['V-SUCT', num(hu.Vsuction_mL, 2), 'mL', 'Suction side hold-up'],
      ['V-GRAD', num(hu.Vgrad_mL, 2), 'mL', 'Gradient path hold-up'],
      ['V-C-UV', num(hu.VcolOutToUV_mL, 2), 'mL', 'Column outlet to UV cell'],
      ['V-UV-C', num(hu.VuvToCond_mL, 2), 'mL', 'UV cell to conductivity cell'],
      ['V-C-PH', num(hu.VcondToPh_mL, 2), 'mL', 'Conductivity cell to pH electrode'],
      ['V-PH-F', num(hu.VphToFracValve_mL, 2), 'mL', 'pH electrode to fraction valve'],
      ['V-UV-F', num(hu.VuvToFracValve_mL, 2), 'mL', 'UV cell to fraction valve'],
      ['V-DEAD', num(hu.VfracDeadLeg_mL, 2), 'mL', 'Fraction valve dead leg'],
      ['V-SMPL', num(hu.VsampleLine_mL, 2), 'mL', 'Sample line hold-up'],
      ['SIG-G', num(hu.sigmaGrad_mL, 2), 'mL', 'Gradient dispersion sigma'],
      ['N-EFF', num(hu.NeffGrad, 3), '-', 'Effective gradient mixer stages'],
      ['SIG-IU', num(hu.sigmaInjToUV_mL, 3), 'mL', 'Extra-column sigma, injection to UV'],
    ]);
  }

  /* ------------------------------------------------------------ fluids card */

  function buildFluidsCard() {
    const chemFields = h('div', { class: 'sv-form' });
    for (const spec of CHEM_FIELDS) {
      chemFields.appendChild(h('div', { class: 'sv-f' }, ...numericField(spec, 'root')));
    }

    const loadFields = h('div', { class: 'sv-form' });
    loadFields.appendChild(frow(selectField('BASIS', 'Load basis',
      [{ value: 'MG_PER_ML_RESIN', label: 'mg/mL RESIN' },
        { value: 'G_TOTAL', label: 'g TOTAL' },
        { value: 'CV', label: 'CV' },
        { value: 'ML', label: 'mL' }],
      () => String(ctx.config.load.basis),
      (v) => applyRebuild({ load: { basis: v } }, `Load basis ${v}`), 'load-challenge')));
    for (const spec of LOAD_FIELDS) {
      loadFields.appendChild(h('div', { class: 'sv-f' }, ...numericField(spec, 'root')));
    }

    dom.loadDerived = h('div', { class: 'sv-kv' });
    dom.tanks = h('div', {});
    dom.speciesEditBody = h('tbody', {});
    dom.speciesEditHead = h('tr', {});

    return panel('TK / CHEM',
      dom.tanks,
      group('LOAD', true, loadFields, dom.loadDerived),
      group('CHEMISTRY', true, chemFields),
      group('SPECIES', true,
        h('div', { class: 'sv-tw sv-sk sv-tw--h' },
          h('table', { class: 'sv-tbl' }, h('thead', {}, dom.speciesEditHead), dom.speciesEditBody))));
  }

  function renderTanks() {
    const { config, run } = ctx;
    const items = config.tanks.map((t, i) => ({ key: t.id, t, i }));
    reconcileList(dom.tanks, items, (r) => r.key,
      (r) => {
        const id = h('div', { class: 'sv-tank__id' }, r.t.id);
        const bar = h('div', { class: 'sv-lvl sv-sk', role: 'img', 'aria-label': `${r.t.id} level` },
          h('i', {}));
        const box = labelBox('L', `${r.t.id} volume`);
        const refill = iconButton('refill', `Refill ${r.t.id} to nominal`, () => {
          const fn = ctx.sim && ctx.sim.refillTank;
          if (typeof fn !== 'function') return;
          const res = fn(ctx, r.t.id, r.t.nominalVolume_mL);
          if (!res || res.ok === false) {
            notify('REFUSED', res && res.reason ? String(res.reason)
              : `${r.t.id} could not be refilled.`, 'blocked');
          } else {
            notify('REFILL OK', `${r.t.id} refilled to ${num(r.t.nominalVolume_mL / 1000, 1)} L.`, 'info');
          }
        });
        const el = h('div', { class: 'sv-tank' }, id, bar, box.el, refill);
        el._parts = { id, bar: bar.firstChild, barEl: bar, v: box.v };
        return el;
      },
      (el, r) => {
        const p = el._parts;
        const t = r.t;
        const level = run.tankVolume_mL ? run.tankVolume_mL[r.i] : t.startVolume_mL;
        const frac = t.nominalVolume_mL > 0 ? level / t.nominalVolume_mL : 0;
        const d = t.derived || {};
        setText(p.v, num(level / 1000, 2));
        p.bar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
        setAttr(p.barEl, 'data-low', frac * 100 <= t.lowLevelPct ? 'true' : 'false');
        setAttr(el, 'title', `${t.id} ${t.label} · port ${t.port}` +
          `${t.isSample ? ' · sample' : ''} · ${num(level / 1000, 2)} of ` +
          `${num(t.nominalVolume_mL / 1000, 2)} L (${num(frac * 100, 0)} %) · ` +
          `pH ${fmtPH(d.pH)} · ${fmtCond(d.kappa25_mScm)} at 25 °C · I ${num(d.I_molL, 4)} M · ` +
          `Na ${num(d.Na_mM, 1)} mM · Cl ${num(d.Cl_mM, 1)} mM`);
      });
  }

  function renderLoadDerived() {
    const { config } = ctx;
    const d = config.load.derived || {};
    renderKV(dom.loadDerived, [
      ['PROD', String(config.load.productSpeciesId), '', 'Product species id'],
      ['MASS', num(d.mass_g, 3), 'g', 'Load mass'],
      ['VOL', num(d.volume_mL, 1), 'mL', 'Load volume'],
      ['CHALL', num(d.CV, 4), 'CV', 'Load challenge'],
      ['FILT', num(d.volume_mL * config.load.feedTiterTotal_gL, 0), 'mg',
        'Total protein presented to the inline filter'],
    ]);
  }

  /** The isotherm parameters the current mode actually reads (§5.8.1). */
  function isothermParams(mode) {
    if (mode === 'SMA') {
      return [{ key: 'nu', label: 'NU', title: 'Characteristic charge', dec: 3 },
        { key: 'sigma', label: 'SIGMA', title: 'Steric factor', dec: 1 },
        { key: 'Keq', label: 'K_EQ', title: 'Equilibrium constant', dec: 5 }];
    }
    if (mode === 'LANGMUIR' || mode === 'HIC') {
      return [{ key: 'qmax_mM', label: 'Q_MAX', title: 'Saturation capacity, mM', dec: 3 },
        { key: 'b0_mM1', label: 'B0', title: 'Affinity at zero modulator, 1/mM', dec: 6 },
        { key: 'beta_mM1', label: 'BETA', title: 'Modulator sensitivity, 1/mM', dec: 5 },
        { key: 'csRef_mM', label: 'CS_REF', title: 'Reference modulator concentration, mM', dec: 1 }];
    }
    if (mode === 'LINEAR') return [{ key: 'Klin', label: 'K_LIN', title: 'Linear partition coefficient', dec: 4 }];
    return [];
  }

  function renderSpeciesEditor() {
    const { config } = ctx;
    const params = isothermParams(config.column.isothermMode);
    const cols = [{ key: 'epsPi', label: 'EPS_P,I', title: 'Accessible pore porosity', dec: 3 },
      { key: 'keffScale', label: 'K_EFF', title: 'Mass transfer scaling factor', dec: 3 }].concat(params);

    while (dom.speciesEditHead.firstChild) {
      dom.speciesEditHead.removeChild(dom.speciesEditHead.firstChild);
    }
    dom.speciesEditHead.appendChild(h('th', { scope: 'col' }, 'SPECIES'));
    dom.speciesEditHead.appendChild(h('th', { scope: 'col' }, 'ROLE'));
    dom.speciesEditHead.appendChild(h('th', { class: 'num', scope: 'col', title: 'Molecular weight, kDa' }, 'MW'));
    for (const c of cols) {
      dom.speciesEditHead.appendChild(h('th', { class: 'num', scope: 'col', title: c.title }, c.label));
    }

    // The column set depends on the isotherm mode, so it is part of the row identity: a mode change
    // must rebuild the rows, not reuse cells that no longer mean the same parameter.
    const colKey = cols.map((c) => c.key).join(',');
    const items = config.species.map((s, i) => ({ key: `${s.id}|${colKey}`, s, i, cols }));
    reconcileList(dom.speciesEditBody, items, (r) => r.key,
      (r) => {
        const tr = h('tr', {}, h('td', {}, ''), h('td', {}, ''), h('td', { class: 'num' }, ''));
        tr._inputs = {};
        for (const c of r.cols) {
          const input = h('input', {
            type: 'text', inputmode: 'decimal', 'aria-label': `${r.s.id} ${c.title}`, title: c.title,
          });
          const commit = () => {
            const v = parseFloat(input.value);
            if (!Number.isFinite(v)) {
              notify('RANGE', `${r.s.id} ${c.title} must be a number.`, 'warn');
              input.value = num(ctx.config.species[r.i][c.key], c.dec);
              return;
            }
            const patch = {};
            patch[c.key] = v;
            const ok = applyRebuild({ speciesOverrides: { [r.s.id]: patch } }, `${r.s.id} ${c.label}`);
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
          setAttr(input, 'title', editable ? c.title : lockReason());
        }
      });
  }

  /* --------------------------------------------------------- thumbnail card */

  function buildThumbCard() {
    dom.thumb = h('canvas', { class: 'sv-thumb sv-sk', role: 'img',
      'aria-label': 'Scale drawing of the configured column' });
    dom.lockLamp = lamp('run', 'Configuration editable');
    dom.lockIcon = h('span', { class: 'sv-btn', role: 'img', 'aria-label': 'Configuration editable' },
      icon('unlock'));
    dom.stateBox = h('span', { class: 'sv-v' }, '—');
    dom.statusLamp = lamp('off', '');
    dom.status = h('div', { class: 'sv-status sv-sk', role: 'status', 'aria-live': 'polite' }, '');
    dom.unitBox = h('div', { class: 'sv-kv' });

    return panel('UNIT',
      h('div', { class: 'sv-row' },
        dom.lockLamp, dom.lockIcon,
        h('div', { class: 'sv-box sv-sk', style: 'min-width:88px', role: 'group',
          'aria-label': 'Run state' }, dom.stateBox),
        h('span', { class: 'sv-sep' }), dom.statusLamp),
      dom.status,
      dom.thumb,
      dom.unitBox);
  }

  /** Resolve the canvas colours from the live custom properties (a canvas cannot use `var()`). */
  function readTokens() {
    const out = {};
    try {
      const cs = getComputedStyle(dom.thumb || el);
      for (const n of TOKEN_NAMES) out[n] = (cs.getPropertyValue(n) || '').trim();
    } catch (err) {
      // Literal fallbacks below cover a missing computed style.
    }
    return out;
  }

  function tok(name, fallback) {
    const v = tokens ? tokens[name] : '';
    return v || fallback;
  }

  /** Draw the column to scale, with beveled adapters and the live compression state. */
  function drawThumb() {
    const canvas = dom.thumb;
    if (!canvas) return;
    const { config, run } = ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(160, Math.round(canvas.clientWidth || 196));
    const H = 220;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.height = `${H}px`;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    if (!tokens) tokens = readTokens();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = tok('--fld-bg', '#0A0F0A');
    g.fillRect(0, 0, W, H);

    const c = config.column;
    const aspect = c.id_cm / Math.max(c.L_cm, 1e-6);
    const maxH = H - 54;
    const maxW = W - 78;
    let colH = maxH;
    let colW = colH * aspect;
    if (colW > maxW) { colW = maxW; colH = colW / Math.max(aspect, 1e-6); }
    const x = Math.round((W - colW) / 2);
    const y = 26;

    // Tube: a sunken glass column on the black field.
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(x, y, colW, colH);
    g.lineWidth = 1;
    g.strokeStyle = tok('--plot-axis', '#C7C3BC');
    g.strokeRect(x + 0.5, y + 0.5, colW - 1, colH - 1);

    // Bed, shortened by the compression offset.
    const eps0 = c.compression.eps0 || c.epsC;
    const shrink = eps0 > 0 ? Math.max(0, 1 - (1 - run.epsCompressed) / (1 - eps0)) : 0;
    const bedTop = y + Math.min(colH * 0.25, colH * shrink);
    g.fillStyle = run.bedCollapsed ? '#8A5BC8' : '#6E6E6E';
    g.globalAlpha = 0.55;
    g.fillRect(x + 2, bedTop, colW - 4, y + colH - bedTop - 2);
    g.globalAlpha = 1;

    // Adapters, drawn with the same bevel language as the chrome.
    const adapter = (ay) => {
      g.fillStyle = tok('--face', '#C7C3BC');
      g.fillRect(x - 5, ay, colW + 10, 7);
      g.fillStyle = tok('--bev-hi', '#FFFFFF');
      g.fillRect(x - 5, ay, colW + 10, 1);
      g.fillStyle = tok('--bev-dk', '#4A4744');
      g.fillRect(x - 5, ay + 6, colW + 10, 1);
    };
    adapter(y - 8);
    adapter(y + colH + 1);

    // Dimension tags — labels and numbers, never a sentence.
    g.fillStyle = tok('--fld-eu', '#9FB39F');
    g.font = '10px ' + (tok('--font-num', 'Consolas, monospace'));
    g.textAlign = 'center';
    g.fillText(`ID ${c.id_cm.toFixed(2)} cm`, W / 2, y - 13);
    g.save();
    g.translate(x - 16, y + colH / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(`L ${c.L_cm.toFixed(2)} cm`, 0, 0);
    g.restore();
    g.fillStyle = tok('--fld-pv', '#12FF4B');
    g.fillText(`CV ${c.V_mL.toFixed(1)} mL`, W / 2, y + colH + 24);

    setAttr(canvas, 'title', `${config.name} · ${config.scale} · ` +
      `${config.column.resinId || 'custom resin'} · seed ${config.seed}`);
    renderKV(dom.unitBox, [
      ['UNIT', String(config.name), '', 'Configured unit name'],
      ['SCALE', String(config.scale), '', 'Skid scale'],
      ['SEED', String(config.seed), '-', 'Deterministic seed'],
      ['EPS', num(run.epsCompressed, 4), '-',
        `Compressed porosity${run.bedCollapsed ? ' — BED COLLAPSED' : ''}`],
    ]);
  }

  /* ------------------------------------------------------------ alarm table */

  const ALARM_COLUMNS = [
    { t: '', cls: 'lamp', title: 'Alarm state lamp' },
    { t: 'TAG', title: 'Alarm identifier and name' },
    { t: 'SIGNAL', title: 'Evaluated signal' },
    { t: 'OP', title: 'Comparison operator' },
    { t: 'LIMIT', cls: 'num', title: 'Threshold, in the signal unit' },
    { t: 'DLY', cls: 'num', title: 'Persistence before the alarm raises, s' },
    { t: 'SEV', title: 'Severity' },
    { t: 'ACTION', title: 'Automatic action on raise' },
    { t: 'STATE', title: 'Active / latched / acknowledged' },
    { t: '', cls: 'act', title: 'Acknowledge' },
  ];

  function buildAlarmPanel() {
    dom.alarmBody = h('tbody', {});
    dom.alarmLamp = lamp('off', 'Worst active alarm severity');
    dom.alarmCount = h('span', { class: 'sv-v' }, '0');
    const p = panel('ALARM LIMITS',
      h('div', { class: 'sv-tw sv-sk' },
        h('table', { class: 'sv-tbl' },
          h('thead', {}, h('tr', {}, ...ALARM_COLUMNS.map((c) => h('th',
            { class: c.cls === 'num' ? 'num' : '', scope: 'col', title: c.title }, c.t)))),
          dom.alarmBody)));
    p._hd.appendChild(dom.alarmLamp);
    p._hd.appendChild(h('div', { class: 'sv-box sv-sk', style: 'width:52px', role: 'group',
      'aria-label': 'Active alarm count' }, dom.alarmCount, h('span', { class: 'sv-eu' }, 'ACT')));
    return p;
  }

  function renderAlarmTable(structural) {
    const { config, run } = ctx;
    const rows = config.alarms.map((a, i) => ({ key: a.id, a, i }));

    if (structural) {
      reconcileList(dom.alarmBody, rows, (r) => r.key,
        (r) => {
          const lp = lamp('off', `${r.a.id} state`);
          const tr = h('tr', {}, h('td', { class: 'lamp' }, lp), h('td', {}, ''), h('td', {}, ''),
            h('td', {}, ''));
          const limitCell = h('td', { class: 'num' });
          let input = null;
          if (r.a.threshold !== null && r.a.threshold !== undefined) {
            input = h('input', {
              type: 'text', inputmode: 'decimal', 'aria-label': `${r.a.id} limit`,
              title: `${r.a.id} limit`,
            });
            const commit = () => {
              const v = parseFloat(input.value);
              if (!Number.isFinite(v)) {
                notify('RANGE', `${r.a.id} limit must be a number.`, 'warn');
                input.value = num(ctx.config.alarms[r.i].threshold, 3);
                return;
              }
              const ok = applyRebuild({ alarmThresholdOverrides: { [r.a.id]: v } }, `${r.a.id} limit`);
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
          const state = h('td', {}, '');
          const ackCell = h('td', { class: 'act' });
          const ack = iconButton('ack', `Acknowledge ${r.a.id}`, () => {
            const fn = ctx.sim && ctx.sim.acknowledgeAlarm;
            if (typeof fn !== 'function') return;
            const res = fn(ctx, r.a.id);
            if (!res || res.ok === false) {
              notify('REFUSED', res && res.reason ? String(res.reason)
                : `${r.a.id} could not be acknowledged.`, 'blocked');
            } else {
              notify('ACK', `${r.a.id} acknowledged.`, 'info');
            }
          });
          ackCell.appendChild(ack);
          tr.appendChild(limitCell);
          tr.appendChild(persist);
          tr.appendChild(sev);
          tr.appendChild(action);
          tr.appendChild(state);
          tr.appendChild(ackCell);
          tr._parts = { input, lamp: lp, state, ack };
          return tr;
        },
        (tr, r) => {
          const a = ctx.config.alarms[r.i] || r.a;
          const c = tr.children;
          setText(c[1], a.id);
          setText(c[2], a.signal || (a.evalKey ? `${a.evalKey}()` : '—'));
          setText(c[3], a.op || '—');
          setText(c[5], num(a.persist_s, 1));
          setText(c[6], a.severity);
          setText(c[7], a.action);
          setAttr(c[6], 'data-sev', a.severity);
          const p = tr._parts;
          if (p.input && document.activeElement !== p.input) {
            p.input.value = num(a.threshold, 3);
            p.input.disabled = !canEdit();
            setAttr(p.input, 'title', canEdit() ? `${a.id} limit` : lockReason());
          }
          setAttr(tr, 'title', `${a.id} — ${a.name} · ${a.latching ? 'latching' : 'non-latching'}` +
            `${a.suppressWhen && a.suppressWhen.length
              ? ` · suppressed by ${a.suppressWhen.join(', ')}` : ''}`);
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
      const label = isActive ? (acked ? 'ACT·ACK' : 'ACTIVE')
        : (latched ? (acked ? 'LTC·ACK' : 'LATCHED') : 'CLEAR');
      setText(parts.state, label);
      const sev = config.alarms[i].severity;
      const lampState = isActive ? (SEV_LAMP[sev] || 'alarm') : (latched ? 'warn' : 'off');
      setAttr(parts.lamp, 'data-s', lampState);
      setAttr(parts.lamp, 'data-blink', isActive && !acked ? '1' : '0');
      setAttr(parts.lamp, 'title', `${config.alarms[i].id} ${label} · ${sev}`);
      parts.ack.disabled = !(isActive || latched) || acked;
      if (isActive || latched) {
        active++;
        const rank = SEVERITIES.indexOf(sev);
        if (rank > worst) worst = rank;
      }
    }
    setText(dom.alarmCount, String(active));
    setAttr(dom.alarmLamp, 'data-s', active === 0 ? 'run'
      : (worst >= SEVERITIES.indexOf('ALARM') ? 'alarm' : 'warn'));
    setAttr(dom.alarmLamp, 'title', active === 0 ? 'No alarm active or latched'
      : `${active} active or latched · worst ${SEVERITIES[worst] || 'INFO'}`);
  }

  /* -------------------------------------------------------------- event log */

  const LOG_COLUMNS = [
    { t: '', cls: 'lamp', title: 'Severity lamp' },
    { t: 'T', cls: 'num', title: 'Run time, s' },
    { t: 'CV', cls: 'num', title: 'Run volume, column volumes' },
    { t: 'TYPE', title: 'Event type' },
    { t: 'SRC', title: 'Event source' },
    { t: 'MESSAGE', title: 'Event message, first clause; the whole message and the detail record '
      + 'are in the row tooltip' },
    { t: '', cls: 'act', title: 'Acknowledge' },
  ];

  function buildLogPanel() {
    const sevSel = h('select', { class: 'sv-sel sv-sk', 'aria-label': 'Filter by severity',
      title: 'Filter by severity', style: 'width:84px' },
    h('option', { value: 'ALL' }, 'SEV ALL'), ...SEVERITIES.map((s) => h('option', { value: s }, s)));
    on(sevSel, 'change', () => { logFilter.severity = sevSel.value; renderLog(true); });

    const srcSel = h('select', { class: 'sv-sel sv-sk', 'aria-label': 'Filter by source',
      title: 'Filter by source', style: 'width:112px' },
    h('option', { value: 'ALL' }, 'SRC ALL'), ...SOURCES.map((s) => h('option', { value: s }, s)));
    on(srcSel, 'change', () => { logFilter.source = srcSel.value; renderLog(true); });

    dom.typeSel = h('select', { class: 'sv-sel sv-sk', 'aria-label': 'Filter by event type',
      title: 'Filter by event type', style: 'width:132px' }, h('option', { value: 'ALL' }, 'TYPE ALL'));
    on(dom.typeSel, 'change', () => { logFilter.type = dom.typeSel.value; renderLog(true); });

    const search = h('input', { type: 'search', 'aria-label': 'Search event messages' });
    on(search, 'input', () => { logFilter.text = search.value.trim().toLowerCase(); renderLog(true); });
    const searchBox = h('div', { class: 'sv-search sv-sk', title: 'Search event messages' },
      icon('search'), search);

    dom.logMore = iconButton('more', 'Show the next page of events', () => {
      logLimit += LOG_PAGE;
      renderLog(true);
    });
    const clear = iconButton('reset', 'Reset every log filter', () => {
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
    dom.logShown = h('span', { class: 'sv-v' }, '0');
    dom.logTotal = h('span', { class: 'sv-v' }, '0');
    dom.logEmpty = h('div', { class: 'sv-empty' }, lamp('off', 'No events logged'), 'NO EVENTS');

    const p = panel('EVENT LOG',
      h('div', { class: 'sv-bar sv-rz' }, sevSel, srcSel, dom.typeSel,
        h('span', { class: 'sv-sep' }), searchBox,
        h('span', { class: 'sv-sep' }), dom.logMore, clear),
      h('div', { class: 'sv-tw sv-sk' },
        h('table', { class: 'sv-tbl' },
          h('thead', {}, h('tr', {}, ...LOG_COLUMNS.map((c) => h('th',
            { class: c.cls === 'num' ? 'num' : '', scope: 'col', title: c.title }, c.t)))),
          dom.logBody)),
      dom.logEmpty);
    p._hd.appendChild(h('div', { class: 'sv-box sv-sk', style: 'width:66px', role: 'group',
      'aria-label': 'Events shown' }, dom.logShown, h('span', { class: 'sv-eu' }, 'SHOWN')));
    p._hd.appendChild(h('div', { class: 'sv-box sv-sk', style: 'width:66px', role: 'group',
      'aria-label': 'Events total' }, dom.logTotal, h('span', { class: 'sv-eu' }, 'TOT')));
    return p;
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
      dom.typeSel.appendChild(h('option', { value: v }, v === 'ALL' ? 'TYPE ALL' : v));
    }
    dom.typeSel.value = wanted.indexOf(current) >= 0 ? current : 'ALL';
  }

  function renderLog(force) {
    const { run } = ctx;
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

    setText(dom.logShown, String(rows.length));
    setText(dom.logTotal, String(events.length));
    dom.logEmpty.hidden = events.length > 0;
    dom.logMore.disabled = rows.length < logLimit;

    reconcileList(dom.logBody, rows, (r) => r.key,
      (r) => {
        const lp = lamp('off', 'severity');
        const tr = h('tr', {},
          h('td', { class: 'lamp' }, lp),
          h('td', { class: 'num' }, ''), h('td', { class: 'num' }, ''),
          h('td', {}, ''), h('td', {}, ''), h('td', {}, ''));
        const ackCell = h('td', { class: 'act' });
        const ack = iconButton('ack', 'Acknowledge this alarm', () => {
          const idx = r.alarmIdx;
          if (idx < 0) return;
          const fn = ctx.sim && ctx.sim.acknowledgeAlarm;
          if (typeof fn !== 'function') return;
          const res = fn(ctx, ctx.config.alarms[idx].id);
          if (!res || res.ok === false) {
            notify('REFUSED', res && res.reason ? String(res.reason) : 'Acknowledge refused.', 'blocked');
          } else {
            notify('ACK', `${ctx.config.alarms[idx].id} acknowledged.`, 'info');
          }
        });
        ackCell.appendChild(ack);
        tr.appendChild(ackCell);
        tr._ack = ack;
        tr._lamp = lp;
        return tr;
      },
      (tr, r) => {
        const e = r.e;
        const c = tr.children;
        setAttr(tr._lamp, 'data-s', SEV_LAMP[e.severity] || 'off');
        setAttr(tr._lamp, 'title', `${e.severity} · ${e.type}`);
        setText(c[1], num(e.t_s, 1));
        setText(c[2], num(e.V_CV, 3));
        setText(c[3], e.type);
        setText(c[4], e.source);
        // A SHORT clause on the glass; the whole message leads the tooltip. Before this the full
        // sentence was the only copy and CSS silently clipped it, so a long message was unreadable.
        const blockSuffix = e.blockId ? ` [${e.blockId}]` : '';
        setText(c[5], shortClause(e.message) + blockSuffix);
        setAttr(c[5], 'data-sev', e.severity);
        let title = `${e.message}${blockSuffix} · ${e.severity} · ${e.type} · ${e.source}`;
        if (e.detail) {
          try {
            title += ` · ${JSON.stringify(e.detail)}`;
          } catch (err) {
            title += ' · [detail not serialisable]';
          }
        }
        setAttr(c[5], 'title', title);
        const idx = r.alarmIdx;
        const shown = idx >= 0 &&
          (ctx.run.alarmActive[idx] === 1 || ctx.run.alarmLatched[idx] === 1);
        tr._ack.hidden = !shown;
        tr._ack.disabled = !shown || ctx.run.alarmAcked[idx] === 1;
        setAttr(tr._ack, 'title', shown && ctx.run.alarmAcked[idx] === 1
          ? 'Already acknowledged' : 'Acknowledge this alarm');
      });
  }

  /* ------------------------------------------------------------ build tree */

  const el = h('div', { class: 'sv-root' });
  const columnCard = buildColumnCard();
  const skidCard = buildSkidCard();
  const fluidsCard = buildFluidsCard();
  const thumbCard = buildThumbCard();
  const logPanel = buildLogPanel();
  const alarmPanel = buildAlarmPanel();

  el.appendChild(h('div', { class: 'sv-cols' }, columnCard, skidCard, fluidsCard, thumbCard));
  el.appendChild(h('div', { class: 'sv-logs' }, alarmPanel, logPanel));

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
      overlayHost = null;   // popovers and toasts degrade to the inline status strip
    }
    tokens = readTokens();

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
      tokens = readTokens();
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
