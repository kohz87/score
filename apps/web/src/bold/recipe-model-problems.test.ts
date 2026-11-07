import { describe, expect, test } from 'vitest'
import { starterDraft, type Draft } from '../routes/workflows/workflow-model.ts'
import { recipeClientProblems } from './recipe-model.ts'

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
