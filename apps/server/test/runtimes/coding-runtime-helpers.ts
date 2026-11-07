import { RoomSchema, type CodingAgent, type Message } from '@score/contract'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import { CodingRuntime, type CodingRuntimeDeps } from '../../src/runtimes/coding/service.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { onMentions } from '../helpers/on-mentions.ts'
import { FAKE_CLI } from './coding-fixtures.ts'

// Every test here spawns real child processes (a version probe per agent and per turn, then the CLI itself). Alone that
// is ~1-2 s, but in the full parallel run on 4 cores node start-up alone takes seconds, and the two-agent Reports test
// (six spawns) overran the 5 s default: the work is real, so the budget says so (same as the other process-spawning tests).

export let dir: string
export let home: string
export let workspace: string
export let log: string
export let db: ScoreDb
export let ingest: Ingest
let port: FakePort
export let coding: CodingRuntime
export let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
export let roomId: string
const secrets = new Map<string, string | undefined>()

export function setEnv(name: string, value: string | undefined) {
  if (!secrets.has(name)) secrets.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

export const spawned: number[] = []
// Per-test changes to how the CLI is launched (e.g. signals that never arrive).
let readSpawnExtra: () => Partial<Parameters<typeof spawnCli>[0]> = () => ({})
export let launches = 0

export function setupCodingRuntime(getSpawnExtra?: () => Partial<Parameters<typeof spawnCli>[0]>) {
  readSpawnExtra = getSpawnExtra ?? (() => ({}))
  vi.setConfig({ testTimeout: 30_000 })

  beforeEach(async () => {
    launches = 0
    spawned.length = 0
    dir = mkdtempSync(join(tmpdir(), 'score-coding-'))
    home = join(dir, 'home')
    workspace = join(dir, 'ws')
    log = join(dir, 'fake-cli.log')
    mkdirSync(home)
    mkdirSync(workspace)
    db = openDatabase(join(dir, 'score.db'))
    migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    ingest = createIngest(db)
    port = new FakePort(1, { db }, false)
    await port.start(ingest)
    await boot()
  })
  afterEach(async () => {
    await coding.close()
    await port.stop()
    await app.close()
    await ingest.close()
    db.close()
    for (const [name, value] of secrets) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    secrets.clear()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
}

export async function boot(
  options: {
    version?: string
    maxTurnMs?: number
    graceMs?: number
    terminalRetryMs?: number
    killGroup?: CodingRuntimeDeps['killGroup']
    reapRetryMs?: number
    stopObserveMs?: number
    onStop?: (cause: string) => void
    ownsProcessRow?: (runId: string) => boolean
    frozen?: () => string | null
    ingestWrap?: (ingest: Ingest) => Pick<Ingest, 'submit'>
  } = {},
) {
  setEnv('SCORE_CODING_FAKE_LOG', log)
  setEnv('SCORE_CODING_FAKE_VERSION', options.version)
  coding = new CodingRuntime({
    db,
    ingest: options.ingestWrap ? options.ingestWrap(ingest) : ingest,
    locator: new CliLocator({ fakeCli: FAKE_CLI, cacheMs: 0 }),
    home,
    policy: defaultRootPolicy([home]),
    ...(options.maxTurnMs ? { maxTurnMs: options.maxTurnMs } : {}),
    ...(options.graceMs ? { graceMs: options.graceMs } : {}),
    terminalRetryMs: options.terminalRetryMs ?? 10,
    ...(options.killGroup ? { killGroup: options.killGroup } : {}),
    ...(options.reapRetryMs ? { reapRetryMs: options.reapRetryMs } : {}),
    ...(options.stopObserveMs ? { stopObserveMs: options.stopObserveMs } : {}),
    ...(options.onStop ? { onStop: options.onStop } : {}),
    ...(options.ownsProcessRow ? { ownsProcessRow: options.ownsProcessRow } : {}),
    ...(options.frozen ? { frozen: options.frozen } : {}),
    // Counts launches and keeps the pids, so a test can prove nothing started or that a child is gone.
    spawn: (spawnOptions) => {
      launches++
      return spawnCli({
        ...spawnOptions,
        ...readSpawnExtra(),
        onSpawn: (pid) => {
          spawned.push(pid)
          spawnOptions.onSpawn?.(pid)
        },
      })
    },
  })
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: home }),
    logger: false,
    db,
    ingest,
    port,
    coding,
    security: new SecurityPassword(home),
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

export const request = (
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'GET',
  url: string,
  payload?: object,
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
export const style = { color: '#19C39A', shape: 'hexagon' }
export async function addAgent(over: Record<string, unknown> = {}): Promise<CodingAgent> {
  const response = await request('POST', '/api/coding-agents', {
    id: 'coder',
    name: 'Coder',
    runtime: 'claude-code',
    workspace,
    style,
    ...over,
  })
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}
let roomCount = 0
export async function makeRoom(): Promise<string> {
  const created = await request('POST', '/api/rooms', {
    name: `code${++roomCount}`,
    leadAgentId: 'lead',
  })
  roomId = RoomSchema.parse(created.json()).id
  onMentions(db, roomId)
  return roomId
}
export async function say(text: string) {
  const response = await request('POST', `/api/rooms/${roomId}/messages`, { text })
  expect(response.statusCode, response.body).toBe(200)
  return response
}
export const runs = () =>
  db.sqlite
    .prepare("SELECT * FROM runs WHERE runtime != 'hermes' ORDER BY started_at, rowid")
    .all() as {
    id: string
    status: string
    runtime: string
    cost_usd: number | null
    cost_kind: string | null
    input_tokens: number | null
    output_tokens: number | null
    session_id: string | null
    error: string | null
    profile: string
  }[]
export async function finished(count = 1) {
  await vi.waitFor(
    () => {
      const rows = runs()
      expect(rows.length).toBeGreaterThanOrEqual(count)
      expect(rows.slice(0, count).every((row) => !['queued', 'running'].includes(row.status))).toBe(
        true,
      )
    },
    { timeout: 15_000, interval: 50 },
  )
  await ingest.flushListeners()
  await ingest.drain()
}
export const replies = (): Message[] =>
  db.sqlite
    .prepare(
      "SELECT * FROM messages WHERE room_id = ? AND author_kind = 'agent' ORDER BY created_at, id",
    )
    .all(roomId)
    .map(messageFromRow)
export const calls = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          runtime: string
          args: string[]
          cwd: string
          prompt: string
          env: string[]
        },
    )

export const agy = (over: Record<string, unknown> = {}) =>
  addAgent({
    id: 'agy1',
    name: 'Agy',
    runtime: 'antigravity',
    acknowledgeReads: true,
    permission: 'read-only',
    ...over,
  })

export const launchedTurns = (prompt: string) => {
  try {
    return calls().filter((call) => call.prompt === prompt)
  } catch {
    return []
  }
}
export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const rebootWith = async (options: Parameters<typeof boot>[0]) => {
  await coding.close()
  await app.close()
  await boot(options)
}
/** A run that was mid-flight when Score crashed, with the process record it left behind. */
export function seedCrashedRun(
  runId: string,
  record?: { pid: number; pgid?: number; start?: string | null },
) {
  const now = new Date().toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, score_turn_id, status, model, started_at, updated_at, runtime)
       VALUES (?, 'coder', 'score', ?, 'running', NULL, ?, ?, 'claude-code')`,
    )
    .run(runId, `turn-${runId}`, now, now)
  if (record)
    db.sqlite
      .prepare(
        `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at) VALUES (?, ?, ?, ?, 'b', ?)`,
      )
      .run(runId, record.pid, record.pgid ?? record.pid, record.start ?? null, now)
}
export const processRows = () =>
  db.sqlite.prepare('SELECT run_id, unresolved FROM coding_processes').all() as {
    run_id: string
    unresolved: number
  }[]
export const runRow = (id: string) =>
  db.sqlite.prepare('SELECT status, error, terminal_source FROM runs WHERE id = ?').get(id) as {
    status: string
    error: string | null
    terminal_source: string | null
  }
