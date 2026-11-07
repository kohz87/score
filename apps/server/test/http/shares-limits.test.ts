import { expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { loadConfig } from '../../src/config.ts'
import { png } from '../media-fixtures.ts'
import {
  PASSWORD,
  createSharesHelpers,
  sharesTestSuite,
  type SharesTestState,
} from './shares-helpers.ts'

let dir: SharesTestState['dir']
let db: SharesTestState['db']
let ingest: SharesTestState['ingest']
let port: SharesTestState['port']
let scheduler: SharesTestState['scheduler']
let app: SharesTestState['app']
let state: SharesTestState
const current = (): SharesTestState => state
sharesTestSuite((next) => {
  state = next
  dir = next.dir
  db = next.db
  ingest = next.ingest
  port = next.port
  scheduler = next.scheduler
  app = next.app
}, current)

const { setPassword, room, say, create, tokenOf, page } = createSharesHelpers(current)

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

// audit4-c 2: a page with many images must still load after the page budget is spent.
test('share images have their own, larger rate budget than the page', async () => {
  await setPassword()
  const r = await room()
  const stored = app.media!.store(png(80, 1), 'image/png')
  await say(r.id, [{ kind: 'image', mediaId: stored.mediaId }], true)
  const token = tokenOf((await create(r.id, { includeImages: true })).json().url)
  const ip = '10.0.0.7'
  for (let i = 0; i < 30; i++) expect((await page(token, ip)).statusCode).toBe(200)
  expect((await page(token, ip)).statusCode).toBe(429)
  for (let i = 0; i < 60; i++)
    expect((await app.inject({ url: `/s/${token}/media/0`, remoteAddress: ip })).statusCode).toBe(
      200,
    )
  // Page hits do not eat the image budget either, and the image budget is finite.
  scheduler.advance(61_000)
  for (let i = 0; i < 600; i++) await app.inject({ url: `/s/${token}/media/0`, remoteAddress: ip })
  expect((await app.inject({ url: `/s/${token}/media/0`, remoteAddress: ip })).statusCode).toBe(429)
  expect((await page(token, ip)).statusCode).toBe(200)
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
