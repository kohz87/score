import { AgentOperationSchema, type AgentOperation } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

const stepLabels: Record<string, string> = {
  create_profile: 'Create profile',
  preserve_key: 'Preserve private key',
  configure_key: 'Connect profile',
  model: 'Set model',
  permissions: 'Apply team rules',
  install_bridge: 'Install bridge',
  enable_bridge: 'Enable bridge',
  verify_ready: 'Verify readiness',
  export: 'Keep private export',
  delete_profile: 'Delete profile',
  purge_identity: 'Reconcile identity',
  retire: 'Retire agent',
}
export function useProfileOperation(id: string | null) {
  return useQuery({
    queryKey: ['team', 'operation', id],
    enabled: Boolean(id),
    queryFn: async ({ signal }) =>
      AgentOperationSchema.parse(await apiFetch(`agents/operations/${id}`, { signal })),
    refetchInterval: (query) =>
      query.state.data?.state === 'running'
        ? 350
        : query.state.data?.state === 'needs_attention' &&
            query.state.data.nextStep === 'verify_ready'
          ? 1500
          : false,
    retry: false,
  })
}
export function ProfileOperation({ operation }: { operation: AgentOperation }) {
  const client = useQueryClient()
  const retry = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch(`agents/operations/${operation.id}/retry`, {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        }),
      ),
    onSuccess: (next) => client.setQueryData(['team', 'operation', operation.id], next),
  })
  return (
    <section className="team-card" aria-live="polite">
      <h2>
        {operation.state === 'needs_attention'
          ? 'Needs attention'
          : operation.state === 'completed'
            ? operation.kind === 'create'
              ? 'Ready'
              : 'Agent removed'
            : operation.kind === 'create'
              ? 'Setting up'
              : 'Deleting agent'}
      </h2>
      <ol className="team-operation-steps">
        {operation.steps.map((step) => (
          <li key={step.name}>
            {stepLabels[step.name]} —{' '}
            {step.state === 'completed'
              ? 'Done'
              : step.state === 'running'
                ? 'In progress'
                : 'Waiting'}
          </li>
        ))}
      </ol>
      {operation.error && <p role="alert">{operation.error}</p>}
      {operation.state === 'needs_attention' && operation.retryable && (
        <button
          type="button"
          className="team-primary"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          {retry.isPending
            ? 'Retrying…'
            : `Retry: ${stepLabels[operation.nextStep ?? ''] ?? 'step'}`}
        </button>
      )}
      {retry.isError && (
        <p role="alert">Score could not retry this step. Check the profile locally.</p>
      )}
      {operation.exportPath && (
        <p>
          Private export: <code>{operation.exportPath}</code>
        </p>
      )}
    </section>
  )
}
