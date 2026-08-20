# Wayfeather — Design Doc

*Wayfeather: a light little guide for finding your way — built for a party of two.*

**Status:** v1 design, 2026-08-19. First real trip runs Sep 3–11, 2026, which sets the deadline for M1–M2 below.

## 1. What this is

Wayfeather is a small, installable trip field guide for two people (Kyle + wife), built as a PWA that lives on both iPhones' home screens. It answers one question while you're standing on a corner: *what's next, is it open, and how do I get there* — and it lets either person add or adjust places from their phone with the change visible to the other.

It grew out of a one-off self-contained HTML page built for the NYC Sep 2026 trip (retired to gitignored `private/reference/v0-nyc-2026.html` — a functionality reference only; its visual theme is dropped). v1 generalizes that page into a multi-trip app: a menu with a **trip loader** (Connecticut 2026, NYC 2026, and whatever comes next), a **refresh** action, and an **add place** flow. Trips are pure data; the app is the reusable shell.

**Goals:** installable on iOS without the App Store; works offline for reading; two-person shared editing with no server to run; trips fully data-driven (days, colors, clusters all come from the trip file); cheap to keep alive between trips (a static site and a repo).

**Non-goals (for now):** accounts/auth beyond a shared token, real-time sync, more than a handful of users, native app anything, automated hours lookup (hours stay human-entered — an LLM must never invent them).

## 2. Architecture

Static frontend + GitHub as the database. There is no application server.

```
┌─────────────────────────────┐
│  iPhone A / iPhone B (PWA)  │
│  service worker (app shell) │
│  IndexedDB (trip cache)     │
└───────────┬─────────────────┘
            │ GitHub REST (Contents API), fine-grained PAT
            ▼
┌─────────────────────────────┐        ┌──────────────────────────┐
│  github.com/<user>/         │  CI →  │  Cloudflare Pages (app)  │
│  data repo (see privacy)    │        │  static deploy of /app   │
│  /app  /data/trips/*.json   │        └──────────────────────────┘
└─────────────────────────────┘
```

Decisions and why:

**Data privacy.** This app repo is **public**; real trip data (confirmation codes, stay addresses, daily whereabouts) is never committed to it. Real trips currently live locally in gitignored `private/trips/`, and committed `data/trips/` carries fictional test fixtures that exercise the full schema. Before M2's live sync, real data needs a Git home the Contents API can reach: either a separate **private data repo** (app repo stays public; Settings' owner/repo point at the data repo) or flipping this repo private. Leaning private data repo — decide by M2 (§11). Hosting: **Cloudflare Pages** either way (free, deploys from public or private repos).

**All data reads AND writes go through the GitHub Contents API** (`GET/PUT /repos/{owner}/{repo}/contents/data/trips/{file}`), authenticated with the PAT. One code path for both directions; no `raw.githubusercontent.com` (its ~5-minute CDN cache would make the refresh button lie). The API returns content base64-encoded with a blob `sha` — that `sha` is the optimistic-concurrency token for writes.

**Auth = one fine-grained PAT**, scoped to the repo that holds real trip data, with Contents read/write only. Each phone enters it once in Settings; it lives in `localStorage`. Threat model: whoever holds a phone holds the token — acceptable for two people; rotate the token after each trip. The PAT is never committed and never appears in the deployed bundle.

**Frontend stays vanilla** ES modules, no framework, ideally no build step (Cloudflare Pages can serve `/app` as-is). The v0 page proves the UI fits in one file; v1 just splits it into modules (`data.js`, `render.js`, `router.js`, `solver.js`, `sw.js`). If a build step ever earns its keep, Vite — but don't start there.

## 3. Data model

Trip data lives under `data/trips/` in whichever repo holds it — test fixtures in this one, real trips in gitignored `private/trips/` until the data-home decision in §2. Git supplies history, backup, blame, and a conflict audit trail for free.

`data/trips/index.json` — the trip loader's source of truth:

```json
{
  "schema": 1,
  "updated": "2026-08-19",
  "trips": [
    { "id": "chicago-test", "name": "Chicago Test Trip",
      "dates": "Jun 4–6, 2027", "file": "chicago-test.json", "color": "#00A1DE" },
    { "id": "river-road-test", "name": "River Road Test Trip",
      "dates": "Oct 8–9, 2027", "file": "river-road-test.json", "color": "#F9461C" }
  ]
}
```

