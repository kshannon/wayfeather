import { defineConfig } from "vitest/config";

/* Vitest is a devDependency only — nothing here touches the app, which stays
   build-free vanilla ES modules served straight out of /app (DESIGN §10).
   The tests import app/js/*.js by relative path; there is no transform,
   no alias, and no bundling step involved. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    /* Pin the host timezone. Several time.js paths fall back to the machine's
       local clock (localISO, and fmtClock/todayIn when no tz is supplied), so
       an unpinned TZ makes those assertions machine-dependent. UTC keeps the
       suite identical on a laptop and in CI. */
    env: { TZ: "UTC" }
  }
});
