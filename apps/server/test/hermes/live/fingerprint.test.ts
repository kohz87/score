import { SystemStatusSchema } from '@score/contract'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HttpError } from '../../../src/errors.ts'
import {
  assertFeature,
  computeFingerprint,
  evaluateCompatibility,
  readCliVersion,
  schemaHash,
  testedFingerprints,
  type Fingerprint,
  type TestedFingerprint,
} from '../../../src/hermes/live/fingerprint.ts'
import { LivePort } from '../../../src/hermes/live/live-port.ts'
import { setup } from './gateway/helpers.ts'

let env: ReturnType<typeof setup>
let home: string
let port: LivePort | undefined
const cli = 'Hermes Agent fixture v0.21.5'
const codeSha = 'e97923c38acba2066aff9c45e35fe1584a2155b2'
const features = [
  'run_submission',
  'run_events_sse',
  'run_status',
  'run_stop',
  'run_approval_response',
]
const cliExecution = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: cliExecution }),
  }
})

function writeState(sha = codeSha, version = '0.21.5') {
  writeFileSync(
    join(home, 'gateway_state.json'),
    JSON.stringify({
      code_sha: sha,
      code_version: version,
      served_profiles: ['default', 'builder'],
    }),
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
function compute() {
  return computeFingerprint({
    hermesHome: home,
    gateway: env.gateway,
    readCliVersion: async () => cli,
  })
}
function entry(fingerprint: Fingerprint): TestedFingerprint {
  return { ...fingerprint, testedAt: '2026-10-07T00:00:00.000Z', notes: 'Fixture-tested build' }
}
function drift(fingerprint: Fingerprint, patch: Partial<Fingerprint['parts']>): Fingerprint {
  const parts = { ...fingerprint.parts, ...patch }
  return {
    id: createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16),
    parts,
  }
}
function createPort(
  tested: TestedFingerprint[],
  fetch = env.fake.fetch,
  version = async () => cli,
) {
  return (port = new LivePort({
    scoreHome: env.home,
    hermesHome: home,
    db: env.db,
    fetch,
    testedFingerprints: tested,
    readCliVersion: version,
  }))
}

beforeEach(() => {
  cliExecution
    .mockReset()
    .mockResolvedValue({ stdout: `${cli}\nInstall directory: fixture\n`, stderr: '' })
  env = setup()
  home = join(env.home, 'upstream-fixture')
  mkdirSync(home)
  writeState()
  buildDb(join(home, 'kanban.db'), 'CREATE TABLE tasks (id TEXT, title TEXT)')
  buildDb(join(home, 'state.db'), 'CREATE TABLE sessions (id TEXT, source TEXT)')
})
afterEach(async () => {
  await port?.stop()
  port = undefined
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('computes a deterministic 16-character SHA with sorted true capabilities and default-profile schemas', async () => {
  mkdirSync(join(home, 'profiles', 'builder'), { recursive: true })
  buildDb(join(home, 'profiles', 'builder', 'state.db'), 'CREATE TABLE other (id INTEGER)')
  const fingerprint = await compute()
  expect(fingerprint.id).toMatch(/^[a-f0-9]{16}$/)
  expect(fingerprint.parts).toEqual({
    codeVersion: '0.21.5',
    codeSha,
    capabilities: [...features, 'run_steer'].sort(),
    schemas: {
      kanban: schemaHash(join(home, 'kanban.db')),
      state: schemaHash(join(home, 'state.db')),
    },
    bridge: null,
    cli,
  })
  expect(fingerprint.parts.schemas.state).not.toBe(
    schemaHash(join(home, 'profiles', 'builder', 'state.db')),
  )
  expect(fingerprint).toEqual(await compute())
  expect(
    await computeFingerprint({
      hermesHome: home,
      capabilities: [...fingerprint.parts.capabilities!].reverse(),
      readCliVersion: async () => cli,
    }),
  ).toEqual(fingerprint)
})

test('an exact tested fingerprint enables every feature and produces no degraded reason', async () => {
  const fingerprint = await compute()
  const tested = [entry(fingerprint)]
  expect(evaluateCompatibility(fingerprint, tested)).toEqual({
    fingerprint: fingerprint.id,
    tested: true,
    disabled: [],
    matchedHermes: { version: '0.21.5', codeSha },
  })
  const live = createPort(tested)
  await live.start(env.ingest)
  expect(SystemStatusSchema.parse({ mode: 'live', ...live.status() })).toMatchObject({
    compatibility: { fingerprint: fingerprint.id, tested: true, disabled: [] },
    degraded: [],
  })
})

test('unknown code disables private actions, preserves reads and public run controls, and explains degradation', async () => {
  const tested = entry(await compute())
  writeState('1234567890abcdef')
  const live = createPort([tested])
  await live.start(env.ingest)
  expect(live.status()).toMatchObject({
    compatibility: { tested: false, disabled: ['gateway-approvals'] },
    degraded: ['Untested Hermes build: 0.21.5 (12345678)'],
  })
  expect((await live.listAgents()).map(({ id }) => id)).toEqual(['default', 'builder'])
  expect(() => assertFeature(live.status(), 'score-runs')).not.toThrow()
  expect(() => assertFeature(live.status(), 'gateway-approvals')).toThrow(HttpError)
})

test('partial capabilities disable score-runs and reject admission before any upstream run or intent is created', async () => {
  const tested = entry(await compute())
  const partial: typeof globalThis.fetch = async (input, init) => {
    const response = await env.fake.fetch(input, init)
    if (new URL(String(input)).pathname.endsWith('/v1/capabilities')) {
      const body = (await response.json()) as { features: Record<string, unknown> }
      body.features.run_approval_response = false
      return Response.json(body)
    }
    return response
  }
  const live = createPort([tested], partial)
  await live.start(env.ingest)
  expect(live.status().compatibility).toMatchObject({ tested: false, disabled: ['score-runs'] })
  await expect(
    live.startRun({ agentId: 'builder', input: 'hello', turnId: 'disabled-turn' }),
  ).rejects.toMatchObject({ status: 403, code: 'feature_disabled' })
  expect(env.fake.creations).toBe(0)
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM command_intents').get()?.n).toBe(0)
  expect(await live.listAgents()).toHaveLength(2)
})

test.each(features)('missing required capability %s disables score-runs', async (feature) => {
  const tested = await compute()
  const fingerprint = drift(tested, {
    capabilities: tested.parts.capabilities!.filter((name) => name !== feature),
  })
  expect(evaluateCompatibility(fingerprint, [entry(tested)]).disabled).toEqual(['score-runs'])
})

test('CLI-only drift is informational and does not disable features', async () => {
  const tested = await compute()
  const fingerprint = drift(tested, { cli: 'Hermes Agent fixture v0.21.6' })
  expect(evaluateCompatibility(fingerprint, [entry(tested)])).toEqual({
    fingerprint: fingerprint.id,
    tested: false,
    disabled: [],
    matchedHermes: { version: '0.21.5', codeSha },
  })
})

test.each(['codeVersion', 'schemas'] as const)(
  '%s drift disables schema-dependent private features',
  async (part) => {
    const tested = await compute()
    const fingerprint = drift(
      tested,
      part === 'codeVersion'
        ? { codeVersion: '0.22.0' }
        : { schemas: { ...tested.parts.schemas, state: 'changed' } },
    )
    expect(evaluateCompatibility(fingerprint, [entry(tested)]).disabled).toEqual([
      'gateway-approvals',
    ])
  },
)

test('compares with the closest tested entry instead of the first or last entry', async () => {
  const baseline = await compute()
  const far = drift(baseline, {
    codeVersion: '0.20.0',
    codeSha: 'old',
    capabilities: [],
    cli: 'old',
  })
  const nearest = drift(baseline, { codeSha: 'new-build' })
  const current = drift(nearest, { cli: 'new-cli' })
  for (const tested of [
    [entry(far), entry(nearest)],
    [entry(nearest), entry(far)],
  ])
    expect(evaluateCompatibility(current, tested).disabled).toEqual([])
})

test('an empty or unseeded registry disables private features while preserving supported public runs', async () => {
  const fingerprint = await compute()
  for (const entries of [[], testedFingerprints])
    expect(evaluateCompatibility(fingerprint, entries)).toEqual({
      fingerprint: fingerprint.id,
      tested: false,
      disabled: ['gateway-approvals'],
    })
})

test('missing files, an unreachable gateway and unavailable CLI yield null parts without creating databases', async () => {
  const missing = join(home, 'missing')
  const fingerprint = await computeFingerprint({
    hermesHome: missing,
    gateway: {
      capabilities: async () => {
        throw new Error('fixture offline')
      },
    },
    readCliVersion: async () => {
      throw new Error('fixture CLI missing')
    },
  })
  expect(fingerprint.parts).toEqual({
    codeVersion: null,
    codeSha: null,
    capabilities: null,
    schemas: { kanban: null, state: null },
    bridge: null,
    cli: null,
  })
  expect(() => readFileSync(join(missing, 'kanban.db'))).toThrow()
  expect(evaluateCompatibility(fingerprint, []).disabled).toEqual([
    'gateway-approvals',
    'score-runs',
  ])
})

test.each(['not json', JSON.stringify({ code_version: 21, code_sha: {} })])(
  'invalid gateway state is ignored: %s',
  async (state) => {
    writeFileSync(join(home, 'gateway_state.json'), state)
    expect((await compute()).parts).toMatchObject({ codeVersion: null, codeSha: null, cli })
  },
)

test('a missing database only nulls that schema, and invalid state fields are independent', async () => {
  rmSync(join(home, 'kanban.db'))
  writeFileSync(
    join(home, 'gateway_state.json'),
    JSON.stringify({ code_version: '0.21.5', code_sha: 42 }),
  )
  expect((await compute()).parts).toMatchObject({
    codeVersion: '0.21.5',
    codeSha: null,
    schemas: { kanban: null, state: expect.stringMatching(/^[a-f0-9]{64}$/) },
  })
})

test('schema hashes ignore SQL whitespace and creation order, detect a new column, and leave files untouched', () => {
  const first = join(home, 'first.db')
  const second = join(home, 'second.db')
  buildDb(
    first,
    'CREATE TABLE alpha (id TEXT, title TEXT); CREATE TABLE beta (id INTEGER); CREATE INDEX idx_alpha ON alpha (id)',
  )
  buildDb(
    second,
    'CREATE TABLE beta (id  INTEGER); CREATE TABLE alpha (id\nTEXT,\n title\tTEXT); CREATE INDEX idx_alpha\n ON alpha (id)',
  )
  const before = readFileSync(first)
  expect(schemaHash(first)).toBe(schemaHash(second))
  expect(readFileSync(first)).toEqual(before)
  const db = new DatabaseSync(second)
  db.exec('ALTER TABLE alpha ADD COLUMN body TEXT')
  db.close()
  expect(schemaHash(first)).not.toBe(schemaHash(second))
})

test('refreshes on startup and every ten minutes while status reads use the cached fingerprint', async () => {
  vi.useFakeTimers()
  const readCli = vi.fn(async () => cli)
  const live = createPort([entry(await compute())], env.fake.fetch, readCli)
  await live.start(env.ingest)
  const original = live.status().compatibility.fingerprint
  for (let i = 0; i < 10; i++) live.status()
  writeState('updated-build')
  await vi.advanceTimersByTimeAsync(9 * 60_000 + 30_000)
  expect(readCli).toHaveBeenCalledTimes(1)
  expect(live.status().compatibility.fingerprint).toBe(original)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(readCli).toHaveBeenCalledTimes(2)
  expect(live.status().compatibility.fingerprint).not.toBe(original)
})

test('gateway reconnection refreshes the fingerprint before ten minutes', async () => {
  vi.useFakeTimers()
  let offline = false
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (offline) throw new Error('fixture disconnected')
    return env.fake.fetch(input, init)
  }
  const readCli = vi.fn(async () => cli)
  const live = createPort([entry(await compute())], fetch, readCli)
  await live.start(env.ingest)
  offline = true
  await vi.advanceTimersByTimeAsync(30_000)
  expect(live.status().hermes.reachable).toBe(false)
  writeState('reconnected-build')
  offline = false
  await vi.advanceTimersByTimeAsync(30_000)
  expect(readCli).toHaveBeenCalledTimes(2)
  expect(live.status()).toMatchObject({
    hermes: { reachable: true },
    compatibility: { tested: false, disabled: ['gateway-approvals'] },
    degraded: ['Untested Hermes build: 0.21.5 (reconnec)'],
  })
})

test('CLI probing takes only the first line and returns null when unavailable', async () => {
  cliExecution.mockRejectedValueOnce(new Error('fixture CLI missing'))
  expect(await readCliVersion()).toBeNull()
  expect(await readCliVersion()).toBe(cli)
  expect(cliExecution).toHaveBeenLastCalledWith('hermes', ['--version'], { timeout: 5_000 })
  cliExecution.mockResolvedValueOnce({ stdout: '\n', stderr: '' })
  expect(await readCliVersion()).toBeNull()
})

test('the printer emits valid JSON from fixture inputs through the existing gateway client', async () => {
  const expected = await compute()
  vi.stubEnv('SCORE_HOME', env.home)
  vi.stubEnv('SCORE_HERMES_HOME', home)
  vi.stubEnv('SCORE_HERMES_URL', 'http://127.0.0.1:8642')
  vi.stubGlobal('fetch', env.fake.fetch)
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  await import('../../../scripts/print-fingerprint.ts')
  expect(output).toHaveBeenCalledTimes(1)
  expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(expected)
})

test('the printer runs with node --import tsx and preloaded fixture inputs', async (context) => {
  const expected = await compute()
  const input = join(home, 'fingerprint-input.json')
  writeFileSync(input, JSON.stringify({ cli, features: [...features, 'run_steer'] }))
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        './test/fixtures/hermes/fingerprint-runtime.ts',
        'scripts/print-fingerprint.ts',
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: {
          ...process.env,
          SCORE_HOME: env.home,
          SCORE_HERMES_HOME: home,
          SCORE_HERMES_URL: 'http://127.0.0.1:8642',
          SCORE_FINGERPRINT_FIXTURE: input,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    expect(JSON.parse(stdout)).toEqual(expected)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM')
      context.skip(
        'Sandbox forbids subprocess execution; the in-process printer test covers fixture inputs',
      )
    throw error
  }
})
