import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { WorkspaceTab } from '../routes/team/WorkspaceTab.tsx'
import { CanUseCard } from './agent-more/CanUseCard.tsx'
import { ChannelsCard } from './agent-more/ChannelsCard.tsx'
import { DeleteCard } from './agent-more/DeleteCard.tsx'
import { GoAheadCard } from './agent-more/GoAheadCard.tsx'
import { LooksCard } from './agent-more/LooksCard.tsx'
import { NameCard } from './agent-more/NameCard.tsx'
import { NeverCard } from './agent-more/NeverCard.tsx'
import { PluginsCard } from './agent-more/PluginsCard.tsx'
import { RemembersCard } from './agent-more/RemembersCard.tsx'
import { RoutinesCard } from './agent-more/RoutinesCard.tsx'
import { RunsCard } from './agent-more/RunsCard.tsx'
import { ScoreAccessCard } from './agent-more/ScoreAccessCard.tsx'
import { SkillsCard } from './agent-more/SkillsCard.tsx'
import { TodoCard } from './agent-more/TodoCard.tsx'
import { WorkspaceCard } from './agent-more/WorkspaceCard.tsx'
import './agent-more/agent-more.css'

/**
 * PLAN 2.0.7: what sits under "More" on the agent page, in the prototype's `grid3` of compact cards. The first six
 * follow prototype.html (vAgent's `more`); the rest are what Score has that the prototype doesn't show. Deep editing
 * (the file editor) opens in the Files panel below the cards, which is the existing workspace browser.
 */
export function BoldAgentMore({
  agent,
  coding,
  initialPath,
  onDelete,
}: {
  agent: AgentDetail
  coding: boolean
  /** A file to open straight away (a workspace link); null keeps the Files panel closed. */
  initialPath: string | null
  onDelete: () => void
}) {
  const [files, setFiles] = useState<{ path: string | null } | null>(
    initialPath === null ? null : { path: initialPath },
  )
  // A workspace link to another file while More is already open follows the link.
  const [seen, setSeen] = useState(initialPath)
  if (seen !== initialPath) {
    setSeen(initialPath)
    if (initialPath !== null) setFiles({ path: initialPath })
  }
  const canDelete = agent.id !== 'default' && agent.lifecycle?.state !== 'removed'
  const editable = !agent.lifecycle || agent.lifecycle.state === 'ready'
  const openFiles = (path: string | null) => {
    setFiles({ path })
    window.setTimeout(() => document.getElementById('agent-files')?.scrollIntoView(), 0)
  }
  const workspace = <WorkspaceCard agent={agent} onOpen={openFiles} />
  const deletion = canDelete ? <DeleteCard agent={agent} onDelete={onDelete} /> : null
  return (
    <>
      <div className="grid3 bold-more-grid">
        {coding ? (
          <>
            <CanUseCard agent={agent} coding />
            {workspace}
            <RunsCard agent={agent} />
            <LooksCard agent={agent} />
            {editable && <NameCard agent={agent} />}
            {deletion}
          </>
        ) : (
          <>
            <RemembersCard agent={agent} />
            <SkillsCard agent={agent} />
            <CanUseCard agent={agent} coding={false} />
            {workspace}
            <RoutinesCard agent={agent} />
            {deletion}
            <PluginsCard agent={agent} />
            <ChannelsCard agent={agent} />
            <GoAheadCard agent={agent} />
            <NeverCard agent={agent} />
            <LooksCard agent={agent} />
            {editable && <NameCard agent={agent} />}
            <RunsCard agent={agent} />
            <ScoreAccessCard agent={agent} />
            <TodoCard agent={agent} />
          </>
        )}
      </div>
      {files && (
        <section
          className="card bold-mc-files"
          id="agent-files"
          aria-labelledby="agent-files-title"
        >
          <span className="row">
            <h3 id="agent-files-title" className="grow">
              Files
            </h3>
            <button type="button" className="btn sm ghost" onClick={() => setFiles(null)}>
              Close files
            </button>
          </span>
          <WorkspaceTab
            agentId={agent.id}
            agentName={agent.name}
            initialPath={files.path}
            key={files.path ?? ''}
          />
        </section>
      )}
    </>
  )
}
