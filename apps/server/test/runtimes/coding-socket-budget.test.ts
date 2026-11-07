import { expect, test, vi } from 'vitest'
import {
  connect,
  FakeSupervisor,
  finishCleanly,
  setup,
  setupSocketTestLifecycle,
} from './coding-socket-helpers.ts'

setupSocketTestLifecycle()

test('an oversize stdout record is dropped (lossy) and the run is stopped (review #15)', async () => {
  const { server } = await setup({ maxRecordBytes: 100 })
  const { sup, session, records } = await connect(server)
  sup.out('stdout', 1, 'ok\n' + 'z'.repeat(5000) + '\nafter\n')
  await vi.waitFor(() => expect(sup.frames.some((f) => f['t'] === 'stop')).toBe(true))
  const outcome = await finishCleanly(sup, session, 1)
  expect(records).toEqual(['ok', 'after'])
  expect(outcome).toMatchObject({ eligible: false, droppedRecords: 1 })
  expect(outcome.reasons).toContain('record-too-large')
})

test('partial records count against the installation memory budget (review #15)', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000, pauseBytes: 1_000_000 })
  const mk = (id: string) =>
    server.expect({
      launch: id,
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => undefined },
    })
  const a = mk('A')
  const b = mk('B')
  const sa = new FakeSupervisor(server.path)
  const sb = new FakeSupervisor(server.path)
  sa.hello('A', a.token)
  sb.hello('B', b.token)
  await vi.waitFor(() => expect(sa.has('welcome') && sb.has('welcome')).toBe(true))
  sa.out('stdout', 1, 'a'.repeat(600))
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(600))
  sb.out('stdout', 1, 'b'.repeat(600))
  await vi.waitFor(() => expect(sb.frames.some((f) => f['t'] === 'stop')).toBe(true))
  expect(server.bufferedBytes).toBeLessThanOrEqual(1000)
  sb.socket.destroy()
  expect((await b.session.outcome).reasons).toContain('memory-budget')
  // The completed line releases the charge.
  sa.out('stdout', 2, '\n')
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(0))
})

test('queue entries carry per-record overhead against the memory budget (review #15)', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000, pauseBytes: 1_000_000 })
  const never = new Promise<void>(() => undefined)
  const reg = server.expect({
    launch: 'Q',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => never },
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('Q', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.out('stdout', 1, '\n'.repeat(40)) // empty records: zero text bytes, still queue entries
  await vi.waitFor(() => expect(sup.frames.some((f) => f['t'] === 'stop')).toBe(true))
  expect(server.bufferedBytes).toBeLessThanOrEqual(1000)
  sup.socket.destroy()
  expect((await reg.session.outcome).reasons).toContain('memory-budget')
})

test('the installation-wide memory budget caps buffered records across runs', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000, pauseBytes: 1_000_000 })
  const never = new Promise<void>(() => undefined)
  const mk = (id: string) =>
    server.expect({
      launch: id,
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => never },
    })
  const a = mk('A')
  const b = mk('B')
  const sa = new FakeSupervisor(server.path)
  const sb = new FakeSupervisor(server.path)
  sa.hello('A', a.token)
  sb.hello('B', b.token)
  await vi.waitFor(() => expect(sa.has('welcome') && sb.has('welcome')).toBe(true))
  sa.out('stdout', 1, 'a'.repeat(600) + '\n')
  sb.out('stdout', 1, 'b'.repeat(600) + '\n')
  await vi.waitFor(() => expect(sb.frames.some((f) => f['t'] === 'stop')).toBe(true))
  expect(server.bufferedBytes).toBeLessThanOrEqual(1000)
  sb.socket.destroy()
  expect((await b.session.outcome).reasons).toContain('memory-budget')
})

