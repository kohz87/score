import { useEffect, useRef, useState } from 'react'
import {
  conflictOf,
  fetchFile,
  fileUrl,
  isImagePath,
  isPdfPath,
  useFile,
  useWorkspaceActions,
  workspaceFailure,
  type LoadedFile,
} from './workspace-queries.ts'

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type Disk = { etag: string | null; content: string | null }

/** Preview for images, PDFs and binaries; a text file opens in the editor. */
export function WorkspaceFile({ agentId, path }: { agentId: string; path: string }) {
  const image = isImagePath(path)
  const pdf = isPdfPath(path)
  const file = useFile(agentId, path, !image && !pdf)
  const download = fileUrl(agentId, path, true)
  const [imageFailed, setImageFailed] = useState(false)
  if (image)
    return (
      <div className="ws-preview">
        {imageFailed ? (
          <p className="ws-note">This is not a picture Score can show.</p>
        ) : (
          <img src={fileUrl(agentId, path)} alt={path} onError={() => setImageFailed(true)} />
        )}
        <a className="team-pill-button" href={download}>
          Download
        </a>
      </div>
    )
  if (pdf)
    return (
      <div className="ws-preview">
        <p className="ws-note">PDF files open in their own tab.</p>
        <div className="ws-actions">
          <a
            className="team-pill-button"
            href={fileUrl(agentId, path)}
            target="_blank"
            rel="noreferrer"
          >
            Open PDF
          </a>
          <a className="team-pill-button" href={download}>
            Download
          </a>
        </div>
      </div>
    )
  if (file.isPending) return <p role="status">Loading file…</p>
  if (file.isError)
    return (
      <p role="alert">
        {workspaceFailure(file.error, 'open this file')}{' '}
        <button type="button" onClick={() => void file.refetch()}>
          Try again
        </button>
      </p>
    )
  if (file.data.kind === 'binary')
    return (
      <div className="ws-preview">
        <p className="ws-note">
          {file.data.reason === 'too_large'
            ? `This file is too large to open here (${size(file.data.size)}).`
            : `This is not a text file (${size(file.data.size)}).`}
        </p>
        <a className="team-pill-button" href={download}>
          Download
        </a>
      </div>
    )
  return <Editor key={path} agentId={agentId} path={path} latest={file.data} />
}

function Editor({
  agentId,
  path,
  latest,
}: {
  agentId: string
  path: string
  latest: Extract<LoadedFile, { kind: 'text' }>
}) {
  const { save } = useWorkspaceActions(agentId)
  const [base, setBase] = useState({ content: latest.content, etag: latest.etag })
  const [draft, setDraft] = useState(latest.content)
  const [disk, setDisk] = useState<Disk | null>(null)
  const [comparing, setComparing] = useState(false)
  const [notice, setNotice] = useState('')
  const dirty = draft !== base.content
  const draftRef = useRef(draft)
  draftRef.current = draft
  const baseRef = useRef(base)
  baseRef.current = base
  const seen = useRef(latest.etag)

  // The agent (or anything else) changed the file: follow it when there is nothing to lose, warn otherwise.
  useEffect(() => {
    if (latest.etag === seen.current) return
    seen.current = latest.etag
    const current = baseRef.current
    if (latest.etag === current.etag) return
    if (draftRef.current === current.content) {
      setBase({ content: latest.content, etag: latest.etag })
      setDraft(latest.content)
      setNotice('Updated: this file changed on disk.')
    } else setDisk({ etag: latest.etag, content: latest.content })
  }, [latest])

  function submit(etag: string | null = base.etag) {
    setNotice('')
    save.mutate(
      { path, content: draft, etag },
      {
        onSuccess: (next) => {
          setBase({ content: draft, etag: next })
          setDisk(null)
          setComparing(false)
          setNotice('Saved.')
        },
        onError: async (error) => {
          const conflict = conflictOf(error)
          if (!conflict) return
          // Fetch what is on disk now so "Compare" has something to show.
          const current = await fetchFile(agentId, path).catch(() => null)
          setDisk({
            etag: conflict.etag,
            content: current?.kind === 'text' ? current.content : null,
          })
        },
      },
    )
  }
  function reload() {
    if (disk?.content != null && disk.etag) {
      setBase({ content: disk.content, etag: disk.etag })
      setDraft(disk.content)
    }
    setDisk(null)
    setComparing(false)
    setNotice('Reloaded from disk.')
  }

  return (
    <div className="ws-editor">
      {disk && (
        <div className="ws-conflict" role="alert">
          <p>
            <strong>Changed on disk.</strong>{' '}
            {disk.etag === null
              ? 'The file was removed while you were editing.'
              : 'Someone or something saved this file after you opened it.'}
          </p>
          <div className="ws-actions">
            <button
              type="button"
              onClick={reload}
              disabled={disk.content === null || disk.etag === null}
            >
              Reload from disk
            </button>
            <button type="button" onClick={() => submit(disk.etag)} disabled={save.isPending}>
              Overwrite with my version
            </button>
            <button type="button" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>
              Compare
            </button>
          </div>
          {comparing && (
            <div className="ws-compare">
              <label>
                On disk
                <textarea readOnly value={disk.content ?? '(unavailable)'} />
              </label>
              <label>
                My version
                <textarea readOnly value={draft} />
              </label>
            </div>
          )}
        </div>
      )}
      <textarea
        className="ws-textarea"
        aria-label={`Contents of ${path}`}
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            if (dirty && !save.isPending) submit()
          }
        }}
      />
      <div className="ws-actions">
        <button
          type="button"
          className="team-primary"
          disabled={!dirty || save.isPending}
          onClick={() => submit()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button type="button" onClick={() => setDraft(base.content)}>
            Discard changes
          </button>
        )}
        <span className="team-muted" role="status">
          {dirty ? 'Unsaved changes' : notice}
        </span>
      </div>
      {save.isError && !conflictOf(save.error) && (
        <p role="alert">{workspaceFailure(save.error, 'save this file')}</p>
      )}
    </div>
  )
}
