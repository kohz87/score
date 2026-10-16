import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  KnowledgeTreeSchema,
  KnowledgeUnzipResultSchema,
  KnowledgeUploadResultSchema,
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
let vaultDir: string

const makeVault = () =>
  new KnowledgeVault({
    vault: vaultDir,
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

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-kn-a5k-')))
  vaultDir = path.join(dir, 'vault')
  // The ignore rule is in place before the vault first looks at the folder.
  fs.mkdirSync(vaultDir)
  fs.writeFileSync(path.join(vaultDir, '.gitignore'), 'private/\n')
  db = openDatabase(path.join(dir, 'home', 'score.db'))
  migrate(db, new URL('../../migrations/', import.meta.url).pathname)
  ingest = createIngest(db)
  vault = makeVault()
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
const put = (target: string, bytes: Buffer, query = '') =>
  app.inject({
    method: 'PUT',
    url: `/api/knowledge/files/${enc(target)}${query}`,
    headers: { ...human(), 'content-type': 'application/octet-stream' },
    payload: bytes,
  })
const tree = async () =>
  KnowledgeTreeSchema.parse(
    (await app.inject({ method: 'GET', url: '/api/knowledge/tree', headers: human() })).json(),
  )
const git = (...args: string[]) =>
  execFileSync('git', ['-C', vaultDir, ...args], { encoding: 'utf8' })

vi.setConfig({ testTimeout: 30_000 })

const CSV = Buffer.from('a,b\n1,2\n')

describe('S5-005 documents follow the same history policy as notes', () => {
  test('an ignored CSV, image and PDF are stored, reported not_versioned and never force-added', async () => {
    for (const [name, bytes] of [
      ['private/data.csv', CSV],
      ['private/pic.png', PNG],
      ['private/doc.pdf', textPdf('Secret')],
    ] as const) {
      const res = await put(name, bytes)
      expect(res.statusCode).toBe(201)
      expect(KnowledgeUploadResultSchema.parse(res.json())).toMatchObject({
        path: name,
        kind: 'document',
        history: 'not_versioned',
      })
      expect(fs.existsSync(path.join(vaultDir, name))).toBe(true)
    }
    const documents = (await tree()).documents.filter((item) => item.path.startsWith('private/'))
    expect(documents).toHaveLength(3)
    expect(documents.every((item) => !item.versioned)).toBe(true)
    expect(git('ls-files')).not.toContain('private/')
    // A normal folder still gets history.
    const normal = await put('open/data.csv', CSV)
    expect(KnowledgeUploadResultSchema.parse(normal.json()).history).toBe('committed')
    expect(git('ls-files')).toContain('open/data.csv')
  })

  test('an ignored note upload says not_versioned too', async () => {
    const res = await put('private/n.md', Buffer.from('# N'))
    expect(KnowledgeUploadResultSchema.parse(res.json())).toMatchObject({
      kind: 'note',
      history: 'not_versioned',
    })
  })

  test('a zip import into an ignored folder reports not_versioned; into a normal one, committed', async () => {
    const zip = await makeZip({ 'a.csv': CSV, 'b.png': PNG, 'n.md': '# N' })
    const hidden = await put('private/pack.zip', zip, '?mode=unzip&folder=private%2Fpack')
    expect(KnowledgeUnzipResultSchema.parse(hidden.json())).toMatchObject({
      written: expect.arrayContaining(['private/pack/a.csv', 'private/pack/b.png']),
      history: 'not_versioned',
    })
    expect(git('ls-files')).not.toContain('private/pack')
    const shown = await put('pack.zip', zip, '?mode=unzip&folder=pack')
    expect(KnowledgeUnzipResultSchema.parse(shown.json()).history).toBe('committed')
    expect(git('ls-files')).toContain('pack/a.csv')
    const rows = (await tree()).documents.filter((item) => item.path.startsWith('private/'))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((item) => !item.versioned)).toBe(true)
  })

  test('a commit failure is reported for an upload and a zip import, and the files stay', async () => {
    const lock = path.join(vaultDir, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    const zip = await put('pack.zip', await makeZip({ 'a.csv': CSV }), '?mode=unzip&folder=pack')
    expect(KnowledgeUnzipResultSchema.parse(zip.json()).history).toBe('failed')
    expect(fs.existsSync(path.join(vaultDir, 'pack', 'a.csv'))).toBe(true)
    fs.rmSync(lock)
    // The next change records the leftovers as "Outside changes", then fails on its own commit.
    const clean = await put('open/first.csv', CSV)
    expect(KnowledgeUploadResultSchema.parse(clean.json()).history).toBe('committed')
    fs.writeFileSync(lock, '')
    const up = await put('open/data.csv', CSV)
    expect(up.statusCode).toBe(201)
    expect(KnowledgeUploadResultSchema.parse(up.json()).history).toBe('failed')
    expect(fs.existsSync(path.join(vaultDir, 'open', 'data.csv'))).toBe(true)
    fs.rmSync(lock)
    const again = await put('open/data.csv', CSV, '?onConflict=replace')
    // The earlier file is recorded as "Outside changes" first, so the replace itself has nothing new to commit.
    expect(KnowledgeUploadResultSchema.parse(again.json()).history).toBe('unchanged')
    expect(git('ls-files')).toContain('open/data.csv')
  })

  test('a scan classifies a file dropped into an ignored folder; a restart repairs old rows', async () => {
    fs.mkdirSync(path.join(vaultDir, 'private'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, 'private', 'dropped.csv'), CSV)
    fs.mkdirSync(path.join(vaultDir, 'open'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, 'open', 'dropped.csv'), CSV)
    await vault.scanNow()
    let rows = new Map((await tree()).documents.map((item) => [item.path, item.versioned]))
    expect(rows.get('private/dropped.csv')).toBe(false)
    expect(rows.get('open/dropped.csv')).toBe(true)

    // Rows as an older Score left them: ignored path marked versioned, and a small file marked not versioned.
    db.tx((sqlite) => {
      sqlite
        .prepare("UPDATE knowledge_documents SET versioned = 1 WHERE path = 'private/dropped.csv'")
        .run()
      sqlite
        .prepare("UPDATE knowledge_documents SET versioned = 0 WHERE path = 'open/dropped.csv'")
        .run()
    })
    await vault.close()
    vault = makeVault()
    await vault.start()
    rows = new Map(vault.docs.list().map((item) => [item.path, item.versioned]))
    expect(rows.get('private/dropped.csv')).toBe(false)
    expect(rows.get('open/dropped.csv')).toBe(true)
  })

  test('a tracked document keeps its history even when a rule later matches it', async () => {
    const first = await put('keep/data.csv', CSV)
    expect(KnowledgeUploadResultSchema.parse(first.json()).history).toBe('committed')
    fs.writeFileSync(path.join(vaultDir, '.gitignore'), 'private/\nkeep/\n')
    const second = await put('keep/data.csv', Buffer.from('a,b\n3,4\n'), '?onConflict=replace')
    expect(KnowledgeUploadResultSchema.parse(second.json()).history).toBe('committed')
    expect((await tree()).documents.find((item) => item.path === 'keep/data.csv')?.versioned).toBe(
      true,
    )
  })
})
