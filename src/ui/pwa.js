/**
 * src/ui/pwa.js — the page side of offline: registration, the precache census, the update prompt,
 * the install affordance and the offline indicator.
 *
 * Layer L7, alongside `app.js`. Imports `./dom.js` and nothing else.
 *
 * WHY THIS EXISTS. The rig is a training tool, and the places people most want a training tool are
 * the places with the worst wifi: a plant floor, a substation, a contractor's site office on a
 * phone hotspot. The simulator itself never touches the network — every number it shows is
 * computed in the page — so the only thing standing between it and a plant network is whether the
 * files are on the machine. `sw.js` puts them there. This file is what talks to it.
 *
 * WHAT IT MUST NEVER DO. It must never break boot. Service workers are absent in a private window
 * in some browsers, absent on `http://` from anything but localhost, and absent behind some
 * corporate policies — and none of that is an error worth showing an operator who only wants to
 * tune a loop. Every entry point below is guarded and returns `{ ok: false, reason }`; nothing
 * here throws, and nothing here is required for the simulator to run.
 *
 * AND IT MUST NEVER UPDATE ON ITS OWN. Taking a new version means reloading the page, which throws
 * away the run in progress: the trend, the score, the lesson someone is nine minutes into. So a
 * new version is ANNOUNCED and waits. The operator decides. See `createUpdateMachine`, whose whole
 * job is that there is no path from "a new version exists" to "the page reloaded" that does not
 * pass through a press of the button.
 */

import { h, setText, cls } from './dom.js';

/** The worker, resolved from this module rather than the page, so any page depth registers it. */
const SW_URL = new URL('../../sw.js', import.meta.url).href;

/** The scope the worker owns: the application root. */
const SW_SCOPE = new URL('../../', import.meta.url).href;

/** How long to wait for a worker to answer a message before giving up on the reply. */
const REPLY_TIMEOUT_MS = 5000;

/** How long to let newly-loaded resources accumulate before telling the worker about them. */
const SYNC_DEBOUNCE_MS = 2000;

/** The shortest gap between two update checks. Checking on every tab focus is rude to nobody's
 *  bandwidth here, but it is still pointless. */
const UPDATE_CHECK_MS = 15 * 60 * 1000;

/** Resource initiator types that are never worth caching. */
const SKIP_INITIATORS = Object.freeze(['beacon', 'ping']);

// ================================================================================================
// PURE PARTS — no DOM, no navigator, no I/O. Everything below is exercised by tests/pwa.test.js.
// ================================================================================================

/**
 * The states of the update flow.
 *
 * `ready` is the important one: a new version is downloaded, installed and WAITING, and the page
 * is still running the old one. Nothing leaves `ready` except the operator.
 */
export const PWA_STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  DISMISSED: 'dismissed',
  APPLYING: 'applying',
  RELOADING: 'reloading',
  FAILED: 'failed',
});

/**
 * The events the flow accepts.
 *
 * `INSTALLED` and `INSTALLED_FIRST` are deliberately different events for the same worker state.
 * A worker that installed while a previous one was controlling the page is an UPDATE and must be
 * announced; a worker that installed when nothing was controlling the page is the FIRST install,
 * which changes nothing about the running page and must stay silent. Conflating the two is how a
 * PWA ends up telling a first-time visitor that an update is available.
 */
export const PWA_EVENTS = Object.freeze({
  CHECK: 'check',
  NONE: 'none',
  FOUND: 'found',
  INSTALLED: 'installed',
  INSTALLED_FIRST: 'installedFirst',
  APPLY: 'apply',
  ACTIVATED: 'activated',
  DISMISS: 'dismiss',
  ERROR: 'error',
  RESET: 'reset',
});

/**
 * The transition table. Absent pairs are refusals, not silent no-ops, so a wiring mistake shows up
 * as a reason in the console instead of a prompt that never appears.
 */
