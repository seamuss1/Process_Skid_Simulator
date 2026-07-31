/**
 * @file src/ui/overlay.js — every floating surface in the application, in one place, drawn in the
 *                           FT-CLASSIC idiom (beveled grey chrome, sunken label boxes, ISA tags).
 *
 * Popovers, glossary cards, modals, confirm dialogs, toasts, coach marks, the `?` cheat sheet and
 * **the faceplate** all live here for one reason: **focus handling is written once**. Modals and
 * popovers trap focus and restore it, `Esc` closes the topmost surface, and every interactive
 * element keeps a real focus ring. Six views each rolling their own dialog would give six subtly
 * different answers.
 *
 * THE FACEPLATE is the characteristic widget of this aesthetic. {@link showFaceplate} opens a small
 * modeless beveled window titled with an ISA tag, carrying a PV label box, an SP label box where a
 * setpoint exists, a vertical bargraph with SP and alarm-limit markers painted on its scale, AUTO /
 * MAN indicator lamps, and the tag's actions as icon buttons. It is opened by clicking an instrument
 * bubble in the P&ID, and it is the reason the main screen needs almost no text: the numbers, the
 * limits and the controls for one loop are all one click away, and nowhere else.
 *
 * This module also owns:
 *  - viewport-flipping placement with a clamped 6 px arrow;
 *  - the dim and the `clip-path` cut-out the tour spotlights with;
 *  - the 250 ms show / 60 ms hide hover timing;
 *  - the toast surface every `{ok:false, reason}` from `core/sim.js` goes through —
 *    **interlocks are explained, never silently refused**.
 *
 * LAYERING: it imports `ui/format.js` and nothing else. In particular it does **not** import
 * `data/glossary.js`: the glossary is content, owned by `src/data/glossary.js`, and the views that
 * render an `ⓘ` already import `glossaryFor`. They pass the resolved entry to
 * {@link showGlossaryPopover}, which knows the four-section layout but not a word of the text.
 *
 * STYLING: geometry (position, size, clip, bar fill) is computed and therefore inline. Appearance
 * comes from class names so `styles/app.css` owns the look. A complete FT-CLASSIC base stylesheet is
 * injected once inside `@layer chromaskid-overlay`, so every surface here is correct with
 * `styles/tokens.css` alone; because unlayered author rules always beat layered ones, `app.css`
 * overrides it without a specificity fight. No colour literal appears in this file — every colour is
 * a `var(--token)` from `styles/tokens.css`.
 *
 * TEXT POLICY: buttons on a process screen are icon-only. The one deliberate exception is a dialog
 * action button, which renders its caller-supplied `label` in 10 px uppercase — a classic
 * FactoryTalk dialog has OK / CANCEL on its buttons, and refusing to render the label would break
 * every dialog in the application. Action specs may also carry an `icon`, and an icon-only action
 * (no `label`) renders as a square icon button.
 *
 * @module ui/overlay
 */

import { h, hSvg, setText, setAttr, cls, fmtFixed, NO_VALUE } from './format.js';

/* =================================================================================================
 * 0. CONSTANTS AND BASE STYLES
 * ===============================================================================================*/

/** Hover show / hide delays. */
const TOOLTIP_SHOW_MS = 250;
const TOOLTIP_HIDE_MS = 60;

/** Gap between an anchor and its floating surface, and the minimum margin to the viewport edge. */
const ANCHOR_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;
const ARROW_PX = 6;

/** Default lifetimes per toast kind, ms. `blocked` lives longest: it explains a refusal. */
const TOAST_MS = { info: 3500, warn: 5000, blocked: 6000 };

/** Stacking order inside the overlay root. */
const Z = { popover: 10, faceplate: 20, modal: 30, coach: 40, toast: 50 };

/** Faceplate geometry. JS and CSS read the same numbers, so the markers land on the scale. */
const FP_W = 230;
const FP_BAR_H = 196;
const FP_BAR_PAD = 2;
const FP_MARK_H = 2;
/** How far each new faceplate is offset from the previous one, px. */
const FP_CASCADE_PX = 18;
/** Keyboard nudge for a focused faceplate title bar, px (×4 with Shift). */
const FP_NUDGE_PX = 8;

/** Elements that can take focus, for the focus trap. */
const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

/** The two bevel recipes, written once. Every surface in this file uses one of them. */
const BEV_RAISED = 'inset 1px 1px 0 var(--bev-hi),inset -1px -1px 0 var(--bev-dk),'
  + 'inset 2px 2px 0 var(--bev-lt),inset -2px -2px 0 var(--bev-sh)';
const BEV_SUNKEN = 'inset 1px 1px 0 var(--bev-dk),inset -1px -1px 0 var(--bev-hi),'
  + 'inset 2px 2px 0 var(--bev-sh),inset -2px -2px 0 var(--bev-lt)';
/** A hard 90s drop shadow. No blur: this aesthetic has no soft shadows. */
const BEV_DROP = '3px 3px 0 var(--bev-dk)';

