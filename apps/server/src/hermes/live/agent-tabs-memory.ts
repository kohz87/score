import type { MemoryItem, MemoryPage } from '@score/contract'
import type { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { pageMemory, MemoryQuerySchema } from '../agent-tabs.ts'
import { AgentTabsSkills } from './agent-tabs-skills.ts'
import { readMemory } from './memory.ts'

/** Read-only built-in memory for one Hermes profile. */
export abstract class AgentTabsMemory extends AgentTabsSkills {
  memory(agentId: string): MemoryItem[] {
    return readMemory(this.profile(agentId).home)
  }
  listMemory(agentId: string, query: z.infer<typeof MemoryQuerySchema>): MemoryPage {
    // Hermes has no per-entry memory command, so the page says it is read-only.
    return pageMemory(this.memory(agentId), MemoryQuerySchema.parse(query), false)
  }
  unsupportedMemoryWrite(agentId: string): never {
    this.profile(agentId)
    throw new HttpError(
      501,
      'not_implemented',
      'Hermes has no way to add or remove a single memory entry, so memory is read-only in Score.',
    )
  }
}
