/* links.test.js — URL synthesis and locality derivation (DESIGN §10).

   Every URL here is built from name + address + a locality derived from the
   trip's base address; nothing is hardcoded per trip. These assertions pin the
   exact strings, because a silent change to one of them sends someone to the
   wrong place while standing on a corner.

   Named, narrow imports: links.js may grow exports; that must not break this. */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  deriveLoc, badHours, linkList, walkDirUrl, appleMapsUrl, telUrl
} from "../app/js/links.js";

const load = (f) =>
  JSON.parse(readFileSync(new URL("../data/trips/" + f, import.meta.url), "utf8"));

const CHICAGO = load("chicago-test.json");
const RIVER = load("river-road-test.json");

const LOC = "Chicago, IL";
const byKey = (list) => Object.fromEntries(list.map((l) => [l.k, l]));

describe("deriveLoc — locality from the trip's base address", () => {
  it("takes 'City, ST' from the last two comma parts of a full address", () => {
    expect(deriveLoc({ base: { address: "17 E Monroe St, Chicago, IL 60603" } }))
      .toBe("Chicago, IL");
  });

  it("derives from the real fixtures", () => {
    expect(deriveLoc(CHICAGO)).toBe("Chicago, IL");
    expect(deriveLoc(RIVER)).toBe("Oglesby, IL");
  });

  it("drops the ZIP and keeps only the state token", () => {
    expect(deriveLoc({ base: { address: "1 A St, Oglesby, IL 61348" } })).toBe("Oglesby, IL");
    expect(deriveLoc({ base: { address: "1 A St, Oglesby, Illinois" } })).toBe("Oglesby, Illinois");
  });

  it("uses the last two parts of a longer address, ignoring the extra lines", () => {
    expect(deriveLoc({ base: { address: "1 A St, Suite 2, Oglesby, IL 61348" } }))
      .toBe("Oglesby, IL");
  });

  it("falls back to the trip name when the address has no street part", () => {
    /* As-implemented: deriveLoc needs THREE comma parts, so an address that is
       already exactly "City, ST" does not derive and the trip name is used
       instead. Harmless for the fixtures (all have street addresses); noted so
       it isn't mistaken for a regression. */
    expect(deriveLoc({ name: "Fallback Trip", base: { address: "Chicago, IL" } }))
      .toBe("Fallback Trip");
  });

  it("falls back to the trip name for an empty or missing base", () => {
    expect(deriveLoc({ name: "Fallback Trip", base: { address: "" } })).toBe("Fallback Trip");
    expect(deriveLoc({ name: "Fallback Trip", base: {} })).toBe("Fallback Trip");
    expect(deriveLoc({ name: "Fallback Trip" })).toBe("Fallback Trip");
  });

  it("returns an empty string rather than throwing on no trip at all", () => {
    expect(deriveLoc(null)).toBe("");
    expect(deriveLoc(undefined)).toBe("");
    expect(deriveLoc({})).toBe("");
  });
});

