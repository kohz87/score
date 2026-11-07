import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { Server as HttpsServer } from 'node:https'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { expect, test, vi } from 'vitest'
import { buildApp, buildBridgeApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { getEpoch, migrate, openDatabase } from '../src/db/index.ts'
import { createIngest } from '../src/hub/ingest.ts'
import { loadWebAssets } from '../src/http/web-assets.ts'
import { startServer } from '../src/start-server.ts'
import { testCert, testKey } from './fixtures/tls.ts'
import { cleanup, directory, env, headers, origin, pair, tlsEnv } from './remote-helpers.ts'

test('bridge routes are registered only on the isolated listener in remote mode', async () => {
  const dir = directory()
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  cleanup.push(() => db.close())
  const ingest = createIngest(db)
  cleanup.push(() => ingest.close())
  const bridge = {
    db,
    ingest,
    bootstrapHash: Buffer.alloc(32),
    getCompatibility: () => ({ fingerprint: 'test', tested: false, disabled: [] }),
  }
  const browser = buildApp({ config: loadConfig(env), bridge, logger: false })
  cleanup.push(() => browser.close())
  const producer = buildBridgeApp(bridge)
  cleanup.push(() => producer.close())
  expect(browser.hasRoute({ method: 'POST', url: '/bridge/v1/hello' })).toBe(false)
  expect(producer.hasRoute({ method: 'POST', url: '/bridge/v1/hello' })).toBe(true)
  expect((await producer.inject('/api/system')).statusCode).toBe(404)
  expect(
    (
      await producer.inject({
        method: 'POST',
        url: '/bridge/v1/hello',
        remoteAddress: '192.168.1.2',
      })
    ).statusCode,
  ).toBe(403)
})

test('only built assets and the app shell are public; data, maps and odd paths stay private', async () => {
  const dir = directory()
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'export {}')
  writeFileSync(join(dir, 'assets', 'private.json'), '{"secret":true}')
  writeFileSync(join(dir, 'assets', 'app.js.map'), '{}')
  const assets = loadWebAssets(dir)
  const app = buildApp({ config: loadConfig(env), webAssets: assets, logger: false })
  cleanup.push(() => app.close())
  for (const url of ['/', '/pair', '/index.html', '/assets/app.js'])
    expect((await app.inject({ url, headers })).statusCode).toBe(200)
  // An unpaired bookmark gets the same public index.html as "/", so it can show the pairing screen.
  const shell = await app.inject({ url: '/runs/demo', headers })
  expect(shell.statusCode).toBe(200)
  expect(shell.body).toContain('<div id="root"></div>')
  // A note deep link (…/Plan%20B.md) is an app route even though it looks like a file.
  const noteLink = await app.inject({ url: '/knowledge/ideas/Plan%20B.md', headers })
  expect(noteLink.statusCode).toBe(200)
  expect(noteLink.body).toContain('<div id="root"></div>')
  for (const url of [
    '/assets/private.json',
    '/assets/app.js.map',
    '/assets/%61pp.js',
    '/api/media/secret',
  ])
    expect((await app.inject({ url, headers })).statusCode).toBe(401)
  // A traversal attempt normalises to an in-app path: at most the public shell comes back, never a file.
  const traversal = await app.inject({ url: '/assets/../private', headers })
  expect([200, 401]).toContain(traversal.statusCode)
  expect(traversal.body).not.toContain('secret')
  expect((await app.inject({ method: 'HEAD', url: '/assets/app.js', headers })).statusCode).toBe(
    401,
  )
  const cookie = await pair(app)
  expect(
    (await app.inject({ url: '/runs/demo', headers: { ...headers, cookie } })).statusCode,
  ).toBe(200)
  expect(
    (await app.inject({ url: '/bridge/v1/hello', headers: { ...headers, cookie } })).statusCode,
  ).toBe(404)
})

