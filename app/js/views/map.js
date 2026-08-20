/* views/map.js — the Map tab.

   Two renderings of the same scope, and one floating bar shared by both:

     geographic  MapLibre over OpenFreeMap tiles, state-coloured pins joined by
                 a direction-arrowed travel line (views/geomap.js, lazy-loaded)
     schematic   the node line — the ORIGINAL view, still here, still the
                 fallback for no-coords and for offline

   Which one you get is decided per render by wantGeo(). Both wear the same
   chrome (DESIGN §5, full-bleed map, 2026-08-20): the map fills the tab, a thin
   context pill floats at the top saying which day it is, and a thin stopover
   bar floats at the bottom. There is no large title and no day switcher on this
   tab — day switching lives on the Itinerary.

   The bar is deliberately shallow: time, reservation glyph, one ellipsized
   name, cycling, the two state actions, and Details. Anything deeper is the
   Details sheet's job, which main.js opens over the map with the itinerary's
   own card fragment — so map context is never lost to a tab jump. */

import { $, esc, attr } from "../dom.js";
import { walkDirUrl } from "../links.js";
import { store } from "../state.js";
import { session } from "../session.js";
import { placesOfDay, dayByKey, isNote, isVisited, isSkipped, isHandled } from "../trip.js";
import { timeHTML, actsHTML } from "./card.js";
import { ctx } from "./itinerary.js";
import { getView } from "../chrome.js";

/* The heavy module is imported on demand inside syncGeo(), never at module
   scope: importing it here would pull a megabyte of map engine into the
   Itinerary's boot, which is exactly what the lazy split exists to prevent. */
let geo = null;

export function routeStops() {
  const trip = store.trip;
  if (!trip) return [];
  const k = session.scope.dayKey || session.dayKey;
  return placesOfDay(trip, k).filter((p) =>
    !isNote(p) && (!session.scope.cluster || p.cluster === session.scope.cluster));
}

export function firstUnhandled(stops) {
  for (let i = 0; i < stops.length; i++) if (!isHandled(stops[i])) return i;
  return 0;
}

/* The stopover the bar is showing — what the Details sheet opens on. */
export function currentStop() {
  return routeStops()[session.route.idx] || null;
}

/* ── geographic vs schematic ──────────────────────────────────────────────── */
function isNum(v) { return typeof v === "number" && isFinite(v); }

/* The scope's stopovers that actually carry coordinates, in visit order, with
   the display state flattened onto each one so geomap.js needs nothing from
   trip.js. Coordinates come from the geocode script or a parsed maps link —
   never from anywhere else (LLMS.md ground rule 1). */
function geoStops() {
  return routeStops()
    .filter((p) => isNum(p.lat) && isNum(p.lng))
    .map((p) => ({
      id: p.id, name: p.name, time: p.time, lat: p.lat, lng: p.lng,
      __visited: isVisited(p), __skipped: isSkipped(p), __fixed: p.priority === "fixed"
    }));
}

/* DESIGN §5 gives the geographic map one precondition and the schematic two
   jobs. Offline is checked first and cheaply: with no network the tiles cannot
   arrive, and a cream rectangle is a worse answer than the node line. The
   library itself is precached, so this really is a decision about tiles. */
function wantGeo(pts) {
  if (!pts.length) return false;
  /* THE lazy-load gate. renderMap() runs during boot and on every day switch,
     long before anyone opens this tab — so the map engine is only ever fetched
     once the Map tab is actually the view on screen. Without this the dynamic
     import fires at boot and the split buys nothing. It also matters for
     correctness: a container inside a display:none view measures 0x0, and
     MapLibre would size its canvas to nothing. */
  if (getView() !== "map") return false;
  if (navigator.onLine === false) return false;
  return !(geo && geo.isBroken());
}

let mode = null;                       // "geo" | "schematic", once decided
let geoLive = false;                   // a map is up and has drawn this scope
let renderToken = 0;                   // only the newest async render may apply

function setMode(next) {
  if (mode === next) return;
  mode = next;
  const on = next === "geo";
  $("geoWrap").hidden = !on;
  $("routeSchematic").hidden = on;
}

