import { useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { fetchNote, knowledgeFailure, useNote } from './knowledge-queries.ts'
import { Pane } from './NotePane.tsx'
import type { NoteWorkspaceProps as Props, Session } from './note-workspace-types.ts'

export function NoteWorkspace(props: Props) {
  const note = useNote(props.path)
  const [session, setSession] = useState<Session | null>(null)
  if (note.data && session === null)
    setSession({ body: note.data.body, etag: note.data.etag, version: 0 })

  // A failed *refresh* keeps the pane (and the text in it); only a note that never opened gets the error screen.
  if (note.isError && session === null) {
    const missing = note.error instanceof ApiError && note.error.status === 404
    return (
      <div className="kn-empty" role="alert">
        <h2>{missing ? 'This note doesn’t exist' : 'Couldn’t open this note'}</h2>
        <p className="kn-muted">
          {missing
            ? 'It may have been moved or deleted.'
            : knowledgeFailure(note.error, 'open the note')}
        </p>
        {missing && (
          <button
            type="button"
            className="kn-primary"
            onClick={() => props.onCreateLink(props.path)}
          >
            Create {props.path}
          </button>
        )}
      </div>
    )
  }
  if (!note.data || session === null) return <p role="status">Opening note…</p>
  return (
    <>
      {note.isError && (
        <p role="alert" className="kn-banner is-warn">
          {knowledgeFailure(note.error, 'refresh the note')} Your text is still here.
        </p>
      )}
      <Pane
        key={session.version}
        {...props}
        note={note.data}
        session={session}
        reload={async (beforeSwap) => {
          const fresh = await fetchNote(props.path)
          beforeSwap()
          setSession((previous) => ({
            body: fresh.body,
            etag: fresh.etag,
            version: (previous?.version ?? 0) + 1,
          }))
          void note.refetch()
        }}
      />
    </>
  )
}
