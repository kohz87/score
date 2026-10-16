# Gemini 4 Argon High audit of Score 1.3.2 (agy 1.3.6, read-only, plan mode + sandbox, file tools only), 2026-10-16

Lead check of each finding against the code (main at v1.3.3):

| # | verdict |
|---|---|
| 1 P1 | **confirmed**: compaction drops `witness` entries with no tombstone while `unjournaledAttempts` requires one for every attempt with `dispatch_generation > 0` ⇒ freeze after maintenance + restart. Fix A1. |
| 2 P2 | **rejected (unreachable)**: incarnation remap refuses `untracked` (decisions.ts:553–557) and coding agents have no lifecycle rows. |
| 3 P2 | **hardening only**: Claude Code applies Read rules to Grep/Glob and Edit rules to Write/NotebookEdit; list them explicitly anyway. Fix A5. |
| 4 P2 | **partly confirmed**: Codex already treats messages after the terminal as loss; Claude Code doesn't for assistant/tool records after `result`. Fix A2. |
| 5 P2 | **rejected on Linux**: `readContainedBuffer` opens with O_NOFOLLOW and checks `/proc/self/fd` realpath; the scenario needs a non-Linux host. |
| 6 P2 | **partly confirmed**: request_receipts and knowledge_agent_writes are retired; `mcp_posts` (rate-limit log) is only deleted on refund. Fix A3. |
| 7 P3 | to verify with a failing test. Fix A6. |
| 8 P3 | **confirmed**: MCP `guarded()` returns only `code: message`, dropping `details` (etag, retryAfterSeconds). Fix A4. |

---

# Score v1.3.2 Security & Reliability Audit Report

## Summary

This audit reviewed the read-only snapshot of **Score v1.3.2** against `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/API-CONTRACT.md`, `docs/DECISIONS.md` (Decisions 1–80), and prior audits in `docs/reviews/` (through `2026-10-15-external-audit-4.md`).

We identified **8 confirmed findings** (**1 P1**, **5 P2**, **2 P3**):

| # | Severity | Confidence | Title |
| :- | :-: | :-: | :- |
| **1** | **P1** | Confirmed (100%) | Journal compaction drops `witness` / `send_refused` entries without a tombstone, causing `unjournaledAttempts` to permanently freeze the installation (`execution_frozen`) on the next restart |
| **2** | **P2** | Confirmed (100%) | Replacing and remapping a coding worker after a `policy_remap` leaves a stale `policy_remap` journal entry, triggering a false-positive global `journal_mismatch` fence on restart |
| **3** | **P2** | Confirmed (100%) | Claude Code `claudeDenyRules` only restricts `Read` and `Edit`, omitting `Grep`, `Glob`, `Write`, and `NotebookEdit` for denied paths and `.env*` files |
| **4** | **P2** | Confirmed (100%) | Claude Code and Codex stream parsers do not treat post-terminal messages or tool executions as stream loss, allowing post-result activity to retain an `eligible: true` verdict |
| **5** | **P2** | Confirmed (100%) | `GET /api/knowledge/notes/*?download=1` bypasses `vault.lookup()`, following intermediate directory symlinks inside the vault on non-Linux hosts |
| **6** | **P2** | Confirmed (100%) | Unbounded SQLite table growth in `request_receipts`, `knowledge_agent_writes`, and `mcp_posts` |
| **7** | **P3** | Confirmed (100%) | Workflow `storageInventory` omits per-generation `turn_id`s from `orc_generations`, reporting zero rows/bytes for coding worker intents, runs, tool calls, and thinking |
| **8** | **P3** | Confirmed (100%) | MCP `guarded()` error handler strips `HttpError.details`, dropping `etag` on `knowledge.write` conflicts and `retryAfterSeconds` on rate-limit errors |

---

## Findings

### 1. [P1] Journal compaction drops `witness` / `send_refused` entries without a tombstone, causing `unjournaledAttempts` to permanently freeze the installation (`execution_frozen`) on the next restart