test('#15: what an active run keeps in memory is reserved from the installation budget and released at its end', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1000 })
  const a = server.expect({
    launch: 'A',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => undefined },
    retainedBytes: 400,
  })
  expect(server.bufferedBytes).toBe(400)
  server.expect({
    launch: 'B',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => undefined },
    retainedBytes: 400,
  })
  expect(server.bufferedBytes).toBe(800)
  // A third does not fit: the launch is refused, nothing is left reserved for it.
  expect(() =>
    server.expect({
      launch: 'C',
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => undefined },
      retainedBytes: 400,
    }),
  ).toThrow('memory-budget')
  expect(server.bufferedBytes).toBe(800)
  server.forget('B')
  expect(server.bufferedBytes).toBe(400)
  const sup = new FakeSupervisor(server.path)
  sup.hello('A', a.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  sup.socket.destroy()
  await a.session.outcome
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(0))
})

test('FU #8: stderr diagnostics and commentary the handlers keep are charged to the budget as they change', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1024 * 1024 })
  let diagnostics = 0
  const reg = server.expect({
    launch: 'L1',
    generation: 1,
    specHash: 'h',
    handlers: {
      onStdoutRecord: () => undefined,
      onStderr: (text: string) => {
        diagnostics += text.length
      },
      retainedBytes: () => diagnostics,
    },
    retainedBytes: 1024,
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L1', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  // Nothing from stdout arrives: only stderr grows what the handlers keep, and that alone is charged.
  sup.out('stderr', 1, 'x'.repeat(4000))
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(4000))
  sup.socket.destroy()
  await reg.session.outcome
})

test('re-review 2 #18: a run is charged for what its parser really retains, and stopped past the installation budget', async () => {
  const { server } = await setup({ memoryBudgetBytes: 1024 * 1024 })
  let retained = 0
  const reg = server.expect({
    launch: 'L1',
    generation: 1,
    specHash: 'h',
    handlers: { onStdoutRecord: () => undefined, retainedBytes: () => retained },
    retainedBytes: 1024,
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L1', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  expect(server.bufferedBytes).toBe(1024)
  retained = 300 * 1024
  sup.out('stdout', 1, 'a\n')
  await vi.waitFor(() => expect(server.bufferedBytes).toBe(300 * 1024))
  // Many short ids were cheap in the old count; large retained values are charged by their bytes.
  retained = 5 * 1024 * 1024
  sup.out('stdout', 2, 'b\n')
  await vi.waitFor(() => expect(sup.has('stop')).toBe(true))
  // FV #3: the run stops, but the bytes it really holds stay charged (debt past the limit) until its state is cleared, so
  // nothing else is admitted on top of them.
  expect(server.bufferedBytes).toBe(5 * 1024 * 1024)
  expect(() =>
    server.expect({
      launch: 'L2',
      generation: 1,
      specHash: 'h',
      handlers: { onStdoutRecord: () => undefined },
      retainedBytes: 1024,
    }),
  ).toThrow('memory-budget')
  sup.socket.destroy()
  const outcome = await reg.session.outcome
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('memory-budget')
  expect(server.bufferedBytes).toBe(0)
})

// audit5 S5-C01: socket loss while a record is still being ingested resolves the outcome and releases the launch's
// reservation; the ingestion that finishes afterwards must not charge the budget again (nobody would ever release it).
test('a record that finishes ingesting after socket loss does not recharge the released reservation', async () => {
  const { server } = await setup()
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => (unblock = resolve))
  let started!: () => void
  const startedSeen = new Promise<void>((resolve) => (started = resolve))
  let retained = 0
  const reg = server.expect({
    launch: 'L1',
    generation: 1,
    specHash: 'h',
    retainedBytes: 100,
    handlers: {
      onStdoutRecord: async () => {
        started()
        await gate
        retained = 5000 // what the parser holds once the record is applied
      },
      retainedBytes: () => retained,
    },
  })
  const sup = new FakeSupervisor(server.path)
  sup.hello('L1', reg.token)
  await vi.waitFor(() => expect(sup.has('welcome')).toBe(true))
  expect(server.bufferedBytes).toBe(100)
  sup.out('stdout', 1, 'one\n')
  await startedSeen
  sup.socket.destroy()
  const outcome = await reg.session.outcome
  expect(outcome.reasons).toContain('ingestion-incomplete')
  // The launch reservation is released with the outcome; only the record still in flight stays charged.
  await vi.waitFor(() => expect(server.bufferedBytes).toBeLessThan(100))
  unblock()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(server.bufferedBytes).toBe(0)
})
