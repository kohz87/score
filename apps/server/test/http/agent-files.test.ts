import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { etagOf } from '../../src/hermes/agent-files.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let cookie: string
async function pair(a: typeof app) {
  const paired = await a.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: a.pairing.createToken() },
  })
  return paired.headers['set-cookie']!.toString().split(';')[0]!
}
beforeEach(async () => {
  env = setup()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port: new FakePort(1, { db: env.db }, false),
    db: env.db,
    ingest: env.ingest,
  })
  cookie = await pair(app)
})
afterEach(async () => {
  await app.close()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
const url = (file = 'SOUL.md', agent = 'builder') => `/api/agents/${agent}/files/${file}`
const put = (body: object, file = 'SOUL.md', headers: Record<string, string> | null = null) =>
  app.inject({
    method: 'PUT',
    url: url(file),
    headers: headers ?? { 'x-score-client': 'web', cookie },
    payload: body,
  })
const events = () =>
  env.db.sqlite
    .prepare("SELECT data FROM events WHERE type = 'agent.updated' ORDER BY seq")
    .all()
    .map((row) => JSON.parse(String(row.data)) as { id: string })

test('GET returns content and etag for both files; other names and agents are 404', async () => {
  for (const file of ['SOUL.md', 'AGENTS.md']) {
    const body = (await app.inject(url(file))).json()
    expect(body.etag).toBe(etagOf(body.content))
    expect(body.content.length).toBeGreaterThan(0)
  }
  expect((await app.inject(url('config.yaml'))).statusCode).toBe(404)
  expect((await app.inject(url('soul.md'))).statusCode).toBe(404)
  expect((await app.inject(url('SOUL.md', 'missing'))).statusCode).toBe(404)
})
test('preview returns a unified diff against the current file and writes nothing', async () => {
  const before = (await app.inject(url())).json()
  const response = await app.inject({
    method: 'POST',
    url: `${url()}/preview`,
    headers: { 'x-score-client': 'web', cookie },
    payload: { content: before.content + 'Always test.\n' },
  })
  expect(response.statusCode).toBe(200)
  expect(response.json().diff).toContain('+Always test.')
  expect((await app.inject(url())).json()).toEqual(before)
  const same = await app.inject({
    method: 'POST',
    url: `${url()}/preview`,
    headers: { 'x-score-client': 'web', cookie },
    payload: { content: before.content },
  })
  expect(same.json()).toEqual({ diff: '' })
})
test('PUT saves with a matching etag, returns the new etag and emits agent.updated with the new excerpt', async () => {
  await app.inject('/api/agents')
  const before = (await app.inject(url())).json()
  const count = events().length
  const response = await put({ content: '# Builder\n\nCareful and fast.\n', etag: before.etag })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ etag: etagOf('# Builder\n\nCareful and fast.\n') })
  expect((await app.inject(url())).json().content).toBe('# Builder\n\nCareful and fast.\n')
  expect(
    events()
      .slice(count)
      .map((event) => event.id),
  ).toEqual(['builder'])
  const detail = (await app.inject('/api/agents/builder')).json()
  expect(detail.personality.excerpt).toBe('Careful and fast.')
})
test('PUT with a stale etag is 409 conflict with the current etag and a diff, and changes nothing', async () => {
  const first = (await app.inject(url())).json()
  await put({ content: 'Theirs.\n', etag: first.etag })
  const response = await put({ content: 'Mine.\n', etag: first.etag })
  expect(response.statusCode).toBe(409)
  const error = response.json().error
  expect(error.code).toBe('conflict')
  expect(error.details.etag).toBe(etagOf('Theirs.\n'))
  expect(error.details.diff).toContain('-Theirs.')
  expect(error.details.diff).toContain('+Mine.')
  expect((await app.inject(url())).json().content).toBe('Theirs.\n')
  // Overwrite: re-PUT with the etag from the conflict.
  expect((await put({ content: 'Mine.\n', etag: error.details.etag })).statusCode).toBe(200)
})
test('PUT is guarded (session, CSRF), validated and replays idempotent receipts', async () => {
  const { etag } = (await app.inject(url())).json()
  expect(
    (await put({ content: 'x', etag }, 'SOUL.md', { 'x-score-client': 'web' })).statusCode,
  ).toBe(401)
  expect((await put({ content: 'x', etag }, 'SOUL.md', { cookie })).statusCode).toBe(403)
  expect((await put({ content: 'x', etag: 'nope' })).statusCode).toBe(400)
  expect((await put({ content: 'x' })).statusCode).toBe(400)
  expect((await put({ content: 'a\0b', etag })).statusCode).toBe(400)
  expect((await put({ content: 'x'.repeat(256 * 1024 + 1), etag })).statusCode).toBe(413)
  expect((await put({ content: 'x', etag }, 'config.yaml')).statusCode).toBe(404)
  const headers = { 'x-score-client': 'web', cookie, 'idempotency-key': 'file-put' }
  const first = await put({ content: 'Once.\n', etag }, 'SOUL.md', headers)
  const second = await put({ content: 'Once.\n', etag }, 'SOUL.md', headers)
  expect(first.statusCode).toBe(200)
  expect(second.json()).toEqual(first.json())
})

test('live: reads and writes real profile files through HTTP, only SOUL.md / AGENTS.md', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/hermes/profiles/', import.meta.url))
  const upstream = join(env.home, 'upstream')
  cpSync(join(fixture, 'default'), upstream, { recursive: true })
  for (const name of ['lead', 'builder'])
    cpSync(join(fixture, name), join(upstream, 'profiles', name), { recursive: true })
  writeFileSync(join(upstream, 'profiles', 'builder', 'auth.json'), 'planted-secret')
  const live = new LivePort({
    scoreHome: env.home,
    hermesHome: upstream,
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    runner: async () => ({ exitCode: 0, stdout: '"fixture-model"' }),
  })
  await live.start(env.ingest)
  await app.close()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'live', SCORE_HERMES_HOME: upstream }),
    logger: false,
    port: live,
    db: env.db,
    ingest: env.ingest,
  })
  cookie = await pair(app)
  try {
    const soul = join(upstream, 'profiles', 'builder', 'SOUL.md')
    const current = (await app.inject(url())).json()
    expect(current.content).toBe(readFileSync(soul, 'utf8'))
    const response = await put({ content: '# Builder\n\nShips.\n', etag: current.etag })
    expect(response.statusCode).toBe(200)
    expect(readFileSync(soul, 'utf8')).toBe('# Builder\n\nShips.\n')
    expect((await put({ content: 'again', etag: current.etag })).statusCode).toBe(409)
    expect((await app.inject(url('AGENTS.md'))).json().content).toBeTypeOf('string')
    expect((await app.inject(url('auth.json'))).statusCode).toBe(404)
    expect((await app.inject(url('SOUL.md', 'nobody'))).statusCode).toBe(404)
    expect(readFileSync(join(upstream, 'profiles', 'builder', 'auth.json'), 'utf8')).toBe(
      'planted-secret',
    )
    expect((await app.inject('/api/agents/builder')).json().personality.excerpt).toBe('Ships.')
  } finally {
    await live.stop()
  }
})
