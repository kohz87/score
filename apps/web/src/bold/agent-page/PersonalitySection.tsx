import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { AgentFiles } from '../../routes/team/AgentFiles.tsx'
import type { AgentFileName } from '../../routes/team/file-queries.ts'

/** Personality (mock-up 26): one section, its heading and the two files as toggles on one row. SOUL.md / AGENTS.md. */
export function PersonalitySection({ agent }: { agent: AgentDetail }) {
  const [file, setFile] = useState<AgentFileName>('SOUL.md')
  return (
    <section
      className="bold-agent-section"
      id="agent-personality"
      aria-labelledby="team-files-heading"
    >
      <AgentFiles agent={agent} file={file} onFile={setFile} />
    </section>
  )
}
