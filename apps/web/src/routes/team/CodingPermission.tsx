import type { CodingPermission, CodingRuntime } from '@score/contract'
import { permissionLabels, shortNames } from './coding-agent-permissions.ts'

/** What the chosen CLI can read, in two short lines, stated where the person chooses (7.2 review #1a; owner 2026-10-11). */
export function ReadAccessWarning({
  runtime,
  permission,
  brief = false,
}: {
  runtime: CodingRuntime
  permission: CodingPermission
  /** Only what the CLI can read: the agent's page shows the "follow instructions" line where it is edited. */
  brief?: boolean
}) {
  const reach =
    runtime === 'claude-code'
      ? 'Claude Code can read files outside its workspace, but Score blocks your Hermes, Score and SSH folders and .env files.'
      : runtime === 'codex'
        ? 'Codex can read every file your user can, including Hermes settings and keys. Score can’t block that.'
        : runtime === 'antigravity'
          ? permission === 'full'
            ? 'With full access, Antigravity can read and change every file your user can.'
            : 'Antigravity’s sandbox keeps it inside its workspace: it can’t read or change files elsewhere.'
          : 'This agent runs as your user.'
  return (
    <div className="team-muted-strong coding-reach" role="note" data-protected="any">
      <p>{reach}</p>
      {!brief && (
        <p>
          Coding agents follow instructions they find in files and messages, so connect only
          workspaces and rooms you trust.
        </p>
      )}
    </div>
  )
}

export function PermissionPicker({
  value,
  onChange,
  name,
  runtime,
  unverified,
}: {
  value: CodingPermission
  onChange: (value: CodingPermission) => void
  name: string
  runtime: CodingRuntime
  /** Levels Score has not live-verified for this CLI: shown, but not selectable. */
  unverified: readonly CodingPermission[]
}) {
  return (
    <fieldset className="team-coding-permission" data-protected="any">
      <legend>Permission</legend>
      {(Object.keys(permissionLabels) as CodingPermission[]).map((level) => (
        <label key={level}>
          <input
            type="radio"
            name={name}
            checked={value === level}
            disabled={unverified.includes(level) && value !== level}
            onChange={() => onChange(level)}
          />{' '}
          {permissionLabels[level]}
          {unverified.includes(level) && (
            <span className="team-muted">
              {' '}
              (not verified for {shortNames[runtime] ?? runtime} yet)
            </span>
          )}
        </label>
      ))}
      {runtime === 'antigravity' && value === 'workspace-write' && (
        <p className="team-muted-strong">
          Antigravity can’t run shell commands at this level (no tests or builds); use Full access
          for that.
        </p>
      )}
      {value === 'full' && (
        <p role="alert" className="team-muted-strong">
          Full access turns the CLI’s own sandbox off. Anything it is told to do runs as your user.
          You will be asked for the security password.
        </p>
      )}
    </fieldset>
  )
}
