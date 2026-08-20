/* sw.js — app-shell service worker.

   Scope is this file's own directory (app/), which deliberately EXCLUDES
   /data/: trip JSON is the app layer's business and is cached in IndexedDB by
   js/data.js, not here. Requests that reach this worker for /data/ are passed
   straight through to the network anyway, belt and braces.

   Bumping: change VERSION. The cache name carries it, install precaches the new
   shell, and activate deletes every other wayfeather-shell-* cache. */

const VERSION = "v1";
const CACHE = "wayfeather-shell-" + VERSION;
const PREFIX = "wayfeather-shell-";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",

  "./css/tokens.css",
  "./css/app.css",

  "./js/main.js",
  "./js/dom.js",
  "./js/time.js",
  "./js/icons.js",
  "./js/links.js",
  "./js/trip.js",
  "./js/data.js",
  "./js/state.js",
  "./js/session.js",
  "./js/router.js",
  "./js/chrome.js",
  "./js/toast.js",
  "./js/confetti.js",
  "./js/sheets.js",
  "./js/ptr.js",
  "./js/forms.js",
  "./js/views/card.js",
  "./js/views/daystrip.js",
  "./js/views/itinerary.js",
  "./js/views/map.js",
  "./js/views/trips.js",
  "./js/views/settings.js",

  "./icons/icon.svg",
  "./icons/icon-square.svg",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // added one at a time: cache.addAll() rejects the whole install if a single
    // entry 404s, which would leave the app with no worker at all
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/data/") !== -1) return;    // network-only, always

  // A navigation to any URL in scope (?trip=…, #map) is the same shell.
  if (req.mode === "navigate") {
    event.respondWith(shellFirst(event, "./index.html", req, { ignoreSearch: true }));
    return;
  }

  // Cache-first for shell assets; anything unknown goes to the network and is
  // NOT written to the cache — the precache list is the whole shell, on purpose.
  event.respondWith(shellFirst(event, req, req, { ignoreSearch: false }));
});

/* Cache-first, with a quiet background re-fetch of the cached copy.

   The response ALWAYS comes from the cache when there is one, so offline and
   cold-start behaviour are exactly cache-first. The background revalidation
   exists so that forgetting to bump VERSION on a deploy costs one extra launch
   instead of pinning both phones to a stale app forever. */
async function shellFirst(event, cacheKey, req, opts) {
  const cached = await caches.match(cacheKey, opts);
  if (cached) {
    event.waitUntil((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-cache" });
        if (fresh && fresh.ok) (await caches.open(CACHE)).put(cacheKey, fresh.clone());
      } catch (e) { /* offline: keep what we have */ }
    })());
    return cached;
  }
  try { return await fetch(req); }
  catch (e) { return Response.error(); }
}
