import { ORCH_ACKNOWLEDGEMENT_TEXT, type AgentDetail } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { withCodingAgents } from '../../src/runtimes/coding/port.ts'
import type { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import {
  agent,
  definition,
  edge,
  end,
  save,
  wfHarness,
  type Harness,
} from '../workflows/wf-harness.ts'

// S2-009: the application wiring in start-server: the executor keeps the raw Hermes port, the routes see the team with
// coding agents merged in. Until PLAN 7.7 a coding agent can't take a step, so the routes say so up front.
let h: Harness
let app: FastifyInstance
let headers: { 'x-score-client': string; cookie: string }

const coder = {
  id: 'coder',
  name: 'Coder',
  role: 'Coding agent',
  style: { color: '#19C39A', shape: 'hexagon' },
  status: 'idle',
  activity: null,
  model: { id: 'default', label: 'Codex default' },
  served: true,
  runtime: 'codex',
  runtimeNote: 'Codex',
} as unknown as AgentDetail
const fakeCoding = {
  isCodingAgent: (id: string) => id === 'coder',
  details: async () => [coder],
  agents: () => [],
} as unknown as CodingRuntime

beforeEach(async () => {
  h = await wfHarness()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: `${h.dir}/home` }),
    logger: false,
    db: h.db,
    ingest: h.ingest,
    port: withCodingAgents(h.port, fakeCoding),
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
})
afterEach(async () => {
  await app.close()
  await h.close()
})

const get = (url: string) => app.inject({ method: 'GET', url, headers })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
const refused = (response: {
  statusCode: number
  json: () => { error: { code: string; message: string } }
}) => {
  expect(response.statusCode).toBe(422)
  expect(response.json().error.code).toBe('unsupported_agent')
  expect(response.json().error.message).toMatch(
    /Coding agents can’t take orchestration or workflow steps yet/,
  )
}

test('orchestration preflight and create refuse a coding agent as a step agent or as the lead', async () => {
  refused(await get('/api/orchestrations/preflight?leadAgentId=lead&allowedAgents=builder,coder'))
  refused(await get('/api/orchestrations/preflight?leadAgentId=coder&allowedAgents=builder'))
  refused(
    await post('/api/orchestrations', {
      goal: 'Write the release notes',
      leadAgentId: 'lead',
      allowedAgents: ['coder'],
      gatePolicy: 'every-step',
      acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
    }),
  )
  // Hermes agents still pass.
  expect(
    (await get('/api/orchestrations/preflight?leadAgentId=lead&allowedAgents=builder')).statusCode,
  ).toBe(200)
})

test('workflow save, preflight and start refuse a coding agent', async () => {
  const withCoder = definition([agent('a', { agentId: 'coder' }), end()], [edge('a', 'done')])
  refused(await post('/api/workflows', { definition: withCoder }))
  const ok = await post('/api/workflows', {
    definition: definition([agent('a'), end()], [edge('a', 'done')]),
  })
  expect(ok.statusCode).toBe(201)
  const { workflowId } = ok.json() as { workflowId: string }
  refused(
    await post(`/api/workflows/${workflowId}/versions`, { baseVersion: 1, definition: withCoder }),
  )
  // A version stored before this rule (or by another route) is refused when it is checked or started.
  const stored = save(h, withCoder)
  refused(await get(`/api/workflow-runs/preflight?workflowId=${stored}&version=1`))
  refused(
    await post('/api/workflow-runs', {
      workflowId: stored,
      version: 1,
      inputs: {},
      agentMap: [],
      acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
    }),
  )
})
