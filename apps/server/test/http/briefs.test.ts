import {
  BriefFlowSchema,
  BriefLogPageSchema,
  BriefSummarySchema,
  FlowNodeDetailSchema,
  MessageSchema,
  PlanStartResponseSchema,
  RoomSchema,
  StreamEventSchema,
  type BriefFlow,
  type Message,
} from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { deriveBriefEvents } from '../../src/domain/briefs.ts'
import { PLAN_FIRST_ADDENDUM } from '../../src/domain/plan.ts'
import { deriveTaskEvents } from '../../src/domain/tasks.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { scenarioDuration } from '../../src/hermes/fake/scenario.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
let replies: Record<string, string>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-briefs-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, {
    clock,
    deriveEvents: (sqlite, drafts, context) => [
      ...deriveTaskEvents(sqlite, drafts, context),
      ...deriveBriefEvents(sqlite, drafts, context),
    ],
  })
  replies = {}
  port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: replies[req.agentId] ?? 'The streamed reply is ready.',
    tools: ['terminal', 'edit_file'],
  }))
  await port.start(ingest)
  // The script's first timer is the only one armed; dropping it keeps the demo scenario out of these tests.
  scheduler.clearTimeout(0)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
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
  roomId = RoomSchema.parse(
    (await post('/api/rooms', { name: 'briefs', leadAgentId: 'lead' })).json(),
  ).id
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const post = (url: string, payload: object = {}, key?: string, authed = true) =>
  app.inject({
    method: 'POST',
    url,
    headers: authed
      ? { ...headers, ...(key ? { 'idempotency-key': key } : {}) }
      : { 'x-score-client': 'web' },
    payload,
  })
const get = (url: string) => app.inject({ url })
const send = (payload: object, key?: string) => post(`/api/rooms/${roomId}/messages`, payload, key)
const events = () =>
  db.sqlite
    .prepare('SELECT * FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
const briefEvents = () =>
  events().flatMap((event) => (event.type === 'brief.upserted' ? [event.data] : []))
const messages = (): Message[] =>
  db.sqlite
    .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at, rowid')
    .all(roomId)
    .map(messageFromRow)
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}
const flow = async (briefId: string): Promise<BriefFlow> => {
  const response = await get(`/api/briefs/${briefId}/flow`)
  expect(response.statusCode).toBe(200)
  return BriefFlowSchema.parse(response.json())
}
const rows = (sql: string, ...args: string[]) => db.sqlite.prepare(sql).all(...args)
async function ask(text: string, extra: object = {}): Promise<string> {
  const response = await send({ text, ...extra })
  expect(response.statusCode).toBe(200)
  return MessageSchema.parse(response.json().message).id
}

test('the fake scenario yields one brief with nodes and every kind of edge', async () => {
  const scripted = new FakePort(1, { db, scheduler }, false)
  await scripted.start(ingest)
  await advance(scenarioDuration)
  const list = BriefSummarySchema.array().parse(
    (await get('/api/briefs?status=recent')).json().items,
  )
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({
    id: 'message-brief-0',
    title: 'Add pagination to the activity feed',
    startedBy: 'you',
    status: 'done',
  })
  const graph = await flow('message-brief-0')
  expect(graph.nodes.map((node) => node.id).sort()).toEqual([
    'brief:message-brief-0',
    'task:task-pagination-0',
    'task:task-review-0',
    'turn:message-plan-0',
  ])
  // The docs task is not linked to the brief, so it stays out even though it is in the same room and window.
  expect(graph.nodes.some((node) => node.id.includes('task-docs'))).toBe(false)
  expect(new Set(graph.edges.map((edge) => edge.kind))).toEqual(
    new Set(['flow', 'handoff', 'review', 'sent_back']),
  )
  expect(graph.edges).toContainEqual(
    expect.objectContaining({
      kind: 'handoff',
      from: 'turn:message-plan-0',
      to: 'task:task-pagination-0',
    }),
  )
  expect(graph.edges).toContainEqual(
    expect.objectContaining({
      kind: 'review',
      from: 'task:task-pagination-0',
      to: 'task:task-review-0',
    }),
  )
  expect(graph.edges).toContainEqual(
    expect.objectContaining({
      kind: 'sent_back',
      from: 'task:task-review-0',
      to: 'task:task-pagination-0',
    }),
  )
  expect(graph.stats).toMatchObject({ steps: 3, handoffs: 1, eta: null })
  expect(graph.nodes.every((node) => node.layout.col >= 0)).toBe(true)
  const statuses = briefEvents().map((brief) => brief.status)
  expect(statuses[0]).toBe('running')
  expect(statuses.at(-1)).toBe('done')
  await scripted.stop()
})

