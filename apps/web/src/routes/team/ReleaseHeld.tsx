import { CodingAgentSchema, CodingAgentsResponseSchema } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

/**
 * A coding agent whose programs Score couldn’t prove ended takes no new message. When the reason is that Score can’t
 * tell whether the leftover programs are its own, the person may check them and release the agent. Releasing never
 * stops anything: it only lets the agent work again.
 */
export function ReleaseHeld({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ['coding', 'agents'],
    queryFn: async ({ signal }) =>
      CodingAgentsResponseSchema.parse(await apiFetch('coding-agents', { signal })).items,
  })
  const release = useMutation({
    mutationFn: async () =>
      CodingAgentSchema.parse(
        await apiFetch(`coding-agents/${encodeURIComponent(agentId)}/release`, {
          method: 'POST',
          body: '{}',
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['coding'] })
      void queryClient.invalidateQueries({ queryKey: ['team'] })
    },
  })
  const held = list.data?.find((item) => item.id === agentId)?.heldGroups ?? []
  const unclear = held.filter((group) => group.canRelease)
  if (unclear.length === 0) return null
  const service = unclear.find((group) => group.unit)?.unit
  return (
    <div className="team-muted-strong" role="group" aria-label="Release this agent">
      {service ? (
        <p>
          Score can’t read the service this agent ran in, so it hasn’t touched it and this agent
          can’t take new messages. Check it yourself (for example{' '}
          <code>{`systemctl --user status ${service}`}</code>), then release the agent. Releasing
          stops nothing.
        </p>
      ) : (
        <p>
          Score can’t tell whether{' '}
          {unclear.length === 1 ? 'these programs are' : 'the programs of these groups are'} its
          own, so it hasn’t touched them and this agent can’t take new messages. Check them
          yourself (for example <code>{`ps -o pid,pgid,args -g ${unclear[0]!.pgid}`}</code>
          ), then release the agent. Releasing stops nothing.
        </p>
      )}
      {release.error && <p role="alert">{release.error.message}</p>}
      <button
        type="button"
        className="team-pill-button"
        disabled={release.isPending}
        onClick={() => release.mutate()}
      >
        Release agent
      </button>
    </div>
  )
}
