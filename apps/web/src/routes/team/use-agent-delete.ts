import {
  AgentOperationSchema,
  AgentPreviewSchema,
  type AgentOperation,
  type AgentPreview,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useProfileOperation } from './ProfileOperation.tsx'

/** The Hermes agent delete flow (contract §8): preview, typed-name confirm, then the operation's progress. */
export function useAgentDelete(agentId: string, resumeOperationId: string | null = null) {
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
          body: JSON.stringify({ typedName, previewHash: preview!.hash }),
        }),
      ),
    onSuccess: setAccepted,
    onError: () => {
      setPreview(null)
      setTypedName('')
    },
  })
  function cancel() {
    setPreview(null)
    setTypedName('')
  }
  return { typedName, setTypedName, preview, review, remove, status, operation, cancel }
}
