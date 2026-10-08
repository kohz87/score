import { HermesCheckSchema } from '@score/contract'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { computeFingerprint, type TestedFingerprint } from '../../../src/hermes/live/fingerprint.ts'
import { LivePort } from '../../../src/hermes/live/live-port.ts'
import {
  BRIDGE_HOOKS,
  PRIVATE_APPROVAL_API,
  type SourceFacts,
} from '../../../src/hermes/live/source-facts.ts'
import { KNOWN_PATTERN_KEYS } from '../../../src/hermes/pattern-keys.ts'
import { setup } from './gateway/helpers.ts'

// Task 5.6: "Check this Hermes version". Everything runs on fixtures: a throwaway Hermes home, the fake gateway and
// injected source facts (the real extractor is exercised against the installed sources by hand).
let env: ReturnType<typeof setup>
let home: string
let port: LivePort | undefined
let facts: SourceFacts | null
const cli = 'Hermes Agent fixture v0.21.5'
const oldSha = 'e97923c38acba2066aff9c45e35fe1584a2155b2'
const newSha = '0240fa4a84123406a0e5e6e7262e5b772b43f0bd'
const cliExecution = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: cliExecution }) }
})

const goodFacts = (): SourceFacts => ({
  validHooks: [...BRIDGE_HOOKS, 'extra_hook'],
  patternKeys: [...KNOWN_PATTERN_KEYS],
  approvalApi: {
    functions: [...PRIVATE_APPROVAL_API.functions],
    state: [...PRIVATE_APPROVAL_API.state],
    detectDangerousCommand: true,
    entrySlots: [...PRIVATE_APPROVAL_API.entrySlots, 'reason'],
  },
})
function writeState(sha: string, version: string) {
  writeFileSync(
    join(home, 'gateway_state.json'),
    JSON.stringify({ code_sha: sha, code_version: version, served_profiles: ['default'] }),
  )
}
function buildDb(path: string, sql: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
function listing(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listing(join(dir, entry.name))
      : [`${join(dir, entry.name)}:${statSync(join(dir, entry.name)).mtimeMs}`],
  )
}
async function testedBuild(): Promise<TestedFingerprint[]> {
  const fingerprint = await computeFingerprint({
    hermesHome: home,
    gateway: env.gateway,
    readCliVersion: async () => cli,
  })
  return [{ ...fingerprint, testedAt: '2026-10-07T00:00:00.000Z', notes: 'Fixture' }]
}
async function start(tested: TestedFingerprint[]) {
  port = new LivePort({
    scoreHome: env.home,
    hermesHome: home,
    db: env.db,
    fetch: env.fake.fetch,
    testedFingerprints: tested,
    readCliVersion: async () => cli,
    readSourceFacts: async () => facts,
  })
  await port.start(env.ingest)
  return port
}