test.each(['bridge', 'browser'] as const)(
  'failed %s bind cleans up both apps and the home lock',
  async (failure) => {
    const dir = directory()
    const web = join(dir, 'web')
    mkdirSync(web)
    writeFileSync(join(web, 'index.html'), '<div id="root"></div>')
    const config = loadConfig(tlsEnv(dir))
    let bridge: FastifyInstance | undefined
    const close = vi.fn()
    await expect(
      startServer(config, {
        logger: false,
        webDirectory: web,
        listenBridge: async (app) => {
          bridge = app
          app.addHook('onClose', async () => {
            close()
          })
          if (failure === 'bridge') throw new Error('occupied')
          await app.ready()
        },
        listen: async () => {
          throw new Error('occupied')
        },
      }),
    ).rejects.toThrow(
      `Could not bind the ${failure === 'bridge' ? 'loopback bridge' : 'browser'} listener`,
    )
    expect(bridge).toBeDefined()
    expect(close).toHaveBeenCalledOnce()
    const next = await startServer(config, {
      logger: false,
      webDirectory: web,
      listen: async (app) => {
        await app.ready()
      },
      listenBridge: async (app) => {
        await app.ready()
      },
    })
    await next.close()
  },
)

test('every start gets a new epoch, so a restored database cannot pass for the one a browser remembers', async () => {
  const dir = directory()
  const web = join(dir, 'web')
  mkdirSync(web)
  writeFileSync(join(web, 'index.html'), '<div id="root"></div>')
  const config = loadConfig(tlsEnv(dir))
  const options = {
    logger: false as const,
    webDirectory: web,
    listen: async (app: FastifyInstance) => {
      await app.ready()
    },
    listenBridge: async (app: FastifyInstance) => {
      await app.ready()
    },
  }
  const first = await startServer(config, options)
  const before = getEpoch(first.db)
  await first.close()
  const second = await startServer(config, options)
  const after = getEpoch(second.db)
  await second.close()
  expect(after).not.toBe(before)
})

test('TLS startup builds an HTTPS browser listener and an HTTP loopback listener', async () => {
  const dir = directory()
  writeFileSync(join(dir, 'cert.pem'), testCert)
  writeFileSync(join(dir, 'key.pem'), testKey)
  const web = join(dir, 'web')
  mkdirSync(web)
  writeFileSync(join(web, 'index.html'), '<html><div id="root"></div></html>')
  const config = loadConfig({
    ...env,
    SCORE_HOME: join(dir, 'home'),
    SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
    SCORE_TLS_CERT: join(dir, 'cert.pem'),
    SCORE_TLS_KEY: join(dir, 'key.pem'),
  })
  const server = await startServer(config, {
    logger: false,
    webDirectory: web,
    listen: async (app) => {
      await app.ready()
    },
    listenBridge: async (app) => {
      await app.ready()
    },
  })
  cleanup.push(() => server.close())
  expect(server.app.server).toBeInstanceOf(HttpsServer)
  expect(server.bridgeApp?.server).not.toBeInstanceOf(HttpsServer)
  const page = await server.app.inject({ url: '/pair', headers })
  expect(page.body).toContain('data-score-transport="tls"')
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { ...headers, origin },
    payload: { token: server.pairingToken },
  })
  expect(result.statusCode).toBe(204)
  expect(result.headers['set-cookie']).toContain('; Secure')
})

test('invalid TLS and missing web builds fail before opening Score state or starting adapters', async () => {
  const dir = directory()
  writeFileSync(join(dir, 'cert.pem'), 'invalid certificate')
  writeFileSync(join(dir, 'key.pem'), 'invalid key')
  const home = join(dir, 'home')
  const config = loadConfig({
    ...env,
    SCORE_HOME: home,
    SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
    SCORE_TLS_CERT: join(dir, 'cert.pem'),
    SCORE_TLS_KEY: join(dir, 'key.pem'),
  })
  await expect(
    startServer(config, { logger: false, webDirectory: join(dir, 'web') }),
  ).rejects.toThrow()
  expect(existsSync(home)).toBe(false)
  await expect(
    startServer(loadConfig({ ...tlsEnv(dir), SCORE_HOME: home }), {
      logger: false,
      webDirectory: join(dir, 'web'),
    }),
  ).rejects.toThrow(/run pnpm build/)
  expect(existsSync(home)).toBe(false)
})
