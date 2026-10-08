import { expect, test, vi } from 'vitest'
import { runHermes, type CliOptions } from '../../../src/hermes/live/cli.ts'

test.each([0, 2, -1])(
  'runner returns only exit code %s with minimal env, bounded timeout/output',
  async (exitCode) => {
    const execute = vi.fn<NonNullable<CliOptions['execute']>>(
      (_file, _args, _options, callback) => {
        callback(
          exitCode === 0
            ? null
            : Object.assign(new Error('stdout/stderr planted-secret'), {
                code: exitCode === -1 ? 'ENOENT' : exitCode,
              }),
        )
      },
    )
    vi.stubEnv('UNRELATED_SECRET', 'planted-secret')
    try {
      const args = ['kanban', 'comment', '--author', 'score', 't_test', 'note']
      await expect(
        runHermes(args, { timeoutMs: 1234, hermesHome: '/tmp/example-home', execute }),
      ).resolves.toEqual({ exitCode })
      expect(execute).toHaveBeenCalledOnce()
      const [file, argv, options] = execute.mock.calls[0]!
      expect(file).toBe('hermes')
      expect(argv).toEqual(args)
      expect(options).toMatchObject({
        timeout: 1234,
        maxBuffer: 16384,
        env: { HERMES_HOME: '/tmp/example-home' },
      })
      expect(options.env).not.toHaveProperty('UNRELATED_SECRET')
      expect(options.shell).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  },
)

test('NUL arguments are rejected before executing', async () => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>()
  await expect(runHermes(['kanban', 'note\0'], { timeoutMs: 100, execute })).rejects.toThrow()
  expect(execute).not.toHaveBeenCalled()
})

test('synchronous runner failures reveal no output or argv', async () => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>(() => {
    throw new Error('planted-secret')
  })
  await expect(runHermes(['kanban'], { timeoutMs: 100, execute })).resolves.toEqual({
    exitCode: -1,
  })
})

test('stdout, stderr and failure messages never reach logs or results', async () => {
  const logs = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'info'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'warn'),
  ]
  try {
    const execute = vi.fn<NonNullable<CliOptions['execute']>>(
      (_file, _args, _options, callback) => {
        Reflect.apply(callback, null, [
          Object.assign(new Error('planted-error-secret'), { code: 2 }),
          'planted-stdout-secret',
          'planted-stderr-secret',
        ])
      },
    )
    const result = await runHermes(['kanban', 'comment'], { timeoutMs: 100, execute })
    expect(result).toEqual({ exitCode: 2 })
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  } finally {
    for (const log of logs) log.mockRestore()
  }
})

test('only the exact model read may capture bounded stdout; stderr and failures stay private', async () => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_file, _args, _options, callback) =>
    callback(null, '"fixture-model"', 'private stderr'),
  )
  const args = ['-p', 'builder', 'config', 'get', '--json', 'model']
  await expect(runHermes(args, { timeoutMs: 100, captureModel: true, execute })).resolves.toEqual({
    exitCode: 0,
    stdout: '"fixture-model"',
  })
  execute.mockImplementation((_file, _args, _options, callback) =>
    callback(null, 'x'.repeat(16385)),
  )
  await expect(runHermes(args, { timeoutMs: 100, captureModel: true, execute })).resolves.toEqual({
    exitCode: 0,
  })
  execute.mockImplementation((_file, _args, _options, callback) =>
    callback(Object.assign(new Error('private'), { code: 2 }), 'private stdout'),
  )
  await expect(runHermes(args, { timeoutMs: 100, captureModel: true, execute })).resolves.toEqual({
    exitCode: 2,
  })
})
test.each([
  ['config', 'get', '--json', 'model'],
  ['-p', '../outside', 'config', 'get', '--json', 'model'],
  ['-p', 'builder', 'config', 'get', '--json', 'api_key'],
  ['-p', 'builder', 'config', 'get', '--json', 'model', '--raw'],
  ['profile', 'describe', 'builder', '--text', 'new description'],
])('capture rejects nonallowlisted command %j', async (...args) => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>()
  await expect(runHermes(args, { timeoutMs: 100, captureModel: true, execute })).rejects.toThrow(
    'restricted',
  )
  expect(execute).not.toHaveBeenCalled()
})