const BASE_CSS = `@layer chromaskid-overlay, chromaskid-onboarding;
@layer chromaskid-overlay {
.ov-root{position:fixed;inset:0;z-index:1000;pointer-events:none;
  font-family:var(--font-ui);font-size:11px;line-height:1.35;color:var(--ink);}
.ov-root>*{pointer-events:auto;}
.ov-root *{box-sizing:border-box;border-radius:0;}
.ov-root p{margin:0 0 6px;}
.ov-root p:last-child{margin-bottom:0;}
.ov-root ul,.ov-root ol{margin:0 0 6px;padding-left:16px;}
.ov-root li{margin:1px 0;}
.ov-root h2,.ov-root h3,.ov-root h4{margin:0 0 3px;font-size:11px;font-weight:700;color:var(--ink);}
.ov-root strong{font-weight:700;color:var(--ink);}
.ov-root code,.ov-root kbd{font-family:var(--font-num);}
.ov-root :focus-visible{outline:2px solid var(--fld-sp);outline-offset:1px;}

/* ---- bevel utilities ------------------------------------------------------------------------ */
.ov-raised{box-shadow:${BEV_RAISED};}
.ov-sunken{box-shadow:${BEV_SUNKEN};}
.ov-sep{flex:0 0 auto;width:2px;align-self:stretch;margin:0 2px;
  box-shadow:inset 1px 0 0 var(--bev-dk),inset -1px 0 0 var(--bev-hi);}

/* ---- the dim -------------------------------------------------------------------------------- */
.ov-dim{position:fixed;inset:0;background:var(--dim,rgba(0,0,0,.55));pointer-events:auto;}

/* ---- generic beveled window ------------------------------------------------------------------ */
.ov-win{position:fixed;display:flex;flex-direction:column;background:var(--face);
  box-shadow:${BEV_RAISED},${BEV_DROP};color:var(--ink);}
.ov-win__tt{flex:0 0 auto;display:flex;align-items:center;gap:5px;height:20px;padding:0 2px 0 5px;
  background:var(--face-2);box-shadow:inset 0 -1px 0 var(--bev-sh);
  font:700 10px/1 var(--font-ui);letter-spacing:.04em;text-transform:uppercase;color:var(--ink);
  -webkit-user-select:none;user-select:none;}
.ov-win__tt--drag{padding-left:2px;cursor:move;}
.ov-win__tag{flex:0 0 auto;font-family:var(--font-num);letter-spacing:.06em;}
.ov-win__sp{flex:1 1 auto;min-width:6px;}
.ov-win__body{flex:1 1 auto;overflow:auto;padding:6px;}

/* ---- buttons -------------------------------------------------------------------------------- */
.ov-ib{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;padding:0;background:var(--face);border:0;color:var(--ink);
  cursor:pointer;box-shadow:${BEV_RAISED};}
.ov-ib--lg{width:22px;height:22px;}
.ov-ib>svg,.ov-ib>span{display:block;pointer-events:none;}
.ov-ib>span{font:700 9px/1 var(--font-num);letter-spacing:.02em;}
.ov-ib:active,.ov-ib[aria-pressed="true"]{box-shadow:${BEV_SUNKEN};}
.ov-ib:active>svg,.ov-ib:active>span,
.ov-ib[aria-pressed="true"]>svg,.ov-ib[aria-pressed="true"]>span{transform:translate(1px,1px);}
.ov-ib[disabled]{color:var(--ink-off);cursor:default;}
.ov-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:5px;
  min-width:64px;height:22px;padding:0 9px;background:var(--face);border:0;color:var(--ink);
  cursor:pointer;font:700 10px/1 var(--font-ui);letter-spacing:.04em;text-transform:uppercase;
  box-shadow:${BEV_RAISED};}
.ov-btn:active{box-shadow:${BEV_SUNKEN};}
.ov-btn:active .ov-btn__t,.ov-btn:active .ov-btn__i{transform:translate(1px,1px);}
.ov-btn[disabled]{color:var(--ink-off);cursor:default;}
.ov-btn__i{flex:0 0 auto;display:block;}
.ov-btn__t{flex:0 0 auto;white-space:nowrap;}
.ov-btn--primary::after{content:'';position:absolute;inset:3px;outline:1px dotted var(--ink-2);}

/* ---- label box (the sunken numeric display) --------------------------------------------------- */
.ov-lbl{display:block;font:700 9px/1.4 var(--font-ui);letter-spacing:.04em;text-transform:uppercase;
  color:var(--ink-2);}
.ov-fld{display:flex;align-items:baseline;justify-content:flex-end;gap:3px;min-width:0;
  padding:2px 4px;background:var(--fld-bg);color:var(--fld-pv);box-shadow:${BEV_SUNKEN};
  font:700 13px/1.25 var(--font-num);font-variant-numeric:tabular-nums lining-nums;}
.ov-fld--pv{font-size:16px;}
.ov-fld--sp{color:var(--fld-sp);}
.ov-fld--out{color:var(--fld-out);}
.ov-fld--alarm{color:var(--fld-alarm);}
.ov-fld--stale{color:var(--fld-stale);}
.ov-fld__v{overflow:hidden;white-space:nowrap;text-overflow:clip;}
.ov-fld__eu{flex:0 0 auto;font-size:80%;font-weight:400;color:var(--fld-eu);}

/* ---- status lamps ---------------------------------------------------------------------------- */
.ov-lamp{position:relative;flex:0 0 auto;display:inline-block;width:10px;height:10px;
  border-radius:50%;background:var(--lamp-off);box-shadow:inset 0 0 0 1px var(--bev-dk);}
.ov-lamp::after{content:'';position:absolute;left:2px;top:1px;width:3px;height:2px;
  border-radius:50%;background:var(--bev-hi);opacity:.8;}
.ov-lamp--lg{width:12px;height:12px;}
.ov-lamp--run{background:var(--lamp-run);}
.ov-lamp--warn{background:var(--lamp-warn);}
.ov-lamp--alarm{background:var(--lamp-alarm);}
.ov-lamp--info{background:var(--fld-out);}
.ov-lamp--blink{animation:ov-blink 1s steps(1,end) infinite;}
@keyframes ov-blink{0%,50%{opacity:1}50.01%,100%{opacity:.25}}

/* ---- popovers and tooltips -------------------------------------------------------------------- */
.ov-card{position:fixed;background:var(--face);box-shadow:${BEV_RAISED},${BEV_DROP};color:var(--ink);}
.ov-popover{padding:6px 8px;max-width:280px;}
.ov-popover--tip{padding:3px 6px;background:var(--face-2);font-size:10px;}
.ov-arrow{position:absolute;width:${ARROW_PX * 2}px;height:${ARROW_PX * 2}px;background:var(--face);}
.ov-arrow--top{clip-path:polygon(0 0,100% 0,50% 100%);}
.ov-arrow--bottom{clip-path:polygon(50% 0,100% 100%,0 100%);}
.ov-arrow--left{clip-path:polygon(0 0,100% 50%,0 100%);}
.ov-arrow--right{clip-path:polygon(100% 0,100% 100%,0 50%);}

/* ---- modal ------------------------------------------------------------------------------------ */
.ov-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;
  flex-direction:column;max-width:min(92vw,560px);max-height:86vh;background:var(--face);
  box-shadow:${BEV_RAISED},${BEV_DROP};color:var(--ink);}
.ov-modal__head{flex:0 0 auto;display:flex;align-items:center;gap:5px;height:22px;padding:0 2px 0 6px;
  background:var(--face-2);box-shadow:inset 0 -1px 0 var(--bev-sh);
  -webkit-user-select:none;user-select:none;}
.ov-modal__title{margin:0;flex:1 1 auto;font:700 10px/1 var(--font-ui);letter-spacing:.04em;
  text-transform:uppercase;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ov-modal__close{margin-left:auto;}
.ov-modal__body{flex:1 1 auto;overflow:auto;padding:8px;color:var(--ink);}
.ov-modal__actions{flex:0 0 auto;display:flex;justify-content:flex-end;gap:6px;padding:6px 8px;
  background:var(--face-2);box-shadow:inset 0 1px 0 var(--bev-hi);}
.ov-root input[type="text"],.ov-root input[type="search"],.ov-root input[type="number"],
.ov-root input:not([type]),.ov-root select,.ov-root textarea{
  padding:2px 4px;background:var(--fld-bg);color:var(--fld-pv);border:0;box-shadow:${BEV_SUNKEN};
  font:400 11px/1.4 var(--font-num);font-variant-numeric:tabular-nums lining-nums;}

/* ---- toasts: small sunken strips with a severity lamp ------------------------------------------ */
.ov-toasts{position:fixed;right:8px;bottom:30px;display:flex;flex-direction:column-reverse;gap:4px;
  max-width:min(92vw,340px);pointer-events:none;}
.ov-toast{pointer-events:auto;display:flex;align-items:center;gap:6px;padding:3px 3px 3px 6px;
  background:var(--face-2);box-shadow:${BEV_SUNKEN};font-size:11px;color:var(--ink);}
.ov-toast__msg{flex:1 1 auto;min-width:0;}
.ov-toast__count{flex:0 0 auto;font:700 10px/1 var(--font-num);color:var(--ink-2);
  font-variant-numeric:tabular-nums;}

/* ---- coach marks ------------------------------------------------------------------------------ */
.ov-coach{max-width:320px;padding:0;}
.ov-coach__body-wrap{padding:8px;}
.ov-coach__step{display:inline-block;margin:0 0 4px;padding:1px 4px;background:var(--fld-bg);
  box-shadow:${BEV_SUNKEN};font:700 10px/1.3 var(--font-num);color:var(--fld-sp);}
.ov-coach__title{margin:0 0 4px;font:700 11px/1.3 var(--font-ui);color:var(--ink);}
.ov-coach__body{margin:0;font-size:11px;color:var(--ink-2);white-space:pre-line;}
.ov-coach__actions{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--face-2);
  box-shadow:inset 0 1px 0 var(--bev-hi);}
.ov-coach__dots{display:flex;gap:3px;margin-right:auto;}
.ov-coach__dot{width:6px;height:6px;background:var(--bev-sh);}
.ov-coach__dot--on{background:var(--fld-sp);}

/* ---- cheat sheet ------------------------------------------------------------------------------ */
.ov-cheat{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px 18px;}
.ov-cheat__group{break-inside:avoid;}
.ov-cheat__gt{margin:0 0 3px;font:700 9px/1.4 var(--font-ui);letter-spacing:.04em;
  text-transform:uppercase;color:var(--ink-2);}
.ov-cheat__row{display:flex;align-items:center;gap:8px;padding:1px 0;}
.ov-cheat__key{flex:0 0 auto;min-width:76px;padding:1px 4px;background:var(--face);
  box-shadow:${BEV_RAISED};font:700 10px/1.5 var(--font-num);color:var(--ink);text-align:center;}
.ov-cheat__label{flex:1 1 auto;font-size:11px;color:var(--ink-2);}

/* ---- glossary card ---------------------------------------------------------------------------- */
.ov-gloss__term{margin:0 0 3px;font:700 11px/1.3 var(--font-ui);color:var(--ink);}
.ov-gloss__lead{margin:0 0 5px;color:var(--ink);}
.ov-gloss__h{margin:5px 0 1px;font:700 9px/1.4 var(--font-ui);letter-spacing:.04em;
  text-transform:uppercase;color:var(--ink-2);}
.ov-gloss__p{margin:0;color:var(--ink-2);}
.ov-gloss__see{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;}
.ov-gloss__chip{padding:1px 5px;background:var(--face);border:0;box-shadow:${BEV_RAISED};
  font:700 9px/1.5 var(--font-num);color:var(--ink-2);cursor:pointer;}
.ov-gloss__chip:active{box-shadow:${BEV_SUNKEN};}

/* ---- FACEPLATE -------------------------------------------------------------------------------- */
.ov-fp{width:${FP_W}px;}
.ov-fp__desc{flex:0 0 auto;padding:2px 5px;background:var(--face-2);
  box-shadow:inset 0 -1px 0 var(--bev-sh);font:700 9px/1.5 var(--font-ui);letter-spacing:.04em;
  text-transform:uppercase;color:var(--ink-2);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;}
.ov-fp__main{flex:1 1 auto;display:flex;gap:8px;padding:6px;}
.ov-fp__scale{position:relative;flex:0 0 auto;width:64px;height:${FP_BAR_H}px;}
.ov-fp__bar{position:absolute;left:0;top:0;width:26px;height:100%;background:var(--fld-bg);
  box-shadow:${BEV_SUNKEN};overflow:hidden;}
.ov-fp__fill{position:absolute;left:${FP_BAR_PAD}px;right:${FP_BAR_PAD}px;bottom:${FP_BAR_PAD}px;
  height:0;background:var(--fld-pv);}
.ov-fp__fill--alarm{background:var(--fld-alarm);}
.ov-fp__fill--out{background:var(--fld-out);}
.ov-fp__fill--stale{background:var(--fld-stale);}
.ov-fp__mk{position:absolute;left:0;width:34px;height:${FP_MARK_H}px;background:var(--fld-alarm);}
.ov-fp__mk--sp{background:var(--fld-sp);}
.ov-fp__mk--warn{background:var(--lamp-warn);}
.ov-fp__tick{position:absolute;left:38px;font:400 9px/1 var(--font-num);color:var(--ink-2);
  font-variant-numeric:tabular-nums;white-space:nowrap;}
.ov-fp__side{flex:1 1 auto;display:flex;flex-direction:column;gap:5px;min-width:0;}
.ov-fp__row{display:flex;flex-direction:column;gap:1px;}
.ov-fp__modes{display:flex;align-items:center;gap:8px;padding:3px 5px;background:var(--face-3);
  box-shadow:${BEV_SUNKEN};}
.ov-fp__mode{display:flex;align-items:center;gap:4px;font:700 9px/1 var(--font-ui);
  letter-spacing:.04em;color:var(--ink-off);}
.ov-fp__mode--on{color:var(--ink);}
.ov-fp__acts{flex:0 0 auto;display:flex;align-items:center;gap:4px;min-height:28px;padding:3px 6px;
  background:var(--face-2);box-shadow:inset 0 1px 0 var(--bev-hi);}
.ov-fp__q{margin-left:auto;display:flex;align-items:center;gap:4px;font:700 9px/1 var(--font-ui);
  letter-spacing:.04em;color:var(--ink-2);}

@media (prefers-reduced-motion:reduce){
  .ov-lamp--blink{animation:none;}
}
}`;

let baseCssInjected = false;

/** Inject the base stylesheet once, as the first child of `<head>` so author rules win. */
function injectBaseCss() {
  if (baseCssInjected || typeof document === 'undefined') return;
  baseCssInjected = true;
  const head = document.head || document.documentElement;
  const style = document.createElement('style');
  style.setAttribute('data-owner', 'ui/overlay.js');
  style.textContent = BASE_CSS;
  head.insertBefore(style, head.firstChild);
}

/** `true` when the user asked for reduced motion. Re-evaluated on every open, not cached. */
function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/* =================================================================================================
 * 1. ICONS — inline SVG, authored here, zero dependencies
 * ===============================================================================================*/

/**
 * The icon vocabulary. Every entry is a list of shapes on a 16×16 grid: `{d}` is a stroked path,
 * `{d, fill:true}` a filled one, `{c:[cx,cy,r]}` a circle.
 * @type {{[name:string]: Array<{d?:string, c?:number[], fill?:boolean}>}}
 */
const ICONS = {
  close: [{ d: 'M4 4 L12 12' }, { d: 'M12 4 L4 12' }],
  autozero: [{ d: 'M2 13 H14' }, { d: 'M8 3 V10' }, { d: 'M5 7 L8 10 L11 7' }],
  refill: [{ d: 'M4 7 H12 V14 H4 Z' }, { d: 'M4 11 H12' }, { d: 'M8 1 V5' }, { d: 'M5.5 2.5 L8 5 L10.5 2.5' }],
  manual: [{ d: 'M3 13 H13' }, { d: 'M8 13 V7' }, { c: [8, 4.5, 2.4] }],
  auto: [{ d: 'M13 8 A5 5 0 1 1 8.5 3.05' }, { d: 'M6 1 L10 3.2 L6 5.4 Z', fill: true }],
  reset: [{ d: 'M3 8 A5 5 0 1 0 7.5 3.05' }, { d: 'M10 1 L6 3.2 L10 5.4 Z', fill: true }],
  ack: [{ d: 'M3 8 L7 12 L13 4' }],
  trend: [{ d: 'M2 13 L6 7 L9 10 L14 3' }],
  purge: [{ d: 'M8 2 C5 6.5 4 8.5 4 10 A4 4 0 0 0 12 10 C12 8.5 11 6.5 8 2 Z' }],
  info: [{ c: [8, 8, 6] }, { d: 'M8 7.5 V11.5' }, { d: 'M8 4.5 V5.6' }],
  warn: [{ d: 'M8 2 L15 14 H1 Z' }, { d: 'M8 6.5 V10' }, { d: 'M8 11.6 V12.4' }],
  move: [{ d: 'M8 2 V14' }, { d: 'M2 8 H14' }, { d: 'M8 2 L6 4.4 M8 2 L10 4.4' },
    { d: 'M8 14 L6 11.6 M8 14 L10 11.6' }, { d: 'M2 8 L4.4 6 M2 8 L4.4 10' },
    { d: 'M14 8 L11.6 6 M14 8 L11.6 10' }],
  next: [{ d: 'M5 2 L11 8 L5 14' }],
  back: [{ d: 'M11 2 L5 8 L11 14' }],
  skip: [{ d: 'M3 2 L10 8 L3 14' }, { d: 'M13 2 V14' }],
  play: [{ d: 'M4 2 L14 8 L4 14 Z', fill: true }],
  book: [{ d: 'M3 3 H7.5 A1.5 1.5 0 0 1 8 4.5 V13 A1.5 1.5 0 0 0 7.5 12 H3 Z' },
    { d: 'M13 3 H8.5 A1.5 1.5 0 0 0 8 4.5 V13 A1.5 1.5 0 0 1 8.5 12 H13 Z' }],
  keys: [{ d: 'M1.5 4.5 H14.5 V11.5 H1.5 Z' }, { d: 'M4.5 8.5 H11.5' }],
  blank: [{ d: 'M2 3 H14 V13 H2 Z' }],
};

