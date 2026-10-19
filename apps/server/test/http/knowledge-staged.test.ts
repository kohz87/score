import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { KnowledgeZipPreviewSchema } from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { STAGING_MAX_ENTRIES, ZipStaging } from '../../src/knowledge/staging.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { makeZip } from '../knowledge/doc-fixtures.ts'

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

vi.setConfig({ testTimeout: 30_000 })
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
const stagingDir = () => path.join(dir, 'home', 'knowledge-staging')

describe('staged zips', () => {
  test('preview returns a staged id; keep from it equals the PUT keep', async () => {
    const zip = await makeZip({ 'a.md': '# a' })
    const staged = (await preview('inbox/pack.zip', zip)).staged!
    expect(staged.id).toMatch(/^[A-Za-z0-9_-]{24,}$/)
    expect(staged.expiresAt).toBe(new Date(now + 30 * 60_000).toISOString())
    const kept = await fromStaged({ stagedId: staged.id, path: 'inbox/pack.zip', mode: 'keep' })
    expect(kept.statusCode).toBe(201)
    expect(kept.json()).toMatchObject({ path: 'inbox/pack.zip', kind: 'document', replaced: false })
    const direct = await put('other/pack.zip', zip)
    expect(direct.json()).toMatchObject({ kind: 'document', replaced: false })
  })

  test('unzip from staged gives the PUT result and removes the stage', async () => {
    const zip = await makeZip({ 'a.md': '# a', 'b.csv': 'x,y\n1,2\n', 'c.exe': 'MZ' })
    const staged = (await preview('inbox/pack.zip', zip)).staged!
    const res = await fromStaged({ stagedId: staged.id, path: 'inbox/pack.zip', mode: 'unzip' })
    expect(res.statusCode).toBe(201)
    expect(res.json().folder).toBe('inbox/pack')
    expect(res.json().written.sort()).toEqual(['inbox/pack/a.md', 'inbox/pack/b.csv'])
    expect(
      (await fromStaged({ stagedId: staged.id, path: 'inbox/pack.zip', mode: 'unzip' })).statusCode,
    ).toBe(404)
    expect(fs.readdirSync(stagingDir())).toEqual([])
  })

  test('another path is staged_mismatch and keeps the stage', async () => {
    const staged = (await preview('a.zip', await makeZip({ 'a.md': '# a' }))).staged!
    const res = await fromStaged({ stagedId: staged.id, path: 'b.zip', mode: 'keep' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('staged_mismatch')
    expect(
      (await fromStaged({ stagedId: staged.id, path: 'a.zip', mode: 'keep' })).statusCode,
    ).toBe(201)
  })

  test('unknown, malformed and expired ids', async () => {
    const unknown = await fromStaged({ stagedId: 'A'.repeat(32), path: 'a.zip', mode: 'keep' })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error.code).toBe('staged_gone')
    expect(
      (await fromStaged({ stagedId: '../../etc', path: 'a.zip', mode: 'keep' })).statusCode,
    ).toBe(400)
    const staged = (await preview('a.zip', await makeZip({ 'a.md': '# a' }))).staged!
    now += 31 * 60_000
    const late = await fromStaged({ stagedId: staged.id, path: 'a.zip', mode: 'keep' })
    expect(late.statusCode).toBe(404)
    expect(late.json().error.code).toBe('staged_gone')
    expect(fs.readdirSync(stagingDir())).toEqual([])
  })

  test('a 409 exists keeps the stage so the retry works', async () => {
    const zip = await makeZip({ 'a.md': '# a' })
    await put('a.zip', zip)
    const staged = (await preview('a.zip', zip)).staged!
    const first = await fromStaged({ stagedId: staged.id, path: 'a.zip', mode: 'keep' })
    expect(first.statusCode).toBe(409)
    expect(first.json().error.code).toBe('exists')
    const retry = await fromStaged({
      stagedId: staged.id,
      path: 'a.zip',
      mode: 'keep',
      onConflict: 'replace',
    })
    expect(retry.statusCode).toBe(201)
    expect(retry.json().replaced).toBe(true)
  })

  test('files are 0600 under random names, folder 0700', async () => {
    const staged = (
      await preview('../evil name.zip'.replace('../', ''), await makeZip({ 'a.md': '# a' }))
    ).staged!
    expect(fs.readdirSync(stagingDir())).toEqual([staged.id])
    expect(fs.statSync(stagingDir()).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(stagingDir(), staged.id)).mode & 0o777).toBe(0o600)
  })

  test('start-up empties the staging folder', async () => {
    await preview('a.zip', await makeZip({ 'a.md': '# a' }))
    expect(fs.readdirSync(stagingDir()).length).toBe(1)
    await shutdown()
    await boot()
    expect(fs.readdirSync(stagingDir())).toEqual([])
  })
})

describe('ZipStaging bounds', () => {
  test('keeps at most 8 entries, evicting the oldest', async () => {
    const store = new ZipStaging(path.join(dir, 'st1'), () => now)
    const ids: string[] = []
    for (let i = 0; i < STAGING_MAX_ENTRIES + 1; i++)
      ids.push((await store.put(`${i}.zip`, Buffer.from('x')))!.id)
    expect(await store.read(ids[0]!, '0.zip')).toBe('gone')
    expect(Buffer.isBuffer(await store.read(ids[1]!, '1.zip'))).toBe(true)
    expect(fs.readdirSync(path.join(dir, 'st1')).length).toBe(8)
  })

  test('evicts the oldest to stay under the byte cap; an oversize zip is not kept', async () => {
    const store = new ZipStaging(path.join(dir, 'st2'), () => now, 100)
    const a = (await store.put('a.zip', Buffer.alloc(60)))!
    const b = (await store.put('b.zip', Buffer.alloc(60)))!
    expect(await store.read(a.id, 'a.zip')).toBe('gone')
    expect(Buffer.isBuffer(await store.read(b.id, 'b.zip'))).toBe(true)
    expect(await store.put('c.zip', Buffer.alloc(101))).toBeNull()
  })
})
