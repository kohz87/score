import type {
  NeedsYou,
  OrchestrationDetail,
  WorkflowNeedsYou,
  WorkflowRunDetail,
} from '@score/contract'

export type OrchestrationNeedEntry = {
  key: string
  item: NeedsYou
  fenceStepId?: string
}

/** One card per item the run asks for; a cancelled step that is also unconfirmed stays one card with both choices. */
export function orchestrationNeedEntries(
  run: Pick<OrchestrationDetail, 'needsYou'>,
): OrchestrationNeedEntry[] {
  const unknownIds = new Set(
    run.needsYou.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const entries: OrchestrationNeedEntry[] = []
  for (const item of run.needsYou) {
    if (item.kind === 'cancel_fence' && unknownIds.has(item.attemptId)) continue
    if (item.kind === 'unknown') {
      const fence = run.needsYou.find(
        (entry) => entry.kind === 'cancel_fence' && entry.attemptId === item.attemptId,
      )
      entries.push({
        key: `unknown-${item.attemptId}`,
        item,
        ...(fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}),
      })
    } else {
      entries.push({ key: `${item.kind}-${needId(item)}`, item })
    }
  }
  return entries
}

export type WorkflowNeedEntry = {
  key: string
  item: WorkflowNeedsYou
  fenceStepId?: string
}

/** What the workflow still asks of the person; once it stops, only work winding down keeps its card. */
export function workflowNeedEntries(
  run: Pick<WorkflowRunDetail, 'needsYou' | 'status'>,
): WorkflowNeedEntry[] {
  const deciding = run.status === 'running' || run.status === 'paused'
  const items = run.needsYou.filter(
    (item) =>
      deciding || item.kind === 'unknown' || item.kind === 'cancel_fence' || item.kind === 'fence',
  )
  const unknownIds = new Set(
    items.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const entries: WorkflowNeedEntry[] = []
  for (const item of items) {
    if (item.kind === 'cancel_fence' && unknownIds.has(item.attemptId)) continue
    if (item.kind === 'unknown') {
      const fence = items.find(
        (entry) => entry.kind === 'cancel_fence' && entry.attemptId === item.attemptId,
      )
      entries.push({
        key: `unknown-${item.attemptId}`,
        item,
        ...(fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}),
      })
    } else {
      entries.push({ key: `${item.kind}-${needId(item)}`, item })
    }
  }
  return entries
}

function needId(item: NeedsYou | WorkflowNeedsYou): string {
  switch (item.kind) {
    case 'gate':
      return item.gateId
    case 'inquiry':
      return item.inquiryId
    case 'budget':
    case 'paused':
    case 'fence':
      return item.reason
    case 'unknown':
      return item.attemptId
    case 'cancel_fence':
      return item.stepId
    case 'remap':
      return item.agentId
    case 'policy_changed':
      return item.stepId
    case 'coding_limit':
      return 'coding_limit' in item && 'stepId' in item ? item.stepId : 'run'
    case 'quota_low':
      return 'stepId' in item ? item.stepId : item.nodeId
    case 'retry':
    case 'refusal_limit':
    case 'coding_agent_changed':
    case 'coding_held_back':
    case 'node_inputs_withdrawn':
      return item.nodeId
  }
}
