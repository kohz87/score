import type { AgentEfforts } from '@score/contract'
import { expect, test } from 'vitest'
import { effortMenuItems } from './effort-menu.ts'

/** Decision 178, the `/effort` palette for one agent: its levels, then "Back to its own", with a header and a note. */
const efforts = (over: Partial<AgentEfforts> = {}): AgentEfforts => ({
  agentId: 'reviewer',
  own: 'medium',
  levels: ['low', 'high', 'max'],
  chats: [],
  ...over,
})

test('no items until the agent’s efforts are loaded, or when it takes no level', () => {
  expect(effortMenuItems(undefined, 'reviewer')).toEqual([])
  expect(effortMenuItems(efforts({ levels: [] }), 'reviewer')).toEqual([])
})

test('lists only the agent’s levels, then Back to its own, and the header goes on the first item', () => {
  const items = effortMenuItems(efforts(), 'reviewer')
  expect(items.map((item) => item.insert)).toEqual([
    '/effort low',
    '/effort high',
    '/effort max',
    '/effort default',
  ])
  expect(items[0]!.header).toBe('Effort for reviewer in this chat · its own setting is medium')
  expect(items.slice(1).every((item) => item.header === undefined)).toBe(true)
  expect(items[3]!.description).toBe('Back to reviewer’s own (medium)')
})

test('every item carries the note under the palette, and the own level reads as the model’s default when unset', () => {
  const items = effortMenuItems(efforts({ own: null }), 'reviewer')
  expect(items.every((item) => item.note?.includes('Other chats keep its own setting.'))).toBe(true)
  expect(items.at(-1)!.description).toBe('Back to reviewer’s own (the model’s default)')
})

test('when the levels can’t be read, the palette offers only Back to its own, and says so; while loading it is empty', () => {
  const items = effortMenuItems(undefined, 'reviewer', true)
  expect(items).toHaveLength(1)
  expect(items[0]!.usage).toBe('/effort default')
  expect(items[0]!.header).toBe('Effort for reviewer in this chat · its own setting is unknown')
  expect(items[0]!.note).toContain('Can’t list the levels reviewer’s model takes right now.')
  expect(effortMenuItems(undefined, 'reviewer')).toEqual([])
})
