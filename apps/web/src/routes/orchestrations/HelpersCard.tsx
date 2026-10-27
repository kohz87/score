import type { AgentSummary, OrchestrationDetail, VoteView } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'

// 3.15/3.16: the job's helpers and the votes the lead asked them. Read-only; the lead (or you) decides a split.

const voteStatus: Record<VoteView['status'], string> = {
  voting: 'Voting',
  sharp: 'Sharp',
  split: 'Split',
  failed: 'No usable answers',
}

function VoteRow({ vote, splitTo }: { vote: VoteView; splitTo: 'lead' | 'person' }) {
  const total = vote.counts.reduce((sum, count) => sum + count, 0)
  return (
    <li className="orch-vote" data-status={vote.status}>
      <div className="orch-check-line">
        <strong>{vote.question}</strong>
        <span className={`orch-check-pill orch-vote-pill--${vote.status}`}>
          {voteStatus[vote.status]}
        </span>
        {vote.inquiryId && <span className="orch-muted">asked you</span>}
        {!vote.inquiryId && vote.status === 'split' && splitTo === 'lead' && (
          <span className="orch-muted">the lead decides</span>
        )}
      </div>
      <ul className="orch-vote-options">
        {vote.options.map((option, index) => {
          const count = vote.counts[index] ?? 0
          const percent = total > 0 ? Math.round((count / total) * 100) : 0
          const chosen = vote.status === 'sharp' && vote.choice === index
          return (
            <li
              key={index}
              className={chosen ? 'orch-vote-option orch-vote-option--chosen' : 'orch-vote-option'}
            >
              <span className="orch-vote-label">{option}</span>
              <span className="orch-vote-count">{count}</span>
              <span className="orch-vote-bar" aria-hidden="true">
                <span style={{ width: `${percent}%` }} />
              </span>
              {chosen && <span className="orch-muted">chosen</span>}
            </li>
          )
        })}
      </ul>
    </li>
  )
}

export function HelpersCard({
  run,
  agents,
}: {
  run: Pick<OrchestrationDetail, 'helpers'>
  agents: AgentSummary[]
}) {
  const helpers = run.helpers
  if (!helpers) return null
  return (
    <section className="orch-advisor orch-helpers" aria-label="Helpers">
      <h3>Helpers</h3>
      <p className="orch-advisor-who">
        {helpers.agentIds.map((id) => {
          const agent = agents.find((item) => item.id === id)
          return (
            <span key={id} className="orch-agent">
              {agent && <AgentGlyph agent={agent} size="xs" describeShape />}
              <span>{agent?.name ?? id}</span>
            </span>
          )
        })}
      </p>
      {helpers.voterIds && helpers.voterIds.length > 0 && (
        <p className="orch-advisor-who">
          <span>Votes:</span>
          {helpers.voterIds.map((id) => {
            const agent = agents.find((item) => item.id === id)
            return (
              <span key={id} className="orch-agent">
                {agent && <AgentGlyph agent={agent} size="xs" describeShape />}
                <span>{agent?.name ?? id}</span>
              </span>
            )
          })}
        </p>
      )}
      <p className="orch-muted">
        {helpers.used} of {helpers.maxSteps} helper steps, up to {helpers.maxConcurrent} at once.
        {helpers.scan && <> Scanned first: {helpers.scanFolder ?? 'no folder'}.</>}
      </p>
      {helpers.votes.length > 0 && (
        <>
          <h4>Votes</h4>
          <ul className="orch-advisor-list">
            {helpers.votes.map((vote) => (
              <VoteRow key={vote.id} vote={vote} splitTo={helpers.splitTo} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
