import type { DatabaseSync } from 'node:sqlite'
import { verifyCoding } from './coding-checkpoint.ts'
import { foldCodingLaunches } from './coding-records.ts'
import { foldHistory, journalDispatches, type JournalEntry, type LaunchFolder } from './journal.ts'
import { readGlobal } from './fence-read.ts'
import type { Mismatch } from './fence-types.ts'

function acceptedSet(entries: readonly JournalEntry[]): Set<number> {
  const accepted = new Set<number>()
  for (const entry of entries)
    if (entry.kind === 'global_fence' && entry.action === 'lift')
      for (const n of entry.accepted ?? []) accepted.add(n)
  return accepted
}

export function verifyJournal(sqlite: DatabaseSync, entries: readonly JournalEntry[]): Mismatch[] {
  const accepted = acceptedSet(entries)
  const mismatches: Mismatch[] = []
  const attempt = sqlite.prepare(
    'SELECT state, run_id, sent_at, abandoned_at, dispatch_generation, refused_generation FROM orc_attempts WHERE id = ?',
  )
  const orchestration = sqlite.prepare(
    'SELECT stop_requested_at, finish_requested_at, waiver_at, status, manual_paused_at FROM orchestrations WHERE id = ?',
  )
  const attemptStop = sqlite.prepare('SELECT stop_requested_at FROM orc_attempts WHERE id = ?')
  const pruned = new Set(
    (
      sqlite
        .prepare("SELECT orchestration_id AS id FROM orc_history WHERE kind = 'pruned'")
        .all() as {
        id: string
      }[]
    ).map((row) => row.id),
  )
  // 3.8.4 (owner): entries that name only an attempt (a run handle) belong to the run the journal started it in. A run
  // whose room was deleted is pruned without compacting the journal first, so its handles stay; they are no doubt either.
  // An attempt id two runs claim maps to neither, so its entries are checked (fail closed).
  const attemptRun = new Map<string, string | null>()
  for (const entry of entries)
    if ('orchestrationId' in entry && 'attemptId' in entry && typeof entry.attemptId === 'string') {
      const seen = attemptRun.get(entry.attemptId)
      const run = entry.orchestrationId as string
      attemptRun.set(entry.attemptId, seen === undefined || seen === run ? run : null)
    }
  const dbSeq = readGlobal(sqlite).fence_seq
  let journalSeq = 0
  // The last pause/resume per orchestration decides whether the journal expects a pause.
  const lastPauseState = new Map<string, { what: 'pause' | 'resume'; n: number }>()
  for (const entry of entries) {
    if (
      (entry.kind === 'transition' || (entry.kind === 'tombstone' && entry.of === 'transition')) &&
      (entry.what === 'pause' || entry.what === 'resume')
    )
      lastPauseState.set(entry.orchestrationId, { what: entry.what, n: entry.n })
  }
  // The newest authorization per orchestration and the newest hold per target say what the database must at least hold.
  const authorization = new Map<string, Extract<JournalEntry, { kind: 'authorization' }>>()
  const hold = new Map<string, Extract<JournalEntry, { kind: 'hold' }>>()
  for (const entry of entries) {
    if (entry.kind === 'authorization') authorization.set(entry.orchestrationId, entry)
    if (entry.kind === 'hold')
      hold.set(entry.target === 'team' ? 'team' : `agent:${entry.agentId}`, entry)
  }
  const remap = new Map<string, Extract<JournalEntry, { kind: 'remap' }>>()
  for (const entry of entries)
    if (entry.kind === 'remap') remap.set(`${entry.orchestrationId}:${entry.agentId}`, entry)
  // 7.7c: the newest renewal of each coding node (its count and successor attempt).
  const renewal = new Map<string, Extract<JournalEntry, { kind: 'renewal' }>>()
  for (const entry of entries)
    if (entry.kind === 'renewal') renewal.set(`${entry.orchestrationId}:${entry.nodeId}`, entry)
  // 7.7b: the newest settings a coding worker was remapped to (a database restored from before it would run the old ones).
  const policyRemap = new Map<string, Extract<JournalEntry, { kind: 'policy_remap' }>>()
  for (const entry of entries)
    if (entry.kind === 'policy_remap')
      policyRemap.set(`${entry.orchestrationId}:${entry.agentId}`, entry)
  const limits = sqlite.prepare(
    'SELECT budget_usd, deadline_at, accepted_unknown_spend, coding_steps, accepted_unknown_cost FROM orchestrations WHERE id = ?',
  )
  // v8.2 / v8.3: only the newest word on an attempt's dispatch counts; older generations are history.
  const dispatches = journalDispatches(entries)
  for (const entry of entries) {
    if (entry.kind === 'global_fence') journalSeq = Math.max(journalSeq, entry.fenceSeq)
    if (accepted.has(entry.n)) continue
    const orchestrationId =
      'orchestrationId' in entry
        ? (entry.orchestrationId as string)
        : 'attemptId' in entry && typeof entry.attemptId === 'string'
          ? (attemptRun.get(entry.attemptId) ?? undefined)
          : undefined
    if (orchestrationId && pruned.has(orchestrationId)) continue
    const kind = entry.kind === 'tombstone' ? entry.of : entry.kind
    if (entry.kind === 'authorization') {
      if (authorization.get(entry.orchestrationId) !== entry) continue
      const row = limits.get(entry.orchestrationId) as
        | {
            budget_usd: number | null
            deadline_at: string | null
            accepted_unknown_spend: number
            coding_steps: number
            accepted_unknown_cost: string
          }
        | undefined
      const lost: string[] = []
      if (!row) lost.push('the run')
      else {
        if (
          entry.budgetUsd !== null &&
          (row.budget_usd === null || row.budget_usd > entry.budgetUsd)
        )
          lost.push('a lowered budget')
        if (
          entry.deadlineAt !== null &&
          (row.deadline_at === null || Date.parse(row.deadline_at) > Date.parse(entry.deadlineAt))
        )
          lost.push('a shorter deadline')
        if (!entry.acceptUnknownSpend && row.accepted_unknown_spend === 1)
          lost.push('a revoked unknown-spend acceptance')
        // 7.7b: a lowered coding step limit, or an unknown-cost acceptance taken back, that this database lacks.
        if (entry.codingSteps !== undefined && row.coding_steps > entry.codingSteps)
          lost.push('a lowered coding step limit')
        if (
          entry.acceptUnknownCost !== undefined &&
          (JSON.parse(row.accepted_unknown_cost) as string[]).some(
            (source) => !entry.acceptUnknownCost!.includes(source),
          )
        )
          lost.push('an unknown-cost acceptance that was taken back')
      }
      if (lost.length > 0)
        mismatches.push({
          kind: 'fence',
          ref: entry.orchestrationId,
          journalN: entry.n,
          detail: `The limits of ${entry.orchestrationId} were tightened (${lost.join(', ')}), but the database does not hold that`,
        })
    } else if (entry.kind === 'remap') {
      if (remap.get(`${entry.orchestrationId}:${entry.agentId}`) !== entry) continue
      const row = sqlite
        .prepare(
          'SELECT incarnation FROM orc_agent_map WHERE orchestration_id = ? AND agent_id = ?',
        )
        .get(entry.orchestrationId, entry.agentId) as { incarnation: string } | undefined
      if (!row || row.incarnation !== entry.incarnation)
        mismatches.push({
          kind: 'fence',
          ref: entry.orchestrationId,
          journalN: entry.n,
          detail: `The remap of ${entry.agentId} in ${entry.orchestrationId} was recorded, but the database does not hold it`,
        })
    } else if (entry.kind === 'renewal') {
      if (renewal.get(`${entry.orchestrationId}:${entry.nodeId}`) !== entry) continue
      const node = sqlite
        .prepare('SELECT renewals FROM wf_nodes WHERE orchestration_id = ? AND node_id = ?')
        .get(entry.orchestrationId, entry.nodeId) as { renewals: number } | undefined
      const successor = attempt.get(entry.successorId)
      if (!node || node.renewals < entry.renewals || !successor)
        mismatches.push({
          kind: 'fence',
          ref: entry.orchestrationId,
          journalN: entry.n,
          detail: `Try again for ${entry.nodeId} in ${entry.orchestrationId} (renewal ${entry.renewals}) was recorded, but the database does not hold it`,
        })
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
    } else if (entry.kind === 'hold') {
      const key = entry.target === 'team' ? 'team' : `agent:${entry.agentId}`
      if (hold.get(key) !== entry || entry.action !== 'set') continue
      const held =
        entry.target === 'team'
          ? sqlite.prepare('SELECT 1 FROM team_state WHERE id = 1 AND paused_at IS NOT NULL').get()
          : sqlite.prepare('SELECT 1 FROM agent_pauses WHERE agent_id = ?').get(entry.agentId ?? '')
      if (!held)
        mismatches.push({
          kind: 'fence',
          ref: key,
          journalN: entry.n,
          detail: `The pause of ${entry.target === 'team' ? 'the team' : `agent ${entry.agentId}`} was recorded, but the database does not hold it`,
        })
    } else if (
      kind === 'send_started' ||
      kind === 'witness' ||
      entry.kind === 'send_refused' ||
      entry.kind === 'send_closed' ||
      entry.kind === 'witness'
    ) {
      const id = (entry as { attemptId: string }).attemptId
      const latest = dispatches.get(id)
      if (!latest || latest.n !== entry.n) continue
      const row = attempt.get(id) as
        | { sent_at: string | null; dispatch_generation: number; refused_generation: number }
        | undefined
      if (!row || (latest.state === 'sent' && row.sent_at === null))
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `Admission of attempt ${id} was started, but the database has no record of it`,
        })
      else if (
        latest.state === 'refused' &&
        latest.generation > 0 &&
        row.refused_generation < latest.generation
      )
        // The journal proves generation g was refused, but the database never committed that refusal (a crash between
        // the two): its state at g may still read "sent".
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `The journal records a refusal of dispatch generation ${latest.generation} of attempt ${id}, but the database does not hold it`,
        })
      else if (
        latest.state === 'closed' &&
        latest.generation > 0 &&
        (
          sqlite
            .prepare(
              'SELECT closed_cause FROM orc_generations WHERE attempt_id = ? AND generation = ?',
            )
            .get(id, latest.generation) as { closed_cause: string | null } | undefined
        )?.closed_cause === null
      )
        // The journal proves generation g launched nothing and was closed; the database never committed that.
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `The journal records dispatch generation ${latest.generation} of attempt ${id} as closed, but the database does not hold it`,
        })
      else if (latest.generation > 0 && row.dispatch_generation < latest.generation)
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `The journal records dispatch generation ${latest.generation} of attempt ${id} (${latest.state === 'sent' ? 'sent' : 'refused'}), but the database is behind it`,
        })
    } else if (entry.kind === 'run_handle') {
      const row = attempt.get(entry.attemptId) as
        { run_id: string | null; dispatch_generation: number } | undefined
      // Only the latest admitted generation's handle is verified; older ones are evidence (7.7b §5). A generation's own
      // handle lives on its generation row (the attempt's run_id is cleared when that generation is closed).
      if (entry.generation !== undefined) {
        if (row && entry.generation < row.dispatch_generation) continue
        const held = sqlite
          .prepare('SELECT run_id FROM orc_generations WHERE attempt_id = ? AND generation = ?')
          .get(entry.attemptId, entry.generation) as { run_id: string | null } | undefined
        if (!held || held.run_id !== entry.runId)
          mismatches.push({
            kind: 'handle',
            ref: entry.attemptId,
            journalN: entry.n,
            detail: `Run ${entry.runId} was returned for generation ${entry.generation} of attempt ${entry.attemptId}, but the database does not hold that handle`,
          })
        continue
      }
      if (!row || row.run_id !== entry.runId)
        mismatches.push({
          kind: 'handle',
          ref: entry.attemptId,
          journalN: entry.n,
          detail: `Hermes run ${entry.runId} was returned for attempt ${entry.attemptId}, but the database does not hold that handle`,
        })
    } else if (kind === 'stop_fence') {
      const e = entry as { orchestrationId: string; attemptId?: string }
      const row = (
        e.attemptId === undefined
          ? orchestration.get(e.orchestrationId)
          : attemptStop.get(e.attemptId)
      ) as { stop_requested_at: string | null } | undefined
      if (!row || row.stop_requested_at === null)
        mismatches.push({
          kind: 'fence',
          ref: e.attemptId ?? e.orchestrationId,
          journalN: entry.n,
          detail: `Stop was requested for ${e.attemptId ?? e.orchestrationId}, but the database does not record it`,
        })
    } else if (kind === 'transition') {
      const e = entry as { orchestrationId: string; what: string; attemptIds?: string[]; n: number }
      const row = orchestration.get(e.orchestrationId) as
        | {
            finish_requested_at: string | null
            waiver_at: string | null
            status: string
            manual_paused_at: string | null
          }
        | undefined
      let missing = !row
      if (row && e.what === 'finish') missing = row.finish_requested_at === null
      if (row && e.what === 'waiver') missing = row.waiver_at === null
      if (row && e.what === 'pause')
        missing =
          lastPauseState.get(e.orchestrationId)?.what === 'pause' &&
          lastPauseState.get(e.orchestrationId)!.n === e.n &&
          row.manual_paused_at === null &&
          (row.status === 'running' || row.status === 'paused')
      if (row && e.what === 'abandon')
        missing = (e.attemptIds ?? []).some(
          (id) =>
            (attempt.get(id) as { abandoned_at: string | null } | undefined)?.abandoned_at == null,
        )
      if (e.what === 'resume') missing = false
      if (missing)
        mismatches.push({
          kind: 'fence',
          ref: e.orchestrationId,
          journalN: entry.n,
          detail: `The ${e.what} of ${e.orchestrationId} was recorded, but the database does not hold it`,
        })
    }
  }
  if (journalSeq > dbSeq) {
    const newest = entries.findLast(
      (entry) => entry.kind === 'global_fence' && entry.fenceSeq === journalSeq,
    )
    if (newest && !accepted.has(newest.n))
      mismatches.push({
        kind: 'fence',
        ref: 'global',
        journalN: newest.n,
        detail: 'A global fence change is newer than the database',
      })
  }
  // 7.7a §2: coding launches and the database's checkpoint sequence.
  mismatches.push(...verifyCoding(sqlite, entries, accepted))
  return mismatches
}

