/**
 * @file src/ui/pid.js — the animated process schematic (P&ID), the live tag bubbles and the
 * packed-bed canvas painter.  Owner group `ui-pid`; architecture-v2 §6.27 and §9.2.
 *
 * The schematic is inline SVG on a `viewBox="0 0 400 620"` grid.  Static geometry is authored once
 * in {@link PID_TEMPLATE} and injected with `innerHTML` at construction ONLY; every subsequent
 * update writes `class` / `fill` / `transform` / `textContent` / `d` on `id`-tagged nodes.  The SVG
 * is never re-serialised.
 *
 * The packed bed is a sibling absolutely-positioned `<canvas>` aligned to SVG (154,282)-(246,462),
 * i.e. 92 x 180 schematic units, painted by {@link paintBed} from `physics/bed.js::bedAxialSnapshot`.
 *
 * This module is READ-ONLY over `config` and `run`.  Every mutation goes through `ctx.sim`.
 */

import { bedAxialSnapshot } from '../physics/bed.js';
import { clamp, createRng, nextFloat, RNG_STREAMS } from '../core/util.js';
import { glossaryFor } from '../data/glossary.js';

/* ===============================================================================================
 * 1.  GEOMETRY CONSTANTS  (schematic user units — the §9.2 20-unit grid)
 * =============================================================================================*/

/** Schematic viewBox width, user units. @type {number} */
const VIEW_W = 400;
/** Schematic viewBox height, user units. @type {number} */
const VIEW_H = 620;

/** Bed canvas left edge in schematic units (§9.2). @type {number} */
const BED_X = 154;
/** Bed canvas top edge in schematic units (§9.2). @type {number} */
const BED_Y = 282;
/** Bed canvas logical width (§9.2). @type {number} */
const BED_W = 92;
/** Bed canvas logical height (§9.2). @type {number} */
const BED_H = 180;

/** Maximum bed-top compression offset, px — matches `bed.js::BED_TOP_OFFSET_MAX_PX`. */
const BED_TOP_MAX_PX = 18;

/** Number of resin beads in the static bed texture (§9.2 step 1). @type {number} */
const BEAD_COUNT = 1400;

/** Mobile-phase tint strip count (§9.2 step 2). @type {number} */
const TINT_STRIPS = 120;

/** Entries in the precomputed buffer-A -> buffer-B colour LUT (§9.2). @type {number} */
const LUT_N = 32;

/** Slow-lane (tag values, valves, snapshot) period, ms. 10 Hz per §6.11 / §6.27. */
const SLOW_MS = 100;

/** Bed repaint budget, ms.  Exceeding it drops the bed to 30 fps (§9.2). */
const BED_BUDGET_MS = 2.0;

/** Dash travel at full pump flow, schematic units per second. */
const DASH_PX_PER_S_AT_QMAX = 30;

/* ===============================================================================================
 * 2.  THEME TOKENS
 * =============================================================================================*/

/** Token names the schematic and the bed painter need. @type {string[]} */
const TOKEN_NAMES = [
  '--bg-0', '--bg-1', '--surface-1', '--surface-2', '--surface-3',
  '--text-1', '--text-2', '--text-3',
  '--line', '--line-soft', '--line-strong',
  '--accent', '--ok', '--warn', '--alarm', '--focus',
  '--pipe-idle', '--flow-dash', '--valve-closed', '--valve-open',
  '--bed-bead', '--col-glass', '--gradient-front',
  '--band-1', '--band-2', '--band-3', '--band-4',
  '--fluid-a', '--fluid-b', '--fluid-sample', '--fluid-cip', '--fluid-waste',
];

/** Normative dark defaults (§9.2, §9.4.1) — used when a token is absent from the stylesheet. */
const DARK_DEFAULTS = {
  '--bg-0': '#0B0F14', '--bg-1': '#121821', '--surface-1': '#161E29',
  '--surface-2': '#1C2733', '--surface-3': '#243040',
  '--text-1': '#E6EDF5', '--text-2': '#A7B4C4', '--text-3': '#71818F',
  '--line': '#2A3441', '--line-soft': '#212A35', '--line-strong': '#3A4757',
  '--accent': '#5DA9FF', '--ok': '#3FBF7F', '--warn': '#E8A33D', '--alarm': '#F2544B',
  '--focus': '#8FD0FF',
  '--pipe-idle': '#2A3441', '--flow-dash': 'rgba(255,255,255,0.75)',
  '--valve-closed': '#3A4350', '--valve-open': '#22C55E',
  '--bed-bead': '#8E9AA8', '--col-glass': 'rgba(255,255,255,0.03)',
  '--gradient-front': '#F2C14E',
  '--band-1': '#4CC9F0', '--band-2': '#B388FF', '--band-3': '#FFB347', '--band-4': '#7DF2B8',
  '--fluid-a': '#2E6FA8', '--fluid-b': '#7A4FA8', '--fluid-sample': '#C98A2B',
  '--fluid-cip': '#2FA98C', '--fluid-waste': '#6B7684',
};

/** Normative light overrides (§9.4.1); anything absent falls back to the dark entry. */
const LIGHT_DEFAULTS = Object.assign({}, DARK_DEFAULTS, {
  '--bg-0': '#EEF1F5', '--bg-1': '#F6F8FA', '--surface-1': '#FFFFFF',
  '--surface-2': '#F2F5F8', '--surface-3': '#E7ECF2',
  '--text-1': '#0F1720', '--text-2': '#48566A', '--text-3': '#6B7A8C',
  '--line': '#D3DAE3', '--line-soft': '#E3E8EE', '--line-strong': '#AAB6C4',
  '--accent': '#0B72D8', '--ok': '#118A4E', '--warn': '#9A6300', '--alarm': '#C42B22',
  '--focus': '#0B72D8',
  '--pipe-idle': '#C9D2DC', '--flow-dash': 'rgba(15,23,32,0.55)',
  '--bed-bead': '#A9B4C0', '--col-glass': 'rgba(15,23,32,0.03)',
});

/* ===============================================================================================
 * 3.  COLOUR UTILITIES
 * =============================================================================================*/

/**
 * Parse a CSS colour string into linear-light RGBA. Accepts `#rgb`, `#rrggbb`, `rgb()` and
 * `rgba()`; anything else resolves to opaque mid-grey so a missing token can never throw.
 *
 * @param {string} css a CSS colour string
 * @returns {{r:number, g:number, b:number, a:number}} sRGB channels 0..255 plus alpha 0..1
 */
function parseColor(css) {
  const s = String(css || '').trim();
  if (s.charAt(0) === '#') {
    if (s.length === 4) {
      return {
        r: parseInt(s[1] + s[1], 16), g: parseInt(s[2] + s[2], 16),
        b: parseInt(s[3] + s[3], 16), a: 1,
      };
    }
    if (s.length >= 7) {
      return {
        r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16),
        b: parseInt(s.slice(5, 7), 16), a: 1,
      };
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter((x) => x.length > 0);
    return {
      r: parseFloat(p[0]) || 0, g: parseFloat(p[1]) || 0, b: parseFloat(p[2]) || 0,
      a: p.length > 3 ? (parseFloat(p[3]) || 0) : 1,
    };
  }
  return { r: 128, g: 128, b: 128, a: 1 };
}

/**
 * sRGB 0..255 -> linear-light 0..1.
 * @param {number} c channel value, 0..255
 * @returns {number} linear-light value, 0..1
 */
function toLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * Linear-light 0..1 -> sRGB 0..255.
 * @param {number} x linear-light value, 0..1
 * @returns {number} channel value, 0..255
 */
function toSrgb(x) {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055;
  return Math.round(clamp(c, 0, 1) * 255);
}

/**
 * Build the 32-entry buffer-A -> buffer-B blend LUT.  The interpolation happens in linear light,
 * which is what stops the blue/violet midpoint going muddy (§9.2, §2.5 of spec-ux).
 *
 * @param {string} aCss buffer-A colour
 * @param {string} bCss buffer-B colour
 * @returns {string[]} `LUT_N` CSS `rgb()` strings, index 0 = pure A, index `LUT_N-1` = pure B
 */
function buildBlendLut(aCss, bCss) {
  const A = parseColor(aCss);
  const B = parseColor(bCss);
  const al = [toLinear(A.r), toLinear(A.g), toLinear(A.b)];
  const bl = [toLinear(B.r), toLinear(B.g), toLinear(B.b)];
  const out = new Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1);
    out[i] = 'rgb(' + toSrgb(al[0] + (bl[0] - al[0]) * t) + ','
      + toSrgb(al[1] + (bl[1] - al[1]) * t) + ','
      + toSrgb(al[2] + (bl[2] - al[2]) * t) + ')';
  }
  return out;
}

/**
 * Look a percentage of buffer B up in a blend LUT.
 * @param {string[]} lut a LUT from {@link buildBlendLut}
 * @param {number} pctB percent buffer B, 0..100 (NaN is treated as 0)
 * @returns {string} a CSS colour string
 */
function lutAt(lut, pctB) {
  const p = Number.isFinite(pctB) ? clamp(pctB, 0, 100) : 0;
  return lut[Math.round(p / 100 * (LUT_N - 1))];
}

/**
 * Relative luminance of a CSS colour, used only to decide whether a token map is a dark theme.
 * @param {string} css a CSS colour string
 * @returns {number} luminance 0..1
 */
