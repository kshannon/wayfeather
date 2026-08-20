/* trip.js — the trip model as pure functions over an assembled trip object.
   No DOM, no storage, no fetching: given a trip, answer questions about it.
   ("Stopover" is the UI's word for a place — DESIGN §5.) */

import { parseClock, parseISO, todayIn, MON, dayGap } from "./time.js";

/* ── the status axes (DESIGN §3, schema 2) ────────────────────────────────────
   The old flat ten-value enum conflated three unrelated questions. Schema 2
   splits them: `priority` answers only "how badly do I want this", while
   `reserved` (booked or paid) and `callAhead` (unverified, ring first) are
   orthogonal booleans that compose with any want-level. A reserved must is now
   expressible; under the old enum you had to pick one and lose the other. */
export const PRIOS = [
  ["must", "Must"], ["yes", "Yes"], ["maybe", "Maybe"], ["skip", "Skip"],
  ["note", "Note — text row, no links"]
];

/* The corner chip, by want-level. `yes` is deliberately absent — the default
   want-level is unmarked, which is what makes the marked ones read. */
export const CHIP = {
  must:  ["must",  "★ Must"],
  maybe: ["maybe", "Maybe"]
};

/* ★★ Reserved — the loudest mark in the system (DESIGN §5). Not in CHIP because
   it is not a want-level: it is the `reserved` boolean, and it can sit on top of
   any priority. */
export const RESERVED_CHIP = ["reserved", "★★ Reserved"];

export function isReserved(p) { return !!p && p.reserved === true; }
export function needsCall(p) { return !!p && p.callAhead === true; }

/* The ONE chip a card's corner shows, or null. ★★ wins the corner outright —
   "you have paid for this" outranks "you want this" — and the reservation glyph
   beside the time carries the reservation on its own besides. */
export function chipOf(p) {
  if (!p || isVisited(p) || isSkipped(p)) return null;
  if (isReserved(p)) return RESERVED_CHIP;
  return CHIP[p.priority] || null;
}

/* ── the XTRA guarantee (DESIGN §5) ───────────────────────────────────────── */
/* A trip file need not ship a bonus day — river-road-test doesn't — but the UI
   promises one: "Move to… XTRA" and "Find me something" both need somewhere for
   an unscheduled idea to live. So the day list is normalised on the way in: if
   nothing in it is date-null, one is synthesized. It is a plain day object, so
   nothing downstream has to know it was invented, and it is NOT written back to
   the trip file — a synthesized day with no stopovers in it simply disappears
   again the moment real data grows one.

   Pure: days in, days out. The caller (state.assemble) owns when it happens. */
export function withExtras(days) {
  const list = Array.isArray(days) ? days.slice() : [];
  if (list.some((d) => d && d.date == null)) return list;
  const taken = Object.create(null);
  list.forEach((d) => { if (d && d.key) taken[d.key] = 1; });
  let key = "bonus";
  for (let n = 2; taken[key]; n++) key = "bonus-" + n;
  list.push({ key, label: "XTRA", title: "Extras", bullet: "+", date: null,
              subtitle: "Unscheduled — slot into any open block" });
  return list;
}

export function tripToday(trip) { return todayIn(trip && trip.tz); }

export function placeById(trip, id) {
  return trip.places.find((p) => p.id === id) || null;
}

export function dayByKey(trip, k) {
  return trip.days.find((d) => d.key === k) || null;
}

export function isNote(p) { return p.priority === "note"; }

/* Chronological slotting: parsed h:mm AM/PM times sort; everything else keeps
   data order at the tail. This is what makes "Find me something" a pure patch
   (day + time) with no insertion index to compute. */
export function orderDay(list) {
  const timed = [], plain = [];
  list.forEach((p, i) => {
    const m = parseClock(p.time);
    if (m === null) plain.push({ p, i }); else timed.push({ p, i, m });
  });
  timed.sort((a, b) => (a.m - b.m) || (a.i - b.i));
  return timed.map((x) => x.p).concat(plain.map((x) => x.p));
}

