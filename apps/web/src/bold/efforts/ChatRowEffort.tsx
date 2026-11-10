import { ChatTagText } from '../models/ChatTagText.tsx'
import { isAmberChat } from '../models/model-model.ts'
import { chatModelOf, useRoomModels } from '../models/model-queries.ts'
import { chatEffortOf, useRoomEfforts } from './effort-queries.ts'

/** The chat list's small "model · effort" tag beside a one-to-one's name, when this chat sets either. */
export function ChatRowEffort({ roomId, agentId }: { roomId: string; agentId: string }) {
  const current = chatEffortOf(useRoomEfforts(roomId).items, agentId)
  const model = chatModelOf(useRoomModels(roomId).items, agentId)
  if (current === null && model === null) return null
  return (
    <span
      className={`bold-effort-level bold-chat-effort${isAmberChat(model, current) ? ' bold-effort--max' : ''}`}
    >
      <ChatTagText model={model} effort={current} />
    </span>
  )
}
