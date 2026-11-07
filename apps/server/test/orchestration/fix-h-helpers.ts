import { afterEach } from 'vitest'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

export let h: Harness

export const startHarness = async (options?: Parameters<typeof harness>[0]) => {
  h = options ? await harness(options) : await harness()
  return h
}

afterEach(async () => {
  await h?.close()
  h = undefined as never
})

export const status = (id: string) => h.orch.summary(id).status
export const detail = (id: string) => h.orch.snapshot(id).orchestration

export const holdScript = {
  script: byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
    },
  }),
}

/** A fresh fence store over the live database and journal: what the next Score start would run. */
export const startup = () => {
  const store = new GlobalFenceStore(h.db, h.journal, () => h.scheduler.now())
  return { store, check: store.startupCheck() }
}

export const running = async (overrides: Parameters<Harness['create']>[0]) => {
  const id = await h.create({ gatePolicy: 'none', ...overrides })
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  return id
}

export const A = '11111111-1111-4111-8111-111111111111'
export const B = '22222222-2222-4222-8222-222222222222'

export const replaceBuilder = () =>
  h.db.sqlite
    .prepare("UPDATE agent_lifecycle SET incarnation_id = ? WHERE agent_id = 'builder'")
    .run(B)

export const seedBuilder = () =>
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('builder', ?, 'ready')",
    )
    .run(A)
