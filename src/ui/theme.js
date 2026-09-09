/**
 * src/ui/theme.js — the palette system: which schemes ship, how one is chosen and remembered, and
 * the colour arithmetic that proves each scheme is as legible as it claims to be.
 *
 * Layer L5, beside `dom.js`. Only `applyTheme`, `ensureThemeStylesheet` and the controller touch
 * the document; everything above them — the parser, the contrast checker, the colour-vision
 * simulation — is pure and is unit-tested in Node against the shipped CSS itself.
 *
 * ------------------------------------------------------------------------------------------
 * WHY MORE THAN ONE PALETTE
 *
 * `styles/tokens.css` ships one deliberate early-2010s graphite scheme and it stays the default.
 * It is the right screen for the room it was drawn for: a dim control room, a big panel, an
 * operator who has been looking at it for six hours. Four other rooms exist:
 *
 *   · a bright one. Sun on the glass at 14:00 washes a dark scheme out completely. This is a
 *     legibility constraint, not a taste in themes, and LIGHT exists for it.
 *   · a night shift on old iron. AMBER is the monochrome phosphor look, one hue and nothing
 *     else, which is genuinely restful at 03:00 and is still what a lot of plants run.
 *   · a workstation whose operator cannot resolve low contrast — age, glare, a cheap panel.
 *     CONTRAST answers that, and answers it to AAA rather than to a vibe.
 *   · an operator who cannot separate red from green. Roughly one man in twelve cannot, and the
 *     graphite scheme leans on exactly that axis: running is green, alarm is red, and under
 *     deuteranopia those two are the same muddy ochre. SAFE moves the whole status vocabulary
 *     onto the blue-yellow axis plus lightness, where the distinction survives.
 *
 * THE CLAIM IS CHECKED, NOT ASSERTED. Every scheme in `THEMES` carries the contrast level it
 * claims and the exact pairs where it knowingly falls short. `tests/theme.test.js` parses the
 * shipped CSS, runs every pair through `auditScheme`, and fails if a claim is untrue OR if a
 * declared exception is not real. A high-contrast theme that is not high-contrast is worse than
 * no high-contrast theme: it is a promise an operator plans their day around.
 *
 * EVERY SCHEME DEFINES EVERY TOKEN. `THEME_TOKENS` is the contract, and the test asserts each
 * scheme satisfies it in full. Partial overrides that inherit the rest from graphite would look
 * fine today and break the first time a token is added — the new token would resolve to a
 * graphite colour on a light background, which is how you get white-on-white readouts in the
 * field six months after anyone remembers why.
 * ------------------------------------------------------------------------------------------
 */

/* ============================================================================================
   1. COLOUR ARITHMETIC
   ========================================================================================== */

/** Named colours the token set is allowed to use. Anything else must be hex or rgb(). */
const NAMED = Object.freeze({
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
});

/**
 * Parse a CSS colour into 8-bit channels plus alpha.
 *
 * Deliberately narrow: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` in either the
 * comma or the space form, and the three names above. A token written as anything else — a
 * gradient, a `color-mix`, an hsl — returns null rather than a wrong colour, and the audit
 * reports it as unparseable instead of quietly scoring it as black.
 *
 * @param {string} str the CSS colour text
 * @returns {?{r:number,g:number,b:number,a:number}} channels 0-255 and alpha 0-1, or null
 */
export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(NAMED, s)) return { ...NAMED[s] };

  if (s[0] === '#') {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const expand = (c) => parseInt(c + c, 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]),
        g: expand(hex[1]),
        b: expand(hex[2]),
        a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  /**
   * One channel, honouring the percentage form.
   * @param {string} tok the raw token
   * @param {number} scale the value a bare 1.0 or 100% means
   * @returns {number} the numeric value
   */
  const chan = (tok, scale) => (tok.endsWith('%')
    ? (parseFloat(tok) / 100) * scale
    : parseFloat(tok));
  const r = chan(parts[0], 255);
  const g = chan(parts[1], 255);
  const b = chan(parts[2], 255);
  const a = parts.length === 4 ? chan(parts[3], 1) : 1;
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return {
    r: Math.min(255, Math.max(0, r)),
    g: Math.min(255, Math.max(0, g)),
    b: Math.min(255, Math.max(0, b)),
    a: Math.min(1, Math.max(0, a)),
  };
}

/**
 * Undo the sRGB transfer function for one channel.
 * @param {number} c the channel, 0-255
 * @returns {number} the linear-light value, 0-1
 */
function toLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/**
 * Apply the sRGB transfer function to one linear channel.
 * @param {number} v the linear-light value, 0-1
 * @returns {number} the channel, 0-255
 */
