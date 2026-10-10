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

const NODE_W = 176
const NODE_H = 68
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
}: DiagramProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const layout = useMemo(
    () =>
      layoutFlow(
        {
          nodes: nodes.map((node) => ({ id: node.id, width: NODE_W, height: NODE_H })),
          edges: edges.map(({ id, from, to, kind }) => ({ id, from, to, kind })),
        },
        { columnGap: 56, rowGap: 28, marginX: 14, marginY: 18 },
      ),
    [nodes, edges],
  )
  const position = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout.nodes])
  const routed = useMemo(() => new Map(layout.edges.map((e) => [e.id, e.points])), [layout.edges])
  const center = (id: string): Point | null => {
    const at = position.get(id)
    return at ? { x: at.x + NODE_W / 2, y: at.y + NODE_H / 2 } : null
  }
  // Fit the diagram to the available width (never above 100%), so a phone sees all of it.
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const width = element.clientWidth
      setScale(width > 0 && layout.width > width ? width / layout.width : 1)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [layout.width])

  const pathFor = (effect: Effect): Point[] | null => {
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
    <div
      className="orch-canvas"
      ref={viewport}
      role="group"
      aria-label="Live diagram of the run. The log next to it says the same in words."
    >
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
              return (
                <path
                  key={edge.id}
                  d={d}
                  data-edge={edge.id}
                  className={`orch-edge orch-edge--${edge.kind}${litEdges.has(edge.id) ? ' orch-edge--lit' : ''}`}
                  markerEnd="url(#orch-arrow)"
                />
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
            const word = isLead
              ? lead === 'working'
                ? 'working'
                : lead === 'ended'
                  ? 'run ended'
                  : 'waiting'
              : visualLabel[visual!]
            return (
              <button
                key={node.id}
                type="button"
                className={`orch-node orch-node--${isLead ? `lead-${lead}` : visual}${selected === node.id ? ' orch-node--selected' : ''}${tone ? ` orch-node--lit ${toneClass(tone)}` : ''}`}
                style={{
                  left: at.x,
                  top: at.y,
                  width: NODE_W,
                  height: NODE_H,
                  ['--node-agent' as string]: glyph.style.color,
                }}
                data-node={node.id}
                data-state={isLead ? `lead-${lead}` : visual}
                aria-pressed={selected === node.id}
                aria-label={`${isLead ? 'Lead' : `Step ${node.id}`}, ${glyph.name}, ${word}`}
                onClick={() => onSelect(selected === node.id ? null : node.id)}
              >
                <AgentGlyph agent={glyph} size="sm" decorative />
                <span className="orch-node__text">
                  <b>{isLead ? 'Lead' : node.id}</b>
                  <span>
                    {glyph.name} · {word}
                  </span>
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
