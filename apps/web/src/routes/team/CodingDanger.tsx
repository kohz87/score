import type { CodingAgent } from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

/** At the bottom, apart from the cards, like a Hermes agent's Danger zone. */
export function CodingDanger({
  coding,
  onRemoved,
}: {
  coding: CodingAgent
  onRemoved: () => void
}) {
  const remove = useMutation({
    mutationFn: () =>
      apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, { method: 'DELETE' }),
    onSuccess: onRemoved,
  })
  return (
    <section
      className="team-card team-profile-danger team-section-gap"
      aria-labelledby="coding-danger"
      data-protected="block"
    >
      <h2 id="coding-danger">Danger zone</h2>
      <p>Removing {coding.name} takes it off the team. Past work stays in rooms.</p>
      {remove.error && <p role="alert">{remove.error.message}</p>}
      <div className="team-file-actions">
        <button
          id="agent-delete"
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Remove ${coding.name} from the team? Past work stays in rooms.`))
              remove.mutate()
          }}
        >
          Remove agent
        </button>
      </div>
    </section>
  )
}
