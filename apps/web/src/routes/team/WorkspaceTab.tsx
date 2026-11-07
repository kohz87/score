import { useState, type FormEvent } from 'react'
import { ApiError } from '../../data/api.ts'
import {
  useWorkspace,
  useWorkspaceActions,
  workspaceFailure,
  WorkspaceRootContext,
} from './workspace-queries.ts'
import { Browser } from './WorkspaceBrowser.tsx'
import './workspace.css'

export function WorkspaceTab({
  agentId,
  agentName,
  initialPath = null,
  canSetFolder = true,
}: {
  agentId: string
  agentName: string
  /** 3.20.0: the bold agent page no longer changes an agent's folder (Settings › Workspaces does). */
  canSetFolder?: boolean
  /** A file to open straight away (a workspace:// link); a bad path shows the normal error. */
  initialPath?: string | null
}) {
  const info = useWorkspace(agentId)
  const actions = useWorkspaceActions(agentId)
  const [settingFolder, setSettingFolder] = useState(false)
  const [folder, setFolder] = useState('')

  function submitFolder(event: FormEvent) {
    event.preventDefault()
    actions.setRoot.mutate(folder.trim(), { onSuccess: () => setSettingFolder(false) })
  }
  const folderForm = (
    <form className="ws-folder-form" aria-label="Set folder" onSubmit={submitFolder}>
      <label>
        Folder on this computer
        <input
          required
          autoFocus
          value={folder}
          maxLength={4096}
          placeholder="/home/you/projects/example"
          onChange={(event) => setFolder(event.target.value)}
        />
      </label>
      {actions.setRoot.isError && (
        <p role="alert">{workspaceFailure(actions.setRoot.error, 'set the folder')}</p>
      )}
      <div className="ws-actions">
        <button
          type="submit"
          className="team-primary"
          disabled={actions.setRoot.isPending || !folder.trim()}
        >
          {actions.setRoot.isPending ? 'Saving…' : 'Use this folder'}
        </button>
        {settingFolder && (
          <button type="button" onClick={() => setSettingFolder(false)}>
            Cancel
          </button>
        )}
      </div>
      <p className="team-muted">
        The folder must already exist. Score never creates it, and won’t use your home folder or the
        Hermes, Score or SSH folders.
      </p>
    </form>
  )

  if (info.isPending) return <p role="status">Loading workspace…</p>
  if (info.isError)
    return (
      <section className="team-card" role="alert">
        <h2>Workspace</h2>
        <p>
          {info.error instanceof ApiError && info.error.code === 'not_paired'
            ? 'Pair this browser using the link in the server terminal to see the workspace.'
            : 'Couldn’t load the workspace.'}
        </p>
        <button type="button" onClick={() => void info.refetch()}>
          Try again
        </button>
      </section>
    )
  if (!info.data.available || info.data.root === null)
    return (
      <section className="team-card" aria-labelledby="ws-heading">
        <h2 id="ws-heading">Workspace</h2>
        <p role="status" className="ws-unavailable">
          {info.data.reason ?? 'The workspace is unavailable.'}
        </p>
        {canSetFolder && folderForm}
      </section>
    )
  return (
    <WorkspaceRootContext.Provider value={info.data.root}>
      <Browser
        key={info.data.root}
        agentId={agentId}
        agentName={agentName}
        initialPath={initialPath}
        root={info.data.root}
        settingFolder={settingFolder}
        onSetFolder={() => {
          setFolder(info.data.root ?? '')
          setSettingFolder(true)
        }}
        folderForm={folderForm}
        canSetFolder={canSetFolder}
      />
    </WorkspaceRootContext.Provider>
  )
}
