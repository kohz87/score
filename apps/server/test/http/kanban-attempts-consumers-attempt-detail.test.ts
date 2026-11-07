import { AttemptDetailSchema, StreamEventSchema } from '@score/contract'
import { describe, expect, test } from 'vitest'
import { attemptUpdates } from '../../src/domain/kanban-attempts.ts'
import { HttpError } from '../../src/errors.ts'
import { withFlag } from '../helpers/kanban-attempts-seed.ts'
import {
  body,
  db,
  iso,
  port,
  seedWorld,
  setupKanbanAttemptsConsumersTest,
} from './kanban-attempts-consumers-helpers.ts'

setupKanbanAttemptsConsumersTest()

describe('Attempt detail', () => {
  test('returns the summary and the frozen task snapshot, also from an earlier board; unknown ids are 404', async () => {
    seedWorld()
    withFlag(true)
    const current = AttemptDetailSchema.parse(
      JSON.parse((await body('/api/attempts/kr_00000000-0000-4000-8000-000000000001')).text),
    )
    expect(current.task).toEqual({ taskId: 't-done', historyId: 'kh_test', current: true })
    expect(current.taskSnapshot?.title).toBe('Snapshot of t-done')
    const old = AttemptDetailSchema.parse(
      JSON.parse((await body('/api/attempts/kr_00000000-0000-4000-8000-000000000010')).text),
    )
    expect(old.task).toEqual({ taskId: 't-gone', historyId: 'kh_old', current: false })
    expect((await body('/api/attempts/kr_nope')).status).toBe(404)
    expect((await body('/api/attempts/not-an-attempt')).status).toBe(400)
  })
})

describe('Stop', () => {
  test('a Kanban attempt is refused with the existing 501 before any profile lookup', async () => {
    seedWorld()
    // The agent does not exist: a profile lookup would fail differently.
    await expect(port.stopRun({ agentId: 'nobody', runId: 'kr_anything' })).rejects.toMatchObject({
      status: 501,
      code: 'unsupported',
    })
    await expect(port.stopRun({ agentId: 'nobody', runId: 'kr_anything' })).rejects.toBeInstanceOf(
      HttpError,
    )
  })
})

describe('attempt.updated', () => {
  test('is built from the committed row and validates against the stream contract', () => {
    seedWorld()
    const drafts = attemptUpdates(db.sqlite, [
      'kr_00000000-0000-4000-8000-000000000004',
      'kr_00000000-0000-4000-8000-000000000004',
      'kr_unknown',
    ])
    expect(drafts).toHaveLength(1)
    const event = StreamEventSchema.parse({ seq: 1, ts: iso('12:00'), ...drafts[0] })
    expect(event.type).toBe('attempt.updated')
  })
})
