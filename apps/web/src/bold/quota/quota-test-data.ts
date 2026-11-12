import type {
  AgentSummary,
  CodingAgent,
  CodingQuota,
  CodingQuotaWindow,
  CodingRuntime,
} from '@score/contract'

export const NOW = new Date('2026-10-16T05:35:00.000Z')
export const SEEN_AT = '2026-10-16T05:05:00.000Z'

export function codingSummaryAgent(
  runtime: CodingRuntime = 'claude-code',
  overrides: Partial<AgentSummary> = {},
): AgentSummary {
  return {
    id: 'builder',
    name: 'Builder',
    role: 'Builds features',
    style: { color: '#6B4EFF', shape: 'hexagon' },
    status: 'idle',
    activity: null,
    model: { id: 'claude-sonnet-5-5', label: 'Claude Sonnet' },
    served: true,
    runtime,
    ...overrides,
  }
}

export function codingRecord(overrides: Partial<CodingAgent> = {}): CodingAgent {
  return {
    id: 'builder',
    name: 'Builder',
    role: 'Builds features',
    instructions: '',
    instructionsEtag: 'etag-1',
    runtime: 'claude-code',
    workspace: '/work/builder',
    permission: 'workspace-write',
    model: 'claude-sonnet-5-5',
    effort: null,
    advisorModel: null,
    style: { color: '#6B4EFF', shape: 'hexagon' },
    quota: 'Claude Code · uses your Claude plan quota',
    quotaFloorPercent: 10,
    cli: { state: 'ready', version: '1.0.0', testedVersions: ['1.0.0'], problem: null },
    heldGroups: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

export function codingQuota(
  windows: CodingQuotaWindow[] = [
    { name: '5 hours', group: null, usedPercent: 38, resetsAt: '2026-10-16T05:40:00.000Z' },
    { name: 'week', group: null, usedPercent: 20, resetsAt: '2026-10-21T05:40:00.000Z' },
  ],
  overrides: Partial<CodingQuota> = {},
): CodingQuota {
  return { runtime: 'claude-code', seenAt: SEEN_AT, source: 'turn', windows, ...overrides }
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The week window's reset day as the browser's locale writes it ("21 Oct" or "Oct 21"). */
export const WEEK_DAY = new Date('2026-10-21T05:40:00.000Z').toLocaleDateString(undefined, {
  day: 'numeric',
  month: 'short',
})
