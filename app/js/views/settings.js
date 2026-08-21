/* views/settings.js — the device rows, the M2 sync form, and About.

   The sync form is the only place in the app that touches the PAT, and it only
   ever writes: the value goes from the input straight into state.saveToken()
   and the input is cleared. Nothing here can read it back — state.hasToken()
   returns a boolean on purpose — so there is no path from storage to the
   screen, and a re-render can never repaint a secret into the DOM.

   renderSettings() runs on every scene refresh (after any edit), so the field
   painters must never stomp on something being typed: an input that currently
   has focus is left exactly as the person left it. */

import { $, esc } from "../dom.js";
import { relTime } from "../time.js";
import {
  store, localChangeCount, isConfigured, hasToken,
  saveSyncSettings, saveToken, clearToken, signOutGitHub
} from "../state.js";
import { cacheInfo, testConnection } from "../data.js";
import { BUILD } from "../version.js";
import { collectDiagnostics, diagRows } from "../shell.js";
import { toast } from "../toast.js";

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

export function renderBuildRow() {
  $("buildSub").textContent = "build " + BUILD;
}

/* "kshannon/wayfeather" or "this site" — the one phrase both About and the note
   are built from, so they can never disagree about where data came from. */
export function sourceLabel() {
  const s = store.sync || {};
  return isConfigured() ? s.owner + "/" + s.repo : "this site";
}

function setField(id, value) {
  const el = $(id);
  if (!el || el === document.activeElement) return;    // never fight a typist
  el.value = value;
}

export function renderSyncForm() {
  const s = store.sync || {};
  setField("s-owner", s.owner || "");
  setField("s-repo", s.repo || "");

  /* Configured token → the field disappears and the row says only that it
     exists. DESIGN §2's threat model is "whoever holds the phone holds the
     token"; that is no reason to also print it on the screen. */
  const saved = hasToken();
  $("s-tokenField").hidden = saved;
  $("s-tokenState").hidden = !saved;
  if (saved) setField("s-token", "");

  $("signOutBox").hidden = !(isConfigured() || saved);

  const note = $("syncNote");
  if (!isConfigured()) {
    note.textContent = "Trip files are read from this site. Fill in an owner and " +
      "repository to read and write a GitHub repo instead — a public one needs no token.";
  } else if (saved) {
    note.textContent = "Reading and writing " + sourceLabel() + " through the GitHub API.";
  } else {
    note.textContent = "Reading " + sourceLabel() + " without a token. That works for a " +
      "public repo; writing needs a fine-grained PAT with Contents read and write.";
  }
}

export function renderAbout() {
  const meta = store.tripMeta;
  const rel = meta.fetchedAt ? relTime(meta.fetchedAt) : "never";
  $("aboutLine").innerHTML = "Trip data " +
    (meta.stale ? "from the offline cache" : "read from " + esc(sourceLabel())) +
    " · updated <b>" + esc(rel) + "</b>";
}

/* ── diagnostics (About) ──────────────────────────────────────────────────── */
/* A field report is a screenshot. This block is what makes that screenshot
   worth something: build, whether this is the installed app or a browser tab,
   which worker is answering, whether the device can store anything, and where
   the trips are being read from. It is the difference between "the app broke
   and lost my token" and a row that says Storage: failing.

   The token is not here and cannot be — sourceLabel() is built from owner and
   repo, and nothing in this file can read the secret back (see the header).

   The snapshot is taken once and repainted from memory, because renderSettings()
   runs after every edit and probing storage and the worker on each repaint would
   be noise. main.js re-takes it whenever the Settings tab is opened, which is
   the only moment anybody is looking. */
let diagFacts = null;        // the snapshot everything repaints from
let diagPending = null;      // one in-flight probe, shared by concurrent renders

export function invalidateDiagnostics() { diagFacts = null; diagPending = null; }

function paintDiag(facts) {
  const box = $("diagList");
  if (!box) return;
  /* sourceLabel() is spliced fresh rather than cached with the rest: owner and
     repo can change between snapshots, and a stale source here would be exactly
     the kind of quiet lie this block exists to replace. */
  const rows = diagRows(Object.assign({}, facts, { source: sourceLabel() }));
  box.innerHTML = rows.map((r) =>
    '<div class="diag-row"><dt>' + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>"
  ).join("");
}

