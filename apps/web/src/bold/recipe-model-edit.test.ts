import { describe, expect, test } from 'vitest'
import { releaseDefinition } from '../../../../e2e/workflow-fixtures.ts'
import { starterDraft, type Draft } from '../routes/workflows/workflow-model.ts'
import { canonical, fixtures, validationAnswer } from './recipe-model-helpers.ts'
import {
  addRecipeStep,
  analyzeRecipe,
  moveRecipeStepProblem,
  planRecipeMove,
  removeRecipeStep,
  setFailureMode,
  setPortTarget,
  setRejectMode,
} from './recipe-model.ts'

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
