import type { AgentSummary } from '@score/contract'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { statusSegments } from '../../live/status-line.ts'
import { loadAnime, usePrefersReducedMotion } from '../../motion/motion.ts'
import { layoutFlow, type Point } from '../../components/flow-layout/layout.ts'
import { withPositions, type PositionMap } from '../../components/flow-layout/free-layout.ts'
import {
  visualLabel,
  type Effect,
  type EffectTone,
  type GraphEdge,
  type GraphNode,
  type NodeVisual,
} from './orch-model.ts'
import { Dot, type DotRoute } from './live-diagram-dot.tsx'
import { EFFECT_GAP_MS, useEffectPlayer, type ActiveEffect } from './live-diagram-effects.ts'
import { NODE_H, NODE_W, nodeSize, shapedWord, toneClass } from './live-diagram-node.ts'
import { NodeShape } from './NodeShape.tsx'
import { useNodeTransitions } from './use-node-transitions.ts'

// The live diagram: SVG edges, HTML nodes, CSS animation. Dots are the playback of real events (see orch-model.ts).

export { usePrefersReducedMotion }
export { EFFECT_GAP_MS, useEffectPlayer }
export type { ActiveEffect }
export { nodeSize, shapedWord }
export { NodeShape }

/** A node's second line; a tool name in a status line is shown in code style. */
function Caption({ text }: { text: string }) {
  return (
    <>
      {statusSegments(text).map((segment, index) =>
        index % 2 === 1 ? <code key={index}>{segment}</code> : segment,
      )}
    </>
  )
}

const named = (word: string, status?: string) =>
  status ? `${word}: ${status.replaceAll('`', '')}` : word

const SHAPE_NAME = { gate: 'Gate', branch: 'Branch', join: 'Join', end: 'End' } as const

export interface DiagramProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  visuals: ReadonlyMap<string, NodeVisual>
  lead: 'idle' | 'working' | 'ended'
  agents: AgentSummary[]
  selected: string | null
  onSelect: (id: string | null) => void
  active: ActiveEffect[]
  reducedMotion: boolean
  /** Steps that do not exist yet at the replayed time: not drawn, but the layout keeps their room. */
  hidden?: ReadonlySet<string>
  /** Workflow runs (7.1b): which edges a token travelled (`taken`) or that were passed over (`skipped`). */
  edgeStates?: ReadonlyMap<string, 'taken' | 'skipped'>
  /** What the screen reader calls the group of nodes; orchestrations say "Step". */
  noun?: string
  ariaLabel?: string
  /** Room between columns; workflow edges carry labels, so they get more. */
  columnGap?: number
  /** Workflow runs (7.1c): where the editor drew the nodes; unlisted nodes are placed automatically. */
  positions?: PositionMap
}

const unknownStyle: AgentSummary['style'] = { color: '#8a909b', shape: 'circle-dot' }

