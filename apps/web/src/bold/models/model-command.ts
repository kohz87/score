import type { QueryClient } from '@tanstack/react-query'
import type { AgentSummary } from '@score/contract'
import { agentDisplayName } from '../bold-agents.ts'
import type { EffortSay } from '../efforts/effort-command.ts'
import { agentChatModelsKey, chatModelOf, fetchRoomModels, putRoomModel } from './model-queries.ts'
import { chosenLabel } from './model-model.ts'

/** What `/model <words>` asks for: its state, the agent's own, or one model or alias. */
export type ModelRequest = { kind: 'show' } | { kind: 'own' } | { kind: 'set'; name: string }

/** `/model` with nothing shows the state, `default` goes back to the agent's own, anything else is a model or alias. */
export function parseModelArgs(args: string): ModelRequest {
  const word = args.trim()
  if (!word) return { kind: 'show' }
  if (word.toLowerCase() === 'default') return { kind: 'own' }
  return { kind: 'set', name: word }
}

/**
 * Runs `/model` for one agent in one chat (decision 182). It changes that chat only, says what it did in the stream and
 * offers Undo, which puts back what the change replaced. The server judges the name (an alias is resolved there); a name it
 * refuses comes back as its own plain words. It never calls the agent's own model endpoint.
 */
export async function runModelCommand({
  roomId,
  roomKind,
  agent,
  args,
  provider,
  queryClient,
  say,
}: {
  roomId: string
  roomKind: 'direct' | 'group'
  agent: AgentSummary
  args: string
  /** The provider of a model picked from a list; a typed name carries none. */
  provider?: string
  queryClient: QueryClient
  say: EffortSay
}): Promise<void> {
  const name = agentDisplayName(agent)
  const own = agent.model?.id ?? 'unknown'
  const current = chatModelOf((await fetchRoomModels(roomId)).items, agent.id)
  const request = parseModelArgs(args)

  if (request.kind === 'show') {
    say(
      current
        ? `${name} runs ${chosenLabel(current)} in this chat (its own is ${own}).`
        : `${name} uses its own model in this chat: ${own}.`,
    )
    return
  }
  const next = request.kind === 'own' ? null : request.name
  if (next === null && current === null) {
    say(`${name} already uses its own model in this chat.`)
    return
  }
  if (
    next !== null &&
    current &&
    (current.label === next || current.model === next) &&
    (!provider || current.provider === provider)
  ) {
    say(`${name} already runs ${chosenLabel(current)} in this chat.`)
    return
  }

  const change = await putRoomModel(roomId, agent.id, next, provider)
  await queryClient.invalidateQueries({ queryKey: agentChatModelsKey(agent.id) })

  const undo = {
    label: 'Undo',
    run: () => {
      const back = change.replaced
      // Exactly what was replaced: its model, provider and the label the person chose it by.
      void putRoomModel(roomId, agent.id, back ? back.model : null, back?.provider, back?.label)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: agentChatModelsKey(agent.id) })
          say(
            back
              ? `Put back ${name}’s model to ${chosenLabel(back)} in this chat.`
              : `${name} is back on its own model in this chat.`,
          )
        })
        .catch(() => say('That didn’t work. Try again.'))
    },
  }
  if (!change.current) {
    say(`${name} is back on its own model in this chat (${own}).`, undo)
    return
  }
  const label = chosenLabel(change.current)
  say(
    roomKind === 'direct'
      ? `${name} uses ${label} in this chat; its own is ${own}.`
      : `You set ${name}’s model to ${label} for this chat`,
    undo,
  )
}