/**
 * Build an inline SVG icon.
 *
 * Unknown names fall back to a 1–3 character glyph, which is exactly what a classic HMI does for a
 * function with no pictogram (`AZ`, `%B`, `CV`), so a caller can pass either.
 *
 * @param {string} name  An {@link ICONS} key, or a short glyph to render as text.
 * @param {number} [size=12]  Edge length in px.
 * @returns {SVGElement|HTMLElement} The icon node, always `aria-hidden`.
 */
export function overlayIcon(name, size) {
  const px = typeof size === 'number' && size > 0 ? Math.round(size) : 12;
  const shapes = ICONS[name];
  if (!shapes) {
    return h('span', { 'aria-hidden': 'true' }, String(name === undefined ? '?' : name).slice(0, 3));
  }
  const svg = hSvg('svg', {
    viewBox: '0 0 16 16', width: px, height: px, 'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6,
    'stroke-linecap': 'square', 'stroke-linejoin': 'miter',
  });
  for (let i = 0; i < shapes.length; i += 1) {
    const s = shapes[i];
    const paint = s.fill
      ? { fill: 'currentColor', stroke: 'none' }
      : {};
    if (s.c) {
      svg.appendChild(hSvg('circle', Object.assign({ cx: s.c[0], cy: s.c[1], r: s.c[2] }, paint)));
    } else {
      svg.appendChild(hSvg('path', Object.assign({ d: s.d }, paint)));
    }
  }
  return svg;
}

/**
 * Build a beveled icon-only button. Icon-only controls need both `title` and `aria-label`, so this
 * writes both from one string and there is no way to forget one.
 *
 * @param {object} opts
 * @param {string|Node} opts.icon  An {@link overlayIcon} name, or a ready-made node.
 * @param {string} opts.title  The tooltip and the accessible name. Required.
 * @param {() => void} opts.onClick
 * @param {boolean} [opts.large=false]  22×22 instead of 16×16.
 * @param {boolean} [opts.disabled=false]
 * @param {string} [opts.className]  Extra class.
 * @returns {HTMLButtonElement}
 */
export function iconButton(opts) {
  const o = opts || {};
  const node = typeof o.icon === 'object' && o.icon && typeof o.icon.nodeType === 'number'
    ? o.icon
    : overlayIcon(o.icon, o.large ? 14 : 11);
  const btn = h('button', {
    type: 'button',
    class: 'ov-ib' + (o.large ? ' ov-ib--lg' : '') + (o.className ? ' ' + o.className : ''),
    title: o.title || '',
    'aria-label': o.title || '',
    onClick: (e) => { if (typeof o.onClick === 'function') o.onClick(e); },
  }, node);
  if (o.disabled) setAttr(btn, 'disabled', '');
  return btn;
}

/**
 * Build a sunken label box: a tag label above (optional), the value right-aligned in tabular
 * numerals, and the engineering unit beside it at 80 % size.
 *
 * @param {object} opts
 * @param {string} [opts.label]  The ISA tag or short caption above the box, 9 px uppercase.
 * @param {'pv'|'sp'|'out'} [opts.tone='pv']  Which digit colour to use.
 * @param {string} [opts.eu]  Engineering unit suffix.
 * @param {string} [opts.value]  Initial text.
 * @param {boolean} [opts.big=false]  16 px digits instead of 13 px.
 * @returns {{el:HTMLElement, box:HTMLElement, valueEl:HTMLElement, euEl:HTMLElement}}
 *          `el` is the label+box group; write through `valueEl` / `euEl`.
 */
export function labelBox(opts) {
  const o = opts || {};
  const tone = o.tone === 'sp' || o.tone === 'out' ? o.tone : 'pv';
  const valueEl = h('span', { class: 'ov-fld__v' }, o.value === undefined ? NO_VALUE : o.value);
  const euEl = h('span', { class: 'ov-fld__eu' }, o.eu || '');
  const box = h('div', {
    class: 'ov-fld ov-fld--' + tone + (o.big ? ' ov-fld--pv' : ''),
  }, valueEl, euEl);
  const el = h('div', { class: 'ov-fp__row' });
  if (o.label) el.appendChild(h('span', { class: 'ov-lbl' }, o.label));
  el.appendChild(box);
  return { el, box, valueEl, euEl };
}

/**
 * Build a round glassy status lamp.
 *
 * @param {'off'|'run'|'warn'|'alarm'|'info'} [state='off']
 * @param {object} [opts]
 * @param {boolean} [opts.large=false]
 * @param {string} [opts.title]  Tooltip; also becomes the accessible name when present.
 * @returns {HTMLElement}
 */
export function statusLamp(state, opts) {
  const o = opts || {};
  const s = state === 'run' || state === 'warn' || state === 'alarm' || state === 'info'
    ? state : 'off';
  const el = h('span', {
    class: 'ov-lamp ov-lamp--' + s + (o.large ? ' ov-lamp--lg' : ''),
  });
  if (o.title) {
    setAttr(el, 'title', o.title);
    setAttr(el, 'role', 'img');
    setAttr(el, 'aria-label', o.title);
  } else {
    setAttr(el, 'aria-hidden', 'true');
  }
  return el;
}

/** Repaint a lamp built by {@link statusLamp} without rebuilding it. */
function setLamp(el, state, blink) {
  if (!el) return;
  const s = state === 'run' || state === 'warn' || state === 'alarm' || state === 'info'
    ? state : 'off';
  cls(el, 'ov-lamp--off', s === 'off');
  cls(el, 'ov-lamp--run', s === 'run');
  cls(el, 'ov-lamp--warn', s === 'warn');
  cls(el, 'ov-lamp--alarm', s === 'alarm');
  cls(el, 'ov-lamp--info', s === 'info');
  cls(el, 'ov-lamp--blink', !!blink && !reducedMotion());
}

/* =================================================================================================
 * 2. PLACEMENT
 * ===============================================================================================*/

/** Split `'bottom-start'` into `{ side:'bottom', align:'start' }`. */
function parsePlacement(placement) {
  const p = typeof placement === 'string' && placement ? placement : 'bottom';
  const dash = p.indexOf('-');
  const side = dash < 0 ? p : p.slice(0, dash);
  const align = dash < 0 ? 'center' : p.slice(dash + 1);
  const validSide = side === 'top' || side === 'bottom' || side === 'left' || side === 'right'
    ? side : 'bottom';
  const validAlign = align === 'start' || align === 'end' ? align : 'center';
  return { side: validSide, align: validAlign };
}

/** Does a card of `size` fit on `side` of `rect` inside the viewport? */
function fitsOn(side, rect, size, vw, vh) {
  const gap = ANCHOR_GAP_PX + VIEWPORT_MARGIN_PX;
  if (side === 'top') return rect.top - size.h - gap >= 0;
  if (side === 'bottom') return rect.bottom + size.h + gap <= vh;
  if (side === 'left') return rect.left - size.w - gap >= 0;
  return rect.right + size.w + gap <= vw;
}

/**
 * Position a floating card against an anchor rect, flipping to the opposite side when it does not
 * fit and clamping into the viewport, then place the arrow on the anchor's centre line.
 *
 * @param {HTMLElement} card  Already in the DOM (measurable) and `position:fixed`.
 * @param {HTMLElement|null} arrow  Optional arrow element inside `card`.
 * @param {DOMRect|{top:number,bottom:number,left:number,right:number,width:number,height:number}} rect
 * @param {string} placement  `'top'|'bottom'|'left'|'right'` with an optional `'-start'|'-end'`.
 * @returns {string} The side actually used.
 */
function placeCard(card, arrow, rect, placement) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { side: wanted, align } = parsePlacement(placement);

  // Measure with the card laid out but not yet positioned.
  const box = card.getBoundingClientRect();
  const size = { w: box.width, h: box.height };

  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  let side = wanted;
  if (!fitsOn(side, rect, size, vw, vh)) {
    if (fitsOn(opposite[side], rect, size, vw, vh)) {
      side = opposite[side];
    } else {
      const perpendicular = side === 'top' || side === 'bottom' ? ['right', 'left'] : ['bottom', 'top'];
      for (let i = 0; i < perpendicular.length; i += 1) {
        if (fitsOn(perpendicular[i], rect, size, vw, vh)) { side = perpendicular[i]; break; }
      }
    }
  }

  let x;
  let y;
  if (side === 'top' || side === 'bottom') {
    y = side === 'top' ? rect.top - size.h - ANCHOR_GAP_PX : rect.bottom + ANCHOR_GAP_PX;
    if (align === 'start') x = rect.left;
    else if (align === 'end') x = rect.right - size.w;
    else x = rect.left + rect.width / 2 - size.w / 2;
  } else {
    x = side === 'left' ? rect.left - size.w - ANCHOR_GAP_PX : rect.right + ANCHOR_GAP_PX;
    if (align === 'start') y = rect.top;
    else if (align === 'end') y = rect.bottom - size.h;
    else y = rect.top + rect.height / 2 - size.h / 2;
  }

  const maxX = Math.max(VIEWPORT_MARGIN_PX, vw - size.w - VIEWPORT_MARGIN_PX);
  const maxY = Math.max(VIEWPORT_MARGIN_PX, vh - size.h - VIEWPORT_MARGIN_PX);
  x = Math.min(Math.max(x, VIEWPORT_MARGIN_PX), maxX);
  y = Math.min(Math.max(y, VIEWPORT_MARGIN_PX), maxY);

  card.style.left = Math.round(x) + 'px';
  card.style.top = Math.round(y) + 'px';

  if (arrow) {
    arrow.className = 'ov-arrow ov-arrow--' + side;
    if (side === 'top' || side === 'bottom') {
      const cx = Math.min(
        Math.max(rect.left + rect.width / 2 - x, ARROW_PX + 4),
        Math.max(ARROW_PX + 4, size.w - ARROW_PX - 4),
      );
      arrow.style.left = Math.round(cx - ARROW_PX) + 'px';
      arrow.style.top = side === 'top' ? size.h - 1 + 'px' : -ARROW_PX * 2 + 1 + 'px';
    } else {
      const cy = Math.min(
        Math.max(rect.top + rect.height / 2 - y, ARROW_PX + 4),
        Math.max(ARROW_PX + 4, size.h - ARROW_PX - 4),
      );
      arrow.style.top = Math.round(cy - ARROW_PX) + 'px';
      arrow.style.left = side === 'left' ? size.w - 1 + 'px' : -ARROW_PX * 2 + 1 + 'px';
    }
  }
  return side;
}

/* =================================================================================================
 * 3. FOCUS
 * ===============================================================================================*/

