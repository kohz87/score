import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { useMemory, useSkills } from '../../routes/team/agent-tab-queries.ts'
import { RemembersCard } from '../agent-more/RemembersCard.tsx'
import { SkillsCard } from '../agent-more/SkillsCard.tsx'
import { OpenCard } from './OpenCard.tsx'

/** Memory and skills (mock-up 26): two summaries; Open memory and Manage skills open today's full cards in place. */
export function MemorySection({
  agent,
  initialOpen,
}: {
  agent: AgentDetail
  initialOpen?: string
}) {
  const [memoryOpen, setMemoryOpen] = useState(initialOpen === 'memory')
  const [skillsOpen, setSkillsOpen] = useState(initialOpen === 'skills')
  const memory = useMemory(agent.id, '')
  const skills = useSkills(agent.id)
  const notes = memory.data?.pages.flatMap((page) => page.items) ?? []
  const items = skills.data ?? []
  const on = items.filter((skill) => skill.enabled)
  const off = items.filter((skill) => !skill.enabled)
  return (
    <section
      className="bold-agent-section bold-agent-pair"
      id="agent-memory-skills"
      aria-labelledby="agent-memory-skills-title"
    >
      <h2 id="agent-memory-skills-title" className="sr">
        Memory and skills
      </h2>
      <OpenCard
        open={memoryOpen}
        onOpen={() => setMemoryOpen(true)}
        onClose={() => setMemoryOpen(false)}
        title={`Remembers${memory.isSuccess ? ` · ${notes.length}${memory.hasNextPage ? '+' : ''}` : ''}`}
        summary={
          memory.isPending
            ? 'Loading memory…'
            : memory.isError
              ? 'Couldn’t load memory.'
              : notes.length
                ? notes
                    .slice(0, 3)
                    .map((note) => note.text)
                    .join(' · ')
                : 'Nothing remembered yet.'
        }
        openLabel="Open memory"
        openName="Open memory"
      >
        <RemembersCard agent={agent} />
      </OpenCard>
      <OpenCard
        open={skillsOpen}
        onOpen={() => setSkillsOpen(true)}
        onClose={() => setSkillsOpen(false)}
        title={`Skills${skills.isSuccess ? ` · ${on.length}` : ''}`}
        summary={
          skills.isPending
            ? 'Loading skills…'
            : skills.isError
              ? 'Couldn’t load skills.'
              : items.length
                ? [
                    on.map((skill) => skill.name).join(', '),
                    off.length && `${off.map((skill) => skill.name).join(', ')} off`,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'No skills installed.'
        }
        openLabel="Manage skills"
        openName="Manage skills"
      >
        <SkillsCard agent={agent} />
      </OpenCard>
    </section>
  )
}
