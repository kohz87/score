import { afterEach, expect, test, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { codingProjection } from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { removeCodingAgent } from '../../src/runtimes/coding/store.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-1 #7: controls route by the run's own runtime, a Stop with no run row resolves launch evidence, and an agent
// with unresolved work can't be removed.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  await h?.close()
  h = undefined as never
})

const idle = byTurn({ 1: async () => 'idle' })
const runRow = (id: string) =>
  h.rows<{ status: string }>('SELECT status FROM runs WHERE id = ?', id)[0]

test('Stop routes by runs.runtime: a queued Chat coding turn of an agent removed meanwhile is stopped by the coding runtime', async () => {
  h = await workerHarness({ lead: { script: idle } })
  h.addAgent()
  const first = await h.port.startRun({
    agentId: 'coder',
    input: '[fixture:slow] hold the turn',
    turnId: 'chat-a',
  })
  const second = await h.port.startRun({
    agentId: 'coder',
    input: '[fixture:basic] wait',
    turnId: 'chat-b',
  })
  await h.until(() => runRow(first.runId)?.status === 'running')
  expect(runRow(second.runId)?.status).toBe('queued')
  // The agent is removed while its turns are still queued: it is no coding agent any more, but its runs are.
  removeCodingAgent(h.db.sqlite, 'coder', new Date().toISOString())
  expect(h.coding.isCodingAgent('coder')).toBe(false)
  expect(await h.port.stopRun({ agentId: 'coder', runId: second.runId })).toBe('stopped')
  expect(await h.port.stopRun({ agentId: 'coder', runId: first.runId })).toBe('stopped')
  await h.until(() => runRow(first.runId)?.status === 'cancelled')
  await h.until(() => !['queued', 'running'].includes(runRow(second.runId)?.status ?? 'queued'))
})

test('a coding Stop with no run row resolves the launch evidence: unconfirmed, never not_running', async () => {
  h = await workerHarness({ lead: { script: idle } })
  h.addAgent()
  // The journal holds a requested launch for a run the (restored) database lost.
  const journal = new CodingJournal(h.journal)
  const project = codingProjection(h.db, Date.now, (sqlite) =>
    sqlite
      .prepare(
        "UPDATE coding_launches SET backend = 'unit', agent_id = 'coder' WHERE launch_id = 'ghost'",
      )
      .run(),
  )
  journal.requestLaunch(
    { launchId: 'ghost', runId: 'cr_ghost', turnId: 'ghost-turn', generation: 0 },
    project,
  )
  expect(h.rows('SELECT 1 FROM runs WHERE id = ?', 'cr_ghost')).toHaveLength(0)
  expect(await h.port.stopRun({ agentId: 'coder', runId: 'cr_ghost' })).toBe('unconfirmed')
  // A run nobody knows at all is still not running.
  expect(await h.port.stopRun({ agentId: 'coder', runId: 'cr_nothing' })).toBe('not_running')
  // The Stop was recorded against the launch.
  expect(journal.state('ghost')!.state.stopCause).toBeDefined()
})

test('removing an agent with unresolved work answers 409 agent_busy; once everything has settled it is removed', async () => {
  h = await workerHarness({ lead: { script: idle } })
  h.addAgent()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: h.home }),
    logger: false,
    db: h.db,
    ingest: h.ingest,
    port: h.raw,
    coding: h.coding,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  const headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  const remove = () => app!.inject({ method: 'DELETE', url: '/api/coding-agents/coder', headers })
  // Queued or running.
  const run = await h.port.startRun({
    agentId: 'coder',
    input: '[fixture:slow] hold',
    turnId: 'busy-1',
  })
  await h.until(() => runRow(run.runId)?.status === 'running')
  let response = await remove()
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('agent_busy')
  await h.port.stopRun({ agentId: 'coder', runId: run.runId })
  await h.until(() => runRow(run.runId)?.status === 'cancelled')
  // Ended, but a launch that isn't settled yet (or not proven) still blocks.
  await h.until(() => h.rows("SELECT 1 FROM coding_launches WHERE phase != 'settled'").length === 0)
  // An unproven end blocks too.
  h.db.sqlite.prepare("UPDATE runs SET terminal_source = 'unconfirmed' WHERE id = ?").run(run.runId)
  response = await remove()
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('agent_busy')
  h.db.sqlite.prepare('UPDATE runs SET terminal_source = NULL WHERE id = ?').run(run.runId)
  response = await remove()
  expect(response.statusCode).toBe(204)
})
