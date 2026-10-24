import {
  type AgentSummary,
  type BranchCondition,
  type WorkflowDetail,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowSummary,
} from '@score/contract'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { runtimeLabel } from '../components/runtime-label.ts'
import { ApiError } from '../data/api.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { taskAgentsQuery } from '../routes/tasks/task-queries.ts'
import { EditorCanvas, type Selection } from '../routes/workflows/EditorCanvas.tsx'
import { ExportDialog } from '../routes/workflows/ExportDialog.tsx'
import { InputsEditor } from '../routes/workflows/EditorParts.tsx'
import { TemplateField } from '../routes/workflows/TemplateField.tsx'
import { useDraftHistory } from '../routes/workflows/use-draft-history.ts'
import {
  addRule,
  removeRule,
  sameDraft,
  starterDraft,
  updateNode,
  updateRule,
  type Draft,
} from '../routes/workflows/workflow-model.ts'
import {
  fetchWorkflowVersion,
  latestVersionOf,
  useDeleteWorkflow,
  useSaveWorkflow,
  useValidation,
  useWorkflow,
  useWorkflows,
} from '../routes/workflows/workflow-queries.ts'
import { combine, indexIssues, shapeIssues } from '../routes/workflows/workflow-validation.ts'
import {
  RECIPE_STEP_LABEL,
  RECIPE_STEP_MARK,
  addRecipeStep,
  analyzeRecipe,
  moveRecipeStepProblem,
  planRecipeMove,
  recipeClientProblems,
  removeRecipeStep,
  setFailureMode,
  setPortTarget,
  setRejectMode,
  targetStepLabel,
  type RecipeAnalysis,
  type RecipeProblem,
  type RecipeRow,
} from './recipe-model.ts'
import '../routes/orchestrations/orchestrations.css'
import '../routes/workflows/workflows.css'
import { PlusIcon, TrashIcon } from './BoldIcons.tsx'
import './bold-recipes.css'

// PLAN 11.10d: the recipe editor on the bold shell. A recipe is a 7.1 workflow; this dialog is a step-list face over
// the same definition and the same API. The prototype (docs/design/bold/prototype.html, mRecipe) is binding for the
// screen. Two things deliberately differ: a graph that fans out from one port can't be shown faithfully as a list (it
// opens read-only, with a way to the classic graph editor), and undo/redo is the prototype's keyboard pair rather than
// extra buttons.

const AGENT_KINDS = new Set(['hermes', 'claude-code', 'codex'])

type ConditionKey =
  | 'verdict:passed'
  | 'verdict:changes_requested'
  | 'outcome:succeeded'
  | 'outcome:failed'
  | 'output_contains'

function conditionKey(when: BranchCondition): ConditionKey {
  if (when.kind === 'verdict') return `verdict:${when.is}`
  if (when.kind === 'outcome') return `outcome:${when.is}`
  return 'output_contains'
}

function conditionFrom(key: ConditionKey, current: BranchCondition): BranchCondition {
  if (key === 'verdict:passed') return { kind: 'verdict', is: 'passed' }
  if (key === 'verdict:changes_requested') return { kind: 'verdict', is: 'changes_requested' }
  if (key === 'outcome:succeeded') return { kind: 'outcome', is: 'succeeded' }
  if (key === 'outcome:failed') return { kind: 'outcome', is: 'failed' }
  return { kind: 'output_contains', text: current.kind === 'output_contains' ? current.text : '' }
}

function refusalsFor(runtime: AgentSummary['runtime']): boolean {
  return runtime !== undefined && runtime !== null && !AGENT_KINDS.has(runtime)
}

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
  if (!(error instanceof ApiError)) return 'Couldn’t do that. Try again.'
  if (error.code === 'workflow_used')
    return 'This recipe has runs, so it can’t be deleted. Delete is only for recipes nothing has run.'
  if (error.code === 'quota_exhausted')
    return 'This recipe has as many saved versions as Score keeps (or there are too many recipes). Delete one you don’t use.'
  if (error.code === 'invalid_definition')
    return 'Score found a problem with this recipe. The problem lines above say what.'
  return error.message
}

