import { useEffect, useRef, useState } from 'react'
import { McpReloadResultSchema } from '@score/contract'
import { apiFetch, ApiError } from '../data/api.ts'

/**
 * 3.7.9 (decision 140): restarts the lead's gateway so its Hermes lists Score's MCP tools again. Asks first: a named
 * profile restarts alone; `default` restarts the gateway every agent runs in. Score refuses while it sees work there.
 */
export function ReloadMcp({
  agentId,
  agentName,
  onReloaded,
}: {
  agentId: string
  agentName: string
  /** Called right away and again while Hermes reconnects (it lists the tools a few seconds after the restart). */
  onReloaded: () => void
}) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), [])
  const shared = agentId === 'default'

  async function reload() {
    setState('busy')
    setError(null)
    try {
      McpReloadResultSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/mcp/reload`, {
          method: 'POST',
        }),
      )
      setState('done')
      onReloaded()
      for (const ms of [2_000, 5_000, 10_000])
        timers.current.push(window.setTimeout(onReloaded, ms))
    } catch (caught) {
      setState('idle')
      setError(caught instanceof ApiError ? caught.message : 'The reload didn’t go through.')
    }
  }

  if (state === 'done')
    return (
      <span className="small muted" role="status">
        Reloaded. Checking again…
      </span>
    )
  return (
    <span className="bold-reload-mcp">
      {state === 'confirm' ? (
        <>
          <span className="small">
            {shared
              ? 'This restarts the Hermes gateway every agent runs in. Their chats on other apps reconnect once.'
              : `This restarts ${agentName}’s Hermes. Its chats on other apps reconnect once.`}
          </span>
          <button type="button" className="btn sm" onClick={() => void reload()}>
            Restart and reload
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setState('idle')}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn sm"
          disabled={state === 'busy'}
          onClick={() => setState('confirm')}
        >
          {state === 'busy' ? 'Reloading…' : 'Reload MCP'}
        </button>
      )}
      {error && (
        <span className="small start-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
