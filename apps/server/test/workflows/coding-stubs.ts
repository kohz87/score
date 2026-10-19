import type { AgentDetail } from '@score/contract'
import type { CodingWorkerFacts } from '../../src/domain/orchestration/supported-agents.ts'
import type { CodingRuntime } from '../../src/runtimes/coding/service.ts'

// 7.7c: a coding team and host facts for tests that exercise the workflow doors (Validate, save, versions, start) without
// a coding runtime. The real runtime is covered by the worker-harness tests.

export const CODING_TEAM = {
  cc: { runtime: 'claude-code', permission: 'workspace-write' },
  cx: { runtime: 'codex', permission: 'read-only' },
  ag: { runtime: 'antigravity', permission: 'workspace-write' },
  wide: { runtime: 'codex', permission: 'full' },
} as const

export const stubFacts = (unitHost = true): CodingWorkerFacts => ({
  unitHost: () => unitHost,
  agent: (id) =>
    // Antigravity is a coding agent of the team, but never a worker.
    id in CODING_TEAM &&
    ['claude-code', 'codex'].includes(CODING_TEAM[id as keyof typeof CODING_TEAM].runtime)
      ? CODING_TEAM[id as keyof typeof CODING_TEAM]
      : undefined,
  report: () => Promise.reject(new Error('not used by validation')),
  checkPolicy: () => {
    throw new Error('not used by validation')
  },
})

const detail = (id: string, runtime: string): AgentDetail =>
  ({
    id,
    name: id,
    role: 'Coding agent',
    style: { color: '#19C39A', shape: 'hexagon' },
    status: 'idle',
    activity: null,
    model: { id: 'default', label: 'default' },
    served: true,
    runtime,
    runtimeNote: runtime,
  }) as unknown as AgentDetail

export const stubRuntime = (): CodingRuntime =>
  ({
    isCodingAgent: (id: string) => id in CODING_TEAM,
    details: async () =>
      Object.entries(CODING_TEAM).map(([id, value]) => detail(id, value.runtime)),
    agents: () => [],
  }) as unknown as CodingRuntime
