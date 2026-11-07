import type { Trigger } from '@score/contract'
import { copyText } from '../../data/clipboard.ts'
import { when } from './wizard-model.ts'

export function TriggerCard({
  trigger,
  busy,
  teamName,
  onEdit,
  onReveal,
  onRotate,
  onDelete,
}: {
  trigger: Trigger
  busy: boolean
  /** Set only when several team rooms exist and this trigger starts jobs somewhere but the first. */
  teamName: string | null
  onEdit: () => void
  onReveal: () => void
  onRotate: () => void
  onDelete: () => void
}) {
  return (
    <article className="card bold-trigger-card" data-protected="flex" data-trigger-id={trigger.id}>
      <div className="row wrap">
        <b>{trigger.name}</b>
        <span className="small muted">
          {trigger.app} · reference <code>{trigger.mapping.ref}</code> · last call{' '}
          {when(trigger.lastCalledAt)}
          {trigger.lastCalledAt ? '' : ` · created ${when(trigger.createdAt)}`}
        </span>
        <button type="button" className="link bold-trigger-push" onClick={onEdit} disabled={busy}>
          Edit
        </button>
      </div>
      {trigger.url ? (
        <div className="row wrap">
          <code className="small grow bold-trigger-url">{trigger.url}</code>
          <button
            type="button"
            className="btn sm"
            aria-label={`Copy address for ${trigger.name}`}
            onClick={() => void copyText(trigger.url!)}
          >
            Copy address
          </button>
        </div>
      ) : (
        <span className="small muted">
          Score is reachable only on this machine, so an outside app can’t call this address yet.
          Use an HTTPS tunnel or remote mode; the address appears here when it is reachable.
        </span>
      )}
      <div className="row wrap">
        <button type="button" className="btn sm" onClick={onReveal} disabled={busy}>
          Show secret again
        </button>
        <button type="button" className="btn sm" onClick={onRotate} disabled={busy}>
          Rotate secret
        </button>
        <button
          type="button"
          className="btn sm bold-trigger-danger"
          onClick={onDelete}
          disabled={busy}
        >
          Delete
        </button>
        <span className="small muted bold-trigger-push">
          {teamName ? `Starts jobs in ${teamName}. ` : ''}
          {trigger.reportBack.mode === 'off'
            ? 'Results stay in Score.'
            : `Reports back with ${trigger.reportBack.tool}.`}
        </span>
      </div>
      {trigger.warning && (
        <span className="small" role="note" data-protected="flex">
          {trigger.warning}
        </span>
      )}
      <span className="small muted">
        Calls must be signed with the secret (Standard Webhooks headers) and arrive within five
        minutes.
      </span>
    </article>
  )
}
