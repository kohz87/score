import type { AgentSummary, WorkflowNode } from '@score/contract'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { nodeSize, NodeShape } from '../orchestrations/LiveDiagram.tsx'
import { layoutFlow, type Point } from '../now/flow/layout.ts'
import { KIND_LABEL, portsOf, type Draft } from './workflow-model.ts'
import { issuesForNode, worstSeverity, type IssueIndex } from './workflow-validation.ts'
import { edgeLabelOf } from './workflow-run-model.ts'
import '../orchestrations/orchestrations.css'

// The editor's canvas (PLAN 7.1b): the Flow canvas in edit mode. Nodes are placed automatically (the definition has no
// coordinates), so "placing" means adding a node and connecting it. Dragging from a port to a node connects them;
// clicking a port and then a node does the same, and so does the inspector's "Connect to…". Every node and connection
// is also listed in the outline, which is the canvas's text equivalent.

export type Selection = { kind: 'node' | 'edge'; id: string } | null
export const PALETTE_MIME = 'application/x-score-workflow-node'

const PORT_PITCH = 24
const unknownStyle: AgentSummary['style'] = { color: '#8a909b', shape: 'circle-dot' }
const ZOOMS = [0.6, 0.75, 1, 1.25, 1.5]

/** Editor sizes: a branch grows with its rules so every port has room. */
function editSize(node: WorkflowNode): { w: number; h: number } {
  const base = nodeSize({ shape: node.kind })
  const ports = portsOf(node).length
  return { w: base.w, h: Math.max(base.h, PORT_PITCH * ports + 14) }
}

/** Where on the right edge of a node each of its ports sits. */
function portY(node: WorkflowNode, at: { y: number }, height: number, port: string): number {
  const ports = portsOf(node)
  const index = Math.max(
    0,
    ports.findIndex((p) => p.id === port),
  )
  return at.y + ((index + 1) * height) / (ports.length + 1)
}