function luminance(css) {
  const c = parseColor(css);
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/**
 * Compose an `rgba()` string from a CSS colour and an explicit alpha.
 * @param {string} css a CSS colour string
 * @param {number} alpha alpha, 0..1
 * @returns {string} an `rgba()` string
 */
function rgba(css, alpha) {
  const c = parseColor(css);
  return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ','
    + clamp(alpha, 0, 1).toFixed(3) + ')';
}

/**
 * Read the theme tokens this panel needs from a live element, falling back to the normative
 * §9.4.1 / §9.2 defaults for any token the stylesheet does not define (the `--fluid-*` family is
 * schematic-only and may legitimately be absent).  Called once at mount and once per theme change,
 * never per frame — reading custom properties inside a frame is a layout-thrash trap.
 *
 * @param {Element|null} el an element inside the themed subtree, or null for `documentElement`
 * @returns {object} a resolved theme: the token map plus `isDark`, `lutAB` and `bands`
 */
function readTheme(el) {
  const target = el || (typeof document !== 'undefined' ? document.documentElement : null);
  /** @type {Record<string,string>} */
  const raw = {};
  let cs = null;
  if (target && typeof getComputedStyle === 'function') {
    try { cs = getComputedStyle(target); } catch (e) { cs = null; }
  }
  let probe = DARK_DEFAULTS;
  if (cs) {
    const bg = String(cs.getPropertyValue('--bg-0') || '').trim();
    if (bg && luminance(bg) > 0.35) probe = LIGHT_DEFAULTS;
    else if (!bg) {
      const attr = target.getAttribute && target.getAttribute('data-theme');
      const rootAttr = attr || (typeof document !== 'undefined'
        ? document.documentElement.getAttribute('data-theme') : null);
      if (rootAttr === 'light') probe = LIGHT_DEFAULTS;
      else if (!rootAttr && typeof matchMedia === 'function'
        && matchMedia('(prefers-color-scheme: light)').matches) probe = LIGHT_DEFAULTS;
    }
  }
  for (let i = 0; i < TOKEN_NAMES.length; i++) {
    const name = TOKEN_NAMES[i];
    const v = cs ? String(cs.getPropertyValue(name) || '').trim() : '';
    raw[name] = v || probe[name];
  }
  const theme = Object.assign({}, raw);
  theme.isDark = luminance(theme['--bg-0']) < 0.35;
  theme.lutAB = buildBlendLut(theme['--fluid-a'], theme['--fluid-b']);
  theme.bands = [theme['--band-1'], theme['--band-2'], theme['--band-3'], theme['--band-4']];
  return theme;
}

/** Cache of normalised themes keyed by the caller's raw token map. @type {WeakMap<object,object>} */
const THEME_CACHE = new WeakMap();

/**
 * Accept either a resolved theme from {@link readTheme} or a bare token map and return a resolved
 * theme.  Keeps {@link paintBed} usable standalone (tests, exports) without duplicating token work.
 *
 * @param {object|null|undefined} theme a resolved theme or a `{'--token': value}` map
 * @returns {object} a resolved theme with `isDark`, `lutAB` and `bands`
 */
function normaliseTheme(theme) {
  if (!theme || typeof theme !== 'object') {
    const t = Object.assign({}, DARK_DEFAULTS);
    t.isDark = true;
    t.lutAB = buildBlendLut(t['--fluid-a'], t['--fluid-b']);
    t.bands = [t['--band-1'], t['--band-2'], t['--band-3'], t['--band-4']];
    return t;
  }
  if (Array.isArray(theme.lutAB) && Array.isArray(theme.bands)) return theme;
  const hit = THEME_CACHE.get(theme);
  if (hit) return hit;
  const t = Object.assign({}, DARK_DEFAULTS, theme);
  t.isDark = luminance(t['--bg-0']) < 0.35;
  t.lutAB = buildBlendLut(t['--fluid-a'], t['--fluid-b']);
  t.bands = [t['--band-1'], t['--band-2'], t['--band-3'], t['--band-4']];
  THEME_CACHE.set(theme, t);
  return t;
}

/* ===============================================================================================
 * 4.  NUMBER FORMATTING (fixed decimals per channel so digits never change width, §9.4.2)
 * =============================================================================================*/

/**
 * Fixed-decimal formatter that degrades gracefully on NaN / Infinity.
 * @param {number} v the value
 * @param {number} dp decimal places
 * @returns {string} the formatted number, or an em dash when not evaluable
 */
function nfix(v, dp) {
  return Number.isFinite(v) ? v.toFixed(dp) : '—';
}

/**
 * Format a volume for a tank / waste readout: litres above 1 L, millilitres below.
 * @param {number} v_mL volume, mL
 * @returns {{value:string, unit:string}} display value and unit
 */
function fmtTankVolume(v_mL) {
  if (!Number.isFinite(v_mL)) return { value: '—', unit: 'L' };
  if (Math.abs(v_mL) >= 1000) return { value: (v_mL / 1000).toFixed(1), unit: 'L' };
  return { value: v_mL.toFixed(0), unit: 'mL' };
}

/* ===============================================================================================
 * 5.  THE STATIC SVG TEMPLATE
 * =============================================================================================*/

/**
 * The complete static schematic markup, `viewBox="0 0 400 620"`.
 *
 * Injected with `innerHTML` exactly once, at panel construction.  Elements that change carry an
 * `id`; pipe runs carry `data-seg`; interactive components carry `data-component` on an invisible
 * hit rect.  Dynamic collections (fraction vials, flow-dash overlays, reduced-motion direction
 * arrows) are built programmatically at mount, not here.
 *
 * @type {string}
 */
export const PID_TEMPLATE = `
<svg class="pid-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet"
     role="group" aria-label="Process schematic">
  <defs>
    <clipPath id="pid-clip-tk0"><rect x="30" y="24" width="62" height="62" rx="4"/></clipPath>
    <clipPath id="pid-clip-tk1"><rect x="110" y="24" width="62" height="62" rx="4"/></clipPath>
    <clipPath id="pid-clip-tk2"><rect x="190" y="24" width="62" height="62" rx="4"/></clipPath>
    <clipPath id="pid-clip-tk3"><rect x="270" y="24" width="62" height="62" rx="4"/></clipPath>
    <clipPath id="pid-clip-waste"><rect x="44" y="576" width="36" height="38" rx="3"/></clipPath>
    <clipPath id="pid-clip-trap"><rect x="237" y="146" width="26" height="40" rx="4"/></clipPath>
    <pattern id="pid-hazard" width="8" height="8" patternUnits="userSpaceOnUse"
             patternTransform="rotate(45)">
      <rect width="8" height="8" class="pid-hazard-bg"/>
      <rect width="4" height="8" class="pid-hazard-fg"/>
    </pattern>
    <pattern id="pid-fault" width="6" height="6" patternUnits="userSpaceOnUse"
             patternTransform="rotate(45)">
      <rect width="6" height="6" class="pid-fault-bg"/>
      <rect width="3" height="6" class="pid-fault-fg"/>
    </pattern>
  </defs>

  <!-- ============================ PIPE RUNS (idle layer) ============================ -->
  <g id="pid-pipes" class="pid-pipes" fill="none">
    <path data-seg="s-tank-a"   d="M61,86 V97"/>
    <path data-seg="s-tank-b"   d="M141,86 V97"/>
    <path data-seg="s-tank-s"   d="M221,86 V97"/>
    <path data-seg="s-tank-c"   d="M301,86 V97"/>
    <path data-seg="s-drop-a"   d="M61,111 V126"/>
    <path data-seg="s-drop-b"   d="M141,111 V126"/>
    <path data-seg="s-drop-s"   d="M221,111 V135"/>
    <path data-seg="s-drop-c"   d="M301,111 V126"/>
    <path data-seg="s-hdr-2"    d="M301,126 H227 A6,6 0 0,0 215,126 H141"/>
    <path data-seg="s-hdr-1"    d="M141,126 H63"/>
    <path data-seg="s-pump-out" d="M52,158 V175 H110"/>
    <path data-seg="s-mix-out"  d="M150,175 H192"/>
    <path data-seg="s-filt-out" d="M218,175 H237"/>
    <path data-seg="s-trap-out" d="M250,186 V189"/>
    <path data-seg="s-iv-out"   d="M236.14,197 H200 V230"/>
    <path data-seg="s-samp-disc" d="M221,157 V169 A6,6 0 0,1 221,181 V213 H236.14"/>
    <path data-seg="s-loop"     d="M263.86,197 H278 V180 H338 V230 H278 V213 H263.86"/>
    <path data-seg="s-iv-vent"  d="M250,221 V231"/>
    <path data-seg="s-cv-top"   d="M200,258 V262"/>
    <path data-seg="s-col-bot"  d="M200,470 V482 H300 V244 H214"/>
    <path data-seg="s-cv-out"   d="M186,244 H104 V499"/>
    <path data-seg="s-det-in"   d="M104,499 H140"/>
    <path data-seg="s-uv-ce"    d="M186,499 H196"/>
    <path data-seg="s-ce-ae"    d="M236,499 H246"/>
    <path data-seg="s-det-out"  d="M280,499 H310 V530 H200"/>
    <path data-seg="s-cip-shunt" d="M104,499 V530 H200"/>
    <path data-seg="s-dv-in"    d="M200,530 V535"/>
    <path data-seg="s-waste"    d="M200,549 V562 H62 V576"/>
    <path data-seg="s-collect"  d="M207,542 H232 V536 H370"/>
  </g>

  <!-- flow overlay + reduced-motion arrows are populated at mount -->
  <g id="pid-flow-layer" class="pid-flow-layer" fill="none" aria-hidden="true"></g>
  <g id="pid-arrows" class="pid-arrows" aria-hidden="true"></g>

  <!-- ============================ TANKS ============================ -->
  <g id="pid-tank-0" class="pid-tank">
    <text id="pid-tank-0-label" class="pid-tag-name" x="61" y="19" text-anchor="middle">BUFFER A</text>
    <g clip-path="url(#pid-clip-tk0)">
      <rect id="pid-tank-0-fill" class="pid-tank-fill" x="30" y="60" width="62" height="26"/>
      <line id="pid-tank-0-men" class="pid-tank-men" x1="30" y1="60" x2="92" y2="60"/>
    </g>
    <rect class="pid-tank-body" x="30" y="24" width="62" height="62" rx="4"/>
    <text id="pid-tank-0-name" class="pid-tank-name" x="61" y="46" text-anchor="middle">TK</text>
    <text id="pid-tank-0-val" class="pid-tag-value" x="61" y="63" text-anchor="middle">0.0</text>
    <text id="pid-tank-0-unit" class="pid-tag-unit" x="61" y="76" text-anchor="middle">L</text>
    <rect class="pid-hit" data-component="TK-A" x="30" y="24" width="62" height="62"
          tabindex="0" role="button" aria-label="Buffer A tank"/>
  </g>
  <g id="pid-tank-1" class="pid-tank">
    <text id="pid-tank-1-label" class="pid-tag-name" x="141" y="19" text-anchor="middle">BUFFER B</text>
    <g clip-path="url(#pid-clip-tk1)">
      <rect id="pid-tank-1-fill" class="pid-tank-fill" x="110" y="60" width="62" height="26"/>
      <line id="pid-tank-1-men" class="pid-tank-men" x1="110" y1="60" x2="172" y2="60"/>
    </g>
    <rect class="pid-tank-body" x="110" y="24" width="62" height="62" rx="4"/>
    <text id="pid-tank-1-name" class="pid-tank-name" x="141" y="46" text-anchor="middle">TK</text>
    <text id="pid-tank-1-val" class="pid-tag-value" x="141" y="63" text-anchor="middle">0.0</text>
    <text id="pid-tank-1-unit" class="pid-tag-unit" x="141" y="76" text-anchor="middle">L</text>
    <rect class="pid-hit" data-component="TK-B" x="110" y="24" width="62" height="62"
          tabindex="0" role="button" aria-label="Buffer B tank"/>
  </g>
  <g id="pid-tank-2" class="pid-tank">
    <text id="pid-tank-2-label" class="pid-tag-name" x="221" y="19" text-anchor="middle">SAMPLE</text>
    <g clip-path="url(#pid-clip-tk2)">
      <rect id="pid-tank-2-fill" class="pid-tank-fill" x="190" y="60" width="62" height="26"/>
      <line id="pid-tank-2-men" class="pid-tank-men" x1="190" y1="60" x2="252" y2="60"/>
    </g>
    <rect class="pid-tank-body" x="190" y="24" width="62" height="62" rx="4"/>
    <text id="pid-tank-2-name" class="pid-tank-name" x="221" y="46" text-anchor="middle">TK</text>
    <text id="pid-tank-2-val" class="pid-tag-value" x="221" y="63" text-anchor="middle">0.0</text>
    <text id="pid-tank-2-unit" class="pid-tag-unit" x="221" y="76" text-anchor="middle">L</text>
    <rect class="pid-hit" data-component="TK-S" x="190" y="24" width="62" height="62"
          tabindex="0" role="button" aria-label="Sample tank"/>
  </g>
  <g id="pid-tank-3" class="pid-tank">
    <text id="pid-tank-3-label" class="pid-tag-name" x="301" y="19" text-anchor="middle">CIP</text>
    <g clip-path="url(#pid-clip-tk3)">
      <rect id="pid-tank-3-fill" class="pid-tank-fill" x="270" y="60" width="62" height="26"/>
      <line id="pid-tank-3-men" class="pid-tank-men" x1="270" y1="60" x2="332" y2="60"/>
    </g>
    <rect class="pid-tank-body" x="270" y="24" width="62" height="62" rx="4"/>
    <text id="pid-tank-3-name" class="pid-tank-name" x="301" y="46" text-anchor="middle">TK</text>
    <text id="pid-tank-3-val" class="pid-tag-value" x="301" y="63" text-anchor="middle">0.0</text>
    <text id="pid-tank-3-unit" class="pid-tag-unit" x="301" y="76" text-anchor="middle">L</text>
    <rect class="pid-hit" data-component="TK-CIP" x="270" y="24" width="62" height="62"
          tabindex="0" role="button" aria-label="CIP tank"/>
  </g>

  <!-- ============================ INLET VALVES ============================ -->
  <g id="pid-v-V1" class="pid-valve" transform="translate(61,104)">
    <line class="pid-valve-stem" x1="-10" y1="0" x2="10" y2="0"/>
    <g class="pid-valve-rot"><rect class="pid-valve-body" x="-7" y="-7" width="14" height="14" rx="1.5"/></g>
    <line class="pid-valve-bore" x1="0" y1="-7" x2="0" y2="7"/>
    <text class="pid-tag-name" x="-13" y="3" text-anchor="end">V1</text>
    <rect class="pid-hit" data-component="V1" x="-12" y="-12" width="24" height="24"
          tabindex="0" role="button" aria-label="Inlet valve V1, buffer A side"/>
  </g>
  <g id="pid-v-V2" class="pid-valve" transform="translate(141,104)">
    <line class="pid-valve-stem" x1="-10" y1="0" x2="10" y2="0"/>
    <g class="pid-valve-rot"><rect class="pid-valve-body" x="-7" y="-7" width="14" height="14" rx="1.5"/></g>
    <line class="pid-valve-bore" x1="0" y1="-7" x2="0" y2="7"/>
    <text class="pid-tag-name" x="-13" y="3" text-anchor="end">V2</text>
    <rect class="pid-hit" data-component="V2" x="-12" y="-12" width="24" height="24"
          tabindex="0" role="button" aria-label="Inlet valve V2, buffer B side"/>
  </g>
  <g id="pid-v-V3" class="pid-valve" transform="translate(221,104)">
    <line class="pid-valve-stem" x1="-10" y1="0" x2="10" y2="0"/>
    <g class="pid-valve-rot"><rect class="pid-valve-body" x="-7" y="-7" width="14" height="14" rx="1.5"/></g>
    <line class="pid-valve-bore" x1="0" y1="-7" x2="0" y2="7"/>
    <text class="pid-tag-name" x="-13" y="3" text-anchor="end">V3</text>
    <rect class="pid-hit" data-component="V3" x="-12" y="-12" width="24" height="24"
          tabindex="0" role="button" aria-label="Sample inlet valve V3"/>
  </g>
  <g id="pid-v-V4" class="pid-valve" transform="translate(301,104)">
    <line class="pid-valve-stem" x1="-10" y1="0" x2="10" y2="0"/>
    <g class="pid-valve-rot"><rect class="pid-valve-body" x="-7" y="-7" width="14" height="14" rx="1.5"/></g>
    <line class="pid-valve-bore" x1="0" y1="-7" x2="0" y2="7"/>
    <text class="pid-tag-name" x="-13" y="3" text-anchor="end">V4</text>
    <rect class="pid-hit" data-component="V4" x="-12" y="-12" width="24" height="24"
          tabindex="0" role="button" aria-label="CIP inlet valve V4"/>
  </g>

  <!-- ============================ PUMPS ============================ -->
  <g id="pid-pump" class="pid-machine" transform="translate(52,140)">
    <circle class="pid-machine-body" cx="0" cy="0" r="18"/>
    <g id="pid-impeller" class="pid-impeller">
      <path d="M0,-12 L3.2,0 L-3.2,0 Z"/>
      <path d="M10.4,6 L0.6,3.4 L3.8,-2.1 Z"/>
      <path d="M-10.4,6 L-3.8,-2.1 L-0.6,3.4 Z"/>
      <circle cx="0" cy="0" r="2.6" class="pid-impeller-hub"/>
    </g>
    <text class="pid-tag-name" x="-22" y="3" text-anchor="end">P-101</text>
    <rect class="pid-hit" data-component="P-101" x="-18" y="-18" width="36" height="36"
          tabindex="0" role="button" aria-label="System pump P-101"/>
  </g>
  <g id="pid-pump-s" class="pid-machine" transform="translate(221,146)">
    <circle class="pid-machine-body" cx="0" cy="0" r="11"/>
    <path class="pid-impeller-static" d="M0,-7 L2,0 L-2,0 Z M6,3.5 L0.4,2 L2.3,-1.2 Z
                                        M-6,3.5 L-2.3,-1.2 L-0.4,2 Z"/>
    <text class="pid-tag-name" x="14" y="3">P-102</text>
    <rect class="pid-hit" data-component="P-102" x="-11" y="-11" width="22" height="22"
          tabindex="0" role="button" aria-label="Sample pump P-102"/>
  </g>

  <!-- ============================ MIXER ============================ -->
  <g id="pid-mixer" class="pid-vessel">
    <rect class="pid-vessel-body" x="110" y="158" width="40" height="34" rx="3"/>
    <path class="pid-mixer-zig" d="M114,186 L122,164 L130,186 L138,164 L146,186"/>
    <text class="pid-tag-name" x="130" y="154" text-anchor="middle">M-101</text>
    <rect class="pid-hit" data-component="M-101" x="110" y="158" width="40" height="34"
          tabindex="0" role="button" aria-label="Gradient mixer M-101"/>
  </g>

  <!-- ============================ PT-101 BALLOON ============================ -->
  <g id="pid-pt101" class="pid-balloon">
    <line class="pid-leader" x1="170" y1="169" x2="170" y2="175"/>
    <circle class="pid-balloon-body" cx="170" cy="158" r="11"/>
    <text class="pid-balloon-t1" x="170" y="156" text-anchor="middle">PT</text>
    <text class="pid-balloon-t2" x="170" y="164" text-anchor="middle">101</text>
    <rect class="pid-hit" data-component="PT-101" x="159" y="147" width="22" height="22"
          tabindex="0" role="button" aria-label="Pre-column pressure transmitter PT-101"/>
  </g>

  <!-- ============================ FILTER ============================ -->
  <g id="pid-filter" class="pid-vessel">
    <rect class="pid-vessel-body" x="192" y="160" width="26" height="30" rx="3"/>
    <path class="pid-filter-mesh" d="M194,168 H216 M194,175 H216 M194,182 H216"/>
    <text class="pid-tag-name" x="205" y="156" text-anchor="middle">F-101</text>
    <rect class="pid-hit" data-component="F-101" x="192" y="160" width="26" height="30"
          tabindex="0" role="button" aria-label="Inline filter F-101"/>
  </g>

  <!-- ============================ AIR TRAP ============================ -->
  <g id="pid-trap" class="pid-vessel">
    <line class="pid-vent" x1="250" y1="146" x2="250" y2="138"/>
    <line class="pid-vent-tick" x1="245" y1="138" x2="255" y2="138"/>
    <g clip-path="url(#pid-clip-trap)">
      <rect id="pid-trap-liq" class="pid-trap-liq" x="237" y="166" width="26" height="20"/>
      <line id="pid-trap-men" class="pid-tank-men" x1="237" y1="166" x2="263" y2="166"/>
    </g>
    <rect class="pid-vessel-body" x="237" y="146" width="26" height="40" rx="4"/>
    <text class="pid-tag-name" x="267" y="152">AT-101</text>
    <rect class="pid-hit" data-component="AT-101" x="237" y="146" width="26" height="40"
          tabindex="0" role="button" aria-label="Air trap AT-101"/>
  </g>

  <!-- ============================ INJECTION VALVE ============================ -->
  <g id="pid-iv" class="pid-rotary" transform="translate(250,205)">
    <circle class="pid-rotary-body" cx="0" cy="0" r="16"/>
    <g id="pid-iv-ports" class="pid-rotary-ports">
      <circle cx="0" cy="-16" r="2"/><circle cx="13.86" cy="-8" r="2"/>
      <circle cx="13.86" cy="8" r="2"/><circle cx="0" cy="16" r="2"/>
      <circle cx="-13.86" cy="8" r="2"/><circle cx="-13.86" cy="-8" r="2"/>
    </g>
    <path id="pid-iv-ch" class="pid-rotary-ch" d=""/>
    <text id="pid-iv-mode" class="pid-tag-name" x="0" y="30" text-anchor="middle">LOAD</text>
    <text class="pid-tag-name" x="-19" y="-16" text-anchor="end">IV-101</text>
    <rect class="pid-hit" data-component="IV-101" x="-17" y="-17" width="34" height="34"
          tabindex="0" role="button" aria-label="Injection valve IV-101"/>
  </g>

  <!-- ============================ COLUMN VALVE ============================ -->
  <g id="pid-cv" class="pid-rotary" transform="translate(200,244)">
    <circle class="pid-rotary-body" cx="0" cy="0" r="14"/>
    <g class="pid-rotary-ports">
      <circle cx="0" cy="-14" r="2"/><circle cx="14" cy="0" r="2"/>
      <circle cx="0" cy="14" r="2"/><circle cx="-14" cy="0" r="2"/>
    </g>
    <path id="pid-cv-ch" class="pid-rotary-ch" d=""/>
    <g id="pid-cv-caps" class="pid-rotary-caps">
      <line id="pid-cv-cap-n" x1="-4" y1="-10" x2="4" y2="-10"/>
      <line id="pid-cv-cap-e" x1="10" y1="-4" x2="10" y2="4"/>
      <line id="pid-cv-cap-s" x1="-4" y1="10" x2="4" y2="10"/>
      <line id="pid-cv-cap-w" x1="-10" y1="-4" x2="-10" y2="4"/>
    </g>
    <circle id="pid-cv-arc" class="pid-move-arc" cx="0" cy="0" r="18"/>
    <rect class="pid-hit" data-component="CV-101" x="-16" y="-16" width="32" height="32"
          tabindex="0" role="button" aria-label="Column valve CV-101"/>
  </g>
  <g id="pid-cv-bubble" class="pid-bubble">
    <line class="pid-leader" x1="174" y1="228" x2="186" y2="236"/>
    <rect class="pid-bubble-box" x="112" y="214" width="62" height="20" rx="3"/>
    <text class="pid-tag-name" x="117" y="223">CV-101</text>
    <text id="pid-cv-pos" class="pid-tag-value pid-tag-value-sm" x="169" y="231"
          text-anchor="end">BYPASS</text>
  </g>

  <!-- ============================ COLUMN ============================ -->
  <g id="pid-column" class="pid-column">
    <rect class="pid-col-adapter" x="146" y="262" width="108" height="12" rx="2"/>
    <rect class="pid-col-adapter" x="146" y="466" width="108" height="10" rx="2"/>
    <rect class="pid-col-tube" x="150" y="270" width="100" height="200" rx="6"/>
    <line class="pid-col-frit" x1="154" y1="463" x2="246" y2="463"/>
    <text class="pid-tag-name" x="200" y="279" text-anchor="middle">C-101</text>
    <g class="pid-ruler">
      <line x1="143" y1="282" x2="150" y2="282"/><text x="140" y="285" text-anchor="end">0.00</text>
      <line x1="143" y1="327" x2="150" y2="327"/><text x="140" y="330" text-anchor="end">0.25</text>
      <line x1="143" y1="372" x2="150" y2="372"/><text x="140" y="375" text-anchor="end">0.50</text>
      <line x1="143" y1="417" x2="150" y2="417"/><text x="140" y="420" text-anchor="end">0.75</text>
      <line x1="143" y1="462" x2="150" y2="462"/><text x="140" y="465" text-anchor="end">1.00</text>
    </g>
    <g class="pid-profile">
      <line class="pid-profile-axis" x1="254" y1="282" x2="254" y2="462"/>
      <polyline id="pid-profile-line" class="pid-profile-line" points=""/>
      <text class="pid-tag-name" x="256" y="472">A280 vs z</text>
    </g>
    <rect class="pid-hit" data-component="C-101" x="150" y="262" width="104" height="214"
          tabindex="0" role="button" aria-label="Chromatography column C-101"/>
  </g>

  <!-- ============================ dP BRACKET ============================ -->
  <g id="pid-dp" class="pid-bracket">
    <path class="pid-bracket-line" d="M96,270 H88 V470 H96"/>
    <line class="pid-leader" x1="76" y1="360" x2="88" y2="360"/>
    <g class="pid-bubble">
      <rect id="pid-dp-box" class="pid-bubble-box" x="14" y="350" width="62" height="20" rx="3"/>
      <text class="pid-tag-name" x="19" y="359">PDT-101</text>
      <text id="pid-dp-val" class="pid-tag-value" x="56" y="367" text-anchor="end">0.000</text>
      <text class="pid-tag-unit" x="59" y="367">bar</text>
    </g>
    <rect class="pid-hit" data-component="PDT-101" x="14" y="350" width="62" height="20"
          tabindex="0" role="button" aria-label="Column differential pressure PDT-101"/>
  </g>

  <!-- ============================ PT-102 ============================ -->
  <g id="pid-pt102" class="pid-balloon">
    <circle class="pid-balloon-body" cx="300" cy="440" r="11"/>
    <text class="pid-balloon-t1" x="300" y="438" text-anchor="middle">PT</text>
    <text class="pid-balloon-t2" x="300" y="446" text-anchor="middle">102</text>
    <line class="pid-leader" x1="311" y1="447" x2="322" y2="456"/>
    <g class="pid-bubble">
      <rect id="pid-pt102-box" class="pid-bubble-box" x="316" y="456" width="62" height="20" rx="3"/>
      <text class="pid-tag-name" x="321" y="465">PT-102</text>
      <text id="pid-pt102-val" class="pid-tag-value" x="358" y="473" text-anchor="end">0.00</text>
      <text class="pid-tag-unit" x="361" y="473">bar</text>
    </g>
    <rect class="pid-hit" data-component="PT-102" x="289" y="429" width="22" height="22"
          tabindex="0" role="button" aria-label="Post-column pressure transmitter PT-102"/>
  </g>

  <!-- ============================ FT-101 / %B / TT-101 BUBBLES ============================ -->
  <g id="pid-ft" class="pid-bubble">
    <line class="pid-leader" x1="39" y1="196" x2="52" y2="180"/>
    <rect id="pid-ft-box" class="pid-bubble-box" x="8" y="196" width="62" height="20" rx="3"/>
    <text class="pid-tag-name" x="13" y="205">FT-101</text>
    <text id="pid-ft-val" class="pid-tag-value" x="45" y="213" text-anchor="end">0.0</text>
    <text class="pid-tag-unit" x="48" y="213">mL/min</text>
    <rect class="pid-hit" data-component="FT-101" x="8" y="196" width="62" height="20"
          tabindex="0" role="button" aria-label="Flow transmitter FT-101"/>
  </g>
  <g id="pid-pctb" class="pid-bubble">
    <line class="pid-leader" x1="117" y1="200" x2="130" y2="192"/>
    <rect id="pid-pctb-box" class="pid-bubble-box" x="86" y="200" width="62" height="20" rx="3"/>
    <text class="pid-tag-name" x="91" y="209">%B</text>
    <text id="pid-pctb-val" class="pid-tag-value" x="136" y="217" text-anchor="end">0.0</text>
    <text class="pid-tag-unit" x="139" y="217">%</text>
    <rect class="pid-hit" data-component="PCTB" x="86" y="200" width="62" height="20"
          tabindex="0" role="button" aria-label="Gradient percent buffer B"/>
  </g>
  <g id="pid-pt101-bubble" class="pid-bubble">
    <line class="pid-leader" x1="171" y1="148" x2="170" y2="147"/>
    <rect id="pid-pt101-box" class="pid-bubble-box" x="140" y="128" width="62" height="20" rx="3"/>
    <text class="pid-tag-name" x="145" y="137">PT-101</text>
    <text id="pid-pt101-val" class="pid-tag-value" x="182" y="145" text-anchor="end">0.00</text>
    <text class="pid-tag-unit" x="185" y="145">bar</text>
  </g>
  <g id="pid-tt" class="pid-bubble">
    <line class="pid-leader" x1="76" y1="480" x2="104" y2="486"/>
    <rect id="pid-tt-box" class="pid-bubble-box" x="14" y="470" width="62" height="20" rx="3"/>
    <text class="pid-tag-name" x="19" y="479">TT-101</text>
    <text id="pid-tt-val" class="pid-tag-value" x="58" y="487" text-anchor="end">25.0</text>
    <text class="pid-tag-unit" x="61" y="487">°C</text>
    <rect class="pid-hit" data-component="TT-101" x="14" y="470" width="62" height="20"
          tabindex="0" role="button" aria-label="Temperature transmitter TT-101"/>
  </g>

  <!-- ============================ DETECTOR TRAIN ============================ -->
  <g id="pid-uv" class="pid-detector">
    <rect id="pid-uv-box" class="pid-det-body" x="140" y="486" width="46" height="26" rx="3"/>
    <text class="pid-tag-name" x="144" y="495">UV-101</text>
    <text id="pid-uv-val" class="pid-tag-value" x="172" y="508" text-anchor="end">0.0</text>
    <text class="pid-tag-unit" x="174" y="508">mAU</text>
    <rect class="pid-hit" data-component="UV-101" x="140" y="486" width="46" height="26"
          tabindex="0" role="button" aria-label="UV absorbance monitor UV-101"/>
  </g>
  <g id="pid-ce" class="pid-detector">
    <rect id="pid-ce-box" class="pid-det-body" x="196" y="486" width="40" height="26" rx="3"/>
    <text class="pid-tag-name" x="200" y="495">CE-101</text>
    <text id="pid-ce-val" class="pid-tag-value" x="222" y="508" text-anchor="end">0.00</text>
    <text class="pid-tag-unit" x="224" y="508">mS</text>
    <rect class="pid-hit" data-component="CE-101" x="196" y="486" width="40" height="26"
          tabindex="0" role="button" aria-label="Conductivity cell CE-101"/>
  </g>
  <g id="pid-ae" class="pid-detector">
    <rect id="pid-ae-box" class="pid-det-body" x="246" y="486" width="34" height="26" rx="3"/>
    <text class="pid-tag-name" x="250" y="495">AE-101</text>
    <text id="pid-ae-val" class="pid-tag-value" x="270" y="508" text-anchor="end">7.00</text>
    <text class="pid-tag-unit" x="272" y="508">pH</text>
    <rect class="pid-hit" data-component="AE-101" x="246" y="486" width="34" height="26"
          tabindex="0" role="button" aria-label="pH electrode AE-101"/>
  </g>

  <!-- ============================ DIVERTER / WASTE / COLLECTOR ============================ -->
  <g id="pid-dv" class="pid-valve" transform="translate(200,542)">
    <line class="pid-valve-stem" x1="-10" y1="0" x2="10" y2="0"/>
    <g class="pid-valve-rot"><rect class="pid-valve-body" x="-7" y="-7" width="14" height="14" rx="1.5"/></g>
    <line class="pid-valve-bore" x1="-7" y1="0" x2="7" y2="0"/>
    <circle id="pid-dv-arc" class="pid-move-arc" cx="0" cy="0" r="11"/>
    <text class="pid-tag-name" x="-14" y="3" text-anchor="end">DV-101</text>
    <rect class="pid-hit" data-component="DV-101" x="-12" y="-12" width="24" height="24"
          tabindex="0" role="button" aria-label="Fraction diverter valve DV-101"/>
  </g>
  <g id="pid-waste" class="pid-waste">
    <g clip-path="url(#pid-clip-waste)">
      <rect class="pid-waste-hazard" x="44" y="576" width="36" height="38"/>
      <rect id="pid-waste-fill" class="pid-waste-fill" x="44" y="600" width="36" height="14"/>
    </g>
    <rect class="pid-vessel-body" x="44" y="576" width="36" height="38" rx="3"/>
    <text class="pid-tag-name" x="62" y="572" text-anchor="middle">WASTE</text>
    <text id="pid-waste-val" class="pid-tag-value pid-tag-value-sm" x="62" y="599"
          text-anchor="middle">0.0</text>
    <rect class="pid-hit" data-component="WASTE" x="44" y="576" width="36" height="38"
          tabindex="0" role="button" aria-label="Waste container"/>
  </g>
  <g id="pid-collector" class="pid-collector">
    <line class="pid-rail" x1="232" y1="536" x2="370" y2="536"/>
    <rect class="pid-collector-body" x="240" y="552" width="130" height="52" rx="3"/>
    <g id="pid-vials"></g>
    <g id="pid-frac-head" class="pid-frac-head" transform="translate(246,0)">
      <line x1="0" y1="536" x2="0" y2="549"/>
      <path d="M-4,547 L4,547 L0,553 Z"/>
    </g>
    <text id="pid-frac-label" class="pid-tag-name" x="370" y="548" text-anchor="end">WASTE</text>
    <text class="pid-tag-name" x="240" y="548">FC-101</text>
    <rect class="pid-hit" data-component="FC-101" x="240" y="552" width="130" height="52"
          tabindex="0" role="button" aria-label="Fraction collector FC-101"/>
  </g>
</svg>`;

/* ===============================================================================================
 * 6.  PANEL STYLESHEET (injected once; scoped to .pid-root)
 * =============================================================================================*/

/** Panel stylesheet.  Everything is expressed through the theme tokens of §9.4.1. @type {string} */
const PID_CSS = `
.pid-root{position:relative;display:block;width:100%;height:100%;min-height:320px;
  color:var(--text-1,#E6EDF5);font-family:var(--font-ui,system-ui,sans-serif);
  -webkit-user-select:none;user-select:none;}
.pid-root .pid-svg{display:block;width:100%;height:100%;overflow:visible;}
.pid-bed-canvas{position:absolute;left:0;top:0;pointer-events:none;}
.pid-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0;}

/* ---- pipes ---------------------------------------------------------------- */
.pid-pipes path{stroke:var(--pipe-idle,#2A3441);stroke-width:3;stroke-linecap:round;
  stroke-linejoin:round;transition:stroke var(--dur-2,160ms) var(--ease-out,ease);}
.pid-pipes path.is-active{stroke-width:4;}
.pid-flow-layer path{stroke:var(--flow-dash,rgba(255,255,255,.75));stroke-width:3;
  stroke-dasharray:6 10;stroke-linecap:round;opacity:0;pointer-events:none;}
.pid-flow-layer path.is-flowing{opacity:.55;}
.pid-arrows path{fill:var(--flow-dash,rgba(255,255,255,.75));opacity:0;}
.pid-arrows path.is-shown{opacity:.7;}

/* ---- tanks ---------------------------------------------------------------- */
.pid-tank-body{fill:none;stroke:var(--line,#2A3441);stroke-width:1;}
.pid-tank-fill{fill:var(--fluid-a,#2E6FA8);opacity:.55;}
.pid-tank-men{stroke:var(--fluid-a,#2E6FA8);stroke-width:1.5;}
.pid-tank.is-low .pid-tank-men{animation:pid-men-pulse 2s steps(1,end) infinite;}
.pid-tank.is-empty .pid-tank-body{stroke:var(--alarm,#F2544B);}
.pid-tank.is-empty .pid-tank-name,.pid-tank.is-empty .pid-tag-value{opacity:.45;}
.pid-tank.is-active .pid-tank-body{stroke:var(--line-strong,#3A4757);stroke-width:1.5;}
.pid-tank-name{font-size:8px;fill:var(--text-2,#A7B4C4);letter-spacing:.02em;}
@keyframes pid-men-pulse{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}

/* ---- valves --------------------------------------------------------------- */
.pid-valve-body{fill:var(--valve-closed,#3A4350);stroke:none;
  transition:fill var(--dur-2,160ms) var(--ease-out,ease);}
.pid-valve-rot{transform:rotate(45deg);transform-origin:0 0;
  transition:transform var(--dur-3,250ms) var(--ease-inout,ease);}
.pid-valve.is-moving .pid-valve-rot{transform:rotate(90deg);}
.pid-valve.is-open .pid-valve-body{fill:var(--valve-open,#22C55E);fill-opacity:.22;
  stroke:var(--valve-open,#22C55E);stroke-width:1.5;}
.pid-valve.is-fault .pid-valve-body{fill:url(#pid-fault);stroke:var(--warn,#E8A33D);stroke-width:1.5;}
.pid-valve.is-fault.is-blinking{animation:pid-blink 1s steps(1,end) 4;}
.pid-valve-stem{stroke:var(--line-strong,#3A4757);stroke-width:1.5;}
.pid-valve-bore{stroke:var(--pipe-idle,#2A3441);stroke-width:2;opacity:0;}
.pid-valve.is-open .pid-valve-bore{opacity:1;}
.pid-hazard-bg,.pid-fault-bg{fill:var(--surface-2,#1C2733);}
.pid-hazard-fg{fill:var(--warn,#E8A33D);opacity:.55;}
.pid-fault-fg{fill:var(--warn,#E8A33D);opacity:.5;}
@keyframes pid-blink{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}

/* ---- rotary valves -------------------------------------------------------- */
.pid-rotary-body{fill:var(--surface-2,#1C2733);stroke:var(--line-strong,#3A4757);stroke-width:1.5;}
.pid-rotary-ports circle{fill:var(--line-strong,#3A4757);}
.pid-rotary-ch{fill:none;stroke:var(--pipe-idle,#2A3441);stroke-width:2.6;stroke-linecap:round;
  transition:stroke var(--dur-2,160ms) var(--ease-out,ease);}
.pid-rotary-caps line{stroke:var(--text-3,#71818F);stroke-width:1.6;opacity:0;}
.pid-rotary-caps line.is-capped{opacity:.9;}
.pid-rotary.is-warn .pid-rotary-body,.pid-valve.is-warn .pid-valve-stem{stroke:var(--warn,#E8A33D);}
.pid-rotary.is-alarm .pid-rotary-body,.pid-valve.is-alarm .pid-valve-stem{stroke:var(--alarm,#F2544B);stroke-width:2;}
.pid-move-arc{fill:none;stroke:var(--accent,#5DA9FF);stroke-width:1.6;opacity:0;
  stroke-linecap:round;transform:rotate(-90deg);transform-origin:0 0;}
.pid-move-arc.is-moving{opacity:.9;}

/* ---- vessels / machines --------------------------------------------------- */
.pid-vessel-body{fill:var(--surface-2,#1C2733);stroke:var(--line,#2A3441);stroke-width:1.2;}
.pid-machine-body{fill:var(--surface-2,#1C2733);stroke:var(--line-strong,#3A4757);stroke-width:1.5;}
.pid-impeller path,.pid-impeller-static{fill:var(--text-3,#71818F);}
.pid-impeller-hub{fill:var(--surface-3,#243040);}
.pid-machine.is-running .pid-impeller path{fill:var(--accent,#5DA9FF);}
.pid-mixer-zig{fill:none;stroke:var(--text-3,#71818F);stroke-width:1.2;stroke-linejoin:round;}
.pid-filter-mesh{stroke:var(--text-3,#71818F);stroke-width:.8;fill:none;}
.pid-vent,.pid-vent-tick{stroke:var(--line-strong,#3A4757);stroke-width:1.2;}
.pid-trap-liq{fill:var(--fluid-a,#2E6FA8);opacity:.5;}

/* ---- column --------------------------------------------------------------- */
.pid-col-tube{fill:var(--col-glass,rgba(255,255,255,.03));stroke:var(--line-strong,#3A4757);
  stroke-width:2;}
.pid-col-adapter{fill:var(--surface-3,#243040);stroke:var(--line-strong,#3A4757);stroke-width:1;}
.pid-col-frit{stroke:var(--line-strong,#3A4757);stroke-width:1.4;opacity:.8;}
.pid-ruler line{stroke:var(--line,#2A3441);stroke-width:1;}
.pid-ruler text{font-size:8px;fill:var(--text-3,#71818F);
  font-family:var(--font-num,ui-monospace,monospace);font-variant-numeric:tabular-nums;}
.pid-profile-axis{stroke:var(--line,#2A3441);stroke-width:1;}
.pid-profile-line{fill:none;stroke:var(--band-1,#4CC9F0);stroke-width:1.4;
  stroke-linejoin:round;opacity:.9;}
.pid-bracket-line{fill:none;stroke:var(--line-strong,#3A4757);stroke-width:1.2;}

/* ---- bubbles / balloons / detectors --------------------------------------- */
.pid-bubble-box,.pid-det-body{fill:var(--surface-2,#1C2733);stroke:var(--line,#2A3441);
  stroke-width:1;transition:stroke var(--dur-2,160ms) var(--ease-out,ease);}
.pid-bubble-box.is-warn,.pid-det-body.is-warn{stroke:var(--warn,#E8A33D);stroke-width:1.5;}
.pid-bubble-box.is-alarm,.pid-det-body.is-alarm{stroke:var(--alarm,#F2544B);stroke-width:1.5;}
.pid-balloon-body{fill:var(--surface-2,#1C2733);stroke:var(--line-strong,#3A4757);stroke-width:1.2;}
.pid-balloon-t1,.pid-balloon-t2{font-size:6.5px;fill:var(--text-2,#A7B4C4);letter-spacing:.04em;}
.pid-leader{stroke:var(--line,#2A3441);stroke-width:1;}
.pid-tag-name{font-size:8px;fill:var(--text-3,#71818F);letter-spacing:.06em;
  text-transform:uppercase;}
.pid-tag-unit{font-size:8px;fill:var(--text-3,#71818F);
  font-family:var(--font-num,ui-monospace,monospace);}
.pid-tag-value{font-size:11px;font-weight:600;fill:var(--text-1,#E6EDF5);
  font-family:var(--font-num,ui-monospace,monospace);
  font-variant-numeric:tabular-nums lining-nums;}
.pid-tag-value-sm{font-size:9px;font-weight:600;}
.pid-detector.is-bypassed .pid-det-body{stroke-dasharray:3 3;}
.pid-detector.is-bypassed .pid-tag-value{opacity:.4;}
.pid-detector.is-suspect .pid-tag-value{fill:var(--warn,#E8A33D);}
.pid-detector.is-invalid .pid-tag-value{fill:var(--alarm,#F2544B);}

/* ---- collector ------------------------------------------------------------ */
.pid-collector-body{fill:var(--surface-2,#1C2733);stroke:var(--line,#2A3441);stroke-width:1;}
.pid-rail{stroke:var(--line-strong,#3A4757);stroke-width:1.4;}
.pid-vial{fill:var(--surface-3,#243040);stroke:var(--line,#2A3441);stroke-width:.7;}
.pid-vial-fill{fill:var(--fluid-a,#2E6FA8);opacity:.75;}
.pid-vial.is-active{stroke:var(--accent,#5DA9FF);stroke-width:1.4;}
.pid-frac-head line{stroke:var(--accent,#5DA9FF);stroke-width:1.6;}
.pid-frac-head path{fill:var(--accent,#5DA9FF);}
.pid-frac-head{transition:transform var(--dur-3,250ms) var(--ease-out,ease);}
.pid-waste-hazard{fill:url(#pid-hazard);opacity:.5;}
.pid-waste-fill{fill:var(--fluid-waste,#6B7684);opacity:.7;}

/* ---- interaction ---------------------------------------------------------- */
.pid-hit{fill:transparent;stroke:none;cursor:default;}
.pid-root.is-manual .pid-hit{cursor:pointer;}
.pid-hit:focus{outline:none;}
.pid-hit:focus-visible{outline:2px solid var(--focus,#8FD0FF);outline-offset:2px;}
.pid-root.is-manual .pid-svg{outline:3px solid var(--warn,#E8A33D);outline-offset:-3px;
  border-radius:var(--r-3,8px);}

/* ---- toast + tooltip ------------------------------------------------------ */
.pid-toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);
  max-width:88%;padding:6px 10px;border-radius:var(--r-2,5px);
  background:var(--overlay,#2B3A4A);border:1px solid var(--line-strong,#3A4757);
  color:var(--text-1,#E6EDF5);font-size:11px;line-height:1.35;
  box-shadow:var(--shadow-2,0 6px 20px rgba(0,0,0,.45));
  opacity:0;pointer-events:none;transition:opacity var(--dur-2,160ms) var(--ease-out,ease);z-index:3;}
.pid-toast.is-shown{opacity:1;}
.pid-toast.is-warn{border-color:var(--warn,#E8A33D);}
.pid-tip{position:absolute;z-index:4;max-width:260px;padding:8px;pointer-events:none;
  border-radius:var(--r-2,5px);background:var(--overlay,#2B3A4A);
  border:1px solid var(--line-strong,#3A4757);box-shadow:var(--shadow-2,0 6px 20px rgba(0,0,0,.45));
  font-size:11px;line-height:1.4;color:var(--text-2,#A7B4C4);opacity:0;
  transition:opacity var(--dur-2,160ms) var(--ease-out,ease);}
.pid-tip.is-shown{opacity:1;}
.pid-tip b{display:block;color:var(--text-1,#E6EDF5);font-size:11px;margin-bottom:3px;}
.pid-tip .pid-tip-val{display:block;margin-top:5px;color:var(--text-1,#E6EDF5);
  font-family:var(--font-num,ui-monospace,monospace);font-variant-numeric:tabular-nums;}
.pid-tip .pid-tip-typ{display:block;margin-top:4px;color:var(--text-3,#71818F);font-size:10px;}

@media (prefers-reduced-motion: reduce){
  .pid-root *{transition-duration:0ms !important;animation:none !important;}
}
`;

/** Guard so the stylesheet is injected exactly once per document. @type {boolean} */
let stylesInjected = false;

/**
 * Inject the panel stylesheet into `document.head`, once.
 * @returns {void}
 */
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  if (document.getElementById('pid-styles')) { stylesInjected = true; return; }
  const st = document.createElement('style');
  st.id = 'pid-styles';
  st.textContent = PID_CSS;
  document.head.appendChild(st);
  stylesInjected = true;
}

