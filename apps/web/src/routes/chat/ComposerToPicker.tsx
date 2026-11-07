import type { AgentSummary } from '@score/contract'
import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { AgentGlyph, agentTint } from '../../components/AgentGlyph.tsx'
import { agentTextColor } from './agent-text-color.ts'

export function ComposerToPicker({
  roomMode,
  agents,
  offered,
  to,
  setTo,
  planFirst,
  setPlanFirst,
  textarea,
}: {
  roomMode: boolean
  agents: AgentSummary[]
  offered: AgentSummary[]
  to: string[]
  setTo: Dispatch<SetStateAction<string[]>>
  planFirst: boolean
  setPlanFirst: Dispatch<SetStateAction<boolean>>
  textarea: RefObject<HTMLTextAreaElement | null>
}) {
  const [picker, setPicker] = useState(false)
  const available = offered.filter((agent) => !to.includes(agent.id))
  return (
    <>
      {!roomMode && <span className="chat-composer-label">To</span>}
      {!roomMode && to.length === 0 && <span className="chat-composer-default">Room lead</span>}
      {to.map((id) => {
        const agent = agents.find((item) => item.id === id)
        const color = agent?.style.color
        return (
          <span
            key={id}
            className="chat-chip"
            style={
              color ? { background: agentTint(color), color: agentTextColor(color) } : undefined
            }
          >
            {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
            {agent?.name ?? id}
            <button
              type="button"
              aria-label={`Remove ${agent?.name ?? id}`}
              onClick={() => setTo(to.filter((item) => item !== id))}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path
                  d="M2 2 L8 8 M8 2 L2 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </span>
        )
      })}
      {!roomMode && (
        <span
          className="chat-add"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && picker) {
              event.stopPropagation()
              setPicker(false)
            }
          }}
        >
          <button
            type="button"
            className="chat-add-trigger"
            aria-expanded={picker}
            aria-haspopup="true"
            disabled={!available.length}
            onClick={() => setPicker(!picker)}
          >
            Add someone
          </button>
          {picker && (
            <ul className="chat-add-list" aria-label="Add someone">
              {available.map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setTo([...to, agent.id])
                      setPicker(false)
                      textarea.current?.focus()
                    }}
                  >
                    <AgentGlyph agent={agent} size="xs" bare decorative />
                    {agent.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </span>
      )}
      <span className="chat-grow" />
      {!roomMode && (
        <button
          type="button"
          className="chat-plan-toggle"
          aria-pressed={planFirst}
          onClick={() => setPlanFirst(!planFirst)}
        >
          <span className="chat-switch" aria-hidden="true" />
          Plan first
        </button>
      )}
    </>
  )
}
