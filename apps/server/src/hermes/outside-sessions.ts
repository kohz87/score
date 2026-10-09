// Hermes sessions that Score did not start (PLAN 5.26): the shape both adapters return. Only the adapters read
// Hermes' databases; everything here is read-only.

export interface OutsideSessionFact {
  id: string
  agentId: string
  /** Hermes' platform id: telegram, cli, discord, … */
  source: string
  sourceLabel: string
  /** The session's title, else its first user message (redacted, cut); '' when neither exists. */
  title: string
  startedAt: string
  messageCount: number
  /** Not ended and active within the last few minutes: another surface may be writing to it right now. */
  busy: boolean
}

export interface OutsideSessionMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
}

export interface OutsideSessionHistory {
  session: OutsideSessionFact
  /** Oldest first, at most {@link MAX_IMPORT_MESSAGES}, text redacted and bounded. */
  messages: OutsideSessionMessage[]
}

export const MAX_IMPORT_MESSAGES = 1000
export const MAX_IMPORT_TEXT_BYTES = 32 * 1024
/** A session with activity inside this window counts as still active on its platform. */
export const BUSY_WINDOW_MS = 5 * 60 * 1000

const LABELS: Record<string, string> = {
  cli: 'CLI',
  tui: 'Terminal UI',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  matrix: 'Matrix',
  email: 'Email',
  sms: 'SMS',
  webui: 'Web UI',
  desktop: 'Desktop app',
  acp: 'Editor (ACP)',
  api_server: 'API',
  github: 'GitHub',
  webhook: 'Webhook',
}
export function sourceLabel(source: string): string {
  return (
    LABELS[source] ??
    (source.charAt(0).toUpperCase() + source.slice(1).replace(/[_-]+/g, ' ')).slice(0, 40)
  )
}

/** Sources that are automation, not conversations a person had. */
export const AUTOMATION_SOURCES = ['cron', 'kanban', 'subagent', 'delegate', 'tool'] as const
