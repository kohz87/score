import type { AgentDetail } from '@score/contract'
import { useMcpAccess } from '../../routes/team/mcp-access-queries.ts'
import { ScoreAccessCard } from '../agent-more/ScoreAccessCard.tsx'
import { OpenCard, useOpenState } from './OpenCard.tsx'
import { accessLine } from './tool-lines.ts'

/**
 * Score access (mock-up 26): one line, "Off" / "Read only" / "Read and write", with Turn on or Manage. The card
 * opens in place; it asks the person to decide, so the line is protected too.
 */
export function ScoreAccessLine({
  agent,
  initialOpen,
}: {
  agent: AgentDetail
  initialOpen: boolean
}) {
  const access = useMcpAccess(agent.id)
  const [open, setOpen] = useOpenState(initialOpen)
  const data = access.data
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title="Score access"
      protectedKind="flex"
      summary={
        data
          ? accessLine(data)
          : access.isError
            ? 'Couldn’t load Score access.'
            : 'Loading Score access…'
      }
      openLabel={data && !data.enabled ? 'Turn on' : 'Manage'}
      openName={data && !data.enabled ? 'Turn on Score access' : 'Manage Score access'}
    >
      <ScoreAccessCard agent={agent} />
    </OpenCard>
  )
}
