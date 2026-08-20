/* sync.js — the write path and its debounce (DESIGN §4).

   Mutations never push instantly. Every change — landed, flew past, an edit, an
   add, a move, find-me-something — lands in a pending buffer that pushes after a
   5-second quiet window, capped at 20 seconds of total deferral, coalesced into
   ONE commit. A flurry of taps makes one history entry, not five, and an UNDO
   inside the window cancels cleanly: an accidental tap never reaches git at all.

   The cancel is not a special case. Every mutation carries the value the field
   had in the published doc (`before`), so an undo is simply the next mutation —
   one that happens to restore the original. When a buffered entry's patch has
   come back to `before` on every key, the entry is dropped. Tap, undo, nothing
   in the log.

   The same buffer IS the offline queue (DESIGN §4): with no network, or with
   Settings unconfigured, it just holds, and the indicator says so.

   Storage, the DOM and the config all arrive through init() rather than
   imports, so the whole engine runs headless under Vitest with fake timers and
   a mocked fetch. createSync() hands out isolated instances for exactly that;
   the app uses the `sync` singleton at the bottom. */

import {
  getFile, putFile, commitMessage, rebase, serializeLike, shortSha, CODES, DATA_PATH
} from "./api.js";

/* DESIGN §4: "~5-second quiet window", "capped at ~20s total deferral". */
export const QUIET_MS = 5000;
export const CAP_MS = 20000;

/* ══ PURE BUFFER MATH ══════════════════════════════════════════════════════ */

/* Absent, null and "" all mean "nothing here" in this schema (DESIGN §3), so a
   field that goes null → "" is not a change worth a commit. */
export function sameValue(a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === nb) return true;
  if ((na === null && nb === "") || (nb === null && na === "")) return true;
  if (na && nb && typeof na === "object" && typeof nb === "object") {
    return JSON.stringify(na) === JSON.stringify(nb);
  }
  return false;
}

/* Has this entry come back to exactly what the published file already says? */
export function isRestored(entry) {
  if (!entry || entry.kind === "add" || !entry.before || !entry.patch) return false;
  const keys = Object.keys(entry.patch);
  if (!keys.length) return true;
  return keys.every((k) => sameValue(entry.patch[k], entry.before[k]));
}

function mergeEntry(cur, next) {
  /* A re-add of the same id replaces outright — there is nothing sane to merge
     a whole place object into a field patch. */
  if (next.kind === "add") return Object.assign({}, next);

  const out = Object.assign({}, cur);
  out.name = next.name || cur.name;
  out.day = next.day || cur.day;
  out.at = next.at || cur.at;

  if (cur.kind === "add") {
    /* Added-then-edited is still one add: fold the edits into the new place so
       the commit reads `add: …`, not an add plus an edit of something that was
       never published. */
    out.place = Object.assign({}, cur.place, next.patch);
    out.kind = "add";
    return out;
  }

  out.patch = Object.assign({}, cur.patch, next.patch);
  out.before = cur.before;                     // published values never move
  /* Mixed kinds collapse to the generic verb rather than letting the last tap
     rename the whole commit ("visit:" for a change that also moved a day). */
  out.kind = cur.kind === next.kind ? cur.kind : "edit";
  return out;
}

/* Fold one mutation into the buffer. Returns a NEW array — the engine keeps its
   own reference, and tests can call this with no engine at all.

   Entries already in flight are never merged into: a PUT is reading that object
   right now, and quietly mutating it would let the success path delete a change
   that was never actually sent. A mutation arriving mid-flush starts a fresh
   entry instead, and the next quiet window picks it up. */
export function coalesce(buffer, entry) {
  const list = (buffer || []).slice();
  if (!entry || !entry.placeId || !entry.file) return list;

  const i = list.findIndex((e) =>
    !e.sending && e.file === entry.file && e.placeId === entry.placeId);

  if (i < 0) {
    if (isRestored(entry)) return list;        // a tap and its undo, net zero
    list.push(entry);
    return list;
  }

  const merged = mergeEntry(list[i], entry);
  if (isRestored(merged)) { list.splice(i, 1); return list; }
  list[i] = merged;
  return list;
}

/* Apply the pending entries to a doc that just came off the wire. Mutates the
   doc it is handed — always called through api.rebase(), which hands it a copy. */
export function applyAll(doc, entries) {
  if (!doc || typeof doc !== "object") return doc;
  if (!Array.isArray(doc.places)) doc.places = [];
  const byId = new Map();
  doc.places.forEach((p) => { if (p && p.id) byId.set(p.id, p); });

  (entries || []).forEach((e) => {
    if (!e) return;
    if (e.kind === "add" && e.place) {
      const found = byId.get(e.place.id);
      if (found) { Object.assign(found, e.place); return; }
      const fresh = JSON.parse(JSON.stringify(e.place));
      doc.places.push(fresh);
      byId.set(fresh.id, fresh);
      return;
    }
    const p = byId.get(e.placeId);
    /* Gone upstream — the other phone hard-deleted it. Reapplying would
       resurrect a place someone deliberately removed, so the patch is dropped;
       the local overlay still shows it until the next read. */
    if (!p || !e.patch) return;
    Object.assign(p, e.patch);
  });
  return doc;
}

