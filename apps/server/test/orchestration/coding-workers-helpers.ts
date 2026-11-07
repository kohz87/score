import { afterEach, vi } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import type { WorkerHarness } from '../helpers/worker-harness.ts'

export const oneStep = (instruction = '[fixture:basic] write hello') =>
  byTurn({
    1: async (t) => {
      await t.call('orch.assign', { agent: 'coder', instruction })
      return 'assigned'
    },
    2: async (t) => {
      await t.call('orch.finish', { outcome: 'success', summary: 'done' })
    },
  })

let harness: () => WorkerHarness | undefined = () => undefined

export function useWorkerHarness(
  current: () => WorkerHarness | undefined,
  reset: () => void,
): void {
  harness = current
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })
  afterEach(async () => {
    await current()?.close()
    reset()
  })
}

const h = () => {
  const current = harness()
  if (!current) throw new Error('worker harness is not ready')
  return current
}

export const attempt = () =>
  h().rows<Record<string, unknown>>("SELECT * FROM orc_attempts WHERE kind = 'step' ORDER BY n")[0]!
export const step = () => h().rows<Record<string, unknown>>('SELECT * FROM orc_steps')[0]!
export const gens = () =>
  h().rows<Record<string, unknown>>('SELECT * FROM orc_generations ORDER BY generation')
export const launches = () =>
  h().rows<Record<string, unknown>>('SELECT * FROM coding_launches ORDER BY updated_at')
export const journalKinds = (kind: string) => {
  const read = h().journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries.filter((entry) => entry.kind === kind)
}
export const nowIso = () => new Date().toISOString()

/** Changes the world once, while the unit of generation 1 is being armed (just before the release decision). */
export function atArming(change: () => void): void {
  const worker = h()
  worker.fake.hooks.afterStart = () => {
    worker.fake.hooks.afterStart = undefined
    change()
  }
}
export const sql = (text: string, ...args: (string | number | null)[]) =>
  h()
    .db.sqlite.prepare(text)
    .run(...args)
export const revision = (id: string) => h().orch.summary(id).revision

/** Waits until generation 1 is closed in the database (the closure is applied after the revoke tombstone is read). */
export const closed = () => h().until(() => gens().some((g) => g['closed_cause'] !== null))
