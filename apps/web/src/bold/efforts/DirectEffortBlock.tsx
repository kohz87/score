import type { AgentSummary } from '@score/contract'
import { agentDisplayName } from '../bold-agents.ts'
import { useAgentModel } from '../room/agent-model-query.ts'
import { useAgentSubagents } from '../subagents/subagent-queries.ts'
import { sayInChat } from './chat-notes.ts'
import { EffortChoice } from './EffortControl.tsx'
import { isAmberEffort, ownEffortLabel } from './effort-model.ts'
import { chatEffortOf, useAgentEfforts, useRoomEfforts } from './effort-queries.ts'
import { useRunEffort } from './use-run-effort.ts'
import './efforts.css'

/**
 * Chat info › "This chat" for a one-to-one: its model and effort here, with Change effort and Back to its own (mock-up
 * 25-effort-direct), and its subagents.
 */
export function DirectEffortBlock({ agent, roomId }: { agent: AgentSummary; roomId: string }) {
  const current = chatEffortOf(useRoomEfforts(roomId).items, agent.id)
  // Undefined until the read answers, and when it fails: its own then reads "unknown", never the model's default.
  const own = useAgentEfforts(agent.id).data?.own
  const runEffort = useRunEffort(roomId, 'direct')
  const model = useAgentModel(agent.id)
  const name = agentDisplayName(agent)
  const ceiling = useAgentSubagents(agent.id).data
  const subagentsText = !ceiling
    ? '—'
    : ceiling.control === 'none'
      ? 'not supported'
      : !ceiling.enabled
        ? 'off'
        : ceiling.control === 'on_off'
          ? 'on'
          : `up to ${ceiling.maxConcurrent}`
  return (
    <section className="bold-effort-this-chat" aria-label="This chat">
      <div className="bold-effort-this-title">THIS CHAT</div>
      <div className="bold-effort-row">
        <span>Model</span>
        <code>{model ?? '—'}</code>
      </div>
      <div className="bold-effort-row">
        <span>Effort</span>
        <span className="bold-effort-row-value">
          {current ? (
            <span
              className={`bold-effort-level${isAmberEffort(current) ? ' bold-effort--max' : ''}`}
            >
              {current}
            </span>
          ) : (
            <span>Its own</span>
          )}
          <small>its own: {ownEffortLabel(own)}</small>
        </span>
      </div>
      <div className="bold-effort-row">
        <span>Subagents</span>
        <span>{subagentsText}</span>
      </div>
      <div className="bold-effort-actions">
        <EffortChoice
          agent={agent}
          current={current}
          runEffort={runEffort}
          showWhenOwn
          placement="down"
          className="bold-effort-button"
          label={`Change effort for ${name} in this chat`}
        >
          Change effort
        </EffortChoice>
        {current && (
          <button
            type="button"
            className="bold-effort-back"
            onClick={() =>
              runEffort(agent, 'default').catch(() =>
                sayInChat(roomId, 'That didn’t work. Try again.'),
              )
            }
          >
            Back to its own
          </button>
        )}
      </div>
      <p className="bold-effort-this-note">
        Only this chat. {name}’s other chats, and its group chats, keep its own setting.
      </p>
    </section>
  )
}
