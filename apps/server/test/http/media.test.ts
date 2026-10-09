import { MessageSchema, RoomSchema } from '@score/contract'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { docx, gif, jpeg, multipart, pdf, png, unique, webp, xlsx } from '../media-fixtures.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-media-http-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const scheduler = new FakeScheduler()
  ingest = createIngest(db, { clock: () => scheduler.now() })
  port = new FakePort(1, { db, scheduler }, false)
  await port.start(ingest)
  scheduler.clearTimeout(0)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    db,
    ingest,
    port,
    clock: () => scheduler.now(),
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
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const mediaFiles = () => {
  try {
    return readdirSync(join(dir, 'media'))
  } catch {
    return []
  }
}
function upload(
  data: Buffer,
  {
    filename = 'shot.png',
    type,
    authed = true,
  }: { filename?: string; type?: string; authed?: boolean } = {},
) {
  const { body, contentType } = multipart([
    { name: 'file', filename, ...(type ? { type } : {}), data },
  ])
  return app.inject({
    method: 'POST',
    url: '/api/media',
    headers: {
      ...(authed ? headers : { 'x-score-client': 'web' }),
      'content-type': contentType,
    },
    payload: body,
  })
}

test('uploads need a paired browser and the CSRF header, and store nothing otherwise', async () => {
  expect((await upload(png(), { authed: false })).statusCode).toBe(401)
  const { body, contentType } = multipart([{ name: 'file', filename: 'a.png', data: png() }])
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/api/media',
    headers: { cookie: headers.cookie, 'content-type': contentType },
    payload: body,
  })
  expect(noCsrf.statusCode).toBe(403)
  expect(mediaFiles()).toEqual([])
})

test('upload then fetch: bytes, sniffed type and hardening headers', async () => {
  for (const [data, expected] of [
    [png(), 'image/png'],
    [jpeg(), 'image/jpeg'],
    [gif(), 'image/gif'],
    [webp(), 'image/webp'],
  ] as const) {
    // Declared as a lie-free but wrong-named file: the served type still comes from the bytes.
    const response = await upload(data, { filename: '../../evil.html', type: expected })
    expect(response.statusCode).toBe(201)
    const meta = response.json()
    expect(meta).toEqual({
      mediaId: expect.any(String),
      name: 'evil.html',
      size: data.length,
      contentType: expected,
    })
    const fetched = await app.inject({ url: `/api/media/${meta.mediaId}` })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.rawPayload.equals(data)).toBe(true)
    expect(fetched.headers['content-type']).toBe(expected)
    expect(fetched.headers['x-content-type-options']).toBe('nosniff')
    expect(fetched.headers['content-disposition']).toBe('inline')
    expect(fetched.headers['cache-control']).toMatch(/^private, max-age=\d+$/)
  }
})

test('rejects non-images whatever they claim to be', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>')
  expect((await upload(html, { type: 'image/png' })).statusCode).toBe(415)
  expect(
    (
      await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        filename: 'a.svg',
        type: 'image/svg+xml',
      })
    ).statusCode,
  ).toBe(415)
  expect((await upload(png(), { type: 'image/gif' })).statusCode).toBe(415)
  expect((await upload(Buffer.alloc(0))).statusCode).toBe(400)
  expect(mediaFiles()).toEqual([])
})

test('size limits: 8 MB per item, and a body past the route limit is refused early', async () => {
  const atLimit = Buffer.concat([png(), Buffer.alloc(8 * 1024 * 1024 - png().length)])
  expect((await upload(atLimit)).statusCode).toBe(201)
  const over = Buffer.concat([png(), Buffer.alloc(8 * 1024 * 1024 - png().length + 1, 1)])
  const rejected = await upload(over)
  expect(rejected.statusCode).toBe(413)
  expect(rejected.json().error.code).toBe('payload_too_large')
  const huge = await upload(Buffer.alloc(26 * 1024 * 1024, 7))
  expect(huge.statusCode).toBe(413)
  expect(mediaFiles()).toHaveLength(1)
})

