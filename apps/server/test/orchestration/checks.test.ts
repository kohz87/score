// 3.13 (decision 150): the oracle. A person-set check gates a successful finish; the lead can only run it.
import type { OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import type {
  CheckRequest,
  CheckResult,
  CheckSpawner,
} from '../../src/runtimes/check/spawn-check.ts'
import { endRun, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const r = (value: unknown) => value as OrchReceipt
const status = (id: string) => h.orch.summary(id).status

interface FakeRun {
  req: CheckRequest
  stopped: boolean
  finish(exitCode: number, output?: string): void
}
function fakeChecks() {
  const runs: FakeRun[] = []
  const spawner: CheckSpawner = async (req) => {
    let resolve!: (result: CheckResult) => void
    const done = new Promise<CheckResult>((res) => (resolve = res))
    const run: FakeRun = {
      req,
      stopped: false,
      finish: (exitCode, output = '') =>
        resolve({ exitCode, signal: null, timedOut: false, stopped: false, output }),
    }
    runs.push(run)
    return {
      stop() {
        run.stopped = true
        resolve({ exitCode: null, signal: 'SIGTERM', timedOut: false, stopped: true, output: '' })
      },
      done,
    }
  }
  return { runs, spawner }
}
const CHECK = {
  command: `pnpm test --filter 'web app'`,
  workspace: '/tmp/repo',
  timeoutSec: 600,
  when: 'finish' as const,
}

test('a successful finish needs a passing check; the lead runs it and is woken with the result', async () => {
  const checks = fakeChecks()
  const out: OrchReceipt[] = []
  const inputs: string[] = []
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: {
      script: byTurn({
        1: async (t) => {
          inputs.push(t.input)
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' })))
          out.push(r(await t.call('orch.check', {})))
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' })))
        },
        2: async (t) => {
          inputs.push(t.input)
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'done' })))
        },
      }),
    },
  })
  const id = await h.create({ check: CHECK })
  await h.until(() => checks.runs.length === 1)
  expect(out.map((o) => [o.status, o.code ?? null])).toEqual([
    ['refused', 'check_required'],
    ['ok', null],
    ['refused', 'check_running'],
  ])
  // The argv is the person's, split without a shell; the lead never supplied any of it.
  expect(checks.runs[0]!.req.argv).toEqual(['pnpm', 'test', '--filter', 'web app'])
  expect(checks.runs[0]!.req.cwd).toBe('/tmp/repo')
  expect(inputs[0]).toContain(`Check (set by the person`)
  expect(inputs[0]).toContain(`pnpm test --filter 'web app' in /tmp/repo`)
  expect(inputs[0]).toContain('orch.check()')
  checks.runs[0]!.finish(0, 'all 12 tests passed')
  await h.until(() => status(id) === 'succeeded')
  expect(inputs[1]).toContain('check_passed')
  expect(inputs[1]).toContain('Last check: passed (exit 0), after the last step.')
  const view = h.orch.snapshot(id).orchestration.check!
  expect(view.command).toBe(`pnpm test --filter 'web app'`)
  expect(view.runs[0]).toMatchObject({
    outcome: 'passed',
    exitCode: 0,
    reason: 'lead',
    current: true,
  })
})

test('a failing check reaches the lead with the end of its output, and success stays refused', async () => {
  const checks = fakeChecks()
  const out: OrchReceipt[] = []
  const inputs: string[] = []
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.check', {})
        },
        2: async (t) => {
          inputs.push(t.input)
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'x' })))
          out.push(r(await t.call('orch.finish', { outcome: 'partial', summary: 'tests fail' })))
        },
      }),
    },
  })
  const id = await h.create({ check: CHECK })
  await h.until(() => checks.runs.length === 1)
  checks.runs[0]!.finish(
    1,
    'FAIL src/a.test.ts\nexpected 2, got 3\napi key: sk-ant-abcdefghijklmnopqrstuvwxyz0123',
  )
  await h.until(() => status(id) === 'succeeded')
  expect(out.map((o) => o.code ?? o.status)).toEqual(['check_required', 'ok'])
  expect(inputs[0]).toContain('check_failed')
  expect(inputs[0]).toContain('Last check: failed (exit 1).')
  expect(inputs[0]).toContain('<<<CHECK OUTPUT (the end)')
  expect(inputs[0]).toContain('expected 2, got 3')
  // Output is redacted before it is stored or shown.
  expect(inputs[0]).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123')
  expect(h.orch.snapshot(id).orchestration.finish?.outcome).toBe('partial')
})

test('a pass from before a step ended does not count', async () => {
  const checks = fakeChecks()
  const out: OrchReceipt[] = []
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.check', {})
        },
        2: async (t) => {
          await t.call('orch.assign', {
            agent: 'builder',
            instruction: 'change things [fake:hold]',
          })
        },
        3: async (t) => {
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'x' })))
        },
      }),
    },
  })
  const id = await h.create({ check: CHECK })
  await h.until(() => checks.runs.length === 1)
  checks.runs[0]!.finish(0)
  await h.until(() =>
    h.orch.snapshot(id).orchestration.attempts.some((a) => a.kind === 'step' && a.runId),
  )
  const step = h.orch.snapshot(id).orchestration.attempts.find((a) => a.kind === 'step')!
  await endRun(h, step.runId!, 'completed', 'changed')
  await h.until(() => out.length === 1)
  expect(out[0]!.code).toBe('check_required')
  expect(out[0]!.message).toMatch(/before a step ended/)
  expect(h.orch.snapshot(id).orchestration.check!.runs[0]!.current).toBe(false)
})

