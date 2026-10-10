import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  GlobalFenceSchema,
  OrchestrationCreatedSchema,
  OrchestrationListSchema,
  OrchestrationSnapshotSchema,
  OrchestrationSummarySchema,
  PreflightSchema,
  ORCH_ACKNOWLEDGEMENT_TEXT,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp, buildBridgeApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
let app: FastifyInstance
let bridge: FastifyInstance
let headers: { 'x-score-client': string; cookie: string }
let bridgeUrl: URL
let capability = ''
const closers: (() => Promise<unknown>)[] = []

async function boot(lead?: NonNullable<Parameters<typeof harness>[0]>['lead']) {
  h = await harness(lead ? { lead } : {})
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: `${h.dir}/home` }),
    logger: false,
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    clock: () => h.scheduler.now(),
    orchestrator: h.orch,
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
  bridge = buildBridgeApp(undefined, undefined, false, {
    db: h.db,
    access: h.access,
    ingest: h.ingest,
    port: { taskAction: async () => ({ hermesStatus: 'running' }) },
    orchestrator: h.orch,
    clock: () => h.scheduler.now(),
  })
  await bridge.listen({ host: '127.0.0.1', port: 0 })
  const address = bridge.server.address()
  bridgeUrl = new URL(
    `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/bridge/mcp`,
  )
}
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  await bridge?.close()
  await app?.close()
  await h?.close()
  h = undefined as never
})

const get = (url: string) => app.inject({ method: 'GET', url, headers })
const post = (url: string, payload: object = {}, authed = true, key?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: authed
      ? { ...headers, ...(key ? { 'idempotency-key': key } : {}) }
      : { 'x-score-client': 'web' },
    payload,
  })
const createBody = (extra: object = {}) => ({
  goal: 'Write the release notes',
  leadAgentId: 'lead',
  allowedAgents: ['builder', 'reviewer'],
  gatePolicy: 'every-step',
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  ...extra,
})
const status = (id: string) => h.orch.summary(id).status
const detail = (id: string) => h.orch.snapshot(id).orchestration

beforeEach(() => {
  capability = ''
})

test('preflight, create, list and snapshot follow the contract', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
      },
    }),
  })
  const preflight = PreflightSchema.parse(
    (
      await get('/api/orchestrations/preflight?leadAgentId=lead&allowedAgents=builder,reviewer')
    ).json(),
  )
  expect(preflight.ok).toBe(true)
  expect(preflight.checks.map((c) => c.id)).toContain('tool_readiness')
  const bad = PreflightSchema.parse(
    (await get('/api/orchestrations/preflight?leadAgentId=lead&allowedAgents=lead')).json(),
  )
  expect(bad.ok).toBe(false)
  expect(bad.checks.find((c) => c.id === 'allowed_agents')!.message).toContain(
    'cannot also do steps',
  )

  expect((await post('/api/orchestrations', createBody(), false)).statusCode).toBe(401)
  expect(
    (await post('/api/orchestrations', createBody({ acknowledgement: { text: 'sure' } })))
      .statusCode,
  ).toBe(400)
  expect(
    (await post('/api/orchestrations', createBody({ allowedAgents: ['lead'] }))).statusCode,
  ).toBe(409)
  const created = await post('/api/orchestrations', createBody(), true, 'k1')
  expect(created.statusCode).toBe(201)
  const body = OrchestrationCreatedSchema.parse(created.json())
  const again = await post('/api/orchestrations', createBody(), true, 'k1')
  expect(OrchestrationCreatedSchema.parse(again.json()).orchestration.id).toBe(
    body.orchestration.id,
  )
  expect(h.orch.list().items).toHaveLength(1)

  await h.until(() => detail(body.orchestration.id).gates.length === 1)
  const list = OrchestrationListSchema.parse((await get('/api/orchestrations')).json())
  expect(list.items[0]!.needsYou).toContainEqual({ kind: 'gate', gateId: 'g1', stepId: 's1' })
  const snap = OrchestrationSnapshotSchema.parse(
    (await get(`/api/orchestrations/${body.orchestration.id}`)).json(),
  )
  expect(snap.asOfSeq).toBeGreaterThan(0)
  expect(snap.orchestration.stepsList[0]!.instruction).toBe('x')
  expect((await get('/api/orchestrations/nope')).statusCode).toBe(404)
  // Events reached the stream log.
  const types = h.rows<{ type: string }>('SELECT DISTINCT type FROM events').map((row) => row.type)
  expect(types).toContain('orchestration.upserted')
  expect(types).toContain('brief.upserted')
})

