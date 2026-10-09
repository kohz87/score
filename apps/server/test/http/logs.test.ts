import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const headers = { 'x-score-client': 'web' }
const line = (extra: Record<string, unknown>) => JSON.stringify({ level: 30, time: 1_760_000_000_000, ...extra })

function setup(lines: string[], rotated: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'score-logs-'))
  dirs.push(dir)
  const file = join(dir, 'score.log')
  writeFileSync(file, lines.join('\n') + '\n')
  if (rotated.length) writeFileSync(`${file}.1`, rotated.join('\n') + '\n')
  const app = buildApp({ config: loadConfig({ SCORE_LOG_FILE: file }), logger: false })
  return app
}
async function paired(app: ReturnType<typeof setup>) {
  const token = app.pairing.createToken()
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers,
    payload: { token },
  })
  return String(response.headers['set-cookie']).split(';')[0]!
}

test('logs need a paired browser', async () => {
  const app = setup([line({ msg: 'hello' })])
  expect((await app.inject({ url: '/api/system/logs' })).statusCode).toBe(401)
  await app.close()
})

test('lists newest first with request fields, the rotated file after the live one', async () => {
  const app = setup(
    [
      line({ msg: 'old', time: 1_760_000_000_000 }),
      line({
        msg: 'request completed',
        time: 1_760_000_001_000,
        req: { method: 'GET', url: '/api/agents' },
        res: { statusCode: 200 },
        responseTime: 12.5,
      }),
    ],
    [line({ msg: 'rotated', time: 1_750_000_000_000 })],
  )
  const cookie = await paired(app)
  const body = (
    await app.inject({ url: '/api/system/logs?limit=10', headers: { ...headers, cookie } })
  ).json()
  expect(body.available).toBe(true)
  expect(body.items.map((item: { message: string }) => item.message)).toEqual([
    'request completed',
    'old',
    'rotated',
  ])
  expect(body.items[0]).toMatchObject({
    level: 'info',
    method: 'GET',
    url: '/api/agents',
    status: 200,
    durationMs: 12.5,
  })
  await app.close()
})

test('filters by level (and above) and keyword, and honours the limit', async () => {
  const app = setup([
    line({ msg: 'fine' }),
    line({ level: 40, msg: 'careful about Disk' }),
    line({ level: 50, msg: 'broke' }),
    'plain launcher output: ERROR something',
  ])
  const cookie = await paired(app)
  const get = async (qs: string) =>
    (await app.inject({ url: `/api/system/logs?${qs}`, headers: { ...headers, cookie } })).json()
      .items.map((item: { message: string }) => item.message)
  expect(await get('level=warn')).toEqual([
    'plain launcher output: ERROR something',
    'broke',
    'careful about Disk',
  ])
  expect(await get('level=error')).toHaveLength(2)
  expect(await get('q=disk')).toEqual(['careful about Disk'])
  expect(await get('limit=1')).toHaveLength(1)
  expect((await app.inject({ url: '/api/system/logs?limit=5000', headers: { ...headers, cookie } })).statusCode).toBe(400)
  await app.close()
})

test('every line is redacted before it leaves the server', async () => {
  const app = setup([
    line({ msg: 'login with Authorization: Bearer abcdefghijklmnop1234', req: { method: 'GET', url: '/x?token=supersecretvalue&a=1' } }),
    'raw line api_key=sk-abcdefghijklmnop1234',
    line({ level: 50, msg: 'failed', err: { message: 'password=hunter2hunter2' } }),
  ])
  const cookie = await paired(app)
  const raw = (await app.inject({ url: '/api/system/logs', headers: { ...headers, cookie } })).body
  for (const secret of ['abcdefghijklmnop1234', 'supersecretvalue', 'hunter2hunter2'])
    expect(raw).not.toContain(secret)
  expect(raw).toContain('[redacted]')
  await app.close()
})

test('without SCORE_LOG_FILE the endpoint says so', async () => {
  const app = buildApp({ config: loadConfig({}), logger: false })
  const cookie = await paired(app as never)
  const body = (await app.inject({ url: '/api/system/logs', headers: { ...headers, cookie } })).json()
  expect(body).toEqual({ available: false, items: [] })
  await app.close()
})
