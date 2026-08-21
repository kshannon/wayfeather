/* state.test.js — do the storage writers tell the truth?

   One failure hid behind every one of these calls until v9. localStorage can
   throw (Safari Private Browsing, a full quota) and it can accept a write and
   forget it (some embedded webviews). state.js caught the exception — rightly,
   an edit must not die because a device cannot remember it — and then every
   caller reported success anyway. Settings said "Sync settings saved" over a
   device that had stored precisely nothing, and the person found out a launch
   later, when the app came up unconfigured and looked like it had lost their
   token.

   So: catching is not storing, and the only proof a write happened is reading
   it back. The three fakes below are the healthy device, the one that throws,
   and the one that quietly forgets.

   state.js reaches for `window.localStorage` at call time, so swapping the
   global per test is enough — no DOM, no jsdom. No real credential appears in
   this file; the token values are obvious placeholders. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  saveToken, hasToken, clearToken, signOutGitHub,
  saveSyncSettings, loadSyncSettings, storageProbe, wipeAll, store
} from "../app/js/state.js";

const FAKE_TOKEN = "not-a-real-token-0000";

/* A working localStorage, faithful enough for state.js: length/key() are used
   by wipeAll(), and getItem returns null (not undefined) for a missing key. */
function workingStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get length() { return map.size; },
    key(i) { const k = Array.from(map.keys())[i]; return k === undefined ? null : k; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map
  };
}

/* Private Browsing / over quota: the write throws. */
function throwingStorage(seed) {
  const s = workingStorage(seed);
  s.setItem = () => { throw new Error("QuotaExceededError"); };
  return s;
}

/* The nastier one, because nothing signals it: the write is accepted and
   dropped on the floor. Only a read-back catches this. */
function amnesiacStorage(seed) {
  const s = workingStorage(seed);
  s.setItem = () => { /* accepted, and forgotten */ };
  return s;
}

let saved;
function useStorage(s) { globalThis.window = { localStorage: s }; return s; }

beforeEach(() => {
  saved = globalThis.window;
  useStorage(workingStorage());
});
afterEach(() => {
  if (saved === undefined) delete globalThis.window;
  else globalThis.window = saved;
});

describe("saveToken — reports whether the token is actually on this device", () => {
  it("stores it and says so", () => {
    const ls = useStorage(workingStorage());
    expect(saveToken(FAKE_TOKEN)).toBe(true);
    expect(hasToken()).toBe(true);
    expect(ls._map.get("wayfeather:token")).toBe(FAKE_TOKEN);
  });

  it("trims, so a pasted token with a stray newline still matches", () => {
    const ls = useStorage(workingStorage());
    expect(saveToken("  " + FAKE_TOKEN + "\n")).toBe(true);
    expect(ls._map.get("wayfeather:token")).toBe(FAKE_TOKEN);
  });

  it("returns false when the write THROWS — and does not throw itself", () => {
    useStorage(throwingStorage());
    expect(() => saveToken(FAKE_TOKEN)).not.toThrow();
    expect(saveToken(FAKE_TOKEN)).toBe(false);
    expect(hasToken()).toBe(false);
  });

  it("returns false when the write is silently DROPPED", () => {
    /* The read-back is the whole point: nothing threw, and nothing was stored.
       Before v9 this returned true and Settings said "saved". */
    useStorage(amnesiacStorage());
    expect(saveToken(FAKE_TOKEN)).toBe(false);
    expect(hasToken()).toBe(false);
  });

  it("reports false for an empty token — there is nothing stored afterwards", () => {
    const ls = useStorage(workingStorage({ "wayfeather:token": FAKE_TOKEN }));
    expect(saveToken("")).toBe(false);
    expect(saveToken("   ")).toBe(false);
    expect(ls._map.has("wayfeather:token")).toBe(false);   // and it cleared the old one
    expect(hasToken()).toBe(false);
  });

  it("survives a device with no storage object at all", () => {
    globalThis.window = {};
    expect(() => saveToken(FAKE_TOKEN)).not.toThrow();
    expect(saveToken(FAKE_TOKEN)).toBe(false);
    expect(hasToken()).toBe(false);
  });
});

