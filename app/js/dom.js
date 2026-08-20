/* dom.js — escaping and tiny DOM helpers. No app state lives here. */

const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/* HTML-escape. NOTE (CLAUDE.md gotcha): the replacement is a FUNCTION, never a
   string — a string replacement treats "$$" (a real `cost` value in the trip
   data) as an escape sequence and silently corrupts it. Every splice of trip
   text into markup in this app goes through here or through textContent. */
export function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ENT[c]);
}

/* Same escaping, used in attribute position — named apart so call sites read
   as intent rather than as a coincidence. */
export const attr = esc;

export const enc = encodeURIComponent;

export function $(id) { return document.getElementById(id); }

/* Read the media query fresh every time: the setting can change while the app
   is open, and nothing should cache a decision about motion. */
export function reduced() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

export function copy(o) {
  const out = {};
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

/* Build the first element of an HTML string. */
export function frag(html) {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box.firstElementChild;
}

/* Swap an element for freshly rendered HTML, keeping its position. */
export function replaceWith(node, html) {
  const fresh = frag(html);
  if (node && fresh && node.parentNode) node.parentNode.replaceChild(fresh, node);
  return fresh;
}

/* Attribute-selector-safe quoting for ids that came from data. */
export function q(value) { return String(value == null ? "" : value).replace(/"/g, '\\"'); }

export function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  } catch (e) { return fallback; }
}
