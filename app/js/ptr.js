/* ptr.js — pull to refresh.

   The gesture mechanic is v3's, unchanged: the shell translates, a fixed
   indicator behind it is revealed in the gap, horizontal drags and upward
   flicks never get hijacked, and mouse drags are supported so the thing is
   testable on a desktop. What changed is the payload — the release now awaits
   a real network round trip instead of a setTimeout, held open for a minimum
   beat so the spinner cannot flash. */

import { $, reduced } from "./dom.js";

const PULL_MAX = 118, PULL_TRIG = 64, PULL_REST = 66, MIN_SPIN = 420;

let shell = null, ptr = null, ptrLabel = null;
let canPull = () => false, doWork = () => Promise.resolve();
const pull = { armed: false, active: false, y0: 0, x0: 0, d: 0 };
let busy = false, settleT = null, suppressUntil = 0;

export function isBusy() { return busy; }

function atTop() { return (window.pageYOffset || document.documentElement.scrollTop || 0) <= 0; }
function ready() { return !busy && canPull() && atTop(); }
function easePull(raw) { return PULL_MAX * (1 - Math.exp(-raw / 180)); }

function paintPull(d) {
  window.clearTimeout(settleT);
  shell.classList.remove("is-settling");
  if (d <= 0) {
    shell.classList.remove("is-pulling");
    shell.style.removeProperty("--pull");
    ptr.style.setProperty("--ptr-o", "0");
    return;
  }
  shell.classList.add("is-pulling");
  shell.style.setProperty("--pull", d.toFixed(1) + "px");
  const t = Math.min(1, d / PULL_TRIG);
  ptr.style.setProperty("--ptr-o", String(Math.min(1, t * 1.15)));
  ptr.style.setProperty("--ptr-s", String(0.65 + 0.35 * t));
  ptr.style.setProperty("--ptr-r", (t >= 1 ? 180 : 0) + "deg");
  if (!busy) ptrLabel.textContent = t >= 1 ? "Release to refresh" : "Pull to refresh";
}

function settle() {
  pull.armed = false; pull.active = false; pull.d = 0;
  if (reduced()) { paintPull(0); return; }
  shell.classList.add("is-pulling", "is-settling");
  shell.style.setProperty("--pull", "0px");
  ptr.style.setProperty("--ptr-o", "0");
  settleT = window.setTimeout(() => {
    shell.classList.remove("is-pulling", "is-settling");
    shell.style.removeProperty("--pull");
  }, 360);
}

export async function refreshNow() {
  if (busy) return;
  busy = true;
  pull.armed = false; pull.active = false;
  ptr.classList.add("is-busy");
  ptrLabel.textContent = "Refreshing…";
  window.clearTimeout(settleT);
  shell.classList.add("is-pulling");
  if (!reduced()) shell.classList.add("is-settling");
  shell.style.setProperty("--pull", PULL_REST + "px");
  ptr.style.setProperty("--ptr-o", "1");
  ptr.style.setProperty("--ptr-s", "1");

  const started = Date.now();
  try { await doWork(); } catch (e) { /* the data layer already fell back */ }
  const held = Date.now() - started;
  if (held < MIN_SPIN) await new Promise((r) => window.setTimeout(r, MIN_SPIN - held));

  ptr.classList.remove("is-busy");
  ptrLabel.textContent = "Pull to refresh";
  busy = false;
  settle();
}

function endPull() {
  if (!pull.active) { pull.armed = false; return; }
  const fire = pull.d >= PULL_TRIG;
  pull.active = false; pull.armed = false;
  if (fire) refreshNow(); else settle();
}

export function initPTR(opts) {
  shell = $("shell"); ptr = $("ptr"); ptrLabel = $("ptrLabel");
  canPull = opts.canPull || canPull;
  doWork = opts.onRefresh || doWork;

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || !ready()) { pull.armed = false; return; }
    pull.armed = true; pull.active = false; pull.d = 0;
    pull.y0 = e.touches[0].clientY; pull.x0 = e.touches[0].clientX;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pull.armed || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - pull.y0, dx = e.touches[0].clientX - pull.x0;
    if (!pull.active) {
      // never hijack the horizontal day strip, never fight an upward flick
      if (Math.abs(dx) > Math.abs(dy)) { pull.armed = false; return; }
      if (dy < -4) { pull.armed = false; return; }
      if (dy > 8 && atTop()) pull.active = true; else return;
    }
    if (dy <= 0) { paintPull(0); pull.d = 0; return; }
    if (e.cancelable) e.preventDefault();
    pull.d = easePull(dy);
    paintPull(pull.d);
  }, { passive: false });

  document.addEventListener("touchend", endPull, { passive: true });
  document.addEventListener("touchcancel", endPull, { passive: true });

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !ready()) { pull.armed = false; return; }
    if (e.target && e.target.closest && e.target.closest("input,textarea,select")) return;
    pull.armed = true; pull.active = false; pull.d = 0;
    pull.y0 = e.clientY; pull.x0 = e.clientX;
  });

  document.addEventListener("mousemove", (e) => {
    if (!pull.armed) return;
    const dy = e.clientY - pull.y0, dx = e.clientX - pull.x0;
    if (!pull.active) {
      if (Math.abs(dx) > Math.abs(dy)) { pull.armed = false; return; }
      if (dy < -4) { pull.armed = false; return; }
      if (dy > 8 && atTop()) pull.active = true; else return;
    }
    e.preventDefault();
    if (dy <= 0) { pull.d = 0; paintPull(0); return; }
    pull.d = easePull(dy);
    paintPull(pull.d);
  });

  document.addEventListener("mouseup", () => {
    if (pull.active && pull.d > 4) suppressUntil = Date.now() + 350;
    endPull();
  });

  // a drag that ended over a card must not also count as a tap on it
  document.addEventListener("click", (e) => {
    if (Date.now() < suppressUntil) { suppressUntil = 0; e.stopPropagation(); e.preventDefault(); }
  }, true);
}
