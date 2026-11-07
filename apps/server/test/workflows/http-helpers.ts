import type { WorkflowDefinition } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { agent, definition, edge, end, wfHarness, type Harness } from './wf-harness.ts'

export let h: Harness
export let app: FastifyInstance
export let headers: { 'x-score-client': string; cookie: string }
export let eventTypes: string[] = []

export function setupWorkflowHttp(): void {
  beforeEach(async () => {
    h = await wfHarness()
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
    eventTypes = []
    h.ingest.onCommitted((events) => {
      eventTypes.push(...events.map((e) => e.type))
    })
  })
  afterEach(async () => {
    await app.close()
    await h.close()
  })
}

export const get = (url: string) => app.inject({ method: 'GET', url, headers })
export const post = (url: string, payload: object = {}, authed = true) =>
  app.inject({
    method: 'POST',
    url,
    headers: authed ? headers : { 'x-score-client': 'web' },
    payload,
  })
export const def = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  ...definition([agent('a'), end()], [edge('a', 'done')]),
  ...over,
})
