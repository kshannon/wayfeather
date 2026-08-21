/* shell.test.js — the mixed-shell bug, pinned so it cannot come back.

   WHAT HAPPENED (v7 → v8, on a real phone). The worker answered shell requests
   from its cache and then quietly re-fetched each asset and wrote the fresh
   bytes back into the CURRENT cache, one file at a time, with no check that
   those bytes still belonged to this version. During a deploy — worker on v7,
   server already serving v8 — a launch on a slow connection revalidated SOME of
   the shell before the app was backgrounded. The v7 cache came out holding a
   mixture of two builds. An ES module graph that disagrees with itself does not
   degrade: main.js never evaluated, nothing was wired, nothing loaded the
   stored sync settings, and the static Settings markup underneath showed empty
   owner, repo and token fields. It was reported as "the app broke and lost my
   token". The token had never moved.

   The FIX is structural, which is why it can be tested as text: the fetch
   handler writes to no cache at all, so no cache can ever hold two versions.
   Staying current moved to the browser's own atomic swap (new sw.js → install
   into a NEW cache name → activate all-or-nothing), nudged once per launch by
   shell.js. The first describe() below is the regression guard for that; the
   rest covers the page-side logic that reports a half-swapped shell honestly
   instead of running mixed. */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mixedVersionHint, diagRows } from "../app/js/shell.js";

const SW_TEXT = readFileSync(new URL("../app/sw.js", import.meta.url), "utf8");

/* sw.js discusses cache.put() at length — that note is doing real work and
   must not be what keeps this suite green (or what fails it). Assertions run
   against code with the prose removed. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const SW = stripComments(SW_TEXT);

describe("service worker — no cross-version cache writes (the v9 field fix)", () => {
  it("never put()s anything into a cache, anywhere", () => {
    /* THE GUARD. install() fills a brand-new cache with cache.add(); every
       other write is a cross-version write waiting to happen, because the unit
       of correctness is the whole shell and put() works one file at a time.
       If this fails, read the note above shellFirst() in sw.js before
       "fixing" the test. */
    expect(SW).not.toMatch(/\.put\s*\(/);
  });

  it("does not open or fill a cache from the fetch handler", () => {
    const fetchOnwards = SW.slice(SW.indexOf('addEventListener("fetch"'));
    expect(fetchOnwards).not.toContain("caches.open");
    expect(fetchOnwards).not.toContain(".put(");
    expect(fetchOnwards).not.toContain(".add(");
    // the revalidating fetch carried this option; its absence is the tell
    expect(fetchOnwards).not.toContain("no-cache");
  });

  it("opens the cache exactly once — in install, the only writer", () => {
    expect((SW.match(/caches\.open\(/g) || []).length).toBe(1);
    const install = SW.slice(SW.indexOf('addEventListener("install"'),
                             SW.indexOf('addEventListener("activate"'));
    expect(install).toContain("caches.open(CACHE)");
    expect(install).toContain("cache.add(");
  });

  it("still serves the shell cache-first, and still reaches the network on a miss", () => {
    expect(SW).toContain("caches.match(cacheKey, opts)");
    expect(SW).toContain("if (cached) return cached;");
    expect(SW).toContain("return await fetch(req)");
  });

  it("deletes every cache that is not this exact version on activate", () => {
    /* The self-heal: a phone carrying a poisoned v7 cache loses it whole the
       moment v9 activates. Nothing is migrated and nothing is repaired. */
    const activate = SW.slice(SW.indexOf('addEventListener("activate"'));
    expect(activate).toContain("k.indexOf(PREFIX) === 0 && k !== CACHE");
    expect(activate).toContain("caches.delete(k)");
  });

  it("answers a version request, so a page can tell it is running mixed", () => {
    expect(SW).toContain('addEventListener("message"');
    expect(SW).toContain('data.type !== "version?"');
    expect(SW).toContain("version: VERSION");
  });
});

