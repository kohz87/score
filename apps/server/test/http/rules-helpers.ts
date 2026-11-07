import { AgentDetailSchema, RulesResponseSchema } from '@score/contract'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

export type RulesTestState = {
  env: ReturnType<typeof setup>
  app: ReturnType<typeof buildApp>
  cookie: string
  extraHome: string | undefined
}

export async function bootRulesApp(env: RulesTestState['env'], port: FakePort | LivePort) {
  const app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  return { app, cookie: paired.headers['set-cookie']!.toString().split(';')[0]! }
}

export async function startRulesTest(): Promise<RulesTestState> {
  const env = setup()
  const { app, cookie } = await bootRulesApp(env, new FakePort(1, { db: env.db }, false))
  return { env, app, cookie, extraHome: undefined }
}

export async function stopRulesTest(state: RulesTestState) {
  vi.restoreAllMocks()
  await state.app.close()
  await state.env.ingest.close()
  state.env.db.close()
  rmSync(state.env.home, { recursive: true, force: true })
  if (state.extraHome) rmSync(state.extraHome, { recursive: true, force: true })
}

export function rulesTestSuite(
  assign: (state: RulesTestState) => void,
  current: () => RulesTestState,
) {
  beforeEach(async () => assign(await startRulesTest()))
  afterEach(async () => stopRulesTest(current()))
}

export function createRulesHelpers(current: () => RulesTestState) {
  const human = () => ({ 'x-score-client': 'web', cookie: current().cookie })
  const call = (
    method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = human(),
  ) => current().app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
  const rules = async () =>
    RulesResponseSchema.parse((await call('GET', '/api/settings/rules')).json())
  const permissions = async (id: string) =>
    AgentDetailSchema.parse((await call('GET', `/api/agents/${id}`)).json()).permissions
  const team = {
    mode: 'manual',
    goAhead: ['SQL DROP', 'recursive delete'],
    never: ['*git*  push*   --force*'],
  }
  const del = (agent: string, id: string, headers?: Record<string, string>) =>
    call('DELETE', `/api/agents/${agent}/permissions/${encodeURIComponent(id)}`, undefined, headers)
  return { call, rules, permissions, team, del }
}