`data/trips/<id>.json` — one file per trip:

```json
{
  "schema": 1,
  "id": "chicago-test",
  "name": "Chicago Test Trip",
  "tz": "America/Chicago",
  "start": "2027-06-04", "end": "2027-06-06",
  "base": { "name": "Palmer House (test base)", "address": "17 E Monroe St, ..." },
  "notes": "free-text banner shown in the footer",
  "days": [
    { "key": "fri", "date": "2027-06-04", "bullet": "F", "label": "FRI",
      "color": "#00A1DE", "darkText": false,
      "title": "Friday · Jun 4", "subtitle": "Arrive → Loop: Art Institute → deep dish",
      "plan": "Optional longer paragraph rendered under the title on the day card." }
  ],
  "places": [
    { "id": "art-institute-of-chicago", "day": "fri", "cluster": "Arrival — Loop",
      "time": "3:45 PM", "name": "Art Institute of Chicago", "type": "Art",
      "address": "111 S Michigan Ave, Chicago, IL 60603",
      "lat": null, "lng": null,
      "hours": "Thu–Mon 11–5; CLOSED Tue/Wed", "cost": "$32",
      "priority": "must",
      "notes": "The lions.",
      "website": "https://www.artic.edu/", "yelp": "", "gmaps": "",
      "warn": "", "visited": null, "skipped": null, "updatedAt": "2026-08-19" }
  ]
}
```

Conventions: `id` is a stable slug, never regenerated on edit. `priority` is an enum — `fixed` (booked/immovable), `must`, `yes`, `maybe`, `maybe-not`, `if-close`, `optional`, `check` (call ahead), `skip`, `note` (renders as a text row, no links). `day` must match a `days[].key`; the special key `bonus` (or any day with `date: null`) renders as an unscheduled section. A reserved cluster name **`Inbox`** holds quick-captured places that haven't been slotted yet (see §6). `lat`/`lng` are nullable; the app works without them (links fall back to address queries) but the solver needs them. Link fields are optional — the renderer already synthesizes Yelp search, Google Maps, Apple Maps, and Google search URLs from name + address, exactly as v0 does (locality derived from `base.address`, never hardcoded). `visited` and `skipped` are nullable ISO timestamps set by the Did it! / Skip it buttons (additive to schema 1; absent means null). A place is *handled* when either is set; `visited` wins for display. The machine-readable version of this section is `data/schema.json` — update both together.

Schema changes bump `schema` and the app refuses versions it doesn't know, with a "pull latest app" message.

## 4. Sync, refresh, and conflicts

**Read path:** on app open (and on trip switch), `GET` the trip file via the API with `cache: "no-store"`, render, and write the payload + blob `sha` + timestamp into IndexedDB. If the network fails, render from IndexedDB and show a stale banner ("offline · data from 3h ago"). The **refresh button (↻ in the header)** re-runs exactly this and surfaces the short `sha` + "updated just now" so you can *see* that you got your wife's edit.

**Write path:** every mutation is read-modify-write of the whole trip file: take the cached `sha`, apply the change to the in-memory doc, `PUT` with `{ message, content(base64), sha }`. On a `409`/`422` (someone else wrote first), re-`GET`, re-apply the same mutation to the fresh doc, retry once, then surface an error. Mutations are small and per-place, so this "rebase" is a merge in name only — it just reapplies one place edit. Commit messages are generated (`add: Los Tacos No.1 (thu)`, `edit: hours — Frick`), which makes `git log` a legible trip changelog.

**Offline writes:** v1 disables the save button offline (visible, disabled, "you're offline"). v1.1 adds a simple queue in IndexedDB that flushes on next open — iOS has no Background Sync API, so flushing on foreground is the honest design.

## 5. UI

