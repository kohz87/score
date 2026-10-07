/** Scrub before cutting: a truncated secret must never become an unrecognizable prefix. */
export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
      '[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bsk-(?:or-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{8,}\b/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(
      /((?:["']?\b(?:[A-Z0-9]+_)*(?:password|token|api_key|secret)["']?)\s*(?:=|:)\s*)(?!\[redacted\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}\]]+)/gi,
      '$1[redacted]',
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
        /password|passwd|secret|token|apikey|accesskey|privatekey|clientsecret|authorization|cookie|credential|sessionid/.test(
          name.toLowerCase().replace(/[_\- ]/g, ''),
        ) &&
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
