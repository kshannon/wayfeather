/* sheets.js — iOS bottom sheets: dimmed scrim, rounded top corners, grabber.

   Dialog duties kept from v3: focus moves in, Tab is trapped, Esc closes, the
   background is inert, and focus returns to whatever opened it. The grabber
   drag and the scrim tap are conveniences ON TOP of a real close BUTTON, never
   instead of one. */

import { $, reduced } from "./dom.js";

const CLOSE_MS = 340;
const DRAG_CLOSE = 96;          // px past which release closes

let openEl = null, opener = null, scrim = null, shell = null, tabbar = null;
let closeHandler = null;

function els() {
  scrim = scrim || $("scrim");
  shell = shell || $("shell");
  tabbar = tabbar || $("tabbar");
}

export function isOpen() { return !!openEl; }
export function openSheetEl() { return openEl; }

export function openSheet(el, from, focusEl) {
  els();
  openEl = el; opener = from || null;

  scrim.hidden = false;
  el.hidden = false;
  document.body.classList.add("is-locked");
  shell.setAttribute("aria-hidden", "true");
  tabbar.setAttribute("aria-hidden", "true");
  if ("inert" in HTMLElement.prototype) { shell.inert = true; tabbar.inert = true; }

  if (!reduced()) { void scrim.offsetHeight; void el.offsetHeight; }  // force reflow
  scrim.classList.add("is-in");
  el.style.removeProperty("--drag");
  el.classList.add("is-in");

  (focusEl || el.querySelector(".sheet-x")).focus();
}

export function closeSheet() {
  const el = openEl;
  if (!el) return;
  els();
  openEl = null;

  const done = () => {
    el.hidden = true;
    el.style.removeProperty("--drag");
    scrim.hidden = true;
    document.body.classList.remove("is-locked");
    shell.removeAttribute("aria-hidden");
    tabbar.removeAttribute("aria-hidden");
    if ("inert" in HTMLElement.prototype) { shell.inert = false; tabbar.inert = false; }
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    opener = null;
    if (closeHandler) closeHandler();
  };

  el.classList.remove("is-in", "is-dragging");
  scrim.classList.remove("is-in");
  if (reduced()) done(); else window.setTimeout(done, CLOSE_MS);
}

export function onClose(fn) { closeHandler = fn; }

/* ── keyboard: Esc + focus trap ───────────────────────────────────────────── */
export function handleKeydown(e) {
  if (!openEl) return false;
  if (e.key === "Escape") { e.preventDefault(); closeSheet(); return true; }
  if (e.key === "Tab") {
    const f = openEl.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
      'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
    if (!f.length) return true;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  return true;
}

/* ── grabber drag-to-dismiss (transform only) ─────────────────────────────── */
export function wireGrabber(grabEl, sheetEl) {
  if (!grabEl) return;
  let y0 = 0, dy = 0, dragging = false, id = null;

  const move = (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - y0);
    sheetEl.style.setProperty("--drag", dy.toFixed(1) + "px");
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheetEl.classList.remove("is-dragging");
    try { if (id !== null) grabEl.releasePointerCapture(id); } catch (err) { /* gone */ }
    id = null;
    if (dy > DRAG_CLOSE) closeSheet();
    else sheetEl.style.setProperty("--drag", "0px");
  };

  grabEl.addEventListener("pointerdown", (e) => {
    if (reduced() || openEl !== sheetEl) return;   // reduced motion: buttons only
    dragging = true; y0 = e.clientY; dy = 0; id = e.pointerId;
    sheetEl.classList.add("is-dragging");
    try { grabEl.setPointerCapture(id); } catch (err) { /* ignore */ }
  });
  grabEl.addEventListener("pointermove", move);
  grabEl.addEventListener("pointerup", end);
  grabEl.addEventListener("pointercancel", end);
}

/* Tapping the dimmed scrim closes, same as iOS. */
export function wireScrim() {
  els();
  scrim.addEventListener("click", () => { if (openEl) closeSheet(); });
}