/* The map is asked for on every render; it answers when it can. Until it does,
   the geo container is already on screen wearing the app's cream, so a
   successful load fades in rather than shoving the layout around. */
async function syncGeo(pts, token) {
  let ok = false;
  try {
    if (!geo) geo = await import("./geomap.js");
    if (token !== renderToken) return;
    ok = await geo.showGeo({
      stops: pts,
      idx: session.route.idx,
      scopeKey: scopeKey(),
      base: (store.trip && store.trip.base) || null,
      tap: jumpTo
    });
  } catch (e) {
    ok = false;              // vendored module missing, or the map gave up
  }
  if (token !== renderToken) return;
  geoLive = ok;
  setMode(ok ? "geo" : "schematic");
  $("geoNote").hidden = true;
}

/* Changes exactly when the viewport should be re-fitted: a different trip, day
   or cluster. Cycling the bar does not change it, so cycling never re-frames
   the map (DESIGN §5 — the viewport is derived from the SCOPE).

   session.scope.cluster is always null now that the cluster-level "Walk it"
   button is gone (DESIGN §5), but the scope model itself is unchanged: DESIGN
   still lists cluster as one of the three derived viewports, and the map's own
   stretch focus is the intended way back to it. */
function scopeKey() {
  const trip = store.trip;
  return [trip && trip.id, session.scope.dayKey || session.dayKey,
          session.scope.cluster || ""].join("|");
}

/* ── render ───────────────────────────────────────────────────────────────── */
export function renderMap() {
  const trip = store.trip;
  if (!trip) { $("mapPill").textContent = ""; renderStopBar([], null); return; }
  const day = dayByKey(trip, session.scope.dayKey || session.dayKey);
  if (!day) return;
  const stops = routeStops();
  if (session.route.idx >= stops.length) session.route.idx = 0;
  const c = ctx();

  /* The whole of this tab's context, in one thin pill. Straight from the trip
     data — never a constructed or constant label (CLAUDE.md). */
  $("mapPill").textContent = day.title || day.label || day.key;

  renderNodes(stops);

  const u = walkDirUrl(stops);
  $("routeOut").innerHTML = u
    ? '<a class="mapsout" href="' + attr(u) + '" target="_blank" rel="noopener noreferrer">' +
      'Open walking directions in Google Maps<span aria-hidden="true">↗</span></a>'
    : "";

  renderStopBar(stops, c);

  /* Under the ≥1-geocoded-stopover rule the camera always has at least one
     point to work with, which is what makes DESIGN §5's "a day with no
     coordinates falls back to trip bounds" unreachable here: a day with no
     coordinates never reaches the geographic map at all. */
  const pts = geoStops();
  renderToken++;
  if (wantGeo(pts)) {
    /* Commit to ONE view from the first frame. The map container has to be
       laid out for MapLibre to size its canvas at all, so it cannot stay
       hidden while the engine boots — which means the node line has to go now,
       not when the map reports success. Otherwise the two stack on top of each
       other for the second or two a cold start takes (very visible when the
       network returns and the map is rebuilt from scratch). */
    setMode("geo");
    $("geoNote").hidden = geoLive;      // "Loading the map…" only before first paint
    syncGeo(pts, renderToken);
  } else {
    if (geo && navigator.onLine === false) { geo.teardown(); geoLive = false; }
    setMode("schematic");
    $("geoNote").hidden = true;
  }
}

