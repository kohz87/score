import { RunsOnSchema, type RunsOnUpdate } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../data/api.ts'
import { workspaceKey } from '../routes/team/workspace-queries.ts'

const path = (agentId: string) => `agents/${encodeURIComponent(agentId)}/runs-on`
export const runsOnKey = (agentId: string) => ['team', 'runs-on', agentId] as const

/** Where the agent runs and what that separates (contract § Where an agent runs). */
export function useRunsOn(agentId: string) {
  return useQuery({
    queryKey: runsOnKey(agentId),
    queryFn: async ({ signal }) => RunsOnSchema.parse(await apiFetch(path(agentId), { signal })),
    // Hermes's settings can change outside Score.
    refetchOnWindowFocus: true,
    retry: false,
  })
}

export function useSetRunsOn(agentId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (update: RunsOnUpdate) =>
      RunsOnSchema.parse(
        await apiFetch(path(agentId), { method: 'PUT', body: JSON.stringify(update) }),
      ),
    onSuccess: (runsOn) => client.setQueryData(runsOnKey(agentId), runsOn),
    // The Workspace tab is only available on this machine's terminal.
    onSettled: () => void client.invalidateQueries({ queryKey: workspaceKey(agentId) }),
  })
}
