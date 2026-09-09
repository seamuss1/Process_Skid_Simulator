/**
 * sw.js — the service worker: the whole trainer, cached, so it runs with the wifi off.
 *
 * Layer: none. This file is not part of the module graph — the browser runs it in a worker of its
 * own, `src/ui/pwa.js` is the page side of the conversation, and the two speak only through
 * `postMessage`. It is deliberately the ONLY file in the repository that is not an ES module: a
 * module service worker (`register(url, { type: 'module' })`) is still unsupported in Firefox, and
 * a training tool that loses offline support on one of the three browsers a plant might have
 * standardised on is not offline-capable at all. Classic worker, no imports, no build step.
 *
 * -----------------------------------------------------------------------------------------------
 * WHAT GETS PRECACHED, AND WHY IT IS DISCOVERED AT RUNTIME
 * -----------------------------------------------------------------------------------------------
 * With no build step there are two honest ways to know the file list:
 *
 *   (a) Ship an explicit manifest that a script in `tools/` regenerates by scanning the sources.
 *   (b) Enumerate what the first load ACTUALLY fetched and cache exactly that.
 *
 * This worker takes (b). (a) was rejected for one concrete reason and one practical one:
 *
 *   · `src/ui/app.js` builds its views from a registry of `import()` specifiers, and more arrive
 *     with every view added. A static scanner has to resolve dynamic imports to be correct, and
 *     where it guesses wrong the generated list is SILENTLY SHORT. A short precache list does not
 *     fail at commit time or in review — it fails weeks later, on a plant network, offline, in
 *     front of a trainee. That is the worst possible place to discover it.
 *   · A generated list must also be re-run and committed by hand on every file added or renamed.
 *     Nothing enforces it, so it drifts, and the drift is invisible until it matters.
 *
 * Runtime enumeration cannot drift, because the list IS what the browser loaded. Its own cost is
 * real and worth stating: a view never opened while online is not in the cache when the network
 * goes away. `src/ui/pwa.js` covers that from the page side — it watches for newly loaded
 * resources and sends them here as they appear, and it accepts a list of view module URLs to warm
 * deliberately. The seed list below is only what a COLD start needs before any of that can run.
 *
 * -----------------------------------------------------------------------------------------------
 * THE UPDATE FLOW
 * -----------------------------------------------------------------------------------------------
 * This worker never calls `skipWaiting()` on its own. A new version that activated itself would
 * swap modules underneath a simulation someone is in the middle of running — a half-updated page
 * whose next dynamic import comes from a different build than the code asking for it. So a new
 * worker installs, waits, the page is told, and the OPERATOR decides when to take it. The only
 * route to `skipWaiting()` is an explicit SKIP_WAITING message, which `pwa.js` sends when the
 * button is pressed.
 *
 * BUMP `SW_VERSION` WHEN YOU SHIP. The browser only looks for a new worker when the bytes of this
 * file change, and the cache is keyed by that version, so a release that edits modules but leaves
 * this file alone will keep serving the old modules from the cache forever.
 */

'use strict';

/** Cache version. Bump on every release: this is what triggers the update and the eviction. */
const SW_VERSION = '1.0.0';

/** Every cache this worker has ever owned starts with this. Nothing else is ours to delete. */
const CACHE_PREFIX = 'skid-shell-';

/** The cache in use right now. */
const CACHE_NAME = CACHE_PREFIX + SW_VERSION;

/** How many URLs one precache message may carry. A bound, so a bad message cannot fan out. */
const PRECACHE_LIMIT = 600;

/** Where `self.location` is not available (the tests evaluate this file in a sandbox). */
const BASE = (typeof self !== 'undefined' && self.location && self.location.href)
  || 'http://localhost:8080/sw.js';

/**
 * Resolve a scope-relative path against this worker's own location.
 * @param {string} p a relative path, e.g. './index.html'
 * @returns {string} the absolute URL
 */
