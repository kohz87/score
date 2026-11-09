import type { Job } from '@score/contract'
import { Link } from 'react-router'
import { boldAgentScreenLink } from '../bold-links.ts'
import { InfoSection } from '../chats/InfoSection.tsx'
import { useAgentSubagents, useJobSubagentRows } from './subagent-queries.ts'
import { subagentAtOnceText, subagentCostText } from './subagent-model.ts'
import './subagents.css'

/**
 * SA.3: the side panel's SUBAGENTS section for the job on screen. A status display: at once, how many of its total it
 * has used, and what its helpers cost so far. Unknown cost is a dash, never $0.
 */
export function SubagentsInfo({
  job,
  watchAgentId,
  agentName,
}: {
  job: Job | undefined
  watchAgentId: string | null
  agentName?: string
}) {
  const rows = useJobSubagentRows(job?.subagents ? job.id : null)
  const ceiling = useAgentSubagents(watchAgentId, Boolean(job?.subagents?.enabled))
  if (!job?.subagents) return null
  const limits = job.subagents
  if (!limits.enabled && rows.length === 0) return null
  const name = agentName ?? watchAgentId ?? ''
  return (
    <InfoSection
      kind="subagents"
      headingId="chat-info-subagents"
      title="Subagents"
      summary={limits.enabled ? subagentAtOnceText(job, ceiling.data) : 'off'}
    >
      <div className="bold-subagents-info">
        <div className="bold-subagents-info-row">
          <span>At once</span>
          <span>{subagentAtOnceText(job, ceiling.data)}</span>
        </div>
        <div className="bold-subagents-info-row">
          <span>Used in this job</span>
          <span>
            {limits.used} of {limits.maxTotal}
          </span>
        </div>
        <div className="bold-subagents-info-row">
          <span>Their cost so far</span>
          <span>{subagentCostText(rows)}</span>
        </div>
        {watchAgentId && (
          <Link
            className="bold-subagents-info-link"
            to={boldAgentScreenLink(watchAgentId)}
            aria-label={`See what ${name}’s subagents did in Watch`}
          >
            See what they did
          </Link>
        )}
      </div>
    </InfoSection>
  )
}