export function EditorCanvas({
  draft,
  agents,
  issues,
  selected,
  onSelect,
  onConnect,
  onDropKind,
  onDeleteNode,
  onDeleteEdge,
  announce,
}: {
  draft: Draft
  agents: AgentSummary[]
  issues: IssueIndex
  selected: Selection
  onSelect: (selection: Selection) => void
  /** Returns a plain-words reason when the connection is not possible. */
  onConnect: (from: string, port: string, to: string) => string | null
  onDropKind: (
    payload: { kind: WorkflowNode['kind']; agentId: string },
    onto: string | null,
  ) => void
  onDeleteNode: (id: string) => void
  onDeleteEdge: (id: string) => void
  announce: (message: string) => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const [fit, setFit] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [connecting, setConnecting] = useState<{ from: string; port: string } | null>(null)
  const [pointer, setPointer] = useState<Point | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const scale = fit * zoom

  const sizes = useMemo(
    () => new Map(draft.nodes.map((node) => [node.id, editSize(node)])),
    [draft.nodes],
  )
  const layout = useMemo(
    () =>
      layoutFlow(
        {
          nodes: draft.nodes.map((node) => ({
            id: node.id,
            width: sizes.get(node.id)!.w,
            height: sizes.get(node.id)!.h,
          })),
          edges: draft.edges.map(({ id, from, to }) => ({ id, from, to, kind: 'flow' })),
        },
        { columnGap: 96, rowGap: 28, marginX: 18, marginY: 22 },
      ),
    [draft.nodes, draft.edges, sizes],
  )
  const position = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout.nodes])
  const nodeById = useMemo(() => new Map(draft.nodes.map((n) => [n.id, n])), [draft.nodes])
  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const ordered = useMemo(
    () => [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y).map((n) => n.id),
    [layout.nodes],
  )
  const focusId =
    activeId && position.has(activeId)
      ? activeId
      : selected?.kind === 'node' && position.has(selected.id)
        ? selected.id
        : (ordered[0] ?? null)

  // Fit the drawing to the width when it is wider than the screen, but never below 75% (smaller is unreadable).
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () =>
      setFit(
        el.clientWidth > 0 && layout.width > el.clientWidth
          ? Math.max(0.75, el.clientWidth / layout.width)
          : 1,
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [layout.width])

  // The route of an edge, starting at the port it leaves from.
  const routes = useMemo(() => {
    const map = new Map<string, Point[]>()
    for (const edge of draft.edges) {
      const raw = layout.edges.find((e) => e.id === edge.id)?.points
      const from = nodeById.get(edge.from)
      const at = position.get(edge.from)
      const size = sizes.get(edge.from)
      if (!raw || !from || !at || !size) continue
      const y = portY(from, at, size.h, edge.port)
      const [p, a, b, q] = raw
      if (raw.length === 4 && p && a && b && q && !layout.edges.find((e) => e.id === edge.id)?.back)
        map.set(edge.id, [{ x: p.x, y }, { x: a.x, y }, b, q])
      else map.set(edge.id, raw)
    }
    return map
  }, [draft.edges, layout.edges, nodeById, position, sizes])

  function worldPoint(event: { clientX: number; clientY: number }): Point {
    const rect = world.current!.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }
  }

  function finishConnect(to: string) {
    if (!connecting) return
    const error = onConnect(connecting.from, connecting.port, to)
    if (error) announce(error)
    setConnecting(null)
    setPointer(null)
  }

  function startConnect(event: PointerEvent<HTMLButtonElement>, from: string, port: string) {
    if (event.button !== 0) return
    event.preventDefault()
    drag.current = { x: event.clientX, y: event.clientY, moved: false }
    setConnecting({ from, port })
    setPointer(worldPoint(event))
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  function moveConnect(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current
    if (!start || !connecting) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) start.moved = true
    setPointer(worldPoint(event))
  }
  function endConnect(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current
    drag.current = null
    if (!start || !connecting) return
    if (!start.moved) return // a click: the next click on a node completes it
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-wf-node]')
      ?.getAttribute('data-wf-node')
    if (target && target !== connecting.from) finishConnect(target)
    else {
      setConnecting(null)
      setPointer(null)
    }
  }

  function focusNode(id: string) {
    setActiveId(id)
    const button = nodeRefs.current.get(id)
    button?.focus()
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  function onNodeKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const here = position.get(id)!
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      onDeleteNode(id)
      return
    }
    let target: string | undefined
    if (event.key === 'Home') target = ordered[0]
    else if (event.key === 'End') target = ordered[ordered.length - 1]
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      let best = Infinity
      for (const other of layout.nodes) {
        if (other.id === id) continue
        const dx = other.x - here.x
        const dy = other.y - here.y
        const along = { ArrowRight: dx, ArrowLeft: -dx, ArrowDown: dy, ArrowUp: -dy }[
          event.key as 'ArrowRight'
        ]
        if (along <= 0) continue
        const across = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? dy : dx
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

  useEffect(() => {
    if (!connecting) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConnecting(null)
        setPointer(null)
        announce('Connecting cancelled.')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [connecting, announce])

  function onDrop(event: DragEvent, onto: string | null) {
    const raw = event.dataTransfer.getData(PALETTE_MIME)
    setDropOn(null)
    if (!raw) return
    event.preventDefault()
    event.stopPropagation()
    try {
      const parsed = JSON.parse(raw) as { kind: WorkflowNode['kind']; agentId: string }
      onDropKind(parsed, onto)
    } catch {
      /* not ours */
    }
  }

  const selectedEdge =
    selected?.kind === 'edge' ? draft.edges.find((e) => e.id === selected.id) : undefined
  const connectingFrom = connecting ? nodeById.get(connecting.from) : undefined
  const ghost =
    connecting && pointer && connectingFrom
      ? (() => {
          const at = position.get(connecting.from)!
          const size = sizes.get(connecting.from)!
          const start = { x: at.x + size.w, y: portY(connectingFrom, at, size.h, connecting.port) }
          return `M ${start.x} ${start.y} L ${pointer.x} ${pointer.y}`
        })()
      : null

  return (
    <div className="wf-canvas">
      <div className="wf-canvas__bar">
        <span className="orch-muted">Nodes are arranged for you.</span>
        <div className="wf-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= ZOOMS[0]!}
            onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)] ?? 1)}
          >
            −
          </button>
          <span role="status" aria-label="Zoom level">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= ZOOMS[ZOOMS.length - 1]!}
            onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)] ?? 1)}
          >
            +
          </button>
          <button type="button" aria-label="Reset zoom" onClick={() => setZoom(1)}>
            Reset
          </button>
        </div>
      </div>
      {connecting && connectingFrom && (
        <p className="wf-banner" role="status">
          Connecting {connectingFrom.label} (
          {portsOf(connectingFrom).find((p) => p.id === connecting.port)?.label}). Choose the node
          it leads to, or press Escape.
          <button type="button" className="wf-link" onClick={() => setConnecting(null)}>
            Cancel
          </button>
        </p>
      )}
      {selectedEdge && (
        <p className="wf-banner" role="status">
          Connection from {nodeById.get(selectedEdge.from)?.label} to{' '}
          {nodeById.get(selectedEdge.to)?.label} selected.
          <button type="button" className="wf-link" onClick={() => onDeleteEdge(selectedEdge.id)}>
            Remove this connection
          </button>
        </p>
      )}
      <div
        ref={viewport}
        className="orch-canvas wf-canvas__viewport"
        role="group"
        aria-label="Workflow canvas. Arrow keys move between nodes, Enter selects one, Delete removes it. The outline below lists the same nodes and connections."
        onClick={(event) => {
          if (
            event.target === event.currentTarget ||
            (event.target as Element).closest('.orch-world-inner') === event.target
          )
            onSelect(null)
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(PALETTE_MIME)) event.preventDefault()
        }}
        onDrop={(event) => onDrop(event, null)}
      >
        <div
          className="orch-world"
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            ref={world}
            className="orch-world-inner"
            style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
          >
            <svg
              className="orch-edges wf-edges"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="wf-edit-arrow"
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
              {draft.edges.map((edge) => {
                const points = routes.get(edge.id)
                if (!points) return null
                const d = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
                const from = nodeById.get(edge.from)
                const label = edgeLabelOf(from, edge.port)
                const a = points[1]
                const b = points[2]
                const bad = issues.byEdge.get(edge.id)
                const on = selected?.kind === 'edge' && selected.id === edge.id
                return (
                  <g key={edge.id} data-edge-id={edge.id}>
                    <path
                      d={d}
                      data-edge={edge.id}
                      className={`orch-edge orch-edge--${edge.port === 'failed' ? 'failed' : edge.port === 'rejected' ? 'rejected' : 'ok'}${on ? ' wf-edge--selected' : ''}${bad ? ' wf-edge--bad' : ''}`}
                      markerEnd="url(#wf-edit-arrow)"
                    />
                    <path
                      d={d}
                      className="wf-edge__hit"
                      onClick={(event) => {
                        event.stopPropagation()
                        onSelect({ kind: 'edge', id: edge.id })
                      }}
                    />
                    {label && a && b && (
                      <text
                        className="orch-edge-label"
                        x={(a.x + b.x) / 2}
                        y={(a.y + b.y) / 2 + (a.y === b.y ? -6 : 4)}
                        textAnchor="middle"
                      >
                        {label}
                      </text>
                    )}
                  </g>
                )
              })}
              {ghost && <path d={ghost} className="wf-ghost" />}
            </svg>
            {draft.nodes.map((node) => {
              const at = position.get(node.id)
              const size = sizes.get(node.id)!
              if (!at) return null
              const agent = node.kind === 'agent' ? byId.get(node.agentId) : undefined
              const glyph = {
                id: node.kind === 'agent' ? node.agentId : node.id,
                name: agent?.name ?? (node.kind === 'agent' ? node.agentId || 'No agent yet' : ''),
                style: agent?.style ?? unknownStyle,
              }
              const mine = issuesForNode(issues, draft, node.id)
              const worst = worstSeverity(mine)
              const shaped = node.kind !== 'agent'
              const isOn = selected?.kind === 'node' && selected.id === node.id
              const ports = portsOf(node)
              const second =
                node.kind === 'agent'
                  ? glyph.name
                  : node.kind === 'branch'
                    ? `${node.rules.length} ${node.rules.length === 1 ? 'rule' : 'rules'} and otherwise`
                    : node.kind === 'gate'
                      ? 'waits for you'
                      : node.kind === 'join'
                        ? 'waits for all'
                        : 'finishes the run'
              return (
                <div
                  key={node.id}
                  className={`wf-node${worst ? ` wf-node--${worst}` : ''}${dropOn === node.id ? ' wf-node--drop' : ''}${connecting && connecting.from !== node.id ? ' wf-node--target' : ''}`}
                  style={{ left: at.x, top: at.y, width: size.w, height: size.h }}
                  data-wf-node={node.id}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes(PALETTE_MIME)) {
                      event.preventDefault()
                      setDropOn(node.id)
                    }
                  }}
                  onDragLeave={() => setDropOn((current) => (current === node.id ? null : current))}
                  onDrop={(event) => onDrop(event, node.id)}
                >
                  <button
                    ref={(el) => {
                      if (el) nodeRefs.current.set(node.id, el)
                      else nodeRefs.current.delete(node.id)
                    }}
                    type="button"
                    className={`orch-node orch-node--edit${shaped ? ` orch-node--shaped orch-node--shape-${node.kind}` : ''}${isOn ? ' orch-node--selected' : ''}`}
                    style={{
                      width: size.w,
                      height: size.h,
                      ['--node-agent' as string]: glyph.style.color,
                    }}
                    data-node={node.id}
                    data-kind={node.kind}
                    aria-pressed={isOn}
                    aria-label={`${KIND_LABEL[node.kind]} ${node.label || node.id}${node.kind === 'agent' ? `, ${glyph.name}` : ''}${mine.length > 0 ? `, ${mine.length} ${mine.length === 1 ? 'problem' : 'problems'}` : ''}`}
                    tabIndex={node.id === focusId ? 0 : -1}
                    onFocus={() => setActiveId(node.id)}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (connecting && connecting.from !== node.id) finishConnect(node.id)
                      else onSelect({ kind: 'node', id: node.id })
                    }}
                    onKeyDown={(event) => onNodeKeyDown(event, node.id)}
                  >
                    {shaped ? (
                      <NodeShape shape={node.kind} w={size.w} h={size.h} />
                    ) : (
                      <AgentGlyph agent={glyph} size="sm" decorative />
                    )}
                    <span className="orch-node__text">
                      <b>{node.label || node.id}</b>
                      <span>{second}</span>
                    </span>
                  </button>
                  {mine.length > 0 && (
                    <span className={`wf-node__flag wf-node__flag--${worst}`} aria-hidden="true">
                      {worst === 'error' ? '✕' : '!'} {mine.length}
                    </span>
                  )}
                  {ports.map((port, index) => (
                    <button
                      key={port.id}
                      type="button"
                      className={`wf-handle${connecting?.from === node.id && connecting.port === port.id ? ' wf-handle--on' : ''}`}
                      style={{ top: ((index + 1) * size.h) / (ports.length + 1) - 8 }}
                      aria-label={`Connect ${node.label || node.id} (${port.label})`}
                      aria-pressed={connecting?.from === node.id && connecting.port === port.id}
                      tabIndex={node.id === focusId ? 0 : -1}
                      onPointerDown={(event) => startConnect(event, node.id, port.id)}
                      onPointerMove={moveConnect}
                      onPointerUp={endConnect}
                      onClick={(event) => {
                        // Keyboard activation (a pointer click is handled by the pointer events above).
                        if (event.detail === 0) {
                          setConnecting(
                            connecting?.from === node.id && connecting.port === port.id
                              ? null
                              : { from: node.id, port: port.id },
                          )
                        }
                      }}
                    >
                      <span aria-hidden="true">
                        {port.id === 'failed' || port.id === 'rejected' ? '✕' : '›'}
                      </span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
