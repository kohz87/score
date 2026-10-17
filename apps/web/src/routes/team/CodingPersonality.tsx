import { CODING_INSTRUCTIONS_MAX, CodingAgentSchema, type CodingAgent } from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { Markdown } from '../chat/Markdown.tsx'
import '../chat/chat.css'

type Conflict = { etag: string; instructions: string }
function conflictOf(details: unknown): Conflict | null {
  if (details === null || typeof details !== 'object') return null
  const { etag, instructions } = details as Record<string, unknown>
  return typeof etag === 'string' && typeof instructions === 'string'
    ? { etag, instructions }
    : null
}

/**
 * A coding agent's "Personality" card (PLAN 8.8, decision 94): the role line and the rendered instructions, with an
 * editor that saves against the etag it started from (like a Hermes agent's SOUL.md).
 */
export function CodingPersonality({
  coding,
  onChanged,
}: {
  coding: CodingAgent
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  return (
    <section className="team-card" aria-labelledby="coding-personality" data-protected="block">
      <div className="team-card-heading">
        <h2 id="coding-personality">Personality</h2>
        {!editing && (
          <button type="button" className="team-pill-button" onClick={() => setEditing(true)}>
            Edit personality
          </button>
        )}
      </div>
      <p className="team-muted-strong">
        Who this agent is and how it works. Score hands this to the CLI at the start of each
        session; it never writes it into the workspace.
      </p>
      {editing ? (
        <PersonalityEditor
          coding={coding}
          onDone={() => {
            setEditing(false)
            onChanged()
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="coding-role">{coding.role || 'No role set'}</p>
          {coding.instructions.trim() ? (
            <div className="coding-instructions" aria-label="Instructions">
              <Markdown text={coding.instructions} />
            </div>
          ) : (
            <p className="team-muted-strong">
              No instructions yet. Use Edit personality to add how this agent should work and talk.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function PersonalityEditor({
  coding,
  onDone,
  onCancel,
}: {
  coding: CodingAgent
  onDone: () => void
  onCancel: () => void
}) {
  const [role, setRole] = useState(coding.role)
  const [text, setText] = useState(coding.instructions)
  // The etag the text was loaded with; replaced only by choosing "Overwrite with mine".
  const [etag, setEtag] = useState(coding.instructionsEtag)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const unchanged = role === coding.role && text === coding.instructions
  const save = useMutation({
    mutationFn: async (base: string) =>
      CodingAgentSchema.parse(
        await apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            role,
            ...(text !== coding.instructions || base !== coding.instructionsEtag
              ? { instructions: text, instructionsEtag: base }
              : {}),
          }),
        }),
      ),
    onSuccess: onDone,
    onError(error) {
      if (error instanceof ApiError && error.status === 409) {
        const details = conflictOf(error.details)
        if (details) setConflict(details)
      }
    },
  })
  const failure =
    save.isError && !conflict
      ? save.error instanceof ApiError && save.error.code === 'not_paired'
        ? 'Pair this browser using the link in the server terminal to save changes.'
        : 'Couldn’t save. Check the length and try again.'
      : null
  return (
    <form
      className="team-file-editor"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate(etag)
      }}
    >
      <label>
        Role
        <input
          value={role}
          maxLength={2000}
          placeholder="For example: reviews build scripts"
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
      <label htmlFor="coding-instructions-text">Personality and instructions</label>
      <textarea
        id="coding-instructions-text"
        className="team-file-text"
        spellCheck={false}
        maxLength={CODING_INSTRUCTIONS_MAX}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <p className="team-muted">
        Markdown. {text.length.toLocaleString('en-GB')} of{' '}
        {CODING_INSTRUCTIONS_MAX.toLocaleString('en-GB')} characters.
      </p>
      {failure && <p role="alert">{failure}</p>}
      {conflict && (
        <div className="team-conflict" role="alert">
          <h3>These instructions changed while you were editing</h3>
          <p>
            Someone saved a newer version. Reload it to start from theirs, or overwrite it with
            yours.
          </p>
          <div className="team-file-actions">
            <button
              type="button"
              onClick={() => {
                setText(conflict.instructions)
                setEtag(conflict.etag)
                setConflict(null)
                save.reset()
              }}
            >
              Reload theirs
            </button>
            <button
              type="button"
              className="team-primary"
              disabled={save.isPending}
              onClick={() => {
                setEtag(conflict.etag)
                setConflict(null)
                save.mutate(conflict.etag)
              }}
            >
              Overwrite with mine
            </button>
          </div>
        </div>
      )}
      <div className="team-file-actions">
        <button
          type="submit"
          className="team-primary"
          disabled={save.isPending || (unchanged && etag === coding.instructionsEtag)}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
