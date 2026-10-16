import { describe, expect, it } from 'vitest'
import {
  BridgeCommandResultSchema,
  BridgeCommandSchema,
  CompactRequestSchema,
  RoomDeleteRequestSchema,
  SessionCompactedSchema,
  StreamEventSchema,
} from '../src/index.ts'

describe('compaction and room deletion contracts (PLAN 5.36)', () => {
  it('parses the compact bridge command next to rewind', () => {
    const command = {
      commandId: 'c1',
      kind: 'compact',
      sessionId: 'score-room-builder',
      keepRecent: 3,
      expiresAt: 1790000180,
    }
    expect(BridgeCommandSchema.parse(command)).toEqual(command)
    expect(BridgeCommandSchema.safeParse({ ...command, keepRecent: 0 }).success).toBe(false)
    expect(BridgeCommandSchema.safeParse({ ...command, turns: 2, kind: 'rewind' }).success).toBe(
      true,
    )
    expect(BridgeCommandSchema.safeParse({ ...command, kind: 'other' }).success).toBe(false)
    expect(BridgeCommandSchema.safeParse({ ...command, sessionId: '' }).success).toBe(false)
  })

  it('carries before/after sizes in a command result', () => {
    const result = {
      outcome: 'done',
      before: { messages: 40, tokens: 54000 },
      after: { messages: 8, tokens: 9000 },
    }
    expect(BridgeCommandResultSchema.parse(result)).toEqual(result)
    expect(
      BridgeCommandResultSchema.safeParse({ outcome: 'done', before: { messages: -1, tokens: 1 } })
        .success,
    ).toBe(false)
  })

  it('validates requests and the session.compacted event', () => {
    expect(CompactRequestSchema.parse({})).toEqual({})
    expect(CompactRequestSchema.parse({ keepRecent: 20 })).toEqual({ keepRecent: 20 })
    expect(CompactRequestSchema.safeParse({ keepRecent: 21 }).success).toBe(false)
    expect(CompactRequestSchema.safeParse({ extra: 1 }).success).toBe(false)
    expect(RoomDeleteRequestSchema.safeParse({ confirm: '' }).success).toBe(false)
    const data = {
      commandId: 'c1',
      agentId: 'builder',
      sessionId: 'score-r-builder',
      roomId: 'r',
      status: 'compacted',
      reason: null,
      keepRecent: 2,
      before: { messages: 40, tokens: 54000 },
      after: { messages: 8, tokens: 9000 },
      memoryNote: null,
    }
    expect(SessionCompactedSchema.parse(data)).toEqual(data)
    // An older producer's event has no memory note: it reads as none.
    const { memoryNote: _omitted, ...older } = data
    expect(SessionCompactedSchema.parse(older).memoryNote).toBeNull()
    expect(SessionCompactedSchema.safeParse({ ...data, reason: 'because' }).success).toBe(false)
    const envelope = { seq: 1, ts: '2026-10-11T10:00:00.000Z' }
    expect(StreamEventSchema.parse({ ...envelope, type: 'session.compacted', data })).toBeTruthy()
    expect(
      StreamEventSchema.parse({ ...envelope, type: 'room.deleted', data: { id: 'r' } }),
    ).toBeTruthy()
  })
})
