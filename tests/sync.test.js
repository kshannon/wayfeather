/* sync.test.js — the write path's debounce and conflict retry (DESIGN §4).

   The engine takes its storage, config, toast and HTTP client through init(),
   so all of this runs headless: no DOM, no localStorage, no network. Timing is
   asserted with fake timers rather than sleeps, and the conflict retry is run
   through the REAL api.js against a stubbed global fetch, so the base64, the
   sha handling and the error classification are all in the loop.

   No real credential exists anywhere in this file; the write tests either send
   no token at all or an obvious placeholder. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createSync, coalesce, applyAll, sameValue, isRestored, groupByFile,
  indicatorText, errorMessage, QUIET_MS, CAP_MS
} from "../app/js/sync.js";
import { b64encode, b64decode, CODES, ApiError } from "../app/js/api.js";

const FILE = "chicago-test.json";
const PATH = "data/trips/" + FILE;
const FAKE_TOKEN = "not-a-real-token-0000";

const TRIP_TEXT = readFileSync(
  new URL("../data/trips/chicago-test.json", import.meta.url), "utf8");
const TRIP = JSON.parse(TRIP_TEXT);
const P0 = TRIP.places[0].id;
const P1 = TRIP.places[1].id;
const P2 = TRIP.places[2].id;

/* ── entry factories, shaped exactly as state.js reports them ─────────────── */
function visit(placeId, name, day, at) {
  return {
    file: FILE, tripId: "chicago-test", kind: "visit", placeId, name, day,
    patch: { visited: at || "2027-06-04T15:12:00.000Z", skipped: null },
    before: { visited: null, skipped: null }
  };
}
function unvisit(placeId, name, day) {
  return {
    file: FILE, tripId: "chicago-test", kind: "edit", placeId, name, day,
    patch: { visited: null, skipped: null },
    before: { visited: null, skipped: null }
  };
}
function edit(placeId, name, day, patch, before) {
  return {
    file: FILE, tripId: "chicago-test", kind: "edit", placeId, name, day,
    patch, before: before || {}
  };
}
function add(place) {
  return {
    file: FILE, tripId: "chicago-test", kind: "add",
    placeId: place.id, name: place.name, day: place.day, place
  };
}

/* ── a harness with everything injected ──────────────────────────────────── */
function harness(opts) {
  const o = opts || {};
  const log = [];
  const state = {
    toasts: [], paints: [], settled: [], stored: o.stored || [],
    online: o.online !== false,
    cfg: o.cfg || { owner: "kshannon", repo: "wayfeather-data", token: FAKE_TOKEN },
    log
  };

  const client = {
    getFile: vi.fn(async (a) => {
      log.push("GET " + a.path);
      return { doc: JSON.parse(TRIP_TEXT), text: TRIP_TEXT, sha: "sha-old", path: a.path };
    }),
    putFile: vi.fn(async (a) => {
      log.push("PUT " + a.path);
      state.lastPut = a;
      return { sha: "sha-new", commit: "c0ffee1234567890", path: a.path };
    })
  };

  const deps = {
    getConfig: () => state.cfg,
    client: o.client || client,
    toast: (m) => state.toasts.push(m),
    onIndicator: (p) => state.paints.push(p),
    onSettled: (entries, result) => state.settled.push({ entries, result }),
    loadBuffer: () => state.stored,
    saveBuffer: (b) => { state.stored = b; },
    online: () => state.online,
    quietMs: QUIET_MS,
    capMs: CAP_MS
  };
  /* `real: true` leaves the client key off entirely so the engine keeps api.js's
     own getFile/putFile — that is how the conflict tests below drive the whole
     stack through a stubbed global fetch. */
  if (o.real) delete deps.client;

  const engine = createSync().init(deps);
  return { engine, client, state, last: () => state.paints[state.paints.length - 1] };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete globalThis.fetch; });

