import {
  CODING_EFFORTS,
  CodingAgentSchema,
  CodingAgentsResponseSchema,
  CodingRuntimesResponseSchema,
  type AgentDetail,
  type CodingAgent,
  type CodingPermission,
  type CodingRuntime,
  type AgentStyle,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { AgentAppearanceFields } from './AgentAppearanceFields.tsx'
import { apiFetch } from '../../data/api.ts'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { CodingBackend } from './CodingBackend.tsx'
import { CodingPersonality } from './CodingPersonality.tsx'
import { AGENT_ID_PATTERN, agentIdInput } from './agent-id.ts'
import { ModelPicker, useCodingModels } from './ModelPicker.tsx'
import { EffortSelect } from '../../components/model-settings/EffortSelect.tsx'
import { ReleaseHeld } from './ReleaseHeld.tsx'
import { AgentQuota, RuntimeQuotaLine } from './QuotaMeters.tsx'

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

const shortPermission: Record<CodingPermission, string> = {
  'read-only': 'read only',
  'workspace-write': 'workspace write',
  full: 'full access',
}

/** The coding-agent create fields, validation, consent and mutation, shared by the classic form and the bold dialog. */
export function useCodingAgentDraft(
  onAdded: (agent: CodingAgent, detail: string) => void,
  initialStyle: AgentStyle = { color: '#6B4EFF', shape: 'hexagon' },
) {
  const queryClient = useQueryClient()
  const runtimes = useQuery(codingRuntimesQuery)
  const [runtime, setRuntime] = useState<CodingRuntime>('claude-code')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [model, setModel] = useState('')
  const [permission, setPermission] = useState<CodingPermission>('workspace-write')
  const [password, setPassword] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [style, setStyle] = useState<AgentStyle>(initialStyle)
  const info = runtimes.data?.find((item) => item.runtime === runtime)
  const usable = info?.state === 'ready' || info?.state === 'untested_version'
  const unverified = info?.unverifiedPermissions ?? []
  const needsAck = readsOutsideWorkspace(runtime, permission)
  const chooseRuntime = (next: CodingRuntime) => {
    setRuntime(next)
    // A model name of one CLI means nothing to another.
    setModel('')
    // A level that is not verified for the new CLI is never kept selected.
    const blocked =
      runtimes.data?.find((item) => item.runtime === next)?.unverifiedPermissions ?? []
    if (blocked.includes(permission))
      setPermission(
        (['read-only', 'workspace-write', 'full'] as const).find(
          (level) => !blocked.includes(level),
        ) ?? permission,
      )
  }
  const create = useMutation({
    mutationFn: async () =>
      CodingAgentSchema.parse(
        await apiFetch('coding-agents', {
          method: 'POST',
          body: JSON.stringify({
            id,
            name: name || id,
            ...(role.trim() ? { role: role.trim() } : {}),
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
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: ['coding'] })
      void queryClient.invalidateQueries({ queryKey: ['team'] })
      onAdded(
        agent,
        [
          'Coding agent',
          info?.label ?? runtime,
          agent.model ?? 'the CLI’s default model',
          shortPermission[agent.permission],
        ].join(' · '),
      )
    },
  })
  return {
    runtimes,
    runtime,
    chooseRuntime,
    id,
    setId,
    name,
    setName,
    role,
    setRole,
    workspace,
    setWorkspace,
    model,
    setModel,
    permission,
    setPermission,
    password,
    setPassword,
    acknowledged,
    setAcknowledged,
    style,
    setStyle,
    info,
    usable,
    unverified,
    needsAck,
    create,
  }
}

export type CodingAgentDraft = ReturnType<typeof useCodingAgentDraft>

export function AddCodingAgentForm({
  onAdded,
}: {
  /** The agent and one line about it, for the dialog's "joined the team" view. */
  onAdded: (agent: CodingAgent, detail: string) => void
}) {
  const draft = useCodingAgentDraft(onAdded)
  const {
    runtimes,
    runtime,
    chooseRuntime,
    id,
    setId,
    setName,
    role,
    setRole,
    workspace,
    setWorkspace,
    model,
    setModel,
    permission,
    setPermission,
    password,
    setPassword,
    acknowledged,
    setAcknowledged,
    style,
    setStyle,
    info,
    usable,
    unverified,
    needsAck,
    create,
  } = draft
  return (
    // One decision: the runtime's message and warning, the permission and read-access context, the fields that carry
    // consent and the button that commits it. Vetting any click or the submit measures all of them (data-decision).
    <form
      className="team-routine-form"
      data-decision
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
          onChange={(event) => chooseRuntime(event.target.value as CodingRuntime)}
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
        <p className="team-muted-strong coding-add-context" data-protected="block">
          {info.message ?? (info.version ? `Version ${info.version}. ` : '')}
          {info.quota}
        </p>
      )}
      {info?.warning && (
        <p className="team-muted-strong coding-add-context" role="note" data-protected="block">
          {info.warning}
        </p>
      )}
      {usable && <RuntimeQuotaLine runtime={runtime} />}
      <label>
        Agent name (lowercase letters, digits, - and _)
        <input
          required
          pattern={AGENT_ID_PATTERN}
          title="Lowercase letters, digits, - and _"
          maxLength={64}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={id}
          onChange={(event) => {
            const next = agentIdInput(event.target.value)
            setId(next)
            setName(next)
          }}
        />
      </label>
      <label>
        Role (optional)
        <input
          maxLength={2000}
          placeholder="For example: reviews build scripts"
          value={role}
          onChange={(event) => setRole(event.target.value)}
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
      <ModelPicker key={runtime} runtime={runtime} value={model} onChange={setModel} />
      <PermissionPicker
        value={permission}
        onChange={setPermission}
        name="coding-permission"
        runtime={runtime}
        unverified={unverified}
      />
      {needsAck && (
        <label className="coding-acknowledge" data-protected="any">
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
        <label data-protected="any">
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
      <AgentAppearanceFields
        value={style}
        onChange={setStyle}
        preview={{ id: id || 'new', name: id || 'New agent' }}
      />
      <ReadAccessWarning runtime={runtime} permission={permission} />
      {create.error && <p role="alert">{create.error.message}</p>}
      <div className="team-file-actions">
        <button
          className="team-primary coding-add-commit"
          data-protected="inline-flex"
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

export function CodingOverview({
  agent,
  teamPath = '/team',
}: {
  agent: AgentDetail
  /** Where to go after removal; the bold shell passes its own Team route. */
  teamPath?: string
}) {
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
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ['coding'] })
    void queryClient.invalidateQueries({ queryKey: ['team'] })
  }
  return (
    <div className="team-stack">
      {/* Keyed by the agent, not the stored text: a refresh must not unmount an open editor. The editor keeps its
          draft and base etag and shows a change saved elsewhere as the conflict choices. */}
      <CodingPersonality
        key={coding.id}
        coding={coding}
        onChanged={changed}
        facts={<CodingFacts coding={coding} />}
      />
      <CodingAlerts coding={coding} onChanged={changed} />
      <div className="team-overview-grid">
        <section className="team-card" aria-labelledby="coding-limits" data-protected="block">
          <h2 id="coding-limits">Limits left</h2>
          <AgentQuota
            agentId={coding.id}
            runtime={coding.runtime}
            floor={coding.quotaFloorPercent}
          />
        </section>
        <CodingModelCard
          key={`model:${coding.model ?? ''}:${coding.effort ?? ''}`}
          coding={coding}
          onChanged={changed}
        />
        <CodingAccessCard
          key={`access:${coding.permission}:${coding.quotaFloorPercent}`}
          coding={coding}
          onChanged={changed}
        />
      </div>
      <CodingDanger
        coding={coding}
        onRemoved={() => {
          changed()
          void navigate(teamPath)
        }}
      />
    </div>
  )
}

const cliStates = {
  ready: 'Ready',
  not_installed: 'Not installed',
  not_supported: 'Not supported yet',
  untested_version: 'Untested version',
} as const

/** The right-hand column of the Personality card: what runs this agent and where. */
function CodingFacts({ coding }: { coding: CodingAgent }) {
  return (
    <dl className="team-facts team-facts-stacked">
      <div>
        <dt>CLI</dt>
        <dd>
          {runtimeLabel(coding.runtime) ?? coding.runtime} {coding.cli.version ?? ''} ·{' '}
          {cliStates[coding.cli.state]}
          {coding.cli.state === 'untested_version' && coding.cli.confirmed && ' (you confirmed it)'}
          <CodingBackend />
        </dd>
      </div>
      <div>
        <dt>Workspace</dt>
        <dd>
          <code>{coding.workspace}</code>
        </dd>
      </div>
      <div>
        <dt>Quota source</dt>
        <dd className="team-facts-plain">{coding.quota}</dd>
      </div>
    </dl>
  )
}

/** Things that stop the agent working: held programs and an untested CLI version. Shown only when they apply. */
function CodingAlerts({ coding, onChanged }: { coding: CodingAgent; onChanged: () => void }) {
  const confirm = useMutation({
    mutationFn: async () =>
      apiFetch(`coding-agents/${encodeURIComponent(coding.id)}/confirm-version`, {
        method: 'POST',
        body: JSON.stringify({ version: coding.cli.version }),
      }),
    onSuccess: onChanged,
  })
  const held = coding.heldGroups.length > 0
  const untested = coding.cli.state === 'untested_version' && !coding.cli.confirmed
  if (!held && !untested) return null
  return (
    <section className="team-card" aria-label="Needs attention" data-protected="block">
      {held && (
        <div role="alert">
          <p className="team-muted-strong">
            Some programs this agent started couldn’t be proven ended. Score keeps trying to stop
            them, and the agent takes no new messages until they have ended.
          </p>
          <ReleaseHeld agentId={coding.id} />
        </div>
      )}
      {untested && (
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
          {confirm.error && <p role="alert">{confirm.error.message}</p>}
        </div>
      )}
    </section>
  )
}

function useCodingPatch(coding: CodingAgent, onChanged: () => void, done: () => void) {
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      CodingAgentSchema.parse(
        await apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      ),
    onSuccess: () => {
      onChanged()
      done()
    },
  })
}