/** Visible focusable descendants of `el`, in DOM order. */
function focusableWithin(el) {
  const all = el.querySelectorAll(FOCUSABLE_SELECTOR);
  const out = [];
  for (let i = 0; i < all.length; i += 1) {
    const n = all[i];
    if (n.offsetParent !== null || n === document.activeElement) out.push(n);
  }
  return out;
}

/**
 * Trap keyboard focus inside an element and remember where focus came from.
 *
 * `Tab` and `Shift+Tab` cycle within `el`; focus that escapes by any other route is pulled back on
 * the next `Tab`. The element itself is given `tabindex="-1"` so it can hold focus when it contains
 * nothing focusable — a text-only dialog still receives `Esc`.
 *
 * @param {HTMLElement} el  The container to trap inside. Must already be in the document.
 * @param {{restoreTo?:Element|null}} [opts]  `restoreTo` overrides the element focus returns to.
 *        **Required whenever the caller made the background `inert` first**: applying `inert` to an
 *        ancestor blurs the focused element synchronously, so by the time this function runs
 *        `document.activeElement` is already `<body>` and the operator's focus would be lost.
 * @returns {() => void} The restore function: removes the trap and returns focus to whatever had it
 *          when the trap was installed. Idempotent — calling it twice is harmless.
 */
export function trapFocus(el, opts) {
  const previous = opts && 'restoreTo' in opts
    ? opts.restoreTo
    : (typeof document !== 'undefined' ? document.activeElement : null);
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');

  function onKeyDown(e) {
    if (e.key !== 'Tab') return;
    const list = focusableWithin(el);
    if (list.length === 0) {
      e.preventDefault();
      el.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = el.contains(active);
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  const initial = focusableWithin(el);
  (initial.length ? initial[0] : el).focus();

  let released = false;
  return function restore() {
    if (released) return;
    released = true;
    document.removeEventListener('keydown', onKeyDown, true);
    if (previous && typeof previous.focus === 'function' && previous.isConnected) previous.focus();
  };
}

/* =================================================================================================
 * 4. THE HOST
 * ===============================================================================================*/

let handleSeq = 0;

/**
 * @typedef {Object} OverlayHandle
 * @property {number} id            Monotonic id, unique per session.
 * @property {'popover'|'modal'|'toast'|'coach'|'cheatsheet'|'faceplate'} kind
 * @property {HTMLElement} el       The floating element (the card, the modal, the toast).
 * @property {HTMLElement} contentEl  Where the caller's content was mounted.
 * @property {OverlayHost} host
 * @property {boolean} dismissed
 * @property {() => void} reposition  Recompute placement. No-op for modals and toasts.
 */

/**
 * @typedef {Object} OverlayHost
 * @property {HTMLElement} rootEl   The application content root, marked inert while a modal is up.
 * @property {HTMLElement} el       The fixed-position overlay root appended to `document.body`.
 * @property {OverlayHandle[]} stack  Open surfaces, oldest first.
 */

/**
 * Create the single overlay host. `ui/app.js` calls this once at boot and passes the host to every
 * view; nothing else may create one, because `Esc` handling and the focus trap assume one stack.
 *
 * The overlay root is appended to `document.body`, not to `rootEl`, so that a floating surface can
 * never be clipped by a panel's `overflow` or trapped by an ancestor's `transform`. `rootEl` is
 * remembered so the application content can be made inert while a modal dialog is open.
 *
 * @param {Element} rootEl  The application content root (the element `boot` mounted the shell into).
 * @returns {OverlayHost} The host. Pass it to every `show*` function.
 */
export function createOverlayHost(rootEl) {
  injectBaseCss();

  const el = h('div', { class: 'ov-root', 'data-overlay-root': '' });
  const toastLayer = h('div', {
    class: 'ov-toasts',
    role: 'status',
    'aria-live': 'polite',
    'aria-relevant': 'additions',
    style: { zIndex: String(Z.toast) },
  });
  el.appendChild(toastLayer);
  (document.body || document.documentElement).appendChild(el);

  /** @type {OverlayHost} */
  const host = {
    rootEl,
    el,
    toastLayer,
    stack: [],
    inertDepth: 0,
    faceplateSeq: 0,
    _onKeyDown: null,
    _onPointerDown: null,
    _onViewportChange: null,
  };

  host._onKeyDown = function onKeyDown(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    for (let i = host.stack.length - 1; i >= 0; i -= 1) {
      const handle = host.stack[i];
      if (handle.kind === 'toast') continue;
      if (handle.dismissible === false) return;
      e.preventDefault();
      e.stopPropagation();
      dismiss(handle);
      return;
    }
  };

  host._onPointerDown = function onPointerDown(e) {
    if (host.stack.length === 0) return;
    // Copy: dismissing mutates the stack.
    const open = host.stack.slice();
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const handle = open[i];
      if (handle.kind === 'faceplate' && handle.el.contains(e.target)) raiseFaceplate(handle);
      if (handle.kind !== 'popover' || handle.closeOnOutside === false) continue;
      if (handle.el.contains(e.target)) continue;
      if (handle.anchorEl && handle.anchorEl.contains(e.target)) continue;
      dismiss(handle);
    }
  };

  host._onViewportChange = function onViewportChange() {
    for (let i = 0; i < host.stack.length; i += 1) host.stack[i].reposition();
  };

  document.addEventListener('keydown', host._onKeyDown, true);
  document.addEventListener('pointerdown', host._onPointerDown, true);
  window.addEventListener('resize', host._onViewportChange, { passive: true });
  window.addEventListener('scroll', host._onViewportChange, { passive: true, capture: true });

  return host;
}

/**
 * Tear down a host: dismiss everything, remove the listeners and the overlay root. Only needed by
 * tests and by a full application teardown; the shipped app creates one host and keeps it.
 *
 * @param {OverlayHost} host
 * @returns {void}
 */
export function destroyOverlayHost(host) {
  if (!host) return;
  dismissAll(host);
  document.removeEventListener('keydown', host._onKeyDown, true);
  document.removeEventListener('pointerdown', host._onPointerDown, true);
  window.removeEventListener('resize', host._onViewportChange);
  window.removeEventListener('scroll', host._onViewportChange, true);
  if (host.el.parentNode) host.el.parentNode.removeChild(host.el);
  host.stack.length = 0;
}

/** Mark the application content inert (or not) while a modal-class surface is open. */
function setBackgroundInert(host, on) {
  const content = host.rootEl;
  if (!content || content === document.body || content.contains(host.el)) return;
  host.inertDepth += on ? 1 : -1;
  if (host.inertDepth < 0) host.inertDepth = 0;
  const inert = host.inertDepth > 0;
  setAttr(content, 'aria-hidden', inert ? 'true' : null);
  if ('inert' in content) content.inert = inert;
}

/** Register a handle, wire its shared behaviour and return it. */
function register(host, handle) {
  host.stack.push(handle);
  return handle;
}

/**
 * Close a floating surface and restore focus. Safe to call twice, and safe to call on a handle whose
 * element has already been removed from the document.
 *
 * @param {OverlayHandle|null|undefined} handle  A handle from any `show*` function.
 * @returns {void}
 */
export function dismiss(handle) {
  if (!handle || handle.dismissed) return;
  handle.dismissed = true;

  const host = handle.host;
  const i = host.stack.indexOf(handle);
  if (i >= 0) host.stack.splice(i, 1);

  if (handle.timer) { clearTimeout(handle.timer); handle.timer = 0; }
  for (let k = 0; k < handle.cleanup.length; k += 1) handle.cleanup[k]();
  handle.cleanup.length = 0;

  // ORDER MATTERS. Un-inert the background and detach the surface BEFORE restoring focus:
  // `element.focus()` is a no-op on an inert subtree, so restoring first would silently drop focus
  // to <body>, and focusing a node that is still inside the surface being removed would drop it too.
  if (handle.inert) setBackgroundInert(host, false);
  if (handle.dimEl && handle.dimEl.parentNode) handle.dimEl.parentNode.removeChild(handle.dimEl);
  if (handle.el.parentNode) handle.el.parentNode.removeChild(handle.el);
  if (handle.releaseFocus) handle.releaseFocus();
  if (typeof handle.onDismiss === 'function') handle.onDismiss(handle);
}

/**
 * Dismiss every open surface, optionally restricted to one kind.
 *
 * @param {OverlayHost} host
 * @param {'popover'|'modal'|'toast'|'coach'|'cheatsheet'|'faceplate'} [kind]  Omit to dismiss all.
 * @returns {void}
 */
export function dismissAll(host, kind) {
  if (!host) return;
  const open = host.stack.slice();
  for (let i = open.length - 1; i >= 0; i -= 1) {
    if (!kind || open[i].kind === kind) dismiss(open[i]);
  }
}

/** Build the shared handle skeleton. */
function makeHandle(host, kind, el, contentEl, opts) {
  handleSeq += 1;
  /** @type {OverlayHandle} */
  const handle = {
    id: handleSeq,
    kind,
    el,
    contentEl,
    host,
    dismissed: false,
    dismissible: opts && opts.dismissible !== undefined ? !!opts.dismissible : true,
    onDismiss: opts ? opts.onDismiss : undefined,
    cleanup: [],
    releaseFocus: null,
    dimEl: null,
    inert: false,
    timer: 0,
    anchorEl: null,
    closeOnOutside: true,
    reposition: function reposition() {},
  };
  return handle;
}

/** Mount `content` (a Node or a string) into `target`. */
function mountContent(target, content) {
  if (content === null || content === undefined) return;
  if (typeof content === 'object' && typeof content.nodeType === 'number') target.appendChild(content);
  else target.appendChild(document.createTextNode(String(content)));
}

/** Build the beveled title strip shared by every window-class surface. */
function titleStrip(titleText, opts) {
  const o = opts || {};
  const strip = h('div', {
    class: 'ov-win__tt' + (o.draggable ? ' ov-win__tt--drag' : '') + (o.className ? ' ' + o.className : ''),
  });
  strip.appendChild(h('span', { class: 'ov-win__tag', id: o.titleId }, titleText || ''));
  strip.appendChild(h('span', { class: 'ov-win__sp' }));
  return strip;
}

/* =================================================================================================
 * 5. POPOVERS AND TOOLTIPS
 * ===============================================================================================*/

/**
 * Show a popover anchored to an element, flipping away from the viewport edges.
 *
 * The popover closes on `Esc`, on a pointer press outside it, and when {@link dismiss} is called.
 * Focus is trapped **only if the content is interactive** — a read-only glossary card must not steal
 * the keyboard from the control the operator was using, while a popover containing buttons must.
 * Focus is always restored to whatever had it before.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {Element} opts.anchorEl  The element to point at. Its bounding rect is re-read on every
 *        scroll and resize, so the popover tracks a scrolling panel.
 * @param {Node|string} opts.content  The body. A string becomes a text node.
 * @param {string} [opts.placement='bottom']  `'top'|'bottom'|'left'|'right'`, optionally suffixed
 *        `'-start'`/`'-end'` to align with the anchor's leading/trailing edge.
 * @param {number} [opts.maxWidth=280]  Max width in px.
 * @param {string} [opts.role='dialog']  Use `'tooltip'` for a purely descriptive popover.
 * @param {string} [opts.className]  Extra class on the card, for view-specific styling.
 * @param {boolean} [opts.arrow=false]  Draw the 6 px arrow. Off by default: a classic HMI popover is
 *        a plain beveled box.
 * @param {boolean} [opts.closeOnOutside=true]
 * @param {boolean} [opts.dismissible=true]  `false` means `Esc` will not close it.
 * @param {(handle:OverlayHandle) => void} [opts.onDismiss]
 * @returns {OverlayHandle} The handle; pass it to {@link dismiss}.
 */
export function showPopover(host, opts) {
  const o = opts || {};
  const maxWidth = typeof o.maxWidth === 'number' ? o.maxWidth : 280;
  const body = h('div', { class: 'ov-popover__body' });
  mountContent(body, o.content);

  const arrow = o.arrow === true ? h('div', { class: 'ov-arrow ov-arrow--bottom' }) : null;
  const card = h('div', {
    class: 'ov-card ov-popover' + (o.className ? ' ' + o.className : ''),
    role: o.role || 'dialog',
    style: { zIndex: String(Z.popover), maxWidth: maxWidth + 'px', left: '0px', top: '0px' },
  }, arrow, body);

  host.el.appendChild(card);

  const handle = makeHandle(host, 'popover', card, body, o);
  handle.anchorEl = o.anchorEl || null;
  handle.closeOnOutside = o.closeOnOutside !== false;
  handle.reposition = function reposition() {
    if (handle.dismissed || !handle.anchorEl || !handle.anchorEl.isConnected) return;
    placeCard(card, arrow, handle.anchorEl.getBoundingClientRect(), o.placement);
  };
  handle.reposition();

  if (focusableWithin(card).length > 0) handle.releaseFocus = trapFocus(card);

  return register(host, handle);
}

/**
 * Bind a hover/focus tooltip to an element, with the house timing: 250 ms before it shows, 60 ms
 * before it hides, so a pointer crossing a dense tag strip does not flash a dozen cards.
 *
 * The tooltip also opens on keyboard focus and closes on blur, which is what makes tag help
 * reachable without a pointer. Because every control on this screen is icon-only, this is the main
 * explanation channel: it carries the sentences the screen itself does not.
 *
 * @param {OverlayHost} host
 * @param {Element} el  The element to bind to.
 * @param {string|(() => (string|Node|null))} text  Static text, or a function evaluated at show
 *        time — return `null` to suppress the tooltip for that hover.
 * @param {object} [opts]
 * @param {string} [opts.placement='top']
 * @param {number} [opts.maxWidth=280]
 * @returns {() => void} A detach function that removes the listeners and closes any open tooltip.
 */
export function attachTooltip(host, el, text, opts) {
  const o = opts || {};
  let showTimer = 0;
  let hideTimer = 0;
  let handle = null;

  function resolve() {
    const v = typeof text === 'function' ? text() : text;
    return v === null || v === undefined || v === '' ? null : v;
  }
  function close() {
    if (handle) { dismiss(handle); handle = null; }
  }
  function open() {
    // The 250 ms delay means the target can be unmounted (a tab switch, a list reconcile) between
    // the pointer entering and the tooltip opening. Anchoring to a detached node would strand the
    // card at the viewport origin.
    if (handle || !el.isConnected) return;
    const content = resolve();
    if (content === null) return;
    handle = showPopover(host, {
      anchorEl: el,
      content,
      placement: o.placement || 'top',
      maxWidth: o.maxWidth,
      role: 'tooltip',
      className: 'ov-popover--tip',
      closeOnOutside: true,
      onDismiss: () => { handle = null; },
    });
  }
  function scheduleShow(immediate) {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(open, immediate ? 0 : TOOLTIP_SHOW_MS);
  }
  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(close, TOOLTIP_HIDE_MS);
  }

  const onEnter = () => scheduleShow(false);
  const onLeave = () => scheduleHide();
  const onFocus = () => scheduleShow(true);
  const onBlur = () => { clearTimeout(showTimer); close(); };

  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('focus', onFocus, true);
  el.addEventListener('blur', onBlur, true);

  return function detach() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    close();
    el.removeEventListener('pointerenter', onEnter);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('focus', onFocus, true);
    el.removeEventListener('blur', onBlur, true);
  };
}

