import type { RunsOn } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { saveRunsOn, type WorksOnChoice } from './bold-add-agent.ts'
import { worksOnLabels, type Runs } from './bold-add-agent-types.ts'

function runsChoice(runs: Runs): WorksOnChoice {
  if (runs.backend === 'docker') return { backend: 'docker' }
  if (runs.backend === 'ssh')
    return {
      backend: 'ssh',
      host: runs.sshHost.trim(),
      user: runs.sshUser.trim(),
      ...(runs.sshPort.trim() ? { port: Number(runs.sshPort) } : {}),
      ...(runs.sshKey.trim() ? { keyPath: runs.sshKey.trim() } : {}),
    }
  return { backend: 'local' }
}

export function WorksOnFields({ runs, setRuns }: { runs: Runs; setRuns: (runs: Runs) => void }) {
  return (
    <div className="bold-add-works">
      <label>
        <span className="lab">Works on</span>
        <select
          className="field"
          value={runs.backend}
          onChange={(event) => setRuns({ ...runs, backend: event.target.value as Runs['backend'] })}
        >
          {worksOnLabels.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {runs.backend === 'ssh' && (
        <div className="bold-add-ssh">
          <label>
            <span className="lab">Host</span>
            <input
              className="field"
              required
              value={runs.sshHost}
              onChange={(event) => setRuns({ ...runs, sshHost: event.target.value })}
            />
          </label>
          <label>
            <span className="lab">User</span>
            <input
              className="field"
              required
              value={runs.sshUser}
              onChange={(event) => setRuns({ ...runs, sshUser: event.target.value })}
            />
          </label>
          <label>
            <span className="lab">Port (optional)</span>
            <input
              className="field"
              type="number"
              min={1}
              max={65535}
              value={runs.sshPort}
              onChange={(event) => setRuns({ ...runs, sshPort: event.target.value })}
            />
          </label>
          <label className="span2">
            <span className="lab">Private key path (optional)</span>
            <input
              className="field"
              placeholder="/home/you/.ssh/id_ed25519"
              value={runs.sshKey}
              onChange={(event) => setRuns({ ...runs, sshKey: event.target.value })}
            />
          </label>
        </div>
      )}
      <span className="small muted">
        {runs.backend === 'local'
          ? 'Runs as you on this machine; its terminal tools are not separated.'
          : runs.backend === 'docker'
            ? 'Score checks Docker after setup. If it is unavailable, you will see the reason.'
            : 'Score stores the key path only; it never reads the key.'}
      </span>
    </div>
  )
}

type RunsSetup = ReturnType<typeof useRunsOnSetup>

export function useRunsOnSetup(
  ready: boolean,
  agentId: string,
  runs: Runs,
  onReady: (result: RunsOn | null) => void,
) {
  const [state, setState] = useState<'idle' | 'saving' | 'error' | 'ready'>('idle')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const saveRef = useRef<() => Promise<void>>(async () => undefined)
  const save = async () => {
    setState('saving')
    setError(null)
    try {
      const choice = runsChoice(runs)
      const result = choice.backend === 'local' ? null : await saveRunsOn(agentId, choice)
      setState('ready')
      onReady(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t set where this agent runs.')
      setState('error')
    }
  }
  useEffect(() => {
    saveRef.current = save
  })
  useEffect(() => {
    if (!ready || started.current) return
    started.current = true
    void saveRef.current()
  }, [ready])
  return { state, error, retry: save }
}

export function RunsProgress({ setup }: { setup: RunsSetup }) {
  if (setup.state === 'saving')
    return (
      <p className="bold-add-runs-status" role="status">
        Setting where it runs…
      </p>
    )
  if (setup.state === 'error')
    return (
      <div className="bold-add-error" role="alert" data-protected="block">
        <p>{setup.error}</p>
        <button type="button" className="btn sm" onClick={() => void setup.retry()}>
          Try again
        </button>
      </div>
    )
  return null
}
