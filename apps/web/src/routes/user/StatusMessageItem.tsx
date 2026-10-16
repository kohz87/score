import type { StatusMessage } from './status-messages.ts'

/**
 * One of Score's own status lines between the messages (PLAN 8.4). It has no agent glyph and no message actions: it is
 * not a message, only a line drawn from the run's events.
 */
export function StatusMessageItem({ message }: { message: StatusMessage }) {
  return (
    <p className="user-status" data-tone={message.tone} data-status-line>
      <span className="user-status-mark" aria-hidden="true" />
      <span className="user-status-text">
        <span className="chat-sr-only">Score: </span>
        {message.text}
      </span>
      <time dateTime={message.at}>
        {new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </time>
    </p>
  )
}
