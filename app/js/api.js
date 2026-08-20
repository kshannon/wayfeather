/* api.js — the GitHub Contents API client (DESIGN §2, §4).

   One transport for both directions:

     GET  /repos/{owner}/{repo}/contents/data/trips/{file}  → { content(base64), sha }
     PUT  /repos/{owner}/{repo}/contents/data/trips/{file}  ← { message, content, sha }

   The blob `sha` returned by the GET is the optimistic-concurrency token for the
   PUT: send a stale one and GitHub answers 409/422, which is the signal that the
   other phone wrote first (the retry lives in sync.js).

   Auth is one fine-grained PAT, supplied by the caller and sent ONLY as an
   Authorization header — never a query parameter, never logged, never stored
   here. `token` is optional throughout: a PUBLIC data repo reads keyless, which
   is what makes the read path testable without any credential at all.

   Everything in this file except the two request functions is pure, so the
   fiddly parts (base64, commit messages, the rebase, the JSON re-serialize) are
   unit-testable with no network and no DOM. */

export const API_ROOT = "https://api.github.com";
export const API_VERSION = "2022-11-28";

/* Where trip files live inside whichever repo holds them — the same layout in
   this public app repo and in the private data repo (DESIGN §2). */
export const DATA_PATH = "data/trips/";

/* ══ ERRORS ════════════════════════════════════════════════════════════════
   One error type with a machine-readable `code`, because the write path has to
   branch on it: conflicts retry, everything else surfaces. */
export class ApiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.code = code;                       // see CODES below
    this.status = (extra && extra.status) || 0;
    this.detail = (extra && extra.detail) || "";
  }
}

export const CODES = {
  OFFLINE: "offline",             // fetch itself threw — no network, DNS, CORS
  UNAUTHORIZED: "unauthorized",   // 401 — no token, or it is invalid/expired
  FORBIDDEN: "forbidden",         // 403 — token lacks Contents write here
  RATE_LIMITED: "rate-limited",   // 403/429 with the rate-limit budget spent
  NOT_FOUND: "not-found",         // 404 — wrong owner/repo/path… or a PRIVATE
                                  //       repo read without a token: GitHub
                                  //       answers 404 rather than admit it exists
  CONFLICT: "conflict",           // 409/422 — stale sha, someone wrote first
  TOO_LARGE: "too-large",         // >1MB: the API stops inlining content
  BAD_JSON: "bad-json",           // the file decoded but is not JSON
  SERVER: "server",               // 5xx
  HTTP: "http"                    // anything else
};

/* 422 is lumped in with 409 deliberately. GitHub uses it for "sha didn't match"
   as well as for genuine validation failures; DESIGN §4 prescribes one retry for
   both, and a retry costs one request when the cause turns out to be real
   invalidity. `status` is preserved so a caller can still tell them apart. */
function classify(status, body, headers) {
  const detail = (body && (body.message || body.error)) || "";
  const spent = headers && headers.get && headers.get("x-ratelimit-remaining") === "0";
  if (status === 401) return new ApiError(CODES.UNAUTHORIZED, detail || "Not authorized", { status, detail });
  if (status === 403) {
    return spent
      ? new ApiError(CODES.RATE_LIMITED, detail || "Rate limit reached", { status, detail })
      : new ApiError(CODES.FORBIDDEN, detail || "Forbidden", { status, detail });
  }
  if (status === 429) return new ApiError(CODES.RATE_LIMITED, detail || "Rate limit reached", { status, detail });
  if (status === 404) return new ApiError(CODES.NOT_FOUND, detail || "Not found", { status, detail });
  if (status === 409 || status === 422) return new ApiError(CODES.CONFLICT, detail || "Conflict", { status, detail });
  if (status >= 500) return new ApiError(CODES.SERVER, detail || "GitHub error", { status, detail });
  return new ApiError(CODES.HTTP, detail || ("HTTP " + status), { status, detail });
}

