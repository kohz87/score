// Which Hermes config keys Score will never search, show or write. The rules mirror Hermes's own:
// `config_env_routing.is_env_setting_key` (bare UPPER_SNAKE names live in .env, not config.yaml),
// `config._is_env_config_key` / `_is_secret_config_key` (credential-shaped names), plus the brief's wider net
// (anything key/token/secret/password/credential-like, env maps, header maps, provider and MCP containers).
// Over-excluding is deliberate: a hidden setting is an inconvenience, a leaked credential is not.
import { redact } from '../redact.ts'

// config.py _ENV_CONFIG_KEYS: bare names `hermes config set` routes to .env.
const ENV_CONFIG_KEYS = new Set([
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'VOICE_TOOLS_OPENAI_KEY',
  'EXA_API_KEY',
  'PARALLEL_API_KEY',
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_URL',
  'FIRECRAWL_GATEWAY_URL',
  'TOOL_GATEWAY_URL',
  'CONNECTOR_GATEWAY_URL',
  'TOOL_GATEWAY_DOMAIN',
  'TOOL_GATEWAY_SCHEME',
  'TOOL_GATEWAY_USER_TOKEN',
  'TAVILY_API_KEY',
  'PERPLEXITY_API_KEY',
  'API_SERVER_KEY',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'BROWSER_USE_API_KEY',
  'FAL_KEY',
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'TERMINAL_SSH_HOST',
  'TERMINAL_SSH_USER',
  'TERMINAL_SSH_KEY',
  'SUDO_PASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'GITHUB_TOKEN',
  'HONCHO_API_KEY',
])
const ENV_SHAPE = /^[A-Z][A-Z0-9_]*$/
// config.py _SECRET_CONFIG_KEYS and _SECRET_CONFIG_KEY_SUFFIXES.
const SECRET_LEAVES = new Set([
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'authorization',
  'private_key',
  'bearer',
  'jwt',
])
const SECRET_SUFFIXES = ['_api_key', '_token', '_secret', '_password', '_key', '_access_key']
// The brief's wider net, applied to every path segment.
const SECRET_WORD = /key|token|secret|passw|credential|authoriz|bearer|jwt|cookie|auth_/
const ENV_OR_HEADERS = /^(env|headers)$|^env_|_env$|_env_|^headers_|_headers$/
// Containers of provider endpoints, MCP launch environments and pooled credentials. Score edits those through
// the Providers and Connections sections, never as raw config.
const SECRET_CONTAINERS = new Set([
  'providers',
  'custom_providers',
  'fallback_providers',
  'mcp_servers',
  'credential_pool_strategies',
])

function normalize(segment: string): string {
  return segment.toLowerCase().replaceAll('-', '_')
}

/** A single path segment that names a credential, environment map or header map. */
export function isSecretSegment(segment: string): boolean {
  const name = normalize(segment)
  return (
    SECRET_LEAVES.has(name) ||
    SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    SECRET_WORD.test(name) ||
    ENV_OR_HEADERS.test(name)
  )
}

/** True for every key Score must neither search, show nor write. Malformed keys count as excluded. */
export function isExcludedConfigKey(key: string): boolean {
  if (key.length === 0 || key.length > 256 || key.includes('\0')) return true
  const segments = key.split('.')
  if (segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) return true
  // Segments starting with `_` are Hermes bookkeeping (`_config_version`), not settings.
  if (segments.some((segment) => segment.startsWith('_'))) return true
  if (segments.length === 1) {
    const upper = key.toUpperCase()
    if (ENV_SHAPE.test(key) || ENV_CONFIG_KEYS.has(upper)) return true
    if (['_API_KEY', '_TOKEN', '_SECRET'].some((suffix) => upper.endsWith(suffix))) return true
    if (upper.startsWith('TERMINAL_SSH')) return true
  }
  if (segments.some((segment) => SECRET_CONTAINERS.has(normalize(segment)))) return true
  return segments.some(isSecretSegment)
}

const MAX_SCRUB_DEPTH = 8
/**
 * Defence in depth for a value read from Hermes: Hermes already masks credential-shaped fields, but a nested
 * object under an allowed key is also stripped of secret-named members and scrubbed of token shapes.
 */
export function scrubConfigValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_SCRUB_DEPTH) return null
  if (Array.isArray(value)) return value.map((item) => scrubConfigValue(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !isSecretSegment(name))
      .map(([name, child]) => [name, scrubConfigValue(child, depth + 1)]),
  )
}

// Settings the running gateway reads only at start.
const RESTART_PREFIXES = [
  'gateway.',
  'platforms.',
  'telegram.',
  'discord.',
  'slack.',
  'whatsapp.',
  'matrix.',
  'mattermost.',
  'signal.',
  'api_server.',
  'messaging.',
]
export function configRestartRequired(keys: string[]): boolean {
  return keys.some((key) => RESTART_PREFIXES.some((prefix) => key.startsWith(prefix)))
}