export function groupByFile(entries) {
  const map = new Map();
  (entries || []).forEach((e) => {
    if (!e || !e.file) return;
    if (!map.has(e.file)) map.set(e.file, []);
    map.get(e.file).push(e);
  });
  return Array.from(map.entries()).map(([file, list]) => ({ file, entries: list }));
}

/* ══ INDICATOR ═════════════════════════════════════════════════════════════
   DESIGN §4: a small indicator distinguishes "saved on this phone" from
   "synced · a1b2c3d" so either person knows when the other can see a change. */
export function indicatorText(state, sha) {
  switch (state) {
    case "local":   return "saved on this phone";
    case "pending": return "saved on this phone";
    case "syncing": return "syncing…";
    case "synced":  return sha ? "synced · " + sha : "synced";
    case "offline": return "saved on this phone · offline";
    case "error":   return "saved on this phone · not synced";
    default:        return "";
  }
}

/* What the toast says when a flush fails. The buffer is kept in every one of
   these cases, so every message has to leave the person confident the change is
   not lost — it is on the phone, it just is not in git yet. */
export function errorMessage(err, hasToken) {
  const code = (err && err.code) || "";
  if (code === CODES.UNAUTHORIZED || code === CODES.FORBIDDEN) {
    return hasToken
      ? "GitHub refused that token — check Settings. Changes are saved on this phone."
      : "Add a GitHub token in Settings to sync. Changes are saved on this phone.";
  }
  if (code === CODES.RATE_LIMITED) return "GitHub rate limit reached — changes are saved on this phone.";
  if (code === CODES.NOT_FOUND) return "Could not find that repo or file — check Settings.";
  if (code === CODES.CONFLICT) return "Someone else is editing — will try again.";
  if (code === CODES.OFFLINE) return "Offline — changes are saved on this phone.";
  if (code === CODES.TOO_LARGE) return "That trip file is too large to write.";
  if (code === CODES.BAD_JSON) return "That trip file could not be read — changes are saved on this phone.";
  return "GitHub is having trouble — changes are saved on this phone.";
}

