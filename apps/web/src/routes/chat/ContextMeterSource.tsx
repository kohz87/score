import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import {
  fetchSessionContext,
  roomSessionId,
  sessionContextQuery,
  type SessionContextState,
} from './room-actions.ts'
import { MeterView } from './ContextMeterView.tsx'
import type { MeterProps } from './context-meter-types.ts'

export function Streamed(props: MeterProps) {
  const sessionId = props.sessionId ?? roomSessionId(props.roomId, props.agentId)
  const definition = useMemo(
    () => sessionContextQuery(props.agentId, sessionId),
    [props.agentId, sessionId],
  )
  const state = useStreamQuery(definition)
  const refetch = useStreamQueryRefetch(definition)
  return <MeterView {...props} data={state.data} refetch={() => void refetch()} />
}

export function Polled(props: MeterProps) {
  const sessionId = props.sessionId ?? roomSessionId(props.roomId, props.agentId)
  const query = useQuery({
    queryKey: ['chat', 'session-context', props.agentId, sessionId],
    queryFn: async (): Promise<SessionContextState> => ({
      context: await fetchSessionContext(props.agentId, sessionId),
      compaction: null,
    }),
    staleTime: 15_000,
    retry: false,
  })
  return <MeterView {...props} data={query.data} refetch={() => void query.refetch()} />
}
