import type { AgentSummary, Room } from '@score/contract'
import { expect, test } from 'vitest'
import { ownerLabel } from './ChatHeader.tsx'

test('the owner is the lead, else the raw id, else "no owner yet"', () => {
  const lead = { id: 'lead', name: 'Lead agent' } as AgentSummary
  expect(ownerLabel({ leadAgentId: 'lead' } as Room, [lead])).toBe('Lead agent')
  expect(ownerLabel({ leadAgentId: 'gone' } as Room, [lead])).toBe('gone')
  expect(ownerLabel({ leadAgentId: null } as Room, [lead])).toBe('no owner yet')
})