/* ===============================================================================================
 * 7.  SEGMENT TABLE
 * =============================================================================================*/

/** Segment ids in schematic order.  Must match the `data-seg` attributes of PID_TEMPLATE. */
const SEGMENT_IDS = [
  's-tank-a', 's-tank-b', 's-tank-s', 's-tank-c',
  's-drop-a', 's-drop-b', 's-drop-s', 's-drop-c',
  's-hdr-2', 's-hdr-1', 's-pump-out', 's-mix-out', 's-filt-out', 's-trap-out',
  's-iv-out', 's-samp-disc', 's-loop', 's-iv-vent',
  's-cv-top', 's-col-bot', 's-cv-out',
  's-det-in', 's-uv-ce', 's-ce-ae', 's-det-out', 's-cip-shunt',
  's-dv-in', 's-waste', 's-collect',
];

/** Segments driven by the sample-pump flow rather than the system flow. @type {Object<string,1>} */
const SAMPLE_CHAIN = { 's-tank-s': 1, 's-drop-s': 1, 's-samp-disc': 1, 's-loop': 1 };

/* ===============================================================================================
 * 8.  BED TEXTURE
 * =============================================================================================*/

/** Per-canvas cache of the static bead texture. @type {WeakMap<object,object>} */
const TEXTURE_CACHE = new WeakMap();

