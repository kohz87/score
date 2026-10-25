import { AgentDetailSchema } from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

/** The display name and the role line (the same PATCH the classic Agent details form sends). */
export function useSaveAgentDetails(agentId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (details: { name: string; role: string }) =>
      AgentDetailSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify(details),
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['team', 'detail', agentId] })
      void client.invalidateQueries({ queryKey: ['team', 'agents'] })
    },
  })
}
