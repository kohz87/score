import { describe, expect, test } from 'vitest'
import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  WORKFLOW_LAYOUT_LIMIT,
  WORKFLOW_LIMITS,
  WorkflowDefinitionSchema,
  GateDecisionSchema,
  WorkflowNeedsYouSchema,
  WorkflowRemapDecisionSchema,
  WorkflowRetryDecisionSchema,
  WorkflowRunCreateSchema,
  WorkflowRunDetailSchema,
  WorkflowRunSummarySchema,
  WorkflowTryAgainDecisionSchema,
  WorkflowVersionCreateSchema,
  ValidationResultSchema,
  maxStepsOf,
  plannerCommandId,
} from '../src/index.ts'
import * as f from './fixtures.ts'

const definition = {
  name: 'Release notes',
  inputs: [{ name: 'topic', label: 'Topic', required: true, maxChars: 200 }],
  nodes: [
    {
      id: 'draft',
      kind: 'agent',
      label: 'Draft',
      agentId: 'builder',
      instruction: 'Write about {{inputs.topic}}',
      retries: 1,
      onFailure: 'fail_run',
    },
    { id: 'approve', kind: 'gate', label: 'Approve', question: 'Ship it?', onReject: 'stop_run' },
    { id: 'done', kind: 'end', label: 'Done' },
  ],
  edges: [
    { id: 'e1', from: 'draft', port: 'ok', to: 'approve' },
    { id: 'e2', from: 'approve', port: 'ok', to: 'done' },
  ],
}

const runCreate = {
  workflowId: 'wf-1',
  version: 1,
  inputs: { topic: 'v2' },
  agentMap: [{ agentId: 'builder', incarnation: 'inc-1' }],
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
}

describe('workflow definitions', () => {
  test('parse and count the true maximum steps', () => {
    const parsed = WorkflowDefinitionSchema.parse(definition)
    expect(maxStepsOf(parsed)).toBe(2)
  })

  test('bounds nodes, retries, ids and unknown keys', () => {
    const agent = definition.nodes[0]!
    expect(() => WorkflowDefinitionSchema.parse({ ...definition, extra: 1 })).toThrow()
    expect(() =>
      WorkflowDefinitionSchema.parse({ ...definition, nodes: [{ ...agent, retries: 3 }] }),
    ).toThrow()
    expect(() =>
      WorkflowDefinitionSchema.parse({ ...definition, nodes: [{ ...agent, id: 'Bad Id' }] }),
    ).toThrow()
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...definition,
        nodes: Array.from({ length: WORKFLOW_LIMITS.maxNodes + 1 }, (_, i) => ({
          id: `n${i}`,
          kind: 'end',
          label: 'End',
        })),
      }),
    ).toThrow()
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...definition,
        nodes: [{ ...agent, onFailure: undefined }],
      }),
    ).toThrow()
  })

  test('instructions allow 32 KiB of UTF-8 and not one byte more', () => {
    const agent = definition.nodes[0]!
    const fits = 'é'.repeat(WORKFLOW_LIMITS.instructionBytes / 2)
    expect(
      WorkflowDefinitionSchema.parse({ ...definition, nodes: [{ ...agent, instruction: fits }] }),
    ).toBeTruthy()
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...definition,
        nodes: [{ ...agent, instruction: `${fits}a` }],
      }),
    ).toThrow()
  })

  test('a whole definition is limited to 256 KiB', () => {
    const agent = definition.nodes[0]!
    const big = Array.from({ length: 10 }, (_, i) => ({
      ...agent,
      id: `a${i}`,
      instruction: 'x'.repeat(WORKFLOW_LIMITS.instructionBytes),
    }))
    expect(() => WorkflowDefinitionSchema.parse({ ...definition, nodes: big })).toThrow(/256 KiB/)
  })

  test('branch nodes carry a subject and typed rules', () => {
    const branch = {
      id: 'route',
      kind: 'branch',
      label: 'Route',
      subject: 'draft',
      rules: [
        { id: 'good', when: { kind: 'verdict', is: 'passed' } },
        { id: 'text', when: { kind: 'output_contains', text: 'TODO' } },
      ],
    }
    const parsed = WorkflowDefinitionSchema.parse({
      ...definition,
      nodes: [...definition.nodes, branch],
    })
    expect(parsed.nodes).toHaveLength(4)
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...definition,
        nodes: [
          ...definition.nodes,
          { ...branch, rules: [{ id: 'x', when: { kind: 'verdict', is: 'maybe' } }] },
        ],
      }),
    ).toThrow()
  })

  test('saving a version names the version it was based on', () => {
    expect(WorkflowVersionCreateSchema.parse({ baseVersion: 1, definition })).toBeTruthy()
    expect(() => WorkflowVersionCreateSchema.parse({ definition })).toThrow()
  })

  test('validation results round-trip', () => {
    const result = {
      ok: false,
      issues: [
        {
          code: 'unrouted_failure',
          severity: 'error',
          nodeId: 'draft',
          edgeId: null,
          field: null,
          message: 'Draft has no failed edge',
        },
      ],
      stats: { nodes: 3, edges: 2, maxSteps: 2, bytes: 400 },
    }
    expect(ValidationResultSchema.parse(result)).toEqual(result)
    expect(() =>
      ValidationResultSchema.parse({ ...result, issues: [{ ...result.issues[0], code: 'nope' }] }),
    ).toThrow()
  })
})

