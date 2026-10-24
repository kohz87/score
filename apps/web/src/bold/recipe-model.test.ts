import type { WorkflowDefinition } from '@score/contract'
import { describe, expect, test } from 'vitest'
import {
  drawnDefinition,
  releaseDefinition,
  unfinishedDefinition,
} from '../../../../e2e/workflow-fixtures.ts'
import { starterDraft, type Draft } from '../routes/workflows/workflow-model.ts'
import {
  addRecipeStep,
  analyzeRecipe,
  moveRecipeStep,
  orderNodes,
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
]

function canonical(definition: Draft) {
  return {
    name: definition.name,
    description: definition.description,
    inputs: definition.inputs,
    nodes: [...definition.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...definition.edges].sort((a, b) =>
      `${a.from}/${a.port}/${a.to}/${a.id}`.localeCompare(`${b.from}/${b.port}/${b.to}/${b.id}`),
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
      expect(analysis.order).toEqual(orderNodes(definition))

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
  test('moving a straight run relinks its normal path and keeps its routes', () => {
    const moved = moveRecipeStep(releaseDefinition, 'review', -1)
    expect(analyzeRecipe(moved).order.map((node) => node.id)).toEqual([
      'review',
      'draft',
      'approve',
      'passed',
      'publish',
      'repair',
      'repaired',
    ])
    expect(moved.edges.find((edge) => edge.id === 'e1')).toMatchObject({
      from: 'review',
      port: 'ok',
      to: 'draft',
    })
    expect(moved.edges.find((edge) => edge.id === 'e2')).toMatchObject({
      from: 'draft',
      port: 'ok',
      to: 'approve',
    })
    expect(moved.edges.find((edge) => edge.id === 'e5')).toMatchObject({
      from: 'passed',
      port: 'default',
      to: 'repair',
    })
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
      expect.objectContaining({ from: 'branch1', port: 'rule1', to: added.id }),
    )
    expect(added.draft.edges).toContainEqual(
      expect.objectContaining({ from: added.id, port: 'ok', to: 'end1' }),
    )
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