test('decisions need the paired session and the revision the page showed', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        await t.call('orch.ask', { question: 'q?' })
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody())).json(),
  ).orchestration.id
  await h.until(() => detail(id).gates.length === 1 && detail(id).inquiries.length === 1)
  const rev = detail(id).revision
  const gate = { decision: 'approve', expectedRevision: 1, orchestrationRevision: rev }
  expect((await post(`/api/orchestrations/${id}/gates/g1/decision`, gate, false)).statusCode).toBe(
    401,
  )
  const stale = await post(`/api/orchestrations/${id}/gates/g1/decision`, {
    ...gate,
    orchestrationRevision: rev - 1,
  })
  expect(stale.statusCode).toBe(409)
  expect(stale.json().error.code).toBe('conflict')
  expect(stale.json().error.details.currentRevision).toBe(rev)
  expect(
    (await post(`/api/orchestrations/${id}/gates/g1/decision`, { decision: 'maybe' })).statusCode,
  ).toBe(400)
  const answered = await post(`/api/orchestrations/${id}/inquiries/q1/answer`, {
    answer: 'blue',
    expectedRevision: 1,
    orchestrationRevision: rev,
  })
  expect(answered.statusCode).toBe(200)
  expect(OrchestrationSummarySchema.parse(answered.json()).needsYou).not.toContainEqual({
    kind: 'inquiry',
    inquiryId: 'q1',
  })
  // The gate decision now needs the new run revision.
  const ok = await post(`/api/orchestrations/${id}/gates/g1/decision`, {
    ...gate,
    orchestrationRevision: detail(id).revision,
  })
  expect(ok.statusCode).toBe(200)
  expect(
    (
      await post(`/api/orchestrations/${id}/waiver`, {
        orchestrationRevision: detail(id).revision,
        acknowledge: true,
      })
    ).statusCode,
  ).toBe(409)
  expect(
    (await post(`/api/orchestrations/${id}/pause`, { orchestrationRevision: detail(id).revision }))
      .statusCode,
  ).toBe(200)
  expect(status(id)).toBe('paused')
  expect(
    (await post(`/api/orchestrations/${id}/resume`, { orchestrationRevision: detail(id).revision }))
      .statusCode,
  ).toBe(200)
  // Stop ignores a stale page.
  expect(
    (await post(`/api/orchestrations/${id}/stop`, { orchestrationRevision: 1 })).statusCode,
  ).toBe(200)
  expect(['stopping', 'stopped']).toContain(status(id))
})

test('ownership: ordinary actions on the run room and brief are rejected while the run owns them; brief pause and resume are delegated', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const d = detail(id)
  const room = d.roomId
  const owned = (
    res: {
      statusCode: number
      json(): {
        error: {
          code: string
          details?: { orchestrationId: string; state: string; action: string }
        }
      }
    },
    action: string,
  ) => {
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('orchestration_owned')
    expect(res.json().error.details).toMatchObject({ orchestrationId: id, state: 'owned', action })
  }
  owned(await post(`/api/rooms/${room}/messages`, { text: 'hello @builder' }), 'message.post')
  owned(
    await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room}`,
      headers,
      payload: { name: 'renamed' },
    }),
    'room.update',
  )
  owned(
    await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room}`,
      headers,
      payload: { archived: true },
    }),
    'room.update',
  )
  // Harmless metadata is still the person's.
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room}`,
        headers,
        payload: { pinned: true },
      })
    ).statusCode,
  ).toBe(200)
  owned(
    await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${room}/messages/${d.briefId}`,
      headers,
    }),
    'message.delete',
  )
  owned(await post(`/api/rooms/${room}/summary`), 'summary.create')
  owned(await post(`/api/rooms/${room}/messages/${d.briefId}/retry`), 'message.retry')
  owned(await post(`/api/rooms/${room}/messages/${d.briefId}/stop`), 'message.stop')
  owned(
    await post(`/api/rooms/${room}/messages/${d.briefId}/rewind`, { turns: 1 }),
    'message.rewind',
  )
  owned(await post(`/api/rooms/${room}/messages/${d.briefId}/plan/start`), 'plan.start')
  // The brief's pause and resume are the run's.
  expect((await post(`/api/briefs/${d.briefId}/pause`)).statusCode).toBe(200)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('person')
  expect(
    (await get('/api/briefs')).json().items.find((b: { id: string }) => b.id === d.briefId).status,
  ).toBe('paused')
  expect((await post(`/api/briefs/${d.briefId}/resume`)).statusCode).toBe(200)
  expect(status(id)).toBe('running')
  // Team pause is a separate hold: it never pauses the run's brief, and Team Resume never clears the run's own pause.
  await post(`/api/orchestrations/${id}/pause`, { orchestrationRevision: detail(id).revision })
  expect((await post('/api/team/pause')).statusCode).toBe(200)
  expect(h.rows('SELECT 1 FROM team_paused_briefs WHERE brief_id = ?', d.briefId)).toHaveLength(0)
  expect((await post('/api/team/resume')).statusCode).toBe(200)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('person')
})

