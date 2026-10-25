import { RoomSchema, WorkflowListSchema } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../data/api.ts'
import { copyText } from '../data/clipboard.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { aboutQuery, useSystemStatus } from '../routes/settings/settings-queries.ts'
import { useSaveWorkflow, useWorkflows } from '../routes/workflows/workflow-queries.ts'
import { finishFirstRun, hermesStatusCopy, starterPlan, starterRecipes } from './bold-first-run.ts'
import { pairingProblem } from './bold-errors.ts'
import { useBoldTeamRoom } from './bold-search-queries.ts'
import './bold-first-run.css'

const SERVICE_COMMAND = 'scripts/score service install'

function useServiceStatus() {
  return useQuery(aboutQuery)
}

function CheckMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12l5 5 9-10" />
    </svg>
  )
}

function Mark({ ok }: { ok: boolean }) {
  return (
    <span className="bold-first-run-mark" data-state={ok ? 'ok' : 'attention'} aria-hidden="true">
      {ok ? (
        <CheckMark />
      ) : (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 8v5M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      )}
    </span>
  )
}

function CopyCommand() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <div className="bold-first-run-command">
      <code>{SERVICE_COMMAND}</code>
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          void copyText(SERVICE_COMMAND).then((copied) => setState(copied ? 'copied' : 'failed'))
        }}
      >
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {state === 'failed' && (
        <span className="small muted" role="alert">
          Couldn’t copy. Select the command and copy it yourself.
        </span>
      )}
    </div>
  )
}

function leadFailure(error: unknown): string {
  const pairing = pairingProblem(error)
  if (pairing) return pairing
  if (error instanceof ApiError) {
    return `Couldn’t save the lead: ${error.message}`
  }
  return 'Couldn’t save the lead. Try again.'
}

