/* views/geomap.js — the geographic map (DESIGN §5).

   MapLibre GL, vendored, over OpenFreeMap's keyless vector tiles, wearing the
   avian-matcha style in app/map-style.json. This module is LAZY: nothing here
   is imported until the Map tab is first activated with geocoded stopovers to
   show, so the Itinerary boots without a megabyte of map engine.

   ── VENDORED LIBRARY ──────────────────────────────────────────────────────
   maplibre-gl 6.4.1 (BSD-3-Clause), taken once from the npm registry tarball
   maplibre-gl-6.4.1.tgz (sha256 21d78393afc6db78f1f9963dfd979057b536b309d8c4
   8c1a4dde95277a522fef) and unpacked into app/vendor/maplibre/. v6 ships an
   ESM-only, code-split dist, so three files matter and all three are precached
   by the service worker: maplibre-gl.mjs (entry) → maplibre-gl-shared.mjs
   (chunk), plus maplibre-gl-worker.mjs, which the library loads itself as a
   MODULE worker resolved relative to its own import.meta.url. The only edit to
   the vendored bytes is a stripped //# sourceMappingURL comment on each file:
   the .map files are ~5 MB and shipping them is not worth it, while leaving
   the comments in makes devtools 404 on every load.

   ── WHAT IS OURS vs WHAT IS THE LIBRARY'S ─────────────────────────────────
   The route line and its direction arrows are real style layers (a line layer
   plus a symbol layer with symbol-placement:"line"), because they have to sit
   under the labels and follow the map as it rotates. The pins are DOM markers
   instead: there are at most a dozen, they need the app's own tokens, real
   44px touch targets and real <button> semantics for VoiceOver — none of which
   a circle layer gives you.

   ── NETWORK ───────────────────────────────────────────────────────────────
   The only requests this adds are map tiles, the TileJSON that lists them, and
   glyph ranges — all to tiles.openfreemap.org, which is the accepted runtime
   dependency (DESIGN §2). No keys, no accounts, no third-party script. The
   service worker never caches any of it. */

import { $, cssVar, reduced } from "../dom.js";

/* Resolved from import.meta.url, never from the document: the app has to work
   unchanged at any host path (see the same reasoning in data.js). */
const LIB_URL = new URL("../../vendor/maplibre/maplibre-gl.mjs", import.meta.url);
const CSS_URL = new URL("../../vendor/maplibre/maplibre-gl.css", import.meta.url);
const STYLE_URL = new URL("../../map-style.json", import.meta.url);

const FIT_PAD = 44;              // px of air around a fitted scope
const FIT_MAX_Z = 16.5;          // a tight cluster must not slam into z20
const SINGLE_Z = 15.5;           // DESIGN §5: one stopover sits at walking zoom
const INIT_TIMEOUT_MS = 9000;    // style + first tiles, or we call it a failure

let gl = null;                   // the library namespace, once imported
let libPromise = null;
let map = null;
let initPromise = null;
let markers = [];
let lastScopeKey = null;
let fitPts = [];                 // the points the current scope was fitted to
let fitTimer = 0;
let resizeObs = null;
let lastPos = null;              // last known user location, from the locate control
let ready = false;               // the map fired "load" and is usable
let broken = false;              // this session gave up on the geographic map
let onPinTap = null;

export function isBroken() { return broken; }

