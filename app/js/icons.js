/* icons.js — inline SVG only; the app makes no external requests of any kind.
   One stroke width (1.7), every glyph drawn to the same ~16px optical box. */

const OPEN = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" ' +
  'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false">';

const GLYPH = {
  site:   '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/>' +
          '<path d="M12 4c2.3 2.4 3.5 5.1 3.5 8s-1.2 5.6-3.5 8c-2.3-2.4-3.5-5.1-3.5-8S9.7 6.4 12 4Z"/>',
  yelp:   '<path d="M12 4.4 14.09 9.53 19.61 9.93 15.38 13.5 16.7 18.87 12 15.95 ' +
          '7.3 18.87 8.62 13.5 4.39 9.93 9.91 9.53Z"/>',
  gmaps:  '<path d="M12 20.4s6.2-5.5 6.2-10.2a6.2 6.2 0 1 0-12.4 0c0 4.7 6.2 10.2 6.2 10.2Z"/>' +
          '<circle cx="12" cy="10.1" r="2.3"/>',
  amaps:  '<path d="M9.1 4.2 3.7 6.2v13.6l5.4-2 5.8 2 5.4-2V4.2l-5.4 2-5.8-2Z"/>' +
          '<path d="M9.1 4.2v13.6"/><path d="M14.9 6.2v13.6"/>',
  search: '<circle cx="10.9" cy="10.9" r="6.1"/><path d="M15.4 15.4 20 20"/>'
};

export function icon(k) { return OPEN + (GLYPH[k] || "") + "</svg>"; }

/* fixed/booked stopovers carry this beside the time instead of a chip */
export const RESV_SVG =
  '<span class="resv" role="img" aria-label="reserved — be there at this time">' +
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" focusable="false">' +
      '<rect x="3.3" y="5" width="17.4" height="15.6" rx="3"/>' +
      '<path d="M3.3 9.6h17.4"/><path d="M8 3.2v3.4"/><path d="M16 3.2v3.4"/>' +
      '<path d="M8.7 14.6l2.4 2.4 4.3-4.4"/>' +
    "</svg></span>";

/* The Nest — the trip's base, still the Apple Maps deep link (DESIGN §5).
   A birdhouse: peaked roof, box, entry hole, perch. Drawn a touch larger than
   the old map pin because it carries more detail in the same optical box. */
export const NEST_SVG =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'focusable="false">' +
  '<path d="M3.4 9.6 12 3.1l8.6 6.5"/>' +
  '<path d="M5.4 9.6v9.2a1.8 1.8 0 0 0 1.8 1.8h9.6a1.8 1.8 0 0 0 1.8-1.8V9.6"/>' +
  '<circle cx="12" cy="12.9" r="2.5"/><path d="M12 15.4v2.9"/></svg>';

/* Forward motion — the tiny flying bird that replaced every forward carat (▸ on
   Route / Walk it, and the ▸ on list rows). A filled swallow seen from below,
   flying right: near wing up, forked tail behind. It is scaled 1.18 about the
   middle of the 24-box because the bird's visual mass is lower than a chevron's
   and it reads dainty at 1.0 — checked at real size against the old glyph.
   NB the ◀ ▶ cycling controls in the Map dock stay ARROWS: those move a cursor
   backwards and forwards, and a bird pointing one way cannot say "previous". */
export const BIRD_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" ' +
  'aria-hidden="true" focusable="false">' +
  '<g transform="translate(12 12) scale(1.18) translate(-12.5 -11.85)">' +
  '<path d="M20.8 10.6c-2.6-.5-5.2-.4-7.8.3L9.6 5.4c.3 2.5.9 4.3 1.8 5.9' +
  '-2.4 1-4.8 2.3-7.2 3.9l4.2-.5-1.2 3.6c2.4-2 4.9-3.6 7.5-4.8' +
  '2.4-1.1 4.6-1.8 6.1-2.9Z"/></g></svg>';

/* The list-row form of the same bird (what CHEV_SVG used to be). */
export const FLY_SVG = '<span class="chev" aria-hidden="true">' + BIRD_SVG + "</span>";

/* index.html cannot import, so its static list rows carry an empty
   <span class="chev" data-fly> placeholder and this fills them once at boot —
   the bird path stays defined in exactly one place. */
export function paintFly(root) {
  const holes = (root || document).querySelectorAll("[data-fly]");
  for (let i = 0; i < holes.length; i++) holes[i].innerHTML = BIRD_SVG;
}

export const OFFLINE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 18.5h.01"/><path d="M8.2 15.1a5.4 5.4 0 0 1 7.6 0"/>' +
  '<path d="M4.6 11.5a10.5 10.5 0 0 1 14.8 0"/><path d="M3 3l18 18"/></svg>';