export function BoldRecipes({ onClose }: { onClose: () => void }) {
  const workflows = useWorkflows()
  const agentsQuery = useStreamQuery(taskAgentsQuery)
  const agents = agentsQuery.data ?? []
  const [selection, setSelection] = useState<string | null>(null)
  const [newKey, setNewKey] = useState(0)
  const [notice, setNotice] = useState('')
  const recipes = useMemo(() => workflows.data?.items ?? [], [workflows.data])
  const selected = selection ?? recipes[0]?.id ?? 'new'
  const detail = useWorkflow(selected !== 'new' ? selected : undefined)
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

  const choose = useCallback((id: string) => {
    setNotice('')
    setSelection(id)
  }, [])

  const startNew = useCallback(() => {
    setNotice('')
    setNewKey((value) => value + 1)
    setSelection('new')
  }, [])

  const deleted = useCallback(
    (id: string) => {
      const next = recipes.find((recipe) => recipe.id !== id)?.id ?? 'new'
      setNotice('Deleted the recipe.')
      setSelection(next)
    },
    [recipes],
  )

  const content =
    selection === null && workflows.isPending ? (
      <BoldRecipeShell
        recipes={recipes}
        selectedId={selected}
        onSelect={choose}
        onNew={startNew}
        onClose={onClose}
      >
        <p role="status" className="muted">
          Loading recipes…
        </p>
      </BoldRecipeShell>
    ) : selected === 'new' ? (
      <BoldRecipeEditor
        key={`new-${newKey}`}
        detail={null}
        initialDefinition={newDraft}
        recipes={recipes}
        selectedId="new"
        agents={agents}
        notice={notice}
        onSelect={choose}
        onNew={startNew}
        onSaved={(id, version) => {
          setNotice(`Saved as version ${version}.`)
          setSelection(id)
        }}
        onDeleted={deleted}
        onNotice={setNotice}
        onClose={onClose}
      />
    ) : detail.data ? (
      <BoldRecipeEditor
        key={detail.data.id}
        detail={detail.data}
        initialDefinition={detail.data.latest.definition}
        recipes={recipes}
        selectedId={detail.data.id}
        agents={agents}
        notice={notice}
        onSelect={choose}
        onNew={startNew}
        onSaved={(id, version) => {
          setNotice(`Saved as version ${version}.`)
          setSelection(id)
        }}
        onDeleted={deleted}
        onNotice={setNotice}
        onClose={onClose}
      />
    ) : (
      <BoldRecipeShell
        recipes={recipes}
        selectedId={selected}
        onSelect={choose}
        onNew={startNew}
        onClose={onClose}
      >
        {detail.isError ? (
          <p role="alert" className="bold-error">
            Couldn’t load this recipe. Try again or choose another.
          </p>
        ) : agentsQuery.status === 'error' ? (
          <p role="alert" className="bold-error">
            Couldn’t load the team, so the recipe can’t choose agents.
          </p>
        ) : (
          <p role="status" className="muted">
            Loading the recipe…
          </p>
        )}
      </BoldRecipeShell>
    )

  return content
}

function BoldRecipeShell({
  recipes,
  selectedId,
  onSelect,
  onNew,
  onClose,
  children,
}: {
  recipes: WorkflowSummary[]
  selectedId: string
  onSelect: (id: string) => void
  onNew: () => void
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="bold-scrim">
      <div className="bold-dialog wide" role="dialog" aria-modal="true" aria-label="Recipe editor">
        <span className="row wrap">
          <h2 className="bold-recipes-title">Recipes</h2>
          <RecipeSwitcher
            recipes={recipes}
            selectedId={selectedId}
            onSelect={onSelect}
            onNew={onNew}
          />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </span>
        {children}
      </div>
    </div>
  )
}

