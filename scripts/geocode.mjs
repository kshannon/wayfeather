#!/usr/bin/env node
/* geocode.mjs — the one-time (and re-runnable) lat/lng backfill.  DESIGN §6

   Reads every data/trips/<id>.json, and for each addressed thing whose
   coordinates are still null asks Nominatim for them:

     trip.base   → gains lat/lng (nullable) so the map can drop a Nest marker
     places[]    → the stopovers; places with address "" (Drive legs, note
                   rows) are skipped and stay null, forever and on purpose

   Ground rule 1 (LLMS.md) is the whole reason this file exists: coordinates are
   *looked up*, never invented. Nothing here writes a number it did not receive
   from the geocoder, and every raw response is kept in the cache so any value
   in the trip files can be traced back to what the service actually said.

   Etiquette (Nominatim usage policy, DESIGN §2 "keyless by default"):
     · at most one request per second — enforced at >= 1100 ms of real spacing
     · a descriptive User-Agent that identifies the app and its repo
     · responses cached in scripts/.geocode-cache.json so a re-run costs zero
       requests; delete the file (or pass --force) to refetch

   Usage:
     node scripts/geocode.mjs               backfill anything still null
     node scripts/geocode.mjs --dry-run     report only, write nothing
     node scripts/geocode.mjs --force       ignore the cache, refetch every query
     node scripts/geocode.mjs --file chicago-test.json    just the one trip

   ── THE $$ GOTCHA (CLAUDE.md / LLMS.md rule 5) ────────────────────────────
   Trip data contains "cost": "$$", and String.replace treats $$ in a
   *replacement string* as an escape — it would silently rewrite the file with
   "$". So nothing in this script ever replaces with a data-derived string:
   the write path is line splicing with slice/concat only, and the final
   verification re-parses the written file and deep-compares every field except
   the lat/lng it meant to change. A corrupted "$$" fails the run loudly. */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TRIPS = path.join(ROOT, "data", "trips");
const CACHE_FILE = path.join(HERE, ".geocode-cache.json");

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const UA = "wayfeather-geocoder/1.0 (github.com/kshannon/wayfeather)";
const MIN_SPACING_MS = 1100;          // "1 req/s" with headroom for clock jitter
const PRECISION = 6;                  // ~11 cm at the equator; far past our needs

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const ONLY = (() => {
  const i = argv.indexOf("--file");
  return i >= 0 ? argv[i + 1] : null;
})();

/* ── tiny console helpers ─────────────────────────────────────────────────── */
const isTTY = process.stdout.isTTY;
const dim = (s) => (isTTY ? "\u001b[2m" + s + "\u001b[0m" : s);
const bold = (s) => (isTTY ? "\u001b[1m" + s + "\u001b[0m" : s);
const green = (s) => (isTTY ? "\u001b[32m" + s + "\u001b[0m" : s);
const yellow = (s) => (isTTY ? "\u001b[33m" + s + "\u001b[0m" : s);
const red = (s) => (isTTY ? "\u001b[31m" + s + "\u001b[0m" : s);

/* ── rate-limited fetch ───────────────────────────────────────────────────── */
let lastRequestAt = 0;
let requestCount = 0;                 // every real network call, across all tiers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/* ── cache ────────────────────────────────────────────────────────────────── */
/* Keyed by the exact query string. The value keeps the WHOLE first result (or
   null for "the service returned nothing"), so a human can audit any committed
   coordinate against the display_name Nominatim actually matched. */
let cache = Object.create(null);

async function loadCache() {
  if (!existsSync(CACHE_FILE)) return;
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const o = JSON.parse(raw);
    if (o && typeof o === "object") cache = o.queries && typeof o.queries === "object" ? o.queries : o;
  } catch {
    console.warn(yellow("  cache unreadable — starting a fresh one"));
  }
}

/* Written even under --dry-run: the requests have already been spent, and
   throwing them away would make a dry run cost the service a second round. */
async function saveCache() {
  await mkdir(HERE, { recursive: true });
  const body = {
    note: "Nominatim response cache for scripts/geocode.mjs. Safe to delete; " +
          "the script refetches (1 req/s). Keyed by query string.",
    updated: new Date().toISOString(),
    queries: cache
  };
  await writeFile(CACHE_FILE, JSON.stringify(body, null, 2) + "\n", "utf8");
}

/* ── the lookup ───────────────────────────────────────────────────────────── */
/* Returns { lat, lng, display, source } or null.
   `source` is "cache" or "network" — used only for the report. */
