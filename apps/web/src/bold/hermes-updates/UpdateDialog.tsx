import { useState } from 'react'
import type { AgentSummary, HermesUpdateStatus } from '@score/contract'
import { useHermesUpdateActions } from '../hermes-update-queries.ts'
import { gb, hermesAgents, NONE } from './hermes-update-model.ts'
import { problem } from './hermes-update-problem.tsx'

export function UpdateDialog({
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
  // A picked agent that has since gone falls back to the first one (review).
  const agent =
    pick !== null && (pick === NONE || candidates.some((candidate) => candidate.id === pick))
      ? pick
      : (candidates[0]?.id ?? NONE)
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
        <li>Waits until no agent is working; Hermes then pauses its gateway.</li>
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
          // The dialog opens on the one thing the person must type (review).
          autoFocus
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
