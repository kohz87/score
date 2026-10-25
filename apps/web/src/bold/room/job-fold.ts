import type { Job, Message } from '@score/contract'
import { reportBackWaiting } from './room-model.ts'

const KEY = 'score.room.expandedJobs'

/** Finished jobs the person has opened in this session; a finished job is collapsed until then. */
export function readExpandedJobs(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]')
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

export function writeExpandedJobs(ids: ReadonlySet<string>) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...ids]))
  } catch {
    // Storage can be blocked; the choice then only lasts while the room is open.
  }
}

export function isFinishedJob(job: Job): boolean {
  return !job.isDefault && (job.state === 'done' || job.state === 'closed')
}

/**
 * Jobs the stream folds into one row: finished, not opened this session, and holding nothing the person must see.
 * A pinned message, an approval waiting in Needs you, a result waiting to be sent back or the message being sought
 * keeps the whole job expanded.
 */
export function foldedJobIds({
  jobs,
  messages,
  expanded,
  isPinned,
  approvalPointerIds,
  seek,
}: {
  jobs: readonly Job[]
  messages: readonly Message[]
  expanded: ReadonlySet<string>
  isPinned: (messageId: string) => boolean
  approvalPointerIds: ReadonlySet<string>
  seek: string | null
}): Set<string> {
  const waiting = new Set(reportBackWaiting([...jobs]).map((job) => job.id))
  const folded = new Set(
    jobs
      .filter((job) => isFinishedJob(job) && !expanded.has(job.id) && !waiting.has(job.id))
      .map((job) => job.id),
  )
  for (const message of messages) {
    if (!message.jobId || !folded.has(message.jobId)) continue
    const needsYou = message.parts.some(
      (part) => part.kind === 'approval' && approvalPointerIds.has(part.approvalId),
    )
    if (needsYou || isPinned(message.id) || message.id === seek) folded.delete(message.jobId)
  }
  return folded
}
