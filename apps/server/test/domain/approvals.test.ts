import { ApprovalSchema, type ApprovalChoice } from '@score/contract'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import { ApprovalOutbox } from '../../src/domain/approval-outbox.ts'
import {
  deriveApproval,
  requestRunApproval,
  respondRunApproval,
  expireApprovals,
} from '../../src/domain/approvals.ts'
import {
  ApprovalRowSchema,
  approvalView,
  readApprovalRow,
  readDelivery,
} from '../../src/domain/approval-store.ts'
import { ApprovalDeliveryError, createHermesPort } from '../../src/hermes/index.ts'
import { translateRunEvent } from '../../src/hermes/live/translate.ts'
import { z } from 'zod'
import { event, hello, initialTime, setup } from '../hermes/bridge/helpers.ts'

let env: ReturnType<typeof setup>
let outbox: ApprovalOutbox
let port: ReturnType<typeof createHermesPort>
let now: number
let cookie: string
let deliver: MockInstance<typeof port.deliverDecision>

beforeEach(async () => {
  env = setup()
  now = initialTime
  port = createHermesPort({ mode: 'fake', fakeSpeed: 1, fakeLoop: false, home: env.home })
  deliver = vi.spyOn(port, 'deliverDecision').mockResolvedValue('applied')
  outbox = new ApprovalOutbox({ db: env.db, ingest: env.ingest, port, clock: () => now })
  // The app uses its own dormant dispatcher; this instance drives attempts explicitly.
  const token = env.app.pairing.createToken()
  const paired = await env.app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token },
  })
  expect(paired.statusCode).toBe(204)
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  await outbox.stop()
  await env.close()
})
function advance(milliseconds: number) {
  now += milliseconds
  env.setNow(now)
}
async function request(
  id: string = randomUUID(),
  overrides: Partial<Parameters<typeof requestRunApproval>[1]> = {},
) {
  const runId = overrides.runId ?? `run-${id}`
  env.db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, credential_generation, status, started_at, updated_at) VALUES (?, 'builder', 'score', 1, 'running', ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(runId, new Date(now).toISOString(), new Date(now).toISOString())
  await env.ingest.submit({
    source: 'test',
    identity: randomUUID(),
    apply: ({ sqlite, now: at }) =>
      requestRunApproval(
        sqlite,
        {
          id,
          profile: 'builder',
          runId,
          requestId: id,
          command: 'rm -rf demo/dist',
          description: 'Remove old output',
          choices: ['once', 'session', 'always', 'deny'],
          ...overrides,
        },
        at,
      ),
  })
  return rows().find((row) => row.request_id === (overrides.requestId ?? id))!.id
}
function rows() {
  return z
    .array(ApprovalRowSchema)
    .parse(env.db.sqlite.prepare('SELECT * FROM approvals ORDER BY rowid').all())
}
function view(id: string) {
  return approvalView(env.db.sqlite, readApprovalRow(env.db.sqlite, id)!, { now })
}
function decide(
  id: string,
  choice: ApprovalChoice = 'once',
  headers = { cookie, 'x-score-client': 'web' },
) {
  return env.app.inject({
    method: 'POST',
    url: `/api/approvals/${id}/decision`,
    headers,
    payload: { choice, note: 'password=planted-secret' },
  })
}
async function intent(
  id: string,
  choice: ApprovalChoice = 'once',
  route: 'port' | 'bridge' = 'port',
) {
  const row = readApprovalRow(env.db.sqlite, id)!
  env.db.sqlite
    .prepare(
      `INSERT INTO approval_deliveries (id, approval_id, choice, route, producer_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)`,
    )
    .run(
      randomUUID(),
      id,
      choice,
      route,
      route === 'bridge' ? row.producer_id : null,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    )
}
async function signalChoice(id: string, choice: ApprovalChoice) {
  const row = readApprovalRow(env.db.sqlite, id)!
  await env.ingest.submit({
    source: 'test',
    identity: randomUUID(),
    apply: ({ sqlite, now: at }) =>
      respondRunApproval(sqlite, row.profile, row.run_id!, row.request_id!, choice, at),
  })
}

