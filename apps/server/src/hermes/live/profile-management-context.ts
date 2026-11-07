import { join } from 'node:path'
import type { ScoreDb } from '../../db/index.ts'
import type { HermesPort } from '../port.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { ProfileNameSchema } from './paths.ts'
import type { ProfilesReader } from './profiles.ts'
import { failure, stat } from './profile-management-files.ts'

export interface LiveProfileManagementOptions {
  scoreHome: string
  hermesHome: string
  db: ScoreDb | undefined
  profiles: ProfilesReader
  port: Pick<HermesPort, 'setAgentModel' | 'readApprovals' | 'updateApprovals'>
  bridgeInstallUrl?: string
  bridgeInstallRef?: string
  runner?: HermesRunner
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}

export function profileHome(options: LiveProfileManagementOptions, name: string) {
  const parent = join(options.hermesHome, 'profiles')
  if (!stat(options.hermesHome)?.isDirectory() || (stat(parent) && !stat(parent)?.isDirectory()))
    throw failure(
      'The folder that holds Hermes profiles must be a plain folder with no symbolic links.',
    )
  return join(options.hermesHome, 'profiles', ProfileNameSchema.parse(name))
}

export async function runProfileCli(
  options: LiveProfileManagementOptions,
  args: string[],
  secret = false,
) {
  const result = await (options.runner ?? runHermes)(args, {
    timeoutMs: 120000,
    hermesHome: options.hermesHome,
    ...(secret ? { sensitiveArgIndices: [args.length - 1] } : {}),
  }).catch(() => ({ exitCode: -1 }))
  if (result.exitCode !== 0)
    throw failure(
      'The CLI refused or didn’t confirm this step. Inspect the profile locally; no fallback was attempted.',
    )
}
