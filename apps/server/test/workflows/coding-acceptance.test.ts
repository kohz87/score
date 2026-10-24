import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end, gate } from './wf-harness.ts'

// 7.7c-1 #10: the done-when items that cut across the others: scoped unknown cost in the workflow view, the restore checks
// for the new decisions, a restart while a step is held back, no write to Chat's session cache, and a workflow with no
// coding step that is unchanged.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 })
let h: WorkerHarness
let fence: string | null = null
afterEach(async () => {
  await h?.close()
  h = undefined as never
  fence = null
})

const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const node = (id: string, nodeId: string) =>
  wfRunOf(h, id).nodeStates.find((n) => n.nodeId === nodeId)!
const revision = (id: string) => h.orch.workflowSummary(id).revision
const summary = (id: string) => h.orch.workflowSummary(id)
async function boot(options: Parameters<typeof workerHarness>[0] = {}): Promise<void> {
  h = await workerHarness(options)
  addCodingAgent(h, 'cc', 'claude-code')
  addCodingAgent(h, 'cx', 'codex', 'read-only')
}
const one = (agentId = 'cc') =>
  definition(
    [agent('a', { agentId, instruction: '[fixture:basic] write hello' }), end()],
    [edge('a', 'done')],
  )

describe('unknown cost per source in the workflow view', () => {
  test('a Codex step without a cost pauses a budgeted run until that source is accepted; other sources don’t help', async () => {
    await boot()
    const id = await startWorkflow(
      h,
      definition(
        [
          agent('a', { agentId: 'cx', instruction: '[fixture:basic] review' }),
          agent('b', { agentId: 'cc', instruction: '[fixture:basic] write {{nodes.a.output}}' }),
          end(),
        ],
        [edge('a', 'b'), edge('b', 'done')],
      ),
      { budgetUsd: 50, maxConcurrentSteps: 1 },
    )
    await h.until(() => summary(id).status === 'paused', 60_000)
    expect(summary(id).pauseReason).toBe('unknown_spend')
    expect(summary(id).needsYou).toContainEqual({ kind: 'budget', reason: 'unknown_spend' })
    expect(node(id, 'a').state).toBe('succeeded')
    expect(summary(id).coding).toMatchObject({ unknownSpend: 'pause', acceptedUnknownCost: [] })
    await h.orch.wfLimits(id, {
      acceptUnknownCost: { add: ['claude-code', 'hermes'] },
      orchestrationRevision: revision(id),
    })
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(summary(id).status).toBe('paused')
    expect(summary(id).coding?.acceptedUnknownCost).toEqual(['claude-code', 'hermes'])
    await h.orch.wfLimits(id, {
      acceptUnknownCost: { add: ['codex'], remove: ['hermes'] },
      orchestrationRevision: revision(id),
    })
    await h.until(() => summary(id).status === 'succeeded', 60_000)
    expect(summary(id).coding?.acceptedUnknownCost).toEqual(['claude-code', 'codex'])
  })
})

describe('restore checks', () => {
  test('“Use the new settings” for a node is journaled: a database that lost it is found at the next start', async () => {
    await boot()
    h.fake.hooks.afterStart = () => {
      h.fake.hooks.afterStart = undefined
      writeFileSync(join(h.dir, 'ws-cc', 'CLAUDE.md'), 'new instructions')
    }
    const id = await startWorkflow(h, one())
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'agent_changed'").length > 0,
      60_000,
    )
    const oldPolicy = rows('SELECT policy_id FROM orc_worker_policies')[0]!['policy_id'] as string
    const fresh = (await h.orch.preflight('lead', ['cc'])).workers[0]!.policyId!
    await h.orch.wfPolicyRemap(id, 'a', {
      policyId: fresh,
      expectedNodeRevision: node(id, 'a').revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => summary(id).status === 'succeeded', 60_000)
    await h.orch.maintenance()
    h.db.sqlite.prepare('UPDATE orc_worker_policies SET policy_id = ?').run(oldPolicy)
    await h.restart()
    expect(h.fence.view().fenced).toBe(true)
    expect(JSON.stringify(h.fence.view().items)).toContain(
      'were approved, but the database does not hold them',
    )
  })
})

describe('a restart while a step is held back', () => {
  test('the item and the suspended attempt survive; Try again then renews it', async () => {
    await boot({ unit: { blocked: () => fence }, orchestrator: { retryMs: 20 } })
    const id = await startWorkflow(h, one())
    fence = 'A fence is up.'
    await h.until(
      () => rows("SELECT 1 FROM orc_steps WHERE disposition = 'held_back'").length > 0,
      120_000,
    )
    const [attempt] = rows("SELECT id FROM orc_attempts WHERE kind = 'step'")
    await h.restart()
    await h.orch.admissionChanged()
    await h.orch.idle()
    expect(summary(id).needsYou).toContainEqual({ kind: 'coding_held_back', nodeId: 'a' })
    expect(rows("SELECT id, suspended FROM orc_attempts WHERE kind = 'step'")).toEqual([
      { id: attempt!['id'], suspended: 1 },
    ])
    fence = null
    await h.orch.wfTryAgain(id, 'a', {
      expectedNodeRevision: node(id, 'a').revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => summary(id).status === 'succeeded', 60_000)
    expect(rows("SELECT COUNT(*) AS n FROM orc_attempts WHERE kind = 'step'")[0]!['n']).toBe(2)
  })
})

describe('Chat’s session cache', () => {
  test('a workflow coding step neither reads nor writes it, and the run ending leaves it alone', async () => {
    await boot()
    const id = await startWorkflow(h, one(), { gatePolicy: 'every-step' })
    const room = rows('SELECT room_id FROM orchestrations WHERE id = ?', id)[0]![
      'room_id'
    ] as string
    h.db.sqlite
      .prepare(
        "INSERT INTO coding_sessions (job_id, agent_id, session_id, updated_at) SELECT id, 'cc', 'chat-session', ? FROM jobs WHERE room_id = ?",
      )
      .run(new Date().toISOString(), room)
    await h.until(() => wfRunOf(h, id).assignmentGates.some((g) => g.status === 'open'))
    const open = wfRunOf(h, id).assignmentGates.find((g) => g.status === 'open')!
    await h.orch.wfGateDecision(id, open.id, {
      decision: 'approve',
      expectedRevision: open.revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => summary(id).status === 'succeeded', 60_000)
    // The CLI ran fresh (no resume of Chat's session), and its own session id stayed on the run.
    expect(h.cliCalls()[0]!.args.join(' ')).not.toContain('chat-session')
    expect(rows('SELECT session_id FROM coding_sessions')).toEqual([{ session_id: 'chat-session' }])
    expect(
      rows("SELECT session_id FROM runs WHERE runtime = 'claude-code'")[0]!['session_id'],
    ).toBeTruthy()
  })
})

describe('a workflow without coding steps', () => {
  test('a gate-only workflow starts and finishes with no coding fields anywhere', async () => {
    await boot()
    const def = definition([gate('g'), end()], [edge('g', 'done')])
    const id = await startWorkflow(h, def)
    expect(summary(id).coding).toBeUndefined()
    expect(rows('SELECT 1 FROM orc_worker_policies')).toEqual([])
    const open = wfRunOf(h, id).nodeGates.find((g) => g.status === 'open')!
    await h.orch.wfGateDecision(id, open.id, {
      decision: 'approve',
      expectedRevision: open.revision,
      orchestrationRevision: revision(id),
    })
    await h.until(() => summary(id).status === 'succeeded', 60_000)
    expect(summary(id).coding).toBeUndefined()
  })
})