const baseEvidence = {
  stage: 'human' as const,
  linked_to: null,
  guardian_verdict: null,
  decision_choice: null,
  closed_reason: null,
  tool_outcome: null,
}
test.each([
  [{}, 'none', 'human_pending', 'pending'],
  [{ stage: 'guardian' }, 'none', 'guardian_evaluating', 'pending'],
  [
    { stage: 'guardian', linked_to: 'human', guardian_verdict: 'deny' },
    'none',
    'escalated',
    'withdrawn',
  ],
  [{ stage: 'guardian', guardian_verdict: 'approve' }, 'none', 'decided', 'approved'],
  [
    { stage: 'guardian', guardian_verdict: 'deny', closed_reason: 'expired' },
    'none',
    'decided',
    'denied',
  ],
  [{ decision_choice: 'once', closed_reason: 'timeout' }, 'none', 'decided', 'approved'],
  [{ decision_choice: 'deny', tool_outcome: 'blocked' }, 'none', 'blocked', 'denied'],
  [{ decision_choice: 'once', tool_outcome: 'ok' }, 'none', 'executed', 'approved'],
  [{ decision_choice: 'once', tool_outcome: 'error' }, 'none', 'blocked', 'approved'],
  [{ closed_reason: 'timeout' }, 'none', 'expired', 'expired'],
  [{ closed_reason: 'cancelled' }, 'none', 'withdrawn', 'withdrawn'],
  [{ closed_reason: 'run_ended' }, 'unknown', 'withdrawn', 'unknown'],
  [{ closed_reason: 'superseded' }, 'delivering', 'withdrawn', 'unknown'],
] as const)('derives evidence %j with %s', (patch, delivery, phase, status) => {
  expect(deriveApproval({ ...baseEvidence, ...patch }, delivery)).toEqual({ phase, status })
})

test('human guard and CSRF; concurrent decisions accept exactly one and include current details', async () => {
  const id = await request()
  expect((await decide(id, 'once', { cookie: '', 'x-score-client': 'web' })).statusCode).toBe(401)
  expect((await decide(id, 'once', { cookie, 'x-score-client': '' })).statusCode).toBe(403)
  const results = await Promise.all([decide(id), decide(id)])
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409])
  const accepted = ApprovalSchema.parse(results.find((r) => r.statusCode === 202)!.json())
  expect(accepted.delivery).toBe('intent')
  expect(accepted.decision).toBeNull()
  expect(
    ApprovalSchema.parse(results.find((r) => r.statusCode === 409)!.json().error.details).id,
  ).toBe(id)
  expect((await decide(id, 'deny')).statusCode).toBe(409)
  expect(readDelivery(env.db.sqlite, id)?.note).toBe('password=[redacted]')
})

test('validation, hidden and missing ids, feature disabled, offered choices', async () => {
  const id = await request('limited', { choices: ['once', 'deny'] })
  expect((await decide(id, 'always')).json().error.code).toBe('validation_error')
  expect((await decide('missing')).statusCode).toBe(404)
  env.db.sqlite.prepare('UPDATE approvals SET visible = 0 WHERE id = ?').run(id)
  expect((await decide(id)).statusCode).toBe(404)
  env.db.sqlite.prepare('UPDATE approvals SET visible = 1 WHERE id = ?').run(id)
  env.disable(['score-runs'])
  expect((await decide(id)).statusCode).toBe(403)
})

test.each(['no_request', 'coalesced', 'inactive_run', 'guardian'] as const)(
  'rejects non-actionable %s',
  async (kind) => {
    const id = await request()
    if (kind === 'no_request')
      env.db.sqlite.prepare('UPDATE approvals SET request_id = NULL WHERE id = ?').run(id)
    if (kind === 'coalesced')
      env.db.sqlite.prepare('UPDATE approvals SET coalesced = 1 WHERE id = ?').run(id)
    if (kind === 'inactive_run') env.db.sqlite.prepare(`UPDATE runs SET status = 'completed'`).run()
    if (kind === 'guardian')
      env.db.sqlite
        .prepare(
          `UPDATE approvals SET stage = 'guardian', phase = 'guardian_evaluating' WHERE id = ?`,
        )
        .run(id)
    expect((await decide(id)).statusCode).toBe(409)
  },
)

