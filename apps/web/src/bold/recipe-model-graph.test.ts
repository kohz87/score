import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@score/contract'
import { describe, expect, test } from 'vitest'
import { releaseDefinition } from '../../../../e2e/workflow-fixtures.ts'
import { fixtures } from './recipe-model-helpers.ts'
import { analyzeRecipe, targetStepLabel } from './recipe-model.ts'

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
