/* state.js — device state, the local overlay, and the sync settings.

   localStorage, all of it, in one place:
     wayfeather:app            → { activeTrip }                   (device-wide)
     wayfeather:app:<tripId>   → { placePatches, addedStopovers } (per trip)
     wayfeather:sync           → { owner, repo }                  (M2 Settings)
     wayfeather:token          → the PAT, alone, as a bare string (M2 Settings)
     wayfeather:pending        → the sync buffer, so a change survives an
                                 iOS app kill before it reaches git
     wayfeather:probe          → written and removed again by storageProbe();
                                 never present between calls

   Rendering is ALWAYS fetched data + overlay patch. Every mutation in the app —
   visited, skipped, an edit, an add, "find me something" — is one of these two
   writes. In M2 each one ALSO goes to the mutation sink below, which is how the
   write path (sync.js) sees changes without state.js having to know it exists.

   The token gets its own key and is never folded into a JSON record: nothing
   iterates it into a log line, and clearing it is one removeItem. It is read
   only by syncConfig(), only to build an Authorization header, and it is never
   rendered back into the DOM. */

import { copy } from "./dom.js";
import { withExtras } from "./trip.js";

const NS = "wayfeather:";
const GKEY = NS + "app";
const SYNC_KEY = NS + "sync";
const TOKEN_KEY = NS + "token";
const PENDING_KEY = NS + "pending";
const ovKey = (id) => GKEY + ":" + id;

/* ?reset and "Reset local changes" wipe the device — but signing you out of
   GitHub is a separate, deliberate act (there is a row for it in Settings).
   Losing the PAT because you cleared a stray overlay would mean re-typing a
   40-character secret on a phone. */
const KEEP_ON_WIPE = [SYNC_KEY, TOKEN_KEY];

export const store = {
  activeTrip: "",
  index: null,                 // index.json payload
  indexMeta: { fetchedAt: 0, stale: false, sha: null },
  raw: null,                   // active trip payload, as fetched
  tripFile: "",                // its filename in data/trips/ — the PUT target
  sync: { owner: "", repo: "" },
  readError: null,             // why the last read failed, for the empty state
  tripMeta: { fetchedAt: 0, stale: false, sha: null },
  /* { <tripId>: { end, tz, dayCount } } — warmed in the background so the Trips
     tab can group past/upcoming; index.json only carries a human date string. */
  summaries: Object.create(null),
  overlay: { placePatches: {}, addedStopovers: [] },
  trip: null                   // assembled: raw + overlay — what views render
};

/* ── localStorage plumbing (private mode must never throw) ────────────────── */
/* Every writer below RETURNS WHETHER IT WORKED, and proves it by reading the
   value back rather than by surviving the call. The try/catch stays — a storage
   failure must never break an edit mid-flight — but "caught it" is not the same
   as "stored it", and until v9 the difference was invisible: Settings said
   "Sync settings saved" whether or not a single byte had landed. Safari in
   Private Browsing and a full quota BOTH throw on setItem, and some embedded
   webviews accept the write and hand back nothing on the next read, which is
   why this verifies instead of trusting. */
function readJSON(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const o = raw ? JSON.parse(raw) : null;
    return (o && typeof o === "object") ? o : null;
  } catch (e) { return null; }
}

/* True only when the exact text is in storage afterwards. */
function writeRaw(key, text) {
  try {
    window.localStorage.setItem(key, text);
    return window.localStorage.getItem(key) === text;
  } catch (e) { return false; }                 // private mode, or over quota
}

function writeJSON(key, val) {
  let text;
  try { text = JSON.stringify(val); } catch (e) { return false; }
  return writeRaw(key, text);
}

/* True when the key is gone afterwards — including when it was never there. */
function drop(key) {
  try {
    window.localStorage.removeItem(key);
    return window.localStorage.getItem(key) == null;
  } catch (e) { return false; }
}

function readRaw(key) {
  try { return window.localStorage.getItem(key) || ""; } catch (e) { return ""; }
}

/* Settings › About asks this: can this device keep anything at all? A write, a
   read-back and a remove, under the app's own namespace so nothing else can
   collide with it, and cleaned up on the way out. This is the honest answer to
   "why do my settings keep disappearing?" when the answer is Safari's privacy
   settings rather than the app. */
export function storageProbe() {
  const key = NS + "probe";
  const text = "probe-" + Date.now();
  const wrote = writeRaw(key, text);
  drop(key);
  return wrote;
}

/* ?reset and the Settings row clear every Wayfeather key on this device — the
   whole "wayfeather:" vendor prefix, so state left behind by the design
   candidates in app/candidates/ goes too. The GitHub settings are the one
   exception (KEEP_ON_WIPE): they have their own row. */
