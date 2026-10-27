import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import { HttpError } from '../src/errors.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { TerminalTicketSchema, SecurityStatusSchema } from '@score/contract'
import { buildApp } from '../src/app.ts'
import { SecurityPassword } from '../src/auth/security-password.ts'
import { loadConfig } from '../src/config.ts'
import { terminalLaunch } from '../src/terminal/env.ts'
import { testCert, testKey } from './fixtures/tls.ts'
import { hostPassword } from './helpers/host-password.ts'

const PASSWORD = 'correct horse battery'

// Real shells (node-pty) with a temporary HOME. Never the owner's home, never a model.
const origin = 'http://127.0.0.1:5173'
const headers = { host: '127.0.0.1:5173', origin, 'x-score-client': 'web' }
vi.setConfig({ testTimeout: 30_000 })
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'score-terminal-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeApp(
  env: Record<string, string> = {},
  clock?: () => number,
  extra: {
    enrolled?: boolean
    secure?: boolean
    limits?: Record<string, number>
    agentRun?: (agentId: string) => Promise<{ file: string; args: string[]; cwd: string }>
  } = {},
) {
  const home = tempDir()
  if (extra.enrolled !== false) hostPassword(home, PASSWORD)
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk))
      done()
    },
  })
  const config = loadConfig({ SCORE_TERMINAL: '1', ...env })
  const app = buildApp({
    config,
    logger: { level: 'trace', stream },
    ...(clock ? { clock } : {}),
    security: new SecurityPassword(home, clock),
    // The TLS app: terminals are not offered on plain HTTP. inject() has no TLS socket, so tests say it is secure.
    https: { cert: testCert, key: testKey },
    terminal: {
      launch: terminalLaunch({ ...process.env, HOME: home }),
      ...(extra.secure === false ? {} : { isSecure: () => true }),
      ...(extra.limits ? { limits: extra.limits } : {}),
      ...(extra.agentRun ? { agentRun: extra.agentRun } : {}),
      ...(clock ? { clock } : {}),
    },
  })
  cleanup.push(() => app.close())
  return { app, lines, home }
}

async function pair(app: FastifyInstance, requestHeaders = headers): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: requestHeaders,
    payload: { token: app.pairing.createToken() },
  })
  expect(response.statusCode).toBe(204)
  return String(response.headers['set-cookie']).split(';')[0]!
}

async function mint(
  app: FastifyInstance,
  cookie: string,
  requestHeaders: Record<string, string> = headers,
) {
  return app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...requestHeaders, cookie },
  })
}

async function ticketFor(
  app: FastifyInstance,
  cookie: string,
  requestHeaders = headers,
): Promise<string> {
  app.pairing.markFresh(cookie)
  const response = await mint(app, cookie, requestHeaders)
  expect(response.statusCode).toBe(200)
  return TerminalTicketSchema.parse(response.json()).ticket
}

async function connect(
  app: FastifyInstance,
  ticket: string,
  cookie: string,
  requestHeaders: Record<string, string> = headers,
): Promise<WebSocket> {
  await app.ready()
  return app.injectWS(
    `/api/terminal/ws?ticket=${ticket}`,
    { headers: { ...requestHeaders, cookie }, socket: { remoteAddress: '10.0.0.9' } as never },
    // Listen before the first frame can arrive (the server says "ready" the moment the socket opens).
    { onInit: (socket: WebSocket) => screens.set(socket, listen(socket)) },
  ) as Promise<WebSocket>
}

const screens = new WeakMap<WebSocket, ReturnType<typeof listen>>()

/** Collects what the terminal prints, waiting until `text` appears. */
function reader(socket: WebSocket) {
  return screens.get(socket)!
}

function listen(socket: WebSocket) {
  let output = ''
  const frames: unknown[] = []
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) output += data.toString('utf8')
    else frames.push(JSON.parse(data.toString('utf8')))
  })
  return {
    frames,
    get output() {
      return output
    },
    async until(text: string, timeoutMs = 10_000): Promise<void> {
      const start = Date.now()
      while (!output.includes(text)) {
        if (Date.now() - start > timeoutMs)
          throw new Error(
            `Timed out waiting for ${text}; saw ${JSON.stringify(output.slice(-300))}`,
          )
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}

async function gone(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0)
      // A zombie is dead; it only waits for its parent (init) to collect it.
      if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return true
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const rejected = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toThrow(/Unexpected server response: (\d+)/)
}

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

test('a ticket opens one terminal, runs a command, and is single use', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  const ticket = await ticketFor(app, cookie)
  const socket = await connect(app, ticket, cookie)
  const screen = reader(socket)
  socket.send(Buffer.from('echo score-$((20+22))\r'))
  await screen.until('score-42')
  expect(screen.frames[0]).toMatchObject({ type: 'ready' })
  const sessions = await app.inject({
    url: '/api/terminal/sessions',
    headers: { ...headers, cookie },
  })
  expect(sessions.json().items).toHaveLength(1)
  // Replaying the ticket fails.
  await rejected(connect(app, ticket, cookie))
  socket.terminate()
})

