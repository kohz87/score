import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { KnowledgeAgentApi } from '../../src/knowledge/agent-api.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'

let dir: string
let app: ReturnType<typeof buildApp>
let db: ScoreDb
let vault: KnowledgeVault
let cookie = ''

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-kn-agents-')))
  db = openDatabase(path.join(dir, 'home', 'score.db'))
  migrate(db, new URL('../../migrations/', import.meta.url).pathname)
  vault = new KnowledgeVault({
    vault: path.join(dir, 'vault'),
    db,
    watch: false,
    emit: () => undefined,
  })
  await vault.start()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: path.join(dir, 'home') }),
    logger: false,
    port: new FakePort(1, {}, false),
    db,
    knowledge: vault,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  await app.close()
  await vault.close()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('per-agent switch: default on, PUT needs a paired browser, persists, and gates the tools', async () => {
  const url = '/api/agents/builder/knowledge'
  expect((await app.inject({ method: 'GET', url })).json()).toEqual({ enabled: true })
  expect((await app.inject({ method: 'PUT', url, payload: { enabled: false } })).statusCode).toBe(
    403,
  )
  const off = await app.inject({
    method: 'PUT',
    url,
    headers: { 'x-score-client': 'web', cookie },
    payload: { enabled: false },
  })
  expect(off.json()).toEqual({ enabled: false })
  expect((await app.inject({ method: 'GET', url })).json()).toEqual({ enabled: false })
  expect(
    (await app.inject({ method: 'GET', url: '/api/agents/reviewer/knowledge' })).json(),
  ).toEqual({ enabled: true })
  await expect(new KnowledgeAgentApi(vault, db).read('builder', 'x.md')).rejects.toMatchObject({
    status: 403,
  })
})

test('agent-usage lists today’s agent writes', async () => {
  const api = new KnowledgeAgentApi(vault, db)
  await api.append('builder', 'log.md', 'a')
  await api.append('builder', 'log.md', 'b')
  await api.write('reviewer', 'r.md', 'x', null)
  const usage = await app.inject({ method: 'GET', url: '/api/knowledge/agent-usage' })
  expect(usage.json()).toEqual({
    items: [
      { agentId: 'builder', writesToday: 2 },
      { agentId: 'reviewer', writesToday: 1 },
    ],
  })
})
