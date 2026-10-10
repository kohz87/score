import {
  WORKFLOW_LIMITS,
  type BranchCondition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@score/contract'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { agentAdmits, lifecycleOf } from '../agent-lifecycle.ts'
import { budgetView, canReserve } from '../orchestration/budget.ts'
import { touch, type Ctx } from '../orchestration/ctx.ts'
import { stopRun } from '../orchestration/decisions.ts'
import {
  addStored,
  admissionRevision,
  beginFinish,
  setStepStatus,
  storageRoom,
  utf8Bytes,
} from '../orchestration/ops.ts'
import {
  addHistory,
  attemptsOf,
  frozenIncarnation,
  readOrch,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from '../orchestration/store.ts'
import { graphOf, type Graph } from './definition.ts'
import { renderAgentPayload } from './payload.ts'
import {
  commandsOf,
  nodesOf,
  readResult,
  requireWfRun,
  setNode,
  tokensOf,
  wfGatesOf,
  wfStepsOf,
  type WfNodeRow,
  type WfRunRow,
  type WfStepRow,
  type WfTokenRow,
} from './store.ts'
import { resultFacts } from './verdict.ts'

// The graph planner (design v8 "Planner principal and command identity"). A pure-looking pass over durable state: it
// reads node states, tokens and the executor's steps, and its only effects are rows in the same transaction as the event
// that woke it (a step result, a decision, a limits change, the periodic sweep). A crash before or after a pass
// re-derives the same commands; `wf_commands` makes a stored identity return its receipt.

const START = '__start'
export const startEdge = (nodeId: string): string => `start:${nodeId}`
const FINAL = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])
export const isFinalNode = (state: string): boolean => FINAL.has(state)

