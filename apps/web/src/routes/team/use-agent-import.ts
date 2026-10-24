import {
  AgentOperationSchema,
  ImportInspectionSchema,
  PROFILE_IMPORT_MAX_BYTES,
  type AgentOperation,
  type AgentStyle,
  type AgentSummary,
  type ImportInspection,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, apiUpload, type UploadProgress as Progress } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useProfileOperation } from './ProfileOperation.tsx'
import { defaultAgentStyle } from './use-agent-create.ts'

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Archive inspection, upload progress, credential consent and the durable import operation shared by the classic and
 * bold Add agent dialogs. `close` is called after the stored upload has been discarded.
 */
export function useAgentImport(
  agents: AgentSummary[],
  close: () => void,
  initialStyle = defaultAgentStyle,
) {
  const [inspection, setInspection] = useState<ImportInspection | null>(null)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [style, setStyle] = useState<AgentStyle>(initialStyle)
  const [credentialsOk, setCredentialsOk] = useState(false)
  const [accepted, setAccepted] = useState<AgentOperation | null>(null)
  const status = useProfileOperation(accepted?.id ?? null)
  const operation = status.data ?? accepted
  const [sending, setSending] = useState<{ name: string; progress: Progress } | null>(null)
  const latest = useRef({ inspection, accepted })
  const disposed = useRef(false)
  useEffect(() => {
    latest.current = { inspection, accepted }
  }, [inspection, accepted])

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > PROFILE_IMPORT_MAX_BYTES)
        throw new Error('The archive is larger than 200 MB.')
      setSending({ name: file.name, progress: { loaded: 0, total: file.size } })
      return ImportInspectionSchema.parse(
        await apiUpload(
          'agents/imports',
          file,
          (progress) => setSending({ name: file.name, progress }),
          {},
          'POST',
        ),
      )
    },
    onSettled: () => setSending(null),
    onSuccess: (result) => {
      setInspection(result)
      setId(result.suggestedId ?? '')
      setName(result.suggestedId ?? '')
      setRole(result.description ?? '')
    },
  })
  const start = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch('agents/import', {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({
            uploadId: inspection!.uploadId,
            id,
            name: name || id,
            role,
            style,
            ...(inspection!.credentialFiles.length ? { confirmCredentials: credentialsOk } : {}),
          }),
        }),
      ),
    onSuccess: setAccepted,
  })
  const leave = () => {
    if (inspection && !accepted) {
      disposed.current = true
      void apiFetch(`agents/imports/${inspection.uploadId}`, { method: 'DELETE' }).catch(() => {})
    }
    close()
  }
  useEffect(
    () => () => {
      const stored = latest.current
      if (disposed.current || !stored.inspection || stored.accepted) return
      void apiFetch(`agents/imports/${stored.inspection.uploadId}`, { method: 'DELETE' }).catch(
        () => {},
      )
    },
    [],
  )

  const taken = agents.some((agent) => agent.id === id)
  const idValid = ID_PATTERN.test(id) && id !== 'default'
  const needsCredentialOk = Boolean(inspection?.credentialFiles.length) && !credentialsOk
  const blocked = !idValid || taken || !role.trim() || needsCredentialOk || start.isPending

  return {
    inspection,
    id,
    setId,
    name,
    setName,
    role,
    setRole,
    style,
    setStyle,
    credentialsOk,
    setCredentialsOk,
    accepted,
    status,
    operation,
    sending,
    upload,
    start,
    leave,
    taken,
    idValid,
    blocked,
  }
}

export type AgentImportDraft = ReturnType<typeof useAgentImport>
