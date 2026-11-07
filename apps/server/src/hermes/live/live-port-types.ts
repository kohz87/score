import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import type { HermesPortDeps } from '../port.ts'
import type { HermesRunner, HermesSpawner } from './cli.ts'
import type { FingerprintInputs, TestedFingerprint } from './fingerprint.ts'
import { ProfileNameSchema } from './paths.ts'
import type { FollowOptions } from './runs.ts'
import type { SourceFacts } from './source-facts.ts'

export const StateSchema = z.object({ served_profiles: z.array(ProfileNameSchema) })
/** How long an agent read waits for the port's first gateway status after a restart. */
export const FIRST_STATUS_WAIT_MS = 15_000
export interface LivePortOptions extends HermesPortDeps {
  /** How long an agent read waits for the first gateway status (default FIRST_STATUS_WAIT_MS; tests pass 0). */
  firstStatusWaitMs?: number
  bridgeInstallUrl?: string
  bridgeInstallRef?: string
  scoreHome: string
  hermesHome?: string
  baseUrl?: string
  db?: ScoreDb
  runner?: HermesRunner
  spawner?: HermesSpawner
  /** Profile the provider routes act on (dev/tests only; default: Hermes's default profile). */
  settingsProfile?: string
  fetch?: typeof globalThis.fetch
  readCliVersion?: FingerprintInputs['readCliVersion']
  testedFingerprints?: readonly TestedFingerprint[]
  /** Reads what Score relies on from the Hermes sources; tests inject fixtures. */
  readSourceFacts?: (sourceDir: string) => Promise<SourceFacts | null>
  following?: Pick<FollowOptions, 'backoff' | 'pollIntervalMs' | 'pollLimitMs' | 'now' | 'wait'>
}
/** How long Hermes gets to end a run it accepted a stop for before a second Stop ends Score's record (3.7.2). */
export const STOP_GRACE_MS = 5000
