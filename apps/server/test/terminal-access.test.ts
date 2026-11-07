import { request as httpsRequest } from 'node:https'
import { SecurityStatusSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { buildApp } from '../src/app.ts'
import { SecurityPassword } from '../src/auth/security-password.ts'
import { loadConfig } from '../src/config.ts'
import {
  PASSWORD,
  cleanup,
  connect,
  expectGone,
  headers,
  hostPassword,
  makeApp,
  mint,
  pair,
  reader,
  rejected,
  tempDir,
  ticketFor,
} from './terminal-helpers.ts'

test('the routes do not exist unless SCORE_TERMINAL=1, and Settings says so', async () => {
  const { app } = makeApp({ SCORE_TERMINAL: '0' })
  const cookie = await pair(app)
  expect((await mint(app, cookie)).statusCode).toBe(404)
  const sessions = await app.inject({
    url: '/api/terminal/sessions',
    headers: { ...headers, cookie },
  })
  expect(sessions.statusCode).toBe(404)
  const ws = await app.inject({ url: '/api/terminal/ws?ticket=x', headers: { ...headers, cookie } })
  expect(ws.statusCode).toBe(404)
  const security = await app.inject({
    url: '/api/session/security',
    headers: { ...headers, cookie },
  })
  expect(SecurityStatusSchema.parse(security.json()).terminal).toBe(false)
})

test('enabled: the status says so, and the routes need a paired session', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  const security = await app.inject({
    url: '/api/session/security',
    headers: { ...headers, cookie },
  })
  expect(SecurityStatusSchema.parse(security.json()).terminal).toBe(true)
  const unpaired = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers,
  })
  expect(unpaired.statusCode).toBe(401)
  expect((await app.inject({ url: '/api/terminal/sessions', headers })).statusCode).toBe(401)
})

test('a ticket needs a fresh password check that is used up by minting', async () => {
  let now = 1_000_000
  const { app } = makeApp({}, () => now)
  const cookie = await pair(app)
  const refused = await mint(app, cookie)
  expect(refused.statusCode).toBe(403)
  expect(refused.json().error.code).toBe('fresh_auth_required')
  // A fresh check older than 60 s is not fresh.
  app.pairing.markFresh(cookie)
  now += 61_000
  expect((await mint(app, cookie)).statusCode).toBe(403)
  app.pairing.markFresh(cookie)
  expect((await mint(app, cookie)).statusCode).toBe(200)
  // One check, one ticket.
  expect((await mint(app, cookie)).statusCode).toBe(403)
})

test('the security-password check makes a session fresh; a wrong one does not', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  const check = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/session/security/check',
      headers: { ...headers, cookie },
      payload: { password },
    })
  expect((await check('not the password!')).statusCode).toBe(403)
  expect((await mint(app, cookie)).statusCode).toBe(403)
  expect((await check(PASSWORD)).statusCode).toBe(204)
  expect((await mint(app, cookie)).statusCode).toBe(200)
})

