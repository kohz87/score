import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer, connect, type Server } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { listenDual } from '../src/dual-listener.ts'
import { buildGuideApp } from '../src/http/https-guide.ts'
import { startServer } from '../src/start-server.ts'
import { testCert, testKey } from './fixtures/tls.ts'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function freePort(): Promise<number> {
  const probe: Server = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function get(scheme: 'http' | 'https', port: number, path: string, method = 'GET') {
  const request = scheme === 'http' ? httpRequest : httpsRequest
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: { host: `localhost:${port}` },
          rejectUnauthorized: false,
          agent: false,
        },
        (response) => {
          let body = ''
          response.on('data', (chunk: Buffer) => (body += chunk.toString()))
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          )
        },
      )
      req.on('error', reject)
      req.end()
    },
  )
}

function dualConfig(port: number, extra: Record<string, string> = {}) {
  return loadConfig({
    SCORE_REMOTE: '1',
    SCORE_HOST: '127.0.0.1',
    SCORE_PORT: String(port),
    SCORE_PUBLIC_ORIGINS: `https://localhost:${port}`,
    SCORE_TLS_CERT: '/tmp/unused-cert',
    SCORE_TLS_KEY: '/tmp/unused-key',
    ...extra,
  })
}

test('one port: TLS reaches the app, plain HTTP gets the guide and 426 under /api', async () => {
  const port = await freePort()
  const config = dualConfig(port)
  const app = buildApp({
    config,
    logger: false,
    https: { cert: Buffer.from(testCert), key: Buffer.from(testKey) },
  })
  const guide = buildGuideApp(config)
  const server = await listenDual(app, guide, { host: '127.0.0.1', port })
  cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve))
    await app.close()
    await guide.close()
  })

  const health = await get('https', port, '/api/health')
  expect(health.status).toBe(200)
  expect(JSON.parse(health.body)).toMatchObject({ ok: true })
  // Host/Origin checks of remote mode still apply on the HTTPS side.
  expect((await get('https', port, '/api/agents')).status).toBe(401)

  const page = await get('http', port, '/setup/https')
  expect(page.status).toBe(200)
  expect(page.body).toContain(`https://localhost:${port}/`)
  expect(page.body).toContain('Open the secure address')
  const api = await get('http', port, '/api/health')
  expect(api.status).toBe(426)
  expect(JSON.parse(api.body).error.code).toBe('https_required')
  const root = await get('http', port, '/')
  expect(root.status).toBe(308)
  expect(root.headers.location).toBe('/setup/https')
  // Keep-alive and a second request on fresh connections keep working in both directions.
  expect((await get('https', port, '/api/health')).status).toBe(200)
  expect((await get('http', port, '/api/health', 'POST')).status).toBe(426)
})

test('a connection that sends nothing is dropped, and garbage gets no app', async () => {
  const port = await freePort()
  const config = dualConfig(port)
  const app = buildApp({
    config,
    logger: false,
    https: { cert: Buffer.from(testCert), key: Buffer.from(testKey) },
  })
  const guide = buildGuideApp(config)
  const server = await listenDual(app, guide, { host: '127.0.0.1', port })
  cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve))
    await app.close()
    await guide.close()
  })
  const socket = connect(port, '127.0.0.1')
  const reply = await new Promise<string>((resolve) => {
    let data = ''
    socket.on('data', (chunk: Buffer) => (data += chunk.toString()))
    socket.on('close', () => resolve(data))
    socket.on('error', () => resolve(data))
    socket.write('\x01\x02 not http\r\n\r\n')
  })
  expect(reply).not.toContain('200 OK')
})

test('startServer in remote TLS mode listens on one port for both protocols', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-dual-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'cert.pem'), testCert)
  writeFileSync(join(dir, 'key.pem'), testKey)
  const web = join(dir, 'web')
  await import('node:fs').then((fs) => {
    fs.mkdirSync(web)
    fs.writeFileSync(join(web, 'index.html'), '<html><div id="root"></div></html>')
  })
  const port = await freePort()
  const bridgePort = await freePort()
  const config = dualConfig(port, {
    SCORE_HOME: join(dir, 'home'),
    SCORE_BRIDGE_PORT: String(bridgePort),
    SCORE_TLS_CERT: join(dir, 'cert.pem'),
    SCORE_TLS_KEY: join(dir, 'key.pem'),
    SCORE_MODE: 'fake',
  })
  const server = await startServer(config, { logger: false, webDirectory: web })
  cleanup.push(() => server.close())
  expect((await get('https', port, '/api/health')).status).toBe(200)
  expect((await get('http', port, '/api/health')).status).toBe(426)
  expect((await get('http', port, '/setup/https')).status).toBe(200)
  expect((await get('http', port, '/')).status).toBe(308)
})
