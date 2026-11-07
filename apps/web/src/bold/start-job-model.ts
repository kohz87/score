import { useEffect, useRef } from 'react'
import { deriveStartJobModel } from './start-job-derive.ts'
import type { StartJobOptions } from './start-job-types.ts'
import type { StartJobData } from './use-start-job-data.ts'
import type { StartJobState } from './use-start-job-state.ts'

export function useStartJobModel(
  state: StartJobState,
  data: StartJobData,
  options: StartJobOptions | undefined,
  location: { search: string },
) {
  const model = deriveStartJobModel(state, data, options, location)
  const appliedWanted = useRef(false)
  // The state setter is stable, so the effect runs when the wanted recipe changes, as before the split (review).
  const { setRecipe } = state
  useEffect(() => {
    if (!model.wantedItem || appliedWanted.current) return
    appliedWanted.current = true
    setRecipe({
      kind: 'workflow',
      id: model.wantedItem.id,
      name: model.wantedItem.name,
    })
  }, [model.wantedItem, setRecipe])
  return model
}

export type StartJobModel = ReturnType<typeof useStartJobModel>
