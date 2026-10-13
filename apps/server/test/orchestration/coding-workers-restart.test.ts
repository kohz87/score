import { afterEach, describe, expect, test, vi } from 'vitest'
import { codingProjection } from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { unitNameFor } from '../../src/runtimes/coding/units.ts'
import { INSTALLATION, workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-1 #8 (design §10): the restart matrix, one test per row. Each starts from a real finished coding step, rewinds
// the attempt, its run and its launch to what a crash would have left (the journal and the database are written through
// the real CodingJournal and projection), restarts every layer, and checks the executor's outcome.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

type LaunchShape =
  | { kind: 'absent' }
  | { kind: 'armed' }
  | { kind: 'revoked'; cause: string }
  | { kind: 'releasing' }
  | { kind: 'ended' }

interface Forge {
  attempt: 'send_started' | 'running'
  /** The generation's run row: absent (the crash came before the coding runtime admitted it) or in this status. */
  run: 'none' | { status: string; unconfirmed?: boolean; pendingSuccess?: boolean }
  launch: LaunchShape
}

const attempt = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n")[0]!
const step = () => h.rows<Record<string, unknown>>('SELECT * FROM orc_steps')[0]!
const gens = () =>
  h.rows<Record<string, unknown>>('SELECT * FROM orc_generations ORDER BY generation')
/** The closures of the journal: the records themselves, or the witness compaction folds an older generation into. */
const closures = () => {
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.filter(
    (e) => e.kind === 'send_closed' || (e.kind === 'witness' && e.lastState === 'closed'),
  )
}

/** A coding step that has run to its end once; the lead keeps the orchestration open afterwards. */
async function finished(): Promise<string> {
  h = await workerHarness({
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', {
            agent: 'coder',
            instruction: '[fixture:basic] write hello',
          })
          return 'assigned'
        },
        // Later wake-ups only look: the orchestration stays open while the tests rewind and restart it.
        ...Object.fromEntries(
          [2, 3, 4, 5, 6, 7, 8, 9].map((turn) => [turn, async () => 'looking']),
        ),
      }),
    },
  })
  h.addAgent()
  const id = await h.create()
  await h.until(() => attempt()['state'] === 'terminated', 40_000)
  await h.orch.idle()
  return id
}

