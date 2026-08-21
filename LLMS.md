# LLMS.md — playbook for AI assistants working with Wayfeather

You are (probably) an LLM asked to do a task for Wayfeather — a two-person trip
field-guide PWA whose database is JSON in a Git repo. This file is the how-to for
common tasks. The companion files are authoritative for what they cover:

- **data/schema.json** — the data format (machine-readable; tracks DESIGN §3).
- **DESIGN.md** — the spec: architecture, sync model, UI, milestones.
- **CLAUDE.md** — repo conventions for coding sessions.

## Ground rules (non-negotiable)

1. **Never invent facts.** Opening hours, addresses, coordinates, phone numbers,
   and confirmation details are verified or absent. If you cannot verify hours,
   set `"hours": ""`, `"callAhead": true`, and add a `warn` like
   `"Hours unverified — call ahead"`. An invented opening time can strand two
   people outside a closed shop; an honest blank cannot.
2. **This repo is public.** Never write real itineraries, confirmation codes,
   stay addresses, or tokens into anything that gets committed here. Real trip
   data lives in gitignored `private/` (or the private data repo — DESIGN §2).
   Committed `data/trips/` holds fictional test fixtures only.
3. **Stable ids.** A place's `id` is a kebab-case slug, unique within its trip,
   created once and never regenerated on edit.
4. **Schema discipline.** Validate anything you produce against
   `data/schema.json`. Additive optional fields are fine within `schema: 1`;
   breaking changes bump `schema` and update schema.json + DESIGN §3 together.
5. **The `$$` gotcha.** JavaScript `String.replace` treats `$$` in the
   replacement as an escape — a `"cost": "$$"` silently corrupts. Splice JSON
   with a function replacer or concatenation, then verify byte-identity.
6. **Commit style.** Data commits: `add:`/`edit:` + place + day
   (`add: Big Star (sat)`). Code/docs commits: `feat:`/`fix:`/`data:` prefixes.

## Create a stopover (place card) from a name, link, or request

1. **Gather**: official website, street address. If you have web access, verify
   hours from the official site (or its Google Business listing) only — record
   them as human-readable text (`"Mon–Sat 10–6"`, `"Closed Tue; other days
   10:30–5:30"`), matching the formats already in the data. Unverifiable →
   ground rule 1.
2. **Build** the object with every key from `schema.json`'s place definition.
   Leave `lat`/`lng` null (the geocode script fills them — never you).
   `website`/`yelp`/`gmaps` may be `""`; the app synthesizes links from
   name + address.
3. **Slot it**: `day` = an existing `days[].key`, or `"bonus"` for the XTRA
   pool. `cluster` = daypart convention (`Morning / Afternoon / Evening /
   Twilight`, optionally `"— area"`), or `"Inbox"` for an unsorted quick
   capture. Insert the object chronologically within its day.
4. **Stamp** `updatedAt` with today's date; set `visited`/`skipped` to null.
5. **Check**: the file parses, the id is unique, `day` matches a real key.

A Google Maps share link (`/maps/place/<name>/@lat,lng` or `?q=`) may be parsed
for name, coordinates, and address — that is extraction, not invention, so
coordinates from the link are allowed.

## Convert a CSV (or a pile of links) into a trip

The historical shape (see `archive/NY_2026_plan_updated.csv`) is
`confirm,Day,Time,Activity,Address,Hours,Cost,Comments` — map columns to fields:

- `Day` → parse into `days[]` entries (one per distinct date: stable `key`,
  ISO `date`, `title`, one-line `subtitle`; add a `bonus` day).
- Each row → one place: `Activity`→`name`, `Address`→`address`, `Time`→`time`,
  `Hours`→`hours`, `Cost`→`cost`, `Comments`→`notes`.
- **Strip confirmation codes and private addresses** from anything destined for
  a public commit; codes stay only in `private/` copies.
- Infer `type` and `priority` conservatively (`yes` when unstated; `fixed` only
  for genuinely booked things).
- Finish with an `index.json` entry (`id`, `name`, `dates`, `file`, `color`).

## Create a new trip

