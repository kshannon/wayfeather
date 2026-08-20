/* main.js — boot and orchestration.

   Everything that crosses module boundaries lives here: the boot sequence, one
   document-level click delegate, and the few functions the views call each
   other through (selectDay, refreshScene, goRoute, switchTrip). Views stay
   render-only; state.js owns persistence; data.js owns the wire. */

import { $ } from "./dom.js";
import {
  store, loadGlobal, saveGlobal, loadOverlay, assemble,
  setPlaceState, wipeAll, localChangeCount
} from "./state.js";
import { load, loadIndex, loadTrip, clearDataCache, schemaOK } from "./data.js";
import { parseBoot, syncTrip, onHashChange } from "./router.js";
import { session, resetScope } from "./session.js";
import { dayByKey, initialDayKey } from "./trip.js";
import { setView, getView, onViewChange, wireTabKeys, setStaticTitles } from "./chrome.js";
import { toast, takeUndo } from "./toast.js";
import { burstAt } from "./confetti.js";
import { closeSheet, isOpen, handleKeydown, wireGrabber, wireScrim } from "./sheets.js";
import { initPTR, refreshNow, isBusy } from "./ptr.js";
import { renderStrips, paintStrips, syncCompletion } from "./views/daystrip.js";
import {
  renderHero, renderPanels, paintPanels, repaintCard, refreshTails, refreshCounts,
  renderStamp, renderStaleBanner
} from "./views/itinerary.js";
import {
  renderMap, routeStops, firstUnhandled, jumpTo, clearClusterScope, wireConnectivity
} from "./views/map.js";
import { renderTrips } from "./views/trips.js";
import { renderSettings, renderCacheRow } from "./views/settings.js";
import { paintFly } from "./icons.js";
import {
  initForms, openEdit, openAdd, openFind, saveForm, takeExtra, markSkipped, moveToExtras
} from "./forms.js";

/* ══ SCENE ═════════════════════════════════════════════════════════════════ */
function selectDay(key, opts) {
  opts = opts || {};
  const trip = store.trip;
  if (!trip || !trip.days.length) return;
  if (!dayByKey(trip, key)) key = trip.days[0].key;
  const changed = session.dayKey !== key;
  session.dayKey = key;
  if (changed || !opts.keepScope) resetScope(key);
  paintStrips(key, !!opts.moveFocus);
  paintPanels(key);
  if (!opts.keepScroll && getView() === "itinerary") window.scrollTo(0, 0);
  renderMap();
}

/* Full scene repaint that keeps where you were standing. */
function refreshScene() {
  const y = window.pageYOffset || document.documentElement.scrollTop || 0;
  renderHero();
  renderPanels();
  if (store.trip) {
    renderStrips(store.trip);
    paintStrips(session.dayKey, false);
    paintPanels(session.dayKey);
  }
  renderMap();
  renderTrips();
  renderSettings();
  renderStamp();
  renderStaleBanner();
  window.scrollTo(0, y);
}

function applyAct(act, id) {
  setPlaceState(id, act);
  repaintCard(id);
  syncCompletion(store.trip);
  refreshCounts();
  renderMap();
  // the tail's "Find me something" appears/disappears with the pool, and an
  // extra can be handled straight from the XTRA day
  refreshTails();
}

function goRoute(dayKey, cluster) {
  if (dayKey && dayKey !== session.dayKey) selectDay(dayKey, { keepScope: true, keepScroll: true });
  session.scope.dayKey = dayKey || session.dayKey;
  session.scope.cluster = cluster || null;
  session.route.idx = firstUnhandled(routeStops());
  renderMap();
  setView("map");
}

/* ══ DATA ══════════════════════════════════════════════════════════════════ */
function tripEntry(id) {
  const trips = (store.index && store.index.trips) || [];
  return trips.find((t) => t.id === id) || null;
}

function noteSummary(id, payload) {
  if (!payload) return;
  store.summaries[id] = {
    end: payload.end || null,
    tz: payload.tz || null,
    dayCount: (payload.days || []).filter((d) => d.date).length
  };
}

async function fetchIndex() {
  const res = await loadIndex();
  if (res.payload) {
    store.index = res.payload;
    store.indexMeta = { fetchedAt: res.fetchedAt, stale: res.stale, sha: res.sha };
  }
  return res;
}

/* Load one trip file into the store. Returns true when the scene can render. */
async function fetchTrip(id) {
  const entry = tripEntry(id);
  if (!entry) return false;
  const res = await loadTrip(entry.file);
  if (!res.payload) return false;
  store.raw = res.payload;
  store.tripMeta = { fetchedAt: res.fetchedAt, stale: res.stale, sha: res.sha };
  noteSummary(id, res.payload);
  loadOverlay();
  if (schemaOK(res.payload)) assemble(); else store.trip = null;
  return true;
}

