import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createSecureContext, type SecureContext } from 'node:tls'

// Extra certificates by server name (5.22): `<name>.crt` + `<name>.key` pairs in one folder, e.g. the Let's Encrypt
// certificate `tailscale cert` issues for this machine's ts.net name. A browser that asks for one of those names (SNI)
// gets its certificate; anything else (an IP address sends no SNI) gets the default one. Renewed files are picked up
// without a restart.
const NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const RECHECK_MS = 60_000

/** The server names that have a usable pair in `directory`. */
export function certificateNames(directory: string): string[] {
  let files: string[]
  try {
    files = readdirSync(directory)
  } catch {
    return []
  }
  return files
    .filter((file) => file.endsWith('.crt'))
    .map((file) => file.slice(0, -'.crt'.length).toLowerCase())
    .filter((name) => NAME.test(name) && files.includes(`${name}.key`))
    .sort()
}

export function namedCertificates(directory: string, now: () => number = Date.now) {
  const loaded = new Map<string, { context: SecureContext; signature: string; checkedAt: number }>()
  const signatureOf = (name: string) => {
    const cert = statSync(join(directory, `${name}.crt`))
    const key = statSync(join(directory, `${name}.key`))
    return `${cert.mtimeMs}:${cert.size}:${key.mtimeMs}:${key.size}`
  }
  function contextFor(servername: string): SecureContext | undefined {
    const name = servername.toLowerCase()
    if (!NAME.test(name)) return undefined
    const current = loaded.get(name)
    if (current && now() - current.checkedAt < RECHECK_MS) return current.context
    try {
      const signature = signatureOf(name)
      if (current?.signature === signature) {
        current.checkedAt = now()
        return current.context
      }
      const context = createSecureContext({
        cert: readFileSync(join(directory, `${name}.crt`)),
        key: readFileSync(join(directory, `${name}.key`)),
      })
      loaded.set(name, { context, signature, checkedAt: now() })
      return context
    } catch {
      // Missing or half-written files: keep serving the last good certificate, if any.
      return current?.context
    }
  }
  return {
    contextFor,
    /** For tls `SNICallback`: the named certificate, or the server's default when there is none. */
    sniCallback(servername: string, done: (error: Error | null, context?: SecureContext) => void) {
      done(null, contextFor(servername))
    },
  }
}

/**
 * Renews Tailscale certificates in the folder once a day (`tailscale cert` only replaces them when they are due).
 * Best effort: a machine without the `tailscale` command, or a failure, changes nothing.
 */
export function renewTailscaleCertificates(
  directory: string,
  onError: (error: unknown) => void,
): { stop(): void } {
  const renew = () => {
    for (const name of certificateNames(directory).filter((n) => n.endsWith('.ts.net')))
      execFile(
        'tailscale',
        [
          'cert',
          '--cert-file',
          join(directory, `${name}.crt`),
          '--key-file',
          join(directory, `${name}.key`),
          name,
        ],
        { timeout: 120_000 },
        (error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error)
        },
      )
  }
  const timer = setInterval(renew, 24 * 60 * 60 * 1000)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
