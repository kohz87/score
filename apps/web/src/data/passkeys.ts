import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'
import { PasskeyCeremonySchema } from '@score/contract'
import { apiFetch } from './api.ts'

/** Passkeys are bound to a domain: an IP address (the LAN address) can't use them, localhost can. */
export function passkeyHostUsable(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false
  return host.includes('.')
}

export function passkeysSupportedHere(): boolean {
  return browserSupportsWebAuthn() && passkeyHostUsable(window.location.hostname)
}

/** The first configured origin that is a domain name (the Tailscale address), for the "open it there" hint. */
export function passkeyOrigin(origins: readonly string[]): string | undefined {
  return origins.find((origin) => {
    try {
      return passkeyHostUsable(new URL(origin).hostname)
    } catch {
      return false
    }
  })
}

const post = (path: string, body: unknown) =>
  apiFetch(path, { method: 'POST', body: JSON.stringify(body) })

/** Asks for options (after the security password), lets the authenticator create the passkey, and stores it. */
export async function registerPasskey(password: string, label: string): Promise<void> {
  const optionsJSON = PasskeyCeremonySchema.parse(
    await post('session/passkeys/registration-options', { password, label }),
  )
  // The server shaped these options with @simplewebauthn/server; the browser library checks them again as it runs.
  const response = await startRegistration({
    optionsJSON: optionsJSON as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
  })
  await post('session/passkeys', { response })
}

/** Signs this browser in with a passkey; the server sets the same session cookie a pairing link does. */
export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = PasskeyCeremonySchema.parse(
    await post('session/passkey/authentication-options', {}),
  )
  const response = await startAuthentication({
    optionsJSON: optionsJSON as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
  })
  await post('session/passkey/authentication', { response })
}
