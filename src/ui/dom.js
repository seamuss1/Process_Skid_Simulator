/**
 * src/ui/dom.js — element construction, in-place text/attribute writes, and number formatting.
 *
 * Layer L5. The only module in `src/ui` allowed to be imported by every other one.
 *
 * Everything the views build goes through `h`/`hSvg`, so no view ever reaches for `innerHTML`.
 * Everything the views UPDATE goes through `setText`/`setAttr`/`cls`, which write only when the
 * value actually changed: at 60 fps with a hundred live readouts, skipping the unchanged ones is
 * the difference between six thousand DOM mutations a second and a few dozen.
 */

/** The SVG namespace. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Apply one attribute-bag entry to an element.
 * @param {Element} el target
 * @param {string} k key
 * @param {*} v value
 * @param {boolean} svg whether the element is in the SVG namespace
 * @returns {void}
 */
function applyProp(el, k, v, svg) {
  if (v === null || v === undefined || v === false) return;
  if (k === 'class' || k === 'className') { el.setAttribute('class', String(v)); return; }
  if (k === 'text') { el.textContent = String(v); return; }
  if (k === 'dataset') {
    for (const dk of Object.keys(v)) el.setAttribute(`data-${dk}`, String(v[dk]));
    return;
  }
  if (k === 'style' && v && typeof v === 'object') {
    for (const sk of Object.keys(v)) {
      const sv = v[sk];
      if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
      else el.style[sk] = typeof sv === 'number' && sk !== 'opacity' && sk !== 'zIndex' ? `${sv}px` : sv;
    }
    return;
  }
  if (k.startsWith('on') && typeof v === 'function') {
    el.addEventListener(k.slice(2).toLowerCase(), v);
    return;
  }
  if (!svg && k in el && k !== 'list' && typeof v !== 'object') {
    try { el[k] = v; return; } catch { /* fall through to setAttribute */ }
  }
  el.setAttribute(k, v === true ? '' : String(v));
}

/**
 * Append a child of any accepted shape. Nullish and boolean children are skipped, so
 * `cond && h(...)` is safe in a child list.
 * @param {Element} el parent
 * @param {*} c child
 * @returns {void}
 */
function appendChild(el, c) {
  if (c === null || c === undefined || c === false || c === true) return;
  if (Array.isArray(c)) { for (const x of c) appendChild(el, x); return; }
  el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
}

/**
 * Build an HTML element.
 * @param {string} tag tag name
 * @param {object|null} [attrs] attribute bag: `class`, `text`, `style` (string or object),
 *   `dataset`, `on<Event>` handlers, anything else becomes an attribute or a property
 * @param {...*} children appended in order
 * @returns {HTMLElement} the element
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) applyProp(el, k, attrs[k], false);
  for (const c of children) appendChild(el, c);
  return el;
}

/**
 * Build an SVG element in the SVG namespace.
 * @param {string} tag tag name
 * @param {object|null} [attrs] as {@link h}
 * @param {...*} children appended in order
 * @returns {SVGElement} the element
 */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) applyProp(el, k, attrs[k], true);
  for (const c of children) appendChild(el, c);
  return el;
}

/**
 * Write text only when it changed.
 * @param {Node|null} node element or text node
 * @param {*} v the new text
 * @returns {void}
 */
export function setText(node, v) {
  if (!node) return;
  const next = typeof v === 'string' ? v : String(v);
  if (node.nodeType === 3) { if (node.nodeValue !== next) node.nodeValue = next; }
  else if (node.textContent !== next) node.textContent = next;
}

/**
 * Write an attribute only when it changed; nullish removes it.
 * @param {Element|null} node target
 * @param {string} k attribute name
 * @param {*} v value, or nullish to remove
 * @returns {void}
 */
export function setAttr(node, k, v) {
  if (!node) return;
  if (v === null || v === undefined) { if (node.hasAttribute(k)) node.removeAttribute(k); return; }
  const next = String(v);
  if (node.getAttribute(k) !== next) node.setAttribute(k, next);
}

/**
 * Add or remove a class.
 * @param {Element|null} node target
 * @param {string} name class name
 * @param {boolean} on truthy adds
 * @returns {void}
 */
export function cls(node, name, on) {
  if (node && name) node.classList.toggle(name, !!on);
}

// --------------------------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------------------------

/**
 * Fixed-decimal format that never shows "NaN" or "-0" on a panel.
 * @param {number} v value
 * @param {number} [d=1] decimals
 * @returns {string} the formatted number, or an em dash
 */
export function num(v, d = 1) {
  if (!Number.isFinite(v)) return '—';
  const x = Math.abs(v) < 0.5 / 10 ** d ? 0 : v;
  return x.toFixed(d);
}

/**
 * Elapsed time as `h:mm:ss`.
 * @param {number} t_s seconds
 * @returns {string} the clock string
 */