describe("linkList — synthesized destinations", () => {
  const plain = { name: "Reckless Records", address: "1379 N Milwaukee Ave, Chicago, IL 60622",
                  priority: "yes" };

  it("synthesizes Yelp, Google Maps, Apple Maps and Search from name + address", () => {
    const L = byKey(linkList(plain, LOC));
    expect(Object.keys(L)).toEqual(["yelp", "gmaps", "amaps", "search"]);
    expect(L.yelp.u).toBe(
      "https://www.yelp.com/search?find_desc=Reckless%20Records" +
      "&find_loc=1379%20N%20Milwaukee%20Ave%2C%20Chicago%2C%20IL%2060622");
    expect(L.gmaps.u).toBe(
      "https://www.google.com/maps/search/?api=1&query=Reckless%20Records%2C%20" +
      "1379%20N%20Milwaukee%20Ave%2C%20Chicago%2C%20IL%2060622");
    expect(L.amaps.u).toBe(
      "https://maps.apple.com/?q=Reckless%20Records" +
      "&address=1379%20N%20Milwaukee%20Ave%2C%20Chicago%2C%20IL%2060622");
    expect(L.search.u).toBe(
      "https://www.google.com/search?q=Reckless%20Records%20Chicago%2C%20IL");
  });

  it("offers no Site link when the place has no website", () => {
    expect(byKey(linkList(plain, LOC)).site).toBeUndefined();
  });

  it("adds a Site link first when a website is set", () => {
    const L = linkList({ ...plain, website: "https://www.artic.edu/" }, LOC);
    expect(L[0].k).toBe("site");
    expect(L[0].u).toBe("https://www.artic.edu/");
    expect(L.map((x) => x.k)).toEqual(["site", "yelp", "gmaps", "amaps", "search"]);
  });

  it("prefers an explicit yelp/gmaps override over the synthesized URL", () => {
    const L = byKey(linkList({
      ...plain,
      website: "https://example.com/site",
      yelp: "https://www.yelp.com/biz/reckless-records-chicago",
      gmaps: "https://maps.app.goo.gl/abc123"
    }, LOC));
    expect(L.site.u).toBe("https://example.com/site");
    expect(L.yelp.u).toBe("https://www.yelp.com/biz/reckless-records-chicago");
    expect(L.gmaps.u).toBe("https://maps.app.goo.gl/abc123");
  });

  it("still synthesizes Apple Maps and Search when yelp/gmaps are overridden", () => {
    /* there is no override field for those two */
    const L = byKey(linkList({ ...plain, yelp: "https://y", gmaps: "https://g" }, LOC));
    expect(L.amaps.u).toContain("maps.apple.com");
    expect(L.search.u).toContain("google.com/search");
  });

  it("falls back to the locality when the place has no address", () => {
    const L = byKey(linkList({ name: "Nowhere Bar", priority: "yes" }, LOC));
    expect(L.yelp.u).toBe(
      "https://www.yelp.com/search?find_desc=Nowhere%20Bar&find_loc=Chicago%2C%20IL");
    /* note the shape difference: with an address the query is "name, address";
       without one it is "name locality" */
    expect(L.gmaps.u).toBe(
      "https://www.google.com/maps/search/?api=1&query=Nowhere%20Bar%20Chicago%2C%20IL");
    expect(L.search.u).toBe(
      "https://www.google.com/search?q=Nowhere%20Bar%20Chicago%2C%20IL");
  });

  it("omits Apple Maps entirely without an address", () => {
    /* Apple Maps needs a real address; a locality-only guess would be wrong */
    expect(byKey(linkList({ name: "Nowhere Bar", priority: "yes" }, LOC)).amaps)
      .toBeUndefined();
    expect(byKey(linkList({ name: "Nowhere Bar", address: "", priority: "yes" }, LOC)).amaps)
      .toBeUndefined();
  });

  it("gives note rows no links at all (DESIGN §3)", () => {
    expect(linkList({ name: "Evening is open", priority: "note", address: "1 A St" }, LOC))
      .toEqual([]);
  });

  it("gives an unnamed place no links", () => {
    expect(linkList({ priority: "yes", address: "1 A St" }, LOC)).toEqual([]);
    expect(linkList({ name: "", priority: "yes" }, LOC)).toEqual([]);
  });

  it("carries a human label and an accessible description on every link", () => {
    for (const l of linkList({ ...plain, website: "https://w" }, LOC)) {
      expect(l.t).toBeTruthy();
      expect(l.a).toContain("Reckless Records");
      expect(l.u).toBeTruthy();
    }
  });
});

