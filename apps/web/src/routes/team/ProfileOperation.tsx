import { AgentOperationSchema, type AgentOperation } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

const stepLabels: Record<string, string> = {
  create_profile: 'Create profile',
  import_profile: 'Import profile',
  describe_profile: 'Set description',
  preserve_key: 'Create access key',
  configure_key: 'Connect profile',
  model: 'Set model',
  permissions: 'Apply team rules',
  install_bridge: 'Install Score’s plugin in Hermes',
  enable_bridge: 'Turn on Score’s plugin',
  verify_ready: 'Check the agent is ready',
  export: 'Keep private export',
  delete_profile: 'Delete profile',
  purge_identity: 'Clean up leftovers',
  retire: 'Remove agent',
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
          headers: { 'Idempotency-Key': newId() },
        }),
      ),
    onSuccess: (next) => client.setQueryData(['team', 'operation', operation.id], next),
  })
  // Score lost track of a step (it restarted mid-step): the person checks it on the Hermes machine and confirms.
  const confirm = useMutation({
    mutationFn: async () =>
      AgentOperationSchema.parse(
        await apiFetch(`agents/operations/${operation.id}/confirm`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ step: operation.nextStep }),
        }),
      ),
    onSuccess: (next) => client.setQueryData(['team', 'operation', operation.id], next),
  })
  const stepName = stepLabels[operation.nextStep ?? ''] ?? 'this step'
  return (
    <section className="team-card" aria-live="polite">
      <h2>
        {operation.state === 'needs_attention'
          ? 'Needs attention'
          : operation.state === 'completed'
            ? operation.kind === 'delete'
              ? 'Agent removed'
              : 'Ready'
            : operation.kind === 'delete'
              ? 'Deleting agent'
              : operation.kind === 'import'
                ? 'Importing agent'
                : 'Setting up'}
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
        <p role="alert">Couldn’t retry this step. Check the profile on the Hermes machine.</p>
      )}
      {operation.state === 'needs_attention' && operation.confirmable && (
        <div className="team-operation-confirm">
          <p>
            Score lost track of “{stepName}” (it restarted while the step ran). Check on the Hermes
            machine whether it finished
            {operation.nextStep === 'create_profile' || operation.nextStep === 'import_profile'
              ? ` (the profile ${operation.targetName} exists)`
              : operation.nextStep === 'delete_profile'
                ? ` (the profile ${operation.targetName} is gone)`
                : ''}
            . If it did, continue from the next step.
          </p>
          <button
            type="button"
            className="team-primary"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? 'Continuing…' : 'I checked: it finished, continue'}
          </button>
        </div>
      )}
      {confirm.isError && (
        <p role="alert">
          {confirm.error instanceof Error && confirm.error.message
            ? confirm.error.message
            : 'Couldn’t continue. Try again.'}
        </p>
      )}
      {operation.exportPath && (
        <p>
          Private export: <code>{operation.exportPath}</code>
        </p>
      )}
    </section>
  )
}
