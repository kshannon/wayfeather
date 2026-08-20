/* api.test.js — the Contents API client (DESIGN §2, §4).

   Everything here runs with no network: the two request functions are exercised
   against a stubbed global fetch, and the rest of the module is pure by design.

   NO TOKEN APPEARS IN THIS FILE that is not obvious nonsense typed here. The
   real PAT is entered by a human in Settings at runtime and never leaves the
   phone; these strings exist only to prove that a token, when present, is put
   in an Authorization header and nowhere else. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  b64encode, b64decode, detectIndent, serializeLike, commitMessage, rebase,
  contentsUrl, shortSha, getFile, putFile, ApiError, CODES, DATA_PATH, API_ROOT
} from "../app/js/api.js";

const FAKE_TOKEN = "not-a-real-token-0000";

const CHICAGO_TEXT = readFileSync(
  new URL("../data/trips/chicago-test.json", import.meta.url), "utf8");
const CHICAGO = JSON.parse(CHICAGO_TEXT);

/* ── fetch stubbing ───────────────────────────────────────────────────────── */
let calls = [];

function reply(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers || {})[String(k).toLowerCase()] ?? null },
    json: async () => body
  };
}

function contentsBody(text, sha) {
  return { encoding: "base64", content: b64encode(text), sha, path: "data/trips/x.json" };
}

/* Queue of replies, consumed in order; the calls are recorded for assertions. */
function stubFetch(replies) {
  const queue = replies.slice();
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const next = queue.shift();
    if (typeof next === "function") return next();
    if (next === undefined) throw new Error("no reply queued");
    return next;
  });
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.restoreAllMocks(); delete globalThis.fetch; });

/* ══ BASE64 ════════════════════════════════════════════════════════════════ */
describe("b64 — unicode-safe round trips", () => {
  it("round-trips plain ASCII", () => {
    for (const s of ["", "a", "ab", "abc", "abcd", "hello world"]) {
      expect(b64decode(b64encode(s))).toBe(s);
    }
  });

  it("pads correctly at every length modulo 3", () => {
    expect(b64encode("a")).toBe("YQ==");
    expect(b64encode("ab")).toBe("YWI=");
    expect(b64encode("abc")).toBe("YWJj");
    expect(b64decode("YQ==")).toBe("a");
    expect(b64decode("YWI=")).toBe("ab");
    expect(b64decode("YWJj")).toBe("abc");
  });

  it("round-trips multi-byte unicode — the reason btoa is not used", () => {
    for (const s of ["Café Déjà Vu", "北京烤鸭", "Mon–Sat 10–6", "émigré",
                     "🐦 feather", "naïve résumé", " thin space"]) {
      expect(b64decode(b64encode(s))).toBe(s);
    }
  });

  it("round-trips the $$ gotcha byte for byte", () => {
    /* CLAUDE.md: a "cost": "$$" is what silently corrupts if anything on the
       write path runs it through String.replace. It must survive the wire. */
    for (const s of ['{"cost":"$$"}', "$$", "$$$$", "$&", "$`", "$'", "a$$b$&c"]) {
      expect(b64decode(b64encode(s))).toBe(s);
    }
  });

  it("survives a whole trip fixture unchanged", () => {
    const round = b64decode(b64encode(CHICAGO_TEXT));
    expect(round).toBe(CHICAGO_TEXT);
    expect(JSON.parse(round)).toEqual(CHICAGO);
  });

  it("decodes what GitHub actually sends — base64 wrapped at 60 columns", () => {
    const flat = b64encode(CHICAGO_TEXT);
    const wrapped = flat.replace(/(.{60})/g, "$1\n") + "\n";
    expect(wrapped).not.toBe(flat);
    expect(b64decode(wrapped)).toBe(CHICAGO_TEXT);
  });

  it("ignores stray whitespace and anything after the padding", () => {
    expect(b64decode(" Y W J j ")).toBe("abc");
    expect(b64decode("YWJj\r\n")).toBe("abc");
    expect(b64decode("YQ==junk")).toBe("a");
  });

  it("treats null and undefined as empty rather than throwing", () => {
    expect(b64encode(null)).toBe("");
    expect(b64encode(undefined)).toBe("");
    expect(b64decode(null)).toBe("");
    expect(b64decode(undefined)).toBe("");
  });
});

