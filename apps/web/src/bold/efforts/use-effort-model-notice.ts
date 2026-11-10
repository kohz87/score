import type { AgentSummary } from '@score/contract'
import { useEffect, useRef } from 'react'
import { agentDisplayName } from '../bold-agents.ts'
import type { EffortSay } from './effort-command.ts'
import { useRoomEfforts } from './effort-queries.ts'

/**
 * Says in the chat when Score put an agent back on its own effort because its model no longer takes the level
 * (`effort.changed` with `reason: model`). Only a change that arrives while the chat is open is said: the one already
 * in the snapshot when it mounts was said before.
 */
export function useEffortModelNotice(roomId: string, agents: AgentSummary[], say: EffortSay) {
  const notice = useRoomEfforts(roomId).notice
  const seen = useRef<number | null>(notice?.seq ?? null)
  useEffect(() => {
    if (!notice || seen.current === notice.seq) return
    seen.current = notice.seq
    const agent = agents.find((item) => item.id === notice.agentId)
    const name = agent ? agentDisplayName(agent) : notice.agentId
    say(
      `${name} went back to its own effort in this chat, because its model no longer takes the level it had.`,
    )
    // Only a new change matters: `say` and `agents` change on every render of the chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice?.seq])
}
