import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@score/contract'
import { describe, expect, test } from 'vitest'
// The test checks the editor's graph against the one validator save and start use.
// eslint-disable-next-line no-restricted-imports
import { validateDefinition } from '../../../../apps/server/src/domain/workflows/definition.ts'
import {
  codingDefinition,
  drawnDefinition,
  failureRouteDefinition,
  gateRejectDefinition,
  joinDefinition,
  releaseDefinition,
  unfinishedDefinition,
} from '../../../../e2e/workflow-fixtures.ts'
import { starterDraft, type Draft } from '../routes/workflows/workflow-model.ts'
import {
  addRecipeStep,
  analyzeRecipe,
  moveRecipeStepProblem,
  planRecipeMove,
  recipeClientProblems,
  removeRecipeStep,
  setFailureMode,
  setPortTarget,
  setRejectMode,
  targetStepLabel,
} from './recipe-model.ts'

const fixtures: [string, WorkflowDefinition][] = [
  ['release', releaseDefinition],
  ['unfinished', unfinishedDefinition],
  ['drawn', drawnDefinition],
  ['coding', codingDefinition],
  ['failure route', failureRouteDefinition],
  ['gate reject route', gateRejectDefinition],
  ['join', joinDefinition],
]

function canonical(definition: Draft) {
  return {
    ...definition,
    nodes: [...definition.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...definition.edges].sort((a, b) =>
      `${a.from}/${a.port}/${a.to}/${a.id}`.localeCompare(`${b.from}/${b.port}/${b.to}/${b.id}`),
    ),
  }
}

function validationAnswer(definition: WorkflowDefinition) {
  const result = validateDefinition(definition)
  return {
    ok: result.ok,
    // Relinking a short id to a longer one changes the serialised byte count without changing the answer.
    stats: { ...result.stats, bytes: 0 },
    issues: result.issues
      .map((issue) => ({ ...issue }))
      .sort((a, b) =>
        `${a.code}/${a.nodeId ?? ''}/${a.edgeId ?? ''}/${a.field ?? ''}/${a.message}`.localeCompare(
          `${b.code}/${b.nodeId ?? ''}/${b.edgeId ?? ''}/${b.field ?? ''}/${b.message}`,
        ),
      ),
  }
}