/**
 * Render a glossary entry as the four-section popover: *what it is*, *units and typical range*,
 * *why it matters and what abnormal looks like*, then the see-also chips.
 *
 * The **content** comes from `src/data/glossary.js` — the caller resolves it with `glossaryFor(id)`
 * and passes the entry in. This module deliberately does not import the glossary, so the layout
 * lives here and not one word of the text does. A `null` entry returns `null` and renders nothing:
 * a label may not carry an `ⓘ` without an entry.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {Element} opts.anchorEl  The `ⓘ` affordance.
 * @param {{term:string, short:string, why:string, typical:string, seeAlso:string[]}|null} opts.entry
 *        The resolved glossary entry.
 * @param {string} [opts.placement='right']
 * @param {(seeAlsoId:string) => void} [opts.onSeeAlso]  Called with the id of a clicked see-also
 *        chip. Omit it and the chips render as plain non-interactive text.
 * @returns {OverlayHandle|null} `null` when `entry` is null.
 */
export function showGlossaryPopover(host, opts) {
  const o = opts || {};
  const entry = o.entry;
  if (!entry) return null;

  const seeAlso = Array.isArray(entry.seeAlso) ? entry.seeAlso : [];
  const chips = seeAlso.length === 0 ? null : h(
    'div',
    { class: 'ov-gloss__see' },
    seeAlso.map((id) => (typeof o.onSeeAlso === 'function'
      ? h('button', { type: 'button', class: 'ov-gloss__chip', onClick: () => o.onSeeAlso(id) }, id)
      : h('span', { class: 'ov-gloss__chip' }, id))),
  );

  const content = h(
    'div',
    { class: 'ov-gloss' },
    h('h3', { class: 'ov-gloss__term' }, entry.term),
    h('p', { class: 'ov-gloss__lead' }, entry.short),
    h('div', { class: 'ov-gloss__h' }, 'Units and typical range'),
    h('p', { class: 'ov-gloss__p' }, entry.typical),
    h('div', { class: 'ov-gloss__h' }, 'Why it matters'),
    h('p', { class: 'ov-gloss__p' }, entry.why),
    chips,
  );

  return showPopover(host, {
    anchorEl: o.anchorEl,
    content,
    placement: o.placement || 'right',
    maxWidth: 320,
    className: 'ov-popover--gloss',
    role: 'dialog',
    onDismiss: o.onDismiss,
  });
}

/* =================================================================================================
 * 6. MODALS AND CONFIRMS
 * ===============================================================================================*/

/**
 * Build one dialog action button.
 *
 * A dialog action may be icon-only (`icon`, no `label`), icon + label, or label-only. The label is
 * rendered in 10 px uppercase, which is what a classic HMI dialog button carries; the icon-only
 * variant is the one the process screens themselves use.
 */
function actionButton(spec, handle) {
  const variant = spec.variant === 'primary' || spec.variant === 'danger' ? spec.variant : 'ghost';
  const label = spec.label === undefined || spec.label === null ? '' : String(spec.label);
  const title = spec.title || label;

  if (!label && spec.icon) {
    return iconButton({
      icon: spec.icon,
      title,
      large: true,
      disabled: !!spec.disabled,
      onClick: () => { if (typeof spec.onClick === 'function') spec.onClick(handle); },
    });
  }

  const kids = [];
  if (variant === 'danger') kids.push(statusLamp('alarm'));
  else if (spec.icon) kids.push(h('span', { class: 'ov-btn__i' }, overlayIcon(spec.icon, 11)));
  kids.push(h('span', { class: 'ov-btn__t' }, label));

  const btn = h('button', {
    type: 'button',
    class: 'ov-btn' + (variant === 'ghost' ? '' : ' ov-btn--' + variant) + ' btn btn--' + variant,
    title,
    onClick: () => { if (typeof spec.onClick === 'function') spec.onClick(handle); },
  }, kids);
  if (spec.disabled) setAttr(btn, 'disabled', '');
  return btn;
}

/**
 * Show a modal dialog: dimmed background, trapped focus, `Esc` to close when dismissible.
 *
 * The app never blocks on a dialog while a run is live except for E-stop confirmation — that policy
 * belongs to the caller; this function only guarantees that when a modal is up, the application
 * content behind it is `inert` and `aria-hidden`, so a screen reader never reads through the dim.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {string} opts.title  Dialog heading; also the accessible name.
 * @param {Node|string} opts.content  The body.
 * @param {Array<{label?:string, icon?:string|Node, title?:string,
 *                onClick?:(handle:OverlayHandle)=>void,
 *                variant?:'primary'|'ghost'|'danger', disabled?:boolean}>} [opts.actions]
 *        Rendered right-aligned in source order. Handlers receive the handle so they can
 *        `dismiss(handle)` themselves; nothing closes automatically. An action with an `icon` and no
 *        `label` renders as a square icon button carrying `title` and `aria-label`.
 * @param {boolean} [opts.dismissible=true]  When false there is no close button, `Esc` does nothing
 *        and clicking the dim does nothing — the operator must choose an action.
 * @param {string} [opts.className]
 * @param {(handle:OverlayHandle) => void} [opts.onDismiss]
 * @returns {OverlayHandle}
 */
export function showModal(host, opts) {
  const o = opts || {};
  const dismissible = o.dismissible !== false;
  // Captured before anything is mounted: `setBackgroundInert` blurs whatever had focus.
  const previouslyFocused = document.activeElement;
  handleSeq += 1;
  const titleId = 'ov-title-' + handleSeq;

  const dim = h('div', { class: 'ov-dim', style: { zIndex: String(Z.modal - 1) } });
  const body = h('div', { class: 'ov-modal__body' });
  mountContent(body, o.content);

  const head = h(
    'div',
    { class: 'ov-modal__head' },
    h('h2', { class: 'ov-modal__title', id: titleId }, o.title || ''),
  );
  const actionsRow = h('div', { class: 'ov-modal__actions' });

  const modal = h('div', {
    class: 'ov-modal' + (o.className ? ' ' + o.className : ''),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    style: { zIndex: String(Z.modal) },
  }, head, body, actionsRow);

  host.el.appendChild(dim);
  host.el.appendChild(modal);

  const handle = makeHandle(host, 'modal', modal, body, o);
  handle.dimEl = dim;
  handle.dismissible = dismissible;

  if (dismissible) {
    head.appendChild(iconButton({
      icon: 'close',
      title: 'Close dialog',
      className: 'ov-modal__close',
      onClick: () => dismiss(handle),
    }));
    dim.addEventListener('pointerdown', (e) => { if (e.target === dim) dismiss(handle); });
  }

  const actions = Array.isArray(o.actions) ? o.actions : [];
  for (let i = 0; i < actions.length; i += 1) actionsRow.appendChild(actionButton(actions[i], handle));
  if (actions.length === 0) actionsRow.style.display = 'none';

  handle.inert = true;
  setBackgroundInert(host, true);
  handle.releaseFocus = trapFocus(modal, { restoreTo: previouslyFocused });

  return register(host, handle);
}

/**
 * A two-button confirm dialog. Used for "End run", for destructive method edits, and for anything
 * that must be undoable or gated by a held/typed confirm.
 *
 * Both handlers fire **after** the dialog closes, so a handler may open another surface.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node|string} opts.message  The question, in the operator's language.
 * @param {string} [opts.confirmLabel='Confirm']
 * @param {string} [opts.cancelLabel='Cancel']
 * @param {'primary'|'danger'} [opts.variant='primary']  `'danger'` for irreversible actions.
 * @param {() => void} [opts.onConfirm]
 * @param {() => void} [opts.onCancel]  Also called when the dialog is dismissed with `Esc`.
 * @returns {OverlayHandle}
 */
