import { expect, test, vi } from 'vitest'

import { createRoutingHelpers, routingTestSuite, type RoutingTestState } from './routing-helpers.ts'

let dir: RoutingTestState['dir']
let db: RoutingTestState['db']
let ingest: RoutingTestState['ingest']
let port: RoutingTestState['port']
let scheduler: RoutingTestState['scheduler']
let app: RoutingTestState['app']
let headers: RoutingTestState['headers']
let roomId: RoutingTestState['roomId']
let replies: RoutingTestState['replies']
const current = (): RoutingTestState => ({
  dir,
  db,
  ingest,
  port,
  scheduler,
  app,
  headers,
  roomId,
  replies,
})
routingTestSuite((next) => {
  dir = next.dir
  db = next.db
  ingest = next.ingest
  port = next.port
  scheduler = next.scheduler
  app = next.app
  headers = next.headers
  roomId = next.roomId
  replies = next.replies
}, current)

const { send, messages, advance } = createRoutingHelpers(current)

test('/model <alias> runs on the model the alias of that agent stands for', async () => {
  await port.updateModelSettings('builder', {
    aliases: [{ name: 'quick', model: 'local-gpt-mini', provider: 'local' }],
  })
  const run = vi.spyOn(port, 'startRun')
  const sent = await send({ text: '/model Quick @builder Check this' }, 'alias')
  expect(sent.statusCode).toBe(200)
  expect(run.mock.calls[0]![0]).toMatchObject({
    agentId: 'builder',
    model: 'local-gpt-mini',
    provider: 'local',
  })
})

test('/model <alias> with a custom endpoint is refused before anything is queued (audit5-e)', async () => {
  const real = port.readModelSettings.bind(port)
  vi.spyOn(port, 'readModelSettings').mockImplementation(async (agentId) => ({
    ...(await real(agentId)),
    aliases: [{ name: 'private', model: 'gpt-x', provider: 'openrouter', editable: false }],
  }))
  const run = vi.spyOn(port, 'startRun')
  const sent = await send({ text: '/model private @builder Check this' }, 'custom-alias')
  expect(sent.statusCode).toBe(409)
  expect(sent.json()).toMatchObject({
    error: { message: expect.stringContaining('custom endpoint') },
  })
  await advance(100)
  expect(run).not.toHaveBeenCalled()
})

test('assign creates one task and receipt replay never reroutes', async () => {
  const task = vi.spyOn(port, 'createTask')
  const run = vi.spyOn(port, 'startRun')
  const body = { text: '/assign @builder Implement paging -- Preserve focus' }
  const first = await send(body, 'assign')
  expect(first.statusCode).toBe(200)
  expect(first.json().command).toMatchObject({
    kind: 'assign',
    taskId: expect.any(String),
    taskKey: expect.stringMatching(/^T-/),
  })
  expect(task.mock.calls[0]![0]).toEqual({
    title: 'Implement paging',
    body: 'Preserve focus',
    assignee: 'builder',
    roomId,
  })
  expect((await send(body, 'assign')).body).toBe(first.body)
  expect(task).toHaveBeenCalledTimes(1)
  expect(run).not.toHaveBeenCalled()
})

test('model command routes remaining text with a one-shot model and stable session', async () => {
  const run = vi.spyOn(port, 'startRun')
  const first = await send({ text: '/model demo-model @builder Check this' }, 'model')
  expect(first.statusCode).toBe(200)
  expect(first.json()).toMatchObject({
    routedTo: ['builder'],
    command: { kind: 'model', model: 'demo-model' },
  })
  expect(run.mock.calls[0]![0]).toMatchObject({
    agentId: 'builder',
    input: '@builder Check this',
    model: 'demo-model',
    sessionId: `score-${roomId}-builder`,
  })
  expect((await send({ text: '/model demo-model @builder Check this' }, 'model')).body).toBe(
    first.body,
  )
  expect(run).toHaveBeenCalledTimes(1)
})

test.each([
  ['/assign @builder', 400, '/assign'],
  ['/model', 400, '/model'],
  ['/routine @builder', 400, '/routine'],
  ['/remember fact', 501, '/remember'],
  ['/skill @builder example', 501, '/skill'],
])('command %s rejects with usage and no stored message', async (text, status, usage) => {
  const response = await send({ text })
  expect(response.statusCode).toBe(status)
  expect(response.json().error.details.usage).toContain(usage)
  expect(messages()).toEqual([])
})

test('/routine creates a routine for the agent, stores the message and starts no run', async () => {
  const run = vi.spyOn(port, 'startRun')
  const response = await send({ text: '/routine @builder every 2h check the build' }, 'routine-key')
  expect(response.statusCode).toBe(200)
  const { command, routedTo } = response.json()
  expect(routedTo).toEqual([])
  expect(command).toEqual({ kind: 'routine', routineId: expect.stringMatching(/^builder:/) })
  expect(run).not.toHaveBeenCalled()
  expect(await port.listRoutines('builder')).toMatchObject([
    { id: command.routineId, schedule: 'every 2h', description: 'check the build', enabled: true },
  ])
  expect(messages()).toHaveLength(1)
  const replay = await send({ text: '/routine @builder every 2h check the build' }, 'routine-key')
  expect(replay.json().command).toEqual(command)
  expect(await port.listRoutines('builder')).toHaveLength(1)
})
