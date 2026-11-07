import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ORCH_ACKNOWLEDGEMENT_TEXT } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach } from 'vitest'
import { buildApp, buildBridgeApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { harness, type Harness } from './harness.ts'

export let h: Harness
export let app: FastifyInstance
let bridge: FastifyInstance
export let headers: { 'x-score-client': string; cookie: string }
export let bridgeUrl: URL
export const capability = { value: '' }
const closers: (() => Promise<unknown>)[] = []

export async function boot(lead?: NonNullable<Parameters<typeof harness>[0]>['lead']) {
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

export const get = (url: string) => app.inject({ method: 'GET', url, headers })
export const post = (url: string, payload: object = {}, authed = true, key?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: authed
      ? { ...headers, ...(key ? { 'idempotency-key': key } : {}) }
      : { 'x-score-client': 'web' },
    payload,
  })

export const createBody = (extra: object = {}) => ({
  goal: 'Write the release notes',
  leadAgentId: 'lead',
  allowedAgents: ['builder', 'reviewer'],
  gatePolicy: 'every-step',
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  ...extra,
})

export const status = (id: string) => h.orch.summary(id).status
export const detail = (id: string) => h.orch.snapshot(id).orchestration

beforeEach(() => {
  capability.value = ''
})

export async function mcp(token: string) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(bridgeUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  closers.push(() => client.close())
  return client
}

export async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  return {
    error: result.isError === true,
    text,
    json: text.startsWith('{') ? JSON.parse(text) : null,
  }
}
