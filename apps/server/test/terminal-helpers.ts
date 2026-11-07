import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import { TerminalTicketSchema } from '@score/contract'
import { afterEach, expect, vi } from 'vitest'
import { buildApp } from '../src/app.ts'
import { SecurityPassword } from '../src/auth/security-password.ts'
import { loadConfig } from '../src/config.ts'
import { terminalLaunch } from '../src/terminal/env.ts'
import { testCert, testKey } from './fixtures/tls.ts'
import { hostPassword } from './helpers/host-password.ts'

export { hostPassword }

export const PASSWORD = 'correct horse battery'

// Real shells (node-pty) with a temporary HOME. Never the owner's home, never a model.
const origin = 'http://127.0.0.1:5173'
export const headers = { host: '127.0.0.1:5173', origin, 'x-score-client': 'web' }
vi.setConfig({ testTimeout: 30_000 })
export const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'score-terminal-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function makeApp(
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

export async function pair(app: FastifyInstance, requestHeaders = headers): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: requestHeaders,
    payload: { token: app.pairing.createToken() },
  })
  expect(response.statusCode).toBe(204)
  return String(response.headers['set-cookie']).split(';')[0]!
}

export async function mint(
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

export async function ticketFor(
  app: FastifyInstance,
  cookie: string,
  requestHeaders = headers,
): Promise<string> {
  app.pairing.markFresh(cookie)
  const response = await mint(app, cookie, requestHeaders)
  expect(response.statusCode).toBe(200)
  return TerminalTicketSchema.parse(response.json()).ticket
}

export async function connect(
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
export function reader(socket: WebSocket) {
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

export const rejected = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toThrow(/Unexpected server response: (\d+)/)
}

export async function expectGone(app: FastifyInstance) {
  const start = Date.now()
  while (app.terminals!.count > 0 && Date.now() - start < 8_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
  expect(app.terminals!.count).toBe(0)
}
