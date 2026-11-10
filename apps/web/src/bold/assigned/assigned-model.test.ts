import { expect, test } from 'vitest'
import {
  assignedCounts,
  assignedNames,
  assignedTasks,
  nextInText,
  taskStateWords,
} from './assigned-model.ts'
import { assignedFixture, inHours, repeatingJob, task } from './assigned-test-data.ts'

test('assigned tasks are the agent’s open ones, newest first', () => {
  const tasks = [
    task({ id: 'old', title: 'Old', column: 'planned', updatedAt: '2026-11-09T09:00:00.000Z' }),
    task({ id: 'new', title: 'New', column: 'working', updatedAt: '2026-11-10T09:00:00.000Z' }),
    task({ id: 'done', title: 'Done', column: 'done' }),
    task({ id: 'other', title: 'Other', column: 'working', assignee: 'lead' }),
    task({ id: 'loose', title: 'Loose', column: 'planned', assignee: null }),
  ]
  expect(assignedTasks(tasks, 'builder').map((item) => item.id)).toEqual(['new', 'old'])
})

test('a blocked task reads as needs you, a working one as in progress', () => {
  expect(taskStateWords(task({ id: 'a', title: 'A', column: 'working' }))).toBe('in progress')
  expect(taskStateWords(task({ id: 'b', title: 'B', column: 'planned' }))).toBe('to do')
  expect(taskStateWords(task({ id: 'c', title: 'C', column: 'in_review' }))).toBe('in review')
  expect(
    taskStateWords(
      task({
        id: 'd',
        title: 'D',
        column: 'working',
        badge: { kind: 'blocked', label: 'Blocked' },
      }),
    ),
  ).toBe('needs you')
})

test('repeating counts jobs and recipe steps together; tasks count on their own', () => {
  const assigned = assignedFixture({
    repeating: [repeatingJob({ id: 'r1', title: 'Morning summary' })],
    recipeSteps: [
      { workflowId: 'wf-1', recipeName: 'Release notes', stepLabel: 'Draft', schedule: null },
    ],
  })
  expect(assignedCounts(assigned, [task({ id: 't', title: 'T', column: 'planned' })])).toEqual({
    repeating: 2,
    tasks: 1,
  })
  expect(assignedNames(assigned)).toEqual(['Morning summary', 'Release notes (Draft)'])
})

test('next fire time reads in hours, minutes or days; none when Hermes gave none', () => {
  const now = Date.parse('2026-11-10T08:00:00.000Z')
  expect(nextInText(null, now)).toBeNull()
  expect(nextInText('not a time', now)).toBeNull()
  expect(nextInText('2026-11-10T22:00:00.000Z', now)).toBe('next in 14 h')
  expect(nextInText('2026-11-10T08:30:00.000Z', now)).toBe('next in 30 min')
  expect(nextInText('2026-11-10T08:00:20.000Z', now)).toBe('next run due')
  expect(nextInText('2026-11-14T08:00:00.000Z', now)).toBe('next in 4 d')
  // The fixture helper stays in step with the formatter.
  expect(nextInText(inHours(3), Date.now())).toBe('next in 3 h')
})