function fromLinear(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * (Math.max(0, v) ** (1 / 2.4)) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

/**
 * WCAG relative luminance.
 * @param {{r:number,g:number,b:number}} rgb the colour; alpha is ignored, composite first
 * @returns {number} luminance, 0-1
 */
export function relativeLuminance(rgb) {
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/**
 * Composite a translucent colour over an opaque one (simple source-over).
 *
 * Every `--*-soft` token in this rig is an rgba fill laid over chrome, and a chip's text is read
 * against the RESULT, not against the fill's nominal colour. Scoring `--ok-ink` against
 * `rgba(76,175,80,0.16)` as if it were opaque green would report a contrast the operator never
 * sees.
 *
 * @param {{r:number,g:number,b:number,a:number}} fg the upper colour
 * @param {{r:number,g:number,b:number,a:number}} bg the lower colour, treated as opaque
 * @returns {{r:number,g:number,b:number,a:number}} the flattened colour
 */
export function compositeOver(fg, bg) {
  const a = fg.a === undefined ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/**
 * The WCAG 2.x contrast ratio between two colours, 1 to 21.
 *
 * Either argument may be translucent; both are flattened onto `base` first, in the order a
 * browser would paint them (background over base, foreground over background).
 *
 * @param {string|object} fg the foreground colour or parsed triple
 * @param {string|object} bg the background colour or parsed triple
 * @param {string|object} [base] what sits under a translucent background; defaults to the
 *   background itself, i.e. assume it is opaque
 * @returns {number} the ratio, or NaN if either colour cannot be parsed
 */
export function contrastRatio(fg, bg, base) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return NaN;
  const u = base === undefined ? null : (typeof base === 'string' ? parseColor(base) : base);
  const bgFlat = b.a !== undefined && b.a < 1 && u ? compositeOver(b, u) : b;
  const fgFlat = f.a !== undefined && f.a < 1 ? compositeOver(f, bgFlat) : f;
  const l1 = relativeLuminance(fgFlat);
  const l2 = relativeLuminance(bgFlat);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------------------------------------------------------------------------
   Colour-vision simulation.

   Viénot, Brettel & Mollon (1999): take the colour into LMS cone space, collapse the missing
   cone's response onto the plane the two surviving cones can still describe, and come back. It is
   the standard linear dichromat model — not a claim about what any individual sees, but a sound
   way to ask "do these two indicator colours still differ when one cone class is gone".
   ------------------------------------------------------------------------------------------ */

/** Linear sRGB to LMS. */
const RGB_TO_LMS = Object.freeze([
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
]);

/** LMS back to linear sRGB. */
const LMS_TO_RGB = Object.freeze([
  [0.080944447, -0.130504409, 0.116721066],
  [-0.010248533, 0.054019327, -0.113614708],
  [-0.000365297, -0.004121615, 0.693511405],
]);

/** The three dichromacies, as the substitution each makes for its missing cone. */
export const CVD_TYPES = Object.freeze(['protanopia', 'deuteranopia', 'tritanopia']);

/**
 * Simulate how a dichromat sees a colour.
 * @param {string|object} color the colour; alpha is carried through untouched
 * @param {string} type one of {@link CVD_TYPES}
 * @returns {?{r:number,g:number,b:number,a:number}} the simulated colour, or null if unparseable
 */
export function simulateCvd(color, type) {
  const c = typeof color === 'string' ? parseColor(color) : color;
  if (!c) return null;
  if (!CVD_TYPES.includes(type)) return { ...c };
  const lin = [toLinear(c.r), toLinear(c.g), toLinear(c.b)];
  const lms = RGB_TO_LMS.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  let [L, M, S] = lms;
  if (type === 'protanopia') L = 2.02344 * M - 2.52581 * S;
  else if (type === 'deuteranopia') M = 0.494207 * L + 1.24827 * S;
  else S = -0.395913 * L + 0.801109 * M;
  const out = LMS_TO_RGB.map((row) => row[0] * L + row[1] * M + row[2] * S);
  return {
    r: fromLinear(out[0]),
    g: fromLinear(out[1]),
    b: fromLinear(out[2]),
    a: c.a === undefined ? 1 : c.a,
  };
}

/** D65 white point, for the Lab conversion. */
const D65 = Object.freeze({ x: 0.95047, y: 1, z: 1.08883 });

/**
 * CIE L*a*b* of a colour, D65.
 * @param {{r:number,g:number,b:number}} rgb the colour
 * @returns {{L:number,a:number,b:number}} the Lab triple
 */
export function toLab(rgb) {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65.x;
  const y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / D65.y;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / D65.z;
  /**
   * The CIE cube-root companding with its linear toe.
   * @param {number} t the normalised tristimulus value
   * @returns {number} the companded value
   */
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIE76 colour difference. Crude next to CIEDE2000, but monotonic and transparent, which is what
 * a threshold in a test wants: roughly, under 10 is "the same colour to a glance", over 25 is
 * "obviously two colours".
 * @param {string|object} a first colour
 * @param {string|object} b second colour
 * @returns {number} deltaE, or NaN if either is unparseable
 */
export function deltaE76(a, b) {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) return NaN;
  const la = toLab(ca);
  const lb = toLab(cb);
  return Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
}

/* ============================================================================================
   2. THE TOKEN CONTRACT
   ========================================================================================== */

/**
 * Every colour token a scheme must define, in the order `styles/themes.css` writes them.
 *
 * This is the whole colour surface of the application: the eleven chrome greys, the ink ramp, the
 * accent, the recessed value fields, the four states as fill and as small text, the equipment, the
 * depth atoms, the lamps, the plot well and its pens, and the head-capacity curves. Geometry,
 * type, spacing and motion are NOT here — they are theme-independent and stay in `tokens.css`.
 *
 * A scheme that omits one of these is rejected by the test, not silently patched at runtime.
 */
export const THEME_TOKENS = Object.freeze([
  // chrome
  '--screen', '--panel', '--panel-hi', '--panel-lo', '--edge', '--edge-soft',
  // ink
  '--ink', '--ink-2', '--ink-3',
  // accent
  '--accent', '--accent-soft', '--accent-hover', '--accent-press', '--accent-ink',
  // value fields
  '--fld-bg', '--fld-edge', '--fld-pv', '--fld-sp', '--fld-out', '--fld-alarm', '--fld-stale',
  '--fld-eu', '--fld-rule',
  // state as fill
  '--ok', '--warn', '--alarm', '--info',
  '--ok-soft', '--warn-soft', '--alarm-soft', '--info-soft', '--neutral-soft',
  '--on-ok', '--on-warn', '--on-alarm',
  // state as small text
  '--ok-ink', '--warn-ink', '--alarm-ink', '--info-ink',
  // equipment
  '--equip-top', '--equip-bot', '--equip-edge', '--pipe-idle',
  // depth atoms
  '--spec', '--spec-edge', '--shade', '--shade-deep', '--shade-press', '--shade-float',
  // tints and scrims
  '--hover-tint', '--press-tint', '--dim', '--disabled-veil',
  // lamps
  '--lamp-off', '--lamp-run', '--lamp-warn', '--lamp-alarm', '--lamp-info', '--lamp-ring',
  '--lamp-gloss', '--glow-run', '--glow-warn', '--glow-alarm', '--glow-info',
  // the plot well
  '--plot-grid', '--plot-grid-strong', '--plot-axis', '--plot-lane', '--plot-cursor',
  // pens
  '--pen-pv', '--pen-sp', '--pen-true', '--pen-co', '--pen-p1', '--pen-p2', '--pen-q',
  '--pen-cursor',
  // head-capacity curves
  '--curve-pump', '--curve-ref', '--curve-sys', '--curve-bep', '--curve-band',
  // process
  '--flow-dash',
  // inverse ink
  '--text-inv', '--sel-ink', '--estop-ink',
]);

/**
 * Every pair of tokens that puts TEXT on a BACKGROUND, with the size class the application
 * actually renders it at.
 *
 * `large` follows WCAG: at least 18.66px bold or 24px plain. Almost nothing in this HMI qualifies
 * — the type scale tops out at 16px and the labels are 10-11px — so the honest answer is `false`
 * nearly everywhere, which is why the thresholds bite.
 *
 * `over` names what sits UNDER a translucent background, so a chip's ink is scored against the
 * colour the operator sees rather than against a nominal rgba.
 */
export const TEXT_PAIRS = Object.freeze([
  { fg: '--ink', bg: '--screen', what: 'primary text on the desktop' },
  { fg: '--ink', bg: '--panel', what: 'primary text on a panel' },
  { fg: '--ink', bg: '--panel-hi', what: 'primary text on a panel header' },
  { fg: '--ink', bg: '--panel-lo', what: 'primary text in a recess' },
  { fg: '--ink', bg: '--equip-top', what: 'an equipment label on the vessel it names' },
  { fg: '--ink-2', bg: '--panel', what: 'secondary text on a panel' },
  { fg: '--ink-2', bg: '--panel-hi', what: 'secondary text on a panel header' },
  { fg: '--ink-3', bg: '--panel', what: 'tertiary and disabled text on a panel' },

  { fg: '--fld-pv', bg: '--fld-bg', what: 'the PV digits' },
  { fg: '--fld-sp', bg: '--fld-bg', what: 'the SP digits' },
  { fg: '--fld-out', bg: '--fld-bg', what: 'the manual output digits' },
  { fg: '--fld-alarm', bg: '--fld-bg', what: 'a value in alarm' },
  { fg: '--fld-stale', bg: '--fld-bg', what: 'a stale value' },
  { fg: '--fld-eu', bg: '--fld-bg', what: 'the engineering-unit suffix' },

  { fg: '--ok-ink', bg: '--panel', what: 'OK as small text' },
  { fg: '--warn-ink', bg: '--panel', what: 'WARNING as small text' },
  { fg: '--alarm-ink', bg: '--panel', what: 'ALARM as small text' },
  { fg: '--info-ink', bg: '--panel', what: 'INFO as small text' },
  { fg: '--accent-ink', bg: '--panel', what: 'an active control label' },

  { fg: '--ok-ink', bg: '--ok-soft', over: '--panel', what: 'OK text on its own soft chip' },
  { fg: '--warn-ink', bg: '--warn-soft', over: '--panel', what: 'WARNING text on its soft chip' },
  { fg: '--alarm-ink', bg: '--alarm-soft', over: '--panel', what: 'the alarm banner' },
  { fg: '--info-ink', bg: '--info-soft', over: '--panel', what: 'INFO text on its soft chip' },
  { fg: '--accent-ink', bg: '--accent-soft', over: '--panel', what: 'the selected tab' },
  { fg: '--ink-3', bg: '--neutral-soft', over: '--panel', what: 'a stale banner' },

  { fg: '--on-ok', bg: '--ok', what: 'text on a solid OK fill' },
  { fg: '--on-warn', bg: '--warn', what: 'text on a solid WARNING fill' },
  { fg: '--on-alarm', bg: '--alarm', what: 'text on a solid ALARM fill' },
  { fg: '--estop-ink', bg: '--alarm', what: 'the E-STOP legend' },
  { fg: '--sel-ink', bg: '--accent', what: 'text on a selection' },
  { fg: '--text-inv', bg: '--accent', what: 'inverse text on the accent' },

  { fg: '--plot-axis', bg: '--panel-lo', what: 'the trend tick labels' },
]);

/**
 * Pairs that are not text but still carry meaning, and so fall under WCAG 1.4.11 at 3:1: the
 * pens the trend is read from, the curves, the alarm lamp, and the focus ring.
 *
 * The lamps are deliberately NOT scored against each other here. A lamp's colour is not the only
 * thing distinguishing it — position, legend and blink all carry state too — and requiring
 * lamp-to-lamp luminance separation would fail the graphite scheme for having a green run lamp
 * and a red alarm lamp, which is a real problem but a different one. That problem is what
 * `auditStatusSeparation` is for.
 */
export const GRAPHIC_PAIRS = Object.freeze([
  { fg: '--pen-pv', bg: '--panel-lo', what: 'the PV pen against the plot well' },
  { fg: '--pen-sp', bg: '--panel-lo', what: 'the SP pen' },
  { fg: '--pen-true', bg: '--panel-lo', what: 'the unfiltered-truth pen' },
  { fg: '--pen-co', bg: '--panel-lo', what: 'the controller-output pen' },
  { fg: '--pen-p1', bg: '--panel-lo', what: 'the P-101 pen' },
  { fg: '--pen-p2', bg: '--panel-lo', what: 'the P-102 pen' },
  { fg: '--pen-q', bg: '--panel-lo', what: 'the flow pen' },
  { fg: '--curve-pump', bg: '--panel-lo', what: 'the pump curve' },
  { fg: '--curve-sys', bg: '--panel-lo', what: 'the system curve' },
  { fg: '--curve-bep', bg: '--panel-lo', what: 'the BEP marker' },
  { fg: '--lamp-alarm', bg: '--panel', what: 'the alarm lamp against its panel' },
  { fg: '--accent', bg: '--panel', what: 'the focus ring against a panel' },
  { fg: '--edge', bg: '--panel', what: 'a control border against its panel' },
]);

/**
 * The three tokens that carry PLANT STATE, which is the set an operator must be able to tell
 * apart at a glance and across the room. `auditStatusSeparation` walks the three pairs of these.
 */
export const STATUS_TOKENS = Object.freeze(['--lamp-run', '--lamp-warn', '--lamp-alarm']);

/** WCAG thresholds, by level and by text size. */
export const LEVELS = Object.freeze({
  AA: Object.freeze({ normal: 4.5, large: 3 }),
  AAA: Object.freeze({ normal: 7, large: 4.5 }),
});

/** The minimum contrast for a meaningful non-text mark, WCAG 1.4.11. */
export const GRAPHIC_MIN = 3;

/* ============================================================================================
   3. THE SCHEMES
   ========================================================================================== */

/**
 * Every palette in the build, in the order the picker shows them.
 *
 * `attr` is the `data-theme` value; `graphite` uses `dark` because `styles/tokens.css` already
 * keys the default palette to it and index.html stamps it before first paint.
 *
 * `contrast.level` is the level the scheme CLAIMS across `TEXT_PAIRS`, and `contrast.exceptions`
 * lists the pairs where it knowingly does not reach it. The test proves both directions: no
 * unlisted pair may fall short, and no listed exception may secretly pass. That second half is
 * what stops this list from rotting into a blanket excuse.
 */
export const THEMES = Object.freeze([
  Object.freeze({
    id: 'graphite',
    attr: 'dark',
    label: 'Graphite',
    colorScheme: 'dark',
    source: 'styles/tokens.css',
    summary: 'The shipped early-2010s HMI scheme: cool graphite chrome, white PV and amber SP.',
    when: 'A normally lit or dim control room. This is the default and the one the screens were '
      + 'drawn for; change it only for a reason below.',
    contrast: Object.freeze({
      level: 'AA',
      exceptions: Object.freeze([
        Object.freeze({
          fg: '--on-alarm',
          bg: '--alarm',
          why: 'White on the saturated alarm red reaches about 4.2:1. Saturated red cannot exceed '
            + '5.3:1 against anything, so the fix is a darker fill or black legend in tokens.css, '
            + 'which this module does not own. HIGH CONTRAST and SAFE both clear 7:1 here.',
        }),
        Object.freeze({
          fg: '--estop-ink',
          bg: '--alarm',
          why: 'The E-STOP legend rides the same alarm red as above.',
        }),
      ]),
    }),
    cvdSafe: false,
  }),
  Object.freeze({
    id: 'contrast',
    attr: 'contrast',
    label: 'High contrast',
    colorScheme: 'dark',
    source: 'styles/themes.css',
    summary: 'Black ground, white rules, light saturated fills carrying black legends. Every text '
      + 'pair clears WCAG AAA.',
    when: 'Low vision, a glare-washed or failing panel, or any workstation where the graphite '
      + 'greys have stopped separating. Also the safe choice when you do not know the screen.',
    contrast: Object.freeze({ level: 'AAA', exceptions: Object.freeze([]) }),
    cvdSafe: false,
  }),
  Object.freeze({
    id: 'light',
    attr: 'light',
    label: 'Light',
    colorScheme: 'light',
    source: 'styles/themes.css',
    summary: 'Paper-white panels and dark ink, with the state fills darkened so their legends stay '
      + 'readable.',
    when: 'A bright room: daylight on the glass, a window behind the operator, a projector or a '
      + 'printed hand-over. A dark scheme in that room is not a preference, it is unreadable.',
    contrast: Object.freeze({ level: 'AA', exceptions: Object.freeze([]) }),
    cvdSafe: false,
  }),
  Object.freeze({
    id: 'amber',
    attr: 'amber',
    label: 'Amber phosphor',
    colorScheme: 'dark',
    source: 'styles/themes.css',
    summary: 'Monochrome amber on near-black. One hue; state is carried by brightness, by legend '
      + 'and by blink, exactly as it was on the tube.',
    when: 'Night shift, and any room where a full-colour screen is too much light. Plenty of '
      + 'plants still run amber panels, and operators who grew up on them read them faster.',
    contrast: Object.freeze({ level: 'AA', exceptions: Object.freeze([]) }),
    cvdSafe: true,
  }),
  Object.freeze({
    id: 'safe',
    attr: 'safe',
    label: 'Colour-vision safe',
    colorScheme: 'dark',
    source: 'styles/themes.css',
    summary: 'Graphite chrome with the status vocabulary moved off the red-green axis: running is '
      + 'blue, warning is orange, alarm is a bright yellow plate.',
    when: 'Anyone who cannot reliably separate red from green — about one man in twelve. On the '
      + 'default scheme a green run lamp and a red alarm lamp are nearly the same colour to them.',
    contrast: Object.freeze({ level: 'AA', exceptions: Object.freeze([]) }),
    cvdSafe: true,
  }),
]);

/** The scheme the application opens on when storage is empty or unreadable. */
export const DEFAULT_THEME = 'graphite';

/** Where the choice lives in the injected storage. */
export const STORAGE_KEY = 'skid.ui.theme';

/** The stylesheet carrying every non-default scheme. */
export const THEME_HREF = './styles/themes.css';

/**
 * Look one scheme up.
 * @param {string} id the scheme id
 * @returns {?object} the record, or null
 */
export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || null;
}

/**
 * The picker's data: every scheme with the description of when it is the right one.
 * @returns {Array<object>} id, label, summary, when, the claimed level and the CVD flag
 */
export function listThemes() {
  return THEMES.map((t) => ({
    id: t.id,
    label: t.label,
    summary: t.summary,
    when: t.when,
    level: t.contrast.level,
    exceptions: t.contrast.exceptions.length,
    cvdSafe: t.cvdSafe,
    colorScheme: t.colorScheme,
  }));
}

/* ============================================================================================
   4. READING THE SHIPPED CSS
   ========================================================================================== */

/**
 * Strip comments and at-rule blocks from a stylesheet.
 *
 * At-rules are dropped rather than descended into on purpose: `@media (prefers-contrast: more)`
 * and friends HARDEN a palette, so auditing them would score a scheme better than the palette it
 * normally shows. The audit is of the base palette, which is what almost every operator sees.
 *
 * @param {string} css the stylesheet text
 * @returns {string} the text with comments and at-rule blocks removed
 */
function stripNonPalette(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  for (let i = 0; i < noComments.length; i += 1) {
    if (noComments[i] !== '@') { out += noComments[i]; continue; }
    // Skip to the end of this at-rule: either its balanced block or its terminating semicolon.
    let j = i;
    let depth = 0;
    let opened = false;
    while (j < noComments.length) {
      const ch = noComments[j];
      if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { j += 1; break; }
      } else if (ch === ';' && !opened) { j += 1; break; }
      j += 1;
    }
    i = j - 1;
  }
  return out;
}

/**
 * Parse the custom properties out of a stylesheet, keyed by the `data-theme` value each rule
 * selects — plus a `root` bucket for rules that select `:root` with no theme attribute.
 *
 * A rule listing several selectors contributes to each of them, so `tokens.css`'s
 * `:root, [data-theme="dark"]` lands in both `root` and `dark`. Later rules win, as they do in a
 * browser.
 *
 * @param {string} css the stylesheet text
 * @returns {{root:object, byTheme:object}} raw declaration maps, values still unresolved
 */
export function parseThemeCss(css) {
  const text = stripNonPalette(String(css || ''));
  const root = {};
  const byTheme = {};
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m = rule.exec(text);
  while (m) {
    const selectors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const decls = {};
    const dec = /(--[\w-]+)\s*:\s*([^;]+)(?:;|$)/g;
    let d = dec.exec(m[2]);
    while (d) {
      decls[d[1]] = d[2].trim();
      d = dec.exec(m[2]);
    }
    if (Object.keys(decls).length) {
      for (const sel of selectors) {
        const attr = /\[data-theme\s*=\s*["']?([\w-]+)["']?\]/.exec(sel);
        if (attr) {
          byTheme[attr[1]] = Object.assign(byTheme[attr[1]] || {}, decls);
        } else if (/:root|^html\b/.test(sel)) {
          Object.assign(root, decls);
        }
      }
    }
    m = rule.exec(text);
  }
  return { root, byTheme };
}

/**
 * Expand `var(--x)` and `var(--x, fallback)` until nothing is left to expand.
 *
 * The rig leans on derived tokens — `--plot-bg: var(--panel-lo)`, `--valve-open: var(--ok)` — and
 * the contrast checker needs concrete colours. The depth guard stops a circular definition from
 * hanging the audit; a token that cannot be resolved keeps its raw text and is reported as
 * unparseable rather than silently scored.
 *
 * @param {object} decls a declaration map, name to value
 * @returns {object} the same map with var() references resolved where possible
 */
export function resolveVars(decls) {
  const out = {};
  /**
   * Resolve one value.
   * @param {string} value the raw declaration text
   * @param {number} depth recursion guard
   * @returns {string} the resolved text
   */
  function expand(value, depth) {
    if (depth > 12 || !value.includes('var(')) return value;
    const next = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name, fb) => {
      if (Object.prototype.hasOwnProperty.call(decls, name)) return decls[name];
      return fb === undefined ? whole : fb.trim();
    });
    return next === value ? value : expand(next, depth + 1);
  }
  for (const k of Object.keys(decls)) out[k] = expand(decls[k], 0);
  return out;
}

/**
 * Build one scheme's resolved token map from parsed stylesheets.
 *
 * Graphite is the merge of `tokens.css`'s `:root` block with its `[data-theme="dark"]` block —
 * that is genuinely how the browser assembles it, and half its lamps and pens live in the `:root`
 * block. Every other scheme must stand alone: it is read from its own `[data-theme]` rules only,
 * so a token it forgot shows up as missing instead of quietly inheriting graphite's value.
 *
 * @param {Array<{root:object, byTheme:object}>} parsed the sheets, in link order
 * @param {string} attr the `data-theme` value
 * @param {boolean} [withRoot=false] fold the bare `:root` declarations in as well
 * @returns {object} the resolved token map
 */
export function resolveScheme(parsed, attr, withRoot = false) {
  const merged = {};
  for (const sheet of parsed) {
    if (withRoot) Object.assign(merged, sheet.root);
    Object.assign(merged, sheet.byTheme[attr] || {});
  }
  return resolveVars(merged);
}

/* ============================================================================================
   5. THE CHECKER
   ========================================================================================== */

/**
 * Score one scheme's token map against the WCAG level it claims.
 *
 * @param {object} tokens a resolved token map, name to colour text
 * @param {object} [opts] options
 * @param {string} [opts.level='AA'] 'AA' or 'AAA'
 * @param {Array<object>} [opts.pairs=TEXT_PAIRS] the pairs to score
 * @param {Array<object>} [opts.exceptions=[]] pairs allowed to fall short, as {fg, bg}
 * @returns {{ok:boolean, level:string, results:Array<object>, failures:Array<object>,
 *   unparseable:Array<object>, excused:Array<object>, worst:?object}} the report
 */
export function auditScheme(tokens, opts) {
  const o = opts || {};
  const level = o.level === 'AAA' ? 'AAA' : 'AA';
  const pairs = o.pairs || TEXT_PAIRS;
  const exceptions = o.exceptions || [];
  const results = [];
  const failures = [];
  const unparseable = [];
  const excused = [];

  for (const p of pairs) {
    const fgText = tokens[p.fg];
    const bgText = tokens[p.bg];
    const overText = p.over ? tokens[p.over] : undefined;
    const min = p.min !== undefined
      ? p.min
      : LEVELS[level][p.large ? 'large' : 'normal'];
    const excusedHere = exceptions.some((e) => e.fg === p.fg && e.bg === p.bg);
    const ratio = contrastRatio(fgText, bgText, overText === undefined ? bgText : overText);
    const row = {
      fg: p.fg,
      bg: p.bg,
      what: p.what,
      ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : NaN,
      min,
      pass: Number.isFinite(ratio) && ratio >= min,
      excused: excusedHere,
    };
    results.push(row);
    if (!Number.isFinite(ratio)) unparseable.push(row);
    else if (!row.pass && !excusedHere) failures.push(row);
    if (excusedHere) excused.push(row);
  }

  const scored = results.filter((r) => Number.isFinite(r.ratio));
  const worst = scored.length
    ? scored.reduce((a, b) => (b.ratio < a.ratio ? b : a))
    : null;
  return {
    ok: failures.length === 0 && unparseable.length === 0,
    level,
    results,
    failures,
    unparseable,
    excused,
    worst,
  };
}

/**
 * Check that a scheme's tokens are all present.
 * @param {object} tokens a resolved token map
 * @param {Array<string>} [required=THEME_TOKENS] the contract
 * @returns {{ok:boolean, missing:Array<string>, unparseable:Array<string>}} the report
 */
export function auditTokenSet(tokens, required = THEME_TOKENS) {
  const missing = [];
  const unparseable = [];
  for (const name of required) {
    const v = tokens[name];
    if (v === undefined || v === '') missing.push(name);
    else if (!parseColor(v)) unparseable.push(name);
  }
  return { ok: missing.length === 0 && unparseable.length === 0, missing, unparseable };
}

/**
 * Check that the status vocabulary survives dichromacy.
 *
 * Every pair drawn from {@link STATUS_TOKENS} is simulated for each listed vision type and the
 * CIE76 difference between them measured. `minDeltaE` of 20 is the working threshold: below it
 * two indicators are the same colour to a glance across a room.
 *
 * Tritanopia is not in the default type list. This scheme moves state ONTO the blue-yellow axis,
 * which is precisely the axis a tritanope loses — but tritanopia affects roughly one person in ten
 * thousand against one man in twelve for the red-green forms, and no single palette serves both.
 * The honest answer for a tritanope is HIGH CONTRAST or AMBER, where state is carried by
 * lightness, and `listThemes()` says so.
 *
 * @param {object} tokens a resolved token map
 * @param {object} [opts] options
 * @param {Array<string>} [opts.types] vision types; defaults to protanopia and deuteranopia
 * @param {number} [opts.minDeltaE=20] the separation required
 * @returns {{ok:boolean, results:Array<object>, failures:Array<object>}} the report
 */
export function auditStatusSeparation(tokens, opts) {
  const o = opts || {};
  const types = o.types || ['protanopia', 'deuteranopia'];
  const minDeltaE = o.minDeltaE === undefined ? 20 : o.minDeltaE;
  const results = [];
  for (const type of types) {
    for (let i = 0; i < STATUS_TOKENS.length; i += 1) {
      for (let j = i + 1; j < STATUS_TOKENS.length; j += 1) {
        const a = tokens[STATUS_TOKENS[i]];
        const b = tokens[STATUS_TOKENS[j]];
        const sa = simulateCvd(a, type);
        const sb = simulateCvd(b, type);
        const dE = sa && sb ? deltaE76(sa, sb) : NaN;
        results.push({
          type,
          a: STATUS_TOKENS[i],
          b: STATUS_TOKENS[j],
          deltaE: Number.isFinite(dE) ? Math.round(dE * 10) / 10 : NaN,
          min: minDeltaE,
          pass: Number.isFinite(dE) && dE >= minDeltaE,
        });
      }
    }
  }
  const failures = results.filter((r) => !r.pass);
  return { ok: failures.length === 0, results, failures };
}

/* ============================================================================================
   6. APPLYING AND REMEMBERING THE CHOICE
   ========================================================================================== */

/**
 * Read the stored choice.
 *
 * Nothing here throws. An absent storage (Node, a test, a locked-down embed), a `getItem` that
 * throws (some privacy modes do), and a value written by a build that shipped a scheme this one
 * no longer has are all ordinary, and all of them mean "use the default".
 *
 * @param {{getItem:Function}|null} storage anything with `getItem`, or null
 * @returns {string} a valid scheme id
 */
export function loadTheme(storage) {
  if (!storage || typeof storage.getItem !== 'function') return DEFAULT_THEME;
  let raw = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_THEME;
  }
  return getTheme(String(raw || '')) ? String(raw) : DEFAULT_THEME;
}

