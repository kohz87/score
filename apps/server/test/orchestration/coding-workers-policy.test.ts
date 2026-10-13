import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORCH_ACKNOWLEDGEMENT_TEXT, type OrchestrationCreate } from '@score/contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'

// 7.7b-2 §§3-4: the worker policy, the invocation built from it, and consent by policy id. Real executor, runtime,
// supervisor, journal and database; only systemd is faked. No configuration or credential file is ever read: the tests
// create files only to see their identity (stat) bound.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const oneStep = byTurn({
  1: async (t) => {
    await t.call('orch.assign', { agent: 'coder', instruction: '[fixture:basic] write hello' })
    return 'assigned'
  },
  2: async (t) => {
    await t.call('orch.finish', { outcome: 'success', summary: 'done' })
  },
})
const attempt = () =>
  h.rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n")[0]!
const gens = () =>
  h.rows<Record<string, unknown>>('SELECT * FROM orc_generations ORDER BY generation')
const launches = () =>
  h.rows<Record<string, unknown>>('SELECT * FROM coding_launches ORDER BY updated_at')
const sql = (text: string, ...args: (string | number | null)[]) =>
  h.db.sqlite.prepare(text).run(...args)
const closed = () => h.until(() => gens().some((g) => g['closed_cause'] !== null))
const bytesOfFiles = (): string =>
  [
    JSON.stringify(h.rows('SELECT * FROM orc_worker_policies')),
    JSON.stringify(h.rows('SELECT detail FROM orc_history')),
    readFileSync(join(h.namespace, 'journal.ndjson'), 'utf8'),
  ].join('\n')

/** Changes the world once, while the unit of generation 1 is being armed (after preparation, before the release). */
const baseBody = (allowedAgents: string[]): OrchestrationCreate => ({
  goal: 'g',
  leadAgentId: 'lead',
  allowedAgents,
  gatePolicy: 'none',
  maxSteps: 12,
  maxLeadTurns: 20,
  maxConcurrentSteps: 2,
  leadTurnEstimateUsd: 0.25,
  stepEstimateUsd: 0.5,
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
})

function atArming(change: () => void): void {
  h.fake.hooks.afterStart = () => {
    h.fake.hooks.afterStart = undefined
    change()
  }
}

