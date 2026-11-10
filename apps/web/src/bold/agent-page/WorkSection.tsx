import type { AgentDetail } from '@score/contract'
import { WorkspaceTab } from '../../routes/team/WorkspaceTab.tsx'
import { TodoTile } from './WorkTiles.tsx'
import { RunsTile } from './RunsTile.tsx'
import { AssignedTile } from './AssignedTile.tsx'

/** Work (mock-up 26; decision 183): Recent runs, Assigned (read-only; set in Tasks) and Todo as one-line summaries, with the Files panel when a workspace link opened it. */
export function WorkSection({
  agent,
  coding,
  files,
  onCloseFiles,
  initialOpen,
}: {
  agent: AgentDetail
  coding: boolean
  files: { path: string | null } | null
  onCloseFiles: () => void
  initialOpen?: string
}) {
  return (
    <section className="bold-agent-section" id="agent-work" aria-labelledby="agent-work-title">
      <h2 id="agent-work-title">Work</h2>
      <div className={`bold-agent-tiles${coding ? '' : ' bold-agent-tiles-3'}`}>
        <RunsTile agent={agent} initialOpen={initialOpen === 'runs'} />
        {!coding && <AssignedTile agent={agent} />}
        {!coding && <TodoTile agent={agent} initialOpen={initialOpen === 'todo'} />}
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