describe('the step list is a faithful face of the workflow definition', () => {
  test.each(fixtures)(
    '%s: every node and edge appears once, in topological order, unchanged',
    (_, definition) => {
      const before = JSON.stringify(definition)
      const analysis = analyzeRecipe(definition)
      expect(JSON.stringify(definition)).toBe(before)
      expect(analysis.listable).toBe(true)
      expect(analysis.rows.map((row) => row.node.id).sort()).toEqual(
        definition.nodes.map((node) => node.id).sort(),
      )
      // The order is topological: every edge's source appears before its target.
      const position = new Map(analysis.order.map((node, index) => [node.id, index]))
      for (const edge of definition.edges)
        expect(position.get(edge.from)!).toBeLessThan(position.get(edge.to)!)

      const seen = analysis.rows.flatMap((row) =>
        row.routes.flatMap((route) =>
          route.edges.map((edge) => `${edge.id}:${edge.from}/${edge.port}/${edge.to}`),
        ),
      )
      expect(seen.sort()).toEqual(
        definition.edges.map((edge) => `${edge.id}:${edge.from}/${edge.port}/${edge.to}`).sort(),
      )
      for (const row of analysis.rows) {
        expect(row.index).toBe(analysis.rows.indexOf(row))
        expect(row.incoming).toEqual(definition.edges.filter((edge) => edge.to === row.node.id))
      }
    },
  )

  test.each(fixtures)(
    '%s: loading and saving unchanged writes the identical definition',
    (_, definition) => {
      const loaded = WorkflowDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)))
      analyzeRecipe(loaded)
      expect(loaded).toEqual(definition)
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(definition))
      expect(loaded.layout).toEqual(definition.layout)
      expect(loaded.nodes.map((node) => node.id)).toEqual(definition.nodes.map((node) => node.id))
      expect(loaded.edges.map((edge) => edge.id)).toEqual(definition.edges.map((edge) => edge.id))
      const originalNodes = new Map(definition.nodes.map((node) => [node.id, node]))
      for (const node of loaded.nodes) expect(node).toEqual(originalNodes.get(node.id))
    },
  )

  test('step labels use the number the list shows', () => {
    const analysis = analyzeRecipe(releaseDefinition)
    expect(targetStepLabel(analysis, 'passed')).toBe('Step 4 · Passed review?')
  })

  test('a port that fans out to two steps is graph-only, with the reason the person needs', () => {
    const fanout: WorkflowDefinition = {
      ...releaseDefinition,
      edges: [
        ...releaseDefinition.edges,
        { id: 'fanout', from: 'passed', port: 'ok', to: 'repaired' },
      ],
    }
    const analysis = analyzeRecipe(fanout)
    expect(analysis.listable).toBe(false)
    expect(analysis.graphOnlyReasons).toEqual(['Passed review? sends “passed” to 2 steps at once.'])
  })

  test('cycles, edges to missing steps and edges from unknown ports stay in the graph view', () => {
    const cycle: WorkflowDefinition = {
      ...releaseDefinition,
      edges: [
        { id: 'e1', from: 'draft', port: 'ok', to: 'review' },
        { id: 'e2', from: 'review', port: 'ok', to: 'draft' },
      ],
    }
    expect(analyzeRecipe(cycle)).toMatchObject({ listable: false })
    expect(analyzeRecipe(cycle).graphOnlyReasons).toContain('The recipe contains a loop.')

    const unknown = {
      ...releaseDefinition,
      edges: [
        ...releaseDefinition.edges,
        { id: 'missing', from: 'draft', port: 'ok', to: 'ghost' },
      ],
    }
    expect(analyzeRecipe(unknown).listable).toBe(false)
    expect(analyzeRecipe(unknown).graphOnlyReasons).toContain(
      'Edge missing points at a step that is not in this recipe.',
    )

    const badPort = {
      ...releaseDefinition,
      edges: [
        ...releaseDefinition.edges,
        { id: 'bad-port', from: 'draft', port: 'ghost', to: 'review' },
      ],
    }
    expect(analyzeRecipe(badPort).listable).toBe(false)
    expect(analyzeRecipe(badPort).graphOnlyReasons).toContain(
      'Draft the notes sends “ghost”, which is not one of its routes.',
    )
  })
})

describe('the prototype problems and live graph problems meet in one list', () => {
  const base = starterDraft('builder')
  const agent = {
    id: 'step1',
    kind: 'agent' as const,
    label: 'Do it',
    agentId: 'builder',
    instruction: 'Do the work.',
    retries: 0,
    onFailure: 'fail_run' as const,
  }
  const gate = {
    id: 'gate1',
    kind: 'gate' as const,
    label: 'Check',
    question: 'Go?',
    onReject: 'stop_run' as const,
  }
  const branch = {
    id: 'branch1',
    kind: 'branch' as const,
    label: 'Passed?',
    subject: '',
    rules: [{ id: 'rule1', when: { kind: 'verdict' as const, is: 'passed' as const } }],
  }

  test('an empty recipe says how to start', () => {
    expect(
      recipeClientProblems({ nodes: [], edges: [] }).map((problem) => problem.message),
    ).toEqual(['Add at least one step.'])
  })

  test('an agent needs an agent and an instruction, a gate needs a step after it, and the last step is an End', () => {
    const emptyAgent: Draft = {
      ...base,
      nodes: [{ ...agent, agentId: '', instruction: '' }],
      edges: [],
    }
    expect(recipeClientProblems(emptyAgent).map((problem) => problem.code)).toContain(
      'agent_incomplete',
    )

    const gateLast: Draft = {
      ...base,
      nodes: [agent, gate],
      edges: [{ id: 'e1', from: 'step1', port: 'ok', to: 'gate1' }],
    }
    const messages = recipeClientProblems(gateLast).map((problem) => problem.message)
    expect(messages).toContain('Step 2: a gate needs a step after it.')
    expect(messages).toContain('The last step should be an End.')

    const unsetBranch: Draft = {
      ...base,
      nodes: [agent, branch, { id: 'end1', kind: 'end', label: 'Done' }],
      edges: [{ id: 'e1', from: 'step1', port: 'ok', to: 'branch1' }],
    }
    expect(recipeClientProblems(unsetBranch).map((problem) => problem.message)).toContain(
      'Step 2: a branch needs a step to check.',
    )
  })
})

