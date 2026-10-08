import { useState } from 'react'
import { TerminalCommand } from '../settings/TerminalCommand.tsx'
import { useChannels } from './agent-tab-queries.ts'

// Score never runs an interactive login or handles a bot token: it shows the command for the person to run.
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
                <TerminalCommand
                  command={row.connectCommand}
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
