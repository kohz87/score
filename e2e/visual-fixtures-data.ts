import { readFileSync } from 'node:fs'
import { MessagePageSchema, SystemStatusSchema } from '../packages/contract/src/index.ts'
import { fixtureNow, nowFixture } from './now-fixture.ts'

export const minutesAgo = (minutes: number) =>
  new Date(Date.parse(fixtureNow) - minutes * 60_000).toISOString()

// Recorded with Fastify inject(), FakeScheduler at 75 seconds, fake mode and a throwaway DB.
// Freezing every REST read and the stream isolates screenshots from other parallel e2e mutations.
export const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/visual.json', import.meta.url), 'utf8'),
) as Record<string, unknown>
export const system = SystemStatusSchema.parse(recorded['/api/system'])
// A formatted reply (PLAN 5.25): Markdown, a code block, a thinking card and tool cards, newest in the room.
export const roomMessages = MessagePageSchema.parse(
  recorded['/api/rooms/room-activity-feed/messages?limit=50'],
)
export const briefVersion = (anchorId: string, replacedBy: string, number: number) => ({
  id: `version-${anchorId}`,
  roomId: 'room-activity-feed',
  anchorId,
  anchorCreatedAt: minutesAgo(30 - number),
  mode: 'edit' as const,
  replacedBy,
  number,
  count: 3,
  hiddenCount: 1,
  rewound: [],
  skipped: [],
  createdAt: minutesAgo(29 - number),
})
// The second wording of the brief: shown read-only when version 2 of 3 is viewed.
export const briefDraft = {
  ...roomMessages.items.find((item) => item.id === 'message-brief-0')!,
  id: 'visual-brief-v2',
  parts: [{ kind: 'text' as const, text: 'Add pagination to the activity feed.' }],
}
export const formatted = {
  id: 'visual-formatted',
  roomId: 'room-activity-feed',
  author: { kind: 'agent' as const, agentId: 'builder' },
  to: [],
  parts: [
    { kind: 'thinking' as const, text: 'Page size first, then the cursor.' },
    {
      kind: 'tool' as const,
      tool: 'terminal',
      args: 'pnpm test',
      result: '3 checks passed',
      status: 'ok' as const,
    },
    {
      kind: 'tool' as const,
      tool: 'edit_file',
      args: '{"path":"src/activity-feed.ts"}',
      result: null,
      status: 'error' as const,
    },
    {
      kind: 'text' as const,
      text: '## Pagination\n\nI added a **page size** and kept the newest items first:\n\n```ts\nconst pageSize = 25 // items per page\n```\n\n- the cursor is opaque\n- see [the notes](https://example.com)',
    },
  ],
  createdAt: '2099-01-01T00:00:00.000Z',
  streaming: false,
  refs: [],
}
// 5.29: a month of runs and spend, and a cache hit rate, so the Reports extras are in the pictures.
export const recordedReport = recorded['/api/reports?range=7d'] as {
  totals: object
  byAgent: object[]
}
export const extras = {
  totals: { ...recordedReport.totals, cacheHitRate: 0.64 },
  byAgent: recordedReport.byAgent.map((row, index) => ({
    ...row,
    cacheHitRate: index % 2 === 0 ? 0.71 - index * 0.05 : null,
  })),
  trend: Array.from({ length: 30 }, (_, day) => ({
    date: new Date(Date.parse(fixtureNow) - (29 - day) * 86_400_000).toISOString().slice(0, 10),
    runs: 2 + ((day * 7) % 9),
    spendUsd: day < 6 ? null : Math.round((1.4 + ((day * 5) % 7) * 0.6) * 100) / 100,
  })),
}
export const focusApproval = nowFixture('room-activity-feed').focusApproval
// 7.4c: a week of marks (the page asks for the 7 days up to the fixed "today").
const journeyDay = (back: number, hour: number) =>
  new Date(Date.parse(fixtureNow) - back * 86_400_000 - (21 - hour) * 3_600_000).toISOString()
export const journeyFixture = {
  from: new Date(Date.parse(fixtureNow) - 6 * 86_400_000).toISOString().slice(0, 10),
  to: fixtureNow.slice(0, 10),
  truncated: false,
  agents: [
    {
      id: 'lead',
      events: [
        { at: journeyDay(0, 10), kind: 'task_done', label: 'Plan the activity feed', ref: 't1' },
        { at: journeyDay(2, 15), kind: 'memory_changed', label: 'Memory file changed', ref: null },
        {
          at: journeyDay(5, 11),
          kind: 'note_written',
          label: 'Launch plan',
          ref: 'launch-plan.md',
        },
      ],
    },
    {
      id: 'builder',
      events: [
        { at: journeyDay(0, 17), kind: 'task_done', label: 'Add pagination', ref: 't2' },
        { at: journeyDay(1, 12), kind: 'task_done', label: 'Fix the empty state', ref: 't3' },
        { at: journeyDay(1, 16), kind: 'skill_changed', label: 'code-review', ref: null },
        { at: journeyDay(3, 14), kind: 'task_done', label: 'Speed up search', ref: 't4' },
        { at: journeyDay(4, 10), kind: 'note_written', label: 'Release retro', ref: 'retro.md' },
        { at: journeyDay(6, 13), kind: 'memory_changed', label: 'Memory file changed', ref: null },
      ],
    },
    {
      id: 'reviewer',
      events: [
        { at: journeyDay(2, 11), kind: 'task_done', label: 'Review the feed', ref: 't5' },
        { at: journeyDay(4, 15), kind: 'skill_changed', label: 'triage', ref: null },
      ],
    },
    {
      id: 'designer',
      events: [
        { at: journeyDay(3, 12), kind: 'note_written', label: 'Design tokens', ref: 'tokens.md' },
      ],
    },
  ],
}
// What 9.1's server answers when nothing but the built-in themes exists (API-CONTRACT § 16).
export const builtinTheme = (id: string, name: string) => ({
  id,
  name,
  version: '1.0.0',
  author: null,
  description: null,
  source: 'builtin',
  updatedAt: '2026-10-17T00:00:00.000Z',
  hasCss: false,
})
