import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createIngest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { FAKE_CLI } from './coding-fixtures.ts'
import {
  addAgent,
  app,
  boot,
  calls,
  coding,
  db,
  dir,
  finished,
  home,
  ingest,
  log,
  makeRoom,
  replies,
  request,
  roomId,
  runs,
  say,
  setEnv,
  setupCodingRuntime,
  workspace,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

test('a queued turn is checked again right before it spawns: a CLI replaced meanwhile by a broken version fails it (review: high 4)', async () => {
  await coding.close()
  await app.close()
  await boot({ version: '2.1.1' })
  expect((await addAgent()).cli).toMatchObject({ state: 'untested_version', version: '2.1.1' })
  await coding.close()
  await app.close()
  // The CLI is the tested one when the first turn starts and is upgraded while the second waits its turn.
  await boot({ version: '2.1.295' })
  await makeRoom()
  await say('@coder [fixture:slow] first')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  const firstRoom = roomId
  // Another room: the same agent runs one turn at a time, so this one waits in the runtime's queue.
  await makeRoom()
  await say('@coder second')
  await vi.waitFor(() => expect(runs()).toHaveLength(2), { timeout: 10_000 })
  expect(runs()[1]!.status).toBe('queued')
  setEnv('SCORE_CODING_FAKE_VERSION', '2.1.297')
  setEnv('SCORE_CODING_FAKE_HELP', join(home, 'missing-help.txt'))
  const first = db.sqlite
    .prepare("SELECT message_id FROM message_runs WHERE room_id = ? AND agent_id = 'coder'")
    .get(firstRoom) as { message_id: string }
  await request('POST', `/api/rooms/${firstRoom}/messages/${first.message_id}/stop`)
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
  expect(runs()[1]!.error).toMatch(/Claude Code 2.1.297 can't run: Score couldn’t read/)
  // Only the first turn was ever spawned.
  expect(calls().filter((call) => call.prompt.includes('second'))).toHaveLength(0)
}, 30_000)

test('a real server crash leaves the tools the CLI started running; the next start stops their group before admitting turns (review: high 2)', async () => {
  const { spawn } = await import('node:child_process')
  // The CLI itself dies with the server (parent-death signal); what outlives the crash is a tool it started, in its group.
  // A killed member stays a zombie until its new parent reaps it, which is not ours to wait for: only live ones count.
  const groupAlive = (pgid: number) =>
    readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry)) return false
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return state !== 'Z' && Number(group) === pgid
      } catch {
        return false
      }
    })
  const crashDir = join(dir, 'crash')
  mkdirSync(crashDir)
  const script = fileURLToPath(new URL('./crash-server.ts', import.meta.url))
  const server = spawn(
    process.execPath,
    ['--import', 'tsx', script, crashDir, workspace, FAKE_CLI],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, SCORE_CODING_FAKE_LOG: log },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  let childPid = 0
  try {
    childPid = await new Promise<number>((resolve, reject) => {
      let out = ''
      server.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const match = /READY (\d+)/.exec(out)
        if (match) resolve(Number(match[1]))
      })
      server.on('exit', () => reject(new Error(`server exited early: ${out}`)))
    })
    expect(groupAlive(childPid)).toBe(true)
    server.removeAllListeners('exit')
    server.kill('SIGKILL')
    await new Promise((resolve) => server.on('exit', resolve))
    // The crash: the server is gone, the tool its CLI started is not.
    expect(groupAlive(childPid)).toBe(true)
    const crashDb = openDatabase(join(crashDir, 'score.db'))
    migrate(crashDb, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    const crashIngest = createIngest(crashDb)
    const restarted = new CodingRuntime({
      db: crashDb,
      ingest: crashIngest,
      locator: new CliLocator({ fakeCli: FAKE_CLI }),
      home: join(crashDir, 'home'),
      policy: defaultRootPolicy([join(crashDir, 'home')]),
    })
    expect(
      crashDb.sqlite.prepare('SELECT pid, pgid, start_time FROM coding_processes').get() as {
        pid: number
        pgid: number
        start_time: string
      },
    ).toMatchObject({ pid: childPid, pgid: childPid, start_time: expect.stringMatching(/^\d+$/) })
    expect(await restarted.recover()).toBe(1)
    // Stopped before the run was released, and the record is gone.
    expect(groupAlive(childPid)).toBe(false)
    expect(crashDb.sqlite.prepare('SELECT 1 FROM coding_processes').get()).toBeUndefined()
    expect(crashDb.sqlite.prepare('SELECT status FROM runs').get()).toEqual({
      status: 'interrupted',
    })
    await crashIngest.close()
    crashDb.close()
  } finally {
    server.kill('SIGKILL')
    if (childPid && groupAlive(childPid)) process.kill(-childPid, 'SIGKILL')
  }
}, 60_000)

test('recovery never signals a reused pid: a different start time is left alone (review: high 2)', async () => {
  const { killRecordedGroup } = await import('../../src/runtimes/coding/proc.ts')
  // This test process is alive, but not "the" recorded process.
  expect(
    await killRecordedGroup(
      { pid: process.pid, pgid: process.pid, startTime: '1', bootId: null },
      100,
    ),
  ).toBe('gone')
})

test('shutdown closes admission: nothing is admitted or spawned after close() (review: medium 5)', async () => {
  await addAgent()
  // Racing: the turn is mid-admission when the runtime closes.
  const racing = coding.startRun({ agentId: 'coder', input: 'go', turnId: 'turn-race' })
  const closing = coding.close()
  await racing.catch(() => undefined)
  await closing
  await ingest.drain()
  const rows = runs()
  expect(rows.every((row) => !['queued', 'running'].includes(row.status))).toBe(true)
  expect(() => readFileSync(log, 'utf8')).toThrow()
  // And afterwards.
  await expect(
    coding.startRun({ agentId: 'coder', input: 'go', turnId: 'turn-late' }),
  ).rejects.toMatchObject({ status: 503 })
})

test('a failure while preparing a turn fails the run and the reply instead of leaving it queued (review: medium 6)', async () => {
  await addAgent()
  await makeRoom()
  // The per-agent settings folder cannot be made: a file sits where it must go.
  writeFileSync(join(home, 'coding'), 'in the way')
  await say('@coder go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/Could not prepare/)
  expect(JSON.stringify(replies()[0]!.parts)).toContain('This run failed')
  // The agent is free again (removal is not blocked by a stuck turn).
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(204)
})

test('a failed resume that already emitted events falls back to a fresh session without losing its events (review: medium 7)', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stale] one')
  await finished(1)
  await say('@coder [fixture:stale] two')
  await finished(2)
  expect(runs()[1]).toMatchObject({
    status: 'completed',
    session_id: '88888888-8888-4888-8888-888888888888',
  })
  expect(db.sqlite.prepare('SELECT session_id FROM coding_sessions').all()).toEqual([
    { session_id: '88888888-8888-4888-8888-888888888888' },
  ])
  expect(JSON.stringify(replies()[1]!.parts)).toContain('Fresh start answer.')
  expect(calls().map((call) => call.args.includes('--resume'))).toEqual([false, true, false])
})
