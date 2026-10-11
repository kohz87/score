import { createHash } from 'node:crypto'
import type { Room } from '@score/contract'
import { HttpError } from '../errors.ts'
import { COMMANDS, parseMessage } from './parse.ts'

export const HANDOFF_HOP_LIMIT = 4

export function routeMessage(
  text: string,
  to: string[],
  room: Pick<Room, 'leadAgentId'>,
  agents: string[],
) {
  const parsed = parseMessage(text, agents)
  const command = parsed.command
  if (command?.kind === 'invalid')
    throw new HttpError(400, 'bad_request', command.error, {
      error: command.error,
      usage: command.usage,
    })
  if (command && ['remember', 'skill'].includes(command.kind))
    throw new HttpError(501, 'not_implemented', 'That command isn’t available yet.', {
      usage: COMMANDS.find((item) => item.name === command.kind)!.usage,
    })
  if (command?.kind === 'assign' || command?.kind === 'routine')
    return { parsed, routedTo: [], input: text, model: undefined }
  const input = command?.kind === 'model' ? command.message : text
  const mentions =
    command?.kind === 'model' ? parseMessage(input, agents).mentions : parsed.mentions
  const routedTo = [...new Set([...to, ...mentions])]
  if (!routedTo.length && room.leadAgentId && agents.includes(room.leadAgentId))
    routedTo.push(room.leadAgentId)
  if (!routedTo.length)
    throw new HttpError(400, 'no_recipient', 'This room has no agent to receive messages.')
  return { parsed, routedTo, input, model: command?.kind === 'model' ? command.model : undefined }
}

export function decideHandoffs({
  from,
  mentions,
  hop,
  edges,
  limit = HANDOFF_HOP_LIMIT,
}: {
  from: string
  mentions: string[]
  hop: number
  edges: { from: string; to: string }[]
  limit?: number
}): { targets: string[]; stopped: boolean } {
  const targets: string[] = []
  let stopped = false
  for (const to of new Set(mentions)) {
    if (to === from) continue
    if (
      hop >= limit ||
      edges.length + targets.length >= limit ||
      edges.some((edge) => edge.from === to && edge.to === from)
    )
      stopped = true
    else targets.push(to)
  }
  return { targets, stopped }
}

/** `retry` makes a further turn for the same message and agent (PLAN 5.24); without it the id is the original turn's. */
export function messageTurnId(messageId: string, agentId: string, retry?: string): string {
  return `room-turn:${createHash('sha256')
    .update(
      JSON.stringify(retry === undefined ? [messageId, agentId] : [messageId, agentId, retry]),
    )
    .digest('hex')}`
}

export function modelCommand(model: string | undefined): { kind: 'model'; model: string } | null {
  return model ? { kind: 'model', model } : null
}