describe("linkList — URL encoding", () => {
  it("percent-encodes the ampersand so it cannot split the query string", () => {
    const L = byKey(linkList({ name: "Ben & Jerry's", priority: "yes" }, LOC));
    expect(L.yelp.u).toContain("find_desc=Ben%20%26%20Jerry's");
    expect(L.yelp.u).not.toContain("find_desc=Ben & ");
    /* the raw & inside the name must not become a third parameter */
    const params = new URL(L.yelp.u).searchParams;
    expect([...params.keys()]).toEqual(["find_desc", "find_loc"]);
    expect(params.get("find_desc")).toBe("Ben & Jerry's");
    expect(params.get("find_loc")).toBe(LOC);
  });

  it("percent-encodes accented characters as UTF-8", () => {
    const L = byKey(linkList({ name: "Café Déjà Vu", priority: "yes" }, LOC));
    expect(L.search.u).toBe(
      "https://www.google.com/search?q=Caf%C3%A9%20D%C3%A9j%C3%A0%20Vu%20Chicago%2C%20IL");
  });

  it("percent-encodes spaces and commas", () => {
    const L = byKey(linkList({ name: "Big Star", address: "1531 N Damen Ave, Chicago, IL",
                              priority: "yes" }, LOC));
    expect(L.amaps.u).toBe(
      "https://maps.apple.com/?q=Big%20Star&address=1531%20N%20Damen%20Ave%2C%20Chicago%2C%20IL");
    expect(L.amaps.u).not.toContain(" ");
  });

  it("handles every awkward character at once without producing a broken URL", () => {
    const L = byKey(linkList({ name: "Bar & Grill «Ñ» #1 100% ?", address: "1 A St, Chicago, IL",
                              priority: "yes" }, LOC));
    for (const l of Object.values(L)) {
      expect(() => new URL(l.u)).not.toThrow();
      expect(l.u).not.toContain(" ");
      expect(l.u).not.toContain("#");
    }
  });

  it("leaves the apostrophe unescaped, as encodeURIComponent does", () => {
    /* pinned so nobody "fixes" it and breaks a URL that already works */
    const L = byKey(linkList({ name: "Lou Malnati's", priority: "yes" }, LOC));
    expect(L.search.u).toContain("Lou%20Malnati's");
  });

  it("round-trips a name through the search URL", () => {
    const name = "Ben & Jerry's Café";
    const L = byKey(linkList({ name, priority: "yes" }, LOC));
    const q = new URL(L.search.u).searchParams.get("q");
    expect(q).toBe(name + " " + LOC);
  });

  it("round-trips an address through the Apple Maps URL", () => {
    const address = "1379 N Milwaukee Ave, Chicago, IL 60622";
    const L = byKey(linkList({ name: "X", address, priority: "yes" }, LOC));
    expect(new URL(L.amaps.u).searchParams.get("address")).toBe(address);
  });
});

describe("linkList — over the real fixtures", () => {
  it("builds a valid, space-free URL set for every non-note place in both trips", () => {
    for (const trip of [CHICAGO, RIVER]) {
      const loc = deriveLoc(trip);
      for (const p of trip.places) {
        const L = linkList(p, loc);
        if (p.priority === "note" || !p.name) { expect(L).toEqual([]); continue; }
        expect(L.length).toBeGreaterThan(0);
        for (const l of L) {
          expect(() => new URL(l.u)).not.toThrow();
          expect(l.u).not.toContain(" ");
        }
      }
    }
  });

  it("offers Apple Maps exactly for the places that carry an address", () => {
    for (const trip of [CHICAGO, RIVER]) {
      const loc = deriveLoc(trip);
      for (const p of trip.places) {
        if (p.priority === "note" || !p.name) continue;
        const hasApple = linkList(p, loc).some((l) => l.k === "amaps");
        expect(hasApple).toBe(!!p.address);
      }
    }
  });

  it("uses the derived locality, never a hardcoded city", () => {
    const drive = RIVER.places.find((p) => p.id === "drive-to-starved-rock");
    expect(drive.address).toBe("");                        // premise: no address
    const L = byKey(linkList(drive, deriveLoc(RIVER)));
    expect(L.search.u).toContain("Oglesby%2C%20IL");
    expect(L.search.u).not.toContain("Chicago%2C%20IL");
  });
});

describe("telUrl — the Call tile's destination (schema 2)", () => {
  it("strips every separator people type", () => {
    for (const v of ["(312) 555-0100", "312.555.0100", "312 555 0100",
                     "312-555-0100", "3125550100"]) {
      expect(telUrl(v), v).toBe("tel:3125550100");
    }
  });

  it("KEEPS a leading +, because dropping it dials the wrong country", () => {
    expect(telUrl("+44 20 7946 0958")).toBe("tel:+442079460958");
    expect(telUrl("+1 (312) 555-0100")).toBe("tel:+13125550100");
  });

  it("never invents a country code for a bare local number", () => {
    /* Guessing +1 on a number that might not be American is how you call a
       stranger at 3am. */
    expect(telUrl("312-555-0100")).not.toContain("+");
  });

  it("returns '' when there is nothing dialable, so no tile renders", () => {
    for (const v of ["", "   ", "call ahead", "n/a", null, undefined, "+"]) {
      expect(telUrl(v), JSON.stringify(v)).toBe("");
    }
  });

  it("keeps digits found inside text rather than half-dialing it", () => {
    /* Not a shape we write, but if it ever arrives the answer must be all the
       digits or none — never a truncated number that dials something real. */
    expect(telUrl("ext 5 — 312 555 0100")).toBe("tel:53125550100");
  });
});

