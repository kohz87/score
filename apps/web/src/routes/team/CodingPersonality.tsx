import { CODING_INSTRUCTIONS_MAX, CodingAgentSchema, type CodingAgent } from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
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
  facts,
}: {
  coding: CodingAgent
  onChanged: () => void
  /** The facts column on the right (CLI, workspace, quota source), like a Hermes agent's card. */
  facts?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  return (
    <section
      className="team-card team-personality"
      aria-labelledby="coding-personality"
      data-protected="block"
    >
      <div className="team-personality-text">
        <div className="team-card-heading">
          <h2 id="coding-personality">Personality</h2>
          <span className="team-muted">Given to the CLI at the start of each session</span>
        </div>
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
            <p className="coding-role">{coding.role || 'No role yet'}</p>
            {coding.instructions.trim() ? (
              <div className="coding-instructions" aria-label="Instructions">
                <Markdown text={coding.instructions} />
              </div>
            ) : (
              <p className="team-muted-strong">
                No instructions yet. Use Edit personality to add how this agent should work and
                talk.
              </p>
            )}
            <button type="button" className="team-text-action" onClick={() => setEditing(true)}>
              Edit personality
            </button>
          </>
        )}
      </div>
      {facts}
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
  // Untouched instructions follow the stored text; the first edit pins the etag the draft was started from, which
  // changes only by choosing "Reload theirs" or "Overwrite with mine".
  const [draft, setDraft] = useState<string | null>(null)
  const [baseEtag, setBaseEtag] = useState<string | null>(null)
  // Stored etags the editor has already dealt with; any other one arriving from a refresh is a change to decide on.
  const [seen, setSeen] = useState<string[]>([])
  const [saveConflict, setSaveConflict] = useState<Conflict | null>(null)
  const text = draft ?? coding.instructions
  const etag = baseEtag ?? coding.instructionsEtag
  // A change saved elsewhere that reached this page through a refresh while the draft was open.
  const incoming: Conflict | null =
    draft !== null && !seen.includes(coding.instructionsEtag)
      ? { etag: coding.instructionsEtag, instructions: coding.instructions }
      : null
  const conflict = saveConflict ?? incoming
  const unchanged = role === coding.role && draft === null
  const save = useMutation({
    mutationFn: async (base: string) =>
      CodingAgentSchema.parse(
        await apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            role,
            ...(draft !== null ? { instructions: draft, instructionsEtag: base } : {}),
          }),
        }),
      ),
    onSuccess: onDone,
    onError(error) {
      if (error instanceof ApiError && error.status === 409) {
        const details = conflictOf(error.details)
        if (details) setSaveConflict(details)
      }
    },
  })
  const failure =
    save.isError && !saveConflict
      ? save.error instanceof ApiError && save.error.code === 'not_paired'
        ? 'Pair this browser using the link in the server terminal to save changes.'
        : 'Couldn’t save. Check the length and try again.'
      : null
  return (
    <form
      className="team-file-editor team-routine-form"
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
        onChange={(event) => {
          if (draft === null) {
            setBaseEtag(coding.instructionsEtag)
            setSeen([coding.instructionsEtag])
          }
          setDraft(event.target.value)
        }}
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
                // Theirs replaces the draft: from here on it follows the stored text again unless edited.
                setDraft(saveConflict ? conflict.instructions : null)
                setBaseEtag(saveConflict ? conflict.etag : null)
                setSeen((list) => [...list, conflict.etag])
                setSaveConflict(null)
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
                setBaseEtag(conflict.etag)
                setSeen((list) => [...list, conflict.etag])
                setSaveConflict(null)
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
          disabled={save.isPending || unchanged || incoming !== null}
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
