import type { AgentSummary } from '@score/contract'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { NewOrchestrationDialog } from '../orchestrations/NewOrchestrationDialog.tsx'
import { userRoomPath } from './user-view.ts'

/** The compact "New orchestration" dialog of the user view; a started run opens its room in this view. */
export function useStartOrchestration(agents: AgentSummary[]): {
  start: (goal: string) => void
  dialog: ReactNode
} {
  const [goal, setGoal] = useState<string | null>(null)
  const navigate = useNavigate()
  return {
    start: setGoal,
    dialog:
      goal === null ? null : (
        <NewOrchestrationDialog
          compact
          initialGoal={goal}
          agents={agents}
          close={() => setGoal(null)}
          created={(run) => {
            setGoal(null)
            void navigate(userRoomPath(run.roomId))
          }}
        />
      ),
  }
}
