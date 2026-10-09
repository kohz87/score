import { useState } from 'react'
import { MessagingSetup } from '../settings/MessagingSetup.tsx'
import { useChannels } from './agent-tab-queries.ts'

// Tokens are saved through the server into this agent's Hermes profile; interactive pairings still show a terminal command.
export function ChannelsTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const channels = useChannels(agentId)
  const [open, setOpen] = useState<string | null>(null)
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
                <MessagingSetup
                  platform={row.platform}
                  label={row.label}
                  agentId={agentId}
                  terminalCommand={row.connectCommand}
                  onSaved={() => void channels.refetch()}
                  onClose={() => {
                    setOpen(null)
                    void channels.refetch()
                  }}
                />
              )}
            </div>
            {row.status !== 'connected' && open !== row.platform && (
              <div className="team-routine-actions">
                <button
                  type="button"
                  aria-label={`Connect ${row.label}`}
                  onClick={() => setOpen(row.platform)}
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