/* ══ SERIALIZE ═════════════════════════════════════════════════════════════ */
describe("serializeLike — a write keeps the file's own shape", () => {
  it("detects the indent the fixtures actually use (one space)", () => {
    expect(detectIndent(CHICAGO_TEXT)).toBe(1);
    expect(detectIndent('{\n  "a": 1\n}')).toBe(2);
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectIndent('{"a":1}')).toBe(2);          // minified → house default
    expect(detectIndent("")).toBe(2);
  });

  it("re-serializes an untouched fixture to the same value and the same shape", () => {
    /* If the SHAPE drifts, every one-field edit becomes a whole-file diff. */
    const out = serializeLike(CHICAGO_TEXT, CHICAGO);
    expect(JSON.parse(out)).toEqual(CHICAGO);
    expect(out.split("\n").length).toBe(CHICAGO_TEXT.split("\n").length);
    expect(out.slice(0, 40)).toBe(CHICAGO_TEXT.slice(0, 40));
    expect(out.endsWith("\n")).toBe(true);
  });

  it("documents the one thing parse/serialize does NOT preserve: number literals", () => {
    /* A hand-written trailing zero is normalised — same value, one line of
       diff, once. The alternative is splicing strings, which eats "$$". */
    expect(serializeLike('{\n "lng": -87.626950\n}\n', { lng: -87.626950 }))
      .toBe('{\n "lng": -87.62695\n}\n');
    expect(CHICAGO_TEXT).toContain("-87.626950");        // the fixture really has one
    const diff = CHICAGO_TEXT.split("\n").filter((line, i) =>
      line !== serializeLike(CHICAGO_TEXT, CHICAGO).split("\n")[i]);
    expect(diff.every((l) => /^\s*"(lat|lng)":/.test(l))).toBe(true);
  });

  it("keeps the trailing newline exactly as it found it", () => {
    expect(serializeLike('{\n "a": 1\n}\n', { a: 1 })).toBe('{\n "a": 1\n}\n');
    expect(serializeLike('{\n "a": 1\n}', { a: 1 })).toBe('{\n "a": 1\n}');
  });

  it("carries $$ through a mutate-and-write cycle", () => {
    const doc = JSON.parse(CHICAGO_TEXT);
    doc.places[0].cost = "$$";
    doc.places[0].notes = "Cheap — about $$ for two, 50% off before 5";
    const out = serializeLike(CHICAGO_TEXT, doc);
    const back = JSON.parse(out);
    expect(back.places[0].cost).toBe("$$");
    expect(back.places[0].notes).toBe("Cheap — about $$ for two, 50% off before 5");
    expect(out).toContain('"cost": "$$"');
  });

  it("REGRESSION: the naive string splice is what eats $$, and we do not do it", () => {
    /* Documented so nobody "optimises" the write path back into a replace().
       String.replace treats $$ in the REPLACEMENT as an escape for one $. */
    const naive = '{"cost":"OLD"}'.replace("OLD", "$$");
    expect(naive).toBe('{"cost":"$"}');               // corrupted — one dollar
    expect(JSON.parse(serializeLike("{}", { cost: "$$" })).cost).toBe("$$");
  });
});