describe('preflight and consent by policy id', () => {
  test('a worker’s preflight entry carries readiness, a policy id and the reach in plain words', async () => {
    h = await workerHarness({ lead: { script: oneStep } })
    h.addAgent('cc', 'claude-code')
    h.addAgent('cx', 'codex', 'read-only')
    const preflight = await h.orch.preflight('lead', ['cc', 'cx'])
    expect(preflight.ok).toBe(true)
    const [cc, cx] = preflight.workers
    expect(cc).toMatchObject({
      agentId: 'cc',
      runtime: 'claude-code',
      readiness: 'ready',
      detail: null,
      reachBeyondWorkspace: false,
    })
    expect(cc!.policyId).toMatch(/^[0-9a-f]{64}$/)
    expect(cc!.reach).toContain(h.workspace)
    expect(cx).toMatchObject({ agentId: 'cx', runtime: 'codex', reachBeyondWorkspace: true })
    expect(cx!.policyId).not.toBe(cc!.policyId)
    // The policy id is stable until something it binds changes.
    expect((await h.orch.preflight('lead', ['cc'])).workers[0]!.policyId).toBe(cc!.policyId)
  })

  test('create needs the policy ids the person saw: missing ⇒ 400, another ⇒ 409 policy_changed', async () => {
    h = await workerHarness({ lead: { script: oneStep } })
    h.addAgent()
    const preflight = await h.orch.preflight('lead', ['coder'])
    const policyId = preflight.workers[0]!.policyId!
    const base = baseBody(['coder'])
    await expect(h.orch.create({ ...base })).rejects.toMatchObject({ status: 400 })
    await expect(
      h.orch.create({ ...base, codingPolicies: { coder: 'a'.repeat(64) } }),
    ).rejects.toMatchObject({ status: 409, code: 'policy_changed' })
    // The settings change after the person looked: the old id is refused with the current one in the details.
    mkdirSync(join(h.home, '.claude'), { recursive: true })
    writeFileSync(join(h.home, '.claude', 'settings.json'), '{}')
    await expect(
      h.orch.create({ ...base, codingPolicies: { coder: policyId } }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'policy_changed',
      details: { agentId: 'coder' },
    })
  })

  test('a reach beyond the workspace needs the acknowledgement of that exact policy id, stored in the history', async () => {
    h = await workerHarness({ lead: { script: oneStep } })
    h.addAgent('cx', 'codex', 'read-only')
    const preflight = await h.orch.preflight('lead', ['cx'])
    const policyId = preflight.workers[0]!.policyId!
    const body = { ...baseBody(['cx']), codingPolicies: { cx: policyId } }
    await expect(h.orch.create({ ...body })).rejects.toMatchObject({
      status: 409,
      code: 'reach_not_acknowledged',
    })
    // An acknowledgement of some other id doesn't count.
    await expect(
      h.orch.create({ ...body, acknowledgeCodingReach: { policyIds: ['b'.repeat(64)] } }),
    ).rejects.toMatchObject({ code: 'reach_not_acknowledged' })
    const created = await h.orch.create({
      ...body,
      acknowledgeCodingReach: { policyIds: [policyId] },
    })
    const history = h.rows<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM orc_history WHERE kind = 'coding_reach_acknowledged'",
    )
    expect(history).toHaveLength(1)
    expect(JSON.parse(history[0]!.detail)).toEqual({ policyIds: [policyId] })
    const detail = h.orch.snapshot(created.orchestration.id).orchestration
    expect(detail.coding).toMatchObject({
      stepLimit: 10,
      workers: [{ agentId: 'cx', policyId, reachBeyondWorkspace: true }],
    })
  })

  test('environment values are never stored: only their names and a hash', async () => {
    process.env['LC_SCORETEST'] = 'value-abc-123-sentinel'
    try {
      h = await workerHarness({ lead: { script: oneStep } })
    } finally {
      delete process.env['LC_SCORETEST']
    }
    h.addAgent()
    const id = await h.create()
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    const stored = h.rows<{ policy: string }>('SELECT policy FROM orc_worker_policies')[0]!
    expect(JSON.parse(stored.policy).envNames).toContain('LC_SCORETEST')
    expect(JSON.parse(stored.policy).envSha256).toMatch(/^[0-9a-f]{64}$/)
    const everything = [
      bytesOfFiles(),
      JSON.stringify(await h.orch.preflight('lead', ['coder'])),
      JSON.stringify(h.orch.snapshot(id)),
      JSON.stringify(h.rows('SELECT * FROM orc_attempts')),
    ].join('\n')
    expect(everything).not.toContain('value-abc-123-sentinel')
  })

  test('configuration files are bound by identity and never read (an unreadable one still binds)', async () => {
    h = await workerHarness({ lead: { script: oneStep } })
    h.addAgent('cx', 'codex', 'read-only')
    const before = (await h.orch.preflight('lead', ['cx'])).workers[0]!.policyId
    mkdirSync(join(h.home, '.codex'), { recursive: true })
    const config = join(h.home, '.codex', 'config.toml')
    writeFileSync(config, 'model = "x"\n')
    chmodSync(config, 0o000)
    const withFile = (await h.orch.preflight('lead', ['cx'])).workers[0]!
    // Reading it would fail with EACCES; the policy is computed and differs from the "absent" one.
    expect(withFile.readiness).toBe('ready')
    expect(withFile.policyId).not.toBe(before)
    chmodSync(config, 0o600)
    rmSync(config)
    expect((await h.orch.preflight('lead', ['cx'])).workers[0]!.policyId).toBe(before)
  })
})

