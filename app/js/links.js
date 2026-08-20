/* links.js — URL synthesis. Identical behaviour to v0/v3: Yelp, Google Maps,
   Apple Maps and web-search URLs are built from name + address, and the
   locality is DERIVED from the trip's base address, never hardcoded.
   Pure functions — a trip (or a place plus a locality) in, strings out. */

import { enc } from "./dom.js";

/* "17 E Monroe St, Chicago, IL 60603" → "Chicago, IL" */
export function deriveLoc(trip) {
  const addr = (trip && trip.base && trip.base.address) || "";
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const city = parts[parts.length - 2];
    const st = parts[parts.length - 1].split(/\s+/)[0];
    if (city && st) return city + ", " + st;
  }
  return (trip && trip.name) || "";
}

export function badHours(h) {
  return /closed mon|closed tue|closed sun|closed wed|unverified|closed weekends|closed$/i.test(h || "")
      || /^CLOSED/i.test(h || "");
}

function query(p, loc) {
  return enc((p.name || "") + (p.address ? ", " + p.address : " " + loc));
}

export function linkList(p, loc) {
  if (!p.name || p.priority === "note") return [];
  const L = [];
  if (p.website) L.push({ k: "site", t: "Site", u: p.website, a: "Open the website for " + p.name });
  L.push({ k: "yelp", t: "Yelp",
    u: p.yelp || "https://www.yelp.com/search?find_desc=" + enc(p.name) + "&find_loc=" + enc(p.address || loc),
    a: "Look up " + p.name + " on Yelp" });
  L.push({ k: "gmaps", t: "Google",
    u: p.gmaps || "https://www.google.com/maps/search/?api=1&query=" + query(p, loc),
    a: "Open " + p.name + " in Google Maps" });
  if (p.address) L.push({ k: "amaps", t: "Apple",
    u: "https://maps.apple.com/?q=" + enc(p.name) + "&address=" + enc(p.address),
    a: "Open " + p.name + " in Apple Maps" });
  L.push({ k: "search", t: "Search",
    u: "https://www.google.com/search?q=" + enc(p.name + " " + loc),
    a: "Search the web for " + p.name });
  return L;
}

/* Multi-stop walking directions; needs at least two addressed stops. */
export function walkDirUrl(stops) {
  const a = stops.filter((s) => s.address).map((s) => enc(s.address));
  if (a.length < 2) return "";
  const wp = a.slice(1, -1).join("|");
  return "https://www.google.com/maps/dir/?api=1&origin=" + a[0] +
         "&destination=" + a[a.length - 1] + (wp ? "&waypoints=" + wp : "") +
         "&travelmode=walking";
}

export function appleMapsUrl(name, address) {
  return "https://maps.apple.com/?q=" + enc(name || "") +
         (address ? "&address=" + enc(address) : "");
}
