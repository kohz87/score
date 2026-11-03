import type { AgentSummary, Job, Room } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood } from '../bold-agents.ts'
import { jobDot } from '../room/RoomTabs.tsx'
import { jobStateLabel } from '../room/room-model.ts'
import { useStartJob } from '../BoldStartJob.tsx'
import { useSharedWorkspaces } from '../workspaces-queries.ts'

function topicLink(room: Room, job: Job, everyone: boolean): string {
  const params = new URLSearchParams()
  if (!everyone) params.set('room', room.id)
  params.set('job', job.id)
  return `/b?${params}`
}

function jobsLink(room: Room, everyone: boolean): string {
  const params = new URLSearchParams()
  if (!everyone) params.set('room', room.id)
  params.set('jobs', '1')
  return `/b?${params}`
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
  /** On a phone the Info sheet is also the way to the job list and to Start a job (stage 2 turns jobs into topics). */
  phone?: boolean
  /** A link or button here leaves the sheet (the phone closes it). */
  onNavigate?: () => void
}) {
  const workspaces = useSharedWorkspaces(Boolean(room?.workspaceId)).data
  const startJob = useStartJob()
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
      <section aria-labelledby="chat-info-topics">
        <h2 id="chat-info-topics" className="bold-chat-kicker">
          Topics
        </h2>
        {topics.length === 0 ? (
          <p className="bold-chat-note">Nothing yet.</p>
        ) : (
          <ul className="bold-chat-topics">
            {topics.map((job) => (
              <li key={job.id}>
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
                </Link>
              </li>
            ))}
          </ul>
        )}
        {phone && (
          <div className="bold-chat-jobs-actions">
            <Link className="btn sm" to={jobsLink(room, everyone)} onClick={onNavigate}>
              All topics
            </Link>
            {room.role === 'team' && (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  onNavigate?.()
                  startJob?.openStartJob()
                }}
              >
                Start a job
              </button>
            )}
          </div>
        )}
      </section>
      <Link className="bold-chat-knowledge" to="/b/knowledge" onClick={onNavigate}>
        Open Knowledge
      </Link>
    </div>
  )
}