test('every human message that starts a turn is a brief, with a title and a derived status', async () => {
  const id = await ask('Plan the launch\nwith details on the second line')
  expect(briefEvents()).toEqual([
    expect.objectContaining({
      id,
      title: 'Plan the launch',
      roomId,
      startedBy: 'you',
      status: 'running',
    }),
  ])
  const active = (await get('/api/briefs?status=active')).json().items
  expect(active).toHaveLength(1)
  expect((await get('/api/briefs?status=recent')).json().items).toEqual([])
  await advance(3000)
  expect(briefEvents().map((brief) => brief.status)).toEqual(['running', 'done'])
  expect((await get('/api/briefs?status=recent')).json().items).toHaveLength(1)
  expect((await get('/api/briefs?status=active')).json().items).toEqual([])
  const graph = await flow(id)
  expect(graph.nodes.map((node) => [node.kind, node.state])).toEqual([
    ['brief', 'done'],
    ['step', 'done'],
  ])
  expect(graph.nodes[1]!.title).toBe('The streamed reply is ready.')
  expect((await get('/api/briefs/unknown/flow')).statusCode).toBe(404)
  expect((await get('/api/briefs?status=other')).statusCode).toBe(400)
})

test('hand-offs between turns become nodes and handoff edges of the same brief', async () => {
  replies.lead = '@builder please continue'
  const id = await ask('hello')
  await advance(4000)
  const graph = await flow(id)
  expect(graph.nodes.filter((node) => node.id.startsWith('turn:'))).toHaveLength(2)
  expect(graph.edges.filter((edge) => edge.kind === 'handoff')).toHaveLength(1)
  expect(graph.stats.handoffs).toBe(1)
  const handoff = events().find((event) => event.type === 'handoff.created')
  expect(handoff?.type === 'handoff.created' && handoff.data.briefId).toBe(id)
  const log = BriefLogPageSchema.parse((await get(`/api/briefs/${id}/log`)).json())
  expect(log.items.map((line) => line.kind)).toContain('handoff')
  expect(log.items.some((line) => line.text === 'lead handed off to builder')).toBe(true)
})

test('links are exact: /assign and Kanban children join, an unlinked agent task stays out', async () => {
  const response = await send({ text: '/assign @builder Write the tests' })
  const id = MessageSchema.parse(response.json().message).id
  const taskId = response.json().command.taskId as string
  expect(rows('SELECT task_id, origin FROM brief_tasks WHERE brief_id = ?', id)).toEqual([
    { task_id: taskId, origin: 'assign' },
  ])
  expect(briefEvents()).toHaveLength(1)
  // An agent-created task that merely looks related (same room, same agent, same time) is not linked.
  const stray = await port.createTask(
    { title: 'Write more tests', assignee: 'builder', roomId },
    'stray',
  )
  // A Kanban child (--parent) of a linked task is.
  const child = await port.createTask(
    { title: 'Subtask', assignee: 'builder', roomId, dependsOn: [taskId] },
    'child',
  )
  const grandchild = await port.createTask(
    { title: 'Sub-subtask', roomId, dependsOn: [child.id] },
    'grandchild',
  )
  expect(
    rows('SELECT task_id, origin FROM brief_tasks WHERE brief_id = ? ORDER BY rowid', id),
  ).toEqual([
    { task_id: taskId, origin: 'assign' },
    { task_id: child.id, origin: 'child' },
    { task_id: grandchild.id, origin: 'child' },
  ])
  const graph = await flow(id)
  expect(graph.nodes.map((node) => node.id)).toEqual([
    `brief:${id}`,
    `task:${taskId}`,
    `task:${child.id}`,
    `task:${grandchild.id}`,
  ])
  expect(graph.nodes.some((node) => node.id === `task:${stray.id}`)).toBe(false)
  expect(graph.edges).toContainEqual(
    expect.objectContaining({ kind: 'flow', from: `task:${taskId}`, to: `task:${child.id}` }),
  )
  expect(graph.nodes[0]!.state).toBe('working')
  expect((await get(`/api/briefs/${id}/flow`)).json().brief.status).toBe('running')
})