describe('moving, adding and removing steps edits the same graph', () => {
  const straight: Draft = {
    ...starterDraft('builder'),
    name: 'Straight run',
    nodes: [
      {
        id: 'one',
        kind: 'agent',
        label: 'One',
        agentId: 'builder',
        instruction: 'One',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'two',
        kind: 'agent',
        label: 'Two',
        agentId: 'builder',
        instruction: 'Two',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'three',
        kind: 'agent',
        label: 'Three',
        agentId: 'builder',
        instruction: 'Three',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'one', port: 'ok', to: 'two' },
      { id: 'e2', from: 'two', port: 'ok', to: 'three' },
      { id: 'e3', from: 'three', port: 'ok', to: 'done' },
    ],
  }

  test('moving a straight run relinks its normal path and keeps every edge id', () => {
    const moved = planRecipeMove(straight, 'two', -1).draft
    expect(analyzeRecipe(moved).order.map((node) => node.id)).toEqual([
      'two',
      'one',
      'three',
      'done',
    ])
    expect(moved.edges.find((edge) => edge.id === 'e1')).toMatchObject({
      from: 'two',
      port: 'ok',
      to: 'one',
    })
    expect(moved.edges.find((edge) => edge.id === 'e2')).toMatchObject({
      from: 'one',
      port: 'ok',
      to: 'three',
    })
    expect(moved.edges.map((edge) => edge.id).sort()).toEqual(['e1', 'e2', 'e3'])
  })

  test('moving the first step below a branch retargets every incoming route, not just an ok edge', () => {
    const branched: Draft = {
      ...starterDraft('builder'),
      name: 'Branched run',
      nodes: [
        {
          id: 's',
          kind: 'agent',
          label: 'Start',
          agentId: 'builder',
          instruction: 'Start.',
          retries: 0,
          onFailure: 'fail_run',
        },
        {
          id: 'br',
          kind: 'branch',
          label: 'Passed?',
          subject: 's',
          rules: [{ id: 'r1', when: { kind: 'verdict', is: 'passed' } }],
        },
        {
          id: 'a',
          kind: 'agent',
          label: 'A',
          agentId: 'builder',
          instruction: 'A.',
          retries: 0,
          onFailure: 'fail_run',
        },
        {
          id: 'b',
          kind: 'agent',
          label: 'B',
          agentId: 'builder',
          instruction: 'B.',
          retries: 0,
          onFailure: 'fail_run',
        },
        {
          id: 'c',
          kind: 'agent',
          label: 'C',
          agentId: 'builder',
          instruction: 'C.',
          retries: 0,
          onFailure: 'fail_run',
        },
        { id: 'end', kind: 'end', label: 'Done' },
      ],
      edges: [
        { id: 'e1', from: 's', port: 'ok', to: 'br' },
        { id: 'e2', from: 'br', port: 'r1', to: 'a' },
        { id: 'e3', from: 'br', port: 'default', to: 'end' },
        { id: 'e4', from: 'a', port: 'ok', to: 'b' },
        { id: 'e5', from: 'b', port: 'ok', to: 'c' },
        { id: 'e6', from: 'c', port: 'ok', to: 'end' },
      ],
    }
    const plan = planRecipeMove(branched, 'a', 1)
    expect(plan.reason).toBeNull()
    expect(plan.order.map((node) => node.id)).toEqual(['s', 'br', 'b', 'a', 'c', 'end'])
    expect(plan.draft.edges.find((edge) => edge.id === 'e2')).toMatchObject({
      from: 'br',
      port: 'r1',
      to: 'b',
    })
    expect(plan.draft.edges.some((edge) => edge.to === 'b' && edge.id === 'e2')).toBe(true)
    expect(plan.draft.edges.find((edge) => edge.id === 'e3')).toMatchObject({
      from: 'br',
      port: 'default',
      to: 'end',
    })
    expect(plan.draft.edges.map((edge) => edge.id).sort()).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
    ])
    expect(validationAnswer(plan.draft).ok).toBe(true)
    expect(moveRecipeStepProblem(branched, 'a', 1)).toBeNull()
  })

  test('a move that cannot change the visible order is refused instead of adding an undo step', () => {
    const plan = planRecipeMove(releaseDefinition, 'passed', 1)
    expect(plan.changed).toBe(false)
    expect(plan.draft).toBe(releaseDefinition)
    expect(plan.reason).toBe('This move would not change the visible order of the steps.')
  })

  test('adding before the final End and removing it again closes the run', () => {
    const added = addRecipeStep(releaseDefinition, 'gate')
    if ('error' in added) throw new Error(added.error)
    const rows = analyzeRecipe(added.draft).rows
    const index = rows.findIndex((row) => row.node.id === added.id)
    expect(rows[index]?.node.kind).toBe('gate')
    expect(rows.at(-1)?.node.kind).toBe('end')
    expect(rows.some((row) => row.node.id === added.id)).toBe(true)

    const removed = removeRecipeStep(added.draft, added.id)
    expect(canonical(removed)).toEqual(canonical(releaseDefinition))
    expect(analyzeRecipe(removed).listable).toBe(true)
  })

  test('adding after a branch joins its path and continues into the End', () => {
    const branched: Draft = {
      ...starterDraft('builder'),
      nodes: [
        {
          id: 'step1',
          kind: 'agent',
          label: 'Draft',
          agentId: 'builder',
          instruction: 'Draft it.',
          retries: 0,
          onFailure: 'fail_run',
        },
        {
          id: 'branch1',
          kind: 'branch',
          label: 'Passed?',
          subject: 'step1',
          rules: [{ id: 'rule1', when: { kind: 'verdict', is: 'passed' } }],
        },
        { id: 'end1', kind: 'end', label: 'Done' },
      ],
      edges: [
        { id: 'e1', from: 'step1', port: 'ok', to: 'branch1' },
        { id: 'e2', from: 'branch1', port: 'default', to: 'end1' },
      ],
    }
    const added = addRecipeStep(branched, 'agent', 'builder')
    if ('error' in added) throw new Error(added.error)
    expect(added.draft.edges).toContainEqual(
      expect.objectContaining({ from: 'branch1', port: 'default', to: added.id }),
    )
    expect(added.draft.edges).toContainEqual(
      expect.objectContaining({ from: added.id, port: 'ok', to: 'end1' }),
    )
  })

  test('every add variant allocates unique edge ids and leaves a graph the shared validator accepts', () => {
    const starter = starterDraft('builder')
    const step = starter.nodes[0]!
    const withoutEnd: Draft = {
      ...starter,
      nodes: [step],
      edges: [],
    }
    const fanIn: Draft = {
      ...starter,
      nodes: [
        {
          id: 'start',
          kind: 'agent',
          label: 'Start',
          agentId: 'builder',
          instruction: 'Start.',
          retries: 0,
          onFailure: 'fail_run',
        },
        {
          id: 'pick',
          kind: 'branch',
          label: 'Which way?',
          subject: 'start',
          rules: [{ id: 'rule1', when: { kind: 'verdict', is: 'passed' } }],
        },
        {
          id: 'left',
          kind: 'agent',
          label: 'Left',
          agentId: 'builder',
          instruction: 'Left.',
          retries: 0,
          onFailure: 'fail_run',
        },
        {
          id: 'right',
          kind: 'agent',
          label: 'Right',
          agentId: 'builder',
          instruction: 'Right.',
          retries: 0,
          onFailure: 'fail_run',
        },
        { id: 'done', kind: 'end', label: 'Done' },
      ],
      edges: [
        { id: 'e1', from: 'start', port: 'ok', to: 'pick' },
        { id: 'e2', from: 'pick', port: 'rule1', to: 'left' },
        { id: 'e3', from: 'pick', port: 'default', to: 'right' },
        { id: 'e4', from: 'left', port: 'ok', to: 'done' },
        { id: 'e5', from: 'right', port: 'ok', to: 'done' },
      ],
    }
    const cases: [string, Draft, Parameters<typeof addRecipeStep>[1]][] = [
      ['agent', starter, 'agent'],
      ['gate', starter, 'gate'],
      ['branch', starter, 'branch'],
      ['join', fanIn, 'join'],
      ['end', withoutEnd, 'end'],
    ]
    for (const [name, base, kind] of cases) {
      const added = addRecipeStep(base, kind, 'builder')
      if ('error' in added) throw new Error(`${name}: ${added.error}`)
      const ids = added.draft.edges.map((edge) => edge.id)
      expect(new Set(ids).size, name).toBe(ids.length)
      expect(validationAnswer(added.draft).issues, name).toEqual([])
    }
  })

  test('the starter replay gate, branch and agent has no reused edge id and validates', () => {
    let draft = starterDraft('builder')
    for (const kind of ['gate', 'branch', 'agent'] as const) {
      const added = addRecipeStep(draft, kind, 'builder')
      if ('error' in added) throw new Error(added.error)
      draft = added.draft
      const ids = draft.edges.map((edge) => edge.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
    expect(validationAnswer(draft)).toMatchObject({ ok: true, issues: [] })
  })

  test('removing a middle step joins the step before to the step after', () => {
    const removed = removeRecipeStep(releaseDefinition, 'review')
    expect(removed.nodes.some((node) => node.id === 'review')).toBe(false)
    expect(removed.edges.some((edge) => edge.from === 'review' || edge.to === 'review')).toBe(false)
    expect(removed.edges).toContainEqual(
      expect.objectContaining({ from: 'draft', port: 'ok', to: 'approve' }),
    )
  })
})