/**
 * Orchestration-only loss (decision 72): every attempt the database says was dispatched has a `send_started` record (or
 * the tombstone compaction leaves) in the journal. One without it means the journal lost a witness (a truncated or
 * replaced file) even when no coding state is involved. Attempts of an archived history (created before the newest
 * reset, or retired by it) are exempt: their witnesses are in the archive.
 */
export function unjournaledAttempts(
  sqlite: DatabaseSync,
  entries: readonly JournalEntry[],
  scope: string,
): Mismatch[] {
  const known = journalDispatches(entries.filter((entry) => entry.scope === scope))
  const resetAt = foldHistory(entries, scope).resetAt
  const rows = sqlite
    .prepare(
      `SELECT id, created_at, dispatch_generation FROM orc_attempts WHERE dispatch_generation > 0 AND unknown_reason IS NOT 'history_reset'`,
    )
    .all() as { id: string; created_at: string; dispatch_generation: number }[]
  // The journal is written before the database commits a dispatch, so it can never hold an older generation of an
  // attempt than the database does: a surviving older word (a refusal, an earlier send) is a truncated journal, not a
  // match (re-review 6 #7). A generation of 0 is a tombstone that kept no number.
  const lostWitness = (row: { id: string; dispatch_generation: number }): boolean => {
    const witness = known.get(row.id)
    return !witness || (witness.generation > 0 && witness.generation < row.dispatch_generation)
  }
  return rows
    .filter((row) => lostWitness(row) && (resetAt === null || row.created_at >= resetAt))
    .slice(0, 20)
    .map((row) => ({
      kind: 'attempt' as const,
      ref: row.id,
      journalN: null,
      lost: true,
      detail: `The database dispatched attempt ${row.id}, but the journal has no record of that: the journal lost a witness`,
    }))
}

/**
 * Launch folders that hold receipts the journal has no launch for: evidence this installation can't account for (the
 * journal lost a witness). No lift, time or earlier decision accounts for them; only `reset-history` does.
 */
export function unownedLaunchFolders(
  entries: readonly JournalEntry[],
  folders: readonly LaunchFolder[],
): Mismatch[] {
  const known = foldCodingLaunches(entries)
  return folders
    .filter((folder) => !known.has(folder.id))
    .map(({ id }) => ({
      kind: 'journal' as const,
      ref: `launch-folder:${id}`,
      journalN: null,
      lost: true,
      detail: `A launch folder (${id}) holds receipts, but the journal has no coding launch with that id: the journal lost a witness`,
    }))
}