export function wipeAll() {
  try {
    const kill = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.indexOf(NS) === 0 && KEEP_ON_WIPE.indexOf(k) < 0) kill.push(k);
    }
    kill.forEach((k) => window.localStorage.removeItem(k));
  } catch (e) { /* ignore */ }
}

/* ── sync settings (DESIGN §2, §5) ────────────────────────────────────────── */
export function loadSyncSettings() {
  const s = readJSON(SYNC_KEY) || {};
  store.sync = {
    owner: typeof s.owner === "string" ? s.owner : "",
    repo: typeof s.repo === "string" ? s.repo : ""
  };
  return store.sync;
}

/* Returns the saved pair plus `ok` — whether this device actually kept it.
   Still an object with .owner and .repo, so existing readers are unaffected;
   the settings view reads .ok to decide between "saved" and telling the truth.
   Clearing counts as a success when the key really is gone. */
export function saveSyncSettings(owner, repo) {
  store.sync = { owner: String(owner || "").trim(), repo: String(repo || "").trim() };
  const ok = (!store.sync.owner && !store.sync.repo)
    ? drop(SYNC_KEY)
    : writeJSON(SYNC_KEY, store.sync);
  return { owner: store.sync.owner, repo: store.sync.repo, ok };
}

/* The only writer of the token key. Returns whether a token is stored on this
   device when the call returns — false for an empty token (nothing to store),
   false when the write threw, and false when the value did not read back. A
   PAT that silently failed to save is the difference between "sync is set up"
   and a phone that quietly stops writing, so this one must not guess. */
export function saveToken(token) {
  const t = String(token || "").trim();
  if (!t) { drop(TOKEN_KEY); return false; }
  return writeRaw(TOKEN_KEY, t);
}

/* Deliberately returns a boolean, not the value: Settings renders from this, so
   there is no path from storage to the screen. */
export function hasToken() { return !!readRaw(TOKEN_KEY); }

export function clearToken() { drop(TOKEN_KEY); }

export function signOutGitHub() {
  drop(SYNC_KEY);
  drop(TOKEN_KEY);
  store.sync = { owner: "", repo: "" };
}

/* Empty owner/repo = keep the same-origin static mode (M1 behaviour). */
export function isConfigured() {
  const s = store.sync || {};
  return !!(s.owner && s.repo);
}

/* The one place the token leaves storage — straight into an Authorization
   header in api.js. Never log this object. */
export function syncConfig() {
  const s = store.sync || {};
  return { owner: s.owner || "", repo: s.repo || "", token: readRaw(TOKEN_KEY) };
}

/* ── the pending write buffer ─────────────────────────────────────────────── */
/* iOS kills a backgrounded PWA without warning. The overlay would still hold
   the change, but nothing would remember it had never been pushed — so the
   buffer is persisted too, and flushes on next foreground. */
export function loadPending() {
  const raw = readJSON(PENDING_KEY);
  return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []);
}

export function savePending(entries) {
  if (!entries || !entries.length) { drop(PENDING_KEY); return; }
  writeJSON(PENDING_KEY, entries);
}

/* ── globals ──────────────────────────────────────────────────────────────── */
/* v4 dropped the accent picker: there is one theme now (DESIGN §5). A device
   that still has `accent` in this record simply keeps an ignored key — nothing
   reads it, and the next saveGlobal() drops it. */
export function loadGlobal() {
  const g = readJSON(GKEY) || {};
  if (g.activeTrip) store.activeTrip = g.activeTrip;
}

export function saveGlobal() {
  writeJSON(GKEY, { activeTrip: store.activeTrip });
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
    /* XTRA is guaranteed here, once, on the way in: every view downstream can
       assume a home for "not today" exists — Move to… and Find me something
       both depend on it (DESIGN §5). */
    days: withExtras(raw.days), places
  };
  return store.trip;
}

/* ── the mutation sink (M2) ───────────────────────────────────────────────── */
/* sync.js registers here at boot. Injected rather than imported so state.js
   keeps no dependency on the write path — and so the whole overlay layer still
   runs headless in tests with no sink at all. Because EVERY mutation below
   funnels through these helpers, there is no call site that can forget to
   report a change. */
let sink = null;
export function setMutationSink(fn) { sink = typeof fn === "function" ? fn : null; }

function rawPlace(id) {
  const list = (store.raw && store.raw.places) || [];
  return list.find((p) => p && p.id === id) || null;
}

/* What the PUBLISHED file says about exactly the keys being changed. sync.js
   compares against this to decide whether an undo has cancelled a change out of
   existence. Null when the place is not in the published file yet (a local add
   that has never been pushed) — nothing to restore to. */