/* ══ PURE ══════════════════════════════════════════════════════════════════ */
describe("sameValue — what counts as unchanged", () => {
  it("treats absent, null and empty string as the same nothing", () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(null, "")).toBe(true);
    expect(sameValue("", undefined)).toBe(true);
    expect(sameValue("", "x")).toBe(false);
    expect(sameValue(0, "")).toBe(false);
    expect(sameValue(0, null)).toBe(false);
  });

  it("compares real values strictly, objects structurally", () => {
    expect(sameValue("$$", "$$")).toBe(true);
    expect(sameValue("11–5", "11-5")).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});

describe("coalesce — one entry per place, undo cancels", () => {
  it("adds the first mutation for a place", () => {
    const b = coalesce([], visit(P0, "A", "fri"));
    expect(b).toHaveLength(1);
    expect(b[0].placeId).toBe(P0);
  });

  it("merges a second mutation into the same entry", () => {
    let b = coalesce([], visit(P0, "A", "fri"));
    b = coalesce(b, edit(P0, "A", "fri", { hours: "11–5" }, { hours: "" }));
    expect(b).toHaveLength(1);
    expect(b[0].patch).toEqual({ visited: "2027-06-04T15:12:00.000Z", skipped: null, hours: "11–5" });
  });

  it("collapses mixed kinds to the generic verb", () => {
    let b = coalesce([], visit(P0, "A", "fri"));
    b = coalesce(b, edit(P0, "A", "fri", { hours: "11–5" }, { hours: "" }));
    expect(b[0].kind).toBe("edit");
  });

  it("DROPS the entry when an undo restores every published value", () => {
    /* DESIGN §4: accidental taps never reach git history at all. */
    let b = coalesce([], visit(P0, "A", "fri"));
    expect(b).toHaveLength(1);
    b = coalesce(b, unvisit(P0, "A", "fri"));
    expect(b).toHaveLength(0);
  });

  it("never creates an entry for a mutation that changes nothing", () => {
    expect(coalesce([], unvisit(P0, "A", "fri"))).toHaveLength(0);
    expect(isRestored(unvisit(P0, "A", "fri"))).toBe(true);
    expect(isRestored(visit(P0, "A", "fri"))).toBe(false);
    expect(isRestored(add({ id: "x", name: "X", day: "fri" }))).toBe(false);
  });

  it("keeps an undo that only PARTLY restores", () => {
    let b = coalesce([], edit(P0, "A", "fri", { hours: "11–5", cost: "$22" }, { hours: "", cost: "" }));
    b = coalesce(b, edit(P0, "A", "fri", { hours: "" }, { hours: "", cost: "" }));
    expect(b).toHaveLength(1);
    expect(b[0].patch).toEqual({ hours: "", cost: "$22" });
  });

  it("cannot cancel a change to a place the published file has never seen", () => {
    const e = visit("brand-new", "New", "fri");
    e.before = null;                      // a local add, not in the doc yet
    expect(coalesce([], e)).toHaveLength(1);
  });

  it("keeps places apart, and files apart", () => {
    let b = coalesce([], visit(P0, "A", "fri"));
    b = coalesce(b, visit(P1, "B", "fri"));
    expect(b).toHaveLength(2);
    const other = visit(P0, "A", "fri");
    other.file = "river-road-test.json";
    expect(coalesce(b, other)).toHaveLength(3);
  });

  it("folds edits into a pending add rather than making a second entry", () => {
    const place = { id: "new-spot", name: "New Spot", day: "fri", cost: "" };
    let b = coalesce([], add(place));
    b = coalesce(b, edit("new-spot", "New Spot", "fri", { cost: "$$" }, null));
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("add");
    expect(b[0].place.cost).toBe("$$");
  });

  it("refuses entries with nothing to address", () => {
    expect(coalesce([], null)).toHaveLength(0);
    expect(coalesce([], { placeId: "x" })).toHaveLength(0);   // no file
  });
});

