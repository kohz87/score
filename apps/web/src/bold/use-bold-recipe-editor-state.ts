import type { WorkflowNode } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { useBlocker, useNavigate } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import type { Selection } from '../routes/workflows/EditorParts.tsx'
import { useDraftHistory } from '../routes/workflows/use-draft-history.ts'
import { useLiveOverlay } from '../routes/workflows/use-live-overlay.ts'
import { sameDraft, updateNode, type Draft } from '../routes/workflows/workflow-model.ts'
import {
  useArchiveWorkflow,
  useDeleteWorkflow,
  useDeleteWorkflowWithRuns,
  useSaveWorkflow,
  useValidation,
  useWorkflowVersion,
  workflowRunsQuery,
} from '../routes/workflows/workflow-queries.ts'
import { combine, indexIssues, shapeIssues } from '../routes/workflows/workflow-validation.ts'
import { dedupeProblems, type BoldRecipeEditorProps } from './bold-recipe-editor-model.ts'
import { analyzeRecipe, moveRecipeStepProblem, recipeClientProblems } from './recipe-model.ts'

export function useBoldRecipeEditorState(
  { detail, initialDefinition, recipes, agents }: BoldRecipeEditorProps,
  allowLeave: RefObject<boolean>,
) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const history = useDraftHistory<Draft>(initialDefinition)
  const { draft, commit } = history
  const analysis = useMemo(() => analyzeRecipe(draft), [draft])
  const [allProblems, setAllProblems] = useState(false)
  const allProblemsId = useId()
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
  const recipe = recipes.find((item) => item.id === detail?.id)
  const runCount =
    useStreamQuery(workflowRunsQuery).data?.filter((run) => run.workflowId === detail?.id).length ??
    0
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

  return {
    navigate,
    agents,
    queryClient,
    history,
    draft,
    commit,
    analysis,
    allProblems,
    setAllProblems,
    allProblemsId,
    sel,
    setSel,
    selectedNodeId,
    saved,
    setSaved,
    graph,
    setGraph,
    conflict,
    setConflict,
    exporting,
    setExporting,
    moreOpen,
    setMoreOpen,
    previewing,
    setPreviewing,
    viewVersion,
    setViewVersion,
    loadedFrom,
    setLoadedFrom,
    saveProblem,
    setSaveProblem,
    announcement,
    setAnnouncement,
    save,
    remove,
    archive,
    removeWithRuns,
    deletingRuns,
    setDeletingRuns,
    recipe,
    runCount,
    nameId,
    viewed,
    viewing,
    shape,
    index,
    problems,
    warnings,
    checking,
    checkFailed,
    dirty,
    canSave,
    selectedRow,
    versions,
    badge,
    moveProblems,
    graphDraft,
    graphNode,
    overlay,
    previewBlocked,
    selectNode,
    patch,
  }
}

export type BoldRecipeEditorState = ReturnType<typeof useBoldRecipeEditorState>
