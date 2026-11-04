import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { createHermesPort } from '../../src/hermes/index.ts'

// 3.27.0: the Tasks page creates and edits Hermes tasks again (POST, PATCH); archive is the actions route.
const port = createHermesPort(loadConfig({ SCORE_MODE: 'fake' }))
let app: ReturnType<typeof buildApp>
let cookie: string
const detail = (over: Record<string, unknown> = {}) =>
  ({
    id: 't_new',
    title: 'Write the changelog',
    body: null,
    assignee: 'builder',
    reviewer: null,
    column: 'planned',
    hermesStatus: 'ready',
    ...over,
  }) as never
beforeEach(async () => {
  app = buildApp({ config: loadConfig({}), logger: false, port })
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
const headers = (key = 'k-1') => ({ 'x-score-client': 'web', cookie, 'idempotency-key': key })

test('POST /api/tasks creates a task with the request’s idempotency key, 201', async () => {
  const create = vi.spyOn(port, 'createTask').mockResolvedValue(detail())
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: headers('k-create'),
    payload: { title: '  Write the changelog  ', body: 'For 2.4', assignee: 'builder' },
  })
  expect(response.statusCode).toBe(201)
  expect(response.json().id).toBe('t_new')
  expect(create).toHaveBeenCalledExactlyOnceWith(
    { title: 'Write the changelog', body: 'For 2.4', assignee: 'builder' },
    'k-create',
  )
})

test('start "now" promotes the new task, and the answer is the task after it', async () => {
  vi.spyOn(port, 'createTask').mockResolvedValue(detail())
  const action = vi.spyOn(port, 'taskAction').mockResolvedValue({ hermesStatus: 'ready' })
  vi.spyOn(port, 'getTask').mockResolvedValue(detail({ column: 'working' }))
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: headers('k-now'),
    payload: { title: 'Ship it', start: 'now' },
  })
  expect(response.statusCode).toBe(201)
  expect(action).toHaveBeenCalledExactlyOnceWith({ taskId: 't_new', action: 'start' })
  expect(response.json().column).toBe('working')
})

test('a blank title, an unknown field or no pairing is refused before Hermes is asked', async () => {
  const create = vi.spyOn(port, 'createTask').mockResolvedValue(detail())
  for (const payload of [{ title: '   ' }, { title: 'x', priority: 1 }])
    expect(
      (await app.inject({ method: 'POST', url: '/api/tasks', headers: headers(), payload }))
        .statusCode,
    ).toBe(400)
  const unpaired = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { 'x-score-client': 'web' },
    payload: { title: 'x' },
  })
  expect(unpaired.statusCode).toBe(401)
  expect(create).not.toHaveBeenCalled()
})

test('PATCH /api/tasks/:taskId changes the title, description or agent; an empty change is refused', async () => {
  const patch = vi.spyOn(port, 'patchTask').mockResolvedValue(detail({ title: 'New title' }))
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/tasks/t_new',
    headers: headers('k-patch'),
    payload: { title: 'New title', assignee: 'reviewer' },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().title).toBe('New title')
  expect(patch).toHaveBeenCalledExactlyOnceWith('t_new', {
    title: 'New title',
    assignee: 'reviewer',
  })
  const empty = await app.inject({
    method: 'PATCH',
    url: '/api/tasks/t_new',
    headers: headers('k-empty'),
    payload: {},
  })
  expect(empty.statusCode).toBe(400)
})

test('a start that fails after the task was made still answers 201 with the task, so a retry never makes a second', async () => {
  const create = vi.spyOn(port, 'createTask').mockResolvedValue(detail())
  vi.spyOn(port, 'taskAction').mockRejectedValue(new Error('promote failed'))
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: headers('k-start-fails'),
    payload: { title: 'Ship it', start: 'now' },
  })
  expect(response.statusCode).toBe(201)
  expect(response.json()).toMatchObject({ id: 't_new', column: 'planned', startFailed: true })
  expect(create).toHaveBeenCalledTimes(1)
})

test('a create that failed on the server can be retried with the same key', async () => {
  const create = vi
    .spyOn(port, 'createTask')
    .mockRejectedValueOnce(new Error('Hermes timed out'))
    .mockResolvedValueOnce(detail())
  const first = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: headers('k-retry'),
    payload: { title: 'Write the changelog' },
  })
  expect(first.statusCode).toBe(500)
  const second = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: headers('k-retry'),
    payload: { title: 'Write the changelog' },
  })
  expect(second.statusCode).toBe(201)
  expect(create).toHaveBeenCalledTimes(2)
})
