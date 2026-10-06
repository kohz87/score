import { describe, expect, test } from 'vitest'
import {
  AgentStyleSchema,
  AgentSummarySchema,
  ApprovalSchema,
  LaneBlockSchema,
  MessagePartSchema,
  MessageSchema,
  RefSchema,
  RoomSchema,
  RunSummarySchema,
  SystemStatusSchema,
  TaskActivitySchema,
  TaskDetailSchema,
  TaskSummarySchema,
  WatchFrameSchema,
} from '../src/index.ts'
import * as f from './fixtures.ts'

test.each(f.refs)('round-trips the $kind reference', (ref) => {
  expect(RefSchema.parse(JSON.parse(JSON.stringify(ref)))).toEqual(ref)
})

test.each(f.parts)('round-trips the $kind message part', (part) => {
  expect(MessagePartSchema.parse(JSON.parse(JSON.stringify(part)))).toEqual(part)
})

test.each([
  { kind: 'plan', lanes: [{ agentId: '', blocks: [] }], briefId: 'brief-1' },
  { kind: 'tools', summary: 'Ran tests', runId: '' },
  { kind: 'file', path: 'src/types.ts', added: '1', removed: 0 },
  { kind: 'review', verdict: 'pending', taskId: null },
  { kind: 'text' },
])('rejects an invalid $kind message part', (part) => {
  expect(MessagePartSchema.safeParse(part).success).toBe(false)
})

test.each(['#000000', '#FFFFFF', '#abcdef'])('accepts color %s', (color) => {
  expect(AgentStyleSchema.parse({ ...f.style, color }).color).toBe(color)
})

test.each(['red', '#12345g', '123456', '#12345678'])('rejects color %s', (color) => {
  expect(AgentStyleSchema.safeParse({ ...f.style, color }).success).toBe(false)
})

test.each([0, 1, null])('accepts progress %s', (progress) => {
  expect(TaskSummarySchema.parse({ ...f.task, progress }).progress).toBe(progress)
})

test.each([-0.01, 1.01])('rejects progress %s', (progress) => {
  expect(TaskSummarySchema.safeParse({ ...f.task, progress }).success).toBe(false)
})

test.each(['not a date', '2026-02-30T12:00:00Z', '2026-10-06T12:00:00+02:00'])(
  'rejects invalid or non-UTC timestamp %s',
  (createdAt) => {
    expect(MessageSchema.safeParse({ ...f.message, createdAt }).success).toBe(false)
  },
)

test('accepts nullable fields without making them optional', () => {
  const cases = [
    [AgentSummarySchema, { ...f.agent, activity: null, model: null }],
    [ApprovalSchema, { ...f.approval, cwd: null, expiresAt: null, decision: null, blocking: null }],
    [
      TaskSummarySchema,
      {
        ...f.task,
        assignee: null,
        reviewer: null,
        roomId: null,
        badge: null,
        progress: null,
        elapsedSec: null,
        note: null,
      },
    ],
    [TaskDetailSchema, { ...f.detail, pendingApproval: null }],
    [RoomSchema, { ...f.room, leadAgentId: null }],
    [LaneBlockSchema, { ...f.lane, end: null, taskId: null, runId: null }],
    [
      RunSummarySchema,
      {
        ...f.run,
        endedAt: null,
        model: null,
        tokens: null,
        costUsd: null,
        gaps: [{ from: f.at, to: null, reason: 'Disconnected' }],
      },
    ],
    [
      SystemStatusSchema,
      {
        ...f.system,
        hermes: { ...f.system.hermes, version: null },
        bridge: { ...f.system.bridge, lastSeenAt: null },
      },
    ],
  ] as const
  for (const [schema, value] of cases) {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value)
  }
  const { activity, ...missingActivity } = f.agent
  expect(activity).toBeTypeOf('string')
  expect(AgentSummarySchema.safeParse(missingActivity).success).toBe(false)
})

test.each(['you', null])('accepts task activity by %s', (agentId) => {
  expect(TaskActivitySchema.parse({ ...f.activity, agentId }).agentId).toBe(agentId)
})

test('accepts human message authors', () => {
  const value = { ...f.message, author: { kind: 'you' } }
  expect(MessageSchema.parse(value)).toEqual(value)
})

test.each([
  {
    surface: 'editor',
    editor: { path: 'src/types.ts', diff: '@@ -1 +1 @@\n-old\n+new', language: null },
  },
  { surface: 'browser', browser: { url: 'https://example.test', title: null, imageUrl: null } },
  { surface: 'terminal', terminal: f.watch.terminal },
])('accepts the payload for Watch surface $surface', (fields) => {
  const value = {
    seq: 1,
    at: f.at,
    agentId: 'designer',
    runId: null,
    caption: 'Reviewing the output',
    ...fields,
  }
  expect(WatchFrameSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value)
})

test.each(['terminal', 'editor', 'browser'])('rejects a missing %s Watch payload', (surface) => {
  const frame = {
    ...f.watch,
    surface,
    terminal: surface === 'terminal' ? undefined : f.watch.terminal,
  }
  expect(WatchFrameSchema.safeParse(frame).success).toBe(false)
})

test('caps terminal output at 64 KiB of UTF-8', () => {
  for (const output of [
    'x'.repeat(65536),
    'é'.repeat(32768),
    '€'.repeat(21845) + 'x',
    '🟢'.repeat(16384),
    '\ud800'.repeat(21845) + 'x',
  ]) {
    expect(
      WatchFrameSchema.safeParse({ ...f.watch, terminal: { ...f.watch.terminal, output } }).success,
    ).toBe(true)
    expect(
      WatchFrameSchema.safeParse({
        ...f.watch,
        terminal: { ...f.watch.terminal, output: output + 'x' },
      }).success,
    ).toBe(false)
  }
})

const integerCases = [
  ['Room.unread', RoomSchema, (unread: number) => ({ ...f.room, unread })],
  [
    'MessagePart.added',
    MessagePartSchema,
    (added: number) => ({ kind: 'file', path: 'src/types.ts', added, removed: 0 }),
  ],
  [
    'MessagePart.removed',
    MessagePartSchema,
    (removed: number) => ({ kind: 'file', path: 'src/types.ts', added: 0, removed }),
  ],
  [
    'RunSummary.tokens.input',
    RunSummarySchema,
    (input: number) => ({ ...f.run, tokens: { input, output: 0 } }),
  ],
  [
    'RunSummary.tokens.output',
    RunSummarySchema,
    (output: number) => ({ ...f.run, tokens: { input: 0, output } }),
  ],
  [
    'SystemStatus.bridge.producers',
    SystemStatusSchema,
    (producers: number) => ({ ...f.system, bridge: { ...f.system.bridge, producers } }),
  ],
  [
    'TaskSummary.elapsedSec',
    TaskSummarySchema,
    (elapsedSec: number) => ({ ...f.task, elapsedSec }),
  ],
] as const

describe.each(integerCases)('%s', (_name, schema, fixture) => {
  test.each([0, 1])('accepts non-negative integer %s', (value) => {
    expect(schema.parse(fixture(value))).toEqual(fixture(value))
  })
  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer %s', (value) => {
    expect(schema.safeParse(fixture(value)).success).toBe(false)
  })
})

test.each([0, 0.01, null])('accepts non-negative or null cost %s', (costUsd) => {
  expect(RunSummarySchema.parse({ ...f.run, costUsd }).costUsd).toBe(costUsd)
})

test('rejects negative cost', () => {
  expect(RunSummarySchema.safeParse({ ...f.run, costUsd: -0.01 }).success).toBe(false)
})