test('a step Score cannot confirm ended makes a pass stale (it may still be writing)', async () => {
  const checks = fakeChecks()
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: { script: byTurn({ 1: async (t) => void (await t.call('orch.check', {})) }) },
  })
  const id = await h.create({ check: CHECK })
  await h.until(() => checks.runs.length === 1)
  checks.runs[0]!.finish(0)
  await h.until(() => h.orch.snapshot(id).orchestration.check!.runs[0]!.outcome === 'passed')
  expect(h.orch.snapshot(id).orchestration.check!.runs[0]!.current).toBe(true)
  // A copy of the lead's attempt row standing in for a step attempt whose end was never confirmed.
  const lead = h.rows<Record<string, unknown>>(
    'SELECT * FROM orc_attempts WHERE orchestration_id = ? LIMIT 1',
    id,
  )[0]!
  const row = {
    ...lead,
    id: 'att-u',
    kind: 'step',
    state: 'unknown',
    terminated_at: null,
    turn_id: 'turn-u',
    run_id: null,
  }
  const keys = Object.keys(row)
  h.db.sqlite
    .prepare(
      `INSERT INTO orc_attempts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    )
    .run(...(Object.values(row) as (string | number | null)[]))
  expect(h.orch.snapshot(id).orchestration.check!.runs[0]!.current).toBe(false)
})

test('when = each_step, Score queues a check after every step that succeeds', async () => {
  const checks = fakeChecks()
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: {
      script: byTurn({
        1: async (t) => {
          await t.call('orch.assign', { agent: 'builder', instruction: 'format the code' })
        },
      }),
    },
  })
  const id = await h.create({
    check: { ...CHECK, command: 'ruff format --check .', when: 'each_step' },
  })
  await h.until(() => checks.runs.length === 1)
  expect(checks.runs[0]!.req.argv).toEqual(['ruff', 'format', '--check', '.'])
  expect(h.orch.snapshot(id).orchestration.check!.runs[0]).toMatchObject({
    reason: 'step',
    outcome: 'running',
  })
})

test('the person can run the check and waive it; a waiver lets success through', async () => {
  const checks = fakeChecks()
  const out: OrchReceipt[] = []
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: {
      script: byTurn({
        1: async () => undefined,
        2: async (t) => {
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'x' })))
        },
      }),
    },
  })
  const id = await h.create({ check: CHECK })
  await h.settle()
  const revision = () => h.orch.summary(id).revision
  await h.orch.runCheck(id, { orchestrationRevision: revision() })
  await h.until(() => checks.runs.length === 1)
  expect(h.orch.snapshot(id).orchestration.check!.runs[0]!.reason).toBe('person')
  checks.runs[0]!.finish(2, 'broken for an unrelated reason')
  await h.until(() => out.length === 1)
  expect(out[0]!.code).toBe('check_required')
  await h.orch.waiveCheck(id, { orchestrationRevision: revision() })
  expect(h.orch.snapshot(id).orchestration.check!.waivedAt).not.toBeNull()
  await expect(h.orch.waiveCheck(id, { orchestrationRevision: revision() - 1 })).rejects.toThrow(
    /changed/,
  )
})

test('a job without a check: orch.check is refused and success finishes as before', async () => {
  const out: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.check', {})))
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'x' })))
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  expect(out.map((o) => o.code ?? o.status)).toEqual(['no_check', 'ok'])
  expect(h.orch.snapshot(id).orchestration.check).toBeNull()
})

test('stopping the job stops a running check; a restart marks a running one interrupted', async () => {
  const checks = fakeChecks()
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: { script: byTurn({ 1: async (t) => void (await t.call('orch.check', {})) }) },
  })
  const id = await h.create({ check: CHECK })
  await h.until(() => checks.runs.length === 1)
  await h.orch.stop(id)
  await h.until(() => checks.runs[0]!.stopped)
  // A row left running (Score went down mid-check) is never a pass.
  h.db.sqlite
    .prepare(
      "INSERT INTO orc_checks (id, orchestration_id, reason, queued_at, started_at, outcome) VALUES ('chk-x', ?, 'lead', ?, ?, 'running')",
    )
    .run(id, '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:01.000Z')
  await h.orch.recover()
  expect(h.rows("SELECT outcome FROM orc_checks WHERE id = 'chk-x'")).toEqual([
    { outcome: 'interrupted' },
  ])
})

test('a command with shell syntax is refused when the job is created', async () => {
  h = await harness()
  await expect(
    h.create({ check: { ...CHECK, command: 'pnpm lint && pnpm test' } }),
  ).rejects.toThrow(/needs a shell/)
})

test('a job makes at most 30 check runs (each keeps its output); then success needs the person', async () => {
  const checks = fakeChecks()
  const out: OrchReceipt[] = []
  h = await harness({
    orchestrator: { checks: checks.spawner },
    lead: {
      script: byTurn({
        1: async (t) => {
          out.push(r(await t.call('orch.check', {})))
          out.push(r(await t.call('orch.finish', { outcome: 'success', summary: 'x' })))
        },
      }),
    },
  })
  const id = await h.create({ check: CHECK })
  // Thirty finished, failed runs already on record.
  const insert = h.db.sqlite.prepare(
    "INSERT INTO orc_checks (id, orchestration_id, reason, queued_at, started_at, ended_at, exit_code, outcome) VALUES (?, ?, 'lead', ?, ?, ?, 1, 'failed')",
  )
  for (let i = 0; i < 30; i++)
    insert.run(
      `chk-${i}`,
      id,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    )
  await h.until(() => out.length === 2)
  expect(out.map((o) => o.code)).toEqual(['check_limit', 'check_limit'])
  expect(checks.runs).toHaveLength(0)
})
