/* data.js — the read path (DESIGN §4).

   Two transports, one shape. With Settings unconfigured it is M1 exactly: a
   same-origin static fetch of data/trips/*.json with cache:"no-store". With an
   owner and repo configured it is the GitHub Contents API, keyless for a public
   repo and with the PAT for the private data repo (DESIGN §2). Either way every
   successful payload is mirrored into IndexedDB; on a network failure we render
   from IndexedDB and the caller shows a stale banner.

   The static URL is resolved from import.meta.url, NOT from the document and
   NOT from any absolute origin — app/js/data.js → ../../data/trips/ — so the
   app works unchanged at any host path (GitHub Pages serves this repo under
   /wayfeather/) and owner/repo are never hardcoded anywhere. */

import { getFile, DATA_PATH } from "./api.js";
import { store, syncConfig, isConfigured } from "./state.js";

/* "owner/repo" or "this site". Reads store.sync, NOT syncConfig(): naming the
   source has no business pulling the token out of storage. */
function sourceName() {
  const s = store.sync || {};
  return isConfigured() ? s.owner + "/" + s.repo : "this site";
}

const DATA_DIR = new URL("../../data/trips/", import.meta.url);

export const INDEX_FILE = "index.json";
export const SUPPORTED_SCHEMA = 1;

/* ── the transport ────────────────────────────────────────────────────────
   The API path is what finally makes `sha` real: it is the blob sha, both the
   optimistic-concurrency token for writes and the short sha the refresh stamp
   prints. A static fetch has no git sha and must not invent one, so it still
   returns null there and the stamp still says only "updated <when>". */
async function fetchJSON(file) {
  if (isConfigured()) {
    const cfg = syncConfig();
    const res = await getFile({
      owner: cfg.owner, repo: cfg.repo, path: DATA_PATH + file, token: cfg.token
    });
    return { payload: res.doc, sha: res.sha };
  }
  const url = new URL(file, DATA_DIR);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + file);
  return { payload: await res.json(), sha: null };
}

/* Cache records are namespaced by source, so this site's fictional fixtures and
   a configured repo's real trips can never be served for one another offline —
   same filenames, different data (DESIGN §2 privacy). */
function cacheKey(file) {
  return isConfigured() ? sourceName() + ":" + file : file;
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
  const key = cacheKey(file);
  try {
    const { payload, sha } = await fetchJSON(file);
    const fetchedAt = Date.now();
    await idbPut({ file: key, payload, fetchedAt, sha });
    return { payload, fetchedAt, sha, stale: false, empty: false, error: null };
  } catch (error) {
    const rec = await idbGet(key);
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

/* Why a read failed, in words the person can act on.

   "Check your connection" is a lie when the real answer is an expired PAT —
   and an expired PAT is the failure most likely to happen mid-trip, since the
   token is meant to be rotated after each one (DESIGN §2). Returns "" for
   offline and for anything unrecognised, where the generic copy is right. */
export function readErrorText(error) {
  const code = (error && error.code) || "";
  const where = sourceName();
  switch (code) {
    case "unauthorized":
      return "GitHub refused the saved token. Open Settings to enter a current one — " +
        "or clear it, if that repository is public.";
    case "forbidden":
      return "That token has no access to " + where + ". Check its repository " +
        "permissions, or clear it in Settings.";
    case "rate-limited":
      return "GitHub's rate limit is spent. It resets within the hour; a token in " +
        "Settings raises the limit.";
    case "not-found":
      return "No data/trips/ files in " + where + ". Check the owner and repository " +
        "in Settings — a private repo also needs a token.";
    case "bad-json":
      return "The trip files in " + where + " could not be read as JSON.";
    case "too-large":
      return "A trip file in " + where + " is too large to read through the API.";
    default:
      return "";
  }
}

/* The same diagnosis in toast length. The empty state can afford two sentences;
   a toast that appears over a still-readable cached trip cannot. */
export function readErrorShort(error) {
  switch ((error && error.code) || "") {
    case "unauthorized": return "GitHub refused the saved token";
    case "forbidden":    return "That token cannot read this repo";
    case "rate-limited": return "GitHub rate limit reached";
    case "not-found":    return "Could not find those trip files";
    case "bad-json":     return "Those trip files are not valid JSON";
    case "too-large":    return "That trip file is too large to read";
    default:             return "";
  }
}

/* Settings' "Test connection": one GET of the index file from the SAVED config,
   which is why Settings saves before it tests. Reading syncConfig() here rather
   than taking a token argument keeps the view layer out of the token's way
   entirely — it writes the field into storage and never handles it again.

   Returns a code, not a sentence: the toast wording lives in the view. */
export async function testConnection() {
  if (!isConfigured()) return { ok: false, code: "unconfigured" };
  const cfg = syncConfig();
  try {
    const res = await getFile({
      owner: cfg.owner, repo: cfg.repo, path: DATA_PATH + INDEX_FILE, token: cfg.token
    });
    const trips = (res.doc && res.doc.trips) || [];
    return { ok: true, code: "ok", trips: trips.length, sha: res.sha, keyless: !cfg.token };
  } catch (e) {
    return { ok: false, code: (e && e.code) || "error", status: (e && e.status) || 0 };
  }
}