/**
 * Persist the choice.
 *
 * A `setItem` that throws — Safari private browsing, any browser at quota — must not take the
 * applied theme down with it. The caller has already changed the screen; failing to write the
 * preference costs the operator one re-pick next session and nothing else.
 *
 * @param {{setItem:Function}|null} storage anything with `setItem`, or null
 * @param {string} id the scheme id
 * @returns {{ok:boolean, reason?:string}} whether it was written
 */
export function saveTheme(storage, id) {
  if (!getTheme(id)) return { ok: false, reason: `no such theme: ${id}` };
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, reason: 'no storage is available; the choice lasts until the tab closes' };
  }
  try {
    storage.setItem(STORAGE_KEY, id);
  } catch (err) {
    return { ok: false, reason: `the choice could not be saved: ${err && err.message}` };
  }
  return { ok: true };
}

/**
 * Make sure `styles/themes.css` is linked, and linked LAST.
 *
 * Order is load-bearing. Both `:root` in `tokens.css` and `:root[data-theme="light"]` here would
 * otherwise be resolved by source order, so a themes sheet linked before tokens.css would lose
 * every declaration to the default palette. The attribute selectors carry higher specificity as a
 * belt to this brace, but the belt is cheap and the failure is total.
 *
 * @param {Document} doc the document
 * @param {string} [href=THEME_HREF] the stylesheet URL
 * @returns {{ok:boolean, added:boolean, reason?:string}} what happened
 */