/** Rewinds the finished step to the state a crash would have left behind. */
function rewind(id: string, forge: Forge): { runId: string; launchId: string } {
  const [generation] = gens()
  const runId = generation!['run_id'] as string
  const turnId = generation!['turn_id'] as string
  const attemptId = attempt()['id'] as string
  const sql = (text: string, ...args: (string | number | null)[]) =>
    h.db.sqlite.prepare(text).run(...args)
  sql(
    "UPDATE orchestrations SET status = 'running', pause_reason = NULL, ended_at = NULL, finish_requested_at = NULL, end_reason = NULL WHERE id = ?",
    id,
  )
  sql("UPDATE orc_steps SET status = 'admitted', result = NULL, disposition = NULL")
  sql(
    'UPDATE orchestrations SET causes_consumed_up_to = (SELECT COALESCE(MAX(id), 0) FROM orc_causes WHERE orchestration_id = orchestrations.id)',
  )
  sql(
    "UPDATE orc_attempts SET state = ?, evidence = NULL, terminated_at = NULL, result_text = NULL, settled = 0, spend_usd = NULL, spend_complete = 0, unknown_reason = NULL WHERE kind = 'step'",
    forge.attempt,
  )
  sql('DELETE FROM coding_run_results')
  // The run ended once for real; its terminal observation must be applicable again, as it would be after a crash.
  sql('DELETE FROM ingest_keys WHERE identity LIKE ?', `coding:${runId}:%`)
  // The launch: a new one in the real journal, owned by this generation.
  const launchId =
    forge.launch.kind === 'absent' ? 'never-requested' : `forged-${forge.launch.kind}`
  if (forge.launch.kind !== 'absent') {
    const journal = new CodingJournal(h.journal)
    const project = codingProjection(h.db, Date.now, (sqlite) =>
      sqlite
        .prepare(
          "UPDATE coding_launches SET backend = 'unit', agent_id = 'coder', runtime = 'claude-code' WHERE launch_id = ?",
        )
        .run(launchId),
    )
    const owner = { orchestrationId: id, attemptId, generation: 1 }
    const unit =
      forge.launch.kind === 'releasing' ? {} : { unit: `${unitNameFor(INSTALLATION, launchId)}` }
    expect(
      journal.requestLaunch(
        { launchId, runId, turnId: `${turnId}-forged`, generation: 0 },
        project,
        { owner, ...unit },
      ).ok,
    ).toBe(true)
    if (
      forge.launch.kind === 'armed' ||
      forge.launch.kind === 'ended' ||
      forge.launch.kind === 'releasing' ||
      forge.launch.kind === 'revoked'
    ) {
      if (forge.launch.kind !== 'releasing')
        journal.arm(
          launchId,
          {
            unit: `${unitNameFor(INSTALLATION, launchId)}`,
            invocationId: 'inv',
            cgroup: '/fake/cg',
          },
          project,
        )
    }
    if (forge.launch.kind === 'revoked')
      journal.revoke(launchId, undefined, project, forge.launch.cause)
    if (forge.launch.kind === 'releasing' || forge.launch.kind === 'ended') {
      if (forge.launch.kind === 'releasing') {
        journal.arm(launchId, { invocationId: 'inv' }, project)
      }
      journal.release(launchId, () => true, project)
    }
    if (forge.launch.kind === 'ended') journal.ended(launchId, { proof: 'cgroup-empty' }, project)
  }
  sql('UPDATE orc_generations SET launch_id = ?, closed_cause = NULL, closed_at = NULL', launchId)
  if (forge.run === 'none') {
    // The crash came before the handle was recorded: the journal never held it.
    h.journal.compact((e) => e.kind === 'run_handle' && e.attemptId === attemptId)
    sql('UPDATE orc_attempts SET run_id = NULL WHERE kind = ?', 'step')
    sql('UPDATE orc_generations SET run_id = NULL')
    sql('DELETE FROM message_runs WHERE run_id = ?', runId)
    sql('DELETE FROM command_intents WHERE idempotency_key = ?', turnId)
    sql('DELETE FROM tool_calls WHERE run_id = ?', runId)
    sql('DELETE FROM run_thinking WHERE run_id = ?', runId)
    sql('DELETE FROM runs WHERE id = ?', runId)
  } else {
    sql(
      'UPDATE runs SET status = ?, terminal_source = ?, ended_at = ? WHERE id = ?',
      forge.run.status,
      forge.run.unconfirmed ? 'unconfirmed' : null,
      ['running', 'queued'].includes(forge.run.status) ? null : new Date().toISOString(),
      runId,
    )
    if (forge.run.pendingSuccess)
      sql(
        'INSERT INTO coding_pending_terminals (run_id, agent_id, room_id, usage, info, created_at) VALUES (?, ?, NULL, NULL, ?, ?)',
        runId,
        'coder',
        JSON.stringify({
          status: 'completed',
          output: 'done',
          reply: 'done',
          costKind: 'estimated',
          group: 'released',
          ownedResult: true,
        }),
        new Date().toISOString(),
      )
  }
  return { runId, launchId }
}

