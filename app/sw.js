/* sw.js — app-shell service worker.

   Scope is this file's own directory (app/), which deliberately EXCLUDES
   /data/: trip JSON is the app layer's business and is cached in IndexedDB by
   js/data.js, not here. Requests that reach this worker for /data/ are passed
   straight through to the network anyway, belt and braces.

   Bumping: change VERSION. The cache name carries it, install precaches the new
   shell, and activate deletes every other wayfeather-shell-* cache. */

/* v9 (2026-08-20, the mixed-shell fix): the fetch handler no longer writes to
   any cache. See "WHY THERE IS NO REVALIDATION" above shellFirst() — this is
   the bug that took an installed phone down in the field, and the reason the
   staleness problem it was solving now lives in js/shell.js instead.

   v8 (2026-08-20, schema 2 status axes).

   v7 (2026-08-20, the v4.3 cosmetic pass): no new modules — index.html, app.css
   and js/views/map.js only. Every byte of it is a file the shell already
   precaches under an unchanged name, which is exactly the shape of deploy that
   goes invisible without a bump (see v5 below).

   v6 (2026-08-20, M2 — the GitHub sync layer): two new shell modules (js/api.js,
   js/sync.js, plus js/version.js), real Settings rows, and the sync indicator.

   KEEP IN LOCKSTEP with BUILD in app/js/version.js, which is what Settings ›
   About prints as "App version" — a classic worker script cannot import an ES
   module, so the string lives in both files and tests/build.test.js fails if
   they ever disagree.

   v5 (the v4.2 wiring pass) shipped new icon BYTES under unchanged names, which
   is the standing reminder that a deploy without a VERSION bump leaves every
   installed copy serving the old shell forever. */
const VERSION = "v9";
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
  "./js/shell.js",
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

/* The ONLY writer of the shell cache, and the reason a version swap is
   all-or-nothing: this cache name is brand new, nothing serves out of it until
   the browser fires `activate`, and the browser only fires `activate` after
   this handler's waitUntil() has settled. So every byte in wayfeather-shell-vN
   was fetched during one install of vN — a cache can never hold two builds. */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // added one at a time: cache.addAll() rejects the whole install if a single
    // entry 404s, which would leave the app with no worker at all. A miss here
    // costs a network round-trip later (cache-first falls through), NOT a
    // mixed shell — the misses are absences, never another version's bytes.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

/* Self-heal: every wayfeather-shell-* cache that is not this exact version is
   deleted here, including one an older build left half-rewritten. A phone
   carrying a poisoned v7 cache therefore loses it the moment v9 activates —
   there is no migration and nothing to repair, only the new cache. */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* "Which shell is actually answering?" — asked by js/shell.js at boot and by
   Settings › About. The page compares this against its own BUILD constant: a
   disagreement means the page was loaded from one version and is now controlled
   by another, which is a "close and reopen", not a crash. Answering over the
   caller's MessagePort keeps it a request/response, with no broadcast to other
   clients and no state kept on either side. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "version?") return;
  const reply = { type: "version", version: VERSION, cache: CACHE };
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(reply);
  else if (event.source && event.source.postMessage) event.source.postMessage(reply);
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
    event.respondWith(shellFirst("./index.html", req, { ignoreSearch: true }));
    return;
  }

  // Cache-first for shell assets; anything unknown goes to the network and is
  // NOT written to the cache — the precache list is the whole shell, on purpose.
  event.respondWith(shellFirst(req, req, { ignoreSearch: false }));
});

/* Cache-first. That is the whole strategy, and this function writes NOTHING.

   ══ WHY THERE IS NO REVALIDATION ══════════════════════════════════════════
   v7 and v8 answered from the cache and then quietly re-fetched each asset and
   put() the fresh bytes back — into the CURRENT cache, one entry at a time,
   with no check that the bytes still belonged to this version. It was there so
   that forgetting to bump VERSION cost one extra launch instead of pinning a
   phone forever.

   On a real phone, during a deploy, it did this instead: the worker was v7, the
   server had started serving v8, and a launch on a slow connection revalidated
   SOME of the shell before the app was backgrounded. The v7 cache came out
   holding a handful of v8 files — an index.html from one build, modules from
   another. Every launch afterwards booted that mixture, and an ES module graph
   that disagrees with itself does not degrade, it fails to evaluate: main.js
   never ran, so nothing was wired and nothing loaded the stored sync settings,
   and the static Settings markup underneath sat there with empty owner, repo
   and token fields. It read as "the app broke and lost my token". Neither was
   true; the token was in localStorage the whole time.

   Per-entry writes cannot be made safe by ordering or by a guard, because the
   unit of correctness is the WHOLE shell, not the file. The browser already has
   an atomic swap for exactly this: a changed sw.js installs into a NEW cache
   name and activates all of it or none of it. So staleness is now handled at
   that layer instead — js/shell.js nudges registration.update() once per launch
   — and this handler never mixes versions because it never writes.

   Do not reintroduce a cache.put() here. tests/shell.test.js fails if you do. */
async function shellFirst(cacheKey, req, opts) {
  const cached = await caches.match(cacheKey, opts);
  if (cached) return cached;
  try { return await fetch(req); }
  catch (e) { return Response.error(); }
}