export function showConfirm(host, opts) {
  const o = opts || {};
  let decided = false;

  const handle = showModal(host, {
    title: o.title || 'Confirm',
    content: typeof o.message === 'string'
      ? h('p', { style: { margin: '0' } }, o.message)
      : o.message,
    className: 'ov-modal--confirm',
    dismissible: o.dismissible !== false,
    actions: [
      {
        label: o.cancelLabel || 'Cancel',
        variant: 'ghost',
        onClick: (hd) => { decided = true; dismiss(hd); if (o.onCancel) o.onCancel(); },
      },
      {
        label: o.confirmLabel || 'Confirm',
        variant: o.variant === 'danger' ? 'danger' : 'primary',
        onClick: (hd) => { decided = true; dismiss(hd); if (o.onConfirm) o.onConfirm(); },
      },
    ],
    onDismiss: () => { if (!decided && o.onCancel) o.onCancel(); },
  });
  return handle;
}

/* =================================================================================================
 * 7. TOASTS
 * ===============================================================================================*/

/** Severity lamp colour per toast kind. */
const TOAST_LAMP = { info: 'info', warn: 'warn', blocked: 'alarm' };

/**
 * Show a transient message in the bottom-right stack, as a small sunken strip with a severity lamp.
 *
 * This is the surface every `{ok:false, reason}` from `core/sim.js` goes through: a blocked interlock
 * is **explained**, never silently refused. Repeating the same message re-arms the timer and adds a
 * `×N` counter instead of stacking duplicates, because a held key can produce a refusal per frame.
 *
 * The stack is `aria-live="polite"`, and a `blocked` toast is additionally `role="alert"` so it is
 * announced immediately.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {string} opts.message  One sentence, in operator language. Say what was blocked and why.
 * @param {'info'|'warn'|'blocked'} [opts.kind='info']
 * @param {number} [opts.ms]  Lifetime; defaults to 3500 / 5000 / 6000 by kind. `0` means it stays
 *        until dismissed.
 * @returns {OverlayHandle}
 */
export function showToast(host, opts) {
  const o = opts || {};
  const kind = o.kind === 'warn' || o.kind === 'blocked' ? o.kind : 'info';
  const message = String(o.message === undefined ? '' : o.message);
  const ms = typeof o.ms === 'number' ? o.ms : TOAST_MS[kind];

  // Coalesce a repeat of the newest toast.
  for (let i = host.stack.length - 1; i >= 0; i -= 1) {
    const prev = host.stack[i];
    if (prev.kind !== 'toast') continue;
    if (prev.toastKind === kind && prev.toastMessage === message) {
      prev.repeatCount += 1;
      setText(prev.countEl, '×' + prev.repeatCount);
      prev.countEl.style.display = '';
      if (prev.timer) clearTimeout(prev.timer);
      if (ms > 0) prev.timer = setTimeout(() => dismiss(prev), ms);
      return prev;
    }
    break;
  }

  const countEl = h('span', { class: 'ov-toast__count', style: { display: 'none' } });
  const el = h('div', {
    class: 'ov-toast ov-toast--' + kind,
    role: kind === 'blocked' ? 'alert' : undefined,
  },
  statusLamp(TOAST_LAMP[kind], { title: kind === 'blocked' ? 'Blocked' : kind }),
  h('span', { class: 'ov-toast__msg' }, message),
  countEl);

  host.toastLayer.appendChild(el);

  const handle = makeHandle(host, 'toast', el, el, o);
  el.appendChild(iconButton({
    icon: 'close',
    title: 'Dismiss message',
    className: 'ov-toast__close',
    onClick: () => dismiss(handle),
  }));
  handle.toastKind = kind;
  handle.toastMessage = message;
  handle.repeatCount = 1;
  handle.countEl = countEl;
  if (ms > 0) handle.timer = setTimeout(() => dismiss(handle), ms);

  return register(host, handle);
}

/* =================================================================================================
 * 8. COACH MARKS (the guided tour)
 * ===============================================================================================*/

/**
 * Build the `clip-path` polygon that dims everything except `rect`. The outer ring is traced in
 * percentages and the hole in pixels; the repeated `0 0` is the seam that joins them, which is what
 * makes a single polygon behave as a cut-out.
 */
function spotlightClip(rect, pad) {
  if (!rect) return '';
  const x0 = Math.max(0, rect.left - pad);
  const y0 = Math.max(0, rect.top - pad);
  const x1 = Math.min(window.innerWidth, rect.right + pad);
  const y1 = Math.min(window.innerHeight, rect.bottom + pad);
  return 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ' +
    x0 + 'px ' + y0 + 'px, ' + x0 + 'px ' + y1 + 'px, ' +
    x1 + 'px ' + y1 + 'px, ' + x1 + 'px ' + y0 + 'px, ' + x0 + 'px ' + y0 + 'px)';
}

/**
 * Show one step of the guided tour: a full-screen dim with a cut-out around the target, plus a
 * positioned beveled card with Back / Next / Skip icon buttons and progress squares.
 *
 * A `null` `targetEl` dims the whole viewport and centres the card, which is what the opening and
 * closing steps of a tour want. `Esc` skips the tour.
 *
 * Under `prefers-reduced-motion` the spotlight has no transition.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {Element|null} opts.targetEl  The element to spotlight.
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {number} opts.step  1-based step number.
 * @param {number} opts.total  Total steps.
 * @param {() => void} [opts.onNext]  Omitted on the last step, where the button reads "Done".
 * @param {() => void} [opts.onBack]  Omitted on the first step, where the button is not rendered.
 * @param {() => void} [opts.onSkip]  Also called when the mark is dismissed with `Esc`.
 * @param {string} [opts.placement='bottom']
 * @returns {OverlayHandle}
 */
export function showCoachMark(host, opts) {
  const o = opts || {};
  const step = Math.max(1, Math.round(o.step || 1));
  const total = Math.max(step, Math.round(o.total || step));
  const target = o.targetEl || null;
  const previouslyFocused = document.activeElement;
  let skipped = false;

  const dim = h('div', {
    class: 'ov-dim ov-dim--spotlight',
    style: {
      zIndex: String(Z.coach - 1),
      transition: reducedMotion() ? 'none' : 'clip-path var(--dur-3, 250ms) var(--ease-out, ease)',
    },
  });

  const dots = h('div', { class: 'ov-coach__dots' });
  for (let i = 1; i <= total; i += 1) {
    dots.appendChild(h('span', { class: 'ov-coach__dot' + (i === step ? ' ov-coach__dot--on' : '') }));
  }

  const actions = h('div', { class: 'ov-coach__actions' }, dots);
  const card = h('div', {
    class: 'ov-card ov-coach',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': (o.title || 'Tour') + ' — step ' + step + ' of ' + total,
    style: { zIndex: String(Z.coach), left: '0px', top: '0px' },
  },
  h('div', { class: 'ov-coach__body-wrap' },
    h('div', { class: 'ov-coach__step' }, step + '/' + total),
    h('h3', { class: 'ov-coach__title' }, o.title || ''),
    h('p', { class: 'ov-coach__body' }, o.body || '')),
  actions);

  host.el.appendChild(dim);
  host.el.appendChild(card);

  const handle = makeHandle(host, 'coach', card, card, o);
  handle.dimEl = dim;

  actions.appendChild(iconButton({
    icon: 'close',
    title: 'Skip the tour',
    large: true,
    onClick: () => { skipped = true; dismiss(handle); if (o.onSkip) o.onSkip(); },
  }));
  if (step > 1 && typeof o.onBack === 'function') {
    actions.appendChild(iconButton({
      icon: 'back',
      title: 'Previous step',
      large: true,
      onClick: () => { skipped = true; dismiss(handle); o.onBack(); },
    }));
  }
  actions.appendChild(iconButton({
    icon: step >= total ? 'ack' : 'next',
    title: step >= total ? 'Finish the tour' : 'Next step',
    large: true,
    onClick: () => {
      skipped = true;
      dismiss(handle);
      if (typeof o.onNext === 'function') o.onNext();
      else if (typeof o.onSkip === 'function') o.onSkip();
    },
  }));

  handle.onDismiss = () => {
    if (!skipped && typeof o.onSkip === 'function') o.onSkip();
    if (typeof o.onDismiss === 'function') o.onDismiss(handle);
  };

  handle.reposition = function reposition() {
    if (handle.dismissed) return;
    if (target && target.isConnected) {
      const rect = target.getBoundingClientRect();
      dim.style.clipPath = spotlightClip(rect, 6);
      placeCard(card, null, rect, o.placement || 'bottom');
    } else {
      dim.style.clipPath = '';
      card.style.left = Math.round((window.innerWidth - card.getBoundingClientRect().width) / 2) + 'px';
      card.style.top = Math.round(window.innerHeight * 0.32) + 'px';
    }
  };
  handle.reposition();

  handle.inert = true;
  setBackgroundInert(host, true);
  handle.releaseFocus = trapFocus(card, { restoreTo: previouslyFocused });

  return register(host, handle);
}

/* =================================================================================================
 * 9. THE `?` CHEAT SHEET
 * ===============================================================================================*/

