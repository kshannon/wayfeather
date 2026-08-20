/* time.js — dates, clocks, and the chronological-slot parser.
   Pure functions: everything that needs a timezone takes it as an argument.
   These are the functions DESIGN §10 earmarks for Vitest. */

export const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const WD  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export function parseISO(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

export function localISO(d) {
  d = d || new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/* "Today" in a given timezone — completeness and past/upcoming compare here. */
export function todayIn(tz) {
  try {
    if (tz && window.Intl && Intl.DateTimeFormat) {
      const s = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    }
  } catch (e) { /* unknown tz — fall through */ }
  return localISO();
}

export function shortDate(iso) {
  const d = parseISO(iso);
  return d ? MON[d.getMonth()] + " " + d.getDate() : "";
}

export function dayNum(iso) {
  const d = parseISO(iso);
  return d ? String(d.getDate()) : "";
}

export function dayGap(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }

export function rangeLabel(a, b) {
  const A = parseISO(a), B = parseISO(b);
  if (!A || !B) return "";
  const sameMonth = A.getFullYear() === B.getFullYear() && A.getMonth() === B.getMonth();
  const left  = WD[A.getDay()] + " " + MON[A.getMonth()] + " " + A.getDate();
  const right = sameMonth ? WD[B.getDay()] + " " + B.getDate()
                          : WD[B.getDay()] + " " + MON[B.getMonth()] + " " + B.getDate();
  return left + " – " + right + ", " + B.getFullYear();
}

/* Some ICU builds emit U+202F before AM/PM; normalize so times line up and
   round-trip through parseClock below. */
export function normSpace(s) { return String(s).replace(/[\u202F\u00A0]/g, " "); }

export function fmtClock(d, tz) {
  try {
    if (tz && window.Intl && Intl.DateTimeFormat) {
      return normSpace(new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true
      }).format(d));
    }
  } catch (e) { /* fall through */ }
  let h = d.getHours();
  const m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (!h) h = 12;
  return h + ":" + (m < 10 ? "0" : "") + m + " " + ap;
}

export function clockOf(iso, tz) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : fmtClock(d, tz);
}

/* Minutes past midnight, or null for anything that is not an h:mm AM/PM time
   ("open", "(optional)", ""). Nulls keep data order at the end of the day. */
export function parseClock(s) {
  const m = /^\s*~?\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]?\.?\s*$/.exec(String(s == null ? "" : s));
  if (!m) return null;
  const h12 = +m[1], mi = +m[2];
  if (h12 < 1 || h12 > 12 || mi > 59) return null;
  let h = h12 % 12;
  if (/p/i.test(m[3])) h += 12;
  return h * 60 + mi;
}

/* "just now" / "12m ago" / "3h ago" / "2d ago" — used by the refresh stamp and
   the offline banner. */
export function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}