**Direction (updated 2026-08-20, v4 avian pass): Soft Cards, light mode only, one theme.** Warm consumer-app aesthetic — cream ground, rounded cards with soft shadows, `-apple-system` stack. **Single palette, "avian matcha"**: mossy matcha green as the one accent ("a strong mossy" — keep it strong), warm brown as the secondary for glyphs and times, and a warm cream ground carrying a *very faint* monotone wallpaper pattern — small bird silhouettes with dashed flight loops, original artwork drawn as an inline SVG tile, sparse and low-contrast; cards sit opaque on top so text contrast never depends on it. The cerulean option and the accent picker are removed. The `color` field stays in trip data but the UI ignores it. Buttons are rounded rectangles, not pills; forward carats (▸) are drawn as a tiny flying-bird glyph; confetti particles are feather-shaped. Candidates v1–v3 are frozen references; the avian pass lands on the modular `/app` (M1).

**App icon (decided 2026-08-20):** a small bird standing on top of a piece of vintage luggage — a classic hard-shell suitcase — drawn in an old-illustration style (engraved / field-guide / travel-poster lineage, pick what reads best at 60px), in the avian-matcha palette on cream. Full-bleed square master SVG; iOS masks its own corners. No lettering.

**Avian voice (light touch — theming must aid meaning, never cosplay):** a place is a **stopover**; the base is the **Nest** (birdhouse icon, still the Apple Maps link); **Did it! → "Landed!"**; **Skip it → "Flew past"** (undo unchanged). Everything else stays plain English — wherever bird voice would read cute over clear, plain labels win.

**App chrome — bottom tab bar** (dissolves the old menu sheet): **Itinerary · Map · Trips · Settings**.

- *Itinerary* — the day view. Segmented day strip at top: adjoined blocks (not pills), large press areas, one finger-sweep spans the trip, completed days greyed (complete = every actionable stopover handled, or the date has passed). Pull-to-refresh (slide down + release) with "updated just now" (+ short sha once the API path exists); the header **Nest** line (birdhouse icon) deep-links to Apple Maps. The day card shows bullet + title, the one-line `subtitle`, an optional longer **`plan`** paragraph (new optional day field, §3), and "N stopovers".
- *Map* — the schematic route view as a resident tab: the current day as a node line with direction arrows; docked bottom card shows the next unhandled stopover with ◀ ▶ cycling; tapping a node jumps the card; Did it!/Skip it work from the dock. "Route"/"Walk it" buttons jump here. Geographic tiles (Leaflet + coordinates) stay on the roadmap.
- *Trips* — the loader: trips from `index.json` grouped past/upcoming, with generous air between trip cards; picking one switches the itinerary + map scene.
- *Settings* — reset local changes; M2 adds PAT + repo owner/name, clear cache, About.

Stopover cards:

