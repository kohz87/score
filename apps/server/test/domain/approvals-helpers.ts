import type { ApprovalChoice } from '@score/contract'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest'
import { ApprovalOutbox } from '../../src/domain/approval-outbox.ts'
import { requestRunApproval, respondRunApproval } from '../../src/domain/approvals.ts'
import {
  ApprovalRowSchema,
  approvalView,
  readApprovalRow,
} from '../../src/domain/approval-store.ts'
import { createHermesPort } from '../../src/hermes/index.ts'
import { z } from 'zod'
import { event, initialTime, setup } from '../hermes/bridge/helpers.ts'

export let env: ReturnType<typeof setup>
export let outbox: ApprovalOutbox
let port: ReturnType<typeof createHermesPort>
export let now: number
export let cookie: string
export let deliver: MockInstance<typeof port.deliverDecision>

export function installApprovalHarness() {
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
}

export function advance(milliseconds: number) {
  now += milliseconds
  env.setNow(now)
}

export async function request(
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

export function rows() {
  return z
    .array(ApprovalRowSchema)
    .parse(env.db.sqlite.prepare('SELECT * FROM approvals ORDER BY rowid').all())
}

export function view(id: string) {
  return approvalView(env.db.sqlite, readApprovalRow(env.db.sqlite, id)!, { now })
}

export function decide(
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

export async function intent(
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

export async function signalChoice(id: string, choice: ApprovalChoice) {
  const row = readApprovalRow(env.db.sqlite, id)!
  await env.ingest.submit({
    source: 'test',
    identity: randomUUID(),
    apply: ({ sqlite, now: at }) =>
      respondRunApproval(sqlite, row.profile, row.run_id!, row.request_id!, choice, at),
  })
}

export async function send(
  token: string,
  counter: number,
  hook: string,
  payload: Record<string, unknown>,
  sessionKey = 'gateway-session',
) {
  const response = await env.send(token, [{ ...event(counter, hook, payload), sessionKey }])
  expect(response.statusCode).toBe(200)
}
