import type { OrchestrationSummary, WorkflowRunSummary, WorkflowSummary } from '@score/contract'
import { useId, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import { orchestrationsQuery } from '../routes/orchestrations/orchestration-queries.ts'
import { statusLabel } from '../routes/orchestrations/orch-model.ts'
import {
  useArchiveWorkflow,
  useWorkflow,
  useWorkflows,
  workflowRunsQuery,
} from '../routes/workflows/workflow-queries.ts'
import { chatEntryForRun } from './chats/chat-model.ts'
import { useChatLists } from './chats/chat-queries.ts'
import { boldRecipesLink, boldRunLink, boldStartJobLink } from './bold-links.ts'
import { PlusIcon } from './BoldIcons.tsx'
import { recipeFacts } from './recipe-facts.ts'
import './bold-recipes.css'

export const BUILT_IN = 'lead decides'

type LastRun = { briefId: string; roomId: string; id: string; title: string; status: string }

/** The newest run of a recipe (or of lead decides), from the two run lists the shell already reads. */
function lastRunOf(
  recipeId: string | null,
  orchestrations: readonly OrchestrationSummary[],
  workflows: readonly WorkflowRunSummary[],
): LastRun | null {
  const runs =
    recipeId === null
      ? orchestrations.map((run) => ({ run, createdAt: run.createdAt }))
      : workflows
          .filter((run) => run.workflowId === recipeId)
          .map((run) => ({ run, createdAt: run.createdAt }))
  const newest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.run
  return newest
    ? {
        id: newest.id,
        briefId: newest.briefId,
        roomId: newest.roomId,
        title: newest.title,
        status: statusLabel[newest.status],
      }
    : null
}

function LastRunLine({
  run,
  chatName,
}: {
  run: LastRun | null
  chatName: (run: LastRun) => string | null
}) {
  if (!run) return <div className="bold-rc-last">Not run yet</div>
  return (
    <div className="bold-rc-last">
      Last run ·{' '}
      <Link to={boldRunLink(run.briefId)}>
        {chatName(run) ?? run.title} · {run.status} ›
      </Link>
    </div>
  )
}

function RecipeCard({
  recipe,
  lastRun,
  chatName,
}: {
  recipe: WorkflowSummary
  lastRun: LastRun | null
  chatName: (run: LastRun) => string | null
}) {
  const navigate = useNavigate()
  const archive = useArchiveWorkflow()
  const detail = useWorkflow(recipe.id)
  const facts = detail.data
    ? recipeFacts(detail.data.latest.definition)
    : (recipe.description ?? '')
  return (
    <li className="bold-rc" aria-label={recipe.name}>
      <div className="bold-rc-head">
        <b>{recipe.name}</b>
        {recipe.archivedAt ? (
          <span className="bold-rc-version">Archived</span>
        ) : (
          <span className="bold-rc-version">version {recipe.latestVersion}</span>
        )}
      </div>
      <div className="bold-rc-facts">
        {facts}
        {recipe.activeRuns > 0 && (
          <b className="bold-recipe-going">
            {facts ? ' · ' : ''}
            {recipe.activeRuns} {recipe.activeRuns === 1 ? 'run' : 'runs'} going
          </b>
        )}
      </div>
      <LastRunLine run={lastRun} chatName={chatName} />
      <div className="bold-rc-actions">
        <Link className="bold-rc-btn" to={boldRecipesLink(recipe.id)}>
          Edit<span className="wf-visually-hidden"> {recipe.name}</span>
        </Link>
        {recipe.archivedAt ? (
          <button
            type="button"
            className="bold-rc-btn"
            aria-label={`Unarchive ${recipe.name}`}
            disabled={archive.isPending}
            onClick={() => archive.mutate({ id: recipe.id, archived: false })}
          >
            Unarchive
          </button>
        ) : (
          <button
            type="button"
            className="bold-rc-btn"
            onClick={() => void navigate(boldStartJobLink(recipe.id))}
          >
            Run in a chat…<span className="wf-visually-hidden"> with {recipe.name}</span>
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * 3.29.0 (decision 165, mock-up 23-recipes-library): Settings › Recipes is a library of cards, not a list with an editor
 * beside it. Landing here never opens an editor; "New recipe" and "Edit" do.
 */
export function RecipeLibrary({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate()
  const deleted =
    (useLocation().state as { deletedRecipe?: boolean } | null)?.deletedRecipe === true
  const workflows = useWorkflows()
  const orchestrations = useStreamQuery(orchestrationsQuery).data
  const runs = useStreamQuery(workflowRunsQuery).data
  const chatLists = useChatLists()
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const searchId = useId()
  const recipes = useMemo(() => workflows.data?.items ?? [], [workflows.data])
  const needle = query.trim().toLowerCase()
  const matches = recipes.filter((recipe) => recipe.name.toLowerCase().includes(needle))
  const live = matches.filter((recipe) => !recipe.archivedAt)
  const archivedAll = recipes.filter((recipe) => recipe.archivedAt)
  const archived = matches.filter((recipe) => recipe.archivedAt)
  const showLead = BUILT_IN.includes(needle)

  const chatName = (run: LastRun): string | null =>
    chatEntryForRun(chatLists, chatLists.jobsByRoom, run.id)?.entry.name ?? null
  const leadRun = lastRunOf(null, orchestrations ?? [], runs ?? [])

  return (
    <div className="bold-rp bold-rl" data-ui-page="recipes">
      <button type="button" className="bold-settings-all" onClick={onBack}>
        ‹ Settings
      </button>
      <div className="bold-rl-head">
        <h2 className="bold-rp-h1">Recipes</h2>
        <label htmlFor={searchId} className="wf-visually-hidden">
          Find a recipe
        </label>
        <input
          id={searchId}
          className="bold-rl-find"
          type="search"
          placeholder="Find a recipe"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="bold-rl-new"
          aria-label="New recipe"
          onClick={() => void navigate(boldRecipesLink('new'))}
        >
          <PlusIcon />
          <span>
            New<span className="bold-rl-new-more"> recipe</span>
          </span>
        </button>
      </div>
      <p className="bold-rl-intro">
        Saved plans a chat’s lead can run with <b>/run</b>. A run shows in its chat: the run card,
        the Graph and the session log.
      </p>
      {deleted && (
        <p className="small muted bold-recipes-notice" role="status">
          Deleted the recipe.
        </p>
      )}
      {workflows.isError ? (
        <p role="alert" className="bold-error">
          Couldn’t load recipes.{' '}
          <button type="button" className="bold-link" onClick={() => void workflows.refetch()}>
            Try again
          </button>
        </p>
      ) : workflows.isPending ? (
        <p role="status" className="muted">
          Loading recipes…
        </p>
      ) : (
        <>
          <ul className="bold-rl-grid" aria-label="Recipes">
            {showLead && (
              <li className="bold-rc" aria-label={BUILT_IN}>
                <div className="bold-rc-head">
                  <b>{BUILT_IN}</b>
                  <span className="bold-badge bold-badge--quiet">Built in</span>
                </div>
                <div className="bold-rc-facts">No fixed steps: the chat’s lead plans each job.</div>
                <LastRunLine run={leadRun} chatName={chatName} />
                <div className="bold-rc-actions">
                  <button
                    type="button"
                    className="bold-rc-btn"
                    onClick={() => void navigate(boldStartJobLink())}
                  >
                    Run in a chat…<span className="wf-visually-hidden"> with {BUILT_IN}</span>
                  </button>
                </div>
              </li>
            )}
            {live.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                lastRun={lastRunOf(recipe.id, [], runs ?? [])}
                chatName={chatName}
              />
            ))}
          </ul>
          {recipes.length === 0 && (
            <p className="small muted">
              No saved recipes yet. “New recipe” starts one: an agent step, a gate for your approval
              and an end.
            </p>
          )}
          {recipes.length > 0 && matches.length === 0 && !showLead && (
            <p className="small muted" role="status">
              No recipe matches “{query}”.
            </p>
          )}
          {archivedAll.length > 0 && (
            <>
              <button
                type="button"
                className="bold-rl-archived"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((value) => !value)}
              >
                Archived recipes · {archivedAll.length}
              </button>
              {showArchived && (
                <ul className="bold-rl-grid" aria-label="Archived recipes">
                  {archived.map((recipe) => (
                    <RecipeCard
                      key={recipe.id}
                      recipe={recipe}
                      lastRun={lastRunOf(recipe.id, [], runs ?? [])}
                      chatName={chatName}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
