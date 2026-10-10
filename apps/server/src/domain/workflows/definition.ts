import {
  WORKFLOW_LIMITS,
  maxStepsOf,
  type ValidationCode,
  type ValidationIssue,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@score/contract'
import { createHash } from 'node:crypto'

// Definition validation (contract §15 "Definitions"). One function serves the editor, save and start. Graph rules only:
// shape and size limits are the zod schema's job, but the limit codes are reported here too so a caller that skipped
// the schema (or a stored definition) gets the same answer.

const encoder = new TextEncoder()
export const bytesOf = (text: string): number => encoder.encode(text).length

export interface Graph {
  nodes: Map<string, WorkflowNode>
  out: Map<string, WorkflowEdge[]>
  inn: Map<string, WorkflowEdge[]>
}

export function graphOf(def: Pick<WorkflowDefinition, 'nodes' | 'edges'>): Graph {
  const nodes = new Map(def.nodes.map((n) => [n.id, n]))
  const out = new Map<string, WorkflowEdge[]>()
  const inn = new Map<string, WorkflowEdge[]>()
  for (const id of nodes.keys()) {
    out.set(id, [])
    inn.set(id, [])
  }
  for (const edge of def.edges) {
    out.get(edge.from)?.push(edge)
    inn.get(edge.to)?.push(edge)
  }
  return { nodes, out, inn }
}

/** Sorted-key JSON: the same definition always hashes the same. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, c]) => [k, sorted(c)]),
          )
        : v
  return JSON.stringify(sorted(value))
}
export const definitionHash = (def: WorkflowDefinition): string =>
  createHash('sha256').update(canonicalJson(def)).digest('hex')

// ------------------------------------------------------------------------------------------------------- templates

export type TemplateRef =
  | { kind: 'input'; name: string; fallback: string | null }
  | { kind: 'node'; id: string; field: 'output' | 'verdict'; fallback: string | null }
export type TemplatePart = string | TemplateRef

const REF =
  /\{\{\s*(inputs|nodes)\.([a-z][a-z0-9_-]*)(?:\.(output|verdict))?\s*(?:\|\s*default\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}\}/g

const unescapeDefault = (raw: string): string => raw.replace(/\\(.)/g, '$1')

/** Splits a template into text and references. `errors` lists `{{` sequences that are not a valid reference. */
export function parseTemplate(text: string): { parts: TemplatePart[]; errors: string[] } {
  const parts: TemplatePart[] = []
  const errors: string[] = []
  let last = 0
  for (const match of text.matchAll(REF)) {
    const index = match.index
    if (index > last) parts.push(text.slice(last, index))
    const [, scope, name, field, fallback] = match
    const def = fallback === undefined ? null : unescapeDefault(fallback)
    if (scope === 'inputs') {
      if (field !== undefined) errors.push(`{{inputs.${name}.${field}}} has no such field`)
      parts.push({ kind: 'input', name: name!, fallback: def })
    } else {
      parts.push({
        kind: 'node',
        id: name!,
        field: (field as 'output' | 'verdict') ?? 'output',
        fallback: def,
      })
    }
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  // Anything left that still looks like a reference is a syntax error (no expressions, no unknown forms).
  for (const part of parts)
    if (typeof part === 'string' && /\{\{|\}\}/.test(part))
      errors.push(`"${part.match(/\{\{[^}]{0,40}|\}\}/)?.[0] ?? '{{'}" is not a valid reference`)
  return { parts, errors }
}

// ------------------------------------------------------------------------------------------------------ validation

const ports = (node: WorkflowNode): string[] => {
  switch (node.kind) {
    case 'agent':
      return ['ok', 'failed']
    case 'gate':
      return ['ok', 'rejected']
    case 'branch':
      return [...node.rules.map((r) => r.id), 'default']
    case 'join':
      return ['ok']
    case 'end':
      return []
  }
}
export const portsOf = ports

function reachable(start: Iterable<string>, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...start]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...next(id))
  }
  return seen
}

