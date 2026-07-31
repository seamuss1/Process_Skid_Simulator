/**
 * @file src/ui/pid.js — the plant P&ID: ISA-5.1 instrument bubbles, service-coloured process lines,
 * beveled equipment, sunken label boxes and the packed-bed canvas painter.
 *
 * The schematic is inline SVG on a `viewBox="0 0 1200 440"` grid drawn in the "FT-CLASSIC" idiom of
 * a FactoryTalk View SE / InTouch operator screen: square corners, beveled grey chrome, sunken
 * near-black label boxes with lime PV digits, round glassy lamps, ISA bubbles wired to their
 * equipment by thin leader lines.
 *
 * Static geometry is authored once in {@link PID_TEMPLATE} and injected with `innerHTML` at panel
 * construction ONLY; every subsequent update writes `class` / `style` / `transform` / `textContent`
 * / `d` on `id`-tagged nodes.  The SVG is never re-serialised.
 *
 * The packed bed is a sibling absolutely-positioned `<canvas>` aligned to the vessel interior at
 * SVG (508,134)-(612,366) — 104 x 232 schematic units — painted by {@link paintBed} from
 * `physics/bed.js::bedAxialSnapshot`.
 *
 * This module is READ-ONLY over `config` and `run`.  Every mutation goes through `ctx.sim`.
 */

import { bedAxialSnapshot } from '../physics/bed.js';
import { clamp, createRng, nextFloat, RNG_STREAMS } from '../core/util.js';
import { glossaryFor } from '../data/glossary.js';
import * as overlay from './overlay.js';

/* ===============================================================================================
 * 1.  GEOMETRY
 * =============================================================================================*/

/** Schematic viewBox width, user units. @type {number} */
const VIEW_W = 1200;
/** Schematic viewBox height, user units. @type {number} */
const VIEW_H = 440;

/** Bed canvas left edge, schematic units. @type {number} */
const BED_X = 508;
/** Bed canvas top edge, schematic units. @type {number} */
const BED_Y = 134;
/** Bed canvas logical width. @type {number} */
const BED_W = 104;
/** Bed canvas logical height. @type {number} */
const BED_H = 232;

/** Maximum bed-top compression offset, px — matches `bed.js::BED_TOP_OFFSET_MAX_PX`. */
const BED_TOP_MAX_PX = 18;

/** Number of resin beads in the static bed texture. @type {number} */
const BEAD_COUNT = 1400;

/** Mobile-phase tint strip count. @type {number} */
const TINT_STRIPS = 120;

/** Entries in the precomputed buffer-A -> buffer-B colour LUT. @type {number} */
const LUT_N = 32;

/** Slow-lane (tag values, valves, snapshot) period, ms — 10 Hz. */
const SLOW_MS = 100;

/** Bed repaint budget, ms.  Exceeding it drops the bed to 30 fps. */
const BED_BUDGET_MS = 2.0;

/** Dash travel at full pump flow, schematic units per second. */
const DASH_PX_PER_S_AT_QMAX = 44;

/** Tank cell origins in visual order CIP, A, B, S — indexed by display slot [a,b,s,cip]. */
const TANK_X = [148, 280, 412, 16];

/** Tank cell drop-pipe x offset from the cell origin. */
const TANK_DROP_DX = 24;

/* ===============================================================================================
 * 2.  THEME TOKENS  (FT-CLASSIC)
 * =============================================================================================*/

/** Every token the schematic and the bed painter read. @type {string[]} */
const TOKEN_NAMES = [
  '--screen', '--face', '--face-2', '--face-3',
  '--bev-hi', '--bev-lt', '--bev-sh', '--bev-dk',
  '--ink', '--ink-2', '--ink-off',
  '--fld-bg', '--fld-pv', '--fld-sp', '--fld-out', '--fld-alarm', '--fld-stale', '--fld-eu',
  '--lamp-off', '--lamp-run', '--lamp-warn', '--lamp-alarm',
  '--pipe-idle', '--svc-a', '--svc-b', '--svc-sample', '--svc-cip', '--svc-product', '--svc-waste',
  '--pen-flow', '--pen-pctb', '--pen-press', '--pen-uv', '--pen-cond', '--pen-ph', '--pen-temp',
];

/** Normative light "FT-CLASSIC" defaults — the fallback when a token is absent. */
const LIGHT_DEFAULTS = {
  '--screen': '#6E6E6E', '--face': '#C7C3BC', '--face-2': '#BFBBB4', '--face-3': '#D2CEC7',
  '--bev-hi': '#FFFFFF', '--bev-lt': '#E6E2DA', '--bev-sh': '#85817B', '--bev-dk': '#4A4744',
  '--ink': '#101010', '--ink-2': '#3A3A3A', '--ink-off': '#7A7A7A',
  '--fld-bg': '#0A0F0A', '--fld-pv': '#12FF4B', '--fld-sp': '#FFD400', '--fld-out': '#00E5FF',
  '--fld-alarm': '#FF3B30', '--fld-stale': '#7A8A7A', '--fld-eu': '#9FB39F',
  '--lamp-off': '#4A4744', '--lamp-run': '#16C60C', '--lamp-warn': '#FFC000',
  '--lamp-alarm': '#E81123',
  '--pipe-idle': '#4A4744', '--svc-a': '#2D6FB8', '--svc-b': '#8A5BC8', '--svc-sample': '#C8862B',
  '--svc-cip': '#1FA98C', '--svc-product': '#16C60C', '--svc-waste': '#6B6B6B',
  '--pen-flow': '#00E5FF', '--pen-pctb': '#FF6EC7', '--pen-press': '#FFD400', '--pen-uv': '#12FF4B',
  '--pen-cond': '#FF9A3C', '--pen-ph': '#B39DFF', '--pen-temp': '#FFFFFF',
};

/** Normative dark defaults — same bevel language, same field and pen colours. */
const DARK_DEFAULTS = Object.assign({}, LIGHT_DEFAULTS, {
  '--screen': '#2A2A2A', '--face': '#4A4744', '--face-2': '#3E3B38', '--face-3': '#565250',
  '--bev-hi': '#7A7672', '--bev-lt': '#605C58', '--bev-sh': '#2E2B29', '--bev-dk': '#1A1817',
  '--ink': '#E8E4DC', '--ink-2': '#B8B4AC', '--ink-off': '#8A8680',
});

/* ===============================================================================================
 * 3.  COLOUR UTILITIES
 * =============================================================================================*/

/**
 * Parse a CSS colour into sRGB channels.  Accepts `#rgb`, `#rrggbb`, `rgb()` and `rgba()`; anything
 * else resolves to opaque mid-grey so a missing token can never throw.
 *
 * @param {string} css a CSS colour string
 * @returns {{r:number, g:number, b:number, a:number}} channels 0..255 plus alpha 0..1
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
 * Build the 32-entry buffer-A -> buffer-B blend LUT.  Interpolation happens in linear light, which
 * is what stops the blue/violet midpoint going muddy.
 *
 * @param {string} aCss buffer-A colour
 * @param {string} bCss buffer-B colour
 * @returns {string[]} `LUT_N` CSS `rgb()` strings, 0 = pure A, `LUT_N-1` = pure B
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
 * Relative luminance of a CSS colour.
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
 * Mix two CSS colours in linear light.
 * @param {string} aCss first colour
 * @param {string} bCss second colour
 * @param {number} t 0 = a, 1 = b
 * @returns {string} an `rgb()` string
 */
function mix(aCss, bCss, t) {
  const A = parseColor(aCss);
  const B = parseColor(bCss);
  const k = clamp(t, 0, 1);
  return 'rgb(' + toSrgb(toLinear(A.r) + (toLinear(B.r) - toLinear(A.r)) * k) + ','
    + toSrgb(toLinear(A.g) + (toLinear(B.g) - toLinear(A.g)) * k) + ','
    + toSrgb(toLinear(A.b) + (toLinear(B.b) - toLinear(A.b)) * k) + ')';
}

/** Cache of resolved themes keyed by the caller's raw token map. @type {WeakMap<object,object>} */
const THEME_CACHE = new WeakMap();

/**
 * Derive the painter-facing fields (`bands`, `lutAB`, bead / front / void colours) from a token map.
 *
 * @param {Record<string,string>} raw a token map
 * @returns {object} the resolved theme
 */
function deriveTheme(raw) {
  const t = Object.assign({}, raw);
  t.isDark = luminance(t['--face']) < 0.35;
  t.lutAB = buildBlendLut(t['--svc-a'], t['--svc-b']);
  t.bands = [t['--pen-uv'], t['--pen-pctb'], t['--pen-cond'], t['--pen-ph']];
  t.$bead = t.isDark ? mix(t['--face'], '#FFFFFF', 0.45) : mix(t['--face'], '#2A2A2A', 0.35);
  t.$front = t['--fld-sp'];
  t.$void = t.isDark ? t['--face-2'] : t['--face-3'];
  t.$edge = t.isDark ? t['--bev-hi'] : t['--bev-dk'];
  return t;
}

/**
 * Read the theme tokens this panel needs from a live element, falling back to the normative
 * FT-CLASSIC defaults for any token the stylesheet does not define.  Called once at mount and once
 * per theme change, never per frame.
 *
 * @param {Element|null} el an element inside the themed subtree, or null for `documentElement`
 * @returns {object} a resolved theme: the token map plus `isDark`, `lutAB`, `bands`
 */
function readTheme(el) {
  const target = el || (typeof document !== 'undefined' ? document.documentElement : null);
  let cs = null;
  if (target && typeof getComputedStyle === 'function') {
    try { cs = getComputedStyle(target); } catch (e) { cs = null; }
  }
  let probe = LIGHT_DEFAULTS;
  const attr = (target && target.getAttribute) ? target.getAttribute('data-theme') : null;
  const rootAttr = attr || ((typeof document !== 'undefined')
    ? document.documentElement.getAttribute('data-theme') : null);
  if (rootAttr === 'dark') probe = DARK_DEFAULTS;
  else if (!rootAttr && typeof matchMedia === 'function'
    && matchMedia('(prefers-color-scheme: dark)').matches) probe = DARK_DEFAULTS;
  if (cs) {
    const face = String(cs.getPropertyValue('--face') || '').trim();
    if (face) probe = luminance(face) < 0.35 ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  }
  /** @type {Record<string,string>} */
  const raw = {};
  for (let i = 0; i < TOKEN_NAMES.length; i++) {
    const name = TOKEN_NAMES[i];
    const v = cs ? String(cs.getPropertyValue(name) || '').trim() : '';
    raw[name] = v || probe[name];
  }
  return deriveTheme(raw);
}

/**
 * Accept either a resolved theme from {@link readTheme} or a bare token map and return a resolved
 * theme.  Keeps {@link paintBed} usable standalone without duplicating token work.
 *
 * @param {object|null|undefined} theme a resolved theme or a `{'--token': value}` map
 * @returns {object} a resolved theme with `isDark`, `lutAB` and `bands`
 */
function normaliseTheme(theme) {
  if (!theme || typeof theme !== 'object') return deriveTheme(LIGHT_DEFAULTS);
  if (Array.isArray(theme.lutAB) && Array.isArray(theme.bands) && theme.$bead) return theme;
  const hit = THEME_CACHE.get(theme);
  if (hit) return hit;
  const probe = (theme['--face'] && luminance(theme['--face']) < 0.35)
    ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  const t = deriveTheme(Object.assign({}, probe, theme));
  THEME_CACHE.set(theme, t);
  return t;
}

/* ===============================================================================================
 * 4.  NUMBER FORMATTING (fixed decimals per channel so digits never change width)
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
 * 5.  SVG BUILDERS  (used once, at module load, to compose PID_TEMPLATE)
 * =============================================================================================*/

/**
 * Two-tone 2 px bevel frame.
 * @param {number} x left
 * @param {number} y top
 * @param {number} w width
 * @param {number} h height
 * @param {boolean} sunken true for a sunken frame, false for raised
 * @returns {string} SVG markup
 */
