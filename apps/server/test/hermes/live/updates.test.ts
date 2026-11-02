import type { HermesCheck } from '@score/contract'
import { expect, test } from 'vitest'
import { hermesUpdateArgv, type HermesChild } from '../../../src/hermes/live/cli.ts'
import {
  HermesUpdates,
  parseCheck,
  parsePlan,
  type HermesUpdatesDeps,
} from '../../../src/hermes/live/updates.ts'

const check = (over: Partial<HermesCheck> = {}): HermesCheck => ({
  hash: 'a'.repeat(64),
  build: { version: '0.22.5', codeSha: 'abc', fingerprint: 'f' },
  parts: [{ name: 'Approval functions', status: 'same', detail: 'Present' }],
  compatible: true,
  overridable: false,
  ...over,
})

function harness(over: Partial<HermesUpdatesDeps> & { lines?: string[]; exit?: number } = {}) {
  const calls: string[] = []
  const accepted: string[] = []
  const deps: HermesUpdatesDeps = {
    spawn: (command, channel, options): HermesChild => {
      calls.push(`${command}:${channel}`)
      const lines =
        command === 'run'
          ? (over.lines ?? [
              'Backup: ~/.hermes/backups/hermes-backup-20261102.zip',
              'Update complete! (v0.22.5+1 → v0.22.5+9) [main]',
            ])
          : command === 'check'
            ? ['⚕ Update available: 2158 commits behind origin/main.']
            : ['Update plan:', '    • gateway [default] pid 1766 — systemd @ x']
      for (const line of lines) options.onLine(line)
      return {
        exited: Promise.resolve(command === 'run' ? (over.exit ?? 0) : 0),
        kill: () => undefined,
      }
    },
    idle: () => ({ idle: true, note: 'nothing running' }),
    version: async () => 'Hermes Agent v0.22.5+1.gabc (2026.9.24)',
    check: async () => check(),
    accept: async (hash) => void accepted.push(hash),
    startTestRun: async () => ({ runId: 'r1' }),
    readRun: () => ({ status: 'completed', output: 'PONG', error: null }),
    diskFreeBytes: async () => 10 * 1024 ** 3,
    backupNeedsBytes: async () => 4 * 1024 ** 3,
    // A real tick: an instant sleep would spin a poll loop without ever letting timers run.
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    ...over,
  }
  return { updates: new HermesUpdates(deps), calls, accepted }
}

async function finished(updates: HermesUpdates) {
  for (let i = 0; i < 50; i += 1) {
    const job = (await updates.status()).job
    if (job?.state === 'finished') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the job did not finish')
}

test('only four exact commands, with a known channel', () => {
  expect(hermesUpdateArgv('version', 'stable')).toEqual(['--version'])
  expect(hermesUpdateArgv('check', 'main')).toEqual(['update', '--check', '--channel', 'main'])
  expect(hermesUpdateArgv('plan', 'stable')).toEqual(['update', '--plan', '--channel', 'stable'])
  expect(hermesUpdateArgv('run', 'main')).toEqual([
    'update',
    '--backup',
    '--yes',
    '--channel',
    'main',
  ])
  expect(() => hermesUpdateArgv('run', 'main; rm -rf ~')).toThrow()
  expect(() => hermesUpdateArgv('check', '--set-channel')).toThrow()
})

test('check and plan output are read in words', () => {
  expect(
    parseCheck([
      '→ Fetching from origin...',
      '⚕ Update available: 2,158 commits behind origin/main.',
    ]),
  ).toEqual({
    available: true,
    behind: 2158,
    summary: 'Update available: 2,158 commits behind origin/main.',
  })
  expect(
    parseCheck([
      '✓ No newer release: stable v0.22.5; this checkout is newer and waits for the next release',
    ]),
  ).toMatchObject({ available: false, behind: null })
  expect(
    parsePlan([
      'Update plan:',
      '    • gateway [default] pid 1766 — systemd @ d778',
      '  Profiles: x',
    ]),
  ).toEqual(['gateway [default]'])
})

test('a clean update: waits, updates with Hermes’s own backup, checks, tests, and turns approvals on', async () => {
  const { updates, calls, accepted } = harness()
  const job = await updates.start({ channel: 'main', testAgentId: 'gem38' })
  expect(job.state).toBe('running')
  const done = await finished(updates)
  expect(done).toMatchObject({
    outcome: 'clear',
    fromVersion: 'v0.22.5+1',
    toVersion: 'v0.22.5+9',
    backup: 'hermes-backup-20261102.zip',
    test: { agentId: 'gem38', ok: true },
  })
  expect(done.steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'done'])
  expect(calls).toContain('run:main')
  expect(accepted).toEqual(['a'.repeat(64)])
})

test('something differs but approvals can be turned on anyway; nothing is accepted by itself', async () => {
  const { updates, accepted } = harness({
    check: async () =>
      check({
        compatible: false,
        overridable: true,
        parts: [{ name: 'Session database schema', status: 'changed', detail: 'differs' }],
      }),
  })
  await updates.start({ channel: 'main', testAgentId: 'gem38' })
  expect(await finished(updates)).toMatchObject({ outcome: 'differs' })
  expect(accepted).toEqual([])
})