export function placesOfDay(trip, k) {
  return orderDay(trip.places.filter((p) => p.day === k));
}

export function actionableOfDay(trip, k) {
  return placesOfDay(trip, k).filter((p) => !isNote(p));
}

export function clustersOf(list) {
  const out = [];
  list.forEach((s) => { if (out.indexOf(s.cluster) === -1) out.push(s.cluster); });
  return out;
}

export function allClusters(trip) {
  const out = [];
  trip.places.forEach((p) => {
    if (p.cluster && out.indexOf(p.cluster) === -1) out.push(p.cluster);
  });
  return out;
}

/* ── handled state ────────────────────────────────────────────────────────── */
export function stateOf(p) { return { visited: p.visited || null, skipped: p.skipped || null }; }
export function isVisited(p) { return !!stateOf(p).visited; }
export function isSkipped(p) { const s = stateOf(p); return !s.visited && !!s.skipped; }
export function isHandled(p) { const s = stateOf(p); return !!(s.visited || s.skipped); }

/* Complete = every actionable stopover handled, or the date has passed in the
   trip's own timezone. Notes never count. */
export function dayComplete(trip, day) {
  const acts = actionableOfDay(trip, day.key);
  if (acts.length && acts.every(isHandled)) return true;
  if (day.date && String(day.date) < tripToday(trip)) return true;
  return false;
}

/* The XTRA pool: unscheduled days (date === null), unhandled, not note rows.
   priority:"skip" stays in — resurfacing written-off ideas is the point.

   RESERVED IS EXCLUDED (DESIGN §5): "Find me something" stamps whatever you
   pick with the current time and drops it into today, which is precisely the
   move the Reserved guard exists to slow down. Offering a booked stopover in a
   list whose every row is a one-tap relocation would route around the guard
   entirely, so it never appears — a reservation sitting in XTRA is a thing you
   move deliberately through the edit sheet, where the confirm lives. */
export function findPool(trip) {
  return trip.places.filter((p) => {
    const d = dayByKey(trip, p.day);
    return d && d.date == null && !isNote(p) && !isHandled(p) && !isReserved(p);
  });
}

/* A place is a "stopover" everywhere the UI counts them (DESIGN §5); the XTRA
   day counts "ideas", because nothing in it is a stop on any route yet. */
export function countText(trip, day) {
  const stops = placesOfDay(trip, day.key);
  const acts = actionableOfDay(trip, day.key);
  const done = acts.filter(isHandled).length;
  const base = day.date
    ? stops.length + (stops.length === 1 ? " stopover" : " stopovers")
    : stops.length + (stops.length === 1 ? " idea" : " ideas") + " · unscheduled";
  if (acts.length && done === acts.length) return base + " · all handled";
  if (done) return base + " · " + done + " handled";
  return base;
}

/* The auto-open-today behaviour from v0: if today is inside the trip, open
   today's day; otherwise the first day. */
export function initialDayKey(trip) {
  const today = tripToday(trip);
  const first = trip.days[0] && trip.days[0].key;
  if (trip.start && trip.end && today >= trip.start && today <= trip.end) {
    const hit = trip.days.find((d) => d.date === today);
    if (hit) return hit.key;
  }
  return first;
}

/* The cluster of the chronologically previous stopover in the day, else the
   next one's — or null when the day has nothing timed to sit beside. */
export function neighbourCluster(trip, dayKey, mins) {
  const list = placesOfDay(trip, dayKey);
  let prev = null, next = null;
  for (let i = 0; i < list.length; i++) {
    const m = parseClock(list[i].time);
    if (m === null) continue;
    if (m <= mins) prev = list[i];
    else if (next === null) next = list[i];
  }
  return (prev && prev.cluster) || (next && next.cluster) || null;
}

