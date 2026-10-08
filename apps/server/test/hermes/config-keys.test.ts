import { expect, test } from 'vitest'
import {
  configRestartRequired,
  isExcludedConfigKey,
  scrubConfigValue,
} from '../../src/hermes/config-keys.ts'
import { CONFIG_INDEX } from '../../src/hermes/live/config.ts'

test.each([
  // env-backed: bare UPPER_SNAKE names and the names Hermes routes to .env
  'OPENROUTER_API_KEY',
  'HERMES_TIMEZONE',
  'TELEGRAM_GROUP_ALLOWED_USERS',
  'openrouter_api_key',
  'terminal_ssh_host',
  'foo_token',
  'foo_secret',
  // credential-shaped names, last segment or any segment
  'model.api_key',
  'auxiliary.vision.api_key',
  'auxiliary.vision.apiKey',
  'tts.openai.api-key',
  'x.access_token',
  'x.client_secret',
  'x.password',
  'x.some_password',
  'x.credentials',
  'x.credential_file',
  'x.bearer',
  'x.private_key',
  'x.session_cookie',
  'secrets.anything',
  'token.limit',
  'key.name',
  // env and header maps
  'mcp_servers.files.env.FOO',
  'terminal.env',
  'terminal.env_passthrough',
  'x.headers',
  'x.headers.X-Trace',
  'x.request_headers',
  // containers of provider endpoints and credentials
  'providers',
  'providers.lab.base_url',
  'providers.lab.name',
  'custom_providers.x.model',
  'fallback_providers',
  'mcp_servers',
  'mcp_servers.files.command',
  'delegation.fallback_providers',
  'credential_pool_strategies',
  // bookkeeping and malformed keys
  '_config_version',
  'agent._internal',
  '',
  'agent.',
  '.agent',
  'agent..x',
  'agent. x',
  'agent/x',
  'agent\0x',
  'a'.repeat(300),
])('key %j is excluded', (key) => {
  expect(isExcludedConfigKey(key)).toBe(true)
})
test.each([
  'agent.max_turns',
  'display.compact',
  'approvals.mode',
  'terminal.backend',
  'gateway.port',
  'timezone',
  'auxiliary.vision.provider',
])('key %j is allowed', (key) => {
  expect(isExcludedConfigKey(key)).toBe(false)
})
test('no key in the generated index that survives the filter is credential-shaped', () => {
  expect(CONFIG_INDEX.length).toBeGreaterThan(500)
  const kept = CONFIG_INDEX.filter((entry) => !isExcludedConfigKey(entry.key))
  expect(kept.length).toBeGreaterThan(300)
  expect(kept.length).toBeLessThan(CONFIG_INDEX.length)
  for (const { key } of kept)
    expect(key).not.toMatch(
      /key|token|secret|passw|credential|cookie|header|(^|\.)env(\.|_|$)|providers|mcp_servers/i,
    )
  // The planted credential leaves of the real index are all excluded.
  for (const { key } of CONFIG_INDEX.filter((entry) => /(^|\.)api_key$/.test(entry.key)))
    expect(isExcludedConfigKey(key)).toBe(true)
})
test('the generated index carries comments and no persona names', () => {
  expect(CONFIG_INDEX.some((entry) => entry.description)).toBe(true)
  expect(JSON.stringify(CONFIG_INDEX)).not.toMatch(/\u0061keno|\u0066ern|\u006dakima|\u006darin/i)
})
test('scrubbing drops secret-named members at any depth and redacts token shapes', () => {
  const planted = 'sk-or-v1-planted-secret-value-1234567890'
  const scrubbed = scrubConfigValue({
    mode: 'a',
    api_key: planted,
    nested: { token: planted, headers: { Authorization: planted }, note: `use ${planted}` },
    list: [{ password: 'p' }, planted],
  })
  expect(JSON.stringify(scrubbed)).not.toContain(planted)
  expect(JSON.stringify(scrubbed)).not.toMatch(/api_key|token|headers|password/)
  expect(scrubbed).toMatchObject({ mode: 'a' })
})
test('restart is required for gateway and platform keys only', () => {
  expect(configRestartRequired(['gateway.port'])).toBe(true)
  expect(configRestartRequired(['display.compact', 'telegram.enabled'])).toBe(true)
  expect(configRestartRequired(['display.compact', 'agent.max_turns'])).toBe(false)
})
