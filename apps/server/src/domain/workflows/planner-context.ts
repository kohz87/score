import type { WorkflowNode } from '@score/contract'
import { createHash } from 'node:crypto'
import { touch, type Ctx } from '../orchestration/ctx.ts'
import { stopRun } from '../orchestration/decisions.ts'
import {
  addHistory,
  attemptsOf,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from '../orchestration/store.ts'
import { graphOf, type Graph } from './definition.ts'
import {
  nodesOf,
  requireWfRun,
  setNode,
  tokensOf,
  wfStepsOf,
  type WfNodeRow,
  type WfRunRow,
  type WfStepRow,
  type WfTokenRow,
} from './store.ts'

// The graph planner (design v8 "Planner principal and command identity"). A pure-looking pass over durable state: it
// reads node states, tokens and the executor's steps, and its only effects are rows in the same transaction as the event
// that woke it (a step result, a decision, a limits change, the periodic sweep). A crash before or after a pass
// re-derives the same commands; `wf_commands` makes a stored identity return its receipt.

export const START = '__start'
export const startEdge = (nodeId: string): string => `start:${nodeId}`
const FINAL = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])
export const isFinalNode = (state: string): boolean => FINAL.has(state)

export interface Pass {
  ctx: Ctx
  o: OrchRow
  wf: WfRunRow
  g: Graph
  nodes: Map<string, WfNodeRow>
  tokens: Map<string, WfTokenRow>
  steps: Map<string, StepRow>
  attempts: AttemptRow[]
  lineage: WfStepRow[]
  canIssue: boolean
}

export function load(ctx: Ctx, o: OrchRow): Pass {
  const { sqlite } = ctx
  const wf = requireWfRun(sqlite, o.id)
  return {
    ctx,
    o,
    wf,
    g: graphOf(wf.definition),
    nodes: new Map(nodesOf(sqlite, o.id).map((n) => [n.node_id, n])),
    tokens: new Map(tokensOf(sqlite, o.id).map((t) => [t.edge_id, t])),
    steps: new Map(stepsOf(sqlite, o.id).map((s) => [s.id, s])),
    attempts: attemptsOf(sqlite, o.id),
    lineage: wfStepsOf(sqlite, o.id),
    canIssue: o.status === 'running' && o.manual_paused_at === null,
  }
}

// ----------------------------------------------------------------------------------------------------- primitives

function note(p: Pass, kind: string, detail: Record<string, unknown>): void {
  addHistory(p.ctx.sqlite, p.o.id, kind, detail, p.ctx.now)
}

export function setState(
  p: Pass,
  nodeId: string,
  state: WfNodeRow['state'],
  patch: Parameters<typeof setNode>[3] = {},
): void {
  const { sqlite, now } = p.ctx
  setNode(sqlite, p.o.id, nodeId, {
    state,
    ...(isFinalNode(state) ? { ended_at: now } : {}),
    ...patch,
  })
  note(p, 'wf_node', { nodeId, state, reason: patch.reason ?? null })
  touch(p.ctx, p.o.id)
}

function insertToken(
  p: Pass,
  edgeId: string,
  kind: WfTokenRow['kind'],
  producedBy: string,
  attempt: number,
  consumedBy: string | null = null,
): void {
  const result = p.ctx.sqlite
    .prepare(
      `INSERT OR IGNORE INTO wf_tokens (orchestration_id, edge_id, kind, produced_by, produced_attempt, consumed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.o.id, edgeId, kind, producedBy, attempt, consumedBy, p.ctx.now)
  if (Number(result.changes) > 0) note(p, 'wf_token', { edgeId, kind, producedBy })
}

/** Tokens on the chosen ports carry `kind`; every other outgoing edge carries a skip. */
export function emit(
  p: Pass,
  nodeId: string,
  chosen: readonly string[],
  kind: WfTokenRow['kind'],
  attempt = 0,
): void {
  for (const edge of p.g.out.get(nodeId) ?? [])
    insertToken(p, edge.id, chosen.includes(edge.port) ? kind : 'skip', nodeId, attempt)
}

export function incomingTokens(
  p: Pass,
  nodeId: string,
): { edgeId: string; token: WfTokenRow | undefined }[] {
  const inc = p.g.inn.get(nodeId) ?? []
  const edgeIds = inc.length === 0 ? [startEdge(nodeId)] : inc.map((e) => e.id)
  return edgeIds.map((edgeId) => ({ edgeId, token: p.tokens.get(edgeId) }))
}

export function consumeIncoming(p: Pass, nodeId: string): number {
  const result = p.ctx.sqlite
    .prepare(
      `UPDATE wf_tokens SET consumed_by = ? WHERE orchestration_id = ? AND consumed_by IS NULL AND edge_id IN (${incomingTokens(
        p,
        nodeId,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(nodeId, p.o.id, ...incomingTokens(p, nodeId).map((t) => t.edgeId))
  return Number(result.changes)
}

export const defOf = (p: Pass, nodeId: string): WorkflowNode => p.g.nodes.get(nodeId)!

// ----------------------------------------------------------------------------------------------- failing the run

/** An unrouted failure: no further admissions, stop what runs, drain; the run ends `failed`. */
export function failRun(p: Pass, nodeId: string, reason: string): void {
  const { sqlite, now } = p.ctx
  sqlite
    .prepare(
      "UPDATE wf_runs SET graph_outcome = 'failed', graph_reason = ? WHERE orchestration_id = ?",
    )
    .run(reason, p.o.id)
  for (const n of p.nodes.values())
    if (n.node_id !== nodeId && ['waiting', 'ready', 'gate_open'].includes(n.state))
      setNode(sqlite, p.o.id, n.node_id, {
        state: 'cancelled',
        reason: 'the run failed',
        ended_at: now,
      })
  sqlite
    .prepare(
      "UPDATE wf_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND status = 'open'",
    )
    .run(now, p.o.id)
  stopRun(p.ctx, p.o.id, 'graph', reason)
  note(p, 'wf_failed', { nodeId, reason })
}

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')
