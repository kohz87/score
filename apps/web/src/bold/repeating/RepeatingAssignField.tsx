import type { AgentSummary } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName } from '../bold-agents.ts'
import { useWorkflows } from '../../routes/workflows/workflow-queries.ts'
import { Field } from './RepeatingFields.tsx'
import { recipePath } from './RepeatingCells.tsx'

// Tasks › Repeating (TR.2): Assigned to. "A recipe…" swaps the agent chips for the recipes; picking one opens that
// recipe's own Repeats card (Tasks › Recipes), where a recipe's schedule is set.

export function AssignField({
  agents,
  agentId,
  choosingRecipe,
  onPick,
  onRecipes,
}: {
  agents: readonly AgentSummary[]
  agentId: string
  choosingRecipe: boolean
  onPick: (id: string) => void
  onRecipes: (on: boolean) => void
}) {
  return (
    <Field label="Assigned to">
      {choosingRecipe ? (
        <RecipeChoices onBack={() => onRecipes(false)} />
      ) : (
        <span className="bold-rj-agents" role="radiogroup" aria-label="Assigned to">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="radio"
              aria-checked={agent.id === agentId}
              onClick={() => onPick(agent.id)}
            >
              <AgentGlyph agent={agent} size="xs" bare decorative />
              {agentDisplayName(agent)}
            </button>
          ))}
          <button type="button" onClick={() => onRecipes(true)}>
            A recipe…
          </button>
        </span>
      )}
    </Field>
  )
}

function RecipeChoices({ onBack }: { onBack: () => void }) {
  const recipes = useWorkflows()
  const items = (recipes.data?.items ?? []).filter((recipe) => !recipe.archivedAt)
  return (
    <span className="bold-rj-recipes">
      {recipes.isPending && <span className="bold-rj-hint">Reading recipes…</span>}
      {recipes.isError && <span className="bold-rj-hint">Couldn’t read the recipes.</span>}
      {recipes.isSuccess && items.length === 0 && (
        <span className="bold-rj-hint">No recipes yet.</span>
      )}
      <span className="bold-rj-agents">
        {items.map((recipe) => (
          <Link key={recipe.id} to={recipePath(recipe.id)}>
            {recipe.name}
          </Link>
        ))}
        <button type="button" onClick={onBack}>
          Back to agents
        </button>
      </span>
      <span className="bold-rj-hint">
        A recipe repeats from its own Repeats card; pick one to open it.
      </span>
    </span>
  )
}
