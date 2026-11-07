// Score's own overlays and sticky bars: the menu drawer, banners, the sticky rails and headers, and the backdrops of
// dialogs. Content scrolled under one is not "covered". A theme can't make anything fixed, sticky or positioned (the
// allowlist), so none of these can be a theme's doing; they are named here by Score's own classes (a theme's CSS cannot
// add a class), not found by looking at `position`, which any rule could have set (re-gate finding 4). A bar or panel
// only counts while it is still fixed or sticky and small: one that has been stretched over the page (an injected
// `position: absolute; inset: 0`) is the cover it looks like. themes/guard.test.ts keeps this list in step with the
// position: fixed / sticky rules in the stylesheets.
export const KNOWN_OVERLAYS = [
  '.responsive-drawer',
  '.nav-drawer',
  '.look-banner',
  '.top-bar',
  '.orch-room-head',
  '.kn-left',
  '.kn-upload-progress',
  '.kn-drop-hint',
  '.kn-toolbar',
  '.chat-version-bar',
  '.chat-doc-table',
  '.chat-toast',
  '.bold-tabbar',
  '.bold-needs-chip-slot',
  '.bold-sidecol',
  '.bold-job-toasts',
  '.bold-start-scrim',
  '.bold-trigger-scrim',
  '.bold-rp-scrim',
  '.bold-rp-sheet',
  '.bold-rp-aside',
  '.bold-tb-sheet',
  '.bold-tb-scrim',
  '.bold-viewer-sheet',
  '.bold-knowledge-menu',
  '.bold-knowledge-scrim',
].join(', ')
/** Dialog backdrops cover the page by design. */
export const KNOWN_BACKDROPS =
  '.drawer-backdrop, .command-backdrop, .kn-backdrop, .cz-backdrop, [role=dialog]'
const MAX_OVERLAY_SHARE = 0.6

export function isScoreOverlay(hit: Element): boolean {
  if (hit.closest(KNOWN_BACKDROPS)) return true
  const overlay = hit.closest(KNOWN_OVERLAYS)
  if (!overlay) return false
  const position = getComputedStyle(overlay).position
  if (position !== 'fixed' && position !== 'sticky') return false
  const box = overlay.getBoundingClientRect()
  return box.width * box.height <= window.innerWidth * window.innerHeight * MAX_OVERLAY_SHARE
}
