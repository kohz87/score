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
import { runtimeLabel } from '../../components/runtime-label.ts'
import { layoutFlow, type Point } from '../../components/flow-layout/layout.ts'
import { withPositions } from '../../components/flow-layout/free-layout.ts'
import { KIND_LABEL, portsOf, type Draft } from './workflow-model.ts'
import {
  BIG_STEP,
  STEP,
  clampCoord,
  editSize,
  layoutOf,
  moveNode,
  snap,
  withLayout,
} from './workflow-layout.ts'
import { issuesForNode, worstSeverity, type IssueIndex } from './workflow-validation.ts'
import { edgeLabelOf } from './workflow-run-model.ts'
import type { LiveOverlay } from './use-live-overlay.ts'
import { NodeShape, shapedWord } from '../orchestrations/LiveDiagram.tsx'
import { statusSegments } from '../../live/status-line.ts'
import { visualLabel } from '../orchestrations/orch-model.ts'
import '../orchestrations/orchestrations.css'

// The editor's canvas (PLAN 7.1b, free placement 7.1c): the Flow canvas in edit mode. A definition without a layout is
// arranged automatically; dragging a node (or moving it with the keyboard: M, then the arrow keys) pins every node where
// it is drawn and saves the positions in the definition. Dragging from a port to a node connects them; clicking a port
// and then a node does the same, and so does the inspector's "Connect to…". Every node and connection is also listed in
// the outline, which is the canvas's text equivalent.

export type Selection = { kind: 'node' | 'edge'; id: string } | null
export const PALETTE_MIME = 'application/x-score-workflow-node'