interface Pass {
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

function load(ctx: Ctx, o: OrchRow): Pass {
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

function setState(
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
function emit(
  p: Pass,
  nodeId: string,
  chosen: readonly string[],
  kind: WfTokenRow['kind'],
  attempt = 0,
): void {
  for (const edge of p.g.out.get(nodeId) ?? [])
    insertToken(p, edge.id, chosen.includes(edge.port) ? kind : 'skip', nodeId, attempt)
}

function incomingTokens(
  p: Pass,
  nodeId: string,
): { edgeId: string; token: WfTokenRow | undefined }[] {
  const inc = p.g.inn.get(nodeId) ?? []
  const edgeIds = inc.length === 0 ? [startEdge(nodeId)] : inc.map((e) => e.id)
  return edgeIds.map((edgeId) => ({ edgeId, token: p.tokens.get(edgeId) }))
}

function consumeIncoming(p: Pass, nodeId: string): number {
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

const defOf = (p: Pass, nodeId: string): WorkflowNode => p.g.nodes.get(nodeId)!

// ----------------------------------------------------------------------------------------------- failing the run

/** An unrouted failure: no further admissions, stop what runs, drain; the run ends `failed`. */
function failRun(p: Pass, nodeId: string, reason: string): void {
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

// -------------------------------------------------------------------------------------------- observing the steps

/** The last executor step the node has, if any. */
function currentStep(p: Pass, nodeId: string): StepRow | undefined {
  const rows = p.lineage.filter((l) => l.node_id === nodeId)
  const last = rows.at(-1)
  return last ? p.steps.get(last.step_id) : undefined
}
const lastAttemptOf = (p: Pass, stepId: string): AttemptRow | undefined =>
  p.attempts
    .filter((a) => a.step_id === stepId)
    .reduce<AttemptRow | undefined>((b, a) => (!b || a.n > b.n ? a : b), undefined)

function onAgentSuccess(p: Pass, node: WfNodeRow, step: StepRow): void {
  const attempt = lastAttemptOf(p, step.id)
  const stored = attempt ? readResult(p.ctx.sqlite, attempt.id) : undefined
  let output = stored?.output ?? step.result ?? ''
  let truncated = stored?.truncated ?? false
  let verdict = stored?.verdict ?? null
  if (!stored) {
    // No complete-reply facts: parse only a reply that the 8 KiB run record cannot have cut.
    const complete = utf8Bytes(step.result ?? '') < 8000
    const facts = resultFacts(step.result ?? '')
    output = facts.output
    truncated = !complete
    verdict = complete && facts.verdict ? JSON.stringify(facts.verdict) : null
  }
  setState(p, node.node_id, 'succeeded', {
    output,
    output_truncated: truncated ? 1 : 0,
    output_revision: step.result_revision,
    verdict,
    reason: null,
  })
  emit(p, node.node_id, ['ok'], 'ok', node.attempts_used)
}

function onAgentFailure(p: Pass, node: WfNodeRow, reason: string, retryable: boolean): void {
  const def = defOf(p, node.node_id)
  if (retryable && node.attempts_used < node.attempts_max) {
    setState(p, node.node_id, 'ready', {
      reason: `attempt ${node.attempts_used} failed: ${reason}; retrying`,
      step_id: null,
    })
    return
  }
  setState(p, node.node_id, 'failed', { reason, output: null })
  if (def.kind === 'agent' && def.onFailure === 'route')
    emit(p, node.node_id, ['failed'], 'failed', node.attempts_used)
  else failRun(p, node.node_id, `${node.node_id} failed: ${reason}`)
}

function observe(p: Pass): boolean {
  let changed = false
  for (const node of p.nodes.values()) {
    if (node.kind !== 'agent') continue
    // A node that already resolved is checked against its step too: a withdrawn result is no longer a success.
    if (node.state === 'succeeded') {
      const step = currentStep(p, node.node_id)
      if (step && step.status !== 'succeeded' && ['unknown', 'failed'].includes(step.status)) {
        setState(p, node.node_id, 'unresolved', {
          reason: 'its result was withdrawn: not confirmed ended',
        })
        changed = true
      }
      continue
    }
    if (!['running', 'gate_open', 'ready'].includes(node.state) || node.step_id === null) continue
    const step = p.steps.get(node.step_id)
    if (!step) continue
    switch (step.status) {
      case 'pending_gate':
        if (node.state !== 'gate_open') {
          setState(p, node.node_id, 'gate_open', { reason: 'waiting for your approval' })
          changed = true
        }
        break
      case 'queued':
      case 'admitted':
      case 'unknown':
        if (node.state !== 'running') {
          setState(p, node.node_id, 'running', { reason: null })
          changed = true
        }
        break
      case 'succeeded':
        onAgentSuccess(p, node, step)
        changed = true
        break
      case 'failed': {
        const attempt = lastAttemptOf(p, step.id)
        if (attempt?.state === 'abandoned') {
          // Administrative: never a failed token. The person retries or stops.
          setState(p, node.node_id, 'unresolved', {
            reason: 'abandoned: not confirmed ended',
            step_id: step.id,
          })
        } else onAgentFailure(p, node, step.disposition ?? 'the step failed', true)
        changed = true
        break
      }
      case 'rejected':
        onAgentFailure(p, node, 'the assignment was rejected', false)
        changed = true
        break
      case 'blocked': {
        const why = step.disposition ?? ''
        if (/^input_withdrawn/.test(why)) setState(p, node.node_id, 'unresolved', { reason: why })
        else if (/^capability_in_input/.test(why)) onAgentFailure(p, node, why, false)
        else
          // agent_changed / agent_unavailable: the node waits for the person's remap; no logical attempt is used.
          setState(p, node.node_id, 'ready', { reason: why, step_id: null })
        changed = true
        break
      }
      case 'not_started':
      case 'cancelled':
        // A remapped step is re-created; one retired by Stop / Finish stays as it is.
        if (/remapped/.test(step.disposition ?? '') && p.canIssue) {
          setState(p, node.node_id, 'ready', { reason: 'remapped', step_id: null })
          changed = true
        }
        break
    }
  }
  return changed
}

// ------------------------------------------------------------------------------------------- resolving local nodes

function matches(rule: BranchCondition, subject: WfNodeRow | undefined): boolean {
  if (!subject) return false
  switch (rule.kind) {
    case 'verdict':
      return subject.verdict?.verdict === rule.is
    case 'outcome':
      return rule.is === 'succeeded' ? subject.state === 'succeeded' : subject.state === 'failed'
    case 'output_contains':
      return (subject.output ?? '').toLowerCase().includes(rule.text.toLowerCase())
  }
}

function resolve(p: Pass): boolean {
  let changed = false
  for (const node of p.nodes.values()) {
    // An end that was reached keeps consuming the tokens that arrive after it (they are produced, so consumed).
    if (node.state === 'succeeded' && node.kind === 'end' && consumeIncoming(p, node.node_id) > 0) {
      changed = true
      continue
    }
    if (node.state !== 'waiting') continue
    const def = defOf(p, node.node_id)
    const inputs = incomingTokens(p, node.node_id)
    if (def.kind === 'end') {
      // An end records tokens as they arrive; it is reached by the first real one.
      const arrived = inputs.filter((i) => i.token && i.token.kind !== 'skip')
      if (arrived.length > 0) {
        consumeIncoming(p, node.node_id)
        setState(p, node.node_id, 'succeeded', { reason: null })
        changed = true
      } else if (inputs.every((i) => i.token)) {
        consumeIncoming(p, node.node_id)
        setState(p, node.node_id, 'skipped', { reason: 'no path led here' })
        changed = true
      }
      continue
    }
    if (!inputs.every((i) => i.token)) continue
    consumeIncoming(p, node.node_id)
    changed = true
    if (inputs.every((i) => i.token!.kind === 'skip')) {
      setState(p, node.node_id, 'skipped', { reason: 'no path led here' })
      emit(p, node.node_id, [], 'skip')
      continue
    }
    switch (def.kind) {
      case 'agent':
      case 'gate':
        setState(p, node.node_id, 'ready', { reason: null, started_at: p.ctx.now })
        break
      case 'join':
        setState(p, node.node_id, 'succeeded', { reason: null })
        emit(p, node.node_id, ['ok'], 'ok')
        break
      case 'branch': {
        const subject = p.nodes.get(def.subject)
        const rule = def.rules.find((r) => matches(r.when, subject))
        setState(p, node.node_id, 'succeeded', { reason: rule ? `matched ${rule.id}` : 'default' })
        emit(p, node.node_id, [rule?.id ?? 'default'], 'branch')
        break
      }
      default:
        break
    }
  }
  return changed
}

// ----------------------------------------------------------------------------------------------------- node gates

/** Nearest agent producers feeding a node, through local nodes. */
function agentAncestors(p: Pass, nodeId: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const walk = (id: string): void => {
    for (const edge of p.g.inn.get(id) ?? []) {
      const token = p.tokens.get(edge.id)
      if (!token || token.kind === 'skip' || seen.has(edge.from)) continue
      seen.add(edge.from)
      if (defOf(p, edge.from).kind === 'agent') found.push(edge.from)
      else walk(edge.from)
    }
  }
  walk(nodeId)
  return found
}

function openNodeGate(p: Pass, node: WfNodeRow): void {
  const { sqlite, now } = p.ctx
  const def = defOf(p, node.node_id)
  if (def.kind !== 'gate') return
  const consumed = agentAncestors(p, node.node_id).flatMap((id) => {
    const producer = p.nodes.get(id)!
    if (producer.output === null) return []
    const cut = Buffer.byteLength(producer.output) > 4096
    return [
      {
        nodeId: id,
        outputRevision: producer.output_revision,
        output: cut ? producer.output.slice(0, 4000) : producer.output,
        truncated: cut || producer.output_truncated,
      },
    ]
  })
  const fresh = p.nodes.get(node.node_id)!
  const payload = {
    question: def.question,
    consumed,
    nodeRevision: fresh.revision + 1,
    runRevision: p.o.revision,
  }
  const text = JSON.stringify(payload)
  const gateId = `ng${(sqlite.prepare('SELECT COUNT(*) AS n FROM wf_gates WHERE orchestration_id = ?').get(p.o.id) as { n: number }).n + 1}`
  sqlite
    .prepare(
      `INSERT INTO wf_gates (orchestration_id, id, node_id, payload, payload_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(p.o.id, gateId, node.node_id, text, createHash('sha256').update(text).digest('hex'), now)
  addStored(sqlite, p.o.id, utf8Bytes(text) + 256)
  setState(p, node.node_id, 'gate_open', { gate_id: gateId, reason: 'waiting for your decision' })
}

// ---------------------------------------------------------------------------------------------------- assignments

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex')

export type NodeWait = 'budget' | 'unknown_spend' | 'remap' | 'agent_unavailable' | null

/** Conditions that can still change; they never produce a stored refusal. */
export function assignWait(
  sqlite: DatabaseSync,
  o: OrchRow,
  wf: WfRunRow,
  agentId: string,
): NodeWait {
  const frozen = frozenIncarnation(sqlite, o.id, agentId)
  const current = lifecycleOf(sqlite, agentId)?.incarnation_id ?? 'untracked'
  if (frozen !== undefined && frozen !== current) return 'remap'
  if (!agentAdmits(sqlite, agentId)) return 'agent_unavailable'
  const view = budgetView(sqlite, o)
  if (
    o.budget_usd !== null &&
    view.unknownSpend &&
    !o.accepted_unknown_spend &&
    wf.unknown_spend === 'pause'
  )
    return 'unknown_spend'
  return null
}

function pendingKind(
  p: Pass,
  node: WfNodeRow,
): { attempt: number; reason: 'initial' | 'retry' | 'remap' } {
  if (node.attempts_used === 0) return { attempt: 1, reason: 'initial' }
  const last = currentStep(p, node.node_id)
  if (last && (last.status === 'blocked' || last.status === 'not_started'))
    return { attempt: node.attempts_used, reason: 'remap' }
  return { attempt: node.attempts_used + 1, reason: 'retry' }
}

function permanentRefusal(
  p: Pass,
  node: WfNodeRow,
  attempt: number,
  code: string,
  message: string,
): void {
  const { sqlite, now } = p.ctx
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO wf_commands (orchestration_id, node_id, attempt, verb, generation, payload_hash, receipt, outcome, created_at)
       VALUES (?, ?, ?, 'assign', ?, ?, ?, 'refused', ?)`,
    )
    .run(
      p.o.id,
      node.node_id,
      attempt,
      p.wf.planner_generation,
      hashOf(`${node.node_id}:${code}`),
      JSON.stringify({ status: 'refused', code, message }),
      now,
    )
  onAgentFailure(p, node, `${code}: ${message}`, false)
}

function assign(p: Pass, node: WfNodeRow): boolean {
  const { sqlite, now } = p.ctx
  // Several nodes can be assigned in one pass: the step counter is read fresh each time.
  p.o = readOrch(sqlite, p.o.id) ?? p.o
  const def = defOf(p, node.node_id)
  if (def.kind !== 'agent') return false
  const { attempt, reason } = pendingKind(p, node)
  const generation = p.wf.planner_generation
  const stored = sqlite
    .prepare(
      "SELECT outcome FROM wf_commands WHERE orchestration_id = ? AND node_id = ? AND attempt = ? AND verb = 'assign' AND generation = ?",
    )
    .get(p.o.id, node.node_id, attempt, generation) as { outcome: string } | undefined
  if (stored) return false
  const wait = assignWait(sqlite, p.o, p.wf, def.agentId)
  if (wait) {
    if (node.reason !== wait && wait === 'remap')
      setNode(sqlite, p.o.id, node.node_id, { reason: 'remap' })
    return false
  }
  if (p.o.steps_created >= p.o.max_steps)
    return (
      permanentRefusal(
        p,
        node,
        attempt,
        'step_limit',
        `The run is limited to ${p.o.max_steps} steps`,
      ),
      true
    )
  const rendered = renderAgentPayload({
    runId: p.o.id,
    nodeId: node.node_id,
    def: p.wf.definition,
    inputs: p.wf.inputs,
    nodes: p.nodes,
  })
  if (!rendered.ok)
    return (permanentRefusal(p, node, attempt, rendered.code, rendered.message), true)
  const estimate = def.estimateUsd ?? p.o.step_estimate_usd
  const view = budgetView(sqlite, p.o)
  if (!canReserve(view, estimate)) return false
  const everyStep = p.wf.gate_policy === 'every-step' && reason !== 'remap'
  const payloadHash = hashOf(rendered.text)
  const bytes = utf8Bytes(rendered.text) * (everyStep ? 2 : 1) + 512
  if (bytes > storageRoom(p.o))
    return (
      permanentRefusal(p, node, attempt, 'quota', "This run's storage allowance is used up"),
      true
    )

  const seq = p.o.steps_created + 1
  const stepId = `s${seq}`
  const life = lifecycleOf(sqlite, def.agentId)
  const incarnation = life?.incarnation_id ?? 'untracked'
  const previous = currentStep(p, node.node_id)
  sqlite
    .prepare(
      `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, after_steps, replaces, status, estimate_usd, payload_hash, created_in_attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.o.id,
      stepId,
      seq,
      def.agentId,
      incarnation,
      rendered.text,
      previous?.id ?? null,
      everyStep ? 'pending_gate' : 'queued',
      estimate,
      payloadHash,
      START,
      now,
      now,
    )
  sqlite
    .prepare('UPDATE orchestrations SET steps_created = steps_created + 1 WHERE id = ?')
    .run(p.o.id)
  let gateId: string | null = null
  if (everyStep) {
    gateId = `g${(sqlite.prepare('SELECT COUNT(*) AS n FROM orc_gates WHERE orchestration_id = ?').get(p.o.id) as { n: number }).n + 1}`
    const payload = {
      agentId: def.agentId,
      agentIncarnation: incarnation,
      instruction: rendered.text,
      after: [] as string[],
      replaces: previous?.id ?? null,
      estimateUsd: estimate,
      dependencyRevisions: {} as Record<string, number>,
    }
    const text = JSON.stringify(payload)
    sqlite
      .prepare(
        `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at) VALUES (?, ?, ?, 'policy', ?, ?, 'open', ?)`,
      )
      .run(p.o.id, gateId, stepId, text, hashOf(text), now)
  }
  sqlite
    .prepare(
      'INSERT INTO wf_steps (orchestration_id, step_id, node_id, attempt, reason) VALUES (?, ?, ?, ?, ?)',
    )
    .run(p.o.id, stepId, node.node_id, attempt, reason)
  const insertConsumed = sqlite.prepare(
    `INSERT OR REPLACE INTO wf_consumed (orchestration_id, step_id, consumer, consumer_attempt, producer, producer_attempt, producer_step, output_revision, kind, withdrawn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  for (const c of rendered.consumed)
    insertConsumed.run(
      p.o.id,
      stepId,
      node.node_id,
      attempt,
      c.producer,
      c.attempt,
      p.nodes.get(c.producer)?.step_id ?? '',
      c.revision,
      c.kind,
    )
  sqlite
    .prepare(
      `INSERT INTO wf_commands (orchestration_id, node_id, attempt, verb, generation, payload_hash, receipt, outcome, created_at)
       VALUES (?, ?, ?, 'assign', ?, ?, ?, 'ok', ?)`,
    )
    .run(
      p.o.id,
      node.node_id,
      attempt,
      generation,
      payloadHash,
      JSON.stringify({ status: 'ok', stepId }),
      now,
    )
  addStored(sqlite, p.o.id, bytes)
  setState(p, node.node_id, everyStep ? 'gate_open' : 'running', {
    step_id: stepId,
    attempts_used: reason === 'remap' ? node.attempts_used : attempt,
    gate_id: gateId,
    reason: everyStep ? 'waiting for your approval' : null,
    started_at: node.started_at ?? now,
  })
  return true
}

// -------------------------------------------------------------------------------------------------- terminal graph

function maybeFinish(p: Pass): boolean {
  const { sqlite, now } = p.ctx
  if (!p.canIssue) return false
  const nodes = [...p.nodes.values()]
  if (!nodes.every((n) => isFinalNode(n.state))) return false
  if (
    [...p.steps.values()].some((s) =>
      ['pending_gate', 'queued', 'admitted', 'unknown'].includes(s.status),
    )
  )
    return false
  if (p.attempts.some((a) => ['created', 'send_started', 'running'].includes(a.state))) return false
  if (wfGatesOf(sqlite, p.o.id).some((g) => g.status === 'open')) return false
  if ([...p.tokens.values()].some((t) => t.consumed_by === null)) return false
  const generation = p.wf.planner_generation
  const hasReceipt = commandsOf(sqlite, p.o.id).some((c) => c.verb === 'finish')
  const reachedEnd = nodes.some((n) => n.kind === 'end' && n.state === 'succeeded')
  const failed = !reachedEnd
  if (!hasReceipt)
    sqlite
      .prepare(
        `INSERT INTO wf_commands (orchestration_id, node_id, attempt, verb, generation, payload_hash, receipt, outcome, created_at)
         VALUES (?, '__run', 0, 'finish', ?, ?, ?, 'ok', ?)`,
      )
      .run(
        p.o.id,
        generation,
        hashOf(failed ? 'failed' : 'success'),
        JSON.stringify({ status: 'ok' }),
        now,
      )
  sqlite
    .prepare('UPDATE wf_runs SET graph_outcome = ?, graph_reason = ? WHERE orchestration_id = ?')
    .run(failed ? 'failed' : 'reached_end', failed ? 'no end was reached' : null, p.o.id)
  beginFinish(
    p.ctx,
    p.o,
    null,
    failed ? 'failed' : 'success',
    failed ? 'The graph ended without reaching an end.' : 'The graph reached its end.',
  )
  return true
}

// ----------------------------------------------------------------------------------------------------- entry point

/**
 * One planning pass for a workflow run. Idempotent: running it again on unchanged state does nothing. Returns whether
 * anything changed.
 */
export function planWorkflow(ctx: Ctx, o: OrchRow): boolean {
  const { sqlite } = ctx
  let any = false
  // v8.1 item 2: a run whose admission revision is behind re-evaluates its waiting work with a new generation.
  const revision = admissionRevision(sqlite)
  if (o.admission_seen < revision) {
    const waiting = nodesOf(sqlite, o.id).some((n) => n.state === 'ready')
    if (waiting)
      sqlite
        .prepare(
          'UPDATE wf_runs SET planner_generation = planner_generation + 1 WHERE orchestration_id = ?',
        )
        .run(o.id)
    sqlite.prepare('UPDATE orchestrations SET admission_seen = ? WHERE id = ?').run(revision, o.id)
    any = true
  }
  for (let round = 0; round < 80; round++) {
    const current = readOrch(sqlite, o.id)
    if (!current) return any
    const p = load(ctx, current)
    if (
      current.status === 'stopping' ||
      current.status === 'finishing' ||
      ['succeeded', 'failed', 'stopped', 'finished_with_unresolved'].includes(current.status)
    ) {
      // Nothing new is issued; observed results are still recorded.
      if (!observe(p)) break
      any = true
      continue
    }
    let progressed = observe(p)
    progressed = resolve(p) || progressed
    if (p.canIssue) {
      for (const node of p.nodes.values()) {
        if (node.state !== 'ready') continue
        const def = defOf(p, node.node_id)
        if (def.kind === 'gate') {
          openNodeGate(p, node)
          progressed = true
        } else if (def.kind === 'agent') progressed = assign(p, node) || progressed
      }
      if (!progressed) progressed = maybeFinish(p)
    }
    if (!progressed) break
    any = true
  }
  return any
}

/** At the run's end: the graph's own outcome and any node that never resolved. */
export function finalizeGraph(ctx: Ctx, orchId: string, status: string): void {
  const { sqlite, now } = ctx
  const wf = requireWfRun(sqlite, orchId)
  if (wf.graph_outcome === null)
    sqlite
      .prepare('UPDATE wf_runs SET graph_outcome = ? WHERE orchestration_id = ?')
      .run(status === 'stopped' ? 'stopped' : 'failed', orchId)
  for (const node of nodesOf(sqlite, orchId))
    if (!isFinalNode(node.state) && node.state !== 'unresolved')
      setNode(sqlite, orchId, node.node_id, {
        state: 'cancelled',
        reason: 'the run ended',
        ended_at: now,
      })
  sqlite
    .prepare(
      "UPDATE wf_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND status = 'open'",
    )
    .run(now, orchId)
}

export type { WorkflowEdge }
export { setStepStatus, WORKFLOW_LIMITS }
