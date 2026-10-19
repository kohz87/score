import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { AgentSummarySchema } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { AVATAR_MAX_BYTES } from '../../src/avatars/sniff.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'
import {
  jpegImage,
  multipartFile,
  pngChunk,
  pngImage,
  webpImage,
} from '../helpers/avatar-images.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie: string
const config = () => loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: env.home })
async function boot() {
  port = new FakePort(1, { db: env.db }, false)
  app = buildApp({ config: config(), logger: false, port, db: env.db, ingest: env.ingest })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
}
beforeEach(async () => {
  env = setup()
  await boot()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
const avatars = () => join(env.home, 'avatars')
const guardHeaders = () => ({ 'x-score-client': 'web', cookie })
function put(filename: string, bytes: Buffer, agent = 'builder', headers = guardHeaders()) {
  const body = multipartFile(filename, bytes)
  return app.inject({
    method: 'PUT',
    url: `/api/agents/${agent}/avatar`,
    headers: { ...headers, ...body.headers },
    payload: body.payload,
  })
}
const remove = (agent = 'builder', headers = guardHeaders()) =>
  app.inject({ method: 'DELETE', url: `/api/agents/${agent}/avatar`, headers })
const get = (rev: string | undefined, agent = 'builder') =>
  app.inject({
    url: `/api/agents/${agent}/avatar${rev === undefined ? '' : `?rev=${rev}`}`,
    headers: { cookie },
  })
function events(agent = 'builder') {
  return env.db.sqlite
    .prepare(
      "SELECT data FROM events WHERE type = 'agent.updated' AND json_extract(data, '$.id') = ? ORDER BY seq",
    )
    .all(agent)
    .map((row) => JSON.parse(String(row.data)))
}
const png = pngImage(64, 64)

test('PUT stores the picture, returns the agent with a new revision, says so, and GET serves the exact bytes', async () => {
  const response = await put('me.png', png)
  expect(response.statusCode, response.body).toBe(200)
  const agent = AgentSummarySchema.parse(response.json())
  const rev = agent.style.avatar!
  expect(rev).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  expect(events().at(-1).style.avatar).toBe(rev)
  const file = join(avatars(), 'builder', `${rev}.png`)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(join(avatars(), 'builder')).mode & 0o777).toBe(0o700)
  expect(env.db.sqlite.prepare('SELECT avatar_rev FROM agent_styles').all()).toEqual([
    { avatar_rev: rev },
  ])
  expect((await app.inject('/api/agents/builder')).json().style.avatar).toBe(rev)

  const served = await get(rev)
  expect(served.statusCode).toBe(200)
  expect(served.rawPayload.equals(png)).toBe(true)
  expect(served.headers).toMatchObject({
    'content-type': 'image/png',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'cache-control': 'private, max-age=31536000, immutable',
  })
})

test('JPEG and WebP are served with their own types', async () => {
  const jpeg = jpegImage(120, 90)
  const rev = (await put('a.JPG', jpeg)).json().style.avatar
  const served = await get(rev)
  expect(served.headers['content-type']).toBe('image/jpeg')
  expect(served.rawPayload.equals(jpeg)).toBe(true)
  const webp = webpImage(200, 200, 'VP8X')
  const next = (await put('a.webp', webp)).json().style.avatar
  expect((await get(next)).headers['content-type']).toBe('image/webp')
  expect(readdirSync(join(avatars(), 'builder'))).toEqual([`${next}.webp`])
})

test('a new picture replaces the old one: new revision, old file removed, old revision 404', async () => {
  const first = (await put('a.png', png)).json().style.avatar
  const second = (await put('b.png', pngImage(80, 80))).json().style.avatar
  expect(second).not.toBe(first)
  expect(readdirSync(join(avatars(), 'builder'))).toEqual([`${second}.png`])
  expect((await get(first)).statusCode).toBe(404)
  expect((await get(second)).statusCode).toBe(200)
  expect(
    events()
      .map((style) => style.style.avatar)
      .slice(-2),
  ).toEqual([first, second])
})

test('GET: no picture, a stale or unknown revision, a bad revision, or an unknown agent are 404 or 400', async () => {
  await app.inject('/api/agents')
  expect((await get('anything')).statusCode).toBe(404)
  const rev = (await put('a.png', png)).json().style.avatar
  expect((await get('anything')).statusCode).toBe(404)
  expect((await get(rev, 'missing')).statusCode).toBe(404)
  expect((await get(undefined)).statusCode).toBe(400)
  expect((await get('../x')).statusCode).toBe(400)
  expect((await get(rev, 'lead')).statusCode).toBe(404)
  expect((await get(rev)).statusCode).toBe(200)
})

test('GET never follows a symbolic link in the file, the agent folder or the avatars folder', async () => {
  const outside = join(env.home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.png'), png)
  const rev = (await put('a.png', png)).json().style.avatar
  const file = join(avatars(), 'builder', `${rev}.png`)
  rmSync(file)
  symlinkSync(join(outside, 'secret.png'), file)
  expect((await get(rev)).statusCode).toBe(404)
  rmSync(join(avatars(), 'builder'), { recursive: true })
  mkdirSync(join(outside, 'folder'))
  writeFileSync(join(outside, 'folder', `${rev}.png`), png)
  symlinkSync(join(outside, 'folder'), join(avatars(), 'builder'))
  expect((await get(rev)).statusCode).toBe(404)
  rmSync(avatars(), { recursive: true })
  mkdirSync(join(outside, 'builder'))
  writeFileSync(join(outside, 'builder', `${rev}.png`), png)
  symlinkSync(outside, avatars())
  expect((await get(rev)).statusCode).toBe(404)
  // And a write through a planted link is refused, leaving the link's target alone.
  expect((await put('a.png', png)).statusCode).toBe(500)
  expect(readdirSync(join(outside, 'builder'))).toEqual([`${rev}.png`])
})

test.each([
  ['more than 2 MB', 'a.png', () => Buffer.concat([png, Buffer.alloc(AVATAR_MAX_BYTES)]), '2 MB'],
  ['a name that disagrees with the bytes', 'a.jpg', () => png, 'PNG'],
  ['no extension', 'picture', () => png, 'Rename'],
  [
    'an SVG',
    'a.svg',
    () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    'SVG',
  ],
  [
    'an SVG called .png',
    'a.png',
    () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    'SVG',
  ],
  ['a GIF', 'a.gif', () => Buffer.from('GIF89a\x40\x00\x40\x00\x00\x00\x00;'), 'PNG, JPEG or WebP'],
  ['text', 'a.png', () => Buffer.from('not a picture'), 'PNG, JPEG or WebP'],
  ['an empty file', 'a.png', () => Buffer.alloc(0), 'empty'],
  [
    'an animated PNG',
    'a.png',
    () => pngImage(64, 64, [pngChunk('acTL', Buffer.alloc(8))]),
    'Animated',
  ],
  ['an animated WebP', 'a.webp', () => webpImage(64, 64, 'VP8X', { animated: true }), 'Animated'],
  ['a picture under 32 px', 'a.png', () => pngImage(31, 100), '32 and 2048'],
  ['a picture over 2048 px', 'a.webp', () => webpImage(2049, 100), '32 and 2048'],
])(
  'PUT refuses %s with 422 avatar_rejected, stores nothing and says nothing',
  async (_name, filename, make, reason) => {
    await app.inject('/api/agents')
    const before = events().length
    const response = await put(filename, make())
    expect(response.statusCode, response.body).toBe(422)
    const error = response.json().error
    expect(error.code).toBe('avatar_rejected')
    expect(error.details.reasons.join(' ')).toContain(reason)
    expect(existsSync(avatars())).toBe(false)
    expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
    expect(events()).toHaveLength(before)
  },
)

test('PUT refuses a request that is not one file, and a body far beyond the limit', async () => {
  const noFile = await app.inject({
    method: 'PUT',
    url: '/api/agents/builder/avatar',
    headers: { ...guardHeaders(), 'content-type': 'multipart/form-data; boundary=xx' },
    payload: '--xx--\r\n',
  })
  expect(noFile.statusCode).toBe(400)
  const json = await app.inject({
    method: 'PUT',
    url: '/api/agents/builder/avatar',
    headers: guardHeaders(),
    payload: { file: 'x' },
  })
  expect(json.statusCode).toBeGreaterThanOrEqual(400)
  expect(json.statusCode).toBeLessThan(500)
  const huge = await put('a.png', Buffer.alloc(40 * 1024 * 1024))
  expect(huge.statusCode).toBe(413)
  expect(existsSync(avatars())).toBe(false)
})

test('PUT and DELETE need a paired browser with the web client header, and an agent that exists', async () => {
  await app.inject('/api/agents')
  expect(
    (await put('a.png', png, 'builder', { 'x-score-client': 'web' } as never)).statusCode,
  ).toBe(401)
  expect((await put('a.png', png, 'builder', { cookie } as never)).statusCode).toBe(403)
  expect((await remove('builder', { 'x-score-client': 'web' } as never)).statusCode).toBe(401)
  expect((await remove('builder', { cookie } as never)).statusCode).toBe(403)
  expect((await put('a.png', png, 'missing')).statusCode).toBe(404)
  expect((await remove('missing')).statusCode).toBe(404)
  expect((await put('a.png', png, '..%2Fx')).statusCode).toBeGreaterThanOrEqual(400)
  expect(existsSync(avatars())).toBe(false)
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
})

test('DELETE removes the picture and the file, says so once, and a second DELETE changes nothing', async () => {
  const rev = (await put('a.png', png)).json().style.avatar
  const sent = events().length
  const response = await remove()
  expect(response.statusCode).toBe(200)
  expect(AgentSummarySchema.parse(response.json()).style.avatar).toBeNull()
  expect(events()).toHaveLength(sent + 1)
  expect(events().at(-1).style.avatar).toBeNull()
  expect(readdirSync(join(avatars(), 'builder'))).toEqual([])
  expect((await get(rev)).statusCode).toBe(404)
  expect(env.db.sqlite.prepare('SELECT avatar_rev FROM agent_styles').all()).toEqual([
    { avatar_rev: null },
  ])
  expect((await remove()).statusCode).toBe(200)
  expect(events()).toHaveLength(sent + 1)
})

test('the picture survives changes to colour, shape and look, and a restart; a picture keeps them too', async () => {
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/agents/builder/style',
    headers: guardHeaders(),
    payload: { color: '#334455', shape: 'cloud', look: 'chibi' },
  })
  expect(patched.statusCode).toBe(200)
  const rev = (await put('a.png', png)).json().style.avatar
  expect((await app.inject('/api/agents/builder')).json().style).toEqual({
    color: '#334455',
    shape: 'cloud',
    look: 'chibi',
    avatar: rev,
    avatarEyes: null,
  })
  const again = await app.inject({
    method: 'PATCH',
    url: '/api/agents/builder/style',
    headers: guardHeaders(),
    payload: { shape: 'moon', avatar: 'forged' },
  })
  expect(again.json().style).toMatchObject({ shape: 'moon', avatar: rev })
  await app.close()
  await boot()
  expect((await app.inject('/api/agents/builder')).json().style.avatar).toBe(rev)
  expect((await get(rev)).statusCode).toBe(200)
})

