import type { AgentSummary } from '@score/contract'
import { useSystemStatus } from '../../routes/settings/settings-queries.ts'

export function HermesCard({ agents }: { agents: AgentSummary[] }) {
  const system = useSystemStatus()
  const connected = system.data?.hermes.reachable === true
  const label = system.isPending
    ? 'Checking…'
    : system.isError
      ? 'Couldn’t check'
      : connected
        ? 'Connected'
        : 'Not reachable'
  return (
    <section className="card" aria-labelledby="bold-hermes-title">
      <div className="row wrap">
        <h3 id="bold-hermes-title">Hermes</h3>
        <span className="bold-connect-status" data-status={connected ? 'ok' : 'error'}>
          <span className="dot" data-status={connected ? 'ok' : 'error'} aria-hidden="true" />
          {label}
        </span>
      </div>
      <span className="bold-connect-detail">
        {system.data?.hermes.version ? `Version ${system.data.hermes.version}` : 'Version unknown'}
        {' · '}
        {system.data?.hermes.apiServer ? 'gateway running' : 'gateway not running'}
        {' · '}
        {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
      </span>
      <span className="small muted">
        Score reads Hermes and works through its gateway. It never opens your keys.
      </span>
      <button
        type="button"
        className="link"
        disabled={system.isFetching}
        onClick={() => void system.refetch()}
      >
        {system.isFetching ? 'Checking…' : 'Check again'}
      </button>
    </section>
  )
}
