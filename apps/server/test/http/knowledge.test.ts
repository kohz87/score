import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  KnowledgeHistorySchema,
  KnowledgeInfoSchema,
  KnowledgeNoteSchema,
  KnowledgeSearchResponseSchema,
  KnowledgeTreeSchema,
} from '@score/contract'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
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
const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = human(),
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const N = '/api/knowledge/notes/'
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
const knowledgeEvents = () =>
  (
    db.sqlite
      .prepare("SELECT data FROM events WHERE type = 'knowledge.changed' ORDER BY seq")
      .all() as Array<{ data: string }>
  ).map((row) => JSON.parse(row.data) as unknown)

describe('reads', () => {
  test('info, tree, note, search match the contract', async () => {
    const info = KnowledgeInfoSchema.parse((await call('GET', '/api/knowledge')).json())
    expect(info).toMatchObject({
      vault: path.join(dir, 'vault'),
      gitAvailable: true,
      agentAccess: true,
    })
    expect(info.notes).toBeGreaterThanOrEqual(4)
    const tree = KnowledgeTreeSchema.parse((await call('GET', '/api/knowledge/tree')).json())
    expect(tree.folders).toContain('Projects')
    expect(tree.notes.map((n) => n.path)).toContain('Projects/Roadmap.md')
    const note = KnowledgeNoteSchema.parse(
      (await call('GET', `${N}${enc('Projects/Roadmap.md')}`)).json(),
    )
    expect(note.title).toBe('Roadmap')
    expect(note.backlinks.map((b) => b.path)).toContain('Welcome.md')
    expect(note.links).toContainEqual({ target: 'Glossary#Handoff', path: 'Glossary.md' })
    const search = KnowledgeSearchResponseSchema.parse(
      (await call('GET', '/api/knowledge/search?q=handoff&limit=5')).json(),
    )
    expect(search.items.map((i) => i.path)).toContain('Glossary.md')
    expect(search.items[0]?.snippet).toContain('[[')
    expect((await call('GET', '/api/knowledge/search?q=%22%20OR%20NEAR(')).json().items).toEqual([])
    expect((await call('GET', '/api/knowledge/search?limit=51')).statusCode).toBe(400)
  })

  test('errors: missing 404, outside the vault 400 bad_path, not a note 400', async () => {
    expect((await call('GET', `${N}nope.md`)).json()).toMatchObject({
      error: { code: 'not_found' },
    })
    expect((await call('GET', `${N}..%2F..%2Fetc%2Fpasswd.md`)).json()).toMatchObject({
      error: { code: 'bad_path' },
    })
    expect((await call('GET', `${N}%2Fetc%2Fpasswd.md`)).json()).toMatchObject({
      error: { code: 'bad_path' },
    })
    expect((await call('GET', `${N}a%00b.md`)).json()).toMatchObject({
      error: { code: 'bad_path' },
    })
    expect((await call('GET', `${N}.git/config`)).json()).toMatchObject({
      error: { code: 'bad_path' },
    })
    expect((await call('GET', `${N}Welcome.txt`)).json()).toMatchObject({
      error: { code: 'not_a_note' },
    })
    expect((await call('GET', `${N}x/history`)).statusCode).toBe(400)
  })
})

