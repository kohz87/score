import {
  type AgentSummary,
  type WorkflowDetail,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowSummary,
} from '@score/contract'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../data/api.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { clock } from '../live/resolved.ts'
import { pairingProblem } from './bold-errors.ts'
import {
  boldRecipesLink,
  boldRunLink,
  boldSettingsSectionLink,
  boldStartJobLink,
} from './bold-links.ts'
import { taskAgentsQuery } from '../data/task-queries.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { AddMenu, RecipeLayers, type InsertStep } from '../routes/workflows/RecipeLayers.tsx'
import { layoutRecipe, placement } from '../routes/workflows/recipe-layers.ts'
import { ExportDialog } from '../routes/workflows/ExportDialog.tsx'
import { InputsEditor, Outline, type Selection } from '../routes/workflows/EditorParts.tsx'
import { NodeInspector } from '../routes/workflows/NodeInspector.tsx'
import { WorkflowPreview } from '../routes/workflows/PreviewRun.tsx'
import { useDraftHistory } from '../routes/workflows/use-draft-history.ts'
import { useLiveOverlay } from '../routes/workflows/use-live-overlay.ts'
import { placeNewNode } from '../routes/workflows/workflow-layout.ts'
import { RecipeSheet } from './RecipeSheet.tsx'
import {
  addStepAfter,
  insertStepBefore,
  insertStepOnEdge,
  removeNodeJoining,
  sameDraft,
  starterDraft,
  updateNode,
  type Draft,
} from '../routes/workflows/workflow-model.ts'
import {
  fetchWorkflowVersion,
  latestVersionOf,
  useArchiveWorkflow,
  useDeleteWorkflow,
  useDeleteWorkflowWithRuns,
  useSaveWorkflow,
  useValidation,
  useWorkflow,
  useWorkflowVersion,
  useWorkflows,
  workflowRunsQuery,
} from '../routes/workflows/workflow-queries.ts'
import {
  combine,
  indexIssues,
  issuesForNode,
  shapeIssues,
} from '../routes/workflows/workflow-validation.ts'
import {
  RECIPE_STEP_LABEL,
  addRecipeStep,
  analyzeRecipe,
  moveRecipeStepProblem,
  planRecipeMove,
  recipeClientProblems,
  removeRecipeStep,
  setPortTarget,
  type RecipeProblem,
} from './recipe-model.ts'
import { RecipeInspector, RecipeStepRow } from './BoldRecipeText.tsx'
import { RecipeLibrary } from './BoldRecipeLibrary.tsx'
import { RunSheet } from './RunSheet.tsx'
import '../routes/orchestrations/orchestrations.css'
import '../routes/workflows/workflows.css'
import { PlusIcon } from './BoldIcons.tsx'
import './bold-recipes.css'

// PLAN 11.10d, rebuilt as a page in 2.8.0 (decision 131, board C) and as a library in 3.29.0 (decision 165, mock-ups
// 23-recipes-*). A recipe is a 7.1 workflow: Settings > Recipes lists them as cards next to the built-in "lead decides"
// (BoldRecipeLibrary.tsx); this file is the editor for one: a graph (the full editor: add, connect, move, delete,
// keyboard on the canvas, preview, live states of a running copy) or "As text" (the step list). The step settings sit to
// the right of both (a bottom sheet on a phone). Starting a run stays in Start a job (Run opens it with this recipe
// chosen). A run is read in its chat; only one that belongs to no chat opens a read-only sheet over the library.

const BUILT_IN = 'lead-decides'
// The bold shell's narrow breakpoint: below it the step settings are a bottom sheet (a tablet gets it too).
const NARROW_QUERY = '(width <= 860px)'

type Problem = RecipeProblem & { edgeId?: string | null }

function problemKey(problem: Problem): string {
  return `${problem.code}|${problem.nodeId ?? ''}|${problem.message}`
}

