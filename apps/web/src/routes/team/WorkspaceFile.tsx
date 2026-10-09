import { lazy, Suspense, useContext, useEffect, useRef, useState } from 'react'
import { Markdown } from '../chat/Markdown.tsx'
import '../chat/chat.css'
import {
  conflictOf,
  fetchFile,
  fileUrl,
  WorkspaceRootContext,
  isImagePath,
  isPdfPath,
  useFile,
  useWorkspaceActions,
  workspaceFailure,
  type LoadedFile,
} from './workspace-queries.ts'

// CodeMirror is heavy: it loads when the first text file opens (as Knowledge does).
const CodeEditor = lazy(async () => ({
  default: (await import('../../components/CodeEditor.tsx')).CodeEditor,
}))
const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Unsaved edits per agent, folder and file: kept while another file is open or the tab is left, so switching never
// throws work away. A saved, discarded or deleted file drops its entry; closing the page asks first.
type Draft = { draft: string; base: { content: string; etag: string | null } }
const drafts = new Map<string, Draft>()
const draftKey = (agentId: string, root: string | undefined, path: string) =>
  `${agentId}\0${root ?? ''}\0${path}`
const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  if (drafts.size) event.preventDefault()
}
function setDraft(key: string, value: Draft | null): void {
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  window.removeEventListener('beforeunload', warnBeforeUnload)
  if (drafts.size) window.addEventListener('beforeunload', warnBeforeUnload)
}
/** A deleted or renamed file (or folder) has no draft any more. */
export function discardDraftsUnder(root: string | undefined, agentId: string, path: string): void {
  const prefix = draftKey(agentId, root, path)
  for (const key of [...drafts.keys()])
    if (key === prefix || key.startsWith(`${prefix}/`)) setDraft(key, null)
}

type Disk = { etag: string | null; content: string | null }

/** Preview for images, PDFs and binaries; a text file opens in the editor. */
export function WorkspaceFile({ agentId, path }: { agentId: string; path: string }) {
  const image = isImagePath(path)
  const pdf = isPdfPath(path)
  const root = useContext(WorkspaceRootContext)
  const file = useFile(agentId, path, !image && !pdf)
  const download = fileUrl(agentId, path, true, root)
  const [imageFailed, setImageFailed] = useState(false)
  if (image)
    return (
      <div className="ws-preview">
        {imageFailed ? (
          <p className="ws-note">This is not a picture Score can show.</p>
        ) : (
          <img
            src={fileUrl(agentId, path, false, root)}
            alt={path}
            onError={() => setImageFailed(true)}
          />
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
            href={fileUrl(agentId, path, false, root)}
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
  const root = useContext(WorkspaceRootContext)
  const key = draftKey(agentId, root, path)
  const kept = useRef(drafts.get(key)).current
  const [base, setBase] = useState<{ content: string; etag: string | null }>(
    kept ? kept.base : { content: latest.content, etag: latest.etag },
  )
  const [draft, setDraftText] = useState(kept ? kept.draft : latest.content)
  const [disk, setDisk] = useState<Disk | null>(null)
  const [comparing, setComparing] = useState(false)
  const [notice, setNotice] = useState(kept ? 'Restored your unsaved changes.' : '')
  const [preview, setPreview] = useState(false)
  const dirty = draft !== base.content
  const draftRef = useRef(draft)
  const dirtyRef = useRef(false)
  const baseRef = useRef(base)
  // Restored edits are compared with what is on disk now, like any change that lands while editing.
  const seen = useRef<string | null>(kept ? null : latest.etag)
  useEffect(() => {
    draftRef.current = draft
    baseRef.current = base
    dirtyRef.current = dirty
    setDraft(key, dirty ? { draft, base } : null)
  })

  // The agent (or anything else) changed the file: follow it when there is nothing to lose, warn otherwise.
  useEffect(() => {
    if (latest.etag === seen.current) return
    seen.current = latest.etag
    const current = baseRef.current
    if (latest.etag === current.etag) return
    if (draftRef.current === current.content) {
      setBase({ content: latest.content, etag: latest.etag })
      setDraftText(latest.content)
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
          const current = await fetchFile(agentId, path, undefined, root).catch(() => null)
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
      setDraftText(disk.content)
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
      {isMarkdownPath(path) && (
        <div className="ws-actions" role="group" aria-label="View">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
      )}
      {preview ? (
        <div className="ws-md-preview" aria-label={`Preview of ${path}`}>
          <Markdown text={draft} workspace={{ agentId, agentIds: [] }} />
        </div>
      ) : (
        <div className="ws-code">
          <Suspense fallback={<p role="status">Loading editor…</p>}>
            <CodeEditor
              value={draft}
              path={path}
              label={`Contents of ${path}`}
              onChange={setDraftText}
              onSave={() => {
                if (dirtyRef.current && !save.isPending) submit()
              }}
            />
          </Suspense>
        </div>
      )}
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
          <button type="button" onClick={() => setDraftText(base.content)}>
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
