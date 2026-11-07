import type { WorkflowNodeKind } from '@score/contract'
import type { RefObject } from 'react'
import { Link } from 'react-router'
import { clock } from '../live/resolved.ts'
import { InputsEditor, Outline } from '../routes/workflows/EditorParts.tsx'
import { RecipeLayers } from '../routes/workflows/RecipeLayers.tsx'
import { WorkflowPreview } from '../routes/workflows/PreviewRun.tsx'
import { boldRunLink } from './bold-links.ts'
import { PlusIcon } from './BoldIcons.tsx'
import { BoldRecipeInspector } from './BoldRecipeInspector.tsx'
import { RecipeStepRow } from './BoldRecipeText.tsx'
import { RECIPE_STEP_LABEL } from './recipe-model.ts'
import { RecipeSheet } from './RecipeSheet.tsx'
import type { BoldRecipeEditorActions } from './use-bold-recipe-editor-actions.ts'
import type { BoldRecipeEditorFocus } from './use-bold-recipe-editor-focus.ts'
import type { BoldRecipeEditorState } from './use-bold-recipe-editor-state.ts'

export function BoldRecipeWorkspace({
  state,
  focus,
  actions,
  aside,
}: {
  state: BoldRecipeEditorState
  focus: BoldRecipeEditorFocus
  actions: BoldRecipeEditorActions
  aside: RefObject<HTMLElement | null>
}) {
  const {
    agents,
    analysis,
    commit,
    draft,
    graph,
    graphDraft,
    graphNode,
    index,
    moveProblems,
    overlay,
    previewing,
    selectedNodeId,
    selectedRow,
    sel,
    selectNode,
    setGraph,
    setPreviewing,
    setSel,
    shape,
    versions,
    viewed,
    viewVersion,
    viewing,
  } = state
  const { recipeLayout, sheet } = focus
  const inspector = (
    <BoldRecipeInspector state={state} actions={actions} recipeLayout={recipeLayout} />
  )
  return (
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
                onInsert={actions.insertStep}
                onDeleteNode={actions.deleteNode}
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
                  onMove={(direction) => actions.move(row.node.id, direction)}
                  onRemove={() => actions.removeStep(row.node.id)}
                  onTarget={actions.point}
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
                    onClick={() => actions.add(kind)}
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
                  if (version) void actions.loadOlder(version)
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
              onDelete={() => actions.deleteNode(graphNode.id)}
              readOnly={viewing}
              more={inspector}
            />
          ) : (
            inspector
          )}
        </aside>
      )}
    </div>
  )
}