test('ownership ends with the run: after a quiescent end the room is an ordinary room again', async () => {
  await boot()
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => status(id) === 'succeeded')
  expect(detail(id).ownership).toBe('released')
  const sent = await post(`/api/rooms/${detail(id).roomId}/messages`, { text: 'thanks' })
  expect(sent.statusCode).toBe(200)
  // A finished run has nothing to pause: the brief controls say so instead of acting.
  expect((await post(`/api/briefs/${detail(id).briefId}/pause`)).statusCode).toBe(409)
})

test('draining keeps the guards: a finished run with an owed Stop still owns its room', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        await t.call('orch.finish', { outcome: 'success', summary: 'x' })
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const run = attemptOf(h, id, 'step', 's1')[0]!.runId!
  const { endRun } = await import('./harness.ts')
  await endRun(h, run, 'interrupted')
  await h.until(() => status(id) === 'finished_with_unresolved')
  expect(detail(id).ownership).toBe('draining')
  const blocked = await post(`/api/rooms/${detail(id).roomId}/messages`, { text: 'hi' })
  expect(blocked.statusCode).toBe(409)
  expect(blocked.json().error.details.state).toBe('draining')
  // Abandoning the step and the owed Stop's acknowledgement release the room.
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  const abandoned = await post(`/api/orchestrations/${id}/abandon`, {
    attemptIds: [s1.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(abandoned.statusCode).toBe(200)
  await h.until(() => detail(id).ownership === 'released')
  await h.settle(300)
  expect(
    h
      .rows<{ detail: string }>(
        "SELECT detail FROM orc_history WHERE kind = 'ownership' ORDER BY id",
      )
      .map((row) => JSON.parse(row.detail).state),
  ).toEqual(['owned', 'draining', 'released'])
  expect(
    (await post(`/api/rooms/${detail(id).roomId}/messages`, { text: 'hi again' })).statusCode,
  ).toBe(200)
})

test('the fence routes: read, and lift needs a reviewed list and the current revision', async () => {
  await boot()
  expect(GlobalFenceSchema.parse((await get('/api/orchestrations/fence')).json()).fenced).toBe(
    false,
  )
  h.fence.set('journal_mismatch', [
    { kind: 'attempt', ref: 'ghost', journalN: 7, detail: 'in the journal only' },
  ])
  const fence = GlobalFenceSchema.parse((await get('/api/orchestrations/fence')).json())
  expect(fence).toMatchObject({
    fenced: true,
    reason: 'journal_mismatch',
    items: [{ kind: 'attempt', ref: 'ghost' }],
  })
  expect((await post('/api/orchestrations', createBody())).statusCode).toBe(409)
  expect((await post('/api/orchestrations', createBody())).json().error.code).toBe('fenced')
  expect(
    (
      await post('/api/orchestrations/fence/lift', {
        expectedRevision: fence.revision,
        reviewed: false,
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await post('/api/orchestrations/fence/lift', {
        expectedRevision: fence.revision + 1,
        reviewed: true,
      })
    ).statusCode,
  ).toBe(409)
  const lifted = await post('/api/orchestrations/fence/lift', {
    expectedRevision: fence.revision,
    reviewed: true,
    note: 'checked',
  })
  expect(lifted.statusCode).toBe(200)
  expect(GlobalFenceSchema.parse(lifted.json()).fenced).toBe(false)
  expect((await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).statusCode).toBe(
    201,
  )
  await h.settle(500)
  expect(
    h.rows<{ type: string }>("SELECT type FROM events WHERE type = 'orchestration.fence.updated'")
      .length,
  ).toBeGreaterThan(0)
})

// -------------------------------------------------------------------------------------------- MCP over HTTP

async function mcp(token: string) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(bridgeUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  closers.push(() => client.close())
  return client
}
async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  return {
    error: result.isError === true,
    text,
    json: text.startsWith('{') ? JSON.parse(text) : null,
  }
}

test('MCP: the orch tools need the access switch and the lead capability, not the writes switch; other agents cannot use it', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        capability = t.capability
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => capability !== '')
  // The lead's turn is running (virtual time stands still).
  expect(attemptOf(h, id, 'lead')[0]!.state).toBe('running')
  h.access.patch('lead', { enabled: true, writesEnabled: false })
  h.access.patch('builder', { enabled: true, writesEnabled: true })
  const leadClient = await mcp(h.access.issueToken('lead'))
  const names = (await leadClient.listTools()).tools.map((t) => t.name)
  expect(names).toEqual(
    expect.arrayContaining([
      'orch.plan',
      'orch.assign',
      'orch.cancel',
      'orch.ask',
      'orch.requestApproval',
      'orch.note',
      'orch.finish',
      'orch.receipt',
    ]),
  )

  const noted = await tool(leadClient, 'orch.note', {
    capability,
    commandId: 'n1',
    text: 'hello from MCP',
  })
  expect(noted.error).toBe(false)
  expect(noted.json).toMatchObject({ status: 'ok', tool: 'orch.note', commandId: 'n1' })
  const assigned = await tool(leadClient, 'orch.assign', {
    capability,
    commandId: 'a1',
    agent: 'builder',
    instruction: 'do it',
  })
  expect(assigned.json.result.stepId).toBe('s1')
  const refused = await tool(leadClient, 'orch.assign', {
    capability,
    commandId: 'a2',
    agent: 'nobody',
    instruction: 'do it',
  })
  expect(refused.error).toBe(true)
  expect(refused.json.code).toBe('agent_not_allowed')
  // Bad shapes are rejected before they reach the executor.
  expect(
    (
      await tool(leadClient, 'orch.assign', {
        capability: 'orc_x',
        commandId: 'a3',
        agent: 'builder',
        instruction: 'x',
      })
    ).error,
  ).toBe(true)
  // Another agent, even with MCP access and writes, cannot use the lead's capability.
  const builderClient = await mcp(h.access.issueToken('builder'))
  const spoof = await tool(builderClient, 'orch.note', {
    capability,
    commandId: 'n2',
    text: 'spoof',
  })
  expect(spoof.error).toBe(true)
  expect(spoof.text).toContain('unauthorized')
  // The writes switch does not open the run's room either: rooms.post into an owned room is refused.
  const roomPost = await tool(builderClient, 'rooms.post', {
    roomId: detail(id).roomId,
    text: 'hi',
  })
  expect(roomPost.error).toBe(true)
  expect(roomPost.text).toContain('orchestration_owned')
  // With MCP access off the tools are off, whatever the capability says.
  h.access.patch('lead', { enabled: false })
  const off = await fetch(bridgeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${h.access.issueToken('lead')}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(off.status).toBe(403)
  expect(detail(id).stepsList.map((s) => s.id)).toEqual(['s1'])
  // The note landed in the run's room, attributed to the lead and tagged via MCP.
  const note = h.rows<{ parts: string; author_agent_id: string }>(
    "SELECT parts, author_agent_id FROM messages WHERE id LIKE 'orc-note:%'",
  )[0]!
  expect(note.author_agent_id).toBe('lead')
  expect(JSON.parse(note.parts)).toEqual([
    expect.objectContaining({ text: 'hello from MCP', via: 'mcp' }),
  ])
})
