import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSummary, Room } from '@score/contract'
import { expect, test } from 'vitest'
import { ownerLabel } from './ChatHeader.tsx'

test('the owner is the lead, else the raw id, else "no owner yet"', () => {
  const lead = { id: 'lead', name: 'Lead agent' } as AgentSummary
  expect(ownerLabel({ leadAgentId: 'lead' } as Room, [lead])).toBe('Lead agent')
  expect(ownerLabel({ leadAgentId: 'gone' } as Room, [lead])).toBe('gone')
  expect(ownerLabel({ leadAgentId: null } as Room, [lead])).toBe('no owner yet')
})

test('the round Back and Info buttons are at least 44px, the phone’s finger-target floor', () => {
  const css = readFileSync(join(__dirname, 'chats-list.css'), 'utf8')
  const rule = /\.bold-chat-round\.small \{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(rule).toContain('width: 44px')
  expect(rule).toContain('height: 44px')
})
