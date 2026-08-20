/* sw.js — app-shell service worker.

   Scope is this file's own directory (app/), which deliberately EXCLUDES
   /data/: trip JSON is the app layer's business and is cached in IndexedDB by
   js/data.js, not here. Requests that reach this worker for /data/ are passed
   straight through to the network anyway, belt and braces.

   Bumping: change VERSION. The cache name carries it, install precaches the new
   shell, and activate deletes every other wayfeather-shell-* cache. */

/* v6 (2026-08-20, M2 — the GitHub sync layer): two new shell modules (js/api.js,
   js/sync.js, plus js/version.js), real Settings rows, and the sync indicator.

   KEEP IN LOCKSTEP with BUILD in app/js/version.js, which is what Settings ›
   About prints as "App version" — a classic worker script cannot import an ES
   module, so the string lives in both files and tests/build.test.js fails if
   they ever disagree.

   v5 (the v4.2 wiring pass) shipped new icon BYTES under unchanged names, which
   is the standing reminder that a deploy without a VERSION bump leaves every
   installed copy serving the old shell forever. */
const VERSION = "v6";
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
  "./js/api.js",
  "./js/sync.js",
  "./js/version.js",
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
  "./js/views/geomap.js",
  "./js/views/trips.js",
  "./js/views/settings.js",

  /* MapLibre GL 6.4.1 (BSD-3-Clause), vendored — see the header of
     js/views/geomap.js for provenance. The LIBRARY is precached so that the
     choice between the geographic map and the schematic is about TILES, not
     about whether the code is reachable: offline, the module still imports,
     and map.js falls back deliberately rather than by accident.

     v6 ships an ESM-only, code-split dist, so all three files are needed:
     the entry imports the shared chunk, and the library itself loads the
     worker as a module Worker resolved against its own import.meta.url. */
  "./vendor/maplibre/maplibre-gl.mjs",
  "./vendor/maplibre/maplibre-gl-shared.mjs",
  "./vendor/maplibre/maplibre-gl-worker.mjs",
  "./vendor/maplibre/maplibre-gl.css",

  /* our cartography — small, and it must be there for the map to draw at all */
  "./map-style.json",

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
  /* Cross-origin means map tiles, the TileJSON and glyph ranges from
     tiles.openfreemap.org — and, from M2, api.github.com. All of it is passed
     straight through and NEVER written to a cache.

     For the tiles: a shell cache is not a tile store, and a half-filled one
     would make the map look available offline while showing whatever squares of
     the world happened to be in it. Offline is the schematic's job (DESIGN §5);
     a real offline map is the Protomaps PMTiles extract, later.

     For the API: a cached trip read is a refresh button that lies (DESIGN §4),
     which is the whole reason this app does not use raw.githubusercontent.com.
     Trip data is cached in IndexedDB by js/data.js, where it carries its sha and
     its fetch time. Writes are PUTs and never reach this handler at all. */
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