function renderNodes(stops) {
  $("routeNodes").innerHTML = stops.map((p, i) => {
    const vis = isVisited(p), skp = isSkipped(p), cur = i === session.route.idx;
    const cls = "node" + (vis ? " is-visited" : "") + (skp ? " is-skipped" : "") +
                (cur ? " is-cur" : "");
    const glyph = vis ? "✓" : (skp ? "–" : String(i + 1));
    const st = vis ? "Landed" : (skp ? "Flew past" : (cur ? "Showing below" : ""));
    return '<li class="' + cls + '">' +
      '<button class="node-btn" type="button" data-node="' + i + '"' +
        (cur ? ' aria-current="true"' : "") +
        ' aria-label="Stopover ' + (i + 1) + " of " + stops.length + ": " +
          attr(p.name || "") + (st ? " — " + st : "") + '">' +
        '<span class="node-rail" aria-hidden="true"><span class="node-dot">' + glyph + "</span></span>" +
        '<span class="node-body">' +
          (p.time ? '<span class="node-time u-tab-num">' + esc(p.time) + "</span>" : "") +
          '<span class="node-name">' + esc(p.name || "") + "</span>" +
          (st ? '<span class="node-state">' + esc(st) + "</span>" : "") +
        "</span>" +
      "</button></li>";
  }).join("") || '<li class="empty">No routable stopovers on this day.</li>';
}

/* The bar's whole job is to be shallow and a fixed height. Two rows, both the
   full width of the bar: the title row (time + reservation glyph + name +
   position), and a 44px action row that carries the compact ◀ ▶ at its ends
   with the state and Details between them. Nothing in here wraps, clamps or
   scrolls — if it would not fit, it is not in the bar.

   Two holes, filled separately, because the arrows now live in the markup
   BETWEEN them: #stopBarLine is the title row, #stopBarMid is the middle of the
   action row. Neither innerHTML ever touches a cycling button. */
function renderStopBar(stops, c) {
  const line = $("stopBarLine");
  const mid = $("stopBarMid");
  const p = stops[session.route.idx];
  const solo = stops.length < 2;

  /* Cycling is meaningless with one stopover and impossible with none. The
     buttons stay in the layout (the bar must not reflow as you cycle) and are
     disabled rather than removed. */
  [$("cycPrev"), $("cycNext")].forEach((b) => {
    b.disabled = solo;
    b.setAttribute("aria-hidden", solo ? "true" : "false");
    b.tabIndex = solo ? -1 : 0;
  });

  /* The empty message takes the full-width title row rather than the slot
     between the two arrows: it is a sentence, and it now has a whole row to be
     read on. The action row stays in the layout so the bar keeps its height. */
  if (!p) {
    line.innerHTML = '<p class="stopbar-empty">No routable stopovers on this day.</p>';
    mid.innerHTML = "";
    return;
  }

  const n = stops.length, i = session.route.idx;
  $("cycPrev").setAttribute("aria-label",
    "Previous stopover (" + (i + 1) + " of " + n + ")");
  $("cycNext").setAttribute("aria-label",
    "Next stopover (" + (i + 1) + " of " + n + ")");

  line.innerHTML =
    ((p.time || p.priority === "fixed") ? timeHTML(p) : "") +
    '<span class="stopbar-name">' + esc(p.name || "") + "</span>" +
    (n > 1
      ? '<span class="stopbar-pos">' + (i + 1) + "/" + n + "</span>"
      : "");

  mid.innerHTML =
    '<span class="stopbar-state">' + actsHTML(p, c) + "</span>" +
    '<button class="btn btn-quiet stopbar-details" type="button" ' +
      'data-details="' + attr(p.id) + '" ' +
      'aria-label="Details for ' + attr(p.name || "this stopover") + '">Details</button>';
}

/* ◀ ▶ wrap instead of disabling: a disabled arrow cannot be dimmed far enough
   to read as disabled while staying >= 3:1. Map pins call this too, which is
   how a tapped pin drives the bar. */
export function jumpTo(i) {
  const n = routeStops().length;
  if (!n) return;
  session.route.idx = ((i % n) + n) % n;
  renderMap();
  if (mode === "geo") return;                  // the map has no list to scroll
  const el = $("routeNodes").querySelector('[data-node="' + session.route.idx + '"]');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

/* Losing the network mid-session drops the map to the schematic; regaining it
   is allowed to try again. Both just re-render — the decision lives in one
   place, in wantGeo(). */
export function wireConnectivity() {
  window.addEventListener("offline", () => { if (mode === "geo") renderMap(); });
  window.addEventListener("online", () => {
    if (geo) geo.unbreak();
    renderMap();
  });
}