describe("applyAll — patches onto a doc off the wire", () => {
  it("applies field patches by id", () => {
    const doc = JSON.parse(TRIP_TEXT);
    applyAll(doc, [visit(P0, "A", "fri", "2027-06-04T15:00:00.000Z")]);
    expect(doc.places[0].visited).toBe("2027-06-04T15:00:00.000Z");
    expect(doc.places[1].visited ?? null).toBe(null);
  });

  it("appends an added stopover, and merges a re-add of the same id", () => {
    const doc = JSON.parse(TRIP_TEXT);
    const n = doc.places.length;
    applyAll(doc, [add({ id: "new-spot", name: "New Spot", day: "fri" })]);
    expect(doc.places).toHaveLength(n + 1);
    applyAll(doc, [add({ id: "new-spot", name: "Renamed", day: "sat" })]);
    expect(doc.places).toHaveLength(n + 1);
    expect(doc.places[n].name).toBe("Renamed");
  });

  it("carries $$ into the doc untouched", () => {
    const doc = JSON.parse(TRIP_TEXT);
    applyAll(doc, [edit(P0, "A", "fri", { cost: "$$", notes: "about $$ each" }, { cost: "" })]);
    expect(doc.places[0].cost).toBe("$$");
    expect(doc.places[0].notes).toBe("about $$ each");
  });

  it("drops a patch for a place that has vanished upstream", () => {
    const doc = JSON.parse(TRIP_TEXT);
    const before = JSON.stringify(doc);
    applyAll(doc, [visit("deleted-by-the-other-phone", "Gone", "fri")]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("copies the added place rather than sharing the buffer's object", () => {
    const doc = JSON.parse(TRIP_TEXT);
    const entry = add({ id: "new-spot", name: "New Spot", day: "fri" });
    applyAll(doc, [entry]);
    doc.places[doc.places.length - 1].name = "Changed in the doc";
    expect(entry.place.name).toBe("New Spot");
  });
});

describe("groupByFile", () => {
  it("splits a buffer that spans trips into one push each", () => {
    const other = visit(P1, "B", "sat");
    other.file = "river-road-test.json";
    const groups = groupByFile([visit(P0, "A", "fri"), other, visit(P2, "C", "fri")]);
    expect(groups.map((g) => g.file)).toEqual([FILE, "river-road-test.json"]);
    expect(groups[0].entries).toHaveLength(2);
  });
});

describe("indicator + error wording", () => {
  it("says where a change lives, in the DESIGN §4 words", () => {
    expect(indicatorText("local")).toBe("saved on this phone");
    expect(indicatorText("pending")).toBe("saved on this phone");
    expect(indicatorText("syncing")).toBe("syncing…");
    expect(indicatorText("synced", "a1b2c3d")).toBe("synced · a1b2c3d");
    expect(indicatorText("offline")).toBe("saved on this phone · offline");
    expect(indicatorText("idle")).toBe("");
  });

  it("never leaves a failure sounding like data loss", () => {
    const codes = [CODES.UNAUTHORIZED, CODES.FORBIDDEN, CODES.RATE_LIMITED,
      CODES.OFFLINE, CODES.SERVER, CODES.BAD_JSON, "weird"];
    codes.forEach((code) => {
      expect(errorMessage(new ApiError(code, "x"), true).length).toBeGreaterThan(10);
    });
    expect(errorMessage(new ApiError(CODES.UNAUTHORIZED, "x"), false)).toMatch(/Add a GitHub token/);
    expect(errorMessage(new ApiError(CODES.UNAUTHORIZED, "x"), true)).toMatch(/refused that token/);
    expect(errorMessage(new ApiError(CODES.NOT_FOUND, "x"), true)).toMatch(/check Settings/);
  });
});

/* ══ THE DEBOUNCE ══════════════════════════════════════════════════════════ */
describe("debounce — 5s quiet window, 20s cap (DESIGN §4)", () => {
  it("holds for the whole quiet window, then pushes once", async () => {
    const h = harness();
    h.engine.record(visit(P0, "Art Institute", "fri"));

    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(h.client.putFile).not.toHaveBeenCalled();
    expect(h.last().text).toBe("saved on this phone");

    await vi.advanceTimersByTimeAsync(2);
    expect(h.client.getFile).toHaveBeenCalledTimes(1);
    expect(h.client.putFile).toHaveBeenCalledTimes(1);
    expect(h.engine.pending()).toBe(0);
    expect(h.last().text).toBe("synced · c0ffee1");
  });

  it("each new tap pushes the window back", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(4000);
    h.engine.record(visit(P1, "B", "fri"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.client.putFile).not.toHaveBeenCalled();      // 8s in, still quiet
    await vi.advanceTimersByTimeAsync(1001);
    expect(h.client.putFile).toHaveBeenCalledTimes(1);
  });

  it("stops deferring at the 20s cap however long the flurry runs", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri"));
    for (let t = 3000; t <= 18000; t += 3000) {
      await vi.advanceTimersByTimeAsync(3000);
      h.engine.record(visit("place-" + t, "P" + t, "fri"));
      expect(h.client.putFile).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(2001);              // t = 20.001s
    expect(h.client.putFile).toHaveBeenCalledTimes(1);
  });

  it("coalesces a flurry into ONE commit with the design's subject line", async () => {
    const h = harness();
    h.engine.record(visit(P0, "Economy Candy", "thu"));
    h.engine.record(visit(P1, "Katz's", "thu"));
    h.engine.record(visit(P2, "The Frick", "thu"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);

    expect(h.client.getFile).toHaveBeenCalledTimes(1);
    expect(h.client.putFile).toHaveBeenCalledTimes(1);
    expect(h.state.lastPut.message).toBe("visit: Economy Candy + 2 more (thu)");
  });

  it("an undo inside the window reaches git history NEVER", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(2000);
    h.engine.record(unvisit(P0, "A", "fri"));             // one-tap undo

    expect(h.engine.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(CAP_MS + QUIET_MS);
    expect(h.client.getFile).not.toHaveBeenCalled();
    expect(h.client.putFile).not.toHaveBeenCalled();
    expect(h.last().text).toBe("");
  });

  it("an undo of one tap in a flurry still commits the others", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "thu"));
    h.engine.record(visit(P1, "B", "thu"));
    h.engine.record(unvisit(P0, "A", "thu"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.client.putFile).toHaveBeenCalledTimes(1);
    expect(h.state.lastPut.message).toBe("visit: B (thu)");
  });

  it("explicit cancel drops a pending change", async () => {
    const h = harness();
    h.engine.record(add({ id: "new-spot", name: "New Spot", day: "fri" }));
    expect(h.engine.pending()).toBe(1);
    h.engine.cancel("new-spot", FILE);
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.engine.pending()).toBe(0);
    expect(h.client.putFile).not.toHaveBeenCalled();
  });
});

/* ══ FLUSH TRIGGERS ════════════════════════════════════════════════════════ */
describe("flush triggers", () => {
  it("pull-to-refresh flushes BEFORE it re-reads", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri"));

    /* Exactly main.js's refreshData(): flush, then fetch the index. */
    await h.engine.flushNow("refresh");
    await h.client.getFile({ owner: "o", repo: "r", path: "data/trips/index.json" });

    expect(h.state.log).toEqual([
      "GET " + PATH,                     // the pre-write read for the sha
      "PUT " + PATH,                     // the write
      "GET data/trips/index.json"        // only now does the refresh read
    ]);
  });

  it("a refresh AWAITS a flush that is already in flight", async () => {
    /* Otherwise pull-to-refresh could re-read while the PUT it is supposed to
       come after is still on the wire. */
    let release;
    const client = {
      getFile: vi.fn(async () => ({ doc: JSON.parse(TRIP_TEXT), text: TRIP_TEXT, sha: "s" })),
      putFile: vi.fn(() => new Promise((r) => { release = () => r({ sha: "s", commit: "c" }); }))
    };
    const h = harness({ client });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);      // quiet-window flush hangs
    expect(client.putFile).toHaveBeenCalledTimes(1);

    let settled = false;
    const refresh = h.engine.flushNow("refresh").then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);                          // still waiting on the PUT

    release();
    await refresh;
    expect(settled).toBe(true);
    expect(h.engine.pending()).toBe(0);
  });

  it("backgrounding flushes with keepalive so the PUT outlives suspension", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri"));
    await h.engine.flushNow("hidden");
    expect(h.state.lastPut.keepalive).toBe(true);
  });

  it("an ordinary quiet-window flush does not ask for keepalive", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.state.lastPut.keepalive).toBe(false);
  });

  it("holds everything when Settings are unconfigured — local-only mode", async () => {
    const h = harness({ cfg: { owner: "", repo: "", token: "" } });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.client.getFile).not.toHaveBeenCalled();
    expect(h.engine.pending()).toBe(1);
    expect(h.last().text).toBe("saved on this phone");
  });

  it("holds when offline, and pushes when the network returns", async () => {
    const h = harness({ online: false });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.client.putFile).not.toHaveBeenCalled();
    expect(h.last().text).toBe("saved on this phone · offline");

    h.state.online = true;
    await h.engine.flushNow("online");
    expect(h.client.putFile).toHaveBeenCalledTimes(1);
    expect(h.engine.pending()).toBe(0);
  });

  it("pushes one commit per trip file when the buffer spans trips", async () => {
    const h = harness();
    const other = visit(P1, "B", "sat");
    other.file = "river-road-test.json";
    h.engine.record(visit(P0, "A", "fri"));
    h.engine.record(other);
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.client.putFile).toHaveBeenCalledTimes(2);
    expect(h.state.log).toEqual([
      "GET " + PATH, "PUT " + PATH,
      "GET data/trips/river-road-test.json", "PUT data/trips/river-road-test.json"
    ]);
  });
});

