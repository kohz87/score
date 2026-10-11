import type { AgentSummary, BriefFlow } from '@score/contract'
import { AgentGlyph } from '../../../components/AgentGlyph.tsx'
import { RunSummary } from '../../../live/RunSummary.tsx'
import { StatusLine } from '../../../live/StatusLine.tsx'
import { useStatusLines } from '../../../live/use-activity.ts'
import { agentTextColor } from '../../chat/agent-text-color.ts'

/**
 * Under the run's title: what its agents are doing now while it runs, and the run's summary once it is over. One slot
 * for both, so the page doesn't move when the run ends.
 */
export function RunLine({
  flow,
  agents,
  toolCalls,
}: {
  flow: BriefFlow
  agents: AgentSummary[]
  toolCalls: number | null
}) {
  const live = flow.brief.status === 'running' || flow.brief.status === 'paused'
  const active = [
    ...new Map(
      flow.nodes
        .filter((node) => node.agentId && (node.state === 'working' || node.state === 'needs_you'))
        .map((node) => [node.agentId!, node.state] as const),
    ),
  ]
  const lines = useStatusLines(
    active.map(([id, state]) => ({ id, working: state === 'working' && live })),
  )
  const { stats } = flow
  return (
    <div className="flow-run-line">
      {live ? (
        <ul aria-label="Working now">
          {active.slice(0, 2).map(([id, state]) => {
            const agent = agents.find((item) => item.id === id)
            const line =
              state === 'needs_you' ? 'Waiting for your approval' : (lines.get(id) ?? null)
            return (
              <li key={id}>
                {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
                <strong style={{ color: agentTextColor(agent?.style.color ?? '#9AA0AB') }}>
                  {agent?.name ?? id}
                </strong>
                <StatusLine line={line} reserve={false} />
              </li>
            )
          })}
        </ul>
      ) : (
        <RunSummary
          failed={flow.brief.status === 'failed'}
          facts={{
            toolCalls,
            steps: stats.steps,
            handoffs: stats.handoffs,
            spendUsd: stats.spendUsd,
            spendEstimated: true,
            durationSec: stats.runningSec,
          }}
        />
      )}
    </div>
  )
}