test('elsewhere decision arriving during delivery plus not_pending never becomes denial', async () => {
  const id = await request()
  await intent(id)
  deliver.mockImplementationOnce(async () => {
    await signalChoice(id, 'once')
    return 'not_pending'
  })
  await outbox.runOnce()
  expect(view(id)).toMatchObject({
    status: 'approved',
    delivery: 'not_pending',
    decision: { choice: 'once', by: 'elsewhere' },
  })
})
test.each(['before', 'after'] as const)(
  'a matching signal %s applied attributes only confirmed delivery to you',
  async (order) => {
    const id = await request()
    await intent(id)
    if (order === 'before')
      deliver.mockImplementationOnce(async () => {
        await signalChoice(id, 'once')
        return 'applied'
      })
    await outbox.runOnce()
    if (order === 'after') await signalChoice(id, 'once')
    expect(view(id)).toMatchObject({ delivery: 'applied', decision: { choice: 'once', by: 'you' } })
  },
)
test('a mismatching confirmed delivery preserves the recorded decision and becomes unknown', async () => {
  const id = await request()
  await intent(id)
  deliver.mockImplementationOnce(async () => {
    await signalChoice(id, 'deny')
    return 'applied'
  })
  await outbox.runOnce()
  expect(view(id)).toMatchObject({
    status: 'denied',
    delivery: 'unknown',
    decision: { choice: 'deny', by: 'elsewhere' },
  })
})

test.each(['intent', 'delivering'] as const)(
  'restart recovers %s; uncertain delivery cannot become not_pending',
  async (state) => {
    const id = await request()
    await intent(id)
    env.db.sqlite
      .prepare('UPDATE approval_deliveries SET state = ? WHERE approval_id = ?')
      .run(state, id)
    deliver.mockResolvedValueOnce(state === 'intent' ? 'applied' : 'not_pending')
    await outbox.start()
    await outbox.runOnce()
    expect(view(id).delivery).toBe(state === 'intent' ? 'applied' : 'unknown')
    if (state === 'delivering') expect(readDelivery(env.db.sqlite, id)?.maybe_applied).toBe(1)
  },
)
test('lost response then not_pending remains unknown', async () => {
  const id = await request()
  await intent(id)
  deliver
    .mockRejectedValueOnce(new ApprovalDeliveryError('transport_error', true, true))
    .mockResolvedValueOnce('not_pending')
  await outbox.runOnce()
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    state: 'intent',
    maybe_applied: 1,
    cycle_attempts: 1,
  })
  advance(1000)
  await outbox.runOnce()
  expect(view(id)).toMatchObject({ delivery: 'unknown', decision: null, status: 'pending' })
})
test('never-sent failures exhaust four attempts; manual retry keeps choice and starts a new cycle', async () => {
  const id = await request()
  await intent(id)
  deliver.mockRejectedValue(new ApprovalDeliveryError('transport_error', false, true))
  for (const delay of [0, 1000, 5000, 30_000]) {
    advance(delay)
    await outbox.runOnce()
  }
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    state: 'failed',
    maybe_applied: 0,
    cycle_attempts: 4,
  })
  expect((await decide(id, 'deny')).statusCode).toBe(409)
  expect((await decide(id)).statusCode).toBe(202)
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    state: 'intent',
    cycle: 2,
    cycle_attempts: 0,
  })
})
test('expired intentions are never dispatched, and late choices beat closure', async () => {
  const id = await request('expired', { expiresAt: new Date(now + 1000).toISOString() })
  await intent(id)
  advance(1000)
  await env.ingest.submit({
    source: 'test',
    identity: randomUUID(),
    apply: ({ sqlite, now: at }) => expireApprovals(sqlite, at),
  })
  await outbox.runOnce()
  expect(deliver).not.toHaveBeenCalled()
  expect(view(id)).toMatchObject({ phase: 'expired', delivery: 'failed' })
  await signalChoice(id, 'once')
  expect(view(id)).toMatchObject({
    phase: 'decided',
    status: 'approved',
    decision: { by: 'elsewhere' },
  })
})

