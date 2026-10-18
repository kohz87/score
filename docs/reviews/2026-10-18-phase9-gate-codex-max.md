**Phase 9 does not pass the gate.** I found these guarantee-breaking issues:

1. **P1 — A ZIP can preview one theme and replace another.** [customizer/zip.ts:178](/home/raven/score/apps/web/src/themes/customizer/zip.ts:178), [server/package.ts:157](/home/raven/score/apps/server/src/themes/package.ts:157).  
   The browser reads central-directory filenames; JSZip uses local-header filenames. Swapping `theme.json` and `style.css` between those headers made both readers accept the same bytes as different manifests. With replacement checked, installation can overwrite a different existing theme from the one reviewed. **Fix:** reject disagreement between local and central headers on both sides; add a regression proving neither theme changes.

2. **P1 — Some approval and permission surfaces have no protection.** [TaskDrawer.tsx:196](/home/raven/score/apps/web/src/routes/tasks/TaskDrawer.tsx:196), [CodingAgent.tsx:104](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:104).  
   `.task-drawer-approval { display:none }` hides the request while leaving “Approve once” available. `.team-coding-permission { display:none }` hides the creation form’s permission controls and sandbox warning. Both pass sanitisation; neither affected subtree is guarded. **Fix:** protect the complete decision context, controls, warnings and password fields, and exercise these actual workflows in safety e2e.

3. **P1 — Protected approval titles and descriptions can become invisible.** [guard.ts:23](/home/raven/score/apps/web/src/themes/guard.ts:23).  
   `TEXT_PARTS` omits spans, including the approval title and description. `div[aria-label^="Approval:"] > div:first-child > span { color:transparent }` passes both checks and leaves the guard satisfied while the decision buttons remain visible. **Fix:** inspect every rendered text-bearing element, and exclude protected descendants from arbitrary theme styling.

4. **P1 — Contrast checks fail open on valid computed colours.** [guard.ts:35](/home/raven/score/apps/web/src/themes/guard.ts:35), [guard.ts:100](/home/raven/score/apps/web/src/themes/guard.ts:100).  
   An approval button styled with `color:color(srgb 1 1 1); background-color:white` becomes unreadable. `parseColor()` returns null, which skips rejection. The existing `parseComputedColor()` handles this form. Even measured normal text is accepted down to 3:1 instead of the promised 4.5:1. **Fix:** use computed-colour parsing, enforce AA thresholds, and provide a safe fallback when measurement fails.

5. **P1 — Themes can erase or change agent glyph shapes.** [protected.css:11](/home/raven/score/apps/web/src/styles/protected.css:11), [guard.ts:105](/home/raven/score/apps/web/src/themes/guard.ts:105).  
   SVG descendants are excluded from protection and guard targets. `:root svg path { opacity:0 }` passes both sanitisers and erases path-based glyphs without changing their wrapper geometry. CSS `d:path(...)` can replace their geometry. **Fix:** prevent theme rules from reaching protected SVG subtrees and test painted geometry, not wrapper visibility alone.

6. **P1 — Delayed and interaction-driven CSS bypasses the guard.** [guard.ts:177](/home/raven/score/apps/web/src/themes/guard.ts:177).  
   A delayed animation setting `.page-content` opacity to zero passes the initial check. Animation progress and hover/focus style changes cause neither the observed DOM mutations nor window resizing, so protected content can disappear afterward. **Fix:** prevent unsafe effects on protected ancestry; any retained runtime enforcement must cover CSS-driven changes before decisions remain actionable.

7. **P1 — Asset-only and licence-only changes bypass `If-Match`.** [store.ts:58](/home/raven/score/apps/server/src/themes/store.ts:58).  
   Etags hash only manifest and CSS. I changed an image’s bytes and licence text without changing either; the etag stayed identical, and a second stale conditional replacement returned **201**, overwriting the first change. **Fix:** use a persisted revision or hash covering the complete package. Test concurrent asset-only and licence-only replacements.

