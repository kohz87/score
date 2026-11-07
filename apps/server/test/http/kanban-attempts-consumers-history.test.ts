import { AgentHistoryPageSchema } from '@score/contract'
import { describe, expect, test } from 'vitest'
import { withFlag } from '../helpers/kanban-attempts-seed.ts'
import {
  body,
  seedWorld,
  setupKanbanAttemptsConsumersTest,
} from './kanban-attempts-consumers-helpers.ts'

setupKanbanAttemptsConsumersTest()

describe('Team history', () => {
  test('attempts are listed under their agent with their outcome; an earlier board has no task link', async () => {
    seedWorld()
    withFlag(true)
    const page = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/builder/history')).text),
    )
    const attempts = page.items.filter((item) => item.attempt)
    // Newest first; the ancestral copy (9) is not listed twice.
    expect(attempts.map((item) => item.attempt!.order[1])).toEqual([8, 10, 3, 1, 7])
    const byNumber = new Map(attempts.map((item) => [item.attempt!.order[1], item]))
    expect(byNumber.get(1)).toMatchObject({
      origin: 'kanban',
      outcome: 'completed',
      title: 'Done work',
      task: { id: 't-done', title: 'Done work' },
      brief: { id: 'brief-1' },
      replaySeq: null,
      durationSec: 1800,
    })
    // From an earlier copy of the board the task is not linked; the row still opens its attempt.
    expect(byNumber.get(10)).toMatchObject({ task: null, brief: null })
    // Not observed to the end: not a "running" or "completed" row.
    expect(byNumber.get(8)!.outcome).toBe('unknown')
    // Newest first.
    const times = page.items.map((item) => Date.parse(item.startedAt))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    const reviewer = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/reviewer/history')).text),
    )
    expect(reviewer.items.map((item) => item.attempt?.status)).toEqual([
      'completed',
      'changes_requested',
    ])
  })

  test('outcome and text filters apply to attempts', async () => {
    seedWorld()
    withFlag(true)
    const failed = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/reviewer/history?outcome=failed')).text),
    )
    expect(failed.items).toEqual([])
    const found = AgentHistoryPageSchema.parse(
      JSON.parse((await body('/api/agents/reviewer/history?q=done%20work')).text),
    )
    expect(found.items).toHaveLength(2)
  })
})