const TRANSITIONS = Object.freeze({
  idle: Object.freeze({
    check: 'checking', found: 'downloading', installed: 'ready', installedFirst: 'idle',
    error: 'failed',
  }),
  checking: Object.freeze({
    check: 'checking', none: 'idle', found: 'downloading', installed: 'ready',
    installedFirst: 'idle', error: 'failed',
  }),
  downloading: Object.freeze({
    installed: 'ready', installedFirst: 'idle', none: 'idle', error: 'failed',
  }),
  // The one state with no automatic exit. `activated` is NOT accepted here: a controller change
  // that arrives without the operator pressing anything is the first worker claiming the page, and
  // reloading on it would destroy a run for nothing.
  ready: Object.freeze({ apply: 'applying', dismiss: 'dismissed', error: 'failed' }),
  // Dismissed keeps the waiting worker. The operator can still take the update later.
  dismissed: Object.freeze({ apply: 'applying', check: 'dismissed', installed: 'dismissed', error: 'failed' }),
  applying: Object.freeze({ activated: 'reloading', error: 'failed' }),
  // Terminal: the page is on its way out.
  reloading: Object.freeze({}),
  failed: Object.freeze({ check: 'checking', reset: 'idle' }),
});

/**
 * Build the update state machine.
 *
 * @returns {{state: string, can: function(string):boolean, send: function(string):object,
 *   onChange: function(function(string, string):void):function():void}} the machine: `state` is
 *   the current state, `can` tests an event, `send` applies one and returns `{ ok, state }` or
 *   `{ ok: false, reason, state }`, and `onChange` subscribes and returns its own unsubscribe
 */
