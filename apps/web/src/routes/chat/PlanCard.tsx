import type { AgentSummary, MessagePart } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentTextColor } from './agent-text-color.ts'

type PlanPart = Extract<MessagePart, { kind: 'plan' }>

const DEFAULT_SPAN = 30 * 60_000

// Blocks share one time axis per card; an open end (working/planned) gets a short default span.
export function planAxis(lanes: PlanPart['lanes']) {
  const blocks = lanes.flatMap((lane) => lane.blocks)
  if (!blocks.length) return null
  const spans = blocks.map((block) => {
    const start = Date.parse(block.start)
    const end = block.end ? Date.parse(block.end) : start + DEFAULT_SPAN
    return { id: block.id, start, end: Math.max(end, start + 60_000) }
  })
  const min = Math.min(...spans.map((span) => span.start))
  const max = Math.max(...spans.map((span) => span.end))
  const total = Math.max(max - min, 1)
  return new Map(
    spans.map((span) => [
      span.id,
      { left: ((span.start - min) / total) * 100, width: ((span.end - span.start) / total) * 100 },
    ]),
  )
}

const stateText = {
  done: 'done',
  working: 'in progress',
  planned: 'planned',
  waiting: 'waiting',
}

export function PlanCard({ part, agents }: { part: PlanPart; agents: AgentSummary[] }) {
  const axis = planAxis(part.lanes)
  return (
    <section className="chat-plan-card" aria-label="Plan">
      <div className="chat-plan-head">
        <strong>Plan</strong>
        <Link to={`/now?brief=${encodeURIComponent(part.briefId)}`}>Open in Score</Link>
      </div>
      <div className="chat-plan-grid">
        {part.lanes.map((lane) => {
          const agent = agents.find((item) => item.id === lane.agentId)
          return (
            <div className="chat-plan-lane" key={lane.agentId} role="group">
              <span
                className="chat-agent-label"
                style={agent && { color: agentTextColor(agent.style.color) }}
              >
                {agent && <AgentGlyph agent={agent} size="xs" decorative />}
                {agent?.name ?? lane.agentId}
              </span>
              <div className="chat-plan-track">
                {lane.blocks.map((block) => {
                  const box = axis?.get(block.id)
                  return (
                    <span
                      className={`chat-plan-block chat-plan-block--${block.state}`}
                      key={block.id}
                      title={`${block.label} (${stateText[block.state]})`}
                      style={{
                        left: `${box?.left ?? 0}%`,
                        width: `${box?.width ?? 100}%`,
                        ['--lane-color' as string]: agent?.style.color,
                      }}
                    >
                      <span className="chat-plan-block-label">{block.label}</span>
                      <span className="chat-sr-only"> ({stateText[block.state]})</span>
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
