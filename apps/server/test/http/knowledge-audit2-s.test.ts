import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { KnowledgeTreeSchema, KnowledgeUnzipResultSchema } from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { PNG, makeZip } from '../knowledge/doc-fixtures.ts'
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

const abs = (rel: string) => path.join(dir, 'vault', rel)
/** Runs `work` once, right after conflicts were resolved and just before anything is published. */
function beforePublish(work: () => void) {
  const real = vault.commitOutside.bind(vault)
  vi.spyOn(vault, 'commitOutside').mockImplementationOnce(async () => {
    work()
    return real()
  })
}
const bigImageNote = (mime: string, payload: string) =>
  `# n\n\n![x](data:${mime};base64,${payload})\n`

describe('S2-003 publication never replaces what appeared meanwhile', () => {
  test('ask: a document created after the check stays as it is', async () => {
    beforePublish(() => fs.writeFileSync(abs('d.csv'), 'external,1\n'))
    const res = await put('d.csv', Buffer.from('mine,2\n'))
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('exists')
    expect(fs.readFileSync(abs('d.csv'), 'utf8')).toBe('external,1\n')
  })

  test('keep: the chosen free name is not replaced either', async () => {
    expect((await put('d.csv', Buffer.from('first,1\n'))).statusCode).toBe(201)
    beforePublish(() => fs.writeFileSync(abs('d (2).csv'), 'external,1\n'))
    const res = await put('d.csv', Buffer.from('mine,2\n'), '?onConflict=keep')
    expect(res.statusCode).toBe(409)
    expect(fs.readFileSync(abs('d (2).csv'), 'utf8')).toBe('external,1\n')
    expect(fs.readFileSync(abs('d.csv'), 'utf8')).toBe('first,1\n')
  })

  test('replace: publishes only over the version it saw', async () => {
    expect((await put('d.csv', Buffer.from('first,1\n'))).statusCode).toBe(201)
    beforePublish(() => fs.writeFileSync(abs('d.csv'), 'edited,elsewhere\n'))
    const res = await put('d.csv', Buffer.from('mine,2\n'), '?onConflict=replace')
    expect(res.statusCode).toBe(412)
    expect(fs.readFileSync(abs('d.csv'), 'utf8')).toBe('edited,elsewhere\n')
  })

  test('a note upload is just as safe', async () => {
    beforePublish(() => fs.writeFileSync(abs('n.md'), 'external'))
    const res = await put('n.md', Buffer.from('mine'))
    expect(res.statusCode).toBe(409)
    expect(fs.readFileSync(abs('n.md'), 'utf8')).toBe('external')
  })

  test('zip: ask/keep entries (document and Markdown) that appear meanwhile are skipped, not replaced', async () => {
    const zip = await makeZip({ 'a.md': '# from zip', 'b.csv': 'x,y\n1,2\n', 'c.md': '# free' })
    beforePublish(() => {
      fs.mkdirSync(abs('in'), { recursive: true })
      fs.writeFileSync(abs('in/a.md'), 'external a')
      fs.writeFileSync(abs('in/b.csv'), 'external b')
    })
    const res = await put('in/pack.zip', zip, '?mode=unzip&folder=in')
    expect(res.statusCode).toBe(201)
    const result = KnowledgeUnzipResultSchema.parse(res.json())
    expect(fs.readFileSync(abs('in/a.md'), 'utf8')).toBe('external a')
    expect(fs.readFileSync(abs('in/b.csv'), 'utf8')).toBe('external b')
    expect(result.written).toEqual(['in/c.md'])
    expect(result.skipped.map((item) => item.path).sort()).toEqual(['in/a.md', 'in/b.csv'])
  })

  test('zip with replace only replaces the version it saw', async () => {
    await put('in/a.md', Buffer.from('v1'))
    await put('in/b.csv', Buffer.from('v1,1\n'))
    const zip = await makeZip({ 'a.md': '# from zip', 'b.csv': 'x,y\n1,2\n' })
    beforePublish(() => fs.writeFileSync(abs('in/b.csv'), 'edited,b\n'))
    const res = await put('in/pack.zip', zip, '?mode=unzip&folder=in&onConflict=replace')
    const result = KnowledgeUnzipResultSchema.parse(res.json())
    expect(fs.readFileSync(abs('in/b.csv'), 'utf8')).toBe('edited,b\n')
    expect(fs.readFileSync(abs('in/a.md'), 'utf8')).toBe('# from zip')
    expect(result.skipped.map((item) => item.path)).toEqual(['in/b.csv'])
  })
})

describe('S2-018 zip notes get the checks an upload gets', () => {
  const cases: Array<[string, string]> = [
    ['unsupported image type', bigImageNote('image/svg+xml', 'PHN2Zz48L3N2Zz4=')],
    ['bad base64', bigImageNote('image/png', '@@@notbase64@@@')],
    [
      'wrong magic bytes',
      bigImageNote('image/png', Buffer.from('plain text, not a png').toString('base64')),
    ],
    [
      'too large',
      bigImageNote(
        'image/png',
        Buffer.concat([PNG, randomBytes(2 * 1024 * 1024)]).toString('base64'),
      ),
    ],
  ]
  test.each(cases)('%s: upload and zip agree', async (_name, note) => {
    const single = await put('one.md', Buffer.from(note))
    const zipped = await put(
      'z/pack.zip',
      await makeZip({ 'one.md': note }),
      '?mode=unzip&folder=z',
    )
    const result = KnowledgeUnzipResultSchema.parse(zipped.json())
    expect(single.statusCode).toBeGreaterThanOrEqual(400)
    expect(result.written).toEqual([])
    expect(result.skipped.map((item) => item.path)).toEqual(['one.md'])
    expect(fs.existsSync(abs('z/one.md'))).toBe(false)
    expect(fs.existsSync(abs('one.md'))).toBe(false)
  })
})

describe('S2-019 .markdown and case variants', () => {
  test('upload and zip import end up as .md notes that open, list and move', async () => {
    expect((await put('chapter.markdown', Buffer.from('# one'))).json().path).toBe('chapter.md')
    expect((await put('Big.MD', Buffer.from('# two'))).json().path).toBe('Big.md')
    expect((await put('plain.txt', Buffer.from('three'))).json().path).toBe('plain.md')
    const zipped = await put(
      'p/pack.zip',
      await makeZip({ 'x.markdown': '# x', 'Y.MD': '# y' }),
      '?mode=unzip&folder=p',
    )
    expect(KnowledgeUnzipResultSchema.parse(zipped.json()).written.sort()).toEqual([
      'p/Y.md',
      'p/x.md',
    ])
    const tree = KnowledgeTreeSchema.parse((await call('GET', '/api/knowledge/tree')).json())
    expect(tree.notes.map((note) => note.path)).toEqual(
      expect.arrayContaining(['chapter.md', 'Big.md', 'plain.md', 'p/x.md', 'p/Y.md']),
    )
    const moved = await call('POST', '/api/knowledge/move', {
      from: 'p/x.md',
      to: 'p/renamed.md',
      updateLinks: false,
    })
    expect(moved.statusCode).toBe(200)
  })
})
