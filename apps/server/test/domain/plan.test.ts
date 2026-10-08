import { expect, test } from 'vitest'
import { orderedPlanSteps, parsePlanSteps, planPart } from '../../src/domain/plan.ts'

const agents = ['lead', 'builder', 'reviewer', 'designer']

test('only unchecked checklist lines naming one known agent become steps', () => {
  const text = [
    'Plan:',
    '- [ ] @builder Add the endpoint',
    '* [ ] Review the endpoint @reviewer',
    '- [x] @designer Already done',
    '- [ ] @nobody Unknown agent',
    '- [ ] No agent at all',
    '- [ ] @builder',
    '- [ ]  @designer   Sketch   the card, please',
    '1. [ ] @builder Numbered lists are not steps',
    '```',
    '- [ ] @builder Inside a fence',
    '```',
    '- [ ] email me@builder.example today',
  ].join('\n')
  expect(parsePlanSteps(text, agents)).toEqual([
    { agentId: 'builder', title: 'Add the endpoint' },
    { agentId: 'reviewer', title: 'Review the endpoint' },
    { agentId: 'designer', title: 'Sketch the card, please' },
  ])
})

test('a plan part groups steps into lanes and keeps their order in the block ids', () => {
  const steps = parsePlanSteps('- [ ] @builder A\n- [ ] @reviewer B\n- [ ] @builder C', agents)
  const part = planPart('brief-1', steps, '2026-10-08T10:00:00.000Z')!
  expect(part.lanes.map((lane) => [lane.agentId, lane.blocks.map((block) => block.id)])).toEqual([
    ['builder', ['plan:brief-1:0', 'plan:brief-1:2']],
    ['reviewer', ['plan:brief-1:1']],
  ])
  expect(part.lanes[0]!.blocks[0]).toMatchObject({ state: 'planned', taskId: null, runId: null })
  expect(orderedPlanSteps(part).map((step) => [step.index, step.agentId, step.title])).toEqual([
    [0, 'builder', 'A'],
    [1, 'reviewer', 'B'],
    [2, 'builder', 'C'],
  ])
  expect(planPart('brief-1', [], '2026-10-08T10:00:00.000Z')).toBeNull()
})

test('plans are capped', () => {
  const text = Array.from({ length: 80 }, (_, index) => `- [ ] @builder Step ${index}`).join('\n')
  expect(parsePlanSteps(text, agents)).toHaveLength(50)
})
