export const SESSION_COOKIE = 'score_session'
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60

export function readCookie(header: string | undefined, name: string): string | undefined {
  let value: string | undefined
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    // Ambiguous credentials should never select a different session based on parsing order.
    if (value !== undefined) return undefined
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return value
}

export function sessionCookie(id: string, maxAge = SESSION_MAX_AGE): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}
