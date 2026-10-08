import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { AgentSummary, FlowEdge, FlowNode } from '@score/contract'
import { AgentGlyph } from '../../../components/AgentGlyph.tsx'
import { layoutFlow } from './layout.ts'
import './flow.css'

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 84
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
const MIN_ZOOM = ZOOM_STEPS[0]!
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!
const PAN_STEP = 48
const FIT_PADDING = 16

const stateLabel: Record<FlowNode['state'], string> = {
  done: 'done',
  working: 'working',
  needs_you: 'needs you',
  planned: 'planned',
  failed: 'failed',
}
const edgeMarkerKinds = ['flow', 'handoff', 'review', 'sent_back', 'planned'] as const
const unknownAgent: AgentSummary['style'] = { color: '#9AA0AB', shape: 'circle-dot' }

const clamp = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))

export type FlowCanvasProps = {
  nodes: FlowNode[]
  edges: FlowEdge[]
  agents: AgentSummary[]
  selectedId?: string | null
  onSelect?: (nodeId: string) => void
}

type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

export function FlowCanvas({ nodes, edges, agents, selectedId = null, onSelect }: FlowCanvasProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const zoomRef = useRef(1)
  const anchor = useRef<{ world: { x: number; y: number }; view: { x: number; y: number } } | null>(
    null,
  )
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [zoom, setZoomState] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)

  const layout = useMemo(
    () =>
      layoutFlow({
        nodes: nodes.map((node) => ({ id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
        edges: edges.map(({ id, from, to, kind }) => ({ id, from, to, kind })),
      }),
    [nodes, edges],
  )
  const position = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  )
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const ordered = useMemo(
    () => [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y).map((node) => node.id),
    [layout.nodes],
  )
  const focusId = activeId && position.has(activeId) ? activeId : (ordered[0] ?? null)

  const setZoom = useCallback((next: number, at?: { x: number; y: number }) => {
    const el = viewport.current
    const value = clamp(next)
    if (el) {
      const view = at ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
      anchor.current = {
        view,
        world: {
          x: (el.scrollLeft + view.x) / zoomRef.current,
          y: (el.scrollTop + view.y) / zoomRef.current,
        },
      }
    }
    zoomRef.current = value
    setZoomState(value)
  }, [])

  // Keeps the point under the cursor (or the viewport centre) fixed while the scale changes.
  useLayoutEffect(() => {
    const el = viewport.current
    const a = anchor.current
    anchor.current = null
    if (!el || !a) return
    el.scrollLeft = a.world.x * zoom - a.view.x
    el.scrollTop = a.world.y * zoom - a.view.y
  }, [zoom])

  const fit = useCallback(() => {
    const el = viewport.current
    if (!el || el.clientWidth === 0 || layout.width === 0) return
    const scale = Math.min(
      (el.clientWidth - FIT_PADDING) / layout.width,
      (el.clientHeight - FIT_PADDING) / layout.height,
    )
    anchor.current = null
    zoomRef.current = clamp(Math.min(scale, 1.5))
    setZoomState(zoomRef.current)
    el.scrollLeft = 0
    el.scrollTop = 0
  }, [layout.width, layout.height])

  // Mounted once per brief (FlowView keys it): start at 100%, or fitted when the graph is wider than the canvas.
  const initialised = useRef(false)
  const attachViewport = (el: HTMLDivElement | null) => {
    viewport.current = el
    if (!el || initialised.current) return
    initialised.current = true
    if (el.clientWidth > 0 && (layout.width > el.clientWidth || layout.height > el.clientHeight))
      fit()
  }

  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const box = el.getBoundingClientRect()
      setZoom(zoomRef.current * Math.exp(-event.deltaY * 0.002), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoom])

  const step = (direction: 1 | -1) => {
    const current = zoomRef.current
    const next =
      direction > 0
        ? ZOOM_STEPS.find((s) => s > current + 0.001)
        : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001)
    if (next !== undefined) setZoom(next)
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest('[data-flow-node]')) return
    const el = event.currentTarget
    drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop }
    el.setPointerCapture?.(event.pointerId)
    setDragging(true)
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current
    if (!start) return
    event.currentTarget.scrollLeft = start.left - (event.clientX - start.x)
    event.currentTarget.scrollTop = start.top - (event.clientY - start.y)
  }
  function endDrag() {
    drag.current = null
    setDragging(false)
  }

  function onViewportKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    const el = event.currentTarget
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-PAN_STEP, 0],
      ArrowRight: [PAN_STEP, 0],
      ArrowUp: [0, -PAN_STEP],
      ArrowDown: [0, PAN_STEP],
    }
    const move = moves[event.key]
    if (move) {
      event.preventDefault()
      el.scrollLeft += move[0]
      el.scrollTop += move[1]
    } else if (event.key === '+' || event.key === '=') step(1)
    else if (event.key === '-') step(-1)
    else if (event.key === '0') fit()
  }

  function focusNode(id: string) {
    setActiveId(id)
    const button = nodeRefs.current.get(id)
    button?.focus()
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  function onNodeKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const here = position.get(id)!
    let target: string | undefined
    if (event.key === 'Home') target = ordered[0]
    else if (event.key === 'End') target = ordered[ordered.length - 1]
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const direction = event.key as Direction
      let best = Infinity
      for (const other of layout.nodes) {
        if (other.id === id) continue
        const dx = other.x - here.x
        const dy = other.y - here.y
        const along = { ArrowRight: dx, ArrowLeft: -dx, ArrowDown: dy, ArrowUp: -dy }[direction]
        if (along <= 0) continue
        const across = direction === 'ArrowLeft' || direction === 'ArrowRight' ? dy : dx
        const cost = along + 3 * Math.abs(across)
        if (cost < best) {
          best = cost
          target = other.id
        }
      }
    } else return
    event.preventDefault()
    event.stopPropagation()
    if (target) focusNode(target)
  }

  const percent = `${Math.round(zoom * 100)}%`
  return (
    <div className="flow-canvas">
      <div className="flow-toolbar">
        <ul className="flow-legend" aria-label="Legend">
          <li>
            <span className="flow-swatch flow-swatch--done" aria-hidden="true" />
            Done
          </li>
          <li>
            <span className="flow-swatch flow-swatch--working" aria-hidden="true" />
            Working
          </li>
          <li>
            <span className="flow-swatch flow-swatch--needs" aria-hidden="true" />
            Needs you
          </li>
          <li>
            <span className="flow-swatch flow-swatch--planned" aria-hidden="true" />
            Planned
          </li>
        </ul>
        <div className="flow-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="flow-zoom__button"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM + 0.001}
            onClick={() => step(-1)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 7 H11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <span className="flow-zoom__percent" role="status" aria-label="Zoom level">
            {percent}
          </span>
          <button
            type="button"
            className="flow-zoom__button"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM - 0.001}
            onClick={() => step(1)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M7 3 V11 M3 7 H11"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="flow-zoom__button"
            aria-label="Fit to screen"
            onClick={fit}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M2 5 V2 H5 M9 2 H12 V5 M12 9 V12 H9 M5 12 H2 V9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div
        ref={attachViewport}
        className={`flow-viewport${dragging ? ' flow-viewport--dragging' : ''}`}
        role="group"
        aria-label="Flow canvas. Arrow keys pan, plus and minus zoom, zero fits. Tab to reach the steps."
        tabIndex={0}
        onKeyDown={onViewportKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className="flow-sizer"
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className="flow-world"
            data-testid="flow-world"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              className="flow-edges"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              <defs>
                {edgeMarkerKinds.map((kind) => (
                  <marker
                    key={kind}
                    id={`flow-arrow-${kind}`}
                    className={`flow-arrow flow-arrow--${kind}`}
                    orient="auto"
                    markerWidth="5"
                    markerHeight="5"
                    refX="3.2"
                    refY="2"
                    overflow="visible"
                  >
                    <path d="M0 0 L4 2 L0 4 Z" stroke="none" />
                  </marker>
                ))}
              </defs>
              {edges.map((edge) => {
                const routed = layout.edges.find((e) => e.id === edge.id)
                if (!routed) return null
                const points = routed.points
                const d = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
                // Label sits on the middle run: the lane under the cards for back edges, the gap otherwise.
                const a = points[1]!
                const b = points[2]!
                const labelAt = routed.back
                  ? { x: (a.x + b.x) / 2, y: a.y - 6 }
                  : { x: a.x, y: (points[0]!.y + points[3]!.y) / 2 - 8 }
                const from = nodeById.get(edge.from)?.title ?? edge.from
                const to = nodeById.get(edge.to)?.title ?? edge.to
                return (
                  <g
                    key={edge.id}
                    className={`flow-edge flow-edge--${edge.kind}`}
                    data-flow-edge={edge.id}
                    data-kind={edge.kind}
                    role="img"
                    aria-label={`${from} to ${to}${edge.label ? `, ${edge.label}` : ''}`}
                  >
                    <path d={d} markerEnd={`url(#flow-arrow-${edge.kind})`} />
                    {edge.label && (
                      <text x={labelAt.x} y={labelAt.y} textAnchor="middle">
                        {edge.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
            {nodes.map((node) => {
              const at = position.get(node.id)
              if (!at) return null
              const agent = node.agentId ? agentById.get(node.agentId) : undefined
              const glyphAgent = {
                id: node.agentId ?? 'unknown',
                name: agent?.name ?? node.agentId ?? 'Unknown agent',
                style: agent?.style ?? unknownAgent,
              }
              return (
                <button
                  key={node.id}
                  ref={(el) => {
                    if (el) nodeRefs.current.set(node.id, el)
                    else nodeRefs.current.delete(node.id)
                  }}
                  type="button"
                  className={`flow-node flow-node--${node.state}${node.kind === 'brief' ? ' flow-node--brief' : ''}${selectedId === node.id ? ' flow-node--selected' : ''}`}
                  style={{
                    left: at.x,
                    top: at.y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    ['--node-agent' as string]: glyphAgent.style.color,
                  }}
                  data-flow-node={node.id}
                  data-state={node.state}
                  aria-pressed={selectedId === node.id}
                  aria-label={`${node.title}, ${node.subtitle ? `${node.subtitle}, ` : ''}${stateLabel[node.state]}`}
                  tabIndex={node.id === focusId ? 0 : -1}
                  onFocus={() => setActiveId(node.id)}
                  onClick={() => onSelect?.(node.id)}
                  onKeyDown={(event) => onNodeKeyDown(event, node.id)}
                >
                  {node.kind === 'brief' ? (
                    <span className="flow-node__brief-icon" aria-hidden="true">
                      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                        <rect width="32" height="32" rx="10" fill="#2A2C35" />
                        <path
                          d="M9 11 H23 V19 H15 L11 23 V19 H9 Z"
                          stroke="#FFFFFF"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  ) : (
                    <AgentGlyph agent={glyphAgent} size="sm" decorative />
                  )}
                  <span className="flow-node__text">
                    <b title={node.title}>{node.title}</b>
                    {node.state === 'needs_you' ? (
                      <span className="flow-node__pill">Needs you</span>
                    ) : (
                      <span className="flow-node__subtitle">{node.subtitle}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
