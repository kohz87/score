import { useLocation } from 'react-router'
import { useStartJobData } from './use-start-job-data.ts'
import { useStartJobFormActions } from './start-job-form-actions.ts'
import { useStartJobModel } from './start-job-model.ts'
import { useStartJobStartActions } from './start-job-start-actions.ts'
import { useStartJobState } from './use-start-job-state.ts'
import type { StartJobOptions } from './start-job-types.ts'
import type { StartJobRefs } from './use-start-job-refs.ts'

export function useStartJobView(
  onClose: () => void,
  options: StartJobOptions | undefined,
  refs: StartJobRefs,
) {
  const location = useLocation()
  const state = useStartJobState(options, refs)
  const data = useStartJobData(state, options, location)
  const model = useStartJobModel(state, data, options, location)
  const form = useStartJobFormActions(
    state,
    model,
    refs.dialogRef,
    refs.attemptKeyRef,
    refs.recipeButtonsRef,
    onClose,
  )
  const start = useStartJobStartActions(
    state,
    data,
    model,
    form,
    refs.attemptKeyRef,
    refs.stoppedForStartRef,
    refs.startingRef,
    refs.savedRecipeNameRef,
  )
  return { ...state, ...data, ...model, ...form, ...start, onClose }
}

export type StartJobView = ReturnType<typeof useStartJobView>