test('the shell starts in HOME with only the allowlisted environment', async () => {
  process.env.SCORE_TERMINAL_LEAK_TEST = 'leaked-value'
  cleanup.push(() => void delete process.env.SCORE_TERMINAL_LEAK_TEST)
  const { app, home } = makeApp()
  const cookie = await pair(app)
  const socket = await connect(app, await ticketFor(app, cookie), cookie)
  const screen = reader(socket)
  socket.send(Buffer.from('echo "cwd=$(pwd -P) leak=[$SCORE_TERMINAL_LEAK_TEST] term=$TERM"\r'))
  await screen.until('term=xterm-256color')
  expect(screen.output).toContain('leak=[]')
  expect(screen.output).not.toContain('leaked-value')
  expect(screen.output).toContain(`cwd=${home}`)
  socket.terminate()
})

test('the environment allowlist is exactly six variables and never Score settings', () => {
  const launch = terminalLaunch(
    {
      HOME: '/home/someone',
      LANG: 'en_US.UTF-8',
      PATH: '/usr/bin',
      SCORE_HOME: '/secret',
      SCORE_BRIDGE_TOKEN: 'secret',
      OPENAI_API_KEY: 'sk-secret',
    },
    { username: 'someone', homedir: '/home/someone', shell: '/bin/zsh' },
  )
  expect(Object.keys(launch.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'SHELL', 'TERM', 'USER'])
  expect(launch).toMatchObject({ file: '/bin/zsh', args: ['-l'], cwd: '/home/someone' })
  expect(JSON.stringify(launch)).not.toMatch(/secret/)
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

test('the ticket and the keystrokes never reach the logs', async () => {
  const { app, lines } = makeApp()
  const cookie = await pair(app)
  const ticket = await ticketFor(app, cookie)
  const socket = await connect(app, ticket, cookie)
  const screen = reader(socket)
  socket.send(Buffer.from('echo typed-secret-words\r'))
  await screen.until('typed-secret-words')
  // Failure paths log too: a replay, a bad origin and a bad host, each with a ticket in the URL.
  const used = ticket
  await rejected(connect(app, used, cookie))
  const another = await ticketFor(app, cookie)
  await rejected(connect(app, another, cookie, { ...headers, origin: 'https://evil.example' }))
  const third = await ticketFor(app, cookie)
  await rejected(connect(app, third, cookie, { ...headers, host: 'evil.example' }))
  await app.inject({ url: `/api/terminal/ws?ticket=${third}`, headers: { ...headers, cookie } })
  socket.terminate()
  await expectGone(app)
  const log = lines.join('')
  for (const secret of [ticket, another, third]) expect(log).not.toContain(secret)
  expect(log).not.toContain('typed-secret-words')
  // Audit lines exist: open and close.
  expect(log).toContain('terminal.open')
  expect(log).toContain('terminal.close')
})

async function expectGone(app: FastifyInstance) {
  const start = Date.now()
  while (app.terminals!.count > 0 && Date.now() - start < 8_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
  expect(app.terminals!.count).toBe(0)
}

test('at most two terminals at once', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  const sockets = [
    await connect(app, await ticketFor(app, cookie), cookie),
    await connect(app, await ticketFor(app, cookie), cookie),
  ]
  expect(app.terminals!.count).toBe(2)
  app.pairing.markFresh(cookie)
  const third = await mint(app, cookie)
  expect(third.statusCode).toBe(429)
  expect(third.json().error.code).toBe('too_many_terminals')
  for (const socket of sockets) socket.terminate()
  await expectGone(app)
})

/** Opens a terminal whose shell has a background job; resolves once both pids are known. */
async function terminalWithJob(app: FastifyInstance, cookie: string, jobCommand = 'sleep 300 &') {
  const socket = await connect(app, await ticketFor(app, cookie), cookie)
  const screen = reader(socket)
  socket.send(Buffer.from(`${jobCommand} echo "pids=$$:$!:"\r`))
  const start = Date.now()
  let pids: RegExpExecArray | null = null
  while (!pids && Date.now() - start < 30_000) {
    pids = /pids=(\d+):(\d+):/.exec(screen.output)
    if (!pids) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!pids) throw new Error(`No pids in ${JSON.stringify(screen.output.slice(-300))}`)
  return { socket, screen, shell: Number(pids[1]), job: Number(pids[2]) }
}

async function exitFrame(screen: ReturnType<typeof reader>, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const frame = screen.frames.find((item) => (item as { type?: string }).type === 'exit')
    if (frame) return frame
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('No exit frame')
}

test.each(['revoke', 'sign-out', 'stop'] as const)(
  'on %s the shell and its background jobs are killed',
  async (how) => {
    const { app } = makeApp()
    const cookie = await pair(app)
    const { screen, shell, job } = await terminalWithJob(app, cookie)
    if (how === 'revoke') app.pairing.revoke(cookie)
    if (how === 'sign-out')
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/session',
            headers: { ...headers, cookie },
          })
        ).statusCode,
      ).toBe(204)
    if (how === 'stop') await app.close()
    await exitFrame(screen)
    expect(await gone(shell, 30_000), 'shell').toBe(true)
    expect(await gone(job, 30_000), 'background job').toBe(true)
    if (how !== 'stop') await expectGone(app)
  },
  90_000,
)

