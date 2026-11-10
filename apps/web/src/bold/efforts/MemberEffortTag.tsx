import type { AgentSummary } from '@score/contract'
import { useMediaQuery } from '../../data/use-media.ts'
import { PHONE } from '../bold-shell-model.ts'
import { EffortChoice, EffortTag } from './EffortControl.tsx'
import { chatEffortOf, useRoomEfforts } from './effort-queries.ts'
import { useRunEffort } from './use-run-effort.ts'
import { ChatTagText } from '../models/ChatTagText.tsx'
import { chatTagLabel } from '../models/model-model.ts'
import { chatModelOf, useRoomModels } from '../models/model-queries.ts'
import { useRunModel } from '../models/use-run-model.ts'
import { agentDisplayName } from '../bold-agents.ts'

/**
 * Chat info › Members: one agent's "model · effort" tag in a group chat. An agent on its own has none, except on a phone,
 * where "its own" is a 44px button to set one for this chat (mock-up 25-effort-phone, 27-model-main).
 */
export function MemberEffortTag({ roomId, agent }: { roomId: string; agent: AgentSummary }) {
  const current = chatEffortOf(useRoomEfforts(roomId).items, agent.id)
  const phone = useMediaQuery(PHONE)
  const runEffort = useRunEffort(roomId, 'group')
  const model = chatModelOf(useRoomModels(roomId).items, agent.id)
  const runModel = useRunModel(roomId, 'group')
  if (current !== null || model !== null)
    return (
      <EffortTag
        agent={agent}
        model={model}
        current={current}
        runEffort={runEffort}
        runModel={runModel}
      />
    )
  if (!phone) return null
  return (
    <EffortChoice
      agent={agent}
      model={null}
      current={null}
      runEffort={runEffort}
      runModel={runModel}
      showWhenOwn
      placement="down"
      className="bold-effort-tag bold-effort-tag--own"
      label={chatTagLabel(agentDisplayName(agent), null, null)}
    >
      <ChatTagText model={null} effort={null} />
    </EffortChoice>
  )
}
