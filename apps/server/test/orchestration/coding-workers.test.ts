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
// 7.7c: with no coding runtime wired, a workflow step on a coding agent is a structured issue at every door.
const refused = (response: {
  statusCode: number
  json: () => { error: { code: string; details: { result: { issues: { code: string }[] } } } }
}) => {
  expect(response.statusCode).toBe(422)
  expect(response.json().error.code).toBe('invalid_definition')
  expect(response.json().error.details.result.issues.map((issue) => issue.code)).toContain(
    'coding_agent_unsupported',
  )
}

// 7.7b: orchestrations take Claude Code and Codex as workers (guard: supported-agents.ts), so here only the lead and an
// executor without a coding runtime refuse a coding agent. The workflow routes below keep the Hermes-only rule.
test('orchestration preflight and create refuse a coding agent as the lead, and as a step agent without a coding runtime', async () => {
  const refusedOrch = (response: {
    statusCode: number
    json: () => { error: { code: string } }
  }) => {
    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('unsupported_agent')
  }
  refusedOrch(
    await get('/api/orchestrations/preflight?leadAgentId=lead&allowedAgents=builder,coder'),
  )
  refusedOrch(await get('/api/orchestrations/preflight?leadAgentId=coder&allowedAgents=builder'))
  refusedOrch(
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

test('workflow save, preflight and start refuse a coding agent when no coding runtime is wired', async () => {
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
  // A version stored before this rule (or by another route) lists its issues when it is checked and is refused at start.
  const stored = save(h, withCoder)
  const checked = await get(`/api/workflow-runs/preflight?workflowId=${stored}&version=1`)
  expect(checked.statusCode).toBe(200)
  expect(checked.json().ok).toBe(false)
  expect(checked.json().issues.map((issue: { code: string }) => issue.code)).toContain(
    'coding_agent_unsupported',
  )
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
