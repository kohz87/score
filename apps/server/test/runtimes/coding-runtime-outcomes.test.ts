import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import {
  addAgent,
  app,
  boot,
  coding,
  db,
  finished,
  home,
  makeRoom,
  replies,
  request,
  roomId,
  runs,
  say,
  setEnv,
  setupCodingRuntime,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

test('Stop ends the process and the reply says it was stopped', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] take your time')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  await vi.waitFor(() => expect(replies()[0]?.parts.length).toBeGreaterThan(0), { timeout: 10_000 })
  const reply = replies()[0]!
  const stopped = await request('POST', `/api/rooms/${roomId}/messages/${reply.id}/stop`)
  expect(stopped.statusCode, stopped.body).toBe(200)
  await finished()
  expect(runs()[0]!.status).toBe('cancelled')
  const final = replies()[0]!
  expect(final.streaming).toBe(false)
  expect(JSON.stringify(final.parts)).toContain('This run was stopped.')
})

test('a turn that outlives the wall-clock limit is stopped and recorded as failed', async () => {
  await coding.close()
  await app.close()
  await boot({ maxTurnMs: 300, graceMs: 100 })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] forever')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed' })
  expect(runs()[0]!.error).toMatch(/Stopped after/)
})

test('a failed CLI turn explains itself in the room and keeps the usage it reported', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:error] go')
  await finished()
  expect(runs()[0]).toMatchObject({ status: 'failed', error: 'The model request failed' })
  expect(JSON.stringify(replies()[0]!.parts)).toContain('This run failed: The model request failed')
})

test('output is redacted before it is stored: reply text, tool previews, frames', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:secret] go')
  await finished()
  const stored = JSON.stringify([
    replies().map((reply) => reply.parts),
    db.sqlite.prepare('SELECT * FROM tool_calls').all(),
    db.sqlite.prepare('SELECT * FROM watch_frames').all(),
    db.sqlite.prepare('SELECT data FROM events').all(),
    db.sqlite.prepare('SELECT output, error FROM runs').all(),
  ])
  expect(stored).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  expect(stored).not.toContain('abcdefghijklmnop123456')
  expect(stored).not.toContain('ghp_abcdefghijklmnop1234')
  expect(stored).toContain('[redacted]')
})

test('allow-listed CLI notices are dropped, not stored, and do not cost the result', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:ignorable] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(JSON.stringify(db.sqlite.prepare('SELECT data FROM events').all())).not.toContain(
    'rate_limit_event',
  )
})

test('FW #5: unknown or unparseable CLI records are dropped, not stored, and the answer is not used', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:unknown] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(JSON.stringify(db.sqlite.prepare('SELECT data FROM events').all())).not.toContain(
    'rate_limit_event',
  )
})

test('FW #5: an explicit Claude success followed by a rejected error record is not a result', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:lateerror] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
})

// 3.15.3 (decision 157): no confirmation step; Score's help check is what stops a broken version.
test('a newer CLI version runs without asking; one whose help changed what Score relies on is refused with why', async () => {
  await coding.close()
  await app.close()
  const changed = join(home, 'changed-help.txt')
  writeFileSync(
    changed,
    readFileSync(
      fileURLToPath(new URL('../fixtures/coding/help/claude-code.txt', import.meta.url)),
      'utf8',
    ).replace('ignoring all other MCP configurations', 'merged with your other MCP configurations'),
  )
  setEnv('SCORE_CODING_FAKE_HELP', changed)
  await boot({ version: '9.9.9' })
  const agent = await addAgent()
  expect(agent.cli).toMatchObject({ state: 'untested_version', version: '9.9.9' })
  expect(agent.cli.problem).toContain('no longer describes --strict-mcp-config')
  await makeRoom()
  await say('@coder go')
  await vi.waitFor(() => expect(JSON.stringify(replies()[0]?.parts)).toContain("can't run"), {
    timeout: 10_000,
  })
  expect(runs()).toHaveLength(0)
  expect(db.sqlite.prepare('SELECT version FROM checked_cli_versions').all()).toEqual([])
  // The confirmation route is gone.
  expect(
    (await request('POST', '/api/coding-agents/coder/confirm-version', { version: '9.9.9' }))
      .statusCode,
  ).toBe(404)
  // A version whose help reads as Score relies on runs straight away, and is remembered.
  setEnv('SCORE_CODING_FAKE_HELP', undefined)
  setEnv('SCORE_CODING_FAKE_VERSION', '9.9.10')
  await say('@coder go again')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(db.sqlite.prepare('SELECT version FROM checked_cli_versions').all()).toEqual([
    { version: '9.9.10' },
  ])
  const view = (await request('GET', '/api/coding-agents')).json().items[0]
  expect(view.cli).toMatchObject({ state: 'untested_version', version: '9.9.10', problem: null })
})

test('the intent is durable before anything spawns', async () => {
  await addAgent()
  await makeRoom()
  const real = coding.locator.command.bind(coding.locator)
  let seen: unknown
  vi.spyOn(coding.locator, 'command').mockImplementation((driver) => {
    seen = db.sqlite
      .prepare("SELECT kind, state FROM command_intents WHERE kind = 'start_coding_run'")
      .get()
    return real(driver)
  })
  await say('@coder go')
  await finished()
  expect(seen).toEqual({ kind: 'start_coding_run', state: 'accepted' })
})
