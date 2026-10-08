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
      expect(argv).toEqual(['-p', 'default', 'kanban', '--board', 'default', ...args.slice(1)])
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

test('create JSON output has enough bounded space for task bodies and is returned only on success', async () => {
  const stdout = JSON.stringify({ id: 't_created', body: 'body'.repeat(8000) })
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_file, _args, _options, callback) =>
    callback(null, stdout),
  )
  expect(
    await runHermes(['kanban', 'create', '--json'], {
      timeoutMs: 100,
      captureTaskCreate: true,
      execute,
    }),
  ).toEqual({
    exitCode: 0,
    stdout,
  })
  expect(execute.mock.calls[0]![2].maxBuffer).toBe(512 * 1024)
  execute.mockImplementation((_file, _args, _options, callback) =>
    callback(Object.assign(new Error('secret'), { code: 1 }), stdout),
  )
  expect(
    await runHermes(['kanban', 'create', '--json'], {
      timeoutMs: 100,
      captureTaskCreate: true,
      execute,
    }),
  ).toEqual({
    exitCode: 1,
  })
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

test.each([
  ['-p', 'builder', 'config', 'get', '--json', 'skills.disabled'],
  ['-p', 'builder', 'config', 'get', '--json', 'delegation.max_concurrent_children'],
  ['-p', 'builder', 'tools', 'list', '--platform', 'api_server'],
  ['skills', 'search', '--json', '--limit', '20', '--', 'changelog'],
  ['config', 'get', '--json', 'display'],
  ['config', 'get', '--json', 'agent'],
])('captureRead returns stdout for allowlisted read %j', async (...args) => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_file, _args, _options, callback) =>
    callback(null, 'out', 'private stderr'),
  )
  await expect(runHermes(args, { timeoutMs: 100, captureRead: true, execute })).resolves.toEqual({
    exitCode: 0,
    stdout: 'out',
  })
})
test.each([
  ['-p', 'builder', 'config', 'get', '--json', 'api_key'],
  ['-p', 'builder', 'config', 'get', '--raw', 'skills.disabled'],
  ['-p', 'builder', 'tools', 'list', '--platform', 'x'],
  ['-p', 'builder', 'tools', 'list'],
  ['-p', '../x', 'tools', 'list'],
  ['skills', 'search', '--json', '--limit', '20', 'unquoted'],
  ['skills', 'search', '--json', '--limit', 'x', '--', 'q'],
  ['skills', 'install', '--yes', '--', 'a/b'],
  ['-p', 'builder', 'config', 'set', 'model.default', 'm'],
  ['config', 'set', 'agent', 'x'],
  ['config', 'get', '--raw', 'agent'],
  ['config', 'get', '--json', 'OPENROUTER_API_KEY'],
  ['config', 'get', '--json', 'openrouter_api_key'],
  ['config', 'get', '--json', 'providers'],
  ['config', 'get', '--json', 'mcp_servers'],
  ['config', 'get', '--json', 'credential_pool_strategies'],
  ['config', 'get', '--json', 'agent.api_key'],
  ['config', 'get', '--json', '--', 'agent'],
  ['config', 'get', '--json', '-x'],
])('captureRead rejects nonallowlisted command %j', async (...args) => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>()
  await expect(runHermes(args, { timeoutMs: 100, captureRead: true, execute })).rejects.toThrow(
    /allowlisted reads/,
  )
  expect(execute).not.toHaveBeenCalled()
})
test('captureRead drops oversized output and failed commands stay private', async () => {
  const args = ['-p', 'builder', 'tools', 'list', '--platform', 'api_server']
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_file, _args, _options, callback) =>
    callback(null, 'x'.repeat(512 * 1024 + 1)),
  )
  await expect(runHermes(args, { timeoutMs: 100, captureRead: true, execute })).resolves.toEqual({
    exitCode: 0,
  })
  execute.mockImplementation((_file, _args, _options, callback) =>
    callback(Object.assign(new Error('private'), { code: 3 }), 'private stdout'),
  )
  await expect(runHermes(args, { timeoutMs: 100, captureRead: true, execute })).resolves.toEqual({
    exitCode: 3,
  })
})

test.each([
  [
    ['config', 'get', '--json', 'display'],
    ['-p', 'default', 'config', 'get', '--json', 'display'],
  ],
  [
    ['auth', 'list'],
    ['-p', 'default', 'auth', 'list'],
  ],
  [
    ['-p', 'builder', 'config', 'set', 'a', 'b'],
    ['-p', 'builder', 'config', 'set', 'a', 'b'],
  ],
  [
    ['kanban', 'comment', '--', 't_1', 'x'],
    ['-p', 'default', 'kanban', '--board', 'default', 'comment', '--', 't_1', 'x'],
  ],
  [
    ['-p', 'builder', 'kanban', 'archive', '--', 't_1'],
    ['-p', 'builder', 'kanban', '--board', 'default', 'archive', '--', 't_1'],
  ],
  [
    ['profile', 'list'],
    ['profile', 'list'],
  ],
])('unscoped commands are pinned to the default profile and board: %j', async (argv, sent) => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_file, _args, _options, callback) =>
    callback(null, ''),
  )
  await runHermes(argv, { timeoutMs: 100, hermesHome: '/tmp/hermes-root', execute })
  expect(execute.mock.calls[0]![1]).toEqual(sent)
})
test('a Hermes home that is itself a profile directory is not re-pinned to default', async () => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_file, _args, _options, callback) =>
    callback(null, ''),
  )
  await runHermes(['auth', 'list'], {
    timeoutMs: 100,
    hermesHome: '/tmp/hermes/profiles/builder',
    execute,
  })
  expect(execute.mock.calls[0]![1]).toEqual(['auth', 'list'])
})
