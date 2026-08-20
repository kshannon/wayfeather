/* views/daystrip.js — the segmented day strip.

   ONE strip now: the Itinerary tablist that owns the day panels. The Map tab
   used to carry a second copy of it as a group of toggle buttons; the map went
   full-bleed (DESIGN §5, 2026-08-20) and day switching lives here alone, so
   that flavour is gone along with the map's title.

   The 1px separators are the container's own background showing through a 1px
   flex gap, so the rules read identically between, around and outside the
   blocks — including next to a filled (selected) block. */

import { $, esc, attr } from "../dom.js";
import { shortDate, dayNum } from "../time.js";
import { dayComplete } from "../trip.js";

function blockLabel(day, done) {
  return (day.label || day.key) + (day.date ? ", " + shortDate(day.date) : "") +
         (done ? ", complete" : "");
}

export function dayBlockHTML(trip, day) {
  const done = dayComplete(trip, day);
  const num = day.date ? dayNum(day.date) : (day.bullet || "");
  const common =
    '<span class="dblock-label">' + esc(day.label || day.key) + "</span>" +
    '<span class="dblock-num u-tab-num">' + esc(num) + "</span>" +
    (done ? '<span class="dblock-done" aria-hidden="true">✓</span>' : "");

  return '<button class="dblock' + (done ? " is-done" : "") + '" type="button" role="tab" ' +
    'id="daytab-' + attr(day.key) + '" aria-controls="panel-' + attr(day.key) + '" ' +
    'aria-selected="false" tabindex="-1" aria-label="' + attr(blockLabel(day, done)) + '" ' +
    'data-key="' + attr(day.key) + '">' + common + "</button>";
}

export function renderStrips(trip) {
  $("dayTabs").innerHTML = trip.days.map((d) => dayBlockHTML(trip, d)).join("");
}

function ensureVisible(el) {
  if (!el || !el.parentNode) return;
  const box = el.parentNode;
  const cr = box.getBoundingClientRect(), tr = el.getBoundingClientRect(), pad = 8;
  if (tr.left < cr.left + pad) box.scrollLeft -= (cr.left + pad - tr.left);
  else if (tr.right > cr.right - pad) box.scrollLeft += (tr.right - (cr.right - pad));
}

export function paintStrips(dayKey, moveFocus) {
  const tabs = $("dayTabs").querySelectorAll(".dblock");
  for (let i = 0; i < tabs.length; i++) {
    const on = tabs[i].getAttribute("data-key") === dayKey;
    tabs[i].setAttribute("aria-selected", on ? "true" : "false");
    tabs[i].classList.toggle("is-sel", on);
    tabs[i].tabIndex = on ? 0 : -1;
    if (on) { if (moveFocus) tabs[i].focus(); ensureVisible(tabs[i]); }
  }
}

/* Grey-out + ✓ after a state change, without a full repaint of the strips. */
export function syncCompletion(trip) {
  trip.days.forEach((d) => {
    const done = dayComplete(trip, d);
    const el = $("dayTabs").querySelector('[data-key="' + d.key + '"]');
    if (!el) return;
    el.classList.toggle("is-done", done);
    el.setAttribute("aria-label", blockLabel(d, done));
    let mark = el.querySelector(".dblock-done");
    if (done && !mark) {
      mark = document.createElement("span");
      mark.className = "dblock-done";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "✓";
      el.appendChild(mark);
    } else if (!done && mark) {
      mark.parentNode.removeChild(mark);
    }
  });
}
