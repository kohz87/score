import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { SqliteSessionStore } from '../../src/auth/sqlite-session-store.ts'
import { createHermesPort } from '../../src/hermes/index.ts'
import { event, setup } from '../hermes/bridge/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: ReturnType<typeof createHermesPort>
let cookie: string
beforeEach(async () => {
  env = setup()
  port = createHermesPort({ mode: 'fake', fakeSpeed: 1, fakeLoop: false, home: env.home })
  app = buildApp({
    config: loadConfig({ SCORE_HOME: env.home }),
    logger: false,
    db: env.db,
    ingest: env.ingest,
    port,
    sessionStore: new SqliteSessionStore(env.db),
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  await env.close()
})
function post(body: object, key?: string, taskId = 'task-1') {
  return app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/actions`,
    headers: { cookie, 'x-score-client': 'web', ...(key ? { 'idempotency-key': key } : {}) },
    payload: body,
  })
}
async function card(runId: number) {
  const token = await env.token()
  await env.send(token, [
    event(runId, 'post_tool_call', {
      tool_name: 'terminal',
      args: { command: 'rm demo' },
      kanbanDenial: {
        patternKey: 'delete',
        commandDigest: 'a'.repeat(64),
        taskId: 'task-1',
        runId,
      },
    }),
  ])
}

test('gate #10 unblock closes captured old cards while a new attempt denial remains open', async () => {
  await card(1)
  vi.spyOn(port, 'taskAction').mockImplementation(async () => {
    await card(2)
    return { hermesStatus: 'blocked' }
  })
  expect((await post({ action: 'unblock' })).statusCode).toBe(200)
  expect(
    env.db.sqlite
      .prepare('SELECT kanban_run_id, closed_reason FROM approvals ORDER BY kanban_run_id')
      .all(),
  ).toEqual([
    { kanban_run_id: 1, closed_reason: 'task_moved' },
    { kanban_run_id: 2, closed_reason: null },
  ])
})
test('gate #10 failed unblock retains old cards', async () => {
  await card(1)
  vi.spyOn(port, 'taskAction').mockRejectedValue(new Error('fixture failure'))
  expect((await post({ action: 'unblock' })).statusCode).toBe(500)
  expect(
    env.db.sqlite.prepare('SELECT closed_reason FROM approvals').get()?.closed_reason,
  ).toBeNull()
})

test.each(['comment', 'unblock'] as const)(
  'gate #12 concurrent keyed %s retries execute one port action and replay durably',
  async (action) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const call = vi.spyOn(port, 'taskAction').mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { hermesStatus: 'ready' }
    })
    const body = { action, text: 'human note' }
    const first = post(body, 'retry-key')
    const running = Promise.resolve(first)
    await entered.promise
    expect(env.db.sqlite.prepare('SELECT status, response FROM request_receipts').get()).toEqual({
      status: null,
      response: null,
    })
    const second = Promise.resolve(post(body, 'retry-key'))
    const conflict = await post({ ...body, text: 'different' }, 'retry-key')
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('idempotency_conflict')
    release.resolve()
    const responses = await Promise.all([running, second])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(responses[1]!.json()).toEqual(responses[0]!.json())
    await app.close()
    app = buildApp({
      config: loadConfig({ SCORE_HOME: env.home }),
      logger: false,
      db: env.db,
      ingest: env.ingest,
      port,
      sessionStore: new SqliteSessionStore(env.db),
    })
    const replay = await post(body, 'retry-key')
    // The same human session is retained by the pairing store shared with the reopened app below.
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(responses[0]!.json())
    expect(call).toHaveBeenCalledTimes(1)
  },
)

test('gate #12 request receipts scope keys to concrete routes; unkeyed requests still run every time', async () => {
  const action = vi.spyOn(port, 'taskAction').mockResolvedValue({ hermesStatus: 'ready' })
  const body = { action: 'comment', text: 'same note' }
  expect((await post(body, 'shared-key', 'task-1')).statusCode).toBe(200)
  expect((await post(body, 'shared-key', 'task-2')).statusCode).toBe(200)
  expect((await post(body)).statusCode).toBe(200)
  expect((await post(body)).statusCode).toBe(200)
  expect(action).toHaveBeenCalledTimes(4)
})

test('gate #12 keyed handler failures replay the original status and body', async () => {
  const action = vi.spyOn(port, 'taskAction').mockRejectedValue(new Error('fixture failure'))
  const body = { action: 'unblock' }
  const first = await post(body, 'error-retry')
  expect(first.statusCode).toBe(500)
  const retry = await post(body, 'error-retry')
  expect(retry.statusCode).toBe(first.statusCode)
  expect(retry.json()).toEqual(first.json())
  expect(action).toHaveBeenCalledOnce()
})

test('gate #12 pending receipt after a crash prevents a second side effect', async () => {
  const action = vi.spyOn(port, 'taskAction').mockResolvedValue({ hermesStatus: 'ready' })
  await post({ action: 'unblock' }, 'crash-key')
  env.db.sqlite.prepare('UPDATE request_receipts SET status = NULL, response = NULL').run()
  const retry = await post({ action: 'unblock' }, 'crash-key')
  expect(retry.statusCode).toBe(409)
  expect(retry.json().error.code).toBe('idempotency_pending')
  expect(action).toHaveBeenCalledOnce()
})

test('gate #12 request receipt retention expires keys after 24 hours', async () => {
  const action = vi.spyOn(port, 'taskAction').mockResolvedValue({ hermesStatus: 'ready' })
  const body = { action: 'comment', text: 'note' }
  await post(body, 'expired-key')
  env.db.sqlite
    .prepare('UPDATE request_receipts SET created_at = ?')
    .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  expect((await post({ ...body, text: 'another note' }, 'expired-key')).statusCode).toBe(200)
  expect(action).toHaveBeenCalledTimes(2)
})

test('gate follow-up: a pending receipt never expires, so an uncertain action is not repeated', async () => {
  const action = vi.spyOn(port, 'taskAction').mockResolvedValue({ hermesStatus: 'blocked' })
  const body = { action: 'comment', text: 'note' }
  await post(body, 'crash-then-expire')
  env.db.sqlite
    .prepare('UPDATE request_receipts SET status = NULL, response = NULL, created_at = ?')
    .run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
  const { retireIngestKeys } = await import('../../src/hub/retire.ts')
  retireIngestKeys(env.db, { keepPositions: 0 })
  const retry = await post(body, 'crash-then-expire')
  expect(retry.statusCode).toBe(409)
  expect(retry.json().error.code).toBe('idempotency_pending')
  expect(action).toHaveBeenCalledOnce()
})
