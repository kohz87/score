import { expect, test } from 'vitest'
import {
  BridgeCommandResultSchema,
  BridgeCommandSchema,
  RewindPlanSchema,
  RewindRequestSchema,
  RewindResponseSchema,
  RoomVersionSchema,
} from '../src/index.ts'
import * as f from './fixtures.ts'

test('a rewind request names its mode and only optionally hides in Score only', () => {
  expect(RewindRequestSchema.parse({ mode: 'edit' })).toEqual({ mode: 'edit' })
  expect(RewindRequestSchema.parse({ mode: 'delete', scoreOnly: true }).scoreOnly).toBe(true)
  expect(RewindRequestSchema.safeParse({ mode: 'undo' }).success).toBe(false)
})

test('a version, a rewind response and a plan round-trip', () => {
  expect(RoomVersionSchema.parse(f.roomVersion)).toEqual(f.roomVersion)
  expect(
    RewindResponseSchema.parse({
      version: f.roomVersion,
      rewound: f.roomVersion.rewound,
      skipped: [],
    }),
  ).toBeTruthy()
  expect(
    RewindPlanSchema.parse({
      hiddenCount: 2,
      blocked: null,
      agents: [{ agentId: 'builder', turns: 2, cannot: 'compressed' }],
    }),
  ).toBeTruthy()
  expect(RoomVersionSchema.safeParse({ ...f.roomVersion, number: 0 }).success).toBe(false)
  expect(
    RoomVersionSchema.safeParse({ ...f.roomVersion, skipped: [{ agentId: 'a', reason: 'x' }] })
      .success,
  ).toBe(false)
})

test('bridge commands are bounded', () => {
  const command = {
    commandId: 'c1',
    kind: 'rewind',
    sessionId: 'score-room-builder',
    turns: 2,
    expiresAt: 1790000060,
  }
  expect(BridgeCommandSchema.parse(command)).toEqual(command)
  for (const bad of [
    { turns: 0 },
    { turns: 1001 },
    { kind: 'other' },
    { sessionId: '' },
    { expiresAt: undefined },
    { expiresAt: 0 },
  ])
    expect(BridgeCommandSchema.safeParse({ ...command, ...bad }).success).toBe(false)
  expect(
    BridgeCommandResultSchema.parse({ outcome: 'done', turnsUndone: 2, rewoundCount: 5 }),
  ).toBeTruthy()
  expect(BridgeCommandResultSchema.parse({ outcome: 'expired' })).toBeTruthy()
  expect(BridgeCommandResultSchema.safeParse({ outcome: 'maybe' }).success).toBe(false)
})
