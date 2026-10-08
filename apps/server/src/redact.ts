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

/** Scrub before cutting: a truncated secret must never become an unrecognizable prefix. */
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
      '[redacted]',
    )
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
