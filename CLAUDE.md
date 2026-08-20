# CLAUDE.md — Wayfeather conventions

Read DESIGN.md before writing code; it is the spec. Current milestone: M1 (DESIGN §9).

- Vanilla JS ES modules, no framework, no build step. App is served statically from /app.
- Mobile-first: design at 380px, test in iOS Safari *standalone* mode (installed PWA), not just the tab.
- UI: redesign in progress — clean and modern, no transit/novelty theming (the v0 MTA system is
  retired; reference copy at private/reference/v0-nyc-2026.html). Day colors/labels come from trip
  data, never constants.
- Data schema is DESIGN §3 and is authoritative. Trip files live in data/trips/; bump `schema` on breaking changes.
- This repo is PUBLIC. Committed data/trips/ holds fictional test fixtures only; real trips live in
  gitignored private/trips/. Never commit real itineraries, confirmation codes, stay addresses, or tokens.
- All GitHub reads/writes go through the Contents API with the user-supplied PAT (localStorage).
  NEVER commit a token, never hardcode owner/repo — both are Settings values.
- app/candidates/ holds competing UI redesign candidates (test data embedded only); don't delete
  the losing candidates without asking.
- archive/ is frozen; don't read or modify it.
- Tests: Vitest, pure functions only (hours parser, slugs, URL builders, solver). No UI test harness.
- Commit style: `feat:`/`fix:`/`data:` prefixes; data commits from the app itself use `add:`/`edit:` + place + day.
