import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { visualLabel } from '../../routes/orchestrations/orch-model.ts'
import type { LayerId, WorkerNode } from './job-map-model.ts'
import { Node } from './Node.tsx'
import { Pill } from './Pill.tsx'

/** Step chips shown on one worker node before the rest are counted. */
const CHIP_LIMIT = 12

export function WorkerBox({
  worker,
  agent,
  selected,
  onPick,
}: {
  worker: WorkerNode
  agent: AgentSummary | undefined
  selected: LayerId | null
  onPick: (layer: LayerId) => void
}) {
  // A long job stays readable: the latest 12 steps as chips, the rest counted (review: 40 chips made a tall node).
  const shown = worker.chips.slice(-CHIP_LIMIT)
  const hidden = worker.chips.length - shown.length
  const counts = new Map<string, number>()
  for (const chip of worker.chips)
    counts.set(visualLabel[chip.visual], (counts.get(visualLabel[chip.visual]) ?? 0) + 1)
  const states = [...counts].map(([label, n]) => `${n} ${label}`)
  const asked = worker.asked
  const program = runtimeLabel(agent?.runtime)
  return (
    <div className="jobmap-worker" data-asked={asked ? '' : undefined}>
      <Node
        layer="workers"
        selected={selected}
        onPick={onPick}
        tone="work"
        pulse={worker.running}
        label={`Workers layer: ${worker.name}${program ? ` (${program})` : ''}, steps ${states.join(', ')}${asked ? `, asked its advisor ${asked.count} times` : ''}`}
      >
        <span className="jobmap-kicker">
          {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
          Worker · {worker.name}
          {/* 3.29.1: which program a coding worker runs (the retired step diagram showed it). */}
          {program && <span className="jobmap-program"> · {program}</span>}
        </span>
        <span className="jobmap-chips">
          {hidden > 0 && <Pill tone="muted">+{hidden} earlier</Pill>}
          {shown.map((chip) => (
            <Pill key={chip.stepId} tone={chip.tone}>
              {chip.label}
            </Pill>
          ))}
        </span>
        {asked && <span className="jobmap-asked">asked its advisor {asked.count}×</span>}
      </Node>
    </div>
  )
}