function bevel(x, y, w, h, sunken) {
  const o1 = sunken ? 'pid-bv-dk' : 'pid-bv-hi';
  const o2 = sunken ? 'pid-bv-hi' : 'pid-bv-dk';
  const i1 = sunken ? 'pid-bv-sh' : 'pid-bv-lt';
  const i2 = sunken ? 'pid-bv-lt' : 'pid-bv-sh';
  const L = x + 0.5;
  const T = y + 0.5;
  const R = x + w - 0.5;
  const B = y + h - 0.5;
  return `<path class="${o1}" d="M${L},${B} V${T} H${R}"/>`
    + `<path class="${o2}" d="M${R},${T} V${B} H${L}"/>`
    + `<path class="${i1}" d="M${L + 1},${B - 1} V${T + 1} H${R - 1}"/>`
    + `<path class="${i2}" d="M${R - 1},${T + 1} V${B - 1} H${L + 1}"/>`;
}

/**
 * A sunken label box: near-black field, right-aligned tabular value, dim EU suffix.
 * @param {string} id element id stem — the value text gets `${id}-v`
 * @param {number} x left
 * @param {number} y top
 * @param {number} w width
 * @param {number} h height
 * @param {string} eu engineering-unit suffix
 * @param {string} [kind] extra class: `sp` for amber setpoint digits, `out` for cyan
 * @returns {string} SVG markup
 */
function fld(id, x, y, w, h, eu, kind) {
  const euW = eu ? eu.length * 4.3 + 3 : 0;
  const base = y + h - Math.max(4, (h - 10) / 2);
  return `<g id="${id}" class="pid-fld${kind ? ' pid-fld--' + kind : ''}">`
    + `<rect class="pid-fld-bg" x="${x}" y="${y}" width="${w}" height="${h}"/>`
    + bevel(x, y, w, h, true)
    + `<text id="${id}-v" class="pid-fld-v" x="${(x + w - 4 - euW).toFixed(1)}" `
    + `y="${base.toFixed(1)}" text-anchor="end">—</text>`
    + (eu ? `<text class="pid-fld-eu" x="${x + w - 3}" y="${base.toFixed(1)}" `
      + `text-anchor="end">${eu}</text>` : '')
    + '</g>';
}

/**
 * An ISA-5.1 field instrument bubble: plain circle, function letters over loop number.
 * @param {string} id element id
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {string} fn function letters, e.g. `PDT`
 * @param {string} loop loop number, e.g. `101`
 * @param {number} [r] radius
 * @returns {string} SVG markup
 */
function bubble(id, cx, cy, fn, loop, r) {
  const rr = r || 13;
  return `<g id="${id}" class="pid-bub">`
    + `<circle class="pid-bub-c" cx="${cx}" cy="${cy}" r="${rr}"/>`
    + `<text class="pid-bub-t" x="${cx}" y="${cy - 1}" text-anchor="middle">${fn}</text>`
    + `<text class="pid-bub-t" x="${cx}" y="${cy + 8}" text-anchor="middle">${loop}</text>`
    + '</g>';
}

/**
 * A round glassy status lamp.
 * @param {string} id element id
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} r radius
 * @returns {string} SVG markup
 */
function lamp(id, cx, cy, r) {
  const a = (r * 0.62).toFixed(2);
  return `<g id="${id}" class="pid-lamp">`
    + `<circle class="pid-lamp-b" cx="${cx}" cy="${cy}" r="${r}"/>`
    + `<path class="pid-lamp-hi" d="M${(cx - r * 0.58).toFixed(2)},${(cy - r * 0.28).toFixed(2)} `
    + `A${a},${a} 0 0,1 ${(cx - r * 0.1).toFixed(2)},${(cy - r * 0.66).toFixed(2)}"/>`
    + '</g>';
}

/**
 * A transparent keyboard-reachable hit target.
 * @param {string} comp the `data-component` id
 * @param {number} x left
 * @param {number} y top
 * @param {number} w width
 * @param {number} h height
 * @param {string} label the accessible name
 * @returns {string} SVG markup
 */
function hit(comp, x, y, w, h, label) {
  return `<rect class="pid-hit" data-component="${comp}" x="${x}" y="${y}" width="${w}" `
    + `height="${h}" tabindex="0" role="button" aria-label="${label}"/>`;
}

/**
 * A thin instrument leader line.
 * @param {string} d the path data
 * @returns {string} SVG markup
 */
function leader(d) {
  return `<path class="pid-leader" d="${d}"/>`;
}

/**
 * A vertical two-triangle gate-valve bowtie with a stem and handwheel to the right.
 * @param {string} id element id
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {string} comp the `data-component` id
 * @param {string} label the accessible name
 * @param {string} tag the printed tag
 * @returns {string} SVG markup
 */
function valveV(id, cx, cy, comp, label, tag) {
  return `<g id="${id}" class="pid-vlv" transform="translate(${cx},${cy})">`
    + '<path class="pid-vlv-body" d="M-8,-11 L8,-11 L0,0 Z"/>'
    + '<path class="pid-vlv-body" d="M-8,11 L8,11 L0,0 Z"/>'
    + '<line class="pid-vlv-stem" x1="0" y1="0" x2="13" y2="0"/>'
    + '<line class="pid-vlv-stem" x1="13" y1="-6" x2="13" y2="6"/>'
    + `<text class="pid-tag" x="17" y="14">${tag}</text>`
    + hit(comp, -13, -13, 32, 26, label)
    + '</g>';
}

/** Column-valve internal channel geometry, per position.  Local coords, port radius 16. */
const CV_CHANNELS = {
  // IN(W) -> column TOP(S) straight through, and column BOTTOM(N) -> detectors(E) hopping over it.
  DOWN: 'M-16,0 L-6,0 Q0,0 0,6 L0,16 M0,-16 L0,-6 Q0,0 6,0 L16,0',
  // IN(W) -> column BOTTOM(N), and column TOP(S) -> detectors(E).
  UP: 'M-16,0 L-6,0 Q0,0 0,-6 L0,-16 M0,16 L0,6 Q0,0 6,0 L16,0',
  // IN(W) -> detectors(E): the column is out of line.
  BYPASS: 'M-16,0 H16',
  ISOLATED: '',
  CIP_DETECTOR_BYPASS: 'M-16,0 L-6,0 Q0,0 0,6 L0,16 M0,-16 L0,-6 Q0,0 6,0 L16,0',
};

/** Which column-valve ports are capped (dead-ended) in each position. */
const CV_CAPS = {
  DOWN: [], UP: [],
  BYPASS: ['n', 's'],
  ISOLATED: ['n', 'e', 's', 'w'],
  CIP_DETECTOR_BYPASS: [],
};

/** Rotor angle, degrees, that the column valve's port indicator shows for each position. */
const CV_ROTOR_DEG = {
  BYPASS: 0, DOWN: 90, UP: 180, ISOLATED: 270, CIP_DETECTOR_BYPASS: 45,
};

/**
 * Injection-valve internal channels, by sample mode.  Ports (local, r = 18): FEED W, COLUMN E,
 * LOOP_A NW, LOOP_B NE, SAMPLE SE, WASTE SW.
 */
const IV_CHANNELS = {
  // Pump straight to the column; the sample line charges the loop and overflows to waste.
  LOAD: 'M-18,0 H18 M15.6,9 L-15.6,-9 M15.6,-9 L-15.6,9',
  // Pump pushes the loop contents onto the column.
  INJECT: 'M-18,0 L-15.6,-9 M15.6,-9 L18,0 M15.6,9 L-15.6,9',
  // Sample and buffer both reach the column through the injection tee.
  DIRECT: 'M-18,0 H18 M15.6,9 L4,1.5',
};

/* ===============================================================================================
 * 6.  THE STATIC SVG TEMPLATE
 * =============================================================================================*/

/**
 * One tank cell: vessel, level fill, LT bubble, level label box and low-level lamp.
 * @param {number} i the display slot index (0 = A, 1 = B, 2 = S, 3 = CIP)
 * @param {string} comp the `data-component` id
 * @param {string} role the printed role tag
 * @param {string} label the accessible name
 * @param {string} lt the LT loop number
 * @returns {string} SVG markup
 */
function tankCell(i, comp, role, label, lt) {
  const x = TANK_X[i];
  const dx = x + TANK_DROP_DX;
  return `<g id="pid-tk${i}" class="pid-tank">`
    + `<text id="pid-tk${i}-role" class="pid-tag" x="${x}" y="20">${role}</text>`
    + `<text id="pid-tk${i}-id" class="pid-tag pid-tag--dim" x="${x + 72}" y="20" `
    + 'text-anchor="end">—</text>'
    + `<rect class="pid-tank-bg" x="${x}" y="26" width="72" height="74"/>`
    + `<g clip-path="url(#pid-clip-tk${i})">`
    + `<rect id="pid-tk${i}-fill" class="pid-tank-fill" x="${x}" y="70" width="72" height="30"/>`
    + `<line id="pid-tk${i}-men" class="pid-tank-men" x1="${x}" y1="70" x2="${x + 72}" y2="70"/>`
    + '</g>'
    + bevel(x, 26, 72, 74, true)
    + leader(`M${x + 72},42 H${x + 85}`)
    + bubble('pid-tk' + i + '-bub', x + 98, 42, 'LT', lt)
    + fld('pid-tk' + i + '-lv', x + 76, 62, 54, 17, 'L')
    + lamp('pid-tk' + i + '-lamp', x + 100, 88, 5.5)
    + hit(comp, x, 26, 72, 74, label)
    + hit(comp + '-LT', x + 85, 29, 26, 26, label + ' level transmitter')
    + `<path class="pid-tank-nozzle" d="M${dx},100 V104"/>`
    + '</g>';
}

/**
 * One detector body in the analyser train.
 * @param {string} id element id
 * @param {number} y top edge
 * @param {string} tag the printed tag
 * @param {string} glyph inner glyph path data
 * @param {string} comp the `data-component` id
 * @param {string} label the accessible name
 * @returns {string} SVG markup
 */
function detector(id, y, tag, glyph, comp, label) {
  return `<g id="${id}" class="pid-det">`
    + `<rect class="pid-det-bg" x="700" y="${y}" width="80" height="40"/>`
    + bevel(700, y, 80, 40, false)
    + `<text class="pid-tag" x="705" y="${y + 13}">${tag}</text>`
    + `<path class="pid-det-glyph" transform="translate(700,${y})" d="${glyph}"/>`
    + hit(comp, 700, y, 80, 40, label)
    + '</g>';
}

/**
 * The complete static schematic markup, `viewBox="0 0 1200 440"`.
 *
 * Injected with `innerHTML` exactly once, at panel construction.  Elements that change carry an
 * `id`; pipe runs carry `data-seg`; interactive components carry `data-component` on a transparent
 * hit rect.  Dynamic collections (fraction vials, flow-dash overlays, flow arrowheads) are built
 * programmatically at mount, not here.
 *
 * @type {string}
 */
