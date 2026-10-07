import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { createHermesPort } from '../../src/hermes/index.ts'

const port = createHermesPort(loadConfig({ SCORE_MODE: 'fake' }))
let app: ReturnType<typeof buildApp>
let cookie: string
let action: MockInstance<typeof port.taskAction>
beforeEach(async () => {
  app = buildApp({ config: loadConfig({}), logger: false, port })
  action = vi.spyOn(port, 'taskAction').mockResolvedValue({ hermesStatus: 'blocked' })
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
})
function send(payload: unknown, headers = { 'x-score-client': 'web', cookie }) {
  return app.inject({
    method: 'POST',
    url: '/api/tasks/t_test/actions',
    headers,
    payload: payload as object,
  })
}

test.each(['comment', 'unblock'] as const)(
  'human %s reaches port and returns task status',
  async (choice) => {
    const response = await send({ action: choice, text: 'human note' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ taskId: 't_test', action: choice, hermesStatus: 'blocked' })
    expect(action).toHaveBeenCalledExactlyOnceWith({
      taskId: 't_test',
      action: choice,
      text: 'human note',
    })
  },
)
test('unblock note is optional', async () => {
  expect((await send({ action: 'unblock' })).statusCode).toBe(200)
  expect(action).toHaveBeenCalledWith({ taskId: 't_test', action: 'unblock' })
})
test.each(['start', 'block', 'request_review', 'request_changes', 'complete', 'archive', 'grant'])(
  'unimplemented action %s is 501',
  async (choice) => {
    const response = await send({ action: choice })
    expect(response.statusCode).toBe(501)
    expect(response.json().error.code).toBe('not_implemented')
    expect(action).not.toHaveBeenCalled()
  },
)
test.each([
  { action: 'comment' },
  { action: 'comment', text: '' },
  { action: 'comment', text: '  ' },
  { action: 'unblock', text: 'x'.repeat(2001) },
  { action: 'comment', text: 'x\0y' },
])('rejects invalid input %j', async (body) => {
  expect((await send(body)).statusCode).toBe(400)
  expect(action).not.toHaveBeenCalled()
})
test('human guard, CSRF header and origin are enforced', async () => {
  expect(
    (await send({ action: 'unblock' }, { 'x-score-client': 'web', cookie: '' })).statusCode,
  ).toBe(401)
  expect((await send({ action: 'unblock' }, { 'x-score-client': '', cookie })).statusCode).toBe(403)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/tasks/t_test/actions',
        headers: { 'x-score-client': 'web', cookie, origin: 'https://untrusted.example' },
        payload: { action: 'unblock' },
      })
    ).statusCode,
  ).toBe(403)
  expect(action).not.toHaveBeenCalled()
})

test('a successful unblock closes the task denial cards; a comment does not', async () => {
  const submit = vi.fn(async () => ({ status: 'applied' as const }))
  const withIngest = buildApp({
    config: loadConfig({}),
    logger: false,
    port,
    ingest: { submit } as unknown as NonNullable<Parameters<typeof buildApp>[0]['ingest']>,
  })
  try {
    const paired = await withIngest.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: withIngest.pairing.createToken() },
    })
    const headers = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
    const post = (payload: object) =>
      withIngest.inject({ method: 'POST', url: '/api/tasks/t_test/actions', headers, payload })
    expect((await post({ action: 'comment', text: 'no' })).statusCode).toBe(200)
    expect(submit).not.toHaveBeenCalled()
    expect((await post({ action: 'unblock' })).statusCode).toBe(200)
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: 'task-actions' }),
    )
  } finally {
    await withIngest.close()
  }
})
