import { useState } from 'react'
import { useChannels } from './agent-tab-queries.ts'

// Score never runs an interactive login or handles a bot token: it shows the command for the person to run.
export function ChannelsTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const channels = useChannels(agentId)
  const [open, setOpen] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className="team-card" aria-labelledby="team-channels-heading">
      <h2 id="team-channels-heading">Channels</h2>
      <p className="team-muted-strong">Where {agentName} can be reached outside Score.</p>
      {channels.isPending && <p role="status">Loading channels…</p>}
      {channels.isError && (
        <p role="alert">
          Could not load channels.{' '}
          <button onClick={() => void channels.refetch()}>Try again</button>
        </p>
      )}
      <ul className="team-routine-list">
        {channels.data?.map((row) => (
          <li className="team-routine-row team-routine" key={row.platform}>
            <div className="team-routine-body">
              <p>
                <strong>{row.label}</strong>{' '}
                <span className="team-channel-state" data-status={row.status}>
                  {row.status === 'connected' ? 'Connected' : 'Not connected'}
                </span>
              </p>
              {row.status !== 'connected' && row.detail && (
                <p className="team-muted">{row.detail.replace(/_/g, ' ')}</p>
              )}
              {open === row.platform && (
                <div role="group" aria-label={`Connect ${row.label}`} className="team-command">
                  <p>Run this in a terminal. Score never asks for your keys or sign-in details.</p>
                  <code>{row.connectCommand}</code>
                  <div className="team-routine-actions">
                    <button type="button" onClick={() => void copy(row.connectCommand)}>
                      {copied ? 'Copied' : 'Copy command'}
                    </button>
                    <button type="button" onClick={() => setOpen(null)}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
            {row.status !== 'connected' && open !== row.platform && (
              <div className="team-routine-actions">
                <button
                  type="button"
                  aria-label={`Connect ${row.label}`}
                  onClick={() => {
                    setCopied(false)
                    setOpen(row.platform)
                  }}
                >
                  Connect
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
