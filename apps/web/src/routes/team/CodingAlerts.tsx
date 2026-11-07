import type { CodingAgent } from '@score/contract'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { ReleaseHeld } from './ReleaseHeld.tsx'

/** Things that stop the agent working: held programs and a CLI version that failed Score's check. Shown only when they apply. */
export function CodingAlerts({ coding }: { coding: CodingAgent }) {
  const held = coding.heldGroups.length > 0
  const broken = coding.cli.problem !== null
  if (!held && !broken) return null
  return (
    <section className="team-card" aria-label="Needs attention" data-protected="block">
      {held && (
        <div role="alert">
          <p className="team-muted-strong">
            Some programs this agent started couldn’t be proven ended. Score keeps trying to stop
            them, and the agent takes no new messages until they have ended.
          </p>
          <ReleaseHeld agentId={coding.id} />
        </div>
      )}
      {broken && (
        <div role="alert">
          <p className="team-muted-strong">
            {runtimeLabel(coding.runtime) ?? coding.runtime} {coding.cli.version} can’t run:{' '}
            {coding.cli.problem} Score was tested with {coding.cli.testedVersions.join(', ')}.
          </p>
        </div>
      )}
    </section>
  )
}