test('a stolen cookie cannot enrol its own second factor', async () => {
  const { app, home } = makeApp({}, undefined, { enrolled: false })
  const cookie = await pair(app)
  const send = (method: string, url: string, payload: object) =>
    app.inject({ method: method as 'POST', url, headers: { ...headers, cookie }, payload })
  // The attacker sets a password of their own from the browser and proves it.
  expect(
    (await send('PUT', '/api/session/security/password', { password: 'attacker password' }))
      .statusCode,
  ).toBe(204)
  expect(
    (await send('POST', '/api/session/security/check', { password: 'attacker password' }))
      .statusCode,
  ).toBe(204)
  const refused = await mint(app, cookie)
  expect(refused.statusCode).toBe(403)
  expect(refused.json().error.code).toBe('second_factor_not_enrolled')
  // Changing it again from the browser (knowing the current one) is still a browser password.
  expect(
    (
      await send('PUT', '/api/session/security/password', {
        password: 'another password',
        current: 'attacker password',
      })
    ).statusCode,
  ).toBe(204)
  expect(
    (await send('POST', '/api/session/security/check', { password: 'another password' }))
      .statusCode,
  ).toBe(204)
  expect((await mint(app, cookie)).statusCode).toBe(403)
  // Replacing the file without the host's mark does not help either.
  const forged = new SecurityPassword(home)
  expect(forged.hostIssued()).toBe(false)
  // Only the owner on the host (scripts/score password) enrols the terminal.
  hostPassword(home, PASSWORD)
  expect(
    (await send('POST', '/api/session/security/check', { password: PASSWORD })).statusCode,
  ).toBe(204)
  expect((await mint(app, cookie)).statusCode).toBe(200)
  // ... and a later browser change takes it away again until the host re-sets it.
  expect(
    (
      await send('PUT', '/api/session/security/password', {
        password: 'sneaky password',
        current: PASSWORD,
      })
    ).statusCode,
  ).toBe(204)
  expect(
    (await send('POST', '/api/session/security/check', { password: 'sneaky password' })).statusCode,
  ).toBe(204)
  expect((await mint(app, cookie)).statusCode).toBe(403)
})

test('minting needs the page origin and an allowed one', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  app.pairing.markFresh(cookie)
  const withoutOrigin: Record<string, string> = { ...headers }
  delete withoutOrigin.origin
  expect((await mint(app, cookie, withoutOrigin)).statusCode).toBe(403)
  expect((await mint(app, cookie, { ...headers, origin: 'https://evil.example' })).statusCode).toBe(
    403,
  )
})

test('the upgrade needs a paired session, the right Host and Origin, and a valid ticket', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  const good = await ticketFor(app, cookie)
  // Wrong Host
  await rejected(connect(app, good, cookie, { ...headers, host: 'evil.example' }))
  // Wrong or missing Origin (a ticket is burned by any attempt that found it, so mint again each time)
  await rejected(
    connect(app, await ticketFor(app, cookie), cookie, {
      ...headers,
      origin: 'https://evil.example',
    }),
  )
  const withoutOrigin: Record<string, string> = { ...headers }
  delete withoutOrigin.origin
  await rejected(connect(app, await ticketFor(app, cookie), cookie, withoutOrigin))
  // Unknown ticket, no ticket
  await rejected(connect(app, 'x'.repeat(43), cookie))
  // Not paired
  const unpairedTicket = await ticketFor(app, cookie)
  await app.ready()
  await rejected(
    app.injectWS(`/api/terminal/ws?ticket=${unpairedTicket}`, { headers }) as Promise<unknown>,
  )
  expect(app.terminals?.count).toBe(0)
})

test('a ticket is bound to its session', async () => {
  const { app } = makeApp()
  const first = await pair(app)
  const second = await pair(app)
  const ticket = await ticketFor(app, first)
  await rejected(connect(app, ticket, second))
  // ... and the failed try burned it for its owner too.
  await rejected(connect(app, ticket, first))
})

test('a ticket expires after 60 seconds', async () => {
  let now = 5_000_000
  const { app } = makeApp({}, () => now)
  const cookie = await pair(app)
  const ticket = await ticketFor(app, cookie)
  now += 61_000
  await rejected(connect(app, ticket, cookie))
})

