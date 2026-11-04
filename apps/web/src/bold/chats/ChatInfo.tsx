import type { AgentSummary, Job, Room } from '@score/contract'
import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood } from '../bold-agents.ts'
import { jobDot } from '../room/job-dot.ts'
import { jobStateLabel } from '../room/room-model.ts'
import { useStartJob } from '../BoldStartJob.tsx'
import { useSharedWorkspaces } from '../workspaces-queries.ts'
import { currentTopic } from './chat-model.ts'
import { runTopicCommand } from '../room/topic-commands.ts'
import { TopicInfo } from './TopicInfo.tsx'
import { FilesAndResults } from './FilesResults.tsx'

function topicLink(room: Room, job: Pick<Job, 'id'>, everyone: boolean): string {
  const params = new URLSearchParams()
  if (!everyone) params.set('room', room.id)
  params.set('job', job.id)
  return `/b?${params}`
}

/** 3.24.0: "New topic" in Info, the same as `/new <title>` in the composer (the old All topics screen is gone). */
function NewTopic({
  room,
  agents,
  jobs,
  everyone,
  onNavigate,
}: {
  room: Room
  agents: AgentSummary[]
  jobs: Job[]
  everyone: boolean
  onNavigate?: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const inputId = useId()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await runTopicCommand('new', title, {
        room,
        agents,
        jobs,
        current: undefined,
        workspaces: [],
        queryClient,
        pick: (jobId) => {
          if (jobId) void navigate(topicLink(room, { id: jobId }, everyone), { replace: true })
        },
        say: () => undefined,
      })
      setTitle('')
      onNavigate?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Couldn’t start the topic. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="bold-chat-new-topic"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label className="bold-chat-note" htmlFor={inputId}>
        Topic title
      </label>
      <div className="bold-chat-new-topic-row">
        <input
          id={inputId}
          type="text"
          maxLength={200}
          value={title}
          placeholder="What is it about?"
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" className="btn sm" disabled={busy || title.trim() === ''}>
          {busy ? 'Starting…' : 'New topic'}
        </button>
      </div>
      {error && (
        <p className="bold-chat-note" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function TopicRow({
  room,
  job,
  everyone,
  onNavigate,
}: {
  room: Room
  job: Job
  everyone: boolean
  onNavigate?: () => void
}) {
  return (
    <li>
      <Link to={topicLink(room, job, everyone)} onClick={onNavigate}>
        {job.state === 'done' || job.state === 'closed' ? (
          <span className="bold-chat-check" role="img" aria-label={jobStateLabel(job)}>
            ✓
          </span>
        ) : (
          <span
            className="bold-job-dot"
            role="img"
            aria-label={jobStateLabel(job)}
            style={{ background: jobDot(job.state) }}
          />
        )}
        <span className="bold-chat-topic-title">{job.title}</span>
        {job.unread > 0 && (
          <span className="bold-unread" aria-label={`${job.unread} unread`}>
            {job.unread > 99 ? '99+' : job.unread}
          </span>
        )}
      </Link>
    </li>
  )
}

/** The side panel's Info tab (3.21.0): members, the chat's workspace and its jobs as Topics. */
export function ChatInfo({
  room,
  agents,
  jobs,
  everyone,
  phone = false,
  onNavigate,
}: {
  room: Room | null
  agents: AgentSummary[]
  jobs: Job[]
  everyone: boolean
  /** On a phone the Info sheet is also the way to Start a job (the composer's + menu has it on a desktop too). */
  phone?: boolean
  /** A link or button here leaves the sheet (the phone closes it). */
  onNavigate?: () => void
}) {
  const workspaces = useSharedWorkspaces(Boolean(room?.workspaceId)).data
  const startJob = useStartJob()
  const [params] = useSearchParams()
  if (!room)
    return (
      <div className="sidebody bold-chat-info">
        <p className="bold-chat-note">Open a group chat to see who is in it.</p>
      </div>
    )
  const workspace = room.workspaceId
    ? workspaces?.find((item) => item.id === room.workspaceId)
    : undefined
  const topics = jobs.filter((job) => !job.isDefault)
  const closedTopics = topics.filter((job) => job.state === 'closed')
  const openTopics = topics.filter((job) => job.state !== 'closed')
  const current = currentTopic(jobs, params.get('job'))
  return (
    <div className="sidebody bold-chat-info" aria-label={`${room.name}, chat info`}>
      <section aria-labelledby="chat-info-members">
        <h2 id="chat-info-members" className="bold-chat-kicker">
          Members
        </h2>
        <ul className="bold-chat-members">
          {room.members.map((id) => {
            const agent = agents.find((item) => item.id === id)
            return (
              <li key={id}>
                {agent && (
                  <AgentGlyph agent={agent} size="sm" bare decorative mood={agentMood(agent)} />
                )}
                <span>{agent ? agentDisplayName(agent) : id}</span>
                {room.leadAgentId === id && <span className="bold-chat-role">owner</span>}
              </li>
            )
          })}
        </ul>
        {!room.leadAgentId && <p className="bold-chat-note">No owner yet.</p>}
      </section>
      <section aria-labelledby="chat-info-workspace">
        <h2 id="chat-info-workspace" className="bold-chat-kicker">
          Workspace
        </h2>
        {room.workspaceId ? (
          <code>{workspace ? `${workspace.name} · ${workspace.path}` : room.workspaceId}</code>
        ) : (
          <p className="bold-chat-note">None set.</p>
        )}
      </section>
      {current && !current.isDefault && (
        <TopicInfo roomId={room.id} job={current} agents={agents} />
      )}
      <FilesAndResults jobId={current?.id ?? null} agents={agents} />
      <section aria-labelledby="chat-info-topics">
        <h2 id="chat-info-topics" className="bold-chat-kicker" tabIndex={-1}>
          Topics
        </h2>
        {topics.length === 0 ? (
          <p className="bold-chat-note">Nothing yet.</p>
        ) : (
          <>
            <ul className="bold-chat-topics">
              {openTopics.map((job) => (
                <TopicRow
                  key={job.id}
                  room={room}
                  job={job}
                  everyone={everyone}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
            {closedTopics.length > 0 &&
              (closedTopics.length > 3 ? (
                <details className="bold-chat-closed">
                  <summary>Closed topics ({closedTopics.length})</summary>
                  <ul className="bold-chat-topics">
                    {closedTopics.map((job) => (
                      <TopicRow
                        key={job.id}
                        room={room}
                        job={job}
                        everyone={everyone}
                        onNavigate={onNavigate}
                      />
                    ))}
                  </ul>
                </details>
              ) : (
                <ul className="bold-chat-topics">
                  {closedTopics.map((job) => (
                    <TopicRow
                      key={job.id}
                      room={room}
                      job={job}
                      everyone={everyone}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              ))}
          </>
        )}
        <NewTopic
          room={room}
          agents={agents}
          jobs={jobs}
          everyone={everyone}
          onNavigate={onNavigate}
        />
        {phone && room.role === 'team' && (
          <div className="bold-chat-jobs-actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                onNavigate?.()
                startJob?.openStartJob({ roomId: room.id })
              }}
            >
              Start a job
            </button>
          </div>
        )}
      </section>
      <Link className="bold-chat-knowledge" to="/b/knowledge" onClick={onNavigate}>
        Open Knowledge
      </Link>
    </div>
  )
}
