import { useMemo, useState } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../../data/task-queries.ts'
import { LiveLog } from './LiveLog.tsx'
import { filterLog, leadSteps } from './orch-model.ts'
import { useRun, useRunActions } from './orchestration-queries.ts'
import { BudgetBlock, StepCard } from './RunPanel.tsx'
import { RunNeeds } from './RunDecisions.tsx'
import { orchCoding } from './orch-model.ts'

/**
 * The run's decisions, step cards, budget and log, wired as the app wires them (RoomRunPanel for the decisions and
 * steps, the log): what the tests of a run's behaviour mount now that the step diagram is gone.
 */
export function RunHarness({ orchestrationId }: { orchestrationId: string }) {
  const run = useRun(orchestrationId)
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const actions = useRunActions(orchestrationId)
  const [selected, setSelected] = useState<string | null>(null)
  const detail = run.data?.snapshot.orchestration
  const events = useMemo(() => run.data?.events ?? [], [run.data])
  if (!detail) return <p role="status">Loading the run…</p>
  const logEvents = filterLog(events, { node: selected })
  return (
    <div>
      <RunNeeds run={detail} agents={agents} actions={actions} />
      {leadSteps(detail.stepsList).map((step) => (
        <StepCard
          key={step.id}
          step={step}
          run={detail}
          agents={agents}
          selected={selected === step.id}
          open={selected === step.id}
          onSelect={setSelected}
        />
      ))}
      <BudgetBlock run={detail} coding={orchCoding(detail.coding, detail.quotaFloorPercent)} />
      <LiveLog
        events={logEvents}
        node={selected}
        onClearNode={() => setSelected(null)}
        label="Live log"
      />
    </div>
  )
}