describe('restart matrix (design §10)', () => {
  test('row 1: send_started only, the pre-minted launch id never reached the coding journal -> send_closed (restart), generation 2 runs', async () => {
    const id = await finished()
    rewind(id, { attempt: 'send_started', run: 'none', launch: { kind: 'absent' } })
    await h.restart()
    await h.until(() => gens().length === 2 && attempt()['state'] === 'terminated', 40_000)
    expect(gens()[0]).toMatchObject({ closed_cause: 'restart' })
    expect(closures()).toHaveLength(1)
    expect(step()['status']).toBe('succeeded')
    expect(attempt()).toMatchObject({ refused_total: 0 })
  })

  test('row 2: launch armed, never releasing -> 7.7a revokes it (restart) -> send_closed -> generation 2', async () => {
    const id = await finished()
    const { launchId } = rewind(id, {
      attempt: 'running',
      run: { status: 'running' },
      launch: { kind: 'armed' },
    })
    await h.restart()
    await h.until(() => gens().length === 2 && attempt()['state'] === 'terminated', 40_000)
    expect(
      h.rows(
        'SELECT revoke_cause, may_have_executed FROM coding_launches WHERE launch_id = ?',
        launchId,
      ),
    ).toEqual([{ revoke_cause: 'restart', may_have_executed: 0 }])
    expect(gens()[0]).toMatchObject({ closed_cause: 'restart' })
    expect(step()['status']).toBe('succeeded')
  })

  test('row 3a: a revoke tombstone with a hold cause -> the hold class (generation 2 runs)', async () => {
    const id = await finished()
    rewind(id, {
      attempt: 'running',
      run: { status: 'failed' },
      launch: { kind: 'revoked', cause: 'paused' },
    })
    await h.restart()
    await h.until(() => gens().length === 2 && attempt()['state'] === 'terminated', 40_000)
    expect(gens()[0]).toMatchObject({ closed_cause: 'paused' })
    expect(attempt()).toMatchObject({ refused_total: 0 })
  })

  test('row 3b: a revoke tombstone with a terminal cause -> the attempt ends, the step is cancelled', async () => {
    const id = await finished()
    rewind(id, {
      attempt: 'running',
      run: { status: 'cancelled' },
      launch: { kind: 'revoked', cause: 'stop' },
    })
    await h.restart()
    await h.until(() => attempt()['state'] === 'terminated', 40_000)
    expect(step()).toMatchObject({ status: 'cancelled', disposition: 'stop' })
    expect(gens()).toHaveLength(1)
    expect(attempt()).toMatchObject({ spend_usd: 0, settled: 1 })
  })

  test('row 4: releasing with an unknown outcome -> unknown, the agent is fenced', async () => {
    const id = await finished()
    rewind(id, { attempt: 'running', run: { status: 'running' }, launch: { kind: 'releasing' } })
    await h.restart()
    await h.until(() => attempt()['state'] === 'unknown', 40_000)
    expect(attempt()).toMatchObject({ unknown_reason: 'run_not_proven_ended' })
    expect(step()['status']).toBe('unknown')
    expect(h.orch.summary(id).needsYou).toContainEqual(expect.objectContaining({ kind: 'unknown' }))
    expect(closures()).toHaveLength(0)
    expect(gens()).toHaveLength(1)
  })

  test('row 5: released, the verdict "completed" held but not committed -> interrupted -> a failed try (7.7a rule)', async () => {
    const id = await finished()
    rewind(id, {
      attempt: 'running',
      run: { status: 'running', pendingSuccess: true },
      launch: { kind: 'ended' },
    })
    await h.restart()
    await h.until(() => attempt()['state'] === 'terminated', 40_000)
    expect(
      h.rows<{ status: string }>("SELECT status FROM runs WHERE runtime != 'hermes'")[0]!.status,
    ).toBe('interrupted')
    expect(attempt()).toMatchObject({ evidence: 'failed', result_text: null })
    expect(step()['status']).toBe('failed')
  })

  test('row 6: released, the result already committed -> nothing happens on restart (idempotent)', async () => {
    const id = await finished()
    const before = { attempt: attempt(), step: step(), gens: gens() }
    expect(before.attempt).toMatchObject({ state: 'terminated', evidence: 'completed' })
    const kinds = () =>
      h
        .rows<{ kind: string }>('SELECT kind FROM orc_history WHERE orchestration_id = ?', id)
        .map((r) => r.kind)
        .filter((k) => k !== 'ownership')
    const history = kinds()
    await h.restart()
    await h.orch.idle()
    expect(attempt()).toMatchObject({
      state: 'terminated',
      evidence: 'completed',
      result_text: before.attempt['result_text'],
      dispatch_generation: 1,
    })
    expect(step()['result']).toBe(before.step['result'])
    expect(step()['result_revision']).toBe(before.step['result_revision'])
    expect(gens()).toHaveLength(1)
    expect(kinds()).toEqual(history)
  })

  test('row 7a: released, proven failure -> a failed try', async () => {
    const id = await finished()
    rewind(id, { attempt: 'running', run: { status: 'failed' }, launch: { kind: 'ended' } })
    await h.restart()
    await h.until(() => attempt()['state'] === 'terminated', 40_000)
    expect(attempt()).toMatchObject({ evidence: 'failed' })
    expect(step()['status']).toBe('failed')
  })

  test('row 7b: released, proven stop -> cancelled, no result, not retried', async () => {
    const id = await finished()
    rewind(id, { attempt: 'running', run: { status: 'cancelled' }, launch: { kind: 'ended' } })
    await h.restart()
    await h.until(() => attempt()['state'] === 'terminated', 40_000)
    expect(step()).toMatchObject({ status: 'cancelled' })
    expect(gens()).toHaveLength(1)
  })

  test('row 8: released, end unproven -> unknown (agent fenced); the late proof then closes it without a usable result', async () => {
    const id = await finished()
    rewind(id, {
      attempt: 'running',
      run: { status: 'failed', unconfirmed: true },
      launch: { kind: 'releasing' },
    })
    await h.restart()
    await h.until(() => attempt()['state'] === 'unknown', 40_000)
    expect(step()['status']).toBe('unknown')
  })

  test('row 9: a frozen home -> nothing happens until reset-history', async () => {
    const id = await finished()
    rewind(id, { attempt: 'send_started', run: 'none', launch: { kind: 'absent' } })
    await h.restart({ beforeStart: () => h.fence.freeze('test freeze') })
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(h.fence.executionFrozen()).not.toBeNull()
    expect(closures()).toHaveLength(0)
    expect(gens()).toHaveLength(1)
    expect(gens()[0]!['closed_cause']).toBeNull()
  })
})
