import { useParams, useSearchParams } from 'react-router'
import { RecipeLibrary } from './BoldRecipeLibrary.tsx'
import { BoldRecipeRoute } from './BoldRecipeRoute.tsx'
import { RecipeSidePanels } from './repeating/RecipeSidePanels.tsx'
import { RecipesNav } from './repeating/RecipesNav.tsx'
import { RunSheet } from './RunSheet.tsx'
import { TasksHeader } from './tasks-tabs/TasksHeader.tsx'
import '../routes/orchestrations/orchestrations.css'
import '../routes/workflows/workflows.css'
import './bold-recipes.css'
import './repeating/repeating.css'

// A recipe that is saved can repeat; a new one and the built-in lead decides have no schedule.
const unsaved = (workflowId: string) => workflowId === 'new' || workflowId === 'lead-decides'

/**
 * Decision 183: Recipes are under Tasks. `/b/tasks/recipes` is the library (with `?run=<brief id>` a chat-less run's
 * read-only sheet over it), `/b/tasks/recipes/new`, `/b/tasks/recipes/lead-decides` or `/b/tasks/recipes/:workflowId`
 * is the editor, with the recipes on its left and, for a saved one, the Repeats card on its right.
 */
export function BoldRecipesPage() {
  const { workflowId } = useParams()
  const [query, setQuery] = useSearchParams()
  const runBrief = query.get('run')
  const saved = workflowId !== undefined && !unsaved(workflowId)
  return (
    <div className="bold-page bold-rt" data-ui-page="tasks">
      <TasksHeader />
      <div
        className={`bold-rt-cols${workflowId ? ' bold-rt-cols--recipe' : ''}${saved ? ' bold-rt-cols--saved' : ''}`}
      >
        {workflowId && <RecipesNav selected={workflowId} />}
        {workflowId ? (
          <BoldRecipeRoute workflowId={workflowId} />
        ) : (
          <div>
            <RecipeLibrary />
            {runBrief && (
              <RunSheet briefId={runBrief} onClose={() => setQuery({}, { replace: true })} />
            )}
          </div>
        )}
        {saved && <RecipeSidePanels workflowId={workflowId} />}
      </div>
    </div>
  )
}
