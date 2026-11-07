import type { AgentSummary, WorkflowNode } from '@score/contract'
import type { CSSProperties, KeyboardEvent } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { shapedWord } from '../orchestrations/LiveDiagram.tsx'
import { visualLabel } from '../orchestrations/orch-model.ts'
import {
  agentMeta,
  layoutRecipe,
  targetName,
  type LayerNode,
  type Route,
  type RouteTarget,
} from './recipe-layers.ts'
import { Kicker } from './RecipeKicker.tsx'
import type { CardState } from './recipe-layers-types.ts'
import { KIND_LABEL, type Draft } from './workflow-model.ts'
import { issuesForNode, worstSeverity, type IssueIndex } from './workflow-validation.ts'

const unknownStyle: AgentSummary['style'] = { color: '#8a909b', shape: 'circle-dot' }

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

export function RecipeCard({
  item: { node, step, routes },
  byAgent,
  draft,
  issues,
  layout,
  selected,
  states,
  edges,
  readOnly,
  onSelect,
  onDeleteNode,
}: {
  item: LayerNode
  byAgent: ReadonlyMap<string, AgentSummary>
  draft: Draft
  issues: IssueIndex
  layout: ReturnType<typeof layoutRecipe>
  selected: string | null
  states?: ReadonlyMap<string, CardState> | null
  edges?: ReadonlyMap<string, 'taken' | 'skipped'> | null
  readOnly: boolean
  onSelect: (id: string | null) => void
  onDeleteNode?: (id: string) => void
}) {
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
  const took = edges
    ? routes.flatMap((route) =>
        route.targets.some((target) => edges.get(target.edgeId) === 'taken')
          ? [
              `${route.label} → ${route.targets
                .filter((target) => edges.get(target.edgeId) === 'taken')
                .map((target) => target.label)
                .join(', ')}`,
            ]
          : [],
      )
    : []
  const again =
    edges !== undefined &&
    edges !== null &&
    layout.layers.some((layer) =>
      layer.nodes.some((entry) =>
        entry.routes.some((route) =>
          route.targets.some(
            (target) =>
              target.back && target.id === node.id && edges.get(target.edgeId) === 'taken',
          ),
        ),
      ),
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
      {node.kind === 'branch' && took.length > 0 && (
        <span className="rl-took">took: {took.join(' · ')}</span>
      )}
      {again && <span className="rl-again">↩ again</span>}
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
  const style = glyph ? ({ '--rl-agent': glyph.style.color } as CSSProperties) : undefined

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (readOnly || !onDeleteNode) return
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    event.preventDefault()
    if (window.confirm(`Delete “${node.label || node.id}”? Its connections go with it.`))
      onDeleteNode(node.id)
  }

  return (
    <button
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
      onKeyDown={onKeyDown}
    >
      {inner}
    </button>
  )
}
