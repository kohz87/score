# External audit 4 (Astra), Score 1.3.1 at f973424e, received 2026-10-15

Seven P2 findings plus one unconfirmed admission risk. Every finding was checked against the code by the lead before
fixing (status after each). Fixes: `docs/briefs/fix-audit4.md`.

| id | finding | files | lead check |
|---|---|---|---|
| S4-001 | Leaving a page during a refresh discards buffered updates; reopening with a failed snapshot leaves the old cache unfenced, so a later event publishes `success` while an earlier update is lost | `apps/web/src/data/resync.ts` (last-observer cleanup) | confirmed: cleanup clears `buffer` while `fetching` without setting `fenced` |
| S4-002 | Legacy move-plan migration deletes `.git/score-move-plan.json` even when writing the replacement failed (EIO), losing the only recovery record | `apps/server/src/knowledge/vault.ts` `migrateLegacyPlan()` | confirmed: parse and write errors share one catch; `fs.rm(legacy)` is unconditional |
| S4-003 | A note in a Git-ignored, untracked path saves normally but `git add` rejects it; the error is logged and swallowed and status omits it, so the note never gets history | `apps/server/src/knowledge/git.ts`, `vault.ts` `commit()` | confirmed; owner decision 80: save, mark "not in history" |
| S4-004 | A live share names image media ids without holding a media reference; deleting/rewinding the original message lets eviction remove the image before the share expires | `domain/shares.ts`, `http/shares.ts`, `domain/media-refs.ts`, `media/store.ts` | confirmed: shares take no media reference |
| S4-005 | The coding socket clears the hello timeout on the first newline, before authentication; a rejected hello is answered with `socket.end()` and the unauthenticated slot is only released on full close, so a half-open local peer keeps its slot | `runtimes/coding/coding-socket.ts` | confirmed (`clearTimeout` before `hello()`, `reject` uses `end`) |
| S4-006 | "Check again" can't recover from a failed listener start: `check()` reads the stored `socketError` and never retries binding | `runtimes/coding/unit-backend.ts` | confirmed (`listening = this.socketError === null`) |
| S4-007 | `ingest_keys` rows of `coding:<agent>` sources are in neither retirement branch and orchestration pruning doesn't delete them, so they grow without bound | `runtimes/coding/translate.ts`, `hub/retire.ts`, `domain/orchestration/prune.ts` | confirmed; live DB has 120 such rows (7.7 KB) |
| S4-C01 | Concurrent same-turn `CodingRuntime.startRun` calls can hit the idempotency constraint or record a run id that was never inserted; reachability through real callers unconfirmed | `runtimes/coding/service.ts` | to verify through the real callers; fix regardless (cheap) |

Auditor's recommended order: S4-001, S4-002; then S4-003, S4-004; then S4-005, S4-006; then S4-007.
The auditor ran isolated fixtures on Node 22.16.0 (below the repo minimum); their scripts aren't in this repo — every
fix here gets its own failing-first test against the real modules.
