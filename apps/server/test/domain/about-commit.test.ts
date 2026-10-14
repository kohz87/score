import { expect, test, vi } from 'vitest'

test('the commit is read once, and is null when git can’t answer', async () => {
  vi.resetModules()
  const { readCommit } = await import('../../src/domain/about.ts')
  const run = vi.fn(() => Promise.reject(new Error('not a git repository')))
  expect(await readCommit(run)).toBeNull()
  expect(await readCommit(run)).toBeNull()
  expect(run).toHaveBeenCalledTimes(1)
  vi.resetModules()
  const fresh = await import('../../src/domain/about.ts')
  expect(await fresh.readCommit(() => Promise.resolve('abc1234\n'))).toBe('abc1234')
})