describe("linkList — the Call tile", () => {
  const withPhone = (phone) => ({
    id: "x", name: "Green Mill", address: "4802 N Broadway, Chicago, IL 60640",
    priority: "yes", phone, website: "", yelp: "", gmaps: ""
  });

  it("adds a Call tile FIRST when a phone is set", () => {
    const L = linkList(withPhone("(312) 555-0100"), LOC);
    expect(L[0].k).toBe("call");
    expect(L[0].t).toBe("Call");
    expect(L[0].u).toBe("tel:3125550100");
    expect(L[0].a).toBe("Call Green Mill");
  });

  it("adds no tile at all when phone is empty or undialable", () => {
    for (const v of ["", "   ", "no phone", undefined]) {
      expect(byKey(linkList(withPhone(v), LOC)).call, JSON.stringify(v)).toBeUndefined();
    }
  });

  it("leaves every other tile exactly where it was", () => {
    const without = linkList(withPhone(""), LOC).map((l) => l.k);
    const with_ = linkList(withPhone("312-555-0100"), LOC).map((l) => l.k);
    expect(with_).toEqual(["call", ...without]);
  });

  it("still renders nothing for a note row, phone or not", () => {
    const note = { ...withPhone("312-555-0100"), priority: "note" };
    expect(linkList(note, LOC)).toEqual([]);
  });
});

describe("walkDirUrl — multi-stop walking directions", () => {
  it("returns empty with fewer than two addressed stops", () => {
    expect(walkDirUrl([])).toBe("");
    expect(walkDirUrl([{ address: "1 A St" }])).toBe("");
    expect(walkDirUrl([{ address: "1 A St" }, { address: "" }])).toBe("");
    expect(walkDirUrl([{ address: "" }, { address: "" }])).toBe("");
  });

  it("builds origin and destination for exactly two stops, with no waypoints", () => {
    expect(walkDirUrl([{ address: "1 A St" }, { address: "2 B St" }])).toBe(
      "https://www.google.com/maps/dir/?api=1&origin=1%20A%20St" +
      "&destination=2%20B%20St&travelmode=walking");
  });

  it("puts every middle stop in waypoints, pipe-separated and in order", () => {
    const u = walkDirUrl([{ address: "A" }, { address: "B" }, { address: "C" }, { address: "D" }]);
    expect(u).toBe("https://www.google.com/maps/dir/?api=1&origin=A&destination=D" +
                   "&waypoints=B|C&travelmode=walking");
  });

  it("skips stops with no address before choosing endpoints", () => {
    const u = walkDirUrl([{ address: "" }, { address: "A" }, { address: "" },
                          { address: "B" }, { address: "C" }]);
    expect(u).toContain("origin=A");
    expect(u).toContain("destination=C");
    expect(u).toContain("waypoints=B");
  });

  it("percent-encodes each stop but leaves the pipe separator literal", () => {
    /* as-implemented, and as v0 shipped: Google accepts a bare pipe here */
    const u = walkDirUrl([{ address: "1 A St, Chicago, IL" },
                          { address: "2 B & C St" },
                          { address: "3 Café Ln" }]);
    expect(u).toContain("origin=1%20A%20St%2C%20Chicago%2C%20IL");
    expect(u).toContain("waypoints=2%20B%20%26%20C%20St");
    expect(u).toContain("destination=3%20Caf%C3%A9%20Ln");
    expect(u).toContain("&travelmode=walking");
  });

  it("always requests walking directions", () => {
    expect(walkDirUrl([{ address: "A" }, { address: "B" }])).toContain("travelmode=walking");
  });

  it("chains a real fixture day into one route", () => {
    const stops = RIVER.places.filter((p) => p.day === "fri");
    const u = walkDirUrl(stops);
    expect(u).toContain("origin=2668%20E%20875th%20Rd%2C%20Oglesby%2C%20IL%2061348");
    expect(() => new URL(u)).not.toThrow();
  });
});

