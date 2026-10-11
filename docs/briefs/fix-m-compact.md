# Fix batch M: Compact must persist Hermes's result (live check 2026-10-11)

Live check on `scoretesta` (plugin from 5.36): `session.compacted` said `status: compacted` with before == after (12
messages, 6,565 tokens); Hermes's state.db (read-only check) showed no continuation session, no compression markers, and the
original transcript unchanged. Root cause: `hermes_private.compact_session` calls `compress_now(...)` and finalises the
notification, but skips Hermes's **persist step** — the gateway's `_persist_manual_compression`
(reference `gateway/slash_commands_session.py`): if the throwaway agent rotated to a new continuation id it must
`persist_rotated_compression_child(old_id, new_id, compressed)` (and the session entry/lineage is repointed); if it compacted
in place (`_last_compaction_in_place`) Hermes already archived/inserted rows; an unchanged id without in-place means rotation
failed → report failure, preserve the transcript.

1. Plugin (`hermes_private.py` only for private calls): after `compress_now` returns `compressed`, perform the same persist
   logic as the gateway (via the session store / SessionDB the rewind code already acquires, under the same transcript
   lock), then report `{ before, after, rotated: bool, newSessionId }`. Before == after or unchanged id without in-place →
   `status: 'nothing'` or `failed` with a reason, never `compacted`.
2. Score: when the session rotated, the room session follows the continuation (Score already follows compression lineage
   for runs — make the next turn use it; check `score-<room>-<agent>` resolution and the context route); after a compaction
   the context cache shows the new figures.
3. Plugin tests with a fake store covering rotation, in-place, rotation failure, nothing-to-do; server tests for following
   the continuation. Read the reference implementation carefully (MIT, read-only).
Done when tests pass and `pnpm check` is green; the lead re-runs the live check on scoretesta.
