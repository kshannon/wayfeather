# Wayfeather

A two-person trip field guide: an installable PWA (iOS home screen, offline-capable)
with a Git repo as the database. Trips are data; the app is the shell.

*A light little guide for finding your way.*

- **DESIGN.md** — read this first; it is the spec (architecture, schema, milestones).
- **CLAUDE.md** — working conventions for Claude Code sessions.
- **app/** — the app shell. UI redesign in progress: competing candidates live in `app/candidates/`. The retired v0 page (it embeds a real itinerary) lives in gitignored `private/reference/`.
- **data/trips/** — `index.json` (trip loader) + one JSON per trip. **Fictional test fixtures only** (`chicago-test`, `river-road-test`).
- **private/**, **archive/** — real trip data and source spreadsheets. Gitignored, never committed.

This repo is **public**: no real itineraries, confirmation codes, stay addresses, or tokens
are ever committed. Real trips live in `private/` locally; their eventual synced home is the
open data-repo decision in DESIGN §2.

Status: M0 (repo live). Next: M1 (multi-trip shell) — see DESIGN.md §9.