/* Pull-to-refresh and the ↻ button: re-fetch the index and the active trip. */
async function refreshData() {
  await fetchIndex();
  const ok = await fetchTrip(store.activeTrip);
  if (!ok) toast("Could not reach the trip files");
  if (store.trip && !dayByKey(store.trip, session.dayKey)) session.dayKey = initialDayKey(store.trip);
  refreshScene();
  if (store.trip) { paintStrips(session.dayKey, false); paintPanels(session.dayKey); }
}

async function switchTrip(id) {
  if (id === store.activeTrip) { setView("itinerary"); return; }
  if (!tripEntry(id)) return;
  store.activeTrip = id;
  saveGlobal();
  syncTrip(id);
  const ok = await fetchTrip(id);
  if (!ok) { toast("Could not open that trip"); return; }
  session.dayKey = store.trip ? initialDayKey(store.trip) : null;
  refreshScene();
  selectDay(session.dayKey, {});
  setView("itinerary");
  toast("Switched to " + ((store.trip && store.trip.name) || id));
}

/* After first paint, pull the other trip files in so the Trips tab can group
   past/upcoming — and so switching trips works offline later. */
async function warmSummaries() {
  const trips = (store.index && store.index.trips) || [];
  for (const e of trips) {
    if (store.summaries[e.id]) continue;
    const res = await load(e.file);
    if (res.payload) noteSummary(e.id, res.payload);
  }
  renderTrips();
}

/* ══ EVENTS ════════════════════════════════════════════════════════════════ */
function wireEvents() {
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;

    if (t.closest("#toastUndo")) {
      e.preventDefault();
      const fn = takeUndo();
      if (fn) fn();
      return;
    }

    const act = t.closest("[data-act]");
    if (act) {
      e.preventDefault();
      const a = act.getAttribute("data-act");
      // capture geometry BEFORE the repaint destroys the button
      const rect = a === "visit" ? act.getBoundingClientRect() : null;
      applyAct(a, act.getAttribute("data-id"));
      if (rect) burstAt(rect);
      return;
    }

    const take = t.closest("[data-take]");
    if (take) { e.preventDefault(); takeExtra(take.getAttribute("data-take")); return; }

    const ed = t.closest("[data-edit]");
    if (ed) { e.preventDefault(); openEdit(ed.getAttribute("data-edit"), ed); return; }

    const add = t.closest("[data-add]");
    if (add) { e.preventDefault(); openAdd(add.getAttribute("data-add"), add); return; }

    const find = t.closest("[data-find]");
    if (find) { e.preventDefault(); openFind(find.getAttribute("data-find"), find); return; }

    const r = t.closest("[data-route]");
    if (r) {
      e.preventDefault();
      goRoute(r.getAttribute("data-route"), r.getAttribute("data-cluster"));
      return;
    }

    if (t.closest("#btnWholeDay")) { e.preventDefault(); clearClusterScope(); return; }

    const n = t.closest("[data-node]");
    if (n) { e.preventDefault(); jumpTo(parseInt(n.getAttribute("data-node"), 10)); return; }

    const c = t.closest("[data-cyc]");
    if (c) { e.preventDefault(); jumpTo(session.route.idx + parseInt(c.getAttribute("data-cyc"), 10)); return; }

    const nav = t.closest("[data-view]");
    if (nav) { e.preventDefault(); setView(nav.getAttribute("data-view")); return; }

    const dtab = t.closest("[data-key]");
    if (dtab && dtab.classList.contains("dblock")) {
      selectDay(dtab.getAttribute("data-key"), {});
      return;
    }
    const mtab = t.closest("[data-mday]");
    if (mtab) { selectDay(mtab.getAttribute("data-mday"), { keepScroll: true }); return; }

    const trip = t.closest("[data-trip]");
    if (trip) { e.preventDefault(); switchTrip(trip.getAttribute("data-trip")); return; }

    if (t.closest("#f-xtra")) { e.preventDefault(); moveToExtras(); return; }

    if (t.closest("#btnReset")) {
      e.preventDefault();
      const n2 = localChangeCount();
      const msg = n2
        ? "Clear " + n2 + " local change" + (n2 === 1 ? "" : "s") +
          " on this device? Every trip goes back to the published data."
        : "Nothing has been changed on this device. Clear anyway?";
      if (!window.confirm(msg)) return;
      wipeAll();
      loadGlobal();
      loadOverlay();
      assemble();
      refreshScene();
      selectDay(initialDayKey(store.trip), {});
      toast("Local changes cleared");
      return;
    }

    if (t.closest("#btnClearCache")) {
      e.preventDefault();
      if (!window.confirm("Clear the offline data cache? The app will need the " +
        "network on next open until it refetches.")) return;
      clearDataCache().then(() => { renderCacheRow(); toast("Offline cache cleared"); });
      return;
    }

    if (t.closest("[data-retry]")) { e.preventDefault(); refreshNow(); return; }
    if (t.closest("#btnRefresh")) { e.preventDefault(); refreshNow(); return; }

    if (t.closest("#formClose") || t.closest("#f-cancel") || t.closest("#findClose")) {
      e.preventDefault(); closeSheet(); return;
    }
    if (t.closest("#f-skip")) { e.preventDefault(); markSkipped(); return; }

    // tapping a card body (never its buttons or links) opens the editor
    const open = t.closest("[data-open]");
    if (open && !t.closest("button") && !t.closest("a")) {
      openEdit(open.getAttribute("data-open"), null);
    }
  });

  $("formBody").addEventListener("submit", (e) => { e.preventDefault(); saveForm(); });

  /* day tablist keyboard */
  $("dayTabs").addEventListener("keydown", (e) => {
    if (!store.trip) return;
    const keys = store.trip.days.map((d) => d.key);
    const i = keys.indexOf(session.dayKey);
    let next = null;
    if (e.key === "ArrowRight") next = keys[(i + 1) % keys.length];
    else if (e.key === "ArrowLeft") next = keys[(i - 1 + keys.length) % keys.length];
    else if (e.key === "Home") next = keys[0];
    else if (e.key === "End") next = keys[keys.length - 1];
    if (next) { e.preventDefault(); selectDay(next, { moveFocus: true }); }
  });

  document.addEventListener("keydown", (e) => {
    if (handleKeydown(e)) return;                 // a sheet owns the keyboard
    if (getView() === "map") {
      if (e.key === "ArrowRight") { e.preventDefault(); jumpTo(session.route.idx + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); jumpTo(session.route.idx - 1); }
    }
  });

  wireTabKeys();
  wireConnectivity();          // offline drops the Map tab to the schematic
  wireScrim();
  wireGrabber($("formGrab"), $("formSheet"));
  wireGrabber($("findGrab"), $("findSheet"));
  onHashChange((v) => setView(v));
  onViewChange((v) => { if (v === "map") renderMap(); });
}

