import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { registerErrorHandlers } from '../../src/errors.ts'
import { loadBridgeBootstrap } from '../../src/hermes/bridge/bootstrap.ts'
import { registerBridgeRoutes } from '../../src/hermes/bridge/routes.ts'
import { KnowledgeAgentApi } from '../../src/knowledge/agent-api.ts'
import { gitOut, makeVault, type Harness } from './helpers.ts'

let h: Harness
let app: FastifyInstance
let now = Date.parse('2026-10-07T12:00:00Z')
let bootstrap = ''

const base = {
  pid: 123,
  kanbanTaskId: null,
  isolation: 'in_process',
  pluginVersion: '0.1.0',
  hermes: { version: '0.21.0', codeSha: 'fixture' },
  privateApis: {},
}
async function token(profile: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/bridge/v1/hello',
    headers: { authorization: `Bearer ${bootstrap}` },
    payload: { ...base, profile, incarnation: `inc-${profile}-12345` },
  })
  return (response.json() as { producerToken: string }).producerToken
}
const call = (tok: string, op: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: `/bridge/v1/knowledge/${op}`,
    headers: { authorization: `Bearer ${tok}` },
    payload,
  })

beforeEach(async () => {
  h = await makeVault({ files: { 'seed.md': '# Seed\nhello world\n' } })
  const home = join(h.dir, 'home')
  const bootstrapHash = loadBridgeBootstrap(home)
  bootstrap = readFileSync(join(home, 'bridge.token'), 'utf8').trim()
  app = Fastify()
  registerErrorHandlers(app)
  registerBridgeRoutes(app, {
    db: h.db,
    ingest: { submit: async () => undefined, clearHolds: () => undefined } as never,
    bootstrapHash,
    getCompatibility: () => ({
      fingerprint: 'f',
      tested: true,
      disabled: [],
      matchedHermes: { version: '0.21.0', codeSha: 'fixture' },
    }),
    clock: () => now,
    knowledge: new KnowledgeAgentApi(h.vault, h.db, () => now),
  })
})
afterEach(async () => {
  await app.close()
  await h.cleanup()
})

test('requires a valid producer token', async () => {
  expect((await call('x'.repeat(43), 'search', { query: 'a' })).statusCode).toBe(401)
  expect(
    (await app.inject({ method: 'POST', url: '/bridge/v1/knowledge/list', payload: {} }))
      .statusCode,
  ).toBe(401)
})

test('write, read, list, search and append work; the author is the producer profile, never the body', async () => {
  const tok = await token('builder')
  const created = await call(tok, 'write', {
    path: 'notes/plan.md',
    body: '# Plan\nship the launchpad\n',
    expectedEtag: null,
    agentId: 'impostor',
  })
  expect(created.statusCode).toBe(200)
  const { etag } = created.json() as { etag: string }
  expect(h.events.at(-1)).toMatchObject({ path: 'notes/plan.md', by: { agentId: 'builder' } })
  expect(gitOut(h.vaultDir, 'log', '-1', '--format=%an').trim()).toBe('builder (agent)')

  const read = (await call(tok, 'read', { path: 'notes/plan.md' })).json()
  expect(read).toMatchObject({ title: 'Plan', etag, truncated: false })
  const list = (await call(tok, 'list', { folder: 'notes' })).json() as {
    notes: { path: string }[]
  }
  expect(list.notes.map((n) => n.path)).toEqual(['notes/plan.md'])
  const found = (await call(tok, 'search', { query: 'launchpad' })).json() as { items: unknown[] }
  expect(found.items).toHaveLength(1)

  const appended = await call(tok, 'append', { path: 'notes/plan.md', text: 'and then rest' })
  expect(appended.statusCode).toBe(200)
  const after = (await call(tok, 'read', { path: 'notes/plan.md' })).json() as { body: string }
  expect(after.body).toBe('# Plan\nship the launchpad\nand then rest')
  const fresh = await call(tok, 'append', { path: 'inbox.md', text: 'first' })
  expect(fresh.statusCode).toBe(200)
})

