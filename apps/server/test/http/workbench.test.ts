import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'

// PLAN 11.6a: the Workbench is a read. Nothing under it types, clicks or takes over.

let app: ReturnType<typeof buildApp>
let port: FakePort
let dir = ''
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-workbench-'))
  port = new FakePort(1, {}, false)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: path.join(dir, 'home') }),
    logger: false,
    port,
  })
  await app.ready()
})
afterEach(async () => {
  await app.close()
  port.workspaceDispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

const web = { 'x-score-client': 'web' }

test('an unknown job is 404 (the shape is covered with real exchanges in test/domain/job-workbench.test.ts)', async () => {
  const missing = await app.inject({ method: 'GET', url: '/api/jobs/job_nope/workbench' })
  expect(missing.statusCode).toBe(404)
})

test('no route under the Workbench accepts input', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const)
    for (const url of [
      '/api/jobs/job_x/workbench',
      '/api/jobs/job_x/workbench/input',
      '/api/jobs/job_x/workbench/takeover',
    ]) {
      const answer = await app.inject({ method, url, headers: web, payload: {} })
      expect(answer.statusCode, `${method} ${url}`).toBe(404)
    }
  const routes = app.printRoutes({ commonPrefix: false })
  expect(routes).not.toMatch(/workbench\/./u)
})
