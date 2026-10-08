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

test('GET /api/reports/export.csv returns the By agent table as a download', async () => {
  const response = await app.inject('/api/reports/export.csv?range=7d')
  expect(response.statusCode).toBe(200)
  expect(response.headers['content-type']).toBe('text/csv; charset=utf-8')
  expect(response.headers['content-disposition']).toMatch(
    /^attachment; filename="score-report-7d-\d{4}-\d{2}-\d{2}\.csv"$/,
  )
  const report = ReportsSchema.parse((await app.inject('/api/reports?range=7d')).json())
  const lines = response.body.trimEnd().split('\r\n')
  expect(lines[0]).toBe('Agent,Finished,Runs,Median time (min),First-time pass (%),Spend (USD)')
  expect(lines).toHaveLength(report.byAgent.length + 1)
  expect((await app.inject('/api/reports/export.csv?range=bad')).statusCode).toBe(400)
})

test('the seeded demo history fills every part of the report', async () => {
  const seeded = new FakePort(1, { db: env.db }, false, undefined, true)
  await seeded.start(env.ingest)
  const demo = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port: seeded,
    db: env.db,
    ingest: env.ingest,
    clock: () => now,
  })
  try {
    for (const range of ['7d', '30d'] as const) {
      const report = ReportsSchema.parse((await demo.inject(`/api/reports?range=${range}`)).json())
      expect(report.totals.tasksFinished).toBeGreaterThan(range === '7d' ? 10 : 50)
      expect(report.totals.firstPassRate).toBeGreaterThan(0.5)
      expect(report.totals.firstPassRate).toBeLessThan(0.95)
      expect(report.approvals.asked).toBeGreaterThan(3)
      expect(report.approvals.denied).toBeGreaterThanOrEqual(0)
      for (const id of ['lead', 'builder', 'designer']) {
        const split = report.timeSplit.find((row) => row.agentId === id)!
        expect(split.workingPct).toBeGreaterThan(0)
        expect(split.waitingOnAgentPct).toBeGreaterThan(0)
      }
      expect(report.byAgent.find((row) => row.agentId === 'reviewer')?.firstPassRate).toBeNull()
    }
    const again = (await demo.inject('/api/reports?range=7d')).json()
    expect((await demo.inject('/api/reports?range=7d')).json()).toEqual(again)
  } finally {
    await demo.close()
    await seeded.stop()
  }
})
