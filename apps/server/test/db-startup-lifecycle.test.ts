import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { mocks, setupStartup, signals } from './db-startup-helpers.ts'

const home = setupStartup('lifecycle')

test('startup opens and migrates the configured database before building and listening', async () => {
  await import('../src/index.ts')
  expect(mocks.openDatabase).toHaveBeenCalledExactlyOnceWith(join(home, 'score.db'))
  expect(mocks.acquireHomeLock).toHaveBeenCalledExactlyOnceWith(home)
  expect(mocks.migrate).toHaveBeenCalledExactlyOnceWith(
    mocks.db,
    fileURLToPath(new URL('../migrations/', import.meta.url)),
  )
  expect(mocks.storeConstructor).toHaveBeenCalledExactlyOnceWith(mocks.db)
  expect(mocks.createIngest).toHaveBeenCalledExactlyOnceWith(mocks.db, {
    deriveEvents: expect.any(Function),
  })
  expect(mocks.buildApp).toHaveBeenCalledWith({
    config: expect.objectContaining({ home }),
    // The composite port (Hermes plus coding agents), built once and shared with the executor (7.7b §2).
    port: expect.any(Object),
    coding: expect.any(Object),
    knowledge: expect.any(Object),
    orchestrator: expect.any(Object),
    outbox: mocks.outbox,
    media: expect.any(Object),
    sessionStore: expect.any(Object),
    db: mocks.db,
    ingest: mocks.ingest,
    getEpoch: expect.any(Function),
  })
  expect(mocks.app.listen).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 8740 })
  expect(mocks.port.start).toHaveBeenCalledExactlyOnceWith(mocks.ingest)
  expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(
    'Pair this browser: http://127.0.0.1:5173/pair#pairing-token\n',
  )
  const order = [
    mocks.acquireHomeLock,
    mocks.openDatabase,
    mocks.migrate,
    mocks.createIngest,
    mocks.storeConstructor,
    mocks.buildApp,
    mocks.app.listen,
    mocks.port.start,
    vi.mocked(process.stdout.write),
  ].map((mock) => mock.mock.invocationCallOrder[0])
  expect(order).toEqual([...order].sort((left, right) => (left ?? 0) - (right ?? 0)))
})

test('live startup initializes bridge bootstrap and passes shared DB, ingest and dynamic compatibility', async () => {
  vi.stubEnv('SCORE_MODE', 'live')
  await import('../src/index.ts')
  // Startup continues after the import resolves (journal folders are created and synced first).
  await vi.waitFor(() => expect(mocks.loadBridgeBootstrap).toHaveBeenCalledExactlyOnceWith(home))
  const options = mocks.buildApp.mock.calls[0] as unknown as [
    {
      bridge: {
        db: unknown
        ingest: unknown
        bootstrapHash: Buffer
        getCompatibility(): unknown
      }
    },
  ]
  expect(options[0].bridge).toMatchObject({
    db: mocks.db,
    ingest: mocks.ingest,
    bootstrapHash: Buffer.alloc(32),
  })
  expect(options[0].bridge.getCompatibility()).toEqual(mocks.port.status().compatibility)
})

test('live bootstrap failure closes resources before listening or printing pairing credentials', async () => {
  vi.stubEnv('SCORE_MODE', 'live')
  mocks.loadBridgeBootstrap.mockImplementationOnce(() => {
    throw new Error('Bridge bootstrap token must be an owner-only regular file')
  })
  await import('../src/index.ts')
  expect(mocks.buildApp).not.toHaveBeenCalled()
  expect(mocks.app.listen).not.toHaveBeenCalled()
  expect(mocks.ingest.close).toHaveBeenCalledOnce()
  expect(mocks.db.close).toHaveBeenCalledOnce()
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(process.stdout.write).not.toHaveBeenCalled()
})

