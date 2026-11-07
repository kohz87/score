import type { AgentSummary, WorkbenchFile } from '@score/contract'
import type { CSSProperties } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { agentDisplayName } from './bold-agents.ts'

export function CursorMark({
  cursor,
  agent,
}: {
  cursor: WorkbenchFile['cursors'][number]
  agent: AgentSummary | undefined
}) {
  return (
    <span
      className="bold-bench-cursor"
      data-cursor={cursor.agentId}
      style={{ '--cursor-colour': agent?.style.color ?? 'var(--ok)' } as CSSProperties}
    >
      <span className="bold-bench-caret" aria-hidden="true" />
      <span className="bold-bench-cursor-name">
        <AgentGlyph
          agent={
            agent ?? {
              id: cursor.agentId,
              name: cursor.agentId,
              style: { color: '#5EE3BF', shape: 'triangle' },
            }
          }
          size="xs"
          bare
          decorative
        />
        {agent ? agentDisplayName(agent) : cursor.agentId}
      </span>
    </span>
  )
}