test('conflicts answer 409 with the current etag; create over an existing note too', async () => {
  const tok = await token('builder')
  const first = (
    await call(tok, 'write', { path: 'a.md', body: 'one', expectedEtag: null })
  ).json() as { etag: string }
  await h.vault.writeNote('a.md', { body: 'two', etag: first.etag })
  const stale = await call(tok, 'write', { path: 'a.md', body: 'three', expectedEtag: first.etag })
  expect(stale.statusCode).toBe(409)
  const current = (await call(tok, 'read', { path: 'a.md' })).json() as { etag: string }
  expect((stale.json() as { error: { details: { etag: string } } }).error.details.etag).toBe(
    current.etag,
  )
  const exists = await call(tok, 'write', { path: 'a.md', body: 'x', expectedEtag: null })
  expect(exists.statusCode).toBe(409)
  expect((exists.json() as { error: { details: { etag: string } } }).error.details.etag).toBe(
    current.etag,
  )
})

test('global and per-agent switches turn every tool off', async () => {
  const tok = await token('builder')
  const other = await token('reviewer')
  h.vault.setAgentAccess(false)
  for (const [op, payload] of [
    ['search', { query: 'a' }],
    ['read', { path: 'seed.md' }],
    ['list', {}],
    ['write', { path: 'n.md', body: 'x', expectedEtag: null }],
    ['append', { path: 'n.md', text: 'x' }],
  ] as const) {
    const response = await call(tok, op, payload)
    expect(response.statusCode).toBe(403)
    expect((response.json() as { error: { message: string } }).error.message).toBe(
      'Knowledge is turned off for agents',
    )
  }
  h.vault.setAgentAccess(true)
  new KnowledgeAgentApi(h.vault, h.db).setAgentEnabled('builder', false)
  expect((await call(tok, 'read', { path: 'seed.md' })).statusCode).toBe(403)
  expect((await call(other, 'read', { path: 'seed.md' })).statusCode).toBe(200)
})

test('size limit (256 KiB) and rate limit (60 writes per hour per agent)', async () => {
  const tok = await token('builder')
  const big = await call(tok, 'write', {
    path: 'big.md',
    body: 'x'.repeat(256 * 1024 + 1),
    expectedEtag: null,
  })
  expect(big.statusCode).toBe(413)
  for (let i = 0; i < 60; i++) {
    const ok = await call(tok, 'append', { path: 'log.md', text: `line ${i}` })
    expect(ok.statusCode).toBe(200)
  }
  const limited = await call(tok, 'append', { path: 'log.md', text: 'one too many' })
  expect(limited.statusCode).toBe(429)
  expect(
    (limited.json() as { error: { details: { retryAfterSeconds: number } } }).error.details
      .retryAfterSeconds,
  ).toBeGreaterThan(0)
  // Another agent has its own budget; the first recovers after the hour.
  const other = await token('reviewer')
  expect((await call(other, 'append', { path: 'log.md', text: 'mine' })).statusCode).toBe(200)
  now += 61 * 60 * 1000
  const renewed = await token('builder')
  expect((await call(renewed, 'append', { path: 'log.md', text: 'later' })).statusCode).toBe(200)
  const usage = new KnowledgeAgentApi(h.vault, h.db, () => now).usageToday()
  expect(usage.find((u) => u.agentId === 'builder')?.writesToday).toBeGreaterThan(0)
}, 60_000)

test('failed writes do not use rate budget; agent text is redacted before it is stored', async () => {
  const tok = await token('builder')
  for (let i = 0; i < 65; i++)
    expect(
      (await call(tok, 'write', { path: 'seed.md', body: 'x', expectedEtag: null })).statusCode,
    ).toBe(409)
  const secret = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
  await call(tok, 'write', { path: 's.md', body: `key ${secret} end`, expectedEtag: null })
  const stored = (await call(tok, 'read', { path: 's.md' })).json() as { body: string }
  expect(stored.body).not.toContain(secret)
})

