import type { AgentSummary } from '@score/contract'
import { skipToken, useQuery, type QueryKey } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import type { Notice, Snapshot } from './composer-types.ts'
import { messagesQuery } from './queries.ts'

export function useComposerRoom({
  roomId,
  messagesKey,
  agents,
  leadAgentId,
  to,
  setNotice,
}: {
  roomId: string
  messagesKey?: QueryKey
  agents: AgentSummary[]
  leadAgentId: string | null
  to: string[]
  setNotice: Dispatch<SetStateAction<Notice | null>>
}) {
  // The room's messages are kept live by the stream; a reply being written turns Send into Stop (PLAN 5.25).
  const roomMessagesKey: QueryKey = messagesKey ?? messagesQuery(roomId).key
  const thread = useQuery<Snapshot | undefined>({
    queryKey: roomMessagesKey,
    queryFn: skipToken,
  })
  const items = thread.data?.data.items
  const writing = useMemo(
    () => (items ?? []).filter((item) => item.streaming && item.author.kind === 'agent'),
    [items],
  )
  const [stopping, setStopping] = useState(false)
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(stopTimer.current), [])
  async function stopReplies() {
    setStopping(true)
    try {
      await Promise.all(
        writing.map((item) =>
          apiFetch(
            `rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(item.id)}/stop`,
            { method: 'POST', headers: { 'Idempotency-Key': newId() }, body: '{}' },
          ),
        ),
      )
    } catch {
      setNotice({ kind: 'error', text: 'Couldn’t stop the reply. It may have just finished.' })
    } finally {
      // The reply's own completion event ends the Stop state; this only guards a response that never comes.
      stopTimer.current = setTimeout(() => setStopping(false), 3000)
    }
  }

  // The agent the meter and /usage speak about: the first "To" chip, else whoever answered last, else the lead.
  const lastReplier = (items ?? []).find((item) => item.author.kind === 'agent')?.author
  const subject =
    to[0] ??
    (lastReplier?.kind === 'agent' ? lastReplier.agentId : null) ??
    (leadAgentId && agents.some((agent) => agent.id === leadAgentId) ? leadAgentId : null)
  const subjectAgent = agents.find((agent) => agent.id === subject)
  const finishedReplies = (items ?? []).filter((item) => !item.streaming).length
  // One ring per addressed agent (PLAN 5.36), or the subject when nobody is addressed.
  const meterAgents = [...new Set(to.length ? to : subject ? [subject] : [])].slice(0, 4)
  const [compactSignal, setCompactSignal] = useState(0)
  const [compactSubject, setCompactSubject] = useState<string | null>(null)

  return {
    roomMessagesKey,
    writing,
    stopping,
    stopReplies,
    subject,
    subjectAgent,
    finishedReplies,
    meterAgents,
    compactSignal,
    setCompactSignal,
    compactSubject,
    setCompactSubject,
  }
}
