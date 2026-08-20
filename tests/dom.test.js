/* dom.test.js — escaping, and the $$-splice regression (DESIGN §10).

   dom.js mixes pure string helpers with real DOM helpers. Only the pure half is
   exercised here; see "browser-only helpers" at the bottom for what is not
   reachable under node and why that is a coupling, not an oversight.

   Named, narrow imports: dom.js may grow exports; that must not break this. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { esc, attr, enc, q, copy, cssVar, reduced } from "../app/js/dom.js";

const CHICAGO = JSON.parse(
  readFileSync(new URL("../data/trips/chicago-test.json", import.meta.url), "utf8"));
const RIVER = JSON.parse(
  readFileSync(new URL("../data/trips/river-road-test.json", import.meta.url), "utf8"));

describe("esc — HTML escaping", () => {
  it("escapes all five markup-significant characters", () => {
    expect(esc("&")).toBe("&amp;");
    expect(esc("<")).toBe("&lt;");
    expect(esc(">")).toBe("&gt;");
    expect(esc('"')).toBe("&quot;");
    expect(esc("'")).toBe("&#39;");
  });

  it("escapes a whole injection attempt", () => {
    expect(esc('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("escapes an ampersand once, not twice", () => {
    expect(esc("Ben & Jerry's")).toBe("Ben &amp; Jerry&#39;s");
    expect(esc("&amp;")).toBe("&amp;amp;");     // already-escaped text is data, not markup
  });

  it("leaves ordinary text byte-identical", () => {
    for (const s of ["Art Institute of Chicago", "Mon–Sat 10–6", "Café Déjà Vu",
                     "Daily 8–sunset", "~2:30 PM", "北京烤鸭", "100% · free"]) {
      expect(esc(s)).toBe(s);
    }
  });

  it("renders null and undefined as empty, but keeps falsy values that are real", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc("")).toBe("");
    expect(esc(0)).toBe("0");
    expect(esc(false)).toBe("false");
  });

  it("stringifies non-strings", () => {
    expect(esc(42)).toBe("42");
    expect(esc(["a", "b"])).toBe("a,b");
  });

  it("attr is the same escaping, named apart for call-site intent", () => {
    expect(attr).toBe(esc);
    expect(attr('a"b')).toBe("a&quot;b");
  });
});

describe("REGRESSION — the $$ splice bug that has bitten three separate builds", () => {
  /* `cost` is free text in the schema and "$$" is a real value in
     data/trips/river-road-test.json. JS String.replace treats "$$" in a
     REPLACEMENT STRING as the escape for a single "$", so any helper that
     splices trip text via a string replacement silently eats half the value.
     dom.js dodges this by passing a FUNCTION replacer. These tests fail the
     moment anyone "simplifies" that back. */

  it("esc() round-trips $$ byte-identically", () => {
    expect(esc("$$")).toBe("$$");
    expect(esc("$$")).toHaveLength(2);
    expect(esc("$")).toBe("$");
    expect(esc("$$$")).toBe("$$$");
    expect(esc("$32")).toBe("$32");
  });

  it("esc() round-trips every other replacement-string escape sequence too", () => {
    /* $& $` $' $1 $<n> are all special in a replacement string, not just $$ */
    expect(esc("$&")).toBe("$&amp;");     // the & is escaped; the $ is literal
    expect(esc("$`")).toBe("$`");
    expect(esc("$'")).toBe("$&#39;");
    expect(esc("$1")).toBe("$1");
    expect(esc("$<name>")).toBe("$&lt;name&gt;");
    expect(esc("$$$&$`$'")).toBe("$$$&amp;$`$&#39;");
  });

  it("esc() round-trips $$ when spliced into markup, the way a card renders it", () => {
    const cost = "$$";
    const html = '<span class="cost">' + esc(cost) + "</span>";
    expect(html).toBe('<span class="cost">$$</span>');
    expect(html).toContain("$$");
  });

  it("preserves the real $$ cost value that ships in river-road-test.json", () => {
    const dinner = RIVER.places.find((p) => p.id === "lodge-dinner");
    expect(dinner.cost).toBe("$$");                 // premise: the fixture still has it
    expect(esc(dinner.cost)).toBe("$$");
    expect(attr(dinner.cost)).toBe("$$");
    expect(q(dinner.cost)).toBe("$$");
  });

  it("preserves every cost value in both fixtures", () => {
    for (const p of [...CHICAGO.places, ...RIVER.places]) {
      expect(esc(p.cost)).toBe(p.cost);             // no cost value contains markup
    }
  });

  it("documents WHY a function replacer is mandatory: the string form eats $$", () => {
    /* Plain JS, no app code — this is the trap dom.js exists to avoid. If this
       ever stops being true, the CLAUDE.md gotcha can be retired. */
    const cost = "$$";
    expect("<b>{cost}</b>".replace("{cost}", cost)).toBe("<b>$</b>");        // the bug
    expect("<b>{cost}</b>".replace("{cost}", () => cost)).toBe("<b>$$</b>"); // the fix
    expect("x".replace("x", "$&$&")).toBe("xx");                             // $& is special too
  });

  it("esc() is implemented with a function replacer, not a string one", () => {
    /* A string replacement could still pass the cases above by luck; this
       checks the property that actually matters — that a $-sequence in the
       INPUT is never interpreted, for every escaped character. */
    for (const c of ["&", "<", ">", '"', "'"]) {
      expect(esc("$$" + c)).toBe("$$" + esc(c));       // $$ survives beside an escape
      expect(esc("$&" + c)).toBe("$&amp;" + esc(c));   // so does $ before a real &
      expect(esc("$1" + c)).toBe("$1" + esc(c));
    }
    expect(esc("$$&")).toBe("$$&amp;");
  });
});

