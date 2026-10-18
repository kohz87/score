# Phase 9 fourth gate (scoped, decision 103) — Codex gpt-6.1-sol, max, read-only (2026-10-18)

Prompt: `~/.score/codex/9-phase-regate4.prompt.md`. Raw output below, then the lead's verdicts.

## Lead verdicts

| # | Finding | Verdict |
|---|---|---|
| Third-review 2–6 | Closed | Agreed. |
| 1 (P1) | A theme's own font (blank/substituted glyphs) on a decision's unmarked fields | **Accepted, fixed by the lead before release**: `[data-decision]` reads in Score's fonts (`protected.css`, tokens reset like protected surfaces) and the guard judges a theme-shipped font on decision fields too (a system font stays allowed). Failing-first unit test in `guard-decision.test.ts`; theme/Customizer/coding/team e2e 244/245 (the one failure, the new glyph-pixel test, passed 3/3 alone and 96/96 with its files repeated ×4). |
| 2 (P2) | After a *successful* replace, a stale editor reads the new asset bytes at the same path and "Save as new" can store A's manifest/CSS with B's assets | **Accepted, deferred to 1.8.1** under decision 103: package consistency during swaps is closed (I2); this is a two-editor staleness variant. Fix: revision-bound asset URLs that the server enforces, and copies built from one snapshot. First item of the post-release fix round. |

Escape hatches and code-execution/fetch categories: closed, no regression found.

## Raw review
**The scoped gate still fails:** finding 1 is partly closed. Findings 2–6 close their original reproductions. C4 also leaves a separate package-version mixing gap.

Reviewed `main` at `606ef768`.

| Third-review finding | Status | Evidence and verification |
|---|---|---|
| **1. Hidden coding-agent fields** | **Partly** | Whole-decision fields now enter measurement ([guard.ts:393](/home/raven/score/apps/web/src/themes/guard.ts:393)). The original opacity attack is refused. Theme fonts remain exempt for those fields; see P1 below. |
| **2. Ancestor highlight styles** | **Closed** | The shared selector check rejects unlisted pseudo-elements ([theme-css.ts:651](/home/raven/score/packages/contract/src/theme-css.ts:651)); protected selections get trusted colors ([protected.css:56](/home/raven/score/apps/web/src/styles/protected.css:56)). Both filters rejected selection, escaped selection, other highlights and legacy first-line/first-letter probes. |
| **3. Glyph/dot erased by matching background** | **Closed** | Bare glyphs receive a trusted plate and dots an ink edge ([protected.css:81](/home/raven/score/apps/web/src/styles/protected.css:81)); the guard measures non-text contrast ([guard.ts:68](/home/raven/score/apps/web/src/themes/guard.ts:68)). The original background attack now has a defense independent of the surrounding color. |
| **4. Mixed reads during unsettled recovery** | **Closed** | Package reads check the recovery lock ([store.ts:205](/home/raven/score/apps/server/src/themes/store.ts:205)). Fault injection produced `409 theme_recovering` for detail, stylesheet, asset and export; successful recovery restored the previous CSS, etag, assets and licences. Other themes and listing remained available. |
| **5. Invisible Settings label** | **Closed** | Manifest labels require visible characters ([themes.ts:133](/home/raven/score/packages/contract/src/themes.ts:133)); rendering supplies a fallback and trusted accessible name ([layout.ts:122](/home/raven/score/apps/web/src/themes/layout.ts:122)). Whitespace, formatting characters, blank fillers and combining-mark probes passed. |
| **6. Package-reader disagreement** | **Closed** | Shared ZIP rules reject conflicting directory metadata ([theme-package.ts:168](/home/raven/score/packages/contract/src/theme-package.ts:168)); both reference checks use the CSS-aware extractor ([theme-css-assets.ts:132](/home/raven/score/packages/contract/src/theme-css-assets.ts:132)). All **59 shared cases** agreed through both actual readers, including accepted package contents. |

Two guarantee violations remain, most severe first:

1. **P1 — Untrusted fonts can still make decision fields unreadable.**  
   [guard.ts:292](/home/raven/score/apps/web/src/themes/guard.ts:292), [CodingAgent.tsx:259](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:259).

   The new `context` handling deliberately skips theme-font rejection for unmarked decision fields. Both filters accept CSS such as:

   ```css
   .team-routine-form > label,
   .team-routine-form input { font-family: "theme-probe-Blank"; }
   ```

   A manifest-supplied font with blank or substituted glyphs can erase or alter field labels and values while retaining normal dimensions and nominal text contrast. The controlled-style probe returned **no periodic violation, no click problem and no submit problem**. The original opacity attack returned “label is faded.”

   **Fix:** enforce trusted typography throughout `data-decision`, or retain the theme-font rejection for decision context. Add a browser regression with an actual blank/substitution font and assert that submission sends nothing.

2. **P2 — Successful replacements still allow mixed-version reads and copies through C4.**  
   [themes.ts:153](/home/raven/score/apps/server/src/http/themes.ts:153), [save.ts:35](/home/raven/score/apps/web/src/themes/customizer/save.ts:35), [save.ts:44](/home/raven/score/apps/web/src/themes/customizer/save.ts:44).

   Asset URLs identify only the theme and path. They carry no enforced package revision. Reproduction through actual Fastify routes:

   - Read manifest/CSS/etag **A**.
   - Successfully PUT **B**, replacing an asset and licence at the same paths.
   - Read A’s asset URL: it returns **B’s bytes**, even with A’s etag supplied as `If-Match`.
   - “Save as new” assembles A’s manifest/CSS with B’s assets/licences; the C4 PUT accepts and stores that hybrid with **200**.

   No unsettled swap note exists in this scenario, so I2’s recovery refusal cannot prevent it.

   **Fix:** bind asset/licence reads to the expected package revision and reject stale reads, or obtain one coherent package snapshot and use its bytes throughout preview/copy. Versioned URLs must enforce the revision, rather than merely change cache keys.

**Escape-hatch and execution/external-fetch categories are closed in this scoped review; no regression found.** Safe URL and blocked-storage reset probes passed. C4’s conditional writes, concurrent-writer handling, package rejection and rollback passed the native probes. Paper/Night/Dense matched their browser packs. Eight unsafe CSS loading/execution forms were refused by both filters.

Validation used in-memory SQLite, a virtual filesystem and jsdom with controlled geometry. **Chromium rendering/e2e and full `pnpm check` remain unverified.** No repository files were changed; the existing `CHANGELOG.md` edit was untouched.