describe('every legal move keeps the definition and the validator answer', () => {
  test.each(fixtures)('%s', (_, definition) => {
    const before = analyzeRecipe(definition)
    if (!before.listable) return
    const expectedNodes = new Map(definition.nodes.map((node) => [node.id, node]))
    const expectedEdgeIds = definition.edges.map((edge) => edge.id).sort()
    const expectedValidation = validationAnswer(definition)
    for (let index = 0; index < before.order.length; index++) {
      for (const direction of [-1, 1] as const) {
        const target = index + direction
        if (target < 0 || target >= before.order.length) continue
        const node = before.order[index]!
        const plan = planRecipeMove(definition, node.id, direction)
        if (!plan.changed) {
          expect(plan.reason).not.toBeNull()
          continue
        }
        expect(plan.reason).toBeNull()
        const expectedOrder = before.order.map((item) => item.id)
        ;[expectedOrder[index], expectedOrder[target]] = [
          expectedOrder[target]!,
          expectedOrder[index]!,
        ]
        expect(plan.order.map((item) => item.id)).toEqual(expectedOrder)
        expect(plan.draft.edges.map((edge) => edge.id).sort()).toEqual(expectedEdgeIds)
        expect(new Set(plan.draft.edges.map((edge) => edge.id)).size).toBe(plan.draft.edges.length)
        for (const movedNode of plan.draft.nodes)
          expect(movedNode).toEqual(expectedNodes.get(movedNode.id))
        expect(validationAnswer(plan.draft)).toEqual(expectedValidation)
        expect(moveRecipeStepProblem(definition, node.id, direction)).toBeNull()
      }
    }
  })
})

