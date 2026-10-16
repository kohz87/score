# External audit 5 (Astra), Score 1.3.2 at 9ce23275, received 2026-10-16

Six P2 findings plus one conditional candidate. Lead check against main (v1.3.3) and cross-reference with the same-day
Gemini 4 Argon audit (`docs/reviews/2026-10-16-argon-audit.md`): no finding overlaps an Argon finding.

| id | finding | lead check | batch |
|---|---|---|---|
| S5-001 | PATCH /api/coding-agents decides the password need from the snapshot read before `await workspaceFor`, then writes unconditionally: a stale request can turn a fresh downgrade into read-only → full without a password | confirmed (coding-agents.ts:157–172) | C |
| S5-002 | Agent image placeholders are `[image: alt, size]`; `restoreImages` restores the first unused original with the same text, so two images with equal alt and rounded size can swap | confirmed (note-images.ts:88–125) | K |
| S5-003 | With git unavailable, `ignoredUntracked` returns an empty set and `commit` returns null, which the vault reports as `versioned: true, historyUpdated: true` | confirmed (vault commit wrapper) | K |
| S5-004 | An unchanged-content save returns `historyState()` (`historyUpdated: true`) without retrying a commit that failed earlier | confirmed (writeNote no-op path) | K |
| S5-005 | Documents decide `versioned` by size (documents.ts:537, 649) and `commitPaths` discards the commit outcome; upload results drop the new history fields | confirmed | K |
| S5-006 | `UnitBackend.close()` doesn't await an in-flight `ensureListener()`; a bind finishing after shutdown leaves a live listener | confirmed (unit-backend.ts:473–494, 657–658) | C |
| S5-C01 | A late output callback could recharge a released memory reservation — reachability unproven | investigate in C; fix if reachable or trivially guarded | C |

Astra rechecked audit 4: S4-001…S4-007 and S4-C01 addressed in source. Fixes: `docs/briefs/fix-audit5.md`.
