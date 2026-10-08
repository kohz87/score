import fs from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ReportsSchema } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
const now = Date.parse('2026-03-10T10:00:00Z')

beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  await port.start(env.ingest)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
    clock: () => now,
  })
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
})

test('GET /api/reports returns a contract-valid report for each range', async () => {
  for (const [range, days] of [
    ['today', 1],
    ['7d', 7],
    ['30d', 30],
  ] as const) {
    const response = await app.inject(`/api/reports?range=${range}`)
    expect(response.statusCode).toBe(200)
    const report = ReportsSchema.parse(response.json())
    expect(report.range).toBe(range)
    expect(report.byDay).toHaveLength(days)
    expect(report.totals.spendUsd).toBeGreaterThan(0)
  }
})

test('runs and approvals in the Score DB feed the report', async () => {
  env.db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, status, started_at, ended_at, updated_at)
       VALUES ('r1', 'builder', 'score', 'completed', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z', '2026-03-10T09:00:00.000Z')`,
    )
    .run()
  const response = await app.inject('/api/reports?range=today')
  const report = ReportsSchema.parse(response.json())
  expect(report.totals.runs).toBe(1)
  expect(report.byAgent.find((agent) => agent.agentId === 'builder')?.runs).toBe(1)
  expect(report.timeSplit.find((agent) => agent.agentId === 'builder')?.workingPct).toBe(100)
})

test.each(['', '?range=year', '?range=7d&x=1'])('a bad query %s is a 400', async (query) => {
  const response = await app.inject(`/api/reports${query}`)
  expect(response.statusCode).toBe(400)
  expect(response.json().error.code).toBe('bad_request')
})
