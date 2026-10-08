import { expect, test } from 'vitest'
import {
  BriefFlowSchema,
  BriefLogPageSchema,
  BriefSummarySchema,
  FlowNodeDetailSchema,
  PlanStartResponseSchema,
} from '../src/index.ts'
import * as f from './fixtures.ts'

const node = {
  id: 'task:t_1',
  kind: 'step',
  title: 'Build',
  agentId: 'builder',
  state: 'working',
  subtitle: 'builder',
  taskId: 't_1',
  layout: { col: 1, row: 0 },
} as const

test('brief summaries accept the four derived statuses and reject others', () => {
  for (const status of ['running', 'paused', 'done', 'failed'])
    expect(BriefSummarySchema.parse({ ...f.brief, status }).status).toBe(status)
  expect(BriefSummarySchema.safeParse({ ...f.brief, status: 'queued' }).success).toBe(false)
  expect(BriefSummarySchema.safeParse({ ...f.brief, startedBy: '' }).success).toBe(false)
})

test('a flow carries nodes, typed edges and stats, capped at 200 nodes', () => {
  const flow = {
    asOfSeq: 3,
    brief: f.brief,
    nodes: [node],
    edges: [{ id: 'e1', from: 'brief:brief-1', to: node.id, kind: 'planned', label: null }],
    stats: { runningSec: 12, steps: 1, handoffs: 0, spendUsd: null, eta: null },
  }
  expect(BriefFlowSchema.parse(flow)).toEqual(flow)
  for (const kind of ['flow', 'handoff', 'review', 'sent_back', 'planned'])
    expect(
      BriefFlowSchema.safeParse({ ...flow, edges: [{ ...flow.edges[0], kind }] }).success,
    ).toBe(true)
  expect(
    BriefFlowSchema.safeParse({ ...flow, edges: [{ ...flow.edges[0], kind: 'other' }] }).success,
  ).toBe(false)
  expect(
    BriefFlowSchema.safeParse({ ...flow, nodes: Array.from({ length: 201 }, () => node) }).success,
  ).toBe(false)
})

test('node detail, log page and plan start responses parse', () => {
  expect(
    FlowNodeDetailSchema.parse({
      node,
      description: '',
      steps: [],
      approval: null,
      run: null,
      model: null,
      tools: [],
      watch: null,
    }).node.id,
  ).toBe('task:t_1')
  expect(BriefLogPageSchema.parse({ items: [f.log], nextCursor: null }).items).toHaveLength(1)
  expect(PlanStartResponseSchema.parse({ briefId: 'b', taskIds: ['t'] }).taskIds).toEqual(['t'])
})
