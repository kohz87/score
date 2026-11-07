import { expect, test, vi } from 'vitest'
import { mocks, setupStartup, signals } from './db-startup-helpers.ts'

setupStartup('retention')

test('hourly retention is unrefd and cleared before shutdown', async () => {
  vi.useFakeTimers()
  const interval = vi.spyOn(globalThis, 'setInterval')
  await import('../src/index.ts')
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000)
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 10_000)
  const timer = interval.mock.results[1]!.value as NodeJS.Timeout
  expect(timer.hasRef()).toBe(false)
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.pruneEvents).toHaveBeenCalledExactlyOnceWith(mocks.db)
  expect(mocks.retireIngestKeys).toHaveBeenCalledExactlyOnceWith(mocks.db)
  expect(mocks.pruneEvents.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.retireIngestKeys.mock.invocationCallOrder[0]!,
  )
  signals.get('SIGTERM')?.()
  await vi.waitFor(() => expect(mocks.db.close).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.pruneEvents).toHaveBeenCalledOnce()
  expect(mocks.retireIngestKeys).toHaveBeenCalledOnce()
})

test('hourly retirement errors are logged and the next interval retries', async () => {
  vi.useFakeTimers()
  vi.spyOn(globalThis, 'setInterval')
  mocks.retireIngestKeys.mockImplementationOnce(() => {
    throw new Error('retirement failed')
  })
  await import('../src/index.ts')
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.app.log.error).toHaveBeenCalledExactlyOnceWith(
    { err: expect.any(Error) },
    'Ingest key retirement failed',
  )
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.retireIngestKeys).toHaveBeenCalledTimes(2)
  expect(mocks.pruneEvents).toHaveBeenCalledTimes(2)
  expect(mocks.pruneBridge).toHaveBeenCalledTimes(2)
})

test('an event prune error is logged and still allows key retirement', async () => {
  vi.useFakeTimers()
  vi.spyOn(globalThis, 'setInterval')
  mocks.pruneEvents.mockImplementationOnce(() => {
    throw new Error('prune failed')
  })
  await import('../src/index.ts')
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.app.log.error).toHaveBeenCalledExactlyOnceWith(
    { err: expect.any(Error) },
    'Event retention prune failed',
  )
  expect(mocks.retireIngestKeys).toHaveBeenCalledExactlyOnceWith(mocks.db)
  expect(mocks.pruneBridge).toHaveBeenCalledExactlyOnceWith(mocks.db)
})

test('bridge prune errors are logged and retried at the next retention interval', async () => {
  vi.useFakeTimers()
  vi.spyOn(globalThis, 'setInterval')
  mocks.pruneBridge.mockImplementationOnce(() => {
    throw new Error('bridge prune failed')
  })
  await import('../src/index.ts')
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.app.log.error).toHaveBeenCalledExactlyOnceWith(
    { err: expect.any(Error) },
    'Bridge retention prune failed',
  )
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.pruneBridge).toHaveBeenCalledTimes(2)
  expect(mocks.retireIngestKeys).toHaveBeenCalledTimes(2)
})

test('denial sweeps use the existing timer in live mode only and stop at shutdown', async () => {
  vi.useFakeTimers()
  vi.spyOn(globalThis, 'setInterval')
  vi.stubEnv('SCORE_MODE', 'live')
  await import('../src/index.ts')
  await vi.advanceTimersByTimeAsync(10000)
  expect(mocks.sweepKanbanDenials).toHaveBeenCalledExactlyOnceWith(
    mocks.db,
    mocks.ingest,
    expect.objectContaining({ mode: 'live' }),
  )
  signals.get('SIGTERM')?.()
  await vi.waitFor(() => expect(mocks.db.close).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(10000)
  expect(mocks.sweepKanbanDenials).toHaveBeenCalledOnce()
})

test('fake mode never opens Hermes for denial sweeps', async () => {
  vi.useFakeTimers()
  vi.spyOn(globalThis, 'setInterval')
  vi.stubEnv('SCORE_MODE', 'fake')
  await import('../src/index.ts')
  await vi.advanceTimersByTimeAsync(10000)
  expect(mocks.sweepKanbanDenials).not.toHaveBeenCalled()
})
