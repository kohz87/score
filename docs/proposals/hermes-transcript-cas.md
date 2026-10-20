# Draft proposal (not sent): replace part of a session transcript safely

**Status:** draft by Score's lead for the owner (PLAN 10.15). Nothing has been posted to NousResearch. The owner decides
whether and where to propose it. Facts are from Hermes `e97923c` and Score's design review
(`docs/reviews/2026-10-20-10.15-swipe-design-codex.md`).

## Problem
A client that shows a session's conversation (Score, a dashboard) wants two operations Hermes can't do safely today:
1. **Swipe**: keep several alternative answers to one user turn and make the agent continue from the one the person
   picked — replace the turn's answer block with an earlier, archived one.
2. **Forget one answer**: remove an assistant reply from the agent's context while keeping the user's question.

`SessionDB.replace_messages(..., archive_dropped=True)` is the closest API, but:
- it takes no expected state: a writer that appends between the caller's read and the replacement has its row archived
  unseen (ordinary appends don't check the turn lease);
- it keeps the **common prefix by matching role, content and tool fields**, so two answers that start with identical
  text but differ in reasoning or provider content can be spliced (an isolated probe stamped the live uid of one
  answer onto a row of the other);
- pending gateway transcript writes (retry queues, disk spools) can land after a replacement and resurrect or drop rows;
- "a user turn" for rewind counts steers and merged/repaired turns, not "one question and its whole answer".

## Proposed operation
`replace_turn_block(session_id, expected: {generation, prefix_digest, block_uids, block_digests}, replacement:
{rows | archived_row_handles}, *, archive=True)` — in **one transaction**:
- verify the session's transcript generation and the digest of the live prefix up to the block, and that the live
  block is exactly `block_uids` with matching digests; otherwise raise a typed conflict and change nothing;
- refuse while transcript writes for the session are pending (or drain them first and re-verify);
- archive the block (soft, like rewind) and insert the replacement rows **verbatim**, including reasoning,
  `api_content`, tool calls and identities, with no common-prefix matching;
- bump the generation and return it with the new live uids.
Plus a read-only `describe_turn(session_id, user_uid)` returning the full execution block of a user turn (tool rows,
steers, the final answer) with row handles and digests, so a client can name a block exactly.

## Why upstream
Doing this from a plugin would need the plugin to own SQL against Hermes's database (forbidden for clients like Score)
and to reimplement Hermes's drain and lease rules. One atomic operation in `SessionDB` keeps those rules in one place.
