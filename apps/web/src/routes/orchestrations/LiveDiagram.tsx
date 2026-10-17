import type { AgentSummary } from '@score/contract'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { statusSegments } from '../../live/status-line.ts'
import { MOTION, loadAnime, playMotion, usePrefersReducedMotion } from '../../motion/motion.ts'
import { layoutFlow, type Point } from '../now/flow/layout.ts'
import { withPositions, type PositionMap } from '../now/flow/free-layout.ts'
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

export { usePrefersReducedMotion }

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

interface DotRoute {
  points: Point[]
  /** The drawn edge this dot rides on, when there is one; `reverse` when the hand-off goes against its direction. */
  edge: string | null
  reverse: boolean
}

/**
 * A dot rides the real SVG edge path (anime.js motion path), so it follows the routed corners exactly. Without a drawn
 * edge (a straight fallback) it rides a hidden path of the same points. Not rendered at all with reduced motion.
 */
function Dot({
  route: given,
  durationMs,
  tone,
}: {
  route: DotRoute
  durationMs: number
  tone: EffectTone
}) {
  const ref = useRef<SVGCircleElement>(null)
  // Fixed at mount: a re-render of the diagram must not restart a dot that is already travelling.
  const [route] = useState(given)
  useLayoutEffect(() => {
    const circle = ref.current
    const svgRoot = circle?.ownerSVGElement
    if (!circle || !svgRoot) return
    let temp: SVGPathElement | null = null
    const stop = playMotion(({ animate, svg }) => {
      let path: SVGPathElement | null = route.edge
        ? svgRoot.querySelector<SVGPathElement>(`path[data-edge="${CSS.escape(route.edge)}"]`)
        : null
      if (!path) {
        const ordered = route.reverse ? [...route.points].reverse() : route.points
        temp = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        temp.setAttribute('d', ordered.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '))
        temp.setAttribute('fill', 'none')
        svgRoot.appendChild(temp)
        path = temp
      }
      if (typeof path.getTotalLength !== 'function') return
      const reversed = path === temp ? false : route.reverse
      circle.style.opacity = '1'
      const animation = animate(circle, {
        ...svg.createMotionPath(path),
        rotate: 0,
        duration: durationMs,
        ease: 'inOutQuad',
        reversed,
      })
      return () => {
        animation.cancel()
      }
    })
    return () => {
      stop()
      temp?.remove()
    }
  }, [route, durationMs])
  return (
    <circle
      ref={ref}
      className={`orch-dot ${toneClass(tone)}`}
      r="6"
      cx="0"
      cy="0"
      style={{ opacity: 0 }}
    />
  )
}

const CHECK_PATH = 'M4 11 L9 16 L18 5'

/**
 * Node state changes (queued → running → done / failed): a short settle of the node, a ring that flows out of it and,
 * for done, a check that draws itself. Several nodes changing at once start in a short stagger. The first render, and
 * nodes that merely appear, do not animate; neither does a quiet diagram (reduced motion, fast replay).
 */
function useNodeTransitions(
  root: React.RefObject<HTMLDivElement | null>,
  visuals: ReadonlyMap<string, NodeVisual>,
  quiet: boolean,
) {
  const previous = useRef<Map<string, NodeVisual> | null>(null)
  const running = useRef(new Set<() => void>())
  useEffect(() => {
    const before = previous.current
    previous.current = new Map(visuals)
    if (!before || quiet || !root.current) return
    const changed: Array<{ id: string; to: NodeVisual }> = []
    for (const [id, to] of visuals) {
      const was = before.get(id)
      if (was !== undefined && was !== to) changed.push({ id, to })
    }
    if (changed.length === 0) return
    const container = root.current
    const stop = playMotion(({ animate, svg }) => {
      const cleanups: Array<() => void> = []
      const nodes = changed.flatMap(({ id, to }) => {
        const node = container.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)
        return node ? [{ node, to }] : []
      })
      nodes.forEach(({ node, to }, index) => {
        const start = index * MOTION.stagger
        const ring = document.createElement('span')
        ring.className = 'orch-node__ring'
        ring.setAttribute('aria-hidden', 'true')
        node.appendChild(ring)
        const settle = animate(node, {
          scale: [
            { to: 1.045, duration: 160 },
            { to: 1, duration: 300 },
          ],
          delay: start,
          ease: MOTION.ease,
          onComplete: () => node.style.removeProperty('transform'),
        })
        const flow = animate(ring, {
          opacity: [0.45, 0],
          scale: [1, 1.12],
          duration: MOTION.slow,
          delay: start,
          ease: MOTION.ease,
          onComplete: () => ring.remove(),
        })
        cleanups.push(() => {
          settle.cancel()
          flow.cancel()
          node.style.removeProperty('transform')
          ring.remove()
        })
        if (to === 'succeeded') {
          const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          mark.setAttribute('class', 'orch-node__check')
          mark.setAttribute('viewBox', '0 0 22 22')
          mark.setAttribute('aria-hidden', 'true')
          const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          tick.setAttribute('d', CHECK_PATH)
          mark.appendChild(tick)
          node.appendChild(mark)
          const [drawable] = svg.createDrawable(tick)
          const draw = animate(drawable!, {
            draw: ['0 0', '0 1'],
            duration: MOTION.base,
            delay: start + 120,
            ease: MOTION.ease,
          })
          const fade = animate(mark, {
            opacity: [1, 0],
            duration: MOTION.fast,
            delay: start + 120 + MOTION.base + 500,
            ease: 'linear',
            onComplete: () => mark.remove(),
          })
          cleanups.push(() => {
            draw.cancel()
            fade.cancel()
            mark.remove()
          })
        }
      })
      const all = () => cleanups.forEach((fn) => fn())
      running.current.add(all)
      window.setTimeout(() => running.current.delete(all), 3000)
    })
    running.current.add(stop)
  }, [visuals, quiet, root])
  useEffect(() => {
    const live = running.current
    return () => {
      live.forEach((fn) => fn())
      live.clear()
    }
  }, [])
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
