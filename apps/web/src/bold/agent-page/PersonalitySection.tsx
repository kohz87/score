import type { AgentDetail } from '@score/contract'
import { useState } from 'react'
import { AgentFiles } from '../../routes/team/AgentFiles.tsx'
import type { AgentFileName } from '../../routes/team/file-queries.ts'
import { agentDisplayName } from '../bold-agents.ts'

/** Personality: today's SOUL.md / AGENTS.md editor, unchanged. */
export function PersonalitySection({ agent }: { agent: AgentDetail }) {
  const [file, setFile] = useState<AgentFileName>('SOUL.md')
  return (
    <section
      className="card bold-up-card bold-agent-section bold-agent-personality"
      id="agent-personality"
      aria-label="How it works"
    >
      <span className="lab">How {agentDisplayName(agent)} works</span>
      <AgentFiles agent={agent} file={file} onFile={setFile} />
    </section>
  )
}
