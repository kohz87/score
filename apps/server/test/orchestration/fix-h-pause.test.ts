import { expect, test } from 'vitest'
import { detail, holdScript, running, startHarness, startup, status } from './fix-h-helpers.ts'

test('fix-h 5: Pause during a budget pause survives raising the budget until Resume', async () => {
  const h = await startHarness({ lead: holdScript })
  const id = await running({ budgetUsd: 50 })
  const rev = () => detail(id).revision
  await h.orch.limits(id, { budgetUsd: 0.1, orchestrationRevision: rev() })
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).pauseReason).toBe('budget')
  await h.orch.pause(id, { orchestrationRevision: rev() })
  await h.orch.limits(id, { budgetUsd: 50, orchestrationRevision: rev() })
  await h.settle(3000)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('person')
  // Restore after overlapping holds: a database that lost the manual hold is detected.
  expect(startup().check.fenced).toBe(false)
  h.db.sqlite.prepare('UPDATE orchestrations SET manual_paused_at = NULL WHERE id = ?').run(id)
  expect(startup().check.fenced).toBe(true)
  h.db.sqlite
    .prepare('UPDATE orchestrations SET manual_paused_at = ? WHERE id = ?')
    .run('2026-10-10T10:00:00.000Z', id)
  await h.orch.resume(id, { orchestrationRevision: rev() })
  expect(status(id)).toBe('running')
})

test('fix-h 5: Pause then a budget condition: Resume does not lift the budget pause, raising the budget does', async () => {
  const h = await startHarness({ lead: holdScript })
  const id = await running({ budgetUsd: 50 })
  const rev = () => detail(id).revision
  await h.orch.pause(id, { orchestrationRevision: rev() })
  await h.orch.limits(id, { budgetUsd: 0.1, orchestrationRevision: rev() })
  await h.orch.resume(id, { orchestrationRevision: rev() })
  await h.until(() => status(id) === 'paused')
  expect(h.orch.summary(id).pauseReason).toBe('budget')
  // A second Pause on top of the budget pause, then Resume: only the manual hold goes.
  await h.orch.pause(id, { orchestrationRevision: rev() })
  await h.orch.resume(id, { orchestrationRevision: rev() })
  await h.settle(3000)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('budget')
  await h.orch.limits(id, { budgetUsd: 50, orchestrationRevision: rev() })
  expect(status(id)).toBe('running')
})
