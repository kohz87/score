import { PlanStartResponseSchema, type AgentSummary, type MessagePart } from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '../../shell/framed-paths.tsx'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { orchestrationsQuery } from '../orchestrations/orchestration-queries.ts'
import { briefHasRun } from '../runs/brief-run.ts'
import { workflowRunsQuery } from '../workflows/workflow-queries.ts'
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

export function PlanCard({
  part,
  agents,
  roomId,
  messageId,
}: {
  part: PlanPart
  agents: AgentSummary[]
  roomId: string
  messageId: string
}) {
  const axis = planAxis(part.lanes)
  const queryClient = useQueryClient()
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const runHref = briefHasRun(part.briefId, orchestrations, workflows)
    ? `/runs/${encodeURIComponent(part.briefId)}`
    : null
  // The server waits for this call before it creates any task; it is idempotent per message, so retry is safe.
  const start = useMutation({
    mutationFn: async () =>
      PlanStartResponseSchema.parse(
        await apiFetch(
          `rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/plan/start`,
          { method: 'POST', headers: { 'Idempotency-Key': newId() } },
        ),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['flow'] }),
  })
  return (
    <section className="chat-plan-card" aria-label="Plan">
      <div className="chat-plan-head">
        <strong>Plan</strong>
        {runHref && <Link to={runHref}>Open the run</Link>}
      </div>
      <div className="chat-plan-start">
        {start.isSuccess ? (
          <span role="status">
            Plan started: {start.data.taskIds.length}{' '}
            {start.data.taskIds.length === 1 ? 'task' : 'tasks'} created.
          </span>
        ) : (
          <button
            type="button"
            className="chat-plan-start-button"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? 'Starting…' : start.isError ? 'Try starting again' : 'Start plan'}
          </button>
        )}
        {start.isError && (
          <span role="alert">
            {start.error instanceof Error ? start.error.message : 'Couldn’t start the plan.'}
          </span>
        )}
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
