import {
  CodingAgentSchema,
  CodingAgentsResponseSchema,
  CodingRuntimesResponseSchema,
  CodingUsageSchema,
  ShapeSchema,
  type AgentDetail,
  type CodingAgent,
  type CodingPermission,
  type CodingRuntime,
  type AgentStyle,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch } from '../../data/api.ts'
import { runtimeLabel } from '../../components/runtime-label.ts'

const permissionLabels: Record<CodingPermission, string> = {
  'read-only': 'Read only: looks at files, changes nothing',
  'workspace-write': 'Workspace write: edits files in its workspace (default)',
  full: 'Full access: no sandbox, runs anything as you',
}

/** Whether this CLI can read files outside its workspace at this level (then adding it needs an acknowledgement). */
export function readsOutsideWorkspace(
  runtime: CodingRuntime,
  permission: CodingPermission,
): boolean {
  if (runtime === 'codex') return true
  if (runtime === 'antigravity') return permission === 'full'
  return false
}

/** What the chosen CLI can read, in two short lines, stated where the person chooses (7.2 review #1a; owner 2026-10-11). */
export function ReadAccessWarning({
  runtime,
  permission,
}: {
  runtime: CodingRuntime
  permission: CodingPermission
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
    <div className="team-muted-strong coding-reach" role="note">
      <p>{reach}</p>
      <p>
        Coding agents follow instructions they find in files and messages, so connect only
        workspaces and rooms you trust.
      </p>
    </div>
  )
}

const codingRuntimesQuery = {
  queryKey: ['coding', 'runtimes'],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    CodingRuntimesResponseSchema.parse(await apiFetch('coding-agents/runtimes', { signal })).items,
}
const codingAgentsQuery = {
  queryKey: ['coding', 'agents'],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    CodingAgentsResponseSchema.parse(await apiFetch('coding-agents', { signal })).items,
}

/** The short name used in "not verified for agy yet". */
const shortNames: Partial<Record<CodingRuntime, string>> = { antigravity: 'agy' }

