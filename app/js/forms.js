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
  slugify, uniqueId, formatCost, parseCost, isReserved
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
  /* NOT `|| ""` — a cost of 0 is falsy and would blank the field, quietly
     turning "this is free" back into "nobody has priced this" on every save. */
  $("f-cost").value = (p && typeof p.cost === "number") ? String(p.cost) : "";
  $("f-notes").value = (p && p.notes) || "";
  $("f-priority").value = (p && p.priority) || "yes";
  $("f-reserved").checked = !!(p && p.reserved === true);
  $("f-callahead").checked = !!(p && p.callAhead === true);
  $("f-phone").value = (p && p.phone) || "";
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

/* ── the Reserved guard, in-sheet (DESIGN §5) ─────────────────────────────────
   `reserved` stopovers are protected, not locked: one confirmation stands
   between you and a move or a skip, and nothing stands between you and a notes,
   hours, cost, link or Landed! edit. The guard is a speed bump that says "this
   one costs money", not a wall.

   It is drawn INSIDE the sheet rather than raised as a second sheet because
   sheets.js tracks exactly one open sheet at a time — a confirm sheet stacked
   over the editor would tear the editor's scrim, body lock and `inert` down
   behind it when it closed. So the sheet's own footer swaps: the actions and
   the danger zone step aside, the question takes their place, and answering
   puts everything back. One sheet, two footers.

   The pending action is a closure, so the same confirm serves the save, the
   XTRA shortcut and the soft delete without knowing what any of them do. */
let pendingConfirm = null;

function askConfirm(verb, fn) {
  pendingConfirm = fn;
  $("f-confirmYes").textContent = verb;
  $("f-confirm").hidden = false;
  $("f-acts").hidden = true;
  $("f-danger").hidden = true;
  $("f-confirmNo").focus();
}

function hideConfirm() {
  pendingConfirm = null;
  $("f-confirm").hidden = true;
  $("f-acts").hidden = false;
  $("f-danger").hidden = form.mode !== "edit";
}

/* Answering the question. main.js routes both footer buttons here. */
export function resolveConfirm(yes) {
  const fn = pendingConfirm;
  hideConfirm();
  if (yes && fn) fn();
}

/* A save is a MOVE when it changes where or when the stopover sits. Compared
   against the stored place, not against the field's initial text, so retyping
   the same time is not a move and does not ask.

   The STORED priority/reserved flag is what arms the guard — not the toggle's
   current position. Un-ticking Reserved and moving it in one save is still
   moving something that is booked right now, and that is the save most worth
   one question. */
function isMove(p, fields) {
  return !!p && (fields.time !== (p.time || "") ||
                 fields.day !== p.day ||
                 fields.cluster !== (p.cluster || ""));
}

export function openEdit(id, opener) {
  const p = placeById(store.trip, id);
  if (!p) return;
  form = { mode: "edit", id, dayKey: p.day, cluster0: p.cluster || "" };
  hideConfirm();
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
  hideConfirm();
  const d = dayByKey(store.trip, dayKey);
  $("formTitle").textContent = "Add a stopover";
  $("formSub").textContent = d ? (d.title || d.label || d.key) : "";
  fillSelects(dayKey);
  setFields(null);
  paintMoveUI("add", dayKey);
  $("f-danger").hidden = true;
  openSheet($("formSheet"), opener, $("f-name"));
}

/* The sheet's soft delete. Guarded exactly like the card's Flew past, and
   guarded HERE rather than inside saveForm, so the save it delegates to does
   not ask a second question about the same tap. */
export function markSkipped(opts) {
  if (!form.id) return;
  const p = placeById(store.trip, form.id);
  if (!(opts && opts.confirmed) && isReserved(p)) {
    askConfirm("Skip it", () => markSkipped({ confirmed: true }));
    return;
  }
  $("f-priority").value = "skip";
  saveForm({ confirmed: true });
}

/* "FRI" / "XTRA" — the compact name, for a toast. */
function dayName(d) { return d ? (d.label || d.title || d.key) : ""; }

export function saveForm(opts) {
  const name = $("f-name").value.trim();
  if (!name) { $("f-name").focus(); toast("A stopover needs a name"); return; }

  /* NaN means "they typed something that is not a number". Refusing beats
     coercing: silently storing null would throw away a price someone just
     entered, and storing 0 would claim it was free. */
  const cost = parseCost($("f-cost").value);
  if (Number.isNaN(cost)) {
    $("f-cost").focus();
    toast("Cost must be a number — leave it blank if it varies");
    return;
  }

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
    cost,                              /* a number or null — schema 2 */
    hours: $("f-hours").value.trim(),
    notes: $("f-notes").value.trim(),
    priority: $("f-priority").value,
    reserved: $("f-reserved").checked,
    callAhead: $("f-callahead").checked,
    phone: $("f-phone").value.trim(),
    updatedAt: localISO()
  };

  /* The guard. Everything above has already been read off the form, so the
     confirm can simply re-enter this function — the fields are still on screen
     and still say the same thing. */
  const before = form.mode === "edit" ? placeById(store.trip, form.id) : null;
  if (!(opts && opts.confirmed) && isReserved(before) && isMove(before, fields)) {
    askConfirm("Change anyway", () => saveForm({ confirmed: true }));
    return;
  }

  if (form.mode === "add") {
    const id = uniqueId(store.trip, slugify(name));
    // This object lands in the overlay AND in the pending buffer, and is what
    // gets appended to trip.places on the next flush (DESIGN §4).
    addStopover({
      id, day: fields.day, cluster: fields.cluster, time: fields.time,
      name: fields.name, type: "", address: "", lat: null, lng: null,
      hours: fields.hours, cost: fields.cost, priority: fields.priority,
      reserved: fields.reserved, callAhead: fields.callAhead, phone: fields.phone,
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
export function moveTo(dayKey, opts) {
  const trip = store.trip;
  const p = form.id ? placeById(trip, form.id) : null;
  const d = dayByKey(trip, dayKey);
  if (!p || !d || p.day === dayKey) return;
  /* "Send to XTRA" is a one-tap day change, which is exactly the move the guard
     is for — it must not be the back door around the confirm the day <select>
     above it goes through. */
  if (!(opts && opts.confirmed) && isReserved(p)) {
    askConfirm("Move anyway", () => moveTo(dayKey, { confirmed: true }));
    return;
  }
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
        /* formatCost's "" is the only "no cost to show" signal — a truthiness
           test on p.cost would drop a genuine 0 and hide "Free". */
        const money = formatCost(p.cost);
        if (money) bits.push(esc(money));
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
