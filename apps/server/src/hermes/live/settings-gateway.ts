import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConnectionsResponse } from '@score/contract'
import { redactBounded } from '../../redact.ts'
import { title } from './settings-catalog.ts'

// Provider and connection status comes from Hermes itself: `hermes auth list` (labels and counts, never key
// material), `hermes config get --json …` (Hermes masks secret-shaped values) and the gateway's runtime
// status file. Score never opens .env, auth.json or any credential store.
const MAX_STATE_BYTES = 1024 * 1024

// Messaging platforms of the tested Hermes (0.21.5 hermes_cli/platforms.py PLATFORMS, minus cli, api_server and cron,
// which aren't places to reach an agent). Plugin-registered platforms still appear when gateway_state.json reports them.
const PLATFORMS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  whatsapp_cloud: 'WhatsApp Business (Cloud)',
  signal: 'Signal',
  bluebubbles: 'BlueBubbles',
  email: 'Email',
  mattermost: 'Mattermost',
  matrix: 'Matrix',
  dingtalk: 'DingTalk',
  feishu: 'Feishu',
  wecom: 'WeCom',
  wecom_callback: 'WeCom Callback',
  weixin: 'Weixin',
  qqbot: 'QQBot',
  yuanbao: 'Yuanbao',
  webhook: 'Webhook',
}
const StateSchema = z.object({
  platforms: z
    .record(
      z.string(),
      z
        .object({
          state: z.string().optional(),
          error_code: z.union([z.string(), z.number()]).nullish(),
          error_message: z.string().nullish(),
        })
        .passthrough(),
    )
    .optional(),
})

type GatewayPlatforms = NonNullable<z.infer<typeof StateSchema>['platforms']>

/** The gateway's runtime status file in one Hermes home; unreadable or oversized files read as empty. */
export function readGatewayPlatforms(home: string): GatewayPlatforms {
  try {
    const path = join(home, 'gateway_state.json')
    if (fs.statSync(path).size > MAX_STATE_BYTES) return {}
    return StateSchema.parse(JSON.parse(fs.readFileSync(path, 'utf8'))).platforms ?? {}
  } catch {
    return {}
  }
}

/**
 * One profile's platforms. A multiplexing gateway records every served profile in the host's file as
 * "<profile>:<platform>" and its own adapters as flat keys; a standalone gateway writes flat keys into the
 * profile's own file (hermes gateway/status.py `profile_platforms_from_multiplexer`).
 */
export function readProfilePlatforms(root: string, profile: string): GatewayPlatforms {
  const platforms: GatewayPlatforms =
    profile === 'default' ? {} : { ...readGatewayPlatforms(join(root, 'profiles', profile)) }
  for (const [key, value] of Object.entries(readGatewayPlatforms(root))) {
    if (key.startsWith(`${profile}:`)) platforms[key.slice(profile.length + 1)] = value
    else if (profile === 'default' && !key.includes(':')) platforms[key] = value
  }
  return platforms
}

/** Known platforms first (disconnected by default), then whatever the gateway reports. */
export function messagingRows(platforms: GatewayPlatforms): ConnectionsResponse['messaging'] {
  const rows = new Map<string, ConnectionsResponse['messaging'][number]>()
  for (const [platform, label] of Object.entries(PLATFORMS))
    rows.set(platform, { platform, label, status: 'disconnected', detail: null })
  for (const [key, value] of Object.entries(platforms)) {
    // Multiplexed gateways key platforms as "<profile>:<platform>".
    const platform = key.split(':').pop()!
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform)) continue
    const connected = value.state === 'connected'
    if (rows.get(platform)?.status === 'connected') continue
    const problem = value.error_code ?? value.error_message
    rows.set(platform, {
      platform,
      label: PLATFORMS[platform] ?? title(platform),
      status: connected ? 'connected' : 'disconnected',
      detail: connected ? null : redactBounded(String(problem ?? value.state ?? ''), 200) || null,
    })
  }
  return [...rows.values()]
}
