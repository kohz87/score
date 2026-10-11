import type { MessagePart, StreamEvent } from '@score/contract'

// PLAN 5.39: what each agent is doing right now, kept from the stream. It is built only from events Score already
// publishes (the reply being written, `typing`, approvals, a compaction answer), so nothing is invented. The status
// line (status-line.ts) is derived from it.

export interface AgentActivity {
  /** The reply being written: its parts so far (a tool card that is still running, the text). */
  messageId: string | null
  parts: readonly MessagePart[]
  /** The `typing` event's text (fake mode). */
  typing: string | null
  /** Approvals of this agent that wait for the person. */
  approvals: ReadonlySet<string>
  /** A compaction was asked for and not answered yet. */
  compacting: boolean
}

export type ActivityMap = ReadonlyMap<string, AgentActivity>

export const EMPTY_ACTIVITY: AgentActivity = {
  messageId: null,
  parts: [],
  typing: null,
  approvals: new Set(),
  compacting: false,
}

const idle = (a: AgentActivity) =>
  a.messageId === null && a.typing === null && a.approvals.size === 0 && !a.compacting

function put(map: ActivityMap, agentId: string, next: AgentActivity): ActivityMap {
  const copy = new Map(map)
  if (idle(next)) copy.delete(agentId)
  else copy.set(agentId, next)
  return copy
}

/** Marks a compaction as asked for (the context meter) or answered. */
export function setCompacting(map: ActivityMap, agentId: string, compacting: boolean): ActivityMap {
  const current = map.get(agentId) ?? EMPTY_ACTIVITY
  return current.compacting === compacting ? map : put(map, agentId, { ...current, compacting })
}

function ownerOf(map: ActivityMap, messageId: string): string | null {
  for (const [agentId, activity] of map) if (activity.messageId === messageId) return agentId
  return null
}

/** Folds one stream event into the activity of the agents; returns the same map when nothing changed. */
export function reduceActivity(map: ActivityMap, event: StreamEvent): ActivityMap {
  switch (event.type) {
    case 'message.created': {
      const message = event.data
      if (message.author.kind !== 'agent' || !message.streaming) return map
      const agentId = message.author.agentId
      const current = map.get(agentId) ?? EMPTY_ACTIVITY
      return put(map, agentId, { ...current, messageId: message.id, parts: message.parts })
    }
    case 'message.delta': {
      const agentId = ownerOf(map, event.data.messageId)
      if (!agentId) return map
      const current = map.get(agentId)!
      const parts = [...current.parts]
      const index = parts.findLastIndex((part) => part.kind === 'text')
      const last = parts[index]
      // As the thread does: text goes onto the last text part, or starts one after the cards.
      if (last?.kind === 'text' && index === parts.length - 1)
        parts[index] = { kind: 'text', text: last.text + event.data.append }
      else parts.push({ kind: 'text', text: event.data.append })
      return put(map, agentId, { ...current, parts })
    }
    case 'message.updated': {
      const agentId = ownerOf(map, event.data.messageId)
      if (!agentId || !event.data.parts) return map
      return put(map, agentId, { ...map.get(agentId)!, parts: event.data.parts })
    }
    case 'message.completed':
    case 'message.deleted': {
      const agentId = ownerOf(map, event.data.messageId)
      if (!agentId) return map
      return put(map, agentId, { ...map.get(agentId)!, messageId: null, parts: [] })
    }
    case 'typing': {
      const current = map.get(event.data.agentId) ?? EMPTY_ACTIVITY
      return current.typing === event.data.text
        ? map
        : put(map, event.data.agentId, { ...current, typing: event.data.text })
    }
    case 'approval.requested':
    case 'approval.updated': {
      const approval = event.data
      const current = map.get(approval.agentId) ?? EMPTY_ACTIVITY
      const waiting = approval.status === 'pending' && approval.delivery === 'none'
      if (waiting === current.approvals.has(approval.id)) return map
      const approvals = new Set(current.approvals)
      if (waiting) approvals.add(approval.id)
      else approvals.delete(approval.id)
      return put(map, approval.agentId, { ...current, approvals })
    }
    case 'session.compacted':
      return setCompacting(map, event.data.agentId, false)
    case 'agent.updated': {
      // An agent that is no longer working has nothing left in flight.
      const current = map.get(event.data.id)
      if (!current || event.data.status === 'working') return map
      return put(map, event.data.id, { ...current, messageId: null, parts: [], typing: null })
    }
    default:
      return map
  }
}
