import { expect, test } from 'vitest'
import { releaseDefinition } from '../../../../e2e/workflow-fixtures.ts'
import { recipeFacts } from './recipe-facts.ts'

test('a recipe card says the steps, who does them, the approval and the inputs', () => {
  const line = recipeFacts(releaseDefinition)
  expect(line).toMatch(/^\d+ steps · builder → reviewer, your approval/)
  expect(line).toMatch(/ · input: topic$/)
})

test('a recipe with one agent step and no inputs reads as plain steps', () => {
  const line = recipeFacts({
    ...releaseDefinition,
    nodes: releaseDefinition.nodes.filter((node) => node.kind === 'agent').slice(0, 1),
    edges: [],
    inputs: [],
  })
  expect(line).toBe('1 step · builder')
})
