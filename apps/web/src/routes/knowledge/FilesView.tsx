import type { AgentSummary, KnowledgeTree } from '@score/contract'
import type { KnowledgeExportRequest } from '@score/contract'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AuthorLabel } from './NotePanels.tsx'
import { fileHref, formatBytes, TYPE_LABEL, ACCEPT_FILES } from './knowledge-files.ts'
import { noteDownloadHref } from './knowledge-export.ts'
import { baseName, folderOf, noteUrl, timeAgo } from './knowledge-paths.ts'

type Row =
  | { kind: 'folder'; path: string; name: string }
  | {
      kind: 'note' | 'document'
      path: string
      name: string
      typeLabel: string
      size: number | null
      mtime: string
      lastAuthor: import('@score/contract').KnowledgeAuthor | null
      versioned: boolean
    }

/** The Knowledge file manager: one folder at a time, every note and document with its size, type, date and author. */
export function FilesView({
  tree,
  folder,
  agents,
  onOpenPath,
  busy,
  onOpenFolder,
  onUpload,
  onNewFolder,
  onMove,
  onDelete,
  onDeleteFolder,
  onRenameFolder,
  exporting,
  onExport,
}: {
  tree: KnowledgeTree
  folder: string
  agents: AgentSummary[]
  /** Where a file opens. The classic page uses the router; the bold Library stays in its panel. */
  onOpenPath?: (path: string) => void
  busy: boolean
  onOpenFolder: (folder: string) => void
  onUpload: (files: File[], folder: string) => void
  onNewFolder: (parent: string) => void
  onMove: (path: string) => void
  onDelete: (path: string) => void
  /** Opens the delete-folder confirmation (3.14.5: a folder with things in it can be deleted too). */
  onDeleteFolder: (path: string) => void
  /** 3.14.5: rename or move a folder with everything in it. */
  onRenameFolder: (path: string) => void
  exporting: boolean
  onExport: (request: KnowledgeExportRequest) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState<string | null>(null)
  const [pick, setPick] = useState<{ folder: string; paths: Set<string> }>({
    folder,
    paths: new Set(),
  })
  const rows = useMemo<Row[]>(() => {
    const folders = tree.folders
      .filter((path) => folderOf(path) === folder)
      .map((path): Row => ({ kind: 'folder', path, name: path.split('/').pop()! }))
    const notes = tree.notes
      .filter((note) => folderOf(note.path) === folder)
      .map((note): Row => ({
        kind: 'note',
        path: note.path,
        name: note.path.split('/').pop()!,
        typeLabel: TYPE_LABEL.note,
        size: null,
        mtime: note.mtime,
        lastAuthor: note.lastAuthor,
        versioned: true,
      }))
    const documents = tree.documents
      .filter((document) => folderOf(document.path) === folder)
      .map((document): Row => ({
        kind: 'document',
        path: document.path,
        name: document.path.split('/').pop()!,
        typeLabel: TYPE_LABEL[document.type],
        size: document.size,
        mtime: document.mtime,
        lastAuthor: document.lastAuthor,
        versioned: document.versioned,
      }))
    const byName = (a: Row, b: Row) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    return [...folders.sort(byName), ...[...notes, ...documents].sort(byName)]
  }, [tree, folder])
  // A selection belongs to the folder it was made in.
  const picked = pick.folder === folder ? pick.paths : new Set<string>()
  // Files can disappear (an agent moves one); only paths still listed stay selected.
  const files = rows.filter((row) => row.kind !== 'folder')
  const selected = files.filter((row) => picked.has(row.path))
  const toggle = (path: string) =>
    setPick(() => {
      const next = new Set(picked)
      if (!next.delete(path)) next.add(path)
      return { folder, paths: next }
    })
  const crumbs = folder === '' ? [] : folder.split('/')

  return (
    <section
      className={`kn-files${over === folder ? ' is-drop' : ''}`}
      aria-label="Files"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setOver((current) => current ?? folder)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        const target = over ?? folder
        setOver(null)
        onUpload([...event.dataTransfer.files], target)
      }}
    >
      <header className="kn-note-head">
        <div>
          <h2>Files</h2>
          <nav aria-label="Folder" className="kn-crumbs">
            <button
              type="button"
              onClick={() => onOpenFolder('')}
              aria-current={folder === '' ? 'page' : undefined}
            >
              Knowledge
            </button>
            {crumbs.map((name, index) => {
              const path = crumbs.slice(0, index + 1).join('/')
              return (
                <span key={path}>
                  <span aria-hidden="true"> / </span>
                  <button
                    type="button"
                    onClick={() => onOpenFolder(path)}
                    aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                  >
                    {name}
                  </button>
                </span>
              )
            })}
          </nav>
        </div>
        <div className="kn-actions">
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept={ACCEPT_FILES}
            data-testid="kn-upload-input"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              if (files.length > 0) onUpload(files, folder)
            }}
          />
          <button
            type="button"
            className="kn-primary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? 'Uploading…' : 'Upload files'}
          </button>
          <button type="button" onClick={() => onNewFolder(folder)}>
            New folder
          </button>
          {folder !== '' && (
            <>
              <button type="button" onClick={() => onRenameFolder(folder)}>
                Rename folder
              </button>
              <button type="button" onClick={() => onDeleteFolder(folder)}>
                Delete folder
              </button>
            </>
          )}
          {selected.length > 0 && (
            <button
              type="button"
              disabled={exporting}
              onClick={() => onExport({ paths: selected.map((row) => row.path) })}
            >
              {exporting ? 'Preparing…' : `Download selected (${selected.length})`}
            </button>
          )}
          <button
            type="button"
            disabled={exporting}
            onClick={() => onExport(folder === '' ? { all: true } : { folder })}
          >
            {exporting ? 'Preparing…' : folder === '' ? 'Export all files' : 'Export this folder'}
          </button>
        </div>
      </header>
      <p className="kn-muted">
        Drop files here to add them to {folder === '' ? 'Knowledge' : <code>{folder}</code>}. Notes
        (.md, .txt), PDF, DOCX, CSV, JSON, HTML, images and zip files, up to 256 MB each.
      </p>
      {rows.length === 0 ? (
        <p className="kn-muted">This folder is empty.</p>
      ) : (
        <div className="kn-table-wrap" tabIndex={0} role="region" aria-label="Files in this folder">
          <table className="kn-table">
            <thead>
              <tr>
                <th scope="col" className="kn-select">
                  <input
                    type="checkbox"
                    aria-label="Select all files in this folder"
                    checked={files.length > 0 && selected.length === files.length}
                    disabled={files.length === 0}
                    onChange={(event) =>
                      setPick({
                        folder,
                        paths: event.target.checked
                          ? new Set(files.map((row) => row.path))
                          : new Set(),
                      })
                    }
                  />
                </th>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Size</th>
                <th scope="col">Modified</th>
                <th scope="col">By</th>
                <th scope="col">
                  <span className="kn-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                row.kind === 'folder' ? (
                  <tr
                    key={`f:${row.path}`}
                    className={over === row.path ? 'is-drop' : ''}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes('Files')) return
                      event.preventDefault()
                      event.stopPropagation()
                      setOver(row.path)
                    }}
                  >
                    <td className="kn-select" />
                    <td>
                      <button
                        type="button"
                        className="kn-link-button"
                        onClick={() => onOpenFolder(row.path)}
                      >
                        <span aria-hidden="true">▸ </span>
                        {row.name}
                      </button>
                      {/* Beside the name, so a narrow panel never scrolls them out of sight (3.14.5). */}
                      <span className="kn-folder-actions">
                        <button
                          type="button"
                          aria-label={`Rename ${row.name}`}
                          onClick={() => onRenameFolder(row.path)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${row.name}`}
                          onClick={() => onDeleteFolder(row.path)}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                    <td>Folder</td>
                    <td />
                    <td />
                    <td />
                    <td className="kn-row-actions" />
                  </tr>
                ) : (
                  <tr key={`${row.kind}:${row.path}`}>
                    <td className="kn-select">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.name}`}
                        checked={picked.has(row.path)}
                        onChange={() => toggle(row.path)}
                      />
                    </td>
                    <td>
                      {onOpenPath ? (
                        <button
                          type="button"
                          className="kn-link-button"
                          onClick={() => onOpenPath(row.path)}
                        >
                          {row.kind === 'note' ? baseName(row.path) : row.name}
                        </button>
                      ) : (
                        <Link to={noteUrl(row.path)}>
                          {row.kind === 'note' ? baseName(row.path) : row.name}
                        </Link>
                      )}
                      {!row.versioned && (
                        <span className="kn-type-badge" title="Stored without history">
                          no history
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="kn-type-badge">{row.typeLabel}</span>
                    </td>
                    <td>{row.size === null ? '' : formatBytes(row.size)}</td>
                    <td>{timeAgo(row.mtime)}</td>
                    <td>
                      <AuthorLabel author={row.lastAuthor} agents={agents} />
                    </td>
                    <td className="kn-row-actions">
                      <a
                        className="kn-button"
                        href={
                          row.kind === 'document'
                            ? fileHref(row.path, true)
                            : noteDownloadHref(row.path)
                        }
                        download
                        aria-label={`Download ${row.name}`}
                      >
                        Download
                      </a>
                      <button
                        type="button"
                        onClick={() => onMove(row.path)}
                        aria-label={`Rename or move ${row.name}`}
                      >
                        Move
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(row.path)}
                        aria-label={`Delete ${row.name}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