describe('workflow runs', () => {
  test('start fills defaults and needs the exact acknowledgement', () => {
    const parsed = WorkflowRunCreateSchema.parse(runCreate)
    expect(parsed.gatePolicy).toBe('gates-only')
    expect(parsed.unknownSpend).toBe('pause')
    expect(parsed.maxConcurrentSteps).toBe(2)
    expect(() =>
      WorkflowRunCreateSchema.parse({ ...runCreate, acknowledgement: { text: 'ok' } }),
    ).toThrow()
    expect(() => WorkflowRunCreateSchema.parse({ ...runCreate, extra: 1 })).toThrow()
  })

  test('start inputs are bounded in total and by name', () => {
    const big = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`in${i}`, 'x'.repeat(WORKFLOW_LIMITS.inputMaxChars)]),
    )
    expect(() => WorkflowRunCreateSchema.parse({ ...runCreate, inputs: big })).not.toThrow()
    const bigger = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `in${i}`,
        'x'.repeat(WORKFLOW_LIMITS.inputMaxChars * 4),
      ]),
    )
    expect(() => WorkflowRunCreateSchema.parse({ ...runCreate, inputs: bigger })).toThrow(/16 KiB/)
    expect(() =>
      WorkflowRunCreateSchema.parse({ ...runCreate, inputs: { 'Bad Name': 'x' } }),
    ).toThrow()
  })

  test('summary round-trips and keeps status apart from graphOutcome', () => {
    expect(WorkflowRunSummarySchema.parse(f.workflowRunSummary)).toEqual(f.workflowRunSummary)
    const abandoned = {
      ...f.workflowRunSummary,
      status: 'finished_with_unresolved',
      graphOutcome: 'reached_end',
      outcomeNote: 'Graph reached the end — 1 abandoned attempt not confirmed ended',
      unconfirmed: 1,
    }
    expect(WorkflowRunSummarySchema.parse(abandoned)).toEqual(abandoned)
    expect(() =>
      WorkflowRunSummarySchema.parse({ ...abandoned, graphOutcome: 'succeeded' }),
    ).toThrow()
  })

  test('the detail view round-trips', () => {
    const detail = {
      ...f.workflowRunSummary,
      definition,
      inputs: { topic: 'v2' },
      agentMap: [{ agentId: 'builder', incarnation: 'inc-1', status: 'current' }],
      plannerGeneration: 2,
      nodeStates: [
        {
          nodeId: 'draft',
          kind: 'agent',
          state: 'ready',
          revision: 3,
          waitingFor: 'budget',
          attemptsUsed: 0,
          attemptsMax: 2,
          stepId: null,
          lineage: [],
          reason: null,
          output: null,
          outputTruncated: false,
          outputRevision: 0,
          verdict: null,
          gateId: null,
          refusals: {
            consecutive: 5,
            lifetime: 7,
            lastGeneration: 7,
            lastState: 'refused',
            nextTryAt: null,
          },
          remaps: 0,
          canRetry: false,
          startedAt: null,
          endedAt: null,
        },
      ],
      tokens: [
        {
          id: 't1',
          edgeId: 'e1',
          kind: 'ok',
          producedBy: 'draft',
          producedAttempt: 1,
          consumedBy: null,
          createdAt: f.at,
        },
      ],
      consumed: [
        {
          consumer: 'approve',
          consumerAttempt: 1,
          producer: 'draft',
          producerAttempt: 1,
          outputRevision: 1,
          kind: 'output',
          eligible: true,
        },
      ],
      nodeGates: [],
      assignmentGates: [],
      steps: [],
      attempts: [],
      deadlineAt: null,
      maxSteps: 2,
      maxConcurrentSteps: 2,
      stepEstimateUsd: 0.5,
      budget: {
        limitUsd: null,
        settledUsd: 0,
        provisionalUsd: 0,
        reservedUsd: 0,
        remainingUsd: null,
        unknownSpend: true,
        complete: false,
      },
      unknownSpend: 'pause',
      spend: {
        settled: false,
        note: "spend not settled — Hermes doesn't report complete costs",
        evidence: [
          {
            attemptId: 'a1',
            attributed: true,
            lineageComplete: false,
            fresh: true,
            costScope: 'tokens',
          },
        ],
      },
      cancelFence: [],
      waiverAt: null,
      acknowledgedAt: f.at,
      endReason: null,
      storage: {
        reserveBytes: 1000,
        storedBytes: 10,
        protectedBytes: 65536,
        items: [{ kind: 'receipts', rows: 2, bytes: 100 }],
        compactedControlRecords: 0,
      },
    }
    expect(WorkflowRunDetailSchema.parse(detail)).toEqual(detail)
  })

  test('needs-you items cover node gates, retry, remap, and the refusal limit', () => {
    for (const item of [
      { kind: 'gate', gateId: 'g', gateKind: 'node', nodeId: 'approve' },
      { kind: 'retry', nodeId: 'draft', attemptsLeft: 1 },
      {
        kind: 'remap',
        agentId: 'builder',
        frozenIncarnation: 'a',
        currentIncarnation: 'b',
        nodeIds: ['draft'],
        plan: [{ nodeId: 'draft', retiresAttemptId: null, payloadHash: 'h', payload: 'text' }],
      },
      { kind: 'refusal_limit', nodeId: 'draft', attemptId: 'a1', refusals: 20 },
    ])
      expect(WorkflowNeedsYouSchema.parse(item)).toEqual(item)
    expect(() => WorkflowNeedsYouSchema.parse({ kind: 'retry', nodeId: 'x' })).toThrow()
  })
})

