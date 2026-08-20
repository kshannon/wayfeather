/* trip.test.js — ordering, clusters, completeness, XTRA synthesis, slugs
   (DESIGN §10). Everything here is a pure function over a plain trip object.

   Named, narrow imports on purpose: trip.js is a module other work appends to,
   and a named import is immune to exports added beside it. Do not `import * as`
   and assert on the export list. */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  PRIOS, CHIP,
  withExtras, tripToday, placeById, dayByKey, isNote,
  orderDay, placesOfDay, actionableOfDay,
  clustersOf, allClusters,
  stateOf, isVisited, isSkipped, isHandled, dayComplete,
  findPool, countText, initialDayKey,
  neighbourCluster, clusterForSlot, clusterOnMove,
  slugify, uniqueId, eyebrowText
} from "../app/js/trip.js";

/* trip.js → time.js → todayIn() reaches for `window.Intl`. See the long note in
   tests/time.test.js: this is a test-environment shim, not a module edit, and
   without it every tz-aware assertion below would silently answer from the
   host clock instead of the trip's timezone. */
beforeAll(() => { globalThis.window = globalThis; });
afterAll(() => { delete globalThis.window; });

afterEach(() => { vi.useRealTimers(); });

/* Inject "now". Nothing in this file may read the wall clock. */
const at = (iso) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

const load = (f) =>
  JSON.parse(readFileSync(new URL("../data/trips/" + f, import.meta.url), "utf8"));

const CHICAGO = load("chicago-test.json");      // has a bonus (date:null) day
const RIVER = load("river-road-test.json");     // has none — XTRA must be synthesized

/* Minimal trip builder; `days` and `places` are partials merged over defaults. */
const place = (o) => ({
  id: "p", day: "d1", cluster: "C", time: "", name: "P", type: "", address: "",
  lat: null, lng: null, hours: "", cost: "", priority: "yes", notes: "",
  website: "", yelp: "", gmaps: "", warn: "", updatedAt: "2026-08-19", ...o
});
const day = (o) => ({
  key: "d1", date: "2027-06-04", bullet: "D", label: "D1", color: "#000000",
  title: "T", subtitle: "S", ...o
});
const trip = (o) => ({
  schema: 1, id: "t", name: "T", tz: "America/Chicago",
  start: "2027-06-04", end: "2027-06-06",
  base: { name: "B", address: "1 A St, Chicago, IL 60603" },
  days: [day()], places: [], ...o
});

describe("XTRA synthesis — the bonus-day guarantee (DESIGN §5)", () => {
  it("synthesizes a bonus day for a trip that ships none (river-road-test is the real case)", () => {
    expect(RIVER.days.some((d) => d.date === null)).toBe(false);   // premise
    const out = withExtras(RIVER.days);
    expect(out).toHaveLength(RIVER.days.length + 1);
    const extra = out[out.length - 1];
    expect(extra.date).toBeNull();
    expect(extra.key).toBe("bonus");
    expect(extra.label).toBe("XTRA");
    expect(extra.bullet).toBe("+");
    expect(extra.title).toBe("Extras");
    expect(extra.subtitle).toMatch(/unscheduled/i);
  });

  it("does NOT synthesize when the trip already has a date-null day (chicago-test)", () => {
    expect(CHICAGO.days.some((d) => d.date === null)).toBe(true);  // premise
    const out = withExtras(CHICAGO.days);
    expect(out).toHaveLength(CHICAGO.days.length);
    expect(out.map((d) => d.key)).toEqual(CHICAGO.days.map((d) => d.key));
    expect(out.filter((d) => d.date === null)).toHaveLength(1);
  });

  it("guarantees exactly one unscheduled day either way", () => {
    for (const days of [RIVER.days, CHICAGO.days]) {
      expect(withExtras(days).filter((d) => d.date === null)).toHaveLength(1);
    }
  });

  it("recognises a date-null day anywhere in the list, not just at the end", () => {
    const days = [day({ key: "bonus", date: null }), day({ key: "fri" })];
    expect(withExtras(days)).toHaveLength(2);
  });

  it("does not mutate the caller's array — the synthesized day is never written back", () => {
    const days = RIVER.days.slice();
    const before = JSON.stringify(days);
    const out = withExtras(days);
    expect(days).toHaveLength(RIVER.days.length);
    expect(JSON.stringify(days)).toBe(before);
    expect(out).not.toBe(days);
  });

  it("suffixes the synthesized key when 'bonus' is already taken by a dated day", () => {
    const days = [day({ key: "bonus", date: "2027-06-04" })];
    expect(withExtras(days)[1].key).toBe("bonus-2");
  });

  it("keeps suffixing past an existing bonus-2", () => {
    const days = [
      day({ key: "bonus", date: "2027-06-04" }),
      day({ key: "bonus-2", date: "2027-06-05" })
    ];
    expect(withExtras(days).map((d) => d.key)).toEqual(["bonus", "bonus-2", "bonus-3"]);
  });

  it("survives a missing or non-array day list", () => {
    expect(withExtras(null).map((d) => d.key)).toEqual(["bonus"]);
    expect(withExtras(undefined).map((d) => d.key)).toEqual(["bonus"]);
    expect(withExtras([]).map((d) => d.key)).toEqual(["bonus"]);
  });

  it("produces a plain day object — nothing downstream can tell it was invented", () => {
    const extra = withExtras(RIVER.days).pop();
    for (const k of ["key", "label", "title", "bullet", "date", "subtitle"]) {
      expect(extra).toHaveProperty(k);
    }
    expect(extra.synthetic).toBeUndefined();
    expect(extra.invented).toBeUndefined();
  });
});

