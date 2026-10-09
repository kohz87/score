import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RoomSchema, type Message } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { deleteMessage, storeMessage } from '../../src/domain/rooms.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { png } from '../media-fixtures.ts'

const PASSWORD = 'correct horse battery'
const DAY = 24 * 60 * 60 * 1000
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let counter = 0

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-shares-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = createHermesPort(loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }), {
    db,
    scheduler,
  })
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
    security: new SecurityPassword(dir, clock),
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'share-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function setPassword() {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/session/security/password',
    headers,
    payload: { password: PASSWORD },
  })
  expect(response.statusCode).toBe(204)
}
async function room(name = 'shared') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers,
    payload: { name, leadAgentId: 'lead', members: ['lead', 'builder'] },
  })
  return RoomSchema.parse(response.json())
}
async function say(roomId: string, parts: Message['parts'], you = false) {
  const message: Message = {
    id: `s-${++counter}`,
    roomId,
    author: you ? { kind: 'you' } : { kind: 'agent', agentId: 'builder' },
    to: [],
    parts,
    refs: [],
    createdAt: new Date(scheduler.now() + counter * 1000).toISOString(),
    streaming: false,
  }
  await ingest.submit({
    source: 'test',
    identity: `say-${counter}`,
    apply: ({ sqlite, now }) => storeMessage(sqlite, message, now),
  })
  return message
}
const create = (roomId: string, payload: object = {}, withHeaders = headers) =>
  app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/shares`,
    headers: withHeaders,
    payload: { password: PASSWORD, ...payload },
  })
const tokenOf = (url: string) => url.split('/s/')[1]!
const page = (token: string, remoteAddress?: string) =>
  app.inject({ url: `/s/${token}`, ...(remoteAddress ? { remoteAddress } : {}) })

test('creating a share needs a paired browser and the security password, with its limits', async () => {
  const r = await room()
  expect((await create(r.id, {}, { 'x-score-client': 'web', cookie: '' })).statusCode).toBe(401)
  // No password set yet.
  const unset = await create(r.id)
  expect(unset.statusCode).toBe(409)
  expect(unset.json().error.code).toBe('password_not_set')
  await setPassword()
  const wrong = await create(r.id, { password: 'not the password' })
  expect(wrong.statusCode).toBe(403)
  expect(wrong.json().error.code).toBe('wrong_password')
  expect((await create(r.id, { password: undefined })).statusCode).toBe(403)
  for (let i = 0; i < 2; i++) await create(r.id, { password: 'still wrong' })
  expect((await create(r.id, { password: 'still wrong' })).statusCode).toBe(403)
  const locked = await create(r.id)
  expect(locked.statusCode).toBe(429)
  expect(locked.json().error.code).toBe('too_many_attempts')
  expect((await app.inject({ url: '/api/shares' })).statusCode).toBe(401)
})

test('validates expiry and room; defaults to 7 days', async () => {
  await setPassword()
  const r = await room()
  expect((await create(r.id, { expiresInDays: 0 })).statusCode).toBe(400)
  expect((await create(r.id, { expiresInDays: 31 })).statusCode).toBe(400)
  expect((await create(r.id, { stray: true })).statusCode).toBe(400)
  expect((await create('nope')).statusCode).toBe(404)
  const made = (await create(r.id)).json()
  expect(Date.parse(made.expiresAt) - scheduler.now()).toBe(7 * DAY)
  expect(made.url).toMatch(/^http:\/\/[^/]+\/s\/[A-Za-z0-9_-]{43}$/)
  const long = (await create(r.id, { expiresInDays: 30 })).json()
  expect(Date.parse(long.expiresAt) - scheduler.now()).toBe(30 * DAY)
})

test('the token is never stored in clear: only its SHA-256, and lookup goes by hash', async () => {
  await setPassword()
  const r = await room()
  await say(r.id, [{ kind: 'text', text: 'hello from the share' }])
  const made = (await create(r.id)).json()
  const token = tokenOf(made.url)
  const rows = db.sqlite.prepare('SELECT * FROM room_shares').all()
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows)).not.toContain(token)
  expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
  expect(rows[0]!.id).toBe(made.id)
  // Not in the database file's pages either (WAL included).
  db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  expect(readFileSync(join(dir, 'score.db')).includes(Buffer.from(token))).toBe(false)
  // The hash is not a token.
  expect((await page(rows[0]!.token_hash as string)).statusCode).toBe(404)
  const ok = await page(token)
  expect(ok.statusCode).toBe(200)
  expect(ok.body).toContain('hello from the share')
})

test('the page is static, escaped HTML with the required headers and no script', async () => {
  await setPassword()
  const r = await room()
  await say(r.id, [
    {
      kind: 'text',
      text: '<script>alert(1)</script> <img src=x onerror=alert(1)> **bold** `a<b` [bad](javascript:alert(1)) [good](https://example.com/a?b=1&c=2)\n\n- one\n- two\n\n```js\nconst x = "<y>"\n```',
    },
  ])
  const token = tokenOf((await create(r.id)).json().url)
  const response = await page(token)
  expect(response.statusCode).toBe(200)
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
  expect(response.headers['content-security-policy']).toBe(
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  )
  expect(response.headers['x-robots-tag']).toBe('noindex')
  expect(response.headers['referrer-policy']).toBe('no-referrer')
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  expect(response.headers['set-cookie']).toBeUndefined()
  const html = response.body
  expect(html).not.toMatch(/<script/i)
  expect(html).not.toContain('<img src=x')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('href="javascript')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<code>a&lt;b</code>')
  expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"')
  expect(html).toContain('<li>one</li>')
  expect(html).toContain('<pre><code>const x = &quot;&lt;y&gt;&quot;')
  // Nothing outside the document is loaded: no src/href other than the escaped link, no scripts or frames.
  expect(html).not.toMatch(/<(iframe|link|object|embed|form)\b/i)
})

test('the snapshot keeps text only, redacted, and nothing else from the room', async () => {
  await setPassword()
  const r = await room('private-room')
  await say(r.id, [{ kind: 'text', text: 'my question' }], true)
  await say(r.id, [
    { kind: 'text', text: 'Use api_key=sk-abcdefghijklmnop123 and /home/raven/secret-project' },
    {
      kind: 'tool',
      tool: 'terminal-tool-name',
      args: 'cat /etc/passwd',
      result: 'root:x',
      status: 'ok',
    },
    { kind: 'thinking', text: 'hidden reasoning words' },
    { kind: 'file', path: 'src/workspace/path.ts', added: 1, removed: 2 },
    { kind: 'tools', summary: 'ran 3 tools summary', runId: 'run-xyz' },
    { kind: 'plan', lanes: [], briefId: 'brief-xyz' },
    { kind: 'approval', approvalId: 'approval-xyz' },
    { kind: 'review', verdict: 'approved', taskId: 'task-xyz' },
    { kind: 'image', mediaId: 'media-not-included' },
  ])
  const gone = await say(r.id, [{ kind: 'text', text: 'this one was deleted' }], true)
  await ingest.submit({
    source: 'test',
    identity: 'del',
    apply: ({ sqlite, now }) => deleteMessage(sqlite, r.id, gone.id, now),
  })
  const made = (await create(r.id)).json()
  const stored = JSON.parse(
    db.sqlite.prepare('SELECT snapshot FROM room_shares').get()!.snapshot as string,
  )
  expect(stored).toEqual({
    title: '#private-room',
    messages: [
      { who: 'You', you: true, at: expect.any(String), text: 'my question', images: [] },
      {
        who: 'builder',
        you: false,
        at: expect.any(String),
        text: expect.stringContaining('api_key=[redacted]'),
        images: [],
      },
    ],
    images: [],
  })
  const html = (await page(tokenOf(made.url))).body
  for (const forbidden of [
    'sk-abcdefghijklmnop123',
    'terminal-tool-name',
    '/etc/passwd',
    'hidden reasoning',
    'src/workspace/path.ts',
    'ran 3 tools',
    'brief-xyz',
    'approval-xyz',
    'task-xyz',
    'media-not-included',
    'this one was deleted',
    'lead',
    r.id,
  ])
    expect(html).not.toContain(forbidden)
  expect(html).toContain('my question')
  expect(html).not.toContain('<img')
})

test('later edits and deletes in the room do not change a snapshot', async () => {
  await setPassword()
  const r = await room()
  const kept = await say(r.id, [{ kind: 'text', text: 'frozen words' }])
  const token = tokenOf((await create(r.id)).json().url)
  await ingest.submit({
    source: 'test',
    identity: 'del2',
    apply: ({ sqlite, now }) => deleteMessage(sqlite, r.id, kept.id, now),
  })
  await say(r.id, [{ kind: 'text', text: 'brand new words' }])
  const html = (await page(token)).body
  expect(html).toContain('frozen words')
  expect(html).not.toContain('brand new words')
})

test('images are included only on request, by position, and only those of the share', async () => {
  await setPassword()
  const r = await room()
  const first = app.media!.store(png(80, 1), 'image/png')
  const other = app.media!.store(png(80, 2), 'image/png')
  await say(
    r.id,
    [
      { kind: 'text', text: 'look' },
      { kind: 'image', mediaId: first.mediaId },
    ],
    true,
  )
  const without = tokenOf((await create(r.id)).json().url)
  expect((await page(without)).body).not.toContain('<img')
  expect((await app.inject({ url: `/s/${without}/media/0` })).statusCode).toBe(404)
  const withImages = tokenOf((await create(r.id, { includeImages: true })).json().url)
  const html = (await page(withImages)).body
  expect(html).toContain(`<img src="/s/${withImages}/media/0"`)
  const image = await app.inject({ url: `/s/${withImages}/media/0` })
  expect(image.statusCode).toBe(200)
  expect(image.headers['content-type']).toBe('image/png')
  expect(image.headers['content-security-policy']).toBe(
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  )
  expect(image.headers['cache-control']).toBe('no-store')
  expect(image.rawPayload.equals(png(80, 1))).toBe(true)
  // Another id (even a real one) or position is not reachable through the share.
  expect((await app.inject({ url: `/s/${withImages}/media/1` })).statusCode).toBe(404)
  expect((await app.inject({ url: `/s/${withImages}/media/${other.mediaId}` })).statusCode).toBe(
    404,
  )
  expect((await app.inject({ url: `/s/${withImages}/media/-1` })).statusCode).toBe(404)
  // The share does not list the id in its HTML, only positions.
  expect(html).not.toContain(first.mediaId)
})

test('unknown, malformed, expired and revoked links are indistinguishable', async () => {
  await setPassword()
  const r = await room()
  await say(r.id, [{ kind: 'text', text: 'content' }])
  const expiring = (await create(r.id, { expiresInDays: 1 })).json()
  const revoked = (await create(r.id)).json()
  const live = (await create(r.id)).json()
  expect((await page(tokenOf(expiring.url))).statusCode).toBe(200)
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/shares/${revoked.id}`, headers })).statusCode,
  ).toBe(204)
  scheduler.advance(DAY + 1000)
  const unknown = await page('A'.repeat(43))
  const responses = [
    unknown,
    await page('short'),
    await page(tokenOf(expiring.url)),
    await page(tokenOf(revoked.url)),
  ]
  for (const response of responses) {
    expect(response.statusCode).toBe(404)
    expect(response.body).toBe(unknown.body)
    expect(response.headers['content-type']).toBe(unknown.headers['content-type'])
    expect(response.headers['content-security-policy']).toBe(
      unknown.headers['content-security-policy'],
    )
  }
  expect((await page(tokenOf(live.url))).statusCode).toBe(200)
})