test.each(['SIGINT', 'SIGTERM'])(
  '%s waits for app.close before closing the database, only once',
  async (signal) => {
    let finishClose: (() => void) | undefined
    mocks.app.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        }),
    )
    await import('../src/index.ts')
    signals.get(signal)?.()
    signals.get('SIGINT')?.()
    signals.get('SIGTERM')?.()
    await vi.waitFor(() => expect(mocks.port.stop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.app.close).toHaveBeenCalledTimes(1))
    expect(mocks.port.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.app.close.mock.invocationCallOrder[0]!,
    )
    expect(mocks.db.close).not.toHaveBeenCalled()
    expect(mocks.ingest.close).not.toHaveBeenCalled()
    if (!finishClose) throw new Error('Shutdown was not started')
    finishClose()
    await vi.waitFor(() => expect(mocks.db.close).toHaveBeenCalledTimes(1))
    expect(mocks.release).toHaveBeenCalledOnce()
    expect(mocks.ingest.close).toHaveBeenCalledOnce()
    expect(mocks.ingest.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.db.close.mock.invocationCallOrder[0]!,
    )
    expect(mocks.db.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0]!,
    )
  },
)

test('migration failures are formatted and close the database without building or printing a pairing URL', async () => {
  mocks.migrate.mockImplementationOnce(() => {
    throw new Error('Applied migration changed')
  })
  await import('../src/index.ts')
  expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
    'Score server could not start: Applied migration changed\n',
  )
  expect(mocks.db.close).toHaveBeenCalledTimes(1)
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(mocks.buildApp).not.toHaveBeenCalled()
  expect(process.stdout.write).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})

test('listen failures close the app then the database and do not print pairing credentials', async () => {
  mocks.app.listen.mockRejectedValueOnce(new Error('listen EADDRINUSE'))
  await import('../src/index.ts')
  expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
    'Score server could not start: listen EADDRINUSE\n',
  )
  expect(mocks.app.close).toHaveBeenCalledTimes(1)
  expect(mocks.db.close).toHaveBeenCalledTimes(1)
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(mocks.app.close.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.db.close.mock.invocationCallOrder[0] ?? 0,
  )
  expect(process.stdout.write).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})

test('adapter startup failure closes all resources and preserves the original error', async () => {
  mocks.port.start.mockRejectedValueOnce(new Error('adapter startup failed'))
  mocks.port.stop.mockRejectedValueOnce(new Error('adapter cleanup failed'))
  await import('../src/index.ts')
  expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
    'Score server could not start: adapter startup failed\n',
  )
  expect(mocks.port.stop).toHaveBeenCalledOnce()
  expect(mocks.app.close).toHaveBeenCalledOnce()
  expect(mocks.ingest.close).toHaveBeenCalledOnce()
  expect(mocks.db.close).toHaveBeenCalledOnce()
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(process.stdout.write).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})

test('adapter shutdown failure still closes the app, ingest and database', async () => {
  mocks.port.stop.mockRejectedValueOnce(new Error('adapter shutdown failed'))
  await import('../src/index.ts')
  signals.get('SIGTERM')?.()
  await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce())
  expect(mocks.app.close).toHaveBeenCalledOnce()
  expect(mocks.ingest.close).toHaveBeenCalledOnce()
  expect(mocks.db.close).toHaveBeenCalledOnce()
  expect(process.exitCode).toBe(1)
})

test('configuration failures are formatted before opening a database', async () => {
  vi.stubEnv('SCORE_PORT', '0')
  await import('../src/index.ts')
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining('Score server could not start:\n  port:'),
  )
  expect(mocks.openDatabase).not.toHaveBeenCalled()
  expect(mocks.db.close).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})

test('database open failures still use the startup formatter', async () => {
  mocks.openDatabase.mockImplementationOnce(() => {
    throw new Error(`Cannot open ${join(home, 'score.db')}`)
  })
  await import('../src/index.ts')
  expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
    `Score server could not start: Cannot open ${join(home, 'score.db')}\n`,
  )
  expect(mocks.db.close).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
  expect(process.exitCode).toBe(1)
})

test('a home-lock failure prevents opening the database or listening', async () => {
  mocks.acquireHomeLock.mockImplementationOnce(() => {
    throw new Error('Another Score server is using this home')
  })
  await import('../src/index.ts')
  expect(mocks.openDatabase).not.toHaveBeenCalled()
  expect(mocks.app.listen).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})

test('a database shutdown failure still releases home ownership', async () => {
  mocks.db.close.mockImplementationOnce(() => {
    throw new Error('close failed')
  })
  await import('../src/index.ts')
  signals.get('SIGTERM')?.()
  await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce())
  expect(process.exitCode).toBe(1)
})
