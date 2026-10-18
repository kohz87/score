**Phase 9 still fails the gate.** Three earlier gaps are closed; nine are partly closed.

| Earlier finding | Status | Evidence |
|---|---|---|
| **#1 ZIP previews one theme, installs another** | **Partly closed** | [zip-structure.ts:81](/home/raven/score/apps/server/src/themes/zip-structure.ts:81) checks raw header names, but Unicode filename extra fields still produce different browser/server interpretations. Finding 1 below. |
| **#2 Unprotected approval/permission surfaces** | **Partly closed** | The task approval and permission fieldset are marked. The add-coding-agent commit button and enclosing form remain unprotected: [CodingAgent.tsx:354](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:354). |
| **#3 Invisible approval spans** | **Partly closed** | [guard.ts:172](/home/raven/score/apps/web/src/themes/guard.ts:172) now finds text regardless of tag; confinement blocks direct styling. Ancestor typography and transforms remain effective. |
| **#4 Contrast fails open** | **Partly closed** | Computed-colour parsing and AA thresholds are present, but [guard.ts:149](/home/raven/score/apps/web/src/themes/guard.ts:149) still accepts equally unmeasurable/sub-AA baselines, and page pictures are deliberately ignored. |
| **#5 Glyph shapes erased/changed** | **Partly closed** | [guard.ts:204](/home/raven/score/apps/web/src/themes/guard.ts:204) compares path geometry and paint; direct subtree styling is excluded. Ancestor transforms can still change the painted shape without detection. |
| **#6 Delayed/interaction CSS** | **Partly closed** | Motion properties are dropped and interaction checks added. Remaining clipping/overlay blind spots and incomplete decision boundaries still bypass enforcement. |
| **#7 Asset/licence changes bypass If-Match** | **Closed** | [store.ts:206](/home/raven/score/apps/server/src/themes/store.ts:206) assigns a persisted global revision on every write. Asset-only, licence-only and recreation regressions are covered in [routes.test.ts:340](/home/raven/score/apps/server/test/themes/routes.test.ts:340) and store tests. |
| **#8 Settings/palette hideable** | **Partly closed** | Admin Settings links and palette are protected. The chat-first view still lacks the palette and has an unprotected path back to admin/Settings. |
| **#9 Reset fails with blocked storage** | **Closed** | [look-store.ts:79](/home/raven/score/apps/web/src/themes/look-store.ts:79) changes authoritative memory before persistence; throwing-storage regression exists. |
| **#10 Host reset misses device overrides** | **Partly closed** | Reset generation invalidates theme overrides/cache, but leaves the per-device colour-mode choice active. |
| **#11 Failed swaps lose assets** | **Partly closed** | Ordinary rollback/startup recovery is implemented. A new replacement can proceed with an unresolved older journal entry, causing mixed versions later. |
| **#12 Upgrade recovery takes another folder** | **Closed** | [store.ts:431](/home/raven/score/apps/server/src/themes/store.ts:431) records the chosen destination before moving; recovery follows it. The orphan-folder regression is covered. |

Remaining findings, most important first:

1. **P1 — Unicode ZIP extra fields still permit the wrong theme to be replaced.**  
   [zip-structure.ts:63](/home/raven/score/apps/server/src/themes/zip-structure.ts:63), [package.ts:166](/home/raven/score/apps/server/src/themes/package.ts:166), [ImportDialog.tsx:113](/home/raven/score/apps/web/src/routes/customizer/ImportDialog.tsx:113).

   I constructed matching local/central raw filenames with valid `0x7075` Unicode-path overrides. Both readers accepted the bytes: the browser reported manifest ID **`reviewed`**, while the server reported **`other-theme`**. The structure checker passes because it checks raw names; JSZip subsequently honours the alternate names. With replacement checked, the original wrong-target overwrite remains possible.

   **Fix:** reject naming-changing extra fields, or compare every decoded JSZip filename against the validated canonical entry. Add this package to both-reader and import-handler regressions.

2. **P1 — An unresolved swap can overwrite a later successful installation’s assets.**  
   [store.ts:265](/home/raven/score/apps/server/src/themes/store.ts:265), [store.ts:382](/home/raven/score/apps/server/src/themes/store.ts:382).

   `recoverInterrupted()` retains failed notes but returns normally; `storeImported()` proceeds. I reproduced: install A → replacement B fails and cannot restore A → retry C succeeds while recovery still fails → later recovery restores A’s folder. Final state: **database/CSS C, asset bytes A**.

   **Fix:** block further mutations for affected IDs until recovery succeeds. Apply that restriction to replacement, deletion and reclamation. Add a retry-before-successful-recovery fault test.

