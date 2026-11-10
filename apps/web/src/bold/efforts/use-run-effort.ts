import type { AgentSummary } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { sayInChat } from './chat-notes.ts'
import { runEffortCommand } from './effort-command.ts'

/** Runs `/effort <args>` for an agent in a chat from a control (the same command the composer runs). */
export function useRunEffort(roomId: string, roomKind: 'direct' | 'group') {
  const queryClient = useQueryClient()
  return (agent: AgentSummary, args: string) =>
    runEffortCommand({
      roomId,
      roomKind,
      agent,
      args,
      queryClient,
      say: (text, action) => sayInChat(roomId, text, action),
    })
}
