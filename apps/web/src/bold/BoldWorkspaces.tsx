import { useId, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentSummary, SharedWorkspace } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useWorkspace, workspaceKey } from '../routes/team/workspace-queries.ts'
import { problem } from './agent-more/MoreCard.tsx'
import { agentDisplayName, onTeam } from './bold-agents.ts'
import { RemoveConfirm } from './RemoveConfirm.tsx'
import {
  createSharedWorkspace,
  deleteSharedWorkspace,
  updateSharedWorkspace,
  setAgentFolder,
  useSharedWorkspaces,
  workspacesKey,
} from './workspaces-queries.ts'

const isCoding = (agent: AgentSummary) => agent.runtime !== undefined && agent.runtime !== 'hermes'

function useWorkspaceChange<T>(work: (value: T) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: work,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspacesKey }),
  })
}

/** A Hermes agent has one folder, so an assigned one can be made that workspace's; it says so when it already is. */
function FolderAction({ workspace, agent }: { workspace: SharedWorkspace; agent: AgentSummary }) {
  const info = useWorkspace(agent.id)
  const queryClient = useQueryClient()
  const use = useMutation({
    mutationFn: () => setAgentFolder(workspace.id, agent.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKey(agent.id) }),
  })
  const name = agentDisplayName(agent)
  if (info.data?.root === workspace.path || use.isSuccess)
    return <span className="small bold-ws-its-folder">{name}’s folder</span>
  return (
    <span className="bold-ws-folder-action">
      <button
        type="button"
        className="btn sm"
        disabled={use.isPending}
        aria-label={`Use as ${name}’s folder`}
        onClick={() => use.mutate()}
      >
        {use.isPending ? 'Setting…' : 'Use as its folder'}
      </button>
      {use.isError && (
        <span className="small" role="alert">
          {problem(use.error, 'Couldn’t set the folder. Try again.')}
        </span>
      )}
    </span>
  )
}

function WorkspaceCard({
  workspace,
  agents,
  roomNames,
}: {
  workspace: SharedWorkspace
  agents: AgentSummary[]
  roomNames: Map<string, string>
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(workspace.name)
  const [removing, setRemoving] = useState(false)
  const update = useWorkspaceChange((request: { name?: string; agentIds?: string[] }) =>
    updateSharedWorkspace(workspace.id, request),
  )
  const remove = useWorkspaceChange(() => deleteSharedWorkspace(workspace.id))
  const used = workspace.roomIds.length
  const usedText =
    used === 0 ? 'Not used by a room yet' : `Used by ${used} room${used === 1 ? '' : 's'}`
  const usedTitle = workspace.roomIds.map((id) => roomNames.get(id) ?? 'Team room').join(', ')

  function toggle(agentId: string) {
    const agentIds = workspace.agentIds.includes(agentId)
      ? workspace.agentIds.filter((id) => id !== agentId)
      : [...workspace.agentIds, agentId]
    update.mutate({ agentIds })
  }
  function rename(event: FormEvent) {
    event.preventDefault()
    const next = name.trim()
    if (!next || next === workspace.name) return setRenaming(false)
    update.mutate({ name: next }, { onSuccess: () => setRenaming(false) })
  }

  return (
    <section className="card bold-ws-card" aria-label={workspace.name}>
      <div className="bold-ws-head">
        <div className="bold-ws-title">
          {renaming ? (
            <form onSubmit={rename} aria-label={`Rename ${workspace.name}`} className="row wrap">
              <input
                className="field"
                aria-label="Workspace name"
                autoFocus
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" className="btn sm" disabled={update.isPending}>
                Save
              </button>
              <button type="button" className="link" onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <h3>{workspace.name}</h3>
          )}
          <code className="bold-ws-path">{workspace.path}</code>
        </div>
        <span className="small muted" title={usedTitle || undefined}>
          {usedText}
        </span>
      </div>
      <div role="group" aria-label="Agents who may work here" className="bold-ws-agents">
        {agents.map((agent) => {
          const on = workspace.agentIds.includes(agent.id)
          return (
            <span key={agent.id} className="bold-ws-agent">
              <button
                type="button"
                className="bold-ws-chip"
                aria-pressed={on}
                disabled={update.isPending}
                onClick={() => toggle(agent.id)}
              >
                <AgentGlyph agent={agent} size="xs" bare decorative />
                {agentDisplayName(agent)}
                <span aria-hidden="true" className="bold-ws-mark">
                  {on ? '✓' : '+'}
                </span>
              </button>
              {on && !isCoding(agent) && <FolderAction workspace={workspace} agent={agent} />}
            </span>
          )
        })}
      </div>
      {update.isError && (
        <p className="small" role="alert">
          {problem(update.error, 'Couldn’t save that. Try again.')}
        </p>
      )}
      {removing ? (
        <RemoveConfirm
          what={workspace.name}
          text="The folder stays on disk. Rooms using this workspace go back to none."
          pending={remove.isPending}
          error={remove.error}
          onCancel={() => setRemoving(false)}
          onRemove={() => remove.mutate(undefined)}
        />
      ) : (
        <div className="row wrap">
          {!renaming && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setName(workspace.name)
                setRenaming(true)
              }}
            >
              Rename
            </button>
          )}
          <button type="button" className="btn sm" onClick={() => setRemoving(true)}>
            Delete
          </button>
        </div>
      )}
    </section>
  )
}