/* ── loading the library ──────────────────────────────────────────────────── */
function loadCSS() {
  if (document.querySelector('link[data-maplibre]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_URL.href;
  link.setAttribute("data-maplibre", "");
  document.head.appendChild(link);
}

function loadLib() {
  if (libPromise) return libPromise;
  loadCSS();
  libPromise = import(/* @vite-ignore */ LIB_URL.href)
    .then((m) => { gl = m.default || m; return gl; })
    .catch((e) => { libPromise = null; throw e; });
  return libPromise;
}

/* ── the direction arrow ──────────────────────────────────────────────────── */
/* Drawn into a canvas and handed to the map rather than shipped in a sprite:
   the style deliberately has no sprite (nothing else in it needs one), and this
   way the arrow picks up --brown from the tokens instead of duplicating a hex.
   symbol-placement:"line" rotates it to follow the direction of travel, so a
   plain right-pointing chevron is all the artwork required. */
function arrowImage(color) {
  const s = 16, r = 2;                       // 16pt glyph at 2x
  const c = document.createElement("canvas");
  c.width = s * r; c.height = s * r;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(r, r);
  g.strokeStyle = color;
  g.lineWidth = 2.1;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(5.6, 3.6); g.lineTo(11, 8); g.lineTo(5.6, 12.4);
  g.stroke();
  const px = g.getImageData(0, 0, s * r, s * r);
  return { width: px.width, height: px.height, data: new Uint8Array(px.data.buffer), pixelRatio: r };
}

/* ── pins ─────────────────────────────────────────────────────────────────── */
/* State → look, straight off DESIGN §5:
     upcoming   accent fill
     fixed      accent fill + a ring, the map's form of the reservation glyph
     landed     subdued fill, ✓ instead of a number
     flew past  grey, dimmed, – instead of a number
   The visible pin is 30px; the button around it is 44px of transparent padding,
   so the touch target clears the minimum without a 44px blob on the map. */
function pinEl(p, i, n, current, tap) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "gpin" +
    (p.__visited ? " is-visited" : "") +
    (p.__skipped ? " is-skipped" : "") +
    (p.__reserved && !p.__visited && !p.__skipped ? " is-reserved-pin" : "") +
    (current ? " is-cur" : "");

  const state = p.__visited ? "Landed" : (p.__skipped ? "Flew past" : "");
  btn.setAttribute("aria-label",
    "Stopover " + (i + 1) + " of " + n + ": " + (p.name || "") +
    (p.time ? ", " + p.time : "") + (state ? " — " + state : ""));
  if (current) btn.setAttribute("aria-current", "true");

  const dot = document.createElement("span");
  dot.className = "gpin-dot";
  dot.textContent = p.__visited ? "✓" : (p.__skipped ? "–" : String(i + 1));
  btn.appendChild(dot);

  btn.addEventListener("click", (e) => { e.stopPropagation(); if (tap) tap(i); });
  return btn;
}

/* The Nest — the trip's base. Deliberately not a numbered pin: it is not a stop
   on the route, so it gets the birdhouse and the brown, and no visit order. */
function nestEl(base) {
  const wrap = document.createElement("div");
  wrap.className = "gnest";
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", "The Nest — " + (base.name || "your base"));
  wrap.innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'focusable="false">' +
    '<path d="M3.4 9.6 12 3.1l8.6 6.5"/>' +
    '<path d="M5.4 9.6v9.2a1.8 1.8 0 0 0 1.8 1.8h9.6a1.8 1.8 0 0 0 1.8-1.8V9.6"/>' +
    '<circle cx="12" cy="12.9" r="2.5"/><path d="M12 15.4v2.9"/></svg>';
  return wrap;
}

function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

/* ── viewport (DESIGN §5: derived, never stored) ──────────────────────────── */
function boundsOf(pts) {
  if (!pts.length) return null;
  const b = new gl.LngLatBounds();
  pts.forEach((p) => b.extend([p.lng, p.lat]));
  return b;
}

/* "if the user's location dot is inside the current bounds, fitting never yanks
   the view away from it" — so when the dot is on screen right now, the new fit
   is widened to keep it on screen. If it is off screen already, it is none of
   the viewport's business. */
function keepUserDot(b) {
  if (!lastPos || !map) return b;
  try {
    if (map.getBounds().contains(lastPos)) b.extend(lastPos);
  } catch (e) { /* no valid bounds yet */ }
  return b;
}

/* The map went full bleed (DESIGN §5), so the canvas is no longer the visible
   frame: the context pill floats over its top and the stopover bar plus the tab
   bar cover its bottom. A symmetric pad would fit the day's bounds to the whole
   canvas and quietly park the last pin underneath the bar. So the padding is
   measured off the chrome that is actually on screen, with FIT_PAD as both the
   minimum and the fallback when a bar has not been laid out yet. */
function fitPadding() {
  const pad = { top: FIT_PAD, bottom: FIT_PAD, left: FIT_PAD, right: FIT_PAD };
  const host = $("geoCanvas");
  if (!host) return pad;
  const box = host.getBoundingClientRect();
  if (!box.height) return pad;
  const clear = (el, edge) => {
    if (!el || el.hidden) return 0;
    const r = el.getBoundingClientRect();
    if (!r.height) return 0;
    return edge === "top" ? Math.max(0, r.bottom - box.top) : Math.max(0, box.bottom - r.top);
  };
  pad.top = Math.max(pad.top, clear($("mapPill"), "top") + 12);
  pad.bottom = Math.max(pad.bottom, clear($("stopBar"), "bottom") + 12);
  /* MapLibre throws if the padding leaves no room at all — on a short screen
     the two bars can genuinely exceed the canvas. Cap each axis at 40% so a
     fit always has a viewport to fit into. */
  const capV = box.height * 0.4, capH = box.width * 0.4;
  pad.top = Math.min(pad.top, capV);
  pad.bottom = Math.min(pad.bottom, capV);
  pad.left = Math.min(pad.left, capH);
  pad.right = Math.min(pad.right, capH);
  return pad;
}

function applyViewport(pts, force, instant) {
  if (!map || !pts.length) return;
  fitPts = pts;
  const anim = (reduced() || instant) ? { duration: 0 } : {};
  if (pts.length === 1 && !force) {
    map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: SINGLE_Z, ...anim });
    return;
  }
  if (pts.length === 1) {
    map.jumpTo({ center: [pts[0].lng, pts[0].lat], zoom: SINGLE_Z });
    return;
  }
  const b = keepUserDot(boundsOf(pts));
  map.fitBounds(b, { padding: fitPadding(), maxZoom: FIT_MAX_Z, ...anim });
}