describe("mixedVersionHint — page build vs the worker answering it", () => {
  it("says nothing when they agree", () => {
    expect(mixedVersionHint("v9", "v9")).toBeNull();
  });

  it("asks for a cold start when they disagree", () => {
    const hint = mixedVersionHint("v9", "v8");
    expect(hint).toBeTruthy();
    expect(hint).toMatch(/close/i);
    expect(hint).toMatch(/reopen/i);
  });

  it("counts a NEWER worker as a mismatch too — this page is still the old one", () => {
    expect(mixedVersionHint("v9", "v10")).toBeTruthy();
  });

  it("treats an unknown version as unknown, never as a mismatch", () => {
    /* No controller, no answer, or a worker too old to have a message handler.
       A hint that fired on silence would cry wolf on every first launch. */
    expect(mixedVersionHint("v9", null)).toBeNull();
    expect(mixedVersionHint("v9", "")).toBeNull();
    expect(mixedVersionHint("v9", undefined)).toBeNull();
    expect(mixedVersionHint(null, "v9")).toBeNull();
    expect(mixedVersionHint("", "")).toBeNull();
  });

  it("compares as text, so a version is never coerced into agreeing", () => {
    expect(mixedVersionHint("v9", "v09")).toBeTruthy();
  });
});

describe("diagRows — the field report", () => {
  const healthy = {
    build: "v9", display: "standalone", swSupported: true, controlled: true,
    workerVersion: "v9", storage: true, idb: true, source: "kshannon/wayfeather"
  };
  const valueOf = (rows, label) => (rows.find((r) => r[0] === label) || [])[1];

  it("is label/value pairs, in a fixed order", () => {
    const rows = diagRows(healthy);
    expect(rows.map((r) => r[0])).toEqual([
      "Build", "Display mode", "Service worker", "Storage", "Offline store", "Data source"
    ]);
    rows.forEach((r) => {
      expect(r).toHaveLength(2);
      expect(typeof r[1]).toBe("string");
      expect(r[1]).not.toBe("");
    });
  });

  it("reads clean on a healthy installed app", () => {
    const rows = diagRows(healthy);
    expect(valueOf(rows, "Build")).toBe("v9");
    expect(valueOf(rows, "Display mode")).toBe("standalone (installed)");
    expect(valueOf(rows, "Service worker")).toBe("v9 · active");
    expect(valueOf(rows, "Storage")).toBe("ok");
    expect(valueOf(rows, "Offline store")).toBe("ok");
    expect(valueOf(rows, "Data source")).toBe("kshannon/wayfeather");
  });

  it("names the mismatch that used to be invisible", () => {
    const rows = diagRows({ ...healthy, workerVersion: "v8" });
    expect(valueOf(rows, "Service worker")).toContain("v8");
    expect(valueOf(rows, "Service worker")).toMatch(/does not match/i);
  });

  it("separates 'no controller' from 'controller will not answer'", () => {
    expect(valueOf(diagRows({ ...healthy, controlled: false, workerVersion: null }),
      "Service worker")).toMatch(/not controlling/i);
    expect(valueOf(diagRows({ ...healthy, workerVersion: null }),
      "Service worker")).toMatch(/unreachable/i);
    expect(valueOf(diagRows({ ...healthy, swSupported: false, controlled: false }),
      "Service worker")).toMatch(/unsupported/i);
  });

  it("says failing when the device cannot store anything", () => {
    /* The row that answers "why do my settings keep disappearing?" without
       anybody having to guess at Safari's privacy settings. */
    expect(valueOf(diagRows({ ...healthy, storage: false }), "Storage")).toBe("failing");
    expect(valueOf(diagRows({ ...healthy, idb: false }), "Offline store")).toBe("unavailable");
  });

  it("falls back to 'this site' when no repo is configured", () => {
    expect(valueOf(diagRows({ ...healthy, source: "" }), "Data source")).toBe("this site");
    expect(valueOf(diagRows({}), "Data source")).toBe("this site");
  });

  it("survives being handed nothing", () => {
    expect(diagRows()).toHaveLength(6);
    expect(diagRows(null)).toHaveLength(6);
    expect(valueOf(diagRows(), "Build")).toBe("unknown");
  });

  it("NEVER prints a secret, whatever it is handed", () => {
    /* Diagnostics are made to be screenshotted and sent to someone. The token
       has no route into these facts (settings.js supplies only owner/repo), and
       this pins that even if a future fact object carries more than it should. */
    const rows = diagRows({ ...healthy, token: "ghp_notarealtoken0000", secret: "hunter2" });
    rows.forEach((r) => {
      expect(r[1]).not.toContain("ghp_notarealtoken0000");
      expect(r[1]).not.toContain("hunter2");
    });
  });
});
