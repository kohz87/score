import type { TaskSummary } from '@score/contract'
import { expect, test } from 'vitest'
import {
  boardColumn,
  elapsedLabel,
  filterTasks,
  groupTasks,
  progressPercent,
  roomChoices,
} from './bold-tasks-model.ts'

function task(id: string, patch: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    key: id.toUpperCase(),
    title: id,
    column: 'working',
    hermesStatus: 'running',
    assignee: 'builder',
    reviewer: null,
    roomId: null,
    badge: null,
    progress: null,
    elapsedSec: null,
    note: null,
    updatedAt: '2026-11-02T10:00:00.000Z',
    ...patch,
  }
}

test('a blocked task sits in Needs you; a finished one stays done', () => {
  expect(boardColumn(task('a', { badge: { kind: 'blocked', label: 'Stuck' } }))).toBe('needs_you')
  expect(boardColumn(task('b', { column: 'done', badge: { kind: 'blocked', label: 'x' } }))).toBe(
    'done',
  )
  expect(boardColumn(task('c', { column: 'in_review' }))).toBe('in_review')
})

test('columns list the newest change first', () => {
  const grouped = groupTasks([
    task('old', { updatedAt: '2026-11-01T10:00:00.000Z' }),
    task('new', { updatedAt: '2026-11-02T10:00:00.000Z' }),
  ])
  expect(grouped.working.map((item) => item.id)).toEqual(['new', 'old'])
})

test('filters by agent and room', () => {
  const tasks = [
    task('a', { assignee: 'builder', roomId: 'r1' }),
    task('b', { assignee: 'lead', roomId: 'r2' }),
  ]
  expect(filterTasks(tasks, { agent: 'lead', room: null }).map((item) => item.id)).toEqual(['b'])
  expect(filterTasks(tasks, { agent: null, room: 'r1' }).map((item) => item.id)).toEqual(['a'])
  expect(filterTasks(tasks, { agent: null, room: null })).toHaveLength(2)
})

test('the room filter needs two rooms', () => {
  expect(roomChoices([task('a', { roomId: 'r1' }), task('b', { roomId: null })])).toEqual([])
  expect(roomChoices([task('a', { roomId: 'r1' }), task('b', { roomId: 'r2' })])).toEqual([
    'r1',
    'r2',
  ])
})

test('elapsed time and progress read plainly', () => {
  expect(elapsedLabel(task('a', { elapsedSec: 840 }))).toBe('14 min')
  expect(elapsedLabel(task('b', { column: 'planned' }))).toBe('queued')
  expect(elapsedLabel(task('c'))).toBe('')
  expect(progressPercent(task('d', { progress: 0.6 }))).toBe(60)
  expect(progressPercent(task('e'))).toBeNull()
})
