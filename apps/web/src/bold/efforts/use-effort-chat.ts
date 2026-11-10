import type { AgentSummary } from '@score/contract'
import type { EffortSay } from './effort-command.ts'
import { useChatNotes } from './chat-notes.ts'
import { useEffortModelNotice } from './use-effort-model-notice.ts'
import { useRunEffort } from './use-run-effort.ts'

/**
 * What an open chat needs for effort (decision 178): the notes that come from its controls and from Score's own
 * `reason: model` change, and the runner its controls use. Returns the runner.
 */
export function useEffortChat(
  roomId: string,
  roomKind: 'direct' | 'group',
  agents: AgentSummary[],
  say: EffortSay,
) {
  useEffortModelNotice(roomId, agents, say)
  useChatNotes(roomId, say)
  return useRunEffort(roomId, roomKind)
}
