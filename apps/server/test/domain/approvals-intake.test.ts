import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { translateRunEvent } from '../../src/hermes/live/translate.ts'
import { z } from 'zod'
import { hello } from '../hermes/bridge/helpers.ts'
import {
  advance,
  decide,
  env,
  installApprovalHarness,
  now,
  request,
  rows,
  send,
  view,
} from './approvals-helpers.ts'

installApprovalHarness()

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
test('post after a closure refines evidence, exact human gate receives informational tool outcome', async () => {
  const token = await env.token()
  await send(token, 1, 'pre_approval_request', { gateId: 'first', requestId: 'request-1' })
  await send(token, 2, 'post_approval_response', { gateId: 'first', choice: 'timeout' })
  await send(token, 3, 'post_approval_response', { gateId: 'first', choice: 'once' })
  expect(view(rows()[0]!.id)).toMatchObject({ phase: 'decided', decision: { by: 'elsewhere' } })
  await send(token, 4, 'pre_approval_request', { gateId: 'second', requestId: 'request-2' })
  await send(token, 5, 'post_tool_call', {
    gateIds: ['second'],
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