/* ══ COMMIT MESSAGES ═══════════════════════════════════════════════════════ */
describe("commitMessage — CLAUDE.md style, coalesced per DESIGN §4", () => {
  it("writes the single-change forms from the design doc", () => {
    expect(commitMessage([{ kind: "add", name: "Los Tacos No.1", day: "thu" }]))
      .toBe("add: Los Tacos No.1 (thu)");
    expect(commitMessage([{ kind: "visit", name: "Economy Candy", day: "thu" }]))
      .toBe("visit: Economy Candy (thu)");
    expect(commitMessage([{ kind: "skip", name: "The Frick", day: "fri" }]))
      .toBe("skip: The Frick (fri)");
    expect(commitMessage([{ kind: "move", name: "Big Star", day: "sat" }]))
      .toBe("move: Big Star (sat)");
  });

  it("names the field on a single edit", () => {
    expect(commitMessage([{ kind: "edit", name: "Frick", day: "fri", patch: { hours: "11–5" } }]))
      .toBe("edit: hours — Frick");
    expect(commitMessage([{ kind: "edit", name: "Frick", patch: { hours: "11–5", cost: "$22" } }]))
      .toBe("edit: hours, cost — Frick");
  });

  it("ignores bookkeeping fields when naming an edit", () => {
    expect(commitMessage([{
      kind: "edit", name: "Frick", day: "fri",
      patch: { hours: "11–5", updatedAt: "2026-08-20" }
    }])).toBe("edit: hours — Frick");
  });

  it("falls back to the place name when an edit rewrites three or more fields", () => {
    expect(commitMessage([{
      kind: "edit", name: "Frick", day: "fri",
      patch: { hours: "11–5", cost: "$22", notes: "x", time: "2 PM" }
    }])).toBe("edit: Frick (fri)");
  });

  it("coalesces a flurry into one subject line", () => {
    const three = [
      { kind: "visit", placeId: "economy-candy", name: "Economy Candy", day: "thu" },
      { kind: "visit", placeId: "katz", name: "Katz's", day: "thu" },
      { kind: "visit", placeId: "frick", name: "The Frick", day: "thu" }
    ];
    expect(commitMessage(three)).toBe("visit: Economy Candy + 2 more (thu)");
  });

  it("drops the day when the changes span days, and generalises mixed verbs", () => {
    expect(commitMessage([
      { kind: "visit", placeId: "a", name: "A", day: "thu" },
      { kind: "visit", placeId: "b", name: "B", day: "fri" }
    ])).toBe("visit: A + 1 more");
    expect(commitMessage([
      { kind: "visit", placeId: "a", name: "A", day: "thu" },
      { kind: "add", placeId: "b", name: "B", day: "thu" }
    ])).toBe("edit: A + 1 more (thu)");
  });

  it("counts distinct places, never repeated entries for one place", () => {
    expect(commitMessage([
      { kind: "visit", placeId: "a", name: "A", day: "thu" },
      { kind: "visit", placeId: "a", name: "A", day: "thu" }
    ])).toBe("visit: A (thu)");
  });

  it("always produces a usable subject, even with nothing to say", () => {
    expect(commitMessage([])).toBe("edit: trip data");
    expect(commitMessage(null)).toBe("edit: trip data");
    expect(commitMessage([{ kind: "edit" }])).toBe("edit: stopover");
  });
});

/* ══ REBASE ════════════════════════════════════════════════════════════════ */
describe("rebase — the conflict retry's one moving part", () => {
  it("applies onto a COPY, leaving the fetched doc pristine", () => {
    const fresh = { schema: 1, places: [{ id: "a", name: "A" }] };
    const out = rebase((d) => { d.places[0].name = "B"; }, fresh);
    expect(out.places[0].name).toBe("B");
    expect(fresh.places[0].name).toBe("A");
  });

  it("takes the applier's return value when it makes a new doc", () => {
    const out = rebase((d) => Object.assign({}, d, { extra: 1 }), { a: 1 });
    expect(out).toEqual({ a: 1, extra: 1 });
  });

  it("refuses to rebase onto nothing", () => {
    expect(() => rebase((d) => d, null)).toThrow(ApiError);
    expect(() => rebase((d) => d, "not a doc")).toThrow(/Nothing to rebase/);
  });

  it("re-applies cleanly onto a doc someone else has already changed", () => {
    /* The 409 case: their edit to one place, ours to another, both survive. */
    const theirs = JSON.parse(CHICAGO_TEXT);
    theirs.places[1].notes = "their edit";
    const out = rebase((d) => { d.places[0].visited = "2027-06-04T15:00:00Z"; }, theirs);
    expect(out.places[0].visited).toBe("2027-06-04T15:00:00Z");
    expect(out.places[1].notes).toBe("their edit");
  });
});