/* ══ SETTLING + PERSISTENCE ════════════════════════════════════════════════ */
describe("what a successful push hands back", () => {
  it("reports the written doc and both shas so the overlay can settle", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri", "2027-06-04T15:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);

    const { entries, result } = h.state.settled[0];
    expect(entries).toHaveLength(1);
    expect(result.file).toBe(FILE);
    expect(result.sha).toBe("sha-new");
    expect(result.commit).toBe("c0ffee1234567890");
    expect(result.doc.places[0].visited).toBe("2027-06-04T15:00:00.000Z");
  });

  it("writes text, not a re-indented file, and keeps $$ intact", async () => {
    const h = harness();
    h.engine.record(edit(P0, "A", "fri", { cost: "$$" }, { cost: "" }));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);

    const written = h.state.lastPut.content;
    expect(written).toContain('"cost": "$$"');
    expect(written.startsWith('{\n "schema": 2,')).toBe(true);   // one-space indent kept
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written).places[0].cost).toBe("$$");
  });

  it("persists the buffer so an app kill cannot lose a change", async () => {
    const h = harness({ cfg: { owner: "", repo: "", token: "" } });
    h.engine.record(visit(P0, "A", "fri"));
    expect(h.state.stored).toHaveLength(1);
    expect("sending" in h.state.stored[0]).toBe(false);

    /* Next launch: a new engine restores it and flushes on its own. */
    const next = harness({ stored: h.state.stored });
    expect(next.engine.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(next.client.putFile).toHaveBeenCalledTimes(1);
    expect(next.state.stored).toHaveLength(0);
  });

  it("discardAll clears the buffer for ?reset", async () => {
    const h = harness();
    h.engine.record(visit(P0, "A", "fri"));
    h.engine.discardAll();
    expect(h.engine.pending()).toBe(0);
    expect(h.state.stored).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CAP_MS + QUIET_MS);
    expect(h.client.putFile).not.toHaveBeenCalled();
  });

  it("keeps a change made WHILE a push is in flight", async () => {
    let release;
    const client = {
      getFile: vi.fn(async () => ({ doc: JSON.parse(TRIP_TEXT), text: TRIP_TEXT, sha: "sha-old" })),
      putFile: vi.fn(() => new Promise((res) => { release = () => res({ sha: "s", commit: "c" }); }))
    };
    const h = harness({ client });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);       // PUT is now hanging

    h.engine.record(edit(P0, "A", "fri", { hours: "11–5" }, { hours: "" }));
    release();
    await vi.advanceTimersByTimeAsync(1);

    /* The in-flight entry settled; the newer edit survived it and is queued. */
    expect(h.engine.pending()).toBe(1);
    expect(h.engine.entries()[0].patch).toEqual({ hours: "11–5" });
  });
});

