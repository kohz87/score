import { expect, test, vi } from 'vitest'
import {
  connect,
  FakeSupervisor,
  finishCleanly,
  register,
  setup,
  setupSocketTestLifecycle,
} from './coding-socket-helpers.ts'

setupSocketTestLifecycle()

test('hello with the right token is welcomed; ready, go and the terminal order work end to end', async () => {
  const { server } = await setup()
  const { sup, session, records } = await connect(server)
  sup.send({ t: 'ready', pid: 4242, start: '777', cgroup: '/user.slice/x.service' })
  expect(await session.ready).toEqual({ pid: 4242, start: '777', cgroup: '/user.slice/x.service' })
  session.go()
  await vi.waitFor(() => expect(sup.has('go')).toBe(true))
  sup.out('stdout', 1, 'one\ntwo\n')
  const outcome = await finishCleanly(sup, session, 1)
  expect(records).toEqual(['one', 'two'])
  expect(outcome).toMatchObject({ kind: 'ended', eligible: true, reasons: [], ackFlushed: true })
})

test('a token is single-use: a replay and a second connection for the same launch are rejected', async () => {
  const { server } = await setup()
  const { sup, token } = await connect(server)
  const second = new FakeSupervisor(server.path)
  second.hello('L1', token)
  await vi.waitFor(() =>
    expect(second.frames[0]).toMatchObject({ t: 'reject', reason: 'already-connected' }),
  )
  expect(sup.closed).toBe(false)
  // After the first connection ended, the launch is forgotten: a later replay is just unknown.
  sup.socket.destroy()
  await vi.waitFor(() => expect(sup.closed).toBe(true))
  const third = new FakeSupervisor(server.path)
  third.hello('L1', token)
  await vi.waitFor(() =>
    expect(third.frames[0]).toMatchObject({ t: 'reject', reason: 'unknown-launch' }),
  )
})

test('wrong token, wrong generation, wrong spec hash and unknown launch are rejected without echoing the token', async () => {
  const { server } = await setup()
  const { token } = register(server)
  for (const [launch, tok, hash, gen, reason] of [
    ['L1', 'f'.repeat(64), 'h', 1, 'mismatch'],
    ['L1', token, 'other', 1, 'mismatch'],
    ['L1', token, 'h', 2, 'mismatch'],
    ['nope', token, 'h', 1, 'unknown-launch'],
  ] as const) {
    const s = new FakeSupervisor(server.path)
    s.hello(launch, tok, hash, gen)
    await vi.waitFor(() => expect(s.frames[0]).toMatchObject({ t: 'reject', reason }))
    expect(JSON.stringify(s.frames)).not.toContain(tok)
  }
  // None of those burned the real token.
  const ok = new FakeSupervisor(server.path)
  ok.hello('L1', token)
  await vi.waitFor(() => expect(ok.has('welcome')).toBe(true))
})

test('a token from another Score incarnation does not verify', async () => {
  const a = await setup()
  const b = await setup()
  const { token } = register(a.server)
  register(b.server)
  const s = new FakeSupervisor(b.server.path)
  s.hello('L1', token)
  await vi.waitFor(() => expect(s.frames[0]).toMatchObject({ t: 'reject' }))
})

test('frames over 64 KB and malformed hellos are refused; a silent connection is dropped after the hello timeout', async () => {
  const { server } = await setup({ helloTimeoutMs: 200 })
  const big = new FakeSupervisor(server.path)
  big.socket.write('x'.repeat(70 * 1024))
  await vi.waitFor(() => expect(big.closed).toBe(true))
  const junk = new FakeSupervisor(server.path)
  junk.socket.write('not json\n')
  await vi.waitFor(() => expect(junk.frames[0]).toMatchObject({ t: 'reject', reason: 'bad-hello' }))
  const silent = new FakeSupervisor(server.path)
  await vi.waitFor(() => expect(silent.closed).toBe(true))
})

test('an oversize frame after hello destroys the connection: socket loss, ineligible', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.socket.write('y'.repeat(70 * 1024))
  const outcome = await session.outcome
  expect(outcome).toMatchObject({ kind: 'lost', eligible: false })
  expect(outcome.reasons).toContain('frame-too-large')
})

test('stdout reassembles lines across chunks and across a split multibyte character', async () => {
  const { server } = await setup()
  const { sup, session, records } = await connect(server)
  const bytes = Buffer.from('{"t":"€x"}\n{"t":"😀"}\n')
  const cut = bytes.indexOf(0xe2) + 1 // inside the euro sign
  const cut2 = bytes.indexOf(0xf0) + 2 // inside the emoji
  sup.out('stdout', 1, bytes.subarray(0, cut))
  sup.out('stdout', 2, bytes.subarray(cut, cut2))
  sup.out('stdout', 3, bytes.subarray(cut2))
  const outcome = await finishCleanly(sup, session, 3)
  expect(records).toEqual(['{"t":"€x"}', '{"t":"😀"}'])
  expect(outcome.eligible).toBe(true)
})

test('a sequence gap or repeat makes the run ineligible and stops it', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, 'a\n')
  sup.out('stdout', 3, 'c\n')
  await vi.waitFor(() => expect(sup.frames.some((f) => f['t'] === 'stop')).toBe(true))
  sup.socket.destroy() // the supervisor, told to stop, goes away
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('seq-stdout')
})

test('eof.lastSeq must match what was received; a partial stdout line at eof is a dropped record', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, '{"a":1}\n{"par')
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: 2 })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  await vi.waitFor(() => expect(sup.has('ack-end')).toBe(true))
  sup.socket.end()
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toEqual(expect.arrayContaining(['eof-seq-stdout', 'dropped-record']))
  expect(outcome.droppedRecords).toBe(1)
})

test('ack-end is sent only after every stdout record is processed; a failing handler makes the result ineligible', async () => {
  const { server } = await setup()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { token, session } = server.expect({
    launch: 'L9',
    generation: 1,
    specHash: 'h',
    handlers: {
      onStdoutRecord: async (line) => {
        await gate
        if (line === 'bad') throw new Error('x')
      },
    },
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L9', token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.out('stdout', 1, 'good\nbad\n')
  sup.send({ t: 'eof', stream: 'stdout', lastSeq: 1 })
  sup.send({ t: 'eof', stream: 'stderr', lastSeq: 0 })
  sup.send({ t: 'exit', code: 0, signal: null })
  sup.send({ t: 'end' })
  await new Promise((r) => setTimeout(r, 150))
  expect(sup.has('ack-end')).toBe(false)
  release()
  await vi.waitFor(() => expect(sup.has('ack-end')).toBe(true))
  sup.socket.end()
  const outcome = await session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('ingest-failure')
})

test('any close other than after ack-end is socket loss', async () => {
  const { server } = await setup()
  const { sup, session } = await connect(server)
  sup.out('stdout', 1, 'partial\n')
  sup.socket.destroy()
  const outcome = await session.outcome
  expect(outcome.reasons).toEqual(expect.arrayContaining(['socket-loss']))
  expect(outcome.eligible).toBe(false)
})