function scopeUrl(p) {
  return new URL(p, BASE).href;
}

/** The document every navigation is answered with — this is a single-page application. */
const DOC_URL = scopeUrl('./index.html');

/** This worker's own URL. Never cached: a cached worker could outlive its own replacement. */
const SELF_URL = scopeUrl('./sw.js');

/**
 * The cold-start seed. Not the file list — the file list is discovered (see the header). These are
 * the handful of URLs that must be present for the page to boot at all and then ask for the rest.
 */
const SHELL = Object.freeze([
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/app.css',
  './src/ui/app.js',
]);

// ------------------------------------------------------------------------------------------------
// PURE HELPERS — no I/O, no globals beyond the constants above. These are what tests/pwa.test.js
// exercises; everything below them is the plumbing that calls them.
// ------------------------------------------------------------------------------------------------

/**
 * The cache name for a version string.
 * @param {string} version the version, e.g. '1.0.0'
 * @returns {string} the cache name
 */
function cacheNameFor(version) {
  return CACHE_PREFIX + String(version);
}

/**
 * Whether a cache name belongs to this worker. Guards the eviction pass: a browser profile holds
 * caches from other applications on the same origin, and deleting one of those would be theft.
 * @param {string} name a cache name from `caches.keys()`
 * @returns {boolean} true when it is ours
 */
function isManagedCache(name) {
  return typeof name === 'string' && name.startsWith(CACHE_PREFIX);
}

/**
 * Which caches the activate pass should delete: ours, minus the one in use.
 * @param {string[]} names every cache name on the origin
 * @param {string} [keep] the cache to preserve; defaults to the current one
 * @returns {string[]} the names to delete, in the order given
 */
function staleCacheNames(names, keep) {
  const current = keep === undefined ? CACHE_NAME : keep;
  if (!Array.isArray(names)) return [];
  return names.filter((n) => isManagedCache(n) && n !== current);
}

/**
 * The cache key for a request. Navigations all collapse onto the one document, so a deep link
 * carrying `?seed=...` is not stored as a second copy of the shell, and the fragment never is:
 * the server has never seen it and it identifies nothing on disk.
 * @param {string} url the request URL
 * @param {string} [mode] the request mode; 'navigate' collapses to the document
 * @returns {string} the key to read and write the cache with
 */
function cacheKeyFor(url, mode) {
  if (mode === 'navigate') return DOC_URL;
  const u = new URL(url, BASE);
  u.hash = '';
  return u.href;
}

/**
 * Whether this worker should answer a request at all. Everything else is handed straight back to
 * the browser untouched — which is the right answer for a POST, for another origin, and for the
 * worker script itself.
 * @param {string} method the HTTP method
 * @param {string} url the request URL
 * @param {string} [origin] the origin to treat as ours; defaults to this worker's
 * @returns {boolean} true when the fetch handler should respond
 */
function shouldHandle(method, url, origin) {
  if (method !== 'GET') return false;
  const home = origin === undefined ? new URL(BASE).origin : origin;
  let u;
  try { u = new URL(url, BASE); } catch { return false; }
  if (u.origin !== home) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (cacheKeyFor(u.href) === SELF_URL) return false;
  return true;
}

/**
 * Clean a precache list arriving from the page. The page is ours, but a message is still input:
 * it is filtered to same-origin http(s) URLs, stripped of fragments, deduped and bounded, so no
 * message can make this worker fetch another origin or open ten thousand requests.
 * @param {*} urls the candidate list, of any shape
 * @param {string} [origin] the origin to accept; defaults to this worker's
 * @returns {string[]} absolute URLs, deduped, sorted, at most {@link PRECACHE_LIMIT} of them
 */
