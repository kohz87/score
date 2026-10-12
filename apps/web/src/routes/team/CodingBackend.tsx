import { CodingBackendSchema, type CodingBackend as Backend } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

const checkLabels: Record<string, string> = {
  manager: 'System service manager',
  'cgroup-v2': 'Control groups (cgroup v2)',
  linger: 'Keeps running after you log out',
  'socket-path': 'Socket path length',
  properties: 'Service settings accepted',
  socket: 'Score’s listener for supervisors',
  python: 'Python 3',
  notify: 'Manager notify socket',
}

export const codingBackendQuery = {
  queryKey: ['coding', 'backend'],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    CodingBackendSchema.parse(await apiFetch('coding-agents/backend', { signal })),
}

/**
 * How coding runs are launched (7.7a): as supervised system services, or by the fallback that has no supervisor.
 * The sentence comes from Score; "Check again" reruns the host check, and new runs follow its answer.
 */
export function CodingBackend() {
  const queryClient = useQueryClient()
  const backend = useQuery(codingBackendQuery)
  const recheck = useMutation({
    mutationFn: async () =>
      CodingBackendSchema.parse(
        await apiFetch('coding-agents/backend/check', { method: 'POST', body: '{}' }),
      ),
    onSuccess: (value: Backend) => {
      queryClient.setQueryData(codingBackendQuery.queryKey, value)
    },
  })
  if (!backend.data) return null
  const { note, kind, checks } = backend.data
  const failed = checks.filter((check) => !check.ok)
  return (
    <div className="team-muted" aria-label="How this agent runs">
      <p data-backend={kind}>{note}</p>
      {kind === 'unit' && (
        <p>
          If Score stops, the service stops this agent and everything running inside it, and Score
          confirms that before it calls a run finished. Work the agent hands to another service, a
          scheduler or a background daemon isn’t covered.
        </p>
      )}
      {checks.length > 0 && (
        <details>
          <summary>Host check{failed.length > 0 ? ` (${failed.length} not met)` : ''}</summary>
          <ul>
            {checks.map((check) => (
              <li key={check.name}>
                {checkLabels[check.name] ?? check.name}: {check.ok ? 'OK' : 'not met'}.{' '}
                {check.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
      {recheck.error && <p role="alert">{recheck.error.message}</p>}
      <button
        type="button"
        className="team-pill-button"
        disabled={recheck.isPending}
        onClick={() => recheck.mutate()}
      >
        Check again
      </button>
    </div>
  )
}
