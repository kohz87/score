import net from 'node:net'
import { expect, test, vi } from 'vitest'
import {
  FakeSupervisor,
  halfOpenClient,
  register,
  setup,
  setupSocketTestLifecycle,
} from './coding-socket-helpers.ts'

setupSocketTestLifecycle()

test('rejected hellos (unknown, malformed, mismatched, replayed) free their slots even for half-open peers', async () => {
  const { server } = await setup({ maxUnauthenticated: 1, helloTimeoutMs: 30_000 })
  const priv = server as unknown as { unauthenticated: number; sockets: Set<net.Socket> }
  const reg = register(server, 'LX')
  const good = (launch: string, token: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      t: 'hello',
      launch,
      generation: 1,
      token,
      specHash: 'h',
      ...extra,
    }) + '\n'
  const bad: [string, string][] = [
    [good('NOPE', reg.token), 'unknown-launch'],
    ['{not json\n', 'bad-hello'],
    [good('LX', 'wrong-token'), 'mismatch'],
  ]
  for (const [line, reason] of bad) {
    const c = halfOpenClient(server.path)
    c.socket.write(line)
    await vi.waitFor(() => expect(c.state.data).toContain(reason), { timeout: 3000 })
    // the slot is released within a bounded time, without the peer ever closing its side
    await vi.waitFor(() => expect(priv.unauthenticated).toBe(0), { timeout: 3000 })
    expect(priv.sockets.size).toBe(0)
    expect(c.state.ended).toBe(true)
  }
  // a valid supervisor connects (replay protection: the second use of its token is then rejected)
  const sup = new FakeSupervisor(server.path)
  sup.hello('LX', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  const replay = halfOpenClient(server.path)
  replay.socket.write(good('LX', reg.token))
  await vi.waitFor(() => expect(replay.state.data).toContain('already-connected'), {
    timeout: 3000,
  })
  await vi.waitFor(() => expect(priv.sockets.size).toBe(1), { timeout: 3000 })
  expect(priv.unauthenticated).toBe(0)
})

test('(control) a partial first line is dropped at the hello deadline', async () => {
  const { server } = await setup({ helloTimeoutMs: 150, maxUnauthenticated: 1 })
  const priv = server as unknown as { unauthenticated: number }
  const c = halfOpenClient(server.path)
  c.socket.write('{"v":1,"t":"hello"') // no newline: partial frame, then silence
  await vi.waitFor(() => expect(priv.unauthenticated).toBe(0), { timeout: 3000 })
  await vi.waitFor(() => expect(c.state.ended || c.socket.destroyed).toBe(true), { timeout: 3000 })
})