test('remote mode: the terminal routes are not public, and Host is checked on the upgrade', async () => {
  const remoteOrigin = 'https://score.lan:8741'
  const remoteHeaders = { host: 'score.lan:8741', origin: remoteOrigin, 'x-score-client': 'web' }
  const { app } = makeApp({
    SCORE_REMOTE: '1',
    SCORE_TLS_CERT: '/tmp/cert',
    SCORE_TLS_KEY: '/tmp/key',
    SCORE_PUBLIC_ORIGINS: remoteOrigin,
  })
  // Unpaired: every terminal route is refused like any private route.
  for (const request of [
    { method: 'POST', url: '/api/terminal/tickets' },
    { method: 'GET', url: '/api/terminal/sessions' },
    { method: 'GET', url: '/api/terminal/ws?ticket=x' },
    { method: 'DELETE', url: '/api/terminal/sessions/6a6f5a54-1a6e-4f4e-8a60-7d7a1b8f4f5a' },
  ] as const)
    expect((await app.inject({ ...request, headers: remoteHeaders })).statusCode).toBe(401)
  const cookie = await pair(app, remoteHeaders)
  const wrongHost = { ...remoteHeaders, host: 'evil.example' }
  expect((await mint(app, cookie, wrongHost)).statusCode).toBe(403)
  const ticket = await ticketFor(app, cookie, remoteHeaders)
  await rejected(connect(app, ticket, cookie, wrongHost))
  const t2 = await ticketFor(app, cookie, remoteHeaders)
  const good = await connect(app, t2, cookie, remoteHeaders)
  const screen = reader(good)
  good.send(Buffer.from('echo remote-$((1+1))\r'))
  await screen.until('remote-2')
  // Terminating the paired browser ends its terminal.
  // Read directly: the HTTP list needs an unlock (3.14.2), which would also count as a fresh password check.
  const { id } = app.pairing.browsers(cookie)[0]!
  expect(id).toBeTruthy()
  app.pairing.revokeBrowser(id)
  await expectGone(app)
})

test('HTTPS only: a plain-HTTP request gets no ticket and no WebSocket', async () => {
  // inject() has no TLS socket, exactly like a plain-HTTP connection to a TLS-capable app.
  const { app } = makeApp({}, undefined, { secure: false })
  const cookie = await pair(app)
  app.pairing.markFresh(cookie)
  const refused = await mint(app, cookie)
  expect(refused.statusCode).toBe(426)
  expect(refused.json().error.code).toBe('https_required')
  // No ticket can be obtained, and the upgrade is refused on its own as well.
  await rejected(connect(app, 'x'.repeat(43), cookie))
  expect(app.terminals?.count).toBe(0)
})

test('local mode (no TLS listener) offers no terminal at all, and says why', async () => {
  const home = tempDir()
  hostPassword(home, PASSWORD)
  const app = buildApp({
    config: loadConfig({ SCORE_TERMINAL: '1' }),
    logger: false,
    security: new SecurityPassword(home),
  })
  cleanup.push(() => app.close())
  const cookie = await pair(app)
  expect(app.terminals).toBeUndefined()
  expect((await mint(app, cookie)).statusCode).toBe(404)
  const status = SecurityStatusSchema.parse(
    (await app.inject({ url: '/api/session/security', headers: { ...headers, cookie } })).json(),
  )
  expect(status).toMatchObject({ terminal: false })
  expect(status.terminalUnavailable).toMatch(/HTTPS/)
})

test('over a real TLS connection the ticket is issued', async () => {
  const { app } = makeApp({}, undefined, { secure: false })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  const call = (path: string, cookie: string | undefined, body: string | undefined) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const request = httpsRequest(
          {
            host: '127.0.0.1',
            port,
            path,
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
              ...headers,
              ...(cookie ? { cookie } : {}),
              'content-type': 'application/json',
            },
          },
          (response) => {
            let text = ''
            response.on('data', (chunk: Buffer) => (text += chunk))
            response.on('end', () =>
              resolve({ status: response.statusCode!, headers: response.headers, body: text }),
            )
          },
        )
        request.on('error', reject)
        request.end(body)
      },
    )
  const paired = await call(
    '/api/session/pair',
    undefined,
    JSON.stringify({ token: app.pairing.createToken() }),
  )
  expect(paired.status).toBe(204)
  const cookie = String(paired.headers['set-cookie']).split(';')[0]!
  app.pairing.markFresh(cookie)
  const minted = await call('/api/terminal/tickets', cookie, '{}')
  expect(minted.status).toBe(200)
})
