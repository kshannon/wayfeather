/* views/card.js — the stopover card and its fragments.
   Shared by the Itinerary list and the Map tab's docked card, so Did it! /
   Skip it / links behave identically in both places.
   `ctx` carries what the fragments need from the trip: { loc, tz }. */

import { esc, attr } from "../dom.js";
import { clockOf } from "../time.js";
import { linkList, badHours } from "../links.js";
import { icon, RESV_SVG } from "../icons.js";
import {
  chipOf, isNote, stateOf, isVisited, isSkipped, isReserved, needsCall, formatCost
} from "../trip.js";

export function linksHTML(p, ctx) {
  const L = linkList(p, ctx.loc);
  if (!L.length) return "";
  return '<div class="iconlinks">' + L.map((x) =>
    '<a class="ilink" href="' + attr(x.u) + '" target="_blank" rel="noopener noreferrer"' +
    ' aria-label="' + attr(x.a) + '">' + icon(x.k) + "<b>" + esc(x.t) + "</b></a>"
  ).join("") + "</div>";
}

export function hoursHTML(p) {
  if (!p.hours) return "";
  const bad = badHours(p.hours);
  return '<p class="hours' + (bad ? " is-bad" : "") + '">' +
    '<span aria-hidden="true">' + (bad ? "⚠" : "◷") + "</span>" +
    "<span>" + esc(p.hours) + "</span></p>";
}

/* The callAhead boolean and a `warn` string merge into ONE line, never two.
   (Schema 2 moved call-ahead off the priority enum onto its own axis — the line
   itself is unchanged, and so is the merge.) */
export function warnHTML(p) {
  const call = needsCall(p);
  if (!call && !p.warn) return "";
  const body = call
    ? "<b>Call ahead</b>" + (p.warn ? '<span aria-hidden="true"> · </span>' + esc(p.warn) : "")
    : esc(p.warn);
  return '<p class="warnline"><span aria-hidden="true">⚠</span><span>' + body + "</span></p>";
}

export function timeHTML(p) {
  return '<span class="card-time">' +
    '<span class="time u-tab-num">' + esc(p.time || "") + "</span>" +
    (isReserved(p) ? RESV_SVG : "") +
  "</span>";
}

/* One chip, or none. trip.chipOf decides WHICH — ★★ Reserved outranks ★ Must
   outranks Maybe — so the precedence lives with the model rather than being
   re-derived by every surface that draws a corner. */
export function chipHTML(p) {
  const c = chipOf(p);
  return c ? '<span class="chip chip-' + c[0] + '">' + esc(c[1]) + "</span>" : "";
}

/* The cost pill (DESIGN §3/§5). Absent entirely when cost is null — an unpriced
   stopover shows nothing rather than claiming to be free. */
export function costHTML(p) {
  const t = formatCost(p.cost);
  if (!t) return "";
  return '<p class="cost' + (p.cost === 0 ? " is-free" : "") + '">' + esc(t) + "</p>";
}

/* Hours chip and cost pill share one wrapping row, so a stopover with both does
   not spend two full lines of a phone screen on two short chips. */
export function factsHTML(p) {
  const inner = hoursHTML(p) + costHTML(p);
  return inner ? '<div class="factrow">' + inner + "</div>" : "";
}

/* Landed / Flew past are one row: a state label plus an explicit Undo control,
   so undo is a labelled button rather than "tap the status again".
   (DESIGN §5, avian voice: Did it! → Landed!, Skip it → Flew past.)

   The two states carry DIFFERENT MARKUP, not just different colours (DESIGN §5,
   "Handled-state contrast"): Landed gets .state-check, a filled accent disc with
   a ✓; Flew past gets .state-dash, the same 22px box with no fill at all and a
   bare dash in it. Filled-vs-hollow survives a glance, a squint, and a
   grayscale screenshot in a way that two similar tints do not. */
/* ── the Reserved guard's inline confirm (DESIGN §5) ──────────────────────────
   "Protected, not locked": flying past a booked stopover asks once, in place,
   and the answer is two real buttons rather than a browser confirm() — which on
   an installed PWA renders as a system alert wearing the origin's name and
   breaks the app's spell completely.

   The pending id lives here rather than in the view that raised it because ONE
   stopover is drawn by three surfaces at once (itinerary card, Details sheet,
   map bar). Parking the flag beside the fragment they all share means asking on
   the card and answering on the bar is coherent by construction, instead of
   three copies of the same boolean drifting apart. */
let askId = null;

export const ASK_Q = "Reserved — change anyway?";

export function setSkipAsk(id) { askId = id || null; }
export function skipAsk() { return askId; }

/* `withQuestion:false` is the map bar, which has a title row to put the
   question in and a fixed 44px action row that cannot grow to hold it. */