/* ══ BASE64 (unicode-safe, "$$"-safe) ══════════════════════════════════════
   Hand-rolled rather than btoa/atob on purpose:
     · btoa throws on any code point > 255, so it needs a binary-string dance;
     · atob throws on the newlines GitHub wraps its base64 with (60 columns);
     · Node's globals are flagged deprecated, and this must behave identically
       in Vitest under Node and in iOS Safari.
   One path, no environment gates, covered by round-trip tests. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const INV = (() => {
  const m = new Uint8Array(256).fill(255);
  for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();

export function b64encode(text) {
  const bytes = new TextEncoder().encode(text == null ? "" : String(text));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const c = i + 2 < bytes.length ? bytes[i + 2] : -1;
    const n = (a << 16) | ((b < 0 ? 0 : b) << 8) | (c < 0 ? 0 : c);
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] +
      (b < 0 ? "=" : B64[(n >>> 6) & 63]) +
      (c < 0 ? "=" : B64[n & 63]);
  }
  return out;
}

export function b64decode(b64) {
  const s = b64 == null ? "" : String(b64);
  const out = new Uint8Array(((s.length * 3) >> 2) + 3);
  let n = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 61) break;                       // '=' — padding ends the data
    const v = code < 256 ? INV[code] : 255;
    if (v === 255) continue;                      // newlines, spaces, stray bytes
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >>> bits) & 255; }
  }
  return new TextDecoder().decode(out.subarray(0, n));
}

/* ══ JSON TEXT ═════════════════════════════════════════════════════════════
   Re-serialize a mutated doc in the shape the file already had, so a one-field
   edit produces a one-line diff instead of reindenting the whole trip.

   This is also the answer to the `$$` gotcha (CLAUDE.md): the write path parses
   and re-serializes, and JSON.stringify never runs a replacement pattern, so a
   `"cost": "$$"` survives untouched. Splicing the doc with String.replace would
   eat it — there is a regression test that pins exactly that.

   Known and accepted: parse/serialize NORMALISES number literals, so a hand-
   written `"lng": -87.626950` comes back as `-87.62695`. Same value, one extra
   line in the diff, once, on the first write to that file — the price of not
   splicing strings. Trailing zeros are the only case in the fixtures. */
export function detectIndent(text) {
  const m = /^\s*[{[]\r?\n([ \t]+)/.exec(text == null ? "" : String(text));
  if (!m) return 2;
  return m[1][0] === "\t" ? "\t" : m[1].length;
}

export function serializeLike(text, doc) {
  const src = text == null ? "" : String(text);
  const out = JSON.stringify(doc, null, detectIndent(src));
  return (src === "" || /\n$/.test(src)) ? out + "\n" : out;
}

/* ══ COMMIT MESSAGES ═══════════════════════════════════════════════════════
   CLAUDE.md: data commits written by the app are `add:`/`edit:` + place + day.
   DESIGN §4 adds the coalesced form, because a flurry of taps is ONE commit:

     add: Los Tacos No.1 (thu)
     edit: hours — Frick
     visit: Economy Candy + 2 more (thu)

   Rules: one verb when every change shares a kind, `edit:` when they are mixed
   (the sanctioned generic); the day suffix only when every change agrees on a
   day; "+ N more" counts distinct places past the first. */
const VERBS = { add: "add", edit: "edit", visit: "visit", skip: "skip", move: "move" };

/* Bookkeeping the human did not type — never worth naming in a subject line. */
const QUIET_FIELDS = { updatedAt: 1, visited: 1, skipped: 1, id: 1, lat: 1, lng: 1 };

const FIELD_WORDS = {
  name: "name", time: "time", day: "day", cluster: "cluster", hours: "hours",
  cost: "cost", notes: "notes", priority: "priority", address: "address",
  website: "website", warn: "warn", type: "type", yelp: "yelp", gmaps: "map link"
};

function namedFields(change) {
  const patch = (change && change.patch) || null;
  if (!patch) return [];
  return Object.keys(patch)
    .filter((k) => !QUIET_FIELDS[k])
    .map((k) => FIELD_WORDS[k] || k);
}

export function commitMessage(changes) {
  const list = (Array.isArray(changes) ? changes : []).filter(Boolean);
  if (!list.length) return "edit: trip data";

  /* Distinct places, first appearance wins — the buffer coalesces per place
     already, this is belt and braces so "+ 2 more" can never over-count. */
  const seen = Object.create(null);
  const uniq = [];
  list.forEach((c) => {
    const key = c.placeId || c.name || String(uniq.length);
    if (seen[key]) return;
    seen[key] = 1;
    uniq.push(c);
  });

  const kinds = uniq.map((c) => VERBS[c.kind] || "edit");
  const verb = kinds.every((k) => k === kinds[0]) ? kinds[0] : "edit";

  const days = uniq.map((c) => c.day || "").filter(Boolean);
  const oneDay = days.length === uniq.length && days.every((d) => d === days[0]) ? days[0] : "";
  const suffix = oneDay ? " (" + oneDay + ")" : "";

  const head = uniq[0];
  const name = (head && head.name) || "stopover";

  if (uniq.length === 1) {
    /* A single edit names what changed, which is what makes `git log` read as a
       trip changelog. Three or more fields is a rewrite, not a tweak — name the
       place instead of listing everything. */
    const fields = verb === "edit" ? namedFields(head) : [];
    if (fields.length && fields.length <= 2) return "edit: " + fields.join(", ") + " — " + name;
    return verb + ": " + name + suffix;
  }
  return verb + ": " + name + " + " + (uniq.length - 1) + " more" + suffix;
}

/* ══ REBASE ════════════════════════════════════════════════════════════════
   The conflict retry in one function: take the doc that just came off the wire,
   apply the pending patches to a COPY of it, hand back the result. Copying is
   the point — the fresh doc stays pristine, so a failed apply cannot leave a
   half-mutated object to be PUT on the next attempt. */
export function rebase(applyPatches, freshDoc) {
  if (!freshDoc || typeof freshDoc !== "object") {
    throw new ApiError(CODES.BAD_JSON, "Nothing to rebase onto");
  }
  const clone = JSON.parse(JSON.stringify(freshDoc));
  const out = applyPatches(clone);
  return out === undefined ? clone : out;
}

/* ══ URLS + REQUESTS ═══════════════════════════════════════════════════════ */
/* Path segments are encoded individually so the slashes survive and a stray
   space or "#" in a filename cannot break out of the path. Dot segments are
   dropped rather than encoded: `file` ultimately comes from index.json, and a
   filename of "../../x" should address nothing at all rather than climb out of
   data/trips/. */
export function contentsUrl(owner, repo, path) {
  const segs = String(path || "").split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .map(encodeURIComponent);
  return API_ROOT + "/repos/" + encodeURIComponent(owner) + "/" +
    encodeURIComponent(repo) + "/contents/" + segs.join("/");
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : "";
}

function headers(token) {
  const h = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION
  };
  /* Only when we actually have one: a public repo reads keyless, and sending an
     empty Authorization header turns a working anonymous read into a 401. */
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}

async function readBody(res) {
  try { return await res.json(); } catch (e) { return null; }
}

async function send(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    /* fetch only rejects for transport failures — offline, DNS, CORS. An HTTP
       error status is a resolved promise and is classified below. */
    throw new ApiError(CODES.OFFLINE, "Could not reach GitHub", { detail: String(e && e.message || e) });
  }
  const body = await readBody(res);
  if (!res.ok) throw classify(res.status, body, res.headers);
  return body;
}

