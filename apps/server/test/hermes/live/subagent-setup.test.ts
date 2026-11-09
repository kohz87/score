import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../../src/db/index.ts'
import { captureReadShape, type HermesRunner } from '../../../src/hermes/live/cli.ts'
import {
  sessionIsInline,
  subagentPolicyPath,
  writeSubagentPolicy,
} from '../../../src/hermes/live/subagent-policy.ts'
import { applySubagentSetup, readSubagentSetup } from '../../../src/hermes/live/subagent-setup.ts'

let dir: string
let db: ScoreDb
let calls: string[][]
let config: Record<string, Record<string, string>>
let failOn: string | null

const runner: HermesRunner = async (args) => {
  calls.push(args)
  const [, profile, verb, action, ...rest] = args
  if (verb !== 'config') return { exitCode: -1 }
  if (action === 'get') {
    const value = config[profile!]?.[rest[1]!]
    return value === undefined ? { exitCode: 1 } : { exitCode: 0, stdout: JSON.stringify(value) }
  }
  if (rest[0] === failOn) return { exitCode: 1 }
  ;(config[profile!] ??= {})[rest[0]!] = rest[1]!
  return { exitCode: 0 }
}
const deps = () => ({ runner, hermesHome: dir, home: (agent: string) => join(dir, agent) })
const writes = () => calls.filter((call) => call[3] === 'set')
const guardFor = (agent: string) => {
  mkdirSync(join(dir, agent, 'plugins', 'score-bridge'), { recursive: true })
  writeFileSync(join(dir, agent, 'plugins', 'score-bridge', 'subagent_guard.py'), '')
}
const since = (profile: string) =>
  db.read(
    (sqlite) =>
      sqlite.prepare('SELECT inline_since FROM subagent_agents WHERE profile = ?').get(profile) as
        { inline_since: string } | undefined,
  )?.inline_since
