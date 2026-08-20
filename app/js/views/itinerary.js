/* views/itinerary.js — the day view: large-title header, day panels grouped by
   cluster, the per-day list tail, the refresh stamp and the offline banner. */

import { $, esc, attr, q, frag, replaceWith } from "../dom.js";
import { rangeLabel, relTime, fmtClock } from "../time.js";
import { deriveLoc, appleMapsUrl } from "../links.js";
import { PIN_SVG, OFFLINE_SVG } from "../icons.js";
import { store } from "../state.js";
import { SUPPORTED_SCHEMA } from "../data.js";
import {
  placesOfDay, clustersOf, isNote, countText, findPool, eyebrowText, placeById
} from "../trip.js";
import { cardHTML } from "./card.js";
import { setTitle } from "../chrome.js";

export function ctx() {
  const t = store.trip;
  return { loc: t ? deriveLoc(t) : "", tz: t && t.tz };
}

/* ── header ───────────────────────────────────────────────────────────────── */
export function renderHero() {
  const trip = store.trip;
  if (!trip) {
    $("heroEyebrow").textContent = "";
    $("heroTitle").textContent = "Wayfeather";
    $("heroSub").textContent = "";
    $("heroBase").innerHTML = "";
    $("tripNotes").textContent = "";
    setTitle("itinerary", "Wayfeather");
    return;
  }
  $("heroEyebrow").textContent = eyebrowText(trip);
  $("heroTitle").textContent = trip.name || "Trip";
  $("heroSub").textContent = rangeLabel(trip.start, trip.end);

  const b = trip.base;
  $("heroBase").innerHTML = (b && b.name)
    ? '<a class="lt-base" href="' + attr(appleMapsUrl(b.name, b.address)) + '" ' +
        'target="_blank" rel="noopener noreferrer" ' +
        'aria-label="Open ' + attr(b.name) + ' in Apple Maps">' +
        '<span class="lbl">Base · ' + esc(b.name) + "</span>" + PIN_SVG + "</a>"
    : "";

  $("tripNotes").textContent = trip.notes || "";
  document.title = (trip.name || "Wayfeather") + " — Wayfeather";
  setTitle("itinerary", trip.name || "Wayfeather");
}

/* ── panels ───────────────────────────────────────────────────────────────── */
function clusterHTML(dayKey, name, stops, c) {
  const routable = stops.filter((s) => !isNote(s));
  return '<section class="cluster">' +
    '<div class="cluster-head">' +
      '<h3 class="cluster-name">' +
        '<span class="cluster-dot" aria-hidden="true"></span>' +
        "<span>" + esc(name) + "</span>" +
      "</h3>" +
      (routable.length >= 2
        ? '<button class="btn btn-soft" type="button" data-route="' + attr(dayKey) + '" ' +
          'data-cluster="' + attr(name) + '" ' +
          'aria-label="Walk it — open the map for ' + attr(name) + '">Walk it' +
          '<span aria-hidden="true">▸</span></button>'
        : "") +
    "</div>" +
    '<div class="stops">' + stops.map((p) => cardHTML(p, c)).join("") + "</div>" +
  "</section>";
}

export function tailHTML(day) {
  if (day.date == null) return "";                 // scheduled days only
  const pool = findPool(store.trip);
  return '<div class="tail">' +
    '<button class="btn btn-card" type="button" data-add="' + attr(day.key) + '">' +
      '<span class="g" aria-hidden="true">＋</span>Add another stopover</button>' +
    (pool.length
      ? '<button class="btn btn-card" type="button" data-find="' + attr(day.key) + '">' +
        '<span class="g" aria-hidden="true">✦</span>Find me something</button>'
      : "") +
  "</div>";
}

