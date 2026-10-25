import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { MessagingSetup } from '../../routes/settings/MessagingSetup.tsx'
import { useChannels } from '../../routes/team/agent-tab-queries.ts'
import { Fail, Loading, MoreCard, useFoldedList } from './MoreCard.tsx'

/** Connecting a channel is a form with tokens: it opens inside the card, using Score's existing setup. */
export function ChannelsCard({ agent }: { agent: AgentDetail }) {
  const channels = useChannels(agent.id)
  const [open, setOpen] = useState<string | null>(null)
  const list = useFoldedList(`channels:${agent.id}`, channels.data ?? [])
  return (
    <MoreCard id="agent-channels" title="Channels">
      <span className="small muted">Where it can be reached outside Score.</span>
      {channels.isPending && <Loading what="channels" />}
      {channels.isError && (
        <Fail>
          Couldn’t load channels.{' '}
          <button type="button" className="link" onClick={() => void channels.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {list.shown.map((row) => (
        <div className="bold-mc-channel" key={row.platform}>
          <div className="listrow wrap">
            <span className="grow small">
              <b>{row.label}</b>{' '}
              <span className="muted">
                {row.status === 'connected' ? 'Connected' : 'Not connected'}
              </span>
              {row.status !== 'connected' && row.detail && (
                <span className="muted"> · {row.detail.replace(/_/g, ' ')}</span>
              )}
            </span>
            {row.status !== 'connected' && open !== row.platform && (
              <button
                type="button"
                className="btn sm"
                aria-label={`Connect ${row.label}`}
                onClick={() => setOpen(row.platform)}
              >
                Connect
              </button>
            )}
          </div>
          {open === row.platform && (
            <MessagingSetup
              platform={row.platform}
              label={row.label}
              agentId={agent.id}
              terminalCommand={row.connectCommand}
              onSaved={() => void channels.refetch()}
              onClose={() => {
                setOpen(null)
                void channels.refetch()
              }}
            />
          )}
        </div>
      ))}
      {list.toggle}
    </MoreCard>
  )
}
