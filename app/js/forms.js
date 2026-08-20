/* forms.js — the edit / add sheet and the "find me something" sheet.

   Both write to the local overlay (state.js), which since M2 also reports every
   mutation to the pending buffer — the same patch objects, read-modify-written
   into the trip file by sync.js a few seconds later (DESIGN §4). Nothing here
   talks to the network, and nothing here changed shape to make that work; the
   only addition is a `kind` on each write, which is what the generated commit
   message reads ("move: …" against "edit: …").

   Hooks (selectDay / refreshScene) are injected once at boot rather than
   imported, so this module never has to import main.js back. */

import { $, esc, attr } from "./dom.js";
import { localISO, fmtClock, parseClock } from "./time.js";
import {
  store, patchPlace, addStopover, snapshotPatch, restorePatch, saveOverlay
} from "./state.js";
import {
  PRIOS, placeById, dayByKey, allClusters, findPool, clusterForSlot, clusterOnMove,
  slugify, uniqueId
} from "./trip.js";
import { openSheet, closeSheet } from "./sheets.js";
import { toast } from "./toast.js";

let hooks = { selectDay() {}, refreshScene() {} };
export function initForms(h) { hooks = Object.assign(hooks, h); }

/* ── edit / add ───────────────────────────────────────────────────────────── */
/* cluster0 is the cluster the sheet was OPENED with: if the day changes and the
   user never touched the cluster field, the stopover adopts a cluster from the
   day it lands in rather than dragging "Afternoon — canyons" into Sunday. */
let form = { mode: "edit", id: null, dayKey: null, cluster0: "" };

/* The date-null day — XTRA. The trip model guarantees one exists (trip.js
   withExtras), so this never returns null for an assembled trip. */
function extrasDay() {
  const days = (store.trip && store.trip.days) || [];
  return days.find((d) => d.date == null) || null;
}

function fillSelects(dayKey) {
  const trip = store.trip;
  $("f-day").innerHTML = trip.days.map((d) =>
    '<option value="' + attr(d.key) + '">' +
    esc((d.title || d.label || d.key) + (d.date ? "" : " · unscheduled")) + "</option>"
  ).join("");
  $("f-priority").innerHTML = PRIOS.map((p) =>
    '<option value="' + attr(p[0]) + '">' + esc(p[1]) + "</option>"
  ).join("");
  // <datalist> is only partially supported in iOS Safari, so the cluster field
  // is a plain text input with the datalist as an assist, never a requirement.
  $("clusterList").innerHTML = allClusters(trip).map((c) =>
    '<option value="' + attr(c) + '"></option>'
  ).join("");
  if (dayKey) $("f-day").value = dayKey;
}

function setFields(p) {
  $("f-name").value = (p && p.name) || "";
  $("f-time").value = (p && p.time) || "";
  $("f-cluster").value = (p && p.cluster) || "";
  $("f-hours").value = (p && p.hours) || "";
  $("f-cost").value = (p && p.cost) || "";
  $("f-notes").value = (p && p.notes) || "";
  $("f-priority").value = (p && p.priority) || "yes";
}

/* The day <select> is the mover, so it is labelled for the job it is doing:
   "Move to" when editing something that already lives somewhere, "Day" when
   placing something new. The XTRA shortcut only shows when there is somewhere
   else to go. */
function paintMoveUI(mode, dayKey) {
  const xtra = extrasDay();
  const inXtra = !!xtra && xtra.key === dayKey;
  $("f-dayLabel").textContent = mode === "edit" ? "Move to" : "Day";
  $("f-movebar").hidden = !(mode === "edit" && xtra && !inXtra);
}

export function openEdit(id, opener) {
  const p = placeById(store.trip, id);
  if (!p) return;
  form = { mode: "edit", id, dayKey: p.day, cluster0: p.cluster || "" };
  $("formTitle").textContent = "Edit stopover";
  $("formSub").textContent = p.name || "";
  fillSelects(p.day);
  setFields(p);
  paintMoveUI("edit", p.day);
  $("f-danger").hidden = false;
  $("f-skip").textContent = p.priority === "skip" ? "Already skipped" : "Skip this stopover";
  $("f-skip").disabled = p.priority === "skip";
  openSheet($("formSheet"), opener, $("f-name"));
}

export function openAdd(dayKey, opener) {
  form = { mode: "add", id: null, dayKey, cluster0: "" };
  const d = dayByKey(store.trip, dayKey);
  $("formTitle").textContent = "Add a stopover";
  $("formSub").textContent = d ? (d.title || d.label || d.key) : "";
  fillSelects(dayKey);
  setFields(null);
  paintMoveUI("add", dayKey);
  $("f-danger").hidden = true;
  openSheet($("formSheet"), opener, $("f-name"));
}

export function markSkipped() {
  if (!form.id) return;
  $("f-priority").value = "skip";
  saveForm();
}

/* "FRI" / "XTRA" — the compact name, for a toast. */
function dayName(d) { return d ? (d.label || d.title || d.key) : ""; }

