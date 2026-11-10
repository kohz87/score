import { chatEffortOf, useRoomEfforts } from './effort-queries.ts'

/** The chat list's small level tag beside a one-to-one's name, when this chat sets one. */
export function ChatRowEffort({ roomId, agentId }: { roomId: string; agentId: string }) {
  const current = chatEffortOf(useRoomEfforts(roomId).items, agentId)
  if (current === null) return null
  return <span className="bold-effort-level bold-chat-effort">{current}</span>
}
