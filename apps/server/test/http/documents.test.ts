import { RoomSchema } from '@score/contract'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { multipart, pdf } from '../media-fixtures.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let root = ''
let other = ''
let roomId = ''

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-docs-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false, () => ({ text: 'Done.', tools: [] }))
  await port.start(ingest)
  // Outside Score's own home, which a workspace may not be inside.
  other = mkdtempSync(join(tmpdir(), 'score-docs-ws-'))
  root = join(other, 'project')
  mkdirSync(root, { recursive: true })
  await port.setWorkspaceCwd('builder', root)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    db,
    ingest,
    port,
    clock,
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
  roomId = RoomSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers,
        payload: { name: 'docs', leadAgentId: 'lead' },
      })
    ).json(),
  ).id
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  port.workspaceDispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function upload(data: Buffer, filename: string): Promise<string> {
  const { body, contentType } = multipart([{ name: 'file', filename, data }])
  const res = await app.inject({
    method: 'POST',
    url: '/api/media',
    headers: { ...headers, 'content-type': contentType },
    payload: body,
  })
  expect(res.statusCode).toBe(201)
  return res.json().mediaId
}
const send = (payload: object) =>
  app.inject({ method: 'POST', url: `/api/rooms/${roomId}/messages`, headers, payload })
const day = () => new Date(scheduler.now()).toISOString().slice(0, 10)

test('text is inlined, a PDF is saved into the agent workspace, and the parts name them', async () => {
  const run = vi.spyOn(port, 'startRun')
  const csv = await upload(Buffer.from('a,b\n1,2\n'), 'data.csv')
  const doc = await upload(pdf('one'), '../../evil name.pdf')
  const sent = await send({
    text: '@builder read these',
    attachments: [
      { mediaId: csv, name: 'data.csv' },
      { mediaId: doc, name: '../../evil name.pdf' },
    ],
  })
  expect(sent.statusCode).toBe(200)
  const body = sent.json()
  expect(body.notices).toBeUndefined()
  expect(body.message.parts).toEqual([
    expect.objectContaining({ kind: 'text' }),
    { kind: 'document', mediaId: csv, name: 'data.csv', contentType: 'text/csv', size: 8 },
    {
      kind: 'document',
      mediaId: doc,
      name: 'evil name.pdf',
      contentType: 'application/pdf',
      size: pdf('one').length,
      saved: [{ agentId: 'builder', path: `attachments/${day()}/evil name.pdf` }],
    },
  ])
  const saved = `attachments/${day()}/evil name.pdf`
  expect(readFileSync(join(root, saved))).toEqual(pdf('one'))
  await vi.waitFor(() => expect(run).toHaveBeenCalled())
  const input = run.mock.calls[0]![0].input
  expect(input).toContain('Attached file: data.csv (text/csv, 8 B)\n```csv\na,b\n1,2\n\n```')
  expect(input).toContain(`Attached: ${saved}`)
  expect(run.mock.calls[0]![0].images).toBeUndefined()
  expect(existsSync(join(other, 'evil name.pdf'))).toBe(false)

  // Sending the same bytes again reuses the saved file instead of copying it.
  const again = await send({
    text: '@builder again',
    attachments: [{ mediaId: doc, name: 'evil name.pdf' }],
  })
  expect(again.statusCode).toBe(200)
  expect(existsSync(join(root, `attachments/${day()}/evil name-2.pdf`))).toBe(false)
})

test('an agent without a usable workspace gets the name only and the person is told', async () => {
  const run = vi.spyOn(port, 'startRun')
  const doc = await upload(pdf('two'), 'report.pdf')
  const sent = await send({
    text: '@designer here',
    attachments: [{ mediaId: doc, name: 'report.pdf' }],
  })
  expect(sent.statusCode).toBe(200)
  expect(sent.json().notices).toEqual([
    expect.stringContaining('report.pdf was not saved for @designer'),
  ])
  await vi.waitFor(() => expect(run).toHaveBeenCalled())
  expect(run.mock.calls[0]![0].input).toContain(
    'Attached (could not be saved to your workspace): report.pdf',
  )
})

test('workspace files are referenced by path, with the Workspace path rules', async () => {
  const run = vi.spyOn(port, 'startRun')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'main.ts'), 'x')
  writeFileSync(join(root, '.env'), 'SECRET=1')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), '[core]')
  const ok = await send({
    text: '@builder see this',
    attachments: [{ workspace: { agentId: 'builder', path: 'src/main.ts' } }],
  })
  expect(ok.statusCode).toBe(200)
  expect(ok.json().message.parts[1]).toEqual({
    kind: 'workspace',
    agentId: 'builder',
    path: 'src/main.ts',
  })
  await vi.waitFor(() => expect(run).toHaveBeenCalled())
  expect(run.mock.calls[0]![0].input).toContain('Workspace file: src/main.ts')
  const refuse = async (path: string, agentId = 'builder') =>
    (await send({ text: '@builder x', attachments: [{ workspace: { agentId, path } }] })).statusCode
  expect(await refuse('.env')).toBe(403)
  expect(await refuse('.git/config')).toBe(403)
  expect(await refuse('../outside.txt')).toBe(400)
  expect(await refuse('/etc/passwd')).toBe(400)
  expect(await refuse('src')).toBe(404)
  expect(await refuse('missing.txt')).toBe(404)
  expect(await refuse('x.txt', 'nobody')).toBe(400)
  expect(await refuse('x.txt', 'designer')).toBe(409)
})

test('a workspace attachment names the root it was picked from; a changed root is refused', async () => {
  writeFileSync(join(root, 'report.csv'), 'a,b')
  const wrong = await send({
    text: '@builder x',
    attachments: [
      { workspace: { agentId: 'builder', path: 'report.csv', root: '/somewhere/else' } },
    ],
  })
  expect(wrong.statusCode).toBe(409)
  expect(wrong.json().error.code).toBe('workspace_changed')
  const info = await app.inject({ url: '/api/agents/builder/workspace' })
  const current = info.json().root as string
  const right = await send({
    text: '@builder x',
    attachments: [{ workspace: { agentId: 'builder', path: 'report.csv', root: current } }],
  })
  expect(right.statusCode).toBe(200)
})

test('at most 10 attachments, and unknown uploads are refused', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    mediaId: `00000000-0000-0000-0000-0000000000${10 + i}`,
  }))
  expect((await send({ text: '@builder x', attachments: many })).statusCode).toBe(400)
  expect(
    (
      await send({
        text: '@builder x',
        attachments: [{ mediaId: '00000000-0000-0000-0000-000000000099' }],
      })
    ).statusCode,
  ).toBe(400)
  const ids: string[] = []
  for (let i = 0; i < 10; i += 1) ids.push(await upload(Buffer.from(`note ${i}`), `n${i}.txt`))
  expect(
    (await send({ text: '@builder x', attachments: ids.map((mediaId) => ({ mediaId })) }))
      .statusCode,
  ).toBe(200)
})