test('plan first with several recipients admits only the planner and keeps the team in its prompt', async () => {
  const run = vi.spyOn(port, 'startRun')
  const id = await ask('Ship the endpoint', { planFirst: true, to: ['lead', 'builder'] })
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead'])
  expect(run.mock.calls[0]![0].input).toContain('@lead, @builder')
  expect(rows('SELECT agent_id FROM message_runs WHERE chain_id = ?', id)).toEqual([
    { agent_id: 'lead' },
  ])
})

test('plan first: addendum, parsed plan part, no hand-offs, nothing created until Start plan', async () => {
  replies.lead = [
    'Here is the plan:',
    '- [ ] @builder Build the endpoint',
    '- [ ] @reviewer Review the endpoint',
    '- [ ] nobody-known Do something else',
    '- [ ] @builder',
    '- a bullet that is not a step',
    '```',
    '- [ ] @designer Inside a code fence',
    '```',
  ].join('\n')
  const run = vi.spyOn(port, 'startRun')
  const create = vi.spyOn(port, 'createTask')
  const id = await ask('Ship the endpoint', { planFirst: true })
  expect(run.mock.calls[0]![0].input).toContain(PLAN_FIRST_ADDENDUM.trim())
  await advance(4000)
  const reply = messages().find((message) => message.author.kind === 'agent')!
  const plan = reply.parts.find((part) => part.kind === 'plan')
  expect(plan).toMatchObject({ kind: 'plan', briefId: id })
  // A stored plan (lanes, blocks) must still fit the snapshot guard (audit 2026-10-08: history returned 500).
  const page = await get(`/api/rooms/${roomId}/messages`)
  expect(page.statusCode).toBe(200)
  expect(page.json().items.some((item: Message) => item.parts.some((p) => p.kind === 'plan'))).toBe(
    true,
  )
  expect(
    plan?.kind === 'plan' &&
      plan.lanes.map((lane) => [lane.agentId, lane.blocks.map((b) => b.label)]),
  ).toEqual([
    ['builder', ['Build the endpoint']],
    ['reviewer', ['Review the endpoint']],
  ])
  // The reply text keeps every line; unparsable ones are text only.
  expect(reply.parts.find((part) => part.kind === 'text')).toMatchObject({
    text: expect.stringContaining('nobody-known'),
  })
  // Nothing runs on its own: no hand-off turns, no tasks.
  expect(run).toHaveBeenCalledTimes(1)
  expect(rows('SELECT 1 FROM message_runs WHERE chain_id = ?', id)).toHaveLength(1)
  expect(create).not.toHaveBeenCalled()
  expect(await port.listTasks()).toEqual([])
  expect(briefEvents().at(-1)!.status).toBe('done')
  const planned = await flow(id)
  expect(
    planned.nodes.filter((node) => node.state === 'planned').map((node) => node.title),
  ).toEqual(['Build the endpoint', 'Review the endpoint'])
  expect(planned.edges.filter((edge) => edge.kind === 'planned')).toHaveLength(2)

  expect((await post(`/api/rooms/${roomId}/messages/${id}/plan/start`)).statusCode).toBe(400)
  expect((await post(`/api/rooms/${roomId}/messages/nope/plan/start`)).statusCode).toBe(404)
  expect(
    (await post(`/api/rooms/${roomId}/messages/${reply.id}/plan/start`, {}, undefined, false))
      .statusCode,
  ).toBe(401)
  expect(create).not.toHaveBeenCalled()

  await post(`/api/briefs/${id}/pause`, {}, 'pause-before-start')
  expect(
    (await post(`/api/rooms/${roomId}/messages/${reply.id}/plan/start`, {}, 'start-paused'))
      .statusCode,
  ).toBe(409)
  expect(create).not.toHaveBeenCalled()
  await post(`/api/briefs/${id}/resume`, {}, 'resume-before-start')

  // The second step fails: the first task is already linked to the brief, and a retry reuses it.
  const realCreate = Object.getPrototypeOf(port).createTask.bind(port)
  create.mockImplementationOnce(realCreate)
  create.mockRejectedValueOnce(new Error('boom'))
  expect(
    (await post(`/api/rooms/${roomId}/messages/${reply.id}/plan/start`, {}, 'start-fails'))
      .statusCode,
  ).toBe(500)
  expect(rows('SELECT task_id FROM brief_tasks WHERE brief_id = ?', id)).toHaveLength(1)
  create.mockClear()

  const started = await post(`/api/rooms/${roomId}/messages/${reply.id}/plan/start`, {}, 'start')
  expect(started.statusCode).toBe(200)
  const { briefId, taskIds } = PlanStartResponseSchema.parse(started.json())
  expect(briefId).toBe(id)
  expect(taskIds).toHaveLength(2)
  expect(create.mock.calls.map(([req]) => [req.title, req.assignee, req.dependsOn])).toEqual([
    // The first step was recorded by the failed attempt, so the retry resumes at the second.
    ['Review the endpoint', 'reviewer', [taskIds[0]]],
  ])
  expect(
    rows('SELECT task_id, origin FROM brief_tasks WHERE brief_id = ? ORDER BY rowid', id),
  ).toEqual(taskIds.map((task_id) => ({ task_id, origin: 'plan' })))
  // Pressing Start again (new receipt key) creates nothing new.
  const again = PlanStartResponseSchema.parse(
    (await post(`/api/rooms/${roomId}/messages/${reply.id}/plan/start`, {}, 'start-2')).json(),
  )
  expect(again.taskIds).toEqual(taskIds)
  expect(await port.listTasks()).toHaveLength(2)
  const running = await flow(id)
  expect(running.nodes.some((node) => node.id.startsWith('plan:'))).toBe(false)
  expect(running.nodes.filter((node) => node.id.startsWith('task:'))).toHaveLength(2)
  expect(running.edges).toContainEqual(
    expect.objectContaining({ kind: 'flow', from: `task:${taskIds[0]}`, to: `task:${taskIds[1]}` }),
  )
  expect(running.brief.status).toBe('running')
})

