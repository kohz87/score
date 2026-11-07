import type { CodingAgent } from '@score/contract'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { CodingBackend } from './CodingBackend.tsx'

const cliStates = {
  ready: 'Ready',
  not_installed: 'Not installed',
  not_supported: 'Not supported yet',
  untested_version: 'Newer than tested',
} as const

/** The right-hand column of the Personality card: what runs this agent and where. */
export function CodingFacts({ coding }: { coding: CodingAgent }) {
  return (
    <dl className="team-facts team-facts-stacked">
      <div>
        <dt>CLI</dt>
        <dd>
          {runtimeLabel(coding.runtime) ?? coding.runtime} {coding.cli.version ?? ''} ·{' '}
          {cliStates[coding.cli.state]}
          {coding.cli.state === 'untested_version' &&
            coding.cli.problem === null &&
            ' (newer than tested; Score checked it)'}
          <CodingBackend />
        </dd>
      </div>
      <div>
        <dt>Workspace</dt>
        <dd>
          <code>{coding.workspace}</code>
        </dd>
      </div>
      <div>
        <dt>Quota source</dt>
        <dd className="team-facts-plain">{coding.quota}</dd>
      </div>
    </dl>
  )
}
