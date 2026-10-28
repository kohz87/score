import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SecurityStatusSchema } from '@score/contract'
import { ApiError } from '../data/api.ts'
import { securityKey } from '../routes/settings/settings-queries.ts'

export const browsersKey = ['session', 'browsers'] as const
export const passkeysKey = ['session', 'passkeys'] as const

/** The server answers 403 `locked` when the section's unlock ran out (3.14.2). */
export function isLocked(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === 'locked'
}

/** The words for a failed security request; `action` finishes "Couldn’t …". */
export function securityFailure(error: unknown, action: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'wrong_password') return 'That is not the security password.'
  if (code === 'too_many_attempts')
    return 'Too many wrong passwords. Wait 15 minutes and try again.'
  if (code === 'password_not_set') return 'Set a security password first.'
  if (code === 'bad_request') return 'Use 8–256 characters for the security password.'
  if (code === 'passkeys_unavailable')
    return 'Passkeys need a domain name, not an IP address. Open Score at its Tailscale address.'
  // The browser refuses a ceremony the person cancelled or timed out.
  if (error instanceof Error && error.name === 'NotAllowedError')
    return 'The passkey was cancelled or timed out.'
  return `Couldn’t ${action}. Try again.`
}

/** Marks the section locked in the cache and drops what it listed, so no stale list stays on screen. */
export function useDropToLocked() {
  const queryClient = useQueryClient()
  return useCallback(() => {
    queryClient.removeQueries({ queryKey: browsersKey })
    queryClient.removeQueries({ queryKey: passkeysKey })
    queryClient.setQueryData(securityKey, (old: unknown) => {
      const parsed = SecurityStatusSchema.safeParse(old)
      return parsed.success ? { ...parsed.data, unlockedUntil: null } : old
    })
    void queryClient.invalidateQueries({ queryKey: securityKey })
  }, [queryClient])
}

/** Call from a query function or a mutation's `onError`: a `locked` answer sends the section back to the lock card. */
export function useOnLocked() {
  const dropToLocked = useDropToLocked()
  return useCallback(
    (error: unknown) => {
      if (isLocked(error)) dropToLocked()
    },
    [dropToLocked],
  )
}

/** After any action: each use pushes the unlock out, so read the new time. */
export function useRefreshSecurity() {
  const queryClient = useQueryClient()
  return useCallback(() => queryClient.invalidateQueries({ queryKey: securityKey }), [queryClient])
}

/** "4:52" for whole seconds. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Seconds until `until`, counted down every second. The time left is taken from the server (`until - serverNow`, read
 * when the answer arrived at `receivedAt`), so a device clock that is minutes off can't shorten or stretch it (review).
 * `onExpired` runs once per `until`.
 */
export function useCountdown(
  until: string,
  serverNow: string | null,
  receivedAt: number,
  onExpired: () => void,
): number {
  const leftAtReceipt = Date.parse(until) - (serverNow ? Date.parse(serverNow) : receivedAt)
  const target = receivedAt + leftAtReceipt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let fired = false
    const tick = () => {
      const current = Date.now()
      setNow(current)
      if (current >= target && !fired) {
        fired = true
        onExpired()
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [target, onExpired])
  return Math.max(0, Math.ceil((target - now) / 1000))
}