function NewWorkspace({ onDone }: { onDone: () => void }) {
  const ids = useId()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [create, setCreate] = useState(false)
  const add = useWorkspaceChange(() =>
    createSharedWorkspace({ name: name.trim(), path: path.trim(), ...(create ? { create } : {}) }),
  )
  function submit(event: FormEvent) {
    event.preventDefault()
    add.mutate(undefined, { onSuccess: onDone })
  }
  return (
    <form className="card bold-ws-new" aria-label="New workspace" onSubmit={submit}>
      <label className="lab" htmlFor={`${ids}-name`}>
        Name
      </label>
      <input
        id={`${ids}-name`}
        className="field"
        autoFocus
        required
        maxLength={80}
        placeholder="activity-feed"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="lab" htmlFor={`${ids}-path`}>
        Folder on this computer
      </label>
      <input
        id={`${ids}-path`}
        className="field"
        required
        maxLength={4096}
        placeholder="~/code/activity-feed"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <label className="row">
        <input
          type="checkbox"
          checked={create}
          onChange={(event) => setCreate(event.target.checked)}
        />
        <span>Create the folder if it doesn’t exist</span>
      </label>
      {add.isError && (
        <p role="alert" className="small">
          {problem(add.error, 'Couldn’t add the workspace. Try again.')}
        </p>
      )}
      <div className="row wrap">
        <button
          type="submit"
          className="btn sm primary"
          disabled={add.isPending || !name.trim() || !path.trim()}
        >
          {add.isPending ? 'Adding…' : 'Add workspace'}
        </button>
        <button type="button" className="link" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** 3.20.0: Settings › Workspaces (contract § 18): named folders, and which agents may work in each. */
export function BoldWorkspaces({
  agents,
  rooms,
}: {
  agents: AgentSummary[]
  rooms: { id: string; name: string }[]
}) {
  const [adding, setAdding] = useState(false)
  const list = useSharedWorkspaces()
  const team = agents.filter(onTeam)
  const roomNames = new Map(rooms.map((room) => [room.id, room.name]))
  return (
    <div className="bold-workspaces">
      <div className="bold-ws-top">
        <div>
          <h2 id="settings-workspaces">Workspaces</h2>
          <p className="muted">
            A workspace is a folder your agents can work in. Tick who may use each one; an agent can
            be in several. A room picks the workspace its agents work in.
          </p>
        </div>
        {!adding && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            New workspace
          </button>
        )}
      </div>
      {adding && <NewWorkspace onDone={() => setAdding(false)} />}
      {list.isPending && <p role="status">Loading workspaces…</p>}
      {list.isError && <p role="alert">Couldn’t load the workspaces. Try again.</p>}
      {list.isSuccess && list.data.length === 0 && !adding && (
        <p className="muted">No workspaces yet. Add a folder to share it between agents.</p>
      )}
      {list.data?.map((workspace) => (
        <WorkspaceCard
          key={workspace.id}
          workspace={workspace}
          agents={team}
          roomNames={roomNames}
        />
      ))}
      <p className="small muted">
        Coding agents work in the room’s workspace when they’re ticked for it; otherwise in their
        own folder. A Hermes agent has one folder: use “Use as its folder” to switch it.
      </p>
    </div>
  )
}
