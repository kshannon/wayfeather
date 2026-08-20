/* state.js — device state and the local overlay.

   Two layers of localStorage:
     wayfeather:app            → { accent, activeTrip }          (device-wide)
     wayfeather:app:<tripId>   → { placePatches, addedStopovers } (per trip)

   Rendering is ALWAYS fetched data + overlay patch. Every mutation in the app —
   visited, skipped, an edit, an add, "find me something" — is one of these two
   writes, which is exactly the shape the M2 Contents-API PUT replaces (§4).
   Only the transport changes; the patch objects do not. */

import { copy } from "./dom.js";

const NS = "wayfeather:";
const GKEY = NS + "app";
const ovKey = (id) => GKEY + ":" + id;

export const ACCENTS = [
  { id: "cerulean", name: "Cerulean", hex: "#0B6C8C" },
  { id: "matcha",   name: "Matcha",   hex: "#4B6630" }
];

export const store = {
  accent: ACCENTS[0].id,
  activeTrip: "",
  index: null,                 // index.json payload
  indexMeta: { fetchedAt: 0, stale: false, sha: null },
  raw: null,                   // active trip payload, as fetched
  tripMeta: { fetchedAt: 0, stale: false, sha: null },
  /* { <tripId>: { end, tz, dayCount } } — warmed in the background so the Trips
     tab can group past/upcoming; index.json only carries a human date string. */
  summaries: Object.create(null),
  overlay: { placePatches: {}, addedStopovers: [] },
  trip: null                   // assembled: raw + overlay — what views render
};

/* ── localStorage plumbing (private mode must never throw) ────────────────── */
function readJSON(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const o = raw ? JSON.parse(raw) : null;
    return (o && typeof o === "object") ? o : null;
  } catch (e) { return null; }
}

function writeJSON(key, val) {
  try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
}

/* ?reset and the Settings row clear every Wayfeather key on this device — the
   whole "wayfeather:" vendor prefix, so state left behind by the design
   candidates in app/candidates/ goes too. */
export function wipeAll() {
  try {
    const kill = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.indexOf(NS) === 0) kill.push(k);
    }
    kill.forEach((k) => window.localStorage.removeItem(k));
  } catch (e) { /* ignore */ }
}

/* ── globals ──────────────────────────────────────────────────────────────── */
export function loadGlobal() {
  const g = readJSON(GKEY) || {};
  if (g.accent && ACCENTS.some((a) => a.id === g.accent)) store.accent = g.accent;
  if (g.activeTrip) store.activeTrip = g.activeTrip;
}

export function saveGlobal() {
  writeJSON(GKEY, { accent: store.accent, activeTrip: store.activeTrip });
}

export function applyAccent() {
  document.documentElement.setAttribute("data-accent", store.accent);
}

export function setAccent(id) {
  if (!ACCENTS.some((a) => a.id === id)) return;
  store.accent = id;
  saveGlobal();
  applyAccent();
}

/* ── overlay ──────────────────────────────────────────────────────────────── */
function normOverlay(o) {
  o = o || {};
  return {
    placePatches: (o.placePatches && typeof o.placePatches === "object") ? o.placePatches : {},
    addedStopovers: Array.isArray(o.addedStopovers) ? o.addedStopovers : []
  };
}

export function loadOverlay() {
  store.overlay = normOverlay(readJSON(ovKey(store.activeTrip)));
}

export function saveOverlay() {
  writeJSON(ovKey(store.activeTrip), store.overlay);
}

/* ── assemble: fetched data + overlay ─────────────────────────────────────── */
export function assemble() {
  const raw = store.raw;
  if (!raw) { store.trip = null; return null; }
  const pool = (raw.places || []).concat(store.overlay.addedStopovers);
  const places = pool.map((p) => {
    const q = store.overlay.placePatches[p.id];
    if (!q) return p;
    const out = copy(p);
    for (const k in q) if (Object.prototype.hasOwnProperty.call(q, k)) out[k] = q[k];
    return out;
  });
  store.trip = {
    schema: raw.schema, id: raw.id, name: raw.name, tz: raw.tz,
    start: raw.start, end: raw.end, base: raw.base, notes: raw.notes,
    days: raw.days || [], places
  };
  return store.trip;
}

export function patchPlace(id, fields) {
  const q = store.overlay.placePatches[id] || (store.overlay.placePatches[id] = {});
  for (const k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) q[k] = fields[k];
  saveOverlay();
  assemble();
}

export function snapshotPatch(id) {
  const q = store.overlay.placePatches[id];
  return q ? JSON.parse(JSON.stringify(q)) : null;
}

export function restorePatch(id, prior) {
  if (prior) store.overlay.placePatches[id] = prior;
  else delete store.overlay.placePatches[id];
  saveOverlay();
  assemble();
}

export function addStopover(place) {
  store.overlay.addedStopovers.push(place);
  saveOverlay();
  assemble();
}

export function setPlaceState(id, act) {
  const now = new Date().toISOString();
  if (act === "visit") patchPlace(id, { visited: now, skipped: null });
  else if (act === "skip") patchPlace(id, { visited: null, skipped: now });
  else patchPlace(id, { visited: null, skipped: null });
}

/* How many local edits exist across every trip in the index — the number the
   Settings reset row quotes before it wipes anything. */
export function localChangeCount() {
  const trips = (store.index && store.index.trips) || [];
  let n = 0;
  trips.forEach((e) => {
    const o = normOverlay(readJSON(ovKey(e.id)));
    n += Object.keys(o.placePatches).length + o.addedStopovers.length;
  });
  return n;
}