function sanitizePrecache(urls, origin) {
  if (!Array.isArray(urls)) return [];
  const home = origin === undefined ? new URL(BASE).origin : origin;
  const out = new Set();
  for (const raw of urls) {
    if (typeof raw !== 'string' || !raw) continue;
    let u;
    try { u = new URL(raw, BASE); } catch { continue; }
    if (u.origin !== home) continue;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    if (u.href === SELF_URL) continue;
    out.add(u.href);
    if (out.size >= PRECACHE_LIMIT) break;
  }
  return [...out].sort();
}

// ------------------------------------------------------------------------------------------------
// CACHE WORK
// ------------------------------------------------------------------------------------------------

/**
 * Fetch and store every URL not already held. Failures are counted, never thrown: one missing file
 * must not fail an install and leave the whole application uncached.
 * @param {string[]} urls candidate URLs, sanitized inside
 * @returns {Promise<{ok: boolean, stored: number, present: number, missed: number, total: number}>}
 *   what happened, for the page's console
 */
async function precache(urls) {
  const targets = sanitizePrecache(urls);
  const cache = await caches.open(CACHE_NAME);
  let stored = 0;
  let present = 0;
  let missed = 0;
  await Promise.all(targets.map(async (url) => {
    try {
      if (await cache.match(url)) { present += 1; return; }
      // `cache: 'reload'` bypasses the browser's HTTP cache. Without it a precache can store the
      // very stale copy the update was meant to replace, and then serve it for a whole version.
      const res = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      if (!res || !res.ok) { missed += 1; return; }
      await cache.put(url, res);
      stored += 1;
    } catch {
      missed += 1;
    }
  }));
  return { ok: true, stored, present, missed, total: targets.length };
}

/**
 * Delete every cache this worker owns except the current one.
 * @param {string} [keep] the cache to preserve; defaults to the current one
 * @returns {Promise<string[]>} the names deleted
 */
async function evictStaleCaches(keep) {
  const names = await caches.keys();
  const doomed = staleCacheNames(names, keep);
  await Promise.all(doomed.map((n) => caches.delete(n)));
  return doomed;
}

/**
 * Delete every cache this worker owns, including the current one. The page offers this as the way
 * out when a developer wants the network back without hunting through browser settings.
 * @returns {Promise<string[]>} the names deleted
 */
async function purgeCaches() {
  const names = (await caches.keys()).filter(isManagedCache);
  await Promise.all(names.map((n) => caches.delete(n)));
  return names;
}

/**
 * The body served when a request misses the cache and the network is gone. Deliberately plain
 * text: whatever asked for it is a module, a stylesheet or an image, and none of them can render
 * an apology — but a developer reading the network panel can.
 * @param {string} url what was asked for
 * @returns {Response} a 504
 */
