import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  addAgent,
  db,
  dir,
  finished,
  log,
  makeRoom,
  request,
  say,
  setEnv,
  setupCodingRuntime,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

// PLAN 8.1 (decision 82): CLI quota meters.
test('8.1: Claude Code keeps the latest rate-limit windows of a turn, read back through the quota routes', async () => {
  await addAgent()
  await makeRoom()
  const before = await request('GET', '/api/coding-agents/coder/quota')
  expect(before.json()).toEqual({ quota: null })
  await say('@coder please add a greeting')
  await finished()
  const { quota } = (await request('GET', '/api/coding-agents/coder/quota')).json()
  expect(quota).toMatchObject({
    runtime: 'claude-code',
    source: 'turn',
    windows: [
      { name: '5 hours', group: null, usedPercent: 6, resetsAt: '2026-10-16T05:40:00.000Z' },
      { name: 'week', group: null, usedPercent: 78, resetsAt: '2026-10-17T03:00:00.000Z' },
    ],
  })
  expect(Date.now() - Date.parse(quota.seenAt)).toBeLessThan(60_000)
  // Storage holds the numbers and nothing else.
  const row = db.sqlite.prepare('SELECT * FROM coding_quota').all()
  expect(row).toHaveLength(1)
  expect(Object.keys(row[0]!).sort()).toEqual([
    'agent_id',
    'runtime',
    'seen_at',
    'source',
    'windows',
  ])
  expect(
    (await request('GET', '/api/coding-agents/runtimes/claude-code/quota')).json().quota,
  ).toEqual(quota)
  expect((await request('GET', '/api/coding-agents/runtimes/codex/quota')).json()).toEqual({
    quota: null,
  })
  expect((await request('GET', '/api/coding-agents/ghost/quota')).statusCode).toBe(404)
})

test('8.1: Codex’s quota comes from its own log of the run Score started; no log means unknown', async () => {
  const codexHome = join(dir, 'codex-home')
  setEnv('CODEX_HOME', codexHome)
  await addAgent({
    id: 'cx',
    name: 'Cx',
    runtime: 'codex',
    acknowledgeReads: true,
    permission: 'read-only',
  })
  await makeRoom()
  await say('@cx look around')
  await finished()
  const { quota } = (await request('GET', '/api/coding-agents/cx/quota')).json()
  expect(quota).toMatchObject({
    runtime: 'codex',
    source: 'log',
    windows: [
      { name: '5 hours', usedPercent: 12 },
      { name: 'week', usedPercent: 41 },
    ],
  })
  // The same turn when the CLI leaves no log: nothing new is stored and the old numbers stay.
  setEnv('SCORE_CODING_FAKE_NO_CODEX_LOG', '1')
  rmSync(join(codexHome, 'sessions'), { recursive: true })
  await say('@cx look again')
  await finished(2)
  expect((await request('GET', '/api/coding-agents/cx/quota')).json().quota).toEqual(quota)
})

test('8.1: Codex with no log at all has no quota', async () => {
  setEnv('CODEX_HOME', join(dir, 'empty-codex-home'))
  setEnv('SCORE_CODING_FAKE_NO_CODEX_LOG', '1')
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx try')
  await finished()
  expect((await request('GET', '/api/coding-agents/cx/quota')).json()).toEqual({ quota: null })
})

test('8.1: Antigravity’s quota is its /usage reading as meters per model group', async () => {
  await addAgent({
    id: 'ag',
    name: 'Ag',
    runtime: 'antigravity',
    permission: 'read-only',
  })
  const response = await request('GET', '/api/coding-agents/ag/quota')
  expect(response.statusCode, response.body).toBe(200)
  const { quota } = response.json()
  expect(quota.source).toBe('usage')
  expect(quota.windows[0]).toEqual({
    name: '5 hours',
    group: 'Gemini Models',
    usedPercent: 13,
    resetsAt: '2026-10-11T04:43:48.000Z',
  })
  const byRuntime = await request('GET', '/api/coding-agents/runtimes/antigravity/quota')
  expect(byRuntime.json().quota.windows).toEqual(quota.windows)
})

// PLAN 8.5 (decision 86): the model picker's lists.
test('8.5: Antigravity models come from `agy models` (no prompt), are cached, and fresh=1 asks again', async () => {
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[] })
      .filter((entry) => entry.args[0] === 'models')
  const first = await request('GET', '/api/coding-agents/runtimes/antigravity/models')
  expect(first.statusCode, first.body).toBe(200)
  const body = first.json()
  expect(body.source).toBe('cli')
  expect(body.models).toHaveLength(13)
  expect(body.models[1]).toEqual({ id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' })
  expect(calls()).toHaveLength(1)
  expect(calls()[0]!.args).toEqual(['models'])
  await request('GET', '/api/coding-agents/runtimes/antigravity/models')
  expect(calls()).toHaveLength(1)
  await request('GET', '/api/coding-agents/runtimes/antigravity/models?fresh=1')
  expect(calls()).toHaveLength(2)
  expect(
    (await request('GET', '/api/coding-agents/runtimes/antigravity/models?fresh=yes')).statusCode,
  ).toBe(400)
})

test('8.5: Claude Code gets the aliases without running anything; Codex reads only its model cache', async () => {
  const alias = await request('GET', '/api/coding-agents/runtimes/claude-code/models')
  expect(alias.json()).toMatchObject({ source: 'aliases' })
  expect(alias.json().models.map((model: { id: string }) => model.id)).toEqual([
    'fable',
    'opus',
    'sonnet',
  ])
  const codexHome = join(dir, 'codex-home')
  mkdirSync(codexHome)
  setEnv('CODEX_HOME', codexHome)
  expect((await request('GET', '/api/coding-agents/runtimes/codex/models')).json()).toEqual({
    models: [],
    source: 'none',
  })
  copyFileSync(
    fileURLToPath(new URL('../fixtures/coding/codex-models-cache.json', import.meta.url)),
    join(codexHome, 'models_cache.json'),
  )
  writeFileSync(join(codexHome, 'auth.json'), '{"tokens":"SECRET-DO-NOT-READ"}')
  const response = await request('GET', '/api/coding-agents/runtimes/codex/models?fresh=1')
  expect(response.json().source).toBe('cache')
  expect(response.json().models.map((model: { id: string }) => model.id)).toEqual([
    'gpt-6.1-sol',
    'gpt-6.1-mini',
  ])
  expect(response.body).not.toMatch(/example\.invalid|acct-FAKE|SECRET-DO-NOT-READ|identity/)
  // Only version probes ran (they exit before the fake CLI logs): no listing command, no prompt.
  expect(existsSync(log)).toBe(false)
})

test('8.5: an unknown runtime is refused and a failing CLI gives the free-text answer, not an error', async () => {
  expect((await request('GET', '/api/coding-agents/runtimes/nope/models')).statusCode).toBe(400)
  // An unreadable list is `none`, and is not remembered.
  setEnv('CODEX_HOME', join(dir, 'does-not-exist'))
  const none = await request('GET', '/api/coding-agents/runtimes/codex/models')
  expect(none.statusCode).toBe(200)
  expect(none.json()).toEqual({ models: [], source: 'none' })
})

// ---- PLAN 8.8: role and "Personality and instructions" ----
