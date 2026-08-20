/* data.js — the read path (DESIGN §4).

   M1: same-origin static fetch of data/trips/*.json with cache:"no-store",
   every successful payload mirrored into IndexedDB. On a network failure we
   render from IndexedDB and the caller shows a stale banner.

   The URL is resolved from import.meta.url, NOT from the document and NOT from
   any absolute origin — app/js/data.js → ../../data/trips/ — so the app works
   unchanged at any host path (GitHub Pages serves this repo under /wayfeather/)
   and owner/repo are never hardcoded anywhere. */

const DATA_DIR = new URL("../../data/trips/", import.meta.url);

export const INDEX_FILE = "index.json";
export const SUPPORTED_SCHEMA = 1;

/* ── M2 SEAM ───────────────────────────────────────────────────────────────
   Everything above the transport is already shaped for the Contents API. When
   Settings grow an owner/repo + PAT (DESIGN §2, §4), fetchJSON below becomes:

     GET /repos/{owner}/{repo}/contents/data/trips/{file}
       → { content: base64, sha }        sha = the optimistic-concurrency token

   and `sha` on the cached record stops being null. It is threaded through the
   record shape and the return value TODAY so that nothing downstream has to
   change: the refresh stamp reads `sha` when it is non-null and says only
   "updated <when>" while it is null. There is no git sha available from a
   static fetch, so the app must not invent one. ─────────────────────────── */

async function fetchJSON(file) {
  const url = new URL(file, DATA_DIR);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + file);
  return { payload: await res.json(), sha: null };
}

/* ── IndexedDB cache ──────────────────────────────────────────────────────── */
const DB_NAME = "wayfeather";
const DB_VERSION = 1;
const STORE = "payloads";           // records: { file, payload, fetchedAt, sha }

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { resolve(null); return; }          // private mode / no IDB
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "file" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }

async function idbGet(file) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = tx(db, "readonly").get(file);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

async function idbPut(rec) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const r = tx(db, "readwrite").put(rec);
      r.onsuccess = () => resolve(true);
      r.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

async function idbAll() {
  const db = await openDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const r = tx(db, "readwrite").getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}

export async function clearDataCache() {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const r = tx(db, "readwrite").clear();
      r.onsuccess = () => resolve(true);
      r.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

/* { count, newest } for the Settings row. */
export async function cacheInfo() {
  const all = await idbAll();
  let newest = 0;
  all.forEach((r) => { if (r && r.fetchedAt > newest) newest = r.fetchedAt; });
  return { count: all.length, newest };
}

/* ── the one read call ────────────────────────────────────────────────────── */
/* Returns { payload, fetchedAt, sha, stale, empty, error }.
     stale  — served from IndexedDB because the network failed
     empty  — nothing on the network AND nothing cached (first run offline) */
export async function load(file) {
  try {
    const { payload, sha } = await fetchJSON(file);
    const fetchedAt = Date.now();
    await idbPut({ file, payload, fetchedAt, sha });
    return { payload, fetchedAt, sha, stale: false, empty: false, error: null };
  } catch (error) {
    const rec = await idbGet(file);
    if (rec && rec.payload) {
      return {
        payload: rec.payload, fetchedAt: rec.fetchedAt || 0, sha: rec.sha || null,
        stale: true, empty: false, error
      };
    }
    return { payload: null, fetchedAt: 0, sha: null, stale: true, empty: true, error };
  }
}

export function loadIndex() { return load(INDEX_FILE); }
export function loadTrip(file) { return load(file); }

/* DESIGN §3: the app refuses schema versions it doesn't know. */
export function schemaOK(payload) {
  return !!payload && payload.schema === SUPPORTED_SCHEMA;
}