3. **P1 — Ancestor styling can make protected text unreadable and transform glyphs without either check noticing.**  
   [sanitise.ts:66](/home/raven/score/apps/web/src/themes/sanitise.ts:66), [guard.ts:90](/home/raven/score/apps/web/src/themes/guard.ts:90), [guard.ts:204](/home/raven/score/apps/web/src/themes/guard.ts:204).

   These accepted rules illustrate the problem:

   ```css
   :root { word-spacing: -100px; }
   .chat-message { transform: scaleY(-1); }
   ```

   The first reaches approval text through inheritance; its stretched flex boxes can retain their dimensions while words overlap. The second flips decision text and triangle/star glyphs through their ancestor. The guard measures neither inherited word spacing nor ancestor transforms; path-local signatures remain unchanged. Controlled-style/geometry probes returned **no violation and no decision problem**.

   **Fix:** establish trusted typography and ancestor geometry for protected surfaces. Selector exclusion alone cannot provide this guarantee.

4. **P1 — Overflow clipping and permitted overlays evade visibility enforcement.**  
   [guard.ts:71](/home/raven/score/apps/web/src/themes/guard.ts:71), [guard.ts:115](/home/raven/score/apps/web/src/themes/guard.ts:115), [guard.ts:303](/home/raven/score/apps/web/src/themes/guard.ts:303).

   An ancestor such as `.chat-message { height:1px; overflow:clip }` can clip its protected contents while those contents retain client rectangles. `visiblePoint()` returns null for the clipped point, which skips the coverage check. The click-time check also accepts an ancestor returned by hit-testing. My controlled probe passed both checks.

   Separately, all fixed/sticky overlays are exempted as supposedly Score-owned. Yet `position:var(--pin)` with `--pin:fixed` passes [sanitise.ts:179](/home/raven/score/apps/web/src/themes/sanitise.ts:179). Themes can also enlarge an existing pseudo-element, such as [user.css:318](/home/raven/score/apps/web/src/routes/user/user.css:318), and reuse its sticky origin to cover decisions.

   **Fix:** measure clipping intersections; verify painted hits rather than accepting arbitrary ancestors; remove the blanket floating-overlay exemption. Reject unresolved positioning values or validate their computed effect.

5. **P1 — Glass over a background picture can leave protected Settings text below AA.**  
   [guard.ts:43](/home/raven/score/apps/web/src/themes/guard.ts:43), [contrast.ts:52](/home/raven/score/apps/web/src/themes/contrast.ts:52), [variants.css:258](/home/raven/score/apps/web/src/themes/variants.css:258).

   A left-rail, glass theme with a black picture and `dim:0` puts the inactive protected Settings label over 70% white glass. Using Score’s normal muted text, the actual contrast is **2.90:1**; the checker calculates **5.84:1** because it ignores the picture. The manifest fallback does not trigger.

   Furthermore, `withoutTheme()` removes sheets but retains theme layout/variant attributes, weakening its baseline comparison.

   **Fix:** give protected navigation and controls opaque trusted backgrounds, or include actual/worst-case picture colours. Enforce AA independently of the retained theme attributes.

6. **P1 — The add-coding-agent commit control is still hideable and unvetted.**  
   [CodingAgent.tsx:202](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:202), [CodingAgent.tsx:354](/home/raven/score/apps/web/src/routes/team/CodingAgent.tsx:354), [guard.ts:317](/home/raven/score/apps/web/src/themes/guard.ts:317).

   `.team-file-actions .team-primary { display:none }` hides “Add coding agent” while protected permission/password fields remain intact. Neither the button nor its form has a protected ancestor, so click/submit vetting returns immediately. The new e2e checks fields and warnings but never commits this form.

   Task-drawer request text and approval buttons also occupy separate protected surfaces; clicking the button checks only its nearest surface.

   **Fix:** protect and vet the complete decision boundary: context, warnings, fields and committing controls. Exercise actual submission in regressions.

7. **P1 — The ZIP-save flow can associate another writer’s etag with the old draft.**  
   [Customizer.tsx:404](/home/raven/score/apps/web/src/routes/customizer/Customizer.tsx:404), [Customizer.tsx:414](/home/raven/score/apps/web/src/routes/customizer/Customizer.tsx:414), [draft.ts:529](/home/raven/score/apps/web/src/themes/customizer/draft.ts:529).

   After a conditional ZIP save, the client separately fetches detail. Another writer can replace the package between those requests. The client adopts that writer’s etag, while `afterSave()` retains the submitted CSS/uploads/licences. A subsequent save can therefore overwrite the intervening changes using an etag for content the editor never loaded.

   **Fix:** return the committed revision/detail from the import operation, or detect a changed read-back revision and report a conflict. Test an intervening CSS-only or asset-only writer.

