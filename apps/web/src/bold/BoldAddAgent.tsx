import type { AgentSummary } from '@score/contract'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AGENT_ID_PATTERN, agentIdInput } from '../routes/team/agent-id.ts'
import {
  PermissionPicker,
  ReadAccessWarning,
  useCodingAgentDraft,
} from '../routes/team/CodingAgent.tsx'
import { ModelPicker as CodingModelPicker } from '../routes/team/ModelPicker.tsx'
import { RuntimeQuotaLine } from '../routes/team/QuotaMeters.tsx'
import { availableStyle } from './bold-add-agent.ts'
import { AddedView } from './BoldAddAgentAdded.tsx'
import { Appearance } from './BoldAddAgentAppearance.tsx'
import { ImportProfilePanel } from './BoldAddAgentImportPanel.tsx'
import { NewAgentPanel } from './BoldAddAgentNewPanel.tsx'
import { fromLabels, type AddedAgent, type From } from './bold-add-agent-types.ts'
import './bold-add-agent.css'

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

/**
 * The bold Team page's Add agent action (PLAN 11.8c). The button and `?add=agent` open one dialog over the same Team
 * route, so closing it keeps the person on the team and an address can be shared before the dialog opens.
 */
export function BoldAddAgent({ agents, phone }: { agents: AgentSummary[]; phone: boolean }) {
  const [params, setParams] = useSearchParams()
  const trigger = useRef<HTMLButtonElement>(null)
  const open = params.get('add') === 'agent'
  const openDialog = () => {
    const next = new URLSearchParams(params)
    next.set('add', 'agent')
    setParams(next, { replace: true })
  }
  const close = () => {
    const next = new URLSearchParams(params)
    next.delete('add')
    setParams(next, { replace: true })
    requestAnimationFrame(() => trigger.current?.focus())
  }
  return (
    <>
      <button ref={trigger} type="button" className="btn primary" onClick={openDialog}>
        {phone ? 'Add' : 'Add an agent'}
      </button>
      {open && <BoldAddAgentDialog agents={agents} close={close} />}
    </>
  )
}

function BoldAddAgentDialog({ agents, close }: { agents: AgentSummary[]; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [from, setFrom] = useState<From>('new')
  const [busy, setBusy] = useState(false)
  const [askingClose, setAskingClose] = useState(false)
  const [added, setAdded] = useState<AddedAgent | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const setWorking = useCallback((working: boolean) => {
    setBusy(working)
    if (!working) setAskingClose(false)
  }, [])
  const another = () => {
    setAdded(null)
    setWorking(false)
    setFrom('new')
  }
  const requestClose = () => {
    if (busy) setAskingClose(true)
    else close()
  }
  const onAdded = (agent: AddedAgent) => {
    setWorking(false)
    setAdded(agent)
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="bold-add-dialog"
      aria-label="Add an agent"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) close()
      }}
    >
      {added ? (
        <AddedView added={added} close={close} {...(added.another ? { another } : {})} />
      ) : (
        <>
          <header className="bold-add-head">
            <h2>Add an agent</h2>
            <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close">
              <CloseIcon />
            </button>
          </header>
          {askingClose && (
            <div
              className="bold-add-confirm"
              role="alertdialog"
              aria-labelledby="bold-add-confirm-title"
              aria-describedby="bold-add-confirm-note"
              data-protected="block"
            >
              <b id="bold-add-confirm-title">Close while it’s still running?</b>
              <span id="bold-add-confirm-note" className="small muted">
                Score is still working. An upload is discarded; setup already started keeps going in
                the background.
              </span>
              <div className="bold-add-confirm-actions">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setAskingClose(false)}
                  autoFocus
                >
                  Keep waiting
                </button>
                <button type="button" className="btn sm primary" onClick={close}>
                  Close anyway
                </button>
              </div>
            </div>
          )}
          <div className="bold-add-from" role="radiogroup" aria-label="Start from">
            {fromLabels.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={from === choice.value}
                className={from === choice.value ? 'on' : undefined}
                disabled={busy}
                onClick={() => setFrom(choice.value)}
              >
                <b>{choice.label}</b>
              </button>
            ))}
          </div>
          {from === 'new' && (
            <NewAgentPanel
              agents={agents}
              close={requestClose}
              onAdded={onAdded}
              onBusy={setWorking}
            />
          )}
          {from === 'import' && (
            <ImportProfilePanel
              agents={agents}
              close={requestClose}
              onAdded={onAdded}
              onBusy={setWorking}
            />
          )}
          {from === 'coding' && (
            <CodingAgentPanel
              agents={agents}
              close={requestClose}
              onAdded={onAdded}
              onBusy={setWorking}
            />
          )}
        </>
      )}
    </dialog>
  )
}