describe('writes', () => {
  test('every write needs a paired browser', async () => {
    const none = { 'x-score-client': 'web' }
    for (const [method, url, body] of [
      ['PUT', `${N}a.md`, { body: 'x', etag: null }],
      ['DELETE', `${N}Welcome.md`, undefined],
      ['POST', '/api/knowledge/move', { from: 'Welcome.md', to: 'x.md', updateLinks: true }],
      ['POST', `${N}Welcome.md/restore`, { commit: 'abcdef0' }],
      ['PUT', '/api/knowledge/settings', { agentAccess: false }],
    ] as const) {
      const response = await call(method, url, body, none)
      expect(response.statusCode, `${method} ${url}`).toBe(401)
    }
    expect(fs.existsSync(path.join(dir, 'vault', 'Welcome.md'))).toBe(true)
  })

  test('PUT creates, updates with etag, 412 carries the current etag, 409 on an existing create', async () => {
    const created = await call('PUT', `${N}${enc('New ideas/Idea one.md')}`, {
      body: '# Idea\n[[Welcome]]',
      etag: null,
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({ etag: expect.any(String), path: 'New ideas/Idea one.md' })
    const dup = await call('PUT', `${N}${enc('New ideas/Idea one.md')}`, {
      body: 'again',
      etag: null,
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ error: { code: 'exists' } })
    const etag = created.json().etag as string
    const updated = await call('PUT', `${N}${enc('New ideas/Idea one.md')}`, {
      body: '# Idea\nv2',
      etag,
    })
    expect(updated.statusCode).toBe(200)
    const stale = await call('PUT', `${N}${enc('New ideas/Idea one.md')}`, { body: 'old', etag })
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toMatchObject({
      error: { code: 'precondition_failed', details: { etag: updated.json().etag } },
    })
    const read = KnowledgeNoteSchema.parse(
      (await call('GET', `${N}${enc('New ideas/Idea one.md')}`)).json(),
    )
    expect(read.body).toBe('# Idea\nv2')
    expect(read.lastAuthor).toBe('you')
    expect(knowledgeEvents()).toContainEqual({
      path: 'New ideas/Idea one.md',
      kind: 'written',
      to: null,
      by: 'you',
    })
  })

  test('embedded images: PNG accepted, SVG and a lying type refused, an oversized image 413', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const put = (name: string, body: string) => call('PUT', `${N}${name}.md`, { body, etag: null })
    expect((await put('img-ok', `![a](data:image/png;base64,${png})`)).statusCode).toBe(200)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    const refused = await put('img-svg', `![a](data:image/svg+xml;base64,${svg})`)
    expect(refused.statusCode).toBe(415)
    expect(refused.json()).toMatchObject({ error: { code: 'unsupported_type' } })
    const jpegAsPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64')
    expect((await put('img-lie', `![a](data:image/png;base64,${jpegAsPng})`)).statusCode).toBe(415)
    const header = Buffer.from(png, 'base64').subarray(0, 8)
    const big = Buffer.concat([header, Buffer.alloc(1.6 * 1024 * 1024)]).toString('base64')
    expect((await put('img-big', `![a](data:image/png;base64,${big})`)).statusCode).toBe(413)
  })

  test('validation and size: bad bodies 400, a note over 8 MiB 413, near 8 MiB works', async () => {
    expect((await call('PUT', `${N}a.md`, { body: 1, etag: null })).statusCode).toBe(400)
    expect((await call('PUT', `${N}a.md`, { body: 'x' })).statusCode).toBe(400)
    const big = await call('PUT', `${N}big.md`, {
      body: 'a'.repeat(8 * 1024 * 1024 + 1),
      etag: null,
    })
    expect(big.statusCode).toBe(413)
    const ok = await call('PUT', `${N}ok.md`, { body: 'a'.repeat(8 * 1024 * 1024), etag: null })
    expect(ok.statusCode).toBe(200)
    expect((await call('PUT', `${N}..%2Fx.md`, { body: 'x', etag: null })).statusCode).toBe(400)
    expect((await call('PUT', `${N}x.txt`, { body: 'x', etag: null })).json()).toMatchObject({
      error: { code: 'not_a_note' },
    })
  })

  test('move rewrites links and reports the count; 409 when the target exists', async () => {
    const moved = await call('POST', '/api/knowledge/move', {
      from: 'Glossary.md',
      to: 'Reference/Terms.md',
      updateLinks: true,
    })
    expect(moved.json()).toEqual({ path: 'Reference/Terms.md', updatedNotes: 3 })
    const roadmap = (await call('GET', `${N}${enc('Projects/Roadmap.md')}`)).json()
    expect(roadmap.body).toContain('[[Terms#Handoff|glossary]]')
    expect(roadmap.links).toContainEqual({ target: 'Terms#Handoff', path: 'Reference/Terms.md' })
    const clash = await call('POST', '/api/knowledge/move', {
      from: 'Welcome.md',
      to: 'Meeting notes.md',
      updateLinks: true,
    })
    expect(clash.statusCode).toBe(409)
    expect(
      (await call('POST', '/api/knowledge/move', { from: 'Welcome.md', to: 'x.md' })).statusCode,
    ).toBe(400)
    expect(knowledgeEvents()).toContainEqual({
      path: 'Glossary.md',
      kind: 'moved',
      to: 'Reference/Terms.md',
      by: 'you',
    })
  })

  test('DELETE returns 204; a second delete is 404', async () => {
    expect((await call('DELETE', `${N}Welcome.md`)).statusCode).toBe(204)
    expect((await call('DELETE', `${N}Welcome.md`)).statusCode).toBe(404)
    expect((await call('GET', `${N}Welcome.md`)).statusCode).toBe(404)
    expect(knowledgeEvents()).toContainEqual({
      path: 'Welcome.md',
      kind: 'deleted',
      to: null,
      by: 'you',
    })
  })

  test('history, versions and restore', async () => {
    const first = (await call('PUT', `${N}h.md`, { body: 'v1', etag: null })).json()
    // A second author in between keeps the commits apart (amend only merges one author's rapid edits).
    await vault.writeNote('h.md', { body: 'v2', etag: first.etag }, { agentId: 'builder' })
    const history = KnowledgeHistorySchema.parse((await call('GET', `${N}h.md/history`)).json())
    expect(history.items.map((i) => i.author)).toEqual([{ agentId: 'builder' }, 'you'])
    const oldest = history.items[1]!.commit
    expect((await call('GET', `${N}h.md/versions/${oldest}`)).json()).toEqual({
      commit: oldest,
      body: 'v1',
    })
    expect((await call('GET', `${N}h.md/versions/abcdef0`)).statusCode).toBe(404)
    expect((await call('GET', `${N}h.md/versions/NOT-A-COMMIT`)).statusCode).toBe(400)
    const restored = await call('POST', `${N}h.md/restore`, { commit: oldest })
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toEqual({ etag: expect.any(String), path: 'h.md' })
    expect((await call('GET', `${N}h.md`)).json().body).toBe('v1')
    expect((await call('GET', `${N}h.md/history`)).json().items).toHaveLength(3)
    expect((await call('POST', `${N}h.md/restore`, { commit: 'nothex!' })).statusCode).toBe(400)
    expect((await call('POST', `${N}h.md/restore`, { commit: 'abcdef0' })).statusCode).toBe(404)
    expect((await call('POST', `${N}h.md/other`, {})).statusCode).toBe(404)
  })

  test('settings: agentAccess persists and is returned', async () => {
    const off = await call('PUT', '/api/knowledge/settings', { agentAccess: false })
    expect(off.json()).toMatchObject({ agentAccess: false })
    expect((await call('GET', '/api/knowledge')).json().agentAccess).toBe(false)
    expect(db.sqlite.prepare('SELECT agent_access FROM knowledge_settings').get()).toEqual({
      agent_access: 0,
    })
    expect((await call('PUT', '/api/knowledge/settings', { agentAccess: 'yes' })).statusCode).toBe(
      400,
    )
    expect(
      (await call('PUT', '/api/knowledge/settings', { agentAccess: true })).json().agentAccess,
    ).toBe(true)
  })

  test('the routes are absent when no vault is configured', async () => {
    const bare = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake' }),
      logger: false,
      port: new FakePort(1, {}, false),
    })
    expect((await bare.inject({ method: 'GET', url: '/api/knowledge' })).statusCode).toBe(404)
    await bare.close()
  })
})
