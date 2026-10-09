import fs from 'node:fs'
import { expect, test, vi } from 'vitest'
import { captureReadShape, type HermesRunner } from '../../../src/hermes/live/cli.ts'
import { readApprovalConfig, updateProfileApprovals } from '../../../src/hermes/live/approvals.ts'

// Stands in for `hermes`: keeps one profile's config in memory and applies `config set` like the CLI would.
function stub(
  initial: { allowlist: unknown; approvals: unknown },
  hook?: (writes: string[][]) => void,
) {
  const state = { ...initial }
  const writes: string[][] = []
  const runner = vi.fn<HermesRunner>(async (args) => {
    const [, , verb, sub, ...rest] = args
    if (verb === 'config' && sub === 'get') {
      const key = rest[1]
      return {
        exitCode: 0,
        stdout: JSON.stringify(key === 'command_allowlist' ? state.allowlist : state.approvals),
      }
    }
    if (verb === 'config' && sub === 'set') {
      writes.push(args)
      const [key, value] = rest as [string, string]
      if (key === 'command_allowlist') state.allowlist = JSON.parse(value)
      else if (key === 'approvals.deny')
        state.approvals = { ...(state.approvals as object), deny: JSON.parse(value) }
      else if (key === 'approvals.mode')
        state.approvals = { ...(state.approvals as object), mode: value }
      hook?.(writes)
      return { exitCode: 0 }
    }
    return { exitCode: 1 }
  })
  return { runner, state, writes }
}

test('the CLI capture allowlist admits exactly the two approval reads', () => {
  for (const key of ['command_allowlist', 'approvals'])
    expect(captureReadShape(['-p', 'builder', 'config', 'get', '--json', key])).toBe(true)
  expect(captureReadShape(['-p', 'builder', 'config', 'get', '--json', 'approvals.deny'])).toBe(
    false,
  )
  expect(captureReadShape(['-p', 'builder', 'config', 'get', '--json', 'env'])).toBe(false)
})

test('reads parse mode, deny and allowlist; unquoted off (false) means off; defaults apply', async () => {
  const home = '/tmp/example-home'
  const { runner } = stub({
    allowlist: ['a', 'a', 'b'],
    approvals: { mode: false, deny: ['x'], timeout: 300 },
  })
  expect(await readApprovalConfig(runner, home, 'builder')).toEqual({
    mode: 'off',
    allowlist: ['a', 'b'],
    deny: ['x'],
  })
  expect(runner.mock.calls.map(([args]) => args)).toEqual([
    ['-p', 'builder', 'config', 'get', '--json', 'command_allowlist'],
    ['-p', 'builder', 'config', 'get', '--json', 'approvals'],
  ])
  expect(runner.mock.calls[0]![1]).toMatchObject({ captureRead: true, hermesHome: home })
  const empty = stub({ allowlist: null, approvals: {} })
  expect(await readApprovalConfig(empty.runner, home, 'builder')).toEqual({
    mode: 'smart',
    allowlist: [],
    deny: [],
  })
  const bad = stub({ allowlist: 'nope', approvals: {} })
  await expect(readApprovalConfig(bad.runner, home, 'builder')).rejects.toMatchObject({
    status: 502,
  })
  const unreadable = vi.fn<HermesRunner>(async () => ({ exitCode: 1 }))
  await expect(readApprovalConfig(unreadable, home, 'builder')).rejects.toMatchObject({
    status: 502,
  })
})

test('writes use exact argv and only the three approval keys, only for what changed', async () => {
  const { runner, writes } = stub({
    allowlist: ['SQL DROP', 'hermes-own'],
    approvals: { mode: 'smart', deny: [], smart_policy: 'keep me' },
  })
  const result = await updateProfileApprovals(
    runner,
    '/tmp/example-home',
    'builder',
    (current) => ({
      mode: 'manual',
      allowlist: current.allowlist.filter((key) => key !== 'SQL DROP'),
      deny: ['git push*'],
    }),
  )
  expect(writes).toEqual([
    ['-p', 'builder', 'config', 'set', 'command_allowlist', '["hermes-own"]'],
    ['-p', 'builder', 'config', 'set', 'approvals.deny', '["git push*"]'],
    ['-p', 'builder', 'config', 'set', 'approvals.mode', 'manual'],
  ])
  expect(result).toEqual({ mode: 'manual', allowlist: ['hermes-own'], deny: ['git push*'] })
  for (const [, options] of runner.mock.calls) expect(options).not.toHaveProperty('captureModel')
  const keys = new Set(writes.map((args) => args[4]))
  expect(
    [...keys].every((key) =>
      ['command_allowlist', 'approvals.deny', 'approvals.mode'].includes(key!),
    ),
  ).toBe(true)
})

test('the write loop survives Hermes appending to command_allowlist between read and re-read', async () => {
  let appended = false
  const { runner, state } = stub(
    { allowlist: ['a', 'b'], approvals: { mode: 'smart', deny: [] } },
    () => {
      if (appended) return
      appended = true
      // Hermes answered "always" for 'z' while we were writing, based on the list before our write.
      state.allowlist = ['a', 'b', 'z']
    },
  )
  const result = await updateProfileApprovals(
    runner,
    '/tmp/example-home',
    'builder',
    (current) => ({
      ...current,
      allowlist: current.allowlist.filter((key) => key !== 'a'),
    }),
  )
  expect(result.allowlist).toEqual(expect.arrayContaining(['b', 'z']))
  expect(result.allowlist).not.toContain('a')
})

test('a CLI failure surfaces as an error and never touches files', async () => {
  const open = vi.spyOn(fs, 'openSync')
  const read = vi.spyOn(fs, 'readFileSync')
  const failing = vi.fn<HermesRunner>(async (args) =>
    args.includes('set')
      ? { exitCode: 1 }
      : { exitCode: 0, stdout: args.includes('approvals') ? '{}' : '[]' },
  )
  await expect(
    updateProfileApprovals(failing, '/tmp/example-home', 'builder', (c) => ({
      ...c,
      mode: 'manual',
    })),
  ).rejects.toMatchObject({ status: 409 })
  expect(open).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

test('a cached read is never the baseline of a mutation: an outside deny added during a model save survives', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const { cachingRunner } = await import('../../../src/hermes/live/config-cache.ts')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'score-approvals-cache-'))
  try {
    const profileDir = path.join(home, 'profiles', 'builder')
    fs.mkdirSync(profileDir, { recursive: true })
    const config = path.join(profileDir, 'config.yaml')
    fs.writeFileSync(config, 'a: 1\n')
    const { runner: inner, state } = stub({ allowlist: [], approvals: { mode: 'smart', deny: [] } })
    const wrapped: HermesRunner = async (args, options) => {
      const result = await inner(args, options)
      if (args.includes('set') && args.includes('model.default')) {
        // Another process adds a deny while the model write runs.
        state.approvals = { mode: 'smart', deny: ['external-block'] }
        fs.writeFileSync(config, `a: ${Math.random()}\n`)
      }
      return result
    }
    const runner = cachingRunner(wrapped, home)
    await readApprovalConfig(runner, home, 'builder') // fills the cache
    await runner(['-p', 'builder', 'config', 'set', 'model.default', 'x'], {
      timeoutMs: 1000,
      hermesHome: home,
    })
    const result = await updateProfileApprovals(runner, home, 'builder', (current) => ({
      ...current,
      deny: [...current.deny, 'score-block'],
    }))
    expect(result.deny.sort()).toEqual(['external-block', 'score-block'])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
