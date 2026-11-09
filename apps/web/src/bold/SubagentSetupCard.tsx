import { SubagentSetupSchema } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../data/api.ts'
import { problem } from './agent-more/MoreCard.tsx'

export const subagentSetupKey = ['subagent-setup'] as const

/** SA.1: the Agents page's one-time offer to make Hermes subagents safe in Score. */
export function SubagentSetupCard() {
  const [dismissed, setDismissed] = useState(false)
  const queryClient = useQueryClient()
  const setup = useQuery({
    queryKey: subagentSetupKey,
    queryFn: async ({ signal }) =>
      SubagentSetupSchema.parse(await apiFetch('subagent-setup', { signal })),
    retry: false,
  })
  const apply = useMutation({
    mutationFn: async (agentIds: string[]) => {
      const result = SubagentSetupSchema.parse(
        await apiFetch('subagent-setup/apply', {
          method: 'POST',
          body: JSON.stringify({ agentIds }),
        }),
      )
      await queryClient.invalidateQueries({ queryKey: subagentSetupKey })
      return result
    },
  })

  const waiting = setup.data?.agents.filter((agent) => !agent.inline) ?? []
  if (dismissed || waiting.length === 0) return null

  const applicable = waiting.filter((agent) => agent.guard)
  const withoutGuard = waiting.filter((agent) => !agent.guard)
  const count = waiting.length

  return (
    <section
      className="bold-subagent-setup"
      data-protected="flex"
      aria-labelledby="bold-subagent-setup-title"
      aria-busy={apply.isPending}
    >
      <h2 id="bold-subagent-setup-title">
        {count === 1
          ? '1 agent needs one setting changed'
          : `${count} agents need one setting changed`}
      </h2>
      <p className="bold-subagent-setup-copy">
        Until then, their subagents can't report back, be stopped or ask for your approval. Score
        has refused them, so nothing runs unsafely.
      </p>
      <code className="bold-subagent-setup-command">
        {`delegation.gateway_mode: inline · ${waiting.map((agent) => agent.agentId).join(', ')}`}
      </code>
      {withoutGuard.length > 0 && (
        <p className="bold-subagent-setup-waiting">
          {`Waiting for the updated Score plugin: ${withoutGuard
            .map((agent) => agent.agentId)
            .join(', ')}`}
        </p>
      )}
      <div className="bold-subagent-setup-actions">
        {applicable.length > 0 && (
          <button
            type="button"
            className="btn primary"
            disabled={apply.isPending}
            onClick={() => apply.mutate(applicable.map((agent) => agent.agentId))}
          >
            {apply.isPending ? 'Applying…' : `Apply to all ${applicable.length}`}
          </button>
        )}
        <button
          type="button"
          className="btn ghost"
          disabled={apply.isPending}
          onClick={() => setDismissed(true)}
        >
          Not now
        </button>
      </div>
      {apply.error && (
        <p className="bold-team-error" role="alert">
          {problem(apply.error, 'Couldn’t change the setting. Try again.')}
        </p>
      )}
    </section>
  )
}
