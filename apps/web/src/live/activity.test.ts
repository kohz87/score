import { describe, expect, it } from 'vitest'
import type { Approval, Message, StreamEvent } from '@score/contract'
import { reduceActivity, setCompacting, type ActivityMap } from './activity.ts'
import { statusLine } from './status-line.ts'

const at = '2026-10-11T10:00:00.000Z'
const event = <T extends StreamEvent['type']>(type: T, data: unknown) =>
  ({ seq: 1, ts: at, type, data }) as unknown as StreamEvent

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  roomId: 'r1',
  author: { kind: 'agent', agentId: 'lead' },
  to: [],
  parts: [],
  createdAt: at,
  streaming: true,
  refs: [],
  ...overrides,
})
const approval = (overrides: Partial<Approval> = {}): Approval =>
  ({
    id: 'a1',
    agentId: 'lead',
    status: 'pending',
    delivery: 'none',
    ...overrides,
  }) as Approval

const start: ActivityMap = new Map()

describe('reduceActivity', () => {
  it('follows a reply: created, tool card, text, completed', () => {
    let map = reduceActivity(start, event('message.created', message()))
    expect(statusLine({ parts: map.get('lead')!.parts, working: true })).toBe('Thinking…')
    map = reduceActivity(
      map,
      event('message.updated', {
        roomId: 'r1',
        messageId: 'm1',
        parts: [{ kind: 'tool', tool: 'read_file', args: '', result: null, status: 'running' }],
      }),
    )
    expect(statusLine({ parts: map.get('lead')!.parts })).toBe('Calling `read_file()`…')
    map = reduceActivity(
      map,
      event('message.updated', {
        roomId: 'r1',
        messageId: 'm1',
        parts: [{ kind: 'tool', tool: 'read_file', args: '', result: 'ok', status: 'ok' }],
      }),
    )
    map = reduceActivity(
      map,
      event('message.delta', { roomId: 'r1', messageId: 'm1', append: 'Hi' }),
    )
    map = reduceActivity(
      map,
      event('message.delta', { roomId: 'r1', messageId: 'm1', append: ' there' }),
    )
    expect(map.get('lead')!.parts.at(-1)).toEqual({ kind: 'text', text: 'Hi there' })
    expect(statusLine({ parts: map.get('lead')!.parts })).toBe('Writing the reply…')
    map = reduceActivity(map, event('message.completed', { roomId: 'r1', messageId: 'm1' }))
    expect(map.has('lead')).toBe(false)
  })

  it('ignores replies that are not streaming and people’s messages', () => {
    expect(reduceActivity(start, event('message.created', message({ streaming: false })))).toBe(
      start,
    )
    expect(
      reduceActivity(start, event('message.created', message({ author: { kind: 'you' } }))),
    ).toBe(start)
    expect(
      reduceActivity(start, event('message.delta', { roomId: 'r1', messageId: 'zz', append: 'x' })),
    ).toBe(start)
  })

  it('tracks typing, open approvals and compaction per agent', () => {
    let map = reduceActivity(
      start,
      event('typing', { roomId: 'r1', agentId: 'lead', text: 'is typing' }),
    )
    expect(map.get('lead')!.typing).toBe('is typing')
    map = reduceActivity(map, event('typing', { roomId: 'r1', agentId: 'lead', text: null }))
    expect(map.size).toBe(0)

    map = reduceActivity(map, event('approval.requested', approval()))
    expect(map.get('lead')!.approvals.has('a1')).toBe(true)
    map = reduceActivity(
      map,
      event('approval.updated', approval({ status: 'approved', delivery: 'applied' })),
    )
    expect(map.size).toBe(0)

    map = setCompacting(map, 'builder', true)
    expect(map.get('builder')!.compacting).toBe(true)
    map = reduceActivity(
      map,
      event('session.compacted', { agentId: 'builder', status: 'compacted' }),
    )
    expect(map.size).toBe(0)
  })

  it('forgets what is in flight when the agent stops working', () => {
    let map = reduceActivity(start, event('message.created', message()))
    map = reduceActivity(map, event('agent.updated', { id: 'lead', status: 'idle' }))
    expect(map.size).toBe(0)
  })
})
