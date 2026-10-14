import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import type { WorkerPolicy } from '../../src/runtimes/coding/policy.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-2 §3: what preflight says when a coding worker can't take a step, and the policy check as the release runs it.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const worker = async (agent = 'coder') => (await h.orch.preflight('lead', [agent])).workers[0]!

describe('readiness', () => {
  test('ready', async () => {
    h = await workerHarness()
    h.addAgent()
    expect(await worker()).toMatchObject({ readiness: 'ready', detail: null })
  })

  test('an untested CLI version', async () => {
    h = await workerHarness()
    h.addAgent()
    h.cliEnv['SCORE_CODING_FAKE_VERSION'] = '9.9.9'
    const preflight = await h.orch.preflight('lead', ['coder'])
    expect(preflight.ok).toBe(false)
    expect(preflight.workers[0]).toMatchObject({
      readiness: 'version_untested',
      policyId: null,
      reach: null,
    })
    expect(preflight.checks.find((c) => c.id === 'allowed_agents')?.message).toContain('coder:')
  })

  test('a permission level the CLI isn’t verified for', async () => {
    h = await workerHarness()
    h.addAgent()
    h.cliEnv['SCORE_CODING_VERIFIED_CLAUDE_CODE'] = 'read-only'
    expect(await worker()).toMatchObject({ readiness: 'level_unverified' })
  })

  test('a frozen home', async () => {
    h = await workerHarness()
    h.addAgent()
    h.fence.freeze('test freeze')
    expect(await worker()).toMatchObject({ readiness: 'frozen' })
  })

  test('a coding fence', async () => {
    let fence: string | null = null
    h = await workerHarness({ unit: { blocked: () => fence } })
    h.addAgent()
    fence = 'A fence is up.'
    expect(await worker()).toMatchObject({ readiness: 'paused', detail: 'A fence is up.' })
  })

  test('a workspace that is gone, or a folder Score can’t look into, is "reach unverifiable"', async () => {
    h = await workerHarness()
    h.addAgent()
    const closed = join(h.workspace, '.claude')
    mkdirSync(closed)
    chmodSync(closed, 0o000)
    try {
      expect(await worker()).toMatchObject({ readiness: 'reach_unverifiable' })
    } finally {
      chmodSync(closed, 0o700)
    }
    expect(await worker()).toMatchObject({ readiness: 'ready' })
    rmSync(h.workspace, { recursive: true })
    expect(await worker()).toMatchObject({ readiness: 'reach_unverifiable' })
  })

  test('create refuses a worker that isn’t ready (preflight_failed)', async () => {
    h = await workerHarness()
    h.addAgent()
    h.cliEnv['SCORE_CODING_FAKE_VERSION'] = '9.9.9'
    await expect(h.create()).rejects.toMatchObject({ code: 'preflight_failed' })
  })
})

describe('the policy check as the release runs it', () => {
  /** A finished run leaves Score’s settings file on disk, which the release check hashes. */
  async function afterARun() {
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async (t) => {
            await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] hello' })
            return 'assigned'
          },
          2: async (t) => {
            await t.call('orch.finish', { outcome: 'success', summary: 'done' })
          },
        }),
      },
    })
    h.addAgent()
    const id = await h.create()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    const stored = h.rows<{ policy: string; policy_id: string }>(
      'SELECT policy, policy_id FROM orc_worker_policies',
    )[0]!
    return { policy: JSON.parse(stored.policy) as WorkerPolicy, policyId: stored.policy_id }
  }

  test('inside a caller’s transaction it opens none and still answers (the release runs it in a read transaction)', async () => {
    const { policy, policyId } = await afterARun()
    h.db.sqlite.exec('BEGIN')
    try {
      expect(h.db.sqlite.isTransaction).toBe(true)
      expect(h.coding.checkWorkerPolicy('coder', policy)).toEqual({ ok: true, id: policyId })
      // Still the caller’s transaction: nothing here committed or opened another.
      expect(h.db.sqlite.isTransaction).toBe(true)
    } finally {
      h.db.sqlite.exec('ROLLBACK')
    }
  })

  test('a changed bound source answers with another id; an unreadable one answers "reach unverifiable"', async () => {
    const { policy, policyId } = await afterARun()
    mkdirSync(join(h.workspace, '.claude'))
    writeFileSync(join(h.workspace, '.claude', 'settings.json'), '{}')
    const changed = h.coding.checkWorkerPolicy('coder', policy)
    expect(changed).toMatchObject({ ok: true })
    expect((changed as { id: string }).id).not.toBe(policyId)
    chmodSync(join(h.workspace, '.claude'), 0o000)
    try {
      expect(h.coding.checkWorkerPolicy('coder', policy)).toMatchObject({
        ok: false,
        cause: 'reach_unverifiable',
      })
    } finally {
      chmodSync(join(h.workspace, '.claude'), 0o700)
    }
  })

  test('without Score’s settings file on disk the check can’t pass', async () => {
    h = await workerHarness()
    h.addAgent()
    const report = await h.coding.workerReport('coder')
    expect(h.coding.checkWorkerPolicy('coder', report.policy!)).toMatchObject({
      ok: false,
      cause: 'reach_unverifiable',
    })
  })
})
