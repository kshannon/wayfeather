/* toast.js — one transient status line, optionally carrying a single undo. */

import { $, esc, reduced } from "./dom.js";

let el = null, timer = null, undoFn = null;

function node() { return el || (el = $("toast")); }

export function toast(msg, undo) {
  const t = node();
  window.clearTimeout(timer);
  undoFn = undo || null;
  t.innerHTML = '<span class="toast-msg">' + esc(msg) + "</span>" +
    (undoFn ? '<button class="toast-undo" type="button" id="toastUndo">Undo</button>' : "");
  t.hidden = false;
  t.classList.remove("is-out");
  timer = window.setTimeout(hideToast, undoFn ? 6000 : 2600);
}

export function hideToast() {
  const t = node();
  window.clearTimeout(timer);
  undoFn = null;
  t.classList.add("is-out");
  window.setTimeout(() => { t.hidden = true; }, reduced() ? 0 : 200);
}

/* The toast's undo button is handled by the global click delegate, which pulls
   the pending callback out through here. */
export function takeUndo() {
  const fn = undoFn;
  hideToast();
  return fn;
}
