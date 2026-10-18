# Phase 9 third gate — Codex gpt-6.1-sol, max, read-only (2026-10-18)

Prompt: `~/.score/codex/9-phase-regate3.prompt.md` (guarantee wording, as regate2, plus a status request for the second
review's 10 items). Raw output below, then the lead's verdicts.

## Lead verdicts

| # | Finding | Verdict | Goes to |
|---|---|---|---|
| 1 | Coding-agent form fields (runtime, name, role, workspace) hideable via `label { opacity:0 }` | **Accepted** — `data-decision` only vets marked surfaces | I1 |
| 2 | `:root::selection` (and other highlight pseudos) cross the protected boundary | **Accepted** (not rendered by the reviewer; I1 reproduces in Chromium first) | I1 |
| 3 | An allowed background in an agent colour erases a bare glyph / Needs-you dot at 1:1 | **Accepted** | I1 |
| 4 | Reads during an unsettled recovery serve CSS/etag A with asset bytes B | **Accepted** | I2 |
| 5 | Manifest label `" "` blanks the Settings destination | **Accepted** | I1 |
| 6 | Package disagreement outside the corpus (directory metadata, CSS comment / escaped asset refs) | **Accepted** | I2 |
| — | "Click-time check cannot block a decision under the default look" | **Rejected**: by design. The default look loads no theme CSS, so there is nothing for the guard to attribute; the guard exists to catch a theme. | — |

Statuses "partly" in the tables map onto findings 1–6; no other open item.

## Raw review
**Phase 9 still fails the gate.** The fixes address the original examples, but protected appearance, complete decision boundaries, and package consistency still have gaps.

“Partly” below means the original example is fixed but the same failure category remains reachable.

First review’s 12 items:

| # | Status | Current evidence |
|---|---|---|
| 1. ZIP previews one theme, replaces another | **Closed** | Unicode-path extras are rejected in both readers; server-decoded names must match the canonical directory. [theme-package.ts:81](/home/raven/score/packages/contract/src/theme-package.ts:81), [package.ts:102](/home/raven/score/apps/server/src/themes/package.ts:102). |
| 2. Unprotected approval/permission surfaces | **Partly** | Permission fields, warnings and commit controls are protected, but several fields in the coding-agent decision remain outside protection. Finding 1 below. [CodingAgent.tsx:204](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:204). |
| 3. Invisible approval spans | **Partly** | Direct descendant styling is excluded and text-bearing spans are measured. Ancestor highlight styling still crosses the boundary. [sanitise.ts:66](/home/raven/score/apps/web/src/themes/sanitise.ts:66), [guard.ts:252](/home/raven/score/apps/web/src/themes/guard.ts:252). |
| 4. Contrast checks fail open | **Partly** | Computed-colour parsing and AA thresholds are implemented; highlighted text and non-text graphics remain outside the effective contrast checks. Findings 2–3. [guard.ts:208](/home/raven/score/apps/web/src/themes/guard.ts:208). |
| 5. Agent glyphs erased/changed | **Partly** | Geometry changes are blocked, but an allowed background can erase a bare glyph at 1:1 contrast without a violation. [guard.ts:299](/home/raven/score/apps/web/src/themes/guard.ts:299). |
| 6. Delayed/interaction CSS | **Partly** | Motion and unsafe ancestor properties are rejected; highlight-driven appearance changes remain unmeasured. [sanitise.ts:253](/home/raven/score/apps/web/src/themes/sanitise.ts:253), [guard.ts:444](/home/raven/score/apps/web/src/themes/guard.ts:444). |
| 7. Asset/licence changes bypass If-Match | **Closed** | Every committed write takes a persisted revision. Asset-only, licence-only and recreation regressions exist. [store.ts:218](/home/raven/score/apps/server/src/themes/store.ts:218), [routes.test.ts:413](/home/raven/score/apps/server/test/themes/routes.test.ts:413). |
| 8. Settings/palette hideable | **Partly** | CSS protection and access paths are present, but the manifest can give Settings an invisible label. Finding 5. [themes.ts:120](/home/raven/score/packages/contract/src/themes.ts:120). |
| 9. Reset fails with blocked storage | **Closed** | Memory changes before persistence; the throwing-storage regression covers reset. [look-store.ts:83](/home/raven/score/apps/web/src/themes/look-store.ts:83), [look-store.test.ts:37](/home/raven/score/apps/web/src/themes/look-store.test.ts:37). |
| 10. Host reset misses device overrides | **Closed** | Generation advancement clears the device theme, cache and colour choice, including memory. [look-store.ts:110](/home/raven/score/apps/web/src/themes/look-store.ts:110). |
| 11. Failed swaps lose assets | **Partly** | Rollback, journaling and write locks exist; reads can still expose mixed versions while recovery is unsettled. Finding 4. [store.ts:396](/home/raven/score/apps/server/src/themes/store.ts:396). |
| 12. Upgrade recovery takes another folder | **Closed** | The selected destination is recorded before moving, and recovery follows that mapping. The orphan-folder regression exists. [store.ts:471](/home/raven/score/apps/server/src/themes/store.ts:471), [store-swap.test.ts:208](/home/raven/score/apps/server/test/themes/store-swap.test.ts:208). |

Second review’s 10 items:

| # | Status | Current evidence |
|---|---|---|
| 1. Unicode ZIP naming disagreement | **Closed** | Shared validation rejects `0x7075` in either header; decoded server names are cross-checked. [theme-package.ts:73](/home/raven/score/packages/contract/src/theme-package.ts:73). |
| 2. Unsettled recovery mixes versions | **Partly** | Further writes are blocked, but detail/CSS/asset/export reads are not. [store.ts:272](/home/raven/score/apps/server/src/themes/store.ts:272), [themes.ts:95](/home/raven/score/apps/server/src/http/themes.ts:95). |
| 3. Ancestor styling damages protected content | **Partly** | Spacing and transforms are rejected; trusted typography is present. Ancestor highlights and backgrounds still affect protected painting. Findings 2–3. [protected.css:34](/home/raven/score/apps/web/src/styles/protected.css:34). |
| 4. Clipping/overlay blind spots | **Partly** | Clipping intersections and stricter hits are implemented, but hit-testing ordinary elements does not establish that highlighted text remains readable. [guard.ts:107](/home/raven/score/apps/web/src/themes/guard.ts:107), [guard.ts:155](/home/raven/score/apps/web/src/themes/guard.ts:155). |
| 5. Glass/picture Settings contrast | **Closed** | Protected navigation gets an opaque background; translucent critical colour pairs trigger fallback. A real-browser regression covers the black-picture case. [protected.css:56](/home/raven/score/apps/web/src/styles/protected.css:56), [themes-boundary.spec.ts:68](/home/raven/score/e2e/themes-boundary.spec.ts:68). |
| 6. Incomplete decision boundary | **Partly** | Task request/buttons are grouped and coding-agent commit controls are protected. Unmarked coding-agent fields are still omitted from vetting. [guard.ts:406](/home/raven/score/apps/web/src/themes/guard.ts:406). |
| 7. Save adopts another writer’s etag | **Closed** | Import returns detail within the serialized write; the editor adopts that response without fetching again. [themes.ts:213](/home/raven/score/apps/server/src/http/themes.ts:213), [Customizer.tsx:406](/home/raven/score/apps/web/src/routes/customizer/Customizer.tsx:406). |
| 8. Chat-first escape path missing | **Closed** | `/u` mounts the palette and protected Way back controls independently of the sidebar. [UserShell.tsx:68](/home/raven/score/apps/web/src/routes/user/UserShell.tsx:68), [UserShell.tsx:133](/home/raven/score/apps/web/src/routes/user/UserShell.tsx:133). |
| 9. Host reset preserves device colour | **Closed** | Generation changes call `forgetStoredTheme()`; storage and memory regressions exist. [look-store.ts:113](/home/raven/score/apps/web/src/themes/look-store.ts:113), [use-look.test.tsx:116](/home/raven/score/apps/web/src/themes/use-look.test.tsx:116). |
| 10. Browser/server package disagreement | **Partly** | All 42 corpus cases agree, but directory metadata and CSS asset-reference cases outside the corpus still disagree. Finding 6. |

Remaining findings, most important first:

1. **P1 — The coding-agent decision still permits hidden fields.**  
   [CodingAgent.tsx:212](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:212), [CodingAgent.tsx:286](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:286), [guard.ts:406](/home/raven/score/apps/web/src/themes/guard.ts:406).

   Both filters accept `.team-routine-form > label { opacity:0 }`. The runtime, name, role and workspace labels/fields disappear. `data-decision` groups only the marked protected surfaces; these fields are not among them. My controlled-style probe returned **no violation, no click problem and no submit problem**.

   **Fix:** protect the complete form or every decision field. Add a real-form regression using accepted theme CSS and verify submission is refused while any decision context is hidden.

2. **P1 — Root highlight styles cross the protected boundary.**  
   [sanitise.ts:120](/home/raven/score/apps/web/src/themes/sanitise.ts:120), [protected.css:77](/home/raven/score/apps/web/src/styles/protected.css:77), [guard.ts:40](/home/raven/score/apps/web/src/themes/guard.ts:40).

   Both filters accept:

   ```css
   :root::selection { color:transparent; background-color:transparent }
   ```

   Confinement checks the originating root, which is outside protection. Highlight styles inherit through descendants separately from ordinary element styles, so selected approval text can disappear despite its normal computed colour remaining readable. Neither the protected pseudo-element rules nor the guard cover this painting. This conclusion follows the [CSS highlight inheritance and painting rules](https://drafts.csswg.org/css-pseudo-4/#highlight-cascade); it was not rendered in Chromium here.

   I also reproduced acceptance inside nested `@media`/`@layer`, using `:is(:root, html):has(body)::selection`. Those wrappers preserve the exclusion suffix correctly; they do not stop an ancestor’s highlight inheritance.

   **Fix:** reject highlight selectors in theme CSS, or assert trusted highlight styles throughout protected subtrees. Add browser regressions for selection and other supported highlight pseudos.

3. **P1 — Allowed backgrounds erase protected glyphs and markers.**  
   [RoomLink.tsx:69](/home/raven/score/apps/web/src/routes/chat/RoomLink.tsx:69), [agent-glyph.css:61](/home/raven/score/apps/web/src/components/agent-glyph.css:61), [guard.ts:208](/home/raven/score/apps/web/src/themes/guard.ts:208), [guard.ts:299](/home/raven/score/apps/web/src/themes/guard.ts:299).

   `.chat-active-agents { background-color:#6b4eff }` passes both filters and makes a bare glyph of that colour disappear at **1:1 contrast**. The shape still paints with unchanged geometry, so its signature passes. The SVG surface has no measured text/control contrast. The guard probe returned **null**.

   Empty Needs-you dots have the same missing contrast check against their surroundings.

   **Fix:** give these graphics a trusted contrasting backplate/outline and enforce non-text contrast against their actual backgrounds. Test painted distinction, including bare SVGs.

4. **P1 — Unsettled recovery still serves mixed package versions.**  
   [store.ts:197](/home/raven/score/apps/server/src/themes/store.ts:197), [store.ts:323](/home/raven/score/apps/server/src/themes/store.ts:323), [themes.ts:95](/home/raven/score/apps/server/src/http/themes.ts:95), [themes.ts:112](/home/raven/score/apps/server/src/http/themes.ts:112).

   Fault injection reproduced: install A → move B’s files into place → row commit fails → rollback remains blocked. Writes correctly raise `ThemeLockedError`, but reads return **CSS A, etag A and asset bytes B**. Startup also continues serving routes when recovery retains a failed note. Eventual successful recovery restores A, but reads before then expose an incoherent package.

   **Fix:** serve the previous committed folder using the journal, or reject affected package reads with `theme_recovering` until settled. Cover detail, stylesheet, assets and export in fault tests.

5. **P1 — Manifest labels can erase the Settings destination.**  
   [themes.ts:120](/home/raven/score/packages/contract/src/themes.ts:120), [layout.ts:116](/home/raven/score/apps/web/src/themes/layout.ts:116), [MainNav.tsx:41](/home/raven/score/apps/web/src/shell/MainNav.tsx:41).

   `{ "to":"/settings", "label":" " }` validates and becomes the rendered Settings label. The link and palette destination have no readable destination name. CSS protection cannot restore text that the manifest removed.

   **Fix:** reject labels containing no visible characters, provide the Settings fallback, and retain a trusted accessible destination name. Test whitespace and invisible formatting characters.

6. **P1 — Package validation still disagrees outside the corpus.**  
   [theme-package.ts:204](/home/raven/score/packages/contract/src/theme-package.ts:204), [package.ts:102](/home/raven/score/apps/server/src/themes/package.ts:102), [draft.ts:379](/home/raven/score/apps/web/src/themes/customizer/draft.ts:379).

   Actual-reader probes found:

   - `theme.json` marked with Unix directory mode `040755`, or the DOS directory flag: **browser accepts; server rejects**. Shared classification uses the trailing slash; JSZip also interprets directory metadata.
   - Valid CSS containing only the comment `/* Example asset:img/missing.png */`: **browser rejects; server accepts**. Browser reference collection scans raw text.
   - An escaped asset reference with a missing file: **browser accepts; server rejects**.

   **Fix:** canonicalize directory metadata in the shared ZIP rules and share CSS-aware asset-reference extraction. Add these cases to the common corpus.

**The click-time check cannot block a decision under the actual Score default look.** It returns immediately unless `data-look="custom"`; applying Score removes that attribute. [guard.ts:426](/home/raven/score/apps/web/src/themes/guard.ts:426), [engine.ts:293](/home/raven/score/apps/web/src/themes/engine.ts:293).

What is solid:

- The allowlist blocks the earlier positioning, transform, clipping, spacing and motion declarations.
- Conditional writes cover committed asset/licence changes; import returns its committed revision.
- Reset implementations now cover blocked storage and host generation changes, including device colour.
- Theme asset URL isolation and font namespacing remain intact.
- All **42 package cases through both readers** and **35 shared CSS scanner cases** passed native assertions. Harbour, Ledger and Studio preserved asset bytes and licence texts through in-memory round-trips.

UI guard probes used jsdom with controlled geometry; recovery probes used the actual store with virtual filesystem fault injection and in-memory SQLite. Vitest failed during temporary-directory setup before running tests; full `pnpm check` and Chromium e2e remain unverified. I changed no repository files and left the existing `CHANGELOG.md` modification untouched.