/**
 * Build the static packed-bed bead texture (§9.2 step 1): 1400 beads on a jittered hex lattice
 * drawn once into an offscreen canvas and blitted every frame.  The bed does not move, so this is
 * never rebuilt except on a theme change or a resolution change.
 *
 * Determinism: the bead layout is drawn from a private PCG stream forked from `config.seed` at
 * `RNG_STREAMS.BED_TEXTURE`.  The UI never touches `run.rng`, so the texture is reproducible
 * without perturbing the simulation's replay stream.
 *
 * @param {number} seed the run seed (`config.seed`)
 * @param {object} theme a resolved theme from {@link readTheme}
 * @param {number} scale backing-store pixels per schematic unit
 * @returns {HTMLCanvasElement|null} the texture canvas, or null when there is no DOM
 */
function buildBedTexture(seed, theme, scale) {
  if (typeof document === 'undefined') return null;
  const k = Math.max(0.5, scale);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(BED_W * k));
  cv.height = Math.max(1, Math.round(BED_H * k));
  const g = cv.getContext('2d');
  if (!g) return null;
  g.setTransform(k, 0, 0, k, 0, 0);

  const bead = theme['--bed-bead'];
  const rng = createRng((seed | 0) || 1).streams[RNG_STREAMS.BED_TEXTURE];

  // A jittered hex lattice sized so cols*rows is close to BEAD_COUNT.
  const aspect = BED_W / BED_H;
  const rows = Math.max(4, Math.round(Math.sqrt(BEAD_COUNT / aspect)));
  const cols = Math.max(4, Math.round(BEAD_COUNT / rows));
  const dx = BED_W / cols;
  const dy = BED_H / rows;

  for (let r = 0; r < rows; r++) {
    const offset = (r & 1) ? dx * 0.5 : 0;
    for (let c = 0; c < cols; c++) {
      const jx = (nextFloat(rng) - 0.5) * dx * 0.7;
      const jy = (nextFloat(rng) - 0.5) * dy * 0.7;
      const x = offset + c * dx + dx * 0.5 + jx;
      const y = r * dy + dy * 0.5 + jy;
      if (x < -3 || x > BED_W + 3) continue;
      const rad = 1.4 + nextFloat(rng) * 1.2;
      const alpha = 0.10 + nextFloat(rng) * 0.12;
      g.globalAlpha = alpha;
      g.fillStyle = bead;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
      // 1 px darker lower-right arc reads as a sphere.
      g.globalAlpha = alpha * 0.9;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, rad * 0.86, -0.35, 1.9);
      g.stroke();
    }
  }

  // Vertical depth gradient (§9.2 step 1).
  g.globalAlpha = 1;
  const grad = g.createLinearGradient(0, 0, 0, BED_H);
  grad.addColorStop(0, 'rgba(0,0,0,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0.05)');
  g.fillStyle = grad;
  g.fillRect(0, 0, BED_W, BED_H);
  return cv;
}

/**
 * Resolve the texture for a canvas, building and caching it on first use.
 * @param {CanvasRenderingContext2D} bedCtx the bed canvas context
 * @param {object} theme a resolved theme
 * @param {number} scale backing pixels per schematic unit
 * @param {number} seed the run seed
 * @returns {HTMLCanvasElement|null} the cached texture
 */
function getTexture(bedCtx, theme, scale, seed) {
  const key = bedCtx.canvas;
  const hit = TEXTURE_CACHE.get(key);
  const stamp = theme['--bed-bead'] + '|' + Math.round(scale * 100) + '|' + seed;
  if (hit && hit.stamp === stamp) return hit.tex;
  const tex = buildBedTexture(seed, theme, scale);
  TEXTURE_CACHE.set(key, { stamp, tex });
  return tex;
}

/** Fixed, stable air-bubble layout used by §9.2 step 7 (BYPASS / CIP only). */
const AIR_BUBBLES = (function buildAirBubbles() {
  const rng = createRng(20250731).streams[RNG_STREAMS.BED_TEXTURE];
  const out = [];
  for (let i = 0; i < 9; i++) {
    out.push({
      x: 10 + nextFloat(rng) * (BED_W - 20),
      phase: nextFloat(rng),
      rx: 3.2 + nextFloat(rng) * 3.4,
      ry: 2.4 + nextFloat(rng) * 2.6,
    });
  }
  return out;
}());

/* ===============================================================================================
 * 9.  THE BED PAINTER
 * =============================================================================================*/

/**
 * Paint the packed bed — the eight steps of architecture-v2 §9.2, in order.
 *
 * The painter works in a fixed 92 x 180 logical space (schematic units); `opts.dpr` is the number
 * of backing-store pixels per logical unit, so the caller may scale the canvas freely and the
 * numbers below never change.  Axial `z` runs top (column inlet) to bottom.
 *
 * @param {CanvasRenderingContext2D} bedCtx the bed canvas 2D context
 * @param {{pctB:Float32Array, species:Float32Array, speciesIds:string[],
 *          bedTopOffset_px:number, channelling:number, cMaxRef?:ArrayLike<number>}} snapshot
 *        the struct written by `physics/bed.js::bedAxialSnapshot`.  `species` is SPECIES-MAJOR,
 *        `species[band*nCells + cell]`, in mM.  `cMaxRef` is `run.bed.snapshotCMaxRef`; when it is
 *        absent the painter normalises each band by its own visible maximum.
 * @param {object} theme a resolved theme from {@link readTheme}, or a bare `{'--token':value}` map
 * @param {{dpr?:number, reducedMotion?:boolean, texture?:HTMLCanvasElement, seed?:number,
 *          showAir?:boolean, airFraction?:number, airPhase?:number}} opts painter options
 * @returns {void}
 */
