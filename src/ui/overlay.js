/**
 * @file src/ui/overlay.js — every floating surface in the application, in one place
 *                           (architecture-v2 §6.33, §9.4.2, §9.4.4, §9.6, §9.7).
 *
 * Popovers, glossary cards, modals, confirm dialogs, toasts, coach marks and the `?` cheat sheet all
 * live here for one reason: **focus handling is written once**. §9.7 requires that modals and
 * popovers trap focus and restore it, that `Esc` closes the topmost surface, and that every
 * interactive element keeps a real focus ring. Six views each rolling their own dialog would give
 * six subtly different answers.
 *
 * This module also owns:
 *  - viewport-flipping placement with a clamped 6 px arrow;
 *  - the `rgba(0,0,0,.55)` dim and the `clip-path` cut-out the §9.6 tour spotlights with;
 *  - the 250 ms show / 60 ms hide hover timing of §9.4.2;
 *  - the toast surface that `sim.manualSet`'s `{ok:false, reason}` goes through (§9.4.4) —
 *    **interlocks are explained, never silently refused**.
 *
 * LAYERING: it imports `ui/format.js` and nothing else (§6.33). In particular it does **not** import
 * `data/glossary.js`: the glossary is content, owned by `src/data/glossary.js`, and the views that
 * render an `ⓘ` already import `glossaryFor`. They pass the resolved entry to
 * {@link showGlossaryPopover}, which knows the four-section layout but not a word of the text.
 *
 * STYLING: geometry (position, size, clip) is computed and therefore inline. Appearance comes from
 * class names so `styles/app.css` owns the look. A minimal base stylesheet is injected once inside
 * `@layer chromaskid-overlay` so the overlays are usable with `styles/tokens.css` alone; because
 * unlayered author rules always beat layered ones, `styles/app.css` overrides it without a
 * specificity fight.
 *
 * @module ui/overlay
 */

import { h, setText, setAttr, cls } from './format.js';

/* =================================================================================================
 * 0. CONSTANTS AND BASE STYLES
 * ===============================================================================================*/

/** Hover show / hide delays, §9.4.2. */
const TOOLTIP_SHOW_MS = 250;
const TOOLTIP_HIDE_MS = 60;

/** Gap between an anchor and its floating surface, and the minimum margin to the viewport edge. */
const ANCHOR_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;
const ARROW_PX = 6;

/** Default lifetimes per toast kind, ms. `blocked` lives longest: it explains a refusal. */
const TOAST_MS = { info: 3500, warn: 5000, blocked: 6000 };

/** Stacking order inside the overlay root. */
const Z = { popover: 10, modal: 30, coach: 40, toast: 50 };

/** Elements that can take focus, for the focus trap. */
const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

