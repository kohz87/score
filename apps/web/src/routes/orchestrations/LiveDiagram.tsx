import type { AgentSummary } from '@score/contract'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { layoutFlow, type Point } from '../now/flow/layout.ts'
import {
  EffectQueue,
  visualLabel,
  type Effect,
  type EffectTone,
  type GraphEdge,
  type GraphNode,
  type NodeVisual,
} from './orch-model.ts'

// The live diagram: SVG edges, HTML nodes, CSS animation. Dots are the playback of real events (see orch-model.ts).

const NODE_W = 196
const NODE_H = 68

/** Workflow nodes (7.1b) keep the agent card's size; the local nodes are smaller and shaped for what they are. */
export const nodeSize = (node: Pick<GraphNode, 'shape'>): { w: number; h: number } => {
  switch (node.shape) {
    case 'gate':
      return { w: 176, h: 96 }
    case 'branch':
      return { w: 176, h: 76 }
    case 'join':
    case 'end':
      return { w: 132, h: 52 }
    default:
      return { w: NODE_W, h: NODE_H }
  }
}
/** Each effect starts at least this long after the previous one (owner: dots paced at 300 ms or more). */
export const EFFECT_GAP_MS = 300
const DOT_MS = 800
const PULSE_MS = 900

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

export type ActiveEffect = { key: number; effect: Effect; durationMs: number }

/**
 * Plays queued effects one at a time with a minimum gap. With reduced motion a dot does not travel: the edge and both
 * nodes are highlighted instead for the same time. Returns what is on screen right now.
 */
export function useEffectPlayer(reducedMotion: boolean, gapMs = EFFECT_GAP_MS) {
  const queue = useRef(new EffectQueue(gapMs))
  const [active, setActive] = useState<ActiveEffect[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const counter = useRef(0)
  const alive = useRef(true)
  const reduced = useRef(reducedMotion)
  useEffect(() => {
    reduced.current = reducedMotion
  }, [reducedMotion])

  const pump = useCallback(function pump() {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    if (!alive.current) return
    const now = performance.now()
    const next = queue.current.take(now)
    if (next) {
      const key = ++counter.current
      const durationMs = reduced.current || next.kind === 'pulse' ? PULSE_MS : DOT_MS
      setActive((list) => [...list, { key, effect: next, durationMs }])
      setTimeout(() => {
        if (alive.current) setActive((list) => list.filter((item) => item.key !== key))
      }, durationMs)
    }
    if (queue.current.length > 0)
      timer.current = setTimeout(pump, Math.max(16, queue.current.wait(performance.now())))
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current !== undefined) clearTimeout(timer.current)
    }
  }, [])

  const enqueue = useCallback(
    (effects: Effect[]) => {
      if (effects.length === 0) return
      queue.current.push(effects)
      pump()
    },
    [pump],
  )
  const reset = useCallback(() => {
    queue.current.clear()
    setActive([])
  }, [])
  return { active, enqueue, reset, queue }
}

const toneClass = (tone: EffectTone) => `orch-tone--${tone}`

const SHAPE_NAME = { gate: 'Gate', branch: 'Branch', join: 'Join', end: 'End' } as const

/** The word under a workflow node's title: a gate is approved, not "succeeded". */
export function shapedWord(shape: NonNullable<GraphNode['shape']>, visual: NodeVisual): string {
  if (shape === 'gate') {
    if (visual === 'succeeded') return 'approved'
    if (visual === 'failed') return 'rejected'
  }
  if (shape === 'end' && visual === 'succeeded') return 'reached'
  if ((shape === 'branch' || shape === 'join') && visual === 'succeeded') return 'passed on'
  return visualLabel[visual]
}

/** The outline of a local node, drawn behind its text: a diamond for a gate, a hexagon for a branch, a pill otherwise. */
export function NodeShape({
  shape,
  w,
  h,
}: {
  shape: NonNullable<GraphNode['shape']>
  w: number
  h: number
}) {
  const inset = 2
  const points =
    shape === 'gate'
      ? `${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`
      : shape === 'branch'
        ? `${h / 3},${inset} ${w - h / 3},${inset} ${w - inset},${h / 2} ${w - h / 3},${h - inset} ${h / 3},${h - inset} ${inset},${h / 2}`
        : null
  return (
    <svg
      className="orch-node__shape"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      focusable="false"
    >
      {points ? (
        <polygon points={points} strokeLinejoin="round" />
      ) : (
        <rect
          x={inset}
          y={inset}
          width={w - inset * 2}
          height={h - inset * 2}
          rx={shape === 'end' ? (h - inset * 2) / 2 : 14}
        />
      )}
    </svg>
  )
}

function polylineLength(points: Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  return total
}

function Dot({
  points,
  durationMs,
  tone,
}: {
  points: Point[]
  durationMs: number
  tone: EffectTone
}) {
  const ref = useRef<SVGCircleElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof element.animate !== 'function') return
    const total = polylineLength(points) || 1
    let walked = 0
    const frames = points.map((point, index) => {
      if (index > 0)
        walked += Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y)
      return { transform: `translate(${point.x}px, ${point.y}px)`, offset: walked / total }
    })
    const animation = element.animate(frames, {
      duration: durationMs,
      easing: 'ease-in-out',
      fill: 'forwards',
    })
    return () => animation.cancel()
  }, [points, durationMs])
  const start = points[0]!
  return (
    <circle
      ref={ref}
      className={`orch-dot ${toneClass(tone)}`}
      r="6"
      cx="0"
      cy="0"
      style={{ transform: `translate(${start.x}px, ${start.y}px)` }}
    />
  )
}

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
}: DiagramProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const layout = useMemo(
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

  const pathFor = (effect: Effect): Point[] | null => {
    const named = effect.edge ? routed.get(effect.edge) : undefined
    if (named) return named
    const forward = routed.get(`${effect.from}>${effect.to}`)
    if (forward) return forward
    const reverse = [...edges].find((e) => e.from === effect.to && e.to === effect.from)
    const back = reverse ? routed.get(reverse.id) : undefined
    if (back) return [...back].reverse()
    const a = center(effect.from)
    const b = center(effect.to)
    return a && b ? [a, b] : null
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
                const points = pathFor(effect)
                return points ? (
                  <Dot key={key} points={points} durationMs={durationMs} tone={effect.tone} />
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
                    ? `${what} ${title}, ${word}`
                    : `${isLead ? 'Lead' : `${what} ${title}`}, ${glyph.name}, ${word}`
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
                        {glyph.name} · {word}
                      </span>
                    </>
                  ) : (
                    <>
                      <b>
                        {isLead ? 'Lead' : title} {!shaped && <i>{glyph.name}</i>}
                      </b>
                      <span>{word}</span>
                    </>
                  )}
                </span>
                {visual === 'gate' && <span className="orch-node__flag">Needs you</span>}
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
