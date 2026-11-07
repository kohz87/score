import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { expect, test } from 'vitest'
import { terminalLaunch } from '../src/terminal/env.ts'
import {
  cleanup,
  connect,
  expectGone,
  headers,
  makeApp,
  mint,
  pair,
  reader,
  rejected,
  ticketFor,
} from './terminal-helpers.ts'

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
