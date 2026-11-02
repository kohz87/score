import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { AgentSummary, HermesUpdateJob, HermesUpdateStatus } from '@score/contract'
import { ApiError } from '../data/api.ts'
import { copyText } from '../data/clipboard.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { useHermesCheck, useSystemStatus } from '../routes/settings/settings-queries.ts'
import { canTalkTo } from './bold-agents.ts'
import {
  readChannel,
  rememberChannel,
  useHermesUpdateActions,
  useHermesUpdateStatus,
} from './hermes-update-queries.ts'
import './bold-hermes-updates.css'

const NONE = '__none'
const GB = 1024 ** 3

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`
}

/** The Hermes agents (not the coding agents) that can answer a test message. */
function hermesAgents(agents: AgentSummary[]): AgentSummary[] {
  return agents.filter(
    (agent) => (!agent.runtime || agent.runtime === 'hermes') && canTalkTo(agent),
  )
}

function problem(error: unknown, action: string) {
  if (error instanceof ApiError) {
    if (error.code === 'wrong_password') return <>That is not the security password.</>
    if (error.code === 'too_many_attempts')
      return <>Too many wrong passwords. Wait 15 minutes and try again.</>
    if (error.code === 'password_not_set')
      return (
        <>
          Set a security password first in{' '}
          <Link className="link" to="/b/settings/security">
            Settings › Remote access and security
          </Link>
          .
        </>
      )
    if (error.code === 'update_running') return <>An update is already running.</>
    if (error.code === 'disk_full') return <>{error.message}</>
    if (error.code === 'not_paired')
      return <>Pair this browser using the link in the server terminal first.</>
  }
  return <>Couldn’t {action}. Try again.</>
}

const STEP_LABEL = {
  wait: 'Waiting for agents to finish',
  update: 'Backing up and updating Hermes',
  check: 'Checking the new version',
} as const

const MARK = { pending: '', running: '…', done: '✓', failed: '!', skipped: '–' } as const

function Progress({ job, agents }: { job: HermesUpdateJob; agents: AgentSummary[] }) {
  const tester = job.testAgentId
    ? (agents.find((agent) => agent.id === job.testAgentId)?.name ?? job.testAgentId)
    : null
  return (
    <div className="bold-hu-run" data-protected="block" role="status" aria-label="Update progress">
      <ol>
        {job.steps.map((step) => (
          <li key={step.id} data-state={step.state}>
            <span className="bold-hu-dot" aria-hidden="true">
              {MARK[step.state]}
            </span>
            <span className="bold-hu-label">
              {step.id === 'test'
                ? step.state === 'skipped' || !tester
                  ? 'No test message'
                  : `Test message to ${tester}`
                : STEP_LABEL[step.id]}
              <span className="bold-hu-state"> ({step.state})</span>
            </span>
            <span className="bold-hu-note">{step.note}</span>
          </li>
        ))}
      </ol>
      <details open={job.outcome === 'failed' || undefined}>
        <summary>Hermes’s output</summary>
        <pre className="bold-hu-log">{job.log.length ? job.log.join('\n') : 'No output yet.'}</pre>
      </details>
    </div>
  )
}

function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="bold-hu-copy">
      <code>{command}</code>
      <button
        type="button"
        className="btn sm"
        aria-label={`Copy ${command}`}
        onClick={() =>
          void copyText(command).then((ok) => {
            if (ok) setCopied(true)
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

const PART_STATUS = {
  same: 'Same',
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
} as const

function Differs({ job, onDone }: { job: HermesUpdateJob; onDone: () => void }) {
  const { override } = useHermesCheck()
  const [password, setPassword] = useState('')
  const [on, setOn] = useState(false)
  const check = job.check
  if (!check) return null
  if (on) return <p role="status">Approvals are on for Hermes {job.toVersion ?? 'this version'}.</p>
  const parts = check.parts.filter((part) => part.status !== 'same')
  return (
    <form
      className="bold-hu-result"
      data-protected="block"
      data-tone="warn"
      aria-label="Turn approvals on anyway"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const typed = password
        setPassword('')
        override.mutate({ hash: check.hash, password: typed }, { onSuccess: () => setOn(true) })
      }}
    >
      <b className="bold-hu-title">Something Score relies on looks different</b>
      <table className="bold-hu-table">
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((part) => (
            <tr key={part.name}>
              <th scope="row">{part.name}</th>
              <td>{PART_STATUS[part.status]}</td>
              <td>{part.detail}</td>
            </tr>
          ))}
          {job.test && (
            <tr>
              <th scope="row">Test message</th>
              <td>{job.test.ok ? 'Passed' : 'Failed'}</td>
              <td>{job.test.detail}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p>
        Approvals are paused. The test passed, so you can turn them on anyway; Score hasn’t been
        tested with these changes, so approvals may show wrong details.
      </p>
      <label className="bold-hu-field">
        Security password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <div className="bold-hu-actions">
        <button type="submit" className="btn primary" disabled={override.isPending}>
          {override.isPending ? 'Turning on…' : 'Turn approvals on anyway'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Stay paused
        </button>
      </div>
      {override.isError && <p role="alert">{problem(override.error, 'turn approvals on')}</p>}
    </form>
  )
}

function Outcome({ job, onDone }: { job: HermesUpdateJob; onDone: () => void }) {
  if (job.outcome === 'clear')
    return (
      <p className="bold-hu-ok" role="status">
        <b>Hermes {job.toVersion ?? ''} works with Score.</b> Approvals are on.
      </p>
    )
  if (job.outcome === 'differs') return <Differs job={job} onDone={onDone} />
  if (job.outcome === 'broken') {
    const failedParts = (job.check?.parts ?? []).filter((part) => part.status !== 'same')
    const why =
      job.test && !job.test.ok
        ? job.test.detail
        : failedParts.map((part) => `${part.name}: ${part.detail}`).join(' ')
    return (
      <div className="bold-hu-result" data-protected="block" data-tone="bad">
        <b className="bold-hu-title">
          {job.test && !job.test.ok
            ? 'The test message failed'
            : 'This Hermes doesn’t work with Score'}
        </b>
        {why && <p>{why}</p>}
        <p>
          Approvals stay paused; chats may not work until Score is updated for this version.
          {job.backup
            ? ` Hermes saved a backup (${job.backup}) in its backups folder; Hermes keeps its last backups.`
            : ' Hermes keeps its last backups in its backups folder.'}
        </p>
        <p>To go back, run these in a terminal:</p>
        <CopyLine command="hermes update --channel stable" />
        <CopyLine
          command={`hermes import ~/.hermes/backups/${job.backup ?? '<backup file>'} --force`}
        />
      </div>
    )
  }
  if (job.outcome === 'failed')
    return (
      <div className="bold-hu-result" data-protected="block" data-tone="bad" role="alert">
        <b className="bold-hu-title">The update didn’t finish</b>
        <p>{job.error ?? 'Hermes stopped before it finished.'}</p>
      </div>
    )
  return null
}

function UpdateDialog({
  status,
  channel,
  agents,
  onClose,
}: {
  status: HermesUpdateStatus
  channel: 'stable' | 'main'
  agents: AgentSummary[]
  onClose: () => void
}) {
  const { start } = useHermesUpdateActions()
  const candidates = hermesAgents(agents)
  const [pick, setPick] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const agent = pick ?? candidates[0]?.id ?? NONE
  const needs = status.backupNeedsBytes
  const free = status.diskFreeBytes
  return (
    <form
      className="bold-hu-dialog"
      data-protected="block"
      aria-label="Update Hermes"
      onSubmit={(event) => {
        event.preventDefault()
        const typed = password
        // The password leaves state as soon as it is sent.
        setPassword('')
        start.mutate(
          { channel, testAgentId: agent === NONE ? null : agent, password: typed },
          { onSuccess: onClose },
        )
      }}
    >
      <h3>Update Hermes</h3>
      <ol>
        <li>Waits until no agent is working (Score starts no new turns meanwhile).</li>
        <li>
          Backs up your Hermes folder
          {needs != null ? `: about ${gb(needs)}` : ''}
          {free != null ? `; ${gb(free)} free` : ''}. Hermes keeps its last backups. The gateway
          stops for a short while.
        </li>
        <li>Updates Hermes and restarts the gateway.</li>
        <li>Checks the new version, then sends one short test message to the agent you pick.</li>
      </ol>
      <label className="bold-hu-field">
        Test with
        <select value={agent} onChange={(event) => setPick(event.target.value)}>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
              {candidate.model ? ` · ${candidate.model.label}` : ''}
            </option>
          ))}
          <option value={NONE}>No test message (checks only)</option>
        </select>
      </label>
      <label className="bold-hu-field">
        Security password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <div className="bold-hu-actions">
        <button type="submit" className="btn primary" disabled={start.isPending}>
          {start.isPending ? 'Starting…' : 'Back up and update'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {start.isError && <p role="alert">{problem(start.error, 'start the update')}</p>}
    </form>
  )
}

/** Settings › System: update Hermes, with a backup, Score's check and a test message (3.15.0, owner). */
export function BoldHermesUpdates() {
  const status = useHermesUpdateStatus()
  const system = useSystemStatus()
  const agents = useStreamQuery(agentsQuery).data ?? []
  const { check } = useHermesUpdateActions()
  const [channel, setChannel] = useState(readChannel)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const data = status.data
  const job = data?.job ?? null
  const checked = check.data ?? (data?.lastCheck?.channel === channel ? data.lastCheck : null)
  // A finished job stays until the next check (or until the person closes it).
  const jobShown =
    job != null &&
    dismissed !== job.id &&
    (job.state === 'running' ||
      !data?.lastCheck ||
      !job.endedAt ||
      data.lastCheck.checkedAt <= job.endedAt)
  const running = job?.state === 'running'

  return (
    <section
      className="card bold-hu span2"
      aria-labelledby="system-hermes-updates"
      id="hermes-updates"
    >
      <h3 id="system-hermes-updates">Hermes updates</h3>
      {status.isPending && <p className="small muted">Loading…</p>}
      {status.isError && <p role="alert">Couldn’t load the Hermes update status.</p>}
      {data && !data.available && (
        <p className="small muted">Updating Hermes isn’t available here.</p>
      )}
      {data?.available && (
        <>
          <div className="bold-hu-facts">
            <div>
              <span className="small muted">Version</span>
              <b>{data.version ?? 'unknown'}</b>
            </div>
            <div>
              <label htmlFor="hermes-channel" className="small muted">
                Update channel
              </label>
              <select
                id="hermes-channel"
                className="field"
                value={channel}
                disabled={running}
                onChange={(event) => {
                  const next = event.target.value === 'stable' ? 'stable' : 'main'
                  setChannel(next)
                  rememberChannel(next)
                  check.reset()
                }}
              >
                <option value="stable">Stable releases</option>
                <option value="main">Every change (main)</option>
              </select>
            </div>
            <div>
              <span className="small muted">Score’s check</span>
              <b data-ok={system.data?.compatibility.tested ? 'true' : 'false'}>
                {!system.data
                  ? '…'
                  : system.data.compatibility.tested
                    ? 'Tested'
                    : 'Approvals paused'}
              </b>
            </div>
          </div>

          {job && jobShown && (
            <>
              <Progress job={job} agents={agents} />
              {job.state === 'finished' && (
                <Outcome job={job} onDone={() => setDismissed(job.id)} />
              )}
            </>
          )}

          {!running && !open && (
            <>
              {checked && (
                <div className="bold-hu-found" role="status">
                  <b>{checked.summary}</b>
                  {checked.restarts.length > 0 && (
                    <span>Restarts: {checked.restarts.join(', ')}</span>
                  )}
                </div>
              )}
              <div className="bold-hu-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={check.isPending}
                  onClick={() =>
                    check.mutate(channel, {
                      onSuccess: () => {
                        if (job) setDismissed(job.id)
                      },
                    })
                  }
                >
                  {check.isPending ? 'Checking…' : checked ? 'Check again' : 'Check for updates'}
                </button>
                {checked?.available && (
                  <button type="button" className="btn primary" onClick={() => setOpen(true)}>
                    Update Hermes…
                  </button>
                )}
              </div>
              {check.isError && <p role="alert">{problem(check.error, 'check for updates')}</p>}
            </>
          )}

          {open && !running && (
            <UpdateDialog
              status={data}
              channel={channel}
              agents={agents}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      )}
    </section>
  )
}
