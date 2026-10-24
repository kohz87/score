const credentialNames = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'authorization',
  'cookie',
  'credential',
]
function credentialKey(key: string): boolean {
  const name = key.toLowerCase().replace(/[_\- ]/g, '')
  return (
    credentialNames.some((part) => name.includes(part)) ||
    ['awssecretaccesskey', 'awsaccesskeyid', 'xapikey'].includes(name)
  )
}

// Exact secrets Score itself holds (profile gateway keys): no pattern recognises an unlabeled random key, so every
// redaction also replaces these verbatim. Volatile (process memory only); registered when a key is read.
const knownSecrets = new Set<string>()
export function registerKnownSecret(secret: string): void {
  if (secret.length >= 16) knownSecrets.add(secret)
}
function withoutKnownSecrets(text: string): string {
  let result = text
  for (const secret of knownSecrets)
    if (result.includes(secret)) result = result.replaceAll(secret, '[redacted]')
  return result
}

/** Scrub before cutting: a truncated secret must never become an unrecognizable prefix. */
export function redact(text: string): string {
  return (
    withoutKnownSecrets(text)
      // Score's MCP bearer tokens (scm_ + base64url): distinctive, so recognised bare and embedded, even when cut short.
      .replace(/(?<![A-Za-z0-9])scm_[A-Za-z0-9_-]{8,}/g, '[redacted]')
      // Orchestration capabilities (orc_ + base64url, 7.5): bearer authority for one lead attempt.
      .replace(/orc_[A-Za-z0-9_-]{8,}/g, '[redacted]')
      // Exchange capabilities (xtc_ + base64url, 11.1b): bearer authority for one agent turn.
      .replace(/xtc_[A-Za-z0-9_-]{8,}/g, '[redacted]')
      // One-time pairing links (/pair#<token>) work for whoever holds them: never let one reach a log or a page.
      .replace(/(\/pair#)[A-Za-z0-9_-]{16,}/g, '$1[redacted]')
      // URL query secrets and userinfo: the assignment pass below would otherwise swallow "https:" + the whole URL.
      .replace(
        /([?&;][\w.-]*?(?:token|ticket|key|secret|passw(?:or)?d|auth|sig|signature|credential|session|cookie)[\w.-]*=)[^&\s#"'<>]+/gi,
        '$1[redacted]',
      )
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[redacted]@')
      .replace(
        /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
        '[redacted]',
      )
      // An END left after that has lost its BEGIN (a tail window cut through the key): what precedes it is key body.
      .replace(/^[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/, '[redacted]')
      .replace(/(\bAuthorization\s*:\s*)(?:Basic|Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\bsk-(?:or-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{8,}\b/g, '[redacted]')
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
      .replace(
        /(?<![\w-])(["']?([\w-]+(?: +[\w-]+){0,3})["']?\s*[=:]\s*)(?!\[redacted\])("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}\]]+)/gi,
        (match: string, prefix: string, key: string) =>
          credentialKey(key) ? `${prefix}[redacted]` : match,
      )
      .replace(
        /(\b(?:key|token|secret|password)["']?\s*(?:[=:]\s*|\s+)["']?)[A-Za-z0-9_-]{32,}=*/gi,
        '$1[redacted]',
      )
  )
}

export function redactBounded(text: string, bytes: number): string {
  const safe = redact(text)
  let result = ''
  let size = 0
  for (const char of safe) {
    size += Buffer.byteLength(char)
    if (size > bytes) break
    result += char
  }
  return result
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]')
    return redact(text)
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [
        redact(name),
        credentialKey(name) &&
        // Numbers, booleans and null can't carry a secret (keeps fields such as input_tokens).
        child !== null &&
        typeof child !== 'number' &&
        typeof child !== 'boolean'
          ? '[redacted]'
          : redactValue(child, secrets),
      ]),
    )
  }
  return value
}
