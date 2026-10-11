import type { WorkflowRunSummary } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { useStatusLines } from '../../live/use-activity.ts'
import { isRunOver, type NodeVisual } from '../orchestrations/orch-model.ts'
import { useWorkflowRun, workflowRunsQuery } from './workflow-queries.ts'
import { edgeStatesOf, liveWorkflowVisuals } from './workflow-run-model.ts'

export interface OverlayNode {
  visual: NodeVisual
  /** What the step's agent is doing now (a status line), while it runs. */
  status?: string
}
export interface LiveOverlay {
  run: WorkflowRunSummary
  nodes: ReadonlyMap<string, OverlayNode>
  edges: ReadonlyMap<string, 'taken' | 'skipped'>
}

/**
 * The states of a run that is going now, for the version of a workflow on screen (PLAN 5.39). It is only read: drawing
 * it on the canvas never touches the draft. Null when no run of that version is active.
 */
export function useLiveOverlay(
  workflowId: string | null,
  version: number,
  enabled: boolean,
): LiveOverlay | null {
  const runs = useStreamQuery(workflowRunsQuery).data
  const active =
    enabled && workflowId !== null
      ? runs?.find(
          (run) =>
            run.workflowId === workflowId && run.version === version && !isRunOver(run.status),
        )
      : undefined
  const detail = useWorkflowRun(active?.id).data?.snapshot.run
  const working = useMemo(() => {
    if (!detail) return []
    const running = new Set(
      detail.nodeStates.filter((node) => node.state === 'running').map((node) => node.nodeId),
    )
    return detail.definition.nodes.flatMap((node) =>
      node.kind === 'agent' && running.has(node.id) ? [{ id: node.agentId, working: true }] : [],
    )
  }, [detail])
  const lines = useStatusLines(working)
  return useMemo(() => {
    if (!active || !detail) return null
    const visuals = liveWorkflowVisuals(detail)
    const nodes = new Map<string, OverlayNode>()
    for (const node of detail.definition.nodes) {
      const visual = visuals.get(node.id)
      if (!visual) continue
      const line =
        node.kind === 'agent' && visual === 'running' ? lines.get(node.agentId) : undefined
      nodes.set(node.id, { visual, ...(line ? { status: line } : {}) })
    }
    return { run: active, nodes, edges: edgeStatesOf(detail.tokens) }
  }, [active, detail, lines])
}