async function nominatim(query) {
  if (!FORCE && Object.prototype.hasOwnProperty.call(cache, query)) {
    const hit = cache[query];
    return hit ? { ...pick(hit), display: hit.display_name, source: "cache" } : null;
  }

  await throttle();
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  } catch (e) {
    throw new Error("network error: " + e.message);
  }
  if (res.status === 429 || res.status === 503) {
    throw new Error("rate limited (HTTP " + res.status + ") — wait a few minutes and re-run");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);

  const list = await res.json();
  const first = Array.isArray(list) && list.length ? list[0] : null;
  cache[query] = first;                       // null is a legitimate cached answer
  requestCount++;                             // counted here: one resolve can cost several tiers
  return first ? { ...pick(first), display: first.display_name, source: "network" } : null;
}

function pick(r) {
  const lat = Number.parseFloat(r.lat);
  const lng = Number.parseFloat(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat: null, lng: null };
  return { lat, lng };
}

/* ── the query ladder ─────────────────────────────────────────────────────── */
/* Three tiers, tried in order, every one of them built ONLY from the name and
   address already in the trip file. Nothing here widens the search to data we
   were not given, and nothing accepts a result it cannot tie back to the
   address's own locality.

     1. "<name>, <address>"   the DESIGN §6 query
     2. "<address>"           the address alone — the fixtures carry names like
                              "Palmer House (test base)" that no gazetteer has
                              heard of, while the street address is real
     3. "<cleanName>, <City, ST>"   last resort, GUARDED (see below)

   Tier 3 exists because rural addresses defeat free-form parsing: OSM files
   Starved Rock and Matthiessen under Utica/Deer Park, so "2500 IL-178,
   Oglesby, IL 61348" resolves to nothing even though both the address and the
   park are real. Dropping to "name + locality" recovers the park.

   Because tier 3 drops the street line, it is the one tier that could match a
   same-named place somewhere else entirely — so its result is REJECTED unless
   the locality we asked for actually appears in the display name Nominatim
   returned. An unverifiable coordinate is precisely what ground rule 1
   forbids, so it is dropped rather than written. There is deliberately no
   bare-"<name>" tier: with no locality in the query there is nothing left to
   check the answer against. */

/* "17 E Monroe St, Chicago, IL 60603" → "Chicago, IL"  (same derivation as the
   app's links.js deriveLoc, so script and UI agree on what a locality is). */
function localityOf(address) {
  const parts = String(address || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return "";
  const city = parts[parts.length - 2];
  const st = parts[parts.length - 1].split(/\s+/)[0];
  return city && st ? city + ", " + st : "";
}

/* Strip the bookkeeping the itinerary hangs off a name — "(test base)",
   "— check-in", "— Dells loop" — none of which is part of what the place is
   called. Only tier 3 uses this; tiers 1 and 2 still carry the full address,
   which keeps the disambiguation a suffix like "— East Village" was doing. */
function cleanName(name) {
  return String(name || "")
    .replace(/\([^)]*\)/g, " ")            // fixed replacement, no data, no $$ risk
    .split(/\s+[—–]\s+/)[0]
    .replace(/\s+/g, " ")
    .replace(/[\s,;:-]+$/, "")
    .trim();
}

function queriesFor(name, address) {
  const raw = String(name || "").trim();
  const addr = String(address || "").trim();
  if (!addr) return [];
  const loc = localityOf(addr);
  const clean = cleanName(raw);
  const out = [];
  if (raw) out.push({ q: raw + ", " + addr, tier: 1, guard: "" });
  out.push({ q: addr, tier: 2, guard: "" });
  if (clean && loc) out.push({ q: clean + ", " + loc, tier: 3, guard: loc.split(",")[0].trim() });
  const seen = Object.create(null);
  return out.filter((x) => (seen[x.q] ? false : (seen[x.q] = 1)));
}

async function resolve(name, address) {
  const qs = queriesFor(name, address);
  for (const step of qs) {
    const hit = await nominatim(step.q);
    if (!hit || hit.lat === null) continue;
    if (step.guard) {
      const shown = String(hit.display || "").toLowerCase();
      if (shown.indexOf(step.guard.toLowerCase()) < 0) continue;   // wrong town — drop it
    }
    return { ...hit, query: step.q, tier: step.tier };
  }
  return null;
}

