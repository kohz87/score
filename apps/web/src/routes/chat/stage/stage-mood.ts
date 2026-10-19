import type { AgentSummary, Approval, Message, Room } from '@score/contract'

/** What a member of the room is doing, from the room's live state (PLAN 10.10, decision 110). */
export type StageMood = 'rest' | 'think' | 'work' | 'needs' | 'sleep'

export type StageInput = {
  roomId: string
  members: Pick<AgentSummary, 'id' | 'status'>[]
  /** The room's latest page of messages (the stream keeps it live). */
  messages: Message[]
  /** The room's `typing` map: agent id to what it is doing, empty when it has just started. */
  typing: Record<string, string>
  /** `Room.activeAgents`: agents with a turn in progress here. */
  activeAgents: string[]
  approvals: Approval[]
}

const words: Record<StageMood, string> = {
  rest: 'resting',
  think: 'thinking',
  work: 'working',
  needs: 'waiting for you',
  sleep: 'paused',
}
export const moodText = (mood: StageMood): string => words[mood]

/** The room's members plus its lead, in that order; agents that are removed or unknown are left out. */
export function stageMembers(
  room: Pick<Room, 'members' | 'leadAgentId' | 'kind'>,
  agents: AgentSummary[],
): AgentSummary[] {
  const ids = [...room.members]
  if (room.leadAgentId && !ids.includes(room.leadAgentId)) ids.push(room.leadAgentId)
  return [...new Set(ids)].flatMap((id) => {
    const agent = agents.find((item) => item.id === id)
    return agent && agent.lifecycle?.state !== 'removed' ? [agent] : []
  })
}

const hasContent = (message: Message) =>
  message.parts.some((part) =>
    part.kind === 'text' ? part.text.trim() !== '' : part.kind !== 'thinking',
  )

/** An approval belongs to this room when it says so, or when the room holds its card. */
function waitingHere(input: StageInput): Set<string> {
  const cards = new Set(
    input.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.kind === 'approval' ? [part.approvalId] : [])),
    ),
  )
  return new Set(
    input.approvals
      .filter(
        (approval) =>
          approval.actionable &&
          approval.status === 'pending' &&
          (cards.has(approval.id) ||
            approval.refs.some((ref) => ref.kind === 'room' && ref.roomId === input.roomId)),
      )
      .map((approval) => approval.agentId),
  )
}

/**
 * One mood per member. Waiting for you comes first (it needs the person), then paused or offline (a stale reply can't
 * keep a stopped agent working), then working (text or a tool call in flight), then thinking (a turn started and
 * nothing to show yet).
 */
export function stageMoods(input: StageInput): Record<string, StageMood> {
  const needs = waitingHere(input)
  const streaming = new Map<string, boolean>()
  for (const message of input.messages)
    if (message.streaming && message.author.kind === 'agent') {
      const id = message.author.agentId
      streaming.set(id, (streaming.get(id) ?? false) || hasContent(message))
    }
  return Object.fromEntries(
    input.members.map((member): [string, StageMood] => {
      const id = member.id
      if (needs.has(id)) return [id, 'needs']
      if (member.status === 'paused' || member.status === 'offline') return [id, 'sleep']
      if (streaming.get(id) === true || (input.typing[id] ?? '') !== '') return [id, 'work']
      if (streaming.has(id) || id in input.typing || input.activeAgents.includes(id))
        return [id, 'think']
      return [id, 'rest']
    }),
  )
}

export type Handoff = { id: string; from: string; to: string }

/** `@id` words of a text. */
const mentioned = (text: string) =>
  [...text.matchAll(/(?:^|\s)@([\w-]+)/g)].map((match) => match[1]!)

/**
 * The newest message nobody has looked at yet in which one member hands over to another: an agent's message that
 * addresses (`to`) or @mentions another member. `seen` holds the messages already looked at, so a hand-off turns the
 * two toward each other once and a room that opens on old messages starts calm.
 */
export function newHandoff(
  messages: Message[],
  seen: ReadonlySet<string>,
  memberIds: string[],
): Handoff | null {
  const unseen = messages
    .filter((message) => !seen.has(message.id) && message.author.kind === 'agent')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  for (const message of unseen) {
    if (message.author.kind !== 'agent') continue
    const from = message.author.agentId
    if (!memberIds.includes(from)) continue
    const text = message.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('\n')
    const to = [...message.to, ...mentioned(text)].find((id) => id !== from && memberIds.includes(id))
    if (to) return { id: message.id, from, to }
  }
  return null
}