export function createUpdateMachine() {
  let state = PWA_STATES.IDLE;
  const listeners = new Set();

  const api = {
    get state() { return state; },

    /**
     * Whether an event is accepted in the current state.
     * @param {string} event one of {@link PWA_EVENTS}
     * @returns {boolean} true when `send` would succeed
     */
    can(event) {
      const row = TRANSITIONS[state];
      return !!(row && Object.prototype.hasOwnProperty.call(row, event));
    },

    /**
     * Apply an event.
     * @param {string} event one of {@link PWA_EVENTS}
     * @returns {{ok: boolean, state: string, from?: string, changed?: boolean, reason?: string}}
     *   the outcome; a refusal carries the reason and leaves the state alone
     */
    send(event) {
      const row = TRANSITIONS[state];
      if (!row || !Object.prototype.hasOwnProperty.call(row, event)) {
        return { ok: false, state, reason: `the update flow is ${state} and cannot ${event}` };
      }
      const from = state;
      state = row[event];
      const changed = state !== from;
      if (changed) for (const fn of listeners) { try { fn(state, from); } catch { /* a listener must not break the flow */ } }
      return { ok: true, state, from, changed };
    },

    /**
     * Subscribe to state changes.
     * @param {function(string, string):void} fn called with `(next, previous)`
     * @returns {function():void} the unsubscribe
     */
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}

/**
 * Whether this origin can host a service worker at all.
 *
 * Browsers allow them on https and on localhost only. Serving the repository from a workstation's
 * LAN address — which is exactly what someone does to show it to a room — is `http://10.x.x.x`,
 * where registration throws. Better to say so once than to let the exception escape into boot.
 *
 * @param {{protocol?: string, hostname?: string, href?: string}} location a `window.location`
 * @param {boolean} [isSecureContext] the browser's own verdict, when it has one
 * @returns {{ok: boolean, reason?: string}} whether to attempt registration
 */
export function isOfflineCapableOrigin(location, isSecureContext) {
  const loc = location || {};
  const protocol = String(loc.protocol || '');
  const host = String(loc.hostname || '');
  if (isSecureContext === true) return { ok: true };
  if (protocol === 'https:') return { ok: true };
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return { ok: true };
  if (protocol === 'file:') {
    return { ok: false, reason: 'opened from disk: serve the folder over http to run offline' };
  }
  return {
    ok: false,
    reason: `service workers need https (or localhost); this page is ${protocol}//${host}, so the`
      + ' offline copy cannot be installed. The simulator itself is unaffected.',
  };
}

/**
 * Build the precache list from what the browser actually loaded.
 *
 * This is the runtime half of the decision documented at the top of `sw.js`: rather than trust a
 * hand-maintained file list, ask the page what it fetched. `resources` is normally
 * `performance.getEntriesByType('resource')`, which by then holds every module of the static
 * graph, every stylesheet and every lazily imported view opened so far — the real answer, not a
 * guess at it.
 *
 * @param {object} input the census
 * @param {string} input.origin the origin to keep; everything else is dropped
 * @param {string} [input.documentUrl] the page itself, normalized and included first
 * @param {Array<string|{name?: string, initiatorType?: string}>} [input.resources] loaded
 *   resources, as strings or `PerformanceResourceTiming`-shaped records
 * @param {string[]} [input.extra] URLs to cache whether or not they were loaded, e.g. the view
 *   modules nobody has opened yet
 * @param {string[]} [input.ignore] substrings; any URL containing one is dropped
 * @param {number} [input.limit] the cap, default 600
 * @returns {string[]} absolute same-origin URLs, deduped, fragment-free and sorted, so the same
 *   census always produces the same list and the "have I sent this already" check is cheap
 */
export function buildPrecacheList(input) {
  const src = input || {};
  const origin = typeof src.origin === 'string' ? src.origin : '';
  if (!origin) return [];
  const base = typeof src.documentUrl === 'string' && src.documentUrl ? src.documentUrl : `${origin}/`;
  const ignore = Array.isArray(src.ignore) ? src.ignore.filter((x) => typeof x === 'string') : [];
  const limit = Number.isFinite(src.limit) && src.limit > 0 ? Math.floor(src.limit) : 600;
  const out = new Set();

  /**
   * Normalize one candidate and keep it when it is ours.
   * @param {string|{name?: string, initiatorType?: string}} item a URL or a timing record
   * @returns {void}
   */
  function take(item) {
    if (!item) return;
    const url = typeof item === 'string' ? item : item.name;
    if (typeof url !== 'string' || !url) return;
    if (typeof item !== 'string' && SKIP_INITIATORS.includes(item.initiatorType)) return;
    let u;
    try { u = new URL(url, base); } catch { return; }
    // data:, blob: and another origin's CDN are all things this worker must not try to own.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.origin !== origin) return;
    u.hash = '';
    // The worker script is the browser's to manage. Caching it would let a stale copy answer the
    // update check, which is the one request that must always reach the server.
    if (u.pathname.endsWith('/sw.js')) return;
    const href = u.href;
    for (const bad of ignore) if (href.includes(bad)) return;
    out.add(href);
  }

  if (typeof src.documentUrl === 'string' && src.documentUrl) {
    // The document is stored under its bare path: a deep link carrying `?seed=...` is the same
    // shell, and caching one copy per query string would fill the cache with duplicates.
    try {
      const doc = new URL(src.documentUrl, base);
      doc.hash = '';
      doc.search = '';
      take(doc.href);
    } catch { /* an unparseable document URL simply is not added */ }
  }
  if (Array.isArray(src.resources)) for (const r of src.resources) take(r);
  if (Array.isArray(src.extra)) for (const e of src.extra) take(e);

  return [...out].sort().slice(0, limit);
}

// ================================================================================================
// THE PAGE CHROME
//
// These rules would live in styles/app.css if this module owned it. They are injected once, from
// one <style> element, and every value in them resolves through a token — so the strip follows the
// palette like everything else and there is not a single colour literal below.
// ================================================================================================

/** The stylesheet, injected once per document. */
const PWA_CSS = `
.pwa {
  position: fixed;
  left: var(--sp-8);
  bottom: var(--sp-9);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-5);
  max-width: 380px;
  font-family: var(--font-ui);
  font-size: var(--fs-11);
  color: var(--ink);
}
.pwa__net,
.pwa__install {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-6);
  background: var(--surface-raised);
  border: var(--border-edge);
  border-radius: var(--r-2);
  box-shadow: var(--elev-raised);
  color: var(--ink-2);
  font: inherit;
  letter-spacing: 0.02em;
}
.pwa__net { border-left: 3px solid var(--warn); color: var(--warn-ink); }
.pwa__net.is-note { border-left-color: var(--ok); color: var(--ok-ink); }
.pwa__install { cursor: pointer; color: var(--ink); }
.pwa__install:hover { background: var(--hover-tint); }
.pwa__update {
  padding: var(--sp-6) var(--sp-7);
  background: var(--panel-hi);
  border: var(--border-edge);
  border-left: 3px solid var(--accent);
  border-radius: var(--r-2);
  box-shadow: var(--elev-float);
}
.pwa__title { display: block; margin-bottom: var(--sp-4); font-size: var(--fs-12); }
.pwa__body { margin: 0 0 var(--sp-6); color: var(--ink-2); line-height: 1.45; }
.pwa__row { display: flex; gap: var(--sp-5); }
.pwa__btn {
  padding: var(--sp-4) var(--sp-7);
  background: var(--surface-raised);
  border: var(--border-edge);
  border-radius: var(--r-2);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.pwa__btn--go { border-color: var(--accent); color: var(--accent-ink); }
.pwa__btn:hover { background: var(--hover-tint); }
`;

/**
 * Inject the stylesheet once.
 * @param {Document} doc the document
 * @returns {void}
 */
function ensureStyle(doc) {
  if (doc.getElementById('pwa-style')) return;
  const style = doc.createElement('style');
  style.id = 'pwa-style';
  style.textContent = PWA_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

/**
 * Build the strip: the offline indicator, the install chip and the update prompt.
 *
 * The prompt is `aria-live="polite"` and never takes focus. Someone mid-step-test has their hands
 * on the controller; stealing the caret to announce a new build would be the software equivalent
 * of tapping an operator on the shoulder during a startup.
 *
 * @param {Document} doc the document
 * @param {{onApply: function():void, onDismiss: function():void, onInstall: function():void}} on
 *   the three actions
 * @returns {{el: HTMLElement, setOnline: function(boolean):void, note: function(string):void,
 *   setUpdate: function(boolean):void, setInstall: function(boolean):void}} the strip
 */
function createChrome(doc, on) {
  ensureStyle(doc);

  const net = h('span', { class: 'pwa__net', role: 'status', 'aria-live': 'polite', hidden: true });
  const install = h('button', {
    class: 'pwa__install', type: 'button', hidden: true,
    title: 'Install the trainer as an application, so it opens without a browser and runs offline',
    onClick: () => on.onInstall(),
  }, '⤓ Install this trainer');

  const update = h('div', { class: 'pwa__update', role: 'status', 'aria-live': 'polite', hidden: true },
    h('b', { class: 'pwa__title', text: 'A new version is ready' }),
    h('p', {
      class: 'pwa__body',
      text: 'It is downloaded and waiting. Loading it reloads the page, which ends the run in'
        + ' progress — so it will wait here until you are between runs.',
    }),
    h('div', { class: 'pwa__row' },
      h('button', { class: 'pwa__btn pwa__btn--go', type: 'button', text: 'Load it now', onClick: () => on.onApply() }),
      h('button', { class: 'pwa__btn', type: 'button', text: 'Not now', onClick: () => on.onDismiss() })));

  const el = h('div', { class: 'pwa' }, update, install, net);
  let noteTimer = 0;

  return {
    el,

    /**
     * Show or hide the offline indicator.
     * @param {boolean} online whether the browser thinks it has a network
     * @returns {void}
     */
    setOnline(online) {
      if (noteTimer) return;
      cls(net, 'is-note', false);
      net.hidden = !!online;
      if (!online) setText(net, 'OFFLINE — running from the cached copy');
    },

    /**
     * Show a passing message in the indicator slot, then restore it.
     * @param {string} msg the message
     * @returns {void}
     */
    note(msg) {
      setText(net, msg);
      cls(net, 'is-note', true);
      net.hidden = false;
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        noteTimer = 0;
        cls(net, 'is-note', false);
        net.hidden = true;
      }, 6000);
    },

    /**
     * Show or hide the update prompt.
     * @param {boolean} show whether a version is waiting
     * @returns {void}
     */
    setUpdate(show) { update.hidden = !show; },

    /**
     * Show or hide the install chip.
     * @param {boolean} show whether the browser has offered an install
     * @returns {void}
     */
    setInstall(show) { install.hidden = !show; },
  };
}