test('malformed or ambiguous multipart bodies are rejected', async () => {
  const post = (body: Buffer, contentType: string) =>
    app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...headers, 'content-type': contentType },
      payload: body,
    })
  const two = multipart([
    { name: 'file', filename: 'a.png', data: png(64, 1) },
    { name: 'file', filename: 'b.png', data: png(64, 2) },
  ])
  expect((await post(two.body, two.contentType)).statusCode).toBe(400)
  const wrongField = multipart([{ name: 'other', filename: 'a.png', data: png() }])
  expect((await post(wrongField.body, wrongField.contentType)).statusCode).toBe(400)
  const truncated = multipart([{ name: 'file', filename: 'a.png', data: png() }])
  expect((await post(truncated.body.subarray(0, 60), truncated.contentType)).statusCode).toBe(400)
  expect((await post(truncated.body, 'multipart/form-data')).statusCode).toBe(400)
  const json = await app.inject({
    method: 'POST',
    url: '/api/media',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: '{}',
  })
  expect(json.statusCode).toBe(400)
  expect(mediaFiles()).toEqual([])
})

test('unknown or hostile ids are 404 and never touch the filesystem', async () => {
  const { mediaId } = (await upload(png())).json()
  expect((await app.inject({ url: '/api/media/does-not-exist' })).statusCode).toBe(404)
  for (const id of ['..%2F..%2Fscore.db', '%2e%2e%2fscore.db', '..', mediaFiles()[0]!]) {
    const response = await app.inject({ url: `/api/media/${id}` })
    expect(response.statusCode).toBe(404)
  }
  expect((await app.inject({ url: `/api/media/${mediaId}` })).statusCode).toBe(200)
})

test('a message with attachments references and pins the media; unknown ids are 400', async () => {
  const room = RoomSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers,
        payload: { name: 'pics', leadAgentId: 'lead' },
      })
    ).json(),
  )
  const { mediaId } = (await upload(png())).json()
  const bad = await app.inject({
    method: 'POST',
    url: `/api/rooms/${room.id}/messages`,
    headers,
    payload: { text: 'look', attachments: [{ mediaId: 'missing' }] },
  })
  expect(bad.statusCode).toBe(400)
  const sent = await app.inject({
    method: 'POST',
    url: `/api/rooms/${room.id}/messages`,
    headers,
    payload: { text: 'look', attachments: [{ mediaId }, { mediaId }] },
  })
  expect(sent.statusCode).toBe(200)
  const message = MessageSchema.parse(sent.json().message)
  expect(message.parts).toEqual([
    { kind: 'text', text: 'look' },
    { kind: 'image', mediaId },
  ])
  expect(db.sqlite.prepare('SELECT refs FROM media WHERE id = ?').get(mediaId)).toEqual({ refs: 1 })
})

test('the configured quota evicts the oldest unreferenced upload through the route', async () => {
  const small = buildApp({
    config: { ...loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }), mediaQuotaMb: 1 },
    logger: false,
    db,
    ingest,
    port,
  })
  const paired = await small.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: small.pairing.createToken() },
  })
  const cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
  const send = async (data: Buffer) => {
    const { body, contentType } = multipart([{ name: 'file', filename: 'a.png', data }])
    const response = await small.inject({
      method: 'POST',
      url: '/api/media',
      headers: { 'x-score-client': 'web', cookie, 'content-type': contentType },
      payload: body,
    })
    expect(response.statusCode).toBe(201)
    return response.json().mediaId as string
  }
  const first = await send(png(600_000, 1))
  const second = await send(png(600_000, 2))
  expect((await small.inject({ url: `/api/media/${first}` })).statusCode).toBe(404)
  expect((await small.inject({ url: `/api/media/${second}` })).statusCode).toBe(200)
  // The same store is what Watch frame capture calls for screenshots.
  expect(small.media?.store(png(10, 9), 'image/png').contentType).toBe('image/png')
  await small.close()
})

