import type { AgentStatus } from '@score/contract'
import type { AgentActivity } from './AgentGlyph.tsx'

/** The mood an agent's glyph shows for its live status: only a run in progress or a wait on a human moves it. */
export function activityOfStatus(status: AgentStatus | undefined): AgentActivity {
  if (status === 'working') return 'working'
  if (status === 'waiting') return 'needs'
  return 'idle'
}

/** The same for a Flow node (its state is the step's, not the agent's). */
export function activityOfNodeState(
  state: 'done' | 'working' | 'needs_you' | 'planned' | 'failed',
): AgentActivity {
  if (state === 'working') return 'working'
  if (state === 'needs_you') return 'needs'
  return 'idle'
}
