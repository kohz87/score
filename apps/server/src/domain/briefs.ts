// Briefs (design review 3.4): a human room message plus what it causes. Links to tasks are exact only; nothing
// here guesses from timing.

export { BriefRowSchema, type BriefRow, type BriefTaskOrigin, type TurnRow } from './brief-types.ts'
export {
  ACTIVE_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
  briefLastEnd,
  briefSummary,
  deriveBriefStatus,
  emitBriefChange,
  listBriefs,
  newestFirst,
  taskFailed,
} from './brief-status.ts'
export {
  actionableBriefTasks,
  briefTaskIds,
  briefTasks,
  briefTitle,
  briefTurns,
  projectedDetail,
  readBriefRow,
  requireBrief,
  taskStatus,
} from './brief-queries.ts'
export { createBrief, linkTask, linkTasks, recordEdge } from './brief-links.ts'
export { deriveBriefEvents } from './brief-events.ts'
