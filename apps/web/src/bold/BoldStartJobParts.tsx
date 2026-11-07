import { ORCH_ACKNOWLEDGEMENT_TEXT } from '@score/contract'
import type { ReactNode, RefObject } from 'react'
import { copyText } from '../data/clipboard.ts'
import { passkeysSupportedHere, signInWithPasskey } from '../data/passkeys.ts'
import { scheduleLabel, type StartCheck } from './bold-start-job.ts'
import type { Result } from './start-job-types.ts'
import type { StartJobView } from './use-start-job-view.ts'

export function ChecklistRows({ checks, reload }: { checks: StartCheck[]; reload?: ReactNode }) {
  return (
    <ul>
      {checks.map((check) => (
        <li key={check.key} className="row small">
          <span
            className={`dot start-dot start-dot--${check.status}`}
            style={{
              background:
                check.status === 'ok'
                  ? 'var(--ok)'
                  : check.status === 'fail'
                    ? 'var(--bad)'
                    : 'var(--warn)',
            }}
            aria-hidden="true"
          />
          <span className="grow">
            {check.text}
            {check.reload && reload && <span className="start-check-action">{reload}</span>}
          </span>
          <span className="sr">
            {check.status === 'ok'
              ? 'Passed'
              : check.status === 'fail'
                ? 'Blocks starting'
                : 'Checking'}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ChecklistContent({ view }: { view: StartJobView }) {
  return (
    <>
      {view.workersAtStake.length > 0 && (
        <div className="start-reach" data-protected="block">
          <b className="small">Coding agents in this job</b>
          {view.workersAtStake.map((worker) => (
            <span key={worker.agentId} className="small muted">
              {worker.agentId}: {worker.reach ?? worker.detail ?? worker.readiness}
            </span>
          ))}
          {view.reachAtStake.length > 0 && (
            <label className="check small">
              <input
                type="checkbox"
                checked={view.reachAccepted}
                onChange={(event) => {
                  view.setReachAcceptedKey(event.target.checked ? view.reachKey : null)
                  view.touch()
                }}
              />
              I understand what these coding agents can read, and I accept it for this job.
            </label>
          )}
        </div>
      )}
      <label className="check small start-ack">
        <input
          type="checkbox"
          checked={view.ack}
          onChange={(event) => {
            view.setAck(event.target.checked)
            view.touch()
          }}
        />
        {ORCH_ACKNOWLEDGEMENT_TEXT}
      </label>
    </>
  )
}

export function StartJobScheduled({ view }: { view: StartJobView }) {
  if (view.scheduled.length === 0) return null
  return (
    <section className="inner start-scheduled" aria-label="Scheduled">
      <span className="lab">Scheduled</span>
      <ul>
        {view.scheduled.map((item) => (
          <li key={item.id} className="row small">
            <span className="grow">{item.title}</span>
            <span className="muted">
              {item.agentId} · {scheduleLabel(item.schedule)}
              {item.enabled ? '' : ' · paused'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AuthFields({
  view,
  inputRef,
}: {
  view: StartJobView
  inputRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <>
      <span className="lab">Confirm it’s you</span>
      <span className="small muted">
        The check runs a command on the Score machine as its user. Confirm your security password or
        passkey to start the job.
      </span>
      <label className="start-field">
        <span>Security password</span>
        <input
          className="field"
          type="password"
          ref={inputRef}
          autoComplete="current-password"
          value={view.authPassword}
          onChange={(event) => view.setAuthPassword(event.target.value)}
        />
      </label>
      <div className="row wrap">
        <button
          type="submit"
          className="btn primary"
          disabled={view.authBusy || view.authPassword.length < 8}
        >
          Confirm and start
        </button>
        {passkeysSupportedHere() && (
          <button
            type="button"
            className="btn"
            disabled={view.authBusy}
            onClick={() => void view.confirmThenStart(() => signInWithPasskey())}
          >
            Use a passkey
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            view.setAuthNeeded(false)
            view.setAuthPassword('')
          }}
        >
          Not now
        </button>
      </div>
      {view.authError && (
        <p className="start-error" role="alert">
          {view.authError}
        </p>
      )}
    </>
  )
}

export function StartJobActions({ view }: { view: StartJobView }) {
  return (
    <div className="row wrap start-actions">
      {view.showSaveRecipe && (
        <div className="start-save-recipe">
          <label className="check small">
            <input
              type="checkbox"
              checked={view.saveRecipe}
              onChange={(event) => {
                view.setSaveRecipe(event.target.checked)
                view.touch()
              }}
            />
            Save as a recipe
          </label>
          {view.saveRecipe && view.savedRecipes.some((item) => item.name === view.saveName) && (
            <span className="small muted" role="status">
              A recipe called “{view.saveName}” already exists; saving adds another.
            </span>
          )}
        </div>
      )}
      <button type="button" className="btn ghost start-cancel" onClick={view.onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="btn primary start-go"
        disabled={!view.canStart}
        onClick={() => void view.start()}
      >
        {view.busy ? 'Starting…' : 'Start the job'}
      </button>
    </div>
  )
}

export function CloseConfirm({
  secret,
  onKeep,
  onClose,
}: {
  secret: boolean
  onKeep: () => void
  onClose: () => void
}) {
  return (
    <div
      className="inner start-confirm"
      role="alertdialog"
      aria-label={secret ? 'Close without saving the secret?' : 'Discard this job?'}
      data-protected="block"
    >
      <b>{secret ? 'The secret is shown only once.' : 'Discard this job?'}</b>
      <span className="small muted">
        {secret
          ? 'Close without copying it? You can show it again from Settings › Tools and triggers.'
          : 'Nothing has been started yet.'}
      </span>
      <div className="row wrap">
        <button type="button" className="btn ghost" onClick={onKeep}>
          {secret ? 'Keep the secret open' : 'Keep editing'}
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          {secret ? 'Close anyway' : 'Discard'}
        </button>
      </div>
    </div>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button type="button" className="btn sm" onClick={() => void copyText(text)}>
      {label}
    </button>
  )
}

export function StartJobResult({
  result,
  saveWarning,
  onClose,
}: {
  result: Exclude<Result, { kind: 'trigger' }>
  saveWarning: string | null
  onClose: () => void
}) {
  const detail =
    result.kind === 'job'
      ? result.orchestrationId
        ? 'The lead is planning it in an orchestration.'
        : 'It is waiting in the team room for you.'
      : result.kind === 'workflow'
        ? 'The recipe is running in its own room.'
        : `It repeats ${result.schedule.toLowerCase()}.`
  return (
    <div className="start-result">
      <h3>{result.kind === 'routine' ? 'Scheduled' : 'Started'}</h3>
      <p>
        <b>{result.title}</b>
      </p>
      <p className="muted">{detail}</p>
      {saveWarning && (
        <p className="small muted" role="status">
          {saveWarning}
        </p>
      )}
      <div className="row wrap start-actions">
        <button type="button" className="btn primary start-cancel" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
