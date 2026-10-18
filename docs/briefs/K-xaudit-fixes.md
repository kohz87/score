# Cross-audit fixes (v1.8.0 → 1.8.1): K1, K2, K3 (+ additions to J1)

Source: `docs/reviews/2026-10-19-xaudit-1.8.0.md` (ids X1–X16, raw reports appended there). Every fix lands with a test
that fails before it (show it). If a finding doesn't reproduce, say so with evidence and don't change code for it.

## K1 — protection coverage (web): X1, X7, X15
- X1: protect the complete consent surfaces and make each a `data-decision`: new-orchestration and start-workflow
  forms (risk text, per-agent reach, approval-policy radios, spend confirmations, quota/budget fields, the start
  button), MCP read/write access controls, Settings › Remote access when a password is set (password field, pairing
  code create/cancel, paired-browser Renew/End/End all, passkeys add/remove), the pair page card. Fix `violationIn`'s
  early return so a decision with no live protected child still vets its fields. Add the classes to
  `protected-surfaces.ts`; extend the inventory test so a form that posts a consent can't be unmarked (list them).
  Real-form e2e: accepted theme CSS hiding the policy/reach/password parts refuses the submit and posts nothing.
- X7: protect the Customizer's way back (`.cz-back`) and give the full-screen Customizer the command palette's
  emergency entries (Reset look, Settings) independent of the page shells.
- X15: an in-session Ctrl+Shift+0 or guard fallback survives a late `GET /api/themes` that bumps the reset generation;
  the chat-first way back renders whenever a custom look is on (CSS already gates its display), not only after the
  server list arrives.

## K2 — theme storage (server): X4, X5, X11, X12, X14
- X4: no symlink anywhere on an asset path (directories included) for listing, serving and export; one safe reader.
- X14: asset/stylesheet/export routes answer 404 for an id without a row; `remove()` is journaled like a swap (rename to
  `.old-<token>` first, row delete, then cleanup; recovery finishes it) and a start sweeps theme folders without a row.
- X5: durability: commit the swap journal with `synchronous=FULL` (or an explicit checkpoint) before moving folders,
  fsync staged files and the parent directory after renames, and commit the new row before deleting the old folder.
  Keep it bounded; document what is and isn't guaranteed after power loss.
- X11: the server's inflate must consume the whole compressed extent (trailing bytes → refused like the browser); add
  deflated-trailing-data cases to the shared corpus.
- X12: `id: "constructor"` (and `__proto__`, `toString`, …) are ordinary ids: own-property or `Map` lookups.
Avoid the route/etag code J1 is changing (asset URL revisions, look.changed); coordinate via small, separate hunks.

## K3 — small items: X6, X8, X9, X16
- X6: the coding-agent personality editor keeps its draft and base etag across query refreshes (key by agent id);
  an incoming change while editing shows the documented conflict choices.
- X8: `pathDirty()` distinguishes clean / dirty / unknown; unknown keeps `failed` (or `git_unavailable`) so the "Save to
  history again" path stays.
- X9: a failed quota refresh stops the guard trusting the cached reading (display may keep it, labelled stale);
  contract text "missing or expired readings never block" holds.
- X16: Customizer preview contrast uses the view's own background (`lookForView`); THEMES.md radius cap → 40px.

## Added to J1
X3 (import Replace sends the etag it showed; a conflict asks again), X10 (Save as new adopts the new name/id, not dirty),
X13 (saving or replacing the theme in use emits `look.changed` so other devices refetch; revision-bound asset URLs also
bust caches), plus Argon's note that a removed asset must not break Save as new (copy from one snapshot).

All: follow AGENTS.md; no new dependencies; contract first for API changes; migrations J1 0078, K2 0079 if needed.
