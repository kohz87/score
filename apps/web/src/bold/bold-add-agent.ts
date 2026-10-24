import type { AgentStyle, AgentSummary } from '@score/contract'
import { apiFetch } from '../data/api.ts'

/** The prototype's four open colours; the colours already on the team are listed after them and faded. */
export const addAgentPalette = ['#6b8cff', '#2bb3c0', '#ff8a3d', '#8bd450'] as const

export type ColourChoice = { colour: string; takenBy: string | null }

export function colourChoices(agents: AgentSummary[]): ColourChoice[] {
  const byColour = new Map<string, string>()
  for (const agent of agents) {
    if (agent.lifecycle?.state === 'removed') continue
    const colour = agent.style.color.toLowerCase()
    if (!byColour.has(colour)) byColour.set(colour, agent.name)
  }
  const colours = addAgentPalette.map((colour) => colour.toLowerCase())
  for (const colour of byColour.keys()) if (!colours.includes(colour)) colours.push(colour)
  return colours.map((colour) => ({ colour, takenBy: byColour.get(colour) ?? null }))
}

/** A first mark that does not collide with a visible agent; the person can still choose any free colour. */
export function availableStyle(agents: AgentSummary[]): AgentStyle {
  const firstFree = colourChoices(agents).find((choice) => choice.takenBy === null)
  return { color: firstFree?.colour ?? addAgentPalette[0], shape: 'hexagon' }
}

export type WorksOnChoice =
  | { backend: 'local' }
  | { backend: 'docker'; image?: string; network?: boolean }
  | { backend: 'ssh'; host: string; user: string; port?: number; keyPath?: string }

/**
 * The Runs on write from contract § Where an agent runs (PLAN 11.8a). It is sent only after profile setup has finished,
 * and only when the person chose something other than this machine: Score never rewrites the default needlessly.
 */
export async function saveRunsOn(agentId: string, choice: WorksOnChoice): Promise<void> {
  await apiFetch(`agents/${encodeURIComponent(agentId)}/runs-on`, {
    method: 'PUT',
    body: JSON.stringify(choice),
  })
}