/* Returns { doc, text, sha, path }.
     doc  — the parsed trip/index payload
     text — the file exactly as stored, so a write can match its formatting
     sha  — the blob sha: the concurrency token AND the stamp's short sha */
export async function getFile(opts) {
  const { owner, repo, path, token } = opts || {};
  const body = await send(contentsUrl(owner, repo, path), {
    method: "GET",
    headers: headers(token),
    cache: "no-store"          // DESIGN §4: the refresh button must not lie
  });

  if (!body || typeof body !== "object") {
    throw new ApiError(CODES.BAD_JSON, "GitHub returned no file body");
  }
  /* Over 1MB the API stops inlining content (encoding "none") and wants the
     Blobs API instead. Trip files are ~8KB, so this is a guard, not a path. */
  if (body.encoding !== "base64" || typeof body.content !== "string") {
    throw new ApiError(CODES.TOO_LARGE, "That file is too large to read this way",
      { detail: String(body.encoding || "") });
  }

  const text = b64decode(body.content);
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { throw new ApiError(CODES.BAD_JSON, "That file is not valid JSON", { detail: path }); }
  return { doc, text, sha: body.sha || null, path: body.path || path };
}

/* Returns { sha, commit, path } — `sha` is the NEW blob sha, `commit` the commit
   sha that the indicator shows. Omit `sha` in the request to create a file. */
export async function putFile(opts) {
  const { owner, repo, path, token, content, sha, message, keepalive } = opts || {};
  const payload = { message: message || "edit: trip data", content: b64encode(content) };
  if (sha) payload.sha = sha;

  const init = {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, headers(token)),
    body: JSON.stringify(payload)
  };
  /* Backgrounding flush: iOS suspends a PWA the moment it leaves the screen and
     an in-flight fetch dies with it. keepalive survives that — but it is capped
     at 64KB of request body, so it is only asked for when the body fits. */
  if (keepalive && init.body.length < 60000) init.keepalive = true;

  const body = await send(contentsUrl(owner, repo, path), init);
  return {
    sha: (body && body.content && body.content.sha) || null,
    commit: (body && body.commit && body.commit.sha) || null,
    path: (body && body.content && body.content.path) || path
  };
}
