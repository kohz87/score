import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

const runtime = (name: string, label: string, extra: object = {}) => ({
  runtime: name,
  label,
  state: 'ready',
  version: '1.0.0',
  testedVersions: ['1.0.0'],
  quota: `${label} quota note.`,
  message: null,
  unverifiedPermissions: [],
  warning: null,
  ...extra,
})
export const runtimes = [
  runtime('claude-code', 'Claude Code'),
  runtime('antigravity', 'Antigravity (agy)', {
    unverifiedPermissions: ['full'],
    warning:
      'Antigravity can also browse the web, generate images, schedule work and run sub-agents.',
  }),
]
const quota = {
  quota: {
    runtime: 'antigravity',
    seenAt: '2026-10-11T00:00:00.000Z',
    source: 'usage',
    windows: [
      { name: '5 hours', group: 'Gemini Pro', usedPercent: 18, resetsAt: null },
      { name: 'week', group: 'Gemini Pro', usedPercent: 36, resetsAt: null },
    ],
  },
}
export const personaAgent = (over: object = {}) => ({
  id: 'builder',
  name: 'Builder',
  role: 'Reviews build scripts',
  instructions: '## Style\n\nBe **brief**.',
  instructionsEtag: 'etag-1',
  runtime: 'claude-code',
  workspace: '/w',
  permission: 'workspace-write',
  model: null,
  style: { color: '#6B4EFF', shape: 'hexagon' },
  quota: 'q',
  quotaFloorPercent: 10,
  cli: { state: 'ready', version: '1.0.0', testedVersions: ['1.0.0'], problem: null },
  heldGroups: [],
  createdAt: '2026-10-17T00:00:00.000Z',
  ...over,
})
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
export function installCodingAgentTestSetup() {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response('{"error":{"code":"x","message":"stop here"}}', { status: 400 })
      const body = path.endsWith('/quota') ? quota : { items: runtimes }
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })
}