test('revoking withdraws the link at once and keeps no content; no password needed', async () => {
  await setPassword()
  const r = await room()
  await say(r.id, [{ kind: 'text', text: 'to be withdrawn' }])
  const made = (await create(r.id)).json()
  const token = tokenOf(made.url)
  expect((await page(token)).statusCode).toBe(200)
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/shares/${made.id}`,
        headers: { 'x-score-client': 'web' },
      })
    ).statusCode,
  ).toBe(401)
  const revoke = await app.inject({ method: 'DELETE', url: `/api/shares/${made.id}`, headers })
  expect(revoke.statusCode).toBe(204)
  expect((await page(token)).statusCode).toBe(404)
  expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM room_shares').all())).not.toContain(
    'to be withdrawn',
  )
  // Idempotent, unknown ids are 404, and a revoked share leaves the list.
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/shares/${made.id}`, headers })).statusCode,
  ).toBe(204)
  expect(
    (await app.inject({ method: 'DELETE', url: '/api/shares/nope', headers })).statusCode,
  ).toBe(404)
  const list = await app.inject({ url: '/api/shares', headers })
  expect(list.json().items).toEqual([])
})

test('lists shares with room, dates and views; the room list shows active ones only', async () => {
  await setPassword()
  const r = await room('listed')
  const other = await room('other')
  const a = (await create(r.id, { expiresInDays: 1 })).json()
  const b = (await create(other.id)).json()
  await page(tokenOf(a.url))
  await page(tokenOf(a.url))
  await page('B'.repeat(43))
  const list = (await app.inject({ url: '/api/shares', headers })).json().items
  expect(list).toHaveLength(2)
  expect(list.find((item: { id: string }) => item.id === a.id)).toMatchObject({
    roomId: r.id,
    roomName: '#listed',
    views: 2,
    includeImages: false,
    status: 'active',
  })
  expect(list.find((item: { id: string }) => item.id === b.id)).toMatchObject({ views: 0 })
  scheduler.advance(2 * DAY)
  const after = (await app.inject({ url: '/api/shares', headers })).json().items
  expect(after.find((item: { id: string }) => item.id === a.id).status).toBe('expired')
  const forRoom = (await app.inject({ url: `/api/rooms/${r.id}/shares`, headers })).json().items
  expect(forRoom).toEqual([])
  const forOther = (await app.inject({ url: `/api/rooms/${other.id}/shares`, headers })).json()
  expect(forOther.items).toHaveLength(1)
})

