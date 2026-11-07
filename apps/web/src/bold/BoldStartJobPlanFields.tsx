import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { SCHEDULES } from './bold-start-job.ts'
import type { StartJobView } from './use-start-job-view.ts'

export function AgentPick({
  agents,
  leadId,
  chosen,
  onChange,
}: {
  agents: AgentSummary[]
  leadId: string
  chosen: string[]
  onChange: (next: string[]) => void
}) {
  const options = agents.filter((agent) => agent.id !== leadId)
  return (
    <fieldset className="bold-agent-pick" data-protected="flex">
      <legend className="lab">Agents allowed</legend>
      <p className="small muted start-pick-note">
        lead plans the work. Only these agents may take a step.
      </p>
      <div className="row wrap start-pick">
        {options.map((agent) => {
          const checked = chosen.includes(agent.id)
          return (
            <label key={agent.id} className="chip start-agent-chip">
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  onChange(checked ? chosen.filter((id) => id !== agent.id) : [...chosen, agent.id])
                }
              />
              <AgentGlyph agent={agent} size="sm" bare decorative />
              <span>{agent.name}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

export function StartJobLead({ view }: { view: StartJobView }) {
  return (
    <>
      <div className="row wrap start-lead">
        {view.leadIsCoding && view.hermesAgents.length > 0 ? (
          <label className="start-planner">
            <span className="lab">Who plans it</span>
            <select
              value={view.leadId}
              onChange={(event) => {
                view.setPlanner(event.target.value)
                view.touch()
              }}
            >
              {view.hermesAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          view.leadAgent && (
            <span className="chip start-agent-chip">
              <AgentGlyph agent={view.leadAgent} size="sm" bare decorative />
              <span>{view.leadAgent.name} plans</span>
            </span>
          )
        )}
        <span className="small muted">
          {view.leadIsCoding
            ? `${view.roomLeadName} leads this room, but a coding agent can’t plan a “lead decides” job yet: a Hermes agent plans it.`
            : 'The lead decides the steps and hands them out.'}
        </span>
      </div>
      <AgentPick
        agents={view.agents}
        leadId={view.leadId}
        chosen={view.allowedFor}
        onChange={(next) => {
          view.setAllowed(next)
          view.touch()
        }}
      />
    </>
  )
}

export function StartJobWhen({ view }: { view: StartJobView }) {
  return (
    <fieldset className="inner" style={{ border: 0, margin: 0 }}>
      <legend className="lab start-legend">When</legend>
      <div className="start-clear">
        {(
          [
            ['once', 'Now, once'],
            ['schedule', 'On a schedule'],
            ['webhook', 'When another app calls'],
          ] as const
        ).map(([id, label]) => (
          <label className="check" key={id}>
            <input
              type="radio"
              name="start-when"
              checked={view.when === id}
              onChange={() => {
                view.setWhen(id)
                view.setError(null)
                view.setResult(null)
                view.touch()
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {view.when === 'schedule' && (
        <label className="start-field">
          <span className="sr">Schedule</span>
          <select
            className="field"
            aria-label="Schedule"
            value={view.schedule}
            onChange={(event) => {
              view.setSchedule(event.target.value)
              view.touch()
            }}
          >
            {SCHEDULES.map((option) => (
              <option key={option.label}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
      {view.when === 'webhook' && (
        <div className="start-trigger-fields">
          <label className="start-field">
            <span className="lab">Trigger name</span>
            <input
              className="field"
              maxLength={100}
              value={view.triggerName}
              placeholder="e.g. New support ticket"
              onChange={(event) => {
                view.setTriggerName(event.target.value)
                view.touch()
              }}
            />
          </label>
          <label className="start-field">
            <span className="lab">The app it comes from</span>
            <input
              className="field"
              maxLength={100}
              value={view.triggerApp}
              onChange={(event) => {
                view.setTriggerApp(event.target.value)
                view.touch()
              }}
            />
          </label>
          <span className="small muted">
            Calls send <code>ref</code>, and may send <code>title</code>, <code>link</code> and{' '}
            <code>details</code>. The address and secret are made when you start.
          </span>
        </div>
      )}
    </fieldset>
  )
}

export function AskChoices({ view }: { view: StartJobView }) {
  return (
    <div className="start-clear">
      {(
        [
          ['plan', 'The plan starts'],
          ['handoff', 'Every hand-off'],
          ['risky', 'Only risky actions'],
        ] as const
      ).map(([id, label]) => (
        <label className="check" key={id}>
          <input
            type="radio"
            name="start-ask"
            checked={view.ask === id}
            onChange={() => {
              view.setAsk(id)
              view.touch()
            }}
          />
          {label}
        </label>
      ))}
    </div>
  )
}

export function StartJobAdvisor({ view }: { view: StartJobView }) {
  return (
    <div className="start-field start-advisor">
      <label htmlFor="start-advisor-select">Advisor</label>
      <select
        id="start-advisor-select"
        aria-describedby="start-advisor-help"
        value={view.advisorId}
        onChange={(event) => {
          view.setAdvisorPick(event.target.value)
          view.touch()
        }}
      >
        <option value="">None</option>
        {view.agents
          .filter((agent) => agent.id !== view.leadId)
          .map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
      </select>
      <span className="small muted" id="start-advisor-help">
        A strong model Score asks before the plan, when a failure repeats, and before it finishes.
        Its advice goes to the lead; the lead decides. Choose an agent set up for reviewing: it runs
        with its own tools.
      </span>
    </div>
  )
}
