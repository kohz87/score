import type { AgentSummary, WorkflowNode, WorkflowNodeKind } from '@score/contract'
import { Fragment, useMemo, useState, type KeyboardEvent } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { shapedWord } from '../orchestrations/LiveDiagram.tsx'
import { visualLabel, type NodeVisual } from '../orchestrations/orch-model.ts'
import {
  agentMeta,
  layoutRecipe,
  targetName,
  type LayerNode,
  type Route,
  type RouteTarget,
} from './recipe-layers.ts'
import { KIND_LABEL, type Draft } from './workflow-model.ts'
import { issuesForNode, worstSeverity, type IssueIndex } from './workflow-validation.ts'
import './recipe-layers.css'

// The recipe as layers, top to bottom (PLAN 3.26.0), from docs/design/bold/mockups/19-recipes.dc.html: the input, then one
// row per rank with steps that run at the same time side by side, an approval as a light card (it is for you), and Done
// as a pill. The cards are buttons in reading order. The stored positions of the free canvas are never read here.

const unknownStyle: AgentSummary['style'] = { color: '#8a909b', shape: 'circle-dot' }

export interface CardState {
  visual: NodeVisual
  /** What the step's agent is doing now, while it runs. */
  status?: string
}

export type InsertAt = { edgeId: string } | { before: string } | { after: string }
export type InsertStep = (
  at: InsertAt,
  kind: WorkflowNodeKind,
  agentId: string,
  agentName: string,
) => void

function Kicker({ children }: { children: React.ReactNode }) {
  return <span className="rl-kicker">{children}</span>
}

function targetText(target: RouteTarget): string {
  return `${target.back ? '↩ ' : ''}${target.back ? targetName(target) : target.label}`
}

function RouteLines({ node, routes }: { node: WorkflowNode; routes: Route[] }) {
  if (node.kind === 'gate') {
    const text = routes
      .map((route) => {
        const where =
          route.targets.length > 0
            ? route.targets.map(targetText).join(', ')
            : route.port === 'rejected' && node.onReject === 'stop_run'
              ? 'stops the run'
              : 'nothing yet'
        return `${route.label} → ${where}`
      })
      .join(' · ')
    return <span className="rl-sub rl-routes">{text}</span>
  }
  if (node.kind === 'branch') {
    return (
      <ul className="rl-paths" aria-label="Paths">
        {routes.map((route) => (
          <li key={route.port}>
            <span>{route.label}</span>
            <span aria-hidden="true">→</span>
            <span>
              {route.targets.length > 0 ? route.targets.map(targetText).join(', ') : 'nothing yet'}
            </span>
          </li>
        ))}
      </ul>
    )
  }
  return null
}

