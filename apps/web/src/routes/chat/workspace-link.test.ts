import { expect, test } from 'vitest'
import { parseWorkspaceLink } from './workspace-link.ts'

const agents = ['builder', 'reviewer']

test('a bare path belongs to the default agent', () => {
  expect(parseWorkspaceLink('workspace://src/main.ts', 'builder', agents)).toEqual({
    agentId: 'builder',
    path: 'src/main.ts',
    to: '/team/builder/workspace?path=src%2Fmain.ts',
  })
})

test('a leading known agent id picks that agent; an unknown first segment stays part of the path', () => {
  expect(parseWorkspaceLink('workspace://reviewer/notes/a b.md', 'builder', agents)).toMatchObject({
    agentId: 'reviewer',
    path: 'notes/a b.md',
  })
  expect(parseWorkspaceLink('workspace://docs/readme.md', 'builder', agents)).toMatchObject({
    agentId: 'builder',
    path: 'docs/readme.md',
  })
})

test('no agent, no path or a broken escape gives no link', () => {
  expect(parseWorkspaceLink('workspace://src/a.ts', null, agents)).toBeNull()
  expect(parseWorkspaceLink('workspace://builder', 'builder', agents)).toBeNull()
  expect(parseWorkspaceLink('workspace://%E0%A4%A', 'builder', agents)).toBeNull()
})

test('a query or fragment is not part of the path', () => {
  expect(parseWorkspaceLink('workspace://a.md#top', 'builder', agents)?.path).toBe('a.md')
})
