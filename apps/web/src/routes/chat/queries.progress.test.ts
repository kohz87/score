import { expect, test } from 'vitest'
import type { Message, StreamEvent } from '@score/contract'
import { reduceMessages } from './queries.ts'

const message: Message = {
  id: 'reply-1',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'builder' },
  to: [],
  parts: [],
  createdAt: '2026-10-09T10:00:00.000Z',
  streaming: true,
  refs: [],
}
const data = { items: [message], typing: {}, nextCursor: null } as unknown as Parameters<
  typeof reduceMessages
>[0]
const event = (type: string, body: object) =>
  ({
    type,
    id: '1',
    data: { roomId: 'general', messageId: 'reply-1', ...body },
  }) as unknown as StreamEvent

test('a tool/reasoning/approval move and a text delta both restart the reply’s stall clock', () => {
  const progressed = reduceMessages(
    data,
    event('message.progressed', { at: '2026-10-09T10:01:00.000Z' }),
    'general',
    true,
  )
  expect(progressed.items[0]!.progressAt).toBeTruthy()
  const delta = reduceMessages(data, event('message.delta', { append: 'hi' }), 'general', true)
  expect(delta.items[0]!.progressAt).toBeTruthy()
  expect(delta.items[0]!.parts).toEqual([{ kind: 'text', text: 'hi' }])
})
