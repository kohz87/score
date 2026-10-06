import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const mocksRelease = vi.fn()
  const db = { close: vi.fn() }
  const app = {
    pairing: { createToken: vi.fn(() => 'pairing-token') },
    listen: vi.fn(async () => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
    log: { error: vi.fn() },
  }
  return {
    db,
    app,
    openDatabase: vi.fn(() => db),
    migrate: vi.fn(),
    buildApp: vi.fn(() => app),
    storeConstructor: vi.fn(),
    acquireHomeLock: vi.fn(() => ({ release: mocksRelease })),
    release: mocksRelease,
    ingest: { close: vi.fn(async (): Promise<void> => undefined) },
    createIngest: vi.fn(),
    getEpoch: vi.fn(() => 'epoch'),
    pruneEvents: vi.fn(),
  }
})

vi.mock('../src/db/index.ts', () => ({
  openDatabase: mocks.openDatabase,
  migrate: mocks.migrate,
  acquireHomeLock: mocks.acquireHomeLock,
  getEpoch: mocks.getEpoch,
}))
vi.mock('../src/hub/ingest.ts', () => ({ createIngest: mocks.createIngest }))
vi.mock('../src/hub/retention.ts', () => ({ pruneEvents: mocks.pruneEvents }))
vi.mock('../src/app.ts', () => ({ buildApp: mocks.buildApp }))
vi.mock('../src/auth/sqlite-session-store.ts', () => ({
  SqliteSessionStore: class {
    constructor(db: unknown) {
      mocks.storeConstructor(db)
    }
  },
}))

let signals: Map<string | symbol, () => void>
let previousExitCode: typeof process.exitCode

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.createIngest.mockReturnValue(mocks.ingest)
  vi.spyOn(globalThis, 'setInterval')
  previousExitCode = process.exitCode
  process.exitCode = undefined
  vi.stubEnv('SCORE_HOME', '/tmp/score-test-startup')
  vi.stubEnv('SCORE_PORT', '8740')
  vi.stubEnv('SCORE_HOST', '127.0.0.1')
  vi.stubEnv('SCORE_WEB_ORIGIN', 'http://127.0.0.1:5173')
  vi.stubEnv('SCORE_MODE', 'fake')
  signals = new Map()
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    signals.set(event, listener)
    return process
  })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(() => {
  for (const result of vi.mocked(setInterval).mock.results) {
    if (result.type === 'return') clearInterval(result.value)
  }
  vi.useRealTimers()
  process.exitCode = previousExitCode
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('startup opens and migrates the configured database before building and listening', async () => {
  await import('../src/index.ts')
  expect(mocks.openDatabase).toHaveBeenCalledExactlyOnceWith('/tmp/score-test-startup/score.db')
  expect(mocks.acquireHomeLock).toHaveBeenCalledExactlyOnceWith('/tmp/score-test-startup')
  expect(mocks.migrate).toHaveBeenCalledExactlyOnceWith(
    mocks.db,
    fileURLToPath(new URL('../migrations/', import.meta.url)),
  )
  expect(mocks.storeConstructor).toHaveBeenCalledExactlyOnceWith(mocks.db)
  expect(mocks.createIngest).toHaveBeenCalledExactlyOnceWith(mocks.db)
  expect(mocks.buildApp).toHaveBeenCalledWith({
    config: expect.objectContaining({ home: '/tmp/score-test-startup' }),
    sessionStore: expect.any(Object),
    db: mocks.db,
    ingest: mocks.ingest,
    getEpoch: expect.any(Function),
  })
  expect(mocks.app.listen).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 8740 })
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
    vi.mocked(process.stdout.write),
  ].map((mock) => mock.mock.invocationCallOrder[0])
  expect(order).toEqual([...order].sort((left, right) => (left ?? 0) - (right ?? 0)))
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
    expect(mocks.app.close).toHaveBeenCalledTimes(1)
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
    throw new Error(`Cannot open ${join('/tmp/score-test-startup', 'score.db')}`)
  })
  await import('../src/index.ts')
  expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith(
    'Score server could not start: Cannot open /tmp/score-test-startup/score.db\n',
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

test('hourly retention is unrefd and cleared before shutdown', async () => {
  vi.useFakeTimers()
  const interval = vi.spyOn(globalThis, 'setInterval')
  await import('../src/index.ts')
  expect(interval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 60 * 60 * 1000)
  const timer = interval.mock.results[0]!.value as NodeJS.Timeout
  expect(timer.hasRef()).toBe(false)
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.pruneEvents).toHaveBeenCalledExactlyOnceWith(mocks.db)
  signals.get('SIGTERM')?.()
  await vi.waitFor(() => expect(mocks.db.close).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
  expect(mocks.pruneEvents).toHaveBeenCalledOnce()
})
