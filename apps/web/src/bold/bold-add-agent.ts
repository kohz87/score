import { RunsOnSchema, type AgentStyle, type AgentSummary, type RunsOn } from '@score/contract'
import { apiFetch } from '../data/api.ts'

/** The prototype's four open colours; the colours already on the team are listed after them and faded. */
const addAgentPalette = ['#6b8cff', '#2bb3c0', '#ff8a3d', '#8bd450'] as const

export type ColourChoice = { colour: string; takenBy: string | null }

/** A distinct colour outside the team's palette, so a full roster still has something to choose. */
function generatedColours(taken: ReadonlySet<string>, count: number): string[] {
  const colours: string[] = []
  // The golden angle spaces successive hues far apart instead of producing a run of near-identical greens.
  for (let index = 0; colours.length < count; index += 1) {
    const hue = (24 + index * 137.508) % 360
    const colour = hslToHex(hue, 0.64, index % 3 === 0 ? 0.48 : 0.6)
    if (!taken.has(colour) && !colours.includes(colour)) colours.push(colour)
  }
  return colours
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = hue / 60
  const second = chroma * (1 - Math.abs((section % 2) - 1))
  const [red, green, blue] =
    section < 1
      ? [chroma, second, 0]
      : section < 2
        ? [second, chroma, 0]
        : section < 3
          ? [0, chroma, second]
          : section < 4
            ? [0, second, chroma]
            : section < 5
              ? [second, 0, chroma]
              : [chroma, 0, second]
  const offset = lightness - chroma / 2
  return `#${[red, green, blue]
    .map((value) =>
      Math.round((value + offset) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

export function colourChoices(agents: AgentSummary[]): ColourChoice[] {
  const byColour = new Map<string, string>()
  for (const agent of agents) {
    if (agent.lifecycle?.state === 'removed') continue
    const colour = agent.style.color.toLowerCase()
    if (!byColour.has(colour)) byColour.set(colour, agent.name)
  }
  const colours = addAgentPalette.map((colour) => colour.toLowerCase())
  for (const colour of byColour.keys()) if (!colours.includes(colour)) colours.push(colour)
  // The four prototype colours can all be taken. Offer unused generated colours instead of silently reusing one.
  if (addAgentPalette.every((colour) => byColour.has(colour.toLowerCase())))
    colours.push(...generatedColours(new Set(byColour.keys()), Math.max(8, byColour.size + 1)))
  return colours.map((colour) => ({ colour, takenBy: byColour.get(colour) ?? null }))
}

/** A first mark that does not collide with a visible agent; the person can still choose any free colour. */
export function availableStyle(agents: AgentSummary[]): AgentStyle {
  const choices = colourChoices(agents)
  const firstFree = choices.find((choice) => choice.takenBy === null)
  if (firstFree) return { color: firstFree.colour, shape: 'hexagon' }
  const taken = new Set(choices.map((choice) => choice.colour))
  return { color: generatedColours(taken, 1)[0] ?? addAgentPalette[0], shape: 'hexagon' }
}

export type WorksOnChoice =
  | { backend: 'local' }
  | { backend: 'docker'; image?: string; network?: boolean }
  | { backend: 'ssh'; host: string; user: string; port?: number; keyPath?: string }

/**
 * The Runs on write from contract § Where an agent runs (PLAN 11.8a). It is sent only after profile setup has finished,
 * and only when the person chose something other than this machine: Score never rewrites the default needlessly.
 */
export async function saveRunsOn(agentId: string, choice: WorksOnChoice): Promise<RunsOn> {
  return RunsOnSchema.parse(
    await apiFetch(`agents/${encodeURIComponent(agentId)}/runs-on`, {
      method: 'PUT',
      body: JSON.stringify(choice),
    }),
  )
}

/** Every reason the Add button stays off, in words: the server's blockers first, then what the form still needs. */
export function addBlockReasons(
  blockers: readonly string[],
  input: { cloneFrom?: string | undefined },
  confirmed: boolean,
  runs: { backend: string; sshHost: string; sshUser: string },
): string[] {
  const reasons = blockers.map((blocker) =>
    /bridge installation URL/i.test(blocker)
      ? `${blocker} Set SCORE_BRIDGE_INSTALL_URL and SCORE_BRIDGE_INSTALL_REF where the Score server runs, then restart it (docs/SETUP.md).`
      : blocker,
  )
  if (input.cloneFrom && !confirmed) reasons.push('Tick “I’ve checked what this agent inherits.”')
  if (runs.backend === 'ssh') {
    if (!runs.sshHost.trim()) reasons.push('Enter the SSH host this agent runs on.')
    if (!runs.sshUser.trim()) reasons.push('Enter the SSH user this agent runs as.')
  }
  return reasons
}
