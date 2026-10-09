import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  CredentialsUnavailable,
  ensureGeneration,
  readKey,
  registerStoredKeys,
} from '../../../../src/hermes/live/credentials.ts'
import { redact } from '../../../../src/redact.ts'
import { GatewayClient } from '../../../../src/hermes/live/gateway.ts'
import { followRun } from '../../../../src/hermes/live/runs.ts'
import { setup } from './helpers.ts'

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
const path = () => join(env.home, 'hermes-keys', 'builder')

test('private modes, current owner and trimmed keys are required; hashes cover file content', () => {
  writeFileSync(path(), ' fixture-key\n')
  expect(readKey(env.home, 'builder')).toEqual({
    key: 'fixture-key',
    keySha256: createHash('sha256').update(' fixture-key\n').digest('hex'),
  })
  chmodSync(path(), 0o400)
  expect(readKey(env.home, 'builder').key).toBe('fixture-key')
  chmodSync(path(), 0o644)
  expect(() => readKey(env.home, 'builder')).toThrow(CredentialsUnavailable)
  chmodSync(path(), 0o600)
  const uid = process.getuid!()
  vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
  expect(() => readKey(env.home, 'builder')).toThrow(CredentialsUnavailable)
})

test('missing, symlinked, empty and multiline key files are unavailable', () => {
  rmSync(path())
  expect(() => readKey(env.home, 'builder')).toThrow(CredentialsUnavailable)
  symlinkSync(join(env.home, 'hermes-keys', 'default'), path())
  expect(() => readKey(env.home, 'builder')).toThrow(CredentialsUnavailable)
  rmSync(path())
  for (const content of ['', '   ', 'first\nsecond']) {
    writeFileSync(path(), content, { mode: 0o600 })
    expect(() => readKey(env.home, 'builder')).toThrow(CredentialsUnavailable)
  }
  expect(() => readKey(env.home, '../outside')).toThrow()
})

test('unchanged key retains generation and rotation increments generation', () => {
  const first = readKey(env.home, 'builder')
  expect(ensureGeneration(env.db, 'builder', first.keySha256)).toBe(1)
  expect(ensureGeneration(env.db, 'builder', first.keySha256)).toBe(1)
  writeFileSync(path(), 'changed-fixture-key')
  const second = readKey(env.home, 'builder')
  expect(ensureGeneration(env.db, 'builder', second.keySha256)).toBe(2)
  expect(ensureGeneration(env.db, 'builder', second.keySha256)).toBe(2)
})

test('rotation prevents old-generation controls, intent replay and new admissions during active runs', async () => {
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'hello' },
    'rotation-turn',
  )
  writeFileSync(path(), 'rotated-fixture-key')
  env.fake.keys.set('builder', 'rotated-fixture-key')
  await expect(env.gateway.stopRun('builder', runId, 1)).rejects.toBeInstanceOf(
    CredentialsUnavailable,
  )
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'new' }, 'new-turn'),
  ).rejects.toBeInstanceOf(CredentialsUnavailable)
  env.db.sqlite.prepare("UPDATE command_intents SET state = 'sent'").run()
  await env.intents.recoverIntents()
  expect(env.fake.creations).toBe(1)
  expect(env.db.sqlite.prepare('SELECT state FROM command_intents').get()?.state).toBe('unknown')
  expect(
    env.db.sqlite.prepare('SELECT generation FROM credentials WHERE profile = ?').get('builder')
      ?.generation,
  ).toBe(2)
})

