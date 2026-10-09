import type { MessagingPlatform } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import type { ProfileLocks } from './profile-locks.ts'
import { messagingRows, readProfilePlatforms } from './settings.ts'

const WRITE_TIMEOUT_MS = 15_000

/**
 * Writes the platform's env values with `hermes [-p profile] config set KEY value`, one per key (Hermes keeps env keys
 * in the profile's .env). The value is an argv element only: the runner never returns it, and nothing here logs or
 * keeps it. Failures say which step failed, never what was sent.
 */
export async function saveMessagingValues(options: {
  hermesHome: string
  profile: string | undefined
  platform: string
  writes: [key: string, value: string][]
  runner?: HermesRunner
  locks: ProfileLocks
  invalidate?: () => void
}): Promise<MessagingPlatform> {
  const runner = options.runner ?? runHermes
  const prefix = options.profile ? ['-p', options.profile] : []
  await options.locks.run(options.profile ?? 'default', async () => {
    try {
      for (const [key, value] of options.writes) {
        const argv = [...prefix, 'config', 'set', key, value]
        const result = await runner(argv, {
          timeoutMs: WRITE_TIMEOUT_MS,
          hermesHome: options.hermesHome,
          sensitiveArgIndices: [argv.length - 1],
        }).catch(() => ({ exitCode: -1 }))
        if (result.exitCode !== 0)
          throw new HttpError(
            result.exitCode < 0 ? 502 : 409,
            'hermes_write_failed',
            'Hermes did not accept the settings',
          )
      }
    } finally {
      options.invalidate?.()
    }
  })
  const row = messagingRows(
    readProfilePlatforms(options.hermesHome, options.profile ?? 'default'),
  ).find((candidate) => candidate.platform === options.platform)
  return (
    row ?? {
      platform: options.platform,
      label: options.platform,
      status: 'disconnected',
      detail: null,
    }
  )
}