/* ══ URLS ══════════════════════════════════════════════════════════════════ */
describe("contentsUrl + shortSha", () => {
  it("builds the documented path and keeps the slashes", () => {
    expect(contentsUrl("kshannon", "wayfeather", "data/trips/index.json"))
      .toBe(API_ROOT + "/repos/kshannon/wayfeather/contents/data/trips/index.json");
  });

  it("encodes each segment so a stray character cannot escape the path", () => {
    expect(contentsUrl("own er", "re/po", "data/trips/a b.json"))
      .toBe(API_ROOT + "/repos/own%20er/re%2Fpo/contents/data/trips/a%20b.json");
  });

  it("drops dot segments instead of letting a filename climb out of data/trips", () => {
    expect(contentsUrl("o", "r", "data/trips/../../secret"))
      .toBe(API_ROOT + "/repos/o/r/contents/data/trips/secret");
    expect(contentsUrl("o", "r", "data/./trips//index.json"))
      .toBe(API_ROOT + "/repos/o/r/contents/data/trips/index.json");
  });

  it("shortens a sha to the seven characters the stamp prints", () => {
    expect(shortSha("a1b2c3d4e5f6a7b8c9d0")).toBe("a1b2c3d");
    expect(shortSha("")).toBe("");
    expect(shortSha(null)).toBe("");
  });
});

/* ══ GET ═══════════════════════════════════════════════════════════════════ */
describe("getFile", () => {
  it("reads a public repo KEYLESS — no Authorization header at all", async () => {
    stubFetch([reply(200, contentsBody(CHICAGO_TEXT, "abc1234def"))]);
    const res = await getFile({ owner: "kshannon", repo: "wayfeather", path: DATA_PATH + "chicago-test.json" });

    expect(res.doc).toEqual(CHICAGO);
    expect(res.text).toBe(CHICAGO_TEXT);
    expect(res.sha).toBe("abc1234def");

    const { url, init } = calls[0];
    expect(url).toBe(API_ROOT + "/repos/kshannon/wayfeather/contents/data/trips/chicago-test.json");
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect("Authorization" in init.headers).toBe(false);
    expect(init.cache).toBe("no-store");        // DESIGN §4: refresh must not lie
  });

  it("sends the token as a Bearer header and never in the URL", async () => {
    stubFetch([reply(200, contentsBody("{}", "s"))]);
    await getFile({ owner: "o", repo: "r", path: "data/trips/index.json", token: FAKE_TOKEN });
    expect(calls[0].init.headers.Authorization).toBe("Bearer " + FAKE_TOKEN);
    expect(calls[0].url).not.toContain(FAKE_TOKEN);
    expect(calls[0].url).not.toContain("token");
  });

  it("classifies every status the write path branches on", async () => {
    const cases = [
      [401, CODES.UNAUTHORIZED], [403, CODES.FORBIDDEN], [404, CODES.NOT_FOUND],
      [409, CODES.CONFLICT], [422, CODES.CONFLICT], [500, CODES.SERVER],
      [418, CODES.HTTP]
    ];
    for (const [status, code] of cases) {
      stubFetch([reply(status, { message: "nope" })]);
      await expect(getFile({ owner: "o", repo: "r", path: "p" }))
        .rejects.toMatchObject({ code, status, name: "ApiError" });
    }
  });

  it("tells a spent rate limit apart from a permission problem", async () => {
    stubFetch([reply(403, { message: "rate limit" }, { "x-ratelimit-remaining": "0" })]);
    await expect(getFile({ owner: "o", repo: "r", path: "p" }))
      .rejects.toMatchObject({ code: CODES.RATE_LIMITED });

    stubFetch([reply(429, { message: "slow down" })]);
    await expect(getFile({ owner: "o", repo: "r", path: "p" }))
      .rejects.toMatchObject({ code: CODES.RATE_LIMITED });
  });

  it("calls a transport failure offline, not an HTTP error", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("Load failed"); });
    await expect(getFile({ owner: "o", repo: "r", path: "p" }))
      .rejects.toMatchObject({ code: CODES.OFFLINE });
  });

  it("refuses a file the API declined to inline", async () => {
    stubFetch([reply(200, { encoding: "none", content: "", sha: "s" })]);
    await expect(getFile({ owner: "o", repo: "r", path: "p" }))
      .rejects.toMatchObject({ code: CODES.TOO_LARGE });
  });

  it("reports unparseable content as bad JSON rather than crashing", async () => {
    stubFetch([reply(200, contentsBody("{not json", "s"))]);
    await expect(getFile({ owner: "o", repo: "r", path: "p" }))
      .rejects.toMatchObject({ code: CODES.BAD_JSON });
  });
});