export function askHTML(p, opts) {
  const id = attr(p.id), nm = attr(p.name || "this stopover");
  const q = (opts && opts.withQuestion === false)
    ? ""
    : '<p class="ask-q"><span class="ask-mark" aria-hidden="true">★★</span>' +
      esc(ASK_Q) + "</p>";
  return '<div class="acts is-ask" role="group" aria-label="' + attr(ASK_Q) + '">' + q +
    '<button type="button" class="act act-keep" data-ask="no" data-id="' + id + '" ' +
      'aria-label="Keep ' + nm + ' as it is">Keep it</button>' +
    '<button type="button" class="act act-confirm" data-ask="yes" data-id="' + id + '" ' +
      'aria-label="Flew past — skip ' + nm + ' anyway">Flew past</button>' +
  "</div>";
}

export function actsHTML(p, ctx) {
  const st = stateOf(p), id = attr(p.id), nm = attr(p.name || "this stopover");
  if (askId === p.id && !st.visited && !st.skipped) return askHTML(p);
  if (st.visited) {
    const w = clockOf(st.visited, ctx.tz);
    return '<div class="state-row">' +
      '<span class="state-lead">' +
        '<span class="state-check" aria-hidden="true">✓</span>' +
        '<span class="state-text">Landed' +
          (w ? '<span aria-hidden="true"> · </span><span class="when">' + esc(w) + "</span>" : "") +
        "</span>" +
      "</span>" +
      '<button type="button" class="undo" data-act="clear" data-id="' + id + '" ' +
        'aria-label="Undo — mark ' + nm + ' as not visited">Undo</button>' +
    "</div>";
  }
  if (st.skipped) {
    return '<div class="state-row is-skip">' +
      '<span class="state-lead">' +
        '<span class="state-dash" aria-hidden="true">–</span>' +
        '<span class="state-text">Flew past</span>' +
      "</span>" +
      '<button type="button" class="undo" data-act="clear" data-id="' + id + '" ' +
        'aria-label="Undo — put ' + nm + ' back on the list">Undo</button>' +
    "</div>";
  }
  return '<div class="acts">' +
    '<button type="button" class="act act-do" data-act="visit" data-id="' + id + '" ' +
      'aria-label="Landed — mark ' + nm + ' as visited">Landed!</button>' +
    '<button type="button" class="act act-no" data-act="skip" data-id="' + id + '" ' +
      'aria-label="Flew past — skip ' + nm + '">Flew past</button>' +
  "</div>";
}

/* The ONLY way into the edit sheet (DESIGN §5). A card cannot be role=button
   while it contains buttons and links, and the whole-card tap it used to carry
   instead put an invisible edit target under the state text and the meta — so
   editing is a real 44px control, present on every card and on the map dock,
   and nothing else on a card navigates. */
export function editBtn(p) {
  return '<button type="button" class="editbtn" data-edit="' + attr(p.id) + '" ' +
    'aria-label="Edit ' + attr(p.name || "this stopover") + '">' +
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M15.2 5.4 18.6 8.8"/>' +
    '<path d="M6.2 14.4 15.4 5.2a2.4 2.4 0 0 1 3.4 3.4l-9.2 9.2-4.3.9Z"/></svg></button>';
}

function noteHTML(p) {
  return '<div class="noterow" data-card="' + attr(p.id) + '">' +
    '<div class="noterow-top">' +
      (p.time ? '<span class="noterow-time u-tab-num">' + esc(p.time) + "</span>" : "") +
      (p.name ? '<span class="noterow-name">' + esc(p.name) + "</span>" : "") +
      '<span style="margin-left:auto">' + editBtn(p) + "</span>" +
    "</div>" +
    (p.notes ? '<p class="noterow-text">' + esc(p.notes) + "</p>" : "") +
  "</div>";
}

export function cardHTML(p, ctx) {
  if (isNote(p)) return noteHTML(p);
  const vis = isVisited(p), skp = isSkipped(p);
  /* `reserved` is a boolean now, so it is a class of its own rather than one of
     the p-* priority classes — the two axes compose, and a reserved must has to
     be able to wear both. */
  const cls = "card p-" + esc(p.priority || "none") +
              (isReserved(p) ? " is-reserved" : "") +
              (vis ? " is-visited" : "") + (skp ? " is-skipped" : "");

  /* Cost left the meta line in schema 2: it is a pill beside the hours chip
     now, which is also why nothing here has to think about "$$" any more. */
  const metaBits = [];
  if (p.type) metaBits.push(esc(p.type));
  if (p.address) metaBits.push(esc(p.address));
  const meta = metaBits.length
    ? '<p class="meta">' + metaBits.join('<span class="dot" aria-hidden="true">·</span>') + "</p>"
    : "";

  return '<article class="' + cls + '" data-card="' + attr(p.id) + '">' +
      '<div class="card-top">' + timeHTML(p) +
        '<span class="card-tools">' + chipHTML(p) + editBtn(p) + "</span>" +
      "</div>" +
      "<h3>" + esc(p.name || "") + "</h3>" +
      meta + factsHTML(p) + warnHTML(p) +
      (p.notes ? '<p class="notes">' + esc(p.notes) + "</p>" : "") +
      linksHTML(p, ctx) +
      actsHTML(p, ctx) +
    "</article>";
}