function CodingAgentPanel({
  agents,
  close,
  onAdded,
  onBusy,
}: {
  agents: AgentSummary[]
  close: () => void
  onAdded: (agent: AddedAgent) => void
  onBusy: (busy: boolean) => void
}) {
  const [initial] = useState(() => availableStyle(agents))
  const draft = useCodingAgentDraft(
    (agent, detail) =>
      onAdded({
        id: agent.id,
        name: agent.name,
        style: agent.style,
        detail,
        another: false,
      }),
    initial,
  )
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
  useEffect(() => {
    onBusy(create.isPending)
  }, [create.isPending, onBusy])
  const blocked = Boolean(
    create.isPending ||
    !usable ||
    !id ||
    (needsAck && !acknowledged) ||
    unverified.includes(permission),
  )
  const group = useId()
  return (
    <form
      className="bold-add-form"
      data-decision
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) create.mutate()
      }}
    >
      <div className="bold-add-tool">
        <span className="lab">Which tool</span>
        <div className="bold-add-tools" role="radiogroup" aria-label="Which tool">
          {(runtimes.data ?? []).map((item) => (
            <label key={item.runtime} className={runtime === item.runtime ? 'on' : undefined}>
              <input
                type="radio"
                name={`${group}-tool`}
                value={item.runtime}
                checked={runtime === item.runtime}
                onChange={() => chooseRuntime(item.runtime)}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
        {!runtimes.data && <p className="small muted">Checking installed coding tools…</p>}
        {info && (
          <div className="bold-add-tool-state">
            <p className="coding-add-context" data-protected="block">
              {info.state === 'ready'
                ? `Installed · version ${info.version ?? 'unknown'} · tested by Score for ${info.testedVersions.join(', ')}. ${info.quota}`
                : info.state === 'untested_version'
                  ? `Installed · version ${info.version ?? 'unknown'}, newer than the versions Score was tested with. It runs unless Score's check finds a problem. ${info.quota}`
                  : (info.message ?? 'This coding tool is not ready.')}
            </p>
            {info.warning && (
              <p role="note" className="coding-add-context" data-protected="block">
                {info.warning}
              </p>
            )}
            {usable && <RuntimeQuotaLine runtime={runtime} />}
            <button
              type="button"
              className="link"
              disabled={runtimes.isFetching}
              onClick={() => void runtimes.refetch()}
            >
              {runtimes.isFetching ? 'Checking…' : 'Check version again'}
            </button>
          </div>
        )}
      </div>
      <div className="bold-add-main">
        <Appearance agents={agents} name={id} value={style} onChange={setStyle} />
        <div className="bold-add-fields">
          <label>
            <span className="lab">Name</span>
            <input
              className="field bold-add-name"
              autoFocus
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
            <span className="lab">What does it do?</span>
            <textarea
              className="field"
              maxLength={2000}
              rows={3}
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
          </label>
          <label>
            <span className="lab">Workspace folder (optional)</span>
            <input
              className="field"
              placeholder="~/score-workspaces/<name>"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
            />
          </label>
          <p className="small muted">Runs on this machine as you.</p>
          <CodingModelPicker key={runtime} runtime={runtime} value={model} onChange={setModel} />
          <PermissionPicker
            value={permission}
            onChange={setPermission}
            name="bold-coding-permission"
            runtime={runtime}
            unverified={unverified}
          />
          {needsAck && (
            <label className="check coding-acknowledge" data-protected="any">
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
              <span className="lab">Security password</span>
              <input
                className="field"
                type="password"
                required
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}
          <ReadAccessWarning runtime={runtime} permission={permission} />
          {create.error && <p role="alert">{create.error.message}</p>}
        </div>
      </div>
      <footer className="bold-add-footer">
        <span className="small muted">
          It joins the team room and uses your own login and plan. You can change everything later.
        </span>
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary coding-add-commit"
          data-protected="inline-flex"
          disabled={blocked}
        >
          {create.isPending ? 'Adding…' : 'Add coding agent'}
        </button>
      </footer>
    </form>
  )
}
