import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import {
  AgentOperationSchema,
  AgentPreviewSchema,
  type AgentOperation,
  type AgentStyle,
} from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

export const input = {
  id: 'helper',
  name: 'Helper',
  role: 'Builds small changes',
  model: 'fake-model',
  style: { color: '#19C39A', shape: 'triangle' as const },
}

export interface ProfilesTestState {
  env: ReturnType<typeof setup>
  app: ReturnType<typeof buildApp>
  port: FakePort
  cookie: string
}

export async function startProfilesTest(): Promise<ProfilesTestState> {
  const env = setup()
  const port = new FakePort(1, { db: env.db }, false)
  const app = buildApp({
    config: loadConfig({ SCORE_HOME: env.home }),
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
  return { env, app, port, cookie: paired.headers['set-cookie']!.toString().split(';')[0]! }
}

async function closeProfilesTest({
  env,
  app,
  port,
}: Pick<ProfilesTestState, 'env' | 'app' | 'port'>) {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  vi.restoreAllMocks()
}

export function profilesTestSuite(
  assign: (state: ProfilesTestState) => void,
  current: () => Pick<ProfilesTestState, 'env' | 'app' | 'port'>,
) {
  beforeEach(async () => assign(await startProfilesTest()))
  afterEach(async () => closeProfilesTest(current()))
}

export function mutateProfiles(
  { app, cookie }: Pick<ProfilesTestState, 'app' | 'cookie'>,
  url: string,
  payload: object,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
  extra: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    payload,
    headers: { cookie, 'x-score-client': 'web', ...extra },
  })
}

export async function createProfile(
  { app, cookie }: Pick<ProfilesTestState, 'app' | 'cookie'>,
  body: Omit<typeof input, 'style'> & { style: AgentStyle } = input,
) {
  const preview = AgentPreviewSchema.parse(
    (
      await mutateProfiles({ app, cookie }, '/api/agents/preview', { kind: 'create', ...body })
    ).json(),
  )
  const response = await mutateProfiles({ app, cookie }, '/api/agents', {
    ...body,
    previewHash: preview.hash,
    confirmInheritance: true,
  })
  expect(response.statusCode).toBe(202)
  return AgentOperationSchema.parse(response.json())
}

export async function waitForFinished(
  { app, cookie }: Pick<ProfilesTestState, 'app' | 'cookie'>,
  id: string,
) {
  let result: AgentOperation | undefined
  await vi.waitFor(
    async () => {
      result = AgentOperationSchema.parse(
        (await app.inject({ url: `/api/agents/operations/${id}`, headers: { cookie } })).json(),
      )
      expect(result.state).not.toBe('running')
    },
    { timeout: 5000, interval: 25 },
  )
  return result!
}
