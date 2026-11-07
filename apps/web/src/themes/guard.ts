// The last line of defence for protected surfaces (design §4.3). styles/protected.css re-asserts what CSS can
// re-assert; what a theme can still do from the outside (hide a button by its tag name, fade an ancestor, cover the
// card, push it off-screen, set a descendant's own font) is caught here: every protected surface is measured with the
// theme on and with the theme's own CSS lifted (the manifest's layout options stay, Score renders those), and a theme
// that makes any of them worse is switched off.

export { KNOWN_BACKDROPS, KNOWN_OVERLAYS } from './guard-overlays.ts'
export { contrastVerdict } from './guard-verdict.ts'
export { findProtectedViolation } from './guard-violation.ts'
export { decisionProblem } from './guard-decision.ts'
export { watchProtectedSurfaces, watchWhileCustom, type WatchOptions } from './guard-watch.ts'
