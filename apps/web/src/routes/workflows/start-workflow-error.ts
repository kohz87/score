import { ApiError } from '../../data/api.ts'
import { describeCreateError } from '../orchestrations/NewOrchestrationDialog.tsx'

export function describeStartError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'conflict')
      return 'An agent changed while this screen was open. The list above now shows the current ones. Check it and start again.'
    if (error.code === 'invalid_inputs') return error.message
    if (error.code === 'invalid_definition')
      return 'A step of this workflow can’t run as it is drawn. The problems are listed below; fix them in the editor and save a new version.'
  }
  return describeCreateError(error)
}
