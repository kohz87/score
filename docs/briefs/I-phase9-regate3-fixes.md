# Phase 9 third-gate fixes — I1, I2

Source: `docs/reviews/2026-10-18-phase9-regate3-codex-max.md` (findings 1–6 and the lead's verdicts). Every fix lands
with a test that fails before it (show it); if something doesn't reproduce, say so with evidence. Decision 102 stands:
theme CSS is visual-only; prefer tightening the shared allowlist or trusted CSS over more guard heuristics.

## I1 — web and contract (findings 1, 2, 3, 5)
1. **Finding 1:** the whole add-coding-agent decision is vetted: every field and label of the form (runtime, name, role,
   workspace, model, permissions, password, warnings, the commit button) counts. Either protect the complete form or make
   `decisionSurfaces` measure every labelled control inside a `data-decision`, not only marked surfaces. Regression:
   real-form submit with *accepted* theme CSS (`.team-routine-form > label { opacity:0 }`, through the sanitiser) is
   refused and nothing is posted. Check the task drawer's decision has no unvetted part either.
2. **Finding 2:** reject highlight pseudo-elements in theme CSS (`::selection`, `::highlight()`, `::target-text`,
   `::spelling-error`, `::grammar-error`, and any future `::*` not explicitly allowed) in the shared allowlist
   (`packages/contract/src/theme-css.ts`), and assert trusted `::selection` colours on `[data-protected]` subtrees in
   `protected.css` as defence in depth. Reproduce in Chromium (e2e) first: selected approval text with the rule slipped
   in after the sanitiser. List any pseudo-element the allowlist still permits and why.
3. **Finding 3:** agent glyphs and Needs-you markers stay distinguishable on any allowed background: a trusted
   contrasting backplate or outline (Score's own `--card`/ink ring) in protected CSS, and the guard checks non-text
   contrast (≥ 3:1, WCAG 1.4.11) of the glyph against its actual painted background. Regression: `.chat-active-agents {
   background-color:<the agent colour> }` keeps the glyph visible (or switches the theme off). Default look stays
   pixel-identical unless the ring is already there; if baselines change, say which and why.
4. **Finding 5:** manifest menu labels must contain visible characters (reject whitespace-only and invisible formatting
   characters such as U+200B–U+200F, U+2060, U+FEFF) in the contract schema, and Settings keeps a trusted accessible name
   and visible fallback label whatever the manifest says. Tests for whitespace and each invisible character class.

Files: `apps/web/src/routes/team/CodingAgent.tsx`, `apps/web/src/themes/` (guard, sanitise, protected-surfaces),
`apps/web/src/styles/protected.css`, `apps/web/src/components/agent-glyph.css`, `packages/contract/src/theme-css.ts`,
`packages/contract/src/themes.ts`, `apps/web/src/shell/MainNav.tsx`, `apps/web/src/themes/layout.ts`, docs/THEMES.md,
API-CONTRACT § 16. Avoid `apps/server/src/themes/store.ts` and `theme-package.ts` (I2, C4).

## I2 — server and package rules (findings 4, 6)
1. **Finding 4:** while a swap note for an id is unsettled, package reads of that id (detail, `style.css`, assets,
   export) answer `409 theme_recovering` (or serve the previous committed folder via the journal — pick the simpler one
   that is never mixed, and document it). The list may show the theme but flagged. Fault-injection tests for each read.
   Also: startup that keeps a failed note logs it and keeps serving other themes.
2. **Finding 6:** the shared zip rules canonicalise directory metadata (Unix mode `040xxx`, DOS directory attribute
   `0x10`) so both readers agree (refuse a "file" marked as a directory); asset references are extracted CSS-aware in one
   shared function (comments ignored, CSS escapes decoded) used by the browser draft check and the server check. Add the
   three reviewer cases and their neighbours to the shared corpus.

Files: `apps/server/src/themes/` (store, routes in `http/themes.ts`, css-check), `packages/contract/src/theme-package.ts`,
`theme-css.ts` (asset-ref function only — coordinate: I1 edits the allowlist part), `apps/web/src/themes/customizer/
draft.ts`, the corpus. C4 is changing `PUT /api/themes/:id` and store.ts for assets in parallel; keep your store change
to the read path and the lock check so the lead can merge both.

## Both
Follow AGENTS.md. No new dependencies. Contract § 16 first for API changes. Don't commit with `git add -A`; commit per
finding ("I1 #<finding>: …"). Targeted tests while working; one full `pnpm check` and one full `pnpm e2e` at the end.
