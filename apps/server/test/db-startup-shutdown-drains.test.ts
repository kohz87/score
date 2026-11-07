import { expect, test, vi } from 'vitest'
import { mocks, setupStartup, signals } from './db-startup-helpers.ts'

setupStartup('shutdown-drains')

test('SCORE-033: shutdown waits for a spend sample held at an await before closing ingest and the database', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let entered!: () => void
  const inside = new Promise<void>((resolve) => (entered = resolve))
  mocks.snapshotSessionCosts.mockImplementationOnce(async () => {
    entered()
    await held
  })
  await import('../src/index.ts')
  await inside // the first sample starts at boot
  signals.get('SIGTERM')?.()
  await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledTimes(1))
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(mocks.ingest.close).not.toHaveBeenCalled()
  expect(mocks.db.close).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce())
  expect(mocks.ingest.close).toHaveBeenCalledOnce()
  expect(mocks.db.close).toHaveBeenCalledOnce()
})

test('S2-026: shutdown waits for a hold-recovery attempt held at the adapter before closing ingest and the database', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let entered!: () => void
  const inside = new Promise<void>((resolve) => (entered = resolve))
  let touchedAfterClose = false
  mocks.app.recoverTaskHolds = vi.fn(async () => {
    entered()
    await held // the slow adapter read
    if (mocks.db.close.mock.calls.length > 0) touchedAfterClose = true
    return 0
  })
  try {
    await import('../src/index.ts')
    await inside // the first attempt starts at boot
    signals.get('SIGTERM')?.()
    await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledTimes(1))
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve))
    expect(mocks.ingest.close).not.toHaveBeenCalled()
    expect(mocks.db.close).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce())
    expect(touchedAfterClose).toBe(false)
    expect(mocks.ingest.close).toHaveBeenCalledOnce()
    expect(mocks.db.close).toHaveBeenCalledOnce()
  } finally {
    mocks.app.recoverTaskHolds = undefined
  }
})
