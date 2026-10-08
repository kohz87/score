import { expect, test } from 'vitest'
import {
  expectedConfig,
  drifted,
  permissionsOf,
  updateApprovalConfig,
  verifies,
  type ApprovalConfig,
  type ApprovalIo,
} from '../../src/hermes/approvals.ts'
import { KNOWN_PATTERN_KEYS } from '../../src/hermes/pattern-keys.ts'

const clone = (config: ApprovalConfig): ApprovalConfig => structuredClone(config)

test('the pinned key list is the tested Hermes version, unique and non-trivial', () => {
  expect(new Set(KNOWN_PATTERN_KEYS).size).toBe(KNOWN_PATTERN_KEYS.length)
  expect(KNOWN_PATTERN_KEYS).toContain('delete in root path')
  expect(KNOWN_PATTERN_KEYS).toContain('git force push (rewrites remote history)')
})

test('expectedConfig applies the baseline, keeps unknown keys, drops removals and keeps foreign denies', () => {
  const current: ApprovalConfig = {
    mode: 'off',
    allowlist: ['hermes-own-key', 'recursive delete', 'SQL DROP'],
    deny: ['rm -rf *', 'old team rule', 'agent only'],
  }
  const next = expectedConfig(
    current,
    { mode: 'manual', goAhead: ['SQL DROP', 'recursive delete'], never: ['new team rule'] },
    { withoutGoAhead: ['recursive delete'], extraNever: ['agent only'] },
    ['old team rule'],
  )
  expect(next).toEqual({
    mode: 'manual',
    allowlist: ['hermes-own-key', 'SQL DROP'],
    deny: ['new team rule', 'agent only', 'rm -rf *'],
  })
  expect(drifted(current, next)).toBe(true)
  expect(drifted(next, next)).toBe(false)
  // Extra deny entries and unknown allowlist keys are not drift.
  expect(
    drifted({ ...next, deny: [...next.deny, 'more'], allowlist: [...next.allowlist, 'x'] }, next),
  ).toBe(false)
  // A known key that Hermes appended on an "always" answer is.
  expect(drifted({ ...next, allowlist: [...next.allowlist, 'recursive delete'] }, next)).toBe(true)
})

test('permissionsOf lists allowed known keys and deny globs only', () => {
  expect(
    permissionsOf({ mode: 'smart', allowlist: ['SQL DROP', 'mystery'], deny: ['git push*'] }),
  ).toEqual([
    { id: 'SQL DROP', label: 'SQL DROP', level: 'allowed', inherited: false },
    { id: 'never:git push*', label: 'git push*', level: 'never', inherited: false },
  ])
  expect(permissionsOf(null)).toEqual([])
})

test('verifies accepts concurrent additions but not drops or leftovers', () => {
  const before: ApprovalConfig = { mode: 'smart', allowlist: ['a', 'b'], deny: [] }
  const wrote: ApprovalConfig = { mode: 'smart', allowlist: ['a', 'c'], deny: [] }
  expect(verifies(before, wrote, clone(wrote))).toBe(true)
  expect(verifies(before, wrote, { ...wrote, allowlist: ['a', 'c', 'hermes-added'] })).toBe(true)
  expect(verifies(before, wrote, { ...wrote, allowlist: ['a'] })).toBe(false)
  expect(verifies(before, wrote, { ...wrote, allowlist: ['a', 'b', 'c'] })).toBe(false)
  expect(verifies(before, wrote, { ...wrote, mode: 'off' })).toBe(false)
})

function memoryIo(initial: ApprovalConfig, onWrite?: (state: ApprovalConfig, n: number) => void) {
  const state = { config: clone(initial), writes: 0, reads: 0 }
  const io: ApprovalIo = {
    async read() {
      state.reads++
      return clone(state.config)
    },
    async write(_current, next) {
      state.writes++
      state.config = clone(next)
      onWrite?.(state.config, state.writes)
    },
  }
  return { state, io }
}

test('no write when nothing changes', async () => {
  const { state, io } = memoryIo({ mode: 'smart', allowlist: ['a'], deny: [] })
  await updateApprovalConfig(io, (current) => clone(current))
  expect(state.writes).toBe(0)
})

test('a concurrent Hermes append during the write is merged, not lost', async () => {
  // Hermes appends 'hermes-added' right after our first write replaced the list (a lost update).
  const { state, io } = memoryIo(
    { mode: 'smart', allowlist: ['a', 'b'], deny: [] },
    (config, n) => {
      // A concurrent Hermes save based on the old list: 'b' vanishes, its own entry appears.
      if (n === 1) config.allowlist = ['a', 'hermes-added']
    },
  )
  const result = await updateApprovalConfig(io, (current) => ({
    ...current,
    allowlist: current.allowlist.filter((key) => key !== 'a'),
  }))
  // First attempt dropped 'b' (not removed by us): the retry merged on the fresh read.
  expect(state.writes).toBe(2)
  expect(result.allowlist).toEqual(['hermes-added'])
})

test('a writer that keeps winning ends in a conflict after three attempts', async () => {
  const { state, io } = memoryIo({ mode: 'smart', allowlist: ['a'], deny: [] }, (config) => {
    config.allowlist = []
  })
  await expect(
    updateApprovalConfig(io, (current) => ({ ...current, allowlist: [...current.allowlist, 'b'] })),
  ).rejects.toMatchObject({ status: 409, code: 'conflict' })
  expect(state.writes).toBe(3)
})