const unknownStyle: AgentSummary['style'] = { color: '#8a909b', shape: 'circle-dot' }
const ZOOMS = [0.6, 0.75, 1, 1.25, 1.5]

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
  onLayout,
  announce,
  overlay = null,
  readOnly = false,
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
  /** Positions changed (a drag, a keyboard move, "Arrange automatically"); `coalesce` merges a run of key presses. */
  onLayout: (next: Draft, coalesce?: string) => void
  announce: (message: string) => void
  /** The states of a run going now, drawn over the nodes (PLAN 5.39); the draft is not touched. */
  overlay?: LiveOverlay | null
  /** Show the drawing without editing it: selection stays, moving, connecting and deleting do not. */
  readOnly?: boolean
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
  // A node being dragged: where it is shown while the pointer is down (committed once, on release).
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null)
  const move = useRef<{
    id: string
    dx: number
    dy: number
    pointer: { clientX: number; clientY: number; alt: boolean }
    moved: boolean
  } | null>(null)
  const suppressClick = useRef(false)
  // Keyboard move mode: arrows move the node instead of changing the focus.
  const [moving, setMoving] = useState<string | null>(null)
  const scale = fit * zoom

  const sizes = useMemo(
    () => new Map(draft.nodes.map((node) => [node.id, editSize(node)])),
    [draft.nodes],
  )
  const auto = useMemo(
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
  const arranged = Boolean(draft.layout)
  const busy = dragging !== null
  const placed = useMemo(() => {
    const map = new Map(Object.entries(layoutOf(draft)))
    if (dragging) map.set(dragging.id, { x: dragging.x, y: dragging.y })
    return map
  }, [draft, dragging])
  const layout = useMemo(
    () =>
      withPositions(
        auto,
        draft.nodes.map((node) => ({
          id: node.id,
          width: sizes.get(node.id)!.w,
          height: sizes.get(node.id)!.h,
        })),
        draft.edges.map(({ id, from, to }) => ({ id, from, to, kind: 'flow' })),
        placed,
        {
          marginX: 18,
          marginY: 22,
          // Room to drag into once the drawing is the person's own.
          ...(arranged ? { slack: { x: 160, y: 120 } } : {}),
          startY: (edgeId, rect) => {
            const edge = draft.edges.find((e) => e.id === edgeId)
            const from = edge && draft.nodes.find((n) => n.id === edge.from)
            return from && edge ? portY(from, rect, rect.h, edge.port) : rect.y + rect.h / 2
          },
        },
      ),
    [auto, draft.nodes, draft.edges, sizes, placed, arranged],
  )
  const position = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout.nodes])
  // Where nodes are drawn when nothing is pinned yet (the first move pins them all there).
  const placedBase = useMemo(() => new Map(auto.nodes.map((n) => [n.id, n])), [auto.nodes])
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
    // The scale stays put while a node is dragged, so the node does not slip away from the pointer.
    const update = () => {
      if (busy) return
      setFit(
        el.clientWidth > 0 && layout.width > el.clientWidth
          ? Math.max(0.75, el.clientWidth / layout.width)
          : 1,
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [layout.width, busy])

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
    if (readOnly || event.button !== 0) return
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

  // ---- Free placement: drag with the pointer (snaps to the grid; Alt switches snapping off).
  function dragTo(id: string, pointer: { clientX: number; clientY: number; alt: boolean }) {
    const grab = move.current
    if (!grab) return
    const at = worldPoint(pointer)
    setDragging({
      id,
      x: clampCoord(snap(at.x - grab.dx, pointer.alt)),
      y: clampCoord(snap(at.y - grab.dy, pointer.alt)),
    })
  }
  function startMove(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (readOnly || event.button !== 0 || connecting) return
    const at = position.get(id)
    if (!at) return
    const point = worldPoint(event)
    move.current = {
      id,
      dx: point.x - at.x,
      dy: point.y - at.y,
      pointer: { clientX: event.clientX, clientY: event.clientY, alt: event.altKey },
      moved: false,
    }
    drag.current = { x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  function moveMove(event: PointerEvent<HTMLButtonElement>, id: string) {
    const grab = move.current
    const start = drag.current
    if (!grab || !start || grab.id !== id) return
    if (!grab.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 4) return
    grab.moved = true
    grab.pointer = { clientX: event.clientX, clientY: event.clientY, alt: event.altKey }
    dragTo(id, grab.pointer)
  }
  function endMove(event: PointerEvent<HTMLButtonElement>, id: string) {
    const grab = move.current
    move.current = null
    drag.current = null
    if (!grab || grab.id !== id || !grab.moved) {
      setDragging(null)
      return
    }
    // The click that follows a drag must not select or connect.
    suppressClick.current = true
    window.setTimeout(() => {
      suppressClick.current = false
    }, 0)
    const at = worldPoint(event)
    const x = clampCoord(snap(at.x - grab.dx, event.altKey))
    const y = clampCoord(snap(at.y - grab.dy, event.altKey))
    setDragging(null)
    onLayout(moveNode(draft, placedBase, id, { x, y }))
    announce(`Moved ${nodeById.get(id)?.label ?? id}.`)
  }
  // Pan while dragging near the edge of the canvas.
  useEffect(() => {
    if (!dragging) return
    const timer = window.setInterval(() => {
      const el = viewport.current
      const grab = move.current
      if (!el || !grab) return
      const rect = el.getBoundingClientRect()
      const edge = 36
      const { clientX, clientY } = grab.pointer
      const dx = clientX > rect.right - edge ? 18 : clientX < rect.left + edge ? -18 : 0
      const dy = clientY > rect.bottom - edge ? 18 : clientY < rect.top + edge ? -18 : 0
      if (dx === 0 && dy === 0) return
      const before = { x: el.scrollLeft, y: el.scrollTop }
      el.scrollBy?.(dx, dy)
      if (el.scrollLeft !== before.x || el.scrollTop !== before.y) dragTo(grab.id, grab.pointer)
    }, 40)
    return () => window.clearInterval(timer)
    // dragTo reads refs and the latest scale through the closure of the render that started the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging !== null, scale])

  // ---- Keyboard move: M, then the arrow keys (Shift = bigger steps), Enter or Escape to finish.
  function nudge(id: string, key: string, big: boolean) {
    const at = position.get(id)
    if (!at) return
    const step = big ? BIG_STEP : STEP
    const to = {
      x: key === 'ArrowLeft' ? at.x - step : key === 'ArrowRight' ? at.x + step : at.x,
      y: key === 'ArrowUp' ? at.y - step : key === 'ArrowDown' ? at.y + step : at.y,
    }
    const next = { x: clampCoord(snap(to.x)), y: clampCoord(snap(to.y)) }
    onLayout(moveNode(draft, placedBase, id, next), `move:${id}`)
    announce(`${nodeById.get(id)?.label ?? id} at ${next.x}, ${next.y}.`)
  }

  function focusNode(id: string) {
    setActiveId(id)
    const button = nodeRefs.current.get(id)
    button?.focus()
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  function onNodeKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const here = position.get(id)!
    if (moving === id) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        nudge(id, event.key, event.shiftKey)
      } else if (['Enter', 'Escape', 'm', 'M', ' '].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        setMoving(null)
        announce(`Stopped moving ${nodeById.get(id)?.label ?? id}.`)
      }
      return
    }
    if (
      !readOnly &&
      (event.key === 'm' || event.key === 'M') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault()
      event.stopPropagation()
      setMoving(id)
      announce(
        `Moving ${nodeById.get(id)?.label ?? id}. Arrow keys move it, Shift for bigger steps, Enter or Escape to finish.`,
      )
      return
    }
    if (!readOnly && (event.key === 'Delete' || event.key === 'Backspace')) {
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
    if (readOnly) return
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
        <span className="orch-muted">
          {readOnly
            ? 'Read-only graph. Choose a step to inspect it.'
            : arranged
              ? 'Drag a step to move it. Hold Alt to skip the grid.'
              : 'Steps are arranged for you until you move one.'}
        </span>
        {!readOnly && (
          <button
            type="button"
            className="wf-arrange"
            disabled={!arranged}
            title={arranged ? undefined : 'Already arranged automatically'}
            onClick={() => {
              onLayout(withLayout(draft, undefined))
              announce('Arranged automatically.')
            }}
          >
            Arrange automatically
          </button>
        )}
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
          {portsOf(connectingFrom).find((p) => p.id === connecting.port)?.label}). Choose the step
          it leads to, or press Escape.
          <button type="button" className="wf-link" onClick={() => setConnecting(null)}>
            Stop connecting
          </button>
        </p>
      )}
      {selectedEdge && !readOnly && (
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
        aria-label={
          readOnly
            ? 'Read-only workflow graph. Arrow keys move between steps and Enter selects one.'
            : 'Workflow canvas. Arrow keys move between steps, Enter selects one, M then the arrow keys moves the focused step, Delete removes it. Drag a step to place it. The outline below lists the same steps and connections.'
        }
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
                const taken = overlay?.edges.get(edge.id)
                return (
                  <g key={edge.id} data-edge-id={edge.id}>
                    <path
                      d={d}
                      data-edge={edge.id}
                      {...(taken ? { 'data-edge-state': taken } : {})}
                      className={`orch-edge orch-edge--${edge.port === 'failed' ? 'failed' : edge.port === 'rejected' ? 'rejected' : 'ok'}${taken ? ` orch-edge--${taken}` : ''}${on ? ' wf-edge--selected' : ''}${bad ? ' wf-edge--bad' : ''}`}
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
              // A coding agent shows which program it runs on, as in the live view.
              const cli = runtimeLabel(agent?.runtime)
              const mine = issuesForNode(issues, draft, node.id)
              const worst = worstSeverity(mine)
              const shaped = node.kind !== 'agent'
              const isOn = selected?.kind === 'node' && selected.id === node.id
              const ports = portsOf(node)
              const live = overlay?.nodes.get(node.id)
              const second =
                live?.status ??
                (live
                  ? shapedWord(node.kind, live.visual)
                  : node.kind === 'agent'
                    ? glyph.name
                    : node.kind === 'branch'
                      ? `${node.rules.length} ${node.rules.length === 1 ? 'rule' : 'rules'} and otherwise`
                      : node.kind === 'gate'
                        ? 'waits for you'
                        : node.kind === 'join'
                          ? 'waits for all'
                          : 'finishes the run')
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
                    className={`orch-node orch-node--edit${live ? ` orch-node--${live.visual}` : ''}${shaped ? ` orch-node--shaped orch-node--shape-${node.kind}` : ''}${isOn ? ' orch-node--selected' : ''}${moving === node.id ? ' orch-node--moving' : ''}${dragging?.id === node.id ? ' orch-node--dragging' : ''}`}
                    style={{
                      width: size.w,
                      height: size.h,
                      ['--node-agent' as string]: glyph.style.color,
                    }}
                    data-node={node.id}
                    data-kind={node.kind}
                    aria-pressed={isOn}
                    aria-keyshortcuts={readOnly ? undefined : 'M'}
                    aria-label={`${KIND_LABEL[node.kind]} ${node.label || node.id}${node.kind === 'agent' ? `, ${glyph.name}${cli ? ` (${cli})` : ''}` : ''}${live ? `, ${visualLabel[live.visual]}${live.status ? `: ${live.status.replaceAll('`', '')}` : ''}` : ''}${mine.length > 0 ? `, ${mine.length} ${mine.length === 1 ? 'problem' : 'problems'}` : ''}`}
                    tabIndex={node.id === focusId ? 0 : -1}
                    onFocus={() => setActiveId(node.id)}
                    onBlur={() => setMoving((current) => (current === node.id ? null : current))}
                    onPointerDown={(event) => startMove(event, node.id)}
                    onPointerMove={(event) => moveMove(event, node.id)}
                    onPointerUp={(event) => endMove(event, node.id)}
                    onPointerCancel={() => {
                      move.current = null
                      drag.current = null
                      setDragging(null)
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressClick.current) return
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
                      <span>
                        {statusSegments(second).map((segment, i) =>
                          i % 2 === 1 ? <code key={i}>{segment}</code> : segment,
                        )}
                      </span>
                    </span>
                    {cli && <span className="orch-node__cli">{cli}</span>}
                    {live?.visual === 'gate' && (
                      <span className="orch-node__flag" data-protected="inline">
                        Needs you
                      </span>
                    )}
                  </button>
                  {mine.length > 0 && (
                    <span className={`wf-node__flag wf-node__flag--${worst}`} aria-hidden="true">
                      {worst === 'error' ? '✕' : '!'} {mine.length}
                    </span>
                  )}
                  {!readOnly &&
                    ports.map((port, index) => (
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
