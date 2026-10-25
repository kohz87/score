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
            'Hermes didn’t accept the settings.',
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

/**
 * Clears a platform's env values with `hermes [-p profile] config unset KEY`, one per key of its field table (2.0.3).
 * Hermes exits non-zero for a key that isn't set, so a failure only counts when no key could be removed. Like a save,
 * the gateway keeps the platform until it restarts.
 */
export async function removeMessagingValues(options: {
  hermesHome: string
  profile: string | undefined
  platform: string
  keys: string[]
  runner?: HermesRunner
  locks: ProfileLocks
  invalidate?: () => void
}): Promise<MessagingPlatform> {
  const runner = options.runner ?? runHermes
  const prefix = options.profile ? ['-p', options.profile] : []
  await options.locks.run(options.profile ?? 'default', async () => {
    let removed = 0
    try {
      for (const key of options.keys) {
        const result = await runner([...prefix, 'config', 'unset', key], {
          timeoutMs: WRITE_TIMEOUT_MS,
          hermesHome: options.hermesHome,
        }).catch(() => ({ exitCode: -1 }))
        if (result.exitCode === 0) removed++
      }
    } finally {
      options.invalidate?.()
    }
    if (removed === 0)
      throw new HttpError(
        409,
        'not_verified',
        'None of its settings were set, so nothing was removed.',
      )
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
