import { useState } from 'react'

// Score never runs an interactive sign-in or handles a credential: it shows the command instead.
export function TerminalCommand({ command, onClose }: { command: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="settings-command" role="group" aria-label="Run in a terminal">
      <p>Run this in a terminal. Score never asks for your keys or sign-in details.</p>
      <code>{command}</code>
      <div className="settings-command-actions">
        <button type="button" className="settings-pill" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy command'}
        </button>
        <button type="button" className="settings-link" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

export function failure(error: unknown, action: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'not_paired')
    return `Pair this browser using the link in the server terminal to ${action}.`
  if (code === 'conflict') return 'That name is already in use.'
  return `Could not ${action}. Please try again.`
}
