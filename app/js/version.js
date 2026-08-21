/* version.js — the shell build identifier, shown in Settings › About.

   "Did the update actually land on this phone?" is otherwise guesswork: an
   installed PWA activates a new shell on the SECOND cold start (LLMS.md), so
   the honest answer is whatever version string the RUNNING code was built with.
   Not a network check, not a timestamp — the constant itself.

   This MUST equal VERSION in app/sw.js. sw.js is a classic worker script and
   cannot import an ES module, so the string is written twice on purpose;
   tests/build.test.js fails the suite the moment the two drift.

   The two strings are also compared AT RUNTIME, on the device: js/shell.js asks
   the controlling worker for its VERSION and holds it against this constant. In
   a healthy install they agree. When they do not, this page's code and the
   worker answering its requests came from different builds — which is what a
   half-swapped shell looks like from the inside, and what the "Update ready"
   hint and the Settings diagnostics row are reporting. */
export const BUILD = "v9";
