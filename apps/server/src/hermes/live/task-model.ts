import {
  TaskDetailSchema,
  AgentIdSchema,
  type TaskColumn,
  type TaskDetail,
  type TaskActivity,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { parseSteps } from '../../domain/steps.ts'
import { redact, redactValue } from '../../redact.ts'
import { HttpError } from '../../errors.ts'
import {
  readTaskBoard,
  readTaskComments,
  readTaskEvents,
  readTaskLinks,
  readTaskRuns,
  type TaskEvent,
  readLatestReviewEvent,
} from './kanban.ts'

export function taskColumn(status: string): TaskColumn | null {
  switch (status) {
    case 'triage':
    case 'todo':
    case 'scheduled':
    case 'ready':
      return 'planned'
    case 'running':
      return 'working'
    case 'review':
      return 'in_review'
    case 'blocked':
      return 'needs_you'
    case 'done':
      return 'done'
    case 'archived':
      return null
    default:
      throw new HttpError(502, 'hermes_unavailable', 'Unknown task status')
  }
}

export function eventActivity(event: TaskEvent): TaskActivity {
  const payload = z
    .object({
      text: z.string().optional(),
      reason: z.string().optional(),
      summary: z.string().optional(),
      author: z.string().optional(),
      profile: z.string().optional(),
    })
    .safeParse(event.payload)
  const data = payload.success ? payload.data : undefined
  return {
    at: new Date(event.created_at * 1000).toISOString(),
    agentId: data?.author === 'score' ? 'you' : (data?.author ?? data?.profile ?? null),
    text: redact(data?.text ?? data?.reason ?? data?.summary ?? event.kind.replaceAll('_', ' ')),
  }
}

/**
 * `runIdsOf` replaces the per-task read of Hermes's whole attempt history (task_runs); the attempts projection supplies
 * the ids from Score's own bounded tables instead (5.17a-1).
 */
export function readTaskDetails(
  db: DatabaseSync,
  now = Date.now(),
  runIdsOf?: (taskId: string) => string[],
): TaskDetail[] {
  const tasks = readTaskBoard(db)
  if (tasks.malformed) throw new HttpError(502, 'hermes_unavailable', 'Task data unavailable')
  return tasks.rows.map((task) => {
    const input = { taskIds: [task.id] }
    const links = readTaskLinks(db, input)
    const runs = runIdsOf ? undefined : readTaskRuns(db, input)
    const comments = readTaskComments(db, input)
    const events = readTaskEvents(db, task.id)
    if ([links, runs, comments, events].some((batch) => batch?.malformed))
      throw new HttpError(502, 'hermes_unavailable', 'Task detail unavailable')
    const body = redact(task.body ?? '')
    const steps = parseSteps(task.body ?? '').map((step) => ({ ...step, text: redact(step.text) }))
    const column = taskColumn(task.status) ?? 'done'
    const activity = [
      ...events.rows.filter((event) => event.kind !== 'comment').map(eventActivity),
      ...comments.rows.map((comment) => ({
        at: new Date(comment.created_at * 1000).toISOString(),
        agentId: comment.author === 'score' ? 'you' : comment.author,
        text: redact(comment.body),
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 50)
    const updatedAt = new Date(
      Math.max(
        task.created_at,
        task.started_at ?? 0,
        task.completed_at ?? 0,
        ...events.rows.map((event) => event.created_at),
        ...comments.rows.map((comment) => comment.created_at),
      ) * 1000,
    ).toISOString()
    // Hermes records the reviewer on both review events (kanban_db request_review / request_changes);
    // the newest one wins. Events are newest first, so this is a plain find, not findLast.
    const latestReview = readLatestReviewEvent(db, task.id)
    const reviewEvent =
      latestReview.rows[0] ??
      events.rows.find((event) => ['review_requested', 'changes_requested'].includes(event.kind))
    const named = z
      .object({
        reviewer: AgentIdSchema.nullish(),
        author: AgentIdSchema.optional(),
        profile: AgentIdSchema.optional(),
      })
      .safeParse(reviewEvent?.payload)
    const fallback =
      reviewEvent?.kind === 'changes_requested'
        ? named.success
          ? (named.data.author ?? named.data.profile)
          : undefined
        : undefined
    // The task may be reassigned to its reviewer, so an explicit `reviewer` is kept even when it is the assignee.
    const reviewer =
      (named.success ? named.data.reviewer : undefined) ??
      (fallback && fallback !== task.assignee ? fallback : undefined)
    const needsInput = ['needs_input', 'capability'].includes(task.block_kind ?? '')
    return TaskDetailSchema.parse(
      redactValue({
        id: task.id,
        key: `T-${task.task_rowid}`,
        title: task.title,
        column,
        hermesStatus: task.status,
        assignee: task.assignee,
        reviewer: reviewer && reviewer !== 'score' && reviewer !== 'you' ? reviewer : null,
        roomId: null,
        badge:
          task.status === 'blocked'
            ? {
                kind: needsInput ? 'needs_you' : 'blocked',
                label: needsInput ? 'Needs your input' : 'Blocked',
              }
            : task.status === 'triage'
              ? { kind: 'triage', label: 'Triage' }
              : null,
        progress:
          column === 'working' && steps.length
            ? steps.filter((step) => step.done).length / steps.length
            : null,
        elapsedSec:
          task.started_at === null
            ? null
            : Math.max(0, Math.floor((task.completed_at ?? now / 1000) - task.started_at)),
        note: task.result,
        updatedAt,
        body,
        createdBy: task.created_by ?? 'unknown',
        steps,
        activity,
        pendingApproval: null,
        dependsOn: links.rows
          .filter((link) => link.child_id === task.id)
          .map((link) => link.parent_id),
        blocks: links.rows
          .filter((link) => link.parent_id === task.id)
          .map((link) => link.child_id),
        runIds: runIdsOf ? runIdsOf(task.id) : runs!.rows.map((run) => String(run.id)),
        completedAt:
          task.completed_at === null ? null : new Date(task.completed_at * 1000).toISOString(),
      }),
    )
  })
}
