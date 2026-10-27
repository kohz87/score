import {
  AgentOperationSchema,
  AgentPreviewSchema,
  type AgentOperation,
  type AgentPreview,
} from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useProfileOperation } from './ProfileOperation.tsx'

/**
 * Whether the typed confirmation names the agent. Profile names are lowercase, and a phone or tablet keyboard capitalises
 * the first letter, so case and stray spaces don't count (3.7.1); the request then carries the exact name.
 */
export function typedMatches(typed: string, agentId: string): boolean {
  return typed.trim().toLowerCase() === agentId.toLowerCase()
}

/** The Hermes agent delete flow (contract §8): preview, typed-name confirm, then the operation's progress. */
export function useAgentDelete(
  agentId: string,
  resumeOperationId: string | null = null,
  /** After a refused DELETE the preview it used is gone: load a fresh one (the bold panel); the classic card asks again. */
  reloadPreviewOnRefusal = false,
) {
  const client = useQueryClient()
  const [typedName, setTypedName] = useState('')
  const [preview, setPreview] = useState<AgentPreview | null>(null)
  const [accepted, setAccepted] = useState<AgentOperation | null>(null)
  const status = useProfileOperation(accepted?.id ?? resumeOperationId)
  const operation = status.data ?? accepted
  const review = useMutation({
    mutationFn: async () =>
      AgentPreviewSchema.parse(
        await apiFetch('agents/preview', {
          method: 'POST',
          body: JSON.stringify({ kind: 'delete', agentId }),
        }),
      ),
    onSuccess: (value) => {
      setPreview(value)
      setTypedName('')
    },
  })
  const remove = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({
            typedName: typedMatches(typedName, agentId) ? agentId : typedName,
            previewHash: preview!.hash,
          }),
        }),
      ),
    onSuccess: (value) => {
      setAccepted(value)
      void client.invalidateQueries({ queryKey: ['team'] })
      void client.invalidateQueries({ queryKey: ['chat', 'agents'] })
    },
    onError: () => {
      setPreview(null)
      setTypedName('')
      if (reloadPreviewOnRefusal) review.mutate()
    },
  })
  function cancel() {
    setPreview(null)
    setTypedName('')
  }
  return { typedName, setTypedName, preview, review, remove, status, operation, cancel }
}
