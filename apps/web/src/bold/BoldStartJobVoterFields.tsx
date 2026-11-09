import { useState } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import type { StartJobView } from './use-start-job-view.ts'
import './bold-start-subagents.css'

/** Up to four voters: named agents the lead can ask when a decision is close. The lead can't vote. */
const MAX_VOTERS = 4

/** The voters picker (mock-up 24): the chosen agents as chips, Add opens the other agents, and the automatic votes. */
export function VoterFields({ view }: { view: StartJobView }) {
  const [adding, setAdding] = useState(false)
  const chosen = view.agents.filter((agent) => view.voterIds.includes(agent.id))
  const others = view.agents.filter(
    (agent) => agent.id !== view.leadId && !view.voterIds.includes(agent.id),
  )
  const full = view.voterIds.length >= MAX_VOTERS
  const setVoters = (ids: string[]) => {
    view.setVoterPick(ids)
    view.touch()
  }
  return (
    <>
      <span className="bold-start-voters-copy" id="start-voters-help">
        Named agents the lead can ask when a decision is close. Score counts the answers.
      </span>
      <div className="bold-start-voter-row">
        {chosen.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className="bold-start-voter"
            aria-label={`Remove ${agent.name} from the voters`}
            onClick={() => setVoters(view.voterIds.filter((id) => id !== agent.id))}
          >
            <AgentGlyph agent={agent} size="xs" bare decorative />
            {agent.name}
            <span aria-hidden="true">×</span>
          </button>
        ))}
        {others.length > 0 && (
          <button
            type="button"
            className="bold-start-voter-add"
            aria-expanded={adding}
            disabled={full}
            onClick={() => setAdding((open) => !open)}
          >
            Add
          </button>
        )}
      </div>
      {adding && !full && (
        <div
          className="bold-start-voter-list"
          role="group"
          aria-label="Agents you can add as voters"
        >
          {others.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="bold-start-voter"
              onClick={() => {
                setVoters([...view.voterIds, agent.id])
                setAdding(false)
              }}
            >
              <AgentGlyph agent={agent} size="xs" bare decorative />
              {agent.name}
            </button>
          ))}
        </div>
      )}
      {view.voterIds.length === 0 && (
        <span className="small muted">No voters: no votes in this job.</span>
      )}
      {view.voterIds.length > 0 && (
        // 3.16 (the split-vote choice of the old helpers form): sent as `splitTo` with the voters.
        <fieldset className="start-field">
          <legend>When the voters split</legend>
          {(
            [
              ['lead', 'The lead decides'],
              ['person', 'Ask me'],
            ] as const
          ).map(([id, label]) => (
            <label className="check small" key={id}>
              <input
                type="radio"
                name="start-voter-split"
                checked={view.helperSplit === id}
                onChange={() => {
                  view.setHelperSplit(id)
                  view.touch()
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <label className="check small">
        <input
          type="checkbox"
          aria-describedby="start-auto-vote-help"
          checked={view.autoVoteOn}
          disabled={view.autoVoteBlocked || view.voterIds.length === 0}
          onChange={(event) => {
            view.setAutoVote(event.target.checked)
            view.touch()
          }}
        />
        Vote on every step before it starts
      </label>
      <span className="small muted" id="start-auto-vote-help">
        {view.autoVoteBlocked
          ? 'Not available when you approve every step: the vote is then yours. '
          : ''}
        {view.voterIds.length === 0 ? 'Name voters first. ' : ''}
        Before each step the lead assigns starts, the voters judge the agent and approach. A clear
        no stops it and the lead reassigns; a split goes to the lead or to you.
      </span>
      {view.autoVoteOn && (
        <label className="start-field">
          <span>Voters per vote (3 to 7)</span>
          <input
            className="field"
            type="number"
            min={3}
            max={7}
            value={view.autoVoteK}
            onChange={(event) => {
              view.setAutoVoteK(event.target.value)
              view.touch()
            }}
          />
        </label>
      )}
      {view.votersProblem && (
        <span className="small" role="alert">
          {view.votersProblem}
        </span>
      )}
    </>
  )
}
