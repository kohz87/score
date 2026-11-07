import { WorkflowRunListSchema } from '../packages/contract/src/index.ts'
import {
  drawnDetail,
  drawnVersion,
  releaseDetail,
  releaseVersion,
  unfinishedDetail,
  unfinishedVersion,
  workflowList,
  workflowPreflight,
} from './workflow-fixtures-definitions.ts'
import { runEvents, runSnapshot, runSummary } from './workflow-fixtures-runs.ts'

export * from './workflow-fixtures-coding.ts'
export * from './workflow-fixtures-definitions.ts'
export * from './workflow-fixtures-graphs.ts'
export * from './workflow-fixtures-runs.ts'

export const workflowFixtures: Record<string, unknown> = {
  '/api/workflows': workflowList,
  '/api/workflows/wf-release': releaseDetail,
  '/api/workflows/wf-draft': unfinishedDetail,
  '/api/workflows/wf-drawn': drawnDetail,
  '/api/workflows/wf-release/versions/1': releaseVersion,
  '/api/workflows/wf-draft/versions/1': unfinishedVersion,
  '/api/workflows/wf-drawn/versions/1': drawnVersion,
  '/api/workflow-runs': WorkflowRunListSchema.parse({ asOfSeq: 52, items: [runSummary] }),
  '/api/workflow-runs/wfrun-1': runSnapshot,
  '/api/workflow-runs/wfrun-1/events': runEvents,
  '/api/workflow-runs/preflight?workflowId=wf-release&version=1': workflowPreflight,
}