test('pause holds the queue and blocks only not-started tasks; resume unblocks only what Score blocked', async () => {
  const response = await send({ text: '/assign @builder First' })
  const id = MessageSchema.parse(response.json().message).id
  const first = response.json().command.taskId as string
  const make = (title: string, key: string, dependsOn: string[]) =>
    port.createTask({ title, assignee: 'builder', roomId, dependsOn }, key)
  const second = await make('Second', 'second', [first])
  const third = await make('Third', 'third', [first])
  const fourth = await make('Fourth', 'fourth', [first])
  // The person blocked this one themselves before pausing; Score must leave it alone.
  await port.taskAction({ taskId: fourth.id, action: 'block', text: 'Mine' })
  // This one is already past "not started" (in review); pause leaves it alone.
  await port.taskAction({ taskId: third.id, action: 'request_review' })
  const actions = vi.spyOn(port, 'taskAction')
  const paused = await post(`/api/briefs/${id}/pause`, {}, 'pause')
  expect(paused.statusCode).toBe(200)
  expect(BriefSummarySchema.parse(paused.json()).status).toBe('paused')
  const blocked = actions.mock.calls.map(([req]) => [req.taskId, req.action, req.text])
  expect(blocked).toEqual(
    expect.arrayContaining([
      [first, 'schedule', 'Paused from Score'],
      [second.id, 'schedule', 'Paused from Score'],
    ]),
  )
  expect(blocked.map(([task]) => task)).not.toContain(fourth.id)
  expect(
    rows('SELECT task_id FROM brief_paused_tasks WHERE brief_id = ? ORDER BY task_id', id)
      .map((r) => r.task_id)
      .sort(),
  ).toEqual([first, second.id].sort())
  expect(briefEvents().at(-1)).toMatchObject({ id, status: 'paused' })
  // Pausing again blocks nothing new.
  actions.mockClear()
  await post(`/api/briefs/${id}/pause`, {}, 'pause-again')
  expect(actions).not.toHaveBeenCalled()
  // The person unblocks one of them while paused.
  await port.taskAction({ taskId: second.id, action: 'unblock' })
  actions.mockClear()
  const resumed = await post(`/api/briefs/${id}/resume`, {}, 'resume')
  expect(resumed.statusCode).toBe(200)
  expect(BriefSummarySchema.parse(resumed.json()).status).toBe('running')
  expect(actions.mock.calls.map(([req]) => [req.taskId, req.action, req.text])).toEqual([
    [first, 'unblock', 'Resumed from Score'],
  ])
  expect((await port.getTask(fourth.id)).hermesStatus).toBe('blocked')
  expect(rows('SELECT 1 FROM brief_paused_tasks WHERE brief_id = ?', id)).toEqual([])
  // A repeated resume is harmless.
  actions.mockClear()
  await post(`/api/briefs/${id}/resume`, {}, 'resume-again')
  expect(actions).not.toHaveBeenCalled()
  expect((await post('/api/briefs/nope/pause')).statusCode).toBe(404)
  expect((await post(`/api/briefs/${id}/pause`, {}, undefined, false)).statusCode).toBe(401)
})