test('read is bounded, list is bounded, bad paths are refused', async () => {
  const tok = await token('builder')
  await h.vault.writeNote('huge.md', { body: 'é'.repeat(200_000), etag: null })
  const read = (await call(tok, 'read', { path: 'huge.md' })).json() as {
    body: string
    truncated: boolean
  }
  expect(read.truncated).toBe(true)
  expect(Buffer.byteLength(read.body)).toBeLessThanOrEqual(256 * 1024)
  for (let i = 0; i < 205; i++) await h.vault.writeNote(`many/n${i}.md`, { body: 'x', etag: null })
  const list = (await call(tok, 'list', { folder: 'many' })).json() as {
    notes: unknown[]
    truncated: boolean
  }
  expect(list.notes).toHaveLength(200)
  expect(list.truncated).toBe(true)
  expect((await call(tok, 'read', { path: '../etc/passwd' })).statusCode).toBe(400)
  expect(
    (await call(tok, 'write', { path: '.git/config.md', body: 'x', expectedEtag: null }))
      .statusCode,
  ).toBe(400)
  expect((await call(tok, 'list', { folder: '../' })).statusCode).toBe(400)
}, 120_000)

test('an observe-only producer (isolation unknown) can read and search but not write or append', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/bridge/v1/hello',
    headers: { authorization: `Bearer ${bootstrap}` },
    payload: { ...base, isolation: 'unknown', profile: 'builder', incarnation: 'inc-obs-123456' },
  })
  const tok = (response.json() as { producerToken: string }).producerToken
  expect((await call(tok, 'read', { path: 'seed.md' })).statusCode).toBe(200)
  expect((await call(tok, 'search', { query: 'hello' })).statusCode).toBe(200)
  for (const [op, payload] of [
    ['write', { path: 'x.md', body: 'x', expectedEtag: null }],
    ['append', { path: 'seed.md', text: 'more' }],
  ] as const) {
    const res = await call(tok, op, payload)
    expect(res.statusCode, op).toBe(403)
    expect(res.json().error.code).toBe('observe_only')
  }
  expect(readFileSync(join(h.vault.vault, 'seed.md'), 'utf8')).toBe('# Seed\nhello world\n')
})

// PLAN 6.8: embedded images reach agents only as placeholders, over the same bridge route the plugin calls.
test('read answers [image: alt, size] instead of base64; write refuses a new image but keeps the old ones', async () => {
  const tok = await token('builder')
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = `![whiteboard](data:image/png;base64,${png})`
  const created = await h.vault.writeNote('pics.md', { body: `# Pics\n${image}\n`, etag: null })
  const read = (await call(tok, 'read', { path: 'pics.md' })).json() as {
    body: string
    etag: string
  }
  expect(read.body).toBe('# Pics\n[image: whiteboard, 70 B]\n')
  expect(read.body).not.toContain('base64')
  expect(read.etag).toBe(created.etag)

  const refused = await call(tok, 'write', {
    path: 'pics.md',
    body: `${read.body}${image}`,
    expectedEtag: read.etag,
  })
  expect(refused.statusCode).toBe(400)
  expect(refused.json()).toMatchObject({ error: { code: 'images_not_allowed' } })

  const ok = await call(tok, 'write', {
    path: 'pics.md',
    body: `${read.body}more words\n`,
    expectedEtag: read.etag,
  })
  expect(ok.statusCode).toBe(200)
  expect((await h.vault.readNote('pics.md')).body).toBe(`# Pics\n${image}\nmore words\n`)
  const hits = (await call(tok, 'search', { query: 'whiteboard' })).json() as {
    items: { snippet: string }[]
  }
  expect(hits.items[0]!.snippet).not.toContain('base64')
})