test('a failed test message is broken even when the check is clean; no test message skips that step', async () => {
  const failing = harness({
    readRun: () => ({ status: 'failed', output: null, error: 'approval.request: unknown field' }),
  })
  await failing.updates.start({ channel: 'main', testAgentId: 'gem38' })
  const broken = await finished(failing.updates)
  expect(broken).toMatchObject({ outcome: 'broken', test: { ok: false } })
  expect(failing.accepted).toEqual([])

  const skipped = harness()
  await skipped.updates.start({ channel: 'stable', testAgentId: null })
  const done = await finished(skipped.updates)
  expect(done.outcome).toBe('clear')
  expect(done.steps.find((step) => step.id === 'test')?.state).toBe('skipped')
})

test('a failed update says so and keeps Hermes’s output; busy agents time out without changing anything', async () => {
  const failed = harness({
    exit: 1,
    lines: ['Error: could not pull', 'token sk-abcdefghijklmnopqrstuvwx'],
  })
  await failed.updates.start({ channel: 'main', testAgentId: null })
  const job = await finished(failed.updates)
  expect(job).toMatchObject({ outcome: 'failed' })
  expect(job.error).toMatch(/did not finish/)
  // Output is redacted before it is kept.
  expect(job.log.join('\n')).not.toContain('sk-abcdefghijklmnopqrstuvwx')

  let now = 0
  const busy = harness({
    idle: () => ({ idle: false, note: '1 still working' }),
    clock: () => now,
    sleep: async () => {
      now += 60_000
    },
  })
  await busy.updates.start({ channel: 'main', testAgentId: null })
  const waited = await finished(busy.updates)
  expect(waited).toMatchObject({ outcome: 'failed' })
  expect(waited.steps[0]).toMatchObject({ id: 'wait', state: 'failed' })
  expect(busy.calls).not.toContain('run:main')
})

test('one job at a time, and not without disk room for the backup', async () => {
  const { updates } = harness({
    readRun: () => ({ status: 'running', output: null, error: null }),
    limits: { testMs: 30 },
  })
  await updates.start({ channel: 'main', testAgentId: 'gem38' })
  await expect(updates.start({ channel: 'main', testAgentId: null })).rejects.toMatchObject({
    code: 'update_running',
  })
  const full = harness({ diskFreeBytes: async () => 1024 ** 3 })
  await expect(full.updates.start({ channel: 'main', testAgentId: null })).rejects.toMatchObject({
    code: 'disk_full',
  })
})

test('a check that can’t read the restarting gateway is tried again', async () => {
  let n = 0
  const { updates } = harness({
    check: async () => {
      n += 1
      return n < 3
        ? check({
            compatible: false,
            parts: [
              {
                name: 'Capabilities',
                status: 'changed',
                detail: 'could not be read (is the gateway running?)',
              },
            ],
          })
        : check()
    },
  })
  await updates.start({ channel: 'main', testAgentId: null })
  expect(await finished(updates)).toMatchObject({ outcome: 'clear' })
  expect(n).toBe(3)
})

test('two quick starts never both run', async () => {
  const { updates, calls } = harness({
    readRun: () => ({ status: 'running', output: null, error: null }),
    limits: { testMs: 30 },
  })
  const results = await Promise.allSettled([
    updates.start({ channel: 'main', testAgentId: null }),
    updates.start({ channel: 'main', testAgentId: null }),
  ])
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  await finished(updates)
  expect(calls.filter((c) => c === 'run:main')).toHaveLength(1)
})

test('an update still running from before a Score restart is shown and blocks a second one', async () => {
  let recorded: { pid: number; startedAt: string } | null = {
    pid: 4242,
    startedAt: '2026-11-02T03:00:00.000Z',
  }
  let alive = true
  const { updates } = harness({
    marker: {
      read: () => recorded,
      write: (value) => void (recorded = value),
      clear: () => void (recorded = null),
      alive: () => alive,
    },
  })
  const status = await updates.status()
  expect(status.job).toMatchObject({
    state: 'running',
    steps: [{ id: 'wait' }, { id: 'update', state: 'running' }, {}, {}],
  })
  await expect(updates.start({ channel: 'main', testAgentId: null })).rejects.toMatchObject({
    code: 'update_running',
  })
  await expect(updates.check('main')).rejects.toMatchObject({ code: 'update_running' })
  alive = false
  expect((await updates.status()).job).toBeNull()
  expect(recorded).toBeNull()
})

test('a check that did not run is an error, never "nothing newer"', async () => {
  const { updates } = harness({
    spawn: (_command, _channel, options) => {
      options.onLine('hermes: command not found')
      return { exited: Promise.resolve(127), kill: () => undefined }
    },
  })
  await expect(updates.check('stable')).rejects.toMatchObject({ code: 'hermes_unavailable' })
})

test('a check that throws while the gateway restarts is tried again; one that never works is broken', async () => {
  let n = 0
  const flaky = harness({
    check: async () => {
      n += 1
      if (n < 3) throw new Error('connect ECONNREFUSED 127.0.0.1:8642')
      return check()
    },
  })
  await flaky.updates.start({ channel: 'main', testAgentId: null })
  expect(await finished(flaky.updates)).toMatchObject({ outcome: 'clear' })

  const down = harness({
    check: async () => {
      throw new Error('connect ECONNREFUSED')
    },
  })
  await down.updates.start({ channel: 'main', testAgentId: null })
  const job = await finished(down.updates)
  expect(job).toMatchObject({ outcome: 'broken' })
  expect(job.error).toMatch(/couldn't check it/)
})
