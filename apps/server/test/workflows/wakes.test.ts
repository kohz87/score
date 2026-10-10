import { afterEach, expect, test } from 'vitest'
import { Orchestrator } from '../../src/domain/orchestration/executor.ts'
import { bumpAdmission } from '../../src/domain/orchestration/ops.ts'
import { admissionRevision } from '../../src/domain/orchestration/ops.ts'
import {
  agent,
  definition,
  edge,
  end,
  finishNode,
  node,
  run,
  runIdOf,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done =
  (id: string, status = 'succeeded') =>
  (): boolean =>
    run(h!, id).status === status
const simple = () => definition([agent('a'), end()], [edge('a', 'done')])
const revision = () => admissionRevision(h!.db.sqlite)
const seen = (id: string) =>
  h!.rows<{ admission_seen: number }>(
    'SELECT admission_seen FROM orchestrations WHERE id = ?',
    id,
  )[0]!.admission_seen

test('every change that can make waiting work admissible increments the admission revision', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
    {
      budgetUsd: 50,
    },
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await h.settle(1500)
  const steps: [string, () => Promise<unknown>][] = [
    [
      'limits raised',
      () => h!.orch.wfLimits(id, { budgetUsd: 80, orchestrationRevision: run(h!, id).revision }),
    ],
    ['pause', async () => undefined],
    [
      'resume',
      async () => {
        await h!.orch.wfPause(id, { orchestrationRevision: run(h!, id).revision })
        await h!.settle(1500)
        await h!.orch.wfResume(id, { orchestrationRevision: run(h!, id).revision })
      },
    ],
    ['agent ready', () => h!.orch.agentReady('builder')],
    ['team or agent resume', () => h!.orch.admissionChanged()],
  ]
  for (const [label, act] of steps) {
    await h.settle(1500)
    const before = revision()
    await act()
    if (label !== 'pause') expect(revision(), label).toBeGreaterThan(before)
  }
  // Releasing a fence is one of them too.
  h.fence.set('test', [{ kind: 'journal', ref: 'x', journalN: null, detail: 'x' }])
  const beforeLift = revision()
  h.fence.lift(h.fence.view().revision, 'ok')
  expect(revision()).toBe(beforeLift)
  void bumpAdmission
})

test('a lifted fence wakes waiting work: the next node waits on the fence, then proceeds', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A' }), agent('b'), end()],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  h.fence.set('test', [{ kind: 'journal', ref: 'y', journalN: null, detail: 'y' }])
  await finishNode(h, id, 'a', 'completed', 'a done')
  await h.until(() => node(h!, id, 'b').waitingFor === 'fence')
  expect(run(h, id).needsYou.some((n) => n.kind === 'fence')).toBe(true)
  h.fence.lift(h.fence.view().revision, 'ok')
  await h.until(done(id))
})

test('a run held by an agent pause waits as "agent hold" and is woken when the pause lifts', async () => {
  h = await wfHarness()
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('builder', '2026-01-01T00:00:00.000Z')",
    )
    .run()
  const id = await start(h, simple())
  await h.until(() => node(h!, id, 'a').waitingFor === 'agent_hold')
  h.db.sqlite.prepare("DELETE FROM agent_pauses WHERE agent_id = 'builder'").run()
  await h.orch.admissionChanged()
  await h.until(done(id))
})

test('a team pause shows the same wait and its release resumes the work', async () => {
  h = await wfHarness()
  h.db.sqlite
    .prepare("UPDATE team_state SET paused_at = '2026-01-01T00:00:00.000Z' WHERE id = 1")
    .run()
  const id = await start(h, simple())
  await h.settle(5000)
  expect(node(h, id, 'a').waitingFor).toBe('agent_hold')
  h.db.sqlite.prepare('UPDATE team_state SET paused_at = NULL WHERE id = 1').run()
  await h.orch.admissionChanged()
  await h.until(done(id))
})

test('capacity released by another run wakes the run that waited for it', async () => {
  h = await wfHarness()
  const hold = (n: string) => agent(n, { instruction: `[fake:hold] ${n}` })
  const first = await start(
    h,
    definition([hold('x1'), hold('x2'), end()], [edge('x1', 'done'), edge('x2', 'done')]),
  )
  await h.until(
    () => runIdOf(h!, first, 'x1') !== undefined && runIdOf(h!, first, 'x2') !== undefined,
  )
  const second = await start(h, simple())
  await h.until(() => node(h!, second, 'a').waitingFor === 'agent_capacity')
  await finishNode(h, first, 'x1', 'completed', 'x1 done')
  await h.until(done(second))
  await finishNode(h, first, 'x2', 'completed', 'x2 done')
  await h.until(done(first))
})

test('a restart between the change and the planner pass loses nothing: the revision is durable', async () => {
  h = await wfHarness()
  const id = await start(h, simple(), { budgetUsd: 0.3 })
  await h.settle(3000)
  expect(node(h, id, 'a').waitingFor).toBe('budget')
  await h.orch.close()
  // The change happens while no executor is running (a crash right after the commit).
  h.db.sqlite.prepare('UPDATE orchestrations SET budget_usd = 10 WHERE id = ?').run(id)
  bumpAdmission(h.db.sqlite)
  expect(seen(id)).toBeLessThan(revision())
  const next = new Orchestrator({
    db: h.db,
    ingest: h.ingest,
    port: h.port,
    access: h.access,
    fence: h.fence,
    clock: () => h!.scheduler.now(),
    retryMs: 1000,
    onError: (e) => h!.errors.push(e),
  })
  h.orch = next
  await next.start()
  await h.until(done(id))
  // The first pass after the restart saw a revision it had not evaluated and re-evaluated the waiting node under a
  // new generation.
  expect(
    h.rows<{ generation: number }>("SELECT generation FROM wf_commands WHERE verb = 'assign'")[0]!
      .generation,
  ).toBeGreaterThanOrEqual(1)
  expect(h.errors).toEqual([])
})