function publishedValues(id, fields) {
  const p = rawPlace(id);
  if (!p) return null;
  const before = {};
  Object.keys(fields || {}).forEach((k) => { before[k] = p[k] === undefined ? null : p[k]; });
  return before;
}

function report(entry) {
  if (!sink || !store.tripFile) return;
  try {
    sink(Object.assign({ file: store.tripFile, tripId: store.activeTrip }, entry));
  } catch (e) { /* a broken sink must never break an edit */ }
}

function effectivePlace(id) {
  const t = store.trip;
  return (t && (t.places || []).find((p) => p && p.id === id)) || rawPlace(id);
}

export function patchPlace(id, fields, meta) {
  const q = store.overlay.placePatches[id] || (store.overlay.placePatches[id] = {});
  for (const k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) q[k] = fields[k];
  saveOverlay();
  assemble();

  const p = effectivePlace(id);
  report({
    kind: (meta && meta.kind) || "edit",
    placeId: id,
    name: (p && p.name) || (fields && fields.name) || "",
    day: (fields && fields.day) || (p && p.day) || "",
    patch: copy(fields),
    before: publishedValues(id, fields)
  });
}

export function snapshotPatch(id) {
  const q = store.overlay.placePatches[id];
  return q ? JSON.parse(JSON.stringify(q)) : null;
}

/* Undo. The restored EFFECTIVE values are reported like any other mutation —
   sync.js sees a change that lands back on the published values and drops the
   pending entry, so an accidental tap never reaches git history (DESIGN §4).
   No special undo channel, no token to keep track of. */
export function restorePatch(id, prior) {
  const current = store.overlay.placePatches[id] || {};
  const touched = {};
  Object.keys(current).forEach((k) => { touched[k] = 1; });
  Object.keys(prior || {}).forEach((k) => { touched[k] = 1; });

  if (prior) store.overlay.placePatches[id] = prior;
  else delete store.overlay.placePatches[id];
  saveOverlay();
  assemble();

  const keys = Object.keys(touched);
  if (!keys.length) return;
  const p = effectivePlace(id);
  const fields = {};
  keys.forEach((k) => { fields[k] = p && p[k] !== undefined ? p[k] : null; });
  report({
    kind: "edit",
    placeId: id,
    name: (p && p.name) || "",
    day: (p && p.day) || "",
    patch: fields,
    before: publishedValues(id, fields)
  });
}

export function addStopover(place) {
  store.overlay.addedStopovers.push(place);
  saveOverlay();
  assemble();
  report({
    kind: "add",
    placeId: place.id,
    name: place.name || "",
    day: place.day || "",
    place: copy(place)
  });
}

export function setPlaceState(id, act) {
  const now = new Date().toISOString();
  if (act === "visit") patchPlace(id, { visited: now, skipped: null }, { kind: "visit" });
  else if (act === "skip") patchPlace(id, { visited: null, skipped: now }, { kind: "skip" });
  else patchPlace(id, { visited: null, skipped: null }, { kind: "edit" });
}

/* ── settling a successful push ───────────────────────────────────────────── */
/* Once a change is in the data repo, the overlay must stop shadowing it: the
   next read carries it, and a stale overlay would keep inflating "N local
   changes" and let "Reset local changes" silently revert PUBLISHED data.

   The doc that was just PUT *is* the new published state, so it is adopted as
   `raw` here rather than waiting for the next refresh. Two reasons: an added
   stopover would otherwise blink out of the list the moment it left the overlay
   and before any re-read put it back, and any edit the other phone made — which
   arrived on the pre-write GET — lands on screen for free.

   Only the exact values that were pushed are cleared. Anything edited again
   while the PUT was in flight differs from the flushed value and stays put, so
   the newer change survives to the next flush. */
export function settleOverlay(entries, result) {
  let dirty = false;

  if (result && result.doc && result.file && result.file === store.tripFile) {
    store.raw = result.doc;
    store.tripMeta = { fetchedAt: Date.now(), stale: false, sha: result.sha || store.tripMeta.sha };
    dirty = true;
  }

  (entries || []).forEach((e) => {
    if (!e || e.tripId !== store.activeTrip) return;

    if (e.kind === "add" && e.place) {
      const i = store.overlay.addedStopovers.findIndex((p) => p && p.id === e.place.id);
      if (i >= 0) { store.overlay.addedStopovers.splice(i, 1); dirty = true; }
      return;
    }

    const q = store.overlay.placePatches[e.placeId];
    if (!q || !e.patch) return;
    Object.keys(e.patch).forEach((k) => {
      if (JSON.stringify(q[k]) === JSON.stringify(e.patch[k])) { delete q[k]; dirty = true; }
    });
    if (!Object.keys(q).length) delete store.overlay.placePatches[e.placeId];
  });
  if (dirty) { saveOverlay(); assemble(); }
  return dirty;
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
