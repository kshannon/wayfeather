/* chrome.js — app chrome: the four views, the tab bar, and the nav bar whose
   compact title is the condensed form of each view's large title.

   The condense is driven by an IntersectionObserver on the ACTIVE view's
   [data-large-title], with the root shrunk from the top by the bar height: the
   instant the large title's bottom passes under the bar, the bar's material,
   hairline and centred title fade in. Only opacity and transform animate, and
   both transitions are already gated behind prefers-reduced-motion in CSS, so
   reduced motion gets the same two states instantly. */

import { $ } from "./dom.js";
import { VIEWS, syncView } from "./router.js";

let current = null;
const scrollY = Object.create(null);
const titles = Object.create(null);
let io = null;
let onChange = null;

let navbar = null, navTitle = null, tabbar = null;

function els() {
  navbar = navbar || $("navbar");
  navTitle = navTitle || $("navbarTitle");
  tabbar = tabbar || $("tabbar");
}

export function getView() { return current; }
export function onViewChange(fn) { onChange = fn; }

/* Views whose large title is fixed markup rather than trip data. The Itinerary
   and Map titles are set from the data as it renders. */
export function setStaticTitles() {
  setTitle("trips", "Trips");
  setTitle("settings", "Settings");
}

/* Each view names its own compact title; it shows only while that view is up. */
export function setTitle(view, text) {
  titles[view] = text || "";
  if (view === current) { els(); navTitle.textContent = titles[view]; }
}

function condense(on) {
  els();
  navbar.classList.toggle("is-condensed", !!on);
}

function observeTitle() {
  els();
  if (io) { io.disconnect(); io = null; }
  const view = $("view-" + current);
  const target = view && view.querySelector("[data-large-title]");
  if (!target || !("IntersectionObserver" in window)) { condense(false); return; }
  const barH = navbar.offsetHeight || 44;
  io = new IntersectionObserver(
    (entries) => { condense(!entries[0].isIntersecting); },
    { rootMargin: "-" + (barH + 4) + "px 0px 0px 0px", threshold: 0 }
  );
  io.observe(target);
}

export function setView(name, moveFocus) {
  els();
  if (VIEWS.indexOf(name) < 0) name = "itinerary";
  if (current === name) { window.scrollTo(0, scrollY[name] || 0); return; }

  if (current) scrollY[current] = window.pageYOffset || document.documentElement.scrollTop || 0;
  current = name;

  VIEWS.forEach((v) => { $("view-" + v).classList.toggle("is-on", v === name); });

  const tabs = tabbar.querySelectorAll(".navtab");
  for (let i = 0; i < tabs.length; i++) {
    const on = tabs[i].getAttribute("data-view") === name;
    tabs[i].setAttribute("aria-selected", on ? "true" : "false");
    tabs[i].tabIndex = on ? 0 : -1;
    if (on && moveFocus) tabs[i].focus();
  }

  navTitle.textContent = titles[name] || "";
  window.scrollTo(0, scrollY[name] || 0);
  condense((scrollY[name] || 0) > 40);      // paint the right state before the IO fires
  observeTitle();
  syncView(name);
  if (onChange) onChange(name);
}

/* Arrow / Home / End across the tab bar, per the tablist pattern. */
export function wireTabKeys() {
  els();
  tabbar.addEventListener("keydown", (e) => {
    const i = VIEWS.indexOf(current);
    let next = null;
    if (e.key === "ArrowRight") next = VIEWS[(i + 1) % VIEWS.length];
    else if (e.key === "ArrowLeft") next = VIEWS[(i - 1 + VIEWS.length) % VIEWS.length];
    else if (e.key === "Home") next = VIEWS[0];
    else if (e.key === "End") next = VIEWS[VIEWS.length - 1];
    if (next) { e.preventDefault(); setView(next, true); }
  });
}