export async function renderDiagnostics() {
  if (!diagFacts) {
    /* refreshScene() repaints Settings after every edit; without this, two
       repaints in the same tick would each start their own probe. */
    if (!diagPending) diagPending = collectDiagnostics().then(null, () => null);
    diagFacts = await diagPending;
    diagPending = null;
  }
  /* A probe that could not run leaves the block exactly as it was rather than
     painting a row of failures it has not established. */
  if (!diagFacts) return null;
  paintDiag(diagFacts);
  return diagFacts;
}

export function renderSettings() {
  renderResetRow();
  renderSyncForm();
  renderAbout();
  renderBuildRow();
  renderCacheRow();
  renderDiagnostics();
}

/* ── actions (wired by main.js's click delegate) ──────────────────────────── */

/* Returns true when the DATA SOURCE moved, which is the caller's cue to reload:
   the trips on screen came from somewhere else a moment ago. */
export function saveSyncForm() {
  const before = (store.sync.owner || "") + "/" + (store.sync.repo || "");
  const saved = saveSyncSettings($("s-owner").value, $("s-repo").value);
  const after = (store.sync.owner || "") + "/" + (store.sync.repo || "");

  const field = $("s-token");
  const typed = field ? field.value : "";
  let tokenKept = true;
  if (typed.trim()) {
    tokenKept = saveToken(typed);
    /* Cleared only once the value is PROVED to be in storage. Wiping the field
       after a failed write would destroy the only copy of a 40-character secret
       that was never saved — and the field is a type=password the person just
       typed into, so leaving it is not a new exposure, it is the retry. */
    if (tokenKept) field.value = "";
  }

  renderSyncForm();
  const moved = before !== after;

  /* Honesty over reassurance (v9). state.js now reports whether the bytes
     actually landed, so a device that cannot keep them — Private Browsing, a
     full quota, a locked-down webview — is told so instead of being told
     "saved". Everything still works for THIS session: store.sync is set in
     memory either way, which is why the caller is told the source moved. */
  if (!saved.ok || !tokenKept) {
    toast("Couldn't store settings on this device — check Safari privacy settings");
    return moved;
  }

  toast(isConfigured()
    ? (moved ? "Now reading " + sourceLabel() : "Sync settings saved")
    : "Sync settings cleared — reading from this site");
  return moved;
}

export function clearTokenField() {
  clearToken();
  const field = $("s-token");
  if (field) field.value = "";
  renderSyncForm();
  toast("Token cleared from this device");
}

export function signOut() {
  if (!window.confirm("Sign out of GitHub on this device? The owner, repository " +
    "and token are cleared; trips go back to being read from this site.")) return false;
  signOutGitHub();
  const field = $("s-token");
  if (field) field.value = "";
  renderSyncForm();
  toast("Signed out of GitHub");
  return true;
}

/* One GET of data/trips/index.json from the SAVED settings — so the button
   saves first, then tests what it saved. */
export async function runConnectionTest() {
  const btn = $("btnTestSync");
  if (btn) { btn.disabled = true; btn.textContent = "Testing…"; }
  try {
    saveSyncForm();
    const res = await testConnection();
    toast(testMessage(res));
    return res;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Test connection"; }
  }
}

/* Exported for the sake of being readable in one place; the codes come from
   api.js's taxonomy. 404 gets the long answer because it is the ambiguous one:
   GitHub returns it for a private repo read without a token rather than admit
   the repo exists at all. */
export function testMessage(res) {
  if (!res) return "Could not test that connection";
  if (res.ok) {
    return "Connected · " + res.trips + (res.trips === 1 ? " trip" : " trips") +
      " in " + sourceLabel() + (res.keyless ? " (keyless)" : "");
  }
  switch (res.code) {
    case "unconfigured":  return "Fill in an owner and repository first";
    case "unauthorized":  return "GitHub refused that token — check it and save again";
    case "forbidden":     return "That token has no access to " + sourceLabel();
    case "rate-limited":  return "GitHub rate limit reached — try again shortly";
    case "not-found":     return "No data/trips/index.json in " + sourceLabel() +
                                 " — check the names, or add a token if it is private";
    case "bad-json":      return "Found the file, but it is not valid JSON";
    case "too-large":     return "That index file is too large to read this way";
    case "offline":       return "Could not reach GitHub — check the connection";
    default:              return "Could not reach " + sourceLabel();
  }
}
