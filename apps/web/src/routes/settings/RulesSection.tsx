import { useRef, useState, type FormEvent } from 'react'
import type { AgentSummary, ApprovalMode, PutRulesRequest, RulesResponse } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { useRules, useRulesActions } from './rules-queries.ts'

// What each Hermes approval style means for "Ask me", in plain words (design review 2.18, finding 1).
const styles: { mode: ApprovalMode; title: string; effect: string }[] = [
  {
    mode: 'smart',
    title: 'Guardian first',
    effect:
      'A guardian model reviews each risky command first. It may approve or block it, and asks you only when it is unsure. “Ask me” does not guarantee you see every request.',
  },
  {
    mode: 'manual',
    title: 'Always ask me',
    effect: 'Every risky command waits for your answer. Nothing is decided without you.',
  },
  {
    mode: 'off',
    title: 'Never ask',
    effect:
      'Risky commands run without asking. Only your Never rules still stop them. Use with care.',
  },
]

function failure(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return `Pair this browser using the link in the server terminal to ${action}.`
    if (error.status === 400)
      return 'Those rules were not accepted. Check the wording and try again.'
    if (error.status === 409)
      return 'Hermes changed these settings while Score was saving. Nothing was lost. Try again.'
  }
  return `Couldn’t ${action}. Try again.`
}

interface Draft {
  mode: ApprovalMode
  goAhead: string[]
  never: string[]
}
function fromServer(rules: RulesResponse): Draft {
  return {
    mode: rules.mode,
    goAhead: rules.goAhead.filter((rule) => !rule.readOnly).map((rule) => rule.id),
    never: rules.never.map((rule) => rule.pattern ?? rule.label),
  }
}
const sameDraft = (a: Draft, b: Draft) =>
  a.mode === b.mode &&
  a.goAhead.length === b.goAhead.length &&
  a.goAhead.every((id) => b.goAhead.includes(id)) &&
  a.never.length === b.never.length &&
  a.never.every((glob) => b.never.includes(glob))
// Same normalisation as the server: one line, single spaces.
const normalise = (glob: string) => glob.trim().replace(/\s+/g, ' ')

