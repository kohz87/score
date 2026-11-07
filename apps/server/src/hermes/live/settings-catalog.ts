import { z } from 'zod'
import type { ProviderBase } from '../port.ts'

// The first reads after a start run several cold Python processes at once; 8 s timed out (2026-10-08 live).
export const READ_TIMEOUT_MS = 20_000
export const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

// Providers worth showing even when Hermes has no credential for them yet.
export const CATALOG: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  'openai-codex': 'ChatGPT (Codex)',
  nous: 'Nous Portal',
}
// Browser sign-in kind per provider (ARCHITECTURE D2.7). Device-code providers are the ones whose
// `hermes auth add <id> --type oauth --no-browser` prints a verification link and a user code and then polls:
// hermes_cli/auth_commands.py `_OAUTH_ADD_SPECS` + `_add_nous_oauth_credential`, with the printing in
// auth_codex.py `_codex_device_code_login` (the default Codex flow), auth_nous.py `_nous_device_code_login`,
// auth_xai.py `_xai_oauth_device_code_login` and auth_minimax.py `_minimax_oauth_login`
// (via auth_device_flow.py `_print_device_code_instructions`). Not device-code: `anthropic` (PKCE, needs a localhost
// callback), `openrouter` (PKCE), `qwen-oauth` (borrows the Qwen CLI's login); they stay "terminal" unless the
// provider also takes a pasted key (gateway `auth_type: "api_key"`).
const DEVICE_CODE_PROVIDERS = new Set(['openai-codex', 'nous', 'xai-oauth', 'minimax-oauth'])
// Used when the gateway can't be read: the short built-in list's key providers.
export const FALLBACK_KEY_PROVIDERS = new Set(['openrouter', 'anthropic'])
export type SignInKind = NonNullable<ProviderBase['signIn']>
// Hermes 0.21.5 reports no auth_type for anthropic, but `auth add anthropic --type api-key` takes a console key
// (auth_commands.py `_add_credential` → `_add_api_key_credential` for any provider); its subscription login stays PKCE.
const ALSO_KEY_PROVIDERS = new Set(['anthropic'])
export function signInKind(id: string, authType: string | undefined): SignInKind {
  if (DEVICE_CODE_PROVIDERS.has(id)) return 'device_code'
  return authType === 'api_key' || ALSO_KEY_PROVIDERS.has(id) ? 'api_key' : 'terminal'
}
export const KEY_TIMEOUT_MS = 30_000

export const HEADER = /^([a-z0-9][a-z0-9._-]{0,63}) \((\d+) credentials?\):\s*$/
export const FREE_TIER = /^([a-z0-9][a-z0-9._-]{0,63}): (.{1,120})$/
export const ROW = /^\s+#\d+\s+.+?\s+(oauth|api_key)\s+id=\S+\s+priority=-?\d+(.*)$/
export const ServersSchema = z.record(z.string(), z.unknown())
export const LocalProvidersSchema = z.record(
  z.string(),
  z.object({ name: z.string().optional(), base_url: z.string().optional() }).passthrough(),
)

export function providerLabel(id: string, name?: string): string {
  return CATALOG[id] ?? name ?? title(id)
}
export function title(id: string): string {
  return id.replace(/[-_.]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
export function quote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'custom endpoint'
  }
}

/** The credential ids `auth list` shows under one provider's header (`#1 <label> api_key id=<id> priority=…`). */
export function credentialIds(text: string, provider: string): string[] {
  const ids: string[] = []
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line)
    if (header) {
      inside = header[1] === provider
      continue
    }
    if (!line.startsWith(' ')) inside = false
    const row = inside
      ? /^\s+#\d+\s+.+?\s+(?:oauth|api_key)\s+id=(\S+)\s+priority=/.exec(line)
      : null
    if (row && /^[A-Za-z0-9._:-]{1,128}$/.test(row[1]!)) ids.push(row[1]!)
  }
  return ids
}