export function paintBed(bedCtx, snapshot, theme, opts) {
  if (!bedCtx || !snapshot || !snapshot.pctB) return;
  const o = opts || {};
  const T = normaliseTheme(theme);
  const k = (typeof o.dpr === 'number' && o.dpr > 0) ? o.dpr : 1;
  const g = bedCtx;

  g.setTransform(k, 0, 0, k, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, BED_W, BED_H);

  const pctB = snapshot.pctB;
  const n = pctB.length;
  if (n < 2) return;
  const top = clamp(snapshot.bedTopOffset_px || 0, 0, BED_TOP_MAX_PX);
  const bedH = BED_H - top;
  const cellH = Math.max(1, bedH / n);
  const chan = clamp(snapshot.channelling || 0, 0, 1);

  /* ---- step 8 (compression void, painted first so the bed sits on top of it) ---------------- */
  if (top > 0.5) {
    g.fillStyle = lutAt(T.lutAB, pctB[0]);
    g.globalAlpha = 0.5;
    g.fillRect(0, 0, BED_W, top);
    g.globalAlpha = 0.9;
    g.strokeStyle = rgba(T['--line-strong'], 0.7);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, top);
    g.lineTo(BED_W, top);
    g.stroke();
    g.globalAlpha = 1;
  }

  /* ---- step 1: static bead texture, compressed into the remaining bed height ---------------- */
  const tex = o.texture || getTexture(g, T, k, o.seed || 1);
  if (tex) g.drawImage(tex, 0, 0, tex.width, tex.height, 0, top, BED_W, bedH);

  /* ---- step 2: mobile-phase tint ------------------------------------------------------------ */
  g.globalAlpha = 0.35;
  const stripH = Math.max(1, bedH / TINT_STRIPS);
  for (let i = 0; i < TINT_STRIPS; i++) {
    const z = (i + 0.5) / TINT_STRIPS;
    const cell = Math.min(n - 1, (z * n) | 0);
    g.fillStyle = lutAt(T.lutAB, pctB[cell]);
    g.fillRect(0, top + i * (bedH / TINT_STRIPS), BED_W, stripH);
  }
  g.globalAlpha = 1;

  /* ---- step 3: the salt / gradient front ---------------------------------------------------- */
  let frontCell = -1;
  let frontMax = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = Math.abs(pctB[i + 1] - pctB[i]);
    if (d > frontMax) { frontMax = d; frontCell = i; }
  }
  if (frontCell >= 0 && frontMax > 0.35) {
    const y = top + (frontCell + 0.5) / n * bedH;
    const front = T['--gradient-front'];
    const feather = g.createLinearGradient(0, y - 10, 0, y + 10);
    feather.addColorStop(0, rgba(front, 0));
    feather.addColorStop(0.5, rgba(front, 0.5));
    feather.addColorStop(1, rgba(front, 0));
    g.fillStyle = feather;
    g.fillRect(0, Math.max(0, y - 10), BED_W, 20);
    g.fillStyle = rgba(front, 0.5);
    g.fillRect(0, y - 1.5, BED_W, 3);
  }

  /* ---- step 4 + 5: protein bands, then band-edge sharpening --------------------------------- */
  const nBands = Math.min(4, snapshot.speciesIds ? snapshot.speciesIds.length : 0);
  g.globalCompositeOperation = T.isDark ? 'screen' : 'multiply';
  for (let b = 0; b < nBands; b++) {
    const id = snapshot.speciesIds[b];
    if (!id) continue;
    const off = b * n;
    let ref = (snapshot.cMaxRef && snapshot.cMaxRef.length > b) ? snapshot.cMaxRef[b] : 0;
    if (!(ref > 0)) {
      for (let i = 0; i < n; i++) if (snapshot.species[off + i] > ref) ref = snapshot.species[off + i];
    }
    if (!(ref > 0)) continue;
    const colour = T.bands[b];
    let peakCell = 0;
    let peakVal = -1;
    g.fillStyle = colour;
    for (let i = 0; i < n; i++) {
      const c = snapshot.species[off + i];
      if (c > peakVal) { peakVal = c; peakCell = i; }
      const a = clamp(c / ref, 0, 1) * 0.85;
      if (a < 0.012) continue;
      g.globalAlpha = a;
      const y = top + i / n * bedH;
      if (chan > 0) {
        // §9.2 step 6: wall channelling bows each strip into a shallow parabola.
        const sag = chan * 14;
        g.beginPath();
        g.moveTo(0, y);
        g.quadraticCurveTo(BED_W * 0.5, y + sag * 2, BED_W, y);
        g.lineTo(BED_W, y + cellH);
        g.quadraticCurveTo(BED_W * 0.5, y + cellH + sag * 2, 0, y + cellH);
        g.closePath();
        g.fill();
      } else {
        g.fillRect(0, y, BED_W, cellH);
      }
    }
    if (peakVal > 0 && peakVal / ref > 0.08) {
      g.globalAlpha = 0.25;
      g.strokeStyle = colour;
      g.lineWidth = 1;
      const py = top + (peakCell + 0.5) / n * bedH;
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(BED_W, py);
      g.stroke();
    }
  }
  g.globalAlpha = 1;

  /* ---- step 6: radial realism — dark at the walls, ~8 % lighter at the centre --------------- */
  g.globalCompositeOperation = 'multiply';
  const radial = g.createLinearGradient(0, 0, BED_W, 0);
  radial.addColorStop(0, 'rgb(206,206,206)');
  radial.addColorStop(0.5, 'rgb(232,232,232)');
  radial.addColorStop(1, 'rgb(206,206,206)');
  g.fillStyle = radial;
  g.fillRect(0, top, BED_W, bedH);
  g.globalCompositeOperation = 'source-over';

  /* ---- step 7: air / void — BYPASS and CIP_DETECTOR_BYPASS only ----------------------------- */
  if (o.showAir && (o.airFraction || 0) > 0) {
    const count = Math.max(3, Math.min(9, Math.round(3 + (o.airFraction || 0) * 60)));
    const phase = o.airPhase || 0;
    g.lineWidth = 1;
    for (let i = 0; i < count; i++) {
      const bub = AIR_BUBBLES[i];
      const t = (bub.phase + phase) % 1;
      const y = top + 4 + t * Math.min(bedH - 8, 70);
      g.globalAlpha = 0.85;
      g.fillStyle = T['--bg-1'];
      g.beginPath();
      g.ellipse(bub.x, y, bub.rx, bub.ry, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.stroke();
      g.globalAlpha = 0.6;
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.beginPath();
      g.arc(bub.x - bub.rx * 0.35, y - bub.ry * 0.35, 0.9, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  g.setTransform(1, 0, 0, 1, 0, 0);
}

/* ===============================================================================================
 * 10.  ACTIVE-PATH AND VALVE HELPERS
 * =============================================================================================*/

/** Column-valve internal channel geometry, per position.  Local coords, port radius 14. */
const CV_CHANNELS = {
  // IN(N) -> column TOP(S) straight through, and column BOTTOM(E) -> detectors(W) with a hop.
  DOWN: 'M0,-14 V14 M14,0 H4.5 A4.5,4.5 0 0,1 -4.5,0 H-14',
  // IN(N) -> column BOTTOM(E), and column TOP(S) -> detectors(W): two rim elbows, no crossing.
  UP: 'M0,-14 L0,-5 Q0,0 5,0 L14,0 M-14,0 L-5,0 Q0,0 0,5 L0,14',
  // IN(N) -> detectors(W): the column is out of line.
  BYPASS: 'M0,-14 L0,-5 Q0,0 -5,0 L-14,0',
  ISOLATED: '',
  CIP_DETECTOR_BYPASS: 'M0,-14 V14 M14,0 H4.5 A4.5,4.5 0 0,1 -4.5,0 H-14',
};

/** Which column-valve ports are capped (dead-ended) in each position. */
const CV_CAPS = {
  DOWN: [], UP: [],
  BYPASS: ['e', 's'],
  ISOLATED: ['n', 'e', 's', 'w'],
  CIP_DETECTOR_BYPASS: [],
};

/**
 * Injection-valve internal channels, by sample mode.  Ports (local, r = 16): FEED 90 deg,
 * COLUMN 150, SAMPLE 210, WASTE 270, LOOP_B -30, LOOP_A 30.
 */
const IV_CHANNELS = {
  // Pump straight to the column; the sample line charges the loop.
  LOAD: 'M0,-16 L0,-6 Q0,-1 -5,-2.9 L-13.86,-8 M-13.86,8 L13.86,-8',
  // Pump pushes the loop contents onto the column.
  INJECT: 'M0,-16 L0,-6 Q0,-1 5,-2.9 L13.86,-8 M13.86,8 L-13.86,-8 M-13.86,8 L-5,13 Q0,15 0,16',
  // Sample and buffer both reach the column through the injection tee.
  DIRECT: 'M0,-16 L0,-6 Q0,-1 -5,-2.9 L-13.86,-8 M-13.86,8 L-8,2 Q-6,-1 -13.86,-8',
};

/**
 * Resolve the display slot roles and the currently live inlet branches.
 *
 * @param {object} config the frozen config
 * @param {object} run the run state
 * @param {number} lastAIdx the last non-CIP tank index seen on the A side (-1 when unknown)
 * @returns {{a:number, b:number, s:number, cip:number, aIsCip:boolean}} tank indices per slot
 */
function resolveTankSlots(config, run, lastAIdx) {
  const byId = new Map();
  for (let i = 0; i < config.tanks.length; i++) byId.set(config.tanks[i].id, i);
  /**
   * @param {string|null} port an inlet port id
   * @returns {number} the tank index, or -1
   */
  const idxOfPort = (port) => {
    if (!port) return -1;
    const id = config.inletAssignments ? config.inletAssignments[port] : null;
    if (!id) return -1;
    const k = byId.get(id);
    return (k === undefined) ? -1 : k;
  };
  let cip = -1;
  for (let i = 0; i < config.tanks.length; i++) {
    const t = config.tanks[i];
    if (/naoh|cip|clean|sanit/i.test(String(t.id) + ' ' + String(t.label || ''))) { cip = i; break; }
  }
  if (cip < 0) cip = idxOfPort('A4');
  if (cip < 0) cip = config.tanks.length - 1;

  const aLive = idxOfPort(run.valves.inletA);
  const aIsCip = (aLive >= 0 && aLive === cip);
  const a = aIsCip ? (lastAIdx >= 0 ? lastAIdx : idxOfPort('A1')) : aLive;
  return { a, b: idxOfPort(run.valves.inletB), s: idxOfPort(run.valves.inletS), cip, aIsCip };
}

/**
 * Choose the fluid colour for a tank: sample amber, CIP teal, buffer-B violet, else buffer-A blue.
 * @param {object} config the frozen config
 * @param {object} theme a resolved theme
 * @param {number} tankIdx a `config.tanks` index, or -1
 * @param {number} cipIdx the resolved CIP tank index
 * @param {boolean} isBSide true when the tank feeds the B inlet
 * @returns {string} a CSS colour
 */
function tankColour(config, theme, tankIdx, cipIdx, isBSide) {
  if (tankIdx < 0) return theme['--pipe-idle'];
  if (tankIdx === cipIdx) return theme['--fluid-cip'];
  const t = config.tanks[tankIdx];
  if (t && t.isSample) return theme['--fluid-sample'];
  return isBSide ? theme['--fluid-b'] : theme['--fluid-a'];
}

/* ===============================================================================================
 * 11.  PUBLIC HELPERS
 * =============================================================================================*/

/**
 * Mark a set of pipe segments active and set the flow magnitude that drives the dash animation.
 *
 * The panel calls this itself every slow tick from the live valve state; it is exported so a host
 * view (or a test) can drive the schematic directly.  Dash offsets are advanced numerically at
 * 10 Hz from one accumulator per chain (§6.27, §11 C-39) — never from a CSS custom property.
 *
 * @param {object} pid the object returned by {@link createPID}
 * @param {string[]} ids segment ids (the `data-seg` values) that carry flow
 * @param {number} flowMagnitude_mLs the system flow magnitude in mL/s, used for dash speed
 * @returns {void}
 */
export function setActiveSegments(pid, ids, flowMagnitude_mLs) {
  if (!pid || !pid._segs) return;
  const set = pid._activeSet;
  set.clear();
  if (ids) for (let i = 0; i < ids.length; i++) set.add(ids[i]);
  pid._flow_mLs = Number.isFinite(flowMagnitude_mLs) ? flowMagnitude_mLs : 0;
  for (let i = 0; i < SEGMENT_IDS.length; i++) {
    const id = SEGMENT_IDS[i];
    const seg = pid._segs[id];
    if (!seg) continue;
    const on = set.has(id);
    if (seg.active !== on) {
      seg.active = on;
      seg.base.classList.toggle('is-active', on);
      seg.flow.classList.toggle('is-flowing', on && !pid._reducedMotion);
      if (seg.arrow) seg.arrow.classList.toggle('is-shown', on && pid._reducedMotion);
    }
  }
}

/**
 * Map a pointer or keyboard event to the schematic component under it.
 *
 * @param {object} pid the object returned by {@link createPID}
 * @param {Event} evt any DOM event whose target lies inside the panel
 * @returns {{componentId:string}|null} the component, or null when the event missed everything
 */
export function pidHitTest(pid, evt) {
  if (!pid || !evt) return null;
  const t = evt.target;
  if (!t || typeof t.closest !== 'function') return null;
  const node = t.closest('[data-component]');
  if (!node || (pid.el && !pid.el.contains(node))) return null;
  const id = node.getAttribute('data-component');
  return id ? { componentId: id } : null;
}

/* ===============================================================================================
 * 12.  THE PANEL
 * =============================================================================================*/

/** Components whose bubble border reflects an alarm, and the alarm ids that drive it. */
const COMPONENT_ALARMS = {
  'PT-101': ['ALM-P1-01', 'ALM-P1-02'],
  'PT-102': ['ALM-DP-04'],
  'PDT-101': ['ALM-DP-01', 'ALM-DP-02', 'ALM-DP-03', 'ALM-DP-04'],
  'P-101': ['ALM-PMP-01', 'ALM-PMP-02', 'ALM-PMP-03'],
  'AT-101': ['ALM-AIR-01', 'ALM-AIR-02', 'WRN-AIR-03'],
  'UV-101': ['ALM-UV-01', 'ALM-UV-02', 'WRN-UV-03'],
  'CE-101': ['ALM-CND-01'],
  'AE-101': ['ALM-PH-01', 'ALM-PH-02'],
  'CV-101': ['ALM-CV-01', 'ALM-CV-02', 'ALM-CV-03'],
  'FC-101': ['ALM-FRC-01'],
  'TT-101': ['ALM-TMP-01', 'ALM-TMP-02'],
  WASTE: ['ALM-TNK-03', 'WRN-TNK-04'],
};

/** Severity ranking used to pick a bubble border colour. */
const SEV_RANK = { INFO: 0, WARN: 1, ALARM: 2, CRITICAL: 3, FAULT: 3 };

/**
 * Create the P&ID panel.
 *
 * @param {Element} rootEl the container the panel mounts into
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx
 *        the §2.4 application context.  `ctx.sim` is the only mutation surface; this panel writes
 *        nothing to `config` or `run`.
 * @returns {{el:Element, mount:function():void, update:function(object=):void,
 *            destroy:function():void}} a §6.24 Panel
 */
export function createPID(rootEl, ctx) {
  ensureStyles();

  const doc = rootEl.ownerDocument || document;
  const el = doc.createElement('div');
  el.className = 'pid-root';

  const canvas = doc.createElement('canvas');
  canvas.className = 'pid-bed-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const toast = doc.createElement('div');
  toast.className = 'pid-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const tip = doc.createElement('div');
  tip.className = 'pid-tip';
  tip.setAttribute('role', 'tooltip');

  const srSummary = doc.createElement('p');
  srSummary.className = 'pid-sr';
  srSummary.setAttribute('aria-live', 'off');

  /** @type {any} */
  const pid = {
    el,
    _ctx: ctx,
    _config: ctx.config,
    _run: ctx.run,
    _segs: /** @type {Object<string,any>} */ ({}),
    _activeSet: new Set(),
    _flow_mLs: 0,
    _reducedMotion: false,
    _theme: null,
    _mounted: false,
  };

  /* ---- local mutable state ------------------------------------------------------------------ */
  let bedCtx = null;
  let nodes = /** @type {Object<string,any>} */ ({});
  let vialNodes = [];
  let snapshot = null;
  let profilePts = null;
  let profileMax = 1e-9;
  let alarmIndex = new Map();
  let slots = { a: -1, b: -1, s: -1, cip: -1, aIsCip: false };
  let lastAIdx = -1;
  let lastSlow = -1e9;
  let lastBed = -1e9;
  let bedPeriod = 0;
  let bedCostMs = 0;
  let impellerAngle = 0;
  let offMain = 0;
  let offSample = 0;
  let dashAccum = 0;
  let bedScale = 1;
  let toastTimer = 0;
  let layoutTimer = 0;
  let hoverId = null;
  let destroyed = false;
  let activeIds = [];
  const listeners = [];
  let ro = null;
  let mqMotion = null;
  let mqTheme = null;
  let themeObserver = null;

  /* ------------------------------------------------------------------------------------------ */
  /* helpers                                                                                     */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Register a DOM listener and remember it for `destroy`.
   * @param {EventTarget} target the event target
   * @param {string} type the event name
   * @param {Function} fn the handler
   * @param {object|boolean} [opt] listener options
   * @returns {void}
   */
  function on(target, type, fn, opt) {
    target.addEventListener(type, fn, opt);
    listeners.push([target, type, fn, opt]);
  }

  /**
   * Show a transient inline message.  Interlock refusals are never silent (§9.4.4).
   * @param {string} msg the message text
   * @param {boolean} [warn] render with the warning border
   * @returns {void}
   */
  function showToast(msg, warn) {
    toast.textContent = msg;
    toast.classList.toggle('is-warn', !!warn);
    toast.classList.add('is-shown');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('is-shown'); }, 3600);
  }

  /**
   * Write text into a cached node only when it changed — avoids needless layout invalidation.
   * @param {Element|null} node the text node holder
   * @param {string} s the new text
   * @returns {void}
   */
  function text(node, s) {
    if (node && node.textContent !== s) node.textContent = s;
  }

  /**
   * Toggle a class on a node without reading the DOM.
   * @param {Element|null} node the element
   * @param {string} name the class name
   * @param {boolean} onFlag whether the class should be present
   * @returns {void}
   */
  function cls(node, name, onFlag) {
    if (node) node.classList.toggle(name, !!onFlag);
  }

  /**
   * Cache the `id`-tagged nodes the update loop writes to.
   * @returns {void}
   */
  function cacheNodes() {
    /**
     * @param {string} id an element id
     * @returns {Element|null} the element
     */
    const q = (id) => el.querySelector('#' + id);
    nodes = {
      pumpG: q('pid-pump'), impeller: q('pid-impeller'),
      mixer: q('pid-mixer'), trapLiq: q('pid-trap-liq'), trapMen: q('pid-trap-men'),
      ivCh: q('pid-iv-ch'), ivMode: q('pid-iv-mode'), ivG: q('pid-iv'),
      cvCh: q('pid-cv-ch'), cvG: q('pid-cv'), cvPos: q('pid-cv-pos'), cvArc: q('pid-cv-arc'),
      cvCap: {
        n: q('pid-cv-cap-n'), e: q('pid-cv-cap-e'),
        s: q('pid-cv-cap-s'), w: q('pid-cv-cap-w'),
      },
      dvG: q('pid-dv'), dvArc: q('pid-dv-arc'),
      ftVal: q('pid-ft-val'), ftBox: q('pid-ft-box'),
      pctbVal: q('pid-pctb-val'), pctbBox: q('pid-pctb-box'),
      pt101Val: q('pid-pt101-val'), pt101Box: q('pid-pt101-box'),
      pt102Val: q('pid-pt102-val'), pt102Box: q('pid-pt102-box'),
      dpVal: q('pid-dp-val'), dpBox: q('pid-dp-box'),
      ttVal: q('pid-tt-val'), ttBox: q('pid-tt-box'),
      uvVal: q('pid-uv-val'), uvBox: q('pid-uv-box'), uvG: q('pid-uv'),
      ceVal: q('pid-ce-val'), ceBox: q('pid-ce-box'), ceG: q('pid-ce'),
      aeVal: q('pid-ae-val'), aeBox: q('pid-ae-box'), aeG: q('pid-ae'),
      wasteFill: q('pid-waste-fill'), wasteVal: q('pid-waste-val'),
      fracHead: q('pid-frac-head'), fracLabel: q('pid-frac-label'),
      vials: q('pid-vials'), profile: q('pid-profile-line'),
      tanks: [0, 1, 2, 3].map((i) => ({
        g: q('pid-tank-' + i), label: q('pid-tank-' + i + '-label'),
        name: q('pid-tank-' + i + '-name'), fill: q('pid-tank-' + i + '-fill'),
        men: q('pid-tank-' + i + '-men'), val: q('pid-tank-' + i + '-val'),
        unit: q('pid-tank-' + i + '-unit'),
      })),
      valves: {
        V1: q('pid-v-V1'), V2: q('pid-v-V2'), V3: q('pid-v-V3'), V4: q('pid-v-V4'),
      },
    };
  }

  /**
   * Build the flow-dash overlay and the reduced-motion direction arrows from the idle pipe layer.
   * Runs once at mount: one DOM read of each path's geometry, never inside `update`.
   * @returns {void}
   */
  function buildSegments() {
    const flowLayer = el.querySelector('#pid-flow-layer');
    const arrowLayer = el.querySelector('#pid-arrows');
    const bases = el.querySelectorAll('#pid-pipes path[data-seg]');
    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      const id = base.getAttribute('data-seg');
      const flow = base.cloneNode(false);
      flow.removeAttribute('data-seg');
      flowLayer.appendChild(flow);

      let arrow = null;
      let mid = null;
      let ang = 0;
      if (typeof base.getTotalLength === 'function') {
        try {
          const L = base.getTotalLength();
          if (L > 6) {
            const p0 = base.getPointAtLength(Math.max(0, L / 2 - 2));
            const p1 = base.getPointAtLength(Math.min(L, L / 2 + 2));
            mid = base.getPointAtLength(L / 2);
            ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
          }
        } catch (e) { mid = null; }
      }
      if (mid) {
        arrow = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrow.setAttribute('d', 'M-3.4,-3.2 L3.6,0 L-3.4,3.2 Z');
        arrow.setAttribute('transform',
          'translate(' + mid.x.toFixed(2) + ',' + mid.y.toFixed(2) + ') rotate(' + ang.toFixed(1) + ')');
        arrowLayer.appendChild(arrow);
      }
      pid._segs[id] = { base, flow, arrow, active: false, dir: 1, colour: '', ang };
    }
  }

  /**
   * (Re)build the fraction-collector vials for the current port list.
   * @returns {void}
   */
  function buildVials() {
    const ports = pid._config.skid.fracValve.ports;
    const host = nodes.vials;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    vialNodes = [];
    const n = Math.max(1, ports.length);
    const slotW = 128 / n;
    for (let i = 0; i < n; i++) {
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      const x = 241 + i * slotW;
      const w = Math.max(3, slotW - 2);
      const body = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      body.setAttribute('class', 'pid-vial');
      body.setAttribute('x', x.toFixed(2));
      body.setAttribute('y', '556');
      body.setAttribute('width', w.toFixed(2));
      body.setAttribute('height', '44');
      body.setAttribute('rx', '1.5');
      const fill = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      fill.setAttribute('class', 'pid-vial-fill');
      fill.setAttribute('x', x.toFixed(2));
      fill.setAttribute('y', '600');
      fill.setAttribute('width', w.toFixed(2));
      fill.setAttribute('height', '0');
      g.appendChild(fill);
      g.appendChild(body);
      host.appendChild(g);
      vialNodes.push({ body, fill, cx: x + w / 2 });
    }
  }

  /**
   * Allocate the caller-owned `bedAxialSnapshot` struct for the current config.
   * @returns {void}
   */
  function allocSnapshot() {
    const cells = (pid._config.ui && pid._config.ui.bedCells) || 120;
    snapshot = {
      pctB: new Float32Array(cells),
      species: new Float32Array(cells * 4),
      speciesIds: ['', '', '', ''],
      bedTopOffset_px: 0,
      channelling: pid._config.column.channellingFactor || 0,
      cMaxRef: null,
    };
    const pts = Math.min(60, cells);
    profilePts = new Array(pts);
    profileMax = 1e-9;
  }

  /**
   * Index `config.alarms` by id so the alarm state of a component is an array lookup, not a scan.
   * @returns {void}
   */
  function indexAlarms() {
    alarmIndex = new Map();
    const list = pid._config.alarms || [];
    for (let i = 0; i < list.length; i++) alarmIndex.set(list[i].id, i);
  }

  /**
   * Worst active/latched alarm severity attached to a component.
   * @param {string} componentId a `data-component` id
   * @returns {number} 0 none, 1 warn, 2+ alarm
   */
  function componentSeverity(componentId) {
    const ids = COMPONENT_ALARMS[componentId];
    if (!ids) return 0;
    const run = pid._run;
    const defs = pid._config.alarms || [];
    let worst = 0;
    for (let i = 0; i < ids.length; i++) {
      const k = alarmIndex.get(ids[i]);
      if (k === undefined) continue;
      const on = (run.alarmActive && run.alarmActive[k]) || (run.alarmLatched && run.alarmLatched[k]);
      if (!on) continue;
      const r = SEV_RANK[defs[k].severity] || 1;
      if (r > worst) worst = r;
    }
    return worst;
  }

  /**
   * Apply an alarm severity to a bubble / detector box.
   * @param {Element|null} box the box element
   * @param {string} componentId the component id
   * @returns {void}
   */
  function applyAlarmBorder(box, componentId) {
    const sev = componentSeverity(componentId);
    cls(box, 'is-warn', sev === 1);
    cls(box, 'is-alarm', sev >= 2);
  }

  /* ------------------------------------------------------------------------------------------ */
  /* layout                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Recompute the bed canvas position and backing size from the panel box.  Called only from the
   * ResizeObserver and from {@link scheduleRelayout}, never from `update` — `update` performs no
   * DOM reads (§6.24).
   * @returns {boolean} true once the panel had a non-zero box and the canvas was sized
   */
  function relayout() {
    if (destroyed) return false;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return false;
    const scale = Math.min(w / VIEW_W, h / VIEW_H);
    const ox = (w - VIEW_W * scale) / 2;
    const oy = (h - VIEW_H * scale) / 2;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    const cssW = BED_W * scale;
    const cssH = BED_H * scale;
    canvas.style.left = (ox + BED_X * scale).toFixed(2) + 'px';
    canvas.style.top = (oy + BED_Y * scale).toFixed(2) + 'px';
    canvas.style.width = cssW.toFixed(2) + 'px';
    canvas.style.height = cssH.toFixed(2) + 'px';
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    bedScale = bw / BED_W;
    lastBed = -1e9;
    return true;
  }

  /**
   * Size the bed canvas as soon as the panel has a box.
   *
   * A panel mounted into a container that is still `display:none` (or whose height has not yet
   * resolved) measures 0 x 0, and a `ResizeObserver` callback is only delivered on a rendering
   * step — which never arrives while the document is hidden.  Without this retry the bed would
   * keep its default 300 x 150 backing store and paint clipped.  The retry costs a handful of
   * timeouts and stops the moment a real box appears; it never runs inside `update`.
   *
   * @param {number} [tries] remaining attempts
   * @returns {void}
   */
  function scheduleRelayout(tries) {
    if (destroyed) return;
    if (relayout()) return;
    const left = (tries === undefined) ? 12 : tries;
    if (left <= 0) return;
    layoutTimer = setTimeout(() => { layoutTimer = 0; scheduleRelayout(left - 1); }, 120);
  }

  /**
   * Re-read the theme tokens and repaint everything that depends on them.
   * @returns {void}
   */
  function refreshTheme() {
    pid._theme = readTheme(el);
    lastBed = -1e9;
    lastSlow = -1e9;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* flow path                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Recompute the live flow path, the per-segment fluid colours and the dash directions from the
   * current valve alignment.  Pure with respect to `run`.
   * @returns {void}
   */
  function refreshFlowPath() {
    const config = pid._config;
    const run = pid._run;
    const theme = pid._theme;
    const v = run.valves;

    const aLive = !!v.inletA && !slots.aIsCip;
    const cipLive = !!v.inletA && slots.aIsCip;
    const bLive = !!v.inletB;
    const sLive = !!v.inletS;

    const colA = tankColour(config, theme, slots.a, slots.cip, false);
    const colB = tankColour(config, theme, slots.b, slots.cip, true);
    const colS = tankColour(config, theme, slots.s, slots.cip, false);
    const colCip = theme['--fluid-cip'];
    const feedA = cipLive ? colCip : colA;

    // The blended stream: lerp the two live endpoint colours through the 32-entry LUT.
    const lut = (cipLive || (slots.b >= 0 && slots.b === slots.cip))
      ? buildBlendLut(feedA, colB) : theme.lutAB;
    const gradCol = lutAt(lut, run.pctB_actual);

    const mode = v.sampleMode;
    const sampleInFeed = (mode === 'DIRECT' || mode === 'LOOP_INJECT');
    const feedCol = sampleInFeed ? colS : gradCol;

    const ids = activeIds;
    ids.length = 0;
    /**
     * @param {string} id the segment id
     * @param {string} colour the fluid colour
     * @param {number} [dir] +1 along the authored path, -1 against it
     * @returns {void}
     */
    const add = (id, colour, dir) => {
      ids.push(id);
      const seg = pid._segs[id];
      if (!seg) return;
      seg.dir = (dir === -1) ? -1 : 1;
      if (seg.colour !== colour) {
        seg.colour = colour;
        seg.base.style.stroke = colour;
      }
    };

    if (aLive) { add('s-tank-a', colA); add('s-drop-a', colA); }
    if (cipLive) {
      add('s-tank-c', colCip); add('s-drop-c', colCip); add('s-hdr-2', colCip);
      add('s-hdr-1', colCip);
    }
    if (bLive) { add('s-tank-b', colB); add('s-drop-b', colB); add('s-hdr-1', colB); }
    if (sLive) {
      add('s-tank-s', colS); add('s-drop-s', colS);
      if (mode !== 'LOOP_INJECT') add('s-samp-disc', colS);
    }
    if (mode === 'LOOP_FILL' || mode === 'LOOP_INJECT') add('s-loop', colS);

    const anyInlet = aLive || bLive || cipLive;
    if (anyInlet) {
      add('s-pump-out', gradCol); add('s-mix-out', gradCol);
      add('s-filt-out', gradCol); add('s-trap-out', gradCol);
    }
    if (anyInlet || sLive) add('s-iv-out', feedCol);

    const cvPos = v.columnValve;
    const inLine = (cvPos === 'DOWN' || cvPos === 'UP' || cvPos === 'CIP_DETECTOR_BYPASS');
    const dirCol = (cvPos === 'UP') ? -1 : 1;
    if (inLine) {
      add('s-cv-top', feedCol, dirCol);
      add('s-col-bot', feedCol, dirCol);
    }
    if (cvPos !== 'ISOLATED') add('s-cv-out', feedCol);

    if (cvPos === 'CIP_DETECTOR_BYPASS') {
      add('s-cip-shunt', feedCol);
    } else if (cvPos !== 'ISOLATED') {
      add('s-det-in', feedCol); add('s-uv-ce', feedCol);
      add('s-ce-ae', feedCol); add('s-det-out', feedCol);
    }
    if (cvPos !== 'ISOLATED') {
      add('s-dv-in', feedCol);
      if (v.outletValve === 'WASTE') add('s-waste', theme['--fluid-waste']);
      else add('s-collect', feedCol);
    }

    setActiveSegments(pid, ids, Math.abs(run.Q_actual_mLs));
    pid._sampleFlow_mLs = Math.abs(run.QS_mLs || 0);
  }

  /**
   * Advance the dash offsets.  One accumulator per chain so dashes flow continuously through
   * junctions; a segment whose authored direction opposes the flow gets the negated offset and its
   * dashes visibly run backwards (§9.2, §11 C-39).
   * @param {number} dt_s elapsed wall seconds since the last dash update
   * @returns {void}
   */
  function advanceDashes(dt_s) {
    if (pid._reducedMotion) return;
    const qmax = pid._config.skid.Qmax_mLs || 1;
    const kMain = DASH_PX_PER_S_AT_QMAX / qmax;
    offMain -= pid._flow_mLs * kMain * dt_s;
    offSample -= (pid._sampleFlow_mLs || 0) * kMain * dt_s;
    if (offMain < -4096 || offMain > 4096) offMain = 0;
    if (offSample < -4096 || offSample > 4096) offSample = 0;
    for (let i = 0; i < SEGMENT_IDS.length; i++) {
      const id = SEGMENT_IDS[i];
      const seg = pid._segs[id];
      if (!seg || !seg.active) continue;
      const base = SAMPLE_CHAIN[id] ? offSample : offMain;
      seg.flow.setAttribute('stroke-dashoffset', (seg.dir * base).toFixed(2));
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* slow lane — tag values, valves, tanks, bed snapshot                                          */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Update every tag bubble, valve, tank and collector graphic.  Runs at 10 Hz.
   * @param {boolean} structural true when list content may have changed
   * @returns {void}
   */
  function slowUpdate(structural) {
    const config = pid._config;
    const run = pid._run;
    const theme = pid._theme;

    if (!slots.aIsCip && slots.a >= 0) lastAIdx = slots.a;
    slots = resolveTankSlots(config, run, lastAIdx);

    /* ---- tanks ---- */
    const slotIdx = [slots.a, slots.b, slots.s, slots.cip];
    const slotLabel = ['BUFFER A', 'BUFFER B', 'SAMPLE', 'CIP'];
    const slotLive = [
      !!run.valves.inletA && !slots.aIsCip, !!run.valves.inletB,
      !!run.valves.inletS, !!run.valves.inletA && slots.aIsCip,
    ];
    for (let i = 0; i < 4; i++) {
      const nd = nodes.tanks[i];
      const k = slotIdx[i];
      if (k < 0 || k >= config.tanks.length) {
        cls(nd.g, 'is-active', false);
        text(nd.name, '—');
        text(nd.val, '—');
        text(nd.unit, '');
        if (nd.fill) nd.fill.setAttribute('height', '0');
        continue;
      }
      const t = config.tanks[k];
      const vol = run.tankVolume_mL[k];
      const cap = t.nominalVolume_mL || Math.max(vol, 1);
      const frac = clamp(vol / cap, 0, 1);
      const yTop = 84 - frac * 58;
      const colour = tankColour(config, theme, k, slots.cip, i === 1);
      if (nd.fill) {
        nd.fill.setAttribute('y', yTop.toFixed(2));
        nd.fill.setAttribute('height', (84 - yTop).toFixed(2));
        nd.fill.style.fill = colour;
      }
      if (nd.men) {
        nd.men.setAttribute('y1', yTop.toFixed(2));
        nd.men.setAttribute('y2', yTop.toFixed(2));
        nd.men.style.stroke = colour;
      }
      const fv = fmtTankVolume(vol);
      text(nd.label, slotLabel[i]);
      text(nd.name, String(t.label || t.id).slice(0, 14));
      text(nd.val, fv.value);
      text(nd.unit, fv.unit);
      const lowPct = (t.lowLevelPct != null ? t.lowLevelPct : 10) / 100;
      cls(nd.g, 'is-low', frac < lowPct && vol > (t.emptyLevel_mL || 0));
      cls(nd.g, 'is-empty', vol <= (t.emptyLevel_mL || 0));
      cls(nd.g, 'is-active', slotLive[i]);
      const hit = nd.g.querySelector('.pid-hit');
      if (hit) {
        hit.setAttribute('aria-label',
          slotLabel[i] + ' tank, ' + (t.label || t.id) + ', '
          + fv.value + ' ' + fv.unit + ', ' + Math.round(frac * 100) + ' percent full');
      }
    }

    /* ---- inlet valves ---- */
    const vmap = { V1: slotLive[0], V2: slotLive[1], V3: slotLive[2], V4: slotLive[3] };
    const vcol = {
      V1: tankColour(config, theme, slots.a, slots.cip, false),
      V2: tankColour(config, theme, slots.b, slots.cip, true),
      V3: tankColour(config, theme, slots.s, slots.cip, false),
      V4: theme['--fluid-cip'],
    };
    const vlabel = { V1: 'buffer A', V2: 'buffer B', V3: 'sample', V4: 'CIP' };
    for (const key of ['V1', 'V2', 'V3', 'V4']) {
      const g = nodes.valves[key];
      if (!g) continue;
      cls(g, 'is-open', vmap[key]);
      const bore = g.querySelector('.pid-valve-bore');
      if (bore) bore.style.stroke = vcol[key];
      const hit = g.querySelector('.pid-hit');
      if (hit) {
        hit.setAttribute('aria-label',
          'Inlet valve ' + key + ', ' + vlabel[key] + ', ' + (vmap[key] ? 'open' : 'closed'));
      }
    }

    /* ---- pump ---- */
    cls(nodes.pumpG, 'is-running', run.Q_actual_mLs > 1e-6);

    /* ---- air trap ---- */
    if (nodes.trapLiq) {
      const trapSeg = (config.skid.segments || []).find((s) => s.id === 'G5');
      const trapV = trapSeg ? trapSeg.V_mL : 50;
      const gasFrac = clamp((run.trapHeadspace_mL || 0) / Math.max(trapV, 1e-9), 0, 1);
      const yTop = 146 + gasFrac * 40;
      nodes.trapLiq.setAttribute('y', yTop.toFixed(2));
      nodes.trapLiq.setAttribute('height', (186 - yTop).toFixed(2));
      nodes.trapLiq.style.fill = lutAt(theme.lutAB, run.pctB_actual);
      if (nodes.trapMen) {
        nodes.trapMen.setAttribute('y1', yTop.toFixed(2));
        nodes.trapMen.setAttribute('y2', yTop.toFixed(2));
      }
    }

    /* ---- injection valve ---- */
    const mode = run.valves.sampleMode;
    const ivKey = (mode === 'LOOP_INJECT') ? 'INJECT' : (mode === 'DIRECT') ? 'DIRECT' : 'LOAD';
    if (nodes.ivCh && nodes.ivCh.getAttribute('data-pos') !== ivKey) {
      nodes.ivCh.setAttribute('data-pos', ivKey);
      nodes.ivCh.setAttribute('d', IV_CHANNELS[ivKey]);
    }
    if (nodes.ivCh) {
      nodes.ivCh.style.stroke = (mode ? tankColour(config, theme, slots.s, slots.cip, false)
        : theme['--pipe-idle']);
    }
    text(nodes.ivMode, mode ? (ivKey === 'INJECT' ? 'INJECT' : ivKey) : 'LOAD');

    /* ---- column valve ---- */
    const pos = run.valves.columnValve;
    const cmd = run.valves.cmdColumnValve;
    const moving = run.valves.moveRemaining_s > 0;
    if (nodes.cvCh && nodes.cvCh.getAttribute('data-pos') !== pos) {
      nodes.cvCh.setAttribute('data-pos', pos);
      nodes.cvCh.setAttribute('d', CV_CHANNELS[pos] || '');
      const caps = CV_CAPS[pos] || [];
      for (const key of ['n', 'e', 's', 'w']) {
        cls(nodes.cvCap[key], 'is-capped', caps.indexOf(key) >= 0);
      }
    }
    if (nodes.cvCh) {
      const feed = (pos === 'ISOLATED') ? theme['--pipe-idle'] : lutAt(theme.lutAB, run.pctB_actual);
      nodes.cvCh.style.stroke = feed;
    }
    text(nodes.cvPos, moving ? 'MOVING' : String(pos));
    cls(nodes.cvArc, 'is-moving', moving);
    if (moving && nodes.cvArc) {
      const tot = Math.max(0.05, config.skid.fracValve.tSwitch_s * 2);
      const frac = clamp(1 - run.valves.moveRemaining_s / tot, 0, 1);
      const circ = 2 * Math.PI * 18;
      nodes.cvArc.setAttribute('stroke-dasharray', (circ * frac).toFixed(1) + ' ' + circ.toFixed(1));
    }
    cls(nodes.cvG, 'is-fault', !moving && pos !== cmd && run.valves.mismatch_s > 0.5);
    const cvHit = nodes.cvG && nodes.cvG.querySelector('.pid-hit');
    if (cvHit) {
      cvHit.setAttribute('aria-label',
        'Column valve CV-101, position ' + (moving ? 'moving to ' + cmd : pos));
    }
    applyAlarmBorder(nodes.cvG, 'CV-101');

    /* ---- diverter + collector ---- */
    const outlet = run.valves.outletValve;
    const fmoving = !!run.frac.moving;
    cls(nodes.dvG, 'is-open', true);
    cls(nodes.dvG, 'is-moving', fmoving);
    cls(nodes.dvArc, 'is-moving', fmoving);
    if (fmoving && nodes.dvArc) {
      const frac = clamp(run.frac.moveElapsed_s / Math.max(config.skid.fracValve.tSwitch_s, 1e-6), 0, 1);
      const circ = 2 * Math.PI * 11;
      nodes.dvArc.setAttribute('stroke-dasharray', (circ * frac).toFixed(1) + ' ' + circ.toFixed(1));
    }
    const dvBore = nodes.dvG && nodes.dvG.querySelector('.pid-valve-bore');
    if (dvBore) {
      dvBore.style.stroke = (outlet === 'WASTE')
        ? theme['--fluid-waste'] : lutAt(theme.lutAB, run.pctB_actual);
    }
    const ports = config.skid.fracValve.ports;
    if (structural && vialNodes.length !== ports.length) buildVials();
    const cap = config.skid.fracValve.portCapacity_mL || 1;
    let activeVial = -1;
    for (let i = 0; i < vialNodes.length; i++) {
      const vn = vialNodes[i];
      const vol = run.portVolume_mL[i] || 0;
      const h = clamp(vol / cap, 0, 1) * 44;
      vn.fill.setAttribute('y', (600 - h).toFixed(2));
      vn.fill.setAttribute('height', h.toFixed(2));
      vn.fill.style.fill = lutAt(theme.lutAB, run.pctB_actual);
      const isActive = (ports[i] === outlet);
      if (isActive) activeVial = i;
      cls(vn.body, 'is-active', isActive);
    }
    if (nodes.fracHead) {
      const hx = (activeVial >= 0) ? vialNodes[activeVial].cx : 236;
      nodes.fracHead.setAttribute('transform', 'translate(' + hx.toFixed(2) + ',0)');
    }
    text(nodes.fracLabel, outlet === 'WASTE' ? 'WASTE'
      : outlet + ' · ' + nfix(run.portVolume_mL[ports.indexOf(outlet)] || 0, 0) + ' mL');
    applyAlarmBorder(nodes.dvG, 'FC-101');

    /* ---- waste ---- */
    const wasteFrac = clamp(run.wasteVolume_mL / Math.max(config.skid.wasteCapacity_mL, 1), 0, 1);
    if (nodes.wasteFill) {
      const h = wasteFrac * 38;
      nodes.wasteFill.setAttribute('y', (614 - h).toFixed(2));
      nodes.wasteFill.setAttribute('height', h.toFixed(2));
    }
    text(nodes.wasteVal, (run.wasteVolume_mL / 1000).toFixed(1));

    /* ---- tag values ---- */
    text(nodes.ftVal, nfix(60 * run.Q_actual_mLs, 1));
    text(nodes.pctbVal, nfix(run.pctB_actual, 1));
    text(nodes.pt101Val, nfix(run.press.P1disp_bar, 2));
    text(nodes.pt102Val, nfix(run.press.P2disp_bar, 2));
    text(nodes.dpVal, nfix(run.dP_bar, 3));
    text(nodes.ttVal, nfix(run.T_fluid_C, 1));
    text(nodes.uvVal, nfix(1000 * run.uv.Afilt[0], 1));
    text(nodes.ceVal, nfix(run.cond.kappaDisp_mScm, 2));
    text(nodes.aeVal, nfix(run.ph.pHfilt, 2));

    applyAlarmBorder(nodes.ftBox, 'P-101');
    applyAlarmBorder(nodes.pt101Box, 'PT-101');
    applyAlarmBorder(nodes.pt102Box, 'PT-102');
    applyAlarmBorder(nodes.dpBox, 'PDT-101');
    applyAlarmBorder(nodes.ttBox, 'TT-101');
    applyAlarmBorder(nodes.uvBox, 'UV-101');
    applyAlarmBorder(nodes.ceBox, 'CE-101');
    applyAlarmBorder(nodes.aeBox, 'AE-101');

    /* ---- detector quality (§5.3) ---- */
    const bypassed = run.valves.columnValve === 'CIP_DETECTOR_BYPASS';
    const qf = run.qualityFlags | 0;
    const detState = [
      [nodes.uvG, bypassed, (qf & 0x0004) !== 0, (qf & (0x0001 | 0x0002 | 0x0008 | 0x0400)) !== 0],
      [nodes.ceG, bypassed, (qf & 0x0010) !== 0, (qf & (0x0020 | 0x0400)) !== 0],
      [nodes.aeG, bypassed, (qf & 0x0040) !== 0, (qf & (0x0080 | 0x0400)) !== 0],
    ];
    for (let i = 0; i < detState.length; i++) {
      const row = detState[i];
      cls(row[0], 'is-bypassed', row[1]);
      cls(row[0], 'is-invalid', !row[1] && row[2]);
      cls(row[0], 'is-suspect', !row[1] && !row[2] && row[3]);
    }

    /* ---- manual-mode outline (§9.4.4) ---- */
    cls(el, 'is-manual', !!run.manualOverride);

    /* ---- flow path ---- */
    refreshFlowPath();

    /* ---- screen-reader summary ---- */
    srSummary.textContent = 'Column valve ' + pos + ', flow ' + nfix(60 * run.Q_actual_mLs, 0)
      + ' millilitres per minute, ' + nfix(run.pctB_actual, 0) + ' percent buffer B, inlet pressure '
      + nfix(run.press.P1disp_bar, 2) + ' bar, UV 280 ' + nfix(1000 * run.uv.Afilt[0], 0)
      + ' milli absorbance units, outlet to ' + outlet + '.';
  }

  /**
   * Repaint the bed canvas and the mini axial profile from a fresh `bedAxialSnapshot`.
   * @returns {void}
   */
  function bedUpdate() {
    const config = pid._config;
    const run = pid._run;
    if (!bedCtx || !snapshot || !run.bed || !run.col) return;

    bedAxialSnapshot(config, run, snapshot);
    snapshot.cMaxRef = run.bed.snapshotCMaxRef;

    const cvPos = run.valves.columnValve;
    const showAir = (cvPos === 'BYPASS' || cvPos === 'CIP_DETECTOR_BYPASS');
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    paintBed(bedCtx, snapshot, pid._theme, {
      dpr: bedScale,
      reducedMotion: pid._reducedMotion,
      seed: config.seed,
      showAir,
      airFraction: run.fAirDet,
      airPhase: (run.V_tot_mL / Math.max(config.column.V_mL, 1e-9)) % 1,
    });
    if (t0) {
      const dt = performance.now() - t0;
      bedCostMs = bedCostMs * 0.9 + dt * 0.1;
      bedPeriod = (bedCostMs > BED_BUDGET_MS) ? 33 : 0;
    }

    /* ---- mini axial profile: total UV-absorbing species vs z ---- */
    if (nodes.profile && profilePts) {
      const n = snapshot.pctB.length;
      const pts = profilePts.length;
      const w = pid._eps280 || null;
      let mx = 0;
      const buf = profilePts;
      for (let p = 0; p < pts; p++) {
        const i0 = Math.floor(p * n / pts);
        const i1 = Math.max(i0 + 1, Math.floor((p + 1) * n / pts));
        let acc = 0;
        for (let b = 0; b < 4; b++) {
          const wt = w ? w[b] : 1;
          if (wt <= 0) continue;
          const off = b * n;
          let s = 0;
          for (let i = i0; i < i1; i++) s += snapshot.species[off + i];
          acc += (s / (i1 - i0)) * wt;
        }
        buf[p] = acc;
        if (acc > mx) mx = acc;
      }
      if (mx > profileMax) profileMax = mx;
      else profileMax = Math.max(mx, profileMax * 0.995, 1e-9);
      let d = '';
      for (let p = 0; p < pts; p++) {
        const x = 254 + clamp(buf[p] / profileMax, 0, 1) * 21;
        const y = 282 + (p + 0.5) / pts * 180;
        d += (p ? ' ' : '') + x.toFixed(1) + ',' + y.toFixed(1);
      }
      nodes.profile.setAttribute('points', d);
    }
  }

  /**
   * Precompute the per-band 280 nm extinction weights used by the mini axial profile.
   * @returns {void}
   */
  function cacheBandWeights() {
    const config = pid._config;
    const w = [0, 0, 0, 0];
    for (let b = 0; b < 4; b++) {
      const id = snapshot ? snapshot.speciesIds[b] : '';
      if (!id) continue;
      for (let i = 0; i < config.species.length; i++) {
        if (config.species[i].id === id) {
          w[b] = Math.max(0, config.species[i].eps280_Lgcm || 0)
            * (config.species[i].MW_gmol || 1) / 1000;
          break;
        }
      }
    }
    pid._eps280 = w;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* interaction                                                                                 */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Handle activation (click / Enter / Space) of a schematic component.  Simple valve moves are
   * issued through `ctx.sim.manualSet`; everything else is published on the bus for the host view
   * to open the appropriate editor.  Refusals surface their `reason` verbatim.
   * @param {string} componentId the component id
   * @returns {void}
   */
  function activate(componentId) {
    const sim = pid._ctx.sim || {};
    const run = pid._run;
    const config = pid._config;
    if (pid._ctx.bus && pid._ctx.bus.emit) {
      pid._ctx.bus.emit('pid-activate', { componentId, ctx: pid._ctx });
    }
    const isValve = /^(V[1-4]|CV-101|DV-101)$/.test(componentId);
    if (!isValve) return;
    if (!run.manualOverride) {
      showToast('Manual control is off — enable MANUAL to operate ' + componentId + '.', true);
      return;
    }
    if (typeof sim.manualSet !== 'function') return;

    let cmd = null;
    if (componentId === 'V1' || componentId === 'V2' || componentId === 'V4') {
      const side = (componentId === 'V2') ? 'B' : 'A';
      const key = (side === 'B') ? 'inletB' : 'inletA';
      const avail = Object.keys(config.inletAssignments || {})
        .filter((p) => p.charAt(0) === side && config.inletAssignments[p]);
      if (!avail.length) { showToast('No tank is assigned to inlet side ' + side + '.', true); return; }
      if (componentId === 'V4') {
        const cipTank = config.tanks[slots.cip];
        const port = cipTank ? avail.find((p) => config.inletAssignments[p] === cipTank.id) : null;
        cmd = {}; cmd[key] = port || avail[avail.length - 1];
      } else {
        const cur = avail.indexOf(run.valves[key]);
        cmd = {}; cmd[key] = avail[(cur + 1) % avail.length];
      }
    } else if (componentId === 'V3') {
      const avail = Object.keys(config.inletAssignments || {})
        .filter((p) => p.charAt(0) === 'S' && config.inletAssignments[p]);
      cmd = { inletS: run.valves.inletS ? null : (avail[0] || null) };
      if (!run.valves.inletS && !avail.length) {
        showToast('No sample tank is assigned to an S port.', true);
        return;
      }
    } else if (componentId === 'CV-101') {
      const order = ['BYPASS', 'DOWN', 'UP', 'ISOLATED', 'CIP_DETECTOR_BYPASS'];
      const cur = order.indexOf(run.valves.cmdColumnValve);
      cmd = { columnValve: order[(cur + 1) % order.length] };
    } else if (componentId === 'DV-101') {
      const ports = config.skid.fracValve.ports;
      if (run.valves.outletValve === 'WASTE') {
        cmd = { outletValve: ports[clamp(run.frac.nextPortIdx, 0, ports.length - 1)] || 'WASTE' };
      } else {
        cmd = { outletValve: 'WASTE' };
      }
    }
    if (!cmd) return;
    const r = sim.manualSet(pid._ctx, cmd);
    if (r && r.ok === false) showToast(String(r.reason || 'Command refused'), true);
  }

  /**
   * Compose and position the hover tooltip from `data/glossary.js` plus the live value.
   * @param {string} componentId the component id
   * @param {number} clientX pointer x in client coordinates
   * @param {number} clientY pointer y in client coordinates
   * @returns {void}
   */
  function showTip(componentId, clientX, clientY) {
    const run = pid._run;
    const F = pid._ctx.fmt || {};
    let glossId = componentId;
    if (componentId === 'TK-A') glossId = tankIdOf(slots.a);
    else if (componentId === 'TK-B') glossId = tankIdOf(slots.b);
    else if (componentId === 'TK-S') glossId = tankIdOf(slots.s);
    else if (componentId === 'TK-CIP') glossId = tankIdOf(slots.cip);
    else if (/^V[1-4]$/.test(componentId)) glossId = 'inlet-valve';
    else if (componentId === 'PCTB') glossId = 'skid.gradientMode';
    else if (componentId === 'WASTE') glossId = 'skid.wasteCapacity_mL';

    const entry = glossaryFor(glossId);
    if (!entry) { hideTip(); return; }

    let live = '';
    if (componentId === 'PT-101') {
      live = (typeof F.fmtPressure === 'function')
        ? F.fmtPressure(run.press.P1disp_bar) : nfix(run.press.P1disp_bar, 3) + ' bar';
    } else if (componentId === 'PT-102') {
      live = (typeof F.fmtPressure === 'function')
        ? F.fmtPressure(run.press.P2disp_bar) : nfix(run.press.P2disp_bar, 3) + ' bar';
    } else if (componentId === 'PDT-101') {
      live = nfix(run.dP_bar, 3) + ' bar';
    } else if (componentId === 'FT-101' || componentId === 'P-101') {
      live = (typeof F.fmtFlow === 'function')
        ? F.fmtFlow(run.Q_actual_mLs, pid._config) : nfix(60 * run.Q_actual_mLs, 2) + ' mL/min';
    } else if (componentId === 'UV-101') {
      live = nfix(1000 * run.uv.Afilt[0], 1) + ' mAU (280 nm), '
        + nfix(1000 * run.uv.Afilt[1], 1) + ' mAU (260 nm)';
    } else if (componentId === 'CE-101') {
      live = nfix(run.cond.kappaDisp_mScm, 3) + ' mS/cm';
    } else if (componentId === 'AE-101') {
      live = nfix(run.ph.pHfilt, 2) + ' pH';
    } else if (componentId === 'TT-101') {
      live = nfix(run.T_fluid_C, 1) + ' °C fluid, ' + nfix(run.T_cell_C, 1) + ' °C cell';
    } else if (componentId === 'CV-101') {
      live = 'Position ' + run.valves.columnValve
        + (run.valves.cmdColumnValve !== run.valves.columnValve
          ? ' (commanded ' + run.valves.cmdColumnValve + ')' : '');
    } else if (componentId === 'DV-101' || componentId === 'FC-101') {
      live = 'Outlet ' + run.valves.outletValve + ', ' + run.frac.records.length + ' fractions closed';
    } else if (componentId === 'WASTE') {
      live = (run.wasteVolume_mL / 1000).toFixed(2) + ' L of '
        + (pid._config.skid.wasteCapacity_mL / 1000).toFixed(0) + ' L';
    } else if (componentId === 'PCTB') {
      live = nfix(run.pctB_actual, 1) + ' % B at the mixer, '
        + nfix(run.pctB_colInlet, 1) + ' % B at the column inlet';
    } else if (componentId.indexOf('TK-') === 0) {
      const k = { 'TK-A': slots.a, 'TK-B': slots.b, 'TK-S': slots.s, 'TK-CIP': slots.cip }[componentId];
      if (k >= 0) {
        const fv = fmtTankVolume(run.tankVolume_mL[k]);
        live = fv.value + ' ' + fv.unit + ' remaining';
      }
    } else if (componentId === 'C-101') {
      live = 'Bed ΔP ' + nfix(run.dPbed_bar, 3) + ' bar, '
        + nfix(run.V_tot_mL / pid._config.column.V_mL, 2) + ' CV delivered';
    }

    tip.innerHTML = '';
    const b = doc.createElement('b');
    b.textContent = entry.term;
    tip.appendChild(b);
    tip.appendChild(doc.createTextNode(entry.short));
    if (live) {
      const lv = doc.createElement('span');
      lv.className = 'pid-tip-val';
      lv.textContent = live;
      tip.appendChild(lv);
    }
    const ty = doc.createElement('span');
    ty.className = 'pid-tip-typ';
    ty.textContent = entry.typical;
    tip.appendChild(ty);

    const box = el.getBoundingClientRect();
    const x = clamp(clientX - box.left + 14, 4, Math.max(4, box.width - 268));
    const y = clamp(clientY - box.top + 14, 4, Math.max(4, box.height - 120));
    tip.style.left = x.toFixed(0) + 'px';
    tip.style.top = y.toFixed(0) + 'px';
    tip.classList.add('is-shown');
  }

  /**
   * Resolve a tank index to its id, for glossary lookup.
   * @param {number} k a `config.tanks` index
   * @returns {string} the tank id, or an empty string
   */
  function tankIdOf(k) {
    const t = (k >= 0 && k < pid._config.tanks.length) ? pid._config.tanks[k] : null;
    return t ? t.id : '';
  }

  /**
   * Hide the hover tooltip.
   * @returns {void}
   */
  function hideTip() {
    hoverId = null;
    tip.classList.remove('is-shown');
  }

  /* ------------------------------------------------------------------------------------------ */
  /* bus                                                                                         */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Rebind every cached reference after `config`/`run` are replaced (§2.4, §6.4).
   * @returns {void}
   */
  function rebind() {
    pid._config = pid._ctx.config;
    pid._run = pid._ctx.run;
    lastAIdx = -1;
    indexAlarms();
    allocSnapshot();
    buildVials();
    profileMax = 1e-9;
    TEXTURE_CACHE.delete(canvas);
    lastSlow = -1e9;
    lastBed = -1e9;
    if (snapshot && pid._run.bed && pid._run.col) {
      bedAxialSnapshot(pid._config, pid._run, snapshot);
      cacheBandWeights();
    }
  }

  const onConfigReplaced = () => { if (!destroyed) rebind(); };

  /* ------------------------------------------------------------------------------------------ */
  /* Panel API                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Mount the panel: inject the static SVG once, build the derived DOM, wire listeners.
   * @returns {void}
   */
  function mount() {
    if (pid._mounted) return;
    pid._mounted = true;
    el.innerHTML = PID_TEMPLATE;
    el.appendChild(canvas);
    el.appendChild(toast);
    el.appendChild(tip);
    el.appendChild(srSummary);
    rootEl.appendChild(el);


    bedCtx = canvas.getContext('2d');
    cacheNodes();
    buildSegments();
    indexAlarms();
    allocSnapshot();
    buildVials();
    refreshTheme();

    if (typeof matchMedia === 'function') {
      mqMotion = matchMedia('(prefers-reduced-motion: reduce)');
      pid._reducedMotion = mqMotion.matches;
      const onMotion = () => {
        pid._reducedMotion = mqMotion.matches;
        for (let i = 0; i < SEGMENT_IDS.length; i++) {
          const seg = pid._segs[SEGMENT_IDS[i]];
          if (!seg) continue;
          seg.flow.classList.toggle('is-flowing', seg.active && !pid._reducedMotion);
          if (seg.arrow) seg.arrow.classList.toggle('is-shown', seg.active && pid._reducedMotion);
        }
      };
      if (mqMotion.addEventListener) on(mqMotion, 'change', onMotion);
      mqTheme = matchMedia('(prefers-color-scheme: dark)');
      if (mqTheme.addEventListener) on(mqTheme, 'change', refreshTheme);
    }

    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => { relayout(); });
      ro.observe(el);
    }
    scheduleRelayout();

    if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
      themeObserver = new MutationObserver(refreshTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-theme', 'class'],
      });
    }

    on(el, 'click', (e) => {
      const hit = pidHitTest(pid, e);
      if (hit) activate(hit.componentId);
    });
    on(el, 'keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const hit = pidHitTest(pid, e);
      if (!hit) return;
      e.preventDefault();
      activate(hit.componentId);
    });
    on(el, 'pointermove', (e) => {
      const hit = pidHitTest(pid, e);
      if (!hit) { if (hoverId) hideTip(); return; }
      if (hit.componentId !== hoverId) hoverId = hit.componentId;
      showTip(hit.componentId, e.clientX, e.clientY);
    });
    on(el, 'pointerleave', hideTip);
    on(el, 'focusin', (e) => {
      const hit = pidHitTest(pid, e);
      if (!hit) return;
      const box = e.target.getBoundingClientRect();
      showTip(hit.componentId, box.left + box.width / 2, box.bottom);
    });
    on(el, 'focusout', hideTip);

    const bus = pid._ctx.bus;
    if (bus && typeof bus.on === 'function') {
      bus.on('config-replaced', onConfigReplaced);
      bus.on('preset-loaded', onConfigReplaced);
    }

    if (pid._run.bed && pid._run.col && snapshot) {
      bedAxialSnapshot(pid._config, pid._run, snapshot);
      cacheBandWeights();
    }
    slowUpdate(true);
  }

  /**
   * Per-frame update.  Called at most once per rAF frame by `ui/app.js`; performs no DOM reads and
   * mutates neither `config` nor `run`.
   *
   * Three lanes: the bed canvas (60 fps, dropped to 30 fps automatically when the measured paint
   * exceeds the 2 ms budget), the dash offsets and impeller (10 Hz / per-frame), and the tag values
   * and valve graphics (10 Hz).
   *
   * @param {{now_ms?:number, dt_ms?:number, tick?:number, structural?:boolean}} [frameInfo]
   *        the §6.24 frame descriptor
   * @returns {void}
   */
  function update(frameInfo) {
    if (!pid._mounted || destroyed) return;
    const fi = frameInfo || {};
    const now = (typeof fi.now_ms === 'number') ? fi.now_ms
      : ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
    const dt_s = Math.min(0.25, Math.max(0, (fi.dt_ms || 16.7) / 1000));

    if (pid._config !== pid._ctx.config || pid._run !== pid._ctx.run) rebind();

    if (now - lastSlow >= SLOW_MS) {
      lastSlow = now;
      slowUpdate(!!fi.structural);
    }

    dashAccum += dt_s;
    if (dashAccum >= 0.1) {
      advanceDashes(dashAccum);
      dashAccum = 0;
    }

    if (!pid._reducedMotion && nodes.impeller && pid._run.Q_actual_mLs > 1e-6) {
      const qmax = pid._config.skid.Qmax_mLs || 1;
      impellerAngle = (impellerAngle + (60 + 300 * clamp(pid._run.Q_actual_mLs / qmax, 0, 1)) * dt_s) % 360;
      nodes.impeller.setAttribute('transform', 'rotate(' + impellerAngle.toFixed(1) + ')');
    }

    if (now - lastBed >= bedPeriod) {
      lastBed = now;
      bedUpdate();
    }
  }

  /**
   * Tear the panel down: drop listeners, observers, timers and DOM.
   * @returns {void}
   */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (toastTimer) clearTimeout(toastTimer);
    if (layoutTimer) clearTimeout(layoutTimer);
    for (let i = 0; i < listeners.length; i++) {
      const [t, ty, fn, opt] = listeners[i];
      t.removeEventListener(ty, fn, opt);
    }
    listeners.length = 0;
    if (ro) { ro.disconnect(); ro = null; }
    if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
    const bus = pid._ctx.bus;
    if (bus && typeof bus.off === 'function') {
      bus.off('config-replaced', onConfigReplaced);
      bus.off('preset-loaded', onConfigReplaced);
    }
    TEXTURE_CACHE.delete(canvas);
    if (el.parentNode) el.parentNode.removeChild(el);
    pid._segs = {};
    nodes = {};
    vialNodes = [];
    snapshot = null;
    bedCtx = null;

    pid._mounted = false;
  }

  pid.mount = mount;
  pid.update = update;
  pid.destroy = destroy;
  return pid;
}