function dedupeProblems(problems: Problem[]): Problem[] {
  const seen = new Set<string>()
  return problems.filter((problem) => {
    const key = problemKey(problem)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function describeError(error: unknown): string {
  const pairing = pairingProblem(error)
  if (pairing) return pairing
  if (!(error instanceof ApiError)) return 'Couldn’t do that. Try again.'
  if (error.code === 'workflow_used')
    return 'This recipe has runs, so it can’t be deleted. Delete is only for recipes nothing has run.'
  if (error.code === 'quota_exhausted')
    return 'This recipe has as many saved versions as Score keeps (or there are too many recipes). Delete one you don’t use.'
  if (error.code === 'invalid_definition')
    return 'Score found a problem with this recipe. The problem line above says what.'
  return error.message
}

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

function BackToRecipes() {
  return (
    <Link className="bold-rp-back" to={boldRecipesLink()}>
      ‹ Recipes
    </Link>
  )
}

function BoldRecipeRoute({ workflowId }: { workflowId: string }) {
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

/** The decision to delete a recipe together with its runs: the person types the recipe's name (3.8.0). */
function DeleteWithRunsDialog({
  name,
  runs,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  name: string
  runs: number
  pending: boolean
  error: string
  onCancel: () => void
  onConfirm: (confirm: string) => void
}) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => input.current?.focus(), [])
  // Escape cancels and Tab stays inside, as in the other confirmations.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (!pending) onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialog.current) return
    const items = [
      ...dialog.current.querySelectorAll<HTMLElement>('input, button:not(:disabled)'),
    ].filter((item) => !item.hasAttribute('disabled'))
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return (
    <div className="bold-rp-scrim">
      <section
        ref={dialog}
        onKeyDown={onKeyDown}
        className="card bold-rp-confirm"
        data-protected="flex"
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete recipe with its runs"
      >
        <h3>Delete {name} with its runs?</h3>
        <p>
          {runs > 0
            ? `This deletes ${runs} ${runs === 1 ? 'run' : 'runs'} of this recipe, with their rooms, and the recipe itself.`
            : 'This deletes every run of this recipe, with their rooms, and the recipe itself.'}{' '}
          It can’t be undone. Archive keeps the runs.
        </p>
        <label className="bold-lab" htmlFor={inputId}>
          Type the recipe’s name to confirm
          <input
            ref={input}
            id={inputId}
            className="bold-field"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="bold-error">
            {error}
          </p>
        )}
        <div className="row wrap">
          <button type="button" className="link" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary bold-danger"
            disabled={pending || typed.trim() !== name.trim()}
            onClick={() => onConfirm(typed.trim())}
          >
            {pending ? 'Deleting…' : 'Delete recipe and runs'}
          </button>
        </div>
      </section>
    </div>
  )
}