describe("orderDay — chronological slotting", () => {
  it("sorts parsed times ascending and sinks unparseable ones to the tail in data order", () => {
    const list = [
      place({ id: "evening", time: "7:00 PM" }),
      place({ id: "open", time: "open" }),
      place({ id: "morning", time: "9:00 AM" }),
      place({ id: "blank", time: "" }),
      place({ id: "soft", time: "~2:30 PM" }),
      place({ id: "optional", time: "(optional)" })
    ];
    expect(orderDay(list).map((p) => p.id))
      .toEqual(["morning", "soft", "evening", "open", "blank", "optional"]);
  });

  it("is stable for identical times (data order breaks the tie)", () => {
    const list = [
      place({ id: "second", time: "9:00 AM" }),
      place({ id: "first", time: "8:00 AM" }),
      place({ id: "third", time: "9:00 AM" })
    ];
    expect(orderDay(list).map((p) => p.id)).toEqual(["first", "second", "third"]);
  });

  it("leaves an all-unparseable day in exactly its data order", () => {
    const list = [place({ id: "a", time: "open" }), place({ id: "b", time: "" }),
                  place({ id: "c", time: "(optional)" })];
    expect(orderDay(list).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list unchanged", () => {
    expect(orderDay([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const list = [place({ id: "b", time: "7:00 PM" }), place({ id: "a", time: "9:00 AM" })];
    orderDay(list);
    expect(list.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("orders a real fixture day and sinks its untimed note", () => {
    /* chicago-test 'sat' ends with a priority:"note" row timed "open". */
    const ids = placesOfDay(CHICAGO, "sat").map((p) => p.id);
    expect(ids[ids.length - 1]).toBe("sat-evening-open");
    expect(ids.slice(0, -1)).toEqual([
      "myopic-books", "reckless-records", "quimbys-bookstore", "big-star-tacos"
    ]);
  });
});

describe("placesOfDay / actionableOfDay", () => {
  it("selects only the requested day", () => {
    expect(placesOfDay(CHICAGO, "fri").every((p) => p.day === "fri")).toBe(true);
    expect(placesOfDay(CHICAGO, "fri")).toHaveLength(4);
    expect(placesOfDay(CHICAGO, "bonus")).toHaveLength(2);
  });

  it("returns empty for an unknown day key", () => {
    expect(placesOfDay(CHICAGO, "nope")).toEqual([]);
  });

  it("actionableOfDay drops note rows", () => {
    expect(placesOfDay(CHICAGO, "sat")).toHaveLength(5);
    expect(actionableOfDay(CHICAGO, "sat")).toHaveLength(4);
    expect(actionableOfDay(CHICAGO, "sat").some(isNote)).toBe(false);
  });

  it("isNote keys off priority only", () => {
    expect(isNote(place({ priority: "note" }))).toBe(true);
    expect(isNote(place({ priority: "skip" }))).toBe(false);
    expect(isNote(place({ priority: "yes" }))).toBe(false);
  });
});

describe("clusters — grouped by first appearance", () => {
  it("clustersOf keeps first-appearance order and dedupes", () => {
    const list = [place({ cluster: "Evening" }), place({ cluster: "Morning" }),
                  place({ cluster: "Evening" }), place({ cluster: "Morning" })];
    expect(clustersOf(list)).toEqual(["Evening", "Morning"]);
  });

  it("clustersOf preserves an empty cluster name as its own group", () => {
    /* as-implemented: clustersOf does not filter falsy, allClusters does */
    expect(clustersOf([place({ cluster: "A" }), place({ cluster: "" })]))
      .toEqual(["A", ""]);
  });

  it("allClusters walks the whole trip in first-appearance order, skipping blanks", () => {
    /* Compared against an independent reimplementation rather than a hardcoded
       list, so an edit to the fixture's cluster names cannot make this fail for
       the wrong reason — only a change in ORDERING behaviour can. */
    for (const t of [CHICAGO, RIVER]) {
      const expected = [...new Set(t.places.map((p) => p.cluster).filter(Boolean))];
      expect(allClusters(t)).toEqual(expected);
    }
  });

  it("allClusters is ordered by data position, never alphabetically", () => {
    const out = allClusters(CHICAGO);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe(CHICAGO.places[0].cluster);
    expect(out).not.toEqual([...out].sort());
  });

  it("allClusters drops empty cluster names", () => {
    const t = trip({ places: [place({ id: "a", cluster: "" }), place({ id: "b", cluster: "Real" })] });
    expect(allClusters(t)).toEqual(["Real"]);
  });

  it("groups the fixture's day clusters in data order, not alphabetically", () => {
    expect(clustersOf(placesOfDay(RIVER, "fri")))
      .toEqual(["Morning — the drive out", "Afternoon — canyons", "Evening — lodge"]);
  });
});

describe("handled state — visited wins over skipped", () => {
  it("stateOf normalizes absent fields to null", () => {
    expect(stateOf(place({}))).toEqual({ visited: null, skipped: null });
    expect(stateOf(place({ visited: "", skipped: "" }))).toEqual({ visited: null, skipped: null });
  });

  it("visited wins for display when BOTH timestamps are set (DESIGN §3)", () => {
    const both = place({ visited: "2027-06-04T18:00:00Z", skipped: "2027-06-04T19:00:00Z" });
    expect(isVisited(both)).toBe(true);
    expect(isSkipped(both)).toBe(false);      // the whole rule
    expect(isHandled(both)).toBe(true);
  });

  it("visited wins even when skipped is the later timestamp", () => {
    const both = place({ visited: "2027-06-04T09:00:00Z", skipped: "2027-06-04T23:00:00Z" });
    expect(isSkipped(both)).toBe(false);
  });

  it("reports skipped only when visited is unset", () => {
    const s = place({ skipped: "2027-06-04T19:00:00Z" });
    expect(isVisited(s)).toBe(false);
    expect(isSkipped(s)).toBe(true);
    expect(isHandled(s)).toBe(true);
  });

  it("an untouched place is neither", () => {
    const p = place({});
    expect(isVisited(p)).toBe(false);
    expect(isSkipped(p)).toBe(false);
    expect(isHandled(p)).toBe(false);
  });

  it("handled means visited OR skipped", () => {
    expect(isHandled(place({ visited: "2027-06-04T18:00:00Z" }))).toBe(true);
    expect(isHandled(place({ skipped: "2027-06-04T18:00:00Z" }))).toBe(true);
    expect(isHandled(place({ visited: null, skipped: null }))).toBe(false);
  });
});

describe("dayComplete — all handled, or the date has passed", () => {
  const visited = "2027-06-04T18:00:00Z";

  it("is complete when every actionable stopover is handled, even before the day", () => {
    at("2027-06-01T12:00:00Z");                       // trip has not started
    const t = trip({
      days: [day({ key: "fri" })],
      places: [place({ id: "a", day: "fri", visited }), place({ id: "b", day: "fri", skipped: visited })]
    });
    expect(dayComplete(t, t.days[0])).toBe(true);
  });

  it("is incomplete while any actionable stopover is unhandled", () => {
    at("2027-06-01T12:00:00Z");
    const t = trip({
      days: [day({ key: "fri" })],
      places: [place({ id: "a", day: "fri", visited }), place({ id: "b", day: "fri" })]
    });
    expect(dayComplete(t, t.days[0])).toBe(false);
  });

  it("ignores note rows when deciding — notes never count", () => {
    at("2027-06-01T12:00:00Z");
    const t = trip({
      days: [day({ key: "fri" })],
      places: [place({ id: "a", day: "fri", visited }),
               place({ id: "n", day: "fri", priority: "note" })]
    });
    expect(dayComplete(t, t.days[0])).toBe(true);
  });

  it("is complete once the date has passed, however little was handled", () => {
    at("2027-06-06T12:00:00Z");                       // two days after
    const t = trip({
      days: [day({ key: "fri", date: "2027-06-04" })],
      places: [place({ id: "a", day: "fri" }), place({ id: "b", day: "fri" })]
    });
    expect(dayComplete(t, t.days[0])).toBe(true);
  });

  it("is NOT complete on the day itself with work outstanding", () => {
    at("2027-06-04T18:00:00Z");                       // 1:00 PM in Chicago
    const t = trip({
      days: [day({ key: "fri", date: "2027-06-04" })],
      places: [place({ id: "a", day: "fri" })]
    });
    expect(dayComplete(t, t.days[0])).toBe(false);
  });

  it("uses the TRIP's timezone, not the device's, to decide the date has passed", () => {
    /* One instant, two answers. 04:30 UTC on Jun 5 is still Jun 4 in Chicago,
       so a Jun 4 day is not yet past there — but it is past in UTC. */
    at("2027-06-05T04:30:00Z");
    const days = [day({ key: "fri", date: "2027-06-04" })];
    const places = [place({ id: "a", day: "fri" })];
    expect(dayComplete(trip({ tz: "America/Chicago", days, places }), days[0])).toBe(false);
    expect(dayComplete(trip({ tz: "UTC", days, places }), days[0])).toBe(true);
  });

  it("never completes an empty day by handling (nothing to handle), only by date", () => {
    at("2027-06-01T12:00:00Z");
    const future = trip({ days: [day({ key: "fri", date: "2027-06-04" })], places: [] });
    expect(dayComplete(future, future.days[0])).toBe(false);
    at("2027-06-10T12:00:00Z");
    expect(dayComplete(future, future.days[0])).toBe(true);
  });

  it("never completes a note-only day by handling", () => {
    at("2027-06-01T12:00:00Z");
    const t = trip({
      days: [day({ key: "fri" })],
      places: [place({ id: "n", day: "fri", priority: "note" })]
    });
    expect(dayComplete(t, t.days[0])).toBe(false);
  });

  it("never completes the XTRA day by date — it has none", () => {
    at("2030-01-01T12:00:00Z");                       // long past the trip
    const t = trip({
      days: [day({ key: "bonus", date: null })],
      places: [place({ id: "a", day: "bonus" })]
    });
    expect(dayComplete(t, t.days[0])).toBe(false);
  });

  it("completes the XTRA day once every idea in it is handled", () => {
    at("2027-06-01T12:00:00Z");
    const t = trip({
      days: [day({ key: "bonus", date: null })],
      places: [place({ id: "a", day: "bonus", visited })]
    });
    expect(dayComplete(t, t.days[0])).toBe(true);
  });
});

describe("findPool — what 'Find me something' may offer", () => {
  const pool = (t) => findPool(t).map((p) => p.id);

  it("offers unhandled ideas from date-null days only", () => {
    at("2027-06-04T18:00:00Z");
    expect(pool(CHICAGO)).toEqual(["navy-pier", "intl-museum-surgical-science"]);
  });

  it("keeps priority:'skip' in the pool — resurfacing written-off ideas is the point", () => {
    const skipped = CHICAGO.places.find((p) => p.id === "intl-museum-surgical-science");
    expect(skipped.priority).toBe("skip");
    expect(pool(CHICAGO)).toContain("intl-museum-surgical-science");
  });

  it("drops handled ideas and note rows", () => {
    const t = trip({
      days: [day({ key: "bonus", date: null })],
      places: [
        place({ id: "open", day: "bonus" }),
        place({ id: "done", day: "bonus", visited: "2027-06-04T18:00:00Z" }),
        place({ id: "gone", day: "bonus", skipped: "2027-06-04T18:00:00Z" }),
        place({ id: "note", day: "bonus", priority: "note" })
      ]
    });
    expect(pool(t)).toEqual(["open"]);
  });

  it("ignores places whose day key does not exist", () => {
    const t = trip({ days: [day({ key: "bonus", date: null })],
                     places: [place({ id: "orphan", day: "ghost" })] });
    expect(pool(t)).toEqual([]);
  });

  it("is empty for a trip whose days are all dated", () => {
    expect(pool(RIVER)).toEqual([]);
  });
});

describe("countText", () => {
  it("counts stopovers on a dated day, with plural agreement", () => {
    at("2027-06-01T12:00:00Z");
    expect(countText(CHICAGO, dayByKey(CHICAGO, "fri"))).toBe("4 stopovers");
    const one = trip({ days: [day({ key: "fri" })], places: [place({ day: "fri" })] });
    expect(countText(one, one.days[0])).toBe("1 stopover");
    const none = trip({ days: [day({ key: "fri" })], places: [] });
    expect(countText(none, none.days[0])).toBe("0 stopovers");
  });

  it("counts 'ideas · unscheduled' on the XTRA day", () => {
    at("2027-06-01T12:00:00Z");
    expect(countText(CHICAGO, dayByKey(CHICAGO, "bonus"))).toBe("2 ideas · unscheduled");
    const one = trip({ days: [day({ key: "bonus", date: null })],
                       places: [place({ day: "bonus" })] });
    expect(countText(one, one.days[0])).toBe("1 idea · unscheduled");
  });

  it("appends a partial handled count", () => {
    at("2027-06-01T12:00:00Z");
    const t = trip({
      days: [day({ key: "fri" })],
      places: [place({ id: "a", day: "fri", visited: "2027-06-04T18:00:00Z" }),
               place({ id: "b", day: "fri" })]
    });
    expect(countText(t, t.days[0])).toBe("2 stopovers · 1 handled");
  });

  it("says 'all handled' when nothing actionable is left", () => {
    at("2027-06-01T12:00:00Z");
    const t = trip({
      days: [day({ key: "fri" })],
      places: [place({ id: "a", day: "fri", visited: "2027-06-04T18:00:00Z" }),
               place({ id: "b", day: "fri", skipped: "2027-06-04T18:00:00Z" })]
    });
    expect(countText(t, t.days[0])).toBe("2 stopovers · all handled");
  });

  it("counts notes in the total but never in the handled tally", () => {
    at("2027-06-01T12:00:00Z");
    const t = trip({
      days: [day({ key: "fri" })],
      places: [place({ id: "a", day: "fri", visited: "2027-06-04T18:00:00Z" }),
               place({ id: "n", day: "fri", priority: "note" })]
    });
    expect(countText(t, t.days[0])).toBe("2 stopovers · all handled");
  });
});

describe("initialDayKey — open today when today is in the trip", () => {
  it("opens today's day when today falls inside the trip", () => {
    at("2027-06-05T18:00:00Z");                 // 1:00 PM Sat in Chicago
    expect(initialDayKey(CHICAGO)).toBe("sat");
  });

  it("opens the first day before the trip starts", () => {
    at("2027-05-01T12:00:00Z");
    expect(initialDayKey(CHICAGO)).toBe("fri");
  });

  it("opens the first day after the trip ends", () => {
    at("2027-07-01T12:00:00Z");
    expect(initialDayKey(CHICAGO)).toBe("fri");
  });

  it("opens on the first and last day at the range edges", () => {
    at("2027-06-04T18:00:00Z");
    expect(initialDayKey(CHICAGO)).toBe("fri");
    at("2027-06-06T18:00:00Z");
    expect(initialDayKey(CHICAGO)).toBe("sun");
  });

  it("resolves 'today' in the trip's timezone, not the device's", () => {
    /* 04:30 UTC Jun 5 = still Jun 4 (Friday) in Chicago */
    at("2027-06-05T04:30:00Z");
    expect(initialDayKey(CHICAGO)).toBe("fri");
    expect(initialDayKey({ ...CHICAGO, tz: "UTC" })).toBe("sat");
  });

  it("falls back to the first day when today is in range but has no matching day", () => {
    at("2027-06-05T18:00:00Z");
    const t = trip({ start: "2027-06-04", end: "2027-06-06",
                     days: [day({ key: "fri", date: "2027-06-04" })] });
    expect(initialDayKey(t)).toBe("fri");
  });
});

describe("eyebrowText — where the trip sits relative to today", () => {
  it("counts the day within the trip", () => {
    at("2027-06-04T18:00:00Z");
    expect(eyebrowText(CHICAGO)).toBe("Day 1 of 3");
    at("2027-06-06T18:00:00Z");
    expect(eyebrowText(CHICAGO)).toBe("Day 3 of 3");
  });

  it("excludes the undated XTRA day from the denominator", () => {
    at("2027-06-05T18:00:00Z");
    expect(CHICAGO.days).toHaveLength(4);       // three dated + bonus
    expect(eyebrowText(CHICAGO)).toBe("Day 2 of 3");
  });

  it("says 'Past trip' after the end date", () => {
    at("2027-06-07T18:00:00Z");
    expect(eyebrowText(CHICAGO)).toBe("Past trip");
  });

  it("says 'Tomorrow' on the eve", () => {
    at("2027-06-03T18:00:00Z");
    expect(eyebrowText(CHICAGO)).toBe("Tomorrow");
  });

  it("counts down inside sixty days", () => {
    at("2027-06-01T18:00:00Z");
    expect(eyebrowText(CHICAGO)).toBe("In 3 days");
    at("2027-05-05T18:00:00Z");
    expect(eyebrowText(CHICAGO)).toBe("In 30 days");
  });

  it("switches to a month label beyond sixty days", () => {
    at("2027-01-05T18:00:00Z");
    expect(eyebrowText(CHICAGO)).toBe("Upcoming · Jun 2027");
  });

  it("falls back to 'Field guide' for a trip with no start date", () => {
    at("2027-06-04T18:00:00Z");
    expect(eyebrowText(trip({ start: "", end: "", days: [day()] }))).toBe("Field guide");
  });
});

describe("neighbourCluster / clusterForSlot / clusterOnMove", () => {
  const t = trip({
    days: [day({ key: "fri" }), day({ key: "bonus", date: null })],
    places: [
      place({ id: "a", day: "fri", time: "9:00 AM", cluster: "Morning" }),
      place({ id: "b", day: "fri", time: "1:00 PM", cluster: "Afternoon" }),
      place({ id: "c", day: "fri", time: "open", cluster: "Untimed" })
    ]
  });

  it("takes the cluster of the chronologically previous stopover", () => {
    expect(neighbourCluster(t, "fri", 10 * 60)).toBe("Morning");
    expect(neighbourCluster(t, "fri", 14 * 60)).toBe("Afternoon");
  });

  it("falls forward to the next stopover when nothing precedes", () => {
    expect(neighbourCluster(t, "fri", 8 * 60)).toBe("Morning");
  });

  it("treats an exactly-equal time as 'previous'", () => {
    expect(neighbourCluster(t, "fri", 13 * 60)).toBe("Afternoon");
  });

  it("ignores untimed stopovers as neighbours", () => {
    const untimed = trip({ days: [day({ key: "fri" })],
                           places: [place({ id: "c", day: "fri", time: "open", cluster: "Untimed" })] });
    expect(neighbourCluster(untimed, "fri", 12 * 60)).toBeNull();
  });

  it("returns null for a day with nothing to sit beside", () => {
    expect(neighbourCluster(t, "bonus", 12 * 60)).toBeNull();
    expect(neighbourCluster(t, "ghost", 12 * 60)).toBeNull();
  });

  it("clusterForSlot prefers the neighbour, then the fallback, then Inbox", () => {
    expect(clusterForSlot(t, "fri", 10 * 60, "Given")).toBe("Morning");
    expect(clusterForSlot(t, "bonus", 12 * 60, "Given")).toBe("Given");
    expect(clusterForSlot(t, "bonus", 12 * 60, "")).toBe("Inbox");
    expect(clusterForSlot(t, "bonus", 12 * 60)).toBe("Inbox");
  });

  it("clusterOnMove adopts the neighbour's cluster when the move carries a time", () => {
    expect(clusterOnMove(t, "fri", 10 * 60, "Afternoon — canyons")).toBe("Morning");
  });

  it("clusterOnMove never lets a stopover carry a daypart into the XTRA pool", () => {
    /* moving into XTRA must not inherit an opinion like "Probably skip" */
    expect(clusterOnMove(t, "bonus", 12 * 60, "Afternoon — canyons")).toBe("Ideas");
    expect(clusterOnMove(t, "bonus", null, "Probably skip")).toBe("Ideas");
  });

  it("clusterOnMove lands at the day's last cluster when the move carries no time", () => {
    expect(clusterOnMove(t, "fri", null, "Afternoon — canyons")).toBe("Untimed");
    expect(clusterOnMove(t, "fri", undefined, "Afternoon — canyons")).toBe("Untimed");
  });

  it("clusterOnMove falls back to the carried name, then Inbox, on an empty day", () => {
    const empty = trip({ days: [day({ key: "sun" })], places: [] });
    expect(clusterOnMove(empty, "sun", null, "Carried")).toBe("Carried");
    expect(clusterOnMove(empty, "sun", null, "")).toBe("Inbox");
  });
});

describe("slugify", () => {
  it("slugs a plain name", () => {
    expect(slugify("Art Institute of Chicago")).toBe("art-institute-of-chicago");
  });

  it("matches the ids already committed in the fixtures", () => {
    expect(slugify(CHICAGO.places.find((p) => p.id === "art-institute-of-chicago").name))
      .toBe("art-institute-of-chicago");
    expect(slugify("Navy Pier")).toBe("navy-pier");
    expect(slugify("Green Mill")).toBe("green-mill");
  });

  it("collapses every punctuation run to a single dash", () => {
    expect(slugify("Lou Malnati's — State St")).toBe("lou-malnati-s-state-st");
    expect(slugify("Ben & Jerry's")).toBe("ben-jerry-s");
    expect(slugify("Mother's / Father's")).toBe("mother-s-father-s");
    expect(slugify("A  B")).toBe("a-b");
    expect(slugify("Quimby's Bookstore")).toBe("quimby-s-bookstore");
  });

  it("strips leading and trailing dashes", () => {
    expect(slugify("-leading-and-trailing-")).toBe("leading-and-trailing");
    expect(slugify("  spaced  ")).toBe("spaced");
    expect(slugify("...Ellipsis...")).toBe("ellipsis");
  });

  it("drops diacritics rather than folding them (as implemented)", () => {
    /* NOT ideal — "Café" becomes "caf", not "cafe" — but it is what ships, and
       ids are stable once written, so a fold would be a migration not a fix.
       Suggested seam: String.prototype.normalize("NFD") before the strip. */
    expect(slugify("Café Déjà Vu")).toBe("caf-d-j-vu");
    expect(slugify("Crème Brûlée")).toBe("cr-me-br-l-e");
  });

  it("falls back to 'stopover' when nothing survives", () => {
    expect(slugify("")).toBe("stopover");
    expect(slugify(null)).toBe("stopover");
    expect(slugify(undefined)).toBe("stopover");
    expect(slugify("   ")).toBe("stopover");
    expect(slugify("!!!")).toBe("stopover");
    expect(slugify("$$")).toBe("stopover");
    expect(slugify("北京烤鸭")).toBe("stopover");     // non-Latin collapses entirely
  });

  it("always emits a schema-legal slug", () => {
    const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const s of ["Art Institute of Chicago", "Lou Malnati's — State St", "Café Déjà Vu",
                     "  ...  ", "", null, "北京烤鸭", "$$", "-x-", "9¾ Platform"]) {
      expect(slugify(s)).toMatch(SLUG);
    }
  });
});

describe("uniqueId — collision suffixing", () => {
  const withIds = (ids) => ({ places: ids.map((id) => ({ id })) });

  it("returns the base untouched when it is free", () => {
    expect(uniqueId(withIds(["other"]), "diner")).toBe("diner");
    expect(uniqueId(withIds([]), "diner")).toBe("diner");
  });

  it("suffixes from -2 on a collision", () => {
    expect(uniqueId(withIds(["cafe"]), "cafe")).toBe("cafe-2");
  });

  it("skips suffixes already taken", () => {
    expect(uniqueId(withIds(["cafe", "cafe-2", "cafe-3"]), "cafe")).toBe("cafe-4");
  });

  it("fills the first gap in a suffix run", () => {
    expect(uniqueId(withIds(["cafe", "cafe-3"]), "cafe")).toBe("cafe-2");
  });

  it("de-duplicates the slugify fallback so two unslugabbles can coexist", () => {
    const t = withIds([slugify("北京烤鸭")]);
    expect(uniqueId(t, slugify("東京"))).toBe("stopover-2");
  });

  it("produces schema-legal ids", () => {
    const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    expect(uniqueId(withIds(["cafe"]), "cafe")).toMatch(SLUG);
    expect(uniqueId(withIds([]), slugify("Café"))).toMatch(SLUG);
  });

  it("does not collide with any id in a real fixture", () => {
    const taken = new Set(CHICAGO.places.map((p) => p.id));
    expect(taken.has(uniqueId(CHICAGO, "navy-pier"))).toBe(false);
    expect(uniqueId(CHICAGO, "navy-pier")).toBe("navy-pier-2");
  });
});

describe("lookups", () => {
  it("placeById finds a place or returns null", () => {
    expect(placeById(CHICAGO, "navy-pier").name).toBe("Navy Pier");
    expect(placeById(CHICAGO, "nope")).toBeNull();
  });

  it("dayByKey finds a day or returns null", () => {
    expect(dayByKey(CHICAGO, "sat").label).toBe("SAT");
    expect(dayByKey(CHICAGO, "nope")).toBeNull();
  });

  it("tripToday reads the trip's timezone", () => {
    at("2027-06-05T04:30:00Z");
    expect(tripToday(CHICAGO)).toBe("2027-06-04");            // America/Chicago
    expect(tripToday({ tz: "UTC" })).toBe("2027-06-05");
    expect(tripToday(null)).toBe("2027-06-05");               // TZ pinned to UTC
  });
});

describe("priority tables", () => {
  it("PRIOS lists every priority once, as [value, label] pairs", () => {
    const keys = PRIOS.map((p) => p[0]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "fixed", "must", "yes", "maybe", "maybe-not", "if-close",
      "optional", "check", "skip", "note"
    ]);
    expect(PRIOS.every((p) => p.length === 2 && typeof p[1] === "string" && p[1])).toBe(true);
  });

  it("CHIP collapses the soft priorities onto one quiet Maybe", () => {
    expect(CHIP.must).toEqual(["must", "★ Must"]);
    for (const k of ["maybe", "maybe-not", "if-close", "optional"]) {
      expect(CHIP[k][0]).toBe("maybe");
      expect(CHIP[k][1]).toBe("Maybe");
    }
  });

  it("gives fixed / yes / check / skip / note no chip at all", () => {
    for (const k of ["fixed", "yes", "check", "skip", "note"]) {
      expect(CHIP[k]).toBeUndefined();
    }
  });

  it("every CHIP key is a real priority", () => {
    const keys = new Set(PRIOS.map((p) => p[0]));
    for (const k of Object.keys(CHIP)) expect(keys.has(k)).toBe(true);
  });
});