test('a shell that exits at once leaves its slot taken until a SIGHUP-ignoring job is killed', async () => {
  const { app } = makeApp({}, undefined, { limits: { killGraceMs: 600 } })
  const cookie = await pair(app)
  const { socket, screen, job } = await terminalWithJob(
    app,
    cookie,
    '(trap "" HUP; exec sleep 300) &',
  )
  socket.send(Buffer.from('exit\r'))
  await exitFrame(screen)
  // The shell is gone; the job ignored SIGHUP, so the terminal still counts and the job is still there.
  expect(app.terminals!.count).toBe(1)
  expect(await gone(job, 100)).toBe(false)
  // SIGKILL after the grace period ends it, and only then the slot is free.
  expect(await gone(job, 30_000)).toBe(true)
  await expectGone(app)
})

test('the owner can list and close an open terminal', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  const socket = await connect(app, await ticketFor(app, cookie), cookie)
  const screen = reader(socket)
  const listed = await app.inject({
    url: '/api/terminal/sessions',
    headers: { ...headers, cookie },
  })
  const { items } = listed.json()
  expect(items).toHaveLength(1)
  const closed = await app.inject({
    method: 'DELETE',
    url: `/api/terminal/sessions/${items[0].id}`,
    headers: { ...headers, cookie },
  })
  expect(closed.statusCode).toBe(204)
  await expectGone(app)
  expect(screen.frames.some((frame) => (frame as { reason?: string }).reason === 'closed')).toBe(
    true,
  )
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/terminal/sessions/${items[0].id}`,
        headers: { ...headers, cookie },
      })
    ).statusCode,
  ).toBe(404)
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
  const [{ id }] = (
    await app.inject({ url: '/api/session/browsers', headers: { ...remoteHeaders, cookie } })
  ).json().items
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

test('a live session: a ticket naming an agent runs its CLI instead of the shell, and the list says whose (3.11.0)', async () => {
  const runs: string[] = []
  const { app, home } = makeApp({}, undefined, {
    agentRun: async (agentId) => {
      runs.push(agentId)
      if (agentId !== 'builder') throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      return { file: '/bin/sh', args: ['-c', 'echo agent-live-$((40+2)); sleep 30'], cwd: home }
    },
  })
  const cookie = await pair(app)
  // An unknown agent is refused before the password check is used up.
  app.pairing.markFresh(cookie)
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'nobody' },
  })
  expect(unknown.statusCode).toBe(404)
  const minted = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'builder' },
  })
  expect(minted.statusCode, minted.body).toBe(200)
  const socket = await connect(app, TerminalTicketSchema.parse(minted.json()).ticket, cookie)
  await reader(socket).until('agent-live-42')
  // Checked when the ticket was minted and again when the terminal opened.
  expect(runs).toEqual(['nobody', 'builder', 'builder'])
  const sessions = await app.inject({
    url: '/api/terminal/sessions',
    headers: { ...headers, cookie },
  })
  expect(sessions.json().items).toEqual([expect.objectContaining({ agent: 'builder' })])
  socket.terminate()
})

test('without a live-session resolver a ticket naming an agent is refused; an odd agent name is a bad request', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  app.pairing.markFresh(cookie)
  const named = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'builder' },
  })
  expect(named.statusCode).toBe(404)
  const odd = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: '../etc' },
  })
  expect(odd.statusCode).toBe(400)
})

test('an agent that became unavailable after its ticket was minted opens nothing, and the ticket is used up (3.11.0)', async () => {
  let available = true
  const { app, home } = makeApp({}, undefined, {
    agentRun: async () => {
      if (!available) throw new Error('workspace gone')
      return { file: '/bin/sh', args: ['-c', 'sleep 30'], cwd: home }
    },
  })
  const cookie = await pair(app)
  app.pairing.markFresh(cookie)
  const minted = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'builder' },
  })
  expect(minted.statusCode).toBe(200)
  const ticket = TerminalTicketSchema.parse(minted.json()).ticket
  available = false
  await rejected(connect(app, ticket, cookie))
  const sessions = await app.inject({
    url: '/api/terminal/sessions',
    headers: { ...headers, cookie },
  })
  expect(sessions.json().items).toEqual([])
  available = true
  await rejected(connect(app, ticket, cookie))
})
