import {
  CodingAgentSchema,
  type AgentStyle,
  type CodingAgent,
  type CodingPermission,
  type CodingRuntime,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { readsOutsideWorkspace, shortPermission } from './coding-agent-permissions.ts'
import { codingRuntimesQuery } from './coding-agent-queries.ts'

/** The coding-agent create fields, validation, consent and mutation, shared by the classic form and the bold dialog. */
export function useCodingAgentDraft(
  onAdded: (agent: CodingAgent, detail: string) => void,
  initialStyle: AgentStyle = { color: '#6B4EFF', shape: 'hexagon' },
) {
  const queryClient = useQueryClient()
  const runtimes = useQuery(codingRuntimesQuery)
  const [runtime, setRuntime] = useState<CodingRuntime>('claude-code')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [model, setModel] = useState('')
  const [permission, setPermission] = useState<CodingPermission>('workspace-write')
  const [password, setPassword] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [style, setStyle] = useState<AgentStyle>(initialStyle)
  const info = runtimes.data?.find((item) => item.runtime === runtime)
  const usable = info?.state === 'ready' || info?.state === 'untested_version'
  const unverified = info?.unverifiedPermissions ?? []
  const needsAck = readsOutsideWorkspace(runtime, permission)
  const chooseRuntime = (next: CodingRuntime) => {
    setRuntime(next)
    // A model name of one CLI means nothing to another.
    setModel('')
    // A level that is not verified for the new CLI is never kept selected.
    const blocked =
      runtimes.data?.find((item) => item.runtime === next)?.unverifiedPermissions ?? []
    if (blocked.includes(permission))
      setPermission(
        (['read-only', 'workspace-write', 'full'] as const).find(
          (level) => !blocked.includes(level),
        ) ?? permission,
      )
  }
  const create = useMutation({
    mutationFn: async () =>
      CodingAgentSchema.parse(
        await apiFetch('coding-agents', {
          method: 'POST',
          body: JSON.stringify({
            id,
            name: name || id,
            ...(role.trim() ? { role: role.trim() } : {}),
            runtime,
            permission,
            style,
            ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(permission === 'full' ? { password } : {}),
            ...(needsAck ? { acknowledgeReads: true } : {}),
          }),
        }),
      ),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: ['coding'] })
      void queryClient.invalidateQueries({ queryKey: ['team'] })
      onAdded(
        agent,
        [
          'Coding agent',
          info?.label ?? runtime,
          agent.model ?? 'the CLI’s default model',
          shortPermission[agent.permission],
        ].join(' · '),
      )
    },
  })
  return {
    runtimes,
    runtime,
    chooseRuntime,
    id,
    setId,
    name,
    setName,
    role,
    setRole,
    workspace,
    setWorkspace,
    model,
    setModel,
    permission,
    setPermission,
    password,
    setPassword,
    acknowledged,
    setAcknowledged,
    style,
    setStyle,
    info,
    usable,
    unverified,
    needsAck,
    create,
  }
}
