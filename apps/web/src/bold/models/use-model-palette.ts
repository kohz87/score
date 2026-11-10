import type { AgentSummary } from '@score/contract'
import { agentDisplayName } from '../bold-agents.ts'
import type { SlashCommand } from '../../routes/chat/composer-model.ts'
import { modelMenuItems } from './model-menu.ts'
import { useModelChoices } from './use-model-choices.ts'

/**
 * The `/model` palette rows for the agent a message goes to, narrowed by what follows `/model `. Reads only while the
 * composer shows the palette (`query` is null otherwise). A hook, so the composer calls it on every render.
 */
export function useModelPalette(
  agents: AgentSummary[],
  agentId: string | null,
  query: string | null,
): SlashCommand[] {
  const agent = agents.find((item) => item.id === agentId)
  const choices = useModelChoices(agent, agent ? query : null)
  return agent && query !== null ? modelMenuItems(choices, agentDisplayName(agent)) : []
}
