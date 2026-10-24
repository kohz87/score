import {
  AgentOperationSchema,
  AgentPreviewSchema,
  type AgentCreateInput,
  type AgentOperation,
  type AgentPreview,
  type AgentStyle,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useProfileOperation } from './ProfileOperation.tsx'

export const defaultAgentStyle: AgentStyle = { color: '#19C39A', shape: 'triangle' }

export function emptyAgentInput(style: AgentStyle = defaultAgentStyle): AgentCreateInput {
  return {
    id: '',
    name: '',
    role: '',
    model: '',
    style: { color: style.color, shape: style.shape, ...(style.look ? { look: style.look } : {}) },
  }
}

/**
 * The create half of Add agent: the same preview hash, inheritance confirmation, idempotency receipt and durable
 * operation polling for the classic and bold dialogs (contract § Team).
 */
export function useAgentCreateDraft(initialInput?: AgentCreateInput) {
  const [initial] = useState(() => initialInput ?? emptyAgentInput())
  const [input, setInput] = useState<AgentCreateInput>(initial)
  const [preview, setPreview] = useState<AgentPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [accepted, setAccepted] = useState<AgentOperation | null>(null)
  const status = useProfileOperation(accepted?.id ?? null)
  const operation = status.data ?? accepted

  const review = useMutation({
    mutationFn: async () =>
      AgentPreviewSchema.parse(
        await apiFetch('agents/preview', {
          method: 'POST',
          body: JSON.stringify({ kind: 'create', ...input }),
        }),
      ),
    onSuccess: setPreview,
  })
  const create = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch('agents', {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({
            ...input,
            previewHash: preview!.hash,
            confirmInheritance: confirmed,
          }),
        }),
      ),
    onSuccess: setAccepted,
    onError: () => {
      setPreview(null)
      setConfirmed(false)
    },
  })
  const another = () => {
    setInput(initial)
    setPreview(null)
    setConfirmed(false)
    setAccepted(null)
    review.reset()
    create.reset()
  }
  const change = (patch: Partial<AgentCreateInput>) => {
    setInput((current) => {
      const next = { ...current, ...patch }
      if (next.provider === undefined) delete next.provider
      return next
    })
    setPreview(null)
    setConfirmed(false)
    review.reset()
    create.reset()
  }

  return {
    input,
    preview,
    confirmed,
    accepted,
    operation,
    status,
    review,
    create,
    change,
    another,
    setConfirmed,
  }
}

export type AgentCreateDraft = ReturnType<typeof useAgentCreateDraft>