8. **P1 — Chat-first view lacks the promised protected UI escape path.**  
   [UserShell.tsx:14](/home/raven/score/apps/web/src/routes/user/UserShell.tsx:14), [AvatarMenu.tsx:41](/home/raven/score/apps/web/src/shell/AvatarMenu.tsx:41), [AppShell.tsx:39](/home/raven/score/apps/web/src/shell/AppShell.tsx:39).

   `/u` mounts neither the command palette nor its shortcut. Its route back to admin/Settings uses the unprotected avatar menu; `.avatar-menu { display:none }` removes it without triggering recovery. The conversation-menu opener is unprotected too.

   **Fix:** mount the reset command globally and provide a protected Settings/reset access path in the user shell, including hidden-sidebar layouts.

9. **P1 — Host reset does not clear every per-device choice.**  
   [look-store.ts:108](/home/raven/score/apps/web/src/themes/look-store.ts:108), [use-look.ts:135](/home/raven/score/apps/web/src/themes/use-look.ts:135).

   Reset generation removes theme selection/cache but leaves `score.theme`. I verified that a stored `dark` choice survives generation advancement; `stored ?? sharedMode` then overrides the host’s reset to `system`.

   **Fix:** invalidate the device colour-mode choice with the same generation, including its in-memory state, and test it with the host reset.

10. **P1 — Browser/server package validation still disagrees beyond filenames.**  
    [web/package.ts:36](/home/raven/score/apps/web/src/themes/customizer/package.ts:36), [server/package.ts:189](/home/raven/score/apps/server/src/themes/package.ts:189), [server/package.ts:264](/home/raven/score/apps/server/src/themes/package.ts:264).

    Both-reader probes showed the browser accepting packages the server rejects: fake PNG bytes, PNGs under `assets/fonts/`, NUL-containing licence text and 42 files. The browser reader also ignores ZIP symlink metadata and several structural constraints enforced server-side.

    **Fix:** share package limits, path/type rules and byte validation; maintain a common acceptance/rejection fixture corpus.

The selector suffix itself correctly excludes direct protected targets through `:is()`/`:has()` and recurses into nested `@media`/`@layer`. Those wrappers do **not** make ancestor rules safe: `:is(html,body):has(button)` still selects ancestors. Pseudo-element confinement protects the originating element’s subtree membership; it does not constrain where an allowed ancestor/sibling pseudo-element paints.

**The click-time check cannot block a decision under the actual Score default look.** [guard.ts:316](/home/raven/score/apps/web/src/themes/guard.ts:316) bypasses it unless `data-look="custom"`; applying Score removes that attribute. A custom theme reproducing default visuals still runs the checker and can suffer its unconditional centre-hit false positives.

What is solid:

- Whole-package server revisions and serialized conditional writes address the original etag gap.
- Ordinary swap rollback and recorded upgrade destinations substantially improve recovery.
- Device reset now works in memory when storage throws; safe-URL handling bypasses cached themes.
- External URL filtering, restricted asset paths/types and font namespacing provide useful boundaries.
- Ledger and Studio font bytes and licence texts survived actual export/import round-trips in my probes.

I changed no repository files. ZIP and package probes used the actual readers; recovery used the actual store with in-memory SQLite/filesystem fault injection. CSS guard probes used controlled styles and geometry. Vitest and Chromium could not run because the read-only sandbox blocked their temporary directories; this is not a certified `pnpm check`/e2e pass.
## Lead response (2026-10-18 ~21:40 GMT+8)
Gate still fails (3 closed, 9 partly, 10 findings). The first re-gate attempt was stopped by the provider's
cybersecurity filter (attacker wording); this run used a guarantee-verification prompt. Root cause of the remaining
UI findings: free-form theme CSS can always act on *ancestors* of protected surfaces (inheritance, transforms, clipping,
overlays), so a blocklist + runtime guard can't make the guarantee. Decision 102: theme CSS becomes an **allowlist of
visual-only properties**; layout stays available through the manifest (rendered by Score); protected surfaces get
trusted typography and opaque backgrounds. All 10 findings accepted; fixes in H1 (CSS model + protected boundary +
guard), H2 (package/server consistency, recovery block, committed detail from import), H3 (decision boundaries,
chat-first escape path, colour-mode reset). Then a third gate run.
