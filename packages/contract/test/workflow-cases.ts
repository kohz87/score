import { workflowDefinitionCases } from './workflow-cases-definitions.ts'
import { workflowRunCases } from './workflow-cases-runs.ts'

export const workflowCases = [...workflowDefinitionCases, ...workflowRunCases] as const
