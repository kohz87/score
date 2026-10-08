import {
  ApprovalSchema,
  ApprovalsPageSchema,
  ErrorEnvelopeSchema,
  RoomSchema,
  StreamEventSchema,
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
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { approvalMessage } from '../../src/domain/message-runs.ts'
import { ApprovalOutbox } from '../../src/domain/approval-outbox.ts'
import { requestRunApproval } from '../../src/domain/approvals.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let outbox: ApprovalOutbox
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
let replies: Record<string, string>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-approval-chat-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  replies = {}
  port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: replies[req.agentId] ?? 'The streamed reply is ready.',
    tools: ['terminal', 'terminal', 'terminal', 'edit_file', 'edit_file'],
  }))
  await port.start(ingest)
  outbox = new ApprovalOutbox({ db, ingest, port, clock })
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    outbox,
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
  const created = await post('/api/rooms', { name: 'routing', leadAgentId: 'lead' })
  roomId = RoomSchema.parse(created.json()).id
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const post = (url: string, payload: object, key?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
    payload,
  })
const send = (payload: object, key?: string) => post(`/api/rooms/${roomId}/messages`, payload, key)
const messages = (): Message[] =>
  db.read((sqlite) =>
    sqlite.prepare('SELECT * FROM messages WHERE room_id = ?').all(roomId).map(messageFromRow),
  )
const events = () =>
  db.sqlite
    .prepare('SELECT * FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}

const approvalMessages = () =>
  messages().filter((message) =>
    message.parts.some((part) => part.kind === 'approval' && part.approvalId.startsWith('fake-')),
  )
const ledger = async () =>
  ApprovalsPageSchema.parse(
    (await app.inject({ url: '/api/approvals?status=all', headers })).json(),
  ).items.filter((item) => item.id.startsWith('fake-approval:'))

test('a Score run that raises an approval adds one approval card message to its room', async () => {
  const sent = await send({ text: 'Please ask for approval before installing' })
  expect(sent.statusCode).toBe(200)
  await advance(5000)
  const cards = approvalMessages()
  expect(cards).toHaveLength(1)
  const [approval] = await ledger()
  expect(approval).toMatchObject({ origin: 'score-run', agentId: 'lead', actionable: true })
  expect(cards[0]).toMatchObject({
    roomId,
    author: { kind: 'agent', agentId: 'lead' },
    streaming: false,
    parts: [{ kind: 'approval', approvalId: approval!.id }],
  })
  // The reply message itself is never mutated to carry the card.
  const reply = messages().find((message) => message.id.startsWith('reply:'))!
  expect(reply.parts.some((part) => part.kind === 'approval')).toBe(false)
  expect(
    events().filter(
      (event) =>
        event.type === 'message.created' &&
        event.data.parts.some(
          (part) => part.kind === 'approval' && part.approvalId.startsWith('fake-'),
        ),
    ),
  ).toHaveLength(1)
})

test('deciding the approval resolves the ledger as you and lets the run finish', async () => {
  await send({ text: 'ask for approval please' })
  await advance(5000)
  const [approval] = await ledger()
  const decided = await post(`/api/approvals/${approval!.id}/decision`, { choice: 'once' }, 'k1')
  expect(decided.statusCode).toBe(202)
  await vi.waitFor(async () => {
    await outbox.runOnce()
    await advance(500)
    expect((await ledger())[0]).toMatchObject({
      status: 'approved',
      decision: { choice: 'once', by: 'you' },
      delivery: 'applied',
    })
  })
  await advance(5000)
  expect(approvalMessages()).toHaveLength(1)
  const reply = messages().find((message) => message.id.startsWith('reply:'))!
  expect(reply.streaming).toBe(false)
})

test('a plain message raises no approval and creates no card', async () => {
  await send({ text: 'hello there' })
  await advance(5000)
  expect(await ledger()).toEqual([])
  expect(approvalMessages()).toEqual([])
})

test('the card message is idempotent per approval', async () => {
  await send({ text: 'ask for approval' })
  await advance(5000)
  const [approval] = await ledger()
  const again = approvalMessage(db.sqlite, approval!.id, new Date(scheduler.now()).toISOString())
  expect(again).toEqual([])
  expect(approvalMessages()).toHaveLength(1)
})

test('approvals of runs that were not started from a room add no card', () => {
  const at = new Date(scheduler.now()).toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('scripted', 'builder', 'score', 'waiting_for_approval', ?, ?)`,
    )
    .run(at, at)
  const request = () =>
    db.tx((sqlite) =>
      requestRunApproval(
        sqlite,
        {
          id: 'scripted-approval',
          profile: 'builder',
          runId: 'scripted',
          requestId: 'scripted',
          command: 'pnpm add ws',
          description: 'Install ws',
          choices: ['once', 'deny'],
        },
        at,
      ),
    )
  expect(request().map((event) => event.type)).toEqual(['approval.requested'])
  expect(db.tx((sqlite) => approvalMessage(sqlite, 'scripted-approval', at))).toEqual([])
  expect(db.tx((sqlite) => approvalMessage(sqlite, 'missing', at))).toEqual([])
})

test('GET /api/approvals/:id returns the same approval as the list, 404 when unknown', async () => {
  await send({ text: 'ask for approval please' })
  await advance(5000)
  const [listed] = await ledger()
  const found = await app.inject({
    url: `/api/approvals/${encodeURIComponent(listed!.id)}`,
    headers,
  })
  expect(found.statusCode).toBe(200)
  expect(ApprovalSchema.parse(found.json())).toEqual(listed)
  const missing = await app.inject({ url: '/api/approvals/nope', headers })
  expect(missing.statusCode).toBe(404)
  expect(ErrorEnvelopeSchema.parse(missing.json()).error.code).toBe('not_found')
  const tooLong = await app.inject({ url: `/api/approvals/${'x'.repeat(300)}`, headers })
  expect(tooLong.statusCode).toBe(414) // Fastify's own parameter-length guard
})