/** Human-readable rendering of a key combo, e.g. `'ctrl+alt+p'` -> `'Ctrl + Alt + P'`. */
function prettyCombo(combo) {
  return String(combo)
    .split('+')
    .map((part) => {
      const p = part.trim();
      if (p.length === 0) return p;
      const known = {
        ctrl: 'Ctrl', control: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta',
        esc: 'Esc', escape: 'Esc', enter: 'Enter', space: 'Space', tab: 'Tab',
        left: '←', right: '→', up: '↑', down: '↓',
      };
      const lower = p.toLowerCase();
      if (known[lower]) return known[lower];
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(' + ');
}

/**
 * Show the keyboard cheat sheet — the discoverability path behind the `?` key.
 *
 * The keymap is `ui/app.js`'s `KEYMAP`: `{ [combo]: { action, label, group? } }`. Entries are grouped
 * by their `group` field, falling back to `'General'`, and rendered in insertion order within each
 * group so the app controls the reading order.
 *
 * @param {OverlayHost} host
 * @param {{[combo:string]: {action:string, label:string, group?:string}}} keymap
 * @returns {OverlayHandle}
 */
export function showCheatSheet(host, keymap) {
  const groups = new Map();
  const map = keymap || {};
  for (const combo of Object.keys(map)) {
    const entry = map[combo] || {};
    const groupName = entry.group || 'General';
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push({ combo, label: entry.label || entry.action || combo });
  }

  const grid = h('div', { class: 'ov-cheat' });
  for (const [groupName, rows] of groups) {
    const section = h('section', { class: 'ov-cheat__group' },
      h('h3', { class: 'ov-cheat__gt' }, groupName));
    for (let i = 0; i < rows.length; i += 1) {
      section.appendChild(h('div', { class: 'ov-cheat__row' },
        h('kbd', { class: 'ov-cheat__key' }, prettyCombo(rows[i].combo)),
        h('span', { class: 'ov-cheat__label' }, rows[i].label)));
    }
    grid.appendChild(section);
  }
  if (groups.size === 0) {
    grid.appendChild(h('p', { class: 'ov-cheat__label' }, 'No shortcuts are registered.'));
  }

  const handle = showModal(host, {
    title: 'Keyboard shortcuts',
    content: grid,
    className: 'ov-modal--cheat',
    actions: [{ label: 'Close', variant: 'primary', onClick: (hd) => dismiss(hd) }],
  });
  handle.kind = 'cheatsheet';
  return handle;
}

/* =================================================================================================
 * 10. THE FACEPLATE
 * ===============================================================================================*/

/**
 * @typedef {Object} FaceplateReading
 * @property {number} pv        Process value in display units.
 * @property {number} [sp]      Setpoint, when the tag has one. Omit or pass `null` for a PV-only tag.
 * @property {string} [eu]      Engineering unit suffix, e.g. `'mL/min'`.
 * @property {string} [quality] `'GOOD'` (default) | `'SUSPECT'` | `'INVALID'`; anything else dims
 *                              the digits to `--fld-stale`.
 * @property {boolean} [alarm]  `true` paints the digits and the bar in `--fld-alarm`.
 * @property {boolean} [manual] `true` paints the bar in `--fld-out` — the tag is being driven by
 *                              hand.
 */

/**
 * @typedef {Object} FaceplateLimit
 * @property {number} value  Where the marker sits, in the same units as `range`.
 * @property {'alarm'|'warn'|'hi'|'lo'|'hihi'|'lolo'} [kind='alarm']  Marker colour class.
 * @property {string} [label]  Tooltip text for the marker.
 */

/**
 * @typedef {Object} FaceplateAction
 * @property {string|Node} icon  An {@link overlayIcon} name, a 1–3 character glyph, or a node.
 * @property {string} title      Tooltip and accessible name. Required — the button carries no text.
 * @property {(ctx:object) => ({ok:boolean, reason?:string}|void)} run  Invoked with `spec.ctx`.
 *           A returned `{ok:false, reason}` is surfaced as a blocked toast, verbatim.
 * @property {boolean} [disabled]
 */

/**
 * @typedef {Object} FaceplateSpec
 * @property {string} tag        The ISA tag, e.g. `'FIC-101'`. Titles the window and identifies it:
 *                               opening the same tag twice raises the existing faceplate.
 * @property {string} [desc]     Short uppercase descriptor, e.g. `'COLUMN FEED FLOW'`.
 * @property {(run:object) => FaceplateReading} read  Reads the tag from `ctx.run`. Called on every
 *           {@link updateFaceplates}; must not mutate anything.
 * @property {number[]} range    `[lo, hi]` for the bargraph scale.
 * @property {Array<FaceplateLimit|number>} [limits]  Alarm/warn markers drawn on the scale.
 * @property {FaceplateAction[]} [actions]
 * @property {string|((run:object) => string)} [mode]  `'AUTO'` | `'MAN'`, or a function of `run`.
 *           Omit entirely on a tag with no mode and the lamps are not drawn.
 * @property {object} [ctx]      The `{config, run, bus, sim, fmt, overrides}` context. Supplied to
 *           each action's `run`, and read for `ctx.run` when `update()` is called with no argument.
 * @property {number} [decimals] Digits after the point. Defaults from the width of `range`.
 * @property {Element} [anchorEl]  The bubble that was clicked; the window opens beside it.
 * @property {boolean} [autoFocus=true]  Move focus into the faceplate on open.
 */

/** Decimal places to show for a scale of the given span. */
function autoDecimals(lo, hi) {
  const span = Math.abs(hi - lo);
  if (!Number.isFinite(span) || span === 0) return 2;
  if (span >= 500) return 0;
  if (span >= 50) return 1;
  if (span >= 5) return 2;
  return 3;
}

/** Clamp `v` into `[lo,hi]` and return its 0..1 position. Non-finite input reads as the bottom. */
function scalePos(v, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v) || !(hi > lo)) return 0;
  const f = (v - lo) / (hi - lo);
  return f < 0 ? 0 : (f > 1 ? 1 : f);
}

/** Normalise the `limits` array into `{value, kind, label}` records. */
function normaliseLimits(limits) {
  const out = [];
  const list = Array.isArray(limits) ? limits : [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    if (typeof raw === 'number') {
      if (Number.isFinite(raw)) out.push({ value: raw, kind: 'alarm', label: '' });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const v = typeof raw.value === 'number' ? raw.value : Number(raw.value);
    if (!Number.isFinite(v)) continue;
    const k = raw.kind === 'warn' ? 'warn' : 'alarm';
    out.push({ value: v, kind: k, label: typeof raw.label === 'string' ? raw.label : '' });
  }
  return out;
}

/** Bottom offset in px for a 0..1 scale position, inside the bar's padded track. */
function markBottom(pos, markHeight) {
  const track = FP_BAR_H - FP_BAR_PAD * 2;
  return FP_BAR_PAD + pos * track - markHeight / 2;
}

/** Bring one faceplate to the top of the faceplate z-band. */
function raiseFaceplate(handle) {
  if (!handle || handle.dismissed || handle.kind !== 'faceplate') return;
  const host = handle.host;
  host.faceplateSeq += 1;
  handle.zSeq = host.faceplateSeq;
  const open = [];
  for (let i = 0; i < host.stack.length; i += 1) {
    if (host.stack[i].kind === 'faceplate') open.push(host.stack[i]);
  }
  open.sort((a, b) => a.zSeq - b.zSeq);
  for (let i = 0; i < open.length; i += 1) {
    // Stay strictly below the modal dim, so a dialog always covers every faceplate.
    const z = Math.min(Z.faceplate + i, Z.modal - 2);
    open[i].el.style.zIndex = String(z);
  }
}

/** Clamp a faceplate into the viewport, keeping the whole title bar reachable. */
function clampFaceplate(handle) {
  if (handle.dismissed) return;
  const el = handle.el;
  const w = el.offsetWidth || FP_W;
  const hgt = el.offsetHeight || 0;
  const maxX = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - w - VIEWPORT_MARGIN_PX);
  const maxY = Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - hgt - VIEWPORT_MARGIN_PX);
  handle.x = Math.min(Math.max(handle.x, VIEWPORT_MARGIN_PX), maxX);
  handle.y = Math.min(Math.max(handle.y, VIEWPORT_MARGIN_PX), maxY);
  el.style.left = Math.round(handle.x) + 'px';
  el.style.top = Math.round(handle.y) + 'px';
}

/**
 * Wire pointer dragging on a faceplate's title bar and arrow-key nudging on its move button.
 *
 * The two live on different elements deliberately: the whole strip is the pointer target, but the
 * keyboard affordance must be a real `<button>` — and a focusable strip carrying `role="button"`
 * would then contain the close button, which is a nested-interactive-control defect.
 *
 * @param {OverlayHandle} handle  The faceplate handle; `handle.x/y` are the live position.
 * @param {HTMLElement} grip  The title strip: the pointer drag surface.
 * @param {HTMLElement} keyEl  The move button: the keyboard nudge target.
 * @returns {void}
 */
function wireFaceplateDrag(handle, grip, keyEl) {
  let dragging = false;
  let offX = 0;
  let offY = 0;
  let pointerId = -1;

  function onDown(e) {
    if (e.button !== 0) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) return;
    const rect = handle.el.getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    dragging = true;
    pointerId = e.pointerId;
    try { grip.setPointerCapture(pointerId); } catch (err) { /* capture is a nicety, not a need */ }
    raiseFaceplate(handle);
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    handle.x = e.clientX - offX;
    handle.y = e.clientY - offY;
    clampFaceplate(handle);
  }
  function onUp(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    try { grip.releasePointerCapture(pointerId); } catch (err) { /* already released */ }
    pointerId = -1;
  }
  function onKey(e) {
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -1;
    else if (e.key === 'ArrowRight') dx = 1;
    else if (e.key === 'ArrowUp') dy = -1;
    else if (e.key === 'ArrowDown') dy = 1;
    else return;
    const step = FP_NUDGE_PX * (e.shiftKey ? 4 : 1);
    handle.x += dx * step;
    handle.y += dy * step;
    clampFaceplate(handle);
    e.preventDefault();
  }

  grip.addEventListener('pointerdown', onDown);
  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', onUp);
  grip.addEventListener('pointercancel', onUp);
  keyEl.addEventListener('keydown', onKey);

  handle.cleanup.push(() => {
    grip.removeEventListener('pointerdown', onDown);
    grip.removeEventListener('pointermove', onMove);
    grip.removeEventListener('pointerup', onUp);
    grip.removeEventListener('pointercancel', onUp);
    keyEl.removeEventListener('keydown', onKey);
  });
}

/**
 * Open a faceplate for one instrument tag: the small draggable beveled window this whole interface
 * is built around.
 *
 * Contents, top to bottom: an ISA-tagged title bar with a close icon; the descriptor strip; a
 * vertical bargraph of PV against `range` with the SP and every alarm limit drawn as markers on its
 * scale; PV and SP label boxes; AUTO / MAN indicator lamps; and the tag's actions as icon buttons.
 * Nothing on it is a sentence — every explanation is a `title` tooltip.
 *
 * The faceplate is **modeless**: it does not dim the screen, does not make the application inert and
 * does not trap focus, because an operator watches the P&ID while a faceplate is open. `Esc` closes
 * the topmost one. Opening a tag that is already open raises and returns the existing window rather
 * than stacking a duplicate.
 *
 * It renders once here and then only on {@link updateFaceplates}; it never schedules a frame of its
 * own, because the application owns the single rAF loop.
 *
 * @param {OverlayHost} host
 * @param {FaceplateSpec} spec
 * @returns {OverlayHandle} The handle, extended with `tag`, `update(run)` and `raise()`.
 */
