import { expect, test } from 'vitest'
import { decideHandoffs, messageTurnId, routeMessage } from '../../src/domain/routing.ts'

const agents = ['lead', 'builder', 'reviewer', 'designer']
test.each([
  ['hello', [], 'lead', ['lead']],
  ['@builder please ask @reviewer', [], 'lead', ['builder', 'reviewer']],
  [
    '@builder @reviewer @builder',
    ['designer', 'builder'],
    'lead',
    ['designer', 'builder', 'reviewer'],
  ],
  ['@unknown hello', [], 'builder', ['builder']],
  ['`@builder` hello', [], 'lead', ['lead']],
] as const)('routes %s preserving recipient order', (text, to, leadAgentId, expected) => {
  expect(routeMessage(text, [...to], { leadAgentId }, agents).routedTo).toEqual(expected)
})
test('a room without a recipient rejects before admission', () => {
  expect(() => routeMessage('hello', [], { leadAgentId: null }, agents)).toThrow('no recipient')
})
test.each([
  { from: 'lead', mentions: ['builder'], hop: 0, edges: [], targets: ['builder'], stopped: false },
  {
    from: 'builder',
    mentions: ['lead'],
    hop: 1,
    edges: [{ from: 'lead', to: 'builder' }],
    targets: [],
    stopped: true,
  },
  { from: 'builder', mentions: ['builder'], hop: 1, edges: [], targets: [], stopped: false },
  {
    from: 'builder',
    mentions: ['reviewer', 'reviewer'],
    hop: 4,
    edges: [],
    targets: [],
    stopped: true,
  },
  {
    from: 'builder',
    mentions: ['lead', 'reviewer'],
    hop: 1,
    edges: [{ from: 'lead', to: 'builder' }],
    targets: ['reviewer'],
    stopped: true,
  },
  {
    from: 'lead',
    mentions: ['builder', 'reviewer'],
    hop: 0,
    edges: [],
    limit: 1,
    targets: ['builder'],
    stopped: true,
  },
])('bounded hand-off decision %#', ({ targets, stopped, ...input }) => {
  expect(decideHandoffs(input)).toEqual({ targets, stopped })
})
test('turn identities are deterministic per message and agent', () => {
  expect(messageTurnId('message', 'builder')).toBe(messageTurnId('message', 'builder'))
  expect(messageTurnId('message', 'lead')).not.toBe(messageTurnId('message', 'builder'))
})