test('credential never escapes in errors, observations, event log or DB bytes, even on echo', async () => {
  const key = 'fixture-credential-DoNotStore-abcdefghijklmnopqrstuvwxyz'
  writeFileSync(path(), key)
  env.fake.keys.set('builder', key)
  const logs: unknown[][] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args)
  })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args)
  })
  env.fake.crashAfterAdmission = true
  let caught: unknown
  try {
    await env.intents.startRunIntent({ profile: 'builder', input: `hello ${key}` }, 'secret-turn')
  } catch (error) {
    caught = error
  }
  expect(String(caught)).not.toContain(key)
  await env.intents.recoverIntents()
  env.fake.events = [
    {
      event: 'tool.started',
      run_id: 'unused',
      seq: 0,
      timestamp: 1791290587,
      tool: 'terminal',
      preview: key,
    },
    {
      event: 'run.completed',
      run_id: 'unused',
      seq: 1,
      timestamp: 1791290588,
      output: `echo ${key}`,
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  ]
  const observations: unknown[] = []
  await followRun({
    db: env.db,
    gateway: env.gateway,
    sink: {
      submit: (obs) => {
        observations.push(obs)
        return env.ingest.submit(obs)
      },
    },
    context: { profile: 'builder', runId: 'run_builder_1', credentialGeneration: 1 },
    metrics: { unknownEvents: 0 },
  })
  expect(JSON.stringify(observations)).not.toContain(key)
  expect(JSON.stringify(logs)).not.toContain(key)
  const tables = [
    'credentials',
    'runs',
    'tool_calls',
    'command_intents',
    'events',
    'ingest_keys',
    'ingest_checkpoints',
  ]
  for (const table of tables)
    expect(JSON.stringify(env.db.sqlite.prepare(`SELECT * FROM ${table}`).all())).not.toContain(key)
  for (const suffix of ['', '-wal', '-shm'])
    expect(readFileSync(join(env.home, `score.db${suffix}`)).includes(Buffer.from(key))).toBe(false)
  const failing = new GatewayClient({
    scoreHome: env.home,
    db: env.db,
    fetch: async () => {
      throw new Error(`Bearer ${key}`)
    },
  })
  await expect(failing.health()).rejects.toMatchObject({
    code: 'transport_error',
    message: 'Gateway request failed (0, transport_error)',
  })
})

test('the user message reaches Hermes unchanged, even when it merely looks like a secret', async () => {
  const input = 'Set password=hunter2 and token=ghp_examplenotreal1234567890 in the test config'
  const { runId } = await env.intents.startRunIntent({ profile: 'builder', input }, 'plain-turn')
  const sent = [...env.fake.runs.values()].find((run) => run.id === runId || run.input === input)
  expect(sent?.input).toBe(input)
})

test('streamed reply text stays raw through the gateway so a secret split across deltas is redacted once joined', async () => {
  const { redactRunFrame } = await import('../../../../src/hermes/live/gateway.ts')
  const { redact } = await import('../../../../src/redact.ts')
  const token = 'Zk3vQ9pLm2Xw8Rt5Yc1Hn7Bd4Fg6Js0A'
  const first = redactRunFrame('message', {
    event: 'message.delta',
    run_id: 'run-1',
    delta: 'Use Authorization: Bearer ',
  })
  const second = redactRunFrame('message', {
    event: 'message.delta',
    run_id: 'run-1',
    delta: `${token} next`,
  })
  // Per-chunk redaction used to eat "Bearer" here and leave the bare token in the second chunk.
  expect(first.delta).toBe('Use Authorization: Bearer ')
  expect(second.delta).toBe(`${token} next`)
  expect(redact(`${String(first.delta)}${String(second.delta)}`)).not.toContain(token)
  // Score's own gateway key is still stripped from stream text, and other fields keep full redaction.
  const keyed = redactRunFrame(
    'message',
    {
      event: 'message.interim',
      run_id: 'run-1',
      text: 'key gw-secret-123 here',
      note: 'password=hunter2',
    },
    ['gw-secret-123'],
  )
  expect(keyed.text).toBe('key [redacted] here')
  expect(JSON.stringify(keyed)).not.toContain('hunter2')
})

test('stored keys are masked from startup, before any request reads them (gate re-check)', () => {
  const key = 'e5b2c8d14f6a7b9c0d1e2f3a4b5c6d7e'
  writeFileSync(path(), `${key}\n`, { mode: 0o600 })
  chmodSync(path(), 0o600)
  expect(redact(`early bridge text ${key}`)).toContain(key)
  registerStoredKeys(env.home)
  expect(redact(`early bridge text ${key}`)).toBe('early bridge text [redacted]')
})
