import type { AgentDetail } from '@score/contract'
import { useChannels } from '../../routes/team/agent-tab-queries.ts'
import { ChannelsCard } from '../agent-more/ChannelsCard.tsx'
import { OpenCard, useOpenState } from './OpenCard.tsx'
import { channelLine } from './tool-lines.ts'

/** Reachable on (mock-up 26): one line of channels; Manage channels opens today's Channels card in place. */
export function ChannelsLine({ agent, initialOpen }: { agent: AgentDetail; initialOpen: boolean }) {
  const channels = useChannels(agent.id)
  const [open, setOpen] = useOpenState(initialOpen)
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title="Reachable on"
      summary={
        channels.isPending
          ? 'Loading channels…'
          : channels.isError
            ? 'Couldn’t load channels.'
            : channelLine(channels.data ?? [])
      }
      openLabel="Manage channels"
      openName="Manage channels"
    >
      <ChannelsCard agent={agent} />
    </OpenCard>
  )
}