beforeEach(() => {
  cliExecution.mockReset().mockResolvedValue({ stdout: `${cli}\n`, stderr: '' })
  env = setup()
  home = join(env.home, 'upstream-fixture')
  mkdirSync(home)
  writeState(oldSha, '0.21.5')
  buildDb(join(home, 'kanban.db'), 'CREATE TABLE tasks (id TEXT, title TEXT)')
  buildDb(join(home, 'state.db'), 'CREATE TABLE sessions (id TEXT, source TEXT)')
  facts = goodFacts()
})
afterEach(async () => {
  await port?.stop()
  port = undefined
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

test('an update with unchanged internals is compatible and one accept re-enables approvals', async () => {
  const tested = await testedBuild()
  writeState(newSha, '0.21.6')
  const live = await start(tested)
  expect(live.status().compatibility).toMatchObject({
    tested: false,
    disabled: ['gateway-approvals'],
  })
  const hermesBefore = listing(home)
  const check = HermesCheckSchema.parse(await live.checkHermes())
  expect(check.compatible).toBe(true)
  expect(check.build).toMatchObject({ version: '0.21.6', codeSha: newSha })
  expect(Object.fromEntries(check.parts.map((part) => [part.name, part.status]))).toMatchObject({
    'Hermes version': 'changed',
    'Code revision': 'changed',
    Capabilities: 'same',
    'Kanban database schema': 'same',
    'Session database schema': 'same',
    'Bridge hooks': 'same',
    'Approval functions': 'same',
    'Dangerous-command patterns': 'same',
  })
  await live.acceptHermes(check.hash)
  expect(live.status().compatibility).toMatchObject({ tested: true, disabled: [] })
  // Recorded on the Score side only, and it survives a restart.
  const stored = JSON.parse(readFileSync(join(env.home, 'accepted-hermes-builds.json'), 'utf8'))
  expect(stored).toHaveLength(1)
  expect(listing(home)).toEqual(hermesBefore)
  await live.stop()
  const again = await start(tested)
  expect(again.status().compatibility).toMatchObject({ tested: true, disabled: [] })
})

test('a build that only adds dangerous-command patterns can be accepted and remembers them', async () => {
  const tested = await testedBuild()
  writeState(newSha, '0.21.6')
  facts = { ...goodFacts(), patternKeys: [...KNOWN_PATTERN_KEYS, 'a brand new pattern'] }
  const live = await start(tested)
  const check = await live.checkHermes()
  expect(check.compatible).toBe(true)
  expect(check.parts.find((part) => part.name === 'Dangerous-command patterns')).toMatchObject({
    status: 'added',
    detail: 'added: a brand new pattern',
  })
  await live.acceptHermes(check.hash)
  expect(live.status().compatibility.disabled).toEqual([])
  const next = await live.checkHermes()
  expect(next.parts.find((part) => part.name === 'Dangerous-command patterns')?.status).toBe('same')
})

test('a changed schema stays off with a report and cannot be accepted', async () => {
  const tested = await testedBuild()
  writeState(newSha, '0.21.6')
  buildDb(join(home, 'kanban.db'), 'ALTER TABLE tasks ADD COLUMN extra TEXT')
  const live = await start(tested)
  const check = await live.checkHermes()
  expect(check.compatible).toBe(false)
  expect(check.parts.find((part) => part.name === 'Kanban database schema')).toMatchObject({
    status: 'changed',
  })
  await expect(live.acceptHermes(check.hash)).rejects.toMatchObject({
    status: 409,
    code: 'not_compatible',
  })
  expect(live.status().compatibility.disabled).toEqual(['gateway-approvals'])
  expect(() => readFileSync(join(env.home, 'accepted-hermes-builds.json'))).toThrow()
})

test.each([
  ['a missing hook', { validHooks: BRIDGE_HOOKS.slice(1) }, 'Bridge hooks'],
  [
    'a missing private function',
    { approvalApi: { ...goodFacts().approvalApi, functions: ['list_gateway_approvals'] } },
    'Approval functions',
  ],
  ['unreadable sources', null, 'Bridge hooks'],
])('%s makes the build incompatible', async (_name, patch, part) => {
  const tested = await testedBuild()
  writeState(newSha, '0.21.6')
  facts = patch === null ? null : { ...goodFacts(), ...patch }
  const live = await start(tested)
  const check = await live.checkHermes()
  expect(check.compatible).toBe(false)
  expect(check.parts.find((item) => item.name === part)?.status).toBe('changed')
})

test('a stale hash is refused with 409 conflict', async () => {
  const tested = await testedBuild()
  writeState(newSha, '0.21.6')
  const live = await start(tested)
  const { hash } = await live.checkHermes()
  writeState('1234567890abcdef1234567890abcdef12345678', '0.21.7')
  await expect(live.acceptHermes(hash)).rejects.toMatchObject({ status: 409, code: 'conflict' })
  expect(live.status().compatibility.disabled).toEqual(['gateway-approvals'])
})

test('the HTTP routes need a person, validate the body and map the refusals', async () => {
  const tested = await testedBuild()
  writeState(newSha, '0.21.6')
  const live = await start(tested)
  const app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port: live,
    db: env.db,
    ingest: env.ingest,
  })
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/api/settings/hermes/check' })).statusCode,
    ).toBe(403)
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
    const check = HermesCheckSchema.parse(
      (await app.inject({ method: 'POST', url: '/api/settings/hermes/check', headers })).json(),
    )
    const accept = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/settings/hermes/accept', headers, payload })
    expect((await accept({ hash: 'nope' })).statusCode).toBe(400)
    const stale = await accept({ hash: '0'.repeat(64) })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('conflict')
    const ok = await accept({ hash: check.hash })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })
    expect(live.status().compatibility.disabled).toEqual([])
  } finally {
    await app.close()
  }
})

test('the hook list the check uses is the one the bridge manifest ships', () => {
  const manifest = readFileSync(
    new URL('../../../../../hermes-plugin/score_bridge/plugin.yaml', import.meta.url),
    'utf8',
  )
  expect([...manifest.matchAll(/^ {2}- (\w+)$/gm)].map((match) => match[1])).toEqual([
    ...BRIDGE_HOOKS,
  ])
})

test('added API capabilities stay compatible; a removed one does not', async () => {
  const { buildHermesCheck } = await import('../../../src/hermes/live/hermes-check.ts')
  const parts = {
    codeVersion: '0.21.5',
    codeSha: 'a'.repeat(40),
    capabilities: ['run_submission', 'run_events_sse'],
    schemas: { kanban: 'k', state: 's' },
    bridge: null,
    cli: 'Hermes Agent v0.21.5',
  }
  const tested = [{ id: 'tested', parts, testedAt: null, notes: '' }]
  const check = (capabilities: string[]) =>
    buildHermesCheck({
      fingerprint: { id: 'new', parts: { ...parts, codeSha: 'b'.repeat(40), capabilities } },
      facts: goodFacts(),
      tested,
      knownPatternKeys: [],
    }).check.compatible
  expect(check(['run_submission', 'run_events_sse', 'brand_new_api'])).toBe(true)
  expect(check(['run_submission'])).toBe(false)
})
