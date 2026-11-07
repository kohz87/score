import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import { taskAgentsQuery } from '../data/task-queries.ts'
import { starterDraft } from '../routes/workflows/workflow-model.ts'
import { useWorkflow, useWorkflows } from '../routes/workflows/workflow-queries.ts'
import { boldRecipesLink, boldStartJobLink } from './bold-links.ts'
import { BoldRecipeEditor } from './BoldRecipeEditor.tsx'

const BUILT_IN = 'lead-decides'

export function BoldRecipeRoute({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate()
  const workflows = useWorkflows()
  const agentsQuery = useStreamQuery(taskAgentsQuery)
  const agents = agentsQuery.data ?? []
  // A new recipe is made once per visit, when the team is known (its first step needs an agent).
  const [notice, setNotice] = useState('')
  const recipes = useMemo(() => workflows.data?.items ?? [], [workflows.data])
  const selected = workflowId
  const isReal = selected !== 'new' && selected !== BUILT_IN
  const detail = useWorkflow(isReal ? selected : undefined)
  const teamKnown = agentsQuery.status === 'success'
  const newDraft = useMemo(() => {
    const starter = starterDraft(
      agents.find((agent) => !agent.runtime || agent.runtime === 'hermes')?.id ??
        agents[0]?.id ??
        '',
    )
    return { ...starter, name: 'Untitled recipe' }
    // The agent list only seeds the first step, once it has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKnown])
  if (isReal && !detail.data) {
    return (
      <div className="bold-rp" data-ui-page="recipes">
        <BackToRecipes />
        <section className="bold-rp-main" aria-label="Recipe editor">
          {detail.isError ? (
            <p role="alert" className="bold-error">
              Couldn’t load this recipe. Try again or choose another.
            </p>
          ) : workflows.isError ? (
            <p role="alert" className="bold-error">
              Couldn’t load recipes.{' '}
              <button type="button" className="bold-link" onClick={() => void workflows.refetch()}>
                Try again
              </button>
            </p>
          ) : (
            <p role="status" className="muted">
              Loading the recipe…
            </p>
          )}
        </section>
      </div>
    )
  }
  if (selected === 'new' && agentsQuery.status !== 'success')
    return (
      <div className="bold-rp" data-ui-page="recipes">
        <BackToRecipes />
        {agentsQuery.status === 'error' ? (
          <p role="alert" className="bold-error">
            Couldn’t load the team, so the recipe can’t choose agents.
          </p>
        ) : (
          <p role="status" className="muted">
            Loading the team…
          </p>
        )}
      </div>
    )

  if (selected === BUILT_IN)
    return (
      <div className="bold-rp" data-ui-page="recipes">
        <BackToRecipes />
        <section className="bold-rp-main" aria-label="Recipe editor">
          <h2 className="bold-rp-title">lead decides</h2>
          <p className="muted">
            The built-in recipe. It has no fixed steps: the lead plans each job, asks the agents it
            needs, and pauses for you where a decision is yours. There is nothing to edit here.
          </p>
          <span>
            <Link className="btn sm primary" to={boldStartJobLink()}>
              Start a job
            </Link>
          </span>
        </section>
      </div>
    )

  const after = (id: string) => {
    void navigate(boldRecipesLink(id), { replace: true })
  }
  const common = {
    recipes,
    agents,
    notice,
    onSaved: (id: string, version: number) => {
      setNotice(`Saved as version ${version}.`)
      if (selected === 'new') after(id)
    },
    onDeleted: () => {
      // The library says so (router state, so a reload doesn't repeat it).
      void navigate(boldRecipesLink(), { replace: true, state: { deletedRecipe: true } })
    },
    onDuplicated: (id: string) => {
      setNotice('Made a copy. It is saved as version 1.')
      after(id)
    },
    onNotice: setNotice,
  }
  return selected === 'new' ? (
    <BoldRecipeEditor key="new" detail={null} initialDefinition={newDraft} {...common} />
  ) : (
    <BoldRecipeEditor
      key={detail.data!.id}
      detail={detail.data!}
      initialDefinition={detail.data!.latest.definition}
      {...common}
    />
  )
}

function BackToRecipes() {
  return (
    <Link className="bold-rp-back" to={boldRecipesLink()}>
      ‹ Recipes
    </Link>
  )
}