export function ensureThemeStylesheet(doc, href = THEME_HREF) {
  if (!doc || !doc.head || typeof doc.createElement !== 'function') {
    return { ok: false, added: false, reason: 'no document to install the stylesheet into' };
  }
  const already = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))
    .some((l) => (l.getAttribute('href') || '').endsWith('themes.css'));
  if (already) return { ok: true, added: false };
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  doc.head.appendChild(link);
  return { ok: true, added: true };
}

/**
 * Put a scheme on the screen.
 *
 * Sets `data-theme` and keeps the `color-scheme` meta in step, so the browser paints its own
 * furniture — scrollbars, form controls, the canvas behind the page — to match. A light palette
 * inside a window the browser still believes is dark shows up as a dark scrollbar down the side of
 * a white screen.
 *
 * @param {Document} doc the document
 * @param {string} id the scheme id
 * @returns {{ok:boolean, id?:string, reason?:string}} the result
 */
export function applyTheme(doc, id) {
  const theme = getTheme(id);
  if (!theme) return { ok: false, reason: `no such theme: ${id}` };
  if (!doc || !doc.documentElement) return { ok: false, reason: 'no document to theme' };
  doc.documentElement.setAttribute('data-theme', theme.attr);
  doc.documentElement.style.colorScheme = theme.colorScheme;
  const meta = doc.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', theme.colorScheme);
  return { ok: true, id: theme.id };
}