export function saveForm() {
  const name = $("f-name").value.trim();
  if (!name) { $("f-name").focus(); toast("A stopover needs a name"); return; }

  const day = $("f-day").value;
  const time = $("f-time").value.trim();
  const moved = form.mode === "edit" && day !== form.dayKey;
  let cluster = $("f-cluster").value.trim();
  /* Moving day with the cluster field untouched: adopt a cluster from the day
     it lands in. Type something in the field and that wins — the automatic
     choice never overwrites a deliberate one. */
  if (moved && cluster === form.cluster0) {
    cluster = clusterOnMove(store.trip, day, parseClock(time), cluster);
  }

  const fields = {
    name,
    time,
    day,
    cluster: cluster || "Inbox",
    cost: $("f-cost").value,           /* never run through .replace — "$$" */
    hours: $("f-hours").value.trim(),
    notes: $("f-notes").value.trim(),
    priority: $("f-priority").value,
    updatedAt: localISO()
  };

  if (form.mode === "add") {
    const id = uniqueId(store.trip, slugify(name));
    // This object lands in the overlay AND in the pending buffer, and is what
    // gets appended to trip.places on the next flush (DESIGN §4).
    addStopover({
      id, day: fields.day, cluster: fields.cluster, time: fields.time,
      name: fields.name, type: "", address: "", lat: null, lng: null,
      hours: fields.hours, cost: fields.cost, priority: fields.priority,
      notes: fields.notes, website: "", yelp: "", gmaps: "", warn: "",
      visited: null, skipped: null, updatedAt: fields.updatedAt
    });
    closeSheet();
    hooks.selectDay(fields.day, { keepScroll: true });
    hooks.refreshScene();
    toast("Added " + name);
  } else {
    /* Everything the undo closure needs is captured NOW: `form` is reassigned
       by the next openEdit/openAdd, and the toast lives for six seconds — long
       enough to open another card's sheet before pressing Undo. */
    const id = form.id, from = form.dayKey;
    const prior = snapshotPatch(id);
    patchPlace(id, fields, { kind: moved ? "move" : "edit" });
    closeSheet();
    if (moved) hooks.selectDay(fields.day, { keepScroll: true });
    hooks.refreshScene();
    /* A move is worth naming — and worth an undo, because it is the one edit
       that makes a card vanish from the day you were looking at. */
    if (moved) {
      toast(name + " → " + dayName(dayByKey(store.trip, fields.day)), () => {
        restorePatch(id, prior);
        hooks.selectDay(from, { keepScroll: true });
        hooks.refreshScene();
        toast("Moved " + name + " back");
      });
    } else {
      toast("Saved " + name);
    }
  }
}

/* One tap out of the day: "Send to XTRA" in the edit sheet. Same patch shape as
   every other edit — day (+ cluster) into the overlay — so it rides the same
   Contents-API PUT as everything else (DESIGN §4). The full mover is the day
   <select> above it, which lists every day including XTRA. */
export function moveTo(dayKey) {
  const trip = store.trip;
  const p = form.id ? placeById(trip, form.id) : null;
  const d = dayByKey(trip, dayKey);
  if (!p || !d || p.day === dayKey) return;
  const from = p.day;
  const prior = snapshotPatch(p.id);
  const cluster = clusterOnMove(trip, dayKey, parseClock(p.time), p.cluster);

  patchPlace(p.id, { day: dayKey, cluster, updatedAt: localISO() }, { kind: "move" });
  closeSheet();
  hooks.selectDay(dayKey, { keepScroll: true });
  hooks.refreshScene();

  toast(p.name + " → " + dayName(d), () => {
    restorePatch(p.id, prior);
    hooks.selectDay(from, { keepScroll: true });
    hooks.refreshScene();
    toast("Moved " + p.name + " back");
  });
}

export function moveToExtras() {
  const d = extrasDay();
  if (d) moveTo(d.key);
}

/* ── find me something ────────────────────────────────────────────────────── */
let findDayKey = null;

export function openFind(dayKey, opener) {
  findDayKey = dayKey;
  const trip = store.trip;
  const d = dayByKey(trip, dayKey);
  const pool = findPool(trip);
  $("findSub").textContent = pool.length + (pool.length === 1 ? " idea" : " ideas") +
    " you haven't handled · drops into " + (d ? (d.title || d.label || d.key) : "today");
  $("findBody").innerHTML = pool.length
    ? pool.map((p) => {
        const bits = [];
        if (p.type) bits.push(esc(p.type));
        if (p.hours) bits.push(esc(p.hours));
        if (p.cost) bits.push(esc(p.cost));
        return '<div class="findrow">' +
          '<span class="findrow-main">' +
            '<span class="findrow-name">' + esc(p.name || "") + "</span>" +
            (bits.length ? '<span class="findrow-sub">' +
              bits.join('<span aria-hidden="true"> · </span>') + "</span>" : "") +
          "</span>" +
          '<button class="btn btn-primary" type="button" data-take="' + attr(p.id) + '" ' +
            'aria-label="Add ' + attr(p.name || "this stopover") + ' to this day">Add</button>' +
        "</div>";
      }).join("")
    : '<p class="empty">Nothing left in the extras pool.</p>';
  openSheet($("findSheet"), opener, $("findClose"));
}

/* Stamp the extra with the current time and move it into the day; the day's
   chronological sort does the slotting, so there is no insertion index. */
export function takeExtra(id) {
  const trip = store.trip;
  const p = placeById(trip, id);
  if (!p) return;
  const when = fmtClock(new Date(), trip.tz);
  const mins = parseClock(when);
  const cluster = clusterForSlot(trip, findDayKey, mins === null ? 0 : mins, p.cluster);
  const prior = snapshotPatch(id);

  patchPlace(id, { day: findDayKey, time: when, cluster, updatedAt: localISO() },
    { kind: "move" });
  closeSheet();
  hooks.selectDay(findDayKey, { keepScroll: true });
  hooks.refreshScene();

  toast(p.name + " → " + when, () => {
    restorePatch(id, prior);
    saveOverlay();
    hooks.refreshScene();
    toast("Put " + p.name + " back in the extras");
  });
}