/** PLAN 11.10b: the first run and starter recipes, as a page in the bold shell's main column. */
export function BoldFirstRun() {
  const roomQuery = useBoldTeamRoom()
  const agents = useStreamQuery(agentsQuery).data ?? []
  const system = useSystemStatus()
  const service = useServiceStatus()
  const workflows = useWorkflows()
  const saveWorkflow = useSaveWorkflow()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [lead, setLead] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [leadSaved, setLeadSaved] = useState(false)
  const [failedRecipes, setFailedRecipes] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const room = roomQuery.data?.room
  const selectedLead = lead ?? room?.leadAgentId ?? ''
  const members = room?.members ?? []
  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  const memberAgents = members.flatMap((id) => {
    const agent = agentById.get(id)
    return agent ? [agent] : []
  })
  const hermes = hermesStatusCopy(system.data, system.isError)
  const existingNames = new Set(workflows.data?.items.map((item) => item.name) ?? [])
  const options = starterRecipes.map((recipe) => {
    const plan = starterPlan(recipe, {
      members,
      agents: memberAgents,
      leadAgentId: selectedLead,
    })
    return { recipe, ...plan, exists: existingNames.has(recipe.name) }
  })

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const finish = () => {
    finishFirstRun()
    void queryClient.invalidateQueries({ queryKey: ['workflows'] })
    void navigate('/b', { replace: true })
  }

  const saveRecipes = async (ids: readonly string[]) => {
    if (ids.length === 0) {
      finish()
      return
    }
    let savedNames: Set<string>
    try {
      // Read the list straight from the server: `refetch()` can resolve with the cached list while another fetch of
      // it is still in flight, and a recipe saved meanwhile (another tab, the classic editor) would be created twice.
      const latest = WorkflowListSchema.parse(await apiFetch('workflows'))
      savedNames = new Set(latest.items.map((item) => item.name))
    } catch {
      setFailedRecipes(
        ids.map((id) => {
          const option = options.find((item) => item.recipe.id === id)
          return { id, name: option?.recipe.name ?? id }
        }),
      )
      return
    }

    const failed: { id: string; name: string }[] = []
    for (const id of ids) {
      const option = options.find((item) => item.recipe.id === id)
      if (!option || savedNames.has(option.recipe.name)) continue
      try {
        await saveWorkflow.mutateAsync({ workflowId: null, definition: option.definition })
        savedNames.add(option.recipe.name)
      } catch {
        failed.push({ id, name: option.recipe.name })
      }
    }
    setFailedRecipes(failed)
    if (failed.length === 0) finish()
  }

  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!room || selectedLead === '' || busy) return
    setBusy(true)
    setError(null)
    setFailedRecipes([])
    try {
      if (!leadSaved) {
        const updated = RoomSchema.parse(
          await apiFetch(`rooms/${encodeURIComponent(room.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ leadAgentId: selectedLead }),
          }),
        )
        if (updated.id !== room.id) throw new Error('The server answered for another room.')
        await roomQuery.refetch()
        setLeadSaved(true)
      }
      await saveRecipes([...selected])
    } catch (failure) {
      setError(leadFailure(failure))
    } finally {
      setBusy(false)
    }
  }

  const retry = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await saveRecipes([...selected])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bold-first-run">
      <div className="bold-first-run-grid">
        <section className="bold-first-run-hero" aria-labelledby="bold-first-run-title">
          <span className="word">score</span>
          <h1 id="bold-first-run-title">Run a team of agents from one room.</h1>
          <p>
            Score works with the Hermes agents already on this machine. Nothing leaves it unless you
            connect a channel.
          </p>
          {memberAgents.length > 0 && (
            <span className="bold-first-run-glyphs" aria-hidden="true">
              {memberAgents.map((agent) => (
                <AgentGlyph key={agent.id} agent={agent} size="lg" bare decorative />
              ))}
            </span>
          )}
        </section>

        <form
          className="bold-first-run-steps bold-first-run-decision"
          data-protected="flex"
          onSubmit={(event) => void open(event)}
        >
          <ol className="bold-first-run-list">
            <li className="bold-first-run-card bold-first-run-hermes">
              <Mark ok={hermes.ok} />
              <span className="bold-first-run-hermes-copy">
                <h2>{hermes.title}</h2>
                <span className="small muted">{hermes.detail}</span>
                {hermes.trouble && <span className="small muted">{hermes.trouble}</span>}
                {!hermes.ok && !system.isPending && (
                  <span className="bold-first-run-help small">
                    <Link to="/b/settings/connections">Open the setup help</Link>
                    {system.isError && (
                      <button type="button" className="link" onClick={() => void system.refetch()}>
                        Check again
                      </button>
                    )}
                  </span>
                )}
              </span>
            </li>

            <li className="bold-first-run-card">
              <h2>Who’s on the team?</h2>
              <p className="small muted">
                Every agent is in the team room. Its members follow the team’s agents.
              </p>
              {roomQuery.isPending ? (
                <p className="small muted" role="status">
                  Finding the team…
                </p>
              ) : (
                <ul className="bold-first-run-members" aria-label="Team members">
                  {members.map((id) => {
                    const agent = agentById.get(id)
                    return (
                      <li key={id} className="bold-first-run-member">
                        {agent ? (
                          <AgentGlyph agent={agent} size="xs" decorative />
                        ) : (
                          <span className="bold-first-run-member-dot" aria-hidden="true" />
                        )}
                        <span>{id}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
              <Link className="link bold-first-run-team-link" to="/b/team">
                Add or remove agents on the Team page
              </Link>
            </li>

            <li className="bold-first-run-card">
              <h2 id="bold-first-run-lead-title">Who leads?</h2>
              <p id="bold-first-run-lead-help" className="small muted">
                Messages without an @name go to the lead, who splits up the work.
              </p>
              <select
                id="bold-first-run-lead"
                className="field bold-first-run-select"
                value={selectedLead}
                required
                disabled={busy || leadSaved || members.length === 0}
                aria-labelledby="bold-first-run-lead-title"
                aria-describedby="bold-first-run-lead-help"
                onChange={(event) => setLead(event.target.value)}
              >
                <option value="">Pick who leads</option>
                {members.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </li>

            <li className="bold-first-run-card">
              <h2>Keep Score running</h2>
              <p className="small muted">
                Start Score with your computer, so the team keeps working when this tab is closed.
              </p>
              {service.data?.service ? (
                <p className="bold-first-run-service" role="status">
                  Already running as a service
                </p>
              ) : (
                <>
                  <p className="small muted">
                    Run this once in the Score folder after <code>pnpm build</code>. Score never
                    installs it for you.
                  </p>
                  <CopyCommand />
                </>
              )}
            </li>

            <li className="bold-first-run-card">
              <h2>Starter recipes</h2>
              <p className="small muted">
                Add a ready-made recipe you can run from the team room. You can edit or remove it
                later in the recipe editor.
              </p>
              <ul className="bold-first-run-recipes">
                {options.map(({ recipe, unmappedSteps, exists }) => {
                  const disabled = busy || exists
                  return (
                    <li key={recipe.id}>
                      <label className={`bold-first-run-option${disabled ? ' disabled' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selected.has(recipe.id)}
                          disabled={disabled}
                          onChange={() => toggle(recipe.id)}
                        />
                        <span className="bold-first-run-option-copy">
                          <b>{recipe.name}</b>
                          <span className="small muted">
                            {exists ? 'Already saved' : recipe.description}
                          </span>
                          {!exists &&
                            unmappedSteps.map((step) => (
                              <span key={step} className="small muted">
                                You pick the agent for {step} in the recipe editor
                              </span>
                            ))}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </li>

            <li className="bold-first-run-actions">
              {error && (
                <p className="bold-first-run-error" role="alert">
                  {error}
                </p>
              )}
              {failedRecipes.length > 0 && (
                <p className="bold-first-run-error" role="alert">
                  Lead saved. Couldn’t save: {failedRecipes.map(({ name }) => name).join(', ')}{' '}
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    onClick={() => void retry()}
                  >
                    Retry
                  </button>
                </p>
              )}
              <button
                type="submit"
                className="btn primary bold-first-run-open"
                disabled={busy || selectedLead === '' || room === undefined}
              >
                {busy ? 'Opening…' : 'Open the team room'}
              </button>
            </li>
          </ol>
        </form>
      </div>
    </div>
  )
}
