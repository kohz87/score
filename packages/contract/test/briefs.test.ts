import { expect, test } from 'vitest'
import { BriefSummarySchema, PlanStartResponseSchema } from '../src/index.ts'
import * as f from './fixtures.ts'

test('brief summaries accept the four derived statuses and reject others', () => {
  for (const status of ['running', 'paused', 'done', 'failed'])
    expect(BriefSummarySchema.parse({ ...f.brief, status }).status).toBe(status)
  expect(BriefSummarySchema.safeParse({ ...f.brief, status: 'queued' }).success).toBe(false)
  expect(BriefSummarySchema.safeParse({ ...f.brief, startedBy: '' }).success).toBe(false)
})

test('plan start responses parse', () => {
  expect(PlanStartResponseSchema.parse({ briefId: 'b', taskIds: ['t'] }).taskIds).toEqual(['t'])
})