export function clock(t_s) {
  const t = Math.max(0, Math.floor(t_s));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * A duration in the shortest sensible unit.
 * @param {number} t_s seconds
 * @returns {string} e.g. `18 s` or `3.4 min`
 */
export function dur(t_s) {
  if (!Number.isFinite(t_s)) return '—';
  return t_s < 90 ? `${num(t_s, 0)} s` : `${num(t_s / 60, 1)} min`;
}

// --------------------------------------------------------------------------------------------
// Small composite controls, shared by every panel
// --------------------------------------------------------------------------------------------

/**
 * A titled panel with a body.
 * @param {string} title the header text
 * @param {object} [opts] options
 * @param {string} [opts.cls] extra class on the panel
 * @param {Node|Node[]} [opts.tools] controls rendered on the right of the header
 * @param {...*} body body children
 * @returns {HTMLElement} the panel, with `.body` exposed as a property
 */
export function panel(title, opts, ...body) {
  const b = h('div', { class: 'panel__body' }, ...body);
  const el = h('section', { class: `panel ${(opts && opts.cls) || ''}` },
    h('header', { class: 'panel__head' },
      h('span', { class: 'panel__title', text: title }),
      opts && opts.tools ? h('span', { class: 'panel__tools' }, opts.tools) : null),
    b);
  el.body = b;
  return el;
}

/**
 * A labelled numeric entry that commits on blur or Enter and reverts on Escape.
 *
 * The revert matters: a mistyped gain that is applied on every keystroke has already been applied
 * as `4`, `45` and `450` before the operator finishes typing `4.5`.
 *
 * @param {object} spec field spec
 * @param {string} spec.label the label
 * @param {string} [spec.unit] engineering unit shown after the input
 * @param {number} spec.value initial value
 * @param {number} [spec.step] input step
 * @param {number} [spec.min] minimum
 * @param {number} [spec.max] maximum
 * @param {string} [spec.hint] title text
 * @param {(v:number)=>void} spec.onCommit called with the parsed value
 * @returns {HTMLElement} the row, with `.input` exposed
 */
export function numField({ label, unit, value, step, min, max, hint, onCommit }) {
  const input = h('input', {
    class: 'field__input',
    type: 'number',
    value: String(value),
    step: step === undefined ? 'any' : step,
    min, max,
    onKeydown: (ev) => {
      if (ev.key === 'Enter') { input.blur(); }
      if (ev.key === 'Escape') { input.value = input.dataset.last || ''; input.blur(); }
    },
    onFocus: () => { input.dataset.last = input.value; },
    onChange: () => {
      const v = Number.parseFloat(input.value);
      if (Number.isFinite(v)) onCommit(v);
    },
  });
  const row = h('label', { class: 'field', title: hint || '' },
    h('span', { class: 'field__label', text: label }),
    input,
    unit ? h('span', { class: 'field__unit', text: unit }) : null);
  row.input = input;
  return row;
}

/**
 * A labelled slider with a live readout.
 * @param {object} spec slider spec
 * @param {string} spec.label the label
 * @param {string} [spec.unit] engineering unit
 * @param {number} spec.value initial value
 * @param {number} spec.min minimum
 * @param {number} spec.max maximum
 * @param {number} spec.step step
 * @param {number} [spec.dp] decimals in the readout
 * @param {string} [spec.hint] title text
 * @param {(v:number)=>void} spec.onInput called continuously as the slider moves
 * @returns {HTMLElement} the row, with `.input` and `.read` exposed
 */
export function slider({ label, unit, value, min, max, step, dp = 1, hint, onInput }) {
  const read = h('span', { class: 'slider__read', text: `${num(value, dp)}${unit ? ` ${unit}` : ''}` });
  const input = h('input', {
    class: 'slider__input', type: 'range', min, max, step, value: String(value),
    onInput: () => {
      const v = Number.parseFloat(input.value);
      setText(read, `${num(v, dp)}${unit ? ` ${unit}` : ''}`);
      onInput(v);
    },
  });
  const row = h('div', { class: 'slider', title: hint || '' },
    h('div', { class: 'slider__top' },
      h('span', { class: 'slider__label', text: label }), read),
    input);
  row.input = input;
  row.read = read;
  row.dp = dp;
  row.unit = unit;
  return row;
}

/**
 * A horizontal group of mutually exclusive buttons.
 * @param {Array<{id:string,label:string,hint?:string}>} items the choices
 * @param {string} value the selected id
 * @param {(id:string)=>void} onPick called with the chosen id
 * @returns {HTMLElement} the group, with `.select(id)` exposed
 */
export function segmented(items, value, onPick) {
  const btns = new Map();
  const el = h('div', { class: 'seg' }, items.map((it) => {
    const b = h('button', {
      class: 'seg__btn', type: 'button', title: it.hint || '', text: it.label,
      onClick: () => onPick(it.id),
    });
    btns.set(it.id, b);
    return b;
  }));
  el.select = (id) => { for (const [k, b] of btns) cls(b, 'is-on', k === id); };
  el.select(value);
  return el;
}

/**
 * A read-only value box: tag, number, unit.
 * @param {string} tag the instrument or field name
 * @param {string} [unit] engineering unit
 * @param {string} [hint] title text
 * @returns {HTMLElement} the box, with `.set(text, modifier)` exposed
 */
export function readout(tag, unit, hint) {
  const v = h('span', { class: 'ro__val', text: '—' });
  const el = h('div', { class: 'ro', title: hint || '' },
    h('span', { class: 'ro__tag', text: tag }),
    h('span', { class: 'ro__row' }, v, unit ? h('span', { class: 'ro__unit', text: unit }) : null));
  el.set = (text, mod) => {
    setText(v, text);
    cls(v, 'is-warn', mod === 'warn');
    cls(v, 'is-alarm', mod === 'alarm');
    cls(v, 'is-off', mod === 'off');
  };
  return el;
}
