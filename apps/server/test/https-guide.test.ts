import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { buildGuideApp } from '../src/http/https-guide.ts'
import { startGuideServer } from '../src/start-server.ts'

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function guideConfig(home: string, extra: Record<string, string> = {}) {
  return loadConfig({
    SCORE_HOME: home,
    SCORE_REMOTE: '1',
    SCORE_HOST: '127.0.0.1',
    SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
    ...extra,
  })
}

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'score-guide-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function withCa(home: string) {
  mkdirSync(join(home, 'tls'), { recursive: true })
  writeFileSync(
    join(home, 'tls', 'ca.crt'),
    '-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----\n',
  )
  writeFileSync(
    join(home, 'tls', 'ca.key'),
    '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n',
  )
  writeFileSync(join(home, 'tls', 'server.key'), 'SERVER-SECRET')
}

test('guide-only mode: the guide is a static page, /api answers 426 https_required, the rest redirects', async () => {
  const app = buildGuideApp(guideConfig(temp()))
  cleanup.push(() => app.close())
  const guide = await app.inject({ url: '/setup/https', headers: { host: 'score.lan:8741' } })
  expect(guide.statusCode).toBe(200)
  expect(guide.headers['content-type']).toContain('text/html')
  expect(guide.body).toContain('href="https://score.lan:8741/"')
  expect(guide.body).toContain('scripts/score tls')
  expect(guide.body).toContain('SCORE_TLS_CERT')
  expect(guide.body).toContain('/setup/https/score-ca.crt')
  expect(guide.body).not.toMatch(
    /<script|<link|@import|url\(|(?:src|href)="https?:\/\/(?!score\.lan)/i,
  )

  for (const [method, url] of [
    ['GET', '/api/agents'],
    ['POST', '/api/session/pair'],
    ['GET', '/api/stream'],
    ['DELETE', '/api/session'],
    ['GET', '/api'],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      payload: method === 'POST' ? { x: 1 } : undefined,
    })
    expect(response.statusCode, `${method} ${url}`).toBe(426)
    expect(ErrorBody.parse(response.json()).error.code).toBe('https_required')
  }
  // Even an unusual content type cannot get past to a body parser error.
  const odd = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'content-type': 'application/x-weird' },
    payload: 'x',
  })
  expect(odd.statusCode).toBe(426)
  for (const url of ['/', '/pair', '/now', '/index.html', '/assets/app.js', '/bridge/v1/hello']) {
    const response = await app.inject({ url })
    expect(response.statusCode, url).toBe(308)
    expect(response.headers.location).toBe('/setup/https')
  }
})

test('the guide never trusts the Host header for its secure link', async () => {
  const app = buildGuideApp(guideConfig(temp()))
  cleanup.push(() => app.close())
  const hostile = await app.inject({
    url: '/setup/https',
    headers: { host: 'evil.example"><script>alert(1)</script>' },
  })
  expect(hostile.statusCode).toBe(200)
  expect(hostile.body).not.toContain('evil.example')
  expect(hostile.body).toContain('https://score.lan:8741/')
})

test('the CA download serves only the public certificate, and is 404 without a tls directory', async () => {
  const home = temp()
  const app = buildGuideApp(guideConfig(home))
  cleanup.push(() => app.close())
  expect((await app.inject({ url: '/setup/https/score-ca.crt' })).statusCode).toBe(404)
  withCa(home)
  const ca = await app.inject({ url: '/setup/https/score-ca.crt' })
  expect(ca.statusCode).toBe(200)
  expect(ca.headers['content-type']).toBe('application/x-x509-ca-cert')
  expect(ca.body).toContain('PUBLIC')
  expect(ca.body).not.toContain('PRIVATE KEY')
  for (const url of [
    '/setup/https/ca.key',
    '/setup/https/server.key',
    '/setup/https/../tls/ca.key',
    '/setup/https/%2e%2e/tls/ca.key',
    '/setup/https/score-ca.crt/../ca.key',
    '/tls/ca.key',
  ]) {
    const response = await app.inject({ url })
    expect(response.statusCode, url).not.toBe(200)
    expect(response.body).not.toContain('SECRET')
  }
})

test('a ca.crt file that contains a private key is never served', async () => {
  const home = temp()
  mkdirSync(join(home, 'tls'))
  writeFileSync(
    join(home, 'tls', 'ca.crt'),
    '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n',
  )
  const app = buildGuideApp(guideConfig(home))
  cleanup.push(() => app.close())
  expect((await app.inject({ url: '/setup/https/score-ca.crt' })).statusCode).toBe(404)
})

test('the HTTPS app serves the same guide and CA to unpaired browsers, and nothing else without pairing', async () => {
  const home = temp()
  withCa(home)
  const config = guideConfig(home, { SCORE_TLS_CERT: '/tmp/c', SCORE_TLS_KEY: '/tmp/k' })
  const app = buildApp({ config, logger: false })
  cleanup.push(() => app.close())
  const headers = { host: 'score.lan:8741' }
  const guide = await app.inject({ url: '/setup/https', headers })
  expect(guide.statusCode).toBe(200)
  expect(guide.body).toContain('Open the secure address')
  expect((await app.inject({ url: '/setup/https/score-ca.crt', headers })).statusCode).toBe(200)
  expect((await app.inject({ url: '/api/agents', headers })).statusCode).toBe(401)
})

test('startGuideServer starts nothing but the guide: no database, pairing or API', async () => {
  const home = join(temp(), 'home')
  const server = await startGuideServer(
    guideConfig(home, { SCORE_REMOTE_INSECURE_HTTP: 'accept' }),
    {
      logger: false,
      listen: async (app) => {
        await app.ready()
      },
    },
  )
  cleanup.push(() => server.close())
  expect('pairing' in server.app).toBe(false)
  expect((await server.app.inject({ url: '/api/health' })).statusCode).toBe(426)
  expect((await server.app.inject({ url: '/setup/https' })).statusCode).toBe(200)
})