/* ── route line + arrows ──────────────────────────────────────────────────── */
function routeGeoJSON(pts) {
  return {
    type: "FeatureCollection",
    features: pts.length >= 2
      ? [{ type: "Feature", properties: {},
           geometry: { type: "LineString", coordinates: pts.map((p) => [p.lng, p.lat]) } }]
      : []
  };
}

function addRouteLayers() {
  const brown = cssVar("--brown", "#6B4F3A");
  const ground = cssVar("--ground", "#F7F2E6");

  const img = arrowImage(brown);
  if (img && !map.hasImage("wf-arrow")) {
    map.addImage("wf-arrow", img, { pixelRatio: img.pixelRatio });
  }

  map.addSource("wf-route", { type: "geojson", data: routeGeoJSON([]) });

  /* A cream casing under the line: the route has to stay legible where it
     crosses a matcha park or a dark building block. */
  map.addLayer({
    id: "wf-route-casing", type: "line", source: "wf-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ground, "line-width": 7, "line-opacity": 0.9 }
  });
  map.addLayer({
    id: "wf-route-line", type: "line", source: "wf-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": brown, "line-width": 3, "line-opacity": 0.85 }
  });
  map.addLayer({
    id: "wf-route-arrows", type: "symbol", source: "wf-route",
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 74,
      "icon-image": "wf-arrow",
      "icon-size": 0.95,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true
    }
  });
}

/* ── init ─────────────────────────────────────────────────────────────────── */
/* Resolves true when the map is genuinely usable. Any failure — the vendored
   module missing, the style unreachable, the tile source erroring, or simply
   nothing happening for INIT_TIMEOUT_MS — resolves false, and the caller draws
   the schematic instead. Nothing here reaches console: MapLibre only logs
   errors when no "error" listener is attached, and one is attached before the
   first tile is ever requested. */
