import type { BranchCondition } from '@score/contract'
import { createHash } from 'node:crypto'
import { addStored, utf8Bytes } from '../orchestration/ops.ts'
import {
  consumeIncoming,
  defOf,
  emit,
  incomingTokens,
  setState,
  type Pass,
} from './planner-context.ts'
import type { WfNodeRow } from './store.ts'

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

export function resolve(p: Pass): boolean {
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
export function agentAncestors(p: Pass, nodeId: string): string[] {
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

export function openNodeGate(p: Pass, node: WfNodeRow): void {
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