describe("saveSyncSettings — same honesty, same shape as before", () => {
  it("still returns the saved pair, so existing readers are unaffected", () => {
    useStorage(workingStorage());
    const res = saveSyncSettings("kshannon", "wayfeather-data");
    expect(res.owner).toBe("kshannon");
    expect(res.repo).toBe("wayfeather-data");
    expect(res.ok).toBe(true);
  });

  it("round-trips through storage, which is what a next launch depends on", () => {
    useStorage(workingStorage());
    saveSyncSettings("  kshannon ", " wayfeather-data ");
    store.sync = { owner: "", repo: "" };            // forget it in memory
    expect(loadSyncSettings()).toEqual({ owner: "kshannon", repo: "wayfeather-data" });
  });

  it("reports ok:false when the device refuses the write", () => {
    useStorage(throwingStorage());
    expect(saveSyncSettings("kshannon", "wayfeather-data").ok).toBe(false);
    useStorage(amnesiacStorage());
    expect(saveSyncSettings("kshannon", "wayfeather-data").ok).toBe(false);
  });

  it("still applies the settings IN MEMORY when the write failed", () => {
    /* The session keeps working — it just will not survive a relaunch, which
       is exactly what the settings view now says out loud. */
    useStorage(throwingStorage());
    saveSyncSettings("kshannon", "wayfeather-data");
    expect(store.sync).toEqual({ owner: "kshannon", repo: "wayfeather-data" });
  });

  it("counts clearing as a success when the key really is gone", () => {
    const ls = useStorage(workingStorage({ "wayfeather:sync": '{"owner":"a","repo":"b"}' }));
    expect(saveSyncSettings("", "").ok).toBe(true);
    expect(ls._map.has("wayfeather:sync")).toBe(false);
  });

  it("reports ok:false when even the removal fails", () => {
    const ls = useStorage(workingStorage({ "wayfeather:sync": '{"owner":"a","repo":"b"}' }));
    ls.removeItem = () => { throw new Error("nope"); };
    expect(saveSyncSettings("", "").ok).toBe(false);
  });
});

describe("storageProbe — the Settings diagnostics row", () => {
  it("is true on a device that can keep things", () => {
    expect(storageProbe()).toBe(true);
  });

  it("is false when writes throw, and false when they are dropped", () => {
    useStorage(throwingStorage());
    expect(storageProbe()).toBe(false);
    useStorage(amnesiacStorage());
    expect(storageProbe()).toBe(false);
  });

  it("leaves nothing behind — it is a probe, not a key", () => {
    const ls = useStorage(workingStorage());
    storageProbe();
    expect(ls._map.has("wayfeather:probe")).toBe(false);
    expect(ls.length).toBe(0);
  });

  it("never throws, whatever the device does", () => {
    globalThis.window = {};
    expect(() => storageProbe()).not.toThrow();
    expect(storageProbe()).toBe(false);
  });
});

describe("wipe and sign-out semantics are UNCHANGED by the v9 fix", () => {
  it("wipeAll clears the overlay but keeps the GitHub settings and the token", () => {
    /* Losing the PAT because you cleared a stray overlay would mean re-typing
       a 40-character secret on a phone; signing out has its own row. */
    const ls = useStorage(workingStorage({
      "wayfeather:app": '{"activeTrip":"chicago-test"}',
      "wayfeather:app:chicago-test": '{"placePatches":{},"addedStopovers":[]}',
      "wayfeather:pending": "[]",
      "wayfeather:sync": '{"owner":"kshannon","repo":"wayfeather-data"}',
      "wayfeather:token": FAKE_TOKEN,
      "unrelated:key": "kept"
    }));
    wipeAll();
    expect(ls._map.has("wayfeather:app")).toBe(false);
    expect(ls._map.has("wayfeather:app:chicago-test")).toBe(false);
    expect(ls._map.has("wayfeather:pending")).toBe(false);
    expect(ls._map.get("wayfeather:sync")).toBe('{"owner":"kshannon","repo":"wayfeather-data"}');
    expect(ls._map.get("wayfeather:token")).toBe(FAKE_TOKEN);
    expect(ls._map.get("unrelated:key")).toBe("kept");
  });

  it("signing out clears both, and clearToken clears only the token", () => {
    const ls = useStorage(workingStorage({
      "wayfeather:sync": '{"owner":"kshannon","repo":"wayfeather-data"}',
      "wayfeather:token": FAKE_TOKEN
    }));
    clearToken();
    expect(ls._map.has("wayfeather:token")).toBe(false);
    expect(ls._map.has("wayfeather:sync")).toBe(true);

    signOutGitHub();
    expect(ls._map.has("wayfeather:sync")).toBe(false);
    expect(store.sync).toEqual({ owner: "", repo: "" });
  });
});
