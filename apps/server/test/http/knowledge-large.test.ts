import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { KnowledgeDocumentSchema, KnowledgeZipPreviewSchema } from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { STAGING_MAX_BYTES } from '../../src/knowledge/staging.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { MAX_STORE_BYTES } from '../../src/knowledge/doc-types.ts'
import { PNG, makeZip } from '../knowledge/doc-fixtures.ts'

let dir: string
let app: ReturnType<typeof buildApp>
let db: ScoreDb
let ingest: Ingest
let vault: KnowledgeVault
let cookie = ''
let now = Date.parse('2026-10-19T00:00:00Z')

async function boot() {
  db = openDatabase(path.join(dir, 'home', 'score.db'))
  migrate(db, new URL('../../migrations/', import.meta.url).pathname)
  ingest = createIngest(db)
  vault = new KnowledgeVault({
    vault: path.join(dir, 'vault'),
    db,
    seed: true,
    watch: false,
    emit: (change) =>
      ingest.submit({
        source: 'knowledge',
        identity: randomUUID(),
        apply: () => [{ type: 'knowledge.changed', data: change }],
      }),
  })
  await vault.start()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: path.join(dir, 'home') }),
    logger: false,
    port: new FakePort(1, {}, false),
    knowledge: vault,
    db,
    ingest,
    clock: () => now,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
}
async function shutdown() {
  await app.close()
  await vault.close()
  await ingest.close()
  db.close()
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-kn-staged-')))
  now = Date.parse('2026-10-19T00:00:00Z')
  await boot()
})
afterEach(async () => {
  await shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
})

vi.setConfig({ testTimeout: 60_000 })
const human = () => ({ 'x-score-client': 'web', cookie })
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
const put = (target: string, bytes: Buffer, query = '') =>
  app.inject({
    method: 'PUT',
    url: `/api/knowledge/files/${enc(target)}${query}`,
    headers: { ...human(), 'content-type': 'application/octet-stream' },
    payload: bytes,
  })
const fromStaged = (payload: object) =>
  app.inject({
    method: 'POST',
    url: '/api/knowledge/files-from-staged',
    headers: human(),
    payload,
  })
const preview = async (target: string, bytes: Buffer) => {
  const res = await put(target, bytes, '?mode=preview')
  expect(res.statusCode).toBe(200)
  return KnowledgeZipPreviewSchema.parse(res.json())
}

const MB = 1024 * 1024
const bigPng = (mb: number) => Buffer.concat([PNG, Buffer.alloc(mb * MB)])

describe('big files over HTTP', () => {
  test('staging holds up to 1 GB', () => {
    expect(STAGING_MAX_BYTES).toBe(1024 * MB)
  })

  test('a 100 MB PUT, document read and a streamed 100 MB download', async () => {
    const png = bigPng(100)
    const res = await put('big/pic.png', png)
    expect(res.statusCode).toBe(201)
    const doc = KnowledgeDocumentSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/knowledge/documents/big/pic.png' })).json(),
    )
    expect(doc).toMatchObject({ size: png.length, textStatus: 'too_large' })
    const read = vi.spyOn(vault, 'readContainedBuffer')
    const readFile = vi.spyOn(fs.promises, 'readFile')
    const down = await app.inject({
      method: 'GET',
      url: '/api/knowledge/files/big/pic.png?download=1',
    })
    expect(down.statusCode).toBe(200)
    expect(down.headers['content-length']).toBe(String(png.length))
    expect(down.headers['content-disposition']).toContain('attachment')
    expect(down.rawPayload.equals(png)).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    const inline = await app.inject({ method: 'GET', url: '/api/knowledge/files/big/pic.png' })
    expect(inline.headers['content-type']).toBe('image/png')
    expect(inline.headers['content-disposition']).toBe('inline')
  })

  test('the download reply is the opened stream, consumed to its end', async () => {
    await put('s.png', bigPng(30))
    const open = vi.spyOn(vault.docs, 'open')
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/files/s.png' })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.length).toBe(PNG.length + 30 * MB)
    const opened = await open.mock.results[0]!.value
    expect(typeof opened.stream.pipe).toBe('function')
    expect(opened.stream.readableEnded || opened.stream.destroyed).toBe(true)
  })

  test('256 MB plus one byte is 413, before anything is stored', async () => {
    const res = await put('huge.png', Buffer.alloc(MAX_STORE_BYTES + 1))
    expect(res.statusCode).toBe(413)
    expect(fs.existsSync(path.join(dir, 'vault', 'huge.png'))).toBe(false)
  })

  test('256 MB plus one is 413 in keep, preview and unzip mode alike', async () => {
    // Fastify's parser allows 1 KiB of slack; the cap itself is exact.
    const body = Buffer.concat([Buffer.from([0x50, 0x4b, 5, 6]), Buffer.alloc(MAX_STORE_BYTES - 3)])
    expect(body.length).toBe(MAX_STORE_BYTES + 1)
    for (const query of ['', '?mode=preview', '?mode=unzip']) {
      const res = await put('cap.zip', body, query)
      expect(res.statusCode, query).toBe(413)
    }
  })

  test('a 100 MB zip: preview is staged, unzip from staged and keep both work', async () => {
    const zip = await makeZip({ 'inner.png': bigPng(100), 'a.md': '# a' }, 'STORE')
    const staged = (await preview('inbox/pack.zip', zip)).staged
    expect(staged).not.toBeNull()
    const unzipped = await fromStaged({
      stagedId: staged!.id,
      path: 'inbox/pack.zip',
      mode: 'unzip',
    })
    expect(unzipped.statusCode).toBe(201)
    expect(unzipped.json().written.sort()).toEqual(['inbox/pack/a.md', 'inbox/pack/inner.png'])
    const direct = await put('direct/pack.zip', zip, '?mode=unzip')
    expect(direct.statusCode).toBe(201)
    expect(direct.json().written).toContain('direct/pack/inner.png')
    const kept = await put('kept.zip', zip)
    expect(kept.statusCode).toBe(201)
    expect(
      KnowledgeDocumentSchema.parse(
        (await app.inject({ method: 'GET', url: '/api/knowledge/documents/kept.zip' })).json(),
      ).textStatus,
    ).toBe('too_large')
  })
})