describe('workflow decisions', () => {
  test('are strict and revision-bound', () => {
    expect(
      GateDecisionSchema.parse({
        decision: 'reject',
        expectedRevision: 1,
        orchestrationRevision: 4,
      }),
    ).toBeTruthy()
    expect(() => GateDecisionSchema.parse({ decision: 'approve', expectedRevision: 1 })).toThrow()
    const retry = { expectedNodeRevision: 2, orchestrationRevision: 5, acknowledge: true }
    expect(WorkflowRetryDecisionSchema.parse(retry)).toEqual(retry)
    expect(() => WorkflowRetryDecisionSchema.parse({ ...retry, acknowledge: false })).toThrow()
    expect(() =>
      WorkflowRetryDecisionSchema.parse({ orchestrationRevision: 5, acknowledge: true }),
    ).toThrow()
    const again = { expectedNodeRevision: 2, orchestrationRevision: 5 }
    expect(WorkflowTryAgainDecisionSchema.parse(again)).toEqual(again)
    expect(() => WorkflowTryAgainDecisionSchema.parse({ ...again, x: 1 })).toThrow()
  })

  test('a remap names the incarnations and the exact payloads it approves', () => {
    const remap = {
      agentId: 'builder',
      frozenIncarnation: 'a',
      currentIncarnation: 'b',
      orchestrationRevision: 3,
      acknowledge: true,
      plan: [{ nodeId: 'draft', payloadHash: 'abc' }],
    }
    expect(WorkflowRemapDecisionSchema.parse(remap)).toEqual(remap)
    expect(() => WorkflowRemapDecisionSchema.parse({ ...remap, plan: undefined })).toThrow()
    expect(() => WorkflowRemapDecisionSchema.parse({ ...remap, acknowledge: false })).toThrow()
  })
})

describe('planner command identities', () => {
  test('are deterministic and carry the generation', () => {
    const id = { run: 'r1', node: 'draft', attempt: 2, verb: 'assign', generation: 3 } as const
    expect(plannerCommandId(id)).toBe('wf:r1:draft:2:assign:3')
    expect(plannerCommandId({ ...id })).toBe(plannerCommandId(id))
    expect(plannerCommandId({ ...id, generation: 4 })).not.toBe(plannerCommandId(id))
  })
})

describe('workflow layout (7.1c)', () => {
  const withLayout = (layout: unknown) => ({ ...definition, layout })

  test('is optional, partial and survives a parse unchanged', () => {
    expect(WorkflowDefinitionSchema.parse(definition).layout).toBeUndefined()
    const layout = { nodes: { draft: { x: 16, y: 32 }, done: { x: -4.5, y: 0 } } }
    expect(WorkflowDefinitionSchema.parse(withLayout(layout)).layout).toEqual(layout)
    expect(WorkflowDefinitionSchema.parse(withLayout({ nodes: {} })).layout).toEqual({ nodes: {} })
  })

  test('refuses non-finite and out-of-bounds numbers, bad ids, extra keys and too many entries', () => {
    const bad = (nodes: unknown) =>
      expect(() => WorkflowDefinitionSchema.parse(withLayout({ nodes }))).toThrow()
    bad({ draft: { x: Number.NaN, y: 0 } })
    bad({ draft: { x: Number.POSITIVE_INFINITY, y: 0 } })
    bad({ draft: { x: WORKFLOW_LAYOUT_LIMIT + 1, y: 0 } })
    bad({ draft: { x: 0, y: -WORKFLOW_LAYOUT_LIMIT - 1 } })
    bad({ draft: { x: '1', y: 0 } })
    bad({ draft: { x: 0, y: 0, z: 1 } })
    bad({ 'Bad Id': { x: 0, y: 0 } })
    bad(
      Object.fromEntries(
        Array.from({ length: WORKFLOW_LIMITS.maxNodes + 1 }, (_, i) => [`n${i}`, { x: 0, y: 0 }]),
      ),
    )
    expect(() => WorkflowDefinitionSchema.parse(withLayout({ nodes: {}, extra: 1 }))).toThrow()
    // The bounds themselves are fine.
    expect(() =>
      WorkflowDefinitionSchema.parse(
        withLayout({ nodes: { draft: { x: WORKFLOW_LAYOUT_LIMIT, y: -WORKFLOW_LAYOUT_LIMIT } } }),
      ),
    ).not.toThrow()
  })
})
