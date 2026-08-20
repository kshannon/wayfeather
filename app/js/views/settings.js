/* views/settings.js — the two device rows and About.

   v4 removed the accent picker: there is one theme now (DESIGN §5), so Settings
   is reset local changes · clear offline cache · the M2 rows · About. The M2
   rows (repo + PAT) are inert markup in index.html; nothing here touches them. */

import { $, esc } from "../dom.js";
import { relTime } from "../time.js";
import { store, localChangeCount } from "../state.js";
import { cacheInfo } from "../data.js";

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
  renderResetRow();
  renderAbout();
  renderCacheRow();
}