export function showFaceplate(host, spec) {
  const s = spec || {};
  const tag = String(s.tag === undefined ? '' : s.tag);

  // One window per tag: a second click on the same bubble raises what is already open.
  for (let i = 0; i < host.stack.length; i += 1) {
    const existing = host.stack[i];
    if (existing.kind === 'faceplate' && existing.tag === tag) {
      raiseFaceplate(existing);
      existing.update();
      return existing;
    }
  }

  const range = Array.isArray(s.range) && s.range.length >= 2
    && Number.isFinite(Number(s.range[0])) && Number.isFinite(Number(s.range[1]))
    ? [Number(s.range[0]), Number(s.range[1])]
    : [0, 100];
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  const decimals = typeof s.decimals === 'number' ? s.decimals : autoDecimals(lo, hi);
  const limits = normaliseLimits(s.limits);
  const previouslyFocused = document.activeElement;

  /* ---- chrome ------------------------------------------------------------------------------- */
  const grip = titleStrip(tag || 'TAG', { draggable: true });
  const moveBtn = iconButton({
    icon: 'move',
    title: 'Move the ' + (tag || 'tag') + ' faceplate — drag, or nudge with the arrow keys',
    onClick: () => { /* the button exists to own the keyboard nudge; the click is a no-op */ },
  });
  grip.insertBefore(moveBtn, grip.firstChild);

  const win = h('div', {
    class: 'ov-win ov-fp',
    role: 'dialog',
    'aria-label': tag + (s.desc ? ' — ' + s.desc : '') + ' faceplate',
    style: { zIndex: String(Z.faceplate), left: '0px', top: '0px' },
  }, grip);

  if (s.desc) win.appendChild(h('div', { class: 'ov-fp__desc' }, s.desc));

  /* ---- bargraph ----------------------------------------------------------------------------- */
  const fillEl = h('div', { class: 'ov-fp__fill' });
  const barEl = h('div', { class: 'ov-fp__bar' }, fillEl);
  const scaleEl = h('div', { class: 'ov-fp__scale' }, barEl);

  const spMark = h('div', {
    class: 'ov-fp__mk ov-fp__mk--sp',
    title: 'Setpoint',
    style: { display: 'none', bottom: markBottom(0, FP_MARK_H) + 'px' },
  });
  scaleEl.appendChild(spMark);

  for (let i = 0; i < limits.length; i += 1) {
    const lim = limits[i];
    scaleEl.appendChild(h('div', {
      class: 'ov-fp__mk' + (lim.kind === 'warn' ? ' ov-fp__mk--warn' : ''),
      title: lim.label || (lim.kind === 'warn' ? 'Warn limit' : 'Alarm limit')
        + ' ' + fmtFixed(lim.value, decimals),
      style: { bottom: markBottom(scalePos(lim.value, lo, hi), FP_MARK_H) + 'px' },
    }));
  }

  const ticks = [hi, lo + (hi - lo) / 2, lo];
  for (let i = 0; i < ticks.length; i += 1) {
    const pos = scalePos(ticks[i], lo, hi);
    scaleEl.appendChild(h('div', {
      class: 'ov-fp__tick',
      style: { bottom: markBottom(pos, 9) + 'px' },
    }, fmtFixed(ticks[i], decimals)));
  }

  /* ---- readouts ----------------------------------------------------------------------------- */
  const pv = labelBox({ label: 'PV', tone: 'pv', big: true });
  const sp = labelBox({ label: 'SP', tone: 'sp' });
  sp.el.style.display = 'none';

  const side = h('div', { class: 'ov-fp__side' }, pv.el, sp.el);

  const hasMode = s.mode !== undefined && s.mode !== null;
  let autoLamp = null;
  let manLamp = null;
  let autoWrap = null;
  let manWrap = null;
  if (hasMode) {
    autoLamp = statusLamp('off');
    manLamp = statusLamp('off');
    autoWrap = h('span', { class: 'ov-fp__mode' }, autoLamp, 'AUTO');
    manWrap = h('span', { class: 'ov-fp__mode' }, manLamp, 'MAN');
    side.appendChild(h('div', { class: 'ov-fp__modes' }, autoWrap, manWrap));
  }

  win.appendChild(h('div', { class: 'ov-fp__main' }, scaleEl, side));

  /* ---- action bar --------------------------------------------------------------------------- */
  const actsRow = h('div', { class: 'ov-fp__acts' });
  const qualityLamp = statusLamp('run', { title: 'Signal quality' });
  const qualityText = h('span', {}, 'GOOD');
  const actions = Array.isArray(s.actions) ? s.actions : [];

  const handle = makeHandle(host, 'faceplate', win, win, s);
  handle.tag = tag;
  handle.spec = s;
  handle.zSeq = 0;
  handle.x = 0;
  handle.y = 0;

  for (let i = 0; i < actions.length; i += 1) {
    const act = actions[i];
    if (!act || typeof act.run !== 'function') continue;
    actsRow.appendChild(iconButton({
      icon: act.icon,
      title: act.title || 'Action',
      large: true,
      disabled: !!act.disabled,
      onClick: () => {
        let result;
        try {
          result = act.run(s.ctx);
        } catch (err) {
          showToast(host, {
            message: (act.title || tag) + ' failed: ' + ((err && err.message) || String(err)),
            kind: 'blocked',
          });
          return;
        }
        if (result && typeof result === 'object' && 'ok' in result) reportResult(host, result);
        handle.update();
      },
    }));
  }
  actsRow.appendChild(h('span', { class: 'ov-fp__q' }, qualityLamp, qualityText));
  win.appendChild(actsRow);

  grip.appendChild(iconButton({
    icon: 'close',
    title: 'Close the ' + (tag || 'tag') + ' faceplate',
    onClick: () => dismiss(handle),
  }));

  host.el.appendChild(win);

  /* ---- placement ---------------------------------------------------------------------------- */
  const anchor = s.anchorEl && s.anchorEl.isConnected ? s.anchorEl.getBoundingClientRect() : null;
  host.faceplateSeq += 1;
  const cascade = (host.faceplateSeq % 6) * FP_CASCADE_PX;
  if (anchor) {
    handle.x = anchor.right + ANCHOR_GAP_PX;
    handle.y = anchor.top - 20;
  } else {
    handle.x = VIEWPORT_MARGIN_PX + cascade;
    handle.y = VIEWPORT_MARGIN_PX + cascade;
  }
  clampFaceplate(handle);
  raiseFaceplate(handle);
  wireFaceplateDrag(handle, grip, moveBtn);

  handle.reposition = function reposition() { clampFaceplate(handle); };
  handle.raise = function raise() { raiseFaceplate(handle); };

  /* ---- the one render path ------------------------------------------------------------------ */
  handle.update = function update(runArg) {
    if (handle.dismissed) return;
    const run = runArg || (s.ctx && s.ctx.run) || null;
    if (!run || typeof s.read !== 'function') return;

    let r;
    try {
      r = s.read(run);
    } catch (err) {
      // A faceplate is never allowed to take the frame loop down with it.
      setText(pv.valueEl, NO_VALUE);
      setLamp(qualityLamp, 'alarm');
      setText(qualityText, 'FAULT');
      return;
    }
    if (!r || typeof r !== 'object') return;

    const quality = typeof r.quality === 'string' ? r.quality.toUpperCase() : 'GOOD';
    const stale = quality !== 'GOOD' && quality !== 'OK';
    const alarm = !!r.alarm;
    const manual = !!r.manual;

    setText(pv.valueEl, fmtFixed(r.pv, decimals));
    setText(pv.euEl, r.eu || '');
    cls(pv.box, 'ov-fld--alarm', alarm);
    cls(pv.box, 'ov-fld--stale', stale && !alarm);
    cls(pv.box, 'ov-fld--out', manual && !alarm && !stale);

    const hasSp = typeof r.sp === 'number' && Number.isFinite(r.sp);
    sp.el.style.display = hasSp ? '' : 'none';
    spMark.style.display = hasSp ? '' : 'none';
    if (hasSp) {
      setText(sp.valueEl, fmtFixed(r.sp, decimals));
      setText(sp.euEl, r.eu || '');
      spMark.style.bottom = markBottom(scalePos(r.sp, lo, hi), FP_MARK_H) + 'px';
    }

    const pos = scalePos(r.pv, lo, hi);
    fillEl.style.height = Math.round(pos * (FP_BAR_H - FP_BAR_PAD * 2)) + 'px';
    cls(fillEl, 'ov-fp__fill--alarm', alarm);
    cls(fillEl, 'ov-fp__fill--stale', stale && !alarm);
    cls(fillEl, 'ov-fp__fill--out', manual && !alarm && !stale);

    if (hasMode) {
      const raw = typeof s.mode === 'function' ? s.mode(run) : s.mode;
      const isMan = String(raw === undefined || raw === null ? '' : raw).toUpperCase().indexOf('MAN') === 0;
      setLamp(autoLamp, isMan ? 'off' : 'run');
      setLamp(manLamp, isMan ? 'warn' : 'off');
      cls(autoWrap, 'ov-fp__mode--on', !isMan);
      cls(manWrap, 'ov-fp__mode--on', isMan);
    }

    setLamp(qualityLamp, alarm ? 'alarm' : (stale ? 'warn' : 'run'), alarm);
    setText(qualityText, alarm ? 'ALM' : (stale ? quality.slice(0, 4) : 'GOOD'));
  };
  handle.update();

  handle.releaseFocus = function releaseFocus() {
    if (previouslyFocused && typeof previouslyFocused.focus === 'function'
      && previouslyFocused.isConnected) previouslyFocused.focus();
  };
  if (s.autoFocus !== false) moveBtn.focus();

  return register(host, handle);
}

/**
 * Repaint every open faceplate from the current `run`. Call it once per frame from the application's
 * single rAF loop, or from the P&ID panel's `update(info)`; faceplates never schedule frames.
 *
 * @param {OverlayHost} host
 * @param {object} [run]  The run state. Omit and each faceplate reads `spec.ctx.run` itself, which
 *        is what keeps them correct across a `config-replaced` rebuild.
 * @returns {number} How many faceplates were repainted.
 */
export function updateFaceplates(host, run) {
  if (!host) return 0;
  let n = 0;
  for (let i = 0; i < host.stack.length; i += 1) {
    const handle = host.stack[i];
    if (handle.kind !== 'faceplate' || typeof handle.update !== 'function') continue;
    handle.update(run);
    n += 1;
  }
  return n;
}

/**
 * The open faceplate for a tag, if any. Lets the P&ID paint an instrument bubble as "opened".
 *
 * @param {OverlayHost} host
 * @param {string} tag  An ISA tag, e.g. `'PT-101'`.
 * @returns {OverlayHandle|null}
 */
export function findFaceplate(host, tag) {
  if (!host) return null;
  for (let i = 0; i < host.stack.length; i += 1) {
    if (host.stack[i].kind === 'faceplate' && host.stack[i].tag === tag) return host.stack[i];
  }
  return null;
}

/* =================================================================================================
 * 11. SMALL HELPERS FOR CALLERS
 * ===============================================================================================*/

/**
 * Is this handle still on screen?
 * @param {OverlayHandle|null|undefined} handle
 * @returns {boolean}
 */
export function isOpen(handle) {
  return !!handle && !handle.dismissed;
}

/**
 * Replace a floating surface's content without closing and reopening it — which would lose focus,
 * scroll position and, for a popover, its placement. Used by the live cursor card and by any
 * readout that updates while its popover is open.
 *
 * @param {OverlayHandle} handle
 * @param {Node|string} content  Replaces everything currently inside `handle.contentEl`.
 * @returns {void}
 */
export function setOverlayContent(handle, content) {
  if (!handle || handle.dismissed) return;
  const target = handle.contentEl;
  while (target.firstChild) target.removeChild(target.firstChild);
  mountContent(target, content);
  handle.reposition();
}

/**
 * Show or clear a "blocked" toast from a `core/sim.js` action result in one line. Every call site
 * that invokes a `sim.*` action can end with `reportResult(host, sim.start(ctx))` and explain the
 * refusal without writing its own branch.
 *
 * @param {OverlayHost} host
 * @param {{ok:boolean, reason?:string}} result  The `{ok, reason}` every action returns.
 * @param {string} [fallbackReason='Action refused.']  Shown when `ok` is false and `reason` is empty.
 * @returns {boolean} `result.ok`, so the caller can chain on it.
 */
export function reportResult(host, result, fallbackReason) {
  if (result && result.ok) return true;
  const reason = (result && result.reason) || fallbackReason || 'Action refused.';
  showToast(host, { message: reason, kind: 'blocked' });
  return false;
}

/**
 * Toggle a CSS class on a handle's element. A convenience so views never reach into `handle.el`
 * directly for a state class.
 *
 * @param {OverlayHandle} handle
 * @param {string} className
 * @param {boolean} on
 * @returns {void}
 */
export function setOverlayClass(handle, className, on) {
  if (!handle || handle.dismissed) return;
  cls(handle.el, className, on);
}
