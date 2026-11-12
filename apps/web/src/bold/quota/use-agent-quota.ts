import type { AgentSummary, CodingQuota } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useReducer } from 'react'
import { useOptionalStream } from '../../data/query-client.ts'
import { codingAgentsQuery, useCodingAgentState } from '../../routes/team/coding-agent-queries.ts'
import { codingAgentQuotaPath, useCodingQuota } from '../../routes/team/QuotaMeters.tsx'
import { buildQuotaView, type AgentQuotaView, type QuotaFloor } from './quota-model.ts'

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
// A browser timer longer than this fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * The reading moves when one of this agent's runs ends (in any room), and the floor is part of the agent's record, which
 * `agent.updated` announces: both refresh from the events the shell already receives.
 */
function useQuotaRefresh(agentId: string, enabled: boolean): void {
  const stream = useOptionalStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!stream || !enabled) return
    return stream.subscribe((event) => {
      if (
        event.type === 'run.updated' &&
        event.data.agentId === agentId &&
        TERMINAL_RUN.has(event.data.status)
      )
        void queryClient.invalidateQueries({ queryKey: ['coding', 'quota', agentId] })
      else if (event.type === 'agent.updated' && event.data.id === agentId)
        void queryClient.invalidateQueries({ queryKey: codingAgentsQuery.queryKey })
    })
  }, [agentId, enabled, queryClient, stream])
}

/** Re-renders at the next reset still ahead, so a below-floor warning ends when its window does (as the server's guard). */
function useResetClock(quota: CodingQuota | null | undefined): void {
  const [ticks, tick] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    const now = Date.now()
    let next: number | null = null
    for (const window of quota?.windows ?? []) {
      const reset = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt)
      if (Number.isFinite(reset) && reset > now && (next === null || reset < next)) next = reset
    }
    if (next === null) return
    const timer = setTimeout(tick, Math.min(next - now + 50, MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [quota, ticks])
}

/**
 * One coding agent's quota as the chat shows it (pill and Chat info share it): the cached reading, refreshed at most once
 * a minute while open, the agent's own floor and model, and the tone/phase derived from them.
 */
export function useAgentQuota(
  agent: AgentSummary,
  options: { refresh?: boolean } = {},
): AgentQuotaView {
  const query = useCodingQuota(codingAgentQuotaPath(agent.id), [agent.id], {
    refetchInterval: 60_000,
  })
  const coding = useCodingAgentState(agent.id)
  useQuotaRefresh(agent.id, options.refresh ?? false)
  useResetClock(query.isError ? undefined : query.data)
  let floor: QuotaFloor = { kind: 'loading' }
  if (coding.agent) floor = { kind: 'known', percent: coding.agent.quotaFloorPercent }
  else if (coding.status !== 'loading') floor = { kind: 'unreadable' }
  return buildQuotaView({
    quota: query.data,
    failed: query.isError,
    pending: query.isPending,
    floor,
    model: coding.agent?.model ?? null,
    now: new Date(),
  })
}
