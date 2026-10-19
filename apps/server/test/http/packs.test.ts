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
import { AgentSummarySchema, PetPackSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'
import {
  apngImage,
  gifImage,
  jpegImage,
  multipartFiles,
  padTo,
  pngImage,
  webpImage,
  zipOf,
} from '../helpers/pack-images.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie: string
async function boot() {
  port = new FakePort(1, { db: env.db }, false)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: env.home }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
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
const packs = () => join(env.home, 'packs')
const guardHeaders = () => ({ 'x-score-client': 'web', cookie })
type Upload = { name: string; bytes: Buffer }[]
function put(files: Upload, agent = 'builder', headers = guardHeaders()) {
  const body = multipartFiles(files)
  return app.inject({
    method: 'PUT',
    url: `/api/agents/${agent}/pack`,
    headers: { ...headers, ...body.headers },
    payload: body.payload,
  })
}
const remove = (agent = 'builder', headers = guardHeaders()) =>
  app.inject({ method: 'DELETE', url: `/api/agents/${agent}/pack`, headers })
const get = (activity: string, rev: string | undefined, agent = 'builder') =>
  app.inject({
    url: `/api/agents/${agent}/pack/${activity}${rev === undefined ? '' : `?rev=${rev}`}`,
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
const idle = webpImage(128, 128, 'VP8X', { animated: true })
const work = gifImage(128, 128, 3)
const think = apngImage(96, 96)
const basic: Upload = [
  { name: 'idle.webp', bytes: idle },
  { name: 'work.gif', bytes: work },
  { name: 'think.png', bytes: think },
  { name: 'pet.json', bytes: Buffer.from('{"name":"Round","credits":"me","floor":0.12}') },
]
const revOf = (response: { json: () => { agent: { style: { pack: { rev: string } } } } }) =>
  response.json().agent.style.pack.rev

test('PUT of several files stores the pack, returns the agent with a new revision, says so, and GET serves each file', async () => {
  const response = await put(basic)
  expect(response.statusCode, response.body).toBe(200)
  const { agent, ignored } = response.json()
  expect(ignored).toEqual([])
  const summary = AgentSummarySchema.parse(agent)
  const pack = PetPackSchema.parse(summary.style.pack)
  expect(pack).toMatchObject({
    activities: ['idle', 'work', 'think'],
    name: 'Round',
    credits: 'me',
    floor: 0.12,
  })
  expect(events().at(-1).style.pack).toEqual(pack)
  const folder = join(packs(), 'builder', pack.rev)
  expect(readdirSync(folder).sort()).toEqual(['idle.webp', 'think.png', 'work.gif'])
  expect(statSync(join(folder, 'idle.webp')).mode & 0o777).toBe(0o600)
  expect(statSync(folder).mode & 0o777).toBe(0o700)
  expect(statSync(join(packs(), 'builder')).mode & 0o777).toBe(0o700)
  expect(statSync(packs()).mode & 0o777).toBe(0o700)
  expect(env.db.sqlite.prepare('SELECT pack_rev FROM agent_styles').all()).toEqual([
    { pack_rev: pack.rev },
  ])
  expect((await app.inject('/api/agents/builder')).json().style.pack).toEqual(pack)

  for (const [activity, bytes, type] of [
    ['idle', idle, 'image/webp'],
    ['work', work, 'image/gif'],
    ['think', think, 'image/png'],
  ] as const) {
    const served = await get(activity, pack.rev)
    expect(served.statusCode, activity).toBe(200)
    expect(served.rawPayload.equals(bytes)).toBe(true)
    expect(served.headers).toMatchObject({
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=31536000, immutable',
    })
  }
  // An activity the pack lacks, or that is no activity at all.
  expect((await get('sleep', pack.rev)).statusCode).toBe(404)
  expect((await get('dance', pack.rev)).statusCode).toBe(404)
})

test('PUT of a zip, with its one folder, reads the same and lists what it left out', async () => {
  const zip = await zipOf({
    'luna/': '',
    'luna/idle.webp': idle,
    'luna/sleep.gif': work,
    'luna/pet.json': '{"name":"Zipped"}',
    'luna/README.txt': 'hello',
    '__MACOSX/luna/._idle.webp': 'x',
    '.DS_Store': 'x',
  })
  const response = await put([{ name: 'luna.zip', bytes: zip }])
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().ignored).toEqual([
    '.DS_Store',
    '__MACOSX/luna/._idle.webp',
    'luna/README.txt',
  ])
  expect(response.json().agent.style.pack).toMatchObject({
    activities: ['idle', 'sleep'],
    name: 'Zipped',
    credits: null,
    floor: 0,
  })
  const rev = revOf(response)
  expect((await get('sleep', rev)).headers['content-type']).toBe('image/gif')
})

test('a new pack replaces the old one: new revision, old folder removed, old revision 404', async () => {
  const first = revOf(await put(basic))
  const second = revOf(await put([{ name: 'idle.gif', bytes: work }]))
  expect(second).not.toBe(first)
  expect(readdirSync(join(packs(), 'builder'))).toEqual([second])
  expect((await get('idle', first)).statusCode).toBe(404)
  expect((await get('work', second)).statusCode).toBe(404)
  expect((await get('idle', second)).statusCode).toBe(200)
  expect(
    events()
      .map((e) => e.style.pack?.rev)
      .slice(-2),
  ).toEqual([first, second])
})

test('GET: no pack, a stale revision, a bad or missing revision, an unknown agent', async () => {
  await app.inject('/api/agents')
  expect((await get('idle', 'anything')).statusCode).toBe(404)
  const rev = revOf(await put(basic))
  expect((await get('idle', 'anything')).statusCode).toBe(404)
  expect((await get('idle', rev, 'missing')).statusCode).toBe(404)
  expect((await get('idle', rev, 'lead')).statusCode).toBe(404)
  expect((await get('idle', undefined)).statusCode).toBe(400)
  expect((await get('idle', '..%2Fx')).statusCode).toBe(400)
  expect((await get('idle', rev, 'Not%20A%20Name')).statusCode).toBe(400)
  expect((await get('idle', rev)).statusCode).toBe(200)
})

test('GET never follows a symbolic link in the file, the revision, the agent folder or the packs folder', async () => {
  const outside = join(env.home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.webp'), idle)
  const rev = revOf(await put([{ name: 'idle.webp', bytes: idle }]))
  const agentFolder = join(packs(), 'builder')
  rmSync(join(agentFolder, rev, 'idle.webp'))
  symlinkSync(join(outside, 'secret.webp'), join(agentFolder, rev, 'idle.webp'))
  expect((await get('idle', rev)).statusCode).toBe(404)
  rmSync(join(agentFolder, rev), { recursive: true })
  mkdirSync(join(outside, 'rev'))
  writeFileSync(join(outside, 'rev', 'idle.webp'), idle)
  symlinkSync(join(outside, 'rev'), join(agentFolder, rev))
  expect((await get('idle', rev)).statusCode).toBe(404)
  rmSync(agentFolder, { recursive: true })
  mkdirSync(join(outside, 'agent', rev), { recursive: true })
  writeFileSync(join(outside, 'agent', rev, 'idle.webp'), idle)
  symlinkSync(join(outside, 'agent'), agentFolder)
  expect((await get('idle', rev)).statusCode).toBe(404)
  rmSync(packs(), { recursive: true })
  mkdirSync(join(outside, 'builder', rev), { recursive: true })
  writeFileSync(join(outside, 'builder', rev, 'idle.webp'), idle)
  symlinkSync(outside, packs())
  expect((await get('idle', rev)).statusCode).toBe(404)
  // And a write through a planted link is refused, leaving the link's target alone.
  expect((await put(basic)).statusCode).toBe(500)
  expect(readdirSync(join(outside, 'builder'))).toEqual([rev])
})

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
test.each([
  ['idle missing', () => [{ name: 'work.gif', bytes: work }], 'idle is missing'],
  [
    'nothing at all usable',
    () => [{ name: 'notes.txt', bytes: Buffer.from('x') }],
    'idle is missing',
  ],
  ['an unknown activity name', () => [...basic, { name: 'dance.webp', bytes: idle }], 'dance.webp'],
  [
    'a type other than webp, png or gif',
    () => [...basic, { name: 'walk.jpg', bytes: jpegImage(100, 100) }],
    'walk.jpg',
  ],
  [
    'two files for one activity',
    () => [...basic, { name: 'idle.gif', bytes: work }],
    'one file per activity',
  ],
  ['an SVG called .png', () => [{ name: 'idle.png', bytes: svg }], 'SVG'],
  ['a name that disagrees with the bytes', () => [{ name: 'idle.gif', bytes: idle }], 'idle.gif'],
  ['an image under 64 px', () => [{ name: 'idle.png', bytes: pngImage(63, 100) }], '64 and 2048'],
  [
    'an image over 2048 px',
    () => [{ name: 'idle.webp', bytes: webpImage(2049, 100) }],
    '64 and 2048',
  ],
  [
    'an image over 32 MB',
    () => [{ name: 'idle.webp', bytes: padTo(idle, 32 * 1024 * 1024 + 2) }],
    '32 MB',
  ],
  [
    'pet.json that is not JSON',
    () => [...basic.slice(0, 1), { name: 'pet.json', bytes: Buffer.from('{no') }],
    'pet.json',
  ],
  [
    'pet.json with a floor out of range',
    () => [...basic.slice(0, 1), { name: 'pet.json', bytes: Buffer.from('{"floor":0.9}') }],
    'pet.json',
  ],
  [
    'more than 24 files',
    () => [
      ...basic,
      ...Array.from({ length: 22 }, (_, i) => ({ name: `n${i}.txt`, bytes: Buffer.from('x') })),
    ],
    '24 files',
  ],
  [
    'a zip together with another file',
    async () => [
      { name: 'a.zip', bytes: await zipOf({ 'idle.webp': idle }) },
      { name: 'work.gif', bytes: work },
    ],
    'either one zip',
  ],
  [
    'a file called .zip that is not one',
    () => [{ name: 'pack.zip', bytes: Buffer.from('hello') }],
    'zip',
  ],
  [
    'a zip with a link in it',
    async () => [
      {
        name: 'a.zip',
        bytes: await zipOf({ 'idle.webp': idle, 'x.png': 'idle.webp' }, { links: ['x.png'] }),
      },
    ],
    'symbolic link',
  ],
  [
    'a zip bomb',
    async () => [
      {
        name: 'a.zip',
        bytes: await zipOf({
          'idle.png': padTo(pngImage(64, 64), 4 * 1024 * 1024),
        }),
      },
    ],
    'zip bomb',
  ],
  [
    'a zip that leaves its folder',
    async () => [{ name: 'a.zip', bytes: await zipOf({ 'idle.webp': idle, '../work.gif': work }) }],
    'leaves the folder',
  ],
])(
  'PUT refuses %s with 422 pack_rejected, stores nothing and says nothing',
  async (_name, make, reason) => {
    await app.inject('/api/agents')
    const before = events().length
    const response = await put(await make())
    expect(response.statusCode, response.body).toBe(422)
    const error = response.json().error
    expect(error.code).toBe('pack_rejected')
    expect(error.details.reasons.join(' ')).toContain(reason)
    expect(existsSync(packs())).toBe(false)
    expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
    expect(events()).toHaveLength(before)
  },
)

test('PUT refuses a request that is not files, and a body far beyond the limit', async () => {
  const noFile = await app.inject({
    method: 'PUT',
    url: '/api/agents/builder/pack',
    headers: { ...guardHeaders(), 'content-type': 'multipart/form-data; boundary=xx' },
    payload: '--xx--\r\n',
  })
  expect(noFile.statusCode).toBe(400)
  const json = await app.inject({
    method: 'PUT',
    url: '/api/agents/builder/pack',
    headers: guardHeaders(),
    payload: { file: 'x' },
  })
  expect(json.statusCode).toBeGreaterThanOrEqual(400)
  expect(json.statusCode).toBeLessThan(500)
  const huge = await put([{ name: 'idle.webp', bytes: Buffer.alloc(265 * 1024 * 1024) }])
  expect(huge.statusCode).toBe(413)
  expect(existsSync(packs())).toBe(false)
})

test('PUT and DELETE need a paired browser with the web client header, and an agent that exists', async () => {
  await app.inject('/api/agents')
  expect((await put(basic, 'builder', { 'x-score-client': 'web' } as never)).statusCode).toBe(401)
  expect((await put(basic, 'builder', { cookie } as never)).statusCode).toBe(403)
  expect((await remove('builder', { 'x-score-client': 'web' } as never)).statusCode).toBe(401)
  expect((await remove('builder', { cookie } as never)).statusCode).toBe(403)
  expect((await put(basic, 'missing')).statusCode).toBe(404)
  expect((await remove('missing')).statusCode).toBe(404)
  expect((await put(basic, '..%2Fx')).statusCode).toBeGreaterThanOrEqual(400)
  expect(existsSync(packs())).toBe(false)
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
})

test('DELETE removes the pack and its folder, says so once, and a second DELETE changes nothing', async () => {
  const rev = revOf(await put(basic))
  const sent = events().length
  const response = await remove()
  expect(response.statusCode).toBe(200)
  expect(AgentSummarySchema.parse(response.json()).style.pack).toBeNull()
  expect(events()).toHaveLength(sent + 1)
  expect(events().at(-1).style.pack).toBeNull()
  expect(readdirSync(join(packs(), 'builder'))).toEqual([])
  expect((await get('idle', rev)).statusCode).toBe(404)
  expect(env.db.sqlite.prepare('SELECT pack_rev, pack_meta FROM agent_styles').all()).toEqual([
    { pack_rev: null, pack_meta: null },
  ])
  expect((await remove()).statusCode).toBe(200)
  expect(events()).toHaveLength(sent + 1)
})

test('the pack survives changes to colour, shape and look, and a restart; a style change keeps it and a forged one is ignored', async () => {
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/agents/builder/style',
    headers: guardHeaders(),
    payload: { color: '#334455', shape: 'cloud', look: 'ring' },
  })
  expect(patched.statusCode).toBe(200)
  const pack = (await put(basic)).json().agent.style.pack
  expect((await app.inject('/api/agents/builder')).json().style).toEqual({
    color: '#334455',
    shape: 'cloud',
    look: 'ring',
    pack,
  })
  const again = await app.inject({
    method: 'PATCH',
    url: '/api/agents/builder/style',
    headers: guardHeaders(),
    payload: { shape: 'moon', pack: { ...pack, rev: 'forged' } },
  })
  expect(again.json().style).toMatchObject({ shape: 'moon', pack })
  await app.close()
  await boot()
  expect((await app.inject('/api/agents/builder')).json().style.pack).toEqual(pack)
  expect((await get('idle', pack.rev)).statusCode).toBe(200)
})

test('a failed commit removes the folder it wrote and changes nothing', async () => {
  await app.inject('/api/agents')
  env.db.sqlite.exec(
    "CREATE TRIGGER reject_pack BEFORE INSERT ON events WHEN NEW.type = 'agent.updated' AND json_extract(NEW.data, '$.style.pack') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  )
  expect((await put(basic)).statusCode).toBe(500)
  expect(readdirSync(join(packs(), 'builder'))).toEqual([])
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
  expect((await app.inject('/api/agents/builder')).json().style.pack ?? null).toBeNull()
})

test('a pack whose stored meta is damaged reads as none, and is not served', async () => {
  const rev = revOf(await put(basic))
  for (const stored of [
    '{not json',
    '{"activities":[]}',
    '[]',
    '{"activities":["idle"],"floor":9}',
  ]) {
    env.db.sqlite.prepare('UPDATE agent_styles SET pack_meta = ?').run(stored)
    await app.close()
    await boot()
    expect((await app.inject('/api/agents/builder')).json().style.pack ?? null, stored).toBeNull()
    expect((await get('idle', rev)).statusCode, stored).toBe(404)
  }
})

test('start-up recovery keeps the current revision and removes strays, temp folders and orphans', async () => {
  const rev = revOf(await put(basic))
  const folder = join(packs(), 'builder')
  mkdirSync(join(folder, 'oldrevision000001'))
  writeFileSync(join(folder, 'oldrevision000001', 'idle.webp'), idle)
  mkdirSync(join(folder, '.tmp-ab12'))
  mkdirSync(join(packs(), 'ghost'))
  writeFileSync(join(packs(), 'ghost', 'idle.webp'), idle)
  await app.close()
  await boot()
  expect(readdirSync(packs())).toEqual(['builder'])
  expect(readdirSync(folder)).toEqual([rev])
  expect((await get('idle', rev)).statusCode).toBe(200)
})
