import type { AgentDetail, RunsOn, RunsOnUpdate } from '@score/contract'
import { useState } from 'react'
import { ApiError } from '../data/api.ts'
import { agentDisplayName } from './bold-agents.ts'
import { pairingProblem } from './bold-errors.ts'
import { useRunsOn, useSetRunsOn } from './runs-on-queries.ts'

const SEPARATED: Record<RunsOn['separated'], string> = {
  no: 'Not separated',
  partly: 'Partly separated',
  unknown: 'Not known',
}

function where(runsOn: RunsOn): string {
  if (runsOn.backend === 'local') return 'This machine, as you'
  if (runsOn.backend === 'docker')
    return `Docker${runsOn.docker?.image ? ` · ${runsOn.docker.image}` : ''}`
  if (runsOn.backend === 'ssh')
    return `SSH · ${runsOn.ssh?.user ? `${runsOn.ssh.user}@` : ''}${runsOn.ssh?.host ?? 'no host'}`
  return `Another backend (${runsOn.raw ?? 'unknown'})`
}

/** "Where it works" (PLAN 11.8a, D15): the agent's terminal backend, exactly what it separates, and the change form.
 * Never says "separated" outright: some tools always run on this machine. */
export function RunsOnCard({ agent }: { agent: AgentDetail }) {
  const runsOn = useRunsOn(agent.id)
  const [editing, setEditing] = useState(false)
  return (
    <section
      className="card bold-up-card"
      id="agent-where"
      aria-labelledby="agent-where-title"
      // Where an agent runs decides what it can reach on this machine: a decision surface no theme may hide.
      data-protected="block"
    >
      <span className="lab" id="agent-where-title">
        Where it works
      </span>
      {runsOn.isPending ? (
        <span className="small muted">Reading Hermes…</span>
      ) : runsOn.isError ? (
        <span className="small" role="alert">
          Couldn’t read where {agentDisplayName(agent)} runs. {runsOn.error.message}
        </span>
      ) : (
        <>
          <span className="row wrap">
            <b>{where(runsOn.data)}</b>
            <span className={`badge runs-on-${runsOn.data.separated}`}>
              {SEPARATED[runsOn.data.separated]}
            </span>
          </span>
          {runsOn.data.separatedTools.length > 0 && (
            <p className="small">
              <b>Inside the {runsOn.data.backend === 'ssh' ? 'other machine' : 'container'}:</b>{' '}
              {runsOn.data.separatedTools.join(', ')}.
            </p>
          )}
          {runsOn.data.hostTools.length > 0 && (
            <p className="small">
              <b>Still on this machine as you:</b> {runsOn.data.hostTools.join(', ')}.
            </p>
          )}
          <ul className="small muted bold-runs-on-notes">
            {runsOn.data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <span className="small muted">
            {runsOn.data.checked.how === 'live' ? 'Checked live' : 'Read from the Hermes source'}{' '}
            with Hermes {runsOn.data.checked.hermes} on {runsOn.data.checked.at}.
          </span>
          {editing ? (
            <RunsOnForm agent={agent} current={runsOn.data} onDone={() => setEditing(false)} />
          ) : (
            <button type="button" className="btn sm" onClick={() => setEditing(true)}>
              Change where it works
            </button>
          )}
        </>
      )}
    </section>
  )
}

function RunsOnForm({
  agent,
  current,
  onDone,
}: {
  agent: AgentDetail
  current: RunsOn
  onDone: () => void
}) {
  const save = useSetRunsOn(agent.id)
  const [backend, setBackend] = useState<RunsOnUpdate['backend']>(
    current.backend === 'other' ? 'local' : current.backend,
  )
  const [network, setNetwork] = useState(current.docker?.network ?? true)
  const [host, setHost] = useState(current.ssh?.host ?? '')
  const [user, setUser] = useState(current.ssh?.user ?? '')
  const [port, setPort] = useState(current.ssh?.port ? String(current.ssh.port) : '')
  const [keyPath, setKeyPath] = useState('')

  function update(): RunsOnUpdate {
    if (backend === 'docker') return { backend, network }
    if (backend === 'ssh')
      return {
        backend,
        host: host.trim(),
        user: user.trim(),
        ...(port.trim() ? { port: Number(port) } : {}),
        ...(keyPath.trim() ? { keyPath: keyPath.trim() } : {}),
      }
    return { backend: 'local' }
  }

  return (
    <form
      className="bold-runs-on-form"
      aria-label={`Change where ${agentDisplayName(agent)} works`}
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate(update(), { onSuccess: onDone })
      }}
    >
      <div className="seg" role="radiogroup" aria-label="Runs on">
        {(
          [
            ['local', 'This machine'],
            ['docker', 'Docker'],
            ['ssh', 'SSH'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={backend === value}
            className={backend === value ? 'on' : ''}
            onClick={() => setBackend(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {backend === 'docker' && (
        <label className="check small">
          <input
            type="checkbox"
            checked={network}
            onChange={(event) => setNetwork(event.target.checked)}
          />
          Let the container reach the network
        </label>
      )}
      {backend === 'ssh' && (
        <div className="grid2">
          <label>
            <span className="lab">Host</span>
            <input
              className="field"
              required
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
          </label>
          <label>
            <span className="lab">User</span>
            <input
              className="field"
              required
              value={user}
              onChange={(event) => setUser(event.target.value)}
            />
          </label>
          <label>
            <span className="lab">Port</span>
            <input
              className="field"
              inputMode="numeric"
              placeholder="22"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          <label>
            <span className="lab">Key file (path; Score never reads it)</span>
            <input
              className="field"
              placeholder="/home/you/.ssh/agent_key"
              value={keyPath}
              onChange={(event) => setKeyPath(event.target.value)}
            />
          </label>
        </div>
      )}
      <span className="small muted">
        Takes effect for terminals {agentDisplayName(agent)} starts afterwards.
        {backend !== 'local' && ' Its Workspace tab is only available on this machine.'}
      </span>
      {save.isError && (
        <span className="small" role="alert">
          {pairingProblem(save.error) ??
            (save.error instanceof ApiError && save.error.code === 'bad_request'
              ? 'Check the host, user, port and key path.'
              : save.error.message)}
        </span>
      )}
      <span className="row">
        <button type="button" className="btn sm ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn sm primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </span>
    </form>
  )
}
