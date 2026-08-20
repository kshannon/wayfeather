/* session.js — ephemeral view state that never outlives the tab.

   Deliberately separate from state.js: nothing here is persisted, and keeping
   it in its own module is what lets the views read each other's cursor (the
   Map tab routes the day the Itinerary is showing) without importing each
   other and forming a cycle. */

export const session = {
  dayKey: null,                          // the day the Itinerary is showing
  scope: { dayKey: null, cluster: null },// what the Map tab is routing
  route: { idx: 0 }                      // which stop the Map dock is showing
};

export function resetScope(dayKey) {
  session.scope.dayKey = dayKey;
  session.scope.cluster = null;
  session.route.idx = 0;
}
