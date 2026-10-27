import fs from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ReportsSchema } from '@score/contract'
import { reconcileAgents } from '../../src/domain/agents.ts'
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
  // Reports read Score's agent projection (the app fills it when the agent list is requested).
  await reconcileAgents(env.ingest, await port.listAgentDetails())
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
    // The trend is always the last 30 local days, whatever the range.
    expect(report.trend).toHaveLength(30)
    expect(report.trend.at(-1)!.date).toBe(report.byDay.at(-1)!.date)
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

test('3.10.0: speedByAgent holds the medians of the range’s measured runs', async () => {
  const insert = env.db.sqlite.prepare(
    `INSERT INTO runs (id, profile, origin, status, started_at, first_output_at, ended_at, output_tokens, updated_at)
     VALUES (?, 'builder', 'score', 'completed', '2026-03-10T08:00:00.000Z', ?, ?, ?, '2026-03-10T09:00:00.000Z')`,
  )
  insert.run('s1', '2026-03-10T08:00:01.000Z', '2026-03-10T08:00:03.000Z', 100)
  insert.run('s2', '2026-03-10T08:00:03.000Z', '2026-03-10T08:00:05.000Z', 400)
  insert.run('s3', null, '2026-03-10T08:00:05.000Z', 400)
  const report = ReportsSchema.parse((await app.inject('/api/reports?range=today')).json())
  expect(report.speedByAgent).toEqual([
    { agentId: 'builder', runs: 2, medianTtftMs: 2000, medianTokensPerSecond: 125 },
  ])
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
  await reconcileAgents(env.ingest, await seeded.listAgentDetails())
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
      expect(report.trend.some((day) => day.runs > 0 && (day.spendUsd ?? 0) > 0)).toBe(true)
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

test('days follow the viewer time zone the browser sends, and a bogus zone is refused', async () => {
  // 10:00 UTC on 10 March is already 11 March in Kiritimati (UTC+14) and still 9 March in Pago Pago (UTC-11).
  const dayIn = async (tz: string) => {
    const response = await app.inject(`/api/reports?range=today&tz=${encodeURIComponent(tz)}`)
    expect(response.statusCode).toBe(200)
    return ReportsSchema.parse(response.json()).byDay.map((day) => day.date)
  }
  expect(await dayIn('Pacific/Kiritimati')).toEqual(['2026-03-11'])
  expect(await dayIn('Pacific/Pago_Pago')).toEqual(['2026-03-09'])
  expect((await app.inject('/api/reports?range=today&tz=Not%2FAZone')).statusCode).toBe(400)
  const csv = await app.inject('/api/reports/export.csv?range=today&tz=Pacific%2FKiritimati')
  expect(csv.headers['content-disposition']).toContain('2026-03-11')
})

test('reports never wait on Hermes listing agents', async () => {
  port.listAgents = () => new Promise(() => {})
  const response = await app.inject('/api/reports?range=7d')
  expect(response.statusCode).toBe(200)
  expect(ReportsSchema.parse(response.json()).byAgent.length).toBeGreaterThan(0)
  expect((await app.inject('/api/reports/export.csv?range=7d')).statusCode).toBe(200)
})

test('a custom range answers per day and its CSV follows it', async () => {
  const url = '?range=custom&from=2026-03-01&to=2026-03-10&tz=UTC'
  const response = await app.inject(`/api/reports${url}`)
  expect(response.statusCode).toBe(200)
  const report = ReportsSchema.parse(response.json())
  expect(report.range).toBe('custom')
  expect(report.byDay.map((day) => day.date)[0]).toBe('2026-03-01')
  expect(report.byDay).toHaveLength(10)
  const csv = await app.inject(`/api/reports/export.csv${url}`)
  expect(csv.statusCode).toBe(200)
  expect(csv.headers['content-disposition']).toBe(
    'attachment; filename="score-report-2026-03-01_2026-03-10.csv"',
  )
})

test.each([
  ['?range=custom', /needs both dates/],
  ['?range=custom&from=2026-03-01', /needs both dates/],
  ['?range=custom&from=2026-03-05&to=2026-03-01', /after to/],
  ['?range=custom&from=2026-03-01&to=2026-03-12&tz=UTC', /after today/],
  ['?range=custom&from=2024-01-01&to=2026-03-01', /at most 366/],
  ['?range=custom&from=2026-02-31&to=2026-03-01', /real dates/],
  ['?range=custom&from=2026-13-01&to=2026-13-02', /real dates/],
  ['?range=7d&from=2026-03-01&to=2026-03-02', /only work with a custom range/],
])('an unusable custom range %s is a clear 400', async (query, message) => {
  for (const path of ['/api/reports', '/api/reports/export.csv']) {
    const response = await app.inject(`${path}${query}`)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(message)
  }
})
