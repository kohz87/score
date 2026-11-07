import type { AgentSummary, Room } from '@score/contract'

export type Lookup = {
  agents: AgentSummary[]
  rooms: Room[]
}

export const agentOf = (lookup: Lookup, id: string | null) =>
  id ? lookup.agents.find((agent) => agent.id === id) : undefined
export const roomName = (lookup: Lookup, id: string | null) =>
  id ? (lookup.rooms.find((room) => room.id === id)?.name ?? 'Room') : 'No room'
