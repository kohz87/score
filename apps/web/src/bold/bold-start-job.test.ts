import { WorkflowDefinitionSchema } from '@score/contract'
import { expect, test } from 'vitest'
import {
  deadlineIso,
  oneStepRecipe,
  orchestrationPolicy,
  orchestrationTitleOf,
  scheduleLabel,
  scheduleValue,
  titleOf,
  triggerNameOf,
  triggerRequest,
  workflowPolicy,
} from './bold-start-job.ts'

test('titles come from the first line and stay inside the contract limits', () => {
  expect(titleOf('  Write the notes\nand the image  ')).toBe('Write the notes')
  expect(titleOf('   ')).toBe('New job')
  expect(titleOf('x'.repeat(300))).toHaveLength(200)
  expect(orchestrationTitleOf('y'.repeat(300))).toHaveLength(120)
  expect(triggerNameOf('', 'Queue the research')).toBe('Queue the research')
  expect(triggerNameOf(' ', 'Queue the research')).toBe('Queue the research')
  expect(triggerNameOf('z'.repeat(200), 'Ignored')).toHaveLength(100)
})

test('a datetime-local deadline becomes an ISO instant; empty or unreadable means no deadline', () => {
  expect(deadlineIso('2026-10-24T18:00')).toBe(new Date('2026-10-24T18:00').toISOString())
  expect(deadlineIso('2026-10-25T09:30')).toBe(new Date('2026-10-25T09:30').toISOString())
  expect(deadlineIso('')).toBeUndefined()
  expect(deadlineIso('not a date')).toBeUndefined()
})

test('schedule labels send values the Hermes scheduler accepts, and values show as labels', () => {
  expect(scheduleValue('Every weekday at 9:00')).toBe('0 9 * * 1-5')
  expect(scheduleValue('Every Monday at 9:00')).toBe('0 9 * * 1')
  expect(scheduleValue('Every hour')).toBe('every 1h')
  expect(scheduleValue('0 7 * * *')).toBe('0 7 * * *')
  expect(scheduleLabel('0 9 * * 1-5')).toBe('Every weekday at 9:00')
  expect(scheduleLabel('0 9 * * 1')).toBe('Every Monday at 9:00')
  expect(scheduleLabel('every 1h')).toBe('Every hour')
  expect(scheduleLabel('0 7 * * *')).toBe('0 7 * * *')
})

test('the three ask choices map onto the orchestration and workflow gate policies', () => {
  expect(orchestrationPolicy('plan')).toBe('every-step')
  expect(orchestrationPolicy('handoff')).toBe('lead-asks')
  expect(orchestrationPolicy('risky')).toBe('none')
  expect(workflowPolicy('plan')).toBe('every-step')
  expect(workflowPolicy('handoff')).toBe('gates-only')
  expect(workflowPolicy('risky')).toBe('gates-only')
})

test('a one-step recipe is a valid workflow from its agent to its end', () => {
  const recipe = WorkflowDefinitionSchema.parse(
    oneStepRecipe({
      name: '  Release notes  ',
      instruction: 'Write the release notes.',
      agentId: 'builder',
    }),
  )
  expect(recipe).toMatchObject({
    name: 'Release notes',
    description: 'Saved from Start a job.',
    inputs: [],
  })
  expect(recipe.nodes).toEqual([
    {
      id: 'work',
      kind: 'agent',
      label: 'Do the work',
      agentId: 'builder',
      instruction: 'Write the release notes.',
      retries: 0,
      onFailure: 'fail_run',
    },
    { id: 'done', kind: 'end', label: 'Done' },
  ])
  expect(recipe.edges).toEqual([{ id: 'work_done', from: 'work', port: 'ok', to: 'done' }])
  expect(oneStepRecipe({ name: '', instruction: '', agentId: 'lead' })).toMatchObject({
    name: 'Saved from Start a job',
    nodes: [expect.objectContaining({ instruction: 'Do the work.' }), expect.anything()],
  })
})

test('a webhook request maps the call fields and redacts nothing into the template', () => {
  expect(triggerRequest({ name: 'New ticket', app: ' Tickets ', what: 'Write the notes' })).toEqual(
    {
      name: 'New ticket',
      app: 'Tickets',
      mapping: { ref: 'ref', title: 'title', link: 'link', details: 'details' },
      template: 'Write the notes',
      reportBack: { mode: 'off' },
    },
  )
  expect(triggerRequest({ name: '', app: '', what: '  ' })).toMatchObject({
    name: 'New job',
    app: 'Another app',
    template: 'Do the work.',
  })
})
