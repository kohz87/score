import type { IncomingHttpHeaders } from 'node:http'
import { readCookie, SESSION_COOKIE } from './auth/cookies.ts'

export function redactLogError(error: unknown, headers: IncomingHttpHeaders): Error {
  const secrets = [
    headers.cookie,
    readCookie(headers.cookie, SESSION_COOKIE),
    headers.authorization,
    headers.authorization?.replace(/^\S+\s+/, ''),
  ].filter((value): value is string => value !== undefined && value.length > 0)

  function redact(text: string): string {
    for (const secret of secrets) text = text.split(secret).join('[Redacted]')
    return (
      text
        .replace(/\bscore_session\s*=\s*[^;\s,]+/gi, 'score_session=[Redacted]')
        .replace(/([?&]ticket=)[^&\s#"']+/gi, '$1[Redacted]')
        .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[Redacted]')
        // Generated pairing tokens and session IDs have this shape; retain only hashes in memory.
        .replace(/[A-Za-z0-9_-]{43,}/g, '[Redacted]')
    )
  }

  if (!(error instanceof Error)) return new Error('Unknown server error')
  const sanitized = new Error(redact(error.message))
  sanitized.name = redact(error.name)
  sanitized.stack = error.stack === undefined ? undefined : redact(error.stack)
  return sanitized
}
