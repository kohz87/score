import { appendFileSync, cpSync, mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RulesResponseSchema, RulesWriteResponseSchema } from '@score/contract'
import { expect, test, vi } from 'vitest'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import type { HermesRunner } from '../../src/hermes/live/cli.ts'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import {
  bootRulesApp,
  createRulesHelpers,
  rulesTestSuite,
  type RulesTestState,
} from './rules-helpers.ts'

let env: RulesTestState['env']
let app: RulesTestState['app']
let cookie: RulesTestState['cookie']
let extraHome: RulesTestState['extraHome']
const current = (): RulesTestState => ({ env, app, cookie, extraHome })
rulesTestSuite((next) => {
  env = next.env
  app = next.app
  cookie = next.cookie
  extraHome = next.extraHome
}, current)

const { call, rules, permissions, del } = createRulesHelpers(current)
async function boot(port: FakePort | LivePort) {
  const next = await bootRulesApp(env, port)
  app = next.app
  cookie = next.cookie
}

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
  // An outside edit rewrites config.yaml, which is what Score's read cache keys on.
  const builderConfig = join(extraHome, 'profiles', 'builder', 'config.yaml')
  appendFileSync(builderConfig, '# edited by Hermes\n')
  utimesSync(builderConfig, new Date(), new Date(Date.now() + 60_000))
  view = await rules()
  expect(view.drift.find((d) => d.agentId === 'builder')?.differs).toBe(true)
  const applied = await call('POST', '/api/settings/rules/apply/builder')
  expect(applied.statusCode).toBe(200)
  expect(config.builder!.allowlist).toEqual(['mystery key'])
  expect(RulesResponseSchema.parse(applied.json()).drift.every((d) => !d.differs)).toBe(true)

  // A failing profile is reported, not hidden.
  delete (config as Record<string, unknown>).builder
  // The outside change rewrote config.yaml too, so Score's read cache cannot answer for it.
  appendFileSync(builderConfig, '# gone\n')
  utimesSync(builderConfig, new Date(), new Date(Date.now() + 120_000))
  const again = RulesWriteResponseSchema.parse(
    (await call('PUT', '/api/settings/rules', { mode: 'manual', goAhead: [], never: [] })).json(),
  )
  expect(again.failed).toEqual(['builder'])
  expect(again.drift.find((d) => d.agentId === 'builder')?.differs).toBe(true)
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