test('a refused park is reported and kept pending; resume then drops it without touching the task', async () => {
  const response = await send({ text: '/assign @builder Only' })
  const id = MessageSchema.parse(response.json().message).id
  const actions = vi.spyOn(port, 'taskAction').mockRejectedValue(new Error('hermes down'))
  expect((await post(`/api/briefs/${id}/pause`)).statusCode).toBe(502)
  expect(rows('SELECT state FROM brief_paused_tasks WHERE brief_id = ?', id)).toEqual([
    { state: 'pending' },
  ])
  actions.mockClear()
  expect((await post(`/api/briefs/${id}/resume`)).statusCode).toBe(200)
  expect(actions).not.toHaveBeenCalled()
  expect(rows('SELECT 1 FROM brief_paused_tasks WHERE brief_id = ?', id)).toEqual([])
})

test('pause holds the brief queue (no new hand-off turns) and resume releases it', async () => {
  replies.lead = '@builder please continue'
  const run = vi.spyOn(port, 'startRun')
  const id = await ask('hello')
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead'])
  expect((await post(`/api/briefs/${id}/pause`)).statusCode).toBe(200)
  // The lead's running turn finishes, but its hand-off waits.
  await advance(4000)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead'])
  expect(
    rows('SELECT agent_id, state FROM message_runs WHERE chain_id = ? ORDER BY hop', id),
  ).toEqual([
    { agent_id: 'lead', state: 'completed' },
    { agent_id: 'builder', state: 'pending' },
  ])
  expect((await get('/api/briefs?status=active')).json().items[0]).toMatchObject({
    status: 'paused',
  })
  expect((await post(`/api/briefs/${id}/resume`)).statusCode).toBe(200)
  await advance(4000)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead', 'builder'])
})

test('stop ends the active run of a step; nothing running is a 409', async () => {
  const id = await ask('hello')
  await advance(300)
  const turn = (await flow(id)).nodes.find((node) => node.id.startsWith('turn:'))!
  expect(turn.state).toBe('working')
  expect((await post(`/api/flow/nodes/${turn.id}/stop`, {}, undefined, false)).statusCode).toBe(401)
  const stopped = await post(`/api/flow/nodes/${encodeURIComponent(turn.id)}/stop`)
  expect(stopped.statusCode).toBe(200)
  expect(stopped.json()).toEqual({ ok: true })
  await advance(100)
  expect(rows('SELECT status FROM runs WHERE score_turn_id IS NOT NULL')).toEqual([
    { status: 'cancelled' },
  ])
  expect((await post(`/api/flow/nodes/${turn.id}/stop`)).statusCode).toBe(409)
  expect((await post(`/api/flow/nodes/brief:${id}/stop`)).statusCode).toBe(400)
  expect((await post('/api/flow/nodes/turn:nope/stop')).statusCode).toBe(404)
})

