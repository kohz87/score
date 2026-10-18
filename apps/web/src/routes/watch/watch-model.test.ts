import type { Approval, WatchFrame, WatchMarker } from '@score/contract'
import { expect, test } from 'vitest'
import {
  activityItems,
  addMarker,
  backFrom,
  groupActivity,
  markerPositions,
  nearestMarker,
  parseDiff,
  resumeCommand,
  stageAt,
  terminalHistory,
  upsertFrame,
} from './watch-model.ts'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8, 21, 0, seconds)).toISOString()
const terminal = (seq: number, seconds: number, status = 'ok'): WatchFrame => ({
  seq,
  at: at(seconds),
  agentId: 'builder',
  runId: null,
  surface: 'terminal',
  terminal: {
    cwd: '/srv',
    command: `step ${seq}`,
    output: '',
    status: status as 'ok',
  },
  caption: `Ran step ${seq}`,
})
const editor = (seq: number, seconds: number): WatchFrame => ({
  seq,
  at: at(seconds),
  agentId: 'builder',
  runId: null,
  surface: 'editor',
  editor: { path: 'a.ts', diff: '+x', language: null },
  caption: `Edited a.ts ${seq}`,
})

test('a re-emitted frame replaces the one with the same seq', () => {
  const frames = [terminal(1, 0, 'running'), editor(2, 5)]
  const next = upsertFrame(frames, terminal(1, 0, 'ok'))
  expect(next).toHaveLength(2)
  expect(next[0]?.terminal?.status).toBe('ok')
  expect(upsertFrame(next, terminal(3, 9)).map((frame) => frame.seq)).toEqual([1, 2, 3])
})

test('an anchored window keeps its oldest frames when live frames push it past the cap', () => {
  const frames = Array.from({ length: 500 }, (_, index) => editor(index + 1, index))
  expect(upsertFrame(frames, editor(501, 501), 'newest')[0]?.seq).toBe(2)
  expect(upsertFrame(frames, editor(501, 501), 'oldest')[0]?.seq).toBe(1)
})

test('a repeated frame keeps one marker, and each ask at a new time adds one', () => {
  const markers: WatchMarker[] = [{ seq: 1, at: at(0), kind: 'command' }]
  expect(addMarker(markers, { seq: 1, at: at(0), kind: 'command' })).toBe(markers)
  const asked = addMarker(markers, { seq: 1, at: at(4), kind: 'asked' })
  expect(asked.map((marker) => marker.kind)).toEqual(['command', 'asked'])
  expect(addMarker(asked, { seq: 1, at: at(4), kind: 'asked' })).toBe(asked)
  expect(addMarker(asked, { seq: 1, at: at(9), kind: 'asked' })).toHaveLength(3)
})

test('the stage at a moment shows the latest frame of each surface up to it', () => {
  const frames = [terminal(1, 0), editor(2, 5), terminal(3, 9)]
  const live = stageAt(frames, null)
  expect(live.front?.seq).toBe(3)
  expect(live.bySurface.editor?.seq).toBe(2)
  const early = stageAt(frames, 2)
  expect(early.front?.seq).toBe(2)
  expect(early.bySurface.terminal?.seq).toBe(1)
  expect(stageAt(frames, 0).front).toBeNull()
  expect(terminalHistory(frames, 3).map((frame) => frame.seq)).toEqual([1])
})

test('markers are placed by time and never stack exactly', () => {
  const markers: WatchMarker[] = [
    { seq: 1, at: at(0), kind: 'command' },
    { seq: 2, at: at(50), kind: 'file' },
    { seq: 2, at: at(50), kind: 'asked' },
    { seq: 3, at: at(100), kind: 'browser' },
  ]
  const positions = markerPositions(markers)
  expect(positions[0]).toBe(4)
  expect(positions.at(-1)).toBe(97)
  expect(positions[2]! - positions[1]!).toBeGreaterThan(0)
  expect(markerPositions([])).toEqual([])
  expect(markerPositions([markers[0]!])).toEqual([97])
  expect(nearestMarker(positions, 5)).toBe(0)
  expect(nearestMarker(positions, 99)).toBe(3)
  expect(nearestMarker([], 50)).toBeNull()
})

test('back 30 seconds lands on the latest marker at or before the target', () => {
  const markers: WatchMarker[] = [0, 10, 40, 50, 70].map((seconds, index) => ({
    seq: index + 1,
    at: at(seconds),
    kind: 'command',
  }))
  // Live is the last marker (70s); 40s is the target.
  expect(backFrom(markers, null)).toBe(2)
  expect(backFrom(markers, 3)).toBe(1)
  expect(backFrom(markers, 0)).toBe(0)
  expect(backFrom([], null)).toBeNull()
})

test('a unified diff is numbered from its hunk headers', () => {
  const lines = parseDiff('--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+more\n')
  expect(lines.map((line) => [line.kind, line.number, line.text])).toEqual([
    ['hunk', null, '@@ -3,2 +3,3 @@'],
    ['ctx', 3, 'keep'],
    ['del', null, 'old'],
    ['add', 4, 'new'],
    ['add', 5, 'more'],
  ])
})

test('the activity list is newest first and includes questions put to the person', () => {
  const approval = {
    id: 'a1',
    title: 'Install a package?',
    createdAt: at(6),
  } as Approval
  const items = activityItems([terminal(1, 0), editor(2, 5), terminal(3, 9)], [approval])
  expect(items.map((item) => item.key)).toEqual(['frame-3', 'approval-a1', 'frame-2', 'frame-1'])
  expect(items[1]).toMatchObject({ kind: 'asked', seq: 2 })
})

test('open in terminal resumes the agent session through its profile', () => {
  expect(resumeCommand('builder', 'sess-1')).toBe('hermes -p builder --resume sess-1')
  expect(resumeCommand('builder', null)).toBe('hermes -p builder --continue')
  expect(resumeCommand('my agent', "it's")).toBe("hermes -p 'my agent' --resume 'it'\\''s'")
})

test('a sub-agent’s steps are grouped, without the caption prefix; frames without it stay flat', () => {
  const sub = (seq: number, seconds: number): WatchFrame => ({
    ...terminal(seq, seconds),
    caption: `Sub-agent · Ran step ${seq}`,
  })
  const items = activityItems([terminal(1, 0), sub(2, 1), sub(3, 2), terminal(4, 3)], [])
  expect(items.map((item) => item.text)).toEqual([
    'Ran step 4',
    'Ran step 3',
    'Ran step 2',
    'Ran step 1',
  ])
  const entries = groupActivity(items)
  expect(entries.map((entry) => entry.type)).toEqual(['item', 'sub-agent', 'item'])
  const group = entries[1]!
  expect(group.type === 'sub-agent' && group.items.map((item) => item.seq)).toEqual([3, 2])
  expect(
    groupActivity(activityItems([terminal(1, 0), terminal(2, 1)], [])).map((e) => e.type),
  ).toEqual(['item', 'item'])
})
