import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { hashXtc, mintXtc } from '../../src/domain/exchanges/capability.ts'
import { reserveMessageRun } from '../../src/domain/message-runs.ts'
import { insertRoom, storeMessage } from '../../src/domain/rooms.ts'
import { registerErrorHandlers } from '../../src/errors.ts'
import { loadBridgeBootstrap } from '../../src/hermes/bridge/bootstrap.ts'
import { registerBridgeRoutes } from '../../src/hermes/bridge/routes.ts'

// Contract §11 "Exchange actions": the bridge route the plugin's score_* tools call (PLAN 11.1b).

let dir: string
let db: ScoreDb
let app: FastifyInstance
let bootstrap = ''
const now = Date.parse('2026-10-24T12:00:00Z')
const iso = new Date(now).toISOString()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-xbridge-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  for (const id of ['builder', 'reviewer'])
    db.sqlite
      .prepare(
        "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready')",
      )
      .run(id, crypto.randomUUID())
  insertRoom(
    db.sqlite,
    {
      id: 'team',
      name: 'Team room',
      kind: 'room',
      leadAgentId: null,
      members: ['builder', 'reviewer'],
    },
    iso,
  )
  db.sqlite.prepare("UPDATE rooms SET routing = 'exchanges', role = 'team' WHERE id = 'team'").run()
  const home = join(dir, 'home')
  const bootstrapHash = loadBridgeBootstrap(home)
  bootstrap = readFileSync(join(home, 'bridge.token'), 'utf8').trim()
  app = Fastify()
  registerErrorHandlers(app)
  registerBridgeRoutes(app, {
    db,
    ingest: { submit: async () => undefined, clearHolds: () => undefined } as never,
    bootstrapHash,
    getCompatibility: () => ({
      fingerprint: 'f',
      tested: true,
      disabled: [],
      matchedHermes: { version: '0.21.0', codeSha: 'fixture' },
    }),
    clock: () => now,
  })
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function token(profile: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/bridge/v1/hello',
    headers: { authorization: `Bearer ${bootstrap}` },
    payload: {
      pid: 123,
      kanbanTaskId: null,
      isolation: 'in_process',
      pluginVersion: '0.1.0',
      hermes: { version: '0.21.0', codeSha: 'fixture' },
      privateApis: {},
      profile,
      incarnation: `inc-${profile}-12345`,
    },
  })
  return (response.json() as { producerToken: string }).producerToken
}

/** A running turn of builder in the team room's default job, with its capability. */
function builderTurn(): string {
  storeMessage(
    db.sqlite,
    {
      id: 'm1',
      roomId: 'team',
      author: { kind: 'you' },
      to: ['builder'],
      parts: [{ kind: 'text', text: 'Build it.' }],
      createdAt: iso,
      streaming: false,
      refs: [],
    },
    iso,
  )
  const id = reserveMessageRun(
    db.sqlite,
    {
      parentMessageId: 'm1',
      roomId: 'team',
      agentId: 'builder',
      chainId: 'm1',
      hop: 0,
      input: 'Build it.',
      agents: ['builder', 'reviewer'],
    },
    iso,
  )
  const capability = mintXtc()
  db.sqlite
    .prepare('UPDATE message_runs SET xtc_hash = ? WHERE message_id = ?')
    .run(hashXtc(capability), id)
  return capability
}

const post = (tok: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: '/bridge/v1/exchanges/action',
    headers: { authorization: `Bearer ${tok}` },
    payload,
  })

test('stages an action for the turn the capability names, idempotently per commandId', async () => {
  const capability = builderTurn()
  const tok = await token('builder')
  const body = {
    capability,
    commandId: 'x1',
    action: { action: 'handoff', to: 'reviewer', note: 'Over to you.' },
  }
  const first = await post(tok, body)
  expect(first.statusCode).toBe(200)
  expect(first.json()).toEqual({
    status: 'staged',
    commandId: 'x1',
    action: 'handoff',
    message: 'Will go to reviewer when your turn ends.',
  })
  expect((await post(tok, body)).json()).toEqual(first.json())
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM exchange_actions').get()).toEqual({ n: 1 })
})

test("another agent's producer token can't use the turn's capability", async () => {
  const capability = builderTurn()
  const response = await post(await token('reviewer'), {
    capability,
    commandId: 'x1',
    action: { action: 'handoff', to: 'builder', note: 'Mine now.' },
  })
  expect(response.json()).toMatchObject({ status: 'refused', code: 'capability_invalid' })
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM exchange_actions').get()).toEqual({ n: 0 })
})

test('refuses bad tokens and malformed bodies', async () => {
  const capability = builderTurn()
  expect(
    (
      await post('x'.repeat(43), {
        capability,
        commandId: 'x',
        action: { action: 'reply', text: 'a' },
      })
    ).statusCode,
  ).toBe(401)
  const tok = await token('builder')
  expect(
    (
      await post(tok, {
        capability: 'xtc_short',
        commandId: 'x',
        action: { action: 'reply', text: 'a' },
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await post(tok, {
        capability,
        commandId: 'has space',
        action: { action: 'reply', text: 'a' },
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (await post(tok, { capability, commandId: 'x', action: { action: 'merge' } })).statusCode,
  ).toBe(400)
})
