import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  KnowledgeDocumentSchema,
  KnowledgeInfoSchema,
  KnowledgeSearchResponseSchema,
  KnowledgeTreeSchema,
  KnowledgeUnzipResultSchema,
  KnowledgeUploadResultSchema,
  KnowledgeZipPreviewSchema,
} from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { PNG, makeZip, textPdf } from '../knowledge/doc-fixtures.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'

let dir: string
let app: ReturnType<typeof buildApp>
let db: ScoreDb
let ingest: Ingest
let vault: KnowledgeVault
let cookie = ''

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-kn-http-')))
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
  await ingest.close()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const human = () => ({ 'x-score-client': 'web', cookie })
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
const put = (
  target: string,
  bytes: Buffer,
  query = '',
  headers: Record<string, string> = human(),
) =>
  app.inject({
    method: 'PUT',
    url: `/api/knowledge/files/${enc(target)}${query}`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: bytes,
  })
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: human(), ...(payload ? { payload } : {}) })

vi.setConfig({ testTimeout: 30_000 })

describe('document routes', () => {
  test('upload, tree, document, search, download match the contract', async () => {
    const res = await put('reports/q3.pdf', textPdf('Zeppelin quarterly'))
    expect(res.statusCode).toBe(201)
    expect(KnowledgeUploadResultSchema.parse(res.json())).toEqual({
      path: 'reports/q3.pdf',
      kind: 'document',
      replaced: false,
    })
    const tree = KnowledgeTreeSchema.parse((await call('GET', '/api/knowledge/tree')).json())
    expect(tree.documents[0]).toMatchObject({
      path: 'reports/q3.pdf',
      type: 'pdf',
      versioned: true,
    })
    expect(KnowledgeInfoSchema.parse((await call('GET', '/api/knowledge')).json()).documents).toBe(
      1,
    )
    const doc = KnowledgeDocumentSchema.parse(
      (await call('GET', `/api/knowledge/documents/${enc('reports/q3.pdf')}`)).json(),
    )
    expect(doc.text).toContain('Zeppelin quarterly')
    const search = KnowledgeSearchResponseSchema.parse(
      (await call('GET', '/api/knowledge/search?q=zeppelin')).json(),
    )
    expect(search.items[0]).toMatchObject({ kind: 'document', type: 'pdf' })
    const file = await call('GET', `/api/knowledge/files/${enc('reports/q3.pdf')}`)
    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toBe('application/octet-stream')
    expect(file.headers['content-disposition']).toMatch(/^attachment/)
    expect(file.headers['x-content-type-options']).toBe('nosniff')
    expect(file.headers['content-security-policy']).toContain('sandbox')
    expect(file.rawPayload.equals(textPdf('Zeppelin quarterly'))).toBe(true)
  })

  test('images are served inline, HTML only as a download', async () => {
    await put('p/logo.png', PNG)
    await put('p/page.html', Buffer.from('<script>alert(1)</script><p>hi</p>'))
    const image = await call('GET', `/api/knowledge/files/${enc('p/logo.png')}`)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.headers['content-disposition']).toBe('inline')
    const html = await call('GET', `/api/knowledge/files/${enc('p/page.html')}`)
    expect(html.headers['content-type']).toBe('application/octet-stream')
    expect(html.headers['content-disposition']).toMatch(/^attachment/)
  })

  test('uploads need a paired browser, and the raw parser is not open elsewhere', async () => {
    expect((await put('a.png', PNG, '', { 'x-score-client': 'web' })).statusCode).toBe(401)
    const other = await app.inject({
      method: 'PUT',
      url: '/api/knowledge/notes/x.md',
      headers: { ...human(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    })
    expect(other.statusCode).toBeGreaterThanOrEqual(400)
  })

  test('errors: unsupported 415, too large 413, bad path 400, clash 409 then keep/replace', async () => {
    expect((await put('a.exe', Buffer.from('MZ'))).statusCode).toBe(415)
    const traversal = await app.inject({
      method: 'PUT',
      url: '/api/knowledge/files/x%2F..%2F..%2Fa.png',
      headers: { ...human(), 'content-type': 'application/octet-stream' },
      payload: PNG,
    })
    expect(traversal.statusCode).toBe(400)
    expect(
      (await put('big.png', Buffer.concat([PNG, Buffer.alloc(26 * 1024 * 1024)]))).statusCode,
    ).toBe(413)
    await put('c.png', PNG)
    const clash = await put('c.png', PNG)
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.details.existing[0].path).toBe('c.png')
    expect(
      KnowledgeUploadResultSchema.parse((await put('c.png', PNG, '?onConflict=keep')).json()).path,
    ).toBe('c (2).png')
    expect((await put('c.png', PNG, '?onConflict=replace')).json().replaced).toBe(true)
  })

  test('move and delete a document; delete needs pairing', async () => {
    await put('m/a.png', PNG)
    const moved = await call('POST', '/api/knowledge/move', {
      from: 'm/a.png',
      to: 'm/b.png',
      updateLinks: true,
    })
    expect(moved.json()).toEqual({ path: 'm/b.png', updatedNotes: 0, skipped: [] })
    const unpaired = await app.inject({
      method: 'DELETE',
      url: `/api/knowledge/documents/${enc('m/b.png')}`,
      headers: { 'x-score-client': 'web' },
    })
    expect(unpaired.statusCode).toBe(401)
    expect((await call('DELETE', `/api/knowledge/documents/${enc('m/b.png')}`)).statusCode).toBe(
      204,
    )
    expect((await call('GET', `/api/knowledge/documents/${enc('m/b.png')}`)).statusCode).toBe(404)
  })

  test('folders: create and delete when empty', async () => {
    expect((await call('POST', '/api/knowledge/folders', { path: 'fresh/inbox' })).statusCode).toBe(
      201,
    )
    expect(
      KnowledgeTreeSchema.parse((await call('GET', '/api/knowledge/tree')).json()).folders,
    ).toContain('fresh/inbox')
    expect((await call('POST', '/api/knowledge/folders', { path: 'fresh/inbox' })).statusCode).toBe(
      409,
    )
    expect((await call('DELETE', '/api/knowledge/folders/fresh/inbox')).statusCode).toBe(204)
  })

  test('save a chat upload into Knowledge', async () => {
    const stored = app.media!.store(textPdf('From the chat'), 'application/pdf', 'chat.pdf')
    const res = await call('POST', '/api/knowledge/files-from-media', {
      mediaId: stored.mediaId,
      path: 'inbox/chat.pdf',
    })
    expect(res.statusCode).toBe(201)
    expect((await vault.docs.get('inbox/chat.pdf')).text).toContain('From the chat')
    expect(
      (
        await call('POST', '/api/knowledge/files-from-media', {
          mediaId: stored.mediaId,
          path: 'inbox/chat.pdf',
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await call('POST', '/api/knowledge/files-from-media', {
          mediaId: 'nope',
          path: 'inbox/x.pdf',
        })
      ).statusCode,
    ).toBe(404)
  })
})

describe('zip routes', () => {
  test('preview stores nothing; unzip extracts into the folder; keep stores the zip', async () => {
    const zip = await makeZip({ 'a.md': '# a', 'b.csv': 'x,y\n1,2\n', 'c.exe': 'MZ' })
    const preview = KnowledgeZipPreviewSchema.parse(
      (await put('pack.zip', zip, '?mode=preview')).json(),
    )
    expect(preview.extractCount).toBe(2)
    expect((await call('GET', '/api/knowledge/tree')).json().documents).toEqual([])
    const unzipped = await put('inbox/pack.zip', zip, '?mode=unzip')
    expect(unzipped.statusCode).toBe(201)
    const result = KnowledgeUnzipResultSchema.parse(unzipped.json())
    expect(result.folder).toBe('inbox/pack')
    expect(result.written.sort()).toEqual(['inbox/pack/a.md', 'inbox/pack/b.csv'])
    const again = await put('inbox/pack.zip', zip, '?mode=unzip&folder=inbox%2Fpack')
    expect(again.statusCode).toBe(409)
    const kept = KnowledgeUploadResultSchema.parse((await put('inbox/pack.zip', zip)).json())
    expect(kept).toMatchObject({ path: 'inbox/pack.zip', kind: 'document' })
    const bomb = await makeZip({ 'z.csv': Buffer.alloc(2 * 1024 * 1024, 0x61) })
    const refused = await put('bomb.zip', bomb, '?mode=unzip')
    expect(refused.statusCode).toBe(413)
    expect(refused.json().error.code).toBe('zip_limits')
  })
})
