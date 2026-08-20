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

export const PIN_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'focusable="false"><path d="M12 21s6.4-5.7 6.4-10.6a6.4 6.4 0 1 0-12.8 0C5.6 15.3 12 21 12 21Z"/>' +
  '<circle cx="12" cy="10.3" r="2.4"/></svg>';

export const CHEV_SVG =
  '<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg></span>';

export const OFFLINE_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 18.5h.01"/><path d="M8.2 15.1a5.4 5.4 0 0 1 7.6 0"/>' +
  '<path d="M4.6 11.5a10.5 10.5 0 0 1 14.8 0"/><path d="M3 3l18 18"/></svg>';