function panelHTML(day, c) {
  const trip = store.trip;
  const stops = placesOfDay(trip, day.key);
  const cl = clustersOf(stops);
  const body = cl.length
    ? cl.map((name) =>
        clusterHTML(day.key, name, stops.filter((s) => s.cluster === name), c)
      ).join("")
    : '<p class="empty">Nothing on the plan for this day yet.</p>';
  const routable = stops.filter((s) => !isNote(s));

  return '<section class="day" id="panel-' + attr(day.key) + '" role="tabpanel" ' +
           'aria-labelledby="daytab-' + attr(day.key) + '">' +
      '<div class="dayhead">' +
        '<div class="dayhead-main">' +
          '<span class="dayhead-mark" aria-hidden="true">' + esc(day.bullet || "") + "</span>" +
          "<div><h2>" + esc(day.title || day.label || day.key) + "</h2>" +
          (day.subtitle ? "<p>" + esc(day.subtitle) + "</p>" : "") + "</div>" +
        "</div>" +
        '<div class="dayhead-foot">' +
          '<span class="dayhead-count" data-count="' + attr(day.key) + '">' +
            esc(countText(trip, day)) + "</span>" +
          (routable.length >= 2
            ? '<button class="btn btn-card" type="button" data-route="' + attr(day.key) + '" ' +
              'aria-label="Open the map for ' + attr(day.title || day.label || day.key) + '">Route' +
              '<span aria-hidden="true">▸</span></button>'
            : "") +
        "</div>" +
      "</div>" +
      body + tailHTML(day) +
    "</section>";
}

export function renderPanels() {
  const trip = store.trip;
  if (!trip) { $("panels").innerHTML = emptyStateHTML(); return; }
  const c = ctx();
  $("panels").innerHTML = trip.days.map((d) => panelHTML(d, c)).join("");
}

export function paintPanels(dayKey) {
  const panels = $("panels").querySelectorAll(".day");
  for (let i = 0; i < panels.length; i++) {
    panels[i].classList.toggle("is-on", panels[i].id === "panel-" + dayKey);
  }
}

/* Repaint one card in place after Did it! / Skip it / Undo. */
export function repaintCard(id) {
  const node = $("panels").querySelector('[data-card="' + q(id) + '"]');
  const p = placeById(store.trip, id);
  if (!node || !p) return;
  replaceWith(node, cardHTML(p, ctx()));
}

/* The tail's "Find me something" appears and disappears with the pool, and an
   extra can be handled straight from the XTRA day. */
export function refreshTails() {
  store.trip.days.forEach((d) => {
    const panel = $("panel-" + d.key);
    if (!panel) return;
    const old = panel.querySelector(".tail");
    const html = tailHTML(d);
    if (!html) { if (old) old.parentNode.removeChild(old); return; }
    if (old) replaceWith(old, html);
    else panel.appendChild(frag(html));
  });
}

export function refreshCounts() {
  store.trip.days.forEach((d) => {
    const c = $("panels").querySelector('[data-count="' + q(d.key) + '"]');
    if (c) c.textContent = countText(store.trip, d);
  });
}

/* ── stamp + offline banner ───────────────────────────────────────────────── */
/* No sha: a static fetch cannot know the git blob sha, and the app must not
   invent one (v3's random 7 hex is gone). The Contents API supplies the real
   sha in M2 — see the seam in data.js — and it lands right here. */
export function renderStamp() {
  const meta = store.tripMeta;
  const when = meta.fetchedAt ? fmtClock(new Date(meta.fetchedAt), store.trip && store.trip.tz) : "";
  const rel = meta.fetchedAt ? relTime(meta.fetchedAt) : "never";
  $("stamp").innerHTML = "updated " + esc(rel) +
    (when ? '<span aria-hidden="true">·</span><b>' + esc(when) + "</b>" : "") +
    (meta.sha ? '<span aria-hidden="true">·</span><b>' + esc(meta.sha) + "</b>" : "");
}

export function renderStaleBanner() {
  const meta = store.tripMeta;
  const box = $("staleBanner");
  if (!meta.stale || !store.trip) { box.innerHTML = ""; return; }
  box.innerHTML = '<p class="stale">' + OFFLINE_SVG +
    "<span>offline · data from " + esc(meta.fetchedAt ? relTime(meta.fetchedAt) : "an earlier session") +
    "</span></p>";
}

/* First run with no network and nothing cached, or a schema we don't know. */
export function emptyStateHTML() {
  const bad = store.raw && store.raw.schema !== SUPPORTED_SCHEMA;
  if (bad) {
    return '<div class="bigempty"><h2>This trip needs a newer Wayfeather</h2>' +
      "<p>The file is schema " + esc(store.raw.schema) + " and this app reads schema " +
      esc(SUPPORTED_SCHEMA) + ". Pull the latest app.</p></div>";
  }
  return '<div class="bigempty"><h2>No trip data yet</h2>' +
    "<p>Wayfeather could not reach the trip files and nothing is cached on this " +
    "device yet. Reconnect and try again — after one successful load it works " +
    "offline.</p>" +
    '<button class="btn btn-primary" type="button" data-retry>Try again</button></div>';
}
