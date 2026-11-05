import type { Job, Message } from '@score/contract'
import type { ReactNode } from 'react'
import { jobStateLabel } from './room-model.ts'

/** A small line the chat shows for what a command changed ("You made builder the owner"). Local to this tab. */
export type SystemLine = { id: string; at: string; text: string }

/** What a divider says about a topic: its state in the words the mock-up uses. */
export function topicStateText(job: Job): string {
  return job.needsYou ? 'needs you' : jobStateLabel(job).toLowerCase()
}

/**
 * Where the dividers go. A divider opens a topic where its first loaded message is (and a topic nobody has written in
 * yet at its creation time); returning to another topic, or to the general conversation, is marked too so a message
 * is never read as part of the wrong topic. The general conversation (the default job) has no divider before its
 * first message.
 */
export type DividerAt = { job: Job | null; again: boolean }
export function topicDividers(jobs: Job[], messages: Message[]): Map<string, DividerAt> {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const defaultId = jobs.find((job) => job.isDefault)?.id ?? null
  const plan = new Map<string, DividerAt>()
  const shown = new Set<string>()
  let current: string | null | undefined
  for (const message of messages) {
    const jobId = message.jobId ?? defaultId
    if (jobId !== current) {
      const job = jobId ? byId.get(jobId) : undefined
      if (job && !job.isDefault) {
        plan.set(message.id, { job, again: shown.has(job.id) })
        shown.add(job.id)
      } else if (current !== undefined) {
        // Back in the general conversation after a topic.
        plan.set(message.id, { job: null, again: false })
      }
      current = jobId
    }
  }
  return plan
}

/** Topics with nothing loaded and nothing said at all yet (just made with /new): their divider sits at creation time. */
export function emptyTopics(jobs: Job[], messages: Message[]): Job[] {
  const seen = new Set(messages.map((message) => message.jobId))
  return jobs.filter((job) => !job.isDefault && job.messageCount === 0 && !seen.has(job.id))
}

/** Where a job's messages start when the chat shows no divider (one job per chat): only the scroll target remains. */
export function TopicAnchor({ job }: { job: Job }) {
  return (
    <span
      className="bold-topic-anchor"
      id={`topic-${job.id}`}
      data-topic-id={job.id}
      aria-hidden="true"
    />
  )
}

export function TopicDivider({
  job,
  again = false,
  menu,
}: {
  /** The topic, or null for "back to the general conversation". */
  job: Job | null
  again?: boolean
  menu?: ReactNode
}) {
  return (
    <div
      className={`bold-topic-divider${job ? '' : ' is-general'}`}
      id={job ? `topic-${job.id}` : undefined}
      data-topic-id={job?.id}
      role="separator"
      aria-label={job ? `Topic: ${job.title}, ${topicStateText(job)}` : 'General conversation'}
    >
      <span className="bold-topic-rule" aria-hidden="true" />
      <span className="bold-topic-text">
        {job ? (
          <>
            {again ? 'Back to topic' : 'Topic'} · <strong>{job.title}</strong> ·{' '}
            <span className={`bold-topic-state is-${job.state}`}>{topicStateText(job)}</span>
          </>
        ) : (
          <strong>General conversation</strong>
        )}
      </span>
      {menu}
      <span className="bold-topic-rule" aria-hidden="true" />
    </div>
  )
}

export function SystemLineRow({ line }: { line: SystemLine }) {
  return (
    <p className="bold-system-line" role="status" data-system-line={line.id}>
      {line.text}
    </p>
  )
}
