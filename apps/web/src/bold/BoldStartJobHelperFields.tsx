import { ORCH_LIMITS } from '@score/contract'
import type { StartJobView } from './use-start-job-view.ts'

export function HelperFields({ view }: { view: StartJobView }) {
  return (
    <div className="start-clear">
      <fieldset className="start-field">
        <legend>Helper agents (1 to 4)</legend>
        {view.agents
          .filter((agent) => agent.id !== view.leadId)
          .map((agent) => {
            const on = view.helperIds.includes(agent.id)
            return (
              <label className="check small" key={agent.id}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && view.helperIds.length >= 4}
                  onChange={(event) => {
                    view.setHelperPick(
                      event.target.checked
                        ? [...view.helperIds, agent.id]
                        : view.helperIds.filter((id) => id !== agent.id),
                    )
                    view.touch()
                  }}
                />
                {agent.name}
              </label>
            )
          })}
      </fieldset>
      <fieldset className="start-field">
        <legend>Who votes (up to 4)</legend>
        <span className="small muted" id="start-voters-help">
          {view.voterIds.length === 0 ? 'The helpers vote. ' : ''}Votes go only to these agents, for
          example the model you keep for small decisions; the helpers keep searching, grepping and
          auditing.
        </span>
        {view.agents
          .filter((agent) => agent.id !== view.leadId)
          .map((agent) => {
            const on = view.voterIds.includes(agent.id)
            return (
              <label className="check small" key={agent.id}>
                <input
                  type="checkbox"
                  aria-label={`Votes: ${agent.name}`}
                  aria-describedby="start-voters-help"
                  checked={on}
                  disabled={!on && view.voterIds.length >= 4}
                  onChange={(event) => {
                    view.setVoterPick(
                      event.target.checked
                        ? [...view.voterIds, agent.id]
                        : view.voterIds.filter((id) => id !== agent.id),
                    )
                    view.touch()
                  }}
                />
                {agent.name}
              </label>
            )
          })}
      </fieldset>
      <label className="start-field">
        <span>At once (1 to 6)</span>
        <input
          className="field"
          type="number"
          min={1}
          max={6}
          value={view.helperConcurrent}
          onChange={(event) => {
            view.setHelperConcurrent(event.target.value)
            view.touch()
          }}
        />
      </label>
      <label className="start-field">
        <span>Helper steps (1 to 60)</span>
        <input
          className="field"
          type="number"
          min={1}
          max={60}
          value={view.helperSteps}
          disabled={view.helperNoLimit}
          onChange={(event) => {
            view.setHelperSteps(event.target.value)
            view.touch()
          }}
        />
      </label>
      <label className="check small">
        <input
          type="checkbox"
          aria-describedby="start-helper-nolimit-help"
          checked={view.helperNoLimit}
          onChange={(event) => {
            view.setHelperNoLimit(event.target.checked)
            view.touch()
          }}
        />
        No limit (until the job ends)
      </label>
      <span className="small muted" id="start-helper-nolimit-help">
        Still bounded by the job&apos;s budget, coding-agent launches and the lead&apos;s turns: set
        a budget.
      </span>
      <label className="check small">
        <input
          type="checkbox"
          aria-describedby="start-auto-vote-help"
          checked={view.autoVoteOn}
          disabled={view.autoVoteBlocked}
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
      <label className="check small">
        <input
          type="checkbox"
          aria-describedby="start-auto-audit-help"
          checked={view.autoAudit}
          onChange={(event) => {
            view.setAutoAudit(event.target.checked)
            view.touch()
          }}
        />
        Audit every step after it finishes
      </label>
      <span className="small muted" id="start-auto-audit-help">
        A helper checks each finished step&apos;s change; its findings go to the lead.
      </span>
      <label className="check small">
        <input
          type="checkbox"
          checked={view.helperScan}
          onChange={(event) => {
            view.setHelperScan(event.target.checked)
            view.touch()
          }}
        />
        Scan the project first
      </label>
      {view.helperScan && (
        <label className="start-field">
          <span>Scan folder</span>
          <input
            className="field start-check-command"
            value={view.helperFolderNow}
            placeholder="/home/you/project"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              view.setHelperFolder(event.target.value)
              view.touch()
            }}
          />
        </label>
      )}
      <fieldset className="start-field">
        <legend>When the helpers split on a vote</legend>
        {(
          [
            ['lead', 'The lead decides'],
            ['person', 'Ask me'],
          ] as const
        ).map(([id, label]) => (
          <label className="check small" key={id}>
            <input
              type="radio"
              name="start-helper-split"
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
      <span className="small muted">
        Cheap agents for narrow, read-only work: the lead hands them searches, greps and audits, and
        asks them to vote on small choices. A clear majority (70% or more) is taken; a split goes to
        the lead or to you. They run with their own tools, so choose agents set up for reading.
      </span>
      {view.helperProblem && (
        <span className="small" role="alert">
          {view.helperProblem}
        </span>
      )}
    </div>
  )
}

export function StartJobLaunches({ view }: { view: StartJobView }) {
  return (
    <div className="start-field start-launches" data-protected="block">
      <label htmlFor="start-launches-input">Coding-agent launches (1–100)</label>
      <input
        id="start-launches-input"
        className="field"
        type="number"
        min={1}
        max={ORCH_LIMITS.maxCodingSteps}
        value={view.launchesNow}
        aria-invalid={!view.launchesValid}
        aria-describedby="start-launches-help"
        onChange={(event) => {
          view.setLaunchesText(event.target.value)
          view.touch()
        }}
      />
      <span className="small muted" id="start-launches-help">
        Each step, helper step, vote answer and advisor consult on a coding agent is one launch.
      </span>
      {view.launchesProblem && (
        <span className="small" role="alert">
          {view.launchesProblem}
        </span>
      )}
    </div>
  )
}
