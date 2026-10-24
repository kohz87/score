import type { Message, StreamEvent } from '@score/contract'
import { attemptPath } from '../routes/attempts/attempt-format.ts'
import type { NotificationKind, NotificationPrefs } from './prefs.ts'

export interface NotificationPayload {
  kind: NotificationKind
  title: string
  body: string
  /** An in-app path: clicking the notification opens it. */
  url: string
  /** Notifications with the same tag replace each other instead of piling up. */
  tag: string
}

interface RouterOptions {
  prefs: () => NotificationPrefs
  /** Whether Score is in the background (hidden tab, minimised or covered window). */
  hidden: () => boolean
  nameOf: (agentId: string) => string
}

const PREVIEW_LENGTH = 120
const TERMINAL = new Set(['completed', 'failed'])

function previewOf(message: Pick<Message, 'parts'>): string {
  const text = message.parts.find((part) => part.kind === 'text')
  const line = text?.kind === 'text' ? text.text.replace(/\s+/g, ' ').trim() : ''
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 1)}…` : line
}

/**
 * Turns stream events into notifications, according to this device's choices. Without "Show message previews" a
 * notification carries only who and what kind, never message text or an approval's command.
 */
export function createNotificationRouter({ prefs, hidden, nameOf }: RouterOptions) {
  // A run emits several updates; each finished run notifies once.
  const finished = new Set<string>()
  // Replies stream in: remember who wrote a message until it completes.
  const writing = new Map<string, { roomId: string; agentId: string }>()

  function reply(
    id: string,
    roomId: string,
    agentId: string,
    message: Pick<Message, 'parts'> | undefined,
    settings: NotificationPrefs,
  ): NotificationPayload | null {
    if (!settings.kinds.replies || !hidden()) return null
    const preview = settings.previews && message ? previewOf(message) : ''
    return {
      kind: 'replies',
      title: `${nameOf(agentId)} replied`,
      body: preview || 'Open Score to read the reply.',
      url: `/chat/${encodeURIComponent(roomId)}`,
      tag: `reply:${roomId}`,
    }
  }

  return {
    handle(event: StreamEvent): NotificationPayload | null {
      const settings = prefs()
      if (!settings.enabled) return null
      switch (event.type) {
        case 'approval.requested': {
          const approval = event.data
          if (!settings.kinds.approvals || !approval.actionable || approval.status !== 'pending')
            return null
          return {
            kind: 'approvals',
            title: 'Approval needed',
            body:
              settings.previews && approval.title
                ? `${nameOf(approval.agentId)}: ${approval.title}`
                : `${nameOf(approval.agentId)} is waiting for your decision.`,
            url: '/b',
            tag: `approval:${approval.id}`,
          }
        }
        case 'run.updated': {
          const run = event.data
          if (!TERMINAL.has(run.status) || finished.has(run.id)) return null
          const routine = run.origin === 'cron'
          // A failed routine is a routine result (one notification), not a second "error" one.
          const kind: NotificationKind | null = routine
            ? 'routines'
            : run.status === 'failed'
              ? 'errors'
              : null
          if (kind === null || !settings.kinds[kind]) return null
          finished.add(run.id)
          if (finished.size > 500) finished.delete(finished.values().next().value!)
          const name = nameOf(run.agentId)
          return routine
            ? {
                kind,
                title: run.status === 'failed' ? 'Routine failed' : 'Routine finished',
                body: `${name}’s routine ${run.status === 'failed' ? 'did not finish' : 'is done'}.`,
                url: '/b/team',
                tag: `run:${run.id}`,
              }
            : {
                kind,
                title: `${name} hit an error`,
                body: 'A run failed. Open Score to see what happened.',
                url: `/watch/${encodeURIComponent(run.agentId)}`,
                tag: `run:${run.id}`,
              }
        }
        case 'attempt.updated': {
          // A failed Kanban attempt reads like a failed run, but it opens the task (or, for an earlier copy of the
          // board, the attempt page): an attempt has no session, so there is never a Watch URL for it.
          const attempt = event.data
          if (attempt.status !== 'failed' || !settings.kinds.errors || finished.has(attempt.id))
            return null
          finished.add(attempt.id)
          if (finished.size > 500) finished.delete(finished.values().next().value!)
          return {
            kind: 'errors',
            title: attempt.agentId
              ? `${nameOf(attempt.agentId)} hit an error`
              : 'A task run failed',
            body: 'A task run failed. Open Score to see what happened.',
            url: attemptPath(attempt),
            tag: `attempt:${attempt.id}`,
          }
        }
        case 'message.created': {
          const message = event.data
          if (message.author.kind !== 'agent') return null
          if (message.streaming) {
            writing.set(message.id, { roomId: message.roomId, agentId: message.author.agentId })
            if (writing.size > 200) writing.delete(writing.keys().next().value!)
            return null
          }
          return reply(message.id, message.roomId, message.author.agentId, message, settings)
        }
        case 'message.completed': {
          const author = writing.get(event.data.messageId)
          writing.delete(event.data.messageId)
          if (!author) return null
          return reply(
            event.data.messageId,
            author.roomId,
            author.agentId,
            event.data.parts ? { parts: event.data.parts } : undefined,
            settings,
          )
        }
        default:
          return null
      }
    },
  }
}