function offlineResponse(url) {
  return new Response(
    `Offline, and ${url} was never cached. Open this view once while connected and it will be.`,
    { status: 504, statusText: 'Offline', headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}

/**
 * Answer one request: cache first, always. Nothing here is network-first because there is no
 * network component to be fresh about — every URL is a static file of a fixed build, and the
 * build only changes when a new worker version says so.
 * @param {FetchEvent} event the fetch event
 * @returns {Promise<Response>} the response
 */
async function serve(event) {
  const req = event.request;
  const key = cacheKeyFor(req.url, req.mode);
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(key);
  if (hit) return hit;

  try {
    const res = await fetch(req);
    // Only whole, successful, same-origin responses are worth storing. A 404 cached would be a
    // 404 forever, and an opaque cross-origin response cannot be validated at all.
    if (res && res.ok && res.status === 200 && res.type !== 'opaque') {
      const copy = res.clone();
      event.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return res;
  } catch {
    // The network is gone. A navigation still gets the shell — the application boots from cache
    // and its own state, and that is the entire point of this file.
    if (req.mode === 'navigate') {
      const shell = await cache.match(DOC_URL);
      if (shell) return shell;
    }
    return offlineResponse(req.url);
  }
}

// ------------------------------------------------------------------------------------------------
// LIFECYCLE
// ------------------------------------------------------------------------------------------------

/**
 * Install: seed the cache. No `skipWaiting()` — see the header.
 * @param {ExtendableEvent} event the install event
 * @returns {void}
 */
function onInstall(event) {
  event.waitUntil(precache(SHELL.map(scopeUrl)));
}

/**
 * Activate: drop the previous version's cache, then take control of open pages so the first load
 * is already offline-capable. Claiming is safe here in a way `skipWaiting()` is not — the modules
 * a running page has already imported stay exactly as they are.
 * @param {ExtendableEvent} event the activate event
 * @returns {void}
 */
function onActivate(event) {
  event.waitUntil((async () => {
    await evictStaleCaches();
    if (self.clients && self.clients.claim) await self.clients.claim();
  })());
}

/**
 * Fetch: cache-first for anything of ours, untouched for everything else.
 * @param {FetchEvent} event the fetch event
 * @returns {void}
 */
function onFetch(event) {
  const req = event.request;
  if (!shouldHandle(req.method, req.url)) return;
  // A ranged request wants a slice; a cached whole response is the wrong answer to it and some
  // browsers reject the mismatch outright. Let the network handle those.
  if (req.headers && req.headers.get && req.headers.get('range')) return;
  event.respondWith(serve(event));
}

/**
 * Message: the page side of the update and precache conversation.
 * @param {ExtendableMessageEvent} event the message event
 * @returns {void}
 */
function onMessage(event) {
  const data = (event && event.data) || {};
  const port = event && event.ports && event.ports[0];
  /**
   * Reply down the message port, when the page opened one.
   * @param {object} msg the reply
   * @returns {void}
   */
  const reply = (msg) => { if (port && port.postMessage) port.postMessage(msg); };

  switch (data.type) {
    case 'SKIP_WAITING':
      // The only path to an activation. Reached only by the operator pressing the button.
      reply({ ok: true, type: 'SKIPPING', version: SW_VERSION });
      event.waitUntil(self.skipWaiting());
      return;

    case 'PRECACHE':
      event.waitUntil(precache(data.urls).then(
        (r) => reply({ type: 'PRECACHED', ...r }),
        (err) => reply({ ok: false, type: 'PRECACHED', reason: String((err && err.message) || err) }),
      ));
      return;

    case 'VERSION':
      reply({ ok: true, type: 'VERSION', version: SW_VERSION, cache: CACHE_NAME });
      return;

    case 'PURGE':
      event.waitUntil(purgeCaches().then(
        (names) => reply({ ok: true, type: 'PURGED', deleted: names }),
        (err) => reply({ ok: false, type: 'PURGED', reason: String((err && err.message) || err) }),
      ));
      return;

    default:
      reply({ ok: false, reason: `unknown message type ${JSON.stringify(data.type ?? null)}` });
  }
}

// ------------------------------------------------------------------------------------------------
// WIRING — guarded, so evaluating this file outside a worker (the tests) defines but does not run.
// ------------------------------------------------------------------------------------------------

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('install', onInstall);
  self.addEventListener('activate', onActivate);
  self.addEventListener('fetch', onFetch);
  self.addEventListener('message', onMessage);

  /**
   * The test seam. `tests/pwa.test.js` evaluates this file in a `node:vm` context holding a fake
   * worker global and reads the helpers from here — the only way to unit-test a classic worker,
   * which by definition cannot export anything. Harmless in the browser: one extra property on a
   * global no page can reach.
   */
  self.__sw = Object.freeze({
    SW_VERSION,
    CACHE_PREFIX,
    CACHE_NAME,
    PRECACHE_LIMIT,
    SHELL,
    DOC_URL,
    SELF_URL,
    cacheNameFor,
    isManagedCache,
    staleCacheNames,
    cacheKeyFor,
    shouldHandle,
    sanitizePrecache,
    precache,
    evictStaleCaches,
    purgeCaches,
    serve,
    onInstall,
    onActivate,
    onFetch,
    onMessage,
  });
}
