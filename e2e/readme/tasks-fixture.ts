import { TaskDetailSchema, TasksSnapshotSchema } from '../../packages/contract/src/index.ts'
import { fixtureNow } from '../now-fixture.ts'

// A fuller board than the e2e fixtures have, for the README picture: a few tasks in every column, all assigned to the
// neutral demo agents, and one drawer with steps, activity and an approval waiting.
const ago = (minutes: number) => new Date(Date.parse(fixtureNow) - minutes * 60_000).toISOString()

const task = (
  id: string,
  key: string,
  title: string,
  column: string,
  assignee: string,
  patch: Record<string, unknown> = {},
) => ({
  id,
  key,
  title,
  column,
  hermesStatus: column === 'done' ? 'done' : 'running',
  assignee,
  reviewer: 'reviewer',
  roomId: 'room-activity-feed',
  badge: null,
  progress: null,
  elapsedSec: 600,
  note: null,
  updatedAt: ago(3),
  ...patch,
})

const docs = task('task-docs', 'T-104', 'Publish the pagination notes', 'needs_you', 'designer', {
  badge: { kind: 'needs_you', label: 'Needs you' },
  note: 'Wants to install a package',
  elapsedSec: 95,
})

export const tasksFixture = TasksSnapshotSchema.parse({
  asOfSeq: 60,
  columns: {
    planned: [
      task('task-notes', 'T-106', 'Write the release notes', 'planned', 'lead', {
        badge: { kind: 'starts_after', label: 'Starts after T-105' },
        elapsedSec: null,
      }),
      task('task-empty', 'T-107', 'Empty and error states', 'planned', 'designer', {
        elapsedSec: null,
        note: 'Feed, search and the task board',
      }),
    ],
    working: [
      task('task-stream', 'T-105', 'Event stream reconnects', 'working', 'builder', {
        progress: 0.5,
        elapsedSec: 540,
        note: 'Resume from the last cursor',
      }),
    ],
    in_review: [
      task(
        'task-pagination',
        'T-103',
        'Add pagination to the activity feed',
        'in_review',
        'builder',
        {
          badge: { kind: 'changes_requested', label: 'Changes requested' },
          note: 'Newest items first, 25 per page',
          elapsedSec: 1260,
        },
      ),
    ],
    needs_you: [docs],
    done: [
      task('task-plan', 'T-101', 'Plan the activity feed', 'done', 'lead', { elapsedSec: 300 }),
      task('task-read', 'T-102', 'Read layer for task events', 'done', 'builder', {
        elapsedSec: 900,
      }),
    ],
  },
})

export const taskDetailFixture = TaskDetailSchema.parse({
  ...docs,
  body: 'Write up how the feed paginates, with a short example of the cursor, and publish it to the docs site.',
  createdBy: 'lead',
  steps: [
    { id: 's1', text: 'Draft the pagination notes', done: true },
    { id: 's2', text: 'Add the cursor example', done: true },
    { id: 's3', text: 'Install the docs generator', done: false },
    { id: 's4', text: 'Publish to the docs site', done: false },
  ],
  activity: [
    { at: ago(8), agentId: 'lead', text: 'Created the task and assigned it to designer' },
    { at: ago(5), agentId: 'designer', text: 'Drafted the notes and the cursor example' },
    { at: ago(2), agentId: 'designer', text: 'Asked to install the docs generator' },
  ],
  pendingApproval: {
    id: 'approval-docs',
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'designer',
    title: 'May I install the docs generator?',
    command: 'pnpm add -D typedoc@0.28.0',
    cwd: null,
    description: 'May I install the docs generator?',
    choices: ['once', 'session', 'always', 'deny'],
    createdAt: ago(2),
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: 'Only this command is waiting; the rest of the team can continue.',
    refs: [{ kind: 'task', taskId: 'task-docs' }],
  },
  dependsOn: [],
  blocks: [],
  runIds: [],
})
