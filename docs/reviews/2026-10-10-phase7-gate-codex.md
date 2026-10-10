Hold the Phase 7 gate. I found six defects involving revoked authority, process termination, queued permissions, secret redaction, Knowledge imports and pruning, plus one pre-existing licensing-policy mismatch. Findings were verified through code tracing and isolated in-memory probes. The review remained read-only; no credentials, real models or prohibited ports were accessed. The full test suite was not run.

### [high] Deleted coding agents retain working MCP tokens

**Where:** [coding-agents.ts:179](/home/raven/score/apps/server/src/http/coding-agents.ts:179), [mcp/access.ts:57](/home/raven/score/apps/server/src/mcp/access.ts:57).

**What happens:** After deleting an MCP-enabled coding agent, its existing token can still act as that agent. An HTTP injection probe returned `204` for deletion, then successfully stored a room message through the old token.

**Why:** Deletion sets `removed_at` and removes the projection, but leaves `mcp_access` intact. Coding agents have no persistent lifecycle row, and MCP’s `current()` treats an absent lifecycle with a null stored incarnation as valid.

**Fix:** Revoke the token and switches atomically with deletion. Check that the agent still exists and is active when authenticating tokens. Add a deletion-to-MCP regression test.

### [high] Coding Stop abandons descendants when the CLI exits first

**Where:** [process.ts:77](/home/raven/score/apps/server/src/runtimes/coding/process.ts:77), [process.ts:135](/home/raven/score/apps/server/src/runtimes/coding/process.ts:135), [service.ts:478](/home/raven/score/apps/server/src/runtimes/coding/service.ts:478).

**What happens:** A tool subprocess that ignores SIGINT and redirects its standard streams can continue running after Score reports its turn cancelled. It can keep changing files while subsequent work starts.

**Why:** Stop schedules group-wide SIGTERM/SIGKILL, but the CLI leader’s `close` handler cancels those timers. The runtime then deletes the durable process record without checking for surviving group members. A mocked process-lifecycle probe confirmed that only SIGINT remains after the leader closes.

**Fix:** Keep escalation, process tracking and the agent’s execution slot until the entire process group has terminated. Test a signal-ignoring descendant whose streams are redirected.

### [medium] Queued coding turns ignore permission downgrades

**Where:** [service.ts:344](/home/raven/score/apps/server/src/runtimes/coding/service.ts:344), [service.ts:452](/home/raven/score/apps/server/src/runtimes/coding/service.ts:452), [coding-agents.ts:141](/home/raven/score/apps/server/src/http/coding-agents.ts:141).

**What happens:** Queue a turn in another room while the coding agent is busy, then lower its permission from `full` to `read-only`. The waiting turn still launches with full-access flags.

**Why:** Admission captures the agent object, and queued execution retains it. Settings changes update SQLite, but execution uses the old `agent.permission`. An in-memory probe observed current permission `read-only` while the queued execution received `full`.

**Fix:** Reload and validate the current agent settings immediately before spawning. Add a cross-room queue test that lowers permissions while a turn waits.

### [medium] Coding Watch frames can store complete unredacted keys

**Where:** [translate.ts:255](/home/raven/score/apps/server/src/runtimes/coding/translate.ts:255), [watch-frames.ts:283](/home/raven/score/apps/server/src/domain/watch-frames.ts:283).

**What happens:** A sufficiently large tool result can persist a complete API key in a Watch frame, despite the original result being recognizable by the redactor.

**Why:** Translation takes the output tail before redacting it. Tail clipping can remove `API_KEY=` while retaining the complete value, defeating later redaction passes. A production-translator probe stored the complete synthetic key; redacting the original output removed it correctly. This violates the redaction-before-truncation requirement.

**Fix:** Redact the complete result before taking its tail. Audit the other coding-output clipping paths and add tests with credential labels crossing truncation boundaries.

### [medium] ZIP “Keep both” silently loses an incoming file

**Where:** [documents.ts:426](/home/raven/score/apps/server/src/knowledge/documents.ts:426), [documents.ts:715](/home/raven/score/apps/server/src/knowledge/documents.ts:715).

**What happens:** With an existing `bundle/report.md`, importing a ZIP containing `report.md` and `report (2).md` using “Keep both” writes both entries to `bundle/report (2).md`. The second overwrites the first, and the response reports success with duplicate written paths.

**Why:** `freeName()` checks only existing files. All renaming happens before batch writes, without reserving names against the other incoming entries. The initial duplicate check runs before renaming. An in-memory ZIP-import probe reproduced the overwrite.

**Fix:** Allocate destinations against the complete incoming batch, existing files and every newly reserved name. Require distinct final destinations before writing, and test suffix collisions.

### [medium] Summaries of lead notes block orchestration pruning indefinitely

**Where:** [executor.ts:2432](/home/raven/score/apps/server/src/domain/orchestration/executor.ts:2432), [room-summaries.ts:194](/home/raven/score/apps/server/src/domain/room-summaries.ts:194), [0011_message_runs.sql:7](/home/raven/score/apps/server/migrations/0011_message_runs.sql:7).

**What happens:** After a run releases its room, a summary can reference its latest `orc-note` message. Retention maintenance then repeatedly fails to prune that run, retaining its associated data and storage charge.

**Why:** Pruning preserves externally referenced attempt replies but unconditionally deletes lead notes. A summary’s `chain_id` and `parent_message_id` reference messages without cascading deletion. A migrated in-memory database using the real summary reservation reproduced `FOREIGN KEY constraint failed`; the pruning transaction rolled back.

**Fix:** Apply the external-reference protection to lead notes too, and account for retained messages when releasing the run’s charge. Test a post-release summary whose boundary is a lead note.

### [low] License checker permits MIT-0 beyond the binding policy

**Where:** [license-check.mjs:8](/home/raven/score/scripts/license-check.mjs:8), [AGENTS.md:94](/home/raven/score/AGENTS.md:94).

**What happens:** The checker accepts `@csstools/color-helpers@6.1.2` and `@csstools/css-syntax-patches-for-csstree@1.1.15` under MIT-0 without recorded owner exceptions. This mismatch predates the review baseline.

**Why:** The checker’s allowlist includes MIT-0; AGENTS.md’s explicit list does not, and requires owner approval for other licenses.

**Fix:** Obtain and record exact-version owner exceptions, or have the owner reconcile the policy and checker.

### Checked and fine

- Remote pairing protection: all 133 injected route/method checks across the registered feature routes returned `401` before reaching handlers.
- Terminal TLS enforcement, host-enrolled second factor, consumed fresh authentication, session/origin-bound single-use tickets, and pairing-revocation cleanup.
- MCP listener separation, token-derived room/task scope, access/write switches, and request/post limits, apart from the retirement defect above.
- Knowledge traversal and symlink guards, ZIP entry validation and extraction limits, and served-file attachment, `nosniff`, CSP and cache headers.
- Orchestration/workflow ownership guards around ordinary chat, rewind, summaries and MCP room posts; dispatch fencing and capability validation.
- Argument-array subprocess launches and coding CLI event validation. The new Knowledge license exceptions for `pako@1.0.11` and `duck@0.1.12` are recorded for the exact versions.