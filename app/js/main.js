/* main.js — boot and orchestration.

   Everything that crosses module boundaries lives here: the boot sequence, one
   document-level click delegate, and the few functions the views call each
   other through (selectDay, refreshScene, goRoute, switchTrip). Views stay
   render-only; state.js owns persistence; data.js owns the wire. */

import { $ } from "./dom.js";
import {
  store, loadGlobal, saveGlobal, loadOverlay, assemble,
  setPlaceState, wipeAll, localChangeCount,
  loadSyncSettings, syncConfig, setMutationSink, settleOverlay, loadPending, savePending
} from "./state.js";
import { load, loadIndex, loadTrip, clearDataCache, schemaOK, readErrorShort } from "./data.js";
import { sync } from "./sync.js";
import { parseBoot, syncTrip, onHashChange } from "./router.js";
import { session, resetScope } from "./session.js";
import { dayByKey, initialDayKey, placeById, isReserved } from "./trip.js";
import { setView, getView, onViewChange, wireTabKeys, setStaticTitles } from "./chrome.js";
import { toast, takeUndo } from "./toast.js";
import { burstAt } from "./confetti.js";
import {
  openSheet, openSheetEl, closeSheet, isOpen, handleKeydown, wireGrabber, wireScrim
} from "./sheets.js";
import { initPTR, refreshNow, isBusy } from "./ptr.js";
import { renderStrips, paintStrips, syncCompletion } from "./views/daystrip.js";
import {
  ctx, renderHero, renderPanels, paintPanels, repaintCard, refreshTails, refreshCounts,
  renderStamp, renderStaleBanner, renderSync
} from "./views/itinerary.js";
import {
  renderMap, routeStops, firstUnhandled, jumpTo, wireConnectivity
} from "./views/map.js";
import { cardHTML, setSkipAsk, skipAsk } from "./views/card.js";
import { renderTrips } from "./views/trips.js";
import {
  renderSettings, renderCacheRow, saveSyncForm, clearTokenField, signOut, runConnectionTest
} from "./views/settings.js";
import { paintFly } from "./icons.js";
import {
  initForms, openEdit, openAdd, openFind, saveForm, takeExtra, markSkipped, moveToExtras,
  resolveConfirm
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
  /* A pending Reserved question does not survive a whole-scene repaint: it was
     asked about a screen that is being replaced, and a confirm left standing
     over freshly-rendered content is a confirm you can answer without having
     read what you are answering about. */
  setSkipAsk(null);
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

/* One stopover is drawn by three surfaces at once — the itinerary card, the
   Details sheet's copy of that same card, and the map bar. Anything that
   changes what a stopover LOOKS like has to touch all three or they disagree,
   which is what this exists to make impossible to forget. */
function repaintStopover(id) {
  repaintCard(id);
  renderMap();
  if (detailsId === id && openSheetEl() === $("cardSheet")) paintDetails();
}

/* Raise the Reserved question on one stopover. Any question already up is
   dropped first — two cards asking at once would leave whichever one you did
   not answer stuck mid-question after the repaint. */
function askSkip(id) {
  const prev = skipAsk();
  setSkipAsk(id);
  if (prev && prev !== id) repaintStopover(prev);
  repaintStopover(id);
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
  // Landed! / Flew past are reachable from inside the Details sheet too, and
  // the card in there has to show the state it just wrote.
  if (detailsId === id && openSheetEl() === $("cardSheet")) paintDetails();
}

/* `cluster` is the map's stretch-focus seam and is currently never passed: the
   cluster-level "Walk it" button was removed (DESIGN §5, 2026-08-20) and the
   day card's Route ▸ is the single entry point. The SCOPE MODEL is deliberately
   untouched — DESIGN still lists cluster as one of the three derived viewports,
   and views/map.js still honours session.scope.cluster — so when the map grows
   its own stretch focus it calls this, rather than rebuilding the plumbing. */
function goRoute(dayKey, cluster) {
  if (dayKey && dayKey !== session.dayKey) selectDay(dayKey, { keepScope: true, keepScroll: true });
  session.scope.dayKey = dayKey || session.dayKey;
  session.scope.cluster = cluster || null;
  session.route.idx = firstUnhandled(routeStops());
  renderMap();
  setView("map");
}

/* ══ DETAILS SHEET ═════════════════════════════════════════════════════════ */
/* DESIGN §5: on the full-bleed Map tab, Details opens the app's STANDARD bottom
   sheet over the map carrying the full stopover card — the itinerary's own
   fragment, pencil and links and actions and all. Deliberately not a jump to
   the Itinerary tab: dismissing it puts you back on the map, unmoved.

   The sheet's visible header carries the day and the cluster — context the card
   itself does not have — so it never just repeats the name printed underneath
   it. The dialog's accessible name is the stopover, set here. */
let detailsId = null;

function paintDetails() {
  const p = detailsId && placeById(store.trip, detailsId);
  if (!p) { closeSheet(); return; }
  const d = dayByKey(store.trip, p.day);
  $("cardTitle").textContent = d ? (d.title || d.label || d.key) : "Stopover";
  $("cardSub").textContent = p.cluster || "";
  $("cardSheet").setAttribute("aria-label", p.name || "Stopover details");
  $("cardBody").innerHTML = cardHTML(p, ctx());
}

function openDetails(id, from) {
  if (!placeById(store.trip, id)) return;
  detailsId = id;
  paintDetails();
  openSheet($("cardSheet"), from, $("cardClose"));
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
  /* Kept whenever the network read failed — even when the cache saved the
     render — so the empty state and the stale banner can name the actual
     problem. A refused token reads as "you are offline" otherwise. */
  store.readError = res.error || null;
  return res;
}

/* Load one trip file into the store. Returns true when the scene can render. */
async function fetchTrip(id) {
  const entry = tripEntry(id);
  if (!entry) return false;
  const res = await loadTrip(entry.file);
  store.readError = res.error || null;
  if (!res.payload) return false;
  /* The filename is the PUT target for every mutation of this trip (DESIGN §4),
     so the write path learns it here rather than re-deriving it from the index
     at flush time — by then the person may have switched trips. */
  store.tripFile = entry.file;
  store.raw = res.payload;
  store.tripMeta = { fetchedAt: res.fetchedAt, stale: res.stale, sha: res.sha };
  noteSummary(id, res.payload);
  loadOverlay();
  if (schemaOK(res.payload)) assemble(); else store.trip = null;
  return true;
}

/* Pull-to-refresh and the ↻ button: re-fetch the index and the active trip.

   The pending buffer flushes FIRST (DESIGN §4). Reading before writing would
   pull down a doc that does not contain the change sitting on this phone, and
   the very next flush would then have to rebase onto data we just rendered —
   worse, the refresh would appear to "lose" the edit for a beat. Flushing first
   also means the re-GET usually returns the commit we just made, so the stamp's
   sha is the one this phone wrote. */
async function refreshData() {
  await sync.flushNow("refresh");
  await fetchIndex();
  /* A boot that could not read the index leaves no active trip — first run
     offline, or (new in M2) a token that has since been fixed in Settings.
     Once the index finally arrives, adopt a trip the way boot does, so "Try
     again" actually recovers instead of repainting the same empty state. */
  if (!tripEntry(store.activeTrip)) {
    const trips = (store.index && store.index.trips) || [];
    if (trips.length) {
      store.activeTrip = trips[0].id;
      saveGlobal();
      syncTrip(store.activeTrip);
    }
  }
  const ok = await fetchTrip(store.activeTrip);
  if (!ok) toast(readErrorShort(store.readError) || "Could not reach the trip files");
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
      const id = act.getAttribute("data-id");
      /* THE RESERVED GUARD on the card's own Flew past (DESIGN §5). Only skip
         asks — Landed! and Undo stay one-tap, because you DO land at
         reservations and undoing has nothing to protect. */
      if (a === "skip" && isReserved(placeById(store.trip, id))) { askSkip(id); return; }
      // capture geometry BEFORE the repaint destroys the button
      const rect = a === "visit" ? act.getBoundingClientRect() : null;
      applyAct(a, id);
      if (rect) burstAt(rect);
      return;
    }

    /* Answering the card/bar confirm. "no" just repaints the row back to its
       two buttons; "yes" performs the skip that was held back. */
    const ask = t.closest("[data-ask]");
    if (ask) {
      e.preventDefault();
      const id = ask.getAttribute("data-id");
      const yes = ask.getAttribute("data-ask") === "yes";
      setSkipAsk(null);
      if (yes) applyAct("skip", id);
      else repaintStopover(id);
      return;
    }

    /* The in-sheet confirm's two buttons (forms.js owns what they resolve to). */
    if (t.closest("#f-confirmYes")) { e.preventDefault(); resolveConfirm(true); return; }
    if (t.closest("#f-confirmNo")) { e.preventDefault(); resolveConfirm(false); return; }

    const take = t.closest("[data-take]");
    if (take) { e.preventDefault(); takeExtra(take.getAttribute("data-take")); return; }

    const ed = t.closest("[data-edit]");
    if (ed) {
      e.preventDefault();
      /* The pencil inside the Details sheet is a HANDOFF, not a second sheet:
         sheets.js tracks one sheet at a time, so Details is torn down
         synchronously and the editor takes its place. Without the synchronous
         close, Details' 340ms tail would fire afterwards and pull the scrim,
         the body lock and `inert` out from under the editor. */
      const id = ed.getAttribute("data-edit");
      if (t.closest("#cardSheet")) { closeSheet(true); openEdit(id, null); return; }
      openEdit(id, ed);
      return;
    }

    const det = t.closest("[data-details]");
    if (det) { e.preventDefault(); openDetails(det.getAttribute("data-details"), det); return; }

    const add = t.closest("[data-add]");
    if (add) { e.preventDefault(); openAdd(add.getAttribute("data-add"), add); return; }

    const find = t.closest("[data-find]");
    if (find) { e.preventDefault(); openFind(find.getAttribute("data-find"), find); return; }

    const r = t.closest("[data-route]");
    if (r) { e.preventDefault(); goRoute(r.getAttribute("data-route")); return; }

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
      /* The buffer holds the same changes the overlay does; leaving it behind
         would push edits that were just discarded. wipeAll() keeps the GitHub
         settings and the token — those have their own row. */
      sync.discardAll();
      loadGlobal();
      loadSyncSettings();
      loadOverlay();
      assemble();
      refreshScene();
      selectDay(initialDayKey(store.trip), {});
      toast("Local changes cleared");
      return;
    }

    /* ── sync settings (M2) ─────────────────────────────────────────────── */
    if (t.closest("#btnSaveSync")) {
      e.preventDefault();
      if (saveSyncForm()) refreshData();      // the data source moved: re-read
      return;
    }
    if (t.closest("#btnTestSync")) { e.preventDefault(); runConnectionTest(); return; }
    if (t.closest("#btnClearToken")) { e.preventDefault(); clearTokenField(); return; }
    if (t.closest("#btnSignOut")) {
      e.preventDefault();
      if (signOut()) refreshData();
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

    if (t.closest("#formClose") || t.closest("#f-cancel") || t.closest("#findClose") ||
        t.closest("#cardClose")) {
      e.preventDefault(); closeSheet(); return;
    }
    if (t.closest("#f-skip")) { e.preventDefault(); markSkipped(); return; }

    /* NOTHING else on a card navigates (DESIGN §5, decided 2026-08-20 after a
       real mis-tap on device: the "Flew past" state text was reachable through
       the old body-tap-to-edit delegate, so writing a stopover off and then
       reading the row that said so opened the edit sheet). The pencil
       ([data-edit], handled above) is the only way into the editor; state text,
       labels and meta are inert, and buttons/links keep their own actions. */
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

  /* Flush triggers (DESIGN §4). iOS has no Background Sync API, so leaving the
     screen is the last honest moment to push — `visibilitychange` fires on the
     app switcher and on lock, `pagehide` covers the cases Safari does not send
     it for, and both hand api.js a keepalive PUT so the request outlives the
     suspension. Coming back online retries whatever is still waiting. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sync.flushNow("hidden");
  });
  window.addEventListener("pagehide", () => { sync.flushNow("hidden"); });
  window.addEventListener("online", () => { sync.flushNow("online"); });

  wireTabKeys();
  wireConnectivity();          // offline drops the Map tab to the schematic
  wireScrim();
  wireGrabber($("formGrab"), $("formSheet"));
  wireGrabber($("findGrab"), $("findSheet"));
  wireGrabber($("cardGrab"), $("cardSheet"));
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
  /* Before any read: data.js asks isConfigured() to choose its transport. */
  loadSyncSettings();

  paintFly();                 // the bird glyph into index.html's static rows
  setStaticTitles();

  /* The write path. state.js reports every mutation to sync.record(); sync
     hands published values back through settleOverlay() so the local overlay
     stops shadowing what git now has. Storage and the toast are injected rather
     than imported, which is what keeps the engine testable headless. */
  sync.init({
    getConfig: syncConfig,
    toast,
    onIndicator: renderSync,
    onSettled: (entries, result) => { settleOverlay(entries, result); refreshScene(); },
    loadBuffer: loadPending,
    saveBuffer: savePending
  });
  setMutationSink(sync.record);

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
  else if (store.tripMeta.stale && store.trip) {
    const why = readErrorShort(store.readError);
    toast(why ? why + " — showing saved trip data" : "Offline — showing saved trip data");
  }

  registerSW();
  window.setInterval(() => { if (!isBusy()) { renderStamp(); renderStaleBanner(); } }, 30000);
  warmSummaries();
}

boot();
