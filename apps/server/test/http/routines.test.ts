import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentDetailSchema, RoutineSummarySchema } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import type { HermesRunner } from '../../src/hermes/live/cli.ts'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import type { HermesPort } from '../../src/hermes/port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: HermesPort
let headers: { 'x-score-client': string; cookie: string }
const fixture = fileURLToPath(new URL('../fixtures/hermes/profiles/', import.meta.url))
const runner = vi.fn<HermesRunner>()
let upstream: string

async function boot(mode: 'fake' | 'live') {
  if (mode === 'live') {
    upstream = fs.mkdtempSync(join(tmpdir(), 'score-routines-http-'))
    fs.cpSync(join(fixture, 'default'), upstream, { recursive: true })
    fs.cpSync(join(fixture, 'builder'), join(upstream, 'profiles', 'builder'), { recursive: true })
    // A stubbed `hermes cron` that edits the jobs file the way Hermes would.
    runner.mockReset().mockImplementation(async (args) => {
      const path = join(upstream, 'profiles', 'builder', 'cron', 'jobs.json')
      const jobs: Record<string, unknown>[] = JSON.parse(fs.readFileSync(path, 'utf8')).jobs
      const [verb, ...rest] = args.slice(3)
      const id = rest[rest.indexOf('--') + 1]
      if (verb === 'create')
        jobs.push({
          id: 'created000001',
          name: rest[0]!.slice(7),
          prompt: rest[3],
          schedule_display: rest[2],
          enabled: true,
        })
      if (verb === 'pause' || verb === 'resume')
        jobs.find((job) => job.id === id)!.enabled = verb === 'resume'
      if (verb === 'remove')
        jobs.splice(
          jobs.findIndex((job) => job.id === id),
          1,
        )
      fs.writeFileSync(path, JSON.stringify({ jobs }))
      return { exitCode: 0 }
    })
    const live = new LivePort({
      scoreHome: env.home,
      hermesHome: upstream,
      db: env.db,
      fetch: env.fake.fetch,
      readCliVersion: async () => null,
      runner,
    })
    await live.start(env.ingest)
    port = live
  } else {
    port = new FakePort(1, { db: env.db }, false)
    await port.start(env.ingest)
  }
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
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
}
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
  if (upstream) fs.rmSync(upstream, { recursive: true, force: true })
  upstream = ''
  vi.restoreAllMocks()
})
const call = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key?: string) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  })

test.each(['fake', 'live'] as const)(
  '%s: create, list, pause, resume, run now and delete',
  async (mode) => {
    await boot(mode)
    const before = (await app.inject('/api/agents/builder/routines')).json().items
    const created = await call(
      'POST',
      '/api/agents/builder/routines',
      { title: 'Build check', schedule: 'every 2h', prompt: 'Check the build.' },
      'create-1',
    )
    expect(created.statusCode).toBe(200)
    const routine = RoutineSummarySchema.parse(created.json())
    expect(routine).toMatchObject({ title: 'Build check', schedule: 'every 2h', enabled: true })
    const replay = await call(
      'POST',
      '/api/agents/builder/routines',
      { title: 'Build check', schedule: 'every 2h', prompt: 'Check the build.' },
      'create-1',
    )
    expect(replay.json()).toEqual(routine)
    const listed = (await app.inject('/api/agents/builder/routines')).json().items
    expect(listed).toHaveLength(before.length + 1)
    expect(listed.map((item: { id: string }) => item.id)).toContain(routine.id)
    if (mode === 'live')
      expect(runner.mock.calls.filter(([args]) => args[3] === 'create')).toHaveLength(1)

    const url = `/api/routines/${routine.id}`
    expect((await call('PATCH', url, { enabled: false })).json().enabled).toBe(false)
    expect((await call('PATCH', url, { enabled: true })).json().enabled).toBe(true)
    const run = await call('POST', `${url}/run`)
    expect(run.statusCode).toBe(200)
    expect(run.json()).toEqual({ id: routine.id, queued: true })
    const removed = await call('DELETE', url)
    expect(removed.json()).toEqual({ id: routine.id })
    expect((await call('DELETE', url)).statusCode).toBe(404)
    expect((await app.inject('/api/agents/builder/routines')).json().items).toHaveLength(
      before.length,
    )
    if (mode === 'live')
      expect(runner.mock.calls.map(([args]) => args.slice(2, 5).join(' '))).toEqual([
        'cron create --name=Build check',
        'cron pause --',
        'cron resume --',
        'cron run --',
        'cron remove --',
      ])
  },
)

test.each(['fake', 'live'] as const)('%s: agent detail carries the routines', async (mode) => {
  await boot(mode)
  await call(
    'POST',
    '/api/agents/builder/routines',
    { title: 'Build check', schedule: 'every 2h', prompt: 'Check the build.' },
    'detail-1',
  )
  const detail = AgentDetailSchema.parse((await app.inject('/api/agents/builder')).json())
  expect(detail.routines.map((item) => item.title)).toContain('Build check')
})

test.each(['fake', 'live'] as const)(
  '%s: mutations need a paired human session, valid bodies and a known target',
  async (mode) => {
    await boot(mode)
    const body = { title: 'T', schedule: 'every 2h', prompt: 'P' }
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/agents/builder/routines',
      payload: body,
    })
    expect([401, 403]).toContain(anonymous.statusCode)
    expect(
      (await call('POST', '/api/agents/builder/routines', { ...body, extra: 1 })).statusCode,
    ).toBe(400)
    expect(
      (await call('POST', '/api/agents/builder/routines', { ...body, prompt: ' ' })).statusCode,
    ).toBe(400)
    expect((await call('PATCH', '/api/routines/builder:nope', {})).statusCode).toBe(400)
    expect((await call('PATCH', '/api/routines/builder:nope', { enabled: true })).statusCode).toBe(
      404,
    )
    expect((await call('POST', '/api/agents/ghost/routines', body)).statusCode).toBe(404)
    expect((await app.inject('/api/agents/ghost/routines')).statusCode).toBe(404)
    if (mode === 'live') expect(runner).not.toHaveBeenCalled()
  },
)
