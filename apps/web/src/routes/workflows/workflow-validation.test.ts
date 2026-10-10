import { ValidationCodeSchema, type ValidationResult } from '@score/contract'
import { expect, test } from 'vitest'
import { starterDraft, updateNode } from './workflow-model.ts'
import {
  ALL_CODES,
  CODE_HELP,
  combine,
  indexIssues,
  issuesForNode,
  shapeIssues,
  summaryLine,
  worstSeverity,
} from './workflow-validation.ts'

test('every validation code of the contract has plain words telling what to do', () => {
  expect(Object.keys(CODE_HELP).sort()).toEqual([...ValidationCodeSchema.options].sort())
  expect(ALL_CODES.length).toBeGreaterThanOrEqual(35)
  for (const code of ALL_CODES) {
    expect(CODE_HELP[code].length).toBeGreaterThan(20)
    // Plain words: no internal code names leak into the help.
    expect(CODE_HELP[code]).not.toContain(code)
  }
})

test('a half-written draft is reported by field, on the node it concerns, before the server is asked', () => {
  const draft = starterDraft('')
  const issues = shapeIssues(draft)
  expect(issues.map((i) => [i.code, i.nodeId, i.field])).toEqual(
    expect.arrayContaining([
      ['incomplete', 'step1', 'agentId'],
      ['incomplete', 'step1', 'instruction'],
    ]),
  )
  const instruction = issues.find((i) => i.field === 'instruction')!
  expect(instruction.message).toBe('Write what this agent should do.')
  expect(
    shapeIssues(
      updateNode(updateNode(draft, 'step1', { agentId: 'builder' }), 'step1', {
        instruction: 'Do it',
      }),
    ),
  ).toEqual([])
})

const server: ValidationResult = {
  ok: false,
  stats: { nodes: 2, edges: 1, maxSteps: 1, bytes: 10 },
  issues: [
    {
      code: 'no_end',
      severity: 'error',
      nodeId: null,
      edgeId: null,
      field: null,
      message: 'There is no end.',
    },
    {
      code: 'unrouted_failure',
      severity: 'error',
      nodeId: 'step1',
      edgeId: null,
      field: null,
      message: 'A failure goes nowhere.',
    },
    {
      code: 'bad_port',
      severity: 'error',
      nodeId: 'step1',
      edgeId: 'e1',
      field: null,
      message: 'No such port.',
    },
    {
      code: 'template_needs_default',
      severity: 'warning',
      nodeId: 'end1',
      edgeId: null,
      field: 'instruction',
      message: 'Needs a fallback.',
    },
  ],
}

test('server issues are indexed by node, by edge and as general ones, each with help', () => {
  const draft = starterDraft('builder')
  const index = indexIssues(combine([], server))
  expect(index.general.map((i) => i.code)).toEqual(['no_end'])
  expect(index.byNode.get('step1')!.map((i) => i.code)).toEqual(['unrouted_failure'])
  expect(index.byEdge.get('e1')!.map((i) => i.code)).toEqual(['bad_port'])
  expect(index.errors).toBe(3)
  expect(index.warnings).toBe(1)
  // A node's list includes what is wrong with the connections that leave or enter it.
  expect(issuesForNode(index, draft, 'step1').map((i) => i.code)).toEqual([
    'unrouted_failure',
    'bad_port',
  ])
  expect(issuesForNode(index, draft, 'end1').map((i) => i.code)).toEqual([
    'template_needs_default',
    'bad_port',
  ])
  expect(index.all.every((i) => i.help.length > 0)).toBe(true)
})

test('severity and the header line', () => {
  expect(worstSeverity([])).toBeNull()
  const index = indexIssues(combine([], server))
  expect(worstSeverity(index.all)).toBe('error')
  expect(summaryLine(index, false)).toBe('3 problems to fix')
  expect(summaryLine(indexIssues([]), true)).toBe('Checking…')
  expect(summaryLine(indexIssues([]), false)).toBe('Looks good')
  const warnOnly = indexIssues(combine([], { ...server, issues: [server.issues[3]!], ok: true }))
  expect(summaryLine(warnOnly, false)).toBe('Ready to save, 1 warning')
})
