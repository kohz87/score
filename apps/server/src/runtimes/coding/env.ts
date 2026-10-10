// The child environment of a coding CLI (review 2026-10-09, 7.2 #4). An allowlist, never Score's own environment: the
// CLIs read their own login/config from HOME (and CLAUDE_CONFIG_DIR / CODEX_HOME when the person points them
// elsewhere). Anything that looks like a secret is dropped even when its name is listed.
const ALLOWED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
])
const ALLOWED_PREFIXES = ['LC_']
// Names that mean "secret" whatever else they are. SCORE_/HERMES_ are Score's and Hermes's own settings.
const SECRET_NAME =
  /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|^SCORE_|^HERMES_)/i
// Fake mode only: lets tests steer the fake CLI script (never reaches a real CLI).
const FAKE_PREFIX = 'SCORE_CODING_FAKE_'

export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  { fake = false }: { fake?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || value.includes('\0')) continue
    if (fake && name.startsWith(FAKE_PREFIX)) {
      env[name] = value
      continue
    }
    if (!ALLOWED.has(name) && !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    if (SECRET_NAME.test(name)) continue
    // A proxy URL with a password in it is a credential.
    if (/proxy$/i.test(name) && /\/\/[^/@]*@/.test(value)) continue
    env[name] = value
  }
  return env
}
