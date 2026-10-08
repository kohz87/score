import type { AgentDetail } from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import {
  fileKey,
  filePath,
  parseConflict,
  parseDiff,
  parseEtag,
  useAgentFile,
  type AgentFileName,
} from './file-queries.ts'
import { newId } from '../../data/ids.ts'

const labels = {
  'SOUL.md': { title: 'Personality', blurb: 'Who this agent is and how it talks.' },
  'AGENTS.md': { title: 'Operating rules', blurb: 'Standing rules this agent follows.' },
} satisfies Record<AgentFileName, { title: string; blurb: string }>

function DiffView({ diff, label }: { diff: string; label: string }) {
  if (!diff) return <p className="team-muted-strong">No changes.</p>
  return (
    <pre className="team-diff" aria-label={label} tabIndex={0}>
      {diff
        .replace(/\n$/, '')
        .split('\n')
        .map((line, index) => (
          <span
            key={index}
            data-kind={
              line.startsWith('@@')
                ? 'hunk'
                : line[0] === '+'
                  ? 'add'
                  : line[0] === '-'
                    ? 'del'
                    : 'ctx'
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
    </pre>
  )
}

// A draft keeps the content and etag it was based on, so switching files (which drops the query cache)
// can never rebase old text onto a newer server version.
export type FileDraft = { text: string; base: { content: string; etag: string } }

export function AgentFiles({
  agent,
  file,
  onFile,
}: {
  agent: AgentDetail
  file: AgentFileName
  onFile: (file: AgentFileName) => void
}) {
  // Drafts live here so switching between the two files does not lose edits.
  const [drafts, setDrafts] = useState<Partial<Record<AgentFileName, FileDraft>>>({})
  const dirty = (name: AgentFileName) => {
    const draft = drafts[name]
    return draft !== undefined && draft.text !== draft.base.content
  }
  return (
    <section className="team-card" aria-labelledby="team-files-heading">
      <div className="team-card-heading">
        <h2 id="team-files-heading">{labels[file].title}</h2>
        <div className="team-segment" role="group" aria-label="File to edit">
          {(['SOUL.md', 'AGENTS.md'] as const).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={file === name}
              onClick={() => onFile(name)}
            >
              {labels[name].title} · {name}
              {dirty(name) && ' (unsaved)'}
            </button>
          ))}
        </div>
      </div>
      <p className="team-muted-strong">{labels[file].blurb}</p>
      <FileEditor
        key={file}
        agentId={agent.id}
        file={file}
        draft={drafts[file]}
        onDraft={(value) =>
          setDrafts((current) => {
            const next = { ...current }
            if (value === undefined) delete next[file]
            else next[file] = value
            return next
          })
        }
      />
    </section>
  )
}

function FileEditor({
  agentId,
  file,
  draft,
  onDraft,
}: {
  agentId: string
  file: AgentFileName
  draft: FileDraft | undefined
  onDraft: (value: FileDraft | undefined) => void
}) {
  const queryClient = useQueryClient()
  const loaded = useAgentFile(agentId, file)
  const [preview, setPreview] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ etag: string; diff: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const base = draft?.base ?? loaded.data
  const value = draft?.text ?? base?.content ?? ''
  const changed = base !== undefined && value !== base.content
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
  })

  const previewMutation = useMutation({
    mutationFn: async () =>
      parseDiff(
        await apiFetch(`${filePath(agentId, file)}/preview`, {
          method: 'POST',
          body: JSON.stringify({ content: value }),
        }),
      ),
    onSuccess: setPreview,
  })
  const save = useMutation({
    mutationFn: async (submit: { content: string; etag: string }) => {
      return parseEtag(
        await apiFetch(filePath(agentId, file), {
          method: 'PUT',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify(submit),
        }),
      )
    },
    onSuccess(etag, submit) {
      queryClient.setQueryData(fileKey(agentId, file), { content: submit.content, etag })
      void queryClient.invalidateQueries({ queryKey: ['team', 'detail', agentId], exact: true })
      // Edits typed while the request was in flight stay a draft on top of what was saved.
      if (latest.current === submit.content) onDraft(undefined)
      else onDraft({ text: latest.current, base: { content: submit.content, etag } })
      setPreview(null)
      setConflict(null)
      setSaved(latest.current === submit.content)
    },
    onError(error) {
      if (error instanceof ApiError && error.status === 409) {
        const details = parseConflict(error.details)
        if (details) {
          setConflict(details)
          setSaved(false)
        }
      }
    },
  })
  async function reloadTheirs() {
    const result = await loaded.refetch()
    if (result.data) {
      onDraft(undefined)
      setConflict(null)
      setPreview(null)
      save.reset()
    }
  }

  if (loaded.isPending) return <p role="status">Loading {file}…</p>
  if (loaded.isError || !loaded.data)
    return (
      <div role="alert">
        <p>Could not load {file}.</p>
        <button type="button" onClick={() => void loaded.refetch()}>
          Try again
        </button>
      </div>
    )
  const fresh = loaded.data
  const data = base ?? fresh
  const failure =
    save.isError && !conflict
      ? save.error instanceof ApiError && save.error.code === 'not_paired'
        ? 'Pair this browser using the link in the server terminal to save changes.'
        : save.error instanceof ApiError && save.error.status === 413
          ? `${file} is larger than 256 KB.`
          : 'Could not save. Please try again.'
      : null
  return (
    <form
      className="team-file-editor"
      onSubmit={(event) => {
        event.preventDefault()
        setSaved(false)
        save.mutate({ content: value, etag: data.etag })
      }}
    >
      <label htmlFor={`file-${file}`} className="team-visually-hidden">
        {file} contents
      </label>
      <textarea
        id={`file-${file}`}
        className="team-file-text"
        spellCheck={false}
        value={value}
        onChange={(event) => {
          const text = event.target.value
          onDraft(
            text === data.content && data.etag === fresh.etag ? undefined : { text, base: data },
          )
          setPreview(null)
          setSaved(false)
        }}
      />
      <div className="team-file-actions">
        <button
          type="button"
          disabled={!changed || previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          Preview changes
        </button>
        <button type="submit" className="team-primary" disabled={!changed || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {changed && (
          <button
            type="button"
            onClick={() => {
              onDraft(undefined)
              setPreview(null)
              setConflict(null)
            }}
          >
            Discard changes
          </button>
        )}
        <span role="status" className="team-muted-strong">
          {saved ? `Saved ${file}.` : ''}
        </span>
      </div>
      {previewMutation.isError && <p role="alert">Could not preview changes. Please try again.</p>}
      {failure && <p role="alert">{failure}</p>}
      {preview !== null && !conflict && (
        <div>
          <h3>Changes</h3>
          <DiffView diff={preview} label="Changes to save" />
        </div>
      )}
      {conflict && (
        <div className="team-conflict" role="alert">
          <h3>{file} changed while you were editing</h3>
          <p>
            Someone else saved a newer version. This is what would change if your version replaced
            theirs.
          </p>
          <DiffView diff={conflict.diff} label="Their version compared with yours" />
          <div className="team-file-actions">
            <button type="button" onClick={() => void reloadTheirs()}>
              Reload theirs
            </button>
            <button
              type="button"
              className="team-primary"
              disabled={save.isPending}
              onClick={() => {
                setSaved(false)
                save.mutate({ content: value, etag: conflict.etag })
              }}
            >
              Overwrite with mine
            </button>
          </div>
        </div>
      )}
    </form>
  )
}