describe("appleMapsUrl", () => {
  it("builds a name-and-address URL", () => {
    expect(appleMapsUrl("Palmer House", "17 E Monroe St, Chicago, IL 60603")).toBe(
      "https://maps.apple.com/?q=Palmer%20House" +
      "&address=17%20E%20Monroe%20St%2C%20Chicago%2C%20IL%2060603");
  });

  it("omits the address parameter when there is no address", () => {
    expect(appleMapsUrl("Palmer House")).toBe("https://maps.apple.com/?q=Palmer%20House");
    expect(appleMapsUrl("Palmer House", "")).toBe("https://maps.apple.com/?q=Palmer%20House");
  });

  it("survives a missing name", () => {
    expect(appleMapsUrl()).toBe("https://maps.apple.com/?q=");
    expect(appleMapsUrl(null, "1 A St")).toBe("https://maps.apple.com/?q=&address=1%20A%20St");
  });

  it("encodes ampersands and accents", () => {
    expect(appleMapsUrl("Ben & Jerry's Café", "1 A & B St")).toBe(
      "https://maps.apple.com/?q=Ben%20%26%20Jerry's%20Caf%C3%A9&address=1%20A%20%26%20B%20St");
  });

  it("links the base of each real fixture", () => {
    expect(appleMapsUrl(CHICAGO.base.name, CHICAGO.base.address))
      .toContain("address=17%20E%20Monroe%20St%2C%20Chicago%2C%20IL%2060603");
    expect(() => new URL(appleMapsUrl(RIVER.base.name, RIVER.base.address))).not.toThrow();
  });
});

describe("badHours — the 'is this place closed' sniff", () => {
  it("flags an hours string that starts with CLOSED", () => {
    expect(badHours("CLOSED Mondays")).toBe(true);
    expect(badHours("Closed for the season")).toBe(true);
    expect(badHours("CLOSED Thu/Fri")).toBe(true);
  });

  it("flags a mid-string Sun/Mon/Tue/Wed closure", () => {
    expect(badHours("Daily 11–5; CLOSED Tue/Wed")).toBe(true);
    expect(badHours("Open 10–6, closed Mondays")).toBe(true);
    expect(badHours("closed Sun")).toBe(true);
  });

  it("flags unverified hours and weekend closures", () => {
    expect(badHours("unverified")).toBe(true);
    expect(badHours("Hours unverified — call ahead")).toBe(true);
    expect(badHours("Closed weekends")).toBe(true);
  });

  it("flags a string that simply ends in 'closed'", () => {
    expect(badHours("Sunday: closed")).toBe(true);
  });

  it("passes ordinary hours and empty input", () => {
    expect(badHours("Mon–Sat 10–6")).toBe(false);
    expect(badHours("Daily 8–sunset")).toBe(false);
    expect(badHours("Trails dawn–dusk")).toBe(false);
    expect(badHours("")).toBe(false);
    expect(badHours(null)).toBe(false);
    expect(badHours(undefined)).toBe(false);
  });

  it("flags a mid-string Thu/Fri/Sat closure (was a known gap — fixed in v4.1)", () => {
    /* The alternation used to cover mon/tue/wed/sun only, and these strings
       neither start with CLOSED nor end in "closed", so they slipped through
       unflagged. badHours now sniffs every weekday anywhere in the string. */
    expect(badHours("Daily 11–5; CLOSED Thu")).toBe(true);
    expect(badHours("Open 10–6, closed Fridays")).toBe(true);
    expect(badHours("Open 10–6, closed Saturdays")).toBe(true);
  });

  it("flags every weekday, with or without the 'on', anywhere in the string", () => {
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((d) => {
      expect(badHours("Open 9–5 · closed " + d)).toBe(true);
      expect(badHours("Open 9–5 · closed on " + d + "days")).toBe(true);
      expect(badHours("Open 9–5 · CLOSED " + d.toUpperCase())).toBe(true);
    });
  });

  it("still passes ordinary hours that merely name a weekday", () => {
    expect(badHours("Thu–Sun 11–7")).toBe(false);
    expect(badHours("Fri & Sat until 10 PM")).toBe(false);
    expect(badHours("Sat 9–1, Sun brunch only")).toBe(false);
  });

  it("agrees with the real fixtures", () => {
    const hours = (id) => [...CHICAGO.places, ...RIVER.places].find((p) => p.id === id).hours;
    expect(badHours(hours("art-institute-of-chicago"))).toBe(true);   // "CLOSED Tue/Wed"
    expect(badHours(hours("lodge-dinner"))).toBe(false);              // "Daily 7 AM–9 PM"
    expect(badHours(hours("matthiessen-state-park"))).toBe(false);    // "Daily 8–sunset"
  });
});