/* ══ CONFLICTS — through the real api.js ═══════════════════════════════════ */
describe("conflict retry, end to end over a mocked fetch (DESIGN §4)", () => {
  let calls;

  function reply(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body
    };
  }
  function getReply(text, sha) {
    return reply(200, { encoding: "base64", content: b64encode(text), sha, path: PATH });
  }
  function stub(replies) {
    const queue = replies.slice();
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ method: (init && init.method) || "GET", url: String(url), init: init || {} });
      return queue.shift();
    });
  }

  beforeEach(() => { calls = []; });

  it("re-GETs, re-applies and retries once — and the second PUT carries the FRESH sha", async () => {
    /* The other phone wrote between our read and our write, and their edit is
       in the doc we rebase onto. Both changes must survive. */
    const theirs = JSON.parse(TRIP_TEXT);
    theirs.places[1].notes = "their edit";
    const theirText = JSON.stringify(theirs, null, 1) + "\n";

    stub([
      getReply(TRIP_TEXT, "sha-stale"),
      reply(409, { message: "is at 111 but expected 222" }),
      getReply(theirText, "sha-fresh"),
      reply(200, { content: { sha: "sha-final" }, commit: { sha: "beefbeefbeef" } })
    ]);

    const h = harness({ real: true, cfg: { owner: "o", repo: "r", token: FAKE_TOKEN } });
    h.engine.record(visit(P0, "Art Institute", "fri", "2027-06-04T15:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);

    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    const second = JSON.parse(calls[3].init.body);
    expect(second.sha).toBe("sha-fresh");

    const doc = JSON.parse(b64decode(second.content));
    expect(doc.places[0].visited).toBe("2027-06-04T15:00:00.000Z");   // ours
    expect(doc.places[1].notes).toBe("their edit");                   // theirs
    expect(h.engine.pending()).toBe(0);
    expect(h.last().text).toBe("synced · beefbee");
  });

  it("a second conflict surfaces a toast and KEEPS the buffer", async () => {
    stub([
      getReply(TRIP_TEXT, "s1"), reply(409, { message: "conflict" }),
      getReply(TRIP_TEXT, "s2"), reply(409, { message: "conflict" })
    ]);

    const h = harness({ real: true, cfg: { owner: "o", repo: "r", token: FAKE_TOKEN } });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);

    expect(calls).toHaveLength(4);                       // one retry, not a loop
    expect(h.engine.pending()).toBe(1);                  // nothing lost
    expect(h.state.toasts.pop()).toMatch(/Someone else is editing/);
    expect(h.last().text).toBe("saved on this phone · not synced");
  });

  it("422 is treated as a conflict too", async () => {
    stub([
      getReply(TRIP_TEXT, "s1"), reply(422, { message: "sha does not match" }),
      getReply(TRIP_TEXT, "s2"),
      reply(200, { content: { sha: "s" }, commit: { sha: "abc1234" } })
    ]);
    const h = harness({ real: true, cfg: { owner: "o", repo: "r", token: FAKE_TOKEN } });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(h.engine.pending()).toBe(0);
  });

  it("KEYLESS write against a public repo: 401 surfaces and the buffer is kept", async () => {
    /* This is the real behaviour of the verification setup — reads work
       keyless, writes do not. The change stays on the phone. */
    stub([getReply(TRIP_TEXT, "s1"), reply(401, { message: "Requires authentication" })]);

    const h = harness({ real: true, cfg: { owner: "kshannon", repo: "wayfeather", token: "" } });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);

    expect(h.engine.pending()).toBe(1);
    expect(h.state.toasts.pop()).toMatch(/Add a GitHub token in Settings/);
    expect(h.last().text).toBe("saved on this phone · not synced");
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("does not spin after a failure — it waits for the next trigger", async () => {
    stub([getReply(TRIP_TEXT, "s1"), reply(403, { message: "no write access" })]);
    const h = harness({ real: true, cfg: { owner: "o", repo: "r", token: FAKE_TOKEN } });
    h.engine.record(visit(P0, "A", "fri"));
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(CAP_MS * 3);
    expect(calls).toHaveLength(2);                       // no retry storm
    expect(h.engine.pending()).toBe(1);
  });
});