describe('branch and failure routes are one target per port', () => {
  test('a branch route can be pointed at another step without leaving the old edge behind', () => {
    const changed = setPortTarget(releaseDefinition, 'passed', 'default', 'repaired')
    const outgoing = changed.edges.filter(
      (edge) => edge.from === 'passed' && edge.port === 'default',
    )
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.to).toBe('repaired')
    expect(
      releaseDefinition.edges.filter((edge) => edge.from === 'passed' && edge.port === 'default'),
    ).toHaveLength(1)
  })

  test('routing a failure adds one edge and switching back to stopping removes it', () => {
    let changed = setFailureMode(releaseDefinition, 'draft', 'route')
    expect(changed.nodes.find((node) => node.id === 'draft')).toMatchObject({ onFailure: 'route' })
    changed = setPortTarget(changed, 'draft', 'failed', 'repair')
    expect(
      changed.edges.filter((edge) => edge.from === 'draft' && edge.port === 'failed'),
    ).toHaveLength(1)
    changed = setFailureMode(changed, 'draft', 'fail_run')
    expect(
      changed.edges.filter((edge) => edge.from === 'draft' && edge.port === 'failed'),
    ).toHaveLength(0)
  })

  test('routing a rejection adds one edge and stopping removes it', () => {
    let changed = setRejectMode(releaseDefinition, 'approve', 'route')
    changed = setPortTarget(changed, 'approve', 'rejected', 'repair')
    expect(
      changed.edges.filter((edge) => edge.from === 'approve' && edge.port === 'rejected'),
    ).toHaveLength(1)
    changed = setRejectMode(changed, 'approve', 'stop_run')
    expect(
      changed.edges.filter((edge) => edge.from === 'approve' && edge.port === 'rejected'),
    ).toHaveLength(0)
  })
})
