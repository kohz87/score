import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { loadWebAssets } from '../../src/http/web-assets.ts'

const origin = 'https://score.example.ts.net:8741'
const headers = { host: 'score.example.ts.net:8741' }
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function remoteApp() {
  const dir = mkdtempSync(join(tmpdir(), 'score-pwa-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'index.html'), '<html><div id="root"></div></html>')
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Score"}')
  const app = buildApp({
    config: loadConfig({
      SCORE_REMOTE: '1',
      SCORE_TLS_CERT: '/tmp/cert',
      SCORE_TLS_KEY: '/tmp/key',
      SCORE_PUBLIC_ORIGINS: origin,
    }),
    webAssets: loadWebAssets(dir),
    logger: false,
  })
  cleanup.push(() => app.close())
  return app
}

test('the manifest and the service worker are public assets, and the worker may take the root scope', async () => {
  const app = remoteApp()
  const manifest = await app.inject({ url: '/manifest.webmanifest', headers })
  expect(manifest.statusCode).toBe(200)
  expect(manifest.headers['content-type']).toContain('application/manifest+json')
  const worker = await app.inject({ url: '/sw.js', headers })
  expect(worker.statusCode).toBe(200)
  expect(worker.headers['content-type']).toContain('text/javascript')
  expect(worker.headers['service-worker-allowed']).toBe('/')
  // Other assets don't carry the header, and the private API stays private.
  expect(
    (await app.inject({ url: '/manifest.webmanifest', headers })).headers['service-worker-allowed'],
  ).toBeUndefined()
  expect((await app.inject({ url: '/api/system', headers })).statusCode).toBe(401)
})
