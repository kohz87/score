// 3.13: creating a job with a check runs a command on the computer: enrolled host, fresh second factor, allowed folder.
import { ORCH_ACKNOWLEDGEMENT_TEXT } from '@score/contract'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { hostPassword } from '../helpers/host-password.ts'
import { harness, type Harness } from './harness.ts'

let h: Harness
let app: FastifyInstance
let folder: string
let headers: { 'x-score-client': string; cookie: string }
afterEach(async () => {
  await app?.close()
  await h?.close()
  rmSync(folder, { recursive: true, force: true })
})

async function boot(enrolled = true) {
  h = await harness()
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'score-check-ws-')))
  const home = `${h.dir}/home`
  mkdirSync(home, { recursive: true })
  if (enrolled) hostPassword(home, 'correct horse battery')
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: home }),
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
}
const body = (check: object) => ({
  goal: 'Fix the failing tests',
  leadAgentId: 'lead',
  allowedAgents: ['builder'],
  gatePolicy: 'none',
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  check: { command: 'pnpm test', workspace: folder, ...check },
})
const create = (check: object = {}) =>
  app.inject({ method: 'POST', url: '/api/orchestrations', headers, payload: body(check) })

test('needs a fresh password or passkey check, used up by one job', async () => {
  await boot()
  const stale = await create()
  expect(stale.statusCode).toBe(403)
  expect(stale.json().error.code).toBe('fresh_auth_required')
  app.pairing.markFresh(headers.cookie)
  const ok = await create()
  expect(ok.statusCode).toBe(201)
  const id = ok.json().orchestration.id as string
  expect(h.orch.snapshot(id).orchestration.check).toMatchObject({
    command: 'pnpm test',
    workspace: folder,
  })
  // One confirmation, one job.
  expect((await create()).json().error.code).toBe('fresh_auth_required')
})

test('refused without the host security password', async () => {
  await boot(false)
  app.pairing.markFresh(headers.cookie)
  const response = await create()
  expect(response.statusCode).toBe(403)
  expect(response.json().error.code).toBe('second_factor_not_enrolled')
})

test('shell syntax and refused folders fail before the confirmation is used up', async () => {
  await boot()
  app.pairing.markFresh(headers.cookie)
  const shell = await create({ command: 'pnpm lint && pnpm test' })
  expect(shell.statusCode).toBe(400)
  expect(shell.json().error.code).toBe('invalid_check')
  const home = await create({ workspace: `${h.dir}/home` })
  expect(home.statusCode).toBe(400)
  expect(home.json().error.message).toMatch(/Score|Hermes|SSH/)
  expect((await create()).statusCode).toBe(201)
})

test('a job without a check needs no confirmation', async () => {
  await boot()
  const plain: Record<string, unknown> = { ...body({}) }
  delete plain.check
  const response = await app.inject({
    method: 'POST',
    url: '/api/orchestrations',
    headers,
    payload: plain,
  })
  expect(response.statusCode).toBe(201)
})
