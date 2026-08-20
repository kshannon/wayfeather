/* views/map.js — the schematic route view as a resident tab: the scoped day as
   a node line with direction arrows, and a docked card for one stop with ◀ ▶
   cycling. Did it! / Skip it work from the dock exactly as on a card. */

import { $, esc, attr } from "../dom.js";
import { walkDirUrl } from "../links.js";
import { store } from "../state.js";
import { session } from "../session.js";
import { placesOfDay, dayByKey, isNote, isVisited, isSkipped, isHandled } from "../trip.js";
import { timeHTML, chipHTML, hoursHTML, warnHTML, linksHTML, actsHTML } from "./card.js";
import { ctx } from "./itinerary.js";
import { setTitle } from "../chrome.js";

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

export function renderMap() {
  const trip = store.trip;
  if (!trip) { setTitle("map", "Map"); return; }
  const day = dayByKey(trip, session.scope.dayKey || session.dayKey);
  if (!day) return;
  const stops = routeStops();
  if (session.route.idx >= stops.length) session.route.idx = 0;
  const c = ctx();

  const title = day.title || day.label || day.key;
  $("mapTitle").textContent = title;
  setTitle("map", title);
  $("mapSub").textContent = (session.scope.cluster ? session.scope.cluster : "Whole day") +
    " · " + stops.length + (stops.length === 1 ? " stop" : " stops") + " in order";
  $("mapEscape").innerHTML = session.scope.cluster
    ? '<button class="btn btn-quiet" type="button" id="btnWholeDay">Whole day</button>'
    : "";

  $("routeNodes").innerHTML = stops.map((p, i) => {
    const vis = isVisited(p), skp = isSkipped(p), cur = i === session.route.idx;
    const cls = "node" + (vis ? " is-visited" : "") + (skp ? " is-skipped" : "") +
                (cur ? " is-cur" : "");
    const glyph = vis ? "✓" : (skp ? "–" : String(i + 1));
    const st = vis ? "Done" : (skp ? "Skipped" : (cur ? "Showing below" : ""));
    return '<li class="' + cls + '">' +
      '<button class="node-btn" type="button" data-node="' + i + '"' +
        (cur ? ' aria-current="true"' : "") +
        ' aria-label="Stop ' + (i + 1) + " of " + stops.length + ": " +
          attr(p.name || "") + (st ? " — " + st : "") + '">' +
        '<span class="node-rail" aria-hidden="true"><span class="node-dot">' + glyph + "</span></span>" +
        '<span class="node-body">' +
          (p.time ? '<span class="node-time u-tab-num">' + esc(p.time) + "</span>" : "") +
          '<span class="node-name">' + esc(p.name || "") + "</span>" +
          (st ? '<span class="node-state">' + esc(st) + "</span>" : "") +
        "</span>" +
      "</button></li>";
  }).join("") || '<li class="empty">No routable stopovers on this day.</li>';

  const u = walkDirUrl(stops);
  $("routeOut").innerHTML = u
    ? '<a class="mapsout" href="' + attr(u) + '" target="_blank" rel="noopener noreferrer">' +
      'Open walking directions in Google Maps<span aria-hidden="true">↗</span></a>'
    : "";

  const p2 = stops[session.route.idx];
  if (!p2) { $("dockBody").innerHTML = ""; $("dockCount").textContent = "No stops"; return; }
  $("dockCount").textContent = "Stop " + (session.route.idx + 1) + " of " + stops.length;
  $("dockBody").innerHTML =
    '<div class="dock-pad">' +
      '<div class="dock-top">' + timeHTML(p2) + chipHTML(p2) + "</div>" +
      '<h3 class="dock-name">' + esc(p2.name || "") + "</h3>" +
      hoursHTML(p2) + warnHTML(p2) +
      (p2.notes ? '<p class="dock-note">' + esc(p2.notes) + "</p>" : "") +
      linksHTML(p2, c) + actsHTML(p2, c) +
    "</div>";
}

/* ◀ ▶ wrap instead of disabling: a disabled arrow cannot be dimmed far enough
   to read as disabled while staying >= 3:1. */
export function jumpTo(i) {
  const n = routeStops().length;
  if (!n) return;
  session.route.idx = ((i % n) + n) % n;
  renderMap();
  const el = $("routeNodes").querySelector('[data-node="' + session.route.idx + '"]');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

export function clearClusterScope() {
  session.scope.cluster = null;
  session.route.idx = firstUnhandled(routeStops());
  renderMap();
}
