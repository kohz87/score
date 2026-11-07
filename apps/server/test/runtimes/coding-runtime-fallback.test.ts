import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import {
  addAgent,
  app,
  boot,
  coding,
  db,
  finished,
  launches,
  log,
  makeRoom,
  processRows,
  rebootWith,
  replies,
  request,
  roomId,
  runs,
  say,
  seedCrashedRun,
  setupCodingRuntime,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

// ---- 7.7a part 3: the acceptance matrix holds on the fallback backend too -----------------------------------------------

test('fallback: a clean exit with text but no explicit success is no result (the exit-zero fallback is gone)', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:nosuccess] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toContain('without a result Score can use')
})

test('fallback: an event that cannot be saved makes the result not used, however the CLI ended', async () => {
  let failed = false
  await rebootWith({
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The first saved event of the run fails once.
        if (!failed && /^coding:cr_[^:]+:0$/.test(observation.identity)) {
          failed = true
          return Promise.reject(new Error('database is locked'))
        }
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  expect(failed).toBe(true)
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/complete record/)
})

test('fallback: hand-offs read only the final validated Codex message', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:commentary] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(
    db.sqlite.prepare("SELECT agent_id FROM message_runs WHERE from_agent_id = 'cx'").all(),
  ).toEqual([])
  await say('@cx [fixture:malformed] go')
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
})

test('a turn the journal says may already have run is refused and never spawned (7.7a code review #4)', async () => {
  await addAgent()
  db.sqlite
    .prepare(
      `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed, waiver,
         journal_n, unsendable, updated_at) VALUES ('l-seen', 'r-seen', 'turn-seen', 1, 'releasing', 0, 1, 0, 1, 1, '2026-10-12T00:00:00.000Z')`,
    )
    .run()
  await expect(
    coding.startRun({ agentId: 'coder', input: 'go', turnId: 'turn-seen' }),
  ).rejects.toMatchObject({ status: 409, code: 'turn_witnessed' })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

// ---- FZ1 (re-review 2026-10-12 #5, #9, #12, #17): the process-group fallback end to end -----------------------------------

test('#12: a labelled secret in a tool name never reaches the tool card, the run row or its tool list', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:toolsecret] go')
  await finished()
  const stored = JSON.stringify([
    db.sqlite.prepare('SELECT * FROM tool_calls').all(),
    db.sqlite.prepare('SELECT tools_used FROM runs').all(),
    db.sqlite.prepare('SELECT data FROM events').all(),
  ])
  expect(stored).not.toContain('review-sentinel')
})

test('#9: a success record with no terminating newline is no success: the run fails and says the record is incomplete', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:partial] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('complete record')
  expect(JSON.stringify(replies()[0]!.parts)).not.toContain('Done.')
})

test('#5: a long secret value on stderr never reaches the failure notice or any stored text', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stderrleak] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  const stored = JSON.stringify([
    runs(),
    replies().map((reply) => reply.parts),
    db.sqlite.prepare('SELECT data FROM events').all(),
  ])
  expect(stored).not.toMatch(/v{20}/)
})

test('#17: Stop, the wall-clock limit and shutdown each hand their cause to the stop hook', async () => {
  const causes: string[] = []
  await coding.close()
  await app.close()
  await boot({ onStop: (cause) => causes.push(cause) })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 10_000 })
  const reply = replies()[0]!
  await request('POST', `/api/rooms/${roomId}/messages/${reply.id}/stop`)
  await finished()
  expect(causes).toEqual(['user'])
})

test('#17: the wall-clock limit reaches the stop hook as `deadline`', async () => {
  const causes: string[] = []
  await coding.close()
  await app.close()
  await boot({ maxTurnMs: 300, graceMs: 100, onStop: (cause) => causes.push(cause) })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] forever')
  await finished()
  expect(causes).toEqual(['deadline'])
})

test('#17: a failing stop hook is reported and the stop goes on', async () => {
  const errors: unknown[] = []
  await coding.close()
  await app.close()
  await boot({
    maxTurnMs: 300,
    graceMs: 100,
    onStop: () => {
      throw new Error('journal down')
    },
  })
  ;(coding as unknown as { deps: { onError?: (e: unknown) => void } }).deps.onError = (e) =>
    errors.push(e)
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] forever')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(errors.length).toBeGreaterThan(0)
})

test('#6: a process row the installation does not own is never signalled, in recovery or by the reaper, and is not ours', async () => {
  const asked: string[] = []
  await rebootWith({
    reapRetryMs: 20,
    ownsProcessRow: (runId) => runId !== 'cr_inherited',
    killGroup: async (record) => {
      asked.push(`${record.pid}`)
      return 'gone'
    },
  })
  await addAgent()
  seedCrashedRun('cr_inherited', { pid: 4_000_011, start: '5' })
  seedCrashedRun('cr_ours', { pid: 4_000_012, start: '5' })
  await coding.recover()
  await new Promise((r) => setTimeout(r, 150))
  expect(asked).toEqual(['4000012'])
  // Left as it was: not signalled, not deleted, not marked unresolved.
  expect(processRows()).toEqual([{ run_id: 'cr_inherited', unresolved: 0 }])
  // The reaper path (a Stop for that run) doesn't signal it either.
  await coding.stopRun({ agentId: 'coder', runId: 'cr_inherited' })
  expect(asked).toEqual(['4000012'])
})

test('FV #1: a frozen home starts no CLI and signals no recorded group, in recovery or by the reaper', async () => {
  let holding: string | null = 'Score is holding all agent work: this folder is a copy.'
  const asked: string[] = []
  await rebootWith({
    reapRetryMs: 20,
    frozen: () => holding,
    killGroup: async (record) => {
      asked.push(`${record.pid}`)
      return 'gone'
    },
  })
  await addAgent()
  seedCrashedRun('cr_inherited', { pid: 4_000_021, start: '5' })
  await coding.recover()
  await new Promise((r) => setTimeout(r, 150))
  expect(asked).toEqual([])
  expect(processRows()).toEqual([{ run_id: 'cr_inherited', unresolved: 0 }])
  // A Stop is refused with the freeze sentence (FT #5) and signals nothing.
  await expect(coding.stopRun({ agentId: 'coder', runId: 'cr_inherited' })).rejects.toMatchObject({
    code: 'execution_frozen',
  })
  expect(asked).toEqual([])
  const before = launches
  await expect(
    coding.startRun({ agentId: 'coder', input: 'hi', turnId: 'turn-frozen' }),
  ).rejects.toMatchObject({ message: holding })
  expect(launches).toBe(before)
  expect(coding.backend().note).toBe(holding)
  // Unfrozen, the same row is signalled.
  holding = null
  await coding.recover()
  expect(asked).toEqual(['4000021'])
})

// PLAN 8.1 (decision 82): CLI quota meters.