function PermissionPicker({
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
    <fieldset className="team-coding-permission">
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

function resetText(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Antigravity's own quota (`/usage`): the 5-hour and weekly share left per model group. */
function AntigravityQuota() {
  const usage = useQuery({
    queryKey: ['coding', 'usage', 'antigravity'],
    queryFn: async ({ signal }) =>
      CodingUsageSchema.parse(
        await apiFetch('coding-agents/runtimes/antigravity/usage', { signal }),
      ),
    retry: false,
    staleTime: 60_000,
  })
  if (usage.isPending) return <p className="team-muted">Reading the Antigravity quota…</p>
  if (usage.error)
    return <p className="team-muted">Antigravity quota unavailable: {usage.error.message}</p>
  const { groups, text } = usage.data
  return (
    <div aria-label="Antigravity quota" role="group">
      {groups.length === 0 ? (
        <pre className="team-muted">{text}</pre>
      ) : (
        <ul className="team-muted team-coding-quota">
          {groups.map((group) => (
            <li key={group.name}>
              {group.name}: {group.fiveHourRemainingPercent ?? '?'}% left in the 5-hour window
              {group.fiveHourResets ? ` (resets ${resetText(group.fiveHourResets)})` : ''}
              {group.weeklyRemainingPercent !== null
                ? `, ${group.weeklyRemainingPercent}% left this week${group.weeklyResets ? ` (resets ${resetText(group.weeklyResets)})` : ''}`
                : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function AddCodingAgentForm({ close }: { close: () => void }) {
  const queryClient = useQueryClient()
  const runtimes = useQuery(codingRuntimesQuery)
  const [runtime, setRuntime] = useState<CodingRuntime>('claude-code')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [model, setModel] = useState('')
  const [permission, setPermission] = useState<CodingPermission>('workspace-write')
  const [password, setPassword] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [style, setStyle] = useState<AgentStyle>({ color: '#6B4EFF', shape: 'hexagon' })
  const info = runtimes.data?.find((item) => item.runtime === runtime)
  const usable = info?.state === 'ready' || info?.state === 'untested_version'
  const unverified = info?.unverifiedPermissions ?? []
  const needsAck = readsOutsideWorkspace(runtime, permission)
  const create = useMutation({
    mutationFn: async () =>
      CodingAgentSchema.parse(
        await apiFetch('coding-agents', {
          method: 'POST',
          body: JSON.stringify({
            id,
            name: name || id,
            runtime,
            permission,
            style,
            ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(permission === 'full' ? { password } : {}),
            ...(needsAck ? { acknowledgeReads: true } : {}),
          }),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['coding'] })
      void queryClient.invalidateQueries({ queryKey: ['team'] })
    },
  })
  if (create.data)
    return (
      <>
        <p role="status">{create.data.name} joined the team.</p>
        <Link to={`/team/${encodeURIComponent(create.data.id)}`} onClick={close}>
          View agent
        </Link>
      </>
    )
  return (
    <form
      className="team-routine-form"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate()
      }}
    >
      <label>
        Kind of coding agent
        <select
          aria-label="Kind of coding agent"
          value={runtime}
          onChange={(event) => {
            const next = event.target.value as CodingRuntime
            setRuntime(next)
            // A level that is not verified for the new CLI is never kept selected.
            const blocked =
              runtimes.data?.find((item) => item.runtime === next)?.unverifiedPermissions ?? []
            if (blocked.includes(permission))
              setPermission(
                (['read-only', 'workspace-write', 'full'] as const).find(
                  (level) => !blocked.includes(level),
                ) ?? permission,
              )
          }}
        >
          {runtimes.data?.map((item) => (
            <option key={item.runtime} value={item.runtime}>
              {item.label}
              {item.state === 'ready'
                ? ''
                : item.state === 'untested_version'
                  ? ' (untested version)'
                  : item.state === 'not_supported'
                    ? ' (not supported yet)'
                    : ' (not installed)'}
            </option>
          ))}
        </select>
      </label>
      {info && (
        <p className="team-muted-strong">
          {info.message ?? (info.version ? `Version ${info.version}. ` : '')}
          {info.quota}
        </p>
      )}
      {info?.warning && (
        <p className="team-muted-strong" role="note">
          {info.warning}
        </p>
      )}
      {runtime === 'antigravity' && usable && <AntigravityQuota />}
      <label>
        Agent name (letters, digits, - and _)
        <input
          required
          pattern="[a-z0-9][a-z0-9_-]{0,63}"
          maxLength={64}
          value={id}
          onChange={(event) => {
            setId(event.target.value)
            setName(event.target.value)
          }}
        />
      </label>
      <label>
        Workspace folder (optional)
        <input
          placeholder="~/score-workspaces/<name>"
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
        />
      </label>
      <label>
        Model (optional, the CLI’s default otherwise)
        <input
          value={model}
          maxLength={200}
          pattern="[A-Za-z0-9][A-Za-z0-9._:/@+\-]*"
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <PermissionPicker
        value={permission}
        onChange={setPermission}
        name="coding-permission"
        runtime={runtime}
        unverified={unverified}
      />
      {needsAck && (
        <label className="coding-acknowledge">
          <input
            type="checkbox"
            required
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand {info?.label ?? 'this agent'} can read any file my user can, including
          secrets outside its workspace.
        </label>
      )}
      {permission === 'full' && (
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
      <div className="team-profile-appearance">
        <AgentGlyph
          agent={{ id: id || 'new', name: id || 'New agent', style }}
          describeShape
          contrast="high"
        />
        <label>
          Colour
          <input
            type="color"
            value={style.color}
            onChange={(event) => setStyle({ ...style, color: event.target.value })}
          />
        </label>
        <label>
          Shape
          <select
            aria-label="Shape"
            value={style.shape}
            onChange={(event) =>
              setStyle({ ...style, shape: ShapeSchema.parse(event.target.value) })
            }
          >
            {ShapeSchema.options.map((shape) => (
              <option key={shape}>{shape}</option>
            ))}
          </select>
        </label>
      </div>
      <ReadAccessWarning runtime={runtime} permission={permission} />
      {create.error && <p role="alert">{create.error.message}</p>}
      <div className="team-file-actions">
        <button
          className="team-primary"
          disabled={
            create.isPending ||
            !usable ||
            !id ||
            (needsAck && !acknowledged) ||
            unverified.includes(permission)
          }
        >
          {create.isPending ? 'Adding…' : 'Add coding agent'}
        </button>
      </div>
    </form>
  )
}

export function CodingOverview({ agent }: { agent: AgentDetail }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const list = useQuery(codingAgentsQuery)
  const coding = list.data?.find((item) => item.id === agent.id)
  if (list.isPending) return <p role="status">Loading…</p>
  if (!coding)
    return (
      <section className="team-card" role="alert">
        <p>This coding agent is no longer available.</p>
      </section>
    )
  return (
    <CodingSettings
      key={`${coding.permission}:${coding.model}:${coding.cli.confirmed}`}
      coding={coding}
      onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: ['coding'] })
        void queryClient.invalidateQueries({ queryKey: ['team'] })
      }}
      onRemoved={() => {
        void queryClient.invalidateQueries({ queryKey: ['coding'] })
        void queryClient.invalidateQueries({ queryKey: ['team'] })
        void navigate('/team')
      }}
    />
  )
}

const cliStates = {
  ready: 'Ready',
  not_installed: 'Not installed',
  not_supported: 'Not supported yet',
  untested_version: 'Untested version',
} as const

function CodingSettings({
  coding,
  onChanged,
  onRemoved,
}: {
  coding: CodingAgent
  onChanged: () => void
  onRemoved: () => void
}) {
  const [permission, setPermission] = useState(coding.permission)
  const [model, setModel] = useState(coding.model ?? '')
  const [password, setPassword] = useState('')
  const runtimes = useQuery(codingRuntimesQuery)
  const unverified =
    runtimes.data?.find((item) => item.runtime === coding.runtime)?.unverifiedPermissions ?? []
  const needsPassword = permission === 'full' && coding.permission !== 'full'
  const save = useMutation({
    mutationFn: async () =>
      CodingAgentSchema.parse(
        await apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            permission,
            model: model.trim() || null,
            ...(needsPassword ? { password } : {}),
          }),
        }),
      ),
    onSuccess: onChanged,
  })
  const confirm = useMutation({
    mutationFn: async () =>
      apiFetch(`coding-agents/${encodeURIComponent(coding.id)}/confirm-version`, {
        method: 'POST',
        body: JSON.stringify({ version: coding.cli.version }),
      }),
    onSuccess: onChanged,
  })
  const remove = useMutation({
    mutationFn: () =>
      apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, { method: 'DELETE' }),
    onSuccess: onRemoved,
  })
  return (
    <section className="team-card" aria-label="Coding agent">
      <h2>Coding agent</h2>
      <dl className="team-facts">
        <div>
          <dt>CLI</dt>
          <dd>
            {runtimeLabel(coding.runtime) ?? coding.runtime} {coding.cli.version ?? ''} ·{' '}
            {cliStates[coding.cli.state]}
            {coding.cli.state === 'untested_version' &&
              coding.cli.confirmed &&
              ' (you confirmed it)'}
          </dd>
        </div>
        <div>
          <dt>Quota</dt>
          <dd>{coding.quota}</dd>
        </div>
        {coding.runtime === 'antigravity' && (
          <div>
            <dt>Limits left</dt>
            <dd>
              <AntigravityQuota />
            </dd>
          </div>
        )}
        <div>
          <dt>Workspace</dt>
          <dd>
            <code>{coding.workspace}</code>
          </dd>
        </div>
      </dl>
      {coding.cli.state === 'untested_version' && !coding.cli.confirmed && (
        <div role="alert">
          <p className="team-muted-strong">
            Score was tested with {coding.cli.testedVersions.join(', ')}. The installed{' '}
            {coding.cli.version} may change its output; it runs only after you confirm it.
          </p>
          <button
            type="button"
            className="team-pill-button"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            Run with {coding.cli.version} anyway
          </button>
        </div>
      )}
      <form
        className="team-routine-form"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <label>
          Model (optional)
          <input
            value={model}
            maxLength={200}
            pattern="[A-Za-z0-9][A-Za-z0-9._:/@+\-]*"
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
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
        <ReadAccessWarning runtime={coding.runtime} permission={permission} />
        {(save.error || confirm.error || remove.error) && (
          <p role="alert">{(save.error ?? confirm.error ?? remove.error)?.message}</p>
        )}
        <div className="team-file-actions">
          <button
            className="team-primary"
            disabled={
              save.isPending ||
              (permission !== coding.permission && unverified.includes(permission))
            }
          >
            Save
          </button>
          <button
            type="button"
            className="team-pill-button"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Remove ${coding.name} from the team? Past work stays in rooms.`))
                remove.mutate()
            }}
          >
            Remove agent
          </button>
        </div>
      </form>
    </section>
  )
}