export function validateDefinition(def: WorkflowDefinition): ValidationResult {
  const issues: ValidationIssue[] = []
  const add = (
    code: ValidationCode,
    message: string,
    where: { nodeId?: string; edgeId?: string; field?: string } = {},
  ): void => {
    issues.push({
      code,
      severity: 'error',
      nodeId: where.nodeId ?? null,
      edgeId: where.edgeId ?? null,
      field: where.field ?? null,
      message: message.slice(0, 500),
    })
  }
  const bytes = bytesOf(JSON.stringify(def))
  if (def.nodes.length > WORKFLOW_LIMITS.maxNodes)
    add('too_many_nodes', `A workflow has at most ${WORKFLOW_LIMITS.maxNodes} nodes`)
  if (def.edges.length > WORKFLOW_LIMITS.maxEdges)
    add('too_many_edges', `A workflow has at most ${WORKFLOW_LIMITS.maxEdges} edges`)
  if (bytes > WORKFLOW_LIMITS.definitionBytes)
    add('definition_too_large', 'A workflow definition is limited to 256 KiB')
  const steps = maxStepsOf(def)
  if (steps > WORKFLOW_LIMITS.maxSteps)
    add(
      'steps_over_limit',
      `The agent nodes can need ${steps} steps with their retries; the limit is ${WORKFLOW_LIMITS.maxSteps}`,
    )

  // identities
  const seenNodes = new Set<string>()
  for (const node of def.nodes) {
    if (seenNodes.has(node.id))
      add('duplicate_node_id', `Node id ${node.id} is used twice`, { nodeId: node.id })
    seenNodes.add(node.id)
  }
  const seenInputs = new Set<string>()
  for (const input of def.inputs) {
    if (seenInputs.has(input.name)) add('duplicate_input', `Input ${input.name} is declared twice`)
    seenInputs.add(input.name)
  }
  const g = graphOf(def)
  const seenEdgeIds = new Set<string>()
  const seenEdges = new Set<string>()
  const validEdges: WorkflowEdge[] = []
  for (const edge of def.edges) {
    if (seenEdgeIds.has(edge.id))
      add('duplicate_edge_id', `Edge id ${edge.id} is used twice`, { edgeId: edge.id })
    seenEdgeIds.add(edge.id)
    const key = `${edge.from}\0${edge.port}\0${edge.to}`
    if (seenEdges.has(key))
      add('duplicate_edge', `The edge ${edge.from}.${edge.port} → ${edge.to} appears twice`, {
        edgeId: edge.id,
      })
    seenEdges.add(key)
    const from = g.nodes.get(edge.from)
    const to = g.nodes.get(edge.to)
    if (!from || !to) {
      add(
        'unknown_node',
        `Edge ${edge.id} names ${!from ? edge.from : edge.to}, which is not a node`,
        { edgeId: edge.id },
      )
      continue
    }
    if (from.kind === 'end')
      add('end_has_outgoing', `${from.id} is an end and cannot have outgoing edges`, {
        nodeId: from.id,
        edgeId: edge.id,
      })
    else if (!ports(from).includes(edge.port))
      add('bad_port', `${from.kind} ${from.id} has no port ${edge.port}`, {
        nodeId: from.id,
        edgeId: edge.id,
      })
    validEdges.push(edge)
  }
  const idx = graphOf({ nodes: def.nodes, edges: validEdges })

  // roots, cycles, reachability, ends
  const roots = def.nodes.filter((n) => (idx.inn.get(n.id) ?? []).length === 0)
  if (roots.length === 0 && def.nodes.length > 0)
    add('no_root', 'Every node has an incoming edge; the workflow has no start')
  for (const root of roots)
    if (root.kind !== 'agent' && root.kind !== 'gate')
      add(
        'bad_root_kind',
        `${root.kind} ${root.id} has no incoming edge; a start must be an agent or a gate`,
        { nodeId: root.id },
      )
  const indegree = new Map(def.nodes.map((n) => [n.id, (idx.inn.get(n.id) ?? []).length]))
  const queue = def.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const edge of idx.out.get(id) ?? []) {
      const left = indegree.get(edge.to)! - 1
      indegree.set(edge.to, left)
      if (left === 0) queue.push(edge.to)
    }
  }
  const acyclic = order.length === new Set(def.nodes.map((n) => n.id)).size
  if (!acyclic)
    add(
      'cycle',
      `The graph has a cycle through ${def.nodes
        .filter((n) => !order.includes(n.id))
        .map((n) => n.id)
        .slice(0, 5)
        .join(', ')}`,
    )
  const fromRoots = reachable(
    roots.map((n) => n.id),
    (id) => (idx.out.get(id) ?? []).map((e) => e.to),
  )
  for (const node of def.nodes)
    if (!fromRoots.has(node.id))
      add('unreachable_node', `${node.id} cannot be reached from a start`, { nodeId: node.id })
  if (!def.nodes.some((n) => n.kind === 'end')) add('no_end', 'The workflow has no end node')

  // per-node routing
  for (const node of def.nodes) {
    const outs = idx.out.get(node.id) ?? []
    const has = (port: string) => outs.some((e) => e.port === port)
    if (node.kind === 'agent') {
      if (!has('ok'))
        add('port_unconnected', `${node.id}: the ok port leads nowhere`, { nodeId: node.id })
      if (node.onFailure === 'route' && !has('failed'))
        add(
          'unrouted_failure',
          `${node.id} fails without a failed edge; add one or choose "fail the run"`,
          { nodeId: node.id },
        )
      if (node.onFailure === 'fail_run' && has('failed'))
        add(
          'failure_edge_with_fail_run',
          `${node.id} has a failed edge but is set to fail the run`,
          { nodeId: node.id },
        )
    } else if (node.kind === 'gate') {
      if (!has('ok'))
        add('port_unconnected', `${node.id}: the approved port leads nowhere`, { nodeId: node.id })
      if (node.onReject === 'route' && !has('rejected'))
        add(
          'unrouted_rejection',
          `${node.id} has no rejected edge; add one or choose "stop the run"`,
          { nodeId: node.id },
        )
      if (node.onReject === 'stop_run' && has('rejected'))
        add(
          'failure_edge_with_fail_run',
          `${node.id} has a rejected edge but is set to stop the run`,
          { nodeId: node.id },
        )
    } else if (node.kind === 'branch') {
      const ruleIds = new Set<string>()
      for (const rule of node.rules) {
        if (rule.id === 'default' || ruleIds.has(rule.id))
          add('branch_duplicate_rule', `${node.id}: rule id ${rule.id} is reserved or repeated`, {
            nodeId: node.id,
            field: `rules[${rule.id}]`,
          })
        ruleIds.add(rule.id)
        if (!has(rule.id))
          add('port_unconnected', `${node.id}: rule ${rule.id} leads nowhere`, { nodeId: node.id })
      }
      if (!has('default'))
        add('branch_no_default', `${node.id} needs a default edge`, { nodeId: node.id })
      const subject = g.nodes.get(node.subject)
      const ancestors = reachable([node.subject], (id) => (idx.out.get(id) ?? []).map((e) => e.to))
      if (
        !subject ||
        subject.kind !== 'agent' ||
        !ancestors.has(node.id) ||
        node.subject === node.id
      )
        add(
          'branch_subject_invalid',
          `${node.id}: the subject must be an agent node that comes before it`,
          { nodeId: node.id, field: 'subject' },
        )
      else
        for (const rule of node.rules)
          if (
            rule.when.kind === 'outcome' &&
            rule.when.is === 'failed' &&
            subject.kind === 'agent' &&
            subject.onFailure === 'fail_run'
          )
            add(
              'branch_condition_unusable',
              `${node.id}: ${subject.id} fails the run when it fails, so this rule can never match`,
              { nodeId: node.id, field: `rules[${rule.id}]` },
            )
    } else if (node.kind === 'join') {
      if ((idx.inn.get(node.id) ?? []).length < 2)
        add('join_needs_inputs', `${node.id} joins fewer than two inputs`, { nodeId: node.id })
      if (!has('ok'))
        add('port_unconnected', `${node.id}: the join leads nowhere`, { nodeId: node.id })
    }
  }

  // templates
  const inputNames = new Set(def.inputs.map((i) => i.name))
  const ancestorsOf = (id: string): Set<string> => {
    const set = reachable([id], (n) => (idx.inn.get(n) ?? []).map((e) => e.from))
    set.delete(id)
    return set
  }
  /** Whether every path from a start to `target` passes `through` (so its result is always there). */
  const dominates = (through: string, target: string): boolean => {
    const starts = roots.map((r) => r.id).filter((r) => r !== through)
    const seen = reachable(starts, (id) =>
      id === through ? [] : (idx.out.get(id) ?? []).map((e) => e.to),
    )
    return !seen.has(target)
  }
  for (const node of def.nodes) {
    if (node.kind !== 'agent') continue
    const { parts, errors } = parseTemplate(node.instruction)
    for (const message of errors)
      add('template_syntax', `${node.id}: ${message}`, { nodeId: node.id, field: 'instruction' })
    const ancestors = acyclic ? ancestorsOf(node.id) : new Set<string>()
    const descendants = reachable([node.id], (id) => (idx.out.get(id) ?? []).map((e) => e.to))
    for (const part of parts) {
      if (typeof part === 'string') continue
      if (part.kind === 'input') {
        if (!inputNames.has(part.name))
          add(
            'template_unknown_input',
            `${node.id} uses {{inputs.${part.name}}}, which is not declared`,
            { nodeId: node.id, field: 'instruction' },
          )
        continue
      }
      const target = g.nodes.get(part.id)
      if (!target)
        add('template_unknown_node', `${node.id} uses {{nodes.${part.id}}}, which is not a node`, {
          nodeId: node.id,
          field: 'instruction',
        })
      else if (part.id === node.id)
        add('template_self_reference', `${node.id} refers to itself`, {
          nodeId: node.id,
          field: 'instruction',
        })
      else if (descendants.has(part.id))
        add('template_forward_reference', `${node.id} refers to ${part.id}, which comes after it`, {
          nodeId: node.id,
          field: 'instruction',
        })
      else if (!ancestors.has(part.id))
        add(
          'template_not_ancestor',
          `${node.id} refers to ${part.id}, which is not on a path to it`,
          { nodeId: node.id, field: 'instruction' },
        )
      else if (target.kind !== 'agent')
        add(
          'template_field_unavailable',
          `${part.id} is a ${target.kind}; only agent nodes have a ${part.field}`,
          { nodeId: node.id, field: 'instruction' },
        )
      else if (part.field === 'output' && part.fallback === null && !dominates(part.id, node.id))
        add(
          'template_needs_default',
          `${node.id} uses {{nodes.${part.id}.output}}, but ${part.id} may be skipped; add |default:"…"`,
          { nodeId: node.id, field: 'instruction' },
        )
    }
  }
  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    stats: { nodes: def.nodes.length, edges: def.edges.length, maxSteps: steps, bytes },
  }
}
