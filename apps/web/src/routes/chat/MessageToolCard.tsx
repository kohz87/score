import type { AgentSummary } from '@score/contract'
import { useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { subagentLine, subagentReport } from '../../components/subagent.ts'
import type { Expansion, ToolPart } from './message-item-types.ts'

const STATUS_LABEL = { running: 'Running', ok: 'Done', error: 'Failed' } as const

export function ToolCard({
  part,
  expansion,
  live,
  nested = [],
  agent,
}: {
  part: ToolPart
  expansion: Expansion
  live: boolean
  /** The calls a sub-agent made under this Agent call (PLAN 8.7), shown inside the card. */
  nested?: ToolPart[]
  agent?: AgentSummary | undefined
}) {
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(expansion.version)
  if (seen !== expansion.version) {
    // Adjusting state while rendering: Expand all / Collapse all overrides what was opened by hand.
    setSeen(expansion.version)
    setOpen(expansion.open)
  }
  // A tool that never reported back in a finished reply is not "running" any more.
  const status = part.status === 'running' && !live ? 'ok' : part.status
  const sub = part.subagent
  return (
    <details
      className={`chat-card chat-tool chat-tool--${status}${sub ? ' chat-tool--subagent' : ''}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {sub ? (
          <>
            {agent && <AgentGlyph agent={agent} size="xs" decorative />}
            <span className="chat-subagent-label">sub-agent</span>
            <span className="chat-tool-args">
              {subagentLine(
                sub.status === 'running' && !live ? { ...sub, status: 'done' } : sub,
                nested.length,
              )}
            </span>
          </>
        ) : (
          <>
            <code className="chat-tool-name">{part.tool}</code>
            <span className="chat-tool-args">{part.args}</span>
          </>
        )}
        <span className="chat-tool-status">{STATUS_LABEL[status]}</span>
      </summary>
      {sub && part.args && (
        <p className="chat-subagent-task">
          <code className="chat-tool-name">{part.tool}</code> {part.args}
        </p>
      )}
      {nested.length > 0 && (
        <div className="chat-subagent-calls" aria-label="Sub-agent tool calls">
          {nested.map((call, index) => (
            <ToolCard key={call.callId ?? index} part={call} expansion={expansion} live={live} />
          ))}
        </div>
      )}
      {!sub && part.args && (
        <pre className="chat-tool-body" aria-label="Arguments">
          {part.args}
        </pre>
      )}
      {part.result && (
        <pre className="chat-tool-body" aria-label="Result">
          {sub ? subagentReport(part.result) : part.result}
        </pre>
      )}
    </details>
  )
}
