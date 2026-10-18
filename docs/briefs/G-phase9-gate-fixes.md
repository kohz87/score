# Phase 9 gate fixes — G1, G2, G3 (decision 101)

Source: `docs/reviews/2026-10-18-phase9-gate-codex-max.md` (12 P1 findings, numbered #1–#12 there; read the exact
scenarios). Every fix lands with a test that **fails before the fix** (show it in your report) — this also verifies the
finding; if a finding turns out not to reproduce, say so with evidence instead of fixing blind.

## G1 — protection model (#2, #3, #4, #5, #6, #8) — web only
- Theme CSS must not apply **inside** protected subtrees at all: wrap the sanitised theme stylesheet (and the
  generated token sheet's rules other than custom properties) so no theme rule matches a `[data-protected]` element or
  its descendants — e.g. CSS `@scope (:root) to ([data-protected]) { … }` (donut scope) applied by the engine, keeping
  the sanitiser and `score-protected` layer as further lines. Check browser support (Chromium/Firefox/Safari current) and
  keep a correct fallback (the existing behaviour plus the runtime guard) where unsupported.
- Mark the full decision context as protected: task drawer approval (#2 `.task-drawer-approval`), the add-coding-agent
  permission controls, sandbox warning and password fields (#2), every approval/decision text element (#3), agent glyph
  SVG subtrees (#5), the mandatory Settings links and the palette's "Reset look" entry and its access path (#8).
- Ancestors: a theme can still hide a protected surface via an ancestor (opacity/visibility/filter/clip/transform/
  animation/hover). Add a **decision-time check**: before an approve/deny/answer/permission/password action runs, verify
  the control and its decision text are actually visible and readable (computed styles up the ancestor chain, painted
  hit-test at the control); if not, refuse the action, switch to the safe look and say why. Also re-run the guard on
  `animationstart/animationend/transitionend`, `pointerover`, `focusin` (#6), and/or have the sanitiser drop
  `animation`/`transition`/`@keyframes` that target opacity/visibility/clip/filter/transform — choose and justify.
- Guard (#4): use `parseComputedColor` (9.4) everywhere, enforce AA (4.5:1 normal, 3:1 large/UI), and **fail closed**
  (safe look) when a colour can't be measured.
- Safety e2e on the real workflows: task drawer approval, add-coding-agent form, approval card spans, glyph paths,
  delayed animation, hover, Settings/palette hidden — each attempt must leave the decision visible/actionable or fall
  back to the safe look.

## G2 — server and storage (#1, #7, #11, #12)
- #1: both zip readers (browser `customizer/zip.ts`, server `themes/package.ts`) reject a package whose local-header
  and central-directory names (and sizes) disagree, or that has duplicate names; regression with a crafted zip proving no
  theme changes.
- #7: the etag/If-Match covers the whole package (manifest, CSS, every asset's bytes, licence files) — a persisted
  revision counter or a full-package hash; tests for asset-only and licence-only concurrent replacements (contract § 16
  wording updated if needed).
- #11: asset swap restores the old folder after any later failure and startup reconciles interrupted swaps; inject a
  failure at each transition.
- #12: persist the chosen rename mapping before moving files; recovery uses the mapping, never directory existence.

## G3 — escape hatches (#9, #10)
- #9: the device reset updates authoritative in-memory state first and persists opportunistically; works when
  localStorage reads/writes throw (test with a throwing storage).
- #10: `scripts/score look reset` bumps a server **reset generation** (setting, exposed in `GET /api/themes` and the
  `look.changed` event); a browser whose override/boot cache predates the current generation drops them. Contract § 16
  first. Test the command together with a browser override.

Rules for all: AGENTS.md; contract doc first for any API change; no new dependencies; one commit per finding
("G1 #n: …" referencing the finding number); targeted tests while working, then one full `pnpm check` and one full
`pnpm e2e` (ports: G1 5800, G2 5810, G3 5820).
