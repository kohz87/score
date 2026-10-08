import {
  AgentDetailSchema,
  AgentPermissionsResponseSchema,
  RulesResponseSchema,
  RulesWriteResponseSchema,
  RulesPreviewResponseSchema,
} from '@score/contract'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import type { HermesRunner } from '../../src/hermes/live/cli.ts'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let cookie: string
let extraHome: string | undefined
async function boot(port: FakePort | LivePort) {
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
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
}
beforeEach(async () => {
  env = setup()
  await boot(new FakePort(1, { db: env.db }, false))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  if (extraHome) rmSync(extraHome, { recursive: true, force: true })
  extraHome = undefined
})
const human = () => ({ 'x-score-client': 'web', cookie })
const call = (
  method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = human(),
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const rules = async () =>
  RulesResponseSchema.parse((await call('GET', '/api/settings/rules')).json())
const permissions = async (id: string) =>
  AgentDetailSchema.parse((await call('GET', `/api/agents/${id}`)).json()).permissions
const team = {
  mode: 'manual',
  goAhead: ['SQL DROP', 'recursive delete'],
  never: ['*git*  push*   --force*'],
}

test('GET starts from the Hermes defaults: every known category asks, nothing drifts', async () => {
  const view = await rules()
  expect(view).toMatchObject({ mode: 'smart', goAhead: [], never: [] })
  expect(view.askMe.length).toBeGreaterThan(50)
  expect(view.askMe[0]).toMatchObject({ pattern: expect.any(String), readOnly: false })
  expect(view.drift.map((d) => d.agentId).sort()).toEqual([
    'builder',
    'designer',
    'lead',
    'reviewer',
  ])
  expect(view.drift.every((d) => !d.differs)).toBe(true)
})

test('PUT needs a paired human', async () => {
  const response = await call('PUT', '/api/settings/rules', team, { 'x-score-client': 'web' })
  expect(response.statusCode).toBe(401)
})

test('PUT applies the baseline to every profile, normalises globs and fills permissions', async () => {
  const response = await call('PUT', '/api/settings/rules', team)
  expect(response.statusCode).toBe(200)
  const written = RulesWriteResponseSchema.parse(response.json())
  expect(written.failed).toEqual([])
  expect(written.mode).toBe('manual')
  expect(written.goAhead.map((r) => r.id)).toEqual(['SQL DROP', 'recursive delete'])
  expect(written.never).toEqual([
    {
      id: 'never:*git* push* --force*',
      label: '*git* push* --force*',
      pattern: '*git* push* --force*',
      readOnly: false,
    },
  ])
  expect(written.askMe.map((r) => r.id)).not.toContain('SQL DROP')
  expect(written.drift.every((d) => !d.differs)).toBe(true)
  for (const id of ['lead', 'builder']) {
    expect(await permissions(id)).toEqual([
      { id: 'recursive delete', label: 'Recursive delete', level: 'allowed', inherited: true },
      { id: 'SQL DROP', label: 'SQL DROP', level: 'allowed', inherited: true },
      {
        id: 'never:*git* push* --force*',
        label: '*git* push* --force*',
        level: 'never',
        inherited: true,
      },
    ])
  }
})

test('PUT validates: unknown categories, bare wildcards, newlines and extra fields are 400', async () => {
  for (const body of [
    { ...team, goAhead: ['made up category'] },
    { ...team, never: ['*'] },
    { ...team, never: ['  ** ?? '] },
    { ...team, never: ['git\npush*'] },
    { ...team, mode: 'yolo' },
    { ...team, askMe: [] },
  ])
    expect((await call('PUT', '/api/settings/rules', body)).statusCode).toBe(400)
  expect((await rules()).mode).toBe('smart')
})

test('dryRun previews a diff and writes nothing', async () => {
  const response = await call('PUT', '/api/settings/rules?dryRun=1', team)
  expect(response.statusCode).toBe(200)
  const { preview } = RulesPreviewResponseSchema.parse(response.json())
  expect(preview).toContain('+mode: manual')
  expect(preview).toContain('+go ahead: SQL DROP')
  expect(preview).toContain('+never: *git* push* --force*')
  expect((await rules()).mode).toBe('smart')
  expect(await permissions('builder')).toEqual([])
})

test('PATCH may only make an agent stricter than the team', async () => {
  await call('PUT', '/api/settings/rules', team)
  const patch = (agent: string, id: string, level: string) =>
    call('PATCH', `/api/agents/${agent}/permissions/${encodeURIComponent(id)}`, { level })

  // Stricter: take a Go-ahead back, add a Never.
  const asks = await patch('builder', 'SQL DROP', 'asks')
  expect(asks.statusCode).toBe(200)
  expect(asks.json()).toMatchObject({ id: 'SQL DROP', level: 'asks' })
  const added = await patch('builder', 'never:rm -rf /tmp/*', 'never')
  expect(added.statusCode).toBe(200)
  expect(added.json()).toMatchObject({
    id: 'never:rm -rf /tmp/*',
    level: 'never',
    inherited: false,
  })
  const builder = await permissions('builder')
  expect(builder.map((p) => p.id)).not.toContain('SQL DROP')
  expect(builder.find((p) => p.id === 'never:rm -rf /tmp/*')).toMatchObject({ inherited: false })
  expect(builder.find((p) => p.id === 'recursive delete')).toMatchObject({ inherited: true })
  expect((await permissions('lead')).map((p) => p.id)).toContain('SQL DROP')

  // Loosening is rejected, and nothing changes.
  for (const [agent, id, level] of [
    ['builder', 'SQL DROP', 'allowed'], // re-adding a Go-ahead
    ['lead', 'git force push (rewrites remote history)', 'allowed'], // adding a Go-ahead
    ['lead', 'never:*git* push* --force*', 'asks'], // removing a team Never
    ['lead', 'never:*git* push* --force*', 'allowed'],
    ['builder', 'never:rm -rf /tmp/*', 'asks'], // removing an agent Never
  ] as const) {
    const response = await patch(agent, id, level)
    expect(response.statusCode, `${agent} ${id} ${level}`).toBe(400)
    expect(response.json().error.code).toBe('not_stricter')
  }
  expect((await permissions('lead')).map((p) => p.id)).toContain('never:*git* push* --force*')
  expect((await permissions('builder')).map((p) => p.id)).not.toContain('SQL DROP')

  // Other bad input.
  expect((await patch('builder', 'no such category', 'asks')).statusCode).toBe(400)
  expect((await patch('builder', 'SQL DROP', 'never')).statusCode).toBe(400)
  expect((await patch('builder', 'never:*', 'never')).statusCode).toBe(400)
  expect((await patch('nobody', 'SQL DROP', 'asks')).statusCode).toBe(404)
  expect(
    (
      await call(
        'PATCH',
        '/api/agents/builder/permissions/SQL%20DROP',
        { level: 'asks' },
        { 'x-score-client': 'web' },
      )
    ).statusCode,
  ).toBe(401)
})

test('per-agent stricter choices survive a later team change; drift shows up and apply fixes it', async () => {
  await call('PUT', '/api/settings/rules', team)
  await call('PATCH', '/api/agents/builder/permissions/SQL%20DROP', { level: 'asks' })
  // The team adds a category and removes its Never; builder keeps its own SQL DROP choice.
  const next = { mode: 'manual', goAhead: ['SQL DROP', 'SQL TRUNCATE'], never: [] }
  const written = RulesWriteResponseSchema.parse(
    (await call('PUT', '/api/settings/rules', next)).json(),
  )
  expect(written.drift.every((d) => !d.differs)).toBe(true)
  expect((await permissions('builder')).map((p) => p.id)).toEqual(['SQL TRUNCATE'])
  expect((await permissions('lead')).map((p) => p.id)).toEqual(['SQL DROP', 'SQL TRUNCATE'])
  expect((await call('POST', '/api/settings/rules/apply/nobody')).statusCode).toBe(404)
  const applied = await call('POST', '/api/settings/rules/apply/builder')
  expect(applied.statusCode).toBe(200)
  expect(RulesResponseSchema.parse(applied.json()).drift.every((d) => !d.differs)).toBe(true)
})

test('live adapter: drift, unknown keys read-only, verified writes with exact argv', async () => {
  extraHome = mkdtempSync(join(tmpdir(), 'score-rules-http-'))
  const fixture = fileURLToPath(new URL('../fixtures/hermes/profiles/', import.meta.url))
  cpSync(join(fixture, 'default'), extraHome, { recursive: true })
  cpSync(join(fixture, 'builder'), join(extraHome, 'profiles', 'builder'), { recursive: true })
  const config: Record<
    string,
    { allowlist: string[]; approvals: { mode: string; deny: string[] } }
  > = {
    default: { allowlist: [], approvals: { mode: 'smart', deny: [] } },
    // Hermes's own "always" answer added a category plus a key Score does not know.
    builder: {
      allowlist: ['SQL DROP', 'mystery key'],
      approvals: { mode: 'smart', deny: ['foreign*'] },
    },
  }
  const writes: string[][] = []
  const runner = vi.fn<HermesRunner>(async (args) => {
    const profile = args[0] === '-p' ? args[1]! : 'default'
    const state = config[profile]
    const [, , verb, sub, ...rest] = args
    if (!state) return { exitCode: 1 }
    if (verb === 'config' && sub === 'get') {
      if (rest[1] === 'command_allowlist')
        return { exitCode: 0, stdout: JSON.stringify(state.allowlist) }
      if (rest[1] === 'approvals') return { exitCode: 0, stdout: JSON.stringify(state.approvals) }
      return { exitCode: 0, stdout: rest[1] === 'model' ? '"fixture-model"' : '[]' }
    }
    if (verb === 'config' && sub === 'set') {
      writes.push(args)
      const [key, value] = rest as [string, string]
      if (key === 'command_allowlist') state.allowlist = JSON.parse(value)
      if (key === 'approvals.deny') state.approvals.deny = JSON.parse(value)
      if (key === 'approvals.mode') state.approvals.mode = value
      return { exitCode: 0 }
    }
    return { exitCode: 0, stdout: '' }
  })
  const live = new LivePort({
    scoreHome: env.home,
    hermesHome: extraHome,
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    runner,
  })
  await live.start(env.ingest)
  await app.close()
  await boot(live)

  // Before any baseline: builder allows a category the defaults do not.
  let view = await rules()
  expect(view.drift.find((d) => d.agentId === 'builder')?.differs).toBe(true)
  expect(view.drift.find((d) => d.agentId === 'default')?.differs).toBe(false)
  expect(view.goAhead).toEqual([
    { id: 'mystery key', label: 'Mystery key', pattern: 'mystery key', readOnly: true },
  ])
  expect((await permissions('builder')).map((p) => p.id)).toEqual(['SQL DROP', 'never:foreign*'])

  const put = await call('PUT', '/api/settings/rules', {
    mode: 'manual',
    goAhead: [],
    never: ['git push*'],
  })
  expect(put.statusCode).toBe(200)
  expect(RulesWriteResponseSchema.parse(put.json()).failed).toEqual([])
  expect(config.builder).toEqual({
    allowlist: ['mystery key'],
    approvals: { mode: 'manual', deny: ['git push*', 'foreign*'] },
  })
  expect(config.default).toEqual({
    allowlist: [],
    approvals: { mode: 'manual', deny: ['git push*'] },
  })
  const keys = new Set(writes.map((args) => args[args.indexOf('set') + 1]))
  expect([...keys].sort()).toEqual(['approvals.deny', 'approvals.mode', 'command_allowlist'])
  for (const args of writes) expect(args.slice(0, 2)).toEqual(['-p', expect.any(String)])
  expect(writes).toContainEqual([
    '-p',
    'builder',
    'config',
    'set',
    'command_allowlist',
    '["mystery key"]',
  ])

  // Hermes appends an "always" answer: drift appears, Apply removes it.
  config.builder!.allowlist.push('SQL TRUNCATE')
  view = await rules()
  expect(view.drift.find((d) => d.agentId === 'builder')?.differs).toBe(true)
  const applied = await call('POST', '/api/settings/rules/apply/builder')
  expect(applied.statusCode).toBe(200)
  expect(config.builder!.allowlist).toEqual(['mystery key'])
  expect(RulesResponseSchema.parse(applied.json()).drift.every((d) => !d.differs)).toBe(true)

  // A failing profile is reported, not hidden.
  delete (config as Record<string, unknown>).builder
  const again = RulesWriteResponseSchema.parse(
    (await call('PUT', '/api/settings/rules', { mode: 'manual', goAhead: [], never: [] })).json(),
  )
  expect(again.failed).toEqual(['builder'])
  expect(again.drift.find((d) => d.agentId === 'builder')?.differs).toBe(true)
})

const del = (agent: string, id: string, headers?: Record<string, string>) =>
  call('DELETE', `/api/agents/${agent}/permissions/${encodeURIComponent(id)}`, undefined, headers)

test('DELETE gives an agent back to the team rule, never looser than the team', async () => {
  await call('PUT', '/api/settings/rules', team)
  await call('PATCH', '/api/agents/builder/permissions/SQL%20DROP', { level: 'asks' })
  await call('PATCH', '/api/agents/builder/permissions/never%3Arm%20-rf%20%2Ftmp%2F*', {
    level: 'never',
  })
  const before = (await permissions('builder')).map((p) => p.id)
  expect(before).not.toContain('SQL DROP')
  expect(before).toContain('never:rm -rf /tmp/*')

  // A taken-back Go-ahead returns to the team's.
  const back = await del('builder', 'SQL DROP')
  expect(back.statusCode).toBe(200)
  const restored = AgentPermissionsResponseSchema.parse(back.json()).items
  expect(restored.find((p) => p.id === 'SQL DROP')).toMatchObject({
    level: 'allowed',
    inherited: true,
  })
  // The other override stays; the team's Never stays.
  expect(restored.map((p) => p.id)).toContain('never:rm -rf /tmp/*')
  expect(restored.map((p) => p.id)).toContain('never:*git* push* --force*')

  // An agent-only Never goes away, the team's remains.
  const gone = AgentPermissionsResponseSchema.parse(
    (await del('builder', 'never:rm -rf /tmp/*')).json(),
  ).items
  expect(gone.map((p) => p.id)).not.toContain('never:rm -rf /tmp/*')
  expect(gone.map((p) => p.id)).toContain('never:*git* push* --force*')
  expect((await permissions('builder')).map((p) => p.id)).toEqual(
    (await permissions('lead')).map((p) => p.id),
  )
  expect((await rules()).drift.every((d) => !d.differs)).toBe(true)

  // Each override can only be removed once; team rules are not overrides.
  expect((await del('builder', 'SQL DROP')).statusCode).toBe(400) // now a plain team rule
  expect((await del('builder', 'SQL DROP')).json().error.code).toBe('not_an_override')
  const teamNever = await del('lead', 'never:*git* push* --force*')
  expect(teamNever.statusCode).toBe(400)
  expect(teamNever.json().error.code).toBe('not_an_override')
  expect((await permissions('lead')).map((p) => p.id)).toContain('never:*git* push* --force*')
  expect((await del('builder', 'never:rm -rf /tmp/*')).statusCode).toBe(404)
  expect((await del('builder', 'recursive delete')).statusCode).toBe(400)
  expect((await del('builder', 'SQL TRUNCATE')).statusCode).toBe(404)
  expect((await del('nobody', 'SQL DROP')).statusCode).toBe(404)
  expect((await del('builder', 'SQL DROP', { 'x-score-client': 'web' })).statusCode).toBe(401)
})

test('live adapter: DELETE rewrites only the baseline-derived keys, exact argv, Hermes-owned entries stay', async () => {
  extraHome = mkdtempSync(join(tmpdir(), 'score-rules-delete-'))
  const fixture = fileURLToPath(new URL('../fixtures/hermes/profiles/', import.meta.url))
  cpSync(join(fixture, 'default'), extraHome, { recursive: true })
  cpSync(join(fixture, 'builder'), join(extraHome, 'profiles', 'builder'), { recursive: true })
  const config: Record<
    string,
    { allowlist: string[]; approvals: { mode: string; deny: string[] } }
  > = {
    default: { allowlist: [], approvals: { mode: 'smart', deny: [] } },
    builder: { allowlist: ['mystery key'], approvals: { mode: 'smart', deny: ['foreign*'] } },
  }
  const writes: string[][] = []
  let failWrites = false
  const runner = vi.fn<HermesRunner>(async (args) => {
    const profile = args[0] === '-p' ? args[1]! : 'default'
    const state = config[profile]
    const [, , verb, sub, ...rest] = args
    if (!state) return { exitCode: 1 }
    if (verb === 'config' && sub === 'get') {
      if (rest[1] === 'command_allowlist')
        return { exitCode: 0, stdout: JSON.stringify(state.allowlist) }
      if (rest[1] === 'approvals') return { exitCode: 0, stdout: JSON.stringify(state.approvals) }
      return { exitCode: 0, stdout: rest[1] === 'model' ? '"fixture-model"' : '[]' }
    }
    if (verb === 'config' && sub === 'set') {
      if (failWrites) return { exitCode: 1 }
      writes.push(args)
      const [key, value] = rest as [string, string]
      if (key === 'command_allowlist') state.allowlist = JSON.parse(value)
      if (key === 'approvals.deny') state.approvals.deny = JSON.parse(value)
      if (key === 'approvals.mode') state.approvals.mode = value
      return { exitCode: 0 }
    }
    return { exitCode: 0, stdout: '' }
  })
  const live = new LivePort({
    scoreHome: env.home,
    hermesHome: extraHome,
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    runner,
  })
  await live.start(env.ingest)
  await app.close()
  await boot(live)

  await call('PUT', '/api/settings/rules', {
    mode: 'manual',
    goAhead: ['SQL DROP'],
    never: ['git push*'],
  })
  expect(config.builder).toEqual({
    allowlist: ['mystery key', 'SQL DROP'],
    approvals: { mode: 'manual', deny: ['git push*', 'foreign*'] },
  })
  await call('PATCH', '/api/agents/builder/permissions/SQL%20DROP', { level: 'asks' })
  await call('PATCH', '/api/agents/builder/permissions/never%3Arm%20-rf%20%2Ftmp%2F*', {
    level: 'never',
  })
  expect(config.builder).toEqual({
    allowlist: ['mystery key'],
    approvals: { mode: 'manual', deny: ['git push*', 'foreign*', 'rm -rf /tmp/*'] },
  })

  // A write Hermes refuses: 409, the override is kept, nothing is looser than before.
  failWrites = true
  const refused = await del('builder', 'SQL DROP')
  expect(refused.statusCode).toBe(409)
  failWrites = false
  expect(config.builder!.allowlist).toEqual(['mystery key'])

  writes.length = 0
  expect((await del('builder', 'SQL DROP')).statusCode).toBe(200)
  expect((await del('builder', 'never:rm -rf /tmp/*')).statusCode).toBe(200)
  expect(config.builder).toEqual({
    allowlist: ['mystery key', 'SQL DROP'],
    approvals: { mode: 'manual', deny: ['git push*', 'foreign*'] },
  })
  // Exactly what the baseline-derived apply writes: nothing else is touched.
  expect(writes).toContainEqual([
    '-p',
    'builder',
    'config',
    'set',
    'command_allowlist',
    '["mystery key","SQL DROP"]',
  ])
  expect(writes).toContainEqual([
    '-p',
    'builder',
    'config',
    'set',
    'approvals.deny',
    '["git push*","foreign*"]',
  ])
  for (const args of writes)
    expect(['command_allowlist', 'approvals.deny', 'approvals.mode']).toContain(
      args[args.indexOf('set') + 1],
    )
  expect((await rules()).drift.every((d) => !d.differs)).toBe(true)
})
