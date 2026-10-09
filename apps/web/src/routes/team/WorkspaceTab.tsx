import { useRef, useState, type CSSProperties, type DragEvent, type FormEvent } from 'react'
import { ApiError } from '../../data/api.ts'
import { useTreeWidth, MAX_TREE, MIN_TREE } from './workspace-split.ts'
import { discardDraftsUnder, WorkspaceFile } from './WorkspaceFile.tsx'
import { join, parentOf, TreeLevel, type Selection } from './WorkspaceTree.tsx'
import {
  useGitStatus,
  useWorkspace,
  useWorkspaceActions,
  workspaceFailure,
  WorkspaceRootContext,
} from './workspace-queries.ts'
import './workspace.css'

type Panel = 'new-file' | 'new-folder' | 'rename' | 'delete' | null

export function WorkspaceTab({
  agentId,
  agentName,
  initialPath = null,
}: {
  agentId: string
  agentName: string
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
        The folder must already exist. Score never creates it, and refuses your home folder, Hermes,
        Score and SSH folders.
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
            : 'Could not load the workspace.'}
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
        {folderForm}
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
      />
    </WorkspaceRootContext.Provider>
  )
}

function Browser({
  agentId,
  agentName,
  initialPath,
  root,
  settingFolder,
  onSetFolder,
  folderForm,
}: {
  agentId: string
  agentName: string
  initialPath: string | null
  root: string
  settingFolder: boolean
  onSetFolder: () => void
  folderForm: React.ReactNode
}) {
  const actions = useWorkspaceActions(agentId)
  const git = useGitStatus(agentId).data
  const start = initialPath?.replace(/^\/+|\/+$/g, '') || null
  const [selected, setSelected] = useState<Selection | null>(
    start ? { path: start, kind: 'file' } : null,
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(start ? ancestors(start) : []),
  )
  const [screen, setScreen] = useState<'tree' | 'file'>(start ? 'file' : 'tree')
  const [panel, setPanel] = useState<Panel>(null)
  const [name, setName] = useState('')
  const [typed, setTyped] = useState('')
  const [needsTyping, setNeedsTyping] = useState(false)
  const [notice, setNotice] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const split = useTreeWidth(grid)

  const dir = selected ? (selected.kind === 'dir' ? selected.path : parentOf(selected.path)) : ''
  const crumbs = selected ? selected.path.split('/') : []

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  function open(next: Selection) {
    setSelected(next)
    setPanel(null)
    setNotice('')
    if (next.kind === 'file') setScreen('file')
  }
  function openPanel(next: Panel) {
    setPanel(next)
    setNotice('')
    setNeedsTyping(false)
    setTyped('')
    actions.create.reset()
    actions.move.reset()
    actions.remove.reset()
    setName(next === 'rename' && selected ? selected.path.split('/').at(-1)! : '')
  }
  function expandTo(path: string) {
    setExpanded((current) => new Set([...current, ...ancestors(path)]))
  }
  function submitName(event: FormEvent) {
    event.preventDefault()
    const clean = name.trim()
    if (panel === 'rename' && selected) {
      const to = join(parentOf(selected.path), clean)
      actions.move.mutate(
        { from: selected.path, to },
        {
          onSuccess: () => {
            discardDraftsUnder(root, agentId, selected.path)
            setSelected({ path: to, kind: selected.kind })
            setPanel(null)
            setNotice('Renamed.')
          },
        },
      )
      return
    }
    const kind = panel === 'new-folder' ? 'dir' : 'file'
    const path = join(dir, clean)
    actions.create.mutate(
      { path, kind },
      {
        onSuccess: () => {
          expandTo(join(path, 'x'))
          setSelected({ path, kind })
          setPanel(null)
          setNotice(kind === 'dir' ? 'Folder created.' : 'File created.')
          if (kind === 'file') setScreen('file')
        },
      },
    )
  }
  function confirmDelete(recursive: boolean) {
    if (!selected) return
    actions.remove.mutate(
      { path: selected.path, recursive },
      {
        onSuccess: () => {
          discardDraftsUnder(root, agentId, selected.path)
          setSelected(null)
          setPanel(null)
          setScreen('tree')
          setNotice('Deleted.')
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'not_empty') setNeedsTyping(true)
        },
      },
    )
  }
  async function upload(files: File[]) {
    setNotice('')
    for (const file of files) {
      try {
        await actions.upload.mutateAsync({ path: join(dir, file.name), file })
        setNotice(`Uploaded ${file.name}.`)
      } catch {
        return
      }
    }
    expandTo(join(dir, 'x'))
  }
  function drop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    const dropped = Array.from(event.dataTransfer.files)
    if (dropped.length) void upload(dropped)
  }
  const failure =
    (actions.create.isError && workspaceFailure(actions.create.error, 'create it')) ||
    (actions.move.isError && workspaceFailure(actions.move.error, 'rename it')) ||
    (actions.remove.isError &&
      !needsTyping &&
      workspaceFailure(actions.remove.error, 'delete it')) ||
    (actions.upload.isError && workspaceFailure(actions.upload.error, 'upload the file'))

  return (
    <section className="team-card ws" aria-labelledby="ws-heading">
      <div className="team-card-heading">
        <h2 id="ws-heading">Workspace</h2>
        <button type="button" className="team-pill-button" onClick={onSetFolder}>
          Set folder
        </button>
      </div>
      <p className="ws-root">
        <span className="team-muted">{agentName} works in</span> <code>{root}</code>
        {git && (
          <span
            className="ws-git"
            aria-label={`Git branch ${git.branch}, ${git.changed} changed ${git.changed === 1 ? 'file' : 'files'}`}
          >
            <span aria-hidden="true">⎇ </span>
            {git.branch}
            <span className="ws-git-count">
              {git.changed === 0 ? 'clean' : `${git.changed} changed`}
            </span>
            {git.ahead > 0 && <span className="ws-git-count">↑{git.ahead}</span>}
            {git.behind > 0 && <span className="ws-git-count">↓{git.behind}</span>}
          </span>
        )}
      </p>
      {settingFolder && folderForm}
      <div
        ref={grid}
        className={`ws-grid ws-screen-${screen}`}
        style={{ '--ws-tree-width': `${split.width}px` } as CSSProperties}
      >
        <div
          className={`ws-tree-pane${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <div className="ws-toolbar" role="toolbar" aria-label="Workspace actions">
            <button type="button" onClick={() => openPanel('new-file')}>
              New file
            </button>
            <button type="button" onClick={() => openPanel('new-folder')}>
              New folder
            </button>
            <button type="button" onClick={() => picker.current?.click()}>
              Upload
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Upload files"
              onChange={(event) => {
                // Copy first: clearing the input empties the live list before the first upload finishes.
                const picked = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (picked.length) void upload(picked)
              }}
            />
            <button type="button" disabled={!selected} onClick={() => openPanel('rename')}>
              Rename
            </button>
            <button type="button" disabled={!selected} onClick={() => openPanel('delete')}>
              Delete
            </button>
          </div>
          {(panel === 'new-file' || panel === 'new-folder' || panel === 'rename') && (
            <form className="ws-name-form" onSubmit={submitName} aria-label={panel}>
              <label>
                {panel === 'rename'
                  ? 'New name'
                  : panel === 'new-file'
                    ? `New file in ${dir || 'the workspace folder'}`
                    : `New folder in ${dir || 'the workspace folder'}`}
                <input
                  required
                  autoFocus
                  value={name}
                  maxLength={255}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <div className="ws-actions">
                <button
                  type="submit"
                  className="team-primary"
                  disabled={!name.trim() || actions.create.isPending || actions.move.isPending}
                >
                  {panel === 'rename' ? 'Rename' : 'Create'}
                </button>
                <button type="button" onClick={() => setPanel(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {panel === 'delete' && selected && (
            <div className="ws-name-form" role="group" aria-label="Delete">
              {needsTyping ? (
                <>
                  <p>
                    <strong>{selected.path}</strong> is not empty. Type its name to delete it and
                    everything inside.
                  </p>
                  <input
                    aria-label="Type the folder name to confirm"
                    autoFocus
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                  <div className="ws-actions">
                    <button
                      type="button"
                      className="team-danger"
                      disabled={
                        typed !== selected.path.split('/').at(-1) || actions.remove.isPending
                      }
                      onClick={() => confirmDelete(true)}
                    >
                      Delete everything
                    </button>
                    <button type="button" onClick={() => setPanel(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    Delete <strong>{selected.path}</strong>? This cannot be undone.
                  </p>
                  <div className="ws-actions">
                    <button
                      type="button"
                      className="team-danger"
                      autoFocus
                      disabled={actions.remove.isPending}
                      onClick={() => confirmDelete(false)}
                    >
                      Confirm delete
                    </button>
                    <button type="button" onClick={() => setPanel(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {failure && <p role="alert">{failure}</p>}
          <p className="team-muted" role="status">
            {actions.upload.isPending ? 'Uploading…' : notice}
          </p>
          <TreeLevel
            agentId={agentId}
            path=""
            depth={0}
            expanded={expanded}
            selected={selected}
            onToggle={toggle}
            onSelect={open}
          />
          <p className="ws-note">
            Files such as .env and keys are hidden. Other secrets can still be visible: keep them
            out of the workspace.
          </p>
        </div>
        <div
          className="ws-separator"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the file list"
          aria-valuemin={MIN_TREE}
          aria-valuemax={MAX_TREE}
          aria-valuenow={split.width}
          tabIndex={0}
          {...split.handlers}
        />
        <div className="ws-file-pane">
          <button
            type="button"
            className="ws-back team-pill-button"
            onClick={() => setScreen('tree')}
          >
            ‹ Files
          </button>
          <nav className="ws-crumbs" aria-label="Location">
            <button type="button" onClick={() => setSelected(null)}>
              workspace
            </button>
            {crumbs.map((part, index) => {
              const path = crumbs.slice(0, index + 1).join('/')
              const last = index === crumbs.length - 1
              return (
                <span key={path}>
                  <span aria-hidden="true"> / </span>
                  {last ? (
                    <span aria-current="page">{part}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSelected({ path, kind: 'dir' })
                        setScreen('tree')
                      }}
                    >
                      {part}
                    </button>
                  )}
                </span>
              )
            })}
          </nav>
          {selected?.kind === 'file' ? (
            <WorkspaceFile key={selected.path} agentId={agentId} path={selected.path} />
          ) : (
            <p className="ws-note ws-placeholder">
              {selected ? 'Pick a file to preview or edit it.' : 'Pick a file from the list.'}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}
