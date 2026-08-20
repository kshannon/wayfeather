/* views/itinerary.js — the day view: large-title header, day panels grouped by
   cluster, the per-day list tail, the refresh stamp and the offline banner. */

import { $, esc, attr, q, frag, replaceWith } from "../dom.js";
import { rangeLabel, relTime, fmtClock } from "../time.js";
import { deriveLoc, appleMapsUrl } from "../links.js";
import { NEST_SVG, BIRD_SVG, OFFLINE_SVG } from "../icons.js";
import { store } from "../state.js";
import { TRIP_SCHEMA, schemaMessage, readErrorText, readErrorShort } from "../data.js";
import { shortSha } from "../api.js";
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

  /* the Nest: the trip's base, still the Apple Maps deep link (DESIGN §5) */
  const b = trip.base;
  $("heroBase").innerHTML = (b && b.name)
    ? '<a class="lt-base" href="' + attr(appleMapsUrl(b.name, b.address)) + '" ' +
        'target="_blank" rel="noopener noreferrer" ' +
        'aria-label="Open the Nest, ' + attr(b.name) + ', in Apple Maps">' +
        NEST_SVG + '<span class="lbl">Nest · ' + esc(b.name) + "</span></a>"
    : "";

  $("tripNotes").textContent = trip.notes || "";
  document.title = (trip.name || "Wayfeather") + " — Wayfeather";
  setTitle("itinerary", trip.name || "Wayfeather");
}

/* ── panels ───────────────────────────────────────────────────────────────── */
/* A cluster header is a LABEL, not a control (DESIGN §5, decided 2026-08-20).
   The per-cluster "Walk it" button that used to sit here is gone — the owner
   asked twice what it did, which was the verdict. The day card's Route ▸ is now
   the single entry to the map, and stretch focus is the map's own job. */
function clusterHTML(name, stops, c) {
  return '<section class="cluster">' +
    '<div class="cluster-head">' +
      '<h3 class="cluster-name">' +
        '<span class="cluster-dot" aria-hidden="true"></span>' +
        "<span>" + esc(name) + "</span>" +
      "</h3>" +
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
        clusterHTML(name, stops.filter((s) => s.cluster === name), c)
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
        /* days[].plan — the optional longer paragraph, in the serif (DESIGN §5).
           Full width under the title block, not indented past the bullet. */
        (day.plan ? '<p class="dayplan">' + esc(day.plan) + "</p>" : "") +
        '<div class="dayhead-foot">' +
          '<span class="dayhead-count" data-count="' + attr(day.key) + '">' +
            esc(countText(trip, day)) + "</span>" +
          (routable.length >= 2
            ? '<button class="btn btn-card" type="button" data-route="' + attr(day.key) + '" ' +
              'aria-label="Open the map for ' + attr(day.title || day.label || day.key) + '">Route' +
              BIRD_SVG + "</button>"
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

/* ── stamp + sync indicator + offline banner ──────────────────────────────── */
/* The sha is the real one now: the Contents API returns the blob sha with every
   read (M2), so "updated just now · a1b2c3d" finally means something you can
   check against the other phone. A static fetch still has no sha and the app
   still refuses to invent one, so that mode prints only the time. */
export function renderStamp() {
  const meta = store.tripMeta;
  const when = meta.fetchedAt ? fmtClock(new Date(meta.fetchedAt), store.trip && store.trip.tz) : "";
  const rel = meta.fetchedAt ? relTime(meta.fetchedAt) : "never";
  const sha = shortSha(meta.sha);
  $("stamp").innerHTML = "updated " + esc(rel) +
    (when ? '<span aria-hidden="true">·</span><b>' + esc(when) + "</b>" : "") +
    (sha ? '<span aria-hidden="true">·</span><b>' + esc(sha) + "</b>" : "");
}

/* Fed by sync.js (DESIGN §4). Hidden when there is nothing to report, which is
   the normal state of a phone that has not touched anything. */
export function renderSync(s) {
  const el = $("syncLine");
  if (!el) return;
  const text = (s && s.text) || "";
  el.textContent = text;
  el.className = "syncline is-" + ((s && s.state) || "idle");
  el.hidden = !text;
}

/* DESIGN §4's banner, with one M2 addition: it only claims "offline" when that
   is actually the diagnosis. A phone with full signal and an expired token was
   being told to check its connection. */
export function renderStaleBanner() {
  const meta = store.tripMeta;
  const box = $("staleBanner");
  if (!meta.stale || !store.trip) { box.innerHTML = ""; return; }
  const why = readErrorShort(store.readError) || "offline";
  box.innerHTML = '<p class="stale">' + OFFLINE_SVG +
    "<span>" + esc(why) + " · data from " +
    esc(meta.fetchedAt ? relTime(meta.fetchedAt) : "an earlier session") +
    "</span></p>";
}

/* First run with no network and nothing cached, or a schema we don't know. */
export function emptyStateHTML() {
  const bad = store.raw && store.raw.schema !== TRIP_SCHEMA;
  if (bad) {
    /* Old data gets a retry: refreshing is exactly the fix when the migrated
       file is already published and this phone is holding a cached copy. Data
       from the FUTURE gets no button — there is nothing this app can re-fetch
       that would help, and a dead "Try again" is worse than no button. */
    const m = schemaMessage(store.raw.schema);
    const stale = Number(store.raw.schema) < TRIP_SCHEMA;
    return '<div class="bigempty"><h2>' + esc(m.title) + "</h2>" +
      "<p>" + esc(m.body) + "</p>" +
      (stale ? '<button class="btn btn-primary" type="button" data-retry>Try again</button>' : "") +
      "</div>";
  }
  /* With Settings configured, "could not reach the trip files" is often the
     wrong answer — the network is fine and the token has expired. When the read
     path knows better, it says so, and the retry button stays either way. */
  const why = readErrorText(store.readError);
  if (why) {
    return '<div class="bigempty"><h2>Cannot read the trip files</h2>' +
      "<p>" + esc(why) + "</p>" +
      '<button class="btn btn-primary" type="button" data-retry>Try again</button></div>';
  }
  return '<div class="bigempty"><h2>No trip data yet</h2>' +
    "<p>Wayfeather could not reach the trip files and nothing is cached on this " +
    "device yet. Reconnect and try again — after one successful load it works " +
    "offline.</p>" +
    '<button class="btn btn-primary" type="button" data-retry>Try again</button></div>';
}
