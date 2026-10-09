import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { startServer } from '../src/start-server.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function setup(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'score-serve-web-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const web = join(dir, 'web')
  mkdirSync(web)
  writeFileSync(join(web, 'index.html'), '<html><div id="root"></div></html>')
  return { web, config: loadConfig({ SCORE_HOME: join(dir, 'home'), SCORE_MODE: 'fake', ...env }) }
}

test('serveWeb comes from SCORE_SERVE_WEB or NODE_ENV=production, never by default', () => {
  expect(loadConfig({}).serveWeb).toBe(false)
  expect(loadConfig({ SCORE_SERVE_WEB: '1' }).serveWeb).toBe(true)
  expect(loadConfig({ NODE_ENV: 'production' }).serveWeb).toBe(true)
  expect(() => loadConfig({ SCORE_SERVE_WEB: 'yes' })).toThrow()
})

test('local mode serves the built web app next to the API and keeps unknown API paths as 404 JSON', async () => {
  const { config, web } = setup({ SCORE_SERVE_WEB: '1' })
  const server = await startServer(config, {
    logger: false,
    webDirectory: web,
    listen: async (app) => {
      await app.ready()
    },
  })
  cleanup.push(() => server.close())
  const page = await server.app.inject({ method: 'GET', url: '/now' })
  expect(page.statusCode).toBe(200)
  expect(page.headers['content-type']).toContain('text/html')
  const note = await server.app.inject({ method: 'GET', url: '/knowledge/a/Plan%20B.md' })
  expect(note.statusCode).toBe(200)
  expect(note.headers['content-type']).toContain('text/html')
  expect((await server.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  const missing = await server.app.inject({ method: 'GET', url: '/api/nope' })
  expect(missing.statusCode).toBe(404)
  expect(missing.json()).toHaveProperty('error.code', 'not_found')
})

test('without the flag a missing build is not an error', async () => {
  const { config } = setup({})
  const server = await startServer(config, {
    logger: false,
    listen: async (app) => {
      await app.ready()
    },
  })
  cleanup.push(() => server.close())
  expect((await server.app.inject({ method: 'GET', url: '/now' })).statusCode).toBe(404)
})

test('serving the web app without a build fails before opening state', async () => {
  const { config } = setup({ SCORE_SERVE_WEB: '1' })
  await expect(
    startServer(config, { logger: false, webDirectory: '/nonexistent' }),
  ).rejects.toThrow('pnpm build')
})

test('served pages carry a strict content security policy and framing protection', async () => {
  const { registerWebAssets } = await import('../src/http/web-assets.ts')
  const Fastify = (await import('fastify')).default
  const app = Fastify()
  registerWebAssets(
    app,
    new Map([
      [
        '/index.html',
        { body: Buffer.from('<div id="root"></div>'), type: 'text/html; charset=utf-8' },
      ],
    ]),
  )
  for (const url of ['/', '/index.html', '/now']) {
    const response = await app.inject({ url })
    expect(response.headers['content-security-policy']).toContain("script-src 'self'")
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(response.headers['x-frame-options']).toBe('DENY')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  }
  await app.close()
})