/**
 * The object the settings view drives: current scheme, the list to draw, and one way to change it.
 *
 * Applying and persisting are deliberately separate steps inside `set`. The screen changes even
 * when the write fails, because a theme the operator cannot save is still a theme they can see.
 *
 * @param {object} [deps] injected dependencies
 * @param {Document} [deps.doc] the document; defaults to the global one when there is one
 * @param {{getItem:Function,setItem:Function}|null} [deps.storage] the store
 * @param {string} [deps.href] the themes stylesheet URL
 * @returns {{id:()=>string, list:()=>Array<object>, set:(id:string)=>object, next:()=>object,
 *   reset:()=>object}} the controller
 */
export function createThemeController(deps) {
  const d = deps || {};
  const doc = d.doc !== undefined
    ? d.doc
    : (typeof document === 'undefined' ? null : document);
  const storage = d.storage === undefined ? null : d.storage;
  let current = loadTheme(storage);

  if (doc) {
    ensureThemeStylesheet(doc, d.href || THEME_HREF);
    applyTheme(doc, current);
  }

  return {
    /** @returns {string} the current scheme id */
    id: () => current,
    /** @returns {Array<object>} the picker's rows */
    list: () => listThemes(),
    /**
     * Change scheme.
     * @param {string} id the scheme id
     * @returns {{ok:boolean, id?:string, reason?:string, saved?:boolean}} the result
     */
    set(id) {
      const applied = doc ? applyTheme(doc, id) : (getTheme(id)
        ? { ok: true, id }
        : { ok: false, reason: `no such theme: ${id}` });
      if (!applied.ok) return applied;
      current = id;
      const saved = saveTheme(storage, id);
      return { ok: true, id, saved: saved.ok, reason: saved.ok ? undefined : saved.reason };
    },
    /**
     * Step to the next scheme in the list — the keyboard shortcut's behaviour.
     * @returns {object} as {@link set}
     */
    next() {
      const i = THEMES.findIndex((t) => t.id === current);
      return this.set(THEMES[(i + 1) % THEMES.length].id);
    },
    /**
     * Go back to the shipped default.
     * @returns {object} as {@link set}
     */
    reset() {
      return this.set(DEFAULT_THEME);
    },
  };
}