function BoldRecipeEditor({
  detail,
  initialDefinition,
  recipes,
  agents,
  notice,
  onSaved,
  onDeleted,
  onDuplicated,
  onNotice,
}: {
  detail: WorkflowDetail | null
  initialDefinition: Draft
  recipes: WorkflowSummary[]
  agents: AgentSummary[]
  notice: string
  onSaved: (id: string, version: number) => void
  onDeleted: (id: string) => void
  onDuplicated: (id: string) => void
  onNotice: (text: string) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const history = useDraftHistory<Draft>(initialDefinition)
  const { draft, commit } = history
  const analysis = useMemo(() => analyzeRecipe(draft), [draft])
  const [sel, setSel] = useState<Selection>(null)
  const selectedNodeId = sel?.kind === 'node' ? sel.id : null
  const [saved, setSaved] = useState(() => ({
    workflowId: detail?.id ?? null,
    version: detail?.latestVersion ?? 0,
    definition: initialDefinition,
  }))
  const [graph, setGraph] = useState(true)
  const [conflict, setConflict] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [previewing, setPreviewing] = useState<Draft | null>(null)
  const [viewVersion, setViewVersion] = useState<number | null>(null)
  const [loadedFrom, setLoadedFrom] = useState<number | null>(null)
  const [saveProblem, setSaveProblem] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const save = useSaveWorkflow()
  const remove = useDeleteWorkflow()
  const archive = useArchiveWorkflow()
  const removeWithRuns = useDeleteWorkflowWithRuns()
  const [deletingRuns, setDeletingRuns] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  const recipe = recipes.find((item) => item.id === detail?.id)
  const runCount =
    useStreamQuery(workflowRunsQuery).data?.filter((run) => run.workflowId === detail?.id).length ??
    0
  const root = useRef<HTMLElement>(null)
  const allowLeave = useRef(false)
  const skipSheetFocus = useRef(false)
  const nameId = useId()
  const viewed = useWorkflowVersion(saved.workflowId ?? undefined, viewVersion ?? undefined)
  const viewing = viewVersion !== null

  const shape = useMemo(() => shapeIssues(draft), [draft])
  const validation = useValidation(shape.length === 0 ? draft : null)
  const issues = useMemo(() => combine(shape, validation.data), [shape, validation.data])
  const index = useMemo(() => indexIssues(issues), [issues])
  // The step list's checks read the recipe as one line of steps; a recipe the list can't show is judged by the
  // graph rules alone.
  const clientProblems = useMemo(
    () => (analysis.listable ? recipeClientProblems(draft, analysis.order) : []),
    [draft, analysis.order, analysis.listable],
  )
  const serverErrors = useMemo(
    () =>
      (validation.data?.issues ?? [])
        .filter((issue) => issue.severity === 'error')
        .map((issue) => ({
          code: issue.code,
          message: issue.message,
          nodeId: issue.nodeId,
          edgeId: issue.edgeId,
        })),
    [validation.data],
  )
  const problems = useMemo(
    () =>
      dedupeProblems([
        ...clientProblems,
        ...shape.map((issue) => ({
          code: issue.code,
          message: issue.message,
          nodeId: issue.nodeId,
          edgeId: issue.edgeId,
        })),
        ...serverErrors,
      ]),
    [clientProblems, shape, serverErrors],
  )
  const warnings =
    validation.data?.issues.filter((issue) => issue.severity === 'warning').length ?? 0
  const checking = shape.length === 0 && (validation.pending || validation.isPending)
  const checkFailed = shape.length === 0 && validation.isError
  const dirty = !sameDraft(draft, saved.definition)
  const canSave =
    problems.length === 0 &&
    !checking &&
    !checkFailed &&
    !save.isPending &&
    !viewing &&
    (dirty || saved.workflowId === null)
  const selectedRow =
    analysis.rows.find((row) => row.node.id === selectedNodeId) ?? analysis.rows[0] ?? null
  const versions = detail?.versions ?? []
  const badge = checkFailed
    ? "Couldn't check this recipe"
    : problems.length > 0
      ? `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix`
      : checking
        ? 'Checking…'
        : 'Looks good'
  const moveProblems = useMemo(
    () =>
      new Map(
        analysis.rows.map((row) => [
          row.node.id,
          {
            up: moveRecipeStepProblem(draft, row.node.id, -1),
            down: moveRecipeStepProblem(draft, row.node.id, 1),
          },
        ]),
      ),
    [analysis.rows, draft],
  )
  const graphDraft: Draft = viewing && viewed.data ? viewed.data.definition : draft
  const graphNode =
    sel?.kind === 'node' ? graphDraft.nodes.find((node) => node.id === sel.id) : undefined
  // A run of the version on screen that is going now: its states are drawn on the canvas; the draft is never touched.
  const overlay = useLiveOverlay(
    saved.workflowId,
    saved.version,
    !dirty && previewing === null && !viewing,
  )
  const previewBlocked =
    shape.length > 0 || problems.length > 0
      ? 'Fix the problems first: a preview needs a recipe without errors.'
      : checking
        ? 'Score is still checking the recipe.'
        : null

  // Leaving with unsaved work asks first (the list, the top bar, a link).
  const blocker = useBlocker(() => dirty && !allowLeave.current)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm('You have unsaved changes. Leave without saving?')) blocker.proceed()
    else blocker.reset()
  }, [blocker])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const selectNode = useCallback(
    (id: string | null) => setSel(id ? { kind: 'node', id } : null),
    [],
  )

  const patch = useCallback(
    (change: Partial<WorkflowNode>, coalesce?: string) => {
      if (!selectedRow) return
      commit(updateNode(draft, selectedRow.node.id, change), coalesce)
    },
    [commit, draft, selectedRow],
  )

  /** The text view's add: a step in the line, before the end. */
  function add(kind: WorkflowNodeKind) {
    if (!analysis.listable) return
    const agentId =
      kind === 'agent'
        ? (agents.find((agent) => !agent.runtime || agent.runtime === 'hermes')?.id ??
          agents[0]?.id ??
          '')
        : ''
    const result = addRecipeStep(draft, kind, agentId)
    if ('error' in result) {
      onNotice(result.error)
      return
    }
    commit(result.draft)
    selectNode(result.id)
  }

  /** The graph's add: a step in the middle of a connection, first, or connected after a step (settings panel). */
  const insertStep: InsertStep = (at, kind, agentId, agentName) => {
    const name = agentName || undefined
    const result =
      'edgeId' in at
        ? insertStepOnEdge(draft, at.edgeId, kind, agentId, name)
        : 'before' in at
          ? insertStepBefore(draft, at.before, kind, agentId, name)
          : addStepAfter(draft, at.after || null, kind, agentId, name)
    if ('error' in result) {
      setAnnouncement(result.error)
      return
    }
    const near =
      'edgeId' in at
        ? (draft.edges.find((edge) => edge.id === at.edgeId)?.from ?? null)
        : 'after' in at
          ? at.after || null
          : null
    commit(placeNewNode(result.draft, result.id, new Map(), near))
    setSel({ kind: 'node', id: result.id })
    setAnnouncement(result.note)
    // The new card takes focus; on a phone the sheet that opens for it must not take it back.
    skipSheetFocus.current = true
    focusCard(result.id)
  }

  function deleteNode(id: string) {
    const label = draft.nodes.find((node) => node.id === id)?.label ?? id
    const shown = layoutRecipe(draft)
    const order = [...shown.layers.flatMap((layer) => layer.nodes), ...shown.orphans].map(
      (entry) => entry.node.id,
    )
    const at = order.indexOf(id)
    const joined = removeNodeJoining(draft, id)
    commit(joined.draft)
    setSel(null)
    setAnnouncement(joined.note ? `Removed ${label}. ${joined.note}` : `Removed ${label}.`)
    // Focus goes to the card the recipe now joins on to, else the next card, else the previous one.
    const after = joined.note ? draft.edges.find((edge) => edge.from === id)?.to : undefined
    focusCard(after ?? order[at + 1] ?? order[at - 1] ?? null)
  }

  function removeStep(id: string) {
    if (!analysis.listable) return
    const order = analysis.order
    const at = order.findIndex((node) => node.id === id)
    const label = order[at]?.label || id
    const next = order[at + 1]?.id ?? order[at - 1]?.id ?? null
    commit(removeRecipeStep(draft, id))
    selectNode(next)
    setAnnouncement(`Removed ${label}`)
    focusStep(next, 'row')
  }

  function move(id: string, direction: -1 | 1) {
    if (!analysis.listable) return
    const plan = planRecipeMove(draft, id, direction)
    if (!plan.changed || plan.reason !== null) return
    const label = analysis.order.find((node) => node.id === id)?.label || id
    const at = plan.order.findIndex((node) => node.id === id)
    commit(plan.draft)
    selectNode(id)
    setAnnouncement(`Moved ${label} to step ${at + 1}`)
    focusStep(id, direction === -1 ? 'up' : 'down')
  }

  function point(nodeId: string, port: string, target: string | null) {
    commit(setPortTarget(draft, nodeId, port, target || null))
  }

  function onSave() {
    setSaveProblem('')
    save.mutate(
      {
        workflowId: saved.workflowId,
        ...(saved.workflowId === null ? {} : { baseVersion: saved.version }),
        definition: draft,
      },
      {
        onSuccess: (version) => {
          setConflict(null)
          setLoadedFrom(null)
          setSaved({ workflowId: version.workflowId, version: version.version, definition: draft })
          // A new recipe moves to its own address: that is not "leaving with unsaved work".
          if (saved.workflowId === null) allowLeave.current = true
          onSaved(version.workflowId, version.version)
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'conflict') {
            setConflict(latestVersionOf(error.details) ?? saved.version + 1)
            return
          }
          setSaveProblem(describeError(error))
        },
      },
    )
  }

  async function reloadLatest(version: number) {
    if (!saved.workflowId) return
    try {
      const loaded = await fetchWorkflowVersion(queryClient, saved.workflowId, version)
      history.reset(loaded.definition)
      setSaved({ workflowId: saved.workflowId, version, definition: loaded.definition })
      selectNode(loaded.definition.nodes[0]?.id ?? null)
      setLoadedFrom(null)
      setConflict(null)
      onNotice(`Reloaded version ${version}. Your edits were discarded.`)
    } catch {
      onNotice('Couldn’t load the newer version.')
    }
  }

  async function loadOlder(version: number) {
    if (!saved.workflowId) return
    if (
      dirty &&
      !window.confirm(
        `You have unsaved changes. Replace them with version ${version}? You can undo this.`,
      )
    )
      return
    try {
      const loaded = await fetchWorkflowVersion(queryClient, saved.workflowId, version)
      // Load it as an edit, not a reset: the unsaved draft stays one undo away.
      history.commit(loaded.definition)
      selectNode(loaded.definition.nodes[0]?.id ?? null)
      setLoadedFrom(version)
      setViewVersion(null)
      onNotice(`Loaded version ${version} into the draft. Saving makes it a new version.`)
    } catch {
      onNotice('Couldn’t load that version.')
    }
  }

  function removeRecipe() {
    if (!saved.workflowId || !window.confirm(`Delete ${draft.name}? Its saved versions go too.`))
      return
    onNotice('')
    setMoreOpen(false)
    remove.mutate(saved.workflowId, {
      onSuccess: () => {
        allowLeave.current = true
        onDeleted(saved.workflowId!)
      },
      onError: (error) => onNotice(describeError(error)),
    })
  }

  function toggleArchive() {
    if (!saved.workflowId) return
    onNotice('')
    setMoreOpen(false)
    const archiving = !recipe?.archivedAt
    archive.mutate(
      { id: saved.workflowId, archived: archiving },
      {
        onSuccess: () =>
          onNotice(
            archiving
              ? 'Archived the recipe. Its runs stay.'
              : 'Unarchived the recipe. It is offered again.',
          ),
        onError: (error) => onNotice(describeError(error)),
      },
    )
  }

  function duplicate() {
    if (!saved.workflowId) return
    setMoreOpen(false)
    const definition = {
      ...saved.definition,
      name: `${saved.definition.name} (copy)`.slice(0, 120),
    }
    save.mutate(
      { workflowId: null, definition },
      {
        onSuccess: (version) => {
          allowLeave.current = true
          onDuplicated(version.workflowId)
        },
        onError: (error) => onNotice(describeError(error)),
      },
    )
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement | null
    const typing =
      !!target &&
      (target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        !!target.closest('.cm-editor'))
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      // A text field keeps its native undo; the recipe history is for the steps themselves.
      if (typing || viewing || previewing) return
      event.preventDefault()
      if (event.shiftKey) history.redo()
      else history.undo()
      return
    }
    if (event.key === 'Escape' && moreOpen) {
      event.preventDefault()
      setMoreOpen(false)
    }
  }

  function focusStep(id: string | null, control: 'row' | 'up' | 'down') {
    requestAnimationFrame(() => {
      if (id === null) {
        root.current?.focus()
        return
      }
      const row = root.current?.querySelector<HTMLElement>(`[data-recipe-step="${id}"]`)
      if (control === 'row') {
        row?.querySelector<HTMLButtonElement>('.bold-step')?.focus()
        return
      }
      const wanted = row?.querySelector<HTMLButtonElement>(`[data-move="${control}"]`)
      const other = row?.querySelector<HTMLButtonElement>(
        `[data-move="${control === 'up' ? 'down' : 'up'}"]`,
      )
      const target = wanted && !wanted.disabled ? wanted : other
      if (target && !target.disabled) target.focus()
      else row?.querySelector<HTMLButtonElement>('.bold-step')?.focus()
    })
  }

  function focusCard(id: string | null) {
    requestAnimationFrame(() => {
      skipSheetFocus.current = false
      if (id === null) {
        root.current?.focus()
        return
      }
      root.current?.querySelector<HTMLElement>(`.rl-card[data-node="${CSS.escape(id)}"]`)?.focus()
    })
  }

  const narrow = useMediaQuery(NARROW_QUERY)
  // Below 860px (phone and tablet) the step's settings are a sheet from the bottom, as in the mock-up (both views); only while a step is selected.
  const sheet = narrow && previewing === null
  const recipeLayout = useMemo(() => layoutRecipe(graphDraft), [graphDraft])
  const sheetOpen = sheet && graphNode !== undefined
  const graphId = graphNode?.id ?? null
  const aside = useRef<HTMLElement>(null)
  const sheetCard = useRef<string | null>(null)
  useEffect(() => {
    if (sheetOpen) sheetCard.current = graphId
  }, [sheetOpen, graphId])
  // The sheet takes focus when it opens and gives it back to the card when it closes; the selected card is scrolled into
  // view above it (the cards keep a bottom margin the height of the sheet).
  useEffect(() => {
    if (sheetOpen) {
      if (!skipSheetFocus.current) aside.current?.focus()
    } else if (sheetCard.current) {
      focusCard(sheetCard.current)
      sheetCard.current = null
    }
    // focusCard only reads refs.
  }, [sheetOpen])
  useEffect(() => {
    if (!sheetOpen || graphId === null) return
    const frame = requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLElement>(`.rl-card[data-node="${CSS.escape(graphId)}"]`)
        ?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [sheetOpen, graphId])
  // Escape closes the sheet wherever focus is, unless something inside (a menu, a field's suggestions) used it.
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) selectNode(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sheetOpen, selectNode])
  const where = graphNode ? placement(graphDraft, recipeLayout, graphNode.id) : null

  const inspector = graph ? (
    graphNode ? (
      <fieldset className="bold-rp-readonly" disabled={viewing}>
        {where && (where.after.length > 0 || where.beside.length > 0) && (
          <p className="small muted rl-where">
            {where.after.length > 0 ? `Runs after ${where.after.join(', ')}` : 'Runs first'}
            {where.beside.length > 0 ? ` · beside ${where.beside.join(', ')}` : ''}
          </p>
        )}
        <NodeInspector
          draft={graphDraft}
          node={graphNode}
          agents={agents}
          issues={issuesForNode(index, graphDraft, graphNode.id)}
          commit={commit}
          onDelete={() => deleteNode(graphNode.id)}
          announce={setAnnouncement}
        />
        {!viewing && graphNode.kind !== 'end' && (
          <div className="rl-aside-add">
            <AddMenu
              label="Add a step after"
              text="Add a step after"
              at={{ after: graphNode.id }}
              agents={agents}
              onInsert={insertStep}
              withEnd
            />
          </div>
        )}
      </fieldset>
    ) : (
      <div className="wf-inspector wf-inspector--empty">
        <h3>Nothing selected</h3>
        <p className="small muted">
          Select a step on the graph, or a problem above, to edit it here.
        </p>
      </div>
    )
  ) : selectedRow ? (
    <RecipeInspector
      row={selectedRow}
      analysis={analysis}
      draft={draft}
      agents={agents}
      editable={analysis.listable && !viewing}
      commit={commit}
      patch={patch}
      point={(port, target) => point(selectedRow.node.id, port, target)}
    />
  ) : (
    <span className="muted small">Add a step to edit it.</span>
  )

  const problem = problems[0]
  const problemTarget = problem
    ? (problem.nodeId ??
      (problem.edgeId
        ? (graphDraft.edges.find((edge) => edge.id === problem.edgeId)?.from ?? null)
        : null))
    : null
  const status = checkFailed ? 'bad' : problems.length > 0 ? 'bad' : 'ok'
  // Everything one menu holds: the steps' history, running and exporting, and the rest of what a recipe can do.
  const noRun = dirty || checking || viewing
  return (
    <div className="bold-rp bold-re" data-ui-page="recipes">
      <section
        ref={root}
        className={`bold-rp-editor${sheet && graphNode ? ' bold-rp-main--sheet' : ''}`}
        aria-label="Recipe editor"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="bold-rp-head">
          <Link className="bold-rp-back" to={boldRecipesLink()}>
            ‹ Recipes
          </Link>
          <label className="wf-visually-hidden" htmlFor={nameId}>
            Recipe name
          </label>
          <input
            id={nameId}
            className="bold-rp-name"
            value={draft.name}
            maxLength={120}
            aria-invalid={draft.name.trim() === '' || undefined}
            disabled={viewing}
            onChange={(event) => commit({ ...draft, name: event.target.value }, 'name')}
          />
          <span className="bold-rp-meta">
            {saved.workflowId === null ? 'New recipe' : `version ${saved.version}`}
            {loadedFrom !== null ? ` · editing version ${loadedFrom}` : ''}
            {dirty || saved.workflowId === null ? ' · unsaved changes' : ''}
          </span>
          {recipe?.archivedAt && <span className="bold-badge bold-badge--quiet">Archived</span>}
          <span className="bold-rp-spacer" />
          <div className="bold-seg" role="tablist" aria-label="How to show the recipe">
            <button
              type="button"
              role="tab"
              aria-selected={graph}
              className={graph ? 'on' : undefined}
              onClick={() => setGraph(true)}
            >
              Graph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!graph}
              className={!graph ? 'on' : undefined}
              onClick={() => setGraph(false)}
            >
              As text
            </button>
          </div>
          <button
            type="button"
            className="bold-rp-pill"
            aria-label="Preview, nothing runs"
            disabled={previewing !== null || previewBlocked !== null || viewing}
            aria-describedby={previewBlocked ? 'bold-rp-preview-why' : undefined}
            title={previewBlocked ?? 'Play the recipe through without running anything'}
            onClick={() => {
              setPreviewing(draft)
              setGraph(true)
              setSel(null)
            }}
          >
            Preview
          </button>
          {previewBlocked && (
            <span id="bold-rp-preview-why" className="wf-visually-hidden">
              {previewBlocked}
            </span>
          )}
          <span className="bold-rp-more">
            <button
              type="button"
              className="bold-rp-dots"
              ref={moreButton}
              aria-label="More"
              aria-haspopup="true"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((value) => !value)}
            >
              ⋯
            </button>
            {moreOpen && (
              <div className="bold-rp-morepanel" role="group" aria-label="More">
                <div className="bold-rp-morerow">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!history.canUndo || viewing || previewing !== null}
                    onClick={history.undo}
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!history.canRedo || viewing || previewing !== null}
                    onClick={history.redo}
                  >
                    Redo
                  </button>
                </div>
                {saved.workflowId !== null && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={noRun}
                    title={dirty ? 'Save first: a run uses a saved version' : undefined}
                    onClick={() => void navigate(boldStartJobLink(saved.workflowId!))}
                  >
                    Run…
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm"
                  disabled={!saved.workflowId || dirty}
                  title={
                    !saved.workflowId
                      ? 'Save the recipe first: the export is a saved version.'
                      : dirty
                        ? 'Save first: the export is a saved version.'
                        : undefined
                  }
                  onClick={() => {
                    setMoreOpen(false)
                    setExporting(true)
                  }}
                >
                  Export
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={!saved.workflowId || dirty || save.isPending}
                  title={dirty ? 'Save first: a copy is made from the saved version.' : undefined}
                  onClick={duplicate}
                >
                  Duplicate
                </button>
                {versions.length > 0 && (
                  <label className="bold-lab">
                    View a saved version (read-only)
                    <select
                      className="bold-field"
                      value={viewVersion ?? ''}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setViewVersion(value || null)
                        setGraph(true)
                        setSel(null)
                        setPreviewing(null)
                        setMoreOpen(false)
                      }}
                    >
                      <option value="">Choose a version…</option>
                      {[...versions].reverse().map((version) => (
                        <option key={version.version} value={version.version}>
                          Version {version.version}
                          {version.used ? ' (used by runs)' : ''}, {version.nodes} steps
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {saved.workflowId && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={archive.isPending}
                    onClick={toggleArchive}
                  >
                    {recipe?.archivedAt ? 'Unarchive' : 'Archive'}
                  </button>
                )}
                {saved.workflowId && !recipe?.used && (
                  <button
                    type="button"
                    className="btn sm bold-danger"
                    disabled={remove.isPending}
                    onClick={removeRecipe}
                  >
                    {remove.isPending ? 'Deleting…' : 'Delete recipe'}
                  </button>
                )}
                {saved.workflowId && recipe?.used && (
                  <button
                    type="button"
                    className="btn sm bold-danger"
                    onClick={() => {
                      setMoreOpen(false)
                      setDeletingRuns(true)
                    }}
                  >
                    Delete with runs…
                  </button>
                )}
              </div>
            )}
          </span>
          <button
            type="button"
            className="bold-rp-save"
            disabled={!canSave}
            aria-label={save.isPending ? 'Saving…' : `Save as version ${saved.version + 1}`}
            title={
              problems.length > 0
                ? 'Fix the problems first'
                : checkFailed
                  ? "Score couldn't check this recipe. Try again before saving."
                  : checking
                    ? 'Score is still checking the recipe'
                    : undefined
            }
            onClick={onSave}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
        {recipe?.archivedAt && (
          <p className="small muted bold-rp-archived-note" role="status">
            Archived: this recipe is hidden from the library’s list and not offered in Start a job.
            Its past runs still open.{' '}
            <button type="button" className="bold-link" onClick={toggleArchive}>
              Unarchive
            </button>
          </p>
        )}

        <p className="wf-visually-hidden" role="status">
          {badge}
        </p>
        {(problems.length > 0 || checkFailed) && (
          <p className="bold-rp-problem" data-status={status}>
            <b>
              {checkFailed && problems.length === 0
                ? 'Score couldn’t check this recipe.'
                : `${problems.length} ${problems.length === 1 ? 'thing' : 'things'} to fix before saving:`}
            </b>{' '}
            {problem?.message}
            {problemTarget && (
              <>
                {' '}
                <button
                  type="button"
                  className="bold-link"
                  onClick={() => selectNode(problemTarget)}
                >
                  Show it
                </button>
              </>
            )}
          </p>
        )}
        {problems.length === 0 && warnings > 0 && (
          <p className="small muted">
            {warnings} {warnings === 1 ? 'warning' : 'warnings'} — saving is still allowed.
          </p>
        )}
        {notice && (
          <p className="small muted bold-recipes-notice" role="status">
            {notice}
          </p>
        )}
        <p className="wf-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {deletingRuns && saved.workflowId && (
          <DeleteWithRunsDialog
            name={detail?.name ?? draft.name}
            runs={runCount}
            pending={removeWithRuns.isPending}
            error={removeWithRuns.isError ? describeError(removeWithRuns.error) : ''}
            onCancel={() => {
              removeWithRuns.reset()
              setDeletingRuns(false)
              moreButton.current?.focus()
            }}
            onConfirm={(confirm) =>
              removeWithRuns.mutate(
                { id: saved.workflowId!, confirm },
                {
                  onSuccess: () => {
                    allowLeave.current = true
                    setDeletingRuns(false)
                    onDeleted(saved.workflowId!)
                  },
                },
              )
            }
          />
        )}

        {conflict !== null && (
          <section
            role="alert"
            data-protected="block"
            className="bold-inner bold-recipes-conflict"
            aria-label="Someone saved first"
          >
            <b>A newer version exists</b>
            <p>
              Version {conflict} was saved while you were editing version {saved.version}, from
              another tab or window. Your changes are still here and nothing was overwritten.
            </p>
            <div className="row wrap">
              <button
                type="button"
                className="btn sm primary"
                onClick={() => void reloadLatest(conflict)}
              >
                Reload version {conflict} (discard my edits)
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setSaved((current) => ({ ...current, version: conflict }))
                  setConflict(null)
                  onNotice(
                    `Your draft now builds on version ${conflict}. Save to add it as the next version.`,
                  )
                }}
              >
                Keep my draft and build on version {conflict}
              </button>
            </div>
          </section>
        )}

        {saveProblem && (
          <p role="alert" className="bold-error">
            {saveProblem}
          </p>
        )}

        {viewing && (
          <section
            className="bold-inner bold-recipes-graphnote"
            aria-label="Viewing a saved version"
          >
            <b>Version {viewVersion} (read-only)</b>
            <p>A saved version never changes. Edit a copy of it to make a new version.</p>
            <div className="row wrap">
              <button
                type="button"
                className="btn sm primary"
                disabled={!viewed.data}
                onClick={() => void loadOlder(viewVersion)}
              >
                Edit a copy of version {viewVersion}
              </button>
              <button type="button" className="btn sm" onClick={() => setViewVersion(null)}>
                Back to my draft
              </button>
            </div>
            {viewed.isError && (
              <p role="alert" className="bold-error">
                Couldn’t load that version.
              </p>
            )}
          </section>
        )}

        <div className="bold-rp-body">
          <section className="bold-rp-main" aria-label="The recipe">
            {graph ? (
              <div className="bold-rp-graph wf-editor">
                {overlay && previewing === null && !viewing && (
                  <p className="wf-live small" role="status">
                    <span className="wf-live__dot" aria-hidden="true" />
                    Live: run started {clock(overlay.run.createdAt)}{' '}
                    <Link to={boldRunLink(overlay.run.briefId)}>Open the run ›</Link>
                  </p>
                )}
                {previewing !== null ? (
                  <WorkflowPreview
                    key="preview"
                    draft={previewing}
                    agents={agents}
                    onStop={() => setPreviewing(null)}
                  />
                ) : viewing && !viewed.data ? (
                  <p role="status" className="muted">
                    Loading version {viewVersion}…
                  </p>
                ) : (
                  <RecipeLayers
                    readOnly={viewing}
                    states={viewing ? null : overlay?.nodes}
                    edges={viewing ? null : overlay?.edges}
                    draft={graphDraft}
                    agents={agents}
                    issues={index}
                    selected={selectedNodeId}
                    onSelect={selectNode}
                    onInsert={insertStep}
                    onDeleteNode={deleteNode}
                  />
                )}
                <details className="bold-rp-outline">
                  <summary>Outline: the graph as text</summary>
                  <Outline draft={graphDraft} issues={index} selected={sel} onSelect={setSel} />
                </details>
              </div>
            ) : (
              <div className="bold-rp-text">
                {analysis.listable ? null : (
                  <section
                    className="bold-inner bold-recipes-graphnote"
                    aria-label="Graph-only recipe"
                  >
                    <b>This recipe is easier to edit as a graph.</b>
                    <p>
                      {analysis.graphOnlyReasons.join(' ')} The step list can’t show every path
                      faithfully, so it is read-only here.
                    </p>
                    <button type="button" className="btn sm" onClick={() => setGraph(true)}>
                      Open the graph
                    </button>
                  </section>
                )}
                <ol className="bold-recipes-list" aria-label="Steps">
                  {analysis.rows.map((row) => (
                    <RecipeStepRow
                      key={row.node.id}
                      row={row}
                      analysis={analysis}
                      agents={agents}
                      editable={analysis.listable && !viewing}
                      selected={selectedRow?.node.id === row.node.id}
                      moveProblems={moveProblems.get(row.node.id) ?? { up: null, down: null }}
                      onSelect={() => selectNode(row.node.id)}
                      onMove={(direction) => move(row.node.id, direction)}
                      onRemove={() => removeStep(row.node.id)}
                      onTarget={point}
                    />
                  ))}
                </ol>
                {analysis.listable && !viewing && (
                  <div className="row wrap">
                    {(['agent', 'gate', 'branch', 'join', 'end'] as WorkflowNodeKind[]).map(
                      (kind) => (
                        <button
                          key={kind}
                          type="button"
                          className="btn sm ghost"
                          data-add-step={kind}
                          onClick={() => add(kind)}
                        >
                          <PlusIcon />
                          {kind === 'agent' ? 'Agent step' : RECIPE_STEP_LABEL[kind].split(' ·')[0]}
                        </button>
                      ),
                    )}
                  </div>
                )}
              </div>
            )}

            <details className="bold-inner bold-recipes-details">
              <summary>Recipe details</summary>
              <fieldset className="bold-recipes-details-fields" disabled={viewing}>
                <label className="bold-lab">
                  Description (optional)
                  <textarea
                    className="bold-field"
                    rows={2}
                    maxLength={500}
                    value={draft.description ?? ''}
                    onChange={(event) => {
                      const next = { ...draft }
                      if (event.target.value === '') delete next.description
                      else next.description = event.target.value
                      commit(next, 'description')
                    }}
                  />
                </label>
                <div className="wf-editor bold-recipes-inputs">
                  <InputsEditor draft={draft} commit={commit} issues={shape} />
                </div>
              </fieldset>
              {versions.length > 1 && (
                <label className="bold-lab">
                  Start from an older version
                  <select
                    className="bold-field"
                    value=""
                    onChange={(event) => {
                      const version = Number(event.target.value)
                      if (version) void loadOlder(version)
                    }}
                  >
                    <option value="">Choose a version…</option>
                    {[...versions].reverse().map((version) => (
                      <option key={version.version} value={version.version}>
                        Version {version.version}
                        {version.used ? ' (used by runs)' : ''}, {version.nodes} steps
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </details>
          </section>

          {(!sheet || graphNode) && (
            <aside
              ref={aside}
              className={`bold-inner bold-rp-aside bold-recipes-inspector wf-editor${sheet ? ' bold-rp-sheet' : ''}`}
              aria-label="Selected step"
              tabIndex={sheet ? -1 : undefined}
            >
              {sheet && (
                <div className="bold-rp-sheet-head">
                  <span className="bold-rp-sheet-grip" aria-hidden="true" />
                  <button
                    type="button"
                    className="bold-rp-sheet-close"
                    aria-label="Close step settings"
                    onClick={() => selectNode(null)}
                  >
                    ×
                  </button>
                </div>
              )}
              {sheet && graph && graphNode ? (
                <RecipeSheet
                  key={graphNode.id}
                  draft={graphDraft}
                  node={graphNode}
                  step={recipeLayout.stepOf.get(graphNode.id) ?? null}
                  agents={agents}
                  commit={commit}
                  onDelete={() => deleteNode(graphNode.id)}
                  readOnly={viewing}
                  more={inspector}
                />
              ) : (
                inspector
              )}
            </aside>
          )}
        </div>
      </section>

      {exporting && saved.workflowId && (
        <ExportDialog
          workflowId={saved.workflowId}
          version={saved.version}
          name={draft.name}
          close={() => setExporting(false)}
        />
      )}
    </div>
  )
}