test('the public page is rate limited per IP', async () => {
  await setPassword()
  const r = await room()
  const token = tokenOf((await create(r.id)).json().url)
  for (let i = 0; i < 30; i++) expect((await page(token, '10.0.0.1')).statusCode).toBe(200)
  const limited = await page(token, '10.0.0.1')
  expect(limited.statusCode).toBe(429)
  expect(limited.headers['content-security-policy']).toContain("default-src 'none'")
  // Unknown tokens count too, so guessing is bounded; another address is unaffected.
  expect((await page('C'.repeat(43), '10.0.0.1')).statusCode).toBe(429)
  expect((await page(token, '10.0.0.2')).statusCode).toBe(200)
  scheduler.advance(61_000)
  expect((await page(token, '10.0.0.1')).statusCode).toBe(200)
})

test('the token never appears in logs or the listing', async () => {
  await setPassword()
  const r = await room()
  const made = (await create(r.id)).json()
  const token = tokenOf(made.url)
  expect(JSON.stringify((await app.inject({ url: '/api/shares', headers })).json())).not.toContain(
    token,
  )
})

test('remote mode: the share page is public, everything else still needs pairing', async () => {
  const origin = 'https://score.lan:8741'
  const remoteHeaders = { host: 'score.lan:8741' }
  const remote = buildApp({
    config: loadConfig({
      SCORE_REMOTE: '1',
      SCORE_TLS_CERT: '/tmp/cert',
      SCORE_TLS_KEY: '/tmp/key',
      SCORE_PUBLIC_ORIGINS: origin,
      SCORE_MODE: 'fake',
    }),
    logger: false,
    db,
    ingest,
    port,
    security: new SecurityPassword(dir),
  })
  try {
    const response = await remote.inject({ url: `/s/${'D'.repeat(43)}`, headers: remoteHeaders })
    expect(response.statusCode).toBe(404)
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(
      (await remote.inject({ url: `/s/${'D'.repeat(43)}/media/0`, headers: remoteHeaders }))
        .statusCode,
    ).toBe(404)
    expect((await remote.inject({ url: '/api/shares', headers: remoteHeaders })).statusCode).toBe(
      401,
    )
    expect(
      (await remote.inject({ method: 'HEAD', url: `/s/${'D'.repeat(43)}`, headers: remoteHeaders }))
        .statusCode,
    ).toBe(401)
    // A Host that is not allowed gets nothing, not even the page.
    expect(
      (await remote.inject({ url: `/s/${'D'.repeat(43)}`, headers: { host: 'evil.test' } }))
        .statusCode,
    ).toBe(403)
    expect(
      (
        await remote.inject({
          method: 'POST',
          url: '/api/rooms/x/shares',
          headers: { ...remoteHeaders, origin, 'x-score-client': 'web' },
          payload: { password: PASSWORD },
        })
      ).statusCode,
    ).toBe(401)
  } finally {
    await remote.close()
  }
})
