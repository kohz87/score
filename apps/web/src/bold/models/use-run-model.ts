import type { AgentSummary } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { sayInChat } from '../efforts/chat-notes.ts'
import { runModelCommand } from './model-command.ts'

/** Runs `/model <args>` for an agent in a chat from a control (the same command the composer runs). */
export function useRunModel(roomId: string, roomKind: 'direct' | 'group') {
  const queryClient = useQueryClient()
  return (agent: AgentSummary, args: string, provider?: string) =>
    runModelCommand({
      roomId,
      roomKind,
      agent,
      args,
      provider,
      queryClient,
      say: (text, action) => sayInChat(roomId, text, action),
    })
}
