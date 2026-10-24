import type { AgentSummary, Message, OutsideSession } from '@score/contract'
import { useMemo, useRef } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import {
  newBringOutsideSessionAttempt,
  useBringOutsideSessionIntoJob,
  usePreviewOutsideSession,
  type BringOutsideSessionAttempt,
} from '../../data/outside-job.ts'
import { roomJobsQuery, teamRoomQuery } from './room-queries.ts'

function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function textOf(message: Message): string {
  return message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
}

/** One of the agents' own chats (PLAN 11.4d): read-only in Hermes, until the person brings it into a team job. */
export function BoldElsewhere({
  session,
  agents,
  onBroughtIn,
}: {
  session: OutsideSession
  agents: AgentSummary[]
  onBroughtIn: (jobId: string) => void
}) {
  const teamDefinition = useMemo(() => teamRoomQuery(null), [])
  const team = useStreamQuery(teamDefinition).data?.room
  // The new job reaches the tabs through the stream; a re-read covers a stream that is reconnecting.
  const jobsDefinition = useMemo(() => roomJobsQuery(team?.id ?? ''), [team?.id])
  const refetchJobs = useStreamQueryRefetch(jobsDefinition)
  const preview = usePreviewOutsideSession()
  const bring = useBringOutsideSessionIntoJob()
  const attempt = useRef<BringOutsideSessionAttempt | null>(null)
  const agent = agents.find((item) => item.id === session.agentId)
  const title = session.title.trim() || 'Untitled session'
  const source = session.sourceLabel
  const nameOf = ({ author }: Message) => {
    if (author.kind === 'you') return 'You'
    const { agentId } = author
    return agents.find((item) => item.id === agentId)?.name ?? agentId
  }
  const previewed = preview.data

  return (
    <div className="sidebody bold-elsewhere">
      <span className="note bold-elsewhere-note" data-protected="any">
        From {source} · read-only. Reply there, or bring it into a job.
      </span>
      <div className="bold-elsewhere-title">
        <span className="small muted">
          <b>{agent?.name ?? session.agentId}</b> · {source}
        </span>
        <h2>{title}</h2>
        <span className="small muted">
          {session.messageCount} {session.messageCount === 1 ? 'message' : 'messages'} · started{' '}
          {when(session.startedAt)}
          {session.busy ? ' · active now' : ''}
        </span>
      </div>
      <div className="card bold-elsewhere-card">
        <b>
          This conversation stays with {agent?.name ?? session.agentId} in {source}.
        </b>
        <span>
          Score can copy its text into a team job, but it can’t reply in {source} or change the
          original chat.
        </span>
      </div>
      {previewed ? (
        <div className="bold-elsewhere-preview" aria-label="Conversation preview">
          <span className="small muted bold-elsewhere-preview-label">
            Read-only preview · imported from {source}
          </span>
          {previewed.messages.length === 0 ? (
            <p className="small muted">This chat has no text to copy.</p>
          ) : (
            <ol className="bold-elsewhere-messages">
              {previewed.messages.map((message) => {
                const author = nameOf(message)
                return message.author.kind === 'you' ? (
                  <li key={message.id} className="bold-elsewhere-mine">
                    <p className="bold-elsewhere-bub">{textOf(message)}</p>
                    <span className="small muted">You</span>
                  </li>
                ) : (
                  <li key={message.id} className="bold-elsewhere-theirs">
                    {agent && <AgentGlyph agent={agent} size="sm" plain bare decorative />}
                    <div>
                      <span className="small muted">{author}</span>
                      <p className="bold-elsewhere-bub">{textOf(message)}</p>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      ) : (
        <div className="row wrap bold-elsewhere-actions">
          <button
            type="button"
            className="btn primary"
            disabled={preview.isPending}
            onClick={() => preview.mutate(session)}
          >
            {preview.isPending ? 'Previewing…' : 'Preview this chat'}
          </button>
          <span className="small muted">
            Previewing adds an “Imported from {source}” room in Score. Hermes isn’t changed.
          </span>
        </div>
      )}
      {previewed && (
        <div className="row wrap bold-elsewhere-actions">
          <button
            type="button"
            className="btn primary"
            disabled={!team || bring.isPending}
            onClick={() => {
              if (!team) return
              const current = attempt.current ?? newBringOutsideSessionAttempt(previewed.roomId)
              attempt.current = current
              bring.mutate(
                { session, teamRoomId: team.id, attempt: current },
                {
                  onSuccess: ({ job }) => {
                    attempt.current = null
                    void refetchJobs()
                    onBroughtIn(job.id)
                  },
                },
              )
            }}
          >
            {bring.isPending ? 'Bringing it in…' : 'Bring into a job'}
          </button>
          <span className="small muted">
            Starts “{title}” in the team room with these messages attached. It also keeps the
            “Imported from {source}” room in Score.
          </span>
        </div>
      )}
      {preview.isError && (
        <p className="bold-request-error" role="alert">
          Couldn’t preview this chat. Try again.
        </p>
      )}
      {bring.isError && (
        <p className="bold-request-error" role="alert">
          Couldn’t bring this chat into a job. Try again: the job and messages already copied are
          kept.
        </p>
      )}
    </div>
  )
}