/* ── number formatting ────────────────────────────────────────────────────── */
/* A fixed 6-decimal JSON number. toFixed never yields exponent notation in this
   range, so the output is always a literal JSON number. */
function coord(n) { return Number(n).toFixed(PRECISION); }

/* ── the write path: targeted line splicing ───────────────────────────────── */
/* The trip files are hand-formatted (1-space indent, deliberate key order) and
   this script must not reformat them. So the file is edited as TEXT, line by
   line, and every other byte is left alone. JSON.stringify would round-trip the
   data correctly and destroy the formatting; that is not an acceptable trade
   for a file a human reads in a diff. */

const RE_ID = /^(\s*)"id":\s*"([^"]*)"/;
const RE_LAT = /^(\s*)"lat":\s*([^,\n]*?)(,?)\s*$/;
const RE_LNG = /^(\s*)"lng":\s*([^,\n]*?)(,?)\s*$/;
const RE_BASE_OPEN = /^(\s*)"base":\s*\{\s*$/;
const RE_ADDRESS = /^(\s*)"address":\s*(".*")(,?)\s*$/;

/* Replace the value on a `"key": value` line, keeping indentation, key, and the
   trailing comma exactly as they were. Pure slice/concat — no String.replace
   with a data-derived replacement (the $$ gotcha). */
function setValueOnLine(line, re, value) {
  const m = line.match(re);
  if (!m) return null;
  return m[1] + '"' + (re === RE_LAT ? "lat" : "lng") + '": ' + value + m[3];
}

/* places: fill the existing lat/lng lines inside the object whose "id" we last
   saw. Key order in every fixture puts "id" before "lat"/"lng", so the most
   recent id line unambiguously names the object we are inside. */
function splicePlaces(lines, byId) {
  let current = null;
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const idm = lines[i].match(RE_ID);
    if (idm) { current = idm[2]; continue; }
    if (!current || !byId[current]) continue;
    const fix = byId[current];
    if (RE_LAT.test(lines[i])) {
      const next = setValueOnLine(lines[i], RE_LAT, coord(fix.lat));
      if (next !== null && next !== lines[i]) { lines[i] = next; changed++; }
    } else if (RE_LNG.test(lines[i])) {
      const next = setValueOnLine(lines[i], RE_LNG, coord(fix.lng));
      if (next !== null && next !== lines[i]) { lines[i] = next; changed++; }
    }
  }
  return changed;
}

/* base: the fields do not exist yet, so they are INSERTED after "address",
   matching the key order places already use (…address, lat, lng…). If a later
   run finds them already there, it updates in place instead. */
function spliceBase(lines, fix) {
  const open = lines.findIndex((l) => RE_BASE_OPEN.test(l));
  if (open < 0) return 0;
  const indent = lines[open].match(RE_BASE_OPEN)[1];
  const closeRe = new RegExp("^" + indent + "\\},?\\s*$");
  let close = -1;
  for (let i = open + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) { close = i; break; }
  }
  if (close < 0) return 0;

  const latVal = fix && fix.lat !== null ? coord(fix.lat) : "null";
  const lngVal = fix && fix.lng !== null ? coord(fix.lng) : "null";

  // already present → update in place
  let hasLat = -1, hasLng = -1;
  for (let i = open + 1; i < close; i++) {
    if (RE_LAT.test(lines[i])) hasLat = i;
    if (RE_LNG.test(lines[i])) hasLng = i;
  }
  if (hasLat >= 0 && hasLng >= 0) {
    let n = 0;
    const a = setValueOnLine(lines[hasLat], RE_LAT, latVal);
    const b = setValueOnLine(lines[hasLng], RE_LNG, lngVal);
    if (a !== null && a !== lines[hasLat]) { lines[hasLat] = a; n++; }
    if (b !== null && b !== lines[hasLng]) { lines[hasLng] = b; n++; }
    return n;
  }

  // insert after base's own "address" line
  let at = -1, m = null;
  for (let i = open + 1; i < close; i++) {
    const mm = lines[i].match(RE_ADDRESS);
    if (mm) { at = i; m = mm; break; }
  }
  if (at < 0) return 0;

  const inner = m[1];
  const addressWasLast = m[3] === "";
  // address gains a comma because two keys now follow it
  lines[at] = inner + '"address": ' + m[2] + ",";
  const tail = addressWasLast ? "" : ",";
  lines.splice(at + 1, 0, inner + '"lat": ' + latVal + ",", inner + '"lng": ' + lngVal + tail);
  return 2;
}

