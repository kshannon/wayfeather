/* time.test.js — clock parsing, tz day logic, chronological slotting (DESIGN §10).

   Imports are NAMED and narrow on purpose: app/js/time.js may grow exports
   (the map work appends to sibling modules), and a named import of a stable
   function is unaffected by anything added beside it. Never `import * as` and
   assert on the export list here — that would turn every new export into a
   failure. */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MON, WD,
  parseISO, localISO, todayIn, shortDate, dayNum, dayGap, rangeLabel,
  normSpace, fmtClock, clockOf, parseClock, relTime
} from "../app/js/time.js";

/* NO `window` shim here, deliberately (v4.1). time.js used to reach for
   `window.Intl` on its two timezone-aware paths, so under node the bare
   `window` threw a ReferenceError that the try/catch swallowed — silently
   dropping the tz argument and answering from the host clock. These tests
   needed `globalThis.window = globalThis` just to reach the real Intl path.
   time.js now reads `globalThis.Intl`, so the module is host-agnostic and the
   shim is gone; "host independence" at the bottom of this file pins that. */

/* Never read the wall clock: every date-sensitive test fixes `now` first. */
afterEach(() => { vi.useRealTimers(); });

const at = (iso) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

describe("parseClock — the chronological-slot parser", () => {
  it("parses the h:mm AM/PM shapes that appear in the fixtures and DESIGN §3", () => {
    expect(parseClock("3:00 PM")).toBe(15 * 60);
    expect(parseClock("10:30 AM")).toBe(10 * 60 + 30);
    expect(parseClock("9:00 AM")).toBe(9 * 60);
    expect(parseClock("7:00 PM")).toBe(19 * 60);
  });

  it("tolerates the approximate '~' prefix used for soft times", () => {
    expect(parseClock("~2:30 PM")).toBe(14 * 60 + 30);
    /* the tilde is not a different time from the exact one */
    expect(parseClock("~2:30 PM")).toBe(parseClock("2:30 PM"));
  });

  it("returns null for the non-time strings the schema allows", () => {
    expect(parseClock("(optional)")).toBeNull();
    expect(parseClock("open")).toBeNull();
    expect(parseClock("")).toBeNull();
  });

  it("returns null rather than throwing for null/undefined/non-strings", () => {
    expect(parseClock(null)).toBeNull();
    expect(parseClock(undefined)).toBeNull();
    expect(parseClock({})).toBeNull();
    expect(parseClock(1500)).toBeNull();
  });

  it("handles the 12 o'clock edge cases in both meridiems", () => {
    expect(parseClock("12:00 AM")).toBe(0);          // midnight sorts first
    expect(parseClock("12:59 AM")).toBe(59);
    expect(parseClock("12:00 PM")).toBe(12 * 60);    // noon, not midnight+12
    expect(parseClock("12:30 PM")).toBe(12 * 60 + 30);
    expect(parseClock("11:59 PM")).toBe(23 * 60 + 59);
  });

  it("orders AM strictly before PM across the noon boundary", () => {
    expect(parseClock("11:59 AM")).toBeLessThan(parseClock("12:00 PM"));
    expect(parseClock("12:00 AM")).toBeLessThan(parseClock("1:00 AM"));
    expect(parseClock("12:00 PM")).toBeLessThan(parseClock("1:00 PM"));
  });

  it("accepts lowercase and dotted meridiems", () => {
    expect(parseClock("3:00 pm")).toBe(15 * 60);
    expect(parseClock("3:00 p.m.")).toBe(15 * 60);
    expect(parseClock("3:00 P")).toBe(15 * 60);
    expect(parseClock("3:00 a.m.")).toBe(3 * 60);
  });

  it("tolerates surrounding and internal whitespace", () => {
    expect(parseClock("  ~ 2:30 PM  ")).toBe(14 * 60 + 30);
    expect(parseClock("3:00PM")).toBe(15 * 60);
  });

  it("rejects out-of-range and 24-hour-shaped values", () => {
    expect(parseClock("0:30 PM")).toBeNull();    // no 0 o'clock in 12-hour time
    expect(parseClock("13:00 PM")).toBeNull();
    expect(parseClock("9:60 AM")).toBeNull();
    expect(parseClock("15:00")).toBeNull();      // bare 24-hour time is not a format here
    expect(parseClock("3 PM")).toBeNull();       // minutes are required
    expect(parseClock("3:00")).toBeNull();       // meridiem is required
  });

  it("round-trips every minute of the day through fmtClock", () => {
    /* fmtClock's output must always be re-parseable — this is what keeps a
       displayed time and its sort key in agreement. */
    for (let m = 0; m < 1440; m++) {
      const d = new Date(Date.UTC(2027, 5, 5, Math.floor(m / 60), m % 60));
      expect(parseClock(fmtClock(d))).toBe(m);
    }
  });
});

