import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { KnowledgeExportSummarySchema } from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import JSZip from 'jszip'
import { PNG, textPdf } from '../knowledge/doc-fixtures.ts'
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
    seed: false,
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

vi.setConfig({ testTimeout: 60_000 })

const post = (url: string, payload: object, headers: Record<string, string> = human()) =>
  app.inject({ method: 'POST', url, headers, payload })
const note = (target: string, body: string, frontmatter: Record<string, unknown> = {}) =>
  app.inject({
    method: 'PUT',
    url: `/api/knowledge/notes/${enc(target)}`,
    headers: human(),
    payload: { body, frontmatter, etag: null },
  })
const unzip = async (res: { rawPayload: Buffer }) => {
  const zip = await JSZip.loadAsync(res.rawPayload)
  const out: Record<string, Buffer> = {}
  for (const [name, entry] of Object.entries(zip.files))
    if (!entry.dir) out[name] = await entry.async('nodebuffer')
  return out
}

describe('single note download', () => {
  test('returns the stored bytes, frontmatter and non-ASCII name included', async () => {
    expect(
      (await note('Café/日本語 ノート.md', 'Héllo\n\n[[Other]]\n', { tags: ['a', 'é'] }))
        .statusCode,
    ).toBe(200)
    const res = await call('GET', `/api/knowledge/notes/${enc('Café/日本語 ノート.md')}?download=1`)
    expect(res.statusCode).toBe(200)
    const onDisk = fs.readFileSync(path.join(vault.vault, 'Café', '日本語 ノート.md'))
    expect(res.rawPayload.equals(onDisk)).toBe(true)
    expect(onDisk.toString('utf8')).toMatch(/^---\n/)
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('日本語 ノート.md')}`,
    )
  })

  test('a missing note is 404 and a non-note path 400', async () => {
    expect((await call('GET', '/api/knowledge/notes/nope.md?download=1')).statusCode).toBe(404)
    expect((await call('GET', '/api/knowledge/notes/a.pdf?download=1')).statusCode).toBe(400)
  })
})

describe('export', () => {
  beforeEach(async () => {
    await note('top.md', 'top')
    await note('proj/plan.md', 'plan', { title: 'Plan' })
    await note('proj/deep/more.md', 'more')
    await put('proj/report.pdf', textPdf('Quarterly'))
    await put('proj/logo.png', PNG)
    await put('other/x.pdf', textPdf('Other'))
  })

  test('a folder keeps paths relative to the folder, with exact bytes and a README', async () => {
    const res = await post('/api/knowledge/export', { folder: 'proj' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/zip')
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="knowledge-proj-${new Date().toISOString().slice(0, 10)}.zip"`,
    )
    const files = await unzip(res)
    expect(
      Object.keys((await JSZip.loadAsync(res.rawPayload)).files).some((n) => n.endsWith('/')),
    ).toBe(false)
    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'deep/more.md',
      'logo.png',
      'plan.md',
      'report.pdf',
    ])
    expect(files['plan.md']!.equals(fs.readFileSync(path.join(vault.vault, 'proj/plan.md')))).toBe(
      true,
    )
    expect(files['report.pdf']!.equals(textPdf('Quarterly'))).toBe(true)
    expect(files['logo.png']!.equals(PNG)).toBe(true)
    expect(files['README.txt']!.toString()).toContain('Exported from Score Knowledge')
  })

  test('a selection keeps vault paths; the whole vault leaves out git, dot files and symlinks', async () => {
    const picked = await unzip(
      await post('/api/knowledge/export', { paths: ['top.md', 'proj/report.pdf', 'top.md'] }),
    )
    expect(Object.keys(picked).sort()).toEqual(['README.txt', 'proj/report.pdf', 'top.md'])

    fs.writeFileSync(path.join(vault.vault, '.hidden.md'), 'secret')
    fs.mkdirSync(path.join(vault.vault, '.private'))
    fs.writeFileSync(path.join(vault.vault, '.private', 'n.md'), 'secret')
    fs.symlinkSync('/etc/hostname', path.join(vault.vault, 'link.md'))
    const res = await post('/api/knowledge/export', { all: true })
    expect(res.headers['content-disposition']).toMatch(/knowledge-vault-\d{4}-\d{2}-\d{2}\.zip/)
    const all = await unzip(res)
    const names = Object.keys(all).sort()
    expect(names).toEqual([
      'README.md',
      'README.txt',
      'other/x.pdf',
      'proj/deep/more.md',
      'proj/logo.png',
      'proj/plan.md',
      'proj/report.pdf',
      'top.md',
    ])
    expect(names.some((name) => name.includes('.git') || name.includes('link'))).toBe(false)
  })

  test('summary reports files and bytes; bad requests are refused', async () => {
    const summary = KnowledgeExportSummarySchema.parse(
      (await post('/api/knowledge/export/summary', { folder: 'other' })).json(),
    )
    expect(summary).toEqual({ files: 1, bytes: textPdf('Other').length, label: 'folder' })
    expect((await post('/api/knowledge/export', {})).statusCode).toBe(400)
    expect((await post('/api/knowledge/export', { all: true, folder: 'proj' })).statusCode).toBe(
      400,
    )
    expect((await post('/api/knowledge/export', { paths: ['missing.md'] })).statusCode).toBe(404)
    expect((await post('/api/knowledge/export', { folder: 'nope' })).statusCode).toBe(404)
    expect((await post('/api/knowledge/export', { paths: ['../x.md'] })).statusCode).toBe(400)
    expect((await post('/api/knowledge/export', { paths: ['.git/config'] })).statusCode).toBe(400)
  })

  test('needs a paired browser', async () => {
    const headers = { 'x-score-client': 'web' }
    expect((await post('/api/knowledge/export', { all: true }, headers)).statusCode).toBe(401)
    expect((await post('/api/knowledge/export/summary', { all: true }, headers)).statusCode).toBe(
      401,
    )
  })
})