/* ── verification ─────────────────────────────────────────────────────────── */
/* Deep-compare before/after, ignoring exactly the keys we intended to write.
   This is what catches a mangled "$$" or a splice that landed on the wrong
   object: any other difference at all fails the run. */
function diffIgnoringCoords(a, b, trail, out) {
  if (a === b) return;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { out.push(trail + ": " + JSON.stringify(a) + " -> " + JSON.stringify(b)); return; }
  if (ta === "array") {
    if (a.length !== b.length) { out.push(trail + ": length " + a.length + " -> " + b.length); return; }
    for (let i = 0; i < a.length; i++) diffIgnoringCoords(a[i], b[i], trail + "[" + i + "]", out);
    return;
  }
  if (ta === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    kb.forEach((k) => {
      if (ka.indexOf(k) < 0 && !(k === "lat" || k === "lng")) out.push(trail + "." + k + ": key added");
    });
    ka.forEach((k) => {
      if (kb.indexOf(k) < 0) { out.push(trail + "." + k + ": key removed"); return; }
      if (k === "lat" || k === "lng") return;                 // the intended change
      diffIgnoringCoords(a[k], b[k], trail + "." + k, out);
    });
    // key ORDER is part of the formatting contract
    const sharedA = ka.filter((k) => kb.indexOf(k) >= 0 && k !== "lat" && k !== "lng");
    const sharedB = kb.filter((k) => ka.indexOf(k) >= 0 && k !== "lat" && k !== "lng");
    if (sharedA.join(" ") !== sharedB.join(" ")) out.push(trail + ": key order changed");
    return;
  }
  out.push(trail + ": " + JSON.stringify(a) + " -> " + JSON.stringify(b));
}

/* ── one trip file ────────────────────────────────────────────────────────── */
async function doTrip(file, tally) {
  const full = path.join(TRIPS, file);
  const before = await readFile(full, "utf8");
  let doc;
  try { doc = JSON.parse(before); }
  catch (e) { console.log(red("  " + file + " does not parse: " + e.message)); tally.errors++; return; }

  console.log("\n" + bold(file) + dim("  — " + (doc.name || doc.id || "")));

  const targets = [];
  if (doc.base && String(doc.base.address || "").trim()) {
    const need = FORCE || doc.base.lat === undefined || doc.base.lat === null ||
                 doc.base.lng === undefined || doc.base.lng === null;
    targets.push({ kind: "base", key: "__base__", name: doc.base.name, address: doc.base.address, need });
  }
  (doc.places || []).forEach((p) => {
    const addr = String(p.address || "").trim();
    if (!addr) { tally.noAddress++; console.log("  " + dim("—     " + (p.name || p.id) + "  (no address — stays null)")); return; }
    const need = FORCE || p.lat === null || p.lat === undefined || p.lng === null || p.lng === undefined;
    targets.push({ kind: "place", key: p.id, name: p.name, address: addr, need });
  });

  const fixes = Object.create(null);
  let baseFix = null;

  for (const t of targets) {
    if (!t.need) {
      tally.already++;
      console.log("  " + dim("=     " + (t.name || t.key) + "  (already has coordinates)"));
      continue;
    }
    let hit = null, err = null;
    try { hit = await resolve(t.name, t.address); }
    catch (e) { err = e; }

    const label = (t.kind === "base" ? "Nest · " : "") + (t.name || t.key);
    if (err) {
      tally.errors++;
      console.log("  " + red("!  " + label) + "  " + dim(err.message));
    } else if (!hit) {
      tally.miss++;
      console.log("  " + yellow("✗  " + label) + dim("  no Nominatim match"));
    } else {
      tally.hit++;
      const TIER = { 1: "", 2: " [address only]", 3: " [name + locality]" };
      const flag = dim(TIER[hit.tier] || "");
      console.log("  " + green("✓  " + label) + "  " + coord(hit.lat) + ", " + coord(hit.lng) + flag);
      console.log("     " + dim(String(hit.display || "").slice(0, 104)));
      if (t.kind === "base") baseFix = { lat: hit.lat, lng: hit.lng };
      else fixes[t.key] = { lat: hit.lat, lng: hit.lng };
    }
  }

  // base always GAINS the fields, even on a miss: the schema addition is
  // "lat/lng, nullable" and an explicit null is the honest value for a base
  // whose address the geocoder could not resolve.
  const baseWantsFields = doc.base && (doc.base.lat === undefined || doc.base.lng === undefined);
  const nothingToDo = !baseFix && !baseWantsFields && !Object.keys(fixes).length;
  if (nothingToDo) { console.log("  " + dim("nothing to write")); return; }

  const lines = before.split("\n");
  let n = 0;
  if (doc.base && (baseFix || baseWantsFields)) n += spliceBase(lines, baseFix);
  n += splicePlaces(lines, fixes);
  const after = lines.join("\n");

  // verify BEFORE writing
  let reparsed;
  try { reparsed = JSON.parse(after); }
  catch (e) {
    tally.errors++;
    console.log("  " + red("ABORT — the spliced file does not parse: " + e.message));
    return;
  }
  const drift = [];
  diffIgnoringCoords(doc, reparsed, "trip", drift);
  if (drift.length) {
    tally.errors++;
    console.log("  " + red("ABORT — the splice changed more than lat/lng:"));
    drift.slice(0, 10).forEach((d) => console.log("      " + d));
    return;
  }
  // and the byte-level check: only lat/lng (and base's address comma) lines moved
  const badLine = unexpectedLineChange(before, after);
  if (badLine) {
    tally.errors++;
    console.log("  " + red("ABORT — unexpected line change: " + badLine));
    return;
  }

  if (DRY) { console.log("  " + dim("--dry-run: " + n + " line(s) would change")); return; }
  await writeFile(full, after, "utf8");
  tally.written++;
  console.log("  " + bold("wrote " + n + " line(s)"));
}

