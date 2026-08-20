/* views/trips.js — the loader: trips from index.json grouped past/upcoming.

   index.json carries only a human "dates" string, so past/upcoming needs each
   trip's real end date. Those come from store.summaries, which main.js warms in
   the background after first paint by loading every listed trip file (which
   also puts them in the IndexedDB cache, so switching trips works offline). A
   trip with no summary yet is listed as upcoming and simply shows its dates. */

import { $, esc, attr } from "../dom.js";
import { todayIn } from "../time.js";
import { store } from "../state.js";
import { CHEV_SVG } from "../icons.js";

function groupHTML(title, list) {
  if (!list.length) return "";
  return '<div class="sect wrap"><h2 class="sect-h">' + esc(title) + "</h2>" +
    '<div class="inset">' + list.map((e) => {
      const s = store.summaries[e.id];
      const on = e.id === store.activeTrip;
      const sub = esc(e.dates || "") +
        (s ? '<span aria-hidden="true"> · </span>' + esc(s.dayCount) + " days" : "");
      return '<button class="rowcard' + (on ? " is-active" : "") + '" type="button" ' +
        'data-trip="' + attr(e.id) + '"' + (on ? ' aria-current="true"' : "") + ">" +
        '<span class="rowcard-main">' +
          '<span class="rowcard-name">' + esc(e.name) + "</span>" +
          '<span class="rowcard-sub">' + sub + "</span>" +
        "</span>" +
        (on ? '<span class="pin">Active</span>' : CHEV_SVG) +
      "</button>";
    }).join("") + "</div></div>";
}

export function renderTrips() {
  const idx = store.index;
  const trips = (idx && idx.trips) || [];

  $("tripsLede").textContent = trips.length
    ? trips.length + (trips.length === 1 ? " trip" : " trips") +
      " · index updated " + ((idx && idx.updated) || "—")
    : "No trips available yet.";

  const up = [], past = [];
  trips.forEach((e) => {
    const s = store.summaries[e.id];
    const today = todayIn(s && s.tz);
    (s && s.end && String(s.end) < today ? past : up).push(e);
  });

  $("tripsList").innerHTML = groupHTML("Upcoming", up) + groupHTML("Past", past) ||
    '<div class="wrap"><p class="empty" style="margin-top:24px">No trips in the index.</p></div>';
}
