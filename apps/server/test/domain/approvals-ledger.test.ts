import { expect, test, vi } from 'vitest'
import { readApprovalRow, readDelivery } from '../../src/domain/approval-store.ts'
import { translateRunEvent } from '../../src/hermes/live/translate.ts'
import { hello, initialTime } from '../hermes/bridge/helpers.ts'
import {
  advance,
  cookie,
  decide,
  deliver,
  env,
  installApprovalHarness,
  intent,
  now,
  outbox,
  request,
  rows,
  send,
  signalChoice,
  view,
} from './approvals-helpers.ts'

installApprovalHarness()

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
  await send(token, 3, 'post_tool_call', {
    gateIds: ['late-gate'],
    tool_name: 'terminal',
    result: { output: 'ok' },
  })
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

test.each(['same-session', 'different-session'] as const)(
  'gate #3 repeated tool IDs across %s complete only the listed gates',
  async (scenario) => {
    const token = await env.token()
    const otherSession = scenario === 'same-session' ? 'session-a' : 'session-b'
    await send(
      token,
      1,
      'pre_approval_request',
      { gateId: 'gate-a', requestId: 'request-a' },
      'session-a',
    )
    await send(
      token,
      2,
      'pre_approval_request',
      { gateId: 'gate-b', requestId: 'request-b' },
      otherSession,
    )
    await send(
      token,
      3,
      'post_tool_call',
      { tool_name: 'terminal', result: 'ok', gateIds: ['gate-a'] },
      'session-a',
    )
    expect(rows().find((row) => row.gate_id === 'gate-a')?.tool_outcome).toBe('ok')
    expect(rows().find((row) => row.gate_id === 'gate-b')?.tool_outcome).toBeNull()
    await send(token, 4, 'post_tool_call', { tool_name: 'terminal', result: 'ok' }, otherSession)
    expect(rows().find((row) => row.gate_id === 'gate-b')?.tool_outcome).toBeNull()
  },
)

test('gate #3 delayed completion evidence pairs only by producer incarnation and gate, regardless of tool reuse', async () => {
  const token = await env.token()
  await send(
    token,
    5,
    'post_tool_call',
    { gateIds: ['gate-a', 'gate-c'], result: 'ok' },
    'session-a',
  )
  await send(
    token,
    2,
    'pre_approval_request',
    { gateId: 'gate-b', requestId: 'request-b' },
    'session-b',
  )
  await send(
    token,
    1,
    'pre_approval_request',
    { gateId: 'gate-a', requestId: 'request-a' },
    'session-a',
  )
  await send(
    token,
    3,
    'pre_approval_request',
    { gateId: 'gate-c', requestId: 'request-c' },
    'session-a',
  )
  const other = await env.token({ ...hello, incarnation: 'another-process' })
  await send(
    other,
    1,
    'pre_approval_request',
    { gateId: 'gate-a', requestId: 'another-request' },
    'session-a',
  )
  expect(rows().map((row) => [row.request_id, row.tool_outcome])).toEqual([
    ['request-b', null],
    ['request-a', 'ok'],
    ['request-c', 'ok'],
    ['another-request', null],
  ])
})

test('gate #12 keyed approval retry returns the original 202 and body, different body conflicts', async () => {
  const id = await request('receipt-approval')
  const headers = { cookie, 'x-score-client': 'web', 'idempotency-key': 'decision-retry' }
  const [first, concurrent] = await Promise.all([
    decide(id, 'once', headers),
    decide(id, 'once', headers),
  ])
  expect(first.statusCode).toBe(202)
  expect(concurrent.statusCode).toBe(202)
  expect(concurrent.json()).toEqual(first.json())
  expect((await decide(id, 'once', headers)).json()).toEqual(first.json())
  const conflict = await decide(id, 'deny', headers)
  expect(conflict.statusCode).toBe(409)
  expect(conflict.json().error.code).toBe('idempotency_conflict')
  expect(
    env.db.sqlite
      .prepare("SELECT count(*) AS n FROM ingest_keys WHERE source = 'approval-decision'")
      .get()?.n,
  ).toBe(1)
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM approval_deliveries').get()?.n).toBe(1)
})

test('gate #13 idle delivery sweeps and startup do not allocate observation keys', async () => {
  const before = env.db.sqlite.prepare('SELECT count(*) AS n FROM ingest_keys').get()?.n
  await outbox.start()
  for (let i = 0; i < 20; i++) await outbox.sweep()
  await outbox.runOnce()
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM ingest_keys').get()?.n).toBe(before)
  const id = await request('future-delivery')
  await intent(id)
  const withIntent = env.db.sqlite.prepare('SELECT count(*) AS n FROM ingest_keys').get()?.n
  await outbox.sweep()
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM ingest_keys').get()?.n).toBe(withIntent)
})

test('gate #13 expiry sweep reads first and records only due changes', async () => {
  const { sweepExpiredApprovals } = await import('../../src/domain/approval-expiry.ts')
  const submit = vi.spyOn(env.ingest, 'submit')
  await sweepExpiredApprovals(env.db, env.ingest, () => now)
  expect(submit).not.toHaveBeenCalled()
  const id = await request('expires-later', { expiresAt: new Date(now + 1000).toISOString() })
  submit.mockClear()
  await sweepExpiredApprovals(env.db, env.ingest, () => now)
  expect(submit).not.toHaveBeenCalled()
  advance(1000)
  await sweepExpiredApprovals(env.db, env.ingest, () => now)
  expect(submit).toHaveBeenCalledOnce()
  expect(readApprovalRow(env.db.sqlite, id)?.closed_reason).toBe('expired')
  await sweepExpiredApprovals(env.db, env.ingest, () => now)
  expect(submit).toHaveBeenCalledOnce()
  submit.mockRestore()
})

test('gate #3 stored completion also pairs when a gate attaches to an existing run-SSE approval', async () => {
  const id = await request('preexisting-request', { runId: 'preexisting-run' })
  const token = await env.token()
  await send(
    token,
    3,
    'post_tool_call',
    { gateIds: ['attached-gate'], result: 'ok' },
    'preexisting-run',
  )
  await send(
    token,
    1,
    'pre_approval_request',
    { gateId: 'attached-gate', requestId: 'preexisting-request' },
    'preexisting-run',
  )
  expect(rows()).toHaveLength(1)
  expect(readApprovalRow(env.db.sqlite, id)).toMatchObject({
    gate_id: 'attached-gate',
    tool_outcome: 'ok',
  })
})