test('a failed commit removes the file it wrote and changes nothing', async () => {
  await app.inject('/api/agents')
  env.db.sqlite.exec(
    "CREATE TRIGGER reject_avatar BEFORE INSERT ON events WHEN NEW.type = 'agent.updated' AND json_extract(NEW.data, '$.style.avatar') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  )
  expect((await put('a.png', png)).statusCode).toBe(500)
  expect(readdirSync(join(avatars(), 'builder'))).toEqual([])
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
  expect((await app.inject('/api/agents/builder')).json().style.avatar ?? null).toBeNull()
})

test('start-up recovery keeps the current picture and removes strays, temp files and orphans', async () => {
  const rev = (await put('a.png', png)).json().style.avatar
  const folder = join(avatars(), 'builder')
  writeFileSync(join(folder, 'oldrevision000001.png'), png)
  writeFileSync(join(folder, `${rev}.png.tmp-ab12`), png)
  mkdirSync(join(avatars(), 'ghost'))
  writeFileSync(join(avatars(), 'ghost', 'x.png'), png)
  await app.close()
  await boot()
  expect(readdirSync(avatars())).toEqual(['builder'])
  expect(readdirSync(folder)).toEqual([`${rev}.png`])
  expect((await get(rev)).statusCode).toBe(200)
})

const eyes = {
  left: { x: 0.3, y: 0.5, w: 0.1, h: 0.12 },
  right: { x: 0.56, y: 0.41, w: 0.12, h: 0.13 },
  lid: '#fce9df',
}
const putEyes = (body: unknown, agent = 'builder', headers = guardHeaders()) =>
  app.inject({
    method: 'PUT',
    url: `/api/agents/${agent}/avatar/eyes`,
    headers,
    payload: body as object,
  })
const removeEyes = (agent = 'builder', headers = guardHeaders()) =>
  app.inject({ method: 'DELETE', url: `/api/agents/${agent}/avatar/eyes`, headers })

test('eye marks: PUT stores them with the picture, returns the agent, says so, and survives a restart', async () => {
  const rev = (await put('a.png', png)).json().style.avatar
  const sent = events().length
  const response = await putEyes(eyes)
  expect(response.statusCode, response.body).toBe(200)
  const agent = AgentSummarySchema.parse(response.json())
  expect(agent.style).toMatchObject({ avatar: rev, avatarEyes: eyes })
  expect(events()).toHaveLength(sent + 1)
  expect(events().at(-1).style.avatarEyes).toEqual(eyes)
  expect(
    JSON.parse(
      String(env.db.sqlite.prepare('SELECT avatar_eyes FROM agent_styles').get()!.avatar_eyes),
    ),
  ).toEqual(eyes)
  expect((await app.inject('/api/agents/builder')).json().style.avatarEyes).toEqual(eyes)
  // The same marks again say nothing; moved marks do.
  expect((await putEyes(eyes)).statusCode).toBe(200)
  expect(events()).toHaveLength(sent + 1)
  const moved = { ...eyes, lid: '#112233' }
  expect((await putEyes(moved)).json().style.avatarEyes.lid).toBe('#112233')
  expect(events()).toHaveLength(sent + 2)
  await app.close()
  await boot()
  expect((await app.inject('/api/agents/builder')).json().style).toMatchObject({
    avatar: rev,
    avatarEyes: moved,
  })
})

test('eye marks: no picture is 404; a box outside the picture, a bad lid or a missing eye is 400; nothing is stored', async () => {
  await app.inject('/api/agents')
  expect((await putEyes(eyes)).statusCode).toBe(404)
  await put('a.png', png)
  const sent = events().length
  for (const bad of [
    { ...eyes, left: { x: 0.95, y: 0.5, w: 0.1, h: 0.1 } },
    { ...eyes, left: { x: 0.1, y: 0.1, w: 0, h: 0.1 } },
    { ...eyes, lid: 'skin' },
    { left: eyes.left, lid: eyes.lid },
    {},
    null,
  ])
    expect((await putEyes(bad)).statusCode, JSON.stringify(bad)).toBe(400)
  expect(env.db.sqlite.prepare('SELECT avatar_eyes FROM agent_styles').all()).toEqual([
    { avatar_eyes: null },
  ])
  expect(events()).toHaveLength(sent)
})

test('eye marks: guard, CSRF header and unknown agent are enforced on PUT and DELETE', async () => {
  await put('a.png', png)
  expect((await putEyes(eyes, 'builder', { 'x-score-client': 'web' } as never)).statusCode).toBe(
    401,
  )
  expect((await putEyes(eyes, 'builder', { cookie } as never)).statusCode).toBe(403)
  expect((await removeEyes('builder', { 'x-score-client': 'web' } as never)).statusCode).toBe(401)
  expect((await removeEyes('builder', { cookie } as never)).statusCode).toBe(403)
  expect((await putEyes(eyes, 'missing')).statusCode).toBe(404)
  expect((await removeEyes('missing')).statusCode).toBe(404)
  expect(env.db.sqlite.prepare('SELECT avatar_eyes FROM agent_styles').all()).toEqual([
    { avatar_eyes: null },
  ])
})

test('eye marks: DELETE clears them once, and a second DELETE changes nothing', async () => {
  await put('a.png', png)
  await putEyes(eyes)
  const sent = events().length
  const response = await removeEyes()
  expect(response.statusCode).toBe(200)
  expect(response.json().style.avatarEyes).toBeNull()
  expect(response.json().style.avatar).toEqual(expect.any(String))
  expect(events()).toHaveLength(sent + 1)
  expect((await removeEyes()).statusCode).toBe(200)
  expect(events()).toHaveLength(sent + 1)
  // Also fine for an agent with no picture at all.
  await remove()
  expect((await removeEyes()).statusCode).toBe(200)
})

test('a new picture and DELETE …/avatar both clear the marks; colour, shape and look changes keep them', async () => {
  await put('a.png', png)
  await putEyes(eyes)
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/agents/builder/style',
    headers: guardHeaders(),
    payload: { shape: 'gem', look: 'chibi', avatarEyes: { forged: true } },
  })
  expect(patched.statusCode).toBe(200)
  expect(patched.json().style.avatarEyes).toEqual(eyes)
  const replaced = await put('b.png', pngImage(80, 80))
  expect(replaced.json().style.avatarEyes).toBeNull()
  expect(events().at(-1).style.avatarEyes).toBeNull()
  await putEyes(eyes)
  const removed = await remove()
  expect(removed.json().style).toMatchObject({ avatar: null, avatarEyes: null })
  expect(env.db.sqlite.prepare('SELECT avatar_rev, avatar_eyes FROM agent_styles').all()).toEqual([
    { avatar_rev: null, avatar_eyes: null },
  ])
  // With the picture gone there is nothing to mark.
  expect((await putEyes(eyes)).statusCode).toBe(404)
})

test('marks stored as invalid JSON, or outside the schema, read as none', async () => {
  await put('a.png', png)
  await putEyes(eyes)
  for (const stored of ['{not json', '{"left":1}', '[]']) {
    env.db.sqlite.prepare('UPDATE agent_styles SET avatar_eyes = ?').run(stored)
    await app.close()
    await boot()
    const style = (await app.inject('/api/agents/builder')).json().style
    expect(style.avatarEyes ?? null, stored).toBeNull()
    expect(style.avatar).toEqual(expect.any(String))
  }
})
