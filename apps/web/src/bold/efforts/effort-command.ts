import type { QueryClient } from '@tanstack/react-query'
import type { AgentSummary } from '@score/contract'
import { agentDisplayName } from '../bold-agents.ts'
import {
  agentEffortsQuery,
  chatEffortOf,
  fetchRoomEfforts,
  putRoomEffort,
  agentEffortsKey,
} from './effort-queries.ts'
import { ownEffortLabel } from './effort-model.ts'

export type EffortSay = (text: string, action?: { label: string; run: () => void }) => void

/** What `/effort <words>` asks for: its state, the agent's own, or one level. */
export type EffortRequest = { kind: 'show' } | { kind: 'own' } | { kind: 'set'; level: string }

/** `/effort` with nothing shows the state, `default` goes back to the agent's own, anything else is a level. */
export function parseEffortArgs(args: string): EffortRequest {
  const word = args.trim().toLowerCase()
  if (!word) return { kind: 'show' }
  if (word === 'default') return { kind: 'own' }
  return { kind: 'set', level: word }
}

/**
 * Runs `/effort` for one agent in one chat (decision 178). It changes that chat only, says what it did in the stream, and
 * offers Undo, which puts back the effort it replaced. A level the agent doesn't take sends nothing and says which it takes.
 */
export async function runEffortCommand({
  roomId,
  roomKind,
  agent,
  args,
  queryClient,
  say,
}: {
  roomId: string
  roomKind: 'direct' | 'group'
  agent: AgentSummary
  args: string
  queryClient: QueryClient
  say: EffortSay
}): Promise<void> {
  const name = agentDisplayName(agent)
  // A failed read (the server's 503) leaves the levels unknown: `own` and `back to its own` still work, a level does not.
  const efforts = await queryClient.fetchQuery(agentEffortsQuery(agent.id)).catch(() => null)
  const levels = efforts?.levels ?? null
  const ownText = ownEffortLabel(efforts ? efforts.own : undefined)
  const current = chatEffortOf((await fetchRoomEfforts(roomId)).items, agent.id)
  const request = parseEffortArgs(args)

  if (request.kind === 'show') {
    say(
      current
        ? `${name} thinks at effort ${current} in this chat (its own is ${ownText}).`
        : `${name} uses its own effort in this chat: ${ownText}.`,
    )
    return
  }

  if (request.kind === 'set' && levels === null) {
    say(`Score can’t list the levels ${name} takes right now. Nothing was sent.`)
    return
  }
  if (request.kind === 'set' && !levels?.includes(request.level)) {
    say(
      levels?.length
        ? `${name} takes ${levels.join(', ')}. Nothing was sent.`
        : `${name} has no effort Score can set. Nothing was sent.`,
    )
    return
  }

  const next = request.kind === 'own' ? null : request.level
  if (next === current) {
    say(
      next === null
        ? `${name} already uses its own effort in this chat.`
        : `${name} is already at effort ${next} in this chat.`,
    )
    return
  }

  await putRoomEffort(roomId, agent.id, next)
  await queryClient.invalidateQueries({ queryKey: agentEffortsKey(agent.id) })

  const undo = {
    label: 'Undo',
    run: () => {
      void putRoomEffort(roomId, agent.id, current)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: agentEffortsKey(agent.id) })
          say(
            current
              ? `Put back ${name}’s effort to ${current} in this chat.`
              : `${name} is back on its own effort in this chat.`,
          )
        })
        .catch(() => say('That didn’t work. Try again.'))
    },
  }
  if (next === null) {
    say(`${name} is back on its own effort in this chat (${ownText}).`, undo)
    return
  }
  say(
    roomKind === 'direct'
      ? `${name} works at effort ${next} in this chat (its own is ${ownText}).`
      : `You set ${name}’s effort to ${next} for this chat`,
    undo,
  )
}
