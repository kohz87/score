import { copyText } from '../../data/clipboard.ts'
import { SecretCard } from './SecretCard.tsx'
import type { Secret, Wizard } from './wizard-model.ts'

export function WizardTestStep({
  wizard,
  sample,
  url,
  secret,
  onChange,
  onClose,
  onShowSecret,
  onSecretClose,
  onRefresh,
}: {
  wizard: Wizard
  sample: unknown | null
  url: string | null
  secret: Secret | null
  onChange: (change: Partial<Wizard>) => void
  onClose: () => void
  onShowSecret: () => void
  onSecretClose: () => void
  onRefresh: () => void
}) {
  return (
    <div className="bold-trigger-test">
      <div className="bold-trigger-inner">
        <span className="small muted">
          Paste this address into {wizard.app || 'the app'}’s webhook settings.
        </span>
        {url ? (
          <div className="row wrap">
            <code className="small grow bold-trigger-url">{url}</code>
            <button
              type="button"
              className="btn sm"
              aria-label="Copy webhook address"
              onClick={() => void copyText(url)}
            >
              Copy address
            </button>
          </div>
        ) : (
          <span className="small muted">
            Score is reachable only on this machine, so an outside app can’t call it yet. Use an
            HTTPS tunnel or remote mode; the address appears here when it is reachable.
          </span>
        )}
        {secret ? (
          <SecretCard secret={secret} onClose={onSecretClose} />
        ) : (
          <button type="button" className="link" onClick={onShowSecret}>
            Show secret again
          </button>
        )}
        <span className="small muted">
          Calls must be signed with the secret (Standard Webhooks headers) and arrive within five
          minutes.
        </span>
      </div>
      <div className="card bold-trigger-wait">
        {sample === null ? (
          <>
            <span className="bold-trigger-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <b>Waiting for a test call</b>
            <span className="small muted">
              Make the app send one, e.g. create a test ticket. Score shows what arrives so you can
              pick the fields.
            </span>
            <button type="button" className="btn sm" onClick={onRefresh}>
              Check again
            </button>
          </>
        ) : (
          <>
            <b>Test call received</b>
            <span className="small muted">This is the redacted payload Score will map:</span>
            <pre className="bold-trigger-sample">{JSON.stringify(sample, null, 2)}</pre>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onSecretClose()
                onChange({ step: 3, problem: '' })
              }}
            >
              Map fields
            </button>
          </>
        )}
      </div>
      <div className="row wrap bold-trigger-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            onSecretClose()
            onChange({ step: 1, problem: '' })
          }}
        >
          Back
        </button>
        <button type="button" className="link bold-trigger-push" onClick={onClose}>
          Finish later
        </button>
      </div>
    </div>
  )
}
