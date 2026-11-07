import { useNavigate, useParams, useSearchParams } from 'react-router'
import { boldSettingsSectionLink } from './bold-links.ts'
import { RecipeLibrary } from './BoldRecipeLibrary.tsx'
import { BoldRecipeRoute } from './BoldRecipeRoute.tsx'
import { RunSheet } from './RunSheet.tsx'
import '../routes/orchestrations/orchestrations.css'
import '../routes/workflows/workflows.css'
import './bold-recipes.css'

/**
 * The route: `/b/settings/recipes` is the library (with `?run=<brief id>` a chat-less run's read-only sheet over it),
 * `/b/settings/recipes/new`, `/b/settings/recipes/lead-decides` or `/b/settings/recipes/:workflowId` is the editor.
 */
export function BoldRecipesPage() {
  const { workflowId } = useParams()
  const navigate = useNavigate()
  const [query, setQuery] = useSearchParams()
  const runBrief = query.get('run')
  if (workflowId) return <BoldRecipeRoute workflowId={workflowId} />
  return (
    <>
      <RecipeLibrary onBack={() => void navigate(boldSettingsSectionLink('connections'))} />
      {runBrief && <RunSheet briefId={runBrief} onClose={() => setQuery({}, { replace: true })} />}
    </>
  )
}
