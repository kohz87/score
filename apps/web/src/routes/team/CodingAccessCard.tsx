import type { CodingAgent } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PermissionPicker, ReadAccessWarning } from './CodingPermission.tsx'
import { permissionMeaning, permissionNames } from './coding-agent-permissions.ts'
import { codingRuntimesQuery, useCodingPatch } from './coding-agent-queries.ts'

/** What the agent may do and when runs stop using it. Edited in place, with its own Save. */
export function CodingAccessCard({
  coding,
  onChanged,
}: {
  coding: CodingAgent
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  return (
    <section className="team-card" aria-labelledby="coding-access" data-protected="block">
      <h2 id="coding-access">Access</h2>
      {editing ? (
        // Drafts, the typed password and a failed save's error live in the editor and go when it closes.
        <AccessEditor coding={coding} onChanged={onChanged} onClose={() => setEditing(false)} />
      ) : (
        <>
          <p className="team-model-name">{permissionNames[coding.permission]}</p>
          <p className="team-muted-strong">
            {permissionMeaning[coding.permission]}{' '}
            {coding.quotaFloorPercent > 0
              ? `Runs stop using it below ${coding.quotaFloorPercent}% of a limit left.`
              : 'Runs keep using it whatever its limits show.'}
          </p>
          <ReadAccessWarning runtime={coding.runtime} permission={coding.permission} brief />
          <button type="button" className="team-text-action" onClick={() => setEditing(true)}>
            Change access
          </button>
        </>
      )}
    </section>
  )
}

function AccessEditor({
  coding,
  onChanged,
  onClose,
}: {
  coding: CodingAgent
  onChanged: () => void
  onClose: () => void
}) {
  const [permission, setPermission] = useState(coding.permission)
  const [password, setPassword] = useState('')
  const [floor, setFloor] = useState(String(coding.quotaFloorPercent))
  const floorValue = Number(floor)
  const floorValid =
    floor.trim() !== '' && Number.isInteger(floorValue) && floorValue >= 0 && floorValue <= 50
  const runtimes = useQuery(codingRuntimesQuery)
  const unverified =
    runtimes.data?.find((item) => item.runtime === coding.runtime)?.unverifiedPermissions ?? []
  const needsPassword = permission === 'full' && coding.permission !== 'full'
  const save = useCodingPatch(coding, onChanged, onClose)
  return (
    <form
      className="team-routine-form"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate({
          // Only what changed: an unchanged level is never re-sent with a password.
          ...(permission !== coding.permission ? { permission } : {}),
          quotaFloorPercent: floorValue,
          ...(needsPassword ? { password } : {}),
        })
      }}
    >
      <PermissionPicker
        value={permission}
        onChange={setPermission}
        name="coding-permission-edit"
        runtime={coding.runtime}
        unverified={unverified}
      />
      {needsPassword && (
        <label>
          Security password
          <input
            type="password"
            required
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      )}
      <div className="team-quota-floor">
        <label>
          Stop using this agent in runs when a limit is below
          <span className="team-quota-floor-input">
            <input
              type="number"
              min={0}
              max={50}
              step={1}
              inputMode="numeric"
              value={floor}
              aria-invalid={!floorValid}
              onChange={(event) => setFloor(event.target.value)}
            />
            <span aria-hidden>%</span>
          </span>
        </label>
        <p className="team-muted">
          Orchestrations and workflows don’t give it new steps while a limit has less than this
          left. Steps already running carry on. Enter 0 to turn this off.
        </p>
      </div>
      <ReadAccessWarning runtime={coding.runtime} permission={permission} />
      {save.error && <p role="alert">{save.error.message}</p>}
      <div className="team-file-actions">
        <button
          className="team-primary"
          disabled={
            save.isPending ||
            !floorValid ||
            (permission !== coding.permission && unverified.includes(permission))
          }
        >
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}
