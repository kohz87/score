import { AgentSummarySchema, AsOfSeqSchema } from '@score/contract'
import { apiFetch } from './api.ts'
import { defineStreamQuery } from './resync.ts'

function snapshot(value: unknown): { fields: Record<string, unknown>; asOfSeq: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid snapshot response')
  const fields = value as Record<string, unknown>
  // A fresh server reports asOfSeq 0, which the stream's (positive) seq would reject.
  return { fields, asOfSeq: AsOfSeqSchema.parse(fields.asOfSeq) }
}

export const taskAgentsQuery = defineStreamQuery({
  key: ['tasks', 'agents'],
  async fetch(signal) {
    const { fields, asOfSeq } = snapshot(await apiFetch('agents', { signal }))
    return { asOfSeq, data: AgentSummarySchema.array().parse(fields.items) }
  },
  types: ['agent.updated'],
  reduce(agents, event) {
    if (event.type !== 'agent.updated') return agents
    return agents.some((agent) => agent.id === event.data.id)
      ? agents.map((agent) => (agent.id === event.data.id ? event.data : agent))
      : [...agents, event.data]
  },
})