/**
 * Ask a worker something and wait for its reply, with a timeout so a worker that never answers
 * does not leak a pending promise per call.
 * @param {ServiceWorker} worker the target
 * @param {object} msg the message
 * @param {typeof MessageChannel} Channel the MessageChannel constructor
 * @returns {Promise<object>} the reply, or `{ ok: false, reason }` on timeout
 */
function ask(worker, msg, Channel) {
  return new Promise((resolve) => {
    let done = false;
    /**
     * Resolve once.
     * @param {object} v the value
     * @returns {void}
     */
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = new Channel();
      ch.port1.onmessage = (ev) => settle(ev.data);
      worker.postMessage(msg, [ch.port2]);
      setTimeout(() => settle({ ok: false, reason: 'the worker did not answer' }), REPLY_TIMEOUT_MS);
    } catch (err) {
      settle({ ok: false, reason: String((err && err.message) || err) });
    }
  });
}

// ================================================================================================
// THE ENTRY POINT
// ================================================================================================

/**
 * Start the offline layer.
 *
 * Safe to call anywhere, on anything: with no service worker, on a plain-http LAN address, in a
 * unit test with no DOM at all, it returns a refusal and touches nothing. It never throws.
 *
 * @param {object} [options] options
 * @param {string[]} [options.extraUrls] modules to cache even though nothing has loaded them yet —
 *   hand it the view registry's `import()` specifiers and every view is available offline, not
 *   only the ones someone happened to open
 * @param {string[]} [options.ignore] substrings; any URL containing one is never cached
 * @param {Window} [options.window] the window, for tests
 * @param {Document} [options.document] the document, for tests
 * @param {Navigator} [options.navigator] the navigator, for tests
 * @returns {{ok: boolean, reason?: string, machine?: object, checkForUpdate?: function():void,
 *   applyUpdate?: function():object, syncPrecache?: function():void, dispose?: function():void}}
 *   the controls, or a refusal carrying why offline is not available here
 */
