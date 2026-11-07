import type { OrchestrationDetail } from '@score/contract'

/** The parts of a run the shared cards read; a workflow run supplies them from its own view (7.1b). */
export type GateRun = Pick<OrchestrationDetail, 'gates' | 'stepsList' | 'revision'>
export type LimitsRun = Pick<OrchestrationDetail, 'budget' | 'revision'>
export type AttemptsRun = Pick<OrchestrationDetail, 'attempts' | 'revision'>