async function send(
  token: string,
  counter: number,
  hook: string,
  payload: Record<string, unknown>,
  sessionKey = 'gateway-session',
) {
  const response = await env.send(token, [{ ...event(counter, hook, payload), sessionKey }])
  expect(response.statusCode).toBe(200)
}
test.each(['gateway', 'sse-first', 'hooks-first'] as const)(
  'guardian escalation with exact gate ids: %s',
  async (order) => {
    const token = await env.token()
    const session = order === 'gateway' ? 'gateway-session' : 'score-run'
    if (order !== 'gateway')
      env.db.sqlite
        .prepare(
          `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'builder', 'score', 'running', ?, ?)`,
        )
        .run(session, new Date(now).toISOString(), new Date(now).toISOString())
    if (order === 'sse-first') await request('human', { runId: session })
    await send(
      token,
      1,
      'pre_approval_request',
      { surface: 'smart', gateId: 'guardian', command: 'rm', description: 'Guardian evaluates' },
      session,
    )
    await send(
      token,
      2,
      'pre_approval_request',
      {
        surface: 'gateway',
        gateId: 'human-gate',
        linkedGateId: 'guardian',
        requestId: 'human',
        command: 'rm',
      },
      session,
    )
    if (order === 'hooks-first') await request('human', { runId: session })
    const [guardian] = rows().filter((r) => r.stage === 'guardian')
    const [human] = rows().filter((r) => r.stage === 'human')
    expect(rows()).toHaveLength(2)
    expect(view(guardian!.id)).toMatchObject({ phase: 'escalated', linkedTo: human!.id })
    expect(view(human!.id).actionable).toBe(true)
  },
)
test('guardian deny override; approved/denied guardian alone; identical commands and reused tool ids stay distinct', async () => {
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', {
    surface: 'smart',
    gateId: 'smart-1',
    command: 'identical',
  })
  await send(token, 2, 'post_approval_response', {
    surface: 'smart',
    gateId: 'smart-1',
    choice: 'smart_deny',
  })
  expect(view(rows()[0]!.id)).toMatchObject({
    phase: 'decided',
    decision: { by: 'guardian', choice: 'deny' },
  })
  await send(token, 3, 'pre_approval_request', {
    surface: 'gateway',
    gateId: 'human-1',
    linkedGateId: 'smart-1',
    requestId: 'request-1',
  })
  await send(token, 4, 'pre_approval_request', {
    surface: 'smart',
    gateId: 'smart-2',
    command: 'different',
  })
  await send(token, 5, 'post_approval_response', {
    surface: 'smart',
    gateId: 'smart-2',
    choice: 'smart_approve',
  })
  await send(token, 6, 'pre_approval_request', {
    surface: 'gateway',
    gateId: 'human-2',
    requestId: 'request-2',
    command: 'identical',
  })
  expect(rows()).toHaveLength(4)
  expect(view(rows()[0]!.id).linkedTo).toBe(rows()[1]!.id)
  expect(view(rows()[1]!.id).choices).toEqual(['once', 'deny'])
  expect(view(rows()[2]!.id)).toMatchObject({
    linkedTo: null,
    decision: { by: 'guardian', choice: 'once' },
  })
})
test('out-of-order post and guardian link replay when exact keys appear; hidden targets never leak', async () => {
  const token = await env.token()
  await send(token, 3, 'post_approval_response', { gateId: 'human-gate', choice: 'once' })
  expect(rows()).toHaveLength(0)
  await send(token, 2, 'pre_approval_request', {
    gateId: 'human-gate',
    linkedGateId: 'smart-gate',
    requestId: 'request-1',
  })
  expect(view(rows()[0]!.id).decision?.by).toBe('elsewhere')
  await send(token, 1, 'pre_approval_request', { gateId: 'smart-gate', surface: 'smart' })
  expect(view(rows()[1]!.id)).toMatchObject({ phase: 'escalated', linkedTo: rows()[0]!.id })
  await request('seed', { runId: 'score-run' })
  await send(
    token,
    4,
    'pre_approval_request',
    { gateId: 'hidden', linkedGateId: 'smart-gate' },
    'score-run',
  )
  const snapshot = (await env.app.inject('/api/approvals?status=all')).json()
  expect(
    snapshot.items.every(
      (item: { id: string }) => item.id !== rows().find((r) => r.gate_id === 'hidden')?.id,
    ),
  ).toBe(true)
  expect(
    env.db.sqlite
      .prepare('SELECT count(*) AS count FROM approval_signals WHERE matched_approval_id IS NULL')
      .get(),
  ).toEqual({ count: 0 })
})
test('coalesced followers remain view-only and are superseded by fresh exact prompts', async () => {
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', {
    gateId: 'follower',
    requestId: 'leader-request',
    coalesced: true,
  })
  const follower = rows()[0]!.id
  expect((await decide(follower)).statusCode).toBe(409)
  await send(token, 2, 'pre_approval_request', {
    gateId: 'fresh',
    requestId: 'fresh-request',
    supersedesGateId: 'follower',
  })
  expect(view(follower)).toMatchObject({ phase: 'withdrawn', status: 'withdrawn' })
  expect(view(rows()[1]!.id).actionable).toBe(true)
})
test('transport ids never become gateway targets; missing gates stay unmatched', async () => {
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', {
    surface: 'transport:telegram',
    gateId: 'transport',
    request_id: 'transport-raw',
    transportRequestId: 'transport-1',
  })
  expect(rows()[0]).toMatchObject({
    target_kind: 'transport',
    request_id: null,
    transport_request_id: 'transport-1',
  })
  expect((await decide(rows()[0]!.id)).statusCode).toBe(409)
  await send(token, 2, 'post_approval_response', {
    transportRequestId: 'transport-1',
    choice: 'once',
  })
  expect(view(rows()[0]!.id).decision?.by).toBe('elsewhere')
  await send(token, 3, 'pre_approval_request', { requestId: 'unproven' })
  expect(rows()).toHaveLength(1)
})
test('gone producers and observe-only hello reject decisions; polls refresh liveness', async () => {
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', { gateId: 'human', requestId: 'request-1' })
  const id = rows()[0]!.id
  advance(120_001)
  expect((await decide(id)).statusCode).toBe(409)
  expect(
    (await env.app.inject({ url: '/bridge/v1/decisions?wait=0', headers: env.headers(token) }))
      .statusCode,
  ).toBe(200)
  expect(view(id).actionable).toBe(true)
  await env.token({ ...hello, isolation: 'host' })
  expect((await decide(id)).statusCode).toBe(409)
})
test.each(['sse-first', 'hook-first'] as const)(
  'recorded L4A request dedupes in %s order',
  async (order) => {
    const fixture = z
      .array(z.record(z.string(), z.unknown()))
      .parse(
        JSON.parse(
          readFileSync(new URL('../fixtures/hermes/l4a-run-events.json', import.meta.url), 'utf8'),
        ),
      )
    const approval = fixture.find((item) => item.event === 'approval.request')!
    const runId = String(approval.run_id)
    env.db.sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, credential_generation, status, started_at, updated_at) VALUES (?, 'builder', 'score', 1, 'running', ?, ?)`,
      )
      .run(runId, new Date(now).toISOString(), new Date(now).toISOString())
    const token = await env.token()
    const hook = () =>
      send(
        token,
        1,
        'pre_approval_request',
        { ...approval, gateId: 'recorded-gate', requestId: approval.request_id },
        runId,
      )
    const sse = () =>
      env.ingest.submit(
        translateRunEvent({ profile: 'builder', runId, credentialGeneration: 1 }, approval, {
          unknownEvents: 0,
        }),
      )
    if (order === 'sse-first') {
      await sse()
      await hook()
    } else {
      await hook()
      await sse()
    }
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      origin: 'score-run',
      gate_id: 'recorded-gate',
      request_id: approval.request_id,
    })
    expect(
      env.db.sqlite
        .prepare(`SELECT count(*) AS count FROM events WHERE type = 'approval.requested'`)
        .get(),
    ).toEqual({ count: 1 })
  },
)
test('post after a closure refines evidence, newest human receives informational tool outcome', async () => {
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', { gateId: 'first', requestId: 'request-1' })
  await send(token, 2, 'post_approval_response', { gateId: 'first', choice: 'timeout' })
  await send(token, 3, 'post_approval_response', { gateId: 'first', choice: 'once' })
  expect(view(rows()[0]!.id)).toMatchObject({ phase: 'decided', decision: { by: 'elsewhere' } })
  await send(token, 4, 'pre_approval_request', { gateId: 'second', requestId: 'request-2' })
  await send(token, 5, 'post_tool_call', {
    tool_name: 'terminal',
    result: { status: 'blocked' },
    status: 'error',
  })
  expect(rows()[0]!.tool_outcome).toBeNull()
  expect(rows()[1]).toMatchObject({
    phase: 'human_pending',
    tool_outcome: 'blocked',
    decision_choice: null,
  })
  await send(token, 6, 'post_approval_response', { gateId: 'second', choice: 'deny' })
  expect(view(rows()[1]!.id)).toMatchObject({ phase: 'blocked', status: 'denied' })
})
test('cursor paging uses descending stable ties, visible rows, phase filter, and event watermark', async () => {
  for (let i = 0; i < 55; i++) await request(`id-${String(i).padStart(2, '0')}`)
  await signalChoice('id-54', 'deny')
  const first = (await env.app.inject('/api/approvals?status=all&agent=builder')).json()
  expect(first.items).toHaveLength(50)
  expect(first.items[0].id).toBe('id-54')
  const second = (
    await env.app.inject(`/api/approvals?status=all&cursor=${first.nextCursor}`)
  ).json()
  expect(second.items).toHaveLength(5)
  expect(
    new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)).size,
  ).toBe(55)
  expect(second.nextCursor).toBeNull()
  expect(first.asOfSeq).toBe(env.db.sqlite.prepare('SELECT max(seq) AS seq FROM events').get()?.seq)
  expect((await env.app.inject('/api/approvals?cursor=bad')).statusCode).toBe(400)
  expect((await env.app.inject('/api/approvals?status=invalid')).statusCode).toBe(400)
})

test('conflicting signal after applied refines the same way as signal before applied', async () => {
  const id = await request()
  await intent(id)
  await outbox.runOnce()
  await signalChoice(id, 'deny')
  expect(view(id)).toMatchObject({
    delivery: 'unknown',
    decision: { choice: 'deny', by: 'elsewhere' },
    status: 'denied',
  })
  expect(readDelivery(env.db.sqlite, id)?.maybe_applied).toBe(1)
})
test('intent, delivering, and applied events each commit with their delivery projection', async () => {
  const id = await request()
  const posted = await decide(id)
  expect(posted.statusCode).toBe(202)
  deliver.mockImplementationOnce(async () => {
    expect(readDelivery(env.db.sqlite, id)?.state).toBe('delivering')
    const data = JSON.parse(
      String(
        env.db.sqlite
          .prepare(
            `SELECT data FROM events WHERE type = 'approval.updated' ORDER BY seq DESC LIMIT 1`,
          )
          .get()!.data,
      ),
    )
    expect(data.delivery).toBe('delivering')
    expect(data.decision).toBeNull()
    return 'applied'
  })
  await outbox.runOnce()
  const updates = env.db.sqlite
    .prepare(`SELECT data FROM events WHERE type = 'approval.updated' ORDER BY seq`)
    .all()
    .map((row) => JSON.parse(String(row.data)))
  expect(updates.map((row) => row.delivery)).toEqual(['intent', 'delivering', 'applied'])
  expect(updates.at(-1).decision.by).toBe('you')
})

test('a hidden gate becomes visible when it gains an exact request key, retaining its evidence and link', async () => {
  await request('seed-run', { runId: 'score-run' })
  const token = await env.token()
  await send(
    token,
    1,
    'pre_approval_request',
    { surface: 'smart', gateId: 'guardian-hidden' },
    'score-run',
  )
  await send(
    token,
    2,
    'pre_approval_request',
    { gateId: 'human-hidden', linkedGateId: 'guardian-hidden' },
    'score-run',
  )
  const hidden = rows().find((row) => row.gate_id === 'human-hidden')!
  const guardian = rows().find((row) => row.gate_id === 'guardian-hidden')!
  expect(hidden.visible).toBe(0)
  expect(view(guardian.id).linkedTo).toBeNull()
  await send(
    token,
    3,
    'post_approval_response',
    { gateId: 'human-hidden', choice: 'once' },
    'score-run',
  )
  await send(
    token,
    4,
    'pre_approval_request',
    { gateId: 'human-hidden', requestId: 'proven-request', linkedGateId: 'guardian-hidden' },
    'score-run',
  )
  expect(view(hidden.id)).toMatchObject({
    decision: { by: 'elsewhere', choice: 'once' },
    status: 'approved',
  })
  expect(view(guardian.id)).toMatchObject({ phase: 'escalated', linkedTo: hidden.id })
  const requested = env.db.sqlite
    .prepare(`SELECT data FROM events WHERE type = 'approval.requested'`)
    .all()
    .map((row) => JSON.parse(String(row.data)))
  expect(requested.filter((row) => row.id === hidden.id)).toHaveLength(1)
})
test('bridge feature gating and producer expiry are computed for visible events', async () => {
  const token = await env.token()
  env.disable(['gateway-approvals'])
  const expiry = now + 5000
  await send(token, 1, 'pre_approval_request', {
    gateId: 'gated-human',
    requestId: 'request-gated',
    expires_at: expiry / 1000,
  })
  const event = JSON.parse(
    String(
      env.db.sqlite.prepare(`SELECT data FROM events WHERE type = 'approval.requested'`).get()!
        .data,
    ),
  )
  expect(event).toMatchObject({ actionable: false, expiresAt: new Date(expiry).toISOString() })
})

test('a hidden hook stage folds into its visible run card when a later signal proves the request (review #1)', async () => {
  const id = await request('proven-request', { runId: 'score-run' })
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', { gateId: 'hook-gate' }, 'score-run')
  await send(
    token,
    2,
    'post_approval_response',
    { gateId: 'hook-gate', choice: 'deny' },
    'score-run',
  )
  expect(rows().filter((row) => row.visible === 0)).toHaveLength(1)
  expect(view(id)).toMatchObject({ phase: 'human_pending', decision: null })
  await send(
    token,
    3,
    'post_approval_response',
    { gateId: 'hook-gate', requestId: 'proven-request', choice: 'deny' },
    'score-run',
  )
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toMatchObject({ id, gate_id: 'hook-gate', visible: 1 })
  expect(view(id)).toMatchObject({
    phase: 'decided',
    status: 'denied',
    decision: { choice: 'deny', by: 'elsewhere' },
  })
})

test('a pre hook proving the request also folds the hidden stage, keeping one card (review #1)', async () => {
  const id = await request('proven-request', { runId: 'score-run' })
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', { gateId: 'hook-gate' }, 'score-run')
  await send(
    token,
    2,
    'post_approval_response',
    { gateId: 'hook-gate', choice: 'once' },
    'score-run',
  )
  await send(
    token,
    3,
    'pre_approval_request',
    { gateId: 'hook-gate', requestId: 'proven-request' },
    'score-run',
  )
  expect(rows()).toHaveLength(1)
  expect(view(id)).toMatchObject({ status: 'approved', decision: { by: 'elsewhere' } })
  const requested = env.db.sqlite
    .prepare(`SELECT data FROM events WHERE type = 'approval.requested'`)
    .all()
    .map((row) => JSON.parse(String(row.data)) as { id: string })
  expect(requested.map((row) => row.id)).toEqual([id])
})

test('a tool completion ingested before its gate is claimed when the gate appears (review #3)', async () => {
  const token = await env.token()
  await send(token, 3, 'post_tool_call', { tool_name: 'terminal', result: { output: 'ok' } })
  await send(token, 1, 'pre_approval_request', { gateId: 'late-gate', requestId: 'request-late' })
  await send(token, 2, 'post_approval_response', { gateId: 'late-gate', choice: 'once' })
  expect(view(rows()[0]!.id)).toMatchObject({ phase: 'executed', status: 'approved' })
})

test('approval.responded without a request id is ignored by the ledger, not fatal (review #2)', () => {
  const observation = translateRunEvent(
    { profile: 'builder', runId: 'run-x', credentialGeneration: 1 },
    {
      event: 'approval.responded',
      run_id: 'run-x',
      seq: 9,
      timestamp: initialTime / 1000,
      choice: 'once',
      resolved: 1,
    },
    { unknownEvents: 0 },
  )
  expect(observation.identity).toBe('sse:run-x:9')
})
