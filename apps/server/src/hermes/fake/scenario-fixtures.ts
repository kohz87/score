import type { AgentSummary, RunSummary } from '@score/contract'
import type { HermesPort } from '../port.ts'

export function exampleAgents(): AgentSummary[] {
  return [
    { id: 'lead', role: 'Leads the team', color: '#6B4EFF', shape: 'circle-dot' },
    { id: 'builder', role: 'Builds features', color: '#19C39A', shape: 'triangle' },
    { id: 'reviewer', role: 'Reviews changes', color: '#FFB61E', shape: 'diamond' },
    { id: 'designer', role: 'Designs interfaces', color: '#FF6B8A', shape: 'square' },
  ].map(({ id, role, color, shape }) => ({
    id,
    name: id,
    role,
    style: { color, shape: shape as AgentSummary['style']['shape'] },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  }))
}

export function fakeStatus(): ReturnType<HermesPort['status']> {
  return {
    hermes: {
      version: null,
      reachable: true,
      apiServer: true,
      capabilities: [],
      servedProfiles: exampleAgents().map((agent) => agent.id),
    },
    bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
    compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
    agentIsolation: 'same_user',
    degraded: [],
  }
}

export function exampleRun(agentId: string, id: string, at: string): RunSummary {
  return {
    id,
    agentId,
    origin: 'score',
    status: 'queued',
    startedAt: at,
    endedAt: null,
    model: 'fake-model',
    toolsUsed: [],
    tokens: null,
    costUsd: null,
    refs: [],
    gaps: [],
  }
}

export const scenarioDuration = 180000