export function RulesSection({ agents }: { agents: AgentSummary[] }) {
  const rules = useRules()
  const { preview, save, apply } = useRulesActions()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [adding, setAdding] = useState(false)
  const [category, setCategory] = useState('')
  const [glob, setGlob] = useState('')
  const [reviewed, setReviewed] = useState<{ diff: string; request: PutRulesRequest } | null>(null)
  const diff = reviewed?.diff ?? null
  // Bumped on every edit so a slow preview for an older draft cannot be shown or saved.
  const revision = useRef(0)
  const [notice, setNotice] = useState('')

  const data = rules.data
  const base = data ? fromServer(data) : null
  const current = draft ?? base
  const dirty = Boolean(current && base && !sameDraft(current, base))
  const labels = new Map(
    [...(data?.goAhead ?? []), ...(data?.askMe ?? [])].map((rule) => [rule.id, rule.label]),
  )
  const edit = (next: Draft) => {
    revision.current += 1
    setDraft(next)
    setReviewed(null)
    setNotice('')
  }
  const request = (value: Draft): PutRulesRequest => ({
    mode: value.mode,
    goAhead: value.goAhead,
    never: value.never,
  })

  function addNever(event: FormEvent) {
    event.preventDefault()
    const value = normalise(glob)
    if (!current || !value || current.never.includes(value)) return
    edit({ ...current, never: [...current.never, value] })
    setGlob('')
  }
  function addGoAhead(event: FormEvent) {
    event.preventDefault()
    if (!current || !category || current.goAhead.includes(category)) return
    edit({ ...current, goAhead: [...current.goAhead, category] })
    setCategory('')
  }
  function review() {
    if (!current) return
    const asked = request(current)
    const at = revision.current
    preview.mutate(asked, {
      onSuccess: (text) => {
        if (revision.current === at) setReviewed({ diff: text, request: asked })
      },
    })
  }
  function commit() {
    if (!reviewed) return
    const at = revision.current
    save.mutate(reviewed.request, {
      onSuccess: (result) => {
        // An edit made while saving stays as an unsaved draft.
        if (revision.current === at) {
          revision.current += 1
          setDraft(null)
          setReviewed(null)
          setAdding(false)
        }
        setNotice(
          result.failed.length
            ? `Saved, but ${result.failed.join(', ')} couldn’t be updated. They are listed below.`
            : 'Saved for the whole team.',
        )
      },
    })
  }

  const drifting = (data?.drift ?? []).filter((item) => item.differs)
  const askMe = (data?.askMe ?? []).filter((rule) => !current?.goAhead.includes(rule.id))
  const unknown = (data?.goAhead ?? []).filter((rule) => rule.readOnly)

  return (
    <section id="rules" className="settings-card rules-card" aria-labelledby="settings-rules">
      <div>
        <h2 id="settings-rules">Rules and approvals</h2>
        <p className="rules-lead">
          What agents may do alone, what they ask you first, and what they never do. Agents can be
          stricter on their own page, never looser.
        </p>
      </div>
      {rules.status === 'pending' && <p role="status">Loading rules…</p>}
      {rules.status === 'error' && (
        <p role="alert">Couldn’t load the rules. Check that the Score server is running.</p>
      )}
      {current && data && (
        <>
          <fieldset className="rules-style">
            <legend>How “Ask me” works</legend>
            {styles.map((style) => (
              <label key={style.mode} className="rules-option">
                <input
                  type="radio"
                  name="approval-style"
                  checked={current.mode === style.mode}
                  onChange={() => edit({ ...current, mode: style.mode })}
                />
                <span>
                  <strong>{style.title}</strong>
                  <small>{style.effect}</small>
                </span>
              </label>
            ))}
            <p className="rules-note">
              When nobody is watching (routines and one-off runs), a command that would ask you is
              blocked instead.
            </p>
          </fieldset>

          <div className="rules-columns">
            <div className="rules-column" data-kind="go" role="group" aria-labelledby="rules-go">
              <span id="rules-go" className="rules-heading">
                Go ahead
              </span>
              {current.goAhead.length === 0 && unknown.length === 0 && (
                <span className="rules-empty">Nothing yet. Everything risky asks first.</span>
              )}
              {current.goAhead.map((id) => (
                <span key={id} className="rules-item">
                  <span>{labels.get(id) ?? id}</span>
                  <button
                    type="button"
                    className="rules-remove"
                    aria-label={`Ask me before: ${labels.get(id) ?? id}`}
                    onClick={() =>
                      edit({ ...current, goAhead: current.goAhead.filter((key) => key !== id) })
                    }
                  >
                    Ask me instead
                  </button>
                </span>
              ))}
              {unknown.map((rule) => (
                <span key={rule.id} className="rules-item">
                  <span>{rule.label}</span>
                  <small>Set in Hermes</small>
                </span>
              ))}
            </div>
            <div className="rules-column" data-kind="ask" role="group" aria-labelledby="rules-ask">
              <span id="rules-ask" className="rules-heading">
                Ask me
              </span>
              <span className="rules-empty">
                {askMe.length} kinds of risky commands. Anything listed in Go ahead or Never is
                excluded.
              </span>
              <details className="rules-details">
                <summary>Show the kinds of commands</summary>
                <ul>
                  {askMe.map((rule) => (
                    <li key={rule.id}>{rule.label}</li>
                  ))}
                </ul>
              </details>
            </div>
            <div
              className="rules-column"
              data-kind="never"
              role="group"
              aria-labelledby="rules-never"
            >
              <span id="rules-never" className="rules-heading">
                Never
              </span>
              {current.never.length === 0 && (
                <span className="rules-empty">No Never rules yet.</span>
              )}
              {current.never.map((pattern) => (
                <span key={pattern} className="rules-item">
                  <code>{pattern}</code>
                  <button
                    type="button"
                    className="rules-remove"
                    aria-label={`Remove Never rule ${pattern}`}
                    onClick={() =>
                      edit({ ...current, never: current.never.filter((item) => item !== pattern) })
                    }
                  >
                    Remove
                  </button>
                </span>
              ))}
            </div>
          </div>
          <p className="rules-note">
            Never rules are guardrails, not a security boundary. They match the command text, so an
            alias, a subshell or unusual spacing can get past them. Keep secrets out of reach in
            other ways too.
          </p>

          <button
            type="button"
            className="rules-link"
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
          >
            Add a rule
          </button>
          {adding && (
            <div className="rules-forms">
              <form onSubmit={addGoAhead} aria-label="Add a Go ahead rule">
                <label>
                  Let agents do this without asking
                  <select
                    className="score-select score-select--dark"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    <option value="">Choose a kind of command…</option>
                    {askMe.map((rule) => (
                      <option key={rule.id} value={rule.id}>
                        {rule.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="rules-pill" disabled={!category}>
                  Add to Go ahead
                </button>
              </form>
              <form onSubmit={addNever} aria-label="Add a Never rule">
                <label>
                  Never allow commands that match
                  <input
                    value={glob}
                    maxLength={200}
                    placeholder="*git* push* --force*"
                    onChange={(event) => setGlob(event.target.value)}
                  />
                </label>
                <button type="submit" className="rules-pill" disabled={!normalise(glob)}>
                  Add to Never
                </button>
              </form>
            </div>
          )}

          {dirty && (
            <div className="rules-save" role="group" aria-label="Unsaved changes">
              <p>These changes apply to every agent once saved.</p>
              {diff === null ? (
                <button
                  type="button"
                  className="rules-pill"
                  disabled={preview.isPending}
                  onClick={review}
                >
                  Review changes
                </button>
              ) : (
                <>
                  <pre aria-label="Changes">{diff.trim() || 'No changes.'}</pre>
                  <button
                    type="button"
                    className="rules-primary"
                    disabled={save.isPending}
                    onClick={commit}
                  >
                    Save for the whole team
                  </button>
                </>
              )}
              <button
                type="button"
                className="rules-link"
                onClick={() => {
                  revision.current += 1
                  setDraft(null)
                  setReviewed(null)
                }}
              >
                Discard
              </button>
            </div>
          )}
          {preview.isError && <p role="alert">{failure(preview.error, 'preview the changes')}</p>}
          {save.isError && <p role="alert">{failure(save.error, 'save the rules')}</p>}

          <div className="rules-drift">
            <span className="rules-heading">Agents and the team rules</span>
            {drifting.length === 0 ? (
              <span className="rules-empty">Every agent follows the team rules.</span>
            ) : (
              drifting.map((item) => {
                const agent = agents.find((candidate) => candidate.id === item.agentId)
                return (
                  <span key={item.agentId} className="rules-item">
                    <span>{agent?.name ?? item.agentId} differs from the team rules</span>
                    <button
                      type="button"
                      className="rules-pill"
                      aria-label={`Apply team rules to ${agent?.name ?? item.agentId}`}
                      disabled={apply.isPending}
                      onClick={() => apply.mutate(item.agentId)}
                    >
                      Apply team rules
                    </button>
                  </span>
                )
              })
            )}
            {apply.isError && <p role="alert">{failure(apply.error, 'apply the team rules')}</p>}
          </div>
          <p role="status" className="rules-lead">
            {notice}
          </p>
        </>
      )}
    </section>
  )
}