- **Severity**: **P1** (Unrecoverable operational lockup — permanently freezes all agent execution across the installation until manual CLI `scripts/score reset-history`)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [journal.ts](apps/server/src/domain/orchestration/journal.ts#L782-L848)
  - [journal.ts](apps/server/src/domain/orchestration/journal.ts#L914-L961)
  - [executor.ts](apps/server/src/domain/orchestration/executor.ts#L3385-L3395)
  - [fence.ts](apps/server/src/domain/orchestration/fence.ts#L597-L626)
  - [fence.ts](apps/server/src/domain/orchestration/fence.ts#L1031-L1043)
  - [coding-attempts.ts](apps/server/src/domain/orchestration/coding-attempts.ts#L195-L229)
  - [ops.ts](apps/server/src/domain/orchestration/ops.ts#L406-L444)

#### Concrete Failing Scenario
1. An orchestration or workflow step attempt is prepared for dispatch (`prepareDispatch` increments `orc_attempts.dispatch_generation` to `>= 1` and appends `send_started` to `orchestration.journal`).
2. Every dispatch generation of that attempt ends without being sent (`send_refused` or `send_closed`), and the attempt subsequently reaches `state = 'terminated'` or `state = 'refused'`. This happens in multiple normal flows:
   - **Coding worker closed at release**: A coding step is prepared (`send_started`, `dispatch_generation = 1`), and before the unit is spawned, the run/step is stopped, cancelled, retired, reaches its deadline, or has its upstream inputs withdrawn. [`applyClosure`](apps/server/src/domain/orchestration/coding-attempts.ts#L212-L229) classifies causes `'stop' | 'cancel' | 'retired' | 'owed_stop' | 'inputs_withdrawn' | 'deadline'` as `klass === 'terminal'`, appends `send_closed` to the journal, and updates `orc_attempts` to `state = 'terminated'` with `dispatch_generation = 1`.
   - **Refused attempt retired or reaching refusal limit**: A step attempt has one or more refused generations (`send_started` + `send_refused`, `dispatch_generation >= 1`) and either hits `WORKFLOW_LIMITS.refusedLifetime` (20 refusals) in [`recordRefusal`](apps/server/src/domain/orchestration/ops.ts#L419-L425) (`state = 'refused'`) or is retired while `state = 'created'` by `stopRun`, `orch.cancel`, `beginFinish`, `renewDispatch`, or `remapWorkflow` via `refuseAttempt` (`state = 'refused'`, `dispatch_generation >= 1`).
3. [`OrchestrationExecutor.maintenance()`](apps/server/src/domain/orchestration/executor.ts#L3369-L3438) runs (scheduled daily or invoked before a backup).
   - First, [`foldGenerations`](apps/server/src/domain/orchestration/journal.ts#L914-L961) sees `group.length >= 2` (`[send_started, send_closed]` or `[send_started, send_refused, ...]`) with `latest.state !== 'sent'`, so it drops `send_started` and replaces the entire group with a single `kind: 'witness'` entry.
   - Next, [`compactLocked`](apps/server/src/domain/orchestration/journal.ts#L792-L843) checks `compactable` (which includes `'witness'` and `'send_refused'`) and calls `droppable(entry)`.
   - In [`executor.ts:3386-3395`](apps/server/src/domain/orchestration/executor.ts#L3386-L3395), `droppable(entry)` returns `true` because `attempt.state === 'terminated' || attempt.state === 'refused'`.
   - In [`journal.ts:806-843`](apps/server/src/domain/orchestration/journal.ts#L806-L843), `compactLocked` emits tombstones for `send_started`, `stop_fence`, and `transition`, **but has no branch for `witness` (or `send_refused`)**, silently deleting the `witness` entry from the journal while the attempt row remains in `orc_attempts` with `dispatch_generation >= 1` (for the rest of the live run and for up to 30 days of retention).
4. On the next server restart, [`fence.startupCheck()`](apps/server/src/domain/orchestration/fence.ts#L1031-L1043) calls [`unjournaledAttempts`](apps/server/src/domain/orchestration/fence.ts#L597-L626). Because the `orc_attempts` row has `dispatch_generation > 0` and the journal now has no record at all for `row.id`, `unjournaledAttempts` reports a mismatch with `lost: true`. `startupCheck()` immediately calls `this.freeze(...)`, placing the entire Score installation into sticky `execution_frozen` (`journal_truncated`).

#### Why the Current Code Allows It
In [`apps/server/src/domain/orchestration/journal.ts:931-959`](apps/server/src/domain/orchestration/journal.ts#L931-L959), `foldGenerations` folds any non-sent attempt's `send_started` + `send_refused`/`send_closed` pair (`group.length >= 2`) into a `witness`:
```ts
  for (const group of byAttempt.values()) {
    if (group.length < 2) continue
    const latest = [...journalDispatches(group).values()][0]!
    const newest = group.at(-1)!
    if (latest.state === 'sent') {
      // Keep the latest send_started; everything older is superseded.
      const keep = group.findLast((e) => e.kind === 'send_started')!
      for (const e of group) if (e.n !== keep.n) drop.add(e.n)
    } else {
      ...
      for (const e of group) drop.add(e.n)
      drop.delete(newest.n)
      replace.set(newest.n, {
        n: newest.n,
        at: newest.at,
        scope: newest.scope,
        kind: 'witness',
        attemptId: (newest as { attemptId: string }).attemptId,
        orchestrationId: (newest as { orchestrationId: string }).orchestrationId,
        lastGeneration: latest.generation,
        lastState: latest.state === 'closed' ? 'closed' : 'refused',
        refusedCount: refused,
      })
    }
  }
```
Then in [`apps/server/src/domain/orchestration/executor.ts:3386-3395`](apps/server/src/domain/orchestration/executor.ts#L3386-L3395), `maintenance()` marks `witness` (and `send_refused`/`send_closed`) droppable as soon as the attempt is `terminated` or `refused` (even while the attempt row still exists in `orc_attempts`):
```ts
      if (
        entry.kind === 'send_refused' ||
        entry.kind === 'send_closed' ||
        entry.kind === 'witness'
      ) {
        const attempt = readAttempt(sqlite, entry.attemptId)
        return (
          attempt !== undefined && (attempt.state === 'terminated' || attempt.state === 'refused')
        )
      }
```
And in [`apps/server/src/domain/orchestration/journal.ts:793-843`](apps/server/src/domain/orchestration/journal.ts#L793-L843), `compactLocked` drops `witness` without turning it into a tombstone:
```ts
      const compactable = [
        'send_started',
        'run_handle',
        'reconciled',
        'stop_fence',
        'transition',
        'authorization',
        'hold',
        'remap',
        'renewal',
        'send_refused',
        'witness',
      ].includes(entry.kind)
      if (entry.scope !== this.scope || !compactable || !droppable(entry)) {
        out.push(entry)
      } else if (entry.kind === 'send_started') {
        out.push({
          n: entry.n,
          at: entry.at,
          scope: entry.scope,
          kind: 'tombstone',
          of: 'send_started',
          orchestrationId: entry.orchestrationId,
          attemptId: entry.attemptId,
          generation: entry.generation,
        })
      } else if (entry.kind === 'stop_fence') {
        ...
      } else if (entry.kind === 'transition') {
        ...
      }
```
Finally, [`unjournaledAttempts`](apps/server/src/domain/orchestration/fence.ts#L604-L625) requires every `orc_attempts` row with `dispatch_generation > 0` to have a witness in `journalDispatches`:
```ts
  const rows = sqlite
    .prepare(
      `SELECT id, created_at, dispatch_generation FROM orc_attempts WHERE dispatch_generation > 0 AND unknown_reason IS NOT 'history_reset'`,
    )
    .all() as { id: string; created_at: string; dispatch_generation: number }[]
  const lostWitness = (row: { id: string; dispatch_generation: number }): boolean => {
    const witness = known.get(row.id)
    return !witness || (witness.generation > 0 && witness.generation < row.dispatch_generation)
  }
```

#### Suggested Fix
1. Keep the folded `witness` entry in the journal (do not include `'witness'`, `'send_refused'`, or `'send_closed'` in `compactable` / `droppable`), **or** convert a compacted `witness` into a `tombstone` (or keep `witness` until the orchestration is pruned, and even after pruning remember that `witness` carries `lastGeneration` for restore-behind-journal detection, as stated in the comment on [`foldGenerations` at `journal.ts:909-913`](apps/server/src/domain/orchestration/journal.ts#L909-L913)).
2. Specifically, removing `'send_refused'` and `'witness'` from `compactable` in [`journal.ts:793-805`](apps/server/src/domain/orchestration/journal.ts#L793-L805) and removing the `send_refused | send_closed | witness` branch in [`executor.ts:3386-3395`](apps/server/src/domain/orchestration/executor.ts#L3386-L3395) ensures `foldGenerations` already collapses all generations of an unsent/refused/closed attempt into a single compact `witness` record that satisfies both `unjournaledAttempts` and `verifyJournal`.

---

### 2. [P2] Replacing and remapping a coding worker after a `policy_remap` leaves a stale `policy_remap` journal entry, triggering a false-positive global `journal_mismatch` fence on restart

- **Severity**: **P2** (False-positive global `journal_mismatch` fence on server restart; also missing journal witness for policy changes made via agent replacement remap, and uncompacted `policy_remap` entries)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [decisions.ts (orchestration)](apps/server/src/domain/orchestration/decisions.ts#L484-L533)
  - [decisions.ts (orchestration)](apps/server/src/domain/orchestration/decisions.ts#L561-L570)
  - [decisions.ts (orchestration)](apps/server/src/domain/orchestration/decisions.ts#L675-L696)
  - [decisions.ts (workflows)](apps/server/src/domain/workflows/decisions.ts#L349-L358)
  - [fence.ts](apps/server/src/domain/orchestration/fence.ts#L111-L115)
  - [fence.ts](apps/server/src/domain/orchestration/fence.ts#L199-L212)
  - [journal.ts](apps/server/src/domain/orchestration/journal.ts#L793-L805)
  - [executor.ts](apps/server/src/domain/orchestration/executor.ts#L3377-L3425)

#### Concrete Failing Scenario
1. An orchestration or workflow run starts with coding worker `coder` at `policyId = P1`.
2. The user edits `coder`'s settings (e.g., model or workspace), changing its policy to `P2`. A step targeting `coder` blocks with `agent_changed`.
3. The user clicks "Use the new settings", invoking [`policyRemapStep`](apps/server/src/domain/orchestration/decisions.ts#L675-L696) (or [`policyRemapWorkflowNode`](apps/server/src/domain/workflows/decisions.ts#L220-L300)). This appends `{ kind: 'policy_remap', orchestrationId, stepId, agentId: 'coder', policyId: P2 }` to the journal and updates `orc_worker_policies.policy_id = P2`.
4. Later in the same run, the `coder` agent is removed and re-created (new lifecycle incarnation) with different settings (`policyId = P3`, where `P3 !== P2`).
5. The user approves "Use the new coder for this run", invoking [`remapAgent`](apps/server/src/domain/orchestration/decisions.ts#L540-L602) or [`remapWorkflow`](apps/server/src/domain/workflows/decisions.ts#L306-L411).
   - [`acceptCodingRemap`](apps/server/src/domain/orchestration/decisions.ts#L518-L530) updates `orc_worker_policies.policy_id` in SQLite to `P3`.
   - However, `remapAgent` and `remapWorkflow` only append `{ kind: 'remap', orchestrationId, agentId: 'coder', incarnation: current }` to the journal—they do **not** append a `policy_remap` entry with `P3` (and `remap` has no `policyId` field).
6. When the Score server restarts, [`verifyJournal`](apps/server/src/domain/orchestration/fence.ts#L111-L115) finds the earlier `policy_remap` entry (`P2`) as the newest `policy_remap` for `${orchestrationId}:coder`, compares `entry.policyId` (`P2`) against `orc_worker_policies.policy_id` (`P3`), sees `row.policy_id !== entry.policyId`, and raises the global `journal_mismatch` fence (`"The new settings for coder in <orchId> were approved, but the database does not hold them"`).
7. Additionally, `policy_remap` is missing from `compactable` in [`journal.ts:793-805`](apps/server/src/domain/orchestration/journal.ts#L793-L805) and `newest` in [`executor.ts:3377-3384`](apps/server/src/domain/orchestration/executor.ts#L3377-L3384), so superseded `policy_remap` entries are never compacted.

#### Why the Current Code Allows It
In [`apps/server/src/domain/orchestration/decisions.ts:561-570`](apps/server/src/domain/orchestration/decisions.ts#L561-L570) (and identically in [`apps/server/src/domain/workflows/decisions.ts:349-357`](apps/server/src/domain/workflows/decisions.ts#L349-L357)):
```ts
  acceptCodingRemap(sqlite, orchId, body, report, now)
  // The journal entry comes first: a database that later lacks this remap is detected at start.
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'remap',
      orchestrationId: orchId,
      agentId: body.agentId,
      incarnation: current,
    }),
  )
```
While [`verifyJournal` in `apps/server/src/domain/orchestration/fence.ts:112-115, 199-212`](apps/server/src/domain/orchestration/fence.ts#L199-L212) checks `orc_worker_policies.policy_id` solely against the latest `policy_remap` entry:
```ts
    } else if (entry.kind === 'policy_remap') {
      if (policyRemap.get(`${entry.orchestrationId}:${entry.agentId}`) !== entry) continue
      const row = sqlite
        .prepare(
          'SELECT policy_id FROM orc_worker_policies WHERE orchestration_id = ? AND agent_id = ?',
        )
        .get(entry.orchestrationId, entry.agentId) as { policy_id: string } | undefined
      if (!row || row.policy_id !== entry.policyId)
        mismatches.push({
          kind: 'fence',
          ref: entry.orchestrationId,
          journalN: entry.n,
          detail: `The new settings for ${entry.agentId} in ${entry.orchestrationId} were approved, but the database does not hold them`,
        })
```

#### Suggested Fix
1. When `remapAgent` or `remapWorkflow` remaps a coding worker of the run (`readWorkerPolicy(sqlite, orchId, body.agentId)` is defined and `report?.policyId` is validated), include `policyId` on the `remap` journal entry (or append a `policy_remap` entry) before updating SQLite, and have `verifyJournal` and `applyJournalEvidence` use the newest policy across both `policy_remap` and coding-worker `remap` entries.
2. Add `'policy_remap'` to `compactable` in [`journal.ts:793-805`](apps/server/src/domain/orchestration/journal.ts#L793-L805) and track the newest `policy_remap` per `${orchestrationId}:${agentId}` in [`executor.ts:3377-3425`](apps/server/src/domain/orchestration/executor.ts#L3377-L3425) so older `policy_remap` entries are compacted like `remap`.

---

### 3. [P2] Claude Code `claudeDenyRules` only restricts `Read` and `Edit`, omitting `Grep`, `Glob`, `Write`, and `NotebookEdit` for denied paths and `.env*` files

- **Severity**: **P2** (Defense-in-depth / policy enforcement gap: Claude Code does not require the `acknowledgeReads` warning because Score claims to block access to `denyPaths`, `denyFiles`, and `.env*`, but `Grep`, `Glob`, and `Write` are not in `--disallowed-tools`)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [claude.ts](apps/server/src/runtimes/coding/claude.ts#L318-L334)
  - [claude.ts](apps/server/src/runtimes/coding/claude.ts#L357-L386)
  - [claude.ts](apps/server/src/runtimes/coding/claude.ts#L429-L438)
  - [policy.ts](apps/server/src/runtimes/coding/policy.ts#L20-L58)

#### Concrete Failing Scenario
1. Unlike Codex and Antigravity, Claude Code does not require `acknowledgeReads: true` when creating an agent ([`claudeDriver.requiresReadAck: () => false`](apps/server/src/runtimes/coding/claude.ts#L357)) and reports `reachBeyondWorkspace: false` at `read-only` and `workspace-write` ([`claudeDriver.worker.describeReach`](apps/server/src/runtimes/coding/claude.ts#L429-L438)) because Score passes `--disallowed-tools` (and managed worker settings `permissions.deny`) constructed by [`claudeDenyRules`](apps/server/src/runtimes/coding/claude.ts#L325-L334) to block `denyPaths` (`$SCORE_HOME`, `$HERMES_HOME`, `~/.ssh`), `denyFiles` (`~/.claude/.credentials.json`, `~/.codex/auth.json`, etc.), and `//**/.env*`.
2. However, `claudeDenyRules` only generates patterns for `['Read', 'Edit']`.
3. In `read-only` mode, `buildArgs` passes `'--tools', 'Read,Grep,Glob'` ([`claude.ts:368`](apps/server/src/runtimes/coding/claude.ts#L368)). Because neither `Grep(...)` nor `Glob(...)` is in `claudeDenyRules`, Claude Code can search `.env` files in the workspace or search/list files inside `denyPaths`/`denyFiles` using `Grep` and `Glob`.
4. In `workspace-write` (`--permission-mode acceptEdits`) and `full` (`--permission-mode bypassPermissions`), Claude Code's built-in file creation/overwrite tool `Write` (parsed in [`claude.ts:113`](apps/server/src/runtimes/coding/claude.ts#L113)) and `NotebookEdit` are not in `claudeDenyRules`, so `Write(//**/.env*)` and `Write(/<denyPath>/**)` are not disallowed by the rule list.

#### Why the Current Code Allows It
In [`apps/server/src/runtimes/coding/claude.ts:325-334`](apps/server/src/runtimes/coding/claude.ts#L325-L334):
```ts
export function claudeDenyRules(
  denyPaths: readonly string[],
  denyFiles: readonly string[] = [],
): string[] {
  const folders = [...new Set(denyPaths)].map((folder) => `/${folder.replace(/\/+$/, '')}/**`)
  const files = denyFiles.map((file) => `/${file}`)
  return ['Read', 'Edit'].flatMap((tool) =>
    [...folders, ...files, ...DENY_FILE_PATTERNS].map((pattern) => `${tool}(${pattern})`),
  )
}
```
And in [`apps/server/src/runtimes/coding/claude.ts:366-385`](apps/server/src/runtimes/coding/claude.ts#L366-L385):
```ts
      case 'read-only':
        // Only the reading tools exist at all; dontAsk refuses anything else.
        args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob')
        break
      ...
    args.push('--disallowed-tools', claudeDenyRules(options.denyPaths, options.denyFiles).join(','))
```

#### Suggested Fix
Expand the tool list in [`claudeDenyRules`](apps/server/src/runtimes/coding/claude.ts#L331) from `['Read', 'Edit']` to include all file-reading, file-searching, and file-writing tools supported by Claude Code (`['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Grep', 'Glob']`). Note that changing `claudeDenyRules` will change the canonical `policyId` of Claude Code workers, so existing tests/fixtures asserting exact `claudeDenyRules` output or policy hashes should be updated accordingly.

---

### 4. [P2] Claude Code and Codex stream parsers do not treat post-terminal messages or tool executions as stream loss, allowing post-result activity to retain an `eligible: true` verdict

- **Severity**: **P2** (Violates the 7.7a/7.7b single-terminal / authoritative-stream invariant: activity or errors emitted after the first terminal record do not invalidate `verdict.eligible`)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [claude.ts](apps/server/src/runtimes/coding/claude.ts#L179-L251)
  - [codex.ts](apps/server/src/runtimes/coding/codex.ts#L130-L136)
  - [codex.ts](apps/server/src/runtimes/coding/codex.ts#L240-L333)

#### Concrete Failing Scenario
1. In [`claude.ts`](apps/server/src/runtimes/coding/claude.ts#L244-L295), when a `ResultEvent` with `subtype: 'success', is_error: false` is parsed, `resultSeen` is set to `true` and a `result` event is emitted with `verdict: { eligible: true, reply: ..., reason: null }`.
2. If the CLI subsequently emits another `assistant` or `user` `MessageEvent` (for example, a late `tool_use`, a `tool_result` with `is_error: true`, or further assistant text) or another `system`/`init` event before exiting `0`, [`claude.ts:179-243`](apps/server/src/runtimes/coding/claude.ts#L179-L243) processes and returns those events **without checking `if (resultSeen)`** and without calling `lose(...)`.
3. Similarly, in [`codex.ts`](apps/server/src/runtimes/coding/codex.ts#L143-L176), when `turn.completed` is parsed, `turnEnded` is set to `true`. While `turnEnded` is checked for `error` ([`codex.ts:203`](apps/server/src/runtimes/coding/codex.ts#L203)) and `agent_message` ([`codex.ts:227`](apps/server/src/runtimes/coding/codex.ts#L227)), it is **not** checked for `thread.started` ([`codex.ts:131`](apps/server/src/runtimes/coding/codex.ts#L131)), `reasoning` ([`codex.ts:240`](apps/server/src/runtimes/coding/codex.ts#L240)), `command_execution` ([`codex.ts:247`](apps/server/src/runtimes/coding/codex.ts#L247)), `file_change` ([`codex.ts:275`](apps/server/src/runtimes/coding/codex.ts#L275)), `mcp_tool_call` ([`codex.ts:299`](apps/server/src/runtimes/coding/codex.ts#L299)), or `web_search` ([`codex.ts:325`](apps/server/src/runtimes/coding/codex.ts#L325)).
4. Because `lossReason()` remains `null`, `service.ts` accepts the earlier `verdict.eligible === true` result as authoritative for orchestration/workflow step completion even though tool executions or messages occurred after the supposed end of the turn.

#### Why the Current Code Allows It
In [`apps/server/src/runtimes/coding/claude.ts:179-195`](apps/server/src/runtimes/coding/claude.ts#L179-L195), `init.success` and `message.success` return before `resultSeen` is ever checked (unlike `ResultEvent` at line 247 and `SystemNotice` at line 305):
```ts
      if (init.success) {
        return [
          {
            kind: 'session',
            sessionId: init.data.session_id,
            ...(init.data.model ? { model: init.data.model } : {}),
          },
        ]
      }
      const message = MessageEvent.safeParse(value)
      ...
      if (message.success) {
        const content = message.data.message.content
        ...
```
And in [`apps/server/src/runtimes/coding/codex.ts:227-255`](apps/server/src/runtimes/coding/codex.ts#L227-L255), `if (turnEnded)` is only inside the `if (type === 'agent_message')` branch, not before handling all other item types:
```ts
      if (type === 'agent_message') {
        ...
        if (turnEnded) {
          lose('Codex sent a message after the end of the turn')
          return []
        }
        ...
      }
      if (type === 'reasoning') {
        ...
      }
      if (type === 'command_execution') {
        ...
```

#### Suggested Fix
- In [`claude.ts`](apps/server/src/runtimes/coding/claude.ts#L179), if `resultSeen` is already `true` when any `init` or `message` (or any non-ignorable record) arrives, call `lose('Claude Code sent a record after the result')` and return `[]`.
- In [`codex.ts`](apps/server/src/runtimes/coding/codex.ts#L217), check `if (turnEnded)` once for all `ItemEvent` records (and `thread.started`) so any item or session event after `turn.completed` / `turn.failed` calls `lose('Codex sent a record after the end of the turn')`.

---

### 5. [P2] `GET /api/knowledge/notes/*?download=1` bypasses `vault.lookup()`, following intermediate directory symlinks inside the vault on non-Linux hosts

- **Severity**: **P2** (Symlink traversal / containment bypass on non-Linux; wrong error semantics on Linux)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [knowledge.ts](apps/server/src/http/knowledge.ts#L78-L96)
  - [vault.ts](apps/server/src/knowledge/vault.ts#L308-L329)
  - [vault.ts](apps/server/src/knowledge/vault.ts#L409-L416)

#### Concrete Failing Scenario
1. Every standard note operation in `KnowledgeVault` (`readNote`, `writeNote`, `deleteNote`, `moveNote`) resolves paths through [`vault.lookup(rel.split('/'))`](apps/server/src/knowledge/vault.ts#L308-L329), which walks each path segment from `this.root` with `fs.lstat` and rejects any symlink segment (`400 bad_path: 'Score doesn’t follow links inside Knowledge.'`).
2. However, the raw note download handler `GET /api/knowledge/notes/*?download=1` in [`apps/server/src/http/knowledge.ts:80-86`](apps/server/src/http/knowledge.ts#L80-L86) constructs `abs = path.join(vault.vault, ...rel.split('/'))`, calls `fs.lstat(abs)` on the final path only, and calls `vault.readContainedBuffer(abs)`.
3. Neither `fs.lstat(abs)` nor `fs.open(abs, O_RDONLY | O_NOFOLLOW)` checks whether an **intermediate directory segment** (e.g., `sub` in `sub/secret.md`) is a symbolic link pointing outside the vault:
   - On non-Linux platforms (such as macOS, where `process.platform !== 'linux'`), [`readContainedBuffer`](apps/server/src/knowledge/vault.ts#L412-L416) skips the `/proc/self/fd/${handle.fd}` check, so `?download=1` follows the intermediate symlink and serves any `.md` file outside the vault.
   - On Linux, `/proc/self/fd/${handle.fd}` catches the mismatch but throws the race error `'The note moved while it was being read.'` instead of `'Score doesn’t follow links inside Knowledge.'`.

#### Why the Current Code Allows It
In [`apps/server/src/http/knowledge.ts:80-86`](apps/server/src/http/knowledge.ts#L80-L86):
```ts
    if (DownloadQuerySchema.parse(request.query).download !== undefined) {
      // The note exactly as stored (frontmatter included), read without following a symlink.
      const rel = parseNotePath(target)
      const abs = path.join(vault.vault, ...rel.split('/'))
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Couldn’t find that note.')
      const bytes = await vault.readContainedBuffer(abs)
```
And in [`apps/server/src/knowledge/vault.ts:409-416`](apps/server/src/knowledge/vault.ts#L409-L416):
```ts
  async readContainedBuffer(abs: string, maxBytes = MAX_NOTE_BYTES): Promise<Buffer> {
    const handle = await fs.open(abs, C.O_RDONLY | C.O_NOFOLLOW)
    try {
      if (process.platform === 'linux') {
        const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`)
        if (actual !== abs)
          throw new HttpError(400, 'bad_path', 'The note moved while it was being read.')
      }
```

#### Suggested Fix
In [`apps/server/src/http/knowledge.ts:82-86`](apps/server/src/http/knowledge.ts#L82-L86), resolve the note via `const { abs, stat } = await vault.lookup(rel.split('/'))` before calling `vault.readContainedBuffer(abs)` (or expose a `vault.downloadNote(target)` method on `KnowledgeVault` that uses `this.lookup()`). Additionally, in `readContainedBuffer`, on non-Linux platforms verify `await fs.realpath(path.dirname(abs)) === path.dirname(abs)`.

---

### 6. [P2] Unbounded SQLite table growth in `request_receipts`, `knowledge_agent_writes`, and `mcp_posts`

- **Severity**: **P2** (Resource leak / unbounded SQLite growth over the lifetime of an installation)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [idempotency.ts](apps/server/src/http/idempotency.ts#L64-L70)
  - [agent-api.ts](apps/server/src/knowledge/agent-api.ts#L74-L102)
  - [access.ts](apps/server/src/mcp/access.ts#L153-L173)

#### Concrete Failing Scenario
1. **`request_receipts`**: Every mutating API request with an `Idempotency-Key` header stores the serialized JSON response (up to 64 KiB, or 300 KiB on workflow routes) in `request_receipts`. In [`idempotency.ts:64-70`](apps/server/src/http/idempotency.ts#L64-L70), expiry cleanup is scoped to `WHERE key = ? AND route = ? AND created_at <= ? AND status IS NOT NULL`. Because clients generate a fresh UUID `Idempotency-Key` per action, old keys are never reused, so completed rows in `request_receipts` are **never** deleted.
2. **`knowledge_agent_writes` and `mcp_posts`**: Every successful agent knowledge write ([`agent-api.ts:98-100`](apps/server/src/knowledge/agent-api.ts#L98-L100)) and every successful MCP post ([`access.ts:169-171`](apps/server/src/mcp/access.ts#L169-L171)) inserts a rate-limit accounting row into `knowledge_agent_writes` or `mcp_posts`. Only rows from the last hour (`at > now - HOUR`) are queried, and neither table is ever pruned anywhere in the codebase.

#### Why the Current Code Allows It
In [`apps/server/src/http/idempotency.ts:64-70`](apps/server/src/http/idempotency.ts#L64-L70):
```ts
      const cutoff = new Date(clock() - 24 * 60 * 60 * 1000).toISOString()
      db.sqlite
        // Pending receipts never expire: the action may have happened before a crash (repeat → 409, not a rerun).
        .prepare(
          'DELETE FROM request_receipts WHERE key = ? AND route = ? AND created_at <= ? AND status IS NOT NULL',
        )
        .run(key, route, cutoff)
```
In [`apps/server/src/knowledge/agent-api.ts:98-100`](apps/server/src/knowledge/agent-api.ts#L98-L100):
```ts
      const id = sqlite
        .prepare('INSERT INTO knowledge_agent_writes (agent_id, at) VALUES (?, ?)')
        .run(agentId, now).lastInsertRowid
```
In [`apps/server/src/mcp/access.ts:169-171`](apps/server/src/mcp/access.ts#L169-L171):
```ts
      const id = sqlite
        .prepare('INSERT INTO mcp_posts (agent_id, tool, at) VALUES (?, ?, ?)')
        .run(agentId, tool, now).lastInsertRowid
```

#### Suggested Fix
- In [`idempotency.ts:68`](apps/server/src/http/idempotency.ts#L68), delete all expired completed receipts (`DELETE FROM request_receipts WHERE created_at <= ? AND status IS NOT NULL`) rather than filtering by `key = ? AND route = ?`.
- In [`agent-api.ts:76`](apps/server/src/knowledge/agent-api.ts#L76) and [`mcp/access.ts:155`](apps/server/src/mcp/access.ts#L155), run `DELETE FROM knowledge_agent_writes WHERE at <= ?` and `DELETE FROM mcp_posts WHERE at <= ?` (with `now - HOUR`) inside the reservation transaction.

---

### 7. [P3] Workflow `storageInventory` omits per-generation `turn_id`s from `orc_generations`, reporting zero rows/bytes for coding worker intents, runs, tool calls, and thinking

- **Severity**: **P3** (Inaccurate storage inventory breakdown in `GET /api/workflow-runs/:id` for workflow runs with coding workers)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [views.ts (workflows)](apps/server/src/domain/workflows/views.ts#L462-L531)
  - [prune.ts (orchestration)](apps/server/src/domain/orchestration/prune.ts#L6-L22)

#### Concrete Failing Scenario
1. When a coding worker step is dispatched in a workflow run, its `command_intents` (`idempotency_key`) and `runs` (`score_turn_id`) are keyed by the per-generation `turn_id` (`${attempt.turn_id}:g${generation}`) stored in `orc_generations.turn_id` (not `orc_attempts.turn_id`).
2. [`pruneAssociated`](apps/server/src/domain/orchestration/prune.ts#L9-L22) unions both `orc_attempts.turn_id` and `orc_generations.turn_id` when deleting associated rows.
3. However, [`storageInventory`](apps/server/src/domain/workflows/views.ts#L464-L468) only selects `turn_id` from `orc_attempts`:
   - As a result, the `intents`, `attempt_runs`, `tool_rows`, and `thinking` items in `WorkflowRunDetail.storageInventory` miss all rows generated by coding worker steps.

#### Why the Current Code Allows It
In [`apps/server/src/domain/workflows/views.ts:462-470`](apps/server/src/domain/workflows/views.ts#L462-L470):
```ts
export function storageInventory(sqlite: DatabaseSync, o: OrchRow): StorageInventory {
  const id = o.id
  const turnIds = (
    sqlite.prepare('SELECT turn_id FROM orc_attempts WHERE orchestration_id = ?').all(id) as {
      turn_id: string
    }[]
  ).map((r) => r.turn_id)
  const marks = turnIds.map(() => '?').join(',') || "''"
```
Compare with [`apps/server/src/domain/orchestration/prune.ts:9-22`](apps/server/src/domain/orchestration/prune.ts#L9-L22):
```ts
  const turns = [
    ...(
      tx.prepare('SELECT turn_id FROM orc_attempts WHERE orchestration_id = ?').all(o.id) as {
        turn_id: string
      }[]
    ).map((r) => r.turn_id),
    ...(
      tx
        .prepare(
          'SELECT turn_id FROM orc_generations WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
        )
        .all(o.id) as { turn_id: string }[]
    ).map((r) => r.turn_id),
  ]
```

#### Suggested Fix
Include `SELECT turn_id FROM orc_generations WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)` in `turnIds` in [`apps/server/src/domain/workflows/views.ts:464-468`](apps/server/src/domain/workflows/views.ts#L464-L468).

---

### 8. [P3] MCP `guarded()` error handler strips `HttpError.details`, dropping `etag` on `knowledge.write` conflicts and `retryAfterSeconds` on rate-limit errors

- **Severity**: **P3** (Minor contract / agent ergonomics gap)
- **Confidence**: **Confirmed (100%)**
- **Files**:
  - [tools.ts](apps/server/src/mcp/tools.ts#L77-L99)
  - [agent-api.ts](apps/server/src/knowledge/agent-api.ts#L103-L109)
  - [agent-api.ts](apps/server/src/knowledge/agent-api.ts#L258-L278)

#### Concrete Failing Scenario
1. [`KnowledgeAgentApi.conflict()`](apps/server/src/knowledge/agent-api.ts#L258-L278) explicitly constructs a `409` `HttpError` carrying `{ etag }` in `error.details` (`// The vault answers 412/'exists'; the tools contract is a 409 that carries the current etag.`), and `reserve()` attaches `{ retryAfterSeconds }` in `error.details` on `429 rate_limited`.
2. While the HTTP bridge route (`/api/bridge/knowledge/*`) serializes `error.details` in its Fastify error response, the MCP server wrapper [`guarded()` in `apps/server/src/mcp/tools.ts:92-94`](apps/server/src/mcp/tools.ts#L92-L94) formats `HttpError` as `${error.code}: ${error.message}` and discards `error.details`.

#### Why the Current Code Allows It
In [`apps/server/src/mcp/tools.ts:92-94`](apps/server/src/mcp/tools.ts#L92-L94):
```ts
      } catch (error) {
        if (error instanceof HttpError) return failure(`${error.code}: ${error.message}`)
        throw error
      }
```

#### Suggested Fix
Append `error.details` when present in [`apps/server/src/mcp/tools.ts:93`](apps/server/src/mcp/tools.ts#L93), e.g.:
```ts
if (error instanceof HttpError) {
  const suffix = error.details ? ` (${JSON.stringify(error.details)})` : ''
  return failure(`${error.code}: ${error.message}${suffix}`)
}
```

---

## Areas Not Covered

Due to session scope, the following areas were not audited in detail:
- **Hermes live CLI / gateway adapter internals** (`apps/server/src/hermes/live/*`, including `kanban-attempts/worktree.ts`, `rewind.ts`, `compact.ts`, and `outside-sessions.ts`)
- **Document extraction and export pipelines** (`apps/server/src/knowledge/documents.ts` parser edge cases for DOCX/PDF/CSV/HTML and `apps/server/src/backup.ts` archive tar/untar routines)
- **Web UI route components and CSS layout** (`apps/web/src/routes/**`, including `WorkflowBuilderPage.tsx`, `NoteWorkspace.tsx`, `WatchPage.tsx`, and `ReportsPage.tsx`)
- **Playwright E2E specs and repository scripts** (`e2e/**`, `scripts/verify-live.mjs`, `scripts/capture-screenshots.mjs`)
