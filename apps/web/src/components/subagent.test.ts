import { expect, test } from 'vitest'
import { nestSubagentCalls, subagentLine } from './subagent.ts'

test('sub-agent calls nest under their Agent call; orphans stay flat, order is kept', () => {
  const items = [
    { id: 'a', callId: 'c1' },
    { id: 'b', callId: 'c2', parentCallId: 'c1' },
    { id: 'c', callId: 'c3', parentCallId: 'gone' },
    { id: 'd', callId: 'c4', parentCallId: 'c4' },
    { id: 'e' },
  ]
  const { top, children } = nestSubagentCalls(items)
  expect(top.map((item) => item.id)).toEqual(['a', 'c', 'd', 'e'])
  expect(children.get('c1')?.map((item) => item.id)).toEqual(['b'])
})

test('the one-line summary reads in plain words', () => {
  const base = {
    status: 'done',
    description: 'List files in folder',
    subagentType: null,
    toolCalls: 1,
    durationMs: null,
    totalTokens: null,
  } as const
  expect(subagentLine(base, 0)).toBe('Sub-agent · List files in folder · 1 tool call · done')
  expect(subagentLine({ ...base, status: 'running', description: null, toolCalls: null }, 3)).toBe(
    'Sub-agent · 3 tool calls · working',
  )
  expect(subagentLine({ ...base, status: 'failed' }, 0)).toContain('failed')
})
