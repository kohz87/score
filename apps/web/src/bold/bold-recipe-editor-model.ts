import type { AgentSummary, WorkflowDetail, WorkflowSummary } from '@score/contract'
import { ApiError } from '../data/api.ts'
import type { Draft } from '../routes/workflows/workflow-model.ts'
import { pairingProblem } from './bold-errors.ts'
import type { RecipeProblem } from './recipe-model.ts'

export type BoldRecipeEditorProps = {
  detail: WorkflowDetail | null
  initialDefinition: Draft
  recipes: WorkflowSummary[]
  agents: AgentSummary[]
  notice: string
  onSaved: (id: string, version: number) => void
  onDeleted: (id: string) => void
  onDuplicated: (id: string) => void
  onNotice: (text: string) => void
}

export type Problem = RecipeProblem & { edgeId?: string | null }

function problemKey(problem: Problem): string {
  return `${problem.code}|${problem.nodeId ?? ''}|${problem.message}`
}

export function dedupeProblems(problems: Problem[]): Problem[] {
  const seen = new Set<string>()
  return problems.filter((problem) => {
    const key = problemKey(problem)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function describeError(error: unknown): string {
  const pairing = pairingProblem(error)
  if (pairing) return pairing
  if (!(error instanceof ApiError)) return 'Couldn’t do that. Try again.'
  if (error.code === 'workflow_used')
    return 'This recipe has runs, so it can’t be deleted. Delete is only for recipes nothing has run.'
  if (error.code === 'quota_exhausted')
    return 'This recipe has as many saved versions as Score keeps (or there are too many recipes). Delete one you don’t use.'
  if (error.code === 'invalid_definition')
    return 'Score found a problem with this recipe. The problem line above says what.'
  return error.message
}

export function problemTarget(problem: Problem, draft: Draft): string | null {
  return (
    problem.nodeId ??
    (problem.edgeId ? (draft.edges.find((edge) => edge.id === problem.edgeId)?.from ?? null) : null)
  )
}
