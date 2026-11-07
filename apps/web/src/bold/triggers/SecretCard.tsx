import { useState } from 'react'
import { copyText } from '../../data/clipboard.ts'
import type { Secret } from './wizard-model.ts'

export function SecretCard({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <section
      className="card bold-trigger-secret"
      data-protected="flex"
      aria-label={`Secret for ${secret.name}`}
    >
      <div className="row wrap">
        <h3>Signing secret</h3>
        <button type="button" className="link" onClick={onClose}>
          Close secret
        </button>
      </div>
      <span className="small muted">
        Copy it before closing this card. Write it where the app keeps credentials, never in a
        command or a message.
      </span>
      <code className="bold-trigger-secret-value" data-trigger-secret>
        {secret.value}
      </code>
      <div className="row wrap">
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            if (await copyText(secret.value)) setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy secret'}
        </button>
      </div>
    </section>
  )
}
