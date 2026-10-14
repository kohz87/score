import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ValidationResultSchema,
  WorkflowPreflightSchema,
  type WorkflowDefinition,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { withCodingAgents } from '../../src/runtimes/coding/port.ts'
import { stubFacts, stubRuntime } from './coding-stubs.ts'
import { agent, definition, edge, end, gate, save, wfHarness, type Harness } from './wf-harness.ts'

// 7.7c-1 #1: one runtime validation (`validateWorkflowAgents`) at every door: Validate, save, a new version, preflight and
// start, with structured issues; a workflow without coding steps is unchanged.

let h: Harness
let app: FastifyInstance
let headers: { 'x-score-client': string; cookie: string }

async function boot(units = true): Promise<void> {
  h = await wfHarness({ orchestrator: { codingFacts: stubFacts(units) } })
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: `${h.dir}/home` }),
    logger: false,
    db: h.db,
    ingest: h.ingest,
    port: withCodingAgents(h.port, stubRuntime()),
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
}
afterEach(async () => {
  await app?.close()
  await h?.close()
})

const get = (url: string) => app.inject({ method: 'GET', url, headers })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
const withAgents = (...ids: string[]): WorkflowDefinition =>
  definition(
    [...ids.map((id) => agent(`s-${id}`, { agentId: id })), end()],
    [
      ...ids.slice(0, -1).map((id, i) => edge(`s-${id}`, `s-${ids[i + 1]!}`)),
      edge(`s-${ids.at(-1)!}`, 'done'),
    ],
  )
const codes = (body: { issues: { code: string; nodeId: string | null }[] }) =>
  body.issues.map((issue) => `${issue.code}:${issue.nodeId}`).sort()

describe('the runtime validation of a workflow', () => {
  test('Validate reports every coding agent that can’t take a step, per node, and accepts Claude Code and Codex', async () => {
    await boot()
    const refused = await post('/api/workflows/validate', {
      definition: withAgents('cc', 'cx', 'ag', 'oc', 'wide'),
    })
    expect(refused.statusCode).toBe(200)
    const result = ValidationResultSchema.parse(refused.json())
    expect(result.ok).toBe(false)
    expect(codes(result)).toEqual([
      'coding_agent_unsupported:s-ag',
      'coding_agent_unsupported:s-oc',
      'coding_permission_full:s-wide',
    ])
    expect(result.issues.every((issue) => issue.field === 'agentId')).toBe(true)
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/Antigravity/)
    const accepted = await post('/api/workflows/validate', { definition: withAgents('cc', 'cx') })
    expect(ValidationResultSchema.parse(accepted.json())).toMatchObject({ ok: true, issues: [] })
  })

  test('a host without supervised units refuses the coding steps, not the Hermes ones', async () => {
    await boot(false)
    const result = ValidationResultSchema.parse(
      (await post('/api/workflows/validate', { definition: withAgents('cc', 'builder') })).json(),
    )
    expect(codes(result)).toEqual(['coding_workers_need_units:s-cc'])
  })

  test('save and a new version answer 422 invalid_definition with the same issues', async () => {
    await boot()
    const bad = withAgents('ag')
    const saved = await post('/api/workflows', { definition: bad })
    expect(saved.statusCode).toBe(422)
    expect(saved.json().error.code).toBe('invalid_definition')
    expect(codes(saved.json().error.details.result)).toEqual(['coding_agent_unsupported:s-ag'])
    const ok = await post('/api/workflows', { definition: withAgents('cc') })
    expect(ok.statusCode).toBe(201)
    const { workflowId } = ok.json() as { workflowId: string }
    const next = await post(`/api/workflows/${workflowId}/versions`, {
      baseVersion: 1,
      definition: withAgents('wide'),
    })
    expect(next.statusCode).toBe(422)
    expect(codes(next.json().error.details.result)).toEqual(['coding_permission_full:s-wide'])
  })

  test('a stored version the host can no longer run: preflight lists the issues, start answers invalid_definition', async () => {
    await boot(false)
    const stored = save(h, withAgents('cx'))
    const preflight = WorkflowPreflightSchema.parse(
      (await get(`/api/workflow-runs/preflight?workflowId=${stored}&version=1`)).json(),
    )
    expect(preflight.ok).toBe(false)
    expect(codes(preflight)).toEqual(['coding_workers_need_units:s-cx'])
    const started = await post('/api/workflow-runs', {
      workflowId: stored,
      version: 1,
      inputs: {},
      agentMap: [{ agentId: 'cx', incarnation: 'untracked' }],
      acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
    })
    expect(started.statusCode).toBe(422)
    expect(started.json().error.code).toBe('invalid_definition')
    expect(codes(started.json().error.details.result)).toEqual(['coding_workers_need_units:s-cx'])
  })

  test('Hermes-only and gate-only workflows are unchanged: valid, saved, no issues', async () => {
    await boot()
    const hermes = withAgents('builder')
    expect(
      ValidationResultSchema.parse(
        (await post('/api/workflows/validate', { definition: hermes })).json(),
      ).issues,
    ).toEqual([])
    expect((await post('/api/workflows', { definition: hermes })).statusCode).toBe(201)
    const gateOnly = definition([gate('g'), end()], [edge('g', 'done')])
    expect(
      ValidationResultSchema.parse(
        (await post('/api/workflows/validate', { definition: gateOnly })).json(),
      ),
    ).toMatchObject({ ok: true, issues: [] })
    const stored = save(h, gateOnly)
    const preflight = WorkflowPreflightSchema.parse(
      (await get(`/api/workflow-runs/preflight?workflowId=${stored}&version=1`)).json(),
    )
    expect(preflight.issues).toEqual([])
  })
})