export const PID_TEMPLATE = `
<svg class="pid-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet"
     role="group" aria-label="Process and instrumentation diagram">
  <defs>
    <clipPath id="pid-clip-tk0"><rect x="${TANK_X[0]}" y="26" width="72" height="74"/></clipPath>
    <clipPath id="pid-clip-tk1"><rect x="${TANK_X[1]}" y="26" width="72" height="74"/></clipPath>
    <clipPath id="pid-clip-tk2"><rect x="${TANK_X[2]}" y="26" width="72" height="74"/></clipPath>
    <clipPath id="pid-clip-tk3"><rect x="${TANK_X[3]}" y="26" width="72" height="74"/></clipPath>
    <clipPath id="pid-clip-waste"><rect x="40" y="340" width="72" height="64"/></clipPath>
    <clipPath id="pid-clip-trap"><rect x="276" y="166" width="40" height="58"/></clipPath>
    <pattern id="pid-hazard" width="8" height="8" patternUnits="userSpaceOnUse"
             patternTransform="rotate(45)">
      <rect width="8" height="8" class="pid-hz-bg"/>
      <rect width="4" height="8" class="pid-hz-fg"/>
    </pattern>
    <pattern id="pid-fault" width="6" height="6" patternUnits="userSpaceOnUse"
             patternTransform="rotate(45)">
      <rect width="6" height="6" class="pid-hz-bg"/>
      <rect width="3" height="6" class="pid-flt-fg"/>
    </pattern>
  </defs>

  <!-- ============================ PROCESS LINES (idle layer) ============================ -->
  <g id="pid-pipes" class="pid-pipes" fill="none">
    <path data-seg="s-tank-c"    d="M40,104 V123"/>
    <path data-seg="s-tank-a"    d="M172,104 V123"/>
    <path data-seg="s-tank-b"    d="M304,104 V123"/>
    <path data-seg="s-tank-s"    d="M436,104 V123"/>
    <path data-seg="s-drop-c"    d="M40,145 V160"/>
    <path data-seg="s-drop-a"    d="M172,145 V160"/>
    <path data-seg="s-drop-b"    d="M304,145 V160"/>
    <path data-seg="s-drop-s"    d="M436,145 V330 H400 V304"/>
    <path data-seg="s-hdr-2"     d="M304,160 H172"/>
    <path data-seg="s-hdr-1"     d="M172,160 H40 V180"/>
    <path data-seg="s-pump-out"  d="M60,200 H96"/>
    <path data-seg="s-mix-out"   d="M164,200 H196"/>
    <path data-seg="s-filt-out"  d="M244,200 H276"/>
    <path data-seg="s-trap-out"  d="M316,200 H352"/>
    <path data-seg="s-samp-disc" d="M400,276 V209 L385.6,209"/>
    <path data-seg="s-loop"      d="M354.4,191 L348,177 H392 L385.6,191"/>
    <path data-seg="s-iv-vent"   d="M354.4,209 L344,224 V428"/>
    <path data-seg="s-iv-out"    d="M388,200 H430 A6,6 0 0,1 442,200 H460 V92 H544"/>
    <path data-seg="s-cv-top"    d="M560,108 V120"/>
    <path data-seg="s-col-bot"   d="M560,374 V390 H648 V60 H560 V76"/>
    <path data-seg="s-cv-out"    d="M576,92 H642 A6,6 0 0,1 654,92 H740 V126"/>
    <path data-seg="s-det-in"    d="M740,126 V150"/>
    <path data-seg="s-uv-ce"     d="M740,190 V216"/>
    <path data-seg="s-ce-ae"     d="M740,256 V282"/>
    <path data-seg="s-det-out"   d="M740,322 V336 H820"/>
    <path data-seg="s-cip-shunt" d="M740,126 H690 V366 H820 V336"/>
    <path data-seg="s-dv-in"     d="M820,336 H846"/>
    <path data-seg="s-waste"     d="M862,352 V428 H28 V356 H40"/>
    <path data-seg="s-collect"   d="M878,336 H960 V344"/>
  </g>

  <!-- flow dashes + inline arrowheads are populated at mount -->
  <g id="pid-flow-layer" class="pid-flow-layer" fill="none" aria-hidden="true"></g>
  <g id="pid-arrows" class="pid-arrows" aria-hidden="true"></g>

  <!-- ============================ TANKS ============================ -->
  ${tankCell(3, 'TK-CIP', 'CIP', 'CIP tank', '104')}
  ${tankCell(0, 'TK-A', 'BUFFER A', 'Buffer A tank', '101')}
  ${tankCell(1, 'TK-B', 'BUFFER B', 'Buffer B tank', '102')}
  ${tankCell(2, 'TK-S', 'SAMPLE', 'Sample tank', '103')}

  <!-- ============================ INLET VALVES ============================ -->
  ${valveV('pid-v-V4', 40, 134, 'V4', 'CIP inlet valve V4', 'V4')}
  ${valveV('pid-v-V1', 172, 134, 'V1', 'Buffer A inlet valve V1', 'V1')}
  ${valveV('pid-v-V2', 304, 134, 'V2', 'Buffer B inlet valve V2', 'V2')}
  ${valveV('pid-v-V3', 436, 134, 'V3', 'Sample inlet valve V3', 'V3')}

  <!-- ============================ PUMPS ============================ -->
  <g id="pid-pump" class="pid-mach">
    <circle class="pid-mach-b" cx="40" cy="200" r="20"/>
    <g id="pid-impeller" class="pid-impeller" transform="rotate(0,40,200)">
      <path d="M40,187 L43.4,200 L36.6,200 Z"/>
      <path d="M51.3,206.5 L41,203.6 L44.2,197.9 Z"/>
      <path d="M28.7,206.5 L35.8,197.9 L39,203.6 Z"/>
      <circle class="pid-impeller-hub" cx="40" cy="200" r="2.8"/>
    </g>
    <text class="pid-tag" x="40" y="231" text-anchor="middle">P-101</text>
    ${hit('P-101', 20, 180, 40, 40, 'System pump P-101')}
  </g>
  <g id="pid-pump-s" class="pid-mach">
    <circle class="pid-mach-b" cx="400" cy="290" r="14"/>
    <path class="pid-impeller-static" d="M400,281 L402.4,290 L397.6,290 Z
                                         M407.6,294.6 L400.7,292.5 L403,288.6 Z
                                         M392.4,294.6 L397,288.6 L399.3,292.5 Z"/>
    <text class="pid-tag" x="418" y="293">P-102</text>
    ${hit('P-102', 386, 276, 28, 28, 'Sample pump P-102')}
  </g>

  <!-- ============================ MIXER / FILTER / AIR TRAP ============================ -->
  <g id="pid-mixer" class="pid-eq">
    <rect class="pid-eq-bg" x="96" y="176" width="68" height="48"/>
    ${bevel(96, 176, 68, 48, false)}
    <path class="pid-eq-glyph" d="M102,218 L112,183 L122,218 L132,183 L142,218 L152,183"/>
    <text class="pid-tag" x="130" y="172" text-anchor="middle">M-101</text>
    ${hit('M-101', 96, 176, 68, 48, 'Gradient mixer M-101')}
  </g>
  <g id="pid-filter" class="pid-eq">
    <rect class="pid-eq-bg" x="196" y="178" width="48" height="44"/>
    ${bevel(196, 178, 48, 44, false)}
    <path class="pid-eq-glyph" d="M200,188 H240 M200,196 H240 M200,204 H240 M200,212 H240"/>
    <text class="pid-tag" x="220" y="174" text-anchor="middle">F-101</text>
    ${hit('F-101', 196, 178, 48, 44, 'Inline filter F-101')}
  </g>
  <g id="pid-trap" class="pid-eq">
    <line class="pid-vent" x1="306" y1="166" x2="306" y2="158"/>
    <line class="pid-vent" x1="300" y1="158" x2="312" y2="158"/>
    <rect class="pid-eq-bg" x="276" y="166" width="40" height="58"/>
    <g clip-path="url(#pid-clip-trap)">
      <rect id="pid-trap-liq" class="pid-trap-liq" x="276" y="188" width="40" height="36"/>
      <line id="pid-trap-men" class="pid-tank-men" x1="276" y1="188" x2="316" y2="188"/>
    </g>
    ${bevel(276, 166, 40, 58, true)}
    <text class="pid-tag" x="320" y="172">AT-101</text>
    ${hit('AT-101', 276, 166, 40, 58, 'Air trap AT-101')}
  </g>

  <!-- ============================ INJECTION VALVE ============================ -->
  <g id="pid-iv" class="pid-rot" transform="translate(370,200)">
    <circle class="pid-rot-b" cx="0" cy="0" r="18"/>
    <g class="pid-rot-ports">
      <circle cx="-18" cy="0" r="2.2"/><circle cx="18" cy="0" r="2.2"/>
      <circle cx="-15.6" cy="-9" r="2.2"/><circle cx="15.6" cy="-9" r="2.2"/>
      <circle cx="-15.6" cy="9" r="2.2"/><circle cx="15.6" cy="9" r="2.2"/>
    </g>
    <path id="pid-iv-ch" class="pid-rot-ch" d=""/>
    <text class="pid-tag" x="26" y="-14">IV-101</text>
    <text id="pid-iv-mode" class="pid-tag pid-tag--state" x="0" y="40"
          text-anchor="middle">LOAD</text>
    ${hit('IV-101', -19, -19, 38, 38, 'Injection valve IV-101')}
  </g>

  <!-- ============================ COLUMN VALVE ============================ -->
  <g id="pid-cv" class="pid-rot" transform="translate(560,92)">
    <circle class="pid-rot-b" cx="0" cy="0" r="16"/>
    <g class="pid-rot-ports">
      <circle cx="0" cy="-16" r="2.2"/><circle cx="16" cy="0" r="2.2"/>
      <circle cx="0" cy="16" r="2.2"/><circle cx="-16" cy="0" r="2.2"/>
    </g>
    <path id="pid-cv-ch" class="pid-rot-ch" d=""/>
    <g id="pid-cv-caps" class="pid-rot-caps">
      <line id="pid-cv-cap-n" x1="-4.5" y1="-11" x2="4.5" y2="-11"/>
      <line id="pid-cv-cap-e" x1="11" y1="-4.5" x2="11" y2="4.5"/>
      <line id="pid-cv-cap-s" x1="-4.5" y1="11" x2="4.5" y2="11"/>
      <line id="pid-cv-cap-w" x1="-11" y1="-4.5" x2="-11" y2="4.5"/>
    </g>
    <g id="pid-cv-rotor" class="pid-rot-rotor">
      <path d="M0,-22 L3.6,-27 L-3.6,-27 Z"/>
      <line x1="0" y1="-16" x2="0" y2="-22"/>
    </g>
    <circle id="pid-cv-arc" class="pid-move-arc" cx="0" cy="0" r="22"/>
    <text class="pid-tag" x="-24" y="-20" text-anchor="end">CV-101</text>
    ${hit('CV-101', -17, -17, 34, 34, 'Column valve CV-101')}
  </g>
  ${fld('pid-cv-pos', 430, 100, 96, 18, '')}

  <!-- ============================ COLUMN ============================ -->
  <g id="pid-column" class="pid-col">
    <rect class="pid-col-adapter" x="486" y="118" width="148" height="16"/>
    ${bevel(486, 118, 148, 16, false)}
    <rect class="pid-col-adapter" x="486" y="366" width="148" height="16"/>
    ${bevel(486, 366, 148, 16, false)}
    <rect class="pid-col-tube" x="490" y="126" width="140" height="248"/>
    ${bevel(490, 126, 140, 248, true)}
    <line class="pid-col-frit" x1="508" y1="134" x2="612" y2="134"/>
    <line class="pid-col-frit" x1="508" y1="366" x2="612" y2="366"/>
    <text class="pid-tag" x="490" y="112">C-101</text>
    <g class="pid-col-ruler">
      <line x1="492" y1="134" x2="500" y2="134"/>
      <line x1="492" y1="192" x2="500" y2="192"/>
      <line x1="492" y1="250" x2="500" y2="250"/>
      <line x1="492" y1="308" x2="500" y2="308"/>
      <line x1="492" y1="366" x2="500" y2="366"/>
    </g>
    <g class="pid-col-profile">
      <line class="pid-col-axis" x1="614" y1="134" x2="614" y2="366"/>
      <polyline id="pid-profile-line" class="pid-profile-line" points=""/>
    </g>
    ${hit('C-101', 486, 118, 148, 264, 'Chromatography column C-101')}
  </g>

  <!-- ============================ PDT-101 ============================ -->
  <g id="pid-dp" class="pid-inst">
    <path class="pid-bracket" d="M490,140 H478 V360 H490"/>
    ${leader('M478,360 V404 H487')}
    ${bubble('pid-dp-bub', 500, 410, 'PDT', '101')}
    ${fld('pid-dp-f', 518, 401, 84, 18, 'bar')}
    ${hit('PDT-101', 487, 397, 26, 26, 'Column differential pressure PDT-101')}
  </g>

  <!-- ============================ PT-102 ============================ -->
  <g id="pid-pt102" class="pid-inst">
    ${leader('M648,60 H663')}
    ${bubble('pid-pt102-bub', 676, 60, 'PT', '102')}
    ${fld('pid-pt102-f', 692, 51, 84, 18, 'bar')}
    ${hit('PT-102', 663, 47, 26, 26, 'Post-column pressure transmitter PT-102')}
  </g>

  <!-- ============================ FT-101 / AIC-101 / PT-101 ============================ -->
  <g id="pid-ft" class="pid-inst">
    ${leader('M44,259 L41,221')}
    ${bubble('pid-ft-bub', 44, 272, 'FT', '101')}
    ${fld('pid-ft-f', 61, 263, 84, 18, 'mL/min')}
    ${fld('pid-ft-sp', 61, 285, 84, 18, 'mL/min', 'sp')}
    ${hit('FT-101', 31, 259, 26, 26, 'Flow transmitter FT-101')}
  </g>
  <g id="pid-pctb" class="pid-inst">
    ${leader('M176,259 L152,226')}
    ${bubble('pid-pctb-bub', 176, 272, 'AIC', '101')}
    ${fld('pid-pctb-f', 193, 263, 84, 18, '%')}
    ${fld('pid-pctb-sp', 193, 285, 84, 18, '%', 'sp')}
    ${hit('PCTB', 163, 259, 26, 26, 'Gradient percent buffer B, AIC-101')}
  </g>
  <g id="pid-pt101" class="pid-inst">
    ${leader('M250,157 V199')}
    ${bubble('pid-pt101-bub', 250, 144, 'PT', '101')}
    ${fld('pid-pt101-f', 266, 135, 84, 18, 'bar')}
    ${hit('PT-101', 237, 131, 26, 26, 'Pre-column pressure transmitter PT-101')}
  </g>

  <!-- ============================ DETECTOR TRAIN ============================ -->
  ${detector('pid-uv', 150, 'UV-101',
    'M14,30 H30 M30,22 L46,30 L46,14 Z M52,22 H66 M52,30 H62', 'UV-101',
    'UV absorbance monitor UV-101')}
  ${detector('pid-ce', 216, 'CE-101',
    'M22,20 V34 M32,20 V34 M22,27 H32 M46,20 V34 M56,20 V34 M46,27 H56', 'CE-101',
    'Conductivity cell CE-101')}
  ${detector('pid-ae', 282, 'AE-101',
    'M28,18 V30 A6,6 0 0,0 40,30 V18 M28,18 H40 M52,20 V34 M46,27 H58', 'AE-101',
    'pH electrode AE-101')}

  <g id="pid-uv-i" class="pid-inst">
    ${leader('M780,170 H799')}
    ${bubble('pid-uv-bub', 812, 170, 'AT', '101')}
    ${fld('pid-uv-f', 828, 161, 84, 18, 'mAU')}
  </g>
  <g id="pid-ce-i" class="pid-inst">
    ${leader('M780,236 H799')}
    ${bubble('pid-ce-bub', 812, 236, 'CE', '101')}
    ${fld('pid-ce-f', 828, 227, 84, 18, 'mS/cm')}
  </g>
  <g id="pid-ae-i" class="pid-inst">
    ${leader('M780,302 H799')}
    ${bubble('pid-ae-bub', 812, 302, 'AE', '101')}
    ${fld('pid-ae-f', 828, 293, 84, 18, 'pH')}
  </g>
  <g id="pid-tt" class="pid-inst">
    ${leader('M799,105 L741,97')}
    ${bubble('pid-tt-bub', 812, 110, 'TT', '101')}
    ${fld('pid-tt-f', 828, 101, 84, 18, '°C')}
    ${hit('TT-101', 799, 97, 26, 26, 'Temperature transmitter TT-101')}
  </g>

  <!-- ============================ DIVERTER / WASTE / COLLECTOR ============================ -->
  <g id="pid-dv" class="pid-vlv" transform="translate(862,336)">
    <path class="pid-vlv-body" d="M-16,-9 L-16,9 L0,0 Z"/>
    <path class="pid-vlv-body" d="M16,-9 L16,9 L0,0 Z"/>
    <path class="pid-vlv-body pid-vlv-body--3" d="M-9,16 L9,16 L0,0 Z"/>
    <circle id="pid-dv-arc" class="pid-move-arc" cx="0" cy="0" r="14"/>
    <text class="pid-tag" x="0" y="-14" text-anchor="middle">DV-101</text>
    ${hit('DV-101', -17, -17, 34, 34, 'Fraction diverter valve DV-101')}
  </g>

  <g id="pid-waste" class="pid-waste">
    <g clip-path="url(#pid-clip-waste)">
      <rect class="pid-waste-hz" x="40" y="340" width="72" height="64"/>
      <rect id="pid-waste-fill" class="pid-waste-fill" x="40" y="380" width="72" height="24"/>
    </g>
    ${bevel(40, 340, 72, 64, true)}
    <text class="pid-tag" x="28" y="310">WASTE</text>
    ${fld('pid-waste-lv', 28, 314, 96, 18, 'L')}
    ${hit('WASTE', 40, 340, 72, 64, 'Waste container')}
  </g>

  <g id="pid-collector" class="pid-fc">
    <line class="pid-rail" x1="890" y1="344" x2="1180" y2="344"/>
    <rect class="pid-fc-bg" x="890" y="356" width="290" height="64"/>
    ${bevel(890, 356, 290, 64, false)}
    <g id="pid-vials"></g>
    <g id="pid-frac-head" class="pid-frac-head" transform="translate(896,0)">
      <line x1="0" y1="344" x2="0" y2="356"/>
      <path d="M-5,354 L5,354 L0,362 Z"/>
    </g>
    <text class="pid-tag" x="890" y="338">FC-101</text>
    ${fld('pid-frac', 1060, 320, 120, 18, 'mL')}
    ${hit('FC-101', 890, 356, 290, 64, 'Fraction collector FC-101')}
  </g>

  <!-- ============================ SERVICE LEGEND ============================ -->
  <g id="pid-legend" class="pid-legend" aria-hidden="true">
    <rect class="pid-lg-sw" x="810" y="24" width="14" height="9"
          style="fill:var(--svc-a,#2D6FB8)"/>
    <text class="pid-tag" x="828" y="32">A</text>
    <rect class="pid-lg-sw" x="872" y="24" width="14" height="9"
          style="fill:var(--svc-b,#8A5BC8)"/>
    <text class="pid-tag" x="890" y="32">B</text>
    <rect class="pid-lg-sw" x="934" y="24" width="14" height="9"
          style="fill:var(--svc-sample,#C8862B)"/>
    <text class="pid-tag" x="952" y="32">SMP</text>
    <rect class="pid-lg-sw" x="996" y="24" width="14" height="9"
          style="fill:var(--svc-cip,#1FA98C)"/>
    <text class="pid-tag" x="1014" y="32">CIP</text>
    <rect class="pid-lg-sw" x="1058" y="24" width="14" height="9"
          style="fill:var(--svc-product,#16C60C)"/>
    <text class="pid-tag" x="1076" y="32">PROD</text>
    <rect class="pid-lg-sw" x="1128" y="24" width="14" height="9"
          style="fill:var(--svc-waste,#6B6B6B)"/>
    <text class="pid-tag" x="1146" y="32">WST</text>
  </g>
</svg>`;

