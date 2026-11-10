import type { AgentDetail } from '@score/contract'
import { RoutinesCard } from '../agent-more/RoutinesCard.tsx'
import { RunsCard } from '../agent-more/RunsCard.tsx'
import { TodoCard } from '../agent-more/TodoCard.tsx'
import { WorkspaceTab } from '../../routes/team/WorkspaceTab.tsx'

/** Work (mock-up 26): Recent runs, Repeating jobs and Todo, with the Files panel when a workspace link opened it. */
export function WorkSection({
  agent,
  coding,
  files,
  onCloseFiles,
}: {
  agent: AgentDetail
  coding: boolean
  files: { path: string | null } | null
  onCloseFiles: () => void
}) {
  return (
    <section className="bold-agent-section" id="agent-work" aria-labelledby="agent-work-title">
      <h2 id="agent-work-title">Work</h2>
      <div className={`bold-agent-tiles${coding ? '' : ' bold-agent-tiles-3'}`}>
        <RunsCard agent={agent} />
        {!coding && <RoutinesCard agent={agent} />}
        {!coding && <TodoCard agent={agent} />}
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
            <button type="button" className="btn sm ghost" onClick={onCloseFiles}>
              Close files
            </button>
          </span>
          <WorkspaceTab
            agentId={agent.id}
            agentName={agent.name}
            initialPath={files.path}
            canSetFolder={false}
            key={files.path ?? ''}
          />
        </section>
      )}
    </section>
  )
}
