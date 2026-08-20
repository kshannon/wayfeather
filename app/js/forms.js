/* forms.js — the edit / add sheet and the "find me something" sheet.

   Both write to the local overlay (state.js). In M2 the exact same field
   objects become read-modify-write PUTs through the Contents API (DESIGN §4) —
   same patches, different transport.

   Hooks (selectDay / refreshScene) are injected once at boot rather than
   imported, so this module never has to import main.js back. */

import { $, esc, attr } from "./dom.js";
import { localISO, fmtClock, parseClock } from "./time.js";
import {
  store, patchPlace, addStopover, snapshotPatch, restorePatch, saveOverlay
} from "./state.js";
import {
  PRIOS, placeById, dayByKey, allClusters, findPool, clusterForSlot, slugify, uniqueId
} from "./trip.js";
import { openSheet, closeSheet } from "./sheets.js";
import { toast } from "./toast.js";

let hooks = { selectDay() {}, refreshScene() {} };
export function initForms(h) { hooks = Object.assign(hooks, h); }

/* ── edit / add ───────────────────────────────────────────────────────────── */
let form = { mode: "edit", id: null, dayKey: null };

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

export function openEdit(id, opener) {
  const p = placeById(store.trip, id);
  if (!p) return;
  form = { mode: "edit", id, dayKey: p.day };
  $("formTitle").textContent = "Edit stopover";
  $("formSub").textContent = p.name || "";
  fillSelects(p.day);
  setFields(p);
  $("f-danger").hidden = false;
  $("f-skip").textContent = p.priority === "skip" ? "Already skipped" : "Skip this stopover";
  $("f-skip").disabled = p.priority === "skip";
  openSheet($("formSheet"), opener, $("f-name"));
}

export function openAdd(dayKey, opener) {
  form = { mode: "add", id: null, dayKey };
  const d = dayByKey(store.trip, dayKey);
  $("formTitle").textContent = "Add a stopover";
  $("formSub").textContent = d ? (d.title || d.label || d.key) : "";
  fillSelects(dayKey);
  setFields(null);
  $("f-danger").hidden = true;
  openSheet($("formSheet"), opener, $("f-name"));
}

export function markSkipped() {
  if (!form.id) return;
  $("f-priority").value = "skip";
  saveForm();
}

export function saveForm() {
  const name = $("f-name").value.trim();
  if (!name) { $("f-name").focus(); toast("A stopover needs a name"); return; }
  const fields = {
    name,
    time: $("f-time").value.trim(),
    day: $("f-day").value,
    cluster: $("f-cluster").value.trim() || "Inbox",
    cost: $("f-cost").value,           /* never run through .replace — "$$" */
    hours: $("f-hours").value.trim(),
    notes: $("f-notes").value.trim(),
    priority: $("f-priority").value,
    updatedAt: localISO()
  };

  if (form.mode === "add") {
    const id = uniqueId(store.trip, slugify(name));
    // In M2 this same object is what gets pushed into the trip file and PUT
    // through the Contents API (DESIGN §4); here it lands in the overlay.
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
    patchPlace(form.id, fields);
    closeSheet();
    if (fields.day !== form.dayKey) hooks.selectDay(fields.day, { keepScroll: true });
    hooks.refreshScene();
    toast("Saved " + name);
  }
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

  patchPlace(id, { day: findDayKey, time: when, cluster, updatedAt: localISO() });
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