test('documents: stored by their bytes and served by kind', async () => {
  const fetchOf = async (data: Buffer, filename: string, type?: string) => {
    const stored = await upload(data, { filename, ...(type ? { type } : {}) })
    expect(stored.statusCode).toBe(201)
    const body = stored.json()
    const res = await app.inject({ method: 'GET', url: `/api/media/${body.mediaId}`, headers })
    return { body, res }
  }
  const doc = await fetchOf(pdf(), 'report.pdf', 'application/pdf')
  expect(doc.body.contentType).toBe('application/pdf')
  // A PDF is never rendered by the browser from Score's origin: download + sandbox CSP (audit5-g).
  expect(doc.res.headers['content-type']).toBe('application/octet-stream')
  expect(doc.res.headers['content-disposition']).toMatch(/^attachment/)
  expect(doc.res.headers['x-content-type-options']).toBe('nosniff')
  expect(doc.res.headers['content-security-policy']).toContain('sandbox')

  const word = await fetchOf(docx(), 'a b.docx')
  expect(word.res.headers['content-type']).toBe('application/octet-stream')
  expect(word.res.headers['content-disposition']).toMatch(/^attachment/)
  const sheet = await app.inject({
    method: 'GET',
    url: `/api/media/${(await fetchOf(xlsx(), 's.xlsx')).body.mediaId}?name=../x%0Ay.xlsx`,
    headers,
  })
  expect(sheet.headers['content-disposition']).toBe("attachment; filename*=UTF-8''xy.xlsx")

  const html = await fetchOf(Buffer.from('<script>alert(1)</script>'), 'page.html', 'text/html')
  expect(html.body.contentType).toBe('text/html')
  expect(html.res.headers['content-type']).toBe('text/plain; charset=utf-8')
  expect(html.res.headers['content-security-policy']).toContain('sandbox')

  const csv = await fetchOf(Buffer.from('a,b\n1,2\n'), 'data.csv', 'text/csv')
  expect(csv.body.contentType).toBe('text/csv')
  expect(
    (
      await app.inject({
        method: 'GET',
        url: `/api/media/${csv.body.mediaId}?download=1&name=data.csv`,
        headers,
      })
    ).headers['content-disposition'],
  ).toBe("attachment; filename*=UTF-8''data.csv")
})

test('documents the allowlist does not cover are refused, however they are named or labelled', async () => {
  expect(
    (await upload(Buffer.from('MZ\x90\x00'), { filename: 'a.pdf', type: 'application/pdf' }))
      .statusCode,
  ).toBe(415)
  expect((await upload(Buffer.from('hi'), { filename: 'a.sh' })).statusCode).toBe(415)
  expect((await upload(pdf(), { filename: 'a.pdf', type: 'image/png' })).statusCode).toBe(415)
  expect((await upload(Buffer.from('PK\x03\x04junk'), { filename: 'a.docx' })).statusCode).toBe(415)
  expect(mediaFiles()).toEqual([])
})

// audit5-g: references go back when the message that held them is deleted or rewound away.
test('deleting or rewinding a message releases its media references', async () => {
  const room = RoomSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers,
        payload: { name: 'refs', leadAgentId: 'lead' },
      })
    ).json(),
  )
  const refs = (id: string) =>
    (db.sqlite.prepare('SELECT refs FROM media WHERE id = ?').get(id) as { refs: number }).refs
  const send = async (mediaId: string) =>
    MessageSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/api/rooms/${room.id}/messages`,
          headers,
          payload: { text: 'look', attachments: [{ mediaId }] },
        })
      ).json().message,
    )
  const first = (await upload(unique(2000))).json().mediaId
  const second = (await upload(unique(2000))).json().mediaId
  const one = await send(first)
  const two = await send(second)
  expect([refs(first), refs(second)]).toEqual([1, 1])
  // The fake agent is already answering; this test is about references, not routing.
  db.sqlite.exec('UPDATE messages SET streaming = 0')
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/rooms/${room.id}/messages/${one.id}`,
    headers,
  })
  expect(removed.statusCode, removed.body).toBeLessThan(300)
  await app.inject({
    method: 'DELETE',
    url: `/api/rooms/${room.id}/messages/${one.id}`,
    headers,
  })
  expect(refs(first)).toBe(0)
  db.sqlite.exec("UPDATE message_runs SET state = 'completed'")
  const rewound = await app.inject({
    method: 'POST',
    url: `/api/rooms/${room.id}/messages/${two.id}/rewind`,
    headers,
    payload: { mode: 'delete' },
  })
  expect(rewound.statusCode, rewound.body).toBe(200)
  expect(refs(second)).toBe(0)
})