/* cluster = the neighbour's, else whatever the stopover already carried. */
export function clusterForSlot(trip, dayKey, mins, fallback) {
  return neighbourCluster(trip, dayKey, mins) || fallback || "Inbox";
}

/* Cluster to adopt when a stopover MOVES to another day. Never the daypart it
   carried out of the day it left — "Afternoon — canyons" means nothing on
   Sunday. In order: the neighbour at its time, then the day's last cluster (it
   lands at the tail of the day), then a plain name.
   XTRA is deliberately handled before the inherit step: the pool is not an
   itinerary, and a stopover moved into it must not silently pick up an opinion
   like "Probably skip" from whatever happens to be sitting there. */
export function clusterOnMove(trip, dayKey, mins, current) {
  const near = (mins === null || mins === undefined)
    ? null : neighbourCluster(trip, dayKey, mins);
  if (near) return near;
  const day = dayByKey(trip, dayKey);
  if (day && day.date == null) return "Ideas";
  const existing = clustersOf(placesOfDay(trip, dayKey)).filter(Boolean);
  if (existing.length) return existing[existing.length - 1];
  return current || "Inbox";
}

/* ── cost (DESIGN §3, schema 2) ───────────────────────────────────────────────
   A number now, not free text. Three renderings, and the third is the one that
   matters: `0` is KNOWN free and says so, a real amount prints as money, and
   `null` — unknown, varies, not applicable — prints NOTHING. Never "Free": the
   old string schema let "" sit in the cost field for a place nobody had priced,
   and rendering that as "Free" would invent a fact about someone's money.

   Locale is pinned to en-US rather than left to the device. `cost` is dollars
   by definition here, and an undefined locale would render "US$32" on a phone
   set to en-GB — a currency-conversion implication the data does not make.

   Two formatters, not one with a 0–2 digit range: a range would print 12.5 as
   "$12.5", and half a cent is not a price. Whole dollars drop the ".00" (a card
   full of "$32.00" reads like a receipt), anything else takes exactly two. */
const WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0
});
const CENTS = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2
});

/* "" means "render no pill at all" — the one sentinel, checked by every caller. */
export function formatCost(v) {
  if (typeof v !== "number" || !isFinite(v)) return "";
  if (v === 0) return "Free";
  return (Number.isInteger(v) ? WHOLE : CENTS).format(v);
}

/* The edit sheet's inverse. Blank → null (unknown), which is the honest default
   for a field nobody filled in. A leading "$" and thousands commas are tolerated
   because people type them; anything else returns NaN so the caller can refuse
   the save rather than silently discarding what was typed. */
export function parseCost(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/* ── ids ──────────────────────────────────────────────────────────────────── */
export function slugify(s) {
  const out = String(s == null ? "" : s).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return out || "stopover";
}

export function uniqueId(trip, base) {
  const taken = Object.create(null);
  trip.places.forEach((p) => { taken[p.id] = 1; });
  if (!taken[base]) return base;
  for (let n = 2; n < 500; n++) if (!taken[base + "-" + n]) return base + "-" + n;
  return base + "-" + Date.now();
}

/* The header eyebrow: where this trip sits relative to today. */
export function eyebrowText(trip) {
  const today = tripToday(trip);
  const dated = trip.days.filter((d) => d.date);
  if (trip.start && trip.end && today >= trip.start && today <= trip.end) {
    const idx = dated.map((d) => d.date).indexOf(today);
    return idx >= 0 ? "Day " + (idx + 1) + " of " + dated.length : "On the trip";
  }
  if (trip.start && today > trip.end) return "Past trip";
  if (trip.start) {
    const n = dayGap(today, trip.start);
    const s = parseISO(trip.start);
    return n <= 1 ? "Tomorrow"
         : n <= 60 ? "In " + n + " days"
         : "Upcoming · " + MON[s.getMonth()] + " " + s.getFullYear();
  }
  return "Field guide";
}