export function AddMenu({
  label,
  text,
  at,
  agents,
  onInsert,
  withEnd = false,
  small = false,
}: {
  label: string
  /** A visible word on the trigger (the settings panel); without it the trigger is a round +. */
  text?: string
  at: InsertAt
  agents: AgentSummary[]
  onInsert: InsertStep
  withEnd?: boolean
  small?: boolean
}) {
  const [open, setOpen] = useState(false)
  const hermes = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const pick = (kind: WorkflowNodeKind, agent?: AgentSummary) => {
    setOpen(false)
    onInsert(at, kind, agent?.id ?? '', agent?.name ?? '')
  }
  const kinds: [WorkflowNodeKind, string][] = [
    ['gate', 'An approval: you decide'],
    ['branch', 'A branch: pick a path'],
    ['join', 'A join: wait for every path'],
    ...(withEnd ? ([['end', 'Done: finish the run']] as [WorkflowNodeKind, string][]) : []),
  ]
  return (
    <span className="rl-add" data-small={small ? '' : undefined}>
      <button
        type="button"
        className={text ? 'rl-plus rl-plus--text' : 'rl-plus'}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
      >
        {text ? text : <span aria-hidden="true">+</span>}
      </button>
      {open && (
        <div
          className="rl-menu"
          role="group"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setOpen(false)
            }
          }}
        >
          {hermes.map((agent) => (
            <button
              key={agent.id}
              type="button"
              aria-label={`Add an agent step for ${agent.name}`}
              onClick={() => pick('agent', agent)}
            >
              <AgentGlyph agent={agent} size="xs" decorative />
              <span>{agent.name}</span>
            </button>
          ))}
          {kinds.map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              aria-label={`Add ${kind === 'end' ? 'an' : 'a'} ${KIND_LABEL[kind].toLowerCase()}`}
              onClick={() => pick(kind)}
            >
              <span>{text}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

export function RecipeLayers({
  draft,
  agents,
  issues,
  selected,
  onSelect,
  onInsert,
  onDeleteNode,
  states,
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
  readOnly?: boolean
  ariaLabel?: string
}) {
  const layout = useMemo(() => layoutRecipe(draft), [draft])
  const byAgent = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const editable = !readOnly && onInsert !== undefined

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, node: WorkflowNode) {
    if (readOnly || !onDeleteNode) return
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    event.preventDefault()
    if (window.confirm(`Delete “${node.label || node.id}”? Its connections go with it.`))
      onDeleteNode(node.id)
  }

  function card({ node, step, routes }: LayerNode) {
    const agent = node.kind === 'agent' ? byAgent.get(node.agentId) : undefined
    const glyph =
      node.kind === 'agent'
        ? (agent ?? {
            id: node.agentId,
            name: node.agentId,
            style: unknownStyle,
          })
        : null
    const cli = runtimeLabel(agent?.runtime)
    const mine = issuesForNode(issues, draft, node.id)
    const worst = worstSeverity(mine)
    const live = states?.get(node.id)
    const isOn = selected === node.id
    const backs = routes.flatMap((route) =>
      route.targets.filter((target) => target.back).map((target) => ({ route, target })),
    )
    const failedTo = routes.find((route) => route.port === 'failed')?.targets ?? []
    const stateWord = live
      ? (live.status ??
        (node.kind === 'agent' ? visualLabel[live.visual] : shapedWord(node.kind, live.visual)))
      : null
    const name = `${KIND_LABEL[node.kind]} ${node.label || node.id}${
      glyph ? `, ${glyph.name}${cli ? ` (${cli})` : ''}` : ''
    }${live ? `, ${visualLabel[live.visual]}${live.status ? `: ${live.status.replaceAll('`', '')}` : ''}` : ''}${
      mine.length > 0 ? `, ${mine.length} ${mine.length === 1 ? 'problem' : 'problems'}` : ''
    }`
    const inner = (
      <>
        {node.kind === 'agent' && glyph && (
          <>
            <span className="rl-kicker rl-kicker--agent">
              <AgentGlyph agent={glyph} size="xs" decorative />
              <span>
                Step {step} · {glyph.name}
              </span>
              {cli && <span className="rl-cli">{cli}</span>}
            </span>
            <b className="rl-title">{node.label || node.id}</b>
            <span className="rl-sub">{agentMeta(node, draft, layout, failedTo)}</span>
          </>
        )}
        {node.kind === 'gate' && (
          <>
            <Kicker>You · approval</Kicker>
            <b className="rl-title">{node.label || node.id}</b>
            {node.question && <span className="rl-sub rl-question">{node.question}</span>}
            <RouteLines node={node} routes={routes} />
          </>
        )}
        {node.kind === 'branch' && (
          <>
            <Kicker>Branch</Kicker>
            <b className="rl-title">{node.label || node.id}</b>
            <RouteLines node={node} routes={routes} />
          </>
        )}
        {node.kind === 'join' && (
          <>
            <Kicker>Join</Kicker>
            <b className="rl-title">{node.label || node.id}</b>
            <span className="rl-sub">waits for every path that leads here</span>
          </>
        )}
        {node.kind === 'end' && (
          <>
            <b className="rl-title">{node.label || node.id}</b>
            <span className="rl-sub">finishes the run</span>
          </>
        )}
        {(node.kind === 'agent' || node.kind === 'join') &&
          backs.map(({ route, target }) => (
            <span key={`${route.port}-${target.id}`} className="rl-back">
              ↩ back to {targetName(target)}
              {route.port === 'ok' ? '' : ` (${route.label})`}
            </span>
          ))}
        {live && (
          <span className="rl-state" data-state={live.visual}>
            {stateWord}
          </span>
        )}
        {live?.visual === 'gate' && (
          <span className="rl-flag" data-protected="inline">
            Needs you
          </span>
        )}
        {mine.length > 0 && (
          <span className="rl-issues" data-severity={worst ?? undefined} aria-hidden="true">
            {worst === 'error' ? '✕' : '!'} {mine.length}
          </span>
        )}
      </>
    )
    const style = glyph ? ({ '--rl-agent': glyph.style.color } as React.CSSProperties) : undefined
    return (
      <button
        key={node.id}
        type="button"
        className="rl-card"
        data-node={node.id}
        data-kind={node.kind}
        data-state={live?.visual}
        data-severity={worst ?? undefined}
        aria-pressed={isOn}
        aria-label={name}
        style={style}
        onClick={() => onSelect(isOn ? null : node.id)}
        onKeyDown={(event) => onKeyDown(event, node)}
      >
        {inner}
      </button>
    )
  }

  const line = <span className="rl-line" aria-hidden="true" />
  const inputs = draft.inputs
  const first = layout.layers[0]

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
      {first === undefined && <span className="rl-sub">This recipe has no steps yet.</span>}
      {editable && first === undefined && (
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