export function initPwa(options) {
  const opt = options || {};
  const win = opt.window || (typeof window !== 'undefined' ? window : null);
  const doc = opt.document || (typeof document !== 'undefined' ? document : null);
  const nav = opt.navigator || (win && win.navigator) || null;

  if (!win || !doc || !nav) return { ok: false, reason: 'no browser here: the offline layer is inert' };
  if (!('serviceWorker' in nav)) {
    return { ok: false, reason: 'this browser has no service worker; the trainer runs, it just will not run offline' };
  }
  const site = isOfflineCapableOrigin(win.location, win.isSecureContext);
  if (!site.ok) return site;

  try {
    // An escape hatch that costs nothing to carry: `?nosw` tears the whole thing down. Cache-first
    // is exactly wrong while you are editing the module it is serving, and a developer who has hit
    // that should not have to go hunting through browser settings to get out of it.
    if (String(win.location.search || '').includes('nosw')) {
      nav.serviceWorker.getRegistrations().then((regs) => {
        for (const r of regs) r.unregister();
      }).catch(() => {});
      if (win.caches && win.caches.keys) {
        win.caches.keys().then((names) => {
          for (const n of names) if (n.startsWith('skid-shell-')) win.caches.delete(n);
        }).catch(() => {});
      }
      return { ok: false, reason: '?nosw — the offline copy has been unregistered and its caches dropped' };
    }

    const machine = createUpdateMachine();
    let registration = null;
    let installEvent = null;
    let reloading = false;
    let lastCheck = 0;
    let syncTimer = 0;
    let announced = false;
    /** Every URL already handed to the worker, so a resync sends only the new ones. */
    const sent = new Set();

    /**
     * Take the waiting update. The only route from "a new version exists" to a reload.
     * @returns {{ok: boolean, reason?: string, state?: string}} the outcome
     */
    function applyUpdate() {
      const waiting = registration && registration.waiting;
      if (!waiting) return { ok: false, reason: 'nothing is waiting: there is no update to take' };
      const step = machine.send(PWA_EVENTS.APPLY);
      if (!step.ok) return step;
      chrome.setUpdate(false);
      waiting.postMessage({ type: 'SKIP_WAITING' });
      return { ok: true, state: machine.state };
    }

    /**
     * Dismiss the prompt, keeping the update for later.
     * @returns {void}
     */
    function dismissUpdate() {
      machine.send(PWA_EVENTS.DISMISS);
      chrome.setUpdate(false);
    }

    /**
     * Run the browser's install flow, if it offered one.
     * @returns {void}
     */
    function runInstall() {
      const ev = installEvent;
      installEvent = null;
      chrome.setInstall(false);
      if (!ev || typeof ev.prompt !== 'function') return;
      try {
        ev.prompt();
        if (ev.userChoice && typeof ev.userChoice.then === 'function') {
          ev.userChoice.then((choice) => {
            if (choice && choice.outcome !== 'accepted') chrome.setInstall(true);
          }).catch(() => {});
        }
      } catch { /* a browser that offered the event and then refused it is not our problem */ }
    }

    const chrome = createChrome(doc, { onApply: applyUpdate, onDismiss: dismissUpdate, onInstall: runInstall });
    (doc.body || doc.documentElement).appendChild(chrome.el);
    chrome.setOnline(nav.onLine !== false);

    machine.onChange((state) => { chrome.setUpdate(state === PWA_STATES.READY); });

    /**
     * Tell the worker about everything this page has loaded since the last time.
     * @returns {void}
     */
    function syncPrecache() {
      const perf = win.performance;
      const resources = perf && perf.getEntriesByType ? perf.getEntriesByType('resource') : [];
      const all = buildPrecacheList({
        origin: win.location.origin,
        documentUrl: win.location.href,
        resources,
        extra: Array.isArray(opt.extraUrls) ? opt.extraUrls : [],
        ignore: Array.isArray(opt.ignore) ? opt.ignore : [],
      });
      const fresh = all.filter((u) => !sent.has(u));
      if (!fresh.length) return;
      nav.serviceWorker.ready.then((reg) => {
        const worker = reg.active || nav.serviceWorker.controller;
        if (!worker) return;
        for (const u of fresh) sent.add(u);
        ask(worker, { type: 'PRECACHE', urls: fresh }, win.MessageChannel).then((res) => {
          // Say it once, the first time the application is genuinely on the machine. After that
          // it is noise: nobody needs to be told at every load that the files are still there.
          if (!announced && res && res.ok && (res.stored || 0) > 0) {
            announced = true;
            chrome.note(`Ready to run offline · ${res.stored + (res.present || 0)} files cached`);
          }
        });
      }).catch(() => {});
    }

    /**
     * Batch the census: a lazily imported view drags in several modules at once, and one message
     * per module would be several round trips for one click.
     * @returns {void}
     */
    function scheduleSync() {
      if (syncTimer) return;
      syncTimer = setTimeout(() => { syncTimer = 0; syncPrecache(); }, SYNC_DEBOUNCE_MS);
    }

    /**
     * Ask the server whether a new worker exists.
     * @param {boolean} [force] check even if one was run recently
     * @returns {void}
     */
    function checkForUpdate(force) {
      if (!registration) return;
      const now = Date.now();
      if (!force && now - lastCheck < UPDATE_CHECK_MS) return;
      lastCheck = now;
      machine.send(PWA_EVENTS.CHECK);
      registration.update().then(() => {
        if (!registration.installing && !registration.waiting) machine.send(PWA_EVENTS.NONE);
      }).catch(() => { machine.send(PWA_EVENTS.NONE); });
    }

    /**
     * Watch one worker until it finishes installing.
     * @param {ServiceWorker} worker the installing worker
     * @returns {void}
     */
    function watchInstall(worker) {
      if (!worker) return;
      machine.send(PWA_EVENTS.FOUND);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') {
          // A controller already present means this is a replacement, not a first install.
          machine.send(nav.serviceWorker.controller ? PWA_EVENTS.INSTALLED : PWA_EVENTS.INSTALLED_FIRST);
        } else if (worker.state === 'redundant') {
          machine.send(PWA_EVENTS.ERROR);
        }
      });
    }

    const onOnline = () => chrome.setOnline(true);
    const onOffline = () => chrome.setOnline(false);
    const onVisible = () => { if (doc.visibilityState === 'visible') checkForUpdate(false); };
    const onBeforeInstall = (ev) => {
      // Suppress the browser's own bar and offer the install where the rest of the chrome lives.
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      installEvent = ev;
      chrome.setInstall(true);
    };
    const onInstalled = () => { installEvent = null; chrome.setInstall(false); };
    const onController = () => {
      // A controller change we did not ask for is the first worker claiming this page. Reloading
      // on it would end a run to gain nothing: the modules already in memory are the same ones.
      if (machine.state !== PWA_STATES.APPLYING) return;
      machine.send(PWA_EVENTS.ACTIVATED);
      if (reloading) return;
      reloading = true;
      win.location.reload();
    };

    win.addEventListener('online', onOnline);
    win.addEventListener('offline', onOffline);
    win.addEventListener('beforeinstallprompt', onBeforeInstall);
    win.addEventListener('appinstalled', onInstalled);
    doc.addEventListener('visibilitychange', onVisible);
    nav.serviceWorker.addEventListener('controllerchange', onController);

    let observer = null;
    if (typeof win.PerformanceObserver === 'function') {
      try {
        // This is what makes runtime enumeration keep up with a lazily loaded application: the
        // moment a view's module arrives, it goes into the census and then into the cache.
        observer = new win.PerformanceObserver(() => scheduleSync());
        observer.observe({ type: 'resource', buffered: true });
      } catch { observer = null; }
    }

    nav.serviceWorker.register(SW_URL, { scope: SW_SCOPE, updateViaCache: 'none' }).then((reg) => {
      registration = reg;
      lastCheck = Date.now();
      // A worker that finished installing while the page was closed is already waiting here.
      if (reg.waiting && nav.serviceWorker.controller) machine.send(PWA_EVENTS.INSTALLED);
      if (reg.installing) watchInstall(reg.installing);
      reg.addEventListener('updatefound', () => watchInstall(reg.installing));
      scheduleSync();
    }).catch((err) => {
      // Registration can fail for reasons that are none of the operator's business — a policy, a
      // private window, a stale worker in a bad state. The simulator does not depend on it.
      machine.send(PWA_EVENTS.ERROR);
      if (win.console && win.console.info) {
        win.console.info(`offline mode unavailable: ${(err && err.message) || err}`);
      }
    });

    /**
     * Detach everything. Nothing in the shipped application calls this; it exists so a test or a
     * future embedding can unwind cleanly instead of leaking listeners onto the window.
     * @returns {void}
     */
    function dispose() {
      win.removeEventListener('online', onOnline);
      win.removeEventListener('offline', onOffline);
      win.removeEventListener('beforeinstallprompt', onBeforeInstall);
      win.removeEventListener('appinstalled', onInstalled);
      doc.removeEventListener('visibilitychange', onVisible);
      nav.serviceWorker.removeEventListener('controllerchange', onController);
      if (observer) observer.disconnect();
      if (syncTimer) clearTimeout(syncTimer);
      chrome.el.remove();
    }

    return { ok: true, machine, checkForUpdate, applyUpdate, syncPrecache, dispose };
  } catch (err) {
    // Belt and braces. Boot must survive anything this file can do wrong.
    return { ok: false, reason: `offline layer failed to start: ${(err && err.message) || err}` };
  }
}
