/* build.test.js — the two ways a deploy silently fails to reach a phone.

   1. The shell VERSION was not bumped, so every installed copy keeps serving
      the old app forever (LLMS.md "App stuck on a phone").
   2. A new module was added and never precached, so the app half-works offline
      — the worst kind of bug to find on a street corner.

   Neither is a runtime error anywhere, which is exactly why they get a test. */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { BUILD } from "../app/js/version.js";

const SW = readFileSync(new URL("../app/sw.js", import.meta.url), "utf8");
const JS_DIR = new URL("../app/js/", import.meta.url);

function modules(dir, prefix) {
  const out = [];
  readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.isDirectory()) out.push(...modules(new URL(e.name + "/", dir), prefix + e.name + "/"));
    else if (e.name.endsWith(".js")) out.push(prefix + e.name);
  });
  return out;
}

describe("shell build identifier", () => {
  it("matches VERSION in sw.js — Settings prints this as the App version", () => {
    const m = /const VERSION = "([^"]+)"/.exec(SW);
    expect(m).toBeTruthy();
    expect(BUILD).toBe(m[1]);
  });

  it("looks like a version string", () => {
    expect(BUILD).toMatch(/^v\d+$/);
  });
});

describe("service worker precache", () => {
  it("lists every app/js module, so nothing is missing offline", () => {
    const missing = modules(JS_DIR, "").filter((rel) => SW.indexOf('"./js/' + rel + '"') < 0);
    expect(missing).toEqual([]);
  });

  it("still precaches the stylesheets and the manifest", () => {
    ["./css/tokens.css", "./css/app.css", "./manifest.webmanifest", "./index.html"]
      .forEach((f) => expect(SW).toContain('"' + f + '"'));
  });

  it("never precaches trip data — that is IndexedDB's job, with its sha", () => {
    expect(SW).not.toMatch(/"\.\.?\/data\//);
    expect(SW).toContain('url.pathname.indexOf("/data/")');
  });

  it("passes cross-origin requests through, so api.github.com is never cached", () => {
    expect(SW).toContain("url.origin !== self.location.origin");
  });
});
