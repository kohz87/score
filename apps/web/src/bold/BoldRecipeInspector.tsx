import { AddMenu } from '../routes/workflows/RecipeLayers.tsx'
import { placement } from '../routes/workflows/recipe-layers.ts'
import { NodeInspector } from '../routes/workflows/NodeInspector.tsx'
import { issuesForNode } from '../routes/workflows/workflow-validation.ts'
import { RecipeInspector } from './BoldRecipeText.tsx'
import type { BoldRecipeEditorActions } from './use-bold-recipe-editor-actions.ts'
import type { BoldRecipeEditorFocus } from './use-bold-recipe-editor-focus.ts'
import type { BoldRecipeEditorState } from './use-bold-recipe-editor-state.ts'

export function BoldRecipeInspector({
  state,
  actions,
  recipeLayout,
}: {
  state: BoldRecipeEditorState
  actions: BoldRecipeEditorActions
  recipeLayout: BoldRecipeEditorFocus['recipeLayout']
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
    patch,
    selectedRow,
    setAnnouncement,
    viewing,
  } = state
  const where = graphNode ? placement(graphDraft, recipeLayout, graphNode.id) : null
  return graph ? (
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
          onDelete={() => actions.deleteNode(graphNode.id)}
          announce={setAnnouncement}
        />
        {!viewing && graphNode.kind !== 'end' && (
          <div className="rl-aside-add">
            <AddMenu
              label="Add a step after"
              text="Add a step after"
              at={{ after: graphNode.id }}
              agents={agents}
              onInsert={actions.insertStep}
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
      point={(port, target) => actions.point(selectedRow.node.id, port, target)}
    />
  ) : (
    <span className="muted small">Add a step to edit it.</span>
  )
}
