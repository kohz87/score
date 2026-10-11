import type { MessagingField, MessagingFieldsResponse } from '@score/contract'
import { HttpError } from '../errors.ts'

// Hermes has no read-only CLI that lists env-var metadata, so the browser setup form is driven by this table. Names,
// labels and URLs mirror OPTIONAL_ENV_VARS in hermes_cli/config_defaults.py (Signal, Email and Home Assistant are not
// listed there; their names come from the gateway adapters). Only these keys are ever written (never arbitrary env).
const field = (
  key: string,
  label: string,
  options: { help?: string; url?: string; secret?: boolean; required?: boolean } = {},
): MessagingField => ({
  key,
  label,
  help: options.help ?? null,
  url: options.url ?? null,
  secret: options.secret ?? false,
  required: options.required ?? false,
})

const FIELDS: Record<string, MessagingField[]> = {
  telegram: [
    field('TELEGRAM_BOT_TOKEN', 'Bot token', {
      help: 'The token @BotFather gives you when you create the bot.',
      url: 'https://t.me/BotFather',
      secret: true,
      required: true,
    }),
    field('TELEGRAM_ALLOWED_USERS', 'Allowed user IDs', {
      help: 'Optional, comma-separated numeric IDs. Leave blank to approve people through DM pairing.',
      url: 'https://t.me/userinfobot',
    }),
  ],
  discord: [
    field('DISCORD_BOT_TOKEN', 'Bot token', {
      help: 'From your application in the Discord Developer Portal.',
      url: 'https://discord.com/developers/applications',
      secret: true,
      required: true,
    }),
    field('DISCORD_ALLOWED_USERS', 'Allowed user IDs', {
      help: 'Optional, comma-separated Discord user IDs.',
    }),
  ],
  slack: [
    field('SLACK_BOT_TOKEN', 'Bot token (xoxb-)', {
      help: 'Install your Slack app, then copy OAuth & Permissions > Bot User OAuth Token.',
      url: 'https://api.slack.com/apps',
      secret: true,
      required: true,
    }),
    field('SLACK_APP_TOKEN', 'App token (xapp-)', {
      help: 'Enable Socket Mode, then create an App-Level Token with the connections:write scope.',
      url: 'https://api.slack.com/apps',
      secret: true,
      required: true,
    }),
    field('SLACK_ALLOWED_USERS', 'Allowed member IDs', {
      help: 'Comma-separated Slack member IDs. Without this, Slack may connect but deny messages.',
    }),
  ],
  mattermost: [
    field('MATTERMOST_URL', 'Server URL', {
      help: 'For example https://mm.example.com',
      url: 'https://mattermost.com/deploy/',
      required: true,
    }),
    field('MATTERMOST_TOKEN', 'Bot token', {
      help: 'A bot token or personal access token.',
      secret: true,
      required: true,
    }),
    field('MATTERMOST_ALLOWED_USERS', 'Allowed user IDs', { help: 'Optional, comma-separated.' }),
  ],
  matrix: [
    field('MATRIX_HOMESERVER', 'Homeserver URL', {
      help: 'For example https://matrix.example.org',
      url: 'https://matrix.org/ecosystem/servers/',
      required: true,
    }),
    field('MATRIX_ACCESS_TOKEN', 'Access token', { secret: true, required: true }),
    field('MATRIX_USER_ID', 'User ID', { help: 'For example @hermes:example.org' }),
    field('MATRIX_ALLOWED_USERS', 'Allowed user IDs', { help: 'Optional, comma-separated.' }),
  ],
  signal: [
    field('SIGNAL_HTTP_URL', 'signal-cli HTTP address', {
      help: 'Where signal-cli runs in daemon mode, for example http://127.0.0.1:8080',
      required: true,
    }),
    field('SIGNAL_ACCOUNT', 'Phone number', {
      help: 'The registered number, with country code.',
      required: true,
    }),
    field('SIGNAL_ALLOWED_USERS', 'Allowed numbers', { help: 'Optional, comma-separated.' }),
  ],
  email: [
    field('EMAIL_ADDRESS', 'Email address', { required: true }),
    field('EMAIL_PASSWORD', 'Password or app password', { secret: true, required: true }),
    field('EMAIL_IMAP_HOST', 'IMAP server', {
      help: 'For example imap.example.com',
      required: true,
    }),
    field('EMAIL_SMTP_HOST', 'SMTP server', {
      help: 'For example smtp.example.com',
      required: true,
    }),
  ],
  homeassistant: [
    field('HASS_URL', 'Home Assistant URL', {
      help: 'For example http://homeassistant.local:8123',
      required: true,
    }),
    field('HASS_TOKEN', 'Long-lived access token', {
      help: 'Create one on your Home Assistant profile page.',
      secret: true,
      required: true,
    }),
  ],
}

/** Platforms not in the table (WhatsApp QR and other pairings) have no fields and `browserSetup: false`. */
export function messagingFields(platform: string): MessagingFieldsResponse {
  const fields = Object.hasOwn(FIELDS, platform) ? FIELDS[platform]! : []
  return { fields: structuredClone(fields), browserSetup: fields.length > 0 }
}

/** The env writes for a setup request: whitelist, required fields, empty optional values skipped. Throws 400. */
export function messagingWrites(
  platform: string,
  values: Record<string, string>,
): [key: string, value: string][] {
  const { fields } = messagingFields(platform)
  if (fields.length === 0)
    throw new HttpError(409, 'not_supported', 'This platform needs the terminal.')
  const known = new Set(fields.map((item) => item.key))
  if (Object.keys(values).some((key) => !known.has(key)))
    throw new HttpError(400, 'bad_request', 'That setting doesn’t exist for this platform.')
  const writes: [string, string][] = []
  for (const item of fields) {
    const value = values[item.key]?.trim() ?? ''
    if (value === '') {
      if (item.required) throw new HttpError(400, 'bad_request', `${item.label} is required.`)
      continue
    }
    writes.push([item.key, value])
  }
  return writes
}
