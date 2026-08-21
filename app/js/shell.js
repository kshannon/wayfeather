/* shell.js — the running shell: which build this device is executing, whether
   the worker answering its requests agrees, and whether the device can store
   anything at all.

   This module exists because of one field failure (see the long note above
   shellFirst() in sw.js). The old worker kept itself current by re-fetching
   shell assets and writing them back into the LIVE cache, one file at a time,
   which during a deploy produced a cache holding two builds at once — an app
   that then failed to start on every launch. Staying current is a real need,
   so it moved here, to the one mechanism that is atomic by construction:

     registration.update()  →  browser fetches sw.js  →  byte-different?
       →  install into a NEW cache name  →  activate  →  whole version swaps

   Nothing in between is ever served. The worst case is a launch that still runs
   the old shell; there is no case that runs half of each.

   Everything below is deliberately quiet: no reloads, no forced refreshes, no
   waiting on the network before the app can paint. The page reports what it
   finds (mixedVersionHint, diagRows) and the person decides. */

import { BUILD } from "./version.js";
import { storageProbe } from "./state.js";
import { idbProbe } from "./data.js";

/* ── registration, and the once-per-launch nudge ──────────────────────────── */
let started = false;

/* Registers the worker and asks the browser to re-check sw.js exactly once per
   launch. Throttled by the module-level flag rather than by a timestamp: a
   "launch" is one page lifetime, which on an installed iOS PWA is precisely the
   unit the person controls by closing and reopening the app.

   register() alone would usually do it — the top-level worker script bypasses
   the HTTP cache by default — but update() states the intent, and it is the
   call that still works when a registration already exists from an older
   build. Both are best-effort: http:// on a non-localhost origin, private mode
   and a locked-down webview all reject here, and none of them are errors the
   app can do anything about. */
export function registerSW() {
  if (started) return;
  started = true;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  // resolved from this module, so it works at any host path; the default scope
  // is the script's own directory (app/), which deliberately excludes /data/
  const url = new URL("../sw.js", import.meta.url);
  const go = () => {
    navigator.serviceWorker.register(url)
      .then((reg) => (reg && reg.update ? reg.update() : null))
      .catch(() => { /* nothing here is recoverable from the page */ });
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

/* ── the version handshake ────────────────────────────────────────────────── */
/* Asks the CONTROLLING worker what version it is, over a private MessagePort so
   the answer cannot be confused with any other message. Resolves null — never
   rejects, never hangs — when there is no controller, when the worker does not
   answer (an older build with no message handler), or when it takes too long.
   Null means "unknown", which is reported as unknown; it is never treated as a
   mismatch, because a hint that fires on silence would cry wolf on every first
   launch. */
export function workerVersion(timeoutMs) {
  return new Promise((resolve) => {
    const sw = typeof navigator !== "undefined" && navigator.serviceWorker;
    const ctrl = sw && sw.controller;
    if (!ctrl) { resolve(null); return; }

    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer !== null) window.clearTimeout(timer);
      resolve(v);
    };
    timer = window.setTimeout(() => finish(null), timeoutMs || 1200);

    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        const d = e.data;
        finish(d && d.type === "version" && d.version ? String(d.version) : null);
      };
      ctrl.postMessage({ type: "version?" }, [ch.port2]);
    } catch (e) { finish(null); }
  });
}

/* The whole decision, as a pure function of two strings.

   `version` is what the controller answered, `build` is the constant compiled
   into the code that is running. They disagree only when this page was loaded
   from one build and is now being served by another — a half-swapped shell,
   seen from the inside. The honest remedy is a cold start, and saying so is
   the entire feature: no auto-reload (it would fight a person mid-edit and can
   loop), no blocking modal, no silent retry. */
export function mixedVersionHint(build, version) {
  if (!version || !build) return null;          // unknown is not a mismatch
  if (String(version) === String(build)) return null;
  return "Update ready — close Wayfeather and reopen it.";
}

/* ── device facts ─────────────────────────────────────────────────────────── */
/* standalone = launched from the Home Screen icon. Worth printing because the
   installed app has its OWN storage silo, separate from the Safari tab: a token
   entered in the tab is genuinely absent from the installed app, and that is a
   different problem from a token that failed to save (DESIGN §2, LLMS.md). */
export function displayMode() {
  try {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
      return "standalone";
    }
  } catch (e) { /* no matchMedia */ }
  // iOS Safari's own pre-standard flag, still the only signal in older webviews
  if (typeof navigator !== "undefined" && navigator.standalone) return "standalone";
  return "browser";
}

/* One snapshot of everything the About block prints. `extra` carries facts this
   module has no business knowing — the data source label comes from the
   settings view, which is also what keeps the token out of here: there is no
   code path from storage to this object. */
export async function collectDiagnostics(extra) {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const controlled = !!(supported && navigator.serviceWorker.controller);
  const version = controlled ? await workerVersion(1200) : null;
  return Object.assign({
    build: BUILD,
    display: displayMode(),
    swSupported: supported,
    controlled,
    workerVersion: version,
    storage: storageProbe(),
    idb: await idbProbe()
  }, extra || {});
}

function workerLine(f) {
  if (!f.swSupported) return "unsupported on this browser";
  if (!f.controlled) return "not controlling this page";
  if (!f.workerVersion) return "active · version unreachable";
  if (String(f.workerVersion) !== String(f.build)) {
    return f.workerVersion + " · does not match this page";
  }
  return f.workerVersion + " · active";
}

/* Pure: facts in, label/value pairs out. Kept apart from the painter so the
   wording is testable and so a screenshot of this list is the whole field
   report — someone reading "Storage: failing, Service worker: v8 · does not
   match this page" already knows both answers without another round trip. */
export function diagRows(facts) {
  const f = facts || {};
  return [
    ["Build", f.build || "unknown"],
    ["Display mode", f.display === "standalone" ? "standalone (installed)" : "browser tab"],
    ["Service worker", workerLine(f)],
    ["Storage", f.storage ? "ok" : "failing"],
    ["Offline store", f.idb ? "ok" : "unavailable"],
    ["Data source", f.source || "this site"]
  ];
}
