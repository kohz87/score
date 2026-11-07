import type { AgentSummary } from '@score/contract'
import { Fragment, useMemo } from 'react'
import { AddMenu } from './RecipeAddMenu.tsx'
import { RecipeCard } from './RecipeCard.tsx'
import { Kicker } from './RecipeKicker.tsx'
import { layoutRecipe, type LayerNode } from './recipe-layers.ts'
import type { CardState, InsertStep } from './recipe-layers-types.ts'
import type { Draft } from './workflow-model.ts'
import type { IssueIndex } from './workflow-validation.ts'
import './recipe-layers.css'

export { AddMenu }
export type { CardState, InsertStep } from './recipe-layers-types.ts'

// The recipe as layers, top to bottom (PLAN 3.26.0), from docs/design/bold/mockups/19-recipes.dc.html: the input, then one
// row per rank with steps that run at the same time side by side, an approval as a light card (it is for you), and Done
// as a pill. The cards are buttons in reading order. The stored positions of the free canvas are never read here.

export function RecipeLayers({
  draft,
  agents,
  issues,
  selected,
  onSelect,
  onInsert,
  onDeleteNode,
  states,
  edges,
  readOnly = false,
  ariaLabel = 'Recipe graph',
}: {
  draft: Draft
  agents: AgentSummary[]
  issues: IssueIndex
  selected: string | null
  onSelect: (id: string | null) => void
  onInsert?: InsertStep
  /** Called after the person confirmed; the view only asks. */
  onDeleteNode?: (id: string) => void
  /** The states of a run going now, or of a preview: drawn on each card; the draft is not touched. */
  states?: ReadonlyMap<string, CardState> | null
  /** Which connections a run or a preview took: a branch says which path it took, a loop says "again". */
  edges?: ReadonlyMap<string, 'taken' | 'skipped'> | null
  readOnly?: boolean
  ariaLabel?: string
}) {
  const layout = useMemo(() => layoutRecipe(draft), [draft])
  const byAgent = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const editable = !readOnly && onInsert !== undefined
  const card = (item: LayerNode) => (
    <RecipeCard
      key={item.node.id}
      item={item}
      byAgent={byAgent}
      draft={draft}
      issues={issues}
      layout={layout}
      selected={selected}
      states={states}
      edges={edges}
      readOnly={readOnly}
      onSelect={onSelect}
      onDeleteNode={onDeleteNode}
    />
  )

  const line = <span className="rl-line" aria-hidden="true" />
  const inputs = draft.inputs

  return (
    <section className="rl" aria-label={ariaLabel} data-readonly={readOnly ? '' : undefined}>
      <div className="rl-card rl-card--input" data-kind="input">
        <Kicker>You · input</Kicker>
        {inputs.length === 0 ? (
          <span className="rl-sub">Nothing to fill in</span>
        ) : (
          <ul className="rl-inputs">
            {inputs.map((input) => (
              <li key={input.name}>
                {input.label || input.name}{' '}
                <span className="rl-mono">· text, {input.required ? 'required' : 'optional'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {layout.layers.map((layer, index) => {
        const several = layer.nodes.length > 1
        const above = layout.layers[index - 1]
        const cards = layer.nodes.map((item) => card(item))
        return (
          <Fragment key={layer.index}>
            {line}
            {index === 0 && editable && layout.insertBeforeFirst && (
              <>
                <AddMenu
                  label="Add a step after the input"
                  at={{ before: layout.insertBeforeFirst }}
                  agents={agents}
                  onInsert={onInsert}
                />
                {line}
              </>
            )}
            {index > 0 && editable && layer.insertOn && above && (
              <>
                <AddMenu
                  label={`Add a step after ${above.nodes[0]!.node.label || above.nodes[0]!.node.id}`}
                  at={layer.insertOn}
                  agents={agents}
                  onInsert={onInsert}
                />
                {line}
              </>
            )}
            {layer.joinNote && (
              <>
                <span className="rl-join">{layer.joinNote}</span>
                {line}
              </>
            )}
            {several ? (
              <div className="rl-group">
                <span className="rl-bracket rl-bracket--down" aria-hidden="true" />
                <span className="rl-simul">at the same time</span>
                <div className="rl-row" data-count={layer.nodes.length}>
                  {cards}
                </div>
                <span className="rl-bracket rl-bracket--up" aria-hidden="true" />
              </div>
            ) : (
              cards
            )}
          </Fragment>
        )
      })}
      {layout.orphans.length > 0 && (
        <section className="rl-orphans" aria-label="Not connected">
          <Kicker>Not connected</Kicker>
          <span className="rl-sub">Connect it in its settings</span>
          <div className="rl-row" data-count={layout.orphans.length}>
            {layout.orphans.map((item) => card(item))}
          </div>
        </section>
      )}
      {draft.nodes.length === 0 && <span className="rl-sub">This recipe has no steps yet.</span>}
      {editable && draft.nodes.length === 0 && (
        <AddMenu
          label="Add a step"
          at={{ after: '' }}
          agents={agents}
          onInsert={onInsert}
          withEnd
        />
      )}
    </section>
  )
}