const BASE_CSS = `@layer chromaskid-overlay {
.ov-root{position:fixed;inset:0;z-index:1000;pointer-events:none;
  font-family:var(--font-ui);color:var(--text-1);}
.ov-root>*{pointer-events:auto;}
.ov-dim{position:fixed;inset:0;background:rgba(0,0,0,.55);pointer-events:auto;}
.ov-card{position:fixed;box-sizing:border-box;background:var(--overlay);
  border:1px solid var(--line-strong);border-radius:var(--r-2);box-shadow:var(--shadow-2);
  font-size:var(--fs-11);line-height:var(--lh-base);}
.ov-popover{padding:8px;max-width:280px;}
.ov-arrow{position:absolute;width:${ARROW_PX * 2}px;height:${ARROW_PX * 2}px;
  background:var(--overlay);border:1px solid var(--line-strong);transform:rotate(45deg);}
.ov-arrow--top{border-left:0;border-top:0;}
.ov-arrow--bottom{border-right:0;border-bottom:0;}
.ov-arrow--left{border-left:0;border-bottom:0;}
.ov-arrow--right{border-right:0;border-top:0;}
.ov-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
  box-sizing:border-box;display:flex;flex-direction:column;max-width:min(92vw,560px);
  max-height:86vh;background:var(--surface-1);border:1px solid var(--line-strong);
  border-radius:var(--r-3);box-shadow:var(--shadow-2);font-size:var(--fs-12);}
.ov-modal__head{display:flex;align-items:center;gap:8px;height:44px;flex:0 0 auto;
  padding:0 12px;border-bottom:1px solid var(--line);}
.ov-modal__title{margin:0;font-size:var(--fs-13);font-weight:600;color:var(--text-1);}
.ov-modal__close{margin-left:auto;width:28px;height:28px;line-height:1;font-size:var(--fs-15);
  background:transparent;border:1px solid transparent;border-radius:var(--r-2);
  color:var(--text-2);cursor:pointer;}
.ov-modal__close:hover{background:var(--surface-2);color:var(--text-1);}
.ov-modal__body{flex:1 1 auto;overflow:auto;padding:12px;color:var(--text-1);}
.ov-modal__actions{flex:0 0 auto;display:flex;justify-content:flex-end;gap:8px;
  padding:12px;border-top:1px solid var(--line);}
.ov-btn{height:30px;padding:0 10px;font:600 var(--fs-12)/1 var(--font-ui);border-radius:var(--r-2);
  border:1px solid var(--line);background:var(--surface-2);color:var(--text-1);cursor:pointer;}
.ov-btn:hover{background:var(--surface-3);}
.ov-btn--primary{background:var(--accent);border-color:var(--accent);color:var(--text-inv);}
.ov-btn--primary:hover{background:var(--accent-hover);}
.ov-btn--danger{background:var(--alarm);border-color:var(--alarm);color:var(--text-inv);}
.ov-toasts{position:fixed;right:16px;bottom:44px;display:flex;flex-direction:column-reverse;
  gap:8px;max-width:min(92vw,360px);pointer-events:none;}
.ov-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:8px 10px;
  background:var(--surface-1);border:1px solid var(--line-strong);border-left-width:4px;
  border-radius:var(--r-2);box-shadow:var(--shadow-2);font-size:var(--fs-12);color:var(--text-1);}
.ov-toast--info{border-left-color:var(--info);}
.ov-toast--warn{border-left-color:var(--warn);background:var(--warn-soft);}
.ov-toast--blocked{border-left-color:var(--alarm);background:var(--alarm-soft);}
.ov-toast__icon{flex:0 0 auto;font-weight:700;}
.ov-toast__msg{flex:1 1 auto;}
.ov-toast__count{flex:0 0 auto;color:var(--text-3);font-variant-numeric:tabular-nums;}
.ov-toast__close{flex:0 0 auto;background:transparent;border:0;color:var(--text-3);
  cursor:pointer;font-size:var(--fs-13);line-height:1;padding:0 2px;}
.ov-coach{max-width:320px;padding:12px;background:var(--surface-1);}
.ov-coach__step{font-size:var(--fs-10);text-transform:uppercase;letter-spacing:.06em;
  color:var(--text-3);}
.ov-coach__title{margin:4px 0 6px;font-size:var(--fs-13);font-weight:600;}
.ov-coach__body{margin:0 0 10px;font-size:var(--fs-12);color:var(--text-2);}
.ov-coach__actions{display:flex;align-items:center;gap:8px;}
.ov-coach__dots{display:flex;gap:4px;margin-right:auto;}
.ov-coach__dot{width:6px;height:6px;border-radius:var(--r-pill);background:var(--surface-3);}
.ov-coach__dot--on{background:var(--accent);}
.ov-gloss__term{margin:0 0 4px;font-size:var(--fs-12);font-weight:600;color:var(--text-1);}
.ov-gloss__lead{margin:0 0 6px;color:var(--text-1);}
.ov-gloss__h{margin:6px 0 2px;font-size:var(--fs-9);text-transform:uppercase;
  letter-spacing:.06em;color:var(--text-3);}
.ov-gloss__p{margin:0;color:var(--text-2);}
.ov-gloss__see{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.ov-gloss__chip{font:400 var(--fs-10)/1 var(--font-ui);padding:3px 6px;border-radius:var(--r-pill);
  border:1px solid var(--line);background:var(--surface-2);color:var(--text-2);cursor:pointer;}
.ov-gloss__chip:hover{color:var(--text-1);border-color:var(--line-strong);}
.ov-cheat{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px 20px;}
.ov-cheat__group{break-inside:avoid;}
.ov-cheat__gt{margin:0 0 4px;font-size:var(--fs-9);text-transform:uppercase;letter-spacing:.06em;
  color:var(--text-3);}
.ov-cheat__row{display:flex;align-items:baseline;gap:8px;padding:2px 0;}
.ov-cheat__key{flex:0 0 auto;min-width:74px;font:600 var(--fs-10)/1.6 var(--font-num);
  padding:1px 5px;border:1px solid var(--line-strong);border-bottom-width:2px;
  border-radius:var(--r-1);background:var(--surface-2);color:var(--text-1);}
.ov-cheat__label{flex:1 1 auto;color:var(--text-2);font-size:var(--fs-12);}
.ov-root :focus-visible{outline:2px solid var(--focus);outline-offset:2px;}
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

/** `true` when the user asked for reduced motion (§9.7). Re-evaluated on every open, not cached. */
function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/* =================================================================================================
 * 1. PLACEMENT
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
      arrow.style.top = side === 'top' ? size.h - ARROW_PX - 1 + 'px' : -ARROW_PX - 1 + 'px';
    } else {
      const cy = Math.min(
        Math.max(rect.top + rect.height / 2 - y, ARROW_PX + 4),
        Math.max(ARROW_PX + 4, size.h - ARROW_PX - 4),
      );
      arrow.style.top = Math.round(cy - ARROW_PX) + 'px';
      arrow.style.left = side === 'left' ? size.w - ARROW_PX - 1 + 'px' : -ARROW_PX - 1 + 'px';
    }
  }
  return side;
}

/* =================================================================================================
 * 2. FOCUS
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
 * Trap keyboard focus inside an element and remember where focus came from (§9.7).
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
 * 3. THE HOST
 * ===============================================================================================*/

let handleSeq = 0;

/**
 * @typedef {Object} OverlayHandle
 * @property {number} id            Monotonic id, unique per session.
 * @property {'popover'|'modal'|'toast'|'coach'|'cheatsheet'} kind
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
 * remembered so the application content can be made inert while a modal dialog is open (§9.7).
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
 * @param {'popover'|'modal'|'toast'|'coach'|'cheatsheet'} [kind]  Omit to dismiss everything.
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

/* =================================================================================================
 * 4. POPOVERS AND TOOLTIPS
 * ===============================================================================================*/

/**
 * Show a popover anchored to an element, flipping away from the viewport edges.
 *
 * The popover closes on `Esc`, on a pointer press outside it, and when {@link dismiss} is called.
 * Focus is trapped **only if the content is interactive** — a read-only glossary card must not steal
 * the keyboard from the control the operator was using, while a popover containing buttons must,
 * per §9.7. Focus is always restored to whatever had it before.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {Element} opts.anchorEl  The element to point at. Its bounding rect is re-read on every
 *        scroll and resize, so the popover tracks a scrolling panel.
 * @param {Node|string} opts.content  The body. A string becomes a text node.
 * @param {string} [opts.placement='bottom']  `'top'|'bottom'|'left'|'right'`, optionally suffixed
 *        `'-start'`/`'-end'` to align with the anchor's leading/trailing edge.
 * @param {number} [opts.maxWidth=280]  Max width in px (§9.4.2 specifies 280).
 * @param {string} [opts.role='dialog']  Use `'tooltip'` for a purely descriptive popover.
 * @param {string} [opts.className]  Extra class on the card, for view-specific styling.
 * @param {boolean} [opts.arrow=true]  Draw the 6 px arrow.
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

  const arrow = o.arrow === false ? null : h('div', { class: 'ov-arrow ov-arrow--bottom' });
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
 * Bind a hover/focus tooltip to an element, with the §9.4.2 timing: 250 ms before it shows, 60 ms
 * before it hides, so a pointer crossing a dense tag strip does not flash a dozen cards.
 *
 * The tooltip also opens on keyboard focus and closes on blur, which is what makes tag help
 * reachable without a pointer.
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
 * Render a glossary entry as the four-section popover §9.6 specifies: *what it is*, *units and
 * typical range*, *why it matters and what abnormal looks like*, then the see-also chips.
 *
 * The **content** comes from `src/data/glossary.js` — the caller resolves it with `glossaryFor(id)`
 * and passes the entry in. This module deliberately does not import the glossary (§6.33: it imports
 * `ui/format.js` only), so the layout lives here and not one word of the text does. A `null` entry
 * returns `null` and renders nothing: §6.22.1 says a label may not carry an `ⓘ` without an entry.
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
 * 5. MODALS AND CONFIRMS
 * ===============================================================================================*/

/** Build one action button. */
function actionButton(spec, handle) {
  const variant = spec.variant === 'primary' || spec.variant === 'danger' ? spec.variant : 'ghost';
  const btn = h('button', {
    type: 'button',
    class: 'ov-btn' + (variant === 'ghost' ? '' : ' ov-btn--' + variant) + ' btn btn--' + variant,
    onClick: () => { if (typeof spec.onClick === 'function') spec.onClick(handle); },
  }, spec.label);
  if (spec.disabled) setAttr(btn, 'disabled', '');
  return btn;
}

/**
 * Show a modal dialog: dimmed background, trapped focus, `Esc` to close when dismissible.
 *
 * §9.7: "the app never blocks on a dialog while a run is live except for E-stop confirmation" — that
 * policy belongs to the caller; this function only guarantees that when a modal is up, the
 * application content behind it is `inert` and `aria-hidden`, so a screen reader never reads through
 * the dim.
 *
 * @param {OverlayHost} host
 * @param {object} opts
 * @param {string} opts.title  Dialog heading; also the accessible name.
 * @param {Node|string} opts.content  The body.
 * @param {Array<{label:string, onClick?:(handle:OverlayHandle)=>void,
 *                variant?:'primary'|'ghost'|'danger', disabled?:boolean}>} [opts.actions]
 *        Rendered right-aligned in source order. Handlers receive the handle so they can
 *        `dismiss(handle)` themselves; nothing closes automatically.
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
    head.appendChild(h('button', {
      type: 'button',
      class: 'ov-modal__close',
      'aria-label': 'Close dialog',
      onClick: () => dismiss(handle),
    }, '×'));
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
 * A two-button confirm dialog. Used for "End run" (§9.4.3), for destructive method edits, and for
 * anything §9.7 requires to be "undoable or gated by a held/typed confirm".
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
 * 6. TOASTS
 * ===============================================================================================*/

const TOAST_ICON = { info: 'i', warn: '!', blocked: '⊘' };

/**
 * Show a transient message in the bottom-right stack.
 *
 * This is the surface every `{ok:false, reason}` from `core/sim.js` goes through (§9.4.4): a blocked
 * interlock is **explained**, never silently refused. Repeating the same message re-arms the timer
 * and adds a `xN` counter instead of stacking duplicates, because a held key can produce a refusal
 * per frame.
 *
 * Live-region behaviour follows §9.7: the stack is `aria-live="polite"`, and a `blocked` toast is
 * additionally `role="alert"` so it is announced immediately.
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
  h('span', { class: 'ov-toast__icon', 'aria-hidden': 'true' }, TOAST_ICON[kind]),
  h('span', { class: 'ov-toast__msg' }, message),
  countEl,
  h('button', {
    type: 'button',
    class: 'ov-toast__close',
    'aria-label': 'Dismiss message',
    onClick: () => dismiss(handle),
  }, '×'));

  host.toastLayer.appendChild(el);

  const handle = makeHandle(host, 'toast', el, el, o);
  handle.toastKind = kind;
  handle.toastMessage = message;
  handle.repeatCount = 1;
  handle.countEl = countEl;
  if (ms > 0) handle.timer = setTimeout(() => dismiss(handle), ms);

  return register(host, handle);
}

/* =================================================================================================
 * 7. COACH MARKS (the §9.6 tour)
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
 * positioned card with Back / Next / Skip and progress dots (§9.6).
 *
 * A `null` `targetEl` dims the whole viewport and centres the card, which is what the opening and
 * closing steps of a tour want. `Esc` skips the tour, exactly as §9.6 requires.
 *
 * Under `prefers-reduced-motion` the spotlight has no transition (§9.7).
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
  h('div', { class: 'ov-coach__step' }, 'Step ' + step + ' of ' + total),
  h('h3', { class: 'ov-coach__title' }, o.title || ''),
  h('p', { class: 'ov-coach__body' }, o.body || ''),
  actions);

  host.el.appendChild(dim);
  host.el.appendChild(card);

  const handle = makeHandle(host, 'coach', card, card, o);
  handle.dimEl = dim;

  actions.appendChild(h('button', {
    type: 'button',
    class: 'ov-btn',
    onClick: () => { skipped = true; dismiss(handle); if (o.onSkip) o.onSkip(); },
  }, 'Skip'));
  if (step > 1 && typeof o.onBack === 'function') {
    actions.appendChild(h('button', {
      type: 'button',
      class: 'ov-btn',
      onClick: () => { skipped = true; dismiss(handle); o.onBack(); },
    }, 'Back'));
  }
  actions.appendChild(h('button', {
    type: 'button',
    class: 'ov-btn ov-btn--primary',
    onClick: () => {
      skipped = true;
      dismiss(handle);
      if (typeof o.onNext === 'function') o.onNext();
      else if (typeof o.onSkip === 'function') o.onSkip();
    },
  }, step >= total ? 'Done' : 'Next'));

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
 * 8. THE `?` CHEAT SHEET
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
 * Show the keyboard cheat sheet — the discoverability path §9.5 requires behind the `?` key.
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
 * 9. SMALL HELPERS FOR CALLERS
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
 * that invokes a `sim.*` action can end with `reportResult(host, sim.start(ctx))` and satisfy §9.4.4
 * without writing its own branch.
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
