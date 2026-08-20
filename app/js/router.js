/* router.js — the URL is the shareable state: ?trip=<id> picks the trip,
   #<view> picks the tab, ?reset wipes this device. Nothing here touches app
   state; it parses and it writes the address bar. */

export const VIEWS = ["itinerary", "map", "trips", "settings"];

function parseQuery() {
  const q = window.location.search.replace(/^\?/, "");
  const kept = [];
  let reset = false, trip = null;
  q.split("&").forEach((kv) => {
    if (!kv) return;
    const i = kv.indexOf("=");
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " "));
    if (k === "reset") { reset = true; return; }   // dropped from the kept list
    if (k === "trip") { trip = v; }
    kept.push(kv);
  });
  return { reset, trip, kept };
}

export function viewFromHash() {
  const h = String(window.location.hash || "").replace(/^#/, "");
  return VIEWS.indexOf(h) >= 0 ? h : null;
}

function replaceUrl(kept, hash) {
  if (!(window.history && window.history.replaceState)) return;
  const search = kept.length ? "?" + kept.join("&") : "";
  window.history.replaceState(null, "", window.location.pathname + search + (hash || ""));
}

/* Read the boot intent. ?reset strips itself from the URL immediately so a
   reload does not keep wiping; ?trip survives it. */
export function parseBoot() {
  const { reset, trip, kept } = parseQuery();
  const view = viewFromHash();
  if (reset) replaceUrl(kept, window.location.hash);
  return { reset, trip, view };
}

export function syncTrip(id) {
  const { kept } = parseQuery();
  const rest = kept.filter((kv) => kv.split("=")[0] !== "trip");
  rest.push("trip=" + encodeURIComponent(id));
  replaceUrl(rest, window.location.hash);
}

/* The tab lives in the hash so a relaunch of the installed app lands where you
   left it. replaceState, not assignment: no history entry, no hashchange. */
export function syncView(name) {
  const { kept } = parseQuery();
  replaceUrl(kept, name && name !== "itinerary" ? "#" + name : "");
}

export function onHashChange(fn) {
  window.addEventListener("hashchange", () => {
    const v = viewFromHash();
    if (v) fn(v);
  });
}
