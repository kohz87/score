import type { AgentSummary, Job, Room } from '@score/contract'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood } from '../bold-agents.ts'
import { jobDot } from '../room/job-dot.ts'
import { activeJobs, holdsSeveralJobs, jobStateLabel } from '../room/room-model.ts'
import { useStartJob } from '../BoldStartJob.tsx'
import { useSharedWorkspaces } from '../workspaces-queries.ts'
import { currentTopic } from './chat-model.ts'
import { TopicInfo } from './TopicInfo.tsx'
import { InfoSection } from './InfoSection.tsx'
import { FilesAndResults } from './FilesResults.tsx'
import { SubagentsInfo } from '../subagents/SubagentsInfo.tsx'

function topicLink(room: Room, job: Pick<Job, 'id'>, everyone: boolean): string {
  const params = new URLSearchParams()
  if (!everyone) params.set('room', room.id)
  params.set('job', job.id)
  return `/b?${params}`
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
            style={{ background: jobDot(job.state, job.needsYou) }}
          />
        )}
        <span className="bold-chat-topic-title">{job.title}</span>
        {job.needsYou && (
          <span className="bold-info-needs" data-protected="inline-flex">
            Needs you
          </span>
        )}
        {job.unread > 0 && (
          <span className="bold-unread" aria-label={`${job.unread} unread`}>
            {job.unread > 99 ? '99+' : job.unread}
          </span>
        )}
      </Link>
    </li>
  )
}

/** The side panel's Info tab (3.21.0): members, the chat's workspace, This job, its files and Past jobs. */
export function ChatInfo({
  room,
  agents,
  jobs,
  everyone,
  phone = false,
  visible = true,
  openTopics = 0,
  onNavigate,
}: {
  room: Room | null
  agents: AgentSummary[]
  jobs: Job[]
  everyone: boolean
  /** On a phone the Info sheet is also the way to Start a job (the composer's + menu has it on a desktop too). */
  phone?: boolean
  /** False while the panel is out of sight (a closed phone sheet or panel): Files and results reads nothing then. */
  visible?: boolean
  /** A counter: each increase (a `?jobs=1` landing) opens the Past jobs section. */
  openTopics?: number
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
  // 3.28.0: one job per chat. Past jobs are the finished ones, newest first; an older chat that still holds several
  // active jobs lists them as Open jobs until they end.
  const pastJobs = topics
    .filter((job) => job.state === 'done' || job.state === 'closed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const several = holdsSeveralJobs(jobs)
  const openJobs = activeJobs(jobs)
  const current = currentTopic(jobs, params.get('job'))
  return (
    <div className="sidebody bold-chat-info" aria-label={`${room.name}, chat info`}>
      <InfoSection
        kind="members"
        headingId="chat-info-members"
        title="Members"
        summary={String(room.members.length)}
      >
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
      </InfoSection>
      <InfoSection
        kind="workspace"
        headingId="chat-info-workspace"
        title="Workspace"
        summary={room.workspaceId ? (workspace?.name ?? room.workspaceId) : 'none'}
      >
        {room.workspaceId ? (
          <code>{workspace ? `${workspace.name} · ${workspace.path}` : room.workspaceId}</code>
        ) : (
          <p className="bold-chat-note">None set.</p>
        )}
      </InfoSection>
      {current && !current.isDefault && (
        <TopicInfo roomId={room.id} job={current} agents={agents} />
      )}
      {current && !current.isDefault && (
        <SubagentsInfo
          job={current}
          watchAgentId={current.activeAgents[0] ?? current.holderAgentId ?? room.leadAgentId}
          agentName={
            agents.find(
              (agent) =>
                agent.id ===
                (current.activeAgents[0] ?? current.holderAgentId ?? room.leadAgentId),
            )?.name
          }
        />
      )}
      <FilesAndResults
        jobId={current?.id ?? null}
        agents={agents}
        visible={visible}
        agentIds={
          current
            ? [...(current.holderAgentId ? [current.holderAgentId] : []), ...current.activeAgents]
            : []
        }
      />
      {several && (
        <InfoSection
          kind="open-jobs"
          headingId="chat-info-open-jobs"
          title="Open jobs"
          summary={String(openJobs.length)}
          needsYou={openJobs.some((job) => job.needsYou === true)}
          forceOpen={openTopics}
        >
          <ul className="bold-chat-topics">
            {openJobs.map((job) => (
              <TopicRow
                key={job.id}
                room={room}
                job={job}
                everyone={everyone}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </InfoSection>
      )}
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
      <InfoSection
        kind="topics"
        headingId="chat-info-topics"
        title="Past jobs"
        summary={String(pastJobs.length)}
        forceOpen={openTopics}
      >
        {pastJobs.length === 0 ? (
          <p className="bold-chat-note">Nothing yet.</p>
        ) : (
          <ul className="bold-chat-topics">
            {pastJobs.map((job) => (
              <TopicRow
                key={job.id}
                room={room}
                job={job}
                everyone={everyone}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </InfoSection>
      <Link className="bold-chat-knowledge" to="/b/knowledge" onClick={onNavigate}>
        Open Knowledge
      </Link>
    </div>
  )
}