/* ══ THE ENGINE ════════════════════════════════════════════════════════════ */
export function createSync(overrides) {
  const deps = Object.assign({
    getConfig: () => ({ owner: "", repo: "", token: "" }),
    client: { getFile, putFile },
    toast: () => {},
    onIndicator: () => {},
    onSettled: () => {},
    loadBuffer: () => [],
    saveBuffer: () => {},
    online: () => (typeof navigator === "undefined" || navigator.onLine !== false),
    quietMs: QUIET_MS,
    capMs: CAP_MS
  }, overrides || {});

  let buffer = [];
  let quietT = null, capT = null;
  let running = null, again = false;
  let shown = { state: "idle", text: "", sha: "" };

  function configured() {
    const c = deps.getConfig() || {};
    return !!(c.owner && c.repo);
  }

  function paint(state, sha) {
    const s = state || (buffer.length ? (configured() ? "pending" : "local") : shown.state);
    const next = { state: s, text: indicatorText(s, sha || ""), sha: sha || "" };
    shown = next;
    deps.onIndicator(next);
  }

  function persist() {
    /* `sending` is in-flight bookkeeping, not data — a reload must not inherit
       a flag whose PUT died with the old page. */
    deps.saveBuffer(buffer.map((e) => {
      const c = Object.assign({}, e);
      delete c.sending;
      return c;
    }));
  }

  function clearTimers() {
    if (quietT) { clearTimeout(quietT); quietT = null; }
    if (capT) { clearTimeout(capT); capT = null; }
  }

  function schedule() {
    if (!buffer.some((e) => !e.sending)) { clearTimers(); return; }
    if (quietT) clearTimeout(quietT);
    quietT = setTimeout(() => { quietT = null; flush("quiet"); }, deps.quietMs);
    /* The cap is measured from the first mutation of this streak, not from the
       last one — that is the whole point of a cap. It is armed once and left
       alone while the quiet window keeps being pushed back. */
    if (!capT) capT = setTimeout(() => { capT = null; flush("cap"); }, deps.capMs);
  }

  function normalize(raw) {
    if (!raw || !raw.placeId || !raw.file) return null;
    const e = {
      file: raw.file,
      tripId: raw.tripId || "",
      kind: raw.kind || "edit",
      placeId: raw.placeId,
      name: raw.name || "",
      day: raw.day || "",
      at: raw.at || Date.now()
    };
    if (e.kind === "add") {
      if (!raw.place) return null;
      e.place = raw.place;
    } else {
      if (!raw.patch) return null;
      e.patch = raw.patch;
      e.before = raw.before || null;
    }
    return e;
  }

  /* The mutation sink. state.js calls this for every write it makes. */
  function record(raw) {
    const entry = normalize(raw);
    if (!entry) return;
    buffer = coalesce(buffer, entry);
    persist();
    if (!buffer.length) {
      /* The undo emptied the buffer: stand the timers down so the cancelled
         change cannot be resurrected by a stale quiet-window callback. */
      clearTimers();
      paint("idle");
      return;
    }
    schedule();
    paint();
  }

  /* Explicit cancel — everything the app does today cancels through the
     restore-to-`before` rule above, but a caller that knows it is abandoning a
     change outright (a discarded add) can say so directly. */
  function cancel(placeId, file) {
    const before = buffer.length;
    buffer = buffer.filter((e) =>
      e.sending || e.placeId !== placeId || (file && e.file !== file));
    if (buffer.length === before) return;
    persist();
    if (!buffer.length) { clearTimers(); paint("idle"); return; }
    paint();
  }

  function settle(entries, result) {
    const gone = new Set(entries);
    buffer = buffer.filter((e) => !gone.has(e));
    persist();
    /* Tell state.js these values are published now, so the local overlay can
       stop shadowing them and "N local changes" stops counting them. The doc
       that was just written goes with them — it is the new published truth. */
    try { deps.onSettled(entries, result); } catch (e) { /* never break a sync on a repaint */ }
  }

  async function pushOne(group, cfg, reason) {
    const entries = group.entries;
    entries.forEach((e) => { e.sending = true; });
    const path = DATA_PATH + group.file;
    let attempt = 0;

    for (;;) {
      try {
        /* Always a FRESH read immediately before the write: the sha it carries
           is the concurrency token, and re-reading is also how the retry
           rebases (DESIGN §4). */
        const fresh = await deps.client.getFile({
          owner: cfg.owner, repo: cfg.repo, path, token: cfg.token
        });
        const next = rebase((d) => applyAll(d, entries), fresh.doc);
        const res = await deps.client.putFile({
          owner: cfg.owner, repo: cfg.repo, path, token: cfg.token,
          content: serializeLike(fresh.text, next),
          sha: fresh.sha,
          message: commitMessage(entries),
          keepalive: reason === "hidden"
        });
        settle(entries, {
          file: group.file, doc: next, sha: res.sha, commit: res.commit
        });
        return shortSha(res.commit || res.sha);
      } catch (err) {
        /* 409/422 — the other phone wrote first. Loop once: re-GET, re-apply,
           retry. A second conflict surfaces and keeps the buffer. */
        if (err && err.code === CODES.CONFLICT && attempt === 0) { attempt++; continue; }
        entries.forEach((e) => { e.sending = false; });
        throw err;
      }
    }
  }

  /* Callers AWAIT a flush that is already running rather than being handed an
     instant resolve — pull-to-refresh's whole contract is that the write is
     done before the re-read starts (DESIGN §4), and a quiet-window flush that
     happened to fire a moment earlier must not break it. `running` is cleared
     before any follow-up flush so a promise can never be chained to itself. */
  function flush(reason) {
    if (running) { again = true; return running; }
    running = runFlush(reason).then((r) => {
      running = null;
      if (again) { again = false; if (buffer.length) return flush(reason); }
      return r;
    }, (e) => { running = null; throw e; });
    return running;
  }

  async function runFlush(reason) {
    clearTimers();
    if (!buffer.length) { paint(); return; }

    const cfg = deps.getConfig() || {};
    /* Unconfigured is not a failure — it is M1's local-only mode, still the
       default. The buffer holds and the indicator says where the change lives. */
    if (!cfg.owner || !cfg.repo) { paint("local"); return; }
    if (!deps.online()) { paint("offline"); return; }

    paint("syncing");
    let sha = "", failed = null;
    try {
      const groups = groupByFile(buffer.filter((e) => !e.sending));
      for (const g of groups) sha = (await pushOne(g, cfg, reason)) || sha;
    } catch (err) {
      failed = err;
    }

    if (failed) {
      deps.toast(errorMessage(failed, !!cfg.token));
      paint(failed.code === CODES.OFFLINE ? "offline" : "error");
      /* No auto-retry loop: a 403 would spin forever and an offline phone would
         burn battery. The next mutation, pull-to-refresh, foreground or
         `online` event picks the buffer back up. */
    } else if (buffer.length) {
      paint();
      schedule();
    } else {
      paint("synced", sha);
    }
    /* The `again` re-entry is handled by flush()'s wrapper, after `running` has
       been cleared — doing it here would chain a promise to itself. */
    if (failed) again = false;
  }

  return {
    init(opts) {
      Object.assign(deps, opts || {});
      const saved = deps.loadBuffer() || [];
      buffer = Array.isArray(saved) ? saved.map(normalize).filter(Boolean) : [];
      if (buffer.length) { schedule(); paint(); } else paint("idle");
      return this;
    },
    record,
    cancel,
    /* Flush triggers (DESIGN §4): the quiet window, the cap, pull-to-refresh
       (which awaits this BEFORE its re-GET), and backgrounding. */
    flushNow(reason) { return flush(reason || "manual"); },
    discardAll() {
      buffer = [];
      clearTimers();
      persist();
      paint("idle");
    },
    pending() { return buffer.length; },
    entries() { return buffer.slice(); },
    state() { return Object.assign({}, shown); }
  };
}

/* The app's one engine. main.js calls init() with the real storage, config and
   toast; nothing else in the app constructs a second one. */
export const sync = createSync();
