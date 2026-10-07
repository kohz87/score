import { ApprovalSchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { afterEach, expect, test } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../../../../src/app.ts'
import { loadConfig } from '../../../../src/config.ts'
import { ApprovalOutbox } from '../../../../src/domain/approval-outbox.ts'
import { LivePort } from '../../../../src/hermes/live/live-port.ts'
import { translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import { setup } from './helpers.ts'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

test('recorded run SSE → human decision API → durable outbox → exact live gateway receipt', async () => {
  const env = setup()
  const sent: { request_id: string; choice: string }[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/approval')) {
      sent.push(
        z
          .object({ request_id: z.string(), choice: z.string() })
          .parse(JSON.parse(String(init?.body))),
      )
      expect(new Headers(init?.headers).has('authorization')).toBe(true)
      return new Response(JSON.stringify({ resolved: 1 }), { status: 200 })
    }
    return env.fake.fetch(url, init)
  }
  const port = new LivePort({
    scoreHome: env.home,
    db: env.db,
    hermesHome: `${env.home}/missing`,
    fetch,
    readCliVersion: async () => null,
  })
  const outbox = new ApprovalOutbox({ db: env.db, ingest: env.ingest, port })
  const app = buildApp({
    config: loadConfig({ SCORE_HOME: env.home, SCORE_MODE: 'live' }),
    port,
    outbox,
    db: env.db,
    ingest: env.ingest,
    logger: false,
  })
  cleanup = async () => {
    await outbox.stop()
    await port.stop()
    await app.close()
    await env.ingest.close()
    env.db.close()
    rmSync(env.home, { recursive: true, force: true })
  }
  await port.start(env.ingest)
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture turn' },
    randomUUID(),
  )
  const fixture = z
    .array(z.record(z.string(), z.unknown()))
    .parse(
      JSON.parse(
        readFileSync(
          new URL('../../../fixtures/hermes/l4a-run-events.json', import.meta.url),
          'utf8',
        ),
      ),
    )
  const approvalEvent = fixture.find((entry) => entry.event === 'approval.request')!
  await env.ingest.submit(
    translateRunEvent(
      { profile: 'builder', runId, credentialGeneration: 1 },
      { ...approvalEvent, run_id: runId, timestamp: Date.now() / 1000 },
      { unknownEvents: 0 },
    ),
  )
  const snapshot = (await app.inject('/api/approvals')).json()
  expect(snapshot.items).toHaveLength(1)
  const approval = ApprovalSchema.parse(snapshot.items[0])
  expect(approval.actionable).toBe(true)
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  const cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
  const response = await app.inject({
    method: 'POST',
    url: `/api/approvals/${approval.id}/decision`,
    headers: { cookie, 'x-score-client': 'web' },
    payload: { choice: 'deny' },
  })
  expect(response.statusCode).toBe(202)
  expect(response.json().decision).toBeNull()
  expect(response.json().delivery).toBe('intent')
  await outbox.runOnce()
  expect(sent).toEqual([{ choice: 'deny', request_id: approvalEvent.request_id }])
  const decided = ApprovalSchema.parse(
    (await app.inject('/api/approvals?status=all')).json().items[0],
  )
  expect(decided).toMatchObject({
    phase: 'decided',
    status: 'denied',
    actionable: false,
    delivery: 'applied',
    decision: { by: 'you', choice: 'deny' },
  })
})
