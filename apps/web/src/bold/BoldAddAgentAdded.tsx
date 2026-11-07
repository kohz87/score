import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { separatedLabels, type AddedAgent, type RunsOutcome } from './bold-add-agent-types.ts'

export function AddedView({
  added,
  close,
  another,
}: {
  added: AddedAgent
  close: () => void
  another?: () => void
}) {
  return (
    <section className="bold-add-added" role="status">
      <AgentGlyph
        agent={{ id: added.id, name: added.name, style: added.style }}
        size="lg"
        mood="done"
      />
      <h2>{added.name} joined the team</h2>
      <p className="muted">{added.detail}</p>
      {added.runs && <JoinedRuns id={added.id} runs={added.runs} close={close} />}
      <div className="bold-add-added-actions">
        <Link
          className="btn primary"
          to={`/b/agents/${encodeURIComponent(added.id)}`}
          onClick={close}
          autoFocus
        >
          Open {added.name}
        </Link>
        {another && (
          <button type="button" className="btn ghost" onClick={another}>
            Add another
          </button>
        )}
        <button type="button" className="btn ghost" onClick={close}>
          Close
        </button>
      </div>
    </section>
  )
}

function JoinedRuns({ id, runs, close }: { id: string; runs: RunsOutcome; close: () => void }) {
  if (runs.kind === 'failed')
    return (
      <div className="bold-add-joined-runs" data-protected="block">
        <p>Runs on this machine as you: {runs.reason}</p>
        <WhereItWorksLink id={id} close={close} />
      </div>
    )
  if (runs.kind === 'local')
    return (
      <div className="bold-add-joined-runs" data-protected="block">
        <p>Runs on this machine as you.</p>
        <WhereItWorksLink id={id} close={close} />
      </div>
    )
  const backend =
    runs.runsOn.backend === 'docker'
      ? 'Docker'
      : runs.runsOn.backend === 'ssh'
        ? 'Another machine over SSH'
        : runs.runsOn.backend === 'local'
          ? 'This machine as you'
          : `Another backend (${runs.runsOn.raw ?? 'unknown'})`
  return (
    <div className="bold-add-joined-runs" data-protected="block">
      <p>
        <b>
          {backend} · {separatedLabels[runs.runsOn.separated]}
        </b>
        {runs.runsOn.notes[0] ? ` — ${runs.runsOn.notes[0]}` : null}
      </p>
      <WhereItWorksLink id={id} close={close} />
    </div>
  )
}

function WhereItWorksLink({ id, close }: { id: string; close: () => void }) {
  return (
    <Link className="link" to={`/b/agents/${encodeURIComponent(id)}#agent-where`} onClick={close}>
      Where it works
    </Link>
  )
}