Copy a fixture's shape (`data/trips/chicago-test.json` is the reference).
Required top level: `schema`, `id`, `name`, `tz`, `start`, `end`, `days`,
`places` (plus `base` and `notes` in practice). Include an XTRA/`bonus` day —
the UI synthesizes one if missing, but data is better explicit. Register the
trip in `index.json`. Real trips go in `private/trips/`, never committed here.

## First: get the evidence (Settings › About)

Every field report should start with a screenshot of the diagnostics block at
the bottom of Settings. Six rows, and they answer most questions before anyone
starts guessing:

- **Build** — which shell is running (`BUILD` in `app/js/version.js`).
- **Display mode** — `standalone (installed)` vs `browser tab`. The installed
  app has its OWN storage silo: a token entered in the Safari tab is genuinely
  absent from the installed app, which is not the same bug as a token that
  failed to save.
- **Service worker** — the version the controlling worker reports. `does not
  match this page` means a half-swapped shell; a cold start fixes it.
- **Storage** — `failing` means localStorage is refusing writes (Private
  Browsing, full quota). Settings genuinely cannot be saved on that device.
- **Offline store** — IndexedDB; `unavailable` means no offline trip data.
- **Data source** — the configured `owner/repo`, or `this site`. Never the token.

## App stuck on a phone / won't update

The installed PWA's shell is served by a service worker from a versioned cache.
The swap between versions is **atomic** — a new `sw.js` installs into a whole
new cache and activates all of it or none of it — so a phone is either fully on
the old build or fully on the new one. Escalate in order:

1. **Pull-to-refresh** — refreshes *data* only, not the app shell.
2. **Fully close the app and reopen, twice.** A deployed update installs in the
   background on the first launch and activates on the next cold start. If the
   app shows "Update ready — close Wayfeather and reopen it", this is exactly
   the step it is asking for.
3. Still stale → the deploy probably didn't bump the cache version: any change
   to app files must bump `VERSION` in `app/sw.js` **and** `BUILD` in
   `app/js/version.js`, in lockstep, or clients keep the old shell forever.
   `tests/build.test.js` fails if the two disagree. There is no background
   revalidation to paper over a missed bump — see the next section for why.
4. Truly wedged → iOS Settings → Safari → Advanced → Website Data → delete the
   site's data, then relaunch (last resort: remove the icon and re-add to Home
   Screen from Safari). Note: an installed app has its own storage silo —
   clearing/reinstalling wipes its localStorage/IndexedDB, so local overlay
   state and (post-M2) the PAT must be re-entered.

## App won't load at all / "it lost my token"

If the app shows **"Wayfeather could not start"**, the module graph failed to
load and `js/main.js` never ran. Reload first (a navigation is what makes the
browser re-check `sw.js`), then close and reopen. Nothing on the device has
been lost — the panel exists precisely because the alternative was worse:
without it, a failed boot left the *static* Settings markup on screen with
empty owner, repo and token fields, and that reads as "the app deleted my
credentials" when localStorage still holds all three.

**Never reintroduce cache revalidation in `app/sw.js`.** v7/v8 re-fetched shell
assets in the background and wrote them into the *live* cache one file at a
time. During a deploy that produced a cache holding two builds at once, and a
mixed ES module graph does not degrade — it fails to evaluate, on every launch,
forever. `tests/shell.test.js` fails on any `cache.put()` in that file. Shell
staleness is handled instead by `js/shell.js`, which calls
`registration.update()` once per launch and lets the browser do the atomic swap.

## Edit trip data through the API (M2+)

Read-modify-write, whole file: `GET` the file via the GitHub Contents API
(returns base64 content + blob `sha`) → apply one change in memory → `PUT` with
`{message, content, sha}`. On `409`/`422` someone else wrote first: re-`GET`,
re-apply, retry once, then surface the error. Never `PUT` without a fresh
`sha`. The PAT is scoped to the data repo, lives only on the phones, and gets
rotated after each trip.

## Suggesting itinerary changes

You may propose ordering, day assignment, and pacing — as suggestions the human
accepts item by item. You never override opening-hours feasibility (the solver
owns that, DESIGN §7), and never mark things visited/skipped on a person's
behalf.
