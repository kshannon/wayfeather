# CLAUDE.md — Wayfeather conventions

Read DESIGN.md before writing code; it is the spec. Current milestone: M1 (DESIGN §9).

- Vanilla JS ES modules, no framework, no build step. App is served statically from /app.
- Mobile-first: design at 380px, test in iOS Safari *standalone* mode (installed PWA), not just the tab.
- UI: Soft Cards v3 (DESIGN §5) — clean, modern, light-only, single accent (cerulean default,
  matcha option); per-day `color` values are currently unused by the UI. No transit/novelty theming
  (v0 reference at private/reference/v0-nyc-2026.html). Day labels/dates come from trip data, never
  constants. UI copy calls places "stopovers".
- Data schema is DESIGN §3 and is authoritative; data/schema.json mirrors it — update both together.
  Trip files live in data/trips/; bump `schema` on breaking changes.
- This repo is PUBLIC. Committed data/trips/ holds fictional test fixtures only; real trips live in
  gitignored private/trips/. Never commit real itineraries, confirmation codes, stay addresses, or tokens.
- All GitHub reads/writes go through the Contents API with the user-supplied PAT (localStorage).
  NEVER commit a token, never hardcode owner/repo — both are Settings values.
- app/candidates/ holds competing UI redesign candidates (test data embedded only); don't delete
  the losing candidates without asking.
- archive/ is frozen; don't read or modify it.
- Tests: Vitest, pure functions only (hours parser, slugs, URL builders, solver). No UI test harness.
- Gotcha: JS String.replace treats `$$` in the replacement as an escape — cost values like "$$"
  silently corrupt. Use a function replacer (or concatenation) when splicing trip JSON into anything.
- Commit style: `feat:`/`fix:`/`data:` prefixes; data commits from the app itself use `add:`/`edit:` + place + day.