test('node detail and the log describe a step', async () => {
  const response = await send({
    text: '/assign @builder Detail -- Do the thing\n\n- [ ] one\n- [x] two',
  })
  const id = MessageSchema.parse(response.json().message).id
  const taskId = response.json().command.taskId as string
  const node = FlowNodeDetailSchema.parse(
    (await get(`/api/flow/nodes/${encodeURIComponent(`task:${taskId}`)}`)).json(),
  )
  expect(node.node.id).toBe(`task:${taskId}`)
  expect(node.description).toContain('Do the thing')
  expect(node.steps.map((step) => step.done)).toEqual([false, true])
  const turnId = await ask('hello')
  await advance(3000)
  const turn = (await flow(turnId)).nodes.find((item) => item.id.startsWith('turn:'))!
  const detail = FlowNodeDetailSchema.parse((await get(`/api/flow/nodes/${turn.id}`)).json())
  expect(detail.description).toBe('The streamed reply is ready.')
  expect(detail.run).toMatchObject({ status: 'completed' })
  expect(detail.tools).toEqual(['terminal', 'edit_file'])
  expect((await get('/api/flow/nodes/task:missing')).statusCode).toBe(404)
  expect((await get('/api/flow/nodes/nonsense')).statusCode).toBe(404)
  const all = BriefLogPageSchema.parse((await get(`/api/briefs/${turnId}/log`)).json())
  expect(all.items.map((line) => line.kind)).toEqual(['system', 'message', 'tool', 'tool'])
  const runId = detail.run!.id
  db.sqlite
    .prepare(
      "INSERT INTO gaps (source, run_id, from_ts, to_ts, reason) VALUES ('run-sse:lead', ?, ?, NULL, 'SSE replay truncated')",
    )
    .run(runId, new Date(scheduler.now()).toISOString())
  const gapped = BriefLogPageSchema.parse((await get(`/api/briefs/${turnId}/log`)).json())
  expect(
    gapped.items.some((line) => line.kind === 'system' && line.text.includes('not recorded')),
  ).toBe(true)
  db.sqlite.prepare('DELETE FROM gaps').run()
  // PLAN 8.7: a coding agent's nesting reaches the log; a stored summary that can't be read is left out.
  const subagent = JSON.stringify({
    status: 'done',
    description: 'Look',
    subagentType: null,
    toolCalls: 1,
    durationMs: 5,
    totalTokens: null,
  })
  db.sqlite
    .prepare(
      "UPDATE tool_calls SET call_id = 'c1', subagent = ? WHERE run_id = ? AND tool = 'terminal'",
    )
    .run(subagent, runId)
  db.sqlite
    .prepare(
      "UPDATE tool_calls SET call_id = 'c2', parent_call_id = 'c1', subagent = 'garbage' WHERE run_id = ? AND tool = 'edit_file'",
    )
    .run(runId)
  const nested = BriefLogPageSchema.parse(
    (await get(`/api/briefs/${turnId}/log?kind=tool`)).json(),
  ).items
  expect(nested[0]).toMatchObject({ callId: 'c1', subagent: { status: 'done', toolCalls: 1 } })
  expect(nested[1]).toMatchObject({ callId: 'c2', parentCallId: 'c1' })
  expect(nested[1]).not.toHaveProperty('subagent')
  const tools = BriefLogPageSchema.parse((await get(`/api/briefs/${turnId}/log?kind=tool`)).json())
  expect(tools.items.map((line) => line.text)).toEqual(['Used terminal', 'Used edit_file'])
  expect(
    BriefLogPageSchema.parse((await get(`/api/briefs/${turnId}/log?agent=nobody`)).json()).items,
  ).toEqual([])
  expect(id).not.toBe(turnId)
  expect((await get(`/api/briefs/${turnId}/log?cursor=!!`)).statusCode).toBe(400)
})

test('a flow is capped at 200 nodes with a "+N more steps" summary', async () => {
  const response = await send({ text: '/assign @builder Root' })
  const id = MessageSchema.parse(response.json().message).id
  db.tx((sqlite) => {
    const insert = sqlite.prepare(
      "INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES (?, ?, 'child', ?)",
    )
    for (let index = 0; index < 249; index++)
      insert.run(
        id,
        `t_${String(index).padStart(3, '0')}`,
        new Date(scheduler.now() + index).toISOString(),
      )
  })
  const graph = await flow(id)
  expect(graph.nodes).toHaveLength(200)
  expect(graph.nodes.at(-1)).toMatchObject({ id: `more:${id}`, title: '+52 more steps' })
  expect(graph.stats.steps).toBe(250)
  const ids = new Set(graph.nodes.map((node) => node.id))
  expect(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true)
})

test('stop requires CSRF, validates inputs and replays its receipt without another adapter call', async () => {
  const id = await ask('Stop once')
  await advance(300)
  const turn = (await flow(id)).nodes.find((node) => node.id.startsWith('turn:'))!
  const url = `/api/flow/nodes/${encodeURIComponent(turn.id)}/stop`
  const stop = vi.spyOn(port, 'stopRun')
  const noCsrf = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: headers.cookie },
    payload: {},
  })
  expect(noCsrf.statusCode).toBe(403)
  expect(stop).not.toHaveBeenCalled()
  const first = await post(url, {}, 'stop-receipt')
  const replay = await post(url, {}, 'stop-receipt')
  expect(first.statusCode).toBe(200)
  expect(replay.json()).toEqual(first.json())
  expect(stop).toHaveBeenCalledTimes(1)
  expect((await post('/api/flow/nodes/invalid/stop')).statusCode).toBe(404)
})
