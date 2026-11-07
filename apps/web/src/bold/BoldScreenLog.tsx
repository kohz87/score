import type { AgentSummary } from '@score/contract'
import { useState } from 'react'
import { copyText } from '../data/clipboard.ts'
import { resumeCommand, type ActivityItem } from '../routes/watch/watch-model.ts'
import { agentDisplayName } from './bold-agents.ts'
import { StepList } from './BoldScreenSteps.tsx'

export function BoldScreenLog({
  agent,
  items,
  currentKey,
  live,
  targets,
  onSelect,
  resumeSession,
}: {
  agent: AgentSummary
  items: ActivityItem[]
  currentKey: string | null
  live: boolean
  targets: (item: ActivityItem) => number
  onSelect: (item: ActivityItem) => void
  resumeSession?: () => Promise<string | null>
}) {
  const [command, setCommand] = useState<{ text: string; copied: boolean } | null>(null)
  const copyResume = async () => {
    const session = await (resumeSession?.() ?? Promise.resolve(null)).catch(() => null)
    const text = resumeCommand(agent.id, session)
    setCommand({ text, copied: await copyText(text) })
  }
  return (
    <section className="bold-screen-log" aria-label={`What ${agentDisplayName(agent)} did`}>
      <h2 className="bold-screen-log-title">What {agentDisplayName(agent)} did</h2>
      {items.length === 0 && (
        <p className="bold-screen-empty">Nothing yet. Steps show up here as they happen.</p>
      )}
      <StepList
        items={items}
        currentKey={currentKey}
        live={live}
        targets={targets}
        onSelect={onSelect}
      />
      <div className="bold-screen-card">
        <p>
          A replay of recorded steps, read-only. {agentDisplayName(agent)} keeps working and can’t
          see you here.
        </p>
        <button type="button" className="btn sm" onClick={() => void copyResume()}>
          Copy the command to continue in a terminal
        </button>
        {command && (
          <p role="status">
            {command.copied
              ? 'Copied. Paste this in a terminal:'
              : 'Select the command and press Ctrl+C, then run it in a terminal:'}{' '}
            <code className="bold-screen-command">{command.text}</code>
          </p>
        )}
      </div>
    </section>
  )
}
