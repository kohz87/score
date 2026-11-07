import { createBriefScenarioSteps } from './scenario-brief-steps.ts'
import { createScenarioContext } from './scenario-context.ts'
import { createDocsScenarioSteps } from './scenario-docs-steps.ts'
import { createMainScenarioSteps } from './scenario-main-steps.ts'
import { createReviewScenarioSteps } from './scenario-review-steps.ts'
import type { ScenarioStep } from './scenario-types.ts'

export { exampleAgents, exampleRun, fakeStatus, scenarioDuration } from './scenario-fixtures.ts'
export type { ScenarioStep } from './scenario-types.ts'

export function createScenario(startedAt: number, loop = 0): ScenarioStep[] {
  const context = createScenarioContext(startedAt, loop)

  return [
    ...createMainScenarioSteps(context),
    ...createReviewScenarioSteps(context),
    ...createBriefScenarioSteps(context),
    ...createDocsScenarioSteps(context),
  ]
    .sort((left, right) => left.at - right.at)
    .map((step) => ({ ...step, at: step.at * 18 }))
}