describe("q — attribute-selector-safe quoting", () => {
  it("backslash-escapes double quotes", () => {
    expect(q('a"b')).toBe('a\\"b');
    expect(q('"')).toBe('\\"');
  });

  it("leaves other characters alone", () => {
    expect(q("art-institute-of-chicago")).toBe("art-institute-of-chicago");
    expect(q("a'b")).toBe("a'b");
    expect(q("a&b")).toBe("a&b");
  });

  it("round-trips $$ and the other replacement escapes byte-identically", () => {
    expect(q("$$")).toBe("$$");
    expect(q("$&")).toBe("$&");
    expect(q("$`")).toBe("$`");
    expect(q("$'")).toBe("$'");
    expect(q('$$"')).toBe('$$\\"');
  });

  it("renders null and undefined as empty", () => {
    expect(q(null)).toBe("");
    expect(q(undefined)).toBe("");
  });

  it("produces a selector that parses for every id in the fixtures", () => {
    for (const p of CHICAGO.places) {
      expect(`[data-id="${q(p.id)}"]`).toBe(`[data-id="${p.id}"]`);
    }
  });
});

describe("enc — URL component encoding", () => {
  it("is encodeURIComponent", () => {
    expect(enc).toBe(encodeURIComponent);
  });

  it("encodes the characters that would break a query string", () => {
    expect(enc("a b")).toBe("a%20b");
    expect(enc("a&b")).toBe("a%26b");
    expect(enc("a,b")).toBe("a%2Cb");
    expect(enc("a?b")).toBe("a%3Fb");
    expect(enc("a#b")).toBe("a%23b");
    expect(enc("é")).toBe("%C3%A9");
  });

  it("percent-encodes $ losslessly, so a $$ cost survives a URL round-trip", () => {
    expect(enc("$$")).toBe("%24%24");
    expect(enc("$32")).toBe("%2432");
    expect(decodeURIComponent(enc("$$"))).toBe("$$");
    expect(decodeURIComponent(enc("$32"))).toBe("$32");
  });

  it("leaves the unreserved characters alone", () => {
    expect(enc("aZ0-_.!~*'()")).toBe("aZ0-_.!~*'()");
  });
});

describe("copy — shallow own-property clone", () => {
  it("copies own enumerable properties", () => {
    const src = { a: 1, b: "two", c: null };
    expect(copy(src)).toEqual(src);
    expect(copy(src)).not.toBe(src);
  });

  it("does not copy inherited properties", () => {
    const proto = { inherited: true };
    const src = Object.create(proto);
    src.own = 1;
    expect(copy(src)).toEqual({ own: 1 });
    expect(copy(src).inherited).toBeUndefined();
  });

  it("is shallow — nested objects stay shared", () => {
    const nested = { x: 1 };
    const out = copy({ nested });
    expect(out.nested).toBe(nested);
  });

  it("copies a place without disturbing the original (the overlay-patch shape)", () => {
    const p = CHICAGO.places[0];
    const out = copy(p);
    out.visited = "2027-06-04T18:00:00Z";
    expect(out.id).toBe(p.id);
    expect(p.visited).toBeUndefined();
  });

  it("returns an empty object for an empty input", () => {
    expect(copy({})).toEqual({});
  });
});

describe("browser-only helpers — what node can and cannot reach", () => {
  it("cssVar falls back safely when there is no document (it try/catches)", () => {
    expect(cssVar("--wf-accent", "#123456")).toBe("#123456");
    expect(cssVar("--nope", "fallback")).toBe("fallback");
  });

  describe("with a window global present", () => {
    beforeAll(() => { globalThis.window = globalThis; });
    afterAll(() => { delete globalThis.window; });

    it("reduced() reports false when matchMedia is unavailable", () => {
      expect(reduced()).toBe(false);
    });
  });

  it("reduced() THROWS with no window global — a known coupling, see the report", () => {
    /* Unlike cssVar, reduced() has no try/catch, so the bare `window` is a hard
       ReferenceError outside a browser. Pinned so the asymmetry is visible.
       Suggested seam: guard with `typeof window !== "undefined"`, or read
       globalThis.matchMedia. */
    const had = "window" in globalThis;
    const saved = globalThis.window;
    delete globalThis.window;
    try {
      expect(() => reduced()).toThrow(ReferenceError);
    } finally {
      if (had) globalThis.window = saved;
    }
  });

  /* NOT tested here — they need a real document, and CLAUDE.md rules out a UI
     test harness (Vitest covers pure functions only):
       $(id)            → document.getElementById
       frag(html)       → document.createElement + innerHTML
       replaceWith(...) → parentNode.replaceChild
     frag/replaceWith would be reachable under `environment: "jsdom"`, but that
     pulls a DOM implementation into a repo whose point is having no build step.
     Left uncovered deliberately — see the coupling notes in the report. */
});