function RecipeSwitcher({
  recipes,
  selectedId,
  onSelect,
  onNew,
}: {
  recipes: WorkflowSummary[]
  selectedId: string
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className="bold-seg" role="group" aria-label="Recipes">
      {recipes.map((recipe) => (
        <button
          key={recipe.id}
          type="button"
          className={selectedId === recipe.id ? 'on' : undefined}
          aria-pressed={selectedId === recipe.id}
          onClick={() => onSelect(recipe.id)}
        >
          {recipe.name}
        </button>
      ))}
      <button
        type="button"
        className={selectedId === 'new' ? 'on' : undefined}
        aria-pressed={selectedId === 'new'}
        onClick={onNew}
      >
        New recipe
      </button>
    </div>
  )
}

function BoldRecipeEditor({
  detail,
  initialDefinition,
  recipes,
  selectedId,
  agents,
  notice,
  onSelect,
  onNew,
  onSaved,
  onDeleted,
  onNotice,
  onClose,
}: {
  detail: WorkflowDetail | null
  initialDefinition: Draft
  recipes: WorkflowSummary[]
  selectedId: string
  agents: AgentSummary[]
  notice: string
  onSelect: (id: string) => void
  onNew: () => void
  onSaved: (id: string, version: number) => void
  onDeleted: (id: string) => void
  onNotice: (text: string) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const history = useDraftHistory<Draft>(initialDefinition)
  const { draft, commit } = history
  const analysis = useMemo(() => analyzeRecipe(draft), [draft])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    () => analysis.rows[0]?.node.id ?? null,
  )
  const [saved, setSaved] = useState(() => ({
    workflowId: detail?.id ?? null,
    version: detail?.latestVersion ?? 0,
    definition: initialDefinition,
  }))
  const [graph, setGraph] = useState(() => !analysis.listable)
  const [conflict, setConflict] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [loadedFrom, setLoadedFrom] = useState<number | null>(null)
  const [saveProblem, setSaveProblem] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const save = useSaveWorkflow()
  const remove = useDeleteWorkflow()
  const dialog = useRef<HTMLDivElement>(null)
  const nameId = useId()

  useEffect(() => {
    dialog.current?.focus()
  }, [])

  const shape = useMemo(() => shapeIssues(draft), [draft])
  const validation = useValidation(shape.length === 0 ? draft : null)
  const index = useMemo(
    () => indexIssues(combine(shape, validation.data)),
    [shape, validation.data],
  )
  const clientProblems = useMemo(
    () => recipeClientProblems(draft, analysis.order),
    [draft, analysis.order],
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
    problems.length === 0 && !checking && !checkFailed && analysis.listable && !save.isPending
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

  const selectNode = useCallback((id: string | null) => setSelectedNodeId(id), [])

  const patch = useCallback(
    (change: Partial<WorkflowNode>, coalesce?: string) => {
      if (!selectedRow) return
      commit(updateNode(draft, selectedRow.node.id, change), coalesce)
    },
    [commit, draft, selectedRow],
  )

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
    setSelectedNodeId(result.id)
  }

  function removeStep(id: string) {
    if (!analysis.listable) return
    const order = analysis.order
    const at = order.findIndex((node) => node.id === id)
    const label = order[at]?.label || id
    const next = order[at + 1]?.id ?? order[at - 1]?.id ?? null
    commit(removeRecipeStep(draft, id))
    setSelectedNodeId(next)
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
    setSelectedNodeId(id)
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
          setSaved({ workflowId: version.workflowId, version: version.version, definition: draft })
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
      setSelectedNodeId(loaded.definition.nodes[0]?.id ?? null)
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
      setSelectedNodeId(loaded.definition.nodes[0]?.id ?? null)
      setLoadedFrom(version)
      onNotice(`Loaded version ${version} into the draft. Saving makes it a new version.`)
    } catch {
      onNotice('Couldn’t load that version.')
    }
  }

  function removeRecipe() {
    if (!saved.workflowId || !window.confirm(`Delete ${draft.name}? Its saved versions go too.`))
      return
    onNotice('')
    remove.mutate(saved.workflowId, {
      onSuccess: () => onDeleted(saved.workflowId!),
      onError: (error) => onNotice(describeError(error)),
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null
    const typing =
      !!target &&
      (target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        !!target.closest('.cm-editor'))
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      // A text field keeps its native undo; the recipe history is for the step list itself.
      if (typing) return
      event.preventDefault()
      if (event.shiftKey) history.redo()
      else history.undo()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
    }
  }

  function requestClose() {
    if (dirty && !window.confirm('You have unsaved changes. Close without saving?')) return
    onClose()
  }

  function focusStep(id: string | null, control: 'row' | 'up' | 'down') {
    requestAnimationFrame(() => {
      if (id === null) {
        dialog.current?.focus()
        return
      }
      const row = dialog.current?.querySelector<HTMLElement>(`[data-recipe-step="${id}"]`)
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

  const graphSelection: Selection = selectedRow ? { kind: 'node', id: selectedRow.node.id } : null

  return (
    <div
      className="bold-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={dialog}
        className="bold-dialog wide"
        role="dialog"
        aria-modal="true"
        aria-label="Recipe editor"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <span className="row wrap">
          <h2 className="bold-recipes-title">Recipes</h2>
          <RecipeSwitcher
            recipes={recipes}
            selectedId={selectedId}
            onSelect={onSelect}
            onNew={onNew}
          />
          <button type="button" className="icon-btn" aria-label="Close" onClick={requestClose}>
            ×
          </button>
        </span>

        {notice && (
          <p className="small muted bold-recipes-notice" role="status">
            {notice}
          </p>
        )}
        <p className="wf-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>

        <div className="row wrap">
          <span
            className={`bold-badge ${problems.length > 0 ? 'bold-badge--bad' : 'bold-badge--ok'}`}
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
          <span className="row bold-recipes-actions" style={{ marginLeft: 'auto' }}>
            <button type="button" className="btn sm" onClick={() => setGraph((value) => !value)}>
              {graph ? 'Show as list' : 'Show as graph'}
            </button>
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
                      : analysis.listable
                        ? undefined
                        : 'This recipe can only be edited in the graph editor'
              }
              onClick={onSave}
            >
              {save.isPending ? 'Saving…' : `Save as version ${saved.version + 1}`}
            </button>
          </span>
        </div>

        {problems.length > 0 && (
          <div className="small bold-recipes-problems" role="status">
            {problems.map((problem) => (
              <div key={problemKey(problem)}>
                {problem.nodeId ? (
                  <button
                    type="button"
                    className="bold-link"
                    onClick={() => {
                      selectNode(problem.nodeId)
                      setGraph(false)
                    }}
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
        {warnings > 0 && (
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

        {!analysis.listable && (
          <section className="bold-inner bold-recipes-graphnote" aria-label="Graph-only recipe">
            <b>This recipe needs the graph editor.</b>
            <p>
              {analysis.graphOnlyReasons.join(' ')} The step list can’t show every path faithfully,
              so it is read-only here.
            </p>
            {saved.workflowId && (
              <Link
                className="btn sm"
                to={`/now/flow/workflows/${encodeURIComponent(saved.workflowId)}`}
              >
                Edit this one in the graph editor
              </Link>
            )}
          </section>
        )}

        <details className="bold-inner bold-recipes-details">
          <summary>Recipe details</summary>
          <fieldset className="bold-recipes-details-fields" disabled={!analysis.listable}>
            <label className="bold-lab" htmlFor={nameId}>
              Name
            </label>
            <input
              id={nameId}
              className="bold-field"
              value={draft.name}
              maxLength={120}
              onChange={(event) => commit({ ...draft, name: event.target.value }, 'name')}
            />
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
          {saved.workflowId && (
            <div className="row wrap">
              <button
                type="button"
                className="btn sm bold-danger"
                disabled={remove.isPending}
                onClick={removeRecipe}
              >
                {remove.isPending ? 'Deleting…' : 'Delete recipe'}
              </button>
            </div>
          )}
        </details>

        <div className="bold-recipes-columns">
          <div className="bold-recipes-listcol">
            {graph ? (
              <div className="bold-inner bold-recipes-graph">
                <p className="small muted">
                  Read-only graph. Edit the steps in the list, or open the classic graph editor for
                  connections and positions.
                </p>
                <EditorCanvas
                  readOnly
                  draft={draft}
                  agents={agents}
                  issues={index}
                  selected={graphSelection}
                  onSelect={(selection) => {
                    if (selection?.kind === 'node') selectNode(selection.id)
                  }}
                  onConnect={() => 'This graph is read-only.'}
                  onDropKind={() => undefined}
                  onDeleteNode={() => undefined}
                  onDeleteEdge={() => undefined}
                  onLayout={() => undefined}
                  announce={() => undefined}
                />
                {saved.workflowId && (
                  <Link
                    className="btn sm"
                    to={`/now/flow/workflows/${encodeURIComponent(saved.workflowId)}`}
                  >
                    Open the graph editor
                  </Link>
                )}
              </div>
            ) : (
              <>
                <ol className="bold-recipes-list" aria-label="Steps">
                  {analysis.rows.map((row) => (
                    <RecipeStepRow
                      key={row.node.id}
                      row={row}
                      analysis={analysis}
                      agents={agents}
                      editable={analysis.listable}
                      selected={selectedRow?.node.id === row.node.id}
                      moveProblems={moveProblems.get(row.node.id) ?? { up: null, down: null }}
                      onSelect={() => selectNode(row.node.id)}
                      onMove={(direction) => move(row.node.id, direction)}
                      onRemove={() => removeStep(row.node.id)}
                      onTarget={point}
                    />
                  ))}
                </ol>
                {analysis.listable && (
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
              </>
            )}
          </div>

          <div className="bold-inner bold-recipes-inspector wf-editor" aria-label="Step inspector">
            {selectedRow ? (
              <RecipeInspector
                row={selectedRow}
                analysis={analysis}
                draft={draft}
                agents={agents}
                editable={analysis.listable}
                commit={commit}
                patch={patch}
                point={(port, target) => point(selectedRow.node.id, port, target)}
              />
            ) : (
              <span className="muted small">Add a step to edit it.</span>
            )}
          </div>
        </div>
      </div>

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

function RecipeStepRow({
  row,
  analysis,
  agents,
  editable,
  selected,
  moveProblems,
  onSelect,
  onMove,
  onRemove,
  onTarget,
}: {
  row: RecipeRow
  analysis: RecipeAnalysis
  agents: AgentSummary[]
  editable: boolean
  selected: boolean
  moveProblems: { up: string | null; down: string | null }
  onSelect: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  onTarget: (nodeId: string, port: string, target: string | null) => void
}) {
  const node = row.node
  const label = node.label || node.id
  const agent = node.kind === 'agent' ? agents.find((item) => item.id === node.agentId) : undefined
  const incoming = row.incoming
    .map((edge) => analysis.order.find((item) => item.id === edge.from)?.label || edge.from)
    .join(', ')
  return (
    <li className={`bold-recipes-row${selected ? ' sel' : ''}`} data-recipe-step={node.id}>
      <div className="bold-recipes-rowmain">
        <button
          type="button"
          className={`bold-step${selected ? ' sel' : ''}`}
          aria-current={selected ? 'true' : undefined}
          onClick={onSelect}
        >
          <span className="mono small muted">{row.index + 1}</span>
          {agent ? (
            <AgentGlyph agent={agent} size="xs" plain decorative />
          ) : node.kind === 'agent' ? (
            <span className="bold-step-mark bold-step-mark--missing" aria-hidden="true">
              ?
            </span>
          ) : (
            <span className="bold-step-mark" aria-hidden="true">
              {RECIPE_STEP_MARK[node.kind]}
            </span>
          )}
          <span className="grow bold-step-copy">
            <b>{label}</b>
            <span className="small muted">
              {RECIPE_STEP_LABEL[node.kind]}
              {node.kind === 'agent'
                ? ` · ${node.agentId || 'no agent'} · retries ${node.retries}`
                : ''}
            </span>
            {node.kind === 'join' && (
              <span className="small muted">Waits for {incoming || 'nothing yet'}.</span>
            )}
            {node.kind === 'branch' && (
              <span className="small muted">
                Looks at{' '}
                {analysis.order.find((item) => item.id === node.subject)?.label ||
                  node.subject ||
                  'no step yet'}
                .
              </span>
            )}
          </span>
        </button>
        <div className="bold-recipes-rowactions">
          <button
            type="button"
            className="icon-btn sm"
            data-move="up"
            aria-label={`Move ${label} up`}
            title={moveProblems.up ?? `Move ${label} up`}
            disabled={!editable || moveProblems.up !== null}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-move="down"
            aria-label={`Move ${label} down`}
            title={moveProblems.down ?? `Move ${label} down`}
            disabled={!editable || moveProblems.down !== null}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn sm bold-recipes-remove"
            aria-label={`Remove ${label}`}
            disabled={!editable}
            onClick={onRemove}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      {node.kind === 'branch' && row.routes.length > 0 && (
        <div className="bold-recipes-routes">
          {row.routes.map((route) => {
            const value = route.edges[0]?.to ?? ''
            const unknown = value && !analysis.order.some((node) => node.id === value)
            return (
              <label key={route.port} className="bold-recipes-route">
                <span>{route.label} →</span>
                <select
                  aria-label={`${label}: ${route.label} goes to`}
                  value={value}
                  disabled={!editable}
                  onChange={(event) => onTarget(node.id, route.port, event.target.value || null)}
                >
                  <option value="">Not connected</option>
                  {unknown && <option value={value}>Missing step {value}</option>}
                  {analysis.order
                    .filter((target) => target.id !== node.id)
                    .map((target) => (
                      <option key={target.id} value={target.id}>
                        {targetStepLabel(analysis, target.id)}
                      </option>
                    ))}
                </select>
              </label>
            )
          })}
        </div>
      )}
    </li>
  )
}

function RecipeInspector({
  row,
  analysis,
  draft,
  agents,
  editable,
  commit,
  patch,
  point,
}: {
  row: RecipeRow
  analysis: RecipeAnalysis
  draft: Draft
  agents: AgentSummary[]
  editable: boolean
  commit: (next: Draft, coalesce?: string) => void
  patch: (change: Partial<WorkflowNode>, coalesce?: string) => void
  point: (port: string, target: string | null) => void
}) {
  const node = row.node
  const agentNodes = draft.nodes.filter((item) => item.kind === 'agent')
  const picked =
    node.kind === 'agent' ? agents.find((agent) => agent.id === node.agentId) : undefined
  const codingNote =
    picked?.runtime === 'claude-code' || picked?.runtime === 'codex'
      ? `${runtimeLabel(picked.runtime)} works on this computer, in its own workspace. Starting the run asks you to accept what it can read.`
      : null
  const doneRoute = row.routes.find((route) => route.port === 'ok')
  const failRoute = row.routes.find((route) => route.port === 'failed')
  const rejectRoute = row.routes.find((route) => route.port === 'rejected')
  return (
    <fieldset className="bold-recipes-fields" disabled={!editable}>
      <b>Step {row.index + 1}</b>
      <label className="orch-field">
        <span>Title</span>
        <input
          value={node.label}
          maxLength={80}
          disabled={!editable}
          onChange={(event) => patch({ label: event.target.value }, `label:${node.id}`)}
        />
      </label>

      {node.kind === 'agent' && (
        <>
          <label className="orch-field">
            <span>Agent</span>
            <select
              value={node.agentId}
              disabled={!editable}
              onChange={(event) => patch({ agentId: event.target.value })}
            >
              {node.agentId === '' && <option value="">Choose an agent…</option>}
              {node.agentId !== '' && !agents.some((agent) => agent.id === node.agentId) && (
                <option value={node.agentId}>{node.agentId} (not on this team)</option>
              )}
              {agents.map((agent) => {
                const cli = runtimeLabel(agent.runtime)
                const refused = refusalsFor(agent.runtime)
                return (
                  <option key={agent.id} value={agent.id} disabled={refused}>
                    {agent.name}
                    {cli ? ` · ${cli}` : ''}
                    {refused ? ' (can’t take workflow steps)' : ''}
                  </option>
                )
              })}
            </select>
          </label>
          {codingNote && <p className="small muted bold-recipes-hint">{codingNote}</p>}
          <TemplateField
            label="Instruction"
            value={node.instruction}
            onChange={(value) => patch({ instruction: value }, `instruction:${node.id}`)}
            draft={draft}
            nodeId={node.id}
            rows={7}
            invalid={node.instruction.trim() === ''}
          />
          <p className="small muted bold-recipes-hint">
            Use <code>{`{{inputs.${draft.inputs[0]?.name ?? 'name'}}}`}</code> or an earlier step’s{' '}
            <code>{`{{nodes.${agentNodes.find((item) => item.id !== node.id)?.id ?? 'name'}.output}}`}</code>
            .
          </p>
          <div className="bold-recipes-inspector-grid">
            <label className="orch-field">
              <span>Retries</span>
              <select
                value={node.retries}
                disabled={!editable}
                onChange={(event) => patch({ retries: Number(event.target.value) })}
              >
                {[0, 1, 2].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="orch-field">
              <span>If it fails</span>
              <select
                value={node.onFailure}
                disabled={!editable}
                onChange={(event) =>
                  commit(setFailureMode(draft, node.id, event.target.value as 'route' | 'fail_run'))
                }
              >
                <option value="fail_run">Stop the job</option>
                <option value="route">Go to a repair step</option>
              </select>
            </label>
          </div>
          {node.onFailure === 'route' && failRoute && (
            <label className="orch-field">
              <span>Failure goes to</span>
              <select
                value={failRoute.edges[0]?.to ?? ''}
                disabled={!editable}
                onChange={(event) => point('failed', event.target.value || null)}
              >
                <option value="">Not connected</option>
                {analysis.order
                  .filter((target) => target.id !== node.id)
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {targetStepLabel(analysis, target.id)}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </>
      )}

      {node.kind === 'gate' && (
        <section data-protected="block" className="bold-recipes-gate" aria-label="Gate decision">
          <TemplateField
            label="Question"
            value={node.question}
            onChange={(value) => patch({ question: value }, `question:${node.id}`)}
            draft={draft}
            nodeId={node.id}
            rows={3}
            invalid={node.question.trim() === ''}
          />
          <p className="small muted">
            The job stops here until you approve or reject. Rejecting stops the job unless you add a
            rejection path.
          </p>
          <label className="orch-field">
            <span>If rejected</span>
            <select
              value={node.onReject}
              disabled={!editable}
              onChange={(event) =>
                commit(setRejectMode(draft, node.id, event.target.value as 'route' | 'stop_run'))
              }
            >
              <option value="stop_run">Stop the job</option>
              <option value="route">Go to its own path</option>
            </select>
          </label>
          {node.onReject === 'route' && rejectRoute && (
            <label className="orch-field">
              <span>Rejection goes to</span>
              <select
                value={rejectRoute.edges[0]?.to ?? ''}
                disabled={!editable}
                onChange={(event) => point('rejected', event.target.value || null)}
              >
                <option value="">Not connected</option>
                {analysis.order
                  .filter((target) => target.id !== node.id)
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {targetStepLabel(analysis, target.id)}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </section>
      )}

      {(node.kind === 'agent' || node.kind === 'gate' || node.kind === 'join') && doneRoute && (
        <label className="orch-field">
          <span>{doneRoute.label} goes to</span>
          <select
            value={doneRoute.edges[0]?.to ?? ''}
            disabled={!editable}
            onChange={(event) => point('ok', event.target.value || null)}
          >
            <option value="">Not connected</option>
            {analysis.order
              .filter((target) => target.id !== node.id)
              .map((target) => (
                <option key={target.id} value={target.id}>
                  {targetStepLabel(analysis, target.id)}
                </option>
              ))}
          </select>
        </label>
      )}

      {node.kind === 'branch' && (
        <>
          <label className="orch-field">
            <span>Looks at</span>
            <select
              value={node.subject}
              disabled={!editable}
              onChange={(event) => patch({ subject: event.target.value })}
            >
              {node.subject === '' && <option value="">Choose an earlier agent step…</option>}
              {agentNodes.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="orch-field bold-recipes-rules">
            <legend>Decide by</legend>
            {node.rules.map((rule, index) => (
              <div key={rule.id} className="bold-recipes-rule">
                <select
                  aria-label={index === 0 ? 'Decide by' : `Rule ${index + 1} condition`}
                  value={conditionKey(rule.when)}
                  disabled={!editable}
                  onChange={(event) =>
                    commit(
                      updateRule(
                        draft,
                        node.id,
                        rule.id,
                        conditionFrom(event.target.value as ConditionKey, rule.when),
                      ),
                    )
                  }
                >
                  <option value="verdict:passed">The verdict is passed</option>
                  <option value="verdict:changes_requested">
                    The verdict is changes requested
                  </option>
                  <option value="outcome:succeeded">The step succeeded</option>
                  <option value="outcome:failed">The step failed</option>
                  <option value="output_contains">Whether its output contains some text</option>
                </select>
                {rule.when.kind === 'output_contains' && (
                  <input
                    aria-label={`Rule ${index + 1} text`}
                    value={rule.when.text}
                    maxLength={200}
                    disabled={!editable}
                    onChange={(event) =>
                      commit(
                        updateRule(draft, node.id, rule.id, {
                          kind: 'output_contains',
                          text: event.target.value,
                        }),
                        `rule:${rule.id}`,
                      )
                    }
                  />
                )}
                <button
                  type="button"
                  className="wf-link"
                  disabled={!editable || node.rules.length <= 1}
                  onClick={() => commit(removeRule(draft, node.id, rule.id))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="bold-recipes-rule">
              <span className="small muted">otherwise</span>
              <span className="small muted">Always needed</span>
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={!editable || node.rules.length >= 8}
              onClick={() => commit(addRule(draft, node.id))}
            >
              Add a rule
            </button>
          </fieldset>
          <p className="small muted">
            Every branch needs an otherwise path. A recipe only moves forward, so a path can lead to
            any later step, never back to an earlier one.
          </p>
        </>
      )}

      {node.kind === 'join' && (
        <p className="small muted">
          Waits for{' '}
          {row.incoming
            .map((edge) => analysis.order.find((item) => item.id === edge.from)?.label || edge.from)
            .join(', ') || 'nothing yet'}
          . A join waits for every path that leads into it.
        </p>
      )}

      {node.kind === 'end' && <p className="small muted">The run finishes when it gets here.</p>}
      <p className="small muted">
        In the graph, this step is <code>{node.id}</code>.
      </p>
      <span className="small muted">
        Step {row.index + 1} of {analysis.rows.length}
      </span>
    </fieldset>
  )
}
