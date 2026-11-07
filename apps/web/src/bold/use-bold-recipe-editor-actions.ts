import type { WorkflowNodeKind } from '@score/contract'
import type { KeyboardEvent } from 'react'
import { ApiError } from '../data/api.ts'
import type { InsertStep } from '../routes/workflows/RecipeLayers.tsx'
import { layoutRecipe } from '../routes/workflows/recipe-layers.ts'
import {
  addStepAfter,
  insertStepBefore,
  insertStepOnEdge,
  removeNodeJoining,
} from '../routes/workflows/workflow-model.ts'
import { fetchWorkflowVersion, latestVersionOf } from '../routes/workflows/workflow-queries.ts'
import { placeNewNode } from '../routes/workflows/workflow-layout.ts'
import { describeError } from './bold-recipe-editor-model.ts'
import type { BoldRecipeEditorProps } from './bold-recipe-editor-model.ts'
import { addRecipeStep, planRecipeMove, removeRecipeStep, setPortTarget } from './recipe-model.ts'
import type { BoldRecipeEditorFocus } from './use-bold-recipe-editor-focus.ts'
import type { BoldRecipeEditorState } from './use-bold-recipe-editor-state.ts'

export function useBoldRecipeEditorActions(
  props: BoldRecipeEditorProps,
  state: BoldRecipeEditorState,
  focus: BoldRecipeEditorFocus,
  refs: {
    setAllowLeave: (value: boolean) => void
    setSkipSheetFocus: (value: boolean) => void
    focusMoreButton: () => void
  },
) {
  const { agents, onNotice, onSaved, onDeleted, onDuplicated } = props
  const {
    analysis,
    archive,
    commit,
    draft,
    history,
    moreOpen,
    previewing,
    queryClient,
    recipe,
    remove,
    removeWithRuns,
    save,
    saved,
    setAnnouncement,
    setConflict,
    setDeletingRuns,
    setLoadedFrom,
    setMoreOpen,
    setSaveProblem,
    setSaved,
    setSel,
    setViewVersion,
    viewing,
  } = state
  const { focusStep, focusCard } = focus
  const { setAllowLeave, setSkipSheetFocus, focusMoreButton } = refs

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
    state.selectNode(result.id)
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
    setSkipSheetFocus(true)
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
    state.selectNode(next)
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
    state.selectNode(id)
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
          if (saved.workflowId === null) setAllowLeave(true)
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
      state.selectNode(loaded.definition.nodes[0]?.id ?? null)
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
      state.dirty &&
      !window.confirm(
        `You have unsaved changes. Replace them with version ${version}? You can undo this.`,
      )
    )
      return
    try {
      const loaded = await fetchWorkflowVersion(queryClient, saved.workflowId, version)
      // Load it as an edit, not a reset: the unsaved draft stays one undo away.
      history.commit(loaded.definition)
      state.selectNode(loaded.definition.nodes[0]?.id ?? null)
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
        setAllowLeave(true)
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
          setAllowLeave(true)
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

  function cancelDeleteWithRuns() {
    removeWithRuns.reset()
    setDeletingRuns(false)
    focusMoreButton()
  }

  function confirmDeleteWithRuns(confirm: string) {
    removeWithRuns.mutate(
      { id: saved.workflowId!, confirm },
      {
        onSuccess: () => {
          setAllowLeave(true)
          setDeletingRuns(false)
          onDeleted(saved.workflowId!)
        },
      },
    )
  }

  function keepDraftOnConflict(conflict: number) {
    setSaved((current) => ({ ...current, version: conflict }))
    setConflict(null)
    onNotice(`Your draft now builds on version ${conflict}. Save to add it as the next version.`)
  }

  return {
    add,
    insertStep,
    deleteNode,
    removeStep,
    move,
    point,
    onSave,
    reloadLatest,
    loadOlder,
    removeRecipe,
    toggleArchive,
    duplicate,
    onKeyDown,
    cancelDeleteWithRuns,
    confirmDeleteWithRuns,
    keepDraftOnConflict,
  }
}

export type BoldRecipeEditorActions = ReturnType<typeof useBoldRecipeEditorActions>