- **Time** — larger, top-left. `fixed` stopovers show a small reservation glyph beside the time (mandatory-to-be-there); other times read as planned, not binding.
- **Chips** — only **★ Must** and a quiet **Maybe** (collapses `maybe`/`maybe-not`/`if-close`/`optional`). Booked-ness is carried by the reservation glyph; `yes` is unmarked; `check` renders the ⚠ Call ahead line; `skip`/`note` stay row states. Schema enum unchanged.
- **Landed! / Flew past** (the did-it / skip-it pair) — rounded-rect buttons; one-tap undo on both. Landed! fires a brief feather-confetti burst (suppressed under reduced-motion) and settles into "Landed · 3:12 PM"; Flew past recesses the card flat grey.
- **Move to…** — a card action moves a stopover to any other day, or back to XTRA. **XTRA always exists**: if a trip file has no bonus day, the UI synthesizes one.
- **Clusters** — free text, daypart-led by convention: **Morning / Afternoon / Evening / Twilight**, optionally "— area" (fixtures follow this; the edit sheet's cluster datalist seeds the four dayparts). **Route ▸** on the day card maps the whole day; **Walk it ▸** on a cluster maps just that stretch (with a Whole-day escape).
- **Link tiles** — Site/Yelp/Google/Apple/Search as tidy rounded-rect icon tiles, generous targets, consistent stroke icons.

List tail, per day: **＋ Add another stopover** (manual add sheet) and **✦ Find me something** — lists the trip's unhandled extras (the XTRA pool); choosing one stamps it with the current time, moves it into today, and slots it chronologically into the stack (adopting the neighboring cluster). Locally this edits the overlay; from M2 the same action is a Contents-API write (§4).

**Editing** — tapping a card opens an edit sheet (name, time, day, cluster, hours, cost, notes, priority); add uses the same sheet blank; delete stays soft (`skip` first). Until M2 these write to a local overlay (`localStorage`) shaped like the future git write path.

Machine-readable schema: **`data/schema.json`** mirrors §3 so an LLM can be handed the schema plus a fixture as the template for generating a new itinerary. Keep them in lockstep.

**iOS-native feel (added 2026-08-20 — an evolution of Soft Cards, not a replacement).** Keep the Soft Cards identity — the warm off-white ground, rounded soft-shadow cards, the single cerulean/matcha accent, the friendly weight — and give it native iOS bones: large-title header that condenses on scroll; inset grouped card sections; a translucent tab bar (backdrop blur + hairline top border) with SF-Symbols-like stroke icons; the iOS type scale (34 large title / 17 body / 15 subhead / 13 footnote / 11 caption); sheets that slide up with a grabber and rounded top corners; segmented, adjoined day blocks; 44pt minimum rows; no tap-highlight flash. Installed on a home screen it should pass for native at a glance — but recognizably *our* app, not a system-app clone.

**M1 form (the "proper PWA" refactor).** The winning candidate stops being one big file and becomes the real app at `/app`: `index.html` + ES modules (`js/main.js`, `data.js`, `render.js`, `router.js`, `state.js`, …) + `css/` + `manifest.webmanifest` (standalone, light theme color, the luggage-bird icon — §5) + `apple-touch-icon` + `sw.js` precaching the shell. Data loading: same-origin static fetch of `/data/trips/*.json` with `cache: "no-store"` by default (the public app repo ships its own test data, and any static host serves it); the Contents API + PAT path (§2, §4) activates when Settings are configured in M2. Offline: shell from the service worker cache, last-good trip data + fetch timestamp from IndexedDB, stale banner when offline. Candidates stay in `app/candidates/` for reference.

Switching trips (Trips tab) re-renders the whole scene from the new trip file; `?trip=nyc-2026` in the URL (or `location.hash`) makes the state shareable and survives relaunch. The auto-open-today behavior from v0 generalizes: if today ∈ [start, end], open today's day tab.

PWA shell: `manifest.webmanifest` (`display: standalone`, light theme color matching the app ground, 180/192/512 icons — an MTA-style bullet with a "W" is the obvious icon), `apple-touch-icon`, and a service worker that precaches the app shell (cache-first for `/app/*`, network-only for API calls). Note iOS specifics: an installed web app has its own storage silo separate from the Safari tab, so enter the PAT *after* installing; and there's no Web Push needed here so we skip it.

## 6. Adding places (the "better way")

Design principle: **capture fast, organize later.** Standing in a store your wife just texted you about, you should be able to save it in 10 seconds; slotting it into a day is a couch job.

The Add sheet has two speeds:

1. **Quick capture** — one field. Type a name and hit save: it lands in the trip's `Inbox` cluster with just a name and `updatedAt`. Or paste a **Google Maps share link**: the app parses `/maps/place/<name>/@lat,lng` and `?q=` variants and pre-fills name + coordinates + (often) address. A "paste from clipboard" button covers the iOS flow, because **iOS Safari does not support the Web Share Target API** — you cannot share *into* a PWA from the Maps app, so don't chase that; paste-a-link is the ceiling on iPhone.
2. **Full form** — name, then an address search field backed by **Nominatim** (OpenStreetMap geocoding: free, no key; debounce to respect their 1 req/sec policy and send a descriptive `User-Agent`). Picking a result fills `address`/`lat`/`lng`. Remaining fields: day (defaults to Inbox), cluster (datalist of existing clusters), time, hours, cost, priority, notes, website, yelp.

Hours remain manually entered. The legit automation is the Google Places Details API (the monthly free credit covers personal use) — that's a v2 "fetch hours" button, never an LLM guess. Editing an existing place reuses the same sheet; delete is a soft `priority: "skip"` first, hard delete from the edit sheet.

A tiny backfill task for Claude Code: geocode the ~75 existing places' `lat`/`lng` once via a Node script against Nominatim (1 rps, cache results, commit the updated JSON) so the solver has coordinates on day one.

## 7. Route solver (v1.1)

Per-day ordering is a small **TSP with time windows**: n ≤ ~13 stops, fixed anchors (`priority: "fixed"`) pinned to their times, every other stop constrained by parsed open/close windows.

Distance model: walking in Manhattan is **taxicab, not crow-flies**, and the grid is rotated ~29° east of true north — so project lat/lng to meters, rotate by the grid angle, then take L1 distance. Walking speed 80 m/min plus a per-stop dwell (default 20 min, overridable per place). Outside Manhattan (CT trip), fall back to haversine × 1.3 and treat drive legs as fixed.

Algorithm: nearest-neighbor seed from the day's first anchor, then 2-opt with a feasibility check (a swap is rejected if it lands any stop outside its window or breaks an anchor). At n=13 this is microseconds; if you ever feel fancy, exact Held-Karp DP over (subset, last-stop) with earliest-arrival times is still trivial at this size. Output: suggested times per stop + total walk minutes, rendered as a "proposed" overlay you accept or dismiss — the solver **suggests, the human commits**, and accepting writes new `time` values through the normal write path. Hours strings need a small parser (`"Mon–Sat 10–6"`, `"Daily 12–8"`, `"Closed Tue; other days 10:30–5:30"` → per-weekday minute ranges); keep it as a pure function with tests, it's the only genuinely fiddly code in the app.

## 8. LLM layer (v2)

A ~20-line Cloudflare Worker holds the Anthropic API key server-side (the key never ships to the client; the Worker checks a shared secret header). Jobs where an LLM actually earns its keep: assigning Inbox items to a day/cluster given the existing geography and the person's stated priority; sanity-checking a day ("Fountain Pen Hospital closes at 5 — move it before the bookshop"); drafting the one-line notes in the house voice. Jobs it must never do: invent hours, invent coordinates, or override the solver's window feasibility. Contract: Worker receives the trip JSON + an instruction, returns a JSON Patch-style list of proposed place edits, app renders them as suggestions to accept per-item.

## 9. Milestones

**M0 — repo live (now).** This zip becomes the repo; Cloudflare Pages serves `/app`; both phones can open the v0 page. *Done when: URL loads on both phones.*

**M1 — multi-trip shell (target Aug 26).** Refactor soft-cards-v3 into the modular `/app` PWA (§5 "M1 form") with the iOS-native styling pass; Trips tab reading `index.json` via same-origin static fetch (Contents API once Settings exist); pull-to-refresh with sha/timestamp; manifest + service worker + icons; installed on both phones; offline read from IndexedDB. *Done when: both trips switchable and readable offline on both installed apps.*

**M2 — editing (target Sep 1, hard deadline Sep 2).** Settings/PAT entry; Add sheet with quick capture, Maps-link paste, Nominatim search; edit + soft delete; optimistic-concurrency writes with the retry described in §4; geocode backfill script run once. *Done when: a place added on one phone appears on the other after ↻.*

**M3 — solver (stretch, or during the trip's train rides).** Hours parser + tests; taxicab TSPTW; proposed-times overlay. **M4 — post-trip:** offline write queue, Worker + LLM suggestions, Places-API hours button, trip archive view.

If time runs out, M1+M2 alone is a fully useful app for this trip; v0 remains the fallback.

## 10. Working in Claude Code

Open the repo and start with: *"Read DESIGN.md and CLAUDE.md, then start M1."* Suggested first PRs: (1) split `app/index.html` into modules with zero visual change, (2) data layer (`api.js`: get/put contents, sha handling, IndexedDB cache), (3) menu + trip loader, (4) SW + manifest. Keep `app/index.html` (v0) untouched until M1 renders both trips identically, then delete it in the same PR that proves parity. Testing stays light: Vitest on the pure functions only — hours parser, slug/id, URL builders, solver. Everything UI gets tested the honest way, on an iPhone in standalone mode.

## 11. Open questions

Whether to keep `bonus`-style extras as a pseudo-day or promote to a first-class "anytime" list; whether the CT trip should get drive-time legs as data (probably yes, as `type: "Drive"` places — already done in the converted file); icon design (decided: bird atop vintage luggage — §5); PAT UX for the wife's phone (simplest: AirDrop the token once).
