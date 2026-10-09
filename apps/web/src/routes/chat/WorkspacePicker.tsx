import type { AgentSummary } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { TreeLevel, type Selection } from '../team/WorkspaceTree.tsx'
import { useWorkspace } from '../team/workspace-queries.ts'
import '../team/workspace.css'

/**
 * "From workspace…": picks a file from an addressed agent's workspace (the Team › Workspace tree, read-only here).
 * The message then carries a reference, not a copy.
 */
export function WorkspacePicker({
  agents,
  onPick,
  onClose,
}: {
  /** The agents the message is for; several get a chooser. */
  agents: AgentSummary[]
  onPick: (agentId: string, path: string) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<Selection | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const info = useWorkspace(agentId)
  const agent = agents.find((candidate) => candidate.id === agentId)
  return (
    <dialog
      ref={dialog}
      className="chat-doc-dialog"
      aria-labelledby="chat-picker-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close()
      }}
    >
      <h2 id="chat-picker-title">Attach from workspace</h2>
      {agents.length > 1 ? (
        <label className="chat-picker-agent">
          Workspace of
          <select
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value)
              setExpanded(new Set())
              setSelected(null)
            }}
          >
            {agents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="chat-doc-note">Workspace of {agent?.name ?? agentId}</p>
      )}
      <div className="chat-doc-body chat-picker-tree">
        {info.isPending && <p role="status">Loading…</p>}
        {info.isError && <p role="alert">Could not load the workspace.</p>}
        {info.data && !info.data.available && (
          <p role="status">{info.data.reason ?? 'The workspace is unavailable.'}</p>
        )}
        {info.data?.available && (
          <TreeLevel
            key={agentId}
            agentId={agentId}
            path=""
            depth={0}
            expanded={expanded}
            selected={selected}
            onToggle={(path) =>
              setExpanded((current) => {
                const next = new Set(current)
                if (!next.delete(path)) next.add(path)
                return next
              })
            }
            onSelect={setSelected}
          />
        )}
      </div>
      <div className="chat-doc-actions">
        <button
          type="button"
          className="chat-doc-button chat-doc-primary"
          disabled={selected?.kind !== 'file'}
          onClick={() => {
            if (selected?.kind !== 'file') return
            onPick(agentId, selected.path)
            dialog.current?.close()
          }}
        >
          Attach
        </button>
        <button
          type="button"
          className="chat-doc-button chat-doc-close"
          onClick={() => dialog.current?.close()}
        >
          Cancel
        </button>
      </div>
    </dialog>
  )
}