8. **P1 — Settings and the palette escape hatch remain hideable.** [MainNav.tsx:33](/home/raven/score/apps/web/src/shell/MainNav.tsx:33), [CommandPalette.tsx:117](/home/raven/score/apps/web/src/shell/CommandPalette.tsx:117).  
   `a[href="/settings"], .command-run { display:none }` passes sanitisation. On a healthy installation without the Settings warning dot, these elements have no protected descendant that would trigger recovery. **Fix:** protect the mandatory Settings links and palette reset control, including their access paths.

9. **P1 — Device reset fails when browser storage is blocked.** [look-store.ts:75](/home/raven/score/apps/web/src/themes/look-store.ts:75), [look-store.ts:107](/home/raven/score/apps/web/src/themes/look-store.ts:107).  
   Reset relies entirely on writing `score.look.device`. If storage throws, `emit()` rereads storage and leaves the device override null or unchanged. Consequently, the shortcut, palette and Settings reset can keep the shared custom theme active. **Fix:** update authoritative in-memory state first and persist opportunistically. Test failing storage reads and writes.

10. **P1 — Host reset does not recover devices with overrides.** [look.mjs:34](/home/raven/score/scripts/look.mjs:34), [use-look.ts:115](/home/raven/score/apps/web/src/themes/use-look.ts:115).  
    The command resets shared settings only. I verified that after resetting shared state to Score/system, a browser retaining `score.look.device=hostile` still resolves to `hostile`. Reloading preserves it. **Fix:** introduce a server reset generation that invalidates older device overrides and caches; test the command together with a browser override.

11. **P1 — A failed asset swap leaves the installed theme without assets.** [store.ts:234](/home/raven/score/apps/server/src/themes/store.ts:234).  
    After moving the existing folder aside, failure of `renameSync(staged, target)` bypasses the rollback catch. I reproduced the old database row remaining while its asset list became empty and its files were stranded under `.old-*`. **Fix:** restore the old folder after any subsequent failure, and reconcile interrupted swaps on startup. Inject failures at each transition.

12. **P1 — Upgrade recovery can attach another folder’s assets.** [store.ts:266](/home/raven/score/apps/server/src/themes/store.ts:266).  
    With an orphan `harbour-mine` directory present, migration correctly chooses `harbour-mine-2`. If interrupted after moving the folder but before committing the row, restart instead assumes `harbour-mine` was the interrupted destination. I reproduced unrelated assets being attached while the correct assets remained stranded in `harbour-mine-2`. **Fix:** persist the chosen rename mapping before moving files; never infer ownership from directory existence.

The execution and licensing boundaries have useful foundations: strict manifests, bounded inflation, asset type checks, exact MIME types, production CSP, and licence preservation. I found no package-driven JavaScript execution or external exfiltration path under that CSP. Built-in fonts match their installed OFL sources byte-for-byte, licence round-trips passed, and shipped art matches its generator. The dependency inventory had zero policy violations across 551 packages.

Existing tests miss the cases above; mocked theme endpoints cannot prove ZIP agreement, and glyph visibility cannot prove shape integrity. Validation used the real ZIP readers/import handler, in-memory SQLite/filesystem fault injection, and jsdom/React reproductions with mocked geometry. Full suites and Playwright were not run under the read-only sandbox. No repository files were changed.
## Lead response (2026-10-18)
Gate **failed**; all 12 findings accepted for fixing before v1.8.0 (none rejected; each fix must come with a test that
fails first, which also verifies the finding). v1.8.0 is held. Grouped into three parallel tasks:
- **G1 protection model** (#2, #3, #4, #5, #6, #8): theme CSS must not reach inside protected subtrees at all (CSS
  `@scope` with a lower boundary at `[data-protected]`, or equivalent), protected ancestors' visibility verified at the
  moment a decision is acted on, the guard parses computed colours and enforces AA, glyph SVGs and the mandatory
  Settings/palette reset entries protected; safety e2e on the real workflows (task drawer, add-agent form).
- **G2 server and storage** (#1, #7, #11, #12): zip local/central header agreement on both readers; a whole-package
  revision for If-Match; asset swap rollback and startup reconciliation; persisted rename mapping for the upgrade step.
- **G3 escape hatches** (#9, #10): in-memory reset state first; a server reset generation that invalidates device
  overrides and boot caches.
Then a re-gate at max effort.