/* ===============================================================================================
 * 7.  PANEL STYLESHEET (injected once; scoped to .pid-root)
 * =============================================================================================*/

/** Panel stylesheet — every colour is an FT-CLASSIC token. @type {string} */
const PID_CSS = `
.pid-root{position:relative;display:block;width:100%;height:100%;min-height:220px;
  background:var(--face,#C7C3BC);color:var(--ink,#101010);
  font-family:var(--font-ui,system-ui,'Segoe UI',Tahoma,sans-serif);border-radius:0;
  box-shadow:inset 1px 1px 0 var(--bev-dk,#4A4744),inset -1px -1px 0 var(--bev-hi,#FFF),
    inset 2px 2px 0 var(--bev-sh,#85817B),inset -2px -2px 0 var(--bev-lt,#E6E2DA);
  -webkit-user-select:none;user-select:none;}
.pid-root .pid-svg{display:block;width:100%;height:100%;overflow:hidden;}
.pid-bed-canvas{position:absolute;left:0;top:0;pointer-events:none;}
.pid-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0;}

/* ---- bevel strokes -------------------------------------------------------- */
.pid-bv-hi,.pid-bv-lt,.pid-bv-sh,.pid-bv-dk{fill:none;stroke-width:1;shape-rendering:crispEdges;}
.pid-bv-hi{stroke:var(--bev-hi,#FFFFFF);}
.pid-bv-lt{stroke:var(--bev-lt,#E6E2DA);}
.pid-bv-sh{stroke:var(--bev-sh,#85817B);}
.pid-bv-dk{stroke:var(--bev-dk,#4A4744);}

/* ---- text ----------------------------------------------------------------- */
.pid-tag{font-size:9px;fill:var(--ink,#101010);letter-spacing:.04em;text-transform:uppercase;
  font-weight:600;}
.pid-tag--dim{fill:var(--ink-2,#3A3A3A);font-weight:400;}
.pid-tag--state{fill:var(--ink-2,#3A3A3A);font-size:9px;}
.pid-bub-t{font-size:8px;fill:var(--ink,#101010);letter-spacing:.02em;font-weight:600;}

/* ---- label boxes ---------------------------------------------------------- */
.pid-fld-bg{fill:var(--fld-bg,#0A0F0A);}
.pid-fld-v{font-family:var(--font-num,ui-monospace,Consolas,monospace);
  font-variant-numeric:tabular-nums lining-nums;font-size:12px;font-weight:700;
  fill:var(--fld-pv,#12FF4B);}
.pid-fld-eu{font-family:var(--font-num,ui-monospace,Consolas,monospace);font-size:8px;
  fill:var(--fld-eu,#9FB39F);}
.pid-fld--sp .pid-fld-v{fill:var(--fld-sp,#FFD400);}
.pid-fld--out .pid-fld-v{fill:var(--fld-out,#00E5FF);}
.pid-fld.is-alarm .pid-fld-v{fill:var(--fld-alarm,#FF3B30);}
.pid-fld.is-stale .pid-fld-v{fill:var(--fld-stale,#7A8A7A);}

/* ---- lamps ---------------------------------------------------------------- */
.pid-lamp-b{fill:var(--lamp-off,#4A4744);stroke:#2A2A2A;stroke-width:1;}
.pid-lamp-hi{fill:none;stroke:rgba(255,255,255,.85);stroke-width:1;stroke-linecap:round;}
.pid-lamp.is-run .pid-lamp-b{fill:var(--lamp-run,#16C60C);}
.pid-lamp.is-warn .pid-lamp-b{fill:var(--lamp-warn,#FFC000);}
.pid-lamp.is-alarm .pid-lamp-b{fill:var(--lamp-alarm,#E81123);}
.pid-lamp.is-blink .pid-lamp-b{animation:pid-blink 1s steps(1,end) infinite;}
@keyframes pid-blink{0%{opacity:1}50%{opacity:.2}100%{opacity:1}}

/* ---- process lines -------------------------------------------------------- */
.pid-pipes path{stroke:var(--pipe-idle,#4A4744);stroke-width:3.5;stroke-linecap:butt;
  stroke-linejoin:miter;}
.pid-pipes path.is-active{stroke-width:5;}
.pid-flow-layer path{stroke:#FFFFFF;stroke-width:3;stroke-dasharray:6 10;stroke-linecap:butt;
  opacity:0;pointer-events:none;}
.pid-flow-layer path.is-flowing{opacity:.85;}
.pid-arrows path{fill:#FFFFFF;opacity:0;pointer-events:none;}
.pid-arrows path.is-shown{opacity:.9;}

/* ---- tanks ---------------------------------------------------------------- */
.pid-tank-bg{fill:var(--face-3,#D2CEC7);}
.pid-tank-fill{fill:var(--svc-a,#2D6FB8);opacity:.85;}
.pid-tank-men{stroke:#FFFFFF;stroke-width:1.2;opacity:.6;}
.pid-tank-nozzle{stroke:var(--pipe-idle,#4A4744);stroke-width:3.5;fill:none;}
.pid-tank.is-empty .pid-tank-bg{fill:var(--face-2,#BFBBB4);}

/* ---- valves --------------------------------------------------------------- */
.pid-vlv-body{fill:var(--pipe-idle,#4A4744);stroke:var(--bev-dk,#4A4744);stroke-width:1;}
.pid-vlv-stem{stroke:var(--ink-2,#3A3A3A);stroke-width:1.6;}
.pid-vlv.is-open .pid-vlv-body{fill:var(--svc-a,#2D6FB8);}
.pid-vlv.is-fault .pid-vlv-body{fill:url(#pid-fault);}
.pid-vlv.is-moving .pid-vlv-body{opacity:.55;}
.pid-vlv.is-alarm .pid-vlv-body{stroke:var(--lamp-alarm,#E81123);stroke-width:2;}
.pid-vlv.is-warn .pid-vlv-body{stroke:var(--lamp-warn,#FFC000);stroke-width:2;}
.pid-hz-bg{fill:var(--face-2,#BFBBB4);}
.pid-hz-fg{fill:var(--lamp-warn,#FFC000);}
.pid-flt-fg{fill:var(--lamp-alarm,#E81123);}

/* ---- rotary valves -------------------------------------------------------- */
.pid-rot-b{fill:var(--face-3,#D2CEC7);stroke:var(--bev-dk,#4A4744);stroke-width:1.4;}
.pid-rot-ports circle{fill:var(--ink-2,#3A3A3A);}
.pid-rot-ch{fill:none;stroke:var(--pipe-idle,#4A4744);stroke-width:3;stroke-linecap:round;}
.pid-rot-caps line{stroke:var(--ink,#101010);stroke-width:1.8;opacity:0;}
.pid-rot-caps line.is-capped{opacity:.9;}
.pid-rot-rotor line{stroke:var(--ink,#101010);stroke-width:1.6;}
.pid-rot-rotor path{fill:var(--ink,#101010);}
.pid-rot-rotor{transition:transform var(--dur-3,250ms) var(--ease-inout,ease);}
.pid-rot.is-fault .pid-rot-b{stroke:var(--lamp-alarm,#E81123);stroke-width:2;}
.pid-move-arc{fill:none;stroke:var(--fld-sp,#FFD400);stroke-width:2;opacity:0;
  transform:rotate(-90deg);}
.pid-move-arc.is-moving{opacity:1;}

/* ---- equipment ------------------------------------------------------------ */
.pid-eq-bg,.pid-det-bg,.pid-fc-bg{fill:var(--face,#C7C3BC);}
.pid-eq-glyph,.pid-det-glyph{fill:none;stroke:var(--ink-2,#3A3A3A);stroke-width:1.2;
  stroke-linejoin:round;}
.pid-det-glyph{stroke-width:1.4;}
.pid-mach-b{fill:var(--face-3,#D2CEC7);stroke:var(--bev-dk,#4A4744);stroke-width:1.4;}
.pid-impeller path,.pid-impeller-static{fill:var(--ink-2,#3A3A3A);}
.pid-impeller-hub{fill:var(--face,#C7C3BC);}
.pid-mach.is-running .pid-impeller path{fill:var(--lamp-run,#16C60C);}
.pid-vent{stroke:var(--ink-2,#3A3A3A);stroke-width:1.4;}
.pid-trap-liq{fill:var(--svc-a,#2D6FB8);opacity:.85;}
.pid-det.is-bypassed .pid-det-glyph{opacity:.3;}

/* ---- column --------------------------------------------------------------- */
.pid-col-tube{fill:var(--fld-bg,#0A0F0A);}
.pid-col-adapter{fill:var(--face-2,#BFBBB4);}
.pid-col-frit{stroke:var(--ink-off,#7A7A7A);stroke-width:1.4;}
.pid-col-ruler line{stroke:var(--ink-off,#7A7A7A);stroke-width:1;}
.pid-col-axis{stroke:var(--ink-off,#7A7A7A);stroke-width:1;opacity:.6;}
.pid-profile-line{fill:none;stroke:var(--pen-uv,#12FF4B);stroke-width:1.4;stroke-linejoin:round;}
.pid-bracket{fill:none;stroke:var(--ink-2,#3A3A3A);stroke-width:1.2;}

/* ---- instruments ---------------------------------------------------------- */
.pid-bub-c{fill:var(--face-3,#D2CEC7);stroke:var(--ink,#101010);stroke-width:1.2;}
.pid-inst.is-warn .pid-bub-c{stroke:var(--lamp-warn,#FFC000);stroke-width:2;}
.pid-inst.is-alarm .pid-bub-c{stroke:var(--lamp-alarm,#E81123);stroke-width:2;}
.pid-leader{fill:none;stroke:var(--ink-2,#3A3A3A);stroke-width:.8;}

/* ---- collector / waste ---------------------------------------------------- */
.pid-rail{stroke:var(--ink-2,#3A3A3A);stroke-width:1.6;}
.pid-vial{fill:var(--face-2,#BFBBB4);stroke:var(--bev-dk,#4A4744);stroke-width:.8;}
.pid-vial-fill{fill:var(--svc-product,#16C60C);opacity:.9;}
.pid-vial.is-active{stroke:var(--fld-sp,#FFD400);stroke-width:2;}
.pid-frac-head line{stroke:var(--fld-sp,#FFD400);stroke-width:1.8;}
.pid-frac-head path{fill:var(--fld-sp,#FFD400);}
.pid-frac-head{transition:transform var(--dur-3,250ms) var(--ease-out,ease);}
.pid-waste-hz{fill:url(#pid-hazard);opacity:.45;}
.pid-waste-fill{fill:var(--svc-waste,#6B6B6B);opacity:.9;}
.pid-lg-sw{stroke:var(--bev-dk,#4A4744);stroke-width:1;}

/* ---- interaction ---------------------------------------------------------- */
.pid-hit{fill:transparent;stroke:none;cursor:pointer;}
.pid-hit:focus{outline:none;}
.pid-hit:focus-visible{outline:2px solid var(--focus-ring);outline-offset:1px;}
.pid-root.is-manual .pid-svg{outline:3px solid var(--lamp-warn);outline-offset:-4px;}

/* ---- toast + tooltip ------------------------------------------------------ */
.pid-toast{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);max-width:70%;
  padding:4px 8px;background:var(--face-2,#BFBBB4);color:var(--ink,#101010);
  font-size:11px;line-height:1.3;letter-spacing:.02em;border-radius:0;z-index:3;
  box-shadow:inset 1px 1px 0 var(--bev-hi,#FFF),inset -1px -1px 0 var(--bev-dk,#4A4744),
    inset 2px 2px 0 var(--bev-lt,#E6E2DA),inset -2px -2px 0 var(--bev-sh,#85817B);
  opacity:0;pointer-events:none;transition:opacity var(--dur-2,160ms) var(--ease-out,ease);}
.pid-toast.is-shown{opacity:1;}
.pid-toast.is-warn{color:var(--ink,#101010);
  box-shadow:inset 0 0 0 2px var(--lamp-warn,#FFC000),inset 1px 1px 0 var(--bev-hi,#FFF);}
.pid-tip{position:absolute;z-index:4;max-width:250px;padding:6px 7px;pointer-events:none;
  background:var(--face-2,#BFBBB4);color:var(--ink-2,#3A3A3A);font-size:11px;line-height:1.35;
  border-radius:0;opacity:0;transition:opacity var(--dur-2,160ms) var(--ease-out,ease);
  box-shadow:inset 1px 1px 0 var(--bev-hi,#FFF),inset -1px -1px 0 var(--bev-dk,#4A4744),
    inset 2px 2px 0 var(--bev-lt,#E6E2DA),inset -2px -2px 0 var(--bev-sh,#85817B),
    2px 2px 0 rgba(0,0,0,.28);}
.pid-tip.is-shown{opacity:1;}
.pid-tip b{display:block;color:var(--ink,#101010);font-size:10px;letter-spacing:.04em;
  text-transform:uppercase;margin-bottom:2px;}
.pid-tip .pid-tip-val{display:block;margin-top:4px;color:var(--ink,#101010);
  font-family:var(--font-num,ui-monospace,Consolas,monospace);font-variant-numeric:tabular-nums;}
.pid-tip .pid-tip-typ{display:block;margin-top:3px;color:var(--ink-off,#7A7A7A);font-size:10px;}

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
  const old = document.getElementById('pid-styles');
  if (old) old.parentNode.removeChild(old);
  const st = document.createElement('style');
  st.id = 'pid-styles';
  st.textContent = PID_CSS;
  document.head.appendChild(st);
  stylesInjected = true;
}

/* ===============================================================================================
 * 8.  SEGMENT TABLE
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
const SAMPLE_CHAIN = { 's-tank-s': 1, 's-drop-s': 1, 's-samp-disc': 1, 's-loop': 1, 's-iv-vent': 1 };

/* ===============================================================================================
 * 9.  BED TEXTURE
 * =============================================================================================*/

/** Per-canvas cache of the static bead texture. @type {WeakMap<object,object>} */
const TEXTURE_CACHE = new WeakMap();

/**
 * Build the static packed-bed bead texture: 1400 beads on a jittered hex lattice drawn once into an
 * offscreen canvas and blitted every frame.
 *
 * Determinism: the bead layout is drawn from a private PCG stream forked from `config.seed` at
 * `RNG_STREAMS.BED_TEXTURE`, so the texture is reproducible without perturbing the simulation.
 *
 * @param {number} seed the run seed (`config.seed`)
 * @param {object} theme a resolved theme
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

  const bead = theme.$bead;
  const rng = createRng((seed | 0) || 1).streams[RNG_STREAMS.BED_TEXTURE];

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
      const alpha = 0.12 + nextFloat(rng) * 0.14;
      g.globalAlpha = alpha;
      g.fillStyle = bead;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = alpha * 0.9;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, rad * 0.86, -0.35, 1.9);
      g.stroke();
    }
  }

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
  const cache = TEXTURE_CACHE.get(key);
  const stamp = theme.$bead + '|' + Math.round(scale * 100) + '|' + seed;
  if (cache && cache.stamp === stamp) return cache.tex;
  const tex = buildBedTexture(seed, theme, scale);
  TEXTURE_CACHE.set(key, { stamp, tex });
  return tex;
}

/** Fixed, stable air-bubble layout used by the BYPASS / CIP void rendering. */
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
 * 10.  THE BED PAINTER
 * =============================================================================================*/

/**
 * Paint the packed bed — bead texture, mobile-phase tint, gradient front, protein bands, radial
 * shading, wall channelling, air void and head-space compression, in that order.
 *
 * The painter works in a fixed {@link BED_W} x {@link BED_H} logical space (schematic units);
 * `opts.dpr` is the number of backing-store pixels per logical unit, so the caller may scale the
 * canvas freely and the numbers below never change.  Axial `z` runs top (column inlet) to bottom.
 *
 * @param {CanvasRenderingContext2D} bedCtx the bed canvas 2D context
 * @param {{pctB:Float32Array, species:Float32Array, speciesIds:string[],
 *          bedTopOffset_px:number, channelling:number, cMaxRef?:ArrayLike<number>}} snapshot
 *        the struct written by `physics/bed.js::bedAxialSnapshot`.  `species` is SPECIES-MAJOR,
 *        `species[band*nCells + cell]`, in mM.  `cMaxRef` is `run.bed.snapshotCMaxRef`; when it is
 *        absent the painter normalises each band by its own visible maximum.
 * @param {object} theme a resolved theme from the panel, or a bare `{'--token':value}` map
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

  /* ---- compression void, painted first so the bed sits on top of it -------------------------- */
  if (top > 0.5) {
    g.fillStyle = lutAt(T.lutAB, pctB[0]);
    g.globalAlpha = 0.5;
    g.fillRect(0, 0, BED_W, top);
    g.globalAlpha = 0.9;
    g.strokeStyle = rgba(T.$edge, 0.7);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, top);
    g.lineTo(BED_W, top);
    g.stroke();
    g.globalAlpha = 1;
  }

  /* ---- static bead texture, compressed into the remaining bed height ------------------------- */
  const tex = o.texture || getTexture(g, T, k, o.seed || 1);
  if (tex) g.drawImage(tex, 0, 0, tex.width, tex.height, 0, top, BED_W, bedH);

  /* ---- mobile-phase tint -------------------------------------------------------------------- */
  g.globalAlpha = 0.42;
  const stripH = Math.max(1, bedH / TINT_STRIPS);
  for (let i = 0; i < TINT_STRIPS; i++) {
    const z = (i + 0.5) / TINT_STRIPS;
    const cell = Math.min(n - 1, (z * n) | 0);
    g.fillStyle = lutAt(T.lutAB, pctB[cell]);
    g.fillRect(0, top + i * (bedH / TINT_STRIPS), BED_W, stripH);
  }
  g.globalAlpha = 1;

  /* ---- the salt / gradient front ------------------------------------------------------------ */
  let frontCell = -1;
  let frontMax = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = Math.abs(pctB[i + 1] - pctB[i]);
    if (d > frontMax) { frontMax = d; frontCell = i; }
  }
  if (frontCell >= 0 && frontMax > 0.35) {
    const y = top + (frontCell + 0.5) / n * bedH;
    const front = T.$front;
    const feather = g.createLinearGradient(0, y - 10, 0, y + 10);
    feather.addColorStop(0, rgba(front, 0));
    feather.addColorStop(0.5, rgba(front, 0.45));
    feather.addColorStop(1, rgba(front, 0));
    g.fillStyle = feather;
    g.fillRect(0, Math.max(0, y - 10), BED_W, 20);
    g.fillStyle = rgba(front, 0.55);
    g.fillRect(0, y - 1.5, BED_W, 3);
  }

  /* ---- protein bands, then band-peak sharpening --------------------------------------------- */
  const nBands = Math.min(4, snapshot.speciesIds ? snapshot.speciesIds.length : 0);
  g.globalCompositeOperation = 'screen';
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
      g.globalAlpha = 0.3;
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

  /* ---- radial realism — dark at the walls, ~8 % lighter at the centre ------------------------ */
  g.globalCompositeOperation = 'multiply';
  const radial = g.createLinearGradient(0, 0, BED_W, 0);
  radial.addColorStop(0, 'rgb(198,198,198)');
  radial.addColorStop(0.5, 'rgb(234,234,234)');
  radial.addColorStop(1, 'rgb(198,198,198)');
  g.fillStyle = radial;
  g.fillRect(0, top, BED_W, bedH);
  g.globalCompositeOperation = 'source-over';

  /* ---- air / void — BYPASS and CIP_DETECTOR_BYPASS only -------------------------------------- */
  if (o.showAir && (o.airFraction || 0) > 0) {
    const count = Math.max(3, Math.min(9, Math.round(3 + (o.airFraction || 0) * 60)));
    const phase = o.airPhase || 0;
    g.lineWidth = 1;
    for (let i = 0; i < count; i++) {
      const bub = AIR_BUBBLES[i];
      const t = (bub.phase + phase) % 1;
      const y = top + 4 + t * Math.min(bedH - 8, 90);
      g.globalAlpha = 0.85;
      g.fillStyle = T.$void;
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
 * 11.  TANK SLOT AND SERVICE-COLOUR HELPERS
 * =============================================================================================*/

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
 * Choose the service colour for a tank: sample amber, CIP teal, buffer-B violet, else buffer-A blue.
 * @param {object} config the frozen config
 * @param {object} theme a resolved theme
 * @param {number} tankIdx a `config.tanks` index, or -1
 * @param {number} cipIdx the resolved CIP tank index
 * @param {boolean} isBSide true when the tank feeds the B inlet
 * @returns {string} a CSS colour
 */
function tankColour(config, theme, tankIdx, cipIdx, isBSide) {
  if (tankIdx < 0) return theme['--pipe-idle'];
  if (tankIdx === cipIdx) return theme['--svc-cip'];
  const t = config.tanks[tankIdx];
  if (t && t.isSample) return theme['--svc-sample'];
  return isBSide ? theme['--svc-b'] : theme['--svc-a'];
}

/* ===============================================================================================
 * 12.  PUBLIC HELPERS
 * =============================================================================================*/

/**
 * Mark a set of process lines active and set the flow magnitude that drives the dash animation.
 *
 * The panel calls this itself every slow tick from the live valve state; it is exported so a host
 * view (or a test) can drive the schematic directly.  Dash offsets are advanced numerically at
 * 10 Hz from one accumulator per chain — never from a CSS custom property.
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
    if (seg.active !== on || seg.dirShown !== seg.dir) {
      seg.active = on;
      seg.base.classList.toggle('is-active', on);
      seg.flow.classList.toggle('is-flowing', on && !pid._reducedMotion);
      if (seg.dirShown !== seg.dir) {
        seg.dirShown = seg.dir;
        for (let a = 0; a < seg.arrows.length; a++) {
          const ar = seg.arrows[a];
          ar.node.setAttribute('transform', 'translate(' + ar.x.toFixed(2) + ','
            + ar.y.toFixed(2) + ') rotate(' + (ar.ang + (seg.dir < 0 ? 180 : 0)).toFixed(1) + ')');
        }
      }
      for (let a = 0; a < seg.arrows.length; a++) {
        seg.arrows[a].node.classList.toggle('is-shown', on);
      }
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
 * 13.  THE PANEL
 * =============================================================================================*/

/** Components whose instrument bubble reflects an alarm, and the alarm ids that drive it. */
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

/** Short display strings for the column-valve position label box. */
const CV_POS_TEXT = {
  BYPASS: 'BYPASS', DOWN: 'DOWN', UP: 'UP', ISOLATED: 'ISOL', CIP_DETECTOR_BYPASS: 'CIP BYP',
};

/**
 * Create the P&ID panel.
 *
 * @param {Element} rootEl the container the panel mounts into
 * @param {{config:object, run:object, bus:object, sim:object, fmt:object, overrides:object}} ctx
 *        the application context.  `ctx.sim` is the only mutation surface; this panel writes
 *        nothing to `config` or `run`.
 * @returns {{el:Element, mount:function():void, update:function(object=):void,
 *            destroy:function():void}} a Panel
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
    _sampleFlow_mLs: 0,
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
  const activeIds = [];
  const listeners = [];
  let ro = null;
  let mqMotion = null;
  let mqTheme = null;
  let themeObserver = null;

  /* ------------------------------------------------------------------------------------------ */
  /* small helpers                                                                               */
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
   * Show a transient inline message.  Interlock refusals are never silent.
   * @param {string} msg the message text
   * @param {boolean} [warn] render with the warning frame
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
   * Write text into a cached node only when it changed.
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
   * Set a lamp to one of its four states.
   * @param {Element|null} node the lamp group
   * @param {string} state `off`, `run`, `warn` or `alarm`
   * @param {boolean} [blink] blink the lamp (suppressed under reduced motion)
   * @returns {void}
   */
  function setLamp(node, state, blink) {
    if (!node) return;
    cls(node, 'is-run', state === 'run');
    cls(node, 'is-warn', state === 'warn');
    cls(node, 'is-alarm', state === 'alarm');
    cls(node, 'is-blink', !!blink && !pid._reducedMotion);
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
      trapLiq: q('pid-trap-liq'), trapMen: q('pid-trap-men'),
      ivCh: q('pid-iv-ch'), ivMode: q('pid-iv-mode'), ivG: q('pid-iv'),
      cvCh: q('pid-cv-ch'), cvG: q('pid-cv'), cvRotor: q('pid-cv-rotor'), cvArc: q('pid-cv-arc'),
      cvPos: q('pid-cv-pos'), cvPosV: q('pid-cv-pos-v'),
      cvCap: {
        n: q('pid-cv-cap-n'), e: q('pid-cv-cap-e'),
        s: q('pid-cv-cap-s'), w: q('pid-cv-cap-w'),
      },
      dvG: q('pid-dv'), dvArc: q('pid-dv-arc'),
      ftG: q('pid-ft'), ftV: q('pid-ft-f-v'), ftBox: q('pid-ft-f'), ftSpV: q('pid-ft-sp-v'),
      pctbG: q('pid-pctb'), pctbV: q('pid-pctb-f-v'), pctbSpV: q('pid-pctb-sp-v'),
      pt101G: q('pid-pt101'), pt101V: q('pid-pt101-f-v'), pt101Box: q('pid-pt101-f'),
      pt102G: q('pid-pt102'), pt102V: q('pid-pt102-f-v'), pt102Box: q('pid-pt102-f'),
      dpG: q('pid-dp'), dpV: q('pid-dp-f-v'), dpBox: q('pid-dp-f'),
      ttG: q('pid-tt'), ttV: q('pid-tt-f-v'), ttBox: q('pid-tt-f'),
      uvG: q('pid-uv'), uvI: q('pid-uv-i'), uvV: q('pid-uv-f-v'), uvBox: q('pid-uv-f'),
      ceG: q('pid-ce'), ceI: q('pid-ce-i'), ceV: q('pid-ce-f-v'), ceBox: q('pid-ce-f'),
      aeG: q('pid-ae'), aeI: q('pid-ae-i'), aeV: q('pid-ae-f-v'), aeBox: q('pid-ae-f'),
      wasteFill: q('pid-waste-fill'), wasteV: q('pid-waste-lv-v'), wasteBox: q('pid-waste-lv'),
      fracHead: q('pid-frac-head'), fracV: q('pid-frac-v'), fracBox: q('pid-frac'),
      vials: q('pid-vials'), profile: q('pid-profile-line'),
      tanks: [0, 1, 2, 3].map((i) => ({
        g: q('pid-tk' + i), role: q('pid-tk' + i + '-role'), id: q('pid-tk' + i + '-id'),
        fill: q('pid-tk' + i + '-fill'), men: q('pid-tk' + i + '-men'),
        val: q('pid-tk' + i + '-lv-v'), box: q('pid-tk' + i + '-lv'),
        lamp: q('pid-tk' + i + '-lamp'), hit: null,
      })),
      valves: { V1: q('pid-v-V1'), V2: q('pid-v-V2'), V3: q('pid-v-V3'), V4: q('pid-v-V4') },
    };
    for (let i = 0; i < 4; i++) {
      const g = nodes.tanks[i].g;
      nodes.tanks[i].hit = g ? g.querySelector('.pid-hit') : null;
    }
  }

  /**
   * Build the flow-dash overlay and the inline flow arrowheads from the idle pipe layer.
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

      const arrows = [];
      if (typeof base.getTotalLength === 'function') {
        try {
          const L = base.getTotalLength();
          if (L > 14) {
            const at = (L > 200) ? [0.25, 0.5, 0.75] : (L > 90 ? [0.35, 0.75] : [0.5]);
            for (let a = 0; a < at.length; a++) {
              const s = L * at[a];
              const p0 = base.getPointAtLength(Math.max(0, s - 2));
              const p1 = base.getPointAtLength(Math.min(L, s + 2));
              const mid = base.getPointAtLength(s);
              const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
              const node = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
              node.setAttribute('d', 'M-4,-4 L4.6,0 L-4,4 L-2,0 Z');
              node.setAttribute('transform', 'translate(' + mid.x.toFixed(2) + ','
                + mid.y.toFixed(2) + ') rotate(' + ang.toFixed(1) + ')');
              arrowLayer.appendChild(node);
              arrows.push({ node, x: mid.x, y: mid.y, ang });
            }
          }
        } catch (e) { arrows.length = 0; }
      }
      pid._segs[id] = { base, flow, arrows, active: false, dir: 1, dirShown: 1, colour: '' };
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
    const slotW = 282 / n;
    for (let i = 0; i < n; i++) {
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      const x = 894 + i * slotW;
      const w = Math.max(3, slotW - 2);
      const body = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      body.setAttribute('class', 'pid-vial');
      body.setAttribute('x', x.toFixed(2));
      body.setAttribute('y', '364');
      body.setAttribute('width', w.toFixed(2));
      body.setAttribute('height', '50');
      const fill = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      fill.setAttribute('class', 'pid-vial-fill');
      fill.setAttribute('x', x.toFixed(2));
      fill.setAttribute('y', '414');
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
      const active = (run.alarmActive && run.alarmActive[k])
        || (run.alarmLatched && run.alarmLatched[k]);
      if (!active) continue;
      const r = SEV_RANK[defs[k].severity] || 1;
      if (r > worst) worst = r;
    }
    return worst;
  }

  /**
   * Apply an alarm severity to an instrument group (bubble ring) and its label box (digits).
   * @param {Element|null} group the instrument group
   * @param {Element|null} box the label-box group
   * @param {string} componentId the component id
   * @returns {number} the resolved severity
   */
  function applyAlarm(group, box, componentId) {
    const sev = componentSeverity(componentId);
    cls(group, 'is-warn', sev === 1);
    cls(group, 'is-alarm', sev >= 2);
    cls(box, 'is-alarm', sev >= 2);
    return sev;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* layout                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Recompute the bed canvas position and backing size from the panel box.  Called only from the
   * ResizeObserver and from {@link scheduleRelayout}, never from `update`.
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
   * Size the bed canvas as soon as the panel has a box.  A panel mounted into a container that is
   * still `display:none` measures 0 x 0 and no ResizeObserver callback ever arrives, so retry.
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
   * Recompute the live flow path, the per-segment service colours and the dash directions from the
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
    const colCip = theme['--svc-cip'];
    const feedA = cipLive ? colCip : colA;

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
     * @param {string} colour the service colour
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
    if (cipLive) { add('s-tank-c', colCip); add('s-drop-c', colCip); }
    if (bLive) { add('s-tank-b', colB); add('s-drop-b', colB); add('s-hdr-2', colB); }
    if (aLive || bLive) add('s-hdr-1', bLive ? colB : colA);
    else if (cipLive) add('s-hdr-1', colCip);
    if (sLive) {
      add('s-tank-s', colS); add('s-drop-s', colS);
      if (mode !== 'LOOP_INJECT') add('s-samp-disc', colS);
    }
    if (mode === 'LOOP_FILL' || mode === 'LOOP_INJECT') add('s-loop', colS);
    if (mode === 'LOOP_FILL') add('s-iv-vent', colS);

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
      if (v.outletValve === 'WASTE') add('s-waste', theme['--svc-waste']);
      else add('s-collect', theme['--svc-product']);
    }

    setActiveSegments(pid, ids, Math.abs(run.Q_actual_mLs));
    pid._sampleFlow_mLs = Math.abs(run.QS_mLs || 0);
  }

  /**
   * Advance the dash offsets.  One accumulator per chain so dashes flow continuously through
   * junctions; a segment whose authored direction opposes the flow gets the negated offset and its
   * dashes visibly run backwards.
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
  /* slow lane — tag values, valves, tanks, collector                                             */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Update every label box, bubble, lamp, valve, tank and collector graphic.  Runs at 10 Hz.
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
    const slotRole = ['BUFFER A', 'BUFFER B', 'SAMPLE', 'CIP'];
    const slotLive = [
      !!run.valves.inletA && !slots.aIsCip, !!run.valves.inletB,
      !!run.valves.inletS, !!run.valves.inletA && slots.aIsCip,
    ];
    for (let i = 0; i < 4; i++) {
      const nd = nodes.tanks[i];
      const k = slotIdx[i];
      text(nd.role, slotRole[i]);
      if (k < 0 || k >= config.tanks.length) {
        text(nd.id, '—');
        text(nd.val, '—');
        setLamp(nd.lamp, 'off', false);
        if (nd.fill) nd.fill.setAttribute('height', '0');
        continue;
      }
      const t = config.tanks[k];
      const vol = run.tankVolume_mL[k];
      const cap = t.nominalVolume_mL || Math.max(vol, 1);
      const frac = clamp(vol / cap, 0, 1);
      const yTop = 100 - frac * 72;
      const colour = tankColour(config, theme, k, slots.cip, i === 1);
      if (nd.fill) {
        nd.fill.setAttribute('y', yTop.toFixed(2));
        nd.fill.setAttribute('height', (100 - yTop).toFixed(2));
        nd.fill.style.fill = colour;
      }
      if (nd.men) {
        nd.men.setAttribute('y1', yTop.toFixed(2));
        nd.men.setAttribute('y2', yTop.toFixed(2));
      }
      const fv = fmtTankVolume(vol);
      text(nd.id, String(t.label || t.id).slice(0, 12));
      text(nd.val, fv.value);
      const empty = vol <= (t.emptyLevel_mL || 0);
      const low = frac < ((t.lowLevelPct != null ? t.lowLevelPct : 10) / 100) && !empty;
      cls(nd.g, 'is-empty', empty);
      cls(nd.box, 'is-alarm', empty);
      setLamp(nd.lamp, empty ? 'alarm' : (low ? 'warn' : (slotLive[i] ? 'run' : 'off')), empty);
      if (nd.hit) {
        nd.hit.setAttribute('aria-label',
          slotRole[i] + ' tank, ' + (t.label || t.id) + ', ' + fv.value + ' ' + fv.unit + ', '
          + Math.round(frac * 100) + ' percent full');
      }
    }

    /* ---- inlet valves ---- */
    const vopen = { V1: slotLive[0], V2: slotLive[1], V3: slotLive[2], V4: slotLive[3] };
    const vcol = {
      V1: tankColour(config, theme, slots.a, slots.cip, false),
      V2: tankColour(config, theme, slots.b, slots.cip, true),
      V3: tankColour(config, theme, slots.s, slots.cip, false),
      V4: theme['--svc-cip'],
    };
    const vlabel = { V1: 'buffer A', V2: 'buffer B', V3: 'sample', V4: 'CIP' };
    for (const key of ['V1', 'V2', 'V3', 'V4']) {
      const g = nodes.valves[key];
      if (!g) continue;
      cls(g, 'is-open', vopen[key]);
      const bodies = g.querySelectorAll('.pid-vlv-body');
      for (let b = 0; b < bodies.length; b++) {
        bodies[b].style.fill = vopen[key] ? vcol[key] : '';
      }
      const hitEl = g.querySelector('.pid-hit');
      if (hitEl) {
        hitEl.setAttribute('aria-label',
          'Inlet valve ' + key + ', ' + vlabel[key] + ', ' + (vopen[key] ? 'open' : 'closed'));
      }
    }

    /* ---- pump ---- */
    cls(nodes.pumpG, 'is-running', run.Q_actual_mLs > 1e-6);

    /* ---- air trap ---- */
    if (nodes.trapLiq) {
      const trapSeg = (config.skid.segments || []).find((s) => s.id === 'G5');
      const trapV = trapSeg ? trapSeg.V_mL : 50;
      const gasFrac = clamp((run.trapHeadspace_mL || 0) / Math.max(trapV, 1e-9), 0, 1);
      const yTop = 166 + gasFrac * 58;
      nodes.trapLiq.setAttribute('y', yTop.toFixed(2));
      nodes.trapLiq.setAttribute('height', (224 - yTop).toFixed(2));
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
      nodes.ivCh.style.stroke = mode
        ? tankColour(config, theme, slots.s, slots.cip, false) : theme['--pipe-idle'];
    }
    text(nodes.ivMode, ivKey);

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
      if (nodes.cvRotor) {
        const deg = CV_ROTOR_DEG[pos] || 0;
        nodes.cvRotor.setAttribute('transform', 'rotate(' + deg + ')');
      }
    }
    if (nodes.cvCh) {
      nodes.cvCh.style.stroke = (pos === 'ISOLATED')
        ? theme['--pipe-idle'] : lutAt(theme.lutAB, run.pctB_actual);
    }
    text(nodes.cvPosV, moving ? 'MOVING' : (CV_POS_TEXT[pos] || String(pos)));
    cls(nodes.cvArc, 'is-moving', moving);
    if (moving && nodes.cvArc) {
      const tot = Math.max(0.05, config.skid.fracValve.tSwitch_s * 2);
      const frac = clamp(1 - run.valves.moveRemaining_s / tot, 0, 1);
      const circ = 2 * Math.PI * 22;
      nodes.cvArc.setAttribute('stroke-dasharray', (circ * frac).toFixed(1) + ' ' + circ.toFixed(1));
    }
    const cvFault = !moving && pos !== cmd && run.valves.mismatch_s > 0.5;
    cls(nodes.cvG, 'is-fault', cvFault);
    cls(nodes.cvPos, 'is-alarm', cvFault || componentSeverity('CV-101') >= 2);
    const cvHit = nodes.cvG && nodes.cvG.querySelector('.pid-hit');
    if (cvHit) {
      cvHit.setAttribute('aria-label',
        'Column valve CV-101, position ' + (moving ? 'moving to ' + cmd : pos));
    }

    /* ---- diverter + collector ---- */
    const outlet = run.valves.outletValve;
    const fmoving = !!run.frac.moving;
    cls(nodes.dvG, 'is-open', true);
    cls(nodes.dvG, 'is-moving', fmoving);
    cls(nodes.dvArc, 'is-moving', fmoving);
    if (fmoving && nodes.dvArc) {
      const frac = clamp(run.frac.moveElapsed_s
        / Math.max(config.skid.fracValve.tSwitch_s, 1e-6), 0, 1);
      const circ = 2 * Math.PI * 14;
      nodes.dvArc.setAttribute('stroke-dasharray', (circ * frac).toFixed(1) + ' ' + circ.toFixed(1));
    }
    const dvBodies = nodes.dvG ? nodes.dvG.querySelectorAll('.pid-vlv-body') : [];
    const dvCol = (outlet === 'WASTE') ? theme['--svc-waste'] : theme['--svc-product'];
    for (let b = 0; b < dvBodies.length; b++) {
      const isWasteLeg = dvBodies[b].classList.contains('pid-vlv-body--3');
      dvBodies[b].style.fill = (isWasteLeg === (outlet === 'WASTE')) ? dvCol : '';
    }

    const ports = config.skid.fracValve.ports;
    if (structural && vialNodes.length !== ports.length) buildVials();
    const cap = config.skid.fracValve.portCapacity_mL || 1;
    let activeVial = -1;
    for (let i = 0; i < vialNodes.length; i++) {
      const vn = vialNodes[i];
      const vol = run.portVolume_mL[i] || 0;
      const h = clamp(vol / cap, 0, 1) * 50;
      vn.fill.setAttribute('y', (414 - h).toFixed(2));
      vn.fill.setAttribute('height', h.toFixed(2));
      vn.fill.style.fill = lutAt(theme.lutAB, run.pctB_actual);
      const isActive = (ports[i] === outlet);
      if (isActive) activeVial = i;
      cls(vn.body, 'is-active', isActive);
    }
    if (nodes.fracHead) {
      const hx = (activeVial >= 0) ? vialNodes[activeVial].cx : 896;
      nodes.fracHead.setAttribute('transform', 'translate(' + hx.toFixed(2) + ',0)');
    }
    const portIdx = ports.indexOf(outlet);
    text(nodes.fracV, outlet === 'WASTE'
      ? 'WASTE' : outlet + ' ' + nfix(run.portVolume_mL[portIdx] || 0, 0));
    applyAlarm(nodes.dvG, nodes.fracBox, 'FC-101');

    /* ---- waste ---- */
    const wasteFrac = clamp(run.wasteVolume_mL / Math.max(config.skid.wasteCapacity_mL, 1), 0, 1);
    if (nodes.wasteFill) {
      const h = wasteFrac * 64;
      nodes.wasteFill.setAttribute('y', (404 - h).toFixed(2));
      nodes.wasteFill.setAttribute('height', h.toFixed(2));
    }
    text(nodes.wasteV, (run.wasteVolume_mL / 1000).toFixed(1));
    cls(nodes.wasteBox, 'is-alarm', componentSeverity('WASTE') >= 2);

    /* ---- label boxes ---- */
    text(nodes.ftV, nfix(60 * run.Q_actual_mLs, 1));
    text(nodes.ftSpV, nfix(60 * run.Q_set_mLs, 1));
    text(nodes.pctbV, nfix(run.pctB_actual, 1));
    text(nodes.pctbSpV, nfix(run.pctB_set, 1));
    text(nodes.pt101V, nfix(run.press.P1disp_bar, 2));
    text(nodes.pt102V, nfix(run.press.P2disp_bar, 2));
    text(nodes.dpV, nfix(run.dP_bar, 3));
    text(nodes.ttV, nfix(run.T_fluid_C, 1));
    text(nodes.uvV, nfix(1000 * run.uv.Afilt[0], 1));
    text(nodes.ceV, nfix(run.cond.kappaDisp_mScm, 2));
    text(nodes.aeV, nfix(run.ph.pHfilt, 2));

    applyAlarm(nodes.ftG, nodes.ftBox, 'P-101');
    applyAlarm(nodes.pt101G, nodes.pt101Box, 'PT-101');
    applyAlarm(nodes.pt102G, nodes.pt102Box, 'PT-102');
    applyAlarm(nodes.dpG, nodes.dpBox, 'PDT-101');
    applyAlarm(nodes.ttG, nodes.ttBox, 'TT-101');
    applyAlarm(nodes.uvI, nodes.uvBox, 'UV-101');
    applyAlarm(nodes.ceI, nodes.ceBox, 'CE-101');
    applyAlarm(nodes.aeI, nodes.aeBox, 'AE-101');

    /* ---- detector quality: bypassed / invalid / suspect digits ---- */
    const bypassed = run.valves.columnValve === 'CIP_DETECTOR_BYPASS';
    const qf = run.qualityFlags | 0;
    const uvBad = (qf & 0x0004) !== 0 || run.uv.saturated;
    const uvSusp = (qf & (0x0001 | 0x0002 | 0x0008 | 0x0400)) !== 0 || run.uv.overrange;
    const det = [
      [nodes.uvG, nodes.uvBox, uvBad, uvSusp],
      [nodes.ceG, nodes.ceBox, (qf & 0x0010) !== 0, (qf & (0x0020 | 0x0400)) !== 0],
      [nodes.aeG, nodes.aeBox, (qf & 0x0040) !== 0, (qf & (0x0080 | 0x0400)) !== 0],
    ];
    for (let i = 0; i < det.length; i++) {
      const row = det[i];
      cls(row[0], 'is-bypassed', bypassed);
      cls(row[1], 'is-stale', bypassed || row[2] || row[3]);
    }

    /* ---- manual-mode outline ---- */
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
        const x = 614 + clamp(buf[p] / profileMax, 0, 1) * 13;
        const y = BED_Y + (p + 0.5) / pts * BED_H;
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
   * Resolve the glossary id for a schematic component.
   * @param {string} componentId the component id
   * @returns {string} a glossary id
   */
  function glossaryIdFor(componentId) {
    if (componentId === 'TK-A') return tankIdOf(slots.a);
    if (componentId === 'TK-B') return tankIdOf(slots.b);
    if (componentId === 'TK-S') return tankIdOf(slots.s);
    if (componentId === 'TK-CIP') return tankIdOf(slots.cip);
    if (/^TK-[A-Z]+-LT$/.test(componentId)) return 'tank.lowLevelPct';
    if (/^V[1-4]$/.test(componentId)) return 'inlet-valve';
    if (componentId === 'PCTB') return 'skid.gradientMode';
    if (componentId === 'WASTE') return 'skid.wasteCapacity_mL';
    return componentId;
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
   * Compose the one-line live value shown for a component in its tooltip and faceplate header.
   * @param {string} componentId the component id
   * @returns {string} the live value line, possibly empty
   */
  function liveLineFor(componentId) {
    const run = pid._run;
    const F = pid._ctx.fmt || {};
    if (componentId === 'PT-101') {
      return (typeof F.fmtPressure === 'function')
        ? F.fmtPressure(run.press.P1disp_bar) : nfix(run.press.P1disp_bar, 3) + ' bar';
    }
    if (componentId === 'PT-102') {
      return (typeof F.fmtPressure === 'function')
        ? F.fmtPressure(run.press.P2disp_bar) : nfix(run.press.P2disp_bar, 3) + ' bar';
    }
    if (componentId === 'PDT-101') return nfix(run.dP_bar, 3) + ' bar';
    if (componentId === 'FT-101' || componentId === 'P-101') {
      return (typeof F.fmtFlow === 'function')
        ? F.fmtFlow(run.Q_actual_mLs, pid._config) : nfix(60 * run.Q_actual_mLs, 2) + ' mL/min';
    }
    if (componentId === 'UV-101') {
      return nfix(1000 * run.uv.Afilt[0], 1) + ' mAU (280 nm), '
        + nfix(1000 * run.uv.Afilt[1], 1) + ' mAU (260 nm)';
    }
    if (componentId === 'CE-101') return nfix(run.cond.kappaDisp_mScm, 3) + ' mS/cm';
    if (componentId === 'AE-101') return nfix(run.ph.pHfilt, 2) + ' pH';
    if (componentId === 'TT-101') {
      return nfix(run.T_fluid_C, 1) + ' °C fluid, ' + nfix(run.T_cell_C, 1) + ' °C cell';
    }
    if (componentId === 'CV-101') {
      return 'Position ' + run.valves.columnValve
        + (run.valves.cmdColumnValve !== run.valves.columnValve
          ? ' (commanded ' + run.valves.cmdColumnValve + ')' : '');
    }
    if (componentId === 'DV-101' || componentId === 'FC-101') {
      return 'Outlet ' + run.valves.outletValve + ', ' + run.frac.records.length
        + ' fractions closed';
    }
    if (componentId === 'WASTE') {
      return (run.wasteVolume_mL / 1000).toFixed(2) + ' L of '
        + (pid._config.skid.wasteCapacity_mL / 1000).toFixed(0) + ' L';
    }
    if (componentId === 'PCTB') {
      return nfix(run.pctB_actual, 1) + ' % B at the mixer, '
        + nfix(run.pctB_colInlet, 1) + ' % B at the column inlet';
    }
    if (componentId === 'C-101') {
      return 'Bed ΔP ' + nfix(run.dPbed_bar, 3) + ' bar, '
        + nfix(run.V_tot_mL / pid._config.column.V_mL, 2) + ' CV delivered';
    }
    if (componentId.indexOf('TK-') === 0) {
      const base = componentId.replace(/-LT$/, '');
      const k = { 'TK-A': slots.a, 'TK-B': slots.b, 'TK-S': slots.s, 'TK-CIP': slots.cip }[base];
      if (k >= 0) {
        const fv = fmtTankVolume(run.tankVolume_mL[k]);
        return fv.value + ' ' + fv.unit + ' remaining';
      }
    }
    return '';
  }

  /**
   * Open the faceplate for a component.  `ui/overlay.js::showFaceplate` is the primary path; when
   * the host has not provided one the panel publishes the request on the bus and falls back to the
   * glossary card so a click is never inert.
   * @param {string} componentId the component id
   * @param {Element|null} anchorEl the element the faceplate should point at
   * @returns {void}
   */
  function openFaceplate(componentId, anchorEl) {
    const c = pid._ctx;
    const host = c.overlayHost || null;
    const entry = glossaryFor(glossaryIdFor(componentId));
    const payload = {
      componentId, tag: componentId, ctx: c, anchorEl, entry, live: liveLineFor(componentId),
    };
    if (c.bus && typeof c.bus.emit === 'function') c.bus.emit('pid-activate', payload);
    if (host && typeof overlay.showFaceplate === 'function') {
      try {
        overlay.showFaceplate(host, payload);
        return;
      } catch (e) { /* fall through to the bus / glossary path */ }
    }
    if (c.bus && typeof c.bus.emit === 'function') c.bus.emit('faceplate-open', payload);
    if (host && entry && typeof overlay.showGlossaryPopover === 'function') {
      overlay.showGlossaryPopover(host, { anchorEl, entry, placement: 'right' });
    }
  }

  /**
   * Direct manipulation of a valve (double-click or Shift+Enter) while MANUAL is engaged.
   * Refusals surface their `reason` verbatim.
   * @param {string} componentId the component id
   * @returns {void}
   */
  function cycleValve(componentId) {
    const sim = pid._ctx.sim || {};
    const run = pid._run;
    const config = pid._config;
    if (!/^(V[1-4]|CV-101|DV-101)$/.test(componentId)) return;
    if (!run.manualOverride) {
      showToast('MANUAL OFF — ' + componentId + ' LOCKED', true);
      return;
    }
    if (typeof sim.manualSet !== 'function') return;

    let cmd = null;
    if (componentId === 'V1' || componentId === 'V2' || componentId === 'V4') {
      const side = (componentId === 'V2') ? 'B' : 'A';
      const key = (side === 'B') ? 'inletB' : 'inletA';
      const avail = Object.keys(config.inletAssignments || {})
        .filter((p) => p.charAt(0) === side && config.inletAssignments[p]);
      if (!avail.length) { showToast('NO TANK ON INLET ' + side, true); return; }
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
      if (!run.valves.inletS && !avail.length) { showToast('NO SAMPLE TANK ON S PORT', true); return; }
      cmd = { inletS: run.valves.inletS ? null : (avail[0] || null) };
    } else if (componentId === 'CV-101') {
      const order = ['BYPASS', 'DOWN', 'UP', 'ISOLATED', 'CIP_DETECTOR_BYPASS'];
      const cur = order.indexOf(run.valves.cmdColumnValve);
      cmd = { columnValve: order[(cur + 1) % order.length] };
    } else if (componentId === 'DV-101') {
      const ports = config.skid.fracValve.ports;
      cmd = (run.valves.outletValve === 'WASTE')
        ? { outletValve: ports[clamp(run.frac.nextPortIdx, 0, ports.length - 1)] || 'WASTE' }
        : { outletValve: 'WASTE' };
    }
    if (!cmd) return;
    const r = sim.manualSet(pid._ctx, cmd);
    if (r && r.ok === false) showToast(String(r.reason || 'COMMAND REFUSED'), true);
  }

  /**
   * Compose and position the hover tooltip from `data/glossary.js` plus the live value.
   * @param {string} componentId the component id
   * @param {number} clientX pointer x in client coordinates
   * @param {number} clientY pointer y in client coordinates
   * @returns {void}
   */
  function showTip(componentId, clientX, clientY) {
    const entry = glossaryFor(glossaryIdFor(componentId));
    if (!entry) { hideTip(); return; }
    const live = liveLineFor(componentId);

    tip.textContent = '';
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
    const x = clamp(clientX - box.left + 14, 4, Math.max(4, box.width - 262));
    const y = clamp(clientY - box.top + 14, 4, Math.max(4, box.height - 130));
    tip.style.left = x.toFixed(0) + 'px';
    tip.style.top = y.toFixed(0) + 'px';
    tip.classList.add('is-shown');
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
   * Rebind every cached reference after `config`/`run` are replaced.
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
      const h = pidHitTest(pid, e);
      if (h) openFaceplate(h.componentId, e.target);
    });
    on(el, 'dblclick', (e) => {
      const h = pidHitTest(pid, e);
      if (h) cycleValve(h.componentId);
    });
    on(el, 'keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const h = pidHitTest(pid, e);
      if (!h) return;
      e.preventDefault();
      if (e.shiftKey) cycleValve(h.componentId);
      else openFaceplate(h.componentId, e.target);
    });
    on(el, 'pointermove', (e) => {
      const h = pidHitTest(pid, e);
      if (!h) { if (hoverId) hideTip(); return; }
      if (h.componentId !== hoverId) hoverId = h.componentId;
      showTip(h.componentId, e.clientX, e.clientY);
    });
    on(el, 'pointerleave', hideTip);
    on(el, 'focusin', (e) => {
      const h = pidHitTest(pid, e);
      if (!h) return;
      const box = e.target.getBoundingClientRect();
      showTip(h.componentId, box.left + box.width / 2, box.bottom);
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
   * exceeds the 2 ms budget), the dash offsets and impeller (10 Hz / per-frame), and the label-box
   * values plus valve graphics (10 Hz).
   *
   * @param {{now_ms?:number, dt_ms?:number, tick?:number, structural?:boolean}} [frameInfo]
   *        the frame descriptor
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
      impellerAngle = (impellerAngle
        + (60 + 300 * clamp(pid._run.Q_actual_mLs / qmax, 0, 1)) * dt_s) % 360;
      nodes.impeller.setAttribute('transform',
        'rotate(' + impellerAngle.toFixed(1) + ',40,200)');
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