describe("chronological slotting — parseClock as the sort key", () => {
  /* The slot rule (trip.js orderDay applies it; the semantics come from
     parseClock): parseable times sort ascending, everything unparseable keeps
     its data order and sinks to the tail. */
  const sortBySlot = (times) =>
    times
      .map((t, i) => ({ t, i, m: parseClock(t) }))
      .sort((a, b) => {
        if (a.m === null && b.m === null) return a.i - b.i;
        if (a.m === null) return 1;
        if (b.m === null) return -1;
        return (a.m - b.m) || (a.i - b.i);
      })
      .map((x) => x.t);

  it("sorts parsed times ascending and sinks unparseable ones to the tail", () => {
    expect(sortBySlot(["7:00 PM", "open", "9:00 AM", "", "~2:30 PM", "(optional)"]))
      .toEqual(["9:00 AM", "~2:30 PM", "7:00 PM", "open", "", "(optional)"]);
  });

  it("keeps unparseable times in data order among themselves", () => {
    expect(sortBySlot(["open", "(optional)", ""]))
      .toEqual(["open", "(optional)", ""]);
  });

  it("is stable for equal times", () => {
    expect(sortBySlot(["9:00 AM", "9:00 AM", "8:00 AM"]))
      .toEqual(["8:00 AM", "9:00 AM", "9:00 AM"]);
  });
});

describe("parseISO / localISO", () => {
  it("parses an ISO date into a local-midnight Date", () => {
    const d = parseISO("2027-06-04");
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(5);          // June, zero-based
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
  });

  it("returns null for empty and malformed input", () => {
    expect(parseISO("")).toBeNull();
    expect(parseISO(null)).toBeNull();
    expect(parseISO(undefined)).toBeNull();
    expect(parseISO("2027-6-4")).toBeNull();          // zero-padding required
    expect(parseISO("2027-06-04T10:00:00Z")).toBeNull();
    expect(parseISO("not a date")).toBeNull();
  });

  it("formats a Date back to a zero-padded ISO date", () => {
    expect(localISO(new Date(2027, 0, 5))).toBe("2027-01-05");
    expect(localISO(new Date(2027, 11, 31))).toBe("2027-12-31");
  });

  it("round-trips parseISO → localISO", () => {
    for (const iso of ["2027-01-01", "2027-06-04", "2027-10-09", "2027-12-31"]) {
      expect(localISO(parseISO(iso))).toBe(iso);
    }
  });

  it("defaults to the current instant when given no Date", () => {
    at("2027-06-04T12:00:00Z");                        // TZ is pinned to UTC
    expect(localISO()).toBe("2027-06-04");
  });
});