const addRun = (profile: string, session: string, at: string) =>
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, session_id, status, started_at, version, updated_at)
         VALUES (?, ?, 'score', ?, 'completed', ?, 1, ?)`,
      )
      .run(`run-${session}-${at}`, profile, session, at, at)
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-subagents-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../../migrations/', import.meta.url)))
  calls = []
  config = {}
  failOn = null
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('reads whether each agent is inline and has the guard', async () => {
  guardFor('lead')
  config['lead'] = { 'delegation.gateway_mode': 'inline' }
  config['builder'] = { 'delegation.gateway_mode': 'auto' }
  expect(await readSubagentSetup(deps(), ['lead', 'builder', 'reviewer'])).toEqual({
    agents: [
      { agentId: 'lead', inline: true, guard: true },
      { agentId: 'builder', inline: false, guard: false },
      { agentId: 'reviewer', inline: false, guard: false },
    ],
  })
  expect(writes()).toEqual([])
})

test('Apply sets the ceiling and inline, and records when', async () => {
  guardFor('lead')
  const setup = await applySubagentSetup(
    deps(),
    db,
    ['lead'],
    ['lead'],
    () => '2026-11-09T10:00:00.000Z',
  )
  expect(setup.agents).toEqual([{ agentId: 'lead', inline: true, guard: true }])
  expect(config['lead']).toEqual({
    'delegation.max_concurrent_children': '4',
    'delegation.max_iterations': '50',
    'delegation.gateway_mode': 'inline',
  })
  expect(since('lead')).toBe('2026-11-09T10:00:00.000Z')
})

test('inline is set last: a failure part-way leaves the agent refusing subagents, not unlimited', async () => {
  guardFor('lead')
  failOn = 'delegation.max_iterations'
  await expect(
    applySubagentSetup(deps(), db, ['lead'], ['lead'], () => '2026-11-09T10:00:00.000Z'),
  ).rejects.toMatchObject({ status: 502 })
  expect(config['lead']?.['delegation.gateway_mode']).toBeUndefined()
  expect(since('lead')).toBeUndefined()
})

test('nothing changes if any agent named lacks the guard', async () => {
  guardFor('lead')
  await expect(
    applySubagentSetup(deps(), db, ['lead', 'builder'], ['lead', 'builder'], () => 'now'),
  ).rejects.toMatchObject({ status: 409 })
  expect(writes()).toEqual([])
  expect(since('lead')).toBeUndefined()
})

test('an agent it does not know is refused before anything is read', async () => {
  await expect(
    applySubagentSetup(deps(), db, ['lead'], ['ghost'], () => 'now'),
  ).rejects.toMatchObject({
    status: 400,
  })
  expect(calls).toEqual([])
})

test('applying again keeps the first moment while the agent stays inline', async () => {
  guardFor('lead')
  await applySubagentSetup(deps(), db, ['lead'], ['lead'], () => '2026-11-09T10:00:00.000Z')
  await applySubagentSetup(deps(), db, ['lead'], ['lead'], () => '2026-11-09T12:00:00.000Z')
  expect(since('lead')).toBe('2026-11-09T10:00:00.000Z')
})

test('applying after someone turned it off moves the moment forward', async () => {
  guardFor('lead')
  await applySubagentSetup(deps(), db, ['lead'], ['lead'], () => '2026-11-09T10:00:00.000Z')
  config['lead']!['delegation.gateway_mode'] = 'auto'
  await applySubagentSetup(deps(), db, ['lead'], ['lead'], () => '2026-11-09T12:00:00.000Z')
  expect(since('lead')).toBe('2026-11-09T12:00:00.000Z')
})

test('a session is inline only if it is new since the profile went inline', async () => {
  const read = (profile: string, session: string) =>
    db.read((sqlite) => sessionIsInline(sqlite, profile, session, null))
  expect(read('lead', 'score-new')).toBe(false) // not set up yet
  guardFor('lead')
  addRun('lead', 'score-old', '2026-11-09T09:00:00.000Z')
  await applySubagentSetup(deps(), db, ['lead'], ['lead'], () => '2026-11-09T10:00:00.000Z')
  addRun('lead', 'score-later', '2026-11-09T11:00:00.000Z')
  expect(read('lead', 'score-old')).toBe(false)
  expect(read('lead', 'score-later')).toBe(true)
  expect(read('lead', 'score-new')).toBe(true)
  expect(read('builder', 'score-new')).toBe(false)
})

test('a session Hermes began before the profile went inline is not, even with no Score run in it', async () => {
  guardFor('lead')
  await applySubagentSetup(deps(), db, ['lead'], ['lead'], () => '2026-11-09T10:00:00.000Z')
  const read = (startedAt: number | null) =>
    db.read((sqlite) => sessionIsInline(sqlite, 'lead', 'outside', startedAt))
  expect(read(Date.parse('2026-11-09T09:00:00.000Z'))).toBe(false)
  expect(read(Date.parse('2026-11-09T11:00:00.000Z'))).toBe(true)
  expect(read(null)).toBe(true)
})

test('the settings it reads are allowed through the Hermes runner', () => {
  for (const key of [
    'delegation.gateway_mode',
    'delegation.model',
    'delegation.max_iterations',
    'delegation.max_concurrent_children',
    'delegation.child_timeout_seconds',
  ])
    expect(captureReadShape(['-p', 'lead', 'config', 'get', '--json', key])).toBe(true)
})

test('the plugin folder may be either spelling', async () => {
  mkdirSync(join(dir, 'lead', 'plugins', 'score_bridge'), { recursive: true })
  writeFileSync(join(dir, 'lead', 'plugins', 'score_bridge', 'subagent_guard.py'), '')
  expect((await readSubagentSetup(deps(), ['lead'])).agents[0]?.guard).toBe(true)
})

test('the policy file is owner-only, whole, and named as the plugin expects', () => {
  writeSubagentPolicy(dir, 'score-room-lead', {
    v: 1,
    inline: true,
    enabled: true,
    maxConcurrent: 4,
    maxTotal: 20,
    used: 0,
  })
  const path = subagentPolicyPath(dir, 'score-room-lead')
  // hashlib.sha256(b"score-room-lead").hexdigest(), the plugin's name for it.
  expect(
    path.endsWith('84c02292c3b9d8cc1125c475f0b9b7ff3b8cee1fd97ebca8a64190750d897ad9.json'),
  ).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    v: 1,
    inline: true,
    enabled: true,
    maxConcurrent: 4,
    maxTotal: 20,
    used: 0,
  })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, 'subagents')).mode & 0o777).toBe(0o700)
})
