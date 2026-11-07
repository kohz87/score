import { createContext, useContext } from 'react'
import type { StartJobOptions } from './start-job-types.ts'

export const StartJobContext = createContext<{
  openStartJob: (options?: StartJobOptions) => void
} | null>(null)

export function useStartJob() {
  return useContext(StartJobContext)
}
