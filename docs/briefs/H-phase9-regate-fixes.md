# Phase 9 re-gate fixes — H1, H2, H3 (decision 102)

Source: `docs/reviews/2026-10-18-phase9-regate-codex-max.md` (findings 1–10 and the status table). Every fix lands with a
test that fails before it (show it); if something doesn't reproduce, say so with evidence.

## H1 — visual-only theme CSS and a trusted protected boundary (findings 3, 4, 5, part of 6's "overlay" note)
1. **Allowlist sanitiser** (browser `themes/sanitise.ts` and the server's `themes/css-check.ts` must agree): a theme
   declaration is kept only if its property is on a documented allowlist of visual properties — colours and
   `background-*` (images only `asset:`), `border-*` style/width/colour/radius, `outline` colour/style, `box-shadow`,
   `text-shadow`, `font-family/weight/style`, `text-decoration-*`, `accent-color`, `caret-color`, `opacity` (not on
   elements that contain protected descendants — enforce via the guard), custom properties `--*` (only ones Score
   defines as public tokens, values validated as colours/lengths, never `var()` into positioning). Everything else —
   `position`, `inset`, `top/left/…`, `transform`/`translate`/`rotate`/`scale`, `overflow*`, `clip*`, `mask*`,
   `width/height/min/max`, `margin/padding`, `display`, `flex*/grid*`, `z-index`, `content`, `filter`,
   `backdrop-filter`, `font-size`, `line-height`, `letter-/word-spacing`, `text-indent`, `text-transform`,
   `writing-mode`, `direction`, `visibility`, motion — is dropped (browser) / rejected (server: a package with a
   disallowed property is `422 theme_rejected` naming it). Update docs/THEMES.md and API-CONTRACT § 16; built-in
   themes and the example must still pass (move any layout they need into manifest options).
2. **Trusted protected boundary** in `styles/protected.css` (`@layer score-protected`, `!important`): reset inherited
   typography on `[data-protected]` (font-size, line-height, letter/word-spacing, text-transform, text-indent,
   writing-mode, direction, white-space) to Score's own values, and give protected navigation/controls an opaque trusted
   background (finding 5's glass-over-picture case) — default look stays pixel-identical.
3. **Guard**: measure clipping (intersection of ancestors' clip/overflow boxes), verify the painted hit is the control
   or its descendant (not any ancestor), drop the blanket fixed/sticky overlay exemption (allowlist makes theme overlays
   impossible; keep only Score's own known overlays by marker), and compare against a real no-theme baseline (remove
   the theme attributes too, finding 5's note).

## H2 — package and server consistency (findings 1, 2, 7, 10)
1. Finding 1: reject zip entries whose extra fields change the name (Info-ZIP Unicode path `0x7075`, Unicode comment is
   fine) on both readers, or compare every decoded name with the validated canonical name; regression with the crafted
   package on both readers and the import route.
2. Finding 2: while a theme id has an unresolved swap/move note, refuse replace, delete and reclaim for that id (409
   with a plain message) until recovery succeeds; fault test "retry before successful recovery".
3. Finding 7: `POST /api/themes/import` returns the committed `ThemeDetail` (etag included) so the Customizer adopts
   exactly what it saved; or detect a changed read-back revision and report a conflict. Contract § 16 first.
4. Finding 10: one shared rule set for packages (paths, types by folder, magic bytes, licence text bytes, file count,
   symlink metadata, sizes) used by both the browser reader and the server — a shared module in `packages/contract`
   (pure, no Node APIs) plus a common accept/reject fixture corpus run against both.

## H3 — decision boundaries, chat-first escape path, colour-mode reset (findings 6, 8, 9)
1. Finding 6: protect and vet the whole decision: the add-coding-agent form (context, warnings, fields **and** the
   "Add coding agent" button), and treat the task drawer's request text and its buttons as one decision surface
   (vetting the click checks the whole decision). Regressions submit the real forms.
2. Finding 8: the chat-first view mounts the command palette (and its shortcut) and has a protected way back to the
   admin view/Settings and to "Reset look", visible in every layout including a hidden sidebar.
3. Finding 9: the host reset generation also clears the device's light/dark choice (memory and storage), with a test
   together with the host reset.

Rules: AGENTS.md; contract doc first; no new dependencies; one commit per item ("H1 #n: …"); targeted tests while
working, then one full `pnpm check` + one full `pnpm e2e` (ports H1 5860, H2 5870, H3 5880). Migration numbers if needed:
H2 0079.