describe('the invocation is built from the stored policy', () => {
  test('an agent row changed to full while the step waits does not change the invocation', async () => {
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async (t) => {
            // The agent is edited to `full` and a different model after the person approved the run.
            sql(
              "UPDATE coding_agents SET permission = 'full', model = 'other-model' WHERE id = 'coder'",
            )
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
    const call = h.cliCalls()[0]!
    expect(call.args).toContain('acceptEdits')
    expect(call.args).not.toContain('bypassPermissions')
    expect(call.args).not.toContain('--model')
    // The worker flags came with it: no MCP server of the person's own sessions.
    expect(call.args).toContain('--strict-mcp-config')
  })

  test('Codex workers ignore the user config and execution rules', async () => {
    h = await workerHarness({
      lead: {
        script: byTurn({
          1: async (t) => {
            await t.call('orch.assign', { agent: 'cx', instruction: '[fixture:basic] hello' })
            return 'assigned'
          },
          2: async (t) => {
            await t.call('orch.finish', { outcome: 'success', summary: 'done' })
          },
        }),
      },
    })
    h.addAgent('cx', 'codex', 'read-only')
    const id = await h.create({ allowedAgents: ['cx'] })
    await h.until(() => h.orch.summary(id).status === 'succeeded', 40_000)
    const args = h.cliCalls()[0]!.args
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules']))
    expect(args).toEqual(expect.arrayContaining(['-s', 'read-only']))
  })
})

describe('every external identity is read again before the release', () => {
  const settingsFile = () => join(h.home, 'coding', 'coder', 'claude-settings.json')

  async function revokedBy(change: () => void) {
    h = await workerHarness({ lead: { script: oneStep } })
    h.addAgent()
    atArming(change)
    const id = await h.create()
    await closed()
    expect(gens()[0]).toMatchObject({ closed_cause: 'agent_changed' })
    expect(launches()[0]).toMatchObject({
      revoked: 1,
      may_have_executed: 0,
      revoke_cause: 'agent_changed',
    })
    expect(h.cliCalls()).toHaveLength(0)
    await h.until(
      () => h.rows<{ status: string }>('SELECT status FROM orc_steps')[0]?.status === 'blocked',
    )
    expect(h.rows('SELECT disposition FROM orc_steps')).toEqual([{ disposition: 'agent_changed' }])
    // One attempt per step, suspended (it holds no slot); nothing was launched.
    expect(attempt()).toMatchObject({ state: 'created', suspended: 1, refused_total: 0 })
    expect(h.orch.summary(id).needsYou).toContainEqual(
      expect.objectContaining({ kind: 'policy_changed', agentId: 'coder' }),
    )
  }

  test('the CLI binary replaced between preparation and release ⇒ revoked "agent changed"', async () => {
    await revokedBy(() =>
      writeFileSync(h.cliFile, readFileSync(h.cliFile, 'utf8') + '\n// replaced\n'),
    )
  })

  test('a bound configuration file (Claude user settings) replaced ⇒ "agent changed"', async () => {
    await revokedBy(() => {
      mkdirSync(join(h.home, '.claude'), { recursive: true })
      writeFileSync(join(h.home, '.claude', 'settings.json'), '{}')
    })
  })

  test('a CLAUDE.md in the workspace chain ⇒ "agent changed"', async () => {
    await revokedBy(() => writeFileSync(join(h.workspace, 'CLAUDE.md'), 'be careful'))
  })

  test('the settings file Score wrote, edited ⇒ "agent changed"', async () => {
    await revokedBy(() => writeFileSync(settingsFile(), '{"permissions":{"deny":[]}}'))
  })

  test('an allow-listed environment variable that changed ⇒ "agent changed"', async () => {
    await revokedBy(() => {
      h.cliEnv['TZ'] = 'Pacific/Fiji'
    })
  })

  test('the workspace replaced by another folder ⇒ "agent changed"', async () => {
    await revokedBy(() => {
      rmSync(h.workspace, { recursive: true })
      mkdirSync(h.workspace)
    })
  })
})
