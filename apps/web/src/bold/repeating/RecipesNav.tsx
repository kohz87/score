import type { WorkflowSummary } from '@score/contract'
import { Link, useNavigate } from 'react-router'
import { useWorkflow, useWorkflows } from '../../routes/workflows/workflow-queries.ts'
import { boldRecipesLink } from '../bold-links.ts'
import { useRecipeSchedules } from './recipe-schedule-queries.ts'
import { describeSchedule } from './recipe-schedule-words.ts'
import './repeating.css'

function Item({
  recipe,
  repeats,
  current,
}: {
  recipe: WorkflowSummary
  repeats: string | null
  current: boolean
}) {
  const detail = useWorkflow(recipe.id)
  const agents: string[] = []
  for (const node of detail.data?.latest.definition.nodes ?? [])
    if (node.kind === 'agent' && node.agentId && !agents.includes(node.agentId))
      agents.push(node.agentId)
  const facts = [...agents, ...(repeats ? [`repeats ${repeats}`] : [])].join(' · ')
  return (
    <li>
      <Link
        className="bold-rn-item"
        to={boldRecipesLink(recipe.id)}
        aria-current={current ? 'page' : undefined}
      >
        <b>{recipe.name}</b>
        {facts && <span>{facts}</span>}
      </Link>
    </li>
  )
}

/**
 * The recipes on the left of an open recipe (mock-up 28-tasks-recipe): each with its agents and, when it repeats, when.
 * Shown on wide screens; a narrower page has the library's cards and the back link instead.
 */
export function RecipesNav({ selected }: { selected: string | undefined }) {
  const navigate = useNavigate()
  const workflows = useWorkflows()
  const schedules = useRecipeSchedules().data
  const live = (workflows.data?.items ?? []).filter((recipe) => !recipe.archivedAt)
  return (
    <nav className="bold-rn" aria-label="Recipes">
      <button
        type="button"
        className="bold-rn-new"
        onClick={() => void navigate(boldRecipesLink('new'))}
      >
        + New recipe
      </button>
      <ul>
        {live.map((recipe) => {
          const schedule = schedules?.find((item) => item.workflowId === recipe.id)
          return (
            <Item
              key={recipe.id}
              recipe={recipe}
              repeats={schedule ? describeSchedule(schedule.schedule) : null}
              current={recipe.id === selected}
            />
          )
        })}
      </ul>
    </nav>
  )
}
