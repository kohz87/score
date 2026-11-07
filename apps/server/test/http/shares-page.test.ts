import { expect, test } from 'vitest'
import { deleteMessage } from '../../src/domain/rooms.ts'

import {
  DAY,
  createSharesHelpers,
  sharesTestSuite,
  type SharesTestState,
} from './shares-helpers.ts'

let db: SharesTestState['db']
let ingest: SharesTestState['ingest']
let scheduler: SharesTestState['scheduler']
let app: SharesTestState['app']
let headers: SharesTestState['headers']
let state: SharesTestState
const current = (): SharesTestState => state
sharesTestSuite((next) => {
  state = next
  db = next.db
  ingest = next.ingest
  scheduler = next.scheduler
  app = next.app
  headers = next.headers
}, current)

const { setPassword, room, say, create, tokenOf, page } = createSharesHelpers(current)

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
