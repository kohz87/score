import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { AboutSchema, CONTRACT_VERSION, UpdateCheckSchema } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

// The running version, whatever release this is; "newer" examples use 99.x so they stay newer.
const CURRENT = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

const tags = (...names: string[]) => names.map((name) => ({ name }))
const answer =
  (body: unknown, status = 200) =>
  () =>
    Promise.resolve(Response.json(body, { status }))

async function start(
  fetcher: (url: string, init: { headers: Record<string, string> }) => Promise<Response>,
  env: Record<string, string> = {},
  extra: Partial<Parameters<typeof buildApp>[0]> = {},
) {
  let now = Date.now()
  const spy = vi.fn(fetcher)
  const app = buildApp({
    config: loadConfig({ SCORE_MODE: 'live', ...env }),
    logger: false,
    clock: () => now,
    updateFetcher: spy,
    ...extra,
  })
  apps.push(app)
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  const headers = {
    'x-score-client': 'web',
    cookie: String(paired.headers['set-cookie']).split(';')[0]!,
  }
  const check = () =>
    app.inject({ method: 'POST', url: '/api/about/update-check', headers }).then((r) => r.json())
  return { app, spy, check, advance: (ms: number) => (now += ms), headers }
}

test('GET /api/about shows the running version, the schema number and the repository', async () => {
  const env = setup()
  const { app, spy } = await start(answer([]), {}, { db: env.db, ingest: env.ingest })
  const about = AboutSchema.parse((await app.inject({ url: '/api/about' })).json())
  expect(about).toMatchObject({
    version: CURRENT,
    contract: CONTRACT_VERSION,
    mode: 'live',
    repository: 'https://github.com/kohz87/score',
    node: process.version,
  })
  expect(about.schema).toBeGreaterThan(60)
  expect(about.checkout).toMatch(/\//)
  // Reading About never contacts GitHub.
  expect(spy).not.toHaveBeenCalled()
})

test('GET /api/about reports whether the server runs as the service (SCORE_RUN_AS=service only)', async () => {
  const previous = process.env.SCORE_RUN_AS
  try {
    for (const [value, expected] of [
      [undefined, false],
      ['', false],
      ['yes', false],
      ['service', true],
    ] as const) {
      if (value === undefined) delete process.env.SCORE_RUN_AS
      else process.env.SCORE_RUN_AS = value
      const { app } = await start(answer([]))
      const about = AboutSchema.parse((await app.inject({ url: '/api/about' })).json())
      expect(about.service).toBe(expected)
    }
  } finally {
    if (previous === undefined) delete process.env.SCORE_RUN_AS
    else process.env.SCORE_RUN_AS = previous
  }
})

test('says up to date, update available (highest stable tag) or ahead', async () => {
  const names = tags('v1.2.0', 'v99.10.0', 'v100.0.0-rc.1', 'nightly', 'v99.9.9')
  const a = await start(answer(names), { SCORE_UPDATE_REPO: 'acme/score-fork' })
  const result = UpdateCheckSchema.parse(await a.check())
  expect(result).toMatchObject({
    status: 'update_available',
    current: CURRENT,
    message: 'v99.10.0 is available.',
    latest: {
      version: '99.10.0',
      tag: 'v99.10.0',
      url: 'https://github.com/acme/score-fork/releases/tag/v99.10.0',
      changelogUrl: 'https://github.com/acme/score-fork/blob/v99.10.0/CHANGELOG.md',
    },
  })
  const [url, init] = a.spy.mock.calls[0]!
  expect(url).toBe('https://api.github.com/repos/acme/score-fork/tags?per_page=100')
  expect(init.headers['user-agent']).toBe(`Score/${CURRENT}`)
  expect(Object.keys(init.headers).join()).not.toMatch(/authorization|cookie/i)

  const same = await start(answer(tags(`v${CURRENT}`, 'v1.2.0')))
  expect(await same.check()).toMatchObject({
    status: 'up_to_date',
    message: `You’re up to date (v${CURRENT}).`,
  })
  const ahead = await start(answer(tags('v1.2.1')))
  expect(await ahead.check()).toMatchObject({
    status: 'ahead',
    message: 'This build is newer than the latest release.',
  })
})

test('a network error, a bad status and a malformed answer are all "unavailable", never a server error', async () => {
  const text = 'Couldn’t reach GitHub. Check your connection and try again.'
  for (const fetcher of [
    () => Promise.reject(new Error('ENOTFOUND')),
    answer({ message: 'rate limited' }, 403),
    answer({ not: 'a list' }),
    answer([{ nope: 1 }]),
  ]) {
    const { check } = await start(fetcher)
    expect(await check()).toMatchObject({ status: 'unavailable', latest: null, message: text })
  }
})

test('a request that never answers is cut off after 10 seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const { check } = await start(
      (_url, init) =>
        new Promise((_ok, fail) =>
          (init as unknown as { signal: AbortSignal }).signal.addEventListener('abort', () =>
            fail(new Error('aborted')),
          ),
        ),
    )
    const pending = check()
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await pending).toMatchObject({ status: 'unavailable' })
  } finally {
    vi.useRealTimers()
  }
})

test('one real check per minute: a second call inside it gets the same answer without a request', async () => {
  const { check, spy, advance } = await start(answer(tags('v99.4.0')))
  const first = await check()
  advance(30_000)
  expect(await check()).toEqual(first)
  expect(spy).toHaveBeenCalledTimes(1)
  advance(31_000)
  const later = await check()
  expect(spy).toHaveBeenCalledTimes(2)
  expect(later.checkedAt).not.toBe(first.checkedAt)
})

test('the check is for paired browsers and never runs by itself', async () => {
  const { app, spy } = await start(answer(tags('v99.4.0')))
  const res = await app.inject({
    method: 'POST',
    url: '/api/about/update-check',
    headers: { 'x-score-client': 'web' },
  })
  expect(res.statusCode).toBe(401)
  await app.ready()
  expect(spy).not.toHaveBeenCalled()
})

test('fake mode gives a fixed answer without any request', async () => {
  const app = buildApp({ config: loadConfig({ SCORE_MODE: 'fake' }), logger: false })
  apps.push(app)
  const token = app.pairing.createToken()
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token },
  })
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const res = await app.inject({
    method: 'POST',
    url: '/api/about/update-check',
    headers: {
      'x-score-client': 'web',
      cookie: String(paired.headers['set-cookie']).split(';')[0]!,
    },
  })
  expect(res.json()).toMatchObject({ status: 'up_to_date', current: CURRENT })
  expect(fetchSpy).not.toHaveBeenCalled()
  fetchSpy.mockRestore()
})

test('SCORE_UPDATE_REPO must look like owner/name', () => {
  expect(() => loadConfig({ SCORE_UPDATE_REPO: 'not a repo' })).toThrow()
  expect(loadConfig({}).updateRepo).toBe('kohz87/score')
})
