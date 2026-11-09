import { useState } from 'react'
import { SUBAGENT_LIMITS, type AgentDetail, type AgentSubagents } from '@score/contract'
import { useAgentSubagents, useSaveAgentSubagents } from '../subagents/subagent-queries.ts'
import { Fail, Loading, MoreCard, problem } from './MoreCard.tsx'

/** A whole number from a text field, or null when blank or not a whole number. */
const whole = (text: string): number | null => {
  const value = Number(text)
  return text.trim() !== '' && Number.isInteger(value) ? value : null
}

/** The contract's limits for `steps` and `time` (AgentSubagentsRequest: steps 1–1000, seconds 1–86400). */
const MAX_STEPS = 1000
const MAX_SECONDS = 86_400

/**
 * SA.3 part 10 (decision 173): the agent's ceiling for its subagents. Hermes agents get the limits; Claude Code gets
 * an on/off; Codex says it isn't supported yet. A job or a chat can only narrow what is set here.
 */
export function SubagentsCard({ agent }: { agent: AgentDetail }) {
  const query = useAgentSubagents(agent.id)
  return (
    <MoreCard id="agent-subagents" title="Subagents">
      {query.isPending && <Loading what="subagent settings" />}
      {query.isError && (
        <Fail>
          Couldn’t load the subagent settings.{' '}
          <button type="button" className="link" onClick={() => void query.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {query.data && (
        <SubagentsForm
          key={JSON.stringify(query.data)}
          agentId={agent.id}
          agentName={agent.name}
          value={query.data}
        />
      )}
    </MoreCard>
  )
}

function SubagentsForm({
  agentId,
  agentName,
  value,
}: {
  agentId: string
  agentName: string
  value: AgentSubagents
}) {
  const save = useSaveAgentSubagents(agentId)
  const [enabled, setEnabled] = useState(value.enabled)
  const [atOnce, setAtOnce] = useState(String(value.maxConcurrent))
  const [model, setModel] = useState(value.model ?? '')
  const [steps, setSteps] = useState(
    value.maxIterations === null ? '' : String(value.maxIterations),
  )
  const [minutes, setMinutes] = useState(
    value.timeoutSeconds === null ? '' : String(value.timeoutSeconds / 60),
  )
  if (value.control === 'none') {
    return (
      <>
        <p className="bold-mc-strong">Subagents aren’t supported here yet</p>
        <p className="small muted">
          Score can’t turn them off or follow them on Codex yet, so it asks this agent not to use
          them. That’s a request, not a limit.
        </p>
      </>
    )
  }
  const concurrent = whole(atOnce)
  const stepCount = steps.trim() === '' ? null : whole(steps)
  const seconds = minutes.trim() === '' ? null : Math.round(Number(minutes) * 60)
  const concurrentOk =
    concurrent !== null && concurrent >= 1 && concurrent <= SUBAGENT_LIMITS.maxConcurrent
  const stepsOk =
    steps.trim() === '' || (stepCount !== null && stepCount >= 1 && stepCount <= MAX_STEPS)
  const minutesOk =
    minutes.trim() === '' || (seconds !== null && seconds >= 1 && seconds <= MAX_SECONDS)
  const valid = value.control === 'on_off' || (concurrentOk && stepsOk && minutesOk)
  const submit = () => {
    if (!valid) return
    if (value.control === 'on_off') {
      save.mutate({ enabled })
      return
    }
    save.mutate({
      enabled,
      maxConcurrent: concurrent!,
      model: model.trim() === '' ? null : model.trim(),
      // Blank steps leave the agent's own value as it is: the contract has no null for them.
      ...(stepCount === null ? {} : { maxIterations: stepCount }),
      timeoutSeconds: seconds,
    })
  }
  const edit = (set: (text: string) => void) => (text: string) => {
    set(text)
    save.reset()
  }
  return (
    <form
      className="bold-mc-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label className="row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked)
            save.reset()
          }}
        />
        Allow subagents
      </label>
      {value.control === 'on_off' ? (
        <p className="small muted">
          Claude Code decides how many run at once. Score can turn them off, stop them, and pause
          the job at its total.
        </p>
      ) : (
        <>
          <p className="small muted">
            Helpers {agentName} can spin up for one task. They report back to {agentName} and never
            join a chat. A job or chat can lower these limits, not raise them.
          </p>
          <label className="lab" htmlFor={`subagents-once-${agentId}`}>
            At once
          </label>
          <input
            id={`subagents-once-${agentId}`}
            className="field"
            inputMode="numeric"
            aria-invalid={!concurrentOk}
            value={atOnce}
            onChange={(event) => edit(setAtOnce)(event.target.value)}
          />
          <label className="lab" htmlFor={`subagents-model-${agentId}`}>
            Model
          </label>
          <input
            id={`subagents-model-${agentId}`}
            className="field"
            placeholder={`Same as ${agentName}`}
            value={model}
            onChange={(event) => edit(setModel)(event.target.value)}
          />
          <label className="lab" htmlFor={`subagents-steps-${agentId}`}>
            Steps for each
          </label>
          <input
            id={`subagents-steps-${agentId}`}
            className="field"
            inputMode="numeric"
            aria-invalid={!stepsOk}
            value={steps}
            onChange={(event) => edit(setSteps)(event.target.value)}
          />
          <label className="lab" htmlFor={`subagents-time-${agentId}`}>
            Time for each (minutes)
          </label>
          <input
            id={`subagents-time-${agentId}`}
            className="field"
            inputMode="decimal"
            placeholder="No limit"
            aria-invalid={!minutesOk}
            value={minutes}
            onChange={(event) => edit(setMinutes)(event.target.value)}
          />
          <p className="small muted">
            Subagents can’t spawn their own, ask you questions directly, write {agentName}’s memory
            or send messages. Their risky commands come to you as approvals.
          </p>
        </>
      )}
      <span className="row">
        <button type="submit" className="btn" disabled={save.isPending || !valid}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.isSuccess && (
          <span role="status" className="small muted">
            Subagent settings saved.
          </span>
        )}
      </span>
      {save.isError && (
        <Fail>{problem(save.error, 'Couldn’t save the subagent settings. Try again.')}</Fail>
      )}
    </form>
  )
}
