import {
  AgentSubagentsSchema,
  JobSchema,
  SubagentRowsResponseSchema,
  type Job,
} from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { ensureTeamRoom } from '../../src/domain/team-room.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let port: FakePort
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let job: Job

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-job-subagents-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const scheduler = new FakeScheduler()
  const ingest = createIngest(db, { clock: () => scheduler.now() })
  port = new FakePort(1, { db, scheduler }, false, () => ({ text: 'Working on it.', tools: [] }))
  await port.start(ingest)
  db.tx((sqlite) => ensureTeamRoom(sqlite, ['lead', 'builder'], new Date().toISOString()))
  app = buildApp({ config: loadConfig({ SCORE_MODE: 'fake' }), logger: false, db, ingest, port })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  const room = (await app.inject({ method: 'GET', url: '/api/team-room', headers })).json() as {
    jobs: Job[]
  }
  job = room.jobs[0]!
})
afterEach(async () => {
  await app.close()
  await port.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a job’s subagent list has the contract’s shape, and an unknown job is not found', async () => {
  expect(job.subagents).toEqual({ enabled: true, maxConcurrent: null, maxTotal: 20, used: 0 })
  const rows = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/subagents`, headers })
  expect(rows.statusCode).toBe(200)
  expect(SubagentRowsResponseSchema.parse(rows.json()).items).toEqual([])
  const missing = await app.inject({ method: 'GET', url: '/api/jobs/nope/subagents', headers })
  expect(missing.statusCode).toBe(404)
})

test('the command’s route changes the job and answers with it', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/jobs/${job.id}/subagents`,
    headers: { ...headers, 'idempotency-key': 'one' },
    payload: { enabled: true, maxConcurrent: 2 },
  })
  expect(response.statusCode).toBe(200)
  expect(JobSchema.parse(response.json()).subagents).toMatchObject({ maxConcurrent: 2 })
})

test('an agent’s ceiling says what Score can control for its program', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/agents/builder/subagents',
    headers,
  })
  expect(response.statusCode).toBe(200)
  expect(AgentSubagentsSchema.parse(response.json())).toMatchObject({
    agentId: 'builder',
    control: 'limits',
    enabled: true,
    maxConcurrent: 4,
  })
  const missing = await app.inject({ method: 'GET', url: '/api/agents/ghost/subagents', headers })
  expect(missing.statusCode).toBe(404)
  const changed = await app.inject({
    method: 'PUT',
    url: '/api/agents/builder/subagents',
    headers,
    payload: { enabled: false, maxConcurrent: 2, maxIterations: 10 },
  })
  expect(changed.statusCode).toBe(200)
  expect(AgentSubagentsSchema.parse(changed.json())).toMatchObject({
    enabled: false,
    maxConcurrent: 2,
    maxIterations: 10,
  })
})
