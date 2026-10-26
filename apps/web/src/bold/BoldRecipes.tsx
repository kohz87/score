import { boldRunLink } from './bold-links.ts'
import {
  type AgentSummary,
  type WorkflowDetail,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowSummary,
} from '@score/contract'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'
import { statusLabel } from '../routes/orchestrations/orch-model.ts'
import { graphOutcomeLabel } from '../routes/workflows/workflow-run-model.ts'
import { ApiError } from '../data/api.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { clock } from '../live/resolved.ts'
import { pairingProblem } from './bold-errors.ts'
import { boldRecipesLink, boldStartJobLink } from './bold-links.ts'
import { taskAgentsQuery } from '../data/task-queries.ts'
import { EditorCanvas, type Selection } from '../routes/workflows/EditorCanvas.tsx'
import { ExportDialog } from '../routes/workflows/ExportDialog.tsx'
import { InputsEditor, IssueList, Outline, Palette } from '../routes/workflows/EditorParts.tsx'
import { NodeInspector } from '../routes/workflows/NodeInspector.tsx'
import { WorkflowPreview } from '../routes/workflows/PreviewRun.tsx'
import { useDraftHistory } from '../routes/workflows/use-draft-history.ts'
import { useLiveOverlay } from '../routes/workflows/use-live-overlay.ts'
import { placeNewNode } from '../routes/workflows/workflow-layout.ts'
import {
  addNode,
  connect,
  disconnect,
  portsOf,
  removeNode,
  sameDraft,
  starterDraft,
  updateNode,
  type Draft,
} from '../routes/workflows/workflow-model.ts'
import {
  fetchWorkflowVersion,
  latestVersionOf,
  useDeleteWorkflow,
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
  summaryLine,
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
import '../routes/orchestrations/orchestrations.css'
import '../routes/workflows/workflows.css'
import { PlusIcon } from './BoldIcons.tsx'
import './bold-recipes.css'

// PLAN 11.10d, rebuilt as a page in 2.8.0 (decision 131, board C). A recipe is a 7.1 workflow: this page lists them
// next to the built-in "lead decides", and edits one as a graph (the full editor: add, connect, move, delete, keyboard
// on the canvas, preview, live states of a running copy) or "As text" (the step list). The step settings sit beside
// both. docs/design/bold/prototype.html (mRecipe) is binding for colours and shapes; the page layout is the approved
// mock-up's. Starting a run stays in Start a job (the editor's Run opens it with this recipe chosen).

const BUILT_IN = 'lead-decides'

function problemKey(problem: RecipeProblem): string {
  return `${problem.code}|${problem.nodeId ?? ''}|${problem.message}`
}

function dedupeProblems(problems: RecipeProblem[]): RecipeProblem[] {
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
    return 'Score found a problem with this recipe. The problem lines above say what.'
  return error.message
}

/** The route: `/b/recipes`, `/b/recipes/new`, `/b/recipes/lead-decides` or `/b/recipes/:workflowId`. */
export function BoldRecipesPage() {
  const { workflowId } = useParams()
  const navigate = useNavigate()
  const workflows = useWorkflows()
  const agentsQuery = useStreamQuery(taskAgentsQuery)
  const agents = agentsQuery.data ?? []
  const [newKey, setNewKey] = useState(0)
  const [notice, setNotice] = useState('')
  const recipes = useMemo(() => workflows.data?.items ?? [], [workflows.data])
  const selected = workflowId ?? recipes[0]?.id ?? (workflows.isPending ? null : 'new')
  const isReal = selected !== null && selected !== 'new' && selected !== BUILT_IN
  const detail = useWorkflow(isReal ? selected : undefined)
  const newDraft = useMemo(() => {
    const starter = starterDraft(
      agents.find((agent) => !agent.runtime || agent.runtime === 'hermes')?.id ??
        agents[0]?.id ??
        '',
    )
    return { ...starter, name: 'Untitled recipe' }
    // A new recipe is made once per press of "New recipe"; the agent list only seeds its first step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newKey])

  const choose = useCallback(
    (id: string) => {
      setNotice('')
      void navigate(boldRecipesLink(id))
    },
    [navigate],
  )
  const startNew = useCallback(() => {
    setNotice('')
    setNewKey((value) => value + 1)
    void navigate(boldRecipesLink('new'))
  }, [navigate])

  const list = (
    <RecipeList recipes={recipes} selectedId={selected} onSelect={choose} onNew={startNew} />
  )

  if (selected === null || (isReal && !detail.data)) {
    return (
      <div className="bold-rp" data-ui-page="recipes">
        {list}
        <section className="bold-rp-main" aria-label="Recipe editor">
          {isReal && detail.isError ? (
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
          ) : agentsQuery.status === 'error' ? (
            <p role="alert" className="bold-error">
              Couldn’t load the team, so the recipe can’t choose agents.
            </p>
          ) : (
            <p role="status" className="muted">
              {selected === null ? 'Loading recipes…' : 'Loading the recipe…'}
            </p>
          )}
        </section>
      </div>
    )
  }

  if (selected === BUILT_IN)
    return (
      <div className="bold-rp" data-ui-page="recipes">
        {list}
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
    list,
    agents,
    notice,
    onSaved: (id: string, version: number) => {
      setNotice(`Saved as version ${version}.`)
      if (selected === 'new') after(id)
    },
    onDeleted: () => {
      setNotice('Deleted the recipe.')
      void navigate(boldRecipesLink(), { replace: true })
    },
    onDuplicated: (id: string) => {
      setNotice('Made a copy. It is saved as version 1.')
      after(id)
    },
    onNotice: setNotice,
  }
  return selected === 'new' ? (
    <BoldRecipeEditor
      key={`new-${newKey}`}
      detail={null}
      initialDefinition={newDraft}
      {...common}
    />
  ) : (
    <BoldRecipeEditor
      key={detail.data!.id}
      detail={detail.data!}
      initialDefinition={detail.data!.latest.definition}
      {...common}
    />
  )
}

/** What each recipe is for at a glance: its version and how its runs are going. */
function RecipeList({
  recipes,
  selectedId,
  onSelect,
  onNew,
}: {
  recipes: WorkflowSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const runs = useStreamQuery(workflowRunsQuery).data
  const [query, setQuery] = useState('')
  const searchId = useId()
  const needle = query.trim().toLowerCase()
  const shown = recipes.filter((recipe) => recipe.name.toLowerCase().includes(needle))
  const showLead = 'lead decides'.includes(needle)
  return (
    <nav className="bold-rp-list" aria-label="Recipes">
      <h1 className="bold-rp-h1">Recipes</h1>
      <div className="row">
        <label htmlFor={searchId} className="wf-visually-hidden">
          Find a recipe
        </label>
        <input
          id={searchId}
          className="bold-field"
          type="search"
          placeholder="Find a recipe"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="bold-rp-new"
          aria-label="New recipe"
          title="New recipe"
          onClick={onNew}
        >
          <PlusIcon />
        </button>
      </div>
      {showLead && (
        <button
          type="button"
          className="bold-rp-row"
          aria-current={selectedId === BUILT_IN ? 'true' : undefined}
          onClick={() => onSelect(BUILT_IN)}
        >
          <span className="row">
            <b>lead decides</b>
            <span className="bold-badge bold-badge--quiet">Built in</span>
          </span>
          <span className="small muted">No fixed steps: lead plans each job</span>
        </button>
      )}
      {shown.map((recipe) => {
        const count = runs?.filter((run) => run.workflowId === recipe.id).length ?? 0
        const facts =
          recipe.activeRuns > 0
            ? 'running now'
            : count > 0
              ? `${count} ${count === 1 ? 'run' : 'runs'}`
              : recipe.used
                ? 'used by runs'
                : 'not used yet'
        return (
          <button
            key={recipe.id}
            type="button"
            className="bold-rp-row"
            aria-current={selectedId === recipe.id ? 'true' : undefined}
            onClick={() => onSelect(recipe.id)}
          >
            <b>{recipe.name}</b>
            <span className="small muted">
              Version {recipe.latestVersion} · {facts}
            </span>
          </button>
        )
      })}
      {recipes.length > 0 && shown.length === 0 && !showLead && (
        <p className="small muted" role="status">
          No recipe matches “{query}”.
        </p>
      )}
      {recipes.length === 0 && (
        <p className="small muted">
          No saved recipes yet. Start with the plus: an agent step, a gate for your approval and an
          end.
        </p>
      )}
    </nav>
  )
}

/** What only the classic workflow list showed: the runs going and the last run, linking to that run's page. */
function RecipeRunStatus({ recipe }: { recipe: WorkflowSummary | undefined }) {
  const runs = useStreamQuery(workflowRunsQuery).data
  if (!recipe) return null
  // Newest first, as the classic list reads it.
  const last = runs?.find((run) => run.workflowId === recipe.id)
  return (
    <span className="small muted bold-recipe-runs" aria-label="Runs of this recipe">
      {recipe.activeRuns > 0 && (
        <b className="bold-recipe-going">
          {recipe.activeRuns} {recipe.activeRuns === 1 ? 'run' : 'runs'} going
        </b>
      )}
      {last ? (
        <>
          {' '}
          Last run: <Link to={boldRunLink(last.briefId)}>{statusLabel[last.status]}</Link>
          {last.graphOutcome ? `, ${graphOutcomeLabel[last.graphOutcome].toLowerCase()}` : ''}
        </>
      ) : (
        ' No runs yet'
      )}
    </span>
  )
}

function BoldRecipeEditor({
  detail,
  initialDefinition,
  recipes,
  list,
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
  list: ReactNode
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
  const root = useRef<HTMLElement>(null)
  const allowLeave = useRef(false)
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
        .map((issue) => ({ code: issue.code, message: issue.message, nodeId: issue.nodeId })),
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

  /** The graph's add: a step connected after the selected one (or dropped onto a step), placed beside it. */
  function addAfter(
    kind: WorkflowNodeKind,
    agentId = '',
    after: string | null = graphNode?.id ?? null,
  ) {
    const result = addNode(draft, kind, agentId)
    if ('error' in result) {
      setAnnouncement(result.error)
      return
    }
    let next = result.draft
    const source = after ? next.nodes.find((node) => node.id === after) : undefined
    const agent = agents.find((item) => item.id === agentId)
    if (kind === 'agent' && agent)
      next = updateNode(next, result.id, { label: `${agent.name} step` })
    let note = `Added ${kind === 'agent' && agent ? `${agent.name} step` : kind}.`
    if (source && source.kind !== 'end') {
      // The first way out of the selected node that leads nowhere yet (never a failure or rejection route).
      const free = portsOf(source).find(
        (port) =>
          port.id !== 'failed' &&
          port.id !== 'rejected' &&
          !next.edges.some((edge) => edge.from === source.id && edge.port === port.id),
      )
      if (free) {
        const joined = connect(next, source.id, free.id, result.id)
        if ('draft' in joined) {
          next = joined.draft
          note = `${note} Connected after ${source.label}.`
        }
      }
      if (kind === 'branch' && source.kind === 'agent')
        next = updateNode(next, result.id, { subject: source.id })
    }
    next = placeNewNode(next, result.id, new Map(), after)
    commit(next)
    setSel({ kind: 'node', id: result.id })
    setAnnouncement(note)
  }

  function deleteNode(id: string) {
    const label = draft.nodes.find((node) => node.id === id)?.label ?? id
    commit(removeNode(draft, id))
    setSel(null)
    setAnnouncement(`Removed ${label}.`)
  }

  function deleteEdge(id: string) {
    commit(disconnect(draft, id))
    setSel(null)
    setAnnouncement('Removed the connection.')
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

  const inspector = graph ? (
    graphNode ? (
      <fieldset className="bold-rp-readonly" disabled={viewing}>
        <NodeInspector
          draft={graphDraft}
          node={graphNode}
          agents={agents}
          issues={issuesForNode(index, graphDraft, graphNode.id)}
          commit={commit}
          onDelete={() => deleteNode(graphNode.id)}
          announce={setAnnouncement}
        />
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

  return (
    <div className="bold-rp" data-ui-page="recipes">
      {list}

      <section
        ref={root}
        className="bold-rp-main"
        aria-label="Recipe editor"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="bold-rp-head">
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
          <span
            className={`bold-badge ${problems.length > 0 || checkFailed ? 'bold-badge--bad' : 'bold-badge--ok'}`}
            role="status"
          >
            {badge}
          </span>
          <span className="small muted">
            {saved.workflowId === null ? 'New recipe' : `Version ${saved.version}`}
            {loadedFrom !== null ? ` · editing version ${loadedFrom}` : ''}
            {dirty || saved.workflowId === null ? ' · unsaved changes' : ''} · inputs:{' '}
            {draft.inputs.length > 0 ? draft.inputs.map((input) => input.name).join(', ') : 'none'}
          </span>
          {saved.workflowId !== null && (
            <RecipeRunStatus recipe={recipes.find((recipe) => recipe.id === saved.workflowId)} />
          )}
        </div>

        <div className="bold-rp-bar">
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
          <span className="row bold-recipes-actions" style={{ marginLeft: 'auto' }}>
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
            <button
              type="button"
              className="btn sm"
              disabled={previewing !== null || previewBlocked !== null || viewing}
              aria-describedby={previewBlocked ? 'bold-rp-preview-why' : undefined}
              title={previewBlocked ?? 'Play the recipe through without running anything'}
              onClick={() => {
                setPreviewing(draft)
                setGraph(true)
                setSel(null)
              }}
            >
              Preview, nothing runs
            </button>
            {previewBlocked && (
              <span id="bold-rp-preview-why" className="wf-visually-hidden">
                {previewBlocked}
              </span>
            )}
            {saved.workflowId !== null && (
              <button
                type="button"
                className="btn sm"
                disabled={dirty || checking || viewing}
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
              onClick={() => setExporting(true)}
            >
              Export
            </button>
            <span className="bold-rp-more">
              <button
                type="button"
                className="btn sm"
                aria-haspopup="true"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((value) => !value)}
              >
                More
              </button>
              {moreOpen && (
                <div className="bold-rp-morepanel" role="group" aria-label="More">
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
                      className="btn sm bold-danger"
                      disabled={remove.isPending}
                      onClick={removeRecipe}
                    >
                      {remove.isPending ? 'Deleting…' : 'Delete recipe'}
                    </button>
                  )}
                </div>
              )}
            </span>
            <button
              type="button"
              className="btn sm primary"
              disabled={!canSave}
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
              {save.isPending ? 'Saving…' : `Save as version ${saved.version + 1}`}
            </button>
          </span>
        </div>

        {notice && (
          <p className="small muted bold-recipes-notice" role="status">
            {notice}
          </p>
        )}
        <p className="wf-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>

        {!graph && problems.length > 0 && (
          <div className="small bold-recipes-problems" role="status">
            {problems.map((problem) => (
              <div key={problemKey(problem)}>
                {problem.nodeId ? (
                  <button
                    type="button"
                    className="bold-link"
                    onClick={() => selectNode(problem.nodeId)}
                  >
                    {problem.message}
                  </button>
                ) : (
                  problem.message
                )}
              </div>
            ))}
          </div>
        )}
        {!graph && warnings > 0 && (
          <p className="small muted">
            {warnings} {warnings === 1 ? 'warning' : 'warnings'} — saving is still allowed.
          </p>
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
              <EditorCanvas
                readOnly={viewing}
                overlay={viewing ? null : overlay}
                draft={graphDraft}
                agents={agents}
                issues={index}
                selected={sel}
                onSelect={setSel}
                onConnect={(from, port, to) => {
                  const result = connect(draft, from, port, to)
                  if ('error' in result) return result.error
                  commit(result.draft)
                  const names = (id: string) =>
                    draft.nodes.find((node) => node.id === id)?.label ?? id
                  setAnnouncement(`Connected ${names(from)} to ${names(to)}.`)
                  return null
                }}
                onDropKind={(payload, onto) => addAfter(payload.kind, payload.agentId, onto)}
                onDeleteNode={deleteNode}
                onDeleteEdge={deleteEdge}
                onLayout={(next, key) => commit(next, key)}
                announce={setAnnouncement}
              />
            )}
            {!viewing && previewing === null && (
              <Palette
                agents={agents}
                onAdd={(kind, agentId) => addAfter(kind, agentId)}
                disabled={false}
              />
            )}
            <IssueList
              issues={issues}
              draft={graphDraft}
              onSelect={setSel}
              checking={checking}
              headline={summaryLine(index, checking)}
            />
            <details className="bold-rp-outline">
              <summary>Outline: the graph as text</summary>
              <Outline draft={graphDraft} issues={index} selected={sel} onSelect={setSel} />
            </details>
          </div>
        ) : (
          <div className="bold-rp-text">
            {analysis.listable ? null : (
              <section className="bold-inner bold-recipes-graphnote" aria-label="Graph-only recipe">
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
                {(['agent', 'gate', 'branch', 'join', 'end'] as WorkflowNodeKind[]).map((kind) => (
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
                ))}
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

      <aside
        className="bold-inner bold-rp-aside bold-recipes-inspector wf-editor"
        aria-label="Selected step"
      >
        {inspector}
      </aside>

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