async function init(container) {
  await loadLib();

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(ok);
    };
    const timer = window.setTimeout(() => done(false), INIT_TIMEOUT_MS);

    try {
      map = new gl.Map({
        container,
        style: STYLE_URL.href,
        center: [0, 0],
        zoom: 1,
        attributionControl: { compact: true },
        /* the app is a field guide, not a flight simulator */
        pitchWithRotate: false,
        dragRotate: false,
        touchPitch: false,
        /* MapLibre honours the OS setting for its own camera animations; ours
           are gated separately through reduced() in applyViewport */
        respectPrefersReducedMotion: true,
        fadeDuration: reduced() ? 0 : 300
      });
    } catch (e) { done(false); return; }

    /* Swallow, do not spam. Before the map is up an error means "fall back";
       after it is up a tile blip is not worth tearing the view down for. */
    map.on("error", (e) => {
      const src = e && e.sourceId;
      if (!ready && (src === "openmaptiles" || !src)) done(false);
    });

    map.on("load", () => {
      ready = true;
      try { addRouteLayers(); } catch (e) { done(false); return; }
      watchResize(container);
      /* "idle" is the map's own "everything has settled" signal, and it fires
         after resizes and camera moves — the exact moments the attribution
         control re-expands itself. */
      map.on("idle", () => collapseAttribution(container));
      collapseAttribution(container);
      done(true);
    });

    addLocate();
  });
}

/* ── keeping the fit honest ───────────────────────────────────────────────── */
/* fitBounds is only correct for the canvas size it was measured against, and
   that size is not final when the map first loads: the header and the docked
   card are still settling (a web-font swap alone moves them), which quietly
   shifted the whole frame and pushed the northernmost pin ~25px off the top
   edge. So the scope's fit is re-applied whenever the container actually
   changes size — instantly, because this is a correction, not a camera move.
   Debounced, since a resize arrives as a burst. */
function watchResize(container) {
  if (!("ResizeObserver" in window)) return;
  if (resizeObs) resizeObs.disconnect();
  resizeObs = new ResizeObserver(() => {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      if (!map || !fitPts.length) return;
      map.resize();
      applyViewport(fitPts, true, true);
    }, 90);
  });
  resizeObs.observe(container);
}

/* MapLibre renders the compact attribution EXPANDED — a 320px slab of text
   lying across the map — and re-expands it every time the control recomputes,
   which includes every map.resize(). So collapsing it once at load does not
   hold; it is re-collapsed whenever the map settles.

   The credit is not being hidden: this is exactly the state MapLibre's own (i)
   button toggles to, and ODbL asks for the attribution to be reachable, not to
   be permanently in the way. Once the reader opens it themselves we stop
   touching it, so a deliberate tap is never undone by a pan. */
let attribOpened = false;

function collapseAttribution(container) {
  if (attribOpened) return;
  const el = container.querySelector(".maplibregl-ctrl-attrib");
  if (!el) return;
  el.classList.remove("maplibregl-compact-show");
  const btn = el.querySelector(".maplibregl-ctrl-attrib-button");
  if (btn && !btn.dataset.wfWired) {
    btn.dataset.wfWired = "1";
    btn.addEventListener("click", () => { attribOpened = true; });
  }
}

/* ── the locate control ───────────────────────────────────────────────────── */
/* Graceful denial, and quietly. MapLibre's own GeolocateControl checks support
   asynchronously and console.warns "Geolocation support is not available" when
   the permission is already denied — so the permission is checked HERE first
   and the control is simply never added in that case. A locate button that
   cannot locate is worse than no button, and the warning is noise we promised
   not to make. If the user later grants the permission, the change event adds
   the control without a reload. */
