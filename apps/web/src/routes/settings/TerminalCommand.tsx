import { useRef, useState } from 'react'
import { copyText, selectText } from '../../data/clipboard.ts'

// The fallback for every sign-in: the person runs the command themselves, on the machine that runs Hermes.
export function TerminalCommand({ command, onClose }: { command: string; onClose: () => void }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const code = useRef<HTMLElement>(null)
  async function copy() {
    if (await copyText(command)) setState('copied')
    else {
      selectText(code.current)
      setState('manual')
    }
  }
  return (
    <div className="settings-command" role="group" aria-label="Run in a terminal">
      <p>Run this in a terminal on the machine that runs Hermes.</p>
      <code ref={code} className="settings-command-text" onClick={() => selectText(code.current)}>
        {command}
      </code>
      <div className="settings-command-actions">
        <button type="button" className="settings-pill" onClick={() => void copy()}>
          {state === 'copied' ? 'Copied' : 'Copy command'}
        </button>
        <button type="button" className="settings-link" onClick={onClose}>
          Done
        </button>
      </div>
      {state === 'manual' && (
        <p role="status">The command is selected: press Ctrl+C (or ⌘C) to copy it.</p>
      )}
    </div>
  )
}

export function failure(error: unknown, action: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'not_paired')
    return `Pair this browser using the link in the server terminal to ${action}.`
  if (code === 'conflict') return 'That name is already in use.'
  return `Couldn’t ${action}. Try again.`
}