export function LiveDiagram({
  nodes,
  edges,
  visuals,
  lead,
  agents,
  selected,
  onSelect,
  active,
  reducedMotion,
  hidden,
  edgeStates,
  noun = 'Step',
  ariaLabel = 'Live diagram of the run. The log next to it says the same in words.',
  columnGap = 56,
  positions,
}: DiagramProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useNodeTransitions(viewport, visuals, reducedMotion)
  useEffect(() => {
    if (!reducedMotion) void loadAnime().catch(() => {})
  }, [reducedMotion])
  const auto = useMemo(
    () =>
      layoutFlow(
        {
          nodes: nodes.map((node) => {
            const size = nodeSize(node)
            return { id: node.id, width: size.w, height: size.h }
          }),
          edges: edges.map(({ id, from, to, kind }) => ({ id, from, to, kind })),
        },
        { columnGap, rowGap: 28, marginX: 14, marginY: 18 },
      ),
    [nodes, edges, columnGap],
  )
  const layout = useMemo(
    () =>
      positions && positions.size > 0
        ? withPositions(
            auto,
            nodes.map((node) => ({
              id: node.id,
              width: nodeSize(node).w,
              height: nodeSize(node).h,
            })),
            edges,
            positions,
            { marginX: 14, marginY: 18 },
          )
        : auto,
    [auto, nodes, edges, positions],
  )
  const position = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout.nodes])
  const routed = useMemo(() => new Map(layout.edges.map((e) => [e.id, e.points])), [layout.edges])
  const sizes = useMemo(() => new Map(nodes.map((node) => [node.id, nodeSize(node)])), [nodes])
  const center = (id: string): Point | null => {
    const at = position.get(id)
    const size = sizes.get(id) ?? { w: NODE_W, h: NODE_H }
    return at ? { x: at.x + size.w / 2, y: at.y + size.h / 2 } : null
  }
  // Fit the diagram to the available width (never above 100%), so a phone sees all of it.
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const width = element.clientWidth
      // Never smaller than 75%: below that the text is unreadable, so a narrow screen scrolls sideways instead.
      setScale(width > 0 && layout.width > width ? Math.max(0.75, width / layout.width) : 1)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [layout.width])

  const routeFor = (effect: Effect): DotRoute | null => {
    const named = effect.edge ? routed.get(effect.edge) : undefined
    if (named) return { points: named, edge: effect.edge!, reverse: false }
    const forward = edges.find((e) => e.id === `${effect.from}>${effect.to}`)
    const forwardPoints = forward ? routed.get(forward.id) : undefined
    if (forward && forwardPoints) return { points: forwardPoints, edge: forward.id, reverse: false }
    const reverse = edges.find((e) => e.from === effect.to && e.to === effect.from)
    const back = reverse ? routed.get(reverse.id) : undefined
    if (reverse && back) return { points: back, edge: reverse.id, reverse: true }
    const a = center(effect.from)
    const b = center(effect.to)
    return a && b ? { points: [a, b], edge: null, reverse: false } : null
  }

  const litNodes = new Map<string, EffectTone>()
  const litEdges = new Set<string>()
  for (const { effect } of active) {
    litNodes.set(effect.to, effect.tone)
    if (effect.kind === 'dot' && reducedMotion) {
      litNodes.set(effect.from, effect.tone)
      for (const edge of edges)
        if (
          (edge.from === effect.from && edge.to === effect.to) ||
          (edge.from === effect.to && edge.to === effect.from)
        )
          litEdges.add(edge.id)
    }
  }
  const byId = new Map(agents.map((a) => [a.id, a]))

  return (
    <div className="orch-canvas" ref={viewport} role="group" aria-label={ariaLabel}>
      <div
        className="orch-world"
        style={{ width: layout.width * scale, height: layout.height * scale }}
      >
        <div
          className="orch-world-inner"
          style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
        >
          <svg
            className="orch-edges"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="orch-arrow"
                orient="auto"
                markerWidth="5"
                markerHeight="5"
                refX="3.2"
                refY="2"
                overflow="visible"
              >
                <path d="M0 0 L4 2 L0 4 Z" className="orch-arrow" stroke="none" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const points = routed.get(edge.id)
              if (!points || hidden?.has(edge.from) || hidden?.has(edge.to)) return null
              const d = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
              const state = edgeStates?.get(edge.id)
              // The label sits on the middle run, where the edge turns; the text has its own halo.
              const a = points[1]
              const b = points[2]
              return (
                <g key={edge.id}>
                  <path
                    d={d}
                    data-edge={edge.id}
                    {...(state ? { 'data-edge-state': state } : {})}
                    className={`orch-edge orch-edge--${edge.kind}${state ? ` orch-edge--${state}` : ''}${litEdges.has(edge.id) ? ' orch-edge--lit' : ''}`}
                    markerEnd="url(#orch-arrow)"
                  />
                  {edge.label && a && b && (
                    <text
                      className={`orch-edge-label${state === 'skipped' ? ' orch-edge-label--skipped' : ''}`}
                      x={(a.x + b.x) / 2}
                      y={(a.y + b.y) / 2 + (a.y === b.y ? -6 : 4)}
                      textAnchor="middle"
                    >
                      {edge.label}
                    </text>
                  )}
                </g>
              )
            })}
            {!reducedMotion &&
              active.map(({ key, effect, durationMs }) => {
                if (effect.kind !== 'dot') return null
                const route = routeFor(effect)
                return route ? (
                  <Dot key={key} route={route} durationMs={durationMs} tone={effect.tone} />
                ) : null
              })}
          </svg>
          {nodes.map((node) => {
            const at = position.get(node.id)
            if (!at || hidden?.has(node.id)) return null
            const isLead = node.kind === 'lead'
            const visual = isLead ? null : (visuals.get(node.id) ?? 'queued')
            const agent = byId.get(node.agentId)
            const glyph = {
              id: node.agentId,
              name: agent?.name ?? node.agentId,
              style: agent?.style ?? unknownStyle,
            }
            // A coding agent shows which program it runs on, next to its name (colour and shape stay the glyph's).
            const cli = runtimeLabel(agent?.runtime)
            const tone = litNodes.get(node.id)
            const shaped = node.shape !== undefined && node.shape !== 'agent'
            const size = nodeSize(node)
            const title = node.title ?? node.id
            const word =
              node.caption ??
              (isLead
                ? lead === 'working'
                  ? 'working'
                  : lead === 'ended'
                    ? 'run ended'
                    : 'waiting'
                : shaped
                  ? shapedWord(node.shape!, visual!)
                  : visualLabel[visual!])
            // The status line replaces the state word on screen; the accessible name keeps both.
            const shown = node.status ?? word
            const what = isLead
              ? 'Lead'
              : shaped
                ? SHAPE_NAME[node.shape as keyof typeof SHAPE_NAME]
                : noun
            return (
              <button
                key={node.id}
                type="button"
                className={`orch-node orch-node--${isLead ? `lead-${lead}` : visual}${shaped ? ` orch-node--shaped orch-node--shape-${node.shape}` : ''}${selected === node.id ? ' orch-node--selected' : ''}${tone ? ` orch-node--lit ${toneClass(tone)}` : ''}`}
                style={{
                  left: at.x,
                  top: at.y,
                  width: size.w,
                  height: size.h,
                  ['--node-agent' as string]: glyph.style.color,
                }}
                data-node={node.id}
                data-state={isLead ? `lead-${lead}` : visual}
                aria-pressed={selected === node.id}
                aria-label={
                  shaped
                    ? `${what} ${title}, ${named(word, node.status)}`
                    : `${isLead ? 'Lead' : `${what} ${title}`}, ${glyph.name}${cli ? ` (${cli})` : ''}, ${named(word, node.status)}`
                }
                onClick={() => onSelect(selected === node.id ? null : node.id)}
              >
                {shaped ? (
                  <NodeShape shape={node.shape!} w={size.w} h={size.h} />
                ) : (
                  <AgentGlyph agent={glyph} size="sm" decorative />
                )}
                <span className="orch-node__text">
                  {node.title !== undefined && !shaped ? (
                    <>
                      <b>{title}</b>
                      <span>
                        {glyph.name} · <Caption text={shown} />
                      </span>
                    </>
                  ) : (
                    <>
                      <b>
                        {isLead ? 'Lead' : title} {!shaped && <i>{glyph.name}</i>}
                      </b>
                      <span>
                        <Caption text={shown} />
                      </span>
                    </>
                  )}
                </span>
                {cli && <span className="orch-node__cli">{cli}</span>}
                {visual === 'gate' && (
                  <span className="orch-node__flag" data-protected="inline">
                    Needs you
                  </span>
                )}
                {visual === 'unknown' && (
                  <span className="orch-node__q" aria-hidden="true">
                    ?
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