describe("todayIn — 'today' in the trip's own timezone", () => {
  it("resolves the same instant to different dates either side of a tz boundary", () => {
    /* 04:30 UTC on Jun 5 is still Jun 4 in Chicago (CDT, UTC-5). This is the
       whole reason day logic takes a tz instead of using the device clock. */
    at("2027-06-05T04:30:00Z");
    expect(todayIn("America/Chicago")).toBe("2027-06-04");
    expect(todayIn("UTC")).toBe("2027-06-05");
    expect(todayIn("Asia/Tokyo")).toBe("2027-06-05");
  });

  it("crosses the date line correctly", () => {
    at("2027-06-04T11:00:00Z");
    expect(todayIn("Pacific/Kiritimati")).toBe("2027-06-05");   // UTC+14
    expect(todayIn("Pacific/Midway")).toBe("2027-06-04");       // UTC-11
    expect(todayIn("UTC")).toBe("2027-06-04");
  });

  it("observes daylight saving in the trip's zone", () => {
    at("2027-01-05T04:30:00Z");   // January: Chicago is CST (UTC-6)
    expect(todayIn("America/Chicago")).toBe("2027-01-04");
    at("2027-01-05T06:30:00Z");
    expect(todayIn("America/Chicago")).toBe("2027-01-05");
  });

  it("falls back to the device date for a missing or unknown timezone", () => {
    at("2027-06-04T12:00:00Z");
    expect(todayIn("")).toBe("2027-06-04");
    expect(todayIn(null)).toBe("2027-06-04");
    expect(todayIn(undefined)).toBe("2027-06-04");
    expect(todayIn("Not/AZone")).toBe("2027-06-04");
  });

  it("always returns a well-formed ISO date", () => {
    at("2027-10-08T23:59:59Z");
    for (const tz of ["America/Chicago", "UTC", "Asia/Kolkata", "Australia/Eucla", "garbage"]) {
      expect(todayIn(tz)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("fmtClock / clockOf", () => {
  it("renders an instant in the trip's timezone", () => {
    const d = new Date("2027-06-05T04:30:00Z");
    expect(fmtClock(d, "America/Chicago")).toBe("11:30 PM");
    expect(fmtClock(d, "UTC")).toBe("4:30 AM");
    expect(fmtClock(d, "Asia/Tokyo")).toBe("1:30 PM");
  });

  it("renders the 12 o'clock edges as 12, not 0", () => {
    expect(fmtClock(new Date("2027-06-05T00:00:00Z"), "UTC")).toBe("12:00 AM");
    expect(fmtClock(new Date("2027-06-05T12:00:00Z"), "UTC")).toBe("12:00 PM");
  });

  it("zero-pads minutes", () => {
    expect(fmtClock(new Date("2027-06-05T09:05:00Z"), "UTC")).toBe("9:05 AM");
  });

  it("falls back to the device clock with no timezone", () => {
    /* TZ is pinned to UTC by vitest.config.js, so this is deterministic. */
    expect(fmtClock(new Date("2027-06-05T04:30:00Z"))).toBe("4:30 AM");
    expect(fmtClock(new Date("2027-06-05T00:00:00Z"))).toBe("12:00 AM");
    expect(fmtClock(new Date("2027-06-05T12:00:00Z"))).toBe("12:00 PM");
  });

  it("emits no narrow/no-break space, so the output stays parseable", () => {
    /* Some ICU builds put U+202F before AM/PM; normSpace exists to undo that. */
    const s = fmtClock(new Date("2027-06-05T16:45:00Z"), "America/Chicago");
    expect(s).not.toMatch(/[\u202F\u00A0]/);
    expect(parseClock(s)).toBe(11 * 60 + 45);
  });

  it("clockOf formats an ISO timestamp and swallows bad input", () => {
    expect(clockOf("2027-06-05T04:30:00Z", "America/Chicago")).toBe("11:30 PM");
    expect(clockOf("", "UTC")).toBe("");
    expect(clockOf(null, "UTC")).toBe("");
    expect(clockOf("not a timestamp", "UTC")).toBe("");
  });
});

describe("normSpace", () => {
  const NARROW = "\u202F";   // U+202F NARROW NO-BREAK SPACE (some ICU builds)
  const NBSP   = "\u00A0";   // U+00A0 NO-BREAK SPACE

  it("normalizes narrow and non-breaking spaces to plain spaces", () => {
    expect(normSpace("3:00" + NARROW + "PM")).toBe("3:00 PM");
    expect(normSpace("3:00" + NBSP + "PM")).toBe("3:00 PM");
    expect(normSpace("3:00 PM")).toBe("3:00 PM");
    expect(normSpace("a" + NARROW + "b" + NBSP + "c")).toBe("a b c");
  });

  it("leaves an already-plain string byte-identical", () => {
    expect(normSpace("10:30 AM")).toBe("10:30 AM");
    expect(normSpace("")).toBe("");
  });

  it("is belt-and-braces for parsing — parseClock already tolerates both spaces", () => {
    /* time.js's comment says normSpace makes times "round-trip through
       parseClock"; in fact JS \s already matches U+202F and U+00A0, so the
       parse is safe either way. normSpace earns its keep on the DISPLAY side,
       where a narrow space makes times fail to line up in a column. Pinning
       the real behaviour here so nobody "fixes" parseClock to be stricter
       without noticing it would then depend on normSpace. */
    expect(parseClock("3:00" + NARROW + "PM")).toBe(15 * 60);
    expect(parseClock("3:00" + NBSP + "PM")).toBe(15 * 60);
    expect(parseClock(normSpace("3:00" + NARROW + "PM"))).toBe(15 * 60);
    expect(parseClock(normSpace("3:00" + NBSP + "PM"))).toBe(15 * 60);
  });

  it("makes narrow-spaced times string-comparable with plain ones", () => {
    /* the display-side reason it exists */
    expect("3:00" + NARROW + "PM").not.toBe("3:00 PM");
    expect(normSpace("3:00" + NARROW + "PM")).toBe("3:00 PM");
  });
});

describe("date labels", () => {
  it("shortDate renders 'Mon D'", () => {
    expect(shortDate("2027-06-04")).toBe("Jun 4");
    expect(shortDate("2027-12-31")).toBe("Dec 31");
    expect(shortDate("")).toBe("");
    expect(shortDate(null)).toBe("");
  });

  it("dayNum renders the un-padded day of month", () => {
    expect(dayNum("2027-06-04")).toBe("4");
    expect(dayNum("2027-06-30")).toBe("30");
    expect(dayNum("")).toBe("");
  });

  it("dayGap counts whole days between two ISO dates", () => {
    expect(dayGap("2027-06-04", "2027-06-06")).toBe(2);
    expect(dayGap("2027-06-04", "2027-06-04")).toBe(0);
    expect(dayGap("2027-06-06", "2027-06-04")).toBe(-2);
    expect(dayGap("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("dayGap survives a daylight-saving transition", () => {
    /* US DST starts 2027-03-14; a naive ms/86400000 without rounding gives
       1.958…, so this pins the Math.round. */
    expect(dayGap("2027-03-13", "2027-03-15")).toBe(2);
    expect(dayGap("2027-11-06", "2027-11-08")).toBe(2);
  });

  it("rangeLabel collapses a same-month range", () => {
    expect(rangeLabel("2027-06-04", "2027-06-06")).toBe("Fri Jun 4 – Sun 6, 2027");
  });

  it("rangeLabel repeats the month across a month or year boundary", () => {
    expect(rangeLabel("2027-10-30", "2027-11-02")).toBe("Sat Oct 30 – Tue Nov 2, 2027");
    expect(rangeLabel("2027-12-30", "2028-01-02")).toBe("Thu Dec 30 – Sun Jan 2, 2028");
  });

  it("rangeLabel returns empty for missing endpoints", () => {
    expect(rangeLabel("", "2027-06-06")).toBe("");
    expect(rangeLabel("2027-06-04", "")).toBe("");
    expect(rangeLabel(null, null)).toBe("");
  });

  it("exposes month and weekday tables of the right shape", () => {
    expect(MON).toHaveLength(12);
    expect(WD).toHaveLength(7);
    expect(MON[0]).toBe("Jan");
    expect(WD[0]).toBe("Sun");
  });
});

describe("relTime", () => {
  it("bucketizes an elapsed timestamp", () => {
    at("2027-06-04T12:00:00Z");
    const now = Date.now();
    expect(relTime(now)).toBe("just now");
    expect(relTime(now - 44 * 1000)).toBe("just now");
    expect(relTime(now - 5 * 60 * 1000)).toBe("5m ago");
    expect(relTime(now - 3 * 3600 * 1000)).toBe("3h ago");
    expect(relTime(now - 2 * 86400 * 1000)).toBe("2d ago");
  });

  it("clamps a future timestamp to 'just now' instead of going negative", () => {
    at("2027-06-04T12:00:00Z");
    expect(relTime(Date.now() + 60 * 60 * 1000)).toBe("just now");
  });
});

describe("host independence (the seam the note at the top used to document)", () => {
  it("honours the timezone with no `window` global at all", () => {
    /* Was: "silently ignores the timezone when no `window` global exists" —
       the degraded fallback that `window.Intl` forced on every non-browser
       host. time.js reads `globalThis.Intl` now, so both tz-aware paths work
       here exactly as they do in Safari, with nothing shimmed. */
    expect("window" in globalThis).toBe(false);
    at("2027-06-05T04:30:00Z");
    expect(todayIn("America/Chicago")).toBe("2027-06-04");   // 11:30 PM the day before
    expect(fmtClock(new Date("2027-06-05T04:30:00Z"), "America/Chicago")).toBe("11:30 PM");
  });

  it("still falls back to the device date for an unknown timezone", () => {
    at("2027-06-05T04:30:00Z");
    expect(todayIn("Mars/Olympus_Mons")).toBe(localISO());
    expect(todayIn("")).toBe(localISO());
  });
});
