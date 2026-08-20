/* views/settings.js — accent picker, the two device rows, and About.
   The M2 rows (repo + PAT) are inert markup in index.html; nothing here
   touches them. */

import { $, esc, attr } from "../dom.js";
import { relTime } from "../time.js";
import { ACCENTS, store, localChangeCount } from "../state.js";
import { cacheInfo } from "../data.js";

export function renderAccentPicker() {
  // NB: the attribute is data-pick-accent, not data-accent — data-accent is the
  // theme hook on <html>, so a [data-accent] delegate would match every click
  // in the document and swallow every branch below it.
  $("accentPick").innerHTML = ACCENTS.map((a) =>
    '<button class="swatch" type="button" data-pick-accent="' + attr(a.id) + '" ' +
    'aria-pressed="' + (a.id === store.accent ? "true" : "false") + '">' +
    '<span class="swatch-chip" style="background:' + attr(a.hex) + '" aria-hidden="true"></span>' +
    '<span class="swatch-name">' + esc(a.name) + "</span></button>"
  ).join("");
}

export function renderResetRow() {
  const n = localChangeCount();
  $("resetSub").textContent = n
    ? n + (n === 1 ? " local change" : " local changes") + " across all trips"
    : "Nothing changed on this device yet";
}

export async function renderCacheRow() {
  const { count, newest } = await cacheInfo();
  $("cacheSub").textContent = count
    ? count + (count === 1 ? " file" : " files") + " cached · newest " + relTime(newest)
    : "Nothing cached on this device yet";
}

export function renderAbout() {
  const meta = store.tripMeta;
  const rel = meta.fetchedAt ? relTime(meta.fetchedAt) : "never";
  $("aboutLine").innerHTML = "Trip data " +
    (meta.stale ? "from the offline cache" : "read from this site") +
    " · updated <b>" + esc(rel) + "</b>";
}

export function renderSettings() {
  renderAccentPicker();
  renderResetRow();
  renderAbout();
  renderCacheRow();
}
