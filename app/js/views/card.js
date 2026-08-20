/* views/card.js — the stopover card and its fragments.
   Shared by the Itinerary list and the Map tab's docked card, so Did it! /
   Skip it / links behave identically in both places.
   `ctx` carries what the fragments need from the trip: { loc, tz }. */

import { esc, attr } from "../dom.js";
import { clockOf } from "../time.js";
import { linkList, badHours } from "../links.js";
import { icon, RESV_SVG } from "../icons.js";
import { CHIP, isNote, stateOf, isVisited, isSkipped } from "../trip.js";

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

/* priority:"check" and a `warn` string merge into ONE line, never two. */
export function warnHTML(p) {
  const callAhead = p.priority === "check";
  if (!callAhead && !p.warn) return "";
  const body = callAhead
    ? "<b>Call ahead</b>" + (p.warn ? '<span aria-hidden="true"> · </span>' + esc(p.warn) : "")
    : esc(p.warn);
  return '<p class="warnline"><span aria-hidden="true">⚠</span><span>' + body + "</span></p>";
}

export function timeHTML(p) {
  return '<span class="card-time">' +
    '<span class="time u-tab-num">' + esc(p.time || "") + "</span>" +
    (p.priority === "fixed" ? RESV_SVG : "") +
  "</span>";
}

export function chipHTML(p) {
  if (isVisited(p) || isSkipped(p) || !CHIP[p.priority]) return "";
  return '<span class="chip chip-' + CHIP[p.priority][0] + '">' + esc(CHIP[p.priority][1]) + "</span>";
}

/* Landed / Flew past are one row: a state label plus an explicit Undo control,
   so undo is a labelled button rather than "tap the status again".
   (DESIGN §5, avian voice: Did it! → Landed!, Skip it → Flew past.)

   The two states carry DIFFERENT MARKUP, not just different colours (DESIGN §5,
   "Handled-state contrast"): Landed gets .state-check, a filled accent disc with
   a ✓; Flew past gets .state-dash, the same 22px box with no fill at all and a
   bare dash in it. Filled-vs-hollow survives a glance, a squint, and a
   grayscale screenshot in a way that two similar tints do not. */
export function actsHTML(p, ctx) {
  const st = stateOf(p), id = attr(p.id), nm = attr(p.name || "this stopover");
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
  const cls = "card p-" + esc(p.priority || "none") +
              (vis ? " is-visited" : "") + (skp ? " is-skipped" : "");

  const metaBits = [];
  if (p.type) metaBits.push(esc(p.type));
  if (p.address) metaBits.push(esc(p.address));
  if (p.cost) metaBits.push(esc(p.cost));      /* never run through .replace — "$$" */
  const meta = metaBits.length
    ? '<p class="meta">' + metaBits.join('<span class="dot" aria-hidden="true">·</span>') + "</p>"
    : "";

  return '<article class="' + cls + '" data-card="' + attr(p.id) + '">' +
      '<div class="card-top">' + timeHTML(p) +
        '<span class="card-tools">' + chipHTML(p) + editBtn(p) + "</span>" +
      "</div>" +
      "<h3>" + esc(p.name || "") + "</h3>" +
      meta + hoursHTML(p) + warnHTML(p) +
      (p.notes ? '<p class="notes">' + esc(p.notes) + "</p>" : "") +
      linksHTML(p, ctx) +
      actsHTML(p, ctx) +
    "</article>";
}