/** The model, large like a Hermes agent's Model card; "Change model" opens the picker right here. */
function CodingModelCard({ coding, onChanged }: { coding: CodingAgent; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  return (
    <section className="team-card" aria-labelledby="coding-model" data-protected="block">
      <h2 id="coding-model">Model</h2>
      {editing ? (
        // The drafts live in the editor, so Cancel and a saved change unmount them: nothing stale is kept.
        <ModelEditor coding={coding} onChanged={onChanged} onClose={() => setEditing(false)} />
      ) : (
        <>
          <p className="team-model-name">{coding.model ?? 'CLI default'}</p>
          <p className="team-muted-strong">
            {coding.model
              ? `Set for this agent. ${runtimeLabel(coding.runtime) ?? coding.runtime} uses it for every turn.`
              : 'The CLI picks its own model.'}
          </p>
          {CODING_EFFORTS[coding.runtime] && (
            <p className="team-muted-strong">Effort: {coding.effort ?? 'Default'}</p>
          )}
          <button type="button" className="team-text-action" onClick={() => setEditing(true)}>
            Change model
          </button>
        </>
      )}
    </section>
  )
}

function ModelEditor({
  coding,
  onChanged,
  onClose,
}: {
  coding: CodingAgent
  onChanged: () => void
  onClose: () => void
}) {
  const [model, setModel] = useState(coding.model ?? '')
  const [effort, setEffort] = useState(coding.effort ?? '')
  const save = useCodingPatch(coding, onChanged, onClose)
  const models = useCodingModels(coding.runtime)
  const runtimeLevels = CODING_EFFORTS[coding.runtime]
  // Codex lists the levels per model; when the chosen model lists some, offer those the server accepts.
  const own = models.data?.models.find((item) => item.id === model.trim())?.efforts
  const levels =
    coding.runtime === 'codex' && own?.length
      ? (runtimeLevels ?? []).filter((level) => own.includes(level))
      : (runtimeLevels ?? [])
  return (
    <form
      className="team-routine-form"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate({
          model: model.trim() || null,
          ...(runtimeLevels && effort !== (coding.effort ?? '') ? { effort: effort || null } : {}),
        })
      }}
    >
      <ModelPicker runtime={coding.runtime} value={model} onChange={setModel} />
      {runtimeLevels && <EffortSelect value={effort} levels={levels} onChange={setEffort} />}
      {save.error && <p role="alert">{save.error.message}</p>}
      <div className="team-file-actions">
        <button className="team-primary" disabled={save.isPending}>
          Save
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

const permissionNames: Record<CodingPermission, string> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  full: 'Full access',
}
const permissionMeaning: Record<CodingPermission, string> = {
  'read-only': 'Looks at files, changes nothing.',
  'workspace-write': 'Edits files in its own workspace.',
  full: 'No sandbox: runs anything as you.',
}

/** What the agent may do and when runs stop using it. Edited in place, with its own Save. */
function CodingAccessCard({ coding, onChanged }: { coding: CodingAgent; onChanged: () => void }) {
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

/** At the bottom, apart from the cards, like a Hermes agent's Danger zone. */
function CodingDanger({ coding, onRemoved }: { coding: CodingAgent; onRemoved: () => void }) {
  const remove = useMutation({
    mutationFn: () =>
      apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, { method: 'DELETE' }),
    onSuccess: onRemoved,
  })
  return (
    <section
      className="team-card team-profile-danger team-section-gap"
      aria-labelledby="coding-danger"
      data-protected="block"
    >
      <h2 id="coding-danger">Danger zone</h2>
      <p>Removing {coding.name} takes it off the team. Past work stays in rooms.</p>
      {remove.error && <p role="alert">{remove.error.message}</p>}
      <div className="team-file-actions">
        <button
          id="agent-delete"
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Remove ${coding.name} from the team? Past work stays in rooms.`))
              remove.mutate()
          }}
        >
          Remove agent
        </button>
      </div>
    </section>
  )
}