/* ══ PUT ═══════════════════════════════════════════════════════════════════ */
describe("putFile", () => {
  it("sends message, base64 content and the sha, and returns both shas", async () => {
    stubFetch([reply(200, {
      content: { sha: "newblobsha", path: "data/trips/x.json" },
      commit: { sha: "c0ffee1234567890" }
    })]);

    const res = await putFile({
      owner: "o", repo: "r", path: "data/trips/x.json", token: FAKE_TOKEN,
      content: '{"cost":"$$"}', sha: "oldblobsha", message: "visit: X (thu)"
    });

    const body = JSON.parse(calls[0].init.body);
    expect(calls[0].init.method).toBe("PUT");
    expect(body.message).toBe("visit: X (thu)");
    expect(body.sha).toBe("oldblobsha");
    expect(b64decode(body.content)).toBe('{"cost":"$$"}');
    expect(res).toEqual({ sha: "newblobsha", commit: "c0ffee1234567890", path: "data/trips/x.json" });
  });

  it("omits the sha when creating a file that does not exist yet", async () => {
    stubFetch([reply(201, { content: { sha: "s" }, commit: { sha: "c" } })]);
    await putFile({ owner: "o", repo: "r", path: "p", content: "{}", message: "add: x" });
    expect("sha" in JSON.parse(calls[0].init.body)).toBe(false);
  });

  it("asks for keepalive only when the body is small enough for it", async () => {
    stubFetch([reply(200, { content: { sha: "s" }, commit: { sha: "c" } })]);
    await putFile({ owner: "o", repo: "r", path: "p", content: "{}", message: "m", keepalive: true });
    expect(calls[0].init.keepalive).toBe(true);

    stubFetch([reply(200, { content: { sha: "s" }, commit: { sha: "c" } })]);
    await putFile({
      owner: "o", repo: "r", path: "p", message: "m", keepalive: true,
      content: JSON.stringify({ big: "x".repeat(70000) })
    });
    /* stubFetch queues a new reply but `calls` accumulates across the test:
       the big write is the SECOND call. Over 64KB the browser rejects a
       keepalive request outright, so it must not be asked for. */
    expect(calls.length).toBe(2);
    expect(calls[1].init.keepalive).toBeUndefined();
  });

  it("classifies a stale sha as a conflict — the retry's trigger", async () => {
    stubFetch([reply(409, { message: "is at 111 but expected 222" })]);
    await expect(putFile({ owner: "o", repo: "r", path: "p", content: "{}", sha: "222", message: "m" }))
      .rejects.toMatchObject({ code: CODES.CONFLICT, status: 409 });
  });

  it("keeps the token out of the URL on writes too", async () => {
    stubFetch([reply(200, { content: { sha: "s" }, commit: { sha: "c" } })]);
    await putFile({ owner: "o", repo: "r", path: "p", token: FAKE_TOKEN, content: "{}", message: "m" });
    expect(calls[0].url).not.toContain(FAKE_TOKEN);
    expect(calls[0].init.body).not.toContain(FAKE_TOKEN);
    expect(calls[0].init.headers.Authorization).toBe("Bearer " + FAKE_TOKEN);
  });
});
