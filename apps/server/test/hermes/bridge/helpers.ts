import {
  BridgeHelloResponseSchema,
  type BridgeEvent,
  type BridgeHelloRequest,
} from '@score/contract'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyServerOptions } from 'fastify'
import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { getEpoch, migrate, openDatabase } from '../../../src/db/index.ts'
import { createIngest } from '../../../src/hub/ingest.ts'
import { createHermesPort } from '../../../src/hermes/index.ts'
import { loadBridgeBootstrap } from '../../../src/hermes/bridge/bootstrap.ts'

export const initialTime = Date.parse('2026-10-07T12:00:00Z')
export const hello: BridgeHelloRequest = {
  profile: 'builder',
  pid: 123,
  incarnation: 'worker-builder',
  kanbanTaskId: 'task-1',
  isolation: 'in_process',
  pluginVersion: '0.1.0',
  // Hermes reports `<version>+<build>`; tested fingerprints store the plain version.
  hermes: { version: '0.21.0+1234', codeSha: 'fixture' },
  privateApis: {
    'tools.approval._lock': true,
    'tools.approval._gateway_queues': true,
    'tools.approval.list_gateway_approvals': true,
    'tools.approval.resolve_gateway_approval': true,
  },
}

export function event(
  counter: number,
  hook = 'on_session_start',
  payload: Record<string, unknown> = {},
): BridgeEvent {
  return {
    counter,
    hook,
    at: new Date(initialTime + counter).toISOString(),
    sessionKey: 'gateway-session',
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    payload,
  }
}

export function setup({
  logger = false,
  mode = 'live',
}: { logger?: FastifyServerOptions['logger']; mode?: 'live' | 'fake' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'score-bridge-'))
  const db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../../migrations/', import.meta.url)))
  let now = initialTime
  let disabled: string[] = []
  const clock = () => now
  const ingest = createIngest(db, { clock })
  const bootstrapHash = loadBridgeBootstrap(home)
  const bootstrap = readFileSync(join(home, 'bridge.token'), 'utf8')
  const config = loadConfig({ SCORE_HOME: home, SCORE_MODE: mode })
  const port = createHermesPort({ ...config, mode: 'fake' })
  const metrics = { unknownHooks: 0 }
  const app = buildApp({
    config,
    db,
    ingest,
    logger,
    clock,
    port,
    getEpoch: () => getEpoch(db),
    bridge: {
      db,
      ingest,
      bootstrapHash,
      clock,
      metrics,
      getCompatibility: () => ({
        fingerprint: 'fixture',
        tested: true,
        disabled,
        matchedHermes: { version: '0.21.0', codeSha: 'fixture' },
      }),
    },
  })
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const handshake = (body: unknown = hello, token = bootstrap) =>
    app.inject({
      method: 'POST',
      url: '/bridge/v1/hello',
      headers: headers(token),
      payload: body as object,
    })
  const send = (token: string, events: BridgeEvent[]) =>
    app.inject({
      method: 'POST',
      url: '/bridge/v1/events',
      headers: headers(token),
      payload: { events },
    })
  return {
    app,
    db,
    ingest,
    home,
    bootstrap,
    bootstrapHash,
    metrics,
    headers,
    handshake,
    send,
    setNow(value: number) {
      now = value
    },
    disable(features: string[]) {
      disabled = features
    },
    async token(body: unknown = hello) {
      const response = await handshake(body)
      if (response.statusCode !== 200) throw new Error('Handshake failed')
      return BridgeHelloResponseSchema.parse(response.json()).producerToken
    },
    async close() {
      await app.close()
      await ingest.close()
      db.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}
