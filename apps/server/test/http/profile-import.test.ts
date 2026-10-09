import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentOperationSchema, ImportInspectionSchema, type AgentOperation } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { HttpError } from '../../src/errors.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'
import { sampleProfile, tarGz } from '../helpers/tar.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie: string
const style = { color: '#19C39A', shape: 'triangle' as const }
beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  app = buildApp({
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
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const uploadsDir = () => join(env.home, 'profile-imports')
const uploads = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : [])
function upload(bytes: Buffer, withCookie = true) {
  return app.inject({
    method: 'POST',
    url: '/api/agents/imports',
    payload: bytes,
    headers: {
      'content-type': 'application/octet-stream',
      'x-score-client': 'web',
      ...(withCookie ? { cookie } : {}),
    },
  })
}
function start(payload: object) {
  return app.inject({
    method: 'POST',
    url: '/api/agents/import',
    payload,
    headers: { cookie, 'x-score-client': 'web' },
  })
}
async function finished(id: string) {
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
const body = (uploadId: string, extra: object = {}) => ({
  uploadId,
  id: 'scout',
  name: 'Scout',
  role: 'Reads and summarizes',
  style,
  ...extra,
})

test('upload stores a private 0600 file and returns a names-only inspection', async () => {
  const response = await upload(sampleProfile())
  expect(response.statusCode).toBe(201)
  const inspection = ImportInspectionSchema.parse(response.json())
  expect(inspection).toMatchObject({
    archiveRoot: 'scout',
    suggestedId: 'scout',
    model: 'example/model-1',
    skills: ['research/web'],
    plugins: ['notes'],
    memoryBytes: 1234,
  })
  expect(statSync(uploadsDir()).mode & 0o777).toBe(0o700)
  expect(statSync(join(uploadsDir(), `${inspection.uploadId}.tar.gz`)).mode & 0o777).toBe(0o600)
})

test('upload needs a paired browser and refuses unsafe archives without keeping them', async () => {
  expect((await upload(sampleProfile(), false)).statusCode).toBe(401)
  const unsafe = await upload(tarGz([{ name: 'scout/' }, { name: 'scout/l', type: '2', link: '/etc' }]))
  expect(unsafe.statusCode).toBe(400)
  expect((await upload(Buffer.from('plain text'))).statusCode).toBe(400)
  expect((await upload(Buffer.alloc(0))).statusCode).toBeGreaterThanOrEqual(400)
  expect(uploads()).toEqual([])
})

test('import runs the durable steps, shows up as an agent and removes the upload', async () => {
  const { uploadId } = ImportInspectionSchema.parse((await upload(sampleProfile())).json())
  const response = await start(body(uploadId))
  expect(response.statusCode).toBe(202)
  const operation = AgentOperationSchema.parse(response.json())
  expect(operation.kind).toBe('import')
  expect(operation.steps.map((step) => step.name)).toEqual([
    'import_profile',
    'describe_profile',
    'preserve_key',
    'configure_key',
    'permissions',
    'install_bridge',
    'enable_bridge',
    'verify_ready',
  ])
  const done = await finished(operation.id)
  expect(done.state).toBe('completed')
  const agent = (await app.inject('/api/agents/scout')).json()
  expect(agent).toMatchObject({ id: 'scout', name: 'Scout', role: 'Reads and summarizes' })
  expect(uploads()).toEqual([])
})

test('an existing id is refused (Hermes never overwrites) and nothing is started', async () => {
  const { uploadId } = ImportInspectionSchema.parse((await upload(sampleProfile())).json())
  const response = await start(body(uploadId, { id: 'lead' }))
  expect(response.statusCode).toBe(409)
  expect(uploads()).toHaveLength(1)
  expect((await start(body(uploadId, { id: 'default' }))).statusCode).toBe(409)
})

test('credential files need an explicit confirmation', async () => {
  const bytes = sampleProfile('scout', [{ name: 'scout/.env', body: 'A=1' }])
  const inspection = ImportInspectionSchema.parse((await upload(bytes)).json())
  expect(inspection.credentialFiles).toEqual(['.env'])
  const refused = await start(body(inspection.uploadId))
  expect(refused.statusCode).toBe(400)
  const accepted = await start(body(inspection.uploadId, { confirmCredentials: true }))
  expect(accepted.statusCode).toBe(202)
  await finished(AgentOperationSchema.parse(accepted.json()).id)
})

test('bad ids, unknown uploads and unexpected fields are rejected', async () => {
  const { uploadId } = ImportInspectionSchema.parse((await upload(sampleProfile())).json())
  expect((await start(body(uploadId, { id: '../x' }))).statusCode).toBe(400)
  expect((await start(body(uploadId, { path: '/etc/passwd' }))).statusCode).toBe(400)
  expect((await start(body('00000000-0000-4000-8000-000000000000'))).statusCode).toBe(404)
})

test('a refused import step stops with a recorded error, is not retryable and drops the upload', async () => {
  const { uploadId } = ImportInspectionSchema.parse((await upload(sampleProfile())).json())
  const real = port.profileStep.bind(port)
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'import_profile') throw new HttpError(409, 'conflict', 'Hermes refused')
    return real(step, context)
  })
  const operation = AgentOperationSchema.parse((await start(body(uploadId))).json())
  const done = await finished(operation.id)
  expect(done.state).toBe('needs_attention')
  expect(done.nextStep).toBe('import_profile')
  expect(done.error).toContain('Hermes refused')
  expect(done.retryable).toBeFalsy()
  expect(done.confirmable).toBeFalsy()
  expect(uploads()).toEqual([])
})

test('cancel removes the upload', async () => {
  const { uploadId } = ImportInspectionSchema.parse((await upload(sampleProfile())).json())
  const response = await app.inject({
    method: 'DELETE',
    url: `/api/agents/imports/${uploadId}`,
    headers: { cookie, 'x-score-client': 'web' },
  })
  expect(response.statusCode).toBe(204)
  expect(uploads()).toEqual([])
})