async function addLocate() {
  if (!navigator.geolocation || !map) return;
  let status = null;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      status = await navigator.permissions.query({ name: "geolocation" });
    }
  } catch (e) { status = null; }          // Safari has shipped both answers here

  if (status && status.state === "denied") {
    status.onchange = () => { if (status.state !== "denied") addLocate(); };
    return;
  }
  if (!map || map._removed) return;       // torn down while we were awaiting

  const locate = new gl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 8000 },
    trackUserLocation: false,
    showUserLocation: true,
    showAccuracyCircle: true
  });
  map.addControl(locate, "top-right");
  /* Denial at the prompt is a normal outcome, not an error: the control returns
     to its resting state and the map carries on. Listening keeps it off the
     console, since MapLibre only logs when nothing is listening. */
  locate.on("error", () => { /* denied, unavailable, or timed out */ });
  locate.on("geolocate", (pos) => {
    if (pos && pos.coords) lastPos = [pos.coords.longitude, pos.coords.latitude];
  });
}

/* ── the one entry point ──────────────────────────────────────────────────── */
/* payload: { stops, idx, scopeKey, base, tap }
     stops    — the scope's stopovers that carry coordinates, in visit order,
                each already flagged with __visited / __skipped / __reserved
     idx      — which one the dock is showing
     scopeKey — changes when the day, cluster or trip changes; that is the ONLY
                thing that re-fits the viewport
     tap      — called with an index when a pin is tapped
   Returns true if the geographic map is on screen, false to draw the schematic. */
export async function showGeo(payload) {
  if (broken) return false;
  const host = $("geoCanvas");
  if (!host) return false;

  /* renderMap() fires on every day switch, every Landed!/Flew past and every
     dock cycle, so overlapping calls during the (slow, one-time) init are
     normal. They all await the SAME init promise rather than each building a
     second Map into the same container. */
  if (!map) {
    if (!initPromise) initPromise = init(host);
    const ok = await initPromise;
    if (!ok) {
      broken = true;
      teardown();
      return false;
    }
  }
  onPinTap = payload.tap;

  const pts = payload.stops;
  map.getSource("wf-route").setData(routeGeoJSON(pts));

  clearMarkers();
  if (payload.base && isNum(payload.base.lat) && isNum(payload.base.lng)) {
    markers.push(new gl.Marker({ element: nestEl(payload.base), anchor: "bottom" })
      .setLngLat([payload.base.lng, payload.base.lat]).addTo(map));
  }
  pts.forEach((p, i) => {
    const el = pinEl(p, i, pts.length, i === payload.idx, onPinTap);
    markers.push(new gl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([p.lng, p.lat]).addTo(map));
  });

  /* The container was display:none while another tab was up, so the canvas has
     stale dimensions until it is measured again. */
  map.resize();

  if (payload.scopeKey !== lastScopeKey) {
    lastScopeKey = payload.scopeKey;
    applyViewport(pts, true);
  } else {
    nudgeTo(pts[payload.idx]);
  }
  return true;
}

/* Cycling the dock should not drag the map around: it moves only when the stop
   the dock is now showing is off screen. */
function nudgeTo(p) {
  if (!map || !p) return;
  try {
    if (map.getBounds().contains([p.lng, p.lat])) return;
  } catch (e) { return; }
  map.easeTo({ center: [p.lng, p.lat], ...(reduced() ? { duration: 0 } : { duration: 420 }) });
}

/* Drop the map entirely — the WebGL context, the workers, the markers. Used
   when the device goes offline: from there the schematic is the honest view,
   and a live map holding cached tiles would quietly lie about being current. */
export function teardown() {
  clearMarkers();
  window.clearTimeout(fitTimer);
  if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
  if (map) { try { map.remove(); } catch (e) { /* already gone */ } }
  map = null;
  initPromise = null;
  ready = false;
  lastScopeKey = null;
  fitPts = [];
}

/* An offline trip is not a permanently broken one: coming back online must be
   allowed to try again. */
export function unbreak() { broken = false; }

function isNum(v) { return typeof v === "number" && isFinite(v); }