/* ══ SERVICE WORKER ════════════════════════════════════════════════════════ */
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  // resolved from this module, so it works at any host path; the default scope
  // is the script's own directory (app/), which deliberately excludes /data/
  const url = new URL("../sw.js", import.meta.url);
  const go = () => navigator.serviceWorker.register(url)
    .catch(() => { /* http:// on a non-localhost origin, private mode, etc. */ });
  // boot() awaits the network before it gets here, so "load" has usually fired
  // already — attaching a listener unconditionally would silently never run.
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

/* ══ BOOT ══════════════════════════════════════════════════════════════════ */
async function boot() {
  const intent = parseBoot();

  if (intent.reset) { wipeAll(); await clearDataCache(); }
  loadGlobal();

  paintFly();                 // the bird glyph into index.html's static rows
  setStaticTitles();
  initForms({ selectDay, refreshScene });
  wireEvents();
  initPTR({
    canPull: () => getView() === "itinerary" && !isOpen(),
    onRefresh: refreshData
  });

  await fetchIndex();

  // ?trip wins, then whatever this device had open, then the first listed trip
  const trips = (store.index && store.index.trips) || [];
  const wanted = [intent.trip, store.activeTrip, trips[0] && trips[0].id]
    .find((id) => id && tripEntry(id));
  store.activeTrip = wanted || "";
  if (store.activeTrip) {
    saveGlobal();
    await fetchTrip(store.activeTrip);
  }

  renderHero();
  renderPanels();
  if (store.trip) {
    renderStrips(store.trip);
    session.dayKey = initialDayKey(store.trip);
    resetScope(session.dayKey);
  }
  renderMap();
  renderTrips();
  renderSettings();
  renderStamp();
  renderStaleBanner();

  setView(intent.view || "itinerary");
  if (store.trip) selectDay(session.dayKey, {});

  if (intent.reset) toast("Local changes cleared");
  else if (store.tripMeta.stale && store.trip) toast("Offline — showing saved trip data");

  registerSW();
  window.setInterval(() => { if (!isBusy()) { renderStamp(); renderStaleBanner(); } }, 30000);
  warmSummaries();
}

boot();
