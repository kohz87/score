import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'

let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie = ''
let dir = ''
const R = '/api/agents/builder/runs-on'
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-runs-on-http-'))
  port = new FakePort(1, {}, false)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: path.join(dir, 'home') }),
    logger: false,
    port,
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
  port.workspaceDispose()
  fs.rmSync(dir, { recursive: true, force: true })
})
const headers = () => ({ 'x-score-client': 'web', cookie })

test('reading and setting where an agent runs needs a paired browser', async () => {
  expect(
    (await app.inject({ method: 'GET', url: R, headers: { 'x-score-client': 'web' } })).statusCode,
  ).toBe(401)
  const put = await app.inject({
    method: 'PUT',
    url: R,
    headers: { 'x-score-client': 'web' },
    payload: { backend: 'local' },
  })
  expect(put.statusCode).toBe(401)
})

test('GET answers the backend; PUT changes it and the workspace follows', async () => {
  const before = await app.inject({ method: 'GET', url: R, headers: headers() })
  expect(before.json()).toMatchObject({ backend: 'local', separated: 'no' })
  const put = await app.inject({
    method: 'PUT',
    url: R,
    headers: headers(),
    payload: { backend: 'docker' },
  })
  expect(put.statusCode).toBe(200)
  expect(put.json()).toMatchObject({ backend: 'docker', separated: 'partly' })
  const workspace = await app.inject({
    method: 'GET',
    url: '/api/agents/builder/workspace',
    headers: headers(),
  })
  expect(workspace.json()).toMatchObject({ available: false })
})

test('bad updates are refused before anything is written', async () => {
  for (const payload of [
    { backend: 'modal' },
    { backend: 'docker', image: 'Bad Image;rm' },
    { backend: 'docker', extra: true },
    { backend: 'ssh', host: 'box', user: 'Root Name' },
    { backend: 'ssh', host: 'box -oProxyCommand=x', user: 'agent' },
    { backend: 'ssh', host: 'box', user: 'agent', keyPath: 'relative/key' },
    { backend: 'ssh', host: 'box', user: 'agent', port: 70000 },
  ]) {
    const answer = await app.inject({ method: 'PUT', url: R, headers: headers(), payload })
    expect(answer.statusCode, JSON.stringify(payload)).toBe(400)
  }
  expect((await app.inject({ method: 'GET', url: R, headers: headers() })).json().backend).toBe(
    'local',
  )
})

test('an unknown agent is 404', async () => {
  const answer = await app.inject({
    method: 'GET',
    url: '/api/agents/nobody/runs-on',
    headers: headers(),
  })
  expect(answer.statusCode).toBe(404)
})