/* Line-level guard: every line that differs must be a lat/lng line, or the
   base "address" line that only gained a trailing comma. */
function unexpectedLineChange(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    const isCoord = (s) => RE_LAT.test(s) || RE_LNG.test(s);
    if (isCoord(b[j]) && !isCoord(a[i])) { j++; continue; }         // an inserted lat/lng
    if (isCoord(a[i]) && isCoord(b[j])) { i++; j++; continue; }     // a rewritten lat/lng
    if (a[i] + "," === b[j] && RE_ADDRESS.test(a[i])) { i++; j++; continue; }  // address gained a comma
    return "line " + (i + 1) + ": " + JSON.stringify(a[i]) + " -> " + JSON.stringify(b[j]);
  }
  return null;
}

/* ── main ─────────────────────────────────────────────────────────────────── */
async function main() {
  if (typeof fetch !== "function") {
    console.error(red("This script needs Node 18+ (global fetch). Node " + process.version + " found."));
    process.exit(1);
  }
  console.log(bold("wayfeather geocode") + dim("  — Nominatim, 1 req/s, cached"));
  console.log(dim("  cache: scripts/.geocode-cache.json" + (FORCE ? "  (--force: ignored)" : "")));
  if (DRY) console.log(yellow("  --dry-run: no file will be written"));

  await loadCache();

  const all = (await readdir(TRIPS))
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .sort();
  const files = ONLY ? all.filter((f) => f === ONLY) : all;
  if (!files.length) { console.error(red("no trip files matched")); process.exit(1); }

  const tally = { hit: 0, miss: 0, already: 0, noAddress: 0, errors: 0, written: 0 };
  try {
    for (const f of files) await doTrip(f, tally);
  } finally {
    await saveCache();
  }

  const looked = tally.hit + tally.miss;
  const rate = looked ? Math.round((tally.hit / looked) * 100) : 100;
  console.log("\n" + bold("summary"));
  /* Phrased as "of what was looked up THIS RUN": on an idempotent re-run every
     coordinate is already in place and only the known misses are retried, and
     a bare "0% hit rate" would read like a regression rather than a no-op. */
  console.log("  resolved      " + tally.hit + " / " + looked +
              (looked ? "   (" + rate + "% of the lookups this run)" : ""));
  if (tally.miss) console.log("  " + yellow("unmatched     " + tally.miss + "   (left null — nothing was invented)"));
  if (tally.already) console.log("  unchanged     " + tally.already + "   (already had coordinates)");
  console.log("  no address    " + tally.noAddress + "   (Drive legs / notes — stay null by design)");
  console.log("  requests      " + requestCount + "   (everything else came from the cache)");
  console.log("  files written " + tally.written);
  if (tally.errors) {
    console.log("  " + red("errors        " + tally.errors));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(red(String(e && e.stack || e))); process.exit(1); });
