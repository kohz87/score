import type { AgentSummary } from '@score/contract'
import { useMediaQuery } from '../../data/use-media.ts'
import { PHONE } from '../bold-shell-model.ts'
import { EffortChoice, EffortTag } from './EffortControl.tsx'
import { chatEffortOf, useRoomEfforts } from './effort-queries.ts'
import { useRunEffort } from './use-run-effort.ts'

/**
 * Chat info › Members: one agent's effort tag in a group chat. An agent on its own has none, except on a phone, where
 * "Its own" is a 44px button to set one for this chat (mock-up 25-effort-phone).
 */
export function MemberEffortTag({ roomId, agent }: { roomId: string; agent: AgentSummary }) {
  const current = chatEffortOf(useRoomEfforts(roomId).items, agent.id)
  const phone = useMediaQuery(PHONE)
  const runEffort = useRunEffort(roomId, 'group')
  if (current !== null) return <EffortTag agent={agent} current={current} runEffort={runEffort} />
  if (!phone) return null
  return (
    <EffortChoice
      agent={agent}
      current={null}
      runEffort={runEffort}
      showWhenOwn
      placement="down"
      className="bold-effort-tag bold-effort-tag--own"
      label={`${agent.name}’s effort: its own. Set for this chat`}
    >
      Its own
    </EffortChoice>
  )
